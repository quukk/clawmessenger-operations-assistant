const { RongyunMessageTypeEnum } = require('./rongyun-message-types');
const { collectDashboardData } = require('./dashboard-collector');
const { RongyunMessageSender } = require('./rongyun-message-sender');

class HeartbeatManager {
  constructor(rongcloudClient, config, log) {
    this.rongcloudClient = rongcloudClient;
    this.config = config;
    this.log = log;
    this.timer = null;
    this.messageSender = new RongyunMessageSender(rongcloudClient, config, log);
  }

  start(getMacAddress, getOpenClawStatus) {
    const interval = (this.config.heartbeatInterval || 20) * 1000;
    this.log?.info(`[HeartbeatManager] 启动心跳定时器，间隔: ${interval}ms`);
    
    this.timer = setInterval(async () => {
      if (!this.rongcloudClient?.isConnected) return;
      
      try {
        const mac = getMacAddress();
        const status = await getOpenClawStatus(this.config.openclawPort || 18789);
        const sent = await this.messageSender.sendProtocolMessage(
          RongyunMessageTypeEnum.HEARTBEAT,
          {
            mac_address: mac,
            nickname: this.config.nodeName,
            open_claw_status: status,
            client_status: 1,
          }
        );
        if (sent) {
          this.log?.info('[HeartbeatManager] 心跳已发送');
        } else {
          this.log?.warn('[HeartbeatManager] 心跳发送失败');
        }
      } catch (err) {
        this.log?.error(`[HeartbeatManager] 心跳发送异常: ${err.message}`);
      }
    }, interval);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.log?.info('[HeartbeatManager] 心跳定时器已停止');
    }
  }
}

class DashboardReporter {
  constructor(rongcloudClient, config, log) {
    this.rongcloudClient = rongcloudClient;
    this.config = config;
    this.log = log;
    this.timer = null;
    this.messageSender = new RongyunMessageSender(rongcloudClient, config, log);
  }

  start(getMacAddress) {
    const interval = 30000; // 30秒
    this.log?.info(`[DashboardReporter] 启动仪表盘上报定时器，间隔: ${interval}ms`);
    
    this.timer = setInterval(async () => {
      if (!this.rongcloudClient?.isConnected) return;
      
      try {
        const data = await collectDashboardData();
        const timestamp = data.diagnostics?.generatedAt || new Date().toISOString();
        const mac = getMacAddress();
        
        // 拆分为 6 条消息发送
        await this.sendChunk(RongyunMessageTypeEnum.DASHBOARD_SESSIONS, {
          mac_address: mac,
          sessions: data.sessions,
          sessionStatuses: data.sessionStatuses,
          timestamp,
        }, 1000);
        
        await this.sendChunk(RongyunMessageTypeEnum.DASHBOARD_JOBS, {
          mac_address: mac,
          cronJobs: data.cronJobs,
          approvals: data.approvals,
          timestamp,
        }, 1000);
        
        await this.sendChunk(RongyunMessageTypeEnum.DASHBOARD_PROJECTS, {
          mac_address: mac,
          projects: data.projects,
          tasks: data.tasks,
          timestamp,
        }, 1000);
        
        await this.sendChunk(RongyunMessageTypeEnum.DASHBOARD_SUMMARIES, {
          mac_address: mac,
          projectSummaries: data.projectSummaries,
          tasksSummary: data.tasksSummary,
          budgetSummary: data.budgetSummary,
          diagnostics: data.diagnostics,
          timestamp,
        }, 1000);
        
        await this.sendChunk(RongyunMessageTypeEnum.DASHBOARD_SESSIONS_CONTEXTS, {
          mac_address: mac,
          sessionsContexts: (data.sessionsContexts || []).slice(0, 50),
          timestamp,
        }, 1000);
        
        await this.sendChunk(RongyunMessageTypeEnum.DASHBOARD_USAGE_EVENTS, {
          mac_address: mac,
          usageEvents: (data.usageEvents || []).slice(-100),
          timestamp,
        }, 0);
        
        this.log?.info('[DashboardReporter] 所有数据块发送完成');
      } catch (err) {
        this.log?.error(`[DashboardReporter] 上报异常: ${err.message}`);
      }
    }, interval);
  }

  async sendChunk(msgType, data, delayMs) {
    try {
      const sent = await this.messageSender.sendProtocolMessage(msgType, data);
      if (sent) {
        this.log?.info(`[DashboardReporter] ${msgType} 发送成功`);
      } else {
        this.log?.warn(`[DashboardReporter] ${msgType} 发送失败`);
      }
    } catch (err) {
      this.log?.error(`[DashboardReporter] ${msgType} 发送异常: ${err.message}`);
    }
    
    if (delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.log?.info('[DashboardReporter] 仪表盘上报定时器已停止');
    }
  }
}

module.exports = {
  HeartbeatManager,
  DashboardReporter
};
