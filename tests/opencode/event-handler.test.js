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
  assert.strictEqual(completed.streamDelta.content, 'Hello World', 'completed content 应是完整累积内容');

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

  console.log('✓ EventHandler smoke tests passed');
}

run().catch((err) => {
  console.error('✗ EventHandler smoke tests failed:', err);
  process.exit(1);
});
