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
  isRelayAllowedTouchGalDomain,
  matchesWorkTitle,
  resolveOverseasProxyUrl,
  sanitizeSearchKeyword,
  searchAnimeTrace,
  searchBangumi,
  searchDlsite,
  searchKunGal,
  searchShinnku,
  searchShionlib,
  searchSteam,
  searchTouchGal,
  searchVndb,
  searchWebResources
} from '../src/features/resource-search/sources.js';
import { runResourceSearchAgent } from '../src/features/resource-search/agent.js';
import {
  buildResourceSearchNodes,
  defangUrlForGroup,
  formatResourceSearchReply,
  sanitizeGroupText
} from '../src/features/resource-search/cards.js';
import { ResourceSearchManager } from '../src/features/resource-search/manager.js';
import { createImageSearchRelay } from '../src/features/image-search/relay.js';

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

test('matchesWorkTitle 过滤分词模糊搜索带出的无关游戏', () => {
  assert.equal(matchesWorkTitle('千恋万花', ['千恋＊万花']), true);
  assert.equal(matchesWorkTitle('千恋万花', ['0/win/千恋万花/千恋万花(城彩修正).7z']), true);
  assert.equal(matchesWorkTitle('千恋万花', ['恋心如花俏绚烂']), false);
  assert.equal(matchesWorkTitle('千恋万花', ['千之刃涛、桃花染之皇姬']), false);
});

test('resourceSearch 配置校验与密钥脱敏', () => {
  const cfg = resourceSearchConfig();
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.cooldownSeconds, 15);
  assert.deepEqual(cfg.allowedGroups, []);
  assert.equal(cfg.sources.kungal, true);
  assert.equal(cfg.sources.shinnku, true);
  assert.equal(cfg.sources.bangumi, true);

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

test('多站点爬虫解析 Shionlib(含版本明细) / KunGal / Shinnku / TouchGal / VNDB / Bangumi / DLsite / Steam / AnimeTrace', async () => {
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
            items: [
              {
                id: 708,
                title_zh: '千恋＊万花',
                title_jp: '千恋＊万花',
                covers: [{ url: '/game/cover/708.jpg', type: 'dig', language: 'zh' }],
                developers: [{ developer: { name: 'Yuzusoft' } }],
                tags: [{ name: '纯爱' }, { name: '和风' }],
                resources: { count: 2 }
              },
              {
                id: 196,
                title_zh: '恋心如花俏绚烂',
                title_jp: '恋心如花俏绚烂',
                resources: { count: 1 }
              }
            ]
          }
        }
      }), { status: 200 });
    }
    if (u.includes('shionlib.com/api/game/708/download-source')) {
      return new Response(JSON.stringify({
        code: 0,
        data: [{
          id: 440,
          platform: ['win'],
          language: ['zh'],
          translation: 'group',
          translators: [{ name: '城彩学园汉化组' }],
          files: [{ file_name: '[160729][ゆずソフト] 千恋＊万花 [城彩学园汉化组].7z', file_size: 9751416271 }]
        }]
      }), { status: 200 });
    }
    if (u.includes('kungal.com/api/v1/search/works')) {
      return new Response(JSON.stringify({
        items: [{
          id: '15',
          display_name: '千恋＊万花',
          localized: { 'zh-Hans': { value: '千恋＊万花' }, ja: { value: '千恋＊万花' } },
          cover: { url: 'https://image.kungal.iloveren.link/cover15.webp' }
        }]
      }), { status: 200 });
    }
    if (u.includes('kungal.com/api/v1/works/15/resources')) {
      return new Response(JSON.stringify({
        items: [{
          id: '78093',
          state: 'valid',
          title: '【PC+安卓直装+全CG步兵】',
          size: '9.55 GB',
          provider_names: ['百度网盘'],
          resource_platforms: ['win', 'and'],
          resource_languages: ['zh-cn']
        }]
      }), { status: 200 });
    }
    if (u.includes('shinnku.com/search')) {
      const rscChunk = JSON.stringify([1, 'a:{"file_path":"0/win/千恋万花/千恋万花(城彩修正).7z","upload_timestamp":1700000000,"file_size":8181022288}\n']);
      return new Response(`<script>self.__next_f.push(${rscChunk})</script>`, { status: 200 });
    }
    if (u.includes('api.bgm.tv/search/subject')) {
      return new Response(JSON.stringify({
        list: [{
          id: 172612,
          name: '千恋＊万花',
          name_cn: '千恋＊万花',
          images: { large: 'http://lain.bgm.tv/pic/cover/l/172612.jpg' }
        }]
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
  assert.equal(shion.results.length, 1, '应过滤掉无关陪跑游戏恋心如花俏绚烂');
  assert.equal(shion.results[0].titleZh, '千恋＊万花');
  assert.equal(shion.results[0].downloads.length, 1);
  assert.match(shion.results[0].downloads[0].name, /城彩学园汉化组/);

  const kungal = await searchKunGal('千恋万花', {}, { fetchImpl: mockFetch });
  assert.equal(kungal.results[0].id, '15');
  assert.equal(kungal.results[0].downloads[0].url, 'https://www.kungal.com/galgame/resource/78093');
  assert.match(kungal.results[0].downloads[0].note, /百度网盘/);

  const shinnku = await searchShinnku('千恋万花', {}, { fetchImpl: mockFetch });
  assert.equal(shinnku.results.length, 1);
  assert.match(shinnku.results[0].downloads[0].name, /千恋万花\(城彩修正\)\.7z/);

  const bgm = await searchBangumi('千恋万花', {}, { fetchImpl: mockFetch });
  assert.equal(bgm.results[0].id, 'bgm172612');

  const tg = await searchTouchGal('千恋万花', {}, { fetchImpl: mockFetch });
  assert.equal(tg.results[0].downloads[0].code, 'abcd');

  const vndb = await searchVndb('千恋万花', {}, { fetchImpl: mockFetch });
  assert.equal(vndb.results[0].id, 'v19002');

  const dl = await searchDlsite('RJ999888', {}, { fetchImpl: mockFetch });
  assert.equal(dl.results[0].id, 'RJ999888');

  const steam = await searchSteam('千恋万花', {}, { fetchImpl: mockFetch });
  assert.equal(steam.results[0].id, '1144400');

  const multi = await crawlMultiSites('千恋万花', resourceSearchConfig(), {
    fetchImpl: mockFetch,
    webSearchImpl: async () => ({ results: [{ title: '千恋万花汉化补丁', url: 'https://forum.example.com/1', snippet: '直装版分流' }] })
  });
  assert.equal(multi.reports.length, 9);
  assert.ok(multi.results.length >= 7);
});

test('后台 DeepSeek 独立检索循环与 ResourceSearchManager 完整流程（含过滤无关游戏、编号厂商去重、多站点卡片）', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-resource-search-test-'));
  try {
    const cfg = {
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
      if (u.includes('shionlib.com/api/search')) {
        return new Response(JSON.stringify({
          data: {
            games: {
              items: [
                {
                  id: 708,
                  title_zh: '千恋＊万花',
                  title_jp: '千恋＊万花',
                  covers: [{ url: 'https://t.shionlib.com/cover.png', type: 'dig', language: 'zh' }],
                  developers: [{ developer: { name: 'ゆずソフト' } }],
                  resources: { count: 2 }
                },
                {
                  id: 196,
                  title_zh: '恋心如花俏绚烂',
                  title_jp: '恋心如花俏绚烂',
                  resources: { count: 1 }
                }
              ]
            }
          }
        }), { status: 200 });
      }
      if (u.includes('shionlib.com/api/game/708/download-source')) {
        return new Response(JSON.stringify({
          code: 0,
          data: [{
            id: 440,
            platform: ['win'],
            language: ['zh'],
            translation: 'group',
            translators: [{ name: '城彩学园汉化组' }],
            files: [{ file_name: '[160729][ゆずソフト] 千恋＊万花 [城彩学园汉化组].7z', file_size: 9751416271 }]
          }]
        }), { status: 200 });
      }
      if (u.includes('kungal.com/api/v1/search/works')) {
        return new Response(JSON.stringify({
          items: [{ id: '15', display_name: '千恋＊万花', localized: { 'zh-Hans': { value: '千恋＊万花' } } }]
        }), { status: 200 });
      }
      if (u.includes('kungal.com/api/v1/works/15/resources')) {
        return new Response(JSON.stringify({
          items: [{ id: '78093', state: 'valid', title: '【PC+安卓直装】', size: '9.55 GB', provider_names: ['百度网盘'] }]
        }), { status: 200 });
      }
      if (u.includes('shinnku.com/search')) {
        const rscChunk = JSON.stringify([1, 'a:{"file_path":"0/win/千恋万花/千恋万花(城彩修正).7z","upload_timestamp":1700000000,"file_size":8181022288}\n']);
        return new Response(`<script>self.__next_f.push(${rscChunk})</script>`, { status: 200 });
      }
      if (u.includes('api.vndb.org/kana/vn')) {
        return new Response(JSON.stringify({
          results: [{ id: 'v19073', title: 'Senren * Banka', alttitle: '千恋＊万花', developers: [{ name: 'ゆずソフト' }] }]
        }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    };

    const mockComplete = async (req) => {
      llmRounds += 1;
      assert.equal(req.overrides.apiKey, 'sk-global-ds-key');
      return {
        message: {
          content: JSON.stringify({
            work: {
              titleZh: '千恋＊万花',
              titleJp: '千恋＊万花',
              codes: ['v19073', 'VNDB:v19073'],
              developers: ['ゆずソフト (Yuzusoft)', 'ゆずソフト', '心愿屋汉化组'],
              tags: ['纯爱', '和风'],
              cover: 'https://t.shionlib.com/cover.png',
              summary: '柚子社代表作，已在书音、鲲Gal与真红小站命中资源。'
            },
            freeResources: [],
            officialResources: []
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

    await manager.start(resourceSearchCommand('/找资源 千恋万花'), 'group:100001', 2);
    await manager.task;
    assert.equal(llmRounds, 1);
    assert.equal(forwardedCards.length, 1);
    const cardTexts = forwardedCards[0].payload.nodes
      .flatMap((n) => n.data.content)
      .filter((c) => c.type === 'text')
      .map((c) => c.data.text)
      .join('\n');

    // 验证无关游戏已被过滤
    assert.doesNotMatch(cardTexts, /恋心如花俏绚烂/);
    // 验证编号去重（不出现 v19073 · VNDB:v19073）
    assert.match(cardTexts, /识别编号：VNDB:v19073/);
    assert.doesNotMatch(cardTexts, /v19073 · VNDB:v19073/);
    // 验证厂商去重且剔除汉化组
    assert.match(cardTexts, /社团\/厂商：ゆずソフト \(Yuzusoft\)/);
    assert.doesNotMatch(cardTexts, /社团\/厂商：.*心愿屋汉化组/);
    // 验证书音、鲲Gal、真红小站全部合并进 3 条气泡且群聊自动防风控断链
    assert.equal(forwardedCards[0].payload.nodes.length, 3);
    assert.match(cardTexts, /书音的图书馆/);
    assert.match(cardTexts, /鲲 Galgame/);
    assert.match(cardTexts, /真红小站/);
    assert.match(cardTexts, /kungal\[\.\]com\/galgame\/resource\/78093/);
    assert.match(cardTexts, /shinnku\[\.\]com\/files\/shinnku/);
    assert.doesNotMatch(cardTexts, /https?:\/\//i, '群聊开启防风控断链时不应输出原始 https:// 裸链');
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
        sources: { shionlib: true, kungal: true, shinnku: true, touchgal: true, vndb: true, bangumi: true, dlsite: true, steam: true, animetrace: true, web: true }
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
  assert.equal(doc.querySelectorAll('[id^="resource-search-source-"]').length, 10);
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

test('东京搜图中转 /v1/resource-search 代查 DLsite / Yahoo 日本及本机代理隧道校验', async (t) => {
  // 1. 本机代理地址校验与自动回退检测
  validateResourceSearchPatch({ proxyUrl: 'http://127.0.0.1:3222' });
  validateResourceSearchPatch({ proxyUrl: '' });
  assert.throws(() => validateResourceSearchPatch({ proxyUrl: 'http://evil.example.com:8080' }), /本机/);
  assert.throws(() => validateResourceSearchPatch({ proxyUrl: 'http://user:pass@127.0.0.1:3222' }), /本机/);

  assert.equal(
    resolveOverseasProxyUrl({}, { config: { pixiv: { proxyUrl: 'http://127.0.0.1:3222' } } }),
    'http://127.0.0.1:3222'
  );
  assert.equal(
    resolveOverseasProxyUrl({ proxyUrl: 'http://127.0.0.1:3223' }, { config: { pixiv: { proxyUrl: 'http://127.0.0.1:3222' } } }),
    'http://127.0.0.1:3223'
  );

  // 2. 启动真实东京中转 HTTP 服务测试 /v1/resource-search + 封面凭证 /v1/image
  const token = 'r'.repeat(40);
  const relayCalls = [];
  const server = createImageSearchRelay({
    token,
    download: async () => ({ buffer: TINY_PNG }),
    resourceSearch: async (source, query) => {
      relayCalls.push({ source, query });
      if (source === 'dlsite') {
        return {
          source: 'dlsite',
          status: 'ok',
          results: [{
            source: 'dlsite',
            siteName: 'DLsite',
            kind: 'official',
            id: 'RJ01208749',
            title: '夢吉原のあやかし妓楼 (RJ01208749)',
            developers: ['とらいあんぐる！'],
            cover: 'https://img.dlsite.jp/modpub/RJ01208749_img_main.jpg',
            url: 'https://www.dlsite.com/maniax/work/=/product_id/RJ01208749.html'
          }]
        };
      }
      if (source === 'yahoo') {
        return {
          source: 'yahoo',
          status: 'ok',
          results: [{
            title: '【SLG/官中】梦吉原的妖怪妓楼 官中步兵版',
            url: 'https://www.vikacg.com/post/41095',
            snippet: '百度网盘/Workupload直链 下载'
          }]
        };
      }
      return { source, status: 'empty', results: [] };
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const relayUrl = `http://127.0.0.1:${server.address().port}`;
  const imageSearchSettings = { relayUrl, relayToken: token };

  // 未鉴权请求被拒绝
  assert.equal((await fetch(`${relayUrl}/v1/resource-search`, { method: 'POST', body: '{}' })).status, 401);
  // 未知源返回 400
  assert.equal((await fetch(`${relayUrl}/v1/resource-search`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ source: 'invalid', query: 'test' })
  })).status, 400);

  // 通过东京中转查询 DLsite 与全网 Yahoo 日本
  const dlReport = await searchDlsite('RJ01208749', {}, { imageSearchSettings });
  assert.equal(dlReport.status, 'ok');
  assert.equal(dlReport.results[0].id, 'RJ01208749');
  assert.ok(dlReport.results[0].coverKey, '东京中转应为 DLsite 封面签发短期图片凭证');

  const webReport = await searchWebResources('RJ01208749', {}, {
    imageSearchSettings,
    webSearchImpl: async () => ({ results: [] })
  });
  // 注意：当传入自定义 webSearchImpl 时只调 webSearchImpl，不传 webSearchImpl 时才调 Yahoo Japan
  const webReportWithYahoo = await searchWebResources('RJ01208749', {}, { imageSearchSettings });
  assert.equal(webReport.results.length, 0);
  assert.equal(webReportWithYahoo.results.some((r) => r.url.includes('vikacg.com')), true);
  assert.deepEqual(relayCalls.map((c) => c.source), ['dlsite', 'yahoo']);

  // 验证合并卡片可通过东京中转 coverKey 拉取海外 DLsite 封面图，并经 sharp 转码为 JPEG
  const nodes = await buildResourceSearchNodes(
    {
      parsed: null,
      crawledItems: [...dlReport.results, ...webReportWithYahoo.results]
    },
    { includeImages: true, maxResults: 5, safeGroupLinks: true },
    { query: '梦吉原的妖怪妓楼', chatKind: 'group', imageSearchSettings, selfId: '10001' }
  );
  assert.ok(nodes);
  assert.equal(nodes.length, 3);
  const imgSeg = nodes[0].data.content.find((part) => part.type === 'image');
  assert.ok(imgSeg);
  assert.ok(imgSeg.data.file.startsWith('base64:///9j/'), '封面图应经 sharp 统一规范化为标准 JPEG');

  // 群聊防风控断链、去内嵌垃圾链接与敏感词柔化验证
  assert.equal(defangUrlForGroup('https://www.vikacg.com/p/303251'), 'vikacg[.]com/p/303251');
  assert.equal(
    sanitizeGroupText('解压工具：https://share.weiyun.com/abc v1.03 (1.93 GB) file.rar 步兵 妓院', { stripUrls: true, softenSensitive: true }),
    '解压工具： v1.03 (1.93 GB) file.rar 步·兵 妓·院'
  );
  const groupText = formatResourceSearchReply(
    { parsed: null, crawledItems: [...dlReport.results, ...webReportWithYahoo.results] },
    { maxResults: 5, safeGroupLinks: true },
    '梦吉原的妖怪妓楼',
    { chatKind: 'group' }
  );
  assert.match(groupText, /vikacg\[\.\]com\/post\/41095/);
  assert.match(groupText, /dlsite\[\.\]com\/maniax\/work\/=\/product_id\/RJ01208749\.html/);
  assert.doesNotMatch(groupText, /https?:\/\//i);

  const privateText = formatResourceSearchReply(
    { parsed: null, crawledItems: [...dlReport.results, ...webReportWithYahoo.results] },
    { maxResults: 5, safeGroupLinks: true },
    '梦吉原的妖怪妓楼',
    { chatKind: 'private' }
  );
  assert.match(privateText, /https:\/\/www\.vikacg\.com\/post\/41095/);
  assert.match(privateText, /https:\/\/www\.dlsite\.com\/maniax\/work\/=\/product_id\/RJ01208749\.html/);
});

test('关键词书名号清洗、TouchGal 域名白名单、东京中转扩展 4 站及中文译名二次补查', async (t) => {
  // 1. 书名号与外层包裹引号清洗（保留正文内标点）
  assert.equal(sanitizeSearchKeyword('《梦吉原的妖怪》'), '梦吉原的妖怪');
  assert.equal(sanitizeSearchKeyword('「『千恋＊万花』」'), '千恋＊万花');
  assert.equal(sanitizeSearchKeyword('【Fate/stay night】'), 'Fate/stay night');
  assert.equal(sanitizeSearchKeyword('Re:ゼロから始める異世界生活'), 'Re:ゼロから始める異世界生活');

  // 2. TouchGal 中转域名防 SSRF 白名单校验
  assert.equal(isRelayAllowedTouchGalDomain('www.touchgal.ink'), true);
  assert.equal(isRelayAllowedTouchGalDomain('touchgal.top'), true);
  assert.equal(isRelayAllowedTouchGalDomain('127.0.0.1'), false);
  assert.equal(isRelayAllowedTouchGalDomain('localhost'), false);
  assert.equal(isRelayAllowedTouchGalDomain('touchgal.ink.evil.com'), false);

  // 3. 东京中转 /v1/resource-search 支持 bangumi / touchgal / shinnku / vndb 并拦截非法 domain
  const token = 't'.repeat(40);
  const relayCalls = [];
  const server = createImageSearchRelay({
    token,
    download: async () => ({ buffer: TINY_PNG }),
    resourceSearch: async (source, query, opts = {}) => {
      relayCalls.push({ source, query, domain: opts.domain || '' });
      if (source === 'bangumi') {
        return {
          source: 'bangumi',
          status: 'ok',
          results: [{
            source: 'bangumi',
            siteName: 'Bangumi 番组计划',
            kind: 'database',
            id: 'bgm539640',
            title: '夢吉原のあやかし妓楼 ～妖怪大楼再建譚～',
            titleZh: '夢吉原のあやかし妓楼 ～妖怪大楼再建譚～',
            titleJp: '夢吉原のあやかし妓楼 ～妖怪大楼再建譚～',
            cover: 'https://lain.bgm.tv/pic/cover/l/aa/bb/539640.jpg',
            url: 'https://bgm.tv/subject/539640'
          }]
        };
      }
      if (source === 'touchgal') {
        return {
          source: 'touchgal',
          status: 'ok',
          results: [{
            source: 'touchgal',
            siteName: 'TouchGal 资源站',
            kind: 'free',
            id: 'tg1',
            title: '千恋＊万花',
            url: `https://${opts.domain || 'www.touchgal.ink'}/tg1`,
            downloads: [{ name: '网盘', url: 'https://pan.example.com/1' }]
          }]
        };
      }
      return { source, status: 'empty', results: [] };
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const relayUrl = `http://127.0.0.1:${server.address().port}`;
  const imageSearchSettings = { relayUrl, relayToken: token };

  // 非法 domain 参数必须被拒绝（防 SSRF）
  assert.equal((await fetch(`${relayUrl}/v1/resource-search`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ source: 'touchgal', query: '千恋万花', domain: '127.0.0.1' })
  })).status, 400);
  assert.equal((await fetch(`${relayUrl}/v1/resource-search`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ source: 'bangumi', query: '千恋万花', domain: 'www.touchgal.ink' })
  })).status, 400);

  const bgm = await searchBangumi('《夢吉原のあやかし妓楼》', {}, { imageSearchSettings });
  assert.equal(bgm.status, 'ok');
  assert.equal(bgm.results[0].id, 'bgm539640');
  assert.ok(bgm.results[0].coverKey, 'Bangumi 封面应经东京中转签发短期图片凭证');

  const tg = await searchTouchGal('《千恋万花》', { touchgalDomain: 'touchgal.top' }, { imageSearchSettings });
  assert.equal(tg.status, 'ok');
  assert.match(tg.results[0].url, /^https:\/\/touchgal\.top\//);

  const shinnku = await searchShinnku('《梦吉原的妖怪》', {}, { imageSearchSettings });
  assert.equal(shinnku.status, 'empty');

  const vndb = await searchVndb('《梦吉原的妖怪》', {}, { imageSearchSettings });
  assert.equal(vndb.status, 'empty');

  assert.deepEqual(relayCalls, [
    { source: 'bangumi', query: '夢吉原のあやかし妓楼', domain: '' },
    { source: 'touchgal', query: '千恋万花', domain: 'touchgal.top' },
    { source: 'shinnku', query: '梦吉原的妖怪', domain: '' },
    { source: 'vndb', query: '梦吉原的妖怪', domain: '' }
  ]);

  // 4. Agent 首轮去书名号 + 自动交叉扩展应使用规范中文译名和日文原名补查 shionlib 与 touchgal
  const seenRequests = [];
  const mockFetch = async (url, init = {}) => {
    const u = String(url);
    seenRequests.push({ url: u, body: String(init.body || '') });
    if (u.includes('kungal.com/api/v1/search/works')) {
      return new Response(JSON.stringify({
        items: [{
          id: '61115',
          display_name: '夢吉原のあやかし妓楼 ～妖怪大楼再建譚～',
          localized: {
            'zh-Hans': { value: '梦吉原的妖魅妓楼 ～妖怪大楼再建谭～' },
            ja: { value: '夢吉原のあやかし妓楼 ～妖怪大楼再建譚～' }
          }
        }]
      }), { status: 200 });
    }
    if (u.includes('kungal.com/api/v1/works/61115/resources')) {
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }
    if (u.includes('kungal.com/api/v1/works/61115')) {
      return new Response(JSON.stringify({ external_refs: [{ site: 'dlsite', external_id: 'RJ01208749' }] }), { status: 200 });
    }
    if (u.includes('shionlib.com/api/search')) {
      if (decodeURIComponent(u).includes('梦吉原的妖魅妓楼')) {
        return new Response(JSON.stringify({
          data: {
            games: {
              items: [{
                id: 999,
                title_zh: '梦吉原的妖魅妓楼 ～妖怪大楼再建谭～',
                title_jp: '夢吉原のあやかし妓楼 ～妖怪大楼再建譚～',
                resources: { count: 0 }
              }]
            }
          }
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { games: { items: [] } } }), { status: 200 });
    }
    if (u.includes('touchgal.ink/api/search')) {
      return new Response(JSON.stringify({ galgames: [] }), { status: 200 });
    }
    if (u.includes('shinnku.com/search')) {
      return new Response('<html></html>', { status: 200 });
    }
    if (u.includes('api.vndb.org/kana/vn')) {
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    if (u.includes('api.bgm.tv/search/subject')) {
      return new Response(JSON.stringify({ list: [] }), { status: 200 });
    }
    if (u.includes('dlsite.com')) {
      return new Response('[]', { status: 200 });
    }
    if (u.includes('steampowered.com')) {
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }
    return new Response('', { status: 404 });
  };

  const agentResult = await runResourceSearchAgent(
    { query: '《梦吉原的妖怪》' },
    {
      deepseekApiKey: 'sk-test-key',
      deepseekBaseUrl: 'https://api.deepseek.com/v1',
      deepseekModel: 'deepseek-chat',
      timeoutSeconds: 30,
      sources: {
        shionlib: true,
        kungal: true,
        shinnku: true,
        touchgal: true,
        vndb: true,
        bangumi: true,
        dlsite: true,
        steam: true,
        web: false
      }
    },
    {
      fetchImpl: mockFetch,
      webSearchImpl: async () => ({ results: [] }),
      completeImpl: async () => ({
        message: {
          content: JSON.stringify({
            work: { titleZh: '梦吉原的妖魅妓楼', titleJp: '夢吉原のあやかし妓楼' },
            freeResources: [],
            officialResources: []
          })
        }
      })
    }
  );

  // 首轮请求不含书名号
  assert.equal(seenRequests.some((r) => decodeURIComponent(r.url).includes('《') || r.body.includes('《')), false);
  // 自动扩展应使用标准中文译名“梦吉原的妖魅妓楼”补查 shionlib 与 touchgal
  assert.equal(seenRequests.some((r) => r.url.includes('shionlib.com/api/search') && decodeURIComponent(r.url).includes('梦吉原的妖魅妓楼')), true);
  assert.equal(seenRequests.some((r) => r.url.includes('touchgal.ink/api/search') && r.body.includes('梦吉原的妖魅妓楼')), true);
  assert.equal(agentResult.crawledItems.some((item) => item.source === 'shionlib' && item.id === '999'), true);
});


