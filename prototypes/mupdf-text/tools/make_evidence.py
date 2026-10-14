"""Builds docs/evidence.png from the crops written by run-node.mjs and
verify_pdfium.py: before (MuPDF), after (MuPDF), after (pdfium) per case."""
import os

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "out")
IDS = ["chrome-specials", "chrome-missing-glyphs", "word-calibri", "word-cambria", "rl-helvetica-std14",
       "rl-arial-custom-enc", "fullfont-identity-path", "xobject-cm-link", "tz-tc-spacing", "chrome-whole-line",
       "rl-rotate90-upright", "chrome-rotate90-crop", "enc-user-aes128"]
W = 520

try:
    FONT = ImageFont.truetype(os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts", "segoeui.ttf"), 15)
except OSError:
    FONT = ImageFont.load_default()


def fit(im, w=W, maxh=260):
    s = min(w / im.width, maxh / im.height)
    return im.resize((max(1, int(im.width * s)), max(1, int(im.height * s))), Image.LANCZOS)


rows = []
for cid in IDS:
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
sheet = Image.new("RGB", (W * 3 + 40, head.height + sum(r.height + 4 for r in rows)), (235, 235, 235))
sheet.paste(head, (0, 0))
y = head.height
for r in rows:
    sheet.paste(r, (0, y))
    y += r.height + 4
sheet.save(os.path.join(ROOT, "docs", "evidence.png"), optimize=True)
print("wrote docs/evidence.png", sheet.size)
