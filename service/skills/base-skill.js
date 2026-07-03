/**
 * Skill 抽象基类
 *
 * 所有 skill 必须继承此类，并实现 match() 与 handle()。
 * Skill 框架通过 SkillLoader 扫描 service/skills/ 下的子目录并实例化。
 */
class BaseSkill {
  /**
   * @param {Object} options
   * @param {string} options.name - skill 唯一标识（目录名）
   * @param {string} [options.displayName] - 展示名称
   * @param {number} [options.priority=0] - 静态优先级，数字越大越优先
   * @param {Object} [options.config={}] - 全局配置注入
   * @param {Object} [options.log] - 日志对象（需包含 info/warn/error 方法）
   */
  constructor(options) {
    if (!options || !options.name) {
      throw new Error('Skill name is required');
    }
    this.name = options.name;
    this.displayName = options.displayName || options.name;
    this.priority = options.priority || 0;
    this.config = options.config || {};
    this.log = options.log || console;

    // 由 SkillLoader 在加载完成后注入
    this.messageSender = null;
  }

  /**
   * 判断该 skill 是否匹配当前消息
   *
   * @param {Object} messageContext
   * @param {string} messageContext.msgType - 消息类型（如 ops_chat_message）
   * @param {string|Object} messageContext.content - 消息内容
   * @param {string} messageContext.senderUserId - 发送者 ID
   * @param {string} messageContext.targetId - 目标会话 ID
   * @param {number} messageContext.conversationType - 会话类型（单聊/群聊）
   * @param {Object} messageContext.data - 完整解析后的结构化消息数据
   * @returns {boolean|Object} false 表示不匹配；返回对象时建议携带 score（数字）和 reason（字符串）
   */
  match(messageContext) {
    throw new Error(`Skill ${this.name} must implement match()`);
  }

  /**
   * 处理匹配到的消息
   *
   * @param {Object} messageContext
   * @param {Object} matchResult - match() 的返回值
   * @returns {Promise<void>}
   */
  async handle(messageContext, matchResult) {
    throw new Error(`Skill ${this.name} must implement handle()`);
  }

  /**
   * 初始化 skill（加载 prompt、初始化 runner 等）
   * @returns {Promise<void>}
   */
  async init() {
    // 子类可覆盖
  }

  /**
   * 销毁 skill（清理 session、定时器等）
   * @returns {Promise<void>}
   */
  async destroy() {
    // 子类可覆盖
  }

  /**
   * 获取该 skill 的 system prompt
   * @returns {string|null}
   */
  getSystemPrompt() {
    return null;
  }

  /**
   * 获取该 skill 回复时使用的 msg_type
   * @returns {string}
   */
  getResponseMsgType() {
    return 'chat_message';
  }

  /**
   * 发送回复消息（需要 messageSender 已注入）
   *
   * @param {string} targetId - 目标用户/会话 ID
   * @param {Object|string} content - 回复内容
   * @param {string} [requestId] - 请求 ID
   */
  async sendReply(targetId, content, requestId) {
    if (!this.messageSender) {
      throw new Error(`Skill ${this.name}: messageSender not injected`);
    }
    return this.messageSender.sendToTarget(
      targetId,
      this.getResponseMsgType(),
      content,
      requestId
    );
  }

  /**
   * 发送普通文本消息（需要 messageSender 已注入）
   *
   * @param {string} targetId - 目标用户/会话 ID
   * @param {string} text - 文本内容
   * @param {number} [conversationType=1] - 会话类型
   */
  async sendText(targetId, text, conversationType = 1) {
    if (!this.messageSender) {
      throw new Error(`Skill ${this.name}: messageSender not injected`);
    }
    if (!this.messageSender.rongcloudClient) {
      throw new Error(`Skill ${this.name}: rongcloudClient not available`);
    }
    return this.messageSender.rongcloudClient.sendMessage(targetId, text, conversationType);
  }

  /**
   * 发送卡片消息（需要 messageSender 已注入）
   * 与 CardKit 规范对齐：接受 CardModel
   *   {schema:'1.0.0', id, header:{title,...}, sections:[...], config:{...}}
   * 透传至 messageSender.sendCardMessage。
   *
   * B4:删除 v3 兼容期,cardData 必须是规范 CardModel(用 id 字段)。
   *
   * @param {string} targetId - 目标用户/会话 ID
   * @param {Object} cardData - CardModel(规范)
   * @param {number} [conversationType=1] - 会话类型
   * @returns {Promise<boolean>}
   */
  async sendCard(targetId, cardData, conversationType = 1) {
    if (!this.messageSender) {
      throw new Error(`Skill ${this.name}: messageSender not injected`);
    }
    this.log.info(`[BaseSkill.sendCard] skill=${this.name}, targetId=${targetId}, card_id=${cardData?.id || 'unknown'}`);
    return this.messageSender.sendCardMessage(targetId, cardData, conversationType);
  }

  /**
   * 发送卡片增量更新消息(card_update),用于分批流式推送。
   *
   * 首卡通过 sendCard 发出,后续批次用本方法发 card_update,小程序按 cardId 累积追加。
   *
   * @param {string} targetId - 目标用户/会话 ID
   * @param {string} cardId - 首卡 ID(必须与首卡一致)
   * @param {Object} appendData - { appendCommands?: [], appendSessions?: [] }
   * @param {number} [conversationType=1] - 会话类型
   * @returns {Promise<boolean>}
   */
  async sendCardUpdate(targetId, cardId, appendData, conversationType = 1) {
    if (!this.messageSender) {
      throw new Error(`Skill ${this.name}: messageSender not injected`);
    }
    if (typeof this.messageSender.sendCardUpdate !== 'function') {
      this.log.warn(`[BaseSkill.sendCardUpdate] messageSender.sendCardUpdate 不存在,跳过分批推送`);
      return false;
    }
    return this.messageSender.sendCardUpdate(targetId, cardId, appendData, conversationType);
  }

  /**
   * 分批流式追加卡片内容(card_update)。
   *
   * 用于解决融云单条 card_message ~7KB 体积上限:首卡已通过 sendCard 发出(调用方自建),
   * 本方法把 allItems 中 [batchSize, end) 的剩余项分批通过 card_update 增量推送,
   * 小程序按 cardId 找到原卡片并将 appendCommands / appendSessions 累积追加到对应 section。
   *
   * fire-and-forget:本方法返回后后台异步推送(不阻塞调用方),每批间隔 SLEEP_MS 防止融云限流。
   * 仅当剩余项 > 0 时启动后台循环;否则立即返回已 resolved 的 Promise(no-op)。
   *
   * @param {Object} opts
   * @param {string} opts.targetId
   * @param {number} opts.convType - 会话类型
   * @param {string} opts.cardId - 首卡 ID(必须与首卡一致)
   * @param {Array} opts.allItems - 完整数据项数组(含首批)
   * @param {number} [opts.batchSize=50] - 首批/每批大小(剩余项从 index=batchSize 开始)
   * @param {number} [opts.sleepMs=300] - 批次间隔
   * @param {Function} opts.buildAppendData - (batchItems) => card_update 的 appendData 对象
   * @returns {Promise<void>} 立即 resolve(后台推送不阻塞)
   */
  _streamRemainingBatches({
    targetId, convType, cardId, allItems,
    batchSize = 50, sleepMs = 300, buildAppendData,
  }) {
    const restCount = Math.max(0, allItems.length - batchSize);
    if (restCount <= 0) return Promise.resolve();

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    (async () => {
      for (let i = batchSize; i < allItems.length; i += batchSize) {
        const batch = allItems.slice(i, i + batchSize);
        try {
          await this.sendCardUpdate(targetId, cardId, buildAppendData(batch), convType);
        } catch (err) {
          this.log.warn(`[BaseSkill._streamRemainingBatches] 批次 i=${i} 发送失败: ${err.message}`);
        }
        if (i + batchSize < allItems.length) {
          await sleep(sleepMs);
        }
      }
    })().catch((err) => {
      this.log.warn(`[BaseSkill._streamRemainingBatches] 后台分批推送异常: ${err.message}`);
    });
    return Promise.resolve();
  }
}

module.exports = { BaseSkill };
