/**
 * 融云消息处理器 - 与桌面客户端对齐
 * 
 * 处理服务端发送的所有结构化消息类型：
 * - COMMAND: 执行 start/stop/restart/status 命令
 * - CHAT_MESSAGE: 转发消息到 OpenClaw AI 服务
 * - CREATE_OPENCODE_SESSION: 创建新会话
 * - DELETE_OPENCODE_SESSION: 删除会话
 */
const { RongyunMessageTypeEnum } = require('./rongyun-message-types');
const { OpenClawCommandEnum } = require('./openclaw-enum');
const { executeCommand } = require('./openclaw-control');
const { createOpencodeSession, deleteOpencodeSession, forwardChatMessage } = require('./opencode-service');

class RongyunMessageHandler {
  constructor(rongcloudClient, config, log) {
    this.rongcloudClient = rongcloudClient;
    this.config = config;
    this.log = log;
    this.commandLock = false;
    this.messageSender = null;
  }

  setMessageSender(messageSender) {
    this.messageSender = messageSender;
  }

  logInfo(message) {
    if (this.log?.info) {
      this.log.info(message);
    } else {
      console.log(`[INFO] ${message}`);
    }
  }

  logWarn(message) {
    if (this.log?.warn) {
      this.log.warn(message);
    } else {
      console.log(`[WARN] ${message}`);
    }
  }

  logError(message) {
    if (this.log?.error) {
      this.log.error(message);
    } else {
      console.error(`[ERROR] ${message}`);
    }
  }

  async handle(parsed) {
    try {
      if (!parsed || typeof parsed !== 'object') {
        this.logWarn('Invalid message format');
        return;
      }

      const msgType = parsed.msg_type;
      this.logInfo(`[RongyunMessageHandler] 处理消息类型: ${msgType}`);

      switch (msgType) {
        case RongyunMessageTypeEnum.COMMAND:
          await this.handleCommand(parsed);
          break;
        case RongyunMessageTypeEnum.CHAT_MESSAGE:
          await this.handleChatMessage(parsed);
          break;
        case RongyunMessageTypeEnum.CREATE_OPENCODE_SESSION:
          await this.handleCreateSession(parsed);
          break;
        case RongyunMessageTypeEnum.DELETE_OPENCODE_SESSION:
          await this.handleDeleteSession(parsed);
          break;
        default:
          this.logWarn(`未处理的消息类型: ${msgType}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logError(`消息处理异常: ${msg}`);
    }
  }

  async handleCommand(data) {
    const command = data.command;
    const commandId = data.command_id;
    const requestId = data.request_id;

    this.logInfo(`[RongyunMessageHandler] 收到命令: command=${command}, command_id=${commandId}`);

    // 验证命令是否有效
    const validCommands = Object.values(OpenClawCommandEnum);
    if (!validCommands.includes(command)) {
      await this.sendResponse(RongyunMessageTypeEnum.COMMAND_RESULT, {
        command,
        command_id: commandId,
        status: 'error',
        message: `未知命令: ${command}`
      }, requestId);
      return;
    }

    // 检查命令锁
    if (this.commandLock) {
      await this.sendResponse(RongyunMessageTypeEnum.COMMAND_RESULT, {
        command,
        command_id: commandId,
        status: 'busy',
        message: '正在执行上一个指令，请稍后再试'
      }, requestId);
      return;
    }

    this.commandLock = true;
    try {
      await executeCommand(command, null, async (response) => {
        // 增加短暂延迟，避免融云 SDK 在收到消息后立刻回复时消息丢失
        await new Promise(resolve => setTimeout(resolve, 500));
        await this.sendResponse(RongyunMessageTypeEnum.COMMAND_RESULT, {
          ...response,
          command_id: commandId
        }, requestId);
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logError(`命令执行异常: ${msg}`);
      await this.sendResponse(RongyunMessageTypeEnum.COMMAND_RESULT, {
        command,
        command_id: commandId,
        status: 'error',
        message: msg
      }, requestId);
    } finally {
      this.commandLock = false;
    }
  }

  async handleChatMessage(data) {
    const roomId = data.room_id;
    const sessionId = data.gateway_session_id || data.session_id;
    const content = data.content;
    const requestId = data.request_id;

    this.logInfo(`[RongyunMessageHandler] 收到聊天消息, roomId=${roomId}, sessionId=${sessionId}`);

    if (!roomId || !sessionId || !content) {
      await this.sendResponse(RongyunMessageTypeEnum.CHAT_MESSAGE, {
        status: 'error',
        message: '缺少必要参数',
        content: '[错误] 缺少必要参数',
        metadata: {}
      }, requestId);
      return;
    }

    let fullResponse = '';
    const chatTimeoutMs = (this.config.chatTimeout || 600) * 1000;

    try {
      await forwardChatMessage(sessionId, content, async (delta) => {
        fullResponse += delta;
      }, (level, message) => {
        if (level === 'ERROR') {
          this.logError(`[CHAT-API] ${message}`);
        } else if (level === 'WARN') {
          this.logWarn(`[CHAT-API] ${message}`);
        } else {
          this.logInfo(`[CHAT-API] ${message}`);
        }
      }, chatTimeoutMs);

      await this.sendResponse(RongyunMessageTypeEnum.CHAT_MESSAGE, {
        status: 'success',
        message: 'Response received',
        content: fullResponse,
        metadata: {}
      }, requestId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logError(`聊天消息处理异常: ${msg}`);
      await this.sendResponse(RongyunMessageTypeEnum.CHAT_MESSAGE, {
        status: 'error',
        message: msg,
        content: `[错误] 转发失败: ${msg}`,
        metadata: {}
      }, requestId);
    }
  }

  async handleCreateSession(data) {
    const requestId = data.request_id;
    const title = data.title || '新会话';

    this.logInfo(`[RongyunMessageHandler] 创建会话, title=${title}`);

    try {
      const session = await createOpencodeSession(title);
      this.logInfo(`会话创建成功: ${session.id}`);
      await this.sendResponse(RongyunMessageTypeEnum.OPENCODE_SESSION_CREATED, {
        status: 'success',
        opencode_session_id: session.id
      }, requestId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logError(`创建会话失败: ${msg}`);
      await this.sendResponse(RongyunMessageTypeEnum.OPENCODE_SESSION_CREATED, {
        status: 'error',
        message: msg
      }, requestId);
    }
  }

  async handleDeleteSession(data) {
    const sessionId = data.opencode_session_id;

    this.logInfo(`[RongyunMessageHandler] 删除会话, sessionId=${sessionId}`);

    if (!sessionId) {
      this.logError('删除会话失败: 缺少 opencode_session_id');
      return;
    }

    try {
      await deleteOpencodeSession(sessionId);
      this.logInfo(`会话删除成功: ${sessionId}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logError(`删除会话失败: ${msg}`);
    }
  }

  async sendResponse(msgType, content, requestId) {
    if (!this.messageSender) {
      this.logError('MessageSender 未设置，无法发送响应');
      return;
    }

    try {
      await this.messageSender.sendProtocolMessage(msgType, content, requestId);
      this.logInfo(`响应已发送: ${msgType}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logError(`发送响应失败: ${msg}`);
    }
  }
}

module.exports = {
  RongyunMessageHandler
};