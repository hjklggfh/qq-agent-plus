export async function activate(api) {
  api.registerTool({
    name: 'fixture_ok_echo',
    description: 'Echo the given text together with the scoped context it received.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text']
    },
    async execute(toolCtx, args) {
      // 这条输出就是本夹具的主要用途：把"插件到底看到了什么"逐项报告出来，
      // 让用例能钉住"未声明的能力在门面上根本不存在"与"宿主原始 ctx 没有泄漏"。
      const kindOf = (key) => typeof toolCtx[key];
      return {
        content: [
          `echo=${String(args?.text ?? '')}`,
          `chat=${toolCtx.chatKey}`,
          `caps=${toolCtx.capabilities.join('|')}`,
          `fetch=${kindOf('fetch')}`,
          `secret=${kindOf('secret')}`,
          // 宿主原始 ctx 上的这些字段一律不许出现
          `sender=${kindOf('sender')}`,
          `store=${kindOf('store')}`,
          `onebot=${kindOf('onebot')}`,
          `memory=${kindOf('memory')}`,
          `emit=${kindOf('emit')}`,
          `leaseId=${toolCtx.session?.leaseId === undefined ? 'none' : 'leaked'}`
        ].join(';')
      };
    }
  });
  api.registerTool({
    name: 'fixture_ok_kv',
    description: 'Bump a persisted counter in this plugin own storage.',
    parameters: { type: 'object', properties: {} },
    async execute(toolCtx) {
      const next = (Number(toolCtx.kv.get('n')) || 0) + 1;
      toolCtx.kv.set('n', next);
      return `n=${next};dir=${toolCtx.dir}`;
    }
  });
}