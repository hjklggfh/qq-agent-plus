import fs from 'node:fs';
import path from 'node:path';

export const RANK_META = Object.freeze({
  daily: { kind: 'daily', label: 'JM日榜', title: '🔥 今日 JM 热度日榜' },
  weekly: { kind: 'weekly', label: 'JM周榜', title: '📈 本周 JM 热度周榜' },
  monthly: { kind: 'monthly', label: 'JM月榜', title: '🗓 本月 JM 热度月榜' },
  total: { kind: 'total', label: 'JM热门总榜', title: '🏆 JM 热门总榜' },
});

export function normalizeRankKind(kind) {
  const k = String(kind || 'daily').trim().toLowerCase();
  return Object.hasOwn(RANK_META, k) ? k : 'daily';
}

export function rankFiles(dataRoot, kind) {
  const k = normalizeRankKind(kind);
  const dir = path.join(String(dataRoot), 'ranks');
  return {
    dir,
    jsonPath: path.join(dir, `rank-${k}.json`),
    imagePath: path.join(dir, `rank-${k}.jpg`),
  };
}

function beijingDateKey(now = Date.now()) {
  return new Date(now + 8 * 3600000).toISOString().slice(0, 10);
}

function beijingStamp(now = Date.now()) {
  const d = new Date(now + 8 * 3600000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')} `
    + `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

function isValidImageFile(filePath) {
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile() || st.size <= 1024) return false;
    const fd = fs.openSync(filePath, 'r');
    try {
      const head = Buffer.alloc(4);
      const n = fs.readSync(fd, head, 0, 4, 0);
      return n >= 2 && ((head[0] === 0xff && head[1] === 0xd8) || head[0] === 0x89 || (head[0] === 0x52 && head[1] === 0x49));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

export function readRankCache(dataRoot, kind) {
  const { jsonPath, imagePath } = rankFiles(dataRoot, kind);
  try {
    if (!isValidImageFile(imagePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.payload?.items) || !parsed.payload.items.length) return null;
    return { ...parsed, imagePath, jsonPath };
  } catch {
    return null;
  }
}

export function isRankCacheFresh(cache, { ttlMinutes = 60, now = Date.now() } = {}) {
  if (!cache || !Number.isFinite(Number(cache.fetchedAt))) return false;
  if (String(cache.dateKey || '') !== beijingDateKey(now)) return false;
  const ttlMs = Math.max(1, Number(ttlMinutes) || 60) * 60000;
  return now - Number(cache.fetchedAt) < ttlMs;
}

function atomicWriteJson(targetPath, data) {
  const tmp = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, targetPath);
}

async function mapWithLimit(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * 构建榜单管理器：负责抓取、繁简翻译、官方封面拉取与本地原子缓存替换。
 */
export function createRankService(deps = {}) {
  const inFlight = new Map();
  const simplify = (x) => (typeof deps.toSimplified === 'function' ? deps.toSimplified(x) : String(x ?? ''));
  const sanitizeTitle = (x) => (typeof deps.cleanTitle === 'function' ? deps.cleanTitle(x) : String(x ?? ''));
  const clockNow = () => (typeof deps.now === 'function' ? deps.now() : Date.now());

  async function refreshAndStore(kind, { topN }) {
    const k = normalizeRankKind(kind);
    const meta = RANK_META[k];
    const dataRoot = deps.getDataRoot();
    const settings = deps.getSettings();
    const { dir, jsonPath, imagePath } = rankFiles(dataRoot, k);
    await fs.promises.mkdir(dir, { recursive: true });

    const client = deps.createClient();
    let raw;
    try {
      raw = await client.rankAlbums(k, 1);
    } finally {
      try { await client.close?.(); } catch { /* ignore */ }
    }

    const picked = (raw?.items || []).slice(0, topN);
    if (!picked.length) throw new Error(`${meta.label}返回为空`);

    const items = picked.map((row, index) => {
      const cat = [row.category, row.categorySub].map((s) => simplify(String(s || '').trim())).filter(Boolean);
      const kindLabel = cat[0] === cat[1] ? (cat[0] || '') : cat.join('/');
      const authors = String(row.author || '')
        .split(/\s+/)
        .map((s) => simplify(s.trim()))
        .filter((s) => s && s !== 'N/A');
      const simplifiedTitle = simplify(row.name || `JM${row.id}`);
      return {
        rank: index + 1,
        id: String(row.id),
        rawTitle: simplifiedTitle,
        title: sanitizeTitle(simplifiedTitle) || simplifiedTitle,
        kind: kindLabel,
        tags: authors.slice(0, 3),
        cover: '',
        cover_scrambled: false,
        cover_scramble_id: 0,
      };
    });

    if (typeof deps.translateTitles === 'function') {
      try {
        await deps.translateTitles(items.map((it) => ({
          title: it.rawTitle,
          apply: (translated) => {
            const zh = simplify(String(translated || '').trim());
            if (zh) it.title = sanitizeTitle(zh) || zh;
          },
        })));
      } catch { /* 标题翻译失败不影响榜单出图 */ }
    }

    await mapWithLimit(items, 6, async (it) => {
      try {
        it.cover = await deps.fetchSiteCover(it.id, settings);
      } catch {
        it.cover = '';
      }
    });

    const fetchedAt = clockNow();
    const dateKey = beijingDateKey(fetchedAt);
    const stamp = beijingStamp(fetchedAt);
    const payload = {
      title: `${meta.title}（Top ${items.length}）`,
      subtitle: `${stamp} 更新 · 发送编号（如 jm${items[0].id}）即可下载`,
      footnote: `${meta.label} · 前 ${items.length} 本 · 本地缓存于 ${stamp}`,
      items: items.map(({ rawTitle: _rawTitle, ...rest }) => rest),
    };

    const tmpImg = path.join(dir, `rank-${k}.${process.pid}.${fetchedAt}.tmp.jpg`);
    try {
      await deps.renderDigestImage({
        payload,
        outPath: tmpImg,
        settings,
        pythonPath: settings.pythonPath,
      });
      if (!isValidImageFile(tmpImg)) throw new Error('榜单图片生成结果无效');
      fs.renameSync(tmpImg, imagePath);
    } catch (error) {
      try { fs.rmSync(tmpImg, { force: true }); } catch { /* ignore */ }
      throw error;
    }

    const record = {
      kind: k,
      label: meta.label,
      dateKey,
      fetchedAt,
      fetchedAtText: stamp,
      requestedTopN: topN,
      topN: items.length,
      payload,
    };
    atomicWriteJson(jsonPath, record);
    deps.log?.(`[jm-rank] ${meta.label}已刷新并原子落盘（${items.length} 本）`);
    return {
      ...record,
      imagePath,
      jsonPath,
      fromCache: false,
      stale: false,
    };
  }

  async function getRank(kind = 'daily', { force = false, topN, ttlMinutes } = {}) {
    const k = normalizeRankKind(kind);
    const settings = deps.getSettings();
    const limit = Math.min(60, Math.max(4, Number(topN ?? settings.rankTopN) || 48));
    const ttl = Math.max(5, Math.min(1440, Number(ttlMinutes ?? settings.rankCacheTtlMinutes) || 60));
    const dataRoot = deps.getDataRoot();
    const existing = readRankCache(dataRoot, k);

    const cachedLimit = Number(existing?.requestedTopN ?? existing?.topN ?? 0);
    if (!force && existing && cachedLimit === limit && isRankCacheFresh(existing, { ttlMinutes: ttl, now: clockNow() })) {
      return {
        ...existing,
        fromCache: true,
        stale: false,
      };
    }

    const inflightKey = `${k}:${limit}`;
    let pending = inFlight.get(inflightKey);
    if (!pending) {
      pending = refreshAndStore(k, { topN: limit }).finally(() => inFlight.delete(inflightKey));
      inFlight.set(inflightKey, pending);
    }

    try {
      return await pending;
    } catch (error) {
      if (existing) {
        deps.warn?.(`[jm-rank] 刷新 ${RANK_META[k].label} 失败，沿用旧缓存（${existing.fetchedAtText || '历史'}）：${error?.message ?? error}`);
        return {
          ...existing,
          fromCache: true,
          stale: true,
          refreshError: error?.message ?? String(error),
        };
      }
      throw error;
    }
  }

  return {
    getRank,
    readCache: (kind) => readRankCache(deps.getDataRoot(), kind),
  };
}
