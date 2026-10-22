import { IMAGE_DOMAINS, UA_APP, firstString, asArray } from './engine.js';

const PER_CARD = 5;
const MAX_COVER_BYTES = 1024 * 1024;

function rowsOf(response) {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response?.content)) return response.content;
  if (Array.isArray(response?.list)) return response.list;
  return [];
}

export async function searchCardPage(client, query, page) {
  const first = await client.searchAlbums(query, 1);
  const firstRows = rowsOf(first);
  const redirectId = first?.redirect_aid;
  const initialRows = firstRows.length ? firstRows : redirectId ? [{ id: redirectId }] : [];
  const total = Math.max(initialRows.length, Number(first?.total) || 0);
  const pages = Math.ceil(total / PER_CARD);
  if (!pages || page > pages) return { rows: [], total, pages };
  if (!initialRows.length) throw new Error('JM 搜索接口报告有结果，但没有返回作品列表');
  const upstreamSize = initialRows.length;
  const offset = (page - 1) * PER_CARD;
  const upstreamPage = Math.floor(offset / upstreamSize) + 1;
  const upstreamOffset = offset % upstreamSize;
  const response = upstreamPage === 1 ? first : await client.searchAlbums(query, upstreamPage);
  const rows = upstreamPage === 1 ? initialRows : rowsOf(response);
  let selected = rows.slice(upstreamOffset, upstreamOffset + PER_CARD);
  if (selected.length < Math.min(PER_CARD, total - offset)) {
    const next = rowsOf(await client.searchAlbums(query, upstreamPage + 1));
    selected = selected.concat(next.slice(0, PER_CARD - selected.length));
  }
  return { rows: selected, total, pages };
}

function imageBuffer(buffer) {
  if (!buffer || buffer.length < 1024 || buffer.length > MAX_COVER_BYTES) return false;
  return (buffer[0] === 0xff && buffer[1] === 0xd8)
    || (buffer[0] === 0x89 && buffer[1] === 0x50)
    || (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46)
    || (buffer[0] === 0x47 && buffer[1] === 0x49);
}

async function coverSegment(client, albumId) {
  for (const domain of IMAGE_DOMAINS.slice(0, 2)) {
    const url = `https://${domain}/media/albums/${albumId}_3x4.jpg?v=${Math.floor(Date.now() / 1000)}`;
    try {
      const result = await client.httpGet(url, {
        headers: { 'user-agent': UA_APP, accept: 'image/*', referer: `https://${domain}/` },
        timeoutOverride: 6000,
        retries: 0
      });
      if (result.ok && imageBuffer(result.buffer)) {
        return { type: 'image', data: { file: `base64://${result.buffer.toString('base64')}` } };
      }
    } catch { /* 尝试下一个图片域名 */ }
  }
  return { type: 'image', data: { file: `https://${IMAGE_DOMAINS[0]}/media/albums/${albumId}_3x4.jpg` } };
}

const text = (value) => ({ type: 'text', data: { text: value } });
const node = (content, bot) => ({ type: 'node', data: {
  uin: String(bot.selfId || ''),
  name: '小鲸鱼',
  content
} });

export function searchFallbackNodes({ rows, pages, total }, page, bot = {}) {
  const nodes = Array.from({ length: PER_CARD }, (_, index) => {
    const number = (page - 1) * PER_CARD + index + 1;
    const albumId = firstString(rows[index]?.id, rows[index]?.album_id);
    return node([text(/^\d{2,9}$/.test(albumId)
      ? `${number}. JM${albumId}` : `${number}. 本页没有更多作品`)], bot);
  });
  nodes.push(node([text(`搜索结果简版：第 ${page}/${pages} 页，共 ${total} 部。发送序号可获取资源；发送「上一页」或「下一页」翻页。完整详情和封面可在私聊搜索查看。`)], bot));
  return nodes;
}

export async function groupForwardVisible(onebot, chatId, messageId, { attempts = 3, delayMs = 1500 } = {}) {
  if (!onebot?.call || messageId == null) return null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt && delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    let history;
    try {
      history = await onebot.call('get_group_msg_history', {
        group_id: Number(chatId), message_seq: 0, count: 50
      });
    } catch { return null; }
    if (!Array.isArray(history?.messages)) return null;
    if (history.messages.some((message) => String(message?.message_id) === String(messageId))) return true;
  }
  return false;
}

function clean(value, format) {
  return format(firstString(value)).replace(/\s+/g, ' ').trim();
}

export async function searchCardNodes(client, { query, page, bot = {}, format = (value) => value, includeExternalLink = true }) {
  const result = await searchCardPage(client, query, page);
  if (!result.pages || page > result.pages) return { ...result, nodes: [] };
  const nodes = await Promise.all(result.rows.map(async (row, index) => {
    const number = (page - 1) * PER_CARD + index + 1;
    const albumId = firstString(row?.id, row?.album_id);
    if (!/^\d{2,9}$/.test(albumId)) return node([text(`${number}. 搜索结果编号无效，无法读取详情`)], bot);
    const album = await client.albumInfo(albumId).catch(() => null);
    const title = clean(album?.name || row?.name || row?.title || `JM${albumId}`, format).slice(0, 150);
    const tags = asArray(album?.tags?.length ? album.tags : row?.tags).map((tag) => clean(tag, format)).filter(Boolean);
    const authors = asArray(album?.authors?.length ? album.authors : row?.author).map((author) => clean(author, format)).filter(Boolean);
    const description = clean(album?.description || row?.description || '', format).slice(0, 240);
    const lines = [
      `${number}. ${title}`,
      `编号：JM${albumId}`,
      `标签：${tags.length ? tags.slice(0, 12).join('、') : '暂无'}`,
      `作者：${authors.length ? authors.slice(0, 4).join('、') : '暂无'}`,
      `简介：${description || '暂无'}`
    ];
    if (includeExternalLink) lines.push(`查看：https://18comic.vip/album/${albumId}`);
    const cover = await coverSegment(client, albumId);
    return node([text(lines.join('\n')), cover], bot);
  }));
  while (nodes.length < PER_CARD) nodes.push(node([text(`${(page - 1) * PER_CARD + nodes.length + 1}. 本页没有更多作品`)], bot));
  const next = page < result.pages ? `\n下一页：发送「下一页」（或「JM搜索 ${query} 第${page + 1}页」）` : '';
  const prev = page > 1 ? `\n上一页：发送「上一页」（或「JM搜索 ${query} 第${page - 1}页」）` : '';
  nodes.push(node([text(`搜索「${query}」：第 ${page}/${result.pages} 页，共 ${result.total} 部作品。\n发送作品序号即可下载。${prev}${next}`)], bot));
  return { ...result, nodes };
}
