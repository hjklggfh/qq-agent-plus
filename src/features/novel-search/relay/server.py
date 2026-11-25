"""Tokyo-side multi-source novel relay (Pixiv Novel + Cool18 + ESJZone + optional Telegram channels).

Binds strictly to loopback (default 127.0.0.1:3224), enforces Bearer token auth,
and hard-locks Telegram access to the configured channel whitelist.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import secrets
import shutil
import time
import urllib.parse
from pathlib import Path
from typing import Any

from aiohttp import web
from telethon import TelegramClient
from telethon.tl.types import (
    DocumentAttributeFilename,
    InputMessagesFilterDocument,
    MessageEntityHashtag,
    MessageEntityTextUrl,
    MessageEntityUrl,
)

from cleaner import (
    clean_caption,
    file_extension,
    format_size,
    is_allowed_novel_file,
    matches_filters,
    normalize_txt_bytes,
    parse_search_query,
)
from web_sources import WebNovelAdapters

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [tg-novel-relay] %(levelname)s %(message)s",
)
LOG = logging.getLogger("tg-novel-relay")

WEB_SOURCES = frozenset({"pixiv", "cool18", "esjzone"})
DEFAULT_CHANNELS = [
    {"id": "px_novels", "label": "蓝P官能文学社", "aliases": ["蓝p", "px", "p站", "pixiv"], "summaryMode": "clean"},
    {"id": "happylibrary", "label": "开心书库", "aliases": ["开心", "书库", "happy"], "summaryMode": "clean"},
]


def _load_env_file(env_path: Path) -> None:
    if not env_path.is_file():
        return
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k = k.strip()
        v = v.strip().strip('"').strip("'")
        if k and k not in os.environ:
            os.environ[k] = v


def _load_channels_config() -> dict[str, dict[str, Any]]:
    raw_json = os.environ.get("TG_NOVEL_CHANNELS_JSON", "").strip()
    if raw_json:
        items = json.loads(raw_json)
    else:
        raw_csv = os.environ.get("TG_NOVEL_CHANNELS", "").strip()
        if raw_csv:
            items = [{"id": c.strip().lstrip("@"), "label": c.strip().lstrip("@"), "summaryMode": "clean"} for c in raw_csv.split(",") if c.strip()]
        else:
            items = DEFAULT_CHANNELS
    result: dict[str, dict[str, Any]] = {}
    for item in items:
        cid = str(item.get("id") or "").strip().lstrip("@").lower()
        if not cid or not all(ch.isalnum() or ch == "_" for ch in cid):
            continue
        result[cid] = {
            "id": cid,
            "label": str(item.get("label") or cid).strip(),
            "aliases": [str(a).strip().lower() for a in (item.get("aliases") or []) if str(a).strip()],
            "summaryMode": "minimal" if item.get("summaryMode") == "minimal" else "clean",
        }
    return result


def _message_entities_to_dicts(message: Any) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for ent in (getattr(message, "entities", None) or []):
        if isinstance(ent, MessageEntityTextUrl):
            out.append({"type": "MessageEntityTextUrl", "offset": ent.offset, "length": ent.length, "url": ent.url})
        elif isinstance(ent, MessageEntityUrl):
            out.append({"type": "MessageEntityUrl", "offset": ent.offset, "length": ent.length})
        elif isinstance(ent, MessageEntityHashtag):
            out.append({"type": "MessageEntityHashtag", "offset": ent.offset, "length": ent.length})
    return out


def _extract_document_info(message: Any) -> tuple[str, int] | None:
    doc = getattr(message, "document", None)
    if not doc:
        return None
    file_name = ""
    for attr in (getattr(doc, "attributes", None) or []):
        if isinstance(attr, DocumentAttributeFilename) and getattr(attr, "file_name", None):
            file_name = str(attr.file_name)
            break
    size = int(getattr(doc, "size", 0) or 0)
    if not file_name:
        return None
    return file_name, size


def _interleave_buckets(buckets: list[list[dict[str, Any]]], limit: int) -> list[dict[str, Any]]:
    """Round-robin merge results across sources so page 1 shows a balanced mix."""
    out: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    indices = [0] * len(buckets)
    while len(out) < limit:
        progressed = False
        for b_idx, bucket in enumerate(buckets):
            while indices[b_idx] < len(bucket):
                item = bucket[indices[b_idx]]
                indices[b_idx] += 1
                key = (str(item.get("channel") or item.get("source") or ""), str(item.get("id") or item.get("msgId") or ""))
                if key in seen:
                    continue
                seen.add(key)
                out.append(item)
                progressed = True
                break
            if len(out) >= limit:
                break
        if not progressed:
            break
    return out


class NovelRelayApp:
    def __init__(self) -> None:
        self.data_dir = Path(os.environ.get("TG_NOVEL_DATA_DIR", str(Path.home() / ".local/share/qq-tg-novel-relay")))
        self.data_dir.mkdir(parents=True, exist_ok=True)
        _load_env_file(self.data_dir / ".env")

        self.host = os.environ.get("TG_NOVEL_RELAY_HOST", "127.0.0.1")
        self.port = int(os.environ.get("TG_NOVEL_RELAY_PORT", "3224"))
        self.api_id = int(os.environ.get("TG_API_ID", "0") or "0")
        self.api_hash = os.environ.get("TG_API_HASH", "").strip()
        self.session_path = os.environ.get("TG_SESSION_PATH", str(self.data_dir / "tg_novel"))
        self.token_file = Path(os.environ.get("TG_NOVEL_RELAY_TOKEN_FILE", str(self.data_dir / "relay-token")))
        self.cache_dir = self.data_dir / "cache"
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.max_cache_bytes = int(os.environ.get("TG_NOVEL_CACHE_MAX_BYTES", str(300 * 1024 * 1024)))
        self.max_file_bytes = int(os.environ.get("TG_NOVEL_MAX_FILE_BYTES", str(30 * 1024 * 1024)))
        self.channels = _load_channels_config()

        self.token = self._load_or_require_token()
        self.client: TelegramClient | None = None
        self.web_adapters = WebNovelAdapters()
        self.entities_cache: dict[str, Any] = {}
        self.search_cache: dict[str, tuple[float, dict[str, Any]]] = {}
        self.tg_lock = asyncio.Lock()
        self.last_tg_call = 0.0
        self.min_tg_interval = float(os.environ.get("TG_NOVEL_MIN_INTERVAL_SEC", "1.5"))
        self.authorized = False

    def _load_or_require_token(self) -> str:
        env_tok = os.environ.get("TG_NOVEL_RELAY_TOKEN", "").strip()
        if env_tok:
            return env_tok
        if self.token_file.is_file():
            tok = self.token_file.read_text(encoding="utf-8").strip()
            if tok:
                return tok
        raise RuntimeError(f"Relay token file missing or empty: {self.token_file}")

    def _check_auth(self, request: web.Request) -> bool:
        auth = request.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            return False
        provided = auth[7:].strip()
        return secrets.compare_digest(provided, self.token)

    async def start_services(self) -> None:
        if not self.api_id or not self.api_hash:
            LOG.info("Telegram credentials not configured; web sources (pixiv/cool18/esjzone) ready")
            return
        self.client = TelegramClient(
            self.session_path,
            self.api_id,
            self.api_hash,
            device_model="Desktop",
            system_version="Linux 6.8",
            app_version="4.16.8",
            lang_code="zh-hans",
            system_lang_code="zh-hans",
        )
        await self.client.connect()
        self.authorized = await self.client.is_user_authorized()
        if self.authorized:
            LOG.info("Telegram client connected and authorized; allowed channels=%s", list(self.channels.keys()))
        else:
            LOG.info("Telegram session not authorized yet; web sources ready")

    async def stop_services(self) -> None:
        await self.web_adapters.close()
        if self.client is not None:
            await self.client.disconnect()
            self.client = None

    async def _throttle_tg(self) -> None:
        now = time.monotonic()
        wait = self.min_tg_interval - (now - self.last_tg_call)
        if wait > 0:
            await asyncio.sleep(wait)
        self.last_tg_call = time.monotonic()

    async def _resolve_channel(self, channel_id: str) -> Any:
        if channel_id not in self.channels:
            raise web.HTTPForbidden(text=json.dumps({"error": f"channel not in whitelist: {channel_id}"}))
        if self.client is None or not self.authorized:
            raise web.HTTPServiceUnavailable(text=json.dumps({"error": "Telegram 客户端尚未完成登录授权"}))
        if channel_id not in self.entities_cache:
            await self._throttle_tg()
            self.entities_cache[channel_id] = await self.client.get_entity(channel_id)
        return self.entities_cache[channel_id]

    def _cache_usage_bytes(self) -> int:
        total = 0
        for p in self.cache_dir.glob("*"):
            if p.is_file():
                try:
                    total += p.stat().st_size
                except OSError:
                    pass
        return total

    def _prune_cache(self) -> None:
        files: list[tuple[float, int, Path]] = []
        total = 0
        for p in self.cache_dir.glob("*"):
            if not p.is_file() or p.name.endswith(".tmp"):
                continue
            try:
                st = p.stat()
                files.append((st.st_mtime, st.st_size, p))
                total += st.st_size
            except OSError:
                pass
        if total <= self.max_cache_bytes:
            return
        files.sort(key=lambda x: x[0])
        for _, size, p in files:
            if total <= int(self.max_cache_bytes * 0.8):
                break
            try:
                p.unlink(missing_ok=True)
                total -= size
            except OSError:
                pass

    def _cache_paths(self, cache_id: str) -> tuple[Path, Path]:
        key = hashlib.sha256(cache_id.encode()).hexdigest()[:24]
        return self.cache_dir / f"{key}.bin", self.cache_dir / f"{key}.json"

    async def handle_healthz(self, request: web.Request) -> web.Response:
        if not self._check_auth(request):
            return web.json_response({"error": "unauthorized"}, status=401)
        connected = bool(self.client and self.client.is_connected())
        return web.json_response({
            "ok": True,
            "webSources": ["pixiv", "cool18", "esjzone"],
            "telegramConfigured": bool(self.api_id and self.api_hash),
            "connected": connected,
            "authorized": self.authorized,
            "channels": [
                {"id": c["id"], "label": c["label"], "summaryMode": c["summaryMode"]}
                for c in self.channels.values()
            ],
            "cacheBytes": self._cache_usage_bytes(),
            "maxCacheBytes": self.max_cache_bytes,
            "maxFileBytes": self.max_file_bytes,
        })

    async def _search_telegram_channels(
        self,
        *,
        mode: str,
        raw_query: str,
        parsed: dict[str, Any],
        target_ids: list[str],
        limit: int,
        summary_override: str,
        max_bytes: int,
        tg_offsets: dict[str, int] | None = None,
    ) -> tuple[list[dict[str, Any]], dict[str, str], dict[str, int]]:
        items: list[dict[str, Any]] = []
        channel_errors: dict[str, str] = {}
        next_offsets: dict[str, int] = dict(tg_offsets or {})
        strict_local = bool(len(parsed["tags"]) > 1 or parsed["exclude"] or len(parsed["keywords"]) > 1)
        per_channel_fetch = min(60, max(limit, 40 if strict_local else 24))

        async with self.tg_lock:
            for cid in target_ids:
                meta = self.channels[cid]
                sm = summary_override if summary_override in ("clean", "minimal") else meta["summaryMode"]
                offset_id = int((tg_offsets or {}).get(cid) or 0)
                try:
                    entity = await self._resolve_channel(cid)
                    await self._throttle_tg()
                    if mode == "latest":
                        messages = await self.client.get_messages(
                            entity,
                            limit=per_channel_fetch,
                            max_id=offset_id,
                            filter=InputMessagesFilterDocument(),
                        )
                    else:
                        tg_q = parsed["tgQuery"] or raw_query
                        messages = await self.client.get_messages(
                            entity,
                            search=tg_q,
                            limit=per_channel_fetch,
                            max_id=offset_id,
                            filter=InputMessagesFilterDocument(),
                        )
                        if not messages and offset_id == 0 and (len(parsed["tags"]) > 1 or (parsed["tags"] and parsed["keywords"])):
                            fallback_q = f"#{parsed['tags'][0]}" if parsed["tags"] else parsed["keywords"][0]
                            await self._throttle_tg()
                            messages = await self.client.get_messages(
                                entity,
                                search=fallback_q,
                                limit=60,
                                filter=InputMessagesFilterDocument(),
                            )
                except Exception as exc:
                    LOG.warning("channel=%s search failed: %s", cid, exc)
                    channel_errors[cid] = str(exc)
                    continue

                min_seen_id = 0
                for msg in (messages or []):
                    mid = int(getattr(msg, "id", 0) or 0)
                    if mid > 0 and (min_seen_id == 0 or mid < min_seen_id):
                        min_seen_id = mid
                    doc_info = _extract_document_info(msg)
                    if not doc_info:
                        continue
                    file_name, size = doc_info
                    if not is_allowed_novel_file(file_name) or size <= 0 or size > max_bytes:
                        continue
                    raw_text = str(getattr(msg, "message", "") or "")
                    ent_dicts = _message_entities_to_dicts(msg)
                    cleaned = clean_caption(raw_text, entities=ent_dicts, file_name=file_name, summary_mode=sm)
                    entry = {
                        "source": "telegram",
                        "channel": cid,
                        "channelLabel": meta["label"],
                        "id": str(msg.id),
                        "msgId": int(msg.id),
                        "title": cleaned["title"],
                        "fileName": file_name,
                        "ext": file_extension(file_name),
                        "size": size,
                        "sizeText": format_size(size),
                        "tags": cleaned["tags"],
                        "summary": cleaned["summary"],
                        "date": msg.date.isoformat() if getattr(msg, "date", None) else "",
                        "ts": int(msg.date.timestamp()) if getattr(msg, "date", None) else 0,
                    }
                    if mode == "search" and not matches_filters(
                        entry,
                        keywords=parsed["keywords"],
                        tags=parsed["tags"],
                        exclude=parsed["exclude"],
                        raw_text=raw_text,
                    ):
                        continue
                    items.append(entry)
                if min_seen_id > 0:
                    next_offsets[cid] = min_seen_id

        items.sort(key=lambda x: x["ts"], reverse=True)
        return items, channel_errors, next_offsets

    async def handle_search(self, request: web.Request) -> web.Response:
        if not self._check_auth(request):
            return web.json_response({"error": "unauthorized"}, status=401)
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "invalid json"}, status=400)

        mode = str(body.get("mode") or "search").strip().lower()
        if mode not in ("search", "latest"):
            return web.json_response({"error": "invalid mode"}, status=400)

        raw_query = str(body.get("query") or "").strip()[:120]
        if mode == "search" and not raw_query:
            return web.json_response({"error": "query is required"}, status=400)

        raw_sources = body.get("sources")
        if isinstance(raw_sources, list) and raw_sources:
            req_sources = [str(s).strip().lower() for s in raw_sources if str(s).strip().lower() in ("pixiv", "cool18", "esjzone", "telegram")]
        else:
            req_sources = ["pixiv", "cool18", "esjzone", "telegram"]

        requested_channels = body.get("channels")
        if isinstance(requested_channels, list) and requested_channels:
            tg_ids = [str(c).strip().lstrip("@").lower() for c in requested_channels if str(c).strip().lstrip("@").lower() in self.channels]
        else:
            tg_ids = list(self.channels.keys())

        summary_override = str(body.get("summaryMode") or "").strip().lower()
        limit = max(1, min(80, int(body.get("limit") or 64)))
        page = max(1, min(20, int(body.get("page") or 1)))
        max_bytes = min(self.max_file_bytes, max(1024 * 1024, int(body.get("maxFileBytes") or self.max_file_bytes)))
        pixiv_cookie = str(body.get("pixivCookie") or "").strip()
        pixiv_min_chars = max(0, min(20000, int(body.get("pixivMinChars") if body.get("pixivMinChars") is not None else 1500)))
        raw_offsets = body.get("tgOffsets")
        tg_offsets = {str(k).lower(): int(v) for k, v in raw_offsets.items() if str(v).isdigit()} if isinstance(raw_offsets, dict) else {}

        parsed = parse_search_query(raw_query) if mode == "search" else {"tgQuery": "", "keywords": [], "tags": [], "exclude": []}
        cache_key = json.dumps({
            "mode": mode, "q": raw_query, "src": req_sources, "chs": tg_ids,
            "limit": limit, "page": page, "sm": summary_override, "mb": max_bytes,
            "hasCk": bool(pixiv_cookie), "pmc": pixiv_min_chars, "off": tg_offsets,
        }, sort_keys=True)
        cached = self.search_cache.get(cache_key)
        if cached and time.monotonic() - cached[0] < 60:
            return web.json_response(cached[1])

        source_errors: dict[str, str] = {}
        buckets: list[list[dict[str, Any]]] = []
        per_source_limit = min(40, max(16, limit))
        paginatable_got_hits = False
        next_tg_offsets: dict[str, int] = dict(tg_offsets)

        # Run enabled web adapters concurrently for fast response.
        web_tasks: list[tuple[str, Any]] = []
        if "pixiv" in req_sources:
            web_tasks.append((
                "pixiv",
                self.web_adapters.search_pixiv(
                    raw_query, mode=mode, limit=per_source_limit, page=page,
                    pixiv_cookie=pixiv_cookie, min_chars=pixiv_min_chars,
                ),
            ))
        if "cool18" in req_sources:
            web_tasks.append((
                "cool18",
                self.web_adapters.search_cool18(raw_query, mode=mode, limit=per_source_limit, page=page),
            ))
        if "esjzone" in req_sources:
            web_tasks.append((
                "esjzone",
                self.web_adapters.search_esjzone(raw_query, mode=mode, limit=per_source_limit, page=page),
            ))

        if web_tasks:
            web_results = await asyncio.gather(*(coro for _, coro in web_tasks), return_exceptions=True)
            for (src_name, _), res in zip(web_tasks, web_results):
                if isinstance(res, Exception):
                    LOG.warning("web source=%s page=%d failed: %s", src_name, page, res)
                    source_errors[src_name] = str(res)
                elif isinstance(res, list) and res:
                    buckets.append(res)
                    if src_name in ("pixiv", "cool18") or (src_name == "esjzone" and mode == "latest"):
                        if len(res) >= 8:
                            paginatable_got_hits = True

        # Telegram channels: run only if enabled & authorized.
        if "telegram" in req_sources and tg_ids:
            if self.client is not None and self.authorized:
                tg_items, tg_errs, next_tg_offsets = await self._search_telegram_channels(
                    mode=mode, raw_query=raw_query, parsed=parsed, target_ids=tg_ids,
                    limit=per_source_limit, summary_override=summary_override, max_bytes=max_bytes,
                    tg_offsets=tg_offsets,
                )
                source_errors.update(tg_errs)
                if tg_items:
                    buckets.append(tg_items)
                    if len(tg_items) >= 8:
                        paginatable_got_hits = True
            elif len(req_sources) == 1:
                return web.json_response({"error": "Telegram 频道尚未完成登录授权（可先使用其他书源）"}, status=503)

        merged = _interleave_buckets(buckets, limit)
        has_more = bool(page < 20 and paginatable_got_hits and len(merged) > 0)
        payload = {
            "ok": True,
            "mode": mode,
            "query": raw_query,
            "parsed": parsed,
            "page": page,
            "hasMore": has_more,
            "nextTgOffsets": next_tg_offsets,
            "total": len(merged),
            "items": merged,
            "channelErrors": source_errors,
        }
        self.search_cache[cache_key] = (time.monotonic(), payload)
        if len(self.search_cache) > 128:
            oldest_k = min(self.search_cache, key=lambda k: self.search_cache[k][0])
            self.search_cache.pop(oldest_k, None)
        return web.json_response(payload)

    async def handle_download(self, request: web.Request) -> web.StreamResponse:
        if not self._check_auth(request):
            return web.json_response({"error": "unauthorized"}, status=401)
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "invalid json"}, status=400)

        source = str(body.get("source") or "").strip().lower()
        channel_id = str(body.get("channel") or "").strip().lstrip("@").lower()
        if not source:
            source = channel_id if channel_id in WEB_SOURCES else "telegram"
        item_id = str(body.get("id") or body.get("msgId") or "").strip()
        normalize_txt = body.get("normalizeTxt", True) is not False
        max_bytes = min(self.max_file_bytes, max(1024 * 1024, int(body.get("maxFileBytes") or self.max_file_bytes)))
        pixiv_cookie = str(body.get("pixivCookie") or "").strip()
        esj_max_chapters = max(1, min(200, int(body.get("esjMaxChapters") or 80)))

        if source in WEB_SOURCES:
            cache_id = f"web:{source}:{item_id}:{esj_max_chapters if source == 'esjzone' else 0}:{int(bool(pixiv_cookie))}"
            bin_path, meta_path = self._cache_paths(cache_id)
            if bin_path.is_file() and meta_path.is_file():
                try:
                    meta = json.loads(meta_path.read_text(encoding="utf-8"))
                    os.utime(bin_path, None)
                    return await self._stream_cached_file(request, bin_path, meta, cache_hit=True)
                except Exception:
                    pass
            try:
                if source == "cool18":
                    file_name, content_bytes = await self.web_adapters.download_cool18(item_id)
                elif source == "esjzone":
                    file_name, content_bytes = await self.web_adapters.download_esjzone(item_id, max_chapters=esj_max_chapters)
                elif source == "pixiv":
                    file_name, content_bytes = await self.web_adapters.download_pixiv(item_id, pixiv_cookie=pixiv_cookie)
                else:
                    return web.json_response({"error": f"unsupported source: {source}"}, status=400)
            except ValueError as exc:
                return web.json_response({"error": str(exc)}, status=400)
            except Exception as exc:
                LOG.warning("web download source=%s id=%s failed: %s", source, item_id, exc)
                return web.json_response({"error": str(exc)}, status=502)

            if len(content_bytes) > max_bytes:
                return web.json_response({"error": f"文件大小超出限制（{format_size(len(content_bytes))}）"}, status=413)

            tmp_path = bin_path.with_suffix(".tmp")
            try:
                tmp_path.write_bytes(content_bytes)
                shutil.move(str(tmp_path), str(bin_path))
                meta = {
                    "source": source,
                    "id": item_id,
                    "fileName": file_name,
                    "size": len(content_bytes),
                    "encoding": "utf-8",
                }
                meta_path.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
                self._prune_cache()
            finally:
                tmp_path.unlink(missing_ok=True)
            return await self._stream_cached_file(request, bin_path, meta, cache_hit=False)

        # Telegram channel download
        msg_id = int(item_id) if item_id.isdigit() else 0
        if channel_id not in self.channels or msg_id <= 0:
            return web.json_response({"error": "invalid channel or msgId"}, status=400)

        bin_path, meta_path = self._cache_paths(f"tg:{channel_id}:{msg_id}:{int(normalize_txt)}")
        if bin_path.is_file() and meta_path.is_file():
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
                os.utime(bin_path, None)
                return await self._stream_cached_file(request, bin_path, meta, cache_hit=True)
            except Exception:
                pass

        if self.client is None or not self.authorized:
            return web.json_response({"error": "Telegram 客户端尚未登录授权"}, status=503)

        async with self.tg_lock:
            if bin_path.is_file() and meta_path.is_file():
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
                return await self._stream_cached_file(request, bin_path, meta, cache_hit=True)

            entity = await self._resolve_channel(channel_id)
            await self._throttle_tg()
            msg = await self.client.get_messages(entity, ids=msg_id)
            if not msg:
                return web.json_response({"error": "目标消息不存在或已被删除"}, status=404)
            doc_info = _extract_document_info(msg)
            if not doc_info:
                return web.json_response({"error": "该消息不包含可下载文件"}, status=404)
            file_name, size = doc_info
            if not is_allowed_novel_file(file_name):
                return web.json_response({"error": f"不支持的文件类型: {file_extension(file_name)}"}, status=400)
            if size <= 0 or size > max_bytes:
                return web.json_response({"error": f"文件大小超出限制（{format_size(size)} > {format_size(max_bytes)}）"}, status=413)

            tmp_path = bin_path.with_suffix(".tmp")
            try:
                await self.client.download_media(msg, file=str(tmp_path))
                if not tmp_path.is_file():
                    return web.json_response({"error": "Telegram 文件下载失败"}, status=502)
                encoding = "binary"
                if normalize_txt and file_extension(file_name) == ".txt":
                    raw_bytes = tmp_path.read_bytes()
                    norm_bytes, encoding = normalize_txt_bytes(raw_bytes)
                    tmp_path.write_bytes(norm_bytes)
                final_size = tmp_path.stat().st_size
                if final_size > max_bytes:
                    tmp_path.unlink(missing_ok=True)
                    return web.json_response({"error": "转码后文件大小超出限制"}, status=413)
                shutil.move(str(tmp_path), str(bin_path))
                meta = {
                    "channel": channel_id,
                    "msgId": msg_id,
                    "fileName": file_name,
                    "size": final_size,
                    "encoding": encoding,
                }
                meta_path.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
                self._prune_cache()
            finally:
                tmp_path.unlink(missing_ok=True)

        return await self._stream_cached_file(request, bin_path, meta, cache_hit=False)

    async def _stream_cached_file(
        self,
        request: web.Request,
        bin_path: Path,
        meta: dict[str, Any],
        *,
        cache_hit: bool,
    ) -> web.StreamResponse:
        resp = web.StreamResponse(
            status=200,
            headers={
                "Content-Type": "application/octet-stream",
                "Content-Length": str(meta["size"]),
                "X-Novel-Filename": urllib.parse.quote(str(meta["fileName"])),
                "X-Novel-Encoding": str(meta.get("encoding") or "binary"),
                "X-Novel-Cache": "hit" if cache_hit else "miss",
            },
        )
        await resp.prepare(request)
        with bin_path.open("rb") as fh:
            while True:
                chunk = fh.read(65536)
                if not chunk:
                    break
                await resp.write(chunk)
        await resp.write_eof()
        return resp


def create_app() -> web.Application:
    relay = NovelRelayApp()
    app = web.Application(client_max_size=1024 * 1024)
    app["relay"] = relay
    app.router.add_get("/healthz", relay.handle_healthz)
    app.router.add_post("/v1/search", relay.handle_search)
    app.router.add_post("/v1/download", relay.handle_download)

    async def _on_startup(_app: web.Application) -> None:
        await relay.start_services()

    async def _on_cleanup(_app: web.Application) -> None:
        await relay.stop_services()

    app.on_startup.append(_on_startup)
    app.on_cleanup.append(_on_cleanup)
    return app


if __name__ == "__main__":
    application = create_app()
    relay_instance: NovelRelayApp = application["relay"]
    LOG.info("Starting novel-relay on http://%s:%d", relay_instance.host, relay_instance.port)
    web.run_app(application, host=relay_instance.host, port=relay_instance.port, access_log=None)
