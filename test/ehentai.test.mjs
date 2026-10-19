import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ehentaiCommand } from '../src/features/ehentai/command.js';
import { validateEhentaiPatch } from '../src/features/ehentai/config.js';
import { EhentaiManager } from '../src/features/ehentai/manager.js';
import { EhentaiDirect } from '../src/features/ehentai/direct.js';
import { imageUrl, parseGallery, parseImagePage, parseListing, reloadImagePage, searchUrl } from '../src/features/ehentai/site.js';
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
  assert.equal(reloadImagePage('<a id="loadfail" onclick="return nl(\'123-456\')">Reload</a>', 'https://e-hentai.org/s/abc123/123-1'), 'https://e-hentai.org/s/abc123/123-1?nl=123-456');
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

test('单个直连 IP 超时后切换到下一个 IP', async () => {
  const tried = [];
  class ProbeDirect extends EhentaiDirect {
    async attempt(_url, { signal }, ip) {
      tried.push(ip);
      if (ip === '172.66.132.196') {
        await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }
      return new Response('ok');
    }
  }
  const direct = new ProbeDirect(['172.66.132.196', '172.66.140.62'], { attemptTimeoutMs: 20 });
  try {
    const response = await direct.fetch('https://e-hentai.org/', { signal: AbortSignal.timeout(500), headers: {}, limit: 100 });
    assert.equal(await response.text(), 'ok');
    assert.deepEqual(tried, ['172.66.132.196', '172.66.140.62']);
  } finally { direct.close(); }
});

test('坏图重载优先换新节点，跳过已失败的 CDN 节点', async () => {
  const root = fs.mkdtempSync(path.join(testRoot, 'ehentai-reload-'));
  const attempted = [];
  let pageReads = 0;
  const link = 'https://e-hentai.org/s/abc123/123-1';
  const manager = new EhentaiManager({ dataDir: root,
    getConfig: () => ({ ehentai: { enabled: true }, admin: { ownerUin: '123456' } }), canRun: () => true,
    fetchImpl: async (url) => {
      if (String(url).startsWith(link)) {
        const host = ['a', 'b', 'a', 'b', 'c'][Math.min(pageReads++, 4)];
        return new Response(`<img id="img" src="https://${host}.hath.network${host === 'c' ? '' : ':9362'}/1.png"><a id="loadfail" onclick="return nl('123-456')">Reload</a>`);
      }
      const host = new URL(url).hostname[0]; attempted.push(host);
      return host === 'c' ? new Response(Buffer.from('89504e470d0a1a0a', 'hex')) : new Response(null, { status: 204 });
    }
  });
  try {
    const result = await manager.downloadImage(link, 0, manager.settings(), AbortSignal.timeout(3000), new EhentaiDirect(['172.66.140.62']));
    assert.equal(result.type, 'image/png');
    assert.deepEqual(attempted, ['a', 'b', 'c']);
  } finally { manager.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('失败后用普通重新加载换节点，而不是锁在 ?nl= 池里', async () => {
  const root = fs.mkdtempSync(path.join(testRoot, 'ehentai-reroll-'));
  const pageUrls = [], attempted = [];
  const link = 'https://e-hentai.org/s/abc123/123-1';
  const manager = new EhentaiManager({ dataDir: root,
    getConfig: () => ({ ehentai: { enabled: true }, admin: { ownerUin: '123456' } }), canRun: () => true,
    fetchImpl: async (url) => {
      const value = String(url);
      if (value.startsWith(link)) {
        pageUrls.push(value);
        // 前两次都分到 9362 高端口，第三次才分到 443 的站方节点。
        const host = ['muudapi.dvubzogrfhrd.hath.network:9362', 'muudapi.dvubzogrfhrd.hath.network:9362', 'zurswtyclg.hath.network'][pageUrls.length - 1];
        return new Response(`<img id="img" src="https://${host}/1.webp"><a id="loadfail" onclick="return nl('123-456')">Reload</a>`);
      }
      attempted.push(new URL(url).host);
      return new URL(url).host === 'zurswtyclg.hath.network'
        ? new Response(Buffer.from('89504e470d0a1a0a', 'hex'))
        : new Response(null, { status: 204 });
    }
  });
  try {
    const result = await manager.downloadImage(link, 21, manager.settings(), AbortSignal.timeout(3000), new EhentaiDirect(['172.66.140.62']));
    assert.equal(result.type, 'image/png');
    assert.deepEqual(attempted, ['muudapi.dvubzogrfhrd.hath.network:9362', 'zurswtyclg.hath.network']);
    assert.equal(pageUrls.length, 3);
    assert.ok(pageUrls.every((url) => !url.includes('nl=')), '普通重载已经能换节点时不应消耗 nl 额度');
  } finally { manager.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('普通重载反复拿不到新节点时才用一次 nl 换池', async () => {
  const root = fs.mkdtempSync(path.join(testRoot, 'ehentai-nl-'));
  const pageUrls = [], attempted = [];
  const link = 'https://e-hentai.org/s/abc123/123-1';
  const manager = new EhentaiManager({ dataDir: root,
    getConfig: () => ({ ehentai: { enabled: true }, admin: { ownerUin: '123456' } }), canRun: () => true,
    fetchImpl: async (url) => {
      const value = String(url);
      if (value.startsWith(link)) {
        pageUrls.push(value);
        const host = value.includes('?nl=') ? 'relay.hath.network' : 'dead.hath.network:9362';
        return new Response(`<img id="img" src="https://${host}/1.webp"><a id="loadfail" onclick="return nl('123-456')">Reload</a>`);
      }
      attempted.push(new URL(url).host);
      return new URL(url).host === 'relay.hath.network'
        ? new Response(Buffer.from('89504e470d0a1a0a', 'hex'))
        : new Response(null, { status: 204 });
    }
  });
  try {
    const result = await manager.downloadImage(link, 4, manager.settings(), AbortSignal.timeout(3000), new EhentaiDirect(['172.66.140.62']));
    assert.equal(result.type, 'image/png');
    assert.deepEqual(attempted, ['dead.hath.network:9362', 'relay.hath.network']);
    assert.equal(pageUrls.filter((url) => url.includes('?nl=')).length, 1, 'nl 只作为最后手段用一次');
    assert.ok(pageUrls[0].endsWith(link) && pageUrls[1].endsWith(link));
  } finally { manager.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('同一坏节点反复出现时继续找新节点，偶发失败不永久拉黑', async () => {
  const root = fs.mkdtempSync(path.join(testRoot, 'ehentai-stale-'));
  const link = 'https://e-hentai.org/s/abc123/123-1';
  const health = new Map();
  let loads = 0, badDownloads = 0, goodDownloads = 0;
  const manager = new EhentaiManager({ dataDir: root,
    getConfig: () => ({ ehentai: { enabled: true }, admin: { ownerUin: '123456' } }), canRun: () => true,
    fetchImpl: async (url) => {
      if (String(url).startsWith(link)) {
        loads++;
        const host = loads < 22 ? 'bad' : 'good';
        return new Response(`<img id="img" src="https://${host}.hath.network/1.png">`);
      }
      if (String(url).includes('bad.hath.network')) { badDownloads++; throw new Error('timeout'); }
      goodDownloads++;
      return new Response(Buffer.from('89504e470d0a1a0a', 'hex'));
    }
  });
  try {
    const result = await manager.downloadImage(link, 0, manager.settings(), AbortSignal.timeout(3000), null, health);
    assert.equal(result.type, 'image/png');
    assert.equal(loads, 22);
    assert.equal(badDownloads, 2);
    assert.equal(goodDownloads, 1);
    assert.equal(health.get('bad.hath.network'), 2);
    assert.equal(health.has('good.hath.network'), false);
  } finally { manager.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('检索分页与序号 PDF 发送经过当前会话，缺页不会发送', async () => {
  const root = fs.mkdtempSync(path.join(testRoot, 'ehentai-flow-'));
  const sent = [], uploads = [];
  let imageAttempts = 0;
  let imagePageLoads = 0;
  const galleryUrl = 'https://e-hentai.org/g/123/abc123/';
  const listHtml = `<table class="itg">${Array.from({ length: 20 }, (_, i) => `<tr><td><a href="https://e-hentai.org/g/${123 + i}/abc123/"><div class="glink">作品${i + 1}</div></a><div title="2026-10-18 11:00">1 pages</div></td></tr>`).join('')}</table>`;
  const fetchImpl = async (url) => {
    const value = String(url);
    if (value.includes('f_search=')) return new Response(listHtml);
    if (value.startsWith('https://e-hentai.org/g/999/abc123/')) return new Response('<div id="gn">缺页</div><div id="gdd">2 pages</div><div id="gdt"><a href="https://e-hentai.org/s/abc123/999-1">1</a></div>');
    if (value === galleryUrl) return new Response('<div id="gn">作品1</div><div id="gdd">1 pages</div><div id="gdt"><a href="https://e-hentai.org/s/abc123/123-1">1</a></div>');
    if (value.includes('/s/abc123/')) {
      imagePageLoads++;
      return new Response(`<img id="img" src="https://${imagePageLoads === 1 ? 'a' : 'b'}.hath.network/1.png"><a id="loadfail" onclick="return nl('123-456')">Reload</a>`);
    }
    if (value.includes('a.hath.network') || value.includes('b.hath.network')) {
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
    assert.equal(imagePageLoads, 2, '第一次分到的节点失败后，普通重载换到新节点直接成功');
    assert.deepEqual(sent.slice(3, 7).map((entry) => entry.text.split(' ')[0]), ['🔍', '📥', '🖼', '📤']);
    assert.equal(uploads[0].chatKey, 'private:123456');
    assert.match(uploads[0].name, /^E站-123-/);
    assert.ok(fs.existsSync(path.join(root, 'ehentai', 'pdf', '123-abc123.pdf')));
    manager.lists.set('private:123456', { kind: 'search', items: [{ url: 'https://e-hentai.org/g/999/abc123/', title: '缺页', pages: 2 }], page: 1, at: Date.now() });
    const missing = await manager.handle({ kind: 'select', index: 1 }, 'private:123456', '5');
    assert.match(missing.error, /不完整/);
    assert.equal(uploads.length, 1);
  } finally { manager.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('多页图片限量并行下载且 PDF 页序不变', async () => {
  const root = fs.mkdtempSync(path.join(testRoot, 'ehentai-parallel-'));
  const sent = [];
  let active = 0, peak = 0;
  const gallery = 'https://e-hentai.org/g/456/abc123/';
  const links = Array.from({ length: 12 }, (_, i) => `https://e-hentai.org/s/abc123/456-${i + 1}`);
  const manager = new EhentaiManager({ dataDir: root,
    getConfig: () => ({ ehentai: { enabled: true }, admin: { ownerUin: '123456' } }), canRun: () => true,
    fetchImpl: async (url) => {
      if (url === gallery) return new Response(`<div id="gn">并行作品</div><div id="gdd">12 pages</div><div id="gdt">${links.map((link) => `<a href="${link}">页</a>`).join('')}</div>`);
      const page = links.indexOf(url);
      if (page >= 0) return new Response(`<img id="img" src="https://a.hath.network/${page + 1}.png">`);
      if (String(url).startsWith('https://a.hath.network/')) {
        active++; peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 25));
        active--;
        return new Response(Buffer.from('89504e470d0a1a0a', 'hex'));
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
    send: async (_chat, messages) => sent.push(messages[0]),
    file: async (_chat, payload) => assert.ok(fs.existsSync(payload.file)),
    buildPdf: async ({ files, output }) => {
      assert.deepEqual(files.map((file) => file.page), Array.from({ length: 12 }, (_, i) => i + 1));
      fs.writeFileSync(output, '%PDF-1.4'); return { file: output, bytes: 8 };
    }
  });
  try {
    manager.active = { chatKey: 'private:123456', file: null, job: null, abort: () => {} };
    await manager.downloadPdf('private:123456', { url: gallery, title: '并行作品', pages: 12 }, 'parallel', AbortSignal.timeout(1000));
    assert.equal(peak, 3);
    assert.deepEqual(sent.map((message) => message.split(' ')[0]), ['🔍', '📥', '📥', '🖼', '📤']);
    assert.match(sent[2], /10\/12/);
  } finally { manager.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('下载失败后保留已完成图片，重新请求时续传并清理缓存', async () => {
  const root = fs.mkdtempSync(path.join(testRoot, 'ehentai-resume-'));
  const gallery = 'https://e-hentai.org/g/789/abc123/';
  const links = Array.from({ length: 3 }, (_, i) => `https://e-hentai.org/s/abc123/789-${i + 1}`);
  const requested = [0, 0, 0], sent = [];
  let failThird = true, uploads = 0;
  const manager = new EhentaiManager({ dataDir: root,
    getConfig: () => ({ ehentai: { enabled: true }, admin: { ownerUin: '123456' } }), canRun: () => true,
    fetchImpl: async (url) => {
      if (url === gallery) return new Response(`<div id="gn">续传作品</div><div id="gdd">3 pages</div><div id="gdt">${links.map((link) => `<a href="${link}">页</a>`).join('')}</div>`);
      const page = links.indexOf(url);
      if (page >= 0) return new Response(`<img id="img" src="https://a.hath.network/${page + 1}.png">`);
      const image = String(url).match(/https:\/\/a\.hath\.network\/(\d)\.png/);
      if (image) {
        const index = Number(image[1]) - 1; requested[index]++;
        if (index === 2 && failThird) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          throw new Error('超过大小上限');
        }
        return new Response(Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(600)]));
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
    send: async (_chat, messages) => sent.push(messages[0]),
    file: async () => { uploads++; },
    buildPdf: async ({ files, output }) => {
      assert.deepEqual(files.map((file) => file.page), [1, 2, 3]);
      fs.writeFileSync(output, '%PDF-1.4'); return { file: output, bytes: 8 };
    }
  });
  try {
    manager.active = { chatKey: 'private:123456', file: null, job: null, cache: null, abort: () => {} };
    await assert.rejects(manager.downloadPdf('private:123456', { url: gallery, title: '续传作品', pages: 3 }, 'first', AbortSignal.timeout(1000)), /超过大小上限/);
    assert.deepEqual(requested, [1, 1, 1]);
    assert.equal(uploads, 0);
    failThird = false;
    await manager.downloadPdf('private:123456', { url: gallery, title: '续传作品', pages: 3 }, 'second', AbortSignal.timeout(1000));
    assert.deepEqual(requested, [1, 1, 2]);
    assert.ok(sent.some((message) => message.includes('已缓存 2 张')));
    assert.equal(uploads, 1);
    assert.equal(fs.existsSync(path.join(root, 'ehentai', 'cache', '789-abc123')), false);
  } finally { manager.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});
