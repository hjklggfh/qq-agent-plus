import { validateNovelSearchPatch } from './config.js';

export function installNovelSearchRoutes(app, manager) {
  const respond = (res, code, data) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(data));
  };

  app.addRoute('GET', '/api/novel-search', async (_req, res) => respond(res, 200, manager.snapshot()));

  app.addRoute('GET', '/api/novel-search/health', async (_req, res) => {
    try {
      const result = await manager.health();
      respond(res, result?.ok ? 200 : 502, result);
    } catch (error) {
      respond(res, 502, { ok: false, error: String(error?.message || error) });
    }
  });

  app.addRoute('POST', '/api/novel-search/settings', async (req, res) => {
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 32768) throw new Error('请求体最多32KB');
        chunks.push(chunk);
      }
      const patch = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      validateNovelSearchPatch(patch);
      app.updateConfig({ novelSearch: patch });
      manager.enforce();
      app.auditWrite?.('novel-search.settings', '/api/novel-search/settings', { req, ok: true });
      respond(res, 200, { ok: true, ...manager.snapshot() });
    } catch (error) {
      respond(res, 400, { error: String(error.message) });
    }
  });
}
