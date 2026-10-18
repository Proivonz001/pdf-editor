// The canvas work of the scan pipeline: decoding a photo upright and scaled to the working size,
// reading an ImageBitmap's pixels, and JPEG encoding. The scan worker uses an OffscreenCanvas;
// a browser whose workers have none (Safari before 16.4) gets the same work done on the main
// thread with a <canvas> (scanClient.ts falls back to it). Where there is no canvas at all
// (Node), encodeJpeg gives null and the decoders throw NoCanvas.
//
// Photos are decoded by the browser, so whatever it can show works (HEIC on Safari, WebP...),
// with the EXIF orientation applied (createImageBitmap's imageOrientation "from-image"; an <img>
// does it by itself): the detector needs the photo upright, and MuPDF would not turn it. The
// photo is drawn straight at the working size, so a 12 MP (or 200 MP) photo never exists at full
// size on a canvas (iOS refuses canvases over 16.7 MP), and on white, so a picture with
// transparency is opaque from there on (the pipeline reads only R, G and B).
import { fitSide } from "./sizes";
import { ScanError, type Pixels } from "./types";

/** No canvas here: the work must be done elsewhere (the main thread). */
export class NoCanvas extends Error {
  constructor() {
    super("No 2D canvas in this context");
    this.name = "NoCanvas";
  }
}

type Surface =
  | { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D }
  | { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D };

/** An OffscreenCanvas with a 2D context, or a <canvas> where there is a document; null where neither exists. */
function surface(width: number, height: number): Surface | null {
  if (typeof OffscreenCanvas === "function") {
    try {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d");
      if (ctx) return { canvas, ctx };
    } catch {
      // No 2D context in this OffscreenCanvas: try a <canvas>.
    }
  }
  if (typeof document !== "undefined" && typeof document.createElement === "function") {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (ctx) return { canvas, ctx };
  }
  return null;
}

/** A <canvas> gives its memory back at once with a zero size (iOS keeps it otherwise). */
function release(s: Surface) {
  if (!("convertToBlob" in s.canvas)) s.canvas.width = s.canvas.height = 0;
}

/** Whether this context can draw at all (checked before decoding, so a worker with no canvas does not decode for nothing). */
export function canDraw(): boolean {
  const s = surface(1, 1);
  if (!s) return false;
  release(s);
  return true;
}

interface Opened {
  source: CanvasImageSource;
  width: number;
  height: number;
  release(): void;
}

/** Decode with createImageBitmap, upright; through an <img> where that refuses the file and there is a document (older Safari with HEIC). */
async function open(blob: Blob): Promise<Opened> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
    } catch {
      // Not decoded here: an <img> may still manage it.
    }
  }
  if (typeof document === "undefined" || typeof Image !== "function") throw new ScanError("The picture could not be decoded", "unreadable");
  const url = URL.createObjectURL(blob);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ source: img, width: img.naturalWidth, height: img.naturalHeight, release: () => URL.revokeObjectURL(url) });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new ScanError("The picture could not be decoded", "unreadable"));
    };
    img.src = url;
  });
}

/**
 * The photo in `blob`, upright, scaled down to at most `maxSide` pixels on its longer side: its
 * pixels (for the detector and the warp) and the same picture as an ImageBitmap (for the corner
 * editor). Throws ScanError("unreadable") when it cannot be decoded, NoCanvas when there is no
 * canvas here.
 */
export async function decodePhoto(blob: Blob, maxSide: number): Promise<{ pixels: Pixels; image: ImageBitmap }> {
  if (!canDraw()) throw new NoCanvas();
  const picture = await open(blob);
  try {
    if (!(picture.width > 0 && picture.height > 0)) throw new ScanError("The picture is empty", "unreadable");
    const { width, height } = fitSide(picture.width, picture.height, maxSide);
    const s = surface(width, height);
    if (!s) throw new NoCanvas();
    try {
      // On white first: a picture with transparency (a PNG or WebP from the gallery) would
      // otherwise be transparent black where it is see-through, and every later step reads only
      // R, G and B (photos are taken as opaque). The editor's bitmap is then the same opaque photo.
      s.ctx.fillStyle = "#ffffff";
      s.ctx.fillRect(0, 0, width, height);
      s.ctx.imageSmoothingEnabled = true;
      s.ctx.imageSmoothingQuality = "high";
      s.ctx.drawImage(picture.source, 0, 0, width, height);
      const data = s.ctx.getImageData(0, 0, width, height).data;
      const image = "transferToImageBitmap" in s.canvas ? s.canvas.transferToImageBitmap() : await createImageBitmap(s.canvas);
      return { pixels: { width, height, data }, image };
    } finally {
      release(s);
    }
  } catch (e) {
    if (e instanceof ScanError || e instanceof NoCanvas) throw e;
    // Drawing or reading it back refused it (out of memory, a tainted canvas...).
    throw new ScanError(e instanceof Error ? e.message : String(e), "unreadable");
  } finally {
    picture.release();
  }
}

/** The pixels of `bitmap` at its own size. Throws NoCanvas when there is no canvas here. */
export async function pixelsOf(bitmap: ImageBitmap): Promise<Pixels> {
  const { width, height } = bitmap;
  if (!(width > 0 && height > 0)) throw new ScanError("The photo is no longer available", "failed");
  const s = surface(width, height);
  if (!s) throw new NoCanvas();
  try {
    s.ctx.drawImage(bitmap, 0, 0);
    return { width, height, data: s.ctx.getImageData(0, 0, width, height).data };
  } finally {
    release(s);
  }
}

/**
 * `page` as a JPEG at `quality` (0..1), or null when there is no canvas here (the caller then
 * hands the pixels to the main thread). A canvas writes a colour JPEG even for a grey page; its
 * empty colour channels add only a few per cent.
 */
export async function encodeJpeg(page: Pixels, quality: number): Promise<ArrayBuffer | null> {
  const s = surface(page.width, page.height);
  if (!s) return null;
  try {
    s.ctx.putImageData(new ImageData(page.data, page.width, page.height), 0, 0);
    let blob: Blob | null;
    if ("convertToBlob" in s.canvas) blob = await s.canvas.convertToBlob({ type: "image/jpeg", quality });
    else {
      const canvas = s.canvas;
      blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    }
    // A browser that cannot write JPEG writes PNG instead: not what the page needs.
    if (!blob || blob.size === 0 || blob.type !== "image/jpeg") throw new ScanError("The page could not be encoded as JPEG", "failed");
    return await blob.arrayBuffer();
  } finally {
    release(s);
  }
}
