import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { toClassicScript } from './helpers/ui-module-source.mjs';
let WindowClass;
try { ({ Window: WindowClass } = await import('happy-dom')); } catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; }
const skip = WindowClass ? false : 'happy-dom未安装';
function page(t) {
  const window = new WindowClass(); t.after(() => window.happyDOM.abort());
  const calls = [], state = { config: { pixiv: { enabled: true, hasCookie: true, chatRatings: { 'group:100001': ['r18'] } } } };
  const api = async (url, options) => { calls.push({ url, options }); return { settings: options ? JSON.parse(options.body) : state.config.pixiv, overrides: {}, history: [], running: false }; };
  const context = vm.createContext({ state, api, window, $: (s) => window.document.querySelector(s), esc: (v) => String(v).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;') });
  vm.runInContext(toClassicScript(fs.readFileSync(new URL('../ui/pages/pixiv.js', import.meta.url), 'utf8')), context);
  window.document.body.innerHTML = vm.runInContext('renderPixivSection(state.config)', context) + '<span id="cfg-save-result"></span>';
  return { window, doc: window.document, calls, context };
}
test('独立PID设置呈现会话分级、多页分批、核实作品入口，凭据为空', { skip }, (t) => {
  const { doc } = page(t);
  assert.equal(doc.querySelector('#pixiv-enabled').checked, true);
  assert.equal(doc.querySelector('.pixiv-chat-id').value, '100001');
  assert.equal(doc.querySelector('#pixiv-cookie').type, 'password'); assert.equal(doc.querySelector('#pixiv-cookie').value, '');
  assert.ok(doc.querySelector('#pixiv-mark-save')); assert.ok(doc.querySelector('#pixiv-batch-pages'));
});
test('保存只发PID设置，空凭据保留；非法群号不得显示保存成功', { skip }, async (t) => {
  const { doc, calls, context } = page(t);
  await vm.runInContext('savePixivSettings()', context);
  const patch = JSON.parse(calls[0].options.body);
  assert.equal(calls[0].url, '/api/pixiv/settings'); assert.equal('cookie' in patch, false); assert.equal('proxyUrl' in patch, false);
  doc.querySelector('.pixiv-chat-id').value = 'invalid';
  await assert.rejects(vm.runInContext('savePixivSettings()', context));
  assert.doesNotMatch(doc.querySelector('#cfg-save-result').textContent, /成功|已保存/);
});
test('刷新任务不能覆盖正在输入的会话分级或网络设置', { skip }, async (t) => {
  const { doc, context } = page(t);
  doc.querySelector('#pixiv-metadata').value = 'https://example.test/{pid}';
  vm.runInContext('bindPixivSection()', context); await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(doc.querySelector('#pixiv-metadata').value, 'https://example.test/{pid}');
  assert.match(doc.querySelector('#pixiv-records').textContent, /当前空闲/);
});
