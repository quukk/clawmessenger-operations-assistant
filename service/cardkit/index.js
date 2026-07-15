/**
 * CardKit —— 平台无关的卡片 UI 框架公共组件包(JS 版,汇总导出)。
 *
 * 从 opencode-clawmessenger/src/cardkit/index.ts 翻译而来。
 * 导出清单与 TS 版保持一致(类型导出在 JS 中通过 JSDoc 表达,见各子模块)。
 *
 * 这是 opencode-clawmessenger 插件与 clawmessenger 小程序之间的契约:
 * 智能体按本包定义的 schema 生成任意交互式卡片,插件负责传输,小程序渲染。
 */

'use strict';

// 协议定义
const schema = require('./schema');
const { CARD_SCHEMA_VERSION, ACTION_TYPES, SECTION_KINDS } = schema;

// 构造器 DSL
const builders = require('./builders');
const {
  card, action, btn, linkBtn, md, divider, note, buttons, kv, select, input, image, table,
  permission, permissionButtons, question, progress, statusReport, sessionList, commandPalette,
} = builders;

// 校验器
const { validateCard } = require('./validate');

// 生命周期控制器(传输层在 rongcloud/card-transport.js,按需导入)
const { CardUpdateController } = require('./update-controller');

// Agent 能力说明(注入 system prompt)
const { CARDKIT_AGENT_PROMPT } = require('./agent-prompt');

// 按钮动作路由器
const { ActionRouter } = require('./action-router');

// 标记解析器(流式场景用)
const { streamSafeBoundary, streamSafeContent, extractMarkers, stripMarkers } = require('./parse-marker');

// 预置业务卡片模板
const {
  permissionCard, errorCard, noticeCard, statusCard, sessionsCard, commandsCard,
} = require('./templates');

// 模型选择卡片
const { buildProviderListCard, buildModelsCard } = require('./model-cards');

module.exports = {
  // 协议定义
  CARD_SCHEMA_VERSION,
  ACTION_TYPES,
  SECTION_KINDS,

  // 构造器 DSL
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

  // 校验器
  validateCard,

  // 生命周期控制器
  CardUpdateController,

  // Agent 能力说明
  CARDKIT_AGENT_PROMPT,

  // 按钮动作路由器
  ActionRouter,

  // 标记解析器
  streamSafeBoundary,
  streamSafeContent,
  extractMarkers,
  stripMarkers,

  // 预置业务卡片模板
  permissionCard,
  errorCard,
  noticeCard,
  statusCard,
  sessionsCard,
  commandsCard,

  // 模型选择卡片
  buildProviderListCard,
  buildModelsCard,
};
