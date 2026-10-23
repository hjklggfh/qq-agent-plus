import https from 'node:https';
import dns from 'node:dns/promises';

export function xImageUrl(raw, original = false) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.hostname !== 'pbs.twimg.com' || url.port || url.username || url.password) throw new Error('非 X 图片地址');
  const format = (url.searchParams.get('format') || url.pathname.match(/\.(jpg|jpeg|png|webp|gif)$/i)?.[1] || 'jpg').toLowerCase();
  if (original && (!/^\/media\/[a-z0-9_-]+(?:\.(?:jpg|jpeg|png|webp|gif))?$/i.test(url.pathname) || !['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(format))) throw new Error('非 X 照片原图地址');
  url.search = ''; url.hash = '';
  if (url.pathname.startsWith('/media/')) {
    if (original) url.pathname = url.pathname.replace(/\.(jpg|jpeg|png|webp|gif)$/i, '');
    url.searchParams.set('name', original ? 'orig' : 'small'); url.searchParams.set('format', original ? format : 'jpg');
  }
  return url;
}

export async function openXRelayImage(raw, options = {}) {
  const url = xImageUrl(raw, options.original);
  const addresses = await dns.lookup('pbs.twimg.com', { all: true, family: 4 });
  if (!addresses.length || addresses.some(({ address }) => {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168))
      || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19));
  })) throw new Error('X 图片地址解析异常');
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const request = https.get({ hostname: addresses[0].address, servername: 'pbs.twimg.com',
      path: url.pathname + url.search, headers: { Host: 'pbs.twimg.com', Accept: 'image/*' }, signal: options.signal }, (res) => {
      res.on('error', () => {}); // 响应交接给 pipeline 前也必须监听。
      const contentType = String(res.headers['content-type'] || '').split(';')[0];
      if (res.statusCode !== 200 || !['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(contentType)) {
        res.destroy(); reject(new Error('X 图片不可用')); return;
      }
      resolve({ stream: res, contentType });
    });
    request.on('error', () => reject(new Error('X 缩略图连接失败')));
  });
}

export async function readXRelayImage(raw, options = {}) {
  const { stream, contentType } = await openXRelayImage(raw, options);
  let bytes = 0; const chunks = [];
  try {
    for await (const chunk of stream) {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) throw new Error('X 缩略图超过限制');
      chunks.push(chunk);
    }
    return { buffer: Buffer.concat(chunks), contentType };
  } finally { stream.destroy(); }
}
