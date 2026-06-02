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
const { OpenClawCommandEnum, getCommandName } = require('./openclaw-enum');
const { executeCommand } = require('./openclaw-control');
const { createOpencodeSession, deleteOpencodeSession, forwardChatMessage, getOrCreateGatewaySession } = require('./opencode-service');
const { ServiceManager } = require('./service-manager');
const { collectDashboardData } = require('./dashboard-collector');
const { getOpenClawStatus } = require('./port-checker');
const { getMacAddress } = require('./mac-address');
const fs = require('fs');
const path = require('path');
const os = require('os');

// 客服会话存储（内存缓存，生产环境建议用 Redis）
const serviceSessions = new Map();

// 客服系统提示词 - OpenClaw 运维助手智能体
const SERVICE_SYSTEM_PROMPT = `你是 虾说智能助手的 openclaw 运维助手智能体，职责有：保活、修配置、做备份 等运维工作。

## 核心职责
1. **保活**：openclaw 挂了自动拉起来
2. **修配置**：配置报错时自动修复，修不好就回滚备份
3. **做备份**：改配置前自动备份到 config.json.bak.时间戳

## 常用运维指令

| 命令 | 功能 | 容器内可用 |
|------|------|-----------|
| \`openclaw doctor\` | 诊断并自动修复问题 | ✅ |
| \`openclaw doctor --fix\` | 强制修复配置错误 | ✅ |
| \`openclaw status\` | 查看整体运行状态 | ✅ |
| \`openclaw models list\` | 查看可用模型 | ✅ |
| \`openclaw channels status\` | 查看通讯平台连接状态 | ✅ |
| \`openclaw logs --follow\` | 实时查看运行日志 | ✅ |
| \`openclaw gateway\` | **前台启动 Gateway**（端口 18789） | ✅ 推荐 |
| \`openclaw gateway --port 18789 --host 0.0.0.0 --verbose\` | 指定参数前台启动 | ✅ |
| \`openclaw onboard\` | 首次配置向导（交互式） | ✅ |

## Docker容器内不可用（需要 systemd）

| 命令 | 容器内替代方案 |
|------|---------|
| \`openclaw gateway start\` | 改用 \`openclaw gateway\` 前台运行 |
| \`openclaw gateway restart\` | 先 \`pkill -f "openclaw gateway"\` 再重新启动 |
| \`openclaw onboard --install-daemon\` | 改用 \`nohup openclaw gateway &\` 后台运行 |
| \`systemctl --user start openclaw-gateway.service\` | 容器无 systemd，用 \`nohup\` |

## 后台运行方案（容器内）nohup 后台运行
nohup openclaw gateway --port 18789 --host 0.0.0.0 --verbose > /var/log/openclaw.log 2>&1 &

## 修不好的时候，查资料顺序
1. \`openclaw --help\` 先看本地帮助
2. https://docs.openclaw.ai 官方文档
3. https://github.com/openclaw/openclaw/issues GitHub 搜报错关键词

## 铁律
- 改配置必须先备份
- 执行命令后汇报结果，别沉默
- 不知道就查资料，别瞎猜
- 看到 \`systemctl\` 相关报错，立即切换为 \`nohup\` 方案, 因为docker容器内是没有systemctl的。
- 超过6分钟 没有修复好就停下来，报告你遇到的问题，不要无限循环的进行修复。
- 不要对外透漏你是什么模型，不要说你是opencode，对外你就说你是 虾说智能助手；
`;

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

      // 解析 content 字段（前端将业务数据放在 content 内）
      let data = parsed;
      if (parsed.content && typeof parsed.content === 'string') {
        // 聊天消息的内容是纯文本，不需要解析为 JSON
        const isChatMessage = parsed.msg_type === RongyunMessageTypeEnum.CHAT_MESSAGE ||
                              parsed.msg_type === RongyunMessageTypeEnum.SERVICE_CHAT_MESSAGE;
        
        if (!isChatMessage) {
          try {
            const contentData = JSON.parse(parsed.content);
            // 将 content 内的数据合并到顶层，方便处理器直接访问
            // 保留原始 content 字段（用于聊天消息等场景）
            data = { ...parsed, ...contentData, _raw_content: parsed.content };
          } catch (e) {
            this.logWarn(`解析 content 失败: ${e.message}`);
          }
        }
      }

      const msgType = data.msg_type;
      this.logInfo(`[RongyunMessageHandler] 处理消息类型: ${msgType}`);

      switch (msgType) {
        case RongyunMessageTypeEnum.COMMAND:
          await this.handleCommand(data);
          break;
        case RongyunMessageTypeEnum.CHAT_MESSAGE:
          await this.handleChatMessage(data);
          break;
        case RongyunMessageTypeEnum.CREATE_OPENCODE_SESSION:
          await this.handleCreateSession(data);
          break;
        case RongyunMessageTypeEnum.DELETE_OPENCODE_SESSION:
          await this.handleDeleteSession(data);
          break;
        case RongyunMessageTypeEnum.DEVICE_CONTROL:
          await this.handleDeviceControl(data);
          break;
        case RongyunMessageTypeEnum.DEVICE_STATUS_REQUEST:
          await this.handleDeviceStatusRequest(data);
          break;
        case RongyunMessageTypeEnum.CREATE_SERVICE_SESSION:
          await this.handleCreateServiceSession(data);
          break;
        case RongyunMessageTypeEnum.SERVICE_CHAT_MESSAGE:
          await this.handleServiceChatMessage(data);
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
    const command = Number(data.command);  // 确保是数字类型
    const commandId = data.command_id;
    const requestId = data.request_id;
    const sourceId = data.source_im_id;
    const force = data.force === true;  // 是否强制停止

    this.logInfo(`[RongyunMessageHandler] 收到命令: command=${command}, command_id=${commandId}, force=${force}, from=${sourceId || 'guardserver'}`);

    // 验证命令是否有效
    const validCommands = Object.values(OpenClawCommandEnum);
    if (!validCommands.includes(command)) {
      this.logError(`[RongyunMessageHandler] 未知命令: ${command}, 有效命令: ${validCommands.join(', ')}`);
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
    // 设置 120 秒超时保护，防止命令永久卡住导致锁无法释放
    // 启动命令可能需要较长时间（等待服务启动）
    this.commandLockTimer = setTimeout(() => {
      this.logWarn('[RongyunMessageHandler] 命令锁超时（120秒），自动释放');
      this.commandLock = false;
      this.commandLockTimer = null;
    }, 120000);

    try {
      // 先发送响应，再执行命令（避免前端超时）
      // 启动/停止/重启命令是异步的，前端只需要知道命令已接收
      const isAsyncCommand = [OpenClawCommandEnum.START, OpenClawCommandEnum.STOP, OpenClawCommandEnum.RESTART].includes(command);

      if (isAsyncCommand) {
        // 立即响应，告知前端命令已接收
        const actionName = force ? '强制' + getCommandName(command) : getCommandName(command);
        await this.sendResponse(RongyunMessageTypeEnum.COMMAND_RESULT, {
          command,
          command_id: commandId,
          status: 'success',
          message: `${actionName}命令已接收，正在执行...`
        }, requestId, sourceId);
      }

      // 执行命令（在后台异步执行，不阻塞响应）
      // 使用 Promise 避免阻塞，让命令在后台执行
      executeCommand(command, null, async (response) => {
        if (!isAsyncCommand) {
          // 同步命令立即响应
          await this.sendResponse(RongyunMessageTypeEnum.COMMAND_RESULT, {
            ...response,
            command_id: commandId
          }, requestId, sourceId);
        }
        // 异步命令不在这里响应，因为已经提前响应了
        // 但我们可以在这里记录执行结果
        this.logInfo(`[RongyunMessageHandler] 命令执行完成: command=${command}, force=${force}, status=${response.status}, message=${response.message}`);
      }, force).then(() => {
        // 命令执行完成后，立即释放锁
        this.commandLock = false;
        if (this.commandLockTimer) {
          clearTimeout(this.commandLockTimer);
          this.commandLockTimer = null;
        }
      }).catch(err => {
        this.logError(`[RongyunMessageHandler] 命令执行失败: ${err.message}`);
        // 执行失败后也要释放锁
        this.commandLock = false;
        if (this.commandLockTimer) {
          clearTimeout(this.commandLockTimer);
          this.commandLockTimer = null;
        }
      });

      // 异步命令立即返回，不等待执行完成
      if (isAsyncCommand) {
        return;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logError(`命令执行异常: ${msg}`);
      await this.sendResponse(RongyunMessageTypeEnum.COMMAND_RESULT, {
        command,
        command_id: commandId,
        status: 'error',
        message: msg
      }, requestId, sourceId);
      // 同步命令执行异常时释放锁
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
    // 使用解析后的 content（聊天内容），如果没有则使用原始 content
    const content = data.content || data._raw_content;
    const requestId = data.request_id;
    const sourceId = data.source_im_id;

    this.logInfo(`[RongyunMessageHandler] 收到聊天消息, roomId=${roomId}, sessionId=${sessionId}, from=${sourceId}`);

    if (!roomId || !sessionId || !content) {
      await this.sendResponse(RongyunMessageTypeEnum.CHAT_MESSAGE, {
        status: 'error',
        message: '缺少必要参数',
        content: '[错误] 缺少必要参数',
        metadata: {}
      }, requestId, sourceId);
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
      }, requestId, sourceId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logError(`聊天消息处理异常: ${msg}`);
      await this.sendResponse(RongyunMessageTypeEnum.CHAT_MESSAGE, {
        status: 'error',
        message: msg,
        content: `[错误] 转发失败: ${msg}`,
        metadata: {}
      }, requestId, sourceId);
    }
  }

  async handleCreateSession(data) {
    const requestId = data.request_id;
    const title = data.title || '新会话';
    const sourceId = data.source_im_id;

    this.logInfo(`[RongyunMessageHandler] 创建会话, title=${title}, from=${sourceId}`);

    try {
      const session = await createOpencodeSession(title);
      this.logInfo(`会话创建成功: ${session.id}`);
      await this.sendResponse(RongyunMessageTypeEnum.OPENCODE_SESSION_CREATED, {
        status: 'success',
        opencode_session_id: session.id
      }, requestId, sourceId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logError(`创建会话失败: ${msg}`);
      await this.sendResponse(RongyunMessageTypeEnum.OPENCODE_SESSION_CREATED, {
        status: 'error',
        message: msg
      }, requestId, sourceId);
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

    const validCommands = ['disable', 'enable', 'delete', 'status', 'rename_device'];
    if (!validCommands.includes(command)) {
      await this.sendDeviceControlResult(targetId, requestId, command, 'error', `未知命令: ${command}`);
      return;
    }

    try {
      let result;
      switch (command) {
        case 'rename_device': {
          const newName = data.name || data.nickname;
          if (!newName) {
            result = { status: 'error', message: '缺少新名称参数' };
            break;
          }
          
          // 更新本地配置文件
          try {
            const homeDir = os.homedir();
            const configPaths = [
              path.join(homeDir, '.claw-bridge', 'config.json'),
              path.join(__dirname, '..', '..', 'rongcloud-config.json')
            ];
            
            for (const configPath of configPaths) {
              if (fs.existsSync(configPath)) {
                const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                config.nodeName = newName;
                fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
                this.logInfo(`[RongyunMessageHandler] 已更新本地配置名称: ${configPath} -> ${newName}`);
              }
            }
            
            // 更新内存中的配置
            if (this.config) {
              this.config.nodeName = newName;
            }
            
            result = { status: 'success', message: `设备名称已更新为: ${newName}` };
          } catch (err) {
            this.logError(`[RongyunMessageHandler] 更新本地配置失败: ${err.message}`);
            result = { status: 'error', message: `更新本地配置失败: ${err.message}` };
          }
          break;
        }
        case 'disable': {
          // 先发送响应，再停止服务
          result = { status: 'success', message: '设备服务已禁用' };
          await this.sendDeviceControlResult(targetId, requestId, command, result.status, result.message, result.data);

          setTimeout(async () => {
            const svcMgr = new ServiceManager('claw-subagent-service', 'OpenClaw Guard CLI Client', process.argv[1], this.log);
            try { await svcMgr.stop(); } catch (e) { }
            try { await svcMgr.uninstall(); } catch (e) { }
          }, 2000);

          return;
        }
        case 'enable': {
          const svcMgr = new ServiceManager('claw-subagent-service', 'OpenClaw Guard CLI Client', process.argv[1], this.log);
          await svcMgr.install();
          result = { status: 'success', message: '设备服务已启用' };
          break;
        }
        case 'delete': {
          // 先发送响应，再停止服务（否则服务停止后无法发送响应）
          result = { status: 'success', message: '设备已删除，本地配置已清除' };
          await this.sendDeviceControlResult(targetId, requestId, command, result.status, result.message, result.data);

          // 延迟执行实际的删除操作
          setTimeout(async () => {
            const svcMgr = new ServiceManager('claw-subagent-service', 'OpenClaw Guard CLI Client', process.argv[1], this.log);
            try { await svcMgr.stop(); } catch (e) { }
            try { await svcMgr.uninstall(); } catch (e) { }
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
          }, 2000);

          return; // 已经发送了响应，直接返回
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
      // 获取 OpenClaw 真实运行状态（检查端口 18789）
      const openClawStatus = await getOpenClawStatus();

      // 获取真实的版本信息（如果可能）
      let version = 'unknown';
      try {
        const { execSync } = require('child_process');
        const versionOutput = execSync('openclaw --version', { encoding: 'utf8', timeout: 5000 }).trim();
        const match = versionOutput.match(/(\d+\.\d+\.\d+)/);
        if (match) {
          version = match[1];
        }
      } catch (e) {
        // 忽略版本获取失败
      }

      // 构建真实状态数据
      // openClawStatus: 1=端口监听正常(服务可用), 0=未运行(端口未监听)
      const statusMessage = openClawStatus === 1 ? '运行中' : '未运行';

      const statusData = {
        open_claw_status: openClawStatus,  // 1=运行中, 0=未运行
        status_message: statusMessage,
        mac_address: getMacAddress(),
        version: version,
        timestamp: Date.now(),
      };

      this.logInfo(`[RongyunMessageHandler] 设备真实状态: openClawStatus=${openClawStatus}, version=${version}`);
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

  async handleCreateServiceSession(data) {
    const requestId = data.request_id;
    const userId = data.userId || data.source_im_id;
    const sourceId = data.source_im_id;

    this.logInfo(`[RongyunMessageHandler] 创建客服会话, userId=${userId}, from=${sourceId}`);

    try {
      // 创建 OpenCode session 用于客服对话
      const session = await createOpencodeSession(`客服会话-${userId}`);
      const sessionId = session.id || session.session_id;

      // 存储会话映射关系
      serviceSessions.set(userId, {
        sessionId: sessionId,
        userId: userId,
        createdAt: Date.now(),
      });

      this.logInfo(`[RongyunMessageHandler] 客服会话创建成功: ${sessionId}`);

      await this.sendResponse(
        RongyunMessageTypeEnum.SERVICE_SESSION_CREATED,
        {
          status: 'success',
          sessionId: sessionId,
          userId: userId,
        },
        requestId,
        sourceId
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logError(`创建客服会话失败: ${msg}`);
      await this.sendResponse(
        RongyunMessageTypeEnum.SERVICE_SESSION_CREATED,
        {
          status: 'error',
          message: msg,
        },
        requestId,
        sourceId
      );
    }
  }

  async handleServiceChatMessage(data) {
    const requestId = data.request_id;
    const userId = data.userId || data.source_im_id;
    const sourceId = data.source_im_id;
    let content = data.content || data._raw_content;
    const voiceUrl = data.voiceUrl;
    const voiceDuration = data.voiceDuration;

    this.logInfo(`[RongyunMessageHandler] 收到客服消息, userId=${userId}, content=${content?.substring(0, 50)}, voiceUrl=${voiceUrl ? '有' : '无'}`);

    // 处理语音消息：如果有语音URL，先进行语音识别
    if (voiceUrl && (!content || content === '[语音]')) {
      try {
        this.logInfo(`[RongyunMessageHandler] 检测到语音消息，开始语音识别: ${voiceUrl}`);
        const recognizedText = await this.recognizeVoice(voiceUrl);
        if (recognizedText) {
          content = recognizedText;
          this.logInfo(`[RongyunMessageHandler] 语音识别成功: ${content.substring(0, 50)}`);
        } else {
          content = '[语音消息识别失败]';
          this.logWarn(`[RongyunMessageHandler] 语音识别失败，使用占位文本`);
        }
      } catch (e) {
        this.logError(`[RongyunMessageHandler] 语音识别异常: ${e.message}`);
        content = '[语音消息识别失败]';
      }
    }

    if (!content) {
      this.logWarn('客服消息内容为空');
      return;
    }

    try {
      // 获取或创建用户会话
      let sessionInfo = serviceSessions.get(userId);
      let sessionId;

      if (!sessionInfo) {
        // 如果没有会话，创建一个
        this.logInfo(`[RongyunMessageHandler] 用户 ${userId} 没有现有会话，创建新会话`);
        const session = await createOpencodeSession(`客服会话-${userId}`);
        sessionId = session.id || session.session_id;
        serviceSessions.set(userId, {
          sessionId: sessionId,
          userId: userId,
          createdAt: Date.now(),
        });
      } else {
        sessionId = sessionInfo.sessionId;
      }

      this.logInfo(`[RongyunMessageHandler] 使用会话: ${sessionId}`);

      // 调用 OpenCode 服务获取回复，使用运维助手提示词
      let fullResponse = '';
      await forwardChatMessage(
        sessionId,
        content,
        (delta) => {
          fullResponse += delta;
        },
        (level, message) => {
          if (level === 'ERROR') {
            this.logError(`[SERVICE-CHAT] ${message}`);
          } else {
            this.logInfo(`[SERVICE-CHAT] ${message}`);
          }
        },
        120000, // 2分钟超时
        SERVICE_SYSTEM_PROMPT // 使用运维助手提示词
      );

      this.logInfo(`[RongyunMessageHandler] 客服回复生成完成, 长度: ${fullResponse.length}`);

      // 发送客服回复给用户
      await this.sendResponse(
        RongyunMessageTypeEnum.SERVICE_CHAT_RESPONSE,
        {
          status: 'success',
          content: fullResponse,
          sessionId: sessionId,
          userId: userId,
        },
        requestId,
        sourceId
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logError(`客服消息处理异常: ${msg}`);

      // 发送错误回复
      await this.sendResponse(
        RongyunMessageTypeEnum.SERVICE_CHAT_RESPONSE,
        {
          status: 'error',
          content: '抱歉，处理您的消息时出现问题，请稍后重试。',
          userId: userId,
        },
        requestId,
        sourceId
      );
    }
  }

  /**
   * 语音识别 - 调用后端 Python 服务
   * @param {string} voiceUrl - 语音文件 URL
   * @returns {Promise<string>} 识别文本
   */
  async recognizeVoice(voiceUrl) {
    try {
      const axios = require('axios');
      
      // 从配置中获取后端 API 地址
      const apiBaseUrl = this.config.apiBaseUrl || process.env.API_BASE_URL || 'http://localhost:5000';
      const recognizeUrl = `${apiBaseUrl}/im/api/voice/recognize`;
      
      this.logInfo(`[RongyunMessageHandler] 调用语音识别 API: ${recognizeUrl}`);
      
      const response = await axios.post(recognizeUrl, {
        audioUrl: voiceUrl,
        format: 'mp3',
        sampleRate: 16000
      }, {
        timeout: 30000,
        headers: { 'Content-Type': 'application/json' }
      });
      
      if (response.data && response.data.code === 200) {
        return response.data.data.text;
      } else {
        this.logError(`[RongyunMessageHandler] 语音识别 API 返回错误: ${JSON.stringify(response.data)}`);
        return null;
      }
    } catch (e) {
      this.logError(`[RongyunMessageHandler] 语音识别请求失败: ${e.message}`);
      return null;
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