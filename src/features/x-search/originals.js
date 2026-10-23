import http from 'node:http';
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { openXRelayImage, xImageUrl } from './relay-image.js';
import { validateXRelayUrl } from './relay-client.js';
import { boundedXImage, X_IMAGE_EXTENSIONS } from './image-stream.js';

export async function downloadXOriginal(item, settings, destination, signal) {
  xImageUrl(item.media.url, true);
  let image;
  if (settings.backend === 'tokyo-browser') {
    const target = new URL('/original', validateXRelayUrl(settings.relayUrl));
    target.searchParams.set('post', item.postId); target.searchParams.set('index', String(item.index));
    image = await new Promise((resolve, reject) => {
      const request = http.get(target, { signal, headers: { Authorization: `Bearer ${settings.relayToken}` } }, (res) => {
        res.on('error', () => {});
        if (res.statusCode !== 200) { res.destroy(); reject(new Error(res.statusCode === 410 ? '东京原图索引已过期，请重新搜索该页' : res.statusCode === 429 ? '东京服务忙，请稍后再试' : '东京未能读取原图')); return; }
        resolve({ stream: res, contentType: String(res.headers['content-type'] || '').split(';')[0] });
      });
      request.on('error', () => reject(new Error('东京原图连接失败')));
    });
  } else image = await openXRelayImage(item.media.url, { original: true, signal });
  try {
    const limiter = boundedXImage(image.contentType);
    await pipeline(image.stream, limiter, fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 }), { signal });
    return { bytes: fs.statSync(destination).size, extension: X_IMAGE_EXTENSIONS[image.contentType] };
  } catch (error) {
    fs.rmSync(destination, { force: true }); throw error;
  } finally { image.stream.destroy(); }
}
