export function haiguiTangCommand(raw, active = false) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const prefixed = /^\/?(?:海龟汤|龟汤)\s*(.*)$/i.exec(text);
  if (prefixed) {
    const action = prefixed[1].trim();
    if (!action || /^(?:开始|来一碗|再来一碗|再来|简单|中等|困难|难的)$/.test(action)) {
      return { kind: 'start', stars: action === '简单' ? 3 : action === '中等' ? 4 : /^(?:困难|难的)$/.test(action) ? 5 : null };
    }
    if (/^(?:换题|换一题|换一碗)$/.test(action)) return { kind: 'start', force: true };
    if (/^(?:提示|给个提示)$/.test(action)) return { kind: 'hint' };
    if (/^(?:公布答案|答案|汤底|放弃)$/.test(action)) return { kind: 'reveal' };
    if (/^(?:状态|进度)$/.test(action)) return { kind: 'status' };
    if (/^(?:结束|停止)$/.test(action)) return { kind: 'stop' };
    const question = /^(?:问|猜)[：:]\s*(.{1,300})$/.exec(action);
    return question ? { kind: 'ask', question: question[1].trim() } : null;
  }
  if (/^(?:来一碗|玩|出|再来一碗|再来个)海龟汤[！!。.]?$/.test(text)) return { kind: 'start' };
  if (!active) return null;
  if (/^(?:换题|换一题|换一碗)$/.test(text)) return { kind: 'start', force: true };
  if (/^(?:提示|给个提示|来点提示)$/.test(text)) return { kind: 'hint' };
  if (/^(?:公布答案|汤底是什么|放弃)$/.test(text)) return { kind: 'reveal' };
  if (/^(?:结束海龟汤|不玩了)$/.test(text)) return { kind: 'stop' };
  if (/^(?:是不是|是否|难道|会不会|我猜|我认为|答案是|真相是|他是不是|她是不是|这是不是)/.test(text)) {
    return { kind: 'ask', question: text.slice(0, 300) };
  }
  return null;
}
