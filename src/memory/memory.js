// 统一记忆入口：人物长期记忆全局化；会话 handoff 仍按 chatKey 隔离。
import { MemoryStore as BaseMemoryStore } from './memory-global.js';
import { bindGlobalMemoryStore } from './memory-runtime-integration.js';
import { backupPersonBeforeConsolidation } from './memory-consolidation-backup.js';
import '../pilots/relationship-runtime-integration.js';
import { impressionVisible, memoryVisibilityOf } from '../core/memory-visibility.js';

export class MemoryStore extends BaseMemoryStore {
  /**
   * @param {object} [options]
   * @param {string} [options.root]  记忆根目录；缺省 DATA_DIR/memory（主实例，行为不变）
   * @param {boolean} [options.bind] 是否把这个实例登记为 IdentityStore 的全局记忆来源。
   *   只有主实例该绑：第二人设实例绑上去会把身份/好友评估读到的记忆整片换成它。
   * @param {boolean} [options.migrate] 是否在构造时立即跑旧记忆迁移。
   *   第二人设库是空白起步、没有旧数据，跳过它＝功能关闭时启动完全不碰这块磁盘。
   */
  constructor({ root = '', bind = true, migrate = true } = {}) {
    super({ root });
    // 启动时立即完成旧人物记忆迁移，确保 IdentityStore 随后的 rebuild
    // 看不到旧 group_*/<QQ>.json，从而不再维护第二份 legacy_memory_refs 内容。
    if (migrate !== false) this.people.listSourceChats();
    if (bind !== false) bindGlobalMemoryStore(this);
  }

  /** 全局人物列表：不再按 chatKey 过滤。 */
  globalMembers() {
    return this.people.members();
  }

  /**
   * memory_query 的底层查询：全局人物记忆，受 memory.visibility 策略约束（#13）——
   * mode='perChat' 只返回来源含当前会话的印象；hidePrivateInGroup 时群聊里剔除私聊来源。
   * 默认（global + 不隐藏）与历史行为逐字一致。
   */
  query(chatKey, category = '') {
    if (category && category !== 'memberImpression') return { [category]: [] };
    const vis = memoryVisibilityOf();
    const memberImpression = [];
    for (const member of this.people.members()) {
      for (const entry of member.impressions || []) {
        if (!impressionVisible(entry, chatKey, vis)) continue;
        memberImpression.push({
          userId: String(member.userId || ''),
          target: String(member.name || member.userId || '某人'),
          content: entry.content,
          createdAt: entry.createdAt,
          lastObservedAt: entry.lastObservedAt,
          origin: entry.origin || '',
          sourceChatKeys: Array.isArray(entry.sourceChatKeys) ? [...entry.sourceChatKeys] : []
        });
      }
    }
    memberImpression.sort((a, b) =>
      (Number(b.lastObservedAt) || Number(b.createdAt) || 0)
      - (Number(a.lastObservedAt) || Number(a.createdAt) || 0));
    return { memberImpression };
  }

  /**
   * 全局人物记忆的 replace 是潜在破坏性写入。
   * 当该人物已经拥有当前 chatKey 的来源记录时，BaseMemoryStore.replace 会用新摘要替换
   * 现有全局印象；因此在写入前保存完整人物快照。若人物只是第一次出现在一个新 chat，
   * 基础实现会做 merge 而不是覆盖，此时不制造无意义备份。
   */
  replaceMember(chatKey, userId, name, contents, options = {}) {
    const source = String(chatKey || '').trim();
    const person = this.getMember('', userId);
    const destructive = Array.isArray(person?.impressions)
      && person.impressions.length > 0
      && Array.isArray(person?.sourceChatKeys)
      && person.sourceChatKeys.includes(source);
    if (destructive) {
      backupPersonBeforeConsolidation(person, {
        root: this.root,
        sourceChatKey: source,
        at: Date.now()
      });
    }
    return super.replaceMember(chatKey, userId, name, contents, options);
  }

  /**
   * 显式 consolidation 入口，供后续调用方使用；避免通过普通 replace 语义猜测意图。
   * 当前 Orchestrator 的历史实现仍直接调用 replaceMember，因此上面的写前保护是必要兜底。
   */
  replaceMemberForConsolidation(chatKey, userId, name, contents, options = {}) {
    const person = this.getMember('', userId);
    backupPersonBeforeConsolidation(person, {
      root: this.root,
      sourceChatKey: chatKey,
      at: Date.now()
    });
    return super.replaceMember(chatKey, userId, name, contents, { origin: 'consolidated', ...options });
  }

  /**
   * 兼容批量 replaceConsolidated 调用。破坏前快照**不要**在这里拍：
   * 中间层的 replaceConsolidated 最终走 this.replaceMember（回到本类覆写），
   * 对"真的会被覆盖"的人自带快照；在这里再拍一遍会让每人每次整理落两份一样的
   * 快照，KEEP_PER_PERSON=20 的实际深度只剩约 10 轮（2026-09-25 复核定案）。
   */
  replaceConsolidated(chatKey, next) {
    return super.replaceConsolidated(chatKey, next);
  }
}
