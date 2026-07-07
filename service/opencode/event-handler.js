/**
 * OpenCode SSE 事件处理器(异步真实流式)
 *
 * 参考 opencode-clawmessenger/src/opencode/event-handler.ts,精简为 ops-assistant 场景。
 *
 * 核心职责:
 *   1. 消费 opencode 全局 SSE 流(message.part.delta / session.idle / session.error)
 *   2. 维护 sessionId → 路由上下文映射(多用户并发,ops-assistant 是多 senderUserId)
 *   3. message.part.delta → 调 ops-assistant._sendStreamChunk 发真实 token 级增量(responding)
 *   4. session.idle → 发 completed 终态(is_final)+ 最终持久化卡片
 *   5. session.error → 发 error 终态
 *   6. SSE 断线自动重订阅(指数退避,上限 60s)
 *
 * 与 opencode-clawmessenger 的区别:
 *   - ops-assistant 是多用户并发,需要 sessionId → {chatId,targetId,senderUserId,cardId,...} 映射
 *   - 流式发送走 OpsAssistantSkill._sendStreamChunk(已封装 StreamDelta + extra + 串行队列),
 *     而不是直接调融云服务端 API
 *   - 不处理 permission.asked / question.asked(ops-assistant 用 --dangerously-skip-permissions
 *     或由 opencode 自身处理权限,IM 侧不交互授权)
 */
const { buildStreamDelta, buildStreamExtra } = require('../skills/ops-assistant/stream-builders');

/**
 * 单条会话的流式状态(对应 opencode-clawmessenger 的 StreamState)
 * @typedef {Object} StreamState
 * @property {string} chatId           会话标识(如 ops-<senderUserId>)
 * @property {string} targetId         回复目标(融云 targetId)
 * @property {string} senderUserId     发起用户(用于 note 文案)
 * @property {number} convType         会话类型(1=单聊)
 * @property {string} cardId           流式卡片 id(与初始静态卡一致,前端续流依赖)
 * @property {string} streamId         流 ID
 * @property {number} seq              当前序号(0=thinking 首流,responding 逐 delta 递增)
 * @property {string} fullContent      累积的完整内容(session.idle 时用于持久化卡片)
 * @property {boolean} hasSentStream   是否已发送过 responding 流片
 * @property {Object|null} extra       首流 extra 卡片壳(已发送后置 null,避免重复写)
 */

class EventHandler {
  /**
   * @param {Object} options
   * @param {import('./opencode-client').OpencodeClient} options.opencode
   * @param {Object} options.log
   */
  constructor(options) {
    this.opencode = options.opencode;
    this.log = options.log || console;

    /**
     * 回调注入:把流片发送动作委托给 OpsAssistantSkill
     * @type {(targetId:string, streamId:string, isFirstChunk:boolean, isLastChunk:boolean, seq:number, opts:{streamDelta:Object, extra?:Object}) => Promise<void>}
     */
    this.sendStreamChunk = options.sendStreamChunk || null;

    /**
     * 回调注入:发送最终持久化卡片 + 历史 command 消息(session.idle 时)
     * @type {(ctx:{targetId:string, convType:number, senderUserId:string, cardId:string, fullContent:string}) => Promise<void>}
     */
    this.sendFinalCard = options.sendFinalCard || null;

    /**
     * 回调注入:发送错误卡片(session.error 时)
     * @type {(ctx:{targetId:string, convType:number, senderUserId:string, cardId:string, error:string}) => Promise<void>}
     */
    this.sendErrorCard = options.sendErrorCard || null;

    this.isRunning = false;
    /** @type {Map<string, StreamState>} sessionId → 状态 */
    this.streamStates = new Map();
    /** 已完成(发过终态)的 session,避免 session.idle 重复发 */
    this.sentSessions = new Set();
    /** per-session 串行队列(保序) */
    this.streamQueues = new Map();
    this.reconnectAttempts = 0;
  }

  /**
   * 注册 sessionId → 路由上下文映射(promptAsync 触发前调用)
   * @param {string} sessionId
   * @param {Object} ctx
   * @param {string} ctx.chatId
   * @param {string} ctx.targetId
   * @param {string} ctx.senderUserId
   * @param {number} ctx.convType
   * @param {string} ctx.cardId
   * @param {string} ctx.streamId
   * @param {Object} [ctx.extra]   首流 extra 卡片壳
   */
  registerSession(sessionId, ctx) {
    this.streamStates.set(sessionId, {
      chatId: ctx.chatId,
      targetId: ctx.targetId,
      senderUserId: ctx.senderUserId,
      convType: ctx.convType,
      cardId: ctx.cardId,
      streamId: ctx.streamId,
      seq: 0,
      fullContent: '',
      hasSentStream: false,
      extra: ctx.extra || buildStreamExtra({ cardId: ctx.cardId }),
    });
    // 清除可能的"已完成"标记(同一 session 复用)
    this.sentSessions.delete(sessionId);
    this.log.info(`[EventHandler] 注册 session 映射: ${sessionId} → chatId=${ctx.chatId}, cardId=${ctx.cardId}`);
  }

  /**
   * 把一个异步任务追加到指定 session 的串行队列后执行。
   * 不同 session 的队列相互独立(并行),同 session 内保序。
   * 参考 opencode-clawmessenger event-handler.ts:50-60。
   * @template T
   * @param {string} sessionId
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  _enqueueStreamTask(sessionId, task) {
    const prev = this.streamQueues.get(sessionId) || Promise.resolve();
    const run = prev.then(() => task(), () => task());
    const tail = run.then(() => undefined, () => undefined);
    this.streamQueues.set(sessionId, tail);
    void tail.then(() => {
      if (this.streamQueues.get(sessionId) === tail) this.streamQueues.delete(sessionId);
    });
    return run;
  }

  /**
   * 启动 SSE 事件循环(后台异步,不阻塞主流程)
   * @param {{stream: AsyncGenerator}} eventStream
   */
  async start(eventStream) {
    if (this.isRunning) return;
    this.isRunning = true;
    this.log.info('[EventHandler] 启动(SSE 真实流式模式)');
    // 后台运行,不 await(避免阻塞 worker 启动)
    this._runEventLoop(eventStream).catch((err) => {
      this.log.error(`[EventHandler] 事件循环异常退出: ${err.message}`);
    });
  }

  stop() {
    this.isRunning = false;
    this.reconnectAttempts = 0;
    this.streamStates.clear();
    this.sentSessions.clear();
    this.streamQueues.clear();
  }

  /**
   * SSE 事件循环主体。流异常结束/断开后延迟重订阅。
   * 参考 opencode-clawmessenger event-handler.ts:101-153。
   * @param {{stream: AsyncGenerator}} eventStream
   */
  async _runEventLoop(eventStream) {
    while (this.isRunning) {
      try {
        for await (const event of eventStream.stream) {
          if (!this.isRunning) break;
          // SSE 事件结构:{ payload: { type, properties } } 或直接 { type, properties }
          await this._handleEvent(event.payload || event);
        }
        this.log.info('[EventHandler] SSE 流正常结束(EOF)');
      } catch (err) {
        this.log.error(`[EventHandler] SSE 流错误: ${err.message}`);
      }

      if (!this.isRunning) break;

      // 清理断线残留的流式状态(避免会话卡住)
      if (this.streamStates.size > 0) {
        this.log.warn(`[EventHandler] SSE 断线,清理 ${this.streamStates.size} 个残留 streamStates`);
        this.streamStates.clear();
      }
      this.sentSessions.clear();
      this.streamQueues.clear();

      // 指数退避重订阅(上限 60s)
      this.reconnectAttempts = Math.min(this.reconnectAttempts + 1, 6);
      const delay = Math.min(5000 * Math.pow(2, this.reconnectAttempts - 1), 60000);
      this.log.info(`[EventHandler] SSE 将在 ${delay}ms 后重订阅 (第 ${this.reconnectAttempts} 次)`);
      await new Promise((resolve) => setTimeout(resolve, delay));

      if (!this.isRunning) break;

      try {
        eventStream = await this.opencode.subscribeGlobalEvents();
        this.reconnectAttempts = 0;
        this.log.info('[EventHandler] SSE 重订阅成功');
      } catch (err) {
        this.log.error(`[EventHandler] SSE 重订阅失败: ${err.message},将继续重试`);
      }
    }
    this.isRunning = false;
  }

  /**
   * 处理单个 SSE 事件
   * @param {Object} globalEvent
   */
  async _handleEvent(globalEvent) {
    try {
      const eventType = globalEvent?.type || globalEvent?.payload?.type || globalEvent?.event?.type;
      if (!eventType) return;

      // 心跳降噪
      if (eventType === 'server.heartbeat' || eventType === 'server.connected') return;

      const props =
        globalEvent.properties ||
        globalEvent.payload?.properties ||
        globalEvent.payload ||
        globalEvent;

      switch (eventType) {
        case 'session.idle': {
          await this._handleSessionIdle(props);
          break;
        }
        case 'message.part.delta': {
          await this._handleMessagePartDelta(props);
          break;
        }
        case 'session.error': {
          await this._handleSessionError(props);
          break;
        }
        case 'session.created':
        case 'session.compacted':
        case 'session.closed':
        case 'chat.message':
        case 'message.part.updated':
        case 'session.status':
          // ops-assistant 不需要处理这些(权限/问答由 opencode 自身完成)
          this.log.debug(`[EventHandler] 忽略事件: ${eventType}`);
          break;
        default:
          this.log.debug(`[EventHandler] 未知事件: ${eventType}`);
      }
    } catch (err) {
      this.log.error(`[EventHandler] 处理事件异常: ${err.message}`);
    }
  }

  /**
   * 处理 message.part.delta —— 真实 token 级增量。
   * 参考 opencode-clawmessenger event-handler.ts:503-617。
   * @param {Object} properties { sessionID, delta?, text?, part? }
   */
  async _handleMessagePartDelta(properties) {
    const sessionId = properties.sessionID || properties.sessionId;
    if (!sessionId) return;

    // 已发送过终态(completed/error)的 session,丢弃迟到的 delta
    if (this.sentSessions.has(sessionId)) {
      this.log.debug(`[EventHandler] session 已完成,丢弃 delta: ${sessionId}`);
      return;
    }

    const streamState = this.streamStates.get(sessionId);
    if (!streamState) {
      // 没有路由映射:可能是其他客户端触发的 session,或注册丢失,跳过
      this.log.debug(`[EventHandler] delta 无路由映射,跳过: ${sessionId}`);
      return;
    }

    // 提取增量文本(兼容多种字段命名)
    const delta =
      properties.delta || properties.text || properties.part?.delta || properties.part?.text || '';
    if (typeof delta !== 'string') return;
    // 空字符串 delta 是合法的(无新内容块),不跳过

    await this._enqueueStreamTask(sessionId, async () => {
      try {
        streamState.fullContent += delta;

        // 首流(尚未发送过任何流片):先发 thinking 态(seq=0)让前端进入续流
        if (!streamState.hasSentStream) {
          if (this.sendStreamChunk) {
            await this.sendStreamChunk(
              streamState.targetId,
              streamState.streamId,
              true, // isFirstChunk
              false,
              0, // seq=0 thinking
              {
                streamDelta: buildStreamDelta({ content: '', sessionStatus: 'thinking', seq: 0 }),
                extra: streamState.extra,
              },
            );
          }
          streamState.hasSentStream = true;
        }

        // 本次增量跳过空内容(避免无意义的空流片)
        if (delta.length === 0) {
          return;
        }

        streamState.seq += 1;
        if (this.sendStreamChunk) {
          await this.sendStreamChunk(
            streamState.targetId,
            streamState.streamId,
            false, // 非首流
            false,
            streamState.seq,
            {
              streamDelta: buildStreamDelta({ content: delta, sessionStatus: 'responding', seq: streamState.seq }),
              extra: streamState.extra,
            },
          );
        }
        this.log.debug(`[EventHandler] delta 已发送: session=${sessionId}, seq=${streamState.seq}, len=${delta.length}`);
      } catch (err) {
        this.log.error(`[EventHandler] 发送 delta 失败: ${err.message}, session=${sessionId}`);
      }
    });
  }

  /**
   * 处理 session.idle —— 会话完成,发 completed 终态 + 持久化卡片。
   * 参考 opencode-clawmessenger event-handler.ts:619-704。
   * @param {Object} properties { sessionID }
   */
  async _handleSessionIdle(properties) {
    const sessionId = properties.sessionID || properties.sessionId;
    if (!sessionId) return;

    if (this.sentSessions.has(sessionId)) {
      this.log.debug(`[EventHandler] session.idle 重复,跳过: ${sessionId}`);
      return;
    }

    const streamState = this.streamStates.get(sessionId);
    if (!streamState) {
      this.log.debug(`[EventHandler] session.idle 无路由映射,跳过: ${sessionId}`);
      return;
    }

    await this._enqueueStreamTask(sessionId, async () => {
      try {
        // 如果 delta 流片一次都没发过(可能 LLM 直接没产文本,或全部被过滤),
        // 兜底:发一个空 thinking + completed,让前端正确收尾
        if (!streamState.hasSentStream) {
          if (this.sendStreamChunk) {
            await this.sendStreamChunk(
              streamState.targetId,
              streamState.streamId,
              true,
              false,
              0,
              {
                streamDelta: buildStreamDelta({ content: '', sessionStatus: 'thinking', seq: 0 }),
                extra: streamState.extra,
              },
            );
          }
          streamState.hasSentStream = true;
        }

        // completed 终态(is_final,完整内容)
        const fullContent = streamState.fullContent || '';
        streamState.seq += 1;
        if (this.sendStreamChunk) {
          await this.sendStreamChunk(
            streamState.targetId,
            streamState.streamId,
            false,
            true, // isLastChunk
            streamState.seq,
            {
              streamDelta: buildStreamDelta({
                content: fullContent,
                sessionStatus: 'completed',
                seq: streamState.seq,
                isFinal: true,
              }),
              extra: streamState.extra,
            },
          );
        }

        // 最终持久化卡片(规范 CardModel)+ 历史 command 消息
        if (this.sendFinalCard) {
          await this.sendFinalCard({
            targetId: streamState.targetId,
            convType: streamState.convType,
            senderUserId: streamState.senderUserId,
            cardId: streamState.cardId,
            fullContent,
          });
        }

        this.sentSessions.add(sessionId);
        this.streamStates.delete(sessionId);
        this.log.info(`[EventHandler] session 完成: ${sessionId}, seq=${streamState.seq}, contentLen=${fullContent.length}`);
      } catch (err) {
        this.log.error(`[EventHandler] session.idle 处理失败: ${err.message}, session=${sessionId}`);
      }
    });
  }

  /**
   * 处理 session.error —— 发 error 终态 + 错误卡片。
   * 参考 opencode-clawmessenger event-handler.ts:916-964。
   * @param {Object} properties { sessionID?, error }
   */
  async _handleSessionError(properties) {
    const sessionId = properties.sessionID || properties.sessionId;
    if (!sessionId) return;
    if (this.sentSessions.has(sessionId)) return;

    const streamState = this.streamStates.get(sessionId);

    // 提取错误消息
    let errorMessage;
    if (typeof properties.error === 'string') {
      errorMessage = properties.error;
    } else if (properties.error?.data?.message) {
      errorMessage = properties.error.data.message;
    } else if (properties.error?.message) {
      errorMessage = properties.error.message;
    } else {
      errorMessage = 'AI 处理失败,请稍后重试';
    }

    const cardId = streamState?.cardId;
    const targetId = streamState?.targetId;
    const convType = streamState?.convType || 1;
    const senderUserId = streamState?.senderUserId || '';
    const streamId = streamState?.streamId;

    // 如果已流式过,先发 error 终态尾流
    if (streamState && streamId && this.sendStreamChunk && streamState.hasSentStream) {
      await this._enqueueStreamTask(sessionId, async () => {
        try {
          streamState.seq += 1;
          await this.sendStreamChunk(
            targetId,
            streamId,
            false,
            true,
            streamState.seq,
            {
              streamDelta: buildStreamDelta({
                sessionStatus: 'error',
                seq: streamState.seq,
                isFinal: true,
                error: errorMessage,
              }),
            },
          );
        } catch (err) {
          this.log.error(`[EventHandler] error 终态发送失败: ${err.message}`);
        }
      });
    }

    // 发错误卡片
    if (this.sendErrorCard && cardId && targetId) {
      try {
        await this.sendErrorCard({ targetId, convType, senderUserId, cardId, error: errorMessage });
      } catch (err) {
        this.log.error(`[EventHandler] 错误卡片发送失败: ${err.message}`);
      }
    }

    this.sentSessions.add(sessionId);
    this.streamStates.delete(sessionId);
    this.log.error(`[EventHandler] session 错误: ${sessionId}, msg=${errorMessage}`);
  }
}

module.exports = { EventHandler };
