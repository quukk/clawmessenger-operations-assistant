const { MessageType } = require('./types');
const { OpenClawClient } = require('./openclaw-client');

const MENTION_REGEX = /@(claw_[a-zA-Z0-9]+)/g;

class MessageHandler {
  constructor(config, sendFn, log) {
    this.config = config;
    this.sendFn = sendFn;
    this.log = log;
    this.openclawClient = new OpenClawClient(log);
    this.nodeId = config.accountId || '';
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

    if (msg.messageType !== 'RC:TxtMsg') {
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
      const type = this.getMessageType(msg.content);
      this.log?.info(`[MessageHandler] 收到消息 from=${msg.senderUserId}, type=${type}, content=${msg.content.substring(0, 50)}`);

      if (type === MessageType.NORMAL) {
        await this.handleNormal(msg);
      } else {
        await this.handleCommand(msg);
      }
    } catch (err) {
      this.log?.error(`[MessageHandler] 处理消息异常: ${err.message}`);
      const targetId = msg.conversationType === 3 ? msg.targetId : msg.senderUserId;
      await this.sendFn(targetId, `处理失败: ${err.message}`, msg.conversationType);
    }
  }

  getMessageType(content) {
    return content.startsWith('/') ? MessageType.COMMAND : MessageType.NORMAL;
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

  async handleNormal(msg) {
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
