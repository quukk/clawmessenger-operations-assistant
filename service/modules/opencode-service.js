/**
 * @deprecated 该模块使用旧的 OpenCode Gateway HTTP 调用模式，已被 Skill 框架中的
 * service/opencode/opencode-runner.js 取代。保留此文件仅用于紧急回滚。
 */
const axios = require('axios');

const GATEWAY_URL = 'http://127.0.0.1:4096';

// 系统提示词 - 虾说智能助手客服助手
const SYSTEM_PROMPT = `你是虾说智能助手的客服助手，专门帮助用户解答使用问题。

## 核心职责
1. **解答产品使用问题**：帮助用户了解如何使用虾说智能助手的各项功能
2. **故障排查**：协助用户解决常见的技术问题
3. **功能介绍**：介绍App的新功能和更新内容

## 常用功能说明

| 功能 | 说明 |
|------|------|
| 会话 | 与好友进行一对一或群聊 |
| 通讯录 | 管理好友和群组 |
| 聊天室 | 加入公开聊天室 |
| 远程管理 | 管理远程设备 |
| AI助手 | 使用AI辅助功能 |

## 回答原则
- 礼貌、专业、简洁
- 如果不知道答案，建议用户联系人工客服
- 不要透露系统内部信息
- 使用中文回答
- 不要对外透漏你是什么模型，不要说你是opencode，对外你就说你是 虾说智能助手；
`;

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
  
  // 首先尝试使用提供的 fallback session ID
  if (fallbackSessionId) {
    try {
      // 验证 session 是否存在（通过尝试获取 session 详情）
      const response = await axios.get(`${GATEWAY_URL}/session/${fallbackSessionId}`, { 
        timeout: 5000,
        validateStatus: (status) => status < 500 // 允许 404，只要不是服务器错误
      });
      if (response.status === 200) {
        console.log(`[CHAT-DEBUG] Fallback session exists: ${fallbackSessionId}`);
        return fallbackSessionId;
      } else {
        console.log(`[CHAT-DEBUG] Fallback session not found (status: ${response.status}): ${fallbackSessionId}`);
      }
    } catch (e) {
      console.log(`[CHAT-DEBUG] Fallback session check failed: ${e.message}`);
    }
  }
  
  // 如果 fallback 无效，创建新 session
  try {
    console.log(`[CHAT-DEBUG] Creating new session...`);
    const response = await axios.post(
      `${GATEWAY_URL}/session`,
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
    if (e.response) {
      console.log(`[CHAT-DEBUG] Create session response status: ${e.response.status}`);
      console.log(`[CHAT-DEBUG] Create session response data: ${JSON.stringify(e.response.data)}`);
    }
  }
  
  // 如果创建也失败，抛出错误
  throw new Error('无法获取或创建有效的 session ID');
}

async function ensureOpencodeRunning(log) {
  try {
    // 快速检查 4096 端口
    const healthResponse = await axios.get('http://127.0.0.1:4096/global/health', { timeout: 3000 });
    log('DEBUG', `OpenCode health check: ${JSON.stringify(healthResponse.data)}`);
    return true;
  } catch (e) {
    log('WARN', `OpenCode 服务未运行: ${e.message}，准备启动...`);
    
    const { exec } = require('child_process');
    
    // 使用 nohup 启动，脱离终端
    exec('nohup opencode serve --port 4096 --hostname 127.0.0.1 > /tmp/opencode.log 2>&1 &');
    
    // 等待 8 秒让服务启动
    await new Promise(resolve => setTimeout(resolve, 8000));
    
    // 再次检查
    try {
      const healthResponse = await axios.get('http://127.0.0.1:4096/global/health', { timeout: 3000 });
      log('DEBUG', `OpenCode health check after start: ${JSON.stringify(healthResponse.data)}`);
      log('INFO', 'OpenCode 服务已启动');
      return true;
    } catch (e) {
      log('ERROR', `OpenCode 服务启动失败: ${e.message}`);
      return false;
    }
  }
}

async function forwardChatMessage(sessionId, content, onDelta, logFn, timeoutMs = 600000, customSystemPrompt = null) {
  const log = (level, message) => {
    console.log(`[CHAT-DEBUG] ${level}: ${message}`);
    if (logFn) logFn(level, message);
  };

  // 确保 opencode 在运行
  const isRunning = await ensureOpencodeRunning(log);
  if (!isRunning) {
    throw new Error('OpenCode 服务无法启动，请检查环境');
  }

  log('DEBUG', `原始 sessionId: ${sessionId}`);
  const realSessionId = await getOrCreateGatewaySession(sessionId);
  log('DEBUG', `实际 sessionId: ${realSessionId}`);
  const url = `${GATEWAY_URL}/session/${realSessionId}/message`;
  log('DEBUG', `请求 URL: ${url}`);

  log('DEBUG', `系统提示词长度: ${SYSTEM_PROMPT.length} 字符`);
  log('DEBUG', `发送消息: ${content}`);
  log('DEBUG', `请求超时: ${timeoutMs}ms`);
  
  // 构建请求体，包含 system 和 model 参数
  // model 字段格式: { providerID: "provider-name", modelID: "model-id" }
  // 使用 opencode/big-pickle 模型（从 TUI 模式确认）
  const requestBody = {
    system: customSystemPrompt || SYSTEM_PROMPT,
    model: { providerID: 'opencode', modelID: 'big-pickle' },
    parts: [{ type: 'text', text: content }]
  };
  
  log('DEBUG', `请求体包含 system 参数: ${!!requestBody.system}`);
  
  try {
    log('DEBUG', `发送请求到: ${url}`);
    // 只记录请求体结构，避免 system 提示词过长截断其他字段
    const requestBodyForLog = {
      ...requestBody,
      system: `[${requestBody.system.length} 字符的系统提示词]`
    };
    log('DEBUG', `请求体结构: ${JSON.stringify(requestBodyForLog)}`);
    
    const response = await axios.post(url, requestBody, {
      headers: { 'Content-Type': 'application/json' },
      timeout: timeoutMs
    });

    const result = response.data || {};
    log('DEBUG', `响应状态: ${response.status}`);
    log('DEBUG', `响应数据类型: ${typeof result}`);
    log('DEBUG', `响应数据 keys: ${Object.keys(result).join(', ')}`);
    log('DEBUG', `响应数据: ${JSON.stringify(result).substring(0, 1000)}`);
    log('DEBUG', `响应 headers: ${JSON.stringify(response.headers)}`);

    const parts = result.parts || [];
    const info = result.info || {};

    let fullContent = '';

    for (const key of ['text', 'content', 'response', 'output', 'message', 'reply', 'answer']) {
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
      // 如果返回空内容，可能是异步处理，返回一个提示信息
      log('WARN', `Gateway 返回空内容, parts 数量: ${parts.length}, 返回默认响应`);
      fullContent = '消息已发送，正在处理中...';
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
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log('ERROR', `Gateway 请求异常: ${msg}`);
    
    // 检测是否是超时错误（Gateway 卡死）
    if (msg.includes('timeout') || msg.includes('ECONNABORTED') || msg.includes('ETIMEDOUT')) {
      log('WARN', 'Gateway 超时，准备使用 nohup 重启...');
      
      const { exec } = require('child_process');
      
      // 1. 杀掉现有进程
      exec('pkill -f "opencode serve"');
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      // 2. 使用 nohup 重新启动
      exec('nohup opencode serve --port 4096 --hostname 127.0.0.1 > /tmp/opencode.log 2>&1 &');
      await new Promise(resolve => setTimeout(resolve, 8000));
      
      throw new Error('OpenCode 服务已重启，请稍后重试');
    }
    
    throw error;
  }
}

module.exports = {
  createOpencodeSession,
  deleteOpencodeSession,
  getOrCreateGatewaySession,
  forwardChatMessage,
  SYSTEM_PROMPT
};
