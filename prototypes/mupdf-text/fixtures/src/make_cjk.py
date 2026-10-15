"""Builds the CJK fixtures.

cjk-reportlab.pdf    reportlab with its non-embedded Adobe CJK fonts:
                     STSong-Light with /UniGB-UCS2-H (a line) and /UniGB-UCS2-V
                     (two vertical columns), and HeiseiMin-W3 with /90ms-RKSJ-H
                     (Shift-JIS codes, written raw since reportlab's drawString
                     cannot encode them). Viewers substitute the fonts.
cjk-identity-v.pdf   hand-built like InDesign/Illustrator write vertical text:
                     one embedded TrueType subset (CIDFontType2, CIDToGIDMap
                     Identity) behind two Type0 dicts, /Identity-V for a
                     vertical column and /Identity-H for a horizontal line,
                     both with /ToUnicode. Font: Noto Sans SC (SIL OFL 1.1).
"""
import io
import os
import zlib

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import CIDFont, UnicodeCIDFont
from reportlab.pdfgen import canvas

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.dirname(HERE)
FONTS = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts")

ZH = "价格是十二元，请于星期五付款。"  # "The price is twelve yuan, please pay on Friday."
ZH2 = "合同已签署，发票随后寄出。"  # "The contract is signed, the invoice follows."
JA = "価格は十二円です。金曜日に支払います。"
ZV1 = "本月账单已结清，谢谢合作。"  # "This month's bill is settled, thank you."
ZV2 = "请在周五前回复确认。"  # "Please confirm by Friday."
ZH3 = "联系人：王先生"  # "Contact: Mr Wang"


def reportlab_cjk():
    pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
    v = UnicodeCIDFont("STSong-Light", isVertical=True)  # same face, /UniGB-UCS2-V
    v.name = v.fontName = "STSong-Light-V"
    pdfmetrics.registerFont(v)
    pdfmetrics.registerFont(CIDFont("HeiseiMin-W3", "90ms-RKSJ-H"))
    c = canvas.Canvas(os.path.join(OUT, "cjk-reportlab.pdf"), pagesize=(595, 842))
    c.setFont("Helvetica-Bold", 14)
    c.drawString(72, 790, "CJK: UniGB-UCS2-H, UniGB-UCS2-V, 90ms-RKSJ-H")
    c.setFont("STSong-Light", 14)
    c.drawString(72, 760, ZH)
    c.drawString(72, 740, ZH2)
    c.setFont("STSong-Light-V", 16)
    c.drawString(480, 700, ZV1)
    c.drawString(450, 700, ZV2)
    c.setFont("HeiseiMin-W3-90ms-RKSJ-H", 14)
    name = c._doc.getInternalFontName("HeiseiMin-W3-90ms-RKSJ-H")
    c._code.append(f"BT {name} 14 Tf 1 0 0 1 72 712 Tm <{JA.encode('cp932').hex()}> Tj ET")
    c.save()


def cid_cmap(entries):
    body = "\n".join(f"<{cid:04x}> <{ord(ch):04x}>" for cid, ch in entries)
    return (f"/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n"
            f"/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n"
            f"/CMapName /Adobe-Identity-UCS def /CMapType 2 def\n"
            f"1 begincodespacerange <0000> <ffff> endcodespacerange\n"
            f"{len(entries)} beginbfchar\n{body}\nendbfchar\n"
            f"endcmap CMapName currentdict /CMap defineresource pop end end\n").encode()


def stream(data, extra=b""):
    z = zlib.compress(data)
    return b"<< /Length %d /Filter /FlateDecode " % len(z) + extra + b" >>\nstream\n" + z + b"\nendstream"


def identity_v():
    font = instancer.instantiateVariableFont(TTFont(os.path.join(FONTS, "NotoSansSC-VF.ttf")), {"wght": 400})
    text = ZH + ZH2 + "发票编号 2026" + ZH3
    opts = subset.Options()
    opts.layout_features = []
    opts.notdef_outline = True
    opts.retain_gids = False
    sub = subset.Subsetter(opts)
    sub.populate(unicodes={ord(ch) for ch in text})
    sub.subset(font)
    buf = io.BytesIO()
    font.save(buf)
    ttf = buf.getvalue()
    font = TTFont(io.BytesIO(ttf))
    cmap, order = font.getBestCmap(), font.getGlyphOrder()
    gid = {u: order.index(n) for u, n in cmap.items()}
    upm = font["head"].unitsPerEm
    adv = {u: round(font["hmtx"][n][0] * 1000 / upm) for u, n in cmap.items()}
    w = []
    for u in sorted(gid, key=gid.get):
        w += [gid[u], [adv[u]]]
    w_str = " ".join(f"{c} [{a[0]}]" if isinstance(a, list) else str(c) for c, a in zip(w[::2], w[1::2]))
    hexs = lambda s: "".join(f"{gid[ord(ch)]:04x}" for ch in s)
    content = (b"BT /FV 16 Tf 1 0 0 1 480 760 Tm <%s> Tj ET\n" % hexs(ZH).encode() +
               b"BT /FV 16 Tf 1 0 0 1 450 760 Tm <%s> Tj ET\n" % hexs(ZH2).encode() +
               b"BT /FH 14 Tf 1 0 0 1 72 780 Tm <%s> Tj ET\n" % hexs("发票编号 2026").encode() +
               b"BT /FH 14 Tf 1 0 0 1 72 760 Tm <%s> Tj ET\n" % hexs(ZH3).encode())
    tag = "AQBRCS+NotoSansSC-Regular"
    tounicode = cid_cmap(sorted((gid[u], chr(u)) for u in gid))
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /FV 5 0 R /FH 6 0 R >> >> /Contents 4 0 R >>",
        stream(content),
        f"<< /Type /Font /Subtype /Type0 /BaseFont /{tag} /Encoding /Identity-V /DescendantFonts [7 0 R] /ToUnicode 10 0 R >>".encode(),
        f"<< /Type /Font /Subtype /Type0 /BaseFont /{tag} /Encoding /Identity-H /DescendantFonts [7 0 R] /ToUnicode 10 0 R >>".encode(),
        (f"<< /Type /Font /Subtype /CIDFontType2 /BaseFont /{tag} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> "
         f"/FontDescriptor 8 0 R /CIDToGIDMap /Identity /DW 1000 /W [{w_str}] /DW2 [880 -1000] >>").encode(),
        (f"<< /Type /FontDescriptor /FontName /{tag} /Flags 4 /FontBBox [-1000 -300 2000 1100] /ItalicAngle 0 "
         f"/Ascent 880 /Descent -120 /CapHeight 733 /StemV 80 /FontFile2 9 0 R >>").encode(),
        stream(ttf, b"/Length1 %d" % len(ttf)),
        stream(tounicode),
    ]
    pdf = bytearray(b"%PDF-1.6\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for i, body in enumerate(objs, 1):
        offsets.append(len(pdf))
        pdf += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(pdf)
    pdf += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    pdf += "".join(f"{o:010d} 00000 n \n" for o in offsets).encode()
    pdf += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    with open(os.path.join(OUT, "cjk-identity-v.pdf"), "wb") as f:
        f.write(pdf)


if __name__ == "__main__":
    reportlab_cjk()
    identity_v()
    for n in ("cjk-reportlab.pdf", "cjk-identity-v.pdf"):
        print(f"wrote {n:24s} {os.path.getsize(os.path.join(OUT, n)):>8d} bytes")
