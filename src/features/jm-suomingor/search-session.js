const SEARCH_TTL_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 200;
const sessions = new Map();

function key(chatKey, senderId) {
  const chat = String(chatKey || '');
  const sender = String(senderId || '');
  return /^(?:group|private):\d{5,15}$/.test(chat) && /^\d{5,15}$/.test(sender)
    ? `${chat}:${sender}` : '';
}

export function searchSenderId(ctx = {}) {
  const entries = Array.isArray(ctx.triggerEntries) ? ctx.triggerEntries : [];
  const sender = [...entries].reverse().find((entry) => entry && !entry.self && /^\d{5,15}$/.test(String(entry.senderId || '')));
  if (sender) return String(sender.senderId);
  if (ctx.kind === 'private' && /^\d{5,15}$/.test(String(ctx.chatId || ''))) return String(ctx.chatId);
  return '';
}

export function rememberSearchPage({ chatKey, senderId, query, page, pages, rows, now = Date.now() } = {}) {
  const id = key(chatKey, senderId);
  if (!id || !query || !Number.isSafeInteger(page) || page < 1 || !Array.isArray(rows)) return false;
  const old = sessions.get(id);
  const sameSearch = old && old.query === query && now - old.at < SEARCH_TTL_MS;
  const items = sameSearch ? new Map(old.items) : new Map();
  for (const [offset, row] of rows.entries()) {
    const albumId = String(row?.id ?? row?.album_id ?? '');
    if (/^\d{2,9}$/.test(albumId)) items.set((page - 1) * 5 + offset + 1, albumId);
  }
  sessions.delete(id);
  sessions.set(id, { query, page, pages, items, at: now });
  while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
  return true;
}

export function resolveSearchFollowup({ chatKey, senderId, text, now = Date.now() } = {}) {
  const id = key(chatKey, senderId);
  if (!id) return null;
  const state = sessions.get(id);
  if (!state) return null;
  if (now - state.at >= SEARCH_TTL_MS) {
    sessions.delete(id);
    return null;
  }
  const command = String(text || '').replace(/@\S+\s*/g, '').trim();
  if (/^(?:JM\s*)?下一页$/iu.test(command)) {
    return state.page < state.pages
      ? { type: 'page', query: state.query, page: state.page + 1 }
      : { type: 'notice', text: `已经是第 ${state.pages} 页了。` };
  }
  if (/^(?:JM\s*)?上一页$/iu.test(command)) {
    return state.page > 1
      ? { type: 'page', query: state.query, page: state.page - 1 }
      : { type: 'notice', text: '已经是第一页了。' };
  }
  const number = /^(\d{1,5})$/u.exec(command);
  if (!number) return null;
  const index = Number(number[1]);
  const albumId = state.items.get(index);
  return albumId ? { type: 'resource', index, albumId } : null;
}

export function clearSearchSessions() {
  sessions.clear();
}
