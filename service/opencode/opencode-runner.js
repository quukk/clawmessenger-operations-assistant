/**
 * OpenCode Runner
 *
 * 通过 `opencode run` 子进程与 OpenCode 交互。
 * 参考 opencode-clawmessenger/src/core/ops-assistant.ts，翻译为纯 JavaScript。
 *
 * 特性：
 * - 按 chatId 持久化 session
 * - 单 chatId 队列串行化
 * - 超时后 SIGKILL 并返回部分结果
 * - 失败时清除 session 重试一次
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

class OpencodeRunner {
  /**
   * @param {Object} options
   * @param {string} options.directory - opencode 工作目录（含 .opencode/prompt.md）
   * @param {string} [options.opencodeUrl='http://127.0.0.1:19877'] --attach 地址
   * @param {number} [options.timeout=600000] - 单次调用超时（毫秒）
   * @param {string} [options.sessionFile] - session 持久化文件路径
   * @param {Object} [options.log] - 日志对象
   */
  constructor(options) {
    this.directory = options.directory || process.cwd();
    this.opencodeUrl = options.opencodeUrl || 'http://127.0.0.1:19877';
    this.timeout = options.timeout || 120000; // 默认 2 分钟，避免子进程无限运行
    this.sessionFile =
      options.sessionFile || path.join(os.homedir(), '.config', 'opencode', 'ops-assistant-sessions.json');
    this.log = options.log || console;

    this.sessions = new Map();
    this.activeProcesses = new Map();
    this.processQueue = new Map();

    this.systemPrompt = this._loadSystemPrompt();
    this._loadSessions();
  }

  _loadSystemPrompt() {
    const promptPath = path.join(this.directory, '.opencode', 'prompt.md');
    if (fs.existsSync(promptPath)) {
      try {
        const content = fs.readFileSync(promptPath, 'utf8');
        if (content.trim().length > 0) {
          this.log.info(`[OpencodeRunner] Loaded system prompt: ${promptPath} (${content.length} chars)`);
          return content.trim();
        }
      } catch (err) {
        this.log.warn(`[OpencodeRunner] Failed to load system prompt: ${err.message}`);
      }
    } else {
      this.log.warn(`[OpencodeRunner] System prompt not found: ${promptPath}`);
    }
    return null;
  }

  _loadSessions() {
    try {
      if (fs.existsSync(this.sessionFile)) {
        const data = JSON.parse(fs.readFileSync(this.sessionFile, 'utf8'));
        if (data.sessions && typeof data.sessions === 'object') {
          for (const [key, value] of Object.entries(data.sessions)) {
            this.sessions.set(key, value);
          }
        }
        this.log.info(`[OpencodeRunner] Loaded ${this.sessions.size} sessions from ${this.sessionFile}`);
      }
    } catch (err) {
      this.log.warn(`[OpencodeRunner] Failed to load sessions: ${err.message}`);
    }
  }

  _saveSessions() {
    try {
      const dir = path.dirname(this.sessionFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data = { sessions: Object.fromEntries(this.sessions) };
      fs.writeFileSync(this.sessionFile, JSON.stringify(data, null, 2));
    } catch (err) {
      this.log.warn(`[OpencodeRunner] Failed to save sessions: ${err.message}`);
    }
  }

  /**
   * 发送消息并获取回复
   *
   * @param {string} chatId - 会话标识（如 userId）
   * @param {string} message - 用户消息
   * @returns {Promise<string>}
   */
  async sendMessage(chatId, message, options = {}) {
    if (this.activeProcesses.get(chatId)) {
      this.log.info(`[OpencodeRunner] chatId=${chatId} busy, queuing message`);
      return new Promise((resolve, reject) => {
        if (!this.processQueue.has(chatId)) {
          this.processQueue.set(chatId, []);
        }

        const queue = this.processQueue.get(chatId);
        const timeoutId = setTimeout(() => {
          const idx = queue.findIndex((item) => item.resolve === resolve);
          if (idx > -1) queue.splice(idx, 1);
          reject(new Error('OpencodeRunner queue timeout'));
        }, 300000);

        const wrappedResolve = (value) => {
          clearTimeout(timeoutId);
          resolve(value);
        };
        const wrappedReject = (reason) => {
          clearTimeout(timeoutId);
          reject(reason);
        };

        queue.push({
          message,
          options,
          resolve: wrappedResolve,
          reject: wrappedReject,
        });
      });
    }

    return this._doSendMessage(chatId, message, false, options);
  }

  async _doSendMessage(chatId, message, isRetry = false, options = {}) {
    this.activeProcesses.set(chatId, true);

    try {
      const result = await this._executeOpencode(chatId, message, options);
      setImmediate(() => this._processQueue(chatId));
      return result;
    } catch (err) {
      this.log.warn(`[OpencodeRunner] chatId=${chatId} failed: ${err.message}, isRetry=${isRetry}`);

      if (!isRetry) {
        // 清除可能损坏的 session，重试一次
        this.log.info(`[OpencodeRunner] Clearing session and retrying for chatId=${chatId}`);
        this.sessions.delete(chatId);
        this._saveSessions();

        try {
          const result = await this._executeOpencode(chatId, message, options);
          setImmediate(() => this._processQueue(chatId));
          return result;
        } catch (retryErr) {
          setImmediate(() => this._processQueue(chatId));
          throw retryErr;
        }
      }

      setImmediate(() => this._processQueue(chatId));
      throw err;
    }
  }

  async _processQueue(chatId) {
    const queue = this.processQueue.get(chatId);
    if (!queue || queue.length === 0) {
      this.activeProcesses.delete(chatId);
      return;
    }

    const next = queue.shift();
    if (!next) {
      this.activeProcesses.delete(chatId);
      return;
    }

    try {
      const result = await this._executeOpencode(chatId, next.message, next.options);
      next.resolve(result);
    } catch (err) {
      next.reject(err);
    } finally {
      setImmediate(() => this._processQueue(chatId));
    }
  }

  _executeOpencode(chatId, message, options = {}) {
    return new Promise((resolve, reject) => {
      const session = this.sessions.get(chatId);
      const args = [
        'run',
        '--dir', this.directory,
        '--format', 'json',
        '--dangerously-skip-permissions',
        '--attach', this.opencodeUrl,
      ];

      if (session) {
        args.push('--session', session.id, '--continue');
        this.log.info(`[OpencodeRunner] chatId=${chatId} continuing session ${session.id}`);
      } else {
        this.log.info(`[OpencodeRunner] chatId=${chatId} starting new session`);
      }

      if (options.model) {
        args.push('-m', options.model);
        this.log.info(`[OpencodeRunner] chatId=${chatId} using model ${options.model}`);
      }

      const inputLines = [];
      if (this.systemPrompt) {
        inputLines.push('[系统指令]');
        inputLines.push(this.systemPrompt);
        inputLines.push('');
      }
      inputLines.push('[用户消息]');
      inputLines.push(message);
      const input = inputLines.join('\n');

      const texts = [];
      let currentSessionId = null;
      let stderr = '';
      let isCompleted = false;

      const isWindows = process.platform === 'win32';
      // Windows 上 opencode 安装为 opencode.cmd，且 worker PATH 可能不完整，使用 node 同级目录的绝对路径
      // 路径含空格，必须加引号
      const opencodeCmd = isWindows
        ? `"${path.join(path.dirname(process.execPath), 'opencode.cmd')}"`
        : 'opencode';
      this.log.info(`[OpencodeRunner] Spawning ${opencodeCmd} run for chatId=${chatId}`);

      const child = spawn(opencodeCmd, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
        shell: isWindows,
      });

      child.stdin.write(input);
      child.stdin.end();

      const timeoutId = setTimeout(() => {
        if (isCompleted) return;
        isCompleted = true;

        this.log.warn(`[OpencodeRunner] chatId=${chatId} timeout (${this.timeout}ms), killing process`);
        child.kill('SIGKILL');

        const response = texts.join('');
        if (response) {
          this.log.info(`[OpencodeRunner] Returning partial response (${response.length} chars)`);
          resolve(response);
        } else {
          reject(new Error('OpencodeRunner timeout'));
        }
      }, this.timeout);

      let apiError = null;

      child.stdout.on('data', (data) => {
        if (isCompleted) return;

        const lines = data.toString().split('\n').filter((l) => l.trim());
        for (const line of lines) {
          try {
            const event = JSON.parse(line);

            // 捕获 API 错误（如配额用完、认证失败等）
            if (event.type === 'error' && event.error) {
              const errMsg = event.error?.data?.message || event.error?.message || JSON.stringify(event.error);
              this.log.warn(`[OpencodeRunner] API error event: ${errMsg.substring(0, 200)}`);
              apiError = errMsg;
            }

            if (event.type === 'text' && event.part && event.part.text) {
              texts.push(event.part.text);
            }
            if (event.sessionID && !currentSessionId) {
              currentSessionId = event.sessionID;
            }
            if (event.session_id && !currentSessionId) {
              currentSessionId = event.session_id;
            }
          } catch {
            // ignore non-JSON lines
          }
        }
      });

      child.stderr.on('data', (data) => {
        if (isCompleted) return;
        const chunk = data.toString();
        stderr += chunk;
        // 调试：记录 stderr 输出
        if (chunk.trim()) {
          this.log.info(`[OpencodeRunner] stderr: ${chunk.trim().substring(0, 200)}`);
        }
      });

      child.on('close', (code) => {
        if (isCompleted) return;
        isCompleted = true;
        clearTimeout(timeoutId);

        if (currentSessionId) {
          this.sessions.set(chatId, { id: currentSessionId, lastUsed: Date.now() });
          this._saveSessions();
          this.log.info(`[OpencodeRunner] Session saved: ${currentSessionId} for chatId=${chatId}`);
        }

        if (code !== 0 && code !== null) {
          this.log.warn(`[OpencodeRunner] opencode exited with code ${code}: ${stderr.slice(0, 500)}`);
        }

        const response = texts.join('');
        if (response) {
          resolve(response);
        } else if (apiError) {
          // API 返回了错误事件（配额用完、认证失败等）
          reject(new Error(`OpenCode API 错误: ${apiError.substring(0, 150)}`));
        } else if (stderr) {
          reject(new Error(`OpencodeRunner failed: ${stderr.slice(0, 200)}`));
        } else {
          reject(new Error('OpencodeRunner returned empty response'));
        }
      });

      child.on('error', (err) => {
        if (isCompleted) return;
        isCompleted = true;
        clearTimeout(timeoutId);
        reject(new Error(`Failed to spawn opencode: ${err.message}`));
      });
    });
  }

  /**
   * 清除指定 chatId 的 session
   * @param {string} chatId
   */
  clearSession(chatId) {
    this.sessions.delete(chatId);
    this._saveSessions();
    this.log.info(`[OpencodeRunner] Session cleared for chatId=${chatId}`);
  }
}

module.exports = { OpencodeRunner };
