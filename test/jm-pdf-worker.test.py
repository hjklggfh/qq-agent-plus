"""Regression for JM PDF generation under a bounded memory budget."""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image


WORKER = Path(__file__).resolve().parents[1] / "src/features/jm-suomingor/jm_worker.py"


def memory_limit():
    if sys.platform != "linux":
        return None
    import resource
    limit = 384 * 1024 * 1024
    resource.setrlimit(resource.RLIMIT_AS, (limit, limit))


def invoke(task):
    result = subprocess.run(
        [sys.executable, str(WORKER)], input=json.dumps(task), text=True,
        capture_output=True, timeout=60,
        preexec_fn=memory_limit if sys.platform == "linux" else None,
        check=False,
    )
    lines = [json.loads(line) for line in result.stdout.splitlines() if line.startswith("{")]
    return result, lines[-1] if lines else None


class JmPdfWorkerTest(unittest.TestCase):
    def test_many_pages_are_written_without_retaining_all_images(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            image = root / "page.jpg"
            # One source page repeated 36 times exercises the old frames[] OOM.
            Image.new("RGB", (1200, 1800), (122, 85, 173)).save(image, quality=90)
            self.assertGreater(image.stat().st_size, 512)
            output = root / "album.pdf"
            result, final = invoke({
                "album_id": "1475771", "output": str(output), "descramble": False,
                "chapters": [{"name": "chapter", "pages": [str(image)] * 36}],
            })
            self.assertEqual(result.returncode, 0, result.stderr or str(final))
            self.assertTrue(final["ok"], final)
            self.assertEqual(final["pagesOk"], 36)
            self.assertTrue(output.read_bytes().startswith(b"%PDF-1.4"))
            self.assertFalse((root / "album.pdf.part").exists())
            try:
                from pypdf import PdfReader
            except ImportError:
                pass
            else:
                self.assertEqual(len(PdfReader(str(output)).pages), 36)

    def test_failed_pages_leave_no_partial_pdf(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            output = root / "bad.pdf"
            result, final = invoke({
                "album_id": "1475771", "output": str(output),
                "chapters": [{"pages": [str(root / "missing.jpg")]}],
            })
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(final["ok"])
            self.assertFalse(output.exists())
            self.assertFalse((root / "bad.pdf.part").exists())


if __name__ == "__main__":
    unittest.main()
