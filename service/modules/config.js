const fs = require('fs');
const path = require('path');
const os = require('os');

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

function loadConfig() {
  const homeDir = getRealHomeDir();

  // Read from ~/.claw-bridge/config.json
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

  // Read from local rongcloud-config.json
  const localConfigPath = path.join(__dirname, '..', '..', 'rongcloud-config.json');
  let localConfig = {};
  if (fs.existsSync(localConfigPath)) {
    try {
      localConfig = JSON.parse(fs.readFileSync(localConfigPath, 'utf-8'));
    } catch (e) {
      console.error('读取本地配置失败:', e);
    }
  }

  return {
    appKey: process.env.DM_APP_KEY || localConfig.appKey || 'bmdehs6pbyyks',
    token: localConfig.token || clawBridgeConfig.token,
    accountId: localConfig.accountId || clawBridgeConfig.nodeId,
    nodeName: clawBridgeConfig.nodeName || 'cli-client',
    secretKey: localConfig.secretKey || 'secret_key',
    nickname: localConfig.nickname || 'CLI客户端',
    reconnectInterval: localConfig.reconnectInterval || 60,
    heartbeatInterval: localConfig.heartbeatInterval || 20,
    openclawPort: localConfig.openclawPort || 18789,
    scriptTimeout: localConfig.scriptTimeout || 180,
    successKeyword: localConfig.successKeyword || 'Success',
    chatTimeout: localConfig.chatTimeout || 600
  };
}

module.exports = { loadConfig, getRealHomeDir };
