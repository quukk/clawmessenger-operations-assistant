const RongyunMessageTypeEnum = require('./message-types');
const { executeCommand } = require('../modules/script-executor');
const { createOpencodeSession, deleteOpencodeSession, forwardChatMessage } = require('../modules/opencode-service');

class MessageHandler {
  constructor(config, sendFn, log) {
    this.config = config;
    this.sendFn = sendFn;
    this.log = log;
    this.commandLock = false;
  }

  async handleMessage(msg) {
    if (msg.isOffLineMessage) {
      this.log?.info('[MessageHandler] 忽略离线消息');
      return;
    }

    if (msg.messageType !== 'RC:TxtMsg') {
      this.log?.info(`[MessageHandler] 忽略非文本消息: ${msg.messageType}`);
      return;
    }

    if (msg.senderUserId === this.config.accountId) {
      this.log?.info('[MessageHandler] 忽略自己发送的消息');
      return;
    }

    try {
      this.log?.info(`[MessageHandler] 收到消息 from=${msg.senderUserId}, content=${msg.content.substring(0, 50)}`);

      if (msg.content.startsWith('/')) {
        await this.handleCommand(msg);
      } else {
        await this.handleNormal(msg);
      }
    } catch (err) {
      this.log?.error(`[MessageHandler] 处理消息异常: ${err.message}`);
      await this.sendFn(msg.senderUserId, `处理失败: ${err.message}`, msg.conversationType);
    }
  }

  async handleStructuredMessage(msg) {
    try {
      if (!msg || typeof msg !== 'object') {
        this.log?.warn('[MessageHandler] 无效的结构化消息格式');
        return;
      }

      let parsed;
      try {
        parsed = typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content;
      } catch {
        this.log?.warn('[MessageHandler] 无法解析结构化消息内容');
        return;
      }

      if (!parsed || !parsed.msg_type) {
        this.log?.warn('[MessageHandler] 结构化消息缺少 msg_type 字段');
        return;
      }

      this.log?.info(`[MessageHandler] 收到结构化消息 type=${parsed.msg_type}, requestId=${parsed.request_id || ''}`);

      switch (parsed.msg_type) {
        case RongyunMessageTypeEnum.COMMAND:
          await this.handleStructuredCommand(parsed);
          break;
        case RongyunMessageTypeEnum.CHAT_MESSAGE:
          await this.handleStructuredChatMessage(parsed);
          break;
        case RongyunMessageTypeEnum.CREATE_OPENCODE_SESSION:
          await this.handleCreateSession(parsed);
          break;
        case RongyunMessageTypeEnum.DELETE_OPENCODE_SESSION:
          await this.handleDeleteSession(parsed);
          break;
        default:
          this.log?.warn(`[MessageHandler] 未处理的消息类型: ${parsed.msg_type}`);
      }
    } catch (err) {
      this.log?.error(`[MessageHandler] 处理结构化消息异常: ${err.message}`);
    }
  }

  async handleCommand(msg) {
    const payload = this.parseCommand(msg.content, msg.senderUserId);
    this.log?.info(`[MessageHandler] 指令消息: command=${payload.command}, args=${payload.args.join(', ')}`);

    try {
      const result = await executeCommand(payload.command, payload.args);
      await this.sendFn(msg.senderUserId, result, msg.conversationType);
    } catch (err) {
      this.log?.error(`[MessageHandler] 指令执行异常: ${err.message}`);
      await this.sendFn(msg.senderUserId, `指令执行异常: ${err.message}`, msg.conversationType);
    }
  }

  async handleNormal(msg) {
    try {
      let fullResponse = '';
      await forwardChatMessage(
        msg.senderUserId,
        msg.content,
        (delta) => {
          fullResponse += delta;
        },
        (level, message) => {
          this.log?.info(`[CHAT-API] ${level}: ${message}`);
        }
      );

      this.log?.info(`[MessageHandler] AI 回复: ${fullResponse.substring(0, 50)}...`);
      await this.sendFn(msg.senderUserId, fullResponse, msg.conversationType);
    } catch (err) {
      this.log?.error(`[MessageHandler] AI 回复异常: ${err.message}`);
      await this.sendFn(msg.senderUserId, `AI 回复异常: ${err.message}`, msg.conversationType);
    }
  }

  async handleStructuredCommand(data) {
    const command = data.command;
    const commandId = data.command_id;
    const requestId = data.request_id;

    if (this.commandLock) {
      await this.sendFn(RongyunMessageTypeEnum.COMMAND_RESULT, {
        command,
        command_id: commandId,
        status: 'busy',
        message: '正在执行上一个指令，请稍后再试'
      }, requestId);
      return;
    }

    this.commandLock = true;
    try {
      const result = await executeCommand(command);
      // 增加短暂延迟，避免融云 SDK 在收到消息后立刻回复时消息丢失
      await new Promise(resolve => setTimeout(resolve, 500));
      await this.sendFn(RongyunMessageTypeEnum.COMMAND_RESULT, {
        command,
        command_id: commandId,
        status: 'success',
        message: result
      }, requestId);
    } catch (err) {
      await this.sendFn(RongyunMessageTypeEnum.COMMAND_RESULT, {
        command,
        command_id: commandId,
        status: 'error',
        message: err.message
      }, requestId);
    } finally {
      this.commandLock = false;
    }
  }

  async handleStructuredChatMessage(data) {
    const sessionId = data.gateway_session_id || data.session_id;
    const content = data.content;
    const requestId = data.request_id;

    if (!sessionId || !content) {
      await this.sendFn(RongyunMessageTypeEnum.CHAT_MESSAGE, {
        status: 'error',
        message: '缺少必要参数',
        content: '[错误] 缺少必要参数',
        metadata: {}
      }, requestId);
      return;
    }

    let fullResponse = '';
    try {
      await forwardChatMessage(sessionId, content, async (delta) => {
        fullResponse += delta;
      }, (level, message) => {
        this.log?.info(`[CHAT-API] ${level}: ${message}`);
      });

      await this.sendFn(RongyunMessageTypeEnum.CHAT_MESSAGE, {
        status: 'success',
        message: 'Response received',
        content: fullResponse,
        metadata: {}
      }, requestId);
    } catch (err) {
      await this.sendFn(RongyunMessageTypeEnum.CHAT_MESSAGE, {
        status: 'error',
        message: err.message,
        content: `[错误] 转发失败: ${err.message}`,
        metadata: {}
      }, requestId);
    }
  }

  async handleCreateSession(data) {
    const requestId = data.request_id;
    const title = data.title || '新会话';

    try {
      const session = await createOpencodeSession(title);
      await this.sendFn(RongyunMessageTypeEnum.OPENCODE_SESSION_CREATED, {
        status: 'success',
        opencode_session_id: session.id
      }, requestId);
    } catch (err) {
      await this.sendFn(RongyunMessageTypeEnum.OPENCODE_SESSION_CREATED, {
        status: 'error',
        message: err.message
      }, requestId);
    }
  }

  async handleDeleteSession(data) {
    const sessionId = data.opencode_session_id;

    try {
      await deleteOpencodeSession(sessionId);
      this.log?.info(`[MessageHandler] 会话删除成功: ${sessionId}`);
    } catch (err) {
      this.log?.error(`[MessageHandler] 删除会话失败: ${err.message}`);
    }
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
