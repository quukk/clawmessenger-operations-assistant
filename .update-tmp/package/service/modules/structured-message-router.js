/**
 * 结构化消息路由器
 * 
 * 由于不能修改 rongcloud/ 文件夹的代码，此模块在 worker.js 中拦截消息，
 * 在传给 MessageHandler 之前解析结构化消息并路由到正确的处理器。
 * 
 * 问题背景：
 * - rongcloud-client.js 现在会传递所有消息（SYSTEM_MSG_TYPES 已清空）
 * - 但 message-handler.js 的 getMessageType() 只检查 content 是否以 '/' 开头
 * - 结构化消息（如 command）的 content 是 JSON 字符串，不以 '/' 开头
 * - 导致所有结构化消息被当作 NORMAL 消息处理
 * 
 * 解决方案：
 * - 在 worker.js 中包装 MessageHandler.handleMessage()
 * - 在消息到达业务处理器之前，解析 JSON 并检查 msg_type
 * - 根据 msg_type 路由到正确的处理器
 */
const { RongyunMessageTypeEnum } = require('./rongyun-message-types');

class StructuredMessageRouter {
  constructor(config, log) {
    this.config = config;
    this.log = log;
    this.handlers = new Map();
  }

  /**
   * 注册消息处理器
   * @param {string} msgType - 消息类型（来自 RongyunMessageTypeEnum）
   * @param {Function} handler - 处理函数 async (parsedMessage) => result
   */
  registerHandler(msgType, handler) {
    this.handlers.set(msgType, handler);
    this.log?.info(`[StructuredMessageRouter] 注册处理器: ${msgType}`);
  }

  /**
   * 解析并路由消息
   * @param {Object} msg - rongcloud-client.js 传来的消息对象
   * @returns {Object|null} - 如果是结构化消息，返回解析后的对象；否则返回 null
   */
  async routeMessage(msg) {
    if (!msg || !msg.content) {
      return null;
    }

    // 尝试解析 JSON
    let parsed = null;
    try {
      parsed = JSON.parse(msg.content);
    } catch {
      // 不是 JSON，可能是普通文本消息
      return null;
    }

    // 检查是否是结构化协议消息
    if (!parsed.msg_type) {
      return null;
    }

    this.log?.info(`[StructuredMessageRouter] 收到结构化消息: type=${parsed.msg_type}, from=${parsed.source_im_id}`);

    // 忽略自己发送的消息
    if (parsed.source_im_id === this.config.accountId) {
      this.log?.info(`[StructuredMessageRouter] 忽略自己发送的消息`);
      return { handled: true };
    }

    // 查找处理器
    const handler = this.handlers.get(parsed.msg_type);
    if (handler) {
      try {
        // 解析 content 字段（它本身可能是 JSON 字符串）
        let innerContent = parsed.content;
        if (typeof innerContent === 'string') {
          try {
            innerContent = JSON.parse(innerContent);
          } catch {
            // 保持字符串
          }
        }

        const messageData = {
          ...parsed,
          content: innerContent,
          rawMessage: msg,
        };

        await handler(messageData);
        return { handled: true };
      } catch (err) {
        this.log?.error(`[StructuredMessageRouter] 处理器异常: ${err.message}`);
        return { handled: true, error: err.message };
      }
    }

    // 没有注册处理器，返回 null 让上层处理
    this.log?.warn(`[StructuredMessageRouter] 未找到处理器: ${parsed.msg_type}`);
    return null;
  }

  /**
   * 检查消息是否是结构化消息
   */
  isStructuredMessage(msg) {
    if (!msg || !msg.content) return false;
    try {
      const parsed = JSON.parse(msg.content);
      return !!parsed.msg_type;
    } catch {
      return false;
    }
  }
}

module.exports = {
  StructuredMessageRouter
};