const path = require('path');
const http = require('http');
const fs = require('fs');
const os = require('os');
const { createLogger } = require('./logger');
const { loadConfig } = require('./modules/config');
const { RongCloudClient } = require('./rongcloud/rongcloud-client');
const { MessageHandler } = require('./rongcloud/message-handler');
const { getMacAddress } = require('./modules/mac-address');
const { collectDashboardData } = require('./modules/dashboard-collector');
const { RongyunMessageTypeEnum } = require('./rongcloud/message-types');
const { startOpencodeService } = require('./modules/opencode-starter');
const { getOpenClawStatus } = require('./modules/port-checker');

const log = createLogger('worker');
const PORT = 33100;

log.info(`[WORKER] 业务进程启动，PID: ${process.pid}`);

class Worker {
  constructor() {
    this.config = null;
    this.rongcloudClient = null;
    this.messageHandler = null;
    this.server = null;
    this.heartbeatInterval = null;
    this.dashboardInterval = null;
    this.isShuttingDown = false;
    this.clawBridgeConfigPath = path.join(os.homedir(), '.claw-bridge', 'config.json');
  }

  async waitForImUserId() {
    return new Promise((resolve) => {
      const check = () => {
        if (fs.existsSync(this.clawBridgeConfigPath)) {
          try {
            const clawConfig = JSON.parse(fs.readFileSync(this.clawBridgeConfigPath, 'utf8'));
            if (clawConfig.nodeId) {
              log.info(`[WORKER] 获取到 IM user ID: ${clawConfig.nodeId}`);
              resolve(clawConfig.nodeId);
              return;
            }
          } catch (err) {
            log.error(`[WORKER] 读取 claw-bridge 配置失败: ${err.message}`);
          }
        }
        log.info('[WORKER] 等待 IM user ID，3分钟后重试...');
        setTimeout(check, 3 * 60 * 1000);
      };
      check();
    });
  }

  async startHeartbeat() {
    log.info('[WORKER] 启动心跳定时器 (20秒)');
    this.heartbeatInterval = setInterval(async () => {
      if (this.rongcloudClient && this.rongcloudClient.isConnected) {
        try {
          const mac = getMacAddress();
          const status = await getOpenClawStatus(this.config.openclawPort || 18789);
          await this.rongcloudClient.sendStructuredMessage(
            RongyunMessageTypeEnum.HEARTBEAT,
            { 
              mac_address: mac, 
              nickname: this.config.nodeName,
              open_claw_status: status, 
              client_status: 1,
              timestamp: new Date().toISOString() 
            }
          );
          log.info('[WORKER] 心跳已发送');
        } catch (err) {
          log.error(`[WORKER] 心跳发送失败: ${err.message}`);
        }
      }
    }, 20 * 1000);
  }

  async sendDashboardChunk(msgType, data) {
    if (this.rongcloudClient && this.rongcloudClient.isConnected) {
      try {
        await this.rongcloudClient.sendStructuredMessage(msgType, data);
        log.info(`[WORKER] Dashboard chunk sent: ${msgType}`);
      } catch (err) {
        log.error(`[WORKER] Dashboard chunk发送失败: ${err.message}`);
      }
    }
  }

  async startDashboardReport() {
    log.info('[WORKER] 启动 Dashboard 上报定时器 (30秒)');
    let messageCount = 0;
    const MAX_MESSAGES = 6;

    this.dashboardInterval = setInterval(async () => {
      if (messageCount >= MAX_MESSAGES) {
        log.info('[WORKER] Dashboard 上报达到最大次数，停止上报');
        clearInterval(this.dashboardInterval);
        this.dashboardInterval = null;
        return;
      }

      if (this.rongcloudClient && this.rongcloudClient.isConnected) {
        try {
          const data = await collectDashboardData();
          await this.sendDashboardChunk(RongyunMessageTypeEnum.DASHBOARD_SESSIONS, { sessions: data.sessions });
          await this.sendDashboardChunk(RongyunMessageTypeEnum.DASHBOARD_JOBS, { cronJobs: data.cronJobs });
          await this.sendDashboardChunk(RongyunMessageTypeEnum.DASHBOARD_PROJECTS, { projects: data.projects });
          await this.sendDashboardChunk(RongyunMessageTypeEnum.DASHBOARD_SUMMARIES, {
            tasksSummary: data.tasksSummary,
            budgetSummary: data.budgetSummary,
            diagnostics: data.diagnostics
          });
          await this.sendDashboardChunk(RongyunMessageTypeEnum.DASHBOARD_SESSIONS_CONTEXTS, { sessionsContexts: data.sessionsContexts });
          await this.sendDashboardChunk(RongyunMessageTypeEnum.DASHBOARD_USAGE_EVENTS, { usageEvents: data.usageEvents });
          messageCount++;
          log.info(`[WORKER] Dashboard 上报完成 (${messageCount}/${MAX_MESSAGES})`);
        } catch (err) {
          log.error(`[WORKER] Dashboard 上报失败: ${err.message}`);
        }
      }
    }, 30 * 1000);
  }

  startHealthServer() {
    this.server = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          connected: this.rongcloudClient?.isConnected || false,
          timestamp: new Date().toISOString()
        }));
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
      res.writeHead(404);
      res.end('not found');
    });

    this.server.listen(PORT, '127.0.0.1', () => {
      log.info(`[WORKER] HTTP 服务已启动: http://127.0.0.1:${PORT}/health`);
    });
  }

  async shutdown() {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    log.info('[WORKER] 开始优雅退出...');

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.dashboardInterval) {
      clearInterval(this.dashboardInterval);
      this.dashboardInterval = null;
    }

    if (this.rongcloudClient) {
      try {
        await this.rongcloudClient.disconnect();
        log.info('[WORKER] 融云已断开');
      } catch (err) {
        log.error(`[WORKER] 断开融云异常: ${err.message}`);
      }
    }

    if (this.server) {
      this.server.close(() => {
        log.info('[WORKER] HTTP 服务已关闭');
        setTimeout(() => process.exit(0), 1000);
      });
    } else {
      setTimeout(() => process.exit(0), 1000);
    }
  }

  async init() {
    try {
      this.config = loadConfig();
      log.info('[WORKER] 配置加载完成');

      const imUserId = await this.waitForImUserId();
      this.config.accountId = imUserId;

      await startOpencodeService(log);
      log.info('[WORKER] opencode 服务已启动');

      this.rongcloudClient = new RongCloudClient(this.config, log);
      this.messageHandler = new MessageHandler(
        this.config,
        async (targetId, content, conversationType) => {
          return this.rongcloudClient.sendMessage(targetId, content, conversationType);
        },
        log
      );

      const connected = await this.rongcloudClient.connect(this.messageHandler);
      if (connected) {
        log.info('[WORKER] 融云连接成功');

        try {
          const mac = getMacAddress();
          await this.rongcloudClient.sendStructuredMessage(
            RongyunMessageTypeEnum.CLIENT_CONNECTED,
            { mac_address: mac, timestamp: new Date().toISOString(), nickname: this.config.nodeName }
          );
          log.info('[WORKER] CLIENT_CONNECTED 消息已发送');
        } catch (err) {
          log.error(`[WORKER] 发送 CLIENT_CONNECTED 失败: ${err.message}`);
        }

        await this.startHeartbeat();
        await this.startDashboardReport();
      } else {
        log.error('[WORKER] 融云连接失败');
      }

      this.startHealthServer();
    } catch (err) {
      log.error(`[WORKER] 初始化异常: ${err.message}`);
      process.exit(1);
    }
  }
}

const worker = new Worker();

process.on('SIGTERM', () => worker.shutdown());

process.on('message', (msg) => {
  if (msg?.type === 'prepare-shutdown') {
    log.info(`[WORKER] 收到${msg.reason || 'unknown'}通知，准备优雅退出...`);
    worker.shutdown();
  }
});

process.on('uncaughtException', (err) => {
  log.error(`[WORKER] 未捕获异常: ${err.message}\n${err.stack}`);
  worker.shutdown();
});

process.on('unhandledRejection', (reason) => {
  log.error(`[WORKER] 未捕获 Promise: ${reason}`);
});

if (process.env.NODE_ENV !== 'test') {
  worker.init();
}

module.exports = {
  Worker,
  worker
};
