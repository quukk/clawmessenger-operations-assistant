/**
 * CardKit 校验器 —— 在卡片传输前验证 CardModel 合法性(JS 版)。
 *
 * 从 opencode-clawmessenger/src/cardkit/validate.ts 翻译而来。
 * 校验逻辑、错误信息、白名单值必须与 TS 版逐字一致。
 *
 * 宽容策略:绝不抛异常中断流程。非法段剔除而非整卡失败,
 * 缺字段降级补全而非拒绝。返回 { valid, errors, warnings, sanitized }。
 */

'use strict';

const { CARD_SCHEMA_VERSION, ACTION_TYPES, SECTION_KINDS } = require('./schema');

/**
 * @typedef {Object} ValidationResult
 * @property {boolean} valid
 * @property {string[]} errors 错误信息清单(空数组表示合法)
 * @property {string[]} warnings 非致命警告(如协议版本不匹配),不阻断渲染,小程序可降级处理
 * @property {import('./schema').CardModel} [sanitized] 修正后的卡片(补默认值,非法段被剔除)。valid=true 时可安全使用
 */

const ACTION_TYPE_SET = new Set(ACTION_TYPES);
const SECTION_KIND_SET = new Set(SECTION_KINDS);
const VALID_COLORS = new Set(['default', 'blue', 'green', 'turquoise', 'orange', 'red', 'grey', 'purple']);

/**
 * 白名单清洗 config 字段:仅保留已知布尔字段(wide/collapsible),
 * 拒绝任意未知内容透传(防止 agent 注入非预期字段进 sanitized)。
 * @param {any} config
 * @returns {{config?: import('./schema').CardConfig}}
 */
function sanitizeConfig(config) {
  if (!config || typeof config !== 'object') return {};
  const out = {};
  if (typeof config.wide === 'boolean') out.wide = config.wide;
  if (typeof config.collapsible === 'boolean') out.collapsible = config.collapsible;
  return Object.keys(out).length > 0 ? { config: out } : {};
}

/**
 * 校验卡片模型,返回结果与修正后的卡片(若基本可用)。
 * @param {unknown} input
 * @returns {ValidationResult}
 */
function validateCard(input) {
  const errors = [];
  const warnings = [];

  if (typeof input !== 'object' || input === null) {
    return { valid: false, errors: ['卡片必须是对象'], warnings };
  }
  const raw = input;

  // ---- 顶层必填 ----
  if (typeof raw.id !== 'string' || !raw.id.trim()) {
    errors.push('缺少必填字段: id(卡片唯一标识)');
  }
  if (typeof raw.schema !== 'string') {
    // 缺 schema:非致命,补全为当前版本(降级兼容旧版/简写)
    warnings.push(`缺少协议版本字段 schema,已补全为 ${CARD_SCHEMA_VERSION}`);
  } else if (raw.schema !== CARD_SCHEMA_VERSION) {
    // 版本不匹配:非致命警告,不阻断渲染,小程序可降级提示。
    warnings.push(`协议版本不匹配: 期望 ${CARD_SCHEMA_VERSION}, 实际 ${raw.schema}`);
  }
  if (typeof raw.header !== 'object' || raw.header === null) {
    errors.push('缺少 header 对象');
  } else if (typeof raw.header.title !== 'string') {
    // title 必须是字符串,但允许为空字符串:
    // 普通聊天卡片传空 title,前端 v-if="cardKitHeaderTitle" 空值守卫会隐藏整块 header。
    errors.push('header.title 必须是字符串');
  }
  if (!Array.isArray(raw.sections)) {
    errors.push('sections 必须是数组');
  }

  // 基本结构都不对,无法继续
  if (errors.length > 0) {
    return { valid: false, errors, warnings };
  }

  // ---- 逐段校验 + 过滤非法段 ----
  const validSections = [];
  const sectionErrors = [];
  const seenButtonIds = new Set();

  raw.sections.forEach((sec, idx) => {
    const secErrs = validateSection(sec, idx, seenButtonIds);
    if (secErrs.length === 0) {
      validSections.push(sec);
    } else {
      // 段非法:剔除而非整体失败(保留可用部分)
      sectionErrors.push(...secErrs);
    }
  });

  // 只要还有合法段,卡片就可发送(非法段已剔除);被剔的段降级为 warning 而非致命。
  // 仅当所有段都非法(或无段)时才认为不可发送。
  const sendable = validSections.length > 0;

  // 组装修正后的卡片(所有字段强制类型转换,config 白名单校验,防注入)
  const sanitized = {
    schema: CARD_SCHEMA_VERSION,
    id: String(raw.id),
    header: {
      title: String(raw.header.title),
      ...(raw.header.icon ? { icon: String(raw.header.icon) } : {}),
      ...(typeof raw.header.color === 'string' && VALID_COLORS.has(raw.header.color) ? { color: raw.header.color } : {}),
      ...(raw.header.subtitle ? { subtitle: String(raw.header.subtitle) } : {}),
    },
    sections: validSections,
    // config 白名单:仅保留已知布尔字段,拒绝任意嵌套内容透传
    ...sanitizeConfig(raw.config),
    // reasoning:仅保留非空字符串
    ...(typeof raw.reasoning === 'string' && raw.reasoning.length > 0 ? { reasoning: raw.reasoning } : {}),
    // loading:仅当显式为 true 时保留
    ...(raw.loading === true ? { loading: true } : {}),
  };

  return {
    valid: sendable,
    // 不可发送时,sectionErrors 才是致命错误;可发送时它们降级为 warning(段已被剔除)
    errors: sendable ? [] : sectionErrors,
    warnings: sendable
      ? [...warnings, ...sectionErrors.map((e) => `已剔除非法段: ${e}`)]
      : warnings,
    sanitized: sendable ? sanitized : undefined,
  };
}

/**
 * 校验单个段落。
 * @param {any} sec
 * @param {number} idx
 * @param {Set<string>} seenButtonIds
 * @returns {string[]}
 */
function validateSection(sec, idx, seenButtonIds) {
  const errs = [];
  const prefix = `段落[${idx}]`;

  if (typeof sec !== 'object' || sec === null) {
    return [`${prefix}: 必须是对象`];
  }
  if (typeof sec.kind !== 'string' || !SECTION_KIND_SET.has(sec.kind)) {
    return [`${prefix}: 未知或缺失的 kind "${sec.kind}"`];
  }

  // 各 kind 的特定校验
  switch (sec.kind) {
    case 'markdown':
      if (typeof sec.content !== 'string' || !sec.content.trim()) {
        errs.push(`${prefix}(markdown): content 不能为空`);
      }
      break;

    case 'note':
      if (typeof sec.text !== 'string') {
        errs.push(`${prefix}(note): text 不能为空`);
      }
      break;

    case 'divider':
      break; // 无字段

    case 'buttonRow':
      if (!Array.isArray(sec.buttons) || sec.buttons.length === 0) {
        errs.push(`${prefix}(buttonRow): buttons 不能为空`);
      } else {
        sec.buttons.forEach((b, bi) => {
          const bErrs = validateButton(b, `${prefix}.button[${bi}]`, seenButtonIds);
          errs.push(...bErrs);
        });
      }
      break;

    case 'keyValue':
      if (!Array.isArray(sec.items)) {
        errs.push(`${prefix}(keyValue): items 必须是数组`);
      } else {
        sec.items.forEach((it, ii) => {
          if (typeof it?.label !== 'string' || typeof it?.value !== 'string') {
            errs.push(`${prefix}(keyValue).item[${ii}]: label/value 必须是字符串`);
          }
        });
      }
      break;

    case 'select':
      if (typeof sec.placeholder !== 'string') errs.push(`${prefix}(select): 缺 placeholder`);
      if (!Array.isArray(sec.options) || sec.options.length === 0) {
        errs.push(`${prefix}(select): options 不能为空`);
      }
      if (sec.action) errs.push(...validateAction(sec.action, `${prefix}(select).action`));
      break;

    case 'input':
      if (typeof sec.placeholder !== 'string') errs.push(`${prefix}(input): 缺 placeholder`);
      if (sec.submitButton) {
        errs.push(...validateButton(sec.submitButton, `${prefix}(input).submitButton`, seenButtonIds));
      }
      break;

    case 'image':
      if (typeof sec.src !== 'string' || !sec.src.trim()) {
        errs.push(`${prefix}(image): src 不能为空`);
      }
      break;

    case 'table':
      if (!Array.isArray(sec.columns) || !Array.isArray(sec.rows)) {
        errs.push(`${prefix}(table): columns/rows 必须是数组`);
      }
      break;

    case 'permission':
      if (typeof sec.permissionId !== 'string') errs.push(`${prefix}(permission): 缺 permissionId`);
      if (typeof sec.permission !== 'string') errs.push(`${prefix}(permission): 缺 permission`);
      if (typeof sec.title !== 'string') errs.push(`${prefix}(permission): 缺 title`);
      if (!Array.isArray(sec.patterns)) errs.push(`${prefix}(permission): patterns 必须是数组`);
      if (Array.isArray(sec.buttons)) {
        sec.buttons.forEach((b, bi) => {
          errs.push(...validateButton(b, `${prefix}(permission).button[${bi}]`, seenButtonIds));
        });
      }
      break;

    case 'question':
      if (typeof sec.questionId !== 'string') errs.push(`${prefix}(question): 缺 questionId`);
      if (typeof sec.header !== 'string') errs.push(`${prefix}(question): 缺 header`);
      if (!Array.isArray(sec.options)) errs.push(`${prefix}(question): options 必须是数组`);
      break;

    case 'progress':
      // 所有字段可选,仅校验 tools 数组结构
      if (Array.isArray(sec.tools)) {
        sec.tools.forEach((t, ti) => {
          if (typeof t?.name !== 'string') errs.push(`${prefix}(progress).tool[${ti}]: 缺 name`);
          if (t?.status && !['running', 'completed', 'error'].includes(t.status)) {
            errs.push(`${prefix}(progress).tool[${ti}]: 非法 status "${t.status}"`);
          }
        });
      }
      break;

    case 'statusReport':
      // 所有字段可选
      if (sec.files && !Array.isArray(sec.files)) errs.push(`${prefix}(statusReport): files 必须是数组`);
      break;

    case 'sessionList':
      if (!Array.isArray(sec.sessions)) {
        errs.push(`${prefix}(sessionList): sessions 必须是数组`);
      }
      break;

    case 'commandPalette':
      // commands 和 groups 二选一(有 groups 时不要求 commands)
      const hasCommands = Array.isArray(sec.commands);
      const hasGroups = Array.isArray(sec.groups);
      if (!hasCommands && !hasGroups) {
        errs.push(`${prefix}(commandPalette): commands 或 groups 至少需要一个数组`);
      }
      if (hasGroups) {
        sec.groups.forEach((g, gi) => {
          if (typeof g !== 'object' || g === null) {
            errs.push(`${prefix}(commandPalette).groups[${gi}]: 必须是对象`);
            return;
          }
          if (typeof g.label !== 'string' || !g.label.trim()) {
            errs.push(`${prefix}(commandPalette).groups[${gi}].label: 不能为空`);
          }
          if (!Array.isArray(g.items)) {
            errs.push(`${prefix}(commandPalette).groups[${gi}].items: 必须是数组`);
          }
        });
      }
      break;

    default:
      errs.push(`${prefix}: 未实现的 kind "${sec.kind}"`);
  }

  return errs;
}

/**
 * 校验按钮。
 * @param {any} btn
 * @param {string} prefix
 * @param {Set<string>} seenButtonIds
 * @returns {string[]}
 */
function validateButton(btn, prefix, seenButtonIds) {
  const errs = [];
  if (typeof btn !== 'object' || btn === null) {
    return [`${prefix}: 必须是对象`];
  }
  if (typeof btn.label !== 'string' || !btn.label.trim()) {
    errs.push(`${prefix}: label 不能为空`);
  }
  // id 唯一性(可选)
  if (typeof btn.id === 'string' && btn.id) {
    if (seenButtonIds.has(btn.id)) {
      errs.push(`${prefix}: 重复的按钮 id "${btn.id}"`);
    } else {
      seenButtonIds.add(btn.id);
    }
  }
  // action 与 url 至少一个(url 优先时 action 可为 none)
  if (!btn.url) {
    errs.push(...validateAction(btn.action, `${prefix}.action`));
  }
  return errs;
}

/**
 * 校验 Action。
 * @param {any} action
 * @param {string} prefix
 * @returns {string[]}
 */
function validateAction(action, prefix) {
  const errs = [];
  if (typeof action !== 'object' || action === null) {
    return [`${prefix}: 必须是对象`];
  }
  if (typeof action.type !== 'string' || !ACTION_TYPE_SET.has(action.type)) {
    return [`${prefix}: 未知 type "${action.type}"`];
  }
  const a = action;
  switch (a.type) {
    case 'permission':
      if (typeof a.permissionId !== 'string') errs.push(`${prefix}(permission): 缺 permissionId`);
      if (!['once', 'always', 'reject'].includes(a.reply)) errs.push(`${prefix}(permission): 非法 reply`);
      break;
    case 'answer':
      if (typeof a.questionId !== 'string') errs.push(`${prefix}(answer): 缺 questionId`);
      if (!Array.isArray(a.value)) errs.push(`${prefix}(answer): value 必须是数组`);
      else if (a.value.length === 0) errs.push(`${prefix}(answer): value 不能为空数组`);
      break;
    case 'command':
      if (typeof a.name !== 'string') errs.push(`${prefix}(command): 缺 name`);
      break;
    case 'session':
      if (!['switch', 'delete'].includes(a.op)) errs.push(`${prefix}(session): 非法 op`);
      if (typeof a.sessionId !== 'string') errs.push(`${prefix}(session): 缺 sessionId`);
      break;
    case 'navigate':
      if (typeof a.target !== 'string') errs.push(`${prefix}(navigate): 缺 target`);
      break;
    case 'custom':
      if (typeof a.kind !== 'string') errs.push(`${prefix}(custom): 缺 kind`);
      if (typeof a.payload !== 'object') errs.push(`${prefix}(custom): payload 必须是对象`);
      break;
    case 'none':
      break;
  }
  return errs;
}

// 内部辅助函数(不再对外导出)
// validateSection, validateButton, validateAction, sanitizeConfig 均为 validateCard 内部使用。

module.exports = {
  validateCard,
};
