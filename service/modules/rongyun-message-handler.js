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
const { ServiceManager } = require('./service-manager');
const { collectDashboardData } = require('./dashboard-collector');
const { getOpenClawStatus } = require('./port-checker');
const { getMacAddress } = require('./mac-address');
const fs = require('fs');
const path = require('path');
const os = require('os');

class RongyunMessageHandler {
  constructor(rongcloudClient, config, log) {
    this.rongcloudClient = rongcloudClient;
    this.config = config;
    this.log = log;
    this.commandLock = false;
    this.commandLockTimer = null;
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
        case RongyunMessageTypeEnum.DEVICE_CONTROL:
          await this.handleDeviceControl(parsed);
          break;
        case RongyunMessageTypeEnum.DEVICE_STATUS_REQUEST:
          await this.handleDeviceStatusRequest(parsed);
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
    const sourceId = data.source_im_id;

    this.logInfo(`[RongyunMessageHandler] 收到命令: command=${command}, command_id=${commandId}, from=${sourceId || 'guardserver'}`);

    // 验证命令是否有效
    const validCommands = Object.values(OpenClawCommandEnum);
    if (!validCommands.includes(command)) {
      await this.sendResponse(RongyunMessageTypeEnum.COMMAND_RESULT, {
        command,
        command_id: commandId,
        status: 'error',
        message: `未知命令: ${command}`
      }, requestId, sourceId);
      return;
    }

    // 检查命令锁
    if (this.commandLock) {
      await this.sendResponse(RongyunMessageTypeEnum.COMMAND_RESULT, {
        command,
        command_id: commandId,
        status: 'busy',
        message: '正在执行上一个指令，请稍后再试'
      }, requestId, sourceId);
      return;
    }

    this.commandLock = true;
    // 设置 60 秒超时保护，防止命令永久卡住导致锁无法释放
    this.commandLockTimer = setTimeout(() => {
      this.logWarn('[RongyunMessageHandler] 命令锁超时（60秒），自动释放');
      this.commandLock = false;
      this.commandLockTimer = null;
    }, 60000);

    try {
      await executeCommand(command, null, async (response) => {
        // 增加短暂延迟，避免融云 SDK 在收到消息后立刻回复时消息丢失
        await new Promise(resolve => setTimeout(resolve, 500));
        await this.sendResponse(RongyunMessageTypeEnum.COMMAND_RESULT, {
          ...response,
          command_id: commandId
        }, requestId, sourceId);
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logError(`命令执行异常: ${msg}`);
      await this.sendResponse(RongyunMessageTypeEnum.COMMAND_RESULT, {
        command,
        command_id: commandId,
        status: 'error',
        message: msg
      }, requestId, sourceId);
    } finally {
      this.commandLock = false;
      if (this.commandLockTimer) {
        clearTimeout(this.commandLockTimer);
        this.commandLockTimer = null;
      }
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

  async handleDeviceControl(data) {
    const command = data.command;
    const requestId = data.request_id;
    const targetId = data.source_im_id;

    this.logInfo(`[RongyunMessageHandler] 收到设备控制命令: command=${command}, from=${targetId}`);

    const validCommands = ['disable', 'enable', 'delete', 'status'];
    if (!validCommands.includes(command)) {
      await this.sendDeviceControlResult(targetId, requestId, command, 'error', `未知命令: ${command}`);
      return;
    }

    try {
      let result;
      switch (command) {
        case 'disable': {
          const svcMgr = new ServiceManager('claw-subagent-service', 'OpenClaw Guard CLI Client', process.argv[1], this.log);
          await svcMgr.stop();
          await svcMgr.uninstall();
          result = { status: 'success', message: '设备服务已禁用' };
          break;
        }
        case 'enable': {
          const svcMgr = new ServiceManager('claw-subagent-service', 'OpenClaw Guard CLI Client', process.argv[1], this.log);
          await svcMgr.install();
          result = { status: 'success', message: '设备服务已启用' };
          break;
        }
        case 'delete': {
          const svcMgr = new ServiceManager('claw-subagent-service', 'OpenClaw Guard CLI Client', process.argv[1], this.log);
          try { await svcMgr.stop(); } catch (e) {}
          try { await svcMgr.uninstall(); } catch (e) {}
          const homeDir = os.homedir();
          const configPaths = [
            path.join(homeDir, '.claw-bridge', 'config.json'),
            path.join(__dirname, '..', '..', 'rongcloud-config.json')
          ];
          for (const p of configPaths) {
            if (fs.existsSync(p)) {
              fs.unlinkSync(p);
            }
          }
          result = { status: 'success', message: '设备已删除，本地配置已清除' };
          break;
        }
        case 'status': {
          const dashboard = await collectDashboardData();
          result = { status: 'success', message: '状态查询成功', data: dashboard };
          break;
        }
      }

      await this.sendDeviceControlResult(targetId, requestId, command, result.status, result.message, result.data);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logError(`设备控制命令执行异常: ${msg}`);
      await this.sendDeviceControlResult(targetId, requestId, command, 'error', msg);
    }
  }

  async handleDeviceStatusRequest(data) {
    const requestId = data.request_id;
    const targetId = data.source_im_id;

    this.logInfo(`[RongyunMessageHandler] 收到设备状态请求, from=${targetId}, requestId=${requestId}`);

    try {
      // 获取 OpenClaw 运行状态（检查端口 18789）
      const openClawStatus = await getOpenClawStatus();
      
      // 构建状态数据
      // openClawStatus: 1=端口监听正常(服务可用), 0=未运行(端口未监听)
      const statusMessage = openClawStatus === 1 ? '运行中' : '未运行';
      
      const statusData = {
        open_claw_status: openClawStatus,  // 1=运行中, 0=未运行
        status_message: statusMessage,
        mac_address: getMacAddress(),
        version: '0.0.20',
        timestamp: Date.now(),
      };
      
      this.logInfo(`[RongyunMessageHandler] 设备状态: openClawStatus=${openClawStatus}`);
      await this.sendDeviceStatusReport(targetId, requestId, statusData);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logError(`设备状态查询异常: ${msg}`);
      await this.sendDeviceStatusReport(targetId, requestId, null, msg);
    }
  }

  async sendDeviceControlResult(targetId, requestId, command, status, message, data) {
    if (!this.messageSender) {
      this.logError('MessageSender 未设置，无法发送响应');
      return;
    }
    try {
      await this.messageSender.sendDeviceControlResult(targetId, requestId, command, status, message, data);
      this.logInfo(`设备控制结果已发送: ${command} -> ${targetId}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logError(`发送设备控制结果失败: ${msg}`);
    }
  }

  async sendDeviceStatusReport(targetId, requestId, data, error) {
    if (!this.messageSender) {
      this.logError('MessageSender 未设置，无法发送响应');
      return;
    }
    try {
      await this.messageSender.sendDeviceStatusReport(targetId, requestId, data, error);
      this.logInfo(`设备状态报告已发送 -> ${targetId}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logError(`发送设备状态报告失败: ${msg}`);
    }
  }

  async sendResponse(msgType, content, requestId, targetId) {
    if (!this.messageSender) {
      this.logError('MessageSender 未设置，无法发送响应');
      return;
    }

    try {
      if (targetId) {
        await this.messageSender.sendToTarget(targetId, msgType, content, requestId);
        this.logInfo(`响应已发送: ${msgType} -> ${targetId}`);
      } else {
        await this.messageSender.sendProtocolMessage(msgType, content, requestId);
        this.logInfo(`响应已发送: ${msgType}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logError(`发送响应失败: ${msg}`);
    }
  }
}

module.exports = {
  RongyunMessageHandler
};