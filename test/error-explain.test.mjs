import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  cleanTechSummary,
  classifyModuleLogSeverity,
  explainError,
  formatGroupNetworkError,
  formatGroupUploadError,
  formatHealthAlert,
  formatHealthRecovery,
  formatIncidentNotification,
  formatSourceLabel,
  FORWARD_UNCERTAIN_HINTS,
  isBillingOrAuthFailure,
  isNoReceiptError
} from '../src/core/error-explain.js';
import { IncidentPilotManager } from '../src/pilots/incident-pilot.js';
import { ImageSearchManager } from '../src/features/image-search/manager.js';
import { imageSearchCommand } from '../src/features/image-search/command.js';
import { QzoneInteractionManager } from '../src/features/qzone-interactions.js';

test('explainError 能把线上高频原始报错翻译成清晰人话并精简技术摘要', () => {
  const ds = explainError(
    '模型 API HTTP 400：{"error":{"message":"The `reasoning_content` in the thinking mode must be passed back to the API. (request_id: abc)","type":"invalid_request_error"}}',
    { source: 'orchestrator' }
  );
  assert.equal(ds.sourceLabel, '对话调度');
  assert.match(ds.title, /思考模式.*缺少思考字段/);
  assert.match(ds.advice, /本轮未回复/);
  assert.doesNotMatch(ds.summary, /"type":"invalid_request_error"/);

  const gemini = explainError(
    '模型 API HTTP 400：[{"error":{"code":400,"message":"Function call is missing a thought_signature in functionCall parts."}}]',
    { source: 'orchestrator' }
  );
  assert.match(gemini.title, /Gemini.*思考签名/);

  const deadline = explainError('Run deadline exceeded', { source: 'orchestrator' });
  assert.match(deadline.title, /耗时超出总时限|强制中断/);

  const forwardNoReceipt = explainError(
    'OneBot send_group_forward_msg 失败: retcode=100 group message delivery was not confirmed: QQ returned no message receipt; check the conversation before retrying',
    { source: 'sender', details: { type: 'forward', label: 'JM搜索 雪女' } }
  );
  assert.equal(forwardNoReceipt.sourceLabel, 'QQ 发送');
  assert.match(forwardNoReceipt.title, /JM搜索 雪女/);
  assert.match(forwardNoReceipt.title, /未收到 QQ 送达回执/);
  assert.match(forwardNoReceipt.advice, /不会自动重试/);

  const qzoneOffline = explainError(
    '[qzone-interactions] QQ 登录账号已改变（状态属于 3809305541，当前 未知），本轮跳过执行；如确认切换账号，请清空 qzone-interactions 状态文件',
    { source: 'qzone-interactions' }
  );
  assert.match(qzoneOffline.title, /暂未连接|未能获取当前登录账号/);
  assert.match(qzoneOffline.advice, /并非切换账号.*请勿清空状态文件/);

  const asr402 = explainError(
    '错误：语音识别失败：语音识别服务返回 402：{"code":30001,"message":"Sorry, your account balance is insufficient","data":null}',
    { source: 'tool:get_message_audio' }
  );
  assert.equal(asr402.sourceLabel, '语音转文字');
  assert.match(asr402.title, /余额不足|额度已用尽/);
  assert.match(asr402.advice, /充值|备用渠道/);

  const html502 = explainError(
    '错误：图片生成失败 HTTP 502：<!DOCTYPE html>\n<html><body>502 Bad Gateway</body></html>',
    { source: 'tool:generate_image' }
  );
  assert.match(html502.title, /HTTP 502/);
  assert.doesNotMatch(html502.summary, /<!DOCTYPE|<html/i);

  const toolSelfFix = explainError('错误：未知工具 finish', { source: 'tool:finish' });
  assert.match(toolSelfFix.advice, /无需人工处理/);
});

test('cleanTechSummary 脱敏且不会泄露 URL token 或 Bearer 密钥', () => {
  const s = cleanTechSummary('fetch https://example.com/api?token=topsecret123 Authorization: Bearer abcdef1234567890');
  assert.doesNotMatch(s, /topsecret123|abcdef1234567890/);
});

test('降噪与欠费提级规则准确区分预期内降级与需人工介入的 401/402', () => {
  assert.equal(classifyModuleLogSeverity('bilibili', '[bilibili] 转发失败：非活跃时间，禁止发送消息'), 'info');
  assert.equal(classifyModuleLogSeverity('qzone-interactions', '[qzone-interactions] 自己的动态列表不可用，本轮改用已关注动态兜底（fetch failed）'), 'warning');
  assert.equal(classifyModuleLogSeverity('qzone-interactions', '[qzone-interactions] QQ 协议端暂未获取到登录账号（历史状态属于 123），本轮跳过执行'), 'warning');
  assert.equal(classifyModuleLogSeverity('identity-pilot', '[identity-pilot] 好友列表读取失败，先按消息与旧记忆建库：fetch failed'), 'warning');
  assert.equal(classifyModuleLogSeverity('bilibili', '[bilibili] 转发失败：未知严重错误'), 'error');

  assert.equal(isBillingOrAuthFailure('错误：语音识别失败：语音识别服务返回 402：{"message":"account balance is insufficient"}'), true);
  assert.equal(isBillingOrAuthFailure('模型 API HTTP 401：invalid_api_key'), true);
  assert.equal(isBillingOrAuthFailure('错误：找不到表情「微笑」'), false);
  assert.equal(formatSourceLabel('tool:pixiv_image'), 'Pixiv 取图');
});

test('IncidentPilotManager 附带 explain 字段并在合并窗口满 3 次时补发一次简短追报', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-incident-explain-'));
  const cfg = {
    incidentPilot: {
      enabled: true,
      ownerUin: '10000003',
      notifyWarnings: false,
      duplicateWindowMinutes: 10,
      unknownWritesBlockChat: false,
      retentionDays: 90
    }
  };
  let now = Date.parse('2026-11-27T10:43:59Z');
  const sent = [];
  const manager = new IncidentPilotManager({
    dataDir,
    config: () => cfg,
    notifyAvailable: () => true,
    notify: async (incident, ownerUin, meta = {}) => {
      sent.push({
        ownerUin,
        escalationCount: meta.escalationCount || 0,
        text: formatIncidentNotification(incident, {
          chatName: '测试车群',
          escalationCount: meta.escalationCount || 0
        })
      });
    },
    now: () => now,
    emit: () => {},
    log: () => {}
  });
  t.after(async () => {
    await manager.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  manager.start();
  const err = new Error('OneBot send_group_forward_msg 失败: retcode=100 group message delivery was not confirmed: QQ returned no message receipt; check the conversation before retrying');
  const ctx = {
    source: 'sender',
    category: 'external_write',
    severity: 'critical',
    outcome: 'unknown',
    chatKey: 'group:892485992',
    details: { type: 'forward', label: 'JM搜索 雪女' }
  };

  // 第 1 次：首报
  const first = manager.capture(err, ctx);
  await manager.waitForIdle();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].escalationCount, 0);
  assert.match(sent[0].text, /【QQ Agent 异常提醒】/);
  assert.match(sent[0].text, /测试车群\(892485992\)/);
  assert.match(sent[0].text, /JM搜索 雪女/);
  assert.equal(first.explain.sourceLabel, 'QQ 发送');

  // 第 2 次：窗口内静默合并
  now += 60_000;
  const second = manager.capture(err, ctx);
  await manager.waitForIdle();
  assert.equal(second.id, first.id);
  assert.equal(second.count, 2);
  assert.equal(sent.length, 1);

  // 第 3 次：触发一次简短追报
  now += 60_000;
  const third = manager.capture(err, ctx);
  await manager.waitForIdle();
  assert.equal(third.count, 3);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].escalationCount, 3);
  assert.match(sent[1].text, /【QQ Agent 连续异常追报】/);
  assert.match(sent[1].text, /已连续触发 3 次/);

  // 第 4 次：不再重复刷屏追报
  now += 60_000;
  manager.capture(err, ctx);
  await manager.waitForIdle();
  assert.equal(sent.length, 2);
});

test('健康巡检与群聊面向群友的报错文案清晰友好且守住严谨边界', () => {
  const alert = formatHealthAlert({ name: 'onebot-status', detail: 'fetch failed' }, 3);
  assert.match(alert, /【QQ Agent 健康告警】/);
  assert.match(alert, /QQ 协议端连接（onebot-status）/);
  assert.match(alert, /说明：/);
  assert.match(formatHealthRecovery({ name: 'onebot-status' }), /【QQ Agent 健康恢复】.*QQ 协议端连接（onebot-status）/);

  const upload134 = formatGroupUploadError({
    attempts: 2,
    retries: 0,
    filenameRetries: 1,
    error: '上传群文件失败（已尝试 2 次，未自动重试，备用文件名重试 1 次）：原文件名：OneBot upload_group_file 失败: retcode=100 group file upload failed: code=-134 msg=文件上传失败（-134）'
  });
  assert.match(upload134, /QQ 拒绝接收该文件/);
  assert.match(upload134, /错误码 -134/);
  assert.match(upload134, /可能与群文件权限\/限额、内容拦截或上传网络波动有关/);
  assert.match(upload134, /已尝试 2 次，未自动重试，备用文件名重试 1 次/);
  assert.doesNotMatch(upload134, /审核|OneBot upload_group_file|retcode=100/);

  const quota = formatGroupUploadError({ error: '本群群文件空间不足，还差约 48 MB，请先清理旧文件' });
  assert.match(quota, /群文件空间不足/);

  const jmDomains = formatGroupNetworkError(
    new Error('所有禁漫域名都连不上（共试 8 个）：www.cdnhjk.net: HTTP 404。可以把当前可用的域名填进技能设置的「备用站点域名」'),
    '下载'
  );
  assert.match(jmDomains, /漫画源站均无法连接/);
  assert.doesNotMatch(jmDomains, /cdnhjk|备用站点域名/);

  assert.equal(isNoReceiptError(new Error('QQ returned no message receipt')), true);
  assert.equal(isNoReceiptError(new Error('timeout after remote send')), false);
  assert.match(FORWARD_UNCERTAIN_HINTS.jmSearch, /如已显示请忽略/);
  assert.match(FORWARD_UNCERTAIN_HINTS.generic, /如已显示请忽略/);
});

test('以图搜图群合并转发无回执时补发一条中性短提示且保持 send-unknown', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-img-uncertain-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sentTexts = [];
  const png1x1 = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex');
  const manager = new ImageSearchManager({
    dataDir: dir,
    getConfig: () => ({
      imageSearch: {
        enabled: true,
        relayUrl: 'http://127.0.0.1:9999',
        relayToken: 't'.repeat(40),
        allowedGroups: ['100001'],
        cooldownSeconds: 0,
        sendImages: true,
        platforms: { google: true, serpapi: false, yandex: false, trace: false }
      }
    }),
    canRun: () => true,
    download: async () => ({ buffer: png1x1, type: 'image/png' }),
    onebot: { selfId: '10001', selfNickname: 'Bot' },
    store: { findByMid: () => null },
    fetchImpl: async () => new Response(JSON.stringify({
      platform: 'google',
      status: 'ok',
      results: [{ title: '测试图', similarity: 95, url: 'https://example.com/1' }]
    }), { status: 200 }),
    forward: async () => {
      throw Object.assign(new Error('OneBot send_group_forward_msg 失败: retcode=100 group message delivery was not confirmed: QQ returned no message receipt'), { outcome: 'unknown' });
    },
    send: async (_chatKey, messages) => {
      sentTexts.push(...messages);
      return { sent: messages.map((text) => ({ text })), failed: [] };
    }
  });
  const cmd = imageSearchCommand([
    { type: 'text', data: { text: '搜图 Google' } },
    { type: 'image', data: { url: 'https://example.com/pic.png' } }
  ]);
  await manager.start(cmd, 'group:100001', 1);
  await manager.task;
  assert.equal(manager.history[0].status, 'send-unknown');
  assert.equal(sentTexts.length, 1);
  assert.equal(sentTexts[0], FORWARD_UNCERTAIN_HINTS.generic);
});

test('空间互动在协议端掉线（selfId 为空）时不误报换号也不提示清空状态文件', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-qzone-offline-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stateFile = path.join(dir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ accountId: '3809305541', watchedPosts: [], runs: [] }));
  const logs = [];
  const manager = new QzoneInteractionManager({
    onebot: { selfId: '' },
    stateFile,
    log: (...args) => logs.push(args.join(' '))
  });
  await manager.runNow('all');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /暂未获取到登录账号/);
  assert.match(logs[0], /无需清理状态文件/);
  assert.doesNotMatch(logs[0], /登录账号已改变/);
});
