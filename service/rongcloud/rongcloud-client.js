"use strict";
require("./env-polyfill");

const RongIMLibModule = require("@rongcloud/imlib-next");
const RongIMLib = RongIMLibModule.default || RongIMLibModule;

const ConversationType = {
  PRIVATE: 1,
  GROUP: 3
};

const SYSTEM_MSG_TYPES = new Set([

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
    this.log?.info(`[RongCloudClient] has sendReadReceiptMessage: ${typeof RongIMLib.sendReadReceiptMessage === 'function'}`);
    this.log?.info(`[RongCloudClient] has sendReadReceiptResponseV2: ${typeof RongIMLib.sendReadReceiptResponseV2 === 'function'}`);
    this.log?.info(`[RongCloudClient] has sendReadReceiptResponseV5: ${typeof RongIMLib.sendReadReceiptResponseV5 === 'function'}`);

    if (RongIMLib.addEventListener) {
      this.log?.info('[RongCloudClient] 使用 addEventListener 模式');

      RongIMLib.addEventListener(RongIMLib.Events?.MESSAGES || 'MESSAGES', (event) => {
        this.log?.info(`[RongCloudClient] 收到消息事件: ${JSON.stringify(event).substring(0, 200)}`);
        event.messages?.forEach(msg => {
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
    if (message.isOffLineMessage) {
      return;
    }

    try {
      const msgType = message.messageType;
      let rawContent = message.content;

      // 自定义消息 content 可能是对象，提取文本内容
      if (rawContent && typeof rawContent === 'object') {
        rawContent = rawContent.content || rawContent.text || JSON.stringify(rawContent);
      }

      const content = rawContent || '';

      this.log?.info(`[RongCloudClient] 收到消息: type=${msgType}, from=${message.senderUserId}`);

      if (!content || !content.trim || !content.trim()) {
        return;
      }

      let parsed = null;
      try {
        parsed = JSON.parse(content);
      } catch { }

      if (parsed && parsed.msg_type) {
        if (SYSTEM_MSG_TYPES.has(parsed.msg_type)) {
          return;
        }
        if (parsed.source_im_id === this.config.accountId) {
          return;
        }
      }

      const userContent = parsed && !parsed.msg_type
        ? (parsed.content || parsed.text || JSON.stringify(parsed))
        : content;

      if (!userContent || !userContent.trim || !userContent.trim()) {
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

      // this.log?.info(`[RongCloudClient] 发送结果: code=${result.code}`);

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

  async sendReadReceipt(msg) {
    if (!this.isConnected) {
      this.log?.warn('[RongCloudClient] 未连接，无法发送已读回执');
      return false;
    }

    const { conversationType, senderUserId, targetId, messageUId, sentTime } = msg;
    if (!messageUId || !sentTime) {
      this.log?.warn('[RongCloudClient] 消息缺少 messageUId 或 sentTime，无法发送已读回执');
      return false;
    }

    // 本地生成的 messageUId 无法发送已读回执
    if (String(messageUId).startsWith('local-')) {
      this.log?.warn('[RongCloudClient] messageUId 为本地生成，跳过已读回执');
      return false;
    }

    this.log?.info(`[RongCloudClient] 准备发送已读回执: conversationType=${conversationType}, senderUserId=${senderUserId}, targetId=${targetId}, messageUId=${messageUId}, sentTime=${sentTime}`);

    try {
      // 优先使用 V5 已读回执 API（与前端 enableReadV5 对齐）
      if (typeof RongIMLib.sendReadReceiptResponseV5 === 'function') {
        this.log?.info(`[RongCloudClient] 发送 V5 已读回执 -> targetId=${targetId}, messageUId=${messageUId}`);
        const result = await RongIMLib.sendReadReceiptResponseV5(
          { conversationType, targetId },
          [messageUId]
        );
        this.log?.info(`[RongCloudClient] V5 已读回执结果: code=${result.code}, msg=${result.msg || ''}`);
        return result.code === 0 || result.code === 200;
      }

      if (conversationType === ConversationType.GROUP) {
        if (typeof RongIMLib.sendReadReceiptResponseV2 !== 'function') {
          this.log?.warn('[RongCloudClient] SDK 不支持群聊已读回执');
          return false;
        }
        this.log?.info(`[RongCloudClient] 发送群聊已读回执 -> ${targetId}, messageUId=${messageUId}`);
        const result = await RongIMLib.sendReadReceiptResponseV2(targetId, {
          [senderUserId]: [messageUId]
        });
        this.log?.info(`[RongCloudClient] 群聊已读回执结果: code=${result.code}, msg=${result.msg || ''}`);
        return result.code === 0 || result.code === 200;
      } else {
        if (typeof RongIMLib.sendReadReceiptMessage !== 'function') {
          this.log?.warn('[RongCloudClient] SDK 不支持单聊已读回执');
          return false;
        }
        this.log?.info(`[RongCloudClient] 发送单聊已读回执 -> ${senderUserId}, messageUId=${messageUId}`);
        const result = await RongIMLib.sendReadReceiptMessage(senderUserId, messageUId, sentTime);
        this.log?.info(`[RongCloudClient] 单聊已读回执结果: code=${result.code}, msg=${result.msg || ''}`);
        return result.code === 0 || result.code === 200;
      }
    } catch (err) {
      this.log?.error(`[RongCloudClient] 发送已读回执异常: ${err.message}`);
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
}

module.exports = { RongCloudClient, ConversationType };