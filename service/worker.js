const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createLogger } = require('./logger');
const { RongCloudClient, MessageHandler, ensurePluginsAllow } = require('./rongcloud');
const { BusinessMessageHandler } = require('./modules/business-message-handler');
const { OpenClawClient } = require('./rongcloud/openclaw-client');
const { handleNormalMessage } = require('./modules/normal-message-handler');
const { RongyunMessageSender } = require('./modules/rongyun-message-sender');
const { getOpenClawStatus } = require('./modules/port-checker');

const log = createLogger('worker');
const PORT = 33100;

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

  await ensurePluginsAllow(log);

  rongcloudClient = new RongCloudClient(rongcloudConfig, log);

  // 创建业务消息处理器
  const businessMessageHandler = new BusinessMessageHandler(
    rongcloudConfig,
    rongcloudClient,
    log
  );

  // 注入命令处理回调
  // 被调用位置：rongcloud/message-handler.js 第93行
  rongcloudConfig.onCommand = async (payload) => {
    return await businessMessageHandler.handleCommand(payload);
  };

  // Monkey Patch: 替换 OpenClawClient.chat 方法
  // 被调用位置：rongcloud/message-handler.js 第109行（handleNormal 方法）
  // 原始代码：const reply = await this.openclawClient.chat(msg.content, msg.senderUserId);
  // 由于 handleNormal 被注释掉了，但如果将来启用，会调用这个方法
  // 我们将 chat 方法替换为直接调用我们的 handleNormalMessage
  OpenClawClient.prototype.chat = async function(content, senderUserId) {
    // 构造 msg 对象，与 handleNormal 的 msg 参数格式一致
    const msg = {
      content: content,
      senderUserId: senderUserId,
      targetId: senderUserId,
      conversationType: 1, // 私聊
      messageType: 'RC:TxtMsg',
      isOffLineMessage: false,
      messageUId: `local-${Date.now()}`,
      sentTime: Date.now()
    };
    return await handleNormalMessage(msg);
  };

  messageHandler = new MessageHandler(
    rongcloudConfig,
    async (targetId, content, conversationType) => {
      return rongcloudClient.sendMessage(targetId, content, conversationType);
    },
    log
  );

  const connected = await rongcloudClient.connect(messageHandler);
  if (connected) {
    log.info('[WORKER] 融云连接成功');
    
    // 创建消息发送器
    const messageSender = new RongyunMessageSender(rongcloudClient, rongcloudConfig, log);
    
    // 发送 CLIENT_CONNECTED
    try {
      await messageSender.sendClientConnected();
      log.info('[WORKER] CLIENT_CONNECTED 已发送');
    } catch (err) {
      log.error(`[WORKER] 发送 CLIENT_CONNECTED 失败: ${err.message}`);
    }
    
    // 启动心跳定时器
    const heartbeatInterval = (rongcloudConfig.heartbeatInterval || 20) * 1000;
    setInterval(async () => {
      try {
        const status = await getOpenClawStatus(rongcloudConfig.openclawPort || 18789);
        await messageSender.sendHeartbeat(status);
        log.info('[WORKER] 心跳已发送');
      } catch (err) {
        log.error(`[WORKER] 心跳发送失败: ${err.message}`);
      }
    }, heartbeatInterval);
    log.info(`[WORKER] 心跳定时器已启动，间隔: ${heartbeatInterval}ms`);
    
  } else {
    log.error('[WORKER] 融云连接失败');
  }
}

async function shutdownRongCloud() {
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
