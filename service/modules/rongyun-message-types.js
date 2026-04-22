/**
 * 融云交互消息类型枚举
 * 服务端和客户端必须保持完全一致
 * 服务端路径: src/enum/rongyun_message_type_enum.py
 * 桌面客户端路径: nodejs_client/src/main/enum/rongyunMessageTypeEnum.ts
 */
const RongyunMessageTypeEnum = {
  CLIENT_CONNECTED: "client_connected",
  CLIENT_DISCONNECTED: "client_disconnected",
  HEARTBEAT: "heartbeat",
  HEARTBEAT_ACK: "heartbeat_ack",
  DASHBOARD_REPORT: "dashboard_report",
  DASHBOARD_REPORT_ACK: "dashboard_report_ack",
  DASHBOARD_SESSIONS: "dashboard_sessions",
  DASHBOARD_JOBS: "dashboard_jobs",
  DASHBOARD_PROJECTS: "dashboard_projects",
  DASHBOARD_SUMMARIES: "dashboard_summaries",
  DASHBOARD_SESSIONS_CONTEXTS: "dashboard_sessions_contexts",
  DASHBOARD_USAGE_EVENTS: "dashboard_usage_events",
  COMMAND: "command",
  COMMAND_RESULT: "command_result",
  CHAT_MESSAGE: "chat_message",
  CREATE_OPENCODE_SESSION: "create_opencode_session",
  OPENCODE_SESSION_CREATED: "opencode_session_created",
  DELETE_OPENCODE_SESSION: "delete_opencode_session"
};

module.exports = { RongyunMessageTypeEnum };
