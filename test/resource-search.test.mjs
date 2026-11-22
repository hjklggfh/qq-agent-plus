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
  matchesWorkTitle,
  searchAnimeTrace,
  searchBangumi,
  searchDlsite,
  searchKunGal,
  searchShinnku,
  searchShionlib,
  searchSteam,
  searchTouchGal,
  searchVndb
} from '../src/features/resource-search/sources.js';
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
    // 验证书音、鲲Gal、真红小站全部出现在免费卡片里
    assert.match(cardTexts, /书音的图书馆/);
    assert.match(cardTexts, /鲲 Galgame/);
    assert.match(cardTexts, /真红小站/);
    assert.match(cardTexts, /kungal\.com\/galgame\/resource\/78093/);
    assert.match(cardTexts, /shinnku\.com\/files\/shinnku/);
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
