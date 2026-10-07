// chat:send / chat:read 的能力面：send 只能发到当前会话，且明确拒绝 replyToMessageId/atUserId。
export async function activate(api) {
  api.registerTool({
    name: 'send_greeting',
    description: 'Send a greeting to the current chat and report what happened.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        atUserId: { type: 'string', description: 'Set this to exercise the unsupported-target guard.' }
      }
    },
    async execute(toolCtx, args) {
      const recent = toolCtx.recent(3);
      const options = {};
      if (args?.atUserId !== undefined) options.atUserId = args.atUserId;
      const result = await toolCtx.send([String(args?.text ?? 'hello')], options);
      return `sent=${result.sent};failed=${result.failed};recent=${recent.length};chat=${toolCtx.chatKey}`;
    }
  });
}