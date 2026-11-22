import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { extractCandidateUrls } from './media-forward-common.js';

const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const UA_MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 '
  + '(KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1';
const DOUYIN_REFERER = 'https://www.douyin.com/';
const DOUYIN_ORIGIN = 'https://www.douyin.com';
const DOUYIN_SIGN_SALT = 'A96D855A08C0A9707F8BEF0D9A527E4E';
const DOUYIN_AID = '6383';

const BARE_DOUYIN_HOSTS = [
  'v.douyin.com',
  'www.douyin.com',
  'm.douyin.com',
  'douyin.com',
  'www.iesdouyin.com',
  'm.iesdouyin.com',
  'iesdouyin.com'
];

const SHORT_HOSTS = new Set(['v.douyin.com']);
const WEB_HOSTS = new Set(['douyin.com', 'www.douyin.com', 'm.douyin.com']);
const SHARE_HOSTS = new Set(['iesdouyin.com', 'www.iesdouyin.com', 'm.iesdouyin.com']);

const SESSION_TTL_MS = 25 * 60 * 1000;
let cachedSession = { cookie: '', uifid: '', at: 0 };

export function resetDouyinSession() {
  cachedSession = { cookie: '', uifid: '', at: 0 };
}

export function formatDouyinDuration(sec) {
  const n = Math.max(0, Math.round(Number(sec) || 0));
  if (!n) return '未知';
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = n % 60;
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

export function formatDouyinCount(n) {
  if (n == null || n === '' || !Number.isFinite(Number(n))) return '未知';
  const num = Number(n);
  if (num >= 100_000_000) return `${(num / 100_000_000).toFixed(2)}亿`;
  if (num >= 10_000) return `${(num / 10_000).toFixed(1)}万`;
  return String(Math.round(num));
}

export function isDouyinExtractableUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (!/^https?:$/i.test(u.protocol)) return false;
    const host = u.hostname.toLowerCase();
    if (SHORT_HOSTS.has(host)) return /^\/[A-Za-z0-9_-]{4,}/.test(u.pathname);
    if (WEB_HOSTS.has(host)) {
      if (/\/(?:video|note|slides)\/\d{6,}/i.test(u.pathname)) return true;
      const modal = u.searchParams.get('modal_id') || u.searchParams.get('aweme_id') || '';
      return /^\d{6,}$/.test(modal);
    }
    if (SHARE_HOSTS.has(host)) {
      if (/\/(?:share\/)?(?:video|note|slides)\/\d{6,}/i.test(u.pathname)) return true;
      const modal = u.searchParams.get('modal_id') || u.searchParams.get('aweme_id') || '';
      return /^\d{6,}$/.test(modal);
    }
    return false;
  } catch {
    return false;
  }
}

export function pickDouyinLinks(text) {
  return extractCandidateUrls(text, { bareHosts: BARE_DOUYIN_HOSTS }).filter(isDouyinExtractableUrl);
}

export function pickDouyinLink(text) {
  return pickDouyinLinks(text)[0] || '';
}

export function isDouyinLink(text) {
  return Boolean(pickDouyinLink(text));
}

export function parseDouyinUrl(rawUrl) {
  const raw = String(rawUrl || '').trim();
  const out = { kind: 'unknown', raw };
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    if (SHORT_HOSTS.has(host)) {
      const m = u.pathname.match(/^\/([A-Za-z0-9_-]{4,})/);
      if (m) return { kind: 'short', shortCode: m[1], raw };
      return out;
    }
    if (WEB_HOSTS.has(host) || SHARE_HOSTS.has(host)) {
      const pm = u.pathname.match(/\/(?:share\/)?(video|note|slides)\/(\d{6,})/i);
      if (pm) return { kind: pm[1].toLowerCase(), awemeId: pm[2], raw };
      const qid = u.searchParams.get('modal_id') || u.searchParams.get('aweme_id') || '';
      if (/^\d{6,}$/.test(qid)) return { kind: 'video', awemeId: qid, raw };
    }
  } catch {
    // 非法 URL 返回 unknown
  }
  return out;
}

function classifyNonVideoTarget(targetUrl) {
  try {
    const u = new URL(targetUrl);
    const host = u.hostname.toLowerCase();
    if (host.includes('live.douyin.com') || /\/live(?:\/|$)/i.test(u.pathname)) {
      return '该短链指向抖音直播间，暂不支持转发直播';
    }
    if (/^\/user\//i.test(u.pathname)) {
      return '该短链指向抖音用户主页，不是具体视频或图文';
    }
    return `短链未跳转到抖音视频或图文（${host}）`;
  } catch {
    return '短链跳转目标无效';
  }
}

export async function expandDouyinShortLink(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10000;
  const doFetch = typeof options.fetchImpl === 'function' ? options.fetchImpl : fetch;
  let current = String(url || '').trim();
  const parsed = parseDouyinUrl(current);
  if (parsed.awemeId) return { ok: true, url: current, expanded: false };
  if (parsed.kind !== 'short') return { ok: false, error: '不是支持的抖音链接' };

  let expanded = false;
  for (let hop = 0; hop < 3; hop += 1) {
    let res;
    try {
      res = await doFetch(current, {
        headers: { 'User-Agent': UA_MOBILE },
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      return { ok: false, error: `短链请求失败：${error?.message ?? error}` };
    }
    const loc = res.headers?.get?.('location') || '';
    await res.body?.cancel?.().catch(() => {});
    if (!loc) {
      return { ok: false, error: `短链未返回跳转（HTTP ${res.status}）` };
    }
    let nextUrl;
    try {
      nextUrl = new URL(loc, current).toString();
    } catch {
      return { ok: false, error: '短链返回了无效的跳转地址' };
    }
    expanded = true;
    const nextParsed = parseDouyinUrl(nextUrl);
    if (nextParsed.awemeId) return { ok: true, url: nextUrl, expanded };
    if (nextParsed.kind !== 'short') {
      return { ok: false, error: classifyNonVideoTarget(nextUrl), targetUrl: nextUrl };
    }
    current = nextUrl;
  }
  return { ok: false, error: '短链跳转次数过多，未解析到作品 ID' };
}

export async function resolveDouyinLink(rawUrl, options = {}) {
  const first = parseDouyinUrl(rawUrl);
  if (first.awemeId) return first;
  if (first.kind !== 'short') return { ...first, error: '不是支持的抖音视频或图文链接' };
  const ex = await expandDouyinShortLink(rawUrl, options);
  if (!ex.ok) return { ...first, error: ex.error };
  const second = parseDouyinUrl(ex.url);
  if (!second.awemeId) return { ...second, expanded: ex.expanded, error: '跳转链接未包含作品 ID' };
  return { ...second, expanded: ex.expanded };
}

function getSetCookieList(headers) {
  if (!headers) return [];
  if (typeof headers.getSetCookie === 'function') {
    const list = headers.getSetCookie();
    if (Array.isArray(list)) return list;
  }
  const single = headers.get?.('set-cookie');
  if (!single) return [];
  return String(single).split(/,(?=\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+=)/);
}

function mergeCookies(jar, setCookieList) {
  for (const rawCookie of setCookieList || []) {
    const pair = String(rawCookie || '').split(';')[0];
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const val = pair.slice(eq + 1).trim();
    if (name && val) jar.set(name, val);
  }
}

function serializeCookies(jar) {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

export async function ensureDouyinSession(options = {}) {
  const timeoutMs = options.timeoutMs ?? 10000;
  const force = options.force === true;
  const doFetch = typeof options.fetchImpl === 'function' ? options.fetchImpl : fetch;
  if (!force && cachedSession.cookie && cachedSession.uifid && Date.now() - cachedSession.at < SESSION_TTL_MS) {
    return { ok: true, cookie: cachedSession.cookie, uifid: cachedSession.uifid };
  }

  const jar = new Map();
  jar.set('passport_csrf_token', randomBytes(16).toString('hex'));

  try {
    const regRes = await doFetch(`${DOUYIN_ORIGIN}/ttwid/register`, {
      method: 'POST',
      headers: {
        'User-Agent': UA_DESKTOP,
        'Content-Type': 'application/json',
        Referer: DOUYIN_REFERER,
        Origin: DOUYIN_ORIGIN
      },
      body: JSON.stringify({ aid: Number(DOUYIN_AID), service: 'www.douyin.com' }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    mergeCookies(jar, getSetCookieList(regRes.headers));
    await regRes.body?.cancel?.().catch(() => {});
  } catch {
    // ttwid 注册失败时仍继续尝试首页获取匿名会话 Cookie / uifid
  }

  let uifid = '';
  try {
    const homeRes = await doFetch(DOUYIN_REFERER, {
      headers: {
        'User-Agent': UA_DESKTOP,
        Referer: DOUYIN_REFERER,
        Cookie: serializeCookies(jar)
      },
      signal: AbortSignal.timeout(timeoutMs)
    });
    mergeCookies(jar, getSetCookieList(homeRes.headers));
    uifid = jar.get('UIFID')
      || jar.get('uifid')
      || jar.get('UIFID_TEMP')
      || String(homeRes.headers?.get?.('x-tt-trace-host') || '').trim();
    await homeRes.body?.cancel?.().catch(() => {});
  } catch (error) {
    return { ok: false, error: `获取抖音匿名会话失败：${error?.message ?? error}` };
  }

  if (!uifid) {
    return { ok: false, error: '未能获取抖音匿名会话标识（uifid）' };
  }

  const cookie = serializeCookies(jar);
  cachedSession = { cookie, uifid, at: Date.now() };
  return { ok: true, cookie, uifid };
}

export function signDouyinDetailQuery({
  awemeId,
  uifid,
  timestamp = Math.floor(Date.now() / 1000),
  aid = DOUYIN_AID
}) {
  const params = new URLSearchParams({
    aweme_id: String(awemeId),
    aid: String(aid),
    uifid: String(uifid),
    timestamp: String(timestamp)
  });
  const query = params.toString();
  const signature = createHash('md5')
    .update(`${uifid}_${timestamp}_${DOUYIN_SIGN_SALT}_${query}`)
    .digest('hex');
  return `${DOUYIN_ORIGIN}/aweme/v1/web/aweme/detail/?${query}&x-secsdk-web-signature=${signature}`;
}

export function mapFilterDetailError(filterDetail) {
  const reason = String(filterDetail?.filter_reason || '').trim();
  if (reason === 'core_dep') return '视频已删除、不存在或暂时不可访问';
  if (reason === 'status_self_see') return '该作品设为私密或仅作者可见';
  return String(filterDetail?.detail_msg || filterDetail?.notice || reason || '该抖音作品不可访问').trim();
}

function normalizePlayUrl(rawUrl) {
  const s = String(rawUrl || '').trim();
  if (!/^https?:\/\//i.test(s)) return '';
  return s.replace('/playwm/', '/play/');
}

function rankImageUrl(rawUrl) {
  const lower = String(rawUrl || '').toLowerCase();
  if (/\.(?:jpe?g|png)(?:[?#]|$)/.test(lower) || /format=(?:jpeg|jpg|png)/.test(lower)) return 0;
  if (/\.webp(?:[?#]|$)/.test(lower) || /format=webp/.test(lower)) return 1;
  return 2;
}

function extractImageMirrors(img) {
  const candidates = (Array.isArray(img?.url_list) ? img.url_list : [])
    .map(u => String(u || '').trim())
    .filter(u => /^https?:\/\//i.test(u));
  if (!candidates.length) return null;
  const sorted = [...new Set(candidates)].sort((a, b) => rankImageUrl(a) - rankImageUrl(b));
  return { url: sorted[0], mirrors: sorted };
}

export function normalizeDouyinQuality(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw === '540' || raw === '540p') return '540p';
  if (raw === '720' || raw === '720p') return '720p';
  if (raw === '1080' || raw === '1080p') return '1080p';
  if (raw === 'highest' || raw === 'auto' || raw === 'max' || raw === 'original') return 'highest';
  return '720p';
}

function targetResolutionPx(quality) {
  const q = normalizeDouyinQuality(quality);
  if (q === '540p') return 540;
  if (q === '720p') return 720;
  if (q === '1080p') return 1080;
  return Infinity;
}

export function inferStreamResolution(stream) {
  const gear = String(stream?.gear || '');
  const gearMatch = gear.match(/(?:^|_)(2160|1440|1080|720|540|480|360)(?=_|$)/);
  if (gearMatch) return Number(gearMatch[1]);
  const w = Number(stream?.width) || 0;
  const h = Number(stream?.height) || 0;
  const shortEdge = w > 0 && h > 0 ? Math.min(w, h) : Math.max(w, h);
  if (shortEdge >= 1900) return 2160;
  if (shortEdge >= 1350) return 1440;
  if (shortEdge >= 1000) return 1080;
  if (shortEdge >= 680) return 720;
  if (shortEdge >= 480) return 540;
  if (shortEdge >= 320) return 360;
  return 0;
}

export function selectVideoStreams(video) {
  if (!video || typeof video !== 'object') return [];
  const entries = Array.isArray(video.bit_rate) ? video.bit_rate : [];
  const streams = [];
  const seenKey = new Set();

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const urls = [...new Set((entry.play_addr?.url_list || []).map(normalizePlayUrl).filter(Boolean))];
    if (!urls.length) continue;
    const gear = String(entry.gear_name || '').trim() || 'stream';
    const isHevc = entry.is_h265 === 1 || entry.is_bytevc1 === 1 || /bytevc1|h265|hevc/i.test(gear);
    const bitRate = Number(entry.bit_rate) || 0;
    const sizeBytes = Number(entry.play_addr?.data_size) || 0;
    const width = Number(entry.play_addr?.width) || Number(video.width) || 0;
    const height = Number(entry.play_addr?.height) || Number(video.height) || 0;
    const resolution = inferStreamResolution({ gear, width, height });
    const dedup = urls[0];
    if (seenKey.has(dedup)) continue;
    seenKey.add(dedup);
    streams.push({ gear, isHevc, bitRate, sizeBytes, width, height, resolution, urls });
  }

  const h264Streams = streams
    .filter(s => !s.isHevc)
    .sort((a, b) => b.bitRate - a.bitRate || a.sizeBytes - b.sizeBytes);
  const hevcStreams = streams
    .filter(s => s.isHevc)
    .sort((a, b) => b.bitRate - a.bitRate || a.sizeBytes - b.sizeBytes);

  const fallbackUrls = [...new Set((video.play_addr?.url_list || []).map(normalizePlayUrl).filter(Boolean))];
  const hasFallbackOnly = fallbackUrls.length && !fallbackUrls.every(u => seenKey.has(u));
  const defaultWidth = Number(video.width) || 0;
  const defaultHeight = Number(video.height) || 0;
  const defaultStream = hasFallbackOnly
    ? [{
        gear: 'default',
        isHevc: false,
        bitRate: 1,
        sizeBytes: Number(video.play_addr?.data_size) || 0,
        width: defaultWidth,
        height: defaultHeight,
        resolution: inferStreamResolution({ gear: 'default', width: defaultWidth, height: defaultHeight }),
        urls: fallbackUrls
      }]
    : [];

  return [...h264Streams, ...defaultStream, ...hevcStreams];
}

function sortByTargetResolution(list, targetPx) {
  if (!Number.isFinite(targetPx)) {
    return [...list].sort((a, b) => (b.bitRate || 0) - (a.bitRate || 0) || (a.sizeBytes || 0) - (b.sizeBytes || 0));
  }
  const withRes = list.map(item => ({
    item,
    res: Number(item.resolution) || inferStreamResolution(item)
  }));
  const within = withRes.filter(x => x.res > 0 && x.res <= targetPx)
    .sort((a, b) => b.res - a.res || (b.item.bitRate || 0) - (a.item.bitRate || 0) || (a.item.sizeBytes || 0) - (b.item.sizeBytes || 0));
  const unknown = withRes.filter(x => x.res === 0)
    .sort((a, b) => (b.item.bitRate || 0) - (a.item.bitRate || 0) || (a.item.sizeBytes || 0) - (b.item.sizeBytes || 0));
  const above = withRes.filter(x => x.res > targetPx)
    .sort((a, b) => a.res - b.res || (b.item.bitRate || 0) - (a.item.bitRate || 0) || (a.item.sizeBytes || 0) - (b.item.sizeBytes || 0));
  return [...within, ...unknown, ...above].map(x => x.item);
}

export function pickVideoStreamCandidates(streams, maxFileBytes, options = {}) {
  const list = Array.isArray(streams) ? streams.filter(s => Array.isArray(s?.urls) && s.urls.length) : [];
  if (!list.length) return { ok: false, error: '未获取到可用视频播放地址' };
  const withinSize = list.filter(s => !s.sizeBytes || s.sizeBytes <= maxFileBytes);
  if (!withinSize.length) {
    const minSizeBytes = list.reduce((min, s) => (s.sizeBytes && s.sizeBytes < min ? s.sizeBytes : min), list[0].sizeBytes);
    return {
      ok: false,
      tooLarge: true,
      sizeBytes: minSizeBytes,
      error: `视频最低码率体积仍超过 ${Math.round(maxFileBytes / 1048576)} MiB 限制`
    };
  }
  const targetPx = targetResolutionPx(options.preferredQuality);
  const h264 = sortByTargetResolution(withinSize.filter(s => !s.isHevc && s.gear !== 'default'), targetPx);
  const defaults = withinSize.filter(s => s.gear === 'default');
  const hevc = sortByTargetResolution(withinSize.filter(s => s.isHevc), targetPx);
  return { ok: true, candidates: [...h264, ...defaults, ...hevc] };
}

function firstValidImageUrl(obj) {
  const list = obj?.url_list;
  if (!Array.isArray(list)) return '';
  const sorted = [...list].map(u => String(u || '').trim()).filter(u => /^https?:\/\//i.test(u))
    .sort((a, b) => rankImageUrl(a) - rankImageUrl(b));
  return sorted[0] || '';
}

function parseAwemeStats(statsObj) {
  if (!statsObj || typeof statsObj !== 'object') return null;
  const pick = (val) => (val == null || val === '' || !Number.isFinite(Number(val)) ? null : Number(val));
  return {
    digg: pick(statsObj.digg_count),
    comment: pick(statsObj.comment_count),
    collect: pick(statsObj.collect_count),
    share: pick(statsObj.share_count)
  };
}

export function parseAwemeDetail(detail, fallbackId = '', source = 'detail-api') {
  if (!detail || typeof detail !== 'object') {
    return { ok: false, error: '未获取到作品详情数据' };
  }
  const awemeId = String(detail.aweme_id || fallbackId || '').trim();
  const title = String(detail.desc || '').replace(/\s+/g, ' ').trim();
  const author = String(detail.author?.nickname || '').replace(/\s+/g, ' ').trim();
  const stats = parseAwemeStats(detail.statistics);
  const createTime = Number(detail.create_time) || 0;

  // 关键防坑：抖音图文作品（images 非空）往往同时带 video.play_addr 指向背景音频 mp3，
  // 必须先判断 images 再判断 video，避免把背景音乐当成视频发送。
  const rawImages = Array.isArray(detail.images) ? detail.images : [];
  if (rawImages.length > 0) {
    const images = rawImages.map(extractImageMirrors).filter(Boolean);
    if (!images.length) {
      return { ok: false, error: '图文作品未包含可用图片地址' };
    }
    const cover = images[0].url
      || firstValidImageUrl(detail.video?.origin_cover)
      || firstValidImageUrl(detail.video?.cover);
    return {
      ok: true,
      kind: 'gallery',
      awemeId,
      title,
      author,
      duration: 0,
      cover,
      images,
      streams: [],
      stats,
      createTime,
      source
    };
  }

  const streams = selectVideoStreams(detail.video);
  const cover = firstValidImageUrl(detail.video?.origin_cover)
    || firstValidImageUrl(detail.video?.cover)
    || firstValidImageUrl(detail.video?.dynamic_cover);
  const rawDuration = Number(detail.duration || detail.video?.duration) || 0;
  const duration = rawDuration > 0 ? Math.max(1, Math.round(rawDuration / 1000)) : 0;

  return {
    ok: true,
    kind: 'video',
    awemeId,
    title,
    author,
    duration,
    cover,
    images: [],
    streams,
    stats,
    createTime,
    source
  };
}

function extractBalancedJson(html, marker) {
  const s = String(html || '');
  const idx = s.indexOf(marker);
  if (idx < 0) return null;
  let pos = s.indexOf('{', idx + marker.length);
  if (pos < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = pos; i < s.length; i += 1) {
    const ch = s[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') { depth += 1; continue; }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(pos, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function findItemInRouterData(routerData) {
  const loaderData = routerData?.loaderData;
  if (!loaderData || typeof loaderData !== 'object') return null;
  for (const val of Object.values(loaderData)) {
    if (val && typeof val === 'object') {
      const item = val.videoInfoRes?.item_list?.[0];
      if (item && typeof item === 'object') return item;
    }
  }
  return null;
}

function extractRenderDataItem(html) {
  const m = String(html || '').match(/<script[^>]+id=["']RENDER_DATA["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return null;
  try {
    const data = JSON.parse(decodeURIComponent(m[1]));
    const stack = [data];
    let guard = 0;
    while (stack.length && guard < 200) {
      guard += 1;
      const cur = stack.pop();
      if (!cur || typeof cur !== 'object') continue;
      if (cur.aweme_id && (cur.video || cur.images)) return cur;
      if (cur.awemeDetail?.aweme_id) return cur.awemeDetail;
      for (const v of Object.values(cur)) {
        if (v && typeof v === 'object') stack.push(v);
      }
    }
  } catch {
    // 忽略格式异常的 RENDER_DATA
  }
  return null;
}

export async function fetchFromDetailApi(awemeId, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15000;
  const doFetch = typeof options.fetchImpl === 'function' ? options.fetchImpl : fetch;
  let session = await ensureDouyinSession({ timeoutMs, fetchImpl: doFetch });
  if (!session.ok) return { ok: false, error: session.error };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const apiUrl = signDouyinDetailQuery({ awemeId, uifid: session.uifid });
    let res;
    try {
      res = await doFetch(apiUrl, {
        headers: {
          'User-Agent': UA_DESKTOP,
          Referer: DOUYIN_REFERER,
          Cookie: session.cookie
        },
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      return { ok: false, error: `详情接口请求失败：${error?.message ?? error}` };
    }
    const text = await res.text();
    const shouldRefresh = res.status === 403 || !text.trim();
    let body = null;
    if (!shouldRefresh) {
      try {
        body = JSON.parse(text);
      } catch {
        // 非 JSON 可能是风控页，刷新会话重试一次
      }
    }
    if ((shouldRefresh || !body) && attempt === 0) {
      session = await ensureDouyinSession({ timeoutMs, force: true, fetchImpl: doFetch });
      if (!session.ok) return { ok: false, error: session.error };
      continue;
    }
    if (res.status !== 200) {
      return { ok: false, error: `详情接口 HTTP ${res.status}`, status: res.status };
    }
    if (!body) {
      return { ok: false, error: '详情接口未返回有效 JSON' };
    }
    if (body.aweme_detail) {
      return parseAwemeDetail(body.aweme_detail, awemeId, 'detail-api');
    }
    if (body.filter_detail) {
      return {
        ok: false,
        businessError: true,
        error: mapFilterDetailError(body.filter_detail)
      };
    }
    if (body.status_code && body.status_code !== 0) {
      if (attempt === 0) {
        session = await ensureDouyinSession({ timeoutMs, force: true, fetchImpl: doFetch });
        if (session.ok) continue;
      }
      return { ok: false, error: body.status_msg || `抖音接口状态码 ${body.status_code}` };
    }
    return { ok: false, error: '抖音详情接口未返回作品信息' };
  }
  return { ok: false, error: '抖音匿名会话校验失败，请稍后重试' };
}

export async function fetchFromSharePage(awemeId, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15000;
  const doFetch = typeof options.fetchImpl === 'function' ? options.fetchImpl : fetch;
  const shareUrl = `https://www.iesdouyin.com/share/video/${encodeURIComponent(awemeId)}/`;
  let res;
  try {
    res = await doFetch(shareUrl, {
      headers: {
        'User-Agent': UA_MOBILE,
        Referer: 'https://www.iesdouyin.com/'
      },
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    return { ok: false, error: `分享页请求失败：${error?.message ?? error}` };
  }
  if (res.status !== 200) {
    await res.body?.cancel?.().catch(() => {});
    return { ok: false, error: `分享页 HTTP ${res.status}` };
  }
  const html = await res.text();
  const routerItem = findItemInRouterData(extractBalancedJson(html, 'window._ROUTER_DATA'));
  if (routerItem) return parseAwemeDetail(routerItem, awemeId, 'iesdouyin-router');
  const renderItem = extractRenderDataItem(html);
  if (renderItem) return parseAwemeDetail(renderItem, awemeId, 'iesdouyin-render');
  return { ok: false, error: '分享页未包含作品信息' };
}

export async function fetchDouyinInfo(link, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15000;
  const doFetch = typeof options.fetchImpl === 'function' ? options.fetchImpl : fetch;
  const parsed = typeof link === 'string' ? parseDouyinUrl(link) : (link || {});
  const awemeId = String(parsed.awemeId || '').trim();
  if (!awemeId) return { ok: false, error: parsed.error || '缺少有效的抖音作品 ID' };

  const primary = await fetchFromDetailApi(awemeId, { timeoutMs, fetchImpl: doFetch });
  if (primary.ok || primary.businessError) return primary;

  const fallback = await fetchFromSharePage(awemeId, { timeoutMs, fetchImpl: doFetch });
  if (fallback.ok) return fallback;

  return {
    ok: false,
    error: `${primary.error}${fallback.error ? `（备用页：${fallback.error}）` : ''}`
  };
}

export async function downloadDouyinVideo(urls, destPath, options = {}) {
  const maxBytes = options.maxBytes ?? 100 * 1024 * 1024;
  const referer = options.referer || DOUYIN_REFERER;
  const timeoutMs = options.timeoutMs ?? 60000;
  const logFn = typeof options.log === 'function' ? options.log : () => {};
  const doFetch = typeof options.fetchImpl === 'function' ? options.fetchImpl : fetch;
  const list = Array.isArray(urls)
    ? [...new Set(urls.map(u => String(u || '').trim()).filter(Boolean))]
    : (typeof urls === 'string' && urls.trim() ? [urls.trim()] : []);
  if (!list.length) return { ok: false, error: '视频下载地址为空' };

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  let lastError = '下载失败';

  for (let idx = 0; idx < list.length; idx += 1) {
    const mirrorUrl = list[idx];
    let res;
    try {
      res = await doFetch(mirrorUrl, {
        headers: {
          'User-Agent': UA_DESKTOP,
          Referer: referer
        },
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      lastError = `下载请求失败：${error?.message ?? error}`;
      continue;
    }

    if (res.status !== 200 && res.status !== 206) {
      await res.body?.cancel?.().catch(() => {});
      lastError = `下载被拒（HTTP ${res.status}）`;
      continue;
    }

    const ctype = String(res.headers?.get?.('content-type') || '');
    if (/text\/html|application\/json|^audio\//i.test(ctype)) {
      await res.body?.cancel?.().catch(() => {});
      lastError = `下载到的不是视频（Content-Type: ${ctype}）`;
      continue;
    }

    const declaredLen = Number(res.headers?.get?.('content-length')) || 0;
    if (declaredLen > maxBytes) {
      await res.body?.cancel?.().catch(() => {});
      return {
        ok: false,
        tooLarge: true,
        sizeBytes: declaredLen,
        error: `视频超过体积上限（>${Math.round(maxBytes / 1048576)}MB），已放弃`
      };
    }

    const fh = fs.openSync(destPath, 'w');
    let written = 0;
    let streamError = null;
    let tooLargeResult = null;
    try {
      const reader = res.body?.getReader?.();
      if (!reader) {
        const buf = Buffer.from(await res.arrayBuffer());
        written += buf.length;
        if (written > maxBytes) {
          tooLargeResult = {
            ok: false,
            tooLarge: true,
            sizeBytes: written,
            error: `视频超过体积上限（>${Math.round(maxBytes / 1048576)}MB），已放弃`
          };
        } else {
          fs.writeSync(fh, buf);
        }
      } else {
        let finished = false;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) { finished = true; break; }
            written += value.length;
            if (written > maxBytes) {
              tooLargeResult = {
                ok: false,
                tooLarge: true,
                sizeBytes: written,
                error: `视频超过体积上限（>${Math.round(maxBytes / 1048576)}MB），已放弃`
              };
              break;
            }
            fs.writeSync(fh, Buffer.from(value));
          }
        } catch (error) {
          streamError = error;
        } finally {
          if (!finished) await reader.cancel?.().catch(() => {});
        }
      }
    } finally {
      try { fs.closeSync(fh); } catch { /* ignore */ }
    }

    if (tooLargeResult) {
      try { fs.unlinkSync(destPath); } catch { /* ignore */ }
      return tooLargeResult;
    }
    if (streamError) {
      try { fs.unlinkSync(destPath); } catch { /* ignore */ }
      lastError = `视频流中断：${streamError?.message ?? streamError}`;
      continue;
    }
    if (!written) {
      try { fs.unlinkSync(destPath); } catch { /* ignore */ }
      lastError = '下载内容为空';
      continue;
    }

    logFn(`抖音视频镜像 ${idx + 1}/${list.length} 下载完成（${(written / 1048576).toFixed(1)}MB）`);
    return { ok: true, bytes: written };
  }

  try { fs.unlinkSync(destPath); } catch { /* ignore */ }
  return { ok: false, error: lastError };
}

export function safeDouyinFileName(info) {
  const bad = /[\\/:*?"<>|\u0000-\u001f]/g;
  const title = String(info?.title || 'video').replace(bad, '_').slice(0, 60);
  const id = String(info?.awemeId || 'douyin').replace(bad, '_');
  return `dy_${id}_${title}.mp4`.replace(/\s+/g, ' ').trim();
}

export function douyinShareCaption(info, { link = '' } = {}) {
  const title = String(info?.title || (info?.kind === 'gallery' ? '抖音图文' : '抖音视频')).trim();
  const meta = [];
  if (info?.author) meta.push(info.author);
  if (info?.kind === 'gallery') {
    const count = info.images?.length || 0;
    meta.push(count ? `图文 ${count}P` : '图文');
  } else if (info?.duration) {
    meta.push(formatDouyinDuration(info.duration));
  }
  const url = link || (info?.awemeId
    ? `https://www.douyin.com/${info.kind === 'gallery' ? 'note' : 'video'}/${info.awemeId}`
    : '');
  return [title, meta.join(' · '), url].filter(Boolean).join('\n');
}

export function douyinDetailCaption(info, { link = '' } = {}) {
  const count = (key) => formatDouyinCount(info?.stats?.[key]);
  const isGallery = info?.kind === 'gallery';
  const defaultTitle = isGallery ? '抖音图文' : '抖音视频';
  const title = String(info?.title || defaultTitle).replace(/\s+/g, ' ').trim().slice(0, 300);
  const author = String(info?.author || '未知').replace(/\s+/g, ' ').trim().slice(0, 100);
  const url = link || (info?.awemeId
    ? `https://www.douyin.com/${isGallery ? 'note' : 'video'}/${info.awemeId}`
    : '');
  const metaLine = isGallery
    ? `图片：${info?.images?.length || 0} 张`
    : `时长：${formatDouyinDuration(info?.duration)}`;
  return [
    `抖音｜${title}`,
    url,
    `作者：${author}`,
    metaLine,
    `点赞：${count('digg')} | 评论：${count('comment')} | 收藏：${count('collect')} | 分享：${count('share')}`
  ].filter(Boolean).join('\n');
}
