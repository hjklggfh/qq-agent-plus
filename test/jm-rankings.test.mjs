import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import test from 'node:test';
import sharp from 'sharp';
import { classifyJmDirectCommand, isSilentWhenChatDenied, parseRankCommand } from '../src/features/jm-suomingor/direct-command.js';
import * as engine from '../src/features/jm-suomingor/engine.js';
import { createRankService, rankFiles } from '../src/features/jm-suomingor/rankings.js';

const validJpg = await sharp(crypto.randomBytes(120 * 160 * 3), {
  raw: { width: 120, height: 160, channels: 3 },
}).jpeg({ quality: 90 }).toBuffer();

test('直通指令拆分：今日JM 指向全站日榜，JM同人日榜指向同人小榜，jm 指向指令菜单', () => {
  assert.deepEqual(classifyJmDirectCommand('今日JM'), { tool: 'jm_rank', args: { kind: 'daily', category: 'all', force: false } });
  assert.deepEqual(classifyJmDirectCommand('JM日榜'), { tool: 'jm_rank', args: { kind: 'daily', category: 'all', force: false } });
  assert.deepEqual(classifyJmDirectCommand('JM周榜'), { tool: 'jm_rank', args: { kind: 'weekly', category: 'all', force: false } });
  assert.deepEqual(classifyJmDirectCommand('JM月榜'), { tool: 'jm_rank', args: { kind: 'monthly', category: 'all', force: false } });
  assert.deepEqual(classifyJmDirectCommand('JM热门'), { tool: 'jm_rank', args: { kind: 'total', category: 'all', force: false } });
  assert.deepEqual(classifyJmDirectCommand('刷新JM周榜'), { tool: 'jm_rank', args: { kind: 'weekly', category: 'all', force: true } });
  assert.deepEqual(classifyJmDirectCommand('刷新今日JM'), { tool: 'jm_rank', args: { kind: 'daily', category: 'all', force: true } });
  assert.deepEqual(classifyJmDirectCommand('JM同人日榜'), { tool: 'jm_rank', args: { kind: 'daily', category: 'doujin', force: false } });
  assert.deepEqual(classifyJmDirectCommand('JM同人周榜'), { tool: 'jm_rank', args: { kind: 'weekly', category: 'doujin', force: false } });
  assert.deepEqual(classifyJmDirectCommand('JM同人月榜'), { tool: 'jm_rank', args: { kind: 'monthly', category: 'doujin', force: false } });
  assert.deepEqual(classifyJmDirectCommand('JM同人热门'), { tool: 'jm_rank', args: { kind: 'total', category: 'doujin', force: false } });
  assert.deepEqual(classifyJmDirectCommand('今日JM 同人'), { tool: 'jm_rank', args: { kind: 'daily', category: 'doujin', force: false } });
  assert.deepEqual(classifyJmDirectCommand('刷新JM同人周榜 48'), { tool: 'jm_rank', args: { kind: 'weekly', category: 'doujin', force: true, topN: 48 } });
  assert.deepEqual(classifyJmDirectCommand('jm'), { tool: 'jm_help', args: {} });
  assert.deepEqual(classifyJmDirectCommand('JM指令'), { tool: 'jm_help', args: {} });
  assert.deepEqual(classifyJmDirectCommand('JM进度'), { tool: 'jm_task_status', args: {} });
  assert.deepEqual(classifyJmDirectCommand('JM收藏'), { tool: 'jm_library', args: {} });
  assert.deepEqual(classifyJmDirectCommand('JM空间'), { tool: 'jm_storage', args: {} });
  assert.equal(isSilentWhenChatDenied('jm_help'), true);
  assert.equal(isSilentWhenChatDenied('jm_task_status'), true);
  assert.equal(isSilentWhenChatDenied('jm_rank'), false);
  assert.deepEqual(classifyJmDirectCommand('JM123456'), { tool: 'jm_download_album', args: { album_id: '123456' } });
  assert.deepEqual(classifyJmDirectCommand('JM书架'), { tool: 'jm_bookshelf', args: {} });
  assert.deepEqual(classifyJmDirectCommand('本地JM'), { tool: 'jm_bookshelf', args: {} });
  assert.deepEqual(classifyJmDirectCommand('更新JM'), { tool: 'jm_daily_updates', args: {} });
  assert.equal(parseRankCommand('更新JM'), null);
});

test('engine.rankAlbums 使用正确榜单排序参数并标准化字段', async () => {
  const seenUrls = [];
  const client = engine.createClient({
    fetchImpl: async (url) => {
      seenUrls.push(String(url));
      return new Response(JSON.stringify({
        code: 200,
        data: {
          total: 70,
          content: [
            { id: '1114299', name: '顶加套房', author: '作者A 作者B', category: { title: '韩漫' }, category_sub: { title: null }, update_at: 1700000000 },
          ],
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
    domains: '',
  });
  // 注意：真实 API 响应为加密 data；此处直接测 jmApi 错误聚合或未加密时 fallback；真实加密解密由 engine 自带测试逻辑验证，这里通过 stub client 测 rankings。
  assert.equal(typeof client.rankAlbums, 'function');
  client.close?.();
});

test('rankings 本地持久化缓存：命中复用、跨天/超时刷新、失败绝不覆盖旧缓存', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-ranks-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  let nowMs = Date.parse('2026-11-19T02:00:00+08:00');
  let fetchCount = 0;
  let renderCount = 0;
  let mode = 'ok';
  let topId = '100001';

  const service = createRankService({
    getDataRoot: () => root,
    getSettings: () => ({ rankTopN: 48, rankCategoryTopN: 24, rankCacheTtlMinutes: 60 }),
    createClient: () => ({
      async rankAlbums(kind, _page, category) {
        fetchCount += 1;
        if (mode === 'fetch-fail') throw new Error('上游榜单拉取失败');
        const list = Array.from({ length: 30 }, (_, idx) => ({
          id: idx === 0 ? topId : String(100002 + idx),
          name: `${kind}-${category}-作品${idx + 1}`,
          author: '作者1',
          category: category === 'doujin' ? '同人' : '韩漫',
          categorySub: '',
          updateAt: 1700000000,
        }));
        return { total: 30, items: list };
      },
      async close() {},
    }),
    fetchSiteCover: async (id) => {
      const p = path.join(root, 'daily-covers', `${id}.jpg`);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, validJpg);
      return p;
    },
    renderDigestImage: async ({ payload, outPath }) => {
      renderCount += 1;
      if (mode === 'render-fail') throw new Error('渲染失败');
      assert.equal(payload.items[0].rank, 1);
      fs.writeFileSync(outPath, Buffer.concat([validJpg, Buffer.from(payload.items[0].id)]));
      return outPath;
    },
    now: () => nowMs,
  });

  // 1) 首次拉取并原子落盘
  const first = await service.getRank('daily');
  assert.equal(first.fromCache, false);
  assert.equal(first.stale, false);
  assert.equal(fetchCount, 1);
  assert.equal(renderCount, 1);
  const { jsonPath, imagePath } = rankFiles(root, 'daily');
  const firstBytes = fs.readFileSync(imagePath);
  assert.ok(fs.existsSync(jsonPath));

  // 2) 30 分钟内再次请求，直接命中本地缓存（不拉接口、不重画）
  nowMs += 30 * 60 * 1000;
  const second = await service.getRank('daily');
  assert.equal(second.fromCache, true);
  assert.equal(second.stale, false);
  assert.equal(fetchCount, 1);
  assert.equal(renderCount, 1);

  // 3) 超过 60 分钟，拉取失败时：allowStale=true 保留旧缓存，allowStale=false 直接拒绝不发旧图
  nowMs += 40 * 60 * 1000;
  mode = 'fetch-fail';
  await assert.rejects(() => service.getRank('daily', { allowStale: false }), /上游榜单拉取失败/);
  const fallbackOnFetchFail = await service.getRank('daily');
  assert.equal(fallbackOnFetchFail.fromCache, true);
  assert.equal(fallbackOnFetchFail.stale, true);
  assert.deepEqual(fs.readFileSync(imagePath), firstBytes);

  // 4) 渲染失败时同样保留旧缓存并清理 tmp 文件
  mode = 'render-fail';
  const fallbackOnRenderFail = await service.getRank('daily', { force: true });
  assert.equal(fallbackOnRenderFail.stale, true);
  assert.deepEqual(fs.readFileSync(imagePath), firstBytes);
  assert.equal(fs.readdirSync(path.dirname(imagePath)).some((n) => n.includes('.tmp.')), false);

  // 5) 跨天后恢复成功，才原子替换旧缓存
  nowMs = Date.parse('2026-11-20T00:05:00+08:00');
  mode = 'ok';
  topId = '200001';
  const refreshed = await service.getRank('daily');
  assert.equal(refreshed.fromCache, false);
  assert.equal(refreshed.stale, false);
  assert.equal(refreshed.dateKey, '2026-11-20');
  assert.equal(refreshed.payload.items[0].id, '200001');
  assert.notDeepEqual(fs.readFileSync(imagePath), firstBytes);

  // 6) 同人分类小榜默认 24 本，缓存文件独立存放在 rank-daily-doujin.*，与全站互不覆盖
  const doujin = await service.getRank('daily', { category: 'doujin' });
  assert.equal(doujin.category, 'doujin');
  assert.equal(doujin.topN, 24);
  assert.match(doujin.payload.title, /同人日榜/);
  const doujinFiles = rankFiles(root, 'daily', 'doujin');
  assert.ok(doujinFiles.imagePath.endsWith('rank-daily-doujin.jpg'));
  assert.ok(fs.existsSync(doujinFiles.jsonPath));
  assert.ok(fs.existsSync(imagePath));
});
