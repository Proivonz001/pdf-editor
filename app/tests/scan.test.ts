// The scan pipeline (release 4, "Foto e scansione", src/scan/), in Node:
// - finding the sheet in synthetic phone photos (ported from the research's synthPhoto: a real
//   page rendered by MuPDF, put in perspective on wood, a grey desk or a white table, with a
//   light gradient, a soft shadow, sensor noise, clutter, blur and JPEG), the corner error, and
//   the low-confidence fallback (a checked tablecloth, paper on an almost-white table); a dark
//   band or frame printed near the paper's edge is not taken for it (fix round 1), nor with a
//   thin margin, a perspective or a side half on the frame, and is never a confident wrong
//   answer (fix round 2), while shadows, curls and clutter near a right side leave it there, and
//   a pen, a ruler, a laptop or a shadow on a white table 15–27 mm beyond a side does not pull
//   the side onto it (fix round 3);
// - the warp's corner order, the homography, the sheet's proportions from a real camera
//   projection, the page sizes, the corner order and checks;
// - the modes' clean-up (paper becomes white, ink stays dark, grey is grey, B/N is 1 bit; solid
//   black areas stay black in B/N, grey pictures keep their tones, fix round 1);
// - the 1-bit PNG read back exactly by MuPDF (compressed and stored) and placed by the engine;
// - the scan worker's requests (scanJobs.ts), and the main-thread client (scanClient.ts) with a
//   fake worker and fake canvases: decoding, processing, the fallbacks, disposing, a transparent
//   picture put on white.
// Timings are printed (Node; phones run plain JavaScript about 2–4 times slower).
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import * as mupdf from "mupdf";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { checkPicture } from "../src/engine/images";
import { EngineSession } from "../src/engine/session";
import { detectSheet, FOUND_CONFIDENCE, orderCorners } from "../src/scan/detect";
import { encodeJpeg } from "../src/scan/encode";
import { flattenLight, greyOf, threshold } from "../src/scan/enhance";
import { previewOf, renderPage } from "../src/scan/pipeline";
import { adler32, crc32, png1, zlib, zlibStored } from "../src/scan/png1";
import { forgetKept, replyTo, runScanRequest } from "../src/scan/scanJobs";
import {
  clampCorners, cornersUsable, MODE_SETTINGS, pageSize, PREVIEW_SIDE, sheetAspect, WORKING_SIDE, wholeFrame,
} from "../src/scan/sizes";
import { ScanError, type Corners, type Pixels, type Point, type ProcessReply } from "../src/scan/types";
import { applyHomography, homography, warp } from "../src/scan/warp";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const ms = (t: number) => `${(performance.now() - t).toFixed(0)} ms`;

// ---------------------------------------------------------------------------------------------
// Pixels to and from MuPDF (tests only: the pipeline itself never uses MuPDF)

function pixmapPixels(pix: mupdf.Pixmap): Pixels {
  const w = pix.getWidth(), h = pix.getHeight(), n = pix.getNumberOfComponents() + (pix.getAlpha() ? 1 : 0), stride = pix.getStride();
  const out = new Uint8ClampedArray(w * h * 4);
  const src = pix.getPixels();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = y * stride + x * n, t = (y * w + x) * 4;
      if (n >= 3) { out[t] = src[s]; out[t + 1] = src[s + 1]; out[t + 2] = src[s + 2]; } else out[t] = out[t + 1] = out[t + 2] = src[s];
      out[t + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

/** Page 0 of a fixture rendered `height` pixels tall. */
function renderFixture(name: string, height: number): Pixels {
  const doc = mupdf.Document.openDocument(fixture(name), "application/pdf");
  try {
    const page = doc.loadPage(0);
    try {
      const b = page.getBounds(), s = height / (b[3] - b[1]);
      const pix = page.toPixmap([s, 0, 0, s, 0, 0], mupdf.ColorSpace.DeviceRGB, false, true);
      try {
        return pixmapPixels(pix);
      } finally {
        pix.destroy();
      }
    } finally {
      page.destroy();
    }
  } finally {
    doc.destroy();
  }
}

/** A picture's bytes decoded by MuPDF. */
function decoded(bytes: Uint8Array): { pixels: Pixels; components: number; xres: number } {
  const image = new mupdf.Image(bytes);
  try {
    const pix = image.toPixmap();
    try {
      return { pixels: pixmapPixels(pix), components: pix.getNumberOfComponents(), xres: image.getXResolution() };
    } finally {
      pix.destroy();
    }
  } finally {
    image.destroy();
  }
}

/** Through a JPEG at quality `q` and back (camera compression). */
function jpegRoundTrip(p: Pixels, q: number): Pixels {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, p.width, p.height], false);
  try {
    const view = pix.getPixels(), stride = pix.getStride();
    for (let y = 0; y < p.height; y++) {
      for (let x = 0; x < p.width; x++) {
        const s = (y * p.width + x) * 4, t = y * stride + x * 3;
        view[t] = p.data[s]; view[t + 1] = p.data[s + 1]; view[t + 2] = p.data[s + 2];
      }
    }
    return decoded(pix.asJPEG(q)).pixels;
  } finally {
    pix.destroy();
  }
}

// ---------------------------------------------------------------------------------------------
// Synthetic phone photos (ported from the research's lib.mjs synthPhoto)

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

function valueNoise(w: number, h: number, cell: number, rand: () => number) {
  const gw = Math.ceil(w / cell) + 2, gh = Math.ceil(h / cell) + 2;
  const g = new Float32Array(gw * gh).map(() => rand());
  return (x: number, y: number) => {
    const fx = x / cell, fy = y / cell, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    const a = g[y0 * gw + x0], b = g[y0 * gw + x0 + 1], c = g[(y0 + 1) * gw + x0], d = g[(y0 + 1) * gw + x0 + 1];
    return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
  };
}

function bilinear(p: Pixels, x: number, y: number, out: number[]) {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const xa = Math.min(Math.max(x0, 0), p.width - 1), xb = Math.min(Math.max(x0 + 1, 0), p.width - 1);
  const ya = Math.min(Math.max(y0, 0), p.height - 1), yb = Math.min(Math.max(y0 + 1, 0), p.height - 1);
  for (let c = 0; c < 3; c++) {
    const a = p.data[(ya * p.width + xa) * 4 + c], b = p.data[(ya * p.width + xb) * 4 + c];
    const e = p.data[(yb * p.width + xa) * 4 + c], f = p.data[(yb * p.width + xb) * 4 + c];
    out[c] = (a * (1 - fx) + b * fx) * (1 - fy) + (e * (1 - fx) + f * fx) * fy;
  }
}

const insideQuad = (q: Corners, x: number, y: number) => {
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = q[i], [bx, by] = q[(i + 1) % 4];
    if ((bx - ax) * (y - ay) - (by - ay) * (x - ax) < 0) return false;
  }
  return true;
};

type Background = "wood" | "desk" | "white";

/**
 * A W × H photo of `paper` with its corners at `quad` (TL TR BR BL, pixel-centre coordinates):
 * a background, a warm paper tint with the ink lifted, light brighter at the top left, a soft
 * shadow at the bottom left (a hand, a phone), sensor noise.
 */
function synthPhoto(paper: Pixels, W: number, H: number, quad: Corners, { bg = "wood" as Background, shadow = true, seed = 1, flat = false } = {}): Pixels {
  const rand = rng(seed), n1 = valueNoise(W, H, 90, rand), n2 = valueNoise(W, H, 7, rand);
  const toPaper = homography(quad, [[0, 0], [paper.width, 0], [paper.width, paper.height], [0, paper.height]])!;
  const data = new Uint8ClampedArray(W * H * 4);
  const tmp = [0, 0, 0];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const t = (y * W + x) * 4, cx = x + 0.5, cy = y + 0.5;
      let light = flat ? 1 : 1 - 0.25 * ((x / W) * 0.4 + (y / H) * 0.6);
      if (shadow) {
        const dx = (x - W * 0.25) / (W * 0.35), dy = (y - H * 0.85) / (H * 0.25);
        light *= 1 - 0.35 * Math.max(0, Math.min(1, 1.3 - Math.hypot(dx, dy)));
      }
      let r: number, g: number, b: number;
      if (insideQuad(quad, cx, cy)) {
        const [px, py] = applyHomography(toPaper, cx, cy);
        bilinear(paper, px - 0.5, py - 0.5, tmp);
        r = 18 + (tmp[0] * (238 - 18)) / 255; g = 18 + (tmp[1] * (232 - 18)) / 255; b = 22 + (tmp[2] * (220 - 22)) / 255;
      } else if (bg === "wood") {
        const v = n1(x * 0.3, y * 3) * 0.6 + n2(x, y) * 0.4;
        r = 95 + 60 * v; g = 60 + 40 * v; b = 35 + 25 * v;
      } else if (bg === "desk") {
        const v = n2(x, y);
        r = g = 150 + 25 * v; b = r + 8;
      } else {
        const v = n2(x, y);
        r = g = 205 + 15 * v; b = 200 + 15 * v;
      }
      const noise = flat ? 0 : (rand() - 0.5) * 10;
      data[t] = r * light + noise; data[t + 1] = g * light + noise; data[t + 2] = b * light + noise; data[t + 3] = 255;
    }
  }
  return { width: W, height: H, data };
}

function paint(p: Pixels, colour: (x: number, y: number) => number[] | null) {
  for (let y = 0; y < p.height; y++) {
    for (let x = 0; x < p.width; x++) {
      const c = colour(x, y);
      if (c) p.data.set([c[0], c[1], c[2], 255], (y * p.width + x) * 4);
    }
  }
}

function boxBlur(p: Pixels, r: number): Pixels {
  const { width: w, height: h } = p, out = new Uint8ClampedArray(p.data.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s0 = 0, s1 = 0, s2 = 0, n = 0;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const t = (Math.min(h - 1, Math.max(0, y + dy)) * w + Math.min(w - 1, Math.max(0, x + dx))) * 4;
          s0 += p.data[t]; s1 += p.data[t + 1]; s2 += p.data[t + 2]; n++;
        }
      }
      const t = (y * w + x) * 4;
      out[t] = s0 / n; out[t + 1] = s1 / n; out[t + 2] = s2 / n; out[t + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

// The research's photos were 1512 × 2016; these are 900 × 1200, the quads scaled to match.
const PW = 900, PH = 1200, K = PW / 1512;
const scaled = (q: number[][]): Corners => q.map(([x, y]) => [x * K, y * K]) as Corners;
const BASE = scaled([[200, 180], [1320, 230], [1290, 1840], [170, 1790]]);
/** `q` scaled by `s` and turned by `deg` (clockwise on screen) about the photo's centre. */
const around = (q: Corners, s: number, deg: number): Corners => {
  const a = (deg * Math.PI) / 180, cx = PW / 2, cy = PH / 2;
  return q.map(([x, y]) => {
    const dx = (x - cx) * s, dy = (y - cy) * s;
    return [cx + dx * Math.cos(a) - dy * Math.sin(a), cy + dx * Math.sin(a) + dy * Math.cos(a)];
  }) as Corners;
};

const pages = {
  word: () => renderFixture("word-winansi.pdf", 1000),
  form: () => renderFixture("reportlab-form.pdf", 1000),
  chrome: () => renderFixture("chrome-images.pdf", 1000),
};
const paperCache = new Map<keyof typeof pages, Pixels>();
const paperOf = (k: keyof typeof pages) => {
  if (!paperCache.has(k)) paperCache.set(k, pages[k]());
  return paperCache.get(k)!;
};

interface Case {
  label: string;
  paper: keyof typeof pages;
  quad: Corners;
  bg: Background;
  post?: (p: Pixels) => Pixels | void;
}

const GOOD: Case[] = [
  { label: "word on dark wood, shadow", paper: "word", quad: BASE, bg: "wood" },
  { label: "word on a grey desk, shadow", paper: "word", quad: BASE, bg: "desk" },
  { label: "word on a white table (low contrast)", paper: "word", quad: BASE, bg: "white" },
  { label: "form on wood, turned 12°", paper: "form", quad: around(BASE, 0.9, 12), bg: "wood" },
  { label: "word, strong perspective", paper: "word", quad: scaled([[380, 300], [1150, 320], [1420, 1900], [90, 1880]]), bg: "desk" },
  { label: "word, a corner cut by the frame", paper: "word", quad: scaled([[-80, 150], [1320, 230], [1290, 1840], [170, 1790]]), bg: "wood" },
  { label: "colour page with photos on a desk", paper: "chrome", quad: BASE, bg: "desk" },
  { label: "word filling almost the whole frame", paper: "word", quad: scaled([[40, 40], [1480, 60], [1470, 1980], [30, 1960]]), bg: "wood" },
  {
    label: "clutter: a dark phone and a table edge", paper: "word", quad: BASE, bg: "desk",
    post: (p) => {
      paint(p, (x, y) => (x > 1150 * K && x < 1480 * K && y > 1650 * K ? [30, 30, 35] : null));
      paint(p, (x, y) => (Math.abs(y - (60 + x * 0.05) * K) < 4 * K ? [70, 60, 50] : null));
    },
  },
  { label: "defocus blur and JPEG q70", paper: "word", quad: BASE, bg: "desk", post: (p) => jpegRoundTrip(boxBlur(p, 2), 70) },
  {
    label: "a thumb over the left edge", paper: "word", quad: BASE, bg: "wood",
    post: (p) => paint(p, (x, y) => (((x - 160 * K) / (110 * K)) ** 2 + ((y - 1000 * K) / (180 * K)) ** 2 < 1 ? [205, 150, 125] : null)),
  },
  { label: "turned 35° clockwise", paper: "word", quad: around(BASE, 0.65, 35), bg: "wood" },
  { label: "turned 35° anticlockwise", paper: "form", quad: around(BASE, 0.65, -35), bg: "desk" },
  { label: "a landscape sheet", paper: "form", quad: [[90, 330], [820, 300], [835, 840], [70, 870]], bg: "wood" },
];

const HARD: Case[] = [
  {
    label: "checked tablecloth", paper: "word", quad: BASE, bg: "desk",
    post: (p) => paint(p, (x, y) => (insideQuad(BASE, x + 0.5, y + 0.5) ? null : (Math.floor(x / 36) + Math.floor(y / 36)) % 2 ? [200, 40, 40] : [235, 235, 235])),
  },
  {
    label: "paper on an almost-white table (230 against 238)", paper: "word", quad: BASE, bg: "white",
    post: (p) => paint(p, (x, y) => {
      if (insideQuad(BASE, x + 0.5, y + 0.5)) return null;
      const l = 1 - 0.25 * ((x / PW) * 0.4 + (y / PH) * 0.6);
      return [230 * l, 229 * l, 226 * l];
    }),
  },
];

function photoOf(c: Case, seed = 7): Pixels {
  const p = synthPhoto(paperOf(c.paper), PW, PH, c.quad, { bg: c.bg, seed });
  return (c.post?.(p) as Pixels | undefined) ?? p;
}

const cornerError = (a: Corners, b: Corners) => Math.max(...a.map((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1])));

// ---------------------------------------------------------------------------------------------

describe("detectSheet on synthetic photos", () => {
  it.each(GOOD)("$label: corners within 3 px at 1200 px, confident", (c) => {
    const photo = photoOf(c);
    const t = performance.now();
    const found = detectSheet(photo);
    const time = ms(t);
    expect(found.corners).not.toBeNull();
    const truth = clampCorners(c.quad, PW, PH);
    const error = cornerError(found.corners!, truth);
    console.log(`${c.label.padEnd(44)} ${time.padStart(7)}  error ${error.toFixed(2)} px  confidence ${found.confidence.toFixed(2)}  sides ${found.sides.map((s) => s.toFixed(2)).join(" ")}`);
    expect(error).toBeLessThanOrEqual(3);
    expect(found.confidence).toBeGreaterThanOrEqual(FOUND_CONFIDENCE);
    for (const [x, y] of found.corners!) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(PW);
      expect(y).toBeLessThanOrEqual(PH);
    }
  });

  it.each(HARD)("$label: not trusted, so the whole frame is used", async (c) => {
    const photo = photoOf(c);
    const t = performance.now();
    const found = detectSheet(photo);
    console.log(`${c.label.padEnd(44)} ${ms(t).padStart(7)}  confidence ${found.confidence.toFixed(2)}  ${found.corners ? `error ${cornerError(found.corners, c.quad).toFixed(1)} px` : "not found"}`);
    expect(found.confidence).toBeLessThan(FOUND_CONFIDENCE);
    forgetKept();
    const [reply] = await runScanRequest({ op: "analysePixels", photo: 1, pixels: photoOf(c) });
    expect(reply).toMatchObject({ corners: wholeFrame(PW, PH), width: PW, height: PH, image: null });
  });

  it("stays quick on a striped background, where many lines pass the filters", () => {
    const photo = synthPhoto(paperOf("word"), PW, PH, BASE, { bg: "desk", seed: 4 });
    paint(photo, (x, y) => (insideQuad(BASE, x + 0.5, y + 0.5) ? null : Math.floor((x + y * 0.3) / 14) % 2 ? [40, 40, 40] : [225, 225, 225]));
    paint(photo, (x, y) => (insideQuad(BASE, x + 0.5, y + 0.5) || Math.floor((y - x * 0.25) / 20) % 3 ? null : [90, 90, 90]));
    const t = performance.now();
    const found = detectSheet(photo);
    const time = performance.now() - t;
    console.log(`striped background: ${time.toFixed(0)} ms, confidence ${found.confidence.toFixed(2)}${found.corners ? `, error ${cornerError(found.corners, BASE).toFixed(1)} px` : ""}`);
    expect(time).toBeLessThan(1000);
    // Either the sheet is found, or the corners are not trusted: never a confident wrong answer.
    if (found.confidence >= FOUND_CONFIDENCE) expect(cornerError(found.corners!, BASE)).toBeLessThanOrEqual(3);
  });

  // Fix round 1 (review finding P20): a dark band, a printed frame or a grey frame within about a
  // centimetre of the paper's edge (letterheads, certificates, forms). Its inner edge is bright
  // inside and dark outside, with far more contrast than the paper against the desk, so it took
  // the side, with full confidence, and the margin outside it was cut off.
  describe("a dark band or frame printed near the sheet's edge", () => {
    /** The word page with `mark` painted on a copy of it (page pixels, 708 × 1000). */
    const marked = (mark: (x: number, y: number, w: number, h: number) => number[] | null): Pixels => {
      const src = paperOf("word"), p = { ...src, data: src.data.slice() };
      paint(p, (x, y) => mark(x, y, p.width, p.height));
      return p;
    };
    const band = (top: number, tall: number, v: number) => (_x: number, y: number) => (y >= top && y < top + tall ? [v, v, v] : null);
    const frame = (inset: number, thick: number, v: number) => (x: number, y: number, w: number, h: number) => {
      const d = Math.min(x - inset, y - inset, w - 1 - inset - x, h - 1 - inset - y);
      return d >= 0 && d < thick ? [v, v, v] : null;
    };
    const cases: { label: string; paper: () => Pixels; bg: Background; quad?: Corners }[] = [];
    for (const bg of ["desk", "white", "wood"] as Background[]) {
      cases.push({ label: `a black band 9 mm from the top, on ${bg}`, paper: () => marked(band(30, 30, 0)), bg });
      cases.push({ label: `a black frame inset 9 mm, on ${bg}`, paper: () => marked(frame(30, 12, 0)), bg });
      cases.push({ label: `a grey frame (120) inset 9 mm, on ${bg}`, paper: () => marked(frame(30, 12, 120)), bg });
      cases.push({ label: `a grey band (120) 5 mm from the top, on ${bg}`, paper: () => marked(band(16, 40, 120)), bg });
    }
    cases.push({ label: "a black frame inset 6 mm, turned 12°, on desk", paper: () => marked(frame(20, 10, 0)), bg: "desk", quad: around(BASE, 0.9, 12) });
    cases.push({
      label: "a dark band 4 mm from the top, strong perspective, on white", paper: () => marked(band(12, 50, 40)), bg: "white",
      quad: scaled([[380, 300], [1150, 320], [1420, 1900], [90, 1880]]),
    });
    it.each(cases)("$label: the sheet's own edge, not the band's", ({ paper, bg, quad = BASE }) => {
      const photo = synthPhoto(paper(), PW, PH, quad, { bg, seed: 7 });
      const t = performance.now();
      const found = detectSheet(photo);
      const error = found.corners ? cornerError(found.corners, quad) : Infinity;
      console.log(`${ms(t).padStart(7)}  error ${error.toFixed(2)} px  confidence ${found.confidence.toFixed(2)}  sides ${found.sides.map((s) => s.toFixed(2)).join(" ")}`);
      expect(error).toBeLessThanOrEqual(3);
      expect(found.confidence).toBeGreaterThanOrEqual(FOUND_CONFIDENCE);
    });

    // Fix round 2 (P20 left over): the cases the check of fix round 1 found still taken with full
    // confidence. A thin margin outside the band (2 mm on a landscape sheet or at the far end of a
    // strong perspective: about 4 photo pixels), a side that ran from the paper's corner onto the
    // frame, a black frame on wood (14–28 px off, confidence 1.00, before). The side is now the
    // outermost edge with paper inside it and something darker just outside.
    const LAND: Corners = [[90, 330], [820, 300], [835, 840], [70, 870]];
    const PERSP = scaled([[380, 300], [1150, 320], [1420, 1900], [90, 1880]]);
    const checked: { label: string; paper: () => Pixels; bg: Background; quad: Corners; seed: number }[] = [
      ...(["desk", "white", "wood"] as Background[]).map((bg) => ({ label: `a black band 2 mm from the top of a landscape sheet, on ${bg}`, paper: () => marked(band(8, 30, 0)), bg, quad: LAND, seed: 3 })),
      { label: "a black band 2 mm from the top, strong perspective, on desk", paper: () => marked(band(8, 30, 0)), bg: "desk", quad: PERSP, seed: 3 },
      { label: "a black frame 2 mm in, a landscape sheet on desk", paper: () => marked(frame(8, 12, 0)), bg: "desk", quad: LAND, seed: 3 },
      ...[3, 7, 11].map((seed) => ({ label: `a black frame 5 mm in, on wood (seed ${seed})`, paper: () => marked(frame(16, 12, 0)), bg: "wood" as Background, quad: BASE, seed })),
      { label: "a grey frame (90) 5 mm in, on white", paper: () => marked(frame(16, 12, 90)), bg: "white", quad: BASE, seed: 3 },
      { label: "a black frame 5 mm in, a landscape sheet on desk (every side first on the frame)", paper: () => marked(frame(16, 12, 0)), bg: "desk", quad: LAND, seed: 3 },
    ];
    it.each(checked)("$label: the sheet's own edge", ({ paper, bg, quad, seed }) => {
      const found = detectSheet(synthPhoto(paper(), PW, PH, quad, { bg, seed }));
      const error = found.corners ? cornerError(found.corners, quad) : Infinity;
      console.log(`error ${error.toFixed(2)} px  confidence ${found.confidence.toFixed(2)}  sides ${found.sides.map((s) => s.toFixed(2)).join(" ")}`);
      expect(error).toBeLessThanOrEqual(3);
      expect(found.confidence).toBeGreaterThanOrEqual(FOUND_CONFIDENCE);
    });

    // A frame 9 mm in on a white table, where the quadrilateral found first has its top on the
    // text block 4–5 cm in: farther than a side is moved (BEYOND), so the corners stay wrong, but
    // the lines along the frame and the paper's edge beyond that side make it unsure (152 px off
    // with confidence 0.90, and 139 px at 0.55 turned on a desk, before).
    const unsure: { label: string; paper: () => Pixels; bg: Background; quad: Corners }[] = [60, 90, 120, 150].map((v) => (
      { label: `a grey frame (${v}) 9 mm in, on white`, paper: () => marked(frame(30, 12, v)), bg: "white" as Background, quad: BASE }
    ));
    unsure.push({ label: "a grey frame (90) 9 mm in, turned 12°, on desk", paper: () => marked(frame(30, 12, 90)), bg: "desk", quad: around(BASE, 0.9, 12) });
    it.each(unsure)("$label: right, or not trusted", ({ paper, bg, quad }) => {
      const found = detectSheet(synthPhoto(paper(), PW, PH, quad, { bg, seed: 3 }));
      const error = found.corners ? cornerError(found.corners, quad) : Infinity;
      console.log(`error ${error.toFixed(2)} px  confidence ${found.confidence.toFixed(2)}  sides ${found.sides.map((s) => s.toFixed(2)).join(" ")}`);
      if (found.confidence >= FOUND_CONFIDENCE) expect(error).toBeLessThanOrEqual(3);
    });

    // The check's sweep in small: bands and frames 2–7 mm in, five poses, three backgrounds.
    it("five poses, three backgrounds, bands and frames 2–7 mm in: never a confident wrong corner", () => {
      const poses: Record<string, Corners> = { upright: BASE, "turned 12°": around(BASE, 0.9, 12), "turned −20°": around(BASE, 0.8, -20), "strong perspective": PERSP, landscape: LAND };
      const marks: Record<string, ReturnType<typeof frame>> = {
        "black band 2 mm in": band(8, 30, 0), "grey frame (90) 2 mm in": frame(8, 12, 90), "grey frame (90) 5 mm in": frame(16, 12, 90),
        "light frame (150) 5 mm in": frame(16, 12, 150), "black frame 7 mm in": frame(24, 12, 0),
      };
      let right = 0, unsure = 0;
      const wrong: string[] = [];
      const t = performance.now();
      for (const [pose, quad] of Object.entries(poses)) {
        for (const bg of ["desk", "white", "wood"] as Background[]) {
          for (const [mark, draw] of Object.entries(marks)) {
            const found = detectSheet(synthPhoto(marked(draw), PW, PH, quad, { bg, seed: 3 }));
            const error = found.corners ? cornerError(found.corners, quad) : Infinity;
            if (found.confidence < FOUND_CONFIDENCE) unsure++;
            else if (error <= 3) right++;
            else wrong.push(`${pose}, ${bg}, ${mark}: ${error.toFixed(1)} px at ${found.confidence.toFixed(2)}`);
          }
        }
      }
      // Before fix round 2: 58 right, 1 not trusted, 16 wrong with confidence 0.84–1.00.
      console.log(`75 photos in ${ms(t)}: ${right} right, ${unsure} not trusted, ${wrong.length} confidently wrong`);
      expect(wrong).toEqual([]);
      expect(right).toBeGreaterThanOrEqual(70);
    }, 120_000);

    // What must not move a side that is right: something dark beyond it, then something bright;
    // and, since fix round 2 also looks inside a side, a shadow or a curl darkening the paper's
    // outer strip (a shadow's edge or the shading would be taken for the side), and another sheet
    // beyond part of the side.
    /** Signed distance of (x, y) beyond BASE's side `i` (0 top, 1 right, 2 bottom, 3 left; positive outside the sheet). */
    const beyond = (i: number, x: number, y: number) => {
      const [ax, ay] = BASE[i], [bx, by] = BASE[(i + 1) % 4], len = Math.hypot(bx - ax, by - ay);
      return ((bx - ax) * (ay - y) - (by - ay) * (ax - x)) / len;
    };
    const aboveTop = (x: number, y: number) => beyond(0, x, y);
    /** The photo's light multiplied by `light(x, y)`. */
    const shade = (light: (x: number, y: number) => number) => (p: Pixels) => {
      for (let y = 0, t = 0; y < p.height; y++) {
        for (let x = 0; x < p.width; x++, t += 4) {
          const f = light(x + 0.5, y + 0.5);
          p.data[t] *= f; p.data[t + 1] *= f; p.data[t + 2] *= f;
        }
      }
    };
    const near: { label: string; bg: Background; post: (p: Pixels) => void }[] = [
      {
        label: "a shadow over the outer 30 px of the left side (55 % of the light), on a desk", bg: "desk",
        post: shade((x, y) => 1 - 0.45 * Math.max(0, Math.min(1, (beyond(3, x, y) + 30) / 6 + 0.5))),
      },
      {
        label: "a curled bottom edge, its last 30 px up to 30 % darker, on wood", bg: "wood",
        post: shade((x, y) => {
          const d = beyond(2, x, y);
          return d > -30 && d < 0 ? 1 - 0.3 * (1 + d / 30) : 1;
        }),
      },
      {
        label: "another sheet 20 px above the right half of the top side, on a desk", bg: "desk",
        post: (p) => paint(p, (x, y) => (aboveTop(x + 0.5, y + 0.5) > 20 && aboveTop(x + 0.5, y + 0.5) < 200 && x > 450 ? [236, 230, 218] : null)),
      },
      {
        label: "a dark ruler against the top edge, on a white table", bg: "white",
        post: (p) => paint(p, (x, y) => (aboveTop(x + 0.5, y + 0.5) > 0 && aboveTop(x + 0.5, y + 0.5) < 25 && x > 150 && x < 780 ? [40, 40, 45] : null)),
      },
      {
        label: "on a dark mat whose edge is just above the sheet, a white table beyond", bg: "wood",
        post: (p) => paint(p, (x, y) => (aboveTop(x + 0.5, y + 0.5) > 45 ? [214, 214, 208] : null)),
      },
    ];
    it.each(near)("$label: the side stays", ({ bg, post }) => {
      const photo = synthPhoto(paperOf("word"), PW, PH, BASE, { bg, seed: 7 });
      post(photo);
      const found = detectSheet(photo);
      const error = found.corners ? cornerError(found.corners, BASE) : Infinity;
      console.log(`error ${error.toFixed(2)} px  confidence ${found.confidence.toFixed(2)}  sides ${found.sides.map((s) => s.toFixed(2)).join(" ")}`);
      expect(error).toBeLessThanOrEqual(3);
      expect(found.confidence).toBeGreaterThanOrEqual(FOUND_CONFIDENCE);
    });

    // Fix round 3 (the check of fix round 2): a dark thing lying along a side 15–27 mm beyond it on
    // a white table. The table is about 0.91 of the paper's brightness, so fix round 2 took it for
    // the paper's margin and moved the side onto the thing's edge, with full confidence, in 60 of
    // the 106 photos of the check's sweep that fix round 1 got right (60 px off at 1.00 for the pen
    // below, 0.86 px in fix round 1). A move outwards now needs the paper's own margin: as bright
    // as the paper inside, past the band the side lay on.
    const T12 = around(BASE, 0.9, 12);
    /** Signed distance of (x, y) beyond side `i` of `q`, and how far along it (0 at its start, 1 at its end). */
    const outside = (q: Corners, i: number, x: number, y: number) => {
      const [ax, ay] = q[i], [bx, by] = q[(i + 1) % 4], len = Math.hypot(bx - ax, by - ay);
      return ((bx - ax) * (ay - y) - (by - ay) * (ax - x)) / len;
    };
    const along = (q: Corners, i: number, x: number, y: number) => {
      const [ax, ay] = q[i], [bx, by] = q[(i + 1) % 4];
      return ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2);
    };
    /** The things of the check's sweep, `at` px beyond side `i` of `q`. */
    const things: Record<string, (q: Corners, i: number, at: number) => (p: Pixels) => void> = {
      pen: (q, i, at) => (p) => paint(p, (x, y) => {
        const d = outside(q, i, x + 0.5, y + 0.5), t = along(q, i, x + 0.5, y + 0.5);
        return d > at && d < at + 6 && t > -0.03 && t < 1.03 ? [30, 30, 40] : null;
      }),
      ruler: (q, i, at) => (p) => paint(p, (x, y) => {
        const d = outside(q, i, x + 0.5, y + 0.5), t = along(q, i, x + 0.5, y + 0.5);
        return d > at && d < at + 25 && t > 0.075 && t < 0.925 ? [40, 40, 45] : null;
      }),
      laptop: (q, i, at) => (p) => paint(p, (x, y) => (outside(q, i, x + 0.5, y + 0.5) > at ? [30, 30, 35] : null)),
      shadow: (q, i, at) => shade((x, y) => 1 - 0.25 * Math.max(0, Math.min(1, (outside(q, i, x, y) - at) / 8))),
    };
    const onTable = (q: Corners, thing: string, i: number, at: number, seed: number) => {
      const photo = synthPhoto(paperOf("word"), PW, PH, q, { bg: "white", seed });
      things[thing](q, i, at)(photo);
      return photo;
    };
    const named: { label: string; photo: () => Pixels; quad: Corners }[] = [
      ...[60, 70, 85].map((at) => ({
        label: `a dark strip 6 px wide, x 100–800, ${at} px beyond the top`,
        photo: () => {
          const photo = synthPhoto(paperOf("word"), PW, PH, BASE, { bg: "white", seed: 3 });
          paint(photo, (x, y) => (aboveTop(x + 0.5, y + 0.5) > at && aboveTop(x + 0.5, y + 0.5) < at + 6 && x >= 100 && x <= 800 ? [30, 30, 40] : null));
          return photo;
        },
        quad: BASE,
      })),
      { label: "everything dark from 70 px beyond the top (a laptop's edge)", photo: () => onTable(BASE, "laptop", 0, 70, 3), quad: BASE },
      { label: "a 25 px ruler 70 px below the bottom", photo: () => onTable(BASE, "ruler", 2, 70, 3), quad: BASE },
      { label: "a soft shadow, 25 % darker, from 50 px beyond the top", photo: () => onTable(BASE, "shadow", 0, 50, 3), quad: BASE },
      { label: "a pen 70 px beyond the top, turned 12°", photo: () => onTable(T12, "pen", 0, 70, 3), quad: T12 },
    ];
    it.each(named)("$label, on a white table: the side stays, with confidence", ({ photo, quad }) => {
      const found = detectSheet(photo());
      const error = found.corners ? cornerError(found.corners, quad) : Infinity;
      console.log(`error ${error.toFixed(2)} px  confidence ${found.confidence.toFixed(2)}  sides ${found.sides.map((s) => s.toFixed(2)).join(" ")}`);
      expect(error).toBeLessThanOrEqual(3);
      expect(found.confidence).toBeGreaterThanOrEqual(FOUND_CONFIDENCE);
    });

    // Where the quadrilateral found first already has its side on the pen (its edge has far more
    // contrast than the paper's on a white table), the side is moved a few pixels onto it and the
    // photo beyond is darker than beyond the other sides: either reading fits, so the corners are
    // not trusted (fix rounds 1 and 2 gave them with confidence, 50 px off).
    it("a pen 50 px below the bottom, the side found first on it: not trusted", () => {
      const found = detectSheet(onTable(BASE, "pen", 2, 50, 3));
      console.log(`confidence ${found.confidence.toFixed(2)}  sides ${found.sides.map((s) => s.toFixed(2)).join(" ")}`);
      expect(found.confidence).toBeLessThan(FOUND_CONFIDENCE);
    });

    // The check's sweep with one seed: pen, ruler, laptop and shadow 50–85 px (15–27 mm) beyond the
    // top or the bottom, upright and turned 12°. Fix round 1 got 35 of these 64 right; fix round 2
    // took the thing for the side in 23 of those 35 and was unsure of 9 more.
    it("dark things on a white table 15–27 mm beyond a side: right wherever fix round 1 was", () => {
      // Fix round 1's wrong answers (all with confidence but 3 not trusted): the side found first on the thing.
      const roundOneWrong = new Set([
        "upright top pen 50", "upright top laptop 50", "upright top laptop 60",
        "upright bottom pen 50", "upright bottom laptop 50", "upright bottom shadow 50", "upright bottom pen 60",
        "upright bottom laptop 60", "upright bottom shadow 60", "upright bottom pen 70", "upright bottom laptop 70",
        "upright bottom laptop 85", "upright bottom shadow 85",
        "turned 12° top pen 50", "turned 12° top laptop 50", "turned 12° top laptop 60",
        ...[50, 60, 70].flatMap((at) => ["pen", "ruler", "laptop", "shadow"].map((thing) => `turned 12° bottom ${thing} ${at}`)),
        "turned 12° bottom laptop 85",
      ]);
      let right = 0, unsure = 0;
      const wrong: string[] = [], lost: string[] = [];
      const t = performance.now();
      for (const [pose, quad] of [["upright", BASE], ["turned 12°", T12]] as const) {
        for (const [side, i] of [["top", 0], ["bottom", 2]] as const) {
          for (const at of [50, 60, 70, 85]) {
            for (const thing of Object.keys(things)) {
              const key = `${pose} ${side} ${thing} ${at}`;
              const found = detectSheet(onTable(quad, thing, i, at, 3));
              const error = found.corners ? cornerError(found.corners, quad) : Infinity;
              const sure = found.confidence >= FOUND_CONFIDENCE;
              if (!sure) unsure++;
              else if (error <= 3) right++;
              else wrong.push(key);
              if (!roundOneWrong.has(key) && !(sure && error <= 3)) lost.push(`${key}: ${error.toFixed(1)} px at ${found.confidence.toFixed(2)}`);
            }
          }
        }
      }
      console.log(`64 photos in ${ms(t)}: ${right} right, ${unsure} not trusted, ${wrong.length} confidently wrong (all of them in fix round 1 too: ${wrong.every((k) => roundOneWrong.has(k))})`);
      expect(lost).toEqual([]);
      expect(wrong.filter((k) => !roundOneWrong.has(k))).toEqual([]);
      expect(right).toBeGreaterThanOrEqual(35);
    }, 120_000);
  });

  it("a blank photo or a tiny one finds nothing", () => {
    const blank: Pixels = { width: 400, height: 300, data: new Uint8ClampedArray(400 * 300 * 4).fill(128) };
    expect(detectSheet(blank)).toMatchObject({ corners: null, confidence: 0 });
    const tiny: Pixels = { width: 10, height: 10, data: new Uint8ClampedArray(400).fill(200) };
    expect(detectSheet(tiny)).toMatchObject({ corners: null, confidence: 0 });
  });

  it("timing on a 3500 px working photo", () => {
    const W = 2625, H = 3500, k = W / PW;
    const quad = BASE.map(([x, y]) => [x * k, y * k]) as Corners;
    let t = performance.now();
    const photo = synthPhoto(renderFixture("word-winansi.pdf", 2800), W, H, quad, { bg: "desk", seed: 9 });
    const made = ms(t);
    t = performance.now();
    const found = detectSheet(photo);
    const detect = ms(t);
    const error = cornerError(found.corners!, quad);
    console.log(`3500 px photo (${W}×${H}, made in ${made}): detect ${detect}, error ${error.toFixed(2)} px, confidence ${found.confidence.toFixed(2)}`);
    expect(error).toBeLessThanOrEqual(6);
    for (const mode of ["document", "grey", "bw", "original"] as const) {
      t = performance.now();
      const page = renderPage(photo, found.corners!, mode, "a4");
      const render = ms(t);
      t = performance.now();
      const preview = previewOf(page);
      const small = ms(t);
      const size = page.kind === "bw" ? `${page.width}×${page.height}` : `${page.pixels.width}×${page.pixels.height}`;
      console.log(`  ${mode.padEnd(9)} ${size} at ${page.dpi} dpi: warp and clean-up ${render}, preview ${small} (${preview.width}×${preview.height})`);
    }
  });
});

describe("orderCorners", () => {
  const rect: Corners = [[100, 50], [400, 60], [390, 500], [90, 480]];
  it("puts any order of the four corners as TL TR BR BL", () => {
    for (const perm of [[0, 1, 2, 3], [2, 0, 3, 1], [3, 2, 1, 0], [1, 3, 0, 2]]) {
      expect(orderCorners(perm.map((i) => rect[i]))).toEqual(rect);
    }
  });

  it("finds the top-left of a sheet turned up to 45° either way, whatever its proportions", () => {
    for (const deg of [-44, -35, -20, 0, 20, 35, 44]) {
      for (const [w, h] of [[210, 297], [297, 210], [100, 400]]) {
        const a = (deg * Math.PI) / 180;
        const turn = ([x, y]: Point): Point => [500 + x * Math.cos(a) - y * Math.sin(a), 500 + x * Math.sin(a) + y * Math.cos(a)];
        const truth = ([[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]] as Point[]).map(turn) as Corners;
        const got = orderCorners([truth[2], truth[0], truth[3], truth[1]]);
        expect(cornerError(got, truth), `${deg}° ${w}×${h}`).toBeLessThan(1e-9);
      }
    }
  });
});

describe("homography and warp", () => {
  it("the homography maps the four points, and refuses degenerate ones", () => {
    const from: Corners = [[0, 0], [100, 0], [100, 140], [0, 140]];
    const to: Corners = [[12, 7], [91, 15], [99, 150], [3, 133]];
    const H = homography(from, to)!;
    for (let i = 0; i < 4; i++) {
      const [x, y] = applyHomography(H, from[i][0], from[i][1]);
      expect(x).toBeCloseTo(to[i][0], 9);
      expect(y).toBeCloseTo(to[i][1], 9);
    }
    expect(homography(from, [[0, 0], [10, 10], [20, 20], [5, 40]])).toBeNull();
    expect(homography(from, [[0, 0], [0, 0], [20, 20], [5, 40]])).toBeNull();
  });

  it("takes the corners as TL TR BR BL (coloured markers end up in the page's own corners)", () => {
    const W = 600, H = 400, data = new Uint8ClampedArray(W * H * 4).fill(128);
    const quad: Corners = [[100, 60], [520, 90], [480, 350], [80, 320]];
    const colours = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]];
    quad.forEach(([cx, cy], i) => {
      for (let y = cy - 8; y <= cy + 8; y++) for (let x = cx - 8; x <= cx + 8; x++) data.set([...colours[i], 255], (y * W + x) * 4);
    });
    const page = warp({ width: W, height: H, data }, quad, 200, 140);
    const at = (x: number, y: number) => [...page.data.subarray((y * 200 + x) * 4, (y * 200 + x) * 4 + 3)];
    expect(at(1, 1)).toEqual(colours[0]);
    expect(at(198, 1)).toEqual(colours[1]);
    expect(at(198, 138)).toEqual(colours[2]);
    expect(at(1, 138)).toEqual(colours[3]);
    expect(page.data[3]).toBe(255);
  });

  it("straightens a synthetic photo back to the page (bilinear: close to the truth)", () => {
    const truth = renderFixture("word-winansi.pdf", 1000);
    const photo = synthPhoto(truth, PW, PH, BASE, { flat: true, shadow: false, bg: "wood" });
    const t = performance.now();
    const page = warp(photo, BASE, truth.width, truth.height);
    const time = ms(t);
    // The photo's paper is the truth tinted: 18 + v × 220/255 (red). Compare in that space.
    let se = 0;
    for (let i = 0; i < page.data.length; i += 4) se += (page.data[i] - (18 + (truth.data[i] * 220) / 255)) ** 2;
    const psnr = 10 * Math.log10((255 * 255) / (se / (page.data.length / 4)));
    console.log(`warp ${truth.width}×${truth.height}: ${time}, PSNR against the truth ${psnr.toFixed(1)} dB`);
    expect(psnr).toBeGreaterThan(24);
  });
});

describe("the sheet's proportions and the page size", () => {
  /** A w × h mm rectangle seen by a pinhole camera of focal length f px centred on a W × H photo, after rotations (degrees). */
  function camera(w: number, h: number, { tiltX = 0, tiltY = 0, turn = 0, f = 3000, distance = 600, W = 3000, H = 4000 } = {}): Corners {
    const rad = Math.PI / 180;
    const pts: [number, number, number][] = [[-w / 2, -h / 2, 0], [w / 2, -h / 2, 0], [w / 2, h / 2, 0], [-w / 2, h / 2, 0]];
    return pts.map(([x, y, z]) => {
      // turn about z, tilt about x, then about y
      let a = turn * rad;
      [x, y] = [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
      a = tiltX * rad;
      [y, z] = [y * Math.cos(a) - z * Math.sin(a), y * Math.sin(a) + z * Math.cos(a)];
      a = tiltY * rad;
      [x, z] = [x * Math.cos(a) + z * Math.sin(a), -x * Math.sin(a) + z * Math.cos(a)];
      z += distance;
      return [W / 2 + (f * x) / z, H / 2 + (f * y) / z];
    }) as Corners;
  }

  const A4 = 210 / 297;
  const naiveAspect = (q: Corners) =>
    (Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]) + Math.hypot(q[2][0] - q[3][0], q[2][1] - q[3][1]))
    / (Math.hypot(q[3][0] - q[0][0], q[3][1] - q[0][1]) + Math.hypot(q[2][0] - q[1][0], q[2][1] - q[1][1]));

  it("reads A4's proportions back from tilted photos, measuring the lens (the sides as seen would not)", () => {
    // Both pairs of sides converge: the focal length is measured, whatever it is.
    for (const view of [{ tiltX: -25, tiltY: 15 }, { tiltX: 35, turn: 10 }, { tiltX: 20, tiltY: 25, f: 2400 }, { tiltX: 28, tiltY: -12, turn: -8, f: 3600 }, { tiltX: 15, tiltY: 10, turn: 40, f: 1800 }]) {
      const q = camera(210, 297, view);
      expect(Math.abs(sheetAspect(q, 3000, 4000) / A4 - 1), JSON.stringify(view)).toBeLessThan(0.01);
      expect(Math.abs(naiveAspect(q) / A4 - 1), JSON.stringify(view)).toBeGreaterThan(0.03);
    }
    expect(sheetAspect(camera(297, 210, { tiltX: 30, tiltY: 10 }), 3000, 4000)).toBeCloseTo(297 / 210, 2);
    expect(sheetAspect(camera(85.6, 54, { tiltX: 20, tiltY: -15, distance: 250 }), 3000, 4000)).toBeCloseTo(85.6 / 54, 2);
  });

  it("assumes a typical phone lens when one pair of sides is parallel (the lens cannot be measured)", () => {
    // Tilted about the photo's own axis: the main camera's lens (0.6 × the diagonal, here 3000 px) is right...
    for (const view of [{ tiltX: 30 }, { tiltY: -25 }]) {
      const q = camera(210, 297, view);
      expect(Math.abs(sheetAspect(q, 3000, 4000) / A4 - 1), JSON.stringify(view)).toBeLessThan(0.01);
    }
    // ... and another lens still gives a better answer than the sides as seen.
    const q = camera(210, 297, { tiltX: 30, f: 3900 });
    const error = Math.abs(sheetAspect(q, 3000, 4000) / A4 - 1), naive = Math.abs(naiveAspect(q) / A4 - 1);
    console.log(`tilted 30° about the photo's axis, lens 1.3 × the assumed one: aspect off by ${(100 * error).toFixed(1)} % (the sides as seen: ${(100 * naive).toFixed(1)} %)`);
    expect(error).toBeLessThan(0.08);
    expect(error).toBeLessThan(naive / 2);
  });

  it("falls back to the sides as seen with no perspective, and stays within bounds", () => {
    expect(sheetAspect(wholeFrame(3000, 4000), 3000, 4000)).toBeCloseTo(0.75, 9);
    expect(sheetAspect(camera(210, 297), 3000, 4000)).toBeCloseTo(210 / 297, 6);
    expect(sheetAspect([[0, 0], [1000, 0], [1000, 2], [0, 2]], 1000, 1000)).toBe(12);
  });

  it("gives A4 in the sheet's orientation, or the sheet's own proportions", () => {
    expect(pageSize(0.7, "a4", 200)).toEqual({ width: 1654, height: 2339 });
    expect(pageSize(1.4, "a4", 200)).toEqual({ width: 2339, height: 1654 });
    expect(pageSize(0.7, "a4", 300)).toEqual({ width: 2480, height: 3508 });
    expect(pageSize(0.5, "photo", 200)).toEqual({ width: 1170, height: 2339 });
    expect(pageSize(2, "photo", 300)).toEqual({ width: 3508, height: 1754 });
  });

  it("checks the corners the user moved", () => {
    expect(cornersUsable(wholeFrame(400, 300), 400, 300)).toBe(true);
    expect(cornersUsable([[10, 10], [390, 20], [380, 290], [5, 280]], 400, 300)).toBe(true);
    expect(cornersUsable([[10, 10], [380, 290], [390, 20], [5, 280]], 400, 300)).toBe(false); // crossed
    expect(cornersUsable([[10, 10], [5, 280], [380, 290], [390, 20]], 400, 300)).toBe(false); // anticlockwise
    expect(cornersUsable([[-10, 10], [390, 20], [380, 290], [5, 280]], 400, 300)).toBe(false); // outside
    expect(cornersUsable([[10, 10], [20, 10], [20, 20], [10, 20]], 400, 300)).toBe(false); // too small
    expect(cornersUsable([[10, 10], [Number.NaN, 20], [380, 290], [5, 280]], 400, 300)).toBe(false);
    expect(cornersUsable([[1, 2]] as unknown as Corners, 400, 300)).toBe(false);
    expect(clampCorners([[-5, 3], [410, -2], [399, 301], [0, 300]], 400, 300)).toEqual([[0, 3], [400, 0], [399, 300], [0, 300]]);
  });
});

describe("the modes' clean-up", () => {
  /** A letter with thick strokes (lines of "words" 9 px tall, a stamp), so that ink and paper are easy to tell apart on the page. */
  let letter: Pixels | null = null;
  const truth = () => {
    if (letter) return letter;
    const W = 700, H = 990, data = new Uint8ClampedArray(W * H * 4).fill(255), rand = rng(21);
    const fill = (x0: number, y0: number, w: number, h: number, c: number[]) => {
      for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) data.set([c[0], c[1], c[2], 255], (y * W + x) * 4);
    };
    for (let y = 80; y < 780; y += 30) for (let x = 60; x < 600; ) { const w = 20 + Math.floor(rand() * 60); fill(x, y, Math.min(w, 640 - x), 9, [20, 20, 20]); x += w + 12; }
    fill(80, 840, 70, 70, [15, 15, 15]);
    fill(400, 840, 200, 40, [30, 60, 170]); // a blue stamp
    return (letter = { width: W, height: H, data });
  };
  // A photo with uneven light and a shadow; the page straightened with the true corners.
  const photo = () => synthPhoto(truth(), PW, PH, BASE, { bg: "desk", seed: 5 });
  const lowest = (a: number[]) => a.reduce((m, v) => Math.min(m, v), 255);
  const highest = (a: number[]) => a.reduce((m, v) => Math.max(m, v), 0);

  /** Output pixels on a grid, with the truth's brightness at the same place on the page. */
  function samples(width: number, height: number, read: (x: number, y: number) => number) {
    const t = truth(), paper: number[] = [], ink: number[] = [];
    for (let y = 4; y < height - 4; y += 3) {
      for (let x = 4; x < width - 4; x += 3) {
        const tx = Math.floor(((x + 0.5) / width) * t.width), ty = Math.floor(((y + 0.5) / height) * t.height);
        let darkest = 255, lightest = 0;
        for (let dy = -3; dy <= 3; dy++) {
          for (let dx = -3; dx <= 3; dx++) {
            const xx = Math.min(t.width - 1, Math.max(0, tx + dx)), yy = Math.min(t.height - 1, Math.max(0, ty + dy));
            const v = t.data[(yy * t.width + xx) * 4];
            darkest = Math.min(darkest, v);
            lightest = Math.max(lightest, v);
          }
        }
        if (darkest === 255) paper.push(read(x, y));
        else if (lightest < 60) ink.push(read(x, y));
      }
    }
    return { paper, ink };
  }
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const share = (a: number[], f: (v: number) => boolean) => a.filter(f).length / a.length;

  it("Documento: the paper white in the light and in the shadow, the ink dark", () => {
    const p = photo();
    const t = performance.now();
    const page = renderPage(p, BASE, "document", "photo");
    console.log(`document ${page.kind === "jpeg" ? `${page.pixels.width}×${page.pixels.height}` : ""}: ${ms(t)}`);
    expect(page.kind).toBe("jpeg");
    if (page.kind !== "jpeg") return;
    expect(page).toMatchObject({ dpi: 200, quality: 0.72 });
    const { width, height, data } = page.pixels;
    const luma = (x: number, y: number) => {
      const i = (y * width + x) * 4;
      return (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
    };
    const { paper, ink } = samples(width, height, luma);
    // Before: the paper ranges from lit to shadowed.
    const raw = warp(p, BASE, width, height);
    const rawLuma = (x: number, y: number) => raw.data[(y * width + x) * 4 + 1];
    const before = samples(width, height, rawLuma);
    console.log(`  paper before ${lowest(before.paper)}..${highest(before.paper)}, after mean ${mean(paper).toFixed(1)} (${(100 * share(paper, (v) => v >= 245)).toFixed(1)} % at 245 or more); ink before ${mean(before.ink).toFixed(1)}, after ${mean(ink).toFixed(1)}`);
    expect(lowest(before.paper)).toBeLessThan(180);
    expect(share(paper, (v) => v >= 245)).toBeGreaterThan(0.97);
    expect(ink.length).toBeGreaterThan(1000);
    expect(mean(ink)).toBeLessThan(40);
    // The stamp keeps its colour.
    const i = (Math.floor((860 / 990) * height) * width + Math.floor((500 / 700) * width)) * 4;
    expect(data[i + 2] - data[i]).toBeGreaterThan(80);
  });

  it("Grigio: grey, white paper; Originale: only straightened", () => {
    const p = photo();
    const grey = renderPage(p, BASE, "grey", "a4");
    if (grey.kind !== "jpeg") throw new Error("grey is a JPEG page");
    expect(grey).toMatchObject({ dpi: 200, quality: 0.65 });
    let coloured = 0;
    for (let i = 0; i < grey.pixels.data.length; i += 4) if (grey.pixels.data[i] !== grey.pixels.data[i + 1] || grey.pixels.data[i] !== grey.pixels.data[i + 2]) coloured++;
    expect(coloured).toBe(0);
    const g = samples(grey.pixels.width, grey.pixels.height, (x, y) => grey.pixels.data[(y * grey.pixels.width + x) * 4]);
    expect(share(g.paper, (v) => v >= 245)).toBeGreaterThan(0.97);
    const original = renderPage(p, BASE, "original", "a4");
    if (original.kind !== "jpeg") throw new Error("original is a JPEG page");
    expect(original).toMatchObject({ dpi: 200, quality: 0.8 });
    const o = samples(original.pixels.width, original.pixels.height, (x, y) => original.pixels.data[(y * original.pixels.width + x) * 4 + 1]);
    expect(mean(o.paper)).toBeLessThan(235); // the tint and the shadow are still there
    const raw = warp(p, BASE, original.pixels.width, original.pixels.height);
    let different = 0;
    for (let i = 0; i < raw.data.length; i++) if (raw.data[i] !== original.pixels.data[i]) different++;
    expect(different).toBe(0);
  });

  it("Bianco e nero: 1 bit at 300 dpi, the paper white, the ink black", () => {
    const p = photo();
    const t = performance.now();
    const page = renderPage(p, BASE, "bw", "a4");
    console.log(`bw: ${ms(t)}`);
    if (page.kind !== "bw") throw new Error("bw is a 1-bit page");
    expect(page).toMatchObject({ width: 2480, height: 3508, dpi: 300 });
    const rowBytes = (page.width + 7) >> 3;
    expect(page.bits.length).toBe(rowBytes * page.height);
    const bit = (x: number, y: number) => (page.bits[y * rowBytes + (x >> 3)] & (0x80 >> (x & 7)) ? 255 : 0);
    const { paper, ink } = samples(page.width, page.height, bit);
    console.log(`  paper white ${(100 * share(paper, (v) => v === 255)).toFixed(2)} %, ink black ${(100 * share(ink, (v) => v === 0)).toFixed(1)} %`);
    expect(share(paper, (v) => v === 255)).toBeGreaterThan(0.995);
    expect(ink.length).toBeGreaterThan(1000);
    // (0.95 before fix round 1: the 70 × 70 block, wider than the threshold's window, was hollow.)
    expect(share(ink, (v) => v === 0)).toBeGreaterThan(0.995);
  });

  // Fix round 1 (review findings P19, P21), on a sheet photographed flat (the whole photo is the
  // sheet, 1240 × 1754, paper at 236): solid black areas in Bianco e nero, grey pictures in all
  // three modes that flatten the light.
  describe("solid black areas and grey pictures", () => {
    const SW = 1240, SH = 1754, PAPER = 236;
    /** A rectangle of grey `v`; `inset`: how far in from its edges it is measured (default 4). */
    type Mark = { x0: number; y0: number; x1: number; y1: number; v: (x: number, y: number) => number; inset?: number };
    /** The sheet with `marks` (grey values) and the light falling on it (1 = full light). */
    function sheet(marks: Mark[], light: (x: number, y: number) => number = () => 1): Pixels {
      const tone = new Float32Array(SW * SH).fill(PAPER);
      for (const m of marks) for (let y = m.y0; y < m.y1; y++) for (let x = m.x0; x < m.x1; x++) tone[y * SW + x] = m.v(x, y);
      const data = new Uint8ClampedArray(SW * SH * 4), rand = rng(17);
      for (let y = 0, i = 0; y < SH; y++) {
        for (let x = 0; x < SW; x++, i++) {
          const v = tone[i] * light(x, y) + (rand() - 0.5) * 6;
          data[4 * i] = data[4 * i + 1] = data[4 * i + 2] = v;
          data[4 * i + 3] = 255;
        }
      }
      return { width: SW, height: SH, data };
    }
    const flat = (v: number) => () => v;
    /** A smooth grey photo between `lo` and `hi` (value noise), with a little grain. */
    const photoTones = (lo: number, hi: number, seed: number) => {
      const n = valueNoise(SW, SH, 60, rng(seed)), grain = valueNoise(SW, SH, 4, rng(seed + 1));
      return (x: number, y: number) => lo + (hi - lo) * (0.85 * n(x, y) + 0.15 * grain(x, y));
    };
    /** Light brighter at the top left, and a soft shadow coming in from the bottom-left edge (as synthPhoto's). */
    const uneven = (x: number, y: number) => {
      const dx = (x - SW * 0.25) / (SW * 0.35), dy = (y - SH * 0.95) / (SH * 0.25);
      return (1 - 0.2 * ((x / SW) * 0.4 + (y / SH) * 0.6)) * (1 - 0.35 * Math.max(0, Math.min(1, 1.3 - Math.hypot(dx, dy))));
    };
    /**
     * Each mark's inside (`inset` photo pixels in from its edges) and the paper (`pad` pixels away
     * from every mark), read through `at` on a page of `width` × `height`, every `step` pixels.
     */
    function regions(marks: Mark[], width: number, height: number, at: (x: number, y: number) => number, step = 2, pad = 20) {
      const owner = new Int32Array(SW * SH).fill(-1), near = new Uint8Array(SW * SH);
      marks.forEach(({ x0, y0, x1, y1, inset = 4 }, k) => {
        for (let y = Math.max(0, y0 - pad); y < Math.min(SH, y1 + pad); y++) near.fill(1, y * SW + Math.max(0, x0 - pad), y * SW + Math.min(SW, x1 + pad));
        for (let y = y0 + inset; y < y1 - inset; y++) owner.fill(k, y * SW + x0 + inset, y * SW + x1 - inset);
      });
      const inside = marks.map(() => [] as number[]), paper: number[] = [];
      for (let y = 0; y < height; y += step) {
        for (let x = 0; x < width; x += step) {
          const i = Math.floor(((y + 0.5) * SH) / height) * SW + Math.floor(((x + 0.5) * SW) / width);
          if (owner[i] >= 0) inside[owner[i]].push(at(x, y));
          else if (!near[i]) paper.push(at(x, y));
        }
      }
      return { inside, paper };
    }

    it("Bianco e nero keeps solid black areas black, wider than the threshold's window, and thin text", () => {
      const strokes: Mark[] = [];
      for (let y = 1000; y < 1500; y += 24) for (let x = 120; x < 1100; x += 46) strokes.push({ x0: x, y0: y, x1: x + 38, y1: y + 3, v: flat(40), inset: 1 });
      const marks: Mark[] = [
        { x0: 120, y0: 200, x1: 1120, y1: 320, v: flat(25) }, // a black header bar, 1000 × 120
        { x0: 150, y0: 450, x1: 350, y1: 650, v: flat(20) }, // a black square 34 mm wide (a redaction box, a logo)
        { x0: 600, y0: 450, x1: 1000, y1: 750, v: photoTones(55, 85, 31) }, // a dark-grey photo
        ...strokes,
      ];
      const page = renderPage(sheet(marks), wholeFrame(SW, SH), "bw", "a4");
      if (page.kind !== "bw") throw new Error("bw is a 1-bit page");
      const rowBytes = (page.width + 7) >> 3;
      const bit = (x: number, y: number) => (page.bits[y * rowBytes + (x >> 3)] & (0x80 >> (x & 7)) ? 255 : 0);
      const { inside, paper } = regions(marks, page.width, page.height, bit);
      const black = (a: number[]) => share(a, (v) => v === 0);
      const text = inside.slice(3).flat();
      // Before fix round 1: the bar 65 % black (its middle white), the square 60 %, the dark photo 39 %.
      console.log(`  bar ${(100 * black(inside[0])).toFixed(1)} % black, square ${(100 * black(inside[1])).toFixed(1)} %, dark photo ${(100 * black(inside[2])).toFixed(1)} %, thin text ${(100 * black(text)).toFixed(1)} %, paper ${(100 * share(paper, (v) => v === 255)).toFixed(2)} % white`);
      expect(black(inside[0])).toBeGreaterThan(0.995);
      expect(black(inside[1])).toBeGreaterThan(0.995);
      expect(black(inside[2])).toBeGreaterThan(0.95);
      expect(black(text)).toBeGreaterThan(0.95);
      expect(share(paper, (v) => v === 255)).toBeGreaterThan(0.995);
    });

    it.each(["document", "grey", "bw"] as const)("%s does not re-light a grey photo as paper in shadow (on a lit and shadowed sheet)", (mode) => {
      const marks: Mark[] = [
        { x0: 300, y0: 420, x1: 940, y1: 900, v: photoTones(40, 170, 41) }, // a black-and-white photo
        { x0: 300, y0: 1000, x1: 520, y1: 1300, v: flat(150) }, // a chart's grey bar
      ];
      const page = renderPage(sheet(marks, uneven), wholeFrame(SW, SH), mode, "photo");
      const width = page.kind === "bw" ? page.width : page.pixels.width, height = page.kind === "bw" ? page.height : page.pixels.height;
      const rowBytes = (width + 7) >> 3;
      const at = page.kind === "bw"
        ? (x: number, y: number) => (page.bits[y * rowBytes + (x >> 3)] & (0x80 >> (x & 7)) ? 255 : 0)
        : (x: number, y: number) => page.pixels.data[(y * width + x) * 4 + 1];
      // What the photo should come out as: its tone against the paper (the light divided out), stretched as Documento does.
      const truth = (x: number, y: number) => {
        const px = Math.floor(((x + 0.5) / width) * SW), py = Math.floor(((y + 0.5) / height) * SH);
        const m = marks.find((k) => px >= k.x0 && px < k.x1 && py >= k.y0 && py < k.y1);
        return m ? 255 * Math.max(0, Math.min(1, (m.v(px, py) / PAPER - 0.2) / 0.68)) : 255;
      };
      const { inside, paper } = regions(marks, width, height, at, 3);
      const expected = regions(marks, width, height, truth, 3).inside;
      const error = (k: number) => inside[k].reduce((s, v, i) => s + Math.abs(v - expected[k][i]), 0) / inside[k].length;
      // Before fix round 1 (Documento and Grigio): the photo 48.5 levels off, the grey bar 27.3.
      console.log(`  ${mode}: photo off by ${error(0).toFixed(1)} levels on average, grey bar ${error(1).toFixed(1)}; paper ${(100 * share(paper, (v) => v >= 245)).toFixed(1)} % white`);
      expect(share(paper, (v) => v >= 245)).toBeGreaterThan(0.97);
      if (mode === "bw") {
        // Thresholded: the photo's darker half stays black (82 % before fix round 1).
        const dark = inside[0].filter((_, i) => expected[0][i] < 60);
        expect(share(dark, (v) => v === 0)).toBeGreaterThan(0.95);
        return;
      }
      expect(error(0)).toBeLessThan(12);
      expect(error(1)).toBeLessThan(12);
    });

    it("a hard-edged shadow coming in from the sheet's edge is still flattened", () => {
      // A phone's shadow under a lamp: the left third at 55 % of the light, a 6-pixel penumbra. (The
      // blocks' levels are smoothed, so the paper within about three blocks of the shadow's edge
      // stays a little grey, as it did before fix round 1; the rest of the shadow must be paper.)
      const shade = (x: number) => 1 - 0.45 * Math.max(0, Math.min(1, (420 - x) / 6));
      const strokes: Mark[] = [];
      for (let y = 300; y < 1500; y += 30) for (let x = 100; x < 1140; x += 52) strokes.push({ x0: x, y0: y, x1: x + 40, y1: y + 6, v: flat(30), inset: 2 });
      const page = renderPage(sheet(strokes, (x) => shade(x)), wholeFrame(SW, SH), "document", "photo");
      if (page.kind !== "jpeg") throw new Error("document is a JPEG page");
      const { width, height, data } = page.pixels;
      const green = (x: number, y: number) => data[(y * width + x) * 4 + 1];
      const { inside } = regions(strokes, width, height, green);
      // The paper in the shadow (left of x = 290) and in the light (right of 550), 8 pixels from the writing.
      const left = regions(strokes, width, height, (x, y) => (x * SW < 290 * width ? green(x, y) : -1), 3, 8).paper.filter((v) => v >= 0);
      const right = regions(strokes, width, height, (x, y) => (x * SW > 550 * width ? green(x, y) : -1), 3, 8).paper.filter((v) => v >= 0);
      const text = inside.flat();
      console.log(`  hard shadow: paper in the shadow ${(100 * share(left, (v) => v >= 245)).toFixed(1)} % white, in the light ${(100 * share(right, (v) => v >= 245)).toFixed(1)} %, text mean ${mean(text).toFixed(1)}`);
      expect(left.length).toBeGreaterThan(1000);
      expect(share(left, (v) => v >= 245)).toBeGreaterThan(0.97);
      expect(share(right, (v) => v >= 245)).toBeGreaterThan(0.97);
      expect(mean(text)).toBeLessThan(40);
    });
  });

  it("a page with no paper-like block (a coloured flyer) is not blown out", () => {
    const W = 200, H = 280, data = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < data.length; i += 4) data.set([230, 120, 150, 255], i);
    for (let y = 100; y < 120; y++) for (let x = 20; x < 180; x++) data.set([40, 20, 30, 255], (y * W + x) * 4);
    const page = { width: W, height: H, data };
    flattenLight(page);
    const pink = [...data.subarray(0, 3)], text = [...data.subarray((110 * W + 100) * 4, (110 * W + 100) * 4 + 3)];
    expect(pink[0]).toBeGreaterThan(pink[1] + 60); // still pink, not white
    expect(Math.max(...text)).toBeLessThan(60);
  });

  it.each([100, 0])("the threshold's running sums equal Bradley's integral-image result (ink below %i in any case)", (ink) => {
    const W = 123, H = 77, rand = rng(3), grey = new Uint8Array(W * H).map(() => Math.floor(rand() * 256));
    // A black block wider than the window: Bradley's own tie (at most the mean is ink) keeps it black.
    for (let y = 20; y < 50; y++) grey.fill(0, y * W + 40, y * W + 80);
    const window = 15, r = window >> 1, t = 0.15;
    const bits = threshold(grey, W, H, ink === 100 ? { window, t } : { window, t, ink });
    const rowBytes = (W + 7) >> 3;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let sum = 0, n = 0;
        for (let yy = Math.max(0, y - r); yy < Math.min(H, y + r + 1); yy++) for (let xx = Math.max(0, x - r); xx < Math.min(W, x + r + 1); xx++) { sum += grey[yy * W + xx]; n++; }
        const white = grey[y * W + x] >= ink && grey[y * W + x] * n > sum * (1 - t);
        expect(Boolean(bits[y * rowBytes + (x >> 3)] & (0x80 >> (x & 7))), `${x},${y}`).toBe(white);
      }
      // padding bits are white
      expect(bits[y * rowBytes + rowBytes - 1] & 0x1f).toBe(0x1f);
    }
    expect(bits[35 * rowBytes + (60 >> 3)] & (0x80 >> (60 & 7))).toBe(0); // the block's centre
  });

  it("greyOf takes the luma", () => {
    const g = greyOf({ width: 2, height: 1, data: new Uint8ClampedArray([255, 255, 255, 255, 255, 0, 0, 255]) });
    expect([...g]).toEqual([255, 76]);
  });

  it("refuses corners that make no sheet, and unknown modes", () => {
    const p = photo();
    expect(() => renderPage(p, [[10, 10], [380, 290], [390, 20], [5, 280]], "document", "a4")).toThrow(ScanError);
    expect(() => renderPage(p, BASE, "sepia" as never, "a4")).toThrow(ScanError);
    expect(() => renderPage(p, BASE, "document", "letter" as never)).toThrow(ScanError);
  });

  it("the preview is small", () => {
    const p = photo();
    for (const mode of ["document", "bw"] as const) {
      const pv = previewOf(renderPage(p, BASE, mode, "a4"));
      expect(Math.max(pv.width, pv.height)).toBe(PREVIEW_SIDE);
      expect(pv.data.length).toBe(pv.width * pv.height * 4);
    }
  });
});

describe("the 1-bit PNG", () => {
  const W = 997, H = 61;
  const rowBytes = (W + 7) >> 3;
  const rand = rng(11);
  const bits = new Uint8Array(rowBytes * H).map(() => Math.floor(rand() * 256));

  it("CRC-32 and Adler-32 are the standard ones", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(adler32(new TextEncoder().encode("Wikipedia"))).toBe(0x11e60398);
    const big = new Uint8Array(200_000).fill(255);
    expect(inflateSync(zlibStored(big))).toEqual(Buffer.from(big)); // inflate checks the Adler-32
  });

  it.each([true, false])("decodes back exactly with MuPDF (compressed: %s)", async (compress) => {
    const png = await png1(bits, W, H, 300, { compress });
    const { pixels, components, xres } = decoded(png);
    expect(components).toBe(1);
    expect(xres).toBe(300);
    expect([pixels.width, pixels.height]).toEqual([W, H]);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const want = bits[y * rowBytes + (x >> 3)] & (0x80 >> (x & 7)) ? 255 : 0;
        if (pixels.data[(y * W + x) * 4] !== want) throw new Error(`pixel ${x},${y}`);
      }
    }
  });

  it("zlib through CompressionStream, and stored blocks, both inflate", async () => {
    const data = new Uint8Array(150_000).map((_, i) => (i * 31) & 0xff);
    expect(inflateSync(await zlib(data))).toEqual(Buffer.from(data));
    expect(inflateSync(await zlib(data, { compress: false }))).toEqual(Buffer.from(data));
    expect(inflateSync(zlibStored(new Uint8Array(0)))).toEqual(Buffer.alloc(0));
  });

  it("refuses bits that do not fill the picture", async () => {
    await expect(png1(new Uint8Array(10), 100, 100, 300)).rejects.toThrow();
  });

  it("an A4 page at 300 dpi goes through the engine's picture path as a 1-bit image", async () => {
    const photo = synthPhoto(paperOf("word"), PW, PH, BASE, { bg: "desk", seed: 5 });
    const page = renderPage(photo, BASE, "bw", "a4");
    if (page.kind !== "bw") throw new Error("bw is a 1-bit page");
    let t = performance.now();
    const png = await png1(page.bits, page.width, page.height, page.dpi);
    console.log(`1-bit PNG ${page.width}×${page.height}: ${(png.length / 1024).toFixed(0)} KB in ${ms(t)}; stored: ${((await png1(page.bits, page.width, page.height, page.dpi, { compress: false })).length / 1024).toFixed(0)} KB`);
    expect(checkPicture(mupdf, png)).toMatchObject({ orientation: 1, width: 2480, height: 3508 });
    // A one-page A4 PDF, the page placed on it as the app places pictures.
    const doc = new mupdf.PDFDocument();
    let base: Uint8Array;
    try {
      doc.insertPage(-1, doc.addPage([0, 0, 595.2756, 841.8898], 0, {}, ""));
      const buf = doc.saveToBuffer("compress=yes");
      base = buf.asUint8Array().slice();
      buf.destroy();
    } finally {
      doc.destroy();
    }
    const s = new EngineSession(mupdf);
    s.open(base);
    t = performance.now();
    const placed = s.addImage(png, [{ pageIndex: 0, matrix: [595.2756, 0, 0, 841.8898, 0, 0] }], null);
    expect(placed.placed).toEqual([{ pageIndex: 0, imageIndex: 0 }]);
    const out = s.save();
    console.log(`  placed and saved in ${ms(t)}: ${(out.bytes.byteLength / 1024).toFixed(0)} KB`);
    const saved = mupdf.Document.openDocument(new Uint8Array(out.bytes), "application/pdf") as mupdf.PDFDocument;
    try {
      const xobjects = saved.findPage(0).get("Resources").get("XObject");
      const kinds: string[] = [];
      xobjects.forEach((v) => kinds.push(`${v.get("BitsPerComponent")} ${v.get("ColorSpace")} ${v.get("Filter")}`));
      expect(kinds).toEqual(["1 /DeviceGray /CCITTFaxDecode"]);
    } finally {
      saved.destroy();
    }
  });
});

describe("the scan worker's requests (scanJobs)", () => {
  afterEach(() => forgetKept());
  const c = GOOD[1];

  it("analyses pixels, then processes the photo it kept; without it, asks for it", async () => {
    const photo = photoOf(c);
    const [analysed] = await runScanRequest({ op: "analysePixels", photo: 5, pixels: photo });
    expect(analysed).toMatchObject({ image: null, width: PW, height: PH });
    const a = analysed as { corners: Corners; confidence: number };
    expect(cornerError(a.corners, BASE)).toBeLessThanOrEqual(3);
    expect(a.confidence).toBeGreaterThanOrEqual(FOUND_CONFIDENCE);

    // Another photo number: not kept.
    expect((await runScanRequest({ op: "process", photo: 6, corners: a.corners, mode: "document", shape: "a4" }))[0]).toEqual({ missing: true });

    // No canvas in Node: a JPEG page comes back as pixels for the main thread, transferred.
    const [reply, transfer] = await runScanRequest({ op: "process", photo: 5, corners: a.corners, mode: "document", shape: "a4" });
    const r = reply as Extract<ProcessReply, { page: unknown }>;
    expect(r).toMatchObject({ width: 1654, height: 2339, dpi: 200 });
    expect(r.page).toMatchObject({ quality: MODE_SETTINGS.document.quality });
    expect("pixels" in r.page && r.page.pixels.width).toBe(1654);
    expect("pixels" in r.preview && Math.max(r.preview.pixels.width, r.preview.pixels.height)).toBe(PREVIEW_SIDE);
    expect(transfer).toHaveLength(2);

    // B/N: the PNG is made here in any case.
    const [bw] = await runScanRequest({ op: "process", photo: 5, corners: a.corners, mode: "bw", shape: "photo" });
    const b = bw as Extract<ProcessReply, { page: unknown }>;
    expect(b.dpi).toBe(300);
    expect("bytes" in b.page).toBe(true);
    if ("bytes" in b.page) {
      const png = decoded(new Uint8Array(b.page.bytes));
      expect([png.pixels.width, png.pixels.height]).toEqual([b.width, b.height]);
      expect(b.height).toBe(3508);
    }
  });

  it("takes the photo again as pixels, checked", async () => {
    const photo = photoOf(c);
    const [reply] = await runScanRequest({ op: "process", photo: 9, corners: BASE, mode: "grey", shape: "a4", source: photo });
    expect(reply).toMatchObject({ width: 1654, height: 2339, dpi: 200 });
    // ... and keeps it for the next request.
    expect((await runScanRequest({ op: "process", photo: 9, corners: BASE, mode: "original", shape: "a4" }))[0]).not.toHaveProperty("missing", true);
    const bad = { width: 10, height: 10, data: new Uint8ClampedArray(12) };
    const [message] = await replyTo({ id: 3, op: "process", photo: 10, corners: wholeFrame(10, 10), mode: "grey", shape: "a4", source: bad });
    expect(message).toMatchObject({ id: 3, ok: false, code: "failed" });
  });

  it("answers errors with their codes", async () => {
    expect((await replyTo({ id: 1, op: "analyse", photo: 1, blob: new Blob([new Uint8Array(10)]) }))[0]).toMatchObject({ id: 1, ok: false, code: "no-canvas" });
    const photo = photoOf(c);
    await runScanRequest({ op: "analysePixels", photo: 2, pixels: photo });
    const crossed: Corners = [[10, 10], [380, 290], [390, 20], [5, 280]];
    expect((await replyTo({ id: 2, op: "process", photo: 2, corners: crossed, mode: "bw", shape: "a4" }))[0]).toMatchObject({ ok: false, code: "failed" });
    expect((await replyTo({ id: 4, op: "nonsense" } as never))[0]).toMatchObject({ id: 4, ok: false, code: "failed" });
  });

  it("encodeJpeg gives null where there is no canvas", async () => {
    expect(await encodeJpeg({ width: 1, height: 1, data: new Uint8ClampedArray(4) }, 0.8)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// The main-thread client with a fake worker (running scanJobs in this thread, messages cloned
// and buffers transferred as postMessage does) and fake canvases: bitmaps hold pixels, drawing
// scales by nearest neighbour, a "JPEG" is a marker and the RGBA.

const FAKE = new TextEncoder().encode("FAKEPIX\0");
const JPEG_MARK = new TextEncoder().encode("FAKEJPG\0");

/** A photo file in the fake decoder's format. */
function fakePhotoFile(p: Pixels): Blob {
  const head = new Uint8Array(16);
  head.set(FAKE);
  new DataView(head.buffer).setUint32(8, p.width, true);
  new DataView(head.buffer).setUint32(12, p.height, true);
  return new Blob([head, p.data], { type: "image/jpeg" });
}

function readFake(bytes: Uint8Array, mark: Uint8Array): Pixels | null {
  if (bytes.length < 16 || mark.some((b, i) => bytes[i] !== b)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  const width = view.getUint32(8, true), height = view.getUint32(12, true);
  return { width, height, data: new Uint8ClampedArray(bytes.slice(16, 16 + width * height * 4)) };
}

class FakeBitmap {
  closed = false;
  constructor(readonly pixels: Pixels) {}
  get width() { return this.closed ? 0 : this.pixels.width; }
  get height() { return this.closed ? 0 : this.pixels.height; }
  close() { this.closed = true; }
}

class FakeImageData {
  constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {
    if (data.length !== width * height * 4) throw new Error("ImageData size");
  }
}

const drawn = { orientations: [] as unknown[], encodes: 0 };

class FakeCanvas {
  data: Uint8ClampedArray<ArrayBuffer>;
  constructor(public width: number, public height: number) {
    this.data = new Uint8ClampedArray(width * height * 4);
  }
  getContext() {
    const canvas = this;
    return {
      imageSmoothingEnabled: false,
      imageSmoothingQuality: "low",
      fillStyle: "#000000",
      /** A solid "#rgb" or "#rrggbb" fill, opaque. */
      fillRect(x0: number, y0: number, w: number, h: number) {
        const hex = this.fillStyle.slice(1), full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
        const c = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
        for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) canvas.data.set([c[0], c[1], c[2], 255], (y * canvas.width + x) * 4);
      },
      /** Nearest-neighbour scaling, composited "source-over" as a canvas does (a fresh canvas is transparent black). */
      drawImage(src: FakeBitmap, dx: number, dy: number, dw = src.width, dh = src.height) {
        if (src.closed) throw new Error("closed bitmap");
        const s = src.pixels, d = canvas.data;
        for (let y = 0; y < dh; y++) {
          for (let x = 0; x < dw; x++) {
            const sx = Math.min(s.width - 1, Math.floor(((x + 0.5) * s.width) / dw)), sy = Math.min(s.height - 1, Math.floor(((y + 0.5) * s.height) / dh));
            const i = (sy * s.width + sx) * 4, o = ((dy + y) * canvas.width + dx + x) * 4;
            const a = s.data[i + 3] / 255, b = (d[o + 3] / 255) * (1 - a), out = a + b;
            for (let c = 0; c < 3; c++) d[o + c] = out > 0 ? (s.data[i + c] * a + d[o + c] * b) / out : 0;
            d[o + 3] = out * 255;
          }
        }
      },
      getImageData(_x: number, _y: number, w: number, h: number) {
        return new FakeImageData(canvas.data.slice(0, w * h * 4), w, h);
      },
      putImageData(image: FakeImageData) {
        canvas.data.set(image.data);
      },
    };
  }
  async convertToBlob({ type }: { type: string; quality: number }) {
    drawn.encodes++;
    const head = new Uint8Array(16);
    head.set(JPEG_MARK);
    new DataView(head.buffer).setUint32(8, this.width, true);
    new DataView(head.buffer).setUint32(12, this.height, true);
    return new Blob([head, this.data], { type });
  }
  transferToImageBitmap() {
    const b = new FakeBitmap({ width: this.width, height: this.height, data: this.data });
    this.data = new Uint8ClampedArray(this.width * this.height * 4);
    return b;
  }
}

async function fakeCreateImageBitmap(src: unknown, options?: { imageOrientation?: string }) {
  if (src instanceof Blob) {
    drawn.orientations.push(options?.imageOrientation);
    const p = readFake(new Uint8Array(await src.arrayBuffer()), FAKE);
    if (!p) throw new Error("The source image could not be decoded.");
    return new FakeBitmap(p);
  }
  if (src instanceof FakeCanvas) return new FakeBitmap({ width: src.width, height: src.height, data: src.data.slice() });
  throw new Error("unsupported source");
}

/** postMessage's copy: buffers in `transfer` move (the sender's become empty), bitmaps are copied, Blobs shared. */
function carry<T>(value: T, transfer: Transferable[]): T {
  const visit = (v: unknown): unknown => {
    if (v instanceof FakeBitmap) {
      if (v.closed) throw new Error("DataCloneError: closed bitmap");
      const copy = new FakeBitmap({ ...v.pixels, data: v.pixels.data.slice() });
      if (transfer.includes(v as never)) v.close();
      return copy;
    }
    if (v instanceof Blob || v === null || typeof v !== "object") return v;
    if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) {
      const buffer = v instanceof ArrayBuffer ? v : v.buffer;
      return structuredClone(v, { transfer: transfer.includes(buffer as never) ? [buffer as ArrayBuffer] : [] });
    }
    if (Array.isArray(v)) return v.map(visit);
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, visit(x)]));
  };
  return visit(value) as T;
}

const workers: FakeWorker[] = [];
let workerHasCanvas = true;

class FakeWorker {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: { message: string; preventDefault(): void }) => void) | null = null;
  terminated = false;
  requests: { op: string; source?: unknown }[] = [];
  private queue = Promise.resolve();
  constructor(readonly url: string, readonly options: unknown) {
    workers.push(this);
    forgetKept(); // a new worker keeps nothing
  }
  postMessage(message: { op: string; id: number; source?: unknown }, transfer: Transferable[] = []) {
    const data = carry(message, transfer);
    this.requests.push({ op: data.op, source: data.source });
    this.queue = this.queue.then(async () => {
      await new Promise((r) => setTimeout(r, 0));
      if (this.terminated) return;
      const g = globalThis as Record<string, unknown>;
      const canvas = g.OffscreenCanvas;
      if (!workerHasCanvas) delete g.OffscreenCanvas;
      let reply: unknown, out: Transferable[];
      try {
        [reply, out] = await replyTo(data as never);
      } finally {
        g.OffscreenCanvas = canvas;
      }
      if (!this.terminated) this.onmessage?.({ data: carry(reply, out) });
    });
  }
  terminate() {
    this.terminated = true;
  }
  crash() {
    this.onerror?.({ message: "out of memory", preventDefault() {} });
  }
}

describe("scanClient with a fake worker and fake canvases", () => {
  const g = globalThis as Record<string, unknown>;
  const saved: Record<string, unknown> = {};
  let client: typeof import("../src/scan/scanClient");

  beforeAll(async () => {
    for (const k of ["Worker", "OffscreenCanvas", "createImageBitmap", "ImageData"]) saved[k] = g[k];
    g.Worker = FakeWorker;
    g.OffscreenCanvas = FakeCanvas;
    g.createImageBitmap = fakeCreateImageBitmap;
    g.ImageData = FakeImageData;
    client = await import("../src/scan/scanClient");
  });
  afterAll(() => {
    client.disposeScanWorker();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete g[k];
      else g[k] = v;
    }
  });
  afterEach(() => {
    client.disposeScanWorker();
    workerHasCanvas = true;
  });

  const sheet = () => photoOf(GOOD[1]);

  it("exports the contract's names", () => {
    expect(client.FOUND_CONFIDENCE).toBe(FOUND_CONFIDENCE);
    expect(new client.ScanError("x", "too-big")).toBeInstanceOf(ScanError);
    expect(client.cornersUsable(wholeFrame(10, 10), 10, 10)).toBe(true);
  });

  it("analyses a photo in the worker (upright, scaled to the working size) and processes it there", async () => {
    drawn.orientations.length = 0;
    const photo = await client.analysePhoto(fakePhotoFile(sheet()));
    expect(drawn.orientations).toEqual(["from-image"]);
    expect(photo.image).toBeInstanceOf(FakeBitmap);
    expect([photo.width, photo.height, photo.image.width, photo.image.height]).toEqual([PW, PH, PW, PH]);
    expect(cornerError(photo.corners, BASE)).toBeLessThanOrEqual(3);
    expect(photo.confidence).toBeGreaterThanOrEqual(client.FOUND_CONFIDENCE);

    const page = await client.processPhoto(photo, photo.corners, "document", "a4");
    expect(page).toMatchObject({ width: 1654, height: 2339, dpi: 200 });
    expect(readFake(new Uint8Array(page.bytes), JPEG_MARK)).toMatchObject({ width: 1654, height: 2339 });
    expect(page.preview.type).toBe("image/jpeg");
    expect(readFake(new Uint8Array(await page.preview.arrayBuffer()), JPEG_MARK)!.height).toBe(PREVIEW_SIDE);
    const worker = workers.at(-1)!;
    expect(worker.requests.map((r) => r.op)).toEqual(["analyse", "process"]);
    expect(worker.url).toMatch(/^blob:/);

    const bw = await client.processPhoto(photo, photo.corners, "bw", "photo");
    expect(bw.dpi).toBe(300);
    expect(decoded(new Uint8Array(bw.bytes)).pixels.width).toBe(bw.width);
  });

  it("scales a large photo down to WORKING_SIDE", async () => {
    const big = synthPhoto(paperOf("word"), 1800, 4000, [[100, 200], [1700, 220], [1690, 3800], [90, 3780]], { bg: "wood", seed: 2 });
    const photo = await client.analysePhoto(fakePhotoFile(big));
    expect([photo.width, photo.height]).toEqual([1575, WORKING_SIDE]);
    expect(photo.corners.every(([x, y]) => x >= 0 && y >= 0 && x <= 1575 && y <= WORKING_SIDE)).toBe(true);
  });

  it("sends the photo again when the worker no longer has it (another came after it, or a new worker)", async () => {
    const first = await client.analysePhoto(fakePhotoFile(sheet()));
    const second = await client.analysePhoto(fakePhotoFile(photoOf(GOOD[0])));
    expect((await client.processPhoto(first, first.corners, "grey", "a4")).dpi).toBe(200);
    let worker = workers.at(-1)!;
    expect(worker.requests.map((r) => r.op)).toEqual(["analyse", "analyse", "process", "process"]);
    expect(worker.requests[3].source).toBeInstanceOf(FakeBitmap);
    expect((first.image as unknown as FakeBitmap).closed).toBe(false); // sent as a copy: the corner editor keeps it
    client.disposeScanWorker();
    expect(worker.terminated).toBe(true);
    expect((await client.processPhoto(second, second.corners, "original", "a4")).width).toBe(1654);
    worker = workers.at(-1)!;
    expect(worker.requests.map((r) => r.op)).toEqual(["process", "process"]);
  });

  it("says what is wrong: unreadable, too big, corners that make no sheet", async () => {
    await expect(client.analysePhoto(new Blob([new Uint8Array(100)]))).rejects.toMatchObject({ code: "unreadable" });
    await expect(client.analysePhoto(new Blob([]))).rejects.toMatchObject({ code: "unreadable" });
    class Huge extends Blob {
      get size() { return 51 * 1024 * 1024; }
    }
    await expect(client.analysePhoto(new Huge([]))).rejects.toMatchObject({ code: "too-big" });
    const photo = await client.analysePhoto(fakePhotoFile(sheet()));
    const sent = workers.at(-1)!.requests.length;
    await expect(client.processPhoto(photo, [[10, 10], [380, 290], [390, 20], [5, 280]], "bw", "a4")).rejects.toMatchObject({ code: "failed" });
    expect(workers.at(-1)!.requests.length).toBe(sent);
  });

  it("fails what is on its way when the scan closes or the worker stops, and starts again", async () => {
    const photo = await client.analysePhoto(fakePhotoFile(sheet()));
    const pending = client.processPhoto(photo, photo.corners, "document", "a4");
    client.disposeScanWorker();
    await expect(pending).rejects.toMatchObject({ code: "failed" });
    const again = client.analysePhoto(fakePhotoFile(sheet()));
    await Promise.resolve();
    workers.at(-1)!.crash();
    await expect(again).rejects.toMatchObject({ code: "failed" });
    expect(workers.at(-1)!.terminated).toBe(true);
    const last = await client.analysePhoto(fakePhotoFile(sheet()));
    expect(last.width).toBe(PW);
  });

  // Fix round 1 (review finding P22): a picture with transparency (a PNG or WebP from the gallery:
  // an exported page, a signature) is put on white before anything reads it. A fresh canvas is
  // transparent black, and every step after it reads only R, G and B, so the transparent parts
  // came out black in every mode while the corner editor showed them see-through.
  it("puts a transparent picture on white: the corner editor's photo and the page", async () => {
    const W = 600, H = 800, data = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const ink = y > 200 && y < 600 && (y % 40) < 8 && x > 80 && x < 520;
        data.set(ink ? [20, 20, 20, 255] : [255, 255, 255, 0], (y * W + x) * 4); // transparent white around the writing
      }
    }
    const photo = await client.analysePhoto(fakePhotoFile({ width: W, height: H, data }));
    const shown = (photo.image as unknown as FakeBitmap).pixels;
    expect(shown.data[3]).toBe(255); // opaque
    expect([...shown.data.subarray(0, 3)]).toEqual([255, 255, 255]);
    for (const mode of ["document", "original", "bw"] as const) {
      const page = await client.processPhoto(photo, wholeFrame(W, H), mode, "photo");
      const pixels = mode === "bw" ? decoded(new Uint8Array(page.bytes)).pixels : readFake(new Uint8Array(page.bytes), JPEG_MARK)!;
      const corner = pixels.data[(5 * pixels.width + 5) * 4], middle = pixels.data[(Math.floor(pixels.height * 0.9) * pixels.width + (pixels.width >> 1)) * 4];
      expect([mode, corner, middle]).toEqual([mode, 255, 255]);
    }
    photo.image.close();
  });

  // Last: once the worker has said it has no canvas, the client remembers it.
  it("decodes on the main thread when the worker has no canvas, and encodes the JPEG there", async () => {
    workerHasCanvas = false;
    const before = drawn.encodes;
    const photo = await client.analysePhoto(fakePhotoFile(sheet()));
    expect(cornerError(photo.corners, BASE)).toBeLessThanOrEqual(3);
    let worker = workers.at(-1)!;
    expect(worker.requests.map((r) => r.op)).toEqual(["analyse", "analysePixels"]);
    const page = await client.processPhoto(photo, photo.corners, "document", "a4");
    expect(readFake(new Uint8Array(page.bytes), JPEG_MARK)).toMatchObject({ width: 1654, height: 2339 });
    expect(drawn.encodes - before).toBe(2); // the page and its preview, here
    // From now on photos are decoded here at once; a photo the worker lost goes as pixels.
    const next = await client.analysePhoto(fakePhotoFile(photoOf(GOOD[0])));
    client.disposeScanWorker();
    await client.processPhoto(next, next.corners, "bw", "a4");
    worker = workers.at(-1)!;
    expect(worker.requests.map((r) => r.op)).toEqual(["process", "process"]);
    expect((worker.requests[1].source as Pixels).data).toBeInstanceOf(Uint8ClampedArray);
  });
});
