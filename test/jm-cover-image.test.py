"""Regression for JM card cover descrambling and non-scrambled official covers."""

import json
import math
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image


DAILY_IMAGE = Path(__file__).resolve().parents[1] / "src/features/jm-suomingor/daily_image.py"
sys.path.insert(0, str(DAILY_IMAGE.parent))
import daily_image  # noqa: E402


def scramble_image(img, num):
    """Inverse of descramble_image: split top-to-bottom and stack bottom-to-top."""
    w, h = img.size
    out = Image.new(img.mode, (w, h))
    over = h % num
    move = math.floor(h / num)
    for i in range(num):
        piece = move + over if i == 0 else move
        y_plain = 0 if i == 0 else move * i + over
        y_scrambled = h - (move * (i + 1)) - over
        out.paste(img.crop((0, y_plain, w, y_plain + piece)), (0, y_scrambled, w, y_scrambled + piece))
    return out


def make_top_red_bottom_blue(w=380, h=507):
    img = Image.new("RGB", (w, h), (220, 40, 40))
    img.paste(Image.new("RGB", (w, h - h // 2), (40, 90, 220)), (0, h // 2))
    return img


class JmCoverImageTest(unittest.TestCase):
    def test_render_album_descrambles_local_fallback_but_keeps_official_cover(self):
        album_id = "533801"
        scramble_id = 220980
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            plain_cover = root / "official.jpg"
            make_top_red_bottom_blue().save(plain_cover, quality=95)

            local_page = root / "00001.png"
            num = daily_image.segmentation_num(scramble_id, album_id, str(local_page))
            self.assertGreater(num, 0)
            scramble_image(make_top_red_bottom_blue(), num).save(local_page)

            # 1) 本地页图标记 cover_scrambled=True 时应先还原（左上角区域上方红、下方蓝）
            out_local = root / "album-local.jpg"
            r1 = subprocess.run(
                [sys.executable, str(DAILY_IMAGE), "--album", str(out_local)],
                input=json.dumps({
                    "id": album_id,
                    "title": "Test Title",
                    "cover": str(local_page),
                    "cover_scramble_id": scramble_id,
                    "cover_scrambled": True,
                }),
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(r1.returncode, 0, r1.stderr)
            with Image.open(out_local) as card:
                top_px = card.getpixel((218, 100))
                bot_px = card.getpixel((218, 480))
                self.assertGreater(top_px[0], 170)
                self.assertLess(top_px[2], 90)
                self.assertGreater(bot_px[2], 170)
                self.assertLess(bot_px[0], 90)

            # 2) 官方 3:4 封面（cover_scrambled=False）绝不能重复切块
            out_official = root / "album-official.jpg"
            r2 = subprocess.run(
                [sys.executable, str(DAILY_IMAGE), "--album", str(out_official)],
                input=json.dumps({
                    "id": album_id,
                    "title": "Test Title",
                    "cover": str(plain_cover),
                    "cover_scramble_id": 0,
                    "cover_scrambled": False,
                }),
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(r2.returncode, 0, r2.stderr)
            with Image.open(out_official) as card:
                top_px = card.getpixel((218, 100))
                bot_px = card.getpixel((218, 480))
                self.assertGreater(top_px[0], 170)
                self.assertGreater(bot_px[2], 170)

    def test_digest_grid_descrambles_fallback_cover(self):
        album_id = "1491079"
        scramble_id = 220980
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            local_page = root / "00001.png"
            num = daily_image.segmentation_num(scramble_id, album_id, str(local_page))
            scramble_image(make_top_red_bottom_blue(312, 420), num).save(local_page)

            out_digest = root / "digest.jpg"
            r = subprocess.run(
                [sys.executable, str(DAILY_IMAGE), str(out_digest)],
                input=json.dumps({
                    "title": "Digest",
                    "items": [{
                        "id": album_id,
                        "title": "Item",
                        "cover": str(local_page),
                        "cover_scramble_id": scramble_id,
                        "cover_scrambled": True,
                    }],
                }),
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(r.returncode, 0, r.stderr)
            with Image.open(out_digest) as card:
                top_px = card.getpixel((170, 200))
                bot_px = card.getpixel((170, 480))
                self.assertGreater(top_px[0], 170)
                self.assertLess(top_px[2], 90)
                self.assertGreater(bot_px[2], 170)
                self.assertLess(bot_px[0], 90)


if __name__ == "__main__":
    unittest.main()
