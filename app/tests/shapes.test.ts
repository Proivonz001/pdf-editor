// Forme (release 6): the shapes the app draws as page content (src/engine/shapes.ts), in Node on
// the worker's mupdf build. The engine functions run directly on MuPDF documents, as the session
// runs them: the inline /PEDef survives a line edit's redaction filter (the first thing proved),
// every kind written and read back on a plain page, a turned page and a cropped one, drawn where it
// is seen; content that ends dirty or unbalanced; edits and deletes in place keep the painting
// order and the ids; blocks that are not the app's (a crafted /PEDef, paths past what it draws, too
// many) are neither listed nor rewritten; lengths as seen on a /UserUnit page; each path starting
// and running as the viewer's preview; the highlight's graphics state. The session's side (history, refusals, Riprendi, the organizer,
// Bianchetto, decorations, the highlight's pixels) is in shapes-session.test.ts.
import * as mupdf from "mupdf";
import { afterEach, describe, expect, it } from "vitest";
import { releaseFallbackFonts, renderPixmap, replaceText } from "../src/engine/core.js";
import { contentStreams, invert, latin1, operations, streamBytes } from "../src/engine/images";
import { ContentError } from "../src/engine/newcontent";
import { HIGHLIGHT_ALPHA, MAX_PEN_POINTS, type Matrix, type Shape } from "../src/engine/protocol";
import { apply, drawing, shapeBox } from "../src/engine/shapeGeometry";
import { MAX_LISTED_POINTS, MAX_LISTED_SHAPES, addShape, listShapes, rewriteShape, shapeBlocksIn } from "../src/engine/shapes";

type RGB = [number, number, number];
const RED: RGB = [0.85, 0.18, 0.13], BLUE: RGB = [0.12, 0.36, 0.85], YELLOW: RGB = [1, 0.83, 0];
const shape = (s: Partial<Shape> & Pick<Shape, "kind" | "points">): Shape => ({ color: RED, width: 2, dash: "solid", heads: 0, ...s });

/** A freehand stroke: a wave of 60 points. */
const PEN: [number, number][] = Array.from({ length: 60 }, (_, k) => [60 + k * 3, 320 + 15 * Math.sin(k / 5)]);
/** One of each kind and style, in page space (all within 430 × 340, so on a turned A4 page too). */
const EVERY: Shape[] = [
  shape({ kind: "line", points: [[60, 80], [200, 120]] }),
  shape({ kind: "line", points: [[60, 150], [200, 150]], heads: 1, dash: "dashed" }),
  shape({ kind: "line", points: [[200, 220], [60, 180]], heads: 2, dash: "dotted", color: BLUE, width: 4 }),
  shape({ kind: "rect", points: [[300, 120], [220, 60]], dash: "dashed" }),
  shape({ kind: "ellipse", points: [[320, 60], [420, 130]], dash: "dotted", width: 1 }),
  shape({ kind: "pen", points: PEN, color: BLUE, width: 0.5 }),
  shape({ kind: "highlight", points: [[60, 250], [260, 270]], color: YELLOW, width: 0 }),
];

/** Documents opened by a test, destroyed after it (rule 5). */
let opened: mupdf.PDFDocument[] = [];
afterEach(() => {
  for (const doc of opened) {
    releaseFallbackFonts(doc);
    doc.destroy();
  }
  opened = [];
});

function saveBytes(doc: mupdf.PDFDocument, options = "compress=no"): Uint8Array {
  const buf = doc.saveToBuffer(options);
  try {
    return buf.asUint8Array().slice();
  } finally {
    buf.destroy();
  }
}
const openBytes = (bytes: Uint8Array) => {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf").asPDF()!;
  opened.push(doc);
  return doc;
};

/** A one-page PDF with `content` (Helvetica as /F1), its /Rotate, CropBox and /UserUnit as given, made here. */
function onePage(
  content = "BT /F1 20 Tf 72 742 Td (Hello world) Tj ET",
  { rotate = 0, crop = null, unit = 1 }: { rotate?: 0 | 90 | 270; crop?: number[] | null; unit?: number } = {},
): mupdf.PDFDocument {
  const d = new mupdf.PDFDocument();
  try {
    const helv = d.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" });
    const buf = new mupdf.Buffer(content);
    try {
      d.insertPage(-1, d.addPage([0, 0, 595, 842], rotate, { Font: { F1: helv } }, buf));
    } finally {
      buf.destroy();
    }
    if (crop) d.findPage(0).put("CropBox", crop);
    if (unit !== 1) d.findPage(0).put("UserUnit", unit);
    return openBytes(saveBytes(d));
  } finally {
    d.destroy();
  }
}

/** The page's content as MuPDF reads it (its streams joined). */
function contentOf(doc: mupdf.PDFDocument, pageIndex = 0): string {
  return contentStreams(doc.findPage(pageIndex)).map((s) => latin1(streamBytes(s))).join("\n");
}

/** The colour (0..255) of page `pageIndex` at page-space point (x, y), rendered at scale 2. */
function pixel(doc: mupdf.PDFDocument, x: number, y: number, pageIndex = 0): RGB {
  const page = doc.loadPage(pageIndex);
  const pix = renderPixmap(mupdf, page, 2);
  try {
    const px = Math.floor(x * 2) - pix.getX(), py = Math.floor(y * 2) - pix.getY();
    const at = py * pix.getStride() + px * pix.getNumberOfComponents();
    const p = pix.getPixels();
    return [p[at], p[at + 1], p[at + 2]];
  } finally {
    pix.destroy();
    page.destroy();
  }
}
/** Page `pageIndex` rendered once at `scale`: the colour (0..255) at page-space point (x, y). */
function rendered(doc: mupdf.PDFDocument, scale: number, pageIndex = 0): (x: number, y: number) => RGB {
  const page = doc.loadPage(pageIndex);
  const pix = renderPixmap(mupdf, page, scale);
  try {
    const p = pix.getPixels().slice(), stride = pix.getStride(), n = pix.getNumberOfComponents(), ox = pix.getX(), oy = pix.getY();
    return (x, y) => {
      const at = (Math.floor(y * scale) - oy) * stride + (Math.floor(x * scale) - ox) * n;
      return [p[at], p[at + 1], p[at + 2]];
    };
  } finally {
    pix.destroy();
    page.destroy();
  }
}
const isRed = ([r, g, b]: RGB) => r > 170 && g < 110 && b < 110;
const isWhite = ([r, g, b]: RGB) => r > 240 && g > 240 && b > 240;

/** The code of the ContentError `fn` throws (null: none). */
function codeOf(fn: () => unknown) {
  try {
    fn();
  } catch (err) {
    return (err as ContentError).code;
  }
  return null;
}

/** listShapes gives back `shapes` (to 0.001), ids 1.. in order, each bbox its shapeBox. */
function expectListed(doc: mupdf.PDFDocument, shapes: Shape[], ids = shapes.map((_, k) => k + 1)) {
  const listed = listShapes(mupdf, doc, 0);
  expect(listed.map((s) => s.id)).toEqual(ids);
  listed.forEach((info, k) => {
    const want = shapes[k];
    expect({ ...info.shape, points: [] }).toEqual({ ...want, points: [] });
    expect(info.shape.points.length).toBe(want.points.length);
    info.shape.points.forEach((p, j) => {
      expect(p[0]).toBeCloseTo(want.points[j][0], 3);
      expect(p[1]).toBeCloseTo(want.points[j][1], 3);
    });
    shapeBox(want).forEach((v, j) => expect(info.bbox[j]).toBeCloseTo(v, 2));
  });
}

describe("the definition survives a line edit", () => {
  it("an inline /PEDef (a dictionary with arrays) comes out of the redaction filter as written; the shapes read back the same", () => {
    const doc = onePage();
    for (const s of EVERY) addShape(mupdf, doc, 0, s);
    const before = listShapes(mupdf, doc, 0);
    expect(before).toHaveLength(EVERY.length);
    // The line edit's redaction runs the whole page through MuPDF's content filter.
    replaceText(mupdf, doc, 0, "Hello world", "Ciao mondo", {});
    const text = contentOf(doc);
    expect(text).toContain("Ciao mondo".split("").map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join(""));
    expect(text).not.toContain("Hello world");
    expect(text).toMatch(/\/PEShape 1\s*\/PEDef\s*<<\s*\/V 1\s*\/K\s*\/line\s*\/P\s*\[/);
    expectListed(doc, EVERY);
    expect(isRed(pixel(doc, 190, 117.1))).toBe(true); // the first line still drawn
  });
});

describe("writing and reading back", () => {
  const pages: [string, { rotate?: 0 | 90 | 270; crop?: number[] }][] = [
    ["a plain page", {}],
    ["a page turned 90°", { rotate: 90 }],
    ["a page turned 270° with a CropBox away from the origin", { rotate: 270, crop: [40, 30, 560, 800] }],
    ["a cropped page", { crop: [25, 50, 580, 820] }],
  ];
  for (const [name, options] of pages) {
    it(`every kind, on ${name}: listed as drawn, in page space, and drawn where it is seen`, () => {
      const doc = onePage("", options);
      EVERY.forEach((s, k) => expect(addShape(mupdf, doc, 0, s)).toEqual({ id: k + 1 }));
      expectListed(doc, EVERY);
      // The first line (red, 2 pt) from (60, 80) to (200, 120): its middle is red, beside it white.
      expect(isRed(pixel(doc, 130, 100))).toBe(true);
      expect(isWhite(pixel(doc, 130, 92))).toBe(true);
      // The rectangle's top-left corner is inked, its middle not.
      expect(isRed(pixel(doc, 220, 60))).toBe(true);
      expect(isWhite(pixel(doc, 260, 90))).toBe(true);
    });
  }

  it("the block: never tagged, every stroke parameter set, DeviceRGB, the definition in user space", () => {
    const doc = onePage(undefined, { rotate: 90 });
    addShape(mupdf, doc, 0, EVERY[2]);
    const text = contentOf(doc);
    const [block] = shapeBlocksIn([text]);
    const own = text.slice(block.start, block.end);
    expect(own).toMatch(/^\/Artifact <<\/PEShape 1 \/PEDef <<\/V 1 \/K \/line \/P \[[-\d. ]+\] \/C \[0\.12 0\.36 0\.85\] \/W 4 \/D \/dotted \/H 2>>>> BDC\n/);
    expect(own).toContain("4 w 1 J 1 j 4 M [0 8] 0 d\n0.12 0.36 0.85 RG 0.12 0.36 0.85 rg\n");
    expect(own.match(/\bS\n/g)).toHaveLength(1);
    expect(own.match(/\bf\n/g)).toHaveLength(1); // both heads in one fill: removed together or not at all
    // The definition is in the page's user space: page space (200, 220) on a page turned 90°.
    const page = doc.loadPage(0);
    const p = apply(invert(page.getTransform() as Matrix), [200, 220]);
    page.destroy();
    expect(own).toContain(`/P [${Math.round(p[0] * 1e4) / 1e4} ${Math.round(p[1] * 1e4) / 1e4} `);
    expect(own).not.toMatch(/MCID|\/Span|\/P <</);
  });

  it("on a page with /UserUnit 2, as wide, with heads and dashes as long, as seen on any page; listed as drawn", () => {
    const doc = onePage("", { unit: 2 });
    const arrow = shape({ kind: "line", points: [[100, 100], [300, 100]], width: 4, heads: 1 });
    const dashed = shape({ kind: "line", points: [[100, 200], [300, 200]], width: 4, dash: "dashed" });
    addShape(mupdf, doc, 0, arrow);
    addShape(mupdf, doc, 0, dashed);
    expectListed(doc, [arrow, dashed]);
    // User space is 2 pt a unit: the definition keeps the width as seen, the drawing halves its lengths.
    const text = contentOf(doc);
    expect(text).toContain("/W 4 /D /solid /H 1>>");
    expect(text).toContain("2 w 1 J 1 j 4 M [] 0 d\n");
    expect(text).toContain("2 w 0 J 1 j 4 M [6 4] 0 d\n");
    const at = rendered(doc, 1);
    let rows = 0;
    for (let y = 80; y < 120; y++) if (isRed(at(200, y + 0.5))) rows++;
    expect(rows).toBe(4); // a 4 pt stroke, not 8
    // The head is 18 pt long (3 × 4 + 6) and 9 pt either side, as listShapes' box says: x 270 is shaft only.
    expect(isRed(at(270, 100))).toBe(true);
    expect(isWhite(at(270, 96))).toBe(true);
    expect(isRed(at(290, 95))).toBe(true);
    const [info] = listShapes(mupdf, doc, 0);
    expect(info.bbox[1]).toBeCloseTo(91, 3);
    expect(isWhite(at(299, info.bbox[1] - 2))).toBe(true);
  });

  it("each path starts where the viewer's preview starts it and runs the same way (the dashes fall the same), on a plain page and a turned one", () => {
    const rect = shape({ kind: "rect", points: [[300, 100], [220, 60]], dash: "dashed" });
    const ellipse = shape({ kind: "ellipse", points: [[320, 60], [420, 130]], dash: "dotted" });
    for (const rotate of [0, 90] as const) {
      const doc = onePage("", { rotate });
      addShape(mupdf, doc, 0, rect);
      addShape(mupdf, doc, 0, ellipse);
      const page = doc.loadPage(0);
      const T = page.getTransform() as Matrix;
      page.destroy();
      const text = contentOf(doc);
      shapeBlocksIn([text]).forEach((block, k) => {
        // Every point the path goes to, in order, as seen; and the preview's.
        const written = [...operations(text.slice(block.start, block.end))]
          .filter((o) => o.op === "m" || o.op === "l" || o.op === "c")
          .map((o) => apply(T, [o.args[o.args.length - 2].num!, o.args[o.args.length - 1].num!]));
        const preview = drawing([rect, ellipse][k]).stroke.flatMap((s) => (s.op === "Z" ? [] : [s.p]));
        expect(written.length, `rotate ${rotate}, shape ${k + 1}`).toBe(preview.length);
        written.forEach((p, j) => {
          expect(p[0]).toBeCloseTo(preview[j][0], 3);
          expect(p[1]).toBeCloseTo(preview[j][1], 3);
        });
      });
    }
  });

  it("a page whose content ends dirty (stroke state set outside any q) still draws the shape with its own parameters", () => {
    // 5 pt wide, dashed 3 on 3 off, blue: none of it may reach the shape (appendSafely does not wrap for these).
    const doc = onePage("BT /F1 20 Tf 72 742 Td (Hello) Tj ET 5 w [3] 0 d 2 J 0 0 1 RG 0 0 1 rg");
    addShape(mupdf, doc, 0, shape({ kind: "line", points: [[60, 300], [260, 300]] }));
    for (let x = 62; x <= 258; x += 1.5) expect(isRed(pixel(doc, x, 300)), `x ${x}`).toBe(true); // solid, red
    expect(isWhite(pixel(doc, 160, 302.5))).toBe(true); // 2 pt wide, not 5
    expect(isWhite(pixel(doc, 263, 300))).toBe(true); // nothing past the end but its 1 pt cap
  });

  it("content that does not end clean (an open q with a cm) is wrapped first: the shape is where it is seen", () => {
    const doc = onePage("q 1 0 0 1 100 100 cm 0 0 1 RG 3 w");
    addShape(mupdf, doc, 0, shape({ kind: "rect", points: [[50, 50], [150, 100]] }));
    expectListed(doc, [shape({ kind: "rect", points: [[50, 50], [150, 100]] })]);
    expect(isRed(pixel(doc, 50, 75))).toBe(true);
    expect(isRed(pixel(doc, 150, 75))).toBe(true);
    expect(isWhite(pixel(doc, 100, 75))).toBe(true);
  });

  it("content that cannot take an addition is refused before anything changes", () => {
    const doc = onePage("BT /F1 20 Tf 72 742 Td (Hello) Tj ET (open");
    const before = contentOf(doc);
    try {
      addShape(mupdf, doc, 0, EVERY[0]);
      throw new Error("added");
    } catch (err) {
      expect(err).toBeInstanceOf(ContentError);
      expect((err as ContentError).code).toBe("not-editable");
    }
    expect(contentOf(doc)).toBe(before);
  });
});

describe("edits in place", () => {
  it("rewriting or deleting a shape keeps its id and the painting order of the others; a new one takes the next id", () => {
    const doc = onePage();
    const [a, b, c] = [EVERY[0], EVERY[3], EVERY[6]];
    for (const s of [a, b, c]) addShape(mupdf, doc, 0, s);
    const moved = { ...b, points: b.points.map(([x, y]) => [x + 10, y + 5] as [number, number]), color: BLUE, dash: "solid" as const };
    expect(rewriteShape(mupdf, doc, 0, 2, moved)).toEqual({ id: 2 });
    expectListed(doc, [a, moved, c]);
    const order = shapeBlocksIn([contentOf(doc)]).map((x) => x.id);
    expect(order).toEqual([1, 2, 3]);
    expect(rewriteShape(mupdf, doc, 0, 2, null)).toEqual({ id: null });
    expectListed(doc, [a, c], [1, 3]);
    expect(addShape(mupdf, doc, 0, b)).toEqual({ id: 4 });
    // twenty rewrites leave one block, not twenty
    for (let k = 0; k < 20; k++) rewriteShape(mupdf, doc, 0, 1, { ...a, width: 1 + k / 10 });
    expect(contentOf(doc).match(/PEShape 1\b/g)).toHaveLength(1);
  });

  it("an unknown id is a bad request; a block holding what the app does not write is neither listed nor rewritten", () => {
    const def = "/PEDef <</V 1 /K /line /P [10 10 100 10] /C [0 0 0] /W 1 /D /solid /H 0>>";
    const doc = onePage(
      `/Artifact <</PEShape 1 ${def}>> BDC q 1 w 10 10 m 100 10 l S BT /F1 9 Tf (secret) Tj ET Q EMC\n` +
      `/Artifact <</PEShape 2 /PEDef <</V 9>>>> BDC q 1 w 10 30 m 100 30 l S Q EMC\n` +
      `/Artifact <</PEShape 3 ${def}>> BDC q 1 w 10 10 m 100 10 l S Q EMC\n` +
      `/Artifact <</PEShape 3 ${def}>> BDC q 1 w 10 50 m 100 50 l S Q EMC\n`,
    );
    expect(listShapes(mupdf, doc, 0).map((s) => s.id)).toEqual([3]);
    expect(codeOf(() => rewriteShape(mupdf, doc, 0, 1, null))).toBe("not-editable");
    expect(codeOf(() => rewriteShape(mupdf, doc, 0, 2, null))).toBe("bad-request");
    expect(codeOf(() => rewriteShape(mupdf, doc, 0, 9, null))).toBe("bad-request");
    expect(contentOf(doc)).toContain("(secret) Tj");
    // a new shape's id is past every /PEShape on the page, read or not
    expect(addShape(mupdf, doc, 0, EVERY[0])).toEqual({ id: 4 });
  });

  it("a block painting past what its /PEDef draws, or whose /PEDef is out of what the app writes, is neither listed nor rewritten", () => {
    const own = (id: number, def: string, paths: string) => `/Artifact <</PEShape ${id} /PEDef <</V 1 ${def}>>>> BDC q 1 w ${paths} Q EMC\n`;
    const doc = onePage(
      "BT /F1 20 Tf 72 742 Td (Hello world) Tj ET\n" +
      // a small arrow by its definition, painting the whole page white (a fill and a stroke: as many paths as an arrow)
      own(1, "/K /line /P [10 10 40 10] /C [1 0 0] /W 1 /D /solid /H 1", "1 1 1 rg 0 0 595 842 re f 10 10 m 30 10 l S") +
      own(2, "/K /line /P [10 30 100 30] /C [0 0 0] /W 2000 /D /solid /H 0", "10 30 m 100 30 l S") + // every click would hit it
      own(3, "/K /rect /P [10 40 100 60] /C [0 0 0] /W 1 /D /solid /H 2", "10 40 90 20 re h S") +
      own(4, "/K /pen /P [10 70 50 80 100 70] /C [0 0 0] /W 1 /D /dashed /H 0", "10 70 m 100 70 l S") +
      own(5, "/K /highlight /P [10 90 100 100] /C [1 1 0] /W 2 /D /solid /H 0", "10 90 90 10 re f") +
      own(7, "/K /line /P [10 130 100 130] /C [0 0 0] /W 1 /D /solid /H 0", "400 w 10 130 m 100 130 l S") + // a thin line by its definition
      own(8, "/K /rect /P [10 150 100 152] /C [0 0 0] /W 1 /D /solid /H 0", "0 j 10000 M 10 150 m 100 152 l 10 152 l h S") + // spikes far out
      own(9, "/K /line /P [10 160 100 160] /C [0 0 0] /W 1 /D /solid /H 0", "/Wide gs 10 160 m 100 160 l S") + // its own line width (/LW)
      own(10, "/K /highlight /P [10 170 100 180] /C [1 1 0] /W 0 /D /solid /H 0", "/Wide gs 10 170 90 10 re S") + // a highlight that strokes
      own(6, "/K /line /P [10 110 100 110] /C [0 0 0] /W 1 /D /solid /H 0", "10 110.4 m 100 110 l S"), // a hair off: rounding
    );
    expect(listShapes(mupdf, doc, 0).map((s) => s.id)).toEqual([6]);
    for (const id of [1, 2, 3, 4, 5, 7, 8, 9, 10]) expect(codeOf(() => rewriteShape(mupdf, doc, 0, id, null)), `shape ${id}`).toBe("bad-request");
    expect(contentOf(doc)).toContain("0 0 595 842 re f");
  });

  it(`lists at most ${MAX_LISTED_SHAPES} shapes, with ${MAX_LISTED_POINTS} points in all, on a page: past them, line art`, () => {
    const line = (k: number) => `/Artifact <</PEShape ${k} /PEDef <</V 1 /K /line /P [10 10 100 10] /C [0 0 0] /W 1 /D /solid /H 0>>>> BDC q 1 w 10 10 m 100 10 l S Q EMC\n`;
    const many = onePage(Array.from({ length: MAX_LISTED_SHAPES + 3 }, (_, k) => line(k + 1)).join(""));
    expect(listShapes(mupdf, many, 0)).toHaveLength(MAX_LISTED_SHAPES);
    // No new shape past the caps: it would be drawn but never listed (selected, moved, deleted).
    const before = contentOf(many);
    expect(codeOf(() => addShape(mupdf, many, 0, EVERY[0]))).toBe("not-editable");
    expect(contentOf(many)).toBe(before);
    expect(codeOf(() => rewriteShape(mupdf, many, 0, MAX_LISTED_SHAPES + 1, null))).toBe("bad-request");
    expect(rewriteShape(mupdf, many, 0, MAX_LISTED_SHAPES, null)).toEqual({ id: null });
    const points = Array.from({ length: MAX_PEN_POINTS }, (_, k) => (k % 2 ? "20 20" : "10 10")).join(" ");
    const pen = (k: number) => `/Artifact <</PEShape ${k} /PEDef <</V 1 /K /pen /P [${points}] /C [0 0 0] /W 1 /D /solid /H 0>>>> BDC q 1 w 10 10 m 20 20 l S Q EMC\n`;
    const heavy = onePage(Array.from({ length: MAX_LISTED_POINTS / MAX_PEN_POINTS + 1 }, (_, k) => pen(k + 1)).join(""));
    expect(listShapes(mupdf, heavy, 0)).toHaveLength(MAX_LISTED_POINTS / MAX_PEN_POINTS);
    expect(codeOf(() => addShape(mupdf, heavy, 0, EVERY[0]))).toBe("not-editable");
  });

  it("a block that paints less than its definition (emptied, or an arrow's heads taken) is not listed", () => {
    const def = (h: number) => `/PEDef <</V 1 /K /line /P [10 10 100 10] /C [0 0 0] /W 1 /D /solid /H ${h}>>`;
    const doc = onePage(
      `/Artifact <</PEShape 1 ${def(0)}>> BDC q 1 w Q EMC\n` +
      `/Artifact <</PEShape 2 ${def(1)}>> BDC q 1 w 10 10 m 90 10 l S Q EMC\n` +
      `/Artifact <</PEShape 3 ${def(1)}>> BDC q 1 w 10 10 m 90 10 l S 100 10 m 91 6 l 91 14 l h f Q EMC\n`,
    );
    expect(listShapes(mupdf, doc, 0).map((s) => s.id)).toEqual([3]);
  });
});

describe("the highlight", () => {
  it("multiplies at HIGHLIGHT_ALPHA under one graphics state of the page's, found again for the next one", () => {
    const doc = onePage();
    addShape(mupdf, doc, 0, EVERY[6]);
    addShape(mupdf, doc, 0, { ...EVERY[6], points: [[60, 300], [200, 320]] });
    const states = doc.findPage(0).get("Resources").get("ExtGState");
    const keys: string[] = [];
    states.forEach((_v, k) => keys.push(String(k)));
    expect(keys).toEqual(["PEHighlight1"]);
    const gs = states.get("PEHighlight1");
    expect(gs.get("BM").asName()).toBe("Multiply");
    expect(gs.get("ca").asNumber()).toBeCloseTo(HIGHLIGHT_ALPHA, 5);
    expect(contentOf(doc).match(/\/PEHighlight1 gs/g)).toHaveLength(2);
  });

  it("a page sharing its resources with another gets its own copy: the other page's stay as they were", () => {
    const d = new mupdf.PDFDocument();
    const res = d.addObject({ Font: {} });
    for (let k = 0; k < 2; k++) {
      const buf = new mupdf.Buffer("0 g 10 10 m 20 20 l S");
      d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, res, buf));
      buf.destroy();
    }
    const doc = openBytes(saveBytes(d));
    d.destroy();
    addShape(mupdf, doc, 0, EVERY[6]);
    expect(doc.findPage(0).get("Resources").get("ExtGState").isDictionary()).toBe(true);
    expect(doc.findPage(1).get("Resources").get("ExtGState").isNull()).toBe(true);
  });

  it("after a line edit renamed the page's resources, a rewrite finds the graphics state again (or adds it)", () => {
    const doc = onePage();
    addShape(mupdf, doc, 0, EVERY[6]);
    replaceText(mupdf, doc, 0, "Hello world", "Ciao", {});
    rewriteShape(mupdf, doc, 0, 1, { ...EVERY[6], color: BLUE });
    const text = contentOf(doc);
    const name = /\/(\S+) gs/.exec(text.slice(text.indexOf("PEShape 1")))![1];
    const gs = doc.findPage(0).get("Resources").get("ExtGState").get(name);
    expect(gs.get("BM").asName()).toBe("Multiply");
    expectListed(doc, [{ ...EVERY[6], color: BLUE }]);
  });
});
