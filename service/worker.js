const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const axios = require('axios');
const { createLogger } = require('./logger');
const { RongCloudClient, MessageHandler, ensurePluginsAllow } = require('./rongcloud');
const { RongyunMessageHandler } = require('./modules/rongyun-message-handler');
const { RongyunMessageSender } = require('./modules/rongyun-message-sender');
const { RongCloudServerAPI } = require('./rongcloud/rongcloud-server-api');
const { SystemConfigManager } = require('./modules/system-config');
const { HeartbeatManager } = require('./modules/heartbeat-dashboard');
const { getMacAddress } = require('./modules/mac-address');
const { startOpencodeService, stopOpencodeService } = require('./modules/opencode-starter');
const { DeviceRegistration } = require('./modules/device-registration');
const { getServerUrl, getAppKey, getApiBaseUrl } = require('./config');
const { SkillLoader } = require('./skills/skill-loader');
const { SkillRouter } = require('./skills/skill-router');

const log = createLogger('worker');
const PORT = process.env.SILENT_SERVICE_PORT ? parseInt(process.env.SILENT_SERVICE_PORT, 10) : 28765;
const HOST = process.env.SILENT_SERVICE_HOST || '127.0.0.1';


// 如果 logger 初始化后，也同步写到 logger
const originalStderr = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, encoding, callback) => {
  try {
    originalStderr(chunk, encoding, callback);
  } catch (err) {
    // EPIPE 常见于子进程（如 openclaw）已退出但仍在写日志，忽略即可
    if (err.code === 'EPIPE') {
      return;
    }
    throw err;
  }
};

/**
 * 查找占用指定端口的进程 PID
 * Windows 下只处理 LISTENING 状态的本地绑定，忽略 TIME_WAIT / CLOSE_WAIT
 */
function findPidOnPort(port) {
  try {
    if (process.platform === 'win32') {
      const out = execSync(`netstat -ano | findstr ":${port}"`, {
        encoding: 'utf8', timeout: 5000, windowsHide: true,
      });
      for (const line of out.split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 5) continue;
        // netstat -ano 格式: Proto LocalAddress ForeignAddress State PID
        const localAddr = parts[1] || '';
        const state = (parts[3] || '').toUpperCase();
        // 忽略 TIME_WAIT / CLOSE_WAIT 等无活跃进程状态
        if (state === 'TIME_WAIT' || state === 'CLOSE_WAIT') continue;
        // 检查本地地址是否以目标端口结尾（避免匹配到 ForeignAddress）
        if (localAddr.endsWith(`:${port}`) || localAddr.endsWith(`]:${port}`)) {
          const pid = parseInt(parts[parts.length - 1], 10);
          if (!isNaN(pid) && pid > 0 && pid !== process.pid) return pid;
        }
      }
    } else {
      // 优先尝试 lsof，再兜底 ss / fuser / netstat（适配精简 Docker 镜像）
      const commands = [
        `lsof -i :${port} -t 2>/dev/null`,
        `fuser ${port}/tcp 2>/dev/null`,
        `ss -tlnp 2>/dev/null | grep ":${port}" | sed -n 's/.*pid=\\([0-9]*\\).*/\\1/p'`,
        `netstat -tlnp 2>/dev/null | grep ":${port}" | sed -n 's/.*\\/\\([0-9]*\\).*/\\1/p'`,
      ];
      for (const cmd of commands) {
        try {
          const out = execSync(cmd, { encoding: 'utf8', timeout: 5000 }).trim();
          const candidate = parseInt(out.split('\n')[0], 10);
          if (!isNaN(candidate) && candidate > 0 && candidate !== process.pid) return candidate;
        } catch { continue; }
      }
    }
  } catch { /* port is free */ }
  return null;
}

/**
 * 判断终止进程错误是否因为目标已不存在
 */
function isProcessAlreadyGoneError(err) {
  if (!err || !err.message) return false;
  const msg = err.message;
  return msg.includes('没有找到进程') ||
         msg.includes('not found') ||
         msg.includes('ERROR:') ||
         /process.*not found/i.test(msg);
}

/**
 * 强制终止进程
 */
function forceKill(pid) {
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /F /PID ${pid}`, { timeout: 5000, windowsHide: true });
    } else {
      process.kill(pid, 'SIGKILL');
    }
    return true;
  } catch (e) {
    // 进程已退出视为成功
    if (isProcessAlreadyGoneError(e)) return true;
    return false;
  }
}

/**
 * 确保端口未被占用：如果端口被占用，尝试杀死占用进程
 * 最多重试 3 轮，每轮间隔 1 秒
 */
function ensurePortFree(port) {
  for (let i = 0; i < 3; i++) {
    const pid = findPidOnPort(port);
    if (!pid) {
      // 端口查询工具都不可用（常见于精简 Docker 镜像）
      // 不执行 pkill 兜底，避免自杀；依赖 Daemon 的 freePortIfNeeded 清理残留 Worker
      if (i === 0) {
        log.warn(`[WORKER] 端口查询工具不可用，等待 Daemon 清理残留进程...`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
        continue;
      }
      return true;
    }
    log.warn(`[WORKER] 端口 ${port} 被进程 ${pid} 占用，正在释放...`);
    const killed = forceKill(pid);
    if (!killed) {
      log.warn(`[WORKER] 终止进程 ${pid} 失败，继续重试...`);
    }
    // 同步等待端口释放（最多 1.5s）
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
  }
  const finalPid = findPidOnPort(port);
  if (finalPid) {
    log.error(`[WORKER] 端口 ${port} 被进程 ${finalPid} 占用，无法释放`);
    return false;
  }
  return true;
}

// Timestamp 校验专用日志
const timestampLogPath = path.join(__dirname, '..', 'logs', 'timestamp-validation.log');
const logTimestampValidation = (message) => {
  const line = `[${new Date().toISOString()}] [WARN] ${message}\n`;
  try {
    fs.appendFileSync(timestampLogPath, line);
  } catch (e) {
    // 忽略写入错误
  }
  log.warn(`[TIMESTAMP-VALIDATION] ${message}`);  // 同时记录到主日志
};

log.info(`[WORKER] 业务进程启动，PID: ${process.pid}`);

// 修复：如果 worker 继承的 cwd 已失效（如 daemon 所在目录被删除），先切到临时目录
try {
  process.cwd();
} catch (e) {
  if (e.code === 'ENOENT') {
    try { process.chdir(os.tmpdir()); } catch { }
  }
}

const localConfigPath = path.join(__dirname, '..', 'rongcloud-config.json');
let rongcloudConfig = null;

/**
 * 获取实际用户主目录
 * Windows 服务以 SYSTEM 运行时 os.homedir() 返回 systemprofile，
 * 优先使用 CLAW_SERVICE_HOME / USERPROFILE 环境变量，最后扫描 C:\Users
 */
function getRealHomeDir() {
  const envHome = process.env.CLAW_SERVICE_HOME || process.env.USERPROFILE || process.env.HOME;
  if (envHome && !envHome.includes('systemprofile')) {
    return envHome;
  }
  const homeDir = os.homedir();
  if (!homeDir.includes('systemprofile')) {
    return homeDir;
  }
  // SYSTEM 账户兜底：扫描 C:\Users 找包含 .claw-bridge 的实际用户目录
  const usersDir = 'C:\\Users';
  if (fs.existsSync(usersDir)) {
    const entries = fs.readdirSync(usersDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !['Public', 'Default', 'All Users', 'Default User'].includes(entry.name)) {
        const candidate = path.join(usersDir, entry.name);
        if (fs.existsSync(path.join(candidate, '.claw-bridge', 'config.json'))) {
          return candidate;
        }
      }
    }
  }
  return homeDir;
}

const homeDir = getRealHomeDir();
const clawBridgeConfigPath = path.join(homeDir, '.claw-bridge', 'config.json');

async function loadRongCloudConfigWithAutoRegister() {
  let config = {};
  let autoRegistered = false;

  // 1. 加载 silent-subagent 自己的手动配置（~/.claw-bridge/config.json）
  try {
    if (fs.existsSync(clawBridgeConfigPath)) {
      const clawConfig = JSON.parse(fs.readFileSync(clawBridgeConfigPath, 'utf8'));
      config.token = clawConfig.token;
      config.accountId = clawConfig.nodeId;
      config.nodeName = clawConfig.nodeName;
      config.omRongcloudId = clawConfig.omRongcloudId;
      config.omToken = clawConfig.omToken;
      if (clawConfig.apiBaseUrl) config.apiBaseUrl = clawConfig.apiBaseUrl;
      if (clawConfig.appKey) config.appKey = clawConfig.appKey;
      log.info(`[WORKER] 从 claw-bridge 加载配置: nodeId=${clawConfig.nodeId}, nodeName=${clawConfig.nodeName}`);
    } else {
      log.warn(`[WORKER] 未找到 ${clawBridgeConfigPath}`);
    }
  } catch (err) {
    log.error(`[WORKER] 加载 claw-bridge 配置失败: ${err.message}`);
  }

  // 2. 检查 openclaw-clawmessenger 的节点 ID 是否与当前配置一致
  //    若 openclaw 已重新注册（nodeId 变化），必须重新获取对应运维账户
  const deviceReg = new DeviceRegistration(log);
  const openclawConfig = deviceReg.loadOpenclawConfig();
  const openclawNodeId = openclawConfig?.nodeId;
  const currentNodeId = config.accountId;
  const needReRegister = openclawNodeId && currentNodeId && openclawNodeId !== currentNodeId;

  if (needReRegister) {
    log.warn(`[WORKER] openclaw 节点 ID 变化: ${currentNodeId} -> ${openclawNodeId}，将重新获取运维账户`);
  }

  // 3. 检查手动配置是否有效且包含运维账户，不满足时按需自动注册
  const manualNotExpired = !config.expiresAt || Date.now() <= config.expiresAt;
  const hasBasicConfig = config.token && config.accountId && manualNotExpired;
  const hasOmAccount = config.omRongcloudId && config.omToken;

  if (!hasBasicConfig || !hasOmAccount || needReRegister) {
    if (!hasBasicConfig) {
      log.info('[WORKER] 手动配置缺失或已过期，尝试从 openclaw 配置获取节点并自动补齐运维账户...');
    } else if (needReRegister) {
      log.info('[WORKER] openclaw 节点 ID 已变化，重新获取运维账户...');
    } else {
      log.info('[WORKER] 手动配置缺少运维账户，尝试自动补齐...');
    }

    const registered = await deviceReg.autoRegister();
    if (registered) {
      config.token = registered.token;
      config.accountId = registered.nodeId;
      config.omRongcloudId = registered.omRongcloudId;
      config.omToken = registered.omToken;
      config.appKey = registered.appKey;
      config.nodeName = registered.nodeName || config.nodeName;
      autoRegistered = true;
      log.info(`[WORKER] 自动注册完成，nodeId=${registered.nodeId}, omRongcloudId=${registered.omRongcloudId}`);
    } else {
      log.error('[WORKER] 自动注册失败，将尝试使用已有配置');
    }
  }

  // 4. 加载本地 rongcloud-config.json（补充或覆盖，但不覆盖自动注册结果）
  try {
    if (fs.existsSync(localConfigPath)) {
      const localConfig = JSON.parse(fs.readFileSync(localConfigPath, 'utf8'));
      config.appKey = localConfig.appKey || config.appKey;
      if (localConfig.token && !autoRegistered) config.token = localConfig.token;
      if (localConfig.accountId && !autoRegistered) config.accountId = localConfig.accountId;
      if (localConfig.apiBaseUrl) config.apiBaseUrl = localConfig.apiBaseUrl;
      log.info(`[WORKER] 从本地配置加载: appKey=${config.appKey?.substring(0, 8)}...`);
    }
  } catch (err) {
    log.error(`[WORKER] 加载本地配置失败: ${err.message}`);
  }

  // 5. 环境变量最高优先级
  config.apiBaseUrl = process.env.API_BASE_URL || config.apiBaseUrl;

  if (!config.apiBaseUrl) {
    config.apiBaseUrl = getApiBaseUrl();
    log.info(`[WORKER] 从统一配置加载 apiBaseUrl: ${config.apiBaseUrl}`);
  }

  if (!config.appKey) {
    config.appKey = getAppKey();
  }

  // 6. 使用运维账户连接融云（如果可用）
  if (config.omToken && config.omRongcloudId) {
    config.originalAccountId = config.accountId;
    config.originalToken = config.token;
    config.accountId = config.omRongcloudId;
    config.token = config.omToken;
    log.info(`[WORKER] 使用运维账户连接融云: ${config.omRongcloudId}`);
  }

  // 设置默认心跳间隔为20秒
  if (!config.heartbeatInterval) {
    config.heartbeatInterval = 20;
  }

  if (config.token && config.accountId) {
    return config;
  }

  log.warn('[WORKER] 缺少必要配置(token/accountId)，融云功能未启用');
  return null;
}

/**
 * 向服务端刷新融云 token
 */
async function refreshRongCloudToken() {
  const deviceReg = new DeviceRegistration(log);

  // 优先刷新运维 token
  if (rongcloudConfig?.omRongcloudId) {
    let nodeId = rongcloudConfig.originalAccountId || rongcloudConfig.accountId;
    // 兼容旧配置：如果 accountId 本身就是 om_xxx 且没有 originalAccountId
    if (!nodeId || nodeId.startsWith('om_')) {
      nodeId = rongcloudConfig.omRongcloudId.replace(/^om_/, '');
    }
    log.info(`[WORKER] 正在刷新运维 token, nodeId=${nodeId}`);
    const omResult = await deviceReg._getOmToken(nodeId);
    if (omResult?.token) {
      rongcloudConfig.omToken = omResult.token;
      rongcloudConfig.token = omResult.token;

      // 持久化
      const savedConfig = deviceReg.loadConfig() || {};
      savedConfig.omToken = omResult.token;
      savedConfig.expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
      await deviceReg._saveConfig(savedConfig);

      log.info('[WORKER] 运维 token 刷新成功');
      return true;
    }
  }

  // 兜底：刷新节点 token
  const refreshed = await deviceReg.refreshToken();
  if (refreshed) {
    const savedConfig = deviceReg.loadConfig();
    if (savedConfig?.token) {
      rongcloudConfig.token = savedConfig.token;
      if (rongcloudConfig.omRongcloudId) {
        // 如果当前使用运维账户，但节点 token 刷新成功，也更新 originalToken
        rongcloudConfig.originalToken = savedConfig.token;
      }
    }
    return true;
  }

  return false;
}

/**
 * 从后端系统配置同步客服账号ID
 * 
 * 重要：节点服务保持独立，不强制切换为客服账号
 * 客服账号仅用于专门的客服服务实例，不应影响普通节点服务
 *
 * @returns {Promise<boolean>} 配置是否已更新
 */
async function syncCustomerServiceAccountId() {
  // 节点服务保持独立，不切换客服账号
  log.info(`[WORKER] 节点服务保持独立账号: ${rongcloudConfig?.accountId || 'unknown'}，不切换客服账号`);
  return false;
}

/**
 * 构建 Skill 框架需要的 messageContext
 */
function buildMessageContext(rawMsg, parsed, innerContent, config) {
  const msgType = parsed.msg_type;
  const senderUserId = parsed.source_im_id || rawMsg.senderUserId;
  const targetId = rawMsg.targetId;
  const conversationType = rawMsg.conversationType;

  // content 优先使用 innerContent.content（聊天消息的真实文本），否则使用 innerContent 本身或原始 content
  let content = '';
  if (innerContent && typeof innerContent === 'object') {
    content = innerContent.content || innerContent.message || '';
  } else if (typeof innerContent === 'string') {
    content = innerContent;
  }
  if (!content && typeof parsed.content === 'string') {
    content = parsed.content;
  }

  return {
    msgType,
    content,
    senderUserId,
    targetId,
    conversationType,
    data: {
      ...parsed,
      ...innerContent,
      content,
      source_im_id: senderUserId,
      targetId,
      conversationType,
    },
    rawMsg,
    config,
  };
}

async function initRongCloud() {
  // 按需自动注册设备并获取运维账户
  if (!rongcloudConfig) {
    rongcloudConfig = await loadRongCloudConfigWithAutoRegister();
  }

  if (!rongcloudConfig) {
    log.error('[WORKER] 无法获取有效融云配置，融云功能未启用');
    return;
  }

  log.info(`[WORKER] Worker 启动，目录: ${__dirname}`);

  // 从后端同步客服账号配置
  // 确保前端发送的客服消息能正确路由到 silent-service 的融云连接账号
  const configChanged = await syncCustomerServiceAccountId();
  if (configChanged) {
    log.info('[WORKER] 客服账号已切换到数据库配置的 ID，将使用新配置连接融云');
  }
  log.info(`[WORKER] 代码版本特征: isOffLineMessage-pass-through, messageDirection-log, addEventListener-exclusive`);

  // 启动 opencode 服务（与桌面客户端对齐）
  log.info('[WORKER] 启动 opencode 服务...');
  try {
    await startOpencodeService(log);
  } catch (err) {
    log.error(`[WORKER] 启动 opencode 服务失败: ${err.message}`);
  }

  await ensurePluginsAllow(log);

  rongcloudClient = new RongCloudClient(rongcloudConfig, log);

  // 创建系统配置管理器（用于融云服务端API）
  const configManager = new SystemConfigManager(rongcloudConfig, log);
  
  // 创建融云服务端API客户端（用于发送流式消息）
  const serverAPI = new RongCloudServerAPI(configManager, log);

  // 创建消息发送器
  const messageSender = new RongyunMessageSender(rongcloudClient, rongcloudConfig, log);
  messageSender.setServerAPI(serverAPI); // 注入 serverAPI，支持发送流式消息

  // 创建新的融云消息处理器（与桌面客户端对齐）
  const rongyunMessageHandler = new RongyunMessageHandler(rongcloudClient, rongcloudConfig, log);
  rongyunMessageHandler.setMessageSender(messageSender);
  rongyunMessageHandler.setServerAPI(serverAPI); // 注入 serverAPI

  // 初始化 Skill 框架
  let skillLoader = null;
  let skillRouter = null;
  let fallbackSkill = null;
  const enableSkillFramework = process.env.ENABLE_SKILL_FRAMEWORK !== 'false';
  try {
    skillLoader = new SkillLoader(path.join(__dirname, 'skills'), log);
    const skills = await skillLoader.loadAll(rongcloudConfig, messageSender);
    skillRouter = new SkillRouter(skills, log);
    fallbackSkill = skills.find((s) => s.name === 'ops-assistant');
    if (fallbackSkill) {
      skillRouter.setFallbackSkill(fallbackSkill);
    }
    if (enableSkillFramework) {
      log.info(`[WORKER] Skill framework enabled, loaded ${skills.length} skill(s)`);
    } else {
      log.info(`[WORKER] Skill framework loaded but disabled (set ENABLE_SKILL_FRAMEWORK=true to enable), loaded ${skills.length} skill(s)`);
    }
  } catch (err) {
    log.error(`[WORKER] Failed to initialize skill framework: ${err.message}`);
  }

  messageHandler = new MessageHandler(
    rongcloudConfig,
    async (targetId, content, conversationType) => {
      return rongcloudClient.sendMessage(targetId, content, conversationType);
    },
    log,
    async (msg) => {
      return rongcloudClient.sendReadReceipt(msg);
    }
  );

  // 包装 MessageHandler.handleMessage 以处理结构化消息
  const originalHandleMessage = messageHandler.handleMessage.bind(messageHandler);

  // 辅助：给需要 SkillRouter 处理的消息发送已读回执（fire-and-forget）
  const sendReadReceiptForMessage = (msg) => {
    if (rongcloudClient && rongcloudClient.isConnected && msg.messageUId) {
      rongcloudClient.sendReadReceipt(msg).catch((err) => {
        log.warn(`[WORKER] 发送已读回执失败: ${err.message}`);
      });
    }
  };

  messageHandler.handleMessage = async (msg) => {
    // 检查是否是结构化消息（支持字符串和对象两种格式）
    // 融云 SDK 对自定义消息可能直接返回对象而非 JSON 字符串
    if (msg.content) {
      let parsed = null;

      if (typeof msg.content === 'string') {
        // 字符串类型：尝试 JSON 解析
        try {
          parsed = JSON.parse(msg.content);
        } catch {
          // 不是 JSON，是普通消息
        }
      } else if (typeof msg.content === 'object' && msg.content !== null) {
        // 对象类型：直接使用（融云 SDK 已自动解析）
        parsed = msg.content;
      }

      if (parsed && parsed.msg_type) {
        // 这是结构化消息，使用 RongyunMessageHandler 处理
        log.info(`[WORKER] 收到结构化消息: type=${parsed.msg_type}, from=${parsed.source_im_id || msg.senderUserId}`);

        // 忽略自己发送的消息
        if (parsed.source_im_id === rongcloudConfig.accountId) {
          return;
        }

        // Timestamp 校验（5分钟有效期）
        const msgTimestamp = parsed.timestamp;
        if (msgTimestamp) {
          const currentTime = Math.floor(Date.now() / 1000);
          const timeDiff = Math.abs(currentTime - msgTimestamp);
          if (timeDiff > 300) { // 5分钟 = 300秒
            logTimestampValidation(
              `消息时间戳过期: msg_time=${msgTimestamp}, current_time=${currentTime}, ` +
              `diff=${timeDiff}s, type=${parsed.msg_type}, source=${parsed.source_im_id}`
            );
            return;
          }
        }

        // 解析 content 字段（它本身可能是 JSON 字符串）
        let innerContent = parsed.content;
        if (typeof innerContent === 'string') {
          try {
            innerContent = JSON.parse(innerContent);
          } catch {
            // 保持字符串
          }
        }

        // 构建消息数据
        // 注意：后端发送的 command 消息中，command/command_id/request_id 在 content 字段内
        // 保留原始 content（用户消息内容），同时展开其他字段
        const messageData = {
          ...parsed,
          ...innerContent,  // 展开 content 中的字段（如 command, command_id 等）
          content: typeof innerContent === 'object' ? innerContent.content : innerContent,
          source_im_id: parsed.source_im_id || msg.senderUserId,  // 确保下游 handler 能取到 source_im_id
          senderUserId: parsed.source_im_id || msg.senderUserId,
          targetId: msg.targetId,
          conversationType: msg.conversationType,
        };

        // 协议消息（非聊天类）始终由旧的 RongyunMessageHandler 处理，不进入 Skill 框架
        // 避免 device_status_request 等消息被路由到 ops-assistant 触发 AI 卡片
        const protocolMessageTypes = [
          'device_status_request',
          'device_status_report',
          'heartbeat',
          'heartbeat_ack',
          'client_connected',
          'client_disconnected',
          'create_opencode_session',
          'opencode_session_created',
          'delete_opencode_session',
          'create_service_session',
          'service_session_created',
          'service_chat_message',
          'service_chat_response',
          'command',
          'command_result',
        ];
        const isProtocolMessage = protocolMessageTypes.includes(parsed.msg_type);

        // 根据 ENABLE_SKILL_FRAMEWORK 决定使用 Skill 框架还是旧的消息处理器
        if (enableSkillFramework && skillRouter && !isProtocolMessage && !msg.isOffLineMessage) {
          // SkillRouter 分支也需要发送已读回执
          sendReadReceiptForMessage(msg);
          try {
            const messageContext = buildMessageContext(msg, parsed, innerContent, rongcloudConfig);
            await skillRouter.route(messageContext);
          } catch (err) {
            log.error(`[WORKER] SkillRouter 处理异常: ${err.message}`);
          }
          return;
        }

        // 使用 RongyunMessageHandler 处理（旧逻辑）
        try {
          await rongyunMessageHandler.handle(messageData);
        } catch (err) {
          log.error(`[WORKER] RongyunMessageHandler 处理异常: ${err.message}`);
        }
        return;
      }
    }

    // 新增：普通单聊消息也交给 SkillRouter，由 ops-assistant 作为 fallback 处理
    // 解决用户直接给运维助手发普通文本消息（RC:TxtMsg）被 MessageHandler 忽略的问题
    if (enableSkillFramework && skillRouter && msg.conversationType === 1 && !msg.isOffLineMessage) {
      // 普通单聊消息进入 SkillRouter 前也需要发送已读回执
      // 注意：离线消息（isOffLineMessage）会被跳过，避免重启后积压的历史消息被重复处理
      sendReadReceiptForMessage(msg);
      try {
        const textContent = typeof msg.content === 'string' ? msg.content : (msg.content?.content || '');
        const messageContext = {
          msgType: msg.messageType,
          content: textContent,
          senderUserId: msg.senderUserId,
          targetId: msg.targetId,
          conversationType: msg.conversationType,
          data: {
            content: textContent,
            source_im_id: msg.senderUserId,
            targetId: msg.targetId,
            conversationType: msg.conversationType,
          },
          rawMsg: msg,
          config: rongcloudConfig,
        };
        log.info(`[WORKER] 普通单聊消息进入 SkillRouter: from=${msg.senderUserId}, content=${String(messageContext.content).substring(0, 50)}`);
        await skillRouter.route(messageContext);
        return;
      } catch (err) {
        log.error(`[WORKER] SkillRouter 处理普通单聊消息异常: ${err.message}`);
      }
    }

    // 调用原始的 handleMessage（处理普通消息）
    return originalHandleMessage(msg);
  };

  // 添加调试日志：确认替换后的方法
  log.info('[WORKER-DEBUG] 替换后 messageHandler.handleMessage 类型: ' + typeof messageHandler.handleMessage);

  let connected = await rongcloudClient.connect(messageHandler);

  // 连接失败时尝试刷新 token 并重试一次
  if (!connected) {
    log.warn('[WORKER] 首次融云连接失败，尝试刷新 token...');
    let refreshed = await refreshRongCloudToken();

    if (!refreshed) {
      log.warn('[WORKER] 刷新 token 失败，尝试重新自动注册...');
      const deviceReg = new DeviceRegistration(log);
      const registered = await deviceReg.autoRegister();
      if (registered) {
        rongcloudConfig = await loadRongCloudConfigWithAutoRegister();
        refreshed = true;
      }
    }

    if (refreshed) {
      // 使用新 token 重新创建客户端并连接
      rongcloudClient = new RongCloudClient(rongcloudConfig, log);
      connected = await rongcloudClient.connect(messageHandler);
    }
  }

  if (connected) {
    log.info('[WORKER] 融云连接成功');

    // 发送 CLIENT_CONNECTED
    try {
      await messageSender.sendClientConnected();
      log.info('[WORKER] CLIENT_CONNECTED 已发送');
    } catch (err) {
      log.error(`[WORKER] 发送 CLIENT_CONNECTED 失败: ${err.message}`);
    }

    // 启动心跳管理器
    const heartbeatManager = new HeartbeatManager(rongcloudClient, rongcloudConfig, log);
    heartbeatManager.start(getMacAddress);

    // 保存引用以便关闭时停止
    global.heartbeatManager = heartbeatManager;

  } else {
    log.error('[WORKER] 融云连接失败，token 刷新后仍无法连接');
  }
}

async function shutdownRongCloud() {
  // 停止心跳
  if (global.heartbeatManager) {
    global.heartbeatManager.stop();
  }

  if (rongcloudClient) {
    // 发送 CLIENT_DISCONNECTED
    try {
      const messageSender = new RongyunMessageSender(rongcloudClient, rongcloudConfig, log);
      await messageSender.sendClientDisconnected();
      log.info('[WORKER] CLIENT_DISCONNECTED 已发送');
    } catch (err) {
      log.error(`[WORKER] 发送 CLIENT_DISCONNECTED 失败: ${err.message}`);
    }

    await rongcloudClient.disconnect();
    log.info('[WORKER] 融云已断开');
  }

  // 停止 opencode 服务
  stopOpencodeService(log);
}

initRongCloud().catch(err => {
  log.error(`[WORKER] 融云初始化异常: ${err.message}`);
});

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('alive');
    return;
  }
  if (req.url === '/version') {
    try {
      const versionFile = path.join(__dirname, '..', 'version.json');
      const data = JSON.parse(fs.readFileSync(versionFile, 'utf8'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500);
      res.end('version read error');
    }
    return;
  }
  if (req.url === '/rongcloud/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      enabled: !!rongcloudConfig,
      connected: rongcloudClient?.isConnected || false
    }));
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

// 启动前确保端口未被占用（防止 EADDRINUSE 导致崩溃循环）
if (!ensurePortFree(PORT)) {
  log.error(`[WORKER] 端口 ${PORT} 无法使用，进程退出`);
  process.exit(1);
}

// 错误处理器必须先注册，再调用 listen，避免 EADDRINUSE 成为未捕获异常
let listenRetryCount = 0;
const MAX_LISTEN_RETRIES = 3;

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    listenRetryCount++;
    if (listenRetryCount > MAX_LISTEN_RETRIES) {
      log.error(`[WORKER] 端口 ${PORT} 被占用，重试 ${MAX_LISTEN_RETRIES} 次后放弃，进程退出`);
      process.exit(1);
    }
    log.error(`[WORKER] 端口 ${PORT} 被占用，尝试释放并重启监听... (第 ${listenRetryCount} 次)`);
    // 尝试杀死占用进程后重试
    const pid = findPidOnPort(PORT);
    if (pid && pid !== process.pid) {
      log.warn(`[WORKER] 发现占用进程 ${pid}，强制终止...`);
      forceKill(pid);
    } else if (!pid) {
      // 端口查询工具都不可用（常见于精简 Docker 镜像）
      // 不执行 pkill 兜底避免自杀；依赖 Daemon 的 freePortIfNeeded 清理残留 Worker
      log.warn('[WORKER] 无法查询端口占用进程，等待 Daemon 清理残留...');
    }
    // 延迟 3 秒后重试，给进程退出和端口释放留出足够时间
    setTimeout(() => {
      log.info(`[WORKER] 重新尝试监听端口 ${PORT}...`);
      server.close(() => { });
      server.listen(PORT, HOST);
    }, 3000);
    return;
  }
  log.error(`[WORKER] HTTP 服务错误: ${err.message}`);
});

server.listen(PORT, HOST, () => {
  log.info(`[WORKER] HTTP 服务已启动: http://${HOST}:${PORT}/health`);
});

process.on('message', (msg) => {
  if (msg?.type === 'prepare-shutdown') {
    log.info(`[WORKER] 收到${msg.reason || 'unknown'}通知，准备优雅退出...`);
    shutdownRongCloud().then(() => {
      server.close(() => {
        log.info('[WORKER] HTTP 服务已关闭');
        setTimeout(() => process.exit(0), 1000);
      });
    }).catch(err => {
      log.error(`[WORKER] 关闭融云异常: ${err.message}`);
      server.close(() => process.exit(0));
    });
  }
});

// 标记是否正在关闭，避免重复执行
let isShuttingDown = false;

// 优雅退出处理函数
async function gracefulShutdown(signal) {
  if (isShuttingDown) {
    log.warn(`[WORKER] 已经在关闭中，忽略 ${signal} 信号`);
    return;
  }
  isShuttingDown = true;

  log.info(`[WORKER] 收到 ${signal} 信号，开始优雅退出...`);

  try {
    await shutdownRongCloud();
  } catch (err) {
    log.error(`[WORKER] 关闭融云异常: ${err.message}`);
  }

  // 关闭 HTTP 服务
  server.close(() => {
    log.info('[WORKER] HTTP 服务已关闭');
  });

  // 给 3 秒时间完成关闭操作
  setTimeout(() => {
    log.info('[WORKER] 退出进程');
    process.exit(0);
  }, 3000);
}

// 处理正常退出信号
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// 处理 Windows 的 SIGINT（Ctrl+C）
if (process.platform === 'win32') {
  process.on('SIGBREAK', () => gracefulShutdown('SIGBREAK'));
}

// 处理未捕获的异常
process.on('uncaughtException', async (err) => {
  // EADDRINUSE 已由 server.on('error') 处理，这里避免重复触发优雅关闭
  if (err.code === 'EADDRINUSE' && err.message && err.message.includes(String(PORT))) {
    log.warn(`[WORKER] 捕获到 EADDRINUSE（端口 ${PORT}），交由 server 错误处理器重试`);
    return;
  }
  // EPIPE 常见于子进程（如 openclaw）已退出但仍在写日志，不触发整个 worker 关闭
  if (err.code === 'EPIPE') {
    log.warn(`[WORKER] 捕获到 EPIPE（子进程管道断开），忽略`);
    return;
  }
  log.error(`[WORKER] 未捕获异常: ${err.message}\n${err.stack}`);
  if (!isShuttingDown) {
    await gracefulShutdown('uncaughtException');
  }
});

// 处理未处理的 Promise 拒绝
process.on('unhandledRejection', async (reason) => {
  log.error(`[WORKER] 未捕获 Promise: ${reason}`);
  if (!isShuttingDown) {
    await gracefulShutdown('unhandledRejection');
  }
});

// 拦截 process.exit 以定位调用来源
const originalExit = process.exit;
process.exit = function (code) {
  const stack = new Error('process.exit called from:').stack;
  log.error(`[WORKER] process.exit(${code}) 被调用:\n${stack}`);
  originalExit.call(process, code);
};

// 处理进程退出事件（最后的机会）
process.on('exit', (code) => {
  log.warn(`[WORKER] 进程即将退出 (code=${code}), isShuttingDown=${isShuttingDown}`);
  if (!isShuttingDown && rongcloudClient?.isConnected) {
    // 同步发送，因为 exit 事件不支持异步
    try {
      const messageSender = new RongyunMessageSender(rongcloudClient, rongcloudConfig, log);
      messageSender.sendClientDisconnected().catch(() => { });
    } catch (e) {
      // 忽略错误
    }
  }
});

setInterval(() => {
  log.info('[WORKER] 业务心跳...');
}, 60000);
