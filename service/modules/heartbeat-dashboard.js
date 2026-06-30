const { RongyunMessageTypeEnum } = require('./rongyun-message-types');
const { RongyunMessageSender } = require('./rongyun-message-sender');

class HeartbeatManager {
  constructor(rongcloudClient, config, log) {
    this.rongcloudClient = rongcloudClient;
    this.config = config;
    this.log = log;
    this.timer = null;
    this.messageSender = new RongyunMessageSender(rongcloudClient, config, log);
  }

  start(getMacAddress) {
    const interval = (this.config.heartbeatInterval || 20) * 1000;

    this.timer = setInterval(async () => {
      if (!this.rongcloudClient?.isConnected) return;

      try {
        const mac = getMacAddress();

        // 1. 发送兼容心跳（HEARTBEAT）
        const heartbeatSent = await this.messageSender.sendProtocolMessage(
          RongyunMessageTypeEnum.HEARTBEAT,
          {
            mac_address: mac,
            nickname: this.config.nodeName,
            client_status: 1,
          }
        );
        if (!heartbeatSent) {
          this.log?.warn('[HeartbeatManager] 心跳发送失败');
        }

        // 2. 发送设备状态报告（DEVICE_STATUS_REPORT），让后端更新 deploy_status 为 online
        const reportSent = await this.messageSender.sendProtocolMessage(
          RongyunMessageTypeEnum.DEVICE_STATUS_REPORT,
          {
            mac_address: mac,
            nickname: this.config.nodeName,
            openclaw_status: 0,
            opencode_status: 1,
            status_message: '运行中',
            timestamp: Date.now(),
          }
        );
        if (!reportSent) {
          this.log?.warn('[HeartbeatManager] 设备状态报告发送失败');
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

module.exports = {
  HeartbeatManager,
};
