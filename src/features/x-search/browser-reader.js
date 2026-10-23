// 独立东京进程使用：复用用户手动登录的专用 Chrome 目录，只读取公开账号页面。
// 不导出 Cookie，不读取首页推荐、私信或登录账号资料。
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { xSearchCommand } from './command.js';
const WebSocket = globalThis.WebSocket;

class BrowserConnection {
  constructor(socket) {
    this.socket = socket; this.sequence = 0; this.pending = new Map(); this.listeners = new Set();
    socket.addEventListener('message', (event) => {
      let data; try { data = JSON.parse(event.data); } catch { return; }
      if (data.method) { for (const listener of this.listeners) listener(data); return; }
      const entry = this.pending.get(data.id); if (!entry) return;
      this.pending.delete(data.id); clearTimeout(entry.timer);
      if (data.error) entry.reject(new Error('X 浏览器操作失败'));
      else entry.resolve(data.result);
    });
    const closed = () => {
      for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('X 浏览器连接中断')); }
      this.pending.clear();
    };
    socket.addEventListener('error', closed); socket.addEventListener('close', closed);
  }
  call(method, params = {}, sessionId) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('X 浏览器操作超时')); }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new Error('X 浏览器连接中断')); }
    });
  }
}

// 只解析浏览器访问目标公开账号时自然返回的 UserTweets，不发起额外非官方请求。
export function browserResponseRows(username, body) {
  const rows = [];
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (value.tweet_results?.result) {
      const result = value.tweet_results.result;
      const tweet = result.tweet || result;
      const author = tweet.core?.user_results?.result;
      const handle = author?.core?.screen_name || author?.legacy?.screen_name;
      const legacy = tweet.legacy;
      if (handle?.toLowerCase() === username.toLowerCase() && legacy && author?.legacy?.protected !== true
        && author?.privacy?.protected !== true && !legacy.retweeted_status_result && !legacy.in_reply_to_status_id_str) {
        rows.push({ url: `https://x.com/${username}/status/${tweet.rest_id || legacy.id_str}`,
          createdAt: legacy.created_at, text: tweet.note_tweet?.note_tweet_results?.result?.text || legacy.full_text || '',
          sensitive: legacy.possibly_sensitive === true,
          media: (legacy.extended_entities?.media || []).map((m) => ({ type: m.type === 'photo' ? 'photo' : 'video', url: m.media_url_https })) });
      }
      return; // 不把引用帖或推荐账号混进目标时间线。
    }
    if (value.type === 'TimelinePinEntry') return;
    for (const child of Object.values(value)) visit(child);
  };
  visit(body);
  return rows;
}

export function normalizeBrowserPosts(username, rows) {
  const seen = new Set();
  return rows.flatMap((row) => {
    let url; try { url = new URL(row.url, 'https://x.com'); } catch { return []; }
    const match = url.pathname.match(/^\/([a-z0-9_]{1,15})\/status\/(\d{1,20})$/i);
    if (url.origin !== 'https://x.com' || !match || match[1].toLowerCase() !== username.toLowerCase()
      || seen.has(match[2]) || row.repost || row.pinned || !Number.isFinite(Date.parse(row.createdAt))) return [];
    seen.add(match[2]);
    const media = (Array.isArray(row.media) ? row.media : []).filter((m) => {
      try { const image = new URL(m.url); return image.protocol === 'https:' && image.hostname === 'pbs.twimg.com'; } catch { return false; }
    }).slice(0, 4);
    return [{ id: match[2], text: String(row.text || '').slice(0, 25000), createdAt: row.createdAt,
      sensitive: Boolean(row.sensitive), url: `https://x.com/${username}/status/${match[2]}`, media }];
  }).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || (BigInt(a.id) > BigInt(b.id) ? -1 : 1)).slice(0, 5);
}

const READ_PAGE = `(() => {
  const rows = [...document.querySelectorAll('article[data-testid="tweet"]')].map(article => {
    const time = article.querySelector('time');
    const social = article.querySelector('[data-testid="socialContext"]')?.innerText || '';
    return {url: time?.closest('a')?.getAttribute('href') || '', createdAt: time?.getAttribute('datetime') || '',
      text: article.querySelector('[data-testid="tweetText"]')?.innerText || '',
      pinned: /Pinned|置顶|固定/i.test(social), repost: /reposted|retweeted|转帖|转推|轉推/i.test(social),
      sensitive: /sensitive content|敏感内容|敏感內容/i.test(article.innerText),
      media: [...article.querySelectorAll('[data-testid="tweetPhoto"] img')].map(img => ({type:'photo',url:img.src})).concat(
        [...article.querySelectorAll('video[poster]')].map(video => ({type:'video',url:video.poster})))
    };
  });
  const name = document.querySelector('[data-testid="UserName"]')?.innerText?.split('\\n')[0] || '';
  const description = document.querySelector('[data-testid="UserDescription"]')?.innerText || '';
  const login = location.pathname.includes('/login') || location.pathname.includes('/i/flow/');
  const protectedAccount = !!document.querySelector('svg[aria-label="Protected account"],svg[aria-label="受保护的账号"],svg[aria-label="受保护账号"]');
  const translated = document.documentElement.classList.contains('translated-ltr') || document.documentElement.classList.contains('translated-rtl');
  return {rows,name,description,login,protectedAccount,translated,title:document.title};
})()`;

export async function readBrowserAccount(username, options) {
  if (!/^[a-z0-9_]{1,15}$/i.test(username || '') || !xSearchCommand(`X @${username}`)) throw new Error('X 用户名无效');
  const { profileDir, chromePath = '/usr/bin/google-chrome', signal } = options;
  if (!profileDir) throw new Error('未配置 X 专用浏览器目录');
  signal?.throwIfAborted();
  const browser = spawn(chromePath, ['--headless=new', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-extensions', '--disable-sync', '--disable-gpu', '--disable-features=Translate',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profileDir}`, 'about:blank'],
  { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let socket;
  try {
    const endpoint = await new Promise((resolve, reject) => {
      let text = '';
      const timer = setTimeout(() => reject(new Error('X 浏览器未能启动，请确认登录桌面已停止')), 15000);
      const finish = (error, value) => { clearTimeout(timer); if (error) reject(error); else resolve(value); };
      browser.once('error', () => finish(new Error('X 浏览器不可用')));
      browser.once('exit', () => finish(new Error('X 浏览器提前退出；请检查目录锁或内存')));
      browser.stderr.on('data', (chunk) => {
        text = (text + chunk.toString()).slice(-4096);
        const match = text.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/);
        if (match) finish(null, match[1]);
      });
    });
    socket = new WebSocket(endpoint);
    await once(socket, 'open', { signal });
    const cdp = new BrowserConnection(socket);
    const abort = () => { socket.close(); browser.kill('SIGTERM'); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const { targetId } = await cdp.call('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await cdp.call('Target.attachToTarget', { targetId, flatten: true });
      const requests = new Set(); const originals = new Map(); const operations = new Set();
      cdp.listeners.add((event) => {
        if (event.sessionId !== sessionId) return;
        if (event.method === 'Network.responseReceived') {
          const response = event.params?.response;
          let url; try { url = new URL(response?.url); } catch { return; }
          if (['x.com', 'api.x.com'].includes(url.hostname) && url.pathname.includes('/graphql/')) operations.add(url.pathname.split('/').at(-1));
          if (response?.status === 200 && ['x.com', 'api.x.com'].includes(url.hostname) && /\/graphql\/[^/]+\/(?:UserTweets|UserOriginalsTimeline)$/.test(url.pathname)) requests.add(event.params.requestId);
        }
        if (event.method === 'Network.loadingFinished' && requests.delete(event.params?.requestId)) {
          void cdp.call('Network.getResponseBody', { requestId: event.params.requestId }, sessionId).then((response) => {
            if (response.base64Encoded || response.body.length > 2 * 1024 * 1024) return;
            let body; try { body = JSON.parse(response.body); } catch { return; }
            for (const row of browserResponseRows(username, body)) originals.set(row.url, row);
          }).catch(() => {});
        }
      });
      await cdp.call('Network.enable', { maxResourceBufferSize: 2 * 1024 * 1024, maxTotalBufferSize: 4 * 1024 * 1024 }, sessionId);
      await cdp.call('Network.setCacheDisabled', { cacheDisabled: true }, sessionId);
      await cdp.call('Page.enable', {}, sessionId);
      await cdp.call('Page.navigate', { url: `https://x.com/${username}?lang=en` }, sessionId);
      const collected = new Map(); let page;
      for (let attempt = 0; attempt < 24; attempt++) {
        await delay(1000, undefined, { signal });
        const { result } = await cdp.call('Runtime.evaluate', { expression: READ_PAGE, returnByValue: true }, sessionId);
        page = result?.value;
        if (page?.login) throw new Error('X 登录态已失效，请重新手动登录');
        if (page?.protectedAccount) throw new Error('试用版仅读取公开账号');
        for (const row of page?.rows || []) collected.set(row.url, row);
        const originalRows = [...originals.values()];
        const posts = normalizeBrowserPosts(username, originalRows.length ? originalRows : page?.translated ? [] : [...collected.values()]);
        if (posts.length >= 5 && (originalRows.length || attempt >= 7)) return { user: { username, name: page.name || username, description: page.description || '' }, posts,
          next: '', fetchedAt: new Date().toISOString(), partial: false, source: 'tokyo-browser', contentSource: originalRows.length ? 'public-timeline-response' : 'rendered-page',
          ...(options.diagnostics ? { operations: [...operations] } : {}) };
        if (page?.rows?.length) await cdp.call('Runtime.evaluate', { expression: 'window.scrollBy(0,700)' }, sessionId);
      }
      const posts = normalizeBrowserPosts(username, originals.size ? [...originals.values()] : page?.translated ? [] : [...collected.values()]);
      if (!posts.length) throw new Error('未读到公开帖子，可能是登录验证、账号受限或网页结构变化');
      return { user: { username, name: page?.name || username, description: page?.description || '' }, posts,
        next: '', fetchedAt: new Date().toISOString(), partial: true, source: 'tokyo-browser' };
    } finally { signal?.removeEventListener('abort', abort); }
  } finally {
    socket?.close();
    if (browser.exitCode === null) {
      browser.kill('SIGTERM');
      await Promise.race([once(browser, 'exit').catch(() => {}), delay(5000, undefined, { ref: false })]);
      if (browser.exitCode === null) browser.kill('SIGKILL');
    }
  }
}
