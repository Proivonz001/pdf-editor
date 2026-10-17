// The pictures behind a signature or initials: every way of making one ends as a trimmed PNG with
// transparency (report-ux §4.7), placed on the page by release 2's image code. So no font is
// embedded, PDF/A sees an ordinary picture, and the frame moves and resizes it.
//
// - Disegna: the pad stores points, not pixels. strokePieces turns a stroke into quadratic curves
//   through the midpoints of its points, with a width that follows the speed (signature_pad's
//   defaults) or a pen's pressure; drawPieces paints them. The pad draws with them live, and
//   renderStrokes paints them again, sharp, at the output size. A stroke keeps the coordinates
//   it was drawn in: a pad that shrinks shows the strokes smaller (fitScale), it never rewrites
//   them, and every stroke has the same line weight in the picture, also one added while the pad
//   showed the others smaller.
// - Scrivi: renderTyped draws the typed name in one of the device's handwriting fonts
//   (handwritingFonts.ts) at 120 px and trims it to its ink; initialsOf makes the initials the
//   Sigla sheet starts with from the name typed for the signature.
// - Foto: extractInk keeps only the ink of a photo of a signature on paper (ported from the
//   release 3 UX prototype, tested on synthetic photos), and renderInk paints it, cropped, in the
//   pen's own colour or the one chosen.
//
// The pixel work (extractInk, trim, strokePieces) is plain code over typed arrays, tested in Node;
// the canvas layer around it is kept thin, so a fake canvas tests it (tests/fill-helpers.test.ts,
// as tests/imageFile.test.ts does). Output RGBA is straight alpha, as ImageData is.
import type { Rect } from "../../engine/protocol";
import type { InkColor } from "../../state";
import type { Point } from "../../viewer/imageGeometry";
import { fitWithin, PictureError } from "../imageFile";

/** The inks as pixels, 0..255: black and a ballpoint blue (state.INK has the same ones in 0..1). */
export const INK_RGB: Readonly<Record<InkColor, readonly [number, number, number]>> = {
  black: [0, 0, 0],
  blue: [0x1f, 0x3b, 0x94],
};

/**
 * Longest side of a drawn or typed signature, in pixels: 50 mm wide at over 300 ppi, and about
 * 20 KB as a PNG.
 */
export const SIGNATURE_MAX_SIDE = 1200;
/** A photo is looked at no larger than this (longest side, pixels): about 1.6 megapixels, a fraction of a second. */
export const PHOTO_MAX_SIDE = 1600;
/** Ink plus this much of its longer side around it, in the output. */
const MARGIN = 0.04;
/**
 * A drawing is painted at most this many output pixels per pad px: a few short strokes make a
 * small picture, not one blown up to SIGNATURE_MAX_SIDE (the pad showed them at 1 to 3 device
 * pixels per px).
 */
const MAX_UPSCALE = 8;
/**
 * Ink whose box is shorter than this on its longer side (pad px, line widths included) is not
 * a signature: a tap or a slip on the pad (a dot is 3 px). Use stays off until there is more.
 */
export const MIN_INK_EXTENT = 15;
/** A typed name: the font size it is drawn at, the room around it for script fonts' overhangs, and the margin kept. */
const TYPED_PX = 120;
const TYPED_PAD = 0.6;
const TYPED_MARGIN = 0.05;
/** No canvas side above this while drawing a typed name (every browser allows it). */
const MAX_CANVAS_SIDE = 4096;

/** A finished signature picture. */
export interface SignatureImage {
  png: Blob;
  width: number;
  height: number;
}

/** There is nothing to draw: no stroke, an empty name, or a crop with no ink in it. */
export class NoInkError extends Error {}

// ---------------------------------------------------------------------------------------------
// Drawn signatures

/** One point of a stroke on the pad. */
export interface StrokePoint {
  /** Pad px: CSS px on the pad divided by the stroke's scale. */
  x: number;
  y: number;
  /** PointerEvent.timeStamp, ms. */
  time: number;
  /** A pen's pressure, 0..1, which then sets the width. Left out for a finger or a mouse: the width follows the speed. */
  pressure?: number;
}

/** One stroke on the pad, from the pointer going down to it lifting. */
export interface Stroke {
  readonly points: readonly StrokePoint[];
  /**
   * CSS px on the pad per pad px while it was drawn: 1, or less when the pad had shrunk and
   * showed the ink smaller (SignaturePad). The speed and the gap between points kept are
   * measured as the hand drew them, at that scale; the width is in pad px, as for any stroke.
   */
  readonly scale: number;
}

export interface StrokeOptions {
  /** Half-width of the line when fast, and the largest half-width, in pad px. */
  minWidth: number;
  maxWidth: number;
  /** How much a new speed counts against the previous one (smooths the width). */
  velocityFilterWeight: number;
  /** Points closer than this to the last one kept are skipped, in pad px. */
  minDistance: number;
}

/** signature_pad's defaults, at 1 CSS px. */
export const STROKE_OPTIONS: StrokeOptions = { minWidth: 0.5, maxWidth: 2.5, velocityFilterWeight: 0.7, minDistance: 5 };

/** A piece of a stroke: a quadratic curve from `from` to `to` that bends towards `control`, its half-width going from `w0` to `w1`. */
export interface StrokePiece {
  from: Point;
  control: Point;
  to: Point;
  w0: number;
  w1: number;
}

/**
 * The pieces that draw `stroke` (in pad px): a curve through the midpoints between its points,
 * each point the control of the curve around it, a straight piece at each end; a single point is
 * a dot. The half-width follows the pen's pressure when the points have one, otherwise the
 * speed: wide when slow, thin when fast, smoothed from point to point. Speeds and the gap between
 * points are those of the hand on the screen, at the stroke's scale; the width is in pad px
 * whatever the scale, so a stroke added while the pad showed the ink smaller has the line weight
 * of the others (it shows as thin as they do there, and the picture has one weight).
 */
export function strokePieces(stroke: Stroke, opts: StrokeOptions = STROKE_OPTIONS): StrokePiece[] {
  const k = Number.isFinite(stroke.scale) && stroke.scale > 0 ? stroke.scale : 1;
  if (k === 1) return piecesOf(stroke.points, opts);
  const seen = piecesOf(stroke.points.map((p) => ({ ...p, x: p.x * k, y: p.y * k })), opts);
  const back = ([x, y]: Point): Point => [x / k, y / k];
  return seen.map((q) => ({ from: back(q.from), control: back(q.control), to: back(q.to), w0: q.w0, w1: q.w1 }));
}

/** strokePieces for points in CSS px as drawn. */
function piecesOf(stroke: readonly StrokePoint[], opts: StrokeOptions): StrokePiece[] {
  const points: StrokePoint[] = [];
  let end: StrokePoint | null = null;
  for (const p of stroke) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    end = p;
    const last = points[points.length - 1];
    if (last && Math.hypot(p.x - last.x, p.y - last.y) < opts.minDistance) continue;
    points.push(p);
  }
  // The stroke ends where the pen lifted, even when that is close to the last point kept.
  const last = points[points.length - 1];
  if (end && last && end !== last && (end.x !== last.x || end.y !== last.y)) points.push(end);
  const n = points.length;
  if (n === 0) return [];

  const widths: number[] = [];
  let velocity = 0;
  let width = (opts.minWidth + opts.maxWidth) / 2;
  let pressed = false;
  for (let i = 0; i < n; i++) {
    const p = points[i];
    if (p.pressure !== undefined && Number.isFinite(p.pressure)) {
      width = opts.minWidth + (opts.maxWidth - opts.minWidth) * Math.min(1, Math.max(0, p.pressure));
      pressed = true;
    } else if (pressed) {
      // A pen's point without a pressure (where it lifted: pointerup has none) keeps the width
      // it had, instead of the speed's, which would end the stroke in a blob.
    } else if (i > 0) {
      const q = points[i - 1];
      const dt = p.time - q.time;
      // Points with the same time (coalesced events) keep the speed they had.
      const v = dt > 0 ? Math.hypot(p.x - q.x, p.y - q.y) / dt : velocity;
      velocity = opts.velocityFilterWeight * v + (1 - opts.velocityFilterWeight) * velocity;
      width = Math.max(opts.maxWidth / (velocity + 1), opts.minWidth);
    }
    widths.push(width);
  }

  const at = (i: number): Point => [points[i].x, points[i].y];
  if (n === 1) return [{ from: at(0), control: at(0), to: at(0), w0: widths[0], w1: widths[0] }];
  const mid = (i: number): Point => [(points[i].x + points[i + 1].x) / 2, (points[i].y + points[i + 1].y) / 2];
  const midWidth = (i: number) => (widths[i] + widths[i + 1]) / 2;
  const straight = (a: Point, b: Point, w0: number, w1: number): StrokePiece =>
    ({ from: a, control: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], to: b, w0, w1 });
  const pieces = [straight(at(0), mid(0), widths[0], midWidth(0))];
  for (let i = 1; i < n - 1; i++) pieces.push({ from: mid(i - 1), control: at(i), to: mid(i), w0: midWidth(i - 1), w1: midWidth(i) });
  pieces.push(straight(mid(n - 2), at(n - 1), midWidth(n - 2), widths[n - 1]));
  return pieces;
}

/** What drawPieces needs of a 2D context (a canvas's, an OffscreenCanvas's, or a test's fake). */
export type InkContext = Pick<CanvasRenderingContext2D, "beginPath" | "moveTo" | "arc" | "fill"> & {
  fillStyle: CanvasRenderingContext2D["fillStyle"];
};

/**
 * Paint `pieces` in `color` (a CSS colour): each piece as round dots one device pixel apart
 * along the curve, their radius going from w0 to w1, filled as one path, so the line is smooth
 * and its width changes gradually. Pad px map to canvas px by `scale`, then `offset`.
 */
export function drawPieces(ctx: InkContext, pieces: readonly StrokePiece[], color: string, scale = 1, offset: Point = [0, 0]): void {
  ctx.beginPath();
  for (const { from, control, to, w0, w1 } of pieces) {
    const length = (Math.hypot(control[0] - from[0], control[1] - from[1]) + Math.hypot(to[0] - control[0], to[1] - control[1])) * scale;
    const steps = Math.max(1, Math.ceil(length));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps, u = 1 - t;
      const x = (u * u * from[0] + 2 * u * t * control[0] + t * t * to[0]) * scale + offset[0];
      const y = (u * u * from[1] + 2 * u * t * control[1] + t * t * to[1]) * scale + offset[1];
      const r = Math.max(0.25, (w0 + (w1 - w0) * t) * scale);
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, 2 * Math.PI);
    }
  }
  ctx.fillStyle = color;
  ctx.fill();
}

/** The box (pad px) that holds every piece, line widths included. */
export function piecesBounds(pieces: readonly StrokePiece[]): Rect {
  const box: Rect = [Infinity, Infinity, -Infinity, -Infinity];
  for (const { from, control, to, w0, w1 } of pieces) {
    // A quadratic curve stays inside the triangle of its three points.
    const r = Math.max(w0, w1);
    for (const [x, y] of [from, control, to]) {
      box[0] = Math.min(box[0], x - r);
      box[1] = Math.min(box[1], y - r);
      box[2] = Math.max(box[2], x + r);
      box[3] = Math.max(box[3], y + r);
    }
  }
  return box;
}

/** The box (pad px) that holds every stroke with its line width, or null when there is none. */
export function strokesBounds(strokes: readonly Stroke[]): Rect | null {
  const pieces = strokes.flatMap((s) => strokePieces(s));
  if (!pieces.length) return null;
  const box = piecesBounds(pieces);
  return box[2] > box[0] && box[3] > box[1] ? box : null;
}

/** The longer side of the strokes' box (pad px): 0 without ink. Under MIN_INK_EXTENT it is not a signature. */
export function inkExtent(strokes: readonly Stroke[]): number {
  const box = strokesBounds(strokes);
  return box ? Math.max(box[2] - box[0], box[3] - box[1]) : 0;
}

/**
 * The scale (CSS px per pad px) at which `strokes` show whole on a pad `width` × `height` CSS px,
 * from its top-left corner: 1, or less when they no longer fit (the pad shrank: a phone turned
 * upright after signing sideways). The strokes themselves stay as drawn.
 */
export function fitScale(strokes: readonly Stroke[], width: number, height: number): number {
  const box = strokesBounds(strokes);
  if (!box || !(width > 0) || !(height > 0)) return 1;
  return Math.min(1, box[2] > 0 ? width / box[2] : 1, box[3] > 0 ? height / box[3] : 1);
}

/**
 * The view scale of a pad `width` × `height` CSS px once its strokes changed (one ended, Undo,
 * Clear), from the one it had (`view`): back up as far as `strokes` now fit (the stroke that did
 * not fit may be gone), never down: a stroke that ran off the pad is no reason to show the rest
 * smaller, only a pad that shrank is (fitScale, on a resize). Unchanged while the pad has no size.
 */
export function refitView(strokes: readonly Stroke[], view: number, width: number, height: number): number {
  if (!(width > 0) || !(height > 0)) return view;
  return Math.max(view, fitScale(strokes, width, height));
}

/**
 * The strokes drawn on the pad as a PNG with transparency, in `color`, trimmed to them plus a 4 %
 * margin, painted again from their points (not copied from the pad's pixels) so that its longest
 * side is `maxSide` pixels, or less for a small drawing (at most 8 pixels per pad px). Throws
 * NoInkError without strokes.
 */
export async function renderStrokes(strokes: readonly Stroke[], color: InkColor, maxSide = SIGNATURE_MAX_SIDE): Promise<SignatureImage> {
  const pieces = strokes.flatMap((s) => strokePieces(s));
  if (pieces.length === 0) throw new NoInkError("Nothing drawn");
  const [x0, y0, x1, y1] = piecesBounds(pieces);
  const margin = MARGIN * Math.max(x1 - x0, y1 - y0);
  const w = x1 - x0 + 2 * margin, h = y1 - y0 + 2 * margin;
  const scale = Math.min(MAX_UPSCALE, Math.max(1, Math.floor(maxSide)) / Math.max(w, h));
  const side = (v: number) => Math.min(Math.max(1, Math.floor(maxSide)), Math.max(1, Math.ceil(v * scale)));
  const width = side(w), height = side(h);
  const s = surface(width, height);
  try {
    drawPieces(s.ctx, pieces, cssColor(INK_RGB[color]), scale, [(margin - x0) * scale, (margin - y0) * scale]);
    return { png: await encode(s), width, height };
  } finally {
    release(s);
  }
}

// ---------------------------------------------------------------------------------------------
// Typed signatures

/**
 * The particles of names (Italian, French, Spanish, Portuguese, Dutch, German, Scandinavian,
 * Arabic) that initials leave out when they are written in lower case.
 */
const PARTICLES = new Set([
  "d'", "da", "dal", "dall'", "dalla", "dalle", "dallo", "dai", "dagli", "de", "de'", "dei", "degli", "del", "dell'",
  "della", "delle", "dello", "di", "la", "le", "lo", "li", "l'", "du", "des", "do", "dos", "das", "e", "y", "i",
  "van", "von", "vom", "der", "den", "het", "'t", "ter", "ten", "zu", "zum", "zur", "af", "av", "al", "el", "bin", "ibn",
]);

/**
 * The initials of `name` (at most 4 letters), which the Sigla sheet starts with: "Mario Rossi"
 * → "MR", "Jean-Luc de la Tour" → "JLT" and "Ludwig van Beethoven" → "LB" (a particle in lower
 * case is left out; "De Luca" keeps its D), "maria Rossi" → "MR" (any other word counts, and
 * the first always does, whatever its case), "Anna Maria De Luca Rossi" → "AMDR" (past four
 * words, the first three and the last: the surname is never lost), "Gianni D'Angelo" → "GD". A
 * word's initial is its first capital, so "d'Alembert" gives "A" and "McEwan" "M".
 */
export function initialsOf(name: string): string {
  const words = name.split(/[\s\p{Pd}]+/u).filter((word) => /[\p{L}\p{N}]/u.test(word));
  const capital = (word: string) => /[\p{Lu}\p{Lt}]/u.test(word);
  const particle = (word: string) => !capital(word) && PARTICLES.has(word.replace(/[‘’`´]/g, "'").toLowerCase());
  const named = words.filter((word, i) => i === 0 || !particle(word));
  const kept = named.length > 4 ? [...named.slice(0, 3), named[named.length - 1]] : named;
  return kept.map((word) => (word.match(/[\p{Lu}\p{Lt}]/u) ?? word.match(/[\p{L}\p{N}]/u))![0].toLocaleUpperCase()).join("");
}

/**
 * `text` written in `family` (a CSS font-family value from availableHandwritingFonts) in
 * `color`, as a PNG with transparency trimmed to its ink: drawn at 120 px with room around it
 * (script fonts reach far outside their advance), trimmed to what has ink (alpha above 8), with
 * a 5 % margin, then scaled down if its longest side is over `maxSide`. Throws NoInkError for
 * an empty name.
 */
export async function renderTyped(text: string, family: string, color: InkColor, maxSide = SIGNATURE_MAX_SIDE): Promise<SignatureImage> {
  const name = text.trim();
  if (!name) throw new NoInkError("No name");
  const s = surface(1, 1);
  try {
    let px = TYPED_PX;
    s.ctx.font = `${px}px ${family}`;
    let advance = s.ctx.measureText(name).width;
    if (!(advance > 0)) advance = px * name.length;
    // A very long name is drawn smaller, so the canvas stays within what every browser allows.
    const wide = advance + 2 * TYPED_PAD * px;
    if (wide > MAX_CANVAS_SIDE) {
      px *= MAX_CANVAS_SIDE / wide;
      advance *= MAX_CANVAS_SIDE / wide;
    }
    const pad = Math.ceil(px * TYPED_PAD);
    const width = Math.min(MAX_CANVAS_SIDE, Math.ceil(advance + 2 * pad));
    const height = Math.ceil(px * 2.2);
    // Resizing the canvas resets its context: the font and the colour are set after it.
    s.canvas.width = width;
    s.canvas.height = height;
    s.ctx.font = `${px}px ${family}`;
    s.ctx.fillStyle = cssColor(INK_RGB[color]);
    s.ctx.textBaseline = "alphabetic";
    s.ctx.fillText(name, pad, Math.round(px * 1.4));
    const cut = trim(s.ctx.getImageData(0, 0, width, height).data, width, height, { margin: Math.round(px * TYPED_MARGIN) });
    if (!cut) throw new NoInkError("The font drew nothing");
    return await toPng(cut.rgba, cut.width, cut.height, maxSide);
  } finally {
    release(s);
  }
}

// ---------------------------------------------------------------------------------------------
// Signatures from a photo

/** Ink found in a photo (extractInk). */
export interface FoundInk {
  empty: false;
  /** The photo's size, in pixels. */
  width: number;
  height: number;
  /** How much ink each pixel of the photo holds, 0..255 (0 for paper, lines dropped, dust). */
  alpha: Uint8ClampedArray;
  /** The ink plus a 4 % margin, in photo pixels, [x0, y0, x1, y1) (end exclusive): where the crop's corners start. */
  box: Rect;
  /** The pen's colour, 0..255: the mean of its solid pixels, a little darker (photos lift blacks). */
  ink: [number, number, number];
  /**
   * The darkness threshold chosen for the ink (0..1); the lines of ruled or squared paper, where
   * found (and the paper's texture apart from the ink), get a higher one.
   */
  threshold: number;
}

export type InkResult = FoundInk | { empty: true; threshold: number };

/** An 8 × 8 cell of the paper map. */
const CELL = 8;

/**
 * Keep only the ink of a photo of a signature on paper (`rgba`, `width` × `height`, as
 * getImageData gives it):
 * 1. the luminance of each pixel;
 * 2. the paper's own brightness everywhere: a 90th percentile per 8 × 8 cell, the brightest over
 *    5 × 5 cells (strokes are thin, so that is paper), a 3 × 3 blur, scaled back up: shadows and
 *    uneven light are followed;
 * 3. darkness 1 − luminance / paper;
 * 4. a threshold by Otsu's method (at least 0.12), and a soft ramp around it, so edges stay
 *    smooth; when more than 6 % comes out dark, the dark part is split again, and the higher
 *    threshold is used on the lines of ruled or squared paper (paperLines: tilted, bowed or
 *    thick ones too), if there are any, and on the lighter pixels apart from the ink when they
 *    are spread over the photo all the same (awayFromInk); ink darker than it stays solid there;
 * 5. groups of solid pixels (touching by a side or a corner): the body is every group of at least
 *    1 % of the ink; smaller ones (an i's dot) stay only near the body, so dust elsewhere goes;
 * 6. empty when the solid ink is under 0.05 % of the photo or too faint (shadows and grain).
 * A dark printed line under the signature is kept (it is ink to this method): the crop removes it.
 */
export function extractInk(rgba: ArrayLike<number>, width: number, height: number, opts: { margin?: number } = {}): InkResult {
  const marginFrac = opts.margin ?? MARGIN;
  const w = Math.floor(width), h = Math.floor(height);
  const n = w * h;
  if (!(n > 0) || rgba.length < n * 4) return { empty: true, threshold: 0 };
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) lum[i] = 0.2126 * rgba[4 * i] + 0.7152 * rgba[4 * i + 1] + 0.0722 * rgba[4 * i + 2];
  const paper = paperLevel(lum, w, h);
  const dark = new Float32Array(n);
  for (let i = 0; i < n; i++) dark[i] = Math.max(0, Math.min(1, 1 - lum[i] / Math.max(1, paper[i])));

  // The threshold, from a sample (every 4th pixel), floored so that grain on an almost empty
  // sheet is not taken for ink.
  const sample = new Float32Array(Math.ceil(n / 4));
  for (let i = 0, k = 0; i < n; i += 4) sample[k++] = dark[i];
  const t = Math.max(0.12, otsu(sample));
  // A signature covers a few per cent of a photo taken from a distance. When more is dark, the
  // dark class may hold the lines of ruled or squared paper too, lighter than the ink: split it
  // again, and use the higher threshold only on those lines, where they are found. The dark
  // class may also be the ink alone (a close-up, a thick pen, a photo cropped in the gallery):
  // then nothing looks like a line, and every stroke keeps the first threshold, its lighter
  // parts (a ballpoint moved fast) too. Lighter pixels spread over the whole photo apart from the
  // ink, besides the lines found, are the paper's too: they get the higher threshold.
  let lineT = t;
  let onLine: Uint8Array | null = null;
  let darkCount = 0;
  for (const v of sample) if (v > t) darkCount++;
  if (darkCount > sample.length * 0.06) {
    const darkPart = new Float32Array(darkCount);
    for (let i = 0, k = 0; i < sample.length; i++) if (sample[i] > t) darkPart[k++] = sample[i];
    const t2 = otsu(darkPart);
    if (t2 > t) {
      const inkWidth = strokeWidth(dark, w, h, t2);
      const lines = paperLines(dark, w, h, t, t2, inkWidth);
      onLine = awayFromInk(dark, w, h, t, t2, lines, inkWidth) ?? lines;
      if (onLine) lineT = t2;
    }
  }
  // On the lines, only what is not darker than the higher threshold gets its ramp: the ink
  // crossing a line, darker, stays as solid as elsewhere.
  const ramp = (at: number) => [at * 0.55, Math.min(0.95, at * 1.35)];
  const [lo, hi] = ramp(t), [lineLo, lineHi] = ramp(lineT);
  const alpha = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = onLine?.[i] && dark[i] <= lineT ? (dark[i] - lineLo) / (lineHi - lineLo) : (dark[i] - lo) / (hi - lo);
    alpha[i] = v <= 0 ? 0 : v >= 1 ? 1 : v * v * (3 - 2 * v);
  }

  // Groups of solid pixels (alpha over 0.5), 8-connected: a thin stroke on the slant, whose rims
  // a paper line took, still holds together by its corners.
  const label = new Int32Array(n).fill(-1);
  const sizes: number[] = [];
  const stack = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    if (alpha[i] <= 0.5 || label[i] !== -1) continue;
    const id = sizes.length;
    let size = 0, top = 0;
    stack[top++] = i;
    label[i] = id;
    while (top > 0) {
      const p = stack[--top];
      size++;
      const px = p % w, py = (p - px) / w;
      for (let y = Math.max(0, py - 1); y <= Math.min(h - 1, py + 1); y++) {
        for (let x = Math.max(0, px - 1); x <= Math.min(w - 1, px + 1); x++) {
          const q = y * w + x;
          if (label[q] !== -1 || alpha[q] <= 0.5) continue;
          label[q] = id;
          stack[top++] = q;
        }
      }
    }
    sizes.push(size);
  }
  let inkTotal = 0;
  for (const s of sizes) inkTotal += s;
  // A dot on an i is about a hundred pixels at 1600 × 1000; grain and dust are a few.
  const keepMin = Math.max(8, inkTotal * 0.0005);
  const bodyMin = inkTotal * 0.01;
  const body = [w, h, -1, -1];
  for (let i = 0; i < n; i++) {
    if (label[i] < 0 || sizes[label[i]] < bodyMin) continue;
    const px = i % w, py = (i - px) / w;
    if (px < body[0]) body[0] = px;
    if (py < body[1]) body[1] = py;
    if (px > body[2]) body[2] = px;
    if (py > body[3]) body[3] = py;
  }
  const reach = Math.max(24, 0.15 * Math.min(body[2] - body[0], body[3] - body[1]));
  const kept = new Uint8Array(n);
  let solid = 0, darkSum = 0;
  for (let i = 0; i < n; i++) {
    if (label[i] < 0) continue;
    const size = sizes[label[i]];
    if (size < keepMin) continue;
    if (size < bodyMin) {
      const px = i % w, py = (i - px) / w;
      if (px < body[0] - reach || px > body[2] + reach || py < body[1] - reach || py > body[3] + reach) continue;
    }
    kept[i] = 1;
    solid++;
    darkSum += dark[i];
  }
  // An empty sheet (only shadows and grain) stays well below even a pencil.
  const inkDarkness = solid ? darkSum / solid : 0;
  if (solid < n * 0.0005 || inkDarkness < 0.22) return { empty: true, threshold: t };

  // The soft edge is kept only within 2 px of kept ink.
  const near = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!kept[i]) continue;
    const px = i % w, py = (i - px) / w;
    for (let y = Math.max(0, py - 2); y <= Math.min(h - 1, py + 2); y++)
      for (let x = Math.max(0, px - 2); x <= Math.min(w - 1, px + 2); x++) near[y * w + x] = 1;
  }
  const out = new Uint8ClampedArray(n);
  let r = 0, g = 0, b = 0, c = 0;
  for (let i = 0; i < n; i++) {
    if (!near[i]) continue;
    out[i] = Math.round(alpha[i] * 255);
    if (kept[i] && alpha[i] > 0.9) {
      r += rgba[4 * i];
      g += rgba[4 * i + 1];
      b += rgba[4 * i + 2];
      c++;
    }
  }
  const ink: [number, number, number] = c ? [r / c, g / c, b / c].map((v) => Math.round(v * 0.8)) as [number, number, number] : [0, 0, 0];
  const box = inkBox(out, w, h, [0, 0, w, h], marginFrac);
  if (!box) return { empty: true, threshold: t };
  return { empty: false, width: w, height: h, alpha: out, box, ink, threshold: t };
}

/**
 * The ink found in a photo, inside `crop` (photo pixels; the whole found box when left out),
 * trimmed again to the ink there plus a 4 % margin, in `color` (null: the pen's own), as straight
 * RGBA. Null when the crop holds no ink.
 */
export function paintInk(found: FoundInk, color: InkColor | null, crop?: Rect): { rgba: Uint8ClampedArray; width: number; height: number } | null {
  const { width: w, height: h, alpha } = found;
  const region: Rect = crop
    ? [
      Math.max(0, Math.floor(Math.min(crop[0], crop[2]))), Math.max(0, Math.floor(Math.min(crop[1], crop[3]))),
      Math.min(w, Math.ceil(Math.max(crop[0], crop[2]))), Math.min(h, Math.ceil(Math.max(crop[1], crop[3]))),
    ]
    : found.box;
  const box = inkBox(alpha, w, h, region, MARGIN);
  if (!box) return null;
  const [x0, y0, x1, y1] = box;
  const ow = x1 - x0, oh = y1 - y0;
  const [cr, cg, cb] = color ? INK_RGB[color] : found.ink;
  const rgba = new Uint8ClampedArray(ow * oh * 4);
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      const o = (y * ow + x) * 4;
      rgba[o] = cr;
      rgba[o + 1] = cg;
      rgba[o + 2] = cb;
      rgba[o + 3] = alpha[(y + y0) * w + x + x0];
    }
  }
  return { rgba, width: ow, height: oh };
}

/** paintInk as a finished PNG (longest side at most `maxSide`). Throws NoInkError when the crop holds no ink. */
export async function renderInk(found: FoundInk, color: InkColor | null, crop?: Rect, maxSide = SIGNATURE_MAX_SIDE): Promise<SignatureImage> {
  const painted = paintInk(found, color, crop);
  if (!painted) throw new NoInkError("No ink in the crop");
  return toPng(painted.rgba, painted.width, painted.height, maxSide);
}

/**
 * The pixels of a photo for extractInk: decoded by the browser (upright), on white (a PNG's
 * transparent parts are paper, not ink), scaled down to `maxSide` pixels on its longer side.
 * Throws PictureError ("unreadable") when the browser cannot decode it.
 */
export async function photoPixels(source: Blob | ArrayBuffer, maxSide = PHOTO_MAX_SIDE): Promise<{ rgba: Uint8ClampedArray; width: number; height: number }> {
  const blob = source instanceof Blob ? source : new Blob([source]);
  const picture = await decode(blob);
  try {
    if (!(picture.width > 0 && picture.height > 0)) throw new PictureError("The picture is empty", "unreadable");
    const { width, height } = fitWithin(picture.width, picture.height, maxSide);
    const s = surface(width, height);
    try {
      s.ctx.fillStyle = "#ffffff";
      s.ctx.fillRect(0, 0, width, height);
      s.ctx.imageSmoothingQuality = "high";
      s.ctx.drawImage(picture.source, 0, 0, width, height);
      return { rgba: s.ctx.getImageData(0, 0, width, height).data, width, height };
    } finally {
      release(s);
    }
  } catch (e) {
    if (e instanceof PictureError) throw e;
    throw new PictureError(e instanceof Error ? e.message : String(e), "unreadable");
  } finally {
    picture.release();
  }
}

// ---------------------------------------------------------------------------------------------
// Shared

/**
 * `rgba` (straight alpha, `width` × `height`) cut to the pixels whose alpha is over `threshold`
 * (default 8), plus `margin` transparent-or-not pixels around them (default 0; past the source's
 * edge they are transparent). `box` is the cut in source pixels, [x0, y0, x1, y1) (end
 * exclusive, it may reach outside the source). Pixels are copied unchanged. Null when nothing is
 * over the threshold.
 */
export function trim(
  rgba: ArrayLike<number>, width: number, height: number, opts: { margin?: number; threshold?: number } = {},
): { rgba: Uint8ClampedArray; width: number; height: number; box: Rect } | null {
  const threshold = opts.threshold ?? 8;
  const margin = Math.max(0, Math.round(opts.margin ?? 0));
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rgba[(y * width + x) * 4 + 3] <= threshold) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  const bx = x0 - margin, by = y0 - margin;
  const ow = x1 - x0 + 1 + 2 * margin, oh = y1 - y0 + 1 + 2 * margin;
  const out = new Uint8ClampedArray(ow * oh * 4);
  for (let y = 0; y < oh; y++) {
    const sy = y + by;
    if (sy < 0 || sy >= height) continue;
    for (let x = 0; x < ow; x++) {
      const sx = x + bx;
      if (sx < 0 || sx >= width) continue;
      const i = (sy * width + sx) * 4, o = (y * ow + x) * 4;
      out[o] = rgba[i];
      out[o + 1] = rgba[i + 1];
      out[o + 2] = rgba[i + 2];
      out[o + 3] = rgba[i + 3];
    }
  }
  return { rgba: out, width: ow, height: oh, box: [bx, by, bx + ow, by + oh] };
}

/** Straight RGBA as a PNG, scaled down (never up) to `maxSide` pixels on its longer side. */
export async function toPng(rgba: Uint8ClampedArray, width: number, height: number, maxSide = SIGNATURE_MAX_SIDE): Promise<SignatureImage> {
  const s = surface(width, height);
  try {
    const image = s.ctx.createImageData(width, height);
    image.data.set(rgba);
    s.ctx.putImageData(image, 0, 0);
    const fit = fitWithin(width, height, maxSide);
    if (fit.width === width && fit.height === height) return { png: await encode(s), width, height };
    const small = surface(fit.width, fit.height);
    try {
      small.ctx.imageSmoothingQuality = "high";
      small.ctx.drawImage(s.canvas, 0, 0, fit.width, fit.height);
      return { png: await encode(small), width: fit.width, height: fit.height };
    } finally {
      release(small);
    }
  } finally {
    release(s);
  }
}

/** `rgb` (0..255) as a CSS colour. */
function cssColor(rgb: readonly [number, number, number]): string {
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

/** The box of `alpha` over 0.1 (26 of 255) inside `region`, plus `marginFrac` of its longer side, kept inside `region`. */
function inkBox(alpha: Uint8ClampedArray, w: number, h: number, region: Rect, marginFrac: number): Rect | null {
  const [rx0, ry0, rx1, ry1] = [Math.max(0, region[0]), Math.max(0, region[1]), Math.min(w, region[2]), Math.min(h, region[3])];
  let x0 = rx1, y0 = ry1, x1 = -1, y1 = -1;
  for (let y = ry0; y < ry1; y++) {
    for (let x = rx0; x < rx1; x++) {
      if (alpha[y * w + x] <= 25) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  const m = Math.round(Math.max(x1 - x0, y1 - y0) * marginFrac);
  return [Math.max(rx0, x0 - m), Math.max(ry0, y0 - m), Math.min(rx1, x1 + m + 1), Math.min(ry1, y1 + m + 1)];
}

/** Paper brightness at each pixel (extractInk step 2). */
function paperLevel(lum: Float32Array, w: number, h: number): Float32Array {
  const gw = Math.ceil(w / CELL), gh = Math.ceil(h / CELL);
  const cell = new Float32Array(gw * gh);
  // A cell's paper level: a high percentile, not the maximum, which a hot pixel or glare would set.
  const values = new Float32Array(CELL * CELL);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      let k = 0;
      for (let y = gy * CELL; y < Math.min(h, gy * CELL + CELL); y++)
        for (let x = gx * CELL; x < Math.min(w, gx * CELL + CELL); x++) values[k++] = lum[y * w + x];
      const v = values.subarray(0, k).sort();
      cell[gy * gw + gx] = v[Math.floor(k * 0.9)];
    }
  }
  // The brightest over 5 × 5 cells: removes strokes up to about 2 cells (16 px) wide.
  const R = 2;
  const max = new Float32Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      let m = 0;
      for (let y = Math.max(0, gy - R); y <= Math.min(gh - 1, gy + R); y++)
        for (let x = Math.max(0, gx - R); x <= Math.min(gw - 1, gx + R); x++) m = Math.max(m, cell[y * gw + x]);
      max[gy * gw + gx] = m;
    }
  }
  // A 3 × 3 blur, so the paper map has no steps.
  const blur = new Float32Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      let s = 0, c = 0;
      for (let y = Math.max(0, gy - 1); y <= Math.min(gh - 1, gy + 1); y++)
        for (let x = Math.max(0, gx - 1); x <= Math.min(gw - 1, gx + 1); x++) { s += max[y * gw + x]; c++; }
      blur[gy * gw + gx] = s / c;
    }
  }
  // Bilinear back to full size, from the cells' centres.
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = Math.min(gh - 1, Math.max(0, (y + 0.5) / CELL - 0.5));
    const cy0 = Math.floor(fy), cy1 = Math.min(gh - 1, cy0 + 1), ty = fy - cy0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(gw - 1, Math.max(0, (x + 0.5) / CELL - 0.5));
      const cx0 = Math.floor(fx), cx1 = Math.min(gw - 1, cx0 + 1), tx = fx - cx0;
      const a = blur[cy0 * gw + cx0] * (1 - tx) + blur[cy0 * gw + cx1] * tx;
      const b = blur[cy1 * gw + cx0] * (1 - tx) + blur[cy1 * gw + cx1] * tx;
      out[y * w + x] = a * (1 - ty) + b * ty;
    }
  }
  return out;
}

/** paperLines looks for lines in a map of at most this many cells on its longer side. */
const LINE_CELLS = 400;
/** A line alone is looked for level or upright within this slope (7°: a photo taken a little askew). */
const LINE_TILT = Math.tan((7 * Math.PI) / 180);
/** A line runs across at least this much of the photo (its width, or its height for an upright line). */
const LINE_SPAN = 0.5;
/** A piece of a line cut short by a corner of the photo: at least this long, and this full along the part inside it. */
const LINE_PIECE = 0.1;
const LINE_PIECE_FULL = 0.8;
/** A printed line alone is at most this thick in a photo PHOTO_MAX_SIDE pixels long (and at least 4 px); a pen's stroke is thicker. */
const LINE_THIN = 6;
/** Around a line found, this many cells either side are its own (its blur, a slightly different slope). */
const LINE_BAND = 2;
/** The lines of ruled or squared paper: at least this many parallel lines, the first and the last this much of the photo apart. */
const FAMILY_MIN = 3;
const FAMILY_COVER = 0.5;
/** A family is looked for level or upright within this slope: in any direction (a photo askew, a sheet turned). */
const FAMILY_TILT = Math.tan((45 * Math.PI) / 180);
/** Its course is measured on pieces this long (a quarter of the photo), half overlapping: a sheet not flat bends it. */
const FAMILY_PIECES = 4;
/** In a piece, a line holds at least this much of the piece's length (the ink hides some of it). */
const FAMILY_PIECE_FULL = 0.5;
/** At least this many pieces show the family, and all but one keep within this slope of its course. */
const FAMILY_PIECES_MIN = 3;
const FAMILY_KEEP = Math.tan((2.5 * Math.PI) / 180);
/** Each line of a family may leave its common course by this slope (perspective). */
const FAMILY_SPREAD = Math.tan((3 * Math.PI) / 180);
/**
 * A family's lines may be thicker than a line alone: twice as thick, or this much of the pen's
 * own stroke width when that is more (a thick pen on paper with heavy rules).
 */
const FAMILY_THICK = 0.8;
/** awayFromInk marks the lighter pixels apart from the ink when they are this much of them, over AWAY_SPREAD of the photo. */
const AWAY_SHARE = 0.5;
const AWAY_SPREAD = 0.1;

/** Cells of the coarse map, in the frame of the lines looked for: `along` them (x for level lines) and `across` them. */
interface Cells {
  along: Int32Array;
  across: Int32Array;
}

/** A line found: where it runs across, `a` cells along; `long` when it spans LINE_SPAN (not a piece a corner cuts short). */
interface Line {
  path(a: number): number;
  long: boolean;
}

/**
 * Where the lines of ruled or squared paper are, among the pixels darker than `t` but not than
 * `t2` (the ones the second threshold would drop). Ink makes no such lines: strokes curve, they
 * are thicker, and only their rims and lighter stretches are that light. Lines are found in two
 * ways, each running across at least half the photo:
 * - a line alone (a printed rule): straight, level or upright within 7°, at most 6 px thick in a
 *   photo 1600 px long;
 * - a family of at least 3 parallel lines (ruled or squared paper) spread over at least half the
 *   photo across them: in any direction (level or upright within 45°), a little bent where the
 *   sheet is not flat, and thicker (twice that, or 0.8 of the pen's stroke width `inkWidth`, px).
 *   One line on its own may be ink (an underline), and so may parallel strokes inside the
 *   signature (a slanted hand); parallel lines across the sheet are the paper.
 * Thickness is the run of pixels darker than `t` across the line through each pixel (down its
 * column for a level line), so the rim of a stroke, whose run goes on into the stroke, is left
 * out, and so is a pixel whose run along the line is shorter (it is on a line of the other
 * direction). The search runs on a coarse map (cells of f × f pixels, at most 400 on the longer
 * side; a cell counts when any of its pixels does), projected along every slope one cell apart
 * over the map's length: a line puts its cells into one or two neighbouring bins of the
 * projection at its own slope (straightLines). A family is projected along its common course,
 * which bends with the sheet (familyCourse). Every pixel within 2 cells of a line found (more for
 * a family of thick lines) is marked; null when there is none.
 */
function paperLines(dark: Float32Array, w: number, h: number, t: number, t2: number, inkWidth: number): Uint8Array | null {
  const thin = Math.max(4, Math.round((LINE_THIN * Math.max(w, h)) / PHOTO_MAX_SIDE));
  const thick = Math.max(2 * thin, Math.round(FAMILY_THICK * inkWidth));
  const f = Math.max(1, Math.ceil(Math.max(w, h) / LINE_CELLS));
  const gw = Math.ceil(w / f), gh = Math.ceil(h / f);
  // Two lines of a family are at least this far apart (cells): the rims of one stroke are closer.
  const gap = Math.max(3, Math.ceil(thick / f) + 1);
  const rowRun = runs(dark, w, h, t, true), colRun = runs(dark, w, h, t, false);
  const lines = new Uint8Array(gw * gh);
  let found = false;
  // Level lines (they run along x, across the map's width), then upright ones (along y).
  for (const level of [true, false]) {
    const length = level ? gw : gh, depth = level ? gh : gw;
    const mark = (line: Line, band: number) => {
      found = true;
      for (let a = 0; a < length; a++) {
        const mid = line.path(a);
        for (let c = Math.max(0, Math.ceil(mid - band)); c <= Math.min(depth - 1, Math.floor(mid + band)); c++) {
          lines[level ? c * gw + a : a * gw + c] = 1;
        }
      }
    };
    const map = lineCells(dark, w, h, t, t2, f, level, thin, thick, rowRun, colRun);
    for (const line of straightLines(map.lone, length, depth, null, Math.ceil(LINE_TILT * length))) mark(line, LINE_BAND);
    const course = familyCourse(map.family, length, depth, gap);
    if (!course) continue;
    const parallel = straightLines(map.family, length, depth, course, Math.ceil(FAMILY_SPREAD * length));
    const long = parallel.filter((l) => l.long);
    // The paper's lines run across the whole sheet; the parallel strokes of a slanted hand stay
    // inside the signature.
    const apart = distinct(long.map((l) => l.path(length / 2)), gap);
    if (apart.length < FAMILY_MIN || apart[apart.length - 1] - apart[0] < FAMILY_COVER * depth) continue;
    // Thin lines (most of their cells also hold runs no longer than `thin`) get the band of a
    // line alone: a wider one would take the light parts of a thin pen's strokes along them.
    let cells = 0, thinCells = 0;
    for (const line of long) {
      for (let a = 0; a < length; a++) {
        const c = Math.round(line.path(a));
        if (c < 0 || c >= depth) continue;
        const i = level ? c * gw + a : a * gw + c;
        if (map.isFamily[i]) cells++;
        if (map.isLone[i]) thinCells++;
      }
    }
    const band = thinCells >= cells / 2 ? LINE_BAND : Math.max(LINE_BAND, Math.ceil(thick / (2 * f)) + 1);
    for (const line of parallel) mark(line, band);
  }
  if (!found) return null;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = ((y / f) | 0) * gw;
    for (let x = 0; x < w; x++) out[y * w + x] = lines[row + ((x / f) | 0)];
  }
  return out;
}

/**
 * The coarse maps of the thin light pixels for level lines (or upright ones): pixels darker than
 * `t` but not than `t2` whose run of pixels darker than `t` across the lines' direction (down the
 * column for level lines: `colRun`) is at most `thin` long (`lone`) or `thick` long (`family`),
 * and no longer than their run along it (`rowRun`): a pixel of a line upright is not one of a
 * level line, even where it leans enough to be thin down a column. As the cells that hold them,
 * and as maps of the coarse grid (`isLone`, `isFamily`).
 */
function lineCells(
  dark: Float32Array, w: number, h: number, t: number, t2: number, f: number, level: boolean, thin: number, thick: number,
  rowRun: Uint8Array, colRun: Uint8Array,
): { lone: Cells; family: Cells; isLone: Uint8Array; isFamily: Uint8Array } {
  const gw = Math.ceil(w / f), gh = Math.ceil(h / f);
  const lone = new Uint8Array(gw * gh), family = new Uint8Array(gw * gh);
  for (let y = 0; y < h; y++) {
    const row = ((y / f) | 0) * gw;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!(dark[i] > t) || dark[i] > t2) continue;
      const across = level ? colRun[i] : rowRun[i], along = level ? rowRun[i] : colRun[i];
      if (across > thick || across > along) continue;
      const cell = row + ((x / f) | 0);
      family[cell] = 1;
      if (across <= thin) lone[cell] = 1;
    }
  }
  const cells = (map: Uint8Array): Cells => {
    let n = 0;
    for (const v of map) n += v;
    const along = new Int32Array(n), across = new Int32Array(n);
    for (let i = 0, k = 0; i < map.length; i++) {
      if (!map[i]) continue;
      const cx = i % gw, cy = (i - cx) / gw;
      along[k] = level ? cx : cy;
      across[k++] = level ? cy : cx;
    }
    return { along, across };
  };
  return { lone: cells(lone), family: cells(family), isLone: lone, isFamily: family };
}

/** For each pixel darker than `t`, the run of such pixels through it along its row (or its column), at most 255. */
function runs(dark: Float32Array, w: number, h: number, t: number, alongRows: boolean): Uint8Array {
  const out = new Uint8Array(w * h);
  const lines = alongRows ? h : w, size = alongRows ? w : h;
  const at = alongRows ? (r: number, k: number) => r * w + k : (r: number, k: number) => k * w + r;
  for (let r = 0; r < lines; r++) {
    for (let k = 0; k < size;) {
      if (!(dark[at(r, k)] > t)) {
        k++;
        continue;
      }
      let e = k + 1;
      while (e < size && dark[at(r, e)] > t) e++;
      const run = Math.min(255, e - k);
      for (let j = k; j < e; j++) out[at(r, j)] = run;
      k = e;
    }
  }
  return out;
}

/**
 * The lines among `cells` that run straight along `course` (cells across, for each cell along;
 * straight when null), give or take `steps` cells over the map's length: at least half the map
 * long, or pieces that a corner of the photo cuts short (at least 10 % of the length, nearly full
 * along the part of them inside the photo) at the slopes of the long ones. A line is a peak of the
 * projection: at least as many cells in two neighbouring bins as its neighbours at the next
 * slopes and bins (each line its own slope: perspective tilts them a little differently; a piece,
 * which the slope moves a lot at the far end, only as its neighbours across); one that runs
 * within a cell of a stronger one is the same line.
 */
function straightLines(cells: Cells, length: number, depth: number, course: Float64Array | null, steps: number): Line[] {
  const { along, across } = cells;
  if (along.length < LINE_SPAN * length) return [];
  let lo = 0, hi = 0;
  if (course) {
    for (const v of course) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  }
  const off = steps + Math.ceil(hi) + 2;
  const nb = off + depth + steps + Math.ceil(-lo) + 2;
  const slopes = 2 * steps + 1;
  const shift = (a: number) => (course ? course[a] : 0);
  // pairs[slope, b]: the cells in bins b and b + 1 of the projection at that slope.
  const pairs = new Int32Array(slopes * nb);
  const bins = new Int32Array(nb);
  for (let s = 0; s < slopes; s++) {
    const slope = (s - steps) / length;
    bins.fill(0);
    for (let k = 0; k < along.length; k++) bins[Math.round(across[k] - shift(along[k]) - along[k] * slope) + off]++;
    for (let b = 0; b + 1 < nb; b++) pairs[s * nb + b] = bins[b] + bins[b + 1];
  }
  const peak = (s: number, b: number) => {
    const v = pairs[s * nb + b];
    for (let ds = -1; ds <= 1; ds++) {
      for (let db = -1; db <= 1; db++) {
        const s2 = s + ds, b2 = b + db;
        if (s2 >= 0 && s2 < slopes && b2 >= 0 && b2 + 1 < nb && pairs[s2 * nb + b2] > v) return false;
      }
    }
    return true;
  };
  /** The line of pair b at slope s, between bins b and b + 1. */
  const line = (s: number, b: number, long: boolean): Line =>
    ({ path: (a) => b + 0.5 - off + shift(Math.min(length - 1, Math.max(0, Math.round(a)))) + (a * (s - steps)) / length, long });
  const found: { line: Line; cells: number }[] = [];
  const slopesFound = new Uint8Array(slopes);
  for (let s = 0; s < slopes; s++) {
    for (let b = 0; b + 1 < nb; b++) {
      const v = pairs[s * nb + b];
      if (v < LINE_SPAN * length || !peak(s, b)) continue;
      found.push({ line: line(s, b, true), cells: v });
      slopesFound[s] = 1;
    }
  }
  for (let s = 0; s < slopes; s++) {
    if (!slopesFound[s] && !slopesFound[s - 1] && !slopesFound[s + 1]) continue;
    for (let b = 0; b + 1 < nb; b++) {
      const v = pairs[s * nb + b];
      if (v >= LINE_SPAN * length || v < LINE_PIECE * length) continue;
      // A short piece at the far end of the map moves a lot with the slope: a peak across only.
      if ((b > 0 && pairs[s * nb + b - 1] > v) || (b + 2 < nb && pairs[s * nb + b + 1] > v)) continue;
      const piece = line(s, b, false);
      let inside = 0;
      for (let a = 0; a < length; a++) {
        const mid = piece.path(a);
        if (mid >= 0 && mid <= depth - 1) inside++;
      }
      if (v >= LINE_PIECE_FULL * inside) found.push({ line: piece, cells: v });
    }
  }
  // A line between two bins, or at two neighbouring slopes, can peak twice: kept once (the
  // stronger), so its band is not widened.
  found.sort((p, q) => q.cells - p.cells);
  const ends = [0, length / 2, length - 1];
  const out: Line[] = [];
  for (const { line: l } of found) {
    if (out.some((o) => ends.every((a) => Math.abs(o.path(a) - l.path(a)) <= 1))) continue;
    out.push(l);
  }
  return out;
}

/**
 * The common course of a family of parallel lines among `cells`, as the cells across it runs at
 * each cell along (0 at the start), or null when there is no family. Measured on quarters of the
 * map, half overlapping: in each, the slope (within 45°) at which its projection is sharpest (the
 * sum of the squared bins, between the steps where it peaks), when the projection there shows at
 * least 3 lines `gap` cells apart, each over half the quarter. A slope unlike both its
 * neighbours' is replaced by the middle one (the ink can mislead a quarter where it hides the
 * lines), then the slope is taken to change evenly along the map (the best straight fit through
 * the quarters' slopes): a tilt, and a sheet bowed once. The course is its sum. At least three
 * quarters must show the family, all but one within 2.5° of that fit (a texture's quarters
 * agree on no course).
 */
function familyCourse(cells: Cells, length: number, depth: number, gap: number): Float64Array | null {
  const { along, across } = cells;
  const n = along.length;
  if (n < LINE_SPAN * length) return null;
  // The cells in order along, so that a quarter is one run of them.
  const start = new Int32Array(length + 1);
  for (let k = 0; k < n; k++) start[along[k] + 1]++;
  for (let a = 0; a < length; a++) start[a + 1] += start[a];
  const order = new Int32Array(n);
  const next = start.slice(0, length);
  for (let k = 0; k < n; k++) order[next[along[k]]++] = k;

  const piece = Math.min(length, Math.max(8, Math.ceil(length / FAMILY_PIECES)));
  const step = Math.max(1, Math.ceil(piece / 2));
  const starts: number[] = [];
  for (let a0 = 0; a0 + piece < length; a0 += step) starts.push(a0);
  starts.push(length - piece);
  const middles: number[] = [], found: number[] = [];
  for (const a0 of starts) {
    const a1 = a0 + piece;
    const steps = Math.ceil(FAMILY_TILT * piece);
    const off = steps + 1, nb = depth + 2 * off + 1;
    const bins = new Int32Array(nb);
    const project = (s: number) => {
      bins.fill(0);
      for (let q = start[a0]; q < start[a1]; q++) {
        const k = order[q];
        bins[Math.round(across[k] - ((along[k] - a0) * s) / piece) + off]++;
      }
    };
    const sharp = new Float64Array(2 * steps + 1);
    let best = 0;
    for (let s = -steps; s <= steps; s++) {
      project(s);
      let e = 0;
      for (const v of bins) e += v * v;
      sharp[s + steps] = e;
      if (e > sharp[best]) best = s + steps;
    }
    project(best - steps);
    const at: number[] = [];
    for (let b = 0; b + 1 < nb; b++) {
      const v = bins[b] + bins[b + 1];
      if (v < FAMILY_PIECE_FULL * piece) continue;
      if ((b > 0 && bins[b - 1] + bins[b] > v) || (b + 2 < nb && bins[b + 1] + bins[b + 2] > v)) continue;
      at.push(b);
    }
    if (distinct(at, gap).length < FAMILY_MIN) continue;
    // Between the steps: the top of the parabola through the sharpest one and its neighbours.
    let s = best - steps;
    if (best > 0 && best < 2 * steps) {
      const l = sharp[best - 1], c = sharp[best], r = sharp[best + 1];
      const curve = l - 2 * c + r;
      if (curve < 0) s += Math.max(-0.5, Math.min(0.5, (l - r) / (2 * curve)));
    }
    middles.push(a0 + piece / 2);
    found.push(s / piece);
  }
  if (found.length < FAMILY_PIECES_MIN) return null;
  const slopes = found.map((v, i) => (i > 0 && i + 1 < found.length ? middle(found[i - 1], v, found[i + 1]) : v));
  // The straight fit, slope = mean + rate × (a − the middles' mean).
  const m = middles.length;
  const ma = middles.reduce((x, y) => x + y, 0) / m, ms = slopes.reduce((x, y) => x + y, 0) / m;
  let sxx = 0, sxy = 0;
  for (let i = 0; i < m; i++) {
    sxx += (middles[i] - ma) ** 2;
    sxy += (middles[i] - ma) * (slopes[i] - ms);
  }
  const rate = sxx > 0 ? sxy / sxx : 0;
  // A sheet's lines keep to it (but in one quarter, where the ink may have misled it); quarters of
  // a texture each go their own way.
  let off = 0;
  for (let i = 0; i < m; i++) if (Math.abs(found[i] - ms - rate * (middles[i] - ma)) > FAMILY_KEEP) off++;
  if (off > 1) return null;
  const course = new Float64Array(length);
  for (let a = 1; a < length; a++) course[a] = course[a - 1] + ms + rate * (a - 0.5 - ma);
  return course;
}

/** Those of `positions` (cells) at least `gap` apart, in order: the lines they are, not counting two rims of one stroke twice. */
function distinct(positions: readonly number[], gap: number): number[] {
  const kept: number[] = [];
  for (const p of [...positions].sort((a, b) => a - b)) if (!kept.length || p - kept[kept.length - 1] >= gap) kept.push(p);
  return kept;
}

/** The middle one of three numbers. */
function middle(a: number, b: number, c: number): number {
  return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
}

/**
 * The pen's stroke width, px: the median, over the pixels darker than `t2` (the ink's core), of
 * the shorter of the row and the column runs of such pixels through each. 0 without any.
 */
function strokeWidth(dark: Float32Array, w: number, h: number, t2: number): number {
  const MAX = 255;
  const row = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w;) {
      if (!(dark[y * w + x] > t2)) {
        x++;
        continue;
      }
      let e = x + 1;
      while (e < w && dark[y * w + e] > t2) e++;
      const run = Math.min(MAX, e - x);
      for (let i = x; i < e; i++) row[y * w + i] = run;
      x = e;
    }
  }
  const hist = new Float64Array(MAX + 1);
  let count = 0;
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h;) {
      if (!row[y * w + x]) {
        y++;
        continue;
      }
      let e = y + 1;
      while (e < h && row[e * w + x]) e++;
      const run = Math.min(MAX, e - y);
      for (let i = y; i < e; i++) hist[Math.min(run, row[i * w + x])]++;
      count += e - y;
      y = e;
    }
  }
  if (!count) return 0;
  for (let v = 0, seen = 0; v <= MAX; v++) {
    seen += hist[v];
    if (seen >= count / 2) return v;
  }
  return MAX;
}

/**
 * `lines` (the paper lines found, or null) and the paper's own lighter pixels, when they are
 * spread over the photo besides those lines: the pixels darker than `t` but not than `t2`, not on
 * `lines`, that no short path of pixels darker than `t` (twice the pen's stroke width `inkWidth`,
 * at least 6 px, by sides or corners) joins to the ink's core (the pixels darker than `t2`), when
 * they are at least half of those lighter pixels and lie in at least 10 % of the photo's 8 × 8
 * cells (of those not wholly on `lines`). The ink's rims are next to its core, and the stretches
 * where the pen ran lighter and the strokes lighter as a whole (an underline) stay within a few
 * per cent of the photo; lines bent or tilted more than paperLines follows, a texture, the table
 * around the sheet are all over it. Null otherwise.
 */
function awayFromInk(
  dark: Float32Array, w: number, h: number, t: number, t2: number, lines: Uint8Array | null, inkWidth: number,
): Uint8Array | null {
  const n = w * h;
  // Joined to the core: reached from it through pixels darker than `t`, in at most `reach` steps
  // (a breadth-first search, one ring of steps at a time).
  const reach = Math.max(6, Math.round(2 * inkWidth));
  const joined = new Uint8Array(n);
  let ring = new Int32Array(n), next = new Int32Array(n);
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (!(dark[i] > t2)) continue;
    joined[i] = 1;
    ring[count++] = i;
  }
  for (let step = 0; step < reach && count > 0; step++) {
    let found = 0;
    for (let k = 0; k < count; k++) {
      const p = ring[k];
      const px = p % w, py = (p - px) / w;
      for (let y = Math.max(0, py - 1); y <= Math.min(h - 1, py + 1); y++) {
        for (let x = Math.max(0, px - 1); x <= Math.min(w - 1, px + 1); x++) {
          const q = y * w + x;
          if (joined[q] || !(dark[q] > t)) continue;
          joined[q] = 1;
          next[found++] = q;
        }
      }
    }
    [ring, next] = [next, ring];
    count = found;
  }
  // The cells they touch, among those not wholly on the lines found.
  const gw = Math.ceil(w / CELL), gh = Math.ceil(h / CELL);
  const touched = new Uint8Array(gw * gh), free = new Uint8Array(gw * gh);
  const loose = new Uint8Array(n);
  let lighter = 0, apart = 0;
  for (let i = 0; i < n; i++) {
    if (lines?.[i]) continue;
    const x = i % w, y = (i - x) / w;
    const cell = ((y / CELL) | 0) * gw + ((x / CELL) | 0);
    free[cell] = 1;
    if (!(dark[i] > t) || dark[i] > t2) continue;
    lighter++;
    if (joined[i]) continue;
    loose[i] = 1;
    apart++;
    touched[cell] = 1;
  }
  let spread = 0, room = 0;
  for (let c = 0; c < touched.length; c++) {
    spread += touched[c];
    room += free[c];
  }
  if (!lighter || apart < AWAY_SHARE * lighter || spread < AWAY_SPREAD * room) return null;
  if (lines) for (let i = 0; i < n; i++) loose[i] |= lines[i];
  return loose;
}

/** Otsu's threshold of values in 0..1 (256 bins). */
function otsu(values: Float32Array): number {
  const hist = new Float64Array(256);
  for (const v of values) hist[Math.min(255, Math.max(0, Math.round(v * 255)))]++;
  const total = values.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, at = 0;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) {
      best = between;
      at = t;
    }
  }
  return at / 255;
}

// --- the canvas layer (as ui/imageFile.ts)

type Surface =
  | { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D }
  | { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D };

/** An OffscreenCanvas, or a <canvas> where there is none (or it has no 2D context). */
function surface(width: number, height: number): Surface {
  if (typeof OffscreenCanvas === "function") {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (ctx) return { canvas, ctx };
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("No 2D canvas");
  return { canvas, ctx };
}

/** A <canvas> gives its memory back at once with a zero size (iOS keeps it otherwise). */
function release(s: Surface) {
  if (!("convertToBlob" in s.canvas)) s.canvas.width = s.canvas.height = 0;
}

async function encode(s: Surface): Promise<Blob> {
  const canvas = s.canvas;
  const blob = "convertToBlob" in canvas
    ? await canvas.convertToBlob({ type: "image/png" })
    : await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob || blob.size === 0) throw new Error("The signature could not be encoded");
  return blob;
}

interface Decoded {
  source: CanvasImageSource;
  width: number;
  height: number;
  release(): void;
}

/** Decode with createImageBitmap (upright), or through an <img> where that refuses the file. */
async function decode(blob: Blob): Promise<Decoded> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
    } catch {
      // Not decoded here: an <img> may still manage it.
    }
  }
  if (typeof Image !== "function") throw new PictureError("The picture could not be decoded", "unreadable");
  const url = URL.createObjectURL(blob);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ source: img, width: img.naturalWidth, height: img.naturalHeight, release: () => URL.revokeObjectURL(url) });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new PictureError("The picture could not be decoded", "unreadable"));
    };
    img.src = url;
  });
}
