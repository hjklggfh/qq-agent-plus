// 只接管明确指令或完整作品链接，普通数字和聊天不会被误当作品号。
export function pixivCommand(raw) {
  let text = String(raw || '').trim();
  const format = text.match(/\s+(PDF|图片)\s*$/i);
  if (format) text = text.slice(0, format.index).trim();
  const output = format ? { outputFormat: format[1].toLowerCase() === 'pdf' ? 'pdf' : 'images' } : {};
  const match = text.match(/^\/?(?:pid|p站|pixiv|查pid)\s*[：:]?\s*(\d{5,12})(?:\s+(\d{1,4})(?:\s*[-—]\s*(\d{1,4}))?)?\s*$/i);
  if (match) return { pid: match[1], startPage: Number(match[2] || 1), endPage: match[3] ? Number(match[3]) : undefined, ...output };
  const link = text.match(/^https?:\/\/(?:www\.)?pixiv\.net\/(?:[a-z]{2}\/)?(?:artworks|i)\/(\d{5,12})(?:\?[^\s]*)?$/i);
  return link ? { pid: link[1], startPage: 1, ...output } : null;
}
