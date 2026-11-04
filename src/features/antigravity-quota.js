// Antigravity 反代额度：读取东京面板的账号配额，供每晚汇报使用。
//
// 面板 API 的鉴权口径（2026-11 实测）：`/api/accounts` **不认 API Key**，
// 只认 `authorization: Bearer <网页密码>`（即 AM 的 WEB_PASSWORD）。所以这里的
// webPassword 是面板登录密码，不是模型 API Key —— 两者不要混用。
//
// 额度是"5 小时 / 每周"两个滚动窗口的剩余比例，读之前先让面板向上游刷新一次，
// 这样报告里的数字是发报告那一刻的，而不是几小时前的缓存。

export const DEFAULT_ANTIGRAVITY_QUOTA = Object.freeze({
  baseUrl: 'http://127.0.0.1:18045',
  webPassword: ''
});

const REFRESH_TIMEOUT_MS = 20000;
const READ_TIMEOUT_MS = 12000;

/** 校验额度来源设置；baseUrl 只允许 http(s)，密码留空表示"沿用已保存的值"。 */
export function validateQuotaSource(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('反代额度设置须为对象');
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(DEFAULT_ANTIGRAVITY_QUOTA, key)) throw new Error(`未知反代额度设置：${key}`);
    if (typeof value !== 'string') throw new Error('反代额度设置须为字符串');
    if (key === 'baseUrl' && value.trim()) {
      let url;
      try { url = new URL(value.trim()); } catch { throw new Error('反代面板地址无效'); }
      if (!/^https?:$/.test(url.protocol)) throw new Error('反代面板地址须为 http(s)');
    }
  }
}

/** 合并默认值；地址去掉尾部斜杠，非法值退回默认地址（读不到就明确报错，不静默换源）。 */
export function quotaSourceConfig(raw = {}) {
  const merged = { ...DEFAULT_ANTIGRAVITY_QUOTA, ...(raw && typeof raw === 'object' ? raw : {}) };
  const base = String(merged.baseUrl || '').trim().replace(/\/+$/, '');
  return {
    baseUrl: /^https?:\/\//i.test(base) ? base : DEFAULT_ANTIGRAVITY_QUOTA.baseUrl,
    webPassword: String(merged.webPassword || '')
  };
}

function timeoutSignal(ms, outer) {
  const signals = [AbortSignal.timeout(ms)];
  if (outer) signals.push(outer);
  return AbortSignal.any(signals);
}

async function requestJson(url, { method = 'GET', password, body, signal, timeoutMs, fetchImpl }) {
  const headers = { authorization: `Bearer ${password}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const doFetch = fetchImpl || fetch;
  const res = await doFetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: timeoutSignal(timeoutMs, signal)
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`面板返回 HTTP ${res.status}${text ? `：${text.slice(0, 120)}` : ''}`);
  }
  try { return JSON.parse(text); } catch { throw new Error('面板返回的不是 JSON'); }
}

function parseTime(raw) {
  if (!raw) return null;
  const ts = Date.parse(String(raw));
  return Number.isFinite(ts) ? ts : null;
}

function normalizeBucket(raw) {
  const fraction = Number(raw?.remaining_fraction);
  return {
    window: String(raw?.window || ''),
    remaining: Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : null,
    resetAt: parseTime(raw?.reset_time)
  };
}

/** 面板返回的账号列表 → 报告只需要的最小结构。 */
export function normalizeQuota(payload) {
  const accounts = Array.isArray(payload?.accounts) ? payload.accounts : [];
  return accounts.map(account => {
    const quota = account?.quota || {};
    const groups = (Array.isArray(quota.quota_groups) ? quota.quota_groups : []).map(group => ({
      name: String(group?.display_name || group?.name || '未命名'),
      buckets: (Array.isArray(group?.buckets) ? group.buckets : []).map(normalizeBucket)
        .filter(bucket => bucket.remaining !== null)
    })).filter(group => group.buckets.length > 0);
    return {
      email: String(account?.email || ''),
      tier: String(quota.subscription_tier || ''),
      current: account?.is_current === true,
      disabled: account?.disabled === true || account?.proxy_disabled === true,
      groups,
      updatedAt: Number.isFinite(Number(quota.last_updated)) ? Number(quota.last_updated) * 1000 : null
    };
  });
}

/**
 * 读一次额度。失败时**不抛给调用方决定**：日报里要能写清"读取失败"而不是整篇不发。
 * 返回 { ok, accounts, refreshedAt, error }。
 */
export async function fetchAntigravityQuota(source, { signal, refresh = true, fetchImpl } = {}) {
  const settings = quotaSourceConfig(source);
  if (!settings.webPassword) {
    return { ok: false, accounts: [], refreshedAt: null, error: '未配置面板网页密码' };
  }
  const doFetch = fetchImpl || fetch;
  const call = (path, options) => requestJson(`${settings.baseUrl}${path}`, {
    password: settings.webPassword,
    signal,
    fetchImpl: doFetch,
    ...options
  });
  let refreshError = '';
  if (refresh) {
    try {
      await call('/api/accounts/refresh', { method: 'POST', body: {}, timeoutMs: REFRESH_TIMEOUT_MS });
    } catch (error) {
      // 刷新失败仍然读旧值：旧值比"没有额度"有用，但必须标注出来。
      if (signal?.aborted) throw error;
      refreshError = `刷新失败（${String(error?.message || error).slice(0, 80)}），以下为面板缓存`;
      console.warn(`[antigravity-quota] ${refreshError}`);
    }
  }
  try {
    const payload = await call('/api/accounts', { timeoutMs: READ_TIMEOUT_MS });
    return {
      ok: true,
      accounts: normalizeQuota(payload),
      refreshedAt: refreshError ? null : Date.now(),
      error: refreshError
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { ok: false, accounts: [], refreshedAt: null, error: String(error?.message || error).slice(0, 120) };
  }
}

const WINDOW_LABEL = { '5h': '5小时', weekly: '每周', daily: '每日', monthly: '每月' };
const PERIOD_LABEL = { 5: '5小时', weekly: '每周' };

function bjt(momentMs) {
  return new Date(momentMs + 8 * 3600000).toISOString();
}

function clockText(momentMs) {
  return `${bjt(momentMs).slice(5, 10)} ${bjt(momentMs).slice(11, 16)}`;
}

function maskEmail(email) {
  const [name, domain] = String(email || '').split('@');
  if (!name) return '未知账号';
  return `${name.slice(0, 3)}***@${domain || ''}`;
}

function windowText(bucket) {
  const label = WINDOW_LABEL[bucket.window] || PERIOD_LABEL[bucket.window] || bucket.window || '额度';
  const reset = bucket.resetAt ? clockText(bucket.resetAt) : '重置时间未知';
  return `${label} 剩${(bucket.remaining * 100).toFixed(1)}%（${reset}）`;
}

/**
 * 报告里的额度段落。读取失败也返回一行，写明原因 —— 空着会让人以为"额度无限"。
 * 返回行数组（调用方决定插在报告哪里）。
 */
export function formatQuotaLines(quota) {
  if (!quota) return [];
  if (!quota.ok) return [`反代额度：读取失败（${quota.error || '原因未知'}）；本次未包含`];
  if (!quota.accounts.length) return ['反代额度：面板里没有账号'];
  const lines = [];
  const stamp = quota.refreshedAt ? clockText(quota.refreshedAt) : '面板缓存';
  lines.push(`反代额度（${stamp}）`);
  for (const account of quota.accounts) {
    const who = `${maskEmail(account.email)}${account.tier ? ` [${account.tier}]` : ''}`
      + `${account.current ? ' · 当前使用' : ''}${account.disabled ? ' · 已停用' : ''}`;
    lines.push(who);
    if (!account.groups.length) {
      lines.push('  面板没有返回分组额度（可能尚未刷新成功）');
      continue;
    }
    for (const group of account.groups) {
      lines.push(`  ${group.name}：${group.buckets.map(windowText).join('｜')}`);
    }
  }
  if (quota.error) lines.push(`注：${quota.error}`);
  return lines;
}
