const RongyunMessageTypeEnum = {
  CLIENT_CONNECTED: "client_connected",
  CLIENT_DISCONNECTED: "client_disconnected",
  HEARTBEAT: "heartbeat",
  HEARTBEAT_ACK: "heartbeat_ack",
  CHAT_MESSAGE: "chat_message",
  CREATE_OPENCODE_SESSION: "create_opencode_session",
  OPENCODE_SESSION_CREATED: "opencode_session_created",
  DELETE_OPENCODE_SESSION: "delete_opencode_session"
};

module.exports = { RongyunMessageTypeEnum };
