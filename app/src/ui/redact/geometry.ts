// Geometry of the areas Bianchetto and Oscura mark on a page (viewer/RedactLayer.tsx): pure
// functions on upright rectangles in page space (points, y down, [x0, y0, x1, y1]), so all of it
// is tested in Node (tests/redact-ui.test.ts). A rectangle dragged out between two points, the
// default box a tap on the page puts there (50 × 8 mm, centred on the tap), the waiting box moved
// or resized by a handle, the mouse or the keyboard, always on its page and never thinner than a
// minimum side, and the quad of a text line, which engine/redactGeometry.ts (areasForQuads) then
// shrinks so that the box over the line never reaches the lines above and below.
import type { LineInfo, Quad, Rect } from "../../engine/protocol";
// The waiting box's handles are the image frame's: four corners and four edges, named by compass point.
import type { Handle, Point } from "../../viewer/imageGeometry";

export const PT_PER_MM = 72 / 25.4;
/** A tap on the page away from any line puts a box this big (millimetres) there. */
export const DEFAULT_BOX_MM: Readonly<[number, number]> = [50, 8];
/** No side of a box is made shorter than this (points), unless the page itself is smaller. */
export const MIN_BOX_SIDE = 2;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** The rectangle with corners `a` and `b`, whichever way it was dragged. */
export function rectBetween(a: Point, b: Point): Rect {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
}

/** `r` cut to the page `bounds` (it may come out empty: x1 <= x0 or y1 <= y0). */
export function clipToPage(r: Rect, bounds: Rect): Rect {
  return [
    clamp(r[0], bounds[0], bounds[2]), clamp(r[1], bounds[1], bounds[3]),
    clamp(r[2], bounds[0], bounds[2]), clamp(r[3], bounds[1], bounds[3]),
  ];
}

/** Both sides at least `minSide` long (and every number finite). */
export function isUsable(r: Rect, minSide = MIN_BOX_SIDE): boolean {
  return r.every(Number.isFinite) && r[2] - r[0] >= minSide - 1e-9 && r[3] - r[1] >= minSide - 1e-9;
}

/** `r` with its size kept (shrunk only where the page is smaller) and moved onto the page. */
export function fitOnPage(r: Rect, bounds: Rect): Rect {
  const w = Math.min(r[2] - r[0], bounds[2] - bounds[0]);
  const h = Math.min(r[3] - r[1], bounds[3] - bounds[1]);
  const x0 = clamp(r[0], bounds[0], bounds[2] - w);
  const y0 = clamp(r[1], bounds[1], bounds[3] - h);
  return [x0, y0, x0 + w, y0 + h];
}

/** The default box (DEFAULT_BOX_MM) centred on `at`, on the page (smaller on a smaller page). */
export function defaultBox(at: Point, bounds: Rect): Rect {
  const w = DEFAULT_BOX_MM[0] * PT_PER_MM;
  const h = DEFAULT_BOX_MM[1] * PT_PER_MM;
  return fitOnPage([at[0] - w / 2, at[1] - h / 2, at[0] + w / 2, at[1] + h / 2], bounds);
}

/** `r` moved by (dx, dy), its size kept, never off the page. */
export function moveBox(r: Rect, dx: number, dy: number, bounds: Rect): Rect {
  return fitOnPage([r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy], bounds);
}

/**
 * `r` with the edges of `handle` taken to `p` (the opposite edges stay where they are), on the
 * page, and no side shorter than `minSide` (an edge stops there instead of crossing the other).
 */
export function resizeBox(r: Rect, handle: Handle, p: Point, bounds: Rect, minSide = MIN_BOX_SIDE): Rect {
  let [x0, y0, x1, y1] = r;
  const x = clamp(p[0], bounds[0], bounds[2]);
  const y = clamp(p[1], bounds[1], bounds[3]);
  if (handle.includes("w")) x0 = Math.min(x, x1 - minSide);
  if (handle.includes("e")) x1 = Math.max(x, x0 + minSide);
  if (handle.includes("n")) y0 = Math.min(y, y1 - minSide);
  if (handle.includes("s")) y1 = Math.max(y, y0 + minSide);
  return clipToPage([x0, y0, x1, y1], bounds);
}

/** One far edge (`hi`) moved by `d`: not past `max`, and not closer than `minSide` to `lo` (nor closer than it was). */
function stretchEdge(lo: number, hi: number, d: number, max: number, minSide: number): number {
  if (d < 0) return Math.max(hi + d, Math.min(hi, lo + minSide));
  return Math.min(hi + d, Math.max(hi, max));
}

/**
 * The keyboard's Alt + arrows: `r` wider by `dw` and taller by `dh` (negative: narrower, shorter),
 * its top-left corner kept, on the page; a side is not made shorter than `minSide` (one that
 * already is does not shrink).
 */
export function stretchBox(r: Rect, dw: number, dh: number, bounds: Rect, minSide = MIN_BOX_SIDE): Rect {
  return [r[0], r[1], stretchEdge(r[0], r[2], dw, bounds[2], minSide), stretchEdge(r[1], r[3], dh, bounds[3], minSide)];
}

/** Where `handle` sits on `r`. */
export function handlePoint(r: Rect, handle: Handle): Point {
  const x = handle.includes("w") ? r[0] : handle.includes("e") ? r[2] : (r[0] + r[2]) / 2;
  const y = handle.includes("n") ? r[1] : handle.includes("s") ? r[3] : (r[1] + r[3]) / 2;
  return [x, y];
}

/** Below this |cos 2θ| (θ within about 7° of 45°) a line's bbox cannot tell its length from its height. */
const NEAR_DIAGONAL = 0.25;

/**
 * The quad of a whole text line, along its writing direction at any angle (so that areasForQuads
 * shrinks it across the line, not along it): ul, ur, ll, lr, as MuPDF gives a line run's quad,
 * centred on the line's upright bbox. A run L long and H high turned by θ has a bbox
 * L|cos θ| + H|sin θ| wide and L|sin θ| + H|cos θ| high, which gives L and H back; near 45° the
 * two cannot be told apart, and H is the font size. A bbox that fits no such run (H or L not
 * positive) gives the bbox itself, as for a horizontal line.
 */
export function lineQuad(line: Pick<LineInfo, "bbox" | "dir" | "size">): Quad {
  const [x0, y0, x1, y1] = line.bbox;
  const w = x1 - x0, h = y1 - y0;
  const n = Math.hypot(line.dir[0], line.dir[1]) || 1;
  const c = line.dir[0] / n, s = line.dir[1] / n;
  const ac = Math.abs(c), as = Math.abs(s);
  const cos2 = ac * ac - as * as;
  const H = Math.abs(cos2) > NEAR_DIAGONAL ? (h * ac - w * as) / cos2 : line.size;
  const L = ac >= as ? (w - H * as) / ac : (h - H * ac) / as;
  if (!(H > 0 && L > 0)) return [x0, y0, x1, y0, x0, y1, x1, y1];
  // u along the line (ul → ur), v across it (ul → ll: ascent to descent, y down).
  const ux = c * L, uy = s * L, vx = -s * H, vy = c * H;
  const ulx = (x0 + x1 - ux - vx) / 2, uly = (y0 + y1 - uy - vy) / 2;
  return [ulx, uly, ulx + ux, uly + uy, ulx + vx, uly + vy, ulx + ux + vx, uly + uy + vy];
}

/** The smallest rectangle round `rects` (the usable ones), or null when there is none. */
export function boundsOfRects(rects: readonly Rect[]): Rect | null {
  const ok = rects.filter((r) => r.every(Number.isFinite) && r[2] > r[0] && r[3] > r[1]);
  if (!ok.length) return null;
  return [
    Math.min(...ok.map((r) => r[0])), Math.min(...ok.map((r) => r[1])),
    Math.max(...ok.map((r) => r[2])), Math.max(...ok.map((r) => r[3])),
  ];
}

/** `a` and `b` are the same rectangle, give or take `eps` points. */
export function sameRect(a: Rect, b: Rect, eps = 0.5): boolean {
  return a.every((v, i) => Math.abs(v - b[i]) <= eps);
}
