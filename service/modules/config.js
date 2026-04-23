const fs = require('fs');
const path = require('path');
const os = require('os');

function loadConfig() {
  // Read from ~/.claw-bridge/config.json
  const clawBridgePath = path.join(os.homedir(), '.claw-bridge', 'config.json');
  let clawBridgeConfig = {};
  if (fs.existsSync(clawBridgePath)) {
    try {
      clawBridgeConfig = JSON.parse(fs.readFileSync(clawBridgePath, 'utf-8'));
    } catch (e) {
      console.error('读取 claw-bridge 配置失败:', e);
    }
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

module.exports = { loadConfig };
