const { MessageType } = require('./types');

class MessageHandler {
  constructor(config, sendFn, log, sendReadReceiptFn) {
    this.config = config;
    this.sendFn = sendFn;
    this.log = log;
    this.sendReadReceiptFn = sendReadReceiptFn;
    this.nodeId = config.accountId || '';
  }

  extractMentions(content) {
    const MENTION_REGEX = /@(claw_[a-zA-Z0-9]+)/g;
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

    // 优先从融云 mentionedInfo 提取被@用户列表
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
      this.log?.info(`[MessageHandler] 群聊消息未 @ 任何人，本节点(${this.nodeId})忽略普通消息`);
      return false;
    } else {
      this.log?.info(`[MessageHandler] 单聊消息未指定节点，本节点(${this.nodeId})忽略普通消息`);
      return false;
    }

    return true;
  }

  async handleMessage(msg) {
    if (!this.shouldHandleMessage(msg)) {
      return;
    }

    try {
      const logContent = typeof msg.content === 'string' ? msg.content : (msg.content?.content || '');
      this.log?.info(`[MessageHandler] 收到普通消息 from=${msg.senderUserId}, type=${msg.messageType}, content=${logContent.substring(0, 50)}`);

      // 发送已读回执（fire-and-forget，不阻塞消息处理）
      if (this.sendReadReceiptFn && msg.messageUId) {
        this.sendReadReceiptFn(msg).catch((err) => {
          this.log?.warn(`[MessageHandler] 发送已读回执失败: ${err.message}`);
        });
      }

      // 普通消息由 claw-messenger 处理，silent-service 不再处理 AI 对话
      this.log?.info('[MessageHandler] 普通消息已忽略（由 claw-messenger 负责处理）');
    } catch (err) {
      this.log?.error(`[MessageHandler] 处理消息异常: ${err.message}`);
    }
  }
}

module.exports = { MessageHandler };
