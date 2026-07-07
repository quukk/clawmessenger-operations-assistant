/**
 * CardKit Schema —— 平台无关的卡片 UI 框架协议定义(JS 版)。
 *
 * 从 opencode-clawmessenger/src/cardkit/schema.ts 翻译而来。
 * 字段名 / 枚举值 / 判别字段必须与 TS 版逐字一致 —— 这是插件与小程序之间的公共契约。
 *
 * 设计原则:
 *  - 判别联合(discriminated union)用 kind/type 字段区分;JS 没有真正的联合类型,
 *    用 JSDoc @typedef + 字符串字面量联合表达,VSCode 可据此提供智能感知
 *  - 原子组件 + 业务模板分层:既支持开箱即用,又允许 agent 自由组合
 *  - 平台无关:不绑定融云/飞书的专有字段,由各自的 Renderer/Transport 翻译
 *  - 自文档:所有类型附 JSDoc,小程序端可据此独立实现渲染器
 */

'use strict';

// ============================================================================
// 协议版本
// ============================================================================

/** 当前卡片协议版本。小程序据此判断能否渲染,不兼容时降级提示。 */
const CARD_SCHEMA_VERSION = '1.0.0';

// ============================================================================
// 通用基础类型(JSDoc 表达)
// ============================================================================

/**
 * 卡片头部主题色。小程序自行映射为具体色值。
 * @typedef {('default'|'blue'|'green'|'turquoise'|'orange'|'red'|'grey'|'purple')} CardColor
 */

/**
 * 按钮视觉样式。
 * @typedef {('primary'|'default'|'danger'|'success'|'text')} ButtonVariant
 */

/**
 * 按钮行布局方式。
 * @typedef {('inline'|'flow'|'stack')} ButtonLayout
 */

/**
 * Markdown 子集渲染支持范围(小程序需自行实现或引入库)。
 * @typedef {Object} MarkdownSupport
 * @property {boolean} bold **加粗**
 * @property {boolean} italic *斜体*
 * @property {boolean} inlineCode `行内代码`
 * @property {boolean} codeBlock ```代码块```
 * @property {boolean} link [文本](url) 链接
 * @property {boolean} colorFont <font color='grey'>彩色文字</font>,色值: grey/red/green/blue
 * @property {boolean} list 有序/无序列表
 */

// ============================================================================
// Action 协议 —— 按钮点击的回传契约
// ============================================================================

/**
 * 按钮点击行为定义。用户点击按钮后,小程序按此结构发回 `card_action` 消息。
 *
 * - 预置业务动作(permission/answer/command 等):插件知道如何处理
 * - custom:agent 自定义动作,插件原样回传给 opencode 作为新 prompt 或事件
 * - none:纯展示按钮或仅跳外链(配合 button.url)
 *
 * 判别字段 `type` 取值清单见 `ACTION_TYPES`。
 *
 * @typedef {Object} CardAction
 * @property {('permission'|'answer'|'command'|'session'|'navigate'|'custom'|'none')} type 动作判别字段
 * @property {string} [permissionId] type=permission 时必填:权限请求 id(透传 opencode)
 * @property {('once'|'always'|'reject')} [reply] type=permission 时必填
 * @property {string} [questionId] type=answer 时必填:问题 id
 * @property {string[]} [value] type=answer 时必填:选中选项 label 数组
 * @property {string} [name] type=command 时必填:斜杠命令名
 * @property {('switch'|'delete')} [op] type=session 时必填
 * @property {string} [sessionId] type=session 时必填
 * @property {string} [target] type=navigate 时必填:导航目标
 * @property {string} [kind] type=custom 时必填:自定义动作名
 * @property {Record<string, unknown>} [payload] type=custom 时必填:任意数据
 */

/** Action 的判别字段值清单,用于校验。 */
const ACTION_TYPES = [
  'permission', 'answer', 'command', 'session', 'navigate', 'custom', 'none',
];

// ============================================================================
// 按钮
// ============================================================================

/**
 * 下拉选项。
 * @typedef {Object} SelectOption
 * @property {string} label
 * @property {string} value
 */

/**
 * 交互按钮。点击后触发 action(或跳转 url)。
 * 同一张卡内的按钮 id 应唯一,用于回传时定位。
 *
 * @typedef {Object} CardButton
 * @property {string} [id] 按钮唯一标识(同卡内),回传时作为 buttonId
 * @property {string} label 按钮文字
 * @property {string} [icon] 图标(emoji 或图标 key,小程序自行映射)
 * @property {ButtonVariant} [variant] 视觉样式
 * @property {boolean} [disabled] 是否禁用
 * @property {CardAction} action 点击行为(action 与 url 二选一)
 * @property {string} [url] 外链跳转地址(与 action 二选一,有 url 时优先跳转)
 */

// ============================================================================
// 卡片段落(Section)—— 原子组件
// ============================================================================

/**
 * 富文本段落(markdown 子集)。
 * @typedef {Object} MarkdownSection
 * @property {'markdown'} kind
 * @property {string} content markdown 文本
 * @property {boolean} [collapsed] 是否默认折叠(思考过程等长文本)
 */

/**
 * 分隔线。
 * @typedef {Object} DividerSection
 * @property {'divider'} kind
 */

/**
 * 注释/提示(灰色小字,辅助说明)。
 * @typedef {Object} NoteSection
 * @property {'note'} kind
 * @property {string} text 注释文本(纯文本,不渲染 markdown)
 */

/**
 * 按钮行(1~N 个按钮)。
 * @typedef {Object} ButtonRowSection
 * @property {'buttonRow'} kind
 * @property {CardButton[]} buttons
 * @property {ButtonLayout} [layout] 布局:inline 横排 / flow 流式换行 / stack 竖排
 */

/**
 * 键值列表项。
 * @typedef {Object} KeyValueItem
 * @property {string} label
 * @property {string} value
 * @property {string} [icon]
 */

/**
 * 键值列表(状态/属性展示)。
 * @typedef {Object} KeyValueSection
 * @property {'keyValue'} kind
 * @property {KeyValueItem[]} items
 */

/**
 * 下拉选择(配合 action 回传选中项)。
 * @typedef {Object} SelectSection
 * @property {'select'} kind
 * @property {string} placeholder 占位提示
 * @property {SelectOption[]} options
 * @property {CardAction} action 选中后触发的 action(通常 type='custom',payload 带选中值)
 */

/**
 * 输入框(配合提交按钮)。
 * @typedef {Object} InputSection
 * @property {'input'} kind
 * @property {string} placeholder 占位提示
 * @property {string} [label] 输入框前缀标签
 * @property {boolean} [multiline] 是否多行输入
 * @property {CardButton} [submitButton] 提交按钮(点击时 action 触发,payload 带 inputValue)
 */

/**
 * 图片。
 * @typedef {Object} ImageSection
 * @property {'image'} kind
 * @property {string} src 图片地址
 * @property {string} [alt] 替代文本
 * @property {string} [url] 点击图片跳转地址(可选)
 */

/**
 * 表格列定义。
 * @typedef {Object} TableColumn
 * @property {string} key
 * @property {string} label
 * @property {number} [width]
 */

/**
 * 简易表格(会话列表/文件列表等)。
 * @typedef {Object} TableSection
 * @property {'table'} kind
 * @property {TableColumn[]} columns 列定义
 * @property {Array<Record<string, string>>} rows 行数据(每行是 key→value 的映射)
 */

// ============================================================================
// 卡片段落(Section)—— 业务模板(开箱即用)
// ============================================================================

/**
 * 授权请求段落。渲染为权限说明 + 三按钮(确认/始终允许/拒绝)。
 * 若不提供 buttons,小程序按默认三按钮渲染。
 *
 * @typedef {Object} PermissionSection
 * @property {'permission'} kind
 * @property {string} permissionId 权限标识(透传给 opencode)
 * @property {string} permission 权限类型,如 "bash" / "edit"
 * @property {string} title 权限标题/描述
 * @property {string[]} patterns 匹配范围(文件 glob 或命令模式)
 * @property {CardButton[]} [buttons] 自定义按钮(不提供则用默认三按钮)
 */

/**
 * 问答段落(单选/多选)。
 * @typedef {Object} QuestionSection
 * @property {'question'} kind
 * @property {string} questionId 问题标识(回传 answer 时对应)
 * @property {string} header 问题标题
 * @property {string} question 问题正文
 * @property {Array<{label: string, description?: string}>} options 可选项
 * @property {boolean} [multiple] 是否多选
 * @property {boolean} [custom] 是否允许自定义输入
 */

/**
 * 进度段落(工具执行/思考过程/计时)。
 * @typedef {Object} ProgressSection
 * @property {'progress'} kind
 * @property {Array<{name: string, status: ('running'|'completed'|'error'), error?: string}>} [tools] 正在执行的工具列表
 * @property {string} [thinking] 思考过程文本(markdown)
 * @property {number} [elapsedMs] 已耗时(毫秒),小程序格式化为 mm:ss
 * @property {boolean} [done] 是否已完成
 */

/**
 * git/项目状态报告段落。
 * @typedef {Object} StatusReportSection
 * @property {'statusReport'} kind
 * @property {string} [branch] 当前分支
 * @property {string} [commit] 当前提交 hash(短)
 * @property {Array<{path: string, status: string}>} [files] 变更文件列表
 */

/**
 * 会话列表段落(带切换/删除按钮)。
 * @typedef {Object} SessionListSection
 * @property {'sessionList'} kind
 * @property {string} [currentSessionId] 当前会话 id
 * @property {Array<{id: string, title: string, updatedAt?: number}>} sessions 会话列表
 * @property {string} [searchCommand] 搜索命令名(不含 / 前缀)。前端搜索框输入关键词后,
 *   会触发 {type:'command', name: searchCommand + ' ' + keyword},由 dispatcher reinject
 *   '/<searchCommand> <keyword>' 请求后端返回匹配的子集。仅在列表因体积被截断、
 *   需要后端搜索补全时设置。
 */

/**
 * 命令面板段落(可点击的命令列表)。
 * @typedef {Object} CommandPaletteSection
 * @property {'commandPalette'} kind
 * @property {Array<{name: string, description?: string}>} commands
 * @property {string} [searchCommand] 搜索命令名(不含 / 前缀)。前端搜索框输入关键词后,
 *   会触发 {type:'command', name: searchCommand + ' ' + keyword},由 dispatcher reinject
 *   '/<searchCommand> <keyword>' 请求后端返回匹配的子集。仅在列表因体积被截断、
 *   需要后端搜索补全时设置。
 */

// ============================================================================
// Section 联合类型
// ============================================================================

/**
 * 卡片段落判别联合。agent 像搭积木一样,在 sections 数组里自由组合
 * 任意数量、任意类型的段落,构成任意交互式卡片。
 *
 * 分两层:
 *  - 原子组件(markdown/divider/note/buttonRow/keyValue/select/input/image/table)
 *  - 业务模板(permission/question/progress/statusReport/sessionList/commandPalette)
 *
 * 通过 `kind` 字段判别。合法 kind 清单见 `SECTION_KINDS`。
 *
 * @typedef {(MarkdownSection|DividerSection|NoteSection|ButtonRowSection|KeyValueSection|SelectSection|InputSection|ImageSection|TableSection|PermissionSection|QuestionSection|ProgressSection|StatusReportSection|SessionListSection|CommandPaletteSection)} CardSection
 */

/** 所有合法的 section kind 值,用于校验。 */
const SECTION_KINDS = [
  // 原子组件
  'markdown', 'divider', 'note', 'buttonRow', 'keyValue', 'select', 'input', 'image', 'table',
  // 业务模板
  'permission', 'question', 'progress', 'statusReport', 'sessionList', 'commandPalette',
];

// ============================================================================
// 卡片顶层模型
// ============================================================================

/**
 * 卡片头部。
 * @typedef {Object} CardHeader
 * @property {string} title 标题(可含 emoji)
 * @property {string} [icon] 图标(emoji 或图标 key)
 * @property {CardColor} [color] 主题色
 * @property {string} [subtitle] 副标题/描述
 */

/**
 * 卡片级配置。
 * @typedef {Object} CardConfig
 * @property {boolean} [wide] 宽屏模式(群聊大屏)
 * @property {boolean} [collapsible] 是否可折叠(默认展开)
 */

/**
 * 一张完整的交互式卡片。这是 agent 生成、插件传输、小程序渲染的统一数据模型。
 *
 * @typedef {Object} CardModel
 * @property {string} schema 协议版本,小程序校验兼容性
 * @property {string} id 卡片唯一 ID。card_update 时小程序按此 id 替换已渲染的同 id 卡片
 * @property {CardHeader} header 卡片头部
 * @property {CardSection[]} sections 有序段落数组 —— agent 按需组合
 * @property {CardConfig} [config] 卡片级配置
 * @property {string} [reasoning] 思考/推理内容(由前端独立展示,不渲染在 sections 中)
 * @property {boolean} [loading] 是否处于加载状态(占位卡片用,前端显示加载动画)
 */

module.exports = {
  CARD_SCHEMA_VERSION,
  ACTION_TYPES,
  SECTION_KINDS,
};
