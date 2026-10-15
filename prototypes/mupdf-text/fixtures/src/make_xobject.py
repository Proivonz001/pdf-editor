"""Builds fixtures/xobject-tz-link.pdf by hand: text inside a Form XObject drawn
under a scaling CTM, a line with horizontal scaling (Tz) and character spacing
(Tc), and a link annotation over the word that gets edited."""
import os
import zlib

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "xobject-tz-link.pdf")


def stream(data, extra=""):
    z = zlib.compress(data)
    return f"<< /Length {len(z)} /Filter /FlateDecode {extra}>>\nstream\n".encode() + z + b"\nendstream"


form = b"BT /F1 12 Tf 72 700 Td (Dentro XObject: il totale \xe8 10 \x80, grazie.) Tj ET\n"
page = (b"q 1.2 0 0 1.2 -20 -150 cm /X1 Do Q\n"
        b"BT /F1 11 Tf 105 Tz 1.5 Tc 72 560 Td (Spaziatura: testo largo qui.) Tj ET\n")
# "totale" sits at x ~ 72+..., y ~ 700 in form space -> page space via the cm.
objs = [
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /X1 5 0 R >> /Font << /F1 6 0 R >> >> /Contents 4 0 R /Annots [7 0 R] >>",
    stream(page),
    stream(form, "/Type /XObject /Subtype /Form /BBox [0 0 595 842] /Resources << /Font << /F1 6 0 R >> >> "),
    b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    b"<< /Type /Annot /Subtype /Link /Rect [175 680 225 700] /Border [0 0 0] /A << /S /URI /URI (https://example.com/totale) >> >>",
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
print("wrote", OUT, len(pdf), "bytes")
