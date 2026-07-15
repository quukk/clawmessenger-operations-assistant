/**
 * 文本内嵌卡片标记解析器(JS 版)。
 *
 * 从 opencode-clawmessenger/src/cardkit/parse-marker.ts 翻译而来。
 * 扫描逻辑、边界判定必须与 TS 版逐字一致(平衡括号扫描,不用正则)。
 *
 * agent 在回复文本里用 [CARD][{...JSON...}] 嵌入卡片。由于卡片 JSON 必然含
 * 嵌套对象(header/sections/buttons/action 等),无法用单个正则正确界定边界
 * (lazy 正则会在第一个嵌套 }处截断,贪婪正则会越界)。
 *
 * 本模块用平衡括号扫描器从 [CARD][ 起点找到配对的 ],正确处理:
 *  - 嵌套对象/数组
 *  - 字符串内的 }、]、"(转义感知)
 *  - 标记后跟正文文字(卡片不必在文本末尾)
 */

'use strict';

/**
 * 解析出的标记结果。
 * @typedef {Object} ParsedMarker
 * @property {unknown} data 解析出的对象(JSON.parse 结果)
 * @property {number} start 标记在原文中的完整区间起点(含 [TAG][)
 * @property {number} end 标记在原文中的完整区间终点(含闭合 ])
 */

/**
 * 从指定位置扫描一个平衡的 JSON 值(对象或数组),返回其结束位置(闭合符之后)。
 *
 * @param {string} text  原文
 * @param {number} start JSON 起始位置(指向 { 或 [)
 * @returns {number} 闭合符之后的索引;若未找到配对返回 -1
 */
function findJsonEnd(text, start) {
  const open = text[start];
  const close = open === '{' ? '}' : open === '[' ? ']' : '';
  if (!close) return -1;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    // 字符串内:转义感知
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) return i + 1; // 闭合符之后
    }
  }
  return -1; // 未配对
}

/**
 * 从文本中提取所有 [TAG][...] 标记,TAG 为指定前缀(如 'CARD' 或 'COMMANDS')。
 * 用平衡括号扫描,正确处理嵌套 JSON 与尾随文本。
 *
 * @param {string} text  原文
 * @param {string} tag   标记名(不含方括号),如 'CARD'
 * @returns {ParsedMarker[]} 解析结果数组
 */
function extractMarkers(text, tag) {
  const results = [];
  const opener = `[${tag}][`;
  let searchFrom = 0;

  while (true) {
    const tagStart = text.indexOf(opener, searchFrom);
    if (tagStart === -1) break;

    const jsonStart = tagStart + opener.length;
    if (jsonStart >= text.length) break;

    const jsonChar = text[jsonStart];
    // JSON 必须以 { 或 [ 开头
    if (jsonChar !== '{' && jsonChar !== '[') {
      searchFrom = tagStart + opener.length;
      continue;
    }

    const jsonEnd = findJsonEnd(text, jsonStart);
    if (jsonEnd === -1) {
      // JSON 未闭合,跳过此标记
      searchFrom = tagStart + opener.length;
      continue;
    }

    const jsonStr = text.slice(jsonStart, jsonEnd);
    // 标记格式必须是 [TAG][{...}],JSON 后必须紧跟闭合 ]。
    // 若缺闭合 ] 视为畸形标记,跳过(不剥离,避免残留孤立的 ])。
    if (text[jsonEnd] !== ']') {
      searchFrom = jsonEnd;
      continue;
    }
    try {
      const data = JSON.parse(jsonStr);
      // 完整区间: [TAG][ 到闭合 ] (含闭合符)
      results.push({ data, start: tagStart, end: jsonEnd + 1 });
    } catch {
      // JSON 非法,跳过
    }

    searchFrom = jsonEnd;
  }

  return results;
}

/**
 * 从文本中剥离所有标记区间,返回去除标记后的纯文本。
 * @param {string} text
 * @param {ParsedMarker[]} markers
 * @returns {string}
 */
function stripMarkers(text, markers) {
  if (markers.length === 0) return text;
  // 按起点降序删除,避免索引偏移
  const sorted = [...markers].sort((a, b) => b.start - a.start);
  let result = text;
  for (const m of sorted) {
    result = result.slice(0, m.start) + result.slice(m.end);
  }
  return result.trim();
}

/**
 * 剥离模型输出中可能混入的 orchestrator/系统标签。
 * 处理完整标签对、自闭合标签与嵌套同名标签，并截断未闭合的开口。
 * @param {string} text
 * @returns {string}
 */
function stripOrchestratorTags(text) {
  let result = '';
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('<', i);
    if (open === -1) {
      result += text.slice(i);
      break;
    }
    result += text.slice(i, open);
    const close = text.indexOf('>', open);
    if (close === -1) {
      break;
    }
    const tag = text.slice(open, close + 1);
    const openMatch = tag.match(/^<(dcp-[^>\s/]*)\s*(\/?)?>$/);
    if (!openMatch) {
      result += tag;
      i = close + 1;
      continue;
    }
    const tagName = openMatch[1];
    if (tag.endsWith('/>')) {
      i = close + 1;
      continue;
    }
    const endTag = `</${tagName}>`;
    let depth = 1;
    let search = close + 1;
    let endIdx = -1;
    while (search < text.length) {
      const nextOpen = text.indexOf('<', search);
      if (nextOpen === -1) break;
      const nextClose = text.indexOf('>', nextOpen);
      if (nextClose === -1) break;
      const nextTag = text.slice(nextOpen, nextClose + 1);
      const nextMatch = nextTag.match(/^<(dcp-[^>\s/]*)\s*(\/?)?>$/);
      if (nextMatch && nextMatch[1] === tagName) {
        if (nextTag.endsWith('/>')) {
          search = nextClose + 1;
        } else {
          depth++;
          search = nextClose + 1;
        }
      } else if (nextTag === endTag) {
        depth--;
        if (depth === 0) {
          endIdx = nextOpen;
          break;
        }
        search = nextClose + 1;
      } else {
        search = nextClose + 1;
      }
    }
    if (endIdx === -1) {
      break;
    }
    i = endIdx + endTag.length;
  }
  return result;
}

/**
 * 流式安全内容:给定累积内容,返回"剥离所有卡片标记后"的安全流式正文。
 *
 * 用于流式场景:
 *  - 已完整闭合的 `[CARD][{...}]` 标记 → 整段剥离(标记不流式,由 idle 时单独发卡片)
 *  - 进行中(未闭合)的 `[CARD][...` 标记 → 从其起始处截断(后续不流式,避免闪烁)
 *  - 其余正文 → 保留,正常流式发送
 *
 * 与 streamSafeBoundary 的区别:本函数处理"标记闭合后正文恢复"的场景——
 * 之前的实现只在 boundary 处切片,导致标记闭合瞬间把缓冲的标记补发出去;
 * 本函数直接返回剥离标记后的纯净正文,event-handler 据此算增量,彻底避免标记泄漏。
 *
 * @param {string} content 累积的完整流式内容(含标记)
 * @returns {string} 剥离所有标记后的安全流式正文
 */
function streamSafeContent(content) {
  // 先剥离 orchestrator 系统标签，避免模型输出中的系统提示泄露给用户
  const sanitized = stripOrchestratorTags(content);
  // 支持的标记 opener:新协议 [CARD][ 与旧协议 [COMMANDS][ 都缓冲
  const openers = ['[CARD][', '[COMMANDS]['];
  let result = '';
  let i = 0;

  while (i < sanitized.length) {
    // 找最早的 opener(任一标记)
    let nextMarker = -1;
    let opener = '';
    for (const op of openers) {
      const idx = sanitized.indexOf(op, i);
      if (idx !== -1 && (nextMarker === -1 || idx < nextMarker)) {
        nextMarker = idx;
        opener = op;
      }
    }
    if (nextMarker === -1) {
      // 无更多标记,追加剩余正文
      result += sanitized.slice(i);
      break;
    }

    // 追加标记前的正文
    result += sanitized.slice(i, nextMarker);

    // 检查这个标记是否已闭合
    const jsonStart = nextMarker + opener.length;
    if (jsonStart >= sanitized.length) {
      // opener 在末尾,JSON 还没开始 → 进行中,截断(不追加 opener)
      break;
    }

    const jsonChar = sanitized[jsonStart];
    if (jsonChar !== '{' && jsonChar !== '[') {
      // opener 后非 JSON 起始,视为普通文本(罕见),跳过 opener 继续
      result += opener;
      i = jsonStart;
      continue;
    }

    const jsonEnd = findJsonEnd(sanitized, jsonStart);
    if (jsonEnd === -1) {
      // JSON 未闭合 → 进行中,截断(不追加标记)
      break;
    }

    if (sanitized[jsonEnd] !== ']') {
      // JSON 闭合但缺闭合符 ] → 畸形进行中,截断
      break;
    }

    // 标记完整闭合:跳过整个标记(含闭合 ]),不追加到 result
    i = jsonEnd + 1;
  }

  // 前视缓冲:结果末尾若是任一 opener 的部分前缀,也要截断
  // (后续字符可能补全为完整 opener,此时已发出的部分会泄漏)
  return trimTrailingDcpTagPrefix(trimTrailingOpenerPrefix(result));
}

/**
 * 截断末尾的 opener 部分前缀。
 * 检查所有已知 opener([CARD][ / [COMMANDS][)的真前缀,取最长匹配截断。
 * @param {string} text
 * @returns {string}
 */
function trimTrailingOpenerPrefix(text) {
  const openers = ['[CARD][', '[COMMANDS]['];
  let cut = 0;
  for (const opener of openers) {
    for (let len = Math.min(opener.length - 1, text.length); len >= 1; len--) {
      const tail = text.slice(text.length - len);
      if (opener.startsWith(tail)) {
        cut = Math.max(cut, len);
        break; // 该 opener 取最长前缀即可
      }
    }
  }
  return cut > 0 ? text.slice(0, text.length - cut) : text;
}

/**
 * 截断末尾的 orchestrator/dcp 标签部分前缀。
 * 检查所有 <dcp-...> / </dcp-...> 标签的前缀，防止 token 级流式把系统标签
 * 的碎片泄漏给用户。
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
 * 流式安全边界:给定累积内容,返回"不含任何进行中卡片标记"的最长前缀长度。
 *
 * @deprecated 改用 streamSafeContent(正确处理标记闭合后正文恢复)。
 * 保留供测试兼容。
 *
 * @param {string} content
 * @returns {number}
 */
function streamSafeBoundary(content) {
  const opener = '[CARD][';
  let searchFrom = content.length;
  while (searchFrom > 0) {
    const idx = content.lastIndexOf(opener, searchFrom - 1);
    if (idx === -1) break;

    const jsonStart = idx + opener.length;
    if (jsonStart >= content.length) return idx;

    const jsonChar = content[jsonStart];
    if (jsonChar !== '{' && jsonChar !== '[') {
      searchFrom = idx;
      continue;
    }

    const jsonEnd = findJsonEnd(content, jsonStart);
    if (jsonEnd === -1) return idx;
    if (content[jsonEnd] === ']') {
      searchFrom = idx;
      continue;
    }
    return idx;
  }
  return content.length;
}

module.exports = {
  findJsonEnd,
  extractMarkers,
  stripMarkers,
  streamSafeContent,
  trimTrailingOpenerPrefix,
  stripOrchestratorTags,
  trimTrailingDcpTagPrefix,
  streamSafeBoundary,
};
