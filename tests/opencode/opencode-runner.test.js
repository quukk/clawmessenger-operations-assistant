/**
 * OpencodeRunner 单元测试（纯 Node.js assert，mock child_process）
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// 保存原始 spawn
const originalSpawn = require('child_process').spawn;

// 创建一个简单的 EventEmitter 替代
function createMockChild() {
  const { EventEmitter } = require('events');
  const child = new EventEmitter();
  child.stdin = {
    written: [],
    write(data) { this.written.push(data); },
    end() { this.ended = true; },
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = (signal) => {
    child.killedSignal = signal;
    setImmediate(() => child.emit('close', 0));
  };
  return child;
}

async function run() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-runner-test-'));
  const opencodeDir = path.join(tmpDir, 'opencode-dir');
  const promptDir = path.join(opencodeDir, '.opencode');
  fs.mkdirSync(promptDir, { recursive: true });
  fs.writeFileSync(path.join(promptDir, 'prompt.md'), 'You are a test assistant.');

  const sessionFile = path.join(tmpDir, 'sessions.json');

  // mock spawn
  let spawnedArgs = null;
  let spawnedEnv = null;
  const mockChild = createMockChild();

  const childProcess = require('child_process');
  childProcess.spawn = (cmd, args, opts) => {
    spawnedArgs = args;
    spawnedEnv = opts.env;

    // 模拟异步输出
    setTimeout(() => {
      mockChild.stdout.emit('data', JSON.stringify({ type: 'text', part: { text: 'Hello ' } }) + '\n');
      mockChild.stdout.emit('data', JSON.stringify({ type: 'text', part: { text: 'world' } }) + '\n');
      mockChild.stdout.emit('data', JSON.stringify({ sessionID: 'sess-123' }) + '\n');
      mockChild.emit('close', 0);
    }, 10);

    return mockChild;
  };

  const { OpencodeRunner } = require('../../service/opencode/opencode-runner');

  const logs = [];
  const mockLog = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: (msg) => logs.push(msg),
  };

  const runner = new OpencodeRunner({
    directory: opencodeDir,
    opencodeUrl: 'http://127.0.0.1:19877',
    timeout: 10000,
    sessionFile,
    log: mockLog,
  });

  // 1. 测试首次调用会生成正确参数
  const result = await runner.sendMessage('chat-1', 'hi');
  assert.strictEqual(result, 'Hello world', '应返回拼接后的完整回复');
  assert.ok(spawnedArgs.includes('run'), '应调用 opencode run');
  assert.ok(spawnedArgs.includes('--dir'), '应包含 --dir 参数');
  assert.ok(spawnedArgs.includes('--format'), '应包含 --format 参数');
  assert.ok(spawnedArgs.includes('json'), '应使用 json 格式');

  // 2. 测试 session 持久化
  assert.ok(fs.existsSync(sessionFile), 'session 文件应被创建');
  const sessionData = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  assert.strictEqual(sessionData.sessions['chat-1'].id, 'sess-123', 'session 应被保存');

  // 3. 测试第二次调用带 --continue
  const mockChild2 = createMockChild();
  childProcess.spawn = (cmd, args) => {
    spawnedArgs = args;
    setTimeout(() => {
      mockChild2.stdout.emit('data', JSON.stringify({ type: 'text', part: { text: 'continued' } }) + '\n');
      mockChild2.emit('close', 0);
    }, 10);
    return mockChild2;
  };

  await runner.sendMessage('chat-1', 'hi again');
  assert.ok(spawnedArgs.includes('--continue'), '第二次调用应包含 --continue');
  assert.ok(spawnedArgs.includes('sess-123'), '第二次调用应使用已保存的 session ID');

  // 恢复 spawn
  childProcess.spawn = originalSpawn;

  // 清理
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log('✓ OpencodeRunner tests passed');
}

run().catch((err) => {
  // 确保恢复 spawn
  require('child_process').spawn = originalSpawn;
  console.error('✗ OpencodeRunner tests failed:', err);
  process.exit(1);
});
