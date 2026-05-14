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
   * 获取融云配置
   */
  async _getRongCloudConfig() {
    const configs = await this.configManager.getConfigs([
      'rongcloud_app_key',
      'rongcloud_app_secret'
    ]);
    
    if (!configs.rongcloud_app_key || !configs.rongcloud_app_secret) {
      throw new Error('融云配置未找到，请先配置 rongcloud_app_key 和 rongcloud_app_secret');
    }
    
    return {
      appKey: configs.rongcloud_app_key,
      appSecret: configs.rongcloud_app_secret
    };
  }

  /**
   * 发送单聊流式消息
   */
  async sendStreamPrivate({
    fromUserId,
    toUserId,
    content,
    streamId,
    isFirstChunk = false,
    isLastChunk = false,
    seq = 1,
    streamType = 'markdown',
    messageUID = null
  }) {
    const { appKey, appSecret } = await this._getRongCloudConfig();
    
    const contentBody = {
      content,
      complete: isLastChunk,
      seq
    };

    if (isFirstChunk) {
      contentBody.type = streamType;
    }

    if (!isFirstChunk && messageUID) {
      contentBody.messageUID = messageUID;
    }

    const data = {
      fromUserId,
      toUserId,
      objectName: 'RC:StreamMsg',
      content: contentBody,
      isPersisted: 1,
      isCounted: isFirstChunk ? 1 : 0,
      disableUpdateLastMsg: !isLastChunk
    };

    this.log?.info(`[RongCloudServerAPI] 发送单聊流式消息: to=${toUserId}, streamId=${streamId}, first=${isFirstChunk}, last=${isLastChunk}, seq=${seq}`);
    return this.request('/v3/message/private/publish_stream.json', data, appKey, appSecret);
  }

  /**
   * 发送群聊流式消息
   */
  async sendStreamGroup({
    fromUserId,
    toGroupId,
    content,
    streamId,
    isFirstChunk = false,
    isLastChunk = false,
    seq = 1,
    streamType = 'markdown',
    messageUID = null
  }) {
    const { appKey, appSecret } = await this._getRongCloudConfig();
    
    const contentBody = {
      content,
      complete: isLastChunk,
      seq
    };

    if (isFirstChunk) {
      contentBody.type = streamType;
    }

    if (!isFirstChunk && messageUID) {
      contentBody.messageUID = messageUID;
    }

    const data = {
      fromUserId,
      toGroupId,
      objectName: 'RC:StreamMsg',
      content: contentBody,
      isPersisted: 1,
      isCounted: isFirstChunk ? 1 : 0,
      isIncludeSender: 1,
      disableUpdateLastMsg: !isLastChunk
    };

    this.log?.info(`[RongCloudServerAPI] 发送群聊流式消息: to=${toGroupId}, streamId=${streamId}, first=${isFirstChunk}, last=${isLastChunk}, seq=${seq}`);
    return this.request('/v3/message/group/publish_stream.json', data, appKey, appSecret);
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
}

module.exports = { RongCloudServerAPI };
