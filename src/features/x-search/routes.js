import { validateXSearchPatch } from './config.js';

export function installXSearchRoutes(app, manager) {
  const respond = (res, code, data) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(data));
  };
  const body = async (req) => {
    let size = 0; const parts = [];
    for await (const part of req) { size += part.length; if (size > 8192) throw new Error('请求体过大'); parts.push(part); }
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  };
  app.addRoute('GET', '/api/x-search', async (_req, res) => respond(res, 200, manager.snapshot()));
  app.addRoute('POST', '/api/x-search/settings', async (req, res) => {
    try {
      const patch = await body(req); validateXSearchPatch(patch);
      app.updateConfig({ xSearch: patch }); manager.enforce();
      app.auditWrite?.('x-search.settings', '/api/x-search/settings', { req, ok: true });
      respond(res, 200, { ok: true, ...manager.snapshot() });
    } catch (error) { respond(res, 400, { error: error.message }); }
  });
  app.addRoute('POST', '/api/x-search/preview', async (req, res) => {
    try {
      const input = await body(req);
      const page = await manager.preview(String(input.username || '').replace(/^@/, ''));
      respond(res, 200, { ok: true, page });
    } catch (error) { respond(res, 400, { error: error.message }); }
  });
}
