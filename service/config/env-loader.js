/**
 * 简单的 .env 文件加载器
 *
 * 不依赖 dotenv，兼容 Node.js >= 14。
 * 仅当环境变量未设置时才从 .env 文件填充。
 */
const fs = require('fs');
const path = require('path');

let loaded = false;

/**
 * 加载 .env 文件到 process.env
 * @param {string} [envPath] - 可选，指定 .env 文件路径
 */
function loadEnv(envPath) {
  if (loaded) return;

  const filePath = envPath || path.join(__dirname, '..', '..', '.env');
  if (!fs.existsSync(filePath)) {
    return;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split(/\r?\n/);

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) continue;

      const key = trimmed.substring(0, eqIndex).trim();
      let value = trimmed.substring(eqIndex + 1).trim();

      // 去除首尾引号
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      // 环境变量优先级高于 .env 文件
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }

    loaded = true;
  } catch (err) {
    console.error(`[EnvLoader] 加载 .env 文件失败: ${err.message}`);
  }
}

/**
 * 重置加载状态（主要用于测试）
 */
function resetLoaded() {
  loaded = false;
}

module.exports = { loadEnv, resetLoaded };
