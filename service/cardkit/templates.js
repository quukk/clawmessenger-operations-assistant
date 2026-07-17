/**
 * CardKit 预置业务卡片模板(JS 版)。
 *
 * 从 opencode-clawmessenger/src/cardkit/templates.ts 翻译而来。
 * 模板签名 / id 生成策略 / icon 映射必须与 TS 版逐字一致。
 *
 * 开箱即用的成品卡片,封装常见业务场景。插件业务代码(opencode 回复、
 * 错误处理、会话管理等)和 agent(参考示例自行生成)都可使用。
 *
 * 这些模板本质是 builders 的组合,展示"如何用原子组件拼出业务卡片"。
 */

'use strict';

const {
  card, md, note, divider, kv, permission, permissionButtons, action, btn,
} = require('./builders');

// ============================================================================
// 授权卡片
// ============================================================================

/**
 * 授权请求卡片:权限说明 + 三按钮(确认/始终允许/拒绝)。
 * @param {Object} p
 * @param {string} p.permissionId
 * @param {string} p.permission
 * @param {string} p.title
 * @param {string[]} p.patterns
 * @returns {import('./schema').CardModel}
 */
function permissionCard(p) {
  const patternsMd = p.patterns.map((pt) => `- \`${pt}\``).join('\n');
  return card(
    `perm_${p.permissionId}`,
    '🔒 权限请求',
    [
      md(`**${p.permission}**\n${p.title}\n\n**匹配范围:**\n${patternsMd || '（未指定）'}`),
      permission({ ...p, buttons: permissionButtons(p.permissionId) }),
    ],
    { color: 'blue' },
  );
}

// ============================================================================
// 错误卡片
// ============================================================================

/**
 * 错误卡片:转义后的错误信息展示。
 *
 * 注意:这类"终结性展示卡"(error/notice/status)用 Date.now() 生成一次性 id,
 * 应通过 CardTransport.send 直接发送,不要经 CardUpdateController.flush
 * (否则一次性 id 会污染 session.currentCardId,导致后续 update 指向错误卡片)。
 * 若需在 errorCard 后继续流式更新,应先调用 controller.reset(chatId) 清除追踪。
 *
 * @param {unknown} error
 * @param {string} [cardId]
 * @returns {import('./schema').CardModel}
 */
function errorCard(error, cardId = `err_${Date.now()}`) {
  let text;
  if (error instanceof Error) text = error.message;
  else if (typeof error === 'string') text = error;
  else if (typeof error === 'object' && error !== null) {
    const e = error;
    text = e.message || e.error || JSON.stringify(error);
  } else text = String(error);

  // 转义 markdown 特殊字符,防注入
  const safe = text.replace(/[*_`\[\]]/g, '\\$&');
  return card(cardId, '❌ 错误', [md(safe)], { color: 'red' });
}

// ============================================================================
// 确认/通知卡片
// ============================================================================

/**
 * 简单通知卡片(纯文本 + 可选颜色)。
 * @param {string} title
 * @param {string} body
 * @param {{color?: import('./schema').CardColor, icon?: string, cardId?: string}} [opts]
 * @returns {import('./schema').CardModel}
 */
function noticeCard(title, body, opts = {}) {
  return card(opts.cardId || `notice_${Date.now()}`, title, [md(body)], {
    color: opts.color,
    icon: opts.icon,
  });
}

// ============================================================================
// git/项目状态卡片
// ============================================================================

/**
 * 项目状态卡片:分支/提交/变更文件展示。
 * @param {Object} status
 * @param {string} [status.branch]
 * @param {string} [status.commit]
 * @param {Array<{path: string, status: string}>} [status.files]
 * @param {string} [cardId]
 * @returns {import('./schema').CardModel}
 */
function statusCard(status, cardId = `status_${Date.now()}`) {
  /** @type {import('./schema').CardSection[]} */
  const sections = [
    kv([
      { label: '分支', value: status.branch || 'unknown' },
      { label: '提交', value: (status.commit || '').substring(0, 8) || 'none' },
    ]),
  ];

  if (status.files && status.files.length > 0) {
    sections.push(divider());
    const iconMap = {
      A: '➕', M: '✏️', D: '🗑️', R: '📋', C: '📄', U: '⚠️', '?': '❓',
      added: '➕', modified: '✏️', deleted: '🗑️',
    };
    const fileLines = status.files.slice(0, 20)
      .map((f) => `${iconMap[f.status] || iconMap[f.status.charAt(0)] || '📄'} ${f.status} ${f.path}`)
      .join('\n');
    sections.push(md(`**变更文件 (${status.files.length}):**\n${fileLines}`));
    if (status.files.length > 20) {
      sections.push(note(`... 还有 ${status.files.length - 20} 个文件`));
    }
  } else {
    sections.push(note('✅ 工作区干净,无变更文件'));
  }

  return card(cardId, '📊 项目状态', sections, { icon: '📊' });
}

// ============================================================================
// 会话列表卡片
// ============================================================================

/**
 * 会话列表卡片:列出会话,每项带切换/删除按钮。
 * @param {Array<{id: string, title: string, updatedAt?: number}>} sessions
 * @param {string} [currentSessionId]
 * @returns {import('./schema').CardModel}
 */
function sessionsCard(sessions, currentSessionId) {
  /** @type {import('./schema').CardSection[]} */
  const sections = sessions.slice(0, 20).map((s) => {
    const isCurrent = s.id === currentSessionId;
    const btns = isCurrent
      ? [btn('🗑️ 删除', action.session('delete', s.id), { variant: 'danger' })]
      : [
          btn('🔄 切换', action.session('switch', s.id), { variant: 'primary' }),
          btn('🗑️', action.session('delete', s.id), { variant: 'text' }),
        ];
    return { kind: 'buttonRow', buttons: btns, layout: 'inline' };
  });

  if (sessions.length === 0) sections.push(note('暂无会话'));
  return card(`sessions_${currentSessionId || 'list'}_${Date.now()}`, '会话列表', sections, { icon: '💬' });
}

// ============================================================================
// 命令面板卡片
// ============================================================================

/**
 * 命令面板卡片:可点击的命令列表。
 * @param {Array<{name: string, description?: string}>} commands
 * @returns {import('./schema').CardModel}
 */
function commandsCard(commands) {
  /** @type {import('./schema').CardSection[]} */
  const sections = commands.map((c) => ({
    kind: 'buttonRow',
    buttons: [btn(c.name, action.command(c.name), { variant: 'default' })],
    layout: 'inline',
  }));
  return card('commands', '⚡ 命令面板', sections, { icon: '⚡' });
}

module.exports = {
  permissionCard,
  errorCard,
  noticeCard,
  statusCard,
  sessionsCard,
  commandsCard,
};
