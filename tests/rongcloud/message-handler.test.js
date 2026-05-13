const { MessageHandler } = require('../../service/rongcloud/message-handler');
const axios = require('axios');

jest.mock('../../service/rongcloud/openclaw-client', () => {
  class MockOpenClawClient {
    constructor(log) { this.log = log; }
    async chat(message, fromUser) {
      return `Mock reply to: ${message}`;
    }
    async chatStream(message, fromUser, onDelta, onDone) {
      onDelta('Mock ');
      onDelta('stream ');
      onDelta('reply');
      onDone('Mock stream reply');
    }
  }
  return { OpenClawClient: MockOpenClawClient };
});

jest.mock('axios');

describe('MessageHandler', () => {
  let handler;
  let mockSendFn;
  let mockLog;
  let mockConfig;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSendFn = jest.fn().mockResolvedValue(true);
    mockLog = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn()
    };
    mockConfig = {
      accountId: 'test_account',
      maxRounds: 10,
      apiBaseUrl: null // 禁用流式处理，简化测试
    };
    handler = new MessageHandler(mockConfig, mockSendFn, mockLog);
  });

  describe('constructor', () => {
    test('should initialize with config, sendFn, log and round tracking', () => {
      expect(handler.config).toBe(mockConfig);
      expect(handler.sendFn).toBe(mockSendFn);
      expect(handler.log).toBe(mockLog);
      expect(handler._groupRoundCounts).toBeInstanceOf(Map);
      expect(handler._defaultMaxRounds).toBe(10);
    });
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
        messageType: 'RC:ImgMsg',
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

    test('should handle normal text messages', () => {
      const msg = {
        messageType: 'RC:TxtMsg',
        senderUserId: 'user1',
        content: 'Hello'
      };
      expect(handler.shouldHandleMessage(msg)).toBe(true);
    });
  });

  describe('handleMessage', () => {
    test('should process normal private chat messages with mention', async () => {
      const msg = {
        messageType: 'RC:TxtMsg',
        senderUserId: 'user1',
        targetId: 'user2',
        conversationType: 1,
        content: 'Hello @test_account',
        mentionedInfo: { userIdList: ['test_account'] }
      };
      await handler.handleMessage(msg);
      // 私聊回复目标为发送者
      expect(mockSendFn).toHaveBeenCalledWith('user1', expect.any(String), 1);
    });

    test('should track group chat rounds and block when max reached', async () => {
      axios.get.mockResolvedValue({
        data: { code: 200, data: { maxRounds: 2 } }
      });
      const msg = {
        messageType: 'RC:TxtMsg',
        senderUserId: 'user1',
        targetId: 'group1',
        conversationType: 3,
        content: 'Hello'
      };
      handler._groupRoundCounts.clear();
      handler._groupConfigCache.clear();

      // 第1轮：正常处理
      await handler.handleMessage(msg);
      expect(handler._getGroupRoundCount('group1')).toBe(1);
      expect(mockSendFn).toHaveBeenCalledWith('group1', expect.any(String), 3);

      // 第2轮：正常处理
      mockSendFn.mockClear();
      await handler.handleMessage(msg);
      expect(handler._getGroupRoundCount('group1')).toBe(2);

      // 第3轮：应被阻止
      mockSendFn.mockClear();
      await handler.handleMessage(msg);
      expect(handler._getGroupRoundCount('group1')).toBe(2);
      expect(mockSendFn).toHaveBeenCalledWith(
        'group1',
        expect.stringContaining('已达到最大轮数'),
        3
      );
    });

    test('should reset rounds with /newround command in group chat', async () => {
      axios.get.mockResolvedValue({
        data: { code: 200, data: { maxRounds: 10 } }
      });
      const msg = {
        messageType: 'RC:TxtMsg',
        senderUserId: 'user1',
        targetId: 'group1',
        conversationType: 3,
        content: '/newround'
      };
      handler._groupRoundCounts.set('group1', 10);
      handler._groupConfigCache.clear();

      await handler.handleMessage(msg);
      expect(handler._getGroupRoundCount('group1')).toBe(0);
      expect(mockSendFn).toHaveBeenCalledWith(
        'group1',
        expect.stringContaining('新一轮对话已开始'),
        3
      );
    });

    test('should show round status with /roundstatus command', async () => {
      axios.get.mockResolvedValue({
        data: { code: 200, data: { maxRounds: 10 } }
      });
      const msg = {
        messageType: 'RC:TxtMsg',
        senderUserId: 'user1',
        targetId: 'group1',
        conversationType: 3,
        content: '/roundstatus'
      };
      handler._groupRoundCounts.set('group1', 5);
      handler._groupConfigCache.clear();

      await handler.handleMessage(msg);
      expect(mockSendFn).toHaveBeenCalledWith(
        'group1',
        expect.stringContaining('第 6/10 轮'),
        3
      );
    });

    test('should show ended status with /roundstatus when max reached', async () => {
      axios.get.mockResolvedValue({
        data: { code: 200, data: { maxRounds: 10 } }
      });
      const msg = {
        messageType: 'RC:TxtMsg',
        senderUserId: 'user1',
        targetId: 'group1',
        conversationType: 3,
        content: '/roundstatus'
      };
      handler._groupRoundCounts.set('group1', 10);
      handler._groupConfigCache.clear();

      await handler.handleMessage(msg);
      expect(mockSendFn).toHaveBeenCalledWith(
        'group1',
        expect.stringContaining('本轮对话已结束'),
        3
      );
    });

    test('should not track rounds for private chat', async () => {
      const msg = {
        messageType: 'RC:TxtMsg',
        senderUserId: 'user1',
        targetId: 'user2',
        conversationType: 1,
        content: 'Hello'
      };
      handler._groupRoundCounts.clear();

      // 发送多条消息，私聊不应受轮数限制
      await handler.handleMessage(msg);
      await handler.handleMessage(msg);
      await handler.handleMessage(msg);

      expect(handler._getGroupRoundCount('user2')).toBe(0);
    });

    test('should handle slash-prefixed messages as normal chat in private with mention', async () => {
      const msg = {
        messageType: 'RC:TxtMsg',
        senderUserId: 'user1',
        targetId: 'user2',
        conversationType: 1,
        content: '/customcmd @test_account',
        mentionedInfo: { userIdList: ['test_account'] }
      };
      await handler.handleMessage(msg);
      // 私聊中 / 开头的消息当前作为普通消息处理，由 AI 回复
      expect(mockSendFn).toHaveBeenCalledWith('user1', expect.any(String), 1);
    });

    test('should send error reply on exception', async () => {
      const msg = {
        messageType: 'RC:TxtMsg',
        senderUserId: 'user1',
        targetId: 'user2',
        conversationType: 1,
        content: 'Hello @test_account',
        mentionedInfo: { userIdList: ['test_account'] }
      };
      // Force an error by making sendFn throw
      mockSendFn.mockRejectedValueOnce(new Error('Send failed'));
      await handler.handleMessage(msg);
      expect(mockSendFn).toHaveBeenCalledWith('user1', expect.stringContaining('处理失败'), 1);
    });
  });

  describe('round control helpers', () => {
    test('_getGroupRoundCount should return 0 for unknown groups', () => {
      expect(handler._getGroupRoundCount('unknown')).toBe(0);
    });

    test('_incrementGroupRoundCount should increase count', () => {
      handler._incrementGroupRoundCount('group1', 10);
      expect(handler._getGroupRoundCount('group1')).toBe(1);
      handler._incrementGroupRoundCount('group1', 10);
      expect(handler._getGroupRoundCount('group1')).toBe(2);
    });

    test('_resetGroupRoundCount should set count to 0', () => {
      handler._groupRoundCounts.set('group1', 5);
      handler._resetGroupRoundCount('group1');
      expect(handler._getGroupRoundCount('group1')).toBe(0);
    });

    test('_getGroupMaxRounds should fetch from API and cache', async () => {
      handler.config.apiBaseUrl = 'http://test-server';
      axios.get.mockResolvedValue({
        data: { code: 200, data: { maxRounds: 20 } }
      });
      const rounds = await handler._getGroupMaxRounds('group1');
      expect(rounds).toBe(20);
      expect(axios.get).toHaveBeenCalledWith(
        'http://test-server/im/api/group/info',
        { params: { groupId: 'group1' }, timeout: 5000 }
      );
      // 第二次调用应走缓存
      axios.get.mockClear();
      const rounds2 = await handler._getGroupMaxRounds('group1');
      expect(rounds2).toBe(20);
      expect(axios.get).not.toHaveBeenCalled();
    });

    test('_getGroupMaxRounds should fallback to default on API error', async () => {
      axios.get.mockRejectedValue(new Error('Network error'));
      const rounds = await handler._getGroupMaxRounds('group1');
      expect(rounds).toBe(10); // default
    });
  });

  describe('parseCommand', () => {
    test('should parse command without args', () => {
      const result = handler.parseCommand('/start', 'user1');
      expect(result).toEqual({
        command: 'start',
        args: [],
        rawMessage: '/start',
        senderId: 'user1'
      });
    });

    test('should parse command with args', () => {
      const result = handler.parseCommand('/start --verbose --debug', 'user1');
      expect(result).toEqual({
        command: 'start',
        args: ['--verbose', '--debug'],
        rawMessage: '/start --verbose --debug',
        senderId: 'user1'
      });
    });

    test('should handle empty command', () => {
      const result = handler.parseCommand('/', 'user1');
      expect(result).toEqual({
        command: '',
        args: [],
        rawMessage: '/',
        senderId: 'user1'
      });
    });
  });
});
