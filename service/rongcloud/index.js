const { MessageType } = require('./types');
const { MessageHandler } = require('./message-handler');
const { OpenClawClient } = require('./openclaw-client');
const { RongCloudClient, ConversationType } = require('./rongcloud-client');
const { ensurePluginsAllow } = require('./openclaw-config');

function createRongCloudModule(config, sendFn, log) {
  return new MessageHandler(config, sendFn, log);
}

module.exports = {
  MessageType,
  MessageHandler,
  OpenClawClient,
  RongCloudClient,
  ConversationType,
  ensurePluginsAllow,
  createRongCloudModule
};