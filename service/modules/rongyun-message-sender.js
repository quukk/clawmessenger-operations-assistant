/**
 * 融云消息发送工具
 * 
 * 封装与融云 guardserver 的消息交互
 * 服务端融云账号: guardserver
 */
const { RongyunMessageTypeEnum } = require('./rongyun-message-types');
const { getMacAddress } = require('./mac-address');
const { generateSecret } = require('./auth');

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
        JSON.stringify(messagePayload),
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
        const serviceChatPayload = {
          msg_type: msgType,
          ...content,  // 展开业务内容（status, content, sessionId, userId 等）
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
          JSON.stringify(messagePayload),
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
   * @param {Object} options - 流式消息选项
   * @param {string} options.targetId - 目标用户ID
   * @param {string} options.content - 消息片段内容
   * @param {string} options.streamId - 流式消息ID
   * @param {number} options.seq - 片段序号
   * @param {boolean} options.isFirstChunk - 是否首流
   * @param {boolean} options.isLastChunk - 是否尾流
   * @param {string} options.messageUID - 首流返回的messageUID（后续流使用）
   * @returns {Promise<Object>} 发送结果
   */
  async sendStreamToTarget({
    targetId,
    content,
    streamId,
    seq = 1,
    isFirstChunk = false,
    isLastChunk = false,
    messageUID = null
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
        content,
        streamId,
        isFirstChunk,
        isLastChunk,
        seq,
        streamType: 'text',
        messageUID
      });

      this.log?.info(`[RongyunMessageSender] 流式消息已发送: seq=${seq}, first=${isFirstChunk}, last=${isLastChunk}`);
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
}

module.exports = {
  RongyunMessageSender
};
