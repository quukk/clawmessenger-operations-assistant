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
   * 与 openclaw-clawmessenger 对齐的 card_message 格式
   *
   * @param {string} targetId - 目标用户/会话 ID
   * @param {Object} cardData - 卡片数据
   * @param {number} [conversationType=1] - 会话类型
   * @returns {Promise<boolean>}
   */
  async sendCard(targetId, cardData, conversationType = 1) {
    if (!this.messageSender) {
      throw new Error(`Skill ${this.name}: messageSender not injected`);
    }
    this.log.info(`[BaseSkill.sendCard] skill=${this.name}, targetId=${targetId}, card_id=${cardData?.card_id}, template=${cardData?.template}`);
    return this.messageSender.sendCardMessage(targetId, cardData, conversationType);
  }
}

module.exports = { BaseSkill };
