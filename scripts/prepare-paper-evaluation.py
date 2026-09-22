"""Download two public papers into a local cache; never write credentials or user files."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import urllib.request
import xml.etree.ElementTree as ET

folder = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/pdf-model-public-papers")
folder.mkdir(parents=True, exist_ok=True)
sources = [
    {"id": "attention", "title": "Attention Is All You Need", "language": "en",
     "url": "https://arxiv.org/pdf/1706.03762v7", "pageOffset": 0, "bodyPages": 10},
    {"id": "multilingual", "title": "大模型时代的多语言研究综述", "language": "zh",
     "url": "https://aclanthology.org/2024.ccl-2.4.pdf", "pageOffset": 62, "bodyPages": 12},
]


def extract_chinese(pdf):
    # This particular PDF's SFRM/SFBX fonts map Latin glyphs into U+6500.
    # Decode only those fonts, preserving genuine Chinese characters unchanged.
    xml = subprocess.check_output(["pdftohtml", "-xml", "-hidden", "-i", "-stdout", str(pdf)])
    root = ET.fromstring(xml)
    fonts = {e.attrib["id"]: e.attrib["family"] for e in root.iter("fontspec")}
    ligatures = {0x10: "“", 0x11: "”", 0x1b: "ff", 0x1c: "fi", 0x1d: "fl", 0x1e: "ffi", 0x1f: "ffl"}
    pages = []
    for page in root.findall("page"):
        lines, seen = [], set()
        top, end = -100, 0
        for element in page.findall("text"):
            text = "".join(element.itertext())
            if "+SF" in fonts[element.attrib["font"]]:
                text = "".join(ligatures.get(ord(c) - 0x6500, chr(ord(c) - 0x6500))
                               if 0x6500 <= ord(c) <= 0x65ff else c for c in text)
            y, x = int(element.attrib["top"]), int(element.attrib["left"])
            # Synthetic bold paints a glyph several times at the same position.
            if (text, x, y) in seen:
                continue
            seen.add((text, x, y))
            if abs(y - top) > 4:
                lines.append(text)
                top = y
            else:
                lines[-1] += (" " if x - end > 2 else "") + text
            end = x + int(element.attrib["width"])
        pages.append("\n".join(lines))
    assert len(pages) == 23
    assert "204,114" in pages[3] and "Bactrain-X" in pages[3] and "ROOTS" in pages[3]
    return pages


papers = []
for source in sources:
    pdf = folder / (source["id"] + ".pdf")
    if not pdf.exists():
        with urllib.request.urlopen(source["url"], timeout=40) as response:
            data = response.read(10 * 1024 * 1024 + 1)
        if not data.startswith(b"%PDF") or len(data) > 10 * 1024 * 1024:
            raise ValueError("Unexpected public paper download")
        pdf.write_bytes(data)
    if source["language"] == "zh":
        pages = extract_chinese(pdf)
    else:
        text = subprocess.check_output(["pdftotext", "-layout", str(pdf), "-"], text=True)
        pages = [page for page in text.split("\f") if page.strip()]
        assert len(pages) == 15 and "28.4" in pages[7]
    papers.append({**source, "pdfSha256": hashlib.sha256(pdf.read_bytes()).hexdigest(), "pages": pages})

(folder / "papers.json").write_text(json.dumps(papers, ensure_ascii=False, indent=2) + "\n")
print(json.dumps([{k: v for k, v in paper.items() if k != "pages"} for paper in papers], ensure_ascii=False, indent=2))
