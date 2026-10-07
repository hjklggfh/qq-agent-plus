// 插件运行时注册表：宿主看到的"当前有哪些插件工具"的唯一来源。
//
// **默认是空的，而且导入本模块不碰磁盘。** 这条是硬要求：
// test/tools.test.mjs、test/sticker-manager.test.mjs、test/video-frames.test.mjs、
// test/selftest.mjs 都会 import src/tools/tools.js 的 buildToolDefs()，并假设工具集与
// 升级前逐字一致。如果 tools.js 在这里"顺手扫一下 data/plugins/"，那些用例就会随
// 开发者本机的插件目录而变。所以：只有 initPlugins()（src/server.js 在 createApp()
// 之前调用）真的跑过，这里才有内容。
//
// 另一个刻意的选择：**插件工具不进 tools-core.js**。test/experimental-tool-scheduler.test.mjs
// 对 buildToolDefs() 的**全部**工具断言零个 unclassified，而它 import 的是 tools-core.js；
// 插件工具只加在 tools.js 的薄包装层，所以那条用例不受影响，插件工具在运行期按
// "保守串行"处理（experimentalToolEffect 对未分类工具返回 'ordered'，不会并发预启动）。

/** 插件工具 def 的形状与内置工具一致，额外挂三个只读标记（见 manager.js 的 buildToolDef）。 */
let currentToolDefs = [];
let currentStatuses = [];
let currentPlugins = [];

/** 当前生效的插件工具（默认空数组）。tools.js 的 buildToolDefs 拼它。 */
export function pluginToolDefs() {
  return currentToolDefs;
}

/** 插件工具名 → 插件 id。给"这个工具属于谁"这类诊断用。 */
export function pluginIdOfTool(name) {
  const tool = String(name ?? '');
  const found = currentToolDefs.find((def) => def.name === tool);
  return found ? String(found.pluginId ?? '') : '';
}

/** 每个插件的运行时状态（已加载/失败/待确认/未启用），给控制台与运维用。 */
export function pluginRuntimeStatuses() {
  return currentStatuses;
}

/** 已加载插件的摘要（不含工具实现），给控制台列表用。 */
export function loadedPluginSummaries() {
  return currentPlugins;
}

/**
 * 装载结果一次写入。由 manager.js 在加载流程结束后调用。
 * 传空数组即彻底清空（测试之间隔离、以及"没有任何插件"的正常情形）。
 */
export function setPluginRegistry({ toolDefs = [], statuses = [], plugins = [] } = {}) {
  currentToolDefs = Array.isArray(toolDefs) ? toolDefs : [];
  currentStatuses = Array.isArray(statuses) ? statuses : [];
  currentPlugins = Array.isArray(plugins) ? plugins : [];
}

export function clearPluginRegistry() {
  setPluginRegistry({});
}
