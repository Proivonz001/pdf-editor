// Straightening the sheet: the perspective transform (a homography) that takes the page's
// rectangle onto the sheet's four corners in the photo, and a bilinear resampling through it.
// Plain JavaScript, so it runs in the scan worker with no MuPDF (whose Pixmap.warp does the same
// with the same quality: within 0.2–0.8 dB in the research probes). Corners are always TL, TR,
// BR, BL (the order Pixmap.warp also wants; the C names ul, ur, ll, lr suggest another one).
import type { Corners, Pixels, Point } from "./types";

/**
 * The homography that maps `from[i]` to `to[i]` for the four points: [a, b, c, d, e, f, g, h]
 * with (x, y) ↦ ((a x + b y + c) / (g x + h y + 1), (d x + e y + f) / (g x + h y + 1)).
 * Null when the points are degenerate (three in a line, or two the same).
 */
export function homography(from: Corners, to: Corners): Float64Array | null {
  // Three points in a line make the system solvable but the map singular: refuse them first.
  if (degenerate(from) || degenerate(to)) return null;
  // The 8 × 8 system, as rows of 9 (the right-hand side last), solved by Gaussian elimination
  // with partial pivoting.
  const M = new Float64Array(8 * 9);
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i], [u, v] = to[i];
    M.set([x, y, 1, 0, 0, 0, -u * x, -u * y, u], 2 * i * 9);
    M.set([0, 0, 0, x, y, 1, -v * x, -v * y, v], (2 * i + 1) * 9);
  }
  let scale = 0;
  for (let i = 0; i < 72; i++) scale = Math.max(scale, Math.abs(M[i]));
  for (let c = 0; c < 8; c++) {
    let pivot = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(M[r * 9 + c]) > Math.abs(M[pivot * 9 + c])) pivot = r;
    if (!(Math.abs(M[pivot * 9 + c]) > 1e-12 * Math.max(1, scale))) return null;
    if (pivot !== c) {
      for (let k = 0; k < 9; k++) {
        const t = M[c * 9 + k];
        M[c * 9 + k] = M[pivot * 9 + k];
        M[pivot * 9 + k] = t;
      }
    }
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = M[r * 9 + c] / M[c * 9 + c];
      if (f === 0) continue;
      for (let k = c; k < 9; k++) M[r * 9 + k] -= f * M[c * 9 + k];
    }
  }
  const H = new Float64Array(8);
  for (let i = 0; i < 8; i++) H[i] = M[i * 9 + 8] / M[i * 9 + i];
  return H.every(Number.isFinite) ? H : null;
}

/** Some three of the four points lie in a line (or two coincide), relative to their spread. */
function degenerate(q: Corners): boolean {
  let extent = 0;
  for (const a of q) for (const b of q) extent = Math.max(extent, Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
  if (!(extent > 0)) return true;
  for (let i = 0; i < 4; i++) {
    const o = q[i], a = q[(i + 1) % 4], b = q[(i + 2) % 4];
    if (Math.abs((a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])) <= 1e-9 * extent * extent) return true;
  }
  return false;
}

/** `H` applied to (x, y). */
export function applyHomography(H: Float64Array, x: number, y: number): Point {
  const w = H[6] * x + H[7] * y + 1;
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

/**
 * The sheet at `corners` (TL, TR, BR, BL, in `photo`'s pixels) as a `width` × `height` page:
 * each page pixel's centre is taken back into the photo through the homography and read there
 * by bilinear interpolation (edges clamped). Opaque RGBA. Throws when the corners are degenerate.
 */
export function warp(photo: Pixels, corners: Corners, width: number, height: number): Pixels {
  const H = homography([[0, 0], [width, 0], [width, height], [0, height]], corners);
  if (!H) throw new Error("The corners do not make a sheet");
  const src = photo.data, W = photo.width, Hh = photo.height;
  const out = new Uint8ClampedArray(width * height * 4);
  const maxX = W - 1, maxY = Hh - 1;
  for (let y = 0; y < height; y++) {
    const v = y + 0.5;
    // Numerators and denominator are linear along the row: step them instead of recomputing.
    let nx = H[0] * 0.5 + H[1] * v + H[2], ny = H[3] * 0.5 + H[4] * v + H[5], d = H[6] * 0.5 + H[7] * v + 1;
    for (let x = 0, o = y * width * 4; x < width; x++, o += 4) {
      // Continuous photo coordinates to pixel-index ones (pixel centres at i + 0.5).
      const sx = nx / d - 0.5, sy = ny / d - 0.5;
      nx += H[0]; ny += H[3]; d += H[6];
      let x0 = Math.floor(sx), y0 = Math.floor(sy);
      let fx = sx - x0, fy = sy - y0;
      if (x0 < 0) { x0 = 0; fx = 0; } else if (x0 >= maxX) { x0 = maxX; fx = 0; }
      if (y0 < 0) { y0 = 0; fy = 0; } else if (y0 >= maxY) { y0 = maxY; fy = 0; }
      const x1 = x0 < maxX ? x0 + 1 : x0, y1 = y0 < maxY ? y0 + 1 : y0;
      const i00 = (y0 * W + x0) * 4, i01 = (y0 * W + x1) * 4, i10 = (y1 * W + x0) * 4, i11 = (y1 * W + x1) * 4;
      const w00 = (1 - fx) * (1 - fy), w01 = fx * (1 - fy), w10 = (1 - fx) * fy, w11 = fx * fy;
      out[o] = src[i00] * w00 + src[i01] * w01 + src[i10] * w10 + src[i11] * w11;
      out[o + 1] = src[i00 + 1] * w00 + src[i01 + 1] * w01 + src[i10 + 1] * w10 + src[i11 + 1] * w11;
      out[o + 2] = src[i00 + 2] * w00 + src[i01 + 2] * w01 + src[i10 + 2] * w10 + src[i11 + 2] * w11;
      out[o + 3] = 255;
    }
  }
  return { width, height, data: out };
}
