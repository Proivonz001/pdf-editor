"""Builds the fixture PDFs used by the MuPDF prototype.

Run from anywhere:  python prototypes/mupdf-text/fixtures/src/make_fixtures.py
Needs: reportlab, pypdf (+ cryptography for AES), Chrome, optionally Word.
chrome-subset.pdf and word-winansi.pdf are produced by Chrome / Word
(see README); this script post-processes them and builds the rest.
"""
import os
import sys

from pypdf import PdfReader, PdfWriter
from pypdf.generic import RectangleObject
from reportlab.lib.colors import HexColor
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.dirname(HERE)
FONTS = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts")


def out(name):
    return os.path.join(OUT, name)


def add_outline_to_chrome():
    """Chrome's headless print drops the outline; add one so saves can be checked."""
    src = out("chrome-subset.pdf")
    r = PdfReader(src)
    if r.outline:
        return
    w = PdfWriter(clone_from=r)
    top = w.add_outline_item("Preventivo n. 2026/118", 0)
    w.add_outline_item("Condizioni", 0, parent=top)
    w.add_outline_item("Note", 0, parent=top)
    with open(src, "wb") as f:
        w.write(f)


def reportlab_form():
    """Standard-14 Helvetica (not embedded) + reportlab TrueType subset with a
    custom (non-standard) encoding + AcroForm fields + outline."""
    pdfmetrics.registerFont(TTFont("ArialRL", os.path.join(FONTS, "arial.ttf")))
    c = canvas.Canvas(out("reportlab-form.pdf"), pagesize=(595, 842))
    c.setTitle("Fattura di prova")
    c.bookmarkPage("p1")
    c.addOutlineEntry("Fattura", "p1", level=0)
    c.setFont("Helvetica-Bold", 16)
    c.drawString(60, 770, "Fattura n. 42")
    c.setFont("Helvetica", 12)
    c.drawString(60, 740, "Totale 1.234,56 € – “saldo” dell’anno, già pagato.")
    c.setFont("ArialRL", 12)
    c.drawString(60, 710, "Cliente: Società Rossi – via dell’Università, Forlì")
    c.setFillColor(HexColor("#1f7a3a"))
    c.drawString(60, 690, "Scadenza: venerdì 30 ottobre")
    c.setFillColor(HexColor("#000000"))
    c.setFont("Helvetica", 10)
    c.drawString(60, 640, "Nome:")
    c.acroForm.textfield(name="nome", tooltip="Nome", x=110, y=630, width=200, height=20,
                         value="Mario", forceBorder=True)
    c.drawString(60, 600, "Pagato:")
    c.acroForm.checkbox(name="pagato", x=110, y=595, size=14, checked=True)
    c.showPage()

    # Page 2: /Rotate 90 with an offset CropBox; content is drawn rotated so
    # that it reads upright on screen (the usual "landscape" scan/export).
    c.bookmarkPage("p2")
    c.addOutlineEntry("Allegato ruotato", "p2", level=0)
    c.setPageRotation(90)
    c.setCropBox((40, 30, 560, 800))
    c.saveState()
    c.translate(595, 0)
    c.rotate(90)
    c.setFont("Helvetica", 14)
    c.drawString(80, 500, "Pagina ruotata: il prezzo è 12 € – “ok” l’ultimo.")
    c.setFont("ArialRL", 14)
    c.drawString(80, 470, "Riga Arial: università, perché, più.")
    c.restoreState()
    c.showPage()
    c.save()


def rotated_chrome():
    """chrome-subset page 1 with /Rotate 90 and an offset CropBox (text then
    reads vertically on screen)."""
    r = PdfReader(out("chrome-subset.pdf"))
    w = PdfWriter(clone_from=r)
    p = w.pages[0]
    p.rotate(90)
    mb = p.mediabox
    p.cropbox = RectangleObject([float(mb.left) + 30, float(mb.bottom) + 45,
                                 float(mb.right) - 20, float(mb.top) - 25])
    with open(out("chrome-rotate90-crop.pdf"), "wb") as f:
        w.write(f)


def encrypted():
    r = PdfReader(out("chrome-subset.pdf"))
    # Owner password only: opens without a password, permissions restricted.
    w = PdfWriter(clone_from=r)
    w.encrypt(user_password="", owner_password="owner-only", algorithm="AES-256",
              permissions_flag=0b0100)  # print only
    with open(out("enc-owner-aes256.pdf"), "wb") as f:
        w.write(f)
    # User password required to open.
    w = PdfWriter(clone_from=r)
    w.encrypt(user_password="utente", owner_password="proprietario", algorithm="RC4-128")
    with open(out("enc-user-rc4.pdf"), "wb") as f:
        w.write(f)
    w = PdfWriter(clone_from=r)
    w.encrypt(user_password="utente", owner_password="proprietario", algorithm="AES-128")
    with open(out("enc-user-aes128.pdf"), "wb") as f:
        w.write(f)


if __name__ == "__main__":
    if not os.path.exists(out("chrome-subset.pdf")):
        sys.exit("chrome-subset.pdf missing: print src/sample.html with Chrome first (see README)")
    add_outline_to_chrome()
    reportlab_form()
    rotated_chrome()
    encrypted()
    for n in sorted(os.listdir(OUT)):
        if n.endswith(".pdf"):
            print(f"{n:28s} {os.path.getsize(out(n)):>8d} bytes")
