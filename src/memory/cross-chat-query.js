import { shanghaiDayStart, safeSlice } from '../core/util.js';

// Deterministic query planning: no model, tokenizer service or extra request.
export function planRecallQuery(raw = '', now = Date.now()) {
  const text = safeSlice(String(raw).replace(/\[CQ:[^\]]*\]/g, ' '), 300).toLowerCase();
  const day = shanghaiDayStart(now);
  let since = null; let until = now;
  if (/前天/.test(text)) { since = day - 2 * 86400000; until = day - 86400000 - 1; }
  else if (/昨天|昨晚/.test(text)) { since = day - 86400000; until = day - 1; }
  else if (/今天|今晚/.test(text)) since = day;
  else if (/上周|上星期/.test(text)) {
    const weekday = new Date(day + 8 * 3600000).getUTCDay() || 7;
    const weekStart = day - (weekday - 1) * 86400000;
    since = weekStart - 7 * 86400000; until = weekStart - 1;
  }
  else if (/最近|这几天/.test(text)) since = day - 7 * 86400000;
  const sourceKind = /私聊|私信/.test(text) ? 'private' : /群里|群聊/.test(text) ? 'group' : '';
  const phrase = text.replace(/前天|昨天|昨晚|今天|今晚|上周|上星期|最近|这几天|私聊|私信|群里|群聊/g, ' ')
    .replace(/是什么|什么意思|还记得|记不记得|记得|上次|刚才|之前|那个|这个|说的|聊过|聊的|继续|接着|聊聊|的|呢|吗|啊|吧|我|你|我们|你们/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  const terms = [];
  for (const word of phrase.match(/[a-z0-9_]{2,}|[\u3400-\u9fff]{2,}/g) || []) {
    terms.push(word);
    if (/^[\u3400-\u9fff]+$/.test(word)) for (let i = 0; i < word.length - 1; i++) terms.push(word.slice(i, i + 2));
  }
  return { phrase: safeSlice(phrase, 100), terms: [...new Set(terms)].slice(0, 20), since, until, sourceKind };
}
export function recallRelevance(text, plan) {
  if (!plan.terms.length) return 0;
  const body = String(text).toLowerCase();
  const matches = plan.terms.filter(term => body.includes(term));
  return matches.reduce((score, term) => score + Math.min(6, term.length), 0) + (plan.phrase && body.includes(plan.phrase) ? 6 : 0);
}
export function recallSnippet(text, plan, limit = 240) {
  const clean = String(text);
  const positions = plan.terms.map(term => clean.toLowerCase().indexOf(term)).filter(index => index >= 0);
  const start = positions.length ? Math.max(0, Math.min(...positions) - 50) : 0;
  return safeSlice((start ? '…' : '') + clean.slice(start).replace(/^[\uDC00-\uDFFF]/, ''), limit);
}
