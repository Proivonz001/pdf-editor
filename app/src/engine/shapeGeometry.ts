// The geometry of Forme (release 6), shared by the engine (the path it writes into the page) and
// the viewer (the SVG preview while a shape is drawn or dragged), so both draw the same thing.
// Both draw in page space: the engine takes the very same paths to the page's user space point by
// point (so each path starts where the preview's does and runs the same way: the same dashes), and
// divides the width and the dashes by the page transform's scale (1, or the page's /UserUnit: the
// transform turns, flips, moves and may scale). isShapeDrawable is the size rule both apply. No
// MuPDF here: the viewer imports it.
import { MAX_PEN_POINTS, MIN_SHAPE_SIZE, type Matrix, type Rect, type Shape, type ShapeDash } from "./protocol";

export type Point = [number, number];
export type Segment = { op: "M" | "L"; p: Point } | { op: "C"; c1: Point; c2: Point; p: Point } | { op: "Z" };

/** A shape as paths: what is stroked (with its caps, joins and dashes) and what is filled. */
export interface ShapeDrawing {
  /** Stroked with the shape's colour and width (empty for a highlight). */
  stroke: Segment[];
  /** Filled with the shape's colour: arrow heads, a highlight's box. */
  fill: Segment[];
  /** PDF line cap (0 butt, 1 round) and line join (0 miter, 1 round). */
  cap: 0 | 1;
  join: 0 | 1;
  /** Dash array in points ([] solid), the same for PDF (`d`) and SVG (stroke-dasharray). */
  dash: number[];
}

/** A quarter ellipse as one cubic Bézier: the control points sit this far along the tangents. */
const K = 0.5522847498;

/** An arrow head's length along the line and half its width, for a stroke `width` wide. */
export const arrowHead = (width: number) => ({ length: 3 * width + 6, half: 1.5 * width + 3 });

/** The dash array of `dash` for a stroke `width` wide. Dotted needs round caps (drawing gives them). */
export function dashArray(dash: ShapeDash, width: number): number[] {
  if (dash === "dashed") return [3 * width, 2 * width];
  if (dash === "dotted") return [0, 2 * width];
  return [];
}

/** `p` through `m` (PDF row-vector matrix). */
export const apply = (m: Matrix, [x, y]: Point): Point => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/** `shape` with its points taken through `m` (to a page's user space and back). */
export const mapShape = (shape: Shape, m: Matrix): Shape => ({ ...shape, points: shape.points.map((p) => apply(m, p)) });

/** The upright box of `points`: [x0, y0, x1, y1]. */
export function boxOf(points: readonly Point[]): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of points) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return [x0, y0, x1, y1];
}

const lerp = (a: Point, b: Point, t: number): Point => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

function boxPath([x0, y0, x1, y1]: Rect): Segment[] {
  return [{ op: "M", p: [x0, y0] }, { op: "L", p: [x1, y0] }, { op: "L", p: [x1, y1] }, { op: "L", p: [x0, y1] }, { op: "Z" }];
}

function ellipsePath([x0, y0, x1, y1]: Rect): Segment[] {
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = (x1 - x0) / 2, ry = (y1 - y0) / 2, kx = rx * K, ky = ry * K;
  return [
    { op: "M", p: [cx + rx, cy] },
    { op: "C", c1: [cx + rx, cy + ky], c2: [cx + kx, cy + ry], p: [cx, cy + ry] },
    { op: "C", c1: [cx - kx, cy + ry], c2: [cx - rx, cy + ky], p: [cx - rx, cy] },
    { op: "C", c1: [cx - rx, cy - ky], c2: [cx - kx, cy - ry], p: [cx, cy - ry] },
    { op: "C", c1: [cx + kx, cy - ry], c2: [cx + rx, cy - ky], p: [cx + rx, cy] },
    { op: "Z" },
  ];
}

/**
 * A freehand stroke through `pts`, smoothed: from the first point, a quadratic curve through
 * each point to the middle of the next segment (written as a cubic), then straight to the last.
 */
function penPath(pts: readonly Point[]): Segment[] {
  const out: Segment[] = [{ op: "M", p: pts[0] }];
  if (pts.length === 2) return [...out, { op: "L", p: pts[1] }];
  let from = pts[0];
  for (let i = 1; i < pts.length - 1; i++) {
    const c = pts[i], to = lerp(pts[i], pts[i + 1], 0.5);
    out.push({ op: "C", c1: lerp(from, c, 2 / 3), c2: lerp(to, c, 2 / 3), p: to });
    from = to;
  }
  out.push({ op: "L", p: pts[pts.length - 1] });
  return out;
}

/** The triangle of an arrow head with its tip at `tip`, pointing along unit `dir`, `scale` of full size. */
function headPath(tip: Point, dir: Point, width: number, scale: number): Segment[] {
  const { length, half } = arrowHead(width);
  const l = length * scale, h = half * scale, base: Point = [tip[0] - dir[0] * l, tip[1] - dir[1] * l];
  return [
    { op: "M", p: tip },
    { op: "L", p: [base[0] - dir[1] * h, base[1] + dir[0] * h] },
    { op: "L", p: [base[0] + dir[1] * h, base[1] - dir[0] * h] },
    { op: "Z" },
  ];
}

/** A line, with its arrow heads: the stroke stops inside each head, so a cap never shows past the tip. */
function linePath(a: Point, b: Point, width: number, heads: 0 | 1 | 2): { stroke: Segment[]; fill: Segment[] } {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (!heads || len === 0) return { stroke: [{ op: "M", p: a }, { op: "L", p: b }], fill: [] };
  const dir: Point = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
  const { length } = arrowHead(width);
  // Heads longer than the line together are drawn smaller, so they never cross each other.
  const scale = Math.min(1, len / (length * heads));
  const cut = (length * scale) / 2;
  const fill = headPath(b, dir, width, scale);
  let start = a;
  if (heads === 2) {
    fill.push(...headPath(a, [-dir[0], -dir[1]], width, scale));
    start = [a[0] + dir[0] * cut, a[1] + dir[1] * cut];
  }
  const end: Point = [b[0] - dir[0] * cut, b[1] - dir[1] * cut];
  return { stroke: [{ op: "M", p: start }, { op: "L", p: end }], fill };
}

/**
 * Whether the engine draws `shape` (page space), as far as its points go: every one finite, as many
 * as its kind takes (two; a pen stroke 2 to MAX_PEN_POINTS), and big enough to see and grab: a line
 * at least MIN_SHAPE_SIZE long, a box (rect, ellipse, highlight) with both sides at least that, a pen
 * stroke whose box is at least that one way (its longer side). The session refuses anything else
 * ("bad-request"); the viewer drops it silently before sending it.
 */
export function isShapeDrawable(shape: Shape): boolean {
  const { kind, points } = shape;
  if (kind === "pen" ? points.length < 2 || points.length > MAX_PEN_POINTS : points.length !== 2) return false;
  if (!points.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))) return false;
  const [x0, y0, x1, y1] = boxOf(points);
  if (kind === "line") return Math.hypot(points[1][0] - points[0][0], points[1][1] - points[0][1]) >= MIN_SHAPE_SIZE;
  if (kind === "pen") return Math.max(x1 - x0, y1 - y0) >= MIN_SHAPE_SIZE;
  return x1 - x0 >= MIN_SHAPE_SIZE && y1 - y0 >= MIN_SHAPE_SIZE;
}

/** `shape` as paths, in the space its points are in. */
export function drawing(shape: Shape): ShapeDrawing {
  const { kind, points, width } = shape;
  const dash = kind === "pen" || kind === "highlight" ? [] : dashArray(shape.dash, width);
  const dotted = dash.length > 0 && dash[0] === 0;
  switch (kind) {
    case "line": {
      const { stroke, fill } = linePath(points[0], points[1], width, shape.heads);
      return { stroke, fill, cap: dotted || !dash.length ? 1 : 0, join: 1, dash };
    }
    case "rect":
      return { stroke: boxPath(boxOf(points)), fill: [], cap: dotted ? 1 : 0, join: 0, dash };
    case "ellipse":
      return { stroke: ellipsePath(boxOf(points)), fill: [], cap: dotted ? 1 : 0, join: 1, dash };
    case "pen":
      return { stroke: penPath(points), fill: [], cap: 1, join: 1, dash };
    case "highlight":
      return { stroke: [], fill: boxPath(boxOf(points)), cap: 0, join: 0, dash };
  }
}

/** Every point a path passes through or bends towards (a curve lies inside its control points). */
const hull = (segs: readonly Segment[]): Point[] =>
  segs.flatMap((s) => (s.op === "Z" ? [] : s.op === "C" ? [s.c1, s.c2, s.p] : [s.p]));

/** What `shape` covers, its stroke's width and its heads included (in the space of its points). */
export function shapeBox(shape: Shape): Rect {
  const d = drawing(shape), pad = shape.width / 2;
  const [x0, y0, x1, y1] = boxOf(hull(d.stroke));
  const stroked: Point[] = d.stroke.length ? [[x0 - pad, y0 - pad], [x1 + pad, y1 + pad]] : [];
  return boxOf([...stroked, ...hull(d.fill)]);
}

const fmt = (v: number) => String(Math.round(v * 1000) / 1000);
const pt = ([x, y]: Point) => `${fmt(x)} ${fmt(y)}`;

/** `segs` as an SVG path's d attribute. */
export function svgPath(segs: readonly Segment[]): string {
  return segs
    .map((s) => (s.op === "Z" ? "Z" : s.op === "C" ? `C ${pt(s.c1)} ${pt(s.c2)} ${pt(s.p)}` : `${s.op} ${pt(s.p)}`))
    .join(" ");
}
