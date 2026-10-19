// 仅接管显式 E站指令；纯数字只有在该会话存在尚未过期的列表时才由管理器接管。
export function ehentaiCommand(raw, hasList = false) {
  const text = String(raw || '').trim();
  if (!text) return null;
  let match = text.match(/^\/?(?:e站|ehentai|e-hentai)\s*(?:tag|标签)\s*[：:]\s*(.{1,120})$/i);
  if (match) return { kind: 'tag', query: match[1].trim() };
  match = text.match(/^\/?tag\s*[：:]\s*(.{1,120})$/i);
  if (match) return { kind: 'tag', query: match[1].trim() };
  match = text.match(/^\/?(?:e站|ehentai|e-hentai)\s*搜索\s*[：:]\s*(.{1,120})$/i);
  if (match) return { kind: 'search', query: match[1].trim() };
  match = text.match(/^\/?(?:e站|ehentai|e-hentai)\s*(?:每日排行榜|日榜|昨日榜单|每日榜单)\s*$/i);
  if (match) return { kind: 'daily' };
  match = text.match(/^\/?(?:e站|ehentai|e-hentai)\s*(?:第\s*(\d{1,3})\s*页|(上一页|下一页)|([1-9]\d?))\s*$/i);
  if (match) return match[1] ? { kind: 'page', page: Number(match[1]) } : match[2] ? { kind: 'turn', direction: match[2] === '下一页' ? 1 : -1 } : { kind: 'select', index: Number(match[3]) };
  if (!hasList) return null;
  match = text.match(/^第\s*(\d{1,3})\s*页$/);
  if (match) return { kind: 'page', page: Number(match[1]) };
  if (text === '上一页' || text === '下一页') return { kind: 'turn', direction: text === '下一页' ? 1 : -1 };
  match = text.match(/^([1-9]|10)$/);
  return match ? { kind: 'select', index: Number(match[1]) } : null;
}
