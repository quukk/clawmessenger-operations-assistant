const { startOpencodeService } = require('../../service/modules/opencode-starter');
const net = require('net');
const { exec, spawn } = require('child_process');

jest.mock('child_process', () => ({
  exec: jest.fn(),
  spawn: jest.fn()
}));

describe('Opencode Starter Module', () => {
  let mockLog;

  beforeEach(() => {
    jest.resetAllMocks();
    jest.useFakeTimers();
    mockLog = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    };
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('returns without error when service already running', async () => {
    net.Socket = jest.fn().mockImplementation(() => ({
      setTimeout: jest.fn(),
      once: jest.fn((event, handler) => {
        if (event === 'connect') {
          setTimeout(() => handler(), 0);
        }
      }),
      destroy: jest.fn(),
      connect: jest.fn()
    }));

    const promise = startOpencodeService(mockLog);
    await jest.advanceTimersByTimeAsync(100);
    await promise;

    expect(mockLog.info).toHaveBeenCalledWith('[OPENCODE] 服务已在运行 (port 4096)');
  });

  test('handles installation failure gracefully', async () => {
    net.Socket = jest.fn().mockImplementation(() => ({
      setTimeout: jest.fn(),
      once: jest.fn((event, handler) => {
        if (event === 'error') {
          setTimeout(() => handler(new Error('Connection refused')), 0);
        }
      }),
      destroy: jest.fn(),
      connect: jest.fn()
    }));

    exec.mockImplementation((cmd, options, callback) => {
      callback(new Error('not found'));
    });

    spawn.mockImplementation(() => ({
      on: jest.fn((event, callback) => {
        if (event === 'close') {
          callback(1);
        }
      })
    }));

    const promise = startOpencodeService(mockLog);
    await jest.advanceTimersByTimeAsync(100);
    await promise;

    expect(mockLog.error).toHaveBeenCalledWith('[OPENCODE] 自动安装失败');
  });

  test('installs and starts opencode when not installed', async () => {
    let socketCount = 0;
    
    net.Socket = jest.fn().mockImplementation(() => {
      socketCount++;
      const currentSocket = socketCount;
      
      return {
        setTimeout: jest.fn(),
        once: jest.fn((event, handler) => {
          // Trigger handler immediately
          if (currentSocket <= 2 && event === 'error') {
            handler(new Error('Connection refused'));
          } else if (currentSocket === 3 && event === 'connect') {
            handler();
          }
        }),
        destroy: jest.fn(),
        connect: jest.fn()
      };
    });

    exec.mockImplementation((cmd, options, callback) => {
      callback(new Error('not found'));
    });

    spawn.mockImplementation((cmd, args, options) => {
      if (cmd === 'npm') {
        return {
          on: jest.fn((event, callback) => {
            if (event === 'close') {
              callback(0);
            }
          })
        };
      }
      return { on: jest.fn() };
    });

    const promise = startOpencodeService(mockLog);
    
    // Run all timers
    jest.runAllTimers();
    
    await promise;

    expect(mockLog.info).toHaveBeenCalledWith('[OPENCODE] 服务启动成功');
  }, 15000);
});
