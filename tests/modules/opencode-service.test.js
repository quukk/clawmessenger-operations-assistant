const {
  createOpencodeSession,
  deleteOpencodeSession,
  getOrCreateGatewaySession,
  forwardChatMessage
} = require('../../service/modules/opencode-service');

const axios = require('axios');

jest.mock('axios');

describe('Opencode Service Module', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('createOpencodeSession', () => {
    test('creates session with title', async () => {
      axios.post.mockResolvedValue({ data: { id: 'session-123', title: 'Test' } });

      const result = await createOpencodeSession('Test');

      expect(axios.post).toHaveBeenCalledWith(
        'http://127.0.0.1:4096/session',
        { title: 'Test' },
        { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
      );
      expect(result).toEqual({ id: 'session-123', title: 'Test' });
    });

    test('returns empty object on empty response', async () => {
      axios.post.mockResolvedValue({ data: null });

      const result = await createOpencodeSession('Test');

      expect(result).toEqual({});
    });
  });

  describe('deleteOpencodeSession', () => {
    test('returns true on successful delete', async () => {
      axios.delete.mockResolvedValue({});

      const result = await deleteOpencodeSession('session-123');

      expect(axios.delete).toHaveBeenCalledWith(
        'http://127.0.0.1:4096/session/session-123',
        { timeout: 10000 }
      );
      expect(result).toBe(true);
    });

    test('returns false on delete failure', async () => {
      axios.delete.mockRejectedValue(new Error('Not found'));

      const result = await deleteOpencodeSession('session-123');

      expect(result).toBe(false);
    });
  });

  describe('getOrCreateGatewaySession', () => {
    test('returns first existing session id', async () => {
      axios.get.mockResolvedValue({
        data: [{ id: 'existing-session', title: 'Chat' }]
      });

      const result = await getOrCreateGatewaySession('fallback');

      expect(result).toBe('existing-session');
    });

    test('returns session_id if id not present', async () => {
      axios.get.mockResolvedValue({
        data: [{ session_id: 'sess-456' }]
      });

      const result = await getOrCreateGatewaySession('fallback');

      expect(result).toBe('sess-456');
    });

    test('creates new session when none exist', async () => {
      axios.get.mockResolvedValue({ data: [] });
      axios.post.mockResolvedValue({ data: { id: 'new-session' } });

      const result = await getOrCreateGatewaySession('fallback');

      expect(axios.post).toHaveBeenCalledWith(
        'http://127.0.0.1:4096/api/sessions',
        { title: 'Chat session' },
        { headers: { 'Content-Type': 'application/json' }, timeout: 5000 }
      );
      expect(result).toBe('new-session');
    });

    test('returns fallback on complete failure', async () => {
      axios.get.mockRejectedValue(new Error('Network error'));
      axios.post.mockRejectedValue(new Error('Network error'));

      const result = await getOrCreateGatewaySession('fallback-id');

      expect(result).toBe('fallback-id');
    });
  });

  describe('forwardChatMessage', () => {
    test('extracts text from top-level field and streams chunks', async () => {
      axios.get.mockResolvedValue({ data: [] });
      axios.post.mockResolvedValue({
        data: { text: 'Hello world this is a test message' },
        status: 200
      });

      const deltas = [];
      const onDelta = jest.fn(async (chunk) => {
        deltas.push(chunk);
      });

      const result = await forwardChatMessage('sess-1', 'Hi', onDelta);

      expect(result).toBe('Hello world this is a test message');
      expect(onDelta).toHaveBeenCalledTimes(1);
      expect(deltas[0]).toBe('Hello world this is a test message');
    });

    test('extracts text from parts array', async () => {
      axios.get.mockResolvedValue({ data: [] });
      axios.post.mockResolvedValue({
        data: {
          parts: [
            { type: 'text', text: 'First part ' },
            { type: 'assistant', text: 'Second part' }
          ]
        },
        status: 200
      });

      const deltas = [];
      const onDelta = jest.fn(async (chunk) => {
        deltas.push(chunk);
      });

      const result = await forwardChatMessage('sess-1', 'Hi', onDelta);

      expect(result).toBe('First part Second part');
    });

    test('extracts text from info object', async () => {
      axios.get.mockResolvedValue({ data: [] });
      axios.post.mockResolvedValue({
        data: {
          info: { text: 'Info text content' }
        },
        status: 200
      });

      const onDelta = jest.fn();

      const result = await forwardChatMessage('sess-1', 'Hi', onDelta);

      expect(result).toBe('Info text content');
    });

    test('simulates streaming with 50-char chunks', async () => {
      axios.get.mockResolvedValue({ data: [] });
      const longText = 'A'.repeat(120);
      axios.post.mockResolvedValue({
        data: { text: longText },
        status: 200
      });

      const deltas = [];
      const onDelta = jest.fn(async (chunk) => {
        deltas.push(chunk);
      });

      const promise = forwardChatMessage('sess-1', 'Hi', onDelta);
      
      // Fast-forward all timers to resolve setTimeout promises
      await jest.runAllTimersAsync();
      
      const result = await promise;

      expect(result).toBe(longText);
      expect(deltas.length).toBe(3);
      expect(deltas[0]).toBe('A'.repeat(50));
      expect(deltas[1]).toBe('A'.repeat(50));
      expect(deltas[2]).toBe('A'.repeat(20));
    });

    test('throws error when no content found', async () => {
      axios.get.mockResolvedValue({ data: [] });
      axios.post.mockResolvedValue({
        data: { parts: [] },
        status: 200
      });

      const onDelta = jest.fn();

      await expect(forwardChatMessage('sess-1', 'Hi', onDelta)).rejects.toThrow('Gateway 返回空内容');
    });

    test('uses custom timeout', async () => {
      axios.get.mockResolvedValue({ data: [] });
      axios.post.mockResolvedValue({
        data: { text: 'Quick response' },
        status: 200
      });

      const onDelta = jest.fn();

      await forwardChatMessage('sess-1', 'Hi', onDelta, null, 30000);

      expect(axios.post).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        expect.objectContaining({ timeout: 30000 })
      );
    });

    test('calls logFn when provided', async () => {
      axios.get.mockResolvedValue({ data: [] });
      axios.post.mockResolvedValue({
        data: { text: 'Test' },
        status: 200
      });

      const logFn = jest.fn();
      const onDelta = jest.fn();

      await forwardChatMessage('sess-1', 'Hi', onDelta, logFn);

      expect(logFn).toHaveBeenCalled();
    });
  });
});
