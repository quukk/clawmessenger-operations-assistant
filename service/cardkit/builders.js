/**
 * CardKit 构造器 —— agent 友好的卡片构建 DSL(JS 版)。
 *
 * 从 opencode-clawmessenger/src/cardkit/builders.ts 翻译而来。
 * 签名/行为/字段名与 TS 版逐字一致。
 *
 * 提供原子构造器(md/btn/kv/divider...)与业务模板(permission/question/progress...),
 * agent 用它们像搭积木一样组合任意卡片,无需手写完整 JSON。
 * 也用于插件侧业务代码构造预置卡片(见 templates.js)。
 */

'use strict';

const { CARD_SCHEMA_VERSION } = require('./schema');

// ============================================================================
// 顶层卡片构造器
// ============================================================================

/**
 * @typedef {Object} CardOptions
 * @property {string} [icon]
 * @property {import('./schema').CardColor} [color]
 * @property {string} [subtitle]
 * @property {boolean} [wide]
 * @property {boolean} [collapsible]
 */

/**
 * 构造一张卡片。
 * @param {string} id
 * @param {string} title
 * @param {import('./schema').CardSection[]} sections
 * @param {CardOptions} [opts]
 * @returns {import('./schema').CardModel}
 */
function card(id, title, sections, opts = {}) {
  return {
    schema: CARD_SCHEMA_VERSION,
    id,
    header: {
      title,
      ...(opts.icon !== undefined ? { icon: opts.icon } : {}),
      ...(opts.color !== undefined ? { color: opts.color } : {}),
      ...(opts.subtitle !== undefined ? { subtitle: opts.subtitle } : {}),
    },
    sections,
    config: {
      ...(opts.wide !== undefined ? { wide: opts.wide } : {}),
      ...(opts.collapsible !== undefined ? { collapsible: opts.collapsible } : {}),
    },
  };
}

// ============================================================================
// Action 构造器(快捷生成各类按钮行为)
// ============================================================================

/**
 * Action 构造器集合。每个方法返回一个完整的 CardAction 对象。
 * @type {Object}
 */
const action = {
  /**
   * @param {string} permissionId
   * @param {('once'|'always'|'reject')} reply
   * @returns {import('./schema').CardAction}
   */
  permission: (permissionId, reply) => ({ type: 'permission', permissionId, reply }),
  /**
   * @param {string} questionId
   * @param {string[]} value
   * @returns {import('./schema').CardAction}
   */
  answer: (questionId, value) => ({ type: 'answer', questionId, value }),
  /**
   * @param {string} name
   * @returns {import('./schema').CardAction}
   */
  command: (name) => ({ type: 'command', name }),
  /**
   * @param {('switch'|'delete')} op
   * @param {string} sessionId
   * @returns {import('./schema').CardAction}
   */
  session: (op, sessionId) => ({ type: 'session', op, sessionId }),
  /**
   * @param {string} target
   * @returns {import('./schema').CardAction}
   */
  navigate: (target) => ({ type: 'navigate', target }),
  /**
   * @param {string} kind
   * @param {Record<string, unknown>} [payload]
   * @returns {import('./schema').CardAction}
   */
  custom: (kind, payload = {}) => ({ type: 'custom', kind, payload }),
  /** @returns {import('./schema').CardAction} */
  none: () => ({ type: 'none' }),
};

// ============================================================================
// 按钮构造器
// ============================================================================

/**
 * @typedef {Object} ButtonOptions
 * @property {string} [id]
 * @property {string} [icon]
 * @property {import('./schema').ButtonVariant} [variant]
 * @property {boolean} [disabled]
 * @property {string} [url] 外链(有 url 时优先跳转,action 可省略)
 */

/**
 * 构造一个按钮。有 url 时 action 可选(默认 none)。
 * @param {string} label
 * @param {import('./schema').CardAction} act
 * @param {ButtonOptions} [opts]
 * @returns {import('./schema').CardButton}
 */
function btn(label, act, opts = {}) {
  return {
    label,
    action: act,
    ...(opts.id !== undefined ? { id: opts.id } : {}),
    ...(opts.icon !== undefined ? { icon: opts.icon } : {}),
    ...(opts.variant !== undefined ? { variant: opts.variant } : {}),
    ...(opts.disabled !== undefined ? { disabled: opts.disabled } : {}),
    ...(opts.url !== undefined ? { url: opts.url } : {}),
  };
}

/**
 * 构造一个外链按钮(无需 action)。
 * @param {string} label
 * @param {string} url
 * @param {ButtonOptions} [opts]
 * @returns {import('./schema').CardButton}
 */
function linkBtn(label, url, opts = {}) {
  return btn(label, action.none(), { ...opts, url });
}

// ============================================================================
// 原子组件构造器
// ============================================================================

/**
 * 富文本段落。
 * @param {string} content
 * @param {boolean} [collapsed]
 * @returns {import('./schema').MarkdownSection}
 */
function md(content, collapsed = false) {
  return { kind: 'markdown', content, ...(collapsed ? { collapsed } : {}) };
}

/**
 * 分隔线。
 * @returns {import('./schema').DividerSection}
 */
function divider() {
  return { kind: 'divider' };
}

/**
 * 注释/提示(灰色小字)。
 * @param {string} text
 * @returns {import('./schema').NoteSection}
 */
function note(text) {
  return { kind: 'note', text };
}

/**
 * 按钮行。
 * @param {import('./schema').CardButton[]} btns
 * @param {import('./schema').ButtonLayout} [layout]
 * @returns {import('./schema').ButtonRowSection}
 */
function buttons(btns, layout = 'inline') {
  return { kind: 'buttonRow', buttons: btns, layout };
}

/**
 * 键值列表。
 * @param {Array<{label: string, value: string, icon?: string}>} items
 * @returns {import('./schema').KeyValueSection}
 */
function kv(items) {
  return { kind: 'keyValue', items };
}

/**
 * 下拉选择。
 * @param {string} placeholder
 * @param {import('./schema').SelectOption[]} options
 * @param {import('./schema').CardAction} act
 * @returns {import('./schema').SelectSection}
 */
function select(placeholder, options, act) {
  return { kind: 'select', placeholder, options, action: act };
}

/**
 * 输入框。
 * @param {string} placeholder
 * @param {{label?: string, multiline?: boolean, submitButton?: import('./schema').CardButton}} [opts]
 * @returns {import('./schema').InputSection}
 */
function input(placeholder, opts = {}) {
  return {
    kind: 'input',
    placeholder,
    ...(opts.label !== undefined ? { label: opts.label } : {}),
    ...(opts.multiline !== undefined ? { multiline: opts.multiline } : {}),
    ...(opts.submitButton !== undefined ? { submitButton: opts.submitButton } : {}),
  };
}

/**
 * 图片。
 * @param {string} src
 * @param {string} [alt]
 * @param {string} [url]
 * @returns {import('./schema').ImageSection}
 */
function image(src, alt, url) {
  return {
    kind: 'image',
    src,
    ...(alt !== undefined ? { alt } : {}),
    ...(url !== undefined ? { url } : {}),
  };
}

/**
 * 表格。
 * @param {import('./schema').TableColumn[]} columns
 * @param {Array<Record<string, string>>} rows
 * @returns {import('./schema').TableSection}
 */
function table(columns, rows) {
  return { kind: 'table', columns, rows };
}

// ============================================================================
// 业务模板构造器
// ============================================================================

/**
 * 构造授权请求段落(默认三按钮)。
 * 不传 buttons 时,小程序按默认渲染"✅ 确认 / 🔓 始终允许 / ❌ 拒绝"。
 * @param {Object} p
 * @param {string} p.permissionId
 * @param {string} p.permission
 * @param {string} p.title
 * @param {string[]} p.patterns
 * @param {import('./schema').CardButton[]} [p.buttons]
 * @returns {import('./schema').PermissionSection}
 */
function permission(p) {
  const sec = {
    kind: 'permission',
    permissionId: p.permissionId,
    permission: p.permission,
    title: p.title,
    patterns: p.patterns,
  };
  // 仅在有自定义按钮时写入
  if (p.buttons && p.buttons.length > 0) sec.buttons = p.buttons;
  return sec;
}

/**
 * 构造默认的授权三按钮(确认/始终允许/拒绝)。
 * @param {string} permissionId
 * @returns {import('./schema').CardButton[]}
 */
function permissionButtons(permissionId) {
  return [
    btn('✅ 确认', action.permission(permissionId, 'once'), { variant: 'primary' }),
    btn('🔓 始终允许', action.permission(permissionId, 'always'), { variant: 'default' }),
    btn('❌ 拒绝', action.permission(permissionId, 'reject'), { variant: 'danger' }),
  ];
}

/**
 * 构造问答段落。
 * @param {Object} q
 * @param {string} q.questionId
 * @param {string} q.header
 * @param {string} q.question
 * @param {Array<{label: string, description?: string}>} q.options
 * @param {boolean} [q.multiple]
 * @param {boolean} [q.custom]
 * @returns {import('./schema').QuestionSection}
 */
function question(q) {
  return {
    kind: 'question',
    questionId: q.questionId,
    header: q.header,
    question: q.question,
    options: q.options,
    ...(q.multiple !== undefined ? { multiple: q.multiple } : {}),
    ...(q.custom !== undefined ? { custom: q.custom } : {}),
  };
}

/**
 * 构造进度段落。
 * @param {Object} [p]
 * @param {Array<{name: string, status: ('running'|'completed'|'error'), error?: string}>} [p.tools]
 * @param {string} [p.thinking]
 * @param {number} [p.elapsedMs]
 * @param {boolean} [p.done]
 * @returns {import('./schema').ProgressSection}
 */
function progress(p = {}) {
  const sec = { kind: 'progress' };
  if (p.tools !== undefined) sec.tools = p.tools;
  if (p.thinking !== undefined) sec.thinking = p.thinking;
  if (p.elapsedMs !== undefined) sec.elapsedMs = p.elapsedMs;
  if (p.done !== undefined) sec.done = p.done;
  return sec;
}

/**
 * 构造 git/项目状态段落。
 * @param {Object} s
 * @param {string} [s.branch]
 * @param {string} [s.commit]
 * @param {Array<{path: string, status: string}>} [s.files]
 * @returns {import('./schema').StatusReportSection}
 */
function statusReport(s) {
  const sec = { kind: 'statusReport' };
  if (s.branch !== undefined) sec.branch = s.branch;
  if (s.commit !== undefined) sec.commit = s.commit;
  if (s.files !== undefined) sec.files = s.files;
  return sec;
}

/**
 * 构造会话列表段落。
 * @param {Object} s
 * @param {string} [s.currentSessionId]
 * @param {Array<{id: string, title: string, updatedAt?: number}>} s.sessions
 * @param {string} [s.searchCommand] 搜索命令名(不含 / 前缀),前端搜索框据此触发后端搜索
 * @returns {import('./schema').SessionListSection}
 */
function sessionList(s) {
  const sec = { kind: 'sessionList', sessions: s.sessions };
  if (s.currentSessionId !== undefined) sec.currentSessionId = s.currentSessionId;
  if (s.searchCommand !== undefined) sec.searchCommand = s.searchCommand;
  return sec;
}

/**
 * 构造命令面板段落。
 * @param {Object} opts
 * @param {Array<{name: string, description?: string}>} opts.commands
 * @param {string} [opts.searchCommand] 搜索命令名(不含 / 前缀),前端搜索框据此触发后端搜索
 * @returns {import('./schema').CommandPaletteSection}
 */
function commandPalette(opts) {
  const sec = { kind: 'commandPalette', commands: opts.commands };
  if (opts.searchCommand !== undefined) sec.searchCommand = opts.searchCommand;
  return sec;
}

module.exports = {
  card,
  action,
  btn,
  linkBtn,
  md,
  divider,
  note,
  buttons,
  kv,
  select,
  input,
  image,
  table,
  permission,
  permissionButtons,
  question,
  progress,
  statusReport,
  sessionList,
  commandPalette,
};
