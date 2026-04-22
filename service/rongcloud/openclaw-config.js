const { homedir } = require('os');
const { join } = require('path');
const { mkdirSync, readFileSync, writeFileSync, existsSync } = require('fs');

const OPENCLAW_DIR = join(homedir(), '.openclaw');
const SETTINGS_FILE = join(OPENCLAW_DIR, 'openclaw.json');

const DEFAULT_PLUGINS = ['claw_messenger', 'openclaw-weixin', 'openclaw-wechat'];

function ensurePluginsAllow(log) {
  try {
    if (!existsSync(OPENCLAW_DIR)) {
      mkdirSync(OPENCLAW_DIR, { recursive: true });
    }
  } catch {}

  let settings = {};

  try {
    const content = readFileSync(SETTINGS_FILE, 'utf-8');
    settings = JSON.parse(content);
    log?.info('[OpenClawConfig] 已加载配置');
  } catch {
    log?.info('[OpenClawConfig] 创建新配置');
    settings = {};
  }

  if (!settings.plugins) settings.plugins = {};

  const existing = settings.plugins.allow || [];
  const missing = DEFAULT_PLUGINS.filter(p => !existing.includes(p));

  if (missing.length === 0) {
    log?.info('[OpenClawConfig] plugins.allow 已完整');
    return true;
  }

  settings.plugins.allow = [...new Set([...existing, ...DEFAULT_PLUGINS])];

  try {
    writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
    log?.info(`[OpenClawConfig] 已添加: ${missing.join(', ')}`);
    return true;
  } catch (err) {
    log?.error(`[OpenClawConfig] 写入失败: ${err.message}`);
    return false;
  }
}

module.exports = { ensurePluginsAllow };