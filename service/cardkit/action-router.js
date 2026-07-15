/**
 * 卡片按钮动作路由器(JS 版)。
 *
 * 从 opencode-clawmessenger/src/cardkit/action-router.ts 翻译而来。
 * 路由表 / 处理器签名 / 处理结果结构必须与 TS 版逐字一致。
 *
 * 用户在小程序点击卡片按钮 → 发回 card_action 消息 → MessageHandler 调用本路由器
 * 按 action.type 分发到对应处理。用 Map 注册替代飞书的 if/else 链,易于扩展。
 *
 * 回传通道:复用现有 command_message/command_result 往返(request_id + 响应),
 * 处理完成后给小程序回一条 command_result 让按钮显示已处理态。
 *
 * 注意:本 JS 项目 logger 为字符串风格(非 pino 对象),日志调用已适配。
 * 依赖注入的 opencode/sessionManager/cardTransport 对象需提供与 TS 版同名的方法。
 */

'use strict';

const { createLogger } = require('../logger');
const { card: buildCard, note } = require('./builders');
const { buildModelsCard } = require('./model-cards');

const log = createLogger('ActionRouter');

/**
 * 按钮点击的回传消息载荷(小程序发来)。
 * @typedef {Object} CardActionMessage
 * @property {string} cardId 被点击按钮所属卡片的 id
 * @property {string} [buttonId] 被点击按钮的 id(可选)
 * @property {import('./schema').CardAction} action 按钮的 action 契约
 * @property {string} [request_id] 往返请求 id,用于回 command_result
 * @property {number} [timestamp]
 */

/**
 * 动作处理的上下文(注入所需依赖)。
 * @typedef {Object} ActionContext
 * @property {string} chatId
 * @property {CardActionMessage} msg
 * @property {Object} opencode OpenCodeClient(opencode/client.ts 的 JS 等价物)
 * @property {Object} [opencodeRunner] 运维助手 OpencodeRunner 实例(用于 stop 等)
 * @property {Object} sessionManager SessionManager
 * @property {Object} cardTransport CardTransport(融云传输)
 */

/**
 * 动作处理结果。
 * @typedef {Object} ActionResult
 * @property {boolean} success 是否处理成功
 * @property {string} confirmText 回传给小程序的确认文本(显示在按钮旁或 toast)
 * @property {import('./schema').CardModel} [resultCard] 处理结果卡片(可选,用于替换原卡片显示已处理态)
 */

/**
 * @typedef {(ctx: ActionContext) => Promise<ActionResult>} ActionHandler
 */

/**
 * 动作路由器。预注册所有内置 action 处理器,并支持自定义扩展。
 */
class ActionRouter {
  constructor() {
    /** @type {Map<string, ActionHandler>} */
    this.handlers = new Map();

    // 注册内置处理器
    this.register('permission', handlePermission);
    this.register('command', handleCommand);
    this.register('session', handleSession);
    this.register('navigate', handleNavigate);
    this.register('answer', handleAnswer);
    this.register('custom', handleCustom);
    this.register('none', handleNone);
  }

  /**
   * 注册自定义动作处理器(扩展点)。
   * @param {string} actionType
   * @param {ActionHandler} handler
   */
  register(actionType, handler) {
    this.handlers.set(actionType, handler);
  }

  /**
   * 分发动作。未知 type 返回错误(不抛异常)。
   * @param {ActionContext} ctx
   * @returns {Promise<ActionResult>}
   */
  async dispatch(ctx) {
    const actionType = ctx.msg.action.type;
    const handler = this.handlers.get(actionType);
    if (!handler) {
      log.warn(`No handler for action type: ${actionType}`);
      return { success: false, confirmText: `不支持的动作类型: ${actionType}` };
    }
    try {
      return await handler(ctx);
    } catch (err) {
      log.error(`Action handler failed: ${err.message}`);
      return { success: false, confirmText: '处理失败,请重试' };
    }
  }
}

// ============================================================================
// 内置处理器
// ============================================================================

/**
 * 权限授权:透传给 opencode.replyPermission。
 * 注意:permissionId 必须是 opencode 在 permission.asked 事件中下发的真实 requestID,
 * 而非 agent 自造的标识(否则 opencode 无法匹配到待决权限请求)。
 * @param {ActionContext} ctx
 * @returns {Promise<ActionResult>}
 */
async function handlePermission(ctx) {
  const a = ctx.msg.action;
  const replyText = { once: '已授权一次', always: '已始终授权', reject: '已拒绝' }[a.reply];

  // replyPermission 返回 boolean(false=失败,如 permissionId 无效/已过期)
  const ok = await ctx.opencode.replyPermission(a.permissionId, a.reply);
  if (!ok) {
    log.warn(`replyPermission failed (invalid/expired requestID?): permissionId=${a.permissionId}, reply=${a.reply}`);
    return { success: false, confirmText: '授权失败(权限请求可能已过期),请重试' };
  }

  const icon = a.reply === 'reject' ? '❌' : '✅';
  const resultCard = buildCard(
    ctx.msg.cardId,
    `${icon} ${replyText}`,
    [note(`权限请求 ${a.permissionId} 已${a.reply === 'reject' ? '拒绝' : '授权'}`)],
    { color: a.reply === 'reject' ? 'grey' : 'green' },
  );
  return { success: true, confirmText: replyText, resultCard };
}

/**
 * 斜杠命令:转发给当前会话。
 * @param {ActionContext} ctx
 * @returns {Promise<ActionResult>}
 */
async function handleCommand(ctx) {
  const a = ctx.msg.action;
  const session = ctx.sessionManager.getSession(ctx.chatId);
  if (!session) {
    return { success: false, confirmText: '无活跃会话' };
  }
  // stop 命令用于中止当前生成，而不是作为新的 prompt 发送
  if (a.name === 'stop') {
    const cardId = ctx.msg.cardId;
    if (ctx.opencodeRunner && typeof ctx.opencodeRunner.stopStream === 'function') {
      try {
        const stopResult = await ctx.opencodeRunner.stopStream(cardId);
        return { success: stopResult?.stopped !== false, confirmText: stopResult?.reason || '已停止生成' };
      } catch (err) {
        log.warn(`Failed to stop stream: ${err.message}, cardId=${cardId}`);
        return { success: false, confirmText: '停止失败，请重试' };
      }
    } else if (ctx.opencodeRunner && typeof ctx.opencodeRunner.stop === 'function') {
      try {
        ctx.opencodeRunner.stop();
        return { success: true, confirmText: '已停止生成' };
      } catch (err) {
        log.warn(`Failed to stop runner: ${err.message}, cardId=${cardId}`);
        return { success: false, confirmText: '停止失败，请重试' };
      }
    }
    // TODO: 当 opencodeRunner 未提供 stopStream/stop 时，接入项目实际的停止能力
    return { success: false, confirmText: '停止功能未就绪' };
  }
  await ctx.opencode.sendCommand(session.id, a.name);
  return { success: true, confirmText: `已执行 ${a.name}` };
}

/**
 * 会话操作:切换/删除。
 * @param {ActionContext} ctx
 * @returns {Promise<ActionResult>}
 */
async function handleSession(ctx) {
  const a = ctx.msg.action;
  if (a.op === 'delete') {
    // 删除 opencode 会话,失败则如实告知用户
    const ok = await ctx.opencode.deleteSession(a.sessionId);
    if (!ok) {
      return { success: false, confirmText: '删除失败,请重试' };
    }
    // 同步清理本地 chatId→sessionId 映射,避免后续消息复用已删会话
    const chatId = ctx.sessionManager.getChatIdBySession(a.sessionId);
    if (chatId) {
      ctx.sessionManager.deleteSession(chatId);
    }
    return { success: true, confirmText: '会话已删除' };
  }
  // switch:调用 opencode 的 selectSession 切换当前活跃会话
  const ok = await ctx.opencode.selectSession(a.sessionId);
  if (!ok) {
    return { success: false, confirmText: '切换失败,请重试' };
  }
  log.info(`Session switched via selectSession: sessionId=${a.sessionId}`);
  return { success: true, confirmText: '已切换会话' };
}

/**
 * 内部导航:目前仅记录,后续可扩展分页等。
 * @param {ActionContext} ctx
 * @returns {Promise<ActionResult>}
 */
async function handleNavigate(ctx) {
  const a = ctx.msg.action;
  log.info(`Navigate action: target=${a.target}, chatId=${ctx.chatId}`);
  return { success: true, confirmText: '导航请求已记录' };
}

/**
 * 问答选择:调 opencode.replyQuestion 解除 question.asked 阻塞。
 * 注意:必须用 replyQuestion(而非 sendPromptAsync),否则 opencode 的待决问题
 * 永远不会被回答,用户会卡在交互状态(这是 question 闭环的正确 API)。
 * @param {ActionContext} ctx
 * @returns {Promise<ActionResult>}
 */
async function handleAnswer(ctx) {
  const a = ctx.msg.action;
  if (!Array.isArray(a.value) || a.value.length === 0) {
    return { success: false, confirmText: '未选择任何选项' };
  }

  // 调 replyQuestion 解除 opencode 的 question 阻塞
  const ok = await ctx.opencode.replyQuestion(a.questionId, [a.value]);
  if (!ok) {
    return { success: false, confirmText: '回复失败,请重试' };
  }

  // 清除待决交互状态(与文本回复路径一致)
  ctx.sessionManager.clearPendingInteraction(ctx.chatId);
  const session = ctx.sessionManager.getSession(ctx.chatId);
  if (session) session.interactionReplied = true;

  const answerText = a.value.join('、');
  // 返回确认卡替换原问答卡(防止用户重复点击已失效的按钮)
  const resultCard = buildCard(
    ctx.msg.cardId,
    '✅ 已选择',
    [note(`已选择: ${answerText}`)],
    { color: 'green' },
  );
  return { success: true, confirmText: `已选择: ${answerText}`, resultCard };
}

/**
 * 自定义动作:把 action.payload 作为新 prompt 发回对话。
 * 这是 agent 自定义交互的核心 —— agent 生成带 custom action 的卡片,
 * 用户点击后 payload 回到对话,agent 可继续处理。
 * @param {ActionContext} ctx
 * @returns {Promise<ActionResult>}
 */
async function handleCustom(ctx) {
  const a = ctx.msg.action;

  // 本地卡片交互:先处理不需要回传会话的特殊动作
  if (a.kind === 'list_models') {
    return handleListModels(ctx, a);
  }

  if (a.kind === 'switch_model') {
    return handleSwitchModel(ctx, a);
  }

  const session = ctx.sessionManager.getSession(ctx.chatId);
  if (!session) {
    return { success: false, confirmText: '无活跃会话' };
  }
  // 把自定义动作序列化为对话输入,让 agent 理解用户的选择
  const promptText = `[用户点击了卡片按钮] 动作: ${a.kind}\n参数: ${JSON.stringify(a.payload)}`;
  await ctx.opencode.sendPromptAsync(session.id, promptText);
  log.info(`Custom action forwarded to session: kind=${a.kind}, chatId=${ctx.chatId}`);
  return { success: true, confirmText: '已处理' };
}

/**
 * 处理“选择服务商”动作,发送该服务商的模型列表卡片。
 * @param {ActionContext} ctx
 * @param {any} a
 * @returns {Promise<ActionResult>}
 */
async function handleListModels(ctx, a) {
  const providerId = a.payload && a.payload.provider;
  if (!providerId) {
    return { success: false, confirmText: '缺少服务商 ID' };
  }
  try {
    const config = await ctx.opencode.getConfig();
    const currentModel = config && config.model;
    const providerData = await ctx.opencode.listProviders();
    const allProviders = (providerData && providerData.all) || (providerData && providerData.providers) || providerData || [];
    const p = allProviders.find((x) => x && x.id === providerId);
    if (!p) {
      return { success: false, confirmText: `未找到服务商: ${providerId}` };
    }
    const provider = {
      id: p.id,
      name: p.name || p.id,
      models: normalizeProviderModels(p.models),
    };
    if (provider.models.length === 0) {
      return { success: false, confirmText: `${provider.name} 暂无可用模型` };
    }
    const resultCard = buildModelsCard(provider, currentModel);
    if (ctx.cardTransport && typeof ctx.cardTransport.send === 'function') {
      await ctx.cardTransport.send(ctx.chatId, resultCard);
    }
    return { success: true, confirmText: '模型列表已发送', resultCard };
  } catch (err) {
    log.error(`list_models failed: ${err.message}`);
    return { success: false, confirmText: '加载模型列表失败' };
  }
}

/**
 * 处理“切换模型”动作。
 * @param {ActionContext} ctx
 * @param {any} a
 * @returns {Promise<ActionResult>}
 */
async function handleSwitchModel(ctx, a) {
  const payload = a.payload || {};
  const value = typeof payload.value === 'string' ? payload.value : '';
  const [providerId, modelId] = value.split('/');
  const model = modelId ? `${providerId}/${modelId}` : value;
  if (!model) {
    return { success: false, confirmText: '缺少模型 ID' };
  }
  const session = ctx.sessionManager.getSession(ctx.chatId);
  if (!session || !session.id) {
    return { success: false, confirmText: '无活跃会话，无法切换模型' };
  }
  try {
    await ctx.opencode.switchModel(session.id, model);
    return {
      success: true,
      confirmText: `已切换至 ${model}`,
      resultCard: buildCard(
        ctx.msg.cardId,
        '✅ 模型已切换',
        [note(`当前模型: ${model}`)],
        { color: 'green' },
      ),
    };
  } catch (err) {
    log.warn(`switchModel failed: ${err.message}, model=${model}`);
    return { success: false, confirmText: '切换模型失败' };
  }
}

/**
 * 把提供商返回的 models 字段统一成 ModelInfo[] 数组。
 * @param {any} models
 * @returns {Array<{id: string, name: string}>}
 */
function normalizeProviderModels(models) {
  if (!models) return [];
  if (Array.isArray(models)) {
    return models.map((m) => {
      if (typeof m === 'string') return { id: m, name: m };
      if (m && typeof m === 'object') {
        const id = m.id || m.modelId || String(m);
        return { id, name: m.name || m.label || m.title || id };
      }
      return { id: String(m), name: String(m) };
    });
  }
  if (typeof models === 'object') {
    return Object.entries(models).map(([id, m]) => {
      if (typeof m === 'string') return { id, name: m };
      if (m && typeof m === 'object') {
        return { id, name: m.name || m.label || m.title || id };
      }
      return { id, name: id };
    });
  }
  return [];
}

/**
 * 无动作(纯展示按钮或外链)。
 * @param {ActionContext} _ctx
 * @returns {Promise<ActionResult>}
 */
async function handleNone(_ctx) {
  return { success: true, confirmText: '' };
}

module.exports = {
  ActionRouter,
  handlePermission,
  handleCommand,
  handleSession,
  handleNavigate,
  handleAnswer,
  handleCustom,
  handleNone,
};
