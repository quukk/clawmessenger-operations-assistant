/**
 * 消息体积估算工具。
 *
 * 融云自定义消息单条建议 ≤ 5 KB（5,120 字节），本工具提供统一的大小估算
 * 与卡片截断辅助函数，供 card_message / card_update 发送前自检。
 */

'use strict';

/** 安全阈值（4 KB），超过此值即开始截断 / 拆分。 */
const SAFE_LIMIT = 4096;
/** 融云硬上限（5 KB），超过此值不允许发送。 */
const HARD_LIMIT = 5120;
/** markdown 段落首次截断目标字节数。 */
const MAX_MD_BYTES = 1500;
/** markdown 段落最小保留字节数。 */
const MIN_MD_BYTES = 200;
/** 表格最多保留行数。 */
const MAX_TABLE_ROWS = 10;
/** 按钮行最多保留按钮数。 */
const MAX_BUTTON_ROW_BUTTONS = 10;

/**
 * 估算任意 JSON 对象序列化后的 UTF-8 字节长度。
 *
 * 优先使用 Node.js Buffer.byteLength；无 Buffer 环境用字符编码近似。
 *
 * @param {any} payload
 * @returns {number} 字节数
 */
function estimateMessageSize(payload) {
  try {
    if (typeof Buffer !== 'undefined' && typeof Buffer.byteLength === 'function') {
      return Buffer.byteLength(JSON.stringify(payload), 'utf8');
    }
  } catch (e) {
    // 无 Buffer 环境降级
  }

  const str = JSON.stringify(payload);
  let size = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 0x80) {
      size += 1;
    } else if (code < 0x800) {
      size += 2;
    } else if (code < 0x10000) {
      size += 3;
    } else {
      size += 4;
    }
  }
  return size;
}

/**
 * 按 UTF-8 字节截断文本，并在末尾追加 "..."。
 *
 * @param {string} text
 * @param {number} maxBytes
 * @returns {string}
 */
function truncateTextToBytes(text, maxBytes) {
  if (!text || typeof text !== 'string') return text;
  const suffix = '...';
  const suffixBytes = estimateMessageSize(suffix);

  let result = '';
  let bytes = 0;
  for (const char of text) {
    const charBytes =
      typeof Buffer !== 'undefined' && typeof Buffer.byteLength === 'function'
        ? Buffer.byteLength(char, 'utf8')
        : (char.charCodeAt(0) < 0x80 ? 1 : char.charCodeAt(0) < 0x800 ? 2 : 3);

    if (bytes + charBytes + suffixBytes > maxBytes) {
      break;
    }
    result += char;
    bytes += charBytes;
  }

  return result + suffix;
}

/**
 * 截断卡片消息 payload，使其尽量低于安全阈值。
 *
 * 策略：
 * 1. 保留 markdown / buttonRow / table 三类 section；删除其余非关键 section。
 * 2. markdown 内容截断到 MAX_MD_BYTES 并加 "..."；仍超限时逐步减半直到 MIN_MD_BYTES。
 * 3. table 行数最多保留 MAX_TABLE_ROWS。
 * 4. buttonRow 按钮最多保留 MAX_BUTTON_ROW_BUTTONS。
 * 5. 最后追加 note："部分内容已截断，原消息超过融云单条限制"。
 *
 * 本函数不修改原始 payload，返回新的 payload 对象。
 *
 * @param {Object} payload
 * @returns {Object}
 */
function truncateCardPayload(payload) {
  const result = { ...payload };
  let sections = (result.sections || []).map((s) => ({ ...s }));

  // 仅保留关键 section 类型
  sections = sections.filter((s) => {
    if (s.kind === 'markdown') return true;
    if (s.kind === 'buttonRow') return true;
    if (s.kind === 'table') return true;
    return false;
  });

  // 首次截断
  for (const s of sections) {
    if (s.kind === 'markdown' && typeof s.content === 'string') {
      s.content = truncateTextToBytes(s.content, MAX_MD_BYTES);
    }
    if (s.kind === 'buttonRow' && Array.isArray(s.buttons)) {
      s.buttons = s.buttons.slice(0, MAX_BUTTON_ROW_BUTTONS);
    }
    if (s.kind === 'table' && Array.isArray(s.rows)) {
      s.rows = s.rows.slice(0, MAX_TABLE_ROWS);
    }
  }

  // 追加截断提示
  sections.push({ kind: 'note', text: '部分内容已截断，原消息超过融云单条限制' });
  result.sections = sections;

  // 仍超安全阈值时，逐步压缩 markdown 到 MIN_MD_BYTES
  let size = estimateMessageSize(result);
  while (size > SAFE_LIMIT) {
    let reduced = false;
    for (const s of sections) {
      if (s.kind === 'markdown' && typeof s.content === 'string') {
        const currentBytes = estimateMessageSize(s.content);
        if (currentBytes > MIN_MD_BYTES) {
          const nextMax = Math.max(MIN_MD_BYTES, Math.floor(currentBytes / 2));
          s.content = truncateTextToBytes(s.content, nextMax);
          reduced = true;
        }
      }
    }
    if (!reduced) break;
    size = estimateMessageSize(result);
  }

  return result;
}

module.exports = {
  SAFE_LIMIT,
  HARD_LIMIT,
  MAX_MD_BYTES,
  MIN_MD_BYTES,
  MAX_TABLE_ROWS,
  MAX_BUTTON_ROW_BUTTONS,
  estimateMessageSize,
  truncateTextToBytes,
  truncateCardPayload,
};
