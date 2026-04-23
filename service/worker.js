const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createLogger } = require('./logger');
const { RongCloudClient, MessageHandler, ensurePluginsAllow } = require('./rongcloud');
const { RongyunMessageHandler } = require('./modules/rongyun-message-handler');
const { RongyunMessageSender } = require('./modules/rongyun-message-sender');
const { HeartbeatManager, DashboardReporter } = require('./modules/heartbeat-dashboard');
const { getOpenClawStatus } = require('./modules/port-checker');
const { getMacAddress } = require('./modules/mac-address');
const { startOpencodeService, stopOpencodeService } = require('./modules/opencode-starter');

const log = createLogger('worker');
const PORT = 33100;

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

const clawBridgeConfigPath = path.join(os.homedir(), '.claw-bridge', 'config.json');
const localConfigPath = path.join(__dirname, '..', 'rongcloud-config.json');
let rongcloudConfig = null;

function loadRongCloudConfig() {
  let config = {};

  try {
    if (fs.existsSync(clawBridgeConfigPath)) {
      const clawConfig = JSON.parse(fs.readFileSync(clawBridgeConfigPath, 'utf8'));
      config.token = clawConfig.token;
      config.accountId = clawConfig.nodeId;
      config.nodeName = clawConfig.nodeName;
      log.info(`[WORKER] 从 claw-bridge 加载配置: nodeId=${clawConfig.nodeId}, nodeName=${clawConfig.nodeName}`);
    } else {
      log.warn('[WORKER] 未找到 ~/.claw-bridge/config.json');
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
      log.info(`[WORKER] 从本地配置加载: appKey=${config.appKey?.substring(0, 8)}...`);
    }
  } catch (err) {
    log.error(`[WORKER] 加载本地配置失败: ${err.message}`);
  }

  if (!config.appKey) {
    config.appKey = process.env.DM_APP_KEY || 'bmdehs6pbyyks';
    log.info(`[WORKER] 使用默认 appKey: ${config.appKey}`);
  }

  if (config.token && config.accountId) {
    return config;
  }

  log.warn('[WORKER] 缺少必要配置(token/accountId)，融云功能未启用');
  return null;
}

rongcloudConfig = loadRongCloudConfig();

let rongcloudClient = null;
let messageHandler = null;

async function initRongCloud() {
  if (!rongcloudConfig) return;

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
    log
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

  const connected = await rongcloudClient.connect(messageHandler);
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
    log.error('[WORKER] 融云连接失败');
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

server.listen(PORT, '127.0.0.1', () => {
  log.info(`[WORKER] HTTP 服务已启动: http://127.0.0.1:${PORT}/health`);
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

process.on('uncaughtException', (err) => {
  log.error(`[WORKER] 未捕获异常: ${err.message}\n${err.stack}`);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  log.error(`[WORKER] 未捕获 Promise: ${reason}`);
});

setInterval(() => {
  log.info('[WORKER] 业务心跳...');
}, 60000);
