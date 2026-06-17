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
        const sent = await this.messageSender.sendProtocolMessage(
          RongyunMessageTypeEnum.HEARTBEAT,
          {
            mac_address: mac,
            nickname: this.config.nodeName,
            client_status: 1,
          }
        );
        if (!sent) {
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

module.exports = {
  HeartbeatManager,
};
