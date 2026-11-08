// 第二人设"现在到底能不能用"的探针。
//
// 背景：切人设只看配置（开关 + 模型名 + 正文），并不代表那个模型此刻真的能调通。
// 额度用完 / key 失效 / 模型被中转站下架时，如果照切不误，就会出现
// "Claude 的名片 + Claude 的头像 + 兜底模型在替他说话"——比不切更糟。
//
// 所以召唤前先打一个**极小**的请求（max_tokens=1，思考关掉）：
//   - 成功：花掉对方几 token，放行；
//   - 硬失败（401/402/403/额度/欠费/模型不存在）：拦下，不切；
//   - 软失败（429 限流、5xx、超时、网络）：**放行** —— 偶发抖动不该让"克劳德今天不上班"，
//     交给正常的重试与并发处理。
// 结果按模型缓存：成功 30 分钟、失败 5 分钟。同一个群反复喊不会反复探。
import { chatCompletion } from '../llm/llm.js';

const SUCCESS_TTL_MS = 30 * 60 * 1000;
const FAIL_TTL_MS = 5 * 60 * 1000;

/** model -> { ok, reason, at } */
const cache = new Map();

/**
 * 把一次失败归类。返回 '' 表示"不是硬失败"（限流/网络/超时，可以照常切）。
 * @returns {'' | 'auth' | 'quota' | 'model'}
 */
export function classifyUnavailable(error) {
  const msg = String(error?.message ?? error ?? '');
  if (!msg) return '';
  // 模型不存在 / 被下架：配置问题，切过去只会每次 404
  if (/HTTP\s*404/i.test(msg) || /model\s*(not\s*found|not\s*exist)|模型不存在|无此模型/i.test(msg)) return 'model';
  // 额度 / 欠费
  if (/余额|欠费|额度|quota|insufficient|exceeded your current quota|billing/i.test(msg)) return 'quota';
  // 鉴权 / 无权限
  if (/HTTP\s*(401|402|403)/i.test(msg) || /unauthorized|forbidden|invalid api.?key|incorrect api.?key|无权限/i.test(msg)) return 'auth';
  return '';
}

/** 硬失败（要拦）vs 软失败（放行）。 */
export function isHardUnavailable(error) {
  return classifyUnavailable(error) !== '';
}

/** 测试与"手动复位"用。 */
export function resetProbeCache() {
  cache.clear();
}

/** 读缓存（过期即删）。 */
export function probeState(model, now = Date.now()) {
  const name = String(model || '').trim();
  if (!name) return null;
  const hit = cache.get(name);
  if (!hit) return null;
  const ttl = hit.ok ? SUCCESS_TTL_MS : FAIL_TTL_MS;
  if (now - Number(hit.at || 0) > ttl) {
    cache.delete(name);
    return null;
  }
  return { ...hit };
}

export function markProbeResult(model, { ok, reason = '', now = Date.now() } = {}) {
  const name = String(model || '').trim();
  if (!name) return;
  cache.set(name, { ok: ok === true, reason: String(reason || ''), at: Number(now) || Date.now() });
}

async function defaultProbeCall(model) {
  return chatCompletion({
    model,
    maxTokens: 1,
    temperature: 0,
    // 思考必须关掉：有的渠道在开思考时对 max_tokens=1 直接 400
    purpose: 'chat',
    messages: [{ role: 'user', content: 'ping' }]
  });
}

/**
 * 探一次某个模型此刻能不能用。
 * @param {object} opts
 * @param {string} opts.model
 * @param {number} [opts.now]
 * @param {(model: string) => Promise<any>} [opts.call] 注入用（测试）
 * @param {boolean} [opts.useCache=true]
 * @returns {Promise<{ok: boolean, reason: string, cached: boolean}>}
 */
export async function probeModel({ model, now = Date.now(), call = defaultProbeCall, useCache = true } = {}) {
  const name = String(model || '').trim();
  if (!name) return { ok: false, reason: 'model', cached: false };
  if (useCache) {
    const hit = probeState(name, now);
    if (hit) return { ok: hit.ok, reason: hit.reason, cached: true };
  }
  try {
    const probeCall = call;
    await probeCall(name);
    markProbeResult(name, { ok: true, now });
    return { ok: true, reason: '', cached: false };
  } catch (error) {
    const reason = classifyUnavailable(error);
    // 软失败：放行，不缓存失败（否则一次抖动会把模型拉黑五分钟）
    if (!reason) return { ok: true, reason: 'transient', cached: false };
    markProbeResult(name, { ok: false, reason, now });
    return { ok: false, reason, cached: false };
  }
}
