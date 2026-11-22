import { searchSegments } from '../image-search/command.js';

const COMMAND_RE = /^\/?(?:找资源|求资源|搜资源|搜黄油|找黄油|gal搜)(?:[:：\s]+([\s\S]+))?$/i;

export function resourceSearchCommand(message) {
  const segments = searchSegments(message);
  const text = segments
    .filter((s) => s?.type === 'text')
    .map((s) => s.data?.text || '')
    .join('')
    .trim();
  const match = text.match(COMMAND_RE);
  if (!match) return null;
  const query = String(match[1] || '')
    .replace(/\[CQ:[^\]]*\]/gi, ' ')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return { query, segments };
}
