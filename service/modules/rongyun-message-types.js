/**
 * 融云交互消息类型枚举
 * 服务端和客户端必须保持完全一致
 */
const RongyunMessageTypeEnum = {
  CLIENT_CONNECTED: "client_connected",
  CLIENT_DISCONNECTED: "client_disconnected",
  HEARTBEAT: "heartbeat",
  HEARTBEAT_ACK: "heartbeat_ack",
  CHAT_MESSAGE: "chat_message",
  CREATE_OPENCODE_SESSION: "create_opencode_session",
  OPENCODE_SESSION_CREATED: "opencode_session_created",
  DELETE_OPENCODE_SESSION: "delete_opencode_session",
  DEVICE_STATUS_REQUEST: "device_status_request",
  DEVICE_STATUS_REPORT: "device_status_report",
  SERVICE_CHAT_MESSAGE: "service_chat_message",
  SERVICE_CHAT_RESPONSE: "service_chat_response",
  CREATE_SERVICE_SESSION: "create_service_session",
  SERVICE_SESSION_CREATED: "service_session_created"
};

module.exports = { RongyunMessageTypeEnum };
