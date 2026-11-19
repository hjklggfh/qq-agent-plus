#!/usr/bin/env python3
# 把「更新JM」/「今日JM」清单渲染成一张信息图（封面网格卡片，方便群里一张图看完）。
#
# 输入：stdin 传 JSON（由 daily_updates.mjs 组装，标题/标签已转简体并排好序）：
#   { "title": "📥 今日禁漫更新 49 本",          # 大标题
#     "subtitle": "2026-10-06 · 截至 10:23 · …", # 副标题（可空）
#     "footnote": "共 49 本 …",                  # 底部备注（可空）
#     "items": [
#       { "id": "1158362", "title": "...", "kind": "单本", "tags": ["青年漫"], "cover": "/abs/path.jpg" } ] }
# 输出：JPEG 到 argv[1]（必填）。退出码 0 = 成功。
#
# 设计：5 列卡片；每张卡 = 封面(3:4 缩放) + 编号/JM编号(醒目) + 标题(最多2行) + 类型·标签。
# 字体：DroidSansFallbackFull（服务器唯一中文字体，含假名）。

import hashlib
import json
import math
import os
import sys

from PIL import Image, ImageDraw, ImageFont

# ── 字体选择 ──────────────────────────────────────────────
# ⚠️ 大坑（2026-10-06）：系统默认的 DroidSansFallbackFull 是"回退字体"，
#    **只有汉字和假名，没有阿拉伯数字和拉丁字母** —— 数字和 JM 全画成"口"豆腐块。
#    装了 fonts-wqy-microhei（数字+汉字+假名全覆盖）后按优先级选它。
FONT_CANDIDATES = [
    ("/usr/share/fonts/truetype/wqy/wqy-microhei.ttc", 0),
    ("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", 2),
    ("/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf", 0),
    ("C:/Windows/Fonts/msyh.ttc", 0),
    ("C:/Windows/Fonts/simhei.ttf", 0),
]
_FONT_PATH, _FONT_INDEX = None, 0
for _p, _i in FONT_CANDIDATES:
    if os.path.exists(_p):
        _FONT_PATH, _FONT_INDEX = _p, _i
        break

SCRAMBLE_268850 = 268850
SCRAMBLE_421926 = 421926


# 新字体没有 emoji 字形（📥 这类会变豆腐），画图前把 BMP 外的字符剥掉。
def clean_glyphs(s):
    return "".join(ch for ch in str(s) if ord(ch) <= 0xFFEF)


def load_font(size):
    if _FONT_PATH:
        return ImageFont.truetype(_FONT_PATH, size, index=_FONT_INDEX)
    return ImageFont.load_default()


def segmentation_num(scramble_id, album_id, filename):
    """与 jm_worker.py 一致的切块数算法（输入文件名为本地页图时必须去扩展名）。"""
    try:
        sid = int(scramble_id or 0)
        aid = int(album_id or 0)
    except (TypeError, ValueError):
        return 0
    if sid <= 0 or aid < sid:
        return 0
    if aid < SCRAMBLE_268850:
        return 10
    x = 10 if aid < SCRAMBLE_421926 else 8
    stem = os.path.splitext(os.path.basename(str(filename)))[0]
    last = hashlib.md5(f"{aid}{stem}".encode("utf-8")).hexdigest()[-1]
    return (ord(last) % x) * 2 + 2


def descramble_image(img, num):
    """把被竖切混淆的页图还原，避免卡片封面变成条块错位堆砌。"""
    if num <= 0:
        return img
    w, h = img.size
    out = Image.new(img.mode, (w, h))
    over = h % num
    move = math.floor(h / num)
    for i in range(num):
        piece = move + over if i == 0 else move
        y_src = h - (move * (i + 1)) - over
        y_dst = 0 if i == 0 else move * i + over
        out.paste(img.crop((0, y_src, w, y_src + piece)), (0, y_dst, w, y_dst + piece))
    return out


def prepare_cover(cover_path, tw, th, album_id="", scramble_id=0, cover_scrambled=False):
    """读取封面图；仅当显式标记为未还原的本地页图时按 scramble_id 还原后再居中裁切。"""
    if not cover_path or not os.path.exists(cover_path):
        return None
    try:
        with Image.open(cover_path) as raw:
            im = raw.convert("RGB")
        if cover_scrambled:
            num = segmentation_num(scramble_id, album_id, cover_path)
            if num > 0:
                im = descramble_image(im, num)
        sw, sh = im.size
        scale = max(tw / sw, th / sh)
        nw, nh = int(sw * scale + 0.5), int(sh * scale + 0.5)
        im = im.resize((nw, nh), Image.LANCZOS)
        left = (nw - tw) // 2
        top = (nh - th) // 2
        return im.crop((left, top, left + tw, top + th))
    except Exception:
        return None


def draw_cover_slot(img, draw, x, y, tw, th, radius, item, fallback_font):
    """统一绘制圆角封面或无封面占位。"""
    cover_img = prepare_cover(
        item.get("cover") or "",
        tw,
        th,
        album_id=item.get("id") or "",
        scramble_id=item.get("cover_scramble_id") or 0,
        cover_scrambled=bool(item.get("cover_scrambled")),
    )
    if cover_img is not None:
        mask = Image.new("L", cover_img.size, 0)
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, cover_img.size[0], cover_img.size[1]), radius=radius, fill=255)
        img.paste(cover_img, (x, y), mask)
    else:
        draw.rounded_rectangle((x, y, x + tw, y + th), radius=radius, fill=(52, 56, 68))
        draw.text((x + max(10, tw // 2 - 42), y + th // 2 - 14), "无封面", font=fallback_font, fill=(120, 128, 140))

COLS = 4
CARD_W = 320
COVER_H = 424          # 320 * 4/3 ≈ 427，取 424 留白
GAP = 12
PAD_X = 14
ID_BADGE_H = 46        # 封面下方「编号. JMxxxx」徽章条
LINE_H = 32            # 标题行高（24px 字）
META_H = 30
HEADER_H = 128
FOOTER_H = 74
MAX_CARDS = 60         # 超过就不画（防止图片过大），清单文字里已有总数说明


def clip_text(draw, text, font, max_w):
    """按像素宽度截断，尾部加省略号。"""
    if draw.textlength(text, font=font) <= max_w:
        return text
    ell = "…"
    while len(text) > 1 and draw.textlength(text + ell, font=font) > max_w:
        text = text[:-1]
    return text + ell


def wrap_cjk(draw, text, font, max_w):
    """中文/日文按字折行（CJK 任意字符可断行），返回行列表。"""
    lines = []
    cur = ""
    for ch in str(text):
        if ch == "\n":
            lines.append(cur)
            cur = ""
            continue
        if draw.textlength(cur + ch, font=font) > max_w and cur:
            lines.append(cur)
            cur = ch
        else:
            cur += ch
    if cur:
        lines.append(cur)
    return lines or [""]


def main():
    if len(sys.argv) < 2:
        print("用法: daily_image.py <输出.jpg>  (清单 JSON 从 stdin 读)", file=sys.stderr)
        return 2
    out_path = sys.argv[1]

    payload = json.load(sys.stdin)
    items = payload.get("items", [])[:MAX_CARDS]
    total_n = int(payload.get("total") or len(items))
    head_title = clean_glyphs(payload.get("title") or f"清单（{len(items)} 本）")
    subtitle = clean_glyphs(payload.get("subtitle") or "")
    footnote = clean_glyphs(payload.get("footnote") or "")
    for it in items:
        it["title"] = clean_glyphs(it.get("title") or "")
        it["kind"] = clean_glyphs(it.get("kind") or "")
        it["tags"] = [clean_glyphs(t) for t in (it.get("tags") or [])]
        it["id"] = str(it.get("id") or "")

    f_head = load_font(40)
    f_sub = load_font(22)
    f_id = load_font(40)
    f_title = load_font(24)
    f_meta = load_font(20)

    rows = max(1, math.ceil(len(items) / COLS))
    card_h = COVER_H + ID_BADGE_H + 2 * LINE_H + META_H + 18
    canvas_w = PAD_X * 2 + COLS * CARD_W + (COLS - 1) * GAP
    canvas_h = HEADER_H + rows * (card_h + GAP) + FOOTER_H + 10

    img = Image.new("RGB", (canvas_w, canvas_h), (23, 25, 31))
    draw = ImageDraw.Draw(img)

    # ── 头部 ──
    head_y = 28
    draw.text((PAD_X + 4, head_y), head_title, font=f_head, fill=(255, 255, 255))
    if subtitle:
        draw.text((PAD_X + 4, head_y + 56), subtitle, font=f_sub, fill=(150, 158, 170))

    # ── 卡片 ──
    y = HEADER_H
    for idx, it in enumerate(items):
        col = idx % COLS
        row = idx // COLS
        cx = PAD_X + col * (CARD_W + GAP)
        cy = y + row * (card_h + GAP)

        # 卡片底板（比背景稍亮，圆角）
        draw.rounded_rectangle(
            (cx, cy, cx + CARD_W, cy + card_h),
            radius=12,
            fill=(38, 41, 51),
        )

        # 封面（居中裁成 3:4 再缩放；圆角粘贴，观感更柔和）
        draw_cover_slot(img, draw, cx + 4, cy + 4, CARD_W - 8, COVER_H - 4, 10, it, f_meta)

        # 编号徽章条：唯一编号来源，深底 + 亮青大字，缩略图也能认出
        ty = cy + COVER_H + 6
        draw.rounded_rectangle(
            (cx + 8, ty, cx + CARD_W - 8, ty + ID_BADGE_H),
            radius=10,
            fill=(30, 52, 66),
        )
        rank_no = it.get("rank")
        label = f"#{rank_no} JM{it.get('id', '')}" if rank_no else f"{idx + 1}. JM{it.get('id', '')}"
        # 文字按徽章宽度居中；编号较长时微缩字号防溢出
        badge_font = f_id
        if draw.textlength(label, font=badge_font) > CARD_W - 24:
            badge_font = load_font(32)
        label_w = draw.textlength(label, font=badge_font)
        lx = cx + 8 + ((CARD_W - 16) - label_w) / 2
        ly = ty + max(1, (ID_BADGE_H - badge_font.size) // 2 - 2)
        draw.text((lx, ly), label, font=badge_font, fill=(96, 208, 255))
        # 标题（最多 2 行）
        title = str(it.get("title") or "")
        ty2 = ty + ID_BADGE_H + 4
        line1 = clip_text(draw, title, f_title, CARD_W - 20)
        draw.text((cx + 10, ty2), line1, font=f_title, fill=(230, 230, 235))
        rest = title[len(line1.rstrip("…")):] if line1.endswith("…") else ""
        if rest:
            draw.text((cx + 10, ty2 + LINE_H), clip_text(draw, rest, f_title, CARD_W - 20),
                      font=f_title, fill=(230, 230, 235))
        # 类型 · 标签
        kind = str(it.get("kind") or "")
        tags = [str(t) for t in (it.get("tags") or [])][:3]
        meta = " · ".join(x for x in [kind] + tags if x)
        draw.text((cx + 10, cy + card_h - META_H - 8), clip_text(draw, meta, f_meta, CARD_W - 20),
                  font=f_meta, fill=(158, 178, 152))

    # ── 底部 ──
    foot_y = canvas_h - FOOTER_H - 2
    drawn_n = len(items)
    extra = f"（仅画前 {drawn_n} 本，其余略）" if total_n > drawn_n else ""
    note = f"{footnote}{extra}".strip()
    draw.text((PAD_X + 4, foot_y), note or f"共 {total_n} 本", font=f_sub, fill=(120, 128, 140))

    img.save(out_path, "JPEG", quality=82)
    return 0


# ═══════════════════════ 单本信息卡（下载完成的「简介」卡片）═══════════════════════
# 输入 stdin JSON：{ id, title, authors:[], tags:[], kind:"N 话 · M 张",
#                    pdf:"PDF 123 页（2.1 MB）", desc:"...", cover:"/abs/path" }
# 布局：左边封面（圆角），右边标题/ID徽章/作者/标签/规模，底部通栏简介。

ALBUM_W = 1344
COVER_AW = 380
COVER_AH = 507


def render_album(out_path):
    payload = json.load(sys.stdin)
    aid = str(payload.get("id") or "")
    title = clean_glyphs(payload.get("title") or f"JM{aid}")
    authors = [clean_glyphs(a) for a in (payload.get("authors") or [])][:3]
    tags = [clean_glyphs(t) for t in (payload.get("tags") or [])][:10]
    kind = clean_glyphs(payload.get("kind") or "")
    pdf = clean_glyphs(payload.get("pdf") or "")
    desc = clean_glyphs(payload.get("desc") or "").strip()

    f_t = load_font(34)
    f_id = load_font(34)
    f_line = load_font(24)
    f_small = load_font(20)
    f_desc = load_font(22)

    probe = ImageDraw.Draw(Image.new("RGB", (8, 8)))
    info_w = ALBUM_W - COVER_AW - 36 * 3   # 右栏可用宽度

    # 预折行（先量高度）
    title_lines = wrap_cjk(probe, title, f_t, info_w)[:2]
    if len(wrap_cjk(probe, title, f_t, info_w)) > 2:
        title_lines[-1] = clip_text(probe, title_lines[-1], f_t, info_w)
    tag_line = "标签：" + "/".join(tags) if tags else ""
    tag_lines = wrap_cjk(probe, tag_line, f_line, info_w)[:2] if tag_line else []
    author_line = ("作者：" + "、".join(authors)) if authors else ""
    stat_line = " · ".join(x for x in [kind, pdf] if x)
    desc_lines = wrap_cjk(probe, desc, f_desc, ALBUM_W - 56)[:8]
    if len(wrap_cjk(probe, desc, f_desc, ALBUM_W - 56)) > 8:
        desc_lines[-1] = clip_text(probe, desc_lines[-1], f_desc, ALBUM_W - 56)

    right_h = len(title_lines) * 46 + 18 + 58 + 16 + (36 if author_line else 0) \
        + len(tag_lines) * 34 + (34 if stat_line else 0) + 20
    body_h = max(COVER_AH + 72, right_h + 72)
    desc_h = (len(desc_lines) * 32 + 66) if desc_lines and desc_lines != [""] else 0
    canvas_h = int(body_h + desc_h + 16)

    img = Image.new("RGB", (ALBUM_W, canvas_h), (23, 25, 31))
    draw = ImageDraw.Draw(img)

    # 左：封面
    draw_cover_slot(img, draw, 28, 36, COVER_AW, COVER_AH, 14, payload, f_line)

    # 右：信息
    x0 = COVER_AW + 36 * 2
    y = 44
    for ln in title_lines:
        draw.text((x0, y), ln, font=f_t, fill=(240, 240, 245))
        y += 46
    y += 14
    # ID 徽章
    pill_w = 236
    draw.rounded_rectangle((x0, y, x0 + pill_w, y + 58), radius=12, fill=(30, 52, 66))
    idt = f"JM{aid}"
    draw.text((x0 + (pill_w - draw.textlength(idt, font=f_id)) / 2, y + 9), idt,
              font=f_id, fill=(96, 208, 255))
    y += 58 + 16
    if author_line:
        draw.text((x0, y), clip_text(probe, author_line, f_line, info_w), font=f_line, fill=(190, 194, 202))
        y += 36
    for ln in tag_lines:
        draw.text((x0, y), ln, font=f_line, fill=(158, 178, 152))
        y += 34
    if stat_line:
        draw.text((x0, y), clip_text(probe, stat_line, f_line, info_w), font=f_line, fill=(150, 158, 170))
        y += 34

    # 底部：简介通栏
    if desc_h:
        dy = body_h + 8
        draw.text((28, dy), "简介", font=f_small, fill=(150, 158, 170))
        dy += 34
        for ln in desc_lines:
            draw.text((28, dy), ln, font=f_desc, fill=(215, 215, 222))
            dy += 32

    img.save(out_path, "JPEG", quality=85)
    return 0


if __name__ == "__main__":
    if "--album" in sys.argv[1:]:
        # 用法: daily_image.py --album <输出.jpg>（JSON 从 stdin）
        try:
            out = sys.argv[sys.argv.index("--album") + 1]
        except IndexError:
            print("缺输出路径", file=sys.stderr)
            sys.exit(2)
        sys.exit(render_album(out))
    sys.exit(main())
