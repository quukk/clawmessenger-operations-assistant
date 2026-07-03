/**
 * StreamDelta / extra 卡片壳构造器(规范 CARD-SPEC.md §7-8)
 *
 * 抽离自 ops-assistant/index.js,供 index.js 与 event-handler.js 共享。
 *
 * 状态机(运维助手场景):
 *   thinking → responding → completed(以及 error)
 *   不涉及 tool_executing/waiting_interaction/cancelled。
 */

/**
 * @typedef {'thinking'|'responding'|'tool_executing'|'waiting_interaction'|'completed'|'error'|'cancelled'} StreamSessionStatus
 */

/**
 * 构造 StreamDelta 对象(规范 §7,作为 RC:StreamMsg content.content 载荷)。
 * @param {Object} p
 * @param {string} [p.content] 本片段文本内容(增量)
 * @param {StreamSessionStatus} p.sessionStatus 会话状态机当前态
 * @param {number} p.seq 序号(小程序按 seq>lastSeq 去重)
 * @param {boolean} [p.isFinal=false] 是否终态(completed/error/cancelled)
 * @param {string} [p.error] 错误信息(sessionStatus='error' 时)
 * @param {string} [p.reasoningContent] 思考过程内容(可选)
 * @returns {Object} StreamDelta
 */
function buildStreamDelta({ content, sessionStatus, seq, isFinal = false, error, reasoningContent }) {
  /** @type {Object} */
  const delta = { session_status: sessionStatus, seq };
  if (content !== undefined && content !== null) delta.content = content;
  if (reasoningContent) delta.reasoning_content = reasoningContent;
  if (isFinal) delta.is_final = true;
  if (error) delta.error = error;
  return delta;
}

/**
 * 构造 RC:StreamMsg 的 extra 卡片壳(规范 §8.3)。
 * 首流时写入 content.extra,让小程序渲染 ai_streaming 卡片壳并按 card_id 续流。
 *
 * 关键:card_id 必须与初始静态卡一致,前端据此把后续 StreamDelta 续流到同一张卡片。
 *
 * @param {Object} p
 * @param {string} p.cardId 卡片 id(与初始静态卡一致)
 * @param {string} [p.title='运维助手'] 卡片标题
 * @param {Array} [p.actions] 按钮列表(与初始静态卡的 buttons 对应)
 * @returns {Object} extra 卡片壳
 */
function buildStreamExtra({ cardId, title = '运维助手', actions }) {
  const extra = {
    stream_type: 'card',
    card_template: 'ai_streaming',
    card_id: cardId,
    title,
    version: '1.0.0',
  };
  if (actions) extra.actions = actions;
  return extra;
}

module.exports = { buildStreamDelta, buildStreamExtra };
