const { homedir } = require('os');
const { join } = require('path');
const { mkdirSync, readFileSync, writeFileSync, existsSync } = require('fs');

const OPENCLAW_DIR = join(homedir(), '.openclaw');
const SETTINGS_FILE = join(OPENCLAW_DIR, 'openclaw.json');

const DEFAULT_PLUGINS = ['claw_messenger'];
const REMOVED_PLUGINS = ['openclaw-weixin', 'openclaw-wechat'];

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
  const cleaned = existing.filter(p => !REMOVED_PLUGINS.includes(p));
  const removedCount = existing.length - cleaned.length;
  const missing = DEFAULT_PLUGINS.filter(p => !cleaned.includes(p));

  if (missing.length === 0 && removedCount === 0) {
    log?.info('[OpenClawConfig] plugins.allow 已完整');
    return true;
  }

  settings.plugins.allow = [...new Set([...cleaned, ...DEFAULT_PLUGINS])];

  try {
    writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
    if (missing.length > 0) {
      log?.info(`[OpenClawConfig] 已添加: ${missing.join(', ')}`);
    }
    if (removedCount > 0) {
      log?.info(`[OpenClawConfig] 已清理无效插件: ${REMOVED_PLUGINS.join(', ')}`);
    }
    return true;
  } catch (err) {
    log?.error(`[OpenClawConfig] 写入失败: ${err.message}`);
    return false;
  }
}

module.exports = { ensurePluginsAllow };