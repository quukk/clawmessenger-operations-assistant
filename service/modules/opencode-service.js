const axios = require('axios');

const GATEWAY_URL = 'http://127.0.0.1:4096';

async function createOpencodeSession(title) {
  const response = await axios.post(`${GATEWAY_URL}/session`, { title }, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 10000
  });
  return response.data || {};
}

async function deleteOpencodeSession(sessionId) {
  try {
    await axios.delete(`${GATEWAY_URL}/session/${sessionId}`, { timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

async function getOrCreateGatewaySession(fallbackSessionId) {
  console.log(`[CHAT-DEBUG] getOrCreateGatewaySession called with fallback: ${fallbackSessionId}`);
  
  try {
    const response = await axios.get(`${GATEWAY_URL}/api/sessions`, { timeout: 5000 });
    const sessions = response.data;
    console.log(`[CHAT-DEBUG] Existing sessions: ${JSON.stringify(sessions)}`);
    if (Array.isArray(sessions) && sessions.length > 0) {
      const sessionId = sessions[0].id || sessions[0].session_id;
      if (sessionId) {
        console.log(`[CHAT-DEBUG] Using existing session: ${sessionId}`);
        return sessionId;
      }
    }
  } catch (e) {
    console.log(`[CHAT-DEBUG] Failed to get sessions: ${e.message}`);
  }

  try {
    const response = await axios.post(
      `${GATEWAY_URL}/api/sessions`,
      { title: 'Chat session' },
      { headers: { 'Content-Type': 'application/json' }, timeout: 5000 }
    );
    const newSessionId = response.data?.id || response.data?.session_id;
    console.log(`[CHAT-DEBUG] Created new session: ${newSessionId}`);
    if (newSessionId) {
      return newSessionId;
    }
  } catch (e) {
    console.log(`[CHAT-DEBUG] Failed to create session: ${e.message}`);
  }
  
  if (fallbackSessionId) {
    console.log(`[CHAT-DEBUG] Using fallback session: ${fallbackSessionId}`);
    return fallbackSessionId;
  }
  
  throw new Error('无法获取或创建有效的 session ID');
}

async function forwardChatMessage(sessionId, content, onDelta, logFn, timeoutMs = 600000) {
  const log = (level, message) => {
    console.log(`[CHAT-DEBUG] ${level}: ${message}`);
    if (logFn) logFn(level, message);
  };

  log('DEBUG', `原始 sessionId: ${sessionId}`);
  const realSessionId = await getOrCreateGatewaySession(sessionId);
  log('DEBUG', `实际 sessionId: ${realSessionId}`);
  const url = `${GATEWAY_URL}/session/${realSessionId}/message`;
  log('DEBUG', `请求 URL: ${url}`);

  log('DEBUG', `发送消息: ${content}`);
  log('DEBUG', `请求超时: ${timeoutMs}ms`);
  const response = await axios.post(url, {
    parts: [{ type: 'text', text: content }]
  }, {
    headers: { 'Content-Type': 'application/json' },
    timeout: timeoutMs
  });

  const result = response.data || {};
  log('DEBUG', `响应状态: ${response.status}`);
  log('DEBUG', `响应数据 keys: ${Object.keys(result).join(', ')}`);
  log('DEBUG', `响应数据: ${JSON.stringify(result).substring(0, 500)}`);

  const parts = result.parts || [];
  const info = result.info || {};

  let fullContent = '';

  for (const key of ['text', 'content', 'response', 'output', 'message', 'reply']) {
    const val = result[key];
    if (val && typeof val === 'string') {
      fullContent = val;
      log('DEBUG', `从顶层字段 ${key} 提取到内容`);
      break;
    }
  }

  if (!fullContent) {
    for (const part of parts) {
      const text = part.text || part.content || part.value || '';
      const partType = part.type || '';
      if (text && ['text', 'assistant', 'message', 'response', ''].includes(partType)) {
        fullContent += String(text);
      }
    }
    if (fullContent) log('DEBUG', `从 parts 中提取到内容, 长度: ${fullContent.length}`);
  }

  if (!fullContent) {
    for (const part of parts) {
      for (const key of ['text', 'content', 'value', 'output']) {
        const val = part[key];
        if (val && typeof val === 'string') {
          fullContent += val;
          break;
        }
      }
    }
    if (fullContent) log('DEBUG', `从所有 parts 兜底提取到内容, 长度: ${fullContent.length}`);
  }

  if (!fullContent) {
    const infoText = info.text || info.content || '';
    if (infoText) fullContent = infoText;
  }

  if (!fullContent) {
    log('ERROR', `Gateway 返回空内容, parts 数量: ${parts.length}`);
    throw new Error('Gateway 返回空内容');
  }

  log('DEBUG', `总内容长度: ${fullContent.length}, 开始模拟流式发送`);
  const chunkSize = 50;
  for (let i = 0; i < fullContent.length; i += chunkSize) {
    const chunk = fullContent.slice(i, i + chunkSize);
    await onDelta(chunk);
    // 仅在非测试环境添加延迟
    if (process.env.NODE_ENV !== 'test') {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  }
  log('DEBUG', '流式发送完成');

  return fullContent;
}

module.exports = {
  createOpencodeSession,
  deleteOpencodeSession,
  getOrCreateGatewaySession,
  forwardChatMessage
};
