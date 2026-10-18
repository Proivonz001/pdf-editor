// What the scan worker does with each request (scanWorker.ts only passes messages): decode and
// analyse a photo, or turn it into a page. Kept apart from the worker's message handler so the
// tests run it in Node, where there is no canvas: there "analyse" answers "no-canvas" and JPEG
// pages come back as pixels, exactly as in a browser whose workers have no OffscreenCanvas.
//
// Memory: the worker keeps the pixels of one photo, the last one analysed or processed (about
// 37 MB at the working size), so processing it, or processing it again in another mode, needs
// no second decode; analysing the next photo lets it go first. Each page's buffers are released
// once encoded. The worker itself is terminated when the scan flow closes (scanClient.ts).
import { MAX_IMAGE_BYTES } from "../engine/protocol";
import { detectSheet, FOUND_CONFIDENCE } from "./detect";
import { decodePhoto, encodeJpeg, NoCanvas, pixelsOf } from "./encode";
import { previewOf, renderPage } from "./pipeline";
import { png1 } from "./png1";
import { PREVIEW_QUALITY, WORKING_SIDE, wholeFrame } from "./sizes";
import {
  ScanError, type AnalyseReply, type Pixels, type ProcessReply, type ScanOutput, type ScanReplyMessage, type ScanRequest,
} from "./types";

let kept: { photo: number; pixels: Pixels } | null = null;

/** Let go of the photo the worker keeps (tests; the worker itself simply ends). */
export function forgetKept(): void {
  kept = null;
}

const isPixels = (v: unknown): v is Pixels =>
  typeof v === "object" && v !== null && "data" in v && (v as Pixels).data instanceof Uint8ClampedArray;

/** Pixels sent by the main thread, checked: whole sizes and RGBA filling them. */
function checked(p: Pixels): Pixels {
  if (!(Number.isInteger(p.width) && Number.isInteger(p.height) && p.width > 0 && p.height > 0) || p.data.length !== p.width * p.height * 4) {
    throw new ScanError("The photo's pixels do not match its size", "failed");
  }
  return p;
}

/** The sheet found in `pixels`, kept as the worker's photo; the whole frame when not found or not sure. */
function analyse(photo: number, pixels: Pixels, image: ImageBitmap | null): AnalyseReply {
  kept = { photo, pixels };
  const found = detectSheet(pixels);
  const sure = found.corners !== null && found.confidence >= FOUND_CONFIDENCE;
  return {
    image,
    width: pixels.width,
    height: pixels.height,
    corners: sure ? found.corners! : wholeFrame(pixels.width, pixels.height),
    confidence: found.confidence,
  };
}

/** A picture encoded here when there is a canvas, else its pixels for the main thread. */
async function jpegOut(pixels: Pixels, quality: number, transfer: Transferable[]): Promise<ScanOutput> {
  const bytes = await encodeJpeg(pixels, quality);
  if (bytes) {
    transfer.push(bytes);
    return { bytes };
  }
  transfer.push(pixels.data.buffer);
  return { pixels, quality };
}

/** Run one request; the result and the buffers to transfer with it. Throws ScanError or NoCanvas. */
export async function runScanRequest(req: ScanRequest): Promise<[AnalyseReply | ProcessReply, Transferable[]]> {
  switch (req.op) {
    case "analyse": {
      kept = null; // the previous photo goes before the next one is decoded
      const { pixels, image } = await decodePhoto(req.blob, WORKING_SIDE);
      return [analyse(req.photo, pixels, image), [image]];
    }
    case "analysePixels":
      kept = null;
      return [analyse(req.photo, checked(req.pixels), null), []];
    case "process": {
      let pixels = kept?.photo === req.photo ? kept.pixels : null;
      if (req.source) {
        if (isPixels(req.source)) pixels = checked(req.source);
        else {
          try {
            pixels = await pixelsOf(req.source);
          } finally {
            req.source.close();
          }
        }
        kept = { photo: req.photo, pixels };
      }
      if (!pixels) return [{ missing: true }, []];
      const transfer: Transferable[] = [];
      const rendered = renderPage(pixels, req.corners, req.mode, req.shape);
      const preview = await jpegOut(previewOf(rendered), PREVIEW_QUALITY, transfer);
      let page: ScanOutput, width: number, height: number;
      if (rendered.kind === "bw") {
        const bytes = (await png1(rendered.bits, rendered.width, rendered.height, rendered.dpi)).buffer;
        transfer.push(bytes);
        page = { bytes };
        ({ width, height } = rendered);
      } else {
        page = await jpegOut(rendered.pixels, rendered.quality, transfer);
        ({ width, height } = rendered.pixels);
      }
      if ("bytes" in page && page.bytes.byteLength > MAX_IMAGE_BYTES) throw new ScanError("The page is too large for the PDF", "failed");
      return [{ page, width, height, dpi: rendered.dpi, preview }, transfer];
    }
    default:
      throw new ScanError(`Unknown scan request ${(req as { op: unknown }).op}`, "failed");
  }
}

/**
 * The reply message to request `id` and what to transfer with it: the result, or the error's
 * code (a ScanError code, "no-canvas" when the photo must be decoded on the main thread,
 * "failed" for anything else, out of memory included).
 */
export async function replyTo(req: ScanRequest & { id: number }): Promise<[ScanReplyMessage, Transferable[]]> {
  try {
    const [result, transfer] = await runScanRequest(req);
    return [{ id: req.id, ok: true, result }, transfer];
  } catch (err) {
    const code = err instanceof ScanError ? err.code : err instanceof NoCanvas ? "no-canvas" : "failed";
    return [{ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err), code }, []];
  }
}
