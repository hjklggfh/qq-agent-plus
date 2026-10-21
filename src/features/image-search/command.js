const ALIASES = Object.freeze({ google: 'google', '谷歌': 'google', lens: 'google', serpapi: 'serpapi', '谷歌api': 'serpapi', yandex: 'yandex', trace: 'trace', 'trace.moe': 'trace', '动画': 'trace', all: 'all', '全部': 'all' });

// OneBot 字符串模式仅解析已知 CQ 段；图片 URL 仍须经过宿主安全下载层。
export function searchSegments(message) {
  if (Array.isArray(message)) return message;
  const segments = [];
  let offset = 0;
  const decode = (s) => s.replace(/&#44;/g, ',').replace(/&#91;/g, '[').replace(/&#93;/g, ']').replace(/&amp;/g, '&');
  for (const match of String(message || '').matchAll(/\[CQ:(image|reply|at),([^\]]*)\]/g)) {
    segments.push({ type: 'text', data: { text: String(message).slice(offset, match.index) } });
    const data = Object.fromEntries(match[2].split(',').map((part) => { const i = part.indexOf('='); return [part.slice(0, i), decode(part.slice(i + 1))]; }));
    segments.push({ type: match[1], data });
    offset = match.index + match[0].length;
  }
  segments.push({ type: 'text', data: { text: String(message || '').slice(offset) } });
  return segments;
}

export function imageSearchCommand(message) {
  const segments = searchSegments(message);
  const text = segments.filter((s) => s?.type === 'text').map((s) => s.data?.text || '').join('').trim();
  const match = text.match(/^\/?搜图(?:\s+(\S+))?\s*$/i);
  if (!match) return null;
  return { platform: match[1] ? ALIASES[match[1].toLowerCase()] || 'invalid' : 'auto', segments };
}
