const { MessageType } = require('./types');
const { OpenClawClient } = require('./openclaw-client');
const { handleNormalMessage } = require('../modules/normal-message-handler');
const axios = require('axios');
const MENTION_REGEX = /@(claw_[a-zA-Z0-9]+)/g;

class MessageHandler {
  constructor(config, sendFn, log, sendReadReceiptFn) {
    this.config = config;
    this.sendFn = sendFn;
    this.log = log;
    this.sendReadReceiptFn = sendReadReceiptFn;
    this.openclawClient = new OpenClawClient(log);
    this.nodeId = config.accountId || '';
    this.handleNormalMessage = handleNormalMessage;
    this._streamQueue = Promise.resolve();
    // 存储流式消息的 RongCloud messageUID：streamId -> messageUID
    this._streamMessageUIDs = new Map();
  }

  /**
   * 判断是否支持流式处理
   */
  get isStreamingEnabled() {
    return !!this.config.apiBaseUrl;
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

    const allowedTypes = ['RC:TxtMsg'];
    if (!allowedTypes.includes(msg.messageType)) {
      this.log?.info(`[MessageHandler] 忽略非文本消息: ${msg.messageType}`);
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

  async handleMessage(msg) {
    if (!this.shouldHandleMessage(msg)) {
      return;
    }

    try {
      const type = this.getMessageType(msg);
      const logContent = typeof msg.content === 'string' ? msg.content : (msg.content?.content || '');
      this.log?.info(`[MessageHandler] 收到消息 from=${msg.senderUserId}, type=${type}, content=${logContent.substring(0, 50)}`);

      // 如果配置了代理地址，使用流式处理
      if (this.isStreamingEnabled) {
        try {
          await this.handleNormalMessageStream(msg);
        } catch (err) {
          this.log?.error(`[MessageHandler] 流式处理失败，回退到非流式: ${err.message}`);
          const reply = await this.handleNormalMessage(msg);
          if (reply) {
            const targetId = this.getReplyTarget(msg);
            await this.sendFn(targetId, reply, msg.conversationType);
          }
        }
      } else {
        // 降级到非流式处理
        const reply = await this.handleNormalMessage(msg);
        if (reply) {
          const targetId = this.getReplyTarget(msg);
          await this.sendFn(targetId, reply, msg.conversationType);
        }
      }
    } catch (err) {
      this.log?.error(`[MessageHandler] 处理消息异常: ${err.message}`);
      const targetId = msg.conversationType === 3 ? msg.targetId : msg.senderUserId;
      await this.sendFn(targetId, `处理失败: ${err.message}`, msg.conversationType);
    }
  }

  getMessageType(msg) {
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
    try {
      // 确保传入的内容是字符串（claw 类型消息 content 可能是对象）
      const chatContent = typeof msg.content === 'string' ? msg.content : (msg.content?.content || JSON.stringify(msg.content));
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
        },
        async (fullText) => {
          this.log?.info(`[MessageHandler] onDone 触发, fullText.length=${fullText.length}, buffer.length=${buffer.length}, hasSentChunk=${hasSentChunk}`);
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
          
          // 清理已存储的 messageUID，防止内存泄漏
          this._streamMessageUIDs.delete(streamId);
        }
      );
    } catch (err) {
      this.log?.error(`[MessageHandler] 流式处理错误: ${err.message}`);
      await this._sendStreamChunk(fromUserId, targetId, conversationType, '抱歉，AI 响应出现错误，请稍后重试。', streamId, true, true, 1);
      
      // 错误时也要清理
      this._streamMessageUIDs.delete(streamId);
      throw err;
    }
  }

  /**
   * 发送 typing 状态（通过 Python 后端代理）
   */
  async _sendTypingStatus(fromUserId, targetId, conversationType) {
    if (!this.isStreamingEnabled) return;
    try {
      await axios.post(
        `${this.config.apiBaseUrl}/im/api/proxy/stream/typing`,
        {
          fromUserId,
          targetId,
          conversationType
        },
        { timeout: 5000 }
      );
      this.log?.info(`[MessageHandler] typing 状态已发送: ${fromUserId} -> ${targetId}`);
    } catch (err) {
      const url = `${this.config.apiBaseUrl}/im/api/proxy/stream/typing`;
      const status = err.response?.status;
      this.log?.warn(`[MessageHandler] 发送 typing 状态失败: ${err.message}, url=${url}, status=${status || 'N/A'}`);
    }
  }

  /**
   * 发送流式消息片段（通过 Python 后端代理）
   */
  async _sendStreamChunk(fromUserId, targetId, conversationType, content, streamId, isFirstChunk, isLastChunk, seq = 1) {
    const contentPreview = typeof content === 'string' ? content.substring(0, 100) : JSON.stringify(content).substring(0, 100);
    this.log?.info(`[MessageHandler] _sendStreamChunk ENTRY: target=${targetId}, streamId=${streamId}, seq=${seq}, first=${isFirstChunk}, last=${isLastChunk}, content_len=${content?.length || 0}, content_preview=${contentPreview}`);
    if (!this.isStreamingEnabled) {
      this.log?.warn('[MessageHandler] _sendStreamChunk  skipped: isStreamingEnabled=false');
      return;
    }
    
    // 使用队列确保流式消息片段串行发送，避免并发导致后端处理错乱
    this._streamQueue = this._streamQueue.then(async () => {
      try {
        // 获取已存储的 RongCloud messageUID（首流响应返回的）
        const messageUID = this._streamMessageUIDs.get(streamId);
        
        const payload = {
          fromUserId,
          targetId,
          content,
          streamId,
          isFirstChunk,
          isLastChunk,
          conversationType,
          seq,
          messageUID
        };
        this.log?.info(`[MessageHandler] _sendStreamChunk 请求体: ${JSON.stringify(payload).substring(0, 300)}`);
        const resp = await axios.post(
          `${this.config.apiBaseUrl}/im/api/proxy/stream/publish`,
          payload,
          { timeout: 10000 }
        );
        
        // 首流时存储 RongCloud 返回的 messageUID
        if (isFirstChunk && resp.data?.messageUID) {
          this._streamMessageUIDs.set(streamId, resp.data.messageUID);
          this.log?.info(`[MessageHandler] 首流 messageUID 已存储: ${resp.data.messageUID}, streamId=${streamId}`);
        }
        
        this.log?.info(`[MessageHandler] _sendStreamChunk 成功: status=${resp.status}, seq=${seq}, response=${JSON.stringify(resp.data).substring(0, 200)}`);
      } catch (err) {
        const url = `${this.config.apiBaseUrl}/im/api/proxy/stream/publish`;
        const status = err.response?.status;
        const responseData = err.response?.data ? JSON.stringify(err.response.data).substring(0, 200) : 'N/A';
        this.log?.warn(`[MessageHandler] 发送流式消息失败: ${err.message}, url=${url}, status=${status || 'N/A'}, response=${responseData}, seq=${seq}`);
      }
    });
    
    await this._streamQueue;
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
