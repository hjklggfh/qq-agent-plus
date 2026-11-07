import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

// 装配层面的断言：记忆分库这件事光"模块对了"不够 —— 控制台忘了把第二实例交给编排器，
// 模型照样只读写主库。这里直接把 createApp 装起来看接线。
const dir = fs.mkdtempSync(path.join(process.cwd(), '.persona-memory-wiring-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* SQLite 可能还占着文件 */ } });

test('控制台把第二人设的记忆库接到了编排器上，且不抢 IdentityStore 的绑定', async (t) => {
  const { createApp } = await import('../src/console/app.js');
  const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/core/config.js');
  const { ALT_MEMORY_ROOT } = await import('../src/memory/memory-routing.js');
  const { globalMemoryStoreForIdentity } = await import('../src/memory/memory-runtime-integration.js');

  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.runtime.mode = 'active';
  cfg.runtime.paused = false;
  cfg.sticker.autoCollect = false;
  cfg.personaSwitch.enabled = true;
  cfg.personaSwitch.altModel = 'claude-sonnet-5-5-low';
  cfg.personaSwitch.altRoleText = '你是克劳德';
  setRuntimeConfig(cfg);

  const app = createApp({ log: () => {} });
  t.after(() => app.stop());

  assert.ok(app.memoryAlt, 'createApp 应该造出第二个记忆实例');
  assert.notEqual(app.memoryAlt, app.memory);
  assert.equal(app.memoryAlt.root, ALT_MEMORY_ROOT);
  assert.equal(app.memory.root, path.join(dir, 'memory'));

  // 编排器拿到的必须是同一对实例（不是又 new 了一份）
  assert.equal(app.orchestrator.memory, app.memory);
  assert.equal(app.orchestrator.memoryAlt, app.memoryAlt);

  // 第二实例绝不能顶掉 IdentityStore 的全局记忆来源
  assert.equal(globalMemoryStoreForIdentity(), app.memory);

  // 功能开着但没人在值班：两边都按主库走
  const other = app.memoryAlt;
  app.memory.append('group:555', 'memberImpression', '主库在这里记过一条', { userId: '70001', target: '甲' });
  assert.match(app.memory.formatForPrompt('group:555'), /主库在这里记过一条/);
  assert.equal(other.formatForPrompt('group:555'), '');
});
