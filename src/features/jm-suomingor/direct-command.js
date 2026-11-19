export const BOOKSHELF_RE = /^(?:(?:JM|禁漫)\s*书架|本地\s*(?:JM|禁漫|漫画)|(?:JM|禁漫)\s*(?:列表|清单|目录)|(?:查看|看看)?\s*(?:我的)?\s*(?:JM|禁漫)\s*书架)$/iu;
export const UPDATE_RE = /^(?:(?:今日|今天|本日)?\s*(?:更新|日更|新更)\s*(?:JM|禁漫)?|更新\s*(?:JM|禁漫)|(?:JM|禁漫)\s*更新)$/iu;
export const HELP_RE = /^(?:JM|禁漫)(?:\s*(?:帮助|指令|菜单|命令|功能|help|\?|？))?$/iu;
const STATUS_RE = /^(?:(?:JM|禁漫)\s*(?:进度|状态|任务|下载进度)|查看\s*(?:JM|禁漫)\s*进度)$/iu;
const LIBRARY_RE = /^(?:(?:JM|禁漫)\s*收藏|本地\s*(?:JM|禁漫)?\s*收藏)$/iu;
const STORAGE_RE = /^(?:(?:JM|禁漫)\s*(?:空间|存储|配额|磁盘)|(?:JM|禁漫)\s*支持\s*PDF)$/iu;
const CONTROL = /^(暂停下载|继续下载|删除\s*JM)\s*[-_:#：]?\s*(?:JM)?(\d{2,9})$/iu;
const GROUP_ON = /^(?:开启|打开|开通|开放)\s*(?:JM|禁漫)$/iu;
const GROUP_OFF = /^(?:关闭|停用)\s*(?:JM|禁漫)$/iu;

/**
 * 判断该直通工具在当前会话未开启 JM 白名单时，是否应静默跳过（不拦截正常闲聊）。
 */
export function isSilentWhenChatDenied(toolName) {
  return toolName === 'jm_help'
    || toolName === 'jm_task_status'
    || toolName === 'jm_library'
    || toolName === 'jm_storage';
}

function matchRankKind(body) {
  const text = String(body || '').trim();
  if (/^(?:(?:今日|今天|本日)\s*(?:的)?\s*(?:JM|禁漫)|(?:JM|禁漫)\s*日榜|日榜\s*(?:JM|禁漫)|今日\s*(?:JM|禁漫)?\s*榜单|今日同人(?:JM|禁漫)?|同人日榜)$/iu.test(text)) {
    return 'daily';
  }
  if (/^(?:(?:JM|禁漫)\s*周榜|周榜\s*(?:JM|禁漫)|本周\s*(?:JM|禁漫)(?:榜)?|同人周榜)$/iu.test(text)) {
    return 'weekly';
  }
  if (/^(?:(?:JM|禁漫)\s*月榜|月榜\s*(?:JM|禁漫)|本月\s*(?:JM|禁漫)(?:榜)?|同人月榜)$/iu.test(text)) {
    return 'monthly';
  }
  if (/^(?:(?:JM|禁漫)\s*(?:热门|总榜|排行|排行榜)|(?:热门|总榜)\s*(?:JM|禁漫)|同人(?:热门|总榜))$/iu.test(text)) {
    return 'total';
  }
  return '';
}

export function parseRankCommand(value) {
  const raw = String(value || '').replace(/@\S+\s*/g, '').trim();
  if (!raw || UPDATE_RE.test(raw)) return null;
  const force = /^(?:刷新|更新|重抓)\s*/iu.test(raw);
  let body = force ? raw.replace(/^(?:刷新|更新|重抓)\s*/iu, '').trim() : raw;
  let topN;
  const countMatch = body.match(/^(.*?)\s+(\d{1,2})$/u);
  if (countMatch) {
    const n = Number(countMatch[2]);
    if (Number.isInteger(n) && n >= 4 && n <= 60) {
      topN = n;
      body = countMatch[1].trim();
    }
  }
  let category = 'all';
  if (/同人/u.test(body)) {
    category = 'doujin';
    body = body.replace(/\s*同人\s*/gu, ' ').replace(/\s+/g, ' ').trim();
    // 兼容「今日JM 同人」「JM日榜 同人」「JM 同人 日榜」「同人日榜」
    if (/^(?:JM|禁漫)?\s*日榜$/iu.test(body) || /^(?:今日|今天|本日)\s*(?:JM|禁漫)?$/iu.test(body)) {
      return { kind: 'daily', category, force, ...(topN ? { topN } : {}) };
    }
    if (/^(?:JM|禁漫)?\s*周榜$/iu.test(body) || /^本周\s*(?:JM|禁漫)?$/iu.test(body)) {
      return { kind: 'weekly', category, force, ...(topN ? { topN } : {}) };
    }
    if (/^(?:JM|禁漫)?\s*月榜$/iu.test(body) || /^本月\s*(?:JM|禁漫)?$/iu.test(body)) {
      return { kind: 'monthly', category, force, ...(topN ? { topN } : {}) };
    }
    if (/^(?:JM|禁漫)?\s*(?:热门|总榜|排行|排行榜)$/iu.test(body)) {
      return { kind: 'total', category, force, ...(topN ? { topN } : {}) };
    }
  }
  const kind = matchRankKind(body);
  if (kind) return { kind, category, force, ...(topN ? { topN } : {}) };
  return null;
}

export function classifyJmDirectCommand(value) {
  const text = String(value || '').replace(/@\S+\s*/g, '').trim();
  if (!text) return null;
  if (UPDATE_RE.test(text)) return { tool: 'jm_daily_updates', args: {} };
  const rank = parseRankCommand(text);
  if (rank) return { tool: 'jm_rank', args: rank };
  if (BOOKSHELF_RE.test(text)) return { tool: 'jm_bookshelf', args: {} };
  if (STATUS_RE.test(text)) return { tool: 'jm_task_status', args: {} };
  if (LIBRARY_RE.test(text)) return { tool: 'jm_library', args: {} };
  if (STORAGE_RE.test(text)) return { tool: 'jm_storage', args: {} };
  if (HELP_RE.test(text)) return { tool: 'jm_help', args: {} };
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
