import { IMAGE_DOMAINS, UA_APP, firstString, asArray } from './engine.js';
import sharp from 'sharp';

const PER_CARD = 5;
const MAX_COVER_BYTES = 4 * 1024 * 1024;

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

export async function normalizeSearchCover(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_COVER_BYTES) {
    throw new Error('封面为空或超过大小限制');
  }
  // 完整解码后统一输出普通 RGB JPEG；不能仅凭文件头把损坏文件交给 QQ。
  // 去除元数据、透明通道和动画，限制像素与传输体积，不改变封面内容。
  const image = await sharp(buffer, { limitInputPixels: 24_000_000, failOn: 'warning' })
    .rotate().resize({ width: 512, height: 768, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' }).toColourspace('srgb')
    .jpeg({ quality: 82, progressive: false }).toBuffer();
  if (image.length > 256 * 1024) throw new Error('封面转换后超过大小限制');
  return image;
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
      if (result.ok) {
        const image = await normalizeSearchCover(result.buffer);
        return { type: 'image', data: { file: `base64://${image.toString('base64')}` } };
      }
    } catch { /* 尝试下一个图片域名 */ }
  }
  // 协议端没有站点所需的请求头；回退裸 URL 可能使一张坏封面拖垮整张卡片。
  return text('封面暂不可用');
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

export function searchDetailNodes(nodes) {
  return nodes.map((item) => ({
    ...item,
    data: {
      ...item.data,
      content: item.data.content.filter((segment) => segment.type !== 'image')
    }
  }));
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
    if (history.messages.some((message) => String(message?.message_id) === String(messageId)
      && (message.message_seq == null || Number(message.message_seq) > 0))) return true;
  }
  return false;
}

export async function deliverSearchCard(ctx, result, { query, page, verifyOptions } = {}) {
  const variants = [
    { kind: '搜索', label: `JM搜索 ${query}`, nodes: result.nodes },
    { kind: '详情版', label: 'JM搜索详情版', nodes: searchDetailNodes(result.nodes) },
    { kind: '编号简版', label: 'JM搜索结果简版', nodes: searchFallbackNodes(result, page, { selfId: ctx.selfId }) }
  ];
  for (const variant of variants) {
    const sent = await ctx.forward(variant.nodes, variant.label);
    if (ctx.kind !== 'group') return { kind: variant.kind, visible: null, messageId: sent?.message_id };
    const visible = await groupForwardVisible(ctx.onebot, ctx.chatId, sent?.message_id, verifyOptions);
    // 查询失败或无消息 ID 时送达未知，不能当作失败连续补发。
    if (visible !== false || variant.kind === '编号简版') {
      return { kind: variant.kind, visible, messageId: sent?.message_id };
    }
  }
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
