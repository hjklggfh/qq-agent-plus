import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

function authHeaders(token) {
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json'
  };
}

async function readErrorText(response) {
  try {
    const text = await response.text();
    try {
      const parsed = JSON.parse(text);
      if (parsed?.error) return String(parsed.error);
    } catch { /* fallback to raw text */ }
    return text.slice(0, 200);
  } catch {
    return `HTTP ${response.status}`;
  }
}

export async function checkNovelRelayHealth(settings, options = {}) {
  const fetchFn = options.fetchImpl || fetch;
  const relayUrl = String(settings?.relayUrl || '').replace(/\/+$/, '');
  const relayToken = String(settings?.relayToken || '').trim();
  if (!relayUrl || !relayToken) {
    return { ok: false, error: '尚未配置小说中转地址或令牌' };
  }
  const signal = options.signal || AbortSignal.timeout(10000);
  const res = await fetchFn(`${relayUrl}/healthz`, {
    method: 'GET',
    headers: { authorization: `Bearer ${relayToken}` },
    signal
  });
  if (!res.ok) {
    return { ok: false, status: res.status, error: await readErrorText(res) };
  }
  return res.json();
}

export async function searchNovelsViaRelay(params, settings, options = {}) {
  const fetchFn = options.fetchImpl || fetch;
  const relayUrl = String(settings?.relayUrl || '').replace(/\/+$/, '');
  const relayToken = String(settings?.relayToken || '').trim();
  if (!relayUrl || !relayToken) {
    throw new Error('小说中转未配置，请在控制台“功能 → 小说检索”填写中转地址与令牌。');
  }
  const timeoutMs = Math.max(10000, Number(settings?.timeoutSeconds || 60) * 1000);
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);

  const res = await fetchFn(`${relayUrl}/v1/search`, {
    method: 'POST',
    headers: authHeaders(relayToken),
    body: JSON.stringify({
      mode: params.mode || 'search',
      query: params.query || '',
      sources: params.sources || [],
      channels: params.channels || [],
      limit: params.limit || 64,
      page: params.page || 1,
      tgOffsets: params.tgOffsets || {},
      summaryMode: params.summaryMode || settings?.summaryMode || 'clean',
      maxFileBytes: Math.round(Number(settings?.maxFileSizeMb || 30) * 1024 * 1024),
      pixivCookie: params.pixivCookie || '',
      pixivMinChars: Number.isInteger(settings?.pixivMinChars) ? settings.pixivMinChars : 1500
    }),
    signal
  });
  if (!res.ok) {
    throw new Error(await readErrorText(res));
  }
  return res.json();
}

export async function downloadNovelViaRelay(params, settings, destPath, options = {}) {
  const fetchFn = options.fetchImpl || fetch;
  const relayUrl = String(settings?.relayUrl || '').replace(/\/+$/, '');
  const relayToken = String(settings?.relayToken || '').trim();
  if (!relayUrl || !relayToken) {
    throw new Error('小说中转未配置');
  }
  const maxFileBytes = Math.round(Number(settings?.maxFileSizeMb || 30) * 1024 * 1024);
  const timeoutMs = Math.max(30000, Number(settings?.timeoutSeconds || 60) * 2000);
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);

  const res = await fetchFn(`${relayUrl}/v1/download`, {
    method: 'POST',
    headers: authHeaders(relayToken),
    body: JSON.stringify({
      source: params.source || '',
      channel: params.channel || '',
      id: String(params.id || params.msgId || ''),
      msgId: params.msgId || 0,
      normalizeTxt: settings?.normalizeTxt !== false,
      maxFileBytes,
      pixivCookie: params.pixivCookie || '',
      esjMaxChapters: Number.isInteger(settings?.esjMaxChapters) ? settings.esjMaxChapters : 80
    }),
    signal
  });
  if (!res.ok) {
    throw new Error(await readErrorText(res));
  }

  const contentLength = Number(res.headers.get('content-length') || 0);
  if (contentLength > maxFileBytes) {
    throw new Error(`文件超出单文件上限（${settings?.maxFileSizeMb || 30} MB）`);
  }

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const tmpPath = `${destPath}.part`;
  let written = 0;
  try {
    if (res.body && typeof res.body.getReader === 'function') {
      const guard = new Transform({
        transform(chunk, _enc, cb) {
          written += chunk.length;
          if (written > maxFileBytes) {
            cb(new Error(`文件超出单文件上限（${settings?.maxFileSizeMb || 30} MB）`));
            return;
          }
          cb(null, chunk);
        }
      });
      await pipeline(Readable.fromWeb(res.body), guard, fs.createWriteStream(tmpPath, { mode: 0o600 }));
    } else {
      const buf = Buffer.from(await res.arrayBuffer());
      written = buf.length;
      if (written > maxFileBytes) {
        throw new Error(`文件超出单文件上限（${settings?.maxFileSizeMb || 30} MB）`);
      }
      fs.writeFileSync(tmpPath, buf, { mode: 0o600 });
    }
    fs.renameSync(tmpPath, destPath);
  } catch (error) {
    fs.rmSync(tmpPath, { force: true });
    throw error;
  }

  const rawHeaderName = res.headers.get('x-novel-filename') || '';
  let fileName = '';
  try {
    fileName = rawHeaderName ? decodeURIComponent(rawHeaderName) : '';
  } catch {
    fileName = rawHeaderName;
  }
  return {
    filePath: destPath,
    fileName: fileName || params.fallbackFileName || `novel-${params.id || params.msgId}.txt`,
    size: written,
    encoding: res.headers.get('x-novel-encoding') || 'binary',
    cacheHit: res.headers.get('x-novel-cache') === 'hit'
  };
}
