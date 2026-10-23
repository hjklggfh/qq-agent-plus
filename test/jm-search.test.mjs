import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

import { classifyJmDirectCommand } from '../src/features/jm-suomingor/direct-command.js';
import { searchCardNodes, searchCardPage, searchDetailNodes, searchFallbackNodes, groupForwardVisible, normalizeSearchCover, deliverSearchCard } from '../src/features/jm-suomingor/search.js';
import { clearSearchSessions, rememberSearchPage, resolveSearchFollowup, searchSenderId } from '../src/features/jm-suomingor/search-session.js';
import { activate as activateJm } from '../src/features/jm-suomingor/index.js';

const rows = Array.from({ length: 13 }, (_, i) => ({
  id: String(123450 + i),
  name: `作品${i + 1}`,
  author: `作者${i + 1}`,
  description: `简介${i + 1}`
}));
const testStateDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '.jm-search-unused');
const coverFixture = await sharp({ create: { width: 40, height: 60, channels: 4,
  background: { r: 60, g: 120, b: 180, alpha: 0.5 } } }).png().toBuffer();

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
      return { ok: true, buffer: coverFixture };
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

test('封面完整解码并转换成有尺寸上限的 RGB JPEG，拒绝伪造文件头', async () => {
  const webp = await sharp({ create: { width: 1200, height: 1800, channels: 3,
    background: '#4080c0' } }).webp().toBuffer();
  const result = await normalizeSearchCover(webp);
  const metadata = await sharp(result).metadata();
  assert.equal(metadata.format, 'jpeg');
  assert.equal(metadata.space, 'srgb');
  assert.equal(metadata.isProgressive, false);
  assert.equal(metadata.width, 512);
  assert.equal(metadata.height, 768);
  assert.ok(result.length <= 256 * 1024);
  assert.ok((await normalizeSearchCover(coverFixture)).length > 0, '小于 1KB 的有效封面也可使用');
  await assert.rejects(normalizeSearchCover(Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(1500)])));
  await assert.rejects(normalizeSearchCover(Buffer.alloc(4 * 1024 * 1024 + 1)));
});

test('损坏或下载失败的封面逐个降级，不向协议端提交裸外站 URL', async () => {
  const client = fakeClient();
  let calls = 0;
  client.httpGet = async () => {
    calls += 1;
    return { ok: true, buffer: Buffer.from('<html>access denied</html>') };
  };
  const result = await searchCardNodes(client, { query: '测试', page: 1, includeExternalLink: false });
  assert.equal(calls, 10, '每张图仅尝试两个来源');
  assert.equal(result.nodes.length, 6);
  assert.ok(result.nodes.every((item) => item.data.content.every((segment) => segment.type === 'text')));
  assert.match(result.nodes[0].data.content[1].data.text, /封面暂不可用/);
  assert.doesNotMatch(JSON.stringify(result.nodes), /https?:\/\//);
});

test('群卡片以群历史确认，序号 0 的缓存不算成功，最终简版也必须核对', async () => {
  const result = await searchCardNodes(fakeClient(), { query: '测试', page: 1 });
  const sent = [];
  let visible = false;
  const ctx = {
    kind: 'group', chatId: '100001', selfId: '10001',
    forward: async (nodes, label) => {
      sent.push({ nodes, label });
      return { message_id: sent.length };
    },
    onebot: { call: async () => ({ messages: [{ message_id: sent.length, message_seq: visible ? 123 : 0 }] }) }
  };
  const options = { query: '测试', page: 1, verifyOptions: { attempts: 1, delayMs: 0 } };
  const missing = await deliverSearchCard(ctx, result, options);
  assert.equal(sent.length, 3);
  assert.equal(missing.kind, '编号简版');
  assert.equal(missing.visible, false, '最终卡片不可见时不能报告成功');
  sent.length = 0;
  visible = true;
  assert.equal((await deliverSearchCard(ctx, result, options)).visible, true);
  assert.equal(sent.length, 1);
  sent.length = 0;
  ctx.onebot.call = async () => { throw new Error('查询超时'); };
  assert.equal((await deliverSearchCard(ctx, result, options)).visible, null);
  assert.equal(sent.length, 1, '未知状态不触发连续补发');
});

test('JM 卡片按每页五部换算站点页码，补齐六条消息', async () => {
  const client = fakeClient();
  const result = await searchCardNodes(client, { query: '测试', page: 2, bot: { selfId: '10001', selfNickname: '机器人' } });
  assert.equal(result.pages, 3);
  assert.equal(result.nodes.length, 6);
  assert.ok(result.nodes.every((node) => node.data.name === '小鲸鱼'));
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

test('群聊完整版保留详情和封面，但不带外站直链', async () => {
  const result = await searchCardNodes(fakeClient(), {
    query: '测试', page: 1, includeExternalLink: false
  });
  const first = result.nodes[0].data.content;
  assert.match(first[0].data.text, /编号：JM123450\n标签：标签甲、标签乙\n作者：作者\n简介：作品简介/);
  assert.doesNotMatch(first[0].data.text, /https?:\/\//);
  assert.equal(first[1].type, 'image');
  assert.equal(result.nodes.length, 6);
  const details = searchDetailNodes(result.nodes);
  assert.equal(details.length, 6);
  assert.ok(details.every((item) => item.data.content.every((segment) => segment.type === 'text')));
  assert.match(details[0].data.content[0].data.text, /标签：标签甲、标签乙.*简介：作品简介/s);
  assert.equal(result.nodes[0].data.content[1].type, 'image', '详情版不改动先发的完整卡片');
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

test('群卡片未进入群历史时，可生成只含编号的六条简版卡片', async () => {
  const result = await searchCardNodes(fakeClient(), { query: '测试', page: 3 });
  const nodes = searchFallbackNodes(result, 3, { selfId: '10001' });
  assert.equal(nodes.length, 6);
  assert.equal(nodes[0].data.content[0].data.text, '11. JM123460');
  assert.equal(nodes[3].data.content[0].data.text, '14. 本页没有更多作品');
  assert.ok(nodes.every((item) => item.data.name === '小鲸鱼'
    && item.data.content.every((segment) => segment.type === 'text')));
  assert.doesNotMatch(JSON.stringify(nodes), /18comic|作品简介|base64:/);
  const calls = [];
  const onebot = { async call(action, params) {
    calls.push({ action, params });
    return { messages: [{ message_id: 123 }, { message_id: -456 }] };
  } };
  assert.equal(await groupForwardVisible(onebot, '100001', '-456', { attempts: 1, delayMs: 0 }), true);
  assert.equal(await groupForwardVisible(onebot, '100001', '999', { attempts: 1, delayMs: 0 }), false);
  assert.deepEqual(calls[0], { action: 'get_group_msg_history',
    params: { group_id: 100001, message_seq: 0, count: 50 } });
  assert.equal(await groupForwardVisible({ call: async () => { throw new Error('不可用'); } }, '100001', '999', { attempts: 1, delayMs: 0 }), null);
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
    assert.equal(feature.isDirectMessage({ chatKey: context.chatKey, senderId: context.chatId, text: '下一页' }), true);
    assert.equal(await feature.handleMessage(context, { text: '1', senderId: '200001' }), true);
    assert.match(sent[0], /漫画下载功能被关掉/);
    assert.equal(await feature.handleMessage(context, { text: '下一页', senderId: '200001' }), true);
    assert.match(sent[1], /JM 功能已关闭/);
  } finally {
    await feature.deactivate();
  }
});
