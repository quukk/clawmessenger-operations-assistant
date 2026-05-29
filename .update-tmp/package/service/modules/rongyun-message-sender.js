/**
 * 融云消息发送工具
 * 
 * 封装与融云 guardserver 的消息交互
 * 服务端融云账号: guardserver
 */
const { RongyunMessageTypeEnum } = require('./rongyun-message-types');
const { getMacAddress } = require('./mac-address');
const { generateSecret } = require('./auth');

class RongyunMessageSender {
  constructor(rongcloudClient, config, log) {
    this.rongcloudClient = rongcloudClient;
    this.config = config;
    this.log = log;
    this.serverImId = 'guardserver';
  }

  /**
   * 构建标准协议消息
   */
  buildMessage(msgType, content, requestId) {
    const mac = getMacAddress();
    const secret = generateSecret(mac, this.config.secretKey || 'secret_key');

    return {
      msg_type: msgType,
      source_im_id: this.config.accountId || '',
      destination_im_id: this.serverImId,
      mac: mac,
      secret: secret,
      content: typeof content === 'string' ? content : JSON.stringify(content),
      request_id: requestId || '',
      timestamp: Math.floor(Date.now() / 1000),
    };
  }

  /**
   * 发送协议消息到 guardserver
   */
  async sendProtocolMessage(msgType, content, requestId) {
    if (!this.rongcloudClient?.isConnected) {
      this.log?.error('[RongyunMessageSender] 未连接，无法发送消息');
      return false;
    }

    try {
      const messagePayload = this.buildMessage(msgType, content, requestId);

      // this.log?.info(`[RongyunMessageSender] 发送协议消息 -> ${this.serverImId}, type=${msgType}`);

      const result = await this.rongcloudClient.sendMessage(
        this.serverImId,
        JSON.stringify(messagePayload),
        1 // PRIVATE
      );

      if (result) {
        // this.log?.info(`[RongyunMessageSender] ${msgType} 发送成功`);
      } else {
        this.log?.warn(`[RongyunMessageSender] ${msgType} 发送失败`);
      }

      return result;
    } catch (err) {
      this.log?.error(`[RongyunMessageSender] 发送异常: ${err.message}`);
      return false;
    }
  }

  /**
   * 发送 CLIENT_CONNECTED
   */
  async sendClientConnected() {
    return await this.sendProtocolMessage(
      RongyunMessageTypeEnum.CLIENT_CONNECTED,
      {
        mac_address: getMacAddress(),
        nickname: this.config.nodeName || 'CLI客户端',
      }
    );
  }

  /**
   * 发送 CLIENT_DISCONNECTED
   */
  async sendClientDisconnected() {
    return await this.sendProtocolMessage(
      RongyunMessageTypeEnum.CLIENT_DISCONNECTED,
      {
        mac_address: getMacAddress(),
      }
    );
  }

  /**
   * 发送心跳
   */
  async sendHeartbeat(openClawStatus) {
    return await this.sendProtocolMessage(
      RongyunMessageTypeEnum.HEARTBEAT,
      {
        mac_address: getMacAddress(),
        nickname: this.config.nodeName || 'CLI客户端',
        open_claw_status: openClawStatus,
        client_status: 1,
      }
    );
  }

  /**
   * 发送命令结果
   */
  async sendCommandResult(command, commandId, status, message, requestId) {
    return await this.sendProtocolMessage(
      RongyunMessageTypeEnum.COMMAND_RESULT,
      {
        command,
        command_id: commandId,
        status,
        message,
      },
      requestId
    );
  }

  /**
   * 发送聊天消息回复
   */
  async sendChatMessage(content, requestId) {
    return await this.sendProtocolMessage(
      RongyunMessageTypeEnum.CHAT_MESSAGE,
      {
        status: 'success',
        message: 'Response received',
        content: content,
        metadata: {}
      },
      requestId
    );
  }

  /**
   * 发送仪表盘数据
   */
  async sendDashboardData(msgType, data) {
    return await this.sendProtocolMessage(msgType, {
      mac_address: getMacAddress(),
      timestamp: new Date().toISOString(),
      ...data,
    });
  }

  /**
   * 发送消息到指定目标（P2P）
   */
  async sendToTarget(targetId, msgType, content, requestId) {
    if (!this.rongcloudClient?.isConnected) {
      this.log?.error('[RongyunMessageSender] 未连接，无法发送消息');
      return false;
    }

    try {
      const mac = getMacAddress();
      const secret = generateSecret(mac, this.config.secretKey || 'secret_key');
      const messagePayload = {
        msg_type: msgType,
        source_im_id: this.config.accountId || '',
        destination_im_id: targetId,
        mac: mac,
        secret: secret,
        content: typeof content === 'string' ? content : JSON.stringify(content),
        request_id: requestId || '',
        timestamp: Math.floor(Date.now() / 1000),
      };

      // 优先使用自定义消息类型发送 P2P 消息
      let result;
      if (this.rongcloudClient.ServiceChatMessage && msgType.includes('service')) {
        // 客服相关消息使用 service_chat 自定义消息类型
        // 对于客服消息，直接将业务内容放在顶层，方便前端解析
        const serviceChatPayload = {
          msg_type: msgType,
          ...content,  // 展开业务内容（status, content, sessionId, userId 等）
          request_id: requestId || '',
          timestamp: Math.floor(Date.now() / 1000),
        };
        result = await this.rongcloudClient.sendCustomMessage(
          targetId,
          serviceChatPayload,
          1, // PRIVATE
          'service_chat'
        );
      } else if (this.rongcloudClient.SystemServiceMessage) {
        result = await this.rongcloudClient.sendCustomMessage(
          targetId,
          messagePayload,
          1 // PRIVATE
        );
      } else {
        // 回退到文本消息（兼容旧版本）
        result = await this.rongcloudClient.sendMessage(
          targetId,
          JSON.stringify(messagePayload),
          1 // PRIVATE
        );
      }

      return result;
    } catch (err) {
      this.log?.error(`[RongyunMessageSender] P2P发送异常: ${err.message}`);
      return false;
    }
  }

  /**
   * 发送设备控制结果（P2P）
   */
  async sendDeviceControlResult(targetId, requestId, command, status, message, data) {
    return await this.sendToTarget(
      targetId,
      RongyunMessageTypeEnum.DEVICE_CONTROL_RESULT,
      {
        command,
        status,
        message,
        data
      },
      requestId
    );
  }

  /**
   * 发送设备状态报告（P2P）
   */
  async sendDeviceStatusReport(targetId, requestId, data, error) {
    return await this.sendToTarget(
      targetId,
      RongyunMessageTypeEnum.DEVICE_STATUS_REPORT,
      {
        status: error ? 'error' : 'success',
        message: error || '状态报告',
        data
      },
      requestId
    );
  }
}

module.exports = {
  RongyunMessageSender
};
