/**
 * 运维助手 Skill
 *
 * 负责处理运维相关消息，通过 opencode run 子进程调用 OpenCode。
 */
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const axios = require('axios');
const { BaseSkill } = require('../base-skill');
const { OpencodeRunner } = require('../../opencode/opencode-runner');
const { RongyunMessageTypeEnum } = require('../../modules/rongyun-message-types');

const execAsync = promisify(exec);

class OpsAssistantSkill extends BaseSkill {
  constructor(options) {
    super({
      ...options,
      displayName: options.displayName || '运维助手',
      priority: options.priority || 10,
    });

    this.runner = null;
    this.systemPrompt = null;

    // 用户模型偏好：userId -> model
    this.userModels = new Map();

    // 用户模型列表缓存：userId -> string[]
    this.userModelLists = new Map();

    // /models 命令执行锁：userId -> boolean，防止用户连续点击触发多次
    this._modelsCommandLocks = new Map();

    // 用户会话偏好：userId -> sessionId
    this.userSessions = new Map();

    // 用户会话列表缓存：userId -> Array<{id, title, updated}>
    this.userSessionLists = new Map();

    // 持久化用户偏好文件路径
    const homeDir = process.env.HOME || process.env.USERPROFILE || '.';
    this._prefsPath = path.join(homeDir, '.claw-bridge', 'user-preferences.json');
    try {
      if (fs.existsSync(this._prefsPath)) {
        const saved = JSON.parse(fs.readFileSync(this._prefsPath, 'utf8'));
        if (saved && saved.models) {
          Object.entries(saved.models).forEach(([uid, model]) => this.userModels.set(uid, model));
        }
        if (saved && saved.sessions) {
          Object.entries(saved.sessions).forEach(([uid, sid]) => this.userSessions.set(uid, sid));
        }
        this.log.info(`[OpsAssistant] 加载用户偏好: ${this.userModels.size} models, ${this.userSessions.size} sessions`);
      }
    } catch (e) { this.log.warn(`[OpsAssistant] 加载偏好失败: ${e.message}`); }

    // 流式消息发送队列：确保片段串行发送
    this._streamQueue = Promise.resolve();
    // 首流返回的 messageUID：streamId -> messageUID
    this._streamMessageUIDs = new Map();
  }

  async init() {
    const promptPath = path.join(__dirname, 'prompt.md');
    if (fs.existsSync(promptPath)) {
      try {
        this.systemPrompt = fs.readFileSync(promptPath, 'utf8').trim();
      } catch (err) {
        this.log.warn(`[OpsAssistant] Failed to load prompt.md: ${err.message}`);
      }
    }

    // 创建独立的 opencode 工作目录，使 prompt.md 可被 opencode CLI 读取
    const opencodeDir = path.join(__dirname, 'opencode-workdir');
    if (!fs.existsSync(opencodeDir)) {
      fs.mkdirSync(opencodeDir, { recursive: true });
    }
    // 将 prompt.md 同步到 opencode 工作目录
    const targetPromptPath = path.join(opencodeDir, '.opencode', 'prompt.md');
    const targetPromptDir = path.dirname(targetPromptPath);
    if (!fs.existsSync(targetPromptDir)) {
      fs.mkdirSync(targetPromptDir, { recursive: true });
    }
    try {
      fs.writeFileSync(targetPromptPath, this.systemPrompt || '');
    } catch (err) {
      this.log.warn(`[OpsAssistant] Failed to sync prompt.md to opencode dir: ${err.message}`);
    }

    const opencodeUrl = this.config.opencodeUrl || process.env.CLAW_OPENCODE_URL || 'http://127.0.0.1:4096';
    const timeout = this.config.opencodeTimeout || parseInt(process.env.CLAW_OPENCODE_TIMEOUT, 10) || 120000; // 默认 2 分钟

    this.runner = new OpencodeRunner({
      directory: opencodeDir,
      opencodeUrl,
      timeout,
      sessionFile: path.join(
        process.env.CLAW_OPS_SESSION_FILE || path.join(require('os').homedir(), '.config', 'opencode'),
        'ops-assistant-sessions.json'
      ),
      log: this.log,
    });

    this.log.info('[OpsAssistant] Initialized');
  }

  async destroy() {
    // OpencodeRunner 无长时间运行资源，无需额外清理
    this.log.info('[OpsAssistant] Destroyed');
  }

  getResponseMsgType() {
    return RongyunMessageTypeEnum.SERVICE_CHAT_RESPONSE;
  }

  /**
   * 判断当前消息是否应由运维助手处理
   */
  match(messageContext) {
    const { msgType, content, data } = messageContext;

    // 1. 精确 msg_type 匹配
    if (msgType === 'ops_chat_message' || msgType === RongyunMessageTypeEnum.SERVICE_CHAT_MESSAGE) {
      return { score: 100, reason: 'msg_type_match' };
    }

    // 2. 命令前缀匹配
    if (typeof content === 'string' && content.trim().startsWith('/ops')) {
      return { score: 90, reason: 'command_prefix' };
    }

    // 3. device-chat 场景（有 room_id）
    if (data && data.room_id) {
      return { score: 80, reason: 'device_chat' };
    }

    // 4. 关键词匹配
    const opsKeywords = [
      'openclaw', 'gateway', 'systemctl', 'docker', '日志', '报错',
      '修复', '重启', '状态', 'doctor', 'backup', '配置'
    ];
    if (typeof content === 'string' && opsKeywords.some((k) => content.toLowerCase().includes(k.toLowerCase()))) {
      return { score: 60, reason: 'keyword_match' };
    }

    return false;
  }

  /**
   * 处理消息
   */
  async handle(messageContext, matchResult) {
    const { senderUserId, targetId, conversationType, data } = messageContext;
    const requestId = data && data.request_id;

    // 提取用户消息内容
    let content = '';
    if (data && typeof data.content === 'string') {
      content = data.content;
    } else if (typeof messageContext.content === 'string') {
      content = messageContext.content;
    }

    this.log.info(`[OpsAssistant] Handling message from ${senderUserId}, match=${matchResult.reason || 'unknown'}, rawContentType=${typeof content}, rawContent=${JSON.stringify(content)}`);

    if (!content) {
      this.log.warn('[OpsAssistant] Empty message content, skipping');
      return;
    }

    this.log.info(`[OpsAssistant] 提取到消息内容: ${JSON.stringify(content.substring(0, 100))}`);

    const replyTarget = targetId || senderUserId;
    const convType = conversationType || 1;

    // 检测并执行快捷命令（直接执行 CLI，不走模型聊天）
    const trimmedContent = content.trim();
    this.log.info(`[OpsAssistant] 命令检测: trimmed=${JSON.stringify(trimmedContent)}, startsWithSlash=${trimmedContent.startsWith('/')}`);
    if (trimmedContent.startsWith('/')) {
      this.log.info(`[OpsAssistant] 检测到快捷命令: ${trimmedContent}`);
      try {
        await this._executeCommand(trimmedContent, replyTarget, convType, senderUserId);
      } catch (err) {
        this.log.error(`[OpsAssistant] 快捷命令执行失败: ${err.message}`);
        await this.sendText(replyTarget, `命令执行失败：${err.message}`, convType);
      }
      return;
    }

    // 语音消息：先进行语音识别
    if (data && data.voiceUrl) {
      const voiceText = await this._recognizeVoice(data.voiceUrl, data.voiceDuration);
      if (voiceText !== null) {
        content = `[语音转文字] ${voiceText}`;
      } else {
        content = `[语音消息，转文字失败] ${content}`;
      }
    }

    const cardId = `card-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    try {
      // 1. 发送初始流式卡片（与 openclaw-clawmessenger 对齐）
      await this.sendCard(replyTarget, {
        version: 3,
        card_id: cardId,
        template: 'ai_streaming',
        title: '运维助手',
        description: '正在思考...',
        actions: [
          {
            id: 'stop',
            label: '停止',
            action: 'stop_stream',
            style: 'danger',
            payload: { __card_id__: cardId },
          },
        ],
        metadata: {
          session_id: `ops-assistant-${senderUserId}`,
          is_streaming: true,
        },
      }, convType);

      // 2. 使用 senderUserId 作为 chatId，实现单用户会话隔离
      const chatId = `ops-${senderUserId}`;

      // 如果用户通过 /session-use 指定了会话，注入到 runner 使其复用历史
      const userSessionId = this.userSessions.get(senderUserId);
      if (userSessionId) {
        this.runner.sessions.set(chatId, { id: userSessionId, lastUsed: Date.now() });
        this.log.info(`[OpsAssistant] 注入用户会话 ${userSessionId} 到 runner chatId=${chatId}`);
      }

      const options = {};
      const preferredModel = this.userModels.get(senderUserId);
      if (preferredModel) options.model = preferredModel;
      const reply = await this.runner.sendMessage(chatId, content, options);

      // 3. 流式发送回复 + 最终卡片
      await this._sendStreamResponse(replyTarget, reply, requestId, convType, cardId, senderUserId);

      this.log.info(`[OpsAssistant] Reply sent to ${replyTarget}, length=${reply.length}`);
    } catch (err) {
      this.log.error(`[OpsAssistant] Failed to handle message: ${err.message}`);

      // 执行失败时发送错误卡片
      await this.sendCard(replyTarget, {
        version: 3,
        card_id: cardId,
        template: 'ai_streaming',
        title: '运维助手',
        description: `执行失败：${err.message}`,
        state: {
          status: 'error',
          result: `执行失败：${err.message}`,
        },
        actions: [],
        metadata: {
          session_id: `ops-assistant-${senderUserId}`,
          is_streaming: false,
        },
      }, convType);
    }
  }

  /**
   * 语音识别
   */
  async _recognizeVoice(voiceUrl, voiceDuration) {
    try {
      if (!voiceUrl) {
        this.log.warn('[OpsAssistant] 语音 URL 为空，跳过识别');
        return null;
      }

      // 从 URL 提取扩展名并映射为百度支持的格式
      const urlPath = voiceUrl.split('?')[0];
      const ext = urlPath.split('.').pop()?.toLowerCase() || '';
      const fmtMap = { aac: 'm4a', ogg: 'mp3', oga: 'mp3', opus: 'mp3' };
      let format = fmtMap[ext] || ext;
      if (!['pcm', 'wav', 'amr', 'm4a', 'mp3'].includes(format)) {
        format = 'mp3';
      }

      // 采样率修正：amr 强制 8000，其余兜底 16000
      let sampleRate = 16000;
      if (format === 'amr') sampleRate = 8000;

      const apiUrl = `${this.config.apiBaseUrl}/api/voice/recognize`;
      this.log.info(`[OpsAssistant] 调用语音识别 API: ${apiUrl}, format=${format}, sampleRate=${sampleRate}`);

      const response = await axios.post(apiUrl, {
        audioUrl: voiceUrl,
        format,
        sampleRate,
      }, { timeout: 30000 });

      if (response.data?.code === 200 && response.data?.data?.text !== undefined) {
        const text = response.data.data.text;
        this.log.info(`[OpsAssistant] 语音识别成功: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);
        return text;
      } else {
        this.log.warn(`[OpsAssistant] 语音识别失败: ${JSON.stringify(response.data)}`);
        return null;
      }
    } catch (err) {
      this.log.error(`[OpsAssistant] 语音识别异常: ${err.message}`);
      return null;
    }
  }

  /**
   * 流式发送完整回复
   */
  async _sendStreamResponse(targetId, fullResponse, requestId, convType, cardId, senderUserId) {
    const accountId = this.config.accountId || '';
    const streamId = `stream-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    let seq = 0;
    let hasSentChunk = false;
    const chunkSize = 50;

    // 1. 按 chunkSize 切片流式发送
    for (let i = 0; i < fullResponse.length; i += chunkSize) {
      const chunk = fullResponse.slice(i, i + chunkSize);
      seq += 1;
      const isFirstChunk = seq === 1;
      await this._sendStreamChunk(targetId, chunk, streamId, isFirstChunk, false, seq);
      hasSentChunk = true;
    }

    // 2. 发送尾流标记
    if (hasSentChunk) {
      seq += 1;
      await this._sendStreamChunk(targetId, '', streamId, false, true, seq);
    }

    // 3. 发送最终持久化卡片（与 openclaw-clawmessenger 对齐）
    try {
      await this.sendCard(targetId, {
        version: 3,
        card_id: cardId,
        template: 'ai_streaming',
        title: '运维助手',
        description: fullResponse,
        state: {
          status: 'completed',
          result: fullResponse,
          completed_at: Date.now(),
        },
        actions: [],
        metadata: {
          session_id: `ops-assistant-${senderUserId}`,
          is_streaming: false,
        },
      }, convType);
    } catch (cardErr) {
      this.log.warn(`[OpsAssistant] 发送最终卡片失败: ${cardErr.message}`);
    }

    // 4. 同时发送完整的 command 消息作为历史记录（兼容旧前端）
    await this.sendReply(targetId, {
      status: 'success',
      message: 'Response received',
      content: fullResponse,
      request_id: requestId,
      node_id: accountId,
    }, requestId);
  }

  /**
   * 发送单个流式消息片段
   */
  async _sendStreamChunk(targetId, content, streamId, isFirstChunk, isLastChunk, seq) {
    if (!this.messageSender) {
      this.log.warn('[OpsAssistant] messageSender not injected, skip stream chunk');
      return;
    }

    // 使用队列确保流式消息片段串行发送
    this._streamQueue = this._streamQueue.then(async () => {
      try {
        const messageUID = this._streamMessageUIDs.get(streamId);
        const result = await this.messageSender.sendStreamToTarget({
          targetId,
          content,
          streamId,
          seq,
          isFirstChunk,
          isLastChunk,
          messageUID,
        });

        // 首流时存储 messageUID
        if (isFirstChunk && result && result.messageUID) {
          this._streamMessageUIDs.set(streamId, result.messageUID);
          this.log.info(`[OpsAssistant] 首流 messageUID 已存储: ${result.messageUID}, streamId=${streamId}`);
        }
      } catch (err) {
        this.log.warn(`[OpsAssistant] 发送流式消息失败: ${err.message}, seq=${seq}`);
      }
    });

    await this._streamQueue;
  }

  /**
   * 执行快捷命令（直接调用 CLI，不走模型聊天）
   * @param {string} commandText - 用户发送的命令文本，如 /models
   * @param {string} targetId - 回复目标
   * @param {number} convType - 会话类型
   * @param {string} senderUserId - 发送者用户ID
   */
  async _executeCommand(commandText, targetId, convType, senderUserId) {
    // 命令映射表：前端 toolbar 中的命令 -> 实际执行的 CLI 命令
    // 与 clawmessenger-uniapp RCUIKit 底部命令面板保持一致
    const commandMap = {
      '/opencode': { cmd: 'opencode --help', desc: 'opencode 帮助' },
      '/run': { cmd: 'opencode run --help', desc: 'run 命令帮助' },
      '/attach': { cmd: 'opencode attach --help', desc: 'attach 命令帮助' },
      '/models': { desc: '可用模型列表', handler: async () => this._sendModelsCard(targetId, convType, senderUserId) },
      '/models-page': {
        desc: '模型列表（已弃用分页，等同于 /models）',
        handler: async () => this._sendModelsCard(targetId, convType, senderUserId),
      },
      '/models-search': {
        desc: '搜索模型',
        handler: async () => {
          const keyword = commandText.replace('/models-search', '').trim().toLowerCase();
          if (!keyword) {
            return '请输入搜索关键词，例如 /models-search kimi';
          }
          const allModels = this.userModelLists.get(senderUserId);
          if (!allModels) {
            return '模型列表未缓存，请重新发送 /models';
          }
          const matched = allModels.filter((m) => m.toLowerCase().includes(keyword));
          return this._sendModelsSearchResults(targetId, convType, senderUserId, keyword, matched);
        },
      },
      '/providers': { desc: '提供商管理', handler: async () => this._sendProvidersCard(targetId, convType, senderUserId) },
      '/providers-login': {
        desc: '登录提供商',
        handler: async () => {
          const name = commandText.replace(/^\/providers-login\s*/, '').trim();
          if (!name) return '请指定提供商名称，例如 /providers-login opencode';
          return this._handleProvidersLogin(targetId, convType, senderUserId, name);
        },
      },
      '/providers-logout': {
        desc: '登出提供商',
        handler: async () => {
          const name = commandText.replace(/^\/providers-logout\s*/, '').trim();
          if (!name) return '请指定提供商名称，例如 /providers-logout opencode';
          return this._handleProvidersLogout(targetId, convType, senderUserId, name);
        },
      },
      '/agent': { cmd: 'opencode agent --help', desc: 'agent 命令帮助' },
      '/session': { desc: '会话管理', handler: async () => this._sendSessionCard(targetId, convType, senderUserId) },
      '/session-search': {
        desc: '搜索会话',
        handler: async () => {
          const keyword = commandText.replace('/session-search', '').trim().toLowerCase();
          if (!keyword) {
            return '请输入搜索关键词，例如 /session-search xxx';
          }
          const allSessions = this.userSessionLists.get(senderUserId);
          if (!allSessions) {
            return '会话列表未缓存，请重新发送 /session';
          }
          const matched = allSessions.filter((s) =>
            s.title.toLowerCase().includes(keyword) ||
            s.id.toLowerCase().includes(keyword)
          );
          return this._sendSessionSearchResults(targetId, convType, senderUserId, keyword, matched);
        },
      },
      '/new': {
        desc: '新建空白会话',
        handler: async () => {
          this.userSessions.delete(senderUserId);
          await this._savePreferences();
          return '新会话已创建。下一次对话将使用全新的空白上下文，不会加载之前的聊天历史。';
        },
      },
      '/session-use': {
        desc: '切换活跃会话',
        handler: async () => {
          const sessionId = commandText.replace(/^\/session-use\s*/, '').trim();
          if (!sessionId) return '用法: /session-use <sessionId>';
          this.userSessions.set(senderUserId, sessionId);
          await this._savePreferences();
          return `已切换到会话 ${sessionId}，后续对话将使用此会话。`;
        },
      },
      '/session-delete': {
        desc: '删除会话',
        handler: async () => {
          const sessionId = commandText.replace(/^\/session-delete\s*/, '').trim();
          if (!sessionId) return '请指定会话 ID，例如 /session-delete abc123';
          return this._handleSessionDelete(targetId, convType, senderUserId, sessionId);
        },
      },
      '/mcp': {
        desc: 'MCP 管理',
        handler: async () => {
          const args = commandText.replace(/^\/mcp\s*/, '').trim();
          if (args) {
            // 带子命令：执行并返回卡片
            let output = '';
            let success = true;
            try {
              const { stdout, stderr } = await execAsync(`opencode mcp ${args}`, {
                timeout: 30000,
                encoding: 'utf8',
                cwd: path.join(__dirname, 'opencode-workdir'),
              });
              output = stdout || stderr || '（无输出）';
            } catch (err) {
              output = err.stdout || err.stderr || err.message;
              success = !!err.stdout || !!err.stderr;
            }
            // 去除 ANSI 转义码
            output = output.replace(/\x1b\[[0-9;]*m/g, '');
            await this.sendCard(targetId, {
              version: 3,
              card_id: `card-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
              template: 'ai_streaming',
              title: `MCP ${args}`,
              description: output.length > 3000 ? output.substring(0, 3000) + '\n\n---\n*输出已截断*' : output,
              actions: [
                { id: 'mcp-back', label: '← 返回管理', action: 'send_text', payload: { text: '/mcp' } },
              ],
              metadata: { session_id: `ops-assistant-${senderUserId}`, is_streaming: false },
            }, convType);
            return undefined; // card already sent
          }
          // 无子命令：显示管理卡片
          await this._sendMcpCard(targetId, convType, senderUserId);
          return undefined; // card already sent
        },
      },
      '/acp': { cmd: 'opencode acp --help', desc: 'acp 命令帮助' },
      '/serve': { cmd: 'opencode serve --help', desc: 'serve 命令帮助' },
      '/web': { cmd: 'opencode web --help', desc: 'web 命令帮助' },
      '/debug': { cmd: 'opencode debug --help', desc: 'debug 命令帮助' },
      '/db': { cmd: 'opencode db --help', desc: 'db 命令帮助' },
      '/github': { cmd: 'opencode github --help', desc: 'github 命令帮助' },
      '/pr': { cmd: 'opencode pr --help', desc: 'pr 命令帮助' },
      '/export': { cmd: 'opencode export --help', desc: 'export 命令帮助' },
      '/import': { cmd: 'opencode import --help', desc: 'import 命令帮助' },
      '/upgrade': { cmd: 'opencode upgrade --help', desc: 'upgrade 命令帮助' },
      '/uninstall': { cmd: 'opencode uninstall --help', desc: 'uninstall 命令帮助' },
      '/completion': { cmd: 'opencode completion --help', desc: 'completion 命令帮助' },
      '/plugin': { cmd: 'opencode plugin --help', desc: 'plugin 命令帮助' },
      '/help': { cmd: 'opencode --help', desc: '帮助信息' },
      '/status': { cmd: 'opencode stats', desc: '运行状态' },
      '/logs': { cmd: 'opencode stats', desc: '统计信息' },
      '/info': { cmd: 'opencode stats', desc: '系统信息' },
      '/use-model': {
        desc: '切换模型',
        handler: async () => {
          const model = commandText.replace('/use-model ', '').trim();
          if (!model) {
            return '请指定模型，例如 /use-model opencode/gpt-5';
          }
          this.userModels.set(senderUserId, model);
          await this._savePreferences();
          return `已切换模型至 ${model}，后续对话将使用该模型。`;
        },
      },
      '/restart': { cmd: null, desc: '重启服务', handler: () => this._restartService() },
    };

    // 支持带参数的命令，如 /use-model <model>、/models-page 1
    const baseCommand = commandText.split(/\s+/)[0];
    const commandConfig = commandMap[baseCommand];
    if (!commandConfig) {
      await this.sendText(targetId, `未知命令：${commandText}`, convType);
      return;
    }

    this.log.info(`[OpsAssistant] 执行命令: ${commandText} (base=${baseCommand}) -> ${commandConfig.cmd || '自定义处理'}`);

    // 自定义处理（如重启、模型列表）
    if (commandConfig.handler) {
      const result = await commandConfig.handler();
      if (result !== undefined && result !== null) {
        await this.sendText(targetId, result, convType);
      }
      return;
    }

    // 执行 CLI 命令
    this.log.info(`[OpsAssistant] 开始执行 CLI: ${commandConfig.cmd}`);
    const { stdout, stderr } = await execAsync(commandConfig.cmd, {
      timeout: 30000,
      encoding: 'utf8',
      cwd: path.join(__dirname, 'opencode-workdir'),
    });

    const output = stdout || stderr || '（无输出）';
    this.log.info(`[OpsAssistant] CLI 输出长度: ${output.length}`);
    // 截断过长的输出
    const maxLength = 2000;
    const finalOutput = output.length > maxLength
      ? output.substring(0, maxLength) + '\n\n...（输出已截断）'
      : output;

    await this.sendText(targetId, `【${commandConfig.desc}】\n${finalOutput}`, convType);
  }

  /**
   * 发送可用模型交互式卡片
   */
  async _sendModelsCard(targetId, convType, senderUserId) {
    // 防止用户连续点击 /models 触发多次执行
    if (this._modelsCommandLocks.get(senderUserId)) {
      this.log.info(`[OpsAssistant] /models 命令正在执行中，忽略重复请求: user=${senderUserId}`);
      return;
    }
    this._modelsCommandLocks.set(senderUserId, true);

    try {
      await this._doSendModelsCard(targetId, convType, senderUserId);
    } finally {
      this._modelsCommandLocks.set(senderUserId, false);
    }
  }

  async _doSendModelsCard(targetId, convType, senderUserId) {
    this.log.info('[OpsAssistant] 开始执行 CLI: opencode models --refresh');
    let stdout = '';
    let stderr = '';
    try {
      const result = await execAsync('opencode models --refresh', {
        timeout: 60000,
        encoding: 'utf8',
        cwd: path.join(__dirname, 'opencode-workdir'),
      });
      stdout = result.stdout || '';
      stderr = result.stderr || '';
    } catch (execErr) {
      this.log.warn(`[OpsAssistant] opencode models 退出码非零: ${execErr.message}`);
      stdout = execErr.stdout || '';
      stderr = execErr.stderr || '';
    }

    const output = stdout || stderr || '';
    this.log.info(`[OpsAssistant] opencode models 原始输出长度: ${output.length}`);
    const allModels = output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && line.includes('/'));

    // 缓存完整模型列表并发送第一页
    this.userModelLists.set(senderUserId, allModels);
    return this._sendModelsPage(targetId, convType, senderUserId);
  }

  /**
   * 发送模型列表卡片（全部模型，不再分页）
   */
  async _sendModelsPage(targetId, convType, senderUserId) {
    const allModels = this.userModelLists.get(senderUserId);

    if (!allModels) {
      await this.sendText(targetId, '模型列表未缓存，请重新发送 /models', convType);
      return;
    }

    const currentModel = this.userModels.get(senderUserId) || '';

    // RongCloud 自定义消息上限 ~32KB，321 个模型全量 ~47KB 超限
    // 截断到 50 个（~7KB），剩余通过搜索 /models-search 获取
    const MAX_ACTIONS = 50;
    const displayModels = allModels.slice(0, MAX_ACTIONS);
    const remaining = allModels.length - MAX_ACTIONS;
    const actions = displayModels.map((model, index) => ({
      id: `m${index}`,
      label: model,
      action: 'send_text',
      payload: { text: `/use-model ${model}` },
    }));

    let desc = `当前模型：${currentModel || '未选择'} | 默认: opencode`;
    if (remaining > 0) {
      desc += ` | 共${allModels.length}个模型，已显示${MAX_ACTIONS}个，搜索查看更多`;
    }

    const cardData = {
      version: 3,
      card_id: `card-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      template: 'ai_streaming',
      title: `可用模型列表 (共 ${allModels.length} 个)`,
      description: desc,
      actions,
      metadata: {
        session_id: `ops-assistant-${senderUserId}`,
        is_streaming: false,
        is_model_list: true,
        current_model: currentModel,
      },
    };

    await this.sendCard(targetId, cardData, convType);
  }

  /**
   * 持久化保存用户偏好（模型 + 会话）到 JSON 文件
   */
  async _savePreferences() {
    try {
      const dir = path.dirname(this._prefsPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const models = {};
      this.userModels.forEach((v, k) => { models[k] = v; });
      const sessions = {};
      this.userSessions.forEach((v, k) => { sessions[k] = v; });
      fs.writeFileSync(this._prefsPath, JSON.stringify({ models, sessions }, null, 2), 'utf8');
    } catch (e) { this.log.warn(`[OpsAssistant] 保存偏好失败: ${e.message}`); }
  }

  /**
   * 发送模型搜索结果卡片
   */
  async _sendModelsSearchResults(targetId, convType, senderUserId, keyword, models) {
    const limitedModels = models.slice(0, 50);
    const currentModel = this.userModels.get(senderUserId) || '';

    const cardData = {
      version: 3,
      card_id: `card-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      template: 'ai_streaming',
      title: '模型搜索结果',
      description: `当前模型：${currentModel || '未选择'} | 搜索 "${keyword}" 找到 ${models.length} 个模型`,
      actions: limitedModels.map((model, index) => ({
        id: `model-${index}`,
        label: model,
        action: 'send_text',
        payload: { text: `/use-model ${model}` },
      })),
      metadata: {
        session_id: `ops-assistant-${senderUserId}`,
        is_streaming: false,
        is_model_list: true,
        is_model_search: true,
        current_model: currentModel,
      },
    };

    await this.sendCard(targetId, cardData, convType);
  }

  /**
   * 发送 MCP 管理交互式卡片
   */
  async _sendMcpCard(targetId, convType, senderUserId) {
    const cardData = {
      version: 3,
      card_id: `card-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      template: 'ai_streaming',
      title: 'MCP 管理',
      description: '管理 Model Context Protocol 服务器',
      actions: [
        { id: 'mcp-list', label: '列表', action: 'send_text', payload: { text: '/mcp list' } },
      ],
      metadata: {
        session_id: `ops-assistant-${senderUserId}`,
        is_streaming: false,
      },
    };

    await this.sendCard(targetId, cardData, convType);
  }

  /**
   * 发送会话管理交互式卡片
   */
  async _sendSessionCard(targetId, convType, senderUserId) {
    this.log.info('[OpsAssistant] 开始执行 CLI: opencode session list');
    let output = '';
    try {
      const result = await execAsync('opencode session list', {
        timeout: 30000,
        encoding: 'utf8',
        cwd: path.join(__dirname, 'opencode-workdir'),
      });
      output = result.stdout || result.stderr || '';
    } catch (execErr) {
      this.log.warn(`[OpsAssistant] opencode session list 失败: ${execErr.message}`);
      output = execErr.stdout || execErr.stderr || '';
    }

    // 去除 ANSI 转义码
    output = output.replace(/\x1b\[[0-9;]*m/g, '');

    // 解析表格行：Session ID (32 字符 ses_xxx) | Title | Updated
    const sessions = [];
    const lines = output.split('\n').map((l) => l.trimEnd()).filter(Boolean);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // 跳过表头和分隔线
      if (/^(─+|═+|=+)/.test(trimmed)) continue;
      if (/^Session ID/i.test(trimmed)) continue;
      // 用 2+ 空格或制表符分割列
      const parts = trimmed.split(/\s{2,}|\t/).map((s) => s.trim()).filter(Boolean);
      if (parts.length < 1) continue;
      const sid = parts[0];
      // Session ID 必须是 ses_ 开头的 32 字符格式
      if (!/^ses_[a-zA-Z0-9]{20,}$/.test(sid)) continue;
      const title = parts[1] || '(无标题)';
      const updated = parts[2] || '';
      sessions.push({ id: sid, title, updated });
    }

    // 缓存完整 session 列表供搜索使用
    this.userSessionLists.set(senderUserId, sessions);

    if (sessions.length === 0) {
      await this.sendText(targetId, '暂无会话记录。使用对话功能后将自动创建会话。', convType);
      return;
    }

    // 限制数量避免卡片过大（与 models 一致）
    const MAX_SESSIONS = 50;
    const displaySessions = sessions.slice(0, MAX_SESSIONS);
    const currentSessionId = this.userSessions.get(senderUserId) || '';
    const currentSession = currentSessionId
      ? displaySessions.find((s) => s.id === currentSessionId)
      : null;
    const currentSessionTitle = currentSession ? currentSession.title : '';

    // 每个 session 一个 action（前端下拉框：点击切换，右侧删除按钮）
    // 只显示标题，不在这里加 ✓ 前缀（前端通过 current_session_id 高亮）
    const actions = [];
    for (const s of displaySessions) {
      actions.push({
        id: `session-${s.id}`,
        label: s.title,
        sublabel: s.updated || '',
        action: 'send_text',
        payload: {
          text: `/session-use ${s.id}`,
          sessionId: s.id,
          sessionTitle: s.title,
        },
      });
    }

    const cardData = {
      version: 3,
      card_id: `card-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      template: 'ai_streaming',
      title: `会话列表 (共 ${sessions.length} 个${sessions.length > MAX_SESSIONS ? `，显示前 ${MAX_SESSIONS}` : ''})`,
      description: currentSessionTitle ? `当前会话：${currentSessionTitle}` : '未指定会话',
      actions,
      metadata: {
        session_id: `ops-assistant-${senderUserId}`,
        is_streaming: false,
        is_session_list: true,
        current_session_id: currentSessionId,
        current_session_title: currentSessionTitle,
      },
    };

    await this.sendCard(targetId, cardData, convType);
  }

  /**
   * 发送会话搜索结果卡片
   */
  async _sendSessionSearchResults(targetId, convType, senderUserId, keyword, sessions) {
    const limitedSessions = sessions.slice(0, 50);
    const currentSessionId = this.userSessions.get(senderUserId) || '';
    const currentSession = currentSessionId
      ? limitedSessions.find((s) => s.id === currentSessionId)
      : null;
    const currentSessionTitle = currentSession ? currentSession.title : '';

    const actions = [];
    for (const s of limitedSessions) {
      actions.push({
        id: `session-${s.id}`,
        label: s.title,
        sublabel: s.updated || '',
        action: 'send_text',
        payload: {
          text: `/session-use ${s.id}`,
          sessionId: s.id,
          sessionTitle: s.title,
        },
      });
    }

    const cardData = {
      version: 3,
      card_id: `card-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      template: 'ai_streaming',
      title: '会话搜索结果',
      description: `搜索 "${keyword}" 找到 ${sessions.length} 个会话`,
      actions,
      metadata: {
        session_id: `ops-assistant-${senderUserId}`,
        is_streaming: false,
        is_session_list: true,
        is_session_search: true,
        current_session_id: currentSessionId,
        current_session_title: currentSessionTitle,
      },
    };

    await this.sendCard(targetId, cardData, convType);
  }

  /**
   * 删除会话并刷新卡片
   */
  async _handleSessionDelete(targetId, convType, senderUserId, sessionId) {
    let output = '';
    let success = true;
    try {
      const result = await execAsync(`opencode session delete ${sessionId}`, {
        timeout: 30000,
        encoding: 'utf8',
        cwd: path.join(__dirname, 'opencode-workdir'),
      });
      output = result.stdout || result.stderr || '删除成功';
    } catch (execErr) {
      output = execErr.stdout || execErr.stderr || execErr.message;
      success = !!(execErr.stdout || execErr.stderr);
    }

    output = output.replace(/\x1b\[[0-9;]*m/g, '');
    const maxLength = 2000;
    const finalOutput = output.length > maxLength
      ? output.substring(0, maxLength) + '\n\n...（输出已截断）'
      : output;

    await this.sendText(targetId, `【删除会话 ${sessionId}】\n${finalOutput}`, convType);

    // 如果删除的是用户当前活跃的会话，清除偏好
    if (this.userSessions.get(senderUserId) === sessionId) {
      this.userSessions.delete(senderUserId);
      this.log.info(`[OpsAssistant] 已清除用户 ${senderUserId} 的会话偏好（会话 ${sessionId} 已删除）`);
    }

    // 刷新会话列表卡片
    await this._sendSessionCard(targetId, convType, senderUserId);
  }

  /**
   * 发送提供商管理交互式卡片
   */
  async _sendProvidersCard(targetId, convType, senderUserId) {
    this.log.info('[OpsAssistant] 开始执行 CLI: opencode providers list');
    let output = '';
    try {
      const result = await execAsync('opencode providers list', {
        timeout: 30000,
        encoding: 'utf8',
        cwd: path.join(__dirname, 'opencode-workdir'),
      });
      output = result.stdout || result.stderr || '';
    } catch (execErr) {
      this.log.warn(`[OpsAssistant] opencode providers list 失败: ${execErr.message}`);
      output = execErr.stdout || execErr.stderr || '';
    }

    output = output.replace(/\x1b\[[0-9;]*m/g, '');

    const lines = output.split('\n').map((l) => l.trim()).filter(Boolean);
    const providers = [];

    // 解析提供商列表：常见格式有表格、列表
    for (const line of lines) {
      // 跳过标题行、分隔线
      if (/^(─+|═+|Provider|Name|名称|提供)/.test(line)) continue;

      const parts = line.split(/\s+/);
      if (parts.length > 0 && parts[0]) {
        const name = parts[0];
        // 过滤明显不是提供商名称的行
        if (name.length > 1 && !/^\d+$/.test(name)) {
          // 检测登录状态：查找 logged in / connected / ✓ / ✅ 等关键词
          const lineLower = line.toLowerCase();
          const isLoggedIn = lineLower.includes('logged in')
            || lineLower.includes('connected')
            || lineLower.includes('login')
            || line.includes('✓')
            || line.includes('✅');
          providers.push({ name, isLoggedIn });
        }
      }
    }

    if (providers.length === 0) {
      await this.sendText(targetId, '暂无提供商配置。请检查 opencode providers 配置。', convType);
      return;
    }

    const actions = [];
    for (const p of providers) {
      // 提供商名称按钮
      actions.push({
        id: `prov-${p.name}`,
        label: p.name,
        action: 'send_text',
        payload: { text: p.isLoggedIn ? `/providers-logout ${p.name}` : `/providers-login ${p.name}` },
      });

      // 登录/登出按钮
      actions.push({
        id: `prov-action-${p.name}`,
        label: p.isLoggedIn ? '登出' : '登录',
        action: 'send_text',
        style: p.isLoggedIn ? 'danger' : undefined,
        payload: { text: p.isLoggedIn ? `/providers-logout ${p.name}` : `/providers-login ${p.name}` },
      });
    }

    const loggedInCount = providers.filter((p) => p.isLoggedIn).length;

    const cardData = {
      version: 3,
      card_id: `card-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      template: 'ai_streaming',
      title: '提供商管理',
      description: `共 ${providers.length} 个提供商，${loggedInCount} 个已登录`,
      actions,
      metadata: {
        session_id: `ops-assistant-${senderUserId}`,
        is_streaming: false,
      },
    };

    await this.sendCard(targetId, cardData, convType);
  }

  /**
   * 登录提供商并刷新卡片
   */
  async _handleProvidersLogin(targetId, convType, senderUserId, name) {
    let output = '';
    let success = true;
    try {
      const result = await execAsync(`opencode providers login ${name}`, {
        timeout: 30000,
        encoding: 'utf8',
        cwd: path.join(__dirname, 'opencode-workdir'),
      });
      output = result.stdout || result.stderr || '登录成功';
    } catch (execErr) {
      output = execErr.stdout || execErr.stderr || execErr.message;
      success = !!(execErr.stdout || execErr.stderr);
    }

    output = output.replace(/\x1b\[[0-9;]*m/g, '');
    const maxLength = 2000;
    const finalOutput = output.length > maxLength
      ? output.substring(0, maxLength) + '\n\n...（输出已截断）'
      : output;

    await this.sendText(targetId, `【登录提供商 ${name}】\n${finalOutput}`, convType);

    // 刷新提供商列表卡片
    await this._sendProvidersCard(targetId, convType, senderUserId);
  }

  /**
   * 登出提供商并刷新卡片
   */
  async _handleProvidersLogout(targetId, convType, senderUserId, name) {
    let output = '';
    let success = true;
    try {
      const result = await execAsync(`opencode providers logout ${name}`, {
        timeout: 30000,
        encoding: 'utf8',
        cwd: path.join(__dirname, 'opencode-workdir'),
      });
      output = result.stdout || result.stderr || '登出成功';
    } catch (execErr) {
      output = execErr.stdout || execErr.stderr || execErr.message;
      success = !!(execErr.stdout || execErr.stderr);
    }

    output = output.replace(/\x1b\[[0-9;]*m/g, '');
    const maxLength = 2000;
    const finalOutput = output.length > maxLength
      ? output.substring(0, maxLength) + '\n\n...（输出已截断）'
      : output;

    await this.sendText(targetId, `【登出提供商 ${name}】\n${finalOutput}`, convType);

    // 刷新提供商列表卡片
    await this._sendProvidersCard(targetId, convType, senderUserId);
  }

  /**
   * 重启服务
   */
  async _restartService() {
    // 发送提示后退出进程，由外部守护进程重新拉起
    setTimeout(() => {
      process.exit(0);
    }, 1000);
    return '重启指令已发送，服务将在 1 秒后重启...';
  }
}

module.exports = { OpsAssistantSkill };
