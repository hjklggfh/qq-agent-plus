// Names follow the user's supplied pathway index. All playable effects are this
// project's bounded d20 adaptations, not an exhaustive canon ability catalogue.
export const TACTICAL_RULESET = 'lotm-tactical-v1';
export const ATTRIBUTE_NAMES = ['力量', '敏捷', '感知', '交涉'];
export const BUILD_STYLES = [
  { name: '均衡', attributes: { 力量: 1, 敏捷: 1, 感知: 1, 交涉: 1 } },
  { name: '调查', attributes: { 力量: 0, 敏捷: 1, 感知: 2, 交涉: 1 } },
  { name: '行动', attributes: { 力量: 2, 敏捷: 1, 感知: 1, 交涉: 0 } },
  { name: '交涉', attributes: { 力量: 0, 敏捷: 1, 感知: 1, 交涉: 2 } }
];

// Each pathway has one new authored, mechanically executed ability at each
// supported sequence (9,8,7,6,5). Earlier abilities remain available.
const rows = [
  ['fool', '愚者', '占卜家/小丑/魔术师/无面人/秘偶大师', '承认象征的盲区，以证据修正判断',
    '象征占卜:insight/灵巧闪避:ward/火焰跳跃:teleport/面容拟态:hide/灵体牵制:control'],
  ['error', '错误', '偷盗者/诈骗师/解密学者/盗火人/窃梦家', '辨认目标与保护它的边界，保留自我',
    '灵巧取物:insight/误导视线:hide/解密弱点:mark/窃取增益:dispel/梦境干扰:control'],
  ['door', '门', '学徒/戏法大师/占星人/记录官/旅行家', '理解阻隔，也承担穿越后的后果',
    '穿门:phase/戏法扰乱:control/星象定位:mark/法术记录:record/短距旅行:teleport'],
  ['visionary', '空想家', '观众/读心者/心理医生/催眠师/梦境行者', '观察先于判断，尊重别人的主动选择',
    '情绪观察:insight/意图洞察:mark/心理安抚:cleanse/催眠牵制:control/梦境遮护:ward'],
  ['hanged', '倒吊人', '秘祈人/倾听者/隐修士/蔷薇主教/牧羊人', '承认回应的危险，不把扮演当人格命令',
    '仪式辨识:insight/残响倾听:mark/阴影束缚:control/血肉修复:heal/有限放牧:summon'],
  ['sun', '太阳', '歌颂者/祈光人/太阳神官/公证人/光之祭司', '鼓舞他人自主行动，以事实支撑公正',
    '歌声鼓舞:buff/微光守护:ward/净化光束:radiant/公证约束:control/光域净化:burst'],
  ['tyrant', '暴君', '水手/暴怒之民/航海家/风眷者/海洋歌者', '认识环境与风浪，力量服务于合作',
    '水域适应:dash/蓄力重击:strike/风向辨识:mark/疾风步:teleport/风暴回响:burst'],
  ['tower', '白塔', '阅读者/推理学员/侦探/博学者/秘术导师', '以可验证事实修正理论',
    '记忆核对:insight/弱点推理:mark/现场重构:insight/术式解析:dispel/秘术导流:burst'],
  ['darkness', '黑暗', '不眠者/午夜诗人/梦魇/安魂师/灵巫', '保持清醒的守望，承认必要的休息',
    '夜间感知:insight/午夜诗歌:buff/梦魇牵制:control/安魂清明:cleanse/灵性护卫:summon'],
  ['death', '死神', '收尸人/掘墓人/通灵者/死灵导师/看门人', '尊重死者，辨认仍可救的生命',
    '遗体辨识:insight/阴冷护身:ward/残留问询:insight/灵体束缚:control/冥界守卫:summon'],
  ['giant', '黄昏巨人', '战士/格斗家/武器大师/黎明骑士/守护者', '以力量承担风险，而非支配队友',
    '体能爆发:buff/精准搏击:strike/武器架势:ward/黎明斩击:radiant/守护屏障:ward'],
  ['demoness', '魔女', '刺客/教唆者/女巫/欢愉/痛苦', '理解行动后果，保留角色与自我的距离',
    '暗处潜行:hide/言语扰乱:control/黑焰束:ranged/迷惑遮蔽:hide/痛苦蔓延:burst'],
  ['priest', '红祭司', '猎人/挑衅者/纵火家/阴谋家/收割者', '先观察布局，再为行动负责',
    '追踪猎物:mark/挑衅牵制:provoke/火焰投射:ranged/战术号令:buff/弱点收割:strike'],
  ['hermit', '隐者', '窥秘人/格斗学者/巫师/卷轴教授/星象师', '克制求知，先准备再接触危险知识',
    '神秘辨识:insight/战斗演算:buff/仪式束缚:control/卷轴护盾:ward/星象打击:ranged'],
  ['paragon', '完美者', '通识者/考古学家/鉴定师/工匠/天文学家', '使知识能够被验证与复现',
    '结构理解:insight/遗迹测绘:mark/物品鉴定:insight/临时装置:trap/星轨演算:buff'],
  ['wheel', '命运之轮', '怪物/机器/幸运儿/灾祸教士/赢家', '接受征兆，不把每个巧合当成命令',
    '危险预警:ward/精密计算:buff/幸运引导:buff/厄运标记:mark/命运偏转:ward'],
  ['mother', '母亲', '耕种者/医师/丰收祭司/生物学家/德鲁伊', '理解生命的环境、需要与边界',
    '生命辨识:insight/医治伤势:heal/丰收祝福:buff/生理调理:cleanse/藤蔓束缚:control'],
  ['moon', '月亮', '药师/驯兽师/吸血鬼/魔药教授/深红学者', '先辨症状与代价，不把药当万能答案',
    '药性辨识:insight/兽伴协助:summon/汲血打击:drain/药剂调理:heal/深红月束:ranged'],
  ['abyss', '深渊', '罪犯/折翼天使/连环杀手/恶魔/欲望使徒', '看清欲望，不让扮演吞没主动选择',
    '敌意嗅觉:insight/危险步伐:dash/致命观察:mark/恶魔焰:ranged/欲望扰乱:control'],
  ['chained', '被缚者', '囚犯/疯子/狼人/活尸/怨魂', '认识束缚与冲动，保留节制和选择',
    '忍耐护身:ward/意志爆发:buff/利爪:strike/坚韧躯体:ward/虚影穿行:teleport'],
  ['emperor', '黑皇帝', '律师/野蛮人/贿赂者/腐化男爵/混乱导师', '理解规则与利益，不以角色身份胁迫玩家',
    '漏洞分析:insight/蛮力冲击:strike/利益交换:buff/扭曲护持:ward/秩序干扰:control'],
  ['judge', '审判者', '仲裁人/治安官/审讯者/法官/惩戒骑士', '裁决有证据，威严不等于任意支配',
    '威严交涉:buff/秩序警戒:mark/逼近真相:insight/有限禁令:control/惩戒一击:radiant']
];

const effectInfo = {
  insight: ['辅助', 1, 0, '记录一条待主持解释的观察依据；下一次相关探索检定+2，不直接给未知谜底'],
  ward: ['辅助', 1, 4, '目标获得防护+2，持续至其下一回合结束；同名不叠加'],
  buff: ['辅助', 1, 4, '目标下一次攻击或检定+2，使用后移除'],
  hide: ['主要', 1, 0, '在掩体/遮蔽格隐匿，下一次攻击+2；攻击后解除'],
  phase: ['主要', 2, 1, '通过相邻的一格普通门；不穿封印门、墙或其他实体'],
  teleport: ['主要', 2, 4, '移动到可见的空格；不穿不透明墙，不携带整队'],
  mark: ['辅助', 1, 5, '标记可见敌人；对其下一次攻击+2，用后移除'],
  control: ['主要', 2, 4, '敌人以攻击修正进行抵抗检定，失败限制移动并失去下一次主要行动；不能控制玩家人格'],
  provoke: ['主要', 1, 4, '敌人以攻击修正进行抵抗检定，失败下回合优先针对施术者；不强迫玩家选择'],
  dispel: ['主要', 2, 4, '清除目标本引擎内的临时效果，包含增益与控制；不抹除高位封印或永久特性'],
  record: ['主要', 2, 4, '记录眼前敌人最近已施展的可记录攻击，转换为一次有限灵性攻击；不复制高序列/无限技能'],
  summon: ['主要', 2, 3, '在可见空格召出短暂协助物，提供周围友军攻击+2，维持两轮；非完整灵魂或永久NPC'],
  heal: ['主要', 2, 3, '恢复友军生命，不超过上限；不能复活或清空污染'],
  cleanse: ['主要', 2, 3, '解除友军一个临时控制并恢复清醒，不降低污染或消化'],
  dash: ['辅助', 1, 0, '本回合增加两格移动，不允许穿过障碍或忽略危险地形'],
  strike: ['主要', 1, 1, '近战攻击，真实攻击骰和伤害骰，受掩体与目标防护影响'],
  ranged: ['主要', 2, 5, '远程灵性攻击，受距离、视线及掩体影响'],
  radiant: ['主要', 2, 4, '可伤害影体的灵性攻击，不能越阶一击抹杀'],
  burst: ['主要', 3, 4, '目标周围一格范围伤害，范围内友军也可能受伤，逐一真实检定'],
  drain: ['主要', 2, 1, '近战命中后恢复造成伤害的一半，不超过自身上限'],
  trap: ['主要', 2, 3, '在可见空格放置一次性减速陷阱，进入者受伤并消耗额外移动，友军也受影响']
};

export const PATHWAYS = rows.map(([id, name, names, principle, effects]) => ({
  id, name, principle,
  sequences: names.split('/').map((title, index) => {
    const [abilityName, effect] = effects.split('/')[index].split(':');
    const [action, cost, range, description] = effectInfo[effect];
    return { sequence: 9 - index, name: title, abilities: [{
      id: `${id}-${9 - index}`, name: abilityName, effect, action, cost, range,
      power: 1 + index, minutes: effect === 'insight' ? 10 : 0,
      description: description + (['buff', 'hide', 'dash'].includes(effect) ? '；探索中启动成功后转为下一次相关检定+2，仍需符合叙事情境' : effect === 'ward' ? '；仅用于战场防护' : ''), adaptation: '同人d20限幅；非原著完整能力清单'
    }] };
  })
}));

export function pathwayOf(value) {
  return PATHWAYS.find((p) => p.id === value || p.name === value) || null;
}

export function abilitiesOf(player) {
  const p = pathwayOf(player.progress?.pathway);
  return p ? p.sequences.filter((s) => s.sequence >= player.progress.sequence).flatMap((s) => s.abilities) : [];
}

export function limitsOf(player) {
  const level = player.progress ? 9 - player.progress.sequence : 0;
  return { hp: player.character.hp + level * 2, spirit: 6 + level * 2, digestion: 6 + level * 2 };
}

export function validateBuild(input) {
  if (!pathwayOf(input.pathway)) throw new Error('请选择22条途径之一');
  if (input.sequence !== undefined && input.sequence !== 9) throw new Error('新建角色必须从序列9开始');
  const a = input.attributes;
  if (!a || Object.keys(a).length !== 4 || ATTRIBUTE_NAMES.some((key) => !Number.isInteger(a[key]) || a[key] < -1 || a[key] > 2)
    || Object.values(a).reduce((n, v) => n + v, 0) > 4) throw new Error('战术角色使用四属性，修正-1至2，总和不超过4');
  if (input.hp !== 10) throw new Error('新建战术角色初始HP固定10');
}

export function newProgress(pathway) {
  const p = pathwayOf(pathway);
  if (!p) throw new Error('角色未选择有效途径');
  return { pathway: p.id, sequence: 9, spirit: 6, pollution: 0, digestion: 0,
    recipes: [], materials: [], rituals: [], history: [], awards: [], overuse: 0, insight: 0 };
}

export const TACTICAL_WORLD = {
  id: 'grey-wharf', scope: '', ownerId: '', ruleset: TACTICAL_RULESET,
  name: '诡秘之主·灰堤长期战役',
  description: '第五纪鲁恩贝克兰德附近的原创灰堤装卸场。蒸汽、教会、工人互助会与非凡物品并存。序列9调查员从失踪工人案起步，逐步建立联系人、处理污染、取得配方和材料，最高晋升序列5。人物、案件和数值为同人自拟，序列名称沿用用户提供的索引。七工人露西、乔纳、彼得、哈维、梅、奥斯卡、萨姆受旧考勤簿影响；管理员埃德加为掩盖欠薪补写七人名字，潮湿、未遮光名册产生点名残响。乔纳逃出仍失声，能写字；其余六人在地窖。普通工资表、新墨、管理员收据、教会残标签各提供独立线索。关灯或完全遮簿可暂控点名；比对工资单去新名、干燥入锡盒、遮光、由两人或一玩家加NPC在盒外交接可完成收容。基础线索不靠一次骰成功；救人、协商、绕行和求援均可行。案件结束后可安全休整、追查古董商、接组织委托，不自动结束战役。主持可设计后续原创案件并按实际表现发放成长证据；不能凭背景赠高序能力。世界卡含主持真相，当前没有技术隔离秘密库。',
  opening: '灰堤仓库外，失声工人乔纳递来半张工资单，纸背写着“名单、灯、地下”。联络员赫斯特留下手套、罩布和干燥锡盒，请你们寻找另外六名工人。先创建各自的序列9角色，准备好后由团主开始。',
  rules: '使用程序提供的d20战术、成长和编号菜单规则。主持负责世界与NPC，程序核算移动、视线、回合、伤害、灵性和晋升。每次询问行动都须生成针对实际在册玩家的编号选项，允许自由描述。现实等待不推进时间。退出游戏为保存暂停，结束战役须团主确认。不要将旧手册的文本资源当成新的真值，也不混用COC百分制。'
};
