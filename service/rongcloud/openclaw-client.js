const { spawn, execSync } = require('child_process');
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

/**
 * 获取实际用户主目录（SYSTEM 账户下 os.homedir() 返回 systemprofile）
 */
function getRealHomeDir() {
  const envHome = process.env.CLAW_SERVICE_HOME || process.env.USERPROFILE || process.env.HOME;
  if (envHome && !envHome.includes('systemprofile')) {
    return envHome;
  }
  const homeDir = os.homedir();
  if (!homeDir.includes('systemprofile')) {
    return homeDir;
  }
  // SYSTEM 账户兜底：扫描 C:\Users 找包含 .openclaw 的实际用户目录
  const usersDir = 'C:\\Users';
  if (fs.existsSync(usersDir)) {
    const entries = fs.readdirSync(usersDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !['Public', 'Default', 'All Users', 'Default User'].includes(entry.name)) {
        const candidate = path.join(usersDir, entry.name);
        if (fs.existsSync(path.join(candidate, '.openclaw'))) {
          return candidate;
        }
      }
    }
  }
  return homeDir;
}

/**
 * 构建 OpenClaw 需要的完整环境变量
 * Windows SYSTEM 账户下必须设置 HOMEDRIVE/HOMEPATH/APPDATA 等
 * 策略：从现有环境变量中推断正确路径，避免硬编码任何用户名或目录结构
 */
function getOpenClawEnv(baseEnv = process.env) {
  const realHome = getRealHomeDir();
  const env = { ...baseEnv };
  const systemHome = os.homedir();

  // 基础 home 目录变量
  env.USERPROFILE = realHome;
  env.HOME = realHome;

  if (process.platform === 'win32') {
    // 从 realHome 推断 HOMEDRIVE / HOMEPATH（匹配盘符 + 路径）
    const match = realHome.match(/^([A-Za-z]:)(.*)$/);
    if (match) {
      env.HOMEDRIVE = match[1];
      env.HOMEPATH = match[2];
    }

    /**
     * 修复路径：把现有环境变量中的 systemprofile home 路径替换为真实用户 home 路径
     * 这样能处理 Roaming Profiles、AppData 重定向、非标准安装等各种情况
     */
    const fixPath = (originalPath) => {
      if (!originalPath) return null;
      const lowerOriginal = originalPath.toLowerCase();
      const lowerSystemHome = systemHome.toLowerCase();
      if (lowerOriginal.includes(lowerSystemHome)) {
        const idx = lowerOriginal.indexOf(lowerSystemHome);
        return originalPath.substring(0, idx) + realHome + originalPath.substring(idx + systemHome.length);
      }
      return null;
    };

    // APPDATA：优先从现有变量推断，保留原始目录结构
    if (baseEnv.APPDATA) {
      const fixed = fixPath(baseEnv.APPDATA);
      if (fixed) env.APPDATA = fixed;
    }
    // 兜底：按标准结构拼接（仅在无法推断时使用）
    if (!env.APPDATA) {
      env.APPDATA = path.join(realHome, 'AppData', 'Roaming');
    }

    // LOCALAPPDATA：同上
    if (baseEnv.LOCALAPPDATA) {
      const fixed = fixPath(baseEnv.LOCALAPPDATA);
      if (fixed) env.LOCALAPPDATA = fixed;
    }
    if (!env.LOCALAPPDATA) {
      env.LOCALAPPDATA = path.join(realHome, 'AppData', 'Local');
    }
  }

  return env;
}

/**
 * 尝试读取 OpenClaw 的 gateway token
 * openclaw agent 连接 gateway 需要认证，token 通常存储在配置文件中
 */
function getGatewayToken() {
  const homeDir = getRealHomeDir();
  const possibleFiles = [
    path.join(homeDir, '.openclaw', 'openclaw.json'),
    path.join(homeDir, '.openclaw', 'config.json'),
    path.join(homeDir, '.openclaw', 'tools.json'),
    path.join(homeDir, '.openclaw', 'settings.json'),
  ];

  for (const filePath of possibleFiles) {
    try {
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf-8');
        const config = JSON.parse(content);
        // 可能的 token 字段名（支持嵌套路径 gateway.auth.token）
        const token = config.gatewayToken
          || (config.gateway?.auth?.token)
          || config.token
          || config.apiKey
          || config.api_key
          || config.password;
        if (token) {
          return String(token);
        }
      }
    } catch {
      // 忽略读取/解析错误
    }
  }

  return null;
}

/**
 * 检测端口是否监听
 */
function checkPort(port) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(3000);
    sock.once('connect', () => {
      sock.destroy();
      resolve(true);
    });
    sock.once('error', () => {
      sock.destroy();
      resolve(false);
    });
    sock.once('timeout', () => {
      sock.destroy();
      resolve(false);
    });
    sock.connect(port, '127.0.0.1');
  });
}

/**
 * 确保 openclaw.json 中启用了 chatCompletions 端点
 * 在启动 gateway 前调用，避免 SSE 流式调用返回 404
 */
function ensureChatCompletionsConfig(log) {
  const realHome = getRealHomeDir();
  const openclawDir = path.join(realHome, '.openclaw');
  const configPath = path.join(openclawDir, 'openclaw.json');

  let settings = {};
  let existed = false;

  try {
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf-8');
      settings = JSON.parse(content);
      existed = true;
    }
  } catch (err) {
    log?.warn(`[OpenClawClient] 读取 openclaw.json 失败: ${err.message}`);
    settings = {};
  }

  const current = settings.gateway?.http?.endpoints?.chatCompletions?.enabled;
  if (current === true) {
    log?.info('[OpenClawClient] openclaw.json 中 chatCompletions 已启用');
    return;
  }

  if (!settings.gateway) settings.gateway = {};
  if (!settings.gateway.http) settings.gateway.http = {};
  if (!settings.gateway.http.endpoints) settings.gateway.http.endpoints = {};
  if (!settings.gateway.http.endpoints.chatCompletions) settings.gateway.http.endpoints.chatCompletions = {};
  settings.gateway.http.endpoints.chatCompletions.enabled = true;

  try {
    if (!fs.existsSync(openclawDir)) {
      fs.mkdirSync(openclawDir, { recursive: true });
    }
    fs.writeFileSync(configPath, JSON.stringify(settings, null, 2), 'utf-8');
    log?.info(`[OpenClawClient] 已自动在 openclaw.json 中启用 chatCompletions (${existed ? '更新' : '新建'})`);
  } catch (err) {
    log?.error(`[OpenClawClient] 写入 openclaw.json 失败: ${err.message}`);
  }
}

/**
 * 启动 OpenClaw gateway
 */
function startOpenClawGateway(log) {
  return new Promise((resolve) => {
    // 启动前自动修复配置
    ensureChatCompletionsConfig(log);

    log?.info('[OpenClawClient] 正在启动 OpenClaw gateway...');

    const child = spawn('openclaw', ['gateway'], {
      shell: true,
      windowsHide: true,
      detached: true,
      stdio: 'ignore',
      env: getOpenClawEnv(),
    });

    child.unref();

    // 等待 gateway 启动（最多 20 秒）
    let attempts = 0;
    const maxAttempts = 20;
    const interval = setInterval(async () => {
      attempts++;
      const gatewayRunning = await checkPort(18789);
      if (gatewayRunning) {
        clearInterval(interval);
        log?.info('[OpenClawClient] OpenClaw gateway 启动成功 (18789)');
        resolve(true);
      } else if (attempts >= maxAttempts) {
        clearInterval(interval);
        log?.warn('[OpenClawClient] OpenClaw gateway 启动超时');
        resolve(false);
      }
    }, 1000);

    child.on('error', (err) => {
      log?.error(`[OpenClawClient] 启动 gateway 失败: ${err.message}`);
      clearInterval(interval);
      resolve(false);
    });
  });
}

class OpenClawClient {
  // 全局并发限制：同时最多运行 N 个 openclaw agent 进程
  static maxConcurrency = 2;
  static runningCount = 0;
  static waitQueue = [];
  // Session 级串行锁：确保同一 session 不会并发 spawn 多个进程
  static sessionLocks = new Map();

  static async acquireSlot() {
    if (OpenClawClient.runningCount < OpenClawClient.maxConcurrency) {
      OpenClawClient.runningCount++;
      return;
    }
    return new Promise(resolve => OpenClawClient.waitQueue.push(resolve));
  }

  static releaseSlot() {
    OpenClawClient.runningCount--;
    if (OpenClawClient.waitQueue.length > 0) {
      const next = OpenClawClient.waitQueue.shift();
      OpenClawClient.runningCount++;
      next();
    }
  }

  constructor(log) {
    this.log = log;
    this.gatewayStarting = false;
    this.gatewayStarted = false;
  }

  /**
   * 确保 OpenClaw gateway 在运行
   */
  async ensureGatewayRunning() {
    // 每次调用都实际检查端口，避免 gateway 崩溃后缓存状态失效
    const gatewayRunning = await checkPort(18789);

    if (gatewayRunning) {
      this.log?.info('[OpenClawClient] OpenClaw gateway 已在运行 (18789)');
      this.gatewayStarted = true;
      return true;
    }

    this.gatewayStarted = false;

    // 避免并发启动
    if (this.gatewayStarting) {
      this.log?.info('[OpenClawClient] gateway 正在启动中，等待...');
      // 等待最多 25 秒
      for (let i = 0; i < 25; i++) {
        await new Promise(r => setTimeout(r, 1000));
        if (await checkPort(18789)) {
          this.gatewayStarted = true;
          return true;
        }
      }
      return false;
    }

    this.gatewayStarting = true;
    try {
      const started = await startOpenClawGateway(this.log);
      this.gatewayStarted = started;
      return started;
    } finally {
      this.gatewayStarting = false;
    }
  }

  async chat(message, fromUser) {
    if (!message || !message.trim()) {
      return '消息内容为空';
    }

    // 确保 OpenClaw gateway 已启动
    const gatewayReady = await this.ensureGatewayRunning();
    if (!gatewayReady) {
      this.log?.error('[OpenClawClient] OpenClaw gateway 未运行且启动失败');
      return 'OpenClaw gateway 启动失败，请检查 openclaw 是否正确安装';
    }

    this.log?.info(`[OpenClawClient] 准备发送消息到 OpenClaw，from=${fromUser}, message=${message.substring(0, 50)}`);

    // 直接走 CLI 调用（OpenClaw Gateway 未暴露兼容的 HTTP REST API）
    return this.chatViaCLI(message, fromUser);
  }

  /**
   * 流式调用 OpenClaw（SSE）
   * 调用 OpenClaw Gateway 的 /v1/chat/completions SSE 端点
   *
   * @param {string} message - 用户消息
   * @param {string} fromUser - 用户ID（用于session隔离）
   * @param {Function} onDelta - 每次收到内容块时的回调 (chunk: string) => void
   * @param {Function} onDone - 流结束时的回调 (fullText: string) => void
   * @param {Function} onError - 出错时的回调 (error: Error) => void
   * @returns {Promise<void>}
   */
  async chatStream(message, fromUser, onDelta, onDone, onError) {
    if (!message || !message.trim()) {
      onError?.(new Error('消息内容为空'));
      return;
    }

    const gatewayReady = await this.ensureGatewayRunning();
    if (!gatewayReady) {
      const err = new Error('OpenClaw gateway 启动失败');
      this.log?.error('[OpenClawClient] ' + err.message);
      onError?.(err);
      return;
    }

    this.log?.info(`[OpenClawClient] 准备 SSE 流式调用 OpenClaw，from=${fromUser}`);

    const gatewayToken = getGatewayToken();
    const sessionId = `clawmessenger-${fromUser}`;

    // 尝试多个可能的 SSE 端点，兼容不同版本 OpenClaw Gateway
    // 注意：多模态图片必须使用 /v1/responses 端点
    const endpoints = [
      'http://127.0.0.1:18789/v1/responses',
      'http://127.0.0.1:18789/v1/chat/completions'
    ];

    for (let i = 0; i < endpoints.length; i++) {
      const apiUrl = endpoints[i];
      try {
        await this._doChatStream(apiUrl, gatewayToken, sessionId, message, onDelta, onDone);
        return; // 成功则直接返回
      } catch (err) {
        const is404 = err.response?.status === 404;
        const isLast = i === endpoints.length - 1;

        if (is404 && !isLast) {
          this.log?.warn(`[OpenClawClient] SSE 端点 ${apiUrl} 返回 404，尝试备用端点`);
          continue;
        }

        if (is404 && isLast) {
          this.log?.error(`[OpenClawClient] 所有 SSE 端点均返回 404。OpenClaw responses 端点未启用。`);
          this.log?.error(`[OpenClawClient] 请检查 ~/.openclaw/openclaw.json 中是否包含:`);
          this.log?.error(`[OpenClawClient]   gateway.http.endpoints.responses.enabled = true`);
          this.log?.error(`[OpenClawClient] 修改后请重启 OpenClaw gateway: openclaw gateway`);
        } else {
          this.log?.error(`[OpenClawClient] SSE 请求失败: ${err.message}`);
          // 打印详细错误响应
          if (err.response) {
            this.log?.error(`[OpenClawClient] 错误状态码: ${err.response.status}`);
            // 安全地提取错误信息
            const errorData = err.response.data;
            if (typeof errorData === 'string') {
              this.log?.error(`[OpenClawClient] 错误响应: ${errorData}`);
            } else if (errorData && typeof errorData === 'object') {
              // 提取常见错误字段
              const errorMsg = errorData.error?.message || errorData.message || errorData.error || JSON.stringify(errorData);
              this.log?.error(`[OpenClawClient] 错误响应: ${errorMsg}`);
            }
          }
        }
        // 不再内部调用 onError，让错误通过 Promise reject 向上传播，便于调用方回退
        throw err;
      }
    }
  }

  async _downloadImageAsBase64(imageUrl) {
    try {
      this.log?.info(`[OpenClawClient] 下载图片: ${imageUrl}`);
      const response = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: 30000,
        maxContentLength: 10 * 1024 * 1024 // 10MB
      });
      
      const buffer = Buffer.from(response.data);
      const base64 = buffer.toString('base64');
      
      // 检测 MIME 类型
      const contentType = response.headers['content-type'] || 'image/jpeg';
      this.log?.info(`[OpenClawClient] 图片下载完成: ${imageUrl}, size=${buffer.length}, type=${contentType}`);
      
      // 返回对象，包含纯 base64 和 MIME 类型
      return {
        base64: base64,
        mediaType: contentType
      };
    } catch (err) {
      this.log?.error(`[OpenClawClient] 图片下载失败: ${imageUrl}, ${err.message}`);
      throw err;
    }
  }

  async _doChatStream(apiUrl, gatewayToken, sessionId, message, onDelta, onDone) {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream'
    };
    if (gatewayToken) {
      headers['Authorization'] = `Bearer ${gatewayToken}`;
    }

    // 检测消息是否包含图片 URL
    const imageUrlMatch = message.match(/\[图片\]\s*(https?:\/\/[^\s]+)/);
    let payload;
    
    // 判断使用哪个端点
    const isResponsesEndpoint = apiUrl.includes('/v1/responses');
    
    if (imageUrlMatch) {
      // 多模态格式：图片 + 文本
      const imageUrl = imageUrlMatch[1];
      const textContent = message.replace(/\[图片\]\s*https?:\/\/[^\s]+/, '').trim();
      
      try {
        // 下载图片并转换为 base64
        const imageData = await this._downloadImageAsBase64(imageUrl);
        
        if (isResponsesEndpoint) {
          // /v1/responses 端点格式（推荐，支持多模态）
          payload = {
            model: 'openclaw',
            input: [
              { type: 'input_text', text: textContent || '描述这张图片' },
              {
                type: 'input_image',
                source: {
                  type: 'base64',
                  media_type: imageData.mediaType,
                  data: imageData.base64  // 纯 base64，不带 data URI 前缀
                }
              }
            ],
            stream: true,
            max_tokens: 2048
          };
        } else {
          // /v1/chat/completions 端点格式（兼容旧版）
          payload = {
            model: 'openclaw',
            messages: [{
              role: 'user',
              content: [
                { type: 'text', text: textContent || '描述这张图片' },
                { type: 'image_url', image_url: { url: `data:${imageData.mediaType};base64,${imageData.base64}` } }
              ]
            }],
            stream: true,
            max_tokens: 2048
          };
        }
      } catch (err) {
        this.log?.warn(`[OpenClawClient] 图片处理失败，回退到文本模式: ${err.message}`);
        // 回退到纯文本模式
        payload = {
          model: 'openclaw',
          messages: [{ role: 'user', content: message }],
          stream: true,
          max_tokens: 2048
        };
      }
    } else {
      // 纯文本格式
      if (isResponsesEndpoint) {
        payload = {
          model: 'openclaw',
          input: [
            { type: 'input_text', text: message }
          ],
          stream: true,
          max_tokens: 2048
        };
      } else {
        payload = {
          model: 'openclaw',
          messages: [{ role: 'user', content: message }],
          stream: true,
          max_tokens: 2048
        };
      }
    }

    this.log?.info(`[OpenClawClient] SSE 请求 payload: ${JSON.stringify(payload)}`);

    let fullText = '';
    let buffer = '';
    let lastChunkData = null;
    let hasError = false;
    let errorMsg = '';

    const response = await axios.post(apiUrl, payload, {
      headers,
      responseType: 'stream',
      timeout: 600000 // 10 分钟
    });

    return new Promise((resolve, reject) => {
      response.data.on('data', async (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop(); // 保留未完整的最后一行

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;

          const dataStr = trimmed.slice(6).trim();
          if (dataStr === '[DONE]') continue;

          try {
            const data = JSON.parse(dataStr);
            lastChunkData = data;

            // 检测流式错误块
            if (data.error) {
              hasError = true;
              errorMsg = typeof data.error === 'string' ? data.error : (data.error.message || JSON.stringify(data.error));
              this.log?.error(`[OpenClawClient] SSE chunk error: ${errorMsg}`);
              continue;
            }

            // 尝试多个可能的内容字段，兼容不同版本 OpenClaw / 不同模型提供商
            let delta = null;
            const choice = data.choices?.[0];
            if (choice) {
              delta = choice.delta?.content
                ?? choice.message?.content
                ?? choice.text
                ?? choice.delta?.text
                ?? choice.delta?.reasoning_content
                ?? null;
            }
            if (delta === null || delta === undefined) {
              delta = data.content ?? data.delta ?? data.text ?? null;
            }

            if (typeof delta === 'string') {
              if (delta.length > 0) {
                fullText += delta;
                try {
                  await onDelta?.(delta);
                } catch (err) {
                  reject(err);
                  return;
                }
              }
              // 空字符串 delta 是合法的（无新内容块），静默跳过
            } else if (delta !== null && delta !== undefined) {
              this.log?.info(`[OpenClawClient] SSE 原始数据(delta非字符串): ${JSON.stringify(data).substring(0, 200)}`);
            } else {
              // 无可识别的 content 字段，仅当不包含 finish_reason 时才打印调试日志
              if (!data.choices?.[0]?.finish_reason) {
                this.log?.info(`[OpenClawClient] SSE 原始数据(无content): ${JSON.stringify(data).substring(0, 200)}`);
              }
            }
          } catch {
            // 忽略无法解析的 JSON 行
          }
        }
      });

      response.data.on('end', async () => {
        this.log?.info(`[OpenClawClient] SSE 流结束，总长度: ${fullText.length}`);

        if (hasError) {
          reject(new Error(`OpenClaw SSE 错误: ${errorMsg}`));
          return;
        }

        if (fullText.length === 0) {
          // 兜底：某些网关会在最后一个 chunk 的 message.content 中返回完整内容
          const lastContent = lastChunkData?.choices?.[0]?.message?.content;
          if (typeof lastContent === 'string' && lastContent.length > 0) {
            fullText = lastContent;
            this.log?.info(`[OpenClawClient] 从 last chunk message.content 提取内容，长度: ${fullText.length}`);
          }
        }

        if (fullText.length === 0) {
          reject(new Error('OpenClaw SSE 返回空内容，可能 LLM 网络异常或模型未配置'));
          return;
        }
        try {
          await onDone?.(fullText);
          resolve();
        } catch (err) {
          reject(err);
        }
      });

      response.data.on('error', (err) => {
        this.log?.error(`[OpenClawClient] SSE 流错误: ${err.message}`);
        reject(err);
      });
    });
  }

  async chatViaCLI(message, fromUser) {
    const sessionId = `clawmessenger-${fromUser}`;

    // 1. Session 级串行锁：同一用户的消息排队执行，避免多个进程竞争同一 session 文件
    const previousLock = OpenClawClient.sessionLocks.get(sessionId);
    let resolveLock;
    const currentLock = new Promise(r => { resolveLock = r; });
    OpenClawClient.sessionLocks.set(sessionId, currentLock);
    if (previousLock) {
      this.log?.info(`[OpenClawClient] session ${sessionId} 正在处理中，排队等待...`);
      await previousLock;
    }

    // 2. 全局并发槽位限制：所有实例共享，防止服务器资源耗尽
    await OpenClawClient.acquireSlot();
    this.log?.info(`[OpenClawClient] 获得执行槽位 (当前运行: ${OpenClawClient.runningCount}/${OpenClawClient.maxConcurrency})`);

    try {
      return await this._runAgentCLI(message, fromUser, sessionId);
    } finally {
      OpenClawClient.releaseSlot();
      this.log?.info(`[OpenClawClient] 释放执行槽位 (当前运行: ${OpenClawClient.runningCount}/${OpenClawClient.maxConcurrency})`);
      // 释放 session 锁
      resolveLock();
      if (OpenClawClient.sessionLocks.get(sessionId) === currentLock) {
        OpenClawClient.sessionLocks.delete(sessionId);
      }
    }
  }

  _runAgentCLI(message, fromUser, sessionId) {
    const escapedMessage = message
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\r\n/g, ' ')
      .replace(/\n/g, ' ')
      .replace(/\r/g, ' ');

    const realHome = getRealHomeDir();
    this.log?.info(`[OpenClawClient] 使用用户目录: ${realHome}`);

    // 尝试读取 gateway token，解决 SYSTEM 账户下认证问题
    const gatewayToken = getGatewayToken();
    if (gatewayToken) {
      this.log?.info('[OpenClawClient] 已读取到 gateway token');
    }

    const quoteArg = (s) => `"${s}"`;
    const cmdParts = ['openclaw', 'agent', '-m', quoteArg(escapedMessage), '--session-id', quoteArg(sessionId)];
    // 注意：openclaw agent CLI 不支持 --token 参数，token 通过环境变量传递
    const command = cmdParts.join(' ');

    this.log?.info(`[OpenClawClient] 执行: ${command}`);

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let killed = false;

      // 关键：不设置 OPENCLAW_GATEWAY_URL，避免触发 "gateway url override requires explicit credentials"
      // 让 openclaw agent 通过默认方式自动发现本地 gateway

      // 修复：如果父进程 cwd 已失效（如目录被删除/替换），先修复自身 cwd，避免子进程继承无效路径
      try {
        process.cwd();
      } catch (e) {
        if (e.code === 'ENOENT') {
          try { process.chdir(os.tmpdir()); } catch {}
        }
      }

      const env = getOpenClawEnv();
      // 将 gateway token 通过环境变量传递（openclaw agent 不支持 --token CLI 参数）
      if (gatewayToken) {
        env.OPENCLAW_API_KEY = gatewayToken;
        env.OPENCLAW_TOKEN = gatewayToken;
      }
      const child = spawn(command, {
        shell: true,
        windowsHide: true,
        env,
        cwd: os.tmpdir(),
      });

      this.log?.info(`[OpenClawClient] CLI 子进程 PID=${child.pid}`);

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        stderr += text;
        // 实时记录 stderr，方便调试卡死问题
        // 子进程退出时管道可能已断开，忽略 EPIPE 避免未捕获异常
        try {
          this.log?.info(`[OpenClawClient] CLI stderr: ${text.trim().substring(0, 300)}`);
        } catch {
          // 忽略日志写入失败
        }
      });

      // 超时兜底（30 分钟）
      const timeout = setTimeout(() => {
        killed = true;
        child.kill('SIGTERM');
        this.log?.error('[OpenClawClient] CLI 执行超时（30分钟），强制终止');
      }, 1800000);

      child.on('error', (err) => {
        clearTimeout(timeout);
        this.log?.error(`[OpenClawClient] CLI 子进程错误: ${err.message}`);
        if (err.code === 'ENOENT') {
          resolve('找不到 openclaw 命令');
        } else {
          resolve(`OpenClaw CLI 调用失败: ${err.message}`);
        }
      });

      child.on('close', (code) => {
        clearTimeout(timeout);

        if (killed) {
          resolve('OpenClaw 响应超时（30分钟），请检查 openclaw 服务状态');
          return;
        }

        this.log?.info(`[OpenClawClient] CLI 进程退出 code=${code}`);
        this.log?.info(`[OpenClawClient] stdout 长度: ${stdout.length}, stderr 长度: ${stderr.length}`);

        if (code !== 0) {
          const errOutput = stderr || stdout || '';
          this.log?.error(`[OpenClawClient] CLI 错误输出: ${errOutput.substring(0, 500)}`);
          resolve(`OpenClaw 调用失败: ${errOutput.substring(0, 200)}`);
          return;
        }

        const output = stdout || stderr || '';
        resolve(this.cleanOutput(output));
      });
    });
  }

  cleanOutput(output) {
    const lines = output.split('\n');
    const cleanLines = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // 移除 ANSI 颜色代码
      const cleanLine = trimmed.replace(/\x1B\[[0-9;]*m/g, '');

      // 跳过所有调试/配置日志行
      if (cleanLine.startsWith('[ws]')) continue;
      if (cleanLine.startsWith('[health-monitor]')) continue;
      if (cleanLine.startsWith('[OpenClawConfig]')) continue;
      if (cleanLine.startsWith('[plugins]')) continue;
      if (cleanLine.includes('龙虾信使插件已注册')) continue;
      if (cleanLine.includes('龙虾信使')) continue;
      if (cleanLine.includes('已加载配置文件')) continue;
      if (cleanLine.includes('plugins.allow')) continue;
      if (cleanLine.includes('Config warnings')) continue;
      if (cleanLine.includes('stale config')) continue;
      if (cleanLine.includes('plugin not found')) continue;
      if (cleanLine.includes('⇄ res')) continue;
      if (cleanLine.includes('chat.history')) continue;
      if (cleanLine.includes('models.list')) continue;
      if (cleanLine.includes('node.list')) continue;
      if (/^\d{2}:\d{2}:\d{2}/.test(cleanLine)) continue; // 时间戳开头的日志

      cleanLines.push(cleanLine);
    }

    return cleanLines.join('\n').trim() || 'OpenClaw 未返回有效响应';
  }
}

module.exports = { OpenClawClient };
