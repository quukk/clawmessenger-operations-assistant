/**
 * 融云服务端 API 客户端
 * 直接从 silent-service 调用融云 REST API，无需通过服务端代理
 * 文档: https://docs.rongcloud.cn/platform-chat-api/message/send-private-stream
 */

const axios = require('axios');
const crypto = require('crypto');

// 国内数据中心 API 地址
const API_HOSTS_CN = [
  'api.rong-api.com',
  'api-b.rong-api.com'
];

class RongCloudServerAPI {
  constructor(configManager, log) {
    this.configManager = configManager;
    this.log = log;
    this.hosts = API_HOSTS_CN;
    this.currentHostIndex = 0;
    this.timeout = 10000;
    this._cachedConfig = null;
    this._cachedConfigTime = 0;
    this._configCacheTtl = 60 * 60 * 1000; // 1 小时
  }

  get currentHost() {
    return this.hosts[this.currentHostIndex];
  }

  _switchHost() {
    if (this.currentHostIndex < this.hosts.length - 1) {
      this.currentHostIndex++;
      this.log?.info(`[RongCloudServerAPI] 切换到备用域名: ${this.currentHost}`);
      return true;
    }
    return false;
  }

  _generateNonce(length = 18) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  _generateSignature(appSecret) {
    const nonce = this._generateNonce();
    const timestamp = Date.now();
    const source = appSecret + nonce + timestamp;
    const signature = crypto.createHash('sha1').update(source).digest('hex');
    return { nonce, timestamp, signature };
  }

  _getHeaders(appKey, appSecret) {
    const sign = this._generateSignature(appSecret);
    return {
      'App-Key': appKey,
      'Nonce': sign.nonce,
      'Timestamp': String(sign.timestamp),
      'Signature': sign.signature,
      'Content-Type': 'application/json; charset=UTF-8'
    };
  }

  _getFormHeaders(appKey, appSecret) {
    const sign = this._generateSignature(appSecret);
    return {
      'App-Key': appKey,
      'Nonce': sign.nonce,
      'Timestamp': String(sign.timestamp),
      'Signature': sign.signature,
      'Content-Type': 'application/x-www-form-urlencoded'
    };
  }

  async request(path, data, appKey, appSecret, retry = true) {
    const url = `https://${this.currentHost}${path}`;
    const headers = this._getHeaders(appKey, appSecret);

    this.log?.info(`[RongCloudServerAPI] 请求: POST ${url} (JSON)`);

    try {
      const response = await axios.post(url, data, {
        headers,
        timeout: this.timeout,
        responseType: 'json'
      });

      const result = response.data;

      if (result.code && result.code !== 200) {
        throw new Error(`[${result.code}] ${result.errorMessage || 'Unknown error'}`);
      }

      return result;
    } catch (err) {
      if (err.response?.status === 401) {
        this.log?.error('[RongCloudServerAPI] 签名验证失败，请检查 App Key 和 App Secret');
        throw err;
      }

      if (retry && this._switchHost()) {
        this.log?.warn(`[RongCloudServerAPI] 请求失败，使用备用域名重试: ${err.message}`);
        return this.request(path, data, appKey, appSecret, false);
      }

      this.log?.error(`[RongCloudServerAPI] 请求失败: ${err.message}`);
      throw err;
    }
  }

  async requestForm(path, data, appKey, appSecret, retry = true) {
    const url = `https://${this.currentHost}${path}`;
    const headers = this._getFormHeaders(appKey, appSecret);

    // 将对象转换为 URLSearchParams (form-urlencoded)
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined && value !== null) {
        params.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
      }
    }

    this.log?.info(`[RongCloudServerAPI] 请求: POST ${url} (Form)`);

    try {
      const response = await axios.post(url, params.toString(), {
        headers,
        timeout: this.timeout,
        responseType: 'json'
      });

      const result = response.data;

      if (result.code && result.code !== 200) {
        throw new Error(`[${result.code}] ${result.errorMessage || 'Unknown error'}`);
      }

      return result;
    } catch (err) {
      if (err.response?.status === 401) {
        this.log?.error('[RongCloudServerAPI] 签名验证失败，请检查 App Key 和 App Secret');
        throw err;
      }

      if (retry && this._switchHost()) {
        this.log?.warn(`[RongCloudServerAPI] 请求失败，使用备用域名重试: ${err.message}`);
        return this.requestForm(path, data, appKey, appSecret, false);
      }

      this.log?.error(`[RongCloudServerAPI] 请求失败: ${err.message}`);
      throw err;
    }
  }

  /**
   * 获取融云配置，带缓存（1小时），避免每次发送消息都请求后端接口。
   * 使用服务端专用接口：
   * - /api/config/rongcloud 获取 appKey（公开）
   * - /api/config/rongcloud/secret 获取 appSecret（需节点认证）
   */
  async _getRongCloudConfig() {
    const now = Date.now();
    if (this._cachedConfig && now - this._cachedConfigTime < this._configCacheTtl) {
      return this._cachedConfig;
    }

    const config = this.configManager?.config || {};
    // 优先使用节点原 token/id（运维账户场景下 originalToken/originalAccountId 才是节点真实身份）
    const nodeToken = config.originalToken || config.token;
    const nodeId = config.originalAccountId || config.accountId;

    const appKey = await this.configManager.fetchRongcloudAppKey();
    const appSecret = await this.configManager.fetchRongcloudAppSecret(nodeToken, nodeId);

    if (!appKey || !appSecret) {
      throw new Error('融云配置未找到，请先配置 rongcloud_app_key 和 rongcloud_app_secret');
    }

    this._cachedConfig = { appKey, appSecret };
    this._cachedConfigTime = now;
    return this._cachedConfig;
  }

  /**
   * 强制刷新融云配置缓存，用于启动预热。
   */
  async refreshRongCloudConfig() {
    this._cachedConfig = null;
    this._cachedConfigTime = 0;
    return this._getRongCloudConfig();
  }

  /**
   * 发送单聊流式消息(B3:RC:StreamMsg 升级,B4 删除旧纯文本模式)。
   *
   * 规范契约(CARD-SPEC.md §8.3,两层包装):
   *   RC:StreamMsg
   *   ├── content.extra (卡片壳): { stream_type:"card", card_template:"ai_streaming", card_id, title, version, actions }
   *   └── content.content (stream_delta): StreamDelta JSON 字符串
   *
   * StreamDelta 结构(规范 §7):
   *   { content?, reasoning_content?, tools?, pending_interaction?,
   *     session_status: thinking|responding|tool_executing|waiting_interaction|completed|error|cancelled,
   *     seq, is_final?, error? }
   *
   * @param {Object} p
   * @param {string} p.fromUserId
   * @param {string} p.toUserId
   * @param {string} p.streamId
   * @param {boolean} [p.isFirstChunk=false]
   * @param {boolean} [p.isLastChunk=false]
   * @param {number} [p.seq=1]
   * @param {string} [p.messageUID] 首流后服务端返回的 messageUID,后续流带上以续流
   * @param {Object} p.streamDelta B4 必传:StreamDelta 对象(序列化为 content.content)
   * @param {Object} [p.extra] B3:卡片壳对象(stream_type/card_template/card_id/title/version/actions),
   *                            首流时写入 content.extra 让前端渲染卡片壳并续流
   * @throws {Error} streamDelta 缺失时抛错
   */
  async sendStreamPrivate({
    fromUserId,
    toUserId,
    streamId,
    isFirstChunk = false,
    isLastChunk = false,
    seq = 1,
    messageUID = null,
    streamDelta,
    extra = null,
  }) {
    const { appKey, appSecret } = await this._getRongCloudConfig();

    const contentBody = this._buildStreamContentBody({
      isLastChunk,
      seq,
      isFirstChunk,
      streamDelta,
      extra,
    });

    if (!isFirstChunk && messageUID) {
      contentBody.messageUID = messageUID;
    }

    const data = {
      fromUserId,
      toUserId,
      objectName: 'RC:StreamMsg',
      content: contentBody,
      isPersisted: isFirstChunk || isLastChunk ? 1 : 0,
      isCounted: isFirstChunk ? 1 : 0,
      disableUpdateLastMsg: !isLastChunk
    };

    this.log?.info(`[RongCloudServerAPI] 发送单聊流式消息: to=${toUserId}, streamId=${streamId}, first=${isFirstChunk}, last=${isLastChunk}, seq=${seq}, hasExtra=${!!extra}`);
    return this.request('/v3/message/private/publish_stream.json', data, appKey, appSecret);
  }

  /**
   * 发送群聊流式消息(B3:同 sendStreamPrivate 升级,B4 删除旧纯文本模式)
   * @see sendStreamPrivate 参数说明
   */
  async sendStreamGroup({
    fromUserId,
    toGroupId,
    streamId,
    isFirstChunk = false,
    isLastChunk = false,
    seq = 1,
    messageUID = null,
    streamDelta,
    extra = null,
  }) {
    const { appKey, appSecret } = await this._getRongCloudConfig();

    const contentBody = this._buildStreamContentBody({
      isLastChunk,
      seq,
      isFirstChunk,
      streamDelta,
      extra,
    });

    if (!isFirstChunk && messageUID) {
      contentBody.messageUID = messageUID;
    }

    const data = {
      fromUserId,
      toGroupId,
      objectName: 'RC:StreamMsg',
      content: contentBody,
      isPersisted: isFirstChunk || isLastChunk ? 1 : 0,
      isCounted: isFirstChunk ? 1 : 0,
      isIncludeSender: 1,
      disableUpdateLastMsg: !isLastChunk
    };

    this.log?.info(`[RongCloudServerAPI] 发送群聊流式消息: to=${toGroupId}, streamId=${streamId}, first=${isFirstChunk}, last=${isLastChunk}, seq=${seq}, hasExtra=${!!extra}`);
    return this.request('/v3/message/group/publish_stream.json', data, appKey, appSecret);
  }

  /**
   * 构造 RC:StreamMsg 的 content body(B3 抽出,B4 删除旧纯文本回退,单聊/群聊共用)。
   *
   * 规范 §8.3 两层包装:
   *   - streamDelta 必传 → content.content = JSON.stringify(streamDelta)
   *   - extra 提供 + 首流 → content.extra = extra(卡片壳,前端据此渲染 ai_streaming 卡并续流)
   *
   * 字段映射:
   *   - complete: isLastChunk(融云原生字段,表示流结束)
   *   - seq: 序号(融云原生,与 StreamDelta.seq 一致)
   *   - content: StreamDelta JSON 字符串(规范模式)
   *   - extra: 卡片壳(仅首流写,后续流前端按 card_id 续流无需重发)
   *
   * @private
   * @throws {Error} streamDelta 缺失时抛错(规范要求,无旧纯文本回退)
   */
  _buildStreamContentBody({ isLastChunk, seq, isFirstChunk, streamDelta, extra }) {
    if (!streamDelta || typeof streamDelta !== 'object') {
      throw new Error('streamDelta 必传(规范 §7),旧纯文本回退已在 B4 删除');
    }

    const contentBody = {
      complete: isLastChunk,
      seq,
      content: JSON.stringify(streamDelta),
    };

    // 每个 chunk 都写 extra 卡片壳，确保前端无需依赖首流即可拿到 card_id
    //（首流可能因分页/离线未加载，导致后续流无法定位卡片）
    if (extra && typeof extra === 'object') {
      contentBody.extra = extra;
    }

    return contentBody;
  }

  /**
   * 发送 typing 状态
   */
  async sendTypingStatus({ fromUserId, toUserId, conversationType = 1 }) {
    const { appKey, appSecret } = await this._getRongCloudConfig();
    
    const content = JSON.stringify({ typingContentType: 'RC:TxtMsg' }, { ensureAscii: false });
    
    const data = {
      fromUserId,
      toUserId,
      objectName: 'RC:TypSts',
      content,
      isPersisted: 0,
      isCounted: 0
    };

    this.log?.info(`[RongCloudServerAPI] 发送 typing 状态: ${fromUserId} -> ${toUserId}`);
    
    if (conversationType === 3) {
      return this.requestForm('/message/group/publish.json', data, appKey, appSecret);
    }
    return this.requestForm('/message/private/publish.json', data, appKey, appSecret);
  }

  /**
   * 发送单聊媒体/卡片消息（通过融云 Server REST API）
   * 绕过 client SDK 的 registerMessageType 限制
   */
  async sendPrivateMessage({ fromUserId, toUserId, objectName, content }) {
    const { appKey, appSecret } = await this._getRongCloudConfig();

    const data = {
      fromUserId,
      toUserId,
      objectName,
      content: JSON.stringify(content),
      isPersisted: 1,
      isCounted: 1,
    };

    this.log?.info(`[RongCloudServerAPI] 发送单聊消息: ${objectName} -> ${toUserId}`);
    return this.requestForm('/message/private/publish.json', data, appKey, appSecret);
  }
}

module.exports = { RongCloudServerAPI };
