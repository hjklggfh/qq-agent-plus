// 仅接管显式小说检索指令；纯数字与上一页/下一页仅在该会话存在尚未过期的搜索列表时接管。

const SEARCH_RE = /^\/?(?:搜小说|找小说|搜书|找书|小说搜索)(?:[:：\s]+([\s\S]+))?$/i;
const HELP_RE = /^\/?(?:小说帮助|搜小说帮助|搜书帮助|小说指令)$/i;
const LATEST_RE = /^\/?(?:(?:小说|蓝p|蓝P|px|p站小说|pixiv小说|禁忌书屋|书屋|cool18|esj|esjzone|轻小说|开心书库|开心)\s*最新|最新小说)$/i;
const SHORTCUT_RE = /^\/?(?:搜?p站小说|搜?pixiv小说|搜?禁忌书屋|搜?书屋|cool18|搜?esjzone|搜?esj|搜?蓝p|搜?蓝P|搜?开心书库|搜?开心)(?:[:：\s]+([\s\S]+))?$/i;
const EXPLICIT_NAV_RE = /^\/?(?:小说|搜小说|搜书)\s*(?:第\s*(\d{1,3})\s*页|(上一页|下一页)|([1-9]\d{0,2}))$/i;

function sanitizeQuery(raw) {
  return String(raw || '')
    .replace(/\[CQ:[^\]]*\]/gi, ' ')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function shortcutRoute(prefixText) {
  const low = String(prefixText || '').toLowerCase();
  if (/p站小说|pixiv/.test(low)) return { sourceHint: 'pixiv', channelHint: '' };
  if (/禁忌书屋|书屋|cool18/.test(low)) return { sourceHint: 'cool18', channelHint: '' };
  if (/esj|轻小说/.test(low)) return { sourceHint: 'esjzone', channelHint: '' };
  if (/蓝p|px/.test(low)) return { sourceHint: 'telegram', channelHint: 'px_novels' };
  if (/开心/.test(low)) return { sourceHint: 'telegram', channelHint: 'happylibrary' };
  return { sourceHint: '', channelHint: '' };
}

export function novelSearchCommand(raw, hasList = false) {
  const text = String(raw || '').trim();
  if (!text) return null;

  if (HELP_RE.test(text)) {
    return { kind: 'help' };
  }

  if (LATEST_RE.test(text)) {
    const route = shortcutRoute(text);
    return { kind: 'latest', sourceHint: route.sourceHint, channelHint: route.channelHint };
  }

  let match = text.match(EXPLICIT_NAV_RE);
  if (match) {
    if (match[1]) return { kind: 'page', page: Number(match[1]) };
    if (match[2]) return { kind: 'turn', direction: match[2] === '下一页' ? 1 : -1 };
    return { kind: 'select', index: Number(match[3]) };
  }

  match = text.match(SEARCH_RE);
  if (match) {
    const query = sanitizeQuery(match[1] || '');
    if (!query) return { kind: 'help' };
    return { kind: 'search', query, sourceHint: '', channelHint: '' };
  }

  match = text.match(SHORTCUT_RE);
  if (match) {
    const query = sanitizeQuery(match[1] || '');
    const route = shortcutRoute(text.split(/[:：\s]/)[0]);
    if (!query) return { kind: 'latest', sourceHint: route.sourceHint, channelHint: route.channelHint };
    return { kind: 'search', query, sourceHint: route.sourceHint, channelHint: route.channelHint };
  }

  if (!hasList) return null;

  match = text.match(/^第\s*(\d{1,3})\s*页$/);
  if (match) return { kind: 'page', page: Number(match[1]) };
  if (text === '上一页' || text === '下一页') {
    return { kind: 'turn', direction: text === '下一页' ? 1 : -1 };
  }
  match = text.match(/^([1-9]\d{0,2})$/);
  if (match) {
    const index = Number(match[1]);
    if (index >= 1 && index <= 500) return { kind: 'select', index };
  }
  return null;
}
