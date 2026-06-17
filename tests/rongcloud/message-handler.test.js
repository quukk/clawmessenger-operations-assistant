const { MessageHandler } = require('../../service/rongcloud/message-handler');

describe('MessageHandler', () => {
  let handler;
  let mockSendFn;
  let mockLog;
  let mockConfig;
  let mockSendReadReceiptFn;

  beforeEach(() => {
    mockSendFn = jest.fn().mockResolvedValue(true);
    mockLog = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn()
    };
    mockConfig = {
      accountId: 'test_account'
    };
    mockSendReadReceiptFn = jest.fn().mockResolvedValue(true);
    handler = new MessageHandler(mockConfig, mockSendFn, mockLog, mockSendReadReceiptFn);
  });

  describe('shouldHandleMessage', () => {
    test('should ignore offline messages', () => {
      const msg = {
        isOffLineMessage: true,
        senderUserId: 'user1',
        content: 'Hello'
      };
      expect(handler.shouldHandleMessage(msg)).toBe(false);
    });

    test('should ignore non-text messages', () => {
      const msg = {
        messageType: 'RC:UnknownMsg',
        senderUserId: 'user1',
        content: 'image'
      };
      expect(handler.shouldHandleMessage(msg)).toBe(false);
    });

    test('should ignore messages from self', () => {
      const msg = {
        messageType: 'RC:TxtMsg',
        senderUserId: 'test_account',
        content: 'Hello'
      };
      expect(handler.shouldHandleMessage(msg)).toBe(false);
    });

    test('should ignore normal private text messages without mention', () => {
      const msg = {
        messageType: 'RC:TxtMsg',
        senderUserId: 'user1',
        conversationType: 1,
        content: 'Hello'
      };
      expect(handler.shouldHandleMessage(msg)).toBe(false);
    });

    test('should handle text messages with mention to this node', () => {
      const msg = {
        messageType: 'RC:TxtMsg',
        senderUserId: 'user1',
        conversationType: 1,
        content: 'Hello @test_account',
        mentionedInfo: { userIdList: ['test_account'] }
      };
      expect(handler.shouldHandleMessage(msg)).toBe(true);
    });

    test('should ignore group chat messages without mention', () => {
      const msg = {
        messageType: 'RC:TxtMsg',
        senderUserId: 'user1',
        targetId: 'group1',
        conversationType: 3,
        content: 'Hello'
      };
      expect(handler.shouldHandleMessage(msg)).toBe(false);
    });
  });

  describe('handleMessage', () => {
    test('should send read receipt and ignore normal private chat messages with mention', async () => {
      const msg = {
        messageType: 'RC:TxtMsg',
        senderUserId: 'user1',
        targetId: 'user2',
        conversationType: 1,
        content: 'Hello @test_account',
        mentionedInfo: { userIdList: ['test_account'] },
        messageUId: 'msg-123'
      };
      await handler.handleMessage(msg);
      expect(mockSendReadReceiptFn).toHaveBeenCalledWith(msg);
      expect(mockSendFn).not.toHaveBeenCalled();
      expect(mockLog.info).toHaveBeenCalledWith(
        expect.stringContaining('普通消息已忽略')
      );
    });

    test('should not process normal group chat messages', async () => {
      const msg = {
        messageType: 'RC:TxtMsg',
        senderUserId: 'user1',
        targetId: 'group1',
        conversationType: 3,
        content: 'Hello'
      };
      await handler.handleMessage(msg);
      expect(mockSendFn).not.toHaveBeenCalled();
      expect(mockSendReadReceiptFn).not.toHaveBeenCalled();
    });

    test('should log read receipt failure as warn', async () => {
      const msg = {
        messageType: 'RC:TxtMsg',
        senderUserId: 'user1',
        targetId: 'user2',
        conversationType: 1,
        content: 'Hello @test_account',
        mentionedInfo: { userIdList: ['test_account'] },
        messageUId: 'msg-123'
      };
      mockSendReadReceiptFn.mockRejectedValueOnce(new Error('Receipt failed'));
      await handler.handleMessage(msg);
      // 等待 microtask 完成，因为 sendReadReceiptFn 是 fire-and-forget
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.stringContaining('发送已读回执失败')
      );
    });
  });
});
