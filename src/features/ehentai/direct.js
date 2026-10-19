import http2 from 'node:http2';
import tls from 'node:tls';

const HOST = 'e-hentai.org';

// E站主站在部分网络里 DNS 被污染，且携带 SNI 的 TLS 被重置。只对固定主站使用
// 无 SNI 的 HTTP/2；TLS 证书仍按原始域名严格核验，HTTP/2 :authority 仍是原域名。
export class EhentaiDirect {
  constructor(ips, { attemptTimeoutMs = 7000 } = {}) {
    this.ips = [...ips];
    this.attemptTimeoutMs = attemptTimeoutMs;
    this.session = null;
    this.ip = '';
  }
  close() {
    this.session?.destroy();
    this.session = null;
    this.ip = '';
  }
  open(ip) {
    if (this.session && this.ip === ip && !this.session.closed && !this.session.destroyed) return this.session;
    this.close();
    const session = http2.connect(`https://${HOST}`, {
      createConnection: () => tls.connect({
        host: ip, port: 443, ALPNProtocols: ['h2'], rejectUnauthorized: true,
        checkServerIdentity: (_hostname, certificate) => tls.checkServerIdentity(HOST, certificate)
      })
    });
    session.on('error', () => { /* 每个请求单独报告错误 */ });
    this.session = session;
    this.ip = ip;
    return session;
  }
  async attempt(url, { signal, headers, limit }, ip) {
    const session = this.open(ip);
    return new Promise((resolve, reject) => {
      let stream;
      let status = 0, length = 0, done = false, responseHeaders = {};
      const chunks = [];
      const finish = (error, response) => {
        if (done) return;
        done = true;
        signal.removeEventListener('abort', cancel);
        if (error) reject(error); else resolve(response);
      };
      const cancel = () => { stream?.close(); finish(signal.reason || new Error('请求已取消')); };
      try {
        stream = session.request({ ':method': 'GET', ':path': `${url.pathname}${url.search}`,
          ':authority': HOST, 'user-agent': headers['user-agent'], referer: headers.referer });
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) { cancel(); return; }
        stream.on('response', (head) => {
          status = Number(head[':status']) || 502;
          responseHeaders = { 'content-type': String(head['content-type'] || ''),
            'content-length': String(head['content-length'] || '') };
          if (Number(responseHeaders['content-length']) > limit) {
            stream.close(); finish(new Error('站点返回内容超过大小上限'));
          }
        });
        stream.on('data', (chunk) => {
          length += chunk.length;
          if (length > limit) { stream.close(); finish(new Error('站点返回内容超过大小上限')); return; }
          chunks.push(chunk);
        });
        stream.on('end', () => finish(null, new Response(Buffer.concat(chunks, length), { status: status || 502, headers: responseHeaders })));
        stream.on('error', (error) => finish(error));
        stream.end();
      } catch (error) { finish(error); }
    });
  }
  async fetch(raw, options) {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.hostname !== HOST || url.username || url.password || url.hash) {
      throw new Error('E站无 SNI 直连只允许主站 HTTPS 地址');
    }
    const ips = this.ip ? [this.ip, ...this.ips.filter((ip) => ip !== this.ip)] : this.ips;
    let lastError;
    for (const ip of ips) {
      const attemptSignal = AbortSignal.any([options.signal, AbortSignal.timeout(this.attemptTimeoutMs)]);
      try { return await this.attempt(url, { ...options, signal: attemptSignal }, ip); }
      catch (error) {
        lastError = error;
        this.close();
        if (options.signal.aborted || /内容超过大小上限/.test(error.message)) throw error;
      }
    }
    throw new Error(`E站直连失败：${lastError?.message || '无法连接'}`);
  }
}
