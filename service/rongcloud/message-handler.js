const { MessageType } = require('./types');
const { OpenClawClient } = require('./openclaw-client');
const { handleNormalMessage } = require('../modules/normal-message-handler');
const { RongCloudServerAPI } = require('./rongcloud-server-api');
const { SystemConfigManager } = require('../modules/system-config');
const axios = require('axios');
const MENTION_REGEX = /@(claw_[a-zA-Z0-9]+)/g;

class MessageHandler {
  constructor(config, sendFn, log, sendReadReceiptFn) {
    this.config = config;
    this.sendFn = sendFn;
    this.log = log;
    this.sendReadReceiptFn = sendReadReceiptFn;
    this.openclawClient = new OpenClawClient(log);
    // 初始化系统配置管理器（从 Python 服务端动态获取配置）
    this.configManager = new SystemConfigManager(config, log);
    // 初始化融云服务端 API 客户端（直接调用融云 API，无需通过服务端代理）
    this.serverAPI = new RongCloudServerAPI(this.configManager, log);
    this.log?.info('[MessageHandler] 融云服务端 API 客户端已初始化（配置从服务端动态获取）');
    this.nodeId = config.accountId || '';
    this.handleNormalMessage = handleNormalMessage;
    this._streamQueue = Promise.resolve();
    // 存储流式消息的 RongCloud messageUID：streamId -> messageUID
    this._streamMessageUIDs = new Map();
    // 群聊对话轮数统计：groupId -> currentRound
    this._groupRoundCounts = new Map();
    // 群组配置缓存：groupId -> { maxRounds, expiresAt }
    this._groupConfigCache = new Map();
    this._defaultMaxRounds = 10;
    this._groupConfigCacheTTL = config.groupConfigCacheTTL || 60000; // 默认缓存 60 秒
    
    // 消息合并相关
    this._pendingMessages = new Map(); // 待合并的消息
    this._messageMergeTimeout = 500; // 合并等待时间（毫秒）
  }

  /**
   * 判断是否支持流式处理
   * 现在配置从服务端动态获取，总是启用
   */
  get isStreamingEnabled() {
    return !!this.serverAPI;
  }

  extractMentions(content) {
    const mentions = [];
    let match;
    while ((match = MENTION_REGEX.exec(content)) !== null) {
      mentions.push(match[1]);
    }
    MENTION_REGEX.lastIndex = 0;
    return mentions;
  }

  shouldHandleMessage(msg) {
    // 过滤离线消息：离线消息是历史记录，不需要重复处理
    if (msg.isOffLineMessage) {
      this.log?.info('[MessageHandler] 收到离线消息，忽略');
      return false;
    }

    const allowedTypes = ['RC:TxtMsg', 'RC:ImgMsg', 'RC:SightMsg', 'RC:FileMsg', 'RC:HQVCMsg'];
    if (!allowedTypes.includes(msg.messageType)) {
      this.log?.info(`[MessageHandler] 忽略不支持的消息类型: ${msg.messageType}`);
      return false;
    }

    if (msg.senderUserId === this.config.accountId) {
      this.log?.info('[MessageHandler] 忽略自己发送的消息');
      return false;
    }

    // 优先从融云 mentionedInfo 提取被@用户列表（用户界面 @昵称，但融云底层存的是 userId）
    let mentions = [];
    if (msg.mentionedInfo && Array.isArray(msg.mentionedInfo.userIdList)) {
      mentions = msg.mentionedInfo.userIdList;
      if (mentions.length > 0) {
        this.log?.info(`[MessageHandler] 融云 mentionedInfo: ${mentions.join(', ')}，本节点: ${this.nodeId}`);
      }
    }

    // 兜底：从文本内容中正则匹配 @claw_xxx
    if (mentions.length === 0) {
      const textContent = typeof msg.content === 'string' ? msg.content : (msg.content?.content || '');
      mentions = this.extractMentions(textContent);
    }

    if (mentions.length > 0) {
      if (!mentions.includes(this.nodeId)) {
        this.log?.info(`[MessageHandler] 消息 @${mentions.join(', ')}，非本节点(${this.nodeId})，忽略`);
        return false;
      }
      this.log?.info(`[MessageHandler] 消息提及本节点(${this.nodeId})，处理`);
    } else if (msg.conversationType === 3) {
      // 群聊消息未 @ 任何人 → 视为所有人参与，正常处理
      this.log?.info(`[MessageHandler] 群聊消息未 @ 任何人，本节点(${this.nodeId})参与处理`);
    } else {
      this.log?.info(`[MessageHandler] 单聊消息未指定节点，本节点(${this.nodeId})处理`);
    }

    return true;
  }

  /**
   * 获取群聊当前轮数
   */
  _getGroupRoundCount(groupId) {
    return this._groupRoundCounts.get(groupId) || 0;
  }

  /**
   * 增加群聊轮数
   */
  _incrementGroupRoundCount(groupId, maxRounds) {
    const current = this._getGroupRoundCount(groupId);
    this._groupRoundCounts.set(groupId, current + 1);
    this.log?.info(`[MessageHandler] 群聊 ${groupId} 轮数 +1，当前: ${current + 1}/${maxRounds}`);
  }

  /**
   * 重置群聊轮数
   */
  _resetGroupRoundCount(groupId) {
    this._groupRoundCounts.set(groupId, 0);
    this.log?.info(`[MessageHandler] 群聊 ${groupId} 轮数已重置`);
  }

  /**
   * 从后端 API 获取群组配置
   */
  async _fetchGroupConfig(groupId) {
    try {
      const apiUrl = `${this.config.apiBaseUrl}/im/api/group/info`;
      this.log?.info(`[MessageHandler] 查询群组配置: groupId=${groupId}, url=${apiUrl}`);
      const resp = await axios.get(apiUrl, {
        params: { groupId: groupId },
        timeout: 5000
      });
      if (resp.data?.code === 200 && resp.data.data) {
        const maxRounds = resp.data.data.maxRounds;
        if (typeof maxRounds === 'number') {
          this.log?.info(`[MessageHandler] 群组 ${groupId} 配置: maxRounds=${maxRounds}`);
          return maxRounds;
        }
      }
    } catch (err) {
      this.log?.warn(`[MessageHandler] 获取群组配置失败: ${err.message}`);
    }
    return this._defaultMaxRounds;
  }

  /**
   * 获取群组最大轮数（带缓存）
   */
  async _getGroupMaxRounds(groupId) {
    const cached = this._groupConfigCache.get(groupId);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      return cached.maxRounds;
    }
    const maxRounds = await this._fetchGroupConfig(groupId);
    this._groupConfigCache.set(groupId, {
      maxRounds,
      expiresAt: now + this._groupConfigCacheTTL
    });
    return maxRounds;
  }

  async handleMessage(msg) {
    if (!this.shouldHandleMessage(msg)) {
      return;
    }

    try {
      const type = this.getMessageType(msg);
      const logContent = typeof msg.content === 'string' ? msg.content : (msg.content?.content || '');
      this.log?.info(`[MessageHandler] 收到消息 from=${msg.senderUserId}, type=${type}, content=${logContent.substring(0, 50)}`);

      // 群聊轮数控制（仅对群聊生效）
      let maxRounds = this._defaultMaxRounds;
      if (msg.conversationType === 3) {
        const groupId = msg.targetId;
        maxRounds = await this._getGroupMaxRounds(groupId);
        const currentRounds = this._getGroupRoundCount(groupId);

        // 处理内置轮数相关命令
        if (type === MessageType.COMMAND) {
          const payload = this.parseCommand(msg.content, msg.senderUserId);
          if (payload.command === 'newround') {
            this._resetGroupRoundCount(groupId);
            // 清空 OpenClaw 对话历史，确保新一轮对话没有上下文
            this.openclawClient.clearHistory(msg.senderUserId);
            await this.sendFn(groupId, `✅ 新一轮对话已开始，最大对话轮数为 ${maxRounds} 轮。`, msg.conversationType);
            return;
          }
          if (payload.command === 'roundstatus') {
            const remaining = Math.max(0, maxRounds - currentRounds);
            const statusMsg = currentRounds >= maxRounds
              ? `⛔ 本轮对话已结束（已达 ${maxRounds} 轮）。发送 /newround 开启新一轮。`
              : `📊 当前对话进度：第 ${currentRounds + 1}/${maxRounds} 轮，剩余 ${remaining} 轮。`;
            await this.sendFn(groupId, statusMsg, msg.conversationType);
            return;
          }
        }

        // 检查是否已达最大轮数
        if (currentRounds >= maxRounds) {
          this.log?.info(`[MessageHandler] 群聊 ${groupId} 已达到最大轮数 ${maxRounds}，拒绝处理`);
          await this.sendFn(groupId, `⛔ 本轮对话已达到最大轮数（${maxRounds} 轮），对话已结束。\n\n发送 /newround 可开启新一轮对话。`, msg.conversationType);
          return;
        }
      }

      // 发送已读回执（fire-and-forget，不阻塞消息处理）
      if (this.sendReadReceiptFn && msg.messageUId) {
        this.sendReadReceiptFn(msg).catch((err) => {
          this.log?.warn(`[MessageHandler] 发送已读回执失败: ${err.message}`);
        });
      }

      // 消息合并逻辑：如果是图片消息，等待一段时间看是否有文字消息跟随
      if (msg.messageType === 'RC:ImgMsg') {
        await this._handleImageMessageWithMerge(msg, maxRounds);
        return;
      }

      // 普通消息直接处理
      await this._processMessage(msg, maxRounds);
    } catch (err) {
      this.log?.error(`[MessageHandler] 处理消息异常: ${err.message}`);
      const targetId = msg.conversationType === 3 ? msg.targetId : msg.senderUserId;
      await this.sendFn(targetId, `处理失败: ${err.message}`, msg.conversationType);
    }
  }

  /**
   * 处理图片消息，支持合并后续文字消息
   */
  async _handleImageMessageWithMerge(msg, maxRounds) {
    const userId = msg.senderUserId;
    const conversationKey = `${msg.conversationType}-${msg.targetId}-${userId}`;
    
    // 设置待处理图片消息
    this._pendingMessages.set(conversationKey, {
      imageMsg: msg,
      timestamp: Date.now(),
    });
    
    // 等待一段时间，看是否有文字消息跟随
    await new Promise(resolve => setTimeout(resolve, this._messageMergeTimeout));
    
    // 获取待处理消息
    const pending = this._pendingMessages.get(conversationKey);
    this._pendingMessages.delete(conversationKey);
    
    if (!pending) {
      return; // 消息已被处理
    }
    
    // 构建合并后的消息内容
    const imageContent = this._extractMessageContent(pending.imageMsg);
    let mergedContent = imageContent;
    
    if (pending.textMsg) {
      const textContent = typeof pending.textMsg.content === 'string' 
        ? pending.textMsg.content 
        : (pending.textMsg.content?.content || '');
      mergedContent = `${textContent}\n${imageContent}`;
      this.log?.info(`[MessageHandler] 合并消息: 图片+文字`);
    }
    
    // 创建合并后的消息对象
    const mergedMsg = {
      ...pending.imageMsg,
      content: mergedContent,
      messageType: 'RC:TxtMsg', // 转为文本消息处理
    };
    
    await this._processMessage(mergedMsg, maxRounds);
  }

  /**
   * 处理普通消息（包括合并后的消息）
   */
  async _processMessage(msg, maxRounds) {
    // 如果配置了代理地址，使用流式处理
    if (this.isStreamingEnabled) {
      try {
        await this.handleNormalMessageStream(msg);
        // 流式处理成功，群聊轮数 +1
        if (msg.conversationType === 3) {
          this._incrementGroupRoundCount(msg.targetId, maxRounds);
        }
      } catch (err) {
        this.log?.error(`[MessageHandler] 流式处理失败，回退到非流式: ${err.message}`);
        
        // 只有非取消错误才回退到非流式处理
        if (err.message !== 'canceled') {
          const reply = await this.handleNormalMessage(msg);
          if (reply) {
            const targetId = this.getReplyTarget(msg);
            await this.sendFn(targetId, reply, msg.conversationType);
            // 非流式回退成功，群聊轮数 +1
            if (msg.conversationType === 3) {
              this._incrementGroupRoundCount(msg.targetId, maxRounds);
            }
          }
        } else {
          this.log?.info(`[MessageHandler] 请求被取消，不回退到非流式处理`);
        }
      }
    } else {
      // 降级到非流式处理
      const reply = await this.handleNormalMessage(msg);
      if (reply) {
        const targetId = this.getReplyTarget(msg);
        await this.sendFn(targetId, reply, msg.conversationType);
        // 非流式处理成功，群聊轮数 +1
        if (msg.conversationType === 3) {
          this._incrementGroupRoundCount(msg.targetId, maxRounds);
        }
      }
    }
  }

  getMessageType(msg) {
    // 如果是媒体消息，直接返回 NORMAL 类型
    if (['RC:ImgMsg', 'RC:SightMsg', 'RC:FileMsg', 'RC:HQVCMsg'].includes(msg.messageType)) {
      return MessageType.NORMAL;
    }
    const text = typeof msg.content === 'string' ? msg.content : (msg.content?.content || '');
    if (text.startsWith('/')) {
      return MessageType.COMMAND;
    }
    return MessageType.NORMAL;
  }

  getReplyTarget(msg) {
    if (msg.conversationType === 3) {
      return msg.targetId;
    }
    return msg.senderUserId;
  }

  async handleCommand(msg) {
    const payload = this.parseCommand(msg.content, msg.senderUserId);
    this.log?.info(`[MessageHandler] 指令消息: command=${payload.command}, args=${payload.args.join(', ')}`);

    let reply;
    if (this.config.onCommand) {
      try {
        reply = await this.config.onCommand(payload);
      } catch (err) {
        this.log?.error(`[MessageHandler] 指令处理回调异常: ${err.message}`);
        reply = `指令执行异常: ${err.message}`;
      }
    } else {
      reply = `指令 "${payload.command}" 暂未实现`;
    }

    const targetId = this.getReplyTarget(msg);
    await this.sendFn(targetId, reply, msg.conversationType);
  }

  /**
   * 流式处理普通消息
   */
  async handleNormalMessageStream(msg) {
    const targetId = this.getReplyTarget(msg);
    const streamId = `${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
    let seq = 0;
    let buffer = '';
    const fromUserId = this.config.accountId;
    const conversationType = msg.conversationType;

    // 1. 发送 typing 状态
    await this._sendTypingStatus(fromUserId, targetId, conversationType);

    this.log?.info(`[MessageHandler] 开始流式处理，streamId=${streamId}`);

    // 2. 调用 OpenClaw SSE
    let hasSentChunk = false;
    // typing 刷新定时器：每次 delta 时刷新 typing，超时后自动停止
    let typingTimer = null;
    const refreshTyping = async () => {
      // 清除旧的超时
      if (typingTimer) {
        clearTimeout(typingTimer);
        typingTimer = null;
      }
      // 发送 typing
      await this._sendTypingStatus(fromUserId, targetId, conversationType);
      // 设置 3 秒超时，如果 3 秒内没有新的 delta，typing 自动消失
      typingTimer = setTimeout(() => {
        this.log?.info(`[MessageHandler] typing 超时自动清除: streamId=${streamId}`);
        typingTimer = null;
      }, 3000);
    };

    try {
      // 确保传入的内容是字符串（claw 类型消息 content 可能是对象）
      const chatContent = this._extractMessageContent(msg);
      this.log?.info(`[MessageHandler] 调用 chatStream, content_type=${typeof msg.content}, chatContent=${chatContent.substring(0, 50)}`);
      await this.openclawClient.chatStream(
        chatContent,
        msg.senderUserId,
        async (delta) => {
          buffer += delta;
          seq += 1;
          this.log?.info(`[MessageHandler] onDelta: seq=${seq}, delta_len=${delta.length}, buffer_len=${buffer.length}`);
          // 发送增量（delta），让前端做增量拼接，避免内容重复
          await this._sendStreamChunk(fromUserId, targetId, conversationType, delta, streamId, seq === 1, false, seq);
          hasSentChunk = true;
          // 每次有输出时刷新 typing 状态
          await refreshTyping();
        },
        async (fullText) => {
          this.log?.info(`[MessageHandler] onDone 触发, fullText.length=${fullText.length}, buffer.length=${buffer.length}, hasSentChunk=${hasSentChunk}`);
          
          // 清除 typing 定时器
          if (typingTimer) {
            clearTimeout(typingTimer);
            typingTimer = null;
          }
          
          if (buffer.trim()) {
            // 发送尾流：空字符串表示流结束，前端保留已拼接的完整内容
            seq += 1;
            await this._sendStreamChunk(fromUserId, targetId, conversationType, '', streamId, false, true, seq);
            hasSentChunk = true;
          } else if (hasSentChunk) {
            // 已经发送过内容，单独发送结束标记
            seq += 1;
            await this._sendStreamChunk(fromUserId, targetId, conversationType, '', streamId, false, true, seq);
          } else {
            // 完全没有收到内容，发送错误提示
            await this._sendStreamChunk(fromUserId, targetId, conversationType, '抱歉，AI 暂时没有回复内容。', streamId, true, true, 1);
            hasSentChunk = true;
          }

          if (!hasSentChunk) {
            throw new Error('流式消息发送失败，没有任何片段成功送达');
          }

          this.log?.info(`[MessageHandler] 流式消息完成，streamId=${streamId}, 总长度: ${fullText.length}`);
          
          // 发送持久化的普通文本消息作为历史记录（融云会保存 RC:TxtMsg）
          if (buffer.trim()) {
            try {
              // 使用融云首流返回的 messageUID 作为 streamId，确保与前端匹配
              const rongCloudMsgUID = this._streamMessageUIDs.get(streamId);
              const historyStreamId = rongCloudMsgUID || streamId;
              this.log?.info(`[MessageHandler] 发送历史记录文本消息: length=${buffer.length}, streamId=${historyStreamId}`);
              // 使用 JSON 格式包含 streamId，前端可据此关联并更新流式消息内容
              const historyContent = JSON.stringify({
                __stream_history__: true,
                streamId: historyStreamId,
                text: buffer,
                sentTime: Date.now()
              });
              await this.sendFn(targetId, historyContent, conversationType);
            } catch (err) {
              this.log?.error(`[MessageHandler] 发送历史记录失败: ${err.message}`);
            }
          }
          
          // 清理已存储的 messageUID，防止内存泄漏
          this._streamMessageUIDs.delete(streamId);
        }
      );
    } catch (err) {
      this.log?.error(`[MessageHandler] 流式处理错误: ${err.message}`);
      
      // 清除 typing 定时器
      if (typingTimer) {
        clearTimeout(typingTimer);
        typingTimer = null;
      }
      
      // 只有非取消错误才发送错误提示
      if (err.message !== 'canceled') {
        await this._sendStreamChunk(fromUserId, targetId, conversationType, '抱歉，AI 响应出现错误，请稍后重试。', streamId, true, true, 1);
      } else {
        this.log?.info(`[MessageHandler] 请求被取消，不发送错误提示消息`);
      }
      
      // 错误时也要清理
      this._streamMessageUIDs.delete(streamId);
      throw err;
    }
  }

  /**
   * 发送 typing 状态（直接调用融云 API）
   */
  async _sendTypingStatus(fromUserId, targetId, conversationType) {
    if (!this.isStreamingEnabled || !this.serverAPI) return;
    try {
      await this.serverAPI.sendTypingStatus({
        fromUserId,
        toUserId: targetId,
        conversationType
      });
      this.log?.info(`[MessageHandler] typing 状态已发送: ${fromUserId} -> ${targetId}`);
    } catch (err) {
      this.log?.warn(`[MessageHandler] 发送 typing 状态失败: ${err.message}`);
    }
  }

  /**
   * 发送流式消息片段（直接调用融云 API）
   */
  async _sendStreamChunk(fromUserId, targetId, conversationType, content, streamId, isFirstChunk, isLastChunk, seq = 1) {
    const contentPreview = typeof content === 'string' ? content.substring(0, 100) : JSON.stringify(content).substring(0, 100);
    this.log?.info(`[MessageHandler] _sendStreamChunk ENTRY: target=${targetId}, streamId=${streamId}, seq=${seq}, first=${isFirstChunk}, last=${isLastChunk}, content_len=${content?.length || 0}, content_preview=${contentPreview}`);
    if (!this.isStreamingEnabled || !this.serverAPI) {
      this.log?.warn('[MessageHandler] _sendStreamChunk  skipped: 未配置 appKey/appSecret');
      return;
    }
    
    // 使用队列确保流式消息片段串行发送，避免并发导致后端处理错乱
    this._streamQueue = this._streamQueue.then(async () => {
      try {
        // 获取已存储的 RongCloud messageUID（首流响应返回的）
        const messageUID = this._streamMessageUIDs.get(streamId);
        
        let result;
        if (conversationType === 3) {
          // 群聊流式消息
          result = await this.serverAPI.sendStreamGroup({
            fromUserId,
            toGroupId: targetId,
            content,
            streamId,
            isFirstChunk,
            isLastChunk,
            seq,
            messageUID
          });
        } else {
          // 单聊流式消息
          result = await this.serverAPI.sendStreamPrivate({
            fromUserId,
            toUserId: targetId,
            content,
            streamId,
            isFirstChunk,
            isLastChunk,
            seq,
            messageUID
          });
        }
        
        // 首流时存储 RongCloud 返回的 messageUID
        if (isFirstChunk && result?.messageUID) {
          this._streamMessageUIDs.set(streamId, result.messageUID);
          this.log?.info(`[MessageHandler] 首流 messageUID 已存储: ${result.messageUID}, streamId=${streamId}`);
        }
        
        this.log?.info(`[MessageHandler] _sendStreamChunk 成功: seq=${seq}`);
      } catch (err) {
        this.log?.warn(`[MessageHandler] 发送流式消息失败: ${err.message}, seq=${seq}`);
      }
    });
    
    await this._streamQueue;
  }

  /**
   * 提取消息内容，支持文本、图片、视频、文件、语音
   */
  _extractMessageContent(msg) {
    const msgType = msg.messageType;
    const content = msg.content;

    // 调试：打印完整消息内容
    this.log?.info(`[_extractMessageContent] msgType=${msgType}, content=${JSON.stringify(content).substring(0, 200)}`);

    // 文本消息
    if (msgType === 'RC:TxtMsg') {
      return typeof content === 'string' ? content : (content?.content || JSON.stringify(content));
    }

    // 图片消息
    if (msgType === 'RC:ImgMsg') {
      // content 可能是对象（包含 imageUri）或字符串（base64 缩略图或 JSON）
      let imageUri = '';
      
      if (typeof content === 'string') {
        // 尝试解析 content 是否为 JSON（包含 imageUri）
        try {
          const contentObj = JSON.parse(content);
          if (contentObj.imageUri) {
            imageUri = contentObj.imageUri;
          }
        } catch (e) {
          // content 不是 JSON，可能是 base64 缩略图
          // 从 msg 其他字段查找 URL
          imageUri = msg.imageUri || msg.imageUrl || msg.url || msg.localPath || '';
        }
      } else if (typeof content === 'object' && content !== null) {
        // content 是对象，包含 imageUri
        imageUri = content.imageUri || content.imageUrl || content.url || '';
      }
      
      // 如果还是没有找到 URL，尝试从 extra 字段获取
      if (!imageUri && msg.extra) {
        try {
          const extraData = JSON.parse(msg.extra);
          imageUri = extraData.imageUrl || extraData.imageUri || '';
        } catch (e) {
          // extra 不是 JSON，忽略
        }
      }
      
      this.log?.info(`[_extractMessageContent] 图片消息: imageUri=${imageUri}`);
      
      if (!imageUri) {
        return '[图片]（无法获取图片地址）';
      }
      
      return `[图片] ${imageUri}`;
    }

    // 视频消息
    if (msgType === 'RC:SightMsg') {
      let sightUrl = '';
      let name = '未知视频';
      let duration = 0;
      
      if (typeof content === 'object' && content !== null) {
        sightUrl = content.sightUrl || content.url || '';
        name = content.name || '未知视频';
        duration = content.duration || 0;
      } else if (typeof content === 'string') {
        // 尝试解析 content 是否为 JSON（包含 sightUrl）
        try {
          const contentObj = JSON.parse(content);
          if (contentObj.sightUrl) {
            sightUrl = contentObj.sightUrl;
            name = contentObj.name || '未知视频';
            duration = contentObj.duration || 0;
          }
        } catch (e) {
          // content 不是 JSON，可能是 base64 缩略图
          sightUrl = msg.sightUrl || msg.url || msg.localPath || '';
        }
      } else {
        sightUrl = msg.sightUrl || msg.url || msg.localPath || '';
      }
      
      // 如果还是没有找到 URL，尝试从 extra 字段获取
      if (!sightUrl && msg.extra) {
        try {
          const extraData = JSON.parse(msg.extra);
          sightUrl = extraData.videoUrl || extraData.sightUrl || '';
        } catch (e) {
          // extra 不是 JSON，忽略
        }
      }
      
      this.log?.info(`[_extractMessageContent] 视频消息: sightUrl=${sightUrl}`);
      
      if (!sightUrl) {
        return '[视频]（无法获取视频地址）';
      }
      
      return `[视频] ${sightUrl} ${name} ${duration}秒`;
    }

    // 文件消息
    if (msgType === 'RC:FileMsg') {
      let fileUrl = '';
      let name = '未知文件';
      let size = 0;
      
      if (typeof content === 'object' && content !== null) {
        fileUrl = content.fileUrl || content.fileUri || content.url || '';
        name = content.name || '未知文件';
        size = content.size || 0;
      } else if (typeof content === 'string') {
        // 尝试解析 content 是否为 JSON（包含 fileUrl）
        try {
          const contentObj = JSON.parse(content);
          if (contentObj.fileUrl) {
            fileUrl = contentObj.fileUrl;
          }
        } catch (e) {
          // content 不是 JSON
          fileUrl = msg.fileUrl || msg.fileUri || msg.url || msg.localPath || '';
        }
      } else {
        fileUrl = msg.fileUrl || msg.fileUri || msg.url || msg.localPath || '';
      }
      
      // 如果还是没有找到 URL，尝试从 extra 字段获取
      if (!fileUrl && msg.extra) {
        try {
          const extraData = JSON.parse(msg.extra);
          fileUrl = extraData.fileUrl || extraData.fileUri || '';
        } catch (e) {
          // extra 不是 JSON，忽略
        }
      }
      
      this.log?.info(`[_extractMessageContent] 文件消息: fileUrl=${fileUrl}`);
      
      if (!fileUrl) {
        return '[文件]（无法获取文件地址）';
      }
      
      return `[文件] ${fileUrl} ${name} ${size}`;
    }

    // 语音消息
    if (msgType === 'RC:HQVCMsg') {
      let remoteUrl = '';
      let duration = 0;
      
      if (typeof content === 'object' && content !== null) {
        remoteUrl = content.remoteUrl || content.url || '';
        duration = content.duration || 0;
      } else {
        remoteUrl = msg.remoteUrl || msg.url || msg.localPath || '';
      }
      
      this.log?.info(`[_extractMessageContent] 语音消息: remoteUrl=${remoteUrl}`);
      return `[语音] ${remoteUrl} ${duration}秒`;
    }

    // 兜底
    return typeof content === 'string' ? content : JSON.stringify(content);
  }

  parseCommand(raw, senderId) {
    const trimmed = raw.slice(1).trim();
    const parts = trimmed.split(/\s+/);
    return {
      command: parts[0] || '',
      args: parts.slice(1),
      rawMessage: raw,
      senderId
    };
  }
}

module.exports = { MessageHandler };
