const assert = require('assert');
const { getMacAddress, normalizeMac } = require('../../service/modules/mac-address');

function run() {
  const mac = getMacAddress();

  // 1. 返回字符串
  assert.strictEqual(typeof mac, 'string', 'MAC 应为字符串');

  // 2. 格式为 AA:BB:CC:DD:EE:FF
  assert.ok(
    /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac),
    `MAC 格式应为 AA:BB:CC:DD:EE:FF 大写，实际: ${mac}`
  );

  // 3. normalizeMac 测试
  assert.strictEqual(normalizeMac('00e070e943bc'), '00:E0:70:E9:43:BC');
  assert.strictEqual(normalizeMac('00:E0:70:E9:43:BC'), '00:E0:70:E9:43:BC');
  assert.strictEqual(normalizeMac('00-E0-70-E9-43-BC'), '00:E0:70:E9:43:BC');
  assert.strictEqual(normalizeMac('"00-E0-70-E9-43-BC"'), '00:E0:70:E9:43:BC');
  assert.strictEqual(normalizeMac('invalid'), null);

  console.log('✓ mac-address tests passed');
}

try {
  run();
} catch (err) {
  console.error('✗ mac-address tests failed:', err);
  process.exit(1);
}
