const { MessageType } = require('./types');
const { OpenClawClient } = require('./openclaw-client');
const { handleNormalMessage } = require('../modules/normal-message-handler');
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
    if (msg.isOffLineMessage) {
      this.log?.info('[MessageHandler] 忽略离线消息');
      return false;
    }

    const allowedTypes = ['RC:TxtMsg', 'claw'];
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
      if (msg.messageType === 'claw') {
        this.log?.info(`收到龙虾消息，交由 OpenClawClient 处理`);
        await this.handleClaw(msg);
      } else {
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
    if (msg.messageType === 'claw') {
      return MessageType.CLAW;
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

  async handleClaw(msg) {
    const targetId = this.getReplyTarget(msg);

    // 发送已读回执（fire-and-forget，不阻塞）
    if (this.sendReadReceiptFn) {
      this.sendReadReceiptFn(msg).catch(() => {});
    }

    // 后台执行 openclaw，不阻塞消息队列
    this.openclawClient.chat(msg.content, msg.senderUserId)
      .then(reply => {
        this.log?.info(`[MessageHandler] AI 回复: ${reply.substring(0, 50)}...`);
        this.sendFn(targetId, reply, msg.conversationType).catch(() => {});
      })
      .catch(err => {
        this.log?.error(`[MessageHandler] OpenClaw 调用失败: ${err.message}`);
        this.sendFn(targetId, `❌ 处理失败: ${err.message}`, msg.conversationType).catch(() => {});
      });
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
