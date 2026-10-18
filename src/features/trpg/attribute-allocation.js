import { integer, shortText } from './combat.js';

export function validateAllocation(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((k) => !['attributes', 'points', 'min', 'max'].includes(k))) throw new Error('自由加点需attributes、points及可选min/max');
  if (!Array.isArray(input.attributes) || input.attributes.length < 1 || input.attributes.length > 12) throw new Error('自由加点需1—12个属性');
  const attributes = input.attributes.map((a) => {
    const name = shortText(a, 20, '加点属性名');
    if (/\s|[=＝:：,，;；{}]/.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name)) throw new Error('加点属性名不能包含空白、分隔符或保留名称');
    return name;
  });
  if (new Set(attributes).size !== attributes.length) throw new Error('加点属性名不能重复');
  const points = integer(input.points, 1, 120, '总属性点'), min = integer(input.min ?? 0, 0, 10, '单项最小值'), max = integer(input.max ?? Math.min(points, 10), min, 10, '单项最大值');
  if (points < min * attributes.length || points > max * attributes.length) throw new Error('总属性点无法在单项上下限内分完');
  return { attributes, points, min, max };
}

export function validateAllocatedAttributes(attributes, rule) {
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes) || Object.keys(attributes).length !== rule.attributes.length || rule.attributes.some((a) => !Object.hasOwn(attributes, a))) throw new Error(`本世界只使用：${rule.attributes.join('、')}`);
  const result = Object.fromEntries(rule.attributes.map((name) => [name, integer(attributes[name], rule.min, rule.max, name)]));
  const total = Object.values(result).reduce((a, b) => a + b, 0);
  if (total !== rule.points) throw new Error(`必须分完${rule.points}点，当前合计${total}点${total > rule.points ? '（超额）' : '（未分完）'}`);
  return result;
}

export function parseAllocation(text, rule) {
  const value = String(text).trim();
  let attributes;
  if (value.startsWith('{')) {
    try { attributes = JSON.parse(value); } catch { throw new Error(`属性JSON格式有误，也可按顺序输入${rule.attributes.length}个整数`); }
  } else {
    const tokens = value.split(/[\s,，;；]+/).filter(Boolean);
    if (tokens.length === rule.attributes.length && tokens.every((s) => /^-?\d+$/.test(s))) attributes = Object.fromEntries(rule.attributes.map((name, i) => [name, Number(tokens[i])]));
    else {
      attributes = {};
      let rest = value.replace(/[\s,，;；]+/g, '');
      const names = [...rule.attributes].sort((a, b) => b.length - a.length);
      while (rest) {
        const name = names.find((a) => rest.startsWith(a));
        if (!name || Object.hasOwn(attributes, name)) throw new Error(`请填写本世界全部属性且不要重复：${rule.attributes.join('、')}`);
        const match = /^[:：=＝]?(-?\d+)/.exec(rest.slice(name.length));
        if (!match) throw new Error('属性点必须为整数');
        attributes[name] = Number(match[1]); rest = rest.slice(name.length + match[0].length);
      }
    }
  }
  return validateAllocatedAttributes(attributes, rule);
}

export function allocationPanel(rule) {
  const sample = rule.attributes.map(() => rule.min);
  let remaining = rule.points - rule.min * sample.length;
  for (let i = 0; i < sample.length && remaining; i++) { const n = Math.min(rule.max - rule.min, remaining); sample[i] += n; remaining -= n; }
  return `【自由分配属性点】\n${rule.attributes.map((name, i) => `${i + 1}. ${name}`).join('\n')}\n总共${rule.points}点，必须分完；每项${rule.min}—${rule.max}点。\n按上面顺序直接发送${sample.length}个整数，例如：${sample.join(' ')}\n也可发送：${rule.attributes.map((name, i) => `${name}${sample[i]}`).join(' ')}\n0. 取消建角`;
}
