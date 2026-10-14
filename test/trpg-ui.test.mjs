import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { toClassicScript } from './helpers/ui-module-source.mjs';
import { TrpgManager } from '../src/features/trpg/manager.js';

let WindowClass;
try { ({ Window: WindowClass } = await import('happy-dom')); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

test('跑团页面：真实表单保存、HTML转义、导入导出及切页草稿保留', { skip: WindowClass ? false : 'happy-dom未安装' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-trpg-ui-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const window = new WindowClass();
  t.after(() => window.happyDOM.abort());
  window.document.write('<div id="trpg-page"></div>');
  const cfg = { trpg: { enabled: false, maxPlayers: 6 } };
  const manager = new TrpgManager({ dataDir: dir, getConfig: () => cfg });
  let exported;
  const context = vm.createContext({
    document: window.document, state: {},
    $: (selector) => window.document.querySelector(selector),
    esc: (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    api: async (route, options) => {
      if (!options) return manager.snapshot();
      const body = JSON.parse(options.body);
      if (route.endsWith('/asset')) return manager.saveAsset(body.kind, body.asset);
      if (route.endsWith('/settings')) { cfg.trpg = body; return { ok: true }; }
      throw new Error('unexpected request');
    },
    askForConfirmation: async () => true,
    URL: { createObjectURL: (blob) => { exported = blob; return 'blob:test'; }, revokeObjectURL: () => {} },
    Blob, setTimeout: () => 0
  });
  const source = fs.readFileSync(new URL('../ui/pages/trpg.js', import.meta.url), 'utf8');
  vm.runInContext(toClassicScript(source), context);
  const run = (code) => vm.runInContext(code, context);
  await run('loadTrpgPage()');
  assert.match(window.document.body.textContent, /跑团工作台/);
  assert.equal(window.document.querySelector('#trpg-enabled').checked, false);
  const form = window.document.querySelector('[data-trpg-form="characters"]');
  form.elements.namedItem('name').value = '<img src=x onerror=alert(1)>';
  form.elements.namedItem('description').value = '谨慎的调查员';
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(manager.snapshot().characters.length, 2);
  assert.equal(window.document.querySelectorAll('#trpg-characters-list img').length, 0);
  assert.match(window.document.querySelector('#trpg-notice').textContent, /已保存/);
  const savedId = form.elements.namedItem('id').value;
  assert.ok(savedId);
  form.elements.namedItem('description').value = '还没保存的新草稿';
  await run('refreshTrpgData()');
  await run('loadTrpgPage()');
  assert.equal(form.elements.namedItem('description').value, '还没保存的新草稿');
  context.importInput = { files: [{ name: '角色.json', size: 500, text: async () => JSON.stringify({ spec: 'chara_card_v2', data: { name: '小岚', description: '旅者', personality: '好奇', scenario: '初到雾港', extensions: { script: 'ignored' } } }) }], dataset: { trpgImport: 'characters' }, value: '' };
  await run('importTrpgCard(importInput)');
  assert.equal(form.elements.namedItem('name').value, '小岚');
  assert.equal(form.elements.namedItem('id').value, '');
  assert.match(form.elements.namedItem('description').value, /好奇/);
  assert.equal(form.elements.namedItem('description').value.includes('ignored'), false);
  await run(`handleTrpgClick({dataset:{trpgAction:'export',kind:'characters',id:${JSON.stringify(savedId)}}})`);
  const parsed = JSON.parse(await exported.text());
  assert.equal(parsed.kind, 'characters');
  assert.equal(parsed.asset.name, '<img src=x onerror=alert(1)>');
  assert.equal(Object.hasOwn(parsed.asset, 'ownerId'), false);
  window.document.querySelector('#trpg-enabled').checked = true;
  window.document.querySelector('#trpg-groups').value = '100001，200001\n100001';
  window.document.querySelector('#trpg-private').value = '123456 234567';
  await run('loadTrpgPage()');
  assert.equal(window.document.querySelector('#trpg-private').value, '123456 234567', '刷新和切页保留白名单草稿');
  await run("handleTrpgClick({dataset:{trpgAction:'settings'}})");
  assert.equal(cfg.trpg.enabled, true);
  assert.deepEqual(cfg.trpg.allowedGroups, ['100001', '200001']);
  assert.deepEqual(cfg.trpg.allowedPrivate, ['123456', '234567']);
});
