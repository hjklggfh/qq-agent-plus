export const BOOKSHELF_RE = /^(?:(?:JM|禁漫)\s*书架|本地\s*(?:JM|禁漫|漫画)|(?:JM|禁漫)\s*(?:列表|清单|目录)|(?:查看|看看)?\s*(?:我的)?\s*(?:JM|禁漫)\s*书架)$/iu;
export const UPDATE_RE = /^(?:(?:今日|今天|本日)?\s*(?:更新|日更|新更)|更新\s*JM|JM\s*更新)$/iu;
const CONTROL = /^(暂停下载|继续下载|删除\s*JM)\s*[-_:#：]?\s*(?:JM)?(\d{2,9})$/iu;
const GROUP_ON = /^(?:开启|打开|开通|开放)\s*(?:JM|禁漫)$/iu;
const GROUP_OFF = /^(?:关闭|停用)\s*(?:JM|禁漫)$/iu;

export function parseRankCommand(value) {
  const raw = String(value || '').replace(/@\S+\s*/g, '').trim();
  if (!raw || UPDATE_RE.test(raw)) return null;
  const force = /^(?:刷新|更新|重抓)\s*/iu.test(raw);
  const body = force ? raw.replace(/^(?:刷新|更新|重抓)\s*/iu, '').trim() : raw;
  if (/^(?:(?:今日|今天|本日)\s*(?:的)?\s*(?:JM|禁漫)|(?:JM|禁漫)\s*日榜|日榜\s*(?:JM|禁漫)|今日\s*(?:JM|禁漫)?\s*榜单)$/iu.test(body)) {
    return { kind: 'daily', force };
  }
  if (/^(?:(?:JM|禁漫)\s*周榜|周榜\s*(?:JM|禁漫)|本周\s*(?:JM|禁漫)(?:榜)?)$/iu.test(body)) {
    return { kind: 'weekly', force };
  }
  if (/^(?:(?:JM|禁漫)\s*月榜|月榜\s*(?:JM|禁漫)|本月\s*(?:JM|禁漫)(?:榜)?)$/iu.test(body)) {
    return { kind: 'monthly', force };
  }
  if (/^(?:(?:JM|禁漫)\s*(?:热门|总榜|排行|排行榜)|(?:热门|总榜)\s*(?:JM|禁漫))$/iu.test(body)) {
    return { kind: 'total', force };
  }
  return null;
}

export function classifyJmDirectCommand(value) {
  const text = String(value || '').replace(/@\S+\s*/g, '').trim();
  if (!text) return null;
  if (UPDATE_RE.test(text)) return { tool: 'jm_daily_updates', args: {} };
  const rank = parseRankCommand(text);
  if (rank) return { tool: 'jm_rank', args: rank };
  if (BOOKSHELF_RE.test(text)) return { tool: 'jm_bookshelf', args: {} };
  const control = CONTROL.exec(text);
  if (control) return {
    tool: 'jm_control',
    args: {
      action: control[1].startsWith('暂停') ? 'pause' : control[1].startsWith('继续') ? 'resume' : 'delete',
      album_id: control[2]
    }
  };
  if (GROUP_ON.test(text)) return { tool: 'jm_group_toggle', args: { action: 'on' } };
  if (GROUP_OFF.test(text)) return { tool: 'jm_group_toggle', args: { action: 'off' } };
  if (/^(?:JM|禁漫)\s*(?:群列表|名单)$/iu.test(text)) return { tool: 'jm_group_toggle', args: { action: 'list' } };
  if (/^(?:JM|禁漫)\s*(?:所有群开放|全开)$/iu.test(text)) return { tool: 'jm_group_toggle', args: { action: 'all' } };
  const search = /^(?:JM|禁漫)\s*搜索\s+(.+)$/iu.exec(text);
  if (search) {
    const page = /\s+第\s*(\d+)\s*页$/u.exec(search[1]);
    return { tool: 'jm_search', args: {
      query: (page ? search[1].slice(0, page.index) : search[1]).trim(),
      page: page ? Number(page[1]) : 1
    } };
  }
  const album = /(?:^|[^0-9a-zA-Z])JM[\s\-_:：#]*(\d{2,9})(?!\d)|\/(?:album|photo)\/(\d{2,9})(?!\d)/iu.exec(text);
  if (album) return { tool: 'jm_download_album', args: { album_id: album[1] || album[2] } };
  return null;
}
