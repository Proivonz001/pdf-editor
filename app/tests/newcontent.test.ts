// New content on a page (phase 3, release 3, "Compila e firma"): new lines of real text and new
// pictures (src/engine/newcontent.ts), and the picture-file checks release 3 adds to images.ts
// (metadata stripped, EXIF orientation), in Node on the worker's mupdf build (1.27.0).
//
// These run the engine modules directly on MuPDF documents, as the session will (an edit is a
// call on the working document, a replay the same calls on a fresh copy): the readback in MuPDF's
// structured text and search, the place on rotated and cropped pages, editing an added line in
// its own block, the redaction of a line edit not taking added text with it, what is appended to
// content that ends badly, tagging, the pictures' placements, and the round trip through a save.
// Ported from the release 3 prototype's tests (r3-research/new-content/tests).
import { readFileSync } from "node:fs";
import * as mupdf from "mupdf";
import { afterEach, describe, expect, it } from "vitest";
import {
  countStructElems, extractLines, fallbackFontState, markedContent, releaseFallbackFonts, renderPixmap, replaceText, restoreFallbackFonts,
  structParents, subsetFallbackFonts,
} from "../src/engine/core.js";
import { srgbProfile } from "../src/engine/icc";
import {
  BadPicture, ORIENTATION, checkPicture, concat, containFit, deletePlacement, findPlacements, invert, jpegOrientation, latin1, openImage,
  operations, replacePlacement, transformPlacement, withoutMetadata, writeStream, type Picture,
} from "../src/engine/images";
import {
  ContentError, MAX_ID, MAX_OPEN, addImage, addText, addedLineIds, addedTexts, appendProblem, endState, isClean, missingChars, pageBlocks,
  protectAdded, rewriteAdded,
} from "../src/engine/newcontent";
import { MAX_IMAGE_BYTES, type Matrix, type Rect, type TextStyle } from "../src/engine/protocol";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const SANS: TextStyle = { size: 12, color: [0, 0, 0], family: "sans", bold: false, italic: false };

/** Documents opened by a test, destroyed after it with their fallback fonts (rule 5). */
let opened: mupdf.PDFDocument[] = [];
afterEach(() => {
  for (const doc of opened) {
    releaseFallbackFonts(doc);
    doc.destroy();
  }
  opened = [];
});
const keep = (doc: mupdf.PDFDocument) => (opened.push(doc), doc);
const openBytes = (bytes: Uint8Array) => keep(mupdf.Document.openDocument(bytes, "application/pdf").asPDF()!);
const openFixture = (name: string) => openBytes(fixture(name));

function saveBytes(doc: mupdf.PDFDocument, options = "compress=no"): Uint8Array {
  const buf = doc.saveToBuffer(options);
  try {
    return buf.asUint8Array().slice();
  } finally {
    buf.destroy();
  }
}

/** A PDF of one page with `content` (and Helvetica as /F1), made here. */
function onePage(content: string, { w = 595, h = 842 } = {}): mupdf.PDFDocument {
  const d = new mupdf.PDFDocument();
  try {
    const font = new mupdf.Font("Helvetica");
    try {
      d.insertPage(-1, d.addPage([0, 0, w, h], 0, { Font: { F1: d.addSimpleFont(font) } }, content));
    } finally {
      font.destroy();
    }
    return openBytes(saveBytes(d));
  } finally {
    d.destroy();
  }
}

/** The download as the session writes it: a snapshot re-opened with its fallback fonts, those subset, garbage collected. */
function download(doc: mupdf.PDFDocument): Uint8Array {
  const scratch = openBytes(saveBytes(doc, "encrypt=none"));
  restoreFallbackFonts(scratch, fallbackFontState(doc));
  subsetFallbackFonts(mupdf, scratch);
  return saveBytes(scratch, "garbage=compact,compress=yes,encrypt=none");
}

interface Line {
  text: string;
  bbox: Rect;
  size: number;
  color: number[];
  dir: number[];
  fontName: string;
  origins: number[][];
}

/** The page's lines as the session lists them (blank ones left out), plain data. */
function linesOf(doc: mupdf.PDFDocument, pageIndex: number): Line[] {
  const page = doc.loadPage(pageIndex);
  const raw = extractLines(page);
  try {
    return raw.filter((l) => l.text.trim() !== "").map((l) => ({
      text: l.text, bbox: [...l.bbox] as Rect, size: l.chars[0].size, color: [...l.chars[0].color], dir: [...l.dir],
      fontName: l.chars[0].fontName, origins: l.chars.map((c: { origin: number[] }) => [...c.origin]),
    }));
  } finally {
    for (const l of raw) for (const ch of l.chars) ch.font.destroy();
    page.destroy();
  }
}
const textsOf = (doc: mupdf.PDFDocument, pageIndex = 0) => linesOf(doc, pageIndex).map((l) => l.text.trim());
const lineWith = (doc: mupdf.PDFDocument, pageIndex: number, text: string) => linesOf(doc, pageIndex).find((l) => l.text.trim() === text);

/** The raw line (core.extractLines) holding `text`, for addedLineIds; its fonts released after `use`. */
function withRawLine<T>(doc: mupdf.PDFDocument, pageIndex: number, text: string, use: (line: ReturnType<typeof extractLines>[number]) => T): T {
  const page = doc.loadPage(pageIndex);
  const raw = extractLines(page);
  try {
    const line = raw.find((l) => l.text.trim() === text);
    if (!line) throw new Error(`no line "${text}"`);
    return use(line);
  } finally {
    for (const l of raw) for (const ch of l.chars) ch.font.destroy();
    page.destroy();
  }
}

/** A line edit as the session makes one: replaceText, with the page's added lines protected. */
function editLine(doc: mupdf.PDFDocument, pageIndex: number, find: string, replacement: string) {
  const restore = protectAdded(mupdf, doc, pageIndex, { find, occurrence: 0 });
  replaceText(mupdf, doc, pageIndex, find, replacement, { occurrence: 0 });
  restore();
}

function contentOf(doc: mupdf.PDFDocument, pageIndex: number): string[] {
  const c = doc.findPage(pageIndex).get("Contents");
  const read = (s: mupdf.PDFObject) => {
    const b = s.readStream();
    try {
      return latin1(b.asUint8Array());
    } finally {
      b.destroy();
    }
  };
  const out: string[] = [];
  if (c.isArray()) for (let k = 0; k < c.length; k++) out.push(read(c.get(k)));
  else if (c.isStream()) out.push(read(c));
  return out;
}

/** Writes content stream `index` of the page again (-1: the last), changed by `change`: content as another tool would write it. */
function changeContent(doc: mupdf.PDFDocument, pageIndex: number, index: number, change: (s: string) => string) {
  const parts = contentOf(doc, pageIndex), k = index < 0 ? parts.length + index : index;
  writeStream(mupdf, doc, doc.findPage(pageIndex), k, change(parts[k]));
}

function maxQ(text: string) {
  let d = 0, max = 0;
  for (const o of operations(text)) {
    if (o.op === "q") max = Math.max(max, ++d);
    else if (o.op === "Q" && d > 0) d--;
  }
  return max;
}

function render(doc: mupdf.PDFDocument, pageIndex: number, scale = 1) {
  const page = doc.loadPage(pageIndex);
  try {
    const pix = renderPixmap(mupdf, page, scale);
    try {
      return { width: pix.getWidth(), height: pix.getHeight(), rgba: new Uint8Array(pix.getPixels()), x0: pix.getX(), y0: pix.getY() };
    } finally {
      pix.destroy();
    }
  } finally {
    page.destroy();
  }
}

/** Dark pixels (a channel sum under 600) in `rect` (page space) of a render at `scale`. */
function inkIn(doc: mupdf.PDFDocument, pageIndex: number, rect: Rect, scale = 2) {
  const r = render(doc, pageIndex, scale);
  let n = 0;
  for (let y = Math.floor(rect[1] * scale); y < Math.ceil(rect[3] * scale); y++)
    for (let x = Math.floor(rect[0] * scale); x < Math.ceil(rect[2] * scale); x++) {
      const px = x - r.x0, py = y - r.y0, i = (py * r.width + px) * 4;
      if (px >= 0 && py >= 0 && px < r.width && py < r.height && r.rgba[i] + r.rgba[i + 1] + r.rgba[i + 2] < 600) n++;
    }
  return n;
}

/** The colour at (x, y) (page space) of a render at scale 1. */
function colourAt(doc: mupdf.PDFDocument, pageIndex: number, x: number, y: number) {
  const r = render(doc, pageIndex, 1);
  const i = ((Math.floor(y) - r.y0) * r.width + Math.floor(x) - r.x0) * 4;
  return [r.rgba[i], r.rgba[i + 1], r.rgba[i + 2]];
}

function hash(u8: Uint8Array) {
  let h = 0x811c9dc5;
  for (let i = 0; i < u8.length; i++) h = Math.imul(h ^ u8[i], 0x01000193);
  return h >>> 0;
}

function boundsOf(doc: mupdf.PDFDocument, pageIndex: number): Rect {
  const page = doc.loadPage(pageIndex);
  try {
    return [...page.getBounds()] as Rect;
  } finally {
    page.destroy();
  }
}

function placementsOf(doc: mupdf.PDFDocument, pageIndex: number) {
  const page = doc.loadPage(pageIndex);
  try {
    return findPlacements(mupdf, page).placements.map((p) => ({ matrix: p.matrix, movable: p.movable, added: p.added, reason: p.reason, pixels: [p.pixelWidth, p.pixelHeight] }));
  } finally {
    page.destroy();
  }
}

/** A picture: a PNG with transparency (a drawn signature: a dark stroke on transparent pixels) or a JPEG. */
function picture(kind: "png" | "jpeg", w = 300, h = 100): Uint8Array {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], kind === "png");
  try {
    const px = pix.getPixels(), n = kind === "png" ? 4 : 3, stride = pix.getStride();
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const o = y * stride + x * n;
        const on = Math.abs(y - (x * h) / w) < 6 || Math.abs(y - h / 2 - 20 * Math.sin(x / 15)) < 4;
        if (kind === "png") [px[o], px[o + 1], px[o + 2], px[o + 3]] = on ? [20, 30, 120, 255] : [0, 0, 0, 0];
        else [px[o], px[o + 1], px[o + 2]] = [(x * 255) / w, (y * 255) / h, 128];
      }
    return (kind === "png" ? pix.asPNG() : pix.asJPEG(85)).slice();
  } finally {
    pix.destroy();
  }
}

/** A picture as the session places it (checkPicture). */
const checked = (bytes: Uint8Array) => checkPicture(mupdf, bytes);

const expectMatrix = (got: readonly number[], want: readonly number[], digits = 3) => want.forEach((v, k) => expect(got[k]).toBeCloseTo(v, digits));

// ---------------------------------------------------------------------------------------------

describe("addText: a new line of real text", () => {
  const samples = [
    "Città: Forlì – 1.234,56 € «ok» “sì” ‘no’ … °",
    "✓ ✗ ✔ ✘",
    "Zażółć gęślą jaźń ŁŚŹ",
    "Ελληνικά Κύριε",
    "Кириллица Ж",
    "中文 日本語 한국어",
    "Mario Rossi, 16/10/2026",
  ];

  it("reads back exactly in the structured text and MuPDF's search, inked, and as AddedText", () => {
    const doc = openFixture("chrome-subset.pdf");
    samples.forEach((text, k) => {
      const origin: [number, number] = [60, 450 + k * 30];
      const r = addText(mupdf, doc, 0, origin, text, SANS);
      expect(r).toEqual({ id: k + 1, missing: [] });
      const l = lineWith(doc, 0, text);
      expect(l, text).toBeTruthy();
      expect(l!.dir).toEqual([1, 0]);
      expect(l!.size).toBeCloseTo(12, 3);
      expectMatrix(l!.origins[0], origin, 2);
      expect(inkIn(doc, 0, l!.bbox)).toBeGreaterThan(30);
    });
    const page = doc.loadPage(0);
    expect(page.search("Forlì").length).toBe(1);
    expect(page.search("1.234,56 €").length).toBe(1);
    page.destroy();
    // the fill layer's view of them
    const added = addedTexts(mupdf, doc, 0);
    expect(added.map((a) => a.text)).toEqual(samples);
    added.forEach((a, k) => {
      expect(a.id).toBe(k + 1);
      expectMatrix(a.origin, [60, 450 + k * 30], 3);
      expect(a.style).toEqual(SANS);
      // the box covers the line MuPDF reads (its ink), from the origin on
      const l = lineWith(doc, 0, a.text)!;
      expect(a.bbox[0]).toBeCloseTo(60, 2);
      expect(Math.abs(a.bbox[2] - l.bbox[2])).toBeLessThan(0.6);
      expect(a.bbox[1]).toBeLessThanOrEqual(l.bbox[1] + 0.5);
      expect(a.bbox[3]).toBeGreaterThanOrEqual(l.bbox[3] - 0.5);
    });
  });

  it("writes ✓ ✗ ✔ ✘ with ZapfDingbats, the CJK text with the CJK font", () => {
    const doc = openFixture("chrome-subset.pdf");
    addText(mupdf, doc, 0, [60, 450], "✓ ✗ ✔ ✘", SANS);
    addText(mupdf, doc, 0, [60, 480], "中文", SANS);
    expect(lineWith(doc, 0, "✓ ✗ ✔ ✘")!.fontName).toBe("Dingbats");
    expect(lineWith(doc, 0, "中文")!.fontName).toMatch(/Droid/);
  });

  it("keeps the style: family, bold, italic, size and colour", () => {
    const doc = openFixture("chrome-subset.pdf");
    const styles: TextStyle[] = [
      { size: 9, color: [0.12, 0.23, 0.58], family: "serif", bold: true, italic: false },
      { size: 17.5, color: [1, 0, 0], family: "mono", bold: false, italic: true },
      { size: 30, color: [0, 0.5, 0], family: "sans", bold: true, italic: true },
    ];
    styles.forEach((st, k) => addText(mupdf, doc, 0, [60, 450 + k * 50], `Stile ${k}`, st));
    const added = addedTexts(mupdf, doc, 0);
    added.forEach((a, k) => {
      expect({ ...a.style, color: a.style.color.map((v) => +v.toFixed(3)) }).toEqual(styles[k]);
      const l = lineWith(doc, 0, `Stile ${k}`)!;
      expect(l.size).toBeCloseTo(styles[k].size, 3);
      l.color.forEach((v, i) => expect(v).toBeCloseTo(styles[k].color[i], 2));
    });
  });

  it("leaves out emoji and characters beyond U+FFFF, and says which; nothing drawable is refused, unchanged", () => {
    const doc = openFixture("chrome-subset.pdf");
    expect(missingChars(mupdf, "Ok 😀 𝑥 fine 😀", SANS)).toEqual(["😀", "𝑥"]);
    expect(missingChars(mupdf, "Città ✓ ✗ 中文", SANS)).toEqual([]);
    const r = addText(mupdf, doc, 0, [60, 500], "Ok 😀 𝑥 fine", SANS);
    expect(r.missing).toEqual(["😀", "𝑥"]);
    expect(linesOf(doc, 0).some((l) => l.text.replace(/\s+/g, " ").trim() === "Ok fine")).toBe(true);
    const content = contentOf(doc, 0).join("\n");
    let refusal: unknown;
    try {
      addText(mupdf, doc, 0, [60, 520], "😀😀", SANS);
    } catch (err) {
      refusal = err;
    }
    expect(refusal).toBeInstanceOf(ContentError);
    expect((refusal as ContentError).code).toBe("bad-request");
    expect(contentOf(doc, 0).join("\n")).toBe(content);
  });

  it("lands where asked, horizontal as seen, on pages with /Rotate 90 and an offset CropBox", () => {
    for (const [name, pageIndex] of [["chrome-rotate90-crop.pdf", 0], ["reportlab-form.pdf", 1]] as const) {
      const doc = openFixture(name);
      const n0 = linesOf(doc, pageIndex).length;
      const origin: [number, number] = [40, boundsOf(doc, pageIndex)[3] - 30];
      addText(mupdf, doc, pageIndex, origin, "Firmato: Mario Rossi ✓", { ...SANS, size: 14, color: [0.1, 0.2, 0.7] });
      const l = lineWith(doc, pageIndex, "Firmato: Mario Rossi ✓")!;
      expect(l, name).toBeTruthy();
      expect(l.dir[0]).toBeCloseTo(1, 6);
      expect(l.dir[1]).toBeCloseTo(0, 6);
      expect(l.size).toBeCloseTo(14, 3);
      expect(l.color[2]).toBeCloseTo(0.7, 2);
      expectMatrix(l.origins[0], origin, 2);
      expect(linesOf(doc, pageIndex).length).toBe(n0 + 1);
      const [a] = addedTexts(mupdf, doc, pageIndex);
      expectMatrix(a.origin, origin, 3);
      expect(a.bbox[2] - a.bbox[0]).toBeGreaterThan(100); // horizontal as seen
      expect(a.bbox[3] - a.bbox[1]).toBeLessThan(25);
    }
  });
});

// ---------------------------------------------------------------------------------------------

/** A flat form: a line of underscores to write on, and two boxes to tick. */
const FORM = "BT /F1 12 Tf 72 700 Td (Nome: ______________________________) Tj ET\nBT /F1 12 Tf 72 670 Td (Barrare: [ ] Si   [ ] No) Tj ET\n";

describe("added text is edited in its own block", () => {
  it("rewriteAdded changes the text, the style and the place, keeping the id; an empty text deletes it", () => {
    const doc = openFixture("chrome-subset.pdf");
    const n0 = linesOf(doc, 0).length;
    const { id } = addText(mupdf, doc, 0, [60, 450], "Mario Rossi ✓", SANS);
    expect(rewriteAdded(mupdf, doc, 0, id, { text: "Maria Rossi ✓" })).toEqual({ id, missing: [] });
    expect(lineWith(doc, 0, "Maria Rossi ✓")).toBeTruthy();
    rewriteAdded(mupdf, doc, 0, id, { origin: [200, 300] });
    expect(lineWith(doc, 0, "Maria Rossi ✓")!.bbox[0]).toBeCloseTo(200, 1);
    const big: TextStyle = { size: 20, color: [0.8, 0, 0], family: "serif", bold: true, italic: false };
    rewriteAdded(mupdf, doc, 0, id, { style: big });
    const l = lineWith(doc, 0, "Maria Rossi ✓")!;
    expect(l.size).toBeCloseTo(20, 3);
    expectMatrix(l.origins[0], [200, 300], 2);
    const [a] = addedTexts(mupdf, doc, 0);
    expect(a).toMatchObject({ id, text: "Maria Rossi ✓", style: big });
    expect(linesOf(doc, 0).length).toBe(n0 + 1);
    expect(rewriteAdded(mupdf, doc, 0, id, { text: "" })).toEqual({ id: null, missing: [] });
    expect(linesOf(doc, 0).length).toBe(n0);
    expect(addedTexts(mupdf, doc, 0)).toEqual([]);
    // no such text
    expect(() => rewriteAdded(mupdf, doc, 0, id, { text: "x" })).toThrow(ContentError);
    expect(() => rewriteAdded(mupdf, doc, 0, 99, { text: "x" })).toThrow(/No text 99/);
  });

  it("a form's underscores and boxes survive writing on them, correcting and deleting what was written", () => {
    const doc = onePage(FORM);
    const form = textsOf(doc);
    // page space is y down: the "Nome" baseline is at 842 - 700 = 142
    const name = addText(mupdf, doc, 0, [115, 142], "Mario Rossi", SANS);
    const tick = addText(mupdf, doc, 0, [131.5, 172], "✓", SANS);
    expect(textsOf(doc)).toEqual([...form, "Mario Rossi", "✓"]);
    const ids = withRawLine(doc, 0, "Mario Rossi", (line) => addedLineIds(mupdf, doc, 0, line));
    expect(ids).toEqual([name.id]);
    rewriteAdded(mupdf, doc, 0, name.id, { text: "Maria Rossi" });
    rewriteAdded(mupdf, doc, 0, tick.id, { text: "" });
    expect(textsOf(doc)).toEqual([...form, "Maria Rossi"]);
  });

  it("tells an added line (one block, or two MuPDF reads as one) from a mixed or an original one", () => {
    const doc = onePage(FORM);
    const blocks = () => pageBlocks(doc, 0);
    const a = addText(mupdf, doc, 0, [100, 300], "Mario", SANS);
    // "Mario " is 2.778 em wide in Nimbus Sans (Helvetica's widths): the next block starts right after it
    const b = addText(mupdf, doc, 0, [100 + 2.778 * 12, 300], "Rossi", SANS);
    expect(textsOf(doc)).toContain("Mario Rossi");
    expect(withRawLine(doc, 0, "Mario Rossi", (l) => addedLineIds(mupdf, doc, 0, l, blocks()))).toEqual([a.id, b.id]);
    expect(withRawLine(doc, 0, "Nome: ______________________________", (l) => addedLineIds(mupdf, doc, 0, l))).toBeNull();
    // a block written a space after the end of the content's last line, on its baseline: MuPDF
    // reads one line (it only continues the line drawn just before)
    const other = onePage(FORM);
    const barrare = linesOf(other, 0).find((l) => l.text.startsWith("Barrare"))!;
    const c = addText(mupdf, other, 0, [barrare.bbox[2] + 0.278 * 12, 172], "AGG", SANS);
    const mixed = textsOf(other).find((t) => t.includes("AGG"))!;
    expect(mixed.startsWith("Barrare")).toBe(true);
    expect(withRawLine(other, 0, mixed, (l) => addedLineIds(mupdf, other, 0, l))).toBeNull();
    // editing the mixed line goes the redaction way: the block is part of it, not written back
    editLine(other, 0, mixed, mixed + "!");
    expect(textsOf(other).filter((t) => t.includes("AGG"))).toEqual([mixed + "!"]);
    expect(addedTexts(mupdf, other, 0).map((t) => t.id)).not.toContain(c.id);
  });

  it("a line holding ligatures (ﬀ ﬁ ﬂ ﬃ ﬄ: one glyph, two or three letters read) is an added line, edited in its block", () => {
    for (const text of ["Coﬀee", "Uﬃcio tecnico", "aﬀﬁﬂﬃﬄb"]) {
      const doc = onePage(FORM);
      const { id } = addText(mupdf, doc, 0, [115, 139.6], text, SANS); // over the underscores of "Nome:"
      const read = text.normalize("NFKC"); // as MuPDF's structured text reads it
      expect(textsOf(doc), text).toContain(read);
      expect(addedTexts(mupdf, doc, 0).map((t) => t.text)).toEqual([text]);
      expect(withRawLine(doc, 0, read, (l) => addedLineIds(mupdf, doc, 0, l)), text).toEqual([id]);
      expect(withRawLine(doc, 0, read, (l) => addedLineIds(mupdf, doc, 0, l, pageBlocks(doc, 0))), text).toEqual([id]);
      // so the session rewrites it in its block, and the printed underscores under it stay whole
      rewriteAdded(mupdf, doc, 0, id, { text: "Luigi Bianchi" });
      expect(textsOf(doc)).toContain("Nome: ______________________________");
      expect(textsOf(doc)).toContain("Luigi Bianchi");
    }
  });

  it("added text read on one line before printed text is not an added line, even with as many glyphs (spaces) as the line has letters", () => {
    // (review r3, mix4: "Via Roma 1 B" has 12 glyphs, 3 of them spaces, and "Via Roma 1 B nr." 12 visible characters)
    const cases = [["Via Roma 1 B", "n.", "nr."], ["Mario Rossi", "n.", "nr."], ["a b c d e f", "kg", "kgs"], ["Mario", "(firma)", "(Firma)"]];
    for (const [text, label, label2] of cases) {
      const doc = onePage(`BT /F1 12 Tf 200 200 Td (${label}) Tj ET`, { w: 400, h: 400 });
      const { id } = addText(mupdf, doc, 0, [20, 200], text, SANS);
      const [t] = addedTexts(mupdf, doc, 0);
      rewriteAdded(mupdf, doc, 0, id, { origin: [20 + (200 - 3 - t.bbox[2]), 200] }); // ends 3 pt before the printed word
      // on a line of its own the value is an added line
      expect(withRawLine(doc, 0, text, (l) => addedLineIds(mupdf, doc, 0, l)), text).toEqual([id]);
      // the printed word edited: its replacement is drawn after the block, and MuPDF reads one line
      editLine(doc, 0, label, label2);
      const merged = `${text} ${label2}`;
      expect(textsOf(doc), text).toContain(merged);
      expect(withRawLine(doc, 0, merged, (l) => addedLineIds(mupdf, doc, 0, l)), text).toBeNull();
      expect(withRawLine(doc, 0, merged, (l) => addedLineIds(mupdf, doc, 0, l, pageBlocks(doc, 0))), text).toBeNull();
      expect(addedTexts(mupdf, doc, 0).map((x) => x.text)).toEqual([text]);
    }
  });

  it("a line edit's redaction does not take added text over or under the edited line with it", () => {
    const doc = openFixture("chrome-subset.pdf");
    const l0 = linesOf(doc, 0).find((l) => l.text.includes("Gentile"))!;
    const mid = (l0.bbox[0] + l0.bbox[2]) / 2;
    addText(mupdf, doc, 0, [mid, l0.bbox[3] - 3], "SOPRA", SANS);
    addText(mupdf, doc, 0, [mid, l0.bbox[1] - 2], "APPENA SOPRA", SANS);
    addText(mupdf, doc, 0, [60, 700], "Lontano", SANS);
    const before = addedTexts(mupdf, doc, 0);
    const find = l0.text.trim();
    // without protection the redaction cuts into what lies over the line...
    const bare = openFixture("chrome-subset.pdf");
    addText(mupdf, bare, 0, [mid, l0.bbox[3] - 3], "SOPRA", SANS);
    replaceText(mupdf, bare, 0, find, find.replace("Gentile", "Caro"), { occurrence: 0 });
    expect(addedTexts(mupdf, bare, 0).map((t) => t.text)).not.toEqual(["SOPRA"]);
    // ...with it, every added line is as it was
    editLine(doc, 0, find, find.replace("Gentile", "Caro"));
    expect(textsOf(doc).some((t) => t.includes("Caro"))).toBe(true);
    const after = addedTexts(mupdf, doc, 0);
    expect(after.map((t) => [t.id, t.text])).toEqual(before.map((t) => [t.id, t.text]));
    after.forEach((t, k) => expectMatrix(t.origin, before[k].origin, 3));
    expect(textsOf(doc).filter((t) => /SOPRA/.test(t)).sort()).toEqual(["APPENA SOPRA", "SOPRA"]);
  });

  it("an added line the redaction emptied, or rewrote with a literal string (printable glyph ids), comes back", () => {
    // 梣 梤 梥 梦 have glyph ids whose two bytes are printable: MuPDF's filter writes them as (...)
    const doc = onePage("BT /F1 12 Tf 72 700 Td (Riga originale da modificare) Tj ET\n");
    const over = addText(mupdf, doc, 0, [80, 142], "梣梤梥梦", SANS); // over the line, on its baseline region
    const far = addText(mupdf, doc, 0, [72, 400], "梣梤梥梦 lontano", SANS);
    const target = textsOf(doc).find((t) => t.startsWith("Riga"))!;
    editLine(doc, 0, target, "Riga cambiata");
    const all = contentOf(doc, 0).join("\n");
    expect(all).toMatch(/\(!!!"!#!\$\)/); // the far block, rewritten by the filter as a literal string
    const after = addedTexts(mupdf, doc, 0);
    expect(after.map((t) => [t.id, t.text])).toEqual([[over.id, "梣梤梥梦"], [far.id, "梣梤梥梦 lontano"]]);
    expect(textsOf(doc)).toContain("Riga cambiata");
    // and it is still edited in place
    rewriteAdded(mupdf, doc, 0, far.id, { text: "梦 vicino" });
    expect(textsOf(doc)).toContain("梦 vicino");
  });

  it("after a save and a re-open (fonts subset), added lines are found, read and rewritten", () => {
    const doc = openFixture("word-winansi.pdf");
    const st: TextStyle = { size: 11, color: [0.12, 0.23, 0.58], family: "serif", bold: false, italic: true };
    addText(mupdf, doc, 0, [72, 500], "Compilato da: Mario Rossi ✓", st);
    const again = openBytes(download(doc));
    const [a] = addedTexts(mupdf, again, 0);
    expect(a.text).toBe("Compilato da: Mario Rossi ✓");
    expect({ ...a.style, color: a.style.color.map((v) => +v.toFixed(3)) }).toEqual(st);
    const ids = withRawLine(again, 0, a.text, (l) => addedLineIds(mupdf, again, 0, l));
    expect(ids).toEqual([a.id]);
    rewriteAdded(mupdf, again, 0, a.id, { text: "Compilato da: Maria Bianchi ✗" });
    expect(lineWith(again, 0, "Compilato da: Maria Bianchi ✗")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------------------------

describe("appending to the page content", () => {
  it("keeps q nesting bounded after many additions; the page ends clean", () => {
    const doc = openFixture("type3-matplotlib.pdf");
    const depth0 = maxQ(contentOf(doc, 0).join(" "));
    for (let k = 0; k < 40; k++) addText(mupdf, doc, 0, [30, 480 + k * 9], `Campo ${k}: valore`, { ...SANS, size: 7 });
    const all = contentOf(doc, 0).join(" ");
    expect(isClean(endState(all))).toBe(true);
    expect(maxQ(all)).toBeLessThanOrEqual(depth0 + 1);
    expect(lineWith(doc, 0, "Campo 39: valore")!.size).toBeCloseTo(7, 3);
  });

  it("closes what the content left open (cm, colour, clip, q, a marked sequence, BT) once, and draws from the initial state", () => {
    const doc = onePage("q 2 0 0 2 0 0 cm 1 0 0 rg 0 0 50 50 re W n /Span <</MCID 0>> BDC BT /F1 10 Tf 10 300 Td (left open) Tj");
    const old = contentOf(doc, 0);
    const st = endState(old.join(" "));
    expect(st).toMatchObject({ stack: ["q", "m", "t"], changed: false, inside: false, underflow: 0 });
    addText(mupdf, doc, 0, [300, 700], "Dopo", SANS);
    const parts = contentOf(doc, 0);
    expect(parts[0]).toBe("q\n");
    expect(parts.at(-1)).toMatch(/^\nET\nEMC\nQ\nQ\n\/Span <<\/PEText 1>> BDC\n/);
    const l = lineWith(doc, 0, "Dopo")!;
    expect(l.size).toBeCloseTo(12, 3);
    expect(l.color).toEqual([0, 0, 0]);
    expect(inkIn(doc, 0, l.bbox)).toBeGreaterThan(20); // not clipped away by the 0 0 50 50 clip, not doubled in size
    addText(mupdf, doc, 0, [300, 720], "Ancora", SANS);
    expect(contentOf(doc, 0).length).toBe(parts.length + 1); // no second wrap
    expect(lineWith(doc, 0, "Ancora")!.size).toBeCloseTo(12, 3);
    expect(contentOf(doc, 0).slice(1, 1 + old.length)).toEqual(old); // the old content as it was
  });

  it("appends to clean content without touching it, after a comment that ends it", () => {
    const doc = onePage("q 1 0 0 1 0 0 cm BT /F1 10 Tf 10 300 Td (in q) Tj ET Q % a comment at the very end");
    const before = contentOf(doc, 0);
    addText(mupdf, doc, 0, [300, 700], "Dopo", SANS);
    const after = contentOf(doc, 0);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.length).toBe(before.length + 1);
    expect(lineWith(doc, 0, "Dopo")).toBeTruthy();
    expect(addedTexts(mupdf, doc, 0).map((t) => t.text)).toEqual(["Dopo"]);
  });

  it("refuses content that ends inside a string, an array, a dictionary or an inline image, changing nothing", () => {
    for (const end of ["BT /F1 10 Tf 10 300 Td (never closed", "[ (a) 10 (b)", "/Span << /MCID 3", "q 10 0 0 10 50 50 cm BI /W 2 /H 1 /CS /G /BPC 8 /F /AHx ID 00FF"]) {
      const doc = onePage(`0 0 1 rg 10 10 20 20 re f ${end}`);
      expect(appendProblem(doc, 0), end).toMatch(/ends inside/);
      const content = contentOf(doc, 0);
      let refusal: unknown;
      try {
        addText(mupdf, doc, 0, [300, 700], "Dopo", SANS);
      } catch (err) {
        refusal = err;
      }
      expect((refusal as ContentError).code, end).toBe("not-editable");
      expect(() => addImage(mupdf, doc, checked(picture("png", 20, 10)), [{ pageIndex: 0, matrix: [40, 0, 0, 20, 100, 100] }], null)).toThrow(ContentError);
      expect(contentOf(doc, 0)).toEqual(content);
    }
    // an inline image with its EI is fine
    expect(appendProblem(onePage("q 10 0 0 10 50 50 cm BI /W 2 /H 1 /CS /G /BPC 8 /F /AHx ID 00FF> EI Q"), 0)).toBeNull();
  });

  it("wraps content that ends with operands no operator takes, so the ids of new lines stay unique", () => {
    for (const tail of ["/Foo", "0 0 1", "(junk)"]) {
      const doc = onePage(`BT /F1 12 Tf 100 700 Td (Original) Tj ET ${tail}`);
      expect(endState(contentOf(doc, 0).join(" ")), tail).toMatchObject({ dangling: true, inside: false });
      expect(appendProblem(doc, 0)).toBeNull();
      const first = addText(mupdf, doc, 0, [100, 300], "First", SANS);
      const second = addText(mupdf, doc, 0, [100, 330], "Second", SANS);
      expect(second.id, tail).not.toBe(first.id);
      const parts = contentOf(doc, 0);
      expect(parts[0]).toBe("q\n"); // wrapped once: the wrap's Q takes the stray operands
      expect(parts.at(-2)).toMatch(/^\nQ\n\/Span <<\/PEText 1>> BDC\n/);
      expect(isClean(endState(parts.join(" ")))).toBe(true);
      rewriteAdded(mupdf, doc, 0, second.id, { text: "Changed" });
      expect(addedTexts(mupdf, doc, 0).map((t) => [t.id, t.text])).toEqual([[first.id, "First"], [second.id, "Changed"]]);
      expect(textsOf(doc).sort()).toEqual(["Changed", "First", "Original"]);
    }
  });

  it("reads a block's property list as the last operand of its BDC, whatever operands come before", () => {
    const doc = onePage(FORM);
    const mario = addText(mupdf, doc, 0, [100, 300], "Mario", SANS);
    addImage(mupdf, doc, checked(picture("png", 60, 20)), [{ pageIndex: 0, matrix: [60, 0, 0, 20, 300, 300] }], null);
    // another tool wrote stray operands before the tags
    changeContent(doc, 0, -2, (s) => s.replace("/Span <<", "1 2 /Span <<"));
    changeContent(doc, 0, -1, (s) => s.replace("/Artifact <<", "0 0 /Artifact <<"));
    expect(addedTexts(mupdf, doc, 0).map((t) => [t.id, t.text])).toEqual([[mario.id, "Mario"]]);
    expect(placementsOf(doc, 0).at(-1)).toMatchObject({ added: true, movable: true });
    const next = addText(mupdf, doc, 0, [100, 330], "Maria", SANS);
    expect(next.id).not.toBe(mario.id);
    rewriteAdded(mupdf, doc, 0, mario.id, { text: "Mario Rossi" });
    expect(addedTexts(mupdf, doc, 0).map((t) => t.text)).toEqual(["Mario Rossi", "Maria"]);
  });

  it("refuses content that restores more states than it saves and does not end clean; ends clean, it is appended", () => {
    const dirty = onePage("Q 2 0 0 2 0 0 cm 0 0 1 rg 10 10 20 20 re f");
    expect(endState(contentOf(dirty, 0).join(" "))).toMatchObject({ underflow: 1, changed: true });
    expect(appendProblem(dirty, 0)).toMatch(/restores more/);
    expect(() => addText(mupdf, dirty, 0, [300, 700], "Dopo", SANS)).toThrow(ContentError);
    const clean = onePage("Q q 2 0 0 2 0 0 cm 0 0 1 rg 10 10 20 20 re f Q");
    expect(appendProblem(clean, 0)).toBeNull();
    addText(mupdf, clean, 0, [300, 700], "Dopo", SANS);
    expect(lineWith(clean, 0, "Dopo")!.size).toBeCloseTo(12, 3);
    // nested deeper than MAX_OPEN: taken when it ends clean, refused when there is that much to close
    expect(appendProblem(onePage("q ".repeat(MAX_OPEN + 10) + "0 0 1 rg 10 10 20 20 re f " + "Q ".repeat(MAX_OPEN + 10)), 0)).toBeNull();
    expect(appendProblem(onePage("q ".repeat(MAX_OPEN + 10) + "0 0 1 rg 10 10 20 20 re f"), 0)).toMatch(/nests more than/);
  });

  it("replaying the same calls on a fresh copy gives the same page", () => {
    const steps = (doc: mupdf.PDFDocument) => [
      () => addText(mupdf, doc, 0, [60, 450], "Nome: Mario Rossi", SANS),
      () => addText(mupdf, doc, 0, [60, 480], "Data: 16/10/2026 ✓", { ...SANS, family: "serif", bold: true }),
      () => addImage(mupdf, doc, checked(picture("png")), [{ pageIndex: 0, matrix: [150, 0, 0, 50, 300, 700] }], null, { locate: false }),
      () => addText(mupdf, doc, 0, [60, 510], "中文 Città", { ...SANS, family: "mono", italic: true, size: 9 }),
      () => rewriteAdded(mupdf, doc, 0, 1, { text: "Nome: Maria Rossi" }),
      () => editLine(doc, 0, textsOf(doc).find((t) => t.includes("Gentile"))!, "Caro cliente,"),
      () => rewriteAdded(mupdf, doc, 0, 3, { text: "" }),
      () => addImage(mupdf, doc, checked(picture("jpeg")), [{ pageIndex: 0, matrix: [90, 0, 0, 30, 100, 470] }], "Foto", { locate: false }),
    ];
    const a = openFixture("chrome-subset.pdf"), b = openFixture("chrome-subset.pdf");
    for (const step of steps(a)) step();
    for (const step of steps(b)) step();
    expect(contentOf(b, 0)).toEqual(contentOf(a, 0));
    mupdf.emptyStore();
    expect(hash(render(b, 0).rgba)).toBe(hash(render(a, 0).rgba));
    expect(textsOf(a)).toContain("Nome: Maria Rossi");
    expect(textsOf(a)).not.toContain("中文 Città");
  });
});

// ---------------------------------------------------------------------------------------------

/** Text shown outside any marked sequence that has an MCID or is an artifact. */
const untaggedShows = (doc: mupdf.PDFDocument, pageIndex: number) => markedContent(contentOf(doc, pageIndex).join("\n"), null).untagged;

describe("tagged pages", () => {
  it("a new line is a /P under the Document element, in the ParentTree; edited it keeps it, deleted it leaves", () => {
    const doc = openFixture("word-winansi.pdf");
    const n0 = countStructElems(doc), u0 = untaggedShows(doc, 0);
    const { id } = addText(mupdf, doc, 0, [72, 500], "Compilato da: Mario Rossi", SANS);
    expect(countStructElems(doc)).toBe(n0 + 1);
    expect(untaggedShows(doc, 0)).toBe(u0);
    const [block] = pageBlocks(doc, 0);
    expect(block).toMatchObject({ id, tagName: "P" });
    const elem = structParents(doc, doc.findPage(0))!.get(block.mcid!);
    expect(elem.get("S").asName()).toBe("P");
    expect(elem.get("P").get("S").asName()).toBe("Document");
    expect(elem.get("K").asNumber()).toBe(block.mcid);
    rewriteAdded(mupdf, doc, 0, id, { text: "Compilato da: Maria Rossi" });
    expect(pageBlocks(doc, 0)[0].mcid).toBe(block.mcid);
    expect(countStructElems(doc)).toBe(n0 + 1);
    // still so in the download
    const saved = openBytes(download(doc));
    expect(countStructElems(saved)).toBe(n0 + 1);
    expect(markedContent(contentOf(saved, 0).join("\n"), null).byMcid.has(block.mcid!)).toBe(true);
    rewriteAdded(mupdf, doc, 0, id, { text: "" });
    expect(countStructElems(doc)).toBe(n0);
    expect(untaggedShows(doc, 0)).toBe(u0);
  });

  it("an untagged document gets /Span blocks without MCID", () => {
    const doc = onePage(FORM);
    addText(mupdf, doc, 0, [72, 500], "Mario", SANS);
    expect(pageBlocks(doc, 0)[0]).toMatchObject({ tagName: "Span", mcid: null });
    expect(contentOf(doc, 0).at(-1)).toMatch(/\/Span <<\/PEText 1>> BDC/);
  });

  it("Chrome's tagged pages (one /Document element) get a /P too", () => {
    const doc = openFixture("chrome-subset.pdf");
    const n0 = countStructElems(doc);
    addText(mupdf, doc, 0, [72, 500], "Mario", SANS);
    expect(pageBlocks(doc, 0)[0]).toMatchObject({ tagName: "P" });
    expect(countStructElems(doc)).toBe(n0 + 1);
  });

  it("a page of a tagged document without /StructParents gets a key; a ParentTree with /Kids has its /Limits updated", () => {
    const d = openFixture("word-winansi.pdf");
    const root = d.getTrailer().get("Root", "StructTreeRoot");
    const nums = root.get("ParentTree").get("Nums");
    const leaf = d.addObject(d.newDictionary());
    leaf.put("Nums", nums);
    const lim = d.newArray();
    lim.push(nums.get(0));
    lim.push(nums.get(nums.length - 2));
    leaf.put("Limits", lim);
    const tree = d.addObject(d.newDictionary());
    const kids = d.newArray();
    kids.push(leaf);
    tree.put("Kids", kids);
    root.put("ParentTree", tree);
    d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, {}, ""));
    const doc = openBytes(saveBytes(d));
    addText(mupdf, doc, 1, [72, 100], "Pagina nuova", SANS);
    const p1 = doc.findPage(1);
    const key = p1.get("StructParents").asNumber();
    expect(structParents(doc, p1)!.get(0).get("S").asName()).toBe("P");
    expect(doc.getTrailer().get("Root", "StructTreeRoot", "ParentTree", "Kids", 0, "Limits").get(1).asNumber()).toBe(key);
    expect(doc.getTrailer().get("Root", "StructTreeRoot", "ParentTreeNextKey").asNumber()).toBe(key + 1);
    expect(lineWith(doc, 1, "Pagina nuova")).toBeTruthy();
  });

  it("a described picture is a /Figure with /Alt; one without a description an /Artifact; both marked /PEImage", () => {
    const doc = openFixture("word-images.pdf");
    const n0 = countStructElems(doc);
    addImage(mupdf, doc, checked(picture("png")), [{ pageIndex: 0, matrix: [150, 0, 0, 50, 300, 700] }], "Firma: Mario Rossi");
    addImage(mupdf, doc, checked(picture("png", 60, 30)), [{ pageIndex: 0, matrix: [40, 0, 0, 20, 500, 760] }], null);
    expect(countStructElems(doc)).toBe(n0 + 1);
    const text = contentOf(doc, 0).join("\n");
    const fig = /\/Figure <<\/MCID (\d+) \/PEImage 1>> BDC\nq [^\n]+ cm \/PEImg\d+ Do Q\nEMC/.exec(text);
    expect(fig).toBeTruthy();
    expect(text).toMatch(/\/Artifact <<\/PEImage 2>> BDC\nq [^\n]+ cm \/PEImg\d+ Do Q\nEMC/);
    const elem = structParents(doc, doc.findPage(0))!.get(Number(fig![1]));
    expect(elem.get("S").asName()).toBe("Figure");
    expect(elem.get("Alt").asString()).toBe("Firma: Mario Rossi");
  });

  it("a line edited twice under added text: its replacement is tagged under the line's element, not the added line's", () => {
    /** Edits the first long line of chrome-subset.pdf twice, with added text over its middle or not; the second edit's tag. */
    const twice = (overlay: boolean) => {
      const doc = openFixture("chrome-subset.pdf");
      const line = linesOf(doc, 0).find((l) => l.text.trim().length > 8)!;
      let mcid: number | null = null;
      if (overlay) {
        const { id } = addText(mupdf, doc, 0, [(line.bbox[0] + line.bbox[2]) / 2, line.bbox[3] - 2], "OVERLAY TEXT", SANS);
        mcid = pageBlocks(doc, 0).find((b) => b.id === id)!.mcid;
      }
      const edit = (find: string, replacement: string) => {
        const restore = protectAdded(mupdf, doc, 0, { find, occurrence: 0 });
        const r = replaceText(mupdf, doc, 0, find, replacement, { occurrence: 0 });
        restore();
        return r.tag as { newMcid: number; ownerType: string; ownerMcid: number };
      };
      const t = line.text.trim();
      edit(t, `${t} A`);
      const tag = edit(`${t} A`, `${t} B`);
      return { doc, tag, mcid, text: t };
    };
    const { doc, tag, mcid, text } = twice(true);
    expect(mcid).not.toBeNull();
    expect(tag.ownerMcid).not.toBe(mcid);
    const parents = structParents(doc, doc.findPage(0))!;
    const mine = parents.get(mcid!);
    // the replacement's element and every element above it: never the added line's /P, which keeps only its own text
    const above: mupdf.PDFObject[] = [];
    for (let e = parents.get(tag.newMcid).get("P"); e.isDictionary() && e.get("Type").asName() === "StructElem" && above.length < 32; e = e.get("P")) above.push(e);
    expect(above.some((e) => e.asIndirect() === mine.asIndirect())).toBe(false);
    expect(mine.get("K").asNumber()).toBe(mcid);
    expect(tag.ownerType).toBe(twice(false).tag.ownerType); // as without the added line
    expect(textsOf(doc)).toContain(`${text} B`);
    expect(addedTexts(mupdf, doc, 0).map((t) => t.text)).toEqual(["OVERLAY TEXT"]);
  });

  it("an MCID far beyond the page's ParentTree (a crafted file) leaves the new line untagged, at once", () => {
    // 99999999: an MCID, far beyond the array's end; 1e21: not one the app reads (beyond 2^53), the line is tagged as usual
    for (const [mcid, tagged] of [["99999999", false], ["1000000000000000000000", true]] as const) {
      const doc = openFixture("word-winansi.pdf");
      const n0 = countStructElems(doc), length = structParents(doc, doc.findPage(0))!.length;
      changeContent(doc, 0, 0, (s) => `/Span <</MCID ${mcid}>> BDC EMC\n${s}`);
      const started = Date.now();
      const { id } = addText(mupdf, doc, 0, [72, 500], "Compilato", SANS);
      expect(Date.now() - started, mcid).toBeLessThan(2000);
      const block = pageBlocks(doc, 0).find((b) => b.id === id)!;
      expect(block, mcid).toMatchObject(tagged ? { tagName: "P", mcid: length } : { tagName: "Span", mcid: null });
      expect(countStructElems(doc), mcid).toBe(tagged ? n0 + 1 : n0);
      expect(structParents(doc, doc.findPage(0))!.length).toBe(tagged ? length + 1 : length);
      expect(contentOf(doc, 0).join("\n")).not.toMatch(/e\+/);
      expect(lineWith(doc, 0, "Compilato")).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------------------------

describe("ids of added lines", () => {
  it("ids in the file beyond MAX_ID are not the app's: new lines get small ids, unique, written as PDF numbers", () => {
    const doc = onePage(
      "BT /F1 12 Tf 72 700 Td (Printed) Tj ET\n/Span <</PEText 9007199254740993>> BDC EMC\n/Span <</PEText 1000000000000000000000>> BDC EMC\n",
    );
    const mario = addText(mupdf, doc, 0, [72, 300], "Mario", SANS);
    const maria = addText(mupdf, doc, 0, [72, 330], "Maria", SANS);
    expect([mario.id, maria.id]).toEqual([1, 2]);
    expect(contentOf(doc, 0).join("\n")).not.toMatch(/PEText 1e\+|PEText 9007199254740992/);
    rewriteAdded(mupdf, doc, 0, maria.id, { text: "Marta" });
    expect(addedTexts(mupdf, doc, 0).map((t) => [t.id, t.text])).toEqual([[1, "Mario"], [2, "Marta"]]);
    // after a save and a re-open too
    const again = openBytes(download(doc));
    expect(addedTexts(mupdf, again, 0).map((t) => [t.id, t.text])).toEqual([[1, "Mario"], [2, "Marta"]]);
    // a block that draws text under such an id is not listed, so it is never written back as "1e+21"
    const other = onePage(FORM);
    const guest = addText(mupdf, other, 0, [72, 300], "Ospite", SANS);
    changeContent(other, 0, -1, (s) => s.replace(`/PEText ${guest.id}>>`, "/PEText 1000000000000000000000>>"));
    expect(addedTexts(mupdf, other, 0)).toEqual([]);
    expect(addText(mupdf, other, 0, [72, 330], "Mario", SANS).id).toBe(1);
    expect(addedTexts(mupdf, other, 0).map((t) => [t.id, t.text])).toEqual([[1, "Mario"]]);
  });

  it("past the largest id, a new line takes the smallest free one; a second block with an id already used is not the app's", () => {
    const doc = onePage(FORM);
    const first = addText(mupdf, doc, 0, [72, 300], "Primo", SANS);
    changeContent(doc, 0, -1, (s) => s.replace(`/PEText ${first.id}>>`, `/PEText ${MAX_ID}>>`));
    expect(addedTexts(mupdf, doc, 0).map((t) => [t.id, t.text])).toEqual([[MAX_ID, "Primo"]]);
    const b = addText(mupdf, doc, 0, [72, 330], "Secondo", SANS);
    const c = addText(mupdf, doc, 0, [72, 360], "Terzo", SANS);
    expect([b.id, c.id]).toEqual([1, 2]);
    rewriteAdded(mupdf, doc, 0, MAX_ID, { text: "Primo!" });
    rewriteAdded(mupdf, doc, 0, 1, { text: "Secondo!" });
    expect(addedTexts(mupdf, doc, 0).map((t) => [t.id, t.text])).toEqual([[MAX_ID, "Primo!"], [1, "Secondo!"], [2, "Terzo"]]);
    // a copy of block 2 that a tool appended: only the first is listed and edited
    changeContent(doc, 0, -1, (s) => `${s}\n${s}`);
    const copied = contentOf(doc, 0).at(-1)!;
    expect(copied.match(/PEText 2>>/g)).toHaveLength(2);
    expect(addedTexts(mupdf, doc, 0).map((t) => t.id)).toEqual([MAX_ID, 1, 2]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("addImage: a new picture", () => {
  it("is the page's last placement, added and movable, at the target; release 2's edits work on it", () => {
    const doc = openFixture("chrome-images.pdf");
    const before = placementsOf(doc, 0);
    expect(before.every((p) => !p.added)).toBe(true);
    const target: Matrix = [150, 0, 0, 50, 380, 690];
    const placed = addImage(mupdf, doc, checked(picture("png")), [{ pageIndex: 0, matrix: target }], null);
    const imgs = placementsOf(doc, 0);
    expect(placed).toEqual([{ pageIndex: 0, imageIndex: imgs.length - 1 }]);
    expect(imgs.length).toBe(before.length + 1);
    const mine = imgs.at(-1)!;
    expect(mine).toMatchObject({ movable: true, added: true, pixels: [300, 100] });
    expectMatrix(mine.matrix, target);
    imgs.slice(0, -1).forEach((im, k) => expect(im.matrix).toEqual(before[k].matrix));
    // moved and turned with release 2's edit, it stays an added picture
    const turned: Matrix = [0, 100, -33.3, 0, 450, 600];
    const page = doc.loadPage(0);
    try {
      const found = findPlacements(mupdf, page);
      transformPlacement(mupdf, doc, page, found, found.placements[imgs.length - 1], turned);
    } finally {
      page.destroy();
    }
    expect(placementsOf(doc, 0).at(-1)).toMatchObject({ movable: true, added: true });
    expectMatrix(placementsOf(doc, 0).at(-1)!.matrix, turned);
    // replaced, too
    const page2 = doc.loadPage(0);
    try {
      const found = findPlacements(mupdf, page2);
      const jpeg = picture("jpeg", 200, 100), image = openImage(mupdf, jpeg);
      try {
        replacePlacement(mupdf, doc, page2, found, found.placements[imgs.length - 1], image, jpeg);
      } finally {
        image.destroy();
      }
    } finally {
      page2.destroy();
    }
    expect(placementsOf(doc, 0).at(-1)).toMatchObject({ movable: true, added: true, pixels: [200, 100] });
  });

  it("stays movable at its place, an added picture, after a line edit; deleted, it leaves the page", () => {
    const doc = openFixture("chrome-subset.pdf");
    const target: Matrix = [150, 0, 0, 50, 300, 700];
    addImage(mupdf, doc, checked(picture("png")), [{ pageIndex: 0, matrix: target }], "Firma");
    const find = textsOf(doc).find((t) => t.includes("Gentile"))!;
    editLine(doc, 0, find, find.replace("Gentile", "Caro"));
    const imgs = placementsOf(doc, 0);
    expect(imgs.at(-1)).toMatchObject({ movable: true, added: true });
    expectMatrix(imgs.at(-1)!.matrix, target);
    const page = doc.loadPage(0);
    try {
      const found = findPlacements(mupdf, page);
      deletePlacement(mupdf, doc, page, found, found.placements[imgs.length - 1]);
    } finally {
      page.destroy();
    }
    expect(placementsOf(doc, 0).length).toBe(imgs.length - 1);
    expect(inkIn(doc, 0, [300, 700, 450, 750], 1)).toBe(0);
  });

  it("puts initials on several pages as one picture, upright on a rotated page", () => {
    const doc = openFixture("reportlab-form.pdf");
    const targets = [0, 1].map((p) => {
      const b = boundsOf(doc, p);
      return { pageIndex: p, matrix: [40, 0, 0, 20, b[2] - 60, b[3] - 40] as Matrix };
    });
    const placed = addImage(mupdf, doc, checked(picture("png", 120, 60)), targets, null);
    for (const t of targets) {
      const im = placementsOf(doc, t.pageIndex).at(-1)!;
      expect(im).toMatchObject({ movable: true, added: true });
      expectMatrix(im.matrix, t.matrix);
      expect(placed[t.pageIndex].imageIndex).toBe(placementsOf(doc, t.pageIndex).length - 1);
    }
    const saved = openBytes(download(doc));
    const nums = [0, 1].map((p) => {
      let n = -1;
      saved.findPage(p).get("Resources", "XObject").forEach((v, k) => {
        if (String(k).startsWith("PEImg")) n = v.asIndirect();
      });
      return n;
    });
    expect(nums[0]).toBeGreaterThan(0);
    expect(nums[1]).toBe(nums[0]);
  });

  it("on a page whose images are locked as unreadable, is placed, without an image index", () => {
    // past the walk's cap of 5,000 placements, a page's images are all listed locked ("unreadable")
    const doc = onePage("q 0.1 0 0 0.1 0 0 cm BI /W 1 /H 1 /CS /G /BPC 8 ID A EI Q\n".repeat(5001));
    const placed = addImage(mupdf, doc, checked(picture("png", 10, 10)), [{ pageIndex: 0, matrix: [50, 0, 0, 50, 150, 150] }], null);
    expect(placed).toEqual([{ pageIndex: 0, imageIndex: null }]);
    expect(placementsOf(doc, 0).every((p) => p.reason === "unreadable")).toBe(true);
    expect(inkIn(doc, 0, [150, 150, 200, 200], 1)).toBeGreaterThan(100);
  });
});

// ---------------------------------------------------------------------------------------------
// Picture files

/** A JPEG segment: marker, then the payload with its length. */
function segment(marker: number, payload: number[] | Uint8Array): number[] {
  const n = payload.length + 2;
  return [0xff, marker, n >> 8, n & 255, ...payload];
}
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** An EXIF APP1 payload with just an orientation tag, big- or little-endian. */
function exifPayload(orientation: number, littleEndian = false): number[] {
  const u16 = (v: number) => (littleEndian ? [v & 255, v >> 8] : [v >> 8, v & 255]);
  const u32 = (v: number) => (littleEndian ? [...u16(v & 0xffff), ...u16(v >>> 16)] : [...u16(v >>> 16), ...u16(v & 0xffff)]);
  return [
    ...ascii("Exif\0\0"), ...(littleEndian ? ascii("II") : ascii("MM")), ...u16(42), ...u32(8),
    ...u16(2), // two entries: Orientation, and GPSInfo (a pointer, standing for the private data)
    ...u16(0x0112), ...u16(3), ...u32(1), ...u16(orientation), 0, 0,
    ...u16(0x8825), ...u16(4), ...u32(1), ...u32(38),
    ...u32(0), ...ascii("GPS 44.2225 N 12.0408 E"),
  ];
}

/**
 * A photo from a phone: a JPEG of `w` x `h` (a red band on the left of the stored pixels) with an
 * EXIF orientation, XMP, a comment, an ICC profile, and a "motion photo" video after its end.
 */
function phonePhoto(orientation: number, { w = 200, h = 100, littleEndian = false } = {}) {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false);
  let plain: Uint8Array;
  try {
    const px = pix.getPixels(), st = pix.getStride();
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const o = y * st + x * 3, red = x < w / 4;
        [px[o], px[o + 1], px[o + 2]] = red ? [255, 0, 0] : [255, 255, 255];
      }
    plain = pix.asJPEG(90).slice();
  } finally {
    pix.destroy();
  }
  const icc = segment(0xe2, [...ascii("ICC_PROFILE\0"), 1, 1, ...srgbProfile()]);
  const bytes = new Uint8Array([
    ...plain.subarray(0, 2),
    ...segment(0xe1, exifPayload(orientation, littleEndian)),
    ...segment(0xe1, ascii("http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>Mario Rossi</x:xmpmeta>")),
    ...segment(0xfe, ascii("Taken at home")),
    ...icc,
    ...plain.subarray(2),
    ...ascii("ftypmp42 a video of a few seconds"),
  ]);
  return { bytes, plain, icc };
}
const has = (hay: Uint8Array, s: string) => Buffer.from(hay).includes(Buffer.from(s, "latin1"));

/** The decoded pixels of a picture file. */
function pixelsOf(bytes: Uint8Array) {
  const image = openImage(mupdf, bytes);
  try {
    const pix = image.toPixmap();
    try {
      return Buffer.from(pix.getPixels());
    } finally {
      pix.destroy();
    }
  } finally {
    image.destroy();
  }
}

describe("picture files (images.checkPicture)", () => {
  it("strip a JPEG's EXIF, XMP, comments and what follows its end, keep its profile, and decode to the same pixels", () => {
    const { bytes } = phonePhoto(6);
    expect(has(bytes, "Exif\0\0")).toBe(true);
    const clean = withoutMetadata(bytes);
    for (const gone of ["Exif\0\0", "GPS", "xmpmeta", "Taken at home", "ftypmp42"]) expect(has(clean, gone), gone).toBe(false);
    expect(has(clean, "ICC_PROFILE\0")).toBe(true);
    expect(has(clean, "JFIF")).toBe(has(bytes, "JFIF"));
    expect(pixelsOf(clean).equals(pixelsOf(bytes))).toBe(true);
    expect(clean[clean.length - 2]).toBe(0xff);
    expect(clean[clean.length - 1]).toBe(0xd9);
    // nothing to drop: the same bytes
    const png = picture("png", 20, 10);
    expect(withoutMetadata(png)).toBe(png);
    const { plain } = phonePhoto(1);
    expect(withoutMetadata(plain)).toBe(plain);
  });

  it("read the EXIF orientation in both byte orders, 1 when there is none or it cannot be read", () => {
    for (let o = 1; o <= 8; o++) {
      expect(jpegOrientation(phonePhoto(o).bytes)).toBe(o);
      expect(jpegOrientation(phonePhoto(o, { littleEndian: true }).bytes)).toBe(o);
    }
    expect(jpegOrientation(phonePhoto(1).plain)).toBe(1);
    expect(jpegOrientation(phonePhoto(9).bytes)).toBe(1);
    expect(jpegOrientation(picture("png", 20, 10))).toBe(1);
    const broken = phonePhoto(6).bytes.slice(0, 30);
    expect(jpegOrientation(broken)).toBe(1);
  });

  it("checkPicture: the picture as placed (bytes stripped, orientation, size as seen), refusals", () => {
    const { bytes } = phonePhoto(6);
    const p = checked(bytes);
    expect(p.orientation).toBe(6);
    expect([p.width, p.height]).toEqual([100, 200]); // stored 200 x 100, seen standing
    expect(has(p.bytes, "Exif")).toBe(false);
    const png = picture("png", 30, 20);
    const q = checked(png);
    expect(q).toEqual({ bytes: png, orientation: 1, width: 30, height: 20 });
    expect(q.bytes).toBe(png);
    expect(() => checked(new Uint8Array(0))).toThrow(BadPicture);
    expect(() => checked(new Uint8Array(MAX_IMAGE_BYTES + 1))).toThrow(/larger than/);
    expect(() => checked(new Uint8Array([1, 2, 3, 4, 5]))).toThrow(/cannot be read/);
  });

  it("a photo stored sideways is placed and replaced upright, still an added, movable picture", () => {
    const doc = openFixture("chrome-subset.pdf");
    const photo = checked(phonePhoto(6).bytes);
    // seen 100 wide x 200 tall at (100, 100): the red band, stored on the left, is on top as the phone showed it
    const target: Matrix = [100, 0, 0, 200, 100, 100];
    const [{ imageIndex }] = addImage(mupdf, doc, photo, [{ pageIndex: 0, matrix: target }], null);
    expect(colourAt(doc, 0, 150, 110)[1]).toBeLessThan(60);
    expect(colourAt(doc, 0, 150, 290)[1]).toBeGreaterThan(200);
    const im = placementsOf(doc, 0)[imageIndex!];
    expect(im).toMatchObject({ movable: true, added: true });
    expectMatrix(im.matrix, concat(ORIENTATION[6], target));
    // release 2's replace, given the orientation: fitted as seen, upright
    const other = openFixture("chrome-images.pdf");
    const page = other.loadPage(0);
    let index = -1;
    try {
      const found = findPlacements(mupdf, page);
      const old = found.placements.find((x) => x.movable && Math.abs(x.matrix[1]) < 1e-6 && x.matrix[0] > 0 && x.matrix[3] > 0)!;
      index = old.index;
      const image = openImage(mupdf, photo.bytes);
      try {
        replacePlacement(mupdf, other, page, found, old, image, photo.bytes, photo.orientation);
      } finally {
        image.destroy();
      }
    } finally {
      page.destroy();
    }
    const replaced = placementsOf(other, 0)[index];
    expect(replaced.pixels).toEqual([200, 100]);
    const [a, b, c, d] = replaced.matrix;
    expect(Math.abs(a)).toBeLessThan(1e-3); // the stored width runs down the page: turned a quarter
    expect(Math.abs(d)).toBeLessThan(1e-3);
    expect(b).toBeGreaterThan(0);
    expect(c).toBeLessThan(0);
    expect(Math.hypot(a, b) / Math.hypot(c, d)).toBeCloseTo(2, 3); // 100 x 200 as seen
  });

  it("stray bytes between segments (libjpeg skips them) do not keep the EXIF, nor lose the orientation", () => {
    const { bytes: photo, plain } = phonePhoto(6);
    const exifEnd = 2 + segment(0xe1, exifPayload(6)).length;
    const cases = {
      "after the EXIF": [...photo.subarray(0, exifEnd), 0, 0, 0, ...photo.subarray(exifEnd)],
      "right after the start of the image": [...photo.subarray(0, 2), 0x55, ...photo.subarray(2)],
      "a stuffed zero between segments": [...photo.subarray(0, exifEnd), 0xff, 0x00, 0x12, ...photo.subarray(exifEnd)],
    };
    for (const [name, list] of Object.entries(cases)) {
      const bytes = new Uint8Array(list);
      expect(pixelsOf(bytes).equals(pixelsOf(photo)), name).toBe(true); // MuPDF reads it all the same
      expect(jpegOrientation(bytes), name).toBe(6);
      const p = checked(bytes);
      expect(p.orientation, name).toBe(6);
      for (const gone of ["Exif\0\0", "GPS", "xmpmeta", "Taken at home", "ftypmp42"]) expect(has(p.bytes, gone), `${name}: ${gone}`).toBe(false);
      expect(pixelsOf(p.bytes).equals(pixelsOf(photo)), name).toBe(true);
    }
    // stray bytes and nothing else to drop: they go, the picture is the same
    const padded = new Uint8Array([...plain.subarray(0, 2), 0, 0, ...plain.subarray(2)]);
    const clean = withoutMetadata(padded);
    expect(clean).not.toBe(padded);
    expect(clean.length).toBe(plain.length);
    expect(pixelsOf(clean).equals(pixelsOf(plain))).toBe(true);
    // a segment that runs past the end of the file: nothing after it can be read, nor kept
    const overrun = new Uint8Array([...plain.subarray(0, 2), 0xff, 0xe1, 0xff, 0xf0, ...ascii("Exif\0\0 GPS 44.2225 N"), ...plain.subarray(2)]);
    expect(has(withoutMetadata(overrun), "GPS")).toBe(false);
    expect(() => checked(overrun)).toThrow(BadPicture);
    // a JFIF extension (JFXX) holds only a thumbnail: it goes, JFIF itself stays
    const jfxx = new Uint8Array([...plain.subarray(0, 2), ...segment(0xe0, [...ascii("JFXX\0"), 0x13, ...ascii("THUMBNAIL")]), ...plain.subarray(2)]);
    const p = checked(jfxx);
    expect(has(p.bytes, "THUMBNAIL")).toBe(false);
    expect(has(p.bytes, "JFIF")).toBe(has(plain, "JFIF"));
    expect(pixelsOf(p.bytes).equals(pixelsOf(plain))).toBe(true);
  });

  it("a picture placed or put in turned by its EXIF orientation is replaced as seen: an upright one is not drawn a quarter turn off", () => {
    /** Replaces placement `index` of page 1 with `picture`, as the session does. */
    const replaceAt = (doc: mupdf.PDFDocument, index: number, pic: Picture) => {
      const page = doc.loadPage(0);
      try {
        const found = findPlacements(mupdf, page);
        const image = openImage(mupdf, pic.bytes);
        try {
          replacePlacement(mupdf, doc, page, found, found.placements[index], image, pic.bytes, pic.orientation);
        } finally {
          image.destroy();
        }
      } finally {
        page.destroy();
      }
    };
    const sideways = checked(phonePhoto(6).bytes); // stored 200 x 100, seen 100 x 200
    const upright = checked(picture("jpeg", 300, 100));
    const seen: Matrix = [100, 0, 0, 200, 100, 100];
    // added by the app
    const doc = openFixture("chrome-subset.pdf");
    const [{ imageIndex }] = addImage(mupdf, doc, sideways, [{ pageIndex: 0, matrix: seen }], null);
    expect(has(saveBytes(doc), "/PEOrientation 6")).toBe(true);
    replaceAt(doc, imageIndex!, upright);
    expectMatrix(placementsOf(doc, 0)[imageIndex!].matrix, containFit(seen, 300, 100)); // a band across the frame
    // moved first, saved and opened again: the turn goes with it
    const moved = openFixture("chrome-subset.pdf");
    const [{ imageIndex: k }] = addImage(mupdf, moved, sideways, [{ pageIndex: 0, matrix: seen }], null);
    const page = moved.loadPage(0);
    try {
      const found = findPlacements(mupdf, page);
      transformPlacement(mupdf, moved, page, found, found.placements[k!], concat(ORIENTATION[6], [100, 0, 0, 200, 200, 300]));
    } finally {
      page.destroy();
    }
    const again = openBytes(download(moved));
    replaceAt(again, k!, upright);
    expectMatrix(placementsOf(again, 0)[k!].matrix, containFit([100, 0, 0, 200, 200, 300], 300, 100));
    // a picture of the file replaced by the sideways photo, then by an upright picture
    const other = openFixture("chrome-images.pdf");
    const index = placementsOf(other, 0).findIndex((x) => x.movable && Math.abs(x.matrix[1]) < 1e-6 && x.matrix[0] > 0 && x.matrix[3] > 0);
    replaceAt(other, index, sideways);
    const photoSeen = concat(invert(ORIENTATION[6]), placementsOf(other, 0)[index].matrix);
    expect(Math.abs(photoSeen[1]) + Math.abs(photoSeen[2])).toBeLessThan(1e-3); // upright as seen
    replaceAt(other, index, upright);
    expectMatrix(placementsOf(other, 0)[index].matrix, containFit(photoSeen, 300, 100));
  });
});
