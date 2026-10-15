"""Builds fixtures/large-220p.pdf: a 220-page A4 report printed by Chrome
headless (tagged, Type0 subsets shared by every page), for the memory and
timing benchmark. Every page has a heading, four paragraphs with the words
the benchmark edits ("prezzo", "consegna", "Capitolo") and a small table.

    python -I prototypes/mupdf-text/fixtures/src/make_large.py [path-to-chrome]
"""
import os
import pathlib
import random
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.dirname(HERE)
PAGES = 220
CHROME = sys.argv[1] if len(sys.argv) > 1 else r"C:\Program Files\Google\Chrome\Application\chrome.exe"

WORDS = ("fornitura servizio cliente contratto offerta ordine fattura magazzino sede ufficio "
         "progetto collaudo verifica manutenzione garanzia documento allegato richiesta "
         "pagamento scadenza importo rata saldo acconto sconto listino trasporto imballo").split()
CITIES = ["Milano", "Forlì", "Torino", "Napoli", "Bologna", "Genova", "Bari", "Trento"]


def paragraph(rng, n, k):
    words = [rng.choice(WORDS) for _ in range(28)]
    city = rng.choice(CITIES)
    return (f"Paragrafo {k} della pagina {n}: il prezzo concordato per la {words[0]} di {city} è di "
            f"{rng.randint(100, 9999)},{rng.randint(10, 99)} € – la consegna avverrà entro venerdì, "
            f"perché l’{words[1]} è già approvata. " + " ".join(words[2:]) + ".")


def build_html(path):
    rng = random.Random(2026)
    parts = ["<!doctype html><html lang=it><meta charset=utf-8><style>",
             "@page{size:A4;margin:22mm 20mm}body{font:11pt Calibri,sans-serif;color:#111}",
             "h2{font:bold 16pt Georgia,serif;margin:0 0 10pt}p{margin:0 0 8pt;line-height:1.35}",
             "table{border-collapse:collapse;margin-top:6pt}td,th{border:.5pt solid #777;padding:2pt 6pt;font-size:10pt}",
             "section{break-after:page}</style><body>"]
    for n in range(1, PAGES + 1):
        rows = "".join(f"<tr><td>{rng.choice(WORDS)}</td><td>{rng.randint(1, 40)}</td>"
                       f"<td>{rng.randint(5, 900)},00 €</td></tr>" for _ in range(4))
        parts.append(f"<section><h2>Capitolo {n} — {rng.choice(WORDS).capitalize()}</h2>"
                     + "".join(f"<p>{paragraph(rng, n, k)}</p>" for k in range(1, 5))
                     + f"<table><tr><th>Voce</th><th>Quantità</th><th>Prezzo</th></tr>{rows}</table></section>")
    parts.append("</body></html>")
    with open(path, "w", encoding="utf-8") as f:
        f.write("".join(parts))


if __name__ == "__main__":
    html = os.path.join(HERE, "large.html")
    pdf = os.path.join(OUT, "large-220p.pdf")
    build_html(html)
    with tempfile.TemporaryDirectory() as profile:  # a running Chrome must not own the profile
        subprocess.run([CHROME, "--headless=new", "--no-pdf-header-footer", f"--user-data-dir={profile}",
                        f"--print-to-pdf={pdf}", pathlib.Path(html).as_uri()], check=True, timeout=180,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    os.remove(html)
    print("wrote", pdf, os.path.getsize(pdf), "bytes")
