import { boundedBody, cleanTitle, publicLink } from '../image-search/common.js';
import { imageType } from '../../core/image-type.js';

const MAX_COVER_BYTES = 4 * 1024 * 1024;

function resolveWorkProfile(agentResult, query) {
  const parsedWork = agentResult?.parsed?.work || {};
  const items = Array.isArray(agentResult?.crawledItems) ? agentResult.crawledItems : [];
  const shion = items.find((i) => i.source === 'shionlib');
  const vndb = items.find((i) => i.source === 'vndb');
  const dlsite = items.find((i) => i.source === 'dlsite');
  const touchgal = items.find((i) => i.source === 'touchgal');
  const steam = items.find((i) => i.source === 'steam');
  const animeWorks = agentResult?.imageClues?.animetrace?.works || [];
  const animeChars = agentResult?.imageClues?.animetrace?.characters || [];

  const titleZh = cleanTitle(parsedWork.titleZh || shion?.titleZh || touchgal?.title || animeWorks[0] || query, 120);
  const titleJp = cleanTitle(parsedWork.titleJp || shion?.titleJp || vndb?.titleJp || dlsite?.title, 120);
  const titleEn = cleanTitle(parsedWork.titleEn || shion?.titleEn || vndb?.titleRomaji || steam?.title, 120);

  const codeSet = new Set();
  for (const c of Array.isArray(parsedWork.codes) ? parsedWork.codes : []) {
    const clean = cleanTitle(c, 30);
    if (clean) codeSet.add(clean);
  }
  if (vndb?.id) codeSet.add(`VNDB:${vndb.id}`);
  if (dlsite?.id) codeSet.add(dlsite.id);
  if (steam?.id) codeSet.add(`Steam:${steam.id}`);

  const devSet = new Set();
  for (const d of [
    ...(Array.isArray(parsedWork.developers) ? parsedWork.developers : []),
    ...(shion?.developers || []),
    ...(vndb?.developers || []),
    ...(dlsite?.developers || [])
  ]) {
    const clean = cleanTitle(d, 60);
    if (clean) devSet.add(clean);
  }

  const tagSet = new Set();
  for (const t of [
    ...(Array.isArray(parsedWork.tags) ? parsedWork.tags : []),
    ...(shion?.tags || [])
  ]) {
    const clean = cleanTitle(t, 40);
    if (clean) tagSet.add(clean);
  }

  const coverCandidates = [
    parsedWork.cover,
    shion?.cover,
    vndb?.cover,
    dlsite?.cover,
    touchgal?.cover,
    steam?.cover
  ].map(publicLink).filter(Boolean);

  const summary = cleanTitle(
    parsedWork.summary
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
    developers: [...devSet].slice(0, 4),
    tags: [...tagSet].slice(0, 8),
    characters: animeChars.slice(0, 3),
    cover: coverCandidates[0] || '',
    summary
  };
}

function collectResourceLists(agentResult, maxResults = 5) {
  const items = Array.isArray(agentResult?.crawledItems) ? agentResult.crawledItems : [];
  const parsedFree = Array.isArray(agentResult?.parsed?.freeResources) ? agentResult.parsed.freeResources : [];
  const parsedOfficial = Array.isArray(agentResult?.parsed?.officialResources) ? agentResult.parsed.officialResources : [];

  const freeList = [];
  const seenFreeUrls = new Set();

  // 1. 优先放 TouchGal 和 书音的图书馆 的结构化免费资源（含直链、提取码、解压密码）
  for (const item of items) {
    if (item.source !== 'touchgal' && item.source !== 'shionlib') continue;
    const url = publicLink(item.url);
    if (!url || seenFreeUrls.has(url)) continue;
    seenFreeUrls.add(url);
    freeList.push({
      siteName: item.siteName || (item.source === 'touchgal' ? 'TouchGal 资源站' : '书音的图书馆'),
      title: cleanTitle(item.title, 120),
      url,
      note: cleanTitle(item.note, 160),
      downloads: Array.isArray(item.downloads) ? item.downloads : []
    });
  }

  // 2. 合并 DeepSeek 筛选出的免费资源渠道
  for (const row of parsedFree) {
    const url = publicLink(row?.url);
    if (!url || seenFreeUrls.has(url)) continue;
    seenFreeUrls.add(url);
    freeList.push({
      siteName: cleanTitle(row?.siteName || '免费资源站', 60),
      title: cleanTitle(row?.title || '资源页面', 120),
      url,
      note: cleanTitle(row?.note, 180),
      downloads: []
    });
  }

  // 3. 若免费列表不足，把全网搜索命中的资源页补进来
  for (const item of items) {
    if (item.source !== 'web' || freeList.length >= maxResults) break;
    const url = publicLink(item.url);
    if (!url || seenFreeUrls.has(url)) continue;
    seenFreeUrls.add(url);
    freeList.push({
      siteName: cleanTitle(item.siteName || '网页资源', 60),
      title: cleanTitle(item.title, 120),
      url,
      note: cleanTitle(item.snippet, 180),
      downloads: []
    });
  }

  // 4. 正版与权威数据库参考（DLsite / Steam / VNDB）
  const officialList = [];
  const seenOfficialUrls = new Set();
  for (const item of items) {
    if (!['dlsite', 'steam', 'vndb'].includes(item.source)) continue;
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

function formatWorkHeader(work) {
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
  if (work.summary) lines.push(`简介与结论：${work.summary}`);
  return lines.join('\n');
}

function formatFreeResourceBlock(item, index) {
  const lines = [`📦 免费资源渠道 #${index + 1} · ${item.siteName}`];
  lines.push(`标题：${item.title}`);
  if (item.note) lines.push(`说明：${item.note}`);
  lines.push(`页面：${item.url}`);
  if (Array.isArray(item.downloads) && item.downloads.length) {
    lines.push('── 直链与网盘分流 ──');
    for (const dl of item.downloads.slice(0, 4)) {
      lines.push(`• ${dl.name}：${dl.url}`);
      const meta = [
        dl.code ? `提取码：${dl.code}` : '',
        dl.password ? `解压密码：${dl.password}` : '',
        dl.note ? `备注：${dl.note}` : ''
      ].filter(Boolean).join(' | ');
      if (meta) lines.push(`  (${meta})`);
    }
  }
  return lines.join('\n');
}

function formatOfficialListBlock(officialResources) {
  const lines = ['🛒 正版与权威数据库参考'];
  for (const [idx, item] of officialResources.entries()) {
    lines.push(`${idx + 1}. [${item.siteName}] ${item.title}`);
    if (item.note) lines.push(`   ${item.note}`);
    lines.push(`   ${item.url}`);
  }
  return lines.join('\n');
}

export function formatResourceSearchReply(agentResult, settings = {}, query = '') {
  const maxResults = Number(settings.maxResults) || 5;
  const work = resolveWorkProfile(agentResult, query);
  const { freeResources, officialResources } = collectResourceLists(agentResult, maxResults);
  const blocks = [formatWorkHeader(work)];

  if (freeResources.length) {
    for (const [i, item] of freeResources.entries()) {
      blocks.push(formatFreeResourceBlock(item, i));
    }
  } else {
    blocks.push('📦 免费资源渠道\n本次在已启用站点中暂未检出可直接确认的免费下载页，可参考下方正版/数据库原名或编号进一步搜索。');
  }

  if (officialResources.length) {
    blocks.push(formatOfficialListBlock(officialResources));
  }
  return blocks.join('\n\n');
}

export async function buildResourceSearchNodes(agentResult, settings = {}, options = {}) {
  const maxResults = Number(settings.maxResults) || 5;
  const work = resolveWorkProfile(agentResult, options.query || '');
  const { freeResources, officialResources } = collectResourceLists(agentResult, maxResults);
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

  const headerContent = [text(formatWorkHeader(work))];
  if (settings.includeImages !== false && work.cover && !options.signal?.aborted) {
    try {
      const fetchFn = options.fetchImpl || globalThis.fetch;
      const imgSignal = AbortSignal.any([
        ...(options.signal ? [options.signal] : []),
        AbortSignal.timeout(10000)
      ]);
      const res = await fetchFn(work.cover, {
        signal: imgSignal,
        headers: { 'user-agent': 'Mozilla/5.0' }
      });
      if (res.ok) {
        const buffer = await boundedBody(res, MAX_COVER_BYTES, imgSignal);
        if (imageType(buffer)) {
          headerContent.push(text('\n作品封面预览：'));
          headerContent.push({
            type: 'image',
            data: { file: `base64://${buffer.toString('base64')}` }
          });
        }
      } else {
        await res.body?.cancel().catch(() => {});
      }
    } catch {
      options.signal?.throwIfAborted();
    }
  }

  const nodes = [node(headerContent)];

  if (freeResources.length) {
    for (const [i, item] of freeResources.entries()) {
      nodes.push(node([text(formatFreeResourceBlock(item, i))]));
    }
  } else {
    nodes.push(node([text('📦 免费资源渠道\n本次在已启用站点中暂未检出可直接确认的免费下载页，建议复制上方日文原名或 RJ/VNDB 编号检索。')]));
  }

  if (officialResources.length) {
    nodes.push(node([text(formatOfficialListBlock(officialResources))]));
  }

  return nodes;
}
