// Linux 服务入口：node src/server.js
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from './console/app.js';
import { installManualFriendReviewRoute } from './console/manual-friend-review-route.js';
import { installExperimentalMultimodalContextPilot } from './pilots/experimental-multimodal-context.js';
import { initPlugins } from '../plugins/loader.js';
import { installPluginRoutes } from '../plugins/console-routes.js';
import { initMarketExtensions } from '../plugins/market-loader.js';
import { buildToolDefs as buildBuiltinToolDefs } from './tools/tools-core.js';
import { DATA_DIR } from './core/config.js';
import { assertSqliteAvailable } from './core/sqlite.js';
import { createLogger } from './core/logger.js';

const log = createLogger('server');

let app = null;
process.on('unhandledRejection', (error) => {
  app?.captureIncident(error, {
    source: 'process',
    category: 'process',
    severity: 'critical',
    code: 'UNHANDLED_REJECTION'
  });
  log.error('[未处理异常]', error);
});
process.on('uncaughtException', (error) => {
  app?.captureIncident(error, {
    source: 'process',
    category: 'process',
    severity: 'critical',
    code: 'UNCAUGHT_EXCEPTION'
  });
  log.error('[未捕获异常]', error);
  process.exit(1);
});

/**
 * 上次部署是不是被中断了？
 *
 * deploy.sh 在停服务之前写 `$DATA_DIR/.deploy-in-progress`、健康检查通过后删掉。所以
 * 正常部署期间本进程也会看到这个标记 —— 判据是**标记里的 pid 还活着没有**：
 * 活着＝那次部署正在进行（正常，不吭声）；不在了（SIGKILL/OOM/掉电让 trap 没跑）
 * ＝代码可能半更新、服务可能被停过，这时才告警，并记一条异常（控制台「异常处理」能看到）。
 * 只告警不拦截：让人按快照决定，而不是让服务起不来。恢复步骤见 docs/LINUX.md。
 */
function reportInterruptedDeploy() {
  // 这段挂在 app.start() 的 then 后面，抛错会落进下游的 catch 直接 process.exit(1) ——
  // 一句告警不该有能力把服务带崩，所以整体兜住。
  try {
    const marker = path.join(DATA_DIR, '.deploy-in-progress');
    let info = null;
    try {
      info = JSON.parse(fs.readFileSync(marker, 'utf8'));
    } catch {
      return;   // 没有标记（或读不动）＝ 正常
    }
    const deployPid = Number(info?.pid) || 0;
    if (deployPid > 0) {
      try {
        process.kill(deployPid, 0);   // 还在跑：这是正常部署，别误报
        return;
      } catch (error) {
        // EPERM = 进程活着但不属于我（跨用户/平台差异）→ 同样按"还在跑"处理；
        // 只有 ESRCH 这类"确实不存在"才继续往下告警。
        if (error?.code === 'EPERM') return;
      }
    }
    const startedAt = Date.parse(String(info?.startedAt || ''));
    const when = Number.isFinite(startedAt)
      ? new Date(startedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
      : '时间未知';
    const snapshot = String(info?.snapshot || '').trim() || '（标记里没记快照，看 data/deploy-backups/ 里最新的一份）';
    log.warn('[部署] 检测到上次部署被中断（开始于 ' + when + '）：代码可能处于半更新状态，服务可能被停过。\n'
      + '  回滚快照：' + snapshot + '\n'
      + '  恢复步骤见 docs/LINUX.md「部署被中断后怎么恢复」；确认无误后删掉标记：' + marker);
    app?.captureIncident(new Error('上次部署被中断，代码可能处于半更新状态（详见服务日志）'), {
      source: 'deploy',
      category: 'deploy',
      severity: 'warning',
      code: 'DEPLOY_INTERRUPTED'
    });
  } catch (error) {
    log.warn('[部署] 中断标记检查失败（不影响启动）:', error?.message ?? error);
  }
}

// 启动最早期确认 node:sqlite 可用：缺内建模块时给人话指引，
// 而不是等 createApp 的存储层 import 链抛加载期裸栈（改进方案 C5/#11）。
assertSqliteAvailable();

// 仅安装一次薄包装；开关关闭时 multimodal-context commit 原样委托旧实现。
installExperimentalMultimodalContextPilot();

// 第三方插件必须在 createApp() **之前**装载：Orchestrator 在构造时就抓一次工具表
// （orchestrator.js 的 `this.toolDefs = buildToolDefs()`），插件工具得在那之前进注册表。
// 插件是代码，住在仓库根的 plugins/（与 src/ 平级、进版本库）；自装的第三方插件用
// config.plugins.roots 指到安装目录之外，那条路完全不经过 deploy.sh 的 rsync。
//
// initPlugins 对单个插件永不抛（坏插件只标成失败，见 plugins/loader.js）；这里的 try 兜的是
// "参数/扫描层面"的异常（例如内置工具名拿不到 = 无法做重名预检）。那种情况也绝不能拦住机器人启动。
//
// 内置工具名从 tools-core 直接取（不是 tools.js）：tools.js 的列表里已经会带上
// 上一次装载的插件工具，用它做"保留名"会把自己的插件判成重名。
// 同一份清单还要给控制台的插件页 —— 它要能报出"这个插件的工具名和内置的撞了"。
const builtinToolNames = buildBuiltinToolDefs().map((def) => String(def.name));
try {
  await initPlugins({ dataDir: DATA_DIR, log, builtinToolNames });
  await initMarketExtensions({ dataDir: DATA_DIR, log });
} catch (error) {
  log.error('[插件] 装载失败，按「没有插件」继续启动：', error?.message ?? error);
}

app = createApp();
installManualFriendReviewRoute(app);
// 插件管理页的 API（列表 / 启停 / 确认能力 / 改设置）。走 app.addRoute，因此鉴权、405 与
// 未命中 404 全部继承路由表；它只改配置，真正的装载仍然只发生在下一次启动。
installPluginRoutes(app, { dataDir: DATA_DIR, builtinToolNames });
app.start().then(reportInterruptedDeploy).catch((error) => {
  log.error('[启动失败]', error);
  process.exit(1);
});

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 25000);
  deadline.unref();
  try { await app.stop(); process.exit(0); }
  catch (error) { log.error(error); process.exit(1); }
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
