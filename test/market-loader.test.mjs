import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  marketManifestFingerprint,
  normalizeMarketManifest,
  readMarketManifest
} from '../plugins/_host/market-manifest.js';
import { initMarketExtensions } from '../plugins/market-loader.js';
import { clearPluginRegistry, pluginToolDefs } from '../plugins/_host/registry.js';

const SAMPLE = path.resolve('D:/QQ-Agent/market-analysis/bangumi-lookup/bangumi-lookup');

test('市场扩展：没有启用或审批时不执行代码', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-market-test-'));
  const fixture = path.join(root, 'disabled-fixture');
  fs.mkdirSync(fixture);
  fs.writeFileSync(path.join(fixture, 'skill.json'), JSON.stringify({
    id: 'disabled-fixture', name: 'Disabled fixture', version: '1.0.0', apiVersion: 1, entry: 'index.js'
  }));
  fs.writeFileSync(path.join(fixture, 'index.js'), 'export async function setup() {}\n');
  try {
    const result = await initMarketExtensions({
      dataDir: os.tmpdir(),
      config: { plugins: { marketRoots: [root], marketEnabled: [] } }
    });
    assert.equal(result.statuses[0]?.status, 'disabled');
  } finally {
    clearPluginRegistry();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('市场扩展：真实 bangumi skill 注册带前缀的工具并注入提示词', async (t) => {
  if (!fs.existsSync(SAMPLE)) {
    t.skip('本地市场样本不存在');
    return;
  }
  const manifest = normalizeMarketManifest(readMarketManifest(SAMPLE), {
    dir: SAMPLE,
    expectedId: 'bangumi-lookup'
  });
  const config = {
    plugins: {
      marketRoots: [path.dirname(SAMPLE)],
      marketEnabled: ['bangumi-lookup'],
      marketApproved: { 'bangumi-lookup': marketManifestFingerprint(manifest) }
    }
  };
  const result = await initMarketExtensions({ config, dataDir: os.tmpdir() });
  assert.equal(result.statuses[0]?.status, 'loaded');
  assert.deepEqual(pluginToolDefs().map((tool) => tool.name).sort(), [
    'bangumi-lookup__calendar',
    'bangumi-lookup__detail',
    'bangumi-lookup__episodes',
    'bangumi-lookup__search'
  ]);
  clearPluginRegistry();
});
