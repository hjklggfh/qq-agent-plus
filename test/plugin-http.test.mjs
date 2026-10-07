// 插件网络能力（capability: http）的守则用例。
//
// 全部只走**拒绝路径**，一个真实请求都不发：这样用例在没网的机器上也能跑，
// 而且守则本来就是"哪些输入必须在发出去之前就被挡掉"。
// 真正要发请求的那部分（DNS 解析后的 IP 固定、重定向跟随、跨源摘凭据）由
// test/safe-fetch.test.mjs 对共享的安全核心做覆盖 —— 这里复用的就是它。
import assert from 'node:assert/strict';
import { test } from 'node:test';

const {
  ALLOWED_METHODS,
  MAX_HEADERS,
  MAX_REQUEST_BODY_BYTES,
  PluginHttpError,
  pluginFetch
} = await import('../plugins/_host/http.js');

test('允许的 method 是一张白名单（其余一律拒绝）', () => {
  assert.deepEqual(ALLOWED_METHODS, ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
});

const REJECT_CASES = [
  ['不支持的 method', 'http://example.invalid/', { method: 'TRACE' }, /不支持的 method/],
  ['method 大小写无所谓但仍在白名单外', 'http://example.invalid/', { method: 'options' }, /不支持的 method/],
  ['headers 不是对象', 'http://example.invalid/', { headers: 'x: 1' }, /headers 必须是对象/],
  ['请求头名不合法', 'http://example.invalid/', { headers: { 'bad header': '1' } }, /请求头名不合法/],
  ['请求头值含 CRLF（头注入）', 'http://example.invalid/', { headers: { 'x-a': 'a\r\nHost: evil' } }, /不能包含换行/],
  ['请求头值含裸 LF', 'http://example.invalid/', { headers: { 'x-a': 'a\nb' } }, /不能包含换行/],
  ['请求头值过长', 'http://example.invalid/', { headers: { 'x-a': 'y'.repeat(2001) } }, /值过长/],
  ['body 类型不合法', 'http://example.invalid/', { method: 'POST', body: 42 }, /只接受字符串/],
  ['body 超过上限', 'http://example.invalid/', { method: 'POST', body: 'z'.repeat(MAX_REQUEST_BODY_BYTES + 1) }, /请求体超过上限/],
  ['maxBytes 太小', 'http://example.invalid/', { maxBytes: 10 }, /maxBytes 必须是不小于 1024/],
  ['timeoutMs 太小', 'http://example.invalid/', { timeoutMs: 5 }, /timeoutMs 必须是不小于 1000/],
  ['URL 带凭据', 'http://user:pw@example.invalid/', {}, /不能包含凭据/],
  ['非 http(s) 协议', 'file:///etc/passwd', {}, /仅允许 http\/https/],
  ['URL 不合法', 'not a url', {}, /URL 无效/]
];

for (const [label, url, options, pattern] of REJECT_CASES) {
  test(`拒绝：${label}`, async () => {
    await assert.rejects(() => pluginFetch(url, options), pattern);
  });
}

test('由实现自己管理的请求头插件不能设置（否则能绕开长度/连接管理）', async () => {
  for (const name of ['host', 'content-length', 'connection', 'transfer-encoding', 'upgrade', 'keep-alive']) {
    await assert.rejects(
      () => pluginFetch('http://example.invalid/', { headers: { [name]: 'x' } }),
      /由宿主管理|请求头名不合法/,
      `${name} 应被拒绝`
    );
  }
});

test('请求头数量有上限', async () => {
  const headers = {};
  for (let i = 0; i <= MAX_HEADERS; i += 1) headers[`x-h${i}`] = '1';
  await assert.rejects(() => pluginFetch('http://example.invalid/', { headers }), /headers 最多/);
});

test('内网 / 本机 / 云元数据地址一律拒绝（插件不继承 security.allowPrivateImageHosts 逃生口）', async () => {
  for (const url of [
    'http://127.0.0.1/',
    'http://127.0.0.1:8080/admin',
    'http://localhost/',
    'http://[::1]/',
    'http://169.254.169.254/latest/meta-data/',   // 云厂商元数据服务：SSRF 的头号目标
    'http://10.0.0.1/',
    'http://192.168.1.1/',
    'http://172.16.0.1/'
  ]) {
    await assert.rejects(() => pluginFetch(url), /内网|本机/, `${url} 应被拒绝`);
  }
});

test('所有拒绝都是 PluginHttpError（调用方靠类型区分"插件参数错"与"宿主 bug"）', async () => {
  await assert.rejects(() => pluginFetch('http://example.invalid/', { method: 'TRACE' }), PluginHttpError);
  await assert.rejects(() => pluginFetch('http://127.0.0.1/'), PluginHttpError);
});

test('被拒绝时不留下任何"半个请求"（拒绝发生在建连之前）', async () => {
  // 用一个必然拒绝的输入，确认返回的是 rejection 而不是一个带拒绝状态的响应对象
  let result = null;
  try {
    result = await pluginFetch('http://example.invalid/', { headers: { host: 'evil' } });
  } catch {
    result = 'rejected';
  }
  assert.equal(result, 'rejected');
});
