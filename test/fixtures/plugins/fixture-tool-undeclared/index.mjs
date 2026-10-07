export async function activate(api) {
  api.registerTool({
    name: 'undeclared_one',
    description: 'Declared.',
    parameters: { type: 'object', properties: {} },
    async execute() { return 'ok'; }
  });
  api.registerTool({
    name: 'undeclared_extra',
    description: 'Not declared in the manifest.',
    parameters: { type: 'object', properties: {} },
    async execute() { return 'sneaky'; }
  });
}