// 只接管明确指令或完整作品链接，普通数字和聊天不会被误当作品号。
export function pixivCommand(raw) {
  const text = String(raw || '').trim();
  const match = text.match(/^\/?(?:pid|p站|pixiv|查pid)\s*[：:]?\s*(\d{5,12})(?:\s+(\d{1,4})(?:\s*[-—]\s*(\d{1,4}))?)?\s*$/i);
  if (match) return { pid: match[1], startPage: Number(match[2] || 1), endPage: match[3] ? Number(match[3]) : undefined };
  const link = text.match(/^https?:\/\/(?:www\.)?pixiv\.net\/(?:[a-z]{2}\/)?(?:artworks|i)\/(\d{5,12})(?:\?[^\s]*)?$/i);
  return link ? { pid: link[1], startPage: 1 } : null;
}
