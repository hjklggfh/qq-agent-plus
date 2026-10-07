export async function activate(api) {
  api.registerTool({
    name: 'missing_alpha',
    description: 'Registered.',
    parameters: { type: 'object', properties: {} },
    async execute() { return 'ok'; }
  });
}