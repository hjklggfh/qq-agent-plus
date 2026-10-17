// 从自有 Pixiv 1.6.1 提取的下载、检索及分级算法；由宿主实例独立持有状态。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pixivFetch } from './network.js';
import { fetchRelayedImage } from './image-relay.js';

export function createPixivEngine(options) {
  let operationSignal;
  const networkFetch = options.fetchImpl || pixivFetch;
  function validRestriction(value) {
    return typeof value === 'number' && [0, 1, 2].includes(value)
      || typeof value === 'string' && /^[012]$/.test(value.trim());
  }
  function stripLoneSurrogates(value) {
    const s = String(value ?? '');
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = s.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) { out += s[i] + s[i + 1]; i += 1; continue; }
        continue;
      }
      if (code >= 0xdc00 && code <= 0xdfff) continue;
      out += s[i];
    }
    return out;
  }
  function safeSlice(value, max) {
    const s = String(value ?? '');
    const limit = Math.max(0, Math.floor(Number(max)) || 0);
    return limit >= s.length ? stripLoneSurrogates(s) : stripLoneSurrogates(s.slice(0, limit));
  }
  let api = null;
  let warn = (msg) => { try { api?.log?.warn?.(msg); } catch { /* 保留主流程。 */ } };
  let stateDir = '';
  let stateFile = '';
  let chatRatingsFile = '';
  function setStateDir(dir) {
    stateDir = String(dir ?? '').trim();
    stateFile = stateDir ? path.join(stateDir, 'state.json') : '';
    chatRatingsFile = stateDir ? path.join(stateDir, 'chat-ratings.json') : '';
    stateLoaded = false;
    chatRatingsCache = null;
    return stateDir;
  }
  const DEFAULTS = {
    enabled: true,
    searchBackend: 'auto',
    loliconApiUrl: 'https://api.lolicon.app/setu/v2',
    excludeAI: false,
    imageUrlTemplate: 'https://pixiv.re/{pid}.png',
    searchUrlTemplate: 'https://www.pixiv.net/ajax/search/artworks/{kw}?word={kw}&order=date_d&mode=all&p={page}&s_mode=s_tag&type=all&lang=zh',
    cookie: '',
    userAgent: '',
    proxyUrl: '',
    poolSize: 5,
    maxCount: 2,
    maxPages: 20,
    pageBudgetMs: 100000,
    forwardBudgetBytes: 8 * 1024 * 1024,
    downsampleOverBytes: 800 * 1024,
    downsampleMaxEdge: 1200,
    downsampleQuality: 5,
    pageRetryOnce: 1,
    ratings: ['safe'],
    allowR18: false,
    stateCap: 2000,
    timeoutMs: 15000,
    maxImageBytes: 5 * 1024 * 1024,
    imageSize: 'regular',
    retryCandidates: 3,
    deadTtlDays: 7,
    ownerIds: '',
    adminIds: ''
  };
  const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
  const MIME_EXT = {
    'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png',
    'image/webp': '.webp', 'image/gif': '.gif', 'image/avif': '.avif'
  };
  let settingsOverride = null;
  function __setSettingsForTest(override) {
    settingsOverride = (override && typeof override === 'object') ? override : null;
  }
  function settings() {
    const raw = settingsOverride || options.getSettings() || {};
    const out = { ...DEFAULTS };
    for (const [k, v] of Object.entries(raw)) {
      if (v !== undefined && v !== null) out[k] = v;
    }
    return out;
  }
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(n) || lo)));
  let seen = new Map();
  let dead = new Map();
  let stateLoaded = false;
  const numMap = (src) => new Map(
    Object.entries(src && typeof src === 'object' ? src : {})
      .filter(([k]) => /^\d+$/.test(k))
      .map(([k, v]) => [k, Number(v) || 0])
  );
  function loadState(file = stateFile) {
    if (stateLoaded && file === stateFile) return;
    stateLoaded = true;
    if (!file) return;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      seen = numMap(raw?.seen);
      dead = numMap(raw?.dead);
    } catch { /* 保留主流程。 */ }
  }
  function saveState(file = stateFile) {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const cap = Math.max(50, Math.round(Number(settings().stateCap) || 2000));
      const trim = (map) => (map.size > cap ? new Map([...map.entries()].sort((a, b) => a[1] - b[1]).slice(-cap)) : map);
      seen = trim(seen);
      dead = trim(dead);
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ seen: Object.fromEntries(seen), dead: Object.fromEntries(dead) }), 'utf8');
      fs.renameSync(tmp, file);
    } catch (error) {
      try { api?.log?.warn?.('PID 索引写入失败：', error?.message ?? error); } catch { /* 保留主流程。 */ }
    }
  }
  function markSeen(pid, at = Date.now()) {
    seen.set(String(pid), at);
    dead.delete(String(pid));
    saveState();
  }
  function markDead(pid, at = Date.now()) {
    dead.set(String(pid), at);
    saveState();
  }
  function deadSet(now = Date.now(), ttlDays = null) {
    const days = ttlDays === null || ttlDays === undefined ? Number(settings().deadTtlDays) : Number(ttlDays);
    const ttl = Math.max(0, Number(days) || 0) * 24 * 60 * 60 * 1000;
    const out = new Set();
    for (const [pid, at] of dead) {
      if (ttl && now - at > ttl) continue;
      out.add(pid);
    }
    return out;
  }
  function normalizeItem(raw) {
    const pid = String(raw?.id ?? raw?.illust_id ?? raw?.illustId ?? '').trim();
    if (!/^\d+$/.test(pid)) return null;
    const rawTags = Array.isArray(raw?.tags)
      ? raw.tags
      : (Array.isArray(raw?.tags?.tags) ? raw.tags.tags : []);
    const tags = rawTags
      .map((t) => String(typeof t === 'string' ? t : (t?.tag ?? t?.name ?? t?.translated_name ?? '')).trim())
      .filter(Boolean);
    const bookmarks = Number(raw?.bookmarkCount ?? raw?.total_bookmarks ?? raw?.bookmark_count);
    const restriction = raw?.xRestrict ?? raw?.x_restrict;
    const hasXRestrict = validRestriction(restriction);
    const rawR18 = raw?.r18 ?? raw?.isR18;
    const hasR18 = typeof rawR18 === 'boolean'
      || (typeof rawR18 === 'number' && [0, 1].includes(rawR18))
      || (typeof rawR18 === 'string' && /^(true|false|0|1)$/i.test(rawR18.trim()));
    const item = {
      pid,
      title: String(raw?.title ?? '').trim() || '（无题）',
      author: String(raw?.userName ?? raw?.user_name ?? raw?.user?.name ?? '').trim() || '（未知作者）',
      userId: String(raw?.userId ?? raw?.user?.id ?? '').trim(),
      bookmarks: Number.isFinite(bookmarks) ? bookmarks : NaN,
      xRestrict: hasXRestrict ? Number(restriction) : 0,
      tags,
      thumbnail: String(raw?.url ?? raw?.thumbnail ?? '').trim()
    };
    Object.defineProperties(item, {
      r18: { value: hasR18 && !/^(false|0)$/i.test(String(rawR18).trim()), enumerable: false },
      ratingKnown: { value: hasXRestrict || hasR18, enumerable: false }
    });
    return item;
  }
  function parseSearchJson(raw) {
    const list = raw?.body?.illust?.data ?? raw?.body?.data ?? raw?.illusts ?? raw?.data ?? [];
    return (Array.isArray(list) ? list : []).map(normalizeItem).filter(Boolean);
  }
  const LOLICON_SIZE_LADDER = ['original', 'regular', 'small', 'thumb', 'mini'];
  function sizeLadderFrom(size) {
    const want = String(size ?? '').trim().toLowerCase();
    const at = LOLICON_SIZE_LADDER.indexOf(want);
    return LOLICON_SIZE_LADDER.slice(at === -1 ? 1 : at);
  }
  function buildLoliconUrl(apiUrl, keyword, { limit = 10, allowR18 = false, excludeAI = false, mode = 'tag', allowed = null, size = DEFAULTS.imageSize } = {}) {
    const base = String(apiUrl || '').trim() || DEFAULTS.loliconApiUrl;
    const kw = String(keyword ?? '').trim();
    let u;
    try { u = new URL(base); } catch { throw new Error(`内置搜索接口地址不合法：${base}`); }
    if (mode === 'keyword') u.searchParams.set('keyword', kw);
    else u.searchParams.set('tag', kw);
    u.searchParams.set('num', String(clamp(limit, 1, 20)));
    u.searchParams.delete('size');
    for (const one of sizeLadderFrom(size)) u.searchParams.append('size', one);
    const wantAdult = allowed instanceof Set
      ? (allowed.has(1) || allowed.has(2))
      : allowR18 === true;
    u.searchParams.set('r18', wantAdult ? '2' : '0');
    if (excludeAI) u.searchParams.set('excludeAI', 'true');
    return u.toString();
  }
  function pickSizeUrls(urls, size = DEFAULTS.imageSize) {
    const map = urls && typeof urls === 'object' ? urls : {};
    const picked = [];
    const push = (raw) => {
      const u = String(raw ?? '').trim();
      if (u && !picked.includes(u)) picked.push(u);
    };
    for (const key of sizeLadderFrom(size)) push(map[key]);
    if (!picked.length) for (const key of LOLICON_SIZE_LADDER) push(map[key]);
    return picked;
  }
  function mapLoliconItems(raw, { size = DEFAULTS.imageSize } = {}) {
    const list = Array.isArray(raw?.data) ? raw.data : [];
    return list.map((it) => {
      const pid = String(it?.pid ?? '').trim();
      if (!/^\d+$/.test(pid)) return null;
      const picked = pickSizeUrls(it?.urls, size);
      const r18Value = it?.r18;
      const hasR18 = typeof r18Value === 'boolean'
        || (typeof r18Value === 'number' && [0, 1].includes(r18Value))
        || (typeof r18Value === 'string' && /^(true|false|0|1)$/i.test(r18Value.trim()));
      const r18 = hasR18 && !/^(false|0)$/i.test(String(r18Value).trim());
      const item = {
        pid,
        title: String(it?.title ?? '').trim() || '（无题）',
        author: String(it?.author ?? '').trim() || '（未知作者）',
        userId: String(it?.uid ?? '').trim(),
        bookmarks: NaN,
        xRestrict: r18 ? 1 : 0,
        tags: Array.isArray(it?.tags)
          ? it.tags.map((t) => String(typeof t === 'string' ? t : (t?.tag ?? t?.name ?? t?.translated_name ?? ''))).filter(Boolean)
          : [],
        thumbnail: picked[0] || '',
        imageUrl: picked[0] || '',
        imageUrls: picked
      };
      Object.defineProperties(item, {
        r18: { value: hasR18 ? r18 : undefined, enumerable: false },
        ratingKnown: { value: hasR18, enumerable: false }
      });
      return item;
    }).filter(Boolean);
  }
  function ratingOf(item) {
    if (!item) return 0;
    const x = Number(item.xRestrict);
    let r = (Number.isFinite(x) && x > 0) ? (x >= 2 ? 2 : 1) : 0;
    const rawR18 = item.r18 ?? item.isR18;
    const flaggedR18 = rawR18 === true || rawR18 === 1 || /^(true|1)$/i.test(String(rawR18 ?? '').trim());
    if (flaggedR18) r = Math.max(r, 1);
    for (const t of (item.tags || [])) {
      const s = String(typeof t === 'string' ? t : (t?.tag ?? t?.name ?? t?.translated_name ?? ''))
        .trim().toLowerCase().replace(/[\s_‐‑‒–—−]/g, '');
      if (/^(r-?18g|guro|リョナ|グロ|猎奇|猟奇)/i.test(s)) { r = Math.max(r, 2); continue; }
      if (/^(r-?18|成人向?|エロ)/i.test(s)) r = Math.max(r, 1);
    }
    return r;
  }
  function ratingKnown(item) {
    if (!item) return false;
    if (item.ratingKnown === true) return true;
    if (item.ratingKnown === false) {
      return (item.tags || []).some((t) => /r\s*-?\s*18|guro|リョナ|猎奇|獵奇|成人向|エロ/i.test(String(t?.tag ?? t?.name ?? t?.translated_name ?? t)));
    }
      const restriction = item.xRestrict ?? item.x_restrict;
      if (validRestriction(restriction)) return true;
    const rawR18 = item.r18 ?? item.isR18;
      if (typeof rawR18 === 'boolean' || (typeof rawR18 === 'number' && [0, 1].includes(rawR18))
      || (typeof rawR18 === 'string' && /^(true|false|0|1)$/i.test(rawR18.trim()))) return true;
    return (item.tags || []).some((t) => /r\s*-?\s*18|guro|リョナ|猎奇|獵奇|成人向|エロ/i.test(String(t?.tag ?? t?.name ?? t?.translated_name ?? t)));
  }
  function isR18(item) {
    return ratingOf(item) > 0;
  }
  const RATING_TOKENS = {
    safe: 0, '全年龄': 0, '一般': 0, 'all-ages': 0,
    r18: 1, 'r-18': 1, '成人': 1,
    r18g: 2, 'r-18g': 2, '猎奇': 2
  };
  function resolveRatings(c = {}) {
    const raw = c.ratings;
    const isList = Array.isArray(raw) || (typeof raw === 'string' && raw.trim() !== '');
    if (isList) {
      const list = (Array.isArray(raw) ? raw : String(raw).split(','))
        .map((x) => String(x).trim().toLowerCase()).filter(Boolean);
      const set = new Set();
      for (const t of list) if (Object.prototype.hasOwnProperty.call(RATING_TOKENS, t)) set.add(RATING_TOKENS[t]);
      if (set.size && !set.has(1) && !set.has(2) && c.allowR18 === true) {
        warn('配置里旧的「允许 R18」已被「允许的分级」多选取代，而当前分级里没有成人档，'
          + '所以不会出成人作品 —— 要开请到PID 搜索设置里在「允许的分级」中勾上 R18 / R18G。');
      }
      if (set.size) return set;
      warn('「允许的分级」里一个有效选项都没有（最少要选一个），本次按「全年龄」处理 —— '
        + '请到PID 搜索设置里补选。');
      return new Set([0]);
    }
    const set = new Set([0]);
    if (c.allowR18 === true) set.add(1);
    return set;
  }
  const allowedRatings = resolveRatings;
  function ratingLabel(x) {
    return x === 1 ? 'R18' : x === 2 ? 'R18G' : '全年龄';
  }


  function filterByRating(items, allowed) {
    const kept = [];
    const dropped = [];
    for (const it of items || []) {
      (ratingKnown(it) && allowed.has(ratingOf(it)) ? kept : dropped).push(it);
    }
    return { kept, dropped };
  }
  const RATING_ORDER = { safe: 0, r18: 1, r18g: 2 };
  function normalizeRatingTokens(raw) {
    const list = Array.isArray(raw) ? raw : String(raw ?? '').split(/[,，\s]+/);
    const out = [];
    for (const x of list) {
      const t = String(x ?? '').trim().toLowerCase();
      if (!t) continue;
      if (!Object.prototype.hasOwnProperty.call(RATING_TOKENS, t)) continue;
      const val = RATING_TOKENS[t];
      const canon = val === 0 ? 'safe' : val === 1 ? 'r18' : 'r18g';
      if (!out.includes(canon)) out.push(canon);
    }
    return out.sort((a, b) => RATING_ORDER[a] - RATING_ORDER[b]);
  }
  let chatRatingsCache = null;
  function loadChatRatings() {
    if (chatRatingsCache) return chatRatingsCache;
    const out = {};
    if (!chatRatingsFile) { chatRatingsCache = out; return out; }
    try {
      const raw = JSON.parse(fs.readFileSync(chatRatingsFile, 'utf8'));
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const [k, v] of Object.entries(raw)) {
          const tokens = normalizeRatingTokens(v);
          if (tokens.length) out[String(k)] = tokens;
          else warn(`按会话的分级文件里「${k}」的取值不认识（${JSON.stringify(v)}），已忽略这一条`);
        }
      } else {
        warn('按会话的分级文件格式不对（应为 JSON 对象），已当空处理');
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') warn(`读按会话的分级文件失败，已当空处理：${error?.message ?? error}`);
    }
    chatRatingsCache = out;
    return out;
  }
  function saveChatRatings(map) {
    chatRatingsCache = map;
    if (!chatRatingsFile) {
      warn('状态目录还没就绪（插件未激活），按会话的分级改不了');
      return false;
    }
    try {
      fs.mkdirSync(path.dirname(chatRatingsFile), { recursive: true });
      fs.writeFileSync(chatRatingsFile, `${JSON.stringify(map, null, 2)}\n`, 'utf8');
      return true;
    } catch (error) {
      warn(`写按会话的分级文件失败：${error?.message ?? error}`);
      return false;
    }
  }
  function __resetChatRatingsCache() { chatRatingsCache = null; }
  function chatRatingOf(chatKey) {
    const map = loadChatRatings();
    const v = map[String(chatKey ?? '')];
    return Array.isArray(v) && v.length ? v : null;
  }
  function ratingsForChat(chatKey, s = {}) {
    const override = chatRatingOf(chatKey);
    if (override) {
      return { allowed: resolveRatings({ ratings: override }), tokens: override, source: 'chat', override };
    }
    const hasGlobal = Array.isArray(s.ratings) || (typeof s.ratings === 'string' && s.ratings.trim() !== '');
    const allowed = resolveRatings(s);
    const tokens = [...allowed].sort((a, b) => a - b).map((x) => (x === 0 ? 'safe' : x === 1 ? 'r18' : 'r18g'));
    return { allowed, tokens, source: hasGlobal ? 'global' : (s.allowR18 === true ? 'legacy' : 'fallback'), override: null };
  }
  function setChatRating(chatKey, rawTokens) {
    const key = String(chatKey ?? '').trim();
    if (!key) return { ok: false, error: '拿不到会话标识，改不了' };
    const tokens = normalizeRatingTokens(rawTokens);
    if (!tokens.length) {
      return { ok: false, error: '没给有效的分级（可选：safe / r18 / r18g，或者 全年龄 / R18 / R18G）' };
    }
    const map = { ...loadChatRatings(), [key]: tokens };
    if (!saveChatRatings(map)) return { ok: false, error: '写入失败（看控制台日志）' };
    return { ok: true, tokens };
  }
  function clearChatRating(chatKey) {
    const key = String(chatKey ?? '').trim();
    const map = { ...loadChatRatings() };
    const had = Boolean(map[key]);
    delete map[key];
    if (!saveChatRatings(map)) return { ok: false, error: '写入失败（看控制台日志）' };
    return { ok: true, had };
  }
  function ownerIdSet(s = {}) {
    const raw = (s.ownerIds !== undefined && s.ownerIds !== '') ? s.ownerIds : s.adminIds;
    return new Set(String(raw ?? '').split(/[,，、\s]+/).map((x) => x.trim()).filter(Boolean));
  }
  const adminIdSet = ownerIdSet;
  function latestCaller(ctx) {
    const recent = ctx?.recent;
    if (typeof recent !== 'function') return { callerId: '', callerName: '' };
    let list = [];
    try { list = recent(6) || []; } catch { list = []; }
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const m = list[i];
      if (!m || m.self === true) continue;
      if (m.senderId) return { callerId: String(m.senderId), callerName: String(m.senderName || '') };
    }
    return { callerId: '', callerName: '' };
  }
  async function callerMayChangeRating(ctx, s = {}) {
    const { callerId, callerName } = latestCaller(ctx);
    if (!callerId) {
      return { ok: false, callerId, callerName, reason: '没能确认是谁在说话（本会话没查到最近的消息记录），所以不敢改。' };
    }
    if (ownerIdSet(s).has(callerId)) return { ok: true, callerId, callerName, how: '在「主人 QQ」名单里' };
    try {
      const cap = api?.capability?.('message.owner-check', { userId: callerId });
      if (cap && typeof cap === 'object' && 'isOwner' in cap && cap.isOwner === true) {
        return { ok: true, callerId, callerName, how: '主人识别插件认定是主人' };
      }
    } catch (error) {
      warn(`问主人识别插件时出错（按非主人处理）：${error?.message ?? error}`);
    }
    return {
      ok: false, callerId, callerName,
      reason: '这个设置只有主人能改（群主/管理员也不行 —— 这是主人特意定的）。'
        + '要放行别人，请主人在「Pixiv 来张图（自建）」的PID 搜索设置里把 QQ 填进「主人 QQ」。'
        + '（本条宿主没有「主人识别」插件，所以那份名单是唯一的判定来源。）'
    };
  }
  function pickUnseen(items, seenSet, poolSize = 5, rand = Math.random) {
    const random = typeof rand === 'function' ? rand : Math.random;
    const fresh = (items || []).filter((x) => x && !seenSet.has(x.pid));
    if (!fresh.length) return null;
    const score = (x) => (Number.isFinite(x.bookmarks) ? x.bookmarks : -1);
    const sorted = [...fresh].sort((a, b) => score(b) - score(a));
    const pool = sorted.slice(0, clamp(poolSize, 1, 50));
    return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
  }
  function buildTryList(items, excludeSet, poolSize, need = 1, extra = 3, rand = Math.random) {
    const taken = new Set(excludeSet || []);
    const pool = (items || []).filter((x) => x && !taken.has(x.pid));
    const out = [];
    const first = pickUnseen(pool, new Set(), poolSize, rand);
    if (first) { out.push(first); taken.add(first.pid); }
    for (const it of pool) {
      if (out.length >= Math.max(1, need) + Math.max(0, extra)) break;
      if (taken.has(it.pid)) continue;
      out.push(it);
      taken.add(it.pid);
    }
    return out;
  }
  function formatNote(item, max = 40) {
    const parts = [`Pixiv ${item.pid}`, item.title, item.author];
    if (Number.isFinite(item.bookmarks)) parts.push(`★${item.bookmarks}`);
    return safeSlice(parts.filter(Boolean).join(' · '), max);
  }
  function buildSearchUrl(template, keyword, page = 1) {
    const kw = encodeURIComponent(String(keyword ?? '').trim());
    return String(template || DEFAULTS.searchUrlTemplate)
      .replaceAll('{kw}', kw)
      .replaceAll('{page}', String(clamp(page, 1, 999)));
  }
  function buildImageUrl(template, pid) {
    return String(template || DEFAULTS.imageUrlTemplate).replaceAll('{pid}', String(pid ?? '').trim());
  }
  function imageCandidates(item, template, { allowTemplate = true } = {}) {
    const list = [];
    const push = (raw) => {
      const u = String(raw ?? '').trim();
      if (u && !list.includes(u)) list.push(u);
    };
    for (const one of (Array.isArray(item?.imageUrls) ? item.imageUrls : [])) push(one);
    push(item?.imageUrl);
    if (allowTemplate) push(buildImageUrl(template, item?.pid));
    return list;
  }
  function parseOriginalPath(url) {
    const m = /\/(\d{4})\/(\d{2})\/(\d{2})\/(\d{2})\/(\d{2})\/(\d{2})\/(\d+)_p(\d+)(?:_[a-z0-9]+)?\.([a-z0-9]+)/i
      .exec(String(url ?? ''));
    if (!m) return null;
    return {
      year: m[1], month: m[2], day: m[3], hour: m[4], minute: m[5], second: m[6],
      pid: m[7], page: m[8], ext: m[9].toLowerCase()
    };
  }
  function sizeUrlsFromOriginal(originalUrl, size = DEFAULTS.imageSize) {
    const p = parseOriginalPath(originalUrl);
    if (!p) return [];
    let origin = '';
    try { origin = new URL(String(originalUrl)).origin; } catch { return []; }
    const date = `${p.year}/${p.month}/${p.day}/${p.hour}/${p.minute}/${p.second}`;
    const page = `p${p.page}`;
    const master = `/img-master/img/${date}/${p.pid}_${page}_master1200.jpg`;
    const ladder = {
      original: `${origin}/img-original/img/${date}/${p.pid}_${page}.${p.ext}`,
      regular: `${origin}${master}`,
      small: `${origin}/c/540x540_70${master}`,
      thumb: `${origin}/c/250x250_80_a2/img-master/img/${date}/${p.pid}_${page}_square1200.jpg`
    };
    return sizeLadderFrom(size).map((key) => ladder[key]).filter(Boolean);
  }
  function parseSuffixPath(url) {
    let u = null;
    try { u = new URL(String(url ?? '')); } catch { return null; }
    const m = /^\/(\d{5,12})(?:-(\d+))?\.([a-z0-9]+)$/i.exec(u.pathname);
    if (!m) return null;
    return { origin: u.origin, pid: m[1], page: m[2] ? Number(m[2]) : 1, ext: m[3].toLowerCase() };
  }
  function pageUrlsOf(item, page, size = DEFAULTS.imageSize) {
    const base = String(item?.imageUrl || (Array.isArray(item?.imageUrls) ? item.imageUrls[0] : '') || '').trim();
    const suffix = parseSuffixPath(base);
    if (suffix) {
      const want = (Number(page) || 0) + 1;
      if (want <= 1) return [];
      return [`${suffix.origin}/${suffix.pid}-${want}.${suffix.ext}`];
    }
    const p = parseOriginalPath(base);
    if (!p) return [];
    let origin = '';
    try { origin = new URL(base).origin; } catch { return []; }
    const rebuilt = `${origin}/img-original/img/${p.year}/${p.month}/${p.day}/${p.hour}/${p.minute}/${p.second}`
      + `/${p.pid}_p${clamp(Number(page) || 0, 0, 9999)}.${p.ext}`;
    return sizeUrlsFromOriginal(rebuilt, size);
  }
  function describeImageHttp(status) {
    if (status === 404 || status === 410) {
      return `图片 HTTP ${status}：这张作品在 Pixiv 上已经删了或限制访问（搜索接口的索引偏旧，里面可能留着死链）`;
    }
    if (status === 403) return '图片 HTTP 403：图床的防盗链拒绝了请求（需要 Referer 或登录态）';
    if (status === 429) return '图片 HTTP 429：图床限流了';
    return `图片 HTTP ${status}`;
  }
  function extractPid(input) {
    const s = String(input ?? '').trim();
    if (!s) return '';
    if (/^\d{5,12}$/.test(s)) return s;
    const patterns = [
      /pixiv\.net\/(?:artworks|i|en\/artworks)\/(\d{5,12})/i,
      /[?&]illust_id=(\d{5,12})/i,
      /(?:i\.)?pixiv\.re\/(\d{5,12})/i,
      /(\d{5,12})_p\d+/i
    ];
    for (const re of patterns) {
      const m = re.exec(s);
      if (m) return m[1];
    }
    const all = s.match(/\d{5,12}/g) || [];
    return all.length === 1 ? all[0] : '';
  }
  let proxyAgent = null;
  let proxyAgentKey = '';
  function resolveProxyUrl(cfg, env = process.env) {
    const fromCfg = String(cfg?.proxyUrl ?? '').trim();
    if (fromCfg) return fromCfg;
    for (const k of ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy']) {
      const v = String(env?.[k] ?? '').trim();
      if (v) return v;
    }
    return '';
  }
  async function dispatcherFor(proxyUrl) {
    const url = String(proxyUrl || '').trim();
    if (!url) return null;
    if (proxyAgent && proxyAgentKey === url) return proxyAgent;
    if (proxyAgent) await proxyAgent.destroy();
    try {
      const { ProxyAgent } = await import('undici');
      const AgentClass = ProxyAgent;
      proxyAgent = new AgentClass(url);
      proxyAgentKey = url;
      return proxyAgent;
    } catch (error) {
      warn(`代理不可用（${url}）：${error?.message ?? error}，本次改直连`);
      return null;
    }
  }
  let netFailStreak = 0;
  let netFailUntil = 0;
  const BREAKER_AFTER = 3;
  const BREAKER_COOLDOWN_MS = 5 * 60 * 1000;
  function breakerState(now = Date.now()) {
    return { open: now < netFailUntil, retryAfterSec: Math.max(0, Math.ceil((netFailUntil - now) / 1000)), streak: netFailStreak };
  }
  function noteNetFailure(now = Date.now()) {
    netFailStreak += 1;
    if (netFailStreak >= BREAKER_AFTER) netFailUntil = now + BREAKER_COOLDOWN_MS;
  }
  function noteNetSuccess() { netFailStreak = 0; netFailUntil = 0; }
  let pixivDirectFailAt = 0;
  const PIXIV_DIRECT_COOLDOWN_MS = 10 * 60 * 1000;
  function pixivDirectCoolingDown(now = Date.now()) {
    return pixivDirectFailAt > 0 && now - pixivDirectFailAt < PIXIV_DIRECT_COOLDOWN_MS;
  }
  function describeFetchError(error, timeoutMs = 15000, proxyUrl = '', url = '') {
    const msg = String(error?.message ?? error);
    const via = proxyUrl ? `（已走代理 ${proxyUrl}）` : '（当前是直连）';
    let host = '';
    try { host = new URL(String(url)).hostname; } catch { /* 保留主流程。 */ }
    const where = host ? `（${host}）` : '';
    const hint = needsPixivReferer(url)
      ? '大陆直连 pixiv 不通，需要代理或换掉地址模板'
      : '这个接口连不上，可能是网络问题或接口本身挂了';
    if (/abort/i.test(msg)) {
      return `请求超时：${Math.round(Number(timeoutMs) / 1000)} 秒内没有任何响应${where}${via}（${hint}）`;
    }
    if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) {
      return `域名解析失败${where}${via}：${msg}（DNS 可能被污染，需要走代理）`;
    }
    if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up|other side closed/i.test(msg)) {
      return `连接失败${where}${via}：${msg}（代理没开、端口写错，或线路不通）`;
    }
    return msg;
  }
  function isNetError(error) {
    return /abort|ENOTFOUND|EAI_AGAIN|getaddrinfo|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up|other side closed|fetch failed/i
      .test(String(error?.message ?? error));
  }
  const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, Math.max(0, Number(ms) || 0)); });
  function isTransientFetchError(error) {
    if (!error) return false;
    if (error.hardNetError) return false;
    if (error.tooBig) return false;
    const status = Number(error.status) || 0;
    if (status === 404 || status === 410) return false;
    // 这里只用于幂等的图片 GET；上游偶发 5xx 可以按 pageRetryOnce 有限重试。
    if ([500, 502, 503, 504].includes(status)) return true;
    if (status >= 400) return false;
    return error.netError === true || isNetError(error);
  }
  function isHardNetError(error) {
    const text = `${String(error?.message ?? '')} ${String(error?.cause?.code ?? '')} ${String(error?.cause?.message ?? '')}`;
    return /ENOTFOUND|EAI_AGAIN|getaddrinfo|ECONNREFUSED|ERR_INVALID_URL/i.test(text);
  }
  function needsPixivReferer(url) {
    let host = '';
    try { host = new URL(String(url)).hostname.toLowerCase(); } catch { return false; }
    return /(^|\.)pixiv\.net$/.test(host) || /(^|\.)pximg\.net$/.test(host) || /(^|\.)pixiv\.re$/.test(host);
  }
  function searchHttpError(url, status) {
    let host = '';
    try { host = new URL(String(url)).hostname; } catch { host = String(url).slice(0, 60); }
    if (status === 403) {
      return needsPixivReferer(url)
        ? `${host} HTTP 403 —— 被 Pixiv 挡了：可能需要填 Cookie 或换 UA`
        : `${host} HTTP 403 —— 这个第三方接口拒绝了请求（反爬 / 限流 / UA）。`
          + '可以到设置里换一个「内置搜索接口地址」，或改用 pid / 作品链接那条路（它不经搜索）';
    }
    return `${host} HTTP ${status}`;
  }
  function requestHeaders(s, accept, url, { minimal = false } = {}) {
    const h = { 'User-Agent': String(s.userAgent || '').trim() || DEFAULT_UA };
    if (accept) h.Accept = accept;
    if (minimal) return h;
    h['Accept-Language'] = 'zh-CN,zh;q=0.9,en;q=0.8';
    const pixivFamily = needsPixivReferer(url);
    if (pixivFamily) {
      h.Referer = 'https://www.pixiv.net/';
      const ck = String(s.cookie || '').trim();
      if (ck && /(^|\.)pixiv\.net$/.test(new URL(url).hostname)) h.Cookie = ck;
    }
    return h;
  }
  async function doFetch(url, accept, timeoutMs, { minimal = false, controller = null, method = 'GET', redirect = 'follow', quiet = false } = {}) {
    const s = settings();
    const official = /(^|\.)(pixiv\.net|pximg\.net)$/.test(new URL(url).hostname);
    const proxyUrl = s.proxyScope === 'official' && !official ? '' : resolveProxyUrl(s);
    const dispatcher = await dispatcherFor(proxyUrl);
    const ms = Math.max(3000, Number(timeoutMs) || 15000);
    const ac = controller ?? new AbortController();
    const timer = controller ? null : setTimeout(() => ac.abort(), ms);
    try {
      return await networkFetch(url, {
        method,
        redirect,
        headers: requestHeaders(s, accept, url, { minimal }),
        signal: operationSignal ? AbortSignal.any([ac.signal, operationSignal]) : ac.signal,
        ...(dispatcher ? { dispatcher } : {})
      });
    } catch (error) {
      if (isNetError(error)) {
        if (!quiet) noteNetFailure();
        const wrapped = new Error(describeFetchError(error, ms, proxyUrl, url));
        wrapped.netError = true;
        wrapped.hardNetError = isHardNetError(error);
        throw wrapped;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  async function requestJson(url) {
    const s = settings();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), s.timeoutMs);
    try {
    let resp = await doFetch(url, 'application/json', s.timeoutMs, { controller });
    if (resp.status === 403 && !needsPixivReferer(url)) {
      await resp.body?.cancel();
      resp = await doFetch(url, 'application/json', s.timeoutMs, { minimal: true, controller });
    }
    if (!resp.ok) throw new Error(searchHttpError(url, resp.status));
    noteNetSuccess();
    const chunks = []; let size = 0;
    for await (const chunk of resp.body || []) {
      operationSignal?.throwIfAborted();
      size += chunk.length;
      if (size > 2 * 1024 * 1024) { controller.abort(); throw new Error('作品信息响应过大'); }
      chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } finally { clearTimeout(timer); }
  }

  async function searchIllusts(s, keyword, want, allowed = null) {
    const allowedSet = (allowed instanceof Set) ? allowed : resolveRatings(s);
    const limit = clamp(Math.max(Number(want) * 5, 15), 1, 20);
    const errors = [];
    let netError = false;
    const noteErr = (prefix, error) => {
      errors.push(`${prefix}：${error?.message ?? error}`);
      if (error?.netError) netError = true;
    };
    const viaBuiltin = async () => {
      for (const mode of ['tag', 'keyword']) {
        const url = buildLoliconUrl(s.loliconApiUrl, keyword, {
          limit, allowed: allowedSet, excludeAI: s.excludeAI === true, mode, size: s.imageSize
        });
        const items = mapLoliconItems(await requestJson(url), { size: s.imageSize });
        if (items.length) return { items, backend: `builtin/${mode}` };
      }
      return { items: [], backend: 'builtin' };
    };
    const viaPixiv = async () => {
      if (!resolveProxyUrl(s) && pixivDirectCoolingDown()) {
        const skip = new Error('pixiv.net 直连最近失败过，暂时跳过（配好代理会自动恢复）');
        skip.skipped = true;
        throw skip;
      }
      try {
        const items = parseSearchJson(await requestJson(buildSearchUrl(s.searchUrlTemplate, keyword, 1)));
        pixivDirectFailAt = 0;
        return { items, backend: 'pixiv' };
      } catch (error) {
        if (error?.netError) {
          pixivDirectFailAt = Date.now();
          warn(`pixiv.net 直连失败，${Math.round(PIXIV_DIRECT_COOLDOWN_MS / 60000)} 分钟内不再试这条路：${error.message}`);
        }
        throw error;
      }
    };
    const backend = String(s.searchBackend || 'auto');
    if (backend === 'builtin' || backend === 'pixiv') {
      try {
        const r = await (backend === 'builtin' ? viaBuiltin() : viaPixiv());
        if (!r.items.length) errors.push(`${backend} 没有结果`);
        return { items: r.items, backend: r.backend, errors, netError };
      } catch (error) {
        noteErr(backend, error);
        return { items: [], backend, errors, netError };
      }
    }
    try {
      const r = await viaBuiltin();
      if (r.items.length) return { items: r.items, backend: r.backend, errors, netError };
      errors.push('内置接口没有结果');
    } catch (error) { noteErr('内置接口', error); }
    try {
      const r = await viaPixiv();
      if (r.items.length) return { items: r.items, backend: r.backend, errors, netError };
      errors.push('pixiv.net 没有结果');
    } catch (error) { noteErr('pixiv.net', error); }
    return { items: [], backend: 'none', errors, netError };
  }
  function tempDir() {
    if (!stateDir) throw new Error('PID 数据目录尚未初始化');
    const d = path.join(stateDir, 'tmp');
    fs.mkdirSync(d, { recursive: true });
    return d;
  }
  function sweepTemp(maxAgeMs = 15 * 60 * 1000) {
    try {
      const dir = tempDir();
      const now = Date.now();
      for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f);
        try { if (now - fs.statSync(p).mtimeMs > maxAgeMs) fs.rmSync(p, { force: true }); } catch { /* 保留主流程。 */ }
      }
    } catch { /* 保留主流程。 */ }
  }
  async function readBodyCapped(resp, cap, controller) {
    const tooBig = (bytes) => {
      const e = new Error(`图片超过上限 ${(cap / 1048576).toFixed(1)}MB`
        + `（已读 ${(bytes / 1048576).toFixed(1)}MB 仍未读完，真实大小未知）`
        + '；想发更大的图就把PID 搜索设置里的 maxImageBytes 调大');
      e.tooBig = true;
      e.bytes = bytes;
      return e;
    };
    if (!resp.body || typeof resp.body.getReader !== 'function') {
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length > cap) throw tooBig(buf.length);
      return buf;
    }
    const reader = resp.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        try { controller.abort(); } catch { /* 保留主流程。 */ }
        try { await reader.cancel(); } catch { /* 保留主流程。 */ }
        throw tooBig(total);
      }
      chunks.push(Buffer.from(value));
    }
    if (!total) throw new Error('图片内容为空');
    return Buffer.concat(chunks);
  }
  async function downloadToTemp(url, timeoutMs, maxBytes) {
    const ms = Math.max(3000, Number(timeoutMs) || 15000);
    const cap = Math.max(64 * 1024, Number(maxBytes) || DEFAULTS.maxImageBytes);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ms);
    try {
      const s = settings();
      const relayed = s.imageRelayUrl && new URL(url).hostname === 'i.pximg.net';
      const resp = relayed ? await fetchRelayedImage(url, s, { fetchImpl: options.fetchImpl,
        signal: operationSignal ? AbortSignal.any([ac.signal, operationSignal]) : ac.signal })
        : await doFetch(url, 'image/avif,image/webp,image/png,image/*,*/*;q=0.8', ms, { controller: ac });
      if (!resp.ok) {
        const e = new Error(describeImageHttp(resp.status));
        e.status = resp.status;
        if (relayed && resp.status === 413) e.tooBig = true;
        try { await resp.body?.cancel(); } catch { /* 保留HTTP错误，释放本次响应。 */ }
        throw e;
      }
      const declared = Number(resp.headers.get('content-length')) || 0;
      if (declared > cap) {
        try { ac.abort(); } catch { /* 保留主流程。 */ }
        const e = new Error(`原图 ${(declared / 1048576).toFixed(1)}MB 超过上限 ${(cap / 1048576).toFixed(1)}MB`
          + '；想发更大的图就把PID 搜索设置里的 maxImageBytes 调大');
        e.tooBig = true;
        e.bytes = declared;
        throw e;
      }
      let buf;
      try {
        buf = await readBodyCapped(resp, cap, ac);
      } catch (error) {
        if (error?.tooBig) throw error;
        if (isNetError(error)) {
          noteNetFailure();
          const wrapped = new Error(describeFetchError(error, ms, resolveProxyUrl(settings()), url));
          wrapped.netError = true;
          wrapped.hardNetError = isHardNetError(error);
          throw wrapped;
        }
        throw error;
      }
      noteNetSuccess();
      const mime = String(resp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      const ext = MIME_EXT[mime] || '.jpg';
      const file = path.join(tempDir(), `pixiv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}${ext}`);
      fs.writeFileSync(file, buf);
      let sourceUrl;
      try {
        const requested = new URL(url);
        const source = new URL(resp.headers.get('x-origin-url') || '');
        const parsed = parseOriginalPath(source.href);
        const page = parseSuffixPath(requested.href)?.page;
        const requestedPage = page ? page - 1 : Number(parseOriginalPath(requested.href)?.page || 0);
        if (['pixiv.re', 'pixiv.cat', 'pixiv.nl', 'i.pixiv.re'].includes(requested.hostname)
          && source.protocol === 'https:' && source.hostname === 'i.pximg.net'
          && !source.username && !source.password && !source.port && !source.search && !source.hash
          && parsed?.pid === extractPid(requested.href) && Number(parsed.page) === requestedPage) {
          if (!resolveProxyUrl(settings())) source.hostname = 'i.pixiv.re';
          sourceUrl = source.href;
        }
      } catch { /* 响应头仅作优化；无效或不匹配时继续沿用请求地址。 */ }
      return { file, bytes: buf.length, ...(sourceUrl ? { sourceUrl } : {}) };
    } finally {
      clearTimeout(timer);
    }
  }
  async function sizeUrlsFromTemplate(templateUrl, s, pid = '') {
    let status = 0;
    try {
      const resp = await doFetch(templateUrl, 'image/*,*/*;q=0.8', s.timeoutMs,
        { method: 'GET', redirect: 'manual', quiet: true });
      status = Number(resp?.status) || 0;
      const location = String(resp?.headers?.get?.('location') ?? '').trim();
      try { await resp?.body?.cancel?.(); } catch { /* 保留主流程。 */ }
      if (!location) {
        say(`[pixiv] ${pid}：模板没有重定向（HTTP ${status}），只能按原图取`);
        return [];
      }
      const urls = sizeUrlsFromOriginal(new URL(location, templateUrl).toString(), s.imageSize);
      if (!urls.length) say(`[pixiv] ${pid}：301 的目标认不出日期路径（${location.slice(0, 90)}），只能按原图取`);
      return urls;
    } catch (error) {
      say(`[pixiv] ${pid}：读 301 失败（${String(error?.message ?? error).slice(0, 60)}），只能按原图取`);
      return [];
    }
  }
  function say(message) {
    if (logSink) { try { logSink('info', message); } catch { /* 保留主流程。 */ } return; }
    try { api?.log?.info?.(message); } catch { /* 保留主流程。 */ }
  }
  let logSink = null;
  function __setLogSinkForTest(fn) { logSink = typeof fn === 'function' ? fn : null; }
  const FFMPEG_PROBE_TTL_MS = 10 * 60 * 1000;
  let ffmpegProbe = { at: 0, path: null, failed: false };
  function __resetFfmpegProbe() { ffmpegProbe = { at: 0, path: null, failed: false }; }
  let spawnImpl = spawn;
  function __setSpawnForTest(fn) { spawnImpl = typeof fn === 'function' ? fn : spawn; }
  async function resolveFfmpeg() {
    const cached = ffmpegProbe.path;
    if (cached && Date.now() - ffmpegProbe.at < FFMPEG_PROBE_TTL_MS) return cached;
    if (!cached && ffmpegProbe.failed && Date.now() - ffmpegProbe.at < FFMPEG_PROBE_TTL_MS) return '';
    ffmpegProbe = { at: Date.now(), path: null, failed: false };
    const candidates = process.platform === 'win32'
      ? ['ffmpeg', 'ffmpeg.exe']
      : ['ffmpeg', '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/bin/ffmpeg'];
    for (const bin of candidates) {
      const ok = await new Promise((resolve) => {
        let child = null;
        try {
          child = spawnImpl(bin, ['-version'], { stdio: 'ignore', windowsHide: true });
        } catch { resolve(false); return; }
        let settled = false;
        const done = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
        const timer = setTimeout(() => {
          try { child.kill(); } catch { /* 保留主流程。 */ }
          done(false);
        }, 5000);
        timer.unref?.();
        child.on('error', () => done(false));
        child.on('exit', (code) => done(code === 0));
      });
      if (ok) {
        ffmpegProbe.path = bin;
        return bin;
      }
    }
    ffmpegProbe.failed = true;
    return '';
  }
  function buildDownsampleArgs(inputPath, outputPath, { maxEdge = 1200, quality = 5 } = {}) {
    const edge = Math.max(64, Math.round(Number(maxEdge) || 1200));
    const q = Math.min(31, Math.max(2, Math.round(Number(quality) || 5)));
    return [
      '-hide_banner', '-loglevel', 'error',
      '-y',
      '-i', inputPath,
      '-vf', `scale='min(${edge},iw)':'min(${edge},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`,
      '-frames:v', '1',
      '-q:v', String(q),
      '-f', 'image2', '-y', outputPath
    ];
  }
  function runFfmpegToFile(ffmpegPath, args, timeoutMs) {
    return new Promise((resolve) => {
      let child = null;
      try {
        child = spawnImpl(ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      } catch (error) {
        resolve({ ok: false, reason: `ffmpeg 起不来：${error?.message ?? error}` });
        return;
      }
      let stderr = '';
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* 保留主流程。 */ }
        done({ ok: false, reason: `ffmpeg 超时（${timeoutMs}ms）` });
      }, timeoutMs);
      child.stderr?.on('data', (chunk) => {
        stderr += chunk;
        if (stderr.length > 2000) stderr = stderr.slice(-2000);
      });
      child.on('error', (error) => done({ ok: false, reason: `ffmpeg 启动失败：${error?.message ?? error}` }));
      child.on('close', (code) => done(
        code === 0
          ? { ok: true }
          : { ok: false, reason: `ffmpeg 退出码 ${code}：${stderr.trim().split('\n').pop() || '无错误输出'}` }
      ));
    });
  }
  async function downsampleToJpeg(file, {
    overBytes = 800 * 1024,
    maxEdge = 1200,
    quality = 5,
    timeoutMs = 10000,
    ffmpegPath = ''
  } = {}) {
    const src = String(file ?? '');
    let stat = null;
    try { stat = fs.statSync(src); } catch (error) {
      return { file: src, bytes: 0, downsized: false, reason: `读不到文件（${error?.message ?? error}）` };
    }
    const size = Number(stat.size) || 0;
    const limit = Math.max(0, Number(overBytes) || 0);
      if (!limit || size <= limit) return { file: src, bytes: size, downsized: false };
    const bin = String(ffmpegPath ?? '').trim() || await resolveFfmpeg();
    if (!bin) return { file: src, bytes: size, downsized: false, reason: '这台机器上没有 ffmpeg' };
    const dir = path.dirname(src);
    const base = path.basename(src).replace(/\.[a-z0-9]+$/i, '');
    const out = path.join(dir, `${base}-ds_${Math.random().toString(36).slice(2, 8)}.jpg`);
    let result;
    try {
      result = await runFfmpegToFile(bin, buildDownsampleArgs(src, out, { maxEdge, quality }), timeoutMs);
    } catch (error) {
      result = { ok: false, reason: `ffmpeg 调用失败：${error?.message ?? error}` };
    }
    let outBytes = 0;
    try { outBytes = fs.statSync(out).size; } catch { outBytes = 0; }
    if (!result.ok || !outBytes) {
      try { fs.rmSync(out, { force: true }); } catch { /* 保留主流程。 */ }
      return { file: src, bytes: size, downsized: false, reason: result.reason || 'ffmpeg 没有产出文件' };
    }
    if (outBytes >= size) {
      try { fs.rmSync(out, { force: true }); } catch { /* 保留主流程。 */ }
      return { file: src, bytes: size, downsized: false, reason: `缩完更大（${outBytes} ≥ ${size}）` };
    }
    try { fs.rmSync(src, { force: true }); } catch { /* 保留主流程。 */ }
    return { file: out, bytes: outBytes, downsized: true, fromBytes: size, fromFile: src };
  }
  async function fetchImage(item, s, { allowTemplate = true } = {}) {
    let itemUrls = Array.isArray(item?.imageUrls) ? item.imageUrls : [];
    if (allowTemplate && !itemUrls.length && !String(item?.imageUrl ?? '').trim() && item?.pid) {
      const derived = await sizeUrlsFromTemplate(buildImageUrl(s.imageUrlTemplate, item.pid), s, item.pid);
      if (derived.length) {
        itemUrls = derived;
        try {
          api?.log?.info?.(`[pixiv] ${item.pid}：由 301 的 Location 推出 ${derived.length} 个尺寸版候选`);
        } catch { /* 保留主流程。 */ }
      }
    }
    const urls = imageCandidates({ ...item, imageUrls: itemUrls }, s.imageUrlTemplate, { allowTemplate });
    const retryOnce = Math.min(2, Math.max(0, Math.round(Number(s.pageRetryOnce) || 0)));
    const retryDelayMs = 400;
    let last = null;
    let hardFail = false;
    for (let i = 0; i < urls.length; i += 1) {
      operationSignal?.throwIfAborted(); if (hardFail) break;
      for (let attempt = 0; attempt <= retryOnce; attempt += 1) { operationSignal?.throwIfAborted();
        if (attempt > 0 && hardFail) break;
        try {
          const got = await downloadToTemp(urls[i], s.timeoutMs, s.maxImageBytes);
          try {
            api?.log?.info?.(`[pixiv] 取图成功 ${item.pid}：${Math.round(got.bytes / 1024)}KB`
              + `（第 ${i + 1}/${urls.length} 个候选${attempt ? `，瞬时失败后重试第 ${attempt} 次` : ''}，档位 ${s.imageSize}）`);
          } catch { /* 保留主流程。 */ }
        const final = await downsampleToJpeg(got.file, {
          overBytes: s.downsampleOverBytes,
          maxEdge: s.downsampleMaxEdge,
          quality: s.downsampleQuality
        });
        if (final.downsized) {
          say(`[pixiv] ${item.pid} 第 ${i + 1} 个候选降采样：`
            + `${Math.round(final.fromBytes / 1024)}KB → ${Math.round(final.bytes / 1024)}KB`
            + `（最长边 ${Math.max(64, Math.round(Number(s.downsampleMaxEdge) || 1200))}px JPEG）`);
        } else if (final.reason) {
          say(`[pixiv] ${item.pid} 降采样跳过（${final.reason}），按原图 ${Math.round(final.bytes / 1024)}KB 继续`);
        }
        return { ...got, file: final.file, bytes: final.bytes, downsized: final.downsized, url: got.sourceUrl || urls[i] };
      } catch (error) {
          last = error;
          if (error?.hardNetError) { hardFail = true; break; }
          if (attempt < retryOnce && isTransientFetchError(error)) {
            say(`[pixiv] ${item.pid} 第 ${i + 1} 个候选瞬时失败（`
              + `${String(error?.message ?? error).slice(0, 50)}），${retryDelayMs}ms 后重试一次`);
            await sleep(retryDelayMs);
            continue;
          }
          if (i + 1 < urls.length) {
            const why = error?.tooBig ? error.message : String(error?.message ?? error).slice(0, 60);
            try { api?.log?.info?.(`[pixiv] 候选地址不可用（${why}），改试 PID 简写形式`); } catch { /* 保留主流程。 */ }
          }
          break;
        }
      }
    }
    throw last || new Error('这张作品没有可用的图片地址');
  }
  api = { log: options.log || {} };
  setStateDir(options.stateDir);
  function setSignal(signal) { operationSignal = signal; }
  function dispose() { return proxyAgent?.destroy(); }
  function seenSet() { return new Set(seen.keys()); }
  return { setStateDir, __setSettingsForTest, deadSet, normalizeItem, parseSearchJson, LOLICON_SIZE_LADDER, sizeLadderFrom, buildLoliconUrl, pickSizeUrls, mapLoliconItems, ratingOf, ratingKnown, isR18, resolveRatings, allowedRatings, ratingLabel, filterByRating, normalizeRatingTokens, loadChatRatings, __resetChatRatingsCache, chatRatingOf, ratingsForChat, setChatRating, clearChatRating, ownerIdSet, adminIdSet, latestCaller, callerMayChangeRating, pickUnseen, buildTryList, formatNote, buildSearchUrl, buildImageUrl, imageCandidates, parseOriginalPath, sizeUrlsFromOriginal, parseSuffixPath, pageUrlsOf, describeImageHttp, extractPid, resolveProxyUrl, breakerState, pixivDirectCoolingDown, describeFetchError, isTransientFetchError, needsPixivReferer, searchHttpError, __setLogSinkForTest, __resetFfmpegProbe, __setSpawnForTest, resolveFfmpeg, buildDownsampleArgs, downsampleToJpeg, searchIllusts, fetchImage, requestJson, sweepTemp, markSeen, markDead, loadState, saveState, settings, setSignal, dispose, seenSet };
}
