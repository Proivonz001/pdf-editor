// Sizes for the scan pipeline: how large the working photo is, what each mode writes (resolution,
// JPEG quality), how large the page comes out for each page shape, and the sheet's own
// proportions read from its corners. Also the checks on corners the user moved (inside the
// frame, a real quadrilateral), shared by the client and the worker.
import type { Corners, PageShape, Point, ScanMode } from "./types";

/** Longest side of the working photo, in pixels: a 12 MP (or larger) photo is scaled down to it (A4 at 300 dpi is 3508). */
export const WORKING_SIDE = 3500;

/**
 * What each mode writes: the page's resolution and, for JPEG pages, the quality (0..1, as a
 * canvas takes it). "bw" is a 1-bit PNG, so it has no quality. The decided defaults: Documento
 * 200 dpi q 0.72, Grigio 200 dpi q 0.65, Bianco e nero 300 dpi 1-bit, Originale 200 dpi q 0.8.
 */
export const MODE_SETTINGS: Readonly<Record<ScanMode, { dpi: number; quality: number | null }>> = {
  document: { dpi: 200, quality: 0.72 },
  grey: { dpi: 200, quality: 0.65 },
  bw: { dpi: 300, quality: null },
  original: { dpi: 200, quality: 0.8 },
};

/** A4 in millimetres, portrait. */
export const A4_MM: readonly [number, number] = [210, 297];
const MM_PER_INCH = 25.4;

/** Longest side of the tray's preview, in pixels, and its JPEG quality. */
export const PREVIEW_SIDE = 360;
export const PREVIEW_QUALITY = 0.7;

/** A sheet more elongated than this (a receipt strip is about 1:4) is taken as this. */
const MAX_ASPECT = 12;
/** Smallest side of a page in pixels (a very thin strip still makes a readable page). */
const MIN_PAGE_SIDE = 16;

/** `width` × `height` scaled down (never up) so the longer side is at most `max`: whole pixels, at least 1. */
export function fitSide(width: number, height: number, max: number): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** The four corners of the whole frame of a `width` × `height` photo. */
export function wholeFrame(width: number, height: number): Corners {
  return [[0, 0], [width, 0], [width, height], [0, height]];
}

/** The corners moved inside the frame (each coordinate clamped to 0..width or 0..height). */
export function clampCorners(corners: Corners, width: number, height: number): Corners {
  const clamp = ([x, y]: Point): Point => [Math.min(width, Math.max(0, x)), Math.min(height, Math.max(0, y))];
  return [clamp(corners[0]), clamp(corners[1]), clamp(corners[2]), clamp(corners[3])];
}

/** Signed area of a polygon by the shoelace formula: positive when its points go clockwise on screen (y down). */
export function signedArea(q: readonly Point[]): number {
  let s = 0;
  for (let i = 0; i < q.length; i++) {
    const a = q[i], b = q[(i + 1) % q.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

/** Each turn of the quadrilateral bends the same way, clockwise on screen: convex, in TL TR BR BL order, not twisted. */
export function isConvexClockwise(q: Corners): boolean {
  for (let i = 0; i < 4; i++) {
    const o = q[i], a = q[(i + 1) % 4], b = q[(i + 2) % 4];
    if ((a[0] - o[0]) * (b[1] - a[1]) - (a[1] - o[1]) * (b[0] - a[0]) <= 0) return false;
  }
  return true;
}

/**
 * The corners make a sheet the pipeline can straighten: finite numbers, inside the frame (with
 * half a pixel of slack), convex, in TL TR BR BL order, and covering at least 1/400 of the frame.
 * The corner editor can use it to tell when the handles have been crossed.
 */
export function cornersUsable(corners: Corners, width: number, height: number): boolean {
  if (!Array.isArray(corners) || corners.length !== 4) return false;
  for (const p of corners) {
    if (!Array.isArray(p) || p.length !== 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return false;
    if (p[0] < -0.5 || p[1] < -0.5 || p[0] > width + 0.5 || p[1] > height + 0.5) return false;
  }
  return isConvexClockwise(corners) && signedArea(corners) >= (width * height) / 400;
}

const dist = (a: Point, b: Point) => Math.hypot(b[0] - a[0], b[1] - a[1]);

/** Width over height of the sheet from its sides as seen: right with no perspective, approximate with some. */
function sideAspect(q: Corners): number {
  const w = dist(q[0], q[1]) + dist(q[3], q[2]);
  const h = dist(q[0], q[3]) + dist(q[1], q[2]);
  return h > 0 ? w / h : 1;
}

/**
 * The focal length assumed when the corners cannot tell it, as a share of the photo's diagonal:
 * a phone's main camera (24–26 mm, 35 mm equivalent, over a 43.3 mm diagonal) is about 0.6.
 */
const TYPICAL_FOCAL = 0.6;
/** Focal lengths measured outside this range (shares of the diagonal) are not believed: ultra-wide is about 0.3, telephoto about 2. */
const FOCAL_RANGE: readonly [number, number] = [0.25, 3];
/** A vanishing point farther than 1 / this diagonals away shows too little perspective to measure the focal length from. */
const MIN_PERSPECTIVE = 0.02;

/**
 * The sheet's own width over height, from its corners in a `width` × `height` photo. A tilted
 * sheet looks shorter in the direction it tilts away, so the sides as seen are not enough: the
 * rectangle's projection gives back the camera's focal length and with it the true proportions
 * (Zhang and He, "Whiteboard scanning and image enhancement", 2007), taking the camera's centre
 * at the photo's centre and square pixels, as phone photos have. The focal length can only be
 * measured when both pairs of sides converge (two vanishing points); when one pair is parallel
 * (a sheet tilted about the photo's own axis) or the measure is implausible (a cropped photo,
 * corners off the sheet), a typical phone lens is assumed. With no perspective at all (the whole
 * frame, a sheet shot straight on) the lens plays no part: the sides as seen are the answer.
 */
export function sheetAspect(corners: Corners, width: number, height: number): number {
  const cx = width / 2, cy = height / 2;
  const m = corners.map(([x, y]) => [x - cx, y - cy, 1]);
  const [m1, m2, m4, m3] = m; // TL, TR, BR, BL as Zhang's m1, m2, m4, m3
  const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const c14 = cross(m1, m4);
  const k2 = dot(c14, m3) / dot(cross(m2, m4), m3);
  const k3 = dot(c14, m2) / dot(cross(m3, m4), m2);
  // The directions of the sheet's sides, homogeneous: [x, y, z] has its vanishing point at (x / z, y / z).
  const n2 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 * m2[2] - m1[2]];
  const n3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 * m3[2] - m1[2]];
  const diagonal = Math.hypot(width, height);
  const converges = (n: number[]) => (Math.abs(n[2]) * diagonal) / (Math.hypot(n[0], n[1]) || 1) > MIN_PERSPECTIVE;
  let f2 = (TYPICAL_FOCAL * diagonal) ** 2;
  if (converges(n2) && converges(n3)) {
    const measured = -(n2[0] * n3[0] + n2[1] * n3[1]) / (n2[2] * n3[2]);
    if (measured > (FOCAL_RANGE[0] * diagonal) ** 2 && measured < (FOCAL_RANGE[1] * diagonal) ** 2) f2 = measured;
  }
  const a2 = (n2[0] ** 2 + n2[1] ** 2 + f2 * n2[2] ** 2) / (n3[0] ** 2 + n3[1] ** 2 + f2 * n3[2] ** 2);
  let aspect = Number.isFinite(a2) && a2 > 0 ? Math.sqrt(a2) : sideAspect(corners);
  if (!(aspect > 0) || !Number.isFinite(aspect)) aspect = 1;
  return Math.min(MAX_ASPECT, Math.max(1 / MAX_ASPECT, aspect));
}

/**
 * The page in pixels for a sheet of proportions `aspect` (width over height) at `dpi`: A4 in
 * the sheet's orientation (landscape when it is wider than tall), or, for "photo", the sheet's
 * own proportions with its longer side as long as A4's.
 */
export function pageSize(aspect: number, shape: PageShape, dpi: number): { width: number; height: number } {
  const px = (mm: number) => Math.max(MIN_PAGE_SIDE, Math.round((mm / MM_PER_INCH) * dpi));
  const landscape = aspect > 1;
  if (shape === "a4") {
    const [short, long] = A4_MM;
    return landscape ? { width: px(long), height: px(short) } : { width: px(short), height: px(long) };
  }
  const long = px(A4_MM[1]);
  return landscape
    ? { width: long, height: Math.max(MIN_PAGE_SIDE, Math.round(long / aspect)) }
    : { width: Math.max(MIN_PAGE_SIDE, Math.round(long * aspect)), height: long };
}
