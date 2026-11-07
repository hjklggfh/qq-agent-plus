import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from '../core/config.js';

// 记忆根目录由调用方给出：主实例用 DATA_DIR/memory（缺省），第二人设实例用
// DATA_DIR/memory-alt —— 快照也必须跟着各自的根目录走，否则两套记忆的备份会混在一个目录里。
const DEFAULT_MEMORY_ROOT = path.join(DATA_DIR, 'memory');
const chatDirName = (chatKey) => String(chatKey || '').replace(/[^a-z0-9_]/gi, '_');

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1), { encoding: 'utf8', mode: 0o600, flush: true });
  fs.renameSync(tmp, file);
  // rename 后显式 chmod：btrfs（部分 NAS）上 writeFileSync 的 mode 会丢失（Issue #11）
  fs.chmodSync(file, 0o600);
}

/**
 * 在人物长期记忆被 consolidation 覆写前保存完整全局快照。
 *
 * 新路径按人物保存不可覆盖的历史（目录键与成员文件名同源）：
 *   memory/backups/consolidation/<QQ | u_<id> | _n_<名字>>/<timestamp>-<uuid>.json
 *
 * 同时保留旧的“当前会话最近一次整理前快照”路径：
 *   memory/backups/<group_...|private_...>/<同上键>.json
 * 这份兼容副本允许旧管理工具继续读取，但真正的历史审计以新路径为准。
 */
const KEEP_PER_PERSON = 20;

export function backupPersonBeforeConsolidation(person, {
  sourceChatKey = '',
  at = Date.now(),
  reason = 'consolidation',
  root = ''
} = {}) {
  const userId = String(person?.userId || '').trim();
  const name = String(person?.name || '').trim();
  const impressions = Array.isArray(person?.impressions) ? person.impressions : [];
  if (!impressions.length) return null;
  const memoryRoot = path.resolve(root ? String(root) : DEFAULT_MEMORY_ROOT);
  // 快照目录键与 global-person-memory-store.js 的 memberFileName 同源：
  // 全数字 id（任意位数）→ 裸数字；非数字 id → u_<净化 id>（CJK 换 _，不截断）；
  // name-only 成员 → _n_<净化名字>（保留 CJK，截 40，空则 unknown）。
  // 原来对非数字 uid 一律返回 null，remove / clearSource / clearPersonSource 删这类成员时
  // 拍不到快照，删了就回不来（2026-09-24 审查发现，违背"服务端会留可回滚快照"的承诺）。
  const isNumeric = /^\d+$/.test(userId);
  const key = isNumeric
    ? userId
    : userId
      ? `u_${userId.replace(/[^a-z0-9_]/gi, '_')}`
      : `_n_${String(name).replace(/[^a-z0-9_\u4e00-\u9fa5]/gi, '_').slice(0, 40) || 'unknown'}`;

  const when = Number(at) || Date.now();
  const snapshot = structuredClone(person);
  const backupRoot = path.join(memoryRoot, 'backups');
  const dir = path.join(backupRoot, 'consolidation', key);
  const file = path.join(dir, `${when}-${crypto.randomUUID()}.json`);
  writeJsonAtomic(file, {
    version: 1,
    reason: String(reason || 'consolidation'),
    sourceChatKey: String(sourceChatKey || ''),
    backedUpAt: when,
    person: snapshot
  });

  const chatDir = chatDirName(sourceChatKey);
  if (/^(group|private)_\d+$/.test(chatDir)) {
    writeJsonAtomic(path.join(backupRoot, chatDir, `${key}.json`), snapshot);
  }
  // 只增不删会一直占盘：每人只保留最近 KEEP_PER_PERSON 份（文件名前缀是时间戳）
  try {
    const kept = fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
    for (const stale of kept.slice(0, Math.max(0, kept.length - KEEP_PER_PERSON))) {
      try { fs.rmSync(path.join(dir, stale), { force: true }); } catch { /* 删不掉不影响本次备份 */ }
    }
  } catch { /* 目录读不到就算了 */ }
  return file;
}
