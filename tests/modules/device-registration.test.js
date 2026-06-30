/**
 * DeviceRegistration 单元测试（纯 Node.js assert，无需 jest）
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');

const { DeviceRegistration } = require('../../service/modules/device-registration');

// 保存原始 axios 方法
const originalAxiosPost = axios.post;
const originalAxiosGet = axios.get;

function createMockLog() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

async function run() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-reg-test-'));
  const configPath = path.join(tmpDir, '.claw-bridge', 'config.json');
  const openclawConfigDir = path.join(tmpDir, '.claw-bridge', 'openclaw');
  const openclawConfigPath = path.join(openclawConfigDir, 'config.json');

  // 覆盖 getRealHomeDir 不太方便，我们通过环境变量 CLAW_SERVICE_HOME 控制
  process.env.CLAW_SERVICE_HOME = tmpDir;

  const log = createMockLog();
  const deviceReg = new DeviceRegistration(log);

  // 1. 无配置时 hasValidConfig 返回 false
  assert.strictEqual(deviceReg.hasValidConfig(), false, '无配置时应返回 false');

  // 2. 无 openclaw 配置时 autoRegister 返回 null
  const noOpenclawResult = await deviceReg.autoRegister();
  assert.strictEqual(noOpenclawResult, null, '缺少 openclaw 配置时应返回 null');

  // 3. 准备 openclaw 配置
  fs.mkdirSync(openclawConfigDir, { recursive: true });
  fs.writeFileSync(
    openclawConfigPath,
    JSON.stringify({
      nodeId: 'claw_test123',
      nodeName: 'test_node',
      token: 'openclaw_node_token_xxx',
      macAddress: '00:11:22:33:44:55',
      createdAt: new Date().toISOString(),
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    })
  );

  // 4. 自动注册完整流程：读取 openclaw 配置并获取运维账户
  axios.post = async (url, data) => {
    throw new Error(`不应再调用注册接口: ${url}`);
  };

  axios.get = async (url) => {
    assert.ok(url.includes('/api/claw/om-token/claw_test123'), '应调用运维 token 接口');
    return {
      data: {
        code: 200,
        data: {
          node_id: 'claw_test123',
          om_rongcloud_id: 'om_claw_test123',
          token: 'om_token_xxx',
          app_key: 'test_app_key',
        },
      },
    };
  };

  const config = await deviceReg.autoRegister();
  assert.ok(config, '自动注册应返回配置');
  assert.strictEqual(config.nodeId, 'claw_test123');
  assert.strictEqual(config.token, 'openclaw_node_token_xxx');
  assert.strictEqual(config.nodeName, 'test_node');
  assert.strictEqual(config.omRongcloudId, 'om_claw_test123');
  assert.strictEqual(config.omToken, 'om_token_xxx');
  assert.strictEqual(config.appKey, 'test_app_key');
  assert.ok(config.expiresAt > Date.now(), '应设置过期时间');

  // 验证配置文件已写入
  assert.ok(fs.existsSync(configPath), '配置文件应被创建');
  const savedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.strictEqual(savedConfig.nodeId, 'claw_test123');
  assert.strictEqual(savedConfig.token, 'openclaw_node_token_xxx');

  // 5. 有效配置检测
  assert.strictEqual(deviceReg.hasValidConfig(savedConfig), true, '未过期配置应有效');
  assert.strictEqual(deviceReg.hasValidConfig(savedConfig, true), true, '包含运维账户的配置应有效');

  // 6. 过期配置检测
  const expiredConfig = { ...savedConfig, expiresAt: Date.now() - 1000 };
  assert.strictEqual(deviceReg.hasValidConfig(expiredConfig), false, '过期配置应无效');

  // 7. 缺少运维账户检测
  const noOmConfig = { nodeId: 'claw_test', token: 'tk' };
  assert.strictEqual(deviceReg.hasValidConfig(noOmConfig), true, '不检查运维账户时基础配置应有效');
  assert.strictEqual(deviceReg.hasValidConfig(noOmConfig, true), false, '要求运维账户时缺少 om 应无效');

  // 8. 刷新 token：优先刷新运维 token
  axios.get = async (url) => {
    assert.ok(url.includes('/api/claw/om-token/claw_test123'), '刷新时应调用运维 token 接口');
    return {
      data: {
        code: 200,
        data: {
          node_id: 'claw_test123',
          om_rongcloud_id: 'om_claw_test123',
          token: 'refreshed_om_token',
          app_key: 'refreshed_app_key',
        },
      },
    };
  };

  const refreshed = await deviceReg.refreshToken();
  assert.strictEqual(refreshed, true, '刷新 token 应成功');
  const refreshedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.strictEqual(refreshedConfig.omToken, 'refreshed_om_token');
  assert.strictEqual(refreshedConfig.appKey, 'refreshed_app_key');
  assert.ok(refreshedConfig.expiresAt > Date.now(), '刷新后过期时间应更新');

  // 9. 兼容旧版 openclaw 配置路径（不含 om 字段的 ~/.claw-bridge/config.json）
  fs.rmSync(openclawConfigPath, { force: true });
  fs.rmSync(configPath, { force: true });
  fs.writeFileSync(
    path.join(tmpDir, '.claw-bridge', 'config.json'),
    JSON.stringify({
      nodeId: 'claw_legacy456',
      nodeName: 'legacy_node',
      token: 'legacy_token_xxx',
    })
  );

  axios.get = async (url) => {
    assert.ok(url.includes('/api/claw/om-token/claw_legacy456'), '应使用旧版 openclaw 节点 ID');
    return {
      data: {
        code: 200,
        data: {
          node_id: 'claw_legacy456',
          om_rongcloud_id: 'om_claw_legacy456',
          token: 'legacy_om_token',
        },
      },
    };
  };

  const legacyResult = await deviceReg.autoRegister();
  assert.ok(legacyResult, '旧版 openclaw 配置应能完成注册');
  assert.strictEqual(legacyResult.nodeId, 'claw_legacy456');
  assert.strictEqual(legacyResult.omRongcloudId, 'om_claw_legacy456');

  // 10. 不应将包含 omRongcloudId/omToken 的 ~/.claw-bridge/config.json 误认为 openclaw 配置
  fs.rmSync(openclawConfigPath, { force: true });
  fs.writeFileSync(
    path.join(tmpDir, '.claw-bridge', 'config.json'),
    JSON.stringify({
      nodeId: 'claw_self_written',
      token: 'self_token',
      omRongcloudId: 'om_claw_self_written',
      omToken: 'self_om_token',
    })
  );
  const shouldFail = await deviceReg.autoRegister();
  assert.strictEqual(shouldFail, null, '不应将 silent-subagent 自己的配置当作 openclaw 配置');

  // 恢复 axios
  axios.post = originalAxiosPost;
  axios.get = originalAxiosGet;

  // 清理
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.CLAW_SERVICE_HOME;

  console.log('✓ DeviceRegistration tests passed');
}

run().catch((err) => {
  axios.post = originalAxiosPost;
  axios.get = originalAxiosGet;
  console.error('✗ DeviceRegistration tests failed:', err);
  process.exit(1);
});
