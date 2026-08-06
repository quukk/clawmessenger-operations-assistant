/**
 * 运维助手 Skill
 *
 * 负责处理运维相关消息，通过 opencode run 子进程调用 OpenCode。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');
const { promisify } = require('util');
const axios = require('axios');
const { BaseSkill } = require('../base-skill');
const { OpencodeRunner } = require('../../opencode/opencode-runner');
const { RongyunMessageTypeEnum } = require('../../modules/rongyun-message-types');
const { getOpsPrefsPath, migrateLegacyOpsConfig } = require('../../modules/config');
// CardKit 规范卡片构造器(B2:v3 硬编码卡片迁移至 builders)
const {
  card, md, note, divider, buttons, btn, action, kv,
  sessionList, commandPalette,
} = require('../../cardkit/builders');
// B3:StreamDelta + extra 卡片壳构造器(抽离至 stream-builders,供 event-handler 共享)
const { buildStreamDelta, buildStreamExtra } = require('./stream-builders');
// NOTE: /models 改用 accordion(commandPalette groups)方案,不再使用 buildModelCascadeCard。

const execAsync = promisify(exec);

// ============================================================================
// B3:StreamDelta + extra 卡片壳构造器已抽离至 ./stream-builders.js
// (event-handler.js 与本文件共享,避免循环依赖)
// 状态机覆盖:thinking → responding → completed(以及 error)
// ============================================================================

// ============================================================================
// 模型分组辅助:把扁平模型列表(形如 "provider/model-name")按 provider 分组
// 用于 /models 卡片的 commandPalette groups 形态
// ============================================================================

/**
 * 首字母大写(简单 capitalize)。"anthropic" → "Anthropic","openai" → "Openai"。
 * 对已是混合大小写的 provider(如 "xAI")保持原样。
 * @param {string} provider
 * @returns {string}
 */
function providerDisplayName(provider) {
  if (!provider) return '其他';
  // 若已含大写字母(如 xAI / MistralAI),保留原样,避免把 xAI 改成 Xai
  if (/[A-Z]/.test(provider)) return provider;
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

/**
 * 把 opencode session list 的 "Updated" 列文本解析成毫秒时间戳。
 * 支持两种格式:
 *   - "14:42"            → 今天的 HH:mm
 *   - "17:00 · 2026/7/15" → 指定日期的 HH:mm(年/月/日,中间用 · 分隔)
 * 解析失败返回 0。
 * @param {string} text
 * @returns {number}
 */
function parseSessionUpdated(text) {
  if (!text || typeof text !== 'string') return 0;
  const t = text.trim();
  // 格式 2: "HH:mm · YYYY/M/D"
  const m = t.match(/^(\d{1,2}):(\d{2})\s*[·•]\s*(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (m) {
    const d = new Date(Number(m[3]), Number(m[4]) - 1, Number(m[5]), Number(m[1]), Number(m[2]));
    return d.getTime();
  }
  // 格式 1: "HH:mm"(今天)
  const m2 = t.match(/^(\d{1,2}):(\d{2})$/);
  if (m2) {
    const now = new Date();
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(m2[1]), Number(m2[2]));
    return d.getTime();
  }
  // 兜底:直接尝试 Date 解析(ISO 等)
  const ts = Date.parse(t);
  return Number.isNaN(ts) ? 0 : ts;
}

/**
 * 取模型的展示名:去掉 provider 前缀。
 *   "anthropic/claude-3.5" → "claude-3.5"
 *   "no-slash-model"      → "no-slash-model"
 * @param {string} model 完整模型串
 * @returns {string}
 */
function prettyModelName(model) {
  const idx = model.indexOf('/');
  return idx > 0 ? model.slice(idx + 1) : model;
}

/**
 * 把扁平模型列表按 provider 聚合成 commandPalette groups 形态。
 * 保持原始顺序(Map 维持插入序);无 provider 前缀的归入"其他"。
 *
 * @param {string[]} models 完整模型串数组(如 ["anthropic/claude-3.5", "openai/gpt-4o"])
 * @returns {Array<{label: string, collapsed: boolean, items: Array<{name: string, description: string}>}>}
 */
function _buildModelGroups(models) {
  const buckets = new Map();
  for (const m of models) {
    const slashIdx = m.indexOf('/');
    const provider = slashIdx > 0 ? m.slice(0, slashIdx) : '其他';
    if (!buckets.has(provider)) buckets.set(provider, []);
    buckets.get(provider).push(m);
  }
  const groups = [];
  for (const [provider, list] of buckets) {
    groups.push({
      label: providerDisplayName(provider),
      collapsed: false,
      items: list.slice(0, 5).map((m) => ({
        name: `use-model ${m}`,
        description: prettyModelName(m),
      })),
    });
  }
  return groups;
}

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

    // 持久化用户偏好文件路径：~/.claw-bridge/opencode-ass/user-preferences.json
    migrateLegacyOpsConfig('[OpsAssistant]');
    this._prefsPath = getOpsPrefsPath();
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
    // 前端 HTTP SSE 端点使用的流 ID：streamId -> clientStreamId
    this._streamClientIds = new Map();
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
    const password = process.env.OPENCODE_SERVER_PASSWORD || null;

    this.runner = new OpencodeRunner({
      directory: opencodeDir,
      opencodeUrl,
      password,
      timeout,
      sessionFile: path.join(
        process.env.CLAW_OPS_SESSION_FILE || path.join(require('os').homedir(), '.config', 'opencode'),
        'ops-assistant-sessions.json'
      ),
      log: this.log,
    });

    // 初始化 SSE 真实流式(注入本 skill 的流式发送回调)
    // 失败不阻断 init:EventHandler 内部会后台重连,降级时 promptAsync 会抛错由 handle() catch
    try {
      await this.runner.initSse({
        sendStreamChunk: (targetId, streamId, isFirstChunk, isLastChunk, seq, opts) =>
          this._sendStreamChunk(targetId, streamId, isFirstChunk, isLastChunk, seq, opts),
        sendFinalCard: (ctx) =>
          this._sendFinalCard(ctx),
        sendErrorCard: (ctx) =>
          this._sendErrorCard(ctx),
      });
    } catch (err) {
      this.log.error(`[OpsAssistant] SSE 初始化失败,流式将降级: ${err.message}`);
    }

    this.log.info('[OpsAssistant] Initialized');
  }

  async destroy() {
    // 停止 SSE 事件循环(EventHandler 内部清理 streamStates/队列)
    if (this.runner && this.runner.eventHandler) {
      try {
        this.runner.eventHandler.stop();
      } catch (err) {
        this.log.warn(`[OpsAssistant] EventHandler.stop 异常: ${err.message}`);
      }
    }
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
    const streamId = `stream-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    try {
      // 1. 发送初始静态卡片(规范 CardModel,loading 占位)
      //    停止按钮发送 command.stop 触发后端取消
      //    普通聊天卡片不显示标题(前端 header.title 为空时整块 header 不渲染)
      await this.sendCard(replyTarget, card(cardId, '', [
        md('正在思考...'),
        buttons([
          btn('停止', action.command('stop'), { id: 'stop', variant: 'danger' }),
        ], 'inline'),
      ], { color: 'blue', loading: true }), convType);

      // 2. 使用 senderUserId 作为 chatId,实现单用户会话隔离
      const chatId = `ops-${senderUserId}`;

      // 如果用户通过 /session-use 指定了会话,注入到 runner 使其复用历史
      const userSessionId = this.userSessions.get(senderUserId);
      if (userSessionId) {
        this.runner.sessions.set(chatId, { id: userSessionId, lastUsed: Date.now() });
        this.log.info(`[OpsAssistant] 注入用户会话 ${userSessionId} 到 runner chatId=${chatId}`);
      }

      // 3. 异步触发 prompt(fire-and-forget)。
      //    真实回复由 EventHandler 消费 SSE 流(message.part.delta)驱动,
      //    通过回调 _sendStreamChunk / _sendFinalCard / _sendErrorCard 发送。
      //    这里只等 promptAsync 触发成功(若触发失败,catch 发错误卡片);
      //    触发成功后立即返回,不阻塞主流程。
      const routeCtx = {
        targetId: replyTarget,
        senderUserId,
        convType,
        cardId,
        streamId,
      };
      await this.runner.sendMessage(chatId, content, { routeCtx });

      this.log.info(`[OpsAssistant] promptAsync 已触发: chatId=${chatId}, cardId=${cardId}, streamId=${streamId}(后续流式由 SSE 驱动)`);
    } catch (err) {
      this.log.error(`[OpsAssistant] Failed to handle message: ${err.message}`);

      // 执行失败时发送错误卡片(普通聊天路径,无标题)
      await this.sendCard(replyTarget, card(cardId, '', [
        md(`**执行失败**\n${err.message}`),
      ], { color: 'red' }), convType);
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
   * 发送最终持久化卡片(session.idle 完成时由 EventHandler 回调)。
   *
   * SSE 真实流式架构下,真实增量(token 级)已由 message.part.delta 逐片发送,
   * completed 终态(is_final)也已在 EventHandler._handleSessionIdle 中发送。
   * 这里负责发送最终持久化卡片(规范 CardModel,card_id 复用,作为历史记录),
   * 并将 reasoning 内容回传给前端展示。
   *
   * @param {Object} ctx
   * @param {string} ctx.targetId
   * @param {number} ctx.convType
   * @param {string} ctx.senderUserId
   * @param {string} ctx.cardId
   * @param {string} ctx.fullContent
   * @param {string} [ctx.reasoningContent]
   */
  async _sendFinalCard(ctx) {
    const { targetId, convType, senderUserId, cardId, fullContent } = ctx;

    // 最终持久化卡片(普通聊天路径,无标题)
    try {
      await this.sendCard(targetId, card(cardId, '', [
        md(fullContent || '(空回复)'),
      ], {
        color: 'blue',
        reasoning: ctx.reasoningContent || '',
      }), convType);
    } catch (cardErr) {
      this.log.warn(`[OpsAssistant] 发送最终卡片失败: ${cardErr.message}`);
    }
  }

  /**
   * 发送错误卡片(session.error 时由 EventHandler 回调)。
   * @param {Object} ctx
   * @param {string} ctx.targetId
   * @param {number} ctx.convType
   * @param {string} ctx.senderUserId
   * @param {string} ctx.cardId
   * @param {string} ctx.error
   * @param {string} [ctx.reasoningContent]
   */
  async _sendErrorCard(ctx) {
    const { targetId, convType, senderUserId, cardId, error } = ctx;
    try {
      await this.sendCard(targetId, card(cardId, '', [
        md(`**执行失败**\n${error}`),
      ], {
        color: 'red',
        reasoning: ctx.reasoningContent || '',
      }), convType);
    } catch (cardErr) {
      this.log.warn(`[OpsAssistant] 发送错误卡片失败: ${cardErr.message}`);
    }
  }

  /**
   * 发送单个流式消息片段(B3:带 StreamDelta + extra;B4:删除旧 content 参数)
   *
   * @param {string} targetId 目标用户/会话 ID
   * @param {string} streamId 流 ID
   * @param {boolean} isFirstChunk 是否首流(决定是否写 extra)
   * @param {boolean} isLastChunk 是否尾流(决定 complete 标志)
   * @param {number} seq 序号
   * @param {Object} [opts]
   * @param {Object} [opts.streamDelta] StreamDelta 对象(必传)
   * @param {Object} [opts.extra] extra 卡片壳(仅首流写)
   */
  async _sendStreamChunk(targetId, streamId, isFirstChunk, isLastChunk, seq, opts = {}) {
    if (!this.messageSender) {
      this.log.warn('[OpsAssistant] messageSender not injected, skip stream chunk');
      return;
    }

    const { streamDelta = null } = opts;
    let { extra = null } = opts;

    // 确保 extra 以对象形式透传给 server-api(如上游误传 JSON 字符串则解析)
    if (extra && typeof extra === 'string') {
      try {
        extra = JSON.parse(extra);
      } catch (e) {
        this.log.warn(`[OpsAssistant] extra 不是合法 JSON,已忽略: ${e.message}`);
        extra = null;
      }
    }

    // 生成前端 HTTP SSE 端点使用的 clientStreamId，每个流只生成一次
    let clientStreamId = this._streamClientIds.get(streamId);
    if (!clientStreamId) {
      clientStreamId = this._generateClientStreamId();
      this._streamClientIds.set(streamId, clientStreamId);
    }

    // 将 clientStreamId 注入 streamDelta，供 RongCloudServerAPI 写入首流 messageUID 并缓冲
    const streamDeltaWithClientId = streamDelta
      ? { ...streamDelta, clientStreamId }
      : null;

    // 使用队列确保流式消息片段串行发送
    this._streamQueue = this._streamQueue.then(async () => {
      try {
        const messageUID = this._streamMessageUIDs.get(streamId);
        const result = await this.messageSender.sendStreamToTarget({
          targetId,
          streamId,
          seq,
          isFirstChunk,
          isLastChunk,
          messageUID,
          streamDelta: streamDeltaWithClientId,
          extra,
        });

        // 首流时存储 messageUID
        if (isFirstChunk && result && result.messageUID) {
          this._streamMessageUIDs.set(streamId, result.messageUID);
          this.log.info(`[OpsAssistant] 首流 messageUID 已存储: ${result.messageUID}, streamId=${streamId}`);
        }

        // 尾流清理该流在内存中的映射，避免长期累积
        if (isLastChunk) {
          this._streamMessageUIDs.delete(streamId);
          this._streamClientIds.delete(streamId);
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
            await this.sendCard(targetId, card(
              `card-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
              `MCP ${args}`,
              [
                md(output.length > 3000 ? output.substring(0, 3000) + '\n\n---\n*输出已截断*' : output),
                buttons([
                  btn('← 返回管理', action.command('mcp'), { id: 'mcp-back' }),
                ], 'inline'),
              ],
              { color: 'blue' },
            ), convType);
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
   * 发送模型选择卡 —— 单卡 accordion 折叠面板(commandPalette groups)。
   */
  async _sendModelsPage(targetId, convType, senderUserId) {
    const allModels = this.userModelLists.get(senderUserId);

    if (!allModels) {
      await this.sendText(targetId, '模型列表未缓存，请重新发送 /models', convType);
      return;
    }

    if (allModels.length === 0) {
      await this.sendText(targetId, '未找到可用模型，请稍后重试 /models', convType);
      return;
    }

    const currentModel = this.userModels.get(senderUserId) || '';

    const groups = _buildModelGroups(allModels);

    const cardId = `card-models-${senderUserId}-${Date.now()}`;
    const cardData = card(cardId, '运维助手', [
      kv([{ label: '当前模型', value: currentModel || '未设置' }]),
      commandPalette({ groups }, { searchCommand: 'models-search' }),
    ], { color: 'blue', icon: '☁️' });

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
  /**
   * 发送模型搜索结果卡片(防御性分批:匹配超 50 时同样流式追加)。
   */
  async _sendModelsSearchResults(targetId, convType, senderUserId, keyword, models) {
    const currentModel = this.userModels.get(senderUserId) || '';

    // 搜索结果通常远少于 50,但防御性截断以防极端情况触发融云体积上限。
    // 超过 50 时启用分批流式追加(逻辑同 _sendModelsPage)。
    const MAX_MODELS = 50;
    const displayModels = models.slice(0, MAX_MODELS);
    const commands = displayModels.map((model) => ({ name: `use-model ${model}`, description: '' }));

    const total = models.length;
    const loading = total > MAX_MODELS ? `（显示前 ${MAX_MODELS} 个，正在加载剩余…）` : '';
    /** @type {import('../../cardkit/schema').CardSection[]} */
    const sections = [
      note(`当前模型：${currentModel || '未选择'} | 搜索 "${keyword}" 找到 ${total} 个模型${loading}`),
      divider(),
      commandPalette({ commands, searchCommand: 'models-search' }),
    ];

    const cardId = `card-models-search-${senderUserId}-${Date.now()}`;
    const cardData = card(
      cardId,
      '模型搜索结果',
      sections,
      { color: 'blue', icon: '🔍' },
    );

    await this.sendCard(targetId, cardData, convType);

    this._streamRemainingBatches({
      targetId,
      convType,
      cardId,
      allItems: models,
      batchSize: MAX_MODELS,
      sleepMs: 300,
      buildAppendData: (batch) => ({
        appendCommands: batch.map((model) => ({ name: `use-model ${model}`, description: '' })),
      }),
    });
  }

  /**
   * 发送 MCP 管理交互式卡片
   */
  async _sendMcpCard(targetId, convType, senderUserId) {
    const cardData = card(
      `card-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      'MCP 管理',
      [
        md('管理 Model Context Protocol 服务器'),
        buttons([
          btn('列表', action.command('mcp list'), { id: 'mcp-list' }),
        ], 'inline'),
      ],
      { color: 'blue', icon: '🔧' },
    );

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
      const updated = parseSessionUpdated(parts[2] || '');
      sessions.push({ id: sid, title, updated });
    }

    // 缓存完整 session 列表供搜索使用
    this.userSessionLists.set(senderUserId, sessions);

    if (sessions.length === 0) {
      await this.sendText(targetId, '暂无会话记录。使用对话功能后将自动创建会话。', convType);
      return;
    }

    // 融云体积上限:首卡发前 50 个会话,剩余用 card_update 异步分批推送。
    const MAX_SESSIONS = 50;
    const displaySessions = sessions.slice(0, MAX_SESSIONS);

    const currentSessionId = this.userSessions.get(senderUserId) || '';

    // sessionList session 对象字段为 {id, title, updatedAt?}(前端 SectionSessionList 读 updatedAt,
    // 并按 section.currentSessionId 高亮当前会话)。将缓存里的 updated → updatedAt。
    const listSessions = displaySessions.map((s) => ({
      id: s.id,
      title: s.title,
      ...(s.updated ? { updatedAt: s.updated } : {}),
    }));

    /** @type {import('../../cardkit/schema').CardSection[]} */
    const sections = [
      sessionList({
        sessions: listSessions,
        searchCommand: 'session-search',
        ...(currentSessionId ? { currentSessionId } : {}),
      }),
    ];

    // 稳定 cardId:首卡与后续 card_update 共用
    const cardId = `card-sessions-${senderUserId}-${Date.now()}`;
    const cardData = card(
      cardId,
      `会话列表`,
      sections,
      { color: 'blue', icon: '💬' },
    );

    await this.sendCard(targetId, cardData, convType);

    // 分批流式追加剩余会话(fire-and-forget)
    this._streamRemainingBatches({
      targetId,
      convType,
      cardId,
      allItems: sessions,
      batchSize: MAX_SESSIONS,
      sleepMs: 300,
      buildAppendData: (batch) => ({
        appendSessions: batch.map((s) => ({
          id: s.id,
          title: s.title,
          ...(s.updated ? { updatedAt: s.updated } : {}),
        })),
      }),
    });
  }

  /**
   * 发送会话搜索结果卡片
   */
  /**
   * 发送会话搜索结果卡片(防御性分批:匹配超 50 时同样流式追加)。
   */
  async _sendSessionSearchResults(targetId, convType, senderUserId, keyword, sessions) {
    // 与 _sendSessionCard 同构,统一用 sessionList;updated → updatedAt。
    // 搜索结果通常远少于 50,但防御性截断以防极端情况触发融云体积上限。
    // 超过 50 时启用分批流式追加(逻辑同 _sendSessionCard)。
    const MAX_SESSIONS = 50;
    const displaySessions = sessions.slice(0, MAX_SESSIONS);

    const currentSessionId = this.userSessions.get(senderUserId) || '';
    const currentSession = currentSessionId
      ? displaySessions.find((s) => s.id === currentSessionId)
      : null;
    const currentSessionTitle = currentSession ? currentSession.title : '';

    const listSessions = displaySessions.map((s) => ({
      id: s.id,
      title: s.title,
      ...(s.updated ? { updatedAt: s.updated } : {}),
    }));

    const total = sessions.length;
    const loading = total > MAX_SESSIONS ? `（显示前 ${MAX_SESSIONS} 个，正在加载剩余…）` : '';

    /** @type {import('../../cardkit/schema').CardSection[]} */
    const sections = [
      note(`搜索 "${keyword}" 找到 ${total} 个会话${loading}${currentSessionTitle ? ` | 当前：${currentSessionTitle}` : ''}`),
      divider(),
      sessionList({
        sessions: listSessions,
        searchCommand: 'session-search',
        ...(currentSessionId ? { currentSessionId } : {}),
      }),
    ];

    const cardId = `card-sessions-search-${senderUserId}-${Date.now()}`;
    const cardData = card(
      cardId,
      '会话搜索结果',
      sections,
      { color: 'blue', icon: '🔍' },
    );

    await this.sendCard(targetId, cardData, convType);

    this._streamRemainingBatches({
      targetId,
      convType,
      cardId,
      allItems: sessions,
      batchSize: MAX_SESSIONS,
      sleepMs: 300,
      buildAppendData: (batch) => ({
        appendSessions: batch.map((s) => ({
          id: s.id,
          title: s.title,
          ...(s.updated ? { updatedAt: s.updated } : {}),
        })),
      }),
    });
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

    const loggedInCount = providers.filter((p) => p.isLoggedIn).length;

    /** @type {import('../../cardkit/schema').CardSection[]} */
    const sections = [
      note(`共 ${providers.length} 个提供商，${loggedInCount} 个已登录`),
      divider(),
    ];
    for (const p of providers) {
      const cmd = p.isLoggedIn ? `providers-logout ${p.name}` : `providers-login ${p.name}`;
      const actionLabel = p.isLoggedIn ? '登出' : '登录';
      sections.push({
        kind: 'buttonRow',
        buttons: [
          btn(p.name, action.command(cmd), { id: `prov-${p.name}` }),
          btn(actionLabel, action.command(cmd), {
            id: `prov-action-${p.name}`,
            variant: p.isLoggedIn ? 'danger' : 'primary',
          }),
        ],
        layout: 'inline',
      });
    }

    const cardData = card(
      `card-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      '提供商管理',
      sections,
      { color: 'blue', icon: '🔌' },
    );

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
  /**
   * 生成前端 HTTP SSE 端点使用的 clientStreamId。
   * Node >=14.17 使用 crypto.randomUUID，否则使用简易 UUID 兜底。
   * @returns {string}
   */
  _generateClientStreamId() {
    if (typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }
}

module.exports = { OpsAssistantSkill };
