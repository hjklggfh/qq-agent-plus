const SOURCE_NOISE_TAGS = new Set(['禁忌书屋', 'esjzone', 'cool18', 'pixiv', '蓝p官能文学社', '开心书库']);

function formatDateShort(iso) {
  const s = String(iso || '');
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : '';
}

function formatNovelItem(item, index) {
  const ext = String(item.ext || '').replace(/^\./, '').toUpperCase() || 'TXT';
  const datePart = formatDateShort(item.date);
  const sizePart = String(item.sizeText || '').replace(/^ESJ\s*/i, '').trim() || ext;
  const meta = [sizePart, datePart].filter(Boolean).join(' · ');
  const lines = [
    `【${index}】《${item.title || '未命名小说'}》`,
    `📄 ${meta}`
  ];
  if (Array.isArray(item.tags) && item.tags.length) {
    const cleanTags = item.tags
      .filter((t) => !SOURCE_NOISE_TAGS.has(String(t || '').trim().toLowerCase()))
      .slice(0, 8);
    if (cleanTags.length) {
      lines.push(`🏷 ${cleanTags.map((t) => `#${t}`).join(' ')}`);
    }
  }
  if (item.summary) {
    lines.push(`📝 ${item.summary}`);
  }
  return lines.join('\n');
}

function buildNovelBlocks(session, page) {
  const total = session.items.length;
  const totalPages = Math.max(1, Math.ceil(total / session.pageSize));
  const safePage = Math.max(1, Math.min(totalPages, page));
  const start = (safePage - 1) * session.pageSize;
  const slice = session.items.slice(start, start + session.pageSize);

  const heading = session.mode === 'latest'
    ? '📚 小说最新更新'
    : `📚 小说检索：${session.query}`;

  const headerLines = [
    heading,
    `共找到 ${total} 本 · 第 ${safePage}/${totalPages} 页`,
    `💡 直接回复序号（如 ${start + 1}）下载上传群文件；回复「下一页」「上一页」翻页。`
  ];

  const blocks = [{
    title: '小说检索',
    text: headerLines.join('\n')
  }];

  for (let i = 0; i < slice.length; i += 1) {
    const globalIdx = start + i + 1;
    blocks.push({
      title: `第 ${globalIdx} 本`,
      text: formatNovelItem(slice[i], globalIdx)
    });
  }

  const label = session.mode === 'latest'
    ? `小说最新更新（第 ${safePage}/${totalPages} 页）`
    : `小说检索 ${session.query}（第 ${safePage}/${totalPages} 页）`;

  return { blocks, label, page: safePage, totalPages, count: slice.length };
}

export function buildNovelSearchNodes(session, page, options = {}) {
  const { blocks, label, page: safePage, totalPages, count } = buildNovelBlocks(session, page);
  const uin = String(options.selfId || '');
  const defaultName = String(options.name || '小说检索').slice(0, 40);
  const nodes = blocks.map((block) => ({
    type: 'node',
    data: {
      uin,
      name: String(block.title || defaultName).slice(0, 40),
      content: [{ type: 'text', data: { text: block.text } }]
    }
  }));
  return { nodes, label, page: safePage, totalPages, count };
}

export function formatNovelSearchText(session, page) {
  const { blocks } = buildNovelBlocks(session, page);
  return blocks.map((b) => b.text).join('\n\n');
}

export function formatNovelHelp() {
  return [
    '📚 小说检索用法',
    '',
    '• /搜小说 关键词 — 搜索小说（别名：/搜书）',
    '• /搜小说 #标签 -避雷词 — 按标签搜索并排除不想看的类型（例：/搜小说 #纯爱 #校园 -NTR）',
    '• /小说最新 — 查看近期更新',
    '',
    '📥 出卡后 30 分钟内：直接回复序号（如 1）即可下载上传群文件，回复「下一页」「上一页」翻页。'
  ].join('\n');
}
