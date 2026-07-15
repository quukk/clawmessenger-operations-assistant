"use strict";

const EventEmitter = require("events");

/**
 * 流式消息片段缓冲区。
 *
 * 用于缓存 RC:StreamMsg 的流式片段，为前端 HTTP SSE 端点 `/api/stream/:clientStreamId`
 * 提供订阅、回放和并发多订阅者支持。
 *
 * 缓冲条目结构：
 *   { seq, content, reasoning_content, session_status, is_final, error, card_id, timestamp, receivedAt }
 */
class StreamBuffer {
  constructor(options = {}) {
    this.ttlMs = options.ttlMs || 5 * 60 * 1000; // 默认 5 分钟
    this.streams = new Map();   // clientStreamId -> chunk[]
    this.emitters = new Map();  // clientStreamId -> EventEmitter
    this.timers = new Map();    // clientStreamId -> cleanup timer
  }

  /**
   * 追加一个流式片段。
   * @param {string} clientStreamId
   * @param {Object} chunk
   */
  append(clientStreamId, chunk) {
    if (!clientStreamId) return;

    this._ensureStream(clientStreamId);

    const normalized = {
      seq: chunk.seq,
      content: chunk.content || "",
      reasoning_content: chunk.reasoning_content || "",
      session_status: chunk.session_status || "",
      is_final: !!chunk.is_final,
      error: chunk.error || "",
      card_id: chunk.card_id || "",
      timestamp: chunk.timestamp || Date.now(),
      receivedAt: Date.now(),
    };

    this.streams.get(clientStreamId).push(normalized);
    this.emitters.get(clientStreamId).emit("chunk", normalized);
    this._resetTimer(clientStreamId);

    if (normalized.is_final || normalized.error) {
      // 终态/错误后留 5 秒让订阅者收到 done，再清理
      this._scheduleCleanup(clientStreamId, 5000);
    }
  }

  /**
   * 获取某个流的所有缓冲片段。
   * @param {string} clientStreamId
   * @returns {Object[]}
   */
  getAll(clientStreamId) {
    return this.streams.has(clientStreamId)
      ? this.streams.get(clientStreamId).slice()
      : [];
  }

  /**
   * 订阅流式片段。会立即回调所有已缓冲的片段，并持续回调新片段。
   * 返回取消订阅函数，调用后停止接收新片段。
   *
   * @param {string} clientStreamId
   * @param {(chunk: Object) => void} callback
   * @returns {() => void}
   */
  subscribe(clientStreamId, callback) {
    this._ensureStream(clientStreamId);

    const emitter = this.emitters.get(clientStreamId);
    const existing = this.streams.get(clientStreamId) || [];

    // 先回放已缓冲的片段（同步，避免订阅 gap）
    for (const chunk of existing) {
      callback(chunk);
    }

    const handler = (chunk) => callback(chunk);
    emitter.on("chunk", handler);

    return () => {
      emitter.off("chunk", handler);
    };
  }

  /**
   * 是否存在指定流的缓冲。
   * @param {string} clientStreamId
   * @returns {boolean}
   */
  hasStream(clientStreamId) {
    return this.streams.has(clientStreamId);
  }

  /**
   * 销毁指定流的缓冲和订阅器。
   * @param {string} clientStreamId
   */
  destroy(clientStreamId) {
    const emitter = this.emitters.get(clientStreamId);
    if (emitter) {
      emitter.removeAllListeners();
      this.emitters.delete(clientStreamId);
    }
    const timer = this.timers.get(clientStreamId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(clientStreamId);
    }
    this.streams.delete(clientStreamId);
  }

  _ensureStream(clientStreamId) {
    if (!this.streams.has(clientStreamId)) {
      this.streams.set(clientStreamId, []);
      this.emitters.set(clientStreamId, new EventEmitter());
      this._resetTimer(clientStreamId);
    }
  }

  _resetTimer(clientStreamId) {
    const existing = this.timers.get(clientStreamId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.destroy(clientStreamId);
    }, this.ttlMs);
    this.timers.set(clientStreamId, timer);
  }

  _scheduleCleanup(clientStreamId, delayMs) {
    const existing = this.timers.get(clientStreamId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.destroy(clientStreamId);
    }, delayMs);
    this.timers.set(clientStreamId, timer);
  }
}

module.exports = { StreamBuffer };
