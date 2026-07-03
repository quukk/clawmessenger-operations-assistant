/**
 * OpencodeRunner 单元测试(SSE 异步真实流式版)
 *
 * 旧版测试的是 spawn CLI + sendMessage 返回 Promise<string>;
 * 新版 sendMessage 改为 fire-and-forget,真实回复由 SSE 驱动。
 *
 * 本测试用 mock OpencodeClient + mock EventHandler 验证:
 *   1. sendMessage 复用/创建 session
 *   2. sendMessage 触发 opencode.promptAsync
 *   3. sendMessage 注册 SSE 路由映射(registerSession)
 *   4. session 持久化(sessions.json)
 *   5. clearSession 清理
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

/** mock OpencodeClient:记录调用,不真实连 SDK */
function createMockOpencodeClient() {
  const calls = { createSession: [], promptAsync: [] };
  let sessionCounter = 0;
  return {
    calls,
    async createSession() {
      sessionCounter += 1;
      const id = `mock-sess-${sessionCounter}`;
      calls.createSession.push(id);
      return { id };
    },
    async promptAsync(sessionId, text) {
      calls.promptAsync.push({ sessionId, text });
    },
    async subscribeGlobalEvents() {
      return { stream: (async function* noop() {})() };
    },
  };
}

/** mock EventHandler:记录 registerSession 调用 */
function createMockEventHandler() {
  const registrations = [];
  return {
    isRunning: true,
    streamStates: new Map(),
    registrations,
    registerSession(sessionId, ctx) {
      registrations.push({ sessionId, ctx });
    },
    async start() {},
    stop() {},
  };
}

async function run() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-runner-test-'));
  const opencodeDir = path.join(tmpDir, 'opencode-dir');
  const promptDir = path.join(opencodeDir, '.opencode');
  fs.mkdirSync(promptDir, { recursive: true });
  fs.writeFileSync(path.join(promptDir, 'prompt.md'), 'You are a test assistant.');

  const sessionFile = path.join(tmpDir, 'sessions.json');

  const mockLog = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };

  const { OpencodeRunner } = require('../../service/opencode/opencode-runner');

  const runner = new OpencodeRunner({
    directory: opencodeDir,
    opencodeUrl: 'http://127.0.0.1:4096',
    sessionFile,
    log: mockLog,
  });

  // 注入 mock(跳过 initSse 的真实 SDK 加载)
  runner.opencode = createMockOpencodeClient();
  runner.eventHandler = createMockEventHandler();
  runner._sseStarted = true;

  const routeCtx = {
    targetId: 'user-1',
    senderUserId: 'user-1',
    convType: 1,
    cardId: 'card-1',
    streamId: 'stream-1',
  };

  // 1. 首次调用:应创建 session + 触发 promptAsync + 注册路由
  await runner.sendMessage('chat-1', 'hello', { routeCtx });

  assert.strictEqual(runner.opencode.calls.createSession.length, 1, '应创建 1 个 session');
  assert.strictEqual(runner.opencode.calls.promptAsync.length, 1, '应触发 1 次 promptAsync');
  assert.strictEqual(runner.opencode.calls.promptAsync[0].text, 'hello');
  assert.strictEqual(runner.eventHandler.registrations.length, 1, '应注册 1 次路由');
  assert.strictEqual(runner.eventHandler.registrations[0].ctx.cardId, 'card-1');

  const createdSessionId = runner.opencode.calls.createSession[0];

  // 2. session 持久化
  assert.ok(fs.existsSync(sessionFile), 'session 文件应被创建');
  const sessionData = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  assert.strictEqual(sessionData.sessions['chat-1'].id, createdSessionId, 'session 应被保存');

  // 3. 第二次调用同一 chatId:应复用 session(不再 createSession)
  await runner.sendMessage('chat-1', 'hi again', { routeCtx });
  assert.strictEqual(runner.opencode.calls.createSession.length, 1, '复用 session,不应再次 createSession');
  assert.strictEqual(runner.opencode.calls.promptAsync.length, 2, '应再次触发 promptAsync');
  assert.strictEqual(runner.opencode.calls.promptAsync[1].sessionId, createdSessionId, '复用同一 sessionId');

  // 4. clearSession
  runner.clearSession('chat-1');
  assert.ok(!runner.sessions.has('chat-1'), 'clearSession 应删除内存映射');
  const sessionData2 = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  assert.ok(!sessionData2.sessions['chat-1'], 'clearSession 应删除持久化');

  // 5. sendMessage 缺少 routeCtx 应抛错
  await assert.rejects(
    () => runner.sendMessage('chat-2', 'x'),
    /routeCtx/,
    '缺少 routeCtx 应抛错',
  );

  // 清理
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log('✓ OpencodeRunner tests passed (SSE async mode)');
}

run().catch((err) => {
  console.error('✗ OpencodeRunner tests failed:', err);
  process.exit(1);
});
