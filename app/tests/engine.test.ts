// EngineSession in Node, on the same mupdf build the worker uses (1.27.0).
// Fixtures come from the prototype (prototypes/mupdf-text/fixtures on the prototype branch).
import { readFileSync } from "node:fs";
import * as mupdf from "mupdf";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { countStructElems } from "../src/engine/core.js";
import type { LineInfo, Rect } from "../src/engine/protocol";
import {
  CHECKPOINT_EVERY,
  MAX_CHECKPOINTS,
  EngineSession,
  MAX_RENDER_PIXELS,
  MAX_RENDER_SIDE,
  SessionError,
  fitScale,
  type RenderPixels,
} from "../src/engine/session";

/**
 * core.replaceText, as the session sees it, counted (one call per edit applied or replayed) and
 * able to fail: "always" throws before editing, "after" lets one edit change the document and
 * then throws, as an edit that fails half way would. `last` is what the latest call returned.
 */
const replaceTextSpy = vi.hoisted(() => ({
  calls: 0,
  fail: "no" as "no" | "always" | "after",
  last: null as { toUnicodeAdded: number; widthsAdded: number } | null,
}));
vi.mock("../src/engine/core.js", async (importOriginal) => {
  const core = await importOriginal<typeof import("../src/engine/core.js")>();
  return {
    ...core,
    replaceText(...args: Parameters<typeof core.replaceText>) {
      replaceTextSpy.calls++;
      if (replaceTextSpy.fail === "always") throw new Error("injected failure");
      const result = core.replaceText(...args);
      replaceTextSpy.last = result;
      if (replaceTextSpy.fail === "after") {
        replaceTextSpy.fail = "no";
        throw new Error("injected failure after a half-done edit");
      }
      return result;
    },
  };
});
beforeEach(() => {
  replaceTextSpy.calls = 0;
  replaceTextSpy.fail = "no";
  replaceTextSpy.last = null;
});

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

/** A PDF made here with MuPDF. */
function makePdf(build: (doc: mupdf.PDFDocument) => void): Uint8Array {
  const doc = new mupdf.PDFDocument();
  try {
    build(doc);
    const buf = doc.saveToBuffer("");
    try {
      return buf.asUint8Array().slice();
    } finally {
      buf.destroy();
    }
  } finally {
    doc.destroy();
  }
}

/** A session with `name` open (throws if it does not open). */
function session(name: string, password?: string) {
  const s = new EngineSession(mupdf);
  const r = s.open(fixture(name), password);
  if (!r.ok) throw new Error(`${name} did not open: ${r.reason}`);
  return s;
}

/** A fresh session on saved bytes: what another viewer would see. */
function reopen(bytes: ArrayBuffer) {
  const s = new EngineSession(mupdf);
  const r = s.open(bytes);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.encrypted).toBe(false);
  return s;
}

function lineWith(lines: LineInfo[], needle: string): LineInfo {
  const line = lines.find((l) => l.text.includes(needle));
  if (!line) throw new Error(`no line contains "${needle}"`);
  return line;
}

const texts = (s: EngineSession, page = 0) => s.lines(page).map((l) => l.text.trim());

/** The saved file has no encryption dictionary and needs no password. */
function expectUnencrypted(bytes: ArrayBuffer) {
  const doc = mupdf.Document.openDocument(new Uint8Array(bytes), "application/pdf").asPDF()!;
  try {
    expect(doc.needsPassword()).toBe(false);
    expect(doc.getTrailer().get("Encrypt").isNull()).toBe(true);
  } finally {
    doc.destroy();
  }
}

/** Where a line starts along its writing direction, and its extent across it. */
function baselineEdges(line: LineInfo) {
  const [x0, y0, x1, y1] = line.bbox;
  const corners = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]];
  const [dx, dy] = line.dir;
  const along = corners.map(([x, y]) => x * dx + y * dy);
  const across = corners.map(([x, y]) => -x * dy + y * dx);
  return { start: Math.min(...along), acrossMin: Math.min(...across), acrossMax: Math.max(...across) };
}

const grow = (r: Rect, d: number): Rect => [r[0] - d, r[1] - d, r[2] + d, r[3] + d];
const union = (a: Rect, b: Rect): Rect => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];

/** Pixels that differ (any channel by more than 40) outside `areas` (page space, points). */
function pixelsChangedOutside(a: RenderPixels, b: RenderPixels, areas: Rect[] = []) {
  expect([b.width, b.height, b.scale]).toEqual([a.width, a.height, a.scale]);
  let changed = 0;
  for (let y = 0; y < a.height; y++) {
    const py = (y + 0.5) / a.scale;
    for (let x = 0; x < a.width; x++) {
      const px = (x + 0.5) / a.scale;
      if (areas.some((r) => px >= r[0] && px <= r[2] && py >= r[1] && py <= r[3])) continue;
      const i = (y * a.width + x) * 4;
      if (Math.abs(a.rgba[i] - b.rgba[i]) > 40 || Math.abs(a.rgba[i + 1] - b.rgba[i + 1]) > 40 || Math.abs(a.rgba[i + 2] - b.rgba[i + 2]) > 40)
        changed++;
    }
  }
  return changed;
}

function expectSessionError(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(SessionError);
    expect((err as SessionError).code).toBe(code);
    return;
  }
  throw new Error(`expected a SessionError "${code}"`);
}

describe("open", () => {
  it("reports pages, bounds, title and encryption", () => {
    const s = new EngineSession(mupdf);
    const r = s.open(fixture("chrome-subset.pdf"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pageCount).toBe(1);
    expect(r.encrypted).toBe(false);
    expect(r.title).toBeNull();
    expect(r.pages[0].index).toBe(0);
    expect(r.pages[0].bounds[0]).toBe(0);
    expect(r.pages[0].bounds[1]).toBe(0);
    expect(r.pages[0].bounds[2]).toBeCloseTo(594.96, 1);
    expect(r.pages[0].bounds[3]).toBeCloseTo(841.92, 1);

    // Re-opening replaces the document; /Rotate 90 + offset CropBox are applied to the bounds.
    const r2 = s.open(fixture("reportlab-form.pdf"));
    expect(r2.ok && r2.pageCount).toBe(2);
    if (!r2.ok) return;
    expect(r2.title).toBe("Fattura di prova");
    expect(r2.pages[1].bounds).toEqual([0, 0, 565, 520]);
    expect(s.edits()).toEqual([]);
  });

  it("asks for a password, rejects a wrong one, accepts the right one", () => {
    const s = new EngineSession(mupdf);
    expect(s.open(fixture("enc-user-aes128.pdf"))).toEqual({ ok: false, reason: "password-required" });
    expectSessionError(() => s.lines(0), "no-document");
    expect(s.open(fixture("enc-user-aes128.pdf"), "sbagliata")).toEqual({ ok: false, reason: "wrong-password" });
    const r = s.open(fixture("enc-user-aes128.pdf"), "utente");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.encrypted).toBe(true);
    expect(texts(s)).toContain("Condizioni");
  });

  it("reports a damaged file", () => {
    const s = new EngineSession(mupdf);
    const r = s.open(new TextEncoder().encode("this is not a PDF at all"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("damaged");
    expectSessionError(() => s.render(0, 1), "no-document");
  });

  it("keeps its own copy of the bytes", () => {
    const bytes = fixture("chrome-subset.pdf");
    const s = new EngineSession(mupdf);
    expect(s.open(bytes).ok).toBe(true);
    bytes.fill(0); // the caller reuses its buffer
    s.replaceLine(0, lineWith(s.lines(0), "Note").index, "Appunti");
    s.undo(); // re-opens the original from the session's copy
    expect(texts(s)).toContain("Note");
    expect(reopen(s.save().bytes).lines(0).length).toBe(9);
  });

  it("keeps a transferred buffer as it is, without a copy", () => {
    const originalOf = (s: EngineSession) => (s as unknown as { original: Uint8Array }).original;
    const bytes = fixture("chrome-subset.pdf");
    const copied = new EngineSession(mupdf);
    expect(copied.open(bytes).ok).toBe(true);
    expect(originalOf(copied).buffer).not.toBe(bytes.buffer);

    const s = new EngineSession(mupdf);
    expect(s.open(bytes.buffer, undefined, { transfer: true }).ok).toBe(true);
    expect(originalOf(s).buffer).toBe(bytes.buffer);
    s.replaceLine(0, lineWith(s.lines(0), "Note").index, "Appunti");
    s.undo(); // re-opens the original from that buffer
    expect(texts(s)).toContain("Note");
  });
});

describe("render", () => {
  it("renders RGBA at the requested scale", () => {
    const s = session("chrome-subset.pdf");
    const r = s.render(0, 1);
    expect([r.width, r.height, r.scale]).toEqual([595, 842, 1]);
    expect(r.rgba.length).toBe(r.width * r.height * 4);
    let ink = 0;
    for (let i = 0; i < r.rgba.length; i += 4) if (r.rgba[i] < 128) ink++;
    expect(ink).toBeGreaterThan(1000); // there is text on it
    expect(r.rgba[3]).toBe(255); // opaque
  });

  it("lowers the scale to stay within the iOS canvas limit", () => {
    const s = session("chrome-subset.pdf");
    const r = s.render(0, 40);
    expect(r.width * r.height).toBeLessThanOrEqual(MAX_RENDER_PIXELS);
    expect(r.width * r.height).toBeGreaterThan(MAX_RENDER_PIXELS * 0.99);
    expect(r.scale).toBeLessThan(40);
    expect(r.width).toBe(Math.ceil(594.96 * r.scale));
  });

  it("keeps each side within the browsers' canvas limit of 32,767 px", () => {
    // A 200 x 14,400 pt page (the largest a PDF page may be) at fit-width on a wide screen:
    // the pixel cap alone would allow 471 x 33,941 px, too tall for a canvas.
    const long = makePdf((doc) => doc.insertPage(-1, doc.addPage([0, 0, 200, 14_400], 0, {}, "")));
    const s = new EngineSession(mupdf);
    expect(s.open(long).ok).toBe(true);
    const r = s.render(0, 10);
    expect(r.height).toBeLessThanOrEqual(MAX_RENDER_SIDE);
    expect(r.height).toBeGreaterThan(MAX_RENDER_SIDE * 0.99);
    expect(r.width).toBe(Math.ceil(200 * r.scale));
    expect(r.width * r.height).toBeLessThanOrEqual(MAX_RENDER_PIXELS);
    expect(r.rgba.length).toBe(r.width * r.height * 4);
    // The same page turned sideways, and a small page that stays at the scale asked for.
    expect(Math.ceil(14_400 * fitScale([0, 0, 14_400, 200], 10))).toBeLessThanOrEqual(MAX_RENDER_SIDE);
    expect(fitScale([0, 0, 595, 842], 2)).toBe(2);
  });

  it("rejects bad requests", () => {
    const s = session("chrome-subset.pdf");
    expectSessionError(() => s.render(1, 1), "bad-request");
    expectSessionError(() => s.render(0, 0), "bad-request");
    expectSessionError(() => s.render(0, Number.NaN), "bad-request");
    expectSessionError(() => s.lines(-1), "bad-request");
    expectSessionError(() => s.replaceLine(0, 99, "x"), "bad-request");
  });
});

describe("lines", () => {
  it("lists the lines of chrome-subset.pdf with their style", () => {
    const s = session("chrome-subset.pdf");
    const lines = s.lines(0);
    expect(lines.map((l) => l.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(lines[0].text).toBe("Preventivo n. 2026/118");
    expect(lines[1].text).toBe("Il prezzo concordato è di 1.250 € – l’offerta “speciale” è valida perché già approvata.");
    const title = lines[0];
    expect(title.fontName).toBe("Calibri-Bold"); // subset tag removed
    expect(title.bold).toBe(true);
    expect(title.vertical).toBe(false);
    expect(title.dir).toEqual([1, 0]);
    expect(title.size).toBeGreaterThan(20);
    expect(title.bbox[0]).toBeCloseTo(62, 0);
    expect(title.bbox[1]).toBeCloseTo(74.4, 0);
    const georgia = lineWith(lines, "venerdì");
    expect(georgia.fontName).toBe("Georgia");
    expect(georgia.serif).toBe(true);
    expect(lineWith(lines, "Codice").mono).toBe(true);
    for (const l of lines) {
      expect(l.editable).toBe(true);
      expect(l.color).toHaveLength(3);
      for (const c of l.color) expect(c >= 0 && c <= 1).toBe(true);
      expect(l.bbox[2]).toBeGreaterThan(l.bbox[0]);
      expect(l.bbox[3]).toBeGreaterThan(l.bbox[1]);
    }
  });

  it("leaves out whitespace-only lines", () => {
    const s = session("word-winansi.pdf");
    const lines = s.lines(0);
    expect(lines.length).toBe(5); // MuPDF sees 6: the last one is a lone space
    expect(lines.map((l) => l.index)).toEqual([0, 1, 2, 3, 4]);
    expect(lines.every((l) => l.text.trim() !== "")).toBe(true);
  });

  it("marks a line with a character outside the BMP as not editable and refuses to edit it", () => {
    // Helvetica drawing "x", which /ToUnicode maps to U+1D465 (mathematical italic small x).
    const toUnicode = [
      "/CIDInit /ProcSet findresource begin 12 dict begin begincmap",
      "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
      "/CMapName /Adobe-Identity-UCS def /CMapType 2 def",
      "1 begincodespacerange <00> <FF> endcodespacerange",
      "2 beginbfrange <20> <77> <0020> <79> <7E> <0079> endbfrange",
      "1 beginbfchar <78> <D835DC65> endbfchar",
      "endcmap CMapName currentdict /CMap defineresource pop end end",
    ].join("\n");
    const pdf = makePdf((doc) => {
      const font = doc.addObject({
        Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding",
        ToUnicode: doc.addStream(toUnicode, {}),
      });
      const contents = "BT /F1 24 Tf 72 700 Td (Sia x = 2) Tj ET\nBT /F1 24 Tf 72 600 Td (Riga normale) Tj ET\n";
      doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { Font: { F1: font } }, contents));
    });
    const s = new EngineSession(mupdf);
    expect(s.open(pdf).ok).toBe(true);
    const [math, plain] = s.lines(0);
    // What MuPDF.js 1.27 reports: U+1D465 cut to its low 16 bits, U+D465, a Hangul syllable.
    expect(math.text).toBe("Sia \u{d465} = 2");
    expect(math.editable).toBe(false);
    expect(plain).toMatchObject({ text: "Riga normale", editable: true });

    const before = s.render(0, 1);
    expectSessionError(() => s.replaceLine(0, math.index, "Sia y = 2"), "not-editable");
    expect(replaceTextSpy.calls).toBe(0);
    expect(s.edits()).toEqual([]);
    expect(pixelsChangedOutside(before, s.render(0, 1))).toBe(0);

    // The other line is edited as usual, and the first stays locked.
    s.replaceLine(0, plain.index, "Riga nuova");
    expect(texts(s)).toContain("Riga nuova");
    expect(lineWith(s.lines(0), "Sia").editable).toBe(false);
  });
});

describe("replaceLine and save", () => {
  it("replaces a line with typographic characters, saves without encryption", () => {
    const s = session("chrome-subset.pdf");
    const old = lineWith(s.lines(0), "prezzo");
    const text = "Il costo “finale” è di 1.250 € – l’offerta è già approvata.";
    const r = s.replaceLine(0, old.index, text);
    expect(r).toMatchObject({
      pageIndex: 0, before: old.text, after: text,
      editCount: 1, canUndo: true, canRedo: false, changedPages: [0], missingChars: [],
    });
    expect(r.segments.map((x) => x.text).join("")).toBe(text);
    expect(r.segments[0].source).toBe("original");
    expect(r.segments[0].fontName).toBe("Calibri");
    expect(texts(s)).toContain(text);

    const saved = s.save().bytes;
    expectUnencrypted(saved);
    const after = texts(reopen(saved));
    expect(after).toContain(text);
    expect(after).not.toContain(old.text);
    expect(after.join("\n")).not.toContain("prezzo");
    expect(after).toContain("Condizioni"); // the rest is still there
    expect(after.length).toBe(9);
  });

  it("undo restores the original, redo re-applies", () => {
    const s = session("chrome-subset.pdf");
    const before = s.lines(0);
    const text = "Il costo concordato è di 1.250 €.";
    s.replaceLine(0, lineWith(before, "prezzo").index, text);
    expect(s.undo()).toEqual({ editCount: 0, canUndo: false, canRedo: true, changedPages: [0] });
    expect(s.lines(0)).toEqual(before); // exactly the original lines again
    expect(s.redo()).toEqual({ editCount: 1, canUndo: true, canRedo: false, changedPages: [0] });
    expect(texts(s)).toContain(text);
    expect(texts(s).join("\n")).not.toContain("prezzo");
    // Nothing left to redo / undo: no-ops that report the state.
    expect(s.redo()).toEqual({ editCount: 1, canUndo: true, canRedo: false, changedPages: [] });
    s.undo();
    expect(s.undo()).toEqual({ editCount: 0, canUndo: false, canRedo: true, changedPages: [] });
    expect(texts(reopen(s.save().bytes))).toEqual(before.map((l) => l.text.trim()));
  });

  it("two edits, undo one", () => {
    const s = session("chrome-subset.pdf");
    s.replaceLine(0, lineWith(s.lines(0), "prezzo").index, "Il costo è di 1.250 €.");
    const r2 = s.replaceLine(0, lineWith(s.lines(0), "Milano").index, "Firmato: Direzione — Forlì");
    expect(r2.editCount).toBe(2);
    expect(s.undo()).toMatchObject({ editCount: 1, canUndo: true, canRedo: true });
    let t = texts(s);
    expect(t).toContain("Il costo è di 1.250 €.");
    expect(t).toContain("Firmato: Ufficio Commerciale — Milano");
    expect(s.edits()).toHaveLength(1);

    // A new edit clears the redo stack.
    const r3 = s.replaceLine(0, lineWith(s.lines(0), "Note").index, "Appunti");
    expect(r3).toMatchObject({ editCount: 2, canRedo: false });
    expect(s.redo().changedPages).toEqual([]);
    t = texts(reopen(s.save().bytes));
    expect(t).toContain("Il costo è di 1.250 €.");
    expect(t).toContain("Firmato: Ufficio Commerciale — Milano");
    expect(t).toContain("Appunti");
    expect(t).not.toContain("Note");
  });

  it("the same text is a no-op: nothing logged, redo kept", () => {
    const s = session("chrome-subset.pdf");
    s.replaceLine(0, lineWith(s.lines(0), "Note").index, "Appunti");
    s.undo();
    const line = lineWith(s.lines(0), "Condizioni");
    const r = s.replaceLine(0, line.index, "  Condizioni ");
    expect(r).toMatchObject({ editCount: 0, canRedo: true, changedPages: [], before: "Condizioni", after: "Condizioni", segments: [] });
    expect(s.edits()).toEqual([]);
  });

  it("empty text deletes the line", () => {
    const s = session("chrome-subset.pdf");
    const before = texts(s);
    const r = s.replaceLine(0, lineWith(s.lines(0), "Seconda sezione").index, "   ");
    expect(r).toMatchObject({ after: "", segments: [], fallbackChars: [], missingChars: [], editCount: 1, changedPages: [0] });
    const expected = before.filter((t) => !t.startsWith("Seconda sezione"));
    expect(texts(s)).toEqual(expected);
    expect(texts(reopen(s.save().bytes))).toEqual(expected);
    s.undo();
    expect(texts(s)).toEqual(before);
  });

  it("deleting a line of a tagged PDF adds no structure element", () => {
    const structElems = (bytes: Uint8Array | ArrayBuffer) => {
      const doc = mupdf.Document.openDocument(new Uint8Array(bytes), "application/pdf").asPDF()!;
      try {
        return countStructElems(doc);
      } finally {
        doc.destroy();
      }
    };
    const s = session("word-winansi.pdf");
    const before = texts(s);
    s.replaceLine(0, lineWith(s.lines(0), "Gentile cliente").index, "");
    const saved = s.save().bytes;
    expect(texts(reopen(saved))).toEqual(before.filter((t) => !t.startsWith("Gentile cliente")));
    expect(structElems(saved)).toBe(structElems(fixture("word-winansi.pdf")));
    // A replacement on the same tagged page does get its /Span.
    s.replaceLine(0, lineWith(s.lines(0), "Capitolo secondo").index, "Capitolo terzo");
    expect(structElems(s.save().bytes)).toBe(structElems(fixture("word-winansi.pdf")) + 1);
  });

  it("edits the right line when its text also occurs in an earlier line", () => {
    const s = session("chrome-subset.pdf");
    // Edited lines are appended to the content stream, so they come last in the line order.
    s.replaceLine(0, lineWith(s.lines(0), "Note").index, "Note di consegna");
    s.replaceLine(0, lineWith(s.lines(0), "Condizioni").index, "Note");
    const lines = s.lines(0);
    const target = lines[lines.length - 1];
    expect(target.text).toBe("Note");
    expect(lines.findIndex((l) => l.text.includes("Note"))).toBeLessThan(target.index);
    s.replaceLine(0, target.index, "Nota");
    expect(s.edits()[2]).toMatchObject({ find: "Note", occurrence: 1 });
    const t = texts(s);
    expect(t).toContain("Note di consegna");
    expect(t).toContain("Nota");
    expect(t).not.toContain("Note");
    // Replaying the log (undo + redo) reaches the same state.
    s.undo();
    s.redo();
    expect(texts(s)).toEqual(t);
  });

  it("reports characters drawn with a fallback font", () => {
    const s = session("chrome-subset.pdf");
    const r = s.replaceLine(0, lineWith(s.lines(0), "Note").index, "Note Ω");
    expect(r.fallbackChars).toEqual(["Ω"]);
    expect(r.missingChars).toEqual([]);
    expect(r.segments.find((x) => x.source === "fallback")?.text).toBe("Ω");
    expect(r.segments[0]).toMatchObject({ text: "Note ", source: "original", fontName: "Calibri-Bold" });
    expect(texts(reopen(s.save().bytes))).toContain("Note Ω");
  });

  it("works on a password-protected file; the saved copy opens without password", () => {
    const s = session("enc-user-aes128.pdf", "utente");
    const original = s.lines(0);
    const text = "Il costo concordato è di 1.250 €.";
    s.replaceLine(0, lineWith(original, "prezzo").index, text);
    const saved = s.save().bytes;
    expectUnencrypted(saved);
    expect(texts(reopen(saved))).toContain(text);
    s.undo(); // re-opens the encrypted original with the stored password
    expect(s.lines(0)).toEqual(original);
  });

  it("keeps the baseline on a /Rotate 90 page with an offset CropBox", () => {
    const s = session("chrome-rotate90-crop.pdf");
    const old = lineWith(s.lines(0), "prezzo");
    expect(old.dir).not.toEqual([1, 0]); // the text runs down the rotated page
    // Only glyphs of the original subset (no "f": the file has just the "ff" ligature), so the
    // line keeps Calibri's ascent and descent and its bbox can be compared across the baseline.
    const text = "Il costo concordato è di 1.250 € – è valido.";
    const r = s.replaceLine(0, old.index, text);
    expect(r.fallbackChars).toEqual([]);
    for (const lines of [s.lines(0), reopen(s.save().bytes).lines(0)]) {
      const now = lines.find((l) => l.text === text)!;
      expect(now).toBeDefined();
      expect(now.dir[0]).toBeCloseTo(old.dir[0], 3);
      expect(now.dir[1]).toBeCloseTo(old.dir[1], 3);
      const a = baselineEdges(old), b = baselineEdges(now);
      expect(Math.abs(b.start - a.start)).toBeLessThan(0.5);
      expect(Math.abs(b.acrossMin - a.acrossMin)).toBeLessThan(0.5);
      expect(Math.abs(b.acrossMax - a.acrossMax)).toBeLessThan(0.5);
      expect(now.size).toBeCloseTo(old.size, 2);
    }
  });

  // MuPDF 1.28.1 fails this: after two edits on a page with Type3 fonts the second redaction
  // shifted a neighbouring label by 36 pt. Keep it when upgrading MuPDF.
  it("Type3 regression guard: two edits on a matplotlib chart move nothing else", () => {
    const s = session("type3-matplotlib.pdf");
    const scale = 2;
    const before = s.render(0, scale);
    const areas: Rect[] = [];
    for (const [needle, text] of [["Vendite", "Ricavi per città – anno 2026"], ["Milano", "Roma"]]) {
      const old = lineWith(s.lines(0), needle);
      s.replaceLine(0, old.index, text);
      const now = s.lines(0).find((l) => l.text.trim() === text);
      expect(now).toBeDefined();
      areas.push(grow(union(old.bbox, now!.bbox), 2));
    }
    expect(pixelsChangedOutside(before, s.render(0, scale), areas)).toBe(0);
    const saved = reopen(s.save().bytes);
    expect(pixelsChangedOutside(before, saved.render(0, scale), areas)).toBe(0);
    // ...and inside the edited areas something did change.
    expect(pixelsChangedOutside(before, saved.render(0, scale))).toBeGreaterThan(0);
    const t = texts(saved);
    expect(t).toContain("Ricavi per città – anno 2026");
    expect(t).toContain("Roma");
    expect(t).toContain("Forlì");
    expect(t).not.toContain("Milano");
  });

  it("save does not change the working document", () => {
    const s = session("chrome-subset.pdf");
    const r1 = s.replaceLine(0, lineWith(s.lines(0), "Note").index, "Note Ω"); // a fallback font
    const fallbackFont = r1.segments.find((x) => x.source === "fallback")?.fontName;
    expect(fallbackFont).toBeTruthy();
    const beforeSave = s.render(0, 2);
    const first = s.save().bytes;
    expect(pixelsChangedOutside(beforeSave, s.render(0, 2))).toBe(0);

    // More glyphs of the same fallback font. Had the first save subset the working document's
    // copy of it, the editor would now draw them from a subset without them (empty glyphs).
    const r = s.replaceLine(0, lineWith(s.lines(0), "Condizioni").index, "Condizioni Σ Δ Ω");
    expect(r.fallbackChars).toEqual(["Σ", "Δ", "Ω"]);
    expect(new Set(r.segments.filter((x) => x.source === "fallback").map((x) => x.fontName))).toEqual(new Set([fallbackFont]));
    const shown = s.render(0, 2); // what the editor shows before saving again
    const second = s.save().bytes;

    const t1 = texts(reopen(first));
    expect(t1).toContain("Note Ω");
    expect(t1).toContain("Condizioni");
    const saved2 = reopen(second);
    const t2 = texts(saved2);
    expect(t2).toContain("Note Ω");
    expect(t2).toContain("Condizioni Σ Δ Ω");
    // The saved file draws exactly what the editor showed: no glyph lost to subsetting.
    expect(pixelsChangedOutside(shown, saved2.render(0, 2))).toBe(0);
  });

  it("close forgets the document", () => {
    const s = session("chrome-subset.pdf");
    expect(s.close()).toBeNull();
    expectSessionError(() => s.save(), "no-document");
    expectSessionError(() => s.undo(), "no-document");
    expect(s.close()).toBeNull();
  });
});

/**
 * Word's Identity-H subsets hold glyphs their /ToUnicode does not list ("r" of Calibri-Bold in
 * word-winansi.pdf, "l" and "r" of Aptos in word-images.pdf). An edit that uses one adds it to the
 * font's /ToUnicode and /W. MuPDF keeps the fonts it has loaded, so unless it loads this one again
 * the working document reads U+FFFD for those codes, the line editor opens with it, and the next
 * edit of the line writes it into the file for good.
 */
describe("an edit that extends a font's /ToUnicode and /W", () => {
  const cases = [
    { name: "word-winansi.pdf", line: "Relazione tecnica" },
    { name: "word-images.pdf", line: "Images in a Word PDF" },
  ];
  const text = "hello world, fill";

  /** `s` after the edit, which must have changed the font (else the case proves nothing). */
  function extendFont(name: string, line: string) {
    const s = session(name);
    s.replaceLine(0, lineWith(s.lines(0), line).index, text);
    expect(replaceTextSpy.last!.toUnicodeAdded).toBeGreaterThan(0);
    expect(replaceTextSpy.last!.widthsAdded).toBeGreaterThan(0);
    return s;
  }

  for (const c of cases) {
    it(`the working document reads and draws the new line as the saved file does (${c.name})`, () => {
      const s = extendFont(c.name, c.line);
      const live = texts(s);
      expect(live).toContain(text);
      expect(live.join("\n")).not.toContain("�");
      const shown = s.render(0, 2); // the old widths would place glyphs elsewhere
      const saved = reopen(s.save().bytes);
      expect(texts(saved)).toEqual(live);
      expect(pixelsChangedOutside(shown, saved.render(0, 2))).toBe(0);
    });

    it(`a second edit of that line writes no U+FFFD into the download (${c.name})`, () => {
      const s = extendFont(c.name, c.line);
      const line = lineWith(s.lines(0), "hello");
      // What the line editor opens with, plus one more change.
      const r = s.replaceLine(0, line.index, line.text.replace("fill", "full!"));
      expect(r.before).toBe(text);
      expect(r.fallbackChars).not.toContain("�");
      const saved = texts(reopen(s.save().bytes));
      expect(saved).toContain("hello world, full!");
      expect(saved.join("\n")).not.toContain("�");
    });
  }

  it("undo and redo agree with the working document across the checkpoint after it", () => {
    const s = session("word-winansi.pdf");
    // CHECKPOINT_EVERY - 1 edits of another line first, so that the checkpoint (bytes re-opened
    // later, where the font is loaded afresh) is taken right after the edit that extends the font.
    for (let i = 1; i < CHECKPOINT_EVERY; i++)
      s.replaceLine(0, lineWith(s.lines(0), i === 1 ? "Capitolo secondo" : `Capitolo ${i}`).index, `Capitolo ${i + 1}`);
    s.replaceLine(0, lineWith(s.lines(0), "Relazione tecnica").index, text);
    expect(replaceTextSpy.last!.toUnicodeAdded).toBeGreaterThan(0);
    const extended = texts(s);
    const line = lineWith(s.lines(0), "hello");
    s.replaceLine(0, line.index, line.text.replace("fill", "full"));
    const edited = texts(s);
    expect(edited).toContain("hello world, full");

    replaceTextSpy.calls = 0;
    s.undo(); // exactly the checkpoint: nothing replayed
    expect(replaceTextSpy.calls).toBe(0);
    expect(texts(s)).toEqual(extended);
    s.redo(); // the last edit must find its line in the re-opened checkpoint
    expect(texts(s)).toEqual(edited);
    s.undo();
    s.undo(); // before the font changed: the original plus CHECKPOINT_EVERY - 1 edits
    s.redo();
    s.redo(); // the font changes again, then the last edit must find its line in the live document
    expect(texts(s)).toEqual(edited);
    expect(texts(reopen(s.save().bytes))).toEqual(edited);
  });
});

/**
 * Edit `i` of a chain that rewrites one line again and again: "Condizioni" becomes "Versione 1",
 * that becomes "Versione 2"...
 */
function version(s: EngineSession, i: number) {
  s.replaceLine(0, lineWith(s.lines(0), i === 1 ? "Condizioni" : `Versione ${i - 1}`).index, `Versione ${i}`);
}

function versions(s: EngineSession, from: number, to: number) {
  for (let i = from; i <= to; i++) version(s, i);
}

describe("history checkpoints", () => {
  it("undo after 30 edits replays only the edits since the nearest checkpoint", () => {
    const s = session("chrome-subset.pdf");
    const states: string[][] = [texts(s)]; // the page's text after each number of edits
    const shown: RenderPixels[] = [];
    for (let i = 1; i <= 30; i++) {
      version(s, i);
      states[i] = texts(s);
      if (i >= 20) shown[i] = s.render(0, 1);
    }
    expect(replaceTextSpy.calls).toBe(30);
    for (let n = 29; n >= 20; n--) {
      replaceTextSpy.calls = 0;
      expect(s.undo().editCount).toBe(n);
      // The checkpoint after 24 (or 16) edits, plus the edits after it: never all 30.
      expect(replaceTextSpy.calls).toBe(n % CHECKPOINT_EVERY);
      expect(texts(s)).toEqual(states[n]);
      expect(pixelsChangedOutside(shown[n], s.render(0, 1))).toBe(0);
    }
    replaceTextSpy.calls = 0;
    expect(s.redo().editCount).toBe(21); // applied to the working document: one call
    expect(replaceTextSpy.calls).toBe(1);
    expect(texts(s)).toEqual(states[21]);

    // Save replays nothing either.
    replaceTextSpy.calls = 0;
    const saved = s.save().bytes;
    expect(replaceTextSpy.calls).toBe(0);
    expect(texts(reopen(saved))).toEqual(states[21]);
  });

  it("a new edit after undo drops the checkpoints beyond it", () => {
    const s = session("chrome-subset.pdf");
    versions(s, 1, 17); // checkpoints after 8 and 16 edits
    s.undo();
    s.undo(); // 15 edits
    s.replaceLine(0, lineWith(s.lines(0), "Versione 15").index, "Ramo nuovo");
    s.replaceLine(0, lineWith(s.lines(0), "Note").index, "Appunti");
    // Back to 16 edits: the old checkpoint after 16 edits (with "Versione 16") must not be used.
    expect(s.undo().editCount).toBe(16);
    const t = texts(s);
    expect(t).toContain("Ramo nuovo");
    expect(t).toContain("Note");
    expect(t.join("\n")).not.toContain("Versione");
    expect(s.redo().editCount).toBe(17);
    expect(texts(s)).toContain("Appunti");
    expect(texts(reopen(s.save().bytes))).toEqual(texts(s));
  });

  it("checkpoints of a password-protected file re-open without the password", () => {
    const s = session("enc-user-aes128.pdf", "utente");
    const states: string[][] = [texts(s)];
    for (let i = 1; i <= 9; i++) {
      version(s, i);
      states[i] = texts(s);
    }
    replaceTextSpy.calls = 0;
    s.undo(); // from the checkpoint after 8 edits (written unencrypted)
    expect(replaceTextSpy.calls).toBe(0);
    expect(texts(s)).toEqual(states[8]);
    s.undo(); // from the encrypted original, with the password, + 7 edits
    expect(replaceTextSpy.calls).toBe(7);
    expect(texts(s)).toEqual(states[7]);
    s.redo();
    s.redo();
    expect(texts(s)).toEqual(states[9]);
    const saved = s.save().bytes;
    expectUnencrypted(saved);
    expect(texts(reopen(saved))).toEqual(states[9]);
  });

  it("fallback fonts carry over a checkpoint: reused by later edits, subset when saving", () => {
    const fallback = (r: { segments: { source: string; fontName: string }[] }) =>
      r.segments.find((x) => x.source === "fallback")?.fontName;
    const s = session("chrome-subset.pdf");
    // The CJK fallback font is embedded whole (about 3.5 MB) until the file is saved.
    const cjk = fallback(s.replaceLine(0, lineWith(s.lines(0), "Condizioni").index, "Condizioni 中"));
    expect(cjk).toBeTruthy();
    for (let i = 1; i <= 8; i++) s.replaceLine(0, lineWith(s.lines(0), i === 1 ? "Note" : `Note ${i - 1}`).index, `Note ${i}`);
    replaceTextSpy.calls = 0;
    s.undo(); // back to 8 edits: exactly the checkpoint, nothing replayed
    expect(replaceTextSpy.calls).toBe(0);

    // More glyphs of the same font, in the document re-opened from the checkpoint.
    expect(fallback(s.replaceLine(0, lineWith(s.lines(0), "Seconda sezione").index, "Seconda sezione 文"))).toBe(cjk);
    const shown = s.render(0, 2);
    const saved = s.save().bytes;
    // One copy of the font, subset to the glyphs used.
    expect(saved.byteLength).toBeLessThan(fixture("chrome-subset.pdf").byteLength + 200_000);
    const doc = mupdf.Document.openDocument(new Uint8Array(saved), "application/pdf").asPDF()!;
    try {
      const names: string[] = [];
      doc.findPage(0).get("Resources", "Font").forEach((v) => names.push(v.get("BaseFont").asName()));
      expect(names.filter((n) => n.includes(cjk!.replace(/^[A-Z]{6}\+/, "")))).toHaveLength(1);
    } finally {
      doc.destroy();
    }
    const again = reopen(saved);
    const t = texts(again);
    expect(t).toContain("Condizioni 中");
    expect(t).toContain("Seconda sezione 文");
    expect(t).toContain("Note 7");
    expect(pixelsChangedOutside(shown, again.render(0, 2))).toBe(0);
  });

  it("checkpoints are thinned out, not dropped oldest first: undo far back stays bounded", () => {
    const s = session("chrome-subset.pdf");
    versions(s, 1, 160); // 20 checkpoints taken, at most MAX_CHECKPOINTS kept
    const kept = (s as unknown as { checkpoints: { editCount: number }[] }).checkpoints.map((c) => c.editCount);
    expect(kept.length).toBeLessThanOrEqual(MAX_CHECKPOINTS);
    expect(kept[kept.length - 1]).toBe(160);
    const gaps = kept.map((n, i) => n - (i > 0 ? kept[i - 1] : 0));
    expect(Math.max(...gaps)).toBeLessThanOrEqual(3 * CHECKPOINT_EVERY);
    // Rebuilding the state after 50 edits starts from a checkpoint near 50, not from the original.
    replaceTextSpy.calls = 0;
    const rebuild = (s as unknown as { rebuild(n: number): mupdf.PDFDocument }).rebuild(50);
    rebuild.destroy();
    expect(replaceTextSpy.calls).toBeLessThan(3 * CHECKPOINT_EVERY);
    replaceTextSpy.calls = 0;
    s.undo();
    expect(replaceTextSpy.calls).toBeLessThan(CHECKPOINT_EVERY);
  });

  it("a fallback font reused as the line's own font keeps all its glyphs when saving", () => {
    const s = session("chrome-subset.pdf");
    // The first edit embeds the CJK fallback font; the second rewrites that line, and now the
    // fallback font is the line's "original" font, also for the Latin letters.
    s.replaceLine(0, lineWith(s.lines(0), "Condizioni").index, "中文 1");
    s.replaceLine(0, lineWith(s.lines(0), "中文 1").index, "Versione 2");
    const shown = s.render(0, 2);
    const again = reopen(s.save().bytes);
    expect(texts(again)).toContain("Versione 2");
    expect(pixelsChangedOutside(shown, again.render(0, 2))).toBe(0);
  });

  it("a failed edit or redo is rolled back from the nearest checkpoint", () => {
    const s = session("chrome-subset.pdf");
    versions(s, 1, 9); // checkpoint after 8 edits
    const before = texts(s);
    replaceTextSpy.calls = 0;
    replaceTextSpy.fail = "after";
    expectSessionError(() => s.replaceLine(0, lineWith(s.lines(0), "Note").index, "Appunti"), "edit-failed");
    expect(replaceTextSpy.calls).toBe(2); // the failed edit, then edit 9 replayed on the checkpoint
    expect(texts(s)).toEqual(before);
    expect(s.edits()).toHaveLength(9);

    s.undo();
    const undone = texts(s);
    replaceTextSpy.fail = "after";
    expectSessionError(() => s.redo(), "edit-failed");
    expect(texts(s)).toEqual(undone);
    expect(s.redo()).toMatchObject({ editCount: 9, canRedo: false });
    expect(texts(s)).toEqual(before);
    s.replaceLine(0, lineWith(s.lines(0), "Note").index, "Appunti");
    expect(texts(reopen(s.save().bytes))).toContain("Appunti");
  });

  it("when the rollback fails too, the session is broken until close or open", () => {
    const s = session("chrome-subset.pdf");
    s.replaceLine(0, lineWith(s.lines(0), "Note").index, "Appunti");
    replaceTextSpy.fail = "always"; // the edit fails, and so does replaying the first one
    expectSessionError(() => s.replaceLine(0, lineWith(s.lines(0), "Condizioni").index, "Patti"), "broken");
    replaceTextSpy.fail = "no";
    for (const request of [
      () => s.lines(0),
      () => s.render(0, 1),
      () => s.replaceLine(0, 0, "x"),
      () => s.undo(),
      () => s.redo(),
    ])
      expectSessionError(request, "broken");
    // Downloading still works: the last good state is rebuilt from the log...
    const saved = reopen(s.save().bytes);
    expect(texts(saved)).toContain("Appunti");
    expect(texts(saved)).toContain("Condizioni");
    // ...unless rebuilding keeps failing.
    replaceTextSpy.fail = "always";
    expectSessionError(() => s.save(), "broken");
    replaceTextSpy.fail = "no";
    expect(s.close()).toBeNull();
    expectSessionError(() => s.lines(0), "no-document");
    expect(s.open(fixture("chrome-subset.pdf")).ok).toBe(true);
    expect(texts(s)).toContain("Note");
  });
});
