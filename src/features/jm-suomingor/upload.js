// 群文件 / 私聊文件上传 + 配额预检 + 到期删除。
//
// 实测结论（协议端行为，2026-09-30 在测试群验证）：
//   · upload_group_file 参数吃**本地绝对路径**，返回 { file_id }
//   · upload_file: false = 只入库（群文件列表里能看到，不发消息），true = 入库并直接发出来
//   · get_group_file_system_info 返回 { file_count, limit_count, used_space, total_space }
//   · delete_group_file 用 file_id 删除
//   · 机器人上传群文件**不需要是管理员**（普通成员有独立配额）
//
// ⚠️ 风险提示（代码里无法消除，只能靠开关与频率控制）：
//   文件一旦进群，全体群员可见可下载；事后删除也收不回别人已下载的副本。

import fs from 'node:fs';

/** 从 OneBot 返回里稳地取 file_id（不同实现字段层级不一致）。 */
function pickFileId(res) {
  return String(res?.file_id ?? res?.data?.file_id ?? '').trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const FILENAME_COMPATIBILITY_NOTE = '⚠️ 原文件名上传失败，已使用编号文件名处理，原始标题不受影响。';

function uploadErrorCodes(error) {
  const text = String(error?.message ?? error ?? '');
  return {
    retcode: error?.retcode ?? text.match(/\bretcode\s*[=:]\s*(-?\d+)/i)?.[1] ?? null,
    code: text.match(/\bcode\s*[=:]\s*(-?\d+)/i)?.[1]
      ?? (/(?:^|[^\d])-134(?:$|[^\d])/.test(text) ? '-134' : null)
      ?? error?.data?.code ?? error?.code ?? null,
  };
}

function isFilenameFormatError(error) {
  const text = String(error?.message ?? error ?? '');
  // 只接受明确的格式/长度/编码错误；-134 本身不说明原因，更不能当成审核错误。
  if (/审核|违规|敏感|moderation|blocked|banned|policy/i.test(text)) return false;
  return /(?:invalid|illegal|malformed|too long) file[ _-]?name|file[ _-]?name[^.\n]{0,32}(?:too long|invalid|illegal character|unsupported character|invalid encoding)|文件名(?:称)?[^。\n]{0,24}(?:无效|格式错误|格式不正确|过长|长度超|非法字符|无效字符|不支持的字符|编码错误|编码无效|编码不支持)/i.test(text);
}

function isTransientUploadError(error) {
  const text = String(error?.message ?? error ?? '').toLowerCase();
  const { code } = uploadErrorCodes(error);
  // 明确的业务拒绝优先于外层 rich-media / network / EventChecker 包装文字。
  if (code != null && /^-?\d+$/.test(String(code)) && Number(code) !== 0) return false;
  if (/permission denied|forbidden|quota|文件名|file[ _-]?name|审核|违规|拒绝|空间不足|数量已满/.test(text)) return false;
  return /\bnetwork\b|timeout|timed out|econnreset|econnrefused|etimedout|eai_again|socket hang up|网络连接异常|超时/.test(`${text} ${code ?? ''}`.toLowerCase());
}

/** 回查群文件列表，拿到 QQ 实际使用的 file_id（不是 upload_group_file 返回的临时 UUID）。 */
async function findGroupFile(onebot, groupId, fileNames, size) {
  try {
    const data = await onebot.call('get_group_root_files', {
      group_id: Number(groupId),
      file_count: 300,
    });
    const files = data?.files ?? data?.data?.files;
    if (!Array.isArray(files)) return { ok: false, file: null };
    for (const fileName of fileNames) {
      const item = files.findLast((item) => (
        String(item?.file_name ?? '') === fileName
        && Number(item?.file_size ?? item?.size ?? -1) === size
        && String(item?.file_id ?? '').trim()
      ));
      if (item) return { ok: true, file: { fileId: String(item.file_id).trim(), fileName, size } };
    }
    return { ok: true, file: null };
  } catch {
    // 无法核对不等于文件不存在：此时不能自动重传。
    return { ok: false, file: null };
  }
}

/**
 * 查群文件配额。
 * @returns {{ok:boolean, fileCount?:number, limitCount?:number, usedSpace?:number, totalSpace?:number, error?:string}}
 */
export async function groupQuota(onebot, groupId) {
  try {
    const data = await onebot.call('get_group_file_system_info', { group_id: Number(groupId) });
    return {
      ok: true,
      fileCount: Number(data?.file_count ?? 0),
      limitCount: Number(data?.limit_count ?? 0),
      usedSpace: Number(data?.used_space ?? 0),
      totalSpace: Number(data?.total_space ?? 0),
    };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
}

/**
 * 上传一个文件到指定会话。
 * @param {object} opts
 * @param {object} opts.onebot    钩子 ctx 里的 onebot（已认证）
 * @param {string} opts.chatKey   'group:123' / 'private:456'
 * @param {string} opts.filePath  本地绝对路径
 * @param {string} [opts.name]    群文件里显示的名字
 * @param {boolean} [opts.publish] true = 入库并直接发出来；false = 只入库
 * @param {number}  [opts.timeoutMs]
 * @param {boolean} [opts.checkQuota] 上传前是否预检群文件配额
 * @param {string} [opts.fallbackName] JM 调用方提供的编号文件名，仅明确格式错误时重试一次
 * @param {function} [opts.log] 仅记录白名单诊断字段，不写鉴权信息或原始响应
 * @returns {Promise<{ok:boolean, fileId?:string, scope?:string, error?:string, quota?:object}>}
 */
export async function uploadFile({ onebot, chatKey, filePath, name, publish = true, timeoutMs = 600000, checkQuota = true, fallbackName, log }) {
  if (!onebot?.call) return { ok: false, error: '没有可用的 onebot 客户端（不在钩子/工具上下文里）' };
  if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: `文件不存在：${filePath}` };

  const [kind, id] = String(chatKey || '').split(':');
  if (!kind || !id) return { ok: false, error: `非法会话 key：${chatKey}` };

  let size = 0;
  try {
    size = fs.statSync(filePath).size;
  } catch (error) {
    return { ok: false, error: `读不到文件大小：${error?.message ?? error}` };
  }
  if (size <= 0) return { ok: false, error: '文件大小为 0' };

  // 群文件显示名不按 UTF-16 截断，避免丢扩展名或截出孤立代理字符；不重命名本地文件。
  const originalName = String(name || filePath.split(/[\\/]/).pop() || 'file');
  const fileName = kind === 'group' ? originalName : originalName.slice(0, 120);
  let quota = null;

  if (kind === 'group') {
    const startedAt = Date.now();
    const alternate = /^JM\d+(?:\.part\d+of\d+)?\.pdf$/.test(String(fallbackName)) && fallbackName !== fileName ? fallbackName : '';
    // 同时识别旧版截断显示名，避免升级后缓存重发再生成一份群文件。
    const fileNames = [...new Set([fileName, ...(alternate ? [alternate] : []), fileName.slice(0, 120)])];
    let currentName = fileName;
    let attempts = 0;
    let retries = 0;
    let filenameRetries = 0;
    let lastError = null;
    const emit = (event, fields = {}) => {
      // 不记录路径、作品标题、原始异常和 OneBot 参数，防止凭据随异常串进入诊断日志。
      try { log?.(`[jm-upload] ${JSON.stringify({ event, attempts, retries, filenameRetries, usedFallbackName: currentName === alternate, elapsedMs: Date.now() - startedAt, ...fields })}`); } catch { /* 日志失败不影响交付 */ }
    };
    const finish = (result) => {
      const usedFallbackName = currentName === alternate;
      const output = { ...result, attempts, retries, filenameRetries, usedFallbackName, fileName: currentName, elapsedMs: Date.now() - startedAt,
        compatibilityNote: result.ok && usedFallbackName ? FILENAME_COMPATIBILITY_NOTE : '' };
      emit('result', { ok: result.ok, verified: Boolean(result.verified), reused: Boolean(result.reused) });
      return output;
    };
    const listedSuccess = (file, note, reused = false) => {
      currentName = file.fileName;
      return finish({ ok: true, fileId: file.fileId, scope: 'group', quota, size, verified: true, note, reused });
    };
    // 只诊断长度，不猜测 QQ 的字节上限；普通长中文名可以正常上传。
    emit('filename', { codeUnits: fileName.length, utf8Bytes: Buffer.byteLength(fileName, 'utf8'),
      wellFormed: fileName.isWellFormed(), hasControlOrSeparator: /[\x00-\x1f\x7f/\\]/.test(fileName) });
    const before = await findGroupFile(onebot, id, fileNames, size);
    if (before.file) return listedSuccess(before.file, '文件已在群文件中，已复用，未重复上传', true);
    if (checkQuota) {
      quota = await groupQuota(onebot, id);
      if (quota.ok) {
        if (quota.limitCount > 0 && quota.fileCount >= quota.limitCount) {
          return finish({ ok: false, quota, error: `本群群文件数量已满（${quota.fileCount}/${quota.limitCount}），请先清理旧文件` });
        }
        if (quota.totalSpace > 0 && quota.usedSpace + size > quota.totalSpace) {
          const need = Math.ceil((quota.usedSpace + size - quota.totalSpace) / 1024 / 1024);
          return finish({ ok: false, quota, error: `本群群文件空间不足，还差约 ${need} MB，请先清理旧文件` });
        }
      }
      // 配额查询失败不阻断上传（有的协议端不实现该接口），继续走
    }
    const maxAttempts = 3; // 原名称首次 + 最多两次临时异常重试；兼容重试单独计数，最多一次。
    let attemptKind = 'initial';
    while (true) {
      attempts += 1;
      emit('attempt', { attemptKind });
      const attemptStartedAt = Date.now();
      try {
        const res = await onebot.call('upload_group_file', {
          group_id: Number(id),
          file: filePath,
          name: currentName,
          folder: '',
          upload_file: publish !== false,
        }, timeoutMs);
        const returnedId = pickFileId(res);
        // NapCat 有时返回临时 UUID，群文件列表里的真实 ID 另有格式；优先回查真实 ID。
        const listed = await findGroupFile(onebot, id, fileNames, size);
        if (listed.file) return listedSuccess(listed.file, '');
        if (!returnedId) {
          lastError = new Error('协议端返回里没有 file_id（上传可能未完成），请核对群文件后再重发');
          emit('attempt_failed', { durationMs: Date.now() - attemptStartedAt, code: null, retcode: null });
          break;
        }
        return finish({
          ok: true,
          fileId: returnedId,
          scope: 'group',
          quota,
          size,
          verified: false,
          note: '协议端已返回成功，群文件列表暂未回查到',
        });
      } catch (error) {
        lastError = error;
        const codes = uploadErrorCodes(error);
        // 仅允许数字业务码 / 标准网络错误名进入日志。
        const safeCode = (value) => /^-?\d+$|^(?:E[A-Z_]+|UND_ERR_[A-Z_]+)$/.test(String(value)) ? value : null;
        emit('attempt_failed', { durationMs: Date.now() - attemptStartedAt, retcode: safeCode(codes.retcode), code: safeCode(codes.code) });
        // QQ NT 的 rich-media 错误可能发生在上传完成后的事件确认阶段，先核对再重试，避免重复上传。
        const listed = await findGroupFile(onebot, id, fileNames, size);
        if (listed.file) return listedSuccess(listed.file, 'QQ 返回发送确认失败，但文件已在群文件中');
        if (!listed.ok) break;
        if (alternate && !filenameRetries && isFilenameFormatError(error)) {
          attemptKind = 'filename_fallback';
        } else {
          // 备用名只调用一次，其失败后也不再自动重复改名/重传。
          if (filenameRetries || !isTransientUploadError(error) || retries >= maxAttempts - 1) break;
          attemptKind = 'automatic_retry';
          await sleep(2000 * (retries + 1));
        }
        // 重试前再查一次，覆盖 QQ 群文件列表延迟可见的情况。
        const recheck = await findGroupFile(onebot, id, fileNames, size);
        if (recheck.file) return listedSuccess(recheck.file, '文件已在群文件中，已停止重试');
        if (!recheck.ok) break;
        if (attemptKind === 'filename_fallback') {
          currentName = alternate;
          filenameRetries += 1;
        } else retries += 1;
      }
    }
    return finish({
      ok: false,
      quota,
      error: `上传群文件失败（已尝试 ${attempts} 次，${retries ? `自动重试 ${retries} 次` : '未自动重试'}${filenameRetries ? '，备用文件名重试 1 次' : ''}）：${lastError?.message ?? lastError}`,
    });
  }

  // 私聊文件：协议端实现差异最大的一条路，失败要给出可操作的建议
  try {
    const res = await onebot.call('upload_private_file', {
      user_id: Number(id),
      file: filePath,
      name: fileName,
      upload_file: true,
    }, timeoutMs);
    const fileId = pickFileId(res);
    if (!fileId) return { ok: false, error: '协议端返回里没有 file_id（私聊文件上传可能未完成）' };
    return { ok: true, fileId, scope: 'private', size };
  } catch (error) {
    return {
      ok: false,
      error: `私聊文件发送失败：${error?.message ?? error}。`
        + '部分协议端不支持私聊文件，可以改成让群友在群里发起，或改用「上传到群文件」。',
    };
  }
}

/** 删除群文件（用于到期清理）。 */
export async function deleteGroupFile(onebot, groupId, fileId) {
  try {
    await onebot.call('delete_group_file', { group_id: Number(groupId), file_id: String(fileId) });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
}

/**
 * 把文件切成若干块（超过单文件上限时用）。
 * 只在 PDF 之后需要"分卷"时调用；按字节均分，落在最近的页边界上由调用方保证。
 * 这里做的是通用字节切分（不解析格式），所以分了卷的 PDF 每卷都能单独打开。
 */
export function splitFileBySize(filePath, maxBytes) {
  const size = fs.statSync(filePath).size;
  if (size <= maxBytes) return [filePath];
  const parts = Math.ceil(size / maxBytes);
  const chunk = Math.ceil(size / parts);
  const ext = (filePath.match(/\.[a-zA-Z0-9]{1,6}$/) || [''])[0];
  const stem = ext ? filePath.slice(0, -ext.length) : filePath;
  const out = [];
  const fd = fs.openSync(filePath, 'r');
  try {
    for (let i = 0; i < parts; i++) {
      const start = i * chunk;
      const len = Math.min(chunk, size - start);
      if (len <= 0) break;
      const target = `${stem}.part${i + 1}of${parts}${ext}`;
      const buf = Buffer.allocUnsafe(len);
      fs.readSync(fd, buf, 0, len, start);
      fs.writeFileSync(target, buf);
      out.push(target);
    }
  } finally {
    fs.closeSync(fd);
  }
  return out;
}

export function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
