import { validateTrpgPatch } from './config.js';

async function readBody(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 128 * 1024) throw new Error('请求体最多128KB');
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求体必须是对象');
  return value;
}

function respond(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

export function installTrpgRoutes(app, manager) {
  const add = (method, route, operation) => app.addRoute(method, route, async (req, res) => {
    try {
      const body = method === 'GET' ? {} : await readBody(req);
      const result = await operation(body);
      if (method !== 'GET') app.auditWrite?.('trpg.update', route, { req, ok: true });
      respond(res, 200, result);
    } catch (error) {
      respond(res, 400, { error: String(error.message) });
    }
  });
  add('GET', '/api/trpg', () => manager.snapshot());
  add('POST', '/api/trpg/settings', (body) => {
    validateTrpgPatch(body);
    const patch = Object.fromEntries(['enabled', 'maxPlayers', 'allowedGroups', 'allowedPrivate'].filter((key) => Object.hasOwn(body, key)).map((key) => [key, body[key]]));
    app.updateConfig({ trpg: patch });
    app.enforceTrpgState();
    return { ok: true, settings: manager.settings() };
  });
  add('POST', '/api/trpg/asset', (body) => manager.saveAsset(body.kind, body.asset));
  add('POST', '/api/trpg/delete-asset', (body) => {
    if (body.confirm !== true) throw new Error('删除卡片需要确认');
    return manager.deleteAsset(body.kind, body.id);
  });
  add('POST', '/api/trpg/campaign', (body) => {
    if (body.confirm !== true) throw new Error('修改存档状态需要确认');
    const result = manager.manageCampaign(body.id, body.action, body.revision);
    app.enforceTrpgState();
    return result;
  });
}
