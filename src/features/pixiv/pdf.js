import fs from 'node:fs';
import path from 'node:path';
import { detect, runTask } from '../jm-suomingor/pdf.js';

// 与 JM 共用单进程串行队列、逐页写入器；Pixiv 图片不进行 JM 还原。
export async function buildPixivPdf(options) {
  const { files, output, signal, maxBytes, pythonPath } = options;
  signal.throwIfAborted();
  const runtime = detect(pythonPath || '');
  if (!runtime.ok) throw new Error(`PDF 环境不可用：${runtime.error}。需要 Python 3 和 Pillow，可先改用图片发送。`);
  signal.throwIfAborted();
  const control = { deleted: false, child: null };
  let cancelWaiting;
  const cancelledWhileWaiting = new Promise((resolve) => { cancelWaiting = resolve; });
  const cancel = () => {
    control.deleted = true;
    if (control.child) control.child.kill('SIGKILL');
    else cancelWaiting.call(null, { ok: false, error: '任务已取消' });
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const result = await Promise.race([runTask({ python: runtime.python, timeoutMs: 600000,
      task: { output, descramble: false, quality: 95, max_dim: 0, max_output_bytes: maxBytes,
        chapters: [{ name: 'Pixiv', pages: files.map((p) => p.file) }], control } }), cancelledWhileWaiting]);
    signal.throwIfAborted();
    // 不发送静默丢页的 PDF，避免生成结果与外部标注的页码不一致。
    if (!result.ok || result.pagesOk !== files.length || result.failed?.length) {
      const error = new Error(`PDF 生成失败或存在无法解码的图片，未上传：${result.error || `${result.failed?.length || 0} 页处理失败`}`);
      error.invalidImages = Boolean(result.failed?.length);
      throw error;
    }
    const bytes = fs.statSync(output).size;
    if (bytes > maxBytes) throw new Error('PDF 超过文件大小上限，请缩小页码范围后重试');
    return { file: output, bytes, pages: files.map((p) => p.page) };
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

// 崩溃或发送未确认的临时文件保留一天；只清理功能自有目录。
export function sweepPdfJobs(root) {
  fs.mkdirSync(root, { recursive: true });
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('job-')) continue;
    const dir = path.join(root, entry.name);
    if (Date.now() - fs.statSync(dir).mtimeMs > 86400000) fs.rmSync(dir, { recursive: true, force: true });
  }
}
