/**
 * SkillRouter 单元测试（纯 Node.js assert，无需 jest）
 */
const assert = require('assert');
const { BaseSkill } = require('../../service/skills/base-skill');
const { SkillRouter } = require('../../service/skills/skill-router');

class HighPrioritySkill extends BaseSkill {
  constructor(options) {
    super({ ...options, priority: 10 });
    this.handled = false;
  }
  match(ctx) {
    if (ctx.content === 'test') return { score: 100 };
    return false;
  }
  async handle() {
    this.handled = true;
  }
}

class LowPrioritySkill extends BaseSkill {
  constructor(options) {
    super({ ...options, priority: 5 });
    this.handled = false;
  }
  match(ctx) {
    if (ctx.content === 'test') return { score: 50 };
    return false;
  }
  async handle() {
    this.handled = true;
  }
}

class NoMatchSkill extends BaseSkill {
  match() { return false; }
  async handle() { throw new Error('should not be called'); }
}

class FallbackSkill extends BaseSkill {
  constructor(options) {
    super(options);
    this.handled = false;
  }
  match() { return false; }
  async handle() {
    this.handled = true;
  }
}

async function run() {
  const logs = [];
  const mockLog = {
    info: (msg) => logs.push(msg),
    warn: (msg) => logs.push(msg),
    error: (msg) => logs.push(msg),
    debug: () => {},
  };

  // 1. 测试高优先级 skill 胜出
  const high = new HighPrioritySkill({ name: 'high', log: mockLog });
  const low = new LowPrioritySkill({ name: 'low', log: mockLog });
  const router = new SkillRouter([high, low], mockLog);

  await router.route({ content: 'test' });
  assert.strictEqual(high.handled, true, '高优先级 skill 应被处理');
  assert.strictEqual(low.handled, false, '低优先级 skill 不应被处理');

  // 2. 测试无匹配时 fallback
  const fallback = new FallbackSkill({ name: 'fallback', log: mockLog });
  const noMatch = new NoMatchSkill({ name: 'noMatch', log: mockLog });
  const router2 = new SkillRouter([noMatch], mockLog);
  router2.setFallbackSkill(fallback);

  await router2.route({ content: 'unknown' });
  assert.strictEqual(fallback.handled, true, 'fallback skill 应被处理');

  // 3. 测试空 skill 列表且无 fallback
  const router3 = new SkillRouter([], mockLog);
  await router3.route({ content: 'unknown' }); // 不应抛错

  console.log('✓ SkillRouter tests passed');
}

run().catch((err) => {
  console.error('✗ SkillRouter tests failed:', err);
  process.exit(1);
});
