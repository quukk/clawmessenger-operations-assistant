/**
 * 消息处理器 - 接收 rongcloud 转发的消息
 * 
 * rongcloud-client.js 会将消息转发到 handler.handleMessage(msg) 方法
 * 位置：rongcloud-client.js 第161-164行
 * 
 * 注意：rongcloud-client.js 第131-138行会过滤掉结构化消息（msg_type 在 SYSTEM_MSG_TYPES 中的）
 * 所以此方法只能收到普通消息（AI聊天等）
 */
class MessageProcessor {
  constructor(config, rongcloudClient, log) {
    this.config = config;
    this.rongcloudClient = rongcloudClient;
    this.log = log;
  }

  /**
   * 接收 rongcloud 转发的普通消息
   * 被调用位置：rongcloud-client.js 第163行
   * 
   * @param {Object} msg - 消息对象
   * @param {string} msg.senderUserId - 发送者ID
   * @param {string} msg.targetId - 目标ID
   * @param {number} msg.conversationType - 会话类型 (1=私聊, 3=群聊)
   * @param {string} msg.content - 消息内容
   * @param {string} msg.messageType - 消息类型 (如 'RC:TxtMsg')
   * @param {boolean} msg.isOffLineMessage - 是否离线消息
   */
  async handleMessage(msg) {
    this.log?.info(`[MessageProcessor] 收到普通消息 from=${msg.senderUserId}, content=${msg.content?.substring(0, 50)}`);
    
    try {
      // 处理普通消息（AI聊天等）
      await this.handleNormalMessage(msg);
    } catch (err) {
      this.log?.error(`[MessageProcessor] 处理消息异常: ${err.message}`);
      // 发送错误回复
      await this.sendReply(msg, `处理失败: ${err.message}`);
    }
  }

  // 处理普通消息
  async handleNormalMessage(msg) {
    // TODO: 实现普通消息处理逻辑（AI聊天等）
    this.log?.info('[MessageProcessor] 处理普通消息');
  }

  // 发送回复
  async sendReply(msg, content) {
    try {
      await this.rongcloudClient.sendMessage(
        msg.senderUserId,
        content,
        msg.conversationType
      );
    } catch (err) {
      this.log?.error(`[MessageProcessor] 发送回复失败: ${err.message}`);
    }
  }
}

module.exports = { MessageProcessor };
