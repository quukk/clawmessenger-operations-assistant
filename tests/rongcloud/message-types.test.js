const { RongyunMessageTypeEnum: MessageTypes } = require('../../service/rongcloud/message-types');

describe('MessageTypes', () => {
  test('should have exactly 8 message types', () => {
    expect(Object.keys(MessageTypes)).toHaveLength(8);
  });

  test('should have correct CLIENT_CONNECTED value', () => {
    expect(MessageTypes.CLIENT_CONNECTED).toBe('client_connected');
  });

  test('should have correct CLIENT_DISCONNECTED value', () => {
    expect(MessageTypes.CLIENT_DISCONNECTED).toBe('client_disconnected');
  });

  test('should have correct HEARTBEAT value', () => {
    expect(MessageTypes.HEARTBEAT).toBe('heartbeat');
  });

  test('should have correct HEARTBEAT_ACK value', () => {
    expect(MessageTypes.HEARTBEAT_ACK).toBe('heartbeat_ack');
  });

  test('should have correct CHAT_MESSAGE value', () => {
    expect(MessageTypes.CHAT_MESSAGE).toBe('chat_message');
  });

  test('should have correct CREATE_OPENCODE_SESSION value', () => {
    expect(MessageTypes.CREATE_OPENCODE_SESSION).toBe('create_opencode_session');
  });

  test('should have correct OPENCODE_SESSION_CREATED value', () => {
    expect(MessageTypes.OPENCODE_SESSION_CREATED).toBe('opencode_session_created');
  });

  test('should have correct DELETE_OPENCODE_SESSION value', () => {
    expect(MessageTypes.DELETE_OPENCODE_SESSION).toBe('delete_opencode_session');
  });
});
