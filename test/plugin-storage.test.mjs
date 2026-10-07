// 插件存储与设置/凭据视图的契约用例（capability: storage / secrets）。
//
// 两条主线：
//   ① 落到 <数据目录>/plugin-state/<id>/，写入是原子的、有上限的，坏文件会被备份而不是
//      被当成合法状态用下去；
//   ② 设置视图里**凭据字段必须消失**、凭据只能按"凭据样"的名字读 —— 这条守的是
//      "宿主按字段名脱敏"的前提，名字不合法就等于把明文凭据交给控制台回显。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-plugin-storage-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
process.on('exit', () => {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows 句柄占用 */ }
});

const {
  MAX_KV_KEYS,
  MAX_KV_VALUE_BYTES,
  PluginKvStore,
  PluginStorageError,
  atomicWriteFile,
  pluginStateDir
} = await import('../plugins/_host/storage.js');
const { readPluginSecret, readPluginSettings } = await import('../plugins/_host/context.js');

let seq = 0;
function newStore() {
  seq += 1;
  return new PluginKvStore({ dataDir, pluginId: `fixture-${seq}` });
}

test('状态目录落在 <数据目录>/plugin-state/<插件 id>/，且不合法 id 直接被拒', () => {
  assert.equal(pluginStateDir('/data', 'demo'), path.join('/data', 'plugin-state', 'demo'));
  // id 由 manifest 校验限死；这里再断言一次，因为它也会被别处直接调用（例如控制台清状态）
  for (const bad of ['../escape', 'Demo', 'de_mo', '', 'a'.repeat(50), '1st']) {
    assert.throws(() => pluginStateDir('/data', bad), PluginStorageError, `应拒绝 ${JSON.stringify(bad)}`);
  }
});

test('键值读写：get / set / delete / list / all / sizeBytes', () => {
  const kv = newPluginKv();
  assert.equal(kv.get('missing'), null);
  assert.equal(kv.list().length, 0);

  kv.set('counter', 3);
  kv.set('note', { text: '你好' });
  assert.equal(kv.get('counter'), 3);
  assert.deepEqual(kv.get('note'), { text: '你好' });
  assert.deepEqual(kv.list(), ['counter', 'note']);
  assert.deepEqual(kv.all(), { counter: 3, note: { text: '你好' } });
  assert.ok(kv.sizeBytes() > 0);

  assert.equal(kv.delete('counter'), true);
  assert.equal(kv.delete('counter'), false);
  assert.deepEqual(kv.list(), ['note']);

  // 深拷贝：改视图**以及改嵌套值**都不能影响内部状态
  // （浅拷贝只挡得住换掉顶层键，挡不住 kv.all().nested.x = 1 这种就地改）
  const snapshot = kv.all();
  snapshot.note.text = '被改了';
  assert.equal(kv.get('note').text, '你好');
  assert.equal(kv.all().note.text, '你好');
});

function newPluginKv() {
  return newStore();
}

test('真实落盘：换一个实例仍能读到（重启不丢），文件在 plugin-state 下', () => {
  const kv = newStore();
  kv.set('persisted', 'yes');
  const file = path.join(kv.dir, 'kv.json');
  assert.ok(fs.existsSync(file));
  assert.equal(kv.dir, path.join(dataDir, 'plugin-state', kv.pluginId));

  const reopened = new PluginKvStore({ dataDir, pluginId: kv.pluginId });
  assert.equal(reopened.get('persisted'), 'yes');
});

test('键名不合法一律拒绝（免得键名把日志/状态页搞乱）', () => {
  const kv = newStore();
  for (const bad of ['含空格 key', 'a/b', 'a\\b', '', 'x'.repeat(65), 'emoji😀']) {
    assert.throws(() => kv.set(bad, 1), /键名不合法/, `应拒绝 ${JSON.stringify(bad)}`);
    assert.throws(() => kv.get(bad), /键名不合法/);
  }
  // 允许的字符集
  for (const good of ['a', 'a.b', 'a:b', 'a-b_c.1']) {
    assert.equal(kv.set(good, 1), true);
  }
});

test('单个值超过上限被拒，且拒绝后不留下"以为存住了"的状态', () => {
  const kv = newStore();
  kv.set('small', 'ok');
  const huge = 'x'.repeat(MAX_KV_VALUE_BYTES + 10);
  assert.throws(() => kv.set('huge', huge), /单个值超过上限/);
  // 关键：被拒的写入不许出现在内存里（否则插件 get() 读得到、重启却没了）
  assert.equal(kv.get('huge'), null);
  assert.deepEqual(kv.list(), ['small']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(kv.dir, 'kv.json'), 'utf8')).huge, undefined);
});

test('键数量超过上限被拒', () => {
  const kv = newStore();
  for (let i = 0; i < MAX_KV_KEYS; i += 1) kv.set(`k${i}`, i);
  assert.throws(() => kv.set('one-too-many', 1), /键数量超过上限/);
  assert.equal(kv.get('one-too-many'), null);
});

test('整份存储超过文件上限时写入被拒（不是写到磁盘胀爆）', () => {
  const kv = newStore();
  const chunk = 'y'.repeat(30000);
  let thrown = null;
  for (let i = 0; i < 40; i += 1) {
    try {
      kv.set(`big${i}`, chunk);
    } catch (error) {
      thrown = error;
      break;
    }
  }
  assert.ok(thrown, '应该在上限处被拒');
  assert.match(thrown.message, /存储超过上限/);
  // 落盘那份仍然是合法 JSON，且不超过上限
  const text = fs.readFileSync(path.join(kv.dir, 'kv.json'), 'utf8');
  assert.ok(Buffer.byteLength(text, 'utf8') <= 512 * 1024);
  JSON.parse(text);
});

test('无法序列化的值被拒（undefined / 函数 / 循环引用）', () => {
  const kv = newStore();
  assert.throws(() => kv.set('fn', () => 1), /无法序列化成 JSON/);
  assert.throws(() => kv.set('undef', undefined), /无法序列化成 JSON/);
  const circular = {};
  circular.self = circular;
  assert.throws(() => kv.set('circular', circular), /无法序列化成 JSON/);
  // 被拒之后什么都没存下
  assert.deepEqual(kv.list(), []);
});

test('顶层不是对象的 kv.json 被备份、按空读，而不是把内容当合法状态用下去', () => {
  const kv = newStore();
  kv.set('a', 1);
  fs.writeFileSync(path.join(kv.dir, 'kv.json'), '[1,2,3]');

  const reopened = new PluginKvStore({ dataDir, pluginId: kv.pluginId });
  assert.deepEqual(reopened.all(), {});
  assert.notEqual(reopened.brokenBackup, '');
  assert.ok(fs.existsSync(reopened.brokenBackup), '坏文件要留一份给人看');
});

test('kv.json 解析不了时同样备份 + 按空读', () => {
  const kv = newStore();
  kv.set('a', 1);
  fs.writeFileSync(path.join(kv.dir, 'kv.json'), '{ this is not json');

  const reopened = new PluginKvStore({ dataDir, pluginId: kv.pluginId });
  assert.deepEqual(reopened.all(), {});
  assert.ok(fs.existsSync(reopened.brokenBackup));
});

test('原子写不留 tmp 文件（进程被杀也不该留下半截文件）', () => {
  const kv = newStore();
  for (let i = 0; i < 5; i += 1) kv.set(`k${i}`, i);
  const left = fs.readdirSync(kv.dir).filter((name) => name.includes('.tmp-'));
  assert.deepEqual(left, []);
});

test('atomicWriteFile 落盘成功，且文件权限在类 Unix 上是 0600（config/状态含敏感内容）', () => {
  const file = path.join(dataDir, 'perm-check', 'x.json');
  atomicWriteFile(file, '{"a":1}');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}');
  if (process.platform === 'win32') return;   // Windows 上 chmod 无意义
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('updatedAt 只在真的写过之后才非 0', () => {
  const kv = newStore();
  assert.equal(kv.updatedAt(), 0);
  kv.set('a', 1);
  assert.ok(kv.updatedAt() > 0);
});

test('readPluginSettings：凭据字段整条消失，其它设置原样给出，且是深拷贝', () => {
  const config = {
    plugins: {
      settings: {
        demo: {
          mode: 'fast',
          timeoutMs: 5000,
          apiKey: 'sk-SECRET',
          webhookToken: 'tok-SECRET',
          nested: { password: 'pw-SECRET', keep: 1 },
          list: [{ secretThing: 'x', keep: 2 }]
        }
      }
    }
  };
  const view = readPluginSettings(config, 'demo');
  assert.deepEqual(view.mode, 'fast');
  assert.equal(view.timeoutMs, 5000);
  assert.equal('apiKey' in view, false);
  assert.equal('webhookToken' in view, false);
  assert.equal('password' in view.nested, false);
  assert.equal(view.nested.keep, 1);
  assert.equal('secretThing' in view.list[0], false);
  assert.equal(view.list[0].keep, 2);

  // 深拷贝：改视图不影响原配置
  view.mode = 'slow';
  assert.equal(config.plugins.settings.demo.mode, 'fast');
});

test('readPluginSettings / readPluginSecret：其它插件的设置与不存在的插件都读不到', () => {
  const config = { plugins: { settings: { other: { apiKey: 'sk-OTHER' } } } };
  assert.deepEqual(readPluginSettings(config, 'demo'), {});
  assert.equal(readPluginSecret(config, 'demo', 'apiKey'), '');
  assert.deepEqual(readPluginSettings({}, 'demo'), {});
  assert.deepEqual(readPluginSettings({ plugins: { settings: { demo: 'scalar' } } }, 'demo'), {});
});

test('readPluginSecret：凭据样的多种命名都放行（含被 2026-10-08 补进模式的 token 后缀）', () => {
  const config = {
    plugins: {
      settings: {
        demo: {
          apiKey: 'sk-OK',
          apiToken: 'tok-CAMEL',
          webhookToken: 'tok-WEBHOOK',
          client_secret: 'sec-SNAKE',
          apiSecret: 'sec-CAMEL',
          botPassword: 'pw-X',
          mode: 'fast'
        }
      }
    }
  };
  for (const name of ['apiKey', 'apiToken', 'webhookToken', 'client_secret', 'apiSecret', 'botPassword']) {
    assert.notEqual(readPluginSecret(config, 'demo', name), '', `${name} 应被认成凭据`);
  }
});

test('readPluginSecret：不像凭据的字段一律拒绝，并说清"为什么要改名"', () => {
  const config = { plugins: { settings: { demo: { apiKey: 'sk-OK', mode: 'fast', region: 'cn' } } } };
  // 宿主脱敏**按字段名**生效：放行一个名字不含关键词的字段，等于把明文交给控制台回显。
  assert.throws(() => readPluginSecret(config, 'demo', 'mode'), /不像凭据字段/);
  assert.throws(() => readPluginSecret(config, 'demo', 'region'), /不像凭据字段/);
  assert.throws(() => readPluginSecret(config, 'demo', 'region'), /改名成凭据样/);
  assert.throws(() => readPluginSecret(config, 'demo', 'region'), /api\.config/);
});

test('脱敏模式不许把非凭据的 token 计数类字段误伤（复数结尾与词首 token 都要放行）', async () => {
  const { SECRET_KEY_PATTERN } = await import('../src/core/secret-keys.js');
  // 这些是业务字段，被当成密钥会让设置页直接丢字段（值被删、只留 hasXxx）
  for (const name of ['maxRunTokens', 'contextWindowTokens', 'lifecycleRolloverInputTokens', 'tokenSaver', 'promptTokens']) {
    assert.equal(SECRET_KEY_PATTERN.test(name), false, `${name} 不该被认成凭据`);
  }
  // 而这些确实是凭据
  for (const name of ['token', 'accessToken', 'apiToken', 'webhookToken', 'refreshToken']) {
    assert.equal(SECRET_KEY_PATTERN.test(name), true, `${name} 应被认成凭据`);
  }
});

test('readPluginSecret：名字不合法 / 含点号（防止穿透到别的段）都被拒', () => {
  const config = { plugins: { settings: { demo: { apiKey: 'sk-OK' } } } };
  assert.throws(() => readPluginSecret(config, 'demo', ''), /凭据名不合法/);
  assert.throws(() => readPluginSecret(config, 'demo', 'a/b'), /凭据名不合法/);
  assert.throws(() => readPluginSecret(config, 'demo', 'x'.repeat(65)), /凭据名不合法/);
  assert.throws(() => readPluginSecret(config, 'demo', 'other.apiKey'), /不能含点号/);
});

test('readPluginSecret：字段不存在返回空串（让插件写成"没配就报错"，而不是 undefined 拼进 URL）', () => {
  assert.equal(readPluginSecret({ plugins: { settings: { demo: {} } } }, 'demo', 'apiKey'), '');
  assert.equal(readPluginSecret({ plugins: { settings: { demo: { apiKey: null } } } }, 'demo', 'apiKey'), '');
  assert.equal(readPluginSecret({ plugins: { settings: { demo: { apiKey: 123 } } } }, 'demo', 'apiKey'), '123');
});
