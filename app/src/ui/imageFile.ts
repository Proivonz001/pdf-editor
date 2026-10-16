// The picture that replaces an image (Replace… in the image's context bar), read from the file
// the user picked: a photo from the camera or the gallery, a screenshot, a PNG with transparency.
// It is decoded by the browser, so whatever the browser can show works (HEIC on Safari, WebP,
// GIF...), turned upright (phones store photos sideways with an EXIF orientation that MuPDF does
// not read), scaled down to MAX_PICTURE_SIDE pixels on its longer side, and encoded again: as
// PNG when some pixel is transparent, as JPEG otherwise. The engine gets one of the two formats
// it embeds as they are, and a 12-megapixel photo does not add 10 MB to the PDF.
import { MAX_IMAGE_BYTES } from "../engine/protocol";

/** Longer side of the picture written into the PDF, in pixels (over 170 ppi across a whole A4 page). */
export const MAX_PICTURE_SIDE = 2000;
/** Largest file accepted from the picker, in bytes (before it is scaled down). */
export const MAX_PICTURE_FILE = 50 * 1024 * 1024;
const JPEG_QUALITY = 0.85;
/** A picture still larger than MAX_IMAGE_BYTES once encoded is tried again with its sides times this. */
const RETRY_SHRINK = 0.75;

export class PictureError extends Error {
  constructor(message: string, readonly code: "too-big" | "unreadable") {
    super(message);
  }
}

/** `width` × `height` scaled down (never up) so that neither side is longer than `max`: whole pixels, at least 1. */
export function fitWithin(width: number, height: number, max: number): { width: number; height: number } {
  const w = Number.isFinite(width) && width > 0 ? width : 1;
  const h = Number.isFinite(height) && height > 0 ? height : 1;
  const limit = Math.max(1, Math.floor(max));
  const scale = Math.min(1, limit / Math.max(w, h));
  const side = (v: number) => Math.min(limit, Math.max(1, Math.round(v * scale)));
  return { width: side(w), height: side(h) };
}

/** Some pixel of these RGBA bytes is not fully opaque. */
export function hasTransparency(rgba: ArrayLike<number>): boolean {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] < 255) return true;
  return false;
}

/** A decoded picture the canvas can draw, and how to let it go. */
interface Decoded {
  source: CanvasImageSource;
  width: number;
  height: number;
  release(): void;
}

/** Decode with createImageBitmap, or through an <img> where that refuses the file (older Safari with HEIC). */
async function decode(file: File): Promise<Decoded> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
    } catch {
      // Not decoded here: an <img> may still manage it.
    }
  }
  const url = URL.createObjectURL(file);
  return new Promise((resolve, reject) => {
    const img = new Image();
    // An <img> follows the EXIF orientation by itself (CSS image-orientation: from-image).
    img.onload = () => resolve({
      source: img, width: img.naturalWidth, height: img.naturalHeight, release: () => URL.revokeObjectURL(url),
    });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new PictureError("The picture could not be decoded", "unreadable"));
    };
    img.src = url;
  });
}

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
  if (!ctx) throw new PictureError("No 2D canvas", "unreadable");
  return { canvas, ctx };
}

function encode(s: Surface, type: string): Promise<Blob | null> {
  if ("convertToBlob" in s.canvas) return s.canvas.convertToBlob({ type, quality: JPEG_QUALITY });
  const canvas = s.canvas;
  return new Promise((resolve) => canvas.toBlob(resolve, type, JPEG_QUALITY));
}

/** Read the picture's alpha; when that is refused, count it as transparent (PNG keeps everything). */
function transparent(s: Surface, width: number, height: number): boolean {
  try {
    return hasTransparency(s.ctx.getImageData(0, 0, width, height).data);
  } catch {
    return true;
  }
}

/**
 * Turn the picked file into the bytes sent to replaceImage: upright, at most MAX_PICTURE_SIDE
 * pixels on its longer side, PNG when it has transparent pixels and JPEG otherwise, and within
 * the engine's MAX_IMAGE_BYTES (a PNG that comes out larger is made smaller until it fits).
 * Throws PictureError: "too-big" for a file over MAX_PICTURE_FILE, "unreadable" when the
 * browser cannot decode or draw it.
 */
export async function preparePicture(file: File): Promise<{ bytes: ArrayBuffer; width: number; height: number }> {
  if (file.size > MAX_PICTURE_FILE) throw new PictureError("The picture file is too large", "too-big");
  const picture = await decode(file);
  try {
    if (!(picture.width > 0 && picture.height > 0)) throw new PictureError("The picture is empty", "unreadable");
    let size = fitWithin(picture.width, picture.height, MAX_PICTURE_SIDE);
    // Read once, at the first size: scaling down neither adds nor removes transparency. A JPEG
    // has none.
    let png: boolean | null = file.type === "image/jpeg" ? false : null;
    for (;;) {
      const s = surface(size.width, size.height);
      let blob: Blob | null;
      try {
        s.ctx.imageSmoothingQuality = "high";
        s.ctx.drawImage(picture.source, 0, 0, size.width, size.height);
        png ??= transparent(s, size.width, size.height);
        blob = await encode(s, png ? "image/png" : "image/jpeg");
      } finally {
        // A <canvas> gives its memory back at once with a zero size (iOS keeps it otherwise).
        if (!("convertToBlob" in s.canvas)) s.canvas.width = s.canvas.height = 0;
      }
      if (!blob || blob.size === 0) throw new PictureError("The picture could not be encoded", "unreadable");
      if (blob.size <= MAX_IMAGE_BYTES) return { bytes: await blob.arrayBuffer(), width: size.width, height: size.height };
      if (size.width === 1 && size.height === 1) throw new PictureError("The picture could not be made small enough", "unreadable");
      size = fitWithin(size.width, size.height, Math.max(size.width, size.height) * RETRY_SHRINK);
    }
  } catch (e) {
    if (e instanceof PictureError) throw e;
    // Drawing or encoding refused it (out of memory, a tainted canvas...).
    throw new PictureError(e instanceof Error ? e.message : String(e), "unreadable");
  } finally {
    picture.release();
  }
}
