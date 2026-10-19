import { validateHaiguiTangPatch } from './config.js';

export function installHaiguiTangRoutes(app, manager) {
  const respond = (res, code, data) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(data));
  };
  app.addRoute('GET', '/api/haigui-tang', async (_req, res) => respond(res, 200, manager.status()));
  app.addRoute('POST', '/api/haigui-tang/settings', async (req, res) => {
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 65536) throw new Error('请求体过大');
        chunks.push(chunk);
      }
      const patch = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      validateHaiguiTangPatch(patch);
      app.updateConfig({ haiguiTang: patch });
      manager.sync();
      app.auditWrite?.('haigui-tang.settings', '/api/haigui-tang/settings', { req, ok: true });
      respond(res, 200, { ok: true, settings: manager.settings() });
    } catch (error) { respond(res, 400, { error: error.message }); }
  });
  app.addRoute('POST', '/api/haigui-tang/custom', async (req, res) => {
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 8192) throw new Error('请求体过大');
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const chatKey = String(body.chatKey || '').trim();
      const soup = String(body.soup || '').trim();
      const answer = String(body.answer || '').trim();
      if (!/^(group|private):\d{5,15}$/.test(chatKey) || !soup || soup.length > 500 || !answer || answer.length > 2000) {
        throw new Error('会话、汤面或汤底格式无效');
      }
      const result = await manager.handle({ kind: 'custom', soup, answer }, chatKey, `custom-${Date.now()}`);
      if (result?.error) throw new Error(result.error);
      app.auditWrite?.('haigui-tang.custom', '/api/haigui-tang/custom', { req, ok: true, chatKey });
      respond(res, 200, { ok: true });
    } catch (error) { respond(res, 400, { error: error.message }); }
  });
}
