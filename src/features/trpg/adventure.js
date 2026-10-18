import { randomInt, randomUUID } from 'node:crypto';
import { ATTRIBUTE_NAMES, pathwayOf, newProgress, limitsOf, abilitiesOf, TACTICAL_RULESET } from './catalog.js';
import { shortText, integer, drawDice, currentUnit, combatPanel, combatOptions, combatAction, startCombat } from './combat.js';

export function tactical(c) { return c?.ruleset === TACTICAL_RULESET; }
export function createPlayer(card, userId) {
  return { userId, character: structuredClone(card), hp: card.hp, inventory: structuredClone(card.inventory), condition: '', progress: newProgress(card.pathway) };
}
export function initializeCampaign(c) {
  Object.assign(c, { ruleset: TACTICAL_RULESET, phase: 'exploration', scene: { id: 'arrival', name: '抵达现场' },
    safe: false, choices: {}, intents: {}, resolved: [], journal: [], npcs: [], rewards: [], flags: {}, clock: 0, dangerClock: 0, clockPaused: false, chapter: 1, combat: null });
}

function optionMenu(c, userId, options, title, kind = 'story') {
  c.choices[userId] = { id: randomUUID().slice(0, 6), scene: c.scene.id, turn: currentUnit(c)?.id + ':' + c.combat?.round,
    title, kind, options: options.slice(0, 144) };
}
export function setStoryOptions(c, groups) {
  if (c.combat?.status === 'active') throw new Error('战斗菜单由程序生成');
  if (!Array.isArray(groups) || groups.length > 6) throw new Error('最多六位玩家菜单');
  for (const group of groups) {
    if (!c.players.some((p) => p.userId === group.userId)) throw new Error('菜单对象不是在册玩家');
    if (c.intents[group.userId]) throw new Error('该玩家已提交意图，不能覆盖其待结算菜单');
    if (!Array.isArray(group.options) || group.options.length < 1 || group.options.length > 6) throw new Error('每人提供1—6个选项');
    const options = group.options.map((o) => {
      const value = { label: shortText(o.label, 100, '行动选项'), risk: String(o.risk || '').slice(0, 200), minutes: integer(o.minutes ?? 0, 0, 60, '游戏分钟') };
      if (o.attribute !== undefined) {
        if (!ATTRIBUTE_NAMES.includes(o.attribute) || ![10, 12, 15, 18].includes(o.dc)) throw new Error('检定需使用四属性和难度10/12/15/18');
        value.attribute = o.attribute; value.dc = o.dc;
        value.failureDamage = integer(o.failureDamage ?? 0, 0, 2, '失败伤害');
        if (!value.risk) throw new Error('检定前必须明确风险');
      }
      return value;
    });
    optionMenu(c, group.userId, options, '请选择行动');
  }
}
export function ensureMenus(c) {
  if (!tactical(c) || c.status !== 'playing') return;
  c.choices ||= {}; c.intents ||= {};
  if (c.combat?.status === 'active') {
    const u = currentUnit(c);
    for (const id of Object.keys(c.choices)) if (id !== u.userId) delete c.choices[id];
    const old = c.choices[u.userId];
    if (!old || old.turn !== `${u.id}:${c.combat.round}`) optionMenu(c, u.userId, combatOptions(c, u.userId), '请选择战斗行动', 'combat');
  } else {
    if (c.combat?.status === 'defeated') {
      for (const p of c.players.filter((p) => !p.away)) if (!c.choices[p.userId]?.options?.[0]?.rescue) optionMenu(c, p.userId, [{ label: '请求救援，带回安全处（花费1游戏小时，任务未完成）', rescue: true }], '全队倒地·选择退路');
      return;
    }
    for (const p of c.players.filter((p) => !p.away && p.hp > 0 && !c.intents[p.userId])) {
      if (!c.choices[p.userId] || c.choices[p.userId].scene !== c.scene.id || c.choices[p.userId].kind === 'combat') {
        optionMenu(c, p.userId, ['观察周围', '与附近人物交谈', '检查线索', '谨慎前进'].map((label) => ({ label, minutes: 0 })), '请选择行动');
      }
    }
  }
}
export function adventurePanel(c, onlyUser = '') {
  if (!tactical(c)) return '';
  const parts = [];
  if (c.combat) parts.push(combatPanel(c));
  if (c.status === 'playing') {
    for (const p of c.players.filter((p) => !onlyUser || p.userId === onlyUser)) {
      const menu = c.choices?.[p.userId];
      const r = p.progress, l = limitsOf(p);
      parts.push(`【${p.character.name}·QQ${p.userId}】HP${p.hp}/${l.hp} 灵性${r.spirit}/${l.spirit} 污染${r.pollution}/6 消化${r.digestion}/${l.digestion}`);
      if (menu) parts.push(`${menu.title}（菜单${menu.id}）\n${menu.options.map((o, i) => `${i + 1}. ${o.label}${o.risk ? `；风险：${o.risk}` : ''}`).join('\n')}\n直接发序号；也可“${menu.id}:序号”避免选旧菜单。`);
      else parts.push(p.away ? '已暂离，归队后继续；角色状态保留。' : c.intents?.[p.userId] ? '已提交，等待其他玩家；场外提问不会推进时间。' : '等待当前行动者。');
    }
  }
  return parts.join('\n');
}
export function statusText(c) {
  return c.players.map((p) => {
    const r = p.progress, route = pathwayOf(r.pathway), l = limitsOf(p);
    return `${p.character.name}：${route.name}·序列${r.sequence}${route.sequences.find((s) => s.sequence === r.sequence).name}\nHP${p.hp}/${l.hp} 灵性${r.spirit}/${l.spirit} 污染${r.pollution}/6 消化${r.digestion}/${l.digestion}\n能力：${abilitiesOf(p).map((a) => a.name).join('、')}`;
  }).join('\n');
}
function findPlayer(c, userId) {
  const p = c.players.find((p) => p.userId === userId);
  if (!p) throw new Error('仅在册玩家可执行');
  return p;
}
function exploreAbility(c, p, id, rng) {
  const s = abilitiesOf(p).find((v) => v.id === id);
  if (!s) throw new Error('能力尚未解锁');
  if (p.progress.spirit < s.cost || p.progress.pollution >= 6 || p.hp <= 0) throw new Error('资源或当前状态不允许使用');
  // No arbitrary target damage or unbounded teleport outside a defined board.
  if (!['insight', 'buff', 'hide', 'dash', 'cleanse', 'heal', 'phase', 'teleport', 'mark', 'dispel', 'record'].includes(s.effect)) throw new Error('该能力需在战场上选择合法目标');
  if (['phase', 'teleport'].includes(s.effect)) return { pending: true, abilityId: s.id, text: `请求使用${s.name}，请裁判确认目标与可见性后由规则工具结算，尚未扣除灵性。` };
  if (['mark', 'dispel', 'record'].includes(s.effect)) throw new Error('该能力需在战场上选择合法目标');
  p.progress.spirit -= s.cost; p.progress.overuse++;
  if (p.progress.overuse > 3) p.progress.pollution = Math.min(6, p.progress.pollution + 1);
  const roll = drawDice(20, rng), total = roll + (p.character.attributes.感知 || 0);
  if (total >= 12) {
    if (s.effect === 'heal') p.hp = Math.min(limitsOf(p).hp, p.hp + drawDice(4, rng) + s.power);
    else if (s.effect === 'cleanse') p.condition = '';
    else p.progress.insight = 2;
  }
  return `${s.name}：真实d20=${roll}，合计${total} 对难度12，${total >= 12 ? '取得效果/观察依据' : '失败'}；灵性消耗${s.cost}，未知事实仍需主持解释。`;
}

export function receiveAdventure(c, userId, raw, messageId, rng = randomInt) {
  const p = findPlayer(c, userId), input = String(raw).trim();
  ensureMenus(c);
  if (/^(场外|规则)[：:]/.test(input)) return { narrative: true, outOfGame: true };
  if (p.away) throw new Error('你已暂离，请先 /跑团 归队；状态和成长保留');
  if (c.combat?.status !== 'active' && c.resolved?.length && !c.settled) {
    if (input === '继续结算') return { narrative: true };
    throw new Error('本轮行动等待裁判结算，请勿重复选择；回复失败时可发“继续结算”，已有骰点和消耗保留');
  }
  const match = /^(?:([a-f0-9]{6})[:：])?(\d{1,3})$/.exec(input);
  const menu = c.choices[userId];
  if (match && match[1] && menu?.id !== match[1]) throw new Error('该菜单已失效，请使用最新菜单');
  if (c.combat?.status === 'active') {
    if (currentUnit(c).userId !== userId) throw new Error('还没轮到你，不能执行当前玩家的选项');
    if (c.pendingCombat) {
      if (input === '继续结算') { c.pendingCombat.messageId = String(messageId); return { narrative: true }; }
      throw new Error('上一条自由战斗行动仍待裁判解释；可发“继续结算”，或 /跑团 菜单 取消尚未执行的意图');
    }
    if (!match) {
      if (input === '结束回合' || input === '防御') {
        const result = combatAction(c, userId, { kind: input === '结束回合' ? 'end' : 'defend' }, rng);
        c.choices = {}; ensureMenus(c); return { reply: result + '\n' + adventurePanel(c, currentUnit(c)?.userId) };
      }
      c.pendingCombat = { userId, text: shortText(input, 2000, '行动'), messageId: String(messageId) };
      return { narrative: true };
    }
    const option = menu?.options[Number(match[2]) - 1];
    if (!option) throw new Error('没有该序号，请查看本人的当前菜单');
    if (option.page) {
      const options = combatOptions(c, userId, option.page, option.skillId);
      options.push({ label: '返回战斗主菜单', page: 'root' });
      optionMenu(c, userId, options, '请选择目标/位置', 'combat');
      return { reply: adventurePanel(c, userId) };
    }
    const result = combatAction(c, userId, option.action, rng);
    c.choices = {}; c.pendingCombat = null; ensureMenus(c);
    return { reply: result + '\n' + adventurePanel(c, c.combat.status === 'active' ? currentUnit(c).userId : '') };
  }
  if (p.hp <= 0 && c.combat?.status === 'defeated' && (input === '1' || input === '求援' || match && menu?.id === match[1] && match[2] === '1')) {
    for (const member of c.players.filter((v) => !v.away)) { member.hp = Math.max(1, member.hp); member.condition = '获救负伤；需要休养'; }
    c.clock += 60; if (!c.clockPaused) c.dangerClock += 60;
    c.safe = true; c.combat.status = 'rescued'; c.choices = {}; c.intents = {};
    c.scene = { id: `rescue-${c.chapter}-${c.clock}`, name: '救援后的安全处' };
    c.resolved = [{ userId, messageId: String(messageId), text: '请求救援并接受带回安全处，任务尚未完成' }]; c.settled = false;
    c.journal.push({ id: c.scene.id, text: '全队获救，需处理医护与援助人情；原战场目标尚未完成', status: 'open' });
    ensureMenus(c); return { narrative: true };
  }
  if (p.hp <= 0) throw new Error('角色已倒地，请等待队友救援或使用场外消息讨论');
  if (c.intents[userId]) throw new Error('你已提交本轮意图，请等待其他玩家；可发“场外：...”讨论');
  if (menu?.kind === 'growth' || menu?.kind === 'skills' || menu?.kind === 'rest') {
    const option = match && menu.options[Number(match[2]) - 1];
    if (!option) throw new Error('请选择当前菜单序号或发送“/跑团 菜单”返回');
    if (option.promote) return { reply: promote(c, userId, rng) };
    if (option.rest) return { reply: rest(c, userId, option.rest) };
    if (option.ability) {
      c.restVotes = {};
      if (c.settled) { c.resolved = []; c.settled = false; }
      const result = exploreAbility(c, p, option.ability, rng);
      const skill = abilitiesOf(p).find((s) => s.id === option.ability);
      c.intents[userId] = { userId, messageId: String(messageId), text: typeof result === 'string' ? result : result.text, outcome: typeof result === 'string' ? result : '等待目标核对', abilityId: skill.id, abilityExecuted: typeof result === 'string', minutes: skill.minutes };
    } else return { reply: growthPanel(c, userId) };
  } else {
    const option = match ? menu?.options[Number(match[2]) - 1] : { label: input, minutes: 0 };
    if (!option) throw new Error('序号无效，请查看本人菜单，不会转成另一种行动');
    c.restVotes = {};
    if (c.settled && !Object.keys(c.intents).length) { c.resolved = []; c.settled = false; }
    const intent = { userId, messageId: String(messageId), text: option.label, risk: option.risk || '', minutes: option.minutes || 0 };
    if (option.attribute) {
      const roll = drawDice(20, rng), bonus = p.progress.insight;
      p.progress.insight = 0;
      const total = roll + (p.character.attributes[option.attribute] || 0) + bonus;
      intent.roll = { dice: roll, total, dc: option.dc, success: total >= option.dc };
      if (total < option.dc) p.hp = Math.max(0, p.hp - option.failureDamage);
      intent.outcome = `d20=${roll}，合计${total} 对${option.dc}，${intent.roll.success ? '成功' : '失败'}${total < option.dc && option.failureDamage ? `，HP-${option.failureDamage}` : ''}`;
    }
    c.intents[userId] = intent;
  }
  delete c.choices[userId];
  const waiting = c.players.filter((v) => !v.away && v.hp > 0 && !c.intents[v.userId]);
  if (waiting.length) return { reply: `${p.character.name}已选择：${c.intents[userId].text}${c.intents[userId].outcome ? '\n' + c.intents[userId].outcome : ''}\n等待：${waiting.map((v) => v.character.name).join('、')}。可用 /跑团 待命 提交等待。` };
  settleIntents(c);
  return { narrative: true };
}

function settleIntents(c) {
  c.resolved = Object.values(c.intents);
  const elapsed = Math.max(0, ...c.resolved.map((v) => v.minutes));
  c.batchMinutes = elapsed;
  c.clock += elapsed;
  if (!c.clockPaused) c.dangerClock += elapsed;
  c.intents = {};
}

export function growthPanel(c, userId) {
  const p = findPlayer(c, userId), r = p.progress, l = limitsOf(p), next = r.sequence - 1;
  optionMenu(c, userId, [{ label: '尝试晋升（消耗材料，风险检定）', promote: true }, { label: '查看成长记录', inspect: true }], '成长菜单', 'growth');
  return `【${p.character.name}·成长】${pathwayOf(r.pathway).name}序列${r.sequence}\n消化${r.digestion}/${l.digestion}；污染${r.pollution}/6\n下一级${next >= 5 ? next : '已达上限5'}；配方${r.recipes.includes(next) ? '已得' : '未得'}；材料${r.materials.includes(next) ? '已齐' : '未齐'}；仪式${r.rituals.includes(next) ? '已完成' : '未完成/无需'}\n${r.history.slice(-5).map((h) => `${h.reason}：${h.result}`).join('\n')}\n${adventurePanel(c, userId)}`;
}
export function promote(c, userId, rng = randomInt) {
  const p = findPlayer(c, userId), r = p.progress, next = r.sequence - 1, l = limitsOf(p);
  if (c.combat?.status === 'active' || !c.safe || Object.keys(c.intents).length || c.resolved?.length && !c.settled) throw new Error('需在安全休整场景、没有待结算行动时晋升');
  if (p.hp <= 0 || r.sequence <= 5 || r.digestion < l.digestion || r.pollution > 1 || !r.recipes.includes(next) || !r.materials.includes(next) || (next === 5 && !r.rituals.includes(next))) throw new Error('晋升条件不足：检查序列5上限、消化、污染、配方、材料及序列5仪式');
  r.materials.splice(r.materials.indexOf(next), 1);
  const roll = drawDice(20, rng), success = roll + (p.character.attributes.感知 || 0) >= 12 + (8 - next);
  if (success) { r.sequence = next; r.digestion = 0; p.hp += 2; r.spirit = Math.min(limitsOf(p).spirit, r.spirit + 2); }
  else r.pollution = Math.min(6, r.pollution + 2);
  const result = `真实骰${roll}，${success ? `晋升序列${next}，解锁${pathwayOf(r.pathway).sequences.find((s) => s.sequence === next).abilities[0].name}` : '晋升失败，材料消耗，污染+2；序列保持不变'}`;
  r.history.push({ reason: `尝试晋升${next}`, result }); r.history = r.history.slice(-80); c.choices = {}; ensureMenus(c);
  return result + '\n' + adventurePanel(c, userId);
}
export function rest(c, userId, hours) {
  if (findPlayer(c, userId).away) throw new Error('暂离者请先归队');
  if (!c.safe || c.combat?.status === 'active' || Object.keys(c.intents).length || c.resolved?.length && !c.settled) throw new Error('只能在没有待结算行动的安全场景休整');
  if (![1, 8].includes(hours)) throw new Error('休整只允许1或8游戏小时');
  c.restVotes ||= {};
  c.restVotes[userId] = hours;
  if (!c.players.filter((p) => !p.away).every((p) => c.restVotes[p.userId] === hours)) return '已登记休整意愿，等待全体玩家选择相同时长；现实等待不推进时间。';
  c.clock += hours * 60;
  if (!c.clockPaused) c.dangerClock += hours * 60;
  for (const p of c.players) {
    const r = p.progress, l = limitsOf(p);
    r.spirit = Math.min(l.spirit, hours === 8 ? l.spirit : r.spirit + 1);
    const day = Math.floor(c.clock / 1440);
    if (r.cleanseDay !== day) { r.cleanseDay = day; r.cleanseUsed = 0; }
    const cleaned = Math.min(hours === 8 ? 2 : 1, 2 - r.cleanseUsed, r.pollution);
    r.pollution -= cleaned; r.cleanseUsed += cleaned; r.overuse = 0;
    if (hours === 8) p.hp = Math.min(l.hp, p.hp + 2);
  }
  c.restVotes = {}; c.choices = {}; ensureMenus(c);
  return `全队休整${hours}游戏小时完成，资源已保存。\n${adventurePanel(c)}`;
}

export function adventureCommand(c, userId, verb, arg, rng) {
  const p = findPlayer(c, userId);
  if (c.combat?.status === 'active' && !['暂离', '归队'].includes(verb)) {
    if (verb === '休整') throw new Error('战斗中不能休整');
    if (verb === '成长' || verb === '晋升') return { reply: statusText(c) + '\n战斗中仅查看成长，不能晋升。' };
    if (verb === '待命') return receiveAdventure(c, userId, '结束回合', arg, rng);
    if (verb === '菜单' || verb === '能力') {
      if (currentUnit(c)?.userId !== userId) return { reply: '还没轮到你。\n' + statusText(c) };
      if (verb === '菜单') c.pendingCombat = null;
      const options = combatOptions(c, userId, verb === '能力' ? 'skills' : 'root');
      if (verb === '能力') options.push({ label: '返回主菜单', page: 'root' });
      optionMenu(c, userId, options, '请选择战斗行动', 'combat');
      return { reply: adventurePanel(c, userId) };
    }
  }
  if (verb === '暂离' || verb === '归队') {
    if (c.combat?.status === 'active') throw new Error('战斗中不能切换在队状态，请完成战斗或暂停整团');
    p.away = verb === '暂离'; delete c.choices[userId]; c.restVotes = {};
    if (p.away && Object.keys(c.intents).length && c.players.filter((v) => !v.away && v.hp > 0).every((v) => c.intents[v.userId])) {
      settleIntents(c); return { narrative: true };
    }
    ensureMenus(c);
    return { reply: `${p.character.name}已${p.away ? '暂离' : '归队'}，角色进度保留。\n${adventurePanel(c)}` };
  }
  if (verb === '成长') return { reply: growthPanel(c, userId) };
  if (verb === '晋升') return { reply: growthPanel(c, userId) + '\n确认后回复1，不能由主持代替确认。' };
  if (verb === '能力') {
    optionMenu(c, userId, abilitiesOf(findPlayer(c, userId)).map((s) => ({ label: `${s.name}：${s.description}（灵性${s.cost}）`, ability: s.id })), '请选择探索能力', 'skills');
    return { reply: adventurePanel(c, userId) };
  }
  if (verb === '休整') {
    optionMenu(c, userId, [{ label: '同意休整1小时', rest: 1 }, { label: '同意休整8小时', rest: 8 }], '全队需选择相同时长', 'rest');
    return { reply: adventurePanel(c, userId) };
  }
  if (verb === '菜单') { delete c.choices[userId]; ensureMenus(c); return { reply: adventurePanel(c, userId) }; }
  if (verb === '待命') return receiveAdventure(c, userId, '本轮待命，配合队友，不自行推进剧情', arg, rng);
  return null;
}

export function tacticalTool(c, actionContext, name, args, rng = randomInt) {
  if (name === 'trpg_check') {
    if (c.combat?.status === 'active') throw new Error('战斗检定使用战斗规则，不允许额外自由骰绕过');
    const p = findPlayer(c, args.userId), intent = c.resolved.find((v) => v.userId === p.userId);
    if (!intent || intent.roll || intent.abilityId || intent.abilityExecuted) throw new Error('本轮没有待检定的真实意图，或已结算，不能重掷；非凡行动使用能力工具');
    if (!ATTRIBUTE_NAMES.includes(args.attribute) || ![10, 12, 15, 18].includes(args.dc)) throw new Error('使用四属性及难度10/12/15/18');
    const damage = integer(args.failureDamage ?? 0, 0, 2, '失败伤害'), minutes = integer(args.minutes ?? 0, 0, 60, '耗时');
    if (damage && !intent.risk && !/确认|接受|愿意|同意/.test(intent.text)) throw new Error('自由行动尚未明确接受伤害风险，请先用编号菜单说明并等待确认');
    const roll = drawDice(20, rng), total = roll + (p.character.attributes[args.attribute] || 0) + p.progress.insight;
    p.progress.insight = 0;
    intent.roll = { dice: roll, total, dc: args.dc, success: total >= args.dc };
    if (total < args.dc) p.hp = Math.max(0, p.hp - damage);
    intent.outcome = `${args.attribute}：真实骰${roll}，合计${total} 对${args.dc}，${intent.roll.success ? '成功' : '失败'}`;
    intent.minutes = Math.max(intent.minutes || 0, minutes);
    const elapsed = Math.max(0, ...c.resolved.map((v) => v.minutes || 0)), delta = Math.max(0, elapsed - (c.batchMinutes || 0));
    c.clock += delta; if (!c.clockPaused) c.dangerClock += delta; c.batchMinutes = elapsed;
    return { saved: true, result: intent.outcome };
  }
  if (name === 'trpg_explore') {
    if (c.combat?.status === 'active') throw new Error('战斗中使用战斗行动工具');
    const p = findPlayer(c, args.userId), skill = abilitiesOf(p).find((s) => s.id === args.ability);
    if (!skill) throw new Error('能力未解锁');
    const intent = c.resolved.find((i) => i.userId === args.userId && (i.abilityId === skill.id || i.text.includes(skill.name)));
    if (!intent || intent.abilityExecuted || intent.roll) throw new Error('没有该玩家本轮授权，或能力已经结算，不能重复扣费或检定');
    let result;
    if (['phase', 'teleport'].includes(skill.effect)) {
      if (args.destinationKnown !== true) throw new Error('未知落点应先说明风险并让玩家确认，不能盲目传送');
      const destination = shortText(args.destination, 100, '落点');
      if (skill.effect === 'phase' && (args.ordinaryDoor !== true || !Number.isInteger(args.doorThicknessCm) || args.doorThicknessCm < 1 || args.doorThicknessCm > 20)) throw new Error('穿门仅允许20厘米内普通非封印门');
      if (skill.effect === 'teleport') integer(args.distance, 1, skill.range, '旅行格数');
      if (p.hp <= 0 || p.progress.pollution >= 6 || p.progress.spirit < skill.cost) throw new Error('资源或状态不足');
      p.progress.spirit -= skill.cost; p.progress.overuse++;
      if (p.progress.overuse > 3) p.progress.pollution = Math.min(6, p.progress.pollution + 1);
      const roll = drawDice(20, rng), success = roll + (p.character.attributes.感知 || 0) >= 12;
      result = `${skill.name}：真实骰${roll}，${success ? `到达${destination}` : '未能通过，位置不变'}，消耗灵性${skill.cost}`;
      if (success) c.flags[`position:${p.userId}`] = { destination };
    } else result = exploreAbility(c, p, skill.id, rng);
    if (typeof result !== 'string') throw new Error('该能力缺少可执行目标');
    intent.abilityExecuted = true; intent.outcome = result;
    intent.minutes = Math.max(intent.minutes || 0, skill.minutes);
    const elapsed = Math.max(0, ...c.resolved.map((v) => v.minutes || 0)), delta = Math.max(0, elapsed - (c.batchMinutes || 0));
    c.clock += delta; if (!c.clockPaused) c.dangerClock += delta; c.batchMinutes = elapsed;
    return { saved: true, result, progress: p.progress };
  }
  if (name === 'trpg_options') { setStoryOptions(c, args.players); return { saved: true, panel: adventurePanel(c) }; }
  if (name === 'trpg_encounter') {
    if (/^(场外|规则)[：:]/.test(actionContext.text || '')) throw new Error('场外问题不能开始战斗');
    if (Object.keys(c.intents).length) throw new Error('仍有玩家待选，不能跳过他们开始战斗');
    c.resolved = []; return { saved: true, panel: startCombat(c, args, rng) };
  }
  if (name === 'trpg_battle_action') {
    const pending = c.pendingCombat;
    if (!pending || pending.userId !== actionContext.actorId || pending.messageId !== actionContext.messageId) throw new Error('没有本轮玩家授权的自由战斗行动');
    if (args.action?.confirmFriendlyFire === true && !/确认.*友伤|允许.*友伤|不顾.*队友/.test(pending.text)) throw new Error('范围伤及队友，需玩家明确确认友伤后再行动');
    const result = combatAction(c, pending.userId, args.action, rng);
    c.pendingCombat = null; c.choices = {}; ensureMenus(c); return { saved: true, result };
  }
  if (name === 'trpg_scene') {
    if (c.combat?.status === 'active' || Object.keys(c.intents).length) throw new Error('战斗或其他玩家待选期间不能换场景');
    c.scene = { id: shortText(args.sceneId, 60, '场景ID'), name: shortText(args.name, 80, '场景名') };
    if (args.clockPaused !== undefined) c.clockPaused = args.clockPaused === true;
    c.safe = args.safe === true; c.choices = {}; c.resolved = []; c.restVotes = {};
    if (Array.isArray(args.journal)) {
      if (args.journal.length > 40) throw new Error('日志条目最多40');
      for (const row of args.journal) {
        const item = { id: shortText(row.id, 60, '日志ID'), text: shortText(row.text, 500, '日志'), status: row.status === 'done' ? 'done' : 'open' };
        const old = c.journal.findIndex((v) => v.id === item.id);
        if (old < 0) c.journal.push(item); else c.journal[old] = item;
      }
      c.journal = c.journal.slice(-100);
    }
    if (args.npcs !== undefined) {
      if (!Array.isArray(args.npcs) || args.npcs.length > 20) throw new Error('每次最多更新20位NPC');
      c.npcs ||= [];
      for (const row of args.npcs) {
        const npc = { id: shortText(row.id, 60, 'NPC ID'), name: shortText(row.name, 60, 'NPC名'), location: shortText(row.location, 100, 'NPC位置'), attitude: integer(row.attitude ?? 0, -2, 2, 'NPC态度'), notes: shortText(row.notes, 500, '关系与经历') };
        const i = c.npcs.findIndex((n) => n.id === npc.id);
        if (i >= 0) c.npcs[i] = npc; else c.npcs.push(npc);
      }
      if (c.npcs.length > 100) throw new Error('战役NPC档案最多100位，请沿用已有ID');
    }
    return { saved: true, scene: c.scene };
  }
  if (name === 'trpg_reward') {
    if (c.combat?.status === 'active') throw new Error('战斗结算后才能发放成长证据');
    const p = findPlayer(c, args.userId), r = p.progress;
    const evidence = shortText(args.evidence, 160, '奖励理由'), eventId = shortText(args.eventId, 60, '事件ID');
    const id = `${p.userId}:${eventId}:${args.kind}`;
    if (c.rewards.some((v) => v.id === id)) throw new Error('同一事件奖励已发放，不能重复领取');
    if (!c.resolved.length && !c.journal.some((j) => j.status === 'done' && j.id === eventId)) throw new Error('奖励需有已结算玩家行动或已完成日志作为依据');
    if (args.kind === 'digestion') {
      if (r.awards.includes(c.scene.id) || r.awards.length >= 1000) throw new Error('该场景已奖励消化，或记录已满');
      const chapterAwards = c.rewards.filter((v) => v.userId === p.userId && v.kind === 'digestion' && v.chapter === c.chapter);
      if (chapterAwards.length >= 2) throw new Error('本章消化奖励已达2次；不能靠改事件ID刷取');
      r.digestion = Math.min(limitsOf(p).digestion, r.digestion + 1); r.awards.push(c.scene.id);
    } else if (['recipe', 'material', 'ritual'].includes(args.kind)) {
      const target = integer(args.sequence, 5, 8, '目标序列');
      if (target !== r.sequence - 1) throw new Error('只能获得下一序列成长准备');
      const field = { recipe: 'recipes', material: 'materials', ritual: 'rituals' }[args.kind];
      if (r[field].includes(target)) throw new Error('已持有该成长准备');
      r[field].push(target);
    } else if (args.kind === 'item') {
      const item = shortText(args.item, 120, '物品');
      if (p.inventory.length >= 30) throw new Error('背包已满');
      p.inventory.push(item);
    } else throw new Error('未知奖励类型');
    c.rewards.push({ id, userId: p.userId, kind: args.kind, chapter: c.chapter, evidence, sceneId: c.scene.id });
    if (c.rewards.length > 2000) throw new Error('战役奖励记录已满，请归档战役，不删除去重凭据');
    r.history.push({ reason: evidence, result: args.kind }); r.history = r.history.slice(-80);
    return { saved: true, progress: r };
  }
  throw new Error('未知战术工具');
}
