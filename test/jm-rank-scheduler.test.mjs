import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JmRankPushManager } from '../src/features/jm-suomingor/rank-scheduler.js';
import { DEFAULT_CONFIG, setRuntimeConfig, updateConfig } from '../src/core/config.js';

test('JmRankPushManager 单次渲染复用发往多个白名单群，单群失败不阻断且当日不重复推送', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-rank-push-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const nowMs = Date.parse('2026-11-19T00:06:00+08:00');
  const fetchedKinds = [];
  const sent = [];

  const mgr = new JmRankPushManager({
    dataDir,
    now: () => nowMs,
    getConfig: () => ({
      runtime: { mode: 'active', paused: false },
      jm: {
        enabled: true,
        rankPushEnabled: true,
        rankPushTime: '00:05',
        rankPushKinds: ['daily', 'weekly'],
        rankPushChats: ['group:747206342', 'group:892485992', 'group:999999999'],
        rankTopN: 20,
      },
    }),
    isChatAllowed: (chatKey) => chatKey !== 'group:999999999',
    getRank: async (kind) => {
      fetchedKinds.push(kind);
      const imagePath = path.join(dataDir, `rank-${kind}.jpg`);
      fs.writeFileSync(imagePath, `img-${kind}`);
      return {
        kind,
        label: kind,
        imagePath,
        payload: { title: `${kind} 榜`, subtitle: '测试时间', items: [{ id: '111' }] },
      };
    },
    onebot: {
      async sendSegments(kind, id, segments) {
        if (id === '747206342' && segments[0].data.text.includes('weekly')) {
          throw new Error('模拟单群发送失败');
        }
        sent.push({ kind, id, text: segments[0].data.text, file: segments[1].data.file });
      },
    },
    log: () => {},
  });

  const first = await mgr.runOnce({ forceRefresh: true, scheduled: true });
  assert.equal(first.ok, true);
  // 日榜与周榜各只拉取渲染 1 次
  assert.deepEqual(fetchedKinds, ['daily', 'weekly']);
  // 999999999 未授权跳过；747206342 daily 成功、weekly 失败；892485992 daily 与 weekly 都成功
  assert.equal(sent.length, 3);
  assert.ok(sent.some((s) => s.id === '747206342' && s.text.includes('daily')));
  assert.ok(sent.some((s) => s.id === '892485992' && s.text.includes('daily')));
  assert.ok(sent.some((s) => s.id === '892485992' && s.text.includes('weekly')));

  // 当日重复 scheduled 调用直接跳过
  const second = await mgr.runOnce({ forceRefresh: true, scheduled: true });
  assert.equal(second.skipped, 'already-pushed-today');
  assert.equal(fetchedKinds.length, 2);
});

test('config.jm 榜单与定时推送字段校验生效', () => {
  const base = structuredClone(DEFAULT_CONFIG);
  setRuntimeConfig(base);
  assert.throws(() => updateConfig({ jm: { rankTopN: 100 } }), /4～60/);
  updateConfig({ jm: { rankTopN: 48 } });
  assert.throws(() => updateConfig({ jm: { rankCacheTtlMinutes: 1 } }), /5～1440/);
  assert.throws(() => updateConfig({ jm: { rankPushTime: '25:00' } }), /HH:MM/);
  assert.throws(() => updateConfig({ jm: { rankPushKinds: [] } }), /至少选择一项/);
  assert.throws(() => updateConfig({ jm: { rankPushChats: ['private:123456'] } }), /group:<群号>/);
});
