// 官方示例插件：把"一个插件长什么样"写全，同时当作手工验证的靶子。
//
// 三个刻意的示范点：
//   ① 只声明用得上的能力。这里没用 http/secrets，所以 toolCtx.fetch / api.secret
//      根本不存在 —— 不是"有但会报错"。想加就改 plugin.json 的 capabilities，
//      然后重装（能力变了必须重新确认，见 docs/PLUGINS.md）。
//   ② 工具名与 manifest.tools **必须完全一致**：多注册一个、少注册一个都会导致整个插件
//      加载失败。所以模型看到的工具永远等于 manifest 里写的那几个。
//   ③ 状态放 kv（落在 <数据目录>/plugin-state/hello/），不放插件目录 —— 升级时整目录被
//      替换掉也不会丢计数。
//
// 入口必须导出 activate(api)。返回 { deactivate } 是可选的：宿主在同进程重载/退出时调用。
export async function activate(api) {
  api.log.info(`示例插件已激活（能力：${api.capabilities.join(', ') || '无'}）`);

  api.registerTool({
    name: 'hello_count',
    description: '示例工具：在当前会话里打招呼，并报告自己被调用过多少次（计数持久化，重启不丢）。',
    parameters: {
      type: 'object',
      properties: {
        style: {
          type: 'string',
          enum: ['normal', 'excited'],
          description: '打招呼的语气，默认 normal'
        }
      }
    },
    async execute(toolCtx, args) {
      // 读计数 → 加一 → 写回。kv.get 读不到时返回 null。
      const previous = Number(toolCtx.kv.get('calls')) || 0;
      const calls = previous + 1;
      toolCtx.kv.set('calls', calls);
      toolCtx.kv.set('lastChatKey', toolCtx.chatKey);

      const excited = String(args?.style ?? '') === 'excited';
      const text = excited
        ? `你好啊！！（第 ${calls} 次被叫到）`
        : `你好，这是第 ${calls} 次被叫到。`;

      // send 只能发到当前会话（chatKey 由宿主绑死），并且与内置 send_message 一样
      // 会记进会话留档、触发控制台的 session-update 广播。
      const result = await toolCtx.send([text]);
      return {
        content: `已在 ${toolCtx.chatKey} 发言（成功 ${result.sent} 条，失败 ${result.failed} 条）；`
          + `累计调用 ${calls} 次，计数存于 ${toolCtx.dir}`
      };
    }
  });

  api.registerTool({
    name: 'hello_recent',
    description: '示例工具：列出当前会话最近几条消息，演示只读能力（只给文本，拿不到图片或其它会话）。',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: '最多几条，默认 5，上限 100' }
      }
    },
    async execute(toolCtx, args) {
      const limit = Math.min(100, Math.max(1, Number(args?.limit) || 5));
      const entries = toolCtx.recent(limit);
      if (!entries.length) return '当前会话没有可读的历史消息。';
      const lines = entries.map((entry) => {
        const who = entry.self ? '我' : (entry.senderName || entry.senderId || '未知');
        return `${new Date(entry.at).toLocaleTimeString('zh-CN', { hour12: false })} ${who}：${entry.text}`;
      });
      return `最近 ${entries.length} 条：\n${lines.join('\n')}`;
    }
  });

  return {
    async deactivate() {
      // v1 的插件不允许注册定时器/后台循环，所以这里通常没什么要清理的。
      // 留一个示例是为了说明：deactivate 里**不要**再调 chat:send 或 http ——
      // 卸载发生在进程收尾阶段，外部写入的成败已经没人能处理，也没有地方汇报。
      api.log.info('示例插件已卸载（计数保留在 plugin-state/hello/kv.json）');
    }
  };
}
