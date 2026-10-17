import { validatePixivPatch } from './config.js';

export function installPixivRoutes(app, manager) {
  const respond = (res, code, data) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(data));
  };
  const body = async (req) => {
    let size = 0; const parts = [];
    for await (const part of req) { size += part.length; if (size > 65536) throw new Error('请求体过大'); parts.push(part); }
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  };
  app.addRoute('GET', '/api/pixiv', async (_req, res) => respond(res, 200, manager.snapshot()));
  app.addRoute('POST', '/api/pixiv/settings', async (req, res) => {
    try {
      const patch = await body(req); validatePixivPatch(patch);
      if (Object.hasOwn(patch, 'chatRatings')) {
        patch.chatRatings = { __replace__: patch.chatRatings.__replace__ || patch.chatRatings };
        patch.chatRatingsMigrated = true;
      }
      app.updateConfig({ pixiv: patch }); manager.enforce();
      app.auditWrite?.('pixiv.settings', '/api/pixiv/settings', { req, ok: true });
      respond(res, 200, { ok: true, ...manager.snapshot() });
    } catch (error) { respond(res, 400, { error: error.message }); }
  });
  app.addRoute('POST', '/api/pixiv/rating', async (req, res) => {
    try {
      const data = await body(req); manager.setRating(String(data.pid), data.rating);
      app.auditWrite?.('pixiv.rating', '/api/pixiv/rating', { req, ok: true });
      respond(res, 200, { ok: true, ...manager.snapshot() });
    } catch (error) { respond(res, 400, { error: error.message }); }
  });
  app.addRoute('POST', '/api/pixiv/cancel', async (req, res) => {
    manager.active?.controller.abort();
    app.auditWrite?.('pixiv.cancel', '/api/pixiv/cancel', { req, ok: true });
    respond(res, 200, { ok: true });
  });
}
