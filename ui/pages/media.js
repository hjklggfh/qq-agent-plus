'use strict';

import { esc } from '../core/dom.js';

const DEFAULT_COLLECTION_KEYWORDS = ['合集', '歌单', '循环', '助眠', '白噪音', 'playlist', 'mix'];

function keywordsText(raw) {
  if (Array.isArray(raw) && raw.length) return raw.join(', ');
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  return DEFAULT_COLLECTION_KEYWORDS.join(', ');
}

function parseKeywords(raw, fallback = DEFAULT_COLLECTION_KEYWORDS) {
  if (Array.isArray(raw)) {
    const items = [...new Set(raw.map(item => String(item || '').trim()).filter(Boolean))];
    return items.length ? items : [...fallback];
  }
  const items = [...new Set(String(raw || '').split(/[,，\n\r]+/).map(s => s.trim()).filter(Boolean))];
  return items.length ? items : [...fallback];
}

function clamp(n, min, max, fallback) {
  const num = Number(n);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function renderMediaSection(c = {}) {
  const b = c?.bilibili || {};
  const d = c?.douyin || {};
  const qn = Number(b.qn) || 16;
  return `
    <h3 id="settings-bilibili">B站视频搜索与转发</h3>
    <div class="hint">宿主内置 B 站解析与下载接口（免额外工具，无需登录），直接识别群内视频/番剧单集（/ep）/b23 短链与分享卡片并转发，不消耗模型 token。</div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-bili-enabled" ${b.enabled === true ? 'checked' : ''} /><label for="cfg-bili-enabled">启用 B 站自动下载与转发</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-bili-private" ${b.allowPrivate === true ? 'checked' : ''} /><label for="cfg-bili-private">处理白名单私聊中的 B 站链接</label></div>
    <div class="field-row">
      <div class="field"><label for="cfg-bili-qn">首选画质（超限时自动降级）</label><select id="cfg-bili-qn">
        <option value="6" ${qn === 6 ? 'selected' : ''}>240P 极速</option>
        <option value="16" ${qn === 16 ? 'selected' : ''}>360P 流畅（推荐）</option>
        <option value="32" ${qn === 32 ? 'selected' : ''}>480P 清晰</option>
        <option value="64" ${qn === 64 ? 'selected' : ''}>720P 高清</option>
        <option value="80" ${qn === 80 ? 'selected' : ''}>1080P 高清</option>
      </select></div>
      <div class="field"><label for="cfg-bili-max-duration">最大时长（秒）</label><input type="number" id="cfg-bili-max-duration" min="30" max="7200" value="${esc(b.maxDurationSeconds ?? 900)}" /></div>
      <div class="field"><label for="cfg-bili-max-size">最大文件（MiB）</label><input type="number" id="cfg-bili-max-size" min="20" max="1024" value="${esc(Math.round((b.maxFileBytes || 314572800) / 1048576))}" /></div>
      <div class="field"><label for="cfg-bili-concurrent">并发下载数</label><input type="number" id="cfg-bili-concurrent" min="1" max="3" value="${esc(b.maxConcurrent ?? 1)}" /></div>
    </div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-bili-reject-collections" ${b.rejectCollections !== false ? 'checked' : ''} /><label for="cfg-bili-reject-collections">跳过合集、歌单、循环和助眠内容</label></div>
    <div class="field-row">
      <div class="field"><label for="cfg-bili-collection-keywords">合集/屏蔽关键词（逗号分隔）</label><input id="cfg-bili-collection-keywords" value="${esc(keywordsText(b.collectionKeywords))}" /></div>
      <div class="field"><label for="cfg-bili-uploader">UP 主筛选（可留空）</label><input id="cfg-bili-uploader" value="${esc(b.preferredUploader || '')}" /></div>
    </div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-bili-keyword-completion" ${b.keywordCompletion !== false ? 'checked' : ''} /><label for="cfg-bili-keyword-completion">搜索关键词自动补全 B 站词条</label></div>
    <div class="field-row">
      <div class="field"><label for="cfg-bili-search-limit">搜索结果数量</label><input type="number" id="cfg-bili-search-limit" min="1" max="10" value="${esc(b.searchLimit ?? 5)}" /></div>
      <div class="field"><label for="cfg-bili-search-duration">搜索最大时长（秒）</label><input type="number" id="cfg-bili-search-duration" min="30" max="7200" value="${esc(b.searchMaxDurationSeconds ?? 900)}" /></div>
      <div class="field"><label for="cfg-bili-sort">搜索排序</label><select id="cfg-bili-sort"><option value="relevance" ${b.searchSort === 'relevance' ? 'selected' : ''}>相关度</option><option value="date" ${b.searchSort === 'date' ? 'selected' : ''}>最新</option><option value="views" ${b.searchSort === 'views' ? 'selected' : ''}>播放量</option><option value="duration" ${b.searchSort === 'duration' ? 'selected' : ''}>时长</option></select></div>
    </div>
    <hr />
    <h3 id="settings-douyin">抖音媒体转发</h3>
    <div class="hint">自动识别抖音短链（v.douyin.com）、网页/分享链接、口令文案与 QQ 分享卡片，免登录解析并转发无水印视频或图文作品（自动过滤带背景音乐的纯图文）。</div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-dy-enabled" ${d.enabled === true ? 'checked' : ''} /><label for="cfg-dy-enabled">启用抖音自动下载与转发</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-dy-private" ${d.allowPrivate === true ? 'checked' : ''} /><label for="cfg-dy-private">处理白名单私聊中的抖音链接</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-dy-forward-gallery" ${d.forwardGallery !== false ? 'checked' : ''} /><label for="cfg-dy-forward-gallery">启用抖音图文作品转发</label></div>
    <div class="field-row">
      <div class="field"><label for="cfg-dy-quality">首选画质（超限时自动降级）</label><select id="cfg-dy-quality">
        <option value="540p" ${d.preferredQuality === '540p' ? 'selected' : ''}>540P 流畅（省流快速）</option>
        <option value="720p" ${(!d.preferredQuality || d.preferredQuality === '720p') ? 'selected' : ''}>720P 高清（推荐默认）</option>
        <option value="1080p" ${d.preferredQuality === '1080p' ? 'selected' : ''}>1080P 原画</option>
        <option value="highest" ${d.preferredQuality === 'highest' ? 'selected' : ''}>最高可用画质</option>
      </select></div>
      <div class="field"><label for="cfg-dy-max-duration">最大时长（秒）</label><input type="number" id="cfg-dy-max-duration" min="30" max="7200" value="${esc(d.maxDurationSeconds ?? 900)}" /></div>
      <div class="field"><label for="cfg-dy-max-size">最大文件（MiB）</label><input type="number" id="cfg-dy-max-size" min="10" max="1024" value="${esc(Math.round((d.maxFileBytes || 104857600) / 1048576))}" /></div>
      <div class="field"><label for="cfg-dy-concurrent">并发下载数</label><input type="number" id="cfg-dy-concurrent" min="1" max="3" value="${esc(d.maxConcurrent ?? 1)}" /></div>
      <div class="field"><label for="cfg-dy-max-gallery-images">图文最大张数</label><input type="number" id="cfg-dy-max-gallery-images" min="1" max="30" value="${esc(d.maxGalleryImages ?? 12)}" /></div>
    </div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-dy-reject-collections" ${d.rejectCollections === true ? 'checked' : ''} /><label for="cfg-dy-reject-collections">跳过合集、歌单、循环和助眠内容</label></div>
    <div class="field-row">
      <div class="field"><label for="cfg-dy-collection-keywords">合集/屏蔽关键词（逗号分隔）</label><input id="cfg-dy-collection-keywords" value="${esc(keywordsText(d.collectionKeywords))}" /></div>
      <div class="field"><label for="cfg-dy-author">作者筛选（可留空）</label><input id="cfg-dy-author" value="${esc(d.preferredAuthor || '')}" /></div>
    </div>`;
}

function collectMediaPatch(c = {}) {
  const el = (sel) => (typeof document !== 'undefined' ? document.querySelector(sel) : null);
  const val = (sel, fallback = '') => {
    const node = el(sel);
    return node ? node.value : fallback;
  };
  const chk = (sel, fallback = false) => {
    const node = el(sel);
    return node ? node.checked : fallback;
  };

  const b = c?.bilibili || {};
  const d = c?.douyin || {};

  return {
    bilibili: {
      ...b,
      enabled: chk('#cfg-bili-enabled', b.enabled === true),
      allowPrivate: chk('#cfg-bili-private', b.allowPrivate === true),
      downloader: 'bilibili-api',
      ffmpeg: 'unused',
      qn: Math.round(clamp(val('#cfg-bili-qn', b.qn ?? 16), 6, 80, 16)),
      maxDurationSeconds: Math.round(clamp(val('#cfg-bili-max-duration', b.maxDurationSeconds ?? 900), 30, 7200, 900)),
      maxFileBytes: Math.round(clamp(val('#cfg-bili-max-size', Math.round((b.maxFileBytes || 314572800) / 1048576)), 20, 1024, 300)) * 1048576,
      maxConcurrent: Math.round(clamp(val('#cfg-bili-concurrent', b.maxConcurrent ?? 1), 1, 3, 1)),
      rejectCollections: chk('#cfg-bili-reject-collections', b.rejectCollections !== false),
      collectionKeywords: parseKeywords(
        el('#cfg-bili-collection-keywords') ? val('#cfg-bili-collection-keywords', '') : b.collectionKeywords,
        DEFAULT_COLLECTION_KEYWORDS
      ).slice(0, 40),
      preferredUploader: val('#cfg-bili-uploader', b.preferredUploader || '').trim(),
      keywordCompletion: chk('#cfg-bili-keyword-completion', b.keywordCompletion !== false),
      searchLimit: Math.round(clamp(val('#cfg-bili-search-limit', b.searchLimit ?? 5), 1, 10, 5)),
      searchMaxDurationSeconds: Math.round(clamp(val('#cfg-bili-search-duration', b.searchMaxDurationSeconds ?? 900), 30, 7200, 900)),
      searchSort: ['relevance', 'date', 'views', 'duration'].includes(val('#cfg-bili-sort', b.searchSort || 'relevance'))
        ? val('#cfg-bili-sort', b.searchSort || 'relevance')
        : 'relevance'
    },
    douyin: {
      ...d,
      enabled: chk('#cfg-dy-enabled', d.enabled === true),
      allowPrivate: chk('#cfg-dy-private', d.allowPrivate === true),
      preferredQuality: ['540p', '720p', '1080p', 'highest'].includes(val('#cfg-dy-quality', d.preferredQuality || '720p'))
        ? val('#cfg-dy-quality', d.preferredQuality || '720p')
        : '720p',
      forwardGallery: chk('#cfg-dy-forward-gallery', d.forwardGallery !== false),
      maxGalleryImages: Math.round(clamp(val('#cfg-dy-max-gallery-images', d.maxGalleryImages ?? 12), 1, 30, 12)),
      maxDurationSeconds: Math.round(clamp(val('#cfg-dy-max-duration', d.maxDurationSeconds ?? 900), 30, 7200, 900)),
      maxFileBytes: Math.round(clamp(val('#cfg-dy-max-size', Math.round((d.maxFileBytes || 104857600) / 1048576)), 10, 1024, 100)) * 1048576,
      maxConcurrent: Math.round(clamp(val('#cfg-dy-concurrent', d.maxConcurrent ?? 1), 1, 3, 1)),
      rejectCollections: chk('#cfg-dy-reject-collections', d.rejectCollections === true),
      collectionKeywords: parseKeywords(
        el('#cfg-dy-collection-keywords') ? val('#cfg-dy-collection-keywords', '') : d.collectionKeywords,
        DEFAULT_COLLECTION_KEYWORDS
      ).slice(0, 40),
      preferredAuthor: val('#cfg-dy-author', d.preferredAuthor || '').trim()
    }
  };
}

function bindMediaSection(c = {}) {
  if (typeof document === 'undefined') return;
  const b = c?.bilibili || {};
  const d = c?.douyin || {};
  const qnEl = document.querySelector('#cfg-bili-qn');
  if (qnEl) {
    const qnStr = String(Number(b.qn) || 16);
    qnEl.value = ['6', '16', '32', '64', '80'].includes(qnStr) ? qnStr : '16';
  }
  const sortEl = document.querySelector('#cfg-bili-sort');
  if (sortEl) {
    const sortStr = String(b.searchSort || 'relevance');
    sortEl.value = ['relevance', 'date', 'views', 'duration'].includes(sortStr) ? sortStr : 'relevance';
  }
  const dyQualityEl = document.querySelector('#cfg-dy-quality');
  if (dyQualityEl) {
    const dyQ = String(d.preferredQuality || '720p');
    dyQualityEl.value = ['540p', '720p', '1080p', 'highest'].includes(dyQ) ? dyQ : '720p';
  }
}

export { renderMediaSection, renderMediaSection as renderBilibiliSection, bindMediaSection, collectMediaPatch };
