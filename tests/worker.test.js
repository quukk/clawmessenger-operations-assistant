const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// Create a shared mock logger
const mockLogger = {
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn()
};

// Mock all dependencies before requiring the worker module
jest.mock('../service/logger', () => ({
  createLogger: jest.fn(() => mockLogger)
}));

jest.mock('../service/modules/config', () => ({
  loadConfig: jest.fn()
}));

jest.mock('../service/modules/opencode-starter', () => ({
  startOpencodeService: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('../service/modules/mac-address', () => ({
  getMacAddress: jest.fn(() => 'aabbccddeeff')
}));

jest.mock('../service/modules/port-checker', () => ({
  getOpenClawStatus: jest.fn().mockResolvedValue(1)
}));

jest.mock('../service/modules/dashboard-collector', () => ({
  collectDashboardData: jest.fn().mockResolvedValue({
    sessions: [],
    cronJobs: [],
    projects: [],
    tasksSummary: {},
    budgetSummary: {},
    diagnostics: {},
    sessionsContexts: [],
    usageEvents: []
  })
}));

jest.mock('../service/rongcloud/message-types', () => ({
  CLIENT_CONNECTED: 'client_connected',
  HEARTBEAT: 'heartbeat',
  DASHBOARD_SESSIONS: 'dashboard_sessions',
  DASHBOARD_JOBS: 'dashboard_jobs',
  DASHBOARD_PROJECTS: 'dashboard_projects',
  DASHBOARD_SUMMARIES: 'dashboard_summaries',
  DASHBOARD_SESSIONS_CONTEXTS: 'dashboard_sessions_contexts',
  DASHBOARD_USAGE_EVENTS: 'dashboard_usage_events'
}));

// Mock RongCloudClient and MessageHandler
jest.mock('../service/rongcloud/rongcloud-client', () => ({
  RongCloudClient: jest.fn()
}));

jest.mock('../service/rongcloud/message-handler', () => ({
  MessageHandler: jest.fn()
}));

const { Worker } = require('../service/worker');
const { loadConfig } = require('../service/modules/config');
const { startOpencodeService } = require('../service/modules/opencode-starter');
const { getMacAddress } = require('../service/modules/mac-address');
const { RongCloudClient } = require('../service/rongcloud/rongcloud-client');
const { MessageHandler } = require('../service/rongcloud/message-handler');

describe('Worker', () => {
  let worker;
  let mockRongCloudClient;
  let mockMessageHandler;
  let mockConfig;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    mockConfig = {
      appKey: 'test_app_key',
      token: 'test_token',
      accountId: 'test_account',
      nodeName: 'test_node',
      openclawPort: 18789,
      secretKey: 'test_secret'
    };

    mockRongCloudClient = {
      isConnected: true,
      connect: jest.fn().mockResolvedValue(true),
      disconnect: jest.fn().mockResolvedValue(undefined),
      sendMessage: jest.fn().mockResolvedValue(true),
      sendStructuredMessage: jest.fn().mockResolvedValue(true)
    };

    mockMessageHandler = {
      handleMessage: jest.fn(),
      handleStructuredMessage: jest.fn()
    };

    // Setup mocks
    loadConfig.mockReturnValue(mockConfig);
    RongCloudClient.mockImplementation(() => mockRongCloudClient);
    MessageHandler.mockImplementation(() => mockMessageHandler);

    // Create a new worker instance
    worker = new Worker();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('constructor', () => {
    test('should initialize with default values', () => {
      expect(worker.config).toBeNull();
      expect(worker.rongcloudClient).toBeNull();
      expect(worker.messageHandler).toBeNull();
      expect(worker.server).toBeNull();
      expect(worker.heartbeatInterval).toBeNull();
      expect(worker.dashboardInterval).toBeNull();
      expect(worker.isShuttingDown).toBe(false);
    });
  });

  describe('waitForImUserId', () => {
    test('should return nodeId when config exists', async () => {
      const clawBridgePath = path.join(os.homedir(), '.claw-bridge', 'config.json');
      const existsSyncSpy = jest.spyOn(fs, 'existsSync').mockImplementation((p) => {
        return p === clawBridgePath;
      });
      const readFileSyncSpy = jest.spyOn(fs, 'readFileSync').mockImplementation(() => {
        return JSON.stringify({ nodeId: 'user123' });
      });

      const result = await worker.waitForImUserId();
      expect(result).toBe('user123');

      existsSyncSpy.mockRestore();
      readFileSyncSpy.mockRestore();
    });

    test('should retry when config does not exist', async () => {
      const clawBridgePath = path.join(os.homedir(), '.claw-bridge', 'config.json');
      let callCount = 0;
      const existsSyncSpy = jest.spyOn(fs, 'existsSync').mockImplementation((p) => {
        if (p === clawBridgePath) {
          callCount++;
          return callCount > 1;
        }
        return false;
      });
      const readFileSyncSpy = jest.spyOn(fs, 'readFileSync').mockImplementation(() => {
        return JSON.stringify({ nodeId: 'user456' });
      });

      const promise = worker.waitForImUserId();

      jest.advanceTimersByTime(3 * 60 * 1000);
      const result = await promise;

      expect(result).toBe('user456');

      existsSyncSpy.mockRestore();
      readFileSyncSpy.mockRestore();
    });
  });

  describe('startHeartbeat', () => {
    test('should set up heartbeat interval', async () => {
      worker.config = mockConfig;
      worker.rongcloudClient = mockRongCloudClient;

      await worker.startHeartbeat();

      expect(worker.heartbeatInterval).not.toBeNull();
    });
  });

  describe('sendDashboardChunk', () => {
    test('should send dashboard chunk when connected', async () => {
      worker.rongcloudClient = mockRongCloudClient;
      await worker.sendDashboardChunk('dashboard_sessions', { sessions: [] });

      expect(mockRongCloudClient.sendStructuredMessage).toHaveBeenCalledWith(
        'dashboard_sessions',
        { sessions: [] }
      );
    });

    test('should not send when not connected', async () => {
      mockRongCloudClient.isConnected = false;
      worker.rongcloudClient = mockRongCloudClient;
      await worker.sendDashboardChunk('dashboard_sessions', { sessions: [] });

      expect(mockRongCloudClient.sendStructuredMessage).not.toHaveBeenCalled();
    });
  });

  describe('startDashboardReport', () => {
    test('should set up dashboard interval', async () => {
      worker.config = mockConfig;
      worker.rongcloudClient = mockRongCloudClient;

      await worker.startDashboardReport();

      expect(worker.dashboardInterval).not.toBeNull();
    });
  });

  describe('startHealthServer', () => {
    test('should start HTTP server on port 33100', () => {
      const mockServer = {
        listen: jest.fn((port, host, cb) => cb())
      };
      jest.spyOn(http, 'createServer').mockReturnValue(mockServer);

      worker.startHealthServer();

      expect(mockServer.listen).toHaveBeenCalledWith(33100, '127.0.0.1', expect.any(Function));
    });

    test('should return health status', () => {
      const mockEnd = jest.fn();
      const mockWriteHead = jest.fn();
      const mockServer = {
        listen: jest.fn()
      };
      let requestHandler;

      jest.spyOn(http, 'createServer').mockImplementation((handler) => {
        requestHandler = handler;
        return mockServer;
      });

      worker.rongcloudClient = mockRongCloudClient;
      worker.startHealthServer();

      const mockReq = { url: '/health' };
      const mockRes = {
        writeHead: mockWriteHead,
        end: mockEnd
      };

      requestHandler(mockReq, mockRes);

      expect(mockWriteHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
      expect(mockEnd).toHaveBeenCalledWith(expect.stringContaining('"status":"ok"'));
    });

    test('should return version', () => {
      const mockEnd = jest.fn();
      const mockWriteHead = jest.fn();
      const mockServer = {
        listen: jest.fn()
      };
      let requestHandler;

      jest.spyOn(http, 'createServer').mockImplementation((handler) => {
        requestHandler = handler;
        return mockServer;
      });

      const versionSpy = jest.spyOn(fs, 'readFileSync').mockReturnValue('{"version":"1.0.0"}');

      worker.startHealthServer();

      const mockReq = { url: '/version' };
      const mockRes = {
        writeHead: mockWriteHead,
        end: mockEnd
      };

      requestHandler(mockReq, mockRes);

      expect(mockWriteHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
      expect(mockEnd).toHaveBeenCalledWith('{"version":"1.0.0"}');

      versionSpy.mockRestore();
    });
  });

  describe('shutdown', () => {
    test('should disconnect rongcloud client', async () => {
      worker.rongcloudClient = mockRongCloudClient;
      await worker.shutdown();

      expect(mockRongCloudClient.disconnect).toHaveBeenCalled();
    });

    test('should not run shutdown twice', async () => {
      worker.rongcloudClient = mockRongCloudClient;
      await worker.shutdown();
      await worker.shutdown();

      expect(mockRongCloudClient.disconnect).toHaveBeenCalledTimes(1);
    });
  });

  describe('init', () => {
    test('should initialize all modules', async () => {
      const originalExit = process.exit;
      process.exit = jest.fn();

      const clawBridgePath = path.join(os.homedir(), '.claw-bridge', 'config.json');
      const existsSyncSpy = jest.spyOn(fs, 'existsSync').mockImplementation((p) => {
        return p === clawBridgePath;
      });
      const readFileSyncSpy = jest.spyOn(fs, 'readFileSync').mockImplementation(() => {
        return JSON.stringify({ nodeId: 'user123' });
      });

      const mockServer = {
        listen: jest.fn((port, host, cb) => cb()),
        close: jest.fn((cb) => cb())
      };
      jest.spyOn(http, 'createServer').mockReturnValue(mockServer);

      await worker.init();

      process.exit = originalExit;

      expect(loadConfig).toHaveBeenCalled();
      expect(startOpencodeService).toHaveBeenCalled();
      expect(RongCloudClient).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: 'user123' }),
        expect.any(Object)
      );
      expect(MessageHandler).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: 'user123' }),
        expect.any(Function),
        expect.any(Object)
      );
      expect(mockRongCloudClient.connect).toHaveBeenCalledWith(mockMessageHandler);
      expect(getMacAddress).toHaveBeenCalled();
      expect(mockRongCloudClient.sendStructuredMessage).toHaveBeenCalledWith(
        'client_connected',
        expect.objectContaining({
          mac: 'aabbccddeeff',
          nodeName: 'test_node'
        })
      );

      existsSyncSpy.mockRestore();
      readFileSyncSpy.mockRestore();
    });
  });
});
