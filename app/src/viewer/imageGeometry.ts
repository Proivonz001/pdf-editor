// Geometry of the image overlay in edit mode: pure functions on the matrices that place a
// picture on the page (ImageInfo.matrix: the picture's unit square, (0, 0) its top-left corner
// as seen and (1, 1) its bottom-right, mapped to page space). They drive the selection frame and
// its handles, the keyboard nudges, the Rotate button and the live preview while a picture is
// dragged. No DOM and no state, so all of it is tested in Node (tests/imageGeometry.test.ts).
//
// Matrices use the PDF layout, which is also CSS's: (x, y) → (a·x + c·y + e, b·x + d·y + f),
// combined in PDF row-vector order (concat(a, b) is "a, then b"). Page space is in points with
// y pointing down, so a positive angle turns clockwise on screen.
//
// Resizing works inside the picture's own unit square (a scale about the opposite corner or
// edge), so a rotated, flipped or skewed picture keeps its rotation, flip and skew, and the
// corner or edge that should stay put stays exactly where it was.
import { MAX_IMAGE_SIDE, type Matrix, type Rect } from "../engine/protocol";

export type Point = [number, number];
/** The frame's resize handles: four corners and four edges, named by compass point as seen. */
export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export const IDENTITY: Matrix = Object.freeze([1, 0, 0, 1, 0, 0]) as Matrix;

/** Within this many degrees of 0/90/180/270 a rotation gesture snaps to it. */
const RIGHT_ANGLE_SNAP = 3;
/** Rotation step with the snap modifier (Shift on desktop), in degrees. */
const SNAP_STEP = 15;
/**
 * clampCentre puts a centre that was off the page this far inside the edge (points), so that
 * rounding in the engine's own centre computation cannot put it back outside.
 */
const EDGE_MARGIN = 1e-6;

/** Where each handle sits in the picture's unit square. */
const HANDLE_UNIT: Record<Handle, Point> = {
  nw: [0, 0],
  n: [0.5, 0],
  ne: [1, 0],
  e: [1, 0.5],
  se: [1, 1],
  s: [0.5, 1],
  sw: [0, 1],
  w: [0, 0.5],
};

/** "a then b" (PDF row-vector order). */
export function concat(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

/** The inverse matrix. Throws on a singular (or non-finite) matrix. */
export function invert(m: Matrix): Matrix {
  const det = m[0] * m[3] - m[1] * m[2];
  if (det === 0 || !Number.isFinite(det)) throw new Error("singular matrix");
  const a = m[3] / det, b = -m[1] / det, c = -m[2] / det, d = m[0] / det;
  return [a, b, c, d, -(m[4] * a + m[5] * c), -(m[4] * b + m[5] * d)];
}

export function applyTo(m: Matrix, [x, y]: Point): Point {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** The picture's corners as seen: top-left, top-right, bottom-right, bottom-left. */
export function corners(m: Matrix): [Point, Point, Point, Point] {
  return [applyTo(m, [0, 0]), applyTo(m, [1, 0]), applyTo(m, [1, 1]), applyTo(m, [0, 1])];
}

export function centre(m: Matrix): Point {
  return applyTo(m, [0.5, 0.5]);
}

/** Side lengths in points: width along the top edge, height along the left edge. */
export function sides(m: Matrix): { width: number; height: number } {
  return { width: Math.hypot(m[0], m[1]), height: Math.hypot(m[2], m[3]) };
}

/** Angle of the top edge, clockwise on screen (y down), in degrees, in [0, 360). */
export function rotationDeg(m: Matrix): number {
  const [a, b] = m;
  // Exact for a picture at a right angle (atan2 in degrees is not always a whole number there).
  if (b === 0) return a < 0 ? 180 : 0;
  if (a === 0) return b > 0 ? 90 : 270;
  return normaliseDeg((Math.atan2(b, a) * 180) / Math.PI);
}

export function boundsOf(m: Matrix): Rect {
  const cs = corners(m);
  const xs = cs.map((p) => p[0]), ys = cs.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export function translateBy(m: Matrix, dx: number, dy: number): Matrix {
  return [m[0], m[1], m[2], m[3], m[4] + dx, m[5] + dy];
}

/** Rotated by `deg` clockwise on screen about `about`. */
export function rotateAbout(m: Matrix, [x, y]: Point, deg: number): Matrix {
  const [cos, sin] = cosSin(deg);
  return tidy(concat(m, [cos, sin, -sin, cos, x - x * cos + y * sin, y - x * sin - y * cos]));
}

/** 90° clockwise about its own centre. */
export function rotate90(m: Matrix): Matrix {
  return rotateAbout(m, centre(m), 90);
}

export function scaleAbout(m: Matrix, [x, y]: Point, factor: number): Matrix {
  return concat(m, [factor, 0, 0, factor, x * (1 - factor), y * (1 - factor)]);
}

/**
 * Width and height changed by `dw` and `dh` points about the centre (the keyboard's stretch),
 * keeping the rotation, flip and skew. A side of no length, or one the change would make
 * zero or negative, stays as it is.
 */
export function stretchBy(m: Matrix, dw: number, dh: number): Matrix {
  const { width, height } = sides(m);
  const factor = (side: number, change: number) => (side > 0 && side + change > 0 ? (side + change) / side : 1);
  const kx = factor(width, dw), ky = factor(height, dh);
  // A scale about the middle of the unit square, then the picture's own matrix.
  return concat([kx, 0, 0, ky, 0.5 * (1 - kx), 0.5 * (1 - ky)], m);
}

/**
 * stretchBy as seen on screen: wider by `dx` and taller by `dy` points. Each change goes to the
 * picture's side that runs closer to that direction, so after a quarter turn (its width now runs
 * down the page) the arrow → lengthens its height, which is what shows as its width.
 */
export function stretchOnScreen(m: Matrix, dx: number, dy: number): Matrix {
  return sidesSwapped(m) ? stretchBy(m, dy, dx) : stretchBy(m, dx, dy);
}

/**
 * The picture's height runs closer to horizontal on screen than its width does: it is turned
 * nearer to 90° or 270° than to 0° or 180° (skew and flips included, by its edges' directions).
 */
export function sidesSwapped(m: Matrix): boolean {
  const { width, height } = sides(m);
  if (!(width > 0) || !(height > 0)) return false;
  return Math.abs(m[2]) / height > Math.abs(m[0]) / width;
}

/** Where `handle` is on the page (the middle of the side for an edge handle). */
export function handlePoint(m: Matrix, handle: Handle): Point {
  return applyTo(m, HANDLE_UNIT[handle]);
}

/**
 * The point `distance` (page units) out from the middle of the picture's top or bottom edge as
 * seen, away from the other one, along its left edge: where the selection frame's children placed
 * above or below the picture (the rotation knob, the touch grip of a small picture) end up, since
 * the frame's CSS transform keeps lengths along that edge (cssBox).
 */
export function beyondEdge(m: Matrix, edge: "top" | "bottom", distance: number): Point {
  const height = Math.hypot(m[2], m[3]);
  // Down the picture, as seen: its left edge's direction (straight down when it has no height).
  const down: Point = height > 0 ? [m[2] / height, m[3] / height] : [0, 1];
  const sign = edge === "top" ? -1 : 1;
  const [x, y] = applyTo(m, [0.5, edge === "top" ? 0 : 1]);
  return [x + sign * down[0] * distance, y + sign * down[1] * distance];
}

/**
 * Dragging `handle` to `pointer` (page space): the opposite corner (or opposite edge) stays
 * where it is, also for rotated or flipped pictures. Corner handles scale uniformly when
 * `keepAspect` (the size follows the pointer's projection on the diagonal), freely otherwise;
 * edge handles change one side only (keepAspect is ignored). A pointer dragged past the
 * opposite side does not flip the picture.
 *
 * The drag makes no side shorter than `minSide` (it stops there) nor longer than MAX_IMAGE_SIDE
 * (the engine would refuse it), but it never forces a change either: a side that is already
 * shorter than `minSide` (a thin rule, a small icon at a low zoom) can grow and does not shrink,
 * and a side already longer than MAX_IMAGE_SIDE can shrink and does not grow, so a picture
 * nudged by a few pixels changes by a few pixels. When no scale can keep both limits, the
 * matrix stays as it is.
 *
 * With `keepAspect`, a corner dragged inward on a picture whose one side is already at or below
 * `minSide` shrinks the other side alone (down to its own limit), by as much as the uniform scale
 * would have: so a 300 × 3 pt rule can be shortened from a corner, keeping its thickness, where
 * there is no Shift and there are no edge handles (touch). Outward the scale is uniform again.
 */
export function resize(m: Matrix, handle: Handle, pointer: Point, opts: { keepAspect: boolean; minSide: number }): Matrix {
  if (!Number.isFinite(pointer[0]) || !Number.isFinite(pointer[1])) return copy(m);
  let inverse: Matrix;
  try {
    inverse = invert(m);
  } catch {
    return copy(m); // a picture with no area: nothing sensible to drag
  }
  const [hu, hv] = HANDLE_UNIT[handle];
  // The point that stays put, in the unit square: the opposite corner, or a point of the
  // opposite edge (for an edge handle the other coordinate does not scale, so any point will do).
  const au = 1 - hu, av = 1 - hv;
  const anchor = applyTo(m, [au, av]);
  const { width, height } = sides(m);
  const { minSide } = opts;
  // The scale limits of each side: down to minSide, up to MAX_IMAGE_SIDE, but never past 1 (no
  // forced growth of a side already shorter than minSide, nor forced shrinking of a longer one).
  const floor = (side: number) => Math.min(1, minSide / side);
  const ceiling = (side: number) => Math.max(1, MAX_IMAGE_SIDE / side);
  let sx = 1, sy = 1;
  if (hu !== 0.5 && hv !== 0.5 && opts.keepAspect) {
    // Uniform: the pointer projected on the diagonal from the anchor to the handle.
    const [hx, hy] = applyTo(m, [hu, hv]);
    const dx = hx - anchor[0], dy = hy - anchor[1];
    const s = ((pointer[0] - anchor[0]) * dx + (pointer[1] - anchor[1]) * dy) / (dx * dx + dy * dy);
    const fw = floor(width), fh = floor(height);
    const lo = Math.max(fw, fh);
    const hi = Math.min(ceiling(width), ceiling(height));
    if (!(lo <= hi)) return copy(m);
    // Held back only by a side already at or below minSide (its floor is 1, the other's is not):
    // that side stays, the other one follows the scale alone.
    if (s < lo && fh >= 1 && fw < 1) sx = Math.max(s, fw);
    else if (s < lo && fw >= 1 && fh < 1) sy = Math.max(s, fh);
    else sx = sy = clamp(s, lo, hi);
  } else {
    // Free: the pointer in the picture's own unit square says how far each moving side goes.
    const [pu, pv] = applyTo(inverse, pointer);
    if (hu !== 0.5) sx = clamp((pu - au) / (hu - au), floor(width), ceiling(width));
    if (hv !== 0.5) sy = clamp((pv - av) / (hv - av), floor(height), ceiling(height));
  }
  // Scale the two columns, then place the result so that the anchor maps where it did.
  const a = m[0] * sx, b = m[1] * sx, c = m[2] * sy, d = m[3] * sy;
  return [a, b, c, d, anchor[0] - au * a - av * c, anchor[1] - au * b - av * d];
}

/**
 * Rotation about the centre by the angle swept from `start` to `pointer` around it, applied to
 * `m` (the matrix when the gesture began). The resulting absolute rotation snaps to 0/90/180/270
 * within 3°, and to multiples of 15° when `snap` is set.
 */
export function rotateTo(m: Matrix, start: Point, pointer: Point, opts: { snap: boolean }): Matrix {
  const [cx, cy] = centre(m);
  const sx = start[0] - cx, sy = start[1] - cy;
  const px = pointer[0] - cx, py = pointer[1] - cy;
  // On the centre (or not a number) there is no angle to follow.
  if (!(Math.hypot(sx, sy) > 0) || !(Math.hypot(px, py) > 0)) return copy(m);
  let swept = ((Math.atan2(py, px) - Math.atan2(sy, sx)) * 180) / Math.PI;
  if (swept > 180) swept -= 360;
  else if (swept <= -180) swept += 360;
  const from = rotationDeg(m);
  let to = from + swept;
  if (opts.snap) to = Math.round(to / SNAP_STEP) * SNAP_STEP;
  else {
    const right = Math.round(to / 90) * 90;
    if (Math.abs(to - right) <= RIGHT_ANGLE_SNAP) to = right;
  }
  return rotateAbout(m, [cx, cy], to - from);
}

/** Moved (translation only) so that its centre lies inside `bounds`. */
export function clampCentre(m: Matrix, bounds: Rect): Matrix {
  const [cx, cy] = centre(m);
  const x = clampInside(cx, bounds[0], bounds[2]);
  const y = clampInside(cy, bounds[1], bounds[3]);
  return x === cx && y === cy ? copy(m) : translateBy(m, x - cx, y - cy);
}

/** True when every number of `a` is within `eps` of the same number of `b`. */
export function nearlyEqual(a: Matrix, b: Matrix, eps = 0.01): boolean {
  for (let i = 0; i < 6; i++) if (!(Math.abs(a[i] - b[i]) <= eps)) return false;
  return true;
}

/**
 * CSS for an absolutely positioned box inside a page element whose top-left is page point
 * `origin`: a W×H px box at (left, top) with `transform-origin: 0 0` and this `transform`
 * covers the picture's quad exactly (rotation, flip or skew included; for an unskewed picture
 * the transform is a pure rotation/reflection, so borders and children keep their size).
 * The box's own top-left corner is the picture's top-left corner as seen (unit point 0, 0).
 */
export function cssBox(m: Matrix, origin: Point, zoom: number): { left: number; top: number; width: number; height: number; transform: string } {
  const { width, height } = sides(m);
  // The box is the picture at its real size; the transform only turns (and, if skewed, shears)
  // it: its columns are the picture's edge directions, of length 1.
  const ux: Point = width > 0 ? [m[0] / width, m[1] / width] : [1, 0];
  const uy: Point = height > 0 ? [m[2] / height, m[3] / height] : [0, 1];
  return {
    left: round6((m[4] - origin[0]) * zoom),
    top: round6((m[5] - origin[1]) * zoom),
    width: round6(width * zoom),
    height: round6(height * zoom),
    transform: cssMatrix([ux[0], ux[1], uy[0], uy[1], 0, 0]),
  };
}

/**
 * CSS transform (origin 0 0) for an element placed at `rect`'s top-left with `rect`'s size in
 * px, showing a bitmap of `rect` captured while the picture was at `from`, so that it shows the
 * picture at `to` instead (the live preview while dragging). The identity when `from` is singular.
 */
export function previewTransform(rect: Rect, from: Matrix, to: Matrix, zoom: number): string {
  let back: Matrix;
  try {
    back = invert(from);
  } catch {
    return cssMatrix(IDENTITY);
  }
  // Element px → page point → the picture's unit square (as it was) → page point (as it will
  // be) → element px.
  const toPage: Matrix = [1 / zoom, 0, 0, 1 / zoom, rect[0], rect[1]];
  const toPx: Matrix = [zoom, 0, 0, zoom, -rect[0] * zoom, -rect[1] * zoom];
  return cssMatrix(concat(concat(concat(toPage, back), to), toPx));
}

/** CSS matrix() for `m`, in plain decimals (6 places at most, never an exponent). */
export function cssMatrix(m: Matrix): string {
  return `matrix(${m.map(cssNumber).join(", ")})`;
}

/** Effective resolution in pixels per inch along the picture's width. */
export function ppi(pixelWidth: number, widthPt: number): number {
  return widthPt > 0 && Number.isFinite(widthPt) ? (pixelWidth * 72) / widthPt : 0;
}

/** Page point under a client (viewport) position, for a page element at `pageRect` (getBoundingClientRect) showing `origin` at its top-left. */
export function pagePoint(clientX: number, clientY: number, pageRect: { left: number; top: number }, origin: Point, zoom: number): Point {
  return [(clientX - pageRect.left) / zoom + origin[0], (clientY - pageRect.top) / zoom + origin[1]];
}

// ------------------------------------------------------------------ helpers

function copy(m: Matrix): Matrix {
  return [m[0], m[1], m[2], m[3], m[4], m[5]];
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

/** `v` if it lies in [lo, hi]; else just inside the nearer end. */
function clampInside(v: number, lo: number, hi: number) {
  if (v >= lo && v <= hi) return v;
  const margin = Math.min(EDGE_MARGIN, (hi - lo) / 2);
  return v < lo ? lo + margin : hi - margin;
}

function normaliseDeg(deg: number) {
  return ((deg % 360) + 360) % 360;
}

/** cos and sin of an angle in degrees, exact at the right angles. */
function cosSin(deg: number): Point {
  switch (normaliseDeg(deg)) {
    case 0:
      return [1, 0];
    case 90:
      return [0, 1];
    case 180:
      return [-1, 0];
    case 270:
      return [0, -1];
  }
  const r = (deg * Math.PI) / 180;
  return [Math.cos(r), Math.sin(r)];
}

/**
 * The rounding noise a rotation leaves (a component of 1e-17 where there should be 0) set to 0,
 * so a picture turned to a right angle is exactly upright and rotationDeg says exactly 90.
 */
function tidy(m: Matrix): Matrix {
  const tiny = 1e-12 * Math.max(Math.abs(m[0]), Math.abs(m[1]), Math.abs(m[2]), Math.abs(m[3]));
  const z = (v: number) => (Math.abs(v) < tiny ? 0 : v);
  return [z(m[0]), z(m[1]), z(m[2]), z(m[3]), m[4], m[5]];
}

/** Rounded to 6 decimals, without -0: CSS px values that never print with an exponent. */
function round6(v: number) {
  return Math.round(v * 1e6) / 1e6 + 0;
}

function cssNumber(v: number) {
  if (!Number.isFinite(v)) return "0";
  const r = round6(v);
  if (r === 0) return "0";
  return r.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}
