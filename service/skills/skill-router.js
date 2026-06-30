/**
 * Skill 消息路由器
 *
 * 让所有 skill 对消息进行 match，选择得分最高者执行；
 * 无匹配时使用 fallback skill（默认运维助手）。
 */
class SkillRouter {
  /**
   * @param {BaseSkill[]} skills - 已加载的 skill 列表
   * @param {Object} log - 日志对象
   */
  constructor(skills, log) {
    this.skills = skills || [];
    this.log = log || console;
    this.fallbackSkill = null;
  }

  /**
   * 设置兜底 skill
   * @param {BaseSkill} skill
   */
  setFallbackSkill(skill) {
    this.fallbackSkill = skill;
  }

  /**
   * 路由消息到匹配的 skill
   *
   * @param {Object} messageContext
   * @returns {Promise<void>}
   */
  async route(messageContext) {
    const matches = [];

    for (const skill of this.skills) {
      try {
        const result = skill.match(messageContext);
        if (result) {
          const normalizedResult = typeof result === 'object' ? result : { score: 1 };
          // 最终得分 = match 内部分数 + skill 静态优先级
          const finalScore = (normalizedResult.score || 0) + (skill.priority || 0);
          matches.push({
            skill,
            result: { ...normalizedResult, finalScore },
          });
        }
      } catch (err) {
        this.log.error(`[SkillRouter] Skill ${skill.name} match error: ${err.message}`);
      }
    }

    if (matches.length > 0) {
      // 按最终得分降序
      matches.sort((a, b) => b.result.finalScore - a.result.finalScore);
      const best = matches[0];
      this.log.info(
        `[SkillRouter] Message routed to skill: ${best.skill.name} ` +
          `(finalScore=${best.result.finalScore}, reason=${best.result.reason || 'unknown'})`
      );
      return best.skill.handle(messageContext, best.result);
    }

    if (this.fallbackSkill) {
      this.log.info(`[SkillRouter] No skill matched, using fallback: ${this.fallbackSkill.name}`);
      return this.fallbackSkill.handle(messageContext, { score: 0, reason: 'fallback' });
    }

    this.log.warn('[SkillRouter] No skill matched and no fallback configured');
  }
}

module.exports = { SkillRouter };
