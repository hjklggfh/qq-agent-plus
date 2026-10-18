import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const cacheKey = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validKey = (key) => /^[a-f0-9]{64}$/.test(key);
function digest(file) {
  const hash = createHash('sha256'), buffer = Buffer.alloc(65536);
  const fd = fs.openSync(file, 'r');
  try { let count; while ((count = fs.readSync(fd, buffer)) > 0) hash.update(buffer.subarray(0, count)); }
  finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

// Optional generated-file cache. It never owns settings, history or ratings.
export class PixivFileCache {
  constructor(root, getSettings, clock = Date.now) {
    this.root = path.resolve(root); this.getSettings = getSettings; this.clock = clock;
  }
  ensure() {
    if (fs.existsSync(this.root) && fs.lstatSync(this.root).isSymbolicLink()) throw new Error('Cache root is a symlink');
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.root, 0o700);
  }
  drop(key) {
    if (!validKey(key) || fs.existsSync(this.root) && fs.lstatSync(this.root).isSymbolicLink()) return;
    const dir = path.join(this.root, key);
    if (fs.existsSync(dir) && !fs.lstatSync(dir).isSymbolicLink()) fs.rmSync(dir, { recursive: true, force: true });
  }
  entry(key) {
    if (!validKey(key)) return null;
    const dir = path.join(this.root, key), file = path.join(dir, 'data');
    if (!fs.existsSync(dir) || fs.lstatSync(dir).isSymbolicLink()) return null;
    const metaFile = path.join(dir, 'meta.json');
    if (fs.lstatSync(metaFile).isSymbolicLink() || fs.statSync(metaFile).size > 65536
      || fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile()) throw new Error('Invalid cache files');
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    const s = this.getSettings();
    if (meta.version !== 1 || !Number.isFinite(meta.createdAt) || meta.createdAt > this.clock() + 60000
      || this.clock() - meta.createdAt >= s.cacheTtlHours * 3600000
      || meta.bytes !== fs.statSync(file).size || meta.bytes < 1 || !validKey(meta.digest)) throw new Error('Expired or invalid cache');
    return { key, file, meta, bytes: meta.bytes + fs.statSync(metaFile).size };
  }
  sweep(reserve = 0) {
    try {
      if (!fs.existsSync(this.root)) return { bytes: 0, entries: 0 };
      this.ensure(); const rows = [];
      for (const key of fs.readdirSync(this.root)) {
        if (key.startsWith('tmp-')) {
          const dir = path.join(this.root, key);
          if (!fs.lstatSync(dir).isSymbolicLink()) fs.rmSync(dir, { recursive: true, force: true });
        } else if (validKey(key)) {
          try { const row = this.entry(key); if (row) rows.push(row); } catch { this.drop(key); }
        }
      }
      let bytes = rows.reduce((sum, row) => sum + row.bytes, 0), entries = rows.length;
      for (const row of rows.sort((a, b) => a.meta.createdAt - b.meta.createdAt)) {
        if (bytes + reserve <= this.getSettings().cacheMaxBytes) break;
        this.drop(row.key); bytes -= row.bytes; entries--;
      }
      return { bytes, entries };
    } catch { return { bytes: 0, entries: 0 }; }
  }
  get(key, output, maxBytes) {
    if (!this.getSettings().cacheEnabled) return null;
    try {
      this.ensure(); const row = this.entry(key);
      if (!row) return null;
      if (row.meta.bytes > maxBytes || digest(row.file) !== row.meta.digest) throw new Error('Invalid cached content');
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.copyFileSync(row.file, output); fs.chmodSync(output, 0o600);
      return { ...row.meta.info, file: output, bytes: row.meta.bytes };
    } catch { try { this.drop(key); } catch { /* Cache misses never stop the task. */ } return null; }
  }
  put(key, file, info = {}) {
    if (!validKey(key) || !this.getSettings().cacheEnabled) return false;
    let tmp;
    try {
      this.ensure(); const bytes = fs.statSync(file).size;
      const meta = JSON.stringify({ version: 1, bytes, digest: digest(file), createdAt: this.clock(), info });
      const reserve = bytes + Buffer.byteLength(meta);
      if (bytes < 1 || meta.length > 65536 || reserve > this.getSettings().cacheMaxBytes) return false;
      this.drop(key); this.sweep(reserve);
      tmp = fs.mkdtempSync(path.join(this.root, 'tmp-')); fs.chmodSync(tmp, 0o700);
      fs.copyFileSync(file, path.join(tmp, 'data')); fs.chmodSync(path.join(tmp, 'data'), 0o600);
      fs.writeFileSync(path.join(tmp, 'meta.json'), meta, { mode: 0o600 });
      fs.renameSync(tmp, path.join(this.root, key)); return true;
    } catch { return false; }
    finally { try { if (tmp && fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Optional cache. */ } }
  }
  clear() {
    try { this.ensure(); for (const key of fs.readdirSync(this.root)) this.drop(key); } catch { /* Optional cache. */ }
    return this.sweep();
  }
}
