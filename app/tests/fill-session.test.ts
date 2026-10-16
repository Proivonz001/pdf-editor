// Fill and sign through EngineSession (release 3), in Node on the worker's mupdf build: form
// fields, new text, edits of that text and new pictures as logged edits beside line and image
// edits. A long mixed history across two checkpoints is undone and redone step by step and
// replayed fresh from the original, every state compared with the one recorded going forward;
// edits() copies every kind deeply; every refusal leaves the log as it was; a printed label and
// the text written just after it (one line for MuPDF) are edited part by part; a picture placed
// again after a checkpoint is embedded once, checkpoints hold pictures compressed, and the
// session carries on with each snapshot it takes, so that a picture is compressed once; forms.ts
// is told whenever the working document changes, and only then; a filled and signed form is
// saved as a normal PDF and as PDF/A-2b and read again. The modules themselves are tested in
// forms.test.ts, newcontent.test.ts and core-fill.test.ts.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as mupdf from "mupdf";
import { describe, expect, it, vi } from "vitest";
import { fallbackFontState } from "../src/engine/core.js";
import type { FieldValue, ImageTarget, LineInfo, Matrix, TextStyle } from "../src/engine/protocol";
import { MAX_ALT_CHARS, MAX_IMAGE_BYTES, MAX_TEXT_CHARS } from "../src/engine/protocol";
import { CHECKPOINT_EVERY, EngineSession, SessionError, pagesOf, splitLine, type LoggedEdit } from "../src/engine/session";

/** The documents the session said changed (forms.formChanged), in order; the real one runs too. */
const told = vi.hoisted(() => ({ docs: [] as unknown[] }));
vi.mock("../src/engine/forms", async (importOriginal) => {
  const forms = await importOriginal<typeof import("../src/engine/forms")>();
  return {
    ...forms,
    formChanged(doc: Parameters<typeof forms.formChanged>[0]) {
      told.docs.push(doc);
      forms.formChanged(doc);
    },
  };
});

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

/** PDF/A outputs for veraPDF in CI (tests/pdfa.test.ts writes the rest of the corpus there). */
const OUT = process.env.PDFA_OUT;
const keepConverted = (name: string, bytes: ArrayBuffer) => {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, `${name}.pdf`), new Uint8Array(bytes));
};

const SANS: TextStyle = { size: 12, color: [0, 0, 0], family: "sans", bold: false, italic: false };
const BLUE: [number, number, number] = [0x1f / 255, 0x3b / 255, 0x94 / 255];

function saveBytes(doc: mupdf.PDFDocument, options = "compress=no"): Uint8Array {
  const buf = doc.saveToBuffer(options);
  try {
    return buf.asUint8Array().slice();
  } finally {
    buf.destroy();
  }
}

/** A new PDF built with MuPDF's object API, as bytes. */
function makePdf(build: (doc: mupdf.PDFDocument) => void): Uint8Array {
  const doc = new mupdf.PDFDocument();
  try {
    build(doc);
    return saveBytes(doc);
  } finally {
    doc.destroy();
  }
}

/** A picture file (PNG or JPEG) whose pixels `colour` gives: RGB, or premultiplied RGBA for a PNG with transparency. */
function pictureFile(format: "jpeg" | "png", w: number, h: number, colour: (x: number, y: number) => number[]): Uint8Array {
  const alpha = colour(0, 0).length === 4;
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], alpha);
  try {
    const px = pix.getPixels(), n = alpha ? 4 : 3, stride = pix.getStride();
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const c = colour(x, y), o = y * stride + x * n;
        for (let k = 0; k < n; k++) px[o + k] = c[k];
      }
    return (format === "jpeg" ? pix.asJPEG(90) : pix.asPNG()).slice();
  } finally {
    pix.destroy();
  }
}

/** A drawn signature: a dark stroke on a transparent background (as the signature pad makes it). */
const signaturePng = (w = 180, h = 60, ink = [20, 30, 60]) =>
  pictureFile("png", w, h, (x, y) => (Math.abs(y - h / 2 - Math.sin(x / 9) * (h / 4)) < 3 ? [...ink, 255] : [0, 0, 0, 0]));

const PRINT = 4;
const BTN_NO_TOGGLE = 1 << 14, BTN_RADIO = 1 << 15, CH_COMBO = 1 << 17;

/**
 * A two-page form, as a filled-in application would have it. Page 1: printed lines (one of
 * underscores to write on, one with boxes to tick), a picture, and fields: a text field, a check
 * box with export value Si, a radio group with NoToggleToOff, a combo box, a read-only field, an
 * unsigned signature field, and a field with widgets on both pages. Page 2: printed lines and the
 * second widget of that field.
 */
function buildForm(): Uint8Array {
  return makePdf((doc) => {
    const helv = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" });
    const zadb = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "ZapfDingbats" });
    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 40, 30], false);
    let photo: mupdf.PDFObject;
    try {
      const px = pix.getPixels();
      for (let i = 0; i < px.length; i += 3) [px[i], px[i + 1], px[i + 2]] = [40 + ((i / 3) % 40) * 5, 120, 200];
      const img = new mupdf.Image(pix);
      try {
        photo = doc.addImage(img);
      } finally {
        img.destroy();
      }
    } finally {
      pix.destroy();
    }
    const page1Content = [
      "BT /F1 14 Tf 72 780 Td (Domanda di iscrizione) Tj ET",
      "BT /F1 12 Tf 72 700 Td (Nome: ______________________________) Tj ET",
      "BT /F1 12 Tf 72 670 Td (Barrare: [ ] Si   [ ] No) Tj ET",
      "q 120 0 0 90 380 450 cm /Im1 Do Q",
      "BT /F1 10 Tf 72 60 Td (Footer line) Tj ET",
    ].join("\n");
    doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { Font: { F1: helv }, XObject: { Im1: photo! } }, page1Content));
    doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { Font: { F1: helv } }, "BT /F1 12 Tf 72 760 Td (Pagina due) Tj ET\nBT /F1 12 Tf 72 700 Td (Note finali) Tj ET"));
    const page1 = doc.findPage(0), page2 = doc.findPage(1);
    const annots1 = doc.newArray(), annots2 = doc.newArray();
    page1.put("Annots", annots1);
    page2.put("Annots", annots2);
    const fields = doc.newArray();
    const DA = "(/Helv 10 Tf 0 g)";
    const widget = (dict: Record<string, unknown>, page = page1, annots = annots1) => {
      const o = doc.addObject({ Type: "Annot", Subtype: "Widget", F: PRINT, P: page, ...dict });
      annots.push(o);
      return o;
    };
    const field = (dict: Record<string, unknown>) => {
      const o = widget(dict);
      fields.push(o);
      return o;
    };
    const zres = { Font: { ZaDb: zadb } };
    const mark = (ch: string) => doc.addStream(`q 0 g BT /ZaDb 12 Tf 1.5 2 Td (${ch}) Tj ET Q\n`, { Type: "XObject", Subtype: "Form", BBox: [0, 0, 14, 14], Resources: zres });
    const off = () => doc.addStream("", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 14, 14] });

    field({ FT: "Tx", T: "(nome)", TU: "(Nome e cognome)", DA, Rect: [150, 600, 400, 618] });
    field({ FT: "Btn", T: "(privacy)", V: "Off", AS: "Off", DA: "(/ZaDb 0 Tf 0 g)", MK: { CA: "(4)" }, AP: { N: { Si: mark("4"), Off: off() } }, Rect: [150, 570, 164, 584] });
    const radio = doc.addObject({ FT: "Btn", T: "(sesso)", Ff: BTN_RADIO | BTN_NO_TOGGLE, V: "Off", Kids: [] });
    fields.push(radio);
    ["M", "F"].forEach((state, i) => {
      radio.get("Kids").push(widget({ Parent: radio, AS: "Off", DA: "(/ZaDb 0 Tf 0 g)", MK: { CA: "(l)" }, AP: { N: { [state]: mark("l"), Off: off() } }, Rect: [150 + 50 * i, 540, 164 + 50 * i, 554] }));
    });
    field({ FT: "Ch", T: "(citta)", Ff: CH_COMBO, Opt: ["(Roma)", "(Milano)", "(Forlì)"], DA, Rect: [150, 505, 300, 523] });
    field({ FT: "Tx", T: "(codice)", Ff: 1, V: "(ABC123)", DA, Rect: [150, 475, 300, 493] });
    field({ FT: "Sig", T: "(firma)", Rect: [300, 200, 500, 250] });
    const head = doc.addObject({ FT: "Tx", T: "(intestazione)", DA, Kids: [] });
    fields.push(head);
    head.get("Kids").push(widget({ Parent: head, Rect: [150, 300, 400, 318] }));
    head.get("Kids").push(widget({ Parent: head, Rect: [150, 640, 400, 658] }, page2, annots2));
    doc.getTrailer().get("Root").put("AcroForm", doc.addObject({ Fields: fields, DR: { Font: { Helv: helv, ZaDb: zadb } }, DA }));
  });
}

/**
 * Pages of 300×200 pt, each with a printed line and then, last in its content, a 9 pt label
 * "Data di nascita:" (baseline at y 100, page space): what is written just after the label joins
 * its line. `first` is content drawn before them on every page.
 */
function labelPages(count: number, first = ""): Uint8Array {
  return makePdf((doc) => {
    const helv = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" });
    const content = [first, "BT /F1 12 Tf 20 150 Td (Altro testo) Tj ET", "BT /F1 9 Tf 20 100 Td (Data di nascita:) Tj ET"].filter(Boolean).join("\n");
    for (let p = 0; p < count; p++) doc.insertPage(-1, doc.addPage([0, 0, 300, 200], 0, { Font: { F1: helv } }, content));
  });
}

/** One page whose content ends inside an array: whatever is appended would be read into it. */
const unappendable = () =>
  makePdf((doc) => {
    const helv = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" });
    doc.insertPage(-1, doc.addPage([0, 0, 300, 300], 0, { Font: { F1: helv } }, "BT /F1 12 Tf 20 250 Td (Testo) Tj ET\n[1 2"));
  });

function open(bytes: Uint8Array): EngineSession {
  const s = new EngineSession(mupdf);
  const r = s.open(bytes);
  if (!r.ok) throw new Error(`did not open: ${r.reason}`);
  return s;
}

function expectSessionError(fn: () => unknown, code: string) {
  let caught: unknown = null;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught, `expected ${code}`).toBeInstanceOf(SessionError);
  expect((caught as SessionError).code).toBe(code);
}

function lineWith(lines: LineInfo[], needle: string): LineInfo {
  const line = lines.find((l) => l.text.includes(needle));
  if (!line) throw new Error(`no line contains "${needle}" in ${JSON.stringify(lines.map((l) => l.text))}`);
  return line;
}

const texts = (s: EngineSession, page = 0) => s.lines(page).map((l) => l.text.trim());
const r2 = (v: number) => Math.round(v * 100) / 100;
const moved = (m: Matrix, dx: number, dy: number): Matrix => [m[0], m[1], m[2], m[3], m[4] + dx, m[5] + dy];
const text = (t: string): FieldValue => ({ kind: "text", text: t });
const state = (st: string): FieldValue => ({ kind: "state", state: st });
const choice = (...values: string[]): FieldValue => ({ kind: "choice", values });

/** The session's working document. */
const docOf = (s: EngineSession) => (s as unknown as { doc: mupdf.PDFDocument }).doc;

/**
 * What the user can see and do on every page: lines (text, place, added), images (place, added,
 * movable), field values, the app's texts (id, text, place, size) and a render (scale 0.5, after
 * emptying MuPDF's store, which may hold a picture decoded at another subsampling).
 */
function fingerprint(s: EngineSession) {
  const pages = docOf(s).countPages();
  const out: unknown[] = [];
  for (let p = 0; p < pages; p++) {
    mupdf.emptyStore();
    const shown = s.render(p, 0.5);
    out.push({
      lines: s.lines(p).map((l) => [l.text.trim(), r2(l.bbox[0]), r2(l.bbox[1]), l.added]),
      images: s.images(p).map((i) => [i.matrix.map(r2), i.added, i.movable]),
      fields: s.fields(p).map((f) => [f.name, f.value, (f.values ?? []).join("|")]),
      added: s.addedTexts(p).map((t) => [t.id, t.text, r2(t.origin[0]), r2(t.origin[1]), r2(t.style.size)]),
      render: createHash("sha1").update(shown.rgba).digest("hex"),
    });
  }
  return out;
}

/**
 * Changes everything inside `v`, at any depth: every number, string and flag of its objects and
 * arrays, every byte of its byte arrays (what a caller changing the result of edits() could do).
 */
function scramble(v: unknown): void {
  if (v instanceof Uint8Array) {
    v.fill(0xa5);
    return;
  }
  if (!v || typeof v !== "object") return;
  const o = v as Record<string, unknown>;
  for (const [k, x] of Object.entries(o)) {
    if (typeof x === "number") o[k] = x + 1000;
    else if (typeof x === "string") o[k] = `${x}!`;
    else if (typeof x === "boolean") o[k] = !x;
    else scramble(x);
  }
}

/** The image XObjects the app put on page `page` (PEImg1, PEImg2...), by object number. */
function pictures(s: EngineSession, page: number): number[] {
  const xobjects = docOf(s).findPage(page).getInheritable("Resources").get("XObject");
  const out: number[] = [];
  xobjects.forEach((v, k) => {
    if (String(k).startsWith("PEImg")) out.push(v.asIndirect());
  });
  return out;
}

/** The /Filter of each picture the app put on page `page` and of its soft mask (null: raw pixels), flat. */
function filters(s: EngineSession, page: number): (string | null)[] {
  const xobjects = docOf(s).findPage(page).getInheritable("Resources").get("XObject");
  const filter = (o: mupdf.PDFObject) => (o.get("Filter").isName() ? o.get("Filter").asName() : null);
  const out: (string | null)[] = [];
  xobjects.forEach((v, k) => {
    if (String(k).startsWith("PEImg")) out.push(filter(v), filter(v.get("SMask")));
  });
  return out;
}

/** The index of the page's line that is exactly `t`. */
function lineIndex(s: EngineSession, page: number, t: string): number {
  const line = s.lines(page).find((l) => l.text.trim() === t);
  if (!line) throw new Error(`no line "${t}" on page ${page + 1}: ${JSON.stringify(texts(s, page))}`);
  return line.index;
}

describe("a filled and signed form, step by step", () => {
  it("20 mixed steps across two checkpoints: undo all, redo all and fresh replays give every state again", () => {
    const original = buildForm();
    const s = open(original);
    const form = texts(s);
    const states = [fingerprint(s)];
    const step = (check?: () => void) => {
      check?.();
      states.push(fingerprint(s));
    };

    // 1. A text field, WinAnsi: MuPDF draws it.
    step(() => expect(s.setField("nome", text("Mario Rossi"))).toMatchObject({ name: "nome", changedPages: [0], editCount: 1 }));
    // 2-3. A name written on the form's line, and a tick in its box (page space: y down).
    const name = s.addText(0, [115, 142], "Mario Rossi", SANS);
    step(() => expect(name).toMatchObject({ pageIndex: 0, id: 1, missingChars: [], changedPages: [0] }));
    const tick = s.addText(0, [131.5, 172], "✓", SANS);
    step(() => expect(tick.id).toBe(2));
    // 4. A printed line edited.
    step(() => s.replaceLine(0, lineIndex(s, 0, "Domanda di iscrizione"), "Domanda di iscrizione 2026"));
    // 5. The printed picture moved.
    step(() => s.transformImage(0, 0, moved(s.images(0)[0].matrix, 10, 10)));
    // 6. The check box ticked.
    step(() => s.setField("privacy", state("Si")));
    // 7. The signature, in the signature field's box, described.
    const sig = s.addImage(signaturePng(), [{ pageIndex: 0, matrix: [150, 0, 0, 40, 320, 597] }], "Firma: Mario Rossi");
    step(() => {
      expect(sig.placed).toEqual([{ pageIndex: 0, imageIndex: 1 }]);
      expect(s.images(0)[1]).toMatchObject({ added: true, movable: true });
    });
    // 8. The name corrected in its own block: the underscores under it stay.
    step(() => {
      expect(s.editAddedText(0, name.id!, { text: "Maria Rossi" })).toMatchObject({ id: name.id, changedPages: [0] });
      expect(texts(s)).toContain("Nome: ______________________________");
    });
    // 9. A text field outside WinAnsi: the app's writer draws it.
    step(() => s.setField("nome", text("Zażółć gęślą")));
    // 10. Initials on both pages: one edit, one picture.
    const initials = s.addImage(signaturePng(60, 30, [10, 10, 10]), [0, 1].map((p) => ({ pageIndex: p, matrix: [40, 0, 0, 20, 520, 800] as Matrix })), null);
    step(() => {
      expect(initials.changedPages).toEqual([0, 1]);
      expect(initials.placed).toEqual([{ pageIndex: 0, imageIndex: 2 }, { pageIndex: 1, imageIndex: 0 }]);
    });
    // 11. The written name edited with the line editor: routed to its block, never redacted.
    step(() => {
      const line = s.lines(0)[lineIndex(s, 0, "Maria Rossi")];
      expect(line.added).toBe(true);
      expect(s.replaceLine(0, line.index, "Maria Bianchi")).toMatchObject({ before: "Maria Rossi", after: "Maria Bianchi", fallbackChars: [] });
      expect(s.edits().at(-1)!.kind).toBe("editAdded");
      expect(texts(s)).toContain("Nome: ______________________________");
    });
    // 12. A radio button.
    step(() => s.setField("sesso", state("F")));
    // 13. The added signature moved with release 2's handles.
    step(() => s.transformImage(0, 1, moved(s.images(0)[1].matrix, 5, -5)));
    // 14. The written name moved and restyled (bigger, blue).
    step(() => s.editAddedText(0, name.id!, { origin: [120, 140], style: { ...SANS, size: 14, color: BLUE } }));
    // 15. A combo box.
    step(() => s.setField("citta", choice("Milano")));
    // 16. The printed line under the written name edited: the name comes back over it.
    step(() => {
      s.replaceLine(0, lineIndex(s, 0, "Nome: ______________________________"), "Nome e cognome: ______________________");
      expect(texts(s)).toContain("Maria Bianchi");
      expect(s.addedTexts(0).find((t) => t.id === name.id)).toMatchObject({ text: "Maria Bianchi", origin: [120, 140] });
    });
    // 17. The initials on page 2 deleted.
    step(() => {
      expect(s.images(1)[0].added).toBe(true);
      s.deleteImage(1, 0);
    });
    // 18. A field with widgets on both pages.
    step(() => expect(s.setField("intestazione", text("Ufficio anagrafe")).changedPages).toEqual([0, 1]));
    // 19. The tick deleted: the box's text stays whole.
    step(() => {
      expect(s.editAddedText(0, tick.id!, { text: "" })).toMatchObject({ id: null });
      expect(texts(s)).toContain("Barrare: [ ] Si   [ ] No");
    });
    // 20. The printed picture replaced.
    step(() => s.replaceImage(0, 0, pictureFile("jpeg", 60, 30, () => [200, 40, 40])));

    const log = s.edits();
    expect(log).toHaveLength(20);
    expect(new Set(log.map((e) => e.kind))).toEqual(new Set(["text", "image", "field", "addText", "editAdded", "addImage"]));
    const checkpoints = (s as unknown as { checkpoints: { editCount: number }[] }).checkpoints.map((c) => c.editCount);
    expect(checkpoints).toEqual([CHECKPOINT_EVERY, 2 * CHECKPOINT_EVERY]);
    // The written lines were never redacted: the form's printed text is all there, edited where edited.
    expect(texts(s)).toEqual(expect.arrayContaining(["Barrare: [ ] Si   [ ] No", "Footer line", "Domanda di iscrizione 2026"]));
    expect(form).toContain("Nome: ______________________________");

    // Undo all the way, one step at a time: each step reports the pages its edit touched.
    for (let k = log.length; k >= 1; k--) {
      const r = s.undo();
      expect(r.changedPages, `undo of step ${k}`).toEqual(pagesOf(log[k - 1]));
      expect(r.editCount).toBe(k - 1);
      expect(fingerprint(s), `state after undoing step ${k}`).toEqual(states[k - 1]);
    }
    expect(s.undo().changedPages).toEqual([]);
    // Redo all the way.
    for (let k = 1; k <= log.length; k++) {
      const r = s.redo();
      expect(r.changedPages, `redo of step ${k}`).toEqual(pagesOf(log[k - 1]));
      expect(fingerprint(s), `state after redoing step ${k}`).toEqual(states[k]);
    }
    expect(s.edits()).toEqual(log);

    // A fresh session replays the log (as copies, from the original, no checkpoint) to the same states.
    const fresh = open(original);
    const apply = (fresh as unknown as { apply(doc: mupdf.PDFDocument, e: LoggedEdit): void }).apply.bind(fresh);
    log.forEach((e, k) => {
      apply(docOf(fresh), e);
      expect(fingerprint(fresh), `fresh replay of step ${k + 1}`).toEqual(states[k + 1]);
    });
    fresh.close();
    s.close();
  });

  it("edits() gives deep copies of every kind of edit, as plain data", () => {
    const s = open(buildForm());
    s.setField("citta", choice("Roma"));
    const added = s.addText(0, [115, 142], "Mario", SANS);
    s.editAddedText(0, added.id!, { origin: [118, 142], style: { ...SANS, color: BLUE } });
    s.addImage(signaturePng(), [{ pageIndex: 0, matrix: [100, 0, 0, 30, 320, 600] }, { pageIndex: 1, matrix: [100, 0, 0, 30, 320, 600] }], "Sigla");
    s.replaceImage(0, 0, pictureFile("png", 8, 8, () => [0, 200, 0]));
    s.replaceLine(0, lineIndex(s, 0, "Footer line"), "Footer");
    const first = s.edits();
    expect(first.map((e) => e.kind)).toEqual(["field", "addText", "editAdded", "addImage", "image", "text"]);
    expect(first[0]).toEqual({ kind: "field", name: "citta", type: "combo", value: { kind: "choice", values: ["Roma"] }, pageIndex: 0, pages: [0] });
    expect(first[1]).toEqual({ kind: "addText", pageIndex: 0, origin: [115, 142], text: "Mario", style: SANS, id: 1 });
    expect(first[2]).toEqual({ kind: "editAdded", pageIndex: 0, id: 1, origin: [118, 142], style: { ...SANS, color: BLUE } });
    expect(first[3]).toMatchObject({ kind: "addImage", pageIndex: 0, alt: "Sigla", targets: [{ pageIndex: 0 }, { pageIndex: 1 }] });
    // The rewritten footer is now the page's last printed text: a text written just after it joins
    // its line, and an edit of both parts is one MixedLineEdit.
    const footer = lineWith(s.lines(0), "Footer");
    s.addText(0, [footer.bbox[2] + 5, 782], "p. 1", SANS);
    s.replaceLine(0, lineWith(s.lines(0), "p. 1").index, "Fotter p. 2");
    // The other image edits, and two texts on one baseline edited as one line (absorb).
    s.transformImage(0, 0, moved(s.images(0)[0].matrix, 5, 5));
    s.deleteImage(1, 0);
    s.addText(0, [100, 400], "Anna", SANS);
    s.addText(0, [s.addedTexts(0).find((x) => x.text === "Anna")!.bbox[2] + 3.336, 400], "Bianchi", SANS);
    s.replaceLine(0, lineWith(s.lines(0), "Anna").index, "Anna Bianchi Rossi");

    const log = s.edits();
    const kinds = log.map((e) => (e.kind === "image" ? `image ${e.op}` : e.kind));
    expect(new Set(kinds)).toEqual(new Set(["field", "addText", "editAdded", "addImage", "image replace", "image transform", "image delete", "text", "mixed"]));
    expect(log.find((e) => e.kind === "mixed")).toMatchObject({ edits: [{ kind: "text", find: "Footer", replacement: "Fotter" }, { kind: "editAdded", text: "p. 2" }] });
    expect(log.at(-1)).toMatchObject({ kind: "editAdded", text: "Anna Bianchi Rossi", absorb: [expect.any(Number)] });
    // Plain data: a structured clone (what storing the log for "resume session" takes) is equal.
    const snapshot = structuredClone(log);
    expect(snapshot).toEqual(log);
    // Changing anything inside a copy, at any depth, changes nothing in the session's log: compared
    // with a snapshot taken before (a shallow copy would change `log` too, and still equal it).
    const state = fingerprint(s);
    scramble(s.edits());
    expect(s.edits()).toEqual(snapshot);
    // ...and the log still replays: undo all, redo all.
    for (let h = s.undo(); h.canUndo; ) h = s.undo();
    for (let h = s.redo(); h.canRedo; ) h = s.redo();
    expect(s.edits()).toEqual(snapshot);
    expect(fingerprint(s)).toEqual(state);
    s.close();
  });
});

describe("refusals: nothing is logged, nothing changes", () => {
  it("setField: unknown names, locked fields, values the field cannot take; the same value is a no-op", () => {
    const s = open(buildForm());
    expectSessionError(() => s.setField("nessuno", text("x")), "bad-request");
    expectSessionError(() => s.setField(42 as unknown as string, text("x")), "bad-request");
    expectSessionError(() => s.setField("codice", text("X")), "not-editable"); // read-only
    expectSessionError(() => s.setField("firma", text("X")), "not-editable"); // signature field
    expectSessionError(() => s.setField("citta", choice("Napoli")), "bad-request");
    expectSessionError(() => s.setField("nome", state("Si")), "bad-request");
    expectSessionError(() => s.setField("privacy", state("Yes")), "bad-request");
    expectSessionError(() => s.setField("nome", text("a\u0000b")), "bad-request");
    expectSessionError(() => s.setField("nome", null as unknown as FieldValue), "bad-request");
    expect(s.edits()).toEqual([]);
    s.setField("nome", text("Mario"));
    s.undo();
    const same = s.setField("nome", text(""));
    expect(same).toEqual({ editCount: 0, canUndo: false, canRedo: true, changedPages: [], name: "nome", missingChars: [], overflow: false });
    expect(s.redo().editCount).toBe(1);
    expect(s.setField("nome", text("Mario")).changedPages).toEqual([]);
    expect(s.edits()).toHaveLength(1);
    s.close();
  });

  it("addText: origins off the page, empty, too long or undrawable text, styles out of range", () => {
    const s = open(buildForm());
    const before = texts(s);
    const bad: [number, [number, number], unknown, unknown][] = [
      [0, [-1, 100], "x", SANS],
      [0, [100, 843], "x", SANS],
      [0, [NaN, 100], "x", SANS],
      [0, [100] as unknown as [number, number], "x", SANS],
      [2, [100, 100], "x", SANS],
      [0.5, [100, 100], "x", SANS],
      [0, [100, 100], "", SANS],
      [0, [100, 100], " \t\n ", SANS],
      [0, [100, 100], "\u0001\u0002", SANS],
      [0, [100, 100], "x".repeat(MAX_TEXT_CHARS + 1), SANS],
      [0, [100, 100], "😀 👍", SANS],
      [0, [100, 100], 42, SANS],
      [0, [100, 100], "x", { ...SANS, size: 0.5 }],
      [0, [100, 100], "x", { ...SANS, size: 501 }],
      [0, [100, 100], "x", { ...SANS, color: [0, 0, 2] }],
      [0, [100, 100], "x", { ...SANS, color: [0, 0] }],
      [0, [100, 100], "x", { ...SANS, family: "comic" }],
      [0, [100, 100], "x", { ...SANS, bold: "yes" }],
      [0, [100, 100], "x", null],
    ];
    for (const [page, origin, t, style] of bad) expectSessionError(() => s.addText(page, origin, t as string, style as TextStyle), "bad-request");
    expect(s.edits()).toEqual([]);
    expect(texts(s)).toEqual(before);
    // What can be drawn is written, the rest listed; line breaks become spaces, the ends trimmed.
    const r = s.addText(0, [100, 400], "  Ok 😀\nfine ", SANS);
    expect(r.missingChars).toEqual(["😀"]);
    expect(s.addedTexts(0).map((x) => x.text)).toEqual(["Ok  fine"]);
    expect(s.edits()).toMatchObject([{ kind: "addText", text: "Ok 😀 fine" }]);
    s.close();
  });

  it("editAddedText: no such text, patches out of range; nothing new is a no-op", () => {
    const s = open(buildForm());
    const { id } = s.addText(0, [100, 400], "Mario", SANS);
    for (const bad of [0, -1, 1.5, 7, NaN]) expectSessionError(() => s.editAddedText(0, bad, { text: "x" }), "bad-request");
    expectSessionError(() => s.editAddedText(1, id!, { text: "x" }), "bad-request"); // another page
    expectSessionError(() => s.editAddedText(0, id!, { text: "😀" }), "bad-request");
    expectSessionError(() => s.editAddedText(0, id!, { text: "x".repeat(MAX_TEXT_CHARS + 1) }), "bad-request");
    expectSessionError(() => s.editAddedText(0, id!, { origin: [600, 100] }), "bad-request");
    expectSessionError(() => s.editAddedText(0, id!, { style: { ...SANS, size: 0 } }), "bad-request");
    expectSessionError(() => s.editAddedText(0, id!, { text: 3 as unknown as string }), "bad-request");
    expect(s.edits()).toHaveLength(1);
    for (const patch of [{}, { text: " Mario " }, { origin: [100, 400] as [number, number] }, { style: SANS }, { text: "Mario", origin: [100.0001, 400] as [number, number], style: SANS }])
      expect(s.editAddedText(0, id!, patch)).toMatchObject({ changedPages: [], id, editCount: 1 });
    expect(s.edits()).toHaveLength(1);
    s.close();
  });

  it("addImage: targets, matrices, descriptions and pictures checked first", () => {
    const s = open(buildForm());
    const png = signaturePng();
    const ok: ImageTarget = { pageIndex: 0, matrix: [100, 0, 0, 30, 300, 600] };
    const badTargets: unknown[] = [
      [],
      null,
      [ok, { ...ok, matrix: [50, 0, 0, 20, 10, 10] }], // two on one page
      [{ pageIndex: 2, matrix: ok.matrix }],
      [{ pageIndex: 0, matrix: [0, 0, 0, 0, 10, 10] }], // degenerate
      [{ pageIndex: 0, matrix: [0.5, 0, 0, 30, 10, 10] }], // a side under 1 pt
      [{ pageIndex: 0, matrix: [20000, 0, 0, 30, 10, 10] }], // over 14,400 pt
      [{ pageIndex: 0, matrix: [100, 0, 0, 30, 700, 600] }], // centre off the page
      [{ pageIndex: 0, matrix: [100, 0, 0, 30, 300, Infinity] }],
      [{ pageIndex: 0 }],
    ];
    for (const targets of badTargets) expectSessionError(() => s.addImage(png, targets as ImageTarget[], null), "bad-request");
    for (const alt of ["x".repeat(MAX_ALT_CHARS + 1), 42, undefined])
      expectSessionError(() => s.addImage(png, [ok], alt as string), "bad-request");
    const garbage = new Uint8Array(4096).map((_, i) => (i * 7919) % 251);
    for (const bytes of [garbage, new Uint8Array(0), "abc" as unknown as Uint8Array, new Uint8Array(MAX_IMAGE_BYTES + 1)])
      expectSessionError(() => s.addImage(bytes, [ok], null), "bad-request");
    expect(s.edits()).toEqual([]);
    expect(s.images(0).map((i) => i.added)).toEqual([false]);
    // A blank description is none; the caller's bytes are copied.
    const copy = png.slice();
    const r = s.addImage(copy.buffer, [ok], "  \u0000 ");
    copy.fill(0);
    expect(r.placed).toEqual([{ pageIndex: 0, imageIndex: 1 }]);
    expect(s.edits()).toMatchObject([{ kind: "addImage", alt: null }]);
    s.undo();
    s.redo();
    expect(s.images(0)[1]).toMatchObject({ added: true, pixelWidth: 180, pixelHeight: 60 });
    s.close();
  });

  it("a page whose content cannot take an addition: not-editable, and the document stays as it was", () => {
    const s = open(unappendable());
    const before = s.lines(0).map((l) => l.text);
    expectSessionError(() => s.addText(0, [20, 100], "Mario", SANS), "not-editable");
    expectSessionError(() => s.addImage(signaturePng(), [{ pageIndex: 0, matrix: [100, 0, 0, 30, 20, 150] }], null), "not-editable");
    expect(s.edits()).toEqual([]);
    expect(s.lines(0).map((l) => l.text)).toEqual(before);
    expect(s.addedTexts(0)).toEqual([]);
    // The session is not broken: a line edit still works.
    s.replaceLine(0, 0, "Altro");
    expect(texts(s)).toContain("Altro");
    s.close();
  });
});

describe("line edits and the lines the app wrote", () => {
  it("lines() marks the app's lines; replaceLine rewrites them in their block, others by redaction, keeping what lies over them", () => {
    const s = open(buildForm());
    s.addText(0, [115, 142], "Mario Rossi", SANS);
    const lines = s.lines(0);
    expect(lineWith(lines, "Mario Rossi").added).toBe(true);
    expect(lines.filter((l) => l.added)).toHaveLength(1);
    // Deleted with the line editor: its block goes, the underscores stay.
    s.replaceLine(0, lineWith(s.lines(0), "Mario Rossi").index, "");
    expect(s.edits().at(-1)).toEqual({ kind: "editAdded", pageIndex: 0, id: 1, text: "" });
    expect(texts(s)).toContain("Nome: ______________________________");
    expect(s.addedTexts(0)).toEqual([]);
    s.undo();
    // The printed line under it edited: the redaction takes the name's glyphs, which come back.
    s.replaceLine(0, lineIndex(s, 0, "Nome: ______________________________"), "Cognome: ________________________");
    expect(s.edits().at(-1)!.kind).toBe("text");
    expect(texts(s)).toEqual(expect.arrayContaining(["Cognome: ________________________", "Mario Rossi"]));
    expect(lineWith(s.lines(0), "Mario Rossi").added).toBe(true);
    s.close();
  });

  it("two texts written one after the other on one baseline edit as one line", () => {
    const s = open(buildForm());
    s.addText(0, [100, 400], "Mario", SANS);
    const after = s.addedTexts(0)[0].bbox[2];
    s.addText(0, [after + 3.336, 400], "Rossi", SANS); // a space of Helvetica at 12 pt further
    // MuPDF reads them as one line (with a space it adds): rewritten as the first, the second absorbed.
    const line = lineWith(s.lines(0), "Mario");
    expect([line.text.trim(), line.added]).toEqual(["Mario Rossi", true]);
    s.replaceLine(0, line.index, "Maria Rossi");
    expect(s.edits().at(-1)).toEqual({ kind: "editAdded", pageIndex: 0, id: 1, text: "Maria Rossi", absorb: [2] });
    expect(s.addedTexts(0).map((t) => [t.id, t.text])).toEqual([[1, "Maria Rossi"]]);
    expect(texts(s).filter((t) => t.includes("Rossi"))).toEqual(["Maria Rossi"]);
    expect(s.undo().changedPages).toEqual([0]);
    expect(s.addedTexts(0).map((t) => t.text)).toEqual(["Mario", "Rossi"]);
    s.close();
  });

  it("a printed label and the date written just after it, read as one line, are edited part by part", () => {
    // Four pages, each ending with a label: a date written just after it, on its baseline, joins its line.
    const original = labelPages(4);
    const s = open(original);
    const DATE: TextStyle = { ...SANS, family: "serif", color: BLUE };
    const states = [fingerprint(s)];
    const ids = [0, 1, 2, 3].map((p) => {
      const { id } = s.addText(p, [lineWith(s.lines(p), "nascita").bbox[2] + 5, 100], "12/03/1980", DATE);
      states.push(fingerprint(s));
      return id!;
    });
    const step = (page: number, find: string, next: string) => {
      const r = s.replaceLine(page, lineWith(s.lines(page), find).index, next);
      states.push(fingerprint(s));
      return r;
    };
    const date = (page: number) => s.addedTexts(page).find((t) => t.text.includes("/"));
    // (an added line's colour reads back to 6 decimals)
    const styleOf = (page: number) => ({ ...date(page)!.style, color: date(page)!.style.color.map((v) => r2(v * 100)) });
    const DATE_READ = { ...DATE, color: BLUE.map((v) => r2(v * 100)) };
    const line = lineWith(s.lines(0), "1980");
    expect([line.text.trim(), line.added]).toEqual(["Data di nascita: 12/03/1980", false]);

    // A digit of the date: its own block, in its own style; the label is not touched.
    expect(step(0, "1980", "Data di nascita: 12/03/1981")).toMatchObject({ changedPages: [0], segments: [] });
    expect(s.edits().at(-1)).toEqual({ kind: "editAdded", pageIndex: 0, id: ids[0], text: "12/03/1981" });
    expect([date(0)!.id, date(0)!.text, styleOf(0)]).toEqual([ids[0], "12/03/1981", DATE_READ]);
    expect(lineWith(s.lines(0), "1981").text.trim()).toBe("Data di nascita: 12/03/1981");
    // Only the space MuPDF reads between them taken away: nothing to do.
    const count = s.edits().length;
    expect(s.replaceLine(0, lineWith(s.lines(0), "1981").index, "Data di nascita:12/03/1981").changedPages).toEqual([]);
    expect(s.edits()).toHaveLength(count);
    // Both parts at once: the label by redaction, the date in its block.
    step(0, "1981", "Data di nascite: 12/03/1982");
    expect(s.edits().at(-1)).toMatchObject({
      kind: "mixed",
      edits: [{ kind: "text", find: "Data di nascita:", occurrence: 0, replacement: "Data di nascite:" }, { kind: "editAdded", id: ids[0], text: "12/03/1982" }],
    });
    expect(texts(s, 0)).toEqual(expect.arrayContaining(["Data di nascite:", "12/03/1982"]));
    expect([date(0)!.id, styleOf(0)]).toEqual([ids[0], DATE_READ]);
    // A longer label: the date moves right as much, so that the two do not run into each other.
    const before = date(1)!.origin;
    step(1, "1980", "Data e luogo di nascita: 12/03/1980");
    const after = date(1)!;
    expect([after.id, after.text, styleOf(1)]).toEqual([ids[1], "12/03/1980", DATE_READ]);
    expect(after.origin[0]).toBeGreaterThan(before[0] + 20);
    expect(after.origin[1]).toBeCloseTo(before[1], 3);
    expect(lineWith(s.lines(1), "luogo").bbox[2]).toBeLessThan(after.origin[0]);
    const moves = s.edits().at(-1) as Extract<LoggedEdit, { kind: "mixed" }>;
    expect(moves.edits.map((e) => [e.kind, e.kind === "editAdded" ? e.id : e.find])).toEqual([["text", "Data di nascita:"], ["editAdded", ids[1]]]);
    expect((moves.edits[1] as Extract<LoggedEdit, { kind: "editAdded" }>).origin![0]).toBeCloseTo(after.origin[0], 3);
    // The whole line deleted: the label redacted, the date's block removed.
    step(2, "1980", "");
    expect(texts(s, 2)).toEqual(["Altro testo"]);
    expect(s.addedTexts(2)).toEqual([]);
    // The line typed again from scratch: one line, in the label's style (the date goes).
    step(3, "1980", "Nuova riga");
    expect(texts(s, 3)).toEqual(["Altro testo", "Nuova riga"]);
    expect(s.addedTexts(3)).toEqual([]);
    // Past a checkpoint, the date (now a line of its own) edited with the line editor.
    s.addText(2, [20, 150], "nota", SANS);
    states.push(fingerprint(s));
    step(0, "1982", "13/03/1982");
    expect(s.edits().at(-1)).toMatchObject({ kind: "editAdded", id: ids[0], text: "13/03/1982" });
    const log = s.edits();
    expect(log).toHaveLength(states.length - 1);
    expect(log.length).toBeGreaterThan(CHECKPOINT_EVERY);

    for (let k = log.length; k >= 1; k--) {
      expect(s.undo().changedPages).toEqual(pagesOf(log[k - 1]));
      expect(fingerprint(s), `state after undoing step ${k}`).toEqual(states[k - 1]);
    }
    for (let k = 1; k <= log.length; k++) {
      s.redo();
      expect(fingerprint(s), `state after redoing step ${k}`).toEqual(states[k]);
    }
    const fresh = open(original);
    const apply = (fresh as unknown as { apply(doc: mupdf.PDFDocument, e: LoggedEdit): void }).apply.bind(fresh);
    log.forEach((e, k) => {
      apply(docOf(fresh), e);
      expect(fingerprint(fresh), `fresh replay of step ${k + 1}`).toEqual(states[k + 1]);
    });
    fresh.close();
    s.close();
  });

  it("a line of printed text, the user's text and printed text again: one printed part at a time", () => {
    // "firma" printed first in the content, just after where the name will end.
    const probe = open(labelPages(1));
    probe.addText(0, [lineWith(probe.lines(0), "nascita").bbox[2] + 5, 100], "Mario", SANS);
    const nameEnd = probe.addedTexts(0)[0].bbox[2];
    probe.close();
    const s = open(labelPages(1, `BT /F1 9 Tf ${nameEnd + 4} 100 Td (firma) Tj ET`));
    s.addText(0, [lineWith(s.lines(0), "nascita").bbox[2] + 5, 100], "Mario", SANS);
    // An edit of "firma" is written after the name in the content: the three then read as one line.
    s.replaceLine(0, lineWith(s.lines(0), "firma").index, "firme");
    const line = lineWith(s.lines(0), "Mario");
    expect(line.text.trim()).toBe("Data di nascita: Mario firme");
    // A change that rewrites both printed parts is refused, and nothing changes.
    const count = s.edits().length;
    expectSessionError(() => s.replaceLine(0, line.index, "Data di nascite: Mario firma"), "not-editable");
    expect(s.edits()).toHaveLength(count);
    // The second printed part alone: found where it is in the line, not at its start.
    s.replaceLine(0, line.index, "Data di nascita: Mario firmato");
    expect(s.edits().at(-1)).toEqual({ kind: "text", pageIndex: 0, find: "firme", occurrence: 0, replacement: "firmato" });
    expect(texts(s)).toContain("Data di nascita: Mario firmato");
    expect(s.addedTexts(0).map((t) => [t.id, t.text])).toEqual([[1, "Mario"]]);
    s.close();
  });

  it("splitLine: which part each change of a mixed line goes to", () => {
    // "Nome:" printed, a space MuPDF reads in the gap, "Mario" written by the user.
    const apart = [{ start: 0, end: 5, text: "Nome:" }, { start: 6, end: 11, text: "Mario" }];
    // (each part's text is trimmed when it is written)
    const split = (next: string) => splitLine("Nome: Mario", next, apart).map((t) => t.trim());
    expect(split("Nome: Maria")).toEqual(["Nome:", "Maria"]);
    expect(split("Name: Mario")).toEqual(["Name:", "Mario"]);
    expect(split("Nome: Mario Rossi")).toEqual(["Nome:", "Mario Rossi"]);
    expect(split("Nome:  Mario")).toEqual(["Nome:", "Mario"]); // (a space more where they meet: trimmed)
    expect(split("Nome:Mario")).toEqual(["Nome:", "Mario"]); // the gap cannot be taken away
    expect(split("Nome: - Mario")).toEqual(["Nome:", "- Mario"]);
    expect(split("Name: Maria")).toEqual(["Name:", "Maria"]); // two changes: cut at the space
    expect(split("Nome. Marco")).toEqual(["Nome.", "Marco"]);
    expect(split("Nome. Luigi")).toEqual(["Nome. Luigi", ""]); // (more than half of it new: one line)
    expect(split("")).toEqual(["", ""]);
    expect(split("Ciao")).toEqual(["Ciao", ""]); // typed again: one line
    expect(split("Ciao Mondo")).toEqual(["Ciao Mondo", ""]); // (too far from both to be cut)
    // Touching parts ("Nome:Mario"): a cut anywhere, if close enough.
    const touching = [{ start: 0, end: 5, text: "Nome:" }, { start: 5, end: 10, text: "Mario" }];
    const joined = (next: string) => splitLine("Nome:Mario", next, touching).map((t) => t.trim());
    expect(joined("Name:Maria")).toEqual(["Name:", "Maria"]);
    expect(joined("Nome:XMario")).toEqual(["Nome:X", "Mario"]); // typed where they meet: the first
    expect(joined("Ciao")).toEqual(["Ciao", ""]);
  });

  it("a fallback in the very face the line already had is not reported as one", () => {
    const s = open(fixture("chrome-subset.pdf"));
    const first = s.replaceLine(0, lineWith(s.lines(0), "Note").index, "ΩΩΩ");
    expect(first.fallbackChars).toEqual(["Ω"]);
    // The line is now drawn in the app's fallback face: more of it adds nothing new to tell.
    const second = s.replaceLine(0, lineWith(s.lines(0), "ΩΩΩ").index, "ΩΩΩ Ω");
    expect(second.fallbackChars).toEqual([]);
    expect(texts(s)).toContain("ΩΩΩ Ω");
    s.close();
  });
});

describe("pictures and checkpoints", () => {
  it("a picture placed again after a checkpoint is embedded once, whichever way the history went", () => {
    const photo = pictureFile("jpeg", 300, 200, (x, y) => [(x * 31 + y * 7) & 255, (x ^ y) & 255, (x * y) & 255]);
    const original = buildForm();
    const s = open(original);
    s.replaceImage(0, 0, photo); // 1: the printed picture replaced with the photo
    for (let i = 0; i < 7; i++) s.addText(0, [72, 300 + i * 14], `riga ${i}`, SANS); // 2-8: a checkpoint at 8
    s.addImage(photo, [{ pageIndex: 1, matrix: [120, 0, 0, 80, 300, 300] }], null); // 9: the same photo on page 2
    s.addText(1, [72, 100], "x", SANS); // 10
    const [held] = pictures(s, 0);
    expect(pictures(s, 1)).toEqual([held]);
    const size = s.save().bytes.byteLength;
    // Undo rebuilds from the checkpoint and replays edit 9: it still draws the copy made by edit 1.
    s.undo();
    expect(pictures(s, 1)).toEqual([held]);
    s.redo();
    expect(s.save().bytes.byteLength).toBe(size);
    // ...and so does a placement after the rebuild.
    s.addImage(photo, [{ pageIndex: 1, matrix: [60, 0, 0, 40, 100, 100] }], null);
    expect(pictures(s, 1)).toEqual([held, held]);
    const third = s.save().bytes.byteLength;
    expect(third - size).toBeLessThan(photo.length / 2);
    // A fresh replay of the log writes the same file.
    const fresh = open(original);
    const apply = (fresh as unknown as { apply(doc: mupdf.PDFDocument, e: LoggedEdit): void }).apply.bind(fresh);
    for (const e of s.edits()) apply(docOf(fresh), e);
    expect(fresh.save().bytes.byteLength).toBe(third);
    fresh.close();
    s.close();
  });

  it("checkpoints hold pictures compressed, keeping object numbers", () => {
    const s = open(buildForm());
    s.addImage(signaturePng(1200, 400), [{ pageIndex: 0, matrix: [120, 0, 0, 40, 300, 300] }], null);
    for (let i = 0; i < 7; i++) s.addText(0, [72, 300 + i * 14], `riga ${i}`, SANS);
    const [checkpoint] = (s as unknown as { checkpoints: { editCount: number; bytes: Uint8Array }[] }).checkpoints;
    expect(checkpoint.editCount).toBe(8);
    // MuPDF keeps the PNG's pixels raw in the document (1.5 MB with the alpha); the checkpoint has them deflated.
    expect(checkpoint.bytes.byteLength).toBeLessThan(200_000);
    const [held] = pictures(s, 0);
    const state = fingerprint(s);
    s.addText(0, [72, 420], "dopo", SANS);
    s.undo(); // rebuilt from that checkpoint: the same objects, the fallback fonts found again
    expect(pictures(s, 0)).toEqual([held]);
    expect(fingerprint(s)).toEqual(state);
    s.addText(0, [72, 420], "Ωmega", SANS);
    expect(texts(s)).toContain("Ωmega");
    s.close();
  });

  it("the session carries on with each snapshot it takes: a picture is compressed once, and its fonts and pictures go along", () => {
    const original = buildForm();
    const s = open(original);
    const png = signaturePng(1200, 400);
    s.addImage(png, [{ pageIndex: 0, matrix: [120, 0, 0, 40, 300, 300] }], null); // 1
    expect(filters(s, 0)).toEqual([null, null]); // MuPDF holds the PNG's pixels and alpha raw
    s.addText(0, [72, 250], "Ωmega", SANS); // 2: the fallback fonts
    for (let i = 0; i < 5; i++) s.addText(0, [72, 300 + i * 14], `riga ${i}`, SANS); // 3-7
    const before = docOf(s), [held] = pictures(s, 0);
    const fonts = fallbackFontState(before).map((f) => [f.name, f.ref]);
    expect(fonts.length).toBeGreaterThan(0);
    s.addText(0, [72, 380], "riga 5", SANS); // 8: a checkpoint
    // The working document is now the checkpoint re-opened: the same objects, the pixels and the
    // mask compressed (MuPDF's choice of filter: the mask, all 0 or 255, as fax), so the next
    // snapshots copy them as they are instead of compressing them again.
    expect(docOf(s)).not.toBe(before);
    expect(pictures(s, 0)).toEqual([held]);
    expect(filters(s, 0)).toEqual(["FlateDecode", "CCITTFaxDecode"]);
    // The fallback fonts went along: more text in them embeds nothing new.
    s.addText(0, [72, 400], "Ωmega", SANS); // 9
    expect(fallbackFontState(docOf(s)).map((f) => [f.name, f.ref])).toEqual(fonts);
    // So did the notes of the pictures embedded: the same picture placed again is that copy.
    s.addImage(png, [{ pageIndex: 1, matrix: [120, 0, 0, 40, 300, 300] }], null); // 10
    expect(pictures(s, 1)).toEqual([held]);
    // A fresh replay of the log from the original, which never re-opens a snapshot, reads and draws the same.
    const state = fingerprint(s);
    const fresh = open(original);
    const apply = (fresh as unknown as { apply(doc: mupdf.PDFDocument, e: LoggedEdit): void }).apply.bind(fresh);
    for (const e of s.edits()) apply(docOf(fresh), e);
    expect(fingerprint(fresh)).toEqual(state);
    fresh.close();

    // The PDF/A check takes a snapshot too: a picture embedded since the checkpoint is compressed
    // there, and the save after it (the download) copies it.
    s.addImage(pictureFile("png", 400, 300, (x, y) => [x & 255, y & 255, 90, 200]), [{ pageIndex: 1, matrix: [80, 0, 0, 60, 100, 500] }], null); // 11
    expect(filters(s, 1)).toContain(null);
    const working = docOf(s), now = fingerprint(s);
    expect(s.pdfaCheck().blockers).toEqual([]);
    expect(docOf(s)).not.toBe(working);
    expect(filters(s, 1)).toEqual(["FlateDecode", "CCITTFaxDecode", "FlateDecode", "FlateDecode"]);
    // ...and it is the same document: it reads and draws the same, saves, undoes and redoes.
    expect(fingerprint(s)).toEqual(now);
    expect(s.save({ format: "pdfa-2b", password: { mode: "none" } }).pdfa?.blockers).toEqual([]);
    expect(s.undo().changedPages).toEqual([1]);
    expect(s.redo().editCount).toBe(11);
    expect(fingerprint(s)).toEqual(now);
    s.close();
  });
});

describe("the field index forms.ts keeps", () => {
  it("is dropped whenever the working document changes or is replaced, and kept while it is only read", () => {
    const s = open(buildForm());
    const saidChanged = (fn: () => unknown) => {
      told.docs = [];
      fn();
      return told.docs.map((d) => (d === docOf(s) ? "working" : d));
    };
    // Reading changes nothing: the index made at open serves every listing.
    const readAll = () => {
      for (const p of [0, 1]) {
        s.fields(p);
        s.lines(p);
        s.images(p);
        s.addedTexts(p);
        s.render(p, 0.25);
      }
    };
    expect(saidChanged(readAll)).toEqual([]);
    // Every new edit, of every kind, on the working document.
    const edits: (() => unknown)[] = [
      () => s.setField("nome", text("Mario")),
      () => s.addText(0, [115, 142], "Mario Rossi", SANS),
      () => s.editAddedText(0, 1, { text: "Maria Rossi" }),
      () => s.replaceLine(0, lineIndex(s, 0, "Footer line"), "Footer"),
      () => s.addImage(signaturePng(), [{ pageIndex: 0, matrix: [100, 0, 0, 30, 320, 600] }], null),
      () => s.transformImage(0, 0, moved(s.images(0)[0].matrix, 5, 5)),
      () => s.deleteImage(0, 1),
    ];
    for (const edit of edits) expect(saidChanged(edit)).toEqual(["working"]);
    // The eighth takes a checkpoint and carries on with it: the edited document, then that one.
    const before = docOf(s);
    expect(saidChanged(() => s.setField("citta", choice("Roma")))).toEqual([before, "working"]);
    expect(docOf(s)).not.toBe(before);
    // Undo rebuilds from the original: the seven edits before replayed, then the rebuilt document in place.
    expect(saidChanged(() => s.undo())).toEqual(Array(7 + 1).fill("working"));
    expect(saidChanged(() => s.redo())).toEqual(["working"]);
    // A save carries on with its snapshot; reading after it still changes nothing.
    expect(saidChanged(() => s.save())).toEqual(["working"]);
    expect(saidChanged(readAll)).toEqual([]);
    // A failed edit is rolled back on a rebuilt document.
    const t = open(unappendable());
    const was = docOf(t);
    told.docs = [];
    expectSessionError(() => t.addText(0, [20, 100], "Mario", SANS), "not-editable");
    expect(docOf(t)).not.toBe(was);
    expect(told.docs.length).toBe(1);
    expect(told.docs[0]).toBe(docOf(t));
    t.close();
    s.close();
  });
});

describe("saving a filled and signed form", () => {
  it("as a normal PDF and as PDF/A-2b: values, written lines and the signature read back, and stay editable", () => {
    const s = new EngineSession(mupdf);
    const info = s.open(buildForm());
    // (the radio group's two widgets are two of the eight on page 1; the fields to fill are five:
    // not the read-only one, nor the signature field)
    expect(info.ok && info.form).toEqual({ fieldsPerPage: [8, 1], fields: 5, required: 0, xfa: "none", scripts: false });
    s.setField("nome", text("Zażółć gęślą jaźń"));
    s.setField("privacy", state("Si"));
    s.setField("sesso", state("M"));
    s.setField("citta", choice("Forlì"));
    s.setField("intestazione", text("Ufficio anagrafe – Città di Forlì"));
    s.addText(0, [115, 142], "Mario Rossi", SANS);
    s.addText(0, [131.5, 172], "✓", SANS);
    s.addText(0, [320, 650], "16/10/2026", { ...SANS, color: BLUE });
    s.addImage(signaturePng(), [{ pageIndex: 0, matrix: [150, 0, 0, 40, 320, 597] }], "Firma: Mario Rossi");
    s.addImage(pictureFile("jpeg", 40, 20, () => [30, 30, 30]), [0, 1].map((p) => ({ pageIndex: p, matrix: [40, 0, 0, 20, 520, 800] as Matrix })), null);

    const check = (bytes: ArrayBuffer) => {
      const t = open(new Uint8Array(bytes));
      const values = Object.fromEntries([0, 1].flatMap((p) => t.fields(p)).map((f) => [f.name, f.value]));
      expect(values).toMatchObject({
        nome: "Zażółć gęślą jaźń", privacy: "Si", sesso: "M", citta: "Forlì", intestazione: "Ufficio anagrafe – Città di Forlì", codice: "ABC123",
      });
      expect(t.addedTexts(0).map((x) => x.text)).toEqual(["Mario Rossi", "✓", "16/10/2026"]);
      expect(lineWith(t.lines(0), "16/10/2026").added).toBe(true);
      expect(t.images(0).filter((i) => i.added)).toHaveLength(2);
      expect(t.images(1).map((i) => [i.added, i.movable])).toEqual([[true, true]]);
      // Still editable in a new session: the written line in its block, the field again.
      t.replaceLine(0, lineWith(t.lines(0), "16/10/2026").index, "17/10/2026");
      expect(t.edits().at(-1)!.kind).toBe("editAdded");
      t.setField("nome", text("Mario Rossi"));
      expect(t.fields(0).find((f) => f.name === "nome")!.value).toBe("Mario Rossi");
      t.close();
    };

    check(s.save().bytes);
    const report = s.pdfaCheck();
    expect(report.blockers).toEqual([]);
    const saved = s.save({ format: "pdfa-2b", password: { mode: "none" } });
    expect(saved.pdfa?.blockers).toEqual([]);
    keepConverted("fill-session-signed-form", saved.bytes);
    const reopened = new EngineSession(mupdf);
    const opened = reopened.open(new Uint8Array(saved.bytes));
    expect(opened.ok && opened.pdfa).toBe("2B");
    reopened.close();
    check(saved.bytes);
    // The working document is untouched by the saves: more edits and another save work.
    s.editAddedText(0, 1, { text: "Maria Rossi" });
    const third = open(new Uint8Array(s.save().bytes));
    expect(third.addedTexts(0).map((x) => x.text)).toContain("Maria Rossi");
    third.close();
    s.close();
  });
});
