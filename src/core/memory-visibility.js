// 记忆可见性策略（改进方案 #13，施工图见方案附录 J.6.4）。
// 默认 global + 不隐藏 = 与历史行为**逐字一致**（升级零行为变化）；切换必须由运营者显式改配置。
//   memory.visibility.mode = 'global' | 'perChat'
//     perChat：只保留"来源含当前会话"的印象（sourceChatKeys 是印象级字段，按条过滤）
//   memory.visibility.hidePrivateInGroup = true
//     群聊里剔除"来源含 private:<QQ>"的印象（私聊印象不在群里露出来）
import { getConfig } from './config.js';

/** 读到归一化后的策略（非法/缺失值一律回落到默认，绝不因坏配置改变行为）。 */
export function memoryVisibilityOf(cfg = getConfig()) {
  const v = cfg?.memory?.visibility || {};
  return {
    mode: cfg.memory?.crossChat?.privacy === true || v.mode === 'perChat' ? 'perChat' : 'global',
    ...(cfg.memory?.crossChat?.privacy === true ? { strictChat: true } : {}),
    ...(Object.keys(cfg.memory?.crossChat?.chats || {}).length ? { chatRules: cfg.memory.crossChat.chats } : {}),
    hidePrivateInGroup: v.hidePrivateInGroup === true
  };
}

/** 单条印象对当前 chatKey 是否可见。 */
export function impressionVisible(entry, chatKey, vis = memoryVisibilityOf()) {
  const sources = Array.isArray(entry?.sourceChatKeys) ? entry.sourceChatKeys.map(String) : [];
  const key = String(chatKey || '');
  const rule = vis.chatRules?.[key] || {};
  if ((vis.strictChat || rule.privacy === true || rule.allowTarget === false) && (!sources.length || sources.some(source => source !== key))) return false;
  if (sources.some(source => source !== key && (vis.chatRules?.[source]?.allowSource === false || vis.chatRules?.[source]?.privacy === true))) return false;
  if (vis.mode === 'perChat' && !sources.includes(key)) return false;
  if (vis.hidePrivateInGroup && key.startsWith('group:') && sources.some((k) => k.startsWith('private:'))) return false;
  return true;
}

/** 过滤一个成员的印象列表（返回新数组；调用方拿到的是 store 的克隆，原地赋回也安全）。 */
export function visibleImpressions(impressions, chatKey, vis = memoryVisibilityOf()) {
  const list = Array.isArray(impressions) ? impressions : [];
  return list.filter((e) => impressionVisible(e, chatKey, vis));
}
