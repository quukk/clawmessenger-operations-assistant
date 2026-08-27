jest.mock('@rongcloud/imlib-next', () => ({
  default: {
    init: jest.fn(),
    connect: jest.fn(),
    sendMessage: jest.fn(),
    TextMessage: jest.fn((content) => content),
    disconnect: jest.fn(),
    registerMessageType: jest.fn(),
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
const RongIMLib = RongIMLibModule.default || RongIMLibModule;

describe('RongCloudClient', () => {
  let client;
  let mockLog;
  let mockHandler;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLog = {
      debug: jest.fn(),
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn()
    };
    mockHandler = {
      handleMessage: jest.fn().mockResolvedValue(undefined)
    };
    client = new RongCloudClient({
      appKey: 'test_app_key',
      token: 'test_token',
      accountId: 'test_account'
    }, mockLog);
  });

  describe('sendMessage', () => {
    test('returns false without calling the SDK when disconnected', async () => {
      const result = await client.sendMessage('user1', 'hello', 1);

      expect(result).toBe(false);
      expect(mockLog.error).toHaveBeenCalledWith('[RongCloudClient] 未连接，无法发送消息');
      expect(RongIMLib.sendMessage).not.toHaveBeenCalled();
    });

    test('sends a private text message and remembers its message id', async () => {
      client.isConnected = true;
      RongIMLib.sendMessage.mockResolvedValue({ code: 200, data: { messageUId: 'sent-1' } });

      const result = await client.sendMessage('user1', 'hello', 1);

      expect(result).toBe(true);
      expect(RongIMLib.TextMessage).toHaveBeenCalledWith({ content: 'hello' });
      expect(RongIMLib.sendMessage).toHaveBeenCalledWith(
        { conversationType: 1, targetId: 'user1' },
        { content: 'hello' }
      );
      expect(client.sentMessageUIds.has('sent-1')).toBe(true);
    });

    test('serializes an unregistered structured group message as text', async () => {
      client.isConnected = true;
      RongIMLib.sendMessage.mockResolvedValue({ code: 0, data: {} });
      const content = { msg_type: 'custom_event', data: 'test' };

      const result = await client.sendMessage('group1', content, 3);

      expect(result).toBe(true);
      expect(RongIMLib.sendMessage).toHaveBeenCalledWith(
        { conversationType: 3, targetId: 'group1' },
        { content: JSON.stringify(content) }
      );
    });

    test('returns false when the SDK rejects the message', async () => {
      client.isConnected = true;
      RongIMLib.sendMessage.mockResolvedValue({ code: 500, data: {} });

      await expect(client.sendMessage('user1', 'hello', 1)).resolves.toBe(false);
      expect(mockLog.error).toHaveBeenCalledWith('[RongCloudClient] 发送失败, code: 500');
    });

    test('returns false when the SDK throws', async () => {
      client.isConnected = true;
      RongIMLib.sendMessage.mockRejectedValue(new Error('Network error'));

      await expect(client.sendMessage('user1', 'hello', 1)).resolves.toBe(false);
      expect(mockLog.error).toHaveBeenCalledWith('[RongCloudClient] 发送异常: Network error');
    });
  });

  describe('handleReceivedMessage', () => {
    test('routes structured content through the common handler', () => {
      client.handler = mockHandler;
      const content = {
        msg_type: 'custom_event',
        source_im_id: 'origin-user',
        payload: { key: 'value' }
      };

      client.handleReceivedMessage({
        messageType: 'command',
        senderUserId: 'relay-user',
        targetId: 'test_account',
        conversationType: 1,
        content,
        messageUId: 'msg-1',
        sentTime: 1234567890000
      });

      expect(mockHandler.handleMessage).toHaveBeenCalledWith(expect.objectContaining({
        senderUserId: 'origin-user',
        targetId: 'test_account',
        conversationType: 1,
        content: JSON.stringify(content),
        messageType: 'command',
        messageUId: 'msg-1',
        sentTime: 1234567890000
      }));
    });

    test('ignores messages sent by this account', () => {
      client.handler = mockHandler;

      client.handleReceivedMessage({
        messageType: 'RC:TxtMsg',
        senderUserId: 'test_account',
        content: { content: 'hello' }
      });

      expect(mockHandler.handleMessage).not.toHaveBeenCalled();
    });

    test('ignores structured messages sourced from this account', () => {
      client.handler = mockHandler;

      client.handleReceivedMessage({
        messageType: 'command',
        senderUserId: 'relay-user',
        content: { msg_type: 'custom_event', source_im_id: 'test_account' }
      });

      expect(mockHandler.handleMessage).not.toHaveBeenCalled();
    });

    test('passes plain-text metadata to the common handler', () => {
      client.handler = mockHandler;

      client.handleReceivedMessage({
        messageType: 'RC:TxtMsg',
        senderUserId: 'user1',
        targetId: 'user2',
        conversationType: 1,
        content: { content: 'Hello world' },
        messageUId: 'msg-2',
        sentTime: 1234567890000
      });

      expect(mockHandler.handleMessage).toHaveBeenCalledWith(expect.objectContaining({
        senderUserId: 'user1',
        targetId: 'user2',
        conversationType: 1,
        content: 'Hello world',
        messageType: 'RC:TxtMsg',
        messageUId: 'msg-2',
        sentTime: 1234567890000
      }));
    });

    test('extracts text from JSON without a message type', () => {
      client.handler = mockHandler;

      client.handleReceivedMessage({
        messageType: 'RC:TxtMsg',
        senderUserId: 'user1',
        content: { content: JSON.stringify({ text: 'Hello from JSON' }) }
      });

      expect(mockHandler.handleMessage).toHaveBeenCalledWith(expect.objectContaining({
        content: 'Hello from JSON'
      }));
    });
  });
});
