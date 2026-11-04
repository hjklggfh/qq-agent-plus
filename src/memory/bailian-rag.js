import { safeSlice, sanitizeUserText } from '../core/util.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('bailian-rag');

export const BAILIAN_RAG_DEFAULTS = Object.freeze({
  enabled: false,
  apiKey: '',
  baseUrl: 'https://dashscope.aliyuncs.com',
  embeddingModel: 'text-embedding-v3',
  rerankModel: 'gte-rerank-v2',
  topN: 5,
  minScore: 0.15
});

/**
 * Normalizes and resolves Bailian RAG settings from config and environment.
 * Environment variables (DASHSCOPE_API_KEY / BAILIAN_API_KEY) take precedence
 * so keys can stay out of config files if preferred.
 */
export function getBailianRagSettings(cfg = {}) {
  const raw = cfg.memory?.bailian || {};
  const envKey = (process.env.DASHSCOPE_API_KEY || process.env.BAILIAN_API_KEY || '').trim();
  const rawKey = typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '';
  const apiKey = envKey || rawKey;

  const baseUrl = (typeof raw.baseUrl === 'string' && raw.baseUrl.trim())
    ? raw.baseUrl.trim().replace(/\/+$/, '')
    : BAILIAN_RAG_DEFAULTS.baseUrl;

  const embeddingModel = (typeof raw.embeddingModel === 'string' && raw.embeddingModel.trim())
    ? raw.embeddingModel.trim()
    : BAILIAN_RAG_DEFAULTS.embeddingModel;

  const rerankModel = (typeof raw.rerankModel === 'string' && raw.rerankModel.trim())
    ? raw.rerankModel.trim()
    : BAILIAN_RAG_DEFAULTS.rerankModel;

  const topN = Number.isInteger(raw.topN) && raw.topN >= 1 && raw.topN <= 20
    ? raw.topN
    : BAILIAN_RAG_DEFAULTS.topN;

  const minScore = typeof raw.minScore === 'number' && Number.isFinite(raw.minScore) && raw.minScore >= 0 && raw.minScore <= 1
    ? raw.minScore
    : BAILIAN_RAG_DEFAULTS.minScore;

  // Enabled only when explicitly true and apiKey is available
  const enabled = raw.enabled === true && Boolean(apiKey);

  return {
    enabled,
    apiKey,
    baseUrl,
    embeddingModel,
    rerankModel,
    topN,
    minScore
  };
}

/**
 * Validates a configuration patch for memory.bailian.
 */
export function validateBailianRagPatch(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.__replace__) {
    throw new Error('百炼 RAG 设置必须为普通对象');
  }
  if (Object.hasOwn(value, 'enabled') && typeof value.enabled !== 'boolean') {
    throw new Error('百炼 RAG enabled 必须为布尔值');
  }
  if (Object.hasOwn(value, 'apiKey') && typeof value.apiKey !== 'string') {
    throw new Error('百炼 RAG apiKey 必须为字符串');
  }
  if (Object.hasOwn(value, 'baseUrl') && (typeof value.baseUrl !== 'string' || !/^https?:\/\//i.test(value.baseUrl))) {
    throw new Error('百炼 RAG baseUrl 必须为有效的 http(s) URL');
  }
  if (Object.hasOwn(value, 'embeddingModel') && (typeof value.embeddingModel !== 'string' || !value.embeddingModel.trim())) {
    throw new Error('百炼 RAG embeddingModel 必须为非空字符串');
  }
  if (Object.hasOwn(value, 'rerankModel') && (typeof value.rerankModel !== 'string' || !value.rerankModel.trim())) {
    throw new Error('百炼 RAG rerankModel 必须为非空字符串');
  }
  if (Object.hasOwn(value, 'topN') && (!Number.isInteger(value.topN) || value.topN < 1 || value.topN > 20)) {
    throw new Error('百炼 RAG topN 必须为 1–20 的整数');
  }
  if (Object.hasOwn(value, 'minScore') && (typeof value.minScore !== 'number' || !Number.isFinite(value.minScore) || value.minScore < 0 || value.minScore > 1)) {
    throw new Error('百炼 RAG minScore 必须为 0–1 的浮点数');
  }
}

/**
 * Calls Alibaba Cloud DashScope / Bailian text-rerank API (e.g. gte-rerank).
 * Returns array of { index, score } sorted by relevance score descending.
 * Returns null on failure, invalid inputs or timeout to trigger graceful fallback.
 */
export async function rerankWithBailian({ query, documents, settings, signal, timeoutMs = 8000, throwOnError = false }) {
  if (!settings?.apiKey) {
    if (throwOnError) throw new Error('缺少 API Key');
    return null;
  }
  if (!query || !Array.isArray(documents) || !documents.length) {
    return null;
  }

  const cleanQuery = safeSlice(sanitizeUserText(String(query)).trim(), 1000);
  if (!cleanQuery) return null;

  const cleanDocs = documents.map((doc) => {
    const raw = typeof doc === 'string' ? doc : (doc?.text ?? '');
    return safeSlice(sanitizeUserText(String(raw)).replace(/\s+/g, ' ').trim(), 2000);
  });

  // DashScope native rerank endpoint
  const endpoint = `${settings.baseUrl.replace(/\/+$/, '')}/api/v1/services/rerank/text-rerank/text-rerank`;
  const abortSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);

  const rawModel = settings.rerankModel || 'gte-rerank-v2';
  // 阿里云已将初代 gte-rerank 逐步替换下线，若传入旧标识自动对齐到当前可用模型 gte-rerank-v2
  const modelToUse = rawModel === 'gte-rerank' ? 'gte-rerank-v2' : rawModel;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${settings.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: modelToUse,
        input: {
          query: cleanQuery,
          documents: cleanDocs
        },
        parameters: {
          top_n: Math.min(documents.length, settings.topN || 5),
          return_documents: false
        }
      }),
      signal: abortSignal
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      let parsedMsg = '';
      try {
        const j = JSON.parse(errText);
        parsedMsg = j.message || j.error?.message || j.code || '';
      } catch (_err) {
        // ignore JSON parse error
      }
      const detail = parsedMsg || safeSlice(errText, 200) || response.statusText;
      log.warn?.(`Bailian rerank HTTP ${response.status}: ${detail}`);
      if (throwOnError) {
        throw new Error(`DashScope HTTP ${response.status}: ${detail}`);
      }
      return null;
    }

    const data = await response.json();
    const results = data?.output?.results;
    if (!Array.isArray(results)) {
      log.warn?.(`Bailian rerank returned unexpected structure: ${JSON.stringify(data).slice(0, 200)}`);
      if (throwOnError) throw new Error(`DashScope 返回结构异常: ${JSON.stringify(data).slice(0, 200)}`);
      return null;
    }

    const minScore = typeof settings.minScore === 'number' ? settings.minScore : 0.15;
    return results
      .map(item => ({
        index: Number(item.index),
        score: Number(item.relevance_score ?? 0)
      }))
      .filter(item => Number.isInteger(item.index) && item.index >= 0 && item.index < documents.length && item.score >= minScore)
      .sort((a, b) => b.score - a.score);
  } catch (err) {
    log.warn?.(`Bailian rerank call failed: ${err?.message || err}`);
    if (throwOnError) throw err;
    return null;
  }
}

/**
 * Calls DashScope embedding API (e.g. text-embedding-v3).
 * Returns array of number[] embeddings, or null on failure.
 */
export async function embedWithBailian({ texts, settings, signal, timeoutMs = 8000, throwOnError = false }) {
  if (!settings?.apiKey) {
    if (throwOnError) throw new Error('缺少 API Key');
    return null;
  }
  if (!Array.isArray(texts) || !texts.length) {
    return null;
  }

  const endpoint = `${settings.baseUrl.replace(/\/+$/, '')}/compatible-mode/v1/embeddings`;
  const abortSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${settings.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: settings.embeddingModel || 'text-embedding-v3',
        input: texts.map(t => safeSlice(sanitizeUserText(String(t)).replace(/\s+/g, ' ').trim(), 2000)),
        encoding_format: 'float'
      }),
      signal: abortSignal
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      let parsedMsg = '';
      try {
        const j = JSON.parse(errText);
        parsedMsg = j.message || j.error?.message || j.code || '';
      } catch (_err) {
        // ignore JSON parse error
      }
      const detail = parsedMsg || safeSlice(errText, 200) || response.statusText;
      log.warn?.(`Bailian embedding HTTP ${response.status}: ${detail}`);
      if (throwOnError) {
        throw new Error(`DashScope Embedding HTTP ${response.status}: ${detail}`);
      }
      return null;
    }

    const data = await response.json();
    if (!Array.isArray(data?.data)) {
      if (throwOnError) throw new Error(`DashScope Embedding 返回异常: ${JSON.stringify(data).slice(0, 200)}`);
      return null;
    }

    return data.data
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map(item => item.embedding);
  } catch (err) {
    log.warn?.(`Bailian embedding call failed: ${err?.message || err}`);
    if (throwOnError) throw err;
    return null;
  }
}

/**
 * Calculates cosine similarity between two float vectors.
 */
export function cosineSimilarity(vecA, vecB) {
  if (!Array.isArray(vecA) || !Array.isArray(vecB) || vecA.length !== vecB.length || !vecA.length) {
    return 0;
  }
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    const a = vecA[i];
    const b = vecB[i];
    dotProduct += a * b;
    normA += a * a;
    normB += b * b;
  }
  if (normA <= 0 || normB <= 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}
