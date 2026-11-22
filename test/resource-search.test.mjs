import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { toClassicScript } from './helpers/ui-module-source.mjs';
import { sanitizeConfigSecrets } from '../src/core/secret-keys.js';
import {
  DEFAULT_RESOURCE_SEARCH_CONFIG,
  RESOURCE_SEARCH_LIMIT_MAX,
  resourceSearchConfig,
  validateResourceSearchPatch
} from '../src/features/resource-search/config.js';
import { resourceSearchCommand } from '../src/features/resource-search/command.js';
import {
  crawlMultiSites,
  searchAnimeTrace,
  searchDlsite,
  searchShionlib,
  searchSteam,
  searchTouchGal,
  searchVndb
} from '../src/features/resource-search/sources.js';
import { resolveDeepSeekCredentials, runResourceSearchAgent } from '../src/features/resource-search/agent.js';
import { buildResourceSearchNodes, formatResourceSearchReply } from '../src/features/resource-search/cards.js';
import { ResourceSearchManager } from '../src/features/resource-search/manager.js';

const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex'
);

test('resourceSearchCommand 解析关键词指令与纯截图找资源指令', () => {
  assert.equal(resourceSearchCommand('今天天气真好'), null);
  assert.equal(resourceSearchCommand('/搜图'), null);

  const byText = resourceSearchCommand('/找资源 千恋万花');
  assert.equal(byText.query, '千恋万花');

  const byAlias = resourceSearchCommand('搜黄油：RJ123456');
  assert.equal(byAlias.query, 'RJ123456');

  const imageOnly = resourceSearchCommand('[CQ:image,url=https://example.com/a.png]/找资源');
  assert.ok(imageOnly);
  assert.equal(imageOnly.query, '');
  assert.equal(imageOnly.segments.some((s) => s.type === 'image'), true);
});

test('resourceSearch 配置校验与密钥脱敏', () => {
  const cfg = resourceSearchConfig();
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.cooldownSeconds, 15);
  assert.deepEqual(cfg.allowedGroups, []);

  assert.throws(() => validateResourceSearchPatch({ allowedGroups: ['bad-id'] }), /群白名单/);
  assert.throws(() => validateResourceSearchPatch({ cooldownSeconds: -1 }), /cooldownSeconds/);
  assert.throws(() => validateResourceSearchPatch({ maxResults: RESOURCE_SEARCH_LIMIT_MAX + 1 }), /maxResults/);
  assert.throws(() => validateResourceSearchPatch({ deepseekBaseUrl: 'ftp://bad.host' }), /DeepSeek API 地址/);

  const sanitized = sanitizeConfigSecrets({
    resourceSearch: {
      ...DEFAULT_RESOURCE_SEARCH_CONFIG,
      deepseekApiKey: 'sk-deepseek-secret',
      touchgalToken: 'tg-jwt-secret'
    }
  });
  assert.equal('deepseekApiKey' in sanitized.resourceSearch, false);
  assert.equal('touchgalToken' in sanitized.resourceSearch, false);
  assert.equal(sanitized.resourceSearch.hasDeepseekApiKey, true);
  assert.equal(sanitized.resourceSearch.hasTouchgalToken, true);
});

test('多站点爬虫解析 Shionlib / TouchGal / VNDB / DLsite / Steam / AnimeTrace', async () => {
  const mockFetch = async (url) => {
    const u = String(url);
    if (u.includes('animetrace.com')) {
      return new Response(JSON.stringify({
        code: 0,
        data: [{ character: [{ character: '朝武芳乃', work: '千恋＊万花' }] }]
      }), { status: 200 });
    }
    if (u.includes('shionlib.com/api/search')) {
      return new Response(JSON.stringify({
        data: {
          games: {
            items: [{
              id: 708,
              title_zh: '千恋＊万花',
              title_jp: '千恋＊万花',
              covers: [{ url: '/game/cover/708.jpg', type: 'dig', language: 'zh' }],
              developers: [{ developer: { name: 'Yuzusoft' } }],
              tags: [{ name: '纯爱' }, { name: '和风' }],
              resources: { count: 4 }
            }]
          }
        }
      }), { status: 200 });
    }
    if (u.includes('touchgal.ink/api/search')) {
      return new Response(JSON.stringify({
        galgames: [{ id: 101, uniqueId: 'senren-banka', name: '千恋＊万花', banner: 'https://www.touchgal.ink/banner.jpg' }]
      }), { status: 200 });
    }
    if (u.includes('touchgal.ink/api/patch/resource')) {
      return new Response(JSON.stringify([
        {
          name: 'PC官中硬盘版',
          note: '免安装直装',
          links: [{ content: 'https://pan.example.com/s/123', size: '6.2GB', code: 'abcd', password: 'gal' }]
        }
      ]), { status: 200 });
    }
    if (u.includes('api.vndb.org/kana/vn')) {
      return new Response(JSON.stringify({
        results: [{
          id: 'v19002',
          title: 'Senren * Banka',
          alttitle: '千恋＊万花',
          aliases: ['千恋万花'],
          released: '2016-07-29',
          rating: 78.5,
          image: { url: 'https://t.vndb.org/cv/02/19002.jpg' },
          developers: [{ name: 'Yuzusoft' }],
          description: 'Yuzusoft 经典和风恋爱冒险作品。'
        }]
      }), { status: 200 });
    }
    if (u.includes('dlsite.com/maniax/api')) {
      return new Response(JSON.stringify([{
        workno: 'RJ999888',
        work_name: '测试同人RPG',
        maker_name: '测试社团',
        intro_s: '同人RPG简介',
        image_main: { url: '//img.dlsite.jp/modpub/images2/work/doujin/RJ999000/RJ999888_img_main.jpg' }
      }]), { status: 200 });
    }
    if (u.includes('store.steampowered.com')) {
      return new Response(JSON.stringify({
        items: [{ id: 1144400, name: 'Senren＊Banka', tiny_image: 'https://cdn.akamai.steamstatic.com/steam/apps/1144400/header.jpg' }]
      }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };

  const trace = await searchAnimeTrace({ buffer: TINY_PNG, type: 'image/png' }, { fetchImpl: mockFetch });
  assert.deepEqual(trace.works, ['千恋＊万花']);
  assert.equal(trace.characters[0].character, '朝武芳乃');

  const shion = await searchShionlib('千恋万花', {}, { fetchImpl: mockFetch });
  assert.equal(shion.results[0].titleZh, '千恋＊万花');
  assert.equal(shion.results[0].cover, 'https://t.shionlib.com/game/cover/708.jpg');
  assert.equal(shion.results[0].resourceCount, 4);

  const tg = await searchTouchGal('千恋万花', {}, { fetchImpl: mockFetch });
  assert.equal(tg.results[0].downloads[0].code, 'abcd');
  assert.equal(tg.results[0].downloads[0].password, 'gal');

  const vndb = await searchVndb('千恋万花', {}, { fetchImpl: mockFetch });
  assert.equal(vndb.results[0].id, 'v19002');

  const dl = await searchDlsite('RJ999888', {}, { fetchImpl: mockFetch });
  assert.equal(dl.results[0].id, 'RJ999888');
  assert.match(dl.results[0].cover, /^https:\/\/img\.dlsite\.jp/);

  const steam = await searchSteam('千恋万花', {}, { fetchImpl: mockFetch });
  assert.equal(steam.results[0].id, '1144400');

  const multi = await crawlMultiSites('千恋万花', resourceSearchConfig(), {
    fetchImpl: mockFetch,
    webSearchImpl: async () => ({ results: [{ title: '千恋万花汉化补丁', url: 'https://forum.example.com/1', snippet: '直装版分流' }] })
  });
  assert.equal(multi.reports.length, 6);
  assert.ok(multi.results.length >= 5);
});

test('后台 DeepSeek 独立检索循环与 ResourceSearchManager 完整流程（含冷却、群白名单与合并转发卡片）', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-resource-search-test-'));
  try {
    let cfg = {
      providerKeys: { deepseek: 'sk-global-ds-key' },
      imageSearch: {},
      resourceSearch: {
        ...DEFAULT_RESOURCE_SEARCH_CONFIG,
        enabled: true,
        allowedGroups: ['100001'],
        allowPrivate: false,
        cooldownSeconds: 30
      }
    };

    const sentMessages = [];
    const forwardedCards = [];
    let llmRounds = 0;

    const mockFetch = async (url) => {
      const u = String(url);
      if (u.includes('cover.png')) return new Response(TINY_PNG, { status: 200 });
      if (u.includes('shionlib.com')) {
        return new Response(JSON.stringify({
          data: {
            games: {
              items: [{
                id: 708,
                title_zh: '千恋＊万花',
                title_jp: '千恋＊万花',
                covers: [{ url: 'https://t.shionlib.com/cover.png', type: 'dig', language: 'zh' }],
                developers: [{ developer: { name: 'Yuzusoft' } }],
                resources: { count: 3 }
              }]
            }
          }
        }), { status: 200 });
      }
      if (u.includes('touchgal.ink/api/search')) {
        return new Response(JSON.stringify({
          galgames: [{ id: 101, uniqueId: 'senren-banka', name: '千恋＊万花' }]
        }), { status: 200 });
      }
      if (u.includes('touchgal.ink/api/patch/resource')) {
        return new Response(JSON.stringify([{
          name: '官中免安装版',
          links: [{ content: 'https://pan.example.com/s/senren', size: '6GB', code: '1122', password: 'yuzu' }]
        }]), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    };

    const mockComplete = async (req) => {
      llmRounds += 1;
      assert.equal(req.overrides.apiKey, 'sk-global-ds-key');
      assert.equal(req.overrides.model, 'deepseek-chat');
      // 首次调用测试 DeepSeek 主动发起第 2 轮工具调用深挖
      if (llmRounds === 1) {
        return {
          message: {
            content: '',
            tool_calls: [{
              id: 'call_1',
              type: 'function',
              function: {
                name: 'crawl_multi_sites',
                arguments: JSON.stringify({ keyword: 'Senren Banka', sites: ['steam'] })
              }
            }]
          }
        };
      }
      return {
        message: {
          content: JSON.stringify({
            work: {
              titleZh: '千恋＊万花',
              titleJp: '千恋＊万花',
              codes: ['v19002', 'Steam:1144400'],
              developers: ['Yuzusoft'],
              tags: ['纯爱', '和风'],
              cover: 'https://t.shionlib.com/cover.png',
              summary: '柚子社代表作，已找到 TouchGal 直链与书音图书馆分流。'
            },
            freeResources: [],
            officialResources: [
              { siteName: 'Steam', title: 'Senren＊Banka', url: 'https://store.steampowered.com/app/1144400', note: '官方中文正版' }
            ]
          })
        }
      };
    };

    const manager = new ResourceSearchManager({
      dataDir: tmpDir,
      getConfig: () => cfg,
      canRun: () => true,
      onebot: { selfId: '99999', selfNickname: '测试Bot' },
      store: { findByMid: () => null },
      download: async () => ({ buffer: TINY_PNG }),
      fetchImpl: mockFetch,
      completeImpl: mockComplete,
      webSearchImpl: async () => ({ results: [] }),
      send: async (chatKey, messages) => { sentMessages.push({ chatKey, messages }); return {}; },
      forward: async (chatKey, payload) => { forwardedCards.push({ chatKey, payload }); return {}; }
    });

    // 1. 未授权群聊拒绝
    await manager.start(resourceSearchCommand('/找资源 千恋万花'), 'group:999999', 1);
    assert.match(sentMessages.at(-1).messages[0], /未获准使用资源检索/);

    // 2. 授权群聊后台运行并发送合并转发卡片
    await manager.start(resourceSearchCommand('/找资源 千恋万花'), 'group:100001', 2);
    await manager.task;
    assert.equal(llmRounds, 2);
    assert.equal(forwardedCards.length, 1);
    assert.equal(forwardedCards[0].payload.label, '资源检索结果');
    const cardTexts = forwardedCards[0].payload.nodes
      .flatMap((n) => n.data.content)
      .filter((c) => c.type === 'text')
      .map((c) => c.data.text)
      .join('\n');
    assert.match(cardTexts, /千恋＊万花/);
    assert.match(cardTexts, /提取码：1122/);
    assert.match(cardTexts, /解压密码：yuzu/);
    assert.match(cardTexts, /shionlib\.com\/zh\/game\/708/);
    assert.match(cardTexts, /store\.steampowered\.com\/app\/1144400/);

    // 3. 冷却时间内拒绝重复触发
    await manager.start(resourceSearchCommand('/找资源 千恋万花'), 'group:100001', 3);
    assert.match(sentMessages.at(-1).messages[0], /过于频繁/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('资源检索控制台设置页渲染、群白名单、冷却与密钥保存行为', async (t) => {
  let WindowClass;
  try { ({ Window: WindowClass } = await import('happy-dom')); }
  catch (error) { if (error.code === 'ERR_MODULE_NOT_FOUND') return; throw error; }

  const window = new WindowClass();
  t.after(() => window.happyDOM.abort());
  const calls = [];
  const state = {
    config: {
      providerKeyPresence: { deepseek: true },
      resourceSearch: {
        enabled: false,
        hasDeepseekApiKey: false,
        hasTouchgalToken: true,
        allowedGroups: ['100001'],
        cooldownSeconds: 15,
        timeoutSeconds: 60,
        maxResults: 5,
        includeImages: true,
        sources: { shionlib: true, touchgal: true, vndb: true, dlsite: true, steam: true, animetrace: true, web: true }
      }
    }
  };
  const api = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/settings')) {
      return { settings: { ...JSON.parse(options.body), hasDeepseekApiKey: false, hasTouchgalToken: true, hasGlobalDeepseekKey: true } };
    }
    return { running: false, history: [{ startedAt: '2026-11-22', chatKey: 'group:100001', query: '千恋万花', status: 'done', sources: [{ source: 'shionlib', count: 1 }] }] };
  };
  const context = vm.createContext({
    state,
    api,
    $: (selector) => window.document.querySelector(selector),
    esc: (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;')
  });
  const source = fs.readFileSync(new URL('../ui/pages/resource-search.js', import.meta.url), 'utf8');
  vm.runInContext(toClassicScript(source), context);
  window.document.body.innerHTML = vm.runInContext('renderResourceSearchSection(state.config)', context) + '<span id="cfg-save-result"></span>';
  const doc = window.document;

  assert.equal(doc.querySelector('#resource-search-enabled').checked, false);
  assert.equal(doc.querySelectorAll('[id^="resource-search-source-"]').length, 7);
  assert.match(doc.body.textContent, /自动复用「模型 API」中的 DeepSeek Key/);

  doc.querySelector('#resource-search-enabled').checked = true;
  doc.querySelector('#resource-search-groups').value = '100001\n100002\n100001';
  doc.querySelector('#resource-search-cooldown').value = '25';
  await vm.runInContext('saveResourceSearchSettings()', context);

  const patch = JSON.parse(calls[0].options.body);
  assert.equal(calls[0].url, '/api/resource-search/settings');
  assert.equal(patch.enabled, true);
  assert.equal(patch.cooldownSeconds, 25);
  assert.deepEqual(patch.allowedGroups, ['100001', '100002']);
  assert.equal(Object.hasOwn(patch, 'deepseekApiKey'), false);
  assert.equal(Object.hasOwn(patch, 'touchgalToken'), false);

  vm.runInContext('bindResourceSearchSection()', context);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(doc.querySelector('#resource-search-history').textContent, /千恋万花/);
});

