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
    // 自定义消息构造函数占位（connect 中注册后填充）
    this.commandCtor = null;
    this.commandResultCtor = null;
    this.cardMessageCtor = null;
    this.cardUpdateCtor = null;
    this.serviceChatCtor = null;
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

    // 注册 command 自定义消息类型（与前端对齐）
    try {
      if (typeof RongIMLib.registerMessageType === 'function') {
        this.SystemServiceMessage = RongIMLib.registerMessageType('command', false, false);
        this.log?.info('[RongCloudClient] command 自定义消息类型已注册');

        // 注册 service_chat 自定义消息类型（客服消息）
        this.ServiceChatMessage = RongIMLib.registerMessageType('service_chat', false, false);
        this.log?.info('[RongCloudClient] service_chat 自定义消息类型已注册');

        // 注册 card_message 自定义消息类型（卡片消息，存储+计数）
        this.CardMessage = RongIMLib.registerMessageType('card_message', true, true);
        this.log?.info('[RongCloudClient] card_message 自定义消息类型已注册');

        // 兜底：Node polyfill 环境下 registerMessageType 可能返回 undefined
        if (!this.CardMessage && RongIMLib.MessageType && RongIMLib.MessageType.card_message) {
          this.CardMessage = RongIMLib.MessageType.card_message;
          this.log?.info('[RongCloudClient] card_message 从 MessageType.card_message 兜底获取');
        }

        this.log?.info(`[RongCloudClient] CardMessage type: ${typeof this.CardMessage}, isFunction: ${typeof this.CardMessage === 'function'}`);

        // B1: CardKit 相关自定义消息类型注册
        // 对齐 opencode-clawmessenger/src/rongcloud/card-transport.ts 的传输约定。
        //   - card_update: 卡片更新(本地替换),持久化+计数(与 card_message 一致,允许离线补发)
        //   - card_action: 按钮点击回传(小程序→插件),非持久化、不计数(瞬时交互,无需漫游)
        //   - command_result: 按钮处理确认 / 流式 delta 载体,非持久化、不计数(已有白名单但此前未注册为自定义类型)
        this.CardUpdate = RongIMLib.registerMessageType('card_update', true, true);
        this.log?.info('[RongCloudClient] card_update 自定义消息类型已注册');

        this.CardAction = RongIMLib.registerMessageType('card_action', false, false);
        this.log?.info('[RongCloudClient] card_action 自定义消息类型已注册');

        this.CommandResult = RongIMLib.registerMessageType('command_result', false, false);
        this.log?.info('[RongCloudClient] command_result 自定义消息类型已注册');
      } else {
        this.log?.warn('[RongCloudClient] SDK 不支持 registerMessageType');
      }
    } catch (err) {
      this.log?.warn(`[RongCloudClient] 注册自定义消息类型失败: ${err.message}`);
    }

    // 同步自定义消息构造函数到统一属性名（供 sendMessage 路由使用）
    this.commandCtor = this.SystemServiceMessage || null;
    this.commandResultCtor = this.CommandResult || null;
    this.cardMessageCtor = this.CardMessage || null;
    this.cardUpdateCtor = this.CardUpdate || null;
    this.serviceChatCtor = this.ServiceChatMessage || null;

    // 兜底：Node polyfill 环境下 registerMessageType 可能返回 undefined
    if (!this.commandCtor && RongIMLib.MessageType && RongIMLib.MessageType.command) {
      this.commandCtor = RongIMLib.MessageType.command;
      this.log?.info('[RongCloudClient] command 从 MessageType.command 兜底获取');
    }
    if (!this.commandResultCtor && RongIMLib.MessageType && RongIMLib.MessageType.command_result) {
      this.commandResultCtor = RongIMLib.MessageType.command_result;
      this.log?.info('[RongCloudClient] command_result 从 MessageType.command_result 兜底获取');
    }
    if (!this.cardMessageCtor && RongIMLib.MessageType && RongIMLib.MessageType.card_message) {
      this.cardMessageCtor = RongIMLib.MessageType.card_message;
      this.log?.info('[RongCloudClient] card_message 从 MessageType.card_message 兜底获取');
    }
    if (!this.cardUpdateCtor && RongIMLib.MessageType && RongIMLib.MessageType.card_update) {
      this.cardUpdateCtor = RongIMLib.MessageType.card_update;
      this.log?.info('[RongCloudClient] card_update 从 MessageType.card_update 兜底获取');
    }
    if (!this.serviceChatCtor && RongIMLib.MessageType && RongIMLib.MessageType.service_chat) {
      this.serviceChatCtor = RongIMLib.MessageType.service_chat;
      this.log?.info('[RongCloudClient] service_chat 从 MessageType.service_chat 兜底获取');
    }

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
          this.log?.debug(`[RongCloudClient] MESSAGES 单条消息: messageType=${msg.messageType}, senderUserId=${msg.senderUserId}, conversationType=${msg.conversationType}, isOffLineMessage=${msg.isOffLineMessage}, messageDirection=${msg.messageDirection}`);
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
          this.log?.debug(`[RongCloudClient] onReceived: messageType=${message.messageType}, senderUserId=${message.senderUserId}, conversationType=${message.conversationType}, isOffLineMessage=${message.isOffLineMessage}, messageDirection=${message.messageDirection}`);
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
    // ============================================================
    // 过滤阶段：所有过滤判断提前到日志之前，命中即静默 return（仅 debug）
    // 这样离线消息风暴中 messageDirection===1 / 自发 / 已处理 的消息
    // 在生产 INFO 级别下完全不产生日志，避免淹没业务日志。
    // ============================================================

    // 1. 过滤自己发送的消息（融云 SDK 可能将发送消息回传）
    // messageDirection: 1=发送, 2=接收
    if (message.messageDirection === 1) {
      this.log?.debug('[RongCloudClient] 过滤自己发送的消息 (messageDirection=1)');
      return;
    }
    if (message.senderUserId === this.config.accountId) {
      this.log?.debug(`[RongCloudClient] 过滤自己发送的消息 (senderUserId=${message.senderUserId} === accountId=${this.config.accountId})`);
      return;
    }

    // 2. 通过发送缓存过滤：融云 SDK 回传自己消息时，messageDirection/senderUserId 可能不一致
    if (message.messageUId && this.sentMessageUIds.has(message.messageUId)) {
      this.log?.debug(`[RongCloudClient] 过滤自己发送的消息 (messageUId=${message.messageUId} 在发送缓存中)`);
      return;
    }

    // 3. 消息去重：防止同一条消息被多次触发（融云重推或多端同步）
    const dedupKey = message.messageUId || `${message.senderUserId}-${message.sentTime}-${message.messageType}`;
    if (this.processedMessageUIds.has(dedupKey)) {
      this.log?.debug(`[RongCloudClient] 消息去重过滤: dedupKey=${dedupKey}`);
      return;
    }

    // 过滤全部通过：此处之后才是真正进入业务处理的消息。
    // 入口 trace 降级为 debug（仅排查时使用），业务日志保持 INFO。
    this.log?.debug(`[RongCloudClient] handleReceivedMessage 入口: messageType=${message.messageType}, senderUserId=${message.senderUserId}, conversationType=${message.conversationType}, isOffLineMessage=${message.isOffLineMessage}, messageDirection=${message.messageDirection}, messageUId=${message.messageUId}`);

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
        // command 等结构化消息保留完整 JSON（上层需要 msg_type 等字段）
        if (message.messageType === 'command' || rawContent.msg_type) {
          rawContent = JSON.stringify(rawContent);
        } else if (['RC:ImgMsg', 'RC:SightMsg', 'RC:FileMsg', 'RC:HQVCMsg'].includes(message.messageType)) {
          // 媒体消息保留完整对象，以便上层提取 URL
          rawContent = JSON.stringify(rawContent);
        } else {
          rawContent = rawContent.content || rawContent.text || JSON.stringify(rawContent);
        }
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

      // 对于媒体消息，保留完整的 JSON 字符串，不要提取 content 字段
      const userContent = parsed && !parsed.msg_type
        ? (['RC:ImgMsg', 'RC:SightMsg', 'RC:FileMsg', 'RC:HQVCMsg'].includes(msgType)
            ? JSON.stringify(parsed)
            : (parsed.content || parsed.text || JSON.stringify(parsed)))
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

      // 检测已注册自定义消息类型：对齐自定义消息类型路由
      // card_message / card_update / command_result / command / service_chat
      // 均使用注册后的构造函数，content 序列化为 JSON 字符串后传入
      let messageContent = new RongIMLib.TextMessage({ content });
      try {
        const parsed = JSON.parse(content);
        if (parsed && parsed.msg_type) {
          const mt = parsed.msg_type;
          const contentStr = JSON.stringify(parsed);

          if (mt === 'card_message' && this.cardMessageCtor) {
            messageContent = new this.cardMessageCtor(contentStr);
            messageContent.messageType = 'card_message';
            this.log?.info(`[RongCloudClient] card_message 自定义消息对象已构造, objectName=${messageContent.objectName || '(empty)'}, messageType=${messageContent.messageType || '(empty)'}, has content=${!!messageContent.content}`);
          } else if (mt === 'card_update' && this.cardUpdateCtor) {
            messageContent = new this.cardUpdateCtor(contentStr);
            messageContent.messageType = 'card_update';
            this.log?.info(`[RongCloudClient] card_update 自定义消息对象已构造, objectName=${messageContent.objectName || '(empty)'}, messageType=${messageContent.messageType || '(empty)'}, has content=${!!messageContent.content}`);
          } else if (mt === 'command_result' && this.commandResultCtor) {
            messageContent = new this.commandResultCtor(contentStr);
            messageContent.messageType = 'command_result';
            this.log?.info(`[RongCloudClient] command_result 自定义消息对象已构造, objectName=${messageContent.objectName || '(empty)'}, messageType=${messageContent.messageType || '(empty)'}, has content=${!!messageContent.content}`);
          } else if (mt === 'command' && this.commandCtor) {
            messageContent = new this.commandCtor(contentStr);
            this.log?.info(`[RongCloudClient] command 自定义消息对象已构造, objectName=${messageContent.objectName || '(empty)'}, messageType=${messageContent.messageType || '(empty)'}, has content=${!!messageContent.content}`);
          } else if (mt === 'service_chat' && this.serviceChatCtor) {
            messageContent = new this.serviceChatCtor(contentStr);
            messageContent.messageType = 'service_chat';
            this.log?.info(`[RongCloudClient] service_chat 自定义消息对象已构造, objectName=${messageContent.objectName || '(empty)'}, messageType=${messageContent.messageType || '(empty)'}, has content=${!!messageContent.content}`);
          }
          // 非注册自定义消息(如未知 msg_type)或未识别类型保持 TextMessage fallback
        }
      } catch (_) { /* not JSON, use text */ }

      const result = await RongIMLib.sendMessage(
        { conversationType: convType, targetId },
        messageContent
      );

      // this.log?.info(`[RongCloudClient] 发送结果: code=${result.code}`);

      if (result.code === 0 || result.code === 200) {
        const sentUId = result.data?.messageUId;
        // this.log?.info(`[RongCloudClient] 发送成功, messageUId: ${sentUId}`);
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

  async sendCustomMessage(targetId, content, conversationType, customType = 'command') {
    if (!this.isConnected) {
      this.log?.error('[RongCloudClient] 未连接，无法发送自定义消息');
      return false;
    }

    // 根据消息类型选择对应的构造函数
    let MessageCtor = this.SystemServiceMessage;
    if (customType === 'service_chat') {
      MessageCtor = this.ServiceChatMessage;
    } else if (customType === 'card_message') {
      MessageCtor = this.CardMessage;
    }

    if (!MessageCtor) {
      this.log?.error(`[RongCloudClient] ${customType} 消息类型未注册`);
      return false;
    }

    try {
      const convType = conversationType === ConversationType.GROUP
        ? (RongIMLib.ConversationType?.GROUP || ConversationType.GROUP)
        : (RongIMLib.ConversationType?.PRIVATE || ConversationType.PRIVATE);

      const messageContent = typeof content === 'string' ? JSON.parse(content) : content;
      const customMsg = new MessageCtor(messageContent);

      const result = await RongIMLib.sendMessage(
        { conversationType: convType, targetId },
        customMsg
      );

      if (result.code === 0 || result.code === 200) {
        const sentUId = result.data?.messageUId;
        if (sentUId) {
          this.sentMessageUIds.add(sentUId);
          if (this.sentMessageUIds.size > this.sentMessageDedupMaxSize) {
            const first = this.sentMessageUIds.values().next().value;
            this.sentMessageUIds.delete(first);
          }
        }
        return true;
      } else {
        this.log?.error(`[RongCloudClient] 自定义消息发送失败, code: ${result.code}`);
        return false;
      }
    } catch (err) {
      this.log?.error(`[RongCloudClient] 发送自定义消息异常: ${err.message}`);
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