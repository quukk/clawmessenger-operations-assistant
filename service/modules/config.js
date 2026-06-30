const fs = require('fs');
const path = require('path');
const os = require('os');
const { getApiBaseUrl, getAppKey } = require('../config');

/**
 * 获取实际用户主目录
 * Windows 服务以 SYSTEM 运行时 os.homedir() 返回 systemprofile，
 * 优先使用 CLAW_SERVICE_HOME / USERPROFILE 环境变量，最后扫描 C:\Users
 */
function getRealHomeDir() {
  const envHome = process.env.CLAW_SERVICE_HOME || process.env.USERPROFILE || process.env.HOME;
  if (envHome && !envHome.includes('systemprofile')) {
    return envHome;
  }
  const homeDir = os.homedir();
  if (!homeDir.includes('systemprofile')) {
    return homeDir;
  }
  // SYSTEM 账户兜底：扫描 C:\Users 找包含 .claw-bridge 的实际用户目录
  const usersDir = 'C:\\Users';
  if (fs.existsSync(usersDir)) {
    const entries = fs.readdirSync(usersDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !['Public', 'Default', 'All Users', 'Default User'].includes(entry.name)) {
        const candidate = path.join(usersDir, entry.name);
        if (fs.existsSync(path.join(candidate, '.claw-bridge', 'config.json'))) {
          return candidate;
        }
      }
    }
  }
  return homeDir;
}

/**
 * 读取 openclaw-clawmessenger 的本地配置
 * 新版：~/.claw-bridge/openclaw/config.json
 * 旧版：~/.claw-bridge/config.json（仅当不含 omRongcloudId / omToken 时）
 */
function loadOpenclawConfig(homeDir) {
  const openclawPath = path.join(homeDir, '.claw-bridge', 'openclaw', 'config.json');
  const legacyPath = path.join(homeDir, '.claw-bridge', 'config.json');

  if (fs.existsSync(openclawPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(openclawPath, 'utf-8'));
      if (cfg.nodeId && cfg.token) {
        return cfg;
      }
    } catch (e) {
      console.error('读取 openclaw 新版配置失败:', e);
    }
  }

  if (fs.existsSync(legacyPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(legacyPath, 'utf-8'));
      // 若包含运维账户字段，说明是 silent-subagent 自己的配置，不应作为 openclaw 源
      if (cfg.nodeId && cfg.token && !cfg.omRongcloudId && !cfg.omToken) {
        return cfg;
      }
    } catch (e) {
      console.error('读取 openclaw 旧版配置失败:', e);
    }
  }

  return null;
}

function loadConfig() {
  const homeDir = getRealHomeDir();

  // 1. 读取 openclaw-clawmessenger 的注册配置（融云用户 ID / token 的真实来源）
  const openclawConfig = loadOpenclawConfig(homeDir);

  // 2. 读取 silent-subagent 自己的 ~/.claw-bridge/config.json
  const clawBridgePath = path.join(homeDir, '.claw-bridge', 'config.json');
  let clawBridgeConfig = {};
  if (fs.existsSync(clawBridgePath)) {
    try {
      clawBridgeConfig = JSON.parse(fs.readFileSync(clawBridgePath, 'utf-8'));
    } catch (e) {
      console.error('读取 claw-bridge 配置失败:', e);
    }
  }
  if (!fs.existsSync(clawBridgePath)) {
    console.warn(`[CONFIG] 未找到 ${clawBridgePath} (home=${homeDir})`);
  }

  // 3. 读取本地 rongcloud-config.json
  const localConfigPath = path.join(__dirname, '..', '..', 'rongcloud-config.json');
  let localConfig = {};
  if (fs.existsSync(localConfigPath)) {
    try {
      localConfig = JSON.parse(fs.readFileSync(localConfigPath, 'utf-8'));
    } catch (e) {
      console.error('读取本地配置失败:', e);
    }
  }

  // 4. 合并配置：openclaw > 本地文件 > silent-subagent 自己的配置
  const accountId =
    localConfig.accountId ||
    openclawConfig?.nodeId ||
    clawBridgeConfig.nodeId;
  const token =
    localConfig.token ||
    openclawConfig?.token ||
    clawBridgeConfig.token;

  // 计算 apiBaseUrl：环境变量 > 配置文件 > 统一配置默认值
  let apiBaseUrl =
    process.env.API_BASE_URL ||
    localConfig.apiBaseUrl ||
    clawBridgeConfig.apiBaseUrl ||
    openclawConfig?.apiBaseUrl;
  if (!apiBaseUrl) {
    apiBaseUrl = getApiBaseUrl();
  }

  return {
    appKey: process.env.DM_APP_KEY || localConfig.appKey || clawBridgeConfig.appKey || getAppKey(),
    token,
    accountId,
    nodeName: clawBridgeConfig.nodeName || openclawConfig?.nodeName || 'cli-client',
    secretKey: localConfig.secretKey || 'secret_key',
    nickname: localConfig.nickname || 'CLI客户端',
    reconnectInterval: localConfig.reconnectInterval || 60,
    heartbeatInterval: localConfig.heartbeatInterval || 20,
    openclawPort: localConfig.openclawPort || 18789,
    scriptTimeout: localConfig.scriptTimeout || 180,
    successKeyword: localConfig.successKeyword || 'Success',
    chatTimeout: localConfig.chatTimeout || 600,
    apiBaseUrl
  };
}

module.exports = { loadConfig, getRealHomeDir };
