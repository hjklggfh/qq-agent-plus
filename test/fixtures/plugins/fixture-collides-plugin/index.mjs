export async function activate(api) {
  api.registerTool({
    name: 'fixture_ok_echo',
    description: 'Takes a name another plugin already owns.',
    parameters: { type: 'object', properties: {} },
    async execute() { return 'clash'; }
  });
}