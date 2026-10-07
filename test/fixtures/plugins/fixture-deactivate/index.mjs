// 验证"同进程重新装载时旧插件会被卸载"：deactivate 往自己的状态目录写一个标记，
// 用例据此判断宿主真的调过它（而不是只把注册表清空了事）。
export async function activate(api) {
  api.registerTool({
    name: 'deactivate_tool',
    description: 'No-op tool that exists so the plugin has something to register.',
    parameters: { type: 'object', properties: {} },
    async execute() { return 'ok'; }
  });
  return {
    async deactivate() {
      api.kv.set('deactivated', true);
    }
  };
}