import { randomInt } from 'node:crypto';
import { abilitiesOf, limitsOf } from './catalog.js';

export function integer(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label}必须为${min}—${max}整数`);
  return value;
}
export function shortText(value, max, label) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new Error(`${label}需为1—${max}字`);
  return value.trim();
}
export function drawDice(sides = 20, rng = randomInt) {
  const draw = rng;
  return draw(1, sides + 1);
}
const distance = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const key = (p) => `${p.x},${p.y}`;
export const coordinate = (p) => `${String.fromCharCode(65 + p.x)}${p.y + 1}`;
export function position(value, board) {
  let p = value;
  if (typeof value === 'string') {
    const m = /^([A-L])(1[0-2]|[1-9])$/i.exec(value.trim());
    if (!m) throw new Error('坐标示例A1、C4');
    p = { x: m[1].toUpperCase().charCodeAt(0) - 65, y: Number(m[2]) - 1 };
  }
  if (!p || typeof p !== 'object') throw new Error('位置必须是坐标');
  return { x: integer(p.x, 0, board.width - 1, '横坐标'), y: integer(p.y, 0, board.height - 1, '纵坐标') };
}
function wall(board, p) {
  return board.walls.some((v) => key(v) === key(p)) || board.objects.some((v) => v.kind === 'door' && !v.used && key(v.at) === key(p));
}
function occupied(board, p, except = '') { return board.units.some((u) => u.id !== except && !u.escaped && u.hp > 0 && key(u.at) === key(p)); }
function walkable(board, p, except = '') {
  return p.x >= 0 && p.y >= 0 && p.x < board.width && p.y < board.height && !wall(board, p) && !occupied(board, p, except);
}
function neighbours(p) { return [{ x: p.x + 1, y: p.y }, { x: p.x - 1, y: p.y }, { x: p.x, y: p.y + 1 }, { x: p.x, y: p.y - 1 }]; }

export function pathTo(board, unit, target, max = 144) {
  if (key(unit.at) === key(target)) return [];
  const queue = [{ at: unit.at, path: [], cost: 0 }], seen = new Map([[key(unit.at), 0]]);
  while (queue.length) {
    queue.sort((a, b) => a.cost - b.cost);
    const item = queue.shift();
    if (key(item.at) === key(target)) return item.path;
    if (item.cost >= max) continue;
    for (const at of neighbours(item.at)) {
      if (!walkable(board, at, unit.id)) continue;
      const cost = item.cost + (board.hazards.some((h) => h.slow && key(h.at) === key(at)) ? 2 : 1);
      if (cost > max || (seen.get(key(at)) ?? Infinity) <= cost) continue;
      seen.set(key(at), cost);
      const next = [...item.path, at];
      queue.push({ at, path: next, cost });
    }
  }
  return null;
}

export function lineOfSight(board, from, to) {
  let x = from.x, y = from.y;
  const dx = Math.abs(to.x - x), dy = Math.abs(to.y - y);
  const sx = x < to.x ? 1 : -1, sy = y < to.y ? 1 : -1;
  let error = dx - dy;
  while (x !== to.x || y !== to.y) {
    const twice = error * 2;
    const old = { x, y };
    if (twice > -dy) { error -= dy; x += sx; }
    if (twice < dx) { error += dx; y += sy; }
    if (x !== old.x && y !== old.y && wall(board, { x, y: old.y }) && wall(board, { x: old.x, y })) return false;
    if (wall(board, { x, y })) return false;
  }
  return true;
}

function effects(unit, type) { return Math.max(0, ...(unit.effects || []).filter((e) => e.type === type).map((e) => e.value)); }
function putEffect(unit, type, value = 2, duration = 1) {
  unit.effects = (unit.effects || []).filter((e) => e.type !== type);
  unit.effects.push({ type, value, expires: unit.turns + duration });
}
function active(board) { return board.units.find((u) => u.id === board.order[board.cursor]); }
export function currentUnit(campaign) { return campaign.combat?.status === 'active' ? active(campaign.combat) : null; }
function playerOf(c, unit) { return c.players.find((p) => p.userId === unit.userId); }
function sync(c) {
  for (const u of c.combat.units.filter((u) => u.side === 'players')) {
    const p = playerOf(c, u);
    p.hp = u.hp;
  }
}
function endIfDone(c) {
  const b = c.combat;
  if (!b.units.some((u) => u.side === 'enemies' && u.hp > 0)) { b.status = 'won'; c.phase = 'exploration'; }
  else if (!b.units.some((u) => u.side === 'players' && !u.escaped && u.hp > 0)) { b.status = b.units.some((u) => u.escaped) ? 'retreated' : 'defeated'; c.phase = 'exploration'; c.safe = false; }
  sync(c);
  return b.status !== 'active';
}

export function startCombat(c, input, rng = randomInt) {
  if (c.combat?.status === 'active') throw new Error('已有战斗，不能重新生成敌人或重置回合');
  if (!c.players.some((p) => !p.away && p.hp > 0)) throw new Error('没有可行动玩家');
  const width = integer(input.width ?? 8, 4, 12, '战场宽'), height = integer(input.height ?? 8, 6, 12, '战场高');
  const b = { width, height, round: 1, cursor: 0, order: [], status: 'active', walls: [], cover: [], hazards: [], objects: [], units: [], supports: [], log: [] };
  for (const [field, max] of [['walls', 60], ['cover', 40], ['hazards', 20], ['objects', 20]]) {
    const rows = input[field] ?? [];
    if (!Array.isArray(rows) || rows.length > max) throw new Error(`战场${field}超限`);
    b[field] = rows.map((v, index) => {
      const at = position(field === 'walls' ? v : v.at, b);
      if (field === 'walls') return at;
      if (field === 'cover') return { at, value: integer(v.value ?? 1, 1, 2, '掩体等级') };
      if (field === 'hazards') return { at, damage: integer(v.damage ?? 1, 1, 3, '地形伤害'), slow: v.slow === true, label: shortText(v.label || '危险地形', 30, '地形名') };
      if (!['door', 'lamp', 'rescue', 'barrier'].includes(v.kind)) throw new Error('互动类型只允许door/lamp/rescue/barrier');
      return { id: `object-${index + 1}`, at, kind: v.kind, used: false, label: shortText(v.label, 30, '互动物名') };
    });
  }
  if (input.players !== undefined && (!Array.isArray(input.players) || input.players.length > 6 || input.players.some((p) => !c.players.some((v) => !v.away && v.userId === p.userId)))) throw new Error('玩家位置需属于实际在队玩家');
  for (const p of c.players.filter((p) => !p.away)) {
    const supplied = (input.players || []).find((v) => v.userId === p.userId);
    const at = position(supplied?.at ?? { x: 0, y: b.units.length }, b);
    if (!walkable(b, at)) throw new Error('玩家出生位置被占用或阻挡');
    b.units.push({ id: `p:${p.userId}`, userId: p.userId, side: 'players', name: p.character.name,
      at, hp: p.hp, maxHp: limitsOf(p).hp, defense: 10 + Math.max(0, p.character.attributes.敏捷 || 0),
      move: 3, remaining: 3, main: 1, bonus: 1, turns: 0, effects: [], initiative: drawDice(20, rng) + (p.character.attributes.敏捷 || 0) });
  }
  if (!Array.isArray(input.enemies) || input.enemies.length < 1 || input.enemies.length > 10) throw new Error('敌人数需1—10');
  for (const [index, e] of input.enemies.entries()) {
    const at = position(e.at ?? { x: width - 1, y: index }, b);
    if (!walkable(b, at)) throw new Error('敌人出生位置被占用或阻挡');
    const hp = integer(e.hp ?? 8, 1, 40, '敌人HP');
    b.units.push({ id: `e:${index + 1}`, side: 'enemies', name: shortText(e.name, 30, '敌人名'), at, hp, maxHp: hp,
      defense: integer(e.defense ?? 11, 8, 18, '敌人防护'), attack: integer(e.attack ?? 1, -1, 5, '敌人攻击修正'),
      damage: integer(e.damage ?? 2, 1, 5, '敌人伤害'), range: integer(e.range ?? 1, 1, 5, '敌人射程'),
      move: integer(e.move ?? 3, 1, 5, '敌人移动'), remaining: 3, main: 1, bonus: 0,
      spiritOnly: e.spiritOnly === true, turns: 0, effects: [], initiative: drawDice(20, rng) + (e.attack ?? 1) });
  }
  b.order = [...b.units].sort((a, d) => d.initiative - a.initiative || a.id.localeCompare(d.id)).map((u) => u.id);
  c.combat = b; c.phase = 'combat'; c.safe = false; c.choices = {}; c.intents = {};
  advanceEnemies(c, rng);
  return combatPanel(c);
}

function getActor(c, userId) {
  const b = c.combat, u = currentUnit(c);
  if (!u || u.userId !== userId || u.hp <= 0 || u.escaped) throw new Error('还没轮到你或角色已倒地/撤离，请等待当前行动者');
  return { b, u, p: playerOf(c, u) };
}
function spendAction(u, type) {
  const field = type === '辅助' ? 'bonus' : 'main';
  if (u[field] < 1) throw new Error(`本回合${type}行动已用完`);
  u[field]--;
}
function consumeSpirit(p, cost) {
  if (!p.progress || p.progress.spirit < cost || p.progress.pollution >= 6) throw new Error('灵性不足或处于失控状态');
  p.progress.spirit -= cost;
  p.progress.overuse++;
  if (p.progress.overuse > 3) p.progress.pollution = Math.min(6, p.progress.pollution + 1);
}
function validTarget(b, u, targetId, range, allowDown = false) {
  const target = b.units.find((e) => !e.escaped && e.id === targetId && (e.hp > 0 || allowDown && e.side === u.side));
  if (!target || distance(u.at, target.at) > range || !lineOfSight(b, u.at, target.at)) throw new Error('目标无效、超出距离或视线被阻挡');
  return target;
}
function attack(c, u, target, bonus, power, spiritual, rng) {
  const b = c.combat;
  if (u.side === target.side) throw new Error('直接攻击不允许伤害队友；范围技能需明确确认友伤');
  if (target.spiritOnly && !spiritual) throw new Error('该影体免疫普通武器，请换用灵性手段或环境互动');
  const roll = drawDice(20, rng);
  const support = b.supports.some((s) => s.side === u.side && distance(s.at, u.at) <= 2) ? 2 : 0;
  const cover = b.cover.find((v) => key(v.at) === key(target.at))?.value || 0;
  const boost = Math.max(effects(u, 'buff'), effects(target, 'marked'), effects(u, 'hidden'), support);
  u.effects = u.effects.filter((v) => !['buff', 'hidden'].includes(v.type));
  target.effects = target.effects.filter((v) => v.type !== 'marked');
  const total = roll + bonus + boost, defense = target.defense + cover * 2 + effects(target, 'ward');
  const hit = total >= defense;
  const damage = hit ? u.side === 'enemies' ? u.damage : drawDice(4, rng) + power : 0;
  target.hp = Math.max(0, target.hp - damage);
  b.lastAttack = { effect: spiritual ? 'ranged' : 'strike', damage, source: u.id };
  return `${u.name}→${target.name}：d20=${roll}，合计${total} 对防护${defense}，${hit ? `命中，伤害${damage}` : '未命中'}`;
}
function hurtGround(b, u) {
  const h = b.hazards.find((v) => key(v.at) === key(u.at));
  if (!h) return '';
  u.hp = Math.max(0, u.hp - h.damage);
  if (h.once) b.hazards.splice(b.hazards.indexOf(h), 1);
  return `；${h.label}造成${h.damage}伤害`;
}
function move(c, u, target) {
  const b = c.combat, steps = pathTo(b, u, target, u.remaining);
  if (!steps) throw new Error('没有可行路线或超过剩余移动');
  const cost = steps.reduce((n, at) => n + (b.hazards.some((h) => h.slow && key(h.at) === key(at)) ? 2 : 1), 0);
  if (cost > u.remaining) throw new Error('危险地形增加移动消耗，额度不足');
  let note = '';
  for (const at of steps) { u.at = at; note += hurtGround(b, u); if (u.hp <= 0) break; }
  u.remaining -= cost;
  return `${u.name}移动到${coordinate(u.at)}，剩余${u.remaining}格${note}`;
}
function advance(c) {
  const b = c.combat, old = active(b);
  old.turns++;
  old.effects = old.effects.filter((v) => v.expires > old.turns);
  for (let i = 0; i < b.order.length; i++) {
    b.cursor++;
    if (b.cursor >= b.order.length) {
      b.cursor = 0; b.round++;
      b.supports = b.supports.filter((v) => v.expires > b.round);
    }
    const u = active(b);
    if (u.hp <= 0 || u.escaped) continue;
    u.remaining = u.move; u.main = 1; u.bonus = u.side === 'players' ? 1 : 0;
    if (effects(u, 'controlled')) { u.main = 0; u.remaining = 0; }
    if (u.side === 'players' && playerOf(c, u).progress.pollution >= 6) { u.main = 0; u.remaining = Math.min(1, u.remaining); }
    return;
  }
}
export function advanceEnemies(c, rng = randomInt) {
  const b = c.combat;
  for (let guard = 0; guard < b.units.length * 2 && !endIfDone(c); guard++) {
    const u = active(b);
    if (u.hp <= 0 || u.escaped) { advance(c); continue; }
    if (u.side === 'players') return;
    const candidates = b.units.filter((p) => p.side === 'players' && !p.escaped && p.hp > 0).sort((a, d) => distance(u.at, a.at) - distance(u.at, d.at) || a.id.localeCompare(d.id));
    const taunt = u.effects.find((e) => e.type === 'taunt');
    const target = candidates.find((p) => p.id === taunt?.target) || candidates[0];
    if (u.main && target) {
      let best = null;
      for (let y = 0; y < b.height; y++) for (let x = 0; x < b.width; x++) {
        const at = { x, y };
        if (key(at) !== key(u.at) && !walkable(b, at, u.id)) continue;
        const route = pathTo(b, u, at, u.remaining);
        if (route && (!best || distance(at, target.at) < best.distance)) best = { at, distance: distance(at, target.at) };
      }
      if (best && distance(u.at, target.at) > u.range) b.log.push(move(c, u, best.at));
      if (u.hp > 0 && distance(u.at, target.at) <= u.range && lineOfSight(b, u.at, target.at)) {
        b.log.push(attack(c, u, target, u.attack, Math.max(0, u.damage - 1), true, rng));
      } else b.log.push(`${u.name}等待可接近的目标`);
    }
    if (!endIfDone(c)) advance(c);
  }
  sync(c);
}

export function combatAction(c, userId, action, rng = randomInt) {
  const { b, u, p } = getActor(c, userId);
  let result;
  if (action.kind === 'move') result = move(c, u, position(action.at, b));
  else if (action.kind === 'attack') {
    const ranged = action.weapon === 'ranged';
    const target = validTarget(b, u, action.target, ranged ? 4 : 1);
    if (ranged && !p.inventory.some((v) => /枪|弓|弩/.test(v))) throw new Error('背包没有远程武器');
    const ammunition = p.inventory.some((v) => /枪/.test(v)) ? '子弹' : '箭矢';
    if (ranged && !p.inventory.includes(ammunition)) throw new Error(`缺少${ammunition}，每个独立背包条目代表一发`);
    spendAction(u, '主要');
    if (ranged) p.inventory.splice(p.inventory.indexOf(ammunition), 1);
    result = attack(c, u, target, p.character.attributes[ranged ? '敏捷' : '力量'] || 0, 0, false, rng);
  } else if (action.kind === 'defend') { spendAction(u, '主要'); putEffect(u, 'ward', 2, 2); result = `${u.name}采取防御`; }
  else if (action.kind === 'interact') {
    const obj = b.objects.find((o) => o.id === action.object && !o.used);
    if (!obj || distance(u.at, obj.at) > 1) throw new Error('互动物不在相邻位置或已使用');
    spendAction(u, '主要'); obj.used = true;
    if (obj.kind === 'barrier') b.cover.push({ at: { ...u.at }, value: 1 });
    if (obj.kind === 'lamp') {
      b.units.filter((v) => v.side === 'enemies' && v.spiritOnly).forEach((v) => { v.defense = Math.max(8, v.defense - 2); putEffect(v, 'controlled', 1); });
      c.clockPaused = true;
    }
    c.flags[obj.id] = { label: obj.label, done: true };
    result = `${u.name}完成互动：${obj.label}`;
  } else if (action.kind === 'item') {
    const item = p.inventory.find((v) => v === action.item);
    if (!item || !/治疗药剂|绷带/.test(item)) throw new Error('没有该可用治疗物品');
    const target = b.units.find((v) => !v.escaped && v.id === action.target && v.side === 'players' && distance(u.at, v.at) <= 1);
    if (!target) throw new Error('治疗目标需是相邻队友或自己');
    if (target.hp === 0 && occupied(b, target.at, target.id)) throw new Error('倒地位置被占用，请先腾出空间');
    spendAction(u, '辅助'); p.inventory.splice(p.inventory.indexOf(item), 1);
    target.hp = Math.min(target.maxHp, target.hp + 3); result = `${u.name}使用${item}，${target.name}恢复至${target.hp}HP`;
  } else if (action.kind === 'ability') {
    const skill = abilitiesOf(p).find((v) => v.id === action.ability);
    if (!skill) throw new Error('尚未解锁该能力');
    let target = null, at = null;
    if (['teleport', 'phase', 'summon', 'trap'].includes(skill.effect)) {
      at = position(action.at, b);
      if (!walkable(b, at, u.id) || key(at) === key(u.at)) throw new Error('能力落点必须为空格');
      if (skill.effect === 'phase') {
        const middle = neighbours(u.at).find((m) => distance(m, at) === 1 && b.objects.some((o) => o.kind === 'door' && !o.used && key(o.at) === key(m)));
        if (distance(u.at, at) !== 2 || !middle) throw new Error('穿门需要隔着一格普通门的空落点');
      } else if (distance(u.at, at) > skill.range || !lineOfSight(b, u.at, at)) throw new Error('能力落点超出可见范围');
    } else if (skill.range > 0) target = validTarget(b, u, action.target || u.id, skill.range, skill.effect === 'heal');
    else target = u;
    if (['heal', 'cleanse', 'ward', 'buff'].includes(skill.effect) && target.side !== u.side) throw new Error('该技能需友军目标');
    if (skill.effect === 'heal' && target.hp === 0 && occupied(b, target.at, target.id)) throw new Error('倒地位置被占用，请先腾出空间');
    if (['strike', 'ranged', 'radiant', 'drain', 'record', 'control', 'mark', 'provoke'].includes(skill.effect) && target.side === u.side) throw new Error('该技能需敌方目标');
    if (skill.effect === 'hide' && !b.cover.some((v) => key(v.at) === key(u.at))) throw new Error('当前位置没有可隐匿的掩体');
    if (skill.effect === 'record' && b.lastAttack?.source?.startsWith('e:') !== true) throw new Error('当前没有可记录的已见敌方攻击');
    const victims = skill.effect === 'burst' ? b.units.filter((v) => !v.escaped && v.hp > 0 && distance(v.at, target.at) <= 1 && lineOfSight(b, target.at, v.at)) : [];
    if (victims.some((v) => v.side === u.side) && action.confirmFriendlyFire !== true) throw new Error('范围包括友军，需明确确认友伤');
    spendAction(u, skill.action); consumeSpirit(p, skill.cost);
    const bonus = (p.character.attributes.感知 || 0) + Math.floor((9 - p.progress.sequence) / 2);
    if (['strike', 'ranged', 'radiant', 'drain', 'record'].includes(skill.effect)) {
      const before = target.hp;
      result = attack(c, u, target, skill.effect === 'strike' ? p.character.attributes.力量 || 0 : bonus, skill.power, skill.effect !== 'strike', rng);
      if (skill.effect === 'drain') u.hp = Math.min(u.maxHp, u.hp + Math.floor((before - target.hp) / 2));
    } else if (skill.effect === 'burst') {
      const results = [];
      for (const v of victims) {
        const roll = drawDice(20, rng), hit = roll + bonus >= v.defense + effects(v, 'ward');
        const damage = hit ? drawDice(4, rng) + skill.power : 0;
        v.hp = Math.max(0, v.hp - damage); results.push(`${v.name}：攻击骰${roll}，伤害${damage}`);
      }
      result = `${skill.name}：${results.join('；')}`;
    } else if (['control', 'provoke'].includes(skill.effect)) {
      const roll = drawDice(20, rng), resisted = roll + (target.side === 'enemies' ? target.attack : 0) >= 12 + skill.power;
      if (!resisted) {
        putEffect(target, skill.effect === 'control' ? 'controlled' : 'taunt', 1);
        target.effects.at(-1).target = u.id;
      }
      result = `${skill.name}：${target.name}豁免骰${roll}，${resisted ? '抵抗' : '受到影响'}`;
    } else if (['ward', 'buff', 'hide', 'mark'].includes(skill.effect)) {
      putEffect(target, { ward: 'ward', buff: 'buff', hide: 'hidden', mark: 'marked' }[skill.effect], 2, target.id === u.id ? 2 : 1); result = `${skill.name}作用于${target.name}`;
    } else if (skill.effect === 'heal') { target.hp = Math.min(target.maxHp, target.hp + drawDice(4, rng) + skill.power); result = `${skill.name}：${target.name}现HP${target.hp}`; }
    else if (skill.effect === 'cleanse') { target.effects = target.effects.filter((v) => !['controlled', 'taunt'].includes(v.type)); result = `${target.name}解除临时控制`; }
    else if (skill.effect === 'dispel') { target.effects = []; result = `${target.name}临时效果解除`; }
    else if (['phase', 'teleport'].includes(skill.effect)) { u.at = at; result = `${skill.name}到${coordinate(at)}${hurtGround(b, u)}`; }
    else if (skill.effect === 'dash') { u.remaining += 2; result = `剩余移动增加至${u.remaining}`; }
    else if (skill.effect === 'summon') { b.supports.push({ side: u.side, at, expires: b.round + 2 }); result = `${skill.name}位于${coordinate(at)}，周围两格友军攻击+2`; }
    else if (skill.effect === 'trap') { b.hazards.push({ at, damage: skill.power, slow: true, once: true, label: skill.name }); result = `${coordinate(at)}放置危险陷阱，敌我均受影响`; }
    else { p.progress.insight = 2; result = `${skill.name}：取得观察依据，下一次相关探索检定+2，未知信息由后续调查说明`; }
  } else if (action.kind === 'retreat') {
    if (u.at.x !== 0 && u.at.y !== 0 && u.at.x !== b.width - 1 && u.at.y !== b.height - 1) throw new Error('需先移动到地图边缘才能撤离');
    u.escaped = true; result = `${u.name}从战场撤离，未击败敌人或自动完成任务`;
    if (!endIfDone(c)) { advance(c); advanceEnemies(c, rng); }
  } else if (action.kind === 'end') { result = `${u.name}结束回合`; advance(c); advanceEnemies(c, rng); }
  else throw new Error('未知战斗行动');
  if (p.progress.pollution >= 6) { u.main = 0; u.remaining = Math.min(1, u.remaining); }
  b.log.push(result); b.log = b.log.slice(-30);
  if (!endIfDone(c) && u.hp <= 0 && active(b).id === u.id) { advance(c); advanceEnemies(c, rng); }
  return `${result}\n${combatPanel(c)}`;
}

export function combatPanel(c) {
  const b = c.combat;
  if (!b) return '';
  const symbols = new Map(b.units.filter((u) => !u.escaped && u.hp > 0).map((u, index) => [key(u.at), u.side === 'players' ? String(c.players.findIndex((p) => p.userId === u.userId) + 1) : String.fromCharCode(97 + index)]));
  const rows = ['   ' + Array.from({ length: b.width }, (_, i) => String.fromCharCode(65 + i)).join(' ')];
  for (let y = 0; y < b.height; y++) rows.push(String(y + 1).padStart(2) + ' ' + Array.from({ length: b.width }, (_, x) => {
    const at = { x, y };
    return symbols.get(key(at)) || (wall(b, at) ? '#' : b.hazards.some((v) => key(v.at) === key(at)) ? '!' : b.objects.some((v) => !v.used && key(v.at) === key(at)) ? '?' : b.cover.some((v) => key(v.at) === key(at)) ? '+' : '.');
  }).join(' '));
  const now = active(b);
  return `【战场·第${b.round}轮·${{ active: '进行中', won: '胜利', defeated: '全队倒地，可选择求援', retreated: '撤离，目标尚未完成', rescued: '已获救，等待后续剧情' }[b.status]}】\n${rows.join('\n')}\n#墙/门 +掩体 !危险 ?互动\n${b.units.map((u) => `${u.escaped ? '撤离' : symbols.get(key(u.at)) || '×'} ${u.name} ${coordinate(u.at)} HP${u.hp}/${u.maxHp}`).join('\n')}\n${b.status === 'active' ? `当前：${now.name}；主要${now.main}，辅助${now.bonus}，移动${now.remaining}` : '战斗记录已保存，下一条消息继续剧情。'}`;
}

export function combatOptions(c, userId, page = 'root', skillId = '') {
  const { b, u, p } = getActor(c, userId);
  if (page === 'root') return [
    { label: '攻击', page: 'attack' }, { label: '非凡能力', page: 'skills' },
    { label: '移动', page: 'move' }, { label: '物品、互动、防御与结束', page: 'other' }
  ];
  if (page === 'skills') return abilitiesOf(p).map((v) => ({ label: `${v.name}（${v.action}，灵性${v.cost}）`, page: 'skillTargets', skillId: v.id }));
  if (page === 'move') {
    const choices = [];
    for (let y = 0; y < b.height; y++) for (let x = 0; x < b.width; x++) {
      const at = { x, y }, steps = pathTo(b, u, at, u.remaining);
      if (steps?.length) choices.push({ label: `移动到${coordinate(at)}${b.hazards.some((v) => key(v.at) === key(at)) ? '（危险）' : ''}`, action: { kind: 'move', at } });
    }
    return choices;
  }
  if (page === 'attack') return b.units.filter((v) => v.side !== u.side && v.hp > 0).flatMap((v) => [
    { label: `近战：${v.name} ${coordinate(v.at)}`, action: { kind: 'attack', target: v.id } },
    ...(p.inventory.some((item) => /枪|弓|弩/.test(item)) && p.inventory.includes(p.inventory.some((item) => /枪/.test(item)) ? '子弹' : '箭矢') ? [{ label: `远程：${v.name}（消耗弹药）`, action: { kind: 'attack', target: v.id, weapon: 'ranged' } }] : [])
  ]).filter((v) => { const t = b.units.find((x) => x.id === v.action.target); return distance(u.at, t.at) <= (v.action.weapon ? 4 : 1) && lineOfSight(b, u.at, t.at) && !t.spiritOnly; });
  if (page === 'skillTargets') {
    const s = abilitiesOf(p).find((v) => v.id === skillId);
    if (!s) throw new Error('能力不存在');
    if (['phase', 'teleport', 'summon', 'trap'].includes(s.effect)) {
      const list = [];
      for (let y = 0; y < b.height; y++) for (let x = 0; x < b.width; x++) {
        const at = { x, y };
        if (walkable(b, at, u.id) && distance(u.at, at) > 0 && distance(u.at, at) <= (s.effect === 'phase' ? 2 : s.range)
          && (s.effect === 'phase' ? distance(u.at, at) === 2 && neighbours(u.at).some((m) => distance(m, at) === 1 && b.objects.some((o) => o.kind === 'door' && !o.used && key(o.at) === key(m))) : lineOfSight(b, u.at, at))) list.push({ label: `${s.name}到${coordinate(at)}`, action: { kind: 'ability', ability: skillId, at } });
      }
      return list;
    }
    const friendly = ['heal', 'cleanse', 'ward', 'buff', 'insight', 'hide', 'dash'].includes(s.effect);
    return b.units.filter((t) => !t.escaped && (t.hp > 0 || s.effect === 'heal' && t.side === u.side && !occupied(b, t.at, t.id)) && (friendly ? t.side === u.side : s.effect === 'burst' || t.side !== u.side) && distance(u.at, t.at) <= s.range && lineOfSight(b, u.at, t.at))
      .map((t) => ({ label: `${s.name}→${t.name}${s.effect === 'burst' ? '（范围内可能友伤，选择即确认）' : ''}`, action: { kind: 'ability', ability: skillId, target: t.id, confirmFriendlyFire: s.effect === 'burst' } }));
  }
  if (page === 'other') return [
    ...b.objects.filter((o) => !o.used && distance(u.at, o.at) <= 1).map((o) => ({ label: `互动：${o.label}`, action: { kind: 'interact', object: o.id } })),
    ...[...new Set(p.inventory.filter((item) => /治疗药剂|绷带/.test(item)))].flatMap((item) => b.units.filter((t) => !t.escaped && t.side === u.side && distance(u.at, t.at) <= 1 && (t.hp > 0 || !occupied(b, t.at, t.id))).map((t) => ({ label: `${item}→${t.name}`, action: { kind: 'item', item, target: t.id } }))),
    { label: '防御（主要行动）', action: { kind: 'defend' } }, { label: '结束回合', action: { kind: 'end' } },
    { label: '从地图边缘撤离（任务不自动完成）', action: { kind: 'retreat' } }
  ];
  throw new Error('未知菜单');
}
