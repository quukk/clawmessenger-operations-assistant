/**
 * 融云消息处理器 - 与桌面客户端对齐
 *
 * @deprecated 该模块使用硬编码 switch-case 分发消息，已被 Skill 框架取代。
 * 保留此文件仅用于紧急回滚。新逻辑见 service/skills/ 目录。
 *
 * 处理服务端发送的所有结构化消息类型：
 * - CHAT_MESSAGE: 转发消息到 OpenClaw AI 服务
 * - CREATE_OPENCODE_SESSION: 创建新会话
 * - DELETE_OPENCODE_SESSION: 删除会话
 */
const { RongyunMessageTypeEnum } = require('./rongyun-message-types');
const { createOpencodeSession, deleteOpencodeSession, forwardChatMessage, getOrCreateGatewaySession } = require('./opencode-service');
const { getMacAddress } = require('./mac-address');
const { getApiBaseUrl } = require('../config');

// 客服会话存储（内存缓存，生产环境建议用 Redis）
const serviceSessions = new Map();

// 客服系统提示词 - OpenClaw 运维助手智能体
const SERVICE_SYSTEM_PROMPT = `你是 虾说智能助手的 openclaw 运维助手智能体，职责有：保活、修配置、做备份 等运维工作。

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

class RongyunMessageHandler {
  constructor(rongcloudClient, config, log) {
    this.rongcloudClient = rongcloudClient;
    this.config = config;
    this.log = log;
    this.messageSender = null;
    this.serverAPI = null;
    // 流式消息队列：确保片段串行发送
    this._streamQueue = Promise.resolve();
    // 存储流式消息的 RongCloud messageUID：streamId -> messageUID
    this._streamMessageUIDs = new Map();
  }

  setMessageSender(messageSender) {
    this.messageSender = messageSender;
  }

  setServerAPI(serverAPI) {
    this.serverAPI = serverAPI;
  }

  /**
   * 发送流式消息片段（直接调用融云 API）
   * @param {string} fromUserId - 发送者ID
   * @param {string} targetId - 目标用户ID
   * @param {string} content - 消息内容
   * @param {string} streamId - 流式消息ID
   * @param {boolean} isFirstChunk - 是否首流
   * @param {boolean} isLastChunk - 是否尾流
   * @param {number} seq - 片段序号
   */
  async _sendStreamChunk(fromUserId, targetId, content, streamId, isFirstChunk, isLastChunk, seq = 1) {
    const contentPreview = typeof content === 'string' ? content.substring(0, 100) : JSON.stringify(content).substring(0, 100);
    this.logInfo(`[RongyunMessageHandler] _sendStreamChunk: target=${targetId}, streamId=${streamId}, seq=${seq}, first=${isFirstChunk}, last=${isLastChunk}, content_len=${content?.length || 0}`);

    if (!this.serverAPI) {
      this.logWarn('[RongyunMessageHandler] _sendStreamChunk skipped: serverAPI not configured');
      return;
    }

    // 使用队列确保流式消息片段串行发送，避免并发导致后端处理错乱
    this._streamQueue = this._streamQueue.then(async () => {
      try {
        // 获取已存储的 RongCloud messageUID（首流响应返回的）
        const messageUID = this._streamMessageUIDs.get(streamId);

        const result = await this.serverAPI.sendStreamPrivate({
          fromUserId,
          toUserId: targetId,
          content,
          streamId,
          isFirstChunk,
          isLastChunk,
          seq,
          messageUID
        });

        // 首流时存储 RongCloud 返回的 messageUID
        if (isFirstChunk && result?.messageUID) {
          this._streamMessageUIDs.set(streamId, result.messageUID);
          this.logInfo(`[RongyunMessageHandler] 首流 messageUID 已存储: ${result.messageUID}, streamId=${streamId}`);
        }

        this.logInfo(`[RongyunMessageHandler] _sendStreamChunk 成功: seq=${seq}`);
      } catch (err) {
        this.logWarn(`[RongyunMessageHandler] 发送流式消息失败: ${err.message}, seq=${seq}`);
      }
    });

    await this._streamQueue;
  }

  logInfo(message) {
    if (this.log?.info) {
      this.log.info(message);
    } else {
      console.log(`[INFO] ${message}`);
    }
  }

  logWarn(message) {
    if (this.log?.warn) {
      this.log.warn(message);
    } else {
      console.log(`[WARN] ${message}`);
    }
  }

  logError(message) {
    if (this.log?.error) {
      this.log.error(message);
    } else {
      console.error(`[ERROR] ${message}`);
    }
  }

  async handle(parsed) {
    try {
      if (!parsed || typeof parsed !== 'object') {
        this.logWarn('Invalid message format');
        return;
      }

      // 解析 content 字段（前端将业务数据放在 content 内）
      let data = parsed;
      if (parsed.content && typeof parsed.content === 'string') {
        // 聊天消息的内容是纯文本，不需要解析为 JSON
        const isChatMessage = parsed.msg_type === RongyunMessageTypeEnum.CHAT_MESSAGE ||
          parsed.msg_type === RongyunMessageTypeEnum.SERVICE_CHAT_MESSAGE;

        if (!isChatMessage) {
          try {
            const contentData = JSON.parse(parsed.content);
            // 将 content 内的数据合并到顶层，方便处理器直接访问
            // 保留原始 content 字段（用于聊天消息等场景）
            data = { ...parsed, ...contentData, _raw_content: parsed.content };
          } catch (e) {
            this.logWarn(`解析 content 失败: ${e.message}`);
          }
        }
      }

      const msgType = data.msg_type;
      this.logInfo(`[RongyunMessageHandler] 处理消息类型: ${msgType}`);

      switch (msgType) {
        case RongyunMessageTypeEnum.CHAT_MESSAGE:
          await this.handleChatMessage(data);
          break;
        case RongyunMessageTypeEnum.CREATE_OPENCODE_SESSION:
          await this.handleCreateSession(data);
          break;
        case RongyunMessageTypeEnum.DELETE_OPENCODE_SESSION:
          await this.handleDeleteSession(data);
          break;
        case RongyunMessageTypeEnum.DEVICE_STATUS_REQUEST:
          await this.handleDeviceStatusRequest(data);
          break;
        case RongyunMessageTypeEnum.CREATE_SERVICE_SESSION:
          await this.handleCreateServiceSession(data);
          break;
        case RongyunMessageTypeEnum.SERVICE_CHAT_MESSAGE:
          await this.handleServiceChatMessage(data);
          break;
        default:
          this.logWarn(`未处理的消息类型: ${msgType}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logError(`消息处理异常: ${msg}`);
    }
  }

  async handleChatMessage(data) {
    const roomId = data.room_id;
    const sessionId = data.gateway_session_id || data.session_id;
    // 使用解析后的 content（聊天内容），如果没有则使用原始 content
    let content = data.content || data._raw_content;
    const requestId = data.request_id;
    const sourceId = data.source_im_id;

    this.logInfo(`[RongyunMessageHandler] 收到聊天消息, roomId=${roomId}, sessionId=${sessionId}, from=${sourceId}`);

    if (!roomId || !sessionId || !content) {
      await this.sendResponse(RongyunMessageTypeEnum.CHAT_MESSAGE, {
        status: 'error',
        message: '缺少必要参数',
        content: '[错误] 缺少必要参数',
        metadata: {}
      }, requestId, sourceId);
      return;
    }

    // 语音消息：先进行语音识别
    if (data.voiceUrl) {
      const voiceText = await this._recognizeVoice(data.voiceUrl, data.voiceDuration);
      if (voiceText !== null) {
        content = `[语音转文字] ${voiceText}`;
      } else {
        content = `[语音消息，转文字失败] ${content}`;
      }
    }

    let fullResponse = '';
    let buffer = ''; // 用于流式发送的缓冲区
    const chatTimeoutMs = (this.config.chatTimeout || 600) * 1000;

    // 生成流式消息唯一ID
    const streamId = `stream-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const cardId = `card-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    let seq = 0;
    let hasSentChunk = false;
    const fromUserId = this.config.accountId || '';

    try {
      // 发送初始流式卡片（与 openclaw-clawmessenger 对齐）
      await this._sendCardMessage(sourceId, {
        version: 3,
        card_id: cardId,
        template: 'ai_streaming',
        title: 'AI 助手',
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
          session_id: `chat-${sourceId}`,
          is_streaming: true,
        },
      });

      // 原有的流式转发逻辑
      await forwardChatMessage(sessionId, content, async (delta) => {
        fullResponse += delta;
        buffer += delta;

        // 当缓冲区达到一定大小或包含标点时，发送流式片段
        // 使用 50 字符作为触发阈值（与 message-handler.js 保持一致）
        if (buffer.length >= 50) {
          seq += 1;
          const chunkToSend = buffer;
          buffer = ''; // 清空缓冲区

          // 首流时发送首流标记
          const isFirstChunk = seq === 1;
          await this._sendStreamChunk(fromUserId, sourceId, chunkToSend, streamId, isFirstChunk, false, seq);
          hasSentChunk = true;
        }
      }, (level, message) => {
        if (level === 'ERROR') {
          this.logError(`[CHAT-API] ${message}`);
        } else if (level === 'WARN') {
          this.logWarn(`[CHAT-API] ${message}`);
        } else {
          this.logInfo(`[CHAT-API] ${message}`);
        }
      }, chatTimeoutMs);

      // 发送剩余缓冲区内容
      if (buffer.length > 0) {
        seq += 1;
        const isFirstChunk = seq === 1;
        await this._sendStreamChunk(fromUserId, sourceId, buffer, streamId, isFirstChunk, false, seq);
        hasSentChunk = true;
        buffer = '';
      }

      // 发送尾流标记
      if (hasSentChunk) {
        seq += 1;
        await this._sendStreamChunk(fromUserId, sourceId, '', streamId, false, true, seq);
      }

      // 发送最终持久化卡片（与 openclaw-clawmessenger 对齐）
      try {
        await this._sendCardMessage(sourceId, {
          version: 3,
          card_id: cardId,
          template: 'ai_streaming',
          title: 'AI 助手',
          description: fullResponse,
          state: {
            status: 'completed',
            result: fullResponse,
            completed_at: Date.now(),
          },
          actions: [],
          metadata: {
            session_id: `chat-${sourceId}`,
            is_streaming: false,
          },
        });
      } catch (cardErr) {
        this.logWarn(`[RongyunMessageHandler] 发送最终卡片失败: ${cardErr.message}`);
      }

      // 同时发送完整的 command 消息作为历史记录（兼容旧前端）
      await this.sendResponse(RongyunMessageTypeEnum.CHAT_MESSAGE, {
        status: 'success',
        message: 'Response received',
        content: fullResponse,
        metadata: {}
      }, requestId, sourceId);

      // 清理已存储的 messageUID
      this._streamMessageUIDs.delete(streamId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logError(`聊天消息处理异常: ${msg}`);

      // 如果已经开始流式发送，发送错误标记
      if (hasSentChunk) {
        seq += 1;
        await this._sendStreamChunk(fromUserId, sourceId, `[错误] 转发失败: ${msg}`, streamId, false, true, seq);
      }

      await this.sendResponse(RongyunMessageTypeEnum.CHAT_MESSAGE, {
        status: 'error',
        message: msg,
        content: `[错误] 转发失败: ${msg}`,
        metadata: {}
      }, requestId, sourceId);

      // 清理已存储的 messageUID
      this._streamMessageUIDs.delete(streamId);
    }
  }

  async handleCreateSession(data) {
    const requestId = data.request_id;
    const title = data.title || '新会话';
    const sourceId = data.source_im_id;

    this.logInfo(`[RongyunMessageHandler] 创建会话, title=${title}, from=${sourceId}`);

    try {
      const session = await createOpencodeSession(title);
      this.logInfo(`会话创建成功: ${session.id}`);
      await this.sendResponse(RongyunMessageTypeEnum.OPENCODE_SESSION_CREATED, {
        status: 'success',
        opencode_session_id: session.id
      }, requestId, sourceId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logError(`创建会话失败: ${msg}`);
      await this.sendResponse(RongyunMessageTypeEnum.OPENCODE_SESSION_CREATED, {
        status: 'error',
        message: msg
      }, requestId, sourceId);
    }
  }

  async handleDeleteSession(data) {
    const sessionId = data.opencode_session_id;

    this.logInfo(`[RongyunMessageHandler] 删除会话, sessionId=${sessionId}`);

    if (!sessionId) {
      this.logError('删除会话失败: 缺少 opencode_session_id');
      return;
    }

    try {
      await deleteOpencodeSession(sessionId);
      this.logInfo(`会话删除成功: ${sessionId}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logError(`删除会话失败: ${msg}`);
    }
  }

  async handleDeviceStatusRequest(data) {
    const requestId = data.request_id;
    const targetId = data.source_im_id;

    this.logInfo(`[RongyunMessageHandler] 收到设备状态请求, from=${targetId}, requestId=${requestId}`);

    try {
      // 新架构下仅保留 opencode 对话能力，返回基础在线状态和能力标识
      const statusData = {
        has_om_capability: 1,  // 支持 opencode 对话式运维
        status_message: '运行中',
        mac_address: getMacAddress(),
        timestamp: Date.now(),
      };

      await this.sendDeviceStatusReport(targetId, requestId, statusData);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logError(`设备状态查询异常: ${msg}`);
      await this.sendDeviceStatusReport(targetId, requestId, null, msg);
    }
  }

  async sendDeviceStatusReport(targetId, requestId, data, error) {
    if (!this.messageSender) {
      this.logError('MessageSender 未设置，无法发送响应');
      return;
    }
    try {
      await this.messageSender.sendDeviceStatusReport(targetId, requestId, data, error);
      this.logInfo(`设备状态报告已发送 -> ${targetId}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logError(`发送设备状态报告失败: ${msg}`);
    }
  }

  async handleCreateServiceSession(data) {
    const requestId = data.request_id;
    const userId = data.userId || data.source_im_id;
    const sourceId = data.source_im_id;

    this.logInfo(`[RongyunMessageHandler] 创建客服会话, userId=${userId}, from=${sourceId}`);

    try {
      // 创建 OpenCode session 用于客服对话
      const session = await createOpencodeSession(`客服会话-${userId}`);
      const sessionId = session.id || session.session_id;

      // 存储会话映射关系
      serviceSessions.set(userId, {
        sessionId: sessionId,
        userId: userId,
        createdAt: Date.now(),
      });

      this.logInfo(`[RongyunMessageHandler] 客服会话创建成功: ${sessionId}`);

      await this.sendResponse(
        RongyunMessageTypeEnum.SERVICE_SESSION_CREATED,
        {
          status: 'success',
          sessionId: sessionId,
          userId: userId,
        },
        requestId,
        sourceId
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logError(`创建客服会话失败: ${msg}`);
      await this.sendResponse(
        RongyunMessageTypeEnum.SERVICE_SESSION_CREATED,
        {
          status: 'error',
          message: msg,
        },
        requestId,
        sourceId
      );
    }
  }

  async handleServiceChatMessage(data) {
    const requestId = data.request_id;
    const userId = data.userId || data.source_im_id;
    const sourceId = data.source_im_id;
    let content = data.content || data._raw_content;
    const voiceUrl = data.voiceUrl;
    const voiceDuration = data.voiceDuration;

    this.logInfo(`[RongyunMessageHandler] 收到客服消息, userId=${userId}, content=${content?.substring(0, 50)}, voiceUrl=${voiceUrl ? '有' : '无'}`);

    // 处理语音消息：如果有语音URL，先进行语音识别
    if (voiceUrl && (!content || content === '[语音]')) {
      try {
        this.logInfo(`[RongyunMessageHandler] 检测到语音消息，开始语音识别: ${voiceUrl}`);
        const recognizedText = await this.recognizeVoice(voiceUrl);
        if (recognizedText) {
          content = recognizedText;
          this.logInfo(`[RongyunMessageHandler] 语音识别成功: ${content.substring(0, 50)}`);
        } else {
          content = '[语音消息识别失败]';
          this.logWarn(`[RongyunMessageHandler] 语音识别失败，使用占位文本`);
        }
      } catch (e) {
        this.logError(`[RongyunMessageHandler] 语音识别异常: ${e.message}`);
        content = '[语音消息识别失败]';
      }
    }

    if (!content) {
      this.logWarn('客服消息内容为空');
      return;
    }

    try {
      // 获取或创建用户会话
      let sessionInfo = serviceSessions.get(userId);
      let sessionId;

      if (!sessionInfo) {
        // 如果没有会话，创建一个
        this.logInfo(`[RongyunMessageHandler] 用户 ${userId} 没有现有会话，创建新会话`);
        const session = await createOpencodeSession(`客服会话-${userId}`);
        sessionId = session.id || session.session_id;
        serviceSessions.set(userId, {
          sessionId: sessionId,
          userId: userId,
          createdAt: Date.now(),
        });
      } else {
        sessionId = sessionInfo.sessionId;
      }

      this.logInfo(`[RongyunMessageHandler] 使用会话: ${sessionId}`);

      // 调用 OpenCode 服务获取回复，使用运维助手提示词
      let fullResponse = '';
      await forwardChatMessage(
        sessionId,
        content,
        (delta) => {
          fullResponse += delta;
        },
        (level, message) => {
          if (level === 'ERROR') {
            this.logError(`[SERVICE-CHAT] ${message}`);
          } else {
            this.logInfo(`[SERVICE-CHAT] ${message}`);
          }
        },
        120000, // 2分钟超时
        SERVICE_SYSTEM_PROMPT // 使用运维助手提示词
      );

      this.logInfo(`[RongyunMessageHandler] 客服回复生成完成, 长度: ${fullResponse.length}`);

      // 发送客服回复给用户
      await this.sendResponse(
        RongyunMessageTypeEnum.SERVICE_CHAT_RESPONSE,
        {
          status: 'success',
          content: fullResponse,
          sessionId: sessionId,
          userId: userId,
        },
        requestId,
        sourceId
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logError(`客服消息处理异常: ${msg}`);

      // 发送错误回复
      await this.sendResponse(
        RongyunMessageTypeEnum.SERVICE_CHAT_RESPONSE,
        {
          status: 'error',
          content: '抱歉，处理您的消息时出现问题，请稍后重试。',
          userId: userId,
        },
        requestId,
        sourceId
      );
    }
  }

  /**
   * 语音识别 - 调用后端 Python 服务
   * @param {string} voiceUrl - 语音文件 URL
   * @returns {Promise<string>} 识别文本
   */
  async recognizeVoice(voiceUrl) {
    try {
      const axios = require('axios');

      // 从配置中获取后端 API 地址
      const apiBaseUrl = this.config.apiBaseUrl || getApiBaseUrl();
      const recognizeUrl = `${apiBaseUrl}/api/voice/recognize`;

      this.logInfo(`[RongyunMessageHandler] 调用语音识别 API: ${recognizeUrl}`);

      const response = await axios.post(recognizeUrl, {
        audioUrl: voiceUrl,
        format: 'mp3',
        sampleRate: 16000
      }, {
        timeout: 30000,
        headers: { 'Content-Type': 'application/json' }
      });

      if (response.data && response.data.code === 200) {
        return response.data.data.text;
      } else {
        this.logError(`[RongyunMessageHandler] 语音识别 API 返回错误: ${JSON.stringify(response.data)}`);
        return null;
      }
    } catch (e) {
      this.logError(`[RongyunMessageHandler] 语音识别请求失败: ${e.message}`);
      return null;
    }
  }

  async sendResponse(msgType, content, requestId, targetId) {
    if (!this.messageSender) {
      this.logError('MessageSender 未设置，无法发送响应');
      return;
    }

    try {
      if (targetId) {
        await this.messageSender.sendToTarget(targetId, msgType, content, requestId);
        this.logInfo(`响应已发送: ${msgType} -> ${targetId}`);
      } else {
        await this.messageSender.sendProtocolMessage(msgType, content, requestId);
        this.logInfo(`响应已发送: ${msgType}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logError(`发送响应失败: ${msg}`);
    }
  }

  /**
   * 发送卡片消息（与 openclaw-clawmessenger 对齐）
   */
  async _sendCardMessage(targetId, cardData) {
    if (!this.messageSender) {
      this.logError('MessageSender 未设置，无法发送卡片消息');
      return;
    }

    try {
      await this.messageSender.sendCardMessage(targetId, cardData);
      this.logInfo(`卡片消息已发送 -> ${targetId}, card_id=${cardData.card_id || 'unknown'}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logError(`发送卡片消息失败: ${msg}`);
    }
  }

  /**
   * 语音识别：调用后端百度语音 API 将语音转为文字
   */
  async _recognizeVoice(voiceUrl, voiceDuration) {
    try {
      if (!voiceUrl) {
        this.logWarn('[_recognizeVoice] 语音 URL 为空，跳过识别');
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

      const axios = require('axios');
      const apiUrl = `${this.config.apiBaseUrl}/api/voice/recognize`;
      this.logInfo(`[_recognizeVoice] 调用语音识别 API: ${apiUrl}, format=${format}, sampleRate=${sampleRate}`);

      const response = await axios.post(apiUrl, {
        audioUrl: voiceUrl,
        format,
        sampleRate,
      }, { timeout: 30000 });

      if (response.data?.code === 200 && response.data?.data?.text !== undefined) {
        const text = response.data.data.text;
        this.logInfo(`[_recognizeVoice] 语音识别成功: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);
        return text;
      } else {
        this.logWarn(`[_recognizeVoice] 语音识别失败: ${JSON.stringify(response.data)}`);
        return null;
      }
    } catch (err) {
      this.logError(`[_recognizeVoice] 语音识别异常: ${err.message}`);
      return null;
    }
  }
}

module.exports = {
  RongyunMessageHandler
};