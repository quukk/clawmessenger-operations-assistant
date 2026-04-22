/**
 * 普通消息处理器 - 接收 rongcloud 转发的普通消息
 * 
 * 被调用位置：rongcloud/message-handler.js 第108行 handleNormal() 方法
 * 调用方式：通过 Monkey Patch 替换 OpenClawClient.chat
 * 
 * 原始代码（被注释）：
 * async handleNormal(msg) {
 *     const reply = await this.openclawClient.chat(msg.content, msg.senderUserId);
 *     ...
 * }
 * 
 * @param {Object} msg - 消息对象
 * @param {string} msg.content - 消息内容
 * @param {string} msg.senderUserId - 发送者ID
 * @param {string} msg.targetId - 目标ID
 * @param {number} msg.conversationType - 会话类型 (1=私聊, 3=群聊)
 * @param {string} msg.messageType - 消息类型
 * @param {boolean} msg.isOffLineMessage - 是否离线消息
 * @param {string} msg.messageUId - 消息唯一ID
 * @param {number} msg.sentTime - 发送时间戳
 * @returns {string} 回复内容
 */
async function handleNormalMessage(msg) {
  console.log(`[NormalMessageHandler] 收到普通消息:`, {
    from: msg.senderUserId,
    content: msg.content?.substring(0, 50),
    type: msg.conversationType === 1 ? '私聊' : '群聊'
  });

  try {
    // TODO: 在这里实现普通消息处理逻辑
    // 例如：
    // - AI 聊天回复
    // - 调用 opencode 服务
    // - 查询知识库
    // - 其他业务逻辑

    // 示例：简单回复
    return `收到您的消息: ${msg.content}`;

  } catch (err) {
    console.error(`[NormalMessageHandler] 处理异常:`, err.message);
    return `抱歉，处理消息时出错: ${err.message}`;
  }
}

module.exports = {
  handleNormalMessage
};
