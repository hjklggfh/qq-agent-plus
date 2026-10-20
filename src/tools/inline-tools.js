// 内联工具调用解析：少数模型不返回原生 tool_calls，而是把调用写进文本。
// 从 orchestrator.js 抽出来共享给各判断类模块（表情判断 / 空间互动 / 每日说说 / 身份与关系评估）。
// 支持格式：
//   1. <tool_call> <function=send_message> <parameter=messages>…</parameter> </function> </tool_call>
//   2. <tool_call> {"name":"send_message","arguments":{...}} </tool_call>
//   3. <tool_call> send_message \n {"messages":"..."} </tool_call>
//   4. 整段就是一个带 name 的 JSON（没有 <tool_call> 包裹）
//   5. <tool_call>send_message<arg_key>messages</arg_key><arg_value>["..."]</arg_value></tool_call>

/**
 * `arguments` 经常是 **JSON 字符串**（OpenAI 的 function.arguments 就是这个形态）：
 * 原来按「非对象 → {}」一判就整包丢掉，工具拿到空参数，消息根本没发出去
 *（2026-10-04 全面复审 P3）。先试着解一次字符串，解不出再按空对象。
 * ⚠️ 两个入口（<tool_call> 包裹 / 整段裸 JSON 的兜底）都要走这里：只修一处时另一种
 * 形态照样整包丢（2026-10-05 全审：格式 4 的兜底还是旧判据，却已有注释声称支持）。
 */
function normalizeArgs(rawArgs) {
  if (typeof rawArgs !== 'string') return rawArgs;
  const text = rawArgs.trim();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return {}; }
}

function parseInlineBlock(block) {
  // 1) 整个块是 JSON：{"name": "...", "arguments": {...}}（部分模型用 parameters/args）
  const jsonMatch = block.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]);
      const name = obj.name || obj.function || obj.tool;
      const args = normalizeArgs(obj.arguments || obj.parameters || obj.args || obj.input || {});
      if (name) return { name: String(name), args: (args && typeof args === 'object' && !Array.isArray(args)) ? args : {} };
    } catch { /* 不是 JSON，继续按 XML 解析 */ }
  }

  // 2) <function=send_message> + <parameter=key>value</parameter>
  const fnMatch = block.match(/<function\s*=\s*([^>]+)>/i);
  let name = fnMatch ? fnMatch[1].trim().replace(/^["']|["']$/g, '') : '';
  const args = {};
  const paramRe = /<parameter\s*=\s*([^>]+)>([\s\S]*?)<\/parameter>/gi;
  let pm;
  while ((pm = paramRe.exec(block)) !== null) {
    const key = pm[1].trim().replace(/^["']|["']$/g, '');
    let value = pm[2].trim();
    try { value = JSON.parse(value); } catch { /* 保持原始文本 */ }
    args[key] = value;
  }
  if (name && fnMatch) return { name, args };

  // 3) 部分模型使用连续的 arg_key/arg_value 标签，函数名直接写在块开头。
  // 只接受整个块由函数名和成对参数组成，避免从普通叙述中误提取发送指令。
  const pairRe = /<arg_key>\s*([^<]+?)\s*<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/gi;
  const pairs = [...block.matchAll(pairRe)];
  if (pairs.length) {
    const prefix = block.slice(0, pairs[0].index).trim();
    const remainder = block.replace(pairRe, '').trim();
    if (/^[a-zA-Z_][\w.-]*$/.test(prefix) && remainder === prefix
      && pairs.every((pair) => /^[a-zA-Z_][\w.-]*$/.test(pair[1].trim()))) {
      const pairArgs = {};
      for (const pair of pairs) {
        let value = pair[2].trim();
        try { value = JSON.parse(value); } catch { /* 非 JSON 参数保留原文 */ }
        pairArgs[pair[1].trim()] = value;
      }
      return { name: prefix, args: pairArgs };
    }
  }

  // 4) 首行是函数名，其余是 JSON 参数（GLM/Qwen 部分格式）
  const lines = block.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!name && lines.length >= 2 && /^[a-zA-Z_][\w.-]*$/.test(lines[0])) {
    name = lines[0];
    try {
      const parsed = JSON.parse(lines.slice(1).join('\n'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { name, args: parsed };
    } catch { /* ignore */ }
  }
  return null;
}

export function parseInlineToolCalls(text) {
  const out = [];
  const blockRe = /<tool_call\b[^>]*>([\s\S]*?)<\/tool_call>/gi;
  let match;
  while ((match = blockRe.exec(String(text || ''))) !== null) {
    const block = match[1].trim();
    if (!block) continue;
    const call = parseInlineBlock(block);
    if (call) out.push(call);
  }
  return out;
}

/**
 * 统一取一次响应里的工具调用，返回 OpenAI 结构（照旧读 call.function.name / arguments）。
 * 优先原生 tool_calls；没有就解析文本里的内联调用（含"整段是带 name 的 JSON"这一种）。
 */
export function resolveToolCalls(message) {
  const structured = Array.isArray(message?.tool_calls) ? message.tool_calls.filter(Boolean) : [];
  if (structured.length) return structured;
  const text = typeof message?.content === 'string' ? message.content : '';
  if (!text) return [];
  let parsed = /<tool_call/i.test(text) ? parseInlineToolCalls(text) : [];
  if (!parsed.length) {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const obj = JSON.parse(jsonMatch[0]);
        const name = obj.name || obj.function || obj.tool;
        // ⚠️ 这里同样要解字符串形态的 arguments（走 normalizeArgs）：裸 JSON 兜底原先按
        // 「非对象 → 丢弃」，模型把 arguments 写成 JSON 字符串时整条调用被吞掉，
        // qzone/说说这类判断方会一直收到"必须调用 submit…"直到轮次耗尽失败（2026-10-05 全审）。
        const args = normalizeArgs(obj.arguments || obj.parameters || obj.args || obj.input);
        if (name && args && typeof args === 'object' && !Array.isArray(args)) {
          parsed = [{ name: String(name), args }];
        }
      } catch { /* 不是 JSON，当普通文本 */ }
    }
  }
  return parsed.map((call, index) => ({
    id: `inline_${index + 1}`,
    type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) }
  }));
}
