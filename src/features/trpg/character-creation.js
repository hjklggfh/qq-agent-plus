import { randomUUID } from 'node:crypto';
import { PATHWAYS, BUILD_STYLES, TACTICAL_RULESET, pathwayOf } from './catalog.js';
import { integer, shortText } from './combat.js';
import { tactical, createPlayer } from './adventure.js';
import { validateAllocation, validateAllocatedAttributes, parseAllocation, allocationPanel } from './attribute-allocation.js';

const plain = (v) => v && typeof v === 'object' && !Array.isArray(v);
const wizardKey = (chatKey, userId) => `${chatKey}|${userId}`;

export function validateCharacterCreation(input) {
  if (!plain(input)) throw new Error('characterCreation必须是建角配置对象');
  const allowed = ['prompt', 'roles', 'backgroundPrompt', 'hp', 'inventory', 'attributePresets', 'attributeAllocation'];
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw new Error('建角配置含未知字段');
  const out = {};
  for (const key of ['prompt', 'backgroundPrompt']) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== 'string' || input[key].trim().length > 1200) throw new Error('建角说明最多1200字');
      out[key] = input[key].trim();
    }
  }
  for (const [key, maxLength] of [['roles', 60], ['inventory', 120]]) {
    if (input[key] !== undefined) {
      if (!Array.isArray(input[key]) || input[key].length > 30) throw new Error(`${key}最多30项`);
      out[key] = input[key].map((v) => shortText(v, maxLength, key));
      if (key === 'roles' && new Set(out[key]).size !== out[key].length) throw new Error('职业/身份选项不能重复');
    }
  }
  if (input.hp !== undefined) out.hp = integer(input.hp, 1, 1000, '建角初始HP');
  if (input.attributeAllocation !== undefined) out.attributeAllocation = input.attributeAllocation === null ? null : validateAllocation(input.attributeAllocation);
  if (out.attributeAllocation && input.attributePresets !== undefined) throw new Error('自由加点与固定属性方案不能同时配置');
  if (input.attributePresets !== undefined) {
    if (!Array.isArray(input.attributePresets) || input.attributePresets.length < 1 || input.attributePresets.length > 6) throw new Error('属性方案需1—6项');
    out.attributePresets = input.attributePresets.map((p) => {
      if (!plain(p) || Object.keys(p).some((k) => !['name', 'attributes'].includes(k)) || !plain(p.attributes) || Object.keys(p.attributes).length < 1 || Object.keys(p.attributes).length > 12) throw new Error('属性方案需名称和1—12个属性');
      const entries = Object.entries(p.attributes).map(([key, v]) => {
        const name = shortText(key, 20, '属性名');
        if (['__proto__', 'constructor', 'prototype'].includes(name)) throw new Error('无效属性名');
        return [name, integer(v, -5, 10, '属性修正')];
      });
      if (new Set(entries.map(([key]) => key)).size !== entries.length) throw new Error('属性名不能重复');
      return { name: shortText(p.name, 40, '属性方案名'), attributes: Object.fromEntries(entries) };
    });
  }
  return out;
}

export function characterProfile(world) {
  const profile = validateCharacterCreation(world.characterCreation || {});
  // Compatibility for the user's existing Linjiang card, whose rule was confirmed
  // in chat but never stored as structured data. Explicit world settings win.
  const oldGlobalPresets = JSON.stringify(profile.attributePresets) === JSON.stringify(BUILD_STYLES);
  if (world.ruleset !== TACTICAL_RULESET && !Object.hasOwn(profile, 'attributeAllocation') && (!profile.attributePresets || oldGlobalPresets)
    && String(world.name).includes('临江最后一日') && String(world.name).includes('万佳福')) {
    delete profile.attributePresets;
    profile.attributeAllocation = { attributes: ['力量', '敏捷', '防御'], points: 10, min: 0, max: 10 };
  }
  return profile;
}

export function validateWorldAttributes(c, attributes) {
  if (tactical(c)) return;
  const rule = characterProfile(c.world).attributeAllocation;
  if (rule) validateAllocatedAttributes(attributes, rule);
}

export function hasWizard(data, chatKey, userId) { return Boolean(data.wizards?.[wizardKey(chatKey, userId)]); }
export function clearWizards(data, chatKey) {
  for (const key of Object.keys(data.wizards || {})) if (key.startsWith(`${chatKey}|`)) delete data.wizards[key];
}
function creationProblem(c, userId, maxPlayers) {
  if (!c) return '请先 /跑团 开团 世界ID，建角将使用当前世界的设定';
  if (c.players.some((p) => p.userId === userId)) return '你已经加入当前战役，不会替换已有角色';
  if (c.status !== 'recruiting' && !(tactical(c) && c.status === 'paused' && c.combat?.status !== 'active')) return '请在待开始的战役中建角；诡秘战术团也可在非战斗暂停期间建角';
  if (c.players.length >= maxPlayers) return '本团人数已满';
  return '';
}
function sameWorld(w, c) {
  return Boolean(c && w.campaignId === c.id && w.worldId === c.world.id && w.ruleset === (tactical(c) ? TACTICAL_RULESET : 'narrative'));
}
function newWizard(c) {
  const lotm = tactical(c);
  return { campaignId: c.id, worldId: c.world.id, ruleset: lotm ? TACTICAL_RULESET : 'narrative',
    stage: lotm ? 'pathway' : 'role', page: 0, profile: lotm ? {} : characterProfile(c.world) };
}
function stylesOf(w) { return w.ruleset === TACTICAL_RULESET ? BUILD_STYLES : w.profile.attributePresets || []; }
function upgradeAttributeStep(w, c) {
  if (tactical(c)) return false;
  const profile = characterProfile(c.world);
  if (JSON.stringify(w.profile) === JSON.stringify(profile)) return false;
  w.profile = profile;
  if (['style', 'allocation', 'confirm'].includes(w.stage)) {
    delete w.style; delete w.attributes;
    w.stage = profile.attributeAllocation ? 'allocation' : profile.attributePresets ? 'style' : 'confirm';
  }
  return true;
}
function rolePanel(w, c) {
  const options = w.stage === 'pathway' ? PATHWAYS.map((p) => `${p.name}·${p.sequences[0].name}`) : w.profile.roles || [];
  const hint = w.stage === 'pathway' ? '' : `${w.profile.prompt || '请按本世界设定选择职业或身份。'}\n`;
  if (!options.length) return `【自建角色·职业/身份】《${c.world.name}》\n${hint}${c.world.opening ? '开场：' + c.world.opening.slice(0, 500) + '\n' : ''}请输入职业或身份（最多60字）；0取消。`;
  const pages = Math.ceil(options.length / 6);
  return `【自建角色·选择${w.stage === 'pathway' ? '途径' : '职业/身份'} ${w.page + 1}/${pages}】《${c.world.name}》\n${hint}`
    + options.slice(w.page * 6, w.page * 6 + 6).map((name, i) => `${i + 1}. ${name}`).join('\n')
    + (pages > 1 ? '\n7. 下一页\n8. 上一页' : '') + (w.stage === 'role' ? '\n9. 自填其他职业/身份' : '') + '\n0. 取消建角';
}
function wizardPanel(w, c) {
  if (['pathway', 'role'].includes(w.stage)) return rolePanel(w, c);
  if (w.stage === 'customRole') return `《${c.world.name}》请输入符合世界设定的职业或身份（最多60字）；0取消。`;
  const identity = w.pathway ? `${pathwayOf(w.pathway).name}，从序列9起步` : w.role;
  if (w.stage === 'name') return `《${c.world.name}》已选${identity}。\n请输入角色姓名（最多60字）；0取消。`;
  if (w.stage === 'background') return `《${c.world.name}》\n${w.profile.backgroundPrompt || '请输入性格、经历、冒险目标，以及与队伍或NPC的联系'}（最多1200字）；0取消。`;
  if (w.stage === 'allocation') return `《${c.world.name}》\n${allocationPanel(w.profile.attributeAllocation)}`;
  const styles = stylesOf(w);
  if (w.stage === 'style') return `【选择属性方案】\n${styles.map((s, i) => `${i + 1}. ${s.name}：${Object.entries(s.attributes).map(([k, v]) => k + v).join('、')}`).join('\n')}\n0. 取消建角`;
  const initial = w.pathway ? 'HP10/灵性6，普通职业工具、提灯、绷带各一' : `HP${w.profile.hp ?? 10}，初始物品：${(w.profile.inventory || []).join('、') || '无'}`;
  const attributes = w.attributes || styles[w.style]?.attributes || {};
  const mode = w.profile.attributeAllocation ? `自由分配${w.profile.attributeAllocation.points}点` : styles[w.style]?.name || '本世界未设置数值属性';
  return `【确认角色】《${c.world.name}》\n${w.name} · ${identity}\n${w.background}\n${mode}：${Object.entries(attributes).map(([k, v]) => k + v).join('、') || '无'}；${initial}。\n1. ${w.reallocate ? '确认更新本人属性' : '确认创建并加入当前战役'}\n2. ${w.reallocate ? '重新加点' : `重新选择${w.pathway ? '途径' : '职业/身份'}`}${w.profile.attributeAllocation ? '\n3. 重新分配属性' : ''}\n0. 取消`;
}

export function startWizard(data, chatKey, userId, c, maxPlayers) {
  const problem = creationProblem(c, userId, maxPlayers);
  if (problem) throw new Error(problem);
  data.wizards ||= {};
  if (Object.keys(data.wizards).length >= 300 && !hasWizard(data, chatKey, userId)) throw new Error('建角草稿已满，请清理旧草稿');
  const key = wizardKey(chatKey, userId), old = data.wizards[key];
  if (!old || !sameWorld(old, c)) data.wizards[key] = newWizard(c);
  else upgradeAttributeStep(old, c);
  return { reply: (old && !sameWorld(old, c) ? '旧草稿不属于当前战役，已按当前世界重新开始建角。\n' : '') + wizardPanel(data.wizards[key], c) };
}

export function startReallocation(data, chatKey, userId, c) {
  if (!c || tactical(c) || !['recruiting', 'paused'].includes(c.status)) throw new Error('重新加点仅用于待开始或已暂停的通用叙事团');
  const p = c.players.find((p) => p.userId === userId);
  if (!p) throw new Error('你还未加入，请先 /跑团 建角');
  const profile = characterProfile(c.world);
  if (!profile.attributeAllocation) throw new Error('本世界未设置自由加点规则，请先由团主设置');
  const w = { ...newWizard(c), stage: 'allocation', reallocate: true, characterId: p.character.id,
    name: p.character.name, role: '已入团角色', background: p.character.description };
  data.wizards ||= {}; data.wizards[wizardKey(chatKey, userId)] = w;
  return { reply: `保留人物、HP与物品，只重新分配本人属性。\n${wizardPanel(w, c)}` };
}
export function wizardInput(data, chatKey, userId, raw, c, maxPlayers) {
  const key = wizardKey(chatKey, userId), w = data.wizards[key], value = String(raw).trim();
  if (value === '0' || value === '/跑团 取消建角') { delete data.wizards[key]; return { reply: '建角已取消，已有角色与存档保留。' }; }
  let problem = creationProblem(c, userId, maxPlayers);
  if (w.reallocate) problem = !c || tactical(c) || !['recruiting', 'paused'].includes(c.status) || !c.players.some((p) => p.userId === userId && p.character.id === w.characterId) ? '当前角色或战役状态不允许重新加点' : '';
  if (problem) { delete data.wizards[key]; return { reply: `建角草稿已停止：${problem}。` }; }
  if (!sameWorld(w, c)) return startWizard(data, chatKey, userId, c, maxPlayers);
  if (upgradeAttributeStep(w, c)) return { reply: `已同步本世界属性规则，保留姓名与背景，请核对后继续。\n${wizardPanel(w, c)}` };
  if (!tactical(c) && w.stage === 'style' && !stylesOf(w).length) { w.stage = w.profile.attributeAllocation ? 'allocation' : 'confirm'; return { reply: wizardPanel(w, c) }; }
  if (['pathway', 'role'].includes(w.stage) && (w.stage === 'pathway' || w.profile.roles?.length)) {
    const options = w.stage === 'pathway' ? PATHWAYS : w.profile.roles, n = Number(value), pages = Math.ceil(options.length / 6);
    if ((n === 7 || n === 8) && pages > 1) w.page = (w.page + (n === 7 ? 1 : pages - 1)) % pages;
    else if (n === 9 && w.stage === 'role') w.stage = 'customRole';
    else {
      const choice = options[w.page * 6 + integer(n, 1, 6, '选项序号') - 1];
      if (!choice) throw new Error('该页没有这个序号');
      if (w.stage === 'pathway') w.pathway = choice.id; else w.role = choice;
      w.stage = 'name';
    }
  } else if (['role', 'customRole'].includes(w.stage)) {
    if (/^\d+$/.test(value)) throw new Error('请输入职业或身份文字，或回复0取消');
    w.role = shortText(value, 60, '职业/身份'); w.stage = 'name';
  } else if (w.stage === 'name') { w.name = shortText(value, 60, '角色名'); w.stage = 'background'; }
  else if (w.stage === 'background') { w.background = shortText(value, 1200, '背景'); w.stage = w.profile.attributeAllocation ? 'allocation' : stylesOf(w).length ? 'style' : 'confirm'; }
  else if (w.stage === 'allocation') { w.attributes = parseAllocation(value, w.profile.attributeAllocation); w.stage = 'confirm'; }
  else if (w.stage === 'style') { w.style = integer(Number(value), 1, stylesOf(w).length, '方案') - 1; w.stage = 'confirm'; }
  else if ((value === '3' && w.profile.attributeAllocation) || (value === '2' && w.reallocate)) { delete w.attributes; w.stage = 'allocation'; }
  else if (value === '2') { data.wizards[key] = newWizard(c); }
  else if (value === '1') {
    const attributes = structuredClone(w.attributes || stylesOf(w)[w.style]?.attributes || {});
    validateWorldAttributes(c, attributes);
    if (w.reallocate) {
      const p = c.players.find((p) => p.userId === userId);
      p.character.attributes = attributes;
      const card = data.characters.find((a) => a.id === w.characterId && a.ownerId === userId && a.scope === chatKey);
      if (card) card.attributes = structuredClone(attributes);
      delete data.wizards[key];
      return { reply: `已更新${p.character.name}的属性：${Object.entries(attributes).map(([k, v]) => k + v).join('、')}。` };
    }
    if (data.characters.length >= 200) throw new Error('角色卡已满');
    const card = { id: randomUUID().slice(0, 8), scope: chatKey, ownerId: userId, name: w.name,
      description: w.pathway ? w.background : `职业/身份：${w.role}\n${w.background}`, hp: w.profile.hp ?? 10,
      attributes, inventory: structuredClone(w.pathway ? ['普通职业工具', '提灯', '绷带'] : w.profile.inventory || []),
      ...(w.pathway ? { pathway: w.pathway, sequence: 9 } : {}) };
    data.characters.push(card);
    c.players.push(w.pathway ? createPlayer(card, userId) : { userId, character: structuredClone(card), hp: card.hp, inventory: structuredClone(card.inventory), condition: '' });
    delete data.wizards[key];
    return { reply: `已创建${card.name}，角色ID ${card.id}。已加入《${c.world.name}》，等待团主开始或继续。` };
  } else throw new Error('请回复1确认、2重选或0取消');
  return { reply: wizardPanel(data.wizards[key], c) };
}
