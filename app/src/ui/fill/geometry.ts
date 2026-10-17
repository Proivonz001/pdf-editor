// Geometry of "Compila e firma" (fill and sign): what counts as a tap, where the text writer
// starts, how large a signature lands and where, how initials are copied to the same place on
// pages of other sizes, and how far the viewer zooms in so that text being written is readable
// on a phone. Pure functions, no DOM and no state, so all of it is tested in Node
// (tests/fill-helpers.test.ts), ported from the release 3 UX prototype.
//
// Coordinates are page space (points, y down, /Rotate and the CropBox already applied, as
// protocol.ts says), so a rotated or cropped page needs no special case here. Matrices follow
// ImageInfo.matrix: the picture's unit square, (0, 0) its top-left corner as seen, mapped to page
// space (viewer/imageGeometry.ts).
import type { Matrix, Rect } from "../../engine/protocol";
import { boundsOf, type Point } from "../../viewer/imageGeometry";
import { MAX_ZOOM } from "../../viewer/layout";

/** Points per millimetre. */
export const MM = 72 / 25.4;

/** Travel that still counts as a tap, in CSS px: a finger wobbles more than a mouse. */
export const TAP_SLOP_TOUCH = 10;
export const TAP_SLOP_MOUSE = 3;
/** A press held longer than this is not a tap (ms). */
export const TAP_MAX_MS = 600;

/** Text being written shows at least this tall on touch screens (CSS px)... */
export const WRITE_PX = 16;
/** ...and the viewer zooms in only when it would show smaller than this (90 %: no jump for a hair). */
export const WRITE_MIN_PX = 14.4;

/** Default size of a placed signature: 50 mm wide, at most 20 mm tall. */
const SIGNATURE_WIDTH = 50 * MM;
const SIGNATURE_MAX_HEIGHT = 20 * MM;
/** Default size of placed initials: 10 mm tall. */
const INITIALS_HEIGHT = 10 * MM;
/** A signature placed at a tap sits on the line: its bottom this much of its height below the tap. */
const BELOW_TAP = 0.15;

/** One press on the page, as the fill layer measured it from pointerdown to pointerup. */
export interface Press {
  /** Travel from where it started, in CSS px. */
  dx: number;
  dy: number;
  /** How long it lasted. */
  ms: number;
  /** The most pointers down at once during the press (two fingers: a pinch). */
  pointers: number;
  /** The page scrolled while it was down (one finger dragging scrolls). */
  scrolled: boolean;
  /** A finger (or a pen), not a mouse. */
  coarse: boolean;
}

/**
 * The press is a tap, which places something or opens a writer: one pointer, at most 10 px of
 * travel on touch (3 px with a mouse), at most 600 ms, and no scroll in between. Anything else is
 * left to the scroller and the pinch zoom.
 */
export function isTap(p: Press): boolean {
  const slop = p.coarse ? TAP_SLOP_TOUCH : TAP_SLOP_MOUSE;
  return p.pointers === 1 && !p.scrolled && Math.hypot(p.dx, p.dy) <= slop && p.ms >= 0 && p.ms <= TAP_MAX_MS;
}

/**
 * The writer's baseline start for a tap at `tap`, with text of `size` points: 0.2 em above the
 * point, so the text sits on the printed line that was tapped instead of crossing it.
 */
export function writerOrigin(tap: Point, size: number): Point {
  const s = Number.isFinite(size) && size > 0 ? size : 0;
  return [tap[0], tap[1] - 0.2 * s];
}

/**
 * Where a signature or initials picture lands, as a rectangle in page space. A signature is 50 mm
 * wide and at most 20 mm tall (a 3:1 signature: 50 × 16.7 mm); initials are 10 mm tall. At a tap
 * `at`: centred on it across, its bottom 15 % of its height below it (it sits on the line, as on
 * paper); without one, centred on the page. Always on the page: shrunk when the page is smaller,
 * moved in when it would stick out. `aspect` is the picture's width / height.
 */
export function signatureRect(page: Rect, kind: "signature" | "initials", aspect: number, at?: Point): Rect {
  const ar = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  let w: number, h: number;
  if (kind === "initials") {
    h = INITIALS_HEIGHT;
    w = h * ar;
  } else {
    w = SIGNATURE_WIDTH;
    h = w / ar;
    if (h > SIGNATURE_MAX_HEIGHT) {
      h = SIGNATURE_MAX_HEIGHT;
      w = h * ar;
    }
  }
  const pageW = page[2] - page[0], pageH = page[3] - page[1];
  const s = Math.min(1, pageW / w, pageH / h);
  w *= s;
  h *= s;
  const [x, y] = at ?? [(page[0] + page[2]) / 2, (page[1] + page[3]) / 2 + (0.5 - BELOW_TAP) * h];
  const bottom = y + BELOW_TAP * h;
  return keepOn([x - w / 2, bottom - h, x + w / 2, bottom], page);
}

/**
 * A picture of proportions `aspect` (width / height) inside a signature field's box: as large as
 * fits (contain), centred across and resting on the box's bottom, where the signature line is.
 * Upright: for a field whose text is turned (FieldWidget.rotation), signatureInField.
 */
export function fitInField(rect: Rect, aspect: number): Rect {
  const x0 = Math.min(rect[0], rect[2]), x1 = Math.max(rect[0], rect[2]);
  const y0 = Math.min(rect[1], rect[3]), y1 = Math.max(rect[1], rect[3]);
  const bw = x1 - x0, bh = y1 - y0;
  if (!(bw > 0) || !(bh > 0)) return [x0, y0, x1, y1];
  const ar = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const w = Math.min(bw, bh * ar), h = w / ar;
  const left = x0 + (bw - w) / 2;
  return [left, y1 - h, left + w, y1];
}

/** An upright picture filling `rect` (ImageInfo.matrix convention), for addImage. */
export function rectMatrix(rect: Rect): Matrix {
  return [rect[2] - rect[0], 0, 0, rect[3] - rect[1], rect[0], rect[1]];
}

/**
 * Where a signature picture of proportions `aspect` lands in a signature field (the matrix for
 * addImage): turned with the field's text, `rotation` clockwise as FieldWidget.rotation says
 * (page /Rotate plus the widget's own), as large as fits, centred along the field's line and
 * resting on its bottom edge as the text runs (the left edge of the box as seen for 90°, the
 * top for 180°, the right for 270°). For 0° it is rectMatrix(fitInField(rect, aspect)).
 */
export function signatureInField(rect: Rect, aspect: number, rotation: number): Matrix {
  const turn = Number.isFinite(rotation) ? ((Math.round(rotation / 90) % 4) + 4) % 4 : 0;
  if (turn === 0) return rectMatrix(fitInField(rect, aspect));
  const x0 = Math.min(rect[0], rect[2]), x1 = Math.max(rect[0], rect[2]);
  const y0 = Math.min(rect[1], rect[3]), y1 = Math.max(rect[1], rect[3]);
  // Fitted in the box as the text sees it (sides swapped for a quarter turn), centred on the
  // field's centre, then turned about it.
  const sideways = turn % 2 === 1;
  const bw = sideways ? y1 - y0 : x1 - x0, bh = sideways ? x1 - x0 : y1 - y0;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const [l, t, r, b] = fitInField([cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2], aspect);
  const w = r - l, h = b - t;
  // The picture's unit square: its top-left corner, and its top and left edges, turned.
  const [ux, uy] = [[1, 0], [0, 1], [-1, 0], [0, -1]][turn];
  const turned = (x: number, y: number): [number, number] => {
    const dx = x - cx, dy = y - cy;
    return [cx + dx * ux - dy * uy, cy + dx * uy + dy * ux];
  };
  const [ex, ey] = turned(l, t);
  const z = (v: number) => (v === 0 ? 0 : v); // no -0 in the matrix
  return [z(w * ux), z(w * uy), z(-h * uy), z(h * ux), ex, ey];
}

/**
 * Where a picture sits on its page, in terms that carry over to a page of another size: the
 * nearest of 9 anchors (corners, edge middles, centre: thirds of the page, by the picture's
 * centre) and its distances from the anchored edges, in points. For a "centre" or "middle"
 * anchor the distance is the offset of the picture's centre from the page's centre.
 */
export interface Anchor {
  h: "left" | "centre" | "right";
  v: "top" | "middle" | "bottom";
  dx: number;
  dy: number;
}

/** The anchor of the picture at `matrix` on a page with bounds `page` (by its box as seen). */
export function anchorOf(matrix: Matrix, page: Rect): Anchor {
  const r = boundsOf(matrix);
  const pageW = page[2] - page[0], pageH = page[3] - page[1];
  const cx = (r[0] + r[2]) / 2 - page[0], cy = (r[1] + r[3]) / 2 - page[1];
  const h = cx < pageW / 3 ? "left" : cx > (2 * pageW) / 3 ? "right" : "centre";
  const v = cy < pageH / 3 ? "top" : cy > (2 * pageH) / 3 ? "bottom" : "middle";
  const dx = h === "left" ? r[0] - page[0] : h === "right" ? page[2] - r[2] : cx - pageW / 2;
  const dy = v === "top" ? r[1] - page[1] : v === "bottom" ? page[3] - r[3] : cy - pageH / 2;
  return { h, v, dx, dy };
}

/**
 * The picture at `matrix`, put at `anchor` on a page with bounds `page`: the same size in points
 * and the same rotation, the same distances from the anchored edges (initials 15 mm from the
 * right and 12 mm from the bottom stay so on A4, A3, Letter or a receipt), shrunk only when the
 * page is smaller than the picture, and always kept on the page.
 */
export function placeOn(anchor: Anchor, matrix: Matrix, page: Rect): Matrix {
  const box = boundsOf(matrix);
  const w0 = box[2] - box[0], h0 = box[3] - box[1];
  const pageW = page[2] - page[0], pageH = page[3] - page[1];
  const s = Math.min(1, w0 > 0 ? pageW / w0 : 1, h0 > 0 ? pageH / h0 : 1);
  const w = w0 * s, h = h0 * s;
  const x0 = anchor.h === "left" ? page[0] + anchor.dx
    : anchor.h === "right" ? page[2] - anchor.dx - w
    : page[0] + pageW / 2 + anchor.dx - w / 2;
  const y0 = anchor.v === "top" ? page[1] + anchor.dy
    : anchor.v === "bottom" ? page[3] - anchor.dy - h
    : page[1] + pageH / 2 + anchor.dy - h / 2;
  const [left, top] = keepOn([x0, y0, x0 + w, y0 + h], page);
  // The same turn and flip, scaled by s, moved so that its box starts at (left, top).
  const linear: Matrix = [matrix[0] * s, matrix[1] * s, matrix[2] * s, matrix[3] * s, 0, 0];
  const lb = boundsOf(linear);
  return [linear[0], linear[1], linear[2], linear[3], left - lb[0], top - lb[1]];
}

/**
 * The zoom at which to write text of `size` points, from the current `zoom` (CSS px per point).
 * On touch screens (`coarse`) text that would show under 14.4 px gets zoomed to 16 px: iOS then
 * does not zoom the whole page into the field, and a finger can aim. Never zooms out, never past
 * MAX_ZOOM; with a mouse the zoom stays as it is.
 */
export function zoomToWrite(size: number, zoom: number, coarse: boolean): number {
  if (!coarse || !(size > 0) || !(zoom > 0) || size * zoom >= WRITE_MIN_PX) return zoom;
  return Math.max(zoom, Math.min(MAX_ZOOM, WRITE_PX / size));
}

// ------------------------------------------------------------------ helpers

/** `r` moved (not resized) so that it lies on `page`; a rect larger than the page keeps its top-left on it. */
function keepOn(r: Rect, page: Rect): Rect {
  const w = r[2] - r[0], h = r[3] - r[1];
  const x0 = Math.max(page[0], Math.min(r[0], page[2] - w));
  const y0 = Math.max(page[1], Math.min(r[1], page[3] - h));
  return [x0, y0, x0 + w, y0 + h];
}
