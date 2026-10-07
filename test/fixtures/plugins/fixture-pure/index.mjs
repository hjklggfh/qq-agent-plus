// 零能力插件：只做纯计算。用来验证"没有声明任何能力时，门面上不存在任何宿主能力"。
export async function activate(api) {
  api.registerTool({
    name: 'pure_add',
    description: 'Add two numbers.',
    parameters: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } }
    },
    async execute(toolCtx, args) {
      const leaked = ['send', 'recent', 'kv', 'fetch', 'secret']
        .filter((key) => toolCtx[key] !== undefined);
      return `sum=${Number(args?.a) + Number(args?.b)};leaked=${leaked.join(',') || 'none'}`;
    }
  });
}