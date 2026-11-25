import unittest

from cleaner import (
    clean_caption,
    is_allowed_novel_file,
    matches_filters,
    normalize_txt_bytes,
    parse_search_query,
)
from web_sources import (
    clean_pixiv_novel_body,
    extract_cool18_body,
    is_pixiv_spam_novel,
    parse_cool18_search_html,
    parse_esjzone_cards,
)


class TestNovelCleaner(unittest.TestCase):
    def test_happylibrary_screenshot_ad_stripping(self):
        caption = (
            "转生，然后捡到冷眼女魔头\n"
            "您的一票(点赞或好评评论)很重要,可能决定一本书的推书投稿更新频率\n"
            "点赞,评论,是对推书书友的支持\n\n"
            "群友letter(代号)投稿上传,后宫\n\n"
            "旧链接(有多个;只列其一):点击查看\n"
            "————\n"
            "“简介”在底部标签偏上处\n"
            "小说标签分类 等索引:点击查看\n"
            "————\n"
            "奈奈AI色色女友:点击查看\n"
            "风月AI色色女友:点击查看\n"
            "夜语AI色色女友:点击查看\n"
            "色色优质飞机杯:点击查看\n"
            "香草AI色色女友:点击查看\n"
            "高速机场VPN 便宜:点击查看\n\n"
            "【本文件与推书相关只投稿“开心书库”频道】\n"
            "主角转生异世界后在雪山捡到重伤冷眼女魔头，开启收留与反差日常。\n"
            "#下克上 #NTL #后宫 #群友书评 #小说评论\n"
            "书评作者：老莫"
        )
        entities = []
        idx = 0
        while True:
            pos = caption.find("点击查看", idx)
            if pos < 0:
                break
            u16_off = len(caption[:pos].encode("utf-16-le")) // 2
            u16_len = len("点击查看".encode("utf-16-le")) // 2
            entities.append({"type": "MessageEntityTextUrl", "offset": u16_off, "length": u16_len})
            idx = pos + 4

        result = clean_caption(
            caption,
            entities=entities,
            file_name="《转生，然后捡到冷眼女魔头》排版01_87连载+番外_作品.txt",
            summary_mode="clean",
        )
        self.assertEqual(result["title"], "转生，然后捡到冷眼女魔头")
        self.assertIn("下克上", result["tags"])
        self.assertIn("NTL", result["tags"])
        self.assertIn("后宫", result["tags"])
        self.assertNotIn("群友书评", result["tags"])
        self.assertIn("雪山捡到重伤冷眼女魔头", result["summary"])
        for forbidden in ("飞机杯", "色色女友", "机场", "VPN", "点击查看", "您的一票", "旧链接", "书评作者"):
            self.assertNotIn(forbidden, result["summary"])

    def test_minimal_mode_strips_all_summary(self):
        res = clean_caption("一段简介内容\n#纯爱 #校园", file_name="《校园物语》.txt", summary_mode="minimal")
        self.assertEqual(res["title"], "校园物语")
        self.assertEqual(res["tags"], ["纯爱", "校园"])
        self.assertEqual(res["summary"], "")

    def test_query_parser_and_multi_tag_exclude(self):
        parsed = parse_search_query("#后宫 #下克上 流萤 -NTR -#猎奇")
        self.assertEqual(parsed["tags"], ["后宫", "下克上"])
        self.assertEqual(parsed["keywords"], ["流萤"])
        self.assertEqual(parsed["exclude"], ["NTR", "猎奇"])

        good = {
            "title": "流萤的异界日常",
            "fileName": "流萤.txt",
            "tags": ["后宫", "下克上", "纯爱"],
            "summary": "甜宠故事",
        }
        bad_ntr = {**good, "tags": ["后宫", "下克上", "NTR"]}
        bad_missing_tag = {**good, "tags": ["后宫"]}

        self.assertTrue(matches_filters(good, keywords=parsed["keywords"], tags=parsed["tags"], exclude=parsed["exclude"]))
        self.assertFalse(matches_filters(bad_ntr, keywords=parsed["keywords"], tags=parsed["tags"], exclude=parsed["exclude"]))
        self.assertFalse(matches_filters(bad_missing_tag, keywords=parsed["keywords"], tags=parsed["tags"], exclude=parsed["exclude"]))

    def test_gb18030_txt_normalization(self):
        text = "第一章 雪山初遇\n你好世界！"
        raw_gbk = text.encode("gb18030")
        out, enc = normalize_txt_bytes(raw_gbk)
        self.assertEqual(enc, "gb18030")
        self.assertEqual(out.decode("utf-8"), text)

    def test_allowed_extensions(self):
        self.assertTrue(is_allowed_novel_file("book.txt"))
        self.assertTrue(is_allowed_novel_file("book.EPUB"))
        self.assertFalse(is_allowed_novel_file("promo.mp4"))
        self.assertFalse(is_allowed_novel_file("malware.exe"))

    def test_pixiv_anti_spam_and_body_cleaner(self):
        rp_spam = {
            "title": "《二相乐园》崩原铁绝米家语c群招新",
            "description": "欢迎加入语擦文爱群",
            "tags": ["原神", "流萤", "语C"],
            "textCount": 3200,
            "bookmarkCount": 1,
        }
        short_post = {
            "title": "流萤短段子",
            "description": "随笔",
            "tags": ["流萤"],
            "textCount": 400,
            "bookmarkCount": 5,
        }
        tag_stuffing = {
            "title": "同人合集",
            "description": "随便写写",
            "tags": ["原神", "崩坏星穹铁道", "绝区零", "鸣潮", "蔚蓝档案"],
            "textCount": 2000,
            "bookmarkCount": 2,
        }
        genuine = {
            "title": "星海与流萤的约定",
            "description": "正经同人长篇",
            "tags": ["流萤", "崩坏星穹铁道", "纯爱"],
            "textCount": 8600,
            "bookmarkCount": 120,
        }
        self.assertTrue(is_pixiv_spam_novel(rp_spam, min_chars=1500))
        self.assertTrue(is_pixiv_spam_novel(short_post, min_chars=1500))
        self.assertTrue(is_pixiv_spam_novel(tag_stuffing, min_chars=1500))
        self.assertFalse(is_pixiv_spam_novel(genuine, min_chars=1500))

        raw_body = "[chapter:序章]\n[[rb:流萤 > ほたる]]看着星空。[newpage]\n第二页内容。[uploadedimage:123]"
        cleaned = clean_pixiv_novel_body(raw_body)
        self.assertIn("=== 序章 ===", cleaned)
        self.assertIn("流萤（ほたる）", cleaned)
        self.assertNotIn("[newpage]", cleaned)
        self.assertNotIn("[uploadedimage", cleaned)

    def test_cool18_search_skips_top_pinned_and_extracts_body(self):
        sample_html = """
        <div class="top_pinned"><a href="index.php?app=forum&act=threadview&tid=11111">顶部精华无关帖</a></div>
        <form><input name="keywords"></form>
        <ul id="thread_list">
          <li><a href="index.php?app=forum&act=threadview&tid=14642442">【流萤同人】星穹之夜(1-5)</a> (18500 bytes) 2026-11-20</li>
          <li><a href="index.php?app=forum&act=threadview&tid=14642443">版规公告请勿水帖</a></li>
        </ul>
        """
        items = parse_cool18_search_html(sample_html, mode="search")
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["id"], "14642442")
        self.assertIn("流萤同人", items[0]["title"])

        thread_html = "<title>星穹之夜 - 禁忌书屋 cool18</title><pre>#纯爱 #流萤\n第一章 正文内容。</pre>"
        title, body, tags = extract_cool18_body(thread_html)
        self.assertEqual(title, "星穹之夜")
        self.assertIn("第一章 正文内容", body)
        self.assertEqual(tags, ["纯爱", "流萤"])

    def test_esjzone_cards_parser(self):
        sample = """
        <div class="card-body">
          <h5 class="card-title"><a href="/detail/1698065287.html">提瓦特 螢的日記</a></h5>
          <span class="badge">R18</span>
          <div class="card-ep">第51章 结局</div>
        </div>
        """
        items = parse_esjzone_cards(sample)
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["id"], "1698065287")
        self.assertIn("R18", items[0]["tags"])
        self.assertIn("第51章", items[0]["sizeText"])


if __name__ == "__main__":
    unittest.main()
