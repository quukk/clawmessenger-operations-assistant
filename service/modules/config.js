const fs = require('fs');
const path = require('path');
const os = require('os');
const { getApiBaseUrl, getAppKey } = require('../config');

// === 运维端 (ops) 自有文件路径常量 ===
// 新位置：~/.claw-bridge/opencode-ass/（与 openclaw(~/.claw-bridge/openclaw/) 区分开）
const OPS_DIR_NAME = 'opencode-ass';
const CLAW_BRIDGE_DIR_NAME = '.claw-bridge';
const OPS_CONFIG_FILE_NAME = 'config.json';
const OPS_PREFS_FILE_NAME = 'user-preferences.json';

/**
 * 获取实际用户主目录
 * Windows 服务以 SYSTEM 运行时 os.homedir() 返回 systemprofile，
 * 优先使用 CLAW_SERVICE_HOME / USERPROFILE 环境变量，最后扫描 C:\Users
 *
 * 扫描标记：新部署仅探测 opencode-ass/config.json。
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
  // SYSTEM 账户兜底：扫描 C:\Users 找包含运维配置的实际用户目录
  const usersDir = 'C:\\Users';
  if (fs.existsSync(usersDir)) {
    const entries = fs.readdirSync(usersDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !['Public', 'Default', 'All Users', 'Default User'].includes(entry.name)) {
        const candidate = path.join(usersDir, entry.name);
        // 新标记：opencode-ass/config.json
        if (fs.existsSync(path.join(candidate, CLAW_BRIDGE_DIR_NAME, OPS_DIR_NAME, OPS_CONFIG_FILE_NAME))) {
          return candidate;
        }
      }
    }
  }
  return homeDir;
}

/**
 * 运维端配置目录：~/.claw-bridge/opencode-ass/
 */
function getOpsConfigDir() {
  return path.join(getRealHomeDir(), CLAW_BRIDGE_DIR_NAME, OPS_DIR_NAME);
}

/**
 * 运维端配置文件：~/.claw-bridge/opencode-ass/config.json
 */
function getOpsConfigPath() {
  return path.join(getOpsConfigDir(), OPS_CONFIG_FILE_NAME);
}

/**
 * 运维端用户偏好文件：~/.claw-bridge/opencode-ass/user-preferences.json
 */
function getOpsPrefsPath() {
  return path.join(getOpsConfigDir(), OPS_PREFS_FILE_NAME);
}

/**
 * 运维端旧版配置路径：~/.claw-bridge/config.json（迁移源）
 */
function getLegacyOpsConfigPath() {
  return path.join(getRealHomeDir(), CLAW_BRIDGE_DIR_NAME, OPS_CONFIG_FILE_NAME);
}

/**
 * 运维端旧版偏好路径：~/.claw-bridge/user-preferences.json（迁移源）
 */
function getLegacyOpsPrefsPath() {
  return path.join(getRealHomeDir(), CLAW_BRIDGE_DIR_NAME, OPS_PREFS_FILE_NAME);
}

/**
 * 从旧路径迁移运维端自有文件到 opencode-ass/，保留旧文件不删除。
 * 幂等：目标已存在则跳过。
 *
 * @param {string} logTag - 日志前缀
 */
function migrateLegacyOpsConfig(logTag = '[MIGRATE]') {
  try {
    const opsDir = getOpsConfigDir();
    if (!fs.existsSync(opsDir)) {
      fs.mkdirSync(opsDir, { recursive: true });
    }

    const pairs = [
      [getLegacyOpsConfigPath(), getOpsConfigPath()],
      [getLegacyOpsPrefsPath(), getOpsPrefsPath()],
    ];
    for (const [oldPath, newPath] of pairs) {
      if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
        // 旧 config.json 同时是 openclaw 的 legacy 读取源；
        // 仅迁移含运维字段（omRongcloudId/omToken）的文件
        if (oldPath.endsWith(OPS_CONFIG_FILE_NAME)) {
          try {
            const cfg = JSON.parse(fs.readFileSync(oldPath, 'utf8'));
            if (!cfg.omRongcloudId && !cfg.omToken) {
              // 不是运维端配置（是 openclaw legacy），不迁移
              continue;
            }
          } catch {
            // 解析失败不阻塞，跳过迁移
            continue;
          }
        }
        fs.copyFileSync(oldPath, newPath);
        console.log(`${logTag} 已迁移 ${oldPath} -> ${newPath} (保留旧文件)`);
      }
    }
  } catch (err) {
    console.warn(`${logTag} 迁移旧配置失败 (非致命): ${err.message}`);
  }
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

  // 0. 一次性迁移旧版运维配置到 opencode-ass/（幂等）
  migrateLegacyOpsConfig('[CONFIG]');

  // 1. 读取 openclaw-clawmessenger 的注册配置（融云用户 ID / token 的真实来源）
  const openclawConfig = loadOpenclawConfig(homeDir);

  // 2. 读取运维端自己的 ~/.claw-bridge/opencode-ass/config.json
  const opsConfigPath = getOpsConfigPath();
  let clawBridgeConfig = {};
  if (fs.existsSync(opsConfigPath)) {
    try {
      clawBridgeConfig = JSON.parse(fs.readFileSync(opsConfigPath, 'utf-8'));
    } catch (e) {
      console.error('读取 claw-bridge 配置失败:', e);
    }
  }
  if (!fs.existsSync(opsConfigPath)) {
    console.warn(`[CONFIG] 未找到 ${opsConfigPath} (home=${homeDir})`);
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

module.exports = {
  loadConfig,
  getRealHomeDir,
  getOpsConfigDir,
  getOpsConfigPath,
  getOpsPrefsPath,
  getLegacyOpsConfigPath,
  getLegacyOpsPrefsPath,
  migrateLegacyOpsConfig,
  // 路径常量
  OPS_DIR_NAME,
  CLAW_BRIDGE_DIR_NAME,
  OPS_CONFIG_FILE_NAME,
  OPS_PREFS_FILE_NAME,
};
