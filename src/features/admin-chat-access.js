// 管理员私聊中的会话权限指令。只写已有的会话名单；功能总开关仍在控制台。
import { chatAllowed } from '../core/access.js';

const TARGET = /^(group|private):\d{5,15}$/;
const FEATURES = Object.freeze({
  '海龟汤': { section: 'haiguiTang', field: 'allowedChats' },
  'E站': { section: 'ehentai', field: 'allowedChats' },
  '跑团': { section: 'trpg', field: { group: 'allowedGroups', private: 'allowedPrivate' }, idOnly: true },
  '群游戏': { section: 'groupGame', field: 'chats', kind: 'group' },
  '群日报': { section: 'groupDigest', field: 'chats', kind: 'group' },
  '群搜图': { section: 'imageSearch', field: 'allowedGroups', kind: 'group', idOnly: true }
});
const ALIASES = Object.freeze({ '聊天': '基础聊天', '基础聊天': '基础聊天', 'E-Hentai': 'E站', '搜图': '群搜图', '以图搜图': '群搜图', '禁漫': 'JM' });

export function parseAdminChatAccessCommand(raw) {
  const text = String(raw || '').trim();
  if (!/^\/?功能(?:\s|$)/.test(text)) return null;
  const parts = text.replace(/^\/?功能\s*/, '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length || parts[0] === '帮助') return { action: 'help' };
  if (parts[0] === '列表' && parts.length === 1) return { action: 'list' };
  if (parts[0] === '查看' && parts.length === 2 && TARGET.test(parts[1])) return { action: 'show', target: parts[1] };
  if (['开启', '关闭', '添加', '删除'].includes(parts[0]) && parts.length === 3 && TARGET.test(parts[1])) {
    return { action: ['开启', '添加'].includes(parts[0]) ? 'enable' : 'disable', target: parts[1], feature: ALIASES[parts[2]] || parts[2] };
  }
  return { action: 'invalid' };
}

function featureEntry(cfg, target, name) {
  const meta = FEATURES[name];
  const [kind, id] = target.split(':');
  if (!meta || meta.kind && meta.kind !== kind) return null;
  const field = typeof meta.field === 'string' ? meta.field : meta.field[kind];
  const value = meta.idOnly ? id : target;
  const section = cfg[meta.section] || {};
  return { meta, field, value, allowed: (section[field] || []).map(String).includes(value), global: section.enabled === true };
}

function basicState(cfg, target) {
  const [kind, id] = target.split(':');
  const field = kind === 'group' ? 'groups' : 'private';
  return { field, id, allowed: chatAllowed(target, cfg) };
}

function featureStatus(cfg, target, name) {
  const entry = featureEntry(cfg, target, name);
  if (!entry) return null;
  const owner = String(cfg.admin?.ownerUin || '');
  const authorized = entry.allowed || name === 'E站' && target === `private:${owner}`;
  if (!authorized) return `${name}：未授权`;
  const inactive = [];
  if (!entry.global) inactive.push('全局关闭');
  if (!chatAllowed(target, cfg)) inactive.push('基础聊天关闭');
  return `${name}：已授权${inactive.length ? `（${inactive.join('、')}）` : ''}`;
}

function show(cfg, target, options = {}) {
  const base = basicState(cfg, target);
  const lines = [`${target} 的功能权限`, `基础聊天：${base.allowed ? '已开启' : '已关闭'}`];
  for (const name of Object.keys(FEATURES)) {
    const status = featureStatus(cfg, target, name);
    if (status) lines.push(status);
  }
  if (options.jmChatAllowed) {
    const permitted = options.jmChatAllowed(target);
    const inactive = [];
    if (cfg.jm?.enabled !== true) inactive.push('全局关闭');
    if (!base.allowed) inactive.push('基础聊天关闭');
    lines.push(`JM：${permitted ? '已授权' : '未授权'}${permitted && inactive.length ? `（${inactive.join('、')}）` : ''}`);
  }
  if (target.startsWith('private:')) lines.push('私聊搜图由控制台的全局私聊开关控制。');
  lines.push('其他没有独立会话名单的功能仍由控制台管理。');
  return lines.join('\n');
}

function list(cfg, options = {}) {
  const keys = new Set();
  for (const [kind, field] of [['group', 'groups'], ['private', 'private']]) {
    for (const id of [...(cfg.allow?.[field] || []), ...(cfg.deny?.[field] || [])]) {
      if (/^\d{5,15}$/.test(String(id))) keys.add(`${kind}:${id}`);
    }
  }
  for (const meta of Object.values(FEATURES)) {
    const section = cfg[meta.section] || {};
    for (const kind of ['group', 'private']) {
      if (meta.kind && meta.kind !== kind) continue;
      const field = typeof meta.field === 'string' ? meta.field : meta.field[kind];
      for (const value of section[field] || []) {
        const key = meta.idOnly ? `${kind}:${value}` : String(value);
        if (TARGET.test(key)) keys.add(key);
      }
    }
  }
  for (const key of [...(cfg.jm?.allowedChats || []), ...(cfg.jm?.deniedChats || [])]) {
    if (TARGET.test(key)) keys.add(key);
  }
  for (const id of options.jmConfiguredGroups?.() || []) keys.add(`group:${id}`);
  const all = [...keys].sort();
  return `已配置的会话（${all.length}）：${all.length ? '\n' + all.slice(0, 50).join('\n') : '无'}${all.length > 50 ? '\n仅显示前 50 项；可用「功能 查看 group:群号」查询指定会话。' : ''}${cfg.allowAllWhenEmpty ? '\n当前允许名单为空时可开放同类全部会话；列表无法列出全部会话。' : ''}`;
}

export function executeAdminChatAccessCommand(command, options) {
  if (!command) return null;
  const readConfig = options.getConfig;
  const writeConfig = options.updateConfig;
  const onChange = options.onChange || (() => {});
  const cfg = readConfig();
  const owner = String(cfg.admin?.ownerUin || '');
  if (!owner || String(options.actorId) !== owner) return null;
  if (command.action === 'help' || command.action === 'invalid') {
    return '功能管理指令：\n功能 列表\n功能 查看 group:群号\n功能 查看 private:QQ号\n功能 开启 group:群号 基础聊天/海龟汤/E站/跑团/群游戏/群日报/群搜图/JM\n功能 关闭 group:群号 功能名\n私聊支持基础聊天、海龟汤、E站、跑团、JM；也可用“添加/删除”代替“开启/关闭”。功能总开关仍在控制台。';
  }
  if (command.action === 'list') return list(cfg, options);
  if (command.action === 'show') return show(cfg, command.target, options);
  if (!['enable', 'disable'].includes(command.action)) return '未知功能管理指令。发送「功能」查看用法。';
  const { target, feature } = command;
  const enabled = command.action === 'enable';
  if (feature === '基础聊天') {
    if (target === `private:${owner}` && !enabled) return '不能关闭管理员自己的基础聊天权限。';
    const { field, id, allowed } = basicState(cfg, target);
    if (allowed === enabled) return `${target} 的基础聊天已${enabled ? '开启' : '关闭'}。`;
    const allow = new Set((cfg.allow?.[field] || []).map(String));
    const deny = new Set((cfg.deny?.[field] || []).map(String));
    if (enabled) {
      // 开放模式下空名单意味着“全部允许”；仅移出拒绝名单，避免写入首个
      // 允许项后意外把其他所有会话都关掉。
      if (allow.size || cfg.allowAllWhenEmpty !== true) allow.add(id);
      deny.delete(id);
    }
    else {
      // 若移除最后一个允许项会激活 allowAllWhenEmpty 的“全部开放”，
      // 就保留该项并交给 deny 阻断，避免关一个会话却放开其他会话。
      if (!(cfg.allowAllWhenEmpty === true && allow.size === 1 && allow.has(id))) allow.delete(id);
      deny.add(id);
    }
    writeConfig({ allow: { [field]: [...allow] }, deny: { [field]: [...deny] } });
  } else if (feature === 'JM') {
    if (!options.jmChatAllowed) return 'JM 权限服务暂不可用。';
    if (options.jmChatAllowed(target) === enabled) return `${target} 的JM已${enabled ? '授权' : '取消授权'}。`;
    const allow = new Set((cfg.jm?.allowedChats || []).map(String));
    const deny = new Set((cfg.jm?.deniedChats || []).map(String));
    if (enabled) { allow.add(target); deny.delete(target); }
    else { allow.delete(target); deny.add(target); }
    writeConfig({ jm: { allowedChats: [...allow], deniedChats: [...deny] } });
  } else {
    const entry = featureEntry(cfg, target, feature);
    if (!entry) return `无法为 ${target} 管理「${feature}」。发送「功能」查看支持的功能和会话类型。`;
    if (feature === 'E站' && target === `private:${owner}` && !enabled) return 'E站对管理员私聊固定开放，不能单独关闭；可在控制台关闭 E站总开关。';
    if (entry.allowed === enabled) return `${target} 的${feature}已${enabled ? '授权' : '取消授权'}。`;
    const values = new Set((cfg[entry.meta.section]?.[entry.field] || []).map(String));
    if (enabled) values.add(entry.value); else values.delete(entry.value);
    writeConfig({ [entry.meta.section]: { [entry.field]: [...values] } });
  }
  onChange(feature, target);
  return `${target} 的${feature}已${enabled ? '开启' : '关闭'}。\n${show(readConfig(), target, options)}`;
}
