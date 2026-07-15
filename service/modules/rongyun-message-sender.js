/**
 * 融云消息发送工具
 * 
 * 封装与融云 guardserver 的消息交互
 * 服务端融云账号: guardserver
 */
const { RongyunMessageTypeEnum } = require('./rongyun-message-types');
const { getMacAddress } = require('./mac-address');
const { generateSecret } = require('./auth');
const { SAFE_LIMIT, HARD_LIMIT, estimateMessageSize, truncateCardPayload } = require('../utils/message-size');
const { validateCard } = require('../cardkit/validate');

class RongyunMessageSender {
  constructor(rongcloudClient, config, log) {
    this.rongcloudClient = rongcloudClient;
    this.config = config;
    this.log = log;
    this.serverImId = 'guardserver';
  }

  /**
   * 构建标准协议消息
   */
  buildMessage(msgType, content, requestId) {
    const mac = getMacAddress();
    const secret = generateSecret(mac, this.config.secretKey || 'secret_key');

    return {
      msg_type: msgType,
      source_im_id: this.config.accountId || '',
      destination_im_id: this.serverImId,
      mac: mac,
      secret: secret,
      content: typeof content === 'string' ? content : JSON.stringify(content),
      request_id: requestId || '',
      timestamp: Math.floor(Date.now() / 1000),
    };
  }

  /**
   * 发送协议消息到 guardserver
   */
  async sendProtocolMessage(msgType, content, requestId) {
    if (!this.rongcloudClient?.isConnected) {
      this.log?.error('[RongyunMessageSender] 未连接，无法发送消息');
      return false;
    }

    try {
      const messagePayload = this.buildMessage(msgType, content, requestId);

      // this.log?.info(`[RongyunMessageSender] 发送协议消息 -> ${this.serverImId}, type=${msgType}`);

      const result = await this.rongcloudClient.sendMessage(
        this.serverImId,
        messagePayload,
        1 // PRIVATE
      );

      if (result) {
        // this.log?.info(`[RongyunMessageSender] ${msgType} 发送成功`);
      } else {
        this.log?.warn(`[RongyunMessageSender] ${msgType} 发送失败`);
      }

      return result;
    } catch (err) {
      this.log?.error(`[RongyunMessageSender] 发送异常: ${err.message}`);
      return false;
    }
  }

  /**
   * 发送 CLIENT_CONNECTED
   */
  async sendClientConnected() {
    return await this.sendProtocolMessage(
      RongyunMessageTypeEnum.CLIENT_CONNECTED,
      {
        mac_address: getMacAddress(),
        nickname: this.config.nodeName || 'CLI客户端',
      }
    );
  }

  /**
   * 发送 CLIENT_DISCONNECTED
   */
  async sendClientDisconnected() {
    return await this.sendProtocolMessage(
      RongyunMessageTypeEnum.CLIENT_DISCONNECTED,
      {
        mac_address: getMacAddress(),
      }
    );
  }

  /**
   * 发送心跳
   */
  async sendHeartbeat() {
    return await this.sendProtocolMessage(
      RongyunMessageTypeEnum.HEARTBEAT,
      {
        mac_address: getMacAddress(),
        nickname: this.config.nodeName || 'CLI客户端',
        client_status: 1,
      }
    );
  }

  /**
   * 发送聊天消息回复
   */
  async sendChatMessage(content, requestId) {
    return await this.sendProtocolMessage(
      RongyunMessageTypeEnum.CHAT_MESSAGE,
      {
        status: 'success',
        message: 'Response received',
        content: content,
        metadata: {}
      },
      requestId
    );
  }

  /**
   * 发送消息到指定目标（P2P）
   */
  async sendToTarget(targetId, msgType, content, requestId) {
    if (!this.rongcloudClient?.isConnected) {
      this.log?.error('[RongyunMessageSender] 未连接，无法发送消息');
      return false;
    }

    try {
      const mac = getMacAddress();
      const secret = generateSecret(mac, this.config.secretKey || 'secret_key');
      const messagePayload = {
        msg_type: msgType,
        source_im_id: this.config.accountId || '',
        destination_im_id: targetId,
        mac: mac,
        secret: secret,
        content: typeof content === 'string' ? content : JSON.stringify(content),
        request_id: requestId || '',
        timestamp: Math.floor(Date.now() / 1000),
      };

      // 优先使用自定义消息类型发送 P2P 消息
      let result;
      // 客服消息和聊天消息都将业务内容放在顶层，方便前端解析
      if (this.rongcloudClient.ServiceChatMessage && (msgType.includes('service') || msgType === 'chat_message')) {
        // 对于客服/聊天消息，直接将业务内容放在顶层，方便前端解析
        // 兼容字符串内容（如快捷命令结果），避免 ...content 展开字符串成字符数组
        const serviceChatPayload = {
          msg_type: msgType,
          ...(typeof content === 'object' && content !== null ? content : { content }),
          request_id: requestId || '',
          timestamp: Math.floor(Date.now() / 1000),
        };
        result = await this.rongcloudClient.sendCustomMessage(
          targetId,
          serviceChatPayload,
          1, // PRIVATE
          'service_chat'
        );
      } else if (this.rongcloudClient.SystemServiceMessage) {
        result = await this.rongcloudClient.sendCustomMessage(
          targetId,
          messagePayload,
          1 // PRIVATE
        );
      } else {
        // 回退到文本消息（兼容旧版本）
        result = await this.rongcloudClient.sendMessage(
          targetId,
          messagePayload,
          1 // PRIVATE
        );
      }

      return result;
    } catch (err) {
      this.log?.error(`[RongyunMessageSender] P2P发送异常: ${err.message}`);
      return false;
    }
  }

  /**
   * 发送设备状态报告（P2P）
   */
  async sendDeviceStatusReport(targetId, requestId, data, error) {
    return await this.sendToTarget(
      targetId,
      RongyunMessageTypeEnum.DEVICE_STATUS_REPORT,
      {
        status: error ? 'error' : 'success',
        message: error || '状态报告',
        data
      },
      requestId
    );
  }

  /**
   * 发送流式消息片段（P2P）
   * 使用融云服务端API发送 RC:StreamMsg
   *
   * B3:支持 StreamDelta + extra 卡片壳(规范 §8.3 两层包装),透传给 serverAPI.sendStreamPrivate。
   * B4:删除旧纯文本 content/streamType 参数,强制 streamDelta。
   * 调用方按状态机构造 streamDelta:
   *   - 初始(思考中): {content:'', session_status:'thinking', seq:1, is_final:false}
   *   - 内容流:       {content: chunk, session_status:'responding', seq:n, is_final:false}
   *   - 最终(完成):   {content: fullText, session_status:'completed', seq:last, is_final:true}
   *   - 失败:         {session_status:'error', is_final:true, error: msg}
   *
   * @param {Object} options - 流式消息选项
   * @param {string} options.targetId - 目标用户ID
   * @param {string} options.streamId - 流式消息ID
   * @param {number} [options.seq=1] - 片段序号
   * @param {boolean} [options.isFirstChunk=false] - 是否首流
   * @param {boolean} [options.isLastChunk=false] - 是否尾流
   * @param {string} [options.messageUID] - 首流返回的messageUID（后续流使用）
   * @param {Object} options.streamDelta - StreamDelta 对象(必传,序列化为 content.content)
   * @param {Object} [options.extra] - 卡片壳对象(stream_type/card_template/card_id/title/version/actions),
   *                                   首流写入 content.extra 让前端渲染卡片壳并续流
   * @returns {Promise<Object>} 发送结果
   */
  async sendStreamToTarget({
    targetId,
    streamId,
    seq = 1,
    isFirstChunk = false,
    isLastChunk = false,
    messageUID = null,
    streamDelta,
    extra = null,
  }) {
    // 需要 serverAPI 支持
    if (!this.serverAPI) {
      this.log?.error('[RongyunMessageSender] serverAPI 未设置，无法发送流式消息');
      return false;
    }

    try {
      const fromUserId = this.config.accountId || '';

      const result = await this.serverAPI.sendStreamPrivate({
        fromUserId,
        toUserId: targetId,
        streamId,
        isFirstChunk,
        isLastChunk,
        seq,
        messageUID,
        streamDelta,
        extra,
      });

      this.log?.info(`[RongyunMessageSender] 流式消息已发送: seq=${seq}, first=${isFirstChunk}, last=${isLastChunk}, status=${streamDelta?.session_status || 'n/a'}`);
      return result;
    } catch (err) {
      this.log?.error(`[RongyunMessageSender] 发送流式消息失败: ${err.message}`);
      return false;
    }
  }

  /**
   * 设置 serverAPI（用于发送流式消息）
   * @param {RongCloudServerAPI} serverAPI 
   */
  setServerAPI(serverAPI) {
    this.serverAPI = serverAPI;
  }

  /**
   * 发送卡片消息（P2P）
   * 与 CardKit 规范对齐：接受规范 CardModel
   *   {schema:'1.0.0', id, header:{title,...}, sections:[...], config:{...}}
   *
   * B4:删除 v3 兼容期,cardData 必须是规范 CardModel(用 id 字段)。统一包装为
   * msg_type:'card_message' 经 sendMessage 路由,小程序按 schema/header/sections 渲染规范卡。
   *
   * @param {string} targetId - 目标用户ID
   * @param {Object} cardData - CardModel(规范)
   * @param {number} [conversationType=1] - 会话类型（1=单聊, 3=群聊）
   * @returns {Promise<boolean>}
   */
  async sendCardMessage(targetId, cardData, conversationType = 1) {
    // 包装 msg_type + timestamp,经 sendMessage 路由
    if (!this.rongcloudClient?.isConnected) {
      this.log?.error('[RongyunMessageSender] 未连接，无法发送卡片消息');
      return false;
    }

    try {
      const validation = validateCard(cardData);
      if (!validation.valid || !validation.sanitized) {
        this.log?.warn(`[RongyunMessageSender] 卡片校验失败: ${validation.errors.join('; ')}，降级为文本`);
        const fallbackText = cardData && cardData.header && typeof cardData.header.title === 'string'
          ? cardData.header.title
          : '卡片内容无效';
        return this.rongcloudClient.sendMessage(targetId, fallbackText, conversationType);
      }

      let card = validation.sanitized;
      let payload = {
        msg_type: 'card_message',
        schema: card.schema,
        card,
        timestamp: card.timestamp || Date.now(),
      };

      let size = estimateMessageSize(payload);
      if (size > SAFE_LIMIT) {
        this.log?.warn(`[RongyunMessageSender] 卡片消息体积(${size} 字节)超过安全阈值 ${SAFE_LIMIT}，执行截断`);
        card = truncateCardPayload(card);
        payload = {
          ...payload,
          card,
        };
        size = estimateMessageSize(payload);
        this.log?.warn(`[RongyunMessageSender] 截断后体积 ${size} 字节`);

        if (size > HARD_LIMIT) {
          this.log?.error(`[RongyunMessageSender] 截断后仍超过硬上限 ${HARD_LIMIT}，发送最小化错误卡片`);
          card = {
            schema: '1.0.0',
            id: cardData.id || `card-error-${Date.now()}`,
            header: { title: '消息过大', color: 'red' },
            sections: [
              { kind: 'markdown', content: '消息内容超过融云单条限制（5KB），无法完整展示。' },
              { kind: 'note', text: '请减少请求内容或分批查询。' },
            ],
            config: {},
          };
          payload = {
            msg_type: 'card_message',
            schema: card.schema,
            card,
            timestamp: Date.now(),
          };
        }
      }

      const result = await this.rongcloudClient.sendMessage(
        targetId,
        payload,
        conversationType
      );

      if (result) {
        this.log?.info(`[RongyunMessageSender] 卡片消息(client)已发送 -> ${targetId}, card_id=${cardData.id || 'unknown'}`);
      } else {
        this.log?.warn(`[RongyunMessageSender] 卡片消息发送失败 -> ${targetId}`);
      }

      return result;
    } catch (err) {
      this.log?.error(`[RongyunMessageSender] 发送卡片消息异常: ${err.message}`);
      return false;
    }
  }

  /**
   * 发送卡片增量更新消息(P2P)。
   *
   * 用于分批流式推送:首张卡片用 sendCardMessage 发出,后续批次用本方法发 card_update,
   * 小程序按 cardId 找到原卡片并将 appendCommands / appendSessions 累积追加到对应 section。
   *
   * 载荷契约(与前端约定):
   *   { msg_type:'card_update', cardId, card: { appendCommands?: CommandItem[], appendSessions?: SessionItem[] }, timestamp: number }
   *
   * 复用与 sendCardMessage 相同的 sendMessage 路由,仅 msg_type 设为 'card_update'
   * (rongcloud-client.sendMessage 已对 card_update 做显式对象构造,与 card_message 同构)。
   *
   * @param {string} targetId - 目标用户ID
   * @param {string} cardId - 首张卡片 ID(必须与首卡一致,前端按此合并)
   * @param {Object} appendData - 增量字段 { appendCommands?: [], appendSessions?: [] }
   * @param {number} [conversationType=1] - 会话类型
   * @returns {Promise<Object>} { success: boolean, size?: number, reason?: string, error?: string }
   */
  async sendCardUpdate(targetId, cardId, appendData, conversationType = 1) {
    if (!this.rongcloudClient?.isConnected) {
      this.log?.error('[RongyunMessageSender] 未连接，无法发送卡片更新');
      return { success: false, reason: 'not connected' };
    }

    try {
      let card = appendData;
      let payload = {
        msg_type: 'card_update',
        cardId,
        card,
        timestamp: Date.now(),
      };

      let size = estimateMessageSize(payload);
      if (size > SAFE_LIMIT) {
        // 尝试通过减半追加列表来降低体积(保持 card 嵌套)
        const truncated = { ...card };
        let currentSize = size;
        while (currentSize > SAFE_LIMIT) {
          let reduced = false;
          if (Array.isArray(truncated.appendCommands) && truncated.appendCommands.length > 1) {
            truncated.appendCommands = truncated.appendCommands.slice(0, Math.max(1, Math.floor(truncated.appendCommands.length / 2)));
            reduced = true;
          }
          if (Array.isArray(truncated.appendSessions) && truncated.appendSessions.length > 1) {
            truncated.appendSessions = truncated.appendSessions.slice(0, Math.max(1, Math.floor(truncated.appendSessions.length / 2)));
            reduced = true;
          }
          if (!reduced) break;
          card = truncated;
          payload = { ...payload, card };
          currentSize = estimateMessageSize(payload);
        }

        if (currentSize > SAFE_LIMIT) {
          this.log?.warn(`[RongyunMessageSender] card_update 体积超过安全阈值(${currentSize} > ${SAFE_LIMIT})，拒绝发送`);
          return { success: false, size: currentSize, reason: 'too large' };
        }

        this.log?.warn(`[RongyunMessageSender] card_update 体积超过安全阈值，已截断追加列表至 ${currentSize} 字节`);
        size = currentSize;
      }

      const result = await this.rongcloudClient.sendMessage(
        targetId,
        payload,
        conversationType
      );

      if (result) {
        const summary = [];
        if (appendData.appendCommands) summary.push(`+${appendData.appendCommands.length} cmd`);
        if (appendData.appendSessions) summary.push(`+${appendData.appendSessions.length} sess`);
        this.log?.info(`[RongyunMessageSender] card_update 已发送 -> ${targetId}, cardId=${cardId}, ${summary.join(' ')}`);
      } else {
        this.log?.warn(`[RongyunMessageSender] card_update 发送失败 -> ${targetId}, cardId=${cardId}`);
      }

      return { success: !!result, size };
    } catch (err) {
      this.log?.error(`[RongyunMessageSender] 发送 card_update 异常: ${err.message}`);
      return { success: false, reason: 'exception', error: err.message };
    }
  }
}

module.exports = {
  RongyunMessageSender
};
