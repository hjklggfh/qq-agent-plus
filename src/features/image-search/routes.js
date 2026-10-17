import { validateImageSearchPatch } from './config.js';

export function installImageSearchRoutes(app, manager) {
  const respond = (res, code, data) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(data));
  };
  app.addRoute('GET', '/api/image-search', async (_req, res) => respond(res, 200, manager.snapshot()));
  app.addRoute('GET', '/api/image-search/health', async (_req, res) => {
    try { respond(res, 200, await manager.health()); }
    catch (error) { respond(res, 400, { error: error.message }); }
  });
  app.addRoute('POST', '/api/image-search/settings', async (req, res) => {
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 32768) throw new Error('请求体最多32KB');
        chunks.push(chunk);
      }
      const patch = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      validateImageSearchPatch(patch);
      app.updateConfig({ imageSearch: patch });
      manager.enforce();
      app.auditWrite?.('image-search.settings', '/api/image-search/settings', { req, ok: true });
      respond(res, 200, { ok: true, ...manager.snapshot() });
    } catch (error) {
      respond(res, 400, { error: String(error.message) });
    }
  });
}
