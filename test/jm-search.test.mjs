import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyJmDirectCommand } from '../src/features/jm-suomingor/direct-command.js';
import { searchCardNodes, searchCardPage } from '../src/features/jm-suomingor/search.js';
import { clearSearchSessions, rememberSearchPage, resolveSearchFollowup, searchSenderId } from '../src/features/jm-suomingor/search-session.js';
import { activate as activateJm } from '../src/features/jm-suomingor/index.js';

const rows = Array.from({ length: 13 }, (_, i) => ({
  id: String(123450 + i),
  name: `作品${i + 1}`,
  author: `作者${i + 1}`,
  description: `简介${i + 1}`
}));
const testStateDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '.jm-search-unused');

function fakeClient(size = 7) {
  const calls = [];
  return {
    calls,
    async searchAlbums(query, page) {
      calls.push(['search', query, page]);
      return { total: rows.length, content: rows.slice((page - 1) * size, page * size) };
    },
    async albumInfo(id) {
      calls.push(['album', id]);
      return { id, name: `详细${id}`, tags: ['标签甲', '标签乙'], authors: ['作者'], description: '作品简介' };
    },
    async httpGet(url) {
      calls.push(['cover', url]);
      return { ok: true, buffer: Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(1500)]) };
    }
  };
}

test('JM 搜索指令包含关键词及可选页码', () => {
  assert.deepEqual(classifyJmDirectCommand('JM搜索 测试作品'), {
    tool: 'jm_search', args: { query: '测试作品', page: 1 }
  });
  assert.deepEqual(classifyJmDirectCommand('禁漫搜索 测试 作品 第2页'), {
    tool: 'jm_search', args: { query: '测试 作品', page: 2 }
  });
});

test('JM 卡片按每页五部换算站点页码，补齐六条消息', async () => {
  const client = fakeClient();
  const result = await searchCardNodes(client, { query: '测试', page: 2, bot: { selfId: '10001', selfNickname: '机器人' } });
  assert.equal(result.pages, 3);
  assert.equal(result.nodes.length, 6);
  assert.deepEqual(result.rows.map((row) => row.id), rows.slice(5, 10).map((row) => row.id));
  assert.deepEqual(client.calls.filter(([action]) => action === 'search').map(([, , page]) => page), [1, 2]);
  const first = result.nodes[0];
  assert.match(first.data.content[0].data.text, /^6\. 详细123455\n编号：JM123455\n标签：标签甲、标签乙/m);
  assert.equal(first.data.content[1].type, 'image');
  assert.match(first.data.content[1].data.file, /^base64:\/\//);
  assert.match(result.nodes[5].data.content[0].data.text, /第 2\/3 页.*共 13 部/);
  assert.match(result.nodes[5].data.content[0].data.text, /第3页/);
  assert.match(result.nodes[5].data.content[0].data.text, /发送「下一页」/);
  assert.match(result.nodes[5].data.content[0].data.text, /发送作品序号即可下载/);
});

test('JM 最后一页保留五个结果位置和翻页提示，越界不发卡片', async () => {
  const result = await searchCardNodes(fakeClient(), { query: '测试', page: 3 });
  assert.equal(result.nodes.length, 6);
  assert.equal(result.rows.length, 3);
  assert.match(result.nodes[0].data.content[0].data.text, /^11\. /);
  assert.match(result.nodes[3].data.content[0].data.text, /^14\. 本页没有更多作品/);
  assert.match(result.nodes[5].data.content[0].data.text, /上一页.*第2页/);
  assert.doesNotMatch(result.nodes[5].data.content[0].data.text, /下一页/);
  const missing = await searchCardPage(fakeClient(), '测试', 4);
  assert.equal(missing.pages, 3);
  assert.deepEqual(missing.rows, []);
});

test('JM 搜索后可用上一页、下一页及跨页序号选择作品，且按发送者隔离', () => {
  clearSearchSessions();
  const chatKey = 'group:100001';
  const senderId = '200001';
  const command = (text, sender = senderId) => resolveSearchFollowup({ chatKey, senderId: sender, text });
  assert.equal(searchSenderId({ kind: 'group', triggerEntries: [{ senderId }] }), senderId);
  assert.equal(rememberSearchPage({ chatKey, senderId, query: '测试', page: 1, pages: 3, rows: rows.slice(0, 5) }), true);
  assert.deepEqual(command('1'), { type: 'resource', index: 1, albumId: '123450' });
  assert.deepEqual(command('下一页'), { type: 'page', query: '测试', page: 2 });
  assert.equal(command('6'), null, '未展示的序号不会截获普通数字消息');
  assert.equal(command('1', '200002'), null, '同群其他人不能使用这次搜索的序号');
  rememberSearchPage({ chatKey, senderId, query: '测试', page: 2, pages: 3, rows: rows.slice(5, 10) });
  assert.deepEqual(command('7'), { type: 'resource', index: 7, albumId: '123456' });
  assert.deepEqual(command('1'), { type: 'resource', index: 1, albumId: '123450' });
  assert.deepEqual(command('上一页'), { type: 'page', query: '测试', page: 1 });
  rememberSearchPage({ chatKey, senderId, query: '另一个搜索', page: 1, pages: 1, rows: rows.slice(10, 12) });
  assert.equal(command('7'), null, '新搜索会清除旧序号映射');
  assert.deepEqual(command('下一页'), { type: 'notice', text: '已经是第 1 页了。' });
  clearSearchSessions();
});

test('JM 搜索会话过期后不再响应数字或翻页', () => {
  clearSearchSessions();
  rememberSearchPage({ chatKey: 'private:200001', senderId: '200001', query: '测试', page: 1, pages: 2, rows: rows.slice(0, 5), now: 1000 });
  assert.equal(resolveSearchFollowup({ chatKey: 'private:200001', senderId: '200001', text: '下一页', now: 1000 + 30 * 60 * 1000 }), null);
  assert.equal(searchSenderId({ kind: 'private', chatId: '200001' }), '200001');
});

test('JM 消息入口将序号交给下载工具，并消费翻页指令', async () => {
  clearSearchSessions();
  const sent = [];
  const feature = activateJm({
    config: () => ({ enabled: false, dataDir: path.dirname(testStateDir), downloadDir: testStateDir }),
    stateDir: testStateDir,
    log: { info() {}, warn() {} },
    registerTool() {}
  });
  const context = {
    chatKey: 'private:200001', chatId: '200001', kind: 'private',
    fetch: async () => { throw new Error('测试不应请求网络'); },
    send: async (messages) => { sent.push(...messages); return { sent: messages.length }; }
  };
  try {
    rememberSearchPage({ chatKey: context.chatKey, senderId: context.chatId, query: '测试', page: 1, pages: 2, rows: rows.slice(0, 5) });
    assert.equal(await feature.handleMessage(context, { text: '1', senderId: '200001' }), true);
    assert.match(sent[0], /漫画下载功能被关掉/);
    assert.equal(await feature.handleMessage(context, { text: '下一页', senderId: '200001' }), true);
    assert.match(sent[1], /JM 功能已关闭/);
  } finally {
    await feature.deactivate();
  }
});
