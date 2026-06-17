const { MessageType } = require('./types');
const { MessageHandler } = require('./message-handler');
const { RongCloudClient, ConversationType } = require('./rongcloud-client');
const { ensurePluginsAllow } = require('./openclaw-config');

function createRongCloudModule(config, sendFn, log, sendReadReceiptFn) {
  return new MessageHandler(config, sendFn, log, sendReadReceiptFn);
}

module.exports = {
  MessageType,
  MessageHandler,
  RongCloudClient,
  ConversationType,
  ensurePluginsAllow,
  createRongCloudModule
};