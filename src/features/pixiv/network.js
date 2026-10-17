import net from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { validateFetchUrl } from '../../llm/safe-fetch.js';

const agents = new Map();
// 与旧下载链路独立运行，既不读取搜图中转配置，也不访问东京。
export async function pixivFetch(raw, init = {}) {
  let target = String(raw);
  let headers = { ...init.headers };
  for (let hop = 0; hop <= 5; hop++) {
    init.signal?.throwIfAborted();
    const { url, ip } = await validateFetchUrl(target);
    if (!/(^|\.)pixiv\.net$/i.test(url.hostname)) delete headers.Cookie;
    const key = `${url.origin}|${ip}`;
    if (!agents.has(key)) {
      agents.set(key, new Agent({ connect: { lookup: (_host, options, callback) => {
        const done = callback;
        if (options.all) done(null, [{ address: ip, family: net.isIP(ip) }]);
        else done(null, ip, net.isIP(ip));
      } } }));
      if (agents.size > 32) { const first = agents.keys().next().value; agents.get(first).close().catch(() => {}); agents.delete(first); }
    }
    // Agent 与 fetch 必须来自同一份 undici；Node22 的内置 fetch 与 undici8 不兼容。
    const response = await undiciFetch(url, { ...init, headers, redirect: 'manual', dispatcher: init.dispatcher || agents.get(key) });
    if (init.redirect === 'manual' || ![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) throw new Error('图片重定向缺少地址');
    const next = new URL(location, url);
    if (next.origin !== url.origin) { headers = { ...headers }; delete headers.Cookie; delete headers.Authorization; }
    target = next.href;
  }
  throw new Error('重定向次数过多');
}
