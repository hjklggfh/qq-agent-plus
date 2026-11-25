function formatDateShort(iso) {
  const s = String(iso || '');
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : '';
}

function formatNovelItem(item, index) {
  const ext = String(item.ext || '').replace(/^\./, '').toUpperCase() || 'TXT';
  const datePart = formatDateShort(item.date);
  const meta = [item.channelLabel || item.channel || item.source, item.sizeText || ext, datePart].filter(Boolean).join(' · ');
  const lines = [
    `【${index}】《${item.title || '未命名小说'}》`,
    `📚 ${meta}`
  ];
  if (Array.isArray(item.tags) && item.tags.length) {
    lines.push(`🏷 ${item.tags.slice(0, 8).map((t) => `#${t}`).join(' ')}`);
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
    ? `📚 小说最新更新${session.channelLabel ? `（${session.channelLabel}）` : ''}`
    : `📚 小说检索：${session.query}${session.channelLabel ? `（${session.channelLabel}）` : ''}`;

  const headerLines = [
    heading,
    `共找到 ${total} 本 · 第 ${safePage}/${totalPages} 页`,
    `💡 直接回复序号（如 ${start + 1}）下载并上传群文件；回复「下一页」「上一页」翻页。`,
    '🔎 支持标签与避雷：/搜小说 #纯爱 #校园 -NTR'
  ];
  if (session.channelErrors && Object.keys(session.channelErrors).length) {
    headerLines.push(`⚠️ 部分源暂时不可用：${Object.keys(session.channelErrors).join('、')}`);
  }

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
    ? `小说最新更新${session.channelLabel ? ` · ${session.channelLabel}` : ''}（第 ${safePage}/${totalPages} 页）`
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

export function formatNovelHelp(settings) {
  const src = settings?.sources || {};
  const enabledList = [];
  if (src.pixiv !== false) enabledList.push('• Pixiv 小说（二游角色同人主力，自动过滤语C/招新水帖）');
  if (src.cool18 !== false) enabledList.push('• Cool18 禁忌书屋（免登录全站中文 R-18）');
  if (src.esjzone !== false) enabledList.push('• ESJZone（免登录日轻 / R-18 里轻小说长篇连载）');
  if (src.telegram !== false) {
    const chs = (settings?.channels || []).filter((c) => c.enabled !== false).map((c) => c.label).join('、');
    if (chs) enabledList.push(`• Telegram 频道（${chs}，需东京端已登录授权）`);
  }

  return [
    '📚 小说检索指令说明',
    '',
    '🔎 全源聚合搜索（支持书名 / 关键词 / #标签 / -避雷词）',
    '• /搜小说 关键词 — 同时检索全部已启用书源（别名：/搜书、/找小说）',
    '• /搜小说 #纯爱 #校园 -NTR — 多标签组合 + 排除避雷词',
    '',
    '🎯 指定书源直搜',
    '• /P站小说 关键词 — 仅搜 Pixiv 小说',
    '• /禁忌书屋 关键词（或 /书屋 关键词）— 仅搜 Cool18 禁忌书屋',
    '• /ESJ 关键词 — 仅搜 ESJZone 轻小说/R18',
    '• /蓝P 关键词 / /开心书库 关键词 — 仅搜对应 TG 频道',
    '',
    '🆕 逛近期更新',
    '• /小说最新 / /书屋最新 / /ESJ最新 / /蓝P最新',
    '',
    '📥 下载与翻页（出卡后 30 分钟内有效）',
    '• 直接回复序号（如 1）即可合成 UTF-8 .txt 并上传群文件',
    '• 回复「下一页」「上一页」或「第2页」翻页',
    '',
    '📡 当前已启用书源：',
    enabledList.length ? enabledList.join('\n') : '（暂未启用任何书源）'
  ].join('\n');
}
