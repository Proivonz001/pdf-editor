// The picture prepared for "Replace…" (src/ui/imageFile.ts): the size it is scaled to, the
// transparency check, and preparePicture's choices with the browser's decoder and canvas
// replaced by fakes (Node has neither): JPEG or PNG, upright, scaled down, closed and revoked,
// retried smaller when too large for the engine, refused when too big or unreadable.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_IMAGE_BYTES } from "../src/engine/protocol";
import {
  fitWithin, hasTransparency, MAX_PICTURE_FILE, MAX_PICTURE_SIDE, PictureError, preparePicture,
} from "../src/ui/imageFile";

describe("fitWithin", () => {
  it("never upscales", () => {
    expect(fitWithin(100, 50, 2000)).toEqual({ width: 100, height: 50 });
    expect(fitWithin(2000, 2000, 2000)).toEqual({ width: 2000, height: 2000 });
  });

  it("brings the longer side to the limit and keeps the proportions", () => {
    expect(fitWithin(4032, 3024, 2000)).toEqual({ width: 2000, height: 1500 });
    expect(fitWithin(3024, 4032, 2000)).toEqual({ width: 1500, height: 2000 });
    expect(fitWithin(3000, 1999, 2000)).toEqual({ width: 2000, height: 1333 });
    expect(fitWithin(2001, 2001, 2000)).toEqual({ width: 2000, height: 2000 });
  });

  it("whole pixels, at least 1, never past the limit", () => {
    expect(fitWithin(100_000, 10, 2000)).toEqual({ width: 2000, height: 1 });
    expect(fitWithin(10, 100_000, 2000)).toEqual({ width: 1, height: 2000 });
    expect(fitWithin(333.3, 100.6, 2000)).toEqual({ width: 333, height: 101 });
    expect(fitWithin(4000, 3000, 1500.9)).toEqual({ width: 1500, height: 1125 });
    for (const [w, h] of [[7919, 104_729], [12_345, 6789], [2999, 2]]) {
      const fit = fitWithin(w, h, MAX_PICTURE_SIDE);
      expect(Math.max(fit.width, fit.height)).toBe(MAX_PICTURE_SIDE);
      expect(Math.min(fit.width, fit.height)).toBeGreaterThanOrEqual(1);
    }
  });

  it("odd input gives 1 × 1 rather than nothing", () => {
    expect(fitWithin(0, 0, 2000)).toEqual({ width: 1, height: 1 });
    expect(fitWithin(Number.NaN, 5, 2000)).toEqual({ width: 1, height: 5 });
    expect(fitWithin(50, 50, 0)).toEqual({ width: 1, height: 1 });
  });
});

describe("hasTransparency", () => {
  it("reads the alpha of every pixel", () => {
    expect(hasTransparency(new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255]))).toBe(false);
    expect(hasTransparency(new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 254]))).toBe(true);
    expect(hasTransparency(new Uint8ClampedArray([255, 255, 255, 0]))).toBe(true);
    expect(hasTransparency(new Uint8ClampedArray([]))).toBe(false);
  });
});

/** A File as preparePicture reads it: only its size and type matter (the decoder is fake). */
const picture = (type: string, size = 1000) => ({ name: "photo", type, size }) as unknown as File;

interface Fakes {
  bitmaps: { width: number; height: number; closed: boolean }[];
  orientations: unknown[];
  canvases: { width: number; height: number }[];
  draws: unknown[][];
  alphaReads: number;
  encodes: { type: string; quality: number; width: number; height: number }[];
}

/**
 * Fake createImageBitmap and OffscreenCanvas. `opaque` sets the alpha getImageData returns;
 * `sizes` the byte sizes of the successive encoded blobs.
 */
function fakeBrowser(opts: { width: number; height: number; opaque: boolean; sizes?: number[]; decodeFails?: boolean }): Fakes {
  const fakes: Fakes = { bitmaps: [], orientations: [], canvases: [], draws: [], alphaReads: 0, encodes: [] };
  vi.stubGlobal("createImageBitmap", async (_file: unknown, options: { imageOrientation?: string }) => {
    fakes.orientations.push(options?.imageOrientation);
    if (opts.decodeFails) throw new DOMException("The source image could not be decoded.", "InvalidStateError");
    const bitmap = { width: opts.width, height: opts.height, closed: false, close() { bitmap.closed = true; } };
    fakes.bitmaps.push(bitmap);
    return bitmap;
  });
  class FakeOffscreenCanvas {
    constructor(public width: number, public height: number) {
      fakes.canvases.push({ width, height });
    }
    getContext() {
      return {
        imageSmoothingQuality: "low",
        drawImage: (...args: unknown[]) => { fakes.draws.push(args); },
        getImageData: (_x: number, _y: number, w: number, h: number) => {
          fakes.alphaReads++;
          const data = new Uint8ClampedArray(w * h * 4).fill(255);
          if (!opts.opaque) data[data.length - 1] = 128;
          return { data };
        },
      };
    }
    async convertToBlob(options: { type: string; quality: number }) {
      const size = opts.sizes?.[fakes.encodes.length] ?? 1234;
      fakes.encodes.push({ ...options, width: this.width, height: this.height });
      return { size, type: options.type, arrayBuffer: async () => new Uint8Array([9, 8, 7]).buffer };
    }
  }
  vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
  return fakes;
}

describe("preparePicture", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("an opaque photo: upright, scaled to 2000 px, JPEG at 0.85, the bitmap closed", async () => {
    const fakes = fakeBrowser({ width: 4032, height: 3024, opaque: true });
    const result = await preparePicture(picture("image/heic"));
    expect(result.width).toBe(2000);
    expect(result.height).toBe(1500);
    expect(new Uint8Array(result.bytes)).toEqual(new Uint8Array([9, 8, 7]));
    expect(fakes.orientations).toEqual(["from-image"]);
    expect(fakes.canvases).toEqual([{ width: 2000, height: 1500 }]);
    expect(fakes.draws[0].slice(1)).toEqual([0, 0, 2000, 1500]);
    expect(fakes.encodes).toEqual([{ type: "image/jpeg", quality: 0.85, width: 2000, height: 1500 }]);
    expect(fakes.bitmaps[0].closed).toBe(true);
  });

  it("a transparent pixel makes it a PNG; a small picture keeps its size", async () => {
    const fakes = fakeBrowser({ width: 300, height: 120, opaque: false });
    const result = await preparePicture(picture("image/png"));
    expect([result.width, result.height]).toEqual([300, 120]);
    expect(fakes.encodes.map((e) => e.type)).toEqual(["image/png"]);
    expect(fakes.bitmaps[0].closed).toBe(true);
  });

  it("a JPEG has no transparency to look for", async () => {
    const fakes = fakeBrowser({ width: 800, height: 600, opaque: false });
    await preparePicture(picture("image/jpeg"));
    expect(fakes.alphaReads).toBe(0);
    expect(fakes.encodes.map((e) => e.type)).toEqual(["image/jpeg"]);
  });

  it("too large for the engine once encoded: tried again smaller until it fits", async () => {
    const fakes = fakeBrowser({ width: 4000, height: 4000, opaque: false, sizes: [MAX_IMAGE_BYTES + 1, MAX_IMAGE_BYTES + 1, 5000] });
    const result = await preparePicture(picture("image/webp"));
    expect(fakes.encodes.map((e) => [e.width, e.height])).toEqual([[2000, 2000], [1500, 1500], [1125, 1125]]);
    expect(fakes.encodes.every((e) => e.type === "image/png")).toBe(true);
    expect(fakes.alphaReads).toBe(1); // read once, at the first size
    expect([result.width, result.height]).toEqual([1125, 1125]);
  });

  it("refuses a file over 50 MB before decoding it", async () => {
    const fakes = fakeBrowser({ width: 10, height: 10, opaque: true });
    const error = await preparePicture(picture("image/png", MAX_PICTURE_FILE + 1)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PictureError);
    expect((error as PictureError).code).toBe("too-big");
    expect(fakes.orientations).toEqual([]);
    await expect(preparePicture(picture("image/png", MAX_PICTURE_FILE))).resolves.toBeTruthy();
  });

  it("not decoded by createImageBitmap: an <img> is tried, and its URL revoked", async () => {
    fakeBrowser({ width: 10, height: 10, opaque: true, decodeFails: true });
    const revoked: string[] = [];
    vi.stubGlobal("URL", Object.assign(Object.create(URL), {
      createObjectURL: () => "blob:picture",
      revokeObjectURL: (url: string) => { revoked.push(url); },
    }));
    let works = true;
    class FakeImage {
      naturalWidth = 640;
      naturalHeight = 480;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_url: string) {
        setTimeout(() => (works ? this.onload?.() : this.onerror?.()), 0);
      }
    }
    vi.stubGlobal("Image", FakeImage);
    const result = await preparePicture(picture("image/heic"));
    expect([result.width, result.height]).toEqual([640, 480]);
    expect(revoked).toEqual(["blob:picture"]);

    works = false;
    const error = await preparePicture(picture("image/heic")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PictureError);
    expect((error as PictureError).code).toBe("unreadable");
    expect(revoked).toEqual(["blob:picture", "blob:picture"]);
  });

  it("an empty picture or a failing canvas is unreadable, and the bitmap is still closed", async () => {
    let fakes = fakeBrowser({ width: 0, height: 0, opaque: true });
    await expect(preparePicture(picture("image/png"))).rejects.toMatchObject({ code: "unreadable" });
    expect(fakes.bitmaps[0].closed).toBe(true);

    fakes = fakeBrowser({ width: 10, height: 10, opaque: true });
    const Canvas = (globalThis as any).OffscreenCanvas;
    vi.stubGlobal("OffscreenCanvas", class extends Canvas {
      async convertToBlob() { throw new DOMException("out of memory", "EncodingError"); }
    });
    const error = await preparePicture(picture("image/png")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PictureError);
    expect((error as PictureError).code).toBe("unreadable");
    expect(fakes.bitmaps[0].closed).toBe(true);
  });
});
