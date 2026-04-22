/**
 * 消息业务处理器 - 处理 rongcloud 转发过来的消息
 * 
 * 被调用位置：rongcloud/message-handler.js
 * - handleNormal() 第108行：处理普通消息（AI聊天）
 * - handleCommand() 第88行：处理命令消息（以/开头）
 * 
 * 注入方式：通过 config.onCommand 回调
 * 位置：rongcloud/message-handler.js 第93行
 */
class BusinessMessageHandler {
  constructor(config, rongcloudClient, log) {
    this.config = config;
    this.rongcloudClient = rongcloudClient;
    this.log = log;
  }

  /**
   * 处理命令消息
   * 被调用位置：rongcloud/message-handler.js 第93行
   * 
   * @param {Object} payload - 命令对象
   * @param {string} payload.command - 命令名称
   * @param {string[]} payload.args - 命令参数
   * @param {string} payload.rawMessage - 原始消息
   * @param {string} payload.senderId - 发送者ID
   * @returns {string} 回复内容
   */
  async handleCommand(payload) {
    this.log?.info(`[BusinessMessageHandler] 收到命令: ${payload.command}, args=${JSON.stringify(payload.args)}`);
    
    try {
      switch (payload.command) {
        case 'start':
          return await this.handleStartCommand(payload);
        case 'stop':
          return await this.handleStopCommand(payload);
        case 'status':
          return await this.handleStatusCommand(payload);
        case 'restart':
          return await this.handleRestartCommand(payload);
        default:
          return `未知命令: ${payload.command}`;
      }
    } catch (err) {
      this.log?.error(`[BusinessMessageHandler] 命令处理异常: ${err.message}`);
      return `执行失败: ${err.message}`;
    }
  }

  /**
   * 接收普通消息（非命令消息）
   * 被调用位置：rongcloud/message-handler.js 第108行 handleNormal() 方法
   * 
   * 调用链：
   * 1. rongcloud-client.js 第163行 → handler.handleMessage(msg)
   * 2. rongcloud/message-handler.js 第56行 → handleMessage()
   * 3. rongcloud/message-handler.js 第66行 → handleNormal(msg)
   * 4. rongcloud/message-handler.js 第109行 → this.openclawClient.chat()
   * 5. 通过 Monkey Patch 转发到本方法
   * 
   * @param {string} message - 消息内容
   * @param {string} fromUser - 发送者用户ID
   * @returns {string} 回复内容
   */
  async onNormalMessage(message, fromUser) {
    this.log?.info(`[BusinessMessageHandler] 收到普通消息 from=${fromUser}: ${message?.substring(0, 50)}`);
    
    try {
      // TODO: 在这里实现普通消息处理逻辑
      // 例如：
      // - AI 聊天回复
      // - 调用 opencode 服务
      // - 查询知识库
      // - 其他业务逻辑
      
      // 示例：简单回复
      return `收到您的消息: ${message}`;
      
    } catch (err) {
      this.log?.error(`[BusinessMessageHandler] 处理普通消息异常: ${err.message}`);
      return `抱歉，处理消息时出错: ${err.message}`;
    }
  }

  // 处理启动命令
  async handleStartCommand(payload) {
    this.log?.info('[BusinessMessageHandler] 执行启动命令');
    // TODO: 实现启动逻辑
    return '启动命令已执行';
  }

  // 处理停止命令
  async handleStopCommand(payload) {
    this.log?.info('[BusinessMessageHandler] 执行停止命令');
    // TODO: 实现停止逻辑
    return '停止命令已执行';
  }

  // 处理状态命令
  async handleStatusCommand(payload) {
    this.log?.info('[BusinessMessageHandler] 执行状态命令');
    // TODO: 实现状态查询逻辑
    return '状态查询结果';
  }

  // 处理重启命令
  async handleRestartCommand(payload) {
    this.log?.info('[BusinessMessageHandler] 执行重启命令');
    // TODO: 实现重启逻辑
    return '重启命令已执行';
  }
}

module.exports = { BusinessMessageHandler };
