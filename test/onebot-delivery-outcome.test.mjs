import assert from 'node:assert/strict';
import test from 'node:test';
import { OneBotClient } from '../src/onebot/onebot.js';

const cases = [
  { wording: 'group message delivery was not confirmed: QQ returned no message receipt; check the conversation before retrying', outcome: 'unknown' },
  { message: 'QQ returned no message receipt', outcome: 'unknown' },
  { wording: 'permission denied', outcome: 'failed' },
  { wording: 'invalid group_id', outcome: 'failed' }
];

for (const transport of ['HTTP', 'WS']) {
  test(`${transport}: missing receipts remain unknown while explicit rejection remains failed`, async (t) => {
    for (const example of cases) {
      const bot = new OneBotClient({ httpUrl: 'http://127.0.0.1:1' });
      const { outcome, ...detail } = example;
      const response = { status: 'failed', retcode: 100, ...detail };
      let calls = 0;
      if (transport === 'HTTP') {
        t.mock.method(globalThis, 'fetch', async () => {
          calls++;
          return { ok: true, status: 200, json: async () => response };
        });
      } else {
        bot.connected = true;
        bot.socket = {
          readyState: 1,
          send(raw, callback) {
            calls++;
            const { echo } = JSON.parse(raw);
            const pending = bot.wsPending.get(echo);
            clearTimeout(pending.timer);
            bot.wsPending.delete(echo);
            callback(null);
            pending.resolve(response);
          }
        };
      }
      const call = transport === 'HTTP'
        ? bot.call('send_group_forward_msg', {})
        : bot.callViaWs('send_group_forward_msg', {});
      await assert.rejects(call, error => {
        assert.equal(error.outcome, outcome);
        assert.equal(error.retcode, 100);
        assert.equal(error.action, 'send_group_forward_msg');
        assert.ok(error.message.includes(detail.wording || detail.message));
        return true;
      });
      assert.equal(calls, 1);
      t.mock.restoreAll();
    }
  });
}
