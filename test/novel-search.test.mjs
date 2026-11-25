import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_NOVEL_SEARCH_CONFIG,
  novelSearchConfig,
  validateNovelSearchPatch
} from '../src/features/novel-search/config.js';
import { novelSearchCommand } from '../src/features/novel-search/command.js';
import { buildNovelSearchNodes, formatNovelHelp } from '../src/features/novel-search/cards.js';
import { NovelSearchManager } from '../src/features/novel-search/manager.js';

test('novelSearchCommand 解析全源搜索、分源快捷、最新与列表跟进指令', () => {
  assert.equal(novelSearchCommand('今天天气不错', false), null);
  assert.equal(novelSearchCommand('1', false), null);
  assert.equal(novelSearchCommand('下一页', false), null);

  assert.deepEqual(novelSearchCommand('/搜小说'), { kind: 'help' });
  assert.deepEqual(novelSearchCommand('/搜小说 #纯爱 #校园 -NTR'), {
    kind: 'search',
    query: '#纯爱 #校园 -NTR',
    sourceHint: '',
    channelHint: ''
  });
  assert.deepEqual(novelSearchCommand('/P站小说 流萤'), {
    kind: 'search',
    query: '流萤',
    sourceHint: 'pixiv',
    channelHint: ''
  });
  assert.deepEqual(novelSearchCommand('/禁忌书屋 原神'), {
    kind: 'search',
    query: '原神',
    sourceHint: 'cool18',
    channelHint: ''
  });
  assert.deepEqual(novelSearchCommand('/ESJ R18'), {
    kind: 'search',
    query: 'R18',
    sourceHint: 'esjzone',
    channelHint: ''
  });
  assert.deepEqual(novelSearchCommand('/蓝P 流萤'), {
    kind: 'search',
    query: '流萤',
    sourceHint: 'telegram',
    channelHint: 'px_novels'
  });
  assert.deepEqual(novelSearchCommand('/书屋最新'), {
    kind: 'latest',
    sourceHint: 'cool18',
    channelHint: ''
  });
  assert.deepEqual(novelSearchCommand('/小说最新'), {
    kind: 'latest',
    sourceHint: '',
    channelHint: ''
  });

  // 有活跃列表时才接管纯数字与翻页
  assert.deepEqual(novelSearchCommand('3', true), { kind: 'select', index: 3 });
  assert.deepEqual(novelSearchCommand('下一页', true), { kind: 'turn', direction: 1 });
  assert.deepEqual(novelSearchCommand('上一页', true), { kind: 'turn', direction: -1 });
  assert.deepEqual(novelSearchCommand('第2页', true), { kind: 'page', page: 2 });
  assert.deepEqual(novelSearchCommand('/小说 2', false), { kind: 'select', index: 2 });
});

test('novelSearch 四源配置校验与默认值归一化', () => {
  const cfg = novelSearchConfig();
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.relayUrl, 'http://127.0.0.1:3224');
  assert.equal(cfg.pixivMinChars, 1500);
  assert.equal(cfg.esjMaxChapters, 80);
  assert.deepEqual(cfg.sources, { pixiv: true, cool18: true, esjzone: true, telegram: true });

  assert.doesNotThrow(() => validateNovelSearchPatch({
    enabled: true,
    allowedGroups: ['892485992'],
    relayUrl: 'http://127.0.0.1:3224',
    relayToken: 'secret-token-123',
    pixivCookie: '12345_abcdef',
    pixivMinChars: 1800,
    esjMaxChapters: 100,
    sources: { pixiv: true, cool18: true, esjzone: true, telegram: false },
    summaryMode: 'clean',
    maxFileSizeMb: 30
  }));

  assert.throws(() => validateNovelSearchPatch({ relayUrl: 'http://1.2.3.4:3224' }), /本机 HTTP/);
  assert.throws(() => validateNovelSearchPatch({ sources: { unknown: true } }), /数据源开关无效/);
  assert.throws(() => validateNovelSearchPatch({ pixivMinChars: 99999 }), /0—20000/);
  assert.throws(() => validateNovelSearchPatch({ esjMaxChapters: 500 }), /1—200/);
  assert.equal(DEFAULT_NOVEL_SEARCH_CONFIG.summaryMode, 'clean');
});

test('NovelSearchManager 多源全流程：搜索出卡、翻页、选号下载、密钥脱敏与临时文件清理', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-novel-search-test-'));
  try {
    const sent = [];
    const forwarded = [];
    const uploaded = [];
    let lastUploadedPath = '';

    const mockItems = Array.from({ length: 7 }, (_, i) => ({
      source: i % 3 === 0 ? 'pixiv' : i % 3 === 1 ? 'cool18' : 'esjzone',
      channel: i % 3 === 0 ? 'pixiv' : i % 3 === 1 ? 'cool18' : 'esjzone',
      channelLabel: i % 3 === 0 ? 'Pixiv小说' : i % 3 === 1 ? '禁忌书屋(R18)' : 'ESJZone',
      id: String(1000 + i),
      msgId: 1000 + i,
      title: `测试小说第${i + 1}本`,
      fileName: `《测试小说第${i + 1}本》.txt`,
      ext: '.txt',
      size: 1024 * (i + 1),
      sizeText: `R-18 · ${i + 1}.5万字`,
      tags: ['纯爱', '校园'],
      summary: `这是第 ${i + 1} 本的干净简介`,
      date: '2026-11-24T12:00:00+08:00',
      ts: 1795492800 - i
    }));

    const fetchImpl = async (url, init) => {
      assert.equal(init.headers.authorization, 'Bearer test-relay-token');
      if (url.endsWith('/v1/search')) {
        const body = JSON.parse(init.body);
        assert.equal(body.query, '#纯爱');
        assert.equal(body.pixivMinChars, 1500);
        assert.equal(body.pixivCookie, 'pixiv-secret-cookie');
        assert.deepEqual(body.sources, ['pixiv', 'cool18', 'esjzone', 'telegram']);
        return new Response(JSON.stringify({ ok: true, items: mockItems, total: mockItems.length, channelErrors: {} }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.endsWith('/v1/download')) {
        const body = JSON.parse(init.body);
        assert.equal(body.source, 'pixiv');
        assert.equal(body.id, '1000');
        return new Response(Buffer.from('第一章 开始\n测试内容', 'utf8'), {
          status: 200,
          headers: {
            'content-type': 'application/octet-stream',
            'x-novel-filename': encodeURIComponent('《测试小说第1本》.txt'),
            'x-novel-encoding': 'gb18030',
            'x-novel-cache': 'miss'
          }
        });
      }
      throw new Error(`unexpected url: ${url}`);
    };

    const uploadImpl = async (opts) => {
      lastUploadedPath = opts.filePath;
      assert.equal(fs.existsSync(opts.filePath), true);
      assert.equal(fs.readFileSync(opts.filePath, 'utf8'), '第一章 开始\n测试内容');
      uploaded.push({
        chatKey: opts.chatKey,
        name: opts.name,
        fallbackName: opts.fallbackName,
        fallbackOnFailure: opts.fallbackOnFailure
      });
      return { ok: true, fileId: 'file-1', fileName: opts.fallbackName, usedFallbackName: true };
    };

    const cfg = {
      novelSearch: {
        enabled: true,
        allowPrivate: false,
        allowedGroups: ['892485992'],
        relayUrl: 'http://127.0.0.1:3224',
        relayToken: 'test-relay-token',
        pixivCookie: 'pixiv-secret-cookie',
        cooldownSeconds: 0,
        downloadCooldownSeconds: 0,
        pageSize: 5,
        maxFileSizeMb: 30,
        summaryMode: 'clean',
        normalizeTxt: true
      }
    };

    const manager = new NovelSearchManager({
      dataDir: tmpRoot,
      getConfig: () => cfg,
      canRun: () => true,
      onebot: { call: async () => ({}) },
      send: async (chatKey, msgs) => { sent.push({ chatKey, msgs }); },
      forward: async (chatKey, nodes, opts) => { forwarded.push({ chatKey, nodes, opts }); },
      fetchImpl,
      uploadImpl
    });

    // 1. 快照脱敏检查（不暴露令牌和 Cookie）
    const snap = manager.snapshot();
    assert.equal('relayToken' in snap.settings, false);
    assert.equal('pixivCookie' in snap.settings, false);
    assert.equal(snap.settings.hasRelayToken, true);
    assert.equal(snap.settings.hasPixivCookie, true);

    // 2. 非白名单群被拒绝
    await manager.handle(novelSearchCommand('/搜小说 #纯爱'), 'group:111111', 1);
    assert.match(sent.at(-1).msgs[0], /未获准/);

    // 3. 搜索并出第 1 页卡片（5 条 + 1 头节点）
    await manager.handle(novelSearchCommand('/搜小说 #纯爱'), 'group:892485992', 2);
    assert.equal(manager.hasList('group:892485992'), true);
    assert.equal(forwarded.length, 1);
    assert.equal(forwarded[0].nodes.length, 6);
    assert.match(forwarded[0].nodes[1].content, /【1】《测试小说第1本》/);

    // 4. 翻页到第 2 页（剩余 2 条 + 1 头节点）
    await manager.handle(novelSearchCommand('下一页', true), 'group:892485992', 3);
    assert.equal(forwarded.length, 2);
    assert.equal(forwarded[1].nodes.length, 3);
    assert.match(forwarded[1].nodes[1].content, /【6】《测试小说第6本》/);

    // 5. 选序号 1 下载并上传，验证编号回退提示、转码提示与临时文件立即清理
    await manager.handle(novelSearchCommand('1', true), 'group:892485992', 4);
    assert.equal(uploaded.length, 1);
    assert.equal(uploaded[0].fallbackName, 'NOVEL-pixiv-1000.txt');
    assert.equal(uploaded[0].fallbackOnFailure, true);
    assert.equal(fs.existsSync(lastUploadedPath), false, '上传完成后必须删除杭州临时文件');
    const doneMsg = sent.at(-1).msgs[0];
    assert.match(doneMsg, /已上传《测试小说第1本》/);
    assert.match(doneMsg, /编号文件名/);
    assert.match(doneMsg, /gb18030 转为 UTF-8/);

    // 6. 帮助文案与卡片纯函数覆盖
    const help = formatNovelHelp(novelSearchConfig(cfg.novelSearch));
    assert.match(help, /Pixiv 小说/);
    assert.match(help, /禁忌书屋/);
    assert.match(help, /ESJZone/);
    const built = buildNovelSearchNodes({ mode: 'latest', query: '', channelLabel: '禁忌书屋', items: mockItems, pageSize: 5 }, 1);
    assert.equal(built.totalPages, 2);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
