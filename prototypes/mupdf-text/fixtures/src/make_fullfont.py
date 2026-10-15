"""Builds fixtures/fullfont-partial-tounicode.pdf: a Type0/Identity-H font whose
program is embedded in full (Latin-1 + punctuation), but whose /ToUnicode and
/W only list the glyphs the page uses. Some producers write fonts like this;
editing then needs glyphs the document never used, which exercises the
"font cmap" path, the /W patch and the ToUnicode extension.

Font: Noto Sans SC (SIL OFL 1.1), instanced at wght=400 and cut down to Latin.
"""
import io
import os
import zlib

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "fullfont-partial-tounicode.pdf")
SRC = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts", "NotoSansSC-VF.ttf")

font = instancer.instantiateVariableFont(TTFont(SRC), {"wght": 400})
opts = subset.Options()
opts.layout_features = []
opts.name_IDs = ["*"]
opts.notdef_outline = True
sub = subset.Subsetter(opts)
chars = list(range(0x20, 0x7F)) + list(range(0xA0, 0x100)) + [0x20AC, 0x2019, 0x201C, 0x201D, 0x2013, 0x2014]
sub.populate(unicodes=chars)
sub.subset(font)
buf = io.BytesIO()
font.save(buf)
ttf = buf.getvalue()
font = TTFont(io.BytesIO(ttf))
cmap = font.getBestCmap()
order = font.getGlyphOrder()
gid_of = {u: order.index(name) for u, name in cmap.items()}
upm = font["head"].unitsPerEm
adv = {u: round(font["hmtx"][cmap[u]][0] * 1000 / upm) for u in cmap}

LINES = [(72, 760, 16, "Prezzo base: 10 €"), (72, 730, 12, "Voce di prova senza altri caratteri.")]
used = sorted({ch for _, _, _, t in LINES for ch in t})


def hexstr(text):
    return "".join("%04x" % gid_of[ord(c)] for c in text)


content = "".join(f"BT /F1 {s} Tf {x} {y} Td <{hexstr(t)}> Tj ET\n" for x, y, s, t in LINES).encode()
w = " ".join(f"{gid_of[ord(c)]} [{adv[ord(c)]}]" for c in used)
tounicode = ("/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n"
             "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n"
             "/CMapName /Adobe-Identity-UCS def /CMapType 2 def\n"
             "1 begincodespacerange <0000> <FFFF> endcodespacerange\n"
             f"{len(used)} beginbfchar\n"
             + "".join("<%04x> <%04x>\n" % (gid_of[ord(c)], ord(c)) for c in used)
             + "endbfchar\nendcmap CMapName currentdict /CMap defineresource pop end end\n").encode()


def stream(data, extra=""):
    z = zlib.compress(data)
    return f"<< /Length {len(z)} /Filter /FlateDecode {extra}>>\nstream\n".encode() + z + b"\nendstream"


objs = [
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    stream(content),
    b"<< /Type /Font /Subtype /Type0 /BaseFont /NotoSansSC-Regular /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 8 0 R >>",
    (f"<< /Type /Font /Subtype /CIDFontType2 /BaseFont /NotoSansSC-Regular /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> "
     f"/FontDescriptor 7 0 R /CIDToGIDMap /Identity /DW 1000 /W [{w}] >>").encode(),
    b"<< /Type /FontDescriptor /FontName /NotoSansSC-Regular /Flags 32 /FontBBox [-200 -300 1200 1000] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 /FontFile2 9 0 R >>",
    stream(tounicode),
    stream(ttf, f"/Length1 {len(ttf)} "),
]
pdf = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
offsets = []
for i, body in enumerate(objs, 1):
    offsets.append(len(pdf))
    pdf += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
xref = len(pdf)
pdf += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
pdf += "".join(f"{o:010d} 00000 n \n" for o in offsets).encode()
pdf += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
with open(OUT, "wb") as f:
    f.write(pdf)
print("wrote", OUT, len(pdf), "bytes; font", len(ttf), "bytes,", len(cmap), "chars,", len(used), "in ToUnicode")
