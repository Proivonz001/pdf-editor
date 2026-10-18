// Cleaning up a straightened sheet, in plain JavaScript (the scan worker has no MuPDF):
// - "Documento" flattens the light: the paper's brightness is estimated block by block and each
//   pixel divided by it, so shadows and uneven light go and the paper comes out white; then a
//   black point and a white point stretch the ink darker. Only "paper" blocks count: their
//   brightest pixels are nearly grey (low chroma), they are not far darker than the brightest
//   paper, and they join it smoothly, block to block, from the brightest blocks or from the
//   page's edge (a shadow changes smoothly, or comes in from outside the sheet). Colour photos,
//   logos and solid colour fail the first test; a grey photo or a chart's grey fill fails the
//   last, its edge being a jump from the paper around it. Those blocks take the paper's level
//   around them, so a picture keeps its tones instead of being re-lit as paper in shadow (on the
//   review's grey photo, 3 levels off on average instead of 49). What this cannot tell apart: a
//   grey picture that reaches the page's edge is still flattened like a shadow, and a hard-edged
//   shadow lying wholly inside the page is left as it is, like a picture.
// - "Grigio" is the same page in grey; "Bianco e nero" thresholds that grey page with Bradley's
//   adaptive threshold (a pixel is ink when at most 85 % of the mean around it) and an absolute
//   one beside it (anything darker than INK on the flattened page is ink, so a black area wider
//   than the threshold's window stays black instead of coming out hollow), straight into 1-bit
//   rows, bit 1 = white (DeviceGray with no /Decode, as a 1-bit PNG means it too).
//
// Ported from the research prototype (enhance.mjs: flatten2, background2, toGray, threshold,
// pack1). What changed: the work is done in place on the page's own buffer (a 300 dpi RGBA page
// is 35 MB: no second copy); a block's samples are read twice instead of being pushed into a
// JS array per block; the threshold keeps running column sums (one Uint32Array as wide as the
// page) instead of a Float64 integral image (70 MB at 300 dpi), and writes the bits directly;
// a grey block much darker than the paper (a solid black heading, the black beyond the sheet)
// counts as ink, not as paper in shadow; a page with no paper-like block at all (a coloured
// flyer) gets one level for the whole page, from its brightest channel, instead of 200 rounds
// of filling nothing; the level never drops below a quarter of the paper's median, so a black
// border is not stretched into noise.
import type { Pixels } from "./types";

/** Brightness (luma, 0..255) of an RGB pixel, in integers (Rec. 601 weights). */
const luma = (r: number, g: number, b: number) => (r * 77 + g * 150 + b * 29) >> 8;

/** A block counts as paper when the mean chroma (max − min channel) of its brightest pixels is below this. */
const PAPER_CHROMA = 28;
/** How close to the block's level a pixel must be to count as its paper. */
const NEAR_LEVEL = 6;
/** Paper is never darker than this (out of 255), however dim the photo: below it a grey block is ink. */
const MIN_PAPER = 64;
/** Grey blocks at least this share of the brightest paper's level are paper wherever they are: with those on the page's edge, where the paper starts from. */
const BRIGHT_PAPER = 0.85;
/** Paper's level changes by at most this share from one block to the next (shadows and uneven light are smooth; a picture's edge is a jump). */
const SMOOTH = 0.12;

/** The paper's brightness on a grid of `cell`-pixel blocks, smoothed: what flattenLight divides by. */
interface Levels {
  grid: Float32Array;
  columns: number;
  rows: number;
}

function paperLevels(page: Pixels, cell: number): Levels {
  const { width: w, height: h, data } = page;
  const columns = Math.ceil(w / cell), rows = Math.ceil(h / cell);
  let grid = new Float32Array(columns * rows);
  const ok = new Uint8Array(columns * rows);
  const hist = new Uint32Array(256);
  for (let by = 0; by < rows; by++) {
    for (let bx = 0; bx < columns; bx++) {
      const x0 = bx * cell, x1 = Math.min(w, x0 + cell), y0 = by * cell, y1 = Math.min(h, y0 + cell);
      hist.fill(0);
      let n = 0;
      // Every second pixel both ways is plenty for a level.
      for (let y = y0; y < y1; y += 2) {
        for (let x = x0, i = (y * w + x0) * 4; x < x1; x += 2, i += 8) { hist[luma(data[i], data[i + 1], data[i + 2])]++; n++; }
      }
      // The block's level: its 90th percentile of brightness.
      let level = 0;
      for (let c = 0, target = n * 0.9; level < 255 && c + hist[level] < target; level++) c += hist[level];
      let chroma = 0, m = 0;
      for (let y = y0; y < y1; y += 2) {
        for (let x = x0, i = (y * w + x0) * 4; x < x1; x += 2, i += 8) {
          const r = data[i], g = data[i + 1], b = data[i + 2];
          if (Math.abs(luma(r, g, b) - level) > NEAR_LEVEL) continue;
          chroma += Math.max(r, g, b) - Math.min(r, g, b);
          m++;
        }
      }
      const k = by * columns + bx;
      grid[k] = Math.max(level, 1);
      ok[k] = m > 0 && chroma / m < PAPER_CHROMA ? 1 : 0;
    }
  }
  // A grey block that is much darker than the paper is ink, not paper in shadow (a solid black
  // heading, the black beyond the sheet): paper is at least MIN_PAPER and 30 % of the brightest paper.
  const grey: number[] = [];
  for (let k = 0; k < ok.length; k++) if (ok[k]) grey.push(grid[k]);
  grey.sort((a, b) => a - b);
  const brightest = grey.length ? grey[Math.floor(0.95 * (grey.length - 1))] : 0;
  const darkest = Math.max(MIN_PAPER, 0.3 * brightest);
  for (let k = 0; k < ok.length; k++) if (ok[k] && grid[k] < darkest) ok[k] = 0;
  // A grey block is paper only when it joins the paper smoothly: from the brightest blocks and
  // from those on the page's edge (where a shadow comes in), block to block, each within SMOOTH
  // of its neighbour's level. A grey photo or a chart's grey fill is a jump from the paper around
  // it, so its blocks are left out and take the paper's level around them; a shadow changes
  // smoothly, or comes in from outside the sheet.
  const joined = new Uint8Array(ok.length), queue = new Int32Array(ok.length);
  let head = 0, tail = 0;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      const k = y * columns + x;
      const edge = x === 0 || y === 0 || x === columns - 1 || y === rows - 1;
      if (ok[k] && (edge || grid[k] >= BRIGHT_PAPER * brightest)) { joined[k] = 1; queue[tail++] = k; }
    }
  }
  while (head < tail) {
    const k = queue[head++], x = k % columns, y = (k - x) / columns;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= columns || yy >= rows) continue;
        const j = yy * columns + xx;
        if (ok[j] && !joined[j] && Math.abs(grid[j] - grid[k]) <= SMOOTH * grid[k]) { joined[j] = 1; queue[tail++] = j; }
      }
    }
  }
  ok.set(joined);
  const paper: number[] = [];
  for (let k = 0; k < ok.length; k++) if (ok[k]) paper.push(grid[k]);
  if (paper.length === 0) {
    // Nothing looks like paper (a coloured flyer, a photo): one level for the whole page, no
    // flattening, from the brightest channel rather than the brightness, so that dividing by it
    // brightens the page without washing its colours out.
    hist.fill(0);
    let n = 0;
    for (let y = 0; y < h; y += 2) {
      for (let x = 0, i = y * w * 4; x < w; x += 2, i += 8) { hist[Math.max(data[i], data[i + 1], data[i + 2])]++; n++; }
    }
    let level = 0;
    for (let c = 0, target = n * 0.95; level < 255 && c + hist[level] < target; level++) c += hist[level];
    grid.fill(Math.max(level, 1));
    paper.push(Math.max(level, 1));
  } else {
    // Blocks that are not paper take the mean of their paper neighbours, ring by ring.
    let left = ok.length - paper.length;
    const filled = new Uint8Array(ok.length);
    for (let round = 0; left > 0 && round < 200; round++) {
      filled.set(ok);
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < columns; x++) {
          const k = y * columns + x;
          if (ok[k]) continue;
          let s = 0, n = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx, yy = y + dy;
              if (xx < 0 || yy < 0 || xx >= columns || yy >= rows) continue;
              const j = yy * columns + xx;
              if (ok[j]) { s += grid[j]; n++; }
            }
          }
          if (n) { grid[k] = s / n; filled[k] = 1; left--; }
        }
      }
      ok.set(filled);
    }
  }
  // 3 × 3 maximum (a block full of text keeps its neighbours' paper level), then 3 × 3 mean twice.
  let other = new Float32Array(grid.length);
  for (const op of ["max", "mean", "mean"] as const) {
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < columns; x++) {
        let v = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= columns || yy >= rows) continue;
            const g = grid[yy * columns + xx];
            if (op === "max") v = Math.max(v, g);
            else { v += g; n++; }
          }
        }
        other[y * columns + x] = op === "max" ? v : v / n;
      }
    }
    [grid, other] = [other, grid];
  }
  paper.sort((a, b) => a - b);
  const floor = Math.max(1, 0.25 * (paper.length ? paper[paper.length >> 1] : grid[0]));
  for (let k = 0; k < grid.length; k++) if (grid[k] < floor) grid[k] = floor;
  return { grid, columns, rows };
}

export interface FlattenOptions {
  /** Share of the paper's brightness that becomes black (ink pushed darker). */
  black?: number;
  /** Share that becomes white (paper a little darker than its level still comes out white). */
  white?: number;
}

/**
 * "Documento": the light flattened, in place. Each channel is divided by the paper's level
 * around the pixel (bilinear between block centres), then stretched so that `black` of it
 * becomes 0 and `white` becomes 255. Blocks of about 1/40 of the page's longer side. The
 * defaults (0.2, 0.88) are those the research ran "Documento" with: paper in a lit and a
 * shadowed margin went from 208 and 131 to 255.
 */
export function flattenLight(page: Pixels, { black = 0.2, white = 0.88 }: FlattenOptions = {}): void {
  const { width: w, height: h, data } = page;
  const cell = Math.max(8, Math.round(Math.max(w, h) / 40));
  const { grid, columns, rows } = paperLevels(page, cell);
  const stretch = 1 / (white - black);
  // Where each column falls between block centres, once for the page.
  const left = new Int32Array(w), right = new Int32Array(w), share = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    const f = Math.min(columns - 1, Math.max(0, x / cell - 0.5));
    left[x] = Math.floor(f);
    right[x] = Math.min(columns - 1, left[x] + 1);
    share[x] = f - left[x];
  }
  const row = new Float32Array(columns);
  for (let y = 0; y < h; y++) {
    const f = Math.min(rows - 1, Math.max(0, y / cell - 0.5));
    const top = Math.floor(f), bottom = Math.min(rows - 1, top + 1), t = f - top;
    for (let c = 0; c < columns; c++) row[c] = grid[top * columns + c] * (1 - t) + grid[bottom * columns + c] * t;
    for (let x = 0, i = y * w * 4; x < w; x++, i += 4) {
      const inverse = 1 / (row[left[x]] * (1 - share[x]) + row[right[x]] * share[x]);
      for (let c = 0; c < 3; c++) {
        let v = data[i + c] * inverse;
        if (v > 1) v = 1;
        v = (v - black) * stretch;
        data[i + c] = v <= 0 ? 0 : v >= 1 ? 255 : v * 255;
      }
      data[i + 3] = 255;
    }
  }
}

/** "Grigio": every pixel made grey (its luma in R, G and B), in place. */
export function greyInPlace(page: Pixels): void {
  const d = page.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = luma(d[i], d[i + 1], d[i + 2]);
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }
}

/** The page's luma as one byte per pixel. */
export function greyOf(page: Pixels): Uint8Array {
  const d = page.data, out = new Uint8Array(page.width * page.height);
  for (let i = 0, j = 0; j < out.length; i += 4, j++) out[j] = luma(d[i], d[i + 1], d[i + 2]);
  return out;
}

/** On the flattened page (paper 255), a pixel darker than this is ink whatever is around it: under half the paper's brightness before the stretch. */
const INK = 100;

export interface ThresholdOptions {
  /** Side of the square the local mean is taken over, in pixels (default: 1/16 of the width). */
  window?: number;
  /** A pixel is ink when at most (1 − t) × the local mean. */
  t?: number;
  /** A pixel darker than this is ink in any case (default INK; 0 for Bradley's threshold alone). */
  ink?: number;
}

/**
 * Black and white by Bradley and Roth's adaptive threshold, as 1-bit rows (each row padded to
 * whole bytes, bit 1 = white, padding white), with an absolute one beside it: a pixel is ink
 * when it is at most (1 − t) × the mean around it, as Bradley has it (so a pixel as dark as all
 * its window, 0 in a black area, is ink), or darker than `ink` on the flattened page. The local
 * test alone hollows out anything dark and wider than the window (1/16 of the page, 13 mm): a
 * pixel inside it is no darker than its surroundings, so a black bar, a redaction box or a dark
 * photo came out as an outline with white or speckled insides. The mean around each pixel comes
 * from running sums: a column sum per x over the window's rows, moved one row at a time, and a
 * running sum of those along the row, so the extra memory is one Uint32Array as wide as the page.
 */
export function threshold(grey: Uint8Array, width: number, height: number, { window, t = 0.15, ink = INK }: ThresholdOptions = {}): Uint8Array {
  const r = Math.max(1, Math.round(window ?? width / 16)) >> 1;
  const rowBytes = (width + 7) >> 3;
  const bits = new Uint8Array(rowBytes * height);
  const columns = new Uint32Array(width);
  const add = (y: number, sign: 1 | -1) => {
    for (let x = 0, i = y * width; x < width; x++, i++) columns[x] += sign * grey[i];
  };
  for (let y = 0; y <= Math.min(height - 1, r); y++) add(y, 1);
  const keep = 1 - t;
  const pad = rowBytes * 8 - width;
  for (let y = 0; y < height; y++) {
    if (y > 0) {
      if (y + r < height) add(y + r, 1);
      if (y - r - 1 >= 0) add(y - r - 1, -1);
    }
    const rowsIn = Math.min(height, y + r + 1) - Math.max(0, y - r);
    let sum = 0;
    for (let x = 0; x <= Math.min(width - 1, r); x++) sum += columns[x];
    const o = y * rowBytes, g = y * width;
    for (let x = 0; x < width; x++) {
      if (x > 0) {
        if (x + r < width) sum += columns[x + r];
        if (x - r - 1 >= 0) sum -= columns[x - r - 1];
      }
      const n = (Math.min(width, x + r + 1) - Math.max(0, x - r)) * rowsIn;
      const v = grey[g + x];
      if (v >= ink && v * n > sum * keep) bits[o + (x >> 3)] |= 0x80 >> (x & 7);
    }
    if (pad) bits[o + rowBytes - 1] |= (1 << pad) - 1;
  }
  return bits;
}
