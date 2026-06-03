/**
 * 消息业务处理器 - 处理 rongcloud 转发过来的消息
 * 
 * 被调用位置：rongcloud/message-handler.js
 * - handleNormal() 第68行：处理普通消息（AI聊天）
 * - handleCommand() 第70行：处理命令消息（以/开头）
 * 
 * 注入方式：通过 config.onCommand 回调
 * 位置：rongcloud/message-handler.js 第93行
 */
const { CommandHandler, OpenClawCommandEnum } = require('./command-handler');
const { RongyunMessageSender } = require('./rongyun-message-sender');

class BusinessMessageHandler {
  constructor(config, rongcloudClient, log) {
    this.config = config;
    this.rongcloudClient = rongcloudClient;
    this.log = log;
    this.commandHandler = new CommandHandler(config, log);
    this.messageSender = new RongyunMessageSender(rongcloudClient, config, log);
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
      // 将命令名称或枚举值映射到枚举值
      // 后端可能发送字符串（如 "start"）或整数（如 1）
      const commandMap = {
        'start': OpenClawCommandEnum.START,
        'stop': OpenClawCommandEnum.STOP,
        'status': OpenClawCommandEnum.STATUS,
        'restart': OpenClawCommandEnum.RESTART,
        1: OpenClawCommandEnum.START,
        2: OpenClawCommandEnum.STOP,
        3: OpenClawCommandEnum.RESTART,
        4: OpenClawCommandEnum.STATUS
      };
      
      // 支持字符串和整数命令
      const commandKey = typeof payload.command === 'string' 
        ? payload.command.toLowerCase() 
        : payload.command;
      
      const command = commandMap[commandKey];
      if (!command) {
        return `未知命令: ${payload.command}\n可用命令: start, stop, status, restart`;
      }
      
      // 执行命令
      const result = await this.commandHandler.execute(command);
      
      // 发送命令结果到服务端
      try {
        await this.messageSender.sendCommandResult(
          command,
          payload.senderId,
          result.status,
          result.message
        );
      } catch (err) {
        this.log?.error(`[BusinessMessageHandler] 发送命令结果失败: ${err.message}`);
      }
      
      return result.message;
      
    } catch (err) {
      this.log?.error(`[BusinessMessageHandler] 命令处理异常: ${err.message}`);
      return `执行失败: ${err.message}`;
    }
  }

  /**
   * 处理普通消息（AI聊天）
   * 被调用位置：rongcloud/message-handler.js 第68行
   * 
   * @param {Object} msg - 消息对象
   * @param {string} msg.content - 消息内容
   * @param {string} msg.senderUserId - 发送者ID
   * @returns {string} 回复内容
   */
  async handleNormalMessage(msg) {
    this.log?.info(`[BusinessMessageHandler] 收到普通消息 from=${msg.senderUserId}: ${msg.content?.substring(0, 50)}`);
    
    try {
      // TODO: 调用 AI 服务进行回复
      // 这里可以调用 opencode 服务或其他 AI 服务
      
      const reply = `收到您的消息: ${msg.content}`;
      
      // 发送聊天消息回复到服务端
      try {
        await this.messageSender.sendChatMessage(reply);
      } catch (err) {
        this.log?.error(`[BusinessMessageHandler] 发送聊天回复失败: ${err.message}`);
      }
      
      return reply;
      
    } catch (err) {
      this.log?.error(`[BusinessMessageHandler] 处理普通消息异常: ${err.message}`);
      return `抱歉，处理消息时出错: ${err.message}`;
    }
  }
}

module.exports = { BusinessMessageHandler };
