import { BackgroundTaskRegistry } from './background-tasks.js';
import { taskObservation } from './task-observation.js';

// Summarize existing bounded records without copying content, errors or payloads.
function recordSummary(records = [], successStatuses, failureStatuses) {
  let lastRunAt = 0; let lastSuccessAt = 0; let lastErrorAt = 0;
  for (const item of records) {
    const at = Number(item.endedAt || item.updatedAt || item.startedAt) || 0;
    lastRunAt = Math.max(lastRunAt, at);
    if (successStatuses.includes(item.status)) lastSuccessAt = Math.max(lastSuccessAt, at);
    if (failureStatuses.includes(item.status)) lastErrorAt = Math.max(lastErrorAt, at);
  }
  return { lastRunAt, lastSuccessAt, lastErrorAt, failed: lastErrorAt > 0 && lastErrorAt >= lastSuccessAt,
    failureCode: lastErrorAt ? 'record' : '' };
}

export function createAppBackgroundTasks({ config, log, orchestrator, dailyMoments, qzoneInteractions,
  groupDigest, dailyReport, groupGame, autoUpdate }) {
  const registry = new BackgroundTaskRegistry({ config, log });
  registry.register({ id: 'message-recovery', name: '消息恢复巡检', schedule: '每 5 秒',
    start: () => orchestrator.startRecoveryLoop(), stop: () => orchestrator.stopRecoveryLoop(),
    status: () => taskObservation(orchestrator, 'message-recovery') });
  registry.register({ id: 'reminders', name: '定时提醒派发', featureId: 'reminders', configKey: 'reminders',
    enabled: cfg => cfg.reminders?.enabled !== false, schedule: '每 30 秒检查',
    start: () => orchestrator.startReminderLoop(), stop: () => orchestrator.stopReminderLoop(),
    status: () => taskObservation(orchestrator, 'reminders') });
  registry.register({ id: 'scheduled-wakes', name: '会话定时唤醒', schedule: '每 30 秒检查',
    start: () => orchestrator.startScheduledWakeTicker(), stop: () => orchestrator.stopScheduledWakeTicker(),
    status: () => taskObservation(orchestrator, 'scheduled-wakes') });
  registry.register({ id: 'daily-moments', name: '每日动态调度', featureId: 'moments', configKey: 'dailyMoments',
    enabled: cfg => cfg.dailyMoments?.enabled === true, schedule: '沿用功能页的时刻或时间窗',
    start: () => dailyMoments.start(), reconfigure: () => dailyMoments.reconfigure(),
    stop: () => { dailyMoments.stop(); dailyMoments.abort(); },
    failureReasons: { record: '动态生成或发布失败，请到每日动态查看记录' },
    status: () => ({ ...recordSummary(dailyMoments.state?.records, ['published'], ['failed', 'interrupted']),
      successKind: 'delivery', running: Boolean(dailyMoments.running), nextRunAt: dailyMoments.running ? null : dailyMoments.nextRunAt,
      needsReview: dailyMoments.state?.records?.some(item => item.status === 'publish-unknown') === true }) });
  registry.register({ id: 'qzone-interactions', name: '动态互动巡检', featureId: 'qzone-interactions', configKey: 'qzoneInteractions',
    enabled: cfg => cfg.qzoneInteractions?.enabled === true, schedule: '沿用功能页巡检与退避规则',
    start: () => qzoneInteractions.start(), reconfigure: () => qzoneInteractions.reconfigure(),
    stop: async () => { qzoneInteractions.stop(); await qzoneInteractions.abort(); },
    failureReasons: { record: '动态互动执行失败或动态抓取降级，请到功能页查看记录' },
    status: () => ({ ...recordSummary(qzoneInteractions.state?.runs, ['done'], ['failed', 'partial-feed-error', 'interrupted']),
      running: Boolean(qzoneInteractions.running), nextRunAt: qzoneInteractions.running ? null : qzoneInteractions.nextRunAt,
      needsReview: [qzoneInteractions.state?.feeds, qzoneInteractions.state?.comments]
        .some(items => items?.some(item => item.status === 'unknown')) }) });
  registry.register({ id: 'group-digest', name: '群日报调度', featureId: 'group-digest', configKey: 'groupDigest',
    enabled: cfg => cfg.groupDigest?.enabled === true, schedule: '沿用群日报的每日时刻',
    start: () => groupDigest.start(), reconfigure: () => groupDigest.reconfigure(), stop: () => groupDigest.shutdown(),
    failureReasons: { digest: '群日报生成或发送失败，请到功能页查看结果' },
    status: () => ({ running: groupDigest.running, nextRunAt: groupDigest.nextRunAt, lastRunAt: groupDigest.lastRun?.at,
      successKind: 'delivery', nextKind: 'schedule', lastSuccessAt: groupDigest.lastSuccessAt,
      lastErrorAt: groupDigest.lastErrorAt, failureCode: groupDigest.lastErrorAt ? 'digest' : '',
      failed: groupDigest.lastErrorAt > 0 && groupDigest.lastErrorAt >= groupDigest.lastSuccessAt }) });
  registry.register({ id: 'group-games', name: '群游戏进度检查', schedule: '每 20 秒检查，业务开关由游戏模块控制',
    start: () => groupGame.startLoop(), stop: () => groupGame.stopLoop(),
    status: () => taskObservation(groupGame, 'group-games') });
  registry.register({ id: 'proactive', name: '主动发言调度', featureId: 'proactive', configKey: 'proactive',
    enabled: cfg => cfg.proactive?.enabled === true, schedule: '沿用主动发言间隔与冷却规则',
    start: () => orchestrator.startProactiveLoop(), stop: () => orchestrator.stopProactiveLoop(),
    reconfigure: () => orchestrator.startProactiveLoop(), status: () => taskObservation(orchestrator, 'proactive') });
  registry.register({ id: 'private-proactive', name: '主动私信调度', featureId: 'private-proactive', configKey: 'privateProactive',
    enabled: cfg => cfg.privateProactive?.enabled === true, schedule: '沿用私信白名单与冷却规则',
    start: () => orchestrator.startPrivateProactiveLoop(), stop: () => orchestrator.stopPrivateProactiveLoop(),
    reconfigure: () => orchestrator.startPrivateProactiveLoop(), status: () => taskObservation(orchestrator.privateProactive, 'private-proactive') });
  registry.register({ id: 'update-notifications', name: '更新通知检查', schedule: '每 30 秒检查；实际更新仍由 systemd 管理',
    start: () => autoUpdate.start(), stop: () => autoUpdate.stop(),
    status: () => ({ ...taskObservation(autoUpdate, 'update-notifications'), running: Boolean(autoUpdate.notificationTask) }) });
  registry.register({ id: 'daily-report', name: '每晚汇报调度', featureId: 'daily-report', configKey: 'dailyReport',
    enabled: cfg => cfg.dailyReport?.enabled === true, schedule: '沿用每晚汇报的北京时间',
    start: () => dailyReport.start(), stop: () => dailyReport.stop(), reconfigure: () => dailyReport.enforce(),
    failureReasons: { report: '报告生成或状态读写失败，请检查报告状态与磁盘' },
    status: () => {
      const report = dailyReport.status();
      const observed = taskObservation(dailyReport, 'daily-report');
      return { ...observed, running: Boolean(dailyReport.pending),
        successKind: 'delivery', lastSuccessAt: report.last?.outcome === 'sent' ? report.last.at : null,
        needsReview: report.last?.outcome === 'unknown', failed: Boolean(report.error),
        failureCode: observed.failureCode || (report.error ? 'report' : '') };
    } });
  return registry;
}
