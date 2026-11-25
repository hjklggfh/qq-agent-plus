import fsp from 'node:fs/promises';
import path from 'node:path';

export class JmOversizeError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'JmOversizeError';
    this.code = 'JM_OVERSIZE';
    this.stage = options.stage || 'preflight';
  }
}

/**
 * 原图总字节实时熔断阈值：
 * 仅在开启「超限拒绝」且需要上传时启用，设为单文件上限的 1.5 倍（PDF 重编码后一般为原图 0.7~1.3 倍）。
 */
export function rawDownloadByteLimit(c = {}) {
  if (c.rejectOversize !== true) return 0;
  if (c.uploadMode === 'off') return 0;
  const maxUploadMB = Number(c.maxUploadMB || 0);
  if (!Number.isFinite(maxUploadMB) || maxUploadMB <= 0) return 0;
  return Math.round(maxUploadMB * 1024 * 1024 * 1.5);
}

export function formatPageLimitMessage({
  albumId,
  title,
  chaptersCount,
  scannedChapters,
  plannedPages,
  maxPages,
}) {
  const label = title ? `JM${albumId}《${title}》` : `JM${albumId}`;
  if (chaptersCount > 1) {
    const scope = scannedChapters < chaptersCount
      ? `共 ${chaptersCount} 话，仅前 ${scannedChapters} 话已达 ${plannedPages} 页`
      : `共 ${chaptersCount} 话、合计 ${plannedPages} 页`;
    return `${label}${scope}，超过整本上限 ${maxPages} 页，体积过大已拒绝下载。`;
  }
  return `${label}共 ${plannedPages} 页，超过上限 ${maxPages} 页，已拒绝下载。`;
}

/**
 * 安全删除超限被拒的整本目录（jm-<id>），严格限制在 rootDir 之内防越界误删。
 */
export async function removeRejectedAlbumDir(targetDir, rootDir) {
  if (!targetDir || !rootDir) return false;
  const rootResolved = path.resolve(rootDir);
  const targetResolved = path.resolve(targetDir);
  const rel = path.relative(rootResolved, targetResolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  try {
    await fsp.rm(targetResolved, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
