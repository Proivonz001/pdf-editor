// From a photo and the sheet's corners to a page: straightened at the page's size (warp.ts),
// cleaned up by the chosen mode (enhance.ts), and the small preview the tray shows. Pure and
// synchronous, so the tests run it in Node; encoding (JPEG through a canvas, the 1-bit PNG) is
// the scan worker's next step (scanJobs.ts).
//
// Time in Node from a 3500 px working photo (scan.test.ts prints it): Originale about 90 ms,
// Documento and Grigio about 210 ms (A4 at 200 dpi), Bianco e nero about 520 ms (A4 at 300 dpi,
// 8.7 MP), the preview 25–45 ms, the 1-bit PNG under 30 ms. Phones: about 2–4 times that, so a
// B/N page takes one or two seconds, with the scan flow's progress shown meanwhile.
import { flattenLight, greyInPlace, greyOf, threshold } from "./enhance";
import { clampCorners, cornersUsable, fitSide, MODE_SETTINGS, pageSize, PREVIEW_SIDE, sheetAspect } from "./sizes";
import { ScanError, type Corners, type PageShape, type Pixels, type ScanMode } from "./types";
import { warp } from "./warp";

/** A page ready to encode: RGBA for a JPEG (with its quality), or 1-bit rows for the black-and-white PNG. */
export type RenderedPage =
  | { kind: "jpeg"; pixels: Pixels; quality: number; dpi: number }
  | { kind: "bw"; bits: Uint8Array; width: number; height: number; dpi: number };

const MODES: readonly ScanMode[] = ["document", "grey", "bw", "original"];
const SHAPES: readonly PageShape[] = ["a4", "photo"];

/**
 * The page for the sheet at `corners` in `photo`: its size from the page shape and the mode's
 * resolution (sizes.ts), then the mode's clean-up. Throws ScanError("failed") when the corners
 * do not make a sheet (crossed, outside the photo, too small) or the mode or shape is unknown.
 */
export function renderPage(photo: Pixels, corners: Corners, mode: ScanMode, shape: PageShape): RenderedPage {
  if (!MODES.includes(mode) || !SHAPES.includes(shape)) throw new ScanError(`Unknown scan mode or page shape: ${mode}, ${shape}`, "failed");
  if (!cornersUsable(corners, photo.width, photo.height)) throw new ScanError("The corners do not make a sheet", "failed");
  const sheet = clampCorners(corners, photo.width, photo.height);
  const { dpi, quality } = MODE_SETTINGS[mode];
  const { width, height } = pageSize(sheetAspect(sheet, photo.width, photo.height), shape, dpi);
  if (mode === "bw") return { kind: "bw", bits: threshold(flattenedGrey(photo, sheet, width, height), width, height), width, height, dpi };
  const page = warp(photo, sheet, width, height);
  if (mode !== "original") flattenLight(page);
  if (mode === "grey") greyInPlace(page);
  return { kind: "jpeg", pixels: page, quality: quality!, dpi };
}

/**
 * The flattened page's grey, for black and white. Its own function so that the RGBA page (35 MB
 * at 300 dpi) is no longer referenced once the grey is taken: only the grey (9 MB) and the bits
 * remain while the threshold and the PNG are made.
 */
function flattenedGrey(photo: Pixels, sheet: Corners, width: number, height: number): Uint8Array {
  const page = warp(photo, sheet, width, height);
  flattenLight(page);
  return greyOf(page);
}

/** `src` (RGBA) scaled down by a box filter so its longer side is at most `maxSide`. */
export function shrinkPixels(src: Pixels, maxSide: number): Pixels {
  const { width: W, height: H, data } = src;
  const { width: w, height: h } = fitSide(W, H, maxSide);
  const sx = W / w, sy = H / h;
  const sums = new Float32Array(w * h * 3);
  const column = new Int32Array(W);
  const perColumn = new Float32Array(w), perRow = new Float32Array(h);
  for (let x = 0; x < W; x++) perColumn[(column[x] = Math.min(w - 1, Math.floor(x / sx)))]++;
  for (let y = 0; y < H; y++) {
    const r = Math.min(h - 1, Math.floor(y / sy));
    perRow[r]++;
    for (let x = 0, i = y * W * 4; x < W; x++, i += 4) {
      const o = (r * w + column[x]) * 3;
      sums[o] += data[i];
      sums[o + 1] += data[i + 1];
      sums[o + 2] += data[i + 2];
    }
  }
  const out = new Uint8ClampedArray(w * h * 4);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const n = perRow[r] * perColumn[c], o = (r * w + c) * 3, p = (r * w + c) * 4;
      out[p] = sums[o] / n;
      out[p + 1] = sums[o + 1] / n;
      out[p + 2] = sums[o + 2] / n;
      out[p + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

/** 1-bit rows (bit 1 = white) scaled down to grey RGBA, longer side at most `maxSide`. */
function shrinkBits(bits: Uint8Array, W: number, H: number, maxSide: number): Pixels {
  const { width: w, height: h } = fitSide(W, H, maxSide);
  const sx = W / w, sy = H / h, rowBytes = (W + 7) >> 3;
  const sums = new Float32Array(w * h);
  const column = new Int32Array(W);
  const perColumn = new Float32Array(w), perRow = new Float32Array(h);
  for (let x = 0; x < W; x++) perColumn[(column[x] = Math.min(w - 1, Math.floor(x / sx)))]++;
  for (let y = 0; y < H; y++) {
    const r = Math.min(h - 1, Math.floor(y / sy));
    perRow[r]++;
    for (let x = 0, o = y * rowBytes; x < W; x++) if (bits[o + (x >> 3)] & (0x80 >> (x & 7))) sums[r * w + column[x]] += 255;
  }
  const out = new Uint8ClampedArray(w * h * 4);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const v = sums[r * w + c] / (perRow[r] * perColumn[c]), p = (r * w + c) * 4;
      out[p] = out[p + 1] = out[p + 2] = v;
      out[p + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

/** The tray's preview of a page: at most PREVIEW_SIDE pixels on its longer side, RGBA. */
export function previewOf(page: RenderedPage): Pixels {
  return page.kind === "jpeg"
    ? shrinkPixels(page.pixels, PREVIEW_SIDE)
    : shrinkBits(page.bits, page.width, page.height, PREVIEW_SIDE);
}
