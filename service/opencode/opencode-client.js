/**
 * OpenCode SDK 客户端封装(基于 @opencode-ai/sdk,异步真实流式)
 *
 * 参考 opencode-clawmessenger/src/opencode/client.ts 精简为 CommonJS 版。
 * SDK 是 ESM-only,这里用动态 import() 加载。
 *
 * 核心方法:
 *   - createSession(title?)      创建新会话
 *   - promptAsync(sessionId,msg) 异步触发 prompt(fire-and-forget,真实回复由 SSE 事件流驱动)
 *   - subscribeGlobalEvents()    订阅全局 SSE 事件流(message.part.delta / session.idle / ...)
 *   - fetchLastMessageText(sid)  读取会话最后一条消息文本(兜底用)
 *
 * 注意:promptAsync 不等待回复,真正的 token 级增量由 EventHandler 消费 SSE 流得到。
 */
const path = require('path');
const fs = require('fs');
const url = require('url');
const axios = require('axios');

const REASONING_INSTRUCTION = `CRITICAL RULE — DO NOT IGNORE:
1. Output ONLY the final answer in the main response text.
2. ALL internal reasoning, planning, thinking, tool-use process, and self-reflection MUST be placed entirely inside <thinking>...</thinking> tags.
3. ONLY text outside <thinking> tags will be shown to the user.
4. NEVER put the answer inside <thinking> tags.
5. NEVER output raw reasoning outside <thinking> tags.
6. NEVER interleave reasoning with the answer. The answer must be a continuous, clean response without any internal monologue.
7. Begin your visible answer immediately; do not start with phrases like "I should", "Let me", "Actually," or "The user wants".
8. If the user's message is in Chinese, the visible answer should be in Chinese. Any English planning or reflection must be hidden inside <thinking> tags.`;

/** 缓存 SDK 模块,避免每次 promptAsync 都重复 import */
let _sdkModulePromise = null;

/**
 * 定位 SDK 包目录(@opencode-ai/sdk 的 package.json 所在目录)。
 *
 * SDK 是纯 ESM 包(exports 字段仅定义 "import" 条件),
 * CommonJS 的 require.resolve / createRequire().resolve 无法解析其子路径
 * (会报 "Package subpath './v2/client' is not defined by exports")。
 * 这里改用 require.cache 的 module.paths 向上查找 node_modules 的标准方式定位包目录,
 * 再手动拼接 dist/v2/client.js 并用 file:// URL 动态 import。
 *
 * @returns {string} SDK 包根目录绝对路径
 */
function findSdkDir() {
  // require.resolve 的 paths 数组是 Node 向上查找 node_modules 的候选目录
  const paths = require.resolve.paths('@opencode-ai/sdk') || [];
  for (const p of paths) {
    const candidate = path.join(p, '@opencode-ai', 'sdk');
    if (fs.existsSync(path.join(candidate, 'package.json'))) {
      return candidate;
    }
  }
  throw new Error('找不到 @opencode-ai/sdk 包目录(请先 npm install)');
}

/**
 * 动态加载 SDK 的 createOpencodeClient(v2 路径,与 opencode-clawmessenger 一致)。
 * SDK 是 ESM-only,用 file:// URL 动态 import 加载。
 * @returns {Promise<{createOpencodeClient: Function}>}
 */
function loadSdk() {
  if (_sdkModulePromise) return _sdkModulePromise;
  _sdkModulePromise = (async () => {
    const sdkDir = findSdkDir();
    const sdkPath = path.join(sdkDir, 'dist', 'v2', 'client.js');
    if (!fs.existsSync(sdkPath)) {
      throw new Error(`SDK 入口不存在: ${sdkPath}(可能 SDK 版本结构变化,请检查 dist/v2/client.js)`);
    }
    const fileUrl = url.pathToFileURL(sdkPath).href;
    return import(fileUrl);
  })();
  return _sdkModulePromise;
}

/**
 * 序列化错误对象为可读字符串(JSON.stringify(Error) 会返回 {})
 */
function serializeError(error) {
  if (error instanceof Error) return error.message || error.name || 'Unknown Error';
  if (error && typeof error === 'object') {
    if (error.message) return typeof error.message === 'string' ? error.message : JSON.stringify(error.message);
    if (error.error) return typeof error.error === 'string' ? error.error : JSON.stringify(error.error);
    if (error.detail) return error.detail;
    if (error.statusText) return error.statusText;
    return JSON.stringify(error);
  }
  return String(error);
}

class OpencodeClient {
  /**
   * @param {Object} options
   * @param {string} options.baseUrl       opencode server 地址(如 http://127.0.0.1:4096)
   * @param {string} [options.directory]   工作目录
   * @param {string} [options.password]    Basic auth 密码(OPENCODE_SERVER_PASSWORD)
   * @param {string} [options.systemPrompt]系统 prompt(注入到每次 prompt)
   * @param {Object} [options.log]         日志对象
   */
  constructor(options) {
    this.baseUrl = options.baseUrl;
    this.directory = options.directory || process.cwd();
    this.systemPrompt = options.systemPrompt
      ? REASONING_INSTRUCTION + '\n\n' + options.systemPrompt
      : REASONING_INSTRUCTION;
    this.log = options.log || console;
    this._clientPromise = null;
  }

  /**
   * 延迟初始化底层 SDK client(首次调用时加载 ESM 模块并构造)
   * @returns {Promise<any>}
   */
  async _getClient() {
    if (this._clientPromise) return this._clientPromise;
    this._clientPromise = (async () => {
      const { createOpencodeClient } = await loadSdk();
      const config = {
        baseUrl: this.baseUrl,
        directory: this.directory,
      };
      if (this.password) {
        config.headers = {
          Authorization: `Basic ${Buffer.from(`opencode:${this.password}`).toString('base64')}`,
        };
      }
      const client = createOpencodeClient(config);
      this.log.info(`[OpencodeClient] SDK client ready: baseUrl=${this.baseUrl}, dir=${this.directory}, hasPrompt=${!!this.systemPrompt}`);
      return client;
    })();
    return this._clientPromise;
  }

  /** 设置/覆盖 system prompt(例如运行时从 prompt.md 加载) */
  setSystemPrompt(prompt) {
    this.systemPrompt = prompt
      ? REASONING_INSTRUCTION + '\n\n' + prompt
      : REASONING_INSTRUCTION;
  }

  getDirectory() {
    return this.directory;
  }

  /**
   * 创建新会话
   * @param {string} [title]
   * @returns {Promise<{id: string}>}
   */
  async createSession(title) {
    const client = await this._getClient();
    const { data, error, response } = await client.session.create({
      title: title || 'ops-assistant',
      directory: this.directory,
    });
    if (error) {
      const errStr = serializeError(error);
      const statusText = response?.statusText ? ` [${response.status} ${response.statusText}]` : '';
      throw new Error(`创建会话失败: ${errStr}${statusText}`);
    }
    const sessionId = data?.id || data?.session_id;
    if (!sessionId) throw new Error('创建会话返回空 ID');
    this.log.info(`[OpencodeClient] Session created: ${sessionId}`);
    return { id: sessionId };
  }

  /**
   * 中止活跃会话
   * @param {string} sessionId
   * @returns {Promise<void>}
   */
  async abortSession(sessionId) {
    const client = await this._getClient();
    const { error, response } = await client.session.abort({
      sessionID: sessionId,
      directory: this.directory,
    });
    if (error) {
      const errStr = serializeError(error);
      const statusText = response?.statusText ? ` [${response.status} ${response.statusText}]` : '';
      throw new Error(`中止会话失败: ${errStr}${statusText}`);
    }
    this.log.info(`[OpencodeClient] session aborted: ${sessionId}`);
  }

  /**
   * 异步触发 prompt(fire-and-forget)。
   * 真实回复通过订阅全局 SSE 流(message.part.delta / session.idle)在 EventHandler 中消费。
   *
   * @param {string} sessionId
   * @param {string} text
   * @returns {Promise<void>}
   */
  async promptAsync(sessionId, text) {
    const client = await this._getClient();
    const { error, response } = await client.session.promptAsync({
      sessionID: sessionId,
      directory: this.directory,
      system: this.systemPrompt,
      parts: [{ type: 'text', text }],
    });
    if (error) {
      const errStr = serializeError(error);
      const statusText = response?.statusText ? ` [${response.status} ${response.statusText}]` : '';
      throw new Error(`发送消息失败: ${errStr}${statusText}`);
    }
    this.log.info(`[OpencodeClient] promptAsync fired: session=${sessionId}, len=${text.length}`);
  }

  /**
   * 订阅全局 SSE 事件流。返回 { stream: AsyncGenerator }。
   * EventHandler 消费该流以获取 token 级真实增量。
   * @returns {Promise<{stream: AsyncGenerator}>}
   */
  async subscribeGlobalEvents() {
    const client = await this._getClient();
    const result = await client.global.event({});
    this.log.info('[OpencodeClient] Global SSE stream connected');
    return result;
  }

  /**
   * 兜底:读取会话最后一条 AI 消息的文本(用于 session.idle 但中途未流式过的场景)
   * @param {string} sessionId
   * @returns {Promise<string|null>}
   */
  async fetchLastMessageText(sessionId) {
    const client = await this._getClient();
    try {
      const { data: messages } = await client.session.messages({
        sessionID: sessionId,
        directory: this.directory,
      });
      if (messages && Array.isArray(messages) && messages.length > 0) {
        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i];
          const role = msg.role || msg.author?.role;
          if (role === 'assistant' || role === 'model') {
            if (msg.parts && msg.parts.length > 0) {
              const textPart = msg.parts.find((p) => p.type === 'text');
              if (textPart && textPart.text) return textPart.text;
            }
          }
        }
        const lastMsg = messages[messages.length - 1];
        if (lastMsg.parts && lastMsg.parts.length > 0) {
          const textPart = lastMsg.parts.find((p) => p.type === 'text');
          if (textPart && textPart.text) return textPart.text;
        }
      }
    } catch (err) {
      this.log.error(`[OpencodeClient] fetchLastMessageText failed: ${err.message}`);
    }
    return null;
  }

  /**
   * 读取当前 OpenCode 配置(用于获取当前模型等)。
   * @returns {Promise<Object>}
   */
  async getConfig() {
    const client = await this._getClient();
    const { data, error, response } = await client.config.get({
      directory: this.directory,
    });
    if (error) {
      const errStr = serializeError(error);
      const statusText = response?.statusText ? ` [${response.status} ${response.statusText}]` : '';
      throw new Error(`读取配置失败: ${errStr}${statusText}`);
    }
    return data || {};
  }

  /**
   * 列出所有可用的 AI 提供商及其模型。
   * @returns {Promise<Object>}
   */
  async listProviders() {
    const client = await this._getClient();
    const { data, error, response } = await client.provider.list({
      directory: this.directory,
    });
    if (error) {
      const errStr = serializeError(error);
      const statusText = response?.statusText ? ` [${response.status} ${response.statusText}]` : '';
      throw new Error(`列出提供商失败: ${errStr}${statusText}`);
    }
    return data || {};
  }

  /**
   * 切换指定会话的模型。
   * @param {string} sessionId
   * @param {string} model
   * @returns {Promise<Object>}
   */
  async switchModel(sessionId, model) {
    const url = `${this.baseUrl.replace(/\/$/, '')}/api/session/${encodeURIComponent(sessionId)}/model`;
    const headers = {
      'Content-Type': 'application/json',
    };
    if (this.password) {
      headers.Authorization = `Basic ${Buffer.from(`opencode:${this.password}`).toString('base64')}`;
    }
    try {
      const { data } = await axios.post(url, { model }, { headers });
      this.log.info(`[OpencodeClient] 会话 ${sessionId} 模型已切换为 ${model}`);
      return data;
    } catch (err) {
      const msg = err.response?.data?.message || err.response?.data?.error || err.message;
      throw new Error(`切换模型失败: ${msg}`);
    }
  }
}

module.exports = { OpencodeClient, serializeError, loadSdk };
