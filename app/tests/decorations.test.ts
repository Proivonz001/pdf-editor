// Decorations that follow an edited line (decorations.ts): detection, the character mapping, and
// the rewrite after core.replaceText, in Node on the worker's mupdf build (1.27.0), edited the way
// the session edits a line (detect, plan, beforeEdit, replaceText, applyDecorations).
//
// Fixtures (no personal data): decorations-chrome.pdf (Chrome-printed, tagged: a link with an
// underline, an "@handle" pill, buttons, a chip, <s>, <mark>, dashed, dotted, wavy, double and
// thick underlines, an overline, a table, form rules, a link wrapping onto two lines) and
// decorations-synthetic.pdf (Word-style `re f` underline, stroked underline, strike polygon,
// rounded button, form rule, 30° text, a box shared by two lines, an accounting rule, an underline
// inside a Form XObject, a translucent marker). Every case of the prototype's three case files
// (cases-chrome.json, cases-synth.json, cases-delete.json) is here with the outcome expected.
// decorations-layout.pdf (Chrome-printed, Arial 12px, A4, one case a page: the review's): 1 and 2,
// a sum column "1.234,56 / 1.234,56 / 2.469,12" in a right-aligned 120px div, the total with
// `text-decoration: overline`, then with `border-top: 1px solid`; 3, a table with the default
// border-spacing and `td { border-bottom: 1px solid #000; padding: 1px }`; 4, the same table with
// `td { background: #eef; padding: 2px 4px }`; 5, a 10px line with `text-decoration: underline
// dotted; text-decoration-thickness: 3px`; 6, a block link (300px) over a 120px blue box and the
// caption "Scopri la nuova collezione".
import { readFileSync } from "node:fs";
import * as mupdf from "mupdf";
import { afterEach, describe, expect, it } from "vitest";
import { countOccurrences, extractLines, releaseFallbackFonts, releasePage, renderPixmap, replaceText, savePdf } from "../src/engine/core.js";
import {
  DecorationMismatch, MAX_PATHS, applyDecorations, beforeEdit, detectDecorations, mapRun, planOf, summaryOf,
  type DecorationPlan, type Detected,
} from "../src/engine/decorations";
import { srgbProfile } from "../src/engine/icc";
import { checkPdfA, convertToPdfA } from "../src/engine/pdfa";
import type { DecorationReport, Rect } from "../src/engine/protocol";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

/** Documents opened by a test, destroyed after it with their fallback fonts (rule 5). */
let opened: mupdf.PDFDocument[] = [];
afterEach(() => {
  for (const doc of opened) {
    releaseFallbackFonts(doc);
    doc.destroy();
  }
  opened = [];
});
const openBytes = (bytes: Uint8Array) => {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf").asPDF()!;
  opened.push(doc);
  return doc;
};
const openFixture = (name: string) => openBytes(fixture(name));
const reopen = (doc: mupdf.PDFDocument) => openBytes(savePdf(mupdf, doc).bytes);

function saveBytes(doc: mupdf.PDFDocument, options = "compress=no"): Uint8Array {
  const buf = doc.saveToBuffer(options);
  try {
    return buf.asUint8Array().slice();
  } finally {
    buf.destroy();
  }
}

type Char = { c: string; quad: number[]; origin: number[] };
type RawLine = { text: string; chars: Char[]; dir: number[] };

/** The page's lines as core.extractLines reads them (plain data). */
function linesOf(doc: mupdf.PDFDocument, pageIndex = 0): RawLine[] {
  const page = doc.loadPage(pageIndex);
  const lines = extractLines(page) as RawLine[];
  const out = lines.map((l) => ({ text: l.text, dir: [...l.dir], chars: l.chars.map((c) => ({ c: c.c, quad: [...c.quad], origin: [...c.origin] })) }));
  releasePage(page, lines as never);
  return out;
}

/** `find` and `occurrence` for the `nth` line reading `text`, as session.ts's locateLine works them out. */
function locate(doc: mupdf.PDFDocument, text: string, nth = 0, pageIndex = 0) {
  const lines = linesOf(doc, pageIndex);
  const targets = lines.filter((l) => l.text.trim() === text);
  const target = targets[nth];
  if (!target) throw new Error(`no line "${text}"`);
  const find = target.text.trim();
  let occurrence = 0;
  for (const l of lines) {
    if (l === target) break;
    occurrence += countOccurrences(l.text, find);
  }
  return { find, occurrence };
}

interface Edited {
  find: string;
  detected: Detected;
  plan: DecorationPlan;
  written: string;
  applied: DecorationPlan;
  report: DecorationReport;
  missing: string[];
}

/** A line edit as the session makes it, decorations included; `box` is the option (absent: as suggested). */
function edit(doc: mupdf.PDFDocument, text: string, replacement: string, { box, nth = 0, pageIndex = 0 }: { box?: boolean; nth?: number; pageIndex?: number } = {}): Edited {
  const { find, occurrence } = locate(doc, text, nth, pageIndex);
  const detected = detectDecorations(mupdf, doc, pageIndex, find, occurrence);
  const plan = planOf(detected, box);
  const before = beforeEdit(mupdf, doc, pageIndex, find, occurrence);
  const result = replaceText(mupdf, doc, pageIndex, find, replacement, { occurrence });
  const written = result.segments.map((s: { text: string }) => s.text).join("");
  const { applied, report } = applyDecorations(mupdf, doc, pageIndex, plan, before, find, written, false);
  return { find, detected, plan, written, applied, report, missing: result.missing };
}

/** A path MuPDF paints, as a test device sees it (page space). */
interface Painted {
  paint: "fill" | "stroke";
  bbox: Rect;
  colour: number[];
  points: [number, number][];
}

/** Every path MuPDF paints on the page, in order. */
function pathsOf(doc: mupdf.PDFDocument, pageIndex = 0): Painted[] {
  const page = doc.loadPage(pageIndex);
  const out: Painted[] = [];
  const take = (paint: Painted["paint"], path: mupdf.Path, ctm: mupdf.Matrix, color: number[]) => {
    const points: [number, number][] = [];
    const at = (x: number, y: number): [number, number] => [x * ctm[0] + y * ctm[2] + ctm[4], x * ctm[1] + y * ctm[3] + ctm[5]];
    path.walk({ moveTo: (x, y) => points.push(at(x, y)), lineTo: (x, y) => points.push(at(x, y)), curveTo: (a, b, c, d, e, f) => points.push(at(a, b), at(c, d), at(e, f)) });
    out.push({ paint, bbox: path.getBounds(null as unknown as mupdf.StrokeState, ctm) as Rect, colour: [...color], points });
  };
  const dev = new mupdf.Device({
    fillPath(path, _eo, ctm, cs, color) { take("fill", path, ctm, color); path.destroy(); cs.destroy(); },
    strokePath(path, stroke, ctm, cs, color) { take("stroke", path, ctm, color); path.destroy(); stroke.destroy(); cs.destroy(); },
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

/** The small subpaths of the clips MuPDF applies (skip-ink holes cut in underlines), page space. */
function holesOf(doc: mupdf.PDFDocument, pageIndex = 0): Rect[] {
  const page = doc.loadPage(pageIndex);
  const out: Rect[] = [];
  const dev = new mupdf.Device({
    clipPath(path, _eo, ctm) {
      const subpaths: [number, number][][] = [];
      const at = (x: number, y: number): [number, number] => [x * ctm[0] + y * ctm[2] + ctm[4], x * ctm[1] + y * ctm[3] + ctm[5]];
      path.walk({ moveTo: (x, y) => subpaths.push([at(x, y)]), lineTo: (x, y) => subpaths[subpaths.length - 1]?.push(at(x, y)) });
      path.destroy();
      for (const sp of subpaths) {
        const xs = sp.map((p) => p[0]), ys = sp.map((p) => p[1]);
        const r: Rect = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
        if (r[2] - r[0] < 20 && r[3] - r[1] < 5) out.push(r);
      }
    },
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

const near = (a: number[], b: number[], eps = 0.05) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= eps);
const at = (paths: Painted[], bbox: Rect, eps = 0.05) => paths.filter((p) => near(p.bbox, bbox, eps));

/** The edges of the characters of the line reading `text` (starting with it), along x: [left, right] per character. */
function edgesOf(doc: mupdf.PDFDocument, text: string, pageIndex = 0): [number, number][] {
  const line = linesOf(doc, pageIndex).find((l) => l.text.trimStart().startsWith(text));
  if (!line) throw new Error(`no line starting "${text}"`);
  const lead = line.text.length - line.text.trimStart().length;
  return line.chars.slice(lead, lead + text.length).map((c) => [Math.min(c.quad[0], c.quad[4]), Math.max(c.quad[2], c.quad[6])]);
}

/**
 * What a horizontal shape's bounds should become: its run's start and end move as the run's first
 * and last characters do (mapRun gives the new run).
 */
function expectedBox(bbox: Rect, range: [number, number], oldText: string, newText: string, oldEdges: [number, number][], newEdges: [number, number][]): Rect {
  const m = mapRun(range, oldText, newText);
  if (!("range" in m)) throw new Error("not moved");
  const dl = newEdges[m.range[0]][0] - oldEdges[range[0]][0], dr = newEdges[m.range[1] - 1][1] - oldEdges[range[1] - 1][1];
  return [bbox[0] + dl, bbox[1], bbox[2] + dr, bbox[3]];
}

/** A pixel's red channel (gray pages: enough) of an RGB pixmap rendered at `scale`, at page point (x, y). */
function redAt(pix: mupdf.Pixmap, scale: number, x: number, y: number): number {
  const i = (Math.round(y * scale) - pix.getY()) * pix.getStride() + (Math.round(x * scale) - pix.getX()) * pix.getNumberOfComponents();
  return pix.getPixels()[i];
}

const kinds = (d: Detected) => ({
  ...summaryOf(d),
  options: d.shapes.filter((s) => s.level === "option").map((s) => s.plan.kind),
});

// ---------------------------------------------------------------------------------------------

describe("mapRun: what a decorated run becomes", () => {
  const map = (run: [number, number], old: string, now: string) => {
    const m = mapRun(run, old, now);
    return "range" in m ? now.slice(...m.range) : "removed" in m ? "removed" : "ambiguous";
  };
  const line = "Click here to pay"; // "here" is [6, 10)
  it("the whole line's run covers the whole new line", () => {
    expect(map([0, 17], line, "Tap now")).toBe("Tap now");
    expect(map([0, 17], line, "")).toBe("removed");
  });
  it("text typed right after a run continues it; a change after it leaves it", () => {
    expect(map([6, 10], line, "Click heres to pay")).toBe("heres");
    expect(map([6, 10], line, "Click here now to pay")).toBe("here");
    expect(map([6, 10], line, "Click here to pay now")).toBe("here");
  });
  it("text stuck to the front of the decorated word takes the decoration, a separate word does not", () => {
    expect(map([6, 10], line, "Click there to pay")).toBe("there");
    expect(map([6, 10], line, "Click now here to pay")).toBe("here");
    expect(map([0, 5], line, "XClick here to pay")).toBe("XClick"); // at the start of the line
  });
  it("a run before or after the change moves with its characters", () => {
    expect(map([6, 10], line, "Please click here to pay")).toBe("here");
    expect(map([6, 10], line, "Click here to pay it")).toBe("here");
    expect(map([0, 5], line, "Click here to pay it")).toBe("Click");
  });
  it("a change inside the run changes it; its words replaced become the new words", () => {
    expect(map([6, 10], line, "Click hire to pay")).toBe("hire");
    expect(map([6, 10], line, "Click hereafter to pay")).toBe("hereafter");
    expect(map([0, 5], "Draft  status chip", "Approved  status chip")).toBe("Approved");
  });
  it("a run whose text went is removed; any run goes when the line is emptied", () => {
    expect(map([6, 10], line, "Click to pay")).toBe("removed");
    expect(map([6, 10], line, "")).toBe("removed");
  });
  it("a change across a run's edge is ambiguous", () => {
    expect(map([6, 10], line, "Tap here now to pay")).toBe("ambiguous");
    expect(map([6, 10], line, "Click hello")).toBe("ambiguous");
    expect(map([6, 10], line, "Please tap to pay")).toBe("ambiguous");
  });
});

describe("detection on decorations-chrome.pdf", () => {
  const cases: [string, Partial<ReturnType<typeof kinds>>][] = [
    ["Pay online", { underlines: 1, links: 1, left: [], box: null }],
    ["@anthropic", { underlines: 1, links: 1, left: [], box: { fill: true, stroke: false, suggested: true }, options: ["background"] }],
    ["Draft  status chip", { underlines: 0, links: 0, left: [], box: { fill: true, stroke: false, suggested: true } }],
    ["Pay now", { links: 1, left: [], box: { fill: true, stroke: false, suggested: true } }],
    ["Old price 120,00 EUR", { strikes: 1, left: [], box: null }],
    ["Red underline on dark text", { underlines: 0, left: [{ kind: "underline", reason: "colour" }] }],
    ["Click here to pay", { underlines: 1, left: [] }],
    ["Highlighted words", { left: [], box: { fill: true, stroke: false, suggested: true } }],
    ["Dashed underline", { underlines: 0, left: [{ kind: "underline", reason: "pattern" }] }],
    ["Dotted underline", { underlines: 0, left: [{ kind: "underline", reason: "pattern" }] }],
    ["Wavy underline", { underlines: 0, left: [] }], // a picture: not seen
    ["Double underline", { underlines: 2, left: [] }],
    ["Thick underline", { underlines: 1, left: [] }],
    ["Overline text", { underlines: 0, left: [{ kind: "overline", reason: "overline" }] }],
    ["Section heading", { underlines: 0, left: [], box: null }], // the rule spans the page
    ["Claude Pro", { underlines: 0, left: [], box: null }], // table rules and cells
    ["20,00 EUR", { underlines: 1, left: [] }],
    ["Note line one", { left: [], box: null }], // the note's box holds two lines and is much wider
    ["Signature:", { underlines: 0, left: [] }], // the rule after the label
    ["Name: ____________________", { underlines: 0, left: [] }],
    ["A long link that wraps", { underlines: 1, links: 1, left: [] }],
    ["onto a second line", { underlines: 1, links: 1, left: [] }],
  ];
  for (const [text, want] of cases)
    it(JSON.stringify(text), () => {
      const doc = openFixture("decorations-chrome.pdf");
      const { find, occurrence } = locate(doc, text);
      expect(kinds(detectDecorations(mupdf, doc, 0, find, occurrence))).toMatchObject(want);
    });

  it("ranges index the trimmed line; a chip covers its word only", () => {
    const doc = openFixture("decorations-chrome.pdf");
    const chip = detectDecorations(mupdf, doc, 0, "Draft  status chip", 0);
    expect(chip.shapes.map((s) => s.plan.range)).toEqual([[0, 5]]);
    const here = detectDecorations(mupdf, doc, 0, "Click here to pay", 0);
    expect(here.shapes.map((s) => [s.plan.kind, s.plan.range])).toEqual([["underline", [6, 10]]]);
    expect(locate(doc, "Signature:").find).toBe("Signature:"); // (the line has two trailing spaces)
  });

  it("planOf takes the auto items, and the box when asked or suggested", () => {
    const doc = openFixture("decorations-chrome.pdf");
    const d = detectDecorations(mupdf, doc, 0, "@anthropic", 0);
    expect(planOf(d, undefined).shapes.map((s) => s.kind).sort()).toEqual(["background", "underline"]);
    expect(planOf(d, true).shapes.length).toBe(2);
    expect(planOf(d, false).shapes.map((s) => s.kind)).toEqual(["underline"]);
    expect(planOf(d, false).links.map((l) => l.uri)).toEqual(["https://example.com/u/anthropic"]);
    // Plain JSON: it goes into the edit log as it is.
    const plan = planOf(d, true);
    expect(JSON.parse(JSON.stringify(plan))).toEqual(plan);
  });

  it("a missing line throws", () => {
    const doc = openFixture("decorations-chrome.pdf");
    expect(() => detectDecorations(mupdf, doc, 0, "No such line", 0)).toThrow(/not found/);
    expect(() => detectDecorations(mupdf, doc, 0, "Pay online", 1)).toThrow(/not found/);
  });
});

describe("detection on decorations-synthetic.pdf", () => {
  const cases: [string, Partial<ReturnType<typeof kinds>>][] = [
    ["Word style underline", { underlines: 1, links: 1, left: [] }], // re f drawn after the text
    ["Stroked line underline", { underlines: 1, left: [] }], // a stroked line, drawn before
    ["Struck through text", { strikes: 1, left: [] }], // a filled polygon, drawn after
    ["Rounded button", { left: [], box: { fill: true, stroke: false, suggested: true } }],
    ["Nome:", { underlines: 0, left: [], box: null }], // the form's rule after the label
    ["Rotated link text", { underlines: 0, left: [{ kind: "underline", reason: "direction" }] }],
    ["Shared box line one", { left: [], box: null }], // one box for two lines
    ["1.234,56", { underlines: 0, left: [{ kind: "overline", reason: "overline" }] }], // an accounting rule
    ["Inside a form", { underlines: 0, left: [{ kind: "underline", reason: "form" }] }],
    ["Marker over text", { left: [], box: { fill: true, stroke: false, suggested: true } }], // translucent, over the text
  ];
  for (const [text, want] of cases)
    it(JSON.stringify(text), () => {
      const doc = openFixture("decorations-synthetic.pdf");
      const { find, occurrence } = locate(doc, text);
      expect(kinds(detectDecorations(mupdf, doc, 0, find, occurrence))).toMatchObject(want);
    });
});

// ---------------------------------------------------------------------------------------------

describe("the owner's cases", () => {
  it('"Pay online" made "Pay onlineeeeee": the underline and the link grow with it, the skip-ink hole stays', () => {
    const doc = openFixture("decorations-chrome.pdf");
    const before = pathsOf(doc);
    const holesBefore = holesOf(doc);
    const oldEdges = edgesOf(doc, "Pay online");
    const e = edit(doc, "Pay online", "Pay onlineeeeee");
    expect(e.report).toEqual({ moved: ["underline"], removed: [], linksMoved: 1, linksRemoved: 0, left: [] });
    expect(e.applied).toEqual(e.plan);
    const grow = edgesOf(doc, "Pay onlineeeeee")[14][1] - oldEdges[9][1];
    expect(grow).toBeGreaterThan(24);
    expect(grow).toBeLessThan(26);
    const after = pathsOf(doc);
    const underline: Rect = [22, 31, 64.035, 31.75];
    expect(at(before, underline)).toHaveLength(1);
    expect(at(after, underline)).toHaveLength(0);
    expect(at(after, [22, 31, 64.035 + grow, 31.75])).toHaveLength(1);
    expect(near(linksOf(doc).find((l) => l.uri === "https://example.com/pay")!.bounds, [22, 22, 64 + grow, 32.5])).toBe(true);
    // The skip-ink hole under the "y" (Chrome's clip) still cuts the underline where it did.
    const hole = (r: Rect) => r[1] > 30 && r[3] < 33;
    expect(holesOf(doc).filter(hole)).toEqual(holesBefore.filter(hole));
    expect(holesBefore.filter(hole).map((r) => r.map((v) => Math.round(v))).length).toBe(1);
    const page = doc.loadPage(0);
    const pix = renderPixmap(mupdf, page, 4);
    page.destroy();
    try {
      expect(redAt(pix, 4, 30, 31.4)).toBeLessThan(160); // the underline
      expect(redAt(pix, 4, 80, 31.4)).toBeLessThan(160); // the underline's new part
      expect(redAt(pix, 4, 90, 31.4)).toBe(255); // past its end
    } finally {
      pix.destroy();
    }
  });

  it('"@anthropic" with the option: the pill grows about 27 pt with exactly the same round ends, its underline and link too', () => {
    const doc = openFixture("decorations-chrome.pdf");
    const pill: Rect = [22, 40.75, 76, 55.75];
    const old = at(pathsOf(doc), pill)[0];
    const e = edit(doc, "@anthropic", "@anthropiccccccc", { box: true });
    expect([...e.report.moved].sort()).toEqual(["background", "underline"]);
    expect(e.report.linksMoved).toBe(1);
    const grown = pathsOf(doc).find((p) => near(p.bbox.slice(0, 2), [22, 40.75]) && near(p.colour, old.colour, 0.001) && p.bbox[2] > 90)!;
    const grow = grown.bbox[2] - pill[2];
    expect(grow).toBeGreaterThan(26);
    expect(grow).toBeLessThan(28);
    // Point by point: the left end where it was, the right end moved by `grow`, nothing else changed.
    expect(grown.points.length).toBe(old.points.length);
    const mid = (pill[0] + pill[2]) / 2;
    grown.points.forEach((p, k) => {
      const o = old.points[k];
      expect(near(p, o[0] > mid ? [o[0] + grow, o[1]] : o, 0.002)).toBe(true);
    });
    expect(near(linksOf(doc).find((l) => l.uri === "https://example.com/u/anthropic")!.bounds, [22, 40.75, 76 + grow, 55.75])).toBe(true);
    // The rendered pill: its colour in the new right end, white past it, and the ends alike.
    const page = doc.loadPage(0);
    const pix = renderPixmap(mupdf, page, 2);
    page.destroy();
    try {
      expect(redAt(pix, 2, 76 + grow - 2, 44)).toBe(245);
      expect(redAt(pix, 2, 76 + grow + 1.5, 44)).toBe(255);
      expect(redAt(pix, 2, 22.5, 42)).toBe(redAt(pix, 2, 76 + grow - 0.5, 42));
    } finally {
      pix.destroy();
    }
  });

  it("without the option the pill stays, the underline and the link still follow", () => {
    const doc = openFixture("decorations-chrome.pdf");
    const e = edit(doc, "@anthropic", "@anthropiccccccc", { box: false });
    expect(e.report).toMatchObject({ moved: ["underline"], linksMoved: 1, left: [] });
    expect(at(pathsOf(doc), [22, 40.75, 76, 55.75])).toHaveLength(1);
  });

  it('"@anthropic" made "x" (narrower than the pill\'s round ends): the pill becomes just its two ends, exact, where it was', () => {
    // Round 4's review: the pill's sides would cross, and it stayed ("complex"). With the option or
    // as suggested (no option given), the same.
    const sliver = 0.02; // decorations.ts SLIVER: what is kept of the straight sides
    for (const box of [true, undefined]) {
      const doc = openFixture("decorations-chrome.pdf");
      const pill: Rect = [22, 40.75, 76, 55.75], radius = 7.5;
      const old = at(pathsOf(doc), pill)[0];
      const oldEdges = edgesOf(doc, "@anthropic");
      const e = edit(doc, "@anthropic", "x", { box });
      expect({ ...e.report, moved: [...e.report.moved].sort() }, `box ${box}`).toEqual({ ...NOTHING, moved: ["background", "underline"], linksMoved: 1 });
      expect(e.applied).toEqual(e.plan);
      // Where it would have been, its margins kept, is narrower than its two ends: it is as wide as
      // they are (and the sliver of straight side kept between them), from where the text says it
      // starts (where it did: Chrome clips the page's content at x = 22, a pill moved left of it
      // would be cut), and holds the "x".
      const x = edgesOf(doc, "x")[0];
      const dl = x[0] - oldEdges[0][0], dr = x[1] - oldEdges[9][1];
      expect(Math.abs(dl)).toBeLessThan(0.01);
      expect(pill[2] + dr - (pill[0] + dl)).toBeLessThan(2 * radius);
      const from = pill[0] + dl;
      expect(from).toBeLessThan(x[0]);
      expect(from + 2 * radius + sliver).toBeGreaterThan(x[1]);
      const after = pathsOf(doc);
      const narrow = after.filter((p) => near(p.colour, old.colour, 0.001) && near(p.bbox, [from, pill[1], from + 2 * radius + sliver, pill[3]], 0.005));
      expect(narrow).toHaveLength(1);
      expect(at(after, pill)).toHaveLength(0);
      // Point by point: each end moved as a whole, nothing else changed (the straight sides between
      // them are now a sliver long).
      const mid = (pill[0] + pill[2]) / 2;
      const distinct = (points: [number, number][]) => points.filter((p, k) => !k || !near(p, points[k - 1], 0.002));
      const want = distinct(old.points.map(([px, py]): [number, number] => [px + (px > mid ? from + 2 * radius + sliver - pill[2] : from - pill[0]), py]));
      const got = distinct(narrow[0].points);
      expect(got.length).toBe(distinct(old.points).length);
      expect(got.length).toBe(want.length);
      got.forEach((p, k) => expect(near(p, want[k], 0.002), `point ${k}`).toBe(true));
      // The underline and the link follow the text, as they do when the pill can follow it exactly.
      expect(at(after, [25.75 + dl, 52, 71.91 + dr, 52.75])).toHaveLength(1);
      expect(near(linksOf(doc).find((l) => l.uri === "https://example.com/u/anthropic")!.bounds, [pill[0] + dl, pill[1], pill[2] + dr, pill[3]])).toBe(true);
      // Rendered: the pill's colour at both ends, white past the right one, the two ends alike.
      const page = doc.loadPage(0);
      const pix = renderPixmap(mupdf, page, 4);
      page.destroy();
      try {
        expect(redAt(pix, 4, from + 0.5, 48.25)).toBe(245);
        expect(redAt(pix, 4, from + 2 * radius + sliver - 0.5, 48.25)).toBe(245);
        expect(redAt(pix, 4, from + 2 * radius + sliver + 1, 48.25)).toBe(255);
        expect(redAt(pix, 4, from + 0.75, 42.5)).toBe(redAt(pix, 4, from + 2 * radius + sliver - 0.75, 42.5));
      } finally {
        pix.destroy();
      }

      // A replay of the plan gives the same page.
      const again = openFixture("decorations-chrome.pdf");
      const { find, occurrence } = locate(again, "@anthropic");
      const before = beforeEdit(mupdf, again, 0, find, occurrence);
      replaceText(mupdf, again, 0, find, "x", { occurrence });
      expect(applyDecorations(mupdf, again, 0, JSON.parse(JSON.stringify(e.applied)), before, find, e.written, true).applied).toEqual(e.applied);
      expect(pathsOf(again).map((p) => p.bbox)).toEqual(after.map((p) => p.bbox));

      // The narrow pill is the line's pill: deleting the line takes it, with the underline and the link.
      const gone = edit(doc, "x", "", { box });
      expect({ ...gone.report, removed: [...gone.report.removed].sort() }).toEqual({ ...NOTHING, removed: ["background", "underline"], linksRemoved: 1 });
      expect(pathsOf(doc).filter((p) => near(p.colour, old.colour, 0.001) && p.bbox[1] > 40 && p.bbox[3] < 56)).toHaveLength(0);
    }
  });

  it("a pill narrowed twice in a row keeps both round ends exact, and grows back with them", () => {
    // Round 4's check: after a first narrowing the two ends met; a second one ("x" made "i") bent the
    // right end into the left one by 0.5 pt, since their join points could no longer be told apart.
    const doc = openFixture("decorations-chrome.pdf");
    const pill: Rect = [22, 40.75, 76, 55.75];
    const old = at(pathsOf(doc), pill)[0];
    const distinct = (points: [number, number][]) => points.filter((p, k) => !k || !near(p, points[k - 1], 0.002));
    const pillOf = () => pathsOf(doc).filter((p) => near(p.colour, old.colour, 0.001) && p.bbox[1] > 40 && p.bbox[3] < 56);
    edit(doc, "@anthropic", "x", { box: true });
    const once = pillOf();
    expect(once).toHaveLength(1);
    const second = edit(doc, "x", "i", { box: true });
    expect(second.report.left).toEqual([]);
    const twice = pillOf();
    expect(twice).toHaveLength(1);
    // As narrow as before, point for point (the text starts where it did: nothing moves).
    expect(near(twice[0].bbox, once[0].bbox, 0.005)).toBe(true);
    const a = distinct(once[0].points), b = distinct(twice[0].points);
    expect(b.length).toBe(a.length);
    b.forEach((p, k) => expect(near(p, a[k], 0.002), `point ${k}`).toBe(true));
    // Grown back to the original text: the original pill's shape, its ends exact, holding the text.
    // (Its right margin is what the narrow pill had past the "i", so a little wider than at first:
    // once narrowed to its ends, the old margin is not known any more.)
    edit(doc, "i", "@anthropic", { box: true });
    const back = pillOf();
    expect(back).toHaveLength(1);
    const grown = back[0].bbox[2] - old.bbox[2];
    expect(grown).toBeGreaterThanOrEqual(0);
    expect(back[0].bbox[2]).toBeGreaterThan(edgesOf(doc, "@anthropic")[9][1]);
    const mid = (old.bbox[0] + old.bbox[2]) / 2;
    const want = distinct(old.points.map(([px, py]): [number, number] => [px > mid ? px + grown : px, py]));
    const got = distinct(back[0].points);
    expect(got.length).toBe(want.length);
    got.forEach((p, k) => expect(near(p, want[k], 0.01), `point ${k}`).toBe(true));
  });

  it("save and re-open keep everything, the links where they are (not mirrored)", () => {
    const doc = openFixture("decorations-chrome.pdf");
    edit(doc, "Pay online", "Pay onlineeeeee");
    const e = edit(doc, "@anthropic", "@anthropiccccccc", { box: true });
    expect(e.report.left).toEqual([]);
    const shapes = pathsOf(doc).map((p) => p.bbox);
    const links = linksOf(doc);
    const saved = reopen(doc);
    const again = pathsOf(saved).map((p) => p.bbox);
    expect(again.length).toBe(shapes.length);
    again.forEach((b, k) => expect(near(b, shapes[k], 0.01)).toBe(true));
    const back = linksOf(saved);
    expect(back.map((l) => l.uri)).toEqual(links.map((l) => l.uri));
    back.forEach((l, k) => expect(near(l.bounds, links[k].bounds, 0.01)).toBe(true));
    expect(back[0].bounds[1]).toBeCloseTo(22, 1); // y down: near the top, as before
  });
});

describe("the prototype's cases (cases-chrome.json, cases-synth.json), each on a fresh page", () => {
  type Case = [file: string, text: string, replacement: string, want: DecorationReport & { box?: boolean }];
  const R = (moved: string[] = [], links = 0, left: DecorationReport["left"] = []): DecorationReport =>
    ({ moved: moved as DecorationReport["moved"], removed: [], linksMoved: links, linksRemoved: 0, left });
  const C = "decorations-chrome.pdf", S = "decorations-synthetic.pdf";
  const cases: Case[] = [
    [C, "Pay online", "Pay onlineeeeee", R(["underline"], 1)],
    [C, "@anthropic", "@anthropiccccccc", { box: true, ...R(["background", "underline"], 1) }],
    [C, "Pay now", "Pay now by card", { box: true, ...R(["background"], 1) }],
    [C, "Draft  status chip", "Approved  status chip", { box: true, ...R(["background"]) }],
    [C, "Old price 120,00 EUR", "Old price 99,00 EUR", R(["strike"])],
    [C, "Red underline on dark text", "Red underline, longer, on dark text", R()], // left at detection ("colour")
    [C, "Click here to pay", "Tap here now to pay", R([], 0, [{ kind: "underline", reason: "ambiguous" }])],
    [C, "Highlighted words", "Highlighted", { box: true, ...R(["background"]) }],
    [C, "Dashed underline", "Dashed underline longer", R()],
    [C, "Double underline", "Double underline longer", R(["underline", "underline"])],
    [C, "Thick underline", "Thick", R(["underline"])],
    [C, "Overline text", "Overline text longer", R()],
    [C, "Section heading", "Section heading renamed", R()],
    [C, "Claude Pro", "Claude Max plan", { box: true, ...R() }],
    [C, "20,00 EUR", "1.020,00 EUR", R(["underline"])],
    [C, "Note line one", "Note line one, edited", { box: true, ...R() }],
    [C, "Signature:", "Firma:", R()],
    [C, "A long link that wraps", "A link that wraps", R(["underline"], 1)],
    [C, "Wavy underline", "Wavy underline longer", R()],
    [S, "Word style underline", "Word style underline, edited", R(["underline"], 1)],
    [S, "Stroked line underline", "Stroked line", R(["underline"])],
    [S, "Struck through text", "Struck through text again", R(["strike"])],
    [S, "Rounded button", "Rounded button wider", { box: true, ...R(["background"]) }],
    [S, "Nome:", "Nome e cognome:", R()],
    [S, "Rotated link text", "Rotated link text, longer", R()], // left at detection ("direction")
    [S, "Shared box line one", "Shared box line one is longer", { box: true, ...R() }],
    [S, "1.234,56", "11.234,56", R()],
    [S, "Inside a form", "Inside a form XObject", R()], // left at detection ("form")
    [S, "Marker over text", "Marker over longer text", { box: true, ...R(["background"]) }],
  ];
  for (const [file, text, replacement, { box, ...want }] of cases)
    it(`${JSON.stringify(text)} made ${JSON.stringify(replacement)}`, () => {
      const doc = openFixture(file);
      const before = pathsOf(doc);
      const oldEdges = edgesOf(doc, text);
      const e = edit(doc, text, replacement, { box });
      expect({ ...e.report, moved: [...e.report.moved].sort() }).toEqual({ ...want, moved: [...want.moved].sort() });
      // Each shape moved is where its run's ends went, and gone from where it was.
      const newEdges = edgesOf(doc, replacement);
      const after = pathsOf(doc);
      for (const s of e.applied.shapes) {
        expect(at(after, s.bbox, 0.02)).toHaveLength(0);
        expect(at(after, expectedBox(s.bbox, s.range, e.find, e.written, oldEdges, newEdges), 0.05).length).toBeGreaterThan(0);
      }
      // Nothing else on the page changed: the shapes left alone are all still there.
      const moved = e.applied.shapes.map((s) => s.bbox);
      for (const p of before) if (!moved.some((b) => near(b, p.bbox, 0.02))) expect(at(after, p.bbox, 0.02).length).toBeGreaterThan(0);
    });

  it('"A long link that wraps" made "A link that wraps": the hole under "long" goes, the one under "wraps" moves with it', () => {
    const doc = openFixture("decorations-chrome.pdf");
    const old = edgesOf(doc, "A long link that wraps");
    const line = (r: Rect) => r[1] > 489 && r[3] < 492;
    const before = holesOf(doc).filter(line);
    const under = (r: Rect, e: [number, number]) => r[0] >= e[0] - 0.5 && r[2] <= e[1] + 0.5;
    const g = before.filter((r) => under(r, old[5])), p = before.filter((r) => under(r, old[20]));
    expect([g.length, p.length, before.length]).toEqual([1, 1, 2]); // under the "g" of "long" and the "p" of "wraps"
    edit(doc, "A long link that wraps", "A link that wraps");
    const now = edgesOf(doc, "A link that wraps");
    const shift = now[15][0] - old[20][0];
    expect(shift).toBeLessThan(-15);
    const after = holesOf(doc).filter(line);
    expect(after).toHaveLength(1);
    expect(near(after[0], [p[0][0] + shift, p[0][1], p[0][2] + shift, p[0][3]], 0.02)).toBe(true);
  });
});

describe("deleting a line (cases-delete.json)", () => {
  it("removes its underline and its link", () => {
    const doc = openFixture("decorations-chrome.pdf");
    const e = edit(doc, "Pay online", "");
    expect(e.report).toEqual({ moved: [], removed: ["underline"], linksMoved: 0, linksRemoved: 1, left: [] });
    expect(at(pathsOf(doc), [22, 31, 64.035, 31.75])).toHaveLength(0);
    expect(linksOf(doc).map((l) => l.uri)).not.toContain("https://example.com/pay");
    expect(linksOf(reopen(doc)).map((l) => l.uri)).not.toContain("https://example.com/pay");
  });
  it("removes its strike-through", () => {
    const doc = openFixture("decorations-chrome.pdf");
    expect(edit(doc, "Old price 120,00 EUR", "").report).toMatchObject({ removed: ["strike"] });
    expect(at(pathsOf(doc), [22, 120.25, 109.55, 121])).toHaveLength(0);
  });
  it("with the option, removes its pill too", () => {
    const doc = openFixture("decorations-chrome.pdf");
    const e = edit(doc, "@anthropic", "", { box: true });
    expect([...e.report.removed].sort()).toEqual(["background", "underline"]);
    expect(e.report.linksRemoved).toBe(1);
    const after = pathsOf(doc);
    expect(at(after, [22, 40.75, 76, 55.75])).toHaveLength(0);
    expect(at(after, [25.75, 52, 71.91, 52.75])).toHaveLength(0);
  });
  it("a partly decorated line goes with its decoration (nothing is ambiguous when the line is emptied)", () => {
    const doc = openFixture("decorations-chrome.pdf");
    expect(edit(doc, "Click here to pay", "").report).toMatchObject({ removed: ["underline"], left: [] });
  });
  it("a deleted word takes its underline with it", () => {
    const doc = openFixture("decorations-chrome.pdf");
    expect(edit(doc, "Click here to pay", "Click to pay").report).toMatchObject({ removed: ["underline"], left: [] });
    expect(at(pathsOf(doc), [44.01, 166, 62.03, 166.75])).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------

describe("pages and lines of other kinds", () => {
  it("/Rotate 90: the underline and the link move along the page's y, and stay right after a save", () => {
    const doc = openFixture("decorations-chrome.pdf");
    doc.findPage(0).put("Rotate", 90);
    const before = linksOf(doc).find((l) => l.uri === "https://example.com/pay")!.bounds;
    const e = edit(doc, "Pay online", "Pay onlineeeeee");
    expect(e.report).toMatchObject({ moved: ["underline"], linksMoved: 1, left: [] });
    const link = linksOf(doc).find((l) => l.uri === "https://example.com/pay")!.bounds;
    const grow = link[3] - before[3];
    expect(grow).toBeGreaterThan(24);
    expect(near(link, [before[0], before[1], before[2], before[3] + grow])).toBe(true);
    const underline = pathsOf(doc).filter((p) => p.bbox[2] - p.bbox[0] < 1 && Math.abs(p.bbox[1] - 22) < 0.05);
    expect(underline.some((p) => Math.abs(p.bbox[3] - (64.035 + grow)) < 0.06)).toBe(true);
    const saved = linksOf(reopen(doc)).find((l) => l.uri === "https://example.com/pay")!.bounds;
    expect(near(saved, link, 0.01)).toBe(true);
  });

  it("a link with /QuadPoints: they move with the rect", () => {
    const doc = openFixture("decorations-chrome.pdf");
    const dict = () => doc.findPage(0).get("Annots").get(0).resolve();
    dict().put("QuadPoints", [22, 819.92, 64, 819.92, 22, 809.42, 64, 809.42]); // user space, as /Rect
    edit(doc, "Pay online", "Pay onlineeeeee");
    const right = linksOf(doc)[0].bounds[2];
    expect(right).toBeGreaterThan(88);
    const q = dict().get("QuadPoints");
    expect(near([0, 1, 2, 3, 4, 5, 6, 7].map((k) => q.get(k).asNumber()), [22, 819.92, right, 819.92, 22, 809.42, right, 809.42], 0.01)).toBe(true);
  });

  it("a character no font can draw: the decorations follow the text that was written", () => {
    const doc = openFixture("decorations-chrome.pdf");
    const missing = String.fromCodePoint(0xe000);
    const e = edit(doc, "Pay online", `Pay online${missing}now`);
    expect(e.missing).toEqual([missing]);
    expect(e.written).toBe("Pay onlinenow");
    expect(e.report).toMatchObject({ moved: ["underline"], linksMoved: 1 });
    const right = edgesOf(doc, "Pay onlinenow")[12][1];
    expect(linksOf(doc)[0].bounds[2]).toBeCloseTo(64 + right - edgesOf(openFixture("decorations-chrome.pdf"), "Pay online")[9][1], 2);
  });

  it("when the text on the page is not what replaceText wrote, every shape stays (complex)", () => {
    const doc = openFixture("decorations-chrome.pdf");
    const { find, occurrence } = locate(doc, "Pay online");
    const plan = planOf(detectDecorations(mupdf, doc, 0, find, occurrence), undefined);
    const before = beforeEdit(mupdf, doc, 0, find, occurrence);
    replaceText(mupdf, doc, 0, find, "Pay later", { occurrence });
    const { applied, report } = applyDecorations(mupdf, doc, 0, plan, before, find, "Pay sooner", false);
    expect(applied).toEqual({ shapes: [], links: [] });
    expect(report.left).toEqual([{ kind: "underline", reason: "complex" }, { kind: "link", reason: "complex" }]);
    expect(at(pathsOf(doc), [22, 31, 64.035, 31.75])).toHaveLength(1);
  });

  it("repeated identical lines: the one at `occurrence` is edited, with its own underline", () => {
    const bytes = makePdf((doc) => {
      const font = helvetica(doc);
      const w = width("Total due", 12);
      let c = "";
      for (const y of [700, 650, 600]) c += `BT 0 0 0 rg /F1 12 Tf 50 ${y} Td (Total due) Tj ET 0 0 0 rg 50 ${y - 2} ${w.toFixed(3)} 0.6 re f\n`;
      doc.insertPage(-1, doc.addPage([0, 0, 400, 800], 0, { Font: { F1: font } }, c));
    });
    const doc = openBytes(bytes);
    const before = pathsOf(doc).map((p) => p.bbox);
    expect(before.length).toBe(3);
    const e = edit(doc, "Total due", "Total due now", { nth: 1 });
    expect(e.report.moved).toEqual(["underline"]);
    const after = pathsOf(doc).map((p) => p.bbox);
    expect(near(after[0], before[0], 0.01)).toBe(true);
    expect(near(after[2], before[2], 0.01)).toBe(true);
    expect(before[1][1]).toBeCloseTo(800 - 650 + 2 - 0.6, 1); // the middle line's (y down)
    expect(after[1][1]).toBeCloseTo(before[1][1], 2);
    expect(after[1][2]).toBeGreaterThan(before[1][2] + 20);
  });

  it("a tagged page (Chrome's): the edit keeps the structure, and the decorations follow", () => {
    const doc = openFixture("decorations-chrome.pdf");
    expect(doc.getTrailer().get("Root", "StructTreeRoot").isDictionary()).toBe(true);
    const e = edit(doc, "Old price 120,00 EUR", "Old price 99,00 EUR");
    expect(e.report.moved).toEqual(["strike"]);
    const saved = reopen(doc);
    expect(saved.getTrailer().get("Root", "StructTreeRoot").isDictionary()).toBe(true);
    expect(linesOf(saved).some((l) => l.text === "Old price 99,00 EUR")).toBe(true);
  });

  it("a link in the structure tree (/StructParent): deleting its line takes it out of the tree too, and PDF/A stays valid", () => {
    const doc = openBytes(taggedLink());
    expect(summaryOf(detectDecorations(mupdf, doc, 0, "Read the terms", 0))).toMatchObject({ underlines: 1, links: 1, left: [] });
    const e = edit(doc, "Read the terms", "");
    expect(e.report).toEqual({ moved: [], removed: ["underline"], linksMoved: 0, linksRemoved: 1, left: [] });
    const saved = reopen(doc);
    const annots = saved.findPage(0).get("Annots");
    expect(annots.isArray() ? annots.length : 0).toBe(0);
    const root = saved.getTrailer().get("Root", "StructTreeRoot");
    const nums = root.get("ParentTree", "Nums");
    const keys: number[] = [];
    for (let k = 0; k < nums.length; k += 2) keys.push(nums.get(k).asNumber());
    expect(keys).toEqual([0]); // key 1 (the link's) went
    const linkElement = root.get("K").get("K").get(0);
    expect(linkElement.get("S").asName()).toBe("Link");
    expect(linkElement.get("K").toString()).toBe("[0]"); // the OBJR went, the text's MCID stays
    // The Chrome page, its link removed with its line, converts to PDF/A and checks clean.
    const chrome = openFixture("decorations-chrome.pdf");
    expect(edit(chrome, "Pay online", "").report.linksRemoved).toBe(1);
    expect(convertToPdfA(mupdf, chrome, { now: new Date("2026-10-15T12:00:00Z") }).blockers).toEqual([]);
    expect(checkPdfA(mupdf, savePdf(mupdf, chrome).bytes)).toEqual([]);
  });

  it("a link in the structure tree that cannot be taken out of it for sure stays (shared)", () => {
    const doc = openBytes(taggedLink({ objrTwice: true }));
    const e = edit(doc, "Read the terms", "");
    expect(e.report).toMatchObject({ removed: ["underline"], linksRemoved: 0, left: [{ kind: "link", reason: "shared" }] });
    expect(e.applied.links).toEqual([]);
    expect(linksOf(doc)).toHaveLength(1);
  });
});

describe("more cases", () => {
  it("the same line edited twice: the decorations follow both times, the second time from where the first left them", () => {
    const doc = openFixture("decorations-chrome.pdf");
    expect(edit(doc, "@anthropic", "@anthropiccccccc", { box: true }).report.left).toEqual([]);
    const second = edit(doc, "@anthropiccccccc", "@ant", { box: true });
    expect(second.detected.box).toEqual({ fill: true, stroke: false, suggested: true }); // (the new text is drawn last now: still under it)
    expect([...second.report.moved].sort()).toEqual(["background", "underline"]);
    expect(second.report.linksMoved).toBe(1);
    const right = edgesOf(doc, "@ant")[3][1];
    const pill = pathsOf(doc).find((p) => near(p.bbox.slice(0, 2), [22, 40.75]))!;
    expect(pill.bbox[2]).toBeCloseTo(right + (76 - 71.91), 1); // its right margin as it was
    expect(linksOf(doc).find((l) => l.uri === "https://example.com/u/anthropic")!.bounds[2]).toBeCloseTo(pill.bbox[2], 1);
  });

  it("an opaque box drawn over the text is a cover, not a background; a box under it holding another line is shared", () => {
    const bytes = makePdf((doc) => {
      const font = helvetica(doc);
      const w = width("Covered words", 12), v = width("Boxed", 12);
      const c = `BT 0 0 0 rg /F1 12 Tf 50 700 Td (Covered words) Tj ET 1 1 0 rg 47 696 ${(w + 6).toFixed(3)} 16 re f
0.9 0.9 0.9 rg 47 646 ${(v + 6).toFixed(3)} 16 re f BT 0 0 0 rg /F1 12 Tf 50 650 Td (Boxed) Tj ET BT /F1 6 Tf 51 657 Td (x) Tj ET`;
      doc.insertPage(-1, doc.addPage([0, 0, 400, 800], 0, { Font: { F1: font } }, c));
    });
    const doc = openBytes(bytes);
    const covered = detectDecorations(mupdf, doc, 0, "Covered words", 0);
    expect(summaryOf(covered)).toMatchObject({ box: null, left: [{ kind: "background", reason: "cover" }] });
    expect(planOf(covered, true).shapes).toEqual([]); // never offered, even when asked
    const boxed = detectDecorations(mupdf, doc, 0, "Boxed", 0);
    expect(summaryOf(boxed)).toMatchObject({ box: null, left: [{ kind: "background", reason: "shared" }] });
  });
});

describe("clips and paths of other kinds", () => {
  it("a decoration clipped to its own bounds: the clip stretches with it", () => {
    const bytes = makePdf((doc) => {
      const font = helvetica(doc);
      const w = width("Clipped rule", 12);
      const c = `BT 0 0 0 rg /F1 12 Tf 50 700 Td (Clipped rule) Tj ET q 50 697 ${w.toFixed(3)} 2 re W n 0 0 0 rg 50 697.5 ${w.toFixed(3)} 0.6 re f Q`;
      doc.insertPage(-1, doc.addPage([0, 0, 400, 800], 0, { Font: { F1: font } }, c));
    });
    const doc = openBytes(bytes);
    expect(edit(doc, "Clipped rule", "Clipped rule, longer").report.moved).toEqual(["underline"]);
    const right = edgesOf(doc, "Clipped rule, longer")[19][1];
    const page = doc.loadPage(0);
    const pix = renderPixmap(mupdf, page, 4);
    page.destroy();
    try {
      expect(redAt(pix, 4, right - 2, 800 - 697.8)).toBeLessThan(100); // the new end of the rule shows
      expect(redAt(pix, 4, right + 2, 800 - 697.8)).toBe(255);
    } finally {
      pix.destroy();
    }
  });

  it("an underline filled and stroked (B) is one underline, rewritten once", () => {
    const bytes = makePdf((doc) => {
      const font = helvetica(doc);
      const w = width("Both ways", 12);
      const c = `BT 0 0 0 rg /F1 12 Tf 50 700 Td (Both ways) Tj ET 0 0 0 rg 0 0 0 RG 0.2 w 50 697.5 ${w.toFixed(3)} 0.4 re B`;
      doc.insertPage(-1, doc.addPage([0, 0, 400, 800], 0, { Font: { F1: font } }, c));
    });
    const doc = openBytes(bytes);
    const d = detectDecorations(mupdf, doc, 0, "Both ways", 0);
    expect(summaryOf(d)).toMatchObject({ underlines: 1, left: [] });
    const before = pathsOf(doc);
    expect(before.map((p) => p.paint)).toEqual(["fill", "stroke"]);
    const e = edit(doc, "Both ways", "Both ways at once");
    expect(e.report.moved).toEqual(["underline"]);
    const after = pathsOf(doc);
    const grow = after[0].bbox[2] - before[0].bbox[2];
    expect(grow).toBeGreaterThan(20);
    expect(near(after[1].bbox, [before[1].bbox[0], before[1].bbox[1], before[1].bbox[2] + grow, before[1].bbox[3]], 0.01)).toBe(true);
  });
});

describe("replays", () => {
  it("the plan applied (replay) gives the same page; a shape that is gone throws DecorationMismatch", () => {
    const first = openFixture("decorations-chrome.pdf");
    const e = edit(first, "@anthropic", "@anthropiccccccc", { box: true });
    // A replay: the same base, the logged plan.
    const doc = openFixture("decorations-chrome.pdf");
    const { find, occurrence } = locate(doc, "@anthropic");
    const before = beforeEdit(mupdf, doc, 0, find, occurrence);
    replaceText(mupdf, doc, 0, find, "@anthropiccccccc", { occurrence });
    const r = applyDecorations(mupdf, doc, 0, JSON.parse(JSON.stringify(e.applied)), before, find, e.written, true);
    expect(r.applied).toEqual(e.applied);
    expect(pathsOf(doc).map((p) => p.bbox)).toEqual(pathsOf(first).map((p) => p.bbox));
    expect(linksOf(doc)).toEqual(linksOf(first));

    const other = openFixture("decorations-chrome.pdf");
    const b2 = beforeEdit(mupdf, other, 0, find, occurrence);
    replaceText(mupdf, other, 0, find, "@anthropiccccccc", { occurrence });
    const gone: DecorationPlan = { shapes: [{ ...e.applied.shapes[0], bbox: [30, 40.75, 76, 55.75] }], links: [] };
    expect(() => applyDecorations(mupdf, other, 0, gone, b2, find, e.written, true)).toThrow(DecorationMismatch);
    // A new edit drops it instead, and says so.
    const r2 = applyDecorations(mupdf, other, 0, gone, b2, find, e.written, false);
    expect(r2.applied.shapes).toEqual([]);
    expect(r2.report.left).toEqual([{ kind: "background", reason: "complex" }]);
  });

  it("a link that is gone throws on a replay too", () => {
    const doc = openFixture("decorations-chrome.pdf");
    const { find, occurrence } = locate(doc, "Pay online");
    const plan = planOf(detectDecorations(mupdf, doc, 0, find, occurrence), undefined);
    const before = beforeEdit(mupdf, doc, 0, find, occurrence);
    replaceText(mupdf, doc, 0, find, "Pay onlineeeeee", { occurrence });
    const wrong = { shapes: [], links: [{ ...plan.links[0], uri: "https://example.com/other" }] };
    expect(() => applyDecorations(mupdf, doc, 0, wrong, before, find, "Pay onlineeeeee", true)).toThrow(DecorationMismatch);
  });
});

describe("limits and MuPDF objects", () => {
  it(`a page that paints more than ${MAX_PATHS} paths says its shapes are complex, quickly`, () => {
    const bytes = makePdf((doc) => {
      const font = helvetica(doc);
      const parts = [`BT 0 0 0 rg /F1 11 Tf 50 60 Td (Heavy page underline) Tj ET 0 0 0 rg 50 58.4 ${width("Heavy page underline", 11).toFixed(3)} 0.55 re f`, "0.7 0.7 0.7 rg"];
      for (let i = 0; i < MAX_PATHS + 10_000; i++) parts.push(`${(i % 250) * 2.2 + 20} ${Math.floor(i / 250) * 0.6 + 100} 1.5 0.5 re f`);
      doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { Font: { F1: font } }, parts.join(String.fromCharCode(10))));
    }, "compress=yes");
    const doc = openBytes(bytes);
    const t = performance.now();
    const d = detectDecorations(mupdf, doc, 0, "Heavy page underline", 0);
    const ms = performance.now() - t;
    expect(summaryOf(d)).toMatchObject({ underlines: 0, left: [{ kind: "underline", reason: "complex" }] });
    expect(planOf(d, undefined).shapes).toEqual([]);
    // About 0.9 s alone; the full suite on a busy machine has taken over 3 s. A walk that did not
    // stop at MAX_PATHS would take far longer than this bound.
    expect(ms).toBeLessThan(10_000);
  }, 30_000);

  it("the device pass destroys every path, stroke state, colour space and text it receives", () => {
    const doc = openFixture("decorations-chrome.pdf");
    // What a pass with the same callbacks receives on this page.
    const received = { Path: 0, StrokeState: 0, ColorSpace: 0, Text: 0 };
    const page = doc.loadPage(0);
    const count = new mupdf.Device({
      fillPath(p, _e, _m, cs) { received.Path++; received.ColorSpace++; p.destroy(); cs.destroy(); },
      strokePath(p, st, _m, cs) { received.Path++; received.StrokeState++; received.ColorSpace++; p.destroy(); st.destroy(); cs.destroy(); },
      fillText(t, _m, cs) { received.Text++; received.ColorSpace++; t.destroy(); cs.destroy(); },
      strokeText(t, st, _m, cs) { received.Text++; received.StrokeState++; received.ColorSpace++; t.destroy(); st.destroy(); cs.destroy(); },
      ignoreText(t) { received.Text++; t.destroy(); },
      beginMask(_a, _l, cs) { received.ColorSpace++; cs.destroy(); },
    });
    page.runPageContents(count, mupdf.Matrix.identity);
    count.close();
    count.destroy();
    page.destroy();
    expect(received.Path).toBeGreaterThan(50);
    // What detection destroys of those kinds.
    const destroyed = { Path: 0, StrokeState: 0, ColorSpace: 0, Text: 0 };
    const restore: (() => void)[] = [];
    for (const name of Object.keys(destroyed) as (keyof typeof destroyed)[]) {
      const proto = mupdf[name].prototype as { destroy(): void };
      const original = proto.destroy;
      proto.destroy = function (this: { pointer: number }) {
        if (this.pointer) destroyed[name]++;
        original.call(this);
      };
      restore.push(() => (proto.destroy = original));
    }
    try {
      detectDecorations(mupdf, doc, 0, "@anthropic", 0);
    } finally {
      for (const f of restore) f();
    }
    expect(destroyed).toEqual(received);
  });
});

// ---------------------------------------------------------------------------------------------
// The review's findings (fix round 1), each reproduced first: rules and boxes that look like the
// line's but are not (a sum column, table cells, dots, a card's link), the rewrite's edge cases
// (a skip-ink hole when the run's ends stay, an ICC colour after the app's own rewrite), and pages
// that are slow or odd to read (dense dots, forms drawn many times, huge paths, broken /Contents).

const NOTHING: DecorationReport = { moved: [], removed: [], linksMoved: 0, linksRemoved: 0, left: [] };
const boxesOf = (doc: mupdf.PDFDocument, pageIndex = 0) => pathsOf(doc, pageIndex).map((p) => p.bbox);

describe("rules and boxes that are not the line's", () => {
  const L = "decorations-layout.pdf";

  it("a sum column (Chrome): the rule under an addend that reads like the total below is both lines' or neither's, and stays (shared)", () => {
    // Page 1: the total has `text-decoration: overline`; page 2: `border-top: 1px solid`.
    for (const pageIndex of [0, 1]) {
      const doc = openFixture(L);
      const addend = locate(doc, "1.234,56", 1, pageIndex);
      expect(summaryOf(detectDecorations(mupdf, doc, pageIndex, addend.find, addend.occurrence)))
        .toMatchObject({ underlines: 0, left: [{ kind: "underline", reason: "shared" }] });
      expect(summaryOf(detectDecorations(mupdf, doc, pageIndex, "2.469,12", 0))).toMatchObject({ left: [{ kind: "overline", reason: "shared" }] });
      const rules = boxesOf(doc, pageIndex);
      expect(rules).toHaveLength(1);
      for (const replacement of ["34,56", ""]) {
        const fresh = openFixture(L);
        expect(edit(fresh, "1.234,56", replacement, { nth: 1, pageIndex }).report).toEqual(NOTHING);
        expect(boxesOf(fresh, pageIndex)).toEqual(rules);
      }
    }
  });

  it("a sum column (synthetic, the fixture's accounting rule): the same at 12 to 14 pt of leading; at 15 pt the rule is the total's only", () => {
    for (const above of [12, 13, 14, 15]) {
      const bytes = makePdf((doc) => {
        const font = helvetica(doc);
        const w = width("1.234,56", 10), x = (300 - w).toFixed(3);
        const c = `BT /F1 10 Tf ${x} ${700 + above} Td (1.234,56) Tj ET 0 0 0 rg ${x} 710 ${w.toFixed(3)} 0.5 re f BT /F1 10 Tf ${x} 700 Td (2.469,12) Tj ET`;
        doc.insertPage(-1, doc.addPage([0, 0, 400, 800], 0, { Font: { F1: font } }, c));
      });
      const doc = openBytes(bytes);
      const addend = summaryOf(detectDecorations(mupdf, doc, 0, "1.234,56", 0));
      const total = summaryOf(detectDecorations(mupdf, doc, 0, "2.469,12", 0));
      if (above < 15) {
        expect(addend).toMatchObject({ underlines: 0, left: [{ kind: "underline", reason: "shared" }] });
        expect(total).toMatchObject({ left: [{ kind: "overline", reason: "shared" }] });
        expect(edit(doc, "1.234,56", "").report).toEqual(NOTHING);
        expect(boxesOf(doc)).toHaveLength(1);
      } else {
        expect(addend).toMatchObject({ underlines: 0, left: [] });
        expect(total).toMatchObject({ left: [{ kind: "overline", reason: "overline" }] });
      }
    }
  });

  it("tight leading: the underline of the line above, in this line's overline band but not on its characters, is the upper line's", () => {
    const bytes = makePdf((doc) => {
      const font = helvetica(doc);
      const w = width("Upper line", 12);
      // Baselines 12 pt apart: the upper line's underline (2 pt below its baseline) sits 10 pt
      // (0.83 S) above the lower one's, where an overline would be; the lower line is shorter.
      const c = `BT 0 0 0 rg /F1 12 Tf 50 700 Td (Upper line) Tj ET 0 0 0 rg 50 697.7 ${w.toFixed(3)} 0.6 re f
BT 0 0 0 rg /F1 12 Tf 50 688 Td (Lower) Tj ET`;
      doc.insertPage(-1, doc.addPage([0, 0, 400, 800], 0, { Font: { F1: font } }, c));
    });
    const doc = openBytes(bytes);
    expect(summaryOf(detectDecorations(mupdf, doc, 0, "Upper line", 0))).toMatchObject({ underlines: 1, left: [] });
    expect(summaryOf(detectDecorations(mupdf, doc, 0, "Lower", 0))).toMatchObject({ underlines: 0, left: [] });
    expect(edit(doc, "Upper line", "Upper line, longer").report.moved).toEqual(["underline"]);
  });

  it("per-cell bottom borders of a table with cell spacing (Chrome) are the table's, not underlines", () => {
    const doc = openFixture(L);
    for (const text of ["Description Qty Amount", "Claude Pro 1", "20,00 EUR", "60,00 EUR"]) {
      const s = summaryOf(detectDecorations(mupdf, doc, 2, text, 0));
      expect(s.underlines).toBe(0);
      expect(s.left.length).toBeGreaterThan(0);
      expect(s.left.every((l) => l.kind === "underline" && l.reason === "shared")).toBe(true);
    }
    const borders = boxesOf(doc, 2);
    expect(borders).toHaveLength(9);
    expect(edit(doc, "20,00 EUR", "", { pageIndex: 2 }).report).toEqual(NOTHING);
    expect(edit(doc, "Claude Pro 1", "Claude Max 1", { pageIndex: 2 }).report).toEqual(NOTHING);
    expect(boxesOf(doc, 2)).toEqual(borders);
  });

  it("table cell backgrounds separated by cell spacing (Chrome) are never offered", () => {
    const doc = openFixture(L);
    for (const text of ["Description", "Qty", "Amount", "Claude Pro", "1", "20,00 EUR", "3", "60,00 EUR"])
      expect(summaryOf(detectDecorations(mupdf, doc, 3, text, 0))).toMatchObject({ box: null, left: [{ kind: "background", reason: "shared" }] });
    const cells = boxesOf(doc, 3);
    expect(edit(doc, "Claude Pro", "Claude Pro Max", { pageIndex: 3 }).report).toEqual(NOTHING);
    expect(boxesOf(doc, 3)).toEqual(cells);
  });

  it("a dotted underline of dots as long as a character (Chrome, 3 px thick) is one dotted rule: it stays as a whole", () => {
    const doc = openFixture(L);
    const d = detectDecorations(mupdf, doc, 4, "Dotted small text underline", 0);
    expect(summaryOf(d)).toEqual({ underlines: 0, strikes: 0, links: 0, box: null, left: [{ kind: "underline", reason: "pattern" }] });
    expect(planOf(d, true)).toEqual({ shapes: [], links: [] });
    const dots = boxesOf(doc, 4);
    expect(dots).toHaveLength(20);
    expect(edit(doc, "Dotted small text underline", "Dotted small text underlined", { pageIndex: 4 }).report).toEqual(NOTHING);
    expect(edit(doc, "Dotted small text underlined", "", { pageIndex: 4 }).report).toEqual(NOTHING);
    expect(boxesOf(doc, 4)).toEqual(dots);
  });

  it("a dashed underline of separate dashes (synthetic): the same", () => {
    const bytes = makePdf((doc) => {
      const font = helvetica(doc);
      const w = width("Dashed underline here", 11);
      let c = "BT 0 0 0 rg /F1 11 Tf 50 700 Td (Dashed underline here) Tj ET 0 0 0 rg\n";
      for (let x = 50; x < 50 + w - 0.5; x += 7.5) c += `${x} 698.4 ${Math.min(5, 50 + w - x).toFixed(3)} 0.55 re f\n`;
      doc.insertPage(-1, doc.addPage([0, 0, 400, 800], 0, { Font: { F1: font } }, c));
    });
    const doc = openBytes(bytes);
    expect(summaryOf(detectDecorations(mupdf, doc, 0, "Dashed underline here", 0)))
      .toMatchObject({ underlines: 0, left: [{ kind: "underline", reason: "pattern" }] });
    const dashes = boxesOf(doc);
    expect(dashes.length).toBeGreaterThan(10);
    expect(edit(doc, "Dashed underline here", "Dashed underline here, longer").report).toEqual(NOTHING);
    expect(edit(doc, "Dashed underline here, longer", "").report).toEqual(NOTHING);
    expect(boxesOf(doc)).toEqual(dashes);
  });

  it("a block link over a picture and its caption (Chrome) is not the caption's link: it stays (shared)", () => {
    const doc = openFixture(L);
    const card: Rect = [22, 22, 247, 122.5];
    expect(near(linksOf(doc, 5)[0].bounds, card)).toBe(true);
    const d = summaryOf(detectDecorations(mupdf, doc, 5, "Scopri la nuova collezione", 0));
    expect(d).toMatchObject({ underlines: 1, links: 0, left: [{ kind: "link", reason: "shared" }] });
    expect(edit(doc, "Scopri la nuova collezione", "Scopri", { pageIndex: 5 }).report).toEqual({ ...NOTHING, moved: ["underline"] });
    expect(near(linksOf(doc, 5)[0].bounds, card)).toBe(true);
    expect(edit(doc, "Scopri", "", { pageIndex: 5 }).report).toEqual({ ...NOTHING, removed: ["underline"] });
    expect(near(linksOf(doc, 5)[0].bounds, card)).toBe(true);
  });
});

describe("dashed rules and words underlined one by one", () => {
  /** `text` in Helvetica `size` at 50,700 (black), then `rules` (black). */
  const page = (text: string, size: number, rules: string) =>
    openBytes(makePdf((doc) => {
      const font = helvetica(doc);
      const c = `BT 0 0 0 rg /F1 ${size} Tf 50 700 Td (${text.replace(/[()\\]/g, "\\$&")}) Tj ET 0 0 0 rg\n${rules}`;
      doc.insertPage(-1, doc.addPage([0, 0, 400, 800], 0, { Font: { F1: font } }, c));
    }));
  /**
   * Separate `re f` dashes `dash` long every `dash + gap` from `x0` to `x1` (the last one cut there,
   * or, `full`, as long as the others: past x1), 0.55 thick, 1.6 under the baseline.
   */
  const dashes = (x0: number, x1: number, dash: number, gap: number, full = false) => {
    let c = "";
    for (let x = x0; x < x1 - 0.5; x += dash + gap) c += `${x.toFixed(3)} 698.4 ${(full ? dash : Math.min(dash, x1 - x)).toFixed(3)} 0.55 re f\n`;
    return c;
  };
  /** An underline under each of `words` in `text` (Helvetica 12), 0.6 thick. */
  const wordsUnderlined = (text: string, words: string[]) => {
    let c = "", from = 0;
    for (const w of words) {
      const at = text.indexOf(w, from);
      from = at + w.length;
      c += `${(50 + width(text.slice(0, at), 12)).toFixed(3)} 697.8 ${width(w, 12).toFixed(3)} 0.6 re f\n`;
    }
    return page(text, 12, c);
  };
  const DASHED = "Dashed underline here";
  const LEFT_DASHED = { underlines: 0, strikes: 0, links: 0, box: null, left: [{ kind: "underline", reason: "pattern" }] };

  it("a dashed underline of long dashes (each longer than 1.5 S) drawn as separate fills is one dashed rule: no dash follows on its own", () => {
    const end = 50 + width(DASHED, 11);
    // [dash, gap, first dash's start]: the review's four, and one whose first dash is cut (8 pt).
    const cases: [string, string][] = [
      ["20/5 from 50", dashes(50, end, 20, 5)],
      ["17/4 from 51.5", dashes(51.5, end, 17, 4)],
      ["21/4 from 50", dashes(50, end, 21, 4)],
      ["24/6 from 50", dashes(50, end, 24, 6)],
      ["20/5, the first dash cut", `50 698.4 8 0.55 re f\n${dashes(63, end, 20, 5)}`],
    ];
    for (const [name, rules] of cases) {
      const doc = page(DASHED, 11, rules);
      const d = detectDecorations(mupdf, doc, 0, DASHED, 0);
      expect(summaryOf(d), name).toEqual(LEFT_DASHED);
      expect(planOf(d, true), name).toEqual({ shapes: [], links: [] });
      const before = boxesOf(doc);
      expect(before.length, name).toBeGreaterThanOrEqual(4);
      expect(edit(doc, DASHED, `${DASHED}, longer`).report, name).toEqual(NOTHING);
      expect(edit(doc, `${DASHED}, longer`, "").report, name).toEqual(NOTHING);
      expect(boxesOf(doc), name).toEqual(before); // (the review's 20/5: 3 of the 5 dashes went)
    }
  });

  it("the same with every dash as long as the others: the last one runs past the text's end (or the first starts before it)", () => {
    const end = 50 + width(DASHED, 11); // 161.28
    const cases: [string, string][] = [
      ["20/5 from 50 (the last 150..170)", dashes(50, end, 20, 5, true)],
      ["17/4 from 51.5 (the last 156.5..173.5)", dashes(51.5, end, 17, 4, true)],
      ["21/4 from 50 (the last 150..171)", dashes(50, end, 21, 4, true)],
      ["24/6 from 50 (the last 140..164)", dashes(50, end, 24, 6, true)],
      ["20/5 from 45 (the first 45..65, the last 145..165)", dashes(45, end, 20, 5, true)],
      ["20/5 from 40 (the first 40..60, the text from 50)", dashes(40, end, 20, 5, true)],
      ["4/2 dots from 50 (the last 158..162)", dashes(50, end, 4, 2, true)],
    ];
    for (const [name, rules] of cases) {
      const doc = page(DASHED, 11, rules);
      const d = detectDecorations(mupdf, doc, 0, DASHED, 0);
      expect(summaryOf(d), name).toEqual(LEFT_DASHED);
      expect(d.shapes.map((s) => s.plan.range), name).toEqual([[0, 21]]);
      expect(planOf(d, true), name).toEqual({ shapes: [], links: [] });
      const before = boxesOf(doc);
      expect(before.length, name).toBeGreaterThanOrEqual(4);
      expect(edit(doc, DASHED, `${DASHED}, longer`).report, name).toEqual(NOTHING);
      expect(boxesOf(doc), name).toEqual(before);
      expect(edit(doc, `${DASHED}, longer`, "").report, name).toEqual(NOTHING);
      expect(boxesOf(doc), name).toEqual(before);
    }
  });

  it("a dashed row that runs well past the text (more than its last dash and gap) is not this line's", () => {
    // A form's dashed fill-in line under a short label: it goes on long after the label's end.
    const doc = page("Name", 11, dashes(50, 300, 20, 5, true));
    expect(summaryOf(detectDecorations(mupdf, doc, 0, "Name", 0))).toMatchObject({ underlines: 0, left: [] });
  });

  it("a word's solid underline next to a dashed one: the word's follows, the dashes stay", () => {
    const text = "See dashed words here";
    const ws = width("See", 11), from = 50 + width("See ", 11);
    const doc = page(text, 11, `50 698.4 ${ws.toFixed(3)} 0.55 re f\n${dashes(from, 50 + width(text, 11), 20, 5)}`);
    const d = detectDecorations(mupdf, doc, 0, text, 0);
    expect(d.shapes.map((s) => [s.level, s.reason ?? null, s.plan.range])).toEqual([["auto", null, [0, 3]], ["left", "pattern", [4, 21]]]);
    const dashed = boxesOf(doc).filter((b) => b[0] > from - 0.1);
    expect(edit(doc, text, "Look dashed words here").report).toEqual({ ...NOTHING, moved: ["underline"] });
    expect(boxesOf(doc).filter((b) => b[0] > from - 0.1)).toEqual(dashed);
  });

  it('short words underlined one by one, close together ("EN IT", pagination), stay as the layout\'s (shared), not as a pattern', () => {
    const cases: [string, string[], [number, number][]][] = [
      ["EN IT", ["EN", "IT"], [[0, 2], [3, 5]]],
      ["1 2 3", ["1", "2", "3"], [[0, 1], [2, 3], [4, 5]]],
      ["1 | 2 | 3", ["1", "2", "3"], [[0, 1], [4, 5], [8, 9]]], // (the gaps on the bars)
      ["Pages 10 11 12 13", ["10", "11", "12", "13"], [[6, 8], [9, 11], [12, 14], [15, 17]]],
      // Words that end next to punctuation, brackets, slashes or dashes rather than a blank.
      ["EN/IT", ["EN", "IT"], [[0, 2], [3, 5]]],
      ["EN, IT", ["EN", "IT"], [[0, 2], [4, 6]]],
      ["EN-IT", ["EN", "IT"], [[0, 2], [3, 5]]],
      ["1, 2, 3", ["1", "2", "3"], [[0, 1], [3, 4], [6, 7]]],
      ["(1) (2) (3)", ["1", "2", "3"], [[1, 2], [5, 6], [9, 10]]],
      ["See 1, 2", ["1", "2"], [[4, 5], [7, 8]]],
    ];
    for (const [text, words, ranges] of cases) {
      const doc = wordsUnderlined(text, words);
      const d = detectDecorations(mupdf, doc, 0, text, 0);
      expect(summaryOf(d), text).toEqual({ underlines: 0, strikes: 0, links: 0, box: null, left: words.map(() => ({ kind: "underline", reason: "shared" })) });
      expect(d.shapes.map((s) => s.plan.range), text).toEqual(ranges);
      const before = boxesOf(doc);
      expect(edit(doc, text, `${text} 4`).report, text).toEqual(NOTHING);
      expect(edit(doc, `${text} 4`, "").report, text).toEqual(NOTHING);
      expect(boxesOf(doc), text).toEqual(before);
    }
  });

  it("a dotted or dashed row under text with punctuation is still one dotted or dashed rule (pattern)", () => {
    for (const text of ["EN/IT, 1-2 (3)", "1, 2, 3", "(1) (2) (3)"]) {
      const end = 50 + width(text, 12);
      for (const [name, rules] of [["dots 1/1", dashes(50, end, 1, 1)], ["dashes 3/2", dashes(50, end, 3, 2)], ["dashes 3/2, full", dashes(50, end, 3, 2, true)]]) {
        const doc = page(text, 12, rules);
        const d = detectDecorations(mupdf, doc, 0, text, 0);
        expect(summaryOf(d), `${text}, ${name}`).toEqual(LEFT_DASHED);
        expect(d.shapes.map((s) => s.plan.range), `${text}, ${name}`).toEqual([[0, text.length]]);
        const before = boxesOf(doc);
        expect(edit(doc, text, `${text} 4`).report, `${text}, ${name}`).toEqual(NOTHING);
        expect(edit(doc, `${text} 4`, "").report, `${text}, ${name}`).toEqual(NOTHING);
        expect(boxesOf(doc), `${text}, ${name}`).toEqual(before);
      }
    }
  });

  it("a regular row of long dashes whose ends fall near punctuation is one dashed rule, not words underlined one by one", () => {
    // Round 4's review: each dash ends within a rule's tolerance of a word's edge at punctuation,
    // so the dashes passed as words underlined one by one and followed the text piece by piece.
    const cases: [string, number, string, string, [number, number]][] = [
      ["Rev. 2.1 (draft)", 11, "50 698.4 20.5 0.55 re f\n74.5 698.4 20.5 0.55 re f\n99 698.4 20.5 0.55 re f\n", "Rev. 2.10 (final draft)", [0, 15]],
      ["Data: 17/10/2026", 10, dashes(50, 50 + width("Data: 17/10/2026", 10), 24.5, 2), "Data: 18/10/2026, ore 9", [0, 16]],
      ["See pp. 12-14, 20.", 10, dashes(51.5, 50 + width("See pp. 12-14, 20.", 10), 29, 3), "See pp. 12-15, 21.", [0, 18]],
    ];
    for (const [text, size, rules, replacement, range] of cases) {
      const doc = page(text, size, rules);
      const d = detectDecorations(mupdf, doc, 0, text, 0);
      expect(summaryOf(d), text).toEqual(LEFT_DASHED);
      expect(d.shapes.map((s) => s.plan.range), text).toEqual([range]);
      expect(planOf(d, true), text).toEqual({ shapes: [], links: [] });
      const before = boxesOf(doc);
      expect(before, text).toHaveLength(3);
      expect(edit(doc, text, replacement).report, text).toEqual(NOTHING);
      expect(boxesOf(doc), text).toEqual(before);
      expect(edit(doc, replacement, "").report, text).toEqual(NOTHING);
      expect(boxesOf(doc), text).toEqual(before);
    }
  });

  it("long words underlined one by one on one line each follow their own word", () => {
    for (const [text, words, replacement] of [
      ["Read Terms and Privacy", ["Terms", "Privacy"], "See Terms and Privacy"],
      ["1000 | 2000 | 3000", ["1000", "2000", "3000"], "100 | 2000 | 3000"], // as long as each other, gaps as long too
    ] as [string, string[], string][]) {
      const doc = wordsUnderlined(text, words);
      const d = detectDecorations(mupdf, doc, 0, text, 0);
      expect(summaryOf(d), text).toMatchObject({ underlines: words.length, left: [] });
      const oldEdges = edgesOf(doc, text), before = boxesOf(doc);
      const e = edit(doc, text, replacement);
      expect(e.report, text).toEqual({ ...NOTHING, moved: words.map(() => "underline") });
      const newEdges = edgesOf(doc, replacement);
      const after = pathsOf(doc);
      d.shapes.forEach((s, k) => {
        expect(at(after, expectedBox(before[k], s.plan.range, text, replacement, oldEdges, newEdges)), `${text}: ${words[k]}`).toHaveLength(1);
      });
      expect(edit(doc, replacement, "").report, text).toEqual({ ...NOTHING, removed: words.map(() => "underline") });
      expect(boxesOf(doc), text).toEqual([]);
    }
  });
});

describe("the rewrite's edge cases", () => {
  it('"Pay online" made "Pas online" (Chrome): the run\'s ends stay, and the skip-ink hole under the old "y" goes', () => {
    const doc = openFixture("decorations-chrome.pdf");
    const row = (r: Rect) => r[1] > 30 && r[3] < 33;
    const hole = holesOf(doc).filter(row);
    expect(hole).toHaveLength(1);
    const x = (hole[0][0] + hole[0][2]) / 2;
    const e = edit(doc, "Pay online", "Pas online");
    expect(e.report).toEqual({ ...NOTHING, moved: ["underline"] });
    expect(e.applied.shapes.map((s) => s.kind)).toEqual(["underline"]);
    expect(holesOf(doc).filter(row)).toEqual([]);
    const page = doc.loadPage(0);
    const pix = renderPixmap(mupdf, page, 4);
    page.destroy();
    try {
      expect(redAt(pix, 4, x, 31.4)).toBeLessThan(160); // the underline, under the "s" too
    } finally {
      pix.destroy();
    }
    // A replay of the logged plan does the same.
    const again = openFixture("decorations-chrome.pdf");
    const { find, occurrence } = locate(again, "Pay online");
    const before = beforeEdit(mupdf, again, 0, find, occurrence);
    replaceText(mupdf, again, 0, find, "Pas online", { occurrence });
    applyDecorations(mupdf, again, 0, JSON.parse(JSON.stringify(e.applied)), before, find, e.written, true);
    expect(holesOf(again).filter(row)).toEqual([]);
  });

  it('a Chrome-style clip with a hole under the "p" of "Shop now", made "Shoe now" (same widths): the hole goes', () => {
    const bytes = makePdf((doc) => {
      const font = helvetica(doc);
      const w = width("Shop now", 12), x0 = 50 + width("Sho", 12), xp = width("p", 12);
      const c = `BT 0 0 0 rg /F1 12 Tf 50 700 Td (Shop now) Tj ET
q 49 696 ${(w + 2).toFixed(3)} 3 re ${x0.toFixed(3)} 696.5 ${xp.toFixed(3)} 2.5 re W* n 0 0 0 rg 50 697.4 ${w.toFixed(3)} 0.8 re f Q`;
      doc.insertPage(-1, doc.addPage([0, 0, 400, 800], 0, { Font: { F1: font } }, c));
    });
    const doc = openBytes(bytes);
    const under = 50 + width("Sho", 12) + width("p", 12) / 2;
    const ink = (d: mupdf.PDFDocument) => {
      const page = d.loadPage(0);
      const pix = renderPixmap(mupdf, page, 4);
      page.destroy();
      try {
        return redAt(pix, 4, under, 800 - 697.8);
      } finally {
        pix.destroy();
      }
    };
    expect(ink(doc)).toBe(255); // the hole
    expect(edit(doc, "Shop now", "Shoe now").report).toEqual({ ...NOTHING, moved: ["underline"] });
    expect(ink(doc)).toBeLessThan(100);
  });

  it("an underline in an ICC colour, the line edited twice: after the app's own rewrite of the text it is still the text's colour", () => {
    const bytes = makePdf((doc) => {
      const font = helvetica(doc);
      const icc = doc.addStream(srgbProfile(), { N: 3 });
      const w = width("Pay online", 12);
      const c = `/CS0 cs 0.1 0.2 0.8 sc BT /F1 12 Tf 50 700 Td (Pay online) Tj ET /CS0 cs 0.1 0.2 0.8 sc 50 697.5 ${w.toFixed(3)} 0.6 re f`;
      doc.insertPage(-1, doc.addPage([0, 0, 400, 800], 0, { Font: { F1: font }, ColorSpace: { CS0: ["ICCBased", icc] } }, c));
    });
    const doc = openBytes(bytes);
    const first = edit(doc, "Pay online", "Pay onlineeee");
    expect(summaryOf(first.detected)).toMatchObject({ underlines: 1, left: [] });
    expect(first.report.moved).toEqual(["underline"]);
    const second = edit(doc, "Pay onlineeee", "Pay online");
    expect(summaryOf(second.detected)).toMatchObject({ underlines: 1, left: [] });
    expect(second.report).toEqual({ ...NOTHING, moved: ["underline"] });
    const right = edgesOf(doc, "Pay online")[9][1];
    expect(pathsOf(doc).some((p) => Math.abs(p.bbox[2] - right) < 0.05)).toBe(true);
  });

  it("a rule in another colour space of the same kind with other components is still another colour", () => {
    const bytes = makePdf((doc) => {
      const font = helvetica(doc);
      const icc = doc.addStream(srgbProfile(), { N: 3 });
      const w = width("Pay online", 12);
      const c = `0.1 0.2 0.8 rg BT /F1 12 Tf 50 700 Td (Pay online) Tj ET /CS0 cs 0.8 0.2 0.1 sc 50 697.5 ${w.toFixed(3)} 0.6 re f`;
      doc.insertPage(-1, doc.addPage([0, 0, 400, 800], 0, { Font: { F1: font }, ColorSpace: { CS0: ["ICCBased", icc] } }, c));
    });
    const doc = openBytes(bytes);
    expect(summaryOf(detectDecorations(mupdf, doc, 0, "Pay online", 0))).toMatchObject({ underlines: 0, left: [{ kind: "underline", reason: "colour" }] });
  });
});

describe("pages that are slow or odd to read", () => {
  /** "Plain underline" (Helvetica 11 at 50,400, black) with its underline; `before` is drawn first. */
  const plain = (before: string, resources: (doc: mupdf.PDFDocument) => Record<string, unknown> = () => ({}), options = "compress=yes") =>
    makePdf((doc) => {
      const font = helvetica(doc);
      const c = `${before}\nBT 0 0 0 rg /F1 11 Tf 50 400 Td (Plain underline) Tj ET 0 0 0 rg 50 398.4 ${width("Plain underline", 11).toFixed(3)} 0.55 re f`;
      doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { Font: { F1: font }, ...resources(doc) }, c));
    }, options);

  /** Detection's time, and the line read's on the same page (what the editor pays anyway). */
  function timed(doc: mupdf.PDFDocument) {
    let t = performance.now();
    const page = doc.loadPage(0);
    releasePage(page, extractLines(page) as never);
    const read = performance.now() - t;
    t = performance.now();
    const d = detectDecorations(mupdf, doc, 0, "Plain underline", 0);
    return { d, ms: performance.now() - t, read };
  }

  it("a dense band of dots near the line does not block the worker (fewer than MAX_PIECES, and many more)", () => {
    for (const n of [4_000, 40_000]) {
      const parts: string[] = [];
      let seed = 7;
      const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
      for (let i = 0; i < n; i++) parts.push(`${(16 + rnd() * 160).toFixed(2)} ${(395.8 + rnd() * 4).toFixed(2)} 0.1 0.1 re f`);
      const { d, ms } = timed(openBytes(plain(parts.join("\n"))));
      expect(d.shapes.length).toBeGreaterThan(0);
      expect(d.shapes.every((s) => s.level === "left")).toBe(true); // the dots touch it: not for sure the line's
      expect(d.shapes.length).toBeLessThan(10);
      expect(ms).toBeLessThan(3000); // (40,000 took 14 s)
    }
  }, 60_000);

  it("20,000 copies of the same underline drawn over each other do not block it either", () => {
    const w = width("Plain underline", 11).toFixed(3);
    const { d, ms } = timed(openBytes(plain(Array.from({ length: 20_000 }, () => `0 0 0 rg 50 398.4 ${w} 0.55 re f`).join("\n"))));
    expect(summaryOf(d)).toMatchObject({ underlines: 0 });
    expect(d.shapes.length).toBeLessThan(10);
    expect(ms).toBeLessThan(3000); // (it took 19 s)
  }, 60_000);

  it("paths drawn by a form drawn many times count against the cap: past it, no device pass runs", () => {
    const tiny = Array.from({ length: 2_000 }, (_, i) => `${(i % 100) * 2} ${Math.floor(i / 100) * 2} 1 1 re f`).join("\n");
    const draws = Array.from({ length: 250 }, (_, i) => `q 1 0 0 1 ${i % 5} 500 cm /Fm0 Do Q`).join("\n");
    const bytes = plain(draws, (doc) => ({ XObject: { Fm0: doc.addStream(tiny, { Type: "XObject", Subtype: "Form", BBox: [0, 0, 200, 40] }) } }));
    const doc = openBytes(bytes);
    let paths = 0;
    const proto = mupdf.Path.prototype as { destroy(): void };
    const original = proto.destroy;
    proto.destroy = function (this: { pointer: number }) {
      if (this.pointer) paths++;
      original.call(this);
    };
    let result: ReturnType<typeof timed>;
    try {
      result = timed(doc);
    } finally {
      proto.destroy = original;
    }
    expect(paths).toBe(0); // 500,000 paths: more than twice MAX_PATHS, never handed to the pass
    expect(result.d.shapes).toEqual([]);
    expect(result.ms).toBeLessThan(2 * result.read + 1000);
  }, 60_000);

  it("a path of 150,000 points near the line neither throws nor hides the underline", () => {
    const pts: string[] = ["30 430 m"];
    for (let i = 1; i < 150_000; i++) pts.push(`${(30 + (120 * i) / 150_000).toFixed(4)} ${(440 + 10 * Math.sin(i / 50)).toFixed(3)} l`);
    pts.push("150 430 l h 0.5 0.5 0.5 rg f");
    const doc = openBytes(plain(pts.join("\n")));
    expect(summaryOf(detectDecorations(mupdf, doc, 0, "Plain underline", 0))).toMatchObject({ underlines: 1, left: [] });
  }, 60_000);

  it("a /Contents array with a null or a dangling entry: read as MuPDF reads it, and the underline follows", () => {
    for (const bad of ["null", "dangling"]) {
      const doc = openBytes(plain("", undefined, "compress=no"));
      const pageObj = doc.findPage(0);
      const arr = doc.newArray();
      arr.push(pageObj.get("Contents"));
      arr.push(bad === "null" ? doc.newNull() : doc.newIndirect(9999));
      pageObj.put("Contents", arr);
      expect(summaryOf(detectDecorations(mupdf, doc, 0, "Plain underline", 0))).toMatchObject({ underlines: 1, left: [] });
      expect(edit(doc, "Plain underline", "Plain underline, longer").report).toEqual({ ...NOTHING, moved: ["underline"] });
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Synthetic PDFs

/** A PDF made here with MuPDF. */
function makePdf(build: (doc: mupdf.PDFDocument) => void, options = "compress=no"): Uint8Array {
  const doc = new mupdf.PDFDocument();
  try {
    build(doc);
    return saveBytes(doc, options);
  } finally {
    doc.destroy();
  }
}

function helvetica(doc: mupdf.PDFDocument) {
  const font = new mupdf.Font("Helvetica");
  try {
    return doc.addSimpleFont(font);
  } finally {
    font.destroy();
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

/**
 * A tagged page: the line "Read the terms" (MCID 0, inside a /Link structure element), underlined,
 * under a link annotation with /F 4, /Border and /StructParent 1, whose OBJR is in the /Link
 * element. `objrTwice`: the element lists the OBJR twice (not as expected: the link must stay).
 */
function taggedLink({ objrTwice = false } = {}): Uint8Array {
  return makePdf((doc) => {
    const font = helvetica(doc);
    const w = width("Read the terms", 12);
    const content = `/Link <</MCID 0>> BDC BT 0 0 1 rg /F1 12 Tf 50 700 Td (Read the terms) Tj ET EMC 0 0 1 rg 50 697.8 ${w.toFixed(3)} 0.6 re f`;
    doc.insertPage(-1, doc.addPage([0, 0, 400, 800], 0, { Font: { F1: font } }, content));
    const page = doc.findPage(0);
    const link = doc.addObject({
      Type: "Annot", Subtype: "Link", Rect: [50, 696, 50 + w, 712], Border: [0, 0, 0], F: 4, StructParent: 1,
      A: { S: "URI", URI: doc.newString("https://example.com/terms") },
    });
    page.put("Annots", [link]);
    page.put("StructParents", 0);
    const root = doc.addObject({ Type: "StructTreeRoot" });
    const document = doc.addObject({ Type: "StructElem", S: "Document", P: root });
    const linkElement = doc.addObject({ Type: "StructElem", S: "Link", P: document, Pg: page });
    const kids = doc.newArray();
    kids.push(0);
    for (let k = 0; k < (objrTwice ? 2 : 1); k++) {
      const r = doc.newDictionary();
      r.put("Type", doc.newName("OBJR"));
      r.put("Obj", link);
      r.put("Pg", page);
      kids.push(r);
    }
    linkElement.put("K", kids);
    document.put("K", [linkElement]);
    root.put("K", document);
    root.put("ParentTree", { Nums: [0, [linkElement], 1, linkElement] });
    root.put("ParentTreeNextKey", 2);
    const catalog = doc.getTrailer().get("Root");
    catalog.put("StructTreeRoot", root);
    catalog.put("MarkInfo", { Marked: true });
  });
}

// ---------------------------------------------------------------------------------------------
// Links: the review's cases (D11, D12, D13, D17)

/**
 * `pages` pages, each with the line "Pay online" (Helvetica 12, blue, at 50,700 on a 400 x 800
 * page), its underline, and its own link annotation over it (/F 4, /Border, /P) to `uri`, with
 * `link`'s entries added; `build` then changes the document as a case needs (`links`: the link
 * objects, one a page).
 */
function payOnline({ uri = "https://example.com/pay", pages = 1, link = {}, build }: {
  uri?: string; pages?: number; link?: Record<string, unknown>; build?: (doc: mupdf.PDFDocument, links: mupdf.PDFObject[]) => void;
} = {}): Uint8Array {
  return makePdf((doc) => {
    const font = helvetica(doc);
    const w = width("Pay online", 12);
    const content = `BT 0 0 1 rg /F1 12 Tf 50 700 Td (Pay online) Tj ET 0 0 1 rg 50 697.8 ${w.toFixed(3)} 0.6 re f`;
    const links: mupdf.PDFObject[] = [];
    for (let k = 0; k < pages; k++) {
      doc.insertPage(-1, doc.addPage([0, 0, 400, 800], 0, { Font: { F1: font } }, content));
      const page = doc.findPage(k);
      const dict = doc.addObject({
        Type: "Annot", Subtype: "Link", Rect: [50, 696, 50 + w, 712], Border: [0, 0, 0], F: 4, P: page,
        A: { S: "URI", URI: doc.newString(uri) }, ...link,
      });
      page.put("Annots", [dict]);
      links.push(dict);
    }
    build?.(doc, links);
  });
}

describe("links: the review's cases", () => {
  const grown = { ...NOTHING, moved: ["underline"], linksMoved: 1 };
  const deleted = { ...NOTHING, removed: ["underline"], linksRemoved: 1 };

  it("D11: a link with /StructParent in a document with no structure tree goes with its line (nothing points at it)", () => {
    const bytes = payOnline({ link: { StructParent: 3 }, build: (doc) => doc.findPage(0).put("StructParents", 2) });
    const doc = openBytes(bytes);
    expect(doc.getTrailer().get("Root", "StructTreeRoot").isNull()).toBe(true);
    expect(summaryOf(detectDecorations(mupdf, doc, 0, "Pay online", 0))).toMatchObject({ underlines: 1, links: 1, left: [] });
    const e = edit(doc, "Pay online", "");
    expect(e.report).toEqual(deleted);
    expect(e.applied.links).toHaveLength(1);
    expect(linksOf(doc)).toEqual([]);
    expect(linksOf(reopen(doc))).toEqual([]);
    // Moved, it keeps its /StructParent.
    const moved = openBytes(bytes);
    expect(edit(moved, "Pay online", "Pay onlineeeeee").report).toEqual(grown);
    expect(moved.findPage(0).get("Annots").get(0).get("StructParent").asNumber()).toBe(3);
  });

  it("D11: with a structure tree that does not name the link, it stays (shared), as before", () => {
    const doc = openBytes(payOnline({
      link: { StructParent: 3 },
      build: (d) => d.getTrailer().get("Root").put("StructTreeRoot", d.addObject({ Type: "StructTreeRoot", ParentTree: { Nums: [] } })),
    }));
    const e = edit(doc, "Pay online", "");
    expect(e.report).toEqual({ ...NOTHING, removed: ["underline"], left: [{ kind: "link", reason: "shared" }] });
    expect(e.applied.links).toEqual([]);
    expect(linksOf(doc)).toHaveLength(1);
  });

  it("D12: a link whose URI has no scheme (MuPDF reads it after file:// or the document's /URI /Base) follows the text", () => {
    const cases = [
      { uri: "www.example.com/pay", base: null, read: "file://www.example.com/pay" },
      { uri: "pay/now", base: "https://example.com/", read: "https://example.com/pay/now" },
      { uri: "#total", base: null, read: "file://#total" },
    ];
    for (const { uri, base, read } of cases) {
      const bytes = payOnline({ uri, build: base ? (doc) => doc.getTrailer().get("Root").put("URI", { Base: doc.newString(base) }) : undefined });
      const doc = openBytes(bytes);
      const before = linksOf(doc)[0];
      expect(before.uri).toBe(read);
      expect(summaryOf(detectDecorations(mupdf, doc, 0, "Pay online", 0))).toMatchObject({ underlines: 1, links: 1, left: [] });
      const e = edit(doc, "Pay online", "Pay onlineeeeee");
      expect(e.report).toEqual(grown);
      const after = linksOf(doc)[0].bounds;
      const grow = edgesOf(doc, "Pay onlineeeeee")[14][1] - edgesOf(openBytes(bytes), "Pay online")[9][1];
      expect(grow).toBeGreaterThan(20);
      expect(near(after, [before.bounds[0], before.bounds[1], before.bounds[2] + grow, before.bounds[3]], 0.01)).toBe(true);
      // A replay of the logged plan finds it again.
      const again = openBytes(bytes);
      const { find, occurrence } = locate(again, "Pay online");
      const b = beforeEdit(mupdf, again, 0, find, occurrence);
      const written = replaceText(mupdf, again, 0, find, "Pay onlineeeeee", { occurrence }).segments.map((s: { text: string }) => s.text).join("");
      expect(applyDecorations(mupdf, again, 0, e.applied, b, find, written, true).report).toEqual(grown);
      expect(near(linksOf(again)[0].bounds, after, 0.01)).toBe(true);
      // Deleted with its line.
      const gone = openBytes(bytes);
      expect(edit(gone, "Pay online", "").report).toEqual(deleted);
      expect(linksOf(gone)).toEqual([]);
    }
  });

  it("D12: two links at one rect, one with a URI without a scheme: each is found as its own", () => {
    const doc = openBytes(payOnline({
      build: (d, [link]) => {
        const other = d.addObject({ Type: "Annot", Subtype: "Link", Rect: link.get("Rect"), A: { S: "URI", URI: d.newString("pay") } });
        d.findPage(0).put("Annots", [link, other]);
      },
    }));
    expect(linksOf(doc).map((l) => l.uri).sort()).toEqual(["file://pay", "https://example.com/pay"]);
    expect(summaryOf(detectDecorations(mupdf, doc, 0, "Pay online", 0))).toMatchObject({ underlines: 1, links: 2, left: [] });
    expect(edit(doc, "Pay online", "Pay onlineeeeee").report).toEqual({ ...grown, linksMoved: 2 });
  });

  it("D13: a null or a dangling entry in /Annots is skipped: the underline and the link still follow, and go with the line", () => {
    for (const bad of ["null", "dangling"])
      for (const replacement of ["Pay onlineeeeee", ""]) {
        const doc = openBytes(payOnline());
        const pageObj = doc.findPage(0);
        const arr = doc.newArray();
        arr.push(bad === "null" ? doc.newNull() : doc.newIndirect(9999));
        arr.push(pageObj.get("Annots").get(0));
        pageObj.put("Annots", arr);
        expect(summaryOf(detectDecorations(mupdf, doc, 0, "Pay online", 0))).toMatchObject({ underlines: 1, links: 1, left: [] });
        expect(edit(doc, "Pay online", replacement).report).toEqual(replacement ? grown : deleted);
        expect(linksOf(doc)).toHaveLength(replacement ? 1 : 0);
        expect(linksOf(reopen(doc))).toHaveLength(replacement ? 1 : 0);
      }
  });

  /** Page 1 lists page 0's link object in its own /Annots. */
  const shareObject = (doc: mupdf.PDFDocument, links: mupdf.PDFObject[]) => doc.findPage(1).put("Annots", [links[0]]);
  /** Pages 0 and 1 have one /Annots array (an indirect object), holding page 0's link. */
  const shareArray = (doc: mupdf.PDFDocument, links: mupdf.PDFObject[]) => {
    const arr = doc.addObject([links[0]]);
    doc.findPage(0).put("Annots", arr);
    doc.findPage(1).put("Annots", arr);
  };

  it("D17: a link that two pages share stays as it is on both (shared), whether one page's line grows or goes", () => {
    for (const share of [shareObject, shareArray])
      for (const replacement of ["Pay onlineeeeee", ""]) {
        const doc = openBytes(payOnline({ pages: 2, build: share }));
        const before = [linksOf(doc, 0), linksOf(doc, 1)];
        expect(before[0]).toHaveLength(1);
        expect(before[1]).toEqual(before[0]);
        expect(summaryOf(detectDecorations(mupdf, doc, 0, "Pay online", 0))).toMatchObject({
          underlines: 1, links: 0, left: [{ kind: "link", reason: "shared" }],
        });
        const e = edit(doc, "Pay online", replacement);
        expect(e.report).toEqual(replacement ? { ...NOTHING, moved: ["underline"] } : { ...NOTHING, removed: ["underline"] });
        const saved = reopen(doc);
        for (const pageIndex of [0, 1]) {
          const now = linksOf(saved, pageIndex);
          expect(now).toHaveLength(1);
          expect(now[0].uri).toBe(before[pageIndex][0].uri);
          expect(near(now[0].bounds, before[pageIndex][0].bounds, 0.01)).toBe(true);
        }
        expect(linesOf(saved, 1).some((l) => l.text === "Pay online")).toBe(true);
      }
  });

  it("D17: pages with a link each (the same URI and rect) share nothing: page 0's follows, page 1's stays", () => {
    const doc = openBytes(payOnline({ pages: 2 }));
    const other = linksOf(doc, 1);
    expect(edit(doc, "Pay online", "Pay onlineeeeee").report).toEqual(grown);
    expect(linksOf(doc, 0)[0].bounds[2]).toBeGreaterThan(other[0].bounds[2] + 20);
    expect(linksOf(doc, 1)).toEqual(other);
  });

  it("D17: a link another page shares by the time the edit is applied is not moved, and a replay of such a plan fails", () => {
    const bytes = payOnline({ pages: 2 });
    const run = (replay: boolean) => {
      const doc = openBytes(bytes);
      const { find, occurrence } = locate(doc, "Pay online");
      const plan = planOf(detectDecorations(mupdf, doc, 0, find, occurrence), undefined);
      expect(plan.links).toHaveLength(1);
      shareObject(doc, [doc.findPage(0).get("Annots").get(0)]);
      const other = linksOf(doc, 1);
      const b = beforeEdit(mupdf, doc, 0, find, occurrence);
      const written = replaceText(mupdf, doc, 0, find, "Pay onlineeeeee", { occurrence }).segments.map((s: { text: string }) => s.text).join("");
      try {
        return applyDecorations(mupdf, doc, 0, plan, b, find, written, replay);
      } finally {
        expect(linksOf(doc, 1)).toEqual(other);
      }
    };
    const { applied, report } = run(false);
    expect(report).toEqual({ ...NOTHING, moved: ["underline"], left: [{ kind: "link", reason: "shared" }] });
    expect(applied.links).toEqual([]);
    expect(() => run(true)).toThrow(DecorationMismatch);
  });
});
