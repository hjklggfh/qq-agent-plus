import fs from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_COLLECTION_KEYWORDS = ['合集', '歌单', '循环', '助眠', '白噪音', 'playlist', 'mix'];
export const DEFAULT_SEEN_TTL_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_JOB_TTL_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_JOB_CLEANUP_DELAY_MS = 10 * 60 * 1000;

const TRAILING_URL_PUNCT_RE = /[),.!?，。！？】）}'"\\\]]+$/g;
const DISALLOWED_URL_CHAR = '\\s<>“”‘’【】「」『』《》（）()\\[\\]"`\'\\u3000-\\u303f\\u3400-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef';

function escapeRegExp(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function trimUrl(raw) {
  return String(raw || '').replace(TRAILING_URL_PUNCT_RE, '');
}

/**
 * 从文本或分享文案中提取 URL：
 * - 在空白、常见中文标点与汉字前停止，避免 "https://v.douyin.com/xxx/复制打开抖音" 连粘；
 * - 可选识别不带协议的指定域名短链（自动补全 https://）。
 */
export function extractCandidateUrls(text, { bareHosts = [] } = {}) {
  const input = String(text || '');
  if (!input) return [];
  const hosts = bareHosts.map(h => String(h || '').trim().toLowerCase()).filter(Boolean);
  const pattern = hosts.length
    ? `(?:https?:\\/\\/|(?<![:/A-Za-z0-9._-])(?:${hosts.map(escapeRegExp).join('|')})\\/)`
    : 'https?:\\/\\/';
  const re = new RegExp(`${pattern}[^${DISALLOWED_URL_CHAR}]+`, 'gi');
  const rawMatches = input.match(re) || [];
  const out = [];
  for (const m of rawMatches) {
    const cleaned = trimUrl(m);
    if (!cleaned) continue;
    out.push(/^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`);
  }
  return [...new Set(out)];
}

export function decodeCardSource(value) {
  let out = String(value || '');
  if (!out) return '';
  for (let i = 0; i < 3; i += 1) {
    const next = out
      .replace(/\\u002f/gi, '/')
      .replace(/\\u0026/gi, '&')
      .replace(/\\\//g, '/')
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&#38;/gi, '&')
      .replace(/&#47;/gi, '/')
      .replace(/&#x2f;/gi, '/');
    if (next === out) break;
    out = next;
  }
  return out;
}

function collectStringsFromValue(value, out, depth = 0, seenObjects = null) {
  if (value == null || depth > 8) return;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return;
    out.push(decodeCardSource(trimmed));
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        const parsed = JSON.parse(trimmed);
        collectStringsFromValue(parsed, out, depth + 1, seenObjects);
      } catch {
        // 忽略非合法 JSON 字符串
      }
    }
    return;
  }
  if (typeof value !== 'object') return;
  const seen = seenObjects || new Set();
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectStringsFromValue(item, out, depth + 1, seen);
    return;
  }
  for (const v of Object.values(value)) {
    collectStringsFromValue(v, out, depth + 1, seen);
  }
}

const IGNORED_SEGMENT_TYPES = new Set(['image', 'record', 'video', 'file', 'face', 'mface', 'poke', 'at', 'reply']);

export function collectCardSources(segments) {
  if (!Array.isArray(segments)) return [];
  const out = [];
  const seen = new Set();
  for (const seg of segments) {
    if (!seg || typeof seg !== 'object') continue;
    const type = String(seg.type || '').toLowerCase();
    if (IGNORED_SEGMENT_TYPES.has(type)) continue;
    if (type === 'text') {
      if (seg.data?.text) out.push(String(seg.data.text));
      continue;
    }
    collectStringsFromValue(seg.data, out, 0, seen);
  }
  return out;
}

export function normalizeCollectionKeywords(raw, fallback = DEFAULT_COLLECTION_KEYWORDS) {
  if (Array.isArray(raw)) {
    const items = [...new Set(raw.map(s => String(s || '').trim()).filter(Boolean))];
    return items.length ? items : [...fallback];
  }
  if (typeof raw === 'string') {
    const items = [...new Set(raw.split(/[,，\n\r]+/).map(s => s.trim()).filter(Boolean))];
    return items.length ? items : [...fallback];
  }
  return [...fallback];
}

export function matchCollectionKeyword(title, keywords = DEFAULT_COLLECTION_KEYWORDS) {
  const lower = String(title || '').toLowerCase();
  if (!lower) return '';
  for (const kw of keywords || []) {
    const k = String(kw || '').trim().toLowerCase();
    if (k && lower.includes(k)) return String(kw).trim();
  }
  return '';
}

export function durationText(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (!s) return '0:00';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
    : `${m}:${String(r).padStart(2, '0')}`;
}

export function clampNumber(value, { fallback, min, max, integer = false }) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const bounded = Math.min(max, Math.max(min, n));
  return integer ? Math.round(bounded) : bounded;
}

export function createSeenTracker(ttlMs = DEFAULT_SEEN_TTL_MS) {
  const seen = new Map();
  const seenCanonical = new Map();

  function prune(now = Date.now()) {
    for (const [k, ts] of seen) {
      if (now - ts > ttlMs) seen.delete(k);
    }
    for (const [k, ts] of seenCanonical) {
      if (now - ts > ttlMs) seenCanonical.delete(k);
    }
  }

  function syncReset() {
    if (seen.size === 0 && seenCanonical.size > 0) seenCanonical.clear();
  }

  function hasUrl(key, now = Date.now()) {
    syncReset();
    prune(now);
    const ts = seen.get(key);
    return typeof ts === 'number' && now - ts < ttlMs;
  }

  function markUrl(key, now = Date.now()) {
    if (!seen.has(key) && seen.size >= 5000) seen.delete(seen.keys().next().value);
    seen.set(key, now);
  }

  function unmarkUrl(key) {
    seen.delete(key);
  }

  function hasCanonical(key, now = Date.now()) {
    syncReset();
    prune(now);
    const ts = seenCanonical.get(key);
    return typeof ts === 'number' && now - ts < ttlMs;
  }

  function markCanonical(key, now = Date.now()) {
    if (!key) return;
    if (!seenCanonical.has(key) && seenCanonical.size >= 5000) seenCanonical.delete(seenCanonical.keys().next().value);
    seenCanonical.set(key, now);
  }

  function unmarkCanonical(key) {
    if (key) seenCanonical.delete(key);
  }

  return {
    seen,
    seenCanonical,
    prune,
    syncReset,
    hasUrl,
    markUrl,
    unmarkUrl,
    hasCanonical,
    markCanonical,
    unmarkCanonical
  };
}

export async function chmodBestEffort(targetPath, mode) {
  try {
    await fs.chmod(targetPath, mode);
  } catch {
    // 非 POSIX 文件系统或权限受限时忽略
  }
}

export async function pruneMediaJobs(mediaRoot, maxAgeMs = DEFAULT_JOB_TTL_MS) {
  try {
    const entries = await fs.readdir(mediaRoot, { withFileTypes: true });
    const now = Date.now();
    await Promise.all(entries.map(async entry => {
      if (!entry.isDirectory() || !entry.name.startsWith('job-')) return;
      const full = path.join(mediaRoot, entry.name);
      try {
        const st = await fs.stat(full);
        if (now - st.mtimeMs > maxAgeMs) {
          await fs.rm(full, { recursive: true, force: true });
        }
      } catch {
        // 忽略并发清理造成的 stat/rm 竞争
      }
    }));
  } catch {
    // mediaRoot 尚未创建时忽略
  }
}

export function removeMediaJobLater(jobDir, delayMs = DEFAULT_JOB_CLEANUP_DELAY_MS) {
  if (!jobDir) return;
  const timer = setTimeout(() => {
    fs.rm(jobDir, { recursive: true, force: true }).catch(() => {});
  }, delayMs);
  timer?.unref?.();
}

export function splitImageBatches(items, batchSize = 10) {
  const out = [];
  const size = Math.max(1, Math.floor(batchSize));
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
