import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { uploadFile, FILENAME_COMPATIBILITY_NOTE } from '../src/features/jm-suomingor/upload.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-upload-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'test.pdf');
  fs.writeFileSync(filePath, '%PDF-test');
  return { filePath, size: fs.statSync(filePath).size };
}

test('未启用失败换名策略时，-134 业务拒绝只尝试一次并保留本地文件', async (t) => {
  const { filePath } = fixture(t);
  let uploads = 0;
  let lookups = 0;
  const result = await uploadFile({
    chatKey: 'group:100001', filePath, checkQuota: false, fallbackName: 'JM1485785.pdf',
    onebot: { async call(action) {
      if (action === 'get_group_root_files') { lookups++; return { files: [] }; }
      assert.equal(action, 'upload_group_file');
      uploads++;
      throw new Error('OneBot upload_group_file 失败: retcode=100 rich media transfer failed EventChecker failed: code=-134 msg=文件上传失败（-134）');
    } }
  });
  assert.equal(result.ok, false);
  assert.equal(uploads, 1);
  assert.equal(lookups, 2);
  assert.equal(result.attempts, 1);
  assert.equal(result.retries, 0);
  assert.match(result.error, /已尝试 1 次，未自动重试/);
  assert.match(result.error, /code=-134/);
  assert.equal(result.filenameRetries, 0);
  assert.equal(result.compatibilityNote, '');
  assert.doesNotMatch(result.error, /审核/);
  assert.equal(fs.existsSync(filePath), true);
});

test('异常后群文件已存在时返回成功，不重复上传', async (t) => {
  const { filePath, size } = fixture(t);
  let uploads = 0;
  const result = await uploadFile({
    chatKey: 'group:100001', filePath, checkQuota: false,
    onebot: { async call(action) {
      if (action === 'get_group_root_files') return { files: uploads ? [{
        file_id: 'existing', file_name: 'test.pdf', file_size: size
      }] : [] };
      uploads++;
      throw new Error('network timeout');
    } }
  });
  assert.equal(result.ok, true);
  assert.equal(result.verified, true);
  assert.equal(result.fileId, 'existing');
  assert.equal(uploads, 1);
});

test('群文件配额不足时不发起上传', async (t) => {
  const { filePath, size } = fixture(t);
  const actions = [];
  const result = await uploadFile({
    chatKey: 'group:100001', filePath,
    onebot: { async call(action) {
      actions.push(action);
      return { file_count: 1, limit_count: 1500, used_space: 99, total_space: 99 + size - 1 };
    } }
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /群文件空间不足/);
  assert.deepEqual(actions, ['get_group_root_files', 'get_group_file_system_info']);
});

test('实际发生一次自动重试时按两次尝试报告', async (t) => {
  const { filePath } = fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let uploads = 0;
  const pending = uploadFile({
    chatKey: 'group:100001', filePath, checkQuota: false,
    onebot: { async call(action) {
      if (action === 'get_group_root_files') return { files: [] };
      uploads++;
      throw new Error(uploads === 1 ? 'network error' : 'group file upload failed: code=-134');
    } }
  });
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(2000);
  const result = await pending;
  assert.equal(uploads, 2);
  assert.equal(result.attempts, 2);
  assert.equal(result.retries, 1);
  assert.match(result.error, /已尝试 2 次，自动重试 1 次/);
});

// 只在 upload_group_file 真正入库时更新列表，模拟 OneBot 的返回/确认分离。
function backend(size, onUpload) {
  const state = { files: [], uploads: [], lookups: 0 };
  state.onebot = { async call(action, params, timeoutMs) {
    if (action === 'get_group_root_files') {
      state.lookups++;
      return { data: { files: state.files } };
    }
    assert.equal(action, 'upload_group_file');
    state.uploads.push({ ...params, timeoutMs });
    const accept = () => {
      const file = { file_id: `real-${state.files.length + 1}`, file_name: params.name, file_size: size };
      state.files.push(file);
      return { data: { file_id: 'temporary-uuid' } };
    };
    return onUpload ? onUpload(params, state, accept) : accept();
  } };
  return state;
}

for (const name of ['正常.pdf', `${'汉'.repeat(58)}.pdf`, `${'a'.repeat(119)}😀作品.pdf`]) {
  test(`正常上传保留完整显示名（${Buffer.byteLength(name)} 字节），不显示兼容提示`, async (t) => {
    const { filePath, size } = fixture(t);
    const original = fs.readFileSync(filePath);
    const server = backend(size);
    const result = await uploadFile({ onebot: server.onebot, chatKey: 'group:100001',
      filePath, name, fallbackName: 'JM1485785.pdf', checkQuota: false, publish: false, timeoutMs: 12345 });
    assert.equal(result.ok, true);
    assert.equal(result.fileId, 'real-1');
    assert.equal(result.attempts, 1);
    assert.equal(result.retries, 0);
    assert.equal(result.filenameRetries, 0);
    assert.equal(result.fileName, name);
    assert.equal(result.compatibilityNote, '');
    assert.equal(result.usedFallbackName, false);
    assert.equal(server.lookups, 2);
    assert.deepEqual(server.uploads, [{ group_id: 100001, file: filePath, name, folder: '', upload_file: false, timeoutMs: 12345 }]);
    assert.deepEqual(fs.readFileSync(filePath), original);
  });
}

for (const reason of ['invalid filename', 'file name too long', '文件名包含非法字符', '文件名编码错误']) {
  test(`明确文件名错误只用编号名重试一次：${reason}`, async (t) => {
    const { filePath, size } = fixture(t);
    const server = backend(size, (_params, state, accept) => {
      if (state.uploads.length === 1) throw new Error(`retcode=100 code=-134 ${reason}`);
      return accept();
    });
    const original = fs.readFileSync(filePath);
    const logs = [];
    const result = await uploadFile({ onebot: server.onebot, chatKey: 'group:100001', filePath,
      name: '完整原始作品标题.pdf', fallbackName: 'JM1485785.pdf', checkQuota: false, log: (line) => logs.push(line) });
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 2);
    assert.equal(result.retries, 0);
    assert.equal(result.filenameRetries, 1);
    assert.equal(result.usedFallbackName, true);
    assert.equal(result.compatibilityNote, FILENAME_COMPATIBILITY_NOTE);
    assert.equal(server.files.length, 1);
    assert.deepEqual(server.uploads.map(x => x.name), ['完整原始作品标题.pdf', 'JM1485785.pdf']);
    assert.deepEqual(server.uploads.map(x => x.file), [filePath, filePath]);
    assert.deepEqual(fs.readFileSync(filePath), original);
    assert.match(logs.join('\n'), /filename_fallback/);
    assert.match(logs.join('\n'), /"code":"-134"/);
    assert.match(logs.join('\n'), /"elapsedMs":\d+/);
    assert.match(logs.at(-1), /"ok":true/);
  });
}

test('备用名失败后停止，即便它是网络超时也不继续重复上传', async (t) => {
  const { filePath, size } = fixture(t);
  const server = backend(size, (_params, state) => {
    throw new Error(state.uploads.length === 1 ? 'invalid filename' : 'network timeout');
  });
  const result = await uploadFile({ onebot: server.onebot, chatKey: 'group:100001', filePath,
    fallbackName: 'JM1485785.pdf', checkQuota: false });
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 2);
  assert.equal(result.retries, 0);
  assert.equal(result.filenameRetries, 1);
  assert.equal(result.compatibilityNote, '');
  assert.match(result.error, /已尝试 2 次，未自动重试，备用文件名重试 1 次/);
  assert.match(result.error, /network timeout/);
});

test('备用名已入库但确认失败，回查成功后显示兼容提示', async (t) => {
  const { filePath, size } = fixture(t);
  const server = backend(size, (_params, state, accept) => {
    if (state.uploads.length === 1) throw new Error('文件名过长');
    accept();
    throw new Error('EventChecker failed: timeout');
  });
  const result = await uploadFile({ onebot: server.onebot, chatKey: 'group:100001', filePath,
    fallbackName: 'JM1485785.pdf', checkQuota: false });
  assert.equal(result.ok, true);
  assert.equal(result.verified, true);
  assert.equal(result.attempts, 2);
  assert.equal(result.compatibilityNote, FILENAME_COMPATIBILITY_NOTE);
  assert.equal(server.files.length, 1);
});

for (const name of ['test.pdf', 'JM1485785.pdf']) {
  test(`缓存重发直接复用已入库的 ${name}，不重复调用上传`, async (t) => {
    const { filePath, size } = fixture(t);
    const server = backend(size);
    server.files.push({ file_id: 'cached-id', file_name: name, file_size: size });
    const result = await uploadFile({ onebot: server.onebot, chatKey: 'group:100001', filePath,
      fallbackName: 'JM1485785.pdf' });
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 0);
    assert.equal(result.reused, true);
    assert.equal(result.fileId, 'cached-id');
    assert.equal(result.fileName, name);
    assert.equal(result.compatibilityNote, name === 'test.pdf' ? '' : FILENAME_COMPATIBILITY_NOTE);
    assert.equal(server.uploads.length, 0);
  });
}

test('同名但大小不同的群文件不能当作已成功上传', async (t) => {
  const { filePath, size } = fixture(t);
  const server = backend(size);
  server.files.push({ file_id: 'different-content', file_name: 'test.pdf', file_size: size + 1 });
  const result = await uploadFile({ onebot: server.onebot, chatKey: 'group:100001', filePath, checkQuota: false });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 1);
  assert.equal(result.fileId, 'real-2');
});

test('明确临时错误按原退避重试，第三次成功，计数和日志准确且不记录鉴权信息', async (t) => {
  const { filePath, size } = fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const server = backend(size, (_params, state, accept) => {
    if (state.uploads.length < 3) throw new Error('network timeout Authorization: Bearer secret-test-token');
    return accept();
  });
  const logs = [];
  const pending = uploadFile({ onebot: server.onebot, chatKey: 'group:100001', filePath,
    checkQuota: false, log: (line) => logs.push(line) });
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(2000);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(4000);
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 3);
  assert.equal(result.retries, 2);
  assert.equal(result.filenameRetries, 0);
  assert.equal(server.files.length, 1);
  assert.equal(logs.filter(line => line.includes('"event":"attempt"')).length, 3);
  assert.doesNotMatch(logs.join('\n'), /Authorization|secret-test-token|Bearer/);
});

test('三次临时错误用尽只报告两次自动重试', async (t) => {
  const { filePath, size } = fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const server = backend(size, () => { throw new Error('网络连接异常'); });
  const pending = uploadFile({ onebot: server.onebot, chatKey: 'group:100001', filePath, checkQuota: false });
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(2000);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(4000);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(server.uploads.length, 3);
  assert.match(result.error, /已尝试 3 次，自动重试 2 次/);
});

test('退避期间文件延迟入库，重试前回查阻止第二次上传', async (t) => {
  const { filePath, size } = fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const server = backend(size, () => { throw new Error('network timeout'); });
  const pending = uploadFile({ onebot: server.onebot, chatKey: 'group:100001', filePath, checkQuota: false });
  await new Promise(resolve => setImmediate(resolve));
  server.files.push({ file_id: 'late-id', file_name: 'test.pdf', file_size: size });
  t.mock.timers.tick(2000);
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.fileId, 'late-id');
  assert.equal(result.attempts, 1);
  assert.equal(result.retries, 0);
  assert.equal(server.uploads.length, 1);
});

for (const response of [null, {}]) {
  test(`失败后列表不可核对（${JSON.stringify(response)}）时停止自动重传`, async (t) => {
    const { filePath } = fixture(t);
    let uploads = 0;
    const result = await uploadFile({ chatKey: 'group:100001', filePath, checkQuota: false,
      onebot: { async call(action) {
        if (action === 'get_group_root_files') {
          if (response === null) throw new Error('lookup timeout');
          return response;
        }
        uploads++;
        throw new Error('network timeout');
      } } });
    assert.equal(result.ok, false);
    assert.equal(result.attempts, 1);
    assert.equal(uploads, 1);
  });
}

for (const reason of ['permission denied network timeout', 'filename blocked by policy', 'rich media transfer failed EventChecker failed', 'code=-134 timeout', 'EventChecker timeout 文件上传失败（-134）']) {
  test(`明确拒绝或原因不明的错误及时停止：${reason}`, async (t) => {
    const { filePath, size } = fixture(t);
    const server = backend(size, () => { throw new Error(reason); });
    const result = await uploadFile({ onebot: server.onebot, chatKey: 'group:100001', filePath,
      fallbackName: 'JM1485785.pdf', checkQuota: false });
    assert.equal(result.ok, false);
    assert.equal(result.attempts, 1);
    assert.equal(result.filenameRetries, 0);
    assert.equal(result.error.endsWith(reason), true);
  });
}

test('无 file_id 时仍可从列表确认成功；列表也没有则停止并保留未知提示', async (t) => {
  const { filePath, size } = fixture(t);
  for (const listed of [true, false]) {
    const server = backend(size, (_params, _state, accept) => {
      if (listed) accept();
      return {};
    });
    const result = await uploadFile({ onebot: server.onebot, chatKey: 'group:100001', filePath, checkQuota: false });
    assert.equal(result.ok, listed);
    assert.equal(result.attempts, 1);
    if (!listed) assert.match(result.error, /没有 file_id.*上传可能未完成/);
  }
});

test('协议返回成功但列表未查到，保留原有成功语义，不重复上传', async (t) => {
  const { filePath, size } = fixture(t);
  const server = backend(size, () => ({ file_id: 'returned-id' }));
  const result = await uploadFile({ onebot: server.onebot, chatKey: 'group:100001', filePath, checkQuota: false });
  assert.equal(result.ok, true);
  assert.equal(result.verified, false);
  assert.equal(result.fileId, 'returned-id');
  assert.equal(result.attempts, 1);
  assert.match(result.note, /群文件列表暂未回查到/);
});

test('私聊仍只调用既有私聊上传接口，不触发群文件名兼容或查重', async (t) => {
  const { filePath } = fixture(t);
  const calls = [];
  const result = await uploadFile({ chatKey: 'private:123456', filePath, fallbackName: 'JM1485785.pdf',
    onebot: { async call(action, params) { calls.push({ action, params }); return { file_id: 'private-id' }; } } });
  assert.equal(result.ok, true);
  assert.equal(result.scope, 'private');
  assert.deepEqual(calls, [{ action: 'upload_private_file', params: { user_id: 123456, file: filePath, name: 'test.pdf', upload_file: true } }]);
});

test('缓存重发兼容旧版被截断的显示名，不生成第二份群文件', async (t) => {
  const { filePath, size } = fixture(t);
  const name = `${'a'.repeat(125)}.pdf`;
  const server = backend(size);
  server.files.push({ file_id: 'old-id', file_name: name.slice(0, 120), file_size: size });
  const result = await uploadFile({ onebot: server.onebot, chatKey: 'group:100001', filePath, name,
    fallbackName: 'JM1485785.pdf', checkQuota: false });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 0);
  assert.equal(result.fileId, 'old-id');
  assert.equal(result.compatibilityNote, '');
});

test('备用名重试前原名称延迟可见，不误报曾使用备用名', async (t) => {
  const { filePath, size } = fixture(t);
  let lookups = 0;
  const result = await uploadFile({ chatKey: 'group:100001', filePath,
    fallbackName: 'JM1485785.pdf', checkQuota: false,
    onebot: { async call(action) {
      if (action === 'get_group_root_files') {
        lookups++;
        return { files: lookups >= 3 ? [{ file_id: 'delayed', file_name: 'test.pdf', file_size: size }] : [] };
      }
      throw new Error('invalid filename');
    } } });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 1);
  assert.equal(result.filenameRetries, 0);
  assert.equal(result.usedFallbackName, false);
  assert.equal(result.compatibilityNote, '');
});

test('混合自动重试和文件名重试分别计数，末次错误原文保留', async (t) => {
  const { filePath, size } = fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const failures = ['network timeout', 'ECONNRESET', 'invalid filename', 'retcode=100 code=-134 文件上传失败'];
  const server = backend(size, (_params, state) => { throw new Error(failures[state.uploads.length - 1]); });
  const pending = uploadFile({ onebot: server.onebot, chatKey: 'group:100001', filePath,
    fallbackName: 'JM1485785.pdf', checkQuota: false });
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(2000);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(4000);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 4);
  assert.equal(result.retries, 2);
  assert.equal(result.filenameRetries, 1);
  assert.match(result.error, /已尝试 4 次，自动重试 2 次，备用文件名重试 1 次/);
  assert.equal(result.error.endsWith(failures.at(-1)), true);
});

for (const reason of ['retcode=100 code=-134 文件上传失败', 'network timeout']) {
  test(`JM 原标题只调用一次，失败后编号名只调用一次：${reason}`, async (t) => {
    const { filePath, size } = fixture(t);
    const server = backend(size, (_params, state, accept) => {
      if (state.uploads.length === 1) throw new Error(reason);
      return accept();
    });
    const result = await uploadFile({ onebot: server.onebot, chatKey: 'group:100001', filePath,
      name: '原标题.pdf', fallbackName: 'JM1485785.pdf', fallbackOnFailure: true, checkQuota: false });
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 2);
    assert.equal(result.retries, 0);
    assert.equal(result.filenameRetries, 1);
    assert.equal(result.compatibilityNote, FILENAME_COMPATIBILITY_NOTE);
    assert.deepEqual(server.uploads.map(x => x.name), ['原标题.pdf', 'JM1485785.pdf']);
    assert.equal(server.files.length, 1);
  });
}

test('JM 编号名也失败时立即停止，报告真实次数并保留原名与编号名两次错误', async (t) => {
  const { filePath, size } = fixture(t);
  const server = backend(size, (_params, state) => {
    throw new Error(state.uploads.length === 1 ? 'retcode=100 code=-134 原名上传失败' : 'network timeout 编号名上传失败');
  });
  const result = await uploadFile({ onebot: server.onebot, chatKey: 'group:100001', filePath,
    fallbackName: 'JM1485785.pdf', fallbackOnFailure: true, checkQuota: false });
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 2);
  assert.equal(result.retries, 0);
  assert.equal(result.filenameRetries, 1);
  assert.equal(server.uploads.length, 2);
  assert.match(result.error, /原文件名：retcode=100 code=-134 原名上传失败/);
  assert.match(result.error, /编号文件名：network timeout 编号名上传失败/);
  assert.equal(result.compatibilityNote, '');
  assert.equal(fs.existsSync(filePath), true);
});

test('JM 原名返回确认失败但文件已经入库，不执行编号名重试', async (t) => {
  const { filePath, size } = fixture(t);
  const server = backend(size, (_params, _state, accept) => {
    accept();
    throw new Error('retcode=100 code=-134 文件上传失败');
  });
  const result = await uploadFile({ onebot: server.onebot, chatKey: 'group:100001', filePath,
    fallbackName: 'JM1485785.pdf', fallbackOnFailure: true, checkQuota: false });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 1);
  assert.equal(result.filenameRetries, 0);
  assert.equal(result.usedFallbackName, false);
  assert.equal(result.compatibilityNote, '');
  assert.equal(server.files.length, 1);
});

test('JM 失败后群文件列表无法核对，不能直接换编号名重传', async (t) => {
  const { filePath } = fixture(t);
  let uploads = 0;
  const result = await uploadFile({ chatKey: 'group:100001', filePath,
    fallbackName: 'JM1485785.pdf', fallbackOnFailure: true, checkQuota: false,
    onebot: { async call(action) {
      if (action === 'get_group_root_files') {
        if (uploads) throw new Error('lookup timeout');
        return { files: [] };
      }
      uploads++;
      throw new Error('retcode=100 code=-134 文件上传失败');
    } } });
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 1);
  assert.equal(result.filenameRetries, 0);
  assert.equal(uploads, 1);
});
