/**
 * 完整消息处理示例 - 展示如何接收 rongcloud 转发的消息
 */

const { MessageProcessor } = require('./modules/message-processor');

// ========== 使用示例 ==========

// 1. 创建消息处理器
const messageProcessor = new MessageProcessor(config, rongcloudClient, log);

// 2. 连接融云，传入处理器
// rongcloud-client.js 第42-43行会保存这个 handler
// rongcloud-client.js 第161-164行会调用 handler.handleMessage(msg)
await rongcloudClient.connect(messageProcessor);

// ========== 消息接收流程 ==========

/**
 * 消息接收流程：
 * 
 * 1. 融云SDK收到消息
 *    ↓
 * 2. rongcloud-client.js 的 handleReceivedMessage() 被调用
 *    位置：rongcloud-client.js 第115行
 *    ↓
 * 3. 检查是否是结构化消息（有 msg_type 字段）
 *    位置：rongcloud-client.js 第131-138行
 *    - 如果是结构化消息且 msg_type 在 SYSTEM_MSG_TYPES 中 → 直接 return，不转发
 *    - 如果是普通消息 → 继续处理
 *    ↓
 * 4. 构建 rongCloudMsg 对象
 *    位置：rongcloud-client.js 第150-159行
 *    ↓
 * 5. 调用 handler.handleMessage(rongCloudMsg)
 *    位置：rongcloud-client.js 第163行
 *    ↓
 * 6. MessageProcessor.handleMessage(msg) 被调用
 *    位置：modules/message-processor.js
 */

// ========== handleMessage 方法签名 ==========

/**
 * handleMessage(msg) 接收的消息格式：
 * 
 * @param {Object} msg
 * @param {string} msg.senderUserId - 发送者用户ID
 * @param {string} msg.targetId - 目标用户ID（群聊时为群ID）
 * @param {number} msg.conversationType - 会话类型：1=私聊，3=群聊
 * @param {string} msg.content - 消息文本内容
 * @param {string} msg.messageType - 融云消息类型，如 'RC:TxtMsg'
 * @param {boolean} msg.isOffLineMessage - 是否为离线消息
 * @param {string} msg.messageUId - 消息唯一ID
 * @param {number} msg.sentTime - 消息发送时间戳
 */

// ========== 示例：自定义消息处理 ==========

class CustomMessageProcessor extends MessageProcessor {
  async handleNormalMessage(msg) {
    // 自定义处理逻辑
    this.log?.info(`[CustomMessageProcessor] 收到消息: ${msg.content}`);
    
    // 例如：简单的 echo 回复
    await this.sendReply(msg, `收到: ${msg.content}`);
  }
}

// 使用自定义处理器
const customProcessor = new CustomMessageProcessor(config, rongcloudClient, log);
await rongcloudClient.connect(customProcessor);
