"""Builds two simple-font fixtures by hand, both with real embedded programs:

type1-pdftex.pdf   Type1 font program in /FontFile (Length1/2/3), subset with a
                   tag, a Cork-like (LaTeX T1) /Differences encoding that names
                   every code (also glyphs the subset dropped), /Widths for the
                   whole range, /CharSet, Flags 4 and no /ToUnicode: what
                   pdfTeX writes for a LaTeX document without glyphtounicode.
                   The text uses the fi ligature like TeX does.
type1c-simple.pdf  Bare CFF in /FontFile3 /Subtype /Type1C (simple font, not
                   CID), subset, /WinAnsiEncoding, /Widths 0 for codes the
                   subset lacks, no /ToUnicode: what Distiller/Ghostscript write.

The glyphs are drawn from Noto Serif SC / Noto Sans SC (SIL OFL 1.1), Latin
part only; TrueType quadratics become exact cubics.
"""
import os
import zlib

from fontTools import agl
from fontTools.fontBuilder import FontBuilder
from fontTools.misc import eexec, psCharStrings
from fontTools.pens.basePen import BasePen
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.t2CharStringPen import T2CharStringPen
from fontTools.t1Lib import std_subrs
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.dirname(HERE)
FONTS = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts")


def load(name):
    font = instancer.instantiateVariableFont(TTFont(os.path.join(FONTS, name)), {"wght": 400})
    return font, font.getGlyphSet(), font.getBestCmap()


def glyph_name(u):
    return {0xFB01: "fi", 0xFB02: "fl", 0x20: "space"}.get(u) or agl.UV2AGL.get(u) or f"uni{u:04X}"


class T1Pen(BasePen):
    """Type 1 charstring program; BasePen turns quadratics into exact cubics."""

    def __init__(self, gs):
        super().__init__(gs)
        self.prog, self.cur = [], (0, 0)

    def _rel(self, p):
        x, y = round(p[0]), round(p[1])
        d = [x - self.cur[0], y - self.cur[1]]
        self.cur = (x, y)
        return d

    def _moveTo(self, p):
        self.prog += self._rel(p) + ["rmoveto"]

    def _lineTo(self, p):
        self.prog += self._rel(p) + ["rlineto"]

    def _curveToOne(self, a, b, c):
        self.prog += self._rel(a) + self._rel(b) + self._rel(c) + ["rrcurveto"]

    def _closePath(self):
        self.prog.append("closepath")


def bbox_of(gs, names):
    bp = BoundsPen(gs)
    for n in names:
        gs[n].draw(bp)
    return [round(v) for v in bp.bounds]


def type1_program(font_name, family, glyphs, encoding, bbox):
    """glyphs: {name: (advance, program)}; encoding: {code: name}."""
    enc = "".join(f"dup {c} /{n} put\n" for c, n in sorted(encoding.items()) if n in glyphs)
    clear = (f"%!PS-AdobeFont-1.0: {font_name} 001.000\n"
             f"11 dict begin\n"
             f"/FontInfo 6 dict dup begin\n/version (001.000) readonly def\n"
             f"/Notice (Outlines from Noto, SIL Open Font License 1.1) readonly def\n"
             f"/FullName ({font_name}) readonly def\n/FamilyName ({family}) readonly def\n"
             f"/Weight (Regular) readonly def\n/ItalicAngle 0 def\nend readonly def\n"
             f"/FontName /{font_name} def\n"
             f"/Encoding 256 array\n0 1 255 {{1 index exch /.notdef put}} for\n{enc}readonly def\n"
             f"/PaintType 0 def\n/FontType 1 def\n/FontMatrix [0.001 0 0 0.001 0 0] readonly def\n"
             f"/FontBBox {{{' '.join(map(str, bbox))}}} readonly def\n"
             f"currentdict end\ncurrentfile eexec\n").encode("latin-1")

    def enc_cs(b):
        return eexec.encrypt(b"\0\0\0\0" + b, 4330)[0]

    priv = [b"dup /Private 9 dict dup begin",
            b"/RD{string currentfile exch readstring pop}executeonly def",
            b"/ND{noaccess def}executeonly def",
            b"/NP{noaccess put}executeonly def",
            b"/MinFeature{16 16}def", b"/password 5839 def",
            b"/BlueValues[-12 0 514 526 729 741]def", b"/StdHW[40]def", b"/StdVW[80]def",
            f"/Subrs {len(std_subrs)} array".encode()]
    for i, s in enumerate(std_subrs):
        e = enc_cs(s)
        priv.append(f"dup {i} {len(e)} RD ".encode() + e + b" NP")
    priv.append(b"ND")
    priv.append(f"2 index /CharStrings {len(glyphs)} dict dup begin".encode())
    for name, (adv, prog) in glyphs.items():
        cs = psCharStrings.T1CharString(program=[0, adv, "hsbw"] + prog + ["endchar"])
        cs.compile()
        e = enc_cs(cs.bytecode)
        priv.append(f"/{name} {len(e)} RD ".encode() + e + b" ND")
    priv += [b"end", b"end", b"readonly put", b"noaccess put",
             b"dup/FontName get exch definefont pop", b"mark currentfile closefile\n"]
    binary = eexec.encrypt(b"\x1f\x2e\x3d\x4c" + b"\n".join(priv), 55665)[0]
    return clear, binary


def pdf_string(s):
    return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def write_pdf(path, objs):
    pdf = bytearray(b"%PDF-1.5\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for i, body in enumerate(objs, 1):
        offsets.append(len(pdf))
        pdf += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(pdf)
    pdf += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    pdf += "".join(f"{o:010d} 00000 n \n" for o in offsets).encode()
    pdf += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    with open(path, "wb") as f:
        f.write(pdf)
    print(f"wrote {os.path.basename(path):24s} {len(pdf):>8d} bytes")


def stream(data, extra=b""):
    z = zlib.compress(data)
    return b"<< /Length %d /Filter /FlateDecode " % len(z) + extra + b" >>\nstream\n" + z + b"\nendstream"


# LaTeX T1 (Cork) encoding: Latin-1 letters at their Latin-1 codes, TeX quotes
# and dashes in the low range, ligatures at 0x1B-0x1F. pdfTeX writes every
# code of the .enc file into /Differences, used or not.
CORK = {0x10: "quotedblleft", 0x11: "quotedblright", 0x15: "endash", 0x16: "emdash",
        0x1B: "ff", 0x1C: "fi", 0x1D: "fl", 0x20: "space", 0x27: "quoteright", 0x60: "quoteleft"}
for c in range(0x21, 0x7F):
    CORK.setdefault(c, glyph_name(c))
for c in range(0xC0, 0x100):
    CORK[c] = glyph_name(c)
CORK.update({0xD7: "OE", 0xDF: "SS", 0xF7: "oe", 0xFF: "germandbls"})
UNI_OF = {n: u for u, n in agl.UV2AGL.items()} | {"fi": 0xFB01, "fl": 0xFB02, "ff": 0xFB00, "space": 0x20, "SS": 0}


def pdftex():
    font, gs, cmap = load("NotoSerifSC-VF.ttf")
    lines = [(72, 760, 12, "Relazione tecnica: il prezzo \u00e8 di 12 euro \u2013 \u201cok\u201d per l\u2019anno."),
             (72, 742, 12, "Seconda riga: verifica della citt\u00e0, perch\u00e9 cos\u00ec \u00e8 meglio."),
             (72, 712, 10, "Nota a pi\u00e8 di pagina con un ufficio e un fiore.")]
    code_of = {UNI_OF.get(n, 0): c for c, n in CORK.items()}

    def encode(text):  # TeX: fi/ffi ligatures, then Cork codes
        out, i = [], 0
        while i < len(text):
            if text.startswith("fi", i):
                out.append(0x1C)
                i += 2
                continue
            out.append(code_of[ord(text[i])])
            i += 1
        return bytes(out)

    used = sorted({c for *_, t in lines for c in encode(t)})
    names = [CORK[c] for c in used]
    glyphs = {".notdef": (500, [])}
    upm = font["head"].unitsPerEm
    for n in names:
        u = UNI_OF[n]
        g = cmap[u]
        pen = T1Pen(gs)
        gs[g].draw(pen)
        glyphs[n] = (round(font["hmtx"][g][0] * 1000 / upm), pen.prog)
    bbox = bbox_of(gs, [cmap[UNI_OF[n]] for n in names if n != "space"])
    tag = "QKXVZB+NotoSerifT1-Regular"
    clear, binary = type1_program(tag, "Noto Serif T1", glyphs, {c: CORK[c] for c in used}, bbox)
    first, last = 0x10, 0xFF
    widths = []
    for c in range(first, last + 1):  # TFM widths for every code, also unused ones
        u = UNI_OF.get(CORK.get(c, ""), 0)
        widths.append(round(font["hmtx"][cmap[u]][0] * 1000 / upm) if u in cmap else 0)
    diffs, prev = [], None
    for c in sorted(CORK):
        if CORK[c] not in UNI_OF or UNI_OF[CORK[c]] not in cmap:
            continue
        if prev != c - 1:
            diffs.append(str(c))
        diffs.append("/" + CORK[c])
        prev = c
    content = b"".join(b"BT /F1 %d Tf %d %d Td <%s> Tj ET\n" % (size, x, y, encode(t).hex().encode())
                       for x, y, size, t in lines)
    charset = "".join("/" + n for n in names)
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> /ProcSet [/PDF /Text] >> /Contents 4 0 R >>",
        stream(content),
        (f"<< /Type /Font /Subtype /Type1 /BaseFont /{tag} /FirstChar {first} /LastChar {last} "
         f"/Widths [{' '.join(map(str, widths))}] /Encoding 7 0 R /FontDescriptor 6 0 R >>").encode(),
        (f"<< /Type /FontDescriptor /Ascent 880 /CapHeight 729 /Descent -230 /Flags 4 "
         f"/FontBBox [{' '.join(map(str, bbox))}] /FontName /{tag} /ItalicAngle 0 /StemV 80 /XHeight 514 "
         f"/CharSet ({charset}) /FontFile 8 0 R >>").encode(),
        f"<< /Type /Encoding /Differences [{' '.join(diffs)}] >>".encode(),
        stream(clear + binary, b"/Length1 %d /Length2 %d /Length3 0" % (len(clear), len(binary))),
    ]
    write_pdf(os.path.join(OUT, "type1-pdftex.pdf"), objs)


WINANSI_EXTRA = {0x80: 0x20AC, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201C, 0x94: 0x201D, 0x96: 0x2013, 0x97: 0x2014}


def winansi(ch):
    u = ord(ch)
    for c, v in WINANSI_EXTRA.items():
        if v == u:
            return c
    assert u < 256 and not 0x80 <= u < 0xA0, ch
    return u


def type1c():
    font, gs, cmap = load("NotoSansSC-VF.ttf")
    lines = [(72, 760, 13, "Fattura 7: il totale \u00e8 99 \u20ac \u2013 \u201csaldo\u201d dell\u2019anno."),
             (72, 740, 13, "Scadenza: luned\u00ec, citt\u00e0 di Forl\u00ec.")]
    used = sorted({winansi(ch) for *_, t in lines for ch in t})
    uni = {c: WINANSI_EXTRA.get(c, c) for c in used}
    order = [".notdef"] + [glyph_name(uni[c]) for c in used]
    upm = font["head"].unitsPerEm
    charstrings, metrics = {}, {}
    pen = T2CharStringPen(500, gs)
    charstrings[".notdef"] = pen.getCharString()
    metrics[".notdef"] = (500, 0)
    for c in used:
        g = cmap[uni[c]]
        adv = round(font["hmtx"][g][0] * 1000 / upm)
        pen = T2CharStringPen(adv, gs)
        gs[g].draw(pen)
        charstrings[glyph_name(uni[c])] = pen.getCharString()
        metrics[glyph_name(uni[c])] = (adv, 0)
    tag = "EFGHIJ+NotoSansT1C-Regular"
    fb = FontBuilder(1000, isTTF=False)
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap({uni[c]: glyph_name(uni[c]) for c in used})
    fb.setupCFF(tag, {"FullName": "Noto Sans T1C"}, charstrings, {})
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=880, descent=-230)
    fb.setupNameTable({"familyName": "Noto Sans T1C", "styleName": "Regular"})
    fb.setupOS2()
    fb.setupPost()
    cff = fb.font["CFF "].compile(fb.font)
    bbox = bbox_of(gs, [cmap[uni[c]] for c in used if c != 32])
    first, last = 32, 255
    widths = [metrics[glyph_name(uni[c])][0] if c in uni else 0 for c in range(first, last + 1)]
    content = b"0.1 0.2 0.5 rg\n" + b"".join(
        b"BT /T1 %d Tf %d %d Td <%s> Tj ET\n" % (size, x, y, bytes(winansi(ch) for ch in t).hex().encode())
        for x, y, size, t in lines)
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /T1 5 0 R >> >> /Contents 4 0 R >>",
        stream(content),
        (f"<< /Type /Font /Subtype /Type1 /BaseFont /{tag} /FirstChar {first} /LastChar {last} "
         f"/Widths [{' '.join(map(str, widths))}] /Encoding /WinAnsiEncoding /FontDescriptor 6 0 R >>").encode(),
        (f"<< /Type /FontDescriptor /Ascent 880 /CapHeight 733 /Descent -230 /Flags 32 "
         f"/FontBBox [{' '.join(map(str, bbox))}] /FontName /{tag} /ItalicAngle 0 /StemV 88 /XHeight 543 "
         f"/FontFile3 7 0 R >>").encode(),
        stream(cff, b"/Subtype /Type1C"),
    ]
    write_pdf(os.path.join(OUT, "type1c-simple.pdf"), objs)


if __name__ == "__main__":
    pdftex()
    type1c()
