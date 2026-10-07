export async function activate(api) {
  api.registerTool({
    name: 'second_ping',
    description: 'Returns pong.',
    parameters: { type: 'object', properties: {} },
    async execute() { return 'pong'; }
  });
}