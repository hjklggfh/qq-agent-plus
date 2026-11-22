import { chatCompletion } from '../../llm/llm.js';
import { webFetch } from '../../llm/web-search.js';
import { cleanTitle, publicLink } from '../image-search/common.js';
import {
  crawlMultiSites,
  searchAnimeTrace,
  searchImageRelayClues,
  searchWebResources
} from './sources.js';

export function resolveDeepSeekCredentials(fullConfig = {}, settings = {}) {
  const fromFeature = String(settings.deepseekApiKey || '').trim();
  const fromCatalog = String(fullConfig?.providerKeys?.deepseek || '').trim();
  const fromWebSearch = String(fullConfig?.webSearch?.deepseek?.apiKey || '').trim();
  const fromEnv = String(process.env.DEEPSEEK_API_KEY || '').trim();
  const providerEntry = (Array.isArray(fullConfig?.providers) ? fullConfig.providers : [])
    .find((p) => p && (p.id === 'deepseek' || /deepseek\.com/i.test(String(p.baseURL || ''))));
  const fromProviderList = String(providerEntry?.apiKey || '').trim();
  const fromMainApi = (fullConfig?.api?.provider === 'deepseek' || /deepseek\.com/i.test(String(fullConfig?.api?.baseUrl || '')))
    ? String(fullConfig?.api?.apiKey || '').trim()
    : '';

  const apiKey = [fromFeature, fromCatalog, fromWebSearch, fromEnv, fromProviderList, fromMainApi]
    .find((v) => v && v !== '******') || '';
  const baseUrl = String(settings.deepseekBaseUrl || 'https://api.deepseek.com/v1').trim().replace(/\/+$/, '');
  const model = String(settings.deepseekModel || 'deepseek-chat').trim();
  return { baseUrl, apiKey, model, configured: Boolean(apiKey && baseUrl && model) };
}

const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'crawl_multi_sites',
      description: '同时在多个资源与作品数据库（书音的图书馆、TouchGal、VNDB、DLsite、Steam、全网搜索）并发爬取指定关键词。当从首轮结果或识图线索中发现了作品的日文原名、准确的中文译名、别名或 RJ/VJ 编号时，立即用新关键词调用此工具深挖资源。',
      parameters: {
        type: 'object',
        properties: {
          keyword: {
            type: 'string',
            description: '精确作品名（中文译名、日文原名或 RJ123456 编号）'
          },
          sites: {
            type: 'array',
            items: {
              type: 'string',
              enum: ['shionlib', 'touchgal', 'vndb', 'dlsite', 'steam', 'web']
            },
            description: '可选：指定要查询的站点列表，不传则查询全部已启用站点'
          }
        },
        required: ['keyword']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_search_query',
      description: '用自定义搜索语法进行全网资源搜索（例如组合 "日文原名" "汉化" 下载 | 补丁 | 网盘）。当垂直站点未收录某款同人黄油/RPG时使用。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词组合' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_webpage',
      description: '读取某个候选资源网页的正文摘要（前 4000 字），核实该页面是否包含有效的下载说明、补丁或版本信息。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要核实的 http(s) 网页链接' }
        },
        required: ['url']
      }
    }
  }
];

const SYSTEM_PROMPT = [
  '你是一个独立运行的「ACG / Galgame / 同人黄油资源检索专家 Agent」。',
  '注意：本次任务不加载任何群聊人设与闲聊上下文，你只需客观、精准地定位作品真名与下载渠道。',
  '',
  '【工作策略】',
  '1. 识别作品真名：结合用户提供的名字或截图识图线索（AnimeTrace 角色/作品识别、以图搜图匹配网页标题），确定作品的「中文常用译名」「日文原名」「开发商/社团」及唯一编号（如 VNDB ID、DLsite RJ/VJ号、Steam AppID）。',
  '2. 多轮交叉检索（最多再调 2 轮工具）：',
  '   - 如果首轮只搜了模糊俗称、角色名或只拿到了 VNDB/DLsite 的日文原名，还没在「书音的图书馆 (shionlib)」或「TouchGal」命中具体资源，请提取准确的中文译名或日文原名再次调用 `crawl_multi_sites`；',
  '   - 如果是 RPGMaker / Unity / SLG 同人黄油（通常不在传统 Galgame 站），请用日文原名、中文名或 RJ 号调用 `web_search_query` 检索免费资源站与汉化补丁信息。',
  '3. 严禁编造任何链接、提取码或解压密码！所有 URL、提取码、解压密码必须 100% 来自工具真实返回的数据。',
  '',
  '【最终输出格式】',
  '完成检索后，只输出一个 JSON 对象（不要多余的寒暄），结构如下：',
  '{',
  '  "work": {',
  '    "titleZh": "作品中文名（未知则留空）",',
  '    "titleJp": "作品日文原名（未知则留空）",',
  '    "titleEn": "英文或罗马音名（可选）",',
  '    "codes": ["v12345", "RJ123456"],',
  '    "developers": ["社团或开发商"],',
  '    "tags": ["类型或标签"],',
  '    "cover": "优先选到的有效封面图片 URL（来自工具结果，无则留空）",',
  '    "summary": "简明介绍作品类型、是否有官方中文或民间汉化、本次检索结论（100字以内）"',
  '  },',
  '  "freeResources": [',
  '    {',
  '      "siteName": "站点名（如 TouchGal 资源站 / 书音的图书馆 / 某资源站）",',
  '      "title": "资源或帖子标题",',
  '      "url": "真实访问或下载链接",',
  '      "note": "版本说明、网盘类型、提取码或解压密码摘要"',
  '    }',
  '  ],',
  '  "officialResources": [',
  '    {',
  '      "siteName": "平台名（如 DLsite / Steam / VNDB）",',
  '      "title": "条目名与编号",',
  '      "url": "真实平台链接",',
  '      "note": "正版发售页或权威数据库档案"',
  '    }',
  '  ]',
  '}'
].join('\n');

function extractJsonBlock(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

function summarizeCrawlForPrompt(crawlReport) {
  return {
    keyword: crawlReport.keyword,
    sources: crawlReport.reports.map((r) => ({
      source: r.source,
      status: r.status,
      ...(r.error ? { error: r.error } : {}),
      results: (r.results || []).slice(0, 4)
    }))
  };
}

export async function runResourceSearchAgent(input, settings, options = {}) {
  const signal = options.signal;
  const completeFn = options.completeImpl || chatCompletion;
  const webFetchFn = options.webFetchImpl || webFetch;
  const fullConfig = typeof options.getConfig === 'function' ? options.getConfig() : (options.config || {});
  const creds = resolveDeepSeekCredentials(fullConfig, settings);
  if (!creds.configured) {
    throw new Error('未检测到可用的 DeepSeek API Key，请在“功能 → 资源检索”或“模型 API”中配置 DeepSeek 密钥。');
  }

  const crawledMap = new Map();
  const siteStats = new Map();
  const recordCrawl = (crawlReport) => {
    for (const rep of crawlReport.reports || []) {
      const prev = siteStats.get(rep.source) || { source: rep.source, status: rep.status, count: 0 };
      const count = Array.isArray(rep.results) ? rep.results.length : 0;
      siteStats.set(rep.source, {
        source: rep.source,
        status: (prev.status === 'ok' || rep.status === 'ok') ? 'ok' : rep.status,
        count: prev.count + count
      });
      for (const item of rep.results || []) {
        const key = `${item.source}:${item.url || item.id || item.title}`;
        if (!crawledMap.has(key)) crawledMap.set(key, item);
      }
    }
  };

  // 1. 若用户发送或引用了截图，先跑 AnimeTrace Galgame 模型 + 东京搜图中转拿线索
  const imageClues = { animetrace: null, relay: null };
  if (input.image) {
    const tasks = [];
    if (settings.sources?.animetrace !== false) {
      tasks.push(searchAnimeTrace(input.image, options).then((res) => {
        imageClues.animetrace = res;
        siteStats.set('animetrace', { source: 'animetrace', status: res.status, count: res.works.length });
      }));
    }
    if (options.imageSearchSettings?.relayUrl && options.imageSearchSettings?.relayToken) {
      tasks.push(searchImageRelayClues(input.image, options.imageSearchSettings, options).then((res) => {
        imageClues.relay = res;
      }));
    }
    await Promise.allSettled(tasks);
    signal?.throwIfAborted();
  }

  // 2. 确定首轮种子关键词并预跑一次多站点并发爬取
  const seedKeywords = [];
  if (input.query) seedKeywords.push(input.query);
  if (imageClues.animetrace?.works?.length) {
    for (const w of imageClues.animetrace.works.slice(0, 2)) {
      if (!seedKeywords.includes(w)) seedKeywords.push(w);
    }
  }
  if (!seedKeywords.length && imageClues.relay?.results?.length) {
    const firstTitle = cleanTitle(imageClues.relay.results[0]?.title, 60);
    if (firstTitle) seedKeywords.push(firstTitle);
  }

  const initialCrawls = [];
  for (const kw of seedKeywords.slice(0, 2)) {
    const report = await crawlMultiSites(kw, settings, options);
    recordCrawl(report);
    initialCrawls.push(summarizeCrawlForPrompt(report));
    signal?.throwIfAborted();
  }

  // 3. 构造给 DeepSeek 的纯净初始消息（无任何人设和群聊上下文）
  const userPayload = {
    userQuery: input.query || '（用户仅提供了游戏截图，未提供文字名称）',
    imageRecognitionClues: {
      animeTraceWorks: imageClues.animetrace?.works || [],
      animeTraceCharacters: imageClues.animetrace?.characters || [],
      reverseImageMatches: imageClues.relay?.results || []
    },
    initialMultiSiteResults: initialCrawls
  };

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `请根据以下输入线索与首轮多站点检索数据，确定作品信息并整理免费与正版资源渠道。若首轮因为别名/外文原名未搜全，请继续调用工具深挖：\n${JSON.stringify(userPayload, null, 2)}`
    }
  ];

  const overrides = {
    baseUrl: creds.baseUrl,
    apiKey: creds.apiKey,
    model: creds.model,
    timeoutMs: Math.min(45000, settings.timeoutSeconds * 1000)
  };

  const MAX_AGENT_ROUNDS = 3;
  let finalContent = '';

  for (let round = 0; round < MAX_AGENT_ROUNDS; round++) {
    signal?.throwIfAborted();
    const isLastRound = round === MAX_AGENT_ROUNDS - 1;
    const response = await completeFn({
      messages,
      tools: isLastRound ? null : AGENT_TOOLS,
      toolChoice: isLastRound ? undefined : 'auto',
      temperature: 0.2,
      maxTokens: 2000,
      purpose: 'default',
      overrides,
      signal
    });

    const msg = response?.message || {};
    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    if (!toolCalls.length || isLastRound) {
      finalContent = String(msg.content || '').trim();
      break;
    }

    messages.push({
      role: 'assistant',
      content: msg.content || '',
      tool_calls: toolCalls
    });

    for (const tc of toolCalls.slice(0, 4)) {
      signal?.throwIfAborted();
      const fnName = tc?.function?.name || '';
      let args = {};
      try { args = JSON.parse(tc?.function?.arguments || '{}'); } catch { args = {}; }
      let toolResult = { error: '未知工具' };

      try {
        if (fnName === 'crawl_multi_sites') {
          const kw = String(args.keyword || '').trim();
          const sites = Array.isArray(args.sites) ? args.sites : undefined;
          const report = await crawlMultiSites(kw, settings, { ...options, sites });
          recordCrawl(report);
          toolResult = summarizeCrawlForPrompt(report);
        } else if (fnName === 'web_search_query') {
          const q = String(args.query || '').trim();
          const rep = await searchWebResources(q, settings, options);
          recordCrawl({ keyword: q, reports: [rep] });
          toolResult = rep;
        } else if (fnName === 'read_webpage') {
          const targetUrl = publicLink(args.url);
          if (!targetUrl) {
            toolResult = { error: '无效的 URL' };
          } else {
            const page = await webFetchFn(targetUrl);
            toolResult = {
              url: page.url,
              statusCode: page.statusCode,
              excerpt: cleanTitle(String(page.body || '').slice(0, 4000), 3500)
            };
          }
        }
      } catch (error) {
        signal?.throwIfAborted();
        toolResult = { error: String(error?.message ?? error).slice(0, 160) };
      }

      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(toolResult)
      });
    }
  }

  const parsed = extractJsonBlock(finalContent);
  const allItems = [...crawledMap.values()];
  return {
    parsed,
    rawSummary: finalContent,
    imageClues,
    crawledItems: allItems,
    sources: [...siteStats.values()]
  };
}
