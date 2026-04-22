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
const { HeartbeatManager, DashboardReporter } = require('./modules/heartbeat-dashboard');
const { getOpenClawStatus } = require('./modules/port-checker');
const { getMacAddress } = require('./modules/mac-address');
const { StructuredMessageRouter } = require('./modules/structured-message-router');
const { RongyunMessageTypeEnum } = require('./modules/rongyun-message-types');

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

  // 包装 MessageHandler.handleMessage 以处理结构化消息
  // 问题：rongcloud-client.js 现在会传递所有消息（SYSTEM_MSG_TYPES 已清空）
  // 但 message-handler.js 的 getMessageType() 只检查 content 是否以 '/' 开头
  // 结构化消息（如 command）的 content 是 JSON 字符串，不以 '/' 开头
  // 导致所有结构化消息被当作 NORMAL 消息处理
  // 解决方案：在 handleMessage 之前拦截，检查是否是结构化消息
  const originalHandleMessage = messageHandler.handleMessage.bind(messageHandler);
  
  // 添加调试日志：确认包装器已设置
  log.info('[WORKER-DEBUG] 包装器已设置，originalHandleMessage 类型: ' + typeof originalHandleMessage);
  log.info('[WORKER-DEBUG] messageHandler.handleMessage 类型: ' + typeof messageHandler.handleMessage);
  
  messageHandler.handleMessage = async (msg) => {
    log.info(`[WORKER-DEBUG] 包装器被调用，msg.content 前50字符: ${msg.content?.substring(0, 50)}`);
    log.info(`[WORKER-DEBUG] msg.senderUserId: ${msg.senderUserId}`);
    
    // 检查是否是结构化消息
    if (msg.content && typeof msg.content === 'string') {
      log.info('[WORKER-DEBUG] content 是字符串，尝试解析 JSON');
      try {
        const parsed = JSON.parse(msg.content);
        log.info(`[WORKER-DEBUG] JSON 解析成功，parsed.msg_type: ${parsed.msg_type}`);
        
        if (parsed.msg_type) {
          // 这是结构化消息，根据 msg_type 路由
          log.info(`[WORKER] 收到结构化消息: type=${parsed.msg_type}, from=${parsed.source_im_id || msg.senderUserId}`);
          
          // 忽略自己发送的消息
          if (parsed.source_im_id === rongcloudConfig.accountId) {
            log.info('[WORKER] 忽略自己发送的消息');
            return;
          }
          
          // 解析 content 字段（它本身可能是 JSON 字符串）
          let innerContent = parsed.content;
          if (typeof innerContent === 'string') {
            try {
              innerContent = JSON.parse(innerContent);
              log.info('[WORKER-DEBUG] innerContent 解析为 JSON 成功');
            } catch {
              log.info('[WORKER-DEBUG] innerContent 保持字符串');
            }
          }
          
          const messageData = {
            ...parsed,
            content: innerContent,
            senderUserId: parsed.source_im_id || msg.senderUserId,
            targetId: msg.targetId,
            conversationType: msg.conversationType,
          };
          
          // 根据 msg_type 处理
          switch (parsed.msg_type) {
            case RongyunMessageTypeEnum.COMMAND:
              log.info(`[WORKER] 处理命令消息: command=${innerContent.command}`);
              if (rongcloudConfig.onCommand) {
                // 后端发送的 command 是数字枚举值（1=start, 2=stop, 3=restart, 4=status）
                // 与桌面客户端保持一致
                const payload = {
                  command: innerContent.command,  // 直接传递数字
                  args: innerContent.args || [],
                  rawMessage: msg.content,
                  senderId: messageData.senderUserId,
                  commandId: innerContent.command_id,
                };
                try {
                  const reply = await rongcloudConfig.onCommand(payload);
                  // 发送回复
                  const targetId = msg.conversationType === 3 ? msg.targetId : msg.senderUserId;
                  await rongcloudClient.sendMessage(targetId, reply, msg.conversationType);
                } catch (err) {
                  log.error(`[WORKER] 命令处理异常: ${err.message}`);
                }
              }
              return;
              
            case RongyunMessageTypeEnum.CHAT_MESSAGE:
              log.info(`[WORKER] 处理聊天消息`);
              // 调用 normal message handler
              try {
                const reply = await handleNormalMessage({
                  content: typeof innerContent === 'string' ? innerContent : JSON.stringify(innerContent),
                  senderUserId: messageData.senderUserId,
                  targetId: msg.targetId,
                  conversationType: msg.conversationType,
                  messageType: 'RC:TxtMsg',
                });
                // 发送回复
                const targetId = msg.conversationType === 3 ? msg.targetId : msg.senderUserId;
                await rongcloudClient.sendMessage(targetId, reply, msg.conversationType);
              } catch (err) {
                log.error(`[WORKER] 聊天消息处理异常: ${err.message}`);
              }
              return;
              
            case RongyunMessageTypeEnum.CREATE_OPENCODE_SESSION:
              log.info(`[WORKER] 处理创建会话消息`);
              // TODO: 实现创建会话逻辑
              return;
              
            case RongyunMessageTypeEnum.DELETE_OPENCODE_SESSION:
              log.info(`[WORKER] 处理删除会话消息`);
              // TODO: 实现删除会话逻辑
              return;
              
            default:
              log.warn(`[WORKER] 未知消息类型: ${parsed.msg_type}`);
              // 继续传给原始 handler
          }
        } else {
          log.info('[WORKER-DEBUG] parsed.msg_type 不存在，不是结构化消息');
        }
      } catch (err) {
        log.info(`[WORKER-DEBUG] JSON 解析失败，是普通消息: ${err.message}`);
      }
    } else {
      log.info(`[WORKER-DEBUG] content 不是字符串或为空: ${typeof msg.content}`);
    }
    
    log.info('[WORKER-DEBUG] 调用原始 handleMessage');
    // 调用原始的 handleMessage
    return originalHandleMessage(msg);
  };
  
  // 添加调试日志：确认替换后的方法
  log.info('[WORKER-DEBUG] 替换后 messageHandler.handleMessage 类型: ' + typeof messageHandler.handleMessage);

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
