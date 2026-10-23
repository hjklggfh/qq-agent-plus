import { BackgroundTaskRegistry } from './background-tasks.js';

export function createAppBackgroundTasks({ config, log, orchestrator, dailyMoments, qzoneInteractions,
  groupDigest, dailyReport, groupGame, autoUpdate }) {
  const registry = new BackgroundTaskRegistry({ config, log });
  registry.register({ id: 'message-recovery', name: '消息恢复巡检', schedule: '每 5 秒',
    start: () => orchestrator.startRecoveryLoop(), stop: () => orchestrator.stopRecoveryLoop() });
  registry.register({ id: 'reminders', name: '定时提醒派发', featureId: 'reminders', configKey: 'reminders',
    enabled: cfg => cfg.reminders?.enabled !== false, schedule: '每 30 秒检查',
    start: () => orchestrator.startReminderLoop(), stop: () => orchestrator.stopReminderLoop() });
  registry.register({ id: 'scheduled-wakes', name: '会话定时唤醒', schedule: '每 30 秒检查',
    start: () => orchestrator.startScheduledWakeTicker(), stop: () => orchestrator.stopScheduledWakeTicker() });
  registry.register({ id: 'daily-moments', name: '每日动态调度', featureId: 'moments', configKey: 'dailyMoments',
    enabled: cfg => cfg.dailyMoments?.enabled === true, schedule: '沿用功能页的时刻或时间窗',
    start: () => dailyMoments.start(), reconfigure: () => dailyMoments.reconfigure(),
    stop: () => { dailyMoments.stop(); dailyMoments.abort(); },
    status: () => ({ running: Boolean(dailyMoments.running), nextRunAt: dailyMoments.nextRunAt,
      needsReview: dailyMoments.state?.records?.some(item => item.status === 'publish-unknown') === true }) });
  registry.register({ id: 'qzone-interactions', name: '动态互动巡检', featureId: 'qzone-interactions', configKey: 'qzoneInteractions',
    enabled: cfg => cfg.qzoneInteractions?.enabled === true, schedule: '沿用功能页巡检与退避规则',
    start: () => qzoneInteractions.start(), reconfigure: () => qzoneInteractions.reconfigure(),
    stop: async () => { qzoneInteractions.stop(); await qzoneInteractions.abort(); },
    status: () => ({ running: Boolean(qzoneInteractions.running), nextRunAt: qzoneInteractions.nextRunAt,
      needsReview: [qzoneInteractions.state?.feeds, qzoneInteractions.state?.comments]
        .some(items => items?.some(item => item.status === 'unknown')) }) });
  registry.register({ id: 'group-digest', name: '群日报调度', featureId: 'group-digest', configKey: 'groupDigest',
    enabled: cfg => cfg.groupDigest?.enabled === true, schedule: '沿用群日报的每日时刻',
    start: () => groupDigest.start(), reconfigure: () => groupDigest.reconfigure(), stop: () => groupDigest.shutdown(),
    status: () => ({ running: groupDigest.running, nextRunAt: groupDigest.nextRunAt, lastRunAt: groupDigest.lastRun?.at }) });
  registry.register({ id: 'group-games', name: '群游戏进度检查', schedule: '每 20 秒检查，业务开关由游戏模块控制',
    start: () => groupGame.startLoop(), stop: () => groupGame.stopLoop() });
  registry.register({ id: 'proactive', name: '主动发言调度', featureId: 'proactive', configKey: 'proactive',
    enabled: cfg => cfg.proactive?.enabled === true, schedule: '沿用主动发言间隔与冷却规则',
    start: () => orchestrator.startProactiveLoop(), stop: () => orchestrator.stopProactiveLoop(),
    reconfigure: () => orchestrator.startProactiveLoop() });
  registry.register({ id: 'private-proactive', name: '主动私信调度', featureId: 'private-proactive', configKey: 'privateProactive',
    enabled: cfg => cfg.privateProactive?.enabled === true, schedule: '沿用私信白名单与冷却规则',
    start: () => orchestrator.startPrivateProactiveLoop(), stop: () => orchestrator.stopPrivateProactiveLoop(),
    reconfigure: () => orchestrator.startPrivateProactiveLoop() });
  registry.register({ id: 'update-notifications', name: '更新通知检查', schedule: '每 30 秒检查；实际更新仍由 systemd 管理',
    start: () => autoUpdate.start(), stop: () => autoUpdate.stop(),
    status: () => ({ running: Boolean(autoUpdate.notificationTask) }) });
  registry.register({ id: 'daily-report', name: '每晚汇报调度', featureId: 'daily-report', configKey: 'dailyReport',
    enabled: cfg => cfg.dailyReport?.enabled === true, schedule: '沿用每晚汇报的北京时间',
    start: () => dailyReport.start(), stop: () => dailyReport.stop(), reconfigure: () => dailyReport.enforce(),
    status: () => {
      const report = dailyReport.status();
      return { running: Boolean(dailyReport.pending), lastRunAt: report.last?.at,
        needsReview: report.last?.outcome === 'unknown', failed: Boolean(report.error) };
    } });
  return registry;
}
