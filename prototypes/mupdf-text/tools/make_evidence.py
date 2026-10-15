"""Builds docs/evidence.png (first matrix) and docs/evidence-gaps.png (Type1,
Type3, CJK, tagged) from the crops written by run-node.mjs and
verify_pdfium.py: before (MuPDF), after (MuPDF), after (pdfium) per case."""
import os

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "out")
SHEETS = {
    "evidence.png": ["chrome-specials", "chrome-missing-glyphs", "word-calibri", "word-cambria", "rl-helvetica-std14",
                     "rl-arial-custom-enc", "fullfont-identity-path", "xobject-cm-link", "tz-tc-spacing",
                     "chrome-whole-line", "rl-rotate90-upright", "chrome-rotate90-crop", "enc-user-aes128"],
    "evidence-gaps.png": ["type1-pdftex", "type1-missing-glyphs", "type1c-missing-glyphs", "type3-matplotlib",
                          "type3-fallback", "cjk-ucs2-h", "cjk-rksj-fallback", "cjk-ucs2-v", "cjk-identity-v",
                          "cjk-identity-v-fallback", "word-tagged-whole-line"],
}
W = 520

try:
    FONT = ImageFont.truetype(os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts", "segoeui.ttf"), 15)
except OSError:
    FONT = ImageFont.load_default()


def fit(im, w=W, maxh=260):
    s = min(w / im.width, maxh / im.height)
    return im.resize((max(1, int(im.width * s)), max(1, int(im.height * s))), Image.LANCZOS)


def sheet(ids, name):
    rows = []
    for cid in ids:
        cells = [fit(Image.open(os.path.join(OUT, f"{cid}-1-{k}.png")).convert("RGB"))
                 for k in ("before", "after", "after-pdfium")]
        row = Image.new("RGB", (W * 3 + 40, max(c.height for c in cells) + 26), "white")
        d = ImageDraw.Draw(row)
        d.text((6, 3), cid, fill=(30, 30, 30), font=FONT)
        for i, c in enumerate(cells):
            x = 10 + i * (W + 10)
            row.paste(c, (x, 24))
            d.rectangle([x - 1, 23, x + c.width, 24 + c.height], outline=(200, 200, 200))
        rows.append(row)

    head = Image.new("RGB", (W * 3 + 40, 30), (255, 233, 77))
    d = ImageDraw.Draw(head)
    for i, t in enumerate(["before (MuPDF render)", "after (MuPDF render)", "after (pdfium render, independent)"]):
        d.text((10 + i * (W + 10), 6), t, fill=(0, 0, 0), font=FONT)
    out = Image.new("RGB", (W * 3 + 40, head.height + sum(r.height + 4 for r in rows)), (235, 235, 235))
    out.paste(head, (0, 0))
    y = head.height
    for r in rows:
        out.paste(r, (0, y))
        y += r.height + 4
    out.save(os.path.join(ROOT, "docs", name), optimize=True)
    print(f"wrote docs/{name}", out.size)


for name, ids in SHEETS.items():
    sheet(ids, name)
