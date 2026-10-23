import assert from 'node:assert/strict';
import test from 'node:test';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { XSearchManager, xCardNodes } from '../src/features/x-search/manager.js';
import { DEFAULT_X_SEARCH_CONFIG, validateXSearchPatch, xSearchConfig } from '../src/features/x-search/config.js';
import { fetchXPage, xRequestJson, xThumbnail } from '../src/features/x-search/client.js';
import { xSearchCommand } from '../src/features/x-search/command.js';
import { sanitizeConfigSecrets } from '../src/core/secret-keys.js';

const settings = { ...DEFAULT_X_SEARCH_CONFIG, enabled: true, bearerToken: 'test-token' };
const user = { id: '123456', username: 'Example', name: '示例账号', description: '账号简介' };
const fixture = { data: [
  { id: '90071992547409932', text: '[CQ:image,file=bad]普通帖子', created_at: '2026-10-23T00:00:00Z', attachments: { media_keys: ['photo', 'video'] } },
  { id: '90071992547409933', text: '敏感正文', possibly_sensitive: true, attachments: { media_keys: ['photo'] } }
], includes: { media: [
  { media_key: 'photo', type: 'photo', url: 'https://pbs.twimg.com/media/example.jpg' },
  { media_key: 'video', type: 'video', preview_image_url: 'https://pbs.twimg.com/ext_tw_video_thumb/example.jpg' }
] }, meta: { next_token: 'next-page' } };

function setup(overrides = {}) {
  const config = { xSearch: { ...settings } };
  const sent = []; const calls = [];
  const manager = new XSearchManager({ getConfig: () => config, canRun: () => true, historyDelayMs: 0,
    request: async (url) => { calls.push(url); return url.includes('/tweets?') ? structuredClone(fixture) : { data: user }; },
    thumbnail: async () => ({ type: 'image', data: { file: 'base64://fixture' } }),
    onebot: { selfId: '10001', call: async () => ({ messages: [{ message_id: sent.length, message_seq: 10 }] }) },
    forward: async (chatKey, payload) => { sent.push({ chatKey, ...payload }); return { message_id: sent.length }; },
    ...overrides
  });
  return { manager, config, sent, calls };
}

test('X 指令只接受明确账号或个人主页，翻页不抢 JM 普通下一页', () => {
  for (const input of ['X @Example', 'X搜索 Example', 'Twitter Example', 'https://x.com/Example', 'https://twitter.com/Example?lang=en']) {
    assert.deepEqual(xSearchCommand(input), { username: 'Example' });
  }
  assert.deepEqual(xSearchCommand('X下一页'), { next: true });
  for (const input of ['下一页', '12345', 'X', 'X 随便聊聊', 'https://x.com/home', 'https://x.com/Example/status/123', 'https://x.com.evil.test/Example']) assert.equal(xSearchCommand(input), null);
});

test('配置默认关闭、验证失败关闭，凭据不进入任何安全视图', () => {
  assert.equal(DEFAULT_X_SEARCH_CONFIG.enabled, false);
  assert.equal(xSearchConfig({ enabled: 'bad' }).enabled, false);
  for (const patch of [{ enabled: 'yes' }, { apiBaseUrl: 'http://api.x.com' }, { apiBaseUrl: 'https://user:pw@api.x.com' },
    { apiBaseUrl: 'https://api.x.com/?token=test' }, { timeoutSeconds: 0 }, { bearerToken: 'bad\nheader' }, { unknown: true }]) assert.throws(() => validateXSearchPatch(patch));
  const { manager } = setup();
  assert.doesNotMatch(JSON.stringify(manager.snapshot()), /test-token/);
  assert.equal(manager.snapshot().settings.hasBearerToken, true);
  assert.doesNotMatch(JSON.stringify(sanitizeConfigSecrets({ xSearch: settings })), /test-token/);
});

test('接口准确查账号、只取5条并携带过滤及分页，保留字符串ID和倒序', async () => {
  const calls = [];
  const page = await fetchXPage('Example', settings, { next: 'abc', request: async (raw, options) => {
    calls.push({ url: new URL(raw), options });
    return raw.includes('/tweets?') ? fixture : { data: user };
  } });
  assert.equal(calls[0].url.pathname, '/2/users/by/username/Example');
  assert.equal(calls[1].url.searchParams.get('max_results'), '5');
  assert.equal(calls[1].url.searchParams.get('exclude'), 'replies,retweets');
  assert.equal(calls[1].url.searchParams.get('pagination_token'), 'abc');
  assert.equal(calls[1].options.bearerToken, 'test-token');
  assert.equal(page.posts[0].id, '90071992547409933');
  assert.equal(page.posts[1].media.length, 2);
  assert.equal(page.next, 'next-page');
  await assert.rejects(fetchXPage('Example', settings, { request: async () => ({ data: { ...user, protected: true } }) }), /受保护/);
  await assert.rejects(fetchXPage('Other', settings, { request: async () => ({ data: user }) }), /不匹配/);
  await assert.rejects(fetchXPage('Example', settings, { request: async (url) => url.includes('/tweets?') ? { errors: [{}] } : { data: user } }), /格式/);
});

test('卡片清除CQ注入、敏感帖不下载图片，坏图片只降级自身', async () => {
  const page = await fetchXPage('Example', settings, { request: async (url) => url.includes('/tweets?') ? fixture : { data: user } });
  let thumbnails = 0;
  const nodes = await xCardNodes(page, { includeImages: true, selfId: '10001', thumbnail: async () => { thumbnails++; throw new Error('bad'); } });
  assert.equal(nodes.length, 3);
  assert.equal(thumbnails, 2, '只处理普通帖子两张图');
  assert.doesNotMatch(JSON.stringify(nodes), /\[CQ:|敏感正文/);
  assert.match(JSON.stringify(nodes), /图片暂不可用|X下一页|北京时间/);
});

test('公开网络边界：API 不访问内网，图片仅允许 X 官方域名', async () => {
  await assert.rejects(xRequestJson('https://127.0.0.1/2/users', { bearerToken: 'secret' }), /内网/);
  await assert.rejects(xThumbnail('https://evil.test/image.jpg'), /非 X/);
});

test('API 遇重定向立即停止，不将 Token 跟随发送到另一个域名', async (t) => {
  const requests = [];
  t.mock.method(https, 'request', (options, callback) => {
    requests.push(options);
    const request = new EventEmitter();
    request.destroy = () => {};
    request.end = () => {
      const response = new EventEmitter();
      response.statusCode = 302; response.headers = { location: 'https://evil.test/collect' }; response.resume = () => {};
      queueMicrotask(() => callback(response));
    };
    return request;
  });
  await assert.rejects(xRequestJson('https://93.184.216.34/test', { bearerToken: 'secret' }), /HTTP 302/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].headers.Authorization, 'Bearer secret');
});

test('群历史未知或发送异常不降级重发；序号0只触发一次文字降级', async () => {
  const unknown = setup({ onebot: { call: async () => { throw new Error('history failed'); } } });
  assert.equal((await unknown.manager.start({ username: 'Example' }, 'group:100001', 1, 'u1')).sendUnknown, true);
  assert.equal(unknown.sent.length, 1);
  const zero = setup({ onebot: { call: async () => ({ messages: [{ message_id: 1, message_seq: 0 }, { message_id: 2, message_seq: 0 }] }) } });
  assert.equal((await zero.manager.start({ username: 'Example' }, 'group:100001', 1, 'u1')).sendUnknown, true);
  assert.equal(zero.sent.length, 2);
  assert.ok(zero.sent[1].nodes.every((n) => n.data.content.every((s) => s.type === 'text')));
  let attempts = 0;
  const timeout = setup({ forward: async () => { attempts++; throw new Error('timeout'); } });
  assert.equal((await timeout.manager.start({ username: 'Example' }, 'group:100001', 1, 'u1')).sendUnknown, true);
  assert.equal(attempts, 1);
});

test('成功后分页按会话和发送者隔离、缓存复用且设置变更清空', async () => {
  const { manager, config, calls } = setup();
  assert.equal((await manager.start({ username: 'Example' }, 'group:100001', 1, 'u1')).ok, true);
  assert.match((await manager.start({ next: true }, 'group:100001', 2, 'u2')).error, /没有可用/);
  assert.equal((await manager.start({ username: 'Example' }, 'private:100002', 3, 'u2')).ok, true);
  assert.equal(calls.length, 2, '不同会话读取相同公开数据时命中缓存');
  manager.cooldowns.clear();
  assert.equal((await manager.start({ next: true }, 'group:100001', 4, 'u1')).ok, true);
  assert.equal(new URL(calls.at(-1)).searchParams.get('pagination_token'), 'next-page');
  config.xSearch.enabled = false; manager.enforce();
  assert.equal(manager.sessions.size, 0);
  assert.equal(manager.cache.size, 0);
  assert.match((await manager.start({ username: 'Example' }, 'group:100001', 5, 'u1')).error, /尚未启用/);
});

test('权限撤销或设置变化中止在途查询，预览不发送QQ', async () => {
  const { manager, config, sent } = setup();
  const page = await manager.preview('Example');
  assert.equal(page.user.username, 'Example'); assert.equal(sent.length, 0);
  manager.cache.clear(); manager.cooldowns.clear();
  let release;
  manager.options.request = async () => new Promise((resolve) => { release = resolve; });
  const running = manager.start({ username: 'Example' }, 'group:100001', 1, 'u1');
  assert.equal(manager.active !== null, true);
  config.xSearch.enabled = false; manager.enforce();
  release({ data: { ...user, protected: true } });
  assert.match((await running).error, /取消|超时/);
  assert.equal(sent.length, 0);
  assert.equal(manager.active, null);
});
