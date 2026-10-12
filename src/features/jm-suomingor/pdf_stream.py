"""Write a JPEG-backed PDF one page at a time without retaining decoded pages."""

import os


class PdfStream:
    def __init__(self, target):
        self.target = target
        self.part = target + ".part"
        self.file = open(self.part, "wb")
        self.offsets = {}
        self.pages = []
        self.next_id = 3
        self.file.write(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
        self._object(1, b"<< /Type /Catalog /Pages 2 0 R >>")

    def _object(self, object_id, body):
        self.offsets[object_id] = self.file.tell()
        self.file.write(f"{object_id} 0 obj\n".encode("ascii"))
        self.file.write(body)
        self.file.write(b"\nendobj\n")

    def append_jpeg(self, jpeg_path, width, height):
        image_id = self.next_id
        length_id = image_id + 1
        content_id = image_id + 2
        page_id = image_id + 3
        self.next_id += 4

        size = os.path.getsize(jpeg_path)
        image_dict = (f"<< /Type /XObject /Subtype /Image /Width {width} /Height {height} "
                      f"/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode "
                      f"/Length {length_id} 0 R >>\nstream\n").encode("ascii")
        self.offsets[image_id] = self.file.tell()
        self.file.write(f"{image_id} 0 obj\n".encode("ascii"))
        self.file.write(image_dict)
        with open(jpeg_path, "rb") as source:
            while True:
                chunk = source.read(1024 * 1024)
                if not chunk:
                    break
                self.file.write(chunk)
        self.file.write(b"\nendstream\nendobj\n")
        self._object(length_id, str(size).encode("ascii"))

        page_width = width * 72 / 150
        page_height = height * 72 / 150
        content = (f"q {page_width:.4f} 0 0 {page_height:.4f} 0 0 cm /Im0 Do Q\n").encode("ascii")
        self._object(content_id, f"<< /Length {len(content)} >>\nstream\n".encode("ascii")
                     + content + b"endstream")
        self._object(page_id, (f"<< /Type /Page /Parent 2 0 R "
                               f"/MediaBox [0 0 {page_width:.4f} {page_height:.4f}] "
                               f"/Resources << /XObject << /Im0 {image_id} 0 R >> >> "
                               f"/Contents {content_id} 0 R >>").encode("ascii"))
        self.pages.append(page_id)

    def finish(self):
        kids = " ".join(f"{page} 0 R" for page in self.pages)
        self._object(2, f"<< /Type /Pages /Kids [{kids}] /Count {len(self.pages)} >>".encode("ascii"))
        xref_start = self.file.tell()
        self.file.write(f"xref\n0 {self.next_id}\n".encode("ascii"))
        self.file.write(b"0000000000 65535 f \n")
        for object_id in range(1, self.next_id):
            self.file.write(f"{self.offsets[object_id]:010d} 00000 n \n".encode("ascii"))
        self.file.write((f"trailer\n<< /Size {self.next_id} /Root 1 0 R >>\n"
                         f"startxref\n{xref_start}\n%%EOF\n").encode("ascii"))
        self.file.flush()
        os.fsync(self.file.fileno())
        self.file.close()
        os.replace(self.part, self.target)

    def abort(self):
        if not self.file.closed:
            self.file.close()
        try:
            os.remove(self.part)
        except FileNotFoundError:
            pass
