/**
 * 普通消息处理器 - 接收 rongcloud 转发的普通消息并调用 AI 服务
 *
 * 被调用位置：rongcloud/message-handler.js
 * 调用方式：await this.handleNormalMessage(msg)
 *
 * @param {Object} msg - 消息对象
 * @param {string} msg.content - 消息内容
 * @param {string} msg.senderUserId - 发送者ID
 * @param {string} msg.targetId - 目标ID
 * @param {number} msg.conversationType - 会话类型 (1=私聊, 3=群聊)
 * @returns {string} 回复内容
 */
const { OpenClawClient } = require('../rongcloud/openclaw-client');

const openclawClient = new OpenClawClient(console);

async function handleNormalMessage(msg) {
  console.log(`[NormalMessageHandler] 收到普通消息:`, {
    from: msg.senderUserId,
    content: msg.content?.substring(0, 50),
    type: msg.conversationType === 1 ? '私聊' : '群聊'
  });

  try {
    const content = msg.content;
    if (!content || !content.trim()) {
      return '消息内容为空';
    }

    const reply = await openclawClient.chat(content, msg.senderUserId);
    console.log(`[NormalMessageHandler] AI 回复: ${reply.substring(0, 50)}...`);
    return reply;
  } catch (err) {
    console.error(`[NormalMessageHandler] 处理异常:`, err.message);
    return `抱歉，处理消息时出错: ${err.message}`;
  }
}

module.exports = {
  handleNormalMessage
};
