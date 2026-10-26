// Forme on the page (release 6) against the app's real modules with a fake engine (no browser):
// SL1 the pure geometry (ui/shapes/geometry.ts): a drag's points and Shift's square, circle and
// 45° lines, the default shapes, a text line's highlight (a turned stamp, a justified line's
// pieces, a column's gutter), the pen's points thinned and its dots, what a click or a finger
// hits, and a selected shape moved, resized by its handles (a pen stroke scaling its points, a
// line's ends), stretched and scaled, always on the page; SL2 the actions (ui/shapes/actions.ts):
// the next shape in the style chosen, names in Italian and English, reading a page's shapes,
// writing them (selected after an add but a pen stroke or a highlight, deselected and dropped
// from the page's shapes after a delete, the lines kept, refusals in words, a selection made
// meanwhile kept) and "Metti al centro"; SL3 the layer and the selected shape's frame called as
// functions (hooks mocked, as tests/redact-ui.test.ts does): drawing with a mouse (Shift too), a
// tap, the highlighter on a line (waiting for the lines, a double click writing one, a tap near a
// shape on touch), Esc giving a drag up, the pen with a finger (dots, a tap on a shape) and a
// second finger giving it up, its dots next to a stroke and its taps on the ink only, a selected
// line's frame (any, with the pen) letting presses through to a finger and a mouse alike, a tap
// in a frame on touch, the frame's keys written as one edit after the pause (a drag released
// while they are written) and said with where the shape now is, its context bar (stretching
// without dragging, Elimina and Deseleziona before the move buttons' row, placed where it shows
// whole, over the next page too, its side kept when the move buttons' row opens: placeBar), a
// change of style not drawn over the old one, a highlight's preview at the engine's opacity, and
// a status region that does not say again what was said before it came.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "./stubs/browser-globals";

/**
 * Hooks outside a render (no DOM here): the i-th useState of a call gives `hooks.states[i]` when
 * set (else its first value), its setter noted in `hooks.sets`; refs that live for one call (the
 * handlers of one render share them); effects that do not run.
 */
const hooks = vi.hoisted(() => ({ states: [] as unknown[], at: 0, sets: [] as unknown[] }));
vi.mock("preact/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("preact/hooks")>()),
  useState: (init: unknown) => {
    const i = hooks.at++;
    return [hooks.states[i] ?? init, (v: unknown) => { hooks.sets.push(v); }];
  },
  useRef: (init: unknown) => ({ current: init }),
  useEffect: () => undefined,
  useLayoutEffect: () => undefined,
}));

vi.mock("../src/engine/client.ts", () => {
  class EngineError extends Error {
    constructor(message: string, readonly code?: string) {
      super(message);
    }
  }
  const e = () => (globalThis as any).__shapesEngine;
  class EngineClient {
    ready = Promise.resolve();
    open(bytes: ArrayBuffer) { return e().open(bytes); }
    lines(p: number) { return e().lines(p); }
    images() { return Promise.resolve([]); }
    addedTexts() { return Promise.resolve([]); }
    fields() { return Promise.resolve([]); }
    shapes(p: number) { return e().shapes(p); }
    addShape(p: number, shape: unknown) { return e().addShape(p, shape); }
    editShape(p: number, id: number, shape: unknown) { return e().editShape(p, id, shape); }
    close() { return Promise.resolve(null); }
  }
  return { EngineError, EngineClient };
});

vi.mock("../src/ui/fill/signatureStore.ts", () => ({
  MAX_SAVED: 5,
  available: async () => false,
  list: async () => [],
  save: async () => null,
  forget: async () => false,
}));

// Window listeners (window is globalThis here), kept so a test can send them an event.
const winListeners = new Map<string, Set<(e: any) => void>>();
const g = globalThis as any;
g.addEventListener = (type: string, fn: (e: any) => void) => {
  if (!winListeners.has(type)) winListeners.set(type, new Set());
  winListeners.get(type)!.add(fn);
};
g.removeEventListener = (type: string, fn: (e: any) => void) => winListeners.get(type)?.delete(fn);
g.cancelAnimationFrame = (id: any) => clearTimeout(id);
const fire = (type: string, e: any) => [...(winListeners.get(type) ?? [])].forEach((fn) => fn(e));

type P = [number, number];
const PAGE: [number, number, number, number] = [0, 0, 600, 800];
const MM = 72 / 25.4;
const calls: any[] = [];
let nextId = 10;
/** What the next addShape does instead of succeeding: an error to throw. */
let addFails: Error | null = null;
/** While set, addShape waits for it (an edit being written). */
let addGate: Promise<void> | null = null;
/** The text lines the engine reads on every page. */
let engineLines: any[] = [];

g.__shapesEngine = {
  open: async () => ({
    ok: true, pageCount: 2, pages: [0, 1].map((index) => ({ index, bounds: PAGE })), encrypted: false,
    needsPassword: false, canKeepPassword: false, pdfa: null, signatures: 0, title: null, form: null,
  }),
  shapes: async (p: number) => {
    calls.push(["shapes", p]);
    return [];
  },
  lines: async (p: number) => {
    calls.push(["lines", p]);
    return engineLines;
  },
  addShape: async (p: number, shape: any) => {
    calls.push(["addShape", p, shape]);
    if (addGate) await addGate;
    if (addFails) throw addFails;
    return { editCount: 1, canUndo: true, canRedo: false, changedPages: [p], pageIndex: p, id: nextId++ };
  },
  editShape: async (p: number, id: number, shape: any) => {
    calls.push(["editShape", p, id, shape]);
    return { editCount: 2, canUndo: true, canRedo: false, changedPages: [p], pageIndex: p, id: shape ? id : null };
  },
};

let state: typeof import("../src/state");
let actions: typeof import("../src/ui/actions");
let i18n: typeof import("../src/i18n");
let geo: typeof import("../src/ui/shapes/geometry");
let shapes: typeof import("../src/ui/shapes/actions");
let layer: typeof import("../src/viewer/ShapeLayer");
let nudge: typeof import("../src/ui/NudgeControls");
let client: typeof import("../src/engine/client");
let protocol: typeof import("../src/engine/protocol");

beforeAll(async () => {
  state = await import("../src/state");
  actions = await import("../src/ui/actions");
  i18n = await import("../src/i18n");
  geo = await import("../src/ui/shapes/geometry");
  shapes = await import("../src/ui/shapes/actions");
  layer = await import("../src/viewer/ShapeLayer");
  nudge = await import("../src/ui/NudgeControls");
  client = await import("../src/engine/client");
  protocol = await import("../src/engine/protocol");
});

beforeEach(() => {
  i18n.setLocale("en");
  calls.length = 0;
  addFails = null;
  addGate = null;
  engineLines = [];
  vi.useRealTimers();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const toastTexts = () => state.toasts.value.map((x) => x.text);
const near = (a: readonly P[], b: readonly P[], digits = 6) => {
  expect(a.length).toBe(b.length);
  a.forEach((p, i) => {
    expect(p[0]).toBeCloseTo(b[i][0], digits);
    expect(p[1]).toBeCloseTo(b[i][1], digits);
  });
};

function shape(kind: any, points: P[], extra: Record<string, unknown> = {}): any {
  return { kind, points, color: [0, 0, 0], width: 2, dash: "solid", heads: 0, ...extra };
}

async function inShapes(name: string) {
  const file = { name, type: "application/pdf", arrayBuffer: async () => new TextEncoder().encode(name).buffer } as unknown as File;
  await actions.openFile(file, { confirmed: true });
  await actions.setTool("edit");
  await actions.setEditTool("shapes");
  state.toasts.value = [];
  calls.length = 0;
  return state.doc.value!;
}

/** The page's shapes as the engine would list them (read at the page's current revision). */
function given(page: any, list: any[]) {
  const infos = list.map((s, i) => ({ id: i + 1, shape: s, bbox: geo.pointsBox(s) }));
  shapes.pageShapes(page).value = { rev: page.rev.peek(), shapes: infos };
  return infos;
}

describe("SL1 the geometry", () => {
  it("a drag gives its two points on the page; Shift a square, a circle, a line at 45°", () => {
    near(geo.dragPoints("rect", [100, 100], [700, -20], false, PAGE), [[100, 100], [600, 0]]);
    near(geo.dragPoints("rect", [100, 100], [160, 120], true, PAGE), [[100, 100], [160, 160]]);
    near(geo.dragPoints("ellipse", [100, 100], [40, 90], true, PAGE), [[100, 100], [40, 40]]);
    // As big as the page lets the square be, from where the drag began.
    near(geo.dragPoints("rect", [580, 100], [700, 150], true, PAGE), [[580, 100], [600, 120]]);
    // A line turns to the nearest 45° step, its length kept.
    const L = Math.hypot(100, 90);
    near(geo.dragPoints("line", [100, 100], [200, 190], true, PAGE), [[100, 100], [100 + L / Math.SQRT2, 100 + L / Math.SQRT2]]);
    near(geo.dragPoints("line", [100, 100], [300, 110], true, PAGE), [[100, 100], [100 + Math.hypot(200, 10), 100]]);
    // Past the edge it stops there, at the same angle.
    near(geo.dragPoints("line", [550, 100], [700, 240], true, PAGE), [[550, 100], [600, 150]]);
    // A highlight is never snapped.
    near(geo.dragPoints("highlight", [100, 100], [160, 120], true, PAGE), [[100, 100], [160, 120]]);
  });

  it("the default shapes: a 40 mm line, a 30 × 20 mm box, a 50 × 6 mm highlight, centred and on the page", () => {
    near(geo.defaultPoints("line", [300, 400], PAGE)!, [[300 - 20 * MM, 400], [300 + 20 * MM, 400]]);
    near(geo.defaultPoints("rect", [300, 400], PAGE)!, [[300 - 15 * MM, 400 - 10 * MM], [300 + 15 * MM, 400 + 10 * MM]]);
    near(geo.defaultPoints("ellipse", [300, 400], PAGE)!, [[300 - 15 * MM, 400 - 10 * MM], [300 + 15 * MM, 400 + 10 * MM]]);
    near(geo.defaultPoints("highlight", [300, 400], PAGE)!, [[300 - 25 * MM, 400 - 3 * MM], [300 + 25 * MM, 400 + 3 * MM]]);
    // At a corner: moved onto the page with its size; on a smaller page, smaller.
    near(geo.defaultPoints("rect", [2, 799], PAGE)!, [[0, 800 - 20 * MM], [30 * MM, 800]]);
    near(geo.defaultPoints("line", [10, 10], [0, 0, 50, 50])!, [[0, 10], [50, 10]]);
    expect(geo.defaultPoints("pen", [300, 400], PAGE)).toBeNull();
  });

  /** A text line as the engine reads it: upright unless `dir` says otherwise. */
  const L = (bbox: number[], text = "testo", dir = [1, 0], size = 12) => ({ bbox, text, dir, size }) as any;

  it("a text line's highlight is its bounds padded by 1 pt, on the page; a click finds the line under it", () => {
    near(geo.lineHighlight([50, 100, 250, 112], PAGE), [[49, 99], [251, 113]]);
    near(geo.lineHighlight([0, 0, 600, 10], PAGE), [[0, 0], [600, 11]]);
    const lines = [L([50, 100, 250, 112], "  "), L([50, 100, 250, 112], "Mario Rossi")];
    expect(geo.lineBoxAt(lines, [100, 105])).toEqual([50, 100, 250, 112]);
    expect(geo.lineBoxAt(lines, [100, 130])).toBeNull();
    expect(geo.lineBoxAt(null, [100, 105])).toBeNull();
    // Where two lines' boxes hold the click, the smaller one (a body line within a big line's box).
    expect(geo.lineBoxAt([L([40, 90, 300, 140], "TITOLO", [1, 0], 48), L([50, 100, 250, 112])], [100, 105])).toEqual([50, 100, 250, 112]);
  });

  it("a stamp turned 45° listed first takes only clicks on its own run, not those on the lines its box covers", () => {
    const s = Math.SQRT1_2;
    const stamp = L([109, 318, 508, 717], "BOZZA", [s, -s], 120);
    const body = L([72, 391, 282, 408], "Body line 20");
    expect(geo.lineBoxAt([stamp, body], [177, 400])).toEqual(body.bbox);
    // In the stamp's box away from its run, and off every line: nothing.
    expect(geo.lineBoxAt([stamp, body], [150, 360])).toBeNull();
    // On the stamp itself: its upright bounds, as the spec says.
    expect(geo.lineBoxAt([stamp, body], [308.5, 517.5])).toEqual(stamp.bbox);
  });

  it("a justified line cut at its wide spaces is one line, a click in a gap too; a column's gutter is never crossed", () => {
    const row = [L([238, 100, 299, 112], "consegnata "), L([318, 100, 385, 112], "all'Università")];
    const around = [L([200, 85, 400, 97]), L([200, 115, 400, 127])];
    expect(geo.lineBoxAt([...around, ...row], [250, 106])).toEqual([238, 100, 385, 112]);
    expect(geo.lineBoxAt([...around, ...row], [308, 106])).toEqual([238, 100, 385, 112]);
    // Without text above or below over the gap, nothing says it is a space: the piece alone.
    expect(geo.lineBoxAt(row, [250, 106])).toEqual([238, 100, 299, 112]);
    // A gap of 2.3 line heights is joined: a click in its very middle (more than a line height from both) too.
    const wide = [L([238, 100, 299, 112], "consegnata "), L([327, 100, 385, 112], "all'Università")];
    expect(geo.lineBoxAt([...around, ...wide], [313, 106])).toEqual([238, 100, 385, 112]);
    expect(geo.lineBoxAt(wide, [313, 106])).toBeNull();
    // Two columns: 30 pt of gutter, which no row crosses.
    const cols = [100, 85, 115].flatMap((y) => [L([50, y, 280, y + 12]), L([310, y, 540, y + 12])]);
    expect(geo.lineBoxAt(cols, [100, 106])).toEqual([50, 100, 280, 112]);
    expect(geo.lineBoxAt(cols, [400, 106])).toEqual([310, 100, 540, 112]);
    // In the gutter, more than a line height from both columns: no line.
    expect(geo.lineBoxAt(cols, [295, 106])).toBeNull();
  });

  it("the pen keeps a point only 0.75 pt or more from the last, and no more than MAX_PEN_POINTS", async () => {
    const { MAX_PEN_POINTS } = await import("../src/engine/protocol");
    const pts: P[] = [[0, 0]];
    expect(geo.addPenPoint(pts, [0.5, 0])).toBe(false);
    expect(geo.addPenPoint(pts, [0.75, 0])).toBe(true);
    expect(geo.addPenPoint(pts, [1.2, 0.2])).toBe(false);
    expect(pts).toEqual([[0, 0], [0.75, 0]]);
    const full: P[] = Array.from({ length: MAX_PEN_POINTS }, (_, i) => [i, 0]);
    expect(geo.addPenPoint(full, [0, 500])).toBe(false);
    expect(full.length).toBe(MAX_PEN_POINTS);
  });

  it("only what the engine takes is written (its own rule, shared): long enough lines, boxes with two real sides, strokes of 2 points or more", async () => {
    const { isShapeDrawable: isDrawable } = await import("../src/engine/shapeGeometry");
    expect(isDrawable(shape("line", [[0, 0], [0.5, 0]]))).toBe(false);
    expect(isDrawable(shape("line", [[0, 0], [1, 0]]))).toBe(true);
    expect(isDrawable(shape("rect", [[0, 0], [50, 0.5]]))).toBe(false);
    expect(isDrawable(shape("highlight", [[0, 0], [50, 10]], { width: 0 }))).toBe(true);
    expect(isDrawable(shape("pen", [[0, 0]]))).toBe(false);
    expect(isDrawable(shape("pen", [[0, 0], [0.5, 0.5]]))).toBe(false);
    // The engine's rule (session.ts, checkSize): the stroke's box at least 1 pt one way, not across.
    expect(isDrawable(shape("pen", [[0, 0], [0.75, 0.75]]))).toBe(false);
    expect(isDrawable(shape("pen", [[0, 0], [1, 0.2]]))).toBe(true);
    expect(isDrawable(shape("pen", [[0, 0], [5, 5], [9, 2]]))).toBe(true);
    expect(isDrawable(shape("rect", [[0, 0], [Number.NaN, 10]]))).toBe(false);
  });

  it("a pen tap or a tiny stroke is a dot the engine takes, on the page; a stroke as drawn", async () => {
    const { isShapeDrawable } = await import("../src/engine/shapeGeometry");
    near(geo.penStroke([[100, 100]], PAGE), [[100, 100], [101.01, 100]]);
    near(geo.penStroke([[100, 100], [100.6, 100.5]], PAGE), [[100, 100], [101.01, 100]]);
    near(geo.penStroke([[600, 100]], PAGE), [[600, 100], [598.99, 100]]);
    const stroke: P[] = [[100, 100], [103, 98], [105, 97]];
    expect(geo.penStroke(stroke, PAGE)).toEqual(stroke);
    expect(geo.penStroke(stroke, PAGE)).not.toBe(stroke);
    expect(isShapeDrawable(shape("pen", geo.penStroke([[100, 100]], PAGE)))).toBe(true);
    expect(isShapeDrawable(shape("pen", geo.penStroke([[100, 100], [100.6, 100.5]], PAGE)))).toBe(true);
    // Wherever the tap is: x + 1 - x can round below 1 (31.88116155177794 does), the dot never does.
    for (let k = 0; k < 20_000; k++) {
      const x = 20 + k * 0.0287931, y = 50 + k * 0.0113;
      expect(isShapeDrawable(shape("pen", geo.penStroke([[x, y]], PAGE)))).toBe(true);
    }
    expect(isShapeDrawable(shape("pen", geo.penStroke([[31.88116155177794, 70]], PAGE)))).toBe(true);
  });

  it("a click hits a stroke within 6 px on screen or half its width + 2 pt, not an outline's empty middle", () => {
    const line = shape("line", [[100, 100], [300, 100]]);
    expect(geo.hitsShape(line, [200, 105], 1)).toBe(true);
    expect(geo.hitsShape(line, [200, 107], 1)).toBe(false);
    // Zoomed in, 6 px is less than the width's own reach (1 + 2 pt).
    expect(geo.hitsShape(line, [200, 105], 4)).toBe(false);
    expect(geo.hitsShape(line, [200, 102.5], 4)).toBe(true);
    const rect = shape("rect", [[100, 100], [300, 200]], { width: 1 });
    expect(geo.hitsShape(rect, [200, 150], 1)).toBe(false);
    expect(geo.hitsShape(rect, [100, 150], 1)).toBe(true);
    expect(geo.hitsShape(rect, [200, 104], 1)).toBe(true);
    const ellipse = shape("ellipse", [[100, 100], [300, 200]], { width: 1 });
    expect(geo.hitsShape(ellipse, [300, 150], 1)).toBe(true);
    expect(geo.hitsShape(ellipse, [200, 200], 1)).toBe(true);
    expect(geo.hitsShape(ellipse, [200, 150], 1)).toBe(false);
    expect(geo.hitsShape(ellipse, [290, 150], 1)).toBe(false);
    // The pen: along its smoothed curve, not its corner points.
    const pen = shape("pen", [[100, 100], [150, 150], [200, 100]]);
    expect(geo.hitsShape(pen, [143.75, 131.25], 1)).toBe(true);
    expect(geo.hitsShape(pen, [150, 150], 1)).toBe(false);
    // A finger reaches 22 px: on a phone (zoom 0.63) a tap 15 px beside a 2 pt line hits it, a click does not.
    const z = 0.63;
    expect(geo.hitsShape(line, [200, 100 + 15 / z], z)).toBe(false);
    expect(geo.hitsShape(line, [200, 100 + 15 / z], z, geo.HIT_PX_TOUCH)).toBe(true);
    expect(geo.hitTest([{ id: 1, shape: line }], [200, 100 + 15 / z], z, geo.HIT_PX_TOUCH)?.id).toBe(1);
    expect(geo.hitsShape(line, [200, 100 + 25 / z], z, geo.HIT_PX_TOUCH)).toBe(false);
    // The pen's tap: only on the ink (half the width + 0.5 pt), whatever the zoom.
    expect(geo.hitsShape(line, [200, 101.4], 1, 0, geo.INK_PT)).toBe(true);
    expect(geo.hitsShape(line, [200, 101.6], 1, 0, geo.INK_PT)).toBe(false);
  });

  it("inside a highlight and inside an arrow head hits; the topmost shape is the one hit", () => {
    const hl = shape("highlight", [[100, 100], [300, 120]], { width: 0 });
    expect(geo.hitsShape(hl, [200, 110], 1)).toBe(true);
    expect(geo.hitsShape(hl, [200, 125], 1)).toBe(false);
    // A 1 pt arrow at 4×: its head is 9 pt long and 4.5 pt half wide, beyond the stroke's reach.
    const arrow = shape("line", [[100, 100], [200, 100]], { width: 1, heads: 1 });
    expect(geo.hitsShape(arrow, [193, 103], 4)).toBe(true);
    expect(geo.hitsShape(arrow, [193, 104], 4)).toBe(false);
    const list = [
      { id: 1, shape: shape("rect", [[100, 100], [300, 200]]) },
      { id: 2, shape: shape("rect", [[100, 100], [200, 150]]) },
    ];
    expect(geo.hitTest(list, [150, 100], 1)?.id).toBe(2);
    expect(geo.hitTest(list, [300, 150], 1)?.id).toBe(1);
    expect(geo.hitTest(list, [250, 150], 1)).toBeNull();
  });

  it("moved, its size kept, never off the page; a pen stroke moves all its points", () => {
    near(geo.moveShape(shape("rect", [[100, 100], [200, 150]]), 10, -5, PAGE).points, [[110, 95], [210, 145]]);
    near(geo.moveShape(shape("rect", [[500, 100], [580, 150]]), 50, 0, PAGE).points, [[520, 100], [600, 150]]);
    near(geo.moveShape(shape("pen", [[10, 10], [30, 40], [50, 20]]), -20, 0, PAGE).points, [[0, 10], [20, 40], [40, 20]]);
    const still = shape("rect", [[0, 0], [10, 10]]);
    expect(geo.moveShape(still, -5, -5, PAGE)).toBe(still);
  });

  it("a box resized by a handle; a pen stroke scales its points with its box, a flat one stays straight", () => {
    near(geo.resizeShape(shape("rect", [[100, 100], [200, 150]]), "se", [250, 180], PAGE, 2).points, [[100, 100], [250, 180]]);
    near(geo.resizeShape(shape("highlight", [[100, 100], [200, 150]]), "w", [50, 400], PAGE, 2).points, [[50, 100], [200, 150]]);
    // An edge stops short of crossing the other one.
    near(geo.resizeShape(shape("rect", [[100, 100], [200, 150]]), "e", [20, 0], PAGE, 2).points, [[100, 100], [102, 150]]);
    near(geo.resizeShape(shape("ellipse", [[100, 100], [200, 150]]), "nw", [-30, -30], PAGE, 2).points, [[0, 0], [200, 150]]);
    const pen = shape("pen", [[100, 100], [150, 120], [200, 100]]);
    near(geo.resizeShape(pen, "se", [300, 140], PAGE, 2).points, [[100, 100], [200, 140], [300, 100]]);
    const flat = shape("pen", [[100, 100], [150, 100], [200, 100]]);
    near(geo.resizeShape(flat, "s", [150, 150], PAGE, 2).points, flat.points);
    near(geo.resizeShape(flat, "e", [300, 100], PAGE, 2).points, [[100, 100], [200, 100], [300, 100]]);
  });

  it("a line's end dragged: on the page, Shift at 45° about the other end, never shorter than the minimum", () => {
    const l = shape("line", [[100, 100], [200, 100]], { heads: 1 });
    near(geo.moveEnd(l, 1, [250, 160], PAGE, false, 2).points, [[100, 100], [250, 160]]);
    near(geo.moveEnd(l, 1, [250, 160], PAGE, true, 2).points, [[100, 100], [100 + Math.hypot(150, 60), 100]]);
    near(geo.moveEnd(l, 0, [-50, 120], PAGE, false, 2).points, [[0, 120], [200, 100]]);
    near(geo.moveEnd(l, 1, [700, 100], PAGE, false, 2).points, [[100, 100], [600, 100]]);
    expect(geo.moveEnd(l, 1, [101, 100], PAGE, false, 2)).toBe(l);
    expect(geo.moveEnd(l, 1, [250, 160], PAGE, false, 2).heads).toBe(1);
  });

  it("Alt + arrows: a box wider or taller from its top-left corner, a line's end moved", () => {
    near(geo.stretchShape(shape("rect", [[100, 100], [200, 150]]), 10, 0, PAGE, 2).points, [[100, 100], [210, 150]]);
    near(geo.stretchShape(shape("rect", [[100, 100], [200, 150]]), 0, -60, PAGE, 2).points, [[100, 100], [200, 102]]);
    near(geo.stretchShape(shape("line", [[100, 100], [200, 100]]), 0, 10, PAGE, 2).points, [[100, 100], [200, 110]]);
  });

  it("scaled about its middle, moved back onto the page; not when it would not fit or get too small", () => {
    const r = shape("rect", [[100, 100], [200, 150]]);
    const w = 100 / 0.9, h = 50 / 0.9;
    near(geo.scaleShape(r, 1 / 0.9, PAGE, 2).points, [[150 - w / 2, 125 - h / 2], [150 + w / 2, 125 + h / 2]]);
    near(geo.scaleShape(shape("rect", [[0, 0], [100, 50]]), 1.1, PAGE, 2).points, [[0, 0], [110, 55]]);
    const big = shape("rect", [[0, 0], [600, 700]]);
    expect(geo.scaleShape(big, 1.2, PAGE, 2)).toBe(big);
    const thin = shape("rect", [[100, 100], [102, 150]]);
    expect(geo.scaleShape(thin, 0.9, PAGE, 2)).toBe(thin);
    near(geo.scaleShape(shape("line", [[100, 100], [200, 100]]), 2, PAGE, 2).points, [[50, 100], [250, 100]]);
    near(geo.scaleShape(shape("pen", [[100, 100], [150, 150], [200, 100]]), 0.5, PAGE, 2).points, [[125, 112.5], [150, 137.5], [175, 112.5]]);
  });

  it("what changed: moved, resized, restyled, or nothing", () => {
    const r = shape("rect", [[100, 100], [200, 150]]);
    expect(geo.changeOf(r, { ...r })).toBeNull();
    expect(geo.changeOf(r, geo.moveShape(r, 5, 5, PAGE))).toBe("moved");
    expect(geo.changeOf(r, geo.stretchShape(r, 5, 0, PAGE, 2))).toBe("resized");
    expect(geo.changeOf(r, { ...r, color: [1, 0, 0] })).toBe("restyled");
    expect(geo.changeOf(r, { ...r, dash: "dotted" })).toBe("restyled");
    expect(geo.sameShape(r, { ...r, points: [[100.0001, 100], [200, 150]] })).toBe(true);
  });
});

describe("SL2 the actions", () => {
  it("the next shape takes the style chosen: an arrow is a line with heads, the highlighter its own colour, no width, solid", () => {
    const style = { color: "red", highlight: "green", width: 4, dash: "dashed", heads: 2 } as const;
    const pts: P[] = [[0, 0], [10, 10]];
    expect(shapes.newShape("arrow", pts, style)).toEqual({ kind: "line", points: pts, color: state.SHAPE_COLORS.red, width: 4, dash: "dashed", heads: 2 });
    expect(shapes.newShape("line", pts, style).heads).toBe(0);
    expect(shapes.newShape("highlight", pts, style)).toEqual({ kind: "highlight", points: pts, color: state.SHAPE_COLORS.green, width: 0, dash: "solid", heads: 0 });
    expect(shapes.newShape("pen", pts, style)).toMatchObject({ kind: "pen", width: 4, dash: "solid", heads: 0 });
    expect(shapes.colorOf(state.SHAPE_COLORS.blue)).toBe("blue");
    expect(shapes.colorOf([0.9, 0.2, 0.1])).toBe("red");
  });

  it("names: by kind, colour (agreeing in Italian) and line style; with their size", () => {
    const c = state.SHAPE_COLORS;
    const arrow = shape("line", [[100, 100], [100 + 40 * MM, 100]], { color: c.red, heads: 1 });
    const rect = shape("rect", [[0, 0], [30 * MM, 20 * MM]], { color: c.blue, dash: "dashed" });
    i18n.setLocale("it");
    expect(shapes.shapeName(arrow)).toBe("Freccia rossa");
    expect(shapes.shapeName(rect)).toBe("Rettangolo blu tratteggiato");
    expect(shapes.shapeName(shape("line", [[0, 0], [9, 9]], { color: c.green, heads: 2, dash: "dotted" }))).toBe("Freccia doppia verde punteggiata");
    expect(shapes.shapeName(shape("highlight", [[0, 0], [9, 9]], { color: c.yellow, width: 0 }))).toBe("Evidenziazione gialla");
    expect(shapes.shapeName(shape("pen", [[0, 0], [9, 9]]))).toBe("Tratto a mano libera nero");
    expect(shapes.shapeName(shape("ellipse", [[0, 0], [9, 9]]))).toBe("Ellisse nera");
    expect(shapes.shapeLabel(arrow)).toBe("Freccia rossa, 40 mm");
    expect(shapes.shapeLabel(rect)).toBe("Rettangolo blu tratteggiato, 30 × 20 mm");
    expect(shapes.addedText(shape("line", [[0, 0], [9, 9]], { heads: 2 }))).toBe("Freccia aggiunta");
    expect(shapes.addedText(rect)).toBe("Rettangolo aggiunto");
    // Where it is (said after a move or a resize): from the page's left and top.
    expect(shapes.placedText(arrow, [50, 0, 650, 800])).toBe(`Freccia rossa, 40 mm, a ${i18n.formatMm(50)} mm da sinistra e ${i18n.formatMm(100)} mm dall'alto`);
    i18n.setLocale("en");
    expect(shapes.placedText(rect, PAGE)).toBe("Blue dashed rectangle, 30 × 20 mm, 0 mm from the left, 0 mm from the top");
    expect(shapes.shapeName(arrow)).toBe("Red arrow");
    expect(shapes.shapeName(rect)).toBe("Blue dashed rectangle");
    expect(shapes.shapeLabel(shape("line", [[0, 0], [10 * MM, 0]]))).toBe("Black line, 10 mm");
  });

  it("Forme is on only in Modifica with its sub-tool; a page's shapes are read once per revision", async () => {
    const d = await inShapes("read.pdf");
    expect(shapes.shapesMode.value).toBe(true);
    const page = d.pages[1];
    shapes.ensureShapes(page);
    shapes.ensureShapes(page);
    await settle();
    expect(calls.filter((x) => x[0] === "shapes")).toEqual([["shapes", 1]]);
    expect(shapes.pageShapes(page).value).toEqual({ rev: page.rev.peek(), shapes: [] });
    await actions.setEditTool("change");
    expect(shapes.shapesMode.value).toBe(false);
    await actions.setTool(null);
  });

  it("adding writes one edit, the new shape selected; deleting deselects it; each said in the status region", async () => {
    const d = await inShapes("add.pdf");
    const page = d.pages[0];
    const rev = page.rev.peek();
    const s = shape("rect", [[10, 10], [100, 60]]);
    const id = await shapes.addShape(page, s);
    expect(calls).toEqual([["addShape", 0, s]]);
    expect(page.rev.peek()).toBe(rev + 1);
    expect(state.selectedShape.value).toEqual({ pageIndex: 0, id });
    expect(state.history.value.editCount).toBe(1);
    expect(await shapes.editShape(page, id!, null)).toBe(true);
    expect(calls.at(-1)).toEqual(["editShape", 0, id, null]);
    expect(state.selectedShape.value).toBeNull();
    shapes.sayShape(0, "Shape deleted");
    shapes.sayShape(0, "Shape deleted");
    expect(shapes.shapeSaid.value?.text).toBe("Shape deleted");
    await actions.setTool(null);
  });

  it("a pen stroke or a highlight added selects nothing; a delete drops the shape from the page's shapes at once; the lines are kept", async () => {
    const d = await inShapes("cache.pdf");
    const page = d.pages[0];
    const infos = given(page, [shape("rect", [[10, 10], [100, 60]]), shape("line", [[10, 100], [100, 100]])]);
    const lines = [{ index: 0, text: "Mario Rossi", bbox: [50, 300, 250, 312], dir: [1, 0], size: 12 }] as any;
    page.lines.value = { rev: page.rev.peek(), lines };
    const rev = page.rev.peek();
    state.selectedShape.value = { pageIndex: 0, id: 1 };
    expect(await shapes.editShape(page, 1, null)).toBe(true);
    expect(state.selectedShape.value).toBeNull();
    // What reading them again gives (ids are stable): no stale button of the shape deleted.
    expect(shapes.pageShapes(page).value).toEqual({ rev: rev + 1, shapes: [infos[1]] });
    expect(page.lines.value).toEqual({ rev: rev + 1, lines });
    state.selectedShape.value = { pageIndex: 0, id: 2 };
    expect(await shapes.addShape(page, shape("pen", [[10, 10], [20, 30]]), false)).not.toBeNull();
    expect(state.selectedShape.value).toBeNull();
    expect(page.lines.value).toEqual({ rev: rev + 2, lines });
    // Shapes not read at the page's revision are left to be read again.
    expect(await shapes.editShape(page, 2, null)).toBe(true);
    expect(shapes.pageShapes(page).value?.rev).toBe(rev + 1);
    await actions.setTool(null);
  });

  it("a selection made while a shape is written stays: not dropped by a stroke, not replaced by a new box", async () => {
    const d = await inShapes("race.pdf");
    const page = d.pages[0];
    let open!: () => void;
    addGate = new Promise<void>((resolve) => { open = () => resolve(); });
    const stroke = shapes.addShape(page, shape("pen", [[10, 10], [20, 30]]), false);
    const box = shapes.addShape(page, shape("rect", [[10, 10], [100, 60]]));
    state.selectedShape.value = { pageIndex: 0, id: 1 }; // the user picks a shape meanwhile
    open();
    expect(await stroke).not.toBeNull();
    expect(await box).not.toBeNull();
    expect(state.selectedShape.value).toEqual({ pageIndex: 0, id: 1 });
    // Two boxes drawn quickly, the second while the first is written: the last one is selected.
    state.selectedShape.value = null;
    addGate = new Promise<void>((resolve) => { open = () => resolve(); });
    const first = shapes.addShape(page, shape("rect", [[10, 10], [100, 60]]));
    const second = shapes.addShape(page, shape("rect", [[200, 10], [300, 60]]));
    open();
    const [a, b] = [await first, await second];
    expect(a).not.toBe(b);
    expect(state.selectedShape.value).toEqual({ pageIndex: 0, id: b });
    state.selectedShape.value = null;
    await actions.setTool(null);
  });

  it("refusals are said in words and select nothing", async () => {
    const d = await inShapes("refused.pdf");
    addFails = new client.EngineError("Refused", "not-editable");
    expect(await shapes.addShape(d.pages[0], shape("rect", [[10, 10], [100, 60]]))).toBeNull();
    addFails = new client.EngineError("Bad", "bad-request");
    expect(await shapes.addShape(d.pages[0], shape("rect", [[10, 10], [100, 60]]))).toBeNull();
    expect(toastTexts()).toEqual([i18n.t("shapes.notEditable"), i18n.t("shapes.badShape")]);
    expect(state.selectedShape.value).toBeNull();
    await actions.setTool(null);
  });

  it("“Metti al centro” puts a default shape of the kind chosen in the middle of what shows, selected; not the pen", async () => {
    const d = await inShapes("centre.pdf");
    state.shapeKind.value = "ellipse";
    state.currentPage.value = 1;
    state.shapeCentreRequest.value++;
    await settle();
    await settle();
    const [call] = calls.filter((x) => x[0] === "addShape");
    expect(call[1]).toBe(1);
    expect(call[2].kind).toBe("ellipse");
    near(call[2].points, [[300 - 15 * MM, 400 - 10 * MM], [300 + 15 * MM, 400 + 10 * MM]]);
    expect(state.selectedShape.value?.pageIndex).toBe(1);
    expect(shapes.shapeSaid.value).toMatchObject({ pageIndex: 1, text: "Ellipse added" });
    calls.length = 0;
    state.shapeKind.value = "pen";
    state.shapeCentreRequest.value++;
    await settle();
    expect(calls).toEqual([]);
    state.shapeKind.value = "rect";
    state.currentPage.value = 0;
    expect(d.pages.length).toBe(2);
    await actions.setTool(null);
  });
});

describe("SL3 the layer and the frame, as they render", () => {
  function nodes(node: any): any[] {
    if (node == null || typeof node !== "object") return [];
    if (Array.isArray(node)) return node.flatMap(nodes);
    return [node, ...nodes(node.props?.children)];
  }
  /** A component called as a function, its i-th useState giving `states[i]` when set. */
  function render(component: any, props: any, states: unknown[] = []) {
    hooks.at = 0;
    hooks.states = states;
    hooks.sets = [];
    return component(props);
  }
  const named = (out: any, name: string) => nodes(out).filter((n) => typeof n.type === "function" && n.type.name === name);
  const catcherOf = (out: any) => nodes(out).find((n) => String(n.props?.class).startsWith("shapes-catcher"));
  const el = { setPointerCapture: () => undefined, hasPointerCapture: () => false, releasePointerCapture: () => undefined };
  const ptr = (x: number, y: number, extra: Record<string, unknown> = {}) => ({
    pointerId: 1, pointerType: "mouse", button: 0, isPrimary: true, clientX: x, clientY: y, shiftKey: false,
    currentTarget: el, preventDefault: () => undefined, stopPropagation: () => undefined, ...extra,
  });
  const key = (k: string, extra: Record<string, unknown> = {}) => ({
    key: k, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, preventDefault: () => undefined, stopPropagation: () => undefined, ...extra,
  });
  const added = () => calls.filter((c) => c[0] === "addShape").map((c) => c[2]);

  it("each shape is a button named by what it is, in painting order; the selected one is its frame", async () => {
    const d = await inShapes("buttons.pdf");
    const page = d.pages[0];
    const infos = given(page, [
      shape("line", [[100, 100], [200, 100]], { color: state.SHAPE_COLORS.red, heads: 1 }),
      shape("rect", [[50, 300], [150, 350]], { color: state.SHAPE_COLORS.blue, dash: "dashed" }),
    ]);
    let out = render(layer.ShapeLayer, { page, zoom: 1, canvasRev: page.rev.peek() });
    expect(named(out, "ShapeBox").map((n) => n.props.info.id)).toEqual([1, 2]);
    const box = render(named(out, "ShapeBox")[1].type, named(out, "ShapeBox")[1].props);
    expect(box.props["aria-label"]).toBe(`Blue dashed rectangle, ${i18n.formatMm(100)} × ${i18n.formatMm(50)} mm`);
    expect(box.props["data-shape"]).toBe(2);
    expect(catcherOf(out).props["aria-hidden"]).toBe("true");
    state.selectedShape.value = { pageIndex: 0, id: 1 };
    out = render(layer.ShapeLayer, { page, zoom: 1, canvasRev: page.rev.peek() });
    expect(named(out, "ShapeBox").map((n) => n.props.info.id)).toEqual([2]);
    expect(named(out, "SelectedShape").map((n) => n.props.info)).toEqual([infos[0]]);
    state.selectedShape.value = null;
    await actions.setTool(null);
  });

  it("a mouse drag draws a rectangle, written on release; Shift with the arrow snaps it to 45°", async () => {
    const d = await inShapes("drag.pdf");
    const page = d.pages[0];
    given(page, []);
    state.shapeKind.value = "rect";
    let c = catcherOf(render(layer.ShapeLayer, { page, zoom: 1, canvasRev: 0 }));
    c.props.onPointerDown(ptr(100, 100));
    c.props.onPointerMove(ptr(101, 101)); // under the threshold: still a click
    c.props.onPointerMove(ptr(200, 160));
    c.props.onPointerUp(ptr(200, 160));
    c.props.onClick(ptr(200, 160)); // the click after a drag is no click
    await settle();
    expect(added()).toEqual([shapes.newShape("rect", [[100, 100], [200, 160]])]);
    expect(state.selectedShape.value).toEqual({ pageIndex: 0, id: expect.any(Number) });
    calls.length = 0;
    state.shapeKind.value = "arrow";
    c = catcherOf(render(layer.ShapeLayer, { page, zoom: 1, canvasRev: 0 }));
    c.props.onPointerDown(ptr(100, 100));
    c.props.onPointerMove(ptr(200, 190, { shiftKey: true }));
    c.props.onPointerUp(ptr(200, 190, { shiftKey: true }));
    await settle();
    const [arrow] = added();
    expect(arrow).toMatchObject({ kind: "line", heads: state.shapeStyle.value.heads });
    expect(arrow.points[1][0] - 100).toBeCloseTo(arrow.points[1][1] - 100, 6);
    // A press too short to draw, then the click: on the empty page with a mouse it only deselects.
    calls.length = 0;
    c = catcherOf(render(layer.ShapeLayer, { page, zoom: 1, canvasRev: 0 }));
    c.props.onPointerDown(ptr(300, 300));
    c.props.onPointerUp(ptr(300, 300));
    c.props.onClick(ptr(300, 300));
    await settle();
    expect(added()).toEqual([]);
    expect(state.selectedShape.value).toBeNull();
    state.shapeKind.value = "rect";
    await actions.setTool(null);
  });

  it("a tap on the empty page puts the default shape there; a tap on a shape selects it", async () => {
    const d = await inShapes("tap.pdf");
    const page = d.pages[0];
    given(page, [shape("rect", [[100, 100], [200, 150]])]);
    state.shapeKind.value = "line";
    let c = catcherOf(render(layer.ShapeLayer, { page, zoom: 1, canvasRev: 0 }));
    c.props.onPointerDown(ptr(300, 400, { pointerType: "touch" })); // one finger: the page scrolls, nothing drawn
    c.props.onClick(ptr(300, 400));
    await settle();
    expect(added()).toEqual([shapes.newShape("line", geo.defaultPoints("line", [300, 400], PAGE) as P[])]);
    state.selectedShape.value = null;
    calls.length = 0;
    given(page, [shape("rect", [[100, 100], [200, 150]])]); // read again at the page's new revision
    c = catcherOf(render(layer.ShapeLayer, { page, zoom: 1, canvasRev: 0 }));
    c.props.onPointerDown(ptr(150, 101, { pointerType: "touch" }));
    c.props.onClick(ptr(150, 101));
    expect(state.selectedShape.value).toEqual({ pageIndex: 0, id: 1 });
    // A tap away first drops the selection, the next one places.
    c.props.onClick(ptr(400, 600));
    await settle();
    expect(state.selectedShape.value).toBeNull();
    expect(added()).toEqual([]);
    state.shapeKind.value = "rect";
    await actions.setTool(null);
  });

  const MARIO = { index: 0, text: "Mario Rossi", bbox: [50, 100, 250, 112], dir: [1, 0], size: 12 };

  it("the highlighter: a click on a text line highlights the line, padded, and selects nothing: the next line follows", async () => {
    const d = await inShapes("line.pdf");
    const page = d.pages[0];
    given(page, []);
    page.lines.value = { rev: page.rev.peek(), lines: [MARIO] as any };
    state.shapeKind.value = "highlight";
    const c = catcherOf(render(layer.ShapeLayer, { page, zoom: 1, canvasRev: 0 }));
    c.props.onClick(ptr(120, 106));
    // A double click: its second click writes no second highlight over the first (still being written).
    c.props.onClick({ ...ptr(120, 106), detail: 2 });
    await settle();
    expect(added()).toEqual([shapes.newShape("highlight", [[49, 99], [251, 113]])]);
    expect(state.selectedShape.value).toBeNull();
    state.shapeKind.value = "rect";
    await actions.setTool(null);
  });

  it("the highlighter on touch: a tap on a text line near a shape highlights the line; off the lines a finger still reaches the shape", async () => {
    const d = await inShapes("near.pdf");
    const page = d.pages[0];
    given(page, [shape("line", [[50, 115], [250, 115]], { width: 1 })]); // an underline
    const lines = [{ ...MARIO, bbox: [50, 86, 250, 98] }, MARIO];
    page.lines.value = { rev: page.rev.peek(), lines: lines as any };
    state.shapeKind.value = "highlight";
    const z = 0.63;
    const tap = (x: number, y: number) => {
      const c = catcherOf(render(layer.ShapeLayer, { page, zoom: z, canvasRev: 0 }));
      c.props.onPointerDown(ptr(x * z, y * z, { pointerType: "touch" }));
      c.props.onClick(ptr(x * z, y * z));
    };
    tap(150, 92); // the line above the underlined one, 23 pt (14.5 px) from the underline
    tap(150, 106); // the underlined line itself
    await settle();
    expect(added()).toEqual([shapes.newShape("highlight", [[49, 85], [251, 99]]), shapes.newShape("highlight", [[49, 99], [251, 113]])]);
    expect(state.selectedShape.value).toBeNull();
    given(page, [shape("line", [[50, 115], [250, 115]], { width: 1 })]); // read again at the page's new revision
    tap(150, 115 + 15 / z); // below the lines, 15 px from the underline
    expect(state.selectedShape.value).toEqual({ pageIndex: 0, id: 1 });
    state.selectedShape.value = null;
    state.shapeKind.value = "rect";
    await actions.setTool(null);
  });

  it("the highlighter: a click before the page's lines are read waits for them", async () => {
    const d = await inShapes("wait.pdf");
    const page = d.pages[0];
    given(page, []);
    page.lines.value = null;
    engineLines = [MARIO];
    state.shapeKind.value = "highlight";
    const c = catcherOf(render(layer.ShapeLayer, { page, zoom: 1, canvasRev: 0 }));
    c.props.onClick(ptr(120, 106));
    expect(added()).toEqual([]);
    await vi.waitFor(() => expect(added()).toEqual([shapes.newShape("highlight", [[49, 99], [251, 113]])]));
    expect(calls.filter((x) => x[0] === "lines")).toEqual([["lines", 0]]);
    state.shapeKind.value = "rect";
    await actions.setTool(null);
  });

  it("Esc during a drag gives it up, and the click of its release does nothing", async () => {
    const d = await inShapes("esc.pdf");
    const page = d.pages[0];
    given(page, []);
    page.lines.value = { rev: page.rev.peek(), lines: [MARIO] as any };
    state.shapeKind.value = "highlight";
    const c = catcherOf(render(layer.ShapeLayer, { page, zoom: 1, canvasRev: 0 }));
    c.props.onPointerDown(ptr(60, 106));
    c.props.onPointerMove(ptr(200, 108));
    fire("keydown", key("Escape"));
    c.props.onPointerUp(ptr(120, 106));
    c.props.onLostPointerCapture(ptr(120, 106));
    c.props.onClick(ptr(120, 106));
    await settle();
    expect(added()).toEqual([]);
    // The next press is a click again.
    c.props.onPointerDown(ptr(120, 106));
    c.props.onPointerUp(ptr(120, 106));
    c.props.onClick(ptr(120, 106));
    await settle();
    expect(added()).toEqual([shapes.newShape("highlight", [[49, 99], [251, 113]])]);
    state.shapeKind.value = "rect";
    await actions.setTool(null);
  });

  it("the pen draws with one finger, its points thinned; a second finger gives the stroke up", async () => {
    const d = await inShapes("pen.pdf");
    const page = d.pages[0];
    given(page, []);
    state.shapeKind.value = "pen";
    const out = render(layer.ShapeLayer, { page, zoom: 1, canvasRev: 0 });
    expect(out.props.class).toBe("shapes-layer is-pen");
    let c = catcherOf(out);
    const touch = { pointerType: "touch" };
    c.props.onPointerDown(ptr(100, 100, touch));
    const coalesced = [ptr(100.5, 100, touch), ptr(101, 100, touch), ptr(110, 100, touch), ptr(115, 100, touch)];
    c.props.onPointerMove(ptr(115, 100, { ...touch, getCoalescedEvents: () => coalesced }));
    c.props.onPointerUp(ptr(120, 100, touch));
    await settle();
    expect(added().map((s) => s.points)).toEqual([[[100, 100], [101, 100], [110, 100], [115, 100], [120, 100]]]);
    expect(added()[0]).toMatchObject({ kind: "pen", dash: "solid", heads: 0 });
    // Not selected: the next stroke may start inside this one's box.
    expect(state.selectedShape.value).toBeNull();
    calls.length = 0;
    c = catcherOf(render(layer.ShapeLayer, { page, zoom: 1, canvasRev: 0 }));
    c.props.onPointerDown(ptr(100, 100, touch));
    c.props.onPointerMove(ptr(130, 100, touch));
    fire("pointerdown", { pointerId: 2 }); // the pinch begins
    c.props.onPointerUp(ptr(140, 100, touch));
    await settle();
    expect(added()).toEqual([]);
    expect(winListeners.get("pointerdown")?.size ?? 0).toBe(0);
    state.shapeKind.value = "rect";
    await actions.setTool(null);
  });

  it("the pen draws a dot and a short accent with a finger or a stylus; a tap on a shape selects it", async () => {
    const d = await inShapes("dots.pdf");
    const page = d.pages[0];
    given(page, [shape("line", [[100, 300], [300, 300]])]);
    state.shapeKind.value = "pen";
    for (const pointerType of ["touch", "pen"]) {
      calls.length = 0;
      given(page, [shape("line", [[100, 300], [300, 300]])]);
      const c = catcherOf(render(layer.ShapeLayer, { page, zoom: 1, canvasRev: 0 }));
      const tp = { pointerType };
      c.props.onPointerDown(ptr(100, 100, tp)); // a dot
      c.props.onPointerUp(ptr(100, 100, tp));
      c.props.onClick(ptr(100, 100));
      c.props.onPointerDown(ptr(200, 100, tp)); // an accent, 6 px
      c.props.onPointerMove(ptr(203, 98, tp));
      c.props.onPointerUp(ptr(205, 97, tp));
      c.props.onClick(ptr(205, 97));
      await settle();
      expect(added().map((s) => s.points)).toEqual([[[100, 100], [101.01, 100]], [[200, 100], [203, 98], [205, 97]]]);
      expect(state.selectedShape.value).toBeNull();
      // A dot 12 px from a stroke whose tap's click comes late (after timers ran): written once, nothing selected.
      calls.length = 0;
      c.props.onPointerDown(ptr(150, 288, tp));
      c.props.onPointerUp(ptr(150, 288, tp));
      await settle();
      c.props.onClick(ptr(150, 288));
      await settle();
      expect(added().map((s) => s.points)).toEqual([[[150, 288], [151.01, 288]]]);
      expect(state.selectedShape.value).toBeNull();
    }
    calls.length = 0;
    given(page, [shape("line", [[100, 300], [300, 300]])]);
    const c = catcherOf(render(layer.ShapeLayer, { page, zoom: 1, canvasRev: 0 }));
    c.props.onPointerDown(ptr(200, 301, { pointerType: "touch" }));
    c.props.onPointerUp(ptr(200, 301, { pointerType: "touch" }));
    c.props.onClick(ptr(200, 301));
    await settle();
    expect(added()).toEqual([]);
    expect(state.selectedShape.value).toEqual({ pageIndex: 0, id: 1 });
    // An accent begun on that line is drawn: past 3 px a finger draws, it is no tap.
    state.selectedShape.value = null;
    const c2 = catcherOf(render(layer.ShapeLayer, { page, zoom: 1, canvasRev: 0 }));
    c2.props.onPointerDown(ptr(200, 301, { pointerType: "touch" }));
    c2.props.onPointerMove(ptr(203, 297, { pointerType: "touch" }));
    c2.props.onPointerUp(ptr(206, 295, { pointerType: "touch" }));
    c2.props.onClick(ptr(206, 295));
    await settle();
    expect(added().map((s) => s.points)).toEqual([[[200, 301], [203, 297], [206, 295]]]);
    expect(state.selectedShape.value).toBeNull();
    state.shapeKind.value = "rect";
    await actions.setTool(null);
  });

  it("the pen: a dot next to a stroke is drawn, a tap selects only on the ink; with one selected, a tap off the ink drops it", async () => {
    const d = await inShapes("ink.pdf");
    const page = d.pages[0];
    state.shapeKind.value = "pen";
    const tapAt = (zoom: number, x: number, y: number, pointerType = "mouse") => {
      const c = catcherOf(render(layer.ShapeLayer, { page, zoom, canvasRev: 0 }));
      c.props.onPointerDown(ptr(x * zoom, y * zoom, { pointerType }));
      c.props.onPointerUp(ptr(x * zoom, y * zoom, { pointerType }));
      c.props.onClick(ptr(x * zoom, y * zoom));
    };
    const z = 4 / 3;
    // A full stop 4 px below a 2 pt stroke (3 px from its ink): a dot, nothing selected.
    given(page, [shape("pen", [[100, 300], [200, 300]])]);
    tapAt(z, 150, 303);
    // "..": the next dot 5 px from the last one.
    given(page, [shape("pen", [[100, 100], [101.01, 100]])]);
    const x = 101.01 + 5 / z;
    tapAt(z, x, 100);
    await settle();
    const dots = added().map((s) => s.points);
    expect(dots.length).toBe(2);
    near(dots[0], [[150, 303], [151.01, 303]]);
    near(dots[1], [[x, 100], [x + 1.01, 100]]);
    expect(state.selectedShape.value).toBeNull();
    // On the ink: selected.
    calls.length = 0;
    given(page, [shape("pen", [[100, 300], [200, 300]])]);
    tapAt(z, 150, 301);
    expect(state.selectedShape.value).toEqual({ pageIndex: 0, id: 1 });
    // Selected, on a phone: a tap 12 px from it drops it, and draws nothing.
    tapAt(0.63, 150, 300 + 12 / 0.63, "touch");
    await settle();
    expect(state.selectedShape.value).toBeNull();
    expect(added()).toEqual([]);
    // Its frame lets the next stroke through, but on its handles and grip (shapes.css).
    const css = readFileSync(new URL("../src/styles/shapes.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).toMatch(/\.shapes-layer\.is-pen \.shape-frame\s*\{\s*pointer-events: none;\s*\}/);
    expect(css).toMatch(/\.shapes-layer\.is-pen \.shape-frame > \.image-grip\s*\{\s*pointer-events: auto;\s*\}/);
    state.shapeKind.value = "rect";
    await actions.setTool(null);
  });

  it("with the pen, a selected stroke's frame lets presses through: a mouse press on its ink moves it, one beside it draws", async () => {
    const d = await inShapes("pen-grab.pdf");
    const page = d.pages[0];
    const [info] = given(page, [shape("pen", [[100, 100], [150, 150], [200, 100]])]);
    state.selectedShape.value = { pageIndex: 0, id: 1 };
    state.shapeKind.value = "pen";
    const layerOut = () => {
      const out = render(layer.ShapeLayer, { page, zoom: 1, canvasRev: 0 });
      const sel = named(out, "SelectedShape")[0];
      render(sel.type, sel.props); // it hands the stroke over to the layer
      return catcherOf(out);
    };
    let c = layerOut();
    c.props.onPointerDown(ptr(187.5, 112.5)); // on its last, straight piece
    c.props.onPointerMove(ptr(197.5, 112.5));
    c.props.onPointerUp(ptr(197.5, 112.5));
    c.props.onClick(ptr(197.5, 112.5));
    await settle();
    expect(calls).toEqual([["editShape", 0, 1, { ...info.shape, points: [[110, 100], [160, 150], [210, 100]] }]]);
    calls.length = 0;
    given(page, [info.shape]);
    c = layerOut();
    c.props.onPointerDown(ptr(150, 105)); // in its box, off the ink
    c.props.onPointerMove(ptr(170, 115));
    c.props.onPointerUp(ptr(170, 115));
    await settle();
    expect(added().map((s) => s.points)).toEqual([[[150, 105], [170, 115]]]);
    expect(calls.filter((x) => x[0] === "editShape")).toEqual([]);
    state.selectedShape.value = null;
    state.shapeKind.value = "rect";
    await actions.setTool(null);
  });

  it("a selected line's frame lets presses through: one on the line moves it, one beside it draws", async () => {
    const d = await inShapes("grab.pdf");
    const page = d.pages[0];
    const [info] = given(page, [shape("line", [[100, 100], [300, 200]], { heads: 1 })]);
    state.selectedShape.value = { pageIndex: 0, id: 1 };
    state.shapeKind.value = "rect";
    const layerOut = () => {
      const out = render(layer.ShapeLayer, { page, zoom: 1, canvasRev: 0 });
      const sel = named(out, "SelectedShape")[0];
      render(sel.type, sel.props); // it hands its line over to the layer
      return catcherOf(out);
    };
    let c = layerOut();
    c.props.onPointerDown(ptr(200, 150)); // on the line
    c.props.onPointerMove(ptr(220, 150));
    c.props.onPointerUp(ptr(220, 150));
    c.props.onClick(ptr(220, 150));
    await settle();
    expect(calls).toEqual([["editShape", 0, 1, { ...info.shape, points: [[120, 100], [320, 200]] }]]);
    calls.length = 0;
    given(page, [info.shape]);
    c = layerOut();
    c.props.onPointerDown(ptr(120, 180)); // in its box, off the line
    c.props.onPointerMove(ptr(180, 230));
    c.props.onPointerUp(ptr(180, 230));
    await settle();
    expect(added()).toEqual([shapes.newShape("rect", [[120, 180], [180, 230]])]);
    expect(calls.filter((x) => x[0] === "editShape")).toEqual([]);
    // A finger or a stylus on the line, where pointers are fine (a touch laptop): the page's, as
    // anywhere else on it (it scrolls), not a move the browser would cancel.
    calls.length = 0;
    given(page, [info.shape]);
    state.selectedShape.value = { pageIndex: 0, id: 1 }; // (the rectangle drawn took the selection)
    c = layerOut();
    for (const pointerType of ["touch", "pen"]) {
      c.props.onPointerDown(ptr(200, 150, { pointerType }));
      c.props.onPointerMove(ptr(220, 170, { pointerType }));
      c.props.onPointerUp(ptr(220, 170, { pointerType }));
    }
    await settle();
    expect(calls).toEqual([]);
    state.selectedShape.value = null;
    await actions.setTool(null);
  });

  it("touch: a tap inside a box frame selects the shape under it, or drops the selection", async () => {
    const media = await import("../src/ui/media");
    media.isCoarse.value = true;
    const d = await inShapes("frame-tap.pdf");
    const page = d.pages[0];
    given(page, [shape("rect", [[100, 100], [300, 200]]), shape("line", [[150, 150], [190, 150]], { heads: 1 })]);
    const frameOf = () => {
      state.selectedShape.value = { pageIndex: 0, id: 1 };
      const sel = named(render(layer.ShapeLayer, { page, zoom: 1, canvasRev: 0 }), "SelectedShape")[0];
      const frame = nodes(render(sel.type, sel.props)).find((n) => n.props?.role === "application");
      frame.ref.current = { focus: () => undefined, closest: () => null };
      return frame;
    };
    const tap = (frame: any, x: number, y: number) => {
      frame.props.onPointerDown(ptr(x, y, { pointerType: "touch" }));
      frame.props.onClick({ ...ptr(x, y), target: frame.ref.current });
    };
    let frame = frameOf();
    tap(frame, 170, 158); // 8 px off the arrow, within a finger's reach
    expect(state.selectedShape.value).toEqual({ pageIndex: 0, id: 2 });
    frame = frameOf();
    frame.props.onPointerDown(ptr(240, 160, { pointerType: "touch" }));
    frame.props.onClick({ ...ptr(240, 160), target: {} }); // on a corner target or the grip: theirs
    frame.props.onPointerDown(ptr(240, 160));
    frame.props.onClick({ ...ptr(240, 160), target: frame.ref.current }); // a mouse: onPointerUp's
    expect(state.selectedShape.value).toEqual({ pageIndex: 0, id: 1 });
    tap(frame, 240, 160); // the rectangle's empty middle
    await settle();
    expect(state.selectedShape.value).toBeNull();
    media.isCoarse.value = false;
    await actions.setTool(null);
  });

  it("the frame: keys add up and are written as one edit 600 ms after the last; Delete and Esc", async () => {
    const d = await inShapes("keys.pdf");
    const page = d.pages[0];
    const [info] = given(page, [shape("rect", [[100, 100], [200, 150]], { color: state.SHAPE_COLORS.red })]);
    state.selectedShape.value = { pageIndex: 0, id: 1 };
    const vnode = named(render(layer.ShapeLayer, { page, zoom: 1, canvasRev: 0 }), "SelectedShape")[0];
    const frameOf = () => nodes(render(vnode.type, vnode.props)).find((n) => n.props?.role === "application");
    vi.useFakeTimers();
    let frame = frameOf();
    expect(frame.props["aria-roledescription"]).toBe("movable shape");
    expect(frame.props["aria-label"]).toBe(shapes.shapeLabel(info.shape));
    expect(frame.props.children.flat().filter((n: any) => n?.props?.class?.startsWith("image-handle")).length).toBe(8);
    frame.props.onKeyDown(key("ArrowRight"));
    frame.props.onKeyDown(key("ArrowRight"));
    frame.props.onKeyDown(key("ArrowDown", { shiftKey: true }));
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(700);
    expect(calls).toEqual([["editShape", 0, 1, { ...info.shape, points: [[102, 110], [202, 160]] }]]);
    // Said with where it now is (and its size), not only that it moved.
    const mm = i18n.formatMm;
    expect(shapes.shapeSaid.value?.text).toBe(`Red rectangle, ${mm(100)} × ${mm(50)} mm, ${mm(102)} mm from the left, ${mm(110)} mm from the top`);
    // Alt + arrows stretch it; flushEditor (a download, an undo) writes it at once.
    calls.length = 0;
    frame = frameOf();
    frame.props.onKeyDown(key("ArrowRight", { altKey: true }));
    await state.flushEditor();
    expect(calls).toEqual([["editShape", 0, 1, { ...info.shape, points: [[100, 100], [201, 150]] }]]);
    expect(shapes.shapeSaid.value?.text).toBe(`Red rectangle, ${mm(101)} × ${mm(50)} mm, ${mm(100)} mm from the left, ${mm(100)} mm from the top`);
    calls.length = 0;
    frame.props.onKeyDown(key("Delete"));
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toEqual([["editShape", 0, 1, null]]);
    expect(state.selectedShape.value).toBeNull();
    expect(shapes.shapeSaid.value?.text).toBe("Shape deleted");
    state.selectedShape.value = { pageIndex: 0, id: 1 };
    frame.props.onKeyDown(key("Escape"));
    await vi.advanceTimersByTimeAsync(10);
    expect(state.selectedShape.value).toBeNull();
    vi.useRealTimers();
    await actions.setTool(null);
  });

  it("a line's frame has a handle on each end; its bar has the heads, and no width for a highlight, no line style for the pen", async () => {
    const d = await inShapes("bar.pdf");
    const page = d.pages[0];
    const infos = given(page, [
      shape("line", [[100, 100], [300, 100]], { color: state.SHAPE_COLORS.red, heads: 1 }),
      shape("highlight", [[100, 200], [300, 220]], { color: state.SHAPE_COLORS.yellow, width: 0 }),
      shape("pen", [[100, 300], [150, 340], [200, 300]]),
    ]);
    const selected = (info: any) => {
      state.selectedShape.value = { pageIndex: 0, id: info.id };
      const vnode = named(render(layer.ShapeLayer, { page, zoom: 1, canvasRev: 0 }), "SelectedShape")[0];
      return render(vnode.type, vnode.props);
    };
    const groups = (out: any) => named(out, "Radios").map((n) => [n.props.label, n.props.options.map((o: any) => o.label), n.props.value]);

    const line = selected(infos[0]);
    const frame = nodes(line).find((n) => n.props?.role === "application");
    expect(frame.props.class).toContain("is-line");
    expect(frame.props.children.flat().filter((n: any) => n?.props?.class === "image-handle shape-end").length).toBe(2);
    expect(groups(line)).toEqual([
      ["Colour", ["Black", "Red", "Blue", "Green", "Yellow"], "red"],
      ["Thickness", ["1 pt", "2 pt", "4 pt"], 2],
      ["Line style", ["Solid", "Dashed", "Dotted"], "solid"],
      ["Arrow heads", ["No heads", "Head at the end", "Heads at both ends"], 1],
    ]);
    const nudges = nodes(line).filter((n) => n.type === nudge.NudgeControls);
    expect(nudges.length).toBe(1);
    expect(typeof nudges[0].props.onScale).toBe("function");
    expect([typeof nudges[0].props.onStretch, nudges[0].props.stretchEnd]).toEqual(["function", true]);
    expect(nudges[0].props.disabled).toBe(false);
    // Elimina and Deseleziona come after the toggle and before its row (Tab reaches the row last).
    expect([nudges[0].props.children].flat().map((b: any) => b.props.class)).toEqual(["btn context-btn", "btn btn-primary context-btn"]);
    expect(groups(selected(infos[1]))).toEqual([["Colour", ["Yellow", "Green", "Blue", "Red"], "yellow"]]);
    expect(groups(selected(infos[2])).map((g) => g[0])).toEqual(["Colour", "Thickness"]);
    state.selectedShape.value = null;
    await actions.setTool(null);
  });

  it("a style chosen in the bar rewrites the shape after the pause and becomes the next shape's; the radios move with the arrows", async () => {
    const d = await inShapes("style.pdf");
    const page = d.pages[0];
    const [info] = given(page, [shape("rect", [[100, 100], [200, 150]], { color: state.SHAPE_COLORS.red })]);
    state.selectedShape.value = { pageIndex: 0, id: 1 };
    const vnode = named(render(layer.ShapeLayer, { page, zoom: 1, canvasRev: 0 }), "SelectedShape")[0];
    vi.useFakeTimers();
    const out = render(vnode.type, vnode.props);
    const [colours, widths] = named(out, "Radios");
    colours.props.onPick("blue");
    widths.props.onPick(4);
    expect(state.shapeStyle.value).toMatchObject({ color: "blue", width: 4 });
    await vi.advanceTimersByTimeAsync(700);
    expect(calls).toEqual([["editShape", 0, 1, { ...info.shape, color: state.SHAPE_COLORS.blue, width: 4 }]]);
    expect(shapes.shapeSaid.value?.text).toBe("Shape changed");
    vi.useRealTimers();
    // The radio group: the arrows move the choice and the focus.
    const picked: unknown[] = [];
    const group = render(colours.type, { ...colours.props, onPick: (v: unknown) => picked.push(v) });
    const radios = group.props.children;
    expect(radios.map((r: any) => [r.props.role, r.props["aria-checked"], r.props.tabIndex])).toEqual([
      ["radio", false, -1], ["radio", true, 0], ["radio", false, -1], ["radio", false, -1], ["radio", false, -1],
    ]);
    const focused: number[] = [];
    // (focus() moves document.activeElement, as a browser does: each press steps from where the last one left)
    const fake: any[] = radios.map((_: any, i: number) => ({ focus: () => {
      focused.push(i);
      (document as any).activeElement = fake[i];
    } }));
    (document as any).activeElement = fake[1];
    group.props.onKeyDown({ ...key("ArrowRight"), currentTarget: { querySelectorAll: () => fake } });
    group.props.onKeyDown({ ...key("ArrowLeft"), currentTarget: { querySelectorAll: () => fake } });
    expect(picked).toEqual(["blue", "red"]);
    expect(focused).toEqual([2, 1]);
    // Disabled (an edit is being written): the focus moves, nothing is picked.
    picked.length = 0;
    focused.length = 0;
    const off = render(colours.type, { ...colours.props, disabled: true, onPick: (v: unknown) => picked.push(v) });
    off.props.onKeyDown({ ...key("ArrowRight"), currentTarget: { querySelectorAll: () => fake } });
    off.props.onKeyDown({ ...key("ArrowRight"), currentTarget: { querySelectorAll: () => fake } });
    (document as any).activeElement = null;
    expect([picked, focused]).toEqual([[], [2, 3]]);
    state.shapeStyle.value = { color: "red", highlight: "yellow", width: 2, dash: "solid", heads: 1 };
    state.selectedShape.value = null;
    await actions.setTool(null);
  });

  it("a change of style alone is not drawn over the old drawing; a move is, with its ghost", async () => {
    const d = await inShapes("preview.pdf");
    const page = d.pages[0];
    const [info] = given(page, [shape("line", [[100, 100], [200, 100]], { dash: "dashed", heads: 1 })]);
    state.selectedShape.value = { pageIndex: 0, id: 1 };
    const vnode = named(render(layer.ShapeLayer, { page, zoom: 1, canvasRev: 0 }), "SelectedShape")[0];
    const drawn = (live: unknown) => {
      const out = render(vnode.type, vnode.props, [live]);
      return [named(out, "ShapeSvg").length, nodes(out).filter((n) => n.props?.class === "shape-ghost").length];
    };
    expect(drawn({ ...info.shape, heads: 2 })).toEqual([0, 0]);
    // Back where it was (a colour picked and picked back, a drag against an edge it touches): nothing over it.
    expect(drawn({ ...info.shape })).toEqual([0, 0]);
    expect(drawn({ ...info.shape, color: state.SHAPE_COLORS.red })).toEqual([0, 0]);
    expect(drawn(geo.moveShape(info.shape, 10, 0, PAGE))).toEqual([1, 1]);
    // Written, the shapes read again (info is the new style) and the canvas not drawn yet: still nothing over it.
    const restyled = { ...info.shape, color: state.SHAPE_COLORS.red };
    const reread = render(vnode.type, { ...vnode.props, info: { ...info, shape: restyled } }, [null, { shape: restyled, rev: 3, change: "restyled" }]);
    expect(named(reread, "ShapeSvg").length).toBe(0);
    const moved = geo.moveShape(info.shape, 10, 0, PAGE);
    const rereadMove = render(vnode.type, { ...vnode.props, info: { ...info, shape: moved } }, [null, { shape: moved, rev: 3, change: "moved" }]);
    expect(named(rereadMove, "ShapeSvg").length).toBe(1);
    state.selectedShape.value = null;
    await actions.setTool(null);
  });

  it("a drag released while flushEditor writes the keys' change is written after it, not dropped", async () => {
    const d = await inShapes("flush.pdf");
    const page = d.pages[0];
    const [info] = given(page, [shape("rect", [[100, 100], [200, 150]])]);
    state.selectedShape.value = { pageIndex: 0, id: 1 };
    const vnode = named(render(layer.ShapeLayer, { page, zoom: 1, canvasRev: 0 }), "SelectedShape")[0];
    const frame = nodes(render(vnode.type, vnode.props)).find((n) => n.props?.role === "application");
    frame.props.onKeyDown(key("ArrowRight"));
    frame.props.onPointerDown(ptr(150, 120));
    frame.props.onPointerMove(ptr(250, 220));
    const flushed = state.flushEditor(); // Ctrl+S during the drag
    frame.props.onPointerUp(ptr(250, 220));
    await flushed;
    await vi.waitFor(() => expect(calls.filter((x) => x[0] === "editShape").length).toBe(2));
    expect(calls.filter((x) => x[0] === "editShape")).toEqual([
      ["editShape", 0, 1, { ...info.shape, points: [[101, 100], [201, 150]] }],
      ["editShape", 0, 1, { ...info.shape, points: [[201, 200], [301, 250]] }],
    ]);
    state.selectedShape.value = null;
    await actions.setTool(null);
  });

  it("without dragging, the bar's Stretch changes a box's width and height and points a line another way", async () => {
    const d = await inShapes("stretch.pdf");
    const [rect] = given(d.pages[0], [shape("rect", [[100, 100], [200, 150]])]);
    const [arrow] = given(d.pages[1], [shape("line", [[100, 300], [213, 300]], { heads: 1 })]);
    const controlsOf = (page: any, info: any) => {
      state.selectedShape.value = { pageIndex: page.index, id: info.id };
      const vnode = named(render(layer.ShapeLayer, { page, zoom: 1, canvasRev: 0 }), "SelectedShape")[0];
      return nodes(render(vnode.type, vnode.props)).find((n) => n.type === nudge.NudgeControls).props;
    };
    let controls = controlsOf(d.pages[0], rect);
    expect(controls.stretchEnd).toBe(false);
    controls.onStretch(10, 0);
    controls.onStretch(0, 30); // taller: no longer 2:1
    await state.flushEditor();
    expect(calls.filter((x) => x[0] === "editShape")).toEqual([["editShape", 0, 1, { ...rect.shape, points: [[100, 100], [210, 180]] }]]);
    calls.length = 0;
    // The arrow's end goes up and left: it points up and to the left now, its start where it was.
    controls = controlsOf(d.pages[1], arrow);
    controls.onStretch(0, -150);
    controls.onStretch(-200, 0);
    await state.flushEditor();
    expect(calls.filter((x) => x[0] === "editShape")).toEqual([["editShape", 1, 1, { ...arrow.shape, points: [[100, 300], [13, 150]] }]]);
    state.selectedShape.value = null;
    await actions.setTool(null);
  });

  it("the bar goes below a shape and above a highlight (the next lines stay free), until measured; then where placeBar put it", async () => {
    const d = await inShapes("place.pdf");
    const page = d.pages[0];
    const [rect, mark] = given(page, [
      shape("rect", [[100, 100], [200, 150]]),
      shape("highlight", [[100, 200], [300, 220]], { color: state.SHAPE_COLORS.yellow, width: 0 }),
    ]);
    const slotOf = (info: any, states: unknown[] = []) => {
      state.selectedShape.value = { pageIndex: 0, id: info.id };
      const vnode = named(render(layer.ShapeLayer, { page, zoom: 1, canvasRev: 0 }), "SelectedShape")[0];
      const slot = nodes(render(vnode.type, vnode.props, states)).find((n) => String(n.props?.class).startsWith("context-slot"));
      return [slot.props.class, slot.props.style.top, slot.props.children[0].props.style.flexBasis];
    };
    // The frame and its 9 px of handles, then 8 px; a bar of one row (36 px) until measured.
    expect(slotOf(rect)).toEqual(["context-slot is-below", "167px", "100px"]);
    expect(slotOf(mark)).toEqual(["context-slot", `${191 - 8 - 36}px`, "100px"]);
    // Measured and placed (live, committed, writing, dragging, placed): its top, its side, shifted to show.
    expect(slotOf(rect, [undefined, undefined, undefined, undefined, { top: 40, below: false, nudge: -30 }])).toEqual(["context-slot", "40px", "70px"]);
    state.selectedShape.value = null;
    await actions.setTool(null);
  });

  it("placeBar: the side where the whole bar shows on the page and in the view, else over the shape; shifted into view", () => {
    const page = { top: 0, left: 8, height: 487 };
    const phone = { top: 0, bottom: 740, left: 0, right: 360 };
    // A small box tapped low on a one-page PDF, its grip below it; a bar of 3 rows (124 px): not
    // below (past the page's end, cut off), so above; and moved left to show whole on the screen.
    expect(layer.placeBar({ top: 229, bottom: 396, left: 150 }, { width: 300, height: 124 }, page, phone, false))
      .toEqual({ top: 229 - 8 - 124, below: false, nudge: 52 - 158 });
    // Room below: below, where it was asked for.
    expect(layer.placeBar({ top: 100, bottom: 200, left: 20 }, { width: 300, height: 124 }, page, phone, false))
      .toEqual({ top: 208, below: true, nudge: 0 });
    // A page scrolled up 300 px: below would be past the view's bottom (532), above shows.
    const tall = { top: -300, left: 0, height: 1000 };
    const view = { top: 52, bottom: 532, left: 0, right: 360 };
    expect(layer.placeBar({ top: 700, bottom: 790, left: 0 }, { width: 200, height: 100 }, tall, view, false))
      .toEqual({ top: 592, below: false, nudge: 8 });
    // A highlight: above first, so the lines below stay free; below on the first line of a page.
    const free = { top: -Infinity, bottom: Infinity, left: -Infinity, right: Infinity };
    const sheet = { top: 0, left: 0, height: 800 };
    expect(layer.placeBar({ top: 191, bottom: 229, left: 100 }, { width: 390, height: 36 }, sheet, free, true).top).toBe(147);
    expect(layer.placeBar({ top: 191, bottom: 229, left: 100 }, { width: 390, height: 36 }, sheet, free, false).top).toBe(237);
    expect(layer.placeBar({ top: 20, bottom: 58, left: 100 }, { width: 390, height: 36 }, sheet, free, true)).toEqual({ top: 66, below: true, nudge: 0 });
    // Room on neither side (a shape as tall as what shows): over what shows of it, on the page.
    expect(layer.placeBar({ top: 10, bottom: 780, left: 0 }, { width: 200, height: 100 }, sheet, { ...view, top: 0, bottom: 600 }, false))
      .toMatchObject({ top: 18, below: true });
    // A slide on a phone (344 × 193.5 px): the bar may stand out of its page, over the gap and the
    // next page (min..max, the pages' box), so it goes below the shape and its grip, not over them.
    const slide = { top: 60, left: 8, height: 193.5, min: -8, max: 193.5 + 8 + 201.5 };
    expect(layer.placeBar({ top: 51, bottom: 200, left: 100 }, { width: 344, height: 124 }, slide, phone, false))
      .toMatchObject({ top: 208, below: true });
    // The last page: not past the pages' end (they clip), so over the shape, within them.
    expect(layer.placeBar({ top: 51, bottom: 200, left: 100 }, { width: 344, height: 124 }, { ...slide, max: 201.5 }, phone, false))
      .toMatchObject({ top: 59, below: true });
  });

  it("placeBar: the move buttons' row opening (or closing) never flips the bar; the buttons stay where they were", () => {
    const page = { top: 60, left: 0, height: 1000 };
    const view = { top: 60, bottom: 700, left: 0, right: 360 };
    const sel = { top: 358, bottom: 506, left: 0 };
    const closed = layer.placeBar(sel, { width: 300, height: 88 }, page, view, false, 48);
    const open = layer.placeBar(sel, { width: 300, height: 136 }, page, view, false, 0);
    expect([closed.below, open.below]).toEqual([false, false]);
    // Above, the row opens above the buttons: they keep their place.
    expect(closed.top).toBe(open.top + 48);
    // Room for both below: below, opened or not.
    const low = { top: 58, bottom: 206, left: 20 };
    expect([layer.placeBar(low, { width: 300, height: 88 }, page, view, false, 48), layer.placeBar(low, { width: 300, height: 136 }, page, view, false, 0)])
      .toEqual([{ top: 214, below: true, nudge: 0 }, { top: 214, below: true, nudge: 0 }]);
    // A phone held sideways: neither side has room for the bar and the row, one has room for the bar
    // alone. The bar goes there (a flip when the row opens), never over the shape.
    const flat = { top: 0, bottom: 260, left: 0, right: 640 };
    const shape = { top: 60, bottom: 175, left: 0 };
    const r = layer.placeBar(shape, { width: 300, height: 44 }, page, flat, false, 48);
    expect(r.top + 44 <= shape.top || r.top >= shape.bottom).toBe(true);
    expect(r).toEqual(layer.placeBar(shape, { width: 300, height: 44 }, page, flat, false, 0));
  });

  it("a highlight's preview is drawn at the engine's opacity; the CSS keeps no copy of it", async () => {
    const d = await inShapes("alpha.pdf");
    const page = d.pages[0];
    given(page, []);
    const mark = shape("highlight", [[100, 200], [300, 220]], { color: state.SHAPE_COLORS.yellow, width: 0 });
    const svg = named(render(layer.ShapeLayer, { page, zoom: 1, canvasRev: 0 }, [mark]), "ShapeSvg")[0];
    const fills = (s: any) => nodes(render(svg.type, { page, shape: s })).filter((n) => n.type === "path" && n.props.fill !== "none");
    expect(fills(mark).map((p) => p.props["fill-opacity"])).toEqual([protocol.HIGHLIGHT_ALPHA]);
    expect(fills(shape("line", [[0, 0], [99, 0]], { heads: 1 })).map((p) => p.props["fill-opacity"])).toEqual([undefined]);
    const css = readFileSync(new URL("../src/styles/shapes.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).not.toMatch(/fill-opacity|opacity:\s*0\.45/);
    await actions.setTool(null);
  });

  it("the context bar's CSS: groups wrap on a narrow page; swatch rings and widths show in both themes and in forced colours", () => {
    const css = readFileSync(new URL("../src/styles/shapes.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = (text: string, selector: string) => [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((m) => m[1].trim() === selector)?.[2] ?? "";
    expect(rule(css, ".shape-radios")).toMatch(/flex: 0 1 auto;[\s\S]*min-width: 0;[\s\S]*flex-wrap: wrap;/);
    expect(rule(css, ".shape-swatch")).toContain("box-shadow: inset 0 0 0 1px var(--muted)");
    const forced = css.slice(css.indexOf("@media (forced-colors: active)"));
    expect(rule(forced, ".shape-width")).toContain("background: ButtonText");
    expect(rule(forced, ".shape-swatch")).toContain("CanvasText");
  });

  it("the status region says what this layer heard, not again what was said before it came", async () => {
    const d = await inShapes("said.pdf");
    const page = d.pages[0];
    given(page, []);
    const status = (said: unknown, seen: number) => {
      shapes.shapeSaid.value = said as any;
      // drawn, placed, hover, then the last id said before the layer came.
      const out = render(layer.ShapeLayer, { page, zoom: 1, canvasRev: 0 }, [undefined, undefined, undefined, seen]);
      return nodes(out).find((n) => n.props?.role === "status").props.children;
    };
    expect(status({ id: 7, pageIndex: 0, text: "Rectangle added" }, 7)).toBe(false);
    expect(status({ id: 8, pageIndex: 0, text: "Rectangle added" }, 7).props.children).toBe("Rectangle added");
    expect(status({ id: 8, pageIndex: 1, text: "Rectangle added" }, 7)).toBe(false);
    shapes.shapeSaid.value = null;
    await actions.setTool(null);
  });
});
