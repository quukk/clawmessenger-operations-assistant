/**
 * SkillLoader 单元测试（纯 Node.js assert，无需 jest）
 */
const assert = require('assert');
const path = require('path');
const { SkillLoader } = require('../../service/skills/skill-loader');

async function run() {
  const fixtureDir = path.join(__dirname, 'fixtures');

  const logs = [];
  const mockLog = {
    info: (msg) => logs.push(`info:${msg}`),
    warn: (msg) => logs.push(`warn:${msg}`),
    error: (msg) => logs.push(`error:${msg}`),
    debug: () => {},
  };

  const loader = new SkillLoader(fixtureDir, mockLog);
  const skills = await loader.loadAll({ accountId: 'test-account' }, { sendToTarget: () => {} });

  assert.strictEqual(skills.length, 1, '应只加载一个有效 skill');
  assert.strictEqual(skills[0].name, 'valid-skill');
  assert.strictEqual(skills[0].priority, 10);
  assert.strictEqual(skills[0].messageSender !== null, true, 'messageSender 应被注入');

  // 验证 bad-skill 被跳过（有 warn 日志）
  const badLog = logs.find((l) => l.includes('bad-skill') && l.includes('does not extend BaseSkill'));
  assert.ok(badLog, '应记录 bad-skill 被跳过的警告');

  // 验证空目录被跳过（无 error）
  const emptyError = logs.find((l) => l.includes('empty-skill'));
  assert.ok(!emptyError, '空目录不应产生日志');

  console.log('✓ SkillLoader tests passed');
}

run().catch((err) => {
  console.error('✗ SkillLoader tests failed:', err);
  process.exit(1);
});
