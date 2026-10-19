import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ehentaiCommand } from '../src/features/ehentai/command.js';
import { validateEhentaiPatch } from '../src/features/ehentai/config.js';
import { EhentaiManager } from '../src/features/ehentai/manager.js';
import { imageUrl, parseGallery, parseImagePage, parseListing, searchUrl } from '../src/features/ehentai/site.js';
const testRoot = path.join(process.cwd(), 'data', '.ehentai-tests');
fs.mkdirSync(testRoot, { recursive: true });

test('明确指令与会话内数字选择', () => {
  assert.deepEqual(ehentaiCommand('e站搜索：测试'), { kind: 'search', query: '测试' });
  assert.deepEqual(ehentaiCommand('e站每日排行榜'), { kind: 'daily' });
  assert.deepEqual(ehentaiCommand('下一页', true), { kind: 'turn', direction: 1 });
  assert.deepEqual(ehentaiCommand('第2页', true), { kind: 'page', page: 2 });
  assert.deepEqual(ehentaiCommand('10', true), { kind: 'select', index: 10 });
  assert.equal(ehentaiCommand('10', false), null);
  assert.match(searchUrl('female:big breasts', 'tag'), /female%3Abig_breasts%24/);
});

test('只解析站内画廊、页码和可信图片域名', () => {
  const list = `<table class="itg"><tr><td><a href="https://e-hentai.org/g/123/abc123/"><div class="glink">测试作品</div></a><div title="2026-10-18 11:00">12 pages</div></td></tr></table><a href="/?f_search=x&next=123">Next</a>`;
  assert.deepEqual(parseListing(list).items[0], { url: 'https://e-hentai.org/g/123/abc123/', title: '测试作品', date: '2026-10-18 11:00', pages: 12 });
  assert.match(parseListing(list).next, /next=123/);
  const gallery = `<div id="gn">测试作品</div><div id="gdd"><tr><td>12 pages</td></tr></div><div id="gdt"><a href="https://e-hentai.org/s/abc123/123-1">1</a></div>`;
  assert.equal(parseGallery(gallery, 'https://e-hentai.org/g/123/abc123/').pageCount, 12);
  assert.equal(parseImagePage('<img id="img" src="https://a.hath.network/x.jpg">'), 'https://a.hath.network/x.jpg');
  assert.equal(imageUrl('https://127.0.0.1/secret'), '');
  assert.equal(imageUrl('https://ehgt.org/g/509.gif'), '');
});

test('关闭时无文件副作用；开启后按过期时间清理自有 PDF', () => {
  const root = fs.mkdtempSync(path.join(testRoot, 'ehentai-test-'));
  let config = { ehentai: { enabled: false, allowedChats: [] }, admin: { ownerUin: '123456' } };
  const manager = new EhentaiManager({ dataDir: root, getConfig: () => config, canRun: () => true });
  try {
    assert.equal(fs.existsSync(path.join(root, 'ehentai')), false);
    assert.equal(manager.allowed('private:123456'), false);
    config = { ...config, ehentai: { enabled: true, allowedChats: ['group:123456'], keepHours: 1 } };
    manager.sync();
    assert.equal(manager.allowed('private:123456'), true);
    assert.equal(manager.allowed('group:123456'), true);
    const dir = path.join(root, 'ehentai', 'pdf'); fs.mkdirSync(dir, { recursive: true });
    const old = path.join(dir, '123-abc.pdf'); fs.writeFileSync(old, 'pdf');
    fs.utimesSync(old, new Date(Date.now() - 2 * 3600000), new Date(Date.now() - 2 * 3600000));
    const unrelated = path.join(dir, 'other.pdf'); fs.writeFileSync(unrelated, 'untouched');
    manager.sweep();
    assert.equal(fs.existsSync(old), false);
    assert.equal(fs.existsSync(unrelated), true);
    validateEhentaiPatch({ allowedChats: ['group:123456'] });
    assert.throws(() => validateEhentaiPatch({ allowedChats: ['private:http://evil'] }));
    assert.throws(() => validateEhentaiPatch({ directIps: ['127.0.0.1'] }));
  } finally { manager.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('检索分页与序号 PDF 发送经过当前会话，缺页不会发送', async () => {
  const root = fs.mkdtempSync(path.join(testRoot, 'ehentai-flow-'));
  const sent = [], uploads = [];
  let imageAttempts = 0;
  const galleryUrl = 'https://e-hentai.org/g/123/abc123/';
  const listHtml = `<table class="itg">${Array.from({ length: 20 }, (_, i) => `<tr><td><a href="https://e-hentai.org/g/${123 + i}/abc123/"><div class="glink">作品${i + 1}</div></a><div title="2026-10-18 11:00">1 pages</div></td></tr>`).join('')}</table>`;
  const fetchImpl = async (url) => {
    const value = String(url);
    if (value.includes('f_search=')) return new Response(listHtml);
    if (value.startsWith('https://e-hentai.org/g/999/abc123/')) return new Response('<div id="gn">缺页</div><div id="gdd">2 pages</div><div id="gdt"><a href="https://e-hentai.org/s/abc123/999-1">1</a></div>');
    if (value === galleryUrl) return new Response('<div id="gn">作品1</div><div id="gdd">1 pages</div><div id="gdt"><a href="https://e-hentai.org/s/abc123/123-1">1</a></div>');
    if (value.includes('/s/abc123/')) return new Response('<img id="img" src="https://a.hath.network/1.png">');
    if (value.includes('a.hath.network')) {
      imageAttempts++;
      return imageAttempts === 1 ? new Response(null, { status: 204 })
        : new Response(Buffer.from('89504e470d0a1a0a', 'hex'));
    }
    throw new Error(`Unexpected URL: ${value}`);
  };
  const manager = new EhentaiManager({ dataDir: root,
    getConfig: () => ({ ehentai: { enabled: true }, admin: { ownerUin: '123456' } }),
    canRun: () => true, fetchImpl,
    send: async (chatKey, messages) => sent.push({ chatKey, text: messages[0] }),
    file: async (chatKey, payload) => uploads.push({ chatKey, ...payload }),
    buildPdf: async ({ files, output }) => { assert.equal(files.length, 1); fs.writeFileSync(output, '%PDF-1.4'); return { file: output, bytes: 8 }; }
  });
  try {
    assert.deepEqual(await manager.handle(ehentaiCommand('e站搜索：测试'), 'private:123456', '1'), { handled: true });
    assert.equal(sent[0].text.match(/作品\d+/g).length, 10);
    assert.deepEqual(await manager.handle(ehentaiCommand('下一页', true), 'private:123456', '2'), { handled: true });
    assert.match(sent[1].text, /作品11/);
    assert.equal(sent[1].text.match(/作品\d+/g).length, 10);
    assert.deepEqual(await manager.handle(ehentaiCommand('第1页', true), 'private:123456', '3'), { handled: true });
    assert.deepEqual(await manager.handle(ehentaiCommand('1', true), 'private:123456', '4'), { handled: true });
    assert.equal(uploads.length, 1);
    assert.equal(imageAttempts, 2);
    assert.equal(uploads[0].chatKey, 'private:123456');
    assert.match(uploads[0].name, /^E站-123-/);
    assert.ok(fs.existsSync(path.join(root, 'ehentai', 'pdf', '123-abc123.pdf')));
    manager.lists.set('private:123456', { kind: 'search', items: [{ url: 'https://e-hentai.org/g/999/abc123/', title: '缺页', pages: 2 }], page: 1, at: Date.now() });
    const missing = await manager.handle({ kind: 'select', index: 1 }, 'private:123456', '5');
    assert.match(missing.error, /不完整/);
    assert.equal(uploads.length, 1);
  } finally { manager.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});
