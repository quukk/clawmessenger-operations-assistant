/**
 * 设备注册与运维账户管理模块
 *
 * 职责：
 * 1. 读取 openclaw-clawmessenger（npm 插件）已注册的融云用户配置
 *    新版路径：~/.claw-bridge/openclaw/config.json
 *    旧版兼容：~/.claw-bridge/config.json（仅当新版不存在且旧版不含运维账户字段时）
 * 2. 基于 openclaw 的 nodeId 获取/创建运维独立融云账户 /api/claw/om-token/<node_id>
 * 3. 配置持久化到 ~/.claw-bridge/config.json
 * 4. token 失效检测与主动刷新
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { getRealHomeDir } = require('./config');
const { getMacAddress } = require('./mac-address');
const { getServerUrl, getAppKey } = require('../config');

const CONFIG_FILE_NAME = 'config.json';
const CONFIG_DIR_NAME = '.claw-bridge';
const OPENCLAW_CONFIG_DIR_NAME = 'openclaw';
const TOKEN_VALIDITY_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

class DeviceRegistration {
  /**
   * @param {Object} log - 日志对象（需包含 info/warn/error）
   */
  constructor(log) {
    this.log = log || console;
    this.configPath = path.join(getRealHomeDir(), CONFIG_DIR_NAME, CONFIG_FILE_NAME);
    this.openclawConfigPath = path.join(
      getRealHomeDir(), CONFIG_DIR_NAME, OPENCLAW_CONFIG_DIR_NAME, CONFIG_FILE_NAME
    );
    this.legacyOpenclawConfigPath = path.join(
      getRealHomeDir(), CONFIG_DIR_NAME, CONFIG_FILE_NAME
    );
    this.serverUrl = getServerUrl();
  }

  /**
   * 获取配置文件的完整路径
   * @returns {string}
   */
  getConfigPath() {
    return this.configPath;
  }

  /**
   * 加载当前配置
   * @returns {Object|null}
   */
  loadConfig() {
    try {
      if (!fs.existsSync(this.configPath)) {
        return null;
      }
      return JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
    } catch (err) {
      this.log.warn(`[DeviceRegistration] 加载配置失败: ${err.message}`);
      return null;
    }
  }

  /**
   * 读取 openclaw-clawmessenger 的本地配置
   *
   * 新版 openclaw 将配置写入 ~/.claw-bridge/openclaw/config.json；
   * 旧版写入 ~/.claw-bridge/config.json。为避免读到 silent-subagent 自己保存的
   * 配置，旧版路径仅在不含 omRongcloudId / omToken 时才被使用。
   *
   * @returns {Object|null} { nodeId, nodeName, token, macAddress }
   */
  loadOpenclawConfig() {
    // 优先新版路径
    if (fs.existsSync(this.openclawConfigPath)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(this.openclawConfigPath, 'utf8'));
        if (cfg.nodeId && cfg.token) {
          this.log.info(
            `[DeviceRegistration] 从 openclaw 新版配置读取: ${this.openclawConfigPath}`
          );
          return cfg;
        }
      } catch (err) {
        this.log.warn(`[DeviceRegistration] 读取 openclaw 新版配置失败: ${err.message}`);
      }
    }

    // 兼容旧版路径：若包含 omRongcloudId / omToken，说明是 silent-subagent 自己的配置，忽略
    if (fs.existsSync(this.legacyOpenclawConfigPath)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(this.legacyOpenclawConfigPath, 'utf8'));
        if (cfg.nodeId && cfg.token && !cfg.omRongcloudId && !cfg.omToken) {
          this.log.info(
            `[DeviceRegistration] 从 openclaw 旧版配置读取: ${this.legacyOpenclawConfigPath}`
          );
          return cfg;
        }
      } catch (err) {
        this.log.warn(`[DeviceRegistration] 读取 openclaw 旧版配置失败: ${err.message}`);
      }
    }

    return null;
  }

  /**
   * 检查当前配置是否有效
   *
   * 有效标准：
   * - 配置文件存在
   * - 包含 nodeId / token
   * - 未过期（expiresAt 不存在或大于当前时间）
   * - 若 requireOmAccount 为 true，还需包含 omRongcloudId / omToken
   *
   * @param {Object} [config] - 可选，传入已加载的配置
   * @param {boolean} [requireOmAccount=false] - 是否要求运维账户
   * @returns {boolean}
   */
  hasValidConfig(config, requireOmAccount = false) {
    const cfg = config || this.loadConfig();
    if (!cfg) return false;
    if (!cfg.nodeId || !cfg.token) return false;

    if (cfg.expiresAt && Date.now() > cfg.expiresAt) {
      this.log.info('[DeviceRegistration] 配置已过期');
      return false;
    }

    if (requireOmAccount && (!cfg.omRongcloudId || !cfg.omToken)) {
      this.log.info('[DeviceRegistration] 配置缺少运维账户');
      return false;
    }

    return true;
  }

  /**
   * 自动注册设备并获取运维账户
   *
   * 注意：不再自行调用 /api/claw/register 注册节点，而是直接复用
   * openclaw-clawmessenger 已注册的融云用户 ID（nodeId）。
   *
   * @returns {Promise<Object|null>} { nodeId, token, omRongcloudId, omToken, appKey, macAddress }
   */
  async autoRegister() {
    try {
      // 1. 读取 openclaw-clawmessenger 已注册的融云用户配置
      const openclawConfig = this.loadOpenclawConfig();
      if (!openclawConfig || !openclawConfig.nodeId || !openclawConfig.token) {
        this.log.error(
          '[DeviceRegistration] 未找到 openclaw-clawmessenger 配置，无法获取运维账户'
        );
        return null;
      }

      const nodeId = openclawConfig.nodeId;
      const nodeToken = openclawConfig.token;
      const nodeName = openclawConfig.nodeName || '';
      const macAddress = getMacAddress();

      this.log.info(`[DeviceRegistration] 使用 openclaw 节点: ${nodeId}`);

      // 2. 获取运维账户
      const omResult = await this._getOmToken(nodeId);
      if (!omResult) {
        this.log.error('[DeviceRegistration] 获取运维账户失败');
        return null;
      }

      const omRongcloudId = omResult.om_rongcloud_id;
      const omToken = omResult.token;
      const appKey = omResult.app_key;

      this.log.info(`[DeviceRegistration] 运维账户获取成功, omRongcloudId=${omRongcloudId}`);

      // 3. 持久化配置
      const config = {
        ...this.loadConfig(), // 保留已有字段（如 apiBaseUrl）
        nodeId,
        token: nodeToken,
        nodeName,
        omRongcloudId,
        omToken,
        appKey: appKey || this._resolveAppKey(),
        macAddress,
        registeredAt: Date.now(),
        expiresAt: Date.now() + TOKEN_VALIDITY_MS,
      };

      await this._saveConfig(config);

      return config;
    } catch (err) {
      this.log.error(`[DeviceRegistration] 自动注册异常: ${err.message}`);
      return null;
    }
  }

  /**
   * 刷新 token
   * 优先刷新运维 token；若当前节点 token 来自 openclaw 且已失效，也可兜底刷新节点 token。
   * @returns {Promise<boolean>}
   */
  async refreshToken() {
    const config = this.loadConfig();
    if (!config || !config.nodeId) {
      this.log.warn('[DeviceRegistration] 缺少 nodeId，无法刷新 token');
      return false;
    }

    // 1. 优先刷新运维 token
    if (config.omRongcloudId) {
      const omResult = await this._getOmToken(config.nodeId);
      if (omResult?.token) {
        config.omToken = omResult.token;
        if (omResult.app_key) config.appKey = omResult.app_key;
        config.expiresAt = Date.now() + TOKEN_VALIDITY_MS;

        await this._saveConfig(config);
        this.log.info('[DeviceRegistration] 运维 token 刷新成功');
        return true;
      }
    }

    // 2. 兜底：刷新节点 token
    try {
      const url = `${this.serverUrl}/api/claw/token/${config.nodeId}`;
      this.log.info(`[DeviceRegistration] 刷新节点 token, nodeId=${config.nodeId}`);

      const resp = await axios.get(url, { timeout: 15000 });
      if (resp.data?.code === 200) {
        const newToken = resp.data.data?.token || resp.data.token;
        const newAppKey = resp.data.data?.app_key || resp.data.app_key;

        if (!newToken) {
          this.log.error('[DeviceRegistration] 服务端返回空 token');
          return false;
        }

        config.token = newToken;
        if (newAppKey) config.appKey = newAppKey;
        config.expiresAt = Date.now() + TOKEN_VALIDITY_MS;

        await this._saveConfig(config);
        this.log.info('[DeviceRegistration] 节点 token 刷新成功');
        return true;
      }

      this.log.error(`[DeviceRegistration] 刷新 token 失败: ${resp.data?.message}`);
      return false;
    } catch (err) {
      this.log.error(`[DeviceRegistration] 刷新 token 异常: ${err.message}`);
      return false;
    }
  }

  /**
   * 获取/创建运维独立融云账户
   * @param {string} nodeId
   * @returns {Promise<Object|null>}
   */
  async _getOmToken(nodeId) {
    const url = `${this.serverUrl}/api/claw/om-token/${nodeId}`;
    try {
      const resp = await axios.get(url, { timeout: 15000 });

      if (resp.data?.code === 200) {
        return resp.data.data || null;
      }

      this.log.error(`[DeviceRegistration] 获取运维 token 失败: ${resp.data?.message || '未知错误'}`);
      return null;
    } catch (err) {
      this.log.error(`[DeviceRegistration] 获取运维 token 异常: ${err.message}`);
      return null;
    }
  }

  /**
   * 持久化配置到 config.json
   * @param {Object} config
   */
  async _saveConfig(config) {
    const dir = path.dirname(this.configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2));
    this.log.info(`[DeviceRegistration] 配置已保存到 ${this.configPath}`);
  }

  /**
   * 解析 AppKey 优先级：环境变量 > 本地配置 > 默认值
   * @returns {string}
   */
  _resolveAppKey() {
    const localConfigPath = path.join(__dirname, '..', '..', 'rongcloud-config.json');
    if (fs.existsSync(localConfigPath)) {
      try {
        const localConfig = JSON.parse(fs.readFileSync(localConfigPath, 'utf8'));
        if (localConfig.appKey) return localConfig.appKey;
      } catch (err) {
        // ignore
      }
    }
    return getAppKey();
  }
}

module.exports = { DeviceRegistration };
