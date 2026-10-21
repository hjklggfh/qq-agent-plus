import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { toClassicScript } from './helpers/ui-module-source.mjs';

let WindowClass;
try { ({ Window: WindowClass } = await import('happy-dom')); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
const skip = WindowClass ? false : 'happy-dom 未安装';

function page(t) {
  const window = new WindowClass();
  t.after(() => window.happyDOM.abort());
  const calls = [];
  const state = { config: { imageSearch: { enabled: false, hasRelayToken: true, allowedGroups: [], platforms: { google: true, yandex: true, trace: true } } } };
  const api = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/settings')) return { settings: { ...JSON.parse(options.body), hasRelayToken: true } };
    if (url.endsWith('/health')) return { ok: true, googleConfigured: false };
    return { running: false, history: [{ startedAt: '2026-10-17', chatKey: 'group:100001', status: 'interrupted', platforms: [] }] };
  };
  const context = vm.createContext({ state, api, $: (selector) => window.document.querySelector(selector), esc: (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;') });
  const source = fs.readFileSync(new URL('../ui/pages/image-search.js', import.meta.url), 'utf8');
  vm.runInContext(toClassicScript(source), context);
  window.document.body.innerHTML = vm.runInContext('renderImageSearchSection(state.config)', context) + '<span id="cfg-save-result"></span>';
  return { window, doc: window.document, context, calls, state };
}

test('搜图独立设置渲染默认关闭和四个平台，群名单语义明确', { skip }, (t) => {
  const { doc } = page(t);
  assert.equal(doc.querySelector('#image-search-enabled').checked, false);
  assert.equal(doc.querySelectorAll('[id^="image-search-platform-"]').length, 4);
  assert.equal(doc.querySelector('#image-search-platform-serpapi').checked, false);
  assert.match(doc.body.textContent, /空名单表示所有群均不允许/);
  assert.equal(doc.querySelector('#image-search-token').type, 'password');
  assert.equal(doc.querySelector('#image-search-token').value, '');
});

test('搜图保存仅发自己的补丁，留空保留令牌、显式清除才发空值', { skip }, async (t) => {
  const { doc, context, calls } = page(t);
  doc.querySelector('#image-search-groups').value = '100001\n100001\n100002';
  doc.querySelector('#image-search-images').checked = true;
  await vm.runInContext('saveImageSearchSettings()', context);
  const patch = JSON.parse(calls[0].options.body);
  assert.equal(Object.hasOwn(patch, 'relayToken'), false);
  assert.equal(patch.sendImages, true);
  assert.deepEqual(patch.allowedGroups, ['100001', '100002']);
  assert.equal(Object.hasOwn(patch, 'api'), false);
  assert.equal(calls[0].url, '/api/image-search/settings');
  doc.querySelector('#image-search-clear-token').checked = true;
  await vm.runInContext('saveImageSearchSettings()', context);
  assert.equal(JSON.parse(calls[1].options.body).relayToken, '');
});

test('刷新历史不覆盖正在输入的中转地址，连接测试不声称搜图成功', { skip }, async (t) => {
  const { doc, context } = page(t);
  doc.querySelector('#image-search-url').value = 'http://127.0.0.1:43220';
  vm.runInContext('bindImageSearchSection()', context);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(doc.querySelector('#image-search-history').textContent, /重启中断/);
  doc.querySelector('#image-search-refresh').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(doc.querySelector('#image-search-url').value, 'http://127.0.0.1:43220');
  doc.querySelector('#image-search-health').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(doc.querySelector('#image-search-health-result').textContent, /尚未配置 Google 浏览器/);
  assert.match(doc.querySelector('#image-search-health-result').textContent, /SerpApi 未配置/);
});

test('搜图保存失败向统一保存入口抛错，不能被覆盖为保存成功', { skip }, async (t) => {
  const { doc, context } = page(t);
  context.api = async () => { throw new Error('白名单格式无效'); };
  await assert.rejects(vm.runInContext('saveImageSearchSettings()', context), /白名单格式无效/);
  assert.equal(doc.querySelector('#cfg-save-result').textContent, '白名单格式无效');
});
