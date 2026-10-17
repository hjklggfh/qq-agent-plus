import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { cleanTitle, publicLink } from './common.js';

export function googleResultRows(rows, limit = 3) {
  const seen = new Set();
  const results = [];
  for (const row of rows) {
    let url = publicLink(row.url);
    if (!url) continue;
    const parsed = new URL(url);
    if (parsed.hostname === 'www.google.com' && parsed.pathname === '/url') url = publicLink(parsed.searchParams.get('q') || parsed.searchParams.get('url'));
    if (!url) continue;
    const host = new URL(url).hostname;
    if (/(^|\.)(google\.[a-z.]+|gstatic\.com|googleusercontent\.com|youtube\.googleapis\.com)$/.test(host) || seen.has(url)) continue;
    const title = cleanTitle(row.title);
    if (title.length < 3) continue;
    seen.add(url);
    results.push({ title, url, thumbnail: publicLink(row.thumbnail) });
    if (results.length >= limit) break;
  }
  return results;
}

class CdpConnection {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    socket.on('message', (raw) => {
      let data;
      try { data = JSON.parse(raw); } catch { return; }
      const pending = this.pending.get(data.id);
      if (!pending) return;
      this.pending.delete(data.id);
      clearTimeout(pending.timer);
      if (data.error) pending.reject(new Error('浏览器操作失败'));
      else pending.resolve(data.result);
    });
    socket.on('close', () => this.rejectAll());
    socket.on('error', () => this.rejectAll());
  }
  rejectAll() {
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error('浏览器连接已关闭')); }
    this.pending.clear();
  }
  call(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('浏览器操作超时')); }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }), (error) => {
        if (error && this.pending.has(id)) { clearTimeout(timer); this.pending.delete(id); reject(error); }
      });
    });
  }
}

export async function googleLens(image, options = {}) {
  const executable = options.chromePath || process.env.IMAGE_SEARCH_CHROME;
  if (!executable) return { platform: 'google', status: 'unavailable', message: '东京中转尚未配置 Chrome 浏览器', results: [] };
  const signal = options.signal;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-lens-'));
  let child, socket;
  let browserError = false;
  try {
    const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[image.type] || 'jpg';
    const file = path.join(dir, `image.${extension}`);
    await fs.writeFile(file, image.buffer, { mode: 0o600 });
    child = spawn(executable, ['--headless=new', '--disable-dev-shm-usage', '--no-first-run', '--disable-background-networking', '--disable-extensions', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${path.join(dir, 'profile')}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    child.on('error', () => { browserError = true; });
    // 避免 stderr 管道塞满；不把页面、临时路径或浏览器诊断写到普通日志。
    child.stderr.resume();
    const onAbort = () => { child.kill('SIGKILL'); socket?.terminate(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      let endpoint;
      for (let i = 0; i < 100; i++) {
        signal?.throwIfAborted();
        if (browserError || child.exitCode != null || child.signalCode) throw new Error('浏览器未能启动，请检查可执行文件、系统依赖和沙箱配置');
        try {
          const [port, browserPath] = (await fs.readFile(path.join(dir, 'profile', 'DevToolsActivePort'), 'utf8')).trim().split('\n');
          if (/^\d+$/.test(port) && browserPath.startsWith('/devtools/browser/')) { endpoint = `ws://127.0.0.1:${port}${browserPath}`; break; }
        } catch { /* 浏览器仍在启动。 */ }
        await delay(100, undefined, { signal });
      }
      if (!endpoint) throw new Error('浏览器启动超时');
      socket = new WebSocket(endpoint, { handshakeTimeout: 5000 });
      await once(socket, 'open', { signal });
      const cdp = new CdpConnection(socket);
      const { targetId } = await cdp.call('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await cdp.call('Target.attachToTarget', { targetId, flatten: true });
      const evaluate = async (expression) => {
        const value = await cdp.call('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
        if (value.exceptionDetails) throw new Error('页面脚本执行失败');
        return value.result?.value;
      };
      await cdp.call('Page.enable', {}, sessionId);
      // 上传本地临时图片，避免把 QQ 私有图片链接暴露给外部搜索站点。
      await cdp.call('Page.navigate', { url: 'https://www.google.com/imghp?hl=en' }, sessionId);
      let uploaded = false;
      const deadline = Date.now() + (options.timeoutSeconds || 45) * 1000;
      while (Date.now() < deadline) {
        signal?.throwIfAborted();
        const state = await evaluate(`({url: location.href, text: document.body?.innerText?.slice(0,12000) || '', file: !!document.querySelector('input[type=file]')})`);
        if (!state) { await delay(500, undefined, { signal }); continue; }
        if (/\/sorry\/|consent.google/.test(state.url) || /unusual traffic|not a robot|before you continue to google/i.test(state.text)) return { platform: 'google', status: 'blocked', message: 'Google 要求验证码或同意确认，请换平台', results: [] };
        if (/can't upload|unsupported image|file is too large/i.test(state.text)) return { platform: 'google', status: 'error', message: 'Google 不接受当前图片格式或大小，请换静态 PNG/JPEG 图片', results: [] };
        if (!uploaded) {
          if (!state.file) {
            await evaluate(`document.querySelector('[aria-label="Search by image"]')?.click()`);
          } else {
            const { root } = await cdp.call('DOM.getDocument', { depth: 1 }, sessionId);
            const { nodeId } = await cdp.call('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' }, sessionId);
            if (nodeId) { await cdp.call('DOM.setFileInputFiles', { nodeId, files: [file] }, sessionId); uploaded = true; }
          }
        } else {
          const rows = await evaluate(`Array.from(document.querySelectorAll('#search a[href], #rso a[href], a[data-ved][href]')).filter(a => a.querySelector('img, h3')).map(a => ({url:a.href,title:a.querySelector('h3')?.innerText || a.innerText || a.getAttribute('aria-label') || a.querySelector('img')?.alt,thumbnail:a.querySelector('img')?.src})).slice(0,100)`);
          const results = googleResultRows(rows || [], options.limit || 3);
          if (results.length) return { platform: 'google', status: 'ok', results };
        }
        await delay(700, undefined, { signal });
      }
      return { platform: 'google', status: 'empty', message: '未取得 Google 结果；可能无匹配或页面结构变化', results: [] };
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  } finally {
    socket?.terminate();
    if (child?.pid && child.exitCode == null) {
      child.kill('SIGKILL');
      await Promise.race([once(child, 'exit').catch(() => {}), delay(2000)]);
    }
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
}
