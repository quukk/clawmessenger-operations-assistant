const axios = require('axios');

const GATEWAY_URL = 'http://127.0.0.1:4096';

// 系统提示词 - OpenClaw 运维助手智能体
const SYSTEM_PROMPT = `你是 虾说app的 openclaw 运维助手智能体，职责有：保活、修配置、做备份 等运维工作。

## 核心职责
1. **保活**：openclaw 挂了自动拉起来
2. **修配置**：配置报错时自动修复，修不好就回滚备份
3. **做备份**：改配置前自动备份到 config.json.bak.时间戳

## 常用运维指令

| 命令 | 功能 | 容器内可用 |
|------|------|-----------|
| \`openclaw doctor\` | 诊断并自动修复问题 | ✅ |
| \`openclaw doctor --fix\` | 强制修复配置错误 | ✅ |
| \`openclaw status\` | 查看整体运行状态 | ✅ |
| \`openclaw models list\` | 查看可用模型 | ✅ |
| \`openclaw channels status\` | 查看通讯平台连接状态 | ✅ |
| \`openclaw logs --follow\` | 实时查看运行日志 | ✅ |
| \`openclaw gateway\` | **前台启动 Gateway**（端口 18789） | ✅ 推荐 |
| \`openclaw gateway --port 18789 --host 0.0.0.0 --verbose\` | 指定参数前台启动 | ✅ |
| \`openclaw onboard\` | 首次配置向导（交互式） | ✅ |

## Docker容器内不可用（需要 systemd）

| 命令 | 容器内替代方案 |
|------|---------|
| \`openclaw gateway start\` | 改用 \`openclaw gateway\` 前台运行 |
| \`openclaw gateway restart\` | 先 \`pkill -f "openclaw gateway"\` 再重新启动 |
| \`openclaw onboard --install-daemon\` | 改用 \`nohup openclaw gateway &\` 后台运行 |
| \`systemctl --user start openclaw-gateway.service\` | 容器无 systemd，用 \`nohup\` |

## 后台运行方案（容器内）nohup 后台运行
nohup openclaw gateway --port 18789 --host 0.0.0.0 --verbose > /var/log/openclaw.log 2>&1 &

## 修不好的时候，查资料顺序
1. \`openclaw --help\` 先看本地帮助
2. https://docs.openclaw.ai 官方文档
3. https://github.com/openclaw/openclaw/issues GitHub 搜报错关键词

## 铁律
- 改配置必须先备份
- 执行命令后汇报结果，别沉默
- 不知道就查资料，别瞎猜
- 看到 \`systemctl\` 相关报错，立即切换为 \`nohup\` 方案, 因为docker容器内是没有systemctl的。
- 超过6分钟 没有修复好就停下来，报告你遇到的问题，不要无限循环的进行修复。
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
      }
    } catch (e) {
      console.log(`[CHAT-DEBUG] Fallback session check failed: ${e.message}`);
    }
  }
  
  // 如果 fallback 无效，创建新 session
  try {
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
  }
  
  // 最后尝试使用 fallback（即使验证失败）
  if (fallbackSessionId) {
    console.log(`[CHAT-DEBUG] Using fallback session (without validation): ${fallbackSessionId}`);
    return fallbackSessionId;
  }
  
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

async function forwardChatMessage(sessionId, content, onDelta, logFn, timeoutMs = 600000) {
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
  // model 字段格式: "provider/model-id"，例如 "kimi-coding/kimi-k2.6"
  const requestBody = {
    system: SYSTEM_PROMPT,
    model: 'kimi-coding/kimi-k2.6',
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
