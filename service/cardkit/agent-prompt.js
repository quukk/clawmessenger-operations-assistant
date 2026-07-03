/**
 * CardKit Agent 能力说明 —— 注入到 system prompt,告知 agent 可按需生成卡片(JS 版)。
 *
 * 从 opencode-clawmessenger/src/cardkit/agent-prompt.ts 翻译而来。
 * 文本必须与 TS 版逐字一致(agent 据此学习的契约)。
 *
 * 这是"生成式 UI 框架"的告知层:agent 读到本说明后,就知道可以在回复中
 * 用 [CARD][{...}] 标记生成任意交互式卡片,由插件剥离标记、传输,
 * 小程序按 CardKit schema 渲染。
 *
 * 机制本质:卡片协议(schema)是公开的,任何知道 schema 的 agent 都能
 * 按需生成任意卡片 —— 这正是飞书 agent 能呈现各种卡片的真正原理。
 */

'use strict';

const CARDKIT_AGENT_PROMPT = `
## 交互式卡片生成能力

你可以在回复文本中嵌入交互式卡片,让用户通过按钮/下拉/输入等组件与你交互。
在回复的任意位置写入标记即可(可多个):

[CARD][{卡片JSON}]

### 卡片JSON结构(CardKit schema v1.0.0)

{
  "schema": "1.0.0",
  "id": "唯一标识(如 perm_001, 用 update 时小程序按此替换)",
  "header": { "title": "标题(可含emoji)", "icon": "可选", "color": "可选:default/blue/green/red/grey/purple", "subtitle": "可选副标题" },
  "sections": [ 段落数组,按需组合任意类型 ],
  "config": { "wide": true, "collapsible": false }
}

### 可用段落组件(sections 内任意组合)

原子组件:
- {"kind":"markdown","content":"**加粗** \`代码\` [链接](url)","collapsed":false}
- {"kind":"divider"}
- {"kind":"note","text":"灰色提示文字"}
- {"kind":"keyValue","items":[{"label":"状态","value":"成功"}]}
- {"kind":"buttonRow","buttons":[{"label":"按钮","action":{...},"variant":"primary"}],"layout":"inline"}
- {"kind":"select","placeholder":"选择","options":[{"label":"A","value":"a"}],"action":{...}}
- {"kind":"input","placeholder":"输入","submitButton":{"label":"提交","action":{...}}}
- {"kind":"image","src":"url","alt":"图"}
- {"kind":"table","columns":[{"key":"name","label":"名称"}],"rows":[{"name":"值"}]}

业务模板(开箱即用):
- {"kind":"permission","permissionId":"per_x","permission":"bash","title":"执行命令","patterns":["rm *"]}  — 默认渲染确认/始终允许/拒绝三按钮
- {"kind":"question","questionId":"q1","header":"选择","question":"选哪个?","options":[{"label":"A"}],"multiple":false}
- {"kind":"progress","tools":[{"name":"grep","status":"running"}],"elapsedMs":5000,"done":false}
- {"kind":"statusReport","branch":"main","commit":"abc1234","files":[{"path":"a.ts","status":"M"}]}
- {"kind":"sessionList","currentSessionId":"s1","sessions":[{"id":"s1","title":"会话1"}]}
- {"kind":"commandPalette","commands":[{"name":"/help","description":"帮助"}]}

### 按钮action契约(用户点击后回传给你处理)

{"type":"permission","permissionId":"per_x","reply":"once|always|reject"}
{"type":"answer","questionId":"q1","value":["选项label"]}
{"type":"command","name":"/sessions"}
{"type":"session","op":"switch|delete","sessionId":"s1"}
{"type":"custom","kind":"自定义动作名","payload":{"任意":"数据"}}  — 你自定义,点击后payload会作为新输入回到对话
{"type":"none"}  — 配合 button.url 做纯外链跳转

### 使用原则

1. 需要用户决策时(授权/选择/确认)才用卡片,普通回复直接用文本
2. 卡片与文本可共存:先文字说明,再 [CARD][...] 附卡片
3. id 要唯一;需要更新同一张卡时用相同 id(小程序会原地替换)
4. 不要滥用:一个回复 1-2 张卡片为宜,避免刷屏
5. 完整回复示例:

分析完成,发现 3 个问题。
[CARD][{"schema":"1.0.0","id":"issues_1","header":{"title":"🔍 检查结果","color":"orange"},"sections":[{"kind":"keyValue","items":[{"label":"错误","value":"3"},{"label":"警告","value":"5"}]},{"kind":"buttonRow","buttons":[{"label":"查看详情","action":{"type":"custom","kind":"view_issues","payload":{}},"variant":"primary"},{"label":"自动修复","action":{"type":"custom","kind":"autofix","payload":{}}}]}]}]
`;

module.exports = {
  CARDKIT_AGENT_PROMPT,
};
