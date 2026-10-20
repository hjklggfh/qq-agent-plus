import assert from 'node:assert/strict';
import { test } from 'node:test';
import { updateFailureDetail } from '../scripts/update-failure-diagnostic.mjs';

test('更新测试失败时提取用例和断言原因，而不是末尾统计', () => {
  const stdout = `大量通过日志\n✖ failing tests:\n\ntest at test/guard.test.mjs:12:1\n✖ 私聊漏回复兜底\n  AssertionError [ERR_ASSERTION]: 预期只发一次\n  2 !== 1\n${'日志'.repeat(1600)}\nℹ tests 100\nℹ fail 1`;
  const detail = updateFailureDetail({ stdout }, { tests: true });
  assert.match(detail, /私聊漏回复兜底/);
  assert.match(detail, /预期只发一次/);
  assert.doesNotMatch(detail, /ℹ tests/);
});

test('无结构化失败时保留命令输出末尾', () => {
  assert.equal(updateFailureDetail({ stderr: 'fatal: network unavailable' }), 'fatal: network unavailable');
});
