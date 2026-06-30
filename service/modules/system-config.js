/**
 * 系统配置获取模块
 * 从 Python 服务端动态获取融云配置（appKey, appSecret 等）
 */

const axios = require('axios');
const { getServerUrl } = require('../config');

class SystemConfigManager {
  constructor(config, log) {
    this.config = config;
    this.log = log;
    this.serverUrl = config.apiBaseUrl || getServerUrl();
    this.configs = new Map();
    this.lastFetchTime = 0;
    this.fetchInterval = 5 * 60 * 1000; // 5分钟刷新一次
  }

  /**
   * 从服务端获取配置
   */
  async fetchConfig(configKey) {
    try {
      const url = `${this.serverUrl}/api/system/config/${configKey}`;
      this.log?.info(`[SystemConfig] 正在请求配置: ${configKey}, URL=${url}`);
      const response = await axios.get(url, { timeout: 10000 });

      if (response.data?.code === 200 && response.data?.data?.value) {
        this.configs.set(configKey, response.data.data.value);
        this.lastFetchTime = Date.now();
        this.log?.info(`[SystemConfig] 获取配置成功: ${configKey}`);
        return response.data.data.value;
      }

      this.log?.warn(`[SystemConfig] 获取配置失败: ${configKey}, code=${response.data?.code}`);
      return null;
    } catch (err) {
      this.log?.error(`[SystemConfig] 获取配置异常: ${configKey}, URL=${this.serverUrl}/api/system/config/${configKey}, ${err.message}`);
      return null;
    }
  }

  /**
   * 获取配置值（带缓存）
   */
  async getConfig(configKey) {
    // 检查缓存是否过期
    const now = Date.now();
    if (this.configs.has(configKey) && (now - this.lastFetchTime) < this.fetchInterval) {
      return this.configs.get(configKey);
    }

    // 重新获取
    return this.fetchConfig(configKey);
  }

  /**
   * 批量获取配置
   */
  async getConfigs(keys) {
    const results = {};
    for (const key of keys) {
      results[key] = await this.getConfig(key);
    }
    return results;
  }

  /**
   * 强制刷新配置
   */
  async refresh() {
    this.lastFetchTime = 0;
    const keys = Array.from(this.configs.keys());
    for (const key of keys) {
      await this.fetchConfig(key);
    }
  }

  /**
   * 获取融云 AppKey（公开配置）
   * 使用专用接口 /api/config/rongcloud，不走 /api/system/config 白名单
   */
  async fetchRongcloudAppKey() {
    try {
      const url = `${this.serverUrl}/api/config/rongcloud`;
      this.log?.info(`[SystemConfig] 获取融云 appKey: ${url}`);
      const response = await axios.get(url, { timeout: 10000 });

      if (response.data?.code === 200 && response.data?.data?.appKey) {
        this.log?.info('[SystemConfig] 获取融云 appKey 成功');
        return response.data.data.appKey;
      }

      this.log?.warn(`[SystemConfig] 获取融云 appKey 失败: code=${response.data?.code}`);
      return null;
    } catch (err) {
      this.log?.error(`[SystemConfig] 获取融云 appKey 异常: ${err.message}`);
      return null;
    }
  }

  /**
   * 获取融云 AppSecret（需要节点认证）
   * 使用专用接口 /api/config/rongcloud/secret
   * @param {string} nodeToken - 节点融云 token
   * @param {string} nodeId - 节点 ID
   */
  async fetchRongcloudAppSecret(nodeToken, nodeId) {
    try {
      const url = `${this.serverUrl}/api/config/rongcloud/secret`;
      const headers = {};
      if (nodeToken) headers['X-Node-Token'] = nodeToken;
      if (nodeId) headers['X-Node-Id'] = nodeId;

      this.log?.info(`[SystemConfig] 获取融云 appSecret: ${url}, nodeId=${nodeId}`);
      const response = await axios.get(url, { headers, timeout: 10000 });

      if (response.data?.code === 200 && response.data?.data?.appSecret) {
        this.log?.info('[SystemConfig] 获取融云 appSecret 成功');
        return response.data.data.appSecret;
      }

      this.log?.warn(`[SystemConfig] 获取融云 appSecret 失败: code=${response.data?.code}, message=${response.data?.message}`);
      return null;
    } catch (err) {
      this.log?.error(`[SystemConfig] 获取融云 appSecret 异常: ${err.message}`);
      return null;
    }
  }
}

module.exports = { SystemConfigManager };
