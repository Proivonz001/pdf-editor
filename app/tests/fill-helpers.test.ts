// The helpers of "Compila e firma" (src/ui/fill/): geometry (taps, the writer's start, where a
// signature lands, initials copied to pages of other sizes, zoom to write), dates, the
// handwriting fonts found by measuring text, the signature pictures (strokes, typed names, ink
// taken from a photo, trimming) and the signatures kept in IndexedDB. Ported from the checks of
// the release 3 UX prototypes (geometry, ink extraction and its synthetic photos, font probe).
// The browser's canvas, decoder and IndexedDB are replaced by fakes (Node has none), as
// tests/imageFile.test.ts does; the photos are synthetic, encoded and decoded as JPEG by MuPDF.
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as mupdf from "mupdf";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Matrix, Rect } from "../src/engine/protocol";
import { dateLocale, datePattern, dateText, looksLikeDate } from "../src/ui/fill/dates";
import {
  anchorOf, fitInField, isTap, MM, placeOn, rectMatrix, signatureInField, signatureRect, writerOrigin, zoomToWrite,
  type Press,
} from "../src/ui/fill/geometry";
import { availableHandwritingFonts, detectHandwritingFonts } from "../src/ui/fill/handwritingFonts";
import {
  drawPieces, extractInk, fitScale, initialsOf, INK_RGB, inkExtent, MIN_INK_EXTENT, NoInkError, paintInk, photoPixels,
  piecesBounds, refitView, renderInk, renderStrokes, renderTyped, SIGNATURE_MAX_SIDE, STROKE_OPTIONS, strokePieces, toPng,
  trim, type FoundInk, type Stroke, type StrokePiece,
} from "../src/ui/fill/signatureImage";
import { available, forget, list, MAX_SAVED, save } from "../src/ui/fill/signatureStore";
import { boundsOf, corners, rotateAbout, sides } from "../src/viewer/imageGeometry";
import { MAX_ZOOM } from "../src/viewer/layout";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------------------------
// Geometry

const A4: Rect = [0, 0, 595.28, 841.89];
const PAGES: Record<string, Rect> = {
  A4,
  "A4 landscape": [0, 0, 841.89, 595.28],
  A3: [0, 0, 841.89, 1190.55],
  Letter: [0, 0, 612, 792],
  receipt: [0, 0, 226, 600],
  "offset bounds": [10, 20, 605.28, 861.89],
};
const mm = (pt: number) => pt / MM;

describe("anchorOf and placeOn: initials on every page", () => {
  /** A 12 × 8 mm picture on A4 at anchor (h, v), dx / dy mm from the anchored edges (or from the centre). */
  function source(h: "left" | "centre" | "right", v: "top" | "middle" | "bottom", dx: number, dy: number): Rect {
    const w = 12 * MM, ht = 8 * MM;
    const x0 = h === "left" ? dx * MM : h === "right" ? A4[2] - dx * MM - w : A4[2] / 2 + dx * MM - w / 2;
    const y0 = v === "top" ? dy * MM : v === "bottom" ? A4[3] - dy * MM - ht : A4[3] / 2 + dy * MM - ht / 2;
    return [x0, y0, x0 + w, y0 + ht];
  }

  /** How the anchor reads on `page`: the distances in mm the anchor keeps, and the size. */
  function measure(r: Rect, page: Rect, h: string, v: string) {
    const W = page[2] - page[0], H = page[3] - page[1];
    const dx = h === "left" ? r[0] - page[0] : h === "right" ? page[2] - r[2] : (r[0] + r[2]) / 2 - page[0] - W / 2;
    const dy = v === "top" ? r[1] - page[1] : v === "bottom" ? page[3] - r[3] : (r[1] + r[3]) / 2 - page[1] - H / 2;
    return { dx: mm(dx), dy: mm(dy), w: mm(r[2] - r[0]), h: mm(r[3] - r[1]) };
  }

  const ANCHORS = [
    ["left", "top", 15, 12], ["centre", "top", 0, 12], ["right", "top", 15, 12],
    ["left", "middle", 15, 5], ["centre", "middle", -6, 5], ["right", "middle", 15, -5],
    ["left", "bottom", 15, 12], ["centre", "bottom", 0, 12], ["right", "bottom", 15, 12],
  ] as const;

  for (const [h, v, dx, dy] of ANCHORS) {
    it(`${v} ${h}: same size and same distances on every page shape`, () => {
      const m = rectMatrix(source(h, v, dx, dy));
      const a = anchorOf(m, A4);
      expect([a.h, a.v]).toEqual([h, v]);
      for (const [name, page] of Object.entries(PAGES)) {
        const placed = placeOn(a, m, page);
        // Upright and unscaled: the same linear part.
        expect(placed.slice(0, 4), name).toEqual(m.slice(0, 4));
        const got = measure(boundsOf(placed), page, h, v);
        expect(got.dx, name).toBeCloseTo(dx, 6);
        expect(got.dy, name).toBeCloseTo(dy, 6);
        expect(got.w, name).toBeCloseTo(12, 6);
        expect(got.h, name).toBeCloseTo(8, 6);
      }
    });
  }

  it("the prototype's case: 15 mm from the right and 12 mm from the bottom, exactly, everywhere", () => {
    const src: Rect = [A4[2] - 27 * MM, A4[3] - 20 * MM, A4[2] - 15 * MM, A4[3] - 12 * MM];
    const a = anchorOf(rectMatrix(src), A4);
    expect(a).toMatchObject({ h: "right", v: "bottom" });
    for (const [name, page] of Object.entries(PAGES)) {
      const r = boundsOf(placeOn(a, rectMatrix(src), page));
      expect(mm(page[2] - r[2]), name).toBeCloseTo(15, 9);
      expect(mm(page[3] - r[3]), name).toBeCloseTo(12, 9);
    }
  });

  it("bottom centre stays centred on a landscape page", () => {
    const src: Rect = [A4[2] / 2 - 6 * MM, A4[3] - 20 * MM, A4[2] / 2 + 6 * MM, A4[3] - 12 * MM];
    const a = anchorOf(rectMatrix(src), A4);
    expect(a.h).toBe("centre");
    const r = boundsOf(placeOn(a, rectMatrix(src), PAGES["A4 landscape"]));
    expect((r[0] + r[2]) / 2).toBeCloseTo(841.89 / 2, 9);
  });

  it("shrinks only when the page is smaller than the picture, and keeps it on the page", () => {
    const big: Matrix = [300, 0, 0, 100, 280, 730];
    const a = anchorOf(big, A4);
    const r = boundsOf(placeOn(a, big, PAGES.receipt));
    expect(r[2] - r[0]).toBeCloseTo(226, 9);
    expect((r[2] - r[0]) / (r[3] - r[1])).toBeCloseTo(3, 9);
    expect(r[0]).toBeGreaterThanOrEqual(0);
    expect(r[2]).toBeLessThanOrEqual(226 + 1e-9);
    // A distance that no longer fits on a small page: moved in, not off the page.
    const far = anchorOf([30, 0, 0, 20, 10, 600], A4);
    const tiny: Rect = [0, 0, 100, 120];
    const t = boundsOf(placeOn(far, [30, 0, 0, 20, 10, 600], tiny));
    expect(t[1]).toBeGreaterThanOrEqual(0);
    expect(t[3]).toBeLessThanOrEqual(120 + 1e-9);
  });

  it("a turned picture keeps its rotation; its box is what is anchored", () => {
    const turned = rotateAbout([60, 0, 0, 30, 480, 760], [510, 775], 90);
    const a = anchorOf(turned, A4);
    expect(a).toMatchObject({ h: "right", v: "bottom" });
    const placed = placeOn(a, turned, PAGES.Letter);
    expect(placed.slice(0, 4)).toEqual(turned.slice(0, 4));
    const before = boundsOf(turned), after = boundsOf(placed);
    expect(612 - after[2]).toBeCloseTo(A4[2] - before[2], 9);
    expect(792 - after[3]).toBeCloseTo(A4[3] - before[3], 9);
  });
});

describe("isTap", () => {
  const press = (p: Partial<Press>): Press => ({ dx: 0, dy: 0, ms: 150, pointers: 1, scrolled: false, coarse: true, ...p });
  it("a finger may move 10 px, a mouse 3 px", () => {
    expect(isTap(press({ dx: 4, dy: 6 }))).toBe(true);
    expect(isTap(press({ dx: 6, dy: 8 }))).toBe(true); // exactly 10
    expect(isTap(press({ dx: 4, dy: 12 }))).toBe(false);
    expect(isTap(press({ dx: 2, dy: 2, coarse: false }))).toBe(true);
    expect(isTap(press({ dx: 3, coarse: false }))).toBe(true);
    expect(isTap(press({ dx: 4, coarse: false }))).toBe(false);
  });
  it("one pointer, at most 600 ms, no scroll", () => {
    expect(isTap(press({ ms: 600 }))).toBe(true);
    expect(isTap(press({ ms: 601 }))).toBe(false);
    expect(isTap(press({ pointers: 2 }))).toBe(false);
    expect(isTap(press({ pointers: 0 }))).toBe(false);
    expect(isTap(press({ scrolled: true }))).toBe(false);
    expect(isTap(press({ dx: Number.NaN }))).toBe(false);
    expect(isTap(press({ ms: Number.NaN }))).toBe(false);
  });
});

describe("zoomToWrite", () => {
  it("fit width on a 390 px phone: 11 pt text goes from 6.9 px to 16 px", () => {
    const fit = (390 - 16) / 595.28;
    const z = zoomToWrite(11, fit, true);
    expect(z).toBeCloseTo(16 / 11, 9);
    expect(11 * z).toBeCloseTo(16, 9);
  });
  it("unchanged when already large enough, on desktop, or for nonsense", () => {
    expect(zoomToWrite(11, 2, true)).toBe(2);
    expect(zoomToWrite(11, 14.4 / 11, true)).toBe(14.4 / 11); // exactly at the trigger
    expect(zoomToWrite(11, 0.5, false)).toBe(0.5);
    expect(zoomToWrite(0, 0.5, true)).toBe(0.5);
    expect(zoomToWrite(Number.NaN, 0.5, true)).toBe(0.5);
  });
  it("capped at MAX_ZOOM, and never zooms out", () => {
    expect(zoomToWrite(2, 1, true)).toBe(MAX_ZOOM);
    expect(zoomToWrite(1, MAX_ZOOM + 1, true)).toBe(MAX_ZOOM + 1);
    expect(zoomToWrite(11, 14.3 / 11, true)).toBeCloseTo(16 / 11, 9);
  });
});

describe("writerOrigin, signatureRect, fitInField, rectMatrix", () => {
  it("the writer's baseline starts 0.2 em above the tap", () => {
    const [x, y] = writerOrigin([100, 200], 11);
    expect(x).toBe(100);
    expect(y).toBeCloseTo(197.8, 9);
    expect(writerOrigin([5, 6], Number.NaN)).toEqual([5, 6]);
  });

  it("a 3:1 signature at a tap: 50 × 16.7 mm, centred across, its bottom 15 % below the tap", () => {
    const r = signatureRect(A4, "signature", 3, [300, 700]);
    expect(mm(r[2] - r[0])).toBeCloseTo(50, 9);
    expect(mm(r[3] - r[1])).toBeCloseTo(50 / 3, 9);
    expect((r[0] + r[2]) / 2).toBeCloseTo(300, 9);
    expect(r[3] - 700).toBeCloseTo(0.15 * (r[3] - r[1]), 9);
  });

  it("a square signature is at most 20 mm tall; initials are 10 mm tall", () => {
    const s = signatureRect(A4, "signature", 1, [300, 400]);
    expect(mm(s[3] - s[1])).toBeCloseTo(20, 9);
    expect(mm(s[2] - s[0])).toBeCloseTo(20, 9);
    const i = signatureRect(A4, "initials", 2, [300, 400]);
    expect(mm(i[3] - i[1])).toBeCloseTo(10, 9);
    expect(mm(i[2] - i[0])).toBeCloseTo(20, 9);
  });

  it("kept on the page: near an edge, on a tiny page, without a tap (centred)", () => {
    for (const at of [[10, 835], [590, 5], [-50, 900]] as [number, number][]) {
      for (const [name, page] of Object.entries(PAGES)) {
        const r = signatureRect(page, "signature", 3, at);
        expect(r[0], name).toBeGreaterThanOrEqual(page[0] - 1e-9);
        expect(r[1], name).toBeGreaterThanOrEqual(page[1] - 1e-9);
        expect(r[2], name).toBeLessThanOrEqual(page[2] + 1e-9);
        expect(r[3], name).toBeLessThanOrEqual(page[3] + 1e-9);
      }
    }
    const tiny: Rect = [0, 0, 60, 30];
    const t = signatureRect(tiny, "signature", 3);
    expect(t[2] - t[0]).toBeCloseTo(60, 9);
    expect(t[3] - t[1]).toBeCloseTo(20, 9);
    const c = signatureRect(PAGES["offset bounds"], "signature", 3);
    expect((c[0] + c[2]) / 2).toBeCloseTo((10 + 605.28) / 2, 9);
    expect((c[1] + c[3]) / 2).toBeCloseTo((20 + 861.89) / 2, 9);
    // A picture with no usable proportions is taken as square.
    expect(signatureRect(A4, "initials", 0, [300, 400])).toEqual(signatureRect(A4, "initials", 1, [300, 400]));
  });

  it("fitInField: contain, centred across, resting on the bottom", () => {
    expect(fitInField([100, 100, 300, 140], 3)).toEqual([140, 100, 260, 140]);
    expect(fitInField([100, 100, 300, 140], 10)).toEqual([100, 120, 300, 140]);
    expect(fitInField([300, 140, 100, 100], 10)).toEqual([100, 120, 300, 140]);
    expect(fitInField([5, 5, 5, 20], 2)).toEqual([5, 5, 5, 20]);
  });

  it("signatureInField: upright as fitInField at 0°; turned with the field's text, on its own line", () => {
    const field: Rect = [100, 100, 300, 140];
    expect(signatureInField(field, 3, 0)).toEqual(rectMatrix(fitInField(field, 3)));
    expect(signatureInField(field, 3, 360)).toEqual(rectMatrix(fitInField(field, 3)));
    // A field in the margin whose text runs down the page (90°): 30 × 150 pt as seen. The old way
    // gave a 30 × 10 pt sliver across it; now the signature runs along it, 90 × 30 pt.
    const tall: Rect = [500, 300, 530, 450];
    expect(boundsOf(rectMatrix(fitInField(tall, 3)))).toEqual([500, 440, 530, 450]);
    const cases = [
      // rotation, where the picture's bottom edge (its corners 3 and 4 as seen) rests
      [90, (p: [number, number]) => expect(p[0]).toBeCloseTo(500, 9)],
      [270, (p: [number, number]) => expect(p[0]).toBeCloseTo(530, 9)],
      [-90, (p: [number, number]) => expect(p[0]).toBeCloseTo(530, 9)],
    ] as const;
    for (const [rotation, onLine] of cases) {
      const m = signatureInField(tall, 3, rotation);
      expect(sides(m).width, String(rotation)).toBeCloseTo(90, 9);
      expect(sides(m).height, String(rotation)).toBeCloseTo(30, 9);
      const b = boundsOf(m);
      expect(b[0]).toBeCloseTo(500, 9);
      expect(b[2]).toBeCloseTo(530, 9);
      expect((b[1] + b[3]) / 2).toBeCloseTo(375, 9); // centred along the field
      const [, , br, bl] = corners(m);
      onLine(br);
      onLine(bl);
    }
    // Upside down (180°): the same size as upright, resting on the top edge as seen.
    const flipped = signatureInField(field, 3, 180);
    expect(boundsOf(flipped).map((v) => Math.round(v * 1e9) / 1e9)).toEqual([140, 100, 260, 140]);
    const [, , br, bl] = corners(flipped);
    expect(br[1]).toBeCloseTo(100, 9);
    expect(bl[1]).toBeCloseTo(100, 9);
    expect(Object.is(signatureInField(tall, 3, 90)[0], -0)).toBe(false);
  });

  it("rectMatrix maps the unit square onto the rect", () => {
    const m = rectMatrix([10, 20, 110, 70]);
    expect(m).toEqual([100, 0, 0, 50, 10, 20]);
    expect(boundsOf(m)).toEqual([10, 20, 110, 70]);
  });
});

// ---------------------------------------------------------------------------------------------
// Dates

describe("dates", () => {
  const d = new Date(2026, 9, 16);
  it("Italian is it-IT; English is day first unless the first English language is en-US", () => {
    expect(dateText(d, "it", ["it-IT"])).toBe("16/10/2026");
    expect(dateText(d, "it", ["en-US"])).toBe("16/10/2026");
    expect(dateText(d, "en", ["en-US"])).toBe("10/16/2026");
    expect(dateText(d, "en", ["en-us", "en-GB"])).toBe("10/16/2026");
    expect(dateText(d, "en", ["en-GB"])).toBe("16/10/2026");
    expect(dateText(d, "en", ["it-IT", "en"])).toBe("16/10/2026");
    expect(dateText(d, "en", ["en"])).toBe("16/10/2026");
    expect(dateText(d, "en", ["en-GB", "en-US"])).toBe("16/10/2026");
    expect(dateText(d, "en", ["fr-FR"])).toBe("16/10/2026");
    expect(dateText(d, "en", [])).toBe("16/10/2026");
    expect(dateLocale("en", ["en-US-u-ca-gregory"])).toBe("en-US");
    expect(dateLocale("en", ["eng"])).toBe("en-GB");
  });
  it("long formats", () => {
    expect(dateText(d, "it", ["it-IT"], "long")).toBe("16 ottobre 2026");
    expect(dateText(d, "en", ["en-GB"], "long")).toBe("16 October 2026");
    expect(dateText(d, "en", ["en-US"], "long")).toBe("October 16, 2026");
    expect(dateText(new Date(2026, 2, 5), "en", ["en-GB"])).toBe("05/03/2026");
  });
  it("the local day, at midnight and just before the next", () => {
    expect(dateText(new Date(2026, 9, 16, 0, 0, 0, 0), "it", [])).toBe("16/10/2026");
    expect(dateText(new Date(2026, 9, 16, 23, 59, 59, 999), "it", [])).toBe("16/10/2026");
    expect(dateText(new Date(2027, 0, 1, 0, 0, 0, 0), "en", ["en-US"])).toBe("01/01/2027");
    expect(dateText(new Date(2026, 11, 31, 23, 59, 59, 999), "en", ["en-GB"], "long")).toBe("31 December 2026");
  });
  it("a field's own numeric date pattern", () => {
    const march = new Date(2026, 2, 5);
    expect(datePattern(d, "dd/mm/yyyy")).toBe("16/10/2026");
    expect(datePattern(d, "mm/dd/yy")).toBe("10/16/26");
    expect(datePattern(d, "yyyy-mm-dd")).toBe("2026-10-16");
    expect(datePattern(march, "d.m.yyyy")).toBe("5.3.2026");
    expect(datePattern(march, "DD/MM/YYYY")).toBe("05/03/2026");
    for (const p of ["mmm d, yyyy", "dd mmmm yyyy", "HH:MM", "dd/mm/yyyy HH:MM", "ddd", "yyy", "", "--"]) expect(datePattern(d, p), p).toBeNull();
  });
  it("labels that ask for a date", () => {
    for (const s of ["Data di nascita", "Date of birth", "nato il", "Nata il", "data_nascita", "birthDate", "DATA"]) expect(looksLikeDate(s), s).toBe(true);
    for (const s of ["Nome", "Database", "Candidate", "Update", "Dati anagrafici"]) expect(looksLikeDate(s), s).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Handwriting fonts

/** Width of the sample text per font: what a canvas would measure (all different). */
const FONT_WIDTHS: Record<string, number> = {
  "Segoe Script": 700, "Ink Free": 610, "Segoe Print": 690, "Comic Sans MS": 640, Gabriola: 450, "MV Boli": 655,
  "Snell Roundhand": 560, "Savoye LET": 430, "Bradley Hand": 580, "Apple Chancery": 600, Zapfino: 900,
  "Dancing Script": 520, "Times New Roman": 500, Arial: 530, "Courier New": 720, Times: 505, Helvetica: 535,
  Courier: 725, Roboto: 525, "Noto Serif": 510, "Droid Sans Mono": 730, "DejaVu Serif": 515, "DejaVu Sans": 545, "DejaVu Sans Mono": 735,
};

interface FakeSystem {
  installed: string[];
  serif: string;
  sans: string;
  mono: string;
  cursive: string;
}

/** A browser's font matching: the first family of the list that is installed (generic names map to the system's). */
function fakeMeasure(system: FakeSystem) {
  return (font: string) => {
    const families = font.replace(/^\s*[\d.]+px\s+/, "").split(",").map((f) => f.trim().replace(/^"(.*)"$/, "$1"));
    const generic: Record<string, string> = { serif: system.serif, "sans-serif": system.sans, monospace: system.mono, cursive: system.cursive };
    for (const f of families) {
      const name = generic[f] ?? (system.installed.includes(f) ? f : null);
      if (name) return FONT_WIDTHS[name];
    }
    return FONT_WIDTHS[system.serif];
  };
}

const WINDOWS: FakeSystem = {
  installed: ["Segoe Script", "Ink Free", "Segoe Print", "Gabriola", "Comic Sans MS", "MV Boli", "Times New Roman", "Arial", "Courier New"],
  serif: "Times New Roman", sans: "Arial", mono: "Courier New", cursive: "Comic Sans MS",
};
const MAC: FakeSystem = {
  installed: ["Snell Roundhand", "Savoye LET", "Bradley Hand", "Apple Chancery", "Zapfino", "Times", "Helvetica", "Courier"],
  serif: "Times", sans: "Helvetica", mono: "Courier", cursive: "Apple Chancery",
};

describe("handwriting fonts", () => {
  it("Windows: Segoe Script, Ink Free, Segoe Print; cursive (Comic Sans MS) is never offered", () => {
    expect(detectHandwritingFonts(fakeMeasure(WINDOWS))).toEqual(['"Segoe Script"', '"Ink Free"', '"Segoe Print"']);
    const fewer = { ...WINDOWS, installed: WINDOWS.installed.filter((f) => f !== "Segoe Script" && f !== "Segoe Print") };
    expect(detectHandwritingFonts(fakeMeasure(fewer))).toEqual(['"Ink Free"']);
  });
  it("Mac: Snell Roundhand, Savoye LET, Bradley Hand; at most 3", () => {
    expect(detectHandwritingFonts(fakeMeasure(MAC))).toEqual(['"Snell Roundhand"', '"Savoye LET"', '"Bradley Hand"']);
    // cursive is Apple Chancery, already chosen: no second copy of it.
    const two = { ...MAC, installed: ["Snell Roundhand", "Apple Chancery", "Times", "Helvetica", "Courier"] };
    expect(detectHandwritingFonts(fakeMeasure(two))).toEqual(['"Snell Roundhand"', '"Apple Chancery"']);
  });
  it("Android: the generic cursive (Dancing Script)", () => {
    const android: FakeSystem = { installed: ["Roboto", "Noto Serif", "Droid Sans Mono"], serif: "Noto Serif", sans: "Roboto", mono: "Droid Sans Mono", cursive: "Dancing Script" };
    expect(detectHandwritingFonts(fakeMeasure(android))).toEqual(["cursive"]);
  });
  it("none: cursive is only the default sans or serif", () => {
    const linux: FakeSystem = { installed: ["DejaVu Serif", "DejaVu Sans", "DejaVu Sans Mono"], serif: "DejaVu Serif", sans: "DejaVu Sans", mono: "DejaVu Sans Mono", cursive: "DejaVu Sans" };
    expect(detectHandwritingFonts(fakeMeasure(linux))).toEqual([]);
    expect(detectHandwritingFonts(fakeMeasure({ ...linux, cursive: "DejaVu Serif" }))).toEqual([]);
  });
  it("Comic Sans MS and Gabriola are excluded as cursive", () => {
    const comic: FakeSystem = { ...WINDOWS, installed: ["Comic Sans MS", "Gabriola", "Times New Roman", "Arial", "Courier New"] };
    expect(detectHandwritingFonts(fakeMeasure(comic))).toEqual([]);
    expect(detectHandwritingFonts(fakeMeasure({ ...comic, cursive: "Gabriola" }))).toEqual([]);
  });

  it("availableHandwritingFonts measures on a canvas; no canvas or a failing one gives none", () => {
    const measure = fakeMeasure(WINDOWS);
    vi.stubGlobal("OffscreenCanvas", class {
      getContext() {
        return { font: "10px sans-serif", measureText(this: { font: string }) { return { width: measure(this.font) }; } };
      }
    });
    expect(availableHandwritingFonts()).toEqual(['"Segoe Script"', '"Ink Free"', '"Segoe Print"']);
    vi.stubGlobal("OffscreenCanvas", class {
      getContext() { return { set font(_f: string) { throw new Error("no fonts"); }, measureText: () => ({ width: 0 }) }; }
    });
    expect(availableHandwritingFonts()).toEqual([]);
    vi.stubGlobal("OffscreenCanvas", undefined);
    expect(availableHandwritingFonts()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Signature from a photo: the prototype's synthetic photos at 800 × 500, JPEG through MuPDF

/** Deterministic noise. */
function noise(seed: number) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const gauss = () => {
    let u = 0, v = 0;
    while (!u) u = rnd();
    while (!v) v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  return { rnd, gauss };
}

/** Coverage (0..1) of a made-up signature: loops, an underline flourish and an i's dot, for a W × H photo (scaled from 1600 × 1000). */
function signatureCoverage(W: number, H: number) {
  const k = W / 1600;
  const cov = new Float32Array(W * H);
  const stamp = (cx: number, cy: number, r: number) => {
    for (let y = Math.floor(cy - r - 1); y <= Math.ceil(cy + r + 1); y++) {
      for (let x = Math.floor(cx - r - 1); x <= Math.ceil(cx + r + 1); x++) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const a = Math.max(0, Math.min(1, r + 0.5 - Math.hypot(x + 0.5 - cx, y + 0.5 - cy)));
        if (a > cov[y * W + x]) cov[y * W + x] = a;
      }
    }
  };
  for (let t = 0; t <= 1; t += 0.00005) {
    const x = 300 + 900 * t + 60 * Math.sin(t * 2 * Math.PI * 7);
    const y = 520 - 110 * Math.sin(t * 2 * Math.PI * 7 + 1) * (0.6 + 0.4 * Math.sin(t * 9)) - 60 * t;
    stamp(x * k, y * k, (2.6 + 1.6 * Math.abs(Math.sin(t * 40))) * k);
  }
  for (let t = 0; t <= 1; t += 0.0001) stamp((260 + 1050 * t) * k, (650 + 30 * Math.sin(t * Math.PI) - 40 * t * t) * k, (2.4 + 1.2 * t) * k);
  stamp(900 * k, 330 * k, 6 * k);
  return { cov, dot: [Math.round(900 * k), Math.round(330 * k)] as [number, number] };
}

interface PhotoCase {
  paper?: number;
  gradient?: number;
  shadow?: boolean;
  ink?: [number, number, number];
  darkness?: number;
  ruled?: boolean;
  darkLine?: boolean;
  grid?: number;
  gridColor?: [number, number, number];
  dust?: number;
  noise?: number;
  empty?: boolean;
  q?: number;
}

/** Paint a photo: paper, light, shadow, lines, ink, noise and dust; returns RGB and which pixels are printed lines. */
function paint(W: number, H: number, cov: Float32Array, o: PhotoCase) {
  const k = W / 1600;
  const { rnd, gauss } = noise(12345);
  const rgb = new Uint8ClampedArray(W * H * 3);
  const line = new Uint8Array(W * H);
  const tint = [1, 0.99, 0.96];
  const ink = o.ink ?? [30, 30, 40], darkness = o.darkness ?? 1, paper = o.paper ?? 225, gradient = o.gradient ?? 0;
  const gridColor = o.gridColor ?? [0.8, 0.86, 0.97];
  const lineY = 700 * k, lineHalf = Math.max(0.75, 1.5 * k), gridWidth = Math.max(1, Math.round(2 * k));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      let p = paper * (1 - gradient * ((0.55 * x) / W + (0.45 * y) / H));
      if (o.shadow) p *= 1 - 0.45 * Math.exp(-(((x - 1100 * k) / (380 * k)) ** 2 + ((y - 600 * k) / (260 * k)) ** 2));
      let c = [p * tint[0], p * tint[1], p * tint[2]];
      const onRule = Math.abs(y - lineY) < lineHalf && x > 150 * k && x < 1450 * k;
      if (o.ruled && onRule) { c = c.map((v) => v * 0.82); line[i] = 1; }
      if (o.grid && (x % o.grid < gridWidth || y % o.grid < gridWidth)) { c = c.map((v, j) => v * gridColor[j]); line[i] = 1; }
      if (o.darkLine && onRule) { c = c.map((v) => v * 0.25); line[i] = 1; }
      const a = (o.empty ? 0 : cov[i]) * darkness;
      c = c.map((v, j) => v * (1 - a) + (ink[j] / 255) * v * a);
      for (let j = 0; j < 3; j++) rgb[i * 3 + j] = c[j] + gauss() * (o.noise ?? 4);
    }
  }
  for (let n = 0; n < (o.dust ?? 0); n++) {
    const cx = Math.floor(rnd() * W), cy = Math.floor(rnd() * H), r = 1 + Math.floor(rnd() * 2);
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if (x < 0 || y < 0 || x >= W || y >= H || (x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
        for (let j = 0; j < 3; j++) rgb[(y * W + x) * 3 + j] *= 0.35;
      }
    }
  }
  return { rgb, line };
}

/** As a phone's photo arrives: JPEG, decoded again, as RGBA. */
function throughJpeg(rgb: Uint8ClampedArray, W: number, H: number, quality: number): Uint8ClampedArray {
  const pm = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, W, H], false);
  let jpeg: Uint8Array;
  try {
    pm.getPixels().set(rgb);
    jpeg = pm.asJPEG(quality, false).slice();
  } finally {
    pm.destroy();
  }
  const img = new mupdf.Image(jpeg);
  try {
    const out = img.toPixmap();
    try {
      const n = out.getNumberOfComponents() + (out.getAlpha() ? 1 : 0);
      const px = out.getPixels();
      const rgba = new Uint8ClampedArray(W * H * 4);
      for (let i = 0; i < W * H; i++) {
        rgba[4 * i] = px[i * n];
        rgba[4 * i + 1] = px[i * n + 1];
        rgba[4 * i + 2] = px[i * n + 2];
        rgba[4 * i + 3] = 255;
      }
      return rgba;
    } finally {
      out.destroy();
    }
  } finally {
    img.destroy();
  }
}

const PW = 800, PH = 500;
const SIG = signatureCoverage(PW, PH);
/** Pixels within 3 px of the ink: not counted as background. */
const NEAR_INK = (() => {
  const near = new Uint8Array(PW * PH);
  for (let i = 0; i < PW * PH; i++) {
    if (!(SIG.cov[i] > 0)) continue;
    const x = i % PW, y = (i - x) / PW;
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        const X = x + dx, Y = y + dy;
        if (X >= 0 && Y >= 0 && X < PW && Y < PH) near[Y * PW + X] = 1;
      }
    }
  }
  return near;
})();

function runCase(o: PhotoCase) {
  const { rgb, line } = paint(PW, PH, SIG.cov, o);
  const rgba = throughJpeg(rgb, PW, PH, o.q ?? 85);
  const res = extractInk(rgba, PW, PH);
  if (res.empty) return { res, recall: 0, background: 0, lineKept: null as number | null };
  let ink = 0, hit = 0, bg = 0, bgKept = 0, ln = 0, lnKept = 0;
  for (let i = 0; i < PW * PH; i++) {
    if (!o.empty && SIG.cov[i] > 0.8) { ink++; if (res.alpha[i] > 127) hit++; }
    if (!NEAR_INK[i] || o.empty) { bg++; if (res.alpha[i] > 25) bgKept++; }
    if (line[i] && !NEAR_INK[i]) { ln++; if (res.alpha[i] > 25) lnKept++; }
  }
  return { res, recall: hit / Math.max(1, ink), background: bgKept / bg, lineKept: ln ? lnKept / ln : null };
}

describe("extractInk on synthetic photos (800 × 500)", () => {
  const CASES: Record<string, PhotoCase> = {
    "A even light, black pen": { paper: 228, ink: [25, 25, 35] },
    "B gradient and shadow, blue pen": { paper: 240, gradient: 0.5, shadow: true, ink: [35, 55, 160], noise: 6 },
    "C B plus a ruled line, JPEG q70": { paper: 240, gradient: 0.5, shadow: true, ink: [35, 55, 160], noise: 8, ruled: true, q: 70 },
    "D faint pencil": { paper: 230, ink: [90, 90, 95], darkness: 0.55, noise: 5 },
    "F dim room": { paper: 120, gradient: 0.3, ink: [20, 20, 30], noise: 9, q: 75 },
    "G dust": { paper: 228, ink: [25, 25, 35], dust: 100, noise: 5 },
    "I light squared paper": { paper: 232, ink: [35, 55, 160], grid: 20, noise: 5 },
    "J dark squared paper": { paper: 232, ink: [25, 25, 35], grid: 20, gridColor: [0.62, 0.7, 0.88], noise: 5, gradient: 0.3 },
  };
  for (const [name, o] of Object.entries(CASES)) {
    it(`${name}: ink kept, background and lines dropped, the i's dot kept`, () => {
      const { res, recall, background, lineKept } = runCase(o);
      expect(res.empty).toBe(false);
      const found = res as FoundInk;
      expect(recall).toBeGreaterThanOrEqual(0.99);
      expect(background).toBeLessThanOrEqual(0.001);
      if (lineKept !== null) expect(lineKept).toBeLessThanOrEqual(0.01);
      expect(found.alpha[SIG.dot[1] * PW + SIG.dot[0]]).toBeGreaterThan(127);
      // The box holds the signature (about x 128..657, y 162..342) and its margin, not much more:
      // dust far away does not stretch it.
      const [x0, y0, x1, y1] = found.box;
      expect(x0).toBeGreaterThan(70);
      expect(x1).toBeLessThan(720);
      expect(y0).toBeGreaterThan(100);
      expect(y1).toBeLessThan(410);
    });
  }

  it("the pen's colour is kept: a blue pen comes out blue", () => {
    const { res } = runCase(CASES["B gradient and shadow, blue pen"]);
    const [r, g, b] = (res as FoundInk).ink;
    expect(b).toBeGreaterThan(r + 40);
    expect(b).toBeGreaterThan(g + 25);
  });

  it("E an empty sheet with a shadow: nothing found", () => {
    expect(runCase({ paper: 235, gradient: 0.5, shadow: true, empty: true, noise: 6 }).res.empty).toBe(true);
    const white = new Uint8ClampedArray(PW * PH * 4).fill(240);
    expect(extractInk(white, PW, PH).empty).toBe(true);
    expect(extractInk(new Uint8ClampedArray(0), 0, 0).empty).toBe(true);
  });

  it("H a dark printed line under the signature is kept, and the crop takes it out", () => {
    const { res, recall } = runCase({ paper: 228, ink: [25, 25, 35], darkLine: true });
    expect(res.empty).toBe(false);
    expect(recall).toBeGreaterThanOrEqual(0.99);
    const found = res as FoundInk;
    expect(found.alpha[350 * PW + 400]).toBeGreaterThan(127); // the line, away from the ink: kept
    const crop: Rect = [found.box[0], found.box[1], found.box[2], 345];
    const painted = paintInk(found, "black", crop)!;
    expect(painted.height).toBeLessThanOrEqual(345 - found.box[1]);
    expect(painted.width).toBeLessThan(found.box[2] - found.box[0] + 1);
  });

  it("about 1.6 megapixels in under a second", () => {
    const W = 1600, H = 1000;
    const { cov } = signatureCoverage(W, H);
    const { rgb } = paint(W, H, cov, { paper: 228, ink: [25, 25, 35] });
    const rgba = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      rgba[4 * i] = rgb[3 * i];
      rgba[4 * i + 1] = rgb[3 * i + 1];
      rgba[4 * i + 2] = rgb[3 * i + 2];
      rgba[4 * i + 3] = 255;
    }
    extractInk(rgba.subarray(0, 64 * 64 * 4), 64, 64); // warm up the JIT
    const t0 = performance.now();
    const res = extractInk(rgba, W, H);
    const ms = performance.now() - t0;
    expect(res.empty).toBe(false);
    expect(ms).toBeLessThan(1000);
  });
});

/** What a synthetic photo holds besides the signature (closeUp). */
interface PhotoPaper {
  /** Ruled or squared paper: lines every `ruled` or `grid` px, `lineW` px thick (2), tilted by `tilt` degrees. */
  ruled?: number;
  grid?: number;
  tilt?: number;
  lineW?: number;
  /** A sheet that is not flat: its level lines bow by this many px in the middle. */
  sag?: number;
  /** Straight strokes of the pen besides the signature (a slanted hand), `darkness` of the ink's. */
  strokes?: { from: [number, number]; to: [number, number]; half: number; darkness: number }[];
  /** The paper's texture: this many short, light, curved fibres all over (or the grain of a table). */
  fibres?: number;
}

/**
 * A synthetic photo of the made-up signature filling `fill` of its width, its pen `pen` times as
 * thick: a close-up (the ink over 6 % of the photo), as a phone held near the sheet or a photo
 * already cropped in the gallery gives, or a phone's whole frame (4:3, the ink about 3 %). The
 * ink's darkness varies along the stroke between 1 − `vary` and 1 (a ballpoint is lighter where
 * the hand moved fast). On plain, ruled or squared paper, with more strokes or a texture
 * (PhotoPaper). Returns the photo and which pixels are ink (`cov`, `shade`), the extra strokes
 * (`extra`), and printed lines or fibres (`line`).
 */
function closeUp(W: number, H: number, o: { fill: number; pen: number; vary: number } & PhotoPaper) {
  const k = (o.fill * W) / 1070; // the signature spans about 1070 of the 1600 units of signatureCoverage
  const ox = 775 * k - W / 2, oy = 500 * k - H / 2;
  const cov = new Float32Array(W * H), shade = new Float32Array(W * H), extra = new Uint8Array(W * H);
  const stamp = (cx: number, cy: number, r: number, d: number, more = false) => {
    for (let y = Math.floor(cy - r - 1); y <= Math.ceil(cy + r + 1); y++) {
      for (let x = Math.floor(cx - r - 1); x <= Math.ceil(cx + r + 1); x++) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const a = Math.max(0, Math.min(1, r + 0.5 - Math.hypot(x + 0.5 - cx, y + 0.5 - cy)));
        if (a > cov[y * W + x]) {
          cov[y * W + x] = a;
          shade[y * W + x] = d;
          extra[y * W + x] = more ? 1 : 0;
        }
      }
    }
  };
  const darkness = (t: number) => 1 - o.vary * (0.5 + 0.5 * Math.sin(t * 2 * Math.PI * 5));
  for (let t = 0; t <= 1; t += 0.00005) {
    const x = 300 + 900 * t + 60 * Math.sin(t * 2 * Math.PI * 7);
    const y = 520 - 110 * Math.sin(t * 2 * Math.PI * 7 + 1) * (0.6 + 0.4 * Math.sin(t * 9)) - 60 * t;
    stamp(x * k - ox, y * k - oy, o.pen * (2.6 + 1.6 * Math.abs(Math.sin(t * 40))) * k, darkness(t));
  }
  for (let t = 0; t <= 1; t += 0.0001) {
    stamp((260 + 1050 * t) * k - ox, (650 + 30 * Math.sin(t * Math.PI) - 40 * t * t) * k - oy, o.pen * (2.4 + 1.2 * t) * k, darkness(t * 0.7 + 0.1));
  }
  stamp(900 * k - ox, 330 * k - oy, 6 * k, 1);
  for (const s of o.strokes ?? []) {
    const length = Math.hypot(s.to[0] - s.from[0], s.to[1] - s.from[1]);
    for (let u = 0; u <= length; u += 0.25) {
      stamp(s.from[0] + ((s.to[0] - s.from[0]) * u) / length, s.from[1] + ((s.to[1] - s.from[1]) * u) / length, s.half, s.darkness, true);
    }
  }
  // Fibres: their own noise, so that the photos without them stay the same.
  const fibre = new Float32Array(W * H);
  if (o.fibres) {
    const { rnd } = noise(4242);
    for (let f = 0; f < o.fibres; f++) {
      const cx = rnd() * W, cy = rnd() * H, length = 30 + rnd() * 60, angle = rnd() * Math.PI, bend = (rnd() - 0.5) * 30;
      const dx = Math.cos(angle), dy = Math.sin(angle);
      for (let u = -length / 2; u <= length / 2; u += 0.5) {
        const off = bend * (1 - ((2 * u) / length) ** 2);
        const px = cx + dx * u - dy * off, py = cy + dy * u + dx * off;
        for (let y = Math.floor(py - 2); y <= Math.ceil(py + 2); y++) {
          for (let x = Math.floor(px - 2); x <= Math.ceil(px + 2); x++) {
            if (x < 0 || y < 0 || x >= W || y >= H) continue;
            const a = Math.max(0, Math.min(1, 1.5 - Math.hypot(x + 0.5 - px, y + 0.5 - py)));
            if (a > 0.5) fibre[y * W + x] = Math.max(fibre[y * W + x], 0.9 * a);
          }
        }
      }
    }
  }
  const { gauss } = noise(777);
  const slope = Math.tan(((o.tilt ?? 0) * Math.PI) / 180);
  const lineW = o.lineW ?? 2;
  const onRule = (v: number, every: number) => ((v % every) + every) % every < lineW;
  const rgb = new Uint8ClampedArray(W * H * 3), line = new Uint8Array(W * H);
  const ink = [35, 55, 160], paper = 232, lineColour = [0.55, 0.62, 0.8]; // a blue ballpoint; blue-grey lines, lighter
  for (let i = 0; i < W * H; i++) {
    const x = i % W, y = (i - x) / W;
    const bow = o.sag ? o.sag * Math.sin((Math.PI * x) / W) : 0;
    const ruled = (o.ruled && onRule(y - bow - x * slope, o.ruled)) ||
      (o.grid && (onRule(y - bow - x * slope, o.grid) || onRule(x + y * slope, o.grid)));
    if (ruled || fibre[i]) line[i] = 1;
    const a = cov[i] * shade[i];
    for (let j = 0; j < 3; j++) {
      const p = ruled ? paper * lineColour[j] : paper * (1 - fibre[i] * (1 - lineColour[j]));
      rgb[3 * i + j] = p * (1 - a) + (ink[j] / 255) * p * a + gauss() * 4;
    }
  }
  return { rgba: throughJpeg(rgb, W, H, 85), cov, shade, extra, line };
}

/**
 * extractInk on a closeUp photo: the ink kept (all of it, its lighter part, and the extra
 * strokes), the printed lines or fibres left (away from the ink), the box found and how long it
 * took.
 */
function measurePhoto(W: number, H: number, o: Parameters<typeof closeUp>[2]) {
  const { rgba, cov, shade, extra, line } = closeUp(W, H, o);
  const t0 = performance.now();
  const res = extractInk(rgba, W, H);
  const ms = performance.now() - t0;
  expect(res.empty).toBe(false);
  const found = res as FoundInk;
  const near = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    if (!(cov[i] > 0)) continue;
    const x = i % W, y = (i - x) / W;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      if (x + dx >= 0 && y + dy >= 0 && x + dx < W && y + dy < H) near[(y + dy) * W + x + dx] = 1;
    }
  }
  let ink = 0, hit = 0, light = 0, lightHit = 0, more = 0, moreHit = 0, lines = 0, linesKept = 0, solid = 0;
  for (let i = 0; i < W * H; i++) {
    if (cov[i] > 0.8) {
      const kept = found.alpha[i] > 127;
      if (extra[i]) {
        more++;
        if (kept) moreHit++;
      } else {
        ink++;
        if (kept) hit++;
        if (shade[i] < 1 - 0.6 * o.vary) {
          light++;
          if (kept) lightHit++;
        }
      }
    }
    if (cov[i] > 0) solid++;
    if (line[i] && !near[i]) {
      lines++;
      if (found.alpha[i] > 25) linesKept++;
    }
  }
  return {
    recall: hit / ink, light: light ? lightHit / light : 1, extra: more ? moreHit / more : 1,
    lines: lines ? linesKept / lines : 0, coverage: solid / (W * H), box: found.box, ms,
  };
}

describe("extractInk on close-ups (2:1, the ink over 6 % of the photo)", () => {
  const W = 1000, H = 500;
  const measure = (o: Parameters<typeof closeUp>[2]) => measurePhoto(W, H, o);

  for (const vary of [0.25, 0.45]) {
    it(`a gel pen whose darkness varies by ${vary * 100} %: every stroke kept, its lighter parts too`, () => {
      // Before, a second threshold split the ink itself: about 60 % of it was kept, the lighter
      // parts not at all.
      const m = measure({ fill: 0.9, pen: 2, vary });
      expect(m.coverage).toBeGreaterThan(0.06);
      expect(m.recall).toBeGreaterThanOrEqual(0.99);
      expect(m.light).toBeGreaterThanOrEqual(0.98);
    });
  }

  it("on ruled paper, a little askew: the lines go, the ink with its lighter parts stays", () => {
    for (const tilt of [3, -5]) {
      const m = measure({ fill: 0.9, pen: 2, vary: 0.25, ruled: 70, tilt });
      expect(m.lines, `tilt ${tilt}`).toBeLessThanOrEqual(0.01);
      expect(m.recall, `tilt ${tilt}`).toBeGreaterThanOrEqual(0.99);
      expect(m.light, `tilt ${tilt}`).toBeGreaterThanOrEqual(0.97);
    }
  });

  it("on squared paper: the grid goes, the ink stays", () => {
    const m = measure({ fill: 0.9, pen: 2, vary: 0.25, grid: 40, tilt: 2 });
    expect(m.lines).toBeLessThanOrEqual(0.01);
    expect(m.recall).toBeGreaterThanOrEqual(0.99);
  });

  it("on squared or ruled paper well askew (10 to 15°, and 40°): the lines go", () => {
    // Before, lines were looked for within 7°: at 10° the whole grid stayed, and the crop was the
    // whole photo.
    for (const paper of [{ grid: 40, tilt: 10 }, { grid: 40, tilt: 14 }, { ruled: 70, tilt: 12 }, { ruled: 70, tilt: -15 }, { grid: 40, tilt: 40 }]) {
      const m = measure({ fill: 0.9, pen: 2, vary: 0.25, ...paper });
      const what = JSON.stringify(paper);
      expect(m.lines, what).toBeLessThanOrEqual(0.01);
      expect(m.recall, what).toBeGreaterThanOrEqual(0.99);
      expect(m.light, what).toBeGreaterThanOrEqual(0.97);
      expect(m.box[3] - m.box[1], what).toBeLessThan(400); // the signature's (about 370), not the photo's 500
    }
  });

  it("on a sheet that is not flat (the lines bowed 25 and 40 px) and on thicker lines (8 px): the lines go", () => {
    for (const paper of [{ ruled: 70, sag: 25 }, { ruled: 70, sag: 40, tilt: 4 }, { ruled: 70, lineW: 8 }, { ruled: 70, lineW: 8, tilt: 12 }]) {
      const m = measure({ fill: 0.9, pen: 2, vary: 0.25, ...paper });
      const what = JSON.stringify(paper);
      expect(m.lines, what).toBeLessThanOrEqual(0.01);
      expect(m.recall, what).toBeGreaterThanOrEqual(0.99);
      expect(m.light, what).toBeGreaterThanOrEqual(0.97);
    }
  });

  it("the parallel strokes of a slanted hand are not ruled paper: kept whole, lighter as they are", () => {
    // Four and six straight strokes, 14° from upright, over 70 % of the photo's height, a little
    // lighter than the ink's core: parallel, but only inside the signature.
    for (const count of [4, 6]) {
      const strokes = Array.from({ length: count }, (_, i) => ({
        from: [300 + 60 * i, 75] as [number, number], to: [387 + 60 * i, 425] as [number, number], half: 2, darkness: 0.7,
      }));
      const m = measure({ fill: 0.9, pen: 2, vary: 0.25, strokes });
      expect(m.extra, `${count} strokes`).toBeGreaterThanOrEqual(0.99);
      expect(m.recall, `${count} strokes`).toBeGreaterThanOrEqual(0.99);
    }
  });

  it("on paper with a texture all over (fibres): it goes, the crop is the signature's", () => {
    const m = measure({ fill: 0.9, pen: 2, vary: 0.25, fibres: 600 });
    expect(m.lines).toBeLessThanOrEqual(0.06); // the fibres touching the strokes stay
    expect(m.recall).toBeGreaterThanOrEqual(0.99);
    expect(m.box[3] - m.box[1]).toBeLessThan(400);
  });
});

describe("extractInk on a phone's whole frame (4:3, the ink about 3 %)", () => {
  const W = 1600, H = 1200;
  const measure = (o: PhotoPaper) => measurePhoto(W, H, { fill: 0.9, pen: 1, vary: 0.25, ...o });
  /** The signature's box is about 1536 × 589: the crop must not take the whole photo. */
  const signatureSized = (box: Rect) => box[3] - box[1] < 700;

  it("squared and ruled paper held askew, a sheet that is not flat, thick rules: the lines go", () => {
    // Before, tilted by 10° or more the whole grid stayed (100 % of it, the crop 1600 × 1200).
    for (const paper of [
      { grid: 50, tilt: 12 }, { grid: 130, lineW: 3, tilt: 15, sag: 30 }, { ruled: 60, lineW: 3, tilt: 10, sag: 30 },
      { ruled: 60, lineW: 8 },
    ]) {
      const m = measure(paper);
      const what = JSON.stringify(paper);
      expect(m.lines, what).toBeLessThanOrEqual(0.01);
      expect(m.recall, what).toBeGreaterThanOrEqual(0.99);
      expect(m.light, what).toBeGreaterThanOrEqual(0.97);
      expect(signatureSized(m.box), `${what}: ${m.box}`).toBe(true);
      expect(m.ms, what).toBeLessThan(2000); // about 0.3 s in Node
    }
  });

  it("paper with a texture all over: away from the ink it goes", () => {
    const m = measure({ fibres: 1500 });
    expect(m.lines).toBeLessThanOrEqual(0.04);
    expect(m.recall).toBeGreaterThanOrEqual(0.99);
    expect(signatureSized(m.box)).toBe(true);
  });
});

describe("paintInk and trim", () => {
  /** A found ink of 10 × 6 with a 2 × 2 blot at (4, 2) and a faint pixel at (8, 5). */
  function blot(): FoundInk {
    const alpha = new Uint8ClampedArray(60);
    for (const [x, y] of [[4, 2], [5, 2], [4, 3], [5, 3]]) alpha[y * 10 + x] = 255;
    alpha[5 * 10 + 8] = 100;
    alpha[0] = 20; // under the 0.1 threshold: not ink
    return { empty: false, width: 10, height: 6, alpha, box: [0, 0, 10, 6], ink: [10, 20, 30], threshold: 0.2 };
  }

  it("paints the pen's colour or the one chosen, straight alpha, trimmed to the ink in the crop", () => {
    const own = paintInk(blot(), null)!;
    expect([own.width, own.height]).toEqual([5, 4]); // x 4..8, y 2..5 (the margin rounds to 0)
    expect(Array.from(own.rgba.subarray(0, 4))).toEqual([10, 20, 30, 255]);
    const blue = paintInk(blot(), "blue", [0, 0, 7, 6])!;
    expect([blue.width, blue.height]).toEqual([2, 2]);
    expect(Array.from(blue.rgba.subarray(0, 4))).toEqual([...INK_RGB.blue, 255]);
    expect(paintInk(blot(), "black", [7, 0, 8, 4])).toBeNull();
    expect(paintInk(blot(), "black", [-100, -100, 1000, 1000])).not.toBeNull();
  });

  it("trim: cut to alpha over the threshold, margins (transparent past the edge), pixels unchanged", () => {
    const w = 6, h = 4;
    const rgba = new Uint8ClampedArray(w * h * 4);
    const set = (x: number, y: number, px: number[]) => rgba.set(px, (y * w + x) * 4);
    set(1, 1, [31, 59, 148, 128]);
    set(4, 2, [31, 59, 148, 255]);
    set(0, 3, [200, 0, 0, 8]); // at the threshold: not ink
    const cut = trim(rgba, w, h)!;
    expect([cut.width, cut.height, cut.box]).toEqual([4, 2, [1, 1, 5, 3]]);
    expect(Array.from(cut.rgba.subarray(0, 4))).toEqual([31, 59, 148, 128]);
    const wide = trim(rgba, w, h, { margin: 2 })!;
    expect([wide.width, wide.height, wide.box]).toEqual([8, 6, [-1, -1, 7, 5]]);
    // The source's (1, 1) is at (2, 2) in the cut; past the source's edge: transparent.
    expect(Array.from(wide.rgba.subarray((2 * 8 + 2) * 4, (2 * 8 + 2) * 4 + 4))).toEqual([31, 59, 148, 128]);
    expect(wide.rgba[3]).toBe(0);
    expect(trim(rgba, w, h, { threshold: 255 })).toBeNull();
    expect(trim(new Uint8ClampedArray(w * h * 4), w, h)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Strokes

const stroke = (pts: [number, number, number][], pressure?: number, scale = 1): Stroke => ({
  points: pts.map(([x, y, time]) => (pressure === undefined ? { x, y, time } : { x, y, time, pressure })),
  scale,
});

describe("strokePieces", () => {
  it("no point, nothing; one point, a dot of the middle width", () => {
    expect(strokePieces({ points: [], scale: 1 })).toEqual([]);
    expect(strokePieces(stroke([[Number.NaN, 1, 0]]))).toEqual([]);
    const dot = strokePieces(stroke([[10, 10, 0]]));
    expect(dot).toHaveLength(1);
    expect(dot[0]).toMatchObject({ from: [10, 10], to: [10, 10], w0: 1.5, w1: 1.5 });
  });

  it("a curve through the midpoints: n points, n pieces, joined end to start", () => {
    const pts: [number, number, number][] = [[0, 0, 0], [20, 0, 20], [40, 20, 40], [60, 20, 60], [80, 0, 80]];
    const pieces = strokePieces(stroke(pts));
    expect(pieces).toHaveLength(5);
    expect(pieces[0].from).toEqual([0, 0]);
    expect(pieces[4].to).toEqual([80, 0]);
    for (let i = 1; i < pieces.length; i++) expect(pieces[i].from).toEqual(pieces[i - 1].to);
    expect(pieces[1]).toMatchObject({ from: [10, 0], control: [20, 0], to: [30, 10] });
    for (let i = 1; i < pieces.length; i++) expect(pieces[i].w0).toBeCloseTo(pieces[i - 1].w1, 12);
  });

  it("points closer than 5 px are skipped, but the stroke still ends where the pen lifted", () => {
    const pieces = strokePieces(stroke([[0, 0, 0], [1, 0, 1], [2, 0, 2], [10, 0, 10], [11, 0, 11]]));
    // Kept: (0, 0), (10, 0), and the end (11, 0).
    expect(pieces).toHaveLength(3);
    expect(pieces[2].to).toEqual([11, 0]);
  });

  it("wide when slow, thin when fast, within the limits; a pen's pressure sets it directly", () => {
    const slow = strokePieces(stroke([[0, 0, 0], [10, 0, 1000], [20, 0, 2000], [30, 0, 3000]]));
    const fast = strokePieces(stroke([[0, 0, 0], [100, 0, 1], [200, 0, 2], [300, 0, 3]]));
    const last = (p: ReturnType<typeof strokePieces>) => p[p.length - 1].w1;
    expect(last(slow)).toBeGreaterThan(2.4);
    expect(last(slow)).toBeLessThanOrEqual(STROKE_OPTIONS.maxWidth);
    expect(last(fast)).toBeCloseTo(STROKE_OPTIONS.minWidth, 9);
    const pen = strokePieces(stroke([[0, 0, 0], [10, 0, 0], [20, 0, 0]], 0.25));
    for (const p of pen) {
      expect(p.w0).toBeCloseTo(1, 12);
      expect(p.w1).toBeCloseTo(1, 12);
    }
    // Points with the same time (coalesced events) give no NaN or infinite width.
    for (const p of strokePieces(stroke([[0, 0, 5], [10, 0, 5], [20, 0, 5]]))) {
      expect(Number.isFinite(p.w0) && Number.isFinite(p.w1)).toBe(true);
    }
  });

  it("drawPieces paints round dots along the curve, in one fill, inside piecesBounds", () => {
    const pieces = strokePieces(stroke([[0, 0, 0], [20, 0, 20], [40, 20, 40], [60, 20, 60]]));
    const arcs: number[][] = [];
    const fills: unknown[] = [];
    const ctx = {
      fillStyle: "" as any,
      beginPath() {},
      moveTo() {},
      arc(x: number, y: number, r: number) { arcs.push([x, y, r]); },
      fill() { fills.push(ctx.fillStyle); },
    };
    drawPieces(ctx, pieces, "rgb(31, 59, 148)", 2, [5, 5]);
    expect(fills).toEqual(["rgb(31, 59, 148)"]);
    expect(arcs.length).toBeGreaterThan(60);
    const b = piecesBounds(pieces);
    for (const [x, y, r] of arcs) {
      expect(x - r).toBeGreaterThanOrEqual(b[0] * 2 + 5 - 1e-9);
      expect(x + r).toBeLessThanOrEqual(b[2] * 2 + 5 + 1e-9);
      expect(y - r).toBeGreaterThanOrEqual(b[1] * 2 + 5 - 1e-9);
      expect(y + r).toBeLessThanOrEqual(b[3] * 2 + 5 + 1e-9);
    }
  });

  it("a pen's lift point, which has no pressure (pointerup reports 0), keeps the width: no blob at the end", () => {
    const body: [number, number, number][] = Array.from({ length: 20 }, (_, i) => [i * 6, 0, i * 4]);
    const half = STROKE_OPTIONS.minWidth + (STROKE_OPTIONS.maxWidth - STROKE_OPTIONS.minWidth) * 0.2; // 0.9
    for (const lift of [0.3, 3]) {
      const pen = stroke(body, 0.2);
      const pieces = strokePieces({ points: [...pen.points, { x: 114 + lift, y: 0, time: 80 }], scale: 1 });
      expect(pieces[pieces.length - 1].to).toEqual([114 + lift, 0]); // it still ends where the pen lifted
      for (const p of pieces) {
        expect(p.w0).toBeCloseTo(half, 9);
        expect(p.w1).toBeCloseTo(half, 9);
      }
    }
  });

  it("a stroke drawn while the pad showed the ink smaller: its speed as the hand moved, the others' line weight", () => {
    // The same motion of the hand on the screen, on a pad at its own size and on one showing the
    // ink at 0.44 (a phone turned upright after signing sideways): the points are stored 1 / 0.44
    // larger, the speed (so the width's changes) and the points kept are the hand's, and the
    // width is in pad px, as for the strokes drawn before: the PNG has one line weight (it was
    // 1 / 0.44 bolder).
    const motion: [number, number, number][] = [[0, 0, 0], [30, 10, 20], [60, 0, 40], [62, 1, 41], [90, 15, 60], [120, 0, 80]];
    const k = 0.44;
    const own = strokePieces(stroke(motion));
    const smaller = strokePieces(stroke(motion.map(([x, y, t]) => [x / k, y / k, t]), undefined, k));
    expect(smaller).toHaveLength(own.length);
    smaller.forEach((p: StrokePiece, i) => {
      expect(p.w0).toBeCloseTo(own[i].w0, 9);
      expect(p.w1).toBeCloseTo(own[i].w1, 9);
      expect(p.from[0] * k).toBeCloseTo(own[i].from[0], 9);
      expect(p.to[1] * k).toBeCloseTo(own[i].to[1], 9);
    });
  });

  it("fitScale: the scale at which the strokes show whole on a pad that shrank", () => {
    // Signed across a phone held sideways (an 812 × 150 pad), then the phone turned upright (356 × 260).
    const wide = [stroke([[20, 40, 0], [400, 100, 300], [790, 60, 600]])];
    const b = piecesBounds(wide.flatMap((s) => strokePieces(s)));
    expect(fitScale(wide, 812, 150)).toBe(1);
    expect(fitScale(wide, 356, 260)).toBeCloseTo(356 / b[2], 9);
    expect(fitScale(wide, 356, 30)).toBeCloseTo(30 / b[3], 9);
    expect(fitScale([], 356, 260)).toBe(1);
    expect(fitScale(wide, 0, 0)).toBe(1);
  });

  it("refitView: undoing the stroke that did not fit shows the rest at its size again; a stroke off the pad shrinks nothing", () => {
    // A small signature, then a long stroke while the pad was 356 px wide: the view went to fit it.
    const small = stroke([[20, 40, 0], [120, 60, 100], [200, 50, 200]]);
    const long = stroke([[20, 120, 400], [400, 130, 700], [790, 110, 1000]]);
    const view = fitScale([small, long], 356, 260);
    expect(view).toBeLessThan(0.5);
    expect(refitView([small], view, 356, 260)).toBe(1); // Undo: the small one fits at 1
    expect(refitView([], view, 356, 260)).toBe(1); // Clear
    // At 1, a stroke that ran off the right edge (pointer capture) leaves the view as it was.
    expect(refitView([small, long], 1, 356, 260)).toBe(1);
    // While the view is smaller, a new stroke inside the pad keeps it, at least.
    expect(refitView([small, long, stroke([[30, 200, 1200], [300, 210, 1300]])], view, 356, 260)).toBeCloseTo(view, 9);
    expect(refitView([small], view, 0, 0)).toBe(view); // its tab hidden: no size to fit
  });

  it("a tap is not a signature: inkExtent of a dot is 3 px, under MIN_INK_EXTENT; a short stroke is over it", () => {
    expect(inkExtent([])).toBe(0);
    expect(inkExtent([stroke([[50, 50, 0]])])).toBeCloseTo(3, 9);
    expect(inkExtent([stroke([[50, 50, 0]]), stroke([[52, 51, 300]])])).toBeLessThan(MIN_INK_EXTENT);
    expect(inkExtent([stroke([[50, 50, 0], [65, 50, 40]])])).toBeGreaterThanOrEqual(MIN_INK_EXTENT);
  });
});

// ---------------------------------------------------------------------------------------------
// The canvas layer, with a fake OffscreenCanvas

interface FakeCanvasLog {
  canvases: FakeCanvas[];
  encodes: { type: string; width: number; height: number }[];
}

class FakeContext {
  font = "10px sans-serif";
  fillStyle: unknown = "#000000";
  textBaseline = "alphabetic";
  imageSmoothingQuality = "low";
  arcs: number[][] = [];
  fills: unknown[] = [];
  texts: { text: string; x: number; y: number; font: string; fillStyle: unknown }[] = [];
  puts: { data: Uint8ClampedArray; width: number; height: number }[] = [];
  draws: unknown[][] = [];
  rects: unknown[][] = [];
  constructor(readonly canvas: FakeCanvas) {}
  beginPath() {}
  moveTo() {}
  arc(x: number, y: number, r: number) { this.arcs.push([x, y, r]); }
  fill() { this.fills.push(this.fillStyle); }
  fillRect(...args: unknown[]) { this.rects.push([this.fillStyle, ...args]); }
  /** Every character is half an em wide. */
  measureText(text: string) { return { width: text.length * 0.5 * parseFloat(this.font) }; }
  fillText(text: string, x: number, y: number) { this.texts.push({ text, x, y, font: this.font, fillStyle: this.fillStyle }); }
  /** The last text as a solid block: from 0.75 em above its baseline to 0.25 em below, as wide as it measures. */
  getImageData(_x: number, _y: number, w: number, h: number) {
    const data = new Uint8ClampedArray(w * h * 4);
    const t = this.texts[this.texts.length - 1];
    if (t) {
      const px = parseFloat(t.font);
      const x0 = Math.round(t.x), x1 = Math.round(t.x + this.measureText(t.text).width);
      const y0 = Math.round(t.y - 0.75 * px), y1 = Math.round(t.y + 0.25 * px);
      for (let y = Math.max(0, y0); y < Math.min(h, y1); y++)
        for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) data.set([31, 59, 148, 255], (y * w + x) * 4);
    }
    return { data, width: w, height: h };
  }
  createImageData(w: number, h: number) { return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h }; }
  putImageData(image: { data: Uint8ClampedArray; width: number; height: number }) { this.puts.push(image); }
  drawImage(...args: unknown[]) { this.draws.push(args); }
}

let canvasLog: FakeCanvasLog;

class FakeCanvas {
  ctx: FakeContext | null = null;
  constructor(public width: number, public height: number) {
    canvasLog.canvases.push(this);
  }
  getContext() {
    return (this.ctx ??= new FakeContext(this));
  }
  async convertToBlob(options: { type: string }) {
    canvasLog.encodes.push({ type: options.type, width: this.width, height: this.height });
    return new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: options.type });
  }
}

function fakeCanvas(): FakeCanvasLog {
  canvasLog = { canvases: [], encodes: [] };
  vi.stubGlobal("OffscreenCanvas", FakeCanvas);
  return canvasLog;
}

describe("renderStrokes", () => {
  it("painted again at 1200 px on its longer side, 4 % margin, in the ink's colour, as a PNG", async () => {
    const log = fakeCanvas();
    const strokes = [
      stroke([[20, 40, 0], [60, 20, 30], [100, 60, 60], [140, 30, 90], [180, 50, 120]]),
      stroke([[30, 80, 400], [170, 80, 600]]),
    ];
    const out = await renderStrokes(strokes, "blue");
    const b = piecesBounds(strokes.flatMap((s) => strokePieces(s)));
    const w = b[2] - b[0], h = b[3] - b[1];
    expect(out.width).toBe(SIGNATURE_MAX_SIDE);
    expect(out.height).toBe(Math.ceil((h + 0.08 * w) * (SIGNATURE_MAX_SIDE / (w + 0.08 * w))));
    expect(out.png.type).toBe("image/png");
    expect(log.encodes).toEqual([{ type: "image/png", width: out.width, height: out.height }]);
    const ctx = log.canvases[0].ctx!;
    expect(ctx.fills).toEqual(["rgb(31, 59, 148)"]);
    for (const [x, y, r] of ctx.arcs) {
      expect(x - r).toBeGreaterThan(0);
      expect(y - r).toBeGreaterThan(0);
      expect(x + r).toBeLessThan(out.width);
      expect(y + r).toBeLessThan(out.height);
    }
  });

  it("a few pixels are not blown up to 1200: at most 8 pixels per pad px", async () => {
    fakeCanvas();
    // A tap's dot (3 px across, with the margin 3.24 px): it was a disc 1200 px wide.
    const dot = await renderStrokes([stroke([[50, 50, 0]])], "black");
    expect([dot.width, dot.height]).toEqual([26, 26]);
    const log = fakeCanvas();
    const short = [stroke([[0, 0, 0], [40, 10, 100]])];
    const small = await renderStrokes(short, "black");
    const b = piecesBounds(short.flatMap((s) => strokePieces(s)));
    expect(small.width).toBe(Math.ceil((b[2] - b[0]) * 1.08 * 8));
    expect(log.encodes[0].width).toBe(small.width);
  });

  it("a smaller maxSide; nothing drawn is refused", async () => {
    fakeCanvas();
    const out = await renderStrokes([stroke([[0, 0, 0], [50, 100, 100]])], "black", 300);
    expect(out.height).toBe(300);
    await expect(renderStrokes([], "black")).rejects.toBeInstanceOf(NoInkError);
    await expect(renderStrokes([{ points: [], scale: 1 }], "black")).rejects.toBeInstanceOf(NoInkError);
  });
});

describe("renderTyped", () => {
  it("drawn at 120 px in the chosen font, trimmed to its ink with a 6 px margin", async () => {
    const log = fakeCanvas();
    const out = await renderTyped("  Mario Rossi ", '"Segoe Script"', "black");
    const ctx = log.canvases[0].ctx!;
    expect(ctx.texts).toEqual([{ text: "Mario Rossi", x: 72, y: 168, font: '120px "Segoe Script"', fillStyle: "rgb(0, 0, 0)" }]);
    // 11 characters × 60 px, 120 px tall (0.75 + 0.25 em), plus 6 px on each side.
    expect([out.width, out.height]).toEqual([660 + 12, 120 + 12]);
    expect(log.canvases[0].width).toBe(660 + 2 * 72);
    expect(log.canvases[0].height).toBe(264);
    const put = log.canvases[1].ctx!.puts[0];
    expect(Array.from(put.data.subarray(0, 4))).toEqual([0, 0, 0, 0]); // the margin
    expect(Array.from(put.data.subarray((6 * out.width + 6) * 4, (6 * out.width + 6) * 4 + 4))).toEqual([31, 59, 148, 255]);
    expect(log.encodes).toEqual([{ type: "image/png", width: 672, height: 132 }]);
  });

  it("a very long name: drawn smaller to keep the canvas small, then scaled to 1200 px", async () => {
    const log = fakeCanvas();
    const out = await renderTyped("M".repeat(100), "cursive", "blue");
    const ctx = log.canvases[0].ctx!;
    expect(ctx.texts[0].font).toBe("80px cursive");
    expect(log.canvases[0].width).toBe(4096);
    expect(out.width).toBe(1200);
    expect(log.encodes[log.encodes.length - 1].width).toBe(1200);
    expect(log.canvases[2].ctx!.draws).toHaveLength(1);
  });

  it("an empty name is refused", async () => {
    fakeCanvas();
    await expect(renderTyped("   ", "cursive", "black")).rejects.toBeInstanceOf(NoInkError);
  });
});

describe("initialsOf", () => {
  it("the initials the Sigla sheet starts with: particles left out, the surname never lost", () => {
    expect(initialsOf("Mario Rossi")).toBe("MR");
    expect(initialsOf("Jean-Luc de la Tour")).toBe("JLT");
    expect(initialsOf("Anna Maria De Luca Rossi")).toBe("AMDR");
    expect(initialsOf("José María García Márquez")).toBe("JMGM");
    expect(initialsOf("Ludwig van Beethoven")).toBe("LB");
    expect(initialsOf("Gianni D'Angelo")).toBe("GD");
    expect(initialsOf("J. R. R. Tolkien")).toBe("JRRT");
    expect(initialsOf("mario rossi")).toBe("MR"); // typed all in lower case: every word counts
    // Only known particles are left out, and never the first word: a given name typed in lower
    // case still counts (it gave "R").
    expect(initialsOf("maria Rossi")).toBe("MR");
    expect(initialsOf("mario ROSSI")).toBe("MR");
    expect(initialsOf("ana de la Cruz")).toBe("AC");
    expect(initialsOf("mario de rossi")).toBe("MR");
    expect(initialsOf("Maria de’ Medici")).toBe("MM");
    expect(initialsOf("Ursula von der Leyen")).toBe("UL");
    expect(initialsOf("de Gaulle")).toBe("DG");
    expect(initialsOf("ROSSI Mario")).toBe("RM");
    expect(initialsOf("李 小龙")).toBe("李小");
    expect(initialsOf("  élodie  ")).toBe("É");
    expect(initialsOf(" - ")).toBe("");
    expect(initialsOf("")).toBe("");
  });
});

describe("toPng, renderInk, photoPixels", () => {
  it("toPng puts the pixels as they are, scaled down only when over maxSide", async () => {
    const log = fakeCanvas();
    const rgba = new Uint8ClampedArray(4 * 3 * 4).fill(7);
    const small = await toPng(rgba, 4, 3);
    expect([small.width, small.height]).toEqual([4, 3]);
    expect(log.canvases[0].ctx!.puts[0].data).toEqual(rgba);
    const big = await toPng(new Uint8ClampedArray(2400 * 10 * 4), 2400, 10);
    expect([big.width, big.height]).toEqual([1200, 5]);
    expect(log.encodes.map((e) => [e.width, e.height])).toEqual([[4, 3], [1200, 5]]);
  });

  it("renderInk refuses a crop without ink", async () => {
    fakeCanvas();
    const alpha = new Uint8ClampedArray(100);
    alpha[55] = 255;
    const found: FoundInk = { empty: false, width: 10, height: 10, alpha, box: [5, 5, 6, 6], ink: [0, 0, 0], threshold: 0.2 };
    const out = await renderInk(found, "black");
    expect([out.width, out.height]).toEqual([1, 1]);
    await expect(renderInk(found, "black", [0, 0, 3, 3])).rejects.toBeInstanceOf(NoInkError);
  });

  it("photoPixels: upright, on white, at most 1600 px, the bitmap closed", async () => {
    const log = fakeCanvas();
    const bitmaps: { closed: boolean }[] = [];
    const orientations: unknown[] = [];
    vi.stubGlobal("createImageBitmap", async (_b: unknown, o: { imageOrientation?: string }) => {
      orientations.push(o?.imageOrientation);
      const bm = { width: 4000, height: 3000, closed: false, close() { bm.closed = true; } };
      bitmaps.push(bm);
      return bm;
    });
    const px = await photoPixels(new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }));
    expect([px.width, px.height]).toEqual([1600, 1200]);
    expect(px.rgba.length).toBe(1600 * 1200 * 4);
    expect(orientations).toEqual(["from-image"]);
    expect(bitmaps[0].closed).toBe(true);
    const ctx = log.canvases[0].ctx!;
    expect(ctx.rects[0]).toEqual(["#ffffff", 0, 0, 1600, 1200]);
    expect(ctx.draws[0].slice(1)).toEqual([0, 0, 1600, 1200]);
  });
});

// ---------------------------------------------------------------------------------------------
// Saved signatures (IndexedDB), with a small in-memory IndexedDB

type Sig = Parameters<typeof save>[0];

const signature = (id: string, extra: Partial<Sig> = {}): Sig => ({
  id, kind: "signature", png: new Blob([new Uint8Array([1, 2, 3, id.length])], { type: "image/png" }), width: 600, height: 200,
  description: "Firma", source: "draw", savedAt: null, ...extra,
});

/**
 * Enough of IndexedDB for signatureStore: open with an upgrade, one object store with a key
 * path, getAll / getAllKeys / put / delete, transactions that commit when their requests are done
 * and roll back on abort. Everything answers asynchronously, as the real one does.
 */
function fakeIndexedDB(mode: "ok" | "error" | "throw" | "hang" | "broken-tx" = "ok") {
  const stores = new Map<string, Map<string, unknown>>();
  let version = 0;
  const later = (f: () => void) => setTimeout(f, 0);
  const opened: { closed: boolean }[] = [];
  const factory = {
    open(_name: string, v: number) {
      if (mode === "throw") throw new DOMException("The operation is insecure.", "SecurityError");
      const req: any = {};
      later(() => {
        if (mode === "hang") return;
        if (mode === "error") {
          req.error = new DOMException("No storage", "UnknownError");
          req.onerror?.({ preventDefault() {} });
          return;
        }
        const db = makeDb();
        req.result = db;
        if (v > version) {
          version = v;
          req.onupgradeneeded?.();
        }
        req.onsuccess?.();
      });
      return req;
    },
  };
  function makeDb() {
    const db: any = {
      closed: false,
      objectStoreNames: { contains: (n: string) => stores.has(n) },
      createObjectStore(n: string) { stores.set(n, new Map()); },
      close() { db.closed = true; },
      transaction(name: string, txMode: string) {
        if (mode === "broken-tx") throw new DOMException("The database connection is closing.", "InvalidStateError");
        const data = stores.get(name);
        if (!data) throw new DOMException("No such store", "NotFoundError");
        const work = new Map(data);
        let pending = 0, aborted = false, finished = false;
        const tx: any = {
          abort() { aborted = true; later(() => tx.onabort?.()); },
          objectStore: () => store,
        };
        const finish = () => {
          if (pending || aborted || finished) return;
          finished = true;
          data.clear();
          for (const [k, v] of work) data.set(k, v);
          tx.oncomplete?.();
        };
        const request = (run: () => unknown) => {
          const req: any = {};
          pending++;
          later(() => {
            if (aborted) return;
            try {
              req.result = run();
            } catch (e) {
              req.error = e;
              aborted = true;
              req.onerror?.();
              tx.onerror?.();
              return;
            }
            req.onsuccess?.();
            pending--;
            later(finish);
          });
          return req;
        };
        const writable = () => { if (txMode !== "readwrite") throw new DOMException("Read only", "ReadOnlyError"); };
        const store = {
          getAll: () => request(() => [...work.values()]),
          getAllKeys: () => request(() => [...work.keys()]),
          put: (r: { id: string }) => { writable(); return request(() => { work.set(r.id, structuredClone(r)); return r.id; }); },
          delete: (id: string) => { writable(); return request(() => { work.delete(id); }); },
        };
        later(finish);
        return tx;
      },
    };
    opened.push(db);
    return db;
  }
  vi.stubGlobal("indexedDB", factory);
  return { stores, opened };
}

describe("signatureStore", () => {
  it("no IndexedDB: unavailable, and nothing throws", async () => {
    vi.stubGlobal("indexedDB", undefined);
    expect(await available()).toBe(false);
    expect(await list()).toEqual([]);
    expect(await save(signature("a"))).toBeNull();
    expect(await forget("a")).toBe(false);
  });

  for (const mode of ["throw", "error", "broken-tx"] as const) {
    it(`a failing IndexedDB (${mode}): nothing saved, nothing throws`, async () => {
      fakeIndexedDB(mode);
      expect(await available()).toBe(mode === "broken-tx");
      expect(await list()).toEqual([]);
      expect(await save(signature("a"))).toBeNull();
      expect(await forget("a")).toBe(false);
    });
  }

  it("reading indexedDB itself throws (blocked storage): unavailable", async () => {
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, get() { throw new DOMException("denied", "SecurityError"); } });
    try {
      expect(await available()).toBe(false);
      expect(await list()).toEqual([]);
    } finally {
      delete (globalThis as any).indexedDB;
    }
  });

  it("an open that never answers counts as unavailable after a few seconds", async () => {
    vi.useFakeTimers();
    fakeIndexedDB("hang");
    const answer = available();
    await vi.advanceTimersByTimeAsync(3000);
    expect(await answer).toBe(false);
  });

  it("at most 5; replacing a saved one still works when full; forget; newest first; connections closed", async () => {
    const { opened } = fakeIndexedDB();
    expect(await available()).toBe(true);
    expect(await list()).toEqual([]);
    const now = vi.spyOn(Date, "now");
    for (let i = 1; i <= MAX_SAVED; i++) {
      now.mockReturnValue(1000 * i);
      const stored = await save(signature(`s${i}`, i === 2 ? { kind: "initials", source: "type", description: "Sigla: MR" } : {}));
      expect(stored?.savedAt).toBe(1000 * i);
    }
    now.mockReturnValue(9000);
    expect(await save(signature("s6"))).toBeNull();
    let saved = await list();
    expect(saved.map((s) => s.id)).toEqual(["s5", "s4", "s3", "s2", "s1"]);
    expect(saved[3]).toMatchObject({ kind: "initials", source: "type", description: "Sigla: MR", width: 600, height: 200, savedAt: 2000 });
    expect(saved[0].png).toBeInstanceOf(Blob);
    expect(saved[0].png.type).toBe("image/png");
    expect(Array.from(new Uint8Array(await saved[0].png.arrayBuffer()))).toEqual([1, 2, 3, 2]);
    // The same id again replaces it, also with 5 saved; a savedAt it already has is kept.
    expect(await save(signature("s1", { savedAt: 500, description: "Firma: Mario Rossi" }))).toMatchObject({ savedAt: 500 });
    saved = await list();
    expect(saved).toHaveLength(5);
    expect(saved.find((s) => s.id === "s1")?.description).toBe("Firma: Mario Rossi");
    expect(await forget("s3")).toBe(true);
    expect(await forget("missing")).toBe(true);
    expect((await list()).map((s) => s.id)).toEqual(["s5", "s4", "s2", "s1"]);
    expect(await save(signature("s6"))).not.toBeNull();
    expect(await list()).toHaveLength(5);
    expect(opened.every((db) => db.closed)).toBe(true);
    now.mockRestore();
  });

  it("damaged or older entries are skipped; a stored Blob is read too", async () => {
    const { stores } = fakeIndexedDB();
    expect(await available()).toBe(true);
    const data = stores.get("signatures")!;
    const png = new Blob([new Uint8Array([9])], { type: "image/png" });
    data.set("ok", { id: "ok", kind: "initials", png, width: 10, height: 5, description: "Sigla", source: "photo", savedAt: 7 });
    data.set("bad-kind", { id: "bad-kind", kind: "stamp", png, width: 10, height: 5, source: "draw", savedAt: 1 });
    data.set("no-png", { id: "no-png", kind: "signature", width: 10, height: 5, source: "draw", savedAt: 1 });
    data.set("zero", { id: "zero", kind: "signature", png, width: 0, height: 5, source: "draw", savedAt: 1 });
    data.set("junk", "not a record");
    const saved = await list();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ id: "ok", kind: "initials", source: "photo", savedAt: 7, description: "Sigla" });
    expect(saved[0].png).toBe(png);
  });
});
