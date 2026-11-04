import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchAntigravityQuota, formatQuotaLines, normalizeQuota, quotaSourceConfig, validateQuotaSource } from '../src/features/antigravity-quota.js';

const PANEL = {
  accounts: [{
    email: 'someone@gmail.com',
    is_current: true,
    disabled: false,
    quota: {
      subscription_tier: 'PRO',
      last_updated: 1793718674,
      quota_groups: [
        { display_name: 'Gemini Models', buckets: [
          { window: 'weekly', remaining_fraction: 0.978, reset_time: '2026-11-10T14:54:15Z' },
          { window: '5h', remaining_fraction: 0.9891, reset_time: '2026-11-04T05:54:15Z' }
        ] },
        { display_name: 'Claude and GPT models', buckets: [
          { window: 'weekly', remaining_fraction: 0.98, reset_time: '2026-11-10T15:06:47Z' }
        ] }
      ]
    }
  }]
};

function mockFetch(handler) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body });
    const reply = await handler(String(url), init);
    return {
      ok: reply.status === undefined || (reply.status >= 200 && reply.status < 300),
      status: reply.status ?? 200,
      text: async () => (typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body))
    };
  };
  return { impl, calls };
}

test('refreshes the panel first, then reads accounts with the web password', async () => {
  const { impl, calls } = mockFetch(url => (url.endsWith('/refresh')
    ? { body: { total: 1, success: 1 } } : { body: PANEL }));
  const result = await fetchAntigravityQuota({ baseUrl: 'http://127.0.0.1:18045/', webPassword: 'web-pass' }, { fetchImpl: impl });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'http://127.0.0.1:18045/api/accounts/refresh');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[1].method, 'GET');
  assert.equal(calls[1].url, 'http://127.0.0.1:18045/api/accounts');
  for (const call of calls) assert.equal(call.headers.authorization, 'Bearer web-pass');
  assert.equal(result.ok, true);
  assert.equal(result.error, '');
  assert.ok(result.refreshedAt > 0);
  assert.equal(result.accounts[0].email, 'someone@gmail.com');
  assert.equal(result.accounts[0].tier, 'PRO');
  assert.equal(result.accounts[0].groups[0].name, 'Gemini Models');
  assert.equal(result.accounts[0].groups[0].buckets[0].remaining, 0.978);
});

test('a failed refresh still returns the cached numbers but says so', async () => {
  const { impl } = mockFetch(url => (url.endsWith('/refresh') ? { status: 500, body: 'boom' } : { body: PANEL }));
  const result = await fetchAntigravityQuota({ webPassword: 'p' }, { fetchImpl: impl });
  assert.equal(result.ok, true);
  assert.equal(result.refreshedAt, null);
  assert.match(result.error, /刷新失败/);
  assert.match(formatQuotaLines(result).join('\n'), /面板缓存/);
});

test('read failure is reported instead of throwing, and the report line says why', async () => {
  const { impl } = mockFetch(() => ({ status: 401, body: 'unauthorized' }));
  const result = await fetchAntigravityQuota({ webPassword: 'wrong' }, { fetchImpl: impl, refresh: false });
  assert.equal(result.ok, false);
  assert.match(result.error, /HTTP 401/);
  assert.match(formatQuotaLines(result)[0], /读取失败.*HTTP 401/);
});

test('missing password never hits the network', async () => {
  const { impl, calls } = mockFetch(() => ({ body: PANEL }));
  const result = await fetchAntigravityQuota({ baseUrl: 'http://127.0.0.1:18045', webPassword: '' }, { fetchImpl: impl });
  assert.equal(calls.length, 0);
  assert.equal(result.ok, false);
  assert.match(result.error, /未配置/);
});

test('normalization drops unknown shapes rather than inventing numbers', () => {
  const accounts = normalizeQuota({ accounts: [
    { email: 'a@b.c', quota: { quota_groups: [
      { display_name: 'Gemini', buckets: [{ window: '5h', remaining_fraction: 2 }] },
      { display_name: 'Empty', buckets: [] }
    ] } },
    { email: 'no-quota@b.c' }
  ] });
  assert.equal(accounts[0].groups.length, 1, '空分组被丢弃');
  assert.equal(accounts[0].groups[0].buckets[0].remaining, 1, '比例被夹到 0..1');
  assert.deepEqual(accounts[1].groups, []);
  const lines = formatQuotaLines({ ok: true, accounts, refreshedAt: Date.now(), error: '' }).join('\n');
  assert.match(lines, /a\*\*\*@b\.c/);
  assert.match(lines, /Gemini：5小时 剩100\.0%/);
});

test('settings validation only accepts http(s) and known keys', () => {
  validateQuotaSource({ baseUrl: 'https://panel.example.com', webPassword: 'x' });
  validateQuotaSource({ baseUrl: '', webPassword: '' });
  assert.throws(() => validateQuotaSource({ baseUrl: 'ftp://x' }));
  assert.throws(() => validateQuotaSource({ baseUrl: 'not a url' }));
  assert.throws(() => validateQuotaSource({ extra: 'x' }));
  assert.throws(() => validateQuotaSource({ webPassword: 123 }));
  assert.throws(() => validateQuotaSource(null));
  assert.deepEqual(quotaSourceConfig({ baseUrl: 'http://h:1///', webPassword: 'p' }), { baseUrl: 'http://h:1', webPassword: 'p' });
  assert.equal(quotaSourceConfig({ baseUrl: 'ftp://bad' }).baseUrl, 'http://127.0.0.1:18045');
});
