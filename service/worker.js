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
const { HeartbeatManager, DashboardReporter } = require('./modules/heartbeat-dashboard');
const { getOpenClawStatus } = require('./modules/port-checker');
const { getMacAddress } = require('./modules/mac-address');
const { startOpencodeService, stopOpencodeService } = require('./modules/opencode-starter');

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
 * Windows 下检查本地地址（第二列）是否匹配目标端口，不限于 LISTENING 状态
 */
function findPidOnPort(port) {
  try {
    if (process.platform === 'win32') {
      const out = execSync(`netstat -ano | findstr ":${port}"`, {
        encoding: 'utf8', timeout: 5000, windowsHide: true,
      });
      for (const line of out.split('\n')) {
        const parts = line.trim().split(/\s+/);
        // netstat -ano 格式: Proto LocalAddress ForeignAddress State PID
        // 检查本地地址是否以目标端口结尾（避免匹配到 ForeignAddress）
        const localAddr = parts[1] || '';
        if (localAddr.endsWith(`:${port}`) || localAddr.endsWith(`]:${port}`)) {
          const pid = parseInt(parts[parts.length - 1], 10);
          if (!isNaN(pid)) return pid;
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
  } catch { return false; }
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
    forceKill(pid);
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
    try { process.chdir(os.tmpdir()); } catch {}
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

function loadRongCloudConfig() {
  let config = {};

  try {
    if (fs.existsSync(clawBridgeConfigPath)) {
      const clawConfig = JSON.parse(fs.readFileSync(clawBridgeConfigPath, 'utf8'));
      config.token = clawConfig.token;
      config.accountId = clawConfig.nodeId;
      config.nodeName = clawConfig.nodeName;
      if (clawConfig.apiBaseUrl) config.apiBaseUrl = clawConfig.apiBaseUrl;
      log.info(`[WORKER] 从 claw-bridge 加载配置: nodeId=${clawConfig.nodeId}, nodeName=${clawConfig.nodeName}`);
    } else {
      log.warn(`[WORKER] 未找到 ${clawBridgeConfigPath}`);
    }
  } catch (err) {
    log.error(`[WORKER] 加载 claw-bridge 配置失败: ${err.message}`);
  }

  try {
    if (fs.existsSync(localConfigPath)) {
      const localConfig = JSON.parse(fs.readFileSync(localConfigPath, 'utf8'));
      config.appKey = localConfig.appKey || config.appKey;
      if (localConfig.token) config.token = localConfig.token;
      if (localConfig.accountId) config.accountId = localConfig.accountId;
      if (localConfig.appSecret) config.appSecret = localConfig.appSecret;
      if (localConfig.apiBaseUrl) config.apiBaseUrl = localConfig.apiBaseUrl;
      log.info(`[WORKER] 从本地配置加载: appKey=${config.appKey?.substring(0, 8)}...`);
    }
  } catch (err) {
    log.error(`[WORKER] 加载本地配置失败: ${err.message}`);
  }

  // 加载 apiBaseUrl（Python 后端地址，用于代理发送流式消息）
  // 优先级：环境变量 > 配置文件 > 推导值(DM_SERVER_URL) > 默认值
  config.apiBaseUrl = process.env.API_BASE_URL || config.apiBaseUrl;

  if (!config.apiBaseUrl) {
    const serverUrl = process.env.DM_SERVER_URL || 'https://newsradar.dreamdt.cn/im';
    try {
      const url = new URL(serverUrl);
      config.apiBaseUrl = `${url.protocol}//${url.host}`;
      log.info(`[WORKER] 从 serverUrl 推导 apiBaseUrl: ${config.apiBaseUrl}`);
    } catch {
      config.apiBaseUrl = 'http://127.0.0.1:5000';
    }
  }

  if (!config.appKey) {
    config.appKey = process.env.DM_APP_KEY || 'bmdehs6pbyyks';
    log.info(`[WORKER] 使用默认 appKey: ${config.appKey}`);
  }

  // 设置默认心跳间隔为20秒
  if (!config.heartbeatInterval) {
    config.heartbeatInterval = 20;
  }

  log.info(`[WORKER] 最终 apiBaseUrl: ${config.apiBaseUrl}`);

  if (config.token && config.accountId) {
    return config;
  }

  log.warn('[WORKER] 缺少必要配置(token/accountId)，融云功能未启用');
  return null;
}

rongcloudConfig = loadRongCloudConfig();

let rongcloudClient = null;
let messageHandler = null;

/**
 * 向服务端刷新融云 token
 */
async function refreshRongCloudToken() {
  const nodeId = rongcloudConfig?.accountId;
  if (!nodeId) {
    log.error('[WORKER] 无法刷新 token: 缺少 nodeId');
    return false;
  }

  const serverUrl = process.env.DM_SERVER_URL || 'https://newsradar.dreamdt.cn/im';
  try {
    log.info(`[WORKER] 正在向服务端刷新 token, nodeId=${nodeId}`);
    const resp = await axios.get(`${serverUrl}/api/claw/token/${nodeId}`, { timeout: 15000 });
    if (resp.data?.code === 200) {
      const newToken = resp.data.data?.token || resp.data.token || '';
      if (!newToken) {
        log.error('[WORKER] 服务端返回了空 token');
        return false;
      }
      log.info('[WORKER] token 刷新成功');

      // 更新内存配置
      rongcloudConfig.token = newToken;

      // 保存到 config.json
      try {
        if (fs.existsSync(clawBridgeConfigPath)) {
          const clawConfig = JSON.parse(fs.readFileSync(clawBridgeConfigPath, 'utf8'));
          clawConfig.token = newToken;
          clawConfig.expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7天
          fs.writeFileSync(clawBridgeConfigPath, JSON.stringify(clawConfig, null, 2));
          log.info('[WORKER] 新 token 已保存到 config.json');
        }
      } catch (err) {
        log.error(`[WORKER] 保存新 token 失败: ${err.message}`);
      }
      return true;
    }
    log.error(`[WORKER] 刷新 token 失败: ${resp.data?.message || '未知错误'}`);
    return false;
  } catch (err) {
    log.error(`[WORKER] 刷新 token 异常: ${err.message}`);
    return false;
  }
}

async function initRongCloud() {
  if (!rongcloudConfig) return;

  log.info(`[WORKER] Worker 启动，目录: ${__dirname}`);
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

  // 创建消息发送器
  const messageSender = new RongyunMessageSender(rongcloudClient, rongcloudConfig, log);

  // 创建新的融云消息处理器（与桌面客户端对齐）
  const rongyunMessageHandler = new RongyunMessageHandler(rongcloudClient, rongcloudConfig, log);
  rongyunMessageHandler.setMessageSender(messageSender);

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

  messageHandler.handleMessage = async (msg) => {
    // 检查是否是结构化消息
    if (msg.content && typeof msg.content === 'string') {
      try {
        const parsed = JSON.parse(msg.content);

        if (parsed.msg_type) {
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
            senderUserId: parsed.source_im_id || msg.senderUserId,
            targetId: msg.targetId,
            conversationType: msg.conversationType,
          };

          // 使用 RongyunMessageHandler 处理
          try {
            await rongyunMessageHandler.handle(messageData);
          } catch (err) {
            log.error(`[WORKER] RongyunMessageHandler 处理异常: ${err.message}`);
          }
          return;
        }
      } catch {
        // 不是 JSON，是普通消息，继续传给原始 handler
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
    const refreshed = await refreshRongCloudToken();
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
    heartbeatManager.start(getMacAddress, getOpenClawStatus);

    // 启动仪表盘上报
    const dashboardReporter = new DashboardReporter(rongcloudClient, rongcloudConfig, log);
    dashboardReporter.start(getMacAddress);

    // 保存引用以便关闭时停止
    global.heartbeatManager = heartbeatManager;
    global.dashboardReporter = dashboardReporter;

  } else {
    log.error('[WORKER] 融云连接失败，token 刷新后仍无法连接');
  }
}

async function shutdownRongCloud() {
  // 停止心跳和仪表盘上报
  if (global.heartbeatManager) {
    global.heartbeatManager.stop();
  }
  if (global.dashboardReporter) {
    global.dashboardReporter.stop();
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
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log.error(`[WORKER] 端口 ${PORT} 被占用，尝试释放并重启监听...`);
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
      server.close(() => {});
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
process.exit = function(code) {
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
      messageSender.sendClientDisconnected().catch(() => {});
    } catch (e) {
      // 忽略错误
    }
  }
});

setInterval(() => {
  log.info('[WORKER] 业务心跳...');
}, 60000);
