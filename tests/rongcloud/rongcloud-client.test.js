// Mock RongIMLib before importing the module
jest.mock('@rongcloud/imlib-next', () => ({
  default: {
    init: jest.fn(),
    connect: jest.fn(),
    sendTextMessage: jest.fn(),
    disconnect: jest.fn(),
    addEventListener: jest.fn(),
    Events: {
      MESSAGES: 'MESSAGES',
      CONNECTED: 'CONNECTED',
      DISCONNECT: 'DISCONNECT'
    },
    ConversationType: {
      PRIVATE: 1,
      GROUP: 3
    }
  }
}));

const { RongCloudClient } = require('../../service/rongcloud/rongcloud-client');
const RongIMLibModule = require('@rongcloud/imlib-next');
const RongIMLib = RongIMLibModule.default || RongIMLibLibModule;

// Mock dependencies
jest.mock('../../service/modules/mac-address', () => ({
  getMacAddress: jest.fn(() => 'aabbccddeeff')
}));

jest.mock('../../service/modules/auth', () => ({
  generateSecret: jest.fn((mac, secretKey) => `secret_${mac}_${secretKey}`)
}));

describe('RongCloudClient', () => {
  let client;
  let mockLog;
  let mockHandler;
  let mockSendTextMessage;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSendTextMessage = RongIMLib.sendTextMessage;
    mockLog = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn()
    };
    mockHandler = {
      handleMessage: jest.fn(),
      handleStructuredMessage: jest.fn()
    };
    client = new RongCloudClient({
      appKey: 'test_app_key',
      token: 'test_token',
      accountId: 'test_account',
      secretKey: 'test_secret_key'
    }, mockLog);
  });

  describe('sendStructuredMessage', () => {
    test('should return false when not connected', async () => {
      client.isConnected = false;
      const result = await client.sendStructuredMessage('test_type', { data: 'test' });
      expect(result).toBe(false);
      expect(mockLog.error).toHaveBeenCalledWith('[RongCloudClient] 未连接，无法发送消息');
    });

    test('should send structured message successfully', async () => {
      client.isConnected = true;
      mockSendTextMessage.mockResolvedValue({ code: 0 });

      const result = await client.sendStructuredMessage('test_type', { data: 'test' }, 'req_123');

      expect(result).toBe(true);
      expect(mockSendTextMessage).toHaveBeenCalledWith(
        {
          conversationType: 1,
          targetId: 'guardserver'
        },
        {
          content: expect.stringContaining('"msg_type":"test_type"')
        }
      );

      const sentContent = JSON.parse(mockSendTextMessage.mock.calls[0][1].content);
      expect(sentContent).toMatchObject({
        msg_type: 'test_type',
        source_im_id: 'test_account',
        destination_im_id: 'guardserver',
        mac: 'aabbccddeeff',
        secret: 'secret_aabbccddeeff_test_secret_key',
        content: '{"data":"test"}',
        request_id: 'req_123'
      });
      expect(sentContent.timestamp).toBeDefined();
    });

    test('should send structured message without requestId', async () => {
      client.isConnected = true;
      mockSendTextMessage.mockResolvedValue({ code: 200 });

      const result = await client.sendStructuredMessage('test_type', { data: 'test' });

      expect(result).toBe(true);
      const sentContent = JSON.parse(mockSendTextMessage.mock.calls[0][1].content);
      expect(sentContent.request_id).toBe('');
    });

    test('should return false when send fails', async () => {
      client.isConnected = true;
      mockSendTextMessage.mockResolvedValue({ code: 500 });

      const result = await client.sendStructuredMessage('test_type', { data: 'test' });

      expect(result).toBe(false);
    });

    test('should return false on exception', async () => {
      client.isConnected = true;
      mockSendTextMessage.mockRejectedValue(new Error('Network error'));

      const result = await client.sendStructuredMessage('test_type', { data: 'test' });

      expect(result).toBe(false);
      expect(mockLog.error).toHaveBeenCalledWith('[RongCloudClient] 发送异常: Network error');
    });
  });

  describe('processStructuredMessage', () => {
    test('should process valid structured message', async () => {
      client.handler = mockHandler;
      const message = {
        content: {
          content: JSON.stringify({
            msg_type: 'custom_type',
            source_im_id: 'user1',
            destination_im_id: 'guardserver',
            mac: '112233445566',
            secret: 'test_secret',
            content: '{"key":"value"}',
            request_id: 'req_456',
            timestamp: 1234567890
          })
        },
        senderUserId: 'user1',
        targetId: 'guardserver',
        conversationType: 1,
        messageUId: 'msg_123',
        sentTime: 1234567890000
      };

      const result = client.processStructuredMessage(message);
      expect(result).toBe(true);

      // Wait for async processing
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockHandler.handleStructuredMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          msgType: 'custom_type',
          sourceImId: 'user1',
          destinationImId: 'guardserver',
          mac: '112233445566',
          secret: 'test_secret',
          content: '{"key":"value"}',
          requestId: 'req_456',
          timestamp: 1234567890,
          senderUserId: 'user1',
          targetId: 'guardserver',
          conversationType: 1,
          messageUId: 'msg_123',
          sentTime: 1234567890000
        })
      );
    });

    test('should return false for invalid JSON', () => {
      const message = {
        content: {
          content: 'invalid json'
        }
      };

      const result = client.processStructuredMessage(message);
      expect(result).toBe(false);
      expect(mockLog.warn).toHaveBeenCalledWith('[RongCloudClient] 无法解析结构化消息');
    });

    test('should return false for missing msg_type', () => {
      const message = {
        content: {
          content: JSON.stringify({ data: 'no msg_type' })
        }
      };

      const result = client.processStructuredMessage(message);
      expect(result).toBe(false);
      expect(mockLog.warn).toHaveBeenCalledWith('[RongCloudClient] 消息缺少 msg_type 字段');
    });

    test('should warn when handler does not support structured messages', async () => {
      client.handler = { handleMessage: jest.fn() }; // No handleStructuredMessage
      const message = {
        content: {
          content: JSON.stringify({ msg_type: 'test' })
        }
      };

      const result = client.processStructuredMessage(message);
      expect(result).toBe(true);

      await new Promise(resolve => setTimeout(resolve, 10));
      expect(mockLog.warn).toHaveBeenCalledWith('[RongCloudClient] 处理器未设置或不支持结构化消息');
    });

    test('should use default values for missing fields', async () => {
      client.handler = mockHandler;
      const message = {
        content: {
          content: JSON.stringify({ msg_type: 'minimal' })
        }
      };

      client.processStructuredMessage(message);
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockHandler.handleStructuredMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          msgType: 'minimal',
          sourceImId: 'unknown',
          destinationImId: 'guardserver',
          mac: '',
          secret: '',
          content: '',
          requestId: '',
          senderUserId: 'unknown',
          targetId: 'guardserver',
          conversationType: 1
        })
      );
    });
  });

  describe('handleReceivedMessage', () => {
    test('should route structured messages to processStructuredMessage', () => {
      client.handler = mockHandler;
      const processSpy = jest.spyOn(client, 'processStructuredMessage').mockReturnValue(true);

      const message = {
        messageType: 'RC:TxtMsg',
        senderUserId: 'user1',
        content: {
          content: JSON.stringify({
            msg_type: 'custom_event',
            source_im_id: 'other_user'
          })
        }
      };

      client.handleReceivedMessage(message);

      expect(processSpy).toHaveBeenCalledWith(message);
      expect(mockHandler.handleMessage).not.toHaveBeenCalled();

      processSpy.mockRestore();
    });

    test('should ignore system message types', () => {
      client.handler = mockHandler;
      const processSpy = jest.spyOn(client, 'processStructuredMessage');

      const message = {
        messageType: 'RC:TxtMsg',
        senderUserId: 'server',
        content: {
          content: JSON.stringify({
            msg_type: 'command',
            source_im_id: 'server'
          })
        }
      };

      client.handleReceivedMessage(message);

      expect(processSpy).not.toHaveBeenCalled();
      expect(mockHandler.handleMessage).not.toHaveBeenCalled();

      processSpy.mockRestore();
    });

    test('should ignore messages from self', () => {
      client.handler = mockHandler;
      const processSpy = jest.spyOn(client, 'processStructuredMessage');

      const message = {
        messageType: 'RC:TxtMsg',
        senderUserId: 'test_account',
        content: {
          content: JSON.stringify({
            msg_type: 'custom_event',
            source_im_id: 'test_account'
          })
        }
      };

      client.handleReceivedMessage(message);

      expect(processSpy).not.toHaveBeenCalled();
      expect(mockHandler.handleMessage).not.toHaveBeenCalled();

      processSpy.mockRestore();
    });

    test('should handle plain text messages', async () => {
      client.handler = mockHandler;
      const message = {
        messageType: 'RC:TxtMsg',
        senderUserId: 'user1',
        targetId: 'user2',
        conversationType: 1,
        content: {
          content: 'Hello world'
        },
        messageUId: 'msg_123',
        sentTime: 1234567890000
      };

      client.handleReceivedMessage(message);

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockHandler.handleMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          senderUserId: 'user1',
          targetId: 'user2',
          conversationType: 1,
          content: 'Hello world',
          messageType: 'RC:TxtMsg',
          messageUId: 'msg_123',
          sentTime: 1234567890000
        })
      );
    });

    test('should handle JSON content without msg_type', async () => {
      client.handler = mockHandler;
      const message = {
        messageType: 'RC:TxtMsg',
        senderUserId: 'user1',
        content: {
          content: JSON.stringify({ text: 'Hello from JSON' })
        }
      };

      client.handleReceivedMessage(message);

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockHandler.handleMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          content: 'Hello from JSON'
        })
      );
    });
  });
});
