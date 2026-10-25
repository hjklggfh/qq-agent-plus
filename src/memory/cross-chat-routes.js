// All three routes explicitly require the existing console authentication.
// createRouter.handle rejects unauthenticated /api requests before invoking handlers.
export function installCrossChatRoutes(app) {
  app.addRoute('GET', '/api/recall-traces', async (_req, res) => {
    const sessions = app.sessions.index.filter(s => s.recall).slice(0, 60).map(s => ({
      id: s.id, chatKey: s.chatKey, startedAt: s.startedAt, status: s.status, ...s.recall
    }));
    app.json(res, 200, { sessions, excludedMessages: app.getConfig().memory?.crossChat?.excludedMessages || [] });
  }, { auth: true });
  app.addRoute('GET', /^\/api\/recall-traces\/([\w-]+)$/, async (_req, res, params) => {
    const session = app.sessions.get(params[1]);
    if (!session?.crossChatRecall) return app.json(res, 404, { error: '没有这次运行的回忆记录' });
    app.json(res, 200, { id: session.id, chatKey: session.chatKey, startedAt: session.startedAt, recall: session.crossChatRecall });
  }, { auth: true });
  app.addRoute('POST', '/api/recall-exclusions', async (req, res) => {
    try {
      const body = await app.readBody(req, 4096);
      if (body.confirm !== true) return app.json(res, 409, { error: '请确认回忆纠错操作' });
      if (!/^(group|private):\d{1,15}$/.test(body.chatKey) || !Number.isSafeInteger(body.id) || body.id < 1) throw new Error('消息标识无效');
      const current = app.getConfig();
      const previous = app.policyKey(current);
      const old = current.memory?.crossChat?.excludedMessages || [];
      const next = old.filter(ref => ref.chatKey !== body.chatKey || ref.id !== body.id);
      if (body.action === 'exclude') {
        const session = typeof body.sessionId === 'string' && /^[\w-]{1,100}$/.test(body.sessionId) ? app.sessions.get(body.sessionId) : null;
        const found = session?.crossChatRecall?.entries?.some(entry => entry.fragments.some(ref => ref.chatKey === body.chatKey && ref.id === body.id));
        if (!found || !['incorrect', 'never'].includes(body.reason)) throw new Error('只能排除已留档的真实回忆片段');
        next.push({ chatKey: body.chatKey, id: body.id, reason: body.reason });
      } else if (body.action !== 'restore') throw new Error('操作无效');
      app.updateConfig({ memory: { crossChat: { excludedMessages: next } } });
      app.enforcePolicy(previous);
      app.auditWrite('recall.exclusion', `${body.chatKey}:${body.id}`, { req, action: body.action, reason: body.reason || '' });
      app.json(res, 200, { ok: true, excludedMessages: next });
    } catch (error) { app.json(res, 400, { error: error.message }); }
  }, { auth: true });
}
