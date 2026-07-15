/**
 * OpenCode SSE 事件处理器(异步真实流式)
 *
 * 参考 opencode-clawmessenger/src/opencode/event-handler.ts,精简为 ops-assistant 场景。
 *
 * 核心职责:
 *   1. 消费 opencode 全局 SSE 流(message.part.delta / session.idle / session.error)
 *   2. 维护 sessionId → 路由上下文映射(多用户并发,ops-assistant 是多 senderUserId)
 *   3. message.part.delta → 调 ops-assistant._sendStreamChunk 发真实 token 级增量(responding)
 *   4. session.idle → 发 completed 终态(is_final)+ 最终持久化卡片
 *   5. session.error → 发 error 终态
 *   6. SSE 断线自动重订阅(指数退避,上限 60s)
 *
 * 与 opencode-clawmessenger 的区别:
 *   - ops-assistant 是多用户并发,需要 sessionId → {chatId,targetId,senderUserId,cardId,...} 映射
 *   - 流式发送走 OpsAssistantSkill._sendStreamChunk(已封装 StreamDelta + extra + 串行队列),
 *     而不是直接调融云服务端 API
 *   - 不处理 permission.asked / question.asked(ops-assistant 用 --dangerously-skip-permissions
 *     或由 opencode 自身处理权限,IM 侧不交互授权)
 */
const { buildStreamDelta, buildStreamExtra } = require('../skills/ops-assistant/stream-builders');

/**
 * 轻量流式解析器：从模型输出中识别并剥离 <thinking>/<think> 标签。
 * 用于兼容不单独发送 field='thinking' 的模型（如 Kimi 2.7）。
 * 支持标签跨多个 delta 分片。
 */
class ThinkingTagParser {
  constructor() {
    this.inThinking = false;
    this.buffer = '';
    this.openTags = ['<thinking>', '<think>'];
    this.closeTags = ['</thinking>', '</think>'];
  }

  /**
   * 处理一段 delta 文本，把标签内内容归入 reasoningContent，外部内容归入 fullContent。
   * @param {string} text
   * @param {StreamState} streamState
   * @returns {{normal:string, reasoning:string}} 本次 delta 新分类出的内容
   */
  process(text, streamState) {
    this.buffer += text;
    const normalStartLen = streamState.fullContent.length;
    const reasoningStartLen = streamState.reasoningContent.length;

    while (true) {
      if (this.inThinking) {
        const idx = this._findTag(this.closeTags);
        if (idx === -1) {
          // 尚未出现完整结束标签；把不可能是结束标签前缀的部分沉淀为 reasoning
          const partial = this._findPartialTagStart(this.closeTags);
          if (partial !== -1) {
            if (partial > 0) {
              streamState.reasoningContent += this.buffer.slice(0, partial);
              this.buffer = this.buffer.slice(partial);
            }
            break;
          }
          streamState.reasoningContent += this.buffer;
          this.buffer = '';
          break;
        }
        const tagLen = this._matchTagLength(this.closeTags, idx);
        streamState.reasoningContent += this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + tagLen);
        this.inThinking = false;
        continue;
      }

      const idx = this._findTag(this.openTags);
      if (idx === -1) {
        const partial = this._findPartialTagStart(this.openTags);
        if (partial !== -1) {
          if (partial > 0) {
            streamState.fullContent += this.buffer.slice(0, partial);
            this.buffer = this.buffer.slice(partial);
          }
          break;
        }
        streamState.fullContent += this.buffer;
        this.buffer = '';
        break;
      }
      const tagLen = this._matchTagLength(this.openTags, idx);
      streamState.fullContent += this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + tagLen);
      this.inThinking = true;
      continue;
    }

    return {
      normal: streamState.fullContent.slice(normalStartLen),
      reasoning: streamState.reasoningContent.slice(reasoningStartLen),
    };
  }

  /**
   * session 结束时刷新残留缓冲：未关闭标签内的内容归入 reasoning。
   * @param {StreamState} streamState
   */
  flush(streamState) {
    if (this.buffer.length === 0) return;
    if (this.inThinking) {
      streamState.reasoningContent += this.buffer;
    } else {
      streamState.fullContent += this.buffer;
    }
    this.buffer = '';
  }

  hasPending() {
    return this.buffer.length > 0;
  }

  _findTag(tags) {
    let idx = -1;
    for (const tag of tags) {
      const i = this.buffer.indexOf(tag);
      if (i !== -1 && (idx === -1 || i < idx)) idx = i;
    }
    return idx;
  }

  _matchTagLength(tags, idx) {
    for (const tag of tags) {
      if (this.buffer.startsWith(tag, idx)) return tag.length;
    }
    return 0;
  }

  _findPartialTagStart(tags) {
    let pos = -1;
    for (let i = 0; i < this.buffer.length; i++) {
      if (this.buffer[i] !== '<') continue;
      const suffix = this.buffer.slice(i + 1);
      for (const tag of tags) {
        const tagBody = tag.slice(1);
        if (tagBody.startsWith(suffix)) {
          if (pos === -1 || i < pos) pos = i;
          break;
        }
      }
    }
    return pos;
  }
}

/**
 * 剥离模型输出中可能混入的 orchestrator/系统标签。
 * 例如 <dcp-system-reminder>、<dcp-message-id> 等，防止它们被流给用户。
 * 要求自闭合标签必须带 />，避免 <dcp-xxx> 开头在流式中尚未闭合时被误剥。
 * @param {string} text
 * @returns {string}
 */
function stripOrchestratorTags(text) {
  if (!text || text.length === 0) return text;
  let result = '';
  let i = 0;
  while (i < text.length) {
    const openIdx = text.toLowerCase().indexOf('<dcp-', i);
    if (openIdx === -1) {
      result += text.slice(i);
      break;
    }
    result += text.slice(i, openIdx);
    const tagEnd = text.indexOf('>', openIdx);
    if (tagEnd === -1) {
      // 未闭合的 dcp 标签开头，从该位置截断
      break;
    }
    const tagContent = text.slice(openIdx + 5, tagEnd);
    const tagNameMatch = tagContent.match(/^([\w-]+)/i);
    if (!tagNameMatch) {
      result += '<';
      i = openIdx + 1;
      continue;
    }
    const tagName = tagNameMatch[1].toLowerCase();
    if (text[tagEnd - 1] === '/') {
      // 自闭合标签
      i = tagEnd + 1;
      continue;
    }
    const openTag = '<dcp-' + tagName + '>';
    const closeTag = '</dcp-' + tagName + '>';
    let depth = 1;
    let j = tagEnd + 1;
    while (j < text.length && depth > 0) {
      const nextOpen = text.toLowerCase().indexOf(openTag, j);
      const nextClose = text.toLowerCase().indexOf(closeTag, j);
      if (nextClose === -1) {
        // 未找到匹配的结束标签，从开头截断
        return result;
      }
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth += 1;
        j = nextOpen + openTag.length;
      } else {
        depth -= 1;
        j = nextClose + closeTag.length;
      }
    }
    i = j;
  }
  return result;
}


/**
 * 若文本末尾是 [CARD][ 或 [COMMANDS][ 的部分前缀，则截断到 opener 前。
 * @param {string} text
 * @returns {string}
 */
function trimTrailingOpenerPrefix(text) {
  const openers = ['[CARD][', '[COMMANDS]['];
  for (const opener of openers) {
    for (let len = 1; len <= opener.length; len++) {
      if (text.endsWith(opener.slice(0, len))) {
        return text.slice(0, -len);
      }
    }
  }
  return text;
}

/**
 * 若文本末尾是 <dcp-... 或 </dcp-... 的部分前缀，则截断到 < 前。
 * @param {string} text
 * @returns {string}
 */
function trimTrailingDcpTagPrefix(text) {
  const lastAngle = text.lastIndexOf('<');
  if (lastAngle === -1) return text;
  const suffix = text.slice(lastAngle).toLowerCase();
  const openers = ['<dcp-', '</dcp-'];
  for (const opener of openers) {
    if (opener.startsWith(suffix) || suffix.startsWith(opener)) {
      return text.slice(0, lastAngle);
    }
  }
  return text;
}

/**
 * 流式安全内容：给定累积内容，返回"剥离所有系统标签和卡片标记后"的安全流式正文。
 * 与 opencode-clawmessenger 的 streamSafeContent 对齐。
 * @param {string} content
 * @returns {string}
 */
function streamSafeContent(content) {
  let result = stripOrchestratorTags(content);
  result = trimTrailingOpenerPrefix(result);
  result = trimTrailingDcpTagPrefix(result);
  return result;
}

/**
 * 内容消毒：移除 <dcp-system-reminder> 及其内部内容。
 * 支持嵌套、跨行、大小写不敏感。
 * <thinking>/<think> 标签由 ThinkingTagParser 处理，避免误把 reasoning 混入正文。
 * @param {string} text
 * @returns {string}
 */
function sanitizeContent(text) {
  if (!text || text.length === 0) return text;
  return stripOrchestratorTags(text);
}

/**
 * 对一段完整文本运行 ThinkingTagParser，将 <thinking>/<think> 标签内的内容
 * 提取到 reasoningContent，外部内容留在 fullContent。
 * 用于 part.updated 快照等需要一次性解析的场景。
 * @param {string} text
 * @returns {{fullContent:string, reasoningContent:string}}
 */
function extractThinkingTags(text) {
  const parser = new ThinkingTagParser();
  const output = { fullContent: '', reasoningContent: '' };
  parser.process(text, output);
  parser.flush(output);
  return output;
}

/**
 * 单条会话的流式状态(对应 opencode-clawmessenger 的 StreamState)
 * @typedef {Object} StreamState
 * @property {string} chatId           会话标识(如 ops-<senderUserId>)
 * @property {string} targetId         回复目标(融云 targetId)
 * @property {string} senderUserId     发起用户(用于 note 文案)
 * @property {number} convType         会话类型(1=单聊)
 * @property {string} cardId           流式卡片 id(与初始静态卡一致,前端续流依赖)
 * @property {string} streamId         流 ID
 * @property {number} seq              当前序号(1=thinking 首流,responding 逐 delta 递增)
 * @property {string} fullContent      累积的完整内容(session.idle 时用于持久化卡片)
 * @property {string} reasoningContent 累积的思考/推理内容(来自 properties.field='thinking'|'reasoning' 或 <thinking> 标签)
 * @property {boolean} hasSentStream   是否已发送过 responding 流片
 * @property {Object|null} extra       首流 extra 卡片壳(已发送后置 null,避免重复写)
 * @property {ThinkingTagParser} thinkParser  <thinking>/<think> 标签流式解析器
 * @property {Map<string,string>} partTypes  partID -> 'reasoning'|'text' 类型映射
 * @property {Set<string>} userMessageIds  已知 user message 的 messageID 集合(part 事件过滤用)
 * @property {boolean} [inLeadingReasoningPhase] 是否处于英文内部独白先导阶段
 * @property {number} [reasoningBoundary] 中文 reasoning 边界(未使用,保留字段)
 * @property {boolean} [isChineseQuery] 是否中文查询(未传入时默认 false)
 * @property {boolean} [heuristicEnabled] 中文 reasoning 启发开关(未传入时默认 false)
 * @property {number} streamedLength 已发送的安全正文长度（流式去标签用）
 * @property {number} reasoningStreamedLength 已发送的 reasoning 长度（流式去重用）
 */

/**
 * 检测文本是否仍处在“开头思考/内部独白”阶段。
 * 用于上游未单独发送 thinking 事件、且模型未使用 <thinking> 标签的情况（如 Kimi 2.7）。
 */
function looksLikeLeadingReasoning(text) {
  if (text.length < 20) return false;

  const leadingReasoningPatterns = [
    /^\s*I\s+(?:should|need|will|would|want|can|could|might|may|shall|must|have|already)\s+\w+/i,
    /^\s*I(?:'m|\s+am)\s+(?:going\s+to|trying\s+to|about\s+to|planning\s+to)\s+\w+/i,
    /^\s*I(?:'ve|\s+have)\s+(?:got|gotten|received|seen|noticed|observed|read)\s+/i,
    /^\s*Let\s+me\s+\w+/i,
    /^\s*Actually,?\s+\w+/i,
    /^\s*The\s+user\s+(?:asked|said|wants|needs|requested|is|was|refers|means)\b/i,
    /^\s*This\s+is\s+(?:a|an)\s+(?:factual|request|coding|question|about|not)\b/i,
    /^\s*Wait,?\s+\w+/i,
    /^\s*Hmm,?\s+\w+/i,
    /^\s*OK,?\s+(?:so|let|I|now|first)\b/i,
    /^\s*So,?\s+(?:I|let|first|to|the|this)\b/i,
    /^\s*(?:Now|First|Next|Then|Finally),?\s+(?:I|let|to|the|this)\s+\w+/i,
    /^\s*(?:To|In order to)\s+\w+/i,
  ];

  const hasLeadingReasoning = leadingReasoningPatterns.some(p => p.test(text));
  if (!hasLeadingReasoning) return false;

  // 一旦检测到强答案结构（中文块、列表、明确回答开头），即视为已过渡出思考阶段
  const answerPatterns = [
    /[\u4e00-\u9fa5]{5,}/,
    /\n\s*[-\*•]\s+\S/,
    /^\s*(?:Here|Below|It|This|According to|Based on|In summary|Yes|No|OK|Sure|I'll|I will|I can help|There (?:is|are|was|were))\b/im,
    /\n\s*\d+\.\s+\S/,
    /^\s*(?:The\s+(?:answer|final answer|result|conclusion|summary)\s+is|These are|Those are)\b/im,
  ];

  return !answerPatterns.some(p => p.test(text));
}

/**
 * 将进入主内容之前的英文内部独白识别为 reasoning。
 * 当模型未遵循 <thinking> 标签指令时，把这类先导性思考文本从正文剥离。
 * @param {StreamState} streamState
 * @returns {boolean} 是否成功进入 leading reasoning phase
 */
function tryEnterLeadingReasoningPhase(streamState) {
  if (streamState.inLeadingReasoningPhase) return false;
  if (streamState.reasoningBoundary !== undefined) return false;

  const text = streamState.fullContent;
  if (text.length < 20) return false;
  if (!looksLikeLeadingReasoning(text)) return false;

  streamState.reasoningContent += text;
  streamState.fullContent = '';
  streamState.inLeadingReasoningPhase = true;
  return true;
}

function isChineseText(text) {
  return /[\u4e00-\u9fa5]/.test(text);
}

function findChineseBlockStart(text) {
  const match = text.match(/[\u4e00-\u9fa5]{5,}/);
  return match && match.index !== undefined ? match.index : -1;
}

function applyChineseReasoningHeuristic(streamState) {
  if (streamState.reasoningBoundary !== undefined) return;
  const boundary = findChineseBlockStart(streamState.fullContent);
  if (boundary >= 0) {
    // 将中文答案块之前的英文前缀移动到 reasoningContent，避免正文重复出现 reasoning。
    if (boundary > 0) {
      streamState.reasoningContent += streamState.fullContent.slice(0, boundary);
      streamState.fullContent = streamState.fullContent.slice(boundary);
      // 前缀已从正文中移除，重置已发送长度，防止后续切片继续引用旧位置。
      streamState.streamedLength = 0;
    }
    streamState.reasoningBoundary = boundary;
    streamState.heuristicEnabled = false;
  }
  // 未找到中文答案块时保持当前正文不变，继续等待后续 delta；
  // 避免把英文-only 的合法答案误识别为 reasoning。
}

/**
 * 最终清理：如果 fullContent 以 reasoningContent 开头，则从 fullContent 中剔除该前缀。
 * 用于启发式失效时兜底去重，避免正文和 thinking 面板出现同一段英文 reasoning。
 * 同时会修正 streamedLength，防止重复发送或切片越界。
 * @param {StreamState} streamState
 */
function removeReasoningPrefixFromContent(streamState) {
  const rc = streamState.reasoningContent;
  if (!rc || rc.length === 0) return;
  const fc = streamState.fullContent;
  if (!fc.startsWith(rc)) return;

  const safeRc = streamSafeContent(rc);
  const newFc = fc.slice(rc.length);
  const safeNewFc = streamSafeContent(newFc);

  streamState.fullContent = newFc;
  if (streamState.streamedLength > 0) {
    const oldSafe = streamSafeContent(fc);
    const removedSafePrefix = oldSafe.startsWith(safeRc) ? safeRc.length : 0;
    streamState.streamedLength = Math.max(
      0,
      Math.min(streamState.streamedLength - removedSafePrefix, safeNewFc.length),
    );
  }
}

/**
 * 检测文本是否包含明显的英文内部独白/思考内容。
 * 与 looksLikeLeadingReasoning 不同：它不要求出现在开头，用于在中文答案已经开始后，
 * 继续识别混入正文流的英文思考片段。
 */
function looksLikeEnglishReasoning(text) {
  if (text.length < 15) return false;
  // 如果包含中文，则属于混合文本，不应整体识别为 reasoning（需要 splitMixedDelta 处理）
  if (/[\u4e00-\u9fa5]/.test(text)) return false;
  // 没有空格的短英文片段通常是中文里夹杂的技术术语，不要误判为 reasoning
  if (!/\s/.test(text)) return false;

  const internalMonologuePatterns = [
    /\b(?:I think|I should|I need to|I will|I would|I can|I could|I might|I have to|I want to|I am going to|I'm going to|I've got to|I can also|I should also|I will also|I need to also)\b/i,
    /\b(?:Let me|Actually,|Wait,|Hmm,|OK,|So,|But |However |Maybe |Perhaps |In summary|To summarize|Final response|On the other hand|In that case|In other words)\b/i,
    /\b(?:This is |That is |These are |Those are |The user |The user asked|This means |That means |What this means|What I mean)\b/i,
  ];

  return internalMonologuePatterns.some(p => p.test(text));
}

/**
 * 把混合了中文答案和英文思考的分片拆成 content/reasoning 两部分。
 * 只在末尾英文后缀看起来像内部独白时才拆分。
 */
function splitMixedDelta(text) {
  if (!/[\u4e00-\u9fa5]/.test(text)) return null;

  const endPunct = ['。', '，', '！', '？', '）'];
  let lastBoundary = -1;
  for (const p of endPunct) {
    const idx = text.lastIndexOf(p);
    if (idx > lastBoundary) lastBoundary = idx;
  }
  if (lastBoundary === -1) return null;

  const suffix = text.slice(lastBoundary + 1).trim();
  if (suffix.length < 20) return null;

  const cleanedSuffix = suffix.replace(/^[\s"\n\r]+/, '');
  if (cleanedSuffix.length < 15) return null;

  if (looksLikeEnglishReasoning(cleanedSuffix)) {
    return { content: text.slice(0, lastBoundary + 1), reasoning: suffix };
  }

  return null;
}

/**
 * 对非先导阶段的 delta 进行 content/reasoning 分类。
 */
function classifyDelta(streamState, text) {
  if (!text) return { content: '', reasoning: '' };

  const hasSeenChineseAnswer =
    streamState.reasoningBoundary !== undefined ||
    /[\u4e00-\u9fa5]{5,}/.test(streamState.fullContent);

  if (!hasSeenChineseAnswer) {
    return { content: text, reasoning: '' };
  }

  if (looksLikeEnglishReasoning(text)) {
    return { content: '', reasoning: text };
  }

  const split = splitMixedDelta(text);
  if (split) return split;

  return { content: text, reasoning: '' };
}

/**
 * 对 part.updated 快照做 content/reasoning 分类。
 * 与 classifyDelta 不同：它基于完整文本，而不是增量状态。
 */
function classifySnapshot(text) {
  if (!text) return { content: '', reasoning: '' };

  if (looksLikeLeadingReasoning(text)) {
    return { content: '', reasoning: text };
  }

  if (looksLikeEnglishReasoning(text)) {
    return { content: '', reasoning: text };
  }

  const split = splitMixedDelta(text);
  if (split) return split;

  return { content: text, reasoning: '' };
}

/**
 * 将 delta 先经过 <thinking> 标签解析器，再对解析器输出的普通文本做 content/reasoning 分类。
 * 返回应作为正文发送的增量内容。
 */
function processDeltaThroughClassifier(streamState, delta, field) {
  if (!streamState.thinkParser) {
    streamState.thinkParser = new ThinkingTagParser();
  }

  // 若上游显式标记了 field，直接按标记路由，不再走分类/启发式。
  if (field === 'thinking' || field === 'reasoning') {
    streamState.reasoningContent += delta;
    return '';
  }
  if (field === 'responding' || field === 'text') {
    streamState.fullContent += delta;
    return delta;
  }

  // 如果已经处在分类器判定的英文先导独白阶段，继续累积；
  // 一旦检测到强答案信号，退出该阶段并把当前 delta 交给正常分类流程。
  if (streamState.inLeadingReasoningPhase) {
    const accumulated = streamState.reasoningContent + delta;
    if (looksLikeLeadingReasoning(accumulated)) {
      streamState.reasoningContent += delta;
      return '';
    }
    // 退出 leading reasoning 阶段：锁定 reasoningBoundary，防止后续英文 reasoning
    // 反复被 tryEnterLeadingReasoningPhase 重新吸收，同时让 classifyDelta 识别到
    // 已进入答案阶段（hasSeenChineseAnswer=true），从而正确路由后续中文/英文。
    streamState.inLeadingReasoningPhase = false;
    if (streamState.reasoningBoundary === undefined) {
      streamState.reasoningBoundary = 0;
    }
  }

  const parserOutput = { ...streamState, fullContent: '', reasoningContent: '' };
  streamState.thinkParser.process(delta, parserOutput);
  const classified = classifyDelta(streamState, parserOutput.fullContent);
  streamState.fullContent += classified.content;
  streamState.reasoningContent += parserOutput.reasoningContent + classified.reasoning;

  if (streamState.heuristicEnabled && streamState.reasoningBoundary === undefined && !streamState.thinkParser.hasPending()) {
    applyChineseReasoningHeuristic(streamState);
  }

  let contentToSend = classified.content;
  if (!streamState.inLeadingReasoningPhase && streamState.reasoningBoundary === undefined && !streamState.thinkParser.hasPending()) {
    const entered = tryEnterLeadingReasoningPhase(streamState);
    if (entered) {
      contentToSend = '';
    }
  }
  return contentToSend;
}

class EventHandler {
  /**
   * @param {Object} options
   * @param {import('./opencode-client').OpencodeClient} options.opencode
   * @param {Object} options.log
   */
  constructor(options) {
    this.opencode = options.opencode;
    this.log = options.log || console;

    /**
     * 回调注入:把流片发送动作委托给 OpsAssistantSkill
     * @type {(targetId:string, streamId:string, isFirstChunk:boolean, isLastChunk:boolean, seq:number, opts:{streamDelta:Object, extra?:Object}) => Promise<void>}
     */
    this.sendStreamChunk = options.sendStreamChunk || null;

    /**
     * 回调注入:发送最终持久化卡片 + 历史 command 消息(session.idle 时)
     * @type {(ctx:{targetId:string, convType:number, senderUserId:string, cardId:string, fullContent:string, reasoningContent:string}) => Promise<void>}
     */
    this.sendFinalCard = options.sendFinalCard || null;

    /**
     * 回调注入:发送错误卡片(session.error 时)
     * @type {(ctx:{targetId:string, convType:number, senderUserId:string, cardId:string, error:string}) => Promise<void>}
     */
    this.sendErrorCard = options.sendErrorCard || null;

    /**
     * 回调注入:流结束(session.idle/error/cancelled)时清理 runner 的 activeStreams
     * @type {(cardId:string) => void}
     */
    this.onStreamEnd = options.onStreamEnd || null;

    this.isRunning = false;
    /** @type {Map<string, StreamState>} sessionId → 状态 */
    this.streamStates = new Map();
    /** 已完成(发过终态)的 session,避免 session.idle 重复发 */
    this.sentSessions = new Set();
    /** per-session 串行队列(保序) */
    this.streamQueues = new Map();
    this.reconnectAttempts = 0;
  }

  /**
   * 注册 sessionId → 路由上下文映射(promptAsync 触发前调用)
   * @param {string} sessionId
   * @param {Object} ctx
   * @param {string} ctx.chatId
   * @param {string} ctx.targetId
   * @param {string} ctx.senderUserId
   * @param {number} ctx.convType
   * @param {string} ctx.cardId
   * @param {string} ctx.streamId
   * @param {Object} [ctx.extra]   首流 extra 卡片壳
   */
  registerSession(sessionId, ctx) {
    this.streamStates.set(sessionId, {
      chatId: ctx.chatId,
      targetId: ctx.targetId,
      senderUserId: ctx.senderUserId,
      convType: ctx.convType,
      cardId: ctx.cardId,
      streamId: ctx.streamId,
      seq: 1,
      fullContent: '',
      reasoningContent: '',
      streamedLength: 0,
      reasoningStreamedLength: 0,
      hasSentStream: false,
      extra: ctx.extra || buildStreamExtra({ cardId: ctx.cardId }),
      thinkParser: new ThinkingTagParser(),
      partTypes: new Map(),
      // 已知 user message 的 messageID 集合：用于过滤 user message 的 part 事件，
      // 避免用户的问题被当作 AI 回复的开头（回声 bug）。
      userMessageIds: new Set(),
      inLeadingReasoningPhase: false,
      reasoningBoundary: undefined,
      isChineseQuery: false,
      heuristicEnabled: true,
    });
    // 清除可能的"已完成"标记(同一 session 复用)
    this.sentSessions.delete(sessionId);
    this.log.info(`[EventHandler] 注册 session 映射: ${sessionId} → chatId=${ctx.chatId}, cardId=${ctx.cardId}`);
  }

  /**
   * 取消指定 session 的流式输出,立即发送 cancelled 终态和最终卡片。
   * @param {string} sessionId
   */
  async cancelStream(sessionId) {
    if (this.sentSessions.has(sessionId)) {
      this.log.debug(`[EventHandler] cancelStream: session 已结束,跳过: ${sessionId}`);
      return;
    }
    const streamState = this.streamStates.get(sessionId);
    if (!streamState) {
      this.log.debug(`[EventHandler] cancelStream: 无路由映射,跳过: ${sessionId}`);
      return;
    }

    await this._enqueueStreamTask(sessionId, async () => {
      try {
        // 标记已发送终态,后续 session.idle/error 不再重复处理
        this.sentSessions.add(sessionId);

        if (!streamState.hasSentStream) {
          // 尚未发送过任何流片:发一个首流(带 extra) + cancelled 终态
          streamState.seq = 1;
          if (this.sendStreamChunk) {
            await this.sendStreamChunk(
              streamState.targetId,
              streamState.streamId,
              true,
              true,
              1,
              {
                streamDelta: buildStreamDelta({
                  content: '用户已停止生成',
                  reasoningContent: streamState.reasoningContent,
                  sessionStatus: 'cancelled',
                  seq: 1,
                  isFinal: true,
                  cardId: streamState.cardId,
                }),
                extra: streamState.extra,
              },
            );
          }
          streamState.hasSentStream = true;
          streamState.extra = null;
        } else {
          streamState.seq += 1;
          if (this.sendStreamChunk) {
            await this.sendStreamChunk(
              streamState.targetId,
              streamState.streamId,
              false,
              true,
              streamState.seq,
              {
                streamDelta: buildStreamDelta({
                  content: '用户已停止生成',
                  reasoningContent: streamState.reasoningContent,
                  sessionStatus: 'cancelled',
                  seq: streamState.seq,
                  isFinal: true,
                  cardId: streamState.cardId,
                }),
              },
            );
          }
        }

        // 最终持久化卡片:显示已停止
        if (this.sendFinalCard) {
          await this.sendFinalCard({
            targetId: streamState.targetId,
            convType: streamState.convType,
            senderUserId: streamState.senderUserId,
            cardId: streamState.cardId,
            fullContent: '已停止生成',
            reasoningContent: streamState.reasoningContent,
          });
        }

        // 清理状态
        const cardId = streamState.cardId;
        streamState.fullContent = '';
        streamState.reasoningContent = '';
        streamState.streamedLength = 0;
        streamState.reasoningStreamedLength = 0;
        this.streamStates.delete(sessionId);
        if (this.onStreamEnd) {
          try {
            this.onStreamEnd(cardId);
          } catch (err) {
            this.log.warn(`[EventHandler] onStreamEnd 回调异常: ${err.message}`);
          }
        }
        this.log.info(`[EventHandler] 流已取消: ${sessionId}, cardId=${cardId}`);
      } catch (err) {
        this.log.error(`[EventHandler] cancelStream 失败: ${err.message}, session=${sessionId}`);
      }
    });
  }

  /**
    * 把一个异步任务追加到指定 session 的串行队列后执行。
   * 不同 session 的队列相互独立(并行),同 session 内保序。
   * 参考 opencode-clawmessenger event-handler.ts:50-60。
   * @template T
   * @param {string} sessionId
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  _enqueueStreamTask(sessionId, task) {
    const prev = this.streamQueues.get(sessionId) || Promise.resolve();
    const run = prev.then(() => task(), () => task());
    const tail = run.then(() => undefined, () => undefined);
    this.streamQueues.set(sessionId, tail);
    void tail.then(() => {
      if (this.streamQueues.get(sessionId) === tail) this.streamQueues.delete(sessionId);
    });
    return run;
  }

  /**
   * 启动 SSE 事件循环(后台异步,不阻塞主流程)
   * @param {{stream: AsyncGenerator}} eventStream
   */
  async start(eventStream) {
    if (this.isRunning) return;
    this.isRunning = true;
    this.log.info('[EventHandler] 启动(SSE 真实流式模式)');
    // 后台运行,不 await(避免阻塞 worker 启动)
    this._runEventLoop(eventStream).catch((err) => {
      this.log.error(`[EventHandler] 事件循环异常退出: ${err.message}`);
    });
  }

  stop() {
    this.isRunning = false;
    this.reconnectAttempts = 0;
    this.streamStates.clear();
    this.sentSessions.clear();
    this.streamQueues.clear();
  }

  /**
   * SSE 事件循环主体。流异常结束/断开后延迟重订阅。
   * 参考 opencode-clawmessenger event-handler.ts:101-153。
   * @param {{stream: AsyncGenerator}} eventStream
   */
  async _runEventLoop(eventStream) {
    while (this.isRunning) {
      try {
        for await (const event of eventStream.stream) {
          if (!this.isRunning) break;
          // SSE 事件结构:{ payload: { type, properties } } 或直接 { type, properties }
          await this._handleEvent(event.payload || event);
        }
        this.log.info('[EventHandler] SSE 流正常结束(EOF)');
      } catch (err) {
        this.log.error(`[EventHandler] SSE 流错误: ${err.message}`);
      }

      if (!this.isRunning) break;

      // 清理断线残留的流式状态(避免会话卡住)
      if (this.streamStates.size > 0) {
        this.log.warn(`[EventHandler] SSE 断线,清理 ${this.streamStates.size} 个残留 streamStates`);
        this.streamStates.clear();
      }
      this.sentSessions.clear();
      this.streamQueues.clear();

      // 指数退避重订阅(上限 60s)
      this.reconnectAttempts = Math.min(this.reconnectAttempts + 1, 6);
      const delay = Math.min(5000 * Math.pow(2, this.reconnectAttempts - 1), 60000);
      this.log.info(`[EventHandler] SSE 将在 ${delay}ms 后重订阅 (第 ${this.reconnectAttempts} 次)`);
      await new Promise((resolve) => setTimeout(resolve, delay));

      if (!this.isRunning) break;

      try {
        eventStream = await this.opencode.subscribeGlobalEvents();
        this.reconnectAttempts = 0;
        this.log.info('[EventHandler] SSE 重订阅成功');
      } catch (err) {
        this.log.error(`[EventHandler] SSE 重订阅失败: ${err.message},将继续重试`);
      }
    }
    this.isRunning = false;
  }

  /**
   * 处理单个 SSE 事件
   * @param {Object} globalEvent
   */
  async _handleEvent(globalEvent) {
    try {
      const eventType = globalEvent?.type || globalEvent?.payload?.type || globalEvent?.event?.type;
      if (!eventType) return;

      // 心跳降噪
      if (eventType === 'server.heartbeat' || eventType === 'server.connected') return;

      this.log.debug(`[EventHandler] raw event: ${eventType}, ${JSON.stringify(globalEvent)}`);

      const props =
        globalEvent.properties ||
        globalEvent.payload?.properties ||
        globalEvent.payload ||
        globalEvent;

      switch (eventType) {
        case 'session.idle': {
          await this._handleSessionIdle(props);
          break;
        }
        case 'message.part.delta': {
          await this._handleMessagePartDelta(props);
          break;
        }
        case 'session.error': {
          await this._handleSessionError(props);
          break;
        }
        case 'message.part.updated': {
          await this._handleMessagePartUpdated(props);
          break;
        }
        case 'session.created':
        case 'session.compacted':
        case 'session.closed':
        case 'chat.message':
        case 'session.status':
          // ops-assistant 不需要处理这些(权限/问答由 opencode 自身完成)
          this.log.debug(`[EventHandler] 忽略事件: ${eventType}`);
          break;
        case 'message.updated': {
          this._handleMessageUpdated(props);
          break;
        }
        default:
          this.log.debug(`[EventHandler] 未知事件: ${eventType}`);
      }
    } catch (err) {
      this.log.error(`[EventHandler] 处理事件异常: ${err.message}`);
    }
  }

  /**
   * 处理 message.updated —— 记录 user message 的 messageID。
   * 用于过滤 user message 的 part.updated/delta 事件,避免用户的问题被当作 AI 回复
   * 的开头显示(回声 bug)。
   *
   * @param {Object} properties { info: { id, sessionID, role } }
   */
  _handleMessageUpdated(properties) {
    const info = properties.info || {};
    const sessionId = info.sessionID;
    if (!sessionId) return;

    const streamState = this.streamStates.get(sessionId);
    if (!streamState) {
      this.log.debug(`[EventHandler] message.updated 无路由映射,跳过: ${sessionId}`);
      return;
    }

    if (info.role === 'user' && info.id) {
      if (!streamState.userMessageIds.has(info.id)) {
        streamState.userMessageIds.add(info.id);
        this.log.debug(`[EventHandler] 记录 user message: session=${sessionId}, messageId=${info.id}`);
      }
    }
  }

  /**
   * 判断 part 事件是否属于已知的 user message。
   * 用于过滤 user message 的 part 事件,避免用户的问题被当作 AI 回复的开头显示。
   * @param {Object} properties { part?, messageID?, partID? }
   * @param {StreamState} streamState
   * @returns {boolean}
   */
  _isUserMessagePart(properties, streamState) {
    if (!streamState.userMessageIds || streamState.userMessageIds.size === 0) return false;
    const messageId =
      properties.messageID ||
      properties.messageId ||
      properties.part?.messageID ||
      properties.part?.messageId;
    return messageId ? streamState.userMessageIds.has(messageId) : false;
  }

  /**
   * 处理 message.part.updated —— part 终态快照,用于 Kimi 2.7+ 等模型
   * 将 reasoning/text 部分类型存入 partTypes 映射,并用最终文本更新状态。
   *
   * @param {Object} properties { sessionID, part: { id, type, text } }
   */
  async _handleMessagePartUpdated(properties) {
    const sessionId = properties.sessionID || properties.sessionId;
    if (!sessionId) return;

    // 已发送过终态的 session,丢弃迟到的更新
    if (this.sentSessions.has(sessionId)) {
      this.log.debug(`[EventHandler] session 已完成,丢弃 part.updated: ${sessionId}`);
      return;
    }

    const streamState = this.streamStates.get(sessionId);
    if (!streamState) {
      this.log.debug(`[EventHandler] part.updated 无路由映射,跳过: ${sessionId}`);
      return;
    }

    // Bug 2 修复:过滤 user message 的 part.updated,避免用户的问题被当作 AI 回复的开头显示
    if (this._isUserMessagePart(properties, streamState)) {
      this.log.debug(`[EventHandler] part.updated 属于 user message,跳过: session=${sessionId}`);
      return;
    }

    const part = properties.part || {};
    const partID = part.id || properties.partID;
    const partType = part.type;
    const partText = sanitizeContent(typeof part.text === 'string' ? part.text : '');

    if (!partID) {
      this.log.debug('[EventHandler] part.updated 缺少 partID,跳过');
      return;
    }

    this.log.debug(`[EventHandler] raw part.updated properties: ${JSON.stringify(properties)}`);

    await this._enqueueStreamTask(sessionId, async () => {
      try {
        // 优先尊重 part.type：reasoning/thinking → reasoningContent，responding/text → fullContent。
        // 只有在 type 缺失时才回退到 classifySnapshot 启发式。
        if (partText.length > 0) {
          const parsed = extractThinkingTags(partText);

          if (partType === 'thinking' || partType === 'reasoning') {
            // reasoning 快照：整体归入 reasoning（<thinking> 标签内/外内容都视为 reasoning）
            const snapshotReasoning = parsed.reasoningContent + parsed.fullContent;
            if (snapshotReasoning) {
              streamState.reasoningContent = snapshotReasoning;
              streamState.reasoningStreamedLength = 0;
            }
          } else if (partType === 'responding' || partType === 'text') {
            // text 快照：正文由快照权威覆盖，同时保留 <thinking> 标签解析出的 reasoning。
            streamState.fullContent = parsed.fullContent;
            streamState.streamedLength = 0;
            if (parsed.reasoningContent) {
              streamState.reasoningContent = parsed.reasoningContent;
              streamState.reasoningStreamedLength = 0;
            }
          } else {
            // 类型缺失：回退到分类器判断
            const classified = classifySnapshot(parsed.fullContent);
            streamState.fullContent = classified.content;
            streamState.streamedLength = 0;
            const snapshotReasoning = parsed.reasoningContent + (classified.reasoning || '');
            if (snapshotReasoning) {
              streamState.reasoningContent = snapshotReasoning;
              streamState.reasoningStreamedLength = Math.min(
                streamState.reasoningStreamedLength,
                streamState.reasoningContent.length,
              );
            }
          }
        }
        // 保留 partTypes 映射供后续 delta 参考
        streamState.partTypes.set(partID, partType || 'text');
      } catch (err) {
        this.log.error(`[EventHandler] 处理 part.updated 失败: ${err.message}, session=${sessionId}`);
      }
    });
  }

  /**
   * 处理 message.part.delta —— 真实 token 级增量。
   * 参考 opencode-clawmessenger event-handler.ts:503-617。
   * @param {Object} properties { sessionID, delta?, text?, part? }
   */
  async _handleMessagePartDelta(properties) {
    const sessionId = properties.sessionID || properties.sessionId;
    if (!sessionId) return;

    // 已发送过终态(completed/error)的 session,丢弃迟到的 delta
    if (this.sentSessions.has(sessionId)) {
      this.log.debug(`[EventHandler] session 已完成,丢弃 delta: ${sessionId}`);
      return;
    }

    const streamState = this.streamStates.get(sessionId);
    if (!streamState) {
      // 没有路由映射:可能是其他客户端触发的 session,或注册丢失,跳过
      this.log.debug(`[EventHandler] delta 无路由映射,跳过: ${sessionId}`);
      return;
    }

    // Bug 2 修复:过滤 user message 的 part.delta,避免用户的问题被当作 AI 回复的开头显示
    if (this._isUserMessagePart(properties, streamState)) {
      this.log.debug(`[EventHandler] delta 属于 user message,跳过: session=${sessionId}`);
      return;
    }

    // 提取增量文本(兼容多种字段命名)
    const rawDelta =
      properties.delta || properties.text || properties.part?.delta || properties.part?.text || '';
    const delta = sanitizeContent(rawDelta);
    if (typeof delta !== 'string') return;
    // 空字符串 delta 是合法的(无新内容块),不跳过

    // Bug 1 修复:不再依赖 properties.field 做路由(真实日志证明 OpenCode 对所有 delta 的
    // field 一律设为 "text",field routing 是死代码)。改用 partID 反查 partTypes 映射,
    // 该映射由 _handleMessagePartUpdated 填充(key=partID, value=partType)。
    const partID = properties.partID || properties.partId || properties.part?.id;
    const knownPartType = partID ? streamState.partTypes.get(partID) : null;
    // 已知 partType 为 reasoning/thinking → 强制进 reasoningContent;
    // 其他情况(已知 text、未知、无 partID)→ 传 undefined 走分类器/启发式(向后兼容),
    // 分类器会处理 leading reasoning、中文答案块边界、<thinking> 标签等。
    const isReasoningPart = knownPartType === 'reasoning' || knownPartType === 'thinking';
    const field = isReasoningPart ? 'reasoning' : undefined;

    this.log.debug(`[EventHandler] raw delta properties: ${JSON.stringify(properties)}`);

    await this._enqueueStreamTask(sessionId, async () => {
      try {
        const isExplicitField = field === 'reasoning';

        processDeltaThroughClassifier(streamState, delta, field);

        // 兜底去重：仅对未显式路由(分类器路径)运行，避免覆盖 reasoning part 显式路由。
        if (!isExplicitField) {
          removeReasoningPrefixFromContent(streamState);
        }

        // 流式安全：基于累积 fullContent 计算本次可发送的新增量正文
        const safeText = streamSafeContent(streamState.fullContent);
        const contentToSend = safeText.slice(streamState.streamedLength);
        streamState.streamedLength = safeText.length;

        // 计算本次新增 reasoning，只发送增量，避免 responding 重复携带全量 reasoning
        const reasoningToSend = streamState.reasoningContent.slice(streamState.reasoningStreamedLength);
        streamState.reasoningStreamedLength = streamState.reasoningContent.length;

        // 首流(尚未发送过任何流片):先发 thinking 态(seq=1)让前端进入续流
        if (!streamState.hasSentStream) {
          if (this.sendStreamChunk) {
            await this.sendStreamChunk(
              streamState.targetId,
              streamState.streamId,
              true, // isFirstChunk
              false,
              1, // seq=1 thinking
              {
                streamDelta: buildStreamDelta({
                  content: '',
                  reasoningContent: reasoningToSend,
                  sessionStatus: 'thinking',
                  seq: 1,
                  cardId: streamState.cardId,
                }),
                extra: streamState.extra,
              },
            );
          }
          streamState.hasSentStream = true;
          streamState.extra = null; // 首流 extra 已发送,避免后续流片重复携带
        } else if (reasoningToSend.length > 0) {
          // 非首流但有新增 reasoning：发送独立的 thinking 片
          streamState.seq += 1;
          if (this.sendStreamChunk) {
            await this.sendStreamChunk(
              streamState.targetId,
              streamState.streamId,
              false,
              false,
              streamState.seq,
              {
                streamDelta: buildStreamDelta({
                  content: '',
                  reasoningContent: reasoningToSend,
                  sessionStatus: 'thinking',
                  seq: streamState.seq,
                  cardId: streamState.cardId,
                }),
              },
            );
          }
        }

        // 发送正文增量（只发 content，不带 reasoning）
        if (contentToSend.length > 0) {
          streamState.seq += 1;
          if (this.sendStreamChunk) {
            const opts = {
              streamDelta: buildStreamDelta({
                content: contentToSend,
                reasoningContent: '',
                sessionStatus: 'responding',
                seq: streamState.seq,
                cardId: streamState.cardId,
              }),
            };
            if (streamState.extra) opts.extra = streamState.extra;
            await this.sendStreamChunk(
              streamState.targetId,
              streamState.streamId,
              false, // 非首流
              false,
              streamState.seq,
              opts,
            );
          }
        }
        this.log.debug(`[EventHandler] delta 已发送: session=${sessionId}, seq=${streamState.seq}, len=${delta.length}, field=${field || 'content'}`);
      } catch (err) {
        this.log.error(`[EventHandler] 发送 delta 失败: ${err.message}, session=${sessionId}`);
      }
    });
  }

  /**
   * 处理 session.idle —— 会话完成,发 completed 终态 + 持久化卡片。
   * 参考 opencode-clawmessenger event-handler.ts:619-704。
   * @param {Object} properties { sessionID }
   */
  async _handleSessionIdle(properties) {
    const sessionId = properties.sessionID || properties.sessionId;
    if (!sessionId) return;

    if (this.sentSessions.has(sessionId)) {
      this.log.debug(`[EventHandler] session.idle 重复,跳过: ${sessionId}`);
      return;
    }

    const streamState = this.streamStates.get(sessionId);
    if (!streamState) {
      this.log.debug(`[EventHandler] session.idle 无路由映射,跳过: ${sessionId}`);
      return;
    }

    await this._enqueueStreamTask(sessionId, async () => {
      try {
        // 刷新未关闭的 <thinking> 标签，残留缓冲内容按标签状态归类
        streamState.thinkParser.flush(streamState);

        // 最终兜底：若 reasoning 仍出现在正文开头，则直接裁掉，避免卡片重复展示。
        removeReasoningPrefixFromContent(streamState);

        // 如果 delta 流片一次都没发过(可能 LLM 直接没产文本,或全部被过滤),
        // 兜底:发一个空 thinking + completed,让前端正确收尾
        if (!streamState.hasSentStream) {
          const reasoningToSend = streamState.reasoningContent.slice(streamState.reasoningStreamedLength);
          streamState.reasoningStreamedLength = streamState.reasoningContent.length;
          if (this.sendStreamChunk) {
            await this.sendStreamChunk(
              streamState.targetId,
              streamState.streamId,
              true,
              false,
              1,
              {
                streamDelta: buildStreamDelta({
                  content: '',
                  reasoningContent: reasoningToSend,
                  sessionStatus: 'thinking',
                  seq: 1,
                  cardId: streamState.cardId,
                }),
                extra: streamState.extra,
              },
            );
          }
          streamState.hasSentStream = true;
        }

        // completed 终态(is_final,内容为空；最终卡片_update承载最终内容)
        const fullContent = streamState.fullContent || '';
        streamState.seq += 1;
        this.log.info(`[EventHandler] session.idle final fullContent: length=${fullContent.length}, preview=${fullContent.slice(0, 80)}${fullContent.length > 80 ? '...' : ''}`);
        if (this.sendStreamChunk) {
          await this.sendStreamChunk(
            streamState.targetId,
            streamState.streamId,
            false,
            true, // isLastChunk
            streamState.seq,
            {
              streamDelta: buildStreamDelta({
                content: '',
                reasoningContent: '',
                sessionStatus: 'completed',
                seq: streamState.seq,
                isFinal: true,
                cardId: streamState.cardId,
              }),
              extra: streamState.extra,
            },
          );
        }

        // 最终持久化卡片(规范 CardModel)+ 历史 command 消息
        if (this.sendFinalCard) {
          await this.sendFinalCard({
            targetId: streamState.targetId,
            convType: streamState.convType,
            senderUserId: streamState.senderUserId,
            cardId: streamState.cardId,
            fullContent: streamSafeContent(fullContent),
            reasoningContent: streamState.reasoningContent,
          });
        }

        this.log.info(`[EventHandler] session completed fullContent: ${fullContent}`);
        this.log.info(`[EventHandler] session completed reasoningContent: ${streamState.reasoningContent}`);

        // completed 终态：清空已发送长度计数
        streamState.fullContent = '';
        streamState.reasoningContent = '';
        streamState.streamedLength = 0;
        streamState.reasoningStreamedLength = 0;

        this.sentSessions.add(sessionId);
        this.streamStates.delete(sessionId);
        if (this.onStreamEnd) {
          try {
            this.onStreamEnd(streamState.cardId);
          } catch (err) {
            this.log.warn(`[EventHandler] onStreamEnd 回调异常: ${err.message}`);
          }
        }
        this.log.info(`[EventHandler] session 完成: ${sessionId}, seq=${streamState.seq}, contentLen=${fullContent.length}`);
      } catch (err) {
        this.log.error(`[EventHandler] session.idle 处理失败: ${err.message}, session=${sessionId}`);
      }
    });
  }

  /**
   * 处理 session.error —— 发 error 终态 + 错误卡片。
   * 参考 opencode-clawmessenger event-handler.ts:916-964。
   * @param {Object} properties { sessionID?, error }
   */
  async _handleSessionError(properties) {
    const sessionId = properties.sessionID || properties.sessionId;
    if (!sessionId) return;
    if (this.sentSessions.has(sessionId)) return;

    const streamState = this.streamStates.get(sessionId);

    // 提取错误消息
    let errorMessage;
    if (typeof properties.error === 'string') {
      errorMessage = properties.error;
    } else if (properties.error?.data?.message) {
      errorMessage = properties.error.data.message;
    } else if (properties.error?.message) {
      errorMessage = properties.error.message;
    } else {
      errorMessage = 'AI 处理失败,请稍后重试';
    }

    const cardId = streamState?.cardId;
    const targetId = streamState?.targetId;
    const convType = streamState?.convType || 1;
    const senderUserId = streamState?.senderUserId || '';
    const streamId = streamState?.streamId;

    // 如果已流式过,先发 error 终态尾流
    if (streamState && streamId && this.sendStreamChunk && streamState.hasSentStream) {
      await this._enqueueStreamTask(sessionId, async () => {
        try {
          streamState.seq += 1;
          await this.sendStreamChunk(
            targetId,
            streamId,
            false,
            true,
            streamState.seq,
            {
              streamDelta: buildStreamDelta({
                sessionStatus: 'error',
                seq: streamState.seq,
                isFinal: true,
                error: errorMessage,
                reasoningContent: streamState.reasoningContent,
                cardId: streamState.cardId,
              }),
            },
          );
        } catch (err) {
          this.log.error(`[EventHandler] error 终态发送失败: ${err.message}`);
        }
      });
    }

    // 发错误卡片
    if (this.sendErrorCard && cardId && targetId) {
      try {
        await this.sendErrorCard({ targetId, convType, senderUserId, cardId, error: errorMessage });
      } catch (err) {
        this.log.error(`[EventHandler] 错误卡片发送失败: ${err.message}`);
      }
    }

    this.sentSessions.add(sessionId);
    this.streamStates.delete(sessionId);
    if (cardId && this.onStreamEnd) {
      try {
        this.onStreamEnd(cardId);
      } catch (err) {
        this.log.warn(`[EventHandler] onStreamEnd 回调异常: ${err.message}`);
      }
    }
    this.log.error(`[EventHandler] session 错误: ${sessionId}, msg=${errorMessage}`);
  }
}

module.exports = { EventHandler };
