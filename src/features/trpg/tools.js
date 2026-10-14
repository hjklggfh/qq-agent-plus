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

const revision = { checkId: { type: 'string' }, expectedRevision: { type: 'integer' } };
const tacticalDefinitions = {
  trpg_check: parameter('对本轮玩家明确提出的自由探索行动作一次属性检定，保存真实结果和并行耗时。已通过编号结算的行动不能重掷，伤害风险需先获同意。', {
    ...revision, userId: { type: 'string' }, attribute: { type: 'string', enum: ['力量', '敏捷', '感知', '交涉'] }, dc: { type: 'integer', enum: [10, 12, 15, 18] }, failureDamage: { type: 'integer', minimum: 0, maximum: 2 }, minutes: { type: 'integer', minimum: 0, maximum: 60 }
  }, ['checkId', 'expectedRevision', 'userId', 'attribute', 'dc', 'minutes']),
  trpg_explore: parameter('结算玩家本轮明确要求使用的非战斗能力；程序检查解锁、目标限制、灵性、骰点和重复使用。不是任意修改资源或获得未知答案的接口。', {
    ...revision, userId: { type: 'string' }, ability: { type: 'string' }, destinationKnown: { type: 'boolean' }, destination: { type: 'string' }, ordinaryDoor: { type: 'boolean' }, doorThicknessCm: { type: 'integer' }, distance: { type: 'integer' }
  }, ['checkId', 'expectedRevision', 'userId', 'ability']),
  trpg_options: parameter('为每位在册玩家创建编号行动；程序解释数字，发送时自动附加菜单。所有风险先写清。', {
    ...revision, players: { type: 'array', items: { type: 'object', properties: {
      userId: { type: 'string' }, options: { type: 'array', items: { type: 'object', properties: {
        label: { type: 'string' }, risk: { type: 'string' }, minutes: { type: 'integer' }, attribute: { type: 'string', enum: ['力量', '敏捷', '感知', '交涉'] },
        dc: { type: 'integer', enum: [10, 12, 15, 18] }, failureDamage: { type: 'integer', minimum: 0, maximum: 2 }
      }, required: ['label', 'minutes'] } }
    }, required: ['userId', 'options'] } }
  }, ['checkId', 'expectedRevision', 'players']),
  trpg_scene: parameter('转换探索/安全休整场景及任务日志；战斗未结束或有人待选时拒绝。不能直接修改资源。', {
    ...revision, sceneId: { type: 'string' }, name: { type: 'string' }, safe: { type: 'boolean' }, clockPaused: { type: 'boolean', description: '已实际断开危险源时暂停危险累计；不改变已过去的游戏时间' },
    journal: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' }, status: { type: 'string', enum: ['open', 'done'] } }, required: ['id', 'text', 'status'] } },
    npcs: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, location: { type: 'string' }, attitude: { type: 'integer', minimum: -2, maximum: 2 }, notes: { type: 'string' } }, required: ['id', 'name', 'location', 'attitude', 'notes'] } }
  }, ['checkId', 'expectedRevision', 'sceneId', 'name', 'safe']),
  trpg_encounter: parameter('开始有格子、掩体、墙、危险地形和互动目标的战斗。地图一次建立，敌人遵守真实回合。不要重置已有战斗。', {
    ...revision, width: { type: 'integer' }, height: { type: 'integer' },
    walls: { type: 'array', items: { type: 'string', description: '坐标如C3' } },
    cover: { type: 'array', items: { type: 'object', properties: { at: { type: 'string' }, value: { type: 'integer', enum: [1, 2] } }, required: ['at', 'value'] } },
    hazards: { type: 'array', items: { type: 'object', properties: { at: { type: 'string' }, label: { type: 'string' }, damage: { type: 'integer' }, slow: { type: 'boolean' } }, required: ['at', 'label', 'damage'] } },
    objects: { type: 'array', items: { type: 'object', properties: { at: { type: 'string' }, label: { type: 'string' }, kind: { type: 'string', enum: ['door', 'lamp', 'barrier', 'rescue'] } }, required: ['at', 'label', 'kind'] } },
    players: { type: 'array', items: { type: 'object', properties: { userId: { type: 'string' }, at: { type: 'string' } }, required: ['userId', 'at'] } },
    enemies: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, at: { type: 'string' }, hp: { type: 'integer' }, defense: { type: 'integer' }, attack: { type: 'integer' }, damage: { type: 'integer' }, range: { type: 'integer' }, move: { type: 'integer' }, spiritOnly: { type: 'boolean' } }, required: ['name', 'at', 'hp'] } }
  }, ['checkId', 'expectedRevision', 'enemies']),
  trpg_battle_action: parameter('仅解释当前玩家本轮自由描述的战斗行动，程序校验次数、资源、距离、视线与目标。不能替其他玩家行动。', {
    ...revision, action: { type: 'object', properties: { kind: { type: 'string', enum: ['move', 'attack', 'ability', 'interact', 'item', 'defend', 'end', 'retreat'] }, at: { type: 'string' }, target: { type: 'string' }, ability: { type: 'string' }, object: { type: 'string' }, item: { type: 'string' }, weapon: { type: 'string', enum: ['melee', 'ranged'] }, confirmFriendlyFire: { type: 'boolean' } }, required: ['kind'] }
  }, ['checkId', 'expectedRevision', 'action']),
  trpg_reward: parameter('依据真实完成行动发放成长证据；有去重和场景/章节上限。不得代替玩家晋升。', {
    ...revision, userId: { type: 'string' }, eventId: { type: 'string' }, evidence: { type: 'string' }, kind: { type: 'string', enum: ['digestion', 'recipe', 'material', 'ritual', 'item'] }, sequence: { type: 'integer', minimum: 5, maximum: 8 }, item: { type: 'string' }
  }, ['checkId', 'expectedRevision', 'userId', 'eventId', 'evidence', 'kind'])
};

export function trpgToolDefs(tactical = false) {
  return Object.entries({ ...definitions, ...(tactical ? tacticalDefinitions : {}) }).map(([name, def]) => ({
    name, feature: 'trpg', ...def,
    async execute(ctx, args) {
      if (!ctx.trpg) return { content: '跑团模块未就绪', isError: true };
      try { return { content: JSON.stringify(ctx.trpg.tool(ctx, name, args)) }; }
      catch (error) { return { content: String(error.message), isError: true, reportIncident: false }; }
    }
  }));
}
