import sharp from 'sharp';
import { boundedBody, cleanTitle, publicLink } from '../image-search/common.js';
import { imageType } from '../../core/image-type.js';
import { getOverseasFetch, matchesWorkTitle, normalizeTitleForMatch } from './sources.js';

const MAX_COVER_BYTES = 4 * 1024 * 1024;
const MAX_NORMALIZED_COVER_BYTES = 320 * 1024;

const SITE_DISPLAY_NAMES = Object.freeze({
  'vikacg.com': '维卡ACG',
  'acggw.me': 'ACG港湾',
  'workupload.com': 'Workupload 网盘',
  'f95zone.to': 'F95zone',
  'ryuugames.com': 'RyuuGames',
  'xsharing.org': 'XSharing',
  'v2dao.com': 'V2Dao',
  'anime-sharing.com': 'Anime-Sharing',
  'south-plus.net': '南+ (South Plus)',
  'kungal.com': '鲲 Galgame',
  'shionlib.com': '书音的图书馆',
  'shinnku.com': '真红小站',
  'dlsite.com': 'DLsite'
});

const WEB_DOMAIN_RE = /\b([a-z][a-z0-9-]*(?:\.[a-z0-9-]+)*)\.(com|net|org|me|to|cc|tv|jp|cn|ink|moe|io|xyz|vip|top|club|site|info|link|pw|gg|ru|co|la|sh|cx|sx|ai|app|dev|pro|icu|fun|work|online|store|blog|wiki|tw|hk|uk|de|fr|eu|us|ca|kr|im|ly|gl|st|ac)\b/gi;
const SENSITIVE_TERMS_RE = /(妓院|游女|步兵|无修正|无码|色情|黄油|18禁|R18|工口|肉番|同人本|调教|强奸|催眠|性爱|做爱|口交|乳交|肉便器|H游戏)/gi;

export function defangUrlForGroup(rawUrl) {
  const s = String(rawUrl || '').trim();
  if (!s) return '';
  try {
    const parsed = new URL(s);
    const host = parsed.hostname.replace(/^www\./i, '').replace(/\./g, '[.]');
    const port = parsed.port ? `:${parsed.port}` : '';
    const pathPart = `${parsed.pathname || ''}${parsed.search || ''}${parsed.hash || ''}`.replace(/^\/$/, '');
    return `${host}${port}${pathPart}`;
  } catch {
    return s.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(WEB_DOMAIN_RE, '$1[.]$2');
  }
}

export function sanitizeGroupText(text, { stripUrls = false, softenSensitive = false } = {}) {
  let out = String(text || '');
  if (!out) return '';
  if (stripUrls) {
    out = out.replace(/https?:\/\/[^\s)）\]】]+/gi, '');
  } else {
    out = out.replace(/https?:\/\/[^\s)）\]】]+/gi, (match) => defangUrlForGroup(match));
  }
  out = out.replace(WEB_DOMAIN_RE, '$1[.]$2');
  if (softenSensitive) {
    out = out.replace(SENSITIVE_TERMS_RE, (m) => (m.length >= 2 ? `${m.slice(0, 1)}·${m.slice(1)}` : m));
  }
  return out.replace(/\s{2,}/g, ' ').trim();
}

function friendlySiteName(rawName, safeGroup = false) {
  const clean = cleanTitle(rawName, 60);
  const key = clean.toLowerCase().replace(/^www\./, '');
  if (SITE_DISPLAY_NAMES[key]) return SITE_DISPLAY_NAMES[key];
  return safeGroup ? sanitizeGroupText(clean) : clean;
}

async function normalizeCoverImage(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_COVER_BYTES) return null;
  try {
    const jpeg = await sharp(buffer, { limitInputPixels: 24_000_000 })
      .rotate()
      .resize({ width: 512, height: 768, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .toColourspace('srgb')
      .jpeg({ quality: 80, progressive: false })
      .toBuffer();
    return jpeg.length <= MAX_NORMALIZED_COVER_BYTES ? jpeg : null;
  } catch {
    return null;
  }
}

function normalizeCodeLabel(raw) {
  const s = cleanTitle(raw, 40);
  if (!s) return '';
  if (/^(?:vndb:)?v\d+$/i.test(s)) return `VNDB:${s.replace(/^vndb:/i, '').toLowerCase()}`;
  if (/^[rvb]j\d{6,8}$/i.test(s)) return s.toUpperCase();
  if (/^(?:bgm|bangumi:)\d+$/i.test(s)) return `Bangumi:${s.replace(/^(?:bgm|bangumi:)/i, '')}`;
  if (/^steam:\d+$/i.test(s)) return `Steam:${s.replace(/^steam:/i, '')}`;
  return s;
}

function deduplicateDevelopers(list) {
  const raw = list.map((d) => cleanTitle(d, 60)).filter(Boolean);
  const nonTranslation = raw.filter((d) => !/汉化组|翻译组/.test(d));
  const pool = nonTranslation.length ? nonTranslation : raw;
  const out = [];
  const seenBase = new Set();
  for (const item of pool) {
    const base = normalizeTitleForMatch(item.replace(/\([^)]*\)|（[^）]*）/g, ''));
    const full = normalizeTitleForMatch(item);
    if (!full) continue;
    if (base && seenBase.has(base)) continue;
    if (base) seenBase.add(base);
    seenBase.add(full);
    out.push(item);
  }
  return out.slice(0, 4);
}

function resolveWorkProfile(agentResult, query) {
  const parsedWork = agentResult?.parsed?.work || {};
  const items = Array.isArray(agentResult?.crawledItems) ? agentResult.crawledItems : [];
  const shion = items.find((i) => i.source === 'shionlib');
  const kungal = items.find((i) => i.source === 'kungal');
  const vndb = items.find((i) => i.source === 'vndb');
  const bangumi = items.find((i) => i.source === 'bangumi');
  const dlsite = items.find((i) => i.source === 'dlsite');
  const touchgal = items.find((i) => i.source === 'touchgal');
  const steam = items.find((i) => i.source === 'steam');
  const animeWorks = agentResult?.imageClues?.animetrace?.works || [];
  const animeChars = agentResult?.imageClues?.animetrace?.characters || [];

  const titleZh = cleanTitle(
    parsedWork.titleZh || shion?.titleZh || kungal?.titleZh || bangumi?.titleZh || touchgal?.title || animeWorks[0] || query,
    120
  );
  const titleJp = cleanTitle(
    parsedWork.titleJp || shion?.titleJp || kungal?.titleJp || vndb?.titleJp || bangumi?.titleJp || dlsite?.title,
    120
  );
  const titleEn = cleanTitle(
    parsedWork.titleEn || shion?.titleEn || kungal?.titleEn || vndb?.titleRomaji || steam?.title,
    120
  );

  const codeSet = new Set();
  for (const c of Array.isArray(parsedWork.codes) ? parsedWork.codes : []) {
    const norm = normalizeCodeLabel(c);
    if (norm) codeSet.add(norm);
  }
  if (vndb?.id) codeSet.add(normalizeCodeLabel(`VNDB:${vndb.id}`));
  if (dlsite?.id) codeSet.add(normalizeCodeLabel(dlsite.id));
  for (const rj of Array.isArray(kungal?.dlsiteCodes) ? kungal.dlsiteCodes : []) {
    codeSet.add(normalizeCodeLabel(rj));
  }
  if (steam?.id) codeSet.add(normalizeCodeLabel(`Steam:${steam.id}`));
  if (bangumi?.id) codeSet.add(normalizeCodeLabel(bangumi.id));

  const devCandidates = [
    ...(Array.isArray(parsedWork.developers) ? parsedWork.developers : []),
    ...(kungal?.developers || []),
    ...(vndb?.developers || []),
    ...(dlsite?.developers || []),
    ...(shion?.developers || [])
  ];
  const developers = deduplicateDevelopers(devCandidates);

  const tagSet = new Set();
  for (const t of [
    ...(Array.isArray(parsedWork.tags) ? parsedWork.tags : []),
    ...(kungal?.tags || []),
    ...(shion?.tags || [])
  ]) {
    const clean = cleanTitle(t, 40);
    if (clean) tagSet.add(clean);
  }

  const coverCandidates = [...new Set([
    shion?.cover,
    kungal?.cover,
    bangumi?.cover,
    vndb?.cover,
    parsedWork.cover,
    dlsite?.cover,
    touchgal?.cover,
    steam?.cover
  ].map(publicLink).filter(Boolean))];

  const coverKeys = {};
  for (const item of items) {
    const cUrl = publicLink(item?.cover);
    if (cUrl && item?.coverKey) coverKeys[cUrl] = String(item.coverKey);
  }

  const summary = cleanTitle(
    parsedWork.summary
      || kungal?.description
      || vndb?.description
      || dlsite?.description
      || (!agentResult?.parsed && agentResult?.rawSummary ? agentResult.rawSummary : ''),
    260
  );

  return {
    titleZh: titleZh || titleJp || titleEn || '未确认作品名',
    titleJp,
    titleEn,
    codes: [...codeSet].slice(0, 5),
    developers,
    tags: [...tagSet].slice(0, 8),
    characters: animeChars.slice(0, 3),
    cover: coverCandidates[0] || '',
    coverCandidates,
    coverKeys,
    summary
  };
}

function collectResourceLists(agentResult, work, query, maxResults = 5) {
  const items = Array.isArray(agentResult?.crawledItems) ? agentResult.crawledItems : [];
  const parsedFree = Array.isArray(agentResult?.parsed?.freeResources) ? agentResult.parsed.freeResources : [];
  const parsedOfficial = Array.isArray(agentResult?.parsed?.officialResources) ? agentResult.parsed.officialResources : [];

  const jpShort = String(work.titleJp || '').split(/[～~－—]/)[0].trim();
  const zhShort = String(work.titleZh || '').split(/[～~－—]/)[0].trim();
  const rawCodes = work.codes.map((c) => c.replace(/^(?:VNDB|Bangumi|Steam):/i, ''));
  const targetTitles = [work.titleZh, work.titleJp, work.titleEn, jpShort, zhShort, ...rawCodes, query]
    .filter((t) => t && t !== '未确认作品名');

  const isItemRelevant = (item) => {
    if (!targetTitles.length) return true;
    const itemTitles = [
      item?.title,
      item?.titleZh,
      item?.titleJp,
      item?.titleEn,
      item?.snippet,
      item?.id,
      ...(Array.isArray(item?.aliases) ? item.aliases : [])
    ].filter(Boolean);
    return matchesWorkTitle(targetTitles, itemTitles);
  };

  const freeList = [];
  const seenFreeUrls = new Set();

  // 1. 优先放有实际免费资源的站点（书音的图书馆、鲲 Galgame 带资源帖、真红小站、TouchGal）
  const freeSources = ['touchgal', 'shionlib', 'kungal', 'shinnku'];
  for (const item of items) {
    if (!freeSources.includes(item.source)) continue;
    // 鲲 Galgame 若该作品下暂未上传网盘资源（kind === 'database'），归入下方数据库参考，不占免费下载位
    if (item.source === 'kungal' && item.kind === 'database') continue;
    if (!isItemRelevant(item)) continue;
    const url = publicLink(item.url);
    if (!url || seenFreeUrls.has(url)) continue;
    seenFreeUrls.add(url);
    freeList.push({
      siteName: item.siteName || item.source,
      title: cleanTitle(item.title, 120),
      url,
      note: cleanTitle(item.note, 180),
      downloads: Array.isArray(item.downloads) ? item.downloads : []
    });
  }

  // 2. 合并 DeepSeek 筛选出的免费资源渠道
  for (const row of parsedFree) {
    const url = publicLink(row?.url);
    if (!url || seenFreeUrls.has(url)) continue;
    if (/dlsite\.com|store\.steampowered\.com|vndb\.org|bgm\.tv/i.test(url)) continue;
    seenFreeUrls.add(url);
    freeList.push({
      siteName: cleanTitle(row?.siteName || '免费资源站', 60),
      title: cleanTitle(row?.title || '资源页面', 120),
      url,
      note: cleanTitle(row?.note, 180),
      downloads: []
    });
  }

  // 3. 若免费列表不足，把全网搜索命中的相关免费资源页按“含下载/汉化/解压密码/资源站特征”优先级排序补入
  const webResourceScore = (item) => {
    const text = `${item.title || ''} ${item.snippet || ''} ${item.url || ''}`;
    let score = 0;
    if (/解压密码|提取码|网盘|百度盘|夸克|workupload|mega\.nz|gofile/i.test(text)) score += 50;
    if (/vikacg|acggw|xsharing|v2dao|ryuugames|f95zone|anime-sharing/i.test(item.url || '')) score += 40;
    if (/汉化|官中|硬盘版|直装|\b(?:rar|7z|zip)\b|download|下载/i.test(text)) score += 25;
    if (/攻略|感想|レビュー|review|matome/i.test(text)) score -= 20;
    return score;
  };
  const webCandidates = items
    .filter((item) => item.source === 'web')
    .sort((a, b) => webResourceScore(b) - webResourceScore(a));

  for (const item of webCandidates) {
    if (freeList.length >= maxResults) break;
    const url = publicLink(item.url);
    if (!url || seenFreeUrls.has(url)) continue;
    if (/dlsite\.com|store\.steampowered\.com|vndb\.org|bgm\.tv|nicovideo\.jp|x\.com|twitter\.com/i.test(url)) continue;
    if (!isItemRelevant(item)) continue;
    seenFreeUrls.add(url);
    freeList.push({
      siteName: cleanTitle(item.siteName || '网页资源', 60),
      title: cleanTitle(item.title, 120),
      url,
      note: cleanTitle(item.snippet, 180),
      downloads: []
    });
  }

  // 4. 正版与权威数据库参考（DLsite / Steam / VNDB / Bangumi / 鲲 Galgame 档案）
  const officialList = [];
  const seenOfficialUrls = new Set();
  for (const item of items) {
    const isKunGalDb = item.source === 'kungal' && item.kind === 'database';
    if (!['dlsite', 'steam', 'vndb', 'bangumi'].includes(item.source) && !isKunGalDb) continue;
    if (!isItemRelevant(item)) continue;
    const url = publicLink(item.url);
    if (!url || seenOfficialUrls.has(url)) continue;
    seenOfficialUrls.add(url);
    const extra = [
      item.id ? `编号：${item.id}` : '',
      item.rating ? `评分：${item.rating}` : '',
      item.released ? `发售：${item.released}` : ''
    ].filter(Boolean).join(' · ');
    officialList.push({
      siteName: item.siteName || item.source.toUpperCase(),
      title: cleanTitle(item.title, 120),
      url,
      note: extra || '正版/权威数据库档案'
    });
  }
  for (const row of parsedOfficial) {
    const url = publicLink(row?.url);
    if (!url || seenOfficialUrls.has(url)) continue;
    seenOfficialUrls.add(url);
    officialList.push({
      siteName: cleanTitle(row?.siteName || '正版平台', 60),
      title: cleanTitle(row?.title || '作品主页', 120),
      url,
      note: cleanTitle(row?.note, 140)
    });
  }

  return {
    freeResources: freeList.slice(0, maxResults),
    officialResources: officialList.slice(0, Math.max(4, maxResults))
  };
}

function formatWorkHeader(work, safeGroup = false) {
  const lines = ['🎮 作品识别与档案'];
  lines.push(`名称：${work.titleZh}`);
  if (work.titleJp && work.titleJp !== work.titleZh) lines.push(`原名：${work.titleJp}`);
  if (work.titleEn && work.titleEn !== work.titleZh && work.titleEn !== work.titleJp) lines.push(`外文/罗马音：${work.titleEn}`);
  if (work.characters.length) {
    lines.push(`识别角色：${work.characters.map((c) => `${c.character}（${c.work}）`).join('、')}`);
  }
  if (work.developers.length) lines.push(`社团/厂商：${work.developers.join('、')}`);
  if (work.codes.length) lines.push(`识别编号：${work.codes.join(' · ')}`);
  if (work.tags.length) lines.push(`标签：${work.tags.join(' / ')}`);
  if (work.summary) {
    const summaryText = safeGroup
      ? sanitizeGroupText(work.summary, { stripUrls: true, softenSensitive: true })
      : work.summary;
    if (summaryText) lines.push(`简介与结论：${summaryText}`);
  }
  return lines.join('\n');
}

function formatLinkValue(url, safeGroup) {
  return safeGroup ? defangUrlForGroup(url) : url;
}

function formatFreeResourcesList(freeResources, safeGroup = false) {
  const lines = [`📦 免费资源渠道（共 ${freeResources.length} 条）`];
  for (const [idx, item] of freeResources.entries()) {
    const site = friendlySiteName(item.siteName, safeGroup);
    const title = safeGroup
      ? sanitizeGroupText(item.title, { stripUrls: true, softenSensitive: true })
      : item.title;
    lines.push(`${idx + 1}. [${site}] ${title}`);
    if (item.note) {
      const note = safeGroup
        ? sanitizeGroupText(item.note, { stripUrls: true, softenSensitive: true }).slice(0, 90).replace(/\[[^\]]*$/, '').trim()
        : item.note;
      if (note) lines.push(`   说明：${note}`);
    }
    lines.push(`   地址：${formatLinkValue(item.url, safeGroup)}`);
    if (Array.isArray(item.downloads) && item.downloads.length) {
      for (const dl of item.downloads.slice(0, 4)) {
        const dlName = safeGroup ? sanitizeGroupText(dl.name, { stripUrls: true, softenSensitive: true }) : dl.name;
        lines.push(`   • ${dlName}`);
        if (dl.url && dl.url !== item.url) {
          lines.push(`     直达：${formatLinkValue(dl.url, safeGroup)}`);
        }
        const meta = [
          dl.code ? `提取码：${dl.code}` : '',
          dl.password ? `解压密码：${dl.password}` : '',
          dl.note ? (safeGroup ? sanitizeGroupText(dl.note, { stripUrls: true }) : dl.note) : ''
        ].filter(Boolean).join(' | ');
        if (meta) lines.push(`     (${meta})`);
      }
    }
  }
  if (safeGroup) {
    lines.push('💡 群聊已对网址做防风控断链，复制后去掉 [ ] 即可浏览器打开；私聊可直出完整链接。');
  }
  return lines.join('\n');
}

function formatOfficialListBlock(officialResources, safeGroup = false) {
  const lines = ['🛒 正版与权威数据库参考'];
  for (const [idx, item] of officialResources.entries()) {
    const site = friendlySiteName(item.siteName, safeGroup);
    const title = safeGroup
      ? sanitizeGroupText(item.title, { stripUrls: true, softenSensitive: true })
      : item.title;
    lines.push(`${idx + 1}. [${site}] ${title}`);
    if (item.note) {
      const note = safeGroup ? sanitizeGroupText(item.note, { stripUrls: true }) : item.note;
      if (note) lines.push(`   ${note}`);
    }
    lines.push(`   ${formatLinkValue(item.url, safeGroup)}`);
  }
  return lines.join('\n');
}

export function formatResourceSearchReply(agentResult, settings = {}, query = '', options = {}) {
  const maxResults = Number(settings.maxResults) || 5;
  const safeGroup = options.chatKind === 'group' && settings.safeGroupLinks !== false;
  const work = resolveWorkProfile(agentResult, query);
  const { freeResources, officialResources } = collectResourceLists(agentResult, work, query, maxResults);
  const blocks = [formatWorkHeader(work, safeGroup)];

  if (freeResources.length) {
    blocks.push(formatFreeResourcesList(freeResources, safeGroup));
  } else {
    blocks.push('📦 免费资源渠道\n本次在已启用站点中暂未检出可直接确认的免费下载页，可参考下方正版/数据库原名或编号进一步搜索。');
  }

  if (officialResources.length) {
    blocks.push(formatOfficialListBlock(officialResources, safeGroup));
  }
  return blocks.join('\n\n');
}

export async function buildResourceSearchNodes(agentResult, settings = {}, options = {}) {
  const maxResults = Number(settings.maxResults) || 5;
  const query = options.query || '';
  const safeGroup = options.chatKind === 'group' && settings.safeGroupLinks !== false;
  const work = resolveWorkProfile(agentResult, query);
  const { freeResources, officialResources } = collectResourceLists(agentResult, work, query, maxResults);
  if (!freeResources.length && !officialResources.length && !work.summary && !work.characters.length) {
    return null;
  }

  const node = (content) => ({
    type: 'node',
    data: {
      uin: String(options.selfId || ''),
      name: String(options.name || '资源检索助手').slice(0, 40),
      content
    }
  });
  const text = (value) => ({ type: 'text', data: { text: value } });

  const headerContent = [text(formatWorkHeader(work, safeGroup))];
  if (settings.includeImages !== false && work.coverCandidates?.length && !options.signal?.aborted) {
    const fetchFn = getOverseasFetch(settings, options);
    const relay = options.imageSearchSettings;
    const relayUrl = typeof relay?.relayUrl === 'string' ? relay.relayUrl.trim().replace(/\/+$/, '') : '';
    const relayToken = typeof relay?.relayToken === 'string' ? relay.relayToken.trim() : '';
    const relayFetch = options.fetchImpl || globalThis.fetch;

    const attachNormalized = async (rawBuf) => {
      if (!imageType(rawBuf)) return false;
      const jpeg = await normalizeCoverImage(rawBuf);
      if (!jpeg) return false;
      headerContent.push(text('\n作品封面预览：'));
      headerContent.push({
        type: 'image',
        data: { file: `base64://${jpeg.toString('base64')}` }
      });
      return true;
    };

    for (const candidateUrl of work.coverCandidates.slice(0, 3)) {
      if (options.signal?.aborted) break;
      const imgSignal = AbortSignal.any([
        ...(options.signal ? [options.signal] : []),
        AbortSignal.timeout(10000)
      ]);
      let attached = false;
      const coverKey = work.coverKeys?.[candidateUrl];
      if (coverKey && relayUrl && relayToken) {
        try {
          const rRes = await relayFetch(`${relayUrl}/v1/image`, {
            method: 'POST',
            signal: imgSignal,
            headers: {
              authorization: `Bearer ${relayToken}`,
              'content-type': 'application/json',
              'x-image-max-bytes': String(MAX_COVER_BYTES)
            },
            body: JSON.stringify({ key: coverKey })
          });
          if (rRes.ok) {
            const buffer = await boundedBody(rRes, MAX_COVER_BYTES, imgSignal);
            attached = await attachNormalized(buffer);
          } else {
            await rRes.body?.cancel().catch(() => {});
          }
        } catch {
          options.signal?.throwIfAborted();
        }
      }
      if (attached) break;
      try {
        const res = await fetchFn(candidateUrl, {
          signal: imgSignal,
          headers: { 'user-agent': 'Mozilla/5.0' }
        });
        if (res.ok) {
          const buffer = await boundedBody(res, MAX_COVER_BYTES, imgSignal);
          if (await attachNormalized(buffer)) break;
        } else {
          await res.body?.cancel().catch(() => {});
        }
      } catch {
        options.signal?.throwIfAborted();
      }
    }
  }

  const nodes = [node(headerContent)];

  if (freeResources.length) {
    nodes.push(node([text(formatFreeResourcesList(freeResources, safeGroup))]));
  } else {
    nodes.push(node([text('📦 免费资源渠道\n本次在已启用站点中暂未检出可直接确认的免费下载页，建议复制上方日文原名或 RJ/VNDB 编号检索。')]));
  }

  if (officialResources.length) {
    nodes.push(node([text(formatOfficialListBlock(officialResources, safeGroup))]));
  }

  return nodes;
}
