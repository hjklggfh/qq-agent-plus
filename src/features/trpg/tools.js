const parameter = (description, properties, required) => ({ description, parameters: { type: 'object', properties, required } });
const definitions = {
  trpg_state: parameter('读取当前跑团的真实存档、版本和骰点；仅在玩家明确跑团行动中可用。', {}, []),
  trpg_roll: parameter('真实掷骰并持久化。每项检定使用唯一checkId；相同检定重试返回原骰点，禁止反复掷到成功。', {
    checkId: { type: 'string' }, expression: { type: 'string', description: '例如1d20+2' }
  }, ['checkId', 'expression']),
  trpg_update: parameter('保存累计剧情摘要、地点和玩家当前状态；不得替玩家决定行动。保存成功后再发送叙述。', {
    checkId: { type: 'string' }, expectedRevision: { type: 'integer' },
    summary: { type: 'string', description: '累计剧情、重要NPC、线索、目标，最多4000字' },
    location: { type: 'string' },
    players: { type: 'array', items: { type: 'object', properties: {
      userId: { type: 'string' }, hp: { type: 'integer' }, condition: { type: 'string' },
      inventory: { type: 'array', items: { type: 'string' } }
    }, required: ['userId'] } }
  }, ['checkId', 'expectedRevision', 'summary', 'location'])
};

export function trpgToolDefs() {
  return Object.entries(definitions).map(([name, def]) => ({
    name, feature: 'trpg', ...def,
    async execute(ctx, args) {
      if (!ctx.trpg) return { content: '跑团模块未就绪', isError: true };
      try { return { content: JSON.stringify(ctx.trpg.tool(ctx, name, args)) }; }
      catch (error) { return { content: String(error.message), isError: true, reportIncident: false }; }
    }
  }));
}
