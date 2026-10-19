import { parse } from 'node-html-parser';

const ORIGIN = 'https://e-hentai.org';
const GALLERY = /^https:\/\/e-hentai\.org\/g\/(\d+)\/([a-f0-9]+)\/?$/i;
const PAGE = /^https:\/\/e-hentai\.org\/s\/[a-f0-9]+\/\d+-\d+\/?$/i;

function absolute(href, base = ORIGIN) {
  try { return new URL(href, base).href; } catch { return ''; }
}
export function galleryUrl(href) {
  const url = absolute(href);
  return GALLERY.test(url) ? url : '';
}
export function imageUrl(href) {
  try {
    const url = new URL(href);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) return '';
    if (/\/(?:403|509)\.(?:gif|jpe?g|png)$/i.test(url.pathname)) return '';
    const host = url.hostname.toLowerCase();
    return host === 'e-hentai.org' || host.endsWith('.e-hentai.org') || host === 'ehgt.org'
      || host.endsWith('.ehgt.org') || host === 'hath.network' || host.endsWith('.hath.network') ? url.href : '';
  } catch { return ''; }
}
function clean(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }

export function parseListing(html, mode = 'search') {
  const root = parse(html);
  const items = [], seen = new Set();
  const rows = mode === 'daily' ? root.querySelectorAll('table.itg tr') : root.querySelectorAll('table.itg tr, .itg .gl1t, .itg .gl1c');
  for (const row of rows) {
    const anchor = row.querySelector('a[href*="/g/"] .glink')?.closest('a')
      || [...row.querySelectorAll('a[href*="/g/"]')].find((a) => galleryUrl(a.getAttribute('href')));
    if (!anchor) continue;
    const url = galleryUrl(anchor.getAttribute('href'));
    if (!url || seen.has(url)) continue;
    const title = clean(row.querySelector('.glink')?.textContent || anchor.textContent);
    if (!title) continue;
    seen.add(url);
    const date = clean(row.querySelector('[title^="20"], [id^="posted_"]')?.getAttribute('title')
      || row.textContent.match(/20\d{2}-\d{2}-\d{2}(?:\s+\d{2}:\d{2})?/)?.[0]);
    const pages = Number(row.querySelector('.gl4c')?.textContent.match(/(?:^|\s)(\d{1,5})\s+pages?/i)?.[1]
      || row.structuredText.match(/(?:^|\s)(\d{1,5})\s+pages?/i)?.[1] || 0);
    items.push({ url, title: title.slice(0, 180), date, pages });
  }
  // E站的普通检索默认最新在前。榜单保留站方名次，不按发布日期改排。
  const next = mode === 'daily' ? '' : [...root.querySelectorAll('a[href]')]
    .map((a) => absolute(a.getAttribute('href')))
    .find((url) => url.startsWith(`${ORIGIN}/?`) && new URL(url).searchParams.has('next')) || '';
  return { items, next };
}

export function parseGallery(html, gallery, pageIndex = 0) {
  const root = parse(html);
  const title = clean(root.querySelector('#gn')?.textContent || root.querySelector('title')?.textContent);
  const links = [...root.querySelectorAll('#gdt a[href*="/s/"]')]
    .map((a) => absolute(a.getAttribute('href'))).filter((url) => PAGE.test(url));
  const unique = [...new Set(links)];
  const pageCount = Number(root.querySelector('#gdd')?.textContent.match(/(\d{1,5})\s+pages?/i)?.[1] || 0);
  const pageNav = [...root.querySelectorAll('.ptt a[href], .ptb a[href]')]
    .map((a) => absolute(a.getAttribute('href'), gallery))
    .filter((url) => url.startsWith(`${gallery}?`) && new URL(url).searchParams.has('p'));
  const next = pageNav.find((url) => Number(new URL(url).searchParams.get('p')) === pageIndex + 1) || '';
  return { title, links: unique, pageCount, next };
}

export function parseImagePage(html) {
  const root = parse(html);
  return imageUrl(root.querySelector('#img')?.getAttribute('src') || root.querySelector('#img')?.getAttribute('data-src'));
}

export function searchUrl(query, kind = 'search') {
  const url = new URL(ORIGIN);
  const value = clean(query).slice(0, 120);
  if (!value) throw new Error('请输入检索词');
  const tag = value.replace(/\s+/g, '_').replace(/\$$/, '');
  url.searchParams.set('f_search', kind === 'tag' ? `${tag.includes(':') ? '' : 'tag:'}${tag}$` : value);
  return url.href;
}
export const dailyUrl = `${ORIGIN}/toplist.php?tl=15`;
