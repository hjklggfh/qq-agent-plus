import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  resetDouyinSession,
  pickDouyinLinks,
  pickDouyinLink,
  isDouyinLink,
  parseDouyinUrl,
  expandDouyinShortLink,
  resolveDouyinLink,
  ensureDouyinSession,
  signDouyinDetailQuery,
  parseAwemeDetail,
  normalizeDouyinQuality,
  inferStreamResolution,
  selectVideoStreams,
  pickVideoStreamCandidates,
  fetchDouyinInfo,
  downloadDouyinVideo,
  douyinDetailCaption
} from '../src/features/douyin-api.js';

function textRes(status, body, headers = {}) {
  const hdrs = new Headers(headers);
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: hdrs });
}

test('抖音链接提取兼容口令粘连汉字、裸短链、video/note/slides与modal_id', () => {
  const copyText = [
    '4.82 复制打开抖音，看看【某某的作品】视频标题 https://v.douyin.com/nWzAJk8H0-E/复制打开抖音，',
    '或者看看 v.douyin.com/AbCd9988/ 还有 https://www.douyin.com/jingxuan?modal_id=7690730985881534955',
    '图文 https://www.douyin.com/note/7700608537977802038 和 https://www.douyin.com/slides/7700608537977802039',
    '忽略主页 https://www.douyin.com/ 与 https://www.douyin.com/user/MS4wLjABAAAA123'
  ].join(' ');
  const links = pickDouyinLinks(copyText);
  assert.deepEqual(links, [
    'https://v.douyin.com/nWzAJk8H0-E/',
    'https://v.douyin.com/AbCd9988/',
    'https://www.douyin.com/jingxuan?modal_id=7690730985881534955',
    'https://www.douyin.com/note/7700608537977802038',
    'https://www.douyin.com/slides/7700608537977802039'
  ]);
  assert.equal(pickDouyinLink('看这个 https://www.iesdouyin.com/share/video/7685666547399168505/'), 'https://www.iesdouyin.com/share/video/7685666547399168505/');
  assert.equal(isDouyinLink('纯聊天没有链接 https://www.douyin.com/'), false);
  assert.deepEqual(parseDouyinUrl('https://www.douyin.com/jingxuan?modal_id=7690730985881534955'), {
    kind: 'video',
    awemeId: '7690730985881534955',
    raw: 'https://www.douyin.com/jingxuan?modal_id=7690730985881534955'
  });
});

test('抖音短链展开支持重定向到作品页并拒绝非视频跳转', async () => {
  const okExpand = await expandDouyinShortLink('https://v.douyin.com/nWzAJk8H0-E/', {
    fetchImpl: async () => new Response(null, {
      status: 302,
      headers: { Location: 'https://www.iesdouyin.com/share/video/7480659754788900122/?region=CN' }
    })
  });
  assert.equal(okExpand.ok, true);
  assert.equal(okExpand.expanded, true);

  const shop = await resolveDouyinLink('https://v.douyin.com/jjDHgpm/', {
    fetchImpl: async () => new Response(null, {
      status: 302,
      headers: { Location: 'https://haohuo.jinritemai.com/views/product/item2?id=1' }
    })
  });
  assert.match(shop.error, /haohuo\.jinritemai\.com/);

  const live = await resolveDouyinLink('https://v.douyin.com/live123/', {
    fetchImpl: async () => new Response(null, {
      status: 302,
      headers: { Location: 'https://live.douyin.com/123456' }
    })
  });
  assert.match(live.error, /直播间/);

  const user = await resolveDouyinLink('https://v.douyin.com/user123/', {
    fetchImpl: async () => new Response(null, {
      status: 302,
      headers: { Location: 'https://www.douyin.com/user/MS4wLjAB' }
    })
  });
  assert.match(user.error, /用户主页/);
});

test('抖音签名与匿名会话403自动刷新一次且识别filter_detail业务错误', async () => {
  resetDouyinSession();
  const signed = signDouyinDetailQuery({ awemeId: '7480659754788900122', uifid: 'trace_uifid', timestamp: 1700000000 });
  const parsed = new URL(signed);
  const expectedQuery = 'aweme_id=7480659754788900122&aid=6383&uifid=trace_uifid&timestamp=1700000000';
  const expectedSig = createHash('md5')
    .update(`trace_uifid_1700000000_A96D855A08C0A9707F8BEF0D9A527E4E_${expectedQuery}`)
    .digest('hex');
  assert.equal(parsed.searchParams.get('x-secsdk-web-signature'), expectedSig);

  let sessionBootCount = 0;
  let detailCalls = 0;
  let shareCalls = 0;
  const mockFetch = async (url) => {
    const s = String(url);
    if (s.endsWith('/ttwid/register')) {
      return textRes(200, { status_code: 0 }, { 'set-cookie': 'ttwid=mock_ttwid; Path=/' });
    }
    if (s === 'https://www.douyin.com/') {
      sessionBootCount += 1;
      return textRes(200, '<html></html>', { 'x-tt-trace-host': `uifid_${sessionBootCount}` });
    }
    if (s.includes('/aweme/v1/web/aweme/detail/')) {
      detailCalls += 1;
      if (detailCalls === 1) return textRes(403, 'forbidden');
      if (s.includes('aweme_id=7480659754788900122')) {
        return textRes(200, {
          status_code: 0,
          aweme_detail: {
            aweme_id: '7480659754788900122',
            desc: '测试视频标题',
            duration: 15600,
            author: { nickname: '原作者' },
            statistics: { digg_count: 12000, comment_count: 34, collect_count: 56, share_count: 7 },
            video: {
              cover: { url_list: ['https://p3.douyinpic.com/cover.jpeg'] },
              bit_rate: [
                {
                  gear_name: 'normal_720_0',
                  bit_rate: 1200000,
                  is_h265: 0,
                  play_addr: { data_size: 2048, url_list: ['https://v1.douyinvod.com/h264.mp4'] }
                }
              ]
            }
          }
        });
      }
      return textRes(200, { status_code: 0, filter_detail: { filter_reason: 'core_dep' } });
    }
    if (s.includes('iesdouyin.com')) {
      shareCalls += 1;
      return textRes(404, '');
    }
    return textRes(404, '');
  };

  const session = await ensureDouyinSession({ fetchImpl: mockFetch });
  assert.equal(session.ok, true);
  assert.equal(session.uifid, 'uifid_1');

  const okInfo = await fetchDouyinInfo({ kind: 'video', awemeId: '7480659754788900122' }, { fetchImpl: mockFetch });
  assert.equal(okInfo.ok, true);
  assert.equal(okInfo.kind, 'video');
  assert.equal(okInfo.duration, 16);
  assert.equal(sessionBootCount, 2);
  assert.equal(detailCalls, 2);

  const deleted = await fetchDouyinInfo({ kind: 'video', awemeId: '1234567890123' }, { fetchImpl: mockFetch });
  assert.equal(deleted.ok, false);
  assert.match(deleted.error, /删除|不存在/);
  assert.equal(shareCalls, 0);
});

test('detail接口异常时回退到iesdouyin分享页解析_ROUTER_DATA', async () => {
  resetDouyinSession();
  const routerJson = JSON.stringify({
    loaderData: {
      'video_(id)/page': {
        videoInfoRes: {
          item_list: [{
            aweme_id: '7685666547399168505',
            desc: '分享页兜底视频',
            duration: 9000,
            author: { nickname: '备用作者' },
            video: {
              play_addr: { url_list: ['https://aweme.snssdk.com/aweme/v1/playwm/?video_id=abc'] }
            }
          }]
        }
      }
    }
  });
  const info = await fetchDouyinInfo('https://www.douyin.com/video/7685666547399168505', {
    fetchImpl: async (url) => {
      const s = String(url);
      if (s.endsWith('/ttwid/register')) return textRes(200, {});
      if (s === 'https://www.douyin.com/') return textRes(200, 'ok', { 'x-tt-trace-host': 'uifid_fb' });
      if (s.includes('/aweme/detail/')) return textRes(502, 'bad gateway');
      if (s.includes('iesdouyin.com/share/video/7685666547399168505/')) {
        return textRes(200, `<html><script>window._ROUTER_DATA = ${routerJson};</script></html>`);
      }
      return textRes(404, '');
    }
  });
  assert.equal(info.ok, true);
  assert.equal(info.source, 'iesdouyin-router');
  assert.equal(info.streams[0].urls[0], 'https://aweme.snssdk.com/aweme/v1/play/?video_id=abc');
});

test('抖音图文作品优先按gallery解析，忽略video中的背景音频流且排除水印下载地址', () => {
  const parsed = parseAwemeDetail({
    aweme_id: '7700608537977802038',
    desc: '图文作品测试',
    author: { nickname: '摄影师' },
    images: [
      {
        url_list: ['https://p3.douyinpic.com/a.webp', 'https://p3.douyinpic.com/a.jpeg'],
        download_url_list: ['https://p3.douyinpic.com/watermarked~tplv-dy-water-v2.jpeg']
      },
      {
        url_list: ['https://p9.douyinpic.com/b.png']
      }
    ],
    video: {
      play_addr: { url_list: ['https://sf3-cdn-tos.douyinstatic.com/obj/ies-music/bg.mp3'] }
    }
  });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.kind, 'gallery');
  assert.equal(parsed.images.length, 2);
  assert.equal(parsed.images[0].url, 'https://p3.douyinpic.com/a.jpeg');
  assert.equal(parsed.images[0].mirrors.some(u => u.includes('tplv-dy-water-v2')), false);
  assert.deepEqual(parsed.streams, []);
});

test('H.264码率优先级、体积上限筛选及多CDN镜像下载防护', async (t) => {
  const streams = selectVideoStreams({
    play_addr: { data_size: 4000, url_list: ['https://cdn.example.com/playwm/default.mp4'] },
    bit_rate: [
      {
        gear_name: 'hevc_1080',
        is_h265: 1,
        bit_rate: 4000000,
        play_addr: { data_size: 8000000, url_list: ['https://cdn.example.com/hevc1080.mp4'] }
      },
      {
        gear_name: 'h264_1080',
        is_h265: 0,
        bit_rate: 2500000,
        play_addr: { data_size: 90000000, url_list: ['https://cdn.example.com/h264_1080.mp4'] }
      },
      {
        gear_name: 'h264_540',
        is_h265: 0,
        bit_rate: 800000,
        play_addr: { data_size: 5000000, url_list: ['https://cdn.example.com/h264_540.mp4'] }
      }
    ]
  });
  assert.deepEqual(streams.map(s => s.gear), ['h264_1080', 'h264_540', 'default', 'hevc_1080']);

  const picked = pickVideoStreamCandidates(streams, 20 * 1024 * 1024);
  assert.equal(picked.ok, true);
  assert.equal(picked.candidates[0].gear, 'h264_540');

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dy-dl-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));
  const dest = path.join(tmpDir, 'out.mp4');

  const sawReferers = [];
  const res = await downloadDouyinVideo(
    ['https://cdn1.douyinvod.com/bad.mp4', 'https://cdn2.douyinvod.com/audio.mp3', 'https://cdn3.douyinvod.com/good.mp4'],
    dest,
    {
      maxBytes: 1024,
      fetchImpl: async (url, init) => {
        sawReferers.push(init?.headers?.Referer || init?.headers?.referer);
        if (String(url).includes('bad')) return textRes(403, 'denied');
        if (String(url).includes('audio')) return new Response(Buffer.from('ID3'), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
        return new Response(Buffer.from('mp4bytes'), { status: 200, headers: { 'content-type': 'video/mp4' } });
      }
    }
  );
  assert.equal(res.ok, true);
  assert.equal(res.bytes, 8);
  assert.deepEqual(sawReferers, ['https://www.douyin.com/', 'https://www.douyin.com/', 'https://www.douyin.com/']);

  const overflow = await downloadDouyinVideo(
    ['https://cdn.douyinvod.com/big.mp4'],
    dest,
    {
      maxBytes: 4,
      fetchImpl: async () => new Response(Buffer.from('123456'), { status: 200, headers: { 'content-type': 'video/mp4' } })
    }
  );
  assert.equal(overflow.ok, false);
  assert.equal(overflow.tooLarge, true);
});

test('抖音详情卡片未知统计标未知、真实0显示0且区分视频与图文文案', () => {
  const videoCaption = douyinDetailCaption({
    kind: 'video',
    awemeId: '7480659754788900122',
    title: '视频演示',
    author: '创作者',
    duration: 75,
    stats: { digg: 0, comment: 25600, collect: null, share: 3 }
  });
  assert.match(videoCaption, /抖音｜视频演示/);
  assert.match(videoCaption, /时长：1:15/);
  assert.match(videoCaption, /点赞：0 \| 评论：2\.6万 \| 收藏：未知 \| 分享：3/);

  const galleryCaption = douyinDetailCaption({
    kind: 'gallery',
    awemeId: '7700608537977802038',
    title: '风景图文',
    images: [{ url: 'a' }, { url: 'b' }, { url: 'c' }]
  });
  assert.match(galleryCaption, /图片：3 张/);
  assert.match(galleryCaption, /作者：未知/);
});

test('抖音首选画质归一化、分辨率识别及档位优先与缺失回退策略', () => {
  assert.equal(normalizeDouyinQuality(), '720p');
  assert.equal(normalizeDouyinQuality('540'), '540p');
  assert.equal(normalizeDouyinQuality('1080P'), '1080p');
  assert.equal(normalizeDouyinQuality('auto'), 'highest');
  assert.equal(normalizeDouyinQuality('unknown'), '720p');

  assert.equal(inferStreamResolution({ gear: 'normal_540_0', width: 576, height: 1024 }), 540);
  assert.equal(inferStreamResolution({ gear: 'custom', width: 1920, height: 1080 }), 1080);
  assert.equal(inferStreamResolution({ gear: 'custom', width: 720, height: 1280 }), 720);

  const streams = selectVideoStreams({
    play_addr: { data_size: 8000, width: 1080, height: 1920, url_list: ['https://cdn.example.com/default.mp4'] },
    bit_rate: [
      { gear_name: 'normal_1080_0', is_h265: 0, bit_rate: 2500000, play_addr: { data_size: 8000000, width: 1080, height: 1920, url_list: ['https://cdn.example.com/1080.mp4'] } },
      { gear_name: 'normal_720_0', is_h265: 0, bit_rate: 1500000, play_addr: { data_size: 5000000, width: 720, height: 1280, url_list: ['https://cdn.example.com/720_hi.mp4'] } },
      { gear_name: 'low_720_0', is_h265: 0, bit_rate: 1000000, play_addr: { data_size: 4000000, width: 720, height: 1280, url_list: ['https://cdn.example.com/720_lo.mp4'] } },
      { gear_name: 'normal_540_0', is_h265: 0, bit_rate: 800000, play_addr: { data_size: 3000000, width: 576, height: 1024, url_list: ['https://cdn.example.com/540.mp4'] } }
    ]
  });

  // 默认 720p：优先 normal_720_0 -> low_720_0 -> normal_540_0，若均失败可兜底 normal_1080_0
  const q720 = pickVideoStreamCandidates(streams, 50 * 1024 * 1024);
  assert.deepEqual(q720.candidates.map(s => s.gear), ['normal_720_0', 'low_720_0', 'normal_540_0', 'normal_1080_0', 'default']);

  // 540p：优先 normal_540_0，缺失或超限时向上贴近选 low_720_0 / normal_720_0
  const q540 = pickVideoStreamCandidates(streams, 50 * 1024 * 1024, { preferredQuality: '540p' });
  assert.equal(q540.candidates[0].gear, 'normal_540_0');

  // 1080p 与 highest：优先 normal_1080_0
  const q1080 = pickVideoStreamCandidates(streams, 50 * 1024 * 1024, { preferredQuality: '1080p' });
  assert.equal(q1080.candidates[0].gear, 'normal_1080_0');
  const qMax = pickVideoStreamCandidates(streams, 50 * 1024 * 1024, { preferredQuality: 'highest' });
  assert.equal(qMax.candidates[0].gear, 'normal_1080_0');

  // 720p 且大小限 4.5MB：过滤掉 1080p 与 normal_720_0，自动降到 4MB 的 low_720_0
  const qTight = pickVideoStreamCandidates(streams, Math.round(4.5 * 1024 * 1024), { preferredQuality: '720p' });
  assert.deepEqual(qTight.candidates.map(s => s.gear), ['low_720_0', 'normal_540_0', 'default']);

  // 只有 1080p 流时选 720p 仍可回退 1080p
  const only1080 = streams.filter(s => s.gear === 'normal_1080_0');
  const fallbackUp = pickVideoStreamCandidates(only1080, 50 * 1024 * 1024, { preferredQuality: '720p' });
  assert.equal(fallbackUp.candidates[0].gear, 'normal_1080_0');
});
