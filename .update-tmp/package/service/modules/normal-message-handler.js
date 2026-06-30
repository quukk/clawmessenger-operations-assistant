/**
 * 普通消息处理器 - 接收 rongcloud 转发的普通消息并调用 AI 服务
 *
 * 被调用位置：rongcloud/message-handler.js
 * 调用方式：await this.handleNormalMessage(msg)
 *
 * @param {Object} msg - 消息对象
 * @param {string} msg.content - 消息内容
 * @param {string} msg.senderUserId - 发送者ID
 * @param {string} msg.targetId - 目标ID
 * @param {number} msg.conversationType - 会话类型 (1=私聊, 3=群聊)
 * @returns {string} 回复内容
 */
const { OpenClawClient } = require('../rongcloud/openclaw-client');
const axios = require('axios');
const { loadConfig } = require('./config');

const openclawClient = new OpenClawClient(console);
const config = loadConfig();

async function handleNormalMessage(msg) {
  console.log(`[NormalMessageHandler] 收到普通消息:`, {
    from: msg.senderUserId,
    content: msg.content?.substring(0, 50),
    type: msg.conversationType === 1 ? '私聊' : '群聊'
  });

  try {
    let content = msg.content;
    if (!content || !content.trim()) {
      return '消息内容为空';
    }

    // 语音消息：先进行语音识别
    if (msg.messageType === 'RC:HQVCMsg') {
      const voiceText = await recognizeVoice(msg);
      if (voiceText !== null) {
        content = `[语音转文字] ${voiceText}`;
      } else {
        content = `[语音消息，转文字失败] ${content}`;
      }
    }

    const reply = await openclawClient.chat(content, msg.senderUserId);
    console.log(`[NormalMessageHandler] AI 回复: ${reply.substring(0, 50)}...`);
    return reply;
  } catch (err) {
    console.error(`[NormalMessageHandler] 处理异常:`, err.message);
    return `抱歉，处理消息时出错: ${err.message}`;
  }
}

/**
 * 语音识别：调用后端百度语音 API
 */
async function recognizeVoice(msg) {
  try {
    let content = msg.content;
    if (typeof content === 'string' && content.startsWith('{')) {
      try {
        content = JSON.parse(content);
      } catch (e) {
        // 解析失败，保持原样
      }
    }

    const remoteUrl = content?.remoteUrl || content?.url || msg.remoteUrl || msg.url;
    if (!remoteUrl) {
      console.warn('[recognizeVoice] 语音消息缺少 remoteUrl，跳过识别');
      return null;
    }

    // 从 URL 提取扩展名并映射为百度支持的格式
    const urlPath = remoteUrl.split('?')[0];
    const ext = urlPath.split('.').pop()?.toLowerCase() || '';
    const fmtMap = { aac: 'm4a', ogg: 'mp3', oga: 'mp3', opus: 'mp3' };
    let format = fmtMap[ext] || ext;
    if (!['pcm', 'wav', 'amr', 'm4a', 'mp3'].includes(format)) {
      format = 'mp3';
    }

    // 采样率修正：amr 强制 8000，其余使用消息自带值兜底 16000
    let sampleRate = content?.sampleRate || msg.sampleRate || 16000;
    if (format === 'amr') sampleRate = 8000;

    const apiUrl = `${config.apiBaseUrl}/api/voice/recognize`;
    console.log(`[recognizeVoice] 调用语音识别 API: ${apiUrl}, format=${format}, sampleRate=${sampleRate}`);

    const response = await axios.post(apiUrl, {
      audioUrl: remoteUrl,
      format,
      sampleRate,
    }, { timeout: 30000 });

    if (response.data?.code === 200 && response.data?.data?.text !== undefined) {
      const text = response.data.data.text;
      console.log(`[recognizeVoice] 语音识别成功: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);
      return text;
    } else {
      console.warn(`[recognizeVoice] 语音识别失败: ${JSON.stringify(response.data)}`);
      return null;
    }
  } catch (err) {
    console.error(`[recognizeVoice] 语音识别异常: ${err.message}`);
    return null;
  }
}

module.exports = {
  handleNormalMessage
};
