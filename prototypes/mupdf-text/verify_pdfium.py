"""Independent check of the MuPDF outputs with a different engine.

pdfium (Chrome's PDF engine, via pypdfium2) re-extracts the text and renders
before/after; pypdf checks encryption, outline and AcroForm. Run after
run-node.mjs:  python -I prototypes/mupdf-text/verify_pdfium.py [--subset=fallback|all|none]
"""
import json
import os
import sys

import pypdf
import pypdfium2 as pdfium

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
MODE = next((a.split("=")[1] for a in sys.argv if a.startswith("--subset=")), "fallback")
SUFFIX = "" if MODE == "fallback" else "-subset-" + MODE
SCALE = 2


def outline_count(items):
    return sum(outline_count(i) if isinstance(i, list) else 1 for i in items)


def render(doc, index):
    page = doc[index]
    return page.render(scale=SCALE).to_pil().convert("RGB")


def changed_outside(a, b, areas):
    pa, pb = a.load(), b.load()
    n = 0
    for y in range(min(a.height, b.height)):
        py = y / SCALE
        for x in range(min(a.width, b.width)):
            px = x / SCALE
            if any(r[0] <= px <= r[2] and r[1] <= py <= r[3] for r in areas):
                continue
            ca, cb = pa[x, y], pb[x, y]
            if max(abs(ca[0] - cb[0]), abs(ca[1] - cb[1]), abs(ca[2] - cb[2])) > 40:
                n += 1
    return n


def line_rest_shift(before, after, page_index, edit):
    """Largest movement (pt) of the up to 20 non-space chars that follow the
    edited word on its line, by pdfium's own char boxes."""
    tb, ta = before[page_index].get_textpage(), after[page_index].get_textpage()
    sb, sa = tb.get_text_range(), ta.get_text_range()
    i = sb.find(edit["find"])
    if i < 0:
        return 0
    i += len(edit["find"])
    chunk = sb[i:i + 20]
    rest = chunk.splitlines()[0] if chunk.strip() else ""
    # Anchor on the text just before the edited word: after the redaction the
    # rest of the line follows it directly (the new text is drawn separately).
    k0 = i - len(edit["find"])
    anchor = sb[max(0, k0 - 12):k0].splitlines()[-1] if sb[max(0, k0 - 12):k0].strip() else ""
    a = sa.find(anchor) if anchor else 0
    j = sa.find(rest.strip(), a + len(anchor)) if rest.strip() and a >= 0 else -1
    if j < 0:
        return 0
    i += len(rest) - len(rest.lstrip())
    shift = 0
    for k, ch in enumerate(rest.strip()):
        if ch.isspace():
            continue
        bb, ba = tb.get_charbox(i + k), ta.get_charbox(j + k)
        shift = max(shift, abs(bb[0] - ba[0]), abs(bb[1] - ba[1]))
    return shift


def main():
    report = json.load(open(os.path.join(OUT, f"results-node{SUFFIX}.json"), encoding="utf-8"))
    rows = []
    for r in report["results"]:
        if not r.get("edits"):
            continue
        src = os.path.join(HERE, "fixtures", r["file"])
        dst = os.path.join(OUT, f"{r['id']}{SUFFIX}.pdf")
        password = None
        if r["id"].startswith("enc-user"):
            password = "utente"
        row = {"id": r["id"]}
        before = pdfium.PdfDocument(src, password=password)
        after = pdfium.PdfDocument(dst)  # must open without a password
        page_index = r["page"] - 1
        tb = before[page_index].get_textpage().get_text_range()
        ta = after[page_index].get_textpage().get_text_range()
        norm = lambda s: " ".join(s.split())
        row["textOk"] = all(
            norm(ta).count(e["find"]) == norm(tb).count(e["find"]) - 1 and norm(e["replacement"]) in norm(ta)
            for e in r["edits"])
        areas = []
        for e, v in zip(r["edits"], r["verify"]["edits"]):
            b = e["original"]["bbox"]
            nb = v.get("newBBox", b)
            areas.append([min(b[0], nb[0]) - 2, min(b[1], nb[1]) - 2, max(b[2], nb[2]) + 2, max(b[3], nb[3]) + 2])
        ib, ia = render(before, page_index), render(after, page_index)
        row["pdfiumPixelsChangedOutside"] = changed_outside(ib, ia, areas)
        # Redaction rewrites the rest of the line with TJ offsets; measure how far
        # pdfium moves that untouched text (MuPDF itself reads back 0.000).
        row["maxShiftOfLineRestPt"] = round(max([line_rest_shift(before, after, page_index, e) for e in r["edits"]] or [0]), 4)
        for i, a in enumerate(areas):
            box = [int((a[0] - 38) * SCALE), int((a[1] - 12) * SCALE), int((a[2] + 38) * SCALE), int((a[3] + 12) * SCALE)]
            ia.crop(box).save(os.path.join(OUT, f"{r['id']}-{i + 1}-after-pdfium{SUFFIX}.png"))
        rb, ra = pypdf.PdfReader(src), pypdf.PdfReader(dst)
        if rb.is_encrypted:
            rb.decrypt(password or "")
        row["encryptedAfter"] = ra.is_encrypted
        row["outline"] = f"{outline_count(rb.outline)}->{outline_count(ra.outline)}"
        fb, fa = rb.get_fields() or {}, ra.get_fields() or {}
        row["acroForm"] = f"{len(fb)}->{len(fa)}"
        row["fieldValuesKept"] = all(fa.get(k, {}).get("/V") == v.get("/V") for k, v in fb.items())
        # Pixels may differ only by anti-aliasing of a sub-0.1 pt shift.
        row["ok"] = (row["textOk"] and (row["pdfiumPixelsChangedOutside"] == 0 or row["maxShiftOfLineRestPt"] < 0.1)
                     and not row["encryptedAfter"]
                     and row["outline"].split("->")[0] == row["outline"].split("->")[1]
                     and row["acroForm"].split("->")[0] == row["acroForm"].split("->")[1] and row["fieldValuesKept"])
        rows.append(row)
        print(("PASS " if row["ok"] else "FAIL ") + json.dumps(row, ensure_ascii=False))
    json.dump({"engine": f"pdfium via pypdfium2 {pdfium.version.PYPDFIUM_INFO}, pypdf {pypdf.__version__}", "rows": rows},
              open(os.path.join(OUT, f"results-pdfium{SUFFIX}.json"), "w", encoding="utf-8"), indent=1, ensure_ascii=False)
    print(f"\n{sum(r['ok'] for r in rows)}/{len(rows)} outputs pass the pdfium/pypdf cross-check")


if __name__ == "__main__":
    main()
