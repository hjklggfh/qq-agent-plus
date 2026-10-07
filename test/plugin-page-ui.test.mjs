// 插件页的**内容级**用例（ui-smoke 只保证"切到这一页不抛"，而它对 /api/plugins 返回 {}，
// 所以只走了空列表那条路）。
//
// 为什么值得单独写：这一页是运维增删插件的**唯一**界面，而 2026-10-08 这次加的三样东西
// （插件根编辑器、来源徽标、「移除 / 移除并删数据」）全是交互控件 —— 渲染不出来或按钮接错了
// 动作，就等于功能不存在。`ui/` 的其余门禁（ui-modules / ui-module-graph / render-test）
// 都看不出这一类错。
//
// 缺 happy-dom 时自动跳过（与 ui-smoke 同一条 D6 约定：更新器环境 --omit=dev）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';
import { toClassicScript } from './helpers/ui-module-source.mjs';

let WindowClass = null;
try {
  ({ Window: WindowClass } = await import('happy-dom'));
} catch (error) {
  if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
}
const SKIP = WindowClass ? false : 'happy-dom 未安装（devDependencies；--omit=dev 环境按约定跳过）';

const UI = path.resolve('ui');
const RAW_HTML = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
const SCRIPT_FILES = [...RAW_HTML.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1].replace(/^\//, ''));

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

/** 一份贴近服务端真实形状的 /api/plugins 响应。 */
function payload() {
  return {
    roots: ['/srv/qq-agent/plugins', '/srv/qq-agent/app/plugins'],
    rootInfo: [
      { path: '/srv/qq-agent/plugins', bundled: false, exists: true },
      { path: '/srv/qq-agent/app/plugins', bundled: true, exists: true }
    ],
    maxRoots: 5,
    enabled: ['mine'],
    capabilities: [
      { id: 'chat:send-image', label: '发送图片', risk: 'medium', summary: '发图片' }
    ],
    plugins: [
      {
        id: 'mine', name: '我自己的插件', version: '2.0.0', status: 'loaded',
        reason: '', dir: '/srv/qq-agent/plugins/mine', root: '/srv/qq-agent/plugins', bundled: false,
        capabilities: ['chat:send-image'], tools: ['mine_pic'],
        enabled: true, needsRestart: false, stateDirExists: true, settings: {}, secretFields: [],
        approved: { version: '2.0.0', capabilities: ['chat:send-image'], tools: ['mine_pic'] },
        approvedMatches: true, loadedInProcess: true
      },
      {
        id: 'hello', name: '示例', version: '1.0.0', status: 'disabled',
        reason: '未在 plugins.enabled 里启用', dir: '/srv/qq-agent/app/plugins/hello',
        root: '/srv/qq-agent/app/plugins', bundled: true,
        capabilities: [], tools: ['hello_count'], enabled: false, needsRestart: false,
        stateDirExists: false, settings: {}, secretFields: [], approved: null,
        approvedMatches: false, loadedInProcess: false
      },
      {
        id: 'ghost', name: 'ghost', version: '', status: 'missing',
        reason: '已启用，但在任何插件根里都没找到这个 id', dir: '', root: '', bundled: false,
        capabilities: [], tools: [], enabled: true, needsRestart: false,
        stateDirExists: false, settings: {}, secretFields: [], approved: null,
        approvedMatches: false, loadedInProcess: false
      }
    ]
  };
}

function loadPage() {
  const window = new WindowClass({ url: 'http://127.0.0.1:3210/' });
  window.document.write(RAW_HTML.replace(/<script[^>]*>\s*<\/script>/g, ''));
  const posts = [];
  window.fetch = async (url, options = {}) => {
    const target = String(url);
    const body = options?.body ? JSON.parse(String(options.body)) : null;
    if (options?.method === 'POST') {
      posts.push({ url: target, body });
      // 写入类路由回的是"最新整份快照"，这里就回同一份，模拟服务端行为
      return { ok: true, status: 200, json: async () => ({ ok: true, ...payload() }) };
    }
    return { ok: true, status: 200, json: async () => payload() };
  };
  window.EventSource = class EventSourceStub {
    constructor() { this.readyState = 0; }
    addEventListener() {}
    close() {}
  };
  const ctx = vm.createContext(window);
  for (const file of SCRIPT_FILES) {
    const raw = fs.readFileSync(path.join(UI, file), 'utf8');
    new vm.Script(toClassicScript(raw, file), { filename: `ui/${file}` }).runInContext(ctx);
  }
  return { window, posts };
}

async function openPluginsTab() {
  const harness = loadPage();
  await settle(120);
  harness.window.switchTab('plugins');
  await settle(150);
  return harness;
}

test('插件页：列表渲染出来源徽标，并区分「随版本发布」与「自建」', { skip: SKIP }, async () => {
  const { window } = await openPluginsTab();
  try {
    const text = window.document.querySelector('#plugin-page').textContent;
    assert.ok(text.includes('mine') && text.includes('hello'), `列表应含两个插件：${text.slice(0, 200)}`);
    const badges = [...window.document.querySelectorAll('#plugin-page .plugin-src')].map((el) => el.textContent.trim());
    assert.ok(badges.includes('自建'), `自建插件应有「自建」徽标，实际 ${JSON.stringify(badges)}`);
    assert.ok(badges.includes('随版本发布'), `随版本发布的插件应有对应徽标，实际 ${JSON.stringify(badges)}`);
  } finally { window.happyDOM?.abort?.(); }
});

test('插件页：「移除并删数据」只在真有状态目录时出现；missing 行不给「设置」', { skip: SKIP }, async () => {
  const { window } = await openPluginsTab();
  try {
    const rows = [...window.document.querySelectorAll('#plugin-page tbody tr')];
    const rowOf = (id) => rows.find((tr) => tr.textContent.includes(id));
    const actions = (tr) => [...tr.querySelectorAll('[data-plugin-action]')].map((b) => b.dataset.pluginAction + (b.dataset.pluginPurge ? ':purge' : ''));

    assert.ok(actions(rowOf('mine')).includes('remove:purge'), '有状态目录的插件应给「移除并删数据」');
    assert.ok(!actions(rowOf('hello')).includes('remove:purge'), '没有状态目录的插件不该给「移除并删数据」');
    assert.ok(actions(rowOf('ghost')).includes('remove'), 'missing 行也要能移除（这正是清残留的入口）');
    assert.ok(!actions(rowOf('ghost')).includes('settings'), 'missing 行不给「设置」——那个请求必然失败');
  } finally { window.happyDOM?.abort?.(); }
});

test('插件页：插件根编辑器列出各根的状态，保存时按行提交', { skip: SKIP }, async () => {
  const { window, posts } = await openPluginsTab();
  try {
    const box = window.document.querySelector('#plugin-roots-box');
    assert.ok(box.textContent.includes('/srv/qq-agent/plugins'), `应列出已有根：${box.textContent.slice(0, 200)}`);
    assert.ok(box.textContent.includes('随版本发布'), '随版本发布的那个根要有标记');

    // 点「编辑插件根」→ 文本域出现 → 改内容 → 保存
    box.querySelector('[data-plugin-action="roots-edit"]').click();
    await settle(60);
    const area = window.document.querySelector('#plugin-roots-text');
    assert.ok(area, '编辑态应渲染文本域');
    area.value = '/srv/qq-agent/plugins\n  /srv/qq-agent/extra  \n\n';
    box.querySelector('[data-plugin-action="roots-save"]').click();
    await settle(120);

    const saved = posts.find((p) => p.url === '/api/plugins/roots');
    assert.ok(saved, `应 POST /api/plugins/roots，实际 ${JSON.stringify(posts.map((p) => p.url))}`);
    assert.deepEqual(saved.body.roots, ['/srv/qq-agent/plugins', '/srv/qq-agent/extra'],
      '空行要去掉、每行两端空白要去掉');
  } finally { window.happyDOM?.abort?.(); }
});

test('插件页：「移除」要先确认，确认后带 purgeState 提交', { skip: SKIP }, async () => {
  const { window, posts } = await openPluginsTab();
  try {
    const row = [...window.document.querySelectorAll('#plugin-page tbody tr')]
      .find((tr) => tr.textContent.includes('mine'));
    const button = [...row.querySelectorAll('[data-plugin-action="remove"]')]
      .find((b) => b.dataset.pluginPurge === 'true');
    button.click();
    await settle(80);

    // askForConfirmation 是会等待的模态：没点确认之前不该发出任何请求
    assert.equal(posts.some((p) => p.url === '/api/plugins/remove'), false,
      '确认之前不许发请求（这条正是"不 await Promise 就等于不问就删"那个 bug 的哨兵）');
    const accept = window.document.querySelector('[data-confirm-accept]');
    assert.ok(accept, '应弹出确认框');
    accept.click();
    await settle(150);

    const removed = posts.find((p) => p.url === '/api/plugins/remove');
    assert.ok(removed, '确认后应 POST /api/plugins/remove');
    assert.deepEqual(removed.body, { id: 'mine', purgeState: true });
  } finally { window.happyDOM?.abort?.(); }
});
