"""Builds fixtures/type3-matplotlib.pdf: a chart saved by matplotlib with its
default pdf.fonttype 3, so every label is drawn with Type3 fonts (DejaVu Sans
glyph procedures, /Differences encoding, FontMatrix in 1/2048 em). Characters
outside the font's first 256 codes (here the euro sign and curly quotes) are
written by matplotlib as Form XObjects, i.e. paths, not text.

Font: DejaVu Sans (Bitstream Vera license), bundled with matplotlib.
"""
import os

import matplotlib

matplotlib.use("pdf")
import matplotlib.pyplot as plt  # noqa: E402

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "type3-matplotlib.pdf")

plt.rcParams.update({"pdf.fonttype": 3, "font.family": "DejaVu Sans", "font.size": 11})
fig = plt.figure(figsize=(8.27, 11.69))  # A4
fig.text(0.1, 0.94, "Vendite per città – anno 2026", fontsize=18, weight="bold")
fig.text(0.1, 0.91, "Il prezzo medio è salito del 12% rispetto all'anno scorso.")
fig.text(0.1, 0.89, "Totale: 1.250 € – “ok” per l’anno.", color="#1f7a3a")
ax = fig.add_axes([0.12, 0.5, 0.8, 0.35])
ax.bar(["Milano", "Forlì", "Torino", "Napoli"], [42, 17, 28, 35], color="#4878a8")
ax.set_ylabel("Fatturato (migliaia di euro)")
ax.set_title("Fatturato per sede")
fig.savefig(OUT, metadata={"CreationDate": None, "Producer": "Matplotlib pdf backend"})
print("wrote", OUT, os.path.getsize(OUT), "bytes")
