import { parse } from 'node-html-parser';
import { boundedBody, cleanTitle, publicLink } from '../image-search/common.js';
import { webSearch } from '../../llm/web-search.js';

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';
const MAX_JSON_BYTES = 2 * 1024 * 1024;

export const SOURCE_LABELS = Object.freeze({
  shionlib: '书音的图书馆',
  touchgal: 'TouchGal 资源站',
  vndb: 'VNDB 数据库',
  dlsite: 'DLsite 同人库',
  steam: 'Steam 商店',
  animetrace: 'AnimeTrace 识图',
  web: '全网搜索'
});

function stripBbCodeAndHtml(raw, max = 260) {
  return String(raw || '')
    .replace(/\[url=[^\]]*\]([\s\S]*?)\[\/url\]/gi, '$1')
    .replace(/\[spoiler\][\s\S]*?\[\/spoiler\]/gi, '')
    .replace(/\[\/?[a-z0-9=_"-]+\]/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

async function fetchJson(url, init, signal, fetchImpl = globalThis.fetch) {
  const timeoutSignal = AbortSignal.any([
    ...(signal ? [signal] : []),
    AbortSignal.timeout(12000)
  ]);
  const res = await fetchImpl(url, {
    ...init,
    signal: timeoutSignal,
    headers: {
      'user-agent': BROWSER_UA,
      accept: 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9,ja;q=0.8,en;q=0.7',
      ...(init?.headers || {})
    }
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`HTTP ${res.status}`);
  }
  const buf = await boundedBody(res, MAX_JSON_BYTES, timeoutSignal);
  return JSON.parse(buf.toString('utf8'));
}

async function fetchText(url, init, signal, fetchImpl = globalThis.fetch) {
  const timeoutSignal = AbortSignal.any([
    ...(signal ? [signal] : []),
    AbortSignal.timeout(12000)
  ]);
  const res = await fetchImpl(url, {
    ...init,
    signal: timeoutSignal,
    headers: {
      'user-agent': BROWSER_UA,
      'accept-language': 'zh-CN,zh;q=0.9,ja;q=0.8,en;q=0.7',
      ...(init?.headers || {})
    }
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`HTTP ${res.status}`);
  }
  const buf = await boundedBody(res, MAX_JSON_BYTES, timeoutSignal);
  return buf.toString('utf8');
}

/**
 * 1. AnimeTrace Galgame / 动漫角色与作品识图（参考 astrbot_plugin_galgame_box & nonebot-plugin-anime-trace）
 */
export async function searchAnimeTrace(image, options = {}) {
  const fetchFn = options.fetchImpl || globalThis.fetch;
  const signal = options.signal;
  const models = options.models || ['full_game_model_kira', 'anime_model_lovelive'];
  const works = [];
  const characters = [];
  const seenWorks = new Set();
  const seenChars = new Set();

  for (const model of models) {
    try {
      const form = new FormData();
      form.set('model', model);
      form.set('is_multi', '1');
      form.set('ai_detect', '1');
      form.set('file', new Blob([image.buffer], { type: image.type || 'image/jpeg' }), 'screenshot.jpg');
      const data = await fetchJson('https://api.animetrace.com/v1/search', {
        method: 'POST',
        body: form
      }, signal, fetchFn);
      const boxes = Array.isArray(data?.data) ? data.data : [];
      for (const box of boxes) {
        const candidates = Array.isArray(box?.character) ? box.character : [];
        for (const item of candidates.slice(0, 4)) {
          const work = cleanTitle(item?.work, 100);
          const charName = cleanTitle(item?.character, 80);
          if (work && !seenWorks.has(work)) {
            seenWorks.add(work);
            works.push(work);
          }
          if (charName && work) {
            const pair = `${charName}（${work}）`;
            if (!seenChars.has(pair)) {
              seenChars.add(pair);
              characters.push({ character: charName, work, model });
            }
          }
        }
      }
      if (works.length) break;
    } catch {
      signal?.throwIfAborted();
    }
  }
  return {
    source: 'animetrace',
    status: works.length ? 'ok' : 'empty',
    works: works.slice(0, 6),
    characters: characters.slice(0, 6)
  };
}

/**
 * 2. 复用宿主已配置的东京搜图中转（SerpApi Google Lens / Yandex / trace.moe）提取图片线索
 */
export async function searchImageRelayClues(image, imageSearchSettings, options = {}) {
  const fetchFn = options.fetchImpl || globalThis.fetch;
  const signal = options.signal;
  const relayUrl = String(imageSearchSettings?.relayUrl || '').trim().replace(/\/$/, '');
  const relayToken = String(imageSearchSettings?.relayToken || '').trim();
  if (!relayUrl || !relayToken) {
    return { source: 'image-relay', status: 'skipped', results: [] };
  }
  const platforms = ['serpapi', 'yandex', 'trace'].filter((p) => imageSearchSettings?.platforms?.[p] !== false);
  const chosen = platforms.length ? platforms.slice(0, 2) : ['serpapi'];
  const results = [];
  for (const platform of chosen) {
    try {
      const timeoutSignal = AbortSignal.any([
        ...(signal ? [signal] : []),
        AbortSignal.timeout(25000)
      ]);
      const res = await fetchFn(`${relayUrl}/v1/search`, {
        method: 'POST',
        redirect: 'error',
        signal: timeoutSignal,
        headers: {
          authorization: `Bearer ${relayToken}`,
          'content-type': image.type || 'image/jpeg',
          'x-search-platform': platform,
          'x-search-limit': '5',
          'x-search-timeout': '20'
        },
        body: image.buffer
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        continue;
      }
      const report = JSON.parse((await boundedBody(res, 128 * 1024, timeoutSignal)).toString('utf8'));
      for (const row of (report?.results || []).slice(0, 5)) {
        const title = cleanTitle(row?.title, 140);
        const url = publicLink(row?.url);
        if (title || url) {
          results.push({
            platform,
            title,
            source: cleanTitle(row?.source, 80),
            url
          });
        }
      }
      if (results.length) break;
    } catch {
      signal?.throwIfAborted();
    }
  }
  return {
    source: 'image-relay',
    status: results.length ? 'ok' : 'empty',
    results: results.slice(0, 6)
  };
}

/**
 * 3. 书音的图书馆 shionlib.com 检索（参考 clown145/astrbot_plugin_GalQuery）
 */
function pickShionlibCover(covers, domain) {
  if (!Array.isArray(covers)) return '';
  const imageDomain = `t.${domain.replace(/^www\./i, '')}`;
  const normalizeUrl = (raw) => {
    const val = String(raw || '').trim();
    if (!val) return '';
    if (val.startsWith('//')) return publicLink(`https:${val}`);
    if (/^https?:\/\//i.test(val)) {
      return publicLink(val.replace(`https://${domain}/game/`, `https://${imageDomain}/game/`));
    }
    if (val.startsWith('/')) {
      const rel = val.replace(/^\/+/, '');
      return publicLink(rel.startsWith('game/') ? `https://${imageDomain}/${rel}` : `https://${domain}/${rel}`);
    }
    return '';
  };
  const byLang = {};
  let fallback = '';
  for (const item of covers) {
    if (!item || typeof item !== 'object') continue;
    if (item.type && item.type !== 'dig') continue;
    const url = normalizeUrl(item.url);
    if (!url) continue;
    if (!fallback) fallback = url;
    const lang = String(item.language || '').toLowerCase();
    if (lang && !byLang[lang]) byLang[lang] = url;
  }
  for (const key of ['zh', 'jp', 'ja', 'en', 'unknown']) {
    if (byLang[key]) return byLang[key];
  }
  return fallback;
}

export async function searchShionlib(keyword, settings = {}, options = {}) {
  const fetchFn = options.fetchImpl || globalThis.fetch;
  const signal = options.signal;
  const domain = String(settings.shionlibDomain || 'shionlib.com').trim();
  const url = `https://${domain}/api/search?q=${encodeURIComponent(keyword)}&page=1`;
  const payload = await fetchJson(url, {
    headers: {
      referer: `https://${domain}/zh/search/game`
    }
  }, signal, fetchFn);

  const items = Array.isArray(payload?.data?.games?.items) ? payload.data.games.items : [];
  const results = [];
  for (const item of items.slice(0, 5)) {
    if (!item || item.id == null) continue;
    const titleZh = cleanTitle(item.title_zh, 120);
    const titleJp = cleanTitle(item.title_jp, 120);
    const titleEn = cleanTitle(item.title_en, 120);
    const title = titleZh || titleJp || titleEn || `游戏 #${item.id}`;
    const developers = (Array.isArray(item.developers) ? item.developers : [])
      .map((d) => cleanTitle(d?.developer?.name || d?.name, 60))
      .filter(Boolean)
      .slice(0, 4);
    const tags = (Array.isArray(item.tags) ? item.tags : [])
      .map((t) => cleanTitle(t?.name, 40))
      .filter(Boolean)
      .slice(0, 8);
    const resourceCount = Number.isInteger(item?.resources?.count) ? item.resources.count : 0;
    results.push({
      source: 'shionlib',
      siteName: '书音的图书馆',
      kind: 'free',
      id: String(item.id),
      title,
      titleZh,
      titleJp,
      titleEn,
      developers,
      tags,
      resourceCount,
      cover: pickShionlibCover(item.covers, domain),
      url: `https://${domain}/zh/game/${item.id}`,
      note: resourceCount > 0 ? `站内收录 ${resourceCount} 个免费资源分流` : '站内游戏档案与资源页'
    });
  }
  return { source: 'shionlib', status: results.length ? 'ok' : 'empty', results };
}

/**
 * 4. TouchGal 一站式社区检索与直链获取（参考 clown145/astrbot_plugin_GalQuery & CCYellowStar2/astrbot_plugin_touchgal）
 */
function normalizeTouchGalResources(payload) {
  if (!Array.isArray(payload)) return [];
  const resources = [];
  for (const item of payload) {
    if (!item || typeof item !== 'object') continue;
    if (typeof item.content === 'string' && item.content.trim()) {
      resources.push({
        name: cleanTitle(item.name || '资源下载', 80),
        url: cleanTitle(item.content, 400),
        password: cleanTitle(item.password, 60),
        code: cleanTitle(item.code, 60),
        note: cleanTitle(item.note, 120)
      });
      continue;
    }
    const baseName = cleanTitle(item.name || '资源下载', 80);
    const note = cleanTitle(item.note, 120);
    const links = Array.isArray(item.links) ? item.links : [];
    for (const link of links) {
      const content = cleanTitle(link?.content, 400);
      if (!content) continue;
      const size = cleanTitle(link?.size, 30);
      resources.push({
        name: size ? `${baseName} [${size}]` : baseName,
        url: content,
        password: cleanTitle(link?.password, 60),
        code: cleanTitle(link?.code, 60),
        note
      });
    }
  }
  return resources.slice(0, 6);
}

export async function searchTouchGal(keyword, settings = {}, options = {}) {
  const fetchFn = options.fetchImpl || globalThis.fetch;
  const signal = options.signal;
  const domain = String(settings.touchgalDomain || 'www.touchgal.ink').trim();
  const token = String(settings.touchgalToken || '').trim();
  const cookieParts = ['kun-patch-setting-store|state|data|kunNsfwEnable=all'];
  if (token) cookieParts.push(`kun-galgame-patch-moe-token=${token}`);
  const headers = {
    'content-type': 'application/json',
    origin: `https://${domain}`,
    referer: `https://${domain}/search`,
    'x-requested-with': 'kun-fetch',
    cookie: cookieParts.join('; ')
  };
  const body = JSON.stringify({
    queryString: JSON.stringify([{ type: 'keyword', mode: 'include', name: keyword }]),
    limit: 4,
    page: 1,
    searchOption: {
      searchInIntroduction: false,
      searchInAlias: true,
      searchInTag: false
    },
    selectedType: 'all',
    selectedLanguage: 'all',
    selectedPlatform: 'all',
    sortField: 'resource_update_time',
    sortOrder: 'desc',
    selectedYears: ['all'],
    selectedMonths: ['all'],
    minRatingCount: 0
  });

  const data = await fetchJson(`https://${domain}/api/search`, {
    method: 'POST',
    headers,
    body
  }, signal, fetchFn);

  const games = Array.isArray(data?.galgames) ? data.galgames.slice(0, 3) : [];
  const results = await Promise.all(games.map(async (game) => {
    const patchId = game?.id;
    const uniqueId = game?.uniqueId || game?.unique_id || patchId;
    const title = cleanTitle(game?.name || game?.cnName || game?.jpName || `TouchGal #${patchId}`, 120);
    let downloads = [];
    if (patchId && uniqueId) {
      try {
        const resPayload = await fetchJson(`https://${domain}/api/patch/resource?patchId=${encodeURIComponent(patchId)}`, {
          headers: {
            ...headers,
            referer: `https://${domain}/${uniqueId}`
          }
        }, signal, fetchFn);
        downloads = normalizeTouchGalResources(resPayload);
      } catch {
        signal?.throwIfAborted();
      }
    }
    const banner = publicLink(game?.banner);
    return {
      source: 'touchgal',
      siteName: 'TouchGal 资源站',
      kind: 'free',
      id: String(patchId || uniqueId || ''),
      title,
      cover: banner,
      url: uniqueId ? `https://${domain}/${uniqueId}` : `https://${domain}`,
      downloads,
      note: downloads.length ? `获取到 ${downloads.length} 条直链/网盘资源` : 'TouchGal 游戏资源详情页'
    };
  }));

  return { source: 'touchgal', status: results.length ? 'ok' : 'empty', results };
}

/**
 * 5. VNDB Kana API 权威作品与别名检索（参考 PyuraMazo/astrbot_plugin_galgame_box）
 */
export async function searchVndb(keyword, _settings = {}, options = {}) {
  const fetchFn = options.fetchImpl || globalThis.fetch;
  const signal = options.signal;
  const data = await fetchJson('https://api.vndb.org/kana/vn', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      filters: ['search', '=', keyword],
      fields: 'id,title,alttitle,aliases,released,rating,image.url,developers.name,description',
      results: 4
    })
  }, signal, fetchFn);

  const rows = Array.isArray(data?.results) ? data.results : [];
  const results = rows.map((row) => {
    const id = cleanTitle(row?.id, 20);
    const titleRomaji = cleanTitle(row?.title, 120);
    const titleJp = cleanTitle(row?.alttitle, 120);
    const aliases = (Array.isArray(row?.aliases) ? row.aliases : [])
      .map((a) => cleanTitle(a, 80))
      .filter(Boolean)
      .slice(0, 6);
    const developers = (Array.isArray(row?.developers) ? row.developers : [])
      .map((d) => cleanTitle(d?.name, 60))
      .filter(Boolean)
      .slice(0, 4);
    return {
      source: 'vndb',
      siteName: 'VNDB 视觉小说库',
      kind: 'database',
      id,
      title: titleJp || titleRomaji || id,
      titleJp,
      titleRomaji,
      aliases,
      released: cleanTitle(row?.released, 20),
      rating: Number.isFinite(row?.rating) ? Number((row.rating / 10).toFixed(2)) : null,
      developers,
      description: stripBbCodeAndHtml(row?.description, 240),
      cover: publicLink(row?.image?.url),
      url: id ? `https://vndb.org/${id}` : 'https://vndb.org'
    };
  });
  return { source: 'vndb', status: results.length ? 'ok' : 'empty', results };
}

/**
 * 6. DLsite 同人黄油检索（支持 RJ/VJ/BJ 号直查与关键词搜索）
 */
export async function searchDlsite(keyword, _settings = {}, options = {}) {
  const fetchFn = options.fetchImpl || globalThis.fetch;
  const signal = options.signal;
  const codeMatch = String(keyword || '').match(/\b([RVB]J\d{6,8})\b/i);
  const results = [];

  if (codeMatch) {
    const code = codeMatch[1].toUpperCase();
    try {
      const data = await fetchJson(`https://www.dlsite.com/maniax/api/=/product.json?workno=${encodeURIComponent(code)}&locale=zh_CN`, {
        headers: { cookie: 'adultchecked=1; locale=zh-cn' }
      }, signal, fetchFn);
      const item = Array.isArray(data) ? data[0] : null;
      if (item && (item.work_name || item.workno)) {
        const rawCover = item?.image_main?.url || item?.image_thum?.url || '';
        const cover = publicLink(rawCover.startsWith('//') ? `https:${rawCover}` : rawCover);
        results.push({
          source: 'dlsite',
          siteName: 'DLsite',
          kind: 'official',
          id: code,
          title: cleanTitle(item.work_name || code, 140),
          developers: item.maker_name ? [cleanTitle(item.maker_name, 60)] : [],
          description: stripBbCodeAndHtml(item.intro_s || item.intro || '', 200),
          cover,
          url: `https://www.dlsite.com/maniax/work/=/product_id/${code}.html`
        });
      }
    } catch {
      signal?.throwIfAborted();
    }
  }

  if (!results.length) {
    try {
      const searchUrl = `https://www.dlsite.com/maniax/fsr/=/language/jp/sex_category%5B0%5D/male/keyword/${encodeURIComponent(keyword)}/per_page/5/page/1`;
      const html = await fetchText(searchUrl, {
        headers: { cookie: 'adultchecked=1; locale=zh-cn' }
      }, signal, fetchFn);
      const root = parse(html);
      const cards = root.querySelectorAll('.search_result_img_box_inner, li.search_result_img_box_inner, tr');
      const seen = new Set();
      for (const card of cards) {
        const linkNode = card.querySelector('a[href*="product_id/"]');
        const href = linkNode?.getAttribute('href') || '';
        const m = href.match(/product_id\/([RVB]J\d{6,8})\.html/i);
        if (!m) continue;
        const code = m[1].toUpperCase();
        if (seen.has(code)) continue;
        seen.add(code);
        const titleNode = card.querySelector('.work_name a, a[title]');
        const title = cleanTitle(titleNode?.getAttribute('title') || titleNode?.text || linkNode?.getAttribute('title') || code, 140);
        const makerNode = card.querySelector('.maker_name a, .maker_name');
        const maker = cleanTitle(makerNode?.text || '', 60);
        const imgNode = card.querySelector('img');
        const rawImg = imgNode?.getAttribute('data-src') || imgNode?.getAttribute('src') || '';
        const cover = publicLink(rawImg.startsWith('//') ? `https:${rawImg}` : rawImg);
        results.push({
          source: 'dlsite',
          siteName: 'DLsite',
          kind: 'official',
          id: code,
          title: `${title} (${code})`,
          developers: maker ? [maker] : [],
          cover,
          url: `https://www.dlsite.com/maniax/work/=/product_id/${code}.html`
        });
        if (results.length >= 4) break;
      }
    } catch {
      signal?.throwIfAborted();
    }
  }
  return { source: 'dlsite', status: results.length ? 'ok' : 'empty', results };
}

/**
 * 7. Steam 商店接口检索
 */
export async function searchSteam(keyword, _settings = {}, options = {}) {
  const fetchFn = options.fetchImpl || globalThis.fetch;
  const signal = options.signal;
  const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(keyword)}&l=schinese&cc=CN`;
  const data = await fetchJson(url, {}, signal, fetchFn);
  const items = Array.isArray(data?.items) ? data.items.slice(0, 4) : [];
  const results = items.filter((item) => item?.id && item?.name).map((item) => ({
    source: 'steam',
    siteName: 'Steam',
    kind: 'official',
    id: String(item.id),
    title: cleanTitle(item.name, 120),
    cover: publicLink(item.tiny_image),
    url: `https://store.steampowered.com/app/${item.id}`
  }));
  return { source: 'steam', status: results.length ? 'ok' : 'empty', results };
}

/**
 * 8. 全网资源搜索（复用宿主配置的 webSearch）
 */
export async function searchWebResources(query, _settings = {}, options = {}) {
  const webSearchFn = options.webSearchImpl || webSearch;
  const data = await webSearchFn(query);
  const items = Array.isArray(data?.results) ? data.results.slice(0, 6) : [];
  const results = items
    .map((item) => ({
      source: 'web',
      siteName: (() => {
        try { return new URL(item.url).hostname.replace(/^www\./i, ''); } catch { return '网页结果'; }
      })(),
      kind: 'web',
      title: cleanTitle(item.title, 140),
      snippet: cleanTitle(item.snippet, 220),
      url: publicLink(item.url)
    }))
    .filter((item) => item.title && (item.url || item.snippet));
  return { source: 'web', status: results.length ? 'ok' : 'empty', results };
}

/**
 * 多站点并发爬取：一次调用同时搜多个已启用站点，避免单一站点漏搜或找错
 */
export async function crawlMultiSites(keyword, settings = {}, options = {}) {
  const clean = String(keyword || '').trim().slice(0, 120);
  if (!clean) return { keyword: '', reports: [], results: [] };
  const enabledSources = settings.sources || {};
  const requested = Array.isArray(options.sites) && options.sites.length
    ? options.sites.filter((s) => enabledSources[s] !== false)
    : ['shionlib', 'touchgal', 'vndb', 'dlsite', 'steam', 'web'].filter((s) => enabledSources[s] !== false);

  const runners = {
    shionlib: () => searchShionlib(clean, settings, options),
    touchgal: () => searchTouchGal(clean, settings, options),
    vndb: () => searchVndb(clean, settings, options),
    dlsite: () => searchDlsite(clean, settings, options),
    steam: () => searchSteam(clean, settings, options),
    web: () => searchWebResources(`${clean} 汉化 下载 资源`, settings, options)
  };

  const tasks = requested
    .filter((name) => typeof runners[name] === 'function')
    .map(async (name) => {
      try {
        const invoke = runners[name];
        return await invoke();
      } catch (error) {
        options.signal?.throwIfAborted();
        return { source: name, status: 'error', error: String(error?.message ?? error).slice(0, 120), results: [] };
      }
    });

  const reports = await Promise.all(tasks);
  const results = reports.flatMap((r) => Array.isArray(r.results) ? r.results : []);
  return { keyword: clean, reports, results };
}
