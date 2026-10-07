// pixiv-illust 插件的用例：纯函数 + 两条"与宿主接触面"的契约。
//
// 分三层：
//   ① 纯逻辑（URL 构造 / 字段映射 / 分级 / 挑选 / PID / 主人名单）—— 不碰网络、不碰盘；
//   ② 两个 seam：状态文件读写（临时目录）与 latestCaller/callerMayChangeRating 的授权判定；
//   ③ **门面契约**：拿真的 buildPluginApi / buildPluginToolContext 跑一遍 activate，
//      钉住"注册的工具名 == manifest.tools"、"toolCtx 上没有 store/sender/emit"、
//      "临时图片落在插件状态目录之内"（门面的 sendImage 只认那之内的文件）。
//
// 风格照抄 test/plugin-tools.test.mjs：临时 QQ_AGENT_DATA_DIR + 动态 import。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PLUGIN_DIR = path.join(REPO, 'plugins', 'pixiv-illust');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-pixiv-plugin-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
const tempDirs = [dataDir];
process.on('exit', () => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 句柄占用 */ }
  }
});

function mkTemp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const plugin = await import('../plugins/pixiv-illust/index.js');
const {
  activate, available, internals,
  buildLoliconUrl, mapLoliconItems, resolveRatings, filterByRating, normalizeRatingTokens,
  pickUnseen, buildTryList, extractPid, ownerIdSet, latestCaller, callerMayChangeRating,
  ratingsForChat, ratingOf, describeFetchError, resolveProxyUrl, deadSet, breakerState
} = plugin;

const { buildPluginApi, buildPluginToolContext } = await import('../plugins/_host/context.js');
const { normalizeManifest, readManifest, manifestFingerprint } = await import('../plugins/_host/manifest.js');
const { PLUGIN_CAPABILITY_IDS } = await import('../plugins/_host/capabilities.js');
const { pluginStateDir } = await import('../plugins/_host/storage.js');
const { initPlugins, resetPlugins } = await import('../plugins/loader.js');

// ── 门面：用真的 manifest + 真的 activate 建一次 ────────────────────────────
//
// config 里给上 ownerIds，下面 callerMayChangeRating/ratingsForChat 才能验到"全局设置"那一层。
const CONFIG = {
  plugins: {
    settings: {
      'pixiv-illust': { ownerIds: '10001,10002', ratings: ['safe'] }
    }
  }
};
const manifest = normalizeManifest(readManifest(PLUGIN_DIR), {
  pluginDir: PLUGIN_DIR,
  expectedId: 'pixiv-illust',
  capabilityNames: PLUGIN_CAPABILITY_IDS
});
const pluginToolNames = manifest.tools.map((tool) => tool.name).sort();

const registered = new Map();
const pluginApi = buildPluginApi({
  manifest,
  config: CONFIG,
  dataDir,
  log: null,
  registerTool: (def) => registered.set(String(def.name), def)
});
const pluginReturned = await activate(pluginApi);

/** 一个尽量贴近宿主真实 ctx 的假上下文（含那些**不许**泄漏给插件的字段）。 */
function fakeHostCtx(overrides = {}) {
  const images = [];
  const sends = [];
  const emitted = [];
  const session = { id: 'sess-1', leaseId: 'lease-1', rounds: 3, sent: [], triggerText: '在吗' };
  const ctx = {
    chatKey: 'group:12345',
    kind: 'group',
    chatId: '12345',
    selfId: '999',
    selfNickname: '小鲸鱼',
    botName: '小鲸鱼',
    signal: null,
    sender: {
      async sendTextBatch(chatKey, messages) {
        sends.push({ chatKey, messages });
        return { sent: messages.map((text, i) => ({ text, messageId: i + 1, at: '00:00:01' })), failed: [] };
      },
      async image(chatKey, payload, options) {
        images.push({ chatKey, payload, options });
        return { message_id: 4242 };
      }
    },
    store: {
      recent: () => [{
        id: 1, mid: 10, ts: 1700000000000, senderId: '10001', senderName: '主人', self: false, text: '来张初音ミク的图'
      }]
    },
    memory: { append() { throw new Error('插件不该碰到 memory'); } },
    onebot: { selfId: '999' },
    identityPilot: null,
    stickers: {},
    reminders: {},
    games: null,
    emit: (type, payload) => emitted.push([type, payload]),
    session,
    ...overrides
  };
  return { ctx, images, sends, emitted, session };
}

function makeToolCtx(hostCtx) {
  return buildPluginToolContext({
    manifest, hostCtx, config: CONFIG, dataDir, log: null, signal: null
  });
}

// ── ① 纯函数 ──────────────────────────────────────────────────────────────

test('buildLoliconUrl：关键词编码、num/r18/excludeAI 参数、tag 与 keyword 两种模式', () => {
  const tagUrl = buildLoliconUrl('https://api.lolicon.app/setu/v2', '初音ミク', { limit: 10 });
  const tag = new URL(tagUrl);
  assert.equal(tag.searchParams.get('tag'), '初音ミク');
  assert.equal(tag.searchParams.get('num'), '10');
  assert.equal(tag.searchParams.get('r18'), '0');
  assert.equal(tag.searchParams.get('excludeAI'), null);
  // 关键词必须真的 URL 编码过（日文原名要能安全拼进查询串）
  assert.match(tagUrl, /tag=%E5%88%9D%E9%9F%B3/);

  const kw = new URL(buildLoliconUrl('https://api.lolicon.app/setu/v2', '天童アリス', { mode: 'keyword' }));
  assert.equal(kw.searchParams.get('keyword'), '天童アリス');
  assert.equal(kw.searchParams.get('tag'), null);

  // 选了任一成人档 → r18=2（混合），到本机再精筛；只选全年龄 → 0
  assert.equal(new URL(buildLoliconUrl('https://api.lolicon.app/setu/v2', 'x', { allowed: new Set([2]) })).searchParams.get('r18'), '2');
  assert.equal(new URL(buildLoliconUrl('https://api.lolicon.app/setu/v2', 'x', { allowed: new Set([0]) })).searchParams.get('r18'), '0');
  // 旧字段兼容：没给 allowed 时看 allowR18 布尔
  assert.equal(new URL(buildLoliconUrl('https://api.lolicon.app/setu/v2', 'x', { allowR18: true })).searchParams.get('r18'), '2');
  assert.equal(new URL(buildLoliconUrl('https://api.lolicon.app/setu/v2', 'x', { excludeAI: true })).searchParams.get('excludeAI'), 'true');
  // num 被夹到 1~20
  assert.equal(new URL(buildLoliconUrl('https://api.lolicon.app/setu/v2', 'x', { limit: 999 })).searchParams.get('num'), '20');
  // 地址不合法要报出来，而不是拿空串去请求
  assert.throws(() => buildLoliconUrl('not a url', 'x'), /内置搜索接口地址不合法/);
});

test('mapLoliconItems：字段映射与缺字段兜底', () => {
  const items = mapLoliconItems({
    data: [
      {
        pid: 12345678, title: '标题', author: '作者', uid: 42, r18: true,
        tags: ['初音ミク', 'R-18'], urls: { original: 'https://i.pixiv.re/img-original/img/2024/01/02/03/04/05/12345678_p0.jpg' }
      },
      { pid: 87654321 },                       // 缺字段兜底
      { pid: 'not-a-pid', title: '坏条目' }     // pid 非法 → 丢掉
    ]
  });
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], {
    pid: '12345678',
    title: '标题',
    author: '作者',
    userId: '42',
    bookmarks: NaN,                          // 这个接口不给收藏数
    xRestrict: 1,                            // r18:true → 1，统一交给 isR18/ratingOf
    tags: ['初音ミク', 'R-18'],
    thumbnail: 'https://i.pixiv.re/img-original/img/2024/01/02/03/04/05/12345678_p0.jpg',
    imageUrl: 'https://i.pixiv.re/img-original/img/2024/01/02/03/04/05/12345678_p0.jpg'
  });
  assert.equal(items[1].pid, '87654321');
  assert.equal(items[1].title, '（无题）');
  assert.equal(items[1].author, '（未知作者）');
  assert.equal(items[1].xRestrict, 0);
  assert.deepEqual(items[1].tags, []);
  assert.deepEqual(mapLoliconItems(null), []);
  assert.deepEqual(mapLoliconItems({ data: 'nope' }), []);
});

test('resolveRatings / filterByRating：只勾 R18G 时就只出 R18G；空选择被兜成 safe', () => {
  const items = [
    { pid: '1', xRestrict: 0, tags: [] },
    { pid: '2', xRestrict: 1, tags: ['R-18'] },
    { pid: '3', xRestrict: 1, tags: ['R-18G'] },   // 标签把 1 升到 2
    { pid: '4', xRestrict: 2, tags: [] }
  ];
  assert.deepEqual([...resolveRatings({ ratings: ['safe'] })], [0]);
  assert.deepEqual([...resolveRatings({ ratings: ['safe', 'r18'] })].sort(), [0, 1]);
  // 只勾 R18G：全年龄也不出（"没勾的档一律不出"）
  const onlyG = resolveRatings({ ratings: ['r18g'] });
  assert.deepEqual([...onlyG], [2]);
  assert.deepEqual(filterByRating(items, onlyG).kept.map((x) => x.pid), ['3', '4']);
  // 空选择/全是垃圾 → 兜成「全年龄」（配置文件可以手改，界面那道校验管不到）
  assert.deepEqual([...resolveRatings({ ratings: [] })], [0]);
  assert.deepEqual([...resolveRatings({ ratings: ['  ', '不存在'] })], [0]);
  // 逗号串也认；旧字段 allowR18 的兼容语义是"全年龄 + R18"
  assert.deepEqual([...resolveRatings({ ratings: 'safe,r18' })].sort(), [0, 1]);
  assert.deepEqual([...resolveRatings({ allowR18: true })].sort(), [0, 1]);
  assert.deepEqual([...resolveRatings({})], [0]);
  // 标签兜底：xRestrict=1 + R-18G 标签 ⇒ R18G
  assert.equal(ratingOf(items[2]), 2);
  assert.equal(ratingOf(items[1]), 1);
});

test('normalizeRatingTokens：中文「全年龄/R18」也认，规范顺序，脏值丢掉', () => {
  assert.deepEqual(normalizeRatingTokens('全年龄,R18'), ['safe', 'r18']);
  assert.deepEqual(normalizeRatingTokens(['R18G', '全年龄']), ['safe', 'r18g']);
  assert.deepEqual(normalizeRatingTokens('r18g r18 safe'), ['safe', 'r18', 'r18g']);
  assert.deepEqual(normalizeRatingTokens('R-18'), ['r18']);
  assert.deepEqual(normalizeRatingTokens('猎奇'), ['r18g']);
  // ⚠️ 原型链上的键不算有效取值（否则一个乱写的值就能往集合里塞个函数）
  assert.deepEqual(normalizeRatingTokens('constructor'), []);
  assert.deepEqual(normalizeRatingTokens('__proto__'), []);
  assert.deepEqual(normalizeRatingTokens(''), []);
  assert.deepEqual(normalizeRatingTokens(null), []);
});

test('pickUnseen：跳过已发、按收藏数降序、从前 N 随机、全发过返回 null', () => {
  const items = [
    { pid: 'a', bookmarks: 10 },
    { pid: 'b', bookmarks: 500 },
    { pid: 'c', bookmarks: 300 },
    { pid: 'd', bookmarks: NaN },
    { pid: 'e', bookmarks: 50 }
  ];
  // 已发过的 a、b 要被跳过
  const seen = new Set(['a', 'b']);
  assert.equal(pickUnseen(items, seen, 5, () => 0).pid, 'c');        // 剩下的最高收藏
  assert.equal(pickUnseen(items, seen, 2, () => 0.999).pid, 'e');    // 前 2 里随机取第 2 个
  assert.equal(pickUnseen(items, seen, 2, () => 0).pid, 'c');
  // 收藏数缺失（NaN）排在最后
  assert.equal(pickUnseen(items, new Set(['a', 'b', 'c', 'e']), 5, () => 0).pid, 'd');
  // 全发过 → null
  assert.equal(pickUnseen(items, new Set(items.map((x) => x.pid)), 5), null);
  assert.equal(pickUnseen([], new Set(), 5), null);
});

test('buildTryList：备选张数 = need + extra，且已发/已拉黑的 pid 不进队列', () => {
  const items = ['1', '2', '3', '4', '5', '6'].map((pid, i) => ({ pid, bookmarks: 100 - i }));
  const list = buildTryList(items, new Set(), 2, 1, 3, () => 0);
  assert.equal(list.length, 4);                       // 1 张要发的 + 3 张备选
  assert.deepEqual([...new Set(list.map((x) => x.pid))].length, list.length);   // 不重复
  assert.equal(buildTryList(items, new Set(), 2, 2, 1, () => 0).length, 3);
  // 池子比 need+extra 小就只给池子里的
  assert.equal(buildTryList(items.slice(0, 2), new Set(), 2, 1, 3, () => 0).length, 2);
  // 全被排除 → 空
  assert.deepEqual(buildTryList(items, new Set(items.map((x) => x.pid)), 2, 1, 3, () => 0), []);
});

test('extractPid：从各种 pixiv 链接里抠 pid', () => {
  assert.equal(extractPid('https://www.pixiv.net/artworks/12345678'), '12345678');
  assert.equal(extractPid('https://www.pixiv.net/i/12345678'), '12345678');
  assert.equal(extractPid('https://www.pixiv.net/member_illust.php?mode=medium&illust_id=12345678'), '12345678');
  assert.equal(extractPid('https://pixiv.re/12345678.png'), '12345678');
  assert.equal(extractPid('https://i.pixiv.re/12345678.jpg'), '12345678');
  assert.equal(extractPid('https://i.pximg.net/img-original/img/2024/01/02/03/04/05/12345678_p0_master1200.jpg'), '12345678');
  assert.equal(extractPid('12345678'), '12345678');
  assert.equal(extractPid(12345678), '12345678');
  // 认不出来就返回空串（不猜）
  assert.equal(extractPid(''), '');
  assert.equal(extractPid('嗯，来张图'), '');
  assert.equal(extractPid('https://example.com/abc'), '');
  assert.equal(extractPid('1234'), '');                        // 太短：不像 PID
  assert.equal(extractPid('12345678 和 87654321'), '');        // 多个数字：不猜
});

test('ownerIdSet：逗号 / 中文逗号 / 顿号 / 空格都当分隔符，旧字段 adminIds 兼容', () => {
  assert.deepEqual([...ownerIdSet({ ownerIds: '1,2' })], ['1', '2']);
  assert.deepEqual([...ownerIdSet({ ownerIds: '1，2' })], ['1', '2']);
  assert.deepEqual([...ownerIdSet({ ownerIds: '1、2 3' })], ['1', '2', '3']);
  assert.deepEqual([...ownerIdSet({ ownerIds: ' 1 ,, 2 ' })], ['1', '2']);
  // ownerIds 为空时回落到旧字段
  assert.deepEqual([...ownerIdSet({ ownerIds: '', adminIds: '9' })], ['9']);
  assert.deepEqual([...ownerIdSet({ adminIds: '9' })], ['9']);
  assert.deepEqual([...ownerIdSet({})], []);
  assert.deepEqual([...ownerIdSet()], []);
  // DEFAULTS 里**刻意留空**：原作者那份把默认值写成了他自己的号（2624585744），
  // 照搬的实际效果是"你的号改不了分级、而一个陌生人的号可以改"。分级意味着"可能往某个群
  // 发成人内容"，这个决定只该由使用者自己做 —— 没填就谁也改不了。
  assert.deepEqual([...ownerIdSet(internals.DEFAULTS)], [],
    'ownerIds 默认必须是空的，不许兜任何具体 QQ 号');
});

test('resolveProxyUrl：设置优先，留空回退环境变量', () => {
  assert.equal(resolveProxyUrl({ proxyUrl: 'http://127.0.0.1:7890' }, {}), 'http://127.0.0.1:7890');
  assert.equal(resolveProxyUrl({}, { HTTPS_PROXY: 'http://a:1' }), 'http://a:1');
  assert.equal(resolveProxyUrl({}, { all_proxy: 'http://b:2' }), 'http://b:2');
  assert.equal(resolveProxyUrl({ proxyUrl: '  ' }, {}), '');
  assert.equal(resolveProxyUrl({}, {}), '');
  // 设置里的值优先于环境变量
  assert.equal(resolveProxyUrl({ proxyUrl: 'http://cfg:1' }, { HTTPS_PROXY: 'http://env:2' }), 'http://cfg:1');
});

// ── ② latestCaller / callerMayChangeRating ────────────────────────────────

test('latestCaller：取最近一条别人发的消息；只有自己说过 / 取不到时返回空 callerId', () => {
  const ctx = {
    chatKey: 'group:12345',
    recent: (limit) => {
      assert.equal(limit, 6, '门面的 recent(limit) 要按原版语义传 6');
      return [
        { senderId: '7', senderName: '阿花', self: false, text: '早' },
        { senderId: '999', senderName: '小鲸鱼', self: true, text: '（我自己说的）' },
        { senderId: '8', senderName: '小刚', self: false, text: '来张初音ミク的图' }
      ];
    }
  };
  const caller = latestCaller(ctx);
  assert.equal(caller.callerId, '8');       // 最近一条**别人**发的，跳过 self:true
  assert.equal(caller.callerName, '小刚');

  // 本会话只有机器人自己说过话 → 认不出调用者（宁可拒改）
  assert.deepEqual(latestCaller({ recent: () => [{ senderId: '999', self: true }] }), { callerId: '', callerName: '' });
  // 没有 recent 能力（没声明 chat:read）→ 空
  assert.deepEqual(latestCaller({ chatKey: 'group:1' }), { callerId: '', callerName: '' });
  // recent 抛错也不能把工具带崩
  assert.deepEqual(latestCaller({ recent: () => { throw new Error('宿主消息存储不可用'); } }), { callerId: '', callerName: '' });
  assert.deepEqual(latestCaller(null), { callerId: '', callerName: '' });
});

test('callerMayChangeRating：主人在名单里 → 放行；不在名单且没有 api.capability → 拒绝并给出原因', async () => {
  const ownerCtx = { recent: () => [{ senderId: '10001', senderName: '主人', self: false }] };
  const allowed = await callerMayChangeRating(ownerCtx, { ownerIds: '10001,10002' });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.callerId, '10001');
  assert.equal(allowed.how, '在「主人 QQ」名单里');

  const strangerCtx = { recent: () => [{ senderId: '55555', senderName: '路人', self: false }] };
  const denied = await callerMayChangeRating(strangerCtx, { ownerIds: '10001' });
  assert.equal(denied.ok, false);
  assert.equal(denied.callerId, '55555');
  assert.match(denied.reason, /只有主人能改/);
  // 本宿主没有"主人识别"插件：文案要照实说，别让人以为装了就有
  assert.match(denied.reason, /主人识别/);
  assert.equal(pluginApi.capability, undefined, '本项目的 api 上没有 capability 成员');

  // 认不出说话人 → 一律不放行
  const unknown = await callerMayChangeRating({ recent: () => [] }, { ownerIds: '10001' });
  assert.equal(unknown.ok, false);
  assert.match(unknown.reason, /没能确认是谁在说话/);

  // 默认（不给设置）时**谁都不能改**：ownerIds 刻意留空。这条是安全口径 ——
  // 原作者的默认值是他自己的号，照搬会让一个陌生人的号有权改分级。
  const nobody = await callerMayChangeRating(
    { recent: () => [{ senderId: '2624585744', self: false }] }, internals.DEFAULTS
  );
  assert.equal(nobody.ok, false, '默认留空时，连原作者那个号也不该放行');
  assert.match(nobody.reason, /只有主人能改/);
  // 填上自己的号之后才放行 —— README §2 要求的那一步
  const mineNow = await callerMayChangeRating(
    { recent: () => [{ senderId: '2624585744', self: false }] },
    { ...internals.DEFAULTS, ownerIds: '2624585744' }
  );
  assert.equal(mineNow.ok, true);
});

// ── ③ internals 的 seam ───────────────────────────────────────────────────

test('internals：状态文件写在注入的状态目录里，PID 索引能落盘并读回，超上限按时间淘汰', () => {
  const dir = mkTemp('qq-pixiv-state-');
  internals.__setStateDir(dir);
  assert.equal(internals.__stateDir(), dir);
  assert.equal(internals.__stateFile(), path.join(dir, 'state.json'));
  assert.equal(internals.__chatRatingsFile(), path.join(dir, 'chat-ratings.json'));

  internals.__setState([], []);
  internals.__markSeen('12345678', 1000);
  internals.__markDead('87654321', 2000);
  const written = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  assert.equal(written.seen['12345678'], 1000);
  assert.equal(written.dead['87654321'], 2000);
  // 生效中的拉黑集合（deadTtlDays 默认 7 天，用 now=2001 一定还在）
  assert.deepEqual([...deadSet(2001)], ['87654321']);

  // 清空内存后重新读盘 —— 证明它是真的落盘了，不是只改了内存
  internals.__setState([], []);
  internals.__loadState();
  assert.deepEqual([...internals.__getSeen().keys()], ['12345678']);
  assert.deepEqual([...internals.__getDead().keys()], ['87654321']);

  // 发送成功会撤掉拉黑（同一个 pid 之前取不到、这次取到了）
  internals.__markSeen('87654321', 3000);
  assert.equal(internals.__getDead().has('87654321'), false);

  // 超出 stateCap（默认 2000）时按时间戳淘汰最旧的
  const many = [];
  for (let i = 0; i < 2001; i += 1) many.push([String(10000000 + i), 1000 + i]);
  internals.__setState(many, []);
  internals.__saveState();
  assert.equal(internals.__getSeen().size, 2000);
  assert.equal(internals.__getSeen().has('10000000'), false, '最旧的那条应被淘汰');
  assert.equal(internals.__getSeen().has('10002000'), true, '最新的那条要留着');

  // 没有状态目录时**绝不落盘**（否则 path.dirname('') === '.'，会写进进程的 cwd）
  internals.__setStateDir('');
  internals.__setState([], []);
  assert.equal(internals.__markSeen('1', 1), undefined);
  assert.equal(fs.existsSync(path.join(process.cwd(), 'state.json')), false);
  // 临时图片目录也在状态目录之下，没有状态目录就没法建
  assert.throws(() => internals.__tempDir(), /状态目录还没初始化/);
});

test('internals：按会话分级写在状态目录的 chat-ratings.json 里，坏条目只忽略不炸', () => {
  const dir = mkTemp('qq-pixiv-ratings-');
  internals.__setStateDir(dir);
  internals.__resetChatRatingsCache();
  assert.equal(internals.__chatRatingsFile(), path.join(dir, 'chat-ratings.json'));

  assert.deepEqual(internals.setChatRating('group:123', ['safe', 'r18']), { ok: true, tokens: ['safe', 'r18'] });
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'chat-ratings.json'), 'utf8'));
  assert.deepEqual(raw, { 'group:123': ['safe', 'r18'] });
  assert.deepEqual(internals.chatRatingOf('group:123'), ['safe', 'r18']);
  assert.equal(internals.chatRatingOf('group:999'), null);

  // 覆盖优先于全局：全局只允许 safe，本会话放宽到 r18
  const eff = ratingsForChat('group:123', { ratings: ['safe'] });
  assert.equal(eff.source, 'chat');
  assert.deepEqual(eff.tokens, ['safe', 'r18']);
  assert.deepEqual([...eff.allowed].sort(), [0, 1]);

  // 坏条目（不认识的取值）只忽略那一条并告警，别的会话照常
  fs.writeFileSync(path.join(dir, 'chat-ratings.json'), JSON.stringify({ 'group:123': ['safe'], 'group:456': ['不存在'] }), 'utf8');
  internals.__resetChatRatingsCache();
  assert.deepEqual(Object.keys(internals.loadChatRatings()), ['group:123']);

  // 清除覆盖 → 回落全局
  internals.__resetChatRatingsCache();
  assert.deepEqual(internals.setChatRating('group:999', ['r18g']), { ok: true, tokens: ['r18g'] });
  assert.deepEqual(internals.clearChatRating('group:999'), { ok: true, had: true });
  assert.equal(ratingsForChat('group:999', { ratings: ['safe'] }).source, 'global');
  // 没给有效分级时明确报错，而不是静默存个空
  assert.equal(internals.setChatRating('group:1', []).ok, false);
  assert.equal(internals.setChatRating('', ['safe']).ok, false);
});

test('describeFetchError：超时与代理不可用给出可读文案，别的错误原样返回', () => {
  const timeout = describeFetchError(new Error('This operation was aborted'), 15000, 'http://127.0.0.1:7890', 'https://www.pixiv.net/ajax/x');
  assert.match(timeout, /请求超时：15 秒内没有任何响应/);
  assert.match(timeout, /已走代理 http:\/\/127\.0\.0\.1:7890/);
  assert.match(timeout, /（www\.pixiv\.net）/);
  assert.match(timeout, /大陆直连 pixiv 不通/);

  const refused = describeFetchError(new Error('connect ECONNREFUSED 127.0.0.1:7890'), 15000, 'http://127.0.0.1:7890', 'https://api.lolicon.app/setu/v2');
  assert.match(refused, /连接失败/);
  assert.match(refused, /代理没开、端口写错/);
  assert.match(refused, /（api\.lolicon\.app）/);
  // 谁不通就说谁：第三方接口不能套 pixiv 的那句原因
  assert.doesNotMatch(refused, /大陆直连 pixiv/);

  // 同一个错误、不同目标：pixiv 会给出"需要代理"，第三方接口给的是另一个原因
  const thirdParty = describeFetchError(new Error('This operation was aborted'), 20000, '', 'https://api.lolicon.app/setu/v2');
  assert.match(thirdParty, /请求超时：20 秒内没有任何响应/);
  assert.match(thirdParty, /这个接口连不上/);
  assert.match(thirdParty, /（当前是直连）/);
  assert.doesNotMatch(thirdParty, /大陆直连 pixiv/);

  const dns = describeFetchError(new Error('getaddrinfo ENOTFOUND www.pixiv.net'), 15000, '', 'https://www.pixiv.net/x');
  assert.match(dns, /域名解析失败/);
  assert.match(dns, /DNS 可能被污染/);
  assert.match(dns, /（当前是直连）/);

  // 不是连接类错误就原样返回
  assert.equal(describeFetchError(new Error('api.lolicon.app HTTP 403')), 'api.lolicon.app HTTP 403');
});

test('internals：熔断与 pixiv.net 直连冷却的状态机', () => {
  internals.__resetBreaker();
  assert.deepEqual(breakerState(1000), { open: false, retryAfterSec: 0, streak: 0 });
  internals.__noteNetFailure(1000);
  internals.__noteNetFailure(1001);
  assert.equal(breakerState(1002).open, false);
  internals.__noteNetFailure(1003);                 // 第 3 次连接级失败 → 熔断
  const open = breakerState(1004);
  assert.equal(open.open, true);
  assert.ok(open.retryAfterSec > 0);
  // 冷却 5 分钟，之后自动恢复
  assert.equal(breakerState(1004 + 5 * 60 * 1000 + 1).open, false);
  internals.__resetBreaker();
  assert.equal(internals.pixivDirectCoolingDown(1000), false);
  internals.__setPixivDirectFailAt(2000);
  assert.equal(internals.pixivDirectCoolingDown(2001), true);
  assert.equal(internals.pixivDirectCoolingDown(2000 + 10 * 60 * 1000 + 1), false);
  internals.__resetBreaker();
});

// ── ④ 门面契约 ────────────────────────────────────────────────────────────

test('activate：注册的工具名与 manifest.tools 完全相等（多一个少一个都会被装载器拒绝）', () => {
  assert.deepEqual([...registered.keys()].sort(), pluginToolNames);
  assert.deepEqual(pluginToolNames, ['pixiv_image', 'pixiv_set_rating']);
  // 每个工具都得有 description / parameters / execute —— 装载器的 registerTool 会逐条校验
  for (const [name, def] of registered) {
    assert.ok(String(def.description || '').trim().length > 0, `${name} 缺少 description`);
    assert.equal(def.parameters.type, 'object');
    assert.equal(typeof def.execute, 'function');
  }
  // 移植要求：模型看到的函数名用原来的 id，name/category/icon 不再传
  assert.equal(registered.has('pixiv_image'), true);
  assert.equal(registered.has('set_rating'), false, '工具名必须是全宿主唯一的 pixiv_set_rating');
  // 分级那段"教模型"的指令（原 manifest 的 prompt.sections）折进了工具描述
  assert.match(registered.get('pixiv_set_rating').description, /按会话/);
  assert.match(registered.get('pixiv_set_rating').description, /只有主人能改/);
  assert.match(registered.get('pixiv_set_rating').description, /不要.*假装改/);
  // 入口还返回了 deactivate（宿主在同进程重载/退出时调）
  assert.equal(typeof pluginReturned.deactivate, 'function');
  // 原宿主那个探测钩子保留了，但本宿主不会调它
  assert.deepEqual(available(), { ok: true });
});

test('activate 的 stateDir 就是 api.kv.dir（<数据目录>/plugin-state/pixiv-illust）', async () => {
  // 重跑一次 activate：上面的 seam 用例把模块状态目录指到自己的临时目录了，
  // 这里顺便验证"重新激活会把目录指回来"（stateLoaded / chatRatingsCache 都会跟着作废）。
  await activate(pluginApi);
  assert.equal(pluginApi.kv.dir, pluginStateDir(dataDir, 'pixiv-illust'));
  assert.equal(pluginApi.stateDir, pluginApi.kv.dir);
  assert.equal(internals.__stateDir(), pluginApi.kv.dir);
  assert.equal(internals.__stateFile(), path.join(pluginApi.kv.dir, 'state.json'));
  // 没声明 storage 时必须抛错（不假装能持久化），而不是静默记在内存里
  const bare = buildPluginApi({
    manifest: { ...manifest, capabilities: ['chat:read'] },
    config: CONFIG,
    dataDir,
    registerTool: () => {}
  });
  assert.equal(bare.kv, undefined);
  await assert.rejects(() => activate(bare), /缺少 storage 能力/);
  await activate(pluginApi);   // 恢复给后面的用例
});

test('门面收窄：toolCtx 上只有声明过的能力，原始 ctx 的 sender/store/emit 一个都没泄漏', () => {
  const { ctx } = fakeHostCtx();
  const toolCtx = makeToolCtx(ctx);

  assert.equal(toolCtx.chatKey, 'group:12345');
  assert.deepEqual([...toolCtx.capabilities].sort(), manifest.capabilities);
  assert.equal(typeof toolCtx.sendImage, 'function');
  assert.equal(typeof toolCtx.recent, 'function');
  assert.equal(typeof toolCtx.kv.get, 'function');
  assert.equal(toolCtx.dir, pluginStateDir(dataDir, 'pixiv-illust'));
  // 这些一律不许出现：插件改宿主状态机的入口全在这儿
  for (const key of ['sender', 'store', 'memory', 'onebot', 'emit']) {
    assert.equal(toolCtx[key], undefined, `${key} 泄漏给了插件`);
  }
  assert.equal(toolCtx.session.leaseId, undefined, 'session 只给 {id, rounds} 快照');
  // recent 给的是投影后的对象（带 self 布尔），latestCaller 依赖它
  const entries = toolCtx.recent(5);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].self, false);
  assert.equal(entries[0].senderId, '10001');
});

test('临时图片必须落在插件状态目录之内（否则门面的 sendImage 路径守卫会拒发）', async () => {
  const { ctx, images } = fakeHostCtx();
  const toolCtx = makeToolCtx(ctx);

  // 把插件的状态目录指到门面认的那个（activate 已经指过一次，这里显式再说一次）
  internals.__setStateDir(toolCtx.dir);
  const tmp = internals.__tempDir();
  const rel = path.relative(toolCtx.dir, tmp);
  assert.equal(rel.startsWith('..'), false, `临时目录越出了状态目录：${tmp}`);
  assert.equal(path.isAbsolute(rel), false);
  assert.equal(fs.existsSync(tmp), true);

  // 状态目录之内的文件能发出去，且走的是 base64:// 约定（本地图片）
  const file = path.join(tmp, 'pixiv_test.png');
  fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const sent = await toolCtx.sendImage({ path: file }, { label: 'Pixiv 12345678 · 标题 · 作者' });
  assert.equal(sent.sent, true);
  assert.equal(images.length, 1);
  assert.equal(images[0].chatKey, 'group:12345');
  assert.match(images[0].payload.url, /^base64:\/\//);
  assert.equal(images[0].payload.label, 'Pixiv 12345678 · 标题 · 作者');

  // 而状态目录之外的文件（宿主自己的 config.json 就是最典型的例子）必须被拒 ——
  // 这条守卫正是"临时图片不能落在 os.tmpdir()"的原因。
  const outside = path.join(dataDir, 'config.json');
  fs.writeFileSync(outside, JSON.stringify({ secret: 'sk-should-never-be-sent' }), 'utf8');
  await assert.rejects(() => toolCtx.sendImage({ path: outside }, {}), /只接受插件自己状态目录里的文件/);
  assert.equal(images.length, 1, '被拒绝的调用不能真的发出图片');

  // 收尾：清理逻辑原样保留（把 mtime 改成 16 分钟前，sweep 应该把它删掉）
  const stale = path.join(tmp, 'stale.png');
  fs.writeFileSync(stale, 'x');
  const old = Date.now() - 16 * 60 * 1000;
  fs.utimesSync(stale, new Date(old), new Date(old));
  internals.__sweepTemp();
  assert.equal(fs.existsSync(stale), false, '超过 15 分钟的临时图应被清掉');
  assert.equal(fs.existsSync(file), true, '刚写的那张要留着（还要发）');
});

test('装载器全流程：带审批 initPlugins → loaded，注入的工具与 manifest 声明完全相等', async () => {
  // 这一条是"acceptance 第 5 步"的固化版：走真正的发现 / 审批比对 / 动态 import /
  // activate / 工具集相等校验。manifest 非法或注册的工具多于/少于声明，这里都会是 failed。
  const result = await initPlugins({
    dataDir,
    config: {
      plugins: {
        roots: [path.join(REPO, 'plugins')],
        enabled: ['pixiv-illust'],
        approved: { 'pixiv-illust': manifestFingerprint(manifest) },
        settings: {}
      }
    },
    builtinToolNames: ['send_message', 'send_sticker', 'web_fetch', 'finish', 'remind'],
    bundledRoot: null
  });
  const status = result.statuses.find((item) => item.id === 'pixiv-illust');
  assert.ok(status, '装载器应该发现 plugins/pixiv-illust');
  assert.equal(status.status, 'loaded', `期望 loaded，实际 ${status.status}：${status.reason}`);
  assert.deepEqual(status.capabilities, ['chat:read', 'chat:send-image', 'http', 'storage']);
  assert.deepEqual(status.tools, ['pixiv_image', 'pixiv_set_rating']);
  assert.deepEqual(result.toolDefs.map((def) => def.name).sort(), pluginToolNames);
  // 随版本分发的另一个插件（hello）也在同一个根里，未启用就是 disabled
  assert.equal(result.statuses.find((item) => item.id === 'hello').status, 'disabled');
  await resetPlugins();
});
