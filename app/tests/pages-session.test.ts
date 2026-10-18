// Page operations, the other PDF, pictures as pages and Riprendi through EngineSession (release 4),
// in Node on the worker's mupdf build. Every page operation is a logged edit among line, field,
// text and picture edits: a long history across a checkpoint is undone and redone step by step,
// every state compared with the one recorded going forward and every layout with the one the
// step should give (by page object: where each page was), then replayed fresh from the original;
// each layout comes from the operation alone, also when the two paths to a state numbered their
// objects differently (a save or a redo past a checkpoint in between). An insert that brings
// layers draws them as the source has them whatever path the history took; an insert logs only
// the chosen pages of the other PDF, as an insert from the whole file would make them, and
// nothing of its document information or XMP, in time linear in its pages; an insert from a
// password-protected PDF replays with no password, and Riprendi keeps nothing while it is in the
// log; a part of the document is written out through the save path (extractPages) and the
// document stays as it was; a download's fonts keep only the glyphs its pages still show; a new
// document made from pictures (JPEG and 1-bit) opens as the session and saves as PDF/A, and
// Riprendi keeps it with no edits, across resumes; exportSession and resumeSession give back the
// same document after a structured clone, stop at an edit that no longer fits, and keep nothing
// of a document that needed a password; every request is checked; a page operation that fails
// half way is rolled back. pages.ts itself is tested in pages.test.ts.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as mupdf from "mupdf";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeWithFallbacks, fontKey, releaseFallbackFonts, renderPixmap, subsetFallbackFonts } from "../src/engine/core.js";
import { insertPages } from "../src/engine/pages";
import { MAX_SOURCE_BYTES, type FieldValue, type HistoryState, type PageLayout, type PagePicture, type PagesEdit, type TextStyle } from "../src/engine/protocol";
import {
  CHECKPOINT_EVERY, EngineSession, LOG_VERSION, SessionError, layoutFrom, pagesOf, undoneFrom as undoFrom, type LoggedEdit, type PageOpEdit, type SessionLog,
} from "../src/engine/session";
import { png1 } from "../src/scan/png1";
import { addStream, formPdf, layersPdf, openPdf, plainPdf, richPdf, saveBytes, smallPng } from "./helpers/richPdf";

/** Makes pages.ts fail on purpose: "after" a delete or move that did its work, or "tree" (a refusal of its own) before it. */
const pagesSpy = vi.hoisted(() => ({ fail: "no" as "no" | "after" | "tree" }));
vi.mock("../src/engine/pages", async (importOriginal) => {
  const pages = await importOriginal<typeof import("../src/engine/pages")>();
  const failing = <A extends unknown[], R>(fn: (...args: A) => R) => (...args: A): R => {
    if (pagesSpy.fail === "tree") throw new pages.PagesError("The page tree cannot be read (test)", "not-editable");
    const result = fn(...args);
    if (pagesSpy.fail === "after") throw new Error("injected failure after a half-done page operation");
    return result;
  };
  return { ...pages, deletePages: failing(pages.deletePages), movePages: failing(pages.movePages) };
});
beforeEach(() => {
  pagesSpy.fail = "no";
});

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const RICH = richPdf();
const SANS: TextStyle = { size: 12, color: [0, 0, 0], family: "sans", bold: false, italic: false };
const text = (t: string): FieldValue => ({ kind: "text", text: t });
const r2 = (v: number) => Math.round(v * 100) / 100 || 0; // (no -0)

/** A session with `bytes` open (throws if it does not open). */
function session(bytes: Uint8Array | ArrayBuffer, password?: string): EngineSession {
  const s = new EngineSession(mupdf);
  const r = s.open(bytes, password);
  if (!r.ok) throw new Error(`did not open: ${r.reason}`);
  return s;
}

/** The session's working document. */
const docOf = (s: EngineSession) => (s as unknown as { doc: mupdf.PDFDocument }).doc;
/** Its checkpoints (to see that a resume takes them). */
const checkpointsOf = (s: EngineSession) => (s as unknown as { checkpoints: unknown[] }).checkpoints;
/** Applies a logged edit as a replay does (the session's private apply). */
const applyOf = (s: EngineSession) => (s as unknown as { apply(doc: mupdf.PDFDocument, e: LoggedEdit): boolean }).apply.bind(s);

function expectSessionError(fn: () => unknown, code: string) {
  let error: unknown;
  try {
    fn();
  } catch (e) {
    error = e;
  }
  expect(error, `expected a SessionError "${code}"`).toBeInstanceOf(SessionError);
  expect((error as SessionError).code).toBe(code);
}

/**
 * What the user can see and do on every page: its size, lines (text, place, added), images
 * (place, added, movable), field values, the app's texts and a render (scale 0.4, after emptying
 * MuPDF's store).
 */
function fingerprint(s: EngineSession) {
  const out: unknown[] = [];
  for (let p = 0; p < docOf(s).countPages(); p++) {
    mupdf.emptyStore();
    const shown = s.render(p, 0.4);
    out.push({
      size: [shown.width, shown.height],
      lines: s.lines(p).map((l) => [l.text.trim(), r2(l.bbox[0]), r2(l.bbox[1]), l.added]),
      images: s.images(p).map((i) => [i.matrix.map(r2), i.added, i.movable]),
      fields: s.fields(p).map((f) => [f.name, f.value]),
      added: s.addedTexts(p).map((t) => [t.id, t.text]),
      render: createHash("sha1").update(shown.rgba).digest("hex"),
    });
  }
  return out;
}

/** Each page's lines, trimmed and joined. */
const pageTexts = (s: EngineSession) =>
  Array.from({ length: docOf(s).countPages() }, (_, p) => s.lines(p).map((l) => l.text.trim()).join(" | "));

const lineOf = (s: EngineSession, page: number, needle: string) => {
  const line = s.lines(page).find((l) => l.text.includes(needle));
  if (!line) throw new Error(`no line "${needle}" on page ${page + 1}: ${JSON.stringify(s.lines(page).map((l) => l.text))}`);
  return line.index;
};

/** Each page's bounds, rounded to 0.01 pt. */
const boundsOf = (s: EngineSession) =>
  Array.from({ length: docOf(s).countPages() }, (_, i) => {
    const page = docOf(s).loadPage(i);
    try {
      return page.getBounds().map(r2);
    } finally {
      page.destroy();
    }
  });

/** The full names of the fields with a widget on any page. */
const fieldNames = (s: EngineSession) =>
  [...new Set(Array.from({ length: docOf(s).countPages() }, (_, p) => s.fields(p).map((f) => f.name)).flat())].sort();

/** What undoing a step that made `layout` out of `before` pages gives as `from`: each page back where the step had put it, or null when it had deleted it. */
const undoneFrom = (layout: PageLayout, before: number) =>
  Array.from({ length: before }, (_, j) => {
    const k = layout.from.indexOf(j);
    return k < 0 ? null : k;
  });

/** A JPEG of w × h pixels in one colour, with a darker band (so a render shows where it is). */
function jpeg(w: number, h: number, colour: [number, number, number] = [200, 120, 40]): Uint8Array {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false);
  try {
    const px = pix.getPixels(), stride = pix.getStride();
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const o = y * stride + x * 3, band = y > h / 3 && y < h / 2 ? 0.5 : 1;
        for (let k = 0; k < 3; k++) px[o + k] = colour[k] * band;
      }
    return pix.asJPEG(85).slice();
  } finally {
    pix.destroy();
  }
}

/** A 1-bit black-and-white picture of w × h pixels (a frame and stripes), as the scan makes it (png1). */
function bwPicture(w: number, h: number, dpi: number): Promise<Uint8Array> {
  const row = (w + 7) >> 3;
  const bits = new Uint8Array(row * h).fill(0xff); // bit 1 = white
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const ink = x < 4 || y < 4 || x >= w - 4 || y >= h - 4 || (y % 40 < 6 && x > 30 && x < w - 30);
      if (ink) bits[y * row + (x >> 3)] &= ~(0x80 >> (x & 7));
    }
  return png1(bits, w, h, dpi);
}

const picture = (bytes: Uint8Array, width: number, height: number, dpi: number, alt?: string): PagePicture =>
  ({ bytes: bytes.slice().buffer, width, height, dpi, ...(alt === undefined ? {} : { alt }) });

/** The /Alt of every Figure in the working document's structure tree, in tree order. */
function figureAlts(s: EngineSession): string[] {
  const out: string[] = [];
  const visit = (o: mupdf.PDFObject, depth: number) => {
    if (depth > 64) return;
    if (o.isArray()) for (let i = 0; i < o.length; i++) visit(o.get(i), depth + 1);
    else if (o.isDictionary()) {
      const type = o.get("S");
      if (type.isName() && type.asName() === "Figure") out.push(o.get("Alt").isString() ? o.get("Alt").asString() : "");
      if (!o.get("K").isNull()) visit(o.get("K"), depth + 1);
    }
  };
  const root = docOf(s).getTrailer().get("Root").get("StructTreeRoot");
  if (root.isDictionary()) visit(root.get("K"), 0);
  return out;
}

/** The bookmarks' titles at the top level. */
const outlineTitles = (s: EngineSession) => (docOf(s).loadOutline() ?? []).map((o) => o.title);
/** A document's bookmarks as MuPDF reads them. */
type Outline = NonNullable<ReturnType<mupdf.PDFDocument["loadOutline"]>>;

/** Bytes as Latin-1 text (to look for strings in a file). */
const latin1 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return s;
};

/** `bytes` opened in a fresh session (another viewer). */
const reopen = (bytes: ArrayBuffer) => session(bytes);

// ---------------------------------------------------------------------------------------------

describe("page operations as edits", () => {
  it("go with line, field, text and picture edits; undo all and redo all pass the same states and layouts; a fresh replay ends the same", () => {
    const s = session(RICH);
    const states = [fingerprint(s)];
    const counts = [4];
    /** Each edit's result: the layout of a page operation, or null. */
    const layouts: (PageLayout | null)[] = [null];
    const changed: number[][] = [[]];
    const step = <R extends HistoryState>(run: () => R): R => {
      const r = run();
      expect(r.editCount).toBe(states.length);
      states.push(fingerprint(s));
      counts.push(docOf(s).countPages());
      layouts.push(r.layout ?? null);
      changed.push(r.changedPages);
      return r;
    };

    // Release 3's edits on the pages as they are (P1 P2 P3 P4).
    step(() => s.addText(1, [72, 400], "Mario Rossi", SANS));
    step(() => s.setField("nome", text("Mario")));
    step(() => s.addImage(smallPng(), [{ pageIndex: 2, matrix: [120, 0, 0, 60, 300, 400] }], "Firma"));

    // Move: P4 P3 P2 P1. Nothing is drawn again, the pages follow their objects.
    const moved = step(() => s.editPages({ kind: "move", order: [3, 2, 1, 0] }));
    expect(moved.layout!.from).toEqual([3, 2, 1, 0]);
    expect(moved.changedPages).toEqual([]);
    expect(pageTexts(s)[2]).toContain("Mario Rossi");
    step(() => s.replaceLine(2, lineOf(s, 2, "Pagina 2"), "Seconda"));

    // Rotate the first page (P4, already turned 90° by its /Pages node): 180° now.
    const before = s.render(0, 0.4);
    const turned = step(() => s.editPages({ kind: "rotate", pages: [0], by: 90 }));
    expect(turned.layout!.from).toEqual([0, 1, 2, 3]);
    expect(turned.changedPages).toEqual([0]);
    expect([turned.layout!.pages[0].bounds[2], turned.layout!.pages[0].bounds[3]].map(Math.round)).toEqual([600, 800]);
    expect([before.width, before.height]).toEqual([s.render(0, 0.4).height, s.render(0, 0.4).width]);

    // Duplicate P2 after it: its fields come as new ones, renamed; editing the copy leaves P2.
    const copied = step(() => s.editPages({ kind: "duplicate", pages: [2], at: 3 }));
    expect(copied.layout!.from).toEqual([0, 1, 2, null, 3]);
    expect(copied.changedPages).toEqual([3]);
    expect(copied.report).toEqual({ linksRemoved: 0, fieldsRenamed: 4, signaturesAdded: 0 });
    expect(copied.layout!.form!.fields).toBeGreaterThan(moved.layout!.form!.fields);
    step(() => s.setField("nome_copia1", text("Luigi")));
    expect(checkpointsOf(s)).toHaveLength(1); // after edit 8
    step(() => s.editAddedText(3, 1, { text: "Copia" }));
    expect(pageTexts(s)[2]).toContain("Mario Rossi");
    expect(pageTexts(s)[3]).toContain("Copia");
    expect(s.fields(2).find((f) => f.name === "nome")!.value).toBe("Mario");

    // A blank page first: the size of the page after it (there is none before), as seen.
    const blank = step(() => s.editPages({ kind: "blank", at: 0 }));
    expect(blank.layout!.from).toEqual([null, 0, 1, 2, 3, 4]);
    expect(blank.changedPages).toEqual([0]);
    expect(blank.layout!.pages[0].bounds.map(Math.round)).toEqual(blank.layout!.pages[1].bounds.map(Math.round));
    step(() => s.addText(0, [72, 100], "Pagina nuova", SANS));

    // All the pages of another PDF at the end, with a bookmark.
    const other = s.openSource(plainPdf(["Allegato A", "Allegato B"]));
    if (!other.ok) throw new Error("the other PDF did not open");
    const inserted = step(() => s.editPages({ kind: "insert", at: 6, source: other.source, pages: "all", title: "Allegati" }));
    expect(inserted.layout!.from).toEqual([0, 1, 2, 3, 4, 5, null, null]);
    expect(inserted.changedPages).toEqual([6, 7]);
    expect(inserted.report).toEqual({ linksRemoved: 0, fieldsRenamed: 0, signaturesAdded: 0 });
    expect(outlineTitles(s)).toContain("Allegati");
    expect(pageTexts(s).slice(6)).toEqual(["Allegato A", "Allegato B"]);

    // A picture as a page of its own, second: 400 × 300 pixels at 100 dpi are 288 × 216 points.
    const pictured = step(() => s.editPages({ kind: "pictures", at: 1, pictures: [picture(jpeg(400, 300), 400, 300, 100)] }));
    expect(pictured.layout!.from).toEqual([0, null, 1, 2, 3, 4, 5, 6, 7]);
    expect(pictured.changedPages).toEqual([1]);
    expect(pictured.layout!.pages[1].bounds.map(r2)).toEqual([0, 0, 288, 216]);
    expect(s.images(1).map((i) => [i.matrix.map(r2), i.added, i.movable])).toEqual([[[288, 0, 0, 216, 0, 0], true, true]]);

    // Delete P2 (index 4): its field goes from the form, its copy stays.
    expect(pageTexts(s)[4]).toContain("Mario Rossi");
    const deleted = step(() => s.editPages({ kind: "delete", pages: [4] }));
    expect(deleted.layout!.from).toEqual([0, 1, 2, 3, 5, 6, 7, 8]);
    expect(deleted.changedPages).toEqual([]);
    expect(fieldNames(s)).toContain("nome_copia1");
    expect(fieldNames(s)).not.toContain("nome");
    expect(deleted.layout!.form!.fields).toBe(copied.layout!.form!.fields - 3); // (nome, accetto, scelta: the password field is not one to fill)
    expect(pageTexts(s).join(" ")).not.toContain("Mario Rossi");
    const last = states.length - 1;
    expect(last).toBe(14);

    // Undo all: every state again, and each page operation's undo gives the pages back where they were.
    for (let k = last; k > 0; k--) {
      const r = s.undo();
      expect(r.editCount).toBe(k - 1);
      expect(fingerprint(s), `after undoing edit ${k}`).toEqual(states[k - 1]);
      const layout = layouts[k];
      if (!layout) {
        expect(r.layout).toBeUndefined();
        continue;
      }
      expect(r.layout!.from, `undo of edit ${k}`).toEqual(undoneFrom(layout, counts[k - 1]));
      expect(r.layout!.pages).toHaveLength(counts[k - 1]);
      expect(r.changedPages).toEqual(k === 6 ? [0] : []); // (the turn of edit 6 shows on that page again)
    }
    // Redo all: the same states, and the same layouts as when the edits were new.
    for (let k = 1; k <= last; k++) {
      const r = s.redo();
      expect(fingerprint(s), `after redoing edit ${k}`).toEqual(states[k]);
      expect(r.layout ?? null, `redo of edit ${k}`).toEqual(layouts[k]);
      expect(r.changedPages).toEqual(changed[k]);
    }

    // The log replayed on the original from scratch ends where the session is.
    const fresh = session(RICH);
    for (const e of s.edits()) applyOf(fresh)(docOf(fresh), e);
    expect(fingerprint(fresh)).toEqual(states[last]);

    // Saved, as a normal PDF and as PDF/A: the pages as they are, nothing of P2.
    const saved = reopen(s.save().bytes);
    expect(pageTexts(saved).map((t) => t.split(" | ")[0])).toEqual(pageTexts(s).map((t) => t.split(" | ")[0]));
    expect(pageTexts(saved).join(" ")).not.toContain("Mario Rossi");
    expect(s.pdfaCheck().blockers).toEqual([]);
    expect(s.save({ format: "pdfa-2b", password: { mode: "none" } }).pdfa!.blockers).toEqual([]);
    expect(fingerprint(s)).toEqual(states[last]);
  });

  it("says which pages each operation changed (pagesOf), as indices after it", () => {
    const op = (e: object) => pagesOf({ kind: "pages", ...e } as LoggedEdit);
    const pic = { picture: { bytes: new Uint8Array(1), orientation: 1, width: 1, height: 1 }, size: [10, 10] as [number, number], alt: null };
    expect(op({ op: "move", order: [1, 0] })).toEqual([]);
    expect(op({ op: "delete", pages: [2] })).toEqual([]);
    expect(op({ op: "rotate", pages: [3, 1], by: 90 })).toEqual([1, 3]);
    expect(op({ op: "blank", at: 2, size: [10, 10] })).toEqual([2]);
    expect(op({ op: "duplicate", pages: [0, 4], at: 5 })).toEqual([5, 6]);
    expect(op({ op: "insert", at: 1, source: new Uint8Array(1), pages: [0, 1, 2], title: null })).toEqual([1, 2, 3]);
    expect(op({ op: "pictures", at: 0, pictures: [pic, pic] })).toEqual([0, 1]);
  });

  it("works out each operation's layout from the operation alone, and its undo's (P3)", () => {
    const pic = { picture: { bytes: new Uint8Array(1), orientation: 1, width: 1, height: 1 }, size: [10, 10] as [number, number], alt: null };
    const from = (e: object, count: number) => layoutFrom({ kind: "pages", ...e } as PageOpEdit, count);
    const cases: [object, number, (number | null)[], (number | null)[]][] = [
      // [operation, pages before, from, the undo's from]
      [{ op: "move", order: [2, 0, 3, 1] }, 4, [2, 0, 3, 1], [1, 3, 0, 2]],
      [{ op: "rotate", pages: [1], by: 90 }, 3, [0, 1, 2], [0, 1, 2]],
      [{ op: "delete", pages: [3, 0] }, 5, [1, 2, 4], [null, 0, 1, null, 2]],
      [{ op: "blank", at: 1, size: [10, 10] }, 3, [0, null, 1, 2], [0, 2, 3]],
      [{ op: "blank", at: 3, size: [10, 10] }, 3, [0, 1, 2, null], [0, 1, 2]],
      [{ op: "duplicate", pages: [2, 0], at: 0 }, 3, [null, null, 0, 1, 2], [2, 3, 4]],
      [{ op: "insert", at: 2, source: new Uint8Array(1), pages: [0, 1, 2], title: null }, 2, [0, 1, null, null, null], [0, 1]],
      [{ op: "pictures", at: 1, pictures: [pic, pic] }, 2, [0, null, null, 1], [0, 3]],
    ];
    for (const [e, count, forward, back] of cases) {
      expect(from(e, count), JSON.stringify(e)).toEqual(forward);
      expect(undoFrom(forward, count), JSON.stringify(e)).toEqual(back);
    }
  });

  it("gives an undo the right layout after a save, whatever objects the two paths made (P3, repro A)", () => {
    // The same picture on page 1, a download, then on page 2: the working document embeds it
    // again (a snapshot forgets what was embedded), the rebuilt one shares it, so their later
    // objects have other numbers.
    const s = session(plainPdf(["A", "B", "C"]));
    s.addImage(smallPng(), [{ pageIndex: 0, matrix: [100, 0, 0, 50, 100, 100] }], null);
    s.save();
    s.addImage(smallPng(), [{ pageIndex: 1, matrix: [100, 0, 0, 50, 100, 100] }], null);
    expect(s.editPages({ kind: "duplicate", pages: [0, 1], at: 3 }).layout.from).toEqual([0, 1, 2, null, null]);
    expect(s.editPages({ kind: "move", order: [4, 3, 2, 1, 0] }).layout.from).toEqual([4, 3, 2, 1, 0]);
    const undone = s.undo();
    expect(undone.layout!.from).toEqual([4, 3, 2, 1, 0]);
    expect(undone.layout!.pages).toHaveLength(5);
    expect(s.undo().layout!.from).toEqual([0, 1, 2]);
    expect(s.redo().layout!.from).toEqual([0, 1, 2, null, null]);
    expect(s.redo().layout!.from).toEqual([4, 3, 2, 1, 0]);
  });

  it("gives an undo the right layout after a redo past a checkpoint (P3, repro B)", () => {
    const s = session(plainPdf(["A", "B", "C"]));
    s.addImage(smallPng(), [{ pageIndex: 0, matrix: [100, 0, 0, 50, 100, 100] }], null);
    for (let k = 1; k < CHECKPOINT_EVERY; k++) s.addText(2, [72, 100 + 20 * k], `Riga ${k}`, SANS);
    expect(checkpointsOf(s)).toHaveLength(1);
    s.undo();
    s.undo();
    s.redo();
    s.redo(); // past the checkpoint taken at edit 8: nothing opened again
    s.addImage(smallPng(), [{ pageIndex: 1, matrix: [100, 0, 0, 50, 100, 100] }], null);
    s.editPages({ kind: "duplicate", pages: [0, 1], at: 3 });
    s.editPages({ kind: "move", order: [4, 3, 2, 1, 0] });
    expect(s.undo().layout!.from).toEqual([4, 3, 2, 1, 0]);
    expect(s.undo().layout!.from).toEqual([0, 1, 2]);
  });

  it("counts a move that leaves every page where it is (the UI records every page operation)", () => {
    const s = session(plainPdf(["Uno", "Due"]));
    const r = s.editPages({ kind: "move", order: [0, 1] });
    expect(r).toMatchObject({ editCount: 1, changedPages: [] });
    expect(r.layout.from).toEqual([0, 1]);
    expect(s.undo().layout!.from).toEqual([0, 1]);
  });

  it("makes a blank page the size asked, or of the page before it", () => {
    const s = session(plainPdf(["Uno", "Due"], [300, 400]));
    expect(s.editPages({ kind: "blank", at: 2 }).layout.pages[2].bounds.map(Math.round)).toEqual([0, 0, 300, 400]);
    expect(s.editPages({ kind: "blank", at: 1, size: [842, 595] }).layout.pages[1].bounds.map(Math.round)).toEqual([0, 0, 842, 595]);
    expect(s.edits().map((e) => (e.kind === "pages" && e.op === "blank" ? e.size.map(Math.round) : null))).toEqual([[300, 400], [842, 595]]);
  });

  it("refuses what cannot be, with nothing done", () => {
    const s = session(RICH);
    s.addText(0, [72, 400], "Prima", SANS);
    const other = s.openSource(plainPdf(["Altro"]));
    if (!other.ok) throw new Error("the other PDF did not open");
    const jpg = jpeg(40, 30);
    const bad: unknown[] = [
      null, 7, "move", {}, { kind: "shuffle" },
      { kind: "move", order: [0, 1, 2] }, { kind: "move", order: [0, 1, 2, 2] }, { kind: "move", order: [0, 1, 2, 4] },
      { kind: "move", order: [0, 1, 2, 3.5] }, { kind: "move", order: "0123" },
      { kind: "delete", pages: [0, 1, 2, 3] }, { kind: "delete", pages: [] }, { kind: "delete", pages: [1, 1] }, { kind: "delete", pages: [-1] },
      { kind: "blank", at: -1 }, { kind: "blank", at: 5 }, { kind: "blank", at: 1, size: [0, 100] }, { kind: "blank", at: 1, size: [100, 20_000] },
      { kind: "blank", at: 1, size: [100] }, { kind: "blank", at: "1" },
      { kind: "duplicate", pages: [4], at: 0 }, { kind: "duplicate", pages: [0], at: 9 },
      { kind: "rotate", pages: [0], by: 45 }, { kind: "rotate", pages: [0], by: -90 }, { kind: "rotate", pages: [9], by: 90 },
      { kind: "insert", at: 0, source: other.source + 1, pages: "all", title: null },
      { kind: "insert", at: 0, source: other.source, pages: [1], title: null },
      { kind: "insert", at: 0, source: other.source, pages: "some", title: null },
      { kind: "insert", at: 0, source: other.source, pages: "all", title: 5 },
      { kind: "insert", at: 0, source: other.source, pages: "all", title: "x".repeat(1001) },
      { kind: "insert", at: 7, source: other.source, pages: "all", title: null },
      { kind: "pictures", at: 0, pictures: [] }, { kind: "pictures", at: 0, pictures: "x" },
      { kind: "pictures", at: 0, pictures: [picture(jpg, 40, 30, 0)] },
      { kind: "pictures", at: 0, pictures: [picture(jpg, 41, 33, 72)] }, // not its size
      { kind: "pictures", at: 0, pictures: [picture(jpg, 40.5, 30, 72)] },
      { kind: "pictures", at: 0, pictures: [picture(jpg, 40, 30, 0.1)] }, // 28,800 points wide
      { kind: "pictures", at: 0, pictures: [picture(new TextEncoder().encode("not a picture"), 40, 30, 72)] },
      { kind: "pictures", at: 0, pictures: [{ width: 40, height: 30, dpi: 72 }] },
      { kind: "pictures", at: 0, pictures: [picture(jpg, 40, 30, 72, "x".repeat(1001))] },
      { kind: "pictures", at: 0, pictures: [picture(jpg, 8000, 6000, 600)] }, // too many pixels
    ];
    const was = fingerprint(s);
    for (const edit of bad) {
      expectSessionError(() => s.editPages(edit as PagesEdit), "bad-request");
      expect(s.edits(), JSON.stringify(edit)).toHaveLength(1);
    }
    expect(fingerprint(s)).toEqual(was);
    expect(s.undo().editCount).toBe(0);
  });

  it("rolls back a page operation that fails half way, keeping a refusal's code", () => {
    const s = session(RICH);
    s.addText(0, [72, 400], "Prima", SANS);
    const was = fingerprint(s);
    pagesSpy.fail = "after";
    expectSessionError(() => s.editPages({ kind: "delete", pages: [1, 2] }), "edit-failed");
    expect(fingerprint(s)).toEqual(was);
    expect(s.edits()).toHaveLength(1);
    pagesSpy.fail = "tree";
    expectSessionError(() => s.editPages({ kind: "move", order: [1, 0, 2, 3] }), "not-editable");
    expect(fingerprint(s)).toEqual(was);
    pagesSpy.fail = "no";
    expect(s.editPages({ kind: "delete", pages: [1, 2] }).layout.from).toEqual([0, 3]);
    s.undo();
    pagesSpy.fail = "after";
    expectSessionError(() => s.redo(), "edit-failed");
    expect(fingerprint(s)).toEqual(was);
    pagesSpy.fail = "no";
    expect(s.redo().layout!.from).toEqual([0, 3]);
  });

  it("still shows the other PDF and writes a part when the session is broken", () => {
    const s = session(plainPdf(["Uno", "Due", "Tre"]));
    s.editPages({ kind: "delete", pages: [0] });
    const other = s.openSource(plainPdf(["Altro"]));
    if (!other.ok) throw new Error("did not open");
    pagesSpy.fail = "after"; // the new delete fails, and so does replaying the first one
    expectSessionError(() => s.editPages({ kind: "delete", pages: [0] }), "broken");
    expectSessionError(() => s.lines(0), "broken");
    expect(s.renderSource(other.source, 0, 0.2).width).toBeGreaterThan(0);
    pagesSpy.fail = "no";
    expect(pageTexts(reopen(s.extractPages([1]).bytes))).toEqual(["Tre"]); // the last good state, rebuilt
  });

  it("answers quickly on 300 pages, the layout included", () => {
    const s = session(plainPdf(Array.from({ length: 300 }, (_, i) => `Pagina ${i + 1}`)));
    const time = (what: string, run: () => HistoryState) => {
      const t = performance.now();
      const r = run();
      const ms = performance.now() - t;
      console.log(`300 pages, ${what}: ${ms.toFixed(1)} ms`);
      expect(ms).toBeLessThan(5000);
      return r;
    };
    const reversed = Array.from({ length: 300 }, (_, i) => 299 - i);
    expect(time("reverse", () => s.editPages({ kind: "move", order: reversed })).layout!.from).toEqual(reversed);
    expect(time("delete 3", () => s.editPages({ kind: "delete", pages: [0, 150, 299] })).layout!.pages).toHaveLength(297);
    expect(time("undo the delete", () => s.undo()).layout!.pages).toHaveLength(300);
    expect(time("duplicate 10", () => s.editPages({ kind: "duplicate", pages: [...Array(10).keys()], at: 300 })).layout!.pages).toHaveLength(310);
    expect(pageTexts(s)[300]).toBe("Pagina 300");
  });

  it("makes the same file from the same operations, whatever session made them", () => {
    const run = () => {
      const s = session(RICH);
      const other = s.openSource(plainPdf(["Allegato"]));
      if (!other.ok) throw new Error("the other PDF did not open");
      s.editPages({ kind: "move", order: [1, 0, 3, 2] });
      s.editPages({ kind: "duplicate", pages: [0, 2], at: 4 });
      s.editPages({ kind: "insert", at: 2, source: other.source, pages: "all", title: "Allegato" });
      s.editPages({ kind: "pictures", at: 0, pictures: [picture(jpeg(60, 80), 60, 80, 72)] });
      s.editPages({ kind: "delete", pages: [3, 5] });
      return new Uint8Array(s.save().bytes);
    };
    expect(createHash("sha1").update(run()).digest("hex")).toBe(createHash("sha1").update(run()).digest("hex"));
  });
});

// ---------------------------------------------------------------------------------------------

describe("pictures as pages", () => {
  it("are a Figure described in the document's language on a tagged document, or as asked", () => {
    const s = session(RICH); // tagged, /Lang it
    s.editPages({ kind: "pictures", at: 0, pictures: [picture(jpeg(100, 140), 100, 140, 50), picture(jpeg(140, 100), 140, 100, 50, "Ricevuta")] });
    expect(figureAlts(s)).toEqual(["Pagina scansionata", "Ricevuta"]);
    expect(s.edits()[0]).toMatchObject({ kind: "pages", op: "pictures", pictures: [{ alt: "Pagina scansionata" }, { alt: "Ricevuta" }] });
    // Landscape where the picture is: 140 × 100 pixels at 50 dpi.
    expect(boundsOf(s)[1]).toEqual([0, 0, 201.6, 144]);

    const english = openPdf(RICH);
    let bytes: Uint8Array;
    try {
      english.getTrailer().get("Root").put("Lang", english.newString("en-GB"));
      bytes = saveBytes(english);
    } finally {
      english.destroy();
    }
    const t = session(bytes);
    t.editPages({ kind: "pictures", at: 2, pictures: [picture(jpeg(100, 140), 100, 140, 50)] });
    expect(figureAlts(t)).toEqual(["Scanned page"]);
  });

  it("make a new document: a JPEG page and a 1-bit page, each the picture's size, saved as PDF and PDF/A", async () => {
    const s = session(plainPdf(["Vecchio"]));
    s.addText(0, [72, 400], "Non scaricato", SANS);
    const other = s.openSource(plainPdf(["Altro"]));
    if (!other.ok) throw new Error("the other PDF did not open");
    // Refused before anything is done: the document stays.
    expectSessionError(() => s.newFromPictures([]), "bad-request");
    expectSessionError(() => s.newFromPictures([picture(jpeg(40, 30), 40, 33, 72)]), "bad-request");
    expect(pageTexts(s)[0]).toContain("Non scaricato");

    const bw = await bwPicture(400, 566, 48); // 600 × 849 points
    const r = s.newFromPictures([picture(jpeg(827, 1169), 827, 1169, 100), picture(bw, 400, 566, 48)]);
    if (!r.ok) throw new Error(`did not open: ${r.reason}`);
    expect(r).toMatchObject({ pageCount: 2, encrypted: false, needsPassword: false, canKeepPassword: false, pdfa: null, signatures: 0, form: null, title: null });
    expect(r.pages.map((p) => p.bounds.map(r2))).toEqual([[0, 0, 595.44, 841.68], [0, 0, 600, 849]]);
    expect(s.images(0).map((i) => [i.matrix.map(r2), i.added, i.movable])).toEqual([[[595.44, 0, 0, 841.68, 0, 0], true, true]]);
    expect(s.images(1).map((i) => [i.pixelWidth, i.pixelHeight, i.added, i.movable])).toEqual([[400, 566, true, true]]);
    // The new file is the original: nothing to undo; the other PDF went with the old document.
    // Riprendi keeps it all the same: it exists only here (see "Riprendi": made here).
    expect(s.undo()).toMatchObject({ editCount: 0, canUndo: false });
    expect(s.exportSession()).toMatchObject({ editCount: 0, madeHere: true });
    expectSessionError(() => s.renderSource(other.source, 0, 1), "bad-request");

    const saved = mupdf.Document.openDocument(new Uint8Array(s.save().bytes), "application/pdf").asPDF()!;
    try {
      const kinds = [0, 1].map((p) => {
        const out: string[] = [];
        saved.findPage(p).get("Resources").get("XObject").forEach((v) => out.push(`${v.get("BitsPerComponent")} ${v.get("ColorSpace")} ${v.get("Filter")}`));
        return out;
      });
      expect(kinds).toEqual([["8 /DeviceRGB /DCTDecode"], ["1 /DeviceGray /CCITTFaxDecode"]]);
    } finally {
      saved.destroy();
    }
    expect(s.pdfaCheck().blockers).toEqual([]);
    expect(s.save({ format: "pdfa-2b", password: { mode: "none" } }).pdfa!.blockers).toEqual([]);
    // It edits like any document.
    s.addText(1, [72, 72], "Scansione", SANS);
    expect(pageTexts(s)[1]).toContain("Scansione");
  });
});

// ---------------------------------------------------------------------------------------------

describe("the other PDF", () => {
  it("opens one at a time, renders apart from the document, and closes with the document", () => {
    const s = session(plainPdf(["Documento"]));
    expect(s.openSource(new TextEncoder().encode("not a pdf"))).toMatchObject({ ok: false, reason: "damaged" });
    const empty = new mupdf.PDFDocument();
    let none: Uint8Array;
    try {
      none = saveBytes(empty);
    } finally {
      empty.destroy();
    }
    expect(s.openSource(none)).toMatchObject({ ok: false, reason: "damaged" });
    const huge = new Uint8Array(MAX_SOURCE_BYTES + 1);
    expect(s.openSource(huge)).toEqual({ ok: false, reason: "too-big" });

    const first = s.openSource(plainPdf(["A1", "A2"], [300, 500]));
    expect(first).toMatchObject({ ok: true, pageCount: 2, pages: [{ index: 0, bounds: [0, 0, 300, 500] }, { index: 1 }], title: null });
    const second = s.openSource(plainPdf(["B1"]));
    if (!first.ok || !second.ok) throw new Error("did not open");
    expect(second.source).not.toBe(first.source);
    expectSessionError(() => s.renderSource(first.source, 0, 1), "bad-request"); // closed by the second
    const shown = s.renderSource(second.source, 0, 0.5);
    expect([shown.width, shown.height]).toEqual([Math.ceil(595 * 0.5), Math.ceil(842 * 0.5)]);
    expectSessionError(() => s.renderSource(second.source, 1, 0.5), "bad-request");
    expectSessionError(() => s.renderSource(second.source, 0, 0), "bad-request");
    expect(s.closeSource(first.source)).toBeNull(); // an earlier one: nothing
    expect(s.renderSource(second.source, 0, 0.2).width).toBeGreaterThan(0);
    expectSessionError(() => s.closeSource("1" as unknown as number), "bad-request");
    s.closeSource(second.source);
    expectSessionError(() => s.renderSource(second.source, 0, 1), "bad-request");
    expectSessionError(() => s.editPages({ kind: "insert", at: 0, source: second.source, pages: "all", title: null }), "bad-request");

    // Open and close of the document close it too.
    const third = s.openSource(plainPdf(["C1"]));
    if (!third.ok) throw new Error("did not open");
    s.open(plainPdf(["Altro documento"]));
    expectSessionError(() => s.renderSource(third.source, 0, 1), "bad-request");
    const fourth = s.openSource(plainPdf(["D1"]));
    if (!fourth.ok) throw new Error("did not open");
    s.close();
    expectSessionError(() => s.renderSource(fourth.source, 0, 1), "bad-request");
  });

  it("asks for its password; the log holds its pages unencrypted, so undo, redo and a replay need none, and Riprendi keeps nothing", () => {
    const enc = fixture("enc-user-aes128.pdf");
    const s = session(plainPdf(["Uno", "Due"]));
    expect(s.openSource(enc)).toEqual({ ok: false, reason: "password-required" });
    expect(s.openSource(enc, "sbagliata")).toEqual({ ok: false, reason: "wrong-password" });
    const src = s.openSource(enc, "utente");
    if (!src.ok) throw new Error("did not open");
    expect(src.pageCount).toBe(1);
    const r = s.editPages({ kind: "insert", at: 1, source: src.source, pages: [0], title: "Preventivo" });
    expect(r.layout.from).toEqual([0, null, 1]);
    expect(pageTexts(s)[1]).toContain("Preventivo n. 2026/118");
    const after = fingerprint(s);

    const logged = s.edits()[0];
    if (logged.kind !== "pages" || logged.op !== "insert") throw new Error("not an insert");
    expect(logged.protectedSource).toBe(true);
    const copy = openPdf(logged.source);
    try {
      expect(copy.needsPassword()).toBe(false);
      expect(copy.getTrailer().get("Encrypt").isNull()).toBe(true);
    } finally {
      copy.destroy();
    }

    s.closeSource(src.source); // the log has its own copy
    s.undo();
    expect(pageTexts(s)).toEqual(["Uno", "Due"]);
    s.redo();
    expect(fingerprint(s)).toEqual(after);
    // Its pages sit in the log unencrypted: nothing is kept for Riprendi.
    expect(s.exportSession()).toBeNull();
    // A log that holds such an insert (written by hand: exportSession never gives one) replays
    // with no password, and the session it makes keeps nothing either.
    const t = new EngineSession(mupdf);
    const log: SessionLog = { version: LOG_VERSION, edits: structuredClone(s.edits()) };
    expect(t.resumeSession(plainPdf(["Uno", "Due"]), log)).toMatchObject({ ok: true, applied: 1, failedAt: null });
    expect(fingerprint(t)).toEqual(after);
    expect(t.exportSession()).toBeNull();
    const bad = structuredClone(log);
    (bad.edits[0] as unknown as Record<string, unknown>).protectedSource = "sì";
    expectSessionError(() => t.resumeSession(plainPdf(["Uno", "Due"]), bad), "bad-request");
  });

  it("keeps nothing for Riprendi while the log holds pages of a PDF that needed a password (P2)", () => {
    const s = session(plainPdf(["Uno", "Due"]));
    s.addText(0, [72, 400], "Prima", SANS);
    const plain = s.openSource(plainPdf(["Libero"]));
    if (!plain.ok) throw new Error("did not open");
    s.editPages({ kind: "insert", at: 2, source: plain.source, pages: "all", title: null });
    expect(s.exportSession()).not.toBeNull(); // a PDF without a password: kept
    const enc = s.openSource(fixture("enc-user-aes128.pdf"), "utente");
    if (!enc.ok) throw new Error("did not open");
    s.editPages({ kind: "insert", at: 0, source: enc.source, pages: [0], title: null });
    expect(s.exportSession()).toBeNull();
    s.addText(1, [72, 300], "Dopo", SANS);
    expect(s.exportSession()).toBeNull(); // for as long as the insert is in the log
    s.undo();
    expect(s.exportSession()).toBeNull();
    s.undo(); // the protected insert undone: what is left is kept again
    const kept = s.exportSession();
    expect(kept).not.toBeNull();
    expect((kept!.log as SessionLog).edits.map((e) => e.kind)).toEqual(["addText", "pages"]);
    s.redo();
    expect(s.exportSession()).toBeNull();
  });

  it("logs only the chosen pages of the other PDF, in the chosen order (P6)", () => {
    const s = session(plainPdf(["Uno", "Due"]));
    const texts = ["Scelta A", "Segreto B", "Scelta C", "Segreto D"];
    const whole = plainPdf(texts);
    const src = s.openSource(whole);
    if (!src.ok) throw new Error("did not open");
    const r = s.editPages({ kind: "insert", at: 1, source: src.source, pages: [2, 0], title: null });
    expect(r.layout.from).toEqual([0, null, null, 1]);
    expect(pageTexts(s)).toEqual(["Uno", "Scelta C", "Scelta A", "Due"]);
    s.closeSource(src.source);

    const exported = structuredClone(s.exportSession()!);
    const logged = (exported.log as SessionLog).edits[0];
    if (logged.kind !== "pages" || logged.op !== "insert") throw new Error("not an insert");
    expect(logged.pages).toEqual([1, 0]); // the file keeps them in its own order
    expect(logged.protectedSource).toBeUndefined();
    const part = openPdf(logged.source);
    let plainText: string;
    try {
      expect(part.countPages()).toBe(2);
      plainText = latin1(saveBytes(part, "decompress=yes")); // every stream readable as it is
    } finally {
      part.destroy();
    }
    expect(plainText).toContain("Scelta A");
    expect(plainText).toContain("Scelta C");
    expect(plainText).not.toContain("Segreto");
    // The pages not chosen are nowhere in the session's log either, nor in its memory of the other PDF.
    for (const e of s.edits()) if (e.kind === "pages" && e.op === "insert") expect(e.source.byteLength).toBeLessThan(whole.byteLength);
    // And the history goes on as for any insert.
    const after = fingerprint(s);
    s.undo();
    expect(pageTexts(s)).toEqual(["Uno", "Due"]);
    s.redo();
    expect(fingerprint(s)).toEqual(after);
    const t = new EngineSession(mupdf);
    expect(t.resumeSession(exported.original, exported.log)).toMatchObject({ ok: true, applied: 1, failedAt: null });
    expect(fingerprint(t)).toEqual(after);
  });

  it("inserts the chosen pages as an insert from the whole file would, the report included (P6)", () => {
    // RICH's page 1 links to page 3 twice (an explicit destination and the name /p3), and to page 4.
    for (const title of ["Ricco", null]) {
      const s = session(plainPdf(["Uno", "Due"]));
      const src = s.openSource(RICH);
      if (!src.ok) throw new Error("did not open");
      const whole = (s as unknown as { source: { bytes: Uint8Array } }).source.bytes; // openSource's private copy
      const r = s.editPages({ kind: "insert", at: 1, source: src.source, pages: [0, 3], title });

      const t = session(plainPdf(["Uno", "Due"]));
      const full = openPdf(whole);
      let report: unknown;
      try {
        report = insertPages(mupdf, docOf(t), full, [0, 3], 1, title).report; // as the insert was made before
      } finally {
        full.destroy();
      }
      expect(r.report, String(title)).toEqual(report);
      expect(r.report.linksRemoved).toBe(2);
      expect(fingerprint(s), String(title)).toEqual(fingerprint(t));
      const outline = (x: EngineSession) => {
        const walk = (items: Outline | null | undefined): unknown[] => (items ?? []).map((o) => [o.title, o.page ?? null, walk(o.down)]);
        return walk(docOf(x).loadOutline());
      };
      expect(outline(s), String(title)).toEqual(outline(t));
      expect(fieldNames(s)).toEqual(fieldNames(t));
    }
  });

  it("logs nothing of the other PDF's document information nor its XMP (P6)", () => {
    const SECRETS = {
      Title: "TitoloRiservato", Author: "AutoreRiservato", Subject: "SoggettoRiservato",
      Keywords: "ChiaviRiservate", Creator: "CreatoreRiservato", Producer: "ProduttoreRiservato",
    };
    const XMP = ["XmpCatalogoRiservato", "XmpPaginaRiservato"];
    const made = openPdf(plainPdf(["Scelta A", "Altra B"]));
    let source: Uint8Array;
    try {
      for (const [key, value] of Object.entries(SECRETS)) made.setMetaData(`info:${key}`, value);
      const xmp = (what: string) =>
        addStream(made, `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${what}</dc:title></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`, { Type: "Metadata", Subtype: "XML" });
      made.getTrailer().get("Root").put("Metadata", xmp(XMP[0]));
      made.findPage(0).put("Metadata", xmp(XMP[1]));
      source = saveBytes(made);
    } finally {
      made.destroy();
    }
    const readable = (bytes: Uint8Array) => {
      const doc = openPdf(bytes);
      try {
        return latin1(bytes) + latin1(saveBytes(doc, "decompress=yes"));
      } finally {
        doc.destroy();
      }
    };
    for (const secret of [...Object.values(SECRETS), ...XMP]) expect(readable(source)).toContain(secret); // (the check sees them)

    for (const [pages, title] of [[[0], null], [[0], "Allegato"], ["all", "Allegato"], ["all", null]] as const) {
      const s = session(plainPdf(["Uno"]));
      const src = s.openSource(source);
      if (!src.ok) throw new Error("did not open");
      s.editPages({ kind: "insert", at: 1, source: src.source, pages: pages === "all" ? "all" : [...pages], title });
      const logged = (structuredClone(s.exportSession()!).log as SessionLog).edits[0];
      if (logged.kind !== "pages" || logged.op !== "insert") throw new Error("not an insert");
      const part = openPdf(logged.source);
      try {
        expect(part.getTrailer().get("Info").isNull(), `${pages} ${title}`).toBe(true);
        expect(part.getTrailer().get("Root").get("Metadata").isNull()).toBe(true);
        expect(part.findPage(0).get("Metadata").isNull()).toBe(true);
      } finally {
        part.destroy();
      }
      const logText = readable(logged.source);
      for (const secret of [...Object.values(SECRETS), ...XMP]) expect(logText, `${pages} ${title}: ${secret}`).not.toContain(secret);
      // Nor does the document's own download carry them.
      const saved = readable(new Uint8Array(s.save().bytes));
      for (const secret of [...Object.values(SECRETS), ...XMP]) expect(saved, `${pages} ${title}: ${secret}`).not.toContain(secret);
    }
  });

  it("inserts one page or every page of a 4000-page PDF in time linear in its pages (P8)", () => {
    // insertReads once found each page again after an edit of the one before: MuPDF drops its
    // page map at every edit, so each findPage walked the tree again (one page of 4000 took about
    // 1.3 s, 14 times as long as one of 1000). Now one pass finds the pages, then the edits:
    // about 45 ms, and 300 ms for every page.
    const sizes = [1000, 4000];
    const sources = new Map(sizes.map((n) => [n, plainPdf(Array.from({ length: n }, (_, i) => `Pagina ${i + 1}`))]));
    const time = (n: number, pages: number[] | "all") => {
      let best = Infinity;
      for (let k = 0; k < 2; k++) {
        const s = session(plainPdf(["Uno", "Due"]));
        const src = s.openSource(sources.get(n)!);
        if (!src.ok) throw new Error("did not open");
        const t = performance.now();
        const r = s.editPages({ kind: "insert", at: 1, source: src.source, pages, title: null });
        best = Math.min(best, performance.now() - t);
        expect(r.layout.pages).toHaveLength(2 + (pages === "all" ? n : pages.length));
        expect(pageTexts(s)[1]).toBe(pages === "all" ? "Pagina 1" : `Pagina ${pages[0] + 1}`);
        s.close();
      }
      return best;
    };
    for (const [label, pages] of [["one page", (n: number) => [n >> 1]], ["every page", () => "all" as const]] as const) {
      const best = sizes.map((n) => time(n, pages(n)));
      console.log(`insert ${label} of another PDF: ${sizes.map((n, k) => `${n} pages ${best[k].toFixed(0)} ms`).join(", ")}`);
      // Linear: 4000 pages take about 4 times as long as 1000 (it was 12 to 16 times); the floor
      // keeps timer noise on short runs from failing the test, the cap a machine that is slow all over.
      expect(best[1], label).toBeLessThan(8 * Math.max(best[0], 25));
      expect(best[1], label).toBeLessThan(5000);
    }
  });

  it("brings its form and signatures (counted in the report and the layout), its password fields hidden", () => {
    const s = session(plainPdf(["Uno"]));
    const signed = s.openSource(formPdf({ signed: true, value: "Mario" }));
    if (!signed.ok) throw new Error("did not open");
    const r = s.editPages({ kind: "insert", at: 1, source: signed.source, pages: "all", title: null });
    expect(r.report).toEqual({ linksRemoved: 0, fieldsRenamed: 0, signaturesAdded: 1 });
    expect(r.layout.signatures).toBe(1);
    expect(r.layout.form).toMatchObject({ fields: 1 });
    expect(s.fields(1).find((f) => f.name === "nome")!.value).toBe("Mario");
    expect(s.editPages({ kind: "delete", pages: [1] }).layout).toMatchObject({ signatures: 0, from: [0] });
    expect(s.undo().layout).toMatchObject({ signatures: 1, from: [0, null] });

    const withPin = s.openSource(formPdf({ password: "1234" }));
    if (!withPin.ok) throw new Error("did not open");
    s.editPages({ kind: "insert", at: 0, source: withPin.source, pages: "all", title: null });
    const logged = s.edits().at(-1)!;
    if (logged.kind !== "pages" || logged.op !== "insert") throw new Error("not an insert");
    const copy = openPdf(logged.source);
    try {
      const pin = copy.findPage(0).get("Annots");
      const widgets = Array.from({ length: pin.length }, (_, i) => pin.get(i)).filter((a) => a.get("T").isString() && a.get("T").asString() === "pin");
      expect(widgets).toHaveLength(1);
      expect(widgets[0].get("AP").isNull()).toBe(false); // a frame-only look of its own (hidePasswords), not MuPDF's drawing of the value
    } finally {
      copy.destroy();
    }
  });

  it("brings layers that draw as the source has them, whatever path the history took", () => {
    // The trap (pages.ts): MuPDF reads the layers once; added after, they draw as visible.
    const raw = openPdf(RICH), layered = openPdf(layersPdf("default"));
    try {
      const p = raw.loadPage(3);
      p.toStructuredText().destroy(); // page 4 draws its hidden layer: MuPDF has read the layers
      p.destroy();
      insertPages(mupdf, raw, layered, "all", 4, null);
      const q = raw.loadPage(4);
      const st = q.toStructuredText();
      expect(st.asText()).toContain("Strato 1");
      st.destroy();
      q.destroy();
    } finally {
      raw.destroy();
      layered.destroy();
    }

    const s = session(RICH);
    s.render(3, 0.4);
    s.replaceLine(3, lineOf(s, 3, "Pagina 4"), "Quarta"); // a replay draws page 4 before the insert too
    const src = s.openSource(layersPdf("default"));
    if (!src.ok) throw new Error("did not open");
    s.editPages({ kind: "insert", at: 4, source: src.source, pages: "all", title: null });
    expect(pageTexts(s)[4]).toBe("Pagina 1");
    expect(pageTexts(s)[5]).toBe("Pagina 2 | Strato 2");
    s.addText(4, [72, 500], "Dopo", SANS);
    const after = fingerprint(s);
    s.undo(); // rebuilt from the original: the line edit, then the insert
    expect(pageTexts(s)[4]).toBe("Pagina 1");
    s.redo();
    expect(fingerprint(s)).toEqual(after);
    for (let k = 0; k < 3; k++) s.undo();
    for (let k = 0; k < 3; k++) s.redo();
    expect(fingerprint(s)).toEqual(after);
    const t = new EngineSession(mupdf);
    const exported = structuredClone(s.exportSession()!);
    t.resumeSession(exported.original, exported.log);
    expect(fingerprint(t)).toEqual(after);
  });
});

// ---------------------------------------------------------------------------------------------

describe("extractPages", () => {
  it("writes only those pages through the save path, and leaves the document as it is", () => {
    const s = session(RICH);
    s.addText(1, [72, 400], "Mario Rossi", SANS);
    s.setField("nome", text("Mario"));
    s.editPages({ kind: "move", order: [1, 0, 2, 3] });
    const was = fingerprint(s);
    const out = s.extractPages([3, 0]); // (in the document's order)
    expect(out.pdfa).toBeNull();
    const part = reopen(out.bytes);
    expect(pageTexts(part)).toEqual([pageTexts(s)[0], pageTexts(s)[3]]);
    expect(pageTexts(part)[0]).toContain("Mario Rossi");
    expect(fieldNames(part)).toContain("nome");
    expect(fieldNames(part)).not.toContain("totale"); // on page 3, left out
    const whole = mupdf.Document.openDocument(new Uint8Array(out.bytes), "application/pdf").asPDF()!;
    try {
      const all = Array.from({ length: whole.countPages() }, (_, i) => {
        const p = whole.loadPage(i), st = p.toStructuredText();
        try {
          return st.asText();
        } finally {
          st.destroy();
          p.destroy();
        }
      }).join(" ");
      expect(all).not.toContain("Pagina 3");
    } finally {
      whole.destroy();
    }
    expect(fingerprint(s)).toEqual(was);
    expect(s.edits()).toHaveLength(3);
    expect(s.undo().editCount).toBe(2);

    // As PDF/A, the part itself converted; refusals.
    expect(s.extractPages([0], { format: "pdfa-2b", password: { mode: "none" } }).pdfa!.blockers).toEqual([]);
    for (const pages of [[], [0, 0], [4], [-1], [0.5], "0"]) expectSessionError(() => s.extractPages(pages as number[]), "bad-request");
    expectSessionError(() => s.extractPages([0], { format: "pdf", password: { mode: "keep" } }), "bad-request");
    expectSessionError(() => new EngineSession(mupdf).extractPages([0]), "no-document");
  });

  it("never claims PDF/A in a normal PDF, and keeps the password", () => {
    const s = session(plainPdf(["Uno", "Due"]));
    const pdfa = s.save({ format: "pdfa-2b", password: { mode: "none" } }).bytes;
    const t = session(pdfa); // a PDF/A, not edited
    const claims = (bytes: ArrayBuffer) => {
      const r = new EngineSession(mupdf).open(bytes);
      return r.ok ? r.pdfa : "not opened";
    };
    expect(claims(t.save().bytes)).toBe("2B"); // the whole file, unedited, keeps its claim
    expect(claims(t.extractPages([1]).bytes)).toBeNull();

    const enc = session(fixture("enc-user-aes128.pdf"), "utente");
    const kept = enc.extractPages([0], { format: "pdf", password: { mode: "keep" } }).bytes;
    expect(new EngineSession(mupdf).open(kept)).toMatchObject({ ok: false, reason: "password-required" });
    expect(new EngineSession(mupdf).open(kept, "utente")).toMatchObject({ ok: true, pageCount: 1 });
  });
});

// ---------------------------------------------------------------------------------------------

describe("Riprendi", () => {
  /** A session with every kind of edit, page operations among them, across a checkpoint; and its states. */
  function edited() {
    const s = session(RICH);
    const states = [fingerprint(s)];
    const step = (run: () => unknown) => {
      run();
      states.push(fingerprint(s));
    };
    step(() => s.addText(1, [72, 400], "Mario Rossi", SANS));
    step(() => s.setField("nome", text("Mario")));
    step(() => s.addImage(smallPng(), [{ pageIndex: 2, matrix: [120, 0, 0, 60, 300, 400] }], "Firma"));
    step(() => s.transformImage(2, 0, [120, 0, 0, 60, 320, 420]));
    step(() => s.editPages({ kind: "move", order: [0, 2, 1, 3] }));
    const other = s.openSource(plainPdf(["Allegato"]));
    if (!other.ok) throw new Error("did not open");
    step(() => s.editPages({ kind: "insert", at: 4, source: other.source, pages: "all", title: "Allegato" }));
    step(() => s.editPages({ kind: "pictures", at: 0, pictures: [picture(jpeg(120, 160), 120, 160, 72)] }));
    step(() => s.editPages({ kind: "delete", pages: [4] }));
    step(() => s.editAddedText(3, 1, { text: "Maria Rossi" }));
    step(() => s.editPages({ kind: "rotate", pages: [1, 2], by: 270 }));
    step(() => s.replaceLine(3, lineOf(s, 3, "Pagina 2"), "Seconda"));
    return { s, states };
  }

  it("gives back the same document, history and checkpoints after a structured clone", () => {
    const { s, states } = edited();
    const n = states.length - 1;
    const exported = s.exportSession();
    if (!exported) throw new Error("nothing exported");
    expect(exported.editCount).toBe(n);
    expect((exported.log as SessionLog).version).toBe(LOG_VERSION);
    const stored = structuredClone(exported);

    // What was handed out is a copy: changing it changes nothing in the session.
    new Uint8Array(exported.original).fill(0);
    for (const e of (exported.log as SessionLog).edits) if (e.kind === "pages" && e.op === "insert") e.source.fill(0);
    expect(fingerprint(s)).toEqual(states[n]);
    expect(s.exportSession()).toEqual(stored);

    const t = new EngineSession(mupdf);
    const r = t.resumeSession(stored.original, stored.log);
    if (!r.ok) throw new Error(`did not resume: ${r.reason}`);
    expect(r).toMatchObject({ applied: n, failedAt: null, history: { editCount: n, canUndo: true, canRedo: false, changedPages: [] } });
    expect(r.pageCount).toBe(docOf(s).countPages());
    expect(r.pages.map((p) => p.bounds.map(r2))).toEqual(boundsOf(s));
    expect(r.form!.fields).toBeGreaterThan(0);
    expect(fingerprint(t)).toEqual(states[n]);
    expect(checkpointsOf(t)).toHaveLength(Math.floor(n / CHECKPOINT_EVERY));
    for (let k = n; k > 0; k--) {
      t.undo();
      expect(fingerprint(t), `undo to ${k - 1}`).toEqual(states[k - 1]);
    }
    for (let k = 1; k <= n; k++) t.redo();
    expect(fingerprint(t)).toEqual(states[n]);
  });

  it("stops at an edit that no longer fits, keeping the ones before", () => {
    const { s, states } = edited();
    const exported = structuredClone(s.exportSession()!);
    const log = exported.log as SessionLog;
    const k = log.edits.findIndex((e) => e.kind === "image");
    const image = log.edits[k];
    if (image.kind !== "image") throw new Error("no image edit");
    image.expect = [10, 0, 0, 10, 5, 5]; // not where the image is
    const t = new EngineSession(mupdf);
    expect(t.resumeSession(exported.original, log)).toMatchObject({ ok: true, applied: k, failedAt: k, history: { editCount: k } });
    expect(fingerprint(t)).toEqual(states[k]);
    expect(t.edits()).toHaveLength(k);

    // A page operation that no longer fits: a page that is not there.
    const again = structuredClone(s.exportSession()!);
    const edits = (again.log as SessionLog).edits;
    const d = edits.findIndex((e) => e.kind === "pages" && e.op === "delete");
    edits[d] = { kind: "pages", op: "delete", pages: [40] };
    expect(t.resumeSession(again.original, again.log)).toMatchObject({ ok: true, applied: d, failedAt: d });
    expect(fingerprint(t)).toEqual(states[d]);
    t.addText(0, [72, 72], "Si continua", SANS);
    expect(t.edits()).toHaveLength(d + 1);
  });

  it("keeps nothing when there is nothing to keep, or the document needed a password", () => {
    expect(new EngineSession(mupdf).exportSession()).toBeNull();
    const s = session(RICH);
    expect(s.exportSession()).toBeNull();
    s.addText(0, [72, 400], "Prima", SANS);
    expect(s.exportSession()).not.toBeNull();
    s.undo();
    expect(s.exportSession()).toBeNull();
    const enc = session(fixture("enc-user-aes128.pdf"), "utente");
    enc.addText(0, [72, 400], "Segreto", SANS);
    enc.editPages({ kind: "blank", at: 1 });
    expect(enc.exportSession()).toBeNull();
  });

  it("keeps a document made here even with no edits, across resumes, downloads and undos (made here)", () => {
    const s = session(plainPdf(["Dal disco"]));
    expect(s.exportSession()).toBeNull(); // a file from the device without edits: the user has it
    const made = s.newFromPictures([picture(jpeg(120, 160), 120, 160, 72), picture(jpeg(160, 120), 160, 120, 72)]);
    if (!made.ok) throw new Error("not made");
    const pages = fingerprint(s);

    // No edits: kept all the same, the file as made and an empty log that says so.
    const first = s.exportSession();
    expect(first).toMatchObject({ editCount: 0, madeHere: true });
    expect(first!.log).toEqual({ version: LOG_VERSION, edits: [], madeHere: true });
    const stored = structuredClone(first!);

    // Resumed (the tab was killed while the camera was open): still made here, still kept.
    const t = new EngineSession(mupdf);
    expect(t.resumeSession(stored.original, stored.log)).toMatchObject({ ok: true, applied: 0, failedAt: null, pageCount: 2 });
    expect(fingerprint(t)).toEqual(pages);
    expect(t.exportSession()).toMatchObject({ editCount: 0, madeHere: true });
    // An edit, a download, the edit undone: that state exists nowhere but here, kept.
    t.addText(0, [20, 100], "Firmato", SANS);
    expect(t.exportSession()).toMatchObject({ editCount: 1, madeHere: true });
    t.save();
    t.undo();
    const again = structuredClone(t.exportSession()!);
    expect(again).toMatchObject({ editCount: 0, madeHere: true });
    // ...and once more, through a second resume, with an edit in the log this time.
    t.redo();
    const u = new EngineSession(mupdf);
    const withEdit = structuredClone(t.exportSession()!);
    expect(u.resumeSession(withEdit.original, withEdit.log)).toMatchObject({ ok: true, applied: 1 });
    u.undo();
    expect(u.exportSession()).toMatchObject({ editCount: 0, madeHere: true });

    // A file from the device opened in its place, or a document closed: no longer.
    u.open(plainPdf(["Altro"]));
    expect(u.exportSession()).toBeNull();
    u.addText(0, [72, 400], "Prima", SANS);
    expect(u.exportSession()!.madeHere).toBeUndefined();
    expect((u.exportSession()!.log as SessionLog).madeHere).toBeUndefined();
    t.close();
    expect(t.exportSession()).toBeNull();
    // A log of a file from the device resumes as one: without edits, nothing to keep.
    const v = new EngineSession(mupdf);
    expect(v.resumeSession(plainPdf(["Dal disco"]), { version: LOG_VERSION, edits: [] })).toMatchObject({ ok: true, applied: 0 });
    expect(v.exportSession()).toBeNull();
    expect(v.resumeSession(stored.original, { ...(stored.log as SessionLog), madeHere: false })).toMatchObject({ ok: true });
    expect(v.exportSession()).toBeNull();

    // The other rules still hold for it: pages of a PDF that needed a password keep nothing.
    const w = new EngineSession(mupdf);
    expect(w.resumeSession(stored.original, stored.log)).toMatchObject({ ok: true });
    const enc = w.openSource(fixture("enc-user-aes128.pdf"), "utente");
    if (!enc.ok) throw new Error("did not open");
    w.editPages({ kind: "insert", at: 0, source: enc.source, pages: [0], title: null });
    expect(w.exportSession()).toBeNull();
    w.undo();
    expect(w.exportSession()).toMatchObject({ editCount: 0, madeHere: true });

    // A log whose flag is not a boolean is not exportSession's.
    for (const madeHere of ["sì", 1, null])
      expectSessionError(() => w.resumeSession(stored.original.slice(0), { ...(stored.log as SessionLog), madeHere }), "bad-request");
  });

  it("says a file with restrictions only is encrypted, after a resume across a checkpoint too", () => {
    const plain = openPdf(plainPdf(["Uno"]));
    let restricted: Uint8Array;
    try {
      restricted = saveBytes(plain, "encrypt=aes-256,owner-password=proprietario");
    } finally {
      plain.destroy();
    }
    const s = session(restricted);
    for (let k = 0; k < CHECKPOINT_EVERY; k++) s.editPages({ kind: "blank", at: k + 1 });
    expect(checkpointsOf(s)).toHaveLength(1);
    const exported = structuredClone(s.exportSession()!); // (no password was needed to open it)
    const t = new EngineSession(mupdf);
    expect(t.resumeSession(exported.original, exported.log)).toMatchObject({
      ok: true, applied: CHECKPOINT_EVERY, pageCount: CHECKPOINT_EVERY + 1, encrypted: true, needsPassword: false, canKeepPassword: false,
    });
    expect(checkpointsOf(t)).toHaveLength(1);
  });

  it("refuses a log that is not exportSession's before anything is done", () => {
    const { s } = edited();
    const good = structuredClone(s.exportSession()!);
    const t = session(plainPdf(["Aperto"]));
    const edits = (good.log as SessionLog).edits;
    const swap = (k: number, patch: Record<string, unknown>) => ({ version: LOG_VERSION, edits: edits.map((e, i) => (i === k ? { ...e, ...patch } : e)) });
    const at = (kind: string) => edits.findIndex((e) => e.kind === kind);
    const pagesAt = (op: string) => edits.findIndex((e) => e.kind === "pages" && e.op === op);
    const bad: unknown[] = [
      null, [], "log", { version: 2, edits }, { version: LOG_VERSION }, { version: LOG_VERSION, edits: [null] },
      { version: LOG_VERSION, edits: [{ kind: "unknown" }] },
      swap(at("addText"), { pageIndex: -1 }),
      swap(at("addText"), { style: { size: 0 } }),
      swap(at("field"), { type: "slider" }),
      swap(at("field"), { value: { kind: "colour" } }),
      swap(at("image"), { op: "crop" }),
      swap(at("image"), { expect: [1, 2, 3] }),
      swap(at("addImage"), { picture: { bytes: [1, 2, 3], orientation: 1, width: 1, height: 1 } }),
      swap(at("addImage"), { targets: [] }),
      swap(at("editAdded"), { id: "1" }),
      swap(at("text"), { occurrence: 0.5 }),
      swap(pagesAt("insert"), { source: "pdf" }),
      swap(pagesAt("rotate"), { by: 45 }),
      swap(pagesAt("pictures"), { pictures: [{ picture: null, size: [1, 1], alt: null }] }),
      swap(pagesAt("move"), { op: "shuffle" }),
    ];
    for (const log of bad) {
      expectSessionError(() => t.resumeSession(good.original.slice(0), log), "bad-request");
      expect(pageTexts(t), JSON.stringify(log)?.slice(0, 80)).toEqual(["Aperto"]);
    }
    expectSessionError(() => t.resumeSession("pdf" as unknown as ArrayBuffer, good.log), "bad-request");
    // A file that does not open is said as open() says it.
    expect(t.resumeSession(new TextEncoder().encode("no pdf").buffer, good.log)).toMatchObject({ ok: false, reason: "damaged" });
  });
});

// ---------------------------------------------------------------------------------------------

describe("the app's fonts in a download (P1)", () => {
  /**
   * The programs of the app's fallback fonts in a file (Type0 fonts of the pages and of their
   * annotations' appearances: name, size, hash): a subset's glyphs tell which characters were
   * written with it.
   */
  function fontPrograms(bytes: ArrayBuffer): string[] {
    const doc = openPdf(new Uint8Array(bytes));
    const out = new Set<string>();
    const take = (fonts: mupdf.PDFObject) => {
      if (!fonts.isDictionary()) return;
      fonts.forEach((f) => {
        if (!f.isDictionary() || f.get("Subtype").asName() !== "Type0") return;
        const fd = f.get("DescendantFonts").get(0).get("FontDescriptor");
        for (const k of ["FontFile", "FontFile2", "FontFile3"]) {
          if (!fd.get(k).isStream()) continue;
          const buf = fd.get(k).readStream();
          try {
            const b = buf.asUint8Array();
            out.add(`${f.get("BaseFont").asName().replace(/^[A-Z]{6}\+/, "")} ${b.length} ${createHash("sha1").update(b).digest("hex")}`);
          } finally {
            buf.destroy();
          }
        }
      });
    };
    try {
      for (let i = 0; i < doc.countPages(); i++) {
        const page = doc.findPage(i);
        take(page.get("Resources").isDictionary() ? page.get("Resources").get("Font") : mupdf.PDFObject.Null);
        const annots = page.get("Annots");
        if (annots.isArray()) annots.forEach((a) => {
          const n = a.isDictionary() ? a.get("AP").isDictionary() ? a.get("AP").get("N") : mupdf.PDFObject.Null : mupdf.PDFObject.Null;
          if (n.isStream() && n.get("Resources").isDictionary()) take(n.get("Resources").get("Font"));
        });
      }
    } finally {
      doc.destroy();
    }
    return [...out].sort();
  }

  /** "abc" written on the first page of three; with `secret`, that text on the second page too. */
  function written(secret: string | null) {
    const s = session(plainPdf(["Uno", "Due", "Tre"]));
    s.addText(0, [72, 400], "abc", SANS);
    if (secret) s.addText(1, [72, 400], secret, SANS);
    return s;
  }

  it("keeps only the glyphs of what the pages still show: a deleted page, a part, a deleted line", () => {
    const PDFA = { format: "pdfa-2b", password: { mode: "none" } } as const;
    const base = written(null);
    const saved = fontPrograms(base.save().bytes), part = fontPrograms(base.extractPages([0]).bytes);
    const archived = fontPrograms(base.save(PDFA).bytes);
    expect(saved).toHaveLength(1);

    const s = written("PIN 4821 QXJZ");
    const all = fontPrograms(s.save().bytes);
    expect(all).not.toEqual(saved); // (the check sees the difference)
    expect(fontPrograms(s.extractPages([0]).bytes)).toEqual(part);
    expect(fontPrograms(s.extractPages([0, 2]).bytes)).toEqual(part);
    s.editPages({ kind: "delete", pages: [1] });
    expect(fontPrograms(s.save().bytes)).toEqual(saved);
    expect(fontPrograms(s.save(PDFA).bytes)).toEqual(archived);
    s.undo();
    expect(fontPrograms(s.save().bytes)).toEqual(all);
    s.redo();
    expect(fontPrograms(s.save().bytes)).toEqual(saved);

    // The page stays, the line goes: its glyphs go too.
    const t = written("PIN 4821 QXJZ");
    t.editAddedText(1, t.addedTexts(1)[0].id, { text: "" });
    expect(fontPrograms(t.save().bytes)).toEqual(saved);
    // A line written over: only the new text's glyphs.
    const u = written("PIN 4821 QXJZ");
    u.editAddedText(1, u.addedTexts(1)[0].id, { text: "cab" });
    expect(fontPrograms(u.save().bytes)).toEqual(saved);
  });

  it("still draws what stays, the text a page op moved and copied included", () => {
    const s = written("Mario Rossi");
    s.editPages({ kind: "duplicate", pages: [1], at: 3 });
    s.editPages({ kind: "delete", pages: [1] });
    const out = reopen(s.save().bytes);
    expect(pageTexts(out)).toEqual(["Uno | abc", "Tre", "Due | Mario Rossi"]);
    mupdf.emptyStore();
    expect(fingerprint(out).map((p) => (p as { render: string }).render)).toEqual(fingerprint(s).map((p) => (p as { render: string }).render));
  });
});

describe("core.subsetFallbackFonts on what the document draws (P1)", () => {
  it("subsets a font already subset again when it draws fewer glyphs, down to .notdef when nothing", () => {
    const doc = new mupdf.PDFDocument();
    try {
      doc.insertPage(-1, doc.addPage([0, 0, 400, 200], 0, {}, ""));
      const page = doc.findPage(0);
      const show = (text: string, y: number) =>
        encodeWithFallbacks(mupdf, doc, text, { family: "sans", bold: false, italic: false }).runs
          .map((r) => `/${fontKey(doc, page, r.font)} 20 Tf 1 0 0 1 20 ${y} Tm <${r.hex}> Tj`).join("\n");
      const program = () => {
        let length = 0;
        page.get("Resources").get("Font").forEach((f) => {
          const fd = f.get("DescendantFonts").get(0).get("FontDescriptor");
          const buf = fd.get("FontFile3").isStream() ? fd.get("FontFile3").readStream() : fd.get("FontFile2").readStream();
          length = buf.getLength();
          buf.destroy();
        });
        return length;
      };
      const render = () => {
        mupdf.emptyStore();
        const p = doc.loadPage(0);
        const pix = renderPixmap(mupdf, p, 1);
        try {
          return createHash("sha1").update(pix.getPixels()).digest("hex");
        } finally {
          pix.destroy();
          p.destroy();
        }
      };
      page.put("Contents", doc.addStream(`BT ${show("Tenuto", 150)} ${show("Via Segreta 7", 100)} ET`, {}));
      expect(subsetFallbackFonts(mupdf, doc)).toBe(1);
      const both = program();
      expect(subsetFallbackFonts(mupdf, doc)).toBe(0); // the same glyphs: left as it is

      page.put("Contents", doc.addStream(`BT ${show("Tenuto", 150)} ET`, {}));
      const before = render();
      expect(subsetFallbackFonts(mupdf, doc)).toBe(1); // fewer: subset again, from the whole program
      expect(program()).toBeLessThan(both);
      expect(render()).toBe(before); // what stays still draws
      expect(subsetFallbackFonts(mupdf, doc)).toBe(0);

      page.put("Contents", doc.addStream("", {})); // nothing drawn, the font still listed
      expect(subsetFallbackFonts(mupdf, doc)).toBe(1);
      const empty = program();
      expect(empty).toBeGreaterThan(0);
      expect(empty).toBeLessThan(both);
    } finally {
      releaseFallbackFonts(doc);
      doc.destroy();
    }
  });
});
