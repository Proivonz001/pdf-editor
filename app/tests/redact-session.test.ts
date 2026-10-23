// Bianchetto and Oscura through EngineSession (release 5), in Node on the worker's mupdf build. A
// redaction is one logged edit like any other: its download holds nothing of what was under the
// area (helpers/leakPdf.ts: a secret in every channel), its undo brings everything back and its
// redo takes it away again, also when the history is rebuilt from a checkpoint or from the original
// and when Riprendi replays the log; a redaction that removes form widgets answers, as its undo and
// redo do, with the pages' layout and the form counted again; a refusal or a bad request changes and
// logs nothing, and keeps the working document (no rollback); a redaction that fails half way, or is
// refused only after the change, is rolled back; the download and PDF/A work after it. redact.ts itself is tested in redact.test.ts.
import { readFileSync } from "node:fs";
import * as mupdf from "mupdf";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RedactArea, RedactMode, TextStyle } from "../src/engine/protocol";
import { CHECKPOINT_EVERY, EngineSession, LOG_VERSION, SessionError, pagesOf, type LoggedEdit, type SessionLog } from "../src/engine/session";
import {
  LEAK_AREA, LEGIT, OSCURA_GONE, WHITEOUT_GONE, WHITEOUT_KEPT, bigPicturePdf, leakPdf, pictureScan, separationPdf, tokenPlaces, unsurePdf,
} from "./helpers/leakPdf";
import { plainPdf } from "./helpers/richPdf";

/**
 * Makes redact.redactAreas fail on purpose after it did its work (a half-done edit to roll back):
 * with an Error, or with the refusal redact.ts can only find after the change (changed true).
 */
const redactSpy = vi.hoisted(() => ({ fail: false, refuseAfter: false }));
vi.mock("../src/engine/redact", async (importOriginal) => {
  const redact = await importOriginal<typeof import("../src/engine/redact")>();
  return {
    ...redact,
    redactAreas: (...args: Parameters<typeof redact.redactAreas>) => {
      const out = redact.redactAreas(...args);
      if (redactSpy.fail) throw new Error("injected failure after a redaction did its work");
      if (redactSpy.refuseAfter) throw new redact.RedactError("injected refusal after a redaction did its work", "not-editable", "shared", 0);
      return out;
    },
  };
});
beforeEach(() => {
  redactSpy.fail = false;
  redactSpy.refuseAfter = false;
});

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const AREA: RedactArea[] = [{ pageIndex: 0, rects: [LEAK_AREA] }];
const SANS: TextStyle = { size: 12, color: [0, 0, 0], family: "sans", bold: false, italic: false };
/** plainPdf's line on every page, in page space (baseline at y 100, 20 pt Helvetica). */
const LINE: [number, number, number, number] = [60, 70, 400, 110];

const leaksIn = (bytes: Uint8Array, tokens: string[]) => tokens.filter((t) => tokenPlaces(bytes, t).length > 0);
const missingIn = (bytes: Uint8Array, tokens: string[]) => tokens.filter((t) => tokenPlaces(bytes, t).length === 0);

function session(bytes: Uint8Array) {
  const s = new EngineSession(mupdf);
  const opened = s.open(bytes);
  if (!opened.ok) throw new Error(`did not open: ${opened.reason}`);
  return { s, opened };
}

/** The download of the session's document, as the app writes it. */
const saved = (s: EngineSession) => new Uint8Array(s.save().bytes);

/** The session's working document (a rollback replaces it with one rebuilt from the log). */
const docOf = (s: EngineSession) => (s as unknown as { doc: mupdf.PDFDocument }).doc;

/** The texts of a page's lines. */
const lineTexts = (s: EngineSession, pageIndex: number) => s.lines(pageIndex).map((l) => l.text.trim());

function errorOf(fn: () => unknown): SessionError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(SessionError);
    return e as SessionError;
  }
  throw new Error("expected a SessionError");
}

/** A download after Oscura over LEAK_AREA: nothing of what was under it (text, pictures, masks), everything else. */
function expectRedacted(bytes: Uint8Array) {
  expect(leaksIn(bytes, OSCURA_GONE)).toEqual([]);
  expect(missingIn(bytes, LEGIT)).toEqual([]);
  const pictures = pictureScan(bytes);
  expect(pictures.secretPixels).toBe(0);
  expect(pictures.secretMasks).toBe(0);
  expect(pictures.legitPixels).toBeGreaterThan(4000);
}

/** A download with everything of the leak document still in it (no redaction applied). */
function expectWhole(bytes: Uint8Array) {
  expect(missingIn(bytes, [...OSCURA_GONE, ...LEGIT])).toEqual([]);
  expect(pictureScan(bytes).secretPixels).toBeGreaterThan(0);
}

describe("a redaction is one edit", () => {
  it("Oscura: the download holds nothing of the area; the form is counted again; undo and redo", () => {
    const { s, opened } = session(leakPdf("shared"));
    if (!opened.ok) return;
    const r = s.redact(AREA, "redact");
    expect(r).toMatchObject({ editCount: 1, canUndo: true, canRedo: false, changedPages: [0], redactions: 1 });
    expect(r.report).toMatchObject({ fields: ["codice", "nome"], fieldsElsewhere: ["nome"], links: 1, attachments: 1 });
    expect(r.report.text).toContain("SEGRETO_INVISIBILE");
    // Widgets went: the layout is the same pages, the form counted again ("codice" gone, "nome" still on page 2).
    expect(r.layout?.from).toEqual([0, 1, 2]);
    expect(r.layout?.pages).toEqual(opened.pages);
    expect(r.layout?.form?.fields).toBe(opened.form!.fields - 1);
    expect(r.layout?.form?.fieldsPerPage[0]).toBe(opened.form!.fieldsPerPage[0] - 2);
    expect(r.layout?.signatures).toBe(opened.signatures);
    expect(s.edits()).toEqual([{ kind: "redact", mode: "redact", areas: AREA }]);
    expect(s.fields(0).map((f) => f.name)).toEqual(["fuori"]);
    expectRedacted(saved(s));

    const u = s.undo();
    expect(u).toMatchObject({ editCount: 0, canUndo: false, canRedo: true, changedPages: [0] });
    expect(u.redactions).toBeUndefined();
    expect(u.layout?.form).toEqual(opened.form);
    expect(s.fields(0).map((f) => f.name).sort()).toEqual(["codice", "fuori", "nome"]);
    expectWhole(saved(s));

    const d = s.redo();
    expect(d).toMatchObject({ editCount: 1, canUndo: true, canRedo: false, changedPages: [0], redactions: 1 });
    expect(d.layout?.form).toEqual(r.layout?.form);
    expectRedacted(saved(s));
  });

  it("Bianchetto: text and drawings go, notes and fields stay on top; the form is the same, no layout", () => {
    const { s } = session(leakPdf("inherited"));
    const r = s.redact(AREA, "whiteout");
    expect(r).toMatchObject({ editCount: 1, changedPages: [0], redactions: 1 });
    expect(r.layout).toBeUndefined();
    const bytes = saved(s);
    expect(leaksIn(bytes, WHITEOUT_GONE)).toEqual([]);
    expect(missingIn(bytes, [...WHITEOUT_KEPT, ...LEGIT])).toEqual([]);
    expect(s.undo().layout).toBeUndefined();
    expect(s.redo().layout).toBeUndefined();
  });

  it("several pages, one edit, one undo; the log keeps one entry per page in page order", () => {
    const { s } = session(plainPdf(["Mario Rossi", "Pagina due", "Luigi Rossi"]));
    const r = s.redact([{ pageIndex: 2, rects: [LINE] }, { pageIndex: 0, rects: [LINE] }, { pageIndex: 2, rects: [[0, 0, 1, 1]] }], "redact");
    expect(r).toMatchObject({ editCount: 1, changedPages: [0, 2] });
    expect(r.layout).toBeUndefined(); // (no field went)
    expect(s.edits()).toEqual([{ kind: "redact", mode: "redact", areas: [{ pageIndex: 0, rects: [LINE] }, { pageIndex: 2, rects: [LINE, [0, 0, 1, 1]] }] }]);
    expect(lineTexts(s, 0)).toEqual([]);
    expect(lineTexts(s, 1)).toEqual(["Pagina due"]);
    expect(lineTexts(s, 2)).toEqual([]);
    expect(s.undo()).toMatchObject({ editCount: 0, changedPages: [0, 2] });
    expect(lineTexts(s, 0)).toEqual(["Mario Rossi"]);
    expect(lineTexts(s, 2)).toEqual(["Luigi Rossi"]);
  });

  it("counts the redactions applied; edits() are copies; pagesOf gives each page once, ascending", () => {
    const { s } = session(plainPdf(["Uno", "Due"]));
    expect(s.redact([{ pageIndex: 0, rects: [LINE] }], "whiteout").redactions).toBe(1);
    expect(s.addText(1, [72, 300], "Scritto", SANS).redactions).toBe(1);
    expect(s.redact([{ pageIndex: 1, rects: [LINE] }], "redact").redactions).toBe(2);
    const copy = s.edits();
    (copy[0] as Extract<LoggedEdit, { kind: "redact" }>).areas[0].rects[0][0] = 999;
    expect(s.edits()[0]).toEqual({ kind: "redact", mode: "whiteout", areas: [{ pageIndex: 0, rects: [LINE] }] });
    expect(s.undo().redactions).toBe(1);
    expect(s.undo().redactions).toBe(1);
    expect(s.undo().redactions).toBeUndefined();
    expect(pagesOf({ kind: "redact", mode: "redact", areas: [{ pageIndex: 3, rects: [] }, { pageIndex: 1, rects: [] }, { pageIndex: 3, rects: [] }] })).toEqual([1, 3]);
  });

  it("the preview changes and logs nothing", () => {
    const { s } = session(leakPdf("shared"));
    const preview = s.redactPreview(AREA, "redact");
    expect(preview.refused).toBeNull();
    expect(preview.pages).toHaveLength(1);
    expect(preview.pages[0]).toMatchObject({ pageIndex: 0, fields: ["codice", "nome"], links: 1 });
    expect(preview.attachments).toBe(1);
    expect(s.edits()).toEqual([]);
    expect(s.undo()).toMatchObject({ editCount: 0, canUndo: false, canRedo: false });
    expectWhole(saved(s));
  });
});

describe("the history around a redaction", () => {
  it("replayed from a checkpoint: undo past a later edit applies it again, exactly", () => {
    const { s } = session(leakPdf("own"));
    for (let k = 0; k < CHECKPOINT_EVERY; k++) s.addText(2, [72, 120 + 20 * k], `Riga ${k}`, SANS);
    s.redact(AREA, "redact"); // after the checkpoint at 8
    s.addText(2, [72, 400], "Dopo", SANS);
    const first = saved(s);
    expectRedacted(first);
    s.undo(); // the checkpoint, then the redaction replayed
    expectRedacted(saved(s));
    s.undo();
    expectWhole(saved(s));
    s.redo();
    s.redo();
    const again = saved(s);
    expectRedacted(again);
    expect(lineTexts(s, 2)).toContain("Dopo");
  });

  it("inside a checkpoint and replayed from the original: undo to the start and redo it all", () => {
    const { s } = session(leakPdf("shared"));
    const r = s.redact(AREA, "redact");
    for (let k = 0; k < CHECKPOINT_EVERY; k++) s.addText(2, [72, 120 + 20 * k], `Riga ${k}`, SANS);
    expectRedacted(saved(s));
    s.undo(); // from the checkpoint at 8, which holds the redaction
    expectRedacted(saved(s));
    for (let k = 1; k < CHECKPOINT_EVERY; k++) s.undo();
    const u = s.undo(); // the redaction itself: from the original
    expect(u.layout?.form?.fields).toBe(r.layout!.form!.fields + 1);
    expectWhole(saved(s));
    const d = s.redo(); // the redaction again, on the original
    expect(d.layout?.form).toEqual(r.layout?.form);
    for (let k = 0; k < CHECKPOINT_EVERY; k++) s.redo();
    expectRedacted(saved(s));
    expect(lineTexts(s, 2)).toContain(`Riga ${CHECKPOINT_EVERY - 1}`);
  });

  it("a redaction that fails half way is rolled back and not logged", () => {
    const { s } = session(leakPdf("shared"));
    s.addText(2, [72, 120], "Prima", SANS);
    redactSpy.fail = true;
    expect(errorOf(() => s.redact(AREA, "redact")).code).toBe("edit-failed");
    redactSpy.fail = false;
    expect(s.edits().map((e) => e.kind)).toEqual(["addText"]);
    expectWhole(saved(s));
    expect(s.fields(0)).toHaveLength(3);
    expect(s.redact(AREA, "redact").editCount).toBe(2);
    expectRedacted(saved(s));
  });

  it("a refusal found after the change is rolled back, its code and reason kept", () => {
    const { s } = session(leakPdf("shared"));
    s.addText(2, [72, 120], "Prima", SANS);
    const before = docOf(s);
    redactSpy.refuseAfter = true;
    const err = errorOf(() => s.redact(AREA, "redact"));
    redactSpy.refuseAfter = false;
    expect(err.code).toBe("not-editable");
    expect(err.message).toContain("Refused (shared) on page 1");
    expect(docOf(s)).not.toBe(before); // (rebuilt from the log)
    expect(s.edits().map((e) => e.kind)).toEqual(["addText"]);
    expectWhole(saved(s));
  });

  it("Riprendi keeps the redaction in the log and replays it; malformed entries are refused", () => {
    const { s } = session(leakPdf("shared"));
    const r = s.redact(AREA, "redact");
    s.addText(2, [72, 120], "Dopo", SANS);
    const out = s.exportSession()!;
    expect((out.log as SessionLog).edits[0]).toEqual({ kind: "redact", mode: "redact", areas: AREA });
    const t = new EngineSession(mupdf);
    const resumed = t.resumeSession(structuredClone(out.original), structuredClone(out.log));
    expect(resumed).toMatchObject({ ok: true, applied: 2, failedAt: null });
    if (!resumed.ok) return;
    expect(resumed.history.redactions).toBe(1);
    expect(resumed.form).toEqual(r.layout?.form);
    expectRedacted(saved(t));
    t.undo();
    expect(t.undo().layout?.form?.fields).toBe(r.layout!.form!.fields + 1); // (marked by the replay)

    const bad = (entry: unknown) =>
      expect(errorOf(() => new EngineSession(mupdf).resumeSession(out.original, { version: LOG_VERSION, edits: [entry] })).code).toBe("bad-request");
    bad({ kind: "redact", mode: "black", areas: AREA });
    bad({ kind: "redact", mode: "redact" });
    bad({ kind: "redact", mode: "redact", areas: [{ pageIndex: -1, rects: [LEAK_AREA] }] });
    bad({ kind: "redact", mode: "redact", areas: [{ pageIndex: 0, rects: [[1, 2, 3]] }] });
    bad({ kind: "redact", mode: "redact", areas: [{ pageIndex: 0, rects: [[1, 2, 3, Number.NaN]] }] });
    bad({ kind: "redact", mode: "redact", areas: [{ pageIndex: 0 }] });
  });

  it("the download and PDF/A after Oscura", () => {
    const { s } = session(fixture("word-images.pdf"));
    const [x0, y0, x1] = s.lines(0)[0].bbox;
    s.redact([{ pageIndex: 0, rects: [[x0, y0, x1, y0 + 400]] }], "redact");
    expect(s.save().bytes.byteLength).toBeGreaterThan(0);
    expect(s.pdfaCheck().blockers).toEqual([]);
    const pdfa = s.save({ format: "pdfa-2b", password: { mode: "none" } });
    expect(pdfa.pdfa?.blockers).toEqual([]);
  });
});

describe("what is refused changes and logs nothing", () => {
  const refusals: [string, () => Uint8Array, RedactMode, string][] = [
    ["a picture in printing colours", separationPdf, "redact", "separation"],
    ["resources shared with a page that cannot be read for sure", unsurePdf, "redact", "shared"],
    ["the same, Bianchetto", unsurePdf, "whiteout", "shared"],
    ["a picture too large to clear", () => bigPicturePdf(7100, 7100), "redact", "too-big"],
  ];
  for (const [what, make, mode, reason] of refusals) {
    it(`${what}: "not-editable", the reason in the message (${reason}); no rollback`, () => {
      const { s } = session(make());
      s.addText(0, [72, 60], "Prima", SANS);
      expect(s.redactPreview(AREA, mode).refused).toEqual({ reason, pageIndex: 0 });
      const before = docOf(s);
      const err = errorOf(() => s.redact(AREA, mode));
      expect(err.code).toBe("not-editable");
      expect(err.message).toMatch(new RegExp(`\\b${reason}\\b`));
      // Found before anything changed: the working document is kept, not rebuilt from the log.
      expect(docOf(s)).toBe(before);
      expect(s.edits().map((e) => e.kind)).toEqual(["addText"]);
      expect(s.undo()).toMatchObject({ editCount: 0, canUndo: false, canRedo: true });
      if (reason !== "too-big") expect(leaksIn(saved(s), ["SEGRETO_VISIBILE"])).toEqual(["SEGRETO_VISIBILE"]);
    });
  }

  it("bad requests: nothing done, before anything changes (no rollback)", () => {
    const { s } = session(plainPdf(["Mario Rossi", "Pagina due"]));
    const before = docOf(s);
    const bad = (areas: unknown, mode: unknown = "redact") => {
      expect(errorOf(() => s.redact(areas as RedactArea[], mode as RedactMode)).code).toBe("bad-request");
      expect(errorOf(() => s.redactPreview(areas as RedactArea[], mode as RedactMode)).code).toBe("bad-request");
    };
    bad([{ pageIndex: 0, rects: [LINE] }], "black");
    bad([]);
    bad("everything");
    bad([null]);
    bad([{ pageIndex: 2, rects: [LINE] }]);
    bad([{ pageIndex: 0.5, rects: [LINE] }]);
    bad([{ pageIndex: 0, rects: LINE }]);
    bad([{ pageIndex: 0, rects: [[0, 0, 10]] }]);
    bad([{ pageIndex: 0, rects: [[0, 0, 10, Number.POSITIVE_INFINITY]] }]);
    bad([{ pageIndex: 0, rects: [] }, { pageIndex: 1, rects: [] }]);
    bad([{ pageIndex: 0, rects: Array.from({ length: 600 }, () => LINE) }, { pageIndex: 0, rects: Array.from({ length: 401 }, () => LINE) }]);
    bad([{ pageIndex: 0, rects: [[-200, -200, -100, -100]] }]); // wholly off the page (as redact.ts reads it)
    bad([{ pageIndex: 0, rects: [[-200, -200, -100, -100]] }, { pageIndex: 1, rects: [[0, 900, 600, 1000]] }]);
    expect(docOf(s)).toBe(before);
    expect(s.edits()).toEqual([]);
    expect(lineTexts(s, 0)).toEqual(["Mario Rossi"]);
    expect(s.redact([{ pageIndex: 0, rects: [LINE] }], "redact").editCount).toBe(1);
  });
});
