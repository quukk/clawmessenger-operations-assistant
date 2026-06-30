const { BaseSkill } = require('../../../../service/skills/base-skill');

class ValidSkill extends BaseSkill {
  constructor(options) {
    super({ ...options, priority: 10 });
  }

  match(ctx) {
    if (ctx.content === 'valid') {
      return { score: 100, reason: 'valid_keyword' };
    }
    return false;
  }

  async handle() {
    // test only
  }
}

module.exports = { ValidSkill };
