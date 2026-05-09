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
    this.processedMessageUIds = new Set();
    this.messageDedupMaxSize = 1000;
    // 发送侧短期缓存：防止融云 SDK 回传自己发送的消息导致机器人自言自语
    this.sentMessageUIds = new Set();
    this.sentMessageDedupMaxSize = 100;
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

    // 优先使用新版 addEventListener；与旧版 setOnReceiveMessageListener 互斥
    // 避免同时注册导致 SDK 内部回调冲突或覆盖
    if (RongIMLib.addEventListener) {
      this.log?.info('[RongCloudClient] 使用 addEventListener 模式');

      RongIMLib.addEventListener(RongIMLib.Events?.MESSAGES || 'MESSAGES', (event) => {
        this.log?.info(`[RongCloudClient] MESSAGES 事件触发, messages长度=${event?.messages?.length || 0}`);
        event.messages?.forEach(msg => {
          this.log?.info(`[RongCloudClient] MESSAGES 单条消息: messageType=${msg.messageType}, senderUserId=${msg.senderUserId}, conversationType=${msg.conversationType}, isOffLineMessage=${msg.isOffLineMessage}, messageDirection=${msg.messageDirection}`);
          this.handleReceivedMessage(msg);
        });
      });

      // 调试：监听消息被拦截事件
      RongIMLib.addEventListener(RongIMLib.Events?.MESSAGE_BLOCKED || 'MESSAGE_BLOCKED', (data) => {
        this.log?.warn(`[RongCloudClient] 消息被拦截: ${JSON.stringify(data).substring(0, 200)}`);
      });

      RongIMLib.addEventListener(RongIMLib.Events?.CONNECTED || 'CONNECTED', () => {
        this.log?.info('[RongCloudClient] 连接成功事件');
        this.isConnected = true;
      });

      RongIMLib.addEventListener(RongIMLib.Events?.DISCONNECT || 'DISCONNECT', (code) => {
        this.log?.warn(`[RongCloudClient] 断开连接, code: ${code}`);
        this.isConnected = false;
      });
    } else if (RongIMLib.setOnReceiveMessageListener) {
      this.log?.info('[RongCloudClient] 使用 setOnReceiveMessageListener 模式');
      RongIMLib.setConnectionStatusListener({
        onChanged: (status) => {
          this.log?.info(`[RongCloudClient] 连接状态变化: ${status}`);
          this.isConnected = status === 3 || status === 'Connected';
        }
      });

      RongIMLib.setOnReceiveMessageListener({
        onReceived: (message) => {
          this.log?.info(`[RongCloudClient] onReceived: messageType=${message.messageType}, senderUserId=${message.senderUserId}, conversationType=${message.conversationType}, isOffLineMessage=${message.isOffLineMessage}, messageDirection=${message.messageDirection}`);
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
    // 最外层日志：确保任何消息到达都能留下痕迹（在过滤之前）
    this.log?.info(`[RongCloudClient] handleReceivedMessage 入口: messageType=${message.messageType}, senderUserId=${message.senderUserId}, conversationType=${message.conversationType}, isOffLineMessage=${message.isOffLineMessage}, messageDirection=${message.messageDirection}, messageUId=${message.messageUId}`);

    // 1. 过滤离线消息：离线消息是历史记录，不需要重复处理
    if (message.isOffLineMessage) {
      this.log?.info('[RongCloudClient] 收到离线消息，忽略');
      return;
    }

    // 2. 过滤自己发送的消息（融云 SDK 可能将发送消息回传）
    // messageDirection: 1=发送, 2=接收
    if (message.messageDirection === 1) {
      this.log?.info('[RongCloudClient] 过滤自己发送的消息 (messageDirection=1)');
      return;
    }
    if (message.senderUserId === this.config.accountId) {
      this.log?.info(`[RongCloudClient] 过滤自己发送的消息 (senderUserId=${message.senderUserId} === accountId=${this.config.accountId})`);
      return;
    }

    // 2.5 通过发送缓存过滤：融云 SDK 回传自己消息时，messageDirection/senderUserId 可能不一致
    if (message.messageUId && this.sentMessageUIds.has(message.messageUId)) {
      this.log?.info(`[RongCloudClient] 过滤自己发送的消息 (messageUId=${message.messageUId} 在发送缓存中)`);
      return;
    }

    // 3. 消息去重：防止同一条消息被多次触发（融云重推或多端同步）
    const dedupKey = message.messageUId || `${message.senderUserId}-${message.sentTime}-${message.messageType}`;
    if (this.processedMessageUIds.has(dedupKey)) {
      this.log?.info(`[RongCloudClient] 消息去重过滤: dedupKey=${dedupKey}`);
      return;
    }
    this.processedMessageUIds.add(dedupKey);
    if (this.processedMessageUIds.size > this.messageDedupMaxSize) {
      const first = this.processedMessageUIds.values().next().value;
      this.processedMessageUIds.delete(first);
    }

    try {
      const msgType = message.messageType;
      let rawContent = message.content;
      // 融云 SDK 中 mentionedInfo 通常在消息根级别
      let mentionedInfo = message.mentionedInfo || null;

      // 自定义消息 content 可能是对象，提取文本内容并保留 mentionedInfo
      if (rawContent && typeof rawContent === 'object') {
        mentionedInfo = mentionedInfo || rawContent.mentionedInfo || null;
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
        sentTime: message.sentTime || Date.now(),
        mentionedInfo
      };

      // 并行处理消息，不等待上一条完成（避免 openclaw 长耗时调用阻塞后续消息）
      if (this.handler) {
        this.handler.handleMessage(rongCloudMsg).catch(err => {
          this.log?.error(`[RongCloudClient] 消息处理异常: ${err.message}`);
        });
      }
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
        const sentUId = result.data?.messageUId;
        this.log?.info(`[RongCloudClient] 发送成功, messageUId: ${sentUId}`);
        // 将发送成功的 messageUId 加入短期缓存，用于过滤 SDK 回传的自己消息
        if (sentUId) {
          this.sentMessageUIds.add(sentUId);
          if (this.sentMessageUIds.size > this.sentMessageDedupMaxSize) {
            const first = this.sentMessageUIds.values().next().value;
            this.sentMessageUIds.delete(first);
          }
        }
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