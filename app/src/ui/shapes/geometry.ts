// Geometry of Forme on the page (viewer/ShapeLayer.tsx): pure functions on shapes in page space
// (points, y down), so all of it is tested in Node (tests/shapes-layer.test.ts). The points a drag
// gives (Shift: a square, a circle, a line at 45° steps), the default shape a tap or "Metti al
// centro" puts down (a 40 mm line, a 30 × 20 mm box, a 50 × 6 mm highlight), the text line a
// click highlights (a turned line only over its own run, a justified line's pieces joined), the
// pen's points thinned as they come (a tap, a dot), which shape a click hits (near its stroke,
// inside a highlight or an arrow head, the topmost first; a finger reaches further than a mouse,
// the pen only its ink),
// and a selected shape moved, resized by a handle (a pen stroke scales its points with its box; a
// line moves an end), stretched or scaled, always on its page. The box helpers are Bianchetto's
// (ui/redact/geometry.ts); the paths are the engine's (shapeGeometry.ts).
import { MAX_PEN_POINTS, MIN_SHAPE_SIZE, type LineInfo, type Rect, type Shape, type ShapeKind } from "../../engine/protocol";
import { boxOf, drawing, shapeBox, type Point, type Segment } from "../../engine/shapeGeometry";
import type { Handle } from "../../viewer/imageGeometry";
import { boundsOfRects, clipToPage, fitOnPage, lineQuad, moveBox, PT_PER_MM, resizeBox, stretchBox } from "../redact/geometry";

/** A tap or "Metti al centro" puts a line this long (mm), a box this big, a highlight this big. */
export const DEFAULT_LINE_MM = 40;
export const DEFAULT_BOX_MM: Readonly<[number, number]> = [30, 20];
export const DEFAULT_HIGHLIGHT_MM: Readonly<[number, number]> = [50, 6];
/** A highlight over a text line: the line's bounds padded this much (pt). */
export const LINE_PAD = 1;
/** The pen keeps a point only this far (pt) from the last one it kept. */
export const PEN_STEP = 0.75;
/** A click hits a stroke within max(HIT_PX on screen, half its width + HIT_PT); a finger within HIT_PX_TOUCH (half a 44 px target). */
const HIT_PX = 6;
export const HIT_PX_TOUCH = 22;
const HIT_PT = 2;
/** The pen's tap hits a stroke only on its ink (half its width + INK_PT): next to it, it is a dot. */
export const INK_PT = 0.5;
/** A justified line's pieces (MuPDF cuts it at its wide spaces) are joined over gaps up to this many line heights. */
const JOIN_GAP = 2.5;
/** Each curve of a path is taken as this many straight pieces when hit-testing it. */
const CURVE_STEPS = 8;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const dist = (a: Point, b: Point) => Math.hypot(b[0] - a[0], b[1] - a[1]);

/** `p` on the page. */
export const clampPoint = ([x, y]: Point, bounds: Rect): Point => [clamp(x, bounds[0], bounds[2]), clamp(y, bounds[1], bounds[3])];

/** The box a shape's points span (what its frame and handles show). */
export const pointsBox = (shape: Shape): Rect => boxOf(shape.points);

/** `b` turned about `a` to the nearest multiple of 45°, its length kept. */
export function snap45(a: Point, b: Point): Point {
  const len = dist(a, b), step = Math.PI / 4;
  const angle = Math.round(Math.atan2(b[1] - a[1], b[0] - a[0]) / step) * step;
  return [a[0] + len * Math.cos(angle), a[1] + len * Math.sin(angle)];
}

/** From `a` (on the page) towards `q`, as far as `q` or the page's edge, whichever comes first. */
export function towards(a: Point, q: Point, bounds: Rect): Point {
  let k = 1;
  for (const i of [0, 1]) {
    const d = q[i] - a[i];
    if (d > 0 && a[i] + d > bounds[i + 2]) k = Math.min(k, (bounds[i + 2] - a[i]) / d);
    if (d < 0 && a[i] + d < bounds[i]) k = Math.min(k, (bounds[i] - a[i]) / d);
  }
  return [a[0] + (q[0] - a[0]) * k, a[1] + (q[1] - a[1]) * k];
}

/**
 * The two points of a drag from `a` to `b`, on the page. With Shift a line turns to the nearest
 * 45° and a rectangle or an ellipse is a square or a circle (as big as the page lets it be); a
 * highlight is never snapped.
 */
export function dragPoints(kind: Exclude<ShapeKind, "pen">, a: Point, b: Point, shift: boolean, bounds: Rect): [Point, Point] {
  const start = clampPoint(a, bounds);
  if (!shift || kind === "highlight") return [start, clampPoint(b, bounds)];
  if (kind === "line") return [start, towards(start, snap45(start, b), bounds)];
  const dx = b[0] - start[0], dy = b[1] - start[1];
  const sx = dx < 0 ? -1 : 1, sy = dy < 0 ? -1 : 1;
  const room = Math.min(sx > 0 ? bounds[2] - start[0] : start[0] - bounds[0], sy > 0 ? bounds[3] - start[1] : start[1] - bounds[1]);
  const side = Math.min(Math.max(Math.abs(dx), Math.abs(dy)), room);
  return [start, [start[0] + sx * side, start[1] + sy * side]];
}

/**
 * The points of the default shape of `kind` centred on `at`, on the page (smaller on a smaller
 * page): a horizontal line DEFAULT_LINE_MM long, a box DEFAULT_BOX_MM, a highlight
 * DEFAULT_HIGHLIGHT_MM. Null for the pen (it is only drawn).
 */
export function defaultPoints(kind: ShapeKind, at: Point, bounds: Rect): Point[] | null {
  if (kind === "pen") return null;
  if (kind === "line") {
    const half = (DEFAULT_LINE_MM * PT_PER_MM) / 2;
    const [x0, y, x1] = fitOnPage([at[0] - half, at[1], at[0] + half, at[1]], bounds);
    return [[x0, y], [x1, y]];
  }
  const [w, h] = (kind === "highlight" ? DEFAULT_HIGHLIGHT_MM : DEFAULT_BOX_MM).map((mm) => mm * PT_PER_MM);
  const [x0, y0, x1, y1] = fitOnPage([at[0] - w / 2, at[1] - h / 2, at[0] + w / 2, at[1] + h / 2], bounds);
  return [[x0, y0], [x1, y1]];
}

/** The highlight over a text line of upright bounds `bbox`: padded by LINE_PAD, on the page. */
export function lineHighlight(bbox: Rect, bounds: Rect): [Point, Point] {
  const [x0, y0, x1, y1] = clipToPage([bbox[0] - LINE_PAD, bbox[1] - LINE_PAD, bbox[2] + LINE_PAD, bbox[3] + LINE_PAD], bounds);
  return [[x0, y0], [x1, y1]];
}

/** What lineBoxAt needs of a text line (LineInfo). */
export type TextLine = Pick<LineInfo, "bbox" | "text" | "dir" | "size">;

const upright = (l: TextLine) => Math.abs(l.dir[1]) < 0.01 && l.dir[0] > 0;
const midY = (r: Rect) => (r[1] + r[3]) / 2;

/** `p` is on `l`'s run: its upright bounds, or for a turned line its own quad (ui/redact/geometry.ts, lineQuad). */
function onRun(l: TextLine, p: Point): boolean {
  const [x0, y0, x1, y1] = l.bbox;
  if (p[0] < x0 || p[0] > x1 || p[1] < y0 || p[1] > y1) return false;
  if (upright(l)) return true;
  const q = lineQuad(l);
  return inside([[q[0], q[1]], [q[2], q[3]], [q[6], q[7]], [q[4], q[5]]], p);
}

/**
 * The upright bounds a click at `p` highlights (for lineHighlight), or null. The text line (with
 * some text) whose run holds `p`, the smallest when several do (a drop cap, tight leading), so a
 * turned stamp takes only clicks on itself; else, in a gap of a row, its nearest upright piece
 * within half of JOIN_GAP line heights, when the gap is one it joins or `p` is within a line
 * height of it. An upright line takes in the pieces of its row that MuPDF cut it into at a
 * justified line's wide spaces: those within JOIN_GAP line heights, over a gap that text in the
 * row above or below covers (a column's gutter is never covered, and is never crossed).
 */
export function lineBoxAt(lines: readonly TextLine[] | null, p: Point): Rect | null {
  const text = (lines ?? []).filter((l) => l.text.trim());
  const flat = text.filter(upright);
  const area = (r: Rect) => (r[2] - r[0]) * (r[3] - r[1]);
  const gapTo = (l: TextLine) => Math.max(l.bbox[0] - p[0], p[0] - l.bbox[2], 0);
  const line = text.filter((l) => onRun(l, p)).sort((a, b) => area(a.bbox) - area(b.bbox))[0] ??
    flat.filter((l) => p[1] >= l.bbox[1] && p[1] <= l.bbox[3] && gapTo(l) <= (JOIN_GAP / 2) * (l.bbox[3] - l.bbox[1])).sort((a, b) => gapTo(a) - gapTo(b))[0];
  if (!line || !upright(line)) return line?.bbox ?? null;
  const h = line.bbox[3] - line.bbox[1], y = midY(line.bbox);
  const row = flat.filter((l) => Math.abs(midY(l.bbox) - y) <= h / 2).sort((a, b) => a.bbox[0] - b.bbox[0]);
  const near = flat.filter((l) => Math.abs(midY(l.bbox) - y) > h / 2 && Math.abs(midY(l.bbox) - y) <= 1.6 * h);
  const joins = (a: Rect, b: Rect) => {
    const x = (a[2] + b[0]) / 2;
    return b[0] - a[2] <= 0 || (b[0] - a[2] <= JOIN_GAP * h && near.some((l) => l.bbox[0] < x && l.bbox[2] > x));
  };
  let i = row.indexOf(line), j = i;
  while (i > 0 && joins(row[i - 1].bbox, row[i].bbox)) i--;
  while (j < row.length - 1 && joins(row[j].bbox, row[j + 1].bbox)) j++;
  const box = boundsOfRects(row.slice(i, j + 1).map((l) => l.bbox)) ?? line.bbox;
  // In a gap: the row when it joins across it, else the piece only within a line height.
  return gapTo(line) <= h || (box[0] <= p[0] && p[0] <= box[2]) ? box : null;
}

/**
 * The pen's next point: added to `points` (in place) when it is at least `step` from the last one
 * kept and the stroke has fewer than MAX_PEN_POINTS. True when it was added.
 */
export function addPenPoint(points: Point[], p: Point, step = PEN_STEP): boolean {
  if (points.length >= MAX_PEN_POINTS) return false;
  const last = points[points.length - 1];
  if (last && dist(last, p) < step) return false;
  points.push(p);
  return true;
}

/**
 * A pen stroke's points as written: as drawn, or, when they span less than MIN_SHAPE_SIZE both
 * ways (a tap, a dot, an accent), a dot the engine takes (shapeGeometry.ts, isShapeDrawable):
 * MIN_SHAPE_SIZE long from the first point, on the page.
 */
export function penStroke(points: readonly Point[], bounds: Rect): Point[] {
  const [x0, y0, x1, y1] = boxOf(points);
  if (Math.max(x1 - x0, y1 - y0) >= MIN_SHAPE_SIZE) return points.slice();
  const [x, y] = points[0], d = MIN_SHAPE_SIZE * 1.01; // (a hair over: x + 1 - x can round below 1)
  return [[x, y], [x + d <= bounds[2] ? x + d : x - d, y]];
}

// --- Hit testing -------------------------------------------------------------------------------

function cubic(p0: Point, c1: Point, c2: Point, p: Point, k: number): Point {
  const u = 1 - k;
  const a = u * u * u, b = 3 * u * u * k, c = 3 * u * k * k, d = k * k * k;
  return [a * p0[0] + b * c1[0] + c * c2[0] + d * p[0], a * p0[1] + b * c1[1] + c * c2[1] + d * p[1]];
}

/** A path as polylines, one per subpath (curves cut in CURVE_STEPS straight pieces, Z back to the start). */
function polylines(segs: readonly Segment[]): Point[][] {
  const out: Point[][] = [];
  let cur: Point[] = [];
  for (const s of segs) {
    if (s.op === "M") {
      if (cur.length) out.push(cur);
      cur = [s.p];
    } else if (s.op === "L") {
      cur.push(s.p);
    } else if (s.op === "C") {
      const p0 = cur[cur.length - 1] ?? s.p;
      for (let i = 1; i <= CURVE_STEPS; i++) cur.push(cubic(p0, s.c1, s.c2, s.p, i / CURVE_STEPS));
    } else if (cur.length) {
      cur.push(cur[0]);
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

function segmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy;
  const k = len2 ? clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2, 0, 1) : 0;
  return dist(p, [a[0] + dx * k, a[1] + dy * k]);
}

/** `p` is inside the closed polygon `poly` (even-odd). */
function inside(poly: readonly Point[], p: Point): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/**
 * A click at `p` hits `shape` (shown at `zoom` CSS px per point): inside what it fills (a
 * highlight, an arrow head), or near its stroke, within max(`px` on screen, half its width + `pt`):
 * 6 px for a mouse, HIT_PX_TOUCH for a finger; 2 pt, or INK_PT for the pen's tap (with `px` 0).
 */
export function hitsShape(shape: Shape, p: Point, zoom: number, px = HIT_PX, pt = HIT_PT): boolean {
  const tol = Math.max(px / zoom, shape.width / 2 + pt);
  const [x0, y0, x1, y1] = shapeBox(shape);
  if (p[0] < x0 - tol || p[0] > x1 + tol || p[1] < y0 - tol || p[1] > y1 + tol) return false;
  const d = drawing(shape);
  if (polylines(d.fill).some((poly) => inside(poly, p))) return true;
  return polylines(d.stroke).some((line) => line.some((a, i) => i > 0 && segmentDistance(p, line[i - 1], a) <= tol) ||
    (line.length === 1 && dist(p, line[0]) <= tol));
}

/** The shape a click at `p` hits (within `px` on screen or `pt`: hitsShape): the topmost (painted last) of `shapes`, or null. */
export function hitTest<T extends { shape: Shape }>(shapes: readonly T[], p: Point, zoom: number, px = HIT_PX, pt = HIT_PT): T | null {
  for (let i = shapes.length - 1; i >= 0; i--) if (hitsShape(shapes[i].shape, p, zoom, px, pt)) return shapes[i];
  return null;
}

// --- Changing a selected shape -------------------------------------------------------------------

/**
 * `shape` with the box its points span taken from `from` to `to`: a rectangle, an ellipse or a
 * highlight takes `to`'s corners; a pen stroke's (and a line's) points scale with it, except along
 * a side of no length (a straight stroke stays straight).
 */
export function withBox(shape: Shape, from: Rect, to: Rect): Shape {
  if (shape.kind === "rect" || shape.kind === "ellipse" || shape.kind === "highlight") {
    return { ...shape, points: [[to[0], to[1]], [to[2], to[3]]] };
  }
  const map = (v: number, a0: number, a1: number, b0: number, b1: number) =>
    a1 - a0 > 1e-6 ? b0 + ((v - a0) * (b1 - b0)) / (a1 - a0) : v;
  return {
    ...shape,
    points: shape.points.map(([x, y]): [number, number] => [map(x, from[0], from[2], to[0], to[2]), map(y, from[1], from[3], to[1], to[3])]),
  };
}

/** `shape` moved by (dx, dy), never off the page (its points' box stops at the edge). */
export function moveShape(shape: Shape, dx: number, dy: number, bounds: Rect): Shape {
  const box = pointsBox(shape);
  const to = moveBox(box, dx, dy, bounds);
  const mx = to[0] - box[0], my = to[1] - box[1];
  if (!mx && !my) return shape;
  return { ...shape, points: shape.points.map(([x, y]): [number, number] => [x + mx, y + my]) };
}

/** A box shape (not a line) with the edges of `handle` taken to `p`, on the page, no side shorter than `minSide`. */
export function resizeShape(shape: Shape, handle: Handle, p: Point, bounds: Rect, minSide: number): Shape {
  const box = pointsBox(shape);
  return withBox(shape, box, resizeBox(box, handle, p, bounds, minSide));
}

/**
 * A line with its end `end` (0: start, 1: end) taken to `p`, on the page; with `snap` turned to the
 * nearest 45° about the other end. Unchanged when it would come out shorter than `minLength`.
 */
export function moveEnd(shape: Shape, end: 0 | 1, p: Point, bounds: Rect, snap: boolean, minLength: number): Shape {
  const other = shape.points[1 - end];
  let q = clampPoint(p, bounds);
  if (snap) q = towards(other, snap45(other, q), bounds);
  if (dist(other, q) < minLength) return shape;
  const points = shape.points.slice() as [number, number][];
  points[end] = q;
  return { ...shape, points };
}

/**
 * Alt + arrows: a box shape `dw` wider and `dh` taller (its top-left corner kept), a line's end
 * moved by (dw, dh); on the page, no side (nor line) shorter than `minSide`.
 */
export function stretchShape(shape: Shape, dw: number, dh: number, bounds: Rect, minSide: number): Shape {
  if (shape.kind === "line") {
    const [x, y] = shape.points[1];
    return moveEnd(shape, 1, [x + dw, y + dh], bounds, false, minSide);
  }
  const box = pointsBox(shape);
  return withBox(shape, box, stretchBox(box, dw, dh, bounds, minSide));
}

/**
 * `shape` `factor` times bigger about the middle of its points' box, moved back onto the page if
 * it went past an edge. Unchanged when it would not fit on the page, or would come out smaller
 * than `minSide` (a box's shorter side, a line's length, a pen stroke's longer side).
 */
export function scaleShape(shape: Shape, factor: number, bounds: Rect, minSide: number): Shape {
  const box = pointsBox(shape);
  const w = (box[2] - box[0]) * factor, h = (box[3] - box[1]) * factor;
  if (w > bounds[2] - bounds[0] + 1e-9 || h > bounds[3] - bounds[1] + 1e-9) return shape;
  if (factor < 1) {
    const size = shape.kind === "line" ? dist(shape.points[0], shape.points[1]) * factor
      : shape.kind === "pen" ? Math.max(w, h) : Math.min(w, h);
    if (size < minSide) return shape;
  }
  const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
  return withBox(shape, box, fitOnPage([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], bounds));
}

const near = (a: number, b: number, eps: number) => Math.abs(a - b) <= eps;

/** `a` and `b` are the same shape, give or take `eps` (points, colour). */
export function sameShape(a: Shape, b: Shape, eps = 1e-3): boolean {
  return a.kind === b.kind && a.dash === b.dash && a.heads === b.heads && near(a.width, b.width, eps) &&
    a.color.every((c, i) => near(c, b.color[i], eps)) && a.points.length === b.points.length &&
    a.points.every((p, i) => near(p[0], b.points[i][0], eps) && near(p[1], b.points[i][1], eps));
}

/**
 * What changed from `a` to `b`, for the status region: "moved" (every point by the same step),
 * "resized" (the points otherwise), "restyled" (only colour, width, line style or heads), or null.
 */
export function changeOf(a: Shape, b: Shape): "moved" | "resized" | "restyled" | null {
  if (sameShape(a, b)) return null;
  const samePoints = a.points.length === b.points.length &&
    a.points.every((p, i) => near(p[0], b.points[i][0], 1e-3) && near(p[1], b.points[i][1], 1e-3));
  if (samePoints) return "restyled";
  if (a.points.length !== b.points.length) return "resized";
  const dx = b.points[0][0] - a.points[0][0], dy = b.points[0][1] - a.points[0][1];
  return a.points.every((p, i) => near(b.points[i][0] - p[0], dx, 1e-3) && near(b.points[i][1] - p[1], dy, 1e-3)) ? "moved" : "resized";
}
