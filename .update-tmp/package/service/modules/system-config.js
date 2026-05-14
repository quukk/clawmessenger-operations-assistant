/**
 * 系统配置获取模块
 * 从 Python 服务端动态获取融云配置（appKey, appSecret 等）
 */

const axios = require('axios');

class SystemConfigManager {
  constructor(config, log) {
    this.config = config;
    this.log = log;
    this.serverUrl = config.apiBaseUrl || process.env.DM_SERVER_URL || 'https://newsradar.dreamdt.cn/im';
    this.configs = new Map();
    this.lastFetchTime = 0;
    this.fetchInterval = 5 * 60 * 1000; // 5分钟刷新一次
  }

  /**
   * 从服务端获取配置
   */
  async fetchConfig(configKey) {
    try {
      const url = `${this.serverUrl}/im/api/system/config/${configKey}`;
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
      this.log?.error(`[SystemConfig] 获取配置异常: ${configKey}, URL=${this.serverUrl}/im/api/system/config/${configKey}, ${err.message}`);
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
}

module.exports = { SystemConfigManager };
