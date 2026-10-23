import { Transform } from 'node:stream';

export const X_ORIGINAL_MAX_BYTES = 25 * 1024 * 1024;
export const X_IMAGE_EXTENSIONS = Object.freeze({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' });

// 只检查签名和字节数，原图不解码、不缩放、不重编码。
export function boundedXImage(contentType, maxBytes = X_ORIGINAL_MAX_BYTES) {
  if (!X_IMAGE_EXTENSIONS[contentType]) throw new Error('原图类型无效');
  let bytes = 0; let prefix = Buffer.alloc(0); let checked = false;
  const transform = (chunk, _encoding, callback) => {
    bytes += chunk.length;
    if (bytes > maxBytes) { callback(new Error('X 原图超过单张大小限制')); return; }
    if (!checked) {
      prefix = Buffer.concat([prefix, chunk.subarray(0, 16 - prefix.length)]);
      if (prefix.length >= 16) {
        const valid = contentType === 'image/jpeg' ? prefix[0] === 255 && prefix[1] === 216 && prefix[2] === 255
          : contentType === 'image/png' ? prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            : contentType === 'image/webp' ? prefix.toString('ascii', 0, 4) === 'RIFF' && prefix.toString('ascii', 8, 12) === 'WEBP'
              : /^GIF8[79]a/.test(prefix.toString('ascii', 0, 6));
        if (!valid) { callback(new Error('原图文件签名无效')); return; }
        checked = true;
      }
    }
    callback(null, chunk);
  };
  const flush = (callback) => callback(checked ? null : new Error('原图文件不完整'));
  return new Transform({ transform, flush });
}
