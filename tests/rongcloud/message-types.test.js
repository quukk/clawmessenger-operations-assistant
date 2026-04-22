const MessageTypes = require('../../service/rongcloud/message-types');

describe('MessageTypes', () => {
  test('should have exactly 18 message types', () => {
    expect(Object.keys(MessageTypes)).toHaveLength(18);
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

  test('should have correct DASHBOARD_REPORT value', () => {
    expect(MessageTypes.DASHBOARD_REPORT).toBe('dashboard_report');
  });

  test('should have correct DASHBOARD_REPORT_ACK value', () => {
    expect(MessageTypes.DASHBOARD_REPORT_ACK).toBe('dashboard_report_ack');
  });

  test('should have correct DASHBOARD_SESSIONS value', () => {
    expect(MessageTypes.DASHBOARD_SESSIONS).toBe('dashboard_sessions');
  });

  test('should have correct DASHBOARD_JOBS value', () => {
    expect(MessageTypes.DASHBOARD_JOBS).toBe('dashboard_jobs');
  });

  test('should have correct DASHBOARD_PROJECTS value', () => {
    expect(MessageTypes.DASHBOARD_PROJECTS).toBe('dashboard_projects');
  });

  test('should have correct DASHBOARD_SUMMARIES value', () => {
    expect(MessageTypes.DASHBOARD_SUMMARIES).toBe('dashboard_summaries');
  });

  test('should have correct DASHBOARD_SESSIONS_CONTEXTS value', () => {
    expect(MessageTypes.DASHBOARD_SESSIONS_CONTEXTS).toBe('dashboard_sessions_contexts');
  });

  test('should have correct DASHBOARD_USAGE_EVENTS value', () => {
    expect(MessageTypes.DASHBOARD_USAGE_EVENTS).toBe('dashboard_usage_events');
  });

  test('should have correct COMMAND value', () => {
    expect(MessageTypes.COMMAND).toBe('command');
  });

  test('should have correct COMMAND_RESULT value', () => {
    expect(MessageTypes.COMMAND_RESULT).toBe('command_result');
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
