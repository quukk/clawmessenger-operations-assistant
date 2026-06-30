const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadConfig } = require('../../service/modules/config');

jest.mock('fs');
jest.mock('os');

describe('Config Module', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...originalEnv };
    os.homedir.mockReturnValue('/home/testuser');
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('returns an object with all required properties', () => {
    fs.existsSync.mockReturnValue(false);
    
    const config = loadConfig();
    
    expect(config).toHaveProperty('appKey');
    expect(config).toHaveProperty('token');
    expect(config).toHaveProperty('accountId');
    expect(config).toHaveProperty('nodeName');
    expect(config).toHaveProperty('secretKey');
    expect(config).toHaveProperty('nickname');
    expect(config).toHaveProperty('reconnectInterval');
    expect(config).toHaveProperty('heartbeatInterval');
    expect(config).toHaveProperty('openclawPort');
    expect(config).toHaveProperty('scriptTimeout');
    expect(config).toHaveProperty('successKeyword');
    expect(config).toHaveProperty('chatTimeout');
    expect(config).toHaveProperty('apiBaseUrl');
  });

  test('has correct default values', () => {
    fs.existsSync.mockReturnValue(false);
    
    const config = loadConfig();
    
    expect(config.appKey).toBe('bmdehs6pbyyks');
    expect(config.token).toBeUndefined();
    expect(config.accountId).toBeUndefined();
    expect(config.nodeName).toBe('cli-client');
    expect(config.secretKey).toBe('secret_key');
    expect(config.nickname).toBe('CLI客户端');
    expect(config.reconnectInterval).toBe(60);
    expect(config.heartbeatInterval).toBe(20);
    expect(config.openclawPort).toBe(18789);
    expect(config.scriptTimeout).toBe(180);
    expect(config.successKeyword).toBe('Success');
    expect(config.chatTimeout).toBe(600);
    expect(config.apiBaseUrl).toBe('https://newsradar.dreamdt.cn');
  });

  test('reads from claw-bridge config', () => {
    fs.existsSync.mockImplementation((filePath) => {
      return filePath.includes('.claw-bridge');
    });
    fs.readFileSync.mockReturnValue(JSON.stringify({
      token: 'bridge-token',
      nodeId: 'bridge-node-123',
      nodeName: 'bridge-client'
    }));
    
    const config = loadConfig();
    
    expect(config.token).toBe('bridge-token');
    expect(config.accountId).toBe('bridge-node-123');
    expect(config.nodeName).toBe('bridge-client');
  });

  test('reads from local config file', () => {
    fs.existsSync.mockImplementation((filePath) => {
      return filePath.includes('rongcloud-config.json');
    });
    fs.readFileSync.mockReturnValue(JSON.stringify({
      appKey: 'local-app-key',
      token: 'local-token',
      accountId: 'local-account',
      secretKey: 'local-secret',
      nickname: 'LocalClient',
      reconnectInterval: 30,
      apiBaseUrl: 'http://localhost:9000'
    }));
    
    const config = loadConfig();
    
    expect(config.appKey).toBe('local-app-key');
    expect(config.token).toBe('local-token');
    expect(config.accountId).toBe('local-account');
    expect(config.secretKey).toBe('local-secret');
    expect(config.nickname).toBe('LocalClient');
    expect(config.reconnectInterval).toBe(30);
    expect(config.apiBaseUrl).toBe('http://localhost:9000');
  });

  test('environment variable DM_APP_KEY overrides local config', () => {
    process.env.DM_APP_KEY = 'env-app-key';
    
    fs.existsSync.mockImplementation((filePath) => {
      return filePath.includes('rongcloud-config.json');
    });
    fs.readFileSync.mockReturnValue(JSON.stringify({
      appKey: 'local-app-key'
    }));
    
    const config = loadConfig();
    
    expect(config.appKey).toBe('env-app-key');
  });

  test('local config overrides claw-bridge config for most fields', () => {
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockImplementation((filePath) => {
      if (filePath.includes('.claw-bridge')) {
        return JSON.stringify({
          token: 'bridge-token',
          nodeId: 'bridge-node',
          nodeName: 'bridge-name'
        });
      }
      if (filePath.includes('rongcloud-config.json')) {
        return JSON.stringify({
          token: 'local-token',
          accountId: 'local-account'
        });
      }
      return '{}';
    });
    
    const config = loadConfig();
    
    expect(config.token).toBe('local-token');
    expect(config.accountId).toBe('local-account');
    expect(config.nodeName).toBe('bridge-name');
  });

  test('handles invalid claw-bridge config gracefully', () => {
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockReturnValue('invalid json');
    
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
    
    const config = loadConfig();
    
    expect(config.appKey).toBe('bmdehs6pbyyks');
    expect(consoleSpy).toHaveBeenCalled();
    
    consoleSpy.mockRestore();
  });

  test('handles invalid local config gracefully', () => {
    fs.existsSync.mockImplementation((filePath) => {
      return filePath.includes('rongcloud-config.json');
    });
    fs.readFileSync.mockReturnValue('invalid json');
    
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
    
    const config = loadConfig();
    
    expect(config.appKey).toBe('bmdehs6pbyyks');
    expect(consoleSpy).toHaveBeenCalled();
    
    consoleSpy.mockRestore();
  });

  test('properly merges all configuration sources', () => {
    process.env.DM_APP_KEY = 'env-app-key';
    
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockImplementation((filePath) => {
      if (filePath.includes('.claw-bridge')) {
        return JSON.stringify({
          token: 'bridge-token',
          nodeId: 'bridge-node',
          nodeName: 'bridge-name'
        });
      }
      if (filePath.includes('rongcloud-config.json')) {
        return JSON.stringify({
          appKey: 'local-app-key',
          secretKey: 'local-secret',
          nickname: 'LocalClient',
          reconnectInterval: 45
        });
      }
      return '{}';
    });
    
    const config = loadConfig();
    
    // env > local > claw-bridge > default
    expect(config.appKey).toBe('env-app-key');        // from env
    expect(config.token).toBe('bridge-token');         // from claw-bridge (local doesn't have it)
    expect(config.accountId).toBe('bridge-node');      // from claw-bridge (local doesn't have it)
    expect(config.nodeName).toBe('bridge-name');       // from claw-bridge
    expect(config.secretKey).toBe('local-secret');     // from local
    expect(config.nickname).toBe('LocalClient');       // from local
    expect(config.reconnectInterval).toBe(45);         // from local
    expect(config.heartbeatInterval).toBe(20);         // default
    expect(config.openclawPort).toBe(18789);           // default
    expect(config.scriptTimeout).toBe(180);            // default
    expect(config.successKeyword).toBe('Success');     // default
    expect(config.chatTimeout).toBe(600);              // default
    expect(config.apiBaseUrl).toBe('https://newsradar.dreamdt.cn'); // default
  });
});
