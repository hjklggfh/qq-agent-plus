"""No-login / low-friction web novel adapters for Tokyo novel relay:
- Cool18 (禁忌书屋, bbs4) — 100% no-login Chinese R-18 novels
- ESJZone (esjzone.cc / esjzone.one) — no-login light/R-18 serialized novels
- Pixiv Novel (www.pixiv.net/ajax/...) — guest safe search + optional PHPSESSID for R-18,
  with strict anti-RP/spam (语C/群宣/招新) filtering and series merging.
"""

from __future__ import annotations

import asyncio
import html
import json
import logging
import re
import urllib.parse
from typing import Any

try:
    import aiohttp
except ImportError:  # allow running pure parser unit tests without aiohttp installed
    aiohttp = None  # type: ignore[assignment]

from cleaner import matches_filters, parse_search_query

LOG = logging.getLogger("tg-novel-relay.web")

DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Accept-Language": "zh-CN,zh;q=0.9,ja;q=0.7",
}

# Anti-spam filter specifically targeting Pixiv Chinese novel RP/recruitment pollution.
PIXIV_SPAM_RE = re.compile(
    r"语\s*c|语擦|文爱|群宣|招新|招人|扩列|pia\s*戏|对戏|皮下|磨皮|"
    r"接稿|约稿|定制文|代写|审核群|门牌号|企鹅群|qq\s*群|加群|进群|"
    r"群号\s*[:：]?\s*\d{5,}|v\s*x\s*[:：]|微\s*信\s*[:：]|"
    r"有偿|无偿约|长期接|点梗招|招写手|招美工|宣群|语c群",
    re.I,
)

# Popular unrelated ACG franchises often spammed together in recruitment posts.
MAJOR_IP_GROUPS = (
    re.compile(r"原神|genshin", re.I),
    re.compile(r"星穹铁道|崩坏|honkai|star\s*rail", re.I),
    re.compile(r"绝区零|zzz|zenless", re.I),
    re.compile(r"鸣潮|wuthering", re.I),
    re.compile(r"蔚蓝档案|blue\s*archive|ブルアカ", re.I),
    re.compile(r"明日方舟|arknights", re.I),
    re.compile(r"第五人格|王者荣耀|恋与|光与夜", re.I),
)


def strip_html(raw: str) -> str:
    if not raw:
        return ""
    s = re.sub(r"<br\s*/?>", "\n", raw, flags=re.I)
    s = re.sub(r"</p\s*>", "\n\n", s, flags=re.I)
    s = re.sub(r"<[^>]+>", "", s)
    s = html.unescape(s)
    s = s.replace("\r\n", "\n").replace("\r", "\n")
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


def format_char_count(n: int) -> str:
    val = max(0, int(n or 0))
    if val >= 10000:
        return f"{val / 10000:.1f}万字"
    if val > 0:
        return f"{val}字"
    return ""


def is_pixiv_spam_novel(item: dict[str, Any], min_chars: int = 1500) -> bool:
    """Return True if a Pixiv novel search hit looks like RP/recruitment/spam pollution."""
    text_count = int(item.get("textCount") or item.get("wordCount") or 0)
    if min_chars > 0 and text_count < min_chars:
        return True
    title = str(item.get("title") or "")
    desc = strip_html(str(item.get("description") or ""))
    tags = [str(t) for t in (item.get("tags") or [])]
    joined = f"{title}\n{desc}\n{' '.join(tags)}"
    if PIXIV_SPAM_RE.search(joined):
        return True
    # Detect tag-stuffing posts that spam 4+ major game franchises with near-zero bookmarks.
    bookmarks = int(item.get("bookmarkCount") or 0)
    if bookmarks < 10:
        ip_hits = sum(1 for pat in MAJOR_IP_GROUPS if pat.search(" ".join(tags) + " " + title))
        if ip_hits >= 4:
            return True
    return False


def clean_pixiv_novel_body(raw_content: str) -> str:
    """Convert Pixiv novel markup ([newpage], [chapter:...], [[rb:A > B]]) into clean TXT."""
    s = str(raw_content or "").replace("\r\n", "\n").replace("\r", "\n")
    s = re.sub(r"\[chapter:([^\]]+)\]", lambda m: f"\n\n=== {m.group(1).strip()} ===\n\n", s)
    s = re.sub(r"\[newpage\]", "\n\n---\n\n", s, flags=re.I)
    s = re.sub(r"\[\[rb:([^>\]]+?)\s*>\s*([^\]]+?)\]\]", r"\1（\2）", s)
    s = re.sub(r"\[\[jumpuri:([^>\]]+?)\s*>\s*([^\]]+?)\]\]", r"\1", s)
    s = re.sub(r"\[(?:uploadedimage|pixivimage):[^\]]+\]", "", s, flags=re.I)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


def parse_cool18_search_html(html_text: str, *, mode: str = "search") -> list[dict[str, Any]]:
    """Extract thread list strictly from Cool18 main result area (skipping top featured bar)."""
    segment = html_text
    m_post_list = re.search(
        r'<ul[^>]*class=["\'][^"\']*thread-list[^"\']*["\'][^>]*>(.*?)</ul>',
        html_text,
        re.S | re.I,
    )
    if m_post_list:
        segment = m_post_list.group(1)
    else:
        m_list = re.search(r'<ul[^>]*id=["\']thread_list["\'][^>]*>(.*?)</ul>', html_text, re.S | re.I)
        if m_list:
            segment = m_list.group(1)
        elif mode == "search":
            pos = html_text.find("搜索结果")
            if pos > 0:
                segment = html_text[pos:]

    results: list[dict[str, Any]] = []
    seen_tids: set[str] = set()
    # Match <li> rows to also capture author / byte size / date when present.
    li_blocks = re.findall(r"<li[^>]*>(.*?)</li>", segment, re.S | re.I)
    if li_blocks:
        for block in li_blocks:
            m_link = re.search(
                r'href="(?:[^"]*?)index\.php\?app=forum&(?:amp;)?act=threadview&(?:amp;)?tid=(\d+)"[^>]*>(.*?)</a>',
                block,
                re.S | re.I,
            )
            if not m_link:
                continue
            tid = m_link.group(1)
            if tid in seen_tids:
                continue
            raw_title = re.sub(r"\s+", " ", strip_html(m_link.group(2))).strip()
            if not raw_title or len(raw_title) < 2:
                continue
            # Skip announcement / notice threads.
            if any(skip in raw_title for skip in ("版规", "公告", "申诉", "置顶", "悬赏说明")):
                continue
            seen_tids.add(tid)
            plain_row = re.sub(r"\s+", " ", strip_html(block))
            m_bytes = re.search(r"(\d{3,8})\s*bytes?", plain_row, re.I)
            size_hint = int(m_bytes.group(1)) if m_bytes else 0
            m_date = re.search(r"(\d{2,4}[-/]\d{1,2}[-/]\d{1,2})", plain_row)
            date_str = m_date.group(1) if m_date else ""
            results.append({
                "source": "cool18",
                "channel": "cool18",
                "channelLabel": "禁忌书屋(R18)",
                "id": tid,
                "msgId": int(tid),
                "title": raw_title[:80],
                "fileName": f"{raw_title[:70]}.txt",
                "ext": ".txt",
                "size": size_hint,
                "sizeText": f"{size_hint / 1024:.0f} KB" if size_hint >= 1024 else ("R-18 TXT"),
                "tags": ["R18", "禁忌书屋"],
                "summary": "",
                "date": date_str,
                "ts": int(tid),
            })
    else:
        for tid, raw_t in re.findall(
            r'href="(?:[^"]*?)index\.php\?app=forum&(?:amp;)?act=threadview&(?:amp;)?tid=(\d+)"[^>]*>(.*?)</a>',
            segment,
            re.S | re.I,
        ):
            if tid in seen_tids:
                continue
            raw_title = re.sub(r"\s+", " ", strip_html(raw_t)).strip()
            if not raw_title or len(raw_title) < 2:
                continue
            seen_tids.add(tid)
            results.append({
                "source": "cool18",
                "channel": "cool18",
                "channelLabel": "禁忌书屋(R18)",
                "id": tid,
                "msgId": int(tid),
                "title": raw_title[:80],
                "fileName": f"{raw_title[:70]}.txt",
                "ext": ".txt",
                "size": 0,
                "sizeText": "R-18 TXT",
                "tags": ["R18", "禁忌书屋"],
                "summary": "",
                "date": "",
                "ts": int(tid),
            })
    return results


def extract_cool18_body(html_text: str) -> tuple[str, str, list[str]]:
    """Extract clean title, novel body text, and inline hashtags from a Cool18 thread page."""
    m_title = re.search(r"<title[^>]*>(.*?)</title>", html_text, re.S | re.I)
    title = strip_html(m_title.group(1)) if m_title else "禁忌书屋小说"
    title = re.sub(r"\s*[-–—|]\s*(?:禁忌书屋|cool18|留园).*$", "", title, flags=re.I).strip()

    m_pre = re.search(r"<pre[^>]*>(.*?)</pre>", html_text, re.S | re.I)
    if m_pre:
        body = strip_html(m_pre.group(1))
    else:
        m_div = re.search(r'<div[^>]*class=["\'][^"\']*show_content[^"\']*["\'][^>]*>(.*?)</div>', html_text, re.S | re.I)
        body = strip_html(m_div.group(1)) if m_div else ""

    # Strip Cool18 footer boilerplate if present.
    body = re.sub(r"---\s*留园网.*$", "", body, flags=re.S)
    body = re.sub(r"本文由.*?cool18.*?整理.*$", "", body, flags=re.I | re.S).strip()
    tags = list(dict.fromkeys(re.findall(r"#([^\s#\[\]【】()（）,，;；/\\|]{1,20})", body[:400])))[:8]
    return title or "禁忌书屋小说", body, tags


def parse_esjzone_cards(html_text: str) -> list[dict[str, Any]]:
    """Parse novel cards from ESJZone tag or list HTML pages."""
    results: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    # Split around card-body blocks so we capture title + stats cleanly.
    blocks = re.split(r'<div\s+class="card-body">', html_text)[1:]
    for block in blocks:
        m_link = re.search(r'<h5\s+class="card-title"[^>]*>\s*<a\s+href="/detail/(\d+)\.html"[^>]*>(.*?)</a>', block, re.S | re.I)
        if not m_link:
            continue
        book_id = m_link.group(1)
        if book_id in seen_ids:
            continue
        seen_ids.add(book_id)
        title = re.sub(r"\s+", " ", strip_html(m_link.group(2))).strip()
        if not title:
            continue
        m_ep = re.search(r'<div\s+class="card-ep"[^>]*>(.*?)</div>', block, re.S | re.I)
        ep_hint = re.sub(r"\s+", " ", strip_html(m_ep.group(1))).strip() if m_ep else ""
        is_r18 = bool(re.search(r"badge[^>]*>[^<]*R18|class=\"[^\"]*r18", block, re.I))
        tags = ["ESJZone"]
        if is_r18:
            tags.insert(0, "R18")
        results.append({
            "source": "esjzone",
            "channel": "esjzone",
            "channelLabel": "ESJZone",
            "id": book_id,
            "msgId": int(book_id),
            "title": title[:80],
            "fileName": f"《{title[:65]}》.txt",
            "ext": ".txt",
            "size": 0,
            "sizeText": f"连载 · {ep_hint[:20]}" if ep_hint else "ESJ 轻小说",
            "tags": tags,
            "summary": f"最新章节：{ep_hint}" if ep_hint else "",
            "date": "",
            "ts": int(book_id),
        })
    return results


def parse_esjzone_detail(html_text: str) -> dict[str, Any]:
    """Parse ESJZone book detail page: title, tags, description, and chapter list."""
    m_title = re.search(r"<h2[^>]*class=\"p-t-10[^>]*>(.*?)</h2>", html_text, re.S | re.I)
    title = re.sub(r"\s+", " ", strip_html(m_title.group(1))).strip() if m_title else "ESJ小说"
    m_desc = re.search(r'<div\s+class="description"[^>]*>(.*?)</div>', html_text, re.S | re.I)
    desc = strip_html(m_desc.group(1)) if m_desc else ""
    tags = [
        re.sub(r"\s+", " ", strip_html(t)).strip()
        for t in re.findall(r'<a[^>]*href="/tags/[^"]+"[^>]*>(.*?)</a>', html_text, re.S | re.I)
    ]
    tags = list(dict.fromkeys(t for t in tags if t and len(t) <= 24))[:10]

    # Chapters live inside #chapterList
    chap_area = html_text
    m_cl = re.search(r'id="chapterList"[^>]*>(.*?)</div>\s*</div>', html_text, re.S | re.I)
    if m_cl:
        chap_area = m_cl.group(1)

    chapters: list[tuple[str, str]] = []
    seen_urls: set[str] = set()
    for url, raw_t in re.findall(
        r'href="(https?://www\.esjzone\.(?:cc|one|me)/forum/\d+/\d+\.html)"[^>]*>(.*?)</a>',
        chap_area,
        re.S | re.I,
    ):
        if url in seen_urls:
            continue
        seen_urls.add(url)
        ctitle = re.sub(r"\s+", " ", strip_html(raw_t)).strip() or f"第{len(chapters) + 1}章"
        chapters.append((ctitle, url))

    return {"title": title, "description": desc, "tags": tags, "chapters": chapters}


def extract_esjzone_chapter_text(html_text: str) -> str:
    m = re.search(r'<div\s+class="forum-content[^"]*"[^>]*>(.*?)</div>', html_text, re.S | re.I)
    if not m:
        return ""
    return strip_html(m.group(1))


class WebNovelAdapters:
    """Async HTTP adapters for Pixiv Novel, Cool18, and ESJZone."""

    def __init__(self) -> None:
        self._session: aiohttp.ClientSession | None = None

    async def session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            timeout = aiohttp.ClientTimeout(total=30, connect=10)
            self._session = aiohttp.ClientSession(headers=DEFAULT_HEADERS, timeout=timeout)
        return self._session

    async def close(self) -> None:
        if self._session is not None and not self._session.closed:
            await self._session.close()
            self._session = None

    async def _fetch_text(self, url: str, *, headers: dict[str, str] | None = None) -> str:
        sess = await self.session()
        async with sess.get(url, headers=headers) as resp:
            if resp.status >= 400:
                raise RuntimeError(f"HTTP {resp.status}")
            raw = await resp.read()
            return raw.decode("utf-8", "replace")

    async def _fetch_json(self, url: str, *, headers: dict[str, str] | None = None) -> dict[str, Any]:
        text = await self._fetch_text(url, headers=headers)
        return json.loads(text)

    # ---------------- Cool18 ----------------
    async def search_cool18(self, query: str, *, mode: str = "search", limit: int = 32, page: int = 1) -> list[dict[str, Any]]:
        parsed = parse_search_query(query) if mode == "search" else {"keywords": [], "tags": [], "exclude": [], "tgQuery": ""}
        safe_page = max(1, min(20, int(page or 1)))
        if mode == "latest":
            url = "https://www.cool18.com/bbs4/index.php" if safe_page == 1 else f"https://www.cool18.com/bbs4/index.php?app=forum&act=gold&p={safe_page}"
            html_text = await self._fetch_text(url)
            items = parse_cool18_search_html(html_text, mode="latest")
            return items[:limit]

        # Cool18 search matches title/body best with plain words without '#'.
        terms = parsed["keywords"] + parsed["tags"]
        search_word = " ".join(terms).strip() or query.lstrip("#").strip()
        if not search_word:
            return []
        q = urllib.parse.quote(search_word)
        page_param = f"&p={safe_page}" if safe_page > 1 else ""
        url = f"https://www.cool18.com/bbs4/index.php?action=search&bbsdr=bbs4&act=threadsearch&app=forum&keywords={q}&submit=%E6%9F%A5%E8%AF%A2&first=1{page_param}"
        html_text = await self._fetch_text(url)
        items = parse_cool18_search_html(html_text, mode="search")

        # Keep hits matching keywords/exclude; if primary search had multiple words, filter locally too.
        filtered = []
        for it in items:
            if parsed["exclude"] and not matches_filters(it, exclude=parsed["exclude"]):
                continue
            filtered.append(it)
        return filtered[:limit]

    async def download_cool18(self, tid: str) -> tuple[str, bytes]:
        if not re.fullmatch(r"\d{4,12}", str(tid)):
            raise ValueError("invalid cool18 tid")
        url = f"https://www.cool18.com/bbs4/index.php?app=forum&act=threadview&tid={tid}"
        html_text = await self._fetch_text(url)
        title, body, tags = extract_cool18_body(html_text)
        if not body or len(body) < 30:
            raise RuntimeError("未能从禁忌书屋页面提取到小说正文")
        header = f"《{title}》\n来源：Cool18 禁忌书屋 (tid={tid})\n"
        if tags:
            header += "标签：" + " ".join(f"#{t}" for t in tags) + "\n"
        header += "=" * 40 + "\n\n"
        full_text = header + body + "\n"
        return f"{title[:70]}.txt", full_text.encode("utf-8")

    # ---------------- ESJZone ----------------
    async def _fetch_esj(self, path_and_query: str) -> str:
        last_err: Exception | None = None
        for host in ("https://www.esjzone.cc", "https://www.esjzone.one"):
            try:
                return await self._fetch_text(f"{host}{path_and_query}")
            except Exception as exc:
                last_err = exc
        raise RuntimeError(f"ESJZone 请求失败: {last_err}")

    async def search_esjzone(self, query: str, *, mode: str = "search", limit: int = 32, page: int = 1) -> list[dict[str, Any]]:
        parsed = parse_search_query(query) if mode == "search" else {"keywords": [], "tags": [], "exclude": [], "tgQuery": ""}
        safe_page = max(1, min(20, int(page or 1)))
        if mode == "latest":
            path_q = "/list-01/" if safe_page == 1 else f"/list-01-{safe_page}.html"
            html_text = await self._fetch_esj(path_q)
            return parse_esjzone_cards(html_text)[:limit]

        # ESJZone tag page returns up to 40 works on page 1 without server-side static page 2.
        if safe_page > 1:
            return []

        # ESJZone tag/keyword search endpoint: /tags/<word>/
        terms = parsed["tags"] + parsed["keywords"]
        primary = terms[0] if terms else query.lstrip("#").strip()
        if not primary:
            return []
        html_text = await self._fetch_esj(f"/tags/{urllib.parse.quote(primary)}/")
        items = parse_esjzone_cards(html_text)
        filtered = []
        extra_kws = terms[1:]
        for it in items:
            if parsed["exclude"] and not matches_filters(it, exclude=parsed["exclude"]):
                continue
            if extra_kws and not matches_filters(it, keywords=extra_kws):
                continue
            filtered.append(it)
        return filtered[:limit]

    async def download_esjzone(self, book_id: str, *, max_chapters: int = 80) -> tuple[str, bytes]:
        if not re.fullmatch(r"\d{4,14}", str(book_id)):
            raise ValueError("invalid esjzone book_id")
        detail_html = await self._fetch_esj(f"/detail/{book_id}.html")
        meta = parse_esjzone_detail(detail_html)
        chapters = meta["chapters"]
        if not chapters:
            raise RuntimeError("该书暂无免登录可读的站内章节（可能为外链搬运或需登录）")

        capped = max(1, min(200, int(max_chapters or 80)))
        selected = chapters[:capped]
        sem = asyncio.Semaphore(3)

        async def _grab(idx: int, ctitle: str, curl: str) -> tuple[int, str, str]:
            async with sem:
                try:
                    ch_html = await self._fetch_text(curl)
                    body = extract_esjzone_chapter_text(ch_html)
                    await asyncio.sleep(0.2)
                    return idx, ctitle, body
                except Exception as exc:
                    return idx, ctitle, f"[本章节抓取失败: {exc}]"

        fetched = await asyncio.gather(*(_grab(i, ct, cu) for i, (ct, cu) in enumerate(selected)))
        fetched.sort(key=lambda x: x[0])

        parts = [
            f"《{meta['title']}》",
            f"来源：ESJZone (id={book_id}) · 收录 {len(selected)}/{len(chapters)} 章",
        ]
        if meta["tags"]:
            parts.append("标签：" + " ".join(f"#{t}" for t in meta["tags"]))
        if meta["description"]:
            parts.append("\n简介：\n" + meta["description"])
        if len(chapters) > len(selected):
            parts.append(f"\n（注：原书共 {len(chapters)} 章，当前已按上限导出前 {len(selected)} 章）")
        parts.append("\n" + "=" * 40 + "\n")

        non_empty = 0
        for _, ctitle, body in fetched:
            if body and not body.startswith("[本章节抓取失败"):
                non_empty += 1
            parts.append(f"\n\n### {ctitle}\n\n{body or '（本章内容为空或需登录查看）'}")

        if non_empty == 0:
            raise RuntimeError("该书章节内容为空或需要登录才能查看")

        return f"《{meta['title'][:65]}》.txt", "\n".join(parts).encode("utf-8")

    # ---------------- Pixiv Novel ----------------
    def _pixiv_headers(self, pixiv_cookie: str = "") -> dict[str, str]:
        h = {
            **DEFAULT_HEADERS,
            "Referer": "https://www.pixiv.net/",
        }
        ck = str(pixiv_cookie or "").strip()
        if ck:
            h["Cookie"] = ck if "=" in ck else f"PHPSESSID={ck}"
        return h

    async def search_pixiv(
        self,
        query: str,
        *,
        mode: str = "search",
        limit: int = 32,
        page: int = 1,
        pixiv_cookie: str = "",
        min_chars: int = 1500,
    ) -> list[dict[str, Any]]:
        headers = self._pixiv_headers(pixiv_cookie)
        has_cookie = bool(str(pixiv_cookie or "").strip())
        safe_page = max(1, min(20, int(page or 1)))

        if mode == "latest":
            # Pull Chinese recent novels via tag search "中文"
            query = "中文"

        parsed = parse_search_query(query)
        req_r18 = any(t.lower() in ("r18", "r-18") for t in parsed["tags"]) or any(k.lower() in ("r18", "r-18") for k in parsed["keywords"])
        clean_tags = [t for t in parsed["tags"] if t.lower() not in ("r18", "r-18")]
        clean_kws = [k for k in parsed["keywords"] if k.lower() not in ("r18", "r-18")]

        search_words = " ".join(clean_tags + clean_kws).strip() or "中文"
        q = urllib.parse.quote(search_words)
        pixiv_mode = "r18" if (req_r18 and has_cookie) else ("all" if has_cookie else "safe")

        raw_entries: list[dict[str, Any]] = []
        start_p = (safe_page - 1) * 2 + 1
        # Fetch 2 upstream pages per batch so after stripping RP/recruitment spam we still get rich results.
        for page_no in (start_p, start_p + 1):
            url = (
                f"https://www.pixiv.net/ajax/search/novels/{q}"
                f"?word={q}&order=date_d&mode={pixiv_mode}&p={page_no}&s_mode=s_tag&lang=zh"
            )
            data = await self._fetch_json(url, headers=headers)
            if data.get("error"):
                break
            rows = data.get("body", {}).get("novel", {}).get("data") or []
            if not rows:
                break
            raw_entries.extend(rows)
            if len(raw_entries) >= 120:
                break

        items: list[dict[str, Any]] = []
        seen_ids: set[str] = set()
        for row in raw_entries:
            nid = str(row.get("id") or "").strip()
            if not nid or nid in seen_ids:
                continue
            if is_pixiv_spam_novel(row, min_chars=min_chars):
                continue

            title = str(row.get("title") or "未命名Pixiv小说").strip()
            author = str(row.get("userName") or "").strip()
            text_count = int(row.get("textCount") or row.get("wordCount") or 0)
            bookmarks = int(row.get("bookmarkCount") or 0)
            x_restrict = int(row.get("xRestrict") or 0)
            tags = [str(t).strip() for t in (row.get("tags") or []) if str(t).strip()][:8]
            desc = strip_html(str(row.get("description") or ""))
            desc = re.sub(r"https?://\S+", "", desc)
            desc = re.sub(r"\s+", " ", desc).strip()
            if len(desc) > 120:
                desc = desc[:119].rstrip() + "…"

            series_id = str(row.get("seriesId") or "").strip()
            series_title = str(row.get("seriesTitle") or "").strip()
            r18_label = "R-18G" if x_restrict == 2 else ("R-18" if x_restrict == 1 else "全年龄")
            meta_parts = [r18_label, format_char_count(text_count)]
            if bookmarks > 0:
                meta_parts.append(f"★{bookmarks}")
            if series_id:
                meta_parts.append("系列")

            entry = {
                "source": "pixiv",
                "channel": "pixiv",
                "channelLabel": "Pixiv小说",
                "id": nid,
                "msgId": int(nid) if nid.isdigit() else 0,
                "title": title[:80],
                "fileName": f"《{title[:65]}》.txt",
                "ext": ".txt",
                "size": text_count * 3,
                "sizeText": " · ".join(p for p in meta_parts if p),
                "tags": tags,
                "summary": f"作者：{author}" + (f" · 系列《{series_title}》" if series_title else "") + (f" / {desc}" if desc else ""),
                "date": str(row.get("createDate") or row.get("updateDate") or ""),
                "ts": bookmarks * 10000 + text_count,  # rank higher-quality novels first
                "bookmarks": bookmarks,
                "textCount": text_count,
                "xRestrict": x_restrict,
                "seriesId": series_id,
            }
            if parsed["exclude"] and not matches_filters(entry, exclude=parsed["exclude"]):
                continue
            if len(clean_tags) > 1 and not matches_filters(entry, tags=clean_tags):
                continue
            seen_ids.add(nid)
            items.append(entry)

        # Sort by bookmarks + length and deduplicate by Pixiv seriesId so one series doesn't flood page 1.
        items.sort(key=lambda x: (x.get("bookmarks", 0), x.get("textCount", 0)), reverse=True)
        deduped: list[dict[str, Any]] = []
        seen_series: set[str] = set()
        for it in items:
            sid = str(it.get("seriesId") or "")
            if sid:
                if sid in seen_series:
                    continue
                seen_series.add(sid)
            deduped.append(it)
            if len(deduped) >= limit:
                break
        return deduped

    async def download_pixiv(
        self,
        novel_id: str,
        *,
        pixiv_cookie: str = "",
        max_series_parts: int = 30,
    ) -> tuple[str, bytes]:
        if not re.fullmatch(r"\d{3,12}", str(novel_id)):
            raise ValueError("invalid pixiv novel_id")
        headers = self._pixiv_headers(pixiv_cookie)
        detail = await self._fetch_json(f"https://www.pixiv.net/ajax/novel/{novel_id}?lang=zh", headers=headers)
        if detail.get("error"):
            raise RuntimeError(str(detail.get("message") or "Pixiv 小说读取失败（可能需要配置 Pixiv Cookie 查看 R-18）"))
        body_obj = detail.get("body") or {}
        title = str(body_obj.get("title") or f"Pixiv小说-{novel_id}").strip()
        author = str(body_obj.get("userName") or "").strip()
        desc = strip_html(str(body_obj.get("description") or ""))
        tags_raw = (body_obj.get("tags") or {}).get("tags") or []
        tags = [str(t.get("tag") or "").strip() for t in tags_raw if isinstance(t, dict) and t.get("tag")]
        content = clean_pixiv_novel_body(str(body_obj.get("content") or ""))
        if not content:
            raise RuntimeError("未能获取到小说正文（R-18 作品请在控制台配置 Pixiv Cookie）")

        series_nav = body_obj.get("seriesNavData") or {}
        series_id = str(series_nav.get("seriesId") or "").strip()
        series_title = str(series_nav.get("title") or "").strip()

        # If this novel belongs to a multi-part series, fetch and merge up to max_series_parts chapters.
        merged_chapters: list[tuple[str, str]] = []
        if series_id and re.fullmatch(r"\d+", series_id):
            try:
                s_data = await self._fetch_json(
                    f"https://www.pixiv.net/ajax/novel/series_content/{series_id}?limit={max_series_parts}&last_order=0&order_by=asc&lang=zh",
                    headers=headers,
                )
                s_list = (s_data.get("body") or {}).get("page", {}).get("seriesContents") or []
                if 2 <= len(s_list) <= max_series_parts:
                    for item in s_list:
                        cid = str(item.get("id") or "")
                        ctitle = str(item.get("title") or f"第{len(merged_chapters) + 1}话").strip()
                        if cid == str(novel_id):
                            merged_chapters.append((ctitle, content))
                        elif cid.isdigit():
                            c_detail = await self._fetch_json(f"https://www.pixiv.net/ajax/novel/{cid}?lang=zh", headers=headers)
                            c_body = clean_pixiv_novel_body(str((c_detail.get("body") or {}).get("content") or ""))
                            if c_body:
                                merged_chapters.append((ctitle, c_body))
                            await asyncio.sleep(0.2)
            except Exception as exc:
                LOG.warning("pixiv series merge skipped for series=%s: %s", series_id, exc)

        if len(merged_chapters) >= 2:
            out_title = series_title or title
            lines = [
                f"《{out_title}》（系列共 {len(merged_chapters)} 话）",
                f"作者：{author} · 来源：Pixiv 小说 (series={series_id})",
            ]
            if tags:
                lines.append("标签：" + " ".join(f"#{t}" for t in tags[:10]))
            if desc:
                lines.append("\n简介：\n" + desc)
            lines.append("\n" + "=" * 40 + "\n")
            for idx, (ctitle, ctext) in enumerate(merged_chapters, 1):
                lines.append(f"\n\n### 第 {idx} 话：{ctitle}\n\n{ctext}")
            return f"《{out_title[:65]}》.txt", "\n".join(lines).encode("utf-8")

        lines = [
            f"《{title}》",
            f"作者：{author} · 来源：Pixiv 小说 (id={novel_id})",
        ]
        if tags:
            lines.append("标签：" + " ".join(f"#{t}" for t in tags[:10]))
        if desc:
            lines.append("\n简介：\n" + desc)
        lines.append("\n" + "=" * 40 + "\n\n" + content + "\n")
        return f"《{title[:65]}》.txt", "\n".join(lines).encode("utf-8")
