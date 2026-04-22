const { executeCommand } = require('../../service/modules/script-executor');
const { spawn } = require('child_process');

jest.mock('child_process');

describe('Script Executor Module', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('returns stdout string on success', async () => {
    const mockStdout = { on: jest.fn() };
    const mockStderr = { on: jest.fn() };
    const mockChild = {
      stdout: mockStdout,
      stderr: mockStderr,
      on: jest.fn(),
      pid: 1234
    };
    
    spawn.mockReturnValue(mockChild);
    
    const promise = executeCommand(1);
    
    // Simulate stdout data
    const stdoutHandler = mockStdout.on.mock.calls.find(call => call[0] === 'data')[1];
    stdoutHandler(Buffer.from('Service started successfully'));
    
    // Simulate close with code 0
    const closeHandler = mockChild.on.mock.calls.find(call => call[0] === 'close')[1];
    closeHandler(0);
    
    const result = await promise;
    expect(result).toBe('Service started successfully');
  });

  test('returns default success message when stdout is empty', async () => {
    const mockStdout = { on: jest.fn() };
    const mockStderr = { on: jest.fn() };
    const mockChild = {
      stdout: mockStdout,
      stderr: mockStderr,
      on: jest.fn(),
      pid: 1234
    };
    
    spawn.mockReturnValue(mockChild);
    
    const promise = executeCommand(2);
    
    const closeHandler = mockChild.on.mock.calls.find(call => call[0] === 'close')[1];
    closeHandler(0);
    
    const result = await promise;
    expect(result).toBe('执行成功');
  });

  test('throws error for unknown command', async () => {
    await expect(executeCommand(99)).rejects.toThrow('未知命令: 99');
  });

  test('throws error when script exits with non-zero code', async () => {
    const mockStdout = { on: jest.fn() };
    const mockStderr = { on: jest.fn() };
    const mockChild = {
      stdout: mockStdout,
      stderr: mockStderr,
      on: jest.fn(),
      pid: 1234
    };
    
    spawn.mockReturnValue(mockChild);
    
    const promise = executeCommand(1);
    
    const stderrHandler = mockStderr.on.mock.calls.find(call => call[0] === 'data')[1];
    stderrHandler(Buffer.from('Failed to start service'));
    
    const closeHandler = mockChild.on.mock.calls.find(call => call[0] === 'close')[1];
    closeHandler(1);
    
    await expect(promise).rejects.toThrow('执行失败 (code=1): Failed to start service');
  });

  test('throws error on process error', async () => {
    const mockStdout = { on: jest.fn() };
    const mockStderr = { on: jest.fn() };
    const mockChild = {
      stdout: mockStdout,
      stderr: mockStderr,
      on: jest.fn(),
      pid: 1234
    };
    
    spawn.mockReturnValue(mockChild);
    
    const promise = executeCommand(1);
    
    const errorHandler = mockChild.on.mock.calls.find(call => call[0] === 'error')[1];
    errorHandler(new Error('ENOENT'));
    
    await expect(promise).rejects.toThrow('进程错误: ENOENT');
  });

  test('handles timeout and kills process', async () => {
    const mockStdout = { on: jest.fn() };
    const mockStderr = { on: jest.fn() };
    const mockChild = {
      stdout: mockStdout,
      stderr: mockStderr,
      on: jest.fn(),
      pid: 1234,
      kill: jest.fn()
    };
    
    spawn.mockReturnValue(mockChild);
    
    const promise = executeCommand(1, [], 1);
    
    // Fast-forward past timeout
    jest.advanceTimersByTime(1100);
    
    await expect(promise).rejects.toThrow('执行超时（超过 1 秒）');
  });

  test('uses correct script for command 1 (start)', () => {
    const mockStdout = { on: jest.fn() };
    const mockStderr = { on: jest.fn() };
    const mockChild = {
      stdout: mockStdout,
      stderr: mockStderr,
      on: jest.fn(),
      pid: 1234
    };
    
    spawn.mockReturnValue(mockChild);
    
    executeCommand(1);
    
    const spawnCall = spawn.mock.calls[0];
    const scriptPath = spawnCall[1][1]; // Second arg in cmdArgs
    expect(scriptPath).toContain('start-opencode');
  });

  test('uses correct script for command 2 (stop)', () => {
    const mockStdout = { on: jest.fn() };
    const mockStderr = { on: jest.fn() };
    const mockChild = {
      stdout: mockStdout,
      stderr: mockStderr,
      on: jest.fn(),
      pid: 1234
    };
    
    spawn.mockReturnValue(mockChild);
    
    executeCommand(2);
    
    const spawnCall = spawn.mock.calls[0];
    const scriptPath = spawnCall[1][1];
    expect(scriptPath).toContain('stop-opencode');
  });

  test('uses correct script for command 3 (restart)', () => {
    const mockStdout = { on: jest.fn() };
    const mockStderr = { on: jest.fn() };
    const mockChild = {
      stdout: mockStdout,
      stderr: mockStderr,
      on: jest.fn(),
      pid: 1234
    };
    
    spawn.mockReturnValue(mockChild);
    
    executeCommand(3);
    
    const spawnCall = spawn.mock.calls[0];
    const scriptPath = spawnCall[1][1];
    expect(scriptPath).toContain('restart-opencode');
  });

  test('passes additional args to script', () => {
    const mockStdout = { on: jest.fn() };
    const mockStderr = { on: jest.fn() };
    const mockChild = {
      stdout: mockStdout,
      stderr: mockStderr,
      on: jest.fn(),
      pid: 1234
    };
    
    spawn.mockReturnValue(mockChild);
    
    executeCommand(1, ['--verbose', '--debug']);
    
    const spawnCall = spawn.mock.calls[0];
    const cmdArgs = spawnCall[1];
    expect(cmdArgs).toContain('--verbose');
    expect(cmdArgs).toContain('--debug');
  });
});
