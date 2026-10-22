'use strict';

import { applyTheme, getThemePref } from '../app.js';
import { api } from '../core/api.js';
import { $ } from '../core/dom.js';
import { state } from '../core/state.js';

const STORAGE_KEY = 'qqa-appearance-v1';
const DEFAULTS = Object.freeze({
  accent: 'blue', backdrop: 'mist', surface: 'solid', layout: 'standard', density: 'balanced',
  typography: 'system', motion: 'subtle', radius: 'soft', preset: 'custom',
  accentColor: '#4c8dff', effectColor: '#4c8dff', trailColor: '#68b8ff',
  hover: 'soft', click: 'ripple', trail: 'off'
});
const OPTIONS = {
  accent: [
    ['blue', '湖蓝', '清晰、沉稳'], ['cyan', '青色', '轻盈、通透'],
    ['violet', '星紫', '柔和、未来感'], ['emerald', '翡翠', '自然、克制'],
    ['amber', '琥珀', '温暖、醒目'], ['custom', '自定义', '使用下方颜色']
  ],
  backdrop: [
    ['plain', '纯色', '保持专注'], ['mist', '柔和蓝雾', '安静的渐变层次'],
    ['grid', '极细网格', '轻微科技感'], ['glow', '角落冷光', '局部空间感']
  ],
  surface: [
    ['solid', '实心卡片', '对比最清楚'], ['glass', '磨砂玻璃', '透出一点背景'],
    ['outline', '轻线框', '减少卡片重量']
  ],
  layout: [
    ['focus', '聚焦', '收窄阅读区域'], ['standard', '标准', '平衡内容宽度'],
    ['wide', '宽屏', '充分利用大显示器']
  ],
  density: [
    ['compact', '紧凑', '一屏显示更多'], ['balanced', '均衡', '默认间距'],
    ['spacious', '舒展', '留白更多']
  ],
  typography: [
    ['system', '系统字体', '熟悉、清晰'], ['reading', '阅读字体', '更柔和的中文'],
    ['technical', '技术字体', '数字更有秩序']
  ],
  motion: [
    ['off', '关闭', '静态界面'], ['subtle', '轻微', '柔和反馈'],
    ['lively', '灵动', '多一点悬浮与光效']
  ],
  hover: [
    ['off', '关闭', '不添加悬停装饰'], ['soft', '轻微', '沿用柔和反馈'],
    ['glow', '发光', '边框泛起淡光'], ['lift', '浮起', '卡片轻微抬升']
  ],
  click: [
    ['off', '关闭', '只保留原有反馈'], ['ripple', '涟漪', '点击处扩散一圈'],
    ['spark', '星点', '点击处散开光点']
  ],
  trail: [
    ['off', '关闭', '默认，不占用画面'], ['dots', '微光点', '短暂点状拖尾'],
    ['comet', '流光', '柔和的短尾迹']
  ],
  radius: [
    ['square', '利落直角', '更像工作台'], ['soft', '柔和圆角', '默认风格'],
    ['round', '圆润卡片', '更轻松']
  ]
};
const PRESETS = [
  ['ocean', '深海', '深色 · 蓝雾 · 湖蓝', 'dark', { accent: 'blue', backdrop: 'mist', surface: 'solid', density: 'balanced', typography: 'system', motion: 'subtle', radius: 'soft' }],
  ['graphite', '石墨', '深色 · 网格 · 青色', 'dark', { accent: 'cyan', backdrop: 'grid', surface: 'outline', density: 'compact', typography: 'technical', motion: 'subtle', radius: 'square' }],
  ['aurora', '极光', '深色 · 冷光 · 星紫', 'dark', { accent: 'violet', backdrop: 'glow', surface: 'glass', density: 'spacious', typography: 'system', motion: 'lively', radius: 'round' }],
  ['daybreak', '晨雾', '浅色 · 蓝雾 · 湖蓝', 'light', { accent: 'blue', backdrop: 'mist', surface: 'solid', density: 'balanced', typography: 'reading', motion: 'subtle', radius: 'soft' }],
  ['warm', '暖纸', '浅色 · 纯色 · 琥珀', 'light', { accent: 'amber', backdrop: 'plain', surface: 'solid', density: 'spacious', typography: 'reading', motion: 'off', radius: 'soft' }]
];

function readAppearance() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {}; } catch { /* 损坏的本地记录回退默认 */ }
  const result = { ...DEFAULTS };
  for (const [key, choices] of Object.entries(OPTIONS)) {
    if (choices.some(([value]) => value === saved[key])) result[key] = saved[key];
  }
  for (const key of ['accentColor', 'effectColor', 'trailColor']) {
    if (/^#[0-9a-fA-F]{6}$/.test(saved[key])) result[key] = saved[key].toLowerCase();
  }
  if (PRESETS.some(([id]) => id === saved.preset)) result.preset = saved.preset;
  return result;
}

function applyAppearance(next) {
  state.appearance = next;
  const root = document.documentElement;
  for (const key of Object.keys(OPTIONS)) root.dataset[key] = next[key];
  if (next.accent === 'custom') root.style.setProperty('--accent', next.accentColor);
  else root.style.removeProperty('--accent');
  root.style.setProperty('--effect-color', next.effectColor);
  root.style.setProperty('--trail-color', next.trailColor);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* 隐私模式下仍保留本次选择 */ }
}

function setTheme(pref) {
  applyTheme(pref);
  api('/api/config', { method: 'POST', body: JSON.stringify({ ui: { theme: pref } }) })
    .catch(() => { /* 页面外观已经在本地生效 */ });
}

function choiceGroup(key, title, description) {
  const current = state.appearance[key];
  const choices = OPTIONS[key].map(([value, label, hint]) => `
    <button type="button" class="appearance-option${current === value ? ' is-selected' : ''}" data-appearance-key="${key}" data-appearance-value="${value}" aria-pressed="${current === value}">
      ${key === 'accent' ? `<i class="appearance-swatch swatch-${value}" aria-hidden="true"></i>` : ''}
      <strong>${label}</strong><small>${hint}</small>
    </button>`).join('');
  if (!title) return `<div class="appearance-subgroup"><div class="appearance-options">${choices}</div></div>`;
  return `<section class="appearance-group"><div class="appearance-group-heading"><h2>${title}</h2><p>${description}</p></div><div class="appearance-options">${choices}</div></section>`;
}

function colorControl(key, title, description) {
  const value = state.appearance[key];
  return `<label class="appearance-color-control"><span><strong>${title}</strong><small>${description}</small></span><input type="color" value="${value}" data-appearance-color="${key}" aria-label="${title}"><input type="text" value="${value}" maxlength="7" spellcheck="false" data-appearance-hex="${key}" aria-label="${title}十六进制色值"></label>`;
}

function renderAppearancePage() {
  const page = $('#appearance-page');
  if (!page) return;
  if (!state.appearance) applyAppearance(readAppearance());
  bindAppearanceControls(page);
  const theme = getThemePref();
  page.innerHTML = `
    <div class="appearance-heading"><div><span class="appearance-eyebrow">APPEARANCE</span><h1>外观</h1><p>调整控制台的色彩、背景、材质与阅读节奏。选择后立即生效，并保存在这个浏览器。</p></div><button type="button" class="btn" data-appearance-reset>恢复默认</button></div>
    <section class="appearance-group"><div class="appearance-group-heading"><h2>快速主题</h2><p>先选一个整体风格，再按喜好微调。</p></div><div class="appearance-presets">
      ${PRESETS.map(([id, label, hint]) => `<button type="button" class="appearance-preset preset-${id}${state.appearance.preset === id ? ' is-selected' : ''}" data-appearance-preset="${id}" aria-pressed="${state.appearance.preset === id}"><span class="appearance-preset-art"><i></i><i></i><i></i></span><strong>${label}</strong><small>${hint}</small></button>`).join('')}
    </div></section>
    <section class="appearance-group"><div class="appearance-group-heading"><h2>明暗模式</h2><p>「跟随系统」会随设备的外观设置变化。</p></div><div class="appearance-options">
      ${[['dark', '深色', '适合长时间使用'], ['light', '浅色', '明亮清爽'], ['system', '跟随系统', '自动切换']].map(([value, label, hint]) => `<button type="button" class="appearance-option${theme === value ? ' is-selected' : ''}" data-appearance-theme="${value}" aria-pressed="${theme === value}"><strong>${label}</strong><small>${hint}</small></button>`).join('')}
    </div></section>
    ${choiceGroup('accent', '强调色', '用于选中项、按钮和图表；状态告警颜色保持独立。')}
    <div class="appearance-color-row">${colorControl('accentColor', '自定义强调色', '选色后自动切换到自定义。')}</div>
    ${choiceGroup('backdrop', '背景', '纹理只放在工作区，避免干扰表单阅读。')}
    ${choiceGroup('surface', '卡片材质', '调整面板的透光度与边框质感。')}
    ${choiceGroup('layout', '页面版式', '控制内容区域的宽度；宽屏下差异更明显。')}
    ${choiceGroup('density', '布局密度', '调整导航、卡片和页面留白。')}
    ${choiceGroup('radius', '边角风格', '控制主要卡片的圆角。')}
    ${choiceGroup('typography', '排版', '选择熟悉的系统字、舒适阅读或更整齐的数字。')}
    ${choiceGroup('motion', '动态效果', '系统开启「减少动态效果」时会自动优先尊重系统设置。')}
    <section class="appearance-group"><div class="appearance-group-heading"><h2>鼠标反馈</h2><p>悬停、点击和拖尾可以分别调整。动态效果关闭时，点击与拖尾也会停止。</p></div>
      <h3>悬停</h3>${choiceGroup('hover', '', '')}
      <h3>点击</h3>${choiceGroup('click', '', '')}
      <h3>拖尾</h3>${choiceGroup('trail', '', '')}
      <div class="appearance-color-row">${colorControl('effectColor', '悬停与点击颜色', '用于发光、涟漪与星点。')}${colorControl('trailColor', '拖尾颜色', '仅在开启拖尾时显示。')}</div>
    </section>
    <p class="appearance-footnote">外观选项即时保存在当前浏览器；明暗模式仍使用原有的跨设备主题设置。</p>`;
}

function updateColor(key, value, rerender = false) {
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) { if (rerender) renderAppearancePage(); return; }
  const next = { ...state.appearance, [key]: value.toLowerCase(), preset: 'custom' };
  if (key === 'accentColor') next.accent = 'custom';
  applyAppearance(next);
  if (rerender) renderAppearancePage();
}

function bindAppearanceControls(page) {
  if (page.dataset.appearanceBound) return;
  page.dataset.appearanceBound = 'true';
  page.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.hasAttribute('data-appearance-reset')) {
      applyAppearance({ ...DEFAULTS });
      setTheme('dark');
    } else if (button.dataset.appearancePreset) {
      const preset = PRESETS.find(([id]) => id === button.dataset.appearancePreset);
      if (!preset) return;
      applyAppearance({ ...DEFAULTS, ...preset[4], preset: preset[0] });
      setTheme(preset[3]);
    } else if (button.dataset.appearanceTheme) {
      setTheme(button.dataset.appearanceTheme);
      applyAppearance({ ...state.appearance, preset: 'custom' });
    } else if (button.dataset.appearanceKey) {
      const key = button.dataset.appearanceKey;
      const value = button.dataset.appearanceValue;
      if (!OPTIONS[key]?.some(([allowed]) => allowed === value)) return;
      applyAppearance({ ...state.appearance, [key]: value, preset: 'custom' });
    } else return;
    renderAppearancePage();
  });
  page.addEventListener('input', (event) => {
    const key = event.target.dataset?.appearanceColor;
    if (!key || !['accentColor', 'effectColor', 'trailColor'].includes(key)) return;
    updateColor(key, event.target.value);
    const hex = page.querySelector(`[data-appearance-hex="${key}"]`);
    if (hex) hex.value = event.target.value;
  });
  page.addEventListener('change', (event) => {
    const key = event.target.dataset?.appearanceColor || event.target.dataset?.appearanceHex;
    if (['accentColor', 'effectColor', 'trailColor'].includes(key)) updateColor(key, event.target.value, true);
  });
}

function initMouseEffects() {
  const root = document.documentElement;
  if (root.dataset.appearanceEffectsBound) return;
  root.dataset.appearanceEffectsBound = 'true';
  const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
  const addEffect = (className, x, y, delay = 600, angle = 0) => {
    const node = document.createElement('span');
    node.className = className;
    node.style.left = `${x}px`;
    node.style.top = `${y}px`;
    node.style.setProperty('--spark-angle', `${angle}deg`);
    document.body.appendChild(node);
    node.addEventListener('animationend', () => node.remove(), { once: true });
    setTimeout(() => node.remove(), delay);
  };
  let lastTrailAt = -Infinity;
  document.addEventListener('pointermove', (event) => {
    if (event.pointerType && event.pointerType !== 'mouse') return;
    const appearance = state.appearance;
    if (!appearance || appearance.trail === 'off' || appearance.motion === 'off' || reducedMotion()) return;
    const now = performance.now();
    if (now - lastTrailAt < 38 || document.querySelectorAll('.appearance-trail').length >= 24) return;
    lastTrailAt = now;
    addEffect(`appearance-trail trail-${appearance.trail}`, event.clientX, event.clientY, 550);
  }, { passive: true });
  document.addEventListener('pointerdown', (event) => {
    const appearance = state.appearance;
    if (!appearance || appearance.click === 'off' || appearance.motion === 'off' || reducedMotion()) return;
    if (!event.target.closest('button, a, [role="button"], input, select')) return;
    if (appearance.click === 'ripple') addEffect('appearance-click-ripple', event.clientX, event.clientY, 580);
    if (appearance.click === 'spark') {
      for (let i = 0; i < 6; i++) addEffect('appearance-click-spark', event.clientX, event.clientY, 580, i * 60);
    }
  }, { passive: true });
}

function initAppearance() {
  applyAppearance(readAppearance());
  const page = $('#appearance-page');
  if (page) bindAppearanceControls(page);
  initMouseEffects();
}

export { initAppearance, renderAppearancePage };
