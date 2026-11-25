"""Telegram novel channel cleaner, query parser, and TXT UTF-8 normalizer."""

from __future__ import annotations

import os
import re
from typing import Any, Iterable

ALLOWED_EXTENSIONS = frozenset({".txt", ".epub", ".pdf", ".zip", ".docx", ".mobi", ".azw3"})

# Known promotional / noisy line patterns observed in TG novel channels.
AD_LINE_PATTERNS = (
    re.compile(r"点击查看|点击进入|点我查看|点这里|立即体验|扫码|进群领", re.I),
    re.compile(r"ai\s*色色?女友|色色?女友|飞机杯|情趣用品|成人用品|高速机场|机场\s*vpn|\bvpn\b|便宜梯子|科学上网|节点推荐", re.I),
    re.compile(r"您的一票|点赞\s*[,，、或]\s*评论|好评评论|对推书书友的支持|投稿上传|本文件与推书相关|只投稿", re.I),
    re.compile(r"小说标签分类|等索引|旧链接\s*[（(]|更多资源|商务合作|广告合作|赞助|推广|博彩|赌场|约炮|同城", re.I),
    re.compile(r"https?://|t\.me/|telegram\.me/|@[a-z0-9_]{4,}", re.I),
    re.compile(r"^[—\-_=~·•*=\s]{4,}$"),
)

# Noisy hashtags that are channel-operational rather than novel genre/content tags.
NOISY_TAGS = frozenset({
    "群友书评",
    "小说评论",
    "广告",
    "推广",
    "赞助",
    "机场",
    "vpn",
    "书评",
    "投稿",
    "索引",
})

TAG_RE = re.compile(r"#([^\s#\[\]【】()（）,，;；/\\|]{1,30})")
BOOK_TITLE_BRACKET_RE = re.compile(r"《([^《》\r\n]{1,80})》")
FILENAME_NOISE_RE = re.compile(
    r"(?:[\s_\-]*\(?（?(?:精校|校对|全本|完结|连载|排版|合集|番外|未删减|无删减|加料|作品集?|整理|修订|v\d+(?:\.\d+)*)[^()（）]*\)?）?)+$",
    re.I,
)


def file_extension(file_name: str) -> str:
    _, ext = os.path.splitext(str(file_name or "").strip().lower())
    return ext


def is_allowed_novel_file(file_name: str) -> bool:
    return file_extension(file_name) in ALLOWED_EXTENSIONS


def format_size(num_bytes: int) -> str:
    size = max(0, int(num_bytes or 0))
    if size >= 1024 * 1024:
        return f"{size / (1024 * 1024):.1f} MB"
    if size >= 1024:
        return f"{size / 1024:.0f} KB"
    return f"{size} B"


def _utf16_offsets_to_py_index(text: str) -> list[int]:
    """Build a mapping from UTF-16 code unit offset (Telegram API) to Python str index."""
    mapping: list[int] = []
    for idx, ch in enumerate(text):
        units = len(ch.encode("utf-16-le")) // 2
        mapping.extend([idx] * units)
    mapping.append(len(text))
    return mapping


def _line_spans(text: str) -> list[tuple[int, int, str]]:
    spans: list[tuple[int, int, str]] = []
    pos = 0
    for raw_line in text.splitlines(keepends=True):
        end = pos + len(raw_line)
        spans.append((pos, end, raw_line.rstrip("\r\n")))
        pos = end
    return spans


def _extract_url_line_indices(text: str, entities: Iterable[dict[str, Any]] | None) -> set[int]:
    """Identify line indices containing Telegram URL / TextUrl entities."""
    if not text or not entities:
        return set()
    u16 = _utf16_offsets_to_py_index(text)
    max_u16 = len(u16) - 1
    spans = _line_spans(text)
    bad_lines: set[int] = set()
    for ent in entities:
        etype = str(ent.get("type") or "")
        if etype not in ("MessageEntityTextUrl", "MessageEntityUrl", "text_url", "url"):
            continue
        off = max(0, min(max_u16, int(ent.get("offset", 0))))
        length = max(0, int(ent.get("length", 0)))
        end_off = max(off, min(max_u16, off + length))
        py_start = u16[off]
        py_end = u16[end_off]
        for line_idx, (ls, le, _) in enumerate(spans):
            if py_start < le and py_end > ls:
                bad_lines.add(line_idx)
    return bad_lines


def extract_title(file_name: str, cleaned_lines: list[str]) -> str:
    raw_name = str(file_name or "").strip()
    stem, _ = os.path.splitext(raw_name)
    m = BOOK_TITLE_BRACKET_RE.search(stem)
    if m:
        return m.group(1).strip()
    for line in cleaned_lines[:3]:
        m2 = BOOK_TITLE_BRACKET_RE.search(line)
        if m2:
            return m2.group(1).strip()
    if stem:
        candidate = re.sub(r"\s+", " ", stem).strip(" _-·")
        if len(candidate) > 80:
            candidate = candidate[:80].rstrip()
        return candidate
    if cleaned_lines:
        return cleaned_lines[0][:60].strip()
    return "未命名小说"


def extract_tags(text: str, entities: Iterable[dict[str, Any]] | None = None, max_tags: int = 8) -> list[str]:
    found: list[str] = []
    seen: set[str] = set()

    def _add(raw_tag: str) -> None:
        tag = raw_tag.lstrip("#").strip()
        if not tag or len(tag) > 24:
            return
        low = tag.lower()
        if low in NOISY_TAGS or low in seen:
            return
        if any(p.search(tag) for p in AD_LINE_PATTERNS[:2]):
            return
        seen.add(low)
        found.append(tag)

    if text and entities:
        u16 = _utf16_offsets_to_py_index(text)
        max_u16 = len(u16) - 1
        for ent in entities:
            etype = str(ent.get("type") or "")
            if etype in ("MessageEntityHashtag", "hashtag"):
                off = max(0, min(max_u16, int(ent.get("offset", 0))))
                end_off = max(off, min(max_u16, off + max(0, int(ent.get("length", 0)))))
                _add(text[u16[off]:u16[end_off]])

    for m in TAG_RE.finditer(text or ""):
        _add(m.group(1))

    return found[:max_tags]


def clean_caption(
    text: str,
    entities: Iterable[dict[str, Any]] | None = None,
    file_name: str = "",
    summary_mode: str = "clean",
    max_summary_chars: int = 140,
) -> dict[str, Any]:
    """Strip promotional/URL lines and produce clean title, tags, and short summary."""
    raw_text = str(text or "")
    tags = extract_tags(raw_text, entities=entities)
    url_lines = _extract_url_line_indices(raw_text, entities)

    kept_lines: list[str] = []
    for idx, (_, _, line) in enumerate(_line_spans(raw_text)):
        s = line.strip()
        if not s:
            continue
        if idx in url_lines:
            continue
        if any(pat.search(s) for pat in AD_LINE_PATTERNS):
            continue
        # Remove inline hashtags from summary lines so summary stays readable.
        without_tags = TAG_RE.sub("", s).strip(" ·|/—-：:")
        if not without_tags:
            continue
        # Drop short pointer lines like "“简介”在底部标签偏上处" or "书评作者：xxx"
        if re.match(r"^[“\"']?简介[”\"']?\s*在", without_tags):
            continue
        if re.match(r"^(?:书评作者|推书人|投稿人|来源|频道)\s*[：:]", without_tags):
            continue
        kept_lines.append(re.sub(r"\s+", " ", without_tags))

    title = extract_title(file_name, kept_lines)

    if summary_mode == "minimal":
        summary = ""
    else:
        # Remove a leading line that just duplicates the title.
        body_lines: list[str] = []
        norm_title = re.sub(r"[\s《》【】\[\]()（）_·\-]", "", title).lower()
        for line in kept_lines:
            norm_line = re.sub(r"[\s《》【】\[\]()（）_·\-]", "", line).lower()
            if norm_title and norm_line == norm_title and not body_lines:
                continue
            body_lines.append(line)
        joined = " / ".join(body_lines)
        if len(joined) > max_summary_chars:
            joined = joined[: max_summary_chars - 1].rstrip() + "…"
        summary = joined

    return {
        "title": title,
        "tags": tags,
        "summary": summary,
    }


def parse_search_query(raw_query: str) -> dict[str, Any]:
    """Parse free-text query into keywords, required hashtags, and excluded terms.

    Examples:
      '#后宫 #NTL -ntr' -> tags=['后宫', 'NTL'], exclude=['ntr'], keywords=[]
      '流萤 纯爱 -猎奇'  -> keywords=['流萤', '纯爱'], tags=[], exclude=['猎奇']
    """
    tokens = [t.strip() for t in re.split(r"\s+", str(raw_query or "").strip()) if t.strip()]
    keywords: list[str] = []
    tags: list[str] = []
    exclude: list[str] = []
    for tok in tokens:
        if len(tok) > 1 and tok.startswith(("-", "－")):
            term = tok[1:].lstrip("#").strip()
            if term:
                exclude.append(term)
        elif len(tok) > 1 and tok.startswith("#"):
            tag = tok[1:].strip()
            if tag:
                tags.append(tag)
        else:
            keywords.append(tok)

    # Telegram search term sent to messages.Search:
    # Combine tags (with '#') and keywords so TG server narrows candidates effectively.
    tg_parts = [f"#{t}" for t in tags] + keywords
    tg_query = " ".join(tg_parts).strip()
    return {
        "tgQuery": tg_query,
        "keywords": keywords,
        "tags": tags,
        "exclude": exclude,
    }


def matches_filters(
    item: dict[str, Any],
    *,
    keywords: list[str] | None = None,
    tags: list[str] | None = None,
    exclude: list[str] | None = None,
    raw_text: str = "",
) -> bool:
    """Strict local filtering for multi-tag AND, multi-keyword AND, and -exclude."""
    haystack = " ".join([
        str(item.get("title") or ""),
        str(item.get("fileName") or ""),
        " ".join(item.get("tags") or []),
        str(item.get("summary") or ""),
        str(raw_text or ""),
    ]).lower()
    item_tags_lower = {str(t).lower() for t in (item.get("tags") or [])}

    for ex in (exclude or []):
        ex_low = ex.lower()
        if ex_low and ex_low in haystack:
            return False

    for req_tag in (tags or []):
        rt = req_tag.lower()
        if not rt:
            continue
        if rt not in item_tags_lower and f"#{rt}" not in haystack and rt not in haystack:
            return False

    for kw in (keywords or []):
        kl = kw.lower()
        if kl and kl not in haystack:
            return False

    return True


def normalize_txt_bytes(raw: bytes) -> tuple[bytes, str]:
    """Decode common Chinese TXT encodings and return normalized UTF-8 bytes + detected encoding."""
    if not raw:
        return b"", "utf-8"
    if raw.startswith(b"\xef\xbb\xbf"):
        try:
            text = raw.decode("utf-8-sig")
            return text.encode("utf-8"), "utf-8-sig"
        except UnicodeDecodeError:
            pass
    if raw.startswith((b"\xff\xfe", b"\xfe\xff")):
        try:
            text = raw.decode("utf-16")
            return text.encode("utf-8"), "utf-16"
        except UnicodeDecodeError:
            pass
    for enc in ("utf-8", "gb18030", "big5"):
        try:
            text = raw.decode(enc)
            return text.encode("utf-8"), enc
        except UnicodeDecodeError:
            continue
    return raw, "binary"
