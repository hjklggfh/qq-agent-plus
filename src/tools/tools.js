// 原工具实现完整保存在 tools-core.js。
// 本文件是两层薄包装，关闭时都直接委托原实现，保持现有行为：
//   ① 「实验工具调度器」：关闭时逐个 await 旧实现；
//   ② 第三方插件工具：注册表默认为空，没跑过 initPlugins() 时结果与升级前逐字一致。
import { getConfig } from '../core/config.js';
import {
  recordMultimodalToolResult
} from '../pilots/experimental-multimodal-context-core.js';
import {
  annotateExperimentalToolSchemas,
  experimentalBatchKey,
  experimentalToolSchedulerConfig,
  ExperimentalToolBatch
} from '../pilots/experimental-tool-scheduler.js';
import { pluginToolDefs } from '../../plugins/_host/registry.js';
import {
  buildToolDefs as coreBuildToolDefs,
  executeTool as coreExecuteTool,
  toOpenAiTools as coreToOpenAiTools
} from './tools-core.js';

export * from './tools-core.js';

// 显式导出覆盖 export * 中同名项；关闭实验时仍原样调用旧实现。
//
// 插件工具**只加在这一层**，不进 tools-core.js。原因有两条：
//   ① test/experimental-tool-scheduler.test.mjs 对 tools-core 的 buildToolDefs() 全部工具
//      断言零个 unclassified —— 插件工具无法预先分类，加进去就会红；
//   ② tools-core 是"内置能力的清单"，让它去 import 插件注册表会把依赖方向倒过来。
// 插件工具在这里表现为"未分类工具"，调度器对未分类工具按保守串行处理
// （experimentalToolEffect 返回 'ordered'），不会并发预启动 —— 对第三方代码正是想要的。
export function buildToolDefs() {
  const core = coreBuildToolDefs();
  const plugins = pluginToolDefs();
  return plugins.length ? [...core, ...plugins] : core;
}

export function toOpenAiTools(defs) {
  const tools = coreToOpenAiTools(defs);
  return annotateExperimentalToolSchemas(tools, getConfig());
}

const batchBySession = new WeakMap();

function latestAssistantToolCalls(session) {
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message?.role === 'assistant'
      && Array.isArray(message.tool_calls)
      && message.tool_calls.length
    ) return message.tool_calls;
  }
  return [];
}

function schedulerMetrics(session, batch, settings) {
  if (!session || !batch) return;
  session.experimentalToolScheduler = {
    enabled: true,
    maxParallelReads: settings.maxParallelReads,
    ...batch.metrics()
  };
}

function runtimeBatch(defs, ctx, settings) {
  const session = ctx?.session;
  if (!session || typeof session !== 'object') return null;
  const calls = latestAssistantToolCalls(session);
  if (!calls.length) return null;
  const key = experimentalBatchKey(calls, session.rounds);
  const old = batchBySession.get(session);
  if (old?.key === key) return old.batch;

  const batch = new ExperimentalToolBatch(calls, {
    maxParallelReads: settings.maxParallelReads,
    execute: (call) => coreExecuteTool(
      defs,
      ctx,
      call?.function?.name ?? '',
      call?.function?.arguments ?? '{}'
    ),
    onParallelWave: ({ size, names }) => {
      session.experimentalToolScheduler = {
        enabled: true,
        maxParallelReads: settings.maxParallelReads,
        parallelWaveActive: true,
        lastParallelSize: size,
        lastParallelTools: names
      };
    }
  });
  batchBySession.set(session, { key, batch });
  schedulerMetrics(session, batch, settings);
  return batch;
}

function safeToolArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw ?? '{}')); } catch { return {}; }
}

function observeMultimodalResult(ctx, name, argsJson, result, cfg) {
  if (cfg?.multimodalContextPilot?.enabled !== true) return result;
  return recordMultimodalToolResult(
    ctx?.session,
    name,
    safeToolArgs(argsJson),
    result,
    cfg
  );
}

/**
 * 实验关闭：直接进入旧 executeTool，连批次解析都不做。
 * 实验开启：宿主依旧逐个 await 本函数；仅连续只读工具会被后台并行预启动。
 */
export async function executeTool(defs, ctx, name, argsJson) {
  const cfg = getConfig();
  const settings = experimentalToolSchedulerConfig(cfg);
  if (!settings.enabled) {
    const result = await coreExecuteTool(defs, ctx, name, argsJson);
    return observeMultimodalResult(ctx, name, argsJson, result, cfg);
  }

  const batch = runtimeBatch(defs, ctx, settings);
  if (!batch) {
    const result = await coreExecuteTool(defs, ctx, name, argsJson);
    return observeMultimodalResult(ctx, name, argsJson, result, cfg);
  }

  const scheduled = await batch.next(name, argsJson);
  if (!scheduled.handled) {
    // Session 审计结构与宿主调用顺序出现任何不一致时，宁可退回旧串行路径。
    const result = await coreExecuteTool(defs, ctx, name, argsJson);
    return observeMultimodalResult(ctx, name, argsJson, result, cfg);
  }
  schedulerMetrics(ctx?.session, batch, settings);
  return observeMultimodalResult(ctx, name, argsJson, scheduled.result, cfg);
}
