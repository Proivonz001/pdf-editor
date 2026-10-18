// Finding the sheet in a photo (release 4, "Foto e scansione"), in plain JavaScript: no OpenCV
// (12.7 MB) and no second MuPDF, so it runs in the small scan worker and in Node's tests.
//
// Ported from the research prototype (detect2.mjs), which found the corners of 11 of 14
// synthetic photos to within a pixel and gave the wrong ones a low confidence:
// 1. A grey copy of about 360 px: blurred, Sobel gradients, the strongest 10 % kept.
// 2. A Hough transform where each edge pixel votes only for lines near its own gradient's
//    direction; up to 24 peaks.
// 3. Every quadrilateral of two nearly parallel pairs of peaks about 90° apart (perspective
//    allows about 20°), large enough and convex, scored by how much of each side has a
//    bright-inside / dark-outside edge (the support, cubed, so a side mostly unsupported
//    counts little).
// 4. Each side fitted again on a grey copy of about 1,200 px (total least squares, one pass of
//    outlier rejection); a corner moves only a little.
// 5. Each side read across on that copy before blurring (sheetSides, readSide) and moved onto
//    the outermost edge along it with paper inside and something darker just outside, up to
//    2–3 cm beyond it on A4: a band or frame printed near the paper's edge has such an edge too,
//    nearer in and with far more contrast, and took the side. Beyond the side such an edge needs
//    the paper's own margin inside it, as bright as the paper just inside the side, and the dark
//    band the side lay on between them (a white table is about 0.9 of the paper's brightness, and
//    the edge of a pen lying on it is not the sheet's: fix round 2 took it so); a move whose new
//    margin has a table's grain is not made. A side that ran off the paper at one end turns in
//    there; none moves wholly inwards (onto a shadow's or a curl's edge).
// 6. The confidence is the weakest side's support: (support − 0.3) / 0.4, clamped to 0..1, a
//    side's support being the share of it with an edge less the share held by a line beyond it
//    (another sheet, or a band's inner edge the side could not get past), and at most 0.45 for a
//    side either reading fits: a move not made for its grain, or a side moved outwards with
//    something darker beyond it than beyond the other sides (a pen or a laptop on the table).
//
// What the prototype lacked and this adds: a threshold (FOUND_CONFIDENCE) under which the caller
// uses the whole frame; the corners kept inside the frame; the top-left corner chosen by the
// direction of the sheet's top and bottom sides (the smallest x + y was ambiguous for a sheet
// near 45°); refined corners checked again (convex, large enough); typed arrays throughout,
// the downscale to grey done in one pass over the photo, a histogram instead of sorting the
// gradients, the peaks found without sorting the accumulator, and quadrilaterals that cannot
// beat the best one (a side scores at most its length) dropped before their sides are read.
// The input must be upright: the worker decodes photos with their EXIF orientation applied.
//
// Accuracy and time in Node (scan.test.ts prints them): on 14 synthetic 1200 px photos the
// corners are within 0.6 px, in about 40–60 ms each once warm (the first of a run takes longer);
// on a 3500 px working photo within 1.3 px, in 75–150 ms, most of it the pass that reads the
// photo. Step 5 adds about 10 %. A checked tablecloth, paper on an almost-white table and a
// striped background give no confidence: the whole frame is used.
//
// Bands and frames printed near the paper's edge (letterheads, certificates, forms), in the
// sweep of the fix rounds' checks (five poses; a desk, a white table and wood; black, grey and
// light bands 9 mm tall and frames 3.6 mm thick, 2–9 mm in; 375 photos, run with three noise
// seeds): none is taken with confidence for the sheet's edge (125 of the 1,125 were, at 0.54 to
// 1.00, before fix round 2); 1,108 are found to within 3 px and 17 are not trusted, so the user
// places the corners: frames 5–9 mm in, 14 of them on a white table, where the quadrilateral
// found first has a side on the text block 4–5 cm in, farther than a side is moved. 12 mm in
// (270 photos): none wrong (59 before), 11 not trusted, the same kind of case. Fix round 3 gives
// each of these photos the same answer as fix round 2.
// Dark things on a white table beyond a side, in the sweep of fix round 2's check (a pen 6 px
// wide, a 25 px ruler along 85 % of the side, all dark beyond a line as a laptop's edge, a soft
// shadow 25 % darker; 15–27 mm beyond the top or the bottom, upright and turned 12°, three seeds:
// 192 photos): fix round 2 took the object's edge for the side, with confidence, in 60 of the 106
// that fix round 1 found (and 37 more were not trusted), because the table passed for paper. Now
// the 106 are found again, with confidence; of the other 86, 11 are not trusted and 75 still
// wrong, as in fix round 1. In a wider run (1,344 more: 3–13 mm beyond as well, all four sides,
// on a desk too) 837 are right (773 in fix round 1), 51 not trusted and 456 wrong, each of them
// wrong in fix round 1 too but one (a ruler 3 mm beyond the top on a desk, not trusted there only
// because a side moved by chance): of fix round 1's 567 wrong, 61 are now right, 51 not trusted.
// Synthetic cases that still give a wrong side with confidence (all of them wrong in fix rounds 1
// and 2 as well):
// - beyond the sheet, paper again after something darker, which is just how a band printed near
//   the edge looks (a sheet lying on a larger white sheet, or another sheet past a narrow shadowed
//   gap, along the whole side: both are taken; a line printed 9 mm in would look the same);
// - a dark object near a side and along it: on a white table its edge has far more contrast than
//   the paper's, so the quadrilateral found first has its side there (a pen, a ruler, a laptop or
//   a shadow's edge, up to 3 cm away), and on a desk up to about 6 mm away (a keyboard, a pen); a
//   side never moves wholly inwards, so it stays there;
// - a shadow or a curl darkening the paper's outer 5–10 mm (on some backgrounds), whose inner
//   edge is taken for the side.
// Phones run plain JavaScript about 2–4 times slower. Nothing has been tried on real photos
// yet: glare, curled paper and busy desks will do worse.
import { clampCorners, fitSide, isConvexClockwise, signedArea } from "./sizes";
import type { Corners, Pixels, Point } from "./types";

/**
 * Below this confidence the corners are not trusted: the caller starts from the whole frame.
 * 0.5 means every side has an edge along at least half of it, less what a line beyond it holds.
 * The synthetic photos give 0.90 to 1.00 when right (0.66 with another sheet beyond part of a
 * side), 0 for the bands and frames the detector cannot get past and 0.375 where two readings fit
 * (DOUBT); the header says which wrong answers still come with confidence.
 */
export const FOUND_CONFIDENCE = 0.5;

/** Long side of the copy the lines are found on, and of the one the sides are refined on. */
const DETECT_SIDE = 360;
const REFINE_SIDE = 1200;
/** Hough angle steps over 180° (1° each), the strongest lines kept, and how far a vote spreads around the gradient's direction. */
const ANGLES = 180;
const MAX_PEAKS = 24;
const VOTE_SPREAD = 6;
/** Two lines of one pair differ by at most this (radians, about 20°); the two pairs by at least 0.9 rad (about 52°). */
const PARALLEL = 0.35;
const PERPENDICULAR = 0.9;
/** A sheet covers at least this share of the frame. */
const MIN_AREA = 0.12;

/** The sheet found in a photo. */
export interface Detection {
  /** TL, TR, BR, BL in the photo's pixels (inside the frame), or null when no sheet-like shape was found. */
  corners: Corners | null;
  /** 0..1: how sure the detector is of the weakest side. */
  confidence: number;
  /** How sure it is of each side (top, right, bottom, left), 0..1: the share of it with an edge, less the share a line beyond it holds. */
  sides: number[];
}

/** One channel of brightness, `scaleX` × `scaleY` source pixels per pixel. */
interface Grey {
  width: number;
  height: number;
  data: Float32Array;
  scaleX: number;
  scaleY: number;
}

/**
 * A grey copy of `photo` whose longer side is at most `maxSide`: each pixel the mean brightness
 * of the source pixels that fall in it (a box filter), in one pass over the photo.
 */
function greyOf(photo: Pixels, maxSide: number): Grey {
  const { width: W, height: H, data } = photo;
  const { width: w, height: h } = fitSide(W, H, maxSide);
  const sx = W / w, sy = H / h;
  const out = new Float32Array(w * h);
  const column = new Int32Array(W);
  const perColumn = new Float32Array(w), perRow = new Float32Array(h);
  for (let x = 0; x < W; x++) perColumn[(column[x] = Math.min(w - 1, Math.floor(x / sx)))]++;
  for (let y = 0; y < H; y++) {
    const r = Math.min(h - 1, Math.floor(y / sy));
    perRow[r]++;
    const o = r * w;
    for (let x = 0, i = y * W * 4; x < W; x++, i += 4) out[o + column[x]] += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) out[r * w + c] /= perRow[r] * perColumn[c];
  return { width: w, height: h, data: out, scaleX: sx, scaleY: sy };
}

/** The same box filter on a grey copy (its scale relative to `g`). */
function shrink(g: Grey, maxSide: number): Grey {
  const { width: W, height: H, data } = g;
  const { width: w, height: h } = fitSide(W, H, maxSide);
  if (w === W && h === H) return { width: W, height: H, data: data.slice(), scaleX: 1, scaleY: 1 };
  const sx = W / w, sy = H / h;
  const out = new Float32Array(w * h);
  const column = new Int32Array(W);
  const perColumn = new Float32Array(w), perRow = new Float32Array(h);
  for (let x = 0; x < W; x++) perColumn[(column[x] = Math.min(w - 1, Math.floor(x / sx)))]++;
  for (let y = 0; y < H; y++) {
    const r = Math.min(h - 1, Math.floor(y / sy));
    perRow[r]++;
    for (let x = 0, o = r * w, i = y * W; x < W; x++, i++) out[o + column[x]] += data[i];
  }
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) out[r * w + c] /= perRow[r] * perColumn[c];
  return { width: w, height: h, data: out, scaleX: sx, scaleY: sy };
}

/** A 3-pixel box blur, horizontal then vertical, done twice (close to a small Gaussian), in place. */
function blur(g: Float32Array, w: number, h: number) {
  const tmp = new Float32Array(g.length);
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < h; y++) {
      const o = y * w;
      for (let x = 0; x < w; x++) {
        let s = g[o + x], n = 1;
        if (x > 0) { s += g[o + x - 1]; n++; }
        if (x < w - 1) { s += g[o + x + 1]; n++; }
        tmp[o + x] = s / n;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0, o = y * w; x < w; x++) {
        let s = tmp[o + x], n = 1;
        if (y > 0) { s += tmp[o + x - w]; n++; }
        if (y < h - 1) { s += tmp[o + x + w]; n++; }
        g[o + x] = s / n;
      }
    }
  }
}

/** Sobel gradients (towards brighter), zero on the border. */
function sobel(g: Float32Array, w: number, h: number): { gx: Float32Array; gy: Float32Array } {
  const gx = new Float32Array(w * h), gy = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1, i = y * w + 1; x < w - 1; x++, i++) {
      const a = g[i - w - 1], b = g[i - w], c = g[i - w + 1], d = g[i - 1], f = g[i + 1], k = g[i + w - 1], l = g[i + w], m = g[i + w + 1];
      gx[i] = c + 2 * f + m - (a + 2 * d + k);
      gy[i] = k + 2 * l + m - (a + 2 * b + c);
    }
  }
  return { gx, gy };
}

/** A line x cos θ + y sin θ = ρ, and its votes. */
type Line = [theta: number, rho: number, votes: number];

function meet(l1: Line, l2: Line): Point | null {
  const a = Math.cos(l1[0]), b = Math.sin(l1[0]), c = Math.cos(l2[0]), d = Math.sin(l2[0]);
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-6) return null;
  return [(l1[1] * d - b * l2[1]) / det, (a * l2[1] - l1[1] * c) / det];
}

const angleBetween = (a: number, b: number) => {
  const d = Math.abs(a - b) % Math.PI;
  return Math.min(d, Math.PI - d);
};

/**
 * Four points as TL, TR, BR, BL: in clockwise order on screen (by their angle around the centre),
 * starting where the sheet's top and bottom sides, taken left to right, point most nearly to the
 * right. That is the top-left of an upright sheet whatever its proportions, and of a turned one
 * up to 45° either way (beyond that the sheet reads as turned the other way: at exactly 45°
 * nothing in the corners can tell).
 */
export function orderCorners(points: readonly Point[]): Corners {
  const cx = (points[0][0] + points[1][0] + points[2][0] + points[3][0]) / 4;
  const cy = (points[0][1] + points[1][1] + points[2][1] + points[3][1]) / 4;
  const s = [...points].sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  let start = 0, best = -Infinity;
  for (let k = 0; k < 4; k++) {
    const p0 = s[k], p1 = s[(k + 1) % 4], p2 = s[(k + 2) % 4], p3 = s[(k + 3) % 4];
    const vx = p1[0] - p0[0] + (p2[0] - p3[0]), vy = p1[1] - p0[1] + (p2[1] - p3[1]);
    const rightward = vx / (Math.hypot(vx, vy) || 1);
    if (rightward > best + 1e-9) { best = rightward; start = k; }
  }
  return [s[start], s[(start + 1) % 4], s[(start + 2) % 4], s[(start + 3) % 4]].map((p) => [p[0], p[1]]) as Corners;
}

/**
 * How much of the side a→b has an edge across it, bright on the inside (towards `inside`) and
 * dark outside: the share of samples with such a gradient above `threshold`, of the samples that
 * lie in the picture (`visible`: the share that does).
 */
function support(gx: Float32Array, gy: Float32Array, w: number, h: number, a: Point, b: Point, inside: Point, threshold: number) {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const n = Math.max(8, Math.round(len / 2));
  const ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len;
  let nx = -uy, ny = ux; // the side's normal, made to point outwards
  if ((inside[0] - a[0]) * nx + (inside[1] - a[1]) * ny > 0) { nx = -nx; ny = -ny; }
  let ok = 0, seen = 0;
  for (let s = 0; s < n; s++) {
    const t = (s + 0.5) / n;
    const x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t;
    if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
    seen++;
    let strongest = 0;
    for (let o = -1; o <= 1; o++) {
      const xi = Math.round(x + nx * o), yi = Math.round(y + ny * o);
      if (xi < 0 || yi < 0 || xi >= w || yi >= h) continue;
      const i = yi * w + xi;
      // The gradient points towards brighter: inside is brighter, so it opposes the outward normal.
      const across = -(gx[i] * nx + gy[i] * ny);
      if (across > strongest) strongest = across;
    }
    if (strongest > threshold) ok++;
  }
  return { share: seen ? ok / seen : 0, visible: seen / n, len };
}

/** The best quadrilateral on the small copy, its sides' support, and the edge threshold used. */
function bestQuad(g: Grey): { quad: Corners; sides: number[]; threshold: number } | null {
  const { width: w, height: h, data } = g;
  blur(data, w, h);
  const { gx, gy } = sobel(data, w, h);
  // Edge threshold: the strongest 10 % of the gradients (at least 20), from a histogram.
  const hist = new Uint32Array(2048);
  let count = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1, i = y * w + 1; x < w - 1; x++, i++) { hist[Math.min(2047, Math.hypot(gx[i], gy[i]) | 0)]++; count++; }
  let level = 0;
  for (let c = 0, target = count * 0.9; level < 2047 && c + hist[level] < target; level++) c += hist[level];
  const threshold = Math.max(20, level);

  // Hough: 1° × 1 px cells, votes weighted by the gradient, only near each pixel's gradient direction.
  const D = Math.ceil(Math.hypot(w, h)), R = 2 * D + 1;
  const acc = new Float32Array(ANGLES * R);
  const cos = new Float64Array(ANGLES), sin = new Float64Array(ANGLES);
  for (let t = 0; t < ANGLES; t++) { cos[t] = Math.cos((t * Math.PI) / ANGLES); sin[t] = Math.sin((t * Math.PI) / ANGLES); }
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1, i = y * w + 1; x < w - 1; x++, i++) {
      const m = Math.hypot(gx[i], gy[i]);
      if (m < threshold) continue;
      let theta = Math.atan2(gy[i], gx[i]);
      if (theta < 0) theta += Math.PI;
      const t0 = Math.round((theta * ANGLES) / Math.PI);
      for (let dt = -VOTE_SPREAD; dt <= VOTE_SPREAD; dt++) {
        const t = (((t0 + dt) % ANGLES) + ANGLES) % ANGLES;
        acc[t * R + Math.round(x * cos[t] + y * sin[t]) + D] += m;
      }
    }
  }
  // Peaks, strongest first, each hiding its neighbours (±5°, ±8 px; across 0°/180° ρ changes sign).
  const used = new Uint8Array(acc.length);
  const lines: Line[] = [];
  while (lines.length < MAX_PEAKS) {
    let top = -1, votes = 0;
    for (let i = 0; i < acc.length; i++) if (!used[i] && acc[i] > votes) { votes = acc[i]; top = i; }
    if (top < 0) break;
    const t = Math.floor(top / R), r = top % R;
    lines.push([(t * Math.PI) / ANGLES, r - D, votes]);
    for (let dt = -5; dt <= 5; dt++) {
      const tt = t + dt, ti = ((tt % ANGLES) + ANGLES) % ANGLES;
      for (let dr = -8; dr <= 8; dr++) {
        const rj = tt === ti ? r + dr : 2 * D - (r + dr);
        if (rj >= 0 && rj < R) used[ti * R + rj] = 1;
      }
    }
  }

  let best: { quad: Corners; sides: number[]; score: number } | null = null;
  const P = lines.length;
  for (let a = 0; a < P; a++) {
    for (let b = a + 1; b < P; b++) {
      if (angleBetween(lines[a][0], lines[b][0]) > PARALLEL) continue;
      // The other pair starts after `a`, so each quadrilateral is tried once.
      for (let c = a + 1; c < P; c++) {
        if (c === b || angleBetween(lines[a][0], lines[c][0]) < PERPENDICULAR) continue;
        for (let d = c + 1; d < P; d++) {
          if (d === b || angleBetween(lines[c][0], lines[d][0]) > PARALLEL) continue;
          const pts = [meet(lines[a], lines[c]), meet(lines[a], lines[d]), meet(lines[b], lines[d]), meet(lines[b], lines[c])];
          if (pts.some((p) => !p || p[0] < -0.15 * w || p[1] < -0.15 * h || p[0] > 1.15 * w || p[1] > 1.15 * h)) continue;
          const quad = orderCorners(pts as Point[]);
          if (signedArea(quad) < MIN_AREA * w * h || !isConvexClockwise(quad)) continue;
          // A side scores at most its length: stop as soon as this quadrilateral cannot win (on a
          // striped or checked background many lines pass the filters above).
          let left = 0;
          for (let i = 0; i < 4; i++) left += Math.hypot(quad[(i + 1) % 4][0] - quad[i][0], quad[(i + 1) % 4][1] - quad[i][1]);
          if (best && left <= best.score) continue;
          const centre: Point = [(quad[0][0] + quad[1][0] + quad[2][0] + quad[3][0]) / 4, (quad[0][1] + quad[1][1] + quad[2][1] + quad[3][1]) / 4];
          let score = 0;
          const sides: number[] = [];
          for (let i = 0; i < 4 && !(best && score + left <= best.score); i++) {
            const s = support(gx, gy, w, h, quad[i], quad[(i + 1) % 4], centre, threshold * 0.5);
            score += s.share ** 3 * s.len * s.visible;
            left -= s.len;
            sides.push(s.share);
          }
          if (sides.length === 4 && (!best || score > best.score)) best = { quad, sides, score };
        }
      }
    }
  }
  return best && { quad: best.quad, sides: best.sides, threshold };
}

/** A line as [nx, ny, c] with nx·x + ny·y = c, fitted to `pts` by total least squares. */
function fitLine(pts: Point[]): [number, number, number] {
  let mx = 0, my = 0;
  for (const [x, y] of pts) { mx += x; my += y; }
  mx /= pts.length; my /= pts.length;
  let sxx = 0, sxy = 0, syy = 0;
  for (const [x, y] of pts) {
    const dx = x - mx, dy = y - my;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
  }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const nx = -Math.sin(theta), ny = Math.cos(theta);
  return [nx, ny, nx * mx + ny * my];
}

/**
 * A line through `pts` by total least squares, then again through those within 3 × the median
 * distance of it (at least 1 px) if `keep` or more are; with how many were that close.
 */
function fitRobust(pts: Point[], keep: number): { line: [number, number, number]; kept: number } {
  const line = fitLine(pts);
  const off = pts.map(([x, y]) => Math.abs(line[0] * x + line[1] * y - line[2]));
  const median = [...off].sort((p, q) => p - q)[off.length >> 1];
  const kept = pts.filter((_, j) => off[j] <= Math.max(1, 3 * median));
  return { line: kept.length >= keep ? fitLine(kept) : line, kept: kept.length };
}

/** Where two lines [nx, ny, c] meet, or null when they are parallel. */
function cross(A: [number, number, number], B: [number, number, number]): Point | null {
  const d = A[0] * B[1] - A[1] * B[0];
  return Math.abs(d) < 1e-9 ? null : [(A[2] * B[1] - A[1] * B[2]) / d, (A[0] * B[2] - A[2] * B[0]) / d];
}

/** The quadrilateral's centre, and the unit normal of its side a→b that points away from it. */
function outward(quad: Corners, a: Point, b: Point): { centre: Point; nx: number; ny: number } {
  const centre: Point = [(quad[0][0] + quad[1][0] + quad[2][0] + quad[3][0]) / 4, (quad[0][1] + quad[1][1] + quad[2][1] + quad[3][1]) / 4];
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  let nx = -(b[1] - a[1]) / len, ny = (b[0] - a[0]) / len;
  if ((centre[0] - a[0]) * nx + (centre[1] - a[1]) * ny > 0) { nx = -nx; ny = -ny; }
  return { centre, nx, ny };
}

/**
 * Each side of `quad` (in `g`'s pixels; `gx`, `gy` its gradients) fitted again: along the side,
 * the strongest bright-to-dark step across it within `span` pixels, then a line through those
 * points (one pass of outlier rejection at 3 × the median distance); each corner where its two
 * fitted sides meet, if that is within `slack` pixels of where it was. A side with too few
 * points keeps its corners.
 */
function refine(g: Grey, gx: Float32Array, gy: Float32Array, quad: Corners, threshold: number, span: number, slack: number): Corners {
  const { width: w, height: h } = g;
  const fitted: ([number, number, number] | null)[] = [];
  for (let i = 0; i < 4; i++) {
    const a = quad[i], b = quad[(i + 1) % 4];
    const { nx, ny } = outward(quad, a, b);
    const pts: Point[] = [];
    for (let k = 8; k <= 92; k++) {
      const s = k / 100;
      const x = a[0] + (b[0] - a[0]) * s, y = a[1] + (b[1] - a[1]) * s;
      let at = 0, strongest = 0;
      for (let o = -span; o <= span; o++) {
        const xi = Math.round(x + nx * o), yi = Math.round(y + ny * o);
        if (xi < 1 || yi < 1 || xi >= w - 1 || yi >= h - 1) continue;
        const j = yi * w + xi;
        const across = -(gx[j] * nx + gy[j] * ny);
        if (across > strongest) { strongest = across; at = o; }
      }
      if (strongest > threshold * 0.5) pts.push([x + nx * at, y + ny * at]);
    }
    if (pts.length < 12) { fitted.push(null); continue; }
    fitted.push(fitRobust(pts, 10).line);
  }
  return quad.map((p, i) => {
    const A = fitted[(i + 3) % 4], B = fitted[i];
    const m = A && B ? cross(A, B) : null;
    return m && Math.hypot(m[0] - p[0], m[1] - p[1]) < slack ? m : p;
  }) as Corners;
}

/**
 * How far beyond a side the paper's own edge is looked for, as a share of the sheet's size across
 * that side at each of its ends (on A4, 3 cm beyond the top and the bottom, 2 cm beyond the left
 * and the right; with perspective the nearer end reaches farther).
 */
const BEYOND = 0.1;
/** How far beyond a side a rival line is looked for, when judging how sure the side is: this many times BEYOND's reach. */
const LOOK = 2;
/** How far inside a side its line may lie at one end (a side that ran off the paper onto the background there), as a share of BEYOND's reach. */
const INWARD = 0.35;
/** Points read along each side, from 8 % to 92 % of its length. */
const SIDE_POINTS = 85;
/** A paper edge: the pixels just inside it at least this share of the paper's brightness near the side... */
const PAPER_INSIDE = 0.9;
/** ...and the band of pixels just outside it darker than them by at least this share of that brightness (and 6 levels). */
const STEP = 0.04;
/**
 * A paper edge more than 2 pixels beyond the side (where the side would move outwards, or a rival
 * line lies) is the sheet's own margin only if those pixels are also this share of the paper just
 * inside the side (its brightest pixel 2 to 8 pixels in, the running median along the side): as
 * bright as the paper. A white table beyond the sheet is about 0.91 of it in the synthetic photos,
 * so the edge of a pen lying on it is not a paper edge...
 */
const MARGIN = 0.94;
/**
 * ...and, more than RIVAL_GAP beyond a side that has an edge of its own there, only past something
 * darker than those pixels by this share of the paper's level: the band or frame printed near the
 * paper's edge that the side lay on. Between a sheet and a pen there is only the table, a little
 * brighter or darker with the light, never a dark band.
 */
const DIP = 0.2;
/**
 * A move outwards is also weighed in sheetSides. The stretch just inside its new line must not
 * change along the side, from one point to the next, more than this many times the paper just
 * inside the side does (nor more than GRAIN_FLOOR of the paper's level): a table's grain is not
 * the paper's margin...
 */
const GRAIN = 2.2;
const GRAIN_FLOOR = 0.006;
/** ...and, once the sides are found, the photo just beyond a side moved outwards no darker, by this share of the paper's level, than beyond the other sides: past a pen, a ruler, a laptop or a shadow on the table it is. */
const BACKGROUND = 0.1;
/** The grain is read where the move is beyond the side (more than 2 pixels out), at this many pairs of neighbouring points or more (fewer: the same edge, turned a little). */
const EVIDENCE_POINTS = 8;
/** A side whose move fails one of those two is no surer than this, so the corners are not trusted: both readings stay plausible. */
const DOUBT = 0.45;
/** The lines that hold at least this share of the best one's points are the side's candidates; the outermost wins. */
const NEAR_BEST = 0.8;
/** A side's line holds at least this share of the points read along it (and 12). */
const HOLDS = 0.5;
/** How far the two ends of a candidate line may differ in offset, as a share of the side's length (about 8.5°). */
const SLANT = 0.15;
/** A side moves when its new line is this far from it at either end (pixels); less is the same edge. */
const MOVES = 1.5;
/** A rival line lies wholly beyond the side by at least this many pixels (closer, it is the same edge). */
const RIVAL_GAP = 6;
/** sheetSides moves the sides at most this many times (a side first taken to a frame's inner edge, then to the paper's). */
const EDGE_PASSES = 3;

type Line3 = [number, number, number];

/** What readSide found along one side. */
interface SideRead {
  /** The line the side moves to, or null when it stays. */
  line: Line3 | null;
  /** The share of the points read with an edge on the side as it is. */
  own: number;
  /** The largest share held by a line wholly beyond the side as it is (within LOOK × the reach). */
  rival: number;
  /** The photo just beyond the side as it is (offsets 3 to 6) over the paper's level: the median along it, or null. */
  outside: number | null;
  /**
   * For a move outwards (EVIDENCE_POINTS pairs of neighbouring points or more beyond the side):
   * how much the brightest of the 3 pixels just inside the new line changes from one point to the
   * next along it, over the paper's level (the median step), and the same for the paper just
   * inside the side.
   */
  grain: { margin: number; paper: number } | null;
}

/** The median of `values` (the mean of the middle two for an even count); NaN when empty. */
function median(values: number[]): number {
  const s = [...values].sort((x, y) => x - y), n = s.length;
  return n === 0 ? Number.NaN : n % 2 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/** The median of the positive values of `values` within 6 places of `k` (0 when none): a thumb or a dark patch at a few points does not count. */
function medianAround(values: Float32Array, k: number): number {
  const near: number[] = [];
  for (let j = Math.max(0, k - 6); j <= Math.min(values.length - 1, k + 6); j++) if (values[j] > 0) near.push(values[j]);
  near.sort((x, y) => x - y);
  return near.length ? near[near.length >> 1] : 0;
}

/**
 * One side of `quad` read on `raw` (the grey copy before blurring, `w` × `h`). At SIDE_POINTS
 * points along it, the profile across it from INWARD of the reach inside to LOOK × the reach
 * beyond, each value the mean of 5 pixels along the side (less noise, the edge as sharp), and in
 * it the paper edges: where the step p[o − 1] − p[o + 1] peaks with paper inside (the brightest of
 * the 3 pixels before it at least PAPER_INSIDE of the paper's level near the side: the brightest
 * value inside the side, its running median along the side) and a band of pixels just outside it
 * darker (offsets 2 to 5, by STEP of that level); beyond the side, also as bright as the paper
 * just inside it (MARGIN) and, farther out than the side's own edge could be, past a dark band
 * (DIP) where the side has an edge of its own. Every line across the points (its end offsets
 * whole pixels, within SLANT of the side's length of each other) then holds the points with a
 * paper edge within a pixel of it; of the lines within the reach that hold at least HOLDS of the
 * points and NEAR_BEST of the best one's, the outermost is the side, fitted again through those
 * edges.
 *
 * A band or frame printed near the paper's edge has paper inside its inner edge and dark just
 * outside it, as the sheet's edge does, with far more contrast: what tells them apart is that the
 * sheet's edge is the outermost such edge, with the paper's own margin inside it and the band
 * between. Beyond the sheet a dark mat, a ruler, or a white table with a pen, a laptop or a
 * shadow on it, is not paper with something darker after it (fix round 2 took a white table for
 * paper, and the pen's edge for the sheet's); another sheet is, and a line along it beyond the
 * side (`rival`) makes the side unsure, as does a band's inner edge the side could not get past.
 *
 * A side that has an edge of its own (any step down across it: a curled or shadowed edge is
 * darker than the paper inside) along NEAR_BEST of it only moves outwards; one that has not (it
 * ran off the paper at one end, or lies on clutter) may also turn inwards at one end, but never
 * moves wholly inside itself: that is how a shadow's edge, a curl's shading or a line of text
 * would look.
 */
function readSide(raw: Float32Array, w: number, h: number, quad: Corners, i: number): SideRead {
  const a = quad[i], b = quad[(i + 1) % 4];
  const { nx, ny } = outward(quad, a, b);
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len;
  // The reach at each end, from the sides that meet the side there.
  const across = (p: Point, q: Point) => Math.max(8, Math.round(BEYOND * Math.hypot(q[0] - p[0], q[1] - p[1])));
  const reachA = across(quad[(i + 3) % 4], a), reachB = across(b, quad[(i + 2) % 4]), reach = Math.max(reachA, reachB);
  const inward = Math.max(6, Math.round(INWARD * reach)), look = LOOK * reach;
  // The profiles at offsets lo … hi (−1 outside the photo): the paper's level read from lo to −2,
  // edges from −inward to look.
  const lo = -inward - 12, hi = look + 6, span = hi - lo + 1;
  const p = new Float32Array(SIDE_POINTS * span).fill(-1);
  const level = new Float32Array(SIDE_POINTS).fill(-1), close = new Float32Array(SIDE_POINTS).fill(-1);
  for (let k = 0; k < SIDE_POINTS; k++) {
    const s = (8 + k) / 100, x0 = a[0] + (b[0] - a[0]) * s, y0 = a[1] + (b[1] - a[1]) * s;
    const row = k * span - lo;
    for (let o = lo; o <= hi; o++) {
      let sum = 0, n = 0;
      for (let t = -2; t <= 2; t++) {
        const xi = Math.round(x0 + nx * o + ux * t), yi = Math.round(y0 + ny * o + uy * t);
        if (xi >= 0 && yi >= 0 && xi < w && yi < h) { sum += raw[yi * w + xi]; n++; }
      }
      if (n >= 3) p[row + o] = sum / n;
    }
    if (p[row] < 0) continue; // the side itself is outside the photo here
    for (let o = lo; o <= -2; o++) level[k] = Math.max(level[k], p[row + o]);
    for (let o = -8; o <= -2; o++) close[k] = Math.max(close[k], p[row + o]);
  }
  // At each point: whether the side has an edge of its own, and the paper edges (`edges` between
  // pixels, to fit; `runs`, the whole pixels within one of them, to count).
  const edges: number[][] = [], runs: number[][] = [];
  const paperAt = new Float32Array(SIDE_POINTS);
  let seen = 0, own = 0;
  for (let k = 0; k < SIDE_POINTS; k++) {
    const found: number[] = [], spans: number[] = [];
    edges.push(found);
    runs.push(spans);
    if (level[k] <= 0) continue;
    seen++;
    const paper = (paperAt[k] = medianAround(level, k));
    const margin = Math.max(PAPER_INSIDE * paper, MARGIN * medianAround(close, k));
    const row = k * span - lo, v = (o: number) => p[row + o];
    let onSide = false, darkest = Infinity; // the darkest pixel from 1 beyond the side to 2 before `o`
    for (let o = -inward; o <= look; o++) {
      if (o - 2 >= 1 && v(o - 2) >= 0) darkest = Math.min(darkest, v(o - 2));
      if (v(o - 3) < 0 || v(o - 2) < 0 || v(o + 5) < 0) continue;
      const d = v(o - 1) - v(o + 1), before = v(o - 2) - v(o), after = v(o) - v(o + 2);
      if (!(d > 0 && d > before && d >= after)) continue;
      const inner = Math.max(v(o - 3), v(o - 2), v(o - 1));
      const outer = (v(o + 2) + v(o + 3) + v(o + 4) + v(o + 5)) / 4;
      if (Math.abs(o) <= 2 && inner - outer >= Math.max(6, STEP * inner)) onSide = true;
      if (inner - outer < Math.max(6, STEP * paper)) continue;
      // Beyond the side: the paper's own margin, and farther out than the side's own edge could be,
      // past the band the side lay on if it has an edge here.
      if (o > 2 ? inner < margin || (onSide && o > RIVAL_GAP && inner - darkest < DIP * paper) : inner < PAPER_INSIDE * paper) continue;
      const curve = before - 2 * d + after; // the peak between pixels: a parabola through the three steps
      found.push(o + (curve < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (before - after)) / curve)) : 0));
      if (spans.length && spans[spans.length - 1] >= o - 2) spans[spans.length - 1] = o + 1;
      else spans.push(o - 1, o + 1);
    }
    if (onSide) own++;
  }
  if (seen < 20) return { line: null, own: 0, rival: 0, outside: null, grain: null };
  /**
   * At each point, the pixels `from` to `to` past offset `at(k)` over the paper's level there:
   * their mean, or with `brightest` the brightest of them (null where any is outside the photo).
   */
  const stretch = (from: number, to: number, at: (k: number) => number | null, brightest: boolean) => {
    const out: (number | null)[] = [];
    for (let k = 0; k < SIDE_POINTS; k++) {
      const o0 = paperAt[k] > 0 ? at(k) : null;
      let sum = 0, top = 0, n = 0;
      if (o0 !== null) {
        for (let o = o0 + from; o <= o0 + to; o++) {
          const x = p[k * span - lo + o];
          if (x < 0) { n = 0; break; }
          sum += x; top = Math.max(top, x); n++;
        }
      }
      out.push(n ? (brightest ? top : sum / n) / paperAt[k] : null);
    }
    return out;
  };
  /** How much `values` change from one point to the next: the median of those steps (along the side, so a slow change of light counts little). */
  const grainOf = (values: (number | null)[]) => {
    const steps: number[] = [];
    for (let k = 1; k < values.length; k++) if (values[k] !== null && values[k - 1] !== null) steps.push(Math.abs(values[k]! - values[k - 1]!));
    return steps.length >= EVIDENCE_POINTS ? median(steps) : null;
  };
  const outside = stretch(3, 6, () => 0, false).filter((x): x is number => x !== null);
  // How many points each line holds, for every line: end offsets da (at a) and db = da + j (at
  // b); at a point s of the way along, round(da + j s) falls in a run for j in an interval, so
  // each run adds 1 over an interval of j (a difference array per da).
  const slant = Math.max(6, Math.round(SLANT * len));
  const nJ = 2 * slant + 1;
  const held = new Int32Array((inward + look + 1) * nJ), diff = new Int32Array(nJ + 1);
  for (let da = -inward; da <= look; da++) {
    diff.fill(0);
    for (let k = 0; k < SIDE_POINTS; k++) {
      const s = (8 + k) / 100, spans = runs[k];
      for (let r = 0; r < spans.length; r += 2) {
        const j0 = Math.max(-slant, Math.ceil((spans[r] - 0.5 - da) / s));
        const j1 = Math.min(slant, Math.ceil((spans[r + 1] + 0.5 - da) / s) - 1);
        if (j0 > j1) continue;
        diff[j0 + slant]++;
        diff[j1 + slant + 1]--;
      }
    }
    for (let j = 0, n = 0, at = (da + inward) * nJ; j < nJ; j++) held[at + j] = n += diff[j];
  }
  const holds = (da: number, db: number) => (db < -inward || db > look || Math.abs(db - da) > slant ? 0 : held[(da + inward) * nJ + db - da + slant]);
  let rival = 0;
  for (let da = RIVAL_GAP; da <= look; da++) for (let db = Math.max(RIVAL_GAP, da - slant); db <= da + slant && db <= look; db++) rival = Math.max(rival, holds(da, db));
  const stays: SideRead = { line: null, own: own / seen, rival: rival / seen, outside: outside.length ? median(outside) : null, grain: null };
  // The lines the side may move to, and the outermost of those that hold enough.
  const turnsIn = own < NEAR_BEST * seen;
  const allowed = (da: number, db: number) => (turnsIn ? Math.max(da, db) : Math.min(da, db)) >= -2;
  let best = 0;
  for (let da = -inward; da <= reachA; da++) for (let db = da - slant; db <= da + slant && db <= reachB; db++) if (allowed(da, db)) best = Math.max(best, holds(da, db));
  const enough = Math.max(12, HOLDS * seen, NEAR_BEST * best);
  let chosen: [number, number] | null = null, outmost = -Infinity, most = 0;
  for (let da = -inward; da <= reachA; da++) {
    for (let db = da - slant; db <= da + slant && db <= reachB; db++) {
      const n = holds(da, db);
      if (n >= enough && allowed(da, db) && (da + db > outmost || (da + db === outmost && n > most))) { outmost = da + db; chosen = [da, db]; most = n; }
    }
  }
  if (!chosen) return stays;
  // The paper edges on that line, fitted again; the side moves if the fit is MOVES or more off it.
  const [ca, cb] = chosen;
  const pts: Point[] = [];
  const picked = new Array<number | null>(SIDE_POINTS).fill(null);
  for (let k = 0; k < SIDE_POINTS; k++) {
    const s = (8 + k) / 100, e = ca + (cb - ca) * s;
    let pick = Infinity;
    for (const o of edges[k]) if (Math.abs(o - e) <= 2 && Math.abs(o - e) < Math.abs(pick - e)) pick = o;
    if (pick === Infinity) continue;
    pts.push([a[0] + (b[0] - a[0]) * s + nx * pick, a[1] + (b[1] - a[1]) * s + ny * pick]);
    if (pick > 2) picked[k] = Math.round(pick);
  }
  const need = Math.max(12, HOLDS * seen);
  if (pts.length < need) return stays;
  const { line, kept } = fitRobust(pts, need);
  const facing = line[0] * nx + line[1] * ny;
  if (kept < need || Math.abs(facing) < 0.985) return stays; // turned by more than about 10°
  const off = (q: Point) => (line[2] - line[0] * q[0] - line[1] * q[1]) / facing;
  if (Math.max(Math.abs(off(a)), Math.abs(off(b))) < MOVES) return stays;
  // A move outwards: how much the stretch just inside the new line, where it is beyond the side,
  // and the paper just inside the side change along it (sheetSides weighs them).
  const marginGrain = grainOf(stretch(-3, -1, (k) => picked[k], true)), paperGrain = grainOf(stretch(-5, -3, () => 0, true));
  return { ...stays, line, grain: marginGrain !== null && paperGrain !== null ? { margin: marginGrain, paper: paperGrain } : null };
}

/**
 * The moves outwards in `reads` whose new margin shows a grain the paper just inside the side has
 * not (a table's, past the sheet's edge, whose pixels pass for the paper's margin as bright but
 * not as smooth), dropped, and the side marked in `doubt`: both readings stay plausible.
 */
function judgeMoves(reads: SideRead[], doubt: boolean[]) {
  reads.forEach((r, i) => {
    if (!r.line || !r.grain || r.grain.margin <= Math.max(GRAIN * r.grain.paper, GRAIN_FLOOR)) return;
    reads[i] = { ...r, line: null };
    doubt[i] = true;
  });
}

/**
 * The sheet's sides found again on the grey copy before blurring (`raw`, `w` × `h`): each side of
 * `start` read by readSide and moved onto the outermost paper edge along it, again while a side
 * moves (each move changes where its neighbours end), up to EDGE_PASSES times; a move outwards
 * whose new margin has a grain is not made (judgeMoves). Then each side's support in `sides`
 * becomes how sure the side is: the share of it with an edge, less the share a line beyond it
 * holds (and for a side that did not move, no more than it was); and no more than DOUBT for a side
 * whose move was not made for its grain, or that moved outwards onto an edge with the photo
 * beyond it darker than beyond the other sides (BACKGROUND): either reading stays plausible.
 */
function sheetSides(raw: Float32Array, w: number, h: number, start: Corners, sides: number[]): Corners {
  let quad = start;
  const moved = [false, false, false, false], outwards = [false, false, false, false], doubt = [false, false, false, false];
  let reads: SideRead[] = [];
  for (let pass = 0; ; pass++) {
    reads = [0, 1, 2, 3].map((i) => readSide(raw, w, h, quad, i));
    judgeMoves(reads, doubt);
    if (pass === EDGE_PASSES || reads.every((r) => !r.line)) break;
    const lines = reads.map((r, i) => {
      if (r.line) return r.line;
      const a = quad[i], { nx, ny } = outward(quad, a, quad[(i + 1) % 4]);
      return [nx, ny, nx * a[0] + ny * a[1]] as Line3;
    });
    const next = quad.map((p, i) => cross(lines[(i + 3) % 4], lines[i]) ?? p) as Corners;
    if (!isConvexClockwise(next) || signedArea(next) < MIN_AREA * w * h) break;
    reads.forEach((r, i) => {
      if (!r.line) return;
      moved[i] = true;
      if (r.grain) outwards[i] = true;
      doubt[i] = false;
    });
    quad = next;
  }
  // A side moved outwards should have the background beyond it, as the other sides have: past the
  // edge of a pen, a ruler, a laptop or a shadow lying on the table, the photo is darker.
  reads.forEach((r, i) => {
    const others = reads.filter((_, j) => j !== i).map((q) => q.outside).filter((x): x is number => x !== null);
    if (outwards[i] && r.outside !== null && others.length >= 2 && r.outside < median(others) - BACKGROUND) doubt[i] = true;
  });
  reads.forEach((r, i) => {
    const sure = Math.max(0, r.own - r.rival);
    sides[i] = moved[i] ? sure : Math.min(sides[i], sure);
    if (doubt[i]) sides[i] = Math.min(sides[i], DOUBT);
  });
  return quad;
}

/**
 * Find the sheet in an upright photo. Returns its corners in the photo's pixels, kept inside the
 * frame (a corner the photo cut off is moved onto its edge), and how sure the detector is; null
 * corners when nothing sheet-like was found. Callers compare `confidence` with FOUND_CONFIDENCE.
 */
export function detectSheet(photo: Pixels): Detection {
  const none: Detection = { corners: null, confidence: 0, sides: [0, 0, 0, 0] };
  if (photo.width < 16 || photo.height < 16) return none;
  const big = greyOf(photo, REFINE_SIDE);
  const small = shrink(big, DETECT_SIDE);
  const found = bestQuad(small);
  if (!found) return none;
  // From the small copy's pixels to the big one's (pixel centres line up), and from there to the photo's.
  const toBig = (p: Point): Point => [(p[0] + 0.5) * small.scaleX - 0.5, (p[1] + 0.5) * small.scaleY - 0.5];
  const k = (small.scaleX + small.scaleY) / 2;
  const rough = found.quad.map(toBig) as Corners;
  const raw = big.data.slice(); // sheetSides reads the copy unblurred (a 2 mm margin is a few pixels)
  blur(big.data, big.width, big.height);
  const { gx, gy } = sobel(big.data, big.width, big.height);
  let quad = refine(big, gx, gy, rough, found.threshold, Math.ceil(2.5 * k), 4 * k);
  if (!isConvexClockwise(quad) || signedArea(quad) < MIN_AREA * big.width * big.height) quad = rough;
  const sides = found.sides.slice();
  quad = sheetSides(raw, big.width, big.height, quad, sides);
  const corners = clampCorners(
    quad.map(([x, y]) => [(x + 0.5) * big.scaleX, (y + 0.5) * big.scaleY]) as Corners,
    photo.width, photo.height,
  );
  const weakest = Math.min(...sides);
  return { corners, confidence: Math.max(0, Math.min(1, (weakest - 0.3) / 0.4)), sides };
}
