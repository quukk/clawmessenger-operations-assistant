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

    const mentions = this.extractMentions(msg.content);

    if (mentions.length > 0) {
      if (!mentions.includes(this.nodeId)) {
        this.log?.info(`[MessageHandler] 消息 @${mentions.join(', ')}，非本节点(${this.nodeId})，忽略`);
        return false;
      }
      this.log?.info(`[MessageHandler] 消息提及本节点(${this.nodeId})，处理`);
    } else {
      this.log?.info(`[MessageHandler] 消息未指定节点，本节点(${this.nodeId})处理`);
    }

    return true;
  }

  async handleMessage(msg) {
    if (!this.shouldHandleMessage(msg)) {
      return;
    }

    try {
      const type = this.getMessageType(msg);
      this.log?.info(`[MessageHandler] 收到消息 from=${msg.senderUserId}, type=${type}, content=${msg.content.substring(0, 50)}`);
      if (msg.messageType === 'claw') {
        this.log?.info(`收到龙虾消息，交由 OpenClawClient 处理`);
        await this.handleClaw(msg);
      } else {
        await this.handleNormalMessage(msg);
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
    if (msg.content && msg.content.startsWith('/')) {
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
    // 先发送已读回执（表示消息已被接收和处理）
    if (this.sendReadReceiptFn) {
      try {
        await this.sendReadReceiptFn(msg);
        this.log?.info(`[MessageHandler] 已读回执已发送`);
      } catch (err) {
        this.log?.error(`[MessageHandler] 发送已读回执失败: ${err.message}`);
      }
    }

    const reply = await this.openclawClient.chat(msg.content, msg.senderUserId);
    this.log?.info(`[MessageHandler] AI 回复: ${reply.substring(0, 50)}...`);

    const targetId = this.getReplyTarget(msg);
    await this.sendFn(targetId, reply, msg.conversationType);
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
