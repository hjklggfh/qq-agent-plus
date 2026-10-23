const RESERVED = new Set(['home', 'explore', 'search', 'settings', 'notifications', 'messages', 'i', 'intent', 'share', 'compose']);

export function xSearchCommand(raw) {
  const text = String(raw || '').trim();
  if (/^\/?X下一页$/i.test(text)) return { next: true };
  const original = text.match(/^\/?X\s*([1-9][0-9]{0,5})\s*原图$/i);
  if (original) return { original: Number(original[1]) };
  let username = text.match(/^\/?(?:X|推特|Twitter)(?:搜索)?\s+@?([a-z0-9_]{1,15})$/i)?.[1];
  if (!username) username = text.match(/^https:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/([a-z0-9_]{1,15})\/?(?:\?[^\s]*)?$/i)?.[1];
  return username && !RESERVED.has(username.toLowerCase()) ? { username } : null;
}
