// 插件持久化存储（capability: storage）。
//
// 落点故意与插件代码目录**分开**：
//     <数据目录>/plugin-state/<插件 id>/kv.json
// 插件代码在 data/plugins/<id>/，升级时人会用新版本整目录替换掉它；状态放在同级
// 会让"换个版本"顺手把插件攒的数据也换没。两个目录都在数据目录下，因此都享受
// deploy.sh 的 rsync 排除（升级不冲）与 .gitignore（不进版本库）。
//
// 一致性口径：这里是**单进程内的整文件读改写**，没有跨进程锁。宿主只有一个应用进程会写它
// （updater 与 ops.js 都不碰插件状态），所以不存在 auto-update.json 那类跨进程覆盖问题。
// 写入本身是原子的（tmp + rename + 0600），进程被杀最多丢掉最后一次未落盘的写入。
import fs from 'node:fs';
import path from 'node:path';

/** 键名允许的字符集。限制字符集是为了让键能安全地出现在日志与状态页里。 */
export const KV_KEY_PATTERN = /^[a-zA-Z0-9_.:-]{1,64}$/;
export const MAX_KV_KEYS = 200;
export const MAX_KV_VALUE_BYTES = 32 * 1024;
export const MAX_KV_FILE_BYTES = 512 * 1024;

export class PluginStorageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PluginStorageError';
  }
}

function fail(message) {
  throw new PluginStorageError(message);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 插件状态目录。
 *
 * `pluginId` 已经在 manifest 校验里被限成 `^[a-z][a-z0-9-]{1,38}$`，因此它不可能含
 * 路径分隔符或 `..`。这里仍然再断言一次：这个函数也会被直接调用（例如控制台清状态），
 * 不能把"调用方一定校验过"当成前提。
 */
export function pluginStateDir(dataDir, pluginId) {
  const id = String(pluginId ?? '');
  if (!/^[a-z][a-z0-9-]{1,38}$/.test(id)) {
    fail(`插件 id 不合法，拒绝据此拼接状态目录：${JSON.stringify(id)}`);
  }
  return path.join(String(dataDir), 'plugin-state', id);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** 原子写：先写同目录 tmp，再 rename，最后 chmod 兜底（btrfs 会丢 mode）。 */
export function atomicWriteFile(file, text, { mode = 0o600 } = {}) {
  const dir = path.dirname(file);
  ensureDir(dir);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, text, { mode, flush: true });
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 清理失败不掩盖原始错误 */ }
    throw error;
  }
  try { fs.chmodSync(file, mode); } catch { /* btrfs 丢 mode 的兜底，不影响内容 */ }
}

/**
 * 一个插件的键值存储。惰性读盘：只有真的调 get/set/list 时才碰磁盘，
 * 因此"插件启用了但从没用过存储"不会凭空建目录（实验特性规范里
 * "从未启用的模块不该因为进程启动就创建自己的可变状态"是同一条口径）。
 */
export class PluginKvStore {
  constructor({ dataDir, pluginId }) {
    this.dataDir = String(dataDir);
    this.pluginId = String(pluginId);
    this.dir = pluginStateDir(this.dataDir, this.pluginId);
    this.file = path.join(this.dir, 'kv.json');
    this.loaded = false;
    this.data = {};
    this.brokenBackup = '';
  }

  /** 真实路径（插件可写自己的额外文件）。用属性不用方法，插件里写成 kv.dir 更自然。 */
  get stateDir() {
    return this.dir;
  }

  #load() {
    if (this.loaded) return;
    this.loaded = true;
    this.data = {};
    let text = '';
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch {
      return;   // 首次使用：文件还不存在
    }
    try {
      const parsed = JSON.parse(text);
      // 顶层不是对象（被手工改成数组/标量）按"空"处理，并把原件留一份 —— 与 config.json
      // 读坏时的做法一致：宁可空着让人看见备份，也不要静默把内容当合法状态用下去。
      if (isPlainObject(parsed)) this.data = parsed;
      else this.brokenBackup = this.#backupBroken(text);
    } catch {
      this.brokenBackup = this.#backupBroken(text);
    }
  }

  #backupBroken(text) {
    const backup = `${this.file}.broken-${Date.now()}`;
    try {
      ensureDir(this.dir);
      fs.writeFileSync(backup, text, { mode: 0o600 });
      return backup;
    } catch {
      return '';
    }
  }

  /** 把给定快照落盘。传参而不是读 this.data：调用方要能"先落盘成功、再提交内存"。 */
  #flush(snapshot) {
    const text = JSON.stringify(snapshot, null, 2);
    if (Buffer.byteLength(text, 'utf8') > MAX_KV_FILE_BYTES) {
      fail(`存储超过上限 ${MAX_KV_FILE_BYTES} 字节，写入被拒绝（先删掉一些键）`);
    }
    atomicWriteFile(this.file, text);
  }

  #assertKey(key) {
    const name = String(key ?? '');
    if (!KV_KEY_PATTERN.test(name)) {
      fail(`键名不合法：${JSON.stringify(name)}（只允许字母/数字/下划线/点/冒号/短横线，长度 1~64）`);
    }
    return name;
  }

  get(key) {
    const name = this.#assertKey(key);
    this.#load();
    if (!Object.prototype.hasOwnProperty.call(this.data, name)) return null;
    // 深拷贝：交给插件的**绝不能是内部对象本身**。浅返回的话插件一句
    // `kv.get('cfg').mode = 'x'` 就改了内存态而没落盘 —— 之后任何一次 set 都会把这个
    // "没存过的值"顺手写进磁盘（和"先改内存再落盘"是同一类静默分叉，见 set 的注释）。
    // 单值上限 32KB，克隆成本可忽略。
    return structuredClone(this.data[name]);
  }

  set(key, value) {
    const name = this.#assertKey(key);
    this.#load();
    let encoded = '';
    try {
      encoded = JSON.stringify(value);
    } catch (error) {
      fail(`值无法序列化成 JSON：${error?.message ?? error}`);
    }
    if (encoded === undefined) {
      fail('值无法序列化成 JSON（undefined/函数/Symbol 都不行）');
    }
    const bytes = Buffer.byteLength(encoded, 'utf8');
    if (bytes > MAX_KV_VALUE_BYTES) {
      fail(`单个值超过上限 ${MAX_KV_VALUE_BYTES} 字节（实际 ${bytes}）`);
    }
    const next = { ...this.data, [name]: value };
    if (Object.keys(next).length > MAX_KV_KEYS) {
      fail(`键数量超过上限 ${MAX_KV_KEYS}`);
    }
    // **先落盘、成功了才改内存**。反过来（先改内存再 flush）在一个被上限拒绝的写入上会分叉：
    // 插件随后 get() 读到自己刚写的值、以为存住了，而磁盘上根本没有 —— 重启即静默丢失。
    this.#flush(next);
    this.data = next;
    return true;
  }

  delete(key) {
    const name = this.#assertKey(key);
    this.#load();
    if (!Object.prototype.hasOwnProperty.call(this.data, name)) return false;
    const next = { ...this.data };
    delete next[name];
    this.#flush(next);   // 同上：先落盘再提交内存
    this.data = next;
    return true;
  }

  /** 键名列表（不含值），方便插件分页展示。 */
  list() {
    this.#load();
    return Object.keys(this.data).sort();
  }

  /**
   * 整份快照（深拷贝）。
   *
   * 明确是**深**拷贝：浅拷贝（`{...this.data}`）只挡住"换掉顶层某个键"，挡不住
   * `kv.all().nested.x = 1` 这种就地改 —— 那同样会改到内存态而不落盘。
   */
  all() {
    this.#load();
    return structuredClone(this.data);
  }

  /** 当前占用的字节数（不含格式化缩进），给控制台显示用。 */
  sizeBytes() {
    this.#load();
    return Buffer.byteLength(JSON.stringify(this.data), 'utf8');
  }

  /** 最后写入时间；文件不存在返回 0。 */
  updatedAt() {
    try {
      return fs.statSync(this.file).mtimeMs;
    } catch {
      return 0;
    }
  }
}
