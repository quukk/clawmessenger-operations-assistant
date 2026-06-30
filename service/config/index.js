/**
 * 统一配置入口
 *
 * 集中管理所有环境变量和默认值，避免各模块硬编码 URL。
 * 启动时自动加载项目根目录的 .env 文件。
 */
const { loadEnv } = require('./env-loader');

// 启动时自动加载 .env
loadEnv();

const DEFAULT_API_BASE_URL = 'https://newsradar.dreamdt.cn';
const DEFAULT_SERVER_URL = 'https://newsradar.dreamdt.cn/im';
const DEFAULT_APP_KEY = 'bmdehs6pbyyks';

/**
 * 获取 API 基础地址（不含 /im 路径）
 * 优先级：环境变量 > .env 文件 > 默认值
 * @returns {string}
 */
function getApiBaseUrl() {
  return process.env.API_BASE_URL || DEFAULT_API_BASE_URL;
}

/**
 * 获取服务端地址（含 /im 路径）
 * 优先级：DM_SERVER_URL > API_BASE_URL > 默认值
 * @returns {string}
 */
function getServerUrl() {
  return process.env.DM_SERVER_URL || process.env.API_BASE_URL || DEFAULT_SERVER_URL;
}

/**
 * 获取融云 AppKey
 * @returns {string}
 */
function getAppKey() {
  return process.env.DM_APP_KEY || DEFAULT_APP_KEY;
}

/**
 * 从 URL 推导 apiBaseUrl
 * 当只有 DM_SERVER_URL 时，提取其 protocol + host
 * @returns {string}
 */
function deriveApiBaseUrl() {
  const serverUrl = getServerUrl();
  try {
    const url = new URL(serverUrl);
    return `${url.protocol}//${url.host}`;
  } catch {
    return DEFAULT_API_BASE_URL;
  }
}

module.exports = {
  loadEnv,
  getApiBaseUrl,
  getServerUrl,
  getAppKey,
  deriveApiBaseUrl,
};
