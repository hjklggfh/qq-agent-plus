export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const PLATFORM_LABELS = Object.freeze({ google: 'Google Lens', serpapi: 'Google Lens（SerpApi）', yandex: 'Yandex', trace: 'trace.moe' });

export function publicLink(raw) {
  try {
    const url = new URL(raw);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.href.length > 2000 || /\[CQ:/i.test(url.href)) return '';
    return url.href;
  } catch { return ''; }
}

export function cleanTitle(value, max = 180) {
  return String(value || '').replace(/\[CQ:[^\]]*\]/gi, '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

export async function boundedBody(response, maxBytes, signal) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body || []) {
    signal?.throwIfAborted();
    size += chunk.length;
    if (size > maxBytes) throw new Error('响应超过大小限制');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function formatSearchReply(reports, limit = 3) {
  const lines = ['以图搜图结果（匹配网页不代表原创出处）'];
  for (const report of reports) {
    const label = PLATFORM_LABELS[report.platform] || '搜图';
    if (report.status !== 'ok') {
      lines.push(`\n${label}：${cleanTitle(report.message || '未找到可靠结果')}`);
      continue;
    }
    lines.push(`\n${label}`);
    for (const [i, row] of (report.results || []).slice(0, limit).entries()) {
      const url = publicLink(row.url);
      if (!url) continue;
      lines.push(`${i + 1}. ${cleanTitle(row.title) || '匹配网页'}`);
      if (report.platform === 'serpapi') {
        const kind = { post: '帖子', profile: '资料页', search: '搜索页', page: '网页' }[row.kind] || '网页';
        const match = row.match === 'exact' ? 'Lens 完全匹配分区' : 'Lens 相似图片分区';
        lines.push(`来源：${cleanTitle(row.source, 80) || new URL(url).hostname} · ${kind} · ${match}${row.account ? ` · 链接账号 ${cleanTitle(row.account, 40)}` : ''}（请核对是否原创）`);
      } else if (report.platform !== 'trace') {
        lines.push(`来源网站：${new URL(url).hostname}（请核对是否原创）`);
      }
      if (report.platform === 'trace' && Number.isFinite(row.similarity)) {
        const stamp = (n) => `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, '0')}`;
        lines.push(`第${cleanTitle(row.episode ?? '未知')}集 · 相似度 ${(row.similarity * 100).toFixed(1)}%${Number.isFinite(row.from) && Number.isFinite(row.to) ? ` · ${stamp(row.from)}—${stamp(row.to)}（对应片源）` : ''}`);
      }
      lines.push(url);
    }
  }
  return lines.join('\n');
}

export function formatFindReply(report) {
  const lines = ['🎯 找鸡结果'];
  if (report?.status !== 'ok' || !report.results?.length) {
    lines.push(`\n🔎 匹配：${cleanTitle(report?.message || '没有找到可核对的公开线索')}`);
    return lines.join('\n');
  }
  const row = report.results.find((item) => publicLink(item.url));
  if (!row) return `${lines[0]}\n\n🔎 匹配：没有找到可核对的公开线索`;
  const site = cleanTitle(row.source, 80) || new URL(row.url).hostname;
  const platform = site.startsWith('X (') ? 'X (Twitter)' : site.replace(/ \([^)]*\)$/, '');
  const kind = { post: '帖子', profile: '资料页', search: '搜索页', page: '网页' }[row.kind] || '网页';
  const match = row.match === 'exact' ? '完全匹配线索' : '视觉匹配线索';
  lines.push(`\n🌐 平台：${platform}`);
  lines.push(`🔎 匹配：${match} · ${kind}`);
  lines.push(`👤 名字：${cleanTitle(row.title, 100) || '未确认'}`);
  lines.push(`🆔 账号：${cleanTitle(row.account, 40) || '未确认'}`);
  lines.push(`🔗 来源：${publicLink(row.url)}`);
  lines.push(row.kind === 'search'
    ? '\n⚠️ 这只是搜索／发现页，尚未确认具体账号或原帖，请自行核对。'
    : '\n⚠️ 识图可能有误，来源也可能是转载，请自行核对。');
  return lines.join('\n');
}
