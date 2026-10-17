import { MAX_IMAGE_BYTES, boundedBody, formatSearchReply, publicLink } from './common.js';
import { imageType } from '../../core/image-type.js';

// 图片只在内存中组装；历史与 outbox 元数据均不保存图片或 base64。
export async function searchResultNodes(reports, settings, options) {
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(35000)]);
  const node = (content) => ({ type: 'node', data: {
    uin: String(options.selfId || ''), name: String(options.name || '机器人').slice(0, 40), content
  } });
  const text = (value) => ({ type: 'text', data: { text: value } });
  const failures = reports.filter((r) => r.status !== 'ok');
  const nodes = [node([text(`${formatSearchReply(failures, settings.limit)}\n最多附3张匹配图片；匹配图原文件不保证是作者发布的最高分辨率版本。`)])];
  let attempts = 0, remaining = MAX_IMAGE_BYTES;
  for (const report of reports) {
    if (report.status !== 'ok') continue;
    for (const row of report.results.slice(0, settings.limit)) {
      if (!publicLink(row.url)) continue;
      const content = [text(formatSearchReply([{ ...report, results: [row] }], 1))];
      let attached = false;
      if (attempts < 3 && remaining > 0 && !signal.aborted) {
        attempts++;
        for (const field of ['image', 'thumbnail']) {
          const key = row[`${field}Key`];
          if (typeof key !== 'string' || !/^[\da-f-]{36}$/i.test(key)) continue;
          try {
            const response = await options.fetch(`${settings.relayUrl.replace(/\/$/, '')}/v1/image`, {
              method: 'POST', redirect: 'error', signal,
              headers: { authorization: `Bearer ${settings.relayToken}`, 'content-type': 'application/json', 'x-image-max-bytes': String(remaining) },
              body: JSON.stringify({ key })
            });
            if (!response.ok) throw new Error('图片不可用');
            const buffer = await boundedBody(response, remaining, signal);
            if (!imageType(buffer)) throw new Error('非图片响应');
            remaining -= buffer.length;
            content.push(text(field === 'thumbnail' ? '\n匹配图片缩略图：' : report.platform === 'trace' ? '\n动画匹配帧（预览）：' : '\n匹配图原文件：'));
            content.push({ type: 'image', data: { file: `base64://${buffer.toString('base64')}` } });
            attached = true;
            break;
          } catch { options.signal.throwIfAborted(); /* 原文件失败时尝试缩略图；保留来源链接。 */ }
        }
      }
      if (!attached) content.push(text('\n未附图：图片不可用、下载超时或达到本次附图上限，请打开来源链接查看。'));
      nodes.push(node(content));
    }
  }
  return nodes;
}
