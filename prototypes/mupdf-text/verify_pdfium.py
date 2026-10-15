"""Independent check of the MuPDF outputs with a different engine.

pdfium (Chrome's PDF engine, via pypdfium2) re-extracts the text and renders
before/after; pypdf checks encryption, outline and AcroForm. For tagged PDFs
pdfium also rebuilds the tag-based reading order (structure tree walked in
/K order, each MCID replaced by the text pdfium finds under it). Run after
run-node.mjs:  python -I prototypes/mupdf-text/verify_pdfium.py [--subset=fallback|all|none]
"""
import ctypes
import json
import os
import sys

import pypdf
import pypdfium2 as pdfium
import pypdfium2.raw as raw

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
MODE = next((a.split("=")[1] for a in sys.argv if a.startswith("--subset=")), "fallback")
SUFFIX = "" if MODE == "fallback" else "-subset-" + MODE
SCALE = 2
sys.stdout.reconfigure(encoding="utf-8")


def wstr(fn, argpos, *args):
    """Calls a pdfium 'fill a UTF-16 buffer' function: size first, then data."""
    def call(buf, n):
        a = list(args)
        a.insert(argpos, ctypes.cast(buf, fn.argtypes[argpos]) if buf is not None else None)
        return fn(*a, n)
    n = call(None, 0)
    if n <= 2:
        return ""
    buf = ctypes.create_string_buffer(n + 2)
    call(buf, n)
    return buf.raw[:n].decode("utf-16-le", "replace").rstrip("\x00")


def tagged_order(pdf, index):
    """Text in structure-tree order for one page: [(struct path, mcid, text)],
    plus the text pdfium finds outside any MCID or /Artifact."""
    page = pdf[index]
    textpage = page.get_textpage()
    texts, untagged = {}, []

    def visit(obj):
        kind = raw.FPDFPageObj_GetType(obj)
        if kind == raw.FPDF_PAGEOBJ_FORM:
            for i in range(raw.FPDFFormObj_CountObjects(obj)):
                visit(raw.FPDFFormObj_GetObject(obj, i))
            return
        if kind != raw.FPDF_PAGEOBJ_TEXT:
            return
        mcid, artifact = -1, False
        for j in range(raw.FPDFPageObj_CountMarks(obj)):
            mark = raw.FPDFPageObj_GetMark(obj, j)
            v = ctypes.c_int()
            if raw.FPDFPageObjMark_GetParamIntValue(mark, b"MCID", ctypes.byref(v)):
                mcid = v.value
            artifact = artifact or _mark_name(mark) == "Artifact"
        s = wstr(raw.FPDFTextObj_GetText, 2, obj, textpage.raw)
        if mcid >= 0:
            texts[mcid] = texts.get(mcid, "") + s
        elif not artifact:
            untagged.append(s)

    for i in range(raw.FPDFPage_CountObjects(page.raw)):
        visit(raw.FPDFPage_GetObject(page.raw, i))
    tree = raw.FPDF_StructTree_GetForPage(page.raw)
    order = []

    def walk(el, path):
        path = path + [wstr(raw.FPDF_StructElement_GetType, 1, el)]
        for i in range(raw.FPDF_StructElement_CountChildren(el)):
            child = raw.FPDF_StructElement_GetChildAtIndex(el, i)
            if child:
                walk(child, path)
            else:
                mc = raw.FPDF_StructElement_GetChildMarkedContentID(el, i)
                if mc >= 0:
                    order.append(("/".join(path), mc, texts.get(mc, "")))

    for i in range(raw.FPDF_StructTree_CountChildren(tree)):
        walk(raw.FPDF_StructTree_GetChildAtIndex(tree, i), [])
    raw.FPDF_StructTree_Close(tree)
    return order, untagged


def _mark_name(mark):
    fn, n = raw.FPDFPageObjMark_GetName, ctypes.c_ulong()
    fn(mark, None, 0, ctypes.byref(n))
    if n.value <= 2:
        return ""
    buf = ctypes.create_string_buffer(n.value + 2)
    fn(mark, ctypes.cast(buf, fn.argtypes[1]), n.value, ctypes.byref(n))
    return buf.raw[:n.value].decode("utf-16-le", "replace").rstrip("\x00")


def is_cjk(s):
    return any(ord(ch) >= 0x2E80 for ch in s)


def norm_for(s, text):
    # pdfium puts breaks between vertical CJK characters: compare without spaces.
    return "".join(text.split()) if is_cjk(s) else " ".join(text.split())


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
        row["textOk"] = all(
            norm_for(e["find"], ta).count(e["find"]) == norm_for(e["find"], tb).count(e["find"]) - 1
            and norm_for(e["replacement"], e["replacement"]) in norm_for(e["replacement"], ta)
            for e in r["edits"])
        # Tagged PDFs: the replacement must be in the tag-based reading order,
        # right after the text that preceded the old word, and nothing untagged.
        tagged = "/StructTreeRoot" in pypdf.PdfReader(dst).trailer["/Root"]
        if tagged:
            ob, ub = tagged_order(before, page_index)
            oa, ua = tagged_order(after, page_index)
            sb = "".join(t for *_, t in ob)
            sa = "".join(t for *_, t in oa)
            row["taggedUntagged"] = f"{len(ub)}->{len(ua)}"
            ctx, paths, ok = [], [], len(ua) == len(ub)
            for e in r["edits"]:
                key = e["find"] + e["replacement"]
                rep, find = norm_for(key, e["replacement"]), norm_for(key, e["find"])
                cb, ca = norm_for(key, sb), norm_for(key, sa)
                at = ca.find(rep)
                ok = ok and at >= 0 and ca.count(find) == cb.count(find) - 1
                ctx.append(ca[max(0, at - 30):at + len(rep) + 10] if at >= 0 else "(not in tag order)")
                paths.append(next((p for p, _, t in oa if rep[:8] in norm_for(key, t)), "(untagged)"))
            row["taggedOrder"] = ctx
            row["taggedPath"] = paths
            row["taggedOk"] = ok
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
                     and row.get("taggedOk", True) and not row["encryptedAfter"]
                     and row["outline"].split("->")[0] == row["outline"].split("->")[1]
                     and row["acroForm"].split("->")[0] == row["acroForm"].split("->")[1] and row["fieldValuesKept"])
        rows.append(row)
        print(("PASS " if row["ok"] else "FAIL ") + json.dumps(row, ensure_ascii=False))
    result = {"engine": f"pdfium via pypdfium2 {pdfium.version.PYPDFIUM_INFO}, pypdf {pypdf.__version__}", "rows": rows}
    print(f"\n{sum(r['ok'] for r in rows)}/{len(rows)} outputs pass the pdfium/pypdf cross-check")
    bench = check_bench()
    if bench:
        result["largeDocument"] = bench
    json.dump(result, open(os.path.join(OUT, f"results-pdfium{SUFFIX}.json"), "w", encoding="utf-8"), indent=1, ensure_ascii=False)


def check_bench():
    """The 50 edits of bench-node.mjs on the 220-page file, re-checked by pdfium:
    text on each edited page and the tag-based reading order."""
    path = os.path.join(OUT, "bench-node.json")
    if SUFFIX or not os.path.exists(path):
        return None
    report = json.load(open(path, encoding="utf-8"))
    before = pdfium.PdfDocument(os.path.join(HERE, "fixtures", report["file"]))
    after = pdfium.PdfDocument(os.path.join(OUT, "large-220p-edited.pdf"))
    edits = report["runs"][-1]["edits"]
    text_ok = tag_ok = 0
    for line in edits:
        page, change = line.split(" ")[:2]
        page, (find, rep) = int(page[1:]) - 1, change.split("->")
        tb = " ".join(before[page].get_textpage().get_text_range().split())
        ta = " ".join(after[page].get_textpage().get_text_range().split())
        text_ok += ta.count(find) == tb.count(find) - 1 and rep in ta
        (ob, ub), (oa, ua) = tagged_order(before, page), tagged_order(after, page)
        sb, sa = "".join(t for *_, t in ob), "".join(t for *_, t in oa)
        tag_ok += rep in sa and sa.count(find) == sb.count(find) - 1 and len(ua) == len(ub)
    res = {"file": report["file"], "pages": len(after), "edits": len(edits),
           "textVerified": text_ok, "inTagReadingOrder": tag_ok}
    print(f"{report['file']}: {text_ok}/{len(edits)} edits verified by pdfium, "
          f"{tag_ok}/{len(edits)} in the tag-based reading order")
    return res


if __name__ == "__main__":
    main()
