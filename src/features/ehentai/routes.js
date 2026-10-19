import { validateEhentaiPatch } from './config.js';

export function installEhentaiRoutes(app, manager) {
  const respond = (res, code, data) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(data));
  };
  app.addRoute('GET', '/api/ehentai', async (_req, res) => respond(res, 200, {
    settings: manager.settings(), running: Boolean(manager.active), cachedLists: manager.lists.size
  }));
  app.addRoute('POST', '/api/ehentai/settings', async (req, res) => {
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 65536) throw new Error('请求体过大');
        chunks.push(chunk);
      }
      const patch = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      validateEhentaiPatch(patch);
      app.updateConfig({ ehentai: patch }); manager.sync();
      app.auditWrite?.('ehentai.settings', '/api/ehentai/settings', { req, ok: true });
      respond(res, 200, { ok: true, settings: manager.settings() });
    } catch (error) { respond(res, 400, { error: error.message }); }
  });
  app.addRoute('POST', '/api/ehentai/cancel', async (req, res) => {
    manager.active?.abort();
    app.auditWrite?.('ehentai.cancel', '/api/ehentai/cancel', { req, ok: true });
    respond(res, 200, { ok: true });
  });
}
