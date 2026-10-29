import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import test from 'node:test';

// 跑真实的入队→缓存→上传→简介→清理链路；只替换 PDF worker 和卡片渲染，隔离网络及生产数据。
const legacyUrl = new URL('../src/features/jm-suomingor/legacy-index.js', import.meta.url).href;
const dailyStub = `
  import fs from 'node:fs';
  export const collect = () => {}, buildDigestFromState = () => {}, sendDigest = () => {},
    loadDigestItems = () => [], renderDigestImage = () => {}, sendDigestImage = () => {};
  export const cleanTitle = x => x, fetchSiteCover = async () => '';
  export const renderAlbumImage = async ({ outPath }) => {
    fs.writeFileSync(outPath, 'rendered-image');
    return outPath;
  };
`;
const pdfStub = 'export const detect = () => ({ ok: true, python: "unused" }); export const runTask = () => { throw new Error("缓存重发不应生成 PDF"); };';
const hook = registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL === legacyUrl) {
    const stub = specifier === './daily_updates.mjs' ? dailyStub : specifier === './pdf.js' ? pdfStub : null;
    if (stub) return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true };
  }
  return nextResolve(specifier, context);
} });
const jm = await import(legacyUrl);
hook.deregister();

async function waitFor(check) {
  for (let i = 0; i < 200; i++) {
    const value = check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('JM 后台任务未在期限内完成');
}

test('缓存 PDF 的实际调用链保留标题、元数据、原图并正确显示兼容提示', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-upload-job-'));
  t.after(() => { jm.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const tools = new Map();
  const messages = [];
  const logs = [];
  let config = { enabled: true, downloadDir: root, translateTitles: false,
    uploadMode: 'request', checkQuota: false, deleteImagesAfterPdf: false, maxUploadMB: 200 };
  jm.setup({ config: () => config, registerTool: tool => tools.set(tool.id, tool),
    log: line => logs.push(line), warn: line => logs.push(line) });
  let albumId = 1485785;

  async function run({ mode, card = false, cleanup = false, oversize = false, failSecondPart = false }) {
    albumId++;
    config = { ...config, deleteImagesAfterPdf: cleanup, maxUploadMB: oversize ? 1 : 200 };
    const id = String(albumId);
    const albumDir = path.join(root, `jm-${id}`, '原始作品目录');
    fs.mkdirSync(albumDir, { recursive: true });
    const pdfName = `JM${id}-完整原始作品标题.pdf`;
    const filePath = path.join(albumDir, pdfName);
    const content = Buffer.alloc(oversize ? 1024 * 1024 + 128 : 2048, 65);
    fs.writeFileSync(filePath, content);
    const imagePath = path.join(albumDir, '001.jpg');
    fs.writeFileSync(imagePath, 'original-image');
    const metadata = JSON.stringify({ id, name: '完整原始作品标题', nameOriginal: 'Original Title',
      description: '作品原始简介', authors: ['作者'], tags: ['标签'], chapters: 1,
      pages: 2, pagesOk: 2, downloadedAt: '2026-10-01T00:00:00Z', customField: '保留未知字段',
      deletedImages: false, pdf: { restored: 2 } }, null, 2);
    const metaPath = path.join(albumDir, 'metadata.json');
    fs.writeFileSync(metaPath, metadata);
    const uploaded = [];
    const files = [];
    let lookups = 0;
    const beforeMessages = messages.length;
    const onebot = {
      async call(action, params) {
        if (action === 'get_group_root_files') { lookups++; return { files }; }
        assert.equal(action, 'upload_group_file');
        uploaded.push({ ...params });
        if (failSecondPart && params.name.includes('.part2of')) throw new Error('code=-134');
        if (mode === 'reject') throw new Error('retcode=100 code=-134 文件上传失败');
        if (mode === 'compat' && !/^JM\d+(?:\.part\d+of\d+)?\.pdf$/.test(params.name)) throw new Error('retcode=100 code=-134 文件上传失败');
        files.push({ file_id: `real-${files.length}`, file_name: params.name, file_size: fs.statSync(params.file).size });
        return { file_id: 'temporary-id' };
      },
      async sendSegments(_kind, _id, segments) {
        const cardPath = segments.find(segment => segment.type === 'image')?.data?.file?.replace(/^file:\/\//, '');
        assert.equal(path.dirname(cardPath), root, '简介图片必须生成在已挂载的数据根目录');
        assert.equal(path.basename(cardPath), 'album-card-group_100001.jpg');
        assert.equal(fs.readFileSync(cardPath, 'utf8'), 'rendered-image');
        if (!card) throw new Error('模拟卡片发送失败，检查文字简介');
      }
    };
    const sender = { async sendTextBatch(_chatKey, text) { messages.push(...text); } };
    const ctx = { chatKey: 'group:100001', kind: 'group', onebot, sender };
    await tools.get('download_album').execute(ctx, { album_id: id });
    await waitFor(() => messages.slice(beforeMessages).some(text => text.includes('处理好啦') || text.includes('处理完成，但文件上传失败')));
    await waitFor(() => {
      try { return JSON.parse(fs.readFileSync(path.join(root, 'tasks.json'), 'utf8')).find(row => row.id === id); }
      catch { return null; }
    });
    const summary = messages.at(-1);
    assert.deepEqual(fs.readFileSync(filePath), content, '原始 PDF 内容和文件名不变');
    assert.equal(fs.existsSync(imagePath), !cleanup || mode === 'reject' || failSecondPart, '失败时不删除原图');
    if (!cleanup || mode === 'reject' || failSecondPart) assert.equal(fs.readFileSync(metaPath, 'utf8'), metadata, '重发不重写原元数据');
    assert.ok(summary.includes(card ? '简介见上图' : '完整原始作品标题'));
    return { id, ctx, filePath, metaPath, imagePath, uploaded, files, summary, beforeMessages, lookups };
  }

  for (const card of [false, true]) {
    const success = await run({ mode: 'compat', card });
    assert.equal(success.uploaded.length, 2);
    assert.match(success.summary, /⚠️ 原文件名上传失败，已使用编号文件名处理，原始标题不受影响。/);
    assert.ok(success.summary.includes(`📎 已上传到本群群文件：JM${success.id}.pdf`));
    assert.ok(success.lookups >= 4);
    const start = messages.length;
    await tools.get('download_album').execute(success.ctx, { album_id: success.id });
    await waitFor(() => messages.length >= start + 2);
    await waitFor(() => {
      try { return JSON.parse(fs.readFileSync(path.join(root, 'tasks.json'), 'utf8')).filter(row => row.id === success.id).length === 2; }
      catch { return false; }
    });
    assert.equal(success.uploaded.length, 2, '再次缓存重发复用编号群文件，不重复上传');
    assert.equal(success.files.length, 1);
    assert.match(messages.at(-1), /原文件名上传失败/);
  }

  const rejected = await run({ mode: 'reject', cleanup: true });
  assert.equal(rejected.uploaded.length, 2);
  assert.match(rejected.summary, /已尝试 2 次，未自动重试，备用文件名重试 1 次/);
  assert.doesNotMatch(rejected.summary, /已使用编号文件名|✅/);

  const normal = await run({ mode: 'normal', cleanup: true });
  assert.equal(normal.uploaded.length, 1);
  assert.doesNotMatch(normal.summary, /原文件名上传失败/);
  const cleanedMeta = JSON.parse(fs.readFileSync(normal.metaPath, 'utf8'));
  assert.equal(cleanedMeta.nameOriginal, 'Original Title');
  assert.equal(cleanedMeta.deletedImages, true, '成功后原有清理策略继续生效');

  const parts = await run({ mode: 'compat', oversize: true });
  assert.equal(parts.files.length, 2);
  assert.deepEqual(parts.files.map(file => file.file_name), [`JM${parts.id}.part1of2.pdf`, `JM${parts.id}.part2of2.pdf`]);
  assert.equal(parts.summary.split('原文件名上传失败').length - 1, 1, '分卷只追加一次提示');

  const partial = await run({ mode: 'compat', oversize: true, failSecondPart: true, cleanup: true });
  assert.match(partial.summary, /第 2 卷上传失败/);
  assert.equal(partial.files.length, 1);
  assert.equal(fs.existsSync(partial.imagePath), true, '部分分卷失败也不清理原图');
  assert.ok(logs.some(line => line.includes('"attemptKind":"filename_fallback"')));
});
