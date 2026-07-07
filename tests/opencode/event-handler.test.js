/**
 * EventHandler 冒烟测试(纯 Node.js assert,mock opencode SSE 流)
 *
 * 验证:
 *   1. registerSession 注册映射后,message.part.delta 正确调用 sendStreamChunk
 *      首次 delta 先发 thinking(seq=0,extra),再发 responding(seq=1,增量)
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
  assert.strictEqual(thinkingChunk.seq, 0, 'thinking seq=0');
  assert.strictEqual(thinkingChunk.streamDelta.session_status, 'thinking');
  assert.ok(thinkingChunk.extra, '首流应带 extra 卡片壳');
  assert.strictEqual(thinkingChunk.extra.card_id, 'card-1', 'extra.card_id 应与 cardId 一致');

  const respondingChunk = sent[1];
  assert.strictEqual(respondingChunk.isFirst, false);
  assert.strictEqual(respondingChunk.seq, 1, 'responding seq=1');
  assert.strictEqual(respondingChunk.streamDelta.session_status, 'responding');
  assert.strictEqual(respondingChunk.streamDelta.content, 'Hello', '增量内容应为 Hello');

  // === 测试 2:第二条 delta 只发 responding(seq=2),不重复 thinking ===
  await handler._handleEvent({ type: 'message.part.delta', properties: { sessionID: sessionId, delta: ' World' } });
  assert.strictEqual(sent.length, 3, '第二条 delta 应只发 1 片');
  const secondDelta = sent[2];
  assert.strictEqual(secondDelta.seq, 2);
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

  // === 测试 8:reasoning/thinking 增量不混入正常内容,但随流传递 ===
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
  // 第一条为 reasoning 增量
  await handler._handleEvent({ type: 'message.part.delta', properties: { sessionID: reasoningSession, field: 'thinking', delta: 'Thinking...' } });
  const reasoningFirst = sent[sent.length - 1];
  assert.strictEqual(reasoningFirst.streamDelta.session_status, 'responding');
  assert.strictEqual(reasoningFirst.streamDelta.content, '', 'reasoning 增量不应作为 content 发送');
  assert.strictEqual(reasoningFirst.streamDelta.reasoning_content, 'Thinking...', 'reasoning 增量应进入 reasoning_content');
  assert.strictEqual(reasoningFirst.extra, undefined, 'reasoning 后续流不应带 extra');
  // 第二条为正常内容增量
  await handler._handleEvent({ type: 'message.part.delta', properties: { sessionID: reasoningSession, delta: 'Answer' } });
  const reasoningSecond = sent[sent.length - 1];
  assert.strictEqual(reasoningSecond.streamDelta.content, 'Answer', '正常内容应作为 content 发送');
  assert.strictEqual(reasoningSecond.streamDelta.reasoning_content, 'Thinking...', 'reasoning 内容应保留并传递');
  // session.idle 终态与最终卡片应携带 reasoningContent
  await handler._handleEvent({ type: 'session.idle', properties: { sessionID: reasoningSession } });
  const completedReasoning = sent[sent.length - 1]; // completed 尾流
  assert.strictEqual(completedReasoning.streamDelta.session_status, 'completed');
  assert.strictEqual(completedReasoning.streamDelta.reasoning_content, undefined, 'completed reasoning_content 应为空(已随流发送)');
  assert.ok(finalCardCalled, 'sendFinalCard 应被调用');
  assert.strictEqual(finalCardCalled.fullContent, 'Answer');
  assert.strictEqual(finalCardCalled.reasoningContent, 'Thinking...');

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
  // 2. delta 携带 field='text' 但 partID 指向 reasoning part
  await handler._handleEvent({
    type: 'message.part.delta',
    properties: {
      sessionID: kimiSession,
      partID: 'part-reason-1',
      field: 'text',
      delta: 'Let me think step by step. ',
    },
  });
  await handler._handleEvent({
    type: 'message.part.delta',
    properties: {
      sessionID: kimiSession,
      partID: 'part-reason-1',
      field: 'text',
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

  // 流式阶段 reasoning 增量不应作为 content 发送
  const respondingChunks = sent.filter((s) => s.streamDelta.session_status === 'responding');
  assert.strictEqual(respondingChunks.length, 2, '应发送 2 个 responding 流片');
  assert.strictEqual(respondingChunks[0].streamDelta.content, '', 'reasoning 增量不应作为 content 发送');
  assert.strictEqual(respondingChunks[0].streamDelta.reasoning_content, 'Let me think step by step. ', 'reasoning 应随流累积');
  assert.strictEqual(respondingChunks[1].streamDelta.content, '', 'reasoning 增量不应作为 content 发送');
  assert.strictEqual(respondingChunks[1].streamDelta.reasoning_content, 'Let me think step by step. 2+2=4.', 'reasoning 应完整累积');

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
  // reasoning 字段中含大小写系统提醒块
  await handler._handleEvent({
    type: 'message.part.delta',
    properties: {
      sessionID: dcpSession,
      field: 'thinking',
      delta: '<DCP-System-Reminder>do not show</dcp-system-reminder>visible reasoning',
    },
  });
  const dcpReasoningChunk = sent[sent.length - 1];
  assert.strictEqual(dcpReasoningChunk.streamDelta.content, '', 'reasoning 增量不应作为 content 发送');
  assert.strictEqual(dcpReasoningChunk.streamDelta.reasoning_content, 'visible reasoning', '系统提醒块应从 reasoning 中移除');

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
  assert.strictEqual(finalCardCalled.reasoningContent, 'visible reasoning', '最终卡片 reasoning 不应含系统提醒块');

  console.log('✓ EventHandler smoke tests passed');
}

run().catch((err) => {
  console.error('✗ EventHandler smoke tests failed:', err);
  process.exit(1);
});
