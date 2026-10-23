// Public, dependency-free feature metadata shared by the console and server.
// Never put credentials, runtime configuration or executable hooks in this list.
const FEATURE_CATALOG = Object.freeze([
  { id: 'search', name: '搜索服务', category: '检索与媒体', configKey: 'webSearch', description: '为模型提供联网搜索能力。' },
  { id: 'image-search', name: '以图搜图', category: '检索与媒体', configKey: 'imageSearch', description: '按图片查询来源与相似结果。' },
  { id: 'pixiv', name: 'PID 搜索', category: '检索与媒体', configKey: 'pixiv', description: '查询作品并投递图片或 PDF。' },
  { id: 'x-search', name: 'X 账号检索', category: '检索与媒体', configKey: 'xSearch', description: '读取公开账号近期帖子与原图。' },
  { id: 'ehentai', name: 'E站检索', category: '检索与媒体', configKey: 'ehentai', description: '搜索、翻页与下载投递。' },
  { id: 'media', name: 'B站媒体', category: '检索与媒体', configKey: 'bilibili', description: '识别视频链接并下载转发。' },
  { id: 'jm', name: 'JM 禁漫下载', category: '检索与媒体', configKey: 'jm', description: '管理现有下载与文件投递设置。' },
  { id: 'asr', name: '语音转文字', category: '检索与媒体', configKey: 'asr', description: '接入语音消息转写。' },
  { id: 'daily-report', name: '每晚汇报', category: '定时与社交', configKey: 'dailyReport', description: '定时向管理员汇报用量、费用和主机状态。' },
  { id: 'moments', name: '每日动态', category: '定时与社交', configKey: 'dailyMoments', description: '按计划生成和发布空间动态。' },
  { id: 'group-digest', name: '群日报', section: 'moments', category: '定时与社交', configKey: 'groupDigest', description: '按计划整理群聊并发送群日报。' },
  { id: 'reminders', name: '定时提醒', category: '定时与社交', configKey: 'reminders', description: '派发已有提醒，保留持久化记录。' },
  { id: 'qzone-interactions', name: '动态互动', category: '定时与社交', configKey: 'qzoneInteractions', description: '巡检好友动态和评论回复。' },
  { id: 'proactive', name: '主动发言', section: 'chat', area: 'settings', category: '对话与时间', configKey: 'proactive', description: '按聊天规则寻找主动发言机会。' },
  { id: 'private-proactive', name: '主动私信', section: 'chat', area: 'settings', category: '对话与时间', configKey: 'privateProactive', description: '按白名单与冷却规则管理主动私信。' },
  { id: 'time-control', name: '时间控制', category: '对话与时间', configKey: 'timeControl', description: '统一限制各会话的活跃时段。' }
].map(item => Object.freeze(item)));

const FEATURE_SECTIONS = Object.freeze(['feature-center', ...new Set(FEATURE_CATALOG.filter(item => !item.area).map(item => item.section || item.id))]);

export { FEATURE_CATALOG, FEATURE_SECTIONS };
