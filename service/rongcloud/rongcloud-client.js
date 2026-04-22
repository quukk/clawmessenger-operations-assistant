"use strict";
require("./env-polyfill");

const RongIMLibModule = require("@rongcloud/imlib-next");
const RongIMLib = RongIMLibModule.default || RongIMLibModule;

const { getMacAddress } = require('../modules/mac-address');
const { generateSecret } = require('../modules/auth');

const ConversationType = {
  PRIVATE: 1,
  GROUP: 3
};

const SYSTEM_MSG_TYPES = new Set([
  'client_connected',
  'client_disconnected',
  'heartbeat',
  'heartbeat_ack',
  'dashboard_report',
  'dashboard_report_ack',
  'dashboard_sessions',
  'dashboard_jobs',
  'dashboard_projects',
  'dashboard_summaries',
  'dashboard_sessions_contexts',
  'dashboard_usage_events',
  'command',
  'command_result',
  'chat_message',
  'create_opencode_session',
  'opencode_session_created',
  'delete_opencode_session'
]);

class RongCloudClient {
  constructor(config, log) {
    this.config = config;
    this.log = log;
    this.isConnected = false;
    this.handler = null;
    this.processingQueue = Promise.resolve();
  }

  async connect(handler) {
    this.handler = handler;
    this.log?.info('[RongCloudClient] 开始连接融云...');

    if (!RongIMLib || typeof RongIMLib.init !== 'function') {
      this.log?.error('[RongCloudClient] SDK 未正确加载');
      return false;
    }

    this.log?.info('[RongCloudClient] 初始化 SDK...');
    RongIMLib.init({ appkey: this.config.appKey });

    this.log?.info(`[RongCloudClient] SDK Events: ${JSON.stringify(Object.keys(RongIMLib.Events || {}))}`);
    this.log?.info(`[RongCloudClient] has addEventListener: ${typeof RongIMLib.addEventListener === 'function'}`);

    if (RongIMLib.addEventListener) {
      this.log?.info('[RongCloudClient] 使用 addEventListener 模式');
      
      RongIMLib.addEventListener(RongIMLib.Events?.MESSAGES || 'MESSAGES', (event) => {
        this.log?.info(`[RongCloudClient] 收到消息事件: ${JSON.stringify(event).substring(0, 200)}`);
        event.messages?.forEach(msg => {
          this.log?.info(`[RongCloudClient] 消息详情: messageType=${msg.messageType}, senderUserId=${msg.senderUserId}`);
          this.handleReceivedMessage(msg);
        });
      });

      RongIMLib.addEventListener(RongIMLib.Events?.CONNECTED || 'CONNECTED', () => {
        this.log?.info('[RongCloudClient] 连接成功事件');
        this.isConnected = true;
      });

      RongIMLib.addEventListener(RongIMLib.Events?.DISCONNECT || 'DISCONNECT', (code) => {
        this.log?.warn(`[RongCloudClient] 断开连接, code: ${code}`);
        this.isConnected = false;
      });
    } else {
      this.log?.info('[RongCloudClient] 使用 setOnReceiveMessageListener 模式');
      
      RongIMLib.setConnectionStatusListener({
        onChanged: (status) => {
          this.log?.info(`[RongCloudClient] 连接状态变化: ${status}`);
          this.isConnected = status === 3 || status === 'Connected';
        }
      });

      RongIMLib.setOnReceiveMessageListener({
        onReceived: (message) => {
          this.log?.info(`[RongCloudClient] onReceived: messageType=${message.messageType}, senderUserId=${message.senderUserId}`);
          this.handleReceivedMessage(message);
        }
      });
    }

    try {
      this.log?.info('[RongCloudClient] 正在连接...');
      const result = await RongIMLib.connect(this.config.token);
      this.log?.info(`[RongCloudClient] connect 结果: code=${result.code}`);

      if (result.code === 0 || result.code === 200) {
        const userId = result.data?.userId || 'unknown';
        this.log?.info(`[RongCloudClient] 登录成功, userId: ${userId}`);
        this.isConnected = true;
        return true;
      } else {
        this.log?.error(`[RongCloudClient] 登录失败, code: ${result.code}`);
        return false;
      }
    } catch (err) {
      this.log?.error(`[RongCloudClient] 连接异常: ${err.message}`);
      return false;
    }
  }

  handleReceivedMessage(message) {
    try {
      const msgType = message.messageType;
      const content = message.content?.content || message.content || '';

      this.log?.info(`[RongCloudClient] 收到消息: type=${msgType}, from=${message.senderUserId}`);

      if (!content || !content.trim()) {
        return;
      }

      let parsed = null;
      try {
        parsed = JSON.parse(content);
      } catch {}

      if (parsed && parsed.msg_type) {
        if (SYSTEM_MSG_TYPES.has(parsed.msg_type)) {
          return;
        }
        if (parsed.source_im_id === this.config.accountId) {
          return;
        }
        // 检测到结构化消息，路由到结构化消息处理器
        this.processStructuredMessage(message);
        return;
      }

      const userContent = parsed
        ? (parsed.content || parsed.text || JSON.stringify(parsed))
        : content;

      if (!userContent || !userContent.trim()) {
        return;
      }

      const senderUserId = parsed?.source_im_id || message.senderUserId || 'unknown';

      const rongCloudMsg = {
        senderUserId,
        targetId: message.targetId || senderUserId,
        conversationType: message.conversationType || ConversationType.PRIVATE,
        content: userContent,
        messageType: msgType || 'RC:TxtMsg',
        isOffLineMessage: message.isOffLineMessage || false,
        messageUId: message.messageUId || `local-${Date.now()}`,
        sentTime: message.sentTime || Date.now()
      };

      this.processingQueue = this.processingQueue.then(async () => {
        if (this.handler) {
          await this.handler.handleMessage(rongCloudMsg);
        }
      }).catch(err => {
        this.log?.error(`[RongCloudClient] 消息处理异常: ${err.message}`);
      });
    } catch (err) {
      this.log?.error(`[RongCloudClient] 解析消息失败: ${err.message}`);
    }
  }

  async sendMessage(targetId, content, conversationType) {
    if (!this.isConnected) {
      this.log?.error('[RongCloudClient] 未连接，无法发送消息');
      return false;
    }

    try {
      const convType = conversationType === ConversationType.GROUP
        ? (RongIMLib.ConversationType?.GROUP || ConversationType.GROUP)
        : (RongIMLib.ConversationType?.PRIVATE || ConversationType.PRIVATE);

      this.log?.info(`[RongCloudClient] 发送消息 -> ${targetId} (Type: ${convType}): ${content.substring(0, 50)}`);

      const result = await RongIMLib.sendTextMessage(
        { conversationType: convType, targetId },
        { content }
      );

      this.log?.info(`[RongCloudClient] 发送结果: code=${result.code}`);

      if (result.code === 0 || result.code === 200) {
        this.log?.info(`[RongCloudClient] 发送成功, messageUId: ${result.data?.messageUId}`);
        return true;
      } else {
        this.log?.error(`[RongCloudClient] 发送失败, code: ${result.code}`);
        return false;
      }
    } catch (err) {
      this.log?.error(`[RongCloudClient] 发送异常: ${err.message}`);
      return false;
    }
  }

  async disconnect() {
    this.log?.info('[RongCloudClient] 断开连接...');
    this.isConnected = false;
    try {
      await RongIMLib.disconnect();
      this.log?.info('[RongCloudClient] 已断开');
    } catch (err) {
      this.log?.error(`[RongCloudClient] 断开异常: ${err.message}`);
    }
  }

  async sendStructuredMessage(msgType, content, requestId) {
    if (!this.isConnected) {
      this.log?.error('[RongCloudClient] 未连接，无法发送消息');
      return false;
    }

    try {
      const mac = getMacAddress();
      const secret = generateSecret(mac, this.config.secretKey);

      const messagePayload = {
        msg_type: msgType,
        source_im_id: this.config.accountId,
        destination_im_id: 'guardserver',
        mac: mac,
        secret: secret,
        content: JSON.stringify(content),
        request_id: requestId || '',
        timestamp: Math.floor(Date.now() / 1000)
      };

      const result = await RongIMLib.sendTextMessage(
        {
          conversationType: RongIMLib.ConversationType?.PRIVATE || 1,
          targetId: 'guardserver'
        },
        { content: JSON.stringify(messagePayload) }
      );

      return result.code === 0 || result.code === 200;
    } catch (err) {
      this.log?.error(`[RongCloudClient] 发送异常: ${err.message}`);
      return false;
    }
  }

  processStructuredMessage(message) {
    try {
      const content = message.content?.content || message.content || '';
      let parsed = null;

      try {
        parsed = JSON.parse(content);
      } catch {
        this.log?.warn('[RongCloudClient] 无法解析结构化消息');
        return false;
      }

      if (!parsed || !parsed.msg_type) {
        this.log?.warn('[RongCloudClient] 消息缺少 msg_type 字段');
        return false;
      }

      const structuredMsg = {
        msgType: parsed.msg_type,
        sourceImId: parsed.source_im_id || message.senderUserId || 'unknown',
        destinationImId: parsed.destination_im_id || 'guardserver',
        mac: parsed.mac || '',
        secret: parsed.secret || '',
        content: parsed.content || '',
        requestId: parsed.request_id || '',
        timestamp: parsed.timestamp || Math.floor(Date.now() / 1000),
        senderUserId: message.senderUserId || 'unknown',
        targetId: message.targetId || 'guardserver',
        conversationType: message.conversationType || ConversationType.PRIVATE,
        messageUId: message.messageUId || `local-${Date.now()}`,
        sentTime: message.sentTime || Date.now()
      };

      this.processingQueue = this.processingQueue.then(async () => {
        if (this.handler && this.handler.handleStructuredMessage) {
          await this.handler.handleStructuredMessage(structuredMsg);
        } else {
          this.log?.warn('[RongCloudClient] 处理器未设置或不支持结构化消息');
        }
      }).catch(err => {
        this.log?.error(`[RongCloudClient] 结构化消息处理异常: ${err.message}`);
      });

      return true;
    } catch (err) {
      this.log?.error(`[RongCloudClient] 处理结构化消息失败: ${err.message}`);
      return false;
    }
  }
}

module.exports = { RongCloudClient, ConversationType };