/**
 * 回声助手 Skill（示例）
 *
 * 用于验证 Skill 框架的可扩展性。
 * 匹配 /echo 前缀的消息，直接原样返回。
 */
const { BaseSkill } = require('../base-skill');
const { RongyunMessageTypeEnum } = require('../../modules/rongyun-message-types');

class EchoAssistantSkill extends BaseSkill {
  constructor(options) {
    super({
      ...options,
      displayName: options.displayName || '回声助手',
      priority: options.priority || 20,
    });
  }

  async init() {
    this.log.info('[EchoAssistant] Initialized');
  }

  async destroy() {
    this.log.info('[EchoAssistant] Destroyed');
  }

  getResponseMsgType() {
    return RongyunMessageTypeEnum.SERVICE_CHAT_RESPONSE;
  }

  match(messageContext) {
    const { content } = messageContext;
    if (typeof content === 'string' && content.trim().startsWith('/echo')) {
      return { score: 100, reason: 'echo_command' };
    }
    return false;
  }

  async handle(messageContext, matchResult) {
    const { senderUserId, targetId, data } = messageContext;
    const requestId = data && data.request_id;

    let content = '';
    if (data && typeof data.content === 'string') {
      content = data.content;
    } else if (typeof messageContext.content === 'string') {
      content = messageContext.content;
    }

    // 去掉 /echo 前缀
    const reply = content.replace(/^\s*\/echo\s*/, '').trim() || '（空消息）';

    this.log.info(`[EchoAssistant] Echo from ${senderUserId}: ${reply}`);

    await this.sendReply(targetId || senderUserId, {
      status: 'success',
      content: reply,
      request_id: requestId,
      node_id: this.config.accountId,
    }, requestId);
  }
}

module.exports = { EchoAssistantSkill };
