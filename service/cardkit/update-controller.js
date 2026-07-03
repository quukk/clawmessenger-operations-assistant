/**
 * 卡片更新生命周期控制器(JS 版)。
 *
 * 从 opencode-clawmessenger/src/cardkit/update-controller.ts 翻译而来。
 * 状态机 / 节流 / 冻结逻辑必须与 TS 版逐字一致。
 *
 * ⚠️ 当前接入状态:与 TS 版一致,本控制器已完整实现但目前是死代码(无任何地方实例化)。
 * B2 阶段接入业务(流式卡片原地更新)时,需在 EventHandler 注入并调 controller.flush()。
 *
 * 核心状态机(每 chatId 独立):
 *  - 无 currentCardId → sendCard 新建,记录 cardId
 *  - 有 currentCardId 且未冻结 → 节流(UPDATE_THROTTLE_MS)后 updateCard
 *  - cardFrozen=true → 跳过(授权等待等,避免覆盖用户正在看的卡片)
 *  - force=true → 绕过节流(工具状态变化/最终完成/权限请求)
 *
 * 为什么需要冻结:用户可能在权限卡片上停留很久才点按钮。若期间每个 token
 * delta 都触发 updateCard,小程序会被同 id 卡片的更新消息刷屏。冻结保证
 * 交互期间卡片稳定。
 *
 * 注意:本 JS 项目 logger 为字符串风格(非 pino 对象),日志调用已适配。
 */

'use strict';

const { createLogger } = require('../logger');

const log = createLogger('CardUpdateController');

/** 更新节流间隔(毫秒)。同卡片 2s 内只推一次更新。 */
const UPDATE_THROTTLE_MS = 2000;

/**
 * @typedef {Object} FlushOptions
 * @property {boolean} [force] 绕过节流(工具状态变化/最终完成/权限请求等关键节点)
 * @property {boolean} [isFinal] 是否为最终态(完成时若 update 失败,回退 sendCard 新建)
 */

/**
 * 卡片更新生命周期控制器。
 *
 * 封装"首次 sendCard → 后续 updateCard 节流 → 冻结态跳过"的核心逻辑,
 * 从 opencode-feishu 的 flushCard 抽取,适配融云的 card_update 机制。
 */
class CardUpdateController {
  /**
   * @param {Object} sessionManager SessionManager(需提供 getSession)
   * @param {Object} transport CardTransport(需提供 send / update)
   */
  constructor(sessionManager, transport) {
    this.sessionManager = sessionManager;
    this.transport = transport;
  }

  /**
   * 合成并推送卡片。
   * - 首次(无 currentCardId):sendCard 新建并记录 cardId
   * - 后续:updateCard 节流推送(card_update 协议)
   * - force:绕过节流
   * - isFinal:updateCard 失败时回退 sendCard
   *
   * @param {string} chatId
   * @param {import('./schema').CardModel} model
   * @param {FlushOptions} [opts]
   * @returns {Promise<void>}
   */
  async flush(chatId, model, opts = {}) {
    const session = this.sessionManager.getSession(chatId);

    // 冻结态:除非 force,否则跳过(保护用户正在交互的卡片)
    if (session?.cardFrozen && !opts.force) {
      log.info?.(`卡片已冻结,跳过更新: chatId=${chatId}, cardId=${model.id}`);
      return;
    }

    const now = Date.now();
    const hasCurrentCard = !!session?.currentCardId;

    // 首次:sendCard
    if (!hasCurrentCard) {
      // 并发守卫:在 await 前预留 currentCardId,避免并发的 flush 也进入 send 分支
      // (与下方 update 分支的"await 前置位时间戳"同理,防止跨 await 竞态发两张卡)
      //
      // 已知限制:若 send 失败回滚 currentCardId,期间并发的 flush B 可能已观察到
      // 预留的 id 并发出 card_update(指向从未成功发送的卡片)。小程序侧该 update
      // 会因找不到卡片而 no-op,不会崩溃。完整修复需在 transport 层追踪 confirmedCardIds
      // (仅 send 成功才允许 update),当前作为已知限制接受。
      if (session) {
        session.currentCardId = model.id;
        session.lastCardUpdateTime = now;
      }
      const res = await this.transport.send(chatId, model);
      if (!res.success && session) {
        // 发送失败:回滚预留,允许下次 flush 重新发送
        session.currentCardId = undefined;
      }
      return;
    }

    // 后续:节流判断
    if (!opts.force && session?.lastCardUpdateTime) {
      const elapsed = now - session.lastCardUpdateTime;
      if (elapsed < UPDATE_THROTTLE_MS) {
        log.info?.(`节流跳过更新: chatId=${chatId}, cardId=${model.id}, elapsed=${elapsed}`);
        return;
      }
    }

    // 先更新时间戳(并发守卫:像飞书那样在 await 前置位)
    if (session) session.lastCardUpdateTime = now;

    const res = await this.transport.update(chatId, model);
    if (!res.success && opts.isFinal) {
      // 最终态 update 失败 → 回退 sendCard 新建(对应飞书 fallback 逻辑)
      log.warn?.(`最终态 update 失败,回退 sendCard: chatId=${chatId}, cardId=${model.id}`);
      const sendRes = await this.transport.send(chatId, model);
      if (sendRes.success && session) {
        session.currentCardId = model.id;
      }
    }
  }

  /**
   * 冻结卡片更新(用户正在交互时调用,如权限卡片等待点击)。
   * @param {string} chatId
   */
  freeze(chatId) {
    const session = this.sessionManager.getSession(chatId);
    if (session) {
      session.cardFrozen = true;
      log.info?.(`卡片已冻结: chatId=${chatId}`);
    }
  }

  /**
   * 解冻卡片更新(交互结束后调用)。
   * @param {string} chatId
   */
  unfreeze(chatId) {
    const session = this.sessionManager.getSession(chatId);
    if (session) {
      session.cardFrozen = false;
      log.info?.(`卡片已解冻: chatId=${chatId}`);
    }
  }

  /**
   * 重置卡片状态(新 turn 开始时,清除上一张卡片的追踪)。
   * @param {string} chatId
   */
  reset(chatId) {
    const session = this.sessionManager.getSession(chatId);
    if (session) {
      session.currentCardId = undefined;
      session.lastCardUpdateTime = undefined;
      session.cardFrozen = false;
    }
  }

  /**
   * 判断是否已有活跃卡片。
   * @param {string} chatId
   * @returns {boolean}
   */
  hasActiveCard(chatId) {
    return !!this.sessionManager.getSession(chatId)?.currentCardId;
  }

  /**
   * 获取当前卡片 id(可能为空)。
   * @param {string} chatId
   * @returns {string|undefined}
   */
  getCurrentCardId(chatId) {
    return this.sessionManager.getSession(chatId)?.currentCardId;
  }
}

module.exports = {
  CardUpdateController,
  UPDATE_THROTTLE_MS,
};
