// Forme (release 6) through EngineSession, in Node on the worker's mupdf build: a shape drawn,
// changed or deleted is one logged edit like any other (undo, redo, checkpoints, Riprendi), its id
// stable at every replay; a change that changes nothing is a no-op; shapes survive a line edit of
// the text under them (and its undo and redo) and are never taken for that line's underline; the
// organizer's turn and copy keep them where they are seen; Bianchetto wholly over one removes it,
// Oscura over an arrow's shaft leaves its head as plain line art; a highlight over black text leaves
// the text dark; save and reopen read them back; untrusted input and stored logs are checked before
// anything is done (a stored shape on its page again). The engine side is in shapes.test.ts.
import * as mupdf from "mupdf";
import { describe, expect, it } from "vitest";
import { contentStreams, invert, latin1, streamBytes } from "../src/engine/images";
import { MAX_PEN_POINTS, type Matrix, type Shape, type ShapeInfo } from "../src/engine/protocol";
import { CHECKPOINT_EVERY, EngineSession, LOG_VERSION, SessionError, type LoggedEdit, type SessionLog } from "../src/engine/session";
import { apply } from "../src/engine/shapeGeometry";
import { plainPdf, saveBytes } from "./helpers/richPdf";

type RGB = [number, number, number];
const RED: RGB = [0.85, 0.18, 0.13], BLUE: RGB = [0.12, 0.36, 0.85], YELLOW: RGB = [1, 0.83, 0], BLACK: RGB = [0, 0, 0];
const shape = (s: Partial<Shape> & Pick<Shape, "kind" | "points">): Shape => ({ color: RED, width: 2, dash: "solid", heads: 0, ...s });

const LINE = shape({ kind: "line", points: [[60, 300], [260, 340]], heads: 1 });
const RECT = shape({ kind: "rect", points: [[300, 300], [400, 360]], dash: "dashed", color: BLUE });
const PEN = shape({ kind: "pen", points: Array.from({ length: 40 }, (_, k) => [80 + k * 4, 420 + 10 * Math.sin(k / 3)] as [number, number]), width: 1 });
/** plainPdf's line "Hello world" (20 pt Helvetica, baseline at y 100, x 72 to about 171) under a yellow highlight. */
const HIGHLIGHT = shape({ kind: "highlight", points: [[68, 82], [176, 106]], color: YELLOW, width: 0 });

function session(bytes: Uint8Array) {
  const s = new EngineSession(mupdf);
  const opened = s.open(bytes);
  if (!opened.ok) throw new Error(`did not open: ${opened.reason}`);
  return { s, opened };
}

/** The session's working document. */
const docOf = (s: EngineSession) => (s as unknown as { doc: mupdf.PDFDocument }).doc;
const contentOf = (s: EngineSession, pageIndex = 0) => contentStreams(docOf(s).findPage(pageIndex)).map((x) => latin1(streamBytes(x))).join("\n");
const transformOf = (s: EngineSession, pageIndex = 0): Matrix => {
  const page = docOf(s).loadPage(pageIndex);
  try {
    return page.getTransform() as Matrix;
  } finally {
    page.destroy();
  }
};

function errorOf(fn: () => unknown): SessionError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(SessionError);
    return e as SessionError;
  }
  throw new Error("expected a SessionError");
}

/** `got` lists `want` (ids and shapes, points to 0.001). */
function expectShapes(got: ShapeInfo[], want: { id: number; shape: Shape }[]) {
  expect(got.map((x) => x.id)).toEqual(want.map((x) => x.id));
  got.forEach((g, k) => {
    const w = want[k].shape;
    expect({ ...g.shape, points: [] }).toEqual({ ...w, points: [] });
    expect(g.shape.points.length).toBe(w.points.length);
    g.shape.points.forEach((p, j) => {
      expect(p[0]).toBeCloseTo(w.points[j][0], 3);
      expect(p[1]).toBeCloseTo(w.points[j][1], 3);
    });
  });
}

/** The colour of the session's page at page-space point (x, y), rendered at scale 2. */
function pixelOf(s: EngineSession, x: number, y: number, pageIndex = 0): RGB {
  const r = s.render(pageIndex, 2);
  const at = (Math.floor(y * 2) * r.width + Math.floor(x * 2)) * 4;
  return [r.rgba[at], r.rgba[at + 1], r.rgba[at + 2]];
}
const isRed = ([r, g, b]: RGB) => r > 170 && g < 110 && b < 110;

describe("a shape is one edit", () => {
  it("drawn, changed, deleted: logged as plain data, the id kept; undo and redo give every state back", () => {
    const { s } = session(plainPdf(["Hello world", "Due"]));
    expect(s.addShape(0, LINE)).toEqual({ editCount: 1, canUndo: true, canRedo: false, changedPages: [0], pageIndex: 0, id: 1 });
    expect(s.addShape(0, RECT)).toMatchObject({ editCount: 2, id: 2 });
    expect(s.addShape(1, PEN)).toMatchObject({ editCount: 3, changedPages: [1], pageIndex: 1, id: 1 });
    const blue = { ...LINE, color: BLUE, heads: 2 as const };
    expect(s.editShape(0, 1, blue)).toEqual({ editCount: 4, canUndo: true, canRedo: false, changedPages: [0], pageIndex: 0, id: 1 });
    expect(s.editShape(0, 2, null)).toMatchObject({ editCount: 5, changedPages: [0], id: null });
    expect(s.edits()).toEqual([
      { kind: "addShape", pageIndex: 0, shape: LINE, id: 1 },
      { kind: "addShape", pageIndex: 0, shape: RECT, id: 2 },
      { kind: "addShape", pageIndex: 1, shape: PEN, id: 1 },
      { kind: "editShape", pageIndex: 0, id: 1, shape: blue },
      { kind: "editShape", pageIndex: 0, id: 2, shape: null },
    ]);
    expectShapes(s.shapes(0), [{ id: 1, shape: blue }]);
    expectShapes(s.shapes(1), [{ id: 1, shape: PEN }]);

    expect(s.undo()).toMatchObject({ editCount: 4, canRedo: true, changedPages: [0] });
    expectShapes(s.shapes(0), [{ id: 1, shape: blue }, { id: 2, shape: RECT }]);
    s.undo();
    expectShapes(s.shapes(0), [{ id: 1, shape: LINE }, { id: 2, shape: RECT }]);
    expect(s.undo()).toMatchObject({ changedPages: [1] });
    expect(s.shapes(1)).toEqual([]);
    s.undo();
    s.undo();
    expect(s.shapes(0)).toEqual([]);
    for (let k = 0; k < 5; k++) s.redo();
    expectShapes(s.shapes(0), [{ id: 1, shape: blue }]);
    expectShapes(s.shapes(1), [{ id: 1, shape: PEN }]);
  });

  it("a change that changes nothing (the shape as it reads back) is a no-op: nothing logged", () => {
    const { s } = session(plainPdf(["Hello world"]));
    s.addShape(0, PEN);
    const [{ shape: now }] = s.shapes(0);
    expect(s.editShape(0, 1, now)).toEqual({ editCount: 1, canUndo: true, canRedo: false, changedPages: [], pageIndex: 0, id: 1 });
    expect(s.editShape(0, 1, PEN)).toMatchObject({ editCount: 1, changedPages: [] });
    expect(s.edits()).toHaveLength(1);
  });

  it(`ids and shapes stay the same through checkpoints and rebuilds (${3 * CHECKPOINT_EVERY} edits)`, () => {
    const { s } = session(plainPdf(["Hello world"]));
    const states: ShapeInfo[][] = [s.shapes(0)];
    for (let k = 0; k < 3 * CHECKPOINT_EVERY; k++) {
      if (k % 3 === 2) s.editShape(0, 1, { ...LINE, points: [[60 + k, 300], [260, 340 + k]] });
      else s.addShape(0, k % 2 ? RECT : { ...PEN, points: PEN.points.map(([x, y]) => [x, y + k] as [number, number]) });
      states.push(s.shapes(0));
    }
    for (let k = states.length - 2; k >= 0; k--) {
      s.undo();
      expect(s.shapes(0), `after undo to ${k}`).toEqual(states[k]);
    }
    for (let k = 1; k < states.length; k++) {
      s.redo();
      expect(s.shapes(0), `after redo to ${k}`).toEqual(states[k]);
    }
  });
});

describe("shapes and the page's other edits", () => {
  it("survive a line edit of the text under them, its undo and redo, and can be changed after it", () => {
    const { s } = session(plainPdf(["Hello world"]));
    s.addShape(0, HIGHLIGHT);
    s.addShape(0, LINE);
    const before = s.shapes(0);
    expect(s.replaceLine(0, 0, "Ciao mondo")).toMatchObject({ editCount: 3, after: "Ciao mondo" });
    expectShapes(s.shapes(0), before);
    expect(s.lines(0).map((l) => l.text.trim())).toEqual(["Ciao mondo"]);
    s.undo();
    expect(s.lines(0).map((l) => l.text.trim())).toEqual(["Hello world"]);
    expectShapes(s.shapes(0), before);
    s.redo();
    expectShapes(s.shapes(0), before);
    const moved = { ...LINE, points: [[70, 310], [270, 350]] as [number, number][] };
    s.editShape(0, 2, moved);
    s.editShape(0, 1, { ...HIGHLIGHT, color: BLUE });
    expectShapes(s.shapes(0), [{ id: 1, shape: { ...HIGHLIGHT, color: BLUE } }, { id: 2, shape: moved }]);
    expect(s.lines(0).map((l) => l.text.trim())).toEqual(["Ciao mondo"]);
  });

  it("a line drawn under a word is never taken for its underline (a printed one is)", () => {
    // The same rule printed in the page (black, 1 pt, 3 pt under the baseline, along the text) is an underline that follows.
    const rule = "0 g 1 w 72 739 m 170.9 739 l S";
    const printed = session(plainWithContent(`BT /F1 20 Tf 72 742 Td (Hello world) Tj ET ${rule}`)).s;
    expect(printed.lineDecorations(0, 0).underlines).toBe(1);

    const { s } = session(plainPdf(["Hello world"]));
    const under = shape({ kind: "line", points: [[72, 103], [170.9, 103]], color: BLACK, width: 1 });
    s.addShape(0, under);
    expect(s.lineDecorations(0, 0)).toMatchObject({ underlines: 0, strikes: 0, box: null });
    s.addShape(0, HIGHLIGHT);
    expect(s.lineDecorations(0, 0)).toMatchObject({ underlines: 0, box: null });
    s.replaceLine(0, 0, "Ciao");
    expectShapes(s.shapes(0), [{ id: 1, shape: under }, { id: 2, shape: HIGHLIGHT }]);
  });

  it("the organizer turning the page keeps a shape where it is seen; a copy of the page has the same shapes", () => {
    const { s } = session(plainPdf(["Hello world", "Due"]));
    s.addShape(0, LINE);
    s.addShape(0, RECT);
    const T0 = transformOf(s);
    s.editPages({ kind: "rotate", pages: [0], by: 90 });
    const T1 = transformOf(s);
    const turn = (p: [number, number]) => apply(T1, apply(invert(T0), p));
    // Turned 90° clockwise, an A4 page is 842 wide: (x, y) is seen at (842 - y, x).
    expect(turn([60, 300])[0]).toBeCloseTo(542, 3);
    expect(turn([60, 300])[1]).toBeCloseTo(60, 3);
    const seen = (sh: Shape) => ({ ...sh, points: sh.points.map(turn) });
    expectShapes(s.shapes(0), [{ id: 1, shape: seen(LINE) }, { id: 2, shape: seen(RECT) }]);
    const mid = turn([160, 320]);
    expect(isRed(pixelOf(s, mid[0], mid[1]))).toBe(true);

    s.editPages({ kind: "duplicate", pages: [0], at: 1 });
    expectShapes(s.shapes(1), [{ id: 1, shape: seen(LINE) }, { id: 2, shape: seen(RECT) }]);
    s.editShape(1, 1, null);
    expect(s.shapes(1).map((x) => x.id)).toEqual([2]);
    expect(s.shapes(0).map((x) => x.id)).toEqual([1, 2]);
    s.undo();
    s.undo();
    s.undo();
    expectShapes(s.shapes(0), [{ id: 1, shape: LINE }, { id: 2, shape: RECT }]);
  });

  it("Bianchetto wholly over a shape removes it and its block; one crossing the area's edge stays", () => {
    const { s } = session(plainPdf(["Hello world"]));
    s.addShape(0, LINE);
    s.addShape(0, RECT);
    s.addShape(0, HIGHLIGHT);
    // The rect wholly under the first area; the line crosses the second (its middle), its head outside both.
    s.redact([{ pageIndex: 0, rects: [[290, 290, 410, 370], [140, 310, 180, 330]] }], "whiteout");
    expectShapes(s.shapes(0), [{ id: 1, shape: LINE }, { id: 3, shape: HIGHLIGHT }]);
    expect(contentOf(s)).not.toMatch(/PEShape 2\b/);
    // Oscura wholly over the highlight
    s.redact([{ pageIndex: 0, rects: [[60, 75, 185, 112]] }], "redact");
    expectShapes(s.shapes(0), [{ id: 1, shape: LINE }]);
    expect(contentOf(s)).not.toMatch(/PEShape 3\b/);
    s.undo();
    s.undo();
    expect(s.shapes(0).map((x) => x.id)).toEqual([1, 2, 3]);
    // A new shape's id stays past the ones the page had, a redaction's box among them.
    s.redo();
    expect(s.addShape(0, RECT).id).toBe(4);
    // An arrow whose head alone lies wholly under the area paints less than it says: line art from
    // then on, its block without /PEShape and /PEDef (a rewrite would bring the head back).
    s.redact([{ pageIndex: 0, rects: [[240, 325, 275, 350]] }], "whiteout");
    expect(s.shapes(0).map((x) => x.id)).toEqual([3, 4]);
    expect(errorOf(() => s.editShape(0, 1, null)).code).toBe("bad-request");
    expect(contentOf(s)).not.toMatch(/PEShape 1\b/);
    expect(isRed(pixelOf(s, 100, 308))).toBe(true); // the shaft still drawn
  });

  it("Oscura over an arrow's shaft: its head stays as printed line art, without the definition of what went", () => {
    const { s } = session(plainPdf(["Hello world"]));
    s.addShape(0, shape({ kind: "line", points: [[100, 500], [300, 500]], heads: 1 }));
    s.redact([{ pageIndex: 0, rects: [[90, 490, 296, 510]] }], "redact");
    const text = contentOf(s);
    expect(text).not.toMatch(/PEShape|PEDef/);
    expect(text).toMatch(/\/Artifact\s*BMC/);
    expect(s.shapes(0)).toEqual([]);
    expect(isRed(pixelOf(s, 297, 500))).toBe(true); // the head, past the box
    s.undo();
    expect(s.shapes(0).map((x) => x.id)).toEqual([1]);
  });

  it("a highlight over black text leaves the text dark and the paper around it yellow", () => {
    const { s } = session(plainPdf(["Hello world"]));
    const r0 = s.render(0, 2);
    s.addShape(0, HIGHLIGHT);
    const r1 = s.render(0, 2);
    let dark = 0, stillDark = 0;
    for (let y = 84 * 2; y < 104 * 2; y++)
      for (let x = 70 * 2; x < 174 * 2; x++) {
        const at = (y * r0.width + x) * 4;
        if (Math.max(r0.rgba[at], r0.rgba[at + 1], r0.rgba[at + 2]) > 60) continue;
        dark++;
        if (Math.max(r1.rgba[at], r1.rgba[at + 1], r1.rgba[at + 2]) <= 60) stillDark++;
      }
    expect(dark).toBeGreaterThan(500);
    expect(stillDark).toBe(dark);
    const [r, g, b] = pixelOf(s, 174, 90); // paper inside the highlight, past the last letter
    expect(r).toBeGreaterThan(235);
    expect(g).toBeGreaterThan(200);
    expect(b).toBeLessThan(190);
    expect(pixelOf(s, 190, 90)).toEqual([255, 255, 255]);
  });

  it("save and reopen: the shapes read back the same", () => {
    const { s } = session(plainPdf(["Hello world"]));
    for (const sh of [LINE, RECT, PEN, HIGHLIGHT]) s.addShape(0, sh);
    const t = session(new Uint8Array(s.save().bytes)).s;
    expectShapes(t.shapes(0), [LINE, RECT, PEN, HIGHLIGHT].map((sh, k) => ({ id: k + 1, shape: sh })));
    expect(t.editShape(0, 3, null).id).toBeNull();
  });
});

/** plainPdf's page with `content` instead. */
function plainWithContent(content: string): Uint8Array {
  const doc = new mupdf.PDFDocument();
  try {
    const helv = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" });
    const buf = new mupdf.Buffer(content);
    try {
      doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { Font: { F1: helv } }, buf));
    } finally {
      buf.destroy();
    }
    return saveBytes(doc);
  } finally {
    doc.destroy();
  }
}

describe("what is checked", () => {
  it("refuses a shape that is not one Shape allows, before anything is done", () => {
    const { s } = session(plainPdf(["Hello world"]));
    const bad: unknown[] = [
      null, "line", {}, { ...LINE, kind: "star" }, { ...LINE, points: [[1, 2]] }, { ...LINE, points: [[60, 300], [260, 340], [10, 10]] },
      { ...RECT, points: [[300, 300], [400, NaN]] }, { ...RECT, points: [[300, 300], [400, Infinity]] }, { ...RECT, points: [[300, 300], "400 360"] },
      { ...LINE, color: [1, 0] }, { ...LINE, color: [1, 0, 2] }, { ...LINE, color: "red" }, { ...LINE, width: 0.1 }, { ...LINE, width: 25 },
      { ...LINE, width: "2" }, { ...LINE, dash: "wavy" }, { ...LINE, heads: 3 }, { ...LINE, heads: true },
      { ...LINE, points: [[60, 300], [60.5, 300.5]] }, { ...RECT, points: [[300, 300], [400, 300.5]] }, { ...PEN, points: [[100, 100], [100.5, 100]] },
      { ...PEN, points: [[100, 100], [100.8, 100.8]] }, // (its box's diagonal is over 1 pt, its longer side is not: shapeGeometry.isShapeDrawable)
      { ...PEN, points: [[100, 100]] }, { ...PEN, points: Array.from({ length: MAX_PEN_POINTS + 1 }, (_, k) => [10 + (k % 500), 100]) },
      { ...LINE, points: [[-3, 300], [100, 300]] }, { ...LINE, points: [[100, 300], [100, 846]] },
    ];
    for (const v of bad) expect(errorOf(() => s.addShape(0, v as Shape)).code, JSON.stringify(v)?.slice(0, 80)).toBe("bad-request");
    expect(errorOf(() => s.addShape(5, LINE)).code).toBe("bad-request");
    expect(s.edits()).toEqual([]);
    s.addShape(0, LINE);
    for (const v of bad.slice(3)) expect(errorOf(() => s.editShape(0, 1, v as Shape)).code).toBe("bad-request");
    for (const id of [2, 0, -1, 1.5, NaN, "1"]) expect(errorOf(() => s.editShape(0, id as number, null)).code).toBe("bad-request");
    expect(errorOf(() => s.editShape(1, 1, null)).code).toBe("bad-request");
    expect(s.edits()).toHaveLength(1);
  });

  it("makes a shape plain: pen and highlight solid, a highlight's width 0, heads only on a line; points a hair off the page brought onto it", () => {
    const { s } = session(plainPdf(["Hello world"]));
    s.addShape(0, { ...PEN, dash: "dashed", heads: 2, points: [[-0.5, 400], ...PEN.points.slice(1), [595.8, 842.4]] });
    s.addShape(0, { ...HIGHLIGHT, width: 7, dash: "dotted", heads: 1 });
    s.addShape(0, { ...RECT, heads: 2 });
    const logged = s.edits().map((e) => (e as Extract<LoggedEdit, { kind: "addShape" }>).shape);
    expect(logged[0]).toMatchObject({ dash: "solid", heads: 0 });
    expect(logged[0].points[0]).toEqual([0, 400]);
    expect(logged[0].points[logged[0].points.length - 1]).toEqual([595, 842]);
    expect(logged[1]).toMatchObject({ width: 0, dash: "solid", heads: 0 });
    expect(logged[2]).toMatchObject({ heads: 0, dash: "dashed" });
  });

  it("refuses a page whose content cannot take an addition (not-editable), logging nothing", () => {
    const { s } = session(plainWithContent("BT /F1 20 Tf 72 742 Td (Hello) Tj ET (open"));
    expect(errorOf(() => s.addShape(0, LINE)).code).toBe("not-editable");
    expect(s.edits()).toEqual([]);
    expect(s.shapes(0)).toEqual([]);
  });
});

describe("Riprendi", () => {
  it("a log with shape edits resumes to the same shapes, and undo works as it did", () => {
    const bytes = plainPdf(["Hello world"]);
    const { s } = session(bytes);
    s.addShape(0, LINE);
    s.addShape(0, HIGHLIGHT);
    s.replaceLine(0, 0, "Ciao mondo");
    s.editShape(0, 1, { ...LINE, color: BLUE });
    s.addShape(0, PEN);
    s.editShape(0, 2, null);
    const exported = s.exportSession()!;
    expect(exported.editCount).toBe(6);
    const t = new EngineSession(mupdf);
    // (a structured clone, as the store keeps it)
    expect(t.resumeSession(exported.original, structuredClone(exported.log))).toMatchObject({ ok: true, applied: 6, failedAt: null });
    expect(t.shapes(0)).toEqual(s.shapes(0));
    expect(t.edits()).toEqual(s.edits());
    t.undo();
    s.undo();
    expect(t.shapes(0)).toEqual(s.shapes(0));
    expect(t.shapes(0).map((x) => x.id)).toEqual([1, 2, 3]);
  });

  it("refuses a log whose shape entries are not exportSession's; one whose new shape gets another id stops there", () => {
    const bytes = plainPdf(["Hello world"]);
    const good: LoggedEdit = { kind: "addShape", pageIndex: 0, shape: LINE, id: 1 };
    const logOf = (...edits: unknown[]) => ({ version: LOG_VERSION, edits }) as unknown as SessionLog;
    for (const bad of [
      { ...good, shape: { ...LINE, kind: "star" } }, { ...good, id: 1.5 }, { ...good, shape: undefined }, { ...good, pageIndex: -1 },
      { kind: "editShape", pageIndex: 0, id: 1 }, { kind: "editShape", pageIndex: 0, id: 1, shape: { ...RECT, width: 99 } },
      { kind: "editShape", pageIndex: 0, id: "1", shape: null },
    ]) {
      const t = new EngineSession(mupdf);
      expect(errorOf(() => t.resumeSession(bytes, logOf(good, bad))).code, JSON.stringify(bad)).toBe("bad-request");
    }
    const t = new EngineSession(mupdf);
    expect(t.resumeSession(bytes, logOf(good, { ...good, id: 7 }))).toMatchObject({ ok: true, applied: 1, failedAt: 1 });
    expect(t.shapes(0).map((x) => x.id)).toEqual([1]);
    const u = new EngineSession(mupdf);
    expect(u.resumeSession(bytes, logOf(good, { kind: "editShape", pageIndex: 0, id: 4, shape: null }))).toMatchObject({ applied: 1, failedAt: 1 });
    // A shape off its page (a tampered record): finite, but far enough to be written 1e+22, which PDF cannot read.
    const far = { ...LINE, points: [[100, 100], [1e22, 100]] };
    const v = new EngineSession(mupdf);
    expect(v.resumeSession(bytes, logOf({ ...good, shape: far }))).toMatchObject({ ok: true, applied: 0, failedAt: 0 });
    expect(contentOf(v)).not.toMatch(/e\+|PEShape/);
    const w = new EngineSession(mupdf);
    expect(w.resumeSession(bytes, logOf(good, { kind: "editShape", pageIndex: 0, id: 1, shape: far }))).toMatchObject({ applied: 1, failedAt: 1 });
    expect(contentOf(w)).not.toMatch(/e\+/);
  });
});
