// Decorations that follow an edited line, through EngineSession (session.ts), in Node on the
// worker's mupdf build: replaceLine detects the line's decorations, plans them (with the box
// option or as suggested), logs the plan as it was carried out and reports it; lineDecorations
// answers the line editor; undo, redo, checkpoints, a rollback and fresh replays give every state
// again, the plan applied as logged (a page that no longer fits it fails the replay, as an image
// edit's does); save and PDF/A keep the result; mixed and added lines are left as they were; bad
// options are refused. The rules themselves are tested in decorations.test.ts.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as mupdf from "mupdf";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DecorationMismatch } from "../src/engine/decorations";
import type { LineDecorations, Rect, TextStyle } from "../src/engine/protocol";
import { CHECKPOINT_EVERY, EngineSession, SessionError, type LoggedEdit, type TextEdit } from "../src/engine/session";

/**
 * Failures to inject, each once: core.replaceText changing the document and then throwing
 * ("after", as an edit that fails half way), applyDecorations throwing once the line is written
 * ("decorations"), detectDecorations throwing ("detect": MuPDF failing to read the page).
 */
const inject = vi.hoisted(() => ({ fail: "no" as "no" | "after" | "decorations" | "detect" }));
vi.mock("../src/engine/core.js", async (importOriginal) => {
  const core = await importOriginal<typeof import("../src/engine/core.js")>();
  return {
    ...core,
    replaceText(...args: Parameters<typeof core.replaceText>) {
      const result = core.replaceText(...args);
      if (inject.fail === "after") {
        inject.fail = "no";
        throw new Error("injected failure after a half-done edit");
      }
      return result;
    },
  };
});
vi.mock("../src/engine/decorations", async (importOriginal) => {
  const decorations = await importOriginal<typeof import("../src/engine/decorations")>();
  return {
    ...decorations,
    applyDecorations(...args: Parameters<typeof decorations.applyDecorations>) {
      if (inject.fail === "decorations") {
        inject.fail = "no";
        throw new Error("injected failure while the decorations follow");
      }
      return decorations.applyDecorations(...args);
    },
    detectDecorations(...args: Parameters<typeof decorations.detectDecorations>) {
      if (inject.fail === "detect") {
        inject.fail = "no";
        throw new Error("injected failure while reading the page");
      }
      return decorations.detectDecorations(...args);
    },
  };
});
beforeEach(() => {
  inject.fail = "no";
});

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const CHROME = "decorations-chrome.pdf";

const PAY = "https://example.com/pay", HANDLE = "https://example.com/u/anthropic";
/** On decorations-chrome.pdf (page space): "Pay online"'s underline, "@anthropic"'s pill and underline. */
const PAY_UNDERLINE: Rect = [22, 31, 64.035, 31.75];
const PILL: Rect = [22, 40.75, 76, 55.75];
const HANDLE_UNDERLINE: Rect = [25.75, 52, 71.91, 52.75];
const NONE: LineDecorations = { underlines: 0, strikes: 0, links: 0, box: null, left: [] };
const SANS9: TextStyle = { size: 9, color: [0, 0, 0], family: "sans", bold: false, italic: false };

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

/** The session's working document. */
const docOf = (s: EngineSession) => (s as unknown as { doc: mupdf.PDFDocument }).doc;

/** The index of the page's line that reads `t` (without its leading and trailing whitespace). */
function lineIndex(s: EngineSession, t: string, page = 0): number {
  const line = s.lines(page).find((l) => l.text.trim() === t);
  if (!line) throw new Error(`no line "${t}" on page ${page + 1}: ${JSON.stringify(s.lines(page).map((l) => l.text))}`);
  return line.index;
}

/** Edits the line reading `t` (as the line editor does: its LineInfo.index of the moment). */
const edit = (s: EngineSession, t: string, text: string, options?: { box?: boolean }) => s.replaceLine(0, lineIndex(s, t), text, options);

/** A path MuPDF paints (page space). */
interface Painted {
  paint: "fill" | "stroke";
  bbox: Rect;
  points: [number, number][];
}

/** Every path MuPDF paints on the page, in order. */
function pathsOf(doc: mupdf.PDFDocument, pageIndex = 0): Painted[] {
  const page = doc.loadPage(pageIndex);
  const out: Painted[] = [];
  const take = (paint: Painted["paint"], path: mupdf.Path, ctm: mupdf.Matrix) => {
    const points: [number, number][] = [];
    const at = (x: number, y: number): [number, number] => [x * ctm[0] + y * ctm[2] + ctm[4], x * ctm[1] + y * ctm[3] + ctm[5]];
    path.walk({ moveTo: (x, y) => points.push(at(x, y)), lineTo: (x, y) => points.push(at(x, y)), curveTo: (a, b, c, d, e, f) => points.push(at(a, b), at(c, d), at(e, f)) });
    out.push({ paint, bbox: path.getBounds(null as unknown as mupdf.StrokeState, ctm) as Rect, points });
  };
  const dev = new mupdf.Device({
    fillPath(path, _eo, ctm, cs) { take("fill", path, ctm); path.destroy(); cs.destroy(); },
    strokePath(path, stroke, ctm, cs) { take("stroke", path, ctm); path.destroy(); stroke.destroy(); cs.destroy(); },
  });
  try {
    page.runPageContents(dev, mupdf.Matrix.identity);
    dev.close();
  } finally {
    dev.destroy();
    page.destroy();
  }
  return out;
}

function linksOf(doc: mupdf.PDFDocument, pageIndex = 0): { uri: string; bounds: Rect }[] {
  const page = doc.loadPage(pageIndex);
  const links = page.getLinks();
  const out = links.map((l) => ({ uri: l.getURI(), bounds: l.getBounds() as Rect }));
  for (const l of links) l.destroy();
  page.destroy();
  return out;
}

const near = (a: number[], b: number[], eps = 0.05) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= eps);
const at = (doc: mupdf.PDFDocument, bbox: Rect, eps = 0.05) => pathsOf(doc).filter((p) => near(p.bbox, bbox, eps));
const linkTo = (doc: mupdf.PDFDocument, uri: string) => linksOf(doc).filter((l) => l.uri === uri);
const r2 = (v: number) => Math.round(v * 100) / 100;

/** The right edge of the characters of the line reading `t` (page space). */
function rightOf(s: EngineSession, t: string): number {
  return s.lines(0)[lineIndex(s, t)].bbox[2];
}

/**
 * What the user sees on page 1: its lines, every path's paint and bounds, its links and a render
 * (scale 1, after emptying MuPDF's store).
 */
function look(s: EngineSession) {
  const doc = docOf(s);
  mupdf.emptyStore();
  const shown = s.render(0, 1);
  return {
    lines: s.lines(0).map((l) => [l.text.trim(), r2(l.bbox[0]), r2(l.bbox[1])]),
    paths: pathsOf(doc).map((p) => [p.paint, ...p.bbox.map(r2)]),
    links: linksOf(doc).map((l) => [l.uri, ...l.bounds.map(r2)]),
    render: createHash("sha1").update(shown.rgba).digest("hex"),
  };
}

/** Changes every number, string and flag inside `v` (what a caller changing edits()' result could do). */
function scramble(v: unknown): void {
  if (!v || typeof v !== "object") return;
  const o = v as Record<string, unknown>;
  for (const [k, x] of Object.entries(o)) {
    if (typeof x === "number") o[k] = x + 1000;
    else if (typeof x === "string") o[k] = `${x}!`;
    else if (typeof x === "boolean") o[k] = !x;
    else scramble(x);
  }
}

/** A PDF made here with MuPDF. */
function makePdf(build: (doc: mupdf.PDFDocument) => void): Uint8Array {
  const doc = new mupdf.PDFDocument();
  try {
    build(doc);
    const buf = doc.saveToBuffer("compress=no");
    try {
      return buf.asUint8Array().slice();
    } finally {
      buf.destroy();
    }
  } finally {
    doc.destroy();
  }
}

/** The width of `s` in Helvetica at `size`. */
function width(s: string, size: number): number {
  const font = new mupdf.Font("Helvetica");
  try {
    let w = 0;
    for (const ch of s) w += font.advanceGlyph(font.encodeCharacter(ch.codePointAt(0)!)) * size;
    return w;
  } finally {
    font.destroy();
  }
}

// ---------------------------------------------------------------------------------------------

describe("the owner's cases through replaceLine", () => {
  it('"Pay online" made "Pay onlineeeeee": the underline and the link grow with it, one edit, the plan logged', () => {
    const s = open(fixture(CHROME));
    const oldRight = rightOf(s, "Pay online");
    const r = edit(s, "Pay online", "Pay onlineeeeee");
    expect(r).toMatchObject({ before: "Pay online", after: "Pay onlineeeeee", editCount: 1, changedPages: [0], missingChars: [] });
    expect(r.decorations).toEqual({ moved: ["underline"], removed: [], linksMoved: 1, linksRemoved: 0, left: [] });
    const grow = rightOf(s, "Pay onlineeeeee") - oldRight;
    expect(grow).toBeGreaterThan(24);
    expect(grow).toBeLessThan(26);
    const doc = docOf(s);
    expect(at(doc, PAY_UNDERLINE)).toHaveLength(0);
    expect(at(doc, [22, 31, 64.035 + grow, 31.75])).toHaveLength(1);
    expect(near(linkTo(doc, PAY)[0].bounds, [22, 22, 64 + grow, 32.5])).toBe(true);
    // The log: the line, and the plan as it was carried out, in page space and characters only.
    const [logged] = s.edits() as TextEdit[];
    expect(logged).toMatchObject({ kind: "text", pageIndex: 0, find: "Pay online", occurrence: 0, replacement: "Pay onlineeeeee" });
    const plan = logged.decorations!;
    expect(plan.shapes).toHaveLength(1);
    expect(plan.shapes[0]).toMatchObject({ kind: "underline", paint: "fill", range: [0, 10] });
    expect(near(plan.shapes[0].bbox, PAY_UNDERLINE, 0.01)).toBe(true);
    expect(plan.links).toHaveLength(1);
    expect(plan.links[0]).toMatchObject({ uri: PAY, range: [0, 10] });
    expect(near(plan.links[0].bounds, [22, 22, 64, 32.5], 0.01)).toBe(true);
    s.close();
  });

  it('"@anthropic" with the option: the pill grows about 27 pt with its round ends, its underline and link too', () => {
    const s = open(fixture(CHROME));
    const old = at(docOf(s), PILL)[0];
    const r = edit(s, "@anthropic", "@anthropiccccccc", { box: true });
    expect([...r.decorations!.moved].sort()).toEqual(["background", "underline"]);
    expect(r.decorations).toMatchObject({ removed: [], linksMoved: 1, linksRemoved: 0, left: [] });
    const doc = docOf(s);
    const pill = pathsOf(doc).find((p) => near(p.bbox.slice(0, 2), PILL.slice(0, 2)) && p.bbox[2] > 90)!;
    const grow = pill.bbox[2] - PILL[2];
    expect(grow).toBeGreaterThan(26);
    expect(grow).toBeLessThan(28);
    const mid = (PILL[0] + PILL[2]) / 2;
    expect(pill.points.length).toBe(old.points.length);
    pill.points.forEach((p, k) => {
      const o = old.points[k];
      expect(near(p, o[0] > mid ? [o[0] + grow, o[1]] : o, 0.002)).toBe(true);
    });
    expect(near(linkTo(doc, HANDLE)[0].bounds, [22, 40.75, 76 + grow, 55.75])).toBe(true);
    expect((s.edits()[0] as TextEdit).decorations!.shapes.map((x) => x.kind).sort()).toEqual(["background", "underline"]);
    s.close();
  });

  it("without options the pill follows as suggested; with box false it stays, and the plan logged leaves it out", () => {
    const suggested = open(fixture(CHROME));
    expect(suggested.lineDecorations(0, lineIndex(suggested, "@anthropic")).box).toEqual({ fill: true, stroke: false, suggested: true });
    expect([...edit(suggested, "@anthropic", "@anthropiccccccc").decorations!.moved].sort()).toEqual(["background", "underline"]);
    const asked = open(fixture(CHROME));
    edit(asked, "@anthropic", "@anthropiccccccc", { box: true });
    expect(look(suggested)).toEqual(look(asked));
    const empty = open(fixture(CHROME));
    edit(empty, "@anthropic", "@anthropiccccccc", {}); // ({}: as suggested too)
    expect(look(empty)).toEqual(look(asked));

    const s = open(fixture(CHROME));
    const r = edit(s, "@anthropic", "@anthropiccccccc", { box: false });
    expect(r.decorations).toEqual({ moved: ["underline"], removed: [], linksMoved: 1, linksRemoved: 0, left: [] });
    expect(at(docOf(s), PILL)).toHaveLength(1);
    expect((s.edits()[0] as TextEdit).decorations!.shapes.map((x) => x.kind)).toEqual(["underline"]);
    for (const x of [suggested, asked, empty, s]) x.close();
  });
});

describe("lineDecorations", () => {
  it("says what follows a plain printed line, what may follow, and what stays, changing nothing", () => {
    const s = open(fixture(CHROME));
    const before = look(s);
    const ask = (t: string) => s.lineDecorations(0, lineIndex(s, t));
    expect(ask("Pay online")).toEqual({ underlines: 1, strikes: 0, links: 1, box: null, left: [] });
    expect(ask("@anthropic")).toEqual({ underlines: 1, strikes: 0, links: 1, box: { fill: true, stroke: false, suggested: true }, left: [] });
    expect(ask("Old price 120,00 EUR")).toEqual({ underlines: 0, strikes: 1, links: 0, box: null, left: [] });
    expect(ask("Dashed underline")).toEqual({ ...NONE, left: [{ kind: "underline", reason: "pattern" }] });
    expect(ask("Overline text")).toEqual({ ...NONE, left: [{ kind: "overline", reason: "overline" }] });
    expect(ask("Section heading")).toEqual(NONE);
    expect(s.edits()).toEqual([]);
    expect(look(s)).toEqual(before);
    expectSessionError(() => s.lineDecorations(0, 999), "bad-request");
    expectSessionError(() => s.lineDecorations(7, 0), "bad-request");
    s.close();
    expectSessionError(() => s.lineDecorations(0, 0), "no-document");
  });

  it("answers what replaceLine then does, also for a line edited before", () => {
    const s = open(fixture(CHROME));
    edit(s, "Pay online", "Pay onlineeeeee");
    expect(s.lineDecorations(0, lineIndex(s, "Pay onlineeeeee"))).toEqual({ underlines: 1, strikes: 0, links: 1, box: null, left: [] });
    expect(edit(s, "Pay onlineeeeee", "Pay").decorations).toEqual({ moved: ["underline"], removed: [], linksMoved: 1, linksRemoved: 0, left: [] });
    // (The link ended 0.02 pt short of the text's right edge, and still does.)
    expect(near(linkTo(docOf(s), PAY)[0].bounds, [22, 22, rightOf(s, "Pay") - 0.02, 32.5], 0.1)).toBe(true);
    s.close();
  });
});

describe("what the result says", () => {
  it("what stays is said, even when nothing follows; a line without decorations says nothing", () => {
    const s = open(fixture(CHROME));
    const dashed = edit(s, "Dashed underline", "Dashed underline longer");
    expect(dashed.decorations).toEqual({ moved: [], removed: [], linksMoved: 0, linksRemoved: 0, left: [{ kind: "underline", reason: "pattern" }] });
    const plain = edit(s, "Section heading", "Section heading renamed");
    expect("decorations" in plain).toBe(false);
    // An ambiguous edit leaves the underline where it was, says so, and logs no plan.
    const ambiguous = edit(s, "Click here to pay", "Tap here now to pay");
    expect(ambiguous.decorations).toEqual({ moved: [], removed: [], linksMoved: 0, linksRemoved: 0, left: [{ kind: "underline", reason: "ambiguous" }] });
    expect(at(docOf(s), [44.01, 166, 62.03, 166.75])).toHaveLength(1);
    // Nothing logged carries a plan: the dashed rule was never planned, the ambiguous one was dropped.
    expect(s.edits().map((e) => "decorations" in e)).toEqual([false, false, false]);
    s.close();
  });

  it("a decorated run before the change stays on its characters, wherever the new text puts them", () => {
    const s = open(fixture(CHROME));
    // Written again, "here" lands about 0.01 pt left of where it was (the space after "Click" is
    // a little narrower than the original's): its underline follows that, and the plan is logged.
    const r = edit(s, "Click here to pay", "Click here to pay now");
    expect(r.decorations).toEqual({ moved: ["underline"], removed: [], linksMoved: 0, linksRemoved: 0, left: [] });
    expect((s.edits()[0] as TextEdit).decorations!.shapes).toMatchObject([{ kind: "underline", range: [6, 10] }]);
    expect(at(docOf(s), [44.01, 166, 62.03, 166.75], 0.05)).toHaveLength(1);
    s.close();
  });
});

describe("deleting a line", () => {
  it("removes its underline and link, and undo brings them back; with the option its pill goes too", () => {
    const s = open(fixture(CHROME));
    const before = look(s);
    const r = edit(s, "Pay online", "");
    expect(r.decorations).toEqual({ moved: [], removed: ["underline"], linksMoved: 0, linksRemoved: 1, left: [] });
    expect(at(docOf(s), PAY_UNDERLINE)).toHaveLength(0);
    expect(linkTo(docOf(s), PAY)).toEqual([]);
    const deleted = look(s);
    s.undo();
    expect(look(s)).toEqual(before);
    expect(near(linkTo(docOf(s), PAY)[0].bounds, [22, 22, 64, 32.5], 0.01)).toBe(true);
    s.redo();
    expect(look(s)).toEqual(deleted);

    const pill = edit(s, "@anthropic", "");
    expect([...pill.decorations!.removed].sort()).toEqual(["background", "underline"]);
    expect(pill.decorations!.linksRemoved).toBe(1);
    expect(at(docOf(s), PILL)).toHaveLength(0);
    expect(at(docOf(s), HANDLE_UNDERLINE)).toHaveLength(0);
    expect(linkTo(docOf(s), HANDLE)).toEqual([]);
    s.close();
  });
});

describe("history", () => {
  /** Edits of decorated and plain lines (some twice, one deleted), past a checkpoint. */
  const steps: [find: string, text: string, box?: boolean][] = [
    ["Pay online", "Pay onlineeeeee"],
    ["@anthropic", "@anthropiccccccc", true],
    ["Old price 120,00 EUR", "Old price 99,00 EUR"],
    ["Section heading", "Section heading renamed"],
    ["Pay now", "Pay now by card", true],
    ["Highlighted words", "Highlighted"],
    ["Click here to pay", "Click here to pay now"],
    ["Pay onlineeeeee", "Pay"], // the checkpoint after this one
    ["Thick underline", "Thick"],
    ["Double underline", ""],
  ];

  it("undo all, redo all and fresh replays across a checkpoint give every state again, the plans applied as logged", () => {
    expect(steps.length).toBeGreaterThan(CHECKPOINT_EVERY);
    const original = fixture(CHROME);
    const s = open(original);
    const states = [look(s)];
    const reports = steps.map(([find, text, box]) => {
      const r = edit(s, find, text, box === undefined ? undefined : { box });
      states.push(look(s));
      return r.decorations;
    });
    expect(reports.map((r) => r && [...r.moved].sort())).toEqual([
      ["underline"], ["background", "underline"], ["strike"], undefined, ["background"], ["background"], ["underline"], ["underline"],
      ["underline"], [],
    ]);
    expect(reports[9]).toMatchObject({ removed: ["underline", "underline"] });
    const log = s.edits();
    expect(log.map((e) => ("decorations" in e ? (e as TextEdit).decorations!.shapes.length + (e as TextEdit).decorations!.links.length : 0)))
      .toEqual([2, 3, 1, 0, 2, 1, 1, 2, 1, 2]);
    const checkpoints = (s as unknown as { checkpoints: { editCount: number }[] }).checkpoints.map((c) => c.editCount);
    expect(checkpoints).toEqual([CHECKPOINT_EVERY]);

    for (let k = log.length; k >= 1; k--) {
      expect(s.undo().editCount).toBe(k - 1);
      expect(look(s), `after undoing step ${k}`).toEqual(states[k - 1]);
    }
    for (let k = 1; k <= log.length; k++) {
      s.redo();
      expect(look(s), `after redoing step ${k}`).toEqual(states[k]);
    }
    expect(s.edits()).toEqual(log);

    // A fresh session replays the log (copies, from the original, no checkpoint) to the same states.
    const fresh = open(original);
    const apply = (fresh as unknown as { apply(doc: mupdf.PDFDocument, e: LoggedEdit): void }).apply.bind(fresh);
    log.forEach((e, k) => {
      apply(docOf(fresh), e);
      expect(look(fresh), `fresh replay of step ${k + 1}`).toEqual(states[k + 1]);
    });
    fresh.close();
    s.close();
  });

  it("a replay after a later unrelated edit and its undo gives the same page", () => {
    const s = open(fixture(CHROME));
    edit(s, "@anthropic", "@anthropiccccccc", { box: true });
    const edited = look(s);
    edit(s, "Overline text", "Overline text, edited");
    expect(look(s)).not.toEqual(edited);
    s.undo(); // rebuilt from the original: the first edit replayed with its plan
    expect(look(s)).toEqual(edited);
    s.close();
  });

  it("the log carries the plan as plain data, no offsets or names; edits() copies it deeply", () => {
    const s = open(fixture(CHROME));
    edit(s, "@anthropic", "@anthropiccccccc", { box: true });
    const [logged] = s.edits() as TextEdit[];
    expect(Object.keys(logged).sort()).toEqual(["decorations", "find", "kind", "occurrence", "pageIndex", "replacement"]);
    expect(Object.keys(logged.decorations!).sort()).toEqual(["links", "shapes"]);
    for (const shape of logged.decorations!.shapes) {
      expect(Object.keys(shape).sort()).toEqual(["bbox", "kind", "paint", "range"]);
      expect(shape.bbox.every(Number.isFinite)).toBe(true);
    }
    for (const link of logged.decorations!.links) expect(Object.keys(link).sort()).toEqual(["bounds", "range", "uri"]);
    expect(JSON.parse(JSON.stringify(logged))).toEqual(logged);
    const copy = s.edits();
    scramble(copy);
    expect(s.edits()).toEqual([logged]);
    // The log's own plan is applied by the next replay: it must still work.
    edit(s, "Overline text", "Overline text, edited");
    const now = look(s);
    s.undo();
    s.redo();
    expect(look(s)).toEqual(now);
    s.close();
  });

  it("a failed edit is rolled back by replaying the plans; so is a failure while the decorations follow", () => {
    const s = open(fixture(CHROME));
    edit(s, "Pay online", "Pay onlineeeeee");
    const after1 = look(s);
    inject.fail = "after";
    expectSessionError(() => edit(s, "@anthropic", "@anthropiccccccc", { box: true }), "edit-failed");
    expect(look(s)).toEqual(after1);
    expect(s.edits()).toHaveLength(1);
    inject.fail = "decorations";
    expectSessionError(() => edit(s, "@anthropic", "@anthropiccccccc", { box: true }), "edit-failed");
    expect(look(s)).toEqual(after1); // the line is not left edited without its decorations
    expect(s.edits()).toHaveLength(1);
    expect(edit(s, "@anthropic", "@anthropiccccccc", { box: true }).decorations!.linksMoved).toBe(1);
    s.close();
  });

  it("decorations that cannot be read do not stop the edit: the line is edited as without them", () => {
    const s = open(fixture(CHROME));
    inject.fail = "detect";
    expect(s.lineDecorations(0, lineIndex(s, "Pay online"))).toEqual(NONE);
    inject.fail = "detect";
    const r = edit(s, "Pay online", "Pay onlineeeeee");
    expect(r).toMatchObject({ after: "Pay onlineeeeee", editCount: 1 });
    expect("decorations" in r).toBe(false);
    expect("decorations" in s.edits()[0]).toBe(false);
    expect(at(docOf(s), PAY_UNDERLINE)).toHaveLength(1); // as release 3 left it
    s.close();
  });

  it("a replay whose plan the page no longer fits fails like an image edit's: undo refuses, redo rolls back", () => {
    const s = open(fixture(CHROME));
    edit(s, "Pay online", "Pay onlineeeeee");
    edit(s, "Overline text", "Overline text, edited");
    const now = look(s);
    const log = (s as unknown as { log: LoggedEdit[] }).log;
    (log[0] as TextEdit).decorations!.shapes[0].bbox[0] += 5; // a shape the page does not have
    expect(() => s.undo()).toThrow(DecorationMismatch);
    expect(s.edits()).toHaveLength(2); // nothing changed, the session goes on
    expect(look(s)).toEqual(now);
    (log[0] as TextEdit).decorations!.shapes[0].bbox[0] -= 5;

    s.undo();
    const undone = look(s);
    const redo = (s as unknown as { redoStack: LoggedEdit[] }).redoStack;
    expect(redo).toHaveLength(1);
    s.undo();
    const stack = redo as TextEdit[];
    stack[1].decorations!.links[0].uri = "https://example.com/other"; // the first edit's link, gone
    expectSessionError(() => s.redo(), "edit-failed");
    expect(s.edits()).toHaveLength(0);
    expect(stack).toHaveLength(2); // (it stays to redo)
    stack[1].decorations!.links[0].uri = PAY;
    s.redo();
    expect(look(s)).toEqual(undone);
    s.close();
  });
});

describe("save", () => {
  it("a normal PDF and a PDF/A keep the decorations where they followed, the links not mirrored", () => {
    const s = open(fixture(CHROME));
    edit(s, "Pay online", "Pay onlineeeeee");
    edit(s, "@anthropic", "@anthropiccccccc", { box: true });
    edit(s, "Old price 120,00 EUR", "");
    const shapes = pathsOf(docOf(s)).map((p) => p.bbox);
    const links = linksOf(docOf(s));
    for (const options of [undefined, { format: "pdfa-2b" as const, password: { mode: "none" as const } }]) {
      const saved = open(new Uint8Array(s.save(options).bytes));
      const again = pathsOf(docOf(saved)).map((p) => p.bbox);
      expect(again.length).toBe(shapes.length);
      again.forEach((b, k) => expect(near(b, shapes[k], 0.01)).toBe(true));
      const back = linksOf(docOf(saved));
      expect(back.map((l) => l.uri)).toEqual(links.map((l) => l.uri));
      back.forEach((l, k) => expect(near(l.bounds, links[k].bounds, 0.01)).toBe(true));
      expect(back.find((l) => l.uri === PAY)!.bounds[1]).toBeCloseTo(22, 1); // y down: near the top, as before
      saved.close();
    }
    s.close();
  });
});

describe("lines the app wrote", () => {
  it("an added line and a mixed line: no decorations asked or followed, as before", () => {
    const s = open(fixture(CHROME));
    // "Pay online" edited (its underline and link follow) is now the page's last text: a text
    // written just after it, on its baseline, joins its line (printed and added: mixed).
    edit(s, "Pay online", "Pay online!");
    const underline = pathsOf(docOf(s)).find((p) => near(p.bbox.slice(0, 2), PAY_UNDERLINE.slice(0, 2)))!.bbox;
    const link = linkTo(docOf(s), PAY)[0].bounds;
    expect(underline[2]).toBeGreaterThan(PAY_UNDERLINE[2] + 1);
    s.addText(0, [rightOf(s, "Pay online!") + 3, 30.25], "today", SANS9);
    const mixed = s.lines(0).find((l) => l.text.trim() === "Pay online! today")!;
    expect(mixed.added).toBe(false);
    expect(s.lineDecorations(0, mixed.index)).toEqual(NONE);
    const r = s.replaceLine(0, mixed.index, "Pay online!! today");
    expect(r.after).toBe("Pay online!! today");
    expect("decorations" in r).toBe(false);
    expect(JSON.stringify(s.edits().at(-1))).not.toContain("decorations");
    expect(at(docOf(s), underline)).toHaveLength(1); // left as it was
    expect(near(linkTo(docOf(s), PAY)[0].bounds, link, 0.01)).toBe(true);

    // A line made only of text the app wrote.
    s.addText(0, [300, 600], "Written here", SANS9);
    const added = s.lines(0).find((l) => l.text.trim() === "Written here")!;
    expect(added.added).toBe(true);
    expect(s.lineDecorations(0, added.index)).toEqual(NONE);
    expect("decorations" in s.replaceLine(0, added.index, "Written there", { box: true })).toBe(false);
    expect(s.edits().at(-1)!.kind).toBe("editAdded");
    s.close();
  });
});

describe("repeated lines", () => {
  it("the line edited is the one asked, with its own underline (occurrence)", () => {
    const bytes = makePdf((doc) => {
      const font = new mupdf.Font("Helvetica");
      let helv: mupdf.PDFObject;
      try {
        helv = doc.addSimpleFont(font);
      } finally {
        font.destroy();
      }
      const w = width("Total due", 12);
      let c = "";
      for (const y of [700, 650, 600]) c += `BT 0 0 0 rg /F1 12 Tf 50 ${y} Td (Total due) Tj ET 0 0 0 rg 50 ${y - 2} ${w.toFixed(3)} 0.6 re f\n`;
      doc.insertPage(-1, doc.addPage([0, 0, 400, 800], 0, { Font: { F1: helv } }, c));
    });
    const s = open(bytes);
    const before = pathsOf(docOf(s)).map((p) => p.bbox);
    expect(s.lines(0).map((l) => l.text.trim())).toEqual(["Total due", "Total due", "Total due"]);
    expect(s.lineDecorations(0, 1)).toEqual({ underlines: 1, strikes: 0, links: 0, box: null, left: [] });
    expect(s.replaceLine(0, 1, "Total due now").decorations).toMatchObject({ moved: ["underline"] });
    expect(s.edits()[0]).toMatchObject({ occurrence: 1 });
    const after = pathsOf(docOf(s)).map((p) => p.bbox);
    expect(near(after[0], before[0], 0.01)).toBe(true);
    expect(near(after[2], before[2], 0.01)).toBe(true);
    expect(after[1][1]).toBeCloseTo(before[1][1], 2);
    expect(after[1][2]).toBeGreaterThan(before[1][2] + 20);
    s.close();
  });
});

// ---------------------------------------------------------------------------------------------
// Fix round 1 (review findings D8/D20, D21, D22)

/** A Helvetica (WinAnsi, not embedded) page with `content`, and /ToUnicode `toUnicode` when given. */
function helveticaPage(content: string, toUnicode?: string): Uint8Array {
  return makePdf((doc) => {
    const font = doc.addObject({
      Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding",
      ...(toUnicode ? { ToUnicode: doc.addStream(toUnicode, {}) } : {}),
    });
    doc.insertPage(-1, doc.addPage([0, 0, 400, 800], 0, { Font: { F1: font } }, content));
  });
}

/** A /ToUnicode CMap that maps the printable ASCII codes to themselves, and nothing else (no 0xA0). */
const ASCII_TO_UNICODE = [
  "/CIDInit /ProcSet findresource begin 12 dict begin begincmap",
  "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
  "/CMapName /Adobe-Identity-UCS def /CMapType 2 def",
  "1 begincodespacerange <00> <FF> endcodespacerange",
  "1 beginbfrange <20> <7E> <0020> endbfrange",
  "endcmap CMapName currentdict /CMap defineresource pop end end",
].join("\n");

/** The page's lines as MuPDF reads them (each character's code points), for what the user cannot tell apart. */
const codes = (s: EngineSession) => s.lines(0).map((l) => [...l.text.trim()].map((c) => c.codePointAt(0)!.toString(16)).join(" "));

describe("text MuPDF reads back otherwise: a no-break space, a ligature (D8, D20)", () => {
  it("an amount with a no-break space before the euro sign: the strike-through follows, logged and replayed", () => {
    const s = open(fixture(CHROME));
    const original = look(s);
    const oldRight = rightOf(s, "Old price 120,00 EUR");
    // An amount from a web page, Excel or Intl formatting carries a no-break space before the €.
    const price = `Old price ${new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" }).format(99)}`;
    expect(price).toContain("\u00a0");
    const r = edit(s, "Old price 120,00 EUR", price);
    expect(r.decorations).toEqual({ moved: ["strike"], removed: [], linksMoved: 0, linksRemoved: 0, left: [] });
    // MuPDF reads it back as a space (the font draws it with its space).
    const now = s.lines(0).find((l) => l.text.trim().startsWith("Old price 99,00"))!.text.trim();
    expect(now).toBe("Old price 99,00 €");
    const [logged] = s.edits() as TextEdit[];
    expect(logged.replacement).toBe(price); // (the log keeps what the user asked)
    const [strike] = logged.decorations!.shapes;
    expect(strike).toMatchObject({ kind: "strike" });
    const shrink = rightOf(s, now) - oldRight;
    expect(shrink).toBeLessThan(-15);
    expect(at(docOf(s), strike.bbox)).toHaveLength(0);
    expect(at(docOf(s), [strike.bbox[0], strike.bbox[1], strike.bbox[2] + shrink, strike.bbox[3]])).toHaveLength(1);
    // Replays read the text back the same way: undo, redo and a fresh replay give the same page.
    const edited = look(s);
    s.undo();
    expect(look(s)).toEqual(original);
    s.redo();
    expect(look(s)).toEqual(edited);
    const fresh = open(fixture(CHROME));
    (fresh as unknown as { apply(doc: mupdf.PDFDocument, e: LoggedEdit): void }).apply(docOf(fresh), logged);
    expect(look(fresh)).toEqual(edited);
    fresh.close();
    s.close();
  });

  it("a no-break space or a ligature in the new text: the underline and the link follow", () => {
    for (const [text, read] of [
      ["Pay\u00a0online now", "Pay online now"],
      ["Pay online \ufb01ne", "Pay online fine"],
      ["Pay \ufb00", "Pay ff"],
      ["\ufb03 \ufb04 \ufb02 \ufb00\u00a0\ufb01", "ffi ffl fl ff fi"],
    ]) {
      const s = open(fixture(CHROME));
      const oldRight = rightOf(s, "Pay online");
      const r = edit(s, "Pay online", text);
      expect(r.decorations, text).toEqual({ moved: ["underline"], removed: [], linksMoved: 1, linksRemoved: 0, left: [] });
      const grow = rightOf(s, read) - oldRight;
      expect(at(docOf(s), [22, 31, 64.035 + grow, 31.75]), text).toHaveLength(1);
      expect(near(linkTo(docOf(s), PAY)[0].bounds, [22, 22, 64 + grow, 32.5]), text).toBe(true);
      const edited = look(s);
      s.undo();
      s.redo();
      expect(look(s), text).toEqual(edited);
      s.close();
    }
  });

  it("a font that reads the no-break space back as itself: the underline follows too", () => {
    // Helvetica with a /ToUnicode for ASCII only: replaceText draws U+00A0 with WinAnsi's code
    // 0xA0 and adds it to /ToUnicode, so MuPDF reads it back as U+00A0, not as a space.
    const w = width("Total due", 12);
    const s = open(helveticaPage(`BT 0 0 0 rg /F1 12 Tf 50 700 Td (Total due) Tj ET 0 0 0 rg 50 698 ${w.toFixed(3)} 0.6 re f\n`, ASCII_TO_UNICODE));
    expect(s.lineDecorations(0, 0)).toEqual({ underlines: 1, strikes: 0, links: 0, box: null, left: [] });
    const r = s.replaceLine(0, 0, "Total\u00a0due now");
    expect(codes(s)).toEqual(["54 6f 74 61 6c a0 64 75 65 20 6e 6f 77"]);
    expect(r.decorations).toEqual({ moved: ["underline"], removed: [], linksMoved: 0, linksRemoved: 0, left: [] });
    const right = s.lines(0)[0].bbox[2];
    expect(pathsOf(docOf(s)).map((p) => p.bbox.map(r2))).toEqual([[50, 101.4, r2(right), 102]]);
    const edited = look(s);
    s.undo();
    s.redo();
    expect(look(s)).toEqual(edited);
    s.close();
  });

  it("a line with a printed part and an added one: a no-break space in the printed part still moves the added text right", () => {
    // (The same reading of the text written, for the added lines that follow a printed part.)
    const s = open(helveticaPage("BT 0 0 0 rg /F1 12 Tf 50 700 Td (Data:) Tj ET\n"));
    s.addText(0, [rightOf(s, "Data:") + 4, 100], "12/03/1980", { ...SANS9, size: 12 });
    const mixed = s.lines(0).find((l) => l.text.trim() === "Data: 12/03/1980")!;
    expect(mixed.added).toBe(false);
    s.replaceLine(0, mixed.index, "Data di\u00a0nascita: 12/03/1980");
    const label = s.lines(0).find((l) => l.text.startsWith("Data"))!;
    expect(label.text).toBe("Data di nascita:");
    // The date moved right with the label's end (as much as it grew): the two do not overlap.
    const [date] = s.addedTexts(0);
    expect(date.text).toBe("12/03/1980");
    expect(date.origin[0]).toBeGreaterThan(label.bbox[2]);
    expect(date.origin[0] - label.bbox[2]).toBeCloseTo(4, 1);
    s.close();
  });
});

describe("vertical lines say what stays (D21)", () => {
  /** "Pay" written down a column (Identity-V), under a link, at (100, 700) user space on a 400×800 page. */
  function verticalPay(rule = ""): Uint8Array {
    return makePdf((doc) => {
      const helv = new mupdf.Font("Helvetica");
      let font: mupdf.PDFObject, hex = "";
      try {
        font = doc.addFont(helv);
        for (const ch of "Pay") hex += helv.encodeCharacter(ch.codePointAt(0)!).toString(16).padStart(4, "0");
      } finally {
        helv.destroy();
      }
      font.put("Encoding", doc.newName("Identity-V"));
      const pageObj = doc.addPage([0, 0, 400, 800], 0, { Font: { F1: font } }, `BT 0 0 0 rg /F1 20 Tf 100 700 Td <${hex}> Tj ET\n${rule}\n`);
      doc.insertPage(-1, pageObj);
      const page = doc.loadPage(0);
      try {
        // The column runs down from y 100 (page space) about 3 em: the link covers it.
        page.createLink([80, 95, 120, 175], "https://example.com/pay").destroy();
      } finally {
        page.destroy();
      }
    });
  }

  it("lineDecorations and the edit report the link that stays, with the reason; nothing moves", () => {
    const s = open(verticalPay());
    const [line] = s.lines(0);
    expect(line).toMatchObject({ text: "Pay", vertical: true });
    const left = [{ kind: "link", reason: "direction" }];
    expect(s.lineDecorations(0, 0)).toEqual({ ...NONE, left });
    const links = linksOf(docOf(s));
    expect(links).toHaveLength(1);
    const r = s.replaceLine(0, 0, "Pay now");
    expect(r.decorations).toEqual({ moved: [], removed: [], linksMoved: 0, linksRemoved: 0, left });
    expect(linksOf(docOf(s))).toEqual(links); // left as it was
    expect("decorations" in s.edits()[0]).toBe(false);
    s.close();
  });

  it("with a rule along the column too: whatever is said stays for the direction, nothing is planned or moved; a delete says it", () => {
    const s = open(verticalPay("0 0 0 rg 90 640 0.6 60 re f")); // (page space x 90..90.6, beside the glyphs, y 100..160)
    const info = s.lineDecorations(0, 0);
    expect(info).toMatchObject({ underlines: 0, strikes: 0, links: 0, box: null });
    expect(info.left).toContainEqual({ kind: "link", reason: "direction" });
    expect(info.left.every((l) => l.reason === "direction")).toBe(true);
    const shapes = pathsOf(docOf(s)).map((p) => p.bbox), links = linksOf(docOf(s));
    const r = s.replaceLine(0, 0, "Pay now", { box: true });
    expect(r.decorations).toEqual({ moved: [], removed: [], linksMoved: 0, linksRemoved: 0, left: info.left });
    expect(pathsOf(docOf(s)).map((p) => p.bbox)).toEqual(shapes);
    expect(linksOf(docOf(s))).toEqual(links);
    const gone = s.replaceLine(0, 0, "");
    expect(gone.decorations).toEqual({ moved: [], removed: [], linksMoved: 0, linksRemoved: 0, left: info.left });
    expect(linksOf(docOf(s))).toEqual(links);
    expect(s.edits().map((e) => "decorations" in e)).toEqual([false, false]);
    s.close();
  });
});

describe("what stays is said only when the edit reaches its characters (D22)", () => {
  /** "Total 120,00" (Helvetica 12 at 50, 700) with a rule drawn by `rule` (the finding's page). */
  const total = (rule: string) => helveticaPage(`BT 0 0 0 rg /F1 12 Tf 50 700 Td (Total 120,00) Tj ET\n${rule}\n`);
  const w = width("Total", 12).toFixed(2);
  /** Under, over "Total" only: dashed, red, an overline. */
  const DASHED = `q [2 2] 0 d 0.6 w 0 0 0 RG 50 697.5 m ${(50 + Number(w)).toFixed(2)} 697.5 l S Q`;
  const RED = `1 0 0 rg 50 697.2 ${w} 0.6 re f`;
  const OVER = `0 0 0 rg 50 710.2 ${w} 0.6 re f`;
  const reasons: [string, string, string][] = [["dashed", DASHED, "pattern"], ["red", RED, "colour"], ["overline", OVER, "overline"]];

  it("a rule under an untouched prefix gives no `left`, the edit after it changes nothing of it", () => {
    for (const [name, rule, reason] of reasons) {
      const s = open(total(rule));
      const kind = reason === "overline" ? "overline" : "underline";
      expect(s.lineDecorations(0, 0), name).toEqual({ ...NONE, left: [{ kind, reason }] });
      const shapes = pathsOf(docOf(s)).map((p) => p.bbox);
      for (const text of ["Total 130,00", "Total 1.130,00", "Total 99", "Total"]) {
        const r = s.replaceLine(0, 0, text);
        expect("decorations" in r, `${name}: ${text}`).toBe(false);
        expect(pathsOf(docOf(s)).map((p) => p.bbox), `${name}: ${text}`).toEqual(shapes);
      }
      s.close();
    }
  });

  it("...but it is said when the edit changes or moves its characters, or deletes the line", () => {
    for (const [name, rule, reason] of reasons) {
      const kind = reason === "overline" ? "overline" : "underline";
      const left = { moved: [], removed: [], linksMoved: 0, linksRemoved: 0, left: [{ kind, reason }] };
      for (const text of ["Totale 120,00", "Totals 120,00", "Tot 120,00", "Il totale 120,00", "Grand Total 120,00", ""]) {
        const s = open(total(rule));
        expect(s.replaceLine(0, 0, text).decorations, `${name}: "${text}"`).toEqual(left);
        s.close();
      }
    }
  });

  it("a rule under the end of the line is said when the change is before it (its characters move)", () => {
    const x = 50 + width("Total ", 12);
    const page = total(`q [2 2] 0 d 0.6 w 0 0 0 RG ${x.toFixed(2)} 697.5 m ${(x + width("120,00", 12)).toFixed(2)} 697.5 l S Q`);
    const left = [{ kind: "underline", reason: "pattern" }];
    for (const text of ["Totale 120,00", "Tot. 120,00", "Total 120,50", "Total 120,00 EUR", ""]) {
      const s = open(page);
      expect(s.lineDecorations(0, 0)).toEqual({ ...NONE, left });
      expect(s.replaceLine(0, 0, text).decorations, `"${text}"`).toEqual({ moved: [], removed: [], linksMoved: 0, linksRemoved: 0, left });
      s.close();
    }
  });
});

describe("options", () => {
  it("anything but an object with at most a boolean box is refused, with nothing done", () => {
    const s = open(fixture(CHROME));
    const before = look(s);
    const index = lineIndex(s, "@anthropic");
    for (const options of [null, 1, "box", true, [], [true], { box: "yes" }, { box: 1 }, { box: null }, { other: true }, { box: true, extra: 1 }])
      expectSessionError(() => s.replaceLine(0, index, "@anthropiccccccc", options as never), "bad-request");
    expect(s.edits()).toEqual([]);
    expect(look(s)).toEqual(before);
    // ...refused even for a line that would be a no-op, or that holds no decorations.
    expectSessionError(() => s.replaceLine(0, index, "@anthropic", { box: "no" } as never), "bad-request");
    expect(s.replaceLine(0, index, "@anthropic", { box: false }).changedPages).toEqual([]);
    expect(s.replaceLine(0, index, "@anthropiccccccc", { box: undefined }).decorations!.linksMoved).toBe(1);
    s.close();
  });
});
