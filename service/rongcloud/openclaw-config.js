const { homedir } = require('os');
const { join } = require('path');
const { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } = require('fs');

const OPENCLAW_DIR = join(homedir(), '.openclaw');
const SETTINGS_FILE = join(OPENCLAW_DIR, 'openclaw.json');

// 静默服务不需要强制启用任何 openclaw 插件
const DEFAULT_PLUGINS = [];
const REMOVED_PLUGINS = ['openclaw-weixin', 'openclaw-wechat'];

function isPluginDirExists(pluginName) {
  const pluginDir = join(OPENCLAW_DIR, 'extensions', pluginName);
  return existsSync(pluginDir);
}

function disableBrokenPlugin(pluginName, log) {
  const pluginDir = join(OPENCLAW_DIR, 'extensions', pluginName);
  const disabledDir = pluginDir + '.bak.disabled';
  if (!existsSync(pluginDir)) return;
  try {
    if (existsSync(disabledDir)) {
      const { rmSync } = require('fs');
      rmSync(pluginDir, { recursive: true, force: true });
    } else {
      renameSync(pluginDir, disabledDir);
    }
    log?.warn(`[OpenClawConfig] ${pluginName} 已禁用（目录重命名为 .bak.disabled）`);
  } catch (err) {
    log?.error(`[OpenClawConfig] 禁用 ${pluginName} 失败: ${err.message}`);
  }
}

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

  const brokenPlugins = [];
  const healthyPlugins = cleaned.filter(p => {
    if (!isPluginDirExists(p)) return false;
    if (p === 'claw_messenger') {
      const enginePath = join(OPENCLAW_DIR, 'extensions', 'claw_messenger', 'node_modules', '@rongcloud', 'engine');
      if (!existsSync(enginePath)) {
        log?.warn(`[OpenClawConfig] claw_messenger 缺少 @rongcloud/engine，自动移除`);
        brokenPlugins.push(p);
        return false;
      }
    }
    return true;
  });
  const removedBroken = cleaned.length - healthyPlugins.length;

  for (const p of brokenPlugins) {
    disableBrokenPlugin(p, log);
  }

  if (settings.channels) {
    for (const p of brokenPlugins) {
      if (settings.channels[p] !== undefined) {
        delete settings.channels[p];
        log?.warn(`[OpenClawConfig] 已从 channels 移除 ${p}`);
      }
    }
  }

  if (removedCount === 0 && removedBroken === 0) {
    log?.info('[OpenClawConfig] plugins.allow 已完整');
    return true;
  }

  settings.plugins.allow = healthyPlugins;

  try {
    writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
    if (removedCount > 0) {
      log?.info(`[OpenClawConfig] 已清理无效插件: ${REMOVED_PLUGINS.join(', ')}`);
    }
    if (removedBroken > 0) {
      log?.info(`[OpenClawConfig] 已清理损坏插件: ${removedBroken} 个`);
    }
    return true;
  } catch (err) {
    log?.error(`[OpenClawConfig] 写入失败: ${err.message}`);
    return false;
  }
}

module.exports = { ensurePluginsAllow };
