const TODAY = /^(?:今日\s*JM|JM\s*(?:列表|清单|目录))$/iu;
const UPDATE = /^(?:(?:今日|今天)?\s*(?:更新|日更|新更)|更新\s*JM|JM\s*更新)$/iu;
const CONTROL = /^(暂停下载|继续下载|删除\s*JM)\s*[-_:#：]?\s*(?:JM)?(\d{2,9})$/iu;
const GROUP_ON = /^(?:开启|打开|开通|开放)\s*(?:JM|禁漫)$/iu;
const GROUP_OFF = /^(?:关闭|停用)\s*(?:JM|禁漫)$/iu;

export function classifyJmDirectCommand(value) {
  const text = String(value || '').replace(/@\S+\s*/g, '').trim();
  if (!text) return null;
  if (TODAY.test(text)) return { tool: 'jm_today_list', args: {} };
  if (UPDATE.test(text)) return { tool: 'jm_daily_updates', args: {} };
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
  const album = /(?:^|[^0-9a-zA-Z])JM[\s\-_:：#]*(\d{2,9})(?!\d)|\/(?:album|photo)\/(\d{2,9})(?!\d)/iu.exec(text);
  if (album) return { tool: 'jm_download_album', args: { album_id: album[1] || album[2] } };
  return null;
}
