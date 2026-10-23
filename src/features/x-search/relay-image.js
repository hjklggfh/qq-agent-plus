import https from 'node:https';
import dns from 'node:dns/promises';

export async function readXRelayImage(raw, options = {}) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.hostname !== 'pbs.twimg.com' || url.username || url.password) throw new Error('非 X 图片地址');
  url.search = ''; url.hash = '';
  if (url.pathname.startsWith('/media/')) { url.searchParams.set('name', 'small'); url.searchParams.set('format', 'jpg'); }
  const addresses = await dns.lookup('pbs.twimg.com', { all: true, family: 4 });
  if (!addresses.length || addresses.some(({ address }) => {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168))
      || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19));
  })) throw new Error('X 图片地址解析异常');
  return new Promise((resolve, reject) => {
    const request = https.get({ hostname: addresses[0].address, servername: 'pbs.twimg.com',
      path: url.pathname + url.search, headers: { Host: 'pbs.twimg.com', Accept: 'image/*' }, signal: options.signal }, (res) => {
      res.on('error', reject);
      const contentType = String(res.headers['content-type'] || '').split(';')[0];
      if (res.statusCode !== 200 || !['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(contentType)) {
        res.resume(); reject(new Error('X 缩略图不可用')); return;
      }
      let bytes = 0; const chunks = [];
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) { reject(new Error('X 缩略图超过限制')); res.destroy(); return; }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ buffer: Buffer.concat(chunks), contentType }));
    });
    request.on('error', () => reject(new Error('X 缩略图连接失败')));
  });
}
