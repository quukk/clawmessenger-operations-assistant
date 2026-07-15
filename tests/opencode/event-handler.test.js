/**
 * EventHandler 冒烟测试(纯 Node.js assert,mock opencode SSE 流)
 *
 * 验证:
 *   1. registerSession 注册映射后,message.part.delta 正确调用 sendStreamChunk
 *      首次 delta 先发 thinking(seq=1,extra),再发 responding(seq=2,增量)
 *   2. session.idle 发 completed(is_final)+ 调 sendFinalCard
 *   3. session.error 发 error 终态 + 调 sendErrorCard
 *   4. 无路由映射的 delta 被跳过
 */
const assert = require('assert');
const { EventHandler } = require('../../service/opencode/event-handler');

async function* mockStream(events) {
  for (const ev of events) {
    yield ev;
  }
}

async function run() {
  // 收集发送的流片
  const sent = [];
  let finalCardCalled = null;
  let errorCardCalled = null;

  const handler = new EventHandler({
    opencode: {}, // 本测试不调用 opencode
    log: { info() {}, warn() {}, error() {}, debug() {} },
    sendStreamChunk: async (targetId, streamId, isFirst, isLast, seq, opts) => {
      sent.push({ targetId, streamId, isFirst, isLast, seq, ...opts });
    },
    sendFinalCard: async (ctx) => { finalCardCalled = ctx; },
    sendErrorCard: async (ctx) => { errorCardCalled = ctx; },
  });

  // 注入 mock 事件流并直接测试 _handleEvent(不启动 runEventLoop,避免重订阅逻辑)
  // 注册路由映射
  const sessionId = 'sess-test-1';
  handler.registerSession(sessionId, {
    chatId: 'ops-user1',
    targetId: 'user1',
    senderUserId: 'user1',
    convType: 1,
    cardId: 'card-1',
    streamId: 'stream-1',
  });

  // === 测试 1:首条 delta 先发 thinking,再发 responding ===
  await handler._handleEvent({ type: 'message.part.delta', properties: { sessionID: sessionId, delta: 'Hello' } });
  assert.strictEqual(sent.length, 2, '首条 delta 应发 2 片(thinking + responding)');

  const thinkingChunk = sent[0];
  assert.strictEqual(thinkingChunk.isFirst, true, 'thinking 应是首流');
  assert.strictEqual(thinkingChunk.isLast, false);
  assert.strictEqual(thinkingChunk.seq, 1, 'thinking seq=1');
  assert.strictEqual(thinkingChunk.streamDelta.session_status, 'thinking');
  assert.ok(thinkingChunk.extra, '首流应带 extra 卡片壳');
  assert.strictEqual(thinkingChunk.extra.card_id, 'card-1', 'extra.card_id 应与 cardId 一致');

  const respondingChunk = sent[1];
  assert.strictEqual(respondingChunk.isFirst, false);
  assert.strictEqual(respondingChunk.seq, 2, 'responding seq=2');
  assert.strictEqual(respondingChunk.streamDelta.session_status, 'responding');
  assert.strictEqual(respondingChunk.streamDelta.content, 'Hello', '增量内容应为 Hello');

  // === 测试 2:第二条 delta 只发 responding(seq=3),不重复 thinking ===
  await handler._handleEvent({ type: 'message.part.delta', properties: { sessionID: sessionId, delta: ' World' } });
  assert.strictEqual(sent.length, 3, '第二条 delta 应只发 1 片');
  const secondDelta = sent[2];
  assert.strictEqual(secondDelta.seq, 3);
  assert.strictEqual(secondDelta.streamDelta.content, ' World');
  assert.strictEqual(secondDelta.extra, undefined, '后续流不应带 extra');

  // === 测试 3:空内容 delta 不发 responding(但仍正常处理) ===
  const beforeLen = sent.length;
  await handler._handleEvent({ type: 'message.part.delta', properties: { sessionID: sessionId, delta: '' } });
  assert.strictEqual(sent.length, beforeLen, '空 delta 不应发 responding 流片');

  // === 测试 4:session.idle 发 completed 终态 + 调 sendFinalCard ===
  await handler._handleEvent({ type: 'session.idle', properties: { sessionID: sessionId } });
  const completed = sent[sent.length - 1];
  assert.strictEqual(completed.isLast, true, 'completed 应是尾流');
  assert.ok(completed.streamDelta.is_final, 'completed 应 is_final=true');
  assert.strictEqual(completed.streamDelta.session_status, 'completed');
  assert.strictEqual(completed.streamDelta.content, '', 'completed content 应为空(最终卡片承载内容)');

  assert.ok(finalCardCalled, 'sendFinalCard 应被调用');
  assert.strictEqual(finalCardCalled.cardId, 'card-1');
  assert.strictEqual(finalCardCalled.fullContent, 'Hello World');

  // === 测试 5:idle 后该 session 标记完成,迟到的 delta 被丢弃 ===
  const lenAfterIdle = sent.length;
  await handler._handleEvent({ type: 'message.part.delta', properties: { sessionID: sessionId, delta: 'late' } });
  assert.strictEqual(sent.length, lenAfterIdle, '完成后迟到的 delta 应被丢弃');

  // === 测试 6:无路由映射的 delta 被跳过 ===
  const lenBefore = sent.length;
  await handler._handleEvent({ type: 'message.part.delta', properties: { sessionID: 'unknown-sess', delta: 'x' } });
  assert.strictEqual(sent.length, lenBefore, '无路由映射的 delta 应被跳过');

  // === 测试 7:session.error 发 error 终态 + 调 sendErrorCard ===
  sent.length = 0;
  const errSession = 'sess-err-1';
  handler.registerSession(errSession, {
    chatId: 'ops-user2',
    targetId: 'user2',
    senderUserId: 'user2',
    convType: 1,
    cardId: 'card-err',
    streamId: 'stream-err',
  });
  // 先发一条 delta 让 hasSentStream=true(这样 error 才会发流式终态)
  await handler._handleEvent({ type: 'message.part.delta', properties: { sessionID: errSession, delta: 'partial' } });
  const errSentBefore = sent.length;
  await handler._handleEvent({ type: 'session.error', properties: { sessionID: errSession, error: 'boom' } });
  assert.ok(sent.length > errSentBefore, 'error 应发送流式终态');
  const errorChunk = sent[sent.length - 1];
  assert.strictEqual(errorChunk.isLast, true);
  assert.strictEqual(errorChunk.streamDelta.session_status, 'error');
  assert.strictEqual(errorChunk.streamDelta.error, 'boom');
  assert.ok(errorCardCalled, 'sendErrorCard 应被调用');
  assert.strictEqual(errorCardCalled.error, 'boom');
  assert.strictEqual(errorCardCalled.cardId, 'card-err');

  // === 测试 8:reasoning/thinking 增量不混入正常内容,thinking 阶段发送 reasoning ===
  // 通过 partTypes 映射(part.updated 先注册)区分 reasoning/text part,
  // 不再依赖已失效的 properties.field 路由。
  sent.length = 0;
  finalCardCalled = null;
  const reasoningSession = 'sess-reason-1';
  handler.registerSession(reasoningSession, {
    chatId: 'ops-user3',
    targetId: 'user3',
    senderUserId: 'user3',
    convType: 1,
    cardId: 'card-reason',
    streamId: 'stream-reason',
  });
  // 0. 先通过 part.updated 注册 reasoning part 类型(填充 partTypes 映射)
  await handler._handleEvent({
    type: 'message.part.updated',
    properties: {
      sessionID: reasoningSession,
      part: { id: 'part-r1', type: 'reasoning', text: '' },
    },
  });
  // 1. reasoning 增量(指向已注册的 reasoning part),应进 reasoning_content
  await handler._handleEvent({
    type: 'message.part.delta',
    properties: { sessionID: reasoningSession, partID: 'part-r1', delta: 'Let me think step by step.\n' },
  });
  assert.strictEqual(sent.length, 1, '首条 reasoning 增量应只发 1 个 thinking 片');
  const reasoningFirst = sent[sent.length - 1];
  assert.strictEqual(reasoningFirst.streamDelta.session_status, 'thinking');
  assert.strictEqual(reasoningFirst.isFirst, true, '首条 reasoning 增量应是首流');
  assert.strictEqual(reasoningFirst.streamDelta.content, '', 'reasoning 增量不应作为 content 发送');
  assert.strictEqual(reasoningFirst.streamDelta.reasoning_content, 'Let me think step by step.\n', 'reasoning 增量应进入 reasoning_content');
  assert.ok(reasoningFirst.extra, '首流应带 extra 卡片壳');
  // 2. 注册 text part,正常内容增量应进 content
  await handler._handleEvent({
    type: 'message.part.updated',
    properties: {
      sessionID: reasoningSession,
      part: { id: 'part-t1', type: 'text', text: '' },
    },
  });
  await handler._handleEvent({
    type: 'message.part.delta',
    properties: { sessionID: reasoningSession, partID: 'part-t1', delta: 'The answer is 42.' },
  });
  assert.strictEqual(sent.length, 2, '正常内容增量应再发 1 个 responding 片');
  const reasoningSecond = sent[sent.length - 1];
  assert.strictEqual(reasoningSecond.streamDelta.session_status, 'responding');
  assert.strictEqual(reasoningSecond.streamDelta.content, 'The answer is 42.', '正常内容应作为 content 发送');
  assert.strictEqual(reasoningSecond.streamDelta.reasoning_content, undefined, 'responding 不应携带 reasoning_content');
  // session.idle 终态与最终卡片应携带 reasoningContent
  await handler._handleEvent({ type: 'session.idle', properties: { sessionID: reasoningSession } });
  const completedReasoning = sent[sent.length - 1]; // completed 尾流
  assert.strictEqual(completedReasoning.streamDelta.session_status, 'completed');
  assert.strictEqual(completedReasoning.streamDelta.reasoning_content, undefined, 'completed reasoning_content 应为空(已随流发送)');
  assert.ok(finalCardCalled, 'sendFinalCard 应被调用');
  assert.strictEqual(finalCardCalled.fullContent, 'The answer is 42.');
  assert.strictEqual(finalCardCalled.reasoningContent, 'Let me think step by step.\n');

  // === 测试 9:<thinking> 标签跨 delta 分片,reasoning 与正文分离 ===
  sent.length = 0;
  finalCardCalled = null;
  const thinkSession = 'sess-think-1';
  handler.registerSession(thinkSession, {
    chatId: 'ops-user4',
    targetId: 'user4',
    senderUserId: 'user4',
    convType: 1,
    cardId: 'card-think',
    streamId: 'stream-think',
  });
  await handler._handleEvent({ type: 'message.part.delta', properties: { sessionID: thinkSession, delta: 'pre <thi' } });
  await handler._handleEvent({ type: 'message.part.delta', properties: { sessionID: thinkSession, delta: 'nking>reasoning</th' } });
  await handler._handleEvent({ type: 'message.part.delta', properties: { sessionID: thinkSession, delta: 'inking> final' } });
  await handler._handleEvent({ type: 'session.idle', properties: { sessionID: thinkSession } });
  const completedThink = sent[sent.length - 1];
  assert.strictEqual(completedThink.streamDelta.session_status, 'completed');
  assert.strictEqual(completedThink.streamDelta.content, '', 'completed 正文应为空(最终卡片承载内容)');
  assert.strictEqual(completedThink.streamDelta.reasoning_content, undefined, 'completed reasoning_content 应为空(已随流发送)');
  assert.ok(finalCardCalled, 'sendFinalCard 应被调用');
  assert.strictEqual(finalCardCalled.fullContent, 'pre  final');
  assert.strictEqual(finalCardCalled.reasoningContent, 'reasoning');

  // === 测试 10:Kimi 2.7+ reasoning part 类型分离,reasoning 不混入正文 ===
  sent.length = 0;
  finalCardCalled = null;
  const kimiSession = 'sess-kimi-1';
  handler.registerSession(kimiSession, {
    chatId: 'ops-user5',
    targetId: 'user5',
    senderUserId: 'user5',
    convType: 1,
    cardId: 'card-kimi',
    streamId: 'stream-kimi',
  });
  // 1. part.updated 声明 reasoning part,空文本
  await handler._handleEvent({
    type: 'message.part.updated',
    properties: {
      sessionID: kimiSession,
      part: { id: 'part-reason-1', type: 'reasoning', text: '' },
    },
  });
  // 2. delta 携带 field='thinking' 指向 reasoning part
  await handler._handleEvent({
    type: 'message.part.delta',
    properties: {
      sessionID: kimiSession,
      partID: 'part-reason-1',
      field: 'thinking',
      delta: 'Let me think step by step. ',
    },
  });
  await handler._handleEvent({
    type: 'message.part.delta',
    properties: {
      sessionID: kimiSession,
      partID: 'part-reason-1',
      field: 'thinking',
      delta: '2+2=4.',
    },
  });
  // 3. part.updated 给出最终 reasoning 文本
  await handler._handleEvent({
    type: 'message.part.updated',
    properties: {
      sessionID: kimiSession,
      part: { id: 'part-reason-1', type: 'reasoning', text: 'Let me think step by step. 2+2=4.' },
    },
  });
  // 4. 正常 answer text part
  await handler._handleEvent({
    type: 'message.part.updated',
    properties: {
      sessionID: kimiSession,
      part: { id: 'part-text-1', type: 'text', text: 'The answer is 4.' },
    },
  });
  await handler._handleEvent({ type: 'session.idle', properties: { sessionID: kimiSession } });

  // 流式阶段 reasoning 增量应作为 thinking 发送，不混入 responding
  const thinkingChunks = sent.filter((s) => s.streamDelta.session_status === 'thinking');
  assert.strictEqual(thinkingChunks.length, 2, '应发送 2 个 thinking 流片');
  assert.strictEqual(thinkingChunks[0].streamDelta.content, '', 'thinking 片 content 应为空');
  assert.strictEqual(thinkingChunks[0].streamDelta.reasoning_content, 'Let me think step by step. ', 'reasoning 增量应通过 thinking 发送');
  assert.strictEqual(thinkingChunks[1].streamDelta.content, '', 'thinking 片 content 应为空');
  assert.strictEqual(thinkingChunks[1].streamDelta.reasoning_content, '2+2=4.', 'reasoning 增量应通过 thinking 发送');

  const respondingChunks = sent.filter((s) => s.streamDelta.session_status === 'responding');
  assert.strictEqual(respondingChunks.length, 0, 'reasoning 增量不应产生 responding 流片');

  const completedKimi = sent[sent.length - 1];
  assert.strictEqual(completedKimi.streamDelta.session_status, 'completed');
  assert.strictEqual(completedKimi.streamDelta.content, '', 'completed 正文应为空(最终卡片承载内容)');
  assert.strictEqual(completedKimi.streamDelta.reasoning_content, undefined, 'completed reasoning_content 应为空(已随流发送)');
  assert.ok(finalCardCalled, 'sendFinalCard 应被调用');
  assert.strictEqual(finalCardCalled.fullContent, 'The answer is 4.');
  assert.strictEqual(finalCardCalled.reasoningContent, 'Let me think step by step. 2+2=4.');

  // === 测试 11:text part 同时有 delta 和 updated 时,正文不应重复 ===
  sent.length = 0;
  finalCardCalled = null;
  const textDupSession = 'sess-text-dup-1';
  handler.registerSession(textDupSession, {
    chatId: 'ops-user6',
    targetId: 'user6',
    senderUserId: 'user6',
    convType: 1,
    cardId: 'card-text-dup',
    streamId: 'stream-text-dup',
  });
  // 先声明 text part 映射
  await handler._handleEvent({
    type: 'message.part.updated',
    properties: {
      sessionID: textDupSession,
      part: { id: 'part-text-2', type: 'text', text: '' },
    },
  });
  // 通过 deltas 累积正文
  await handler._handleEvent({
    type: 'message.part.delta',
    properties: {
      sessionID: textDupSession,
      partID: 'part-text-2',
      field: 'text',
      delta: 'Hello',
    },
  });
  await handler._handleEvent({
    type: 'message.part.delta',
    properties: {
      sessionID: textDupSession,
      partID: 'part-text-2',
      field: 'text',
      delta: ' World',
    },
  });
  // 随后到达 part.updated 快照(与 deltas 内容相同)
  await handler._handleEvent({
    type: 'message.part.updated',
    properties: {
      sessionID: textDupSession,
      part: { id: 'part-text-2', type: 'text', text: 'Hello World' },
    },
  });
  await handler._handleEvent({ type: 'session.idle', properties: { sessionID: textDupSession } });

  const completedTextDup = sent[sent.length - 1];
  assert.strictEqual(completedTextDup.streamDelta.session_status, 'completed');
  assert.strictEqual(completedTextDup.streamDelta.content, '', 'completed 正文应为空(最终卡片承载内容)');
  assert.ok(finalCardCalled, 'sendFinalCard 应被调用');
  assert.strictEqual(finalCardCalled.fullContent, 'Hello World', 'finalCard 正文不应重复');

  // === 测试 12:message.part.updated text 快照即使比 delta 累积短也权威覆盖 ===
  sent.length = 0;
  finalCardCalled = null;
  const snapshotSession = 'sess-snapshot-1';
  handler.registerSession(snapshotSession, {
    chatId: 'ops-user7',
    targetId: 'user7',
    senderUserId: 'user7',
    convType: 1,
    cardId: 'card-snapshot',
    streamId: 'stream-snapshot',
  });
  // 先声明 text part
  await handler._handleEvent({
    type: 'message.part.updated',
    properties: {
      sessionID: snapshotSession,
      part: { id: 'part-text-3', type: 'text', text: '' },
    },
  });
  // deltas 累积了较长文本
  await handler._handleEvent({
    type: 'message.part.delta',
    properties: {
      sessionID: snapshotSession,
      partID: 'part-text-3',
      field: 'text',
      delta: 'Hello World and even more text',
    },
  });
  // 最终快照更短，应覆盖 delta 累积内容
  await handler._handleEvent({
    type: 'message.part.updated',
    properties: {
      sessionID: snapshotSession,
      part: { id: 'part-text-3', type: 'text', text: 'Hello World' },
    },
  });
  await handler._handleEvent({ type: 'session.idle', properties: { sessionID: snapshotSession } });
  assert.ok(finalCardCalled, 'sendFinalCard 应被调用');
  assert.strictEqual(finalCardCalled.fullContent, 'Hello World', 'text 快照应权威覆盖 delta 累积内容');

  // === 测试 13:<dcp-system-reminder> 块从正文和 reasoning 中剥离 ===
  sent.length = 0;
  finalCardCalled = null;
  const dcpSession = 'sess-dcp-1';
  handler.registerSession(dcpSession, {
    chatId: 'ops-user8',
    targetId: 'user8',
    senderUserId: 'user8',
    convType: 1,
    cardId: 'card-dcp',
    streamId: 'stream-dcp',
  });
  // 先建立中文答案上下文，使后续英文独白被分类器识别为 reasoning
  await handler._handleEvent({
    type: 'message.part.delta',
    properties: { sessionID: dcpSession, delta: '这是一个中文回答。' },
  });
  // reasoning 字段中含大小写系统提醒块，英文独白部分走分类器进入 reasoning
  await handler._handleEvent({
    type: 'message.part.delta',
    properties: {
      sessionID: dcpSession,
      field: 'thinking',
      delta: 'I think this is the right approach. <DCP-System-Reminder>do not show</dcp-system-reminder>visible reasoning',
    },
  });
  const dcpReasoningChunk = sent[sent.length - 1];
  assert.strictEqual(dcpReasoningChunk.streamDelta.content, '', 'reasoning 增量不应作为 content 发送');
  assert.strictEqual(dcpReasoningChunk.streamDelta.reasoning_content, 'I think this is the right approach. visible reasoning', '系统提醒块应从 reasoning 中移除');

  // 正文增量中含跨行系统提醒块
  await handler._handleEvent({
    type: 'message.part.delta',
    properties: {
      sessionID: dcpSession,
      delta: 'before <dcp-system-reminder>\nsecret\n</dcp-system-reminder> after',
    },
  });
  const dcpTextChunk = sent[sent.length - 1];
  assert.strictEqual(dcpTextChunk.streamDelta.content, 'before  after', '系统提醒块应从正文移除');

  // 嵌套系统提醒块
  await handler._handleEvent({
    type: 'message.part.delta',
    properties: {
      sessionID: dcpSession,
      delta: 'x<dcp-system-reminder>outer<dcp-system-reminder>inner</dcp-system-reminder>outer</dcp-system-reminder>y',
    },
  });
  const dcpNestedChunk = sent[sent.length - 1];
  assert.strictEqual(dcpNestedChunk.streamDelta.content, 'xy', '嵌套系统提醒块应完全移除');

  // part.updated 快照也应被消毒
  await handler._handleEvent({
    type: 'message.part.updated',
    properties: {
      sessionID: dcpSession,
      part: { id: 'part-dcp-text', type: 'text', text: 'snapshot<dcp-system-reminder>hidden</dcp-system-reminder>end' },
    },
  });

  await handler._handleEvent({ type: 'session.idle', properties: { sessionID: dcpSession } });
  assert.ok(finalCardCalled, 'sendFinalCard 应被调用');
  assert.strictEqual(finalCardCalled.fullContent, 'snapshotend', '最终卡片正文不应含系统提醒块');
  assert.strictEqual(finalCardCalled.reasoningContent, 'I think this is the right approach. visible reasoning', '最终卡片 reasoning 不应含系统提醒块');

  // === 测试 14:英文内部独白先导阶段应被识别为 reasoning ===
  sent.length = 0;
  finalCardCalled = null;
  const leadingReasoningSession = 'sess-leading-1';
  handler.registerSession(leadingReasoningSession, {
    chatId: 'ops-user9',
    targetId: 'user9',
    senderUserId: 'user9',
    convType: 1,
    cardId: 'card-leading',
    streamId: 'stream-leading',
  });
  // 第一条为英文内部独白,应进入 leading reasoning phase
  await handler._handleEvent({
    type: 'message.part.delta',
    properties: { sessionID: leadingReasoningSession, delta: 'The user said hello. I should respond in Chinese. ' },
  });
  assert.strictEqual(sent.length, 1, '首条独白应只发 1 个 thinking 片');
  assert.strictEqual(sent[0].streamDelta.session_status, 'thinking');
  assert.strictEqual(sent[0].seq, 1);
  assert.strictEqual(sent[0].streamDelta.reasoning_content, 'The user said hello. I should respond in Chinese. ');
  assert.strictEqual(sent[0].streamDelta.content, '');
  // 第二条出现强答案信号,退出 leading reasoning phase,正文开始发送
  await handler._handleEvent({
    type: 'message.part.delta',
    properties: { sessionID: leadingReasoningSession, delta: '\nHere is the answer: 42.' },
  });
  assert.strictEqual(sent.length, 2, '答案 delta 应再发 1 个 responding 片');
  assert.strictEqual(sent[1].seq, 2);
  assert.strictEqual(sent[1].streamDelta.content, '\nHere is the answer: 42.', '强答案信号后应发送正文');
  assert.strictEqual(sent[1].streamDelta.session_status, 'responding');
  assert.strictEqual(sent[1].streamDelta.reasoning_content, undefined, 'responding 不应携带 reasoning_content');
  // idle 后最终卡片正文只包含答案,不含独白
  await handler._handleEvent({ type: 'session.idle', properties: { sessionID: leadingReasoningSession } });
  assert.ok(finalCardCalled, 'sendFinalCard 应被调用');
  assert.strictEqual(finalCardCalled.fullContent, '\nHere is the answer: 42.');
  assert.strictEqual(finalCardCalled.reasoningContent, 'The user said hello. I should respond in Chinese. ');

  // === 测试 15:中文答案块后的英文内部独白应被识别为 reasoning_content ===
  sent.length = 0;
  finalCardCalled = null;
  const mixedSession = 'sess-mixed-1';
  handler.registerSession(mixedSession, {
    chatId: 'ops-user10',
    targetId: 'user10',
    senderUserId: 'user10',
    convType: 1,
    cardId: 'card-mixed',
    streamId: 'stream-mixed',
  });
  // 先发送中文答案块,应作为正文
  await handler._handleEvent({
    type: 'message.part.delta',
    properties: { sessionID: mixedSession, delta: '这是一个中文答案。' },
  });
  assert.strictEqual(sent.length, 2, '中文答案首条应发 thinking + responding');
  assert.strictEqual(sent[1].streamDelta.content, '这是一个中文答案。', '中文答案应作为正文');
  assert.strictEqual(sent[1].streamDelta.reasoning_content, undefined, 'responding 不应携带 reasoning_content');
  // 再发送英文内部独白,由于已见过中文答案块,应被识别为 reasoning
  await handler._handleEvent({
    type: 'message.part.delta',
    properties: { sessionID: mixedSession, delta: ' I think this is the right answer.' },
  });
  assert.strictEqual(sent.length, 3, '英文独白应再发 1 个 thinking 片');
  const monologueChunk = sent[2];
  assert.strictEqual(monologueChunk.streamDelta.session_status, 'thinking');
  assert.strictEqual(monologueChunk.streamDelta.content, '', '英文独白不应作为正文发送');
  assert.strictEqual(monologueChunk.streamDelta.reasoning_content, ' I think this is the right answer.', '英文独白应通过 thinking 发送');
  // 最终卡片正文只含中文答案,reasoning 含英文独白
  await handler._handleEvent({ type: 'session.idle', properties: { sessionID: mixedSession } });
  assert.ok(finalCardCalled, 'sendFinalCard 应被调用');
  assert.strictEqual(finalCardCalled.fullContent, '这是一个中文答案。');
  assert.strictEqual(finalCardCalled.reasoningContent, ' I think this is the right answer.');

  // === 测试 16: partTypes 注册的 reasoning part 强制路由到 reasoning；未注册时回退到分类器 ===
  // (field routing 已废弃,改用 partTypes 映射)
  sent.length = 0;
  finalCardCalled = null;
  const explicitFieldSession = 'sess-explicit-field-1';
  handler.registerSession(explicitFieldSession, {
    chatId: 'ops-user11',
    targetId: 'user11',
    senderUserId: 'user11',
    convType: 1,
    cardId: 'card-explicit-field',
    streamId: 'stream-explicit-field',
  });
  // 1. 注册 reasoning part,中文 reasoning 文本应强制进入 reasoning_content
  await handler._handleEvent({
    type: 'message.part.updated',
    properties: {
      sessionID: explicitFieldSession,
      part: { id: 'part-er1', type: 'reasoning', text: '' },
    },
  });
  await handler._handleEvent({
    type: 'message.part.delta',
    properties: { sessionID: explicitFieldSession, partID: 'part-er1', delta: '这是中文 reasoning 内容。' },
  });
  assert.strictEqual(sent.length, 1, 'reasoning part delta 应只发 1 个 thinking 片');
  assert.strictEqual(sent[0].streamDelta.session_status, 'thinking');
  assert.strictEqual(sent[0].streamDelta.content, '');
  assert.strictEqual(sent[0].streamDelta.reasoning_content, '这是中文 reasoning 内容。');
  // 2. 注册 text part,中文正文应进入 content
  await handler._handleEvent({
    type: 'message.part.updated',
    properties: {
      sessionID: explicitFieldSession,
      part: { id: 'part-et1', type: 'text', text: '' },
    },
  });
  await handler._handleEvent({
    type: 'message.part.delta',
    properties: { sessionID: explicitFieldSession, partID: 'part-et1', delta: '这是中文正文内容。' },
  });
  assert.strictEqual(sent[sent.length - 1].streamDelta.content, '这是中文正文内容。', 'text part 的中文应作为正文');
  // 3. 无 partID/未知 part:回退到分类器。先发更多中文答案,再发英文独白应被分类器识别为 reasoning
  await handler._handleEvent({
    type: 'message.part.delta',
    properties: { sessionID: explicitFieldSession, delta: '更多中文内容。' },
  });
  await handler._handleEvent({
    type: 'message.part.delta',
    properties: { sessionID: explicitFieldSession, delta: ' I think this is correct.' },
  });
  const fallbackReasoningChunk = sent[sent.length - 1];
  assert.strictEqual(fallbackReasoningChunk.streamDelta.session_status, 'thinking');
  assert.strictEqual(fallbackReasoningChunk.streamDelta.reasoning_content, ' I think this is correct.');
  await handler._handleEvent({ type: 'session.idle', properties: { sessionID: explicitFieldSession } });
  assert.ok(finalCardCalled, 'sendFinalCard 应被调用');
  assert.strictEqual(finalCardCalled.fullContent, '这是中文正文内容。更多中文内容。');
  assert.strictEqual(finalCardCalled.reasoningContent, '这是中文 reasoning 内容。 I think this is correct.');

  // === 测试 17: 英文先导 reasoning 累积 → 出现中文答案 → 中文应进入 content 而非 reasoning ===
  // 复现 bug：leading phase 退出后 reasoningBoundary 未设置，导致 tryEnterLeadingReasoningPhase
  // 反复把后续英文 reasoning 重新吸收，content 始终为空。
  sent.length = 0;
  finalCardCalled = null;
  const transitionSession = 'sess-transition-1';
  handler.registerSession(transitionSession, {
    chatId: 'ops-user12',
    targetId: 'user12',
    senderUserId: 'user12',
    convType: 1,
    cardId: 'card-transition',
    streamId: 'stream-transition',
  });
  // 1) 英文先导 reasoning 累积到 >20 字符，触发 leading reasoning phase
  await handler._handleEvent({
    type: 'message.part.delta',
    properties: { sessionID: transitionSession, delta: 'The user said something and I should think about it.' },
  });
  // 首条发 thinking(seq=1) + responding(seq=2)，此时 content 应为空（全部进 reasoning）
  const transitionThinking = sent[0];
  assert.strictEqual(transitionThinking.streamDelta.session_status, 'thinking');
  const transitionChunk2 = sent[1];
  // leading phase 进入后 contentToSend='' → 但 seq=2 仍然发出（content 可能空）
  // 关键：后续中文答案必须进入 content
  sent.length = 0;
  // 2) 中文答案 delta：应进入 content
  await handler._handleEvent({
    type: 'message.part.delta',
    properties: { sessionID: transitionSession, delta: '少爷，请给具体工程任务。' },
  });
  const chineseChunk = sent[sent.length - 1];
  assert.strictEqual(
    chineseChunk.streamDelta.content,
    '少爷，请给具体工程任务。',
    '中文答案必须进入 content（复现 bug：leading phase 退出后 reasoningBoundary 未设置导致 content 为空）',
  );
  // 3) 后续英文 reasoning 应进入 reasoning_content，content 保持
  sent.length = 0;
  await handler._handleEvent({
    type: 'message.part.delta',
    properties: { sessionID: transitionSession, delta: ' I should keep it concise and direct.' },
  });
  const englishReasoningChunk = sent[sent.length - 1];
  assert.strictEqual(
    englishReasoningChunk.streamDelta.content,
    '',
    '英文 reasoning 不应进入 content（复现 bug：tryEnterLeadingReasoningPhase 反复吸收）',
  );
  await handler._handleEvent({ type: 'session.idle', properties: { sessionID: transitionSession } });
  assert.ok(finalCardCalled, 'sendFinalCard 应被调用');
  assert.strictEqual(finalCardCalled.fullContent, '少爷，请给具体工程任务。', '最终卡片正文应是中文答案');
  assert.ok(
    finalCardCalled.reasoningContent.includes('The user said'),
    '最终卡片 reasoning 应包含英文先导 reasoning',
  );

  // === 测试 18: 已注册的 reasoning part 的英文 reasoning 直接走 thinking，不产生 responding ===
  // (field routing 已废弃,改用 partTypes 映射)
  sent.length = 0;
  finalCardCalled = null;
  const explicitThinkingSession = 'sess-explicit-thinking-1';
  handler.registerSession(explicitThinkingSession, {
    chatId: 'ops-user13',
    targetId: 'user13',
    senderUserId: 'user13',
    convType: 1,
    cardId: 'card-explicit-thinking',
    streamId: 'stream-explicit-thinking',
  });
  // 先注册 reasoning part(填充 partTypes 映射)
  await handler._handleEvent({
    type: 'message.part.updated',
    properties: {
      sessionID: explicitThinkingSession,
      part: { id: 'part-et-r1', type: 'reasoning', text: '' },
    },
  });
  await handler._handleEvent({
    type: 'message.part.delta',
    properties: { sessionID: explicitThinkingSession, partID: 'part-et-r1', delta: 'We need to analyze this carefully. ' },
  });
  assert.strictEqual(sent.length, 1, 'reasoning part delta 应只产生 1 个 thinking 流片');
  assert.strictEqual(sent[0].streamDelta.session_status, 'thinking');
  assert.strictEqual(sent[0].streamDelta.content, '', 'thinking 片 content 应为空');
  assert.strictEqual(
    sent[0].streamDelta.reasoning_content,
    'We need to analyze this carefully. ',
    'reasoning part 的英文内容应进入 reasoning_content',
  );
  await handler._handleEvent({ type: 'session.idle', properties: { sessionID: explicitThinkingSession } });
  assert.ok(finalCardCalled, 'sendFinalCard 应被调用');
  assert.strictEqual(finalCardCalled.fullContent, '', '最终卡片正文应为空');
  assert.strictEqual(
    finalCardCalled.reasoningContent,
    'We need to analyze this carefully. ',
    '最终卡片 reasoning 应含显式 thinking 内容',
  );

  // === 测试 19: 显式 field='responding' 的中文文本直接走 responding，不进入 reasoning ===
  sent.length = 0;
  finalCardCalled = null;
  const explicitRespondingSession = 'sess-explicit-responding-1';
  handler.registerSession(explicitRespondingSession, {
    chatId: 'ops-user14',
    targetId: 'user14',
    senderUserId: 'user14',
    convType: 1,
    cardId: 'card-explicit-responding',
    streamId: 'stream-explicit-responding',
  });
  await handler._handleEvent({
    type: 'message.part.delta',
    properties: { sessionID: explicitRespondingSession, field: 'responding', delta: '这是一个中文答案块。' },
  });
  assert.strictEqual(sent.length, 2, '首条 responding delta 应先发 thinking 再发 responding');
  assert.strictEqual(sent[0].streamDelta.session_status, 'thinking');
  assert.strictEqual(sent[0].streamDelta.content, '');
  assert.strictEqual(sent[1].streamDelta.session_status, 'responding');
  assert.strictEqual(sent[1].streamDelta.content, '这是一个中文答案块。', '显式 responding 字段的中文应作为 content');
  assert.strictEqual(sent[1].streamDelta.reasoning_content, undefined, 'responding 片不应携带 reasoning_content');
  await handler._handleEvent({ type: 'session.idle', properties: { sessionID: explicitRespondingSession } });
  assert.ok(finalCardCalled, 'sendFinalCard 应被调用');
  assert.strictEqual(finalCardCalled.fullContent, '这是一个中文答案块。');
  assert.strictEqual(finalCardCalled.reasoningContent, '');

  // === 测试 20: 完整的 <thinking> 标签应在单条 delta 内被剥离出正文 ===
  sent.length = 0;
  finalCardCalled = null;
  const thinkingCompleteSession = 'sess-thinking-complete-1';
  handler.registerSession(thinkingCompleteSession, {
    chatId: 'ops-user14',
    targetId: 'user14',
    senderUserId: 'user14',
    convType: 1,
    cardId: 'card-thinking-complete',
    streamId: 'stream-thinking-complete',
  });
  await handler._handleEvent({
    type: 'message.part.delta',
    properties: {
      sessionID: thinkingCompleteSession,
      delta: '<thinking>English reasoning</thinking>这是一个中文答案。',
    },
  });
  const thinkingCompleteSent = sent.filter((s) => s.streamDelta.session_status === 'thinking');
  assert.strictEqual(thinkingCompleteSent.length, 1, 'thinking 内容应作为 thinking 发送');
  assert.strictEqual(
    thinkingCompleteSent[0].streamDelta.reasoning_content,
    'English reasoning',
    'thinking 标签内内容应进入 reasoning',
  );
  const respondingCompleteSent = sent.filter((s) => s.streamDelta.session_status === 'responding');
  assert.strictEqual(respondingCompleteSent.length, 1, '标签外中文应作为 responding 发送');
  assert.strictEqual(
    respondingCompleteSent[0].streamDelta.content,
    '这是一个中文答案。',
    'thinking 标签外内容应作为正文',
  );
  await handler._handleEvent({ type: 'session.idle', properties: { sessionID: thinkingCompleteSession } });
  assert.ok(finalCardCalled, 'sendFinalCard 应被调用');
  assert.strictEqual(finalCardCalled.fullContent, '这是一个中文答案。', '最终卡片正文不应含 thinking 标签内内容');
  assert.strictEqual(finalCardCalled.reasoningContent, 'English reasoning', '最终卡片 reasoning 应含 thinking 标签内内容');

  // === 测试 21: 启发式未触发时，fallback 应剔除正文开头的 reasoning 前缀 ===
  sent.length = 0;
  finalCardCalled = null;
  const fallbackSession = 'sess-fallback-1';
  handler.registerSession(fallbackSession, {
    chatId: 'ops-user15',
    targetId: 'user15',
    senderUserId: 'user15',
    convType: 1,
    cardId: 'card-fallback',
    streamId: 'stream-fallback',
  });
  // 1) 通过 <thinking> 标签把 English reasoning 放入 reasoningContent
  await handler._handleEvent({
    type: 'message.part.delta',
    properties: {
      sessionID: fallbackSession,
      delta: '<thinking>English reasoning</thinking>',
    },
  });
  // 2) 同一段 English reasoning 又以纯文本形式出现在中文答案前，
  //    且中文块不足 5 字，启发式无法触发，应由 fallback 兜底剔除
  await handler._handleEvent({
    type: 'message.part.delta',
    properties: {
      sessionID: fallbackSession,
      delta: 'English reasoning 中文。',
    },
  });
  await handler._handleEvent({ type: 'session.idle', properties: { sessionID: fallbackSession } });
  assert.ok(finalCardCalled, 'sendFinalCard 应被调用');
  assert.strictEqual(finalCardCalled.fullContent, ' 中文。', '最终卡片正文应剔除 reasoning 前缀');
  assert.strictEqual(finalCardCalled.reasoningContent, 'English reasoning', '最终卡片 reasoning 应保留');

  // === 测试 22: user message 的 part 事件被过滤,不污染 AI 回复的正文(回声 bug) ===
  // 复现 bug：OpenCode 全局 SSE 会广播 user message 的 part.updated(part.type:text,
  // text:"你好"),若不区分 user/assistant,用户的问题会作为回复开头显示。
  sent.length = 0;
  finalCardCalled = null;
  const echoSession = 'sess-echo-1';
  handler.registerSession(echoSession, {
    chatId: 'ops-user16',
    targetId: 'user16',
    senderUserId: 'user16',
    convType: 1,
    cardId: 'card-echo',
    streamId: 'stream-echo',
  });
  // 1. message.updated 声明一条 user message(role:'user'),EventHandler 应记录其 messageID
  await handler._handleEvent({
    type: 'message.updated',
    properties: {
      info: { id: 'msg-user-1', sessionID: echoSession, role: 'user' },
    },
  });
  // 2. user message 的 text part.updated(text:"你好")应被跳过,不写 fullContent
  await handler._handleEvent({
    type: 'message.part.updated',
    properties: {
      sessionID: echoSession,
      messageID: 'msg-user-1',
      part: { id: 'part-user-text', messageID: 'msg-user-1', type: 'text', text: '你好' },
    },
  });
  // 3. user message 的 text part.delta 也应被跳过
  await handler._handleEvent({
    type: 'message.part.delta',
    properties: {
      sessionID: echoSession,
      messageID: 'msg-user-1',
      partID: 'part-user-text',
      delta: '你好',
    },
  });
  assert.strictEqual(sent.length, 0, 'user message 的 part 事件不应产生任何流片');
  // 4. assistant message 的 text part.delta 应正常进入 fullContent
  //    (用 5 字以上中文连续块开头的回答,避免启发式把开头前缀误判为非答案)
  await handler._handleEvent({
    type: 'message.part.delta',
    properties: {
      sessionID: echoSession,
      messageID: 'msg-assistant-1',
      partID: 'part-assistant-text',
      delta: '这是助手的正式回答内容。',
    },
  });
  assert.ok(sent.length >= 1, 'assistant message 的 delta 应正常发送');
  const assistantChunk = sent.filter((s) => s.streamDelta.session_status === 'responding');
  assert.strictEqual(assistantChunk.length, 1, '应有 1 个 responding 流片');
  assert.strictEqual(
    assistantChunk[0].streamDelta.content,
    '这是助手的正式回答内容。',
    'assistant 正文应是回答,不含用户问题',
  );
  await handler._handleEvent({ type: 'session.idle', properties: { sessionID: echoSession } });
  assert.ok(finalCardCalled, 'sendFinalCard 应被调用');
  assert.strictEqual(finalCardCalled.fullContent, '这是助手的正式回答内容。', '最终卡片正文不应回声用户问题');

  console.log('✓ EventHandler smoke tests passed');
}

run().catch((err) => {
  console.error('✗ EventHandler smoke tests failed:', err);
  process.exit(1);
});
