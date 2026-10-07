// 只报告能力面是否存在，不发真实请求 —— 用例必须能在没有网络的机器上跑。
export async function activate(api) {
  const secretToken = api.secret('apiKey');
  api.registerTool({
    name: 'net_probe',
    description: 'Report which capability surfaces this plugin received.',
    parameters: { type: 'object', properties: {} },
    async execute(toolCtx) {
      return [
        `fetch=${typeof toolCtx.fetch}`,
        `secret=${typeof toolCtx.secret}`,
        `send=${typeof toolCtx.send}`,
        `recent=${typeof toolCtx.recent}`,
        `kv=${typeof toolCtx.kv}`,
        `token=${secretToken === '' ? 'empty' : 'set'}`
      ].join(';');
    }
  });
}