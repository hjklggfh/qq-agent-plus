// UI 真实 DOM 冒烟（改进方案 #1 A 档）：happy-dom 提供真实 DOM 语义（对比 render-test 的
// 手写桩件），加载 index.html 骨架 + 全部 ui/*.js（按 script 清单顺序），断言：
// 所有主导航入口都不抛、api() 走 fetch 桩、登录表单提交走通。
// **缺 happy-dom 时自动跳过** —— D6 约定：更新器用 --omit=dev 不装 devDeps，
// 这条 skip 路径是必须守住的（不许删；删了更新器环境会红）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';
import { toClassicScript } from './helpers/ui-module-source.mjs';

let WindowClass = null;
try {
  ({ Window: WindowClass } = await import('happy-dom'));
} catch (e) {
  // 只有"依赖确实没装"才跳过（生产/更新器环境是 npm ci --omit=dev）；装了却加载失败
  // （版本与 Node 不兼容 / 包损坏）必须抛出去 —— 否则这层门禁静默消失，CI 照样绿（2026-10-01 审查）。
  if (e?.code !== 'ERR_MODULE_NOT_FOUND') throw e;
}
const SKIP = WindowClass ? false : 'happy-dom 未安装（devDependencies；--omit=dev 环境按约定跳过）';

const UI = path.resolve('ui');
const RAW_HTML = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
const SCRIPT_FILES = [...RAW_HTML.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1].replace(/^\//, ''));
const TABS = [...new Set([...RAW_HTML.matchAll(/data-tab="([a-z-]+)"/g)].map((m) => m[1]))];

function settle(ms = 250) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadPage() {
  const window = new WindowClass({ url: 'http://127.0.0.1:3210/' });
  // 骨架进 DOM；script 标签不交给 happy-dom 自己加载，由测试按清单手动按序执行
  window.document.write(RAW_HTML.replace(/<script[^>]*>\s*<\/script>/g, ''));
  const fetchLog = [];
  const cfgStub = {
    api: { model: 'smoke-model', maxRounds: 3 },
    allow: { groups: ['10001'], private: [] },
    server: {}, runtime: { mode: 'observe' },
    webSearch: { enabled: false }, asr: {}, tts: {},
    identityPilot: {}, slangPilot: {}, incidentPilot: {}, memory: {}
  };
  window.fetch = async (url) => {
    fetchLog.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => (String(url).includes('/api/config') ? cfgStub : {})
    };
  };
  window.EventSource = class EventSourceStub {
    constructor() { this.readyState = 0; }
    addEventListener() {}
    close() {}
  };
  const errors = [];
  window.addEventListener('error', (event) => errors.push(String(event?.error ?? event?.message ?? event)));
  const ctx = vm.createContext(window);
  for (const file of SCRIPT_FILES) {
    const raw = fs.readFileSync(path.join(UI, file), 'utf8');
    new vm.Script(toClassicScript(raw, file), { filename: `ui/${file}` }).runInContext(ctx);
  }
  return { window, fetchLog, errors };
}

test('真实 DOM 冒烟：加载全部脚本、主导航切换入口不抛', { skip: SKIP }, async () => {
  const { window, errors } = loadPage();
  await settle();
  try {
    assert.ok(SCRIPT_FILES.length >= 12, `脚本清单应含 i18n+core+app+8 外挂，实际 ${SCRIPT_FILES.length}`);
    assert.deepEqual(errors, [], `加载期出现未捕获错误：${errors.join(' | ')}`);
    assert.ok(typeof window.switchTab === 'function', 'switchTab 应可用');
    const failed = [];
    for (const tab of TABS) {
      try {
        window.switchTab(tab);
        await settle(30);
      } catch (error) {
        failed.push(`${tab}: ${error?.message ?? error}`);
      }
    }
    assert.deepEqual(failed, [], `这些 tab 的渲染入口抛错：${failed.join(' | ')}`);
  } finally { window.happyDOM?.abort?.(); }
});

test('总览用量图只在首次加载时播放入场动画', { skip: SKIP }, async () => {
  const { window, errors } = loadPage();
  await settle();
  try {
    const doc = window.document;
    window.switchTab('overview');
    await settle();
    assert.ok(doc.querySelector('.overview-chart.is-entering'));
    doc.querySelector('[data-overview-refresh]').click();
    await settle();
    assert.ok(doc.querySelector('.overview-chart'));
    assert.equal(doc.querySelector('.overview-chart.is-entering'), null);
    assert.deepEqual(errors, []);
  } finally { window.happyDOM?.abort?.(); }
});

test('功能、游戏和记忆入口能抵达原有页面', { skip: SKIP }, async () => {
  const { window, errors } = loadPage();
  await settle();
  try {
    const doc = window.document;
    doc.querySelector('[data-tab="features"]').click();
    await settle(60);
    assert.ok(doc.querySelector('[data-tab="features"]').classList.contains('active'));
    assert.ok(doc.querySelector('#view-settings').classList.contains('active'));
    assert.ok(doc.querySelector('#settings-sidebar').innerHTML.includes('data-section="image-search"'));
    assert.ok(!doc.querySelector('#settings-sidebar').innerHTML.includes('data-section="api"'));
    doc.querySelector('#settings-sidebar [data-section="pixiv"]').click();
    await settle(60);
    assert.ok(doc.querySelector('#settings-sidebar [data-section="pixiv"]').classList.contains('active'));
    assert.ok(doc.querySelector('#settings-form').innerHTML.includes('PID'));

    doc.querySelector('[data-tab="games"]').click();
    assert.ok(doc.querySelector('#view-games').classList.contains('active'));
    doc.querySelector('[data-game-section="groupGame"]').click();
    await settle(60);
    assert.ok(doc.querySelector('#view-settings').classList.contains('active'));
    assert.ok(doc.querySelector('#settings-sidebar').innerHTML.includes('data-section="groupGame"'));
    assert.ok(doc.querySelector('[data-tab="games"]').classList.contains('active'));
    doc.querySelector('[data-tab="games"]').click();
    doc.querySelector('[data-game-target="trpg"]').click();
    await settle(60);
    assert.ok(doc.querySelector('#view-trpg').classList.contains('active'));
    assert.ok(doc.querySelector('[data-tab="games"]').classList.contains('active'));

    doc.querySelector('[data-tab="memory"]').click();
    doc.querySelector('[data-memory-tab="people-memory"]').click();
    await settle(60);
    assert.ok(doc.querySelector('#view-people-memory').classList.contains('active'));
    assert.ok(doc.querySelector('[data-tab="memory"]').classList.contains('active'));
    assert.deepEqual(errors, []);
  } finally { window.happyDOM?.abort?.(); }
});

test('X 设置可保存且不回显Token，预览仅走网页API并转义帖子HTML', { skip: SKIP }, async () => {
  const { window, errors } = loadPage();
  await settle();
  try {
    const doc = window.document; const calls = [];
    doc.querySelector('[data-tab="features"]').click();
    await settle(60);
    doc.querySelector('[data-section="x-search"]').click();
    assert.equal(doc.querySelector('#x-search-enabled').checked, false);
    assert.equal(doc.querySelector('#x-search-token').value, '');
    const previousFetch = window.fetch;
    window.fetch = async (url, options = {}) => {
      if (!String(url).includes('/api/x-search')) return previousFetch(url, options);
      calls.push({ url, body: options.body ? JSON.parse(options.body) : null });
      return { ok: true, status: 200, json: async () => url.includes('/preview')
        ? { page: { user: { name: '<img src=x>', username: 'Example' }, fetchedAt: 'now', posts: [{ text: '<script>bad()</script>', url: 'https://x.com/Example/status/1' }] } }
        : { settings: { enabled: true, hasBearerToken: true } } };
    };
    doc.querySelector('#x-search-token').value = 'test-x-token';
    doc.querySelector('#save-cfg-btn').click(); await settle(50);
    assert.equal(calls[0].url, '/api/x-search/settings');
    assert.equal(calls[0].body.bearerToken, 'test-x-token');
    assert.equal(doc.querySelector('#x-search-token').value, '');
    assert.match(doc.querySelector('#x-search-token-label').textContent, /已保存/);
    doc.querySelector('#save-cfg-btn').click(); await settle(50);
    assert.equal(Object.hasOwn(calls[1].body, 'bearerToken'), false, '留空不会清除Token');
    doc.querySelector('#x-search-preview-user').value = 'Example';
    doc.querySelector('#x-search-preview').click(); await settle(50);
    assert.equal(calls[2].url, '/api/x-search/preview');
    assert.equal(doc.querySelector('#x-search-preview-result script'), null);
    assert.equal(doc.querySelector('#x-search-preview-result img'), null);
    assert.match(doc.querySelector('#x-search-preview-result').textContent, /bad/);
    assert.deepEqual(errors, []);
  } finally { window.happyDOM?.abort?.(); }
});

test('外观系统可即时切换、保存并恢复默认', { skip: SKIP }, async () => {
  const { window, errors } = loadPage();
  await settle();
  try {
    const doc = window.document;
    doc.querySelector('[data-tab="settings"]').click();
    await settle(60);
    doc.querySelector('#settings-sidebar [data-section="appearance"]').click();
    assert.ok(doc.querySelector('#view-settings').classList.contains('active'));
    assert.equal(doc.querySelector('[data-global-admin-settings]'), null);
    assert.ok(doc.querySelector('[data-appearance-preset="ocean"]'));
    assert.ok(doc.querySelector('.appearance-live-preview .appearance-option'));
    assert.equal(doc.querySelector('.appearance-advanced').open, false);
    assert.deepEqual(errors, []);
    doc.querySelector('[data-appearance-preset="aurora"]').click();
    assert.deepEqual(errors, []);
    assert.equal(doc.documentElement.dataset.backdrop, 'glow');
    assert.equal(doc.documentElement.dataset.surface, 'glass');
    assert.equal(doc.documentElement.dataset.accent, 'violet');
    assert.equal(doc.documentElement.dataset.theme, 'dark');
    doc.querySelector('[data-appearance-key="accent"][data-appearance-value="emerald"]').click();
    assert.equal(doc.documentElement.dataset.accent, 'emerald');
    assert.equal(JSON.parse(window.localStorage.getItem('qqa-appearance-v1')).accent, 'emerald');
    const customAccent = doc.querySelector('[data-appearance-color="accentColor"]');
    customAccent.value = '#123abc';
    customAccent.dispatchEvent(new window.Event('change', { bubbles: true }));
    assert.equal(doc.documentElement.dataset.accent, 'custom');
    assert.equal(doc.documentElement.style.getPropertyValue('--accent'), '#123abc');
    doc.querySelector('[data-appearance-key="hover"][data-appearance-value="glow"]').click();
    doc.querySelector('[data-appearance-key="click"][data-appearance-value="spark"]').click();
    doc.querySelector('[data-appearance-key="trail"][data-appearance-value="dots"]').click();
    assert.equal(doc.documentElement.dataset.hover, 'glow');
    assert.equal(doc.documentElement.dataset.click, 'spark');
    assert.equal(doc.documentElement.dataset.trail, 'dots');
    window.initAppearance();
    const move = new window.Event('pointermove', { bubbles: true });
    Object.defineProperties(move, { clientX: { value: 210 }, clientY: { value: 130 }, pointerType: { value: 'mouse' } });
    doc.dispatchEvent(move);
    assert.ok(doc.querySelector('.appearance-trail'));
    doc.querySelector('[data-appearance-key="trail"][data-appearance-value="line"]').click();
    const moveTo = (x, y) => {
      const event = new window.Event('pointermove', { bubbles: true });
      Object.defineProperties(event, { clientX: { value: x }, clientY: { value: y }, pointerType: { value: 'mouse' } });
      doc.dispatchEvent(event);
    };
    await settle(18);
    moveTo(220, 140);
    await settle(18);
    moveTo(260, 160);
    const line = doc.querySelector('.appearance-trail-segment.trail-line');
    assert.ok(line, '连续光线应连接相邻鼠标位置');
    assert.ok(Number.parseFloat(line.style.width) > 40);
    doc.querySelector('[data-appearance-key="trail"][data-appearance-value="ribbon"]').click();
    await settle(18);
    moveTo(280, 170);
    await settle(18);
    moveTo(320, 190);
    assert.ok(doc.querySelector('.appearance-trail-segment.trail-ribbon'), '柔光丝带应有连续线段');
    const press = new window.Event('pointerdown', { bubbles: true });
    Object.defineProperties(press, { clientX: { value: 210 }, clientY: { value: 130 } });
    doc.querySelector('[data-appearance-reset]').dispatchEvent(press);
    assert.equal(doc.querySelectorAll('.appearance-click-spark').length, 6);
    const trailColor = doc.querySelector('[data-appearance-color="trailColor"]');
    trailColor.value = '#ff8844';
    trailColor.dispatchEvent(new window.Event('change', { bubbles: true }));
    assert.equal(doc.documentElement.style.getPropertyValue('--trail-color'), '#ff8844');
    doc.querySelector('.appearance-advanced').open = true;
    doc.querySelector('[data-appearance-key="layout"][data-appearance-value="wide"]').click();
    assert.equal(doc.documentElement.dataset.layout, 'wide');
    assert.equal(doc.querySelector('.appearance-advanced').open, true);
    doc.querySelector('[data-appearance-theme="light"]').click();
    assert.equal(doc.documentElement.dataset.theme, 'light');
    doc.querySelector('[data-appearance-reset]').click();
    assert.equal(doc.documentElement.dataset.backdrop, 'mist');
    assert.equal(doc.documentElement.dataset.accent, 'blue');
    assert.equal(doc.documentElement.dataset.theme, 'dark');
    assert.equal(doc.documentElement.dataset.trail, 'off');
    assert.deepEqual(errors, []);
  } finally { window.happyDOM?.abort?.(); }
});

test('真实 DOM 冒烟：api() 走 fetch 桩', { skip: SKIP }, async () => {
  const { window, fetchLog } = loadPage();
  await settle();
  try {
    const data = await window.api('/api/smoke-probe');
    assert.ok(fetchLog.includes('/api/smoke-probe'), `fetch 桩应收到调用，实际：${fetchLog.slice(0, 5).join(', ')}`);
    assert.deepEqual(data, {}, '桩返回空对象');
  } finally { window.happyDOM?.abort?.(); }
});

test('真实 DOM 冒烟：登录表单提交打到 /api/login 且不抛', { skip: SKIP }, async () => {
  const { window, fetchLog } = loadPage();
  await settle();
  try {
    const form = window.document.querySelector('#console-login-form');
    assert.ok(form, 'index.html 应含 #console-login-form');
    const input = form.querySelector('input');
    if (input) input.value = 'smoke-token';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await settle(150);
    assert.ok(fetchLog.some((u) => u.includes('/api/login')), `提交应请求 /api/login，实际：${fetchLog.slice(0, 6).join(', ')}`);
  } finally { window.happyDOM?.abort?.(); }
});

// 去插件化（§11 C2）之后的交互层覆盖：render-test 只验"渲染不抛"，这里验"钩子真的改写了输出"。
// 这条断言的由来：stable-features.js 原先靠 `window[name] = wrapped` 包裹渲染函数，
// 改成 QARegistry 注册后，"注册了但没人调用"会变成静默失效 —— 页面照常渲染，只是改造没了。
test('真实 DOM 冒烟：QARegistry 的 transform / after / override 真的接上了渲染入口', { skip: SKIP }, async () => {
  const { window } = loadPage();
  await settle();
  try {
    const { QARegistry } = window;
    assert.ok(QARegistry, 'index.html 必须先加载 core/registry.js');

    const cfg = {
      identityPilot: { enabled: false, graduated: false },
      slangPilot: {}, incidentPilot: {},
      api: {}, allow: {}, server: {}, runtime: {}
    };

    // ① transform：返回值被钩子改写（stable-features 的"摘掉已转正/退役控件"走的就是这条）
    const before = window.renderExperimentalSettingsSection(cfg);
    assert.ok(typeof before === 'string' && before.length > 0, '原实现应返回 html');
    QARegistry.onTransform('renderExperimentalSettingsSection', (html) => `${html}<!--smoke-transform-->`);
    const after = window.renderExperimentalSettingsSection(cfg);
    assert.ok(after.includes('<!--smoke-transform-->') && !before.includes('<!--smoke-transform-->'),
      '注册 transform 后，渲染函数的输出应被改写');

    // ② after：原实现跑完后触发（stable-features 在此挂"全局管理员"面板）
    // 注意：app.js 的 `const state` 是全局**词法**绑定，不挂 window（只有函数声明会挂），
    // 所以这里不能写 window.state.xxx —— 渲染函数自己闭包取 state 就行。
    let afterCalls = 0;
    QARegistry.onAfter('renderIdentityFeaturePage', () => { afterCalls += 1; });
    window.renderIdentityFeaturePage({ active: true, people: 0, aliases: 0, sources: 0, legacyMemories: 0, friends: 0 }, [], []);
    assert.equal(afterCalls, 1, 'after 钩子应在渲染函数返回后触发一次');

    // ③ override：整体接管（status-refresh.js 接管 refreshStatus 走的就是这条）
    QARegistry.override('refreshStatus', async () => 'smoke-override');
    assert.equal(await window.refreshStatus(), 'smoke-override', 'override 应接管全局入口');
    assert.equal(typeof QARegistry.base('refreshStatus'), 'function', 'override 之后仍能取回原实现');
  } finally { window.happyDOM?.abort?.(); }
});
