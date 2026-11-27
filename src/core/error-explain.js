// 统一报错可读性解释层：
// - 面向管理员（私聊告警 / 控制台异常页 / 会话详情 / 健康巡检）：说明异常原因、处理建议与精简技术摘要。
// - 面向群友（群聊功能报错 / 合并转发未确认提示）：隐去内部运维细节与协议原文，给出清晰原因与后续建议。
// 纯函数，无 I/O；内部统一走 redactText 脱敏。
import { redactText } from './redact.js';

export const SOURCE_LABELS = Object.freeze({
  orchestrator: '对话调度',
  sender: 'QQ 发送',
  'onebot-ingress': '消息接收',
  'qzone-interactions': '空间互动',
  'daily-moments': '每日说说',
  'identity-pilot': '身份记忆',
  bilibili: 'B站转发',
  douyin: '抖音转发',
  jm: 'JM 功能',
  pixiv: 'Pixiv 功能',
  'haigui-tang': '海龟汤',
  'group-game': '群游戏',
  'group-digest': '群日报',
  http: '控制台接口',
  process: '主进程',
  'auto-update': '自动更新',
  application: '主程序'
});

const TOOL_LABELS = Object.freeze({
  get_message_audio: '语音转文字',
  generate_image: 'AI 画图',
  pixiv_image: 'Pixiv 取图',
  send_message: '工具调用（发消息）',
  send_face: '工具调用（发系统表情）',
  send_sticker: '工具调用（发表情包）',
  collect_sticker: '工具调用（收表情包）',
  send_poke: '工具调用（戳一戳）',
  get_message_images: '工具调用（读图片）',
  get_message_detail: '工具调用（查消息详情）',
  memory_append: '工具调用（写记忆）',
  person_memory_lookup: '工具调用（查人物记忆）',
  search_chat_history: '工具调用（查聊天记录）',
  jm_rank: 'JM 功能',
  jm_search: 'JM 功能',
  download_album: 'JM 功能',
  group_game: '群游戏'
});

export const SEVERITY_LABELS = Object.freeze({
  critical: '严重',
  error: '错误',
  warning: '警告',
  info: '信息'
});

export const HEALTH_CHECK_META = Object.freeze({
  'console-healthz': {
    label: '机器人主服务状态',
    explain: '无法连接本地控制台，主进程可能无响应、重启中或已退出'
  },
  'onebot-status': {
    label: 'QQ 协议端连接',
    explain: '无法连接本地 QQ 协议端，暂时无法收发消息，请检查 QQ 客户端或协议端状态'
  },
  'outbound-freshness': {
    label: '消息处理进度',
    explain: '存在到期较久仍未处理的入站消息，收发或模型调用链路可能停滞'
  },
  'disk-space': {
    label: '服务器磁盘空间',
    explain: '可用磁盘空间不足 1 GB，请及时清理旧缓存或日志文件'
  },
  'auto-update': {
    label: '自动更新任务',
    explain: '最近一次自动更新失败，请前往控制台查看更新详情'
  },
  'deploy-interrupted': {
    label: '部署状态检查',
    explain: '上次部署中途中断未完成收尾，请按部署文档执行恢复'
  },
  'sqlite-integrity': {
    label: '消息数据库完整性',
    explain: '消息数据库自检未通过，建议尽快备份并排查文件状态'
  }
});

export const FORWARD_UNCERTAIN_HINTS = Object.freeze({
  jmSearch: '⚠️ 搜索结果卡片已发出，但未收到 QQ 送达回执。若群内未显示，可能触发了群转发限制，请尝试更换关键词或改用私聊搜索（如已显示请忽略）。',
  generic: '⚠️ 结果卡片已发出，但未收到 QQ 送达回执。若群内未显示，可能是图片或外链触发了群转发限制，请稍后再试或改用私聊查询（如已显示请忽略）。'
});

export function formatSourceLabel(source = '') {
  const raw = String(source || '').trim();
  if (!raw) return '系统模块';
  if (Object.hasOwn(SOURCE_LABELS, raw)) return SOURCE_LABELS[raw];
  if (raw.startsWith('tool:')) {
    const tool = raw.slice(5);
    if (Object.hasOwn(TOOL_LABELS, tool)) return TOOL_LABELS[tool];
    return `工具调用（${tool || '未知'}）`;
  }
  return raw;
}

export function formatChatLabel(chatKey = '', chatName = '') {
  const key = String(chatKey || '').trim();
  if (!key) return '';
  const name = String(chatName || '').replace(/\s+/g, ' ').trim();
  const groupMatch = /^group:(\d+)$/.exec(key);
  if (groupMatch) return name ? `${name}(${groupMatch[1]})` : `群 ${groupMatch[1]}`;
  const privateMatch = /^private:(\d+)$/.exec(key);
  if (privateMatch) return name ? `${name}(${privateMatch[1]})` : `私聊 ${privateMatch[1]}`;
  return name ? `${name}(${key})` : key;
}

/** 识别是否为 OneBot 送达未确认（QQ 未返回回执）。 */
export function isNoReceiptError(error) {
  const text = String(error?.message ?? error ?? '');
  return /\bno message receipt\b|\bdelivery was not confirmed\b/i.test(text);
}

/** 从嵌套 JSON / HTML 报错文本里提取精炼的一行技术摘要。 */
export function cleanTechSummary(raw, maxLen = 140) {
  let text = redactText(String(raw ?? ''), 2000).replace(/\r\n?/g, '\n').trim();
  if (!text) return '无详细错误信息';

  // 去掉整页 HTML 错误响应（常见于 Cloudflare 502/503/504 网关页）
  const htmlIdx = text.search(/<!doctype\s+html|<html[\s>]/i);
  if (htmlIdx >= 0) {
    const prefix = text.slice(0, htmlIdx).replace(/[:：\s]+$/, '').trim();
    text = prefix ? `${prefix}（上游返回 HTML 错误页）` : '上游返回 HTML 错误页';
  }

  // 尝试把常见的 "前缀：{json}" / "前缀：[{json}]" 压成 "前缀（core message）"
  const jsonStart = text.search(/[:：]\s*[[{]/);
  if (jsonStart >= 0) {
    const prefix = text.slice(0, jsonStart).trim();
    const tail = text.slice(jsonStart + 1).trim();
    const extracted = extractJsonErrorMessage(tail);
    if (extracted) {
      text = prefix ? `${prefix}（${extracted}）` : extracted;
    }
  }

  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > maxLen) return `${text.slice(0, maxLen - 1)}…`;
  return text;
}

function extractJsonErrorMessage(jsonText) {
  const s = String(jsonText || '').trim();
  try {
    const parsed = JSON.parse(s);
    const obj = Array.isArray(parsed) ? parsed[0] : parsed;
    const msg = obj?.error?.message ?? obj?.message ?? obj?.msg ?? '';
    if (typeof msg === 'string' && msg.trim()) {
      return msg.replace(/\s+/g, ' ').trim().slice(0, 120);
    }
  } catch {
    // JSON 被上游或日志截断时，退回正则提取 "message": "..."
    const m = /"message"\s*:\s*"([^"\\]{4,180}(?:\\.[^"\\]*)*)"/.exec(s);
    if (m?.[1]) {
      return m[1].replace(/\\n/g, ' ').replace(/\\"/g, '"').replace(/\s+/g, ' ').trim().slice(0, 120);
    }
  }
  return '';
}

/** 检测明确的鉴权失效或余额不足（工具调用中这类错误应提级通知管理员，避免静默欠费）。 */
export function isBillingOrAuthFailure(message) {
  const text = String(message ?? '');
  return /(?:HTTP\s*40[12]|返回\s*40[12])(?!\d)/i.test(text)
    || /authentication_error|invalid_api_key|api key[^.\n]{0,40}invalid|unauthorized/i.test(text)
    || /insufficient_quota|balance is insufficient|余额不足|欠费|quota exceeded/i.test(text);
}

/**
 * 判定 moduleLog 捕获到的后台模块警告的告警级别：
 * - 非活跃时段按规则拦截：info（记录但不打扰）
 * - 已自动兜底或等待协议端重连的降级提示：warning（记入异常面板，但不按 error 刷屏私聊）
 * - 其余异常：保持 error
 */
export function classifyModuleLogSeverity(source, message) {
  const text = String(message ?? '');
  if (/非活跃时间，禁止发送消息|TIME_CONTROL_INACTIVE/.test(text)) return 'info';
  if (/本轮改用已关注动态兜底|先按消息与旧记忆建库/.test(text)) return 'warning';
  if (source === 'qzone-interactions' && /暂未获取到登录账号|登录账号已改变（[^）]*当前\s*未知/.test(text)) {
    return 'warning';
  }
  return 'error';
}

function extractHttpStatus(text) {
  const m = /(?:HTTP|状态码|返回)\s*([45]\d{2})\b/i.exec(text)
    || /"code"\s*:\s*([45]\d{2})\b/.exec(text);
  return m ? Number(m[1]) : 0;
}

/**
 * 把任意异常转成面向管理员的结构化可读说明。
 * @returns {{ sourceLabel: string, title: string, advice: string, summary: string }}
 */
export function explainError(message, { source = '', code = '', details = {} } = {}) {
  const raw = String(message ?? '');
  const src = String(source || '');
  const sourceLabel = formatSourceLabel(src);
  const summary = cleanTechSummary(raw, 140);
  const httpStatus = extractHttpStatus(raw);
  const forwardLabel = String(details?.label || '').replace(/\s+/g, ' ').trim().slice(0, 30);

  // 1. QQ 发送无回执 / 未知送达
  if (isNoReceiptError(raw)) {
    const isForward = details?.type === 'forward' || /send_.*forward_msg/i.test(raw);
    const what = isForward
      ? (forwardLabel ? `发送「${forwardLabel}」合并转发卡片后` : '发送合并转发消息后')
      : '发送 QQ 消息后';
    return {
      sourceLabel,
      title: isForward
        ? `${what}未收到 QQ 送达回执，无法确认是否已送达（可能触发群转发风控拦截，或回执丢失）`
        : `${what}未收到送达回执，无法确认对方是否已收到`,
      advice: '机器人运行正常；为避免重复发送不会自动重试，请核对对应会话记录',
      summary
    };
  }

  if (/Delivery uncertain; batch held/i.test(raw)) {
    return {
      sourceLabel,
      title: '上一批消息发送结果未知，已暂挂等待人工核对',
      advice: '新消息可正常处理；核对会话记录确认发送情况后，可在控制台「聊天」页放行',
      summary
    };
  }

  // 2. 非活跃时间 / 主动取消
  if (code === 'TIME_CONTROL_INACTIVE' || code === 'EXPECTED_CANCELLATION'
    || /非活跃时间，禁止发送消息|^(?:Run cancelled|Daily moments stopped)$/.test(raw)) {
    return {
      sourceLabel,
      title: '当前处于静默/非活跃时段或任务已取消，按规则跳过发送',
      advice: '属于预期规则生效，无需处理',
      summary
    };
  }

  // 3. 空间互动专题
  if (src === 'qzone-interactions' || /\[qzone-interactions\]/.test(raw)) {
    if (/暂未获取到登录账号|登录账号已改变（[^）]*当前\s*未知/.test(raw)) {
      return {
        sourceLabel,
        title: 'QQ 协议端暂未连接，未能获取当前登录账号，本轮跳过空间互动',
        advice: '并非切换账号，请勿清空状态文件；等待 QQ 协议端恢复连接即可',
        summary
      };
    }
    if (/登录账号已改变/.test(raw)) {
      return {
        sourceLabel,
        title: '当前登录 QQ 号与空间互动历史状态不一致，已暂停执行以防串号',
        advice: '若确实更换了 QQ 账号，请清空 qzone-interactions 状态文件；否则请切回原账号',
        summary
      };
    }
    if (/code=-3000|请先登录空间/.test(raw)) {
      return {
        sourceLabel,
        title: 'QQ 空间登录态已失效，无法获取个人动态（已自动改用已关注动态兜底）',
        advice: '已启用兜底，不影响正常聊天；如需恢复个人动态扫描请刷新空间登录态',
        summary
      };
    }
    if (/自己的动态列表不可用|get_qzone_msg_list/.test(raw)) {
      return {
        sourceLabel,
        title: '获取个人空间动态接口返回异常，已自动改用已关注动态兜底',
        advice: '已启用兜底，偶发可忽略；如持续出现请检查空间登录态或协议端状态',
        summary
      };
    }
  }

  // 4. 身份建库同步好友列表
  if (src === 'identity-pilot' && /好友列表读取失败/.test(raw)) {
    return {
      sourceLabel,
      title: '同步好友列表时未能连接 QQ 协议端，已先使用既有记录继续运行',
      advice: '常随 QQ 协议端重启或闪断出现，连接恢复后将自动同步，通常无需处理',
      summary
    };
  }

  // 5. QQ 发送层常见业务/连接错误
  if (/result=120\b/.test(raw)) {
    return {
      sourceLabel,
      title: '群消息被 QQ 拒绝，机器人可能已被禁言或该群已开启全员禁言',
      advice: '请检查机器人在对应群聊中的发言权限',
      summary
    };
  }
  if (/result=16\b|请先添加对方为好友/.test(raw)) {
    return {
      sourceLabel,
      title: '对方非机器人好友，私聊消息被 QQ 拒绝发送',
      advice: '属于 QQ 正常限制，通常无需处理',
      summary
    };
  }
  if (code === 'STICKER_LINK_DEAD' || /HTTP download failed:\s*404|图片链接已经失效/.test(raw)) {
    return {
      sourceLabel,
      title: '待发送的图片或表情链接已失效（HTTP 404）',
      advice: '请更换图片或清理该失效表情资产',
      summary
    };
  }
  if (src === 'sender' && /ECONNRESET|UND_ERR_SOCKET|other side closed|qq_hook client closed|ECONNREFUSED|WebSocket is not open|fetch failed/i.test(raw)) {
    return {
      sourceLabel,
      title: '与本地 QQ 协议端的连接中途断开，本次发送结果未知',
      advice: '常见于 QQ 协议端重启或网络闪断；请确认协议端在线，必要时在控制台核对发送记录',
      summary
    };
  }
  if (src === 'sender' && /timeout|aborted|超过\s*\d+ms\s*未返回/i.test(raw)) {
    return {
      sourceLabel,
      title: '发送消息超时，无法确认 QQ 侧是否已送达',
      advice: '常见于发送较大媒体文件或协议端响应较慢；请核对对应会话记录',
      summary
    };
  }

  // 6. 模型 API 特定错误
  if (/reasoning_content/i.test(raw) && (httpStatus === 400 || /thinking/i.test(raw))) {
    return {
      sourceLabel,
      title: '模型接口拒绝请求：开启思考模式时，历史上下文缺少思考字段（reasoning_content）',
      advice: '本轮未回复。偶发可忽略；如频繁出现，请检查思考模式或跨模型切换配置',
      summary
    };
  }
  if (/thought_signature/i.test(raw)) {
    return {
      sourceLabel,
      title: 'Gemini 接口拒绝请求：历史工具调用缺少思考签名（thought_signature）',
      advice: '本轮未回复。常见于跨模型切换或中转站格式兼容问题，偶发可先观察',
      summary
    };
  }
  if (/unsupported image/i.test(raw)) {
    return {
      sourceLabel,
      title: '提交给模型的图片格式不受支持',
      advice: '本轮未回复。通常由损坏图片或非常见图片格式引起，一般无需处理',
      summary
    };
  }

  // 7. 通用鉴权 / 余额 / 限流 / 404 / 5xx（模型和工具通用）
  if (httpStatus === 401 || /authentication_error|invalid_api_key|api key[^.\n]{0,40}invalid/i.test(raw)) {
    return {
      sourceLabel,
      title: `${sourceLabel}接口密钥（API Key）无效或已过期（HTTP 401）`,
      advice: '需要处理：请前往控制台检查对应渠道的 API Key 配置',
      summary
    };
  }
  if (httpStatus === 402 || /insufficient_quota|balance is insufficient|余额不足|欠费/i.test(raw)) {
    return {
      sourceLabel,
      title: `${sourceLabel}服务账户余额不足或额度已用尽${httpStatus ? `（HTTP ${httpStatus}）` : ''}`,
      advice: '需要处理：请前往服务商后台核对余额或充值，或在控制台切换备用渠道',
      summary
    };
  }
  if (httpStatus === 429 || /rate.?limit|quota exceeded|访问量过大/i.test(raw)) {
    return {
      sourceLabel,
      title: `${sourceLabel}接口触发限流，或当前额度已达上限（HTTP 429）`,
      advice: '通常为短时请求频次过高或免费额度耗尽；如持续出现请检查额度或切换渠道',
      summary
    };
  }
  if (httpStatus === 404 && (/模型 API|chat\/completions/i.test(raw) || src === 'orchestrator')) {
    return {
      sourceLabel,
      title: '模型接口地址（Base URL）或模型名称不存在（HTTP 404）',
      advice: '需要处理：请前往控制台「设置 → 模型」核对接口路径与模型名称',
      summary
    };
  }
  if (httpStatus >= 500 && httpStatus <= 599) {
    return {
      sourceLabel,
      title: `${sourceLabel}上游服务暂时拥堵或返回异常（HTTP ${httpStatus}）`,
      advice: '属于上游服务波动，通常稍后会自动恢复；如长时间未恢复可临时切换备用渠道',
      summary
    };
  }

  // 8. 编排器 / 工具超时
  if (/Run deadline exceeded/i.test(raw)) {
    return {
      sourceLabel,
      title: '单轮对话执行耗时超出总时限，已强制中断',
      advice: '本轮未能完成回复。偶发可忽略；如频繁出现说明模型响应过慢或工具阻塞',
      summary
    };
  }
  if (/模型请求超时/.test(raw)) {
    return {
      sourceLabel,
      title: '等待模型响应超过单次请求时限',
      advice: '本轮未回复。通常由上游接口延迟或网络波动导致，请稍后观察',
      summary
    };
  }
  if (/执行超时|图片生成超时|请求超时|timed out|due to timeout/i.test(raw)) {
    return {
      sourceLabel,
      title: `${sourceLabel}等待响应超时，本次操作未完成`,
      advice: '通常由外部服务响应缓慢或网络波动引起，偶发可忽略',
      summary
    };
  }

  // 9. 模型调用工具自纠正类（非系统故障）
  if (src.startsWith('tool:') && (
    /未知工具|找不到表情|不要在 send_message 里发送|不是当前会话中出现过的成员|只能查询当前私聊对象|请先用trpg_update|请给出具体关键词|画面描述太长|收藏额度用完了|没有找到当前会话允许分级/.test(raw)
  )) {
    return {
      sourceLabel,
      title: `模型调用「${sourceLabel}」时参数或条件不符，已按规则拦截`,
      advice: '属于参数校验拦截（模型会自行调整），通常无需人工处理',
      summary
    };
  }

  // 10. 通用网络连接失败
  if (/fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|UND_ERR_SOCKET/i.test(raw)) {
    return {
      sourceLabel,
      title: `${sourceLabel}发起网络请求时连接中断或无法到达目标服务`,
      advice: '通常为目标站点波动或网络抖动，偶发可先观察',
      summary
    };
  }

  return {
    sourceLabel,
    title: `${sourceLabel}发生异常：${summary}`,
    advice: '如反复出现，可前往控制台「异常」页查看完整上下文',
    summary
  };
}

/** 格式化私聊给管理员的异常提醒（支持首报 + 满 N 次简短追报）。 */
export function formatIncidentNotification(incident, { chatName = '', escalationCount = 0 } = {}) {
  const exp = explainError(incident?.message || incident?.code || '', {
    source: incident?.source || '',
    code: incident?.code || '',
    details: incident?.details || {}
  });
  const where = formatChatLabel(incident?.chatKey, chatName);

  if (Number(escalationCount) >= 2) {
    return [
      '【QQ Agent 连续异常追报】',
      `模块「${exp.sourceLabel}」同一异常在合并窗口内已连续触发 ${escalationCount} 次${where ? `（${where}）` : ''}。`,
      `异常说明：${exp.title}`,
      `处理建议：${exp.advice}`,
      `编号：${incident?.id || '-'}（控制台 → 异常）`
    ].join('\n');
  }

  const severity = SEVERITY_LABELS[incident?.severity] || incident?.severity || '错误';
  const count = Math.max(1, Number(incident?.count) || 1);
  return [
    '【QQ Agent 异常提醒】',
    `异常说明：${exp.title}`,
    `处理建议：${exp.advice}`,
    `位置：${exp.sourceLabel}${where ? ` · ${where}` : ''} · 等级：${severity}（第 ${count} 次）`,
    `技术摘要：${exp.summary}`,
    `编号：${incident?.id || '-'}（控制台 → 异常）`
  ].join('\n');
}

/** 格式化健康巡检告警文案（保留检查项英文 ID，兼容运维与单测）。 */
export function formatHealthAlert(check, count) {
  const name = String(check?.name || 'unknown');
  const meta = HEALTH_CHECK_META[name] || {
    label: name,
    explain: '巡检项连续未通过，请登录服务器或控制台排查'
  };
  const detail = String(check?.detail || '无详情').trim();
  return [
    '【QQ Agent 健康告警】',
    `异常项：${meta.label}（${name}）连续 ${count} 次检查失败`,
    `说明：${meta.explain}`,
    `详情：${detail}`,
    '（每 5 分钟巡检一次，恢复后会另行通知）'
  ].join('\n');
}

/** 格式化健康巡检恢复文案。 */
export function formatHealthRecovery(check) {
  const name = String(check?.name || 'unknown');
  const meta = HEALTH_CHECK_META[name];
  return meta
    ? `【QQ Agent 健康恢复】${meta.label}（${name}）已恢复正常`
    : `【QQ Agent 健康恢复】${name} 已恢复正常`;
}

/**
 * 面向群友的群文件/私聊文件上传失败说明（JM 与搜小说共用）。
 * 注意：对 -134 不武断归因为“审核”，并保留简洁尝试次数摘要以便诊断。
 */
export function formatGroupUploadError(result) {
  const raw = String(result?.error ?? result ?? '文件上传失败').trim();
  // 空间不足、文件数超限等已有清晰说明直接保留
  if (/群文件空间不足|群文件数量已达上限|超过单文件上限/.test(raw)) return raw;

  const attempts = Number(result?.attempts) || 0;
  const retries = Number(result?.retries) || 0;
  const filenameRetries = Number(result?.filenameRetries) || 0;
  const stats = attempts > 0
    ? `（已尝试 ${attempts} 次，${retries ? `自动重试 ${retries} 次` : '未自动重试'}${filenameRetries ? `，备用文件名重试 ${filenameRetries} 次` : ''}）`
    : '';

  if (/(?:^|[^\d])-134(?:$|[^\d])/.test(raw)) {
    const triedNames = filenameRetries > 0 ? '原文件名与编号文件名均未通过，' : '';
    return `QQ 拒绝接收该文件（${triedNames}错误码 -134；QQ 未返回具体原因，可能与群文件权限/限额、内容拦截或上传网络波动有关，请稍后再试或联系管理员排查）${stats}`;
  }
  if (/timeout|timed out|aborted|fetch failed|ECONNRESET|UND_ERR_SOCKET|ECONNREFUSED/i.test(raw)) {
    return `文件上传超时或连接中断，无法确认是否已成功上传（可能因文件较大、网络波动或协议端繁忙导致），请先核对群文件列表后再决定是否重发${stats}`;
  }
  if (/没有 file_id|私聊文件上传可能未完成/.test(raw)) {
    return `文件已尝试发送，但未收到 QQ 完成确认（可能因协议端响应超时或网络波动导致），请先核对是否已收到${stats}`;
  }
  const summary = cleanTechSummary(raw.replace(/OneBot\s+\w+\s+失败:\s*retcode=\d+\s*/gi, ''), 120);
  return `${summary}${stats && !summary.includes('已尝试') ? stats : ''}`;
}

/**
 * 面向群友的网络/源站类功能报错说明（B站、抖音、搜小说、JM 下载等）。
 */
export function formatGroupNetworkError(error, scene = '处理') {
  const raw = String(error?.message ?? error ?? '未知错误').trim();
  if (!raw) return `${scene}暂时失败，请稍后再试。`;
  if (/所有禁漫域名都连不上/.test(raw)) {
    return '当前漫画源站均无法连接（可能站点维护或域名变更），请稍后再试；若持续失败请联系管理员更新线路。';
  }
  if (/timeout|timed out|aborted|超时/i.test(raw)) {
    return `${scene}超时（网络波动或上游响应较慢），请稍后再试。`;
  }
  if (/fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|UND_ERR_SOCKET|other side closed/i.test(raw)) {
    return `${scene}时网络连接中断或暂时无法连接目标服务，请稍后再试。`;
  }
  const status = extractHttpStatus(raw);
  if (status === 429) return `${scene}触发上游频率限制，请稍后再试。`;
  if (status >= 500 && status <= 599) return `${scene}依赖的目标服务暂时异常（HTTP ${status}），请稍后再试。`;
  if (status === 403 || /Restricted Access|ip地区/i.test(raw)) {
    return `${scene}被目标站点拒绝访问，请稍后再试；若持续失败请联系管理员检查线路。`;
  }
  if (/retcode=|OneBot\s+\w+\s+失败|<!doctype|<html|\{"error":/i.test(raw)) {
    return `${scene}暂时失败（服务返回异常），请稍后再试。`;
  }
  return cleanTechSummary(raw, 140);
}
