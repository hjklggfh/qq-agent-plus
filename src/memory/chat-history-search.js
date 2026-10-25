import { getConfig } from '../core/config.js';
import { chatAllowed } from '../core/access.js';
import { assertTimeAllowed } from '../core/time-gate.js';
import { safeSlice, sanitizeUserText } from '../core/util.js';
import { recallParticipants, recallAvailable } from './cross-chat-recall.js';
import { chatRecallRule, recallPolicyKey, crossChatSettings } from './cross-chat-policy.js';
import { planRecallQuery, recallRelevance, recallSnippet } from './cross-chat-query.js';

function dateBound(value, end = false) {
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new Error('日期必须为YYYY-MM-DD或带时区的ISO时间');
  const day = /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (!day && !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw new Error('日期格式无效');
  const at = Date.parse(day ? `${value}T00:00:00+08:00` : value);
  if (!Number.isFinite(at) || (day && new Date(at + 8 * 3600000).toISOString().slice(0, 10) !== value)) throw new Error('日期无效');
  return at + (day && end ? 86400000 - 1 : 0);
}
function historyScope(ctx, source, cfg) {
  if (!/^(group|private):\d{1,15}$/.test(source) || !chatAllowed(ctx.chatKey, cfg) || !chatAllowed(source, cfg)) throw new Error('该会话不在允许范围内');
  if (source === ctx.chatKey) return { cross: false, participants: [] };
  const rule = chatRecallRule(cfg, source);
  if (!recallAvailable(cfg, ctx.chatKey) || !rule.allowSource || rule.privacy
    || (source.startsWith('private:') && ctx.chatKey.startsWith('group:') && cfg.memory?.visibility?.hidePrivateInGroup === true)) throw new Error('隐私规则禁止跨窗口读取历史');
  const participants = recallParticipants(ctx);
  if (!participants.length || (source.startsWith('private:') && !participants.includes(source.split(':')[1]))) throw new Error('只能跨窗口检索本轮说话者的记录');
  return { cross: true, participants };
}
function visibleRow(row, ctx, source, scope, cfg) {
  if (row.eventKind === 'game-secret') return false;
  const blocked = (cfg.blocklist?.[source.split(':')[1]] || []).map(String);
  const targetBlocked = (cfg.blocklist?.[ctx.chatKey.split(':')[1]] || []).map(String);
  if (!row.self && (blocked.includes(row.senderId) || targetBlocked.includes(row.senderId))) return false;
  if (row.self && row.targetUserId && (blocked.includes(row.targetUserId) || targetBlocked.includes(row.targetUserId))) return false;
  if (scope.cross) {
    if (!row.self && !scope.participants.includes(row.senderId)) return false;
    if (row.self && !scope.participants.includes(row.targetUserId) && source !== `private:${scope.participants[0]}`) return false;
  }
  return !(cfg.memory?.crossChat?.excludedMessages || []).some(ref => ref.chatKey === source && ref.id === row.localId);
}
function qqRow(message, ctx, source) {
  const [kind, peer] = source.split(':');
  const mid = String(message?.message_id ?? '');
  const ts = Number(message?.time) * 1000;
  if (!/^-?\d{1,16}$/.test(mid) || !Number.isSafeInteger(Number(mid)) || !Number.isSafeInteger(ts) || ts <= 0 || ts > 8640000000000000) return null;
  if (message.message_type !== kind || (kind === 'group' && String(message.group_id) !== peer)) return null;
  const senderId = String(message.sender?.user_id ?? message.user_id ?? '');
  if (!/^\d{1,15}$/.test(senderId)) return null;
  const known = ctx.store?.findByMid?.(source, mid);
  const self = senderId === String(ctx.selfId) || known?.self === true;
  if (kind === 'private') {
    if (!self && senderId !== peer) return null;
    if (self && (!known || known.eventKind === 'game-secret')) return null;
    if (self && message.target_id != null && String(message.target_id) !== peer) return null;
  }
  let text = '';
  if (Array.isArray(message.message)) text = message.message.filter(segment => segment?.type === 'text')
    .map(segment => safeSlice(String(segment.data?.text || ''), 8000)).join(' ');
  else text = String(message.raw_message || message.message || '').replace(/\[CQ:[^\]]*\]/g, ' ');
  text = safeSlice(sanitizeUserText(text).replace(/\s+/g, ' ').trim(), 8000);
  if (!text) return null;
  return { messageId: mid, ts, text, senderId, senderName: sanitizeUserText(String(message.sender?.card || message.sender?.nickname || senderId)),
    self, targetUserId: known?.targetUserId || '', localId: known?.id, eventKind: known?.eventKind || 'message', source: 'qq-history-api' };
}

/** Read-only retrieval. QQ exposes anchored history pages, not a native keyword-search action. */
export async function searchChatHistory(ctx, args = {}, options = {}) {
  const config = options.config || getConfig;
  const now = options.now || Date.now;
  assertTimeAllowed();
  ctx.signal?.throwIfAborted();
  const cfg = config(); const policy = recallPolicyKey(cfg);
  const source = String(args.chatKey || ctx.chatKey);
  const scope = historyScope(ctx, source, cfg);
  if (typeof args.query !== 'string') throw new Error('关键词必须是字符串');
  const query = safeSlice(args.query.trim(), 120);
  const plan = planRecallQuery(query, now());
  if (!plan.terms.length) throw new Error('请给出具体关键词，例如服务器、部署、游戏名称');
  const since = Math.max(0, dateBound(args.since) ?? plan.since ?? 0,
    scope.cross ? now() - crossChatSettings(cfg).lookbackDays * 86400000 : 0);
  const until = Math.min(now(), dateBound(args.until, true) ?? plan.until);
  if (since > until) throw new Error('起止时间范围无效，或超出跨窗口回看范围');
  let cursor = String(args.beforeMessageId ?? '').trim().replace(/^#+/, '');
  if (cursor && (!/^-?\d{1,16}$/.test(cursor) || !Number.isSafeInteger(Number(cursor)) || Number(cursor) === 0)) throw new Error('翻页锚点必须为真实QQ消息ID，负数需原样保留');
  const budget = ctx.session.historySearchBudget ||= { calls: 0, pages: 0 };
  if (budget.calls >= 2 || budget.pages >= 8) throw new Error('本轮历史检索已达上限，请依据已有结果或下轮继续');
  budget.calls++;
  const pageLimit = Math.min(4, Math.max(1, Number(args.pages) || 4), 8 - budget.pages);
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(18000)]) : AbortSignal.timeout(18000);
  const assertPolicy = () => {
    signal.throwIfAborted();
    if (recallPolicyKey(config()) !== policy) throw new Error('历史读取期间隐私或访问范围已改变，已停止返回结果');
  };
  const archive = ctx.store?.searchHistoryMessages?.(source, { terms: plan.terms, since, until }) || { rows: [], truncated: false };
  let automaticAnchor = false;
  if (!cursor && until < now() - 60000) {
    const anchor = ctx.store?.historyDateAnchor?.(source, since, until);
    if (anchor && /^-?\d{1,16}$/.test(String(anchor.mid)) && Number.isSafeInteger(Number(anchor.mid)) && Number(anchor.mid) !== 0) {
      cursor = String(anchor.mid); automaticAnchor = true;
    }
  }
  const rows = new Map();
  for (const row of archive.rows) if (visibleRow(row, ctx, source, scope, cfg)) rows.set(row.messageId, row);
  const coverage = { pages: 0, fetched: 0, oldest: null, newest: null, nextCursor: null, stopReason: 'page-limit',
    archiveTruncated: archive.truncated === true, qqAvailable: false,
    startedFrom: automaticAnchor ? 'known-date-anchor' : cursor ? 'cursor' : 'latest' };
  const seen = new Set(); const cursors = new Set();
  if (!ctx.onebot?.call) coverage.stopReason = 'qq-unavailable';
  else for (let page = 0; page < pageLimit; page++) {
    assertPolicy();
    if (cursors.has(cursor)) { coverage.stopReason = 'repeated-cursor'; break; }
    cursors.add(cursor);
    const [kind, id] = source.split(':');
    let data;
    try {
      budget.pages++;
      data = await ctx.onebot.call(kind === 'group' ? 'get_group_msg_history' : 'get_friend_msg_history', {
        [kind === 'group' ? 'group_id' : 'user_id']: Number(id), count: 50, message_id: cursor ? Number(cursor) : 0, reverse_order: true
      }, 10000, signal);
    } catch {
      assertPolicy(); coverage.stopReason = 'qq-error'; break;
    }
    assertPolicy();
    if (!Array.isArray(data?.messages)) { coverage.stopReason = 'invalid-response'; break; }
    coverage.qqAvailable = true; coverage.pages++;
    if (!data.messages.length) {
      // Protocol caches may not recognize an old stored anchor; try latest once instead of claiming no history.
      if (automaticAnchor) { automaticAnchor = false; cursor = ''; continue; }
      coverage.stopReason = 'available-history-end'; break;
    }
    automaticAnchor = false;
    const pageRows = data.messages.slice(0, 50).map(message => qqRow(message, ctx, source)).filter(Boolean);
    // Private self messages without a known safe origin are excluded, including unknown game secrets.
    const anchors = data.messages.slice(0, 50).filter(message => {
      if (!Number.isFinite(Number(message?.time)) || Number(message.time) <= 0 || !/^-?\d+$/.test(String(message.message_id))) return false;
      if (message.message_type !== kind) return false;
      return kind === 'group' ? String(message.group_id) === id
        : String(message.user_id) === id || String(message.target_id) === id;
    }).sort((a, b) => Number(a.time) - Number(b.time));
    let added = 0;
    for (const message of anchors) {
      const mid = String(message.message_id);
      if (!seen.has(mid)) { seen.add(mid); added++; }
      coverage.oldest = Math.min(coverage.oldest ?? Infinity, Number(message.time) * 1000);
      coverage.newest = Math.max(coverage.newest ?? 0, Number(message.time) * 1000);
    }
    coverage.fetched = seen.size;
    for (const row of pageRows) if (row.ts >= since && row.ts <= until && visibleRow(row, ctx, source, scope, cfg)) rows.set(row.messageId, row);
    if (!anchors.length || !added) { coverage.stopReason = 'no-progress'; break; }
    cursor = String(anchors[0].message_id); coverage.nextCursor = cursor;
    if (coverage.oldest < since) { coverage.stopReason = 'date-boundary'; break; }
  }
  assertPolicy();
  const all = [...rows.values()].sort((a, b) => a.ts - b.ts);
  const ranked = all.map((row, index) => ({ row, index, score: recallRelevance(row.text, plan) }))
    .filter(hit => hit.score > 0).sort((a, b) => b.score - a.score || b.row.ts - a.row.ts).slice(0, 6);
  const selected = []; const selectedIds = new Set();
  const result = { query, chatKey: source, crossChat: scope.cross, coverage, messages: selected,
    note: '按关键词检索原文。QQ接口为分页读取后筛选，可能使用协议端缓存；未找到不等于从未聊过。来源区分QQ接口与agent存档；跨窗口消息ID不可用于当前窗口引用。' };
  const charLimit = Math.max(800, Math.min(3000, crossChatSettings(cfg).maxChars * 2));
  const append = (row, matched) => {
    if (!row || selectedIds.has(row.messageId) || selected.length >= 8) return;
    const entry = { messageId: row.messageId, time: new Date(row.ts).toISOString(), senderId: row.senderId,
      sender: row.self ? '我' : safeSlice(sanitizeUserText(row.senderName), 40), text: recallSnippet(sanitizeUserText(row.text).replace(/\s+/g, ' '), plan, matched ? 320 : 180),
      source: row.source, matched };
    selected.push(entry);
    if (JSON.stringify(result).length > charLimit) selected.pop();
    else selectedIds.add(row.messageId);
  };
  for (const hit of ranked) append(hit.row, true);
  for (const hit of ranked) for (const neighbor of [all[hit.index - 1], all[hit.index + 1]]) {
    if (neighbor && Math.abs(neighbor.ts - hit.row.ts) <= 300000) append(neighbor, false);
  }
  selected.sort((a, b) => a.time.localeCompare(b.time));
  if (scope.cross && selected.length) ctx.session.crossChatRecalled = true;
  (ctx.session.historySearches ||= []).push({ query, chatKey: source, at: now(), returned: selected.length,
    chars: JSON.stringify(result).length, coverage });
  return result;
}
