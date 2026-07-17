/**
 * OpenCode Runner(SSE 异步真实流式)
 *
 * 通过 @opencode-ai/sdk 与 OpenCode server 交互。
 * 参考 opencode-clawmessenger/src/opencode/client.ts + event-handler.ts。
 *
 * 与旧版(CLI spawn)的关键差异:
 *   - sendMessage(chatId,msg) 改为 fire-and-forget:内部 promptAsync 触发后立即返回 void,
 *     真实回复由 EventHandler 消费 SSE 流(message.part.delta)驱动流式发送
 *   - chatId → sessionId 映射仍持久化(sessions.json),便于复用历史会话
 *   - 失败重试逻辑移除(promptAsync 失败由调用方捕获并发错误卡片)
 *   - 快捷命令(/models 等)仍走 execAsync('opencode ...') CLI,不在本类
 *
 * 依赖:
 *   - 持有的 opencode client(OpencodeClient,封装 SDK)
 *   - 持有的 eventHandler(EventHandler,消费 SSE 流并回调发送流片)
 *   - 两者由 worker 在启动时注入(见 worker.js)
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { OpencodeClient } = require('./opencode-client');
const { EventHandler } = require('./event-handler');
const { buildStreamExtra } = require('../skills/ops-assistant/stream-builders');

/**
 * 判断错误是否为 session stale(已被 server 删除)。
 * 匹配特征(任一即成立):
 *   - error.name === 'NotFoundError'(SDK 错误类型)
 *   - 消息含 "Session not found" 或 "session not found"
 *   - 消息含 "[404" 状态标记(opencode-client 抛错格式: `发送消息失败: {...} [404 Not Found]`)
 *
 * 用于 _doSendMessage 的自愈兜底:检测到 stale 后清除本地 session 映射并重试。
 *
 * @param {Error} err
 * @returns {boolean}
 */
function _isSessionNotFoundError(err) {
  if (!err || typeof err.message !== 'string') return false;
  const msg = err.message;
  if (err.name === 'NotFoundError') return true;
  if (msg.includes('Session not found') || msg.includes('session not found')) return true;
  if (msg.includes('[404')) return true;
  return false;
}

class OpencodeRunner {
  /**
   * @param {Object} options
   * @param {string} options.directory - opencode 工作目录(含 .opencode/prompt.md)
   * @param {string} [options.opencodeUrl='http://127.0.0.1:4096'] opencode server 地址
   * @param {string} [options.password] - Basic auth 密码(OPENCODE_SERVER_PASSWORD)
   * @param {number} [options.timeout] - 兼容旧参数(不再用于 spawn 超时,保留以避免破坏调用方)
   * @param {string} [options.sessionFile] - session 持久化文件路径
   * @param {Object} [options.log] - 日志对象
   */
  constructor(options) {
    this.directory = options.directory || process.cwd();
    this.opencodeUrl = options.opencodeUrl || 'http://127.0.0.1:4096';
    this.password = options.password || null;
    this.timeout = options.timeout || 600000;
    this.sessionFile =
      options.sessionFile || path.join(os.homedir(), '.config', 'opencode', 'ops-assistant-sessions.json');
    this.log = options.log || console;

    /** @type {Map<string, {id:string, lastUsed:number}>} chatId → session */
    this.sessions = new Map();

    // per-chatId 串行队列:同一 chatId 的 promptAsync 按顺序触发(避免并发乱序)
    /** @type {Map<string, Promise<void>>} */
    this.chatQueues = new Map();

    this.systemPrompt = this._loadSystemPrompt();
    this._loadSessions();

    /** @type {OpencodeClient|null} */
    this.opencode = null;
    /** @type {EventHandler|null} */
    this.eventHandler = null;
    /** SSE 是否已启动 */
    this._sseStarted = false;
    /** cardId → { sessionId, routeCtx } 的活跃流索引,用于 stop 命令 */
    this.activeStreams = new Map();
  }

  _loadSystemPrompt() {
    const promptPath = path.join(this.directory, '.opencode', 'prompt.md');
    if (fs.existsSync(promptPath)) {
      try {
        const content = fs.readFileSync(promptPath, 'utf8');
        if (content.trim().length > 0) {
          this.log.info(`[OpencodeRunner] Loaded system prompt: ${promptPath} (${content.length} chars)`);
          return content.trim();
        }
      } catch (err) {
        this.log.warn(`[OpencodeRunner] Failed to load system prompt: ${err.message}`);
      }
    } else {
      this.log.warn(`[OpencodeRunner] System prompt not found: ${promptPath}`);
    }
    return null;
  }

  _loadSessions() {
    try {
      if (fs.existsSync(this.sessionFile)) {
        const data = JSON.parse(fs.readFileSync(this.sessionFile, 'utf8'));
        if (data.sessions && typeof data.sessions === 'object') {
          for (const [key, value] of Object.entries(data.sessions)) {
            this.sessions.set(key, value);
          }
        }
        this.log.info(`[OpencodeRunner] Loaded ${this.sessions.size} sessions from ${this.sessionFile}`);
      }
    } catch (err) {
      this.log.warn(`[OpencodeRunner] Failed to load sessions: ${err.message}`);
    }
  }

  _saveSessions() {
    try {
      const dir = path.dirname(this.sessionFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data = { sessions: Object.fromEntries(this.sessions) };
      fs.writeFileSync(this.sessionFile, JSON.stringify(data, null, 2));
    } catch (err) {
      this.log.warn(`[OpencodeRunner] Failed to save sessions: ${err.message}`);
    }
  }

  /**
   * 初始化 OpenCode SDK client 与 EventHandler。
   * 注入 OpsAssistantSkill 的发送回调(sendStreamChunk / sendFinalCard / sendErrorCard)。
   * 启动 SSE 事件流(后台异步循环,不阻塞)。
   *
   * @param {Object} callbacks
   * @param {Function} callbacks.sendStreamChunk
   * @param {Function} callbacks.sendFinalCard
   * @param {Function} callbacks.sendErrorCard
   */
  async initSse(callbacks) {
    if (this._sseStarted) {
      this.log.info('[OpencodeRunner] SSE 已启动,跳过重复初始化');
      return;
    }

    this.opencode = new OpencodeClient({
      baseUrl: this.opencodeUrl,
      directory: this.directory,
      password: this.password,
      systemPrompt: this.systemPrompt,
      log: this.log,
    });

    this.eventHandler = new EventHandler({
      opencode: this.opencode,
      log: this.log,
      sendStreamChunk: callbacks.sendStreamChunk,
      sendFinalCard: callbacks.sendFinalCard,
      sendErrorCard: callbacks.sendErrorCard,
      onStreamEnd: (cardId) => {
        this.activeStreams.delete(cardId);
      },
    });

    // 连接 SSE 流并启动事件循环
    try {
      const eventStream = await this.opencode.subscribeGlobalEvents();
      await this.eventHandler.start(eventStream);
      this._sseStarted = true;
      this.log.info('[OpencodeRunner] SSE 事件流已启动(真实流式)');
    } catch (err) {
      this.log.error(`[OpencodeRunner] SSE 启动失败,流式将不可用: ${err.message}`);
      // EventHandler 内部会在 isRunning 后自动重试订阅,但首次失败时 start 未调用
      // 这里降级:即便首次订阅失败,也标记启动以便后续重试
      this._sseStarted = true;
      // 触发一次后台重试循环
      this._retrySubscribeInBackground();
    }
  }

  /**
   * SSE 首次连接失败时的后台重试(指数退避)
   */
  _retrySubscribeInBackground() {
    const attempt = async () => {
      while (this._sseStarted && this.eventHandler && !this.eventHandler.isRunning) {
        try {
          const eventStream = await this.opencode.subscribeGlobalEvents();
          await this.eventHandler.start(eventStream);
          this.log.info('[OpencodeRunner] SSE 后台重连成功');
          return;
        } catch (err) {
          this.log.warn(`[OpencodeRunner] SSE 后台重连失败: ${err.message},5s 后重试`);
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    };
    attempt().catch((err) => this.log.error(`[OpencodeRunner] SSE 后台重试异常: ${err.message}`));
  }

  /**
   * 发送消息(异步真实流式)。
   *
   * 语义变化(关键!):
   *   - 旧版返回 Promise<string>,阻塞等待完整回复
   *   - 新版 fire-and-forget,触发 promptAsync 后立即返回 void
   *   - 真实回复由 EventHandler 消费 SSE 流(message.part.delta → 回调 sendStreamChunk)
   *
   * 因此本方法不再返回回复内容,调用方(OpsAssistantSkill.handle)在发完 thinking 首流后
   * 立即返回,后续流式完全由 SSE 驱动。
   *
   * @param {string} chatId - 会话标识(如 ops-<senderUserId>)
   * @param {string} message - 用户消息
   * @param {Object} [options]
   * @param {Object} [options.routeCtx] - 路由上下文(必需,用于注册 SSE 路由映射)
   *   @param {string} options.routeCtx.targetId
   *   @param {string} options.routeCtx.senderUserId
   *   @param {number} options.routeCtx.convType
   *   @param {string} options.routeCtx.cardId
   *   @param {string} options.routeCtx.streamId
   * @returns {Promise<void>}
   */
  async sendMessage(chatId, message, options = {}) {
    const routeCtx = options.routeCtx;
    if (!routeCtx) {
      throw new Error('OpencodeRunner.sendMessage 需要 options.routeCtx(SSE 路由上下文)');
    }

    // 串行化:同一 chatId 的 promptAsync 按顺序触发
    const prev = this.chatQueues.get(chatId) || Promise.resolve();
    const run = prev.then(
      () => this._doSendMessage(chatId, message, routeCtx),
      () => this._doSendMessage(chatId, message, routeCtx),
    );
    const tail = run.then(() => undefined, () => undefined);
    this.chatQueues.set(chatId, tail);
    void tail.then(() => {
      if (this.chatQueues.get(chatId) === tail) this.chatQueues.delete(chatId);
    });
    // 不返回执行结果(fire-and-forget 语义由调用方决定)
    // 但若有错误需抛出,调用方可 await run
    return run;
  }

  async _doSendMessage(chatId, message, routeCtx) {
    if (!this.opencode || !this.eventHandler) {
      throw new Error('OpencodeRunner 未初始化 SSE(请先调用 initSse)');
    }

    // 复用或创建 session,并注册 SSE 路由。返回 { session, sessionId }。
    // 抽成内部方法便于 stale session 自愈后重试复用。
    const resolveAndRegister = async () => {
      let session = this.sessions.get(chatId);
      if (!session) {
        try {
          const created = await this.opencode.createSession(`ops-assistant ${chatId}`);
          session = { id: created.id, lastUsed: Date.now() };
          this.sessions.set(chatId, session);
          this._saveSessions();
          this.log.info(`[OpencodeRunner] 新建 session: ${created.id} for chatId=${chatId}`);
        } catch (err) {
          throw new Error(`创建会话失败: ${err.message}`);
        }
      } else {
        session.lastUsed = Date.now();
        this._saveSessions();
      }

      const sessionId = session.id;

      // 注册 SSE 路由映射(promptAsync 触发前注册,避免首个 delta 到达时无映射)
      this.eventHandler.registerSession(sessionId, {
        chatId,
        targetId: routeCtx.targetId,
        senderUserId: routeCtx.senderUserId,
        convType: routeCtx.convType,
        cardId: routeCtx.cardId,
        streamId: routeCtx.streamId,
        extra: buildStreamExtra({ cardId: routeCtx.cardId, title: '' }),
      });

      // 注册活跃流索引,供 stop 命令查找 sessionId
      this.activeStreams.set(routeCtx.cardId, { sessionId, routeCtx });
      this.log.info(`[OpencodeRunner] 注册活跃流: cardId=${routeCtx.cardId}, sessionId=${sessionId}`);

      return { session, sessionId };
    };

    const { sessionId } = await resolveAndRegister();

    // 异步触发 prompt(fire-and-forget,真实回复由 SSE 驱动)
    try {
      await this.opencode.promptAsync(sessionId, message);
    } catch (err) {
      // 触发失败:清理刚注册的映射。
      this.eventHandler.streamStates.delete(sessionId);

      // 自愈:若失败是 session stale(404 / NotFoundError / Session not found),
      // 清除本地 session 映射,新建 session 后重试 promptAsync 一次。
      // 根因:用户通过 /session-use 指定或历史残留了一个已被 server 删除的 sessionId,
      // runner 复用前不校验存在性,这里作为最后一道兜底。
      if (_isSessionNotFoundError(err)) {
        this.log.warn(
          `[OpencodeRunner] session 不存在(stale),清除本地映射并重试: chatId=${chatId}, sessionId=${sessionId}, err=${err.message}`,
        );
        this.clearSession(chatId);
        // 清理活跃流索引中的旧 entry,resolveAndRegister 会用新 sessionId 覆盖
        this.activeStreams.delete(routeCtx.cardId);
        const retry = await resolveAndRegister();
        try {
          await this.opencode.promptAsync(retry.sessionId, message);
          this.log.info(
            `[OpencodeRunner] stale session 自愈成功: chatId=${chatId}, newSessionId=${retry.sessionId}`,
          );
          return;
        } catch (retryErr) {
          this.eventHandler.streamStates.delete(retry.sessionId);
          throw retryErr;
        }
      }

      throw err;
    }
  }

  /**
   * 停止指定 cardId 对应的活跃流
   * @param {string} cardId
   * @returns {Promise<{stopped: boolean, reason?: string}>}
   */
  async stopStream(cardId) {
    const entry = this.activeStreams.get(cardId);
    if (!entry) {
      this.log.warn(`[OpencodeRunner] stopStream: 未找到 cardId=${cardId} 对应的活跃流`);
      return { stopped: false, reason: '未找到活跃流' };
    }
    const { sessionId, routeCtx } = entry;
    this.log.info(`[OpencodeRunner] stopStream: cardId=${cardId}, sessionId=${sessionId}`);
    try {
      await this.opencode.abortSession(sessionId);
    } catch (err) {
      this.log.warn(`[OpencodeRunner] abortSession 失败: ${err.message}`);
      // 继续:即使 abort 请求失败,也标记本地流已取消,避免无限等待
    }
    if (this.eventHandler) {
      await this.eventHandler.cancelStream(sessionId);
    }
    this.activeStreams.delete(cardId);
    return { stopped: true };
  }

  /**
   * 清除指定 chatId 的 session
   * @param {string} chatId
   */
  clearSession(chatId) {
    this.sessions.delete(chatId);
    this._saveSessions();
    this.log.info(`[OpencodeRunner] Session cleared for chatId=${chatId}`);
  }
}

module.exports = { OpencodeRunner };
