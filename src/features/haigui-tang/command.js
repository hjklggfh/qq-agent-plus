function difficulty(action) {
  if (/^(?:简单|1)$/.test(action)) return 3;
  if (/^(?:中等|2)$/.test(action)) return 4;
  if (/^(?:困难|难的|3)$/.test(action)) return 5;
  return null;
}

export function haiguiTangCommand(raw, active = false, selecting = false) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const prefixed = /^\/?(?:海龟汤|龟汤)\s*(.*)$/i.exec(text);
  if (prefixed) {
    const action = prefixed[1].trim();
    if (!action || /^(?:开始|来一碗|再来一碗|再来)$/.test(action)) return { kind: 'menu' };
    const stars = difficulty(action);
    if (stars) return { kind: 'start', stars };
    if (/^(?:换题|换一题|换一碗)$/.test(action)) return { kind: 'start', force: true };
    if (/^(?:提示|给个提示)$/.test(action)) return { kind: 'hint' };
    if (/^(?:公布答案|答案|汤底|放弃)$/.test(action)) return { kind: 'reveal' };
    if (/^(?:状态|进度)$/.test(action)) return { kind: 'status' };
    if (/^(?:结束|停止|退出)$/.test(action)) return { kind: 'stop' };
    const question = /^(?:问|猜)[：:]\s*(.{1,300})$/.exec(action);
    return question ? { kind: 'ask', question: question[1].trim() } : null;
  }
  if (/^(?:来一碗|玩|出|再来一碗|再来个)海龟汤[！!。.]?$/.test(text)) return { kind: 'menu' };
  if (selecting && !active) {
    const stars = difficulty(text);
    if (stars) return { kind: 'start', stars };
  }
  if ((active || selecting) && /^(?:退出|退出海龟汤|结束海龟汤|不玩了)$/.test(text)) return { kind: 'stop' };
  if (!active) return null;
  if (/^(?:换题|换一题|换一碗)$/.test(text)) return { kind: 'start', force: true };
  if (/^(?:提示|给个提示|来点提示)$/.test(text)) return { kind: 'hint' };
  if (/^(?:公布答案|汤底是什么|放弃)$/.test(text)) return { kind: 'reveal' };
  if (/^(?:是不是|是否|难道|会不会|我猜|我认为|答案是|真相是|他是不是|她是不是|这是不是)/.test(text)) {
    return { kind: 'ask', question: text.slice(0, 300) };
  }
  return null;
}
