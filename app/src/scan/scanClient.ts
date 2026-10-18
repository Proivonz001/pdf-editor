// The scan pipeline's main-thread side (release 4, "Foto e scansione"): the scan flow calls
// analysePhoto for each photo (decoded upright, scaled to the working size, the sheet found),
// lets the user check the corners, then processPhoto turns it into a page (PagePicture) for the
// engine, with a small preview for the tray. The work runs in the scan worker, started on demand
// from a same-origin blob: module, as the engine is (src/engine/client.ts says why: it inherits
// the page's Content-Security-Policy on any host), and terminated by disposeScanWorker when the
// flow closes, which frees its memory (pixel buffers, a canvas, the decoded photo).
//
// Fallbacks, so the flow works where the worker cannot do everything:
// - a worker without OffscreenCanvas (Safari before 16.4) cannot decode a photo into pixels or
//   write a JPEG: the photo is decoded here with a <canvas> and its pixels sent to the worker,
//   and JPEG pages come back as pixels to encode here;
// - a photo the worker cannot decode (createImageBitmap refuses it) is tried here, where an <img>
//   may still read it (older Safari with HEIC); in Chrome a HEIC stays "unreadable".
import type { PagePicture } from "../engine/protocol";
import { MAX_IMAGE_BYTES } from "../engine/protocol";
import { MAX_PICTURE_FILE } from "../ui/imageFile";
import { FOUND_CONFIDENCE } from "./detect";
import { decodePhoto, encodeJpeg, NoCanvas, pixelsOf } from "./encode";
import { cornersUsable, WORKING_SIDE } from "./sizes";
import {
  ScanError, type AnalyseReply, type Corners, type PageShape, type Pixels, type ProcessReply, type ScanMode, type ScanOutput,
  type ScanReplyMessage, type ScanRequest,
} from "./types";
// The URL of the worker chunk: Vite bundles scanWorker.ts as a worker entry for this import.
import scanWorkerPath from "./scanWorker.ts?worker&url";

export { cornersUsable, FOUND_CONFIDENCE, ScanError };
export type { Corners, PageShape, Point, ScanMode } from "./types";

export interface AnalysedPhoto {
  /**
   * The photo upright (EXIF applied) and scaled to a long side ≤ 3500 px, for the corner editor.
   * Keep it open until processPhoto has answered (it may be sent to the worker again); close it
   * when the photo is done with.
   */
  image: ImageBitmap;
  width: number;
  height: number;
  /** Found corners, or the whole frame when not found or not sure. */
  corners: Corners;
  /** 0..1; below FOUND_CONFIDENCE the corners are the whole frame and the UI says "Non ho trovato i bordi: spostali tu." */
  confidence: number;
}

/** A failure inside the worker, with its code (a ScanError code or "no-canvas"). */
class WorkerFailure extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
  }
}

class ScanWorker {
  private worker: Worker;
  private blobUrl: string | null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  /** Set once the worker has failed or been terminated: calls fail at once and a new worker is started. */
  dead = false;

  constructor() {
    const url = new URL(scanWorkerPath, import.meta.url).href;
    this.blobUrl = URL.createObjectURL(new Blob([`import ${JSON.stringify(url)};`], { type: "text/javascript" }));
    this.worker = new Worker(this.blobUrl, { type: "module" });
    this.worker.onmessage = ({ data }: MessageEvent<ScanReplyMessage>) => {
      this.revoke(); // the module has loaded: the blob URL is not needed
      const p = this.pending.get(data.id);
      if (!p) return;
      this.pending.delete(data.id);
      if (data.ok) p.resolve(data.result);
      else p.reject(new WorkerFailure(data.error, data.code));
    };
    this.worker.onerror = (e) => {
      e.preventDefault();
      this.stop(new ScanError(e.message || "The scan stopped", "failed"));
    };
  }

  private revoke() {
    if (this.blobUrl) URL.revokeObjectURL(this.blobUrl);
    this.blobUrl = null;
  }

  call<T>(req: ScanRequest, transfer: Transferable[] = []): Promise<T> {
    if (this.dead) return Promise.reject(new ScanError("The scan stopped", "failed"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      try {
        this.worker.postMessage({ ...req, id }, transfer);
      } catch (e) {
        this.pending.delete(id);
        reject(new ScanError(e instanceof Error ? e.message : String(e), "failed"));
      }
    });
  }

  /** Terminate the worker; what was still on its way fails with `reason`. */
  stop(reason: Error) {
    this.dead = true;
    this.worker.terminate();
    this.revoke();
    for (const p of this.pending.values()) p.reject(reason);
    this.pending.clear();
  }
}

let current: ScanWorker | null = null;
/** False once the worker has said it has no canvas: photos are then decoded here. */
let workerDecodes = true;
/** Photo numbers, never reused (also across workers), and the number each analysed photo has. */
let nextPhoto = 1;
const photoNumbers = new WeakMap<AnalysedPhoto, number>();

function scanWorker(): ScanWorker {
  if (!current || current.dead) current = new ScanWorker();
  return current;
}

/** Terminate the scan worker (when the scan flow closes): its memory goes, and anything still on its way fails. */
export function disposeScanWorker(): void {
  current?.stop(new ScanError("The scan was closed", "failed"));
  current = null;
}

const codeOf = (e: unknown) => (e instanceof WorkerFailure || e instanceof ScanError ? e.code : null);

/** `e` as the ScanError the flow shows. */
function scanError(e: unknown): ScanError {
  if (e instanceof ScanError) return e;
  const code = codeOf(e);
  const message = e instanceof Error ? e.message : String(e);
  return new ScanError(message, code === "unreadable" || code === "too-big" ? code : "failed");
}

function photo(number: number, reply: AnalyseReply, image: ImageBitmap): AnalysedPhoto {
  const p: AnalysedPhoto = { image, width: reply.width, height: reply.height, corners: reply.corners, confidence: reply.confidence };
  photoNumbers.set(p, number);
  return p;
}

/**
 * Read a photo (from the camera or the gallery) and find the sheet in it. Throws ScanError:
 * "too-big" for a file over MAX_PICTURE_FILE (50 MB, as for any picture), "unreadable" when this
 * browser cannot decode it (HEIC outside Safari, a damaged file), "failed" otherwise.
 */
export async function analysePhoto(file: Blob): Promise<AnalysedPhoto> {
  if (!(file instanceof Blob) || file.size === 0) throw new ScanError("The picture is empty", "unreadable");
  if (file.size > MAX_PICTURE_FILE) throw new ScanError("The picture file is too large", "too-big");
  const number = nextPhoto++;
  if (workerDecodes) {
    try {
      const reply = await scanWorker().call<AnalyseReply>({ op: "analyse", photo: number, blob: file });
      if (reply.image) return photo(number, reply, reply.image);
    } catch (e) {
      const code = codeOf(e);
      if (code === "no-canvas") workerDecodes = false;
      // Unreadable there: an <img> here may still read it.
      else if (code !== "unreadable") throw scanError(e);
    }
  }
  let decoded: { pixels: Pixels; image: ImageBitmap };
  try {
    decoded = await decodePhoto(file, WORKING_SIDE);
  } catch (e) {
    if (e instanceof NoCanvas) throw new ScanError("This browser cannot draw the picture", "unreadable");
    throw scanError(e);
  }
  try {
    const reply = await scanWorker().call<AnalyseReply>(
      { op: "analysePixels", photo: number, pixels: decoded.pixels }, [decoded.pixels.data.buffer],
    );
    return photo(number, reply, decoded.image);
  } catch (e) {
    decoded.image.close();
    throw scanError(e);
  }
}

/** A worker's picture as bytes: as it came, or encoded here when the worker sent pixels. */
async function bytesOf(out: ScanOutput): Promise<ArrayBuffer> {
  if ("bytes" in out) return out.bytes;
  const bytes = await encodeJpeg(out.pixels, out.quality);
  if (!bytes) throw new ScanError("This browser cannot encode the page", "failed");
  return bytes;
}

/**
 * Turn the sheet at `corners` (in `photo`'s pixels, TL TR BR BL) into a page: straightened to
 * the page shape, cleaned up by `mode`, encoded (JPEG; 1-bit PNG for "bw") at the mode's
 * resolution. Returns the PagePicture for the engine (`bytes` to transfer) and a small JPEG
 * preview for the tray. Throws ScanError("failed") when the corners do not make a sheet
 * (cornersUsable) or the page cannot be made.
 */
export async function processPhoto(
  photoIn: AnalysedPhoto, corners: Corners, mode: ScanMode, shape: PageShape,
): Promise<PagePicture & { preview: Blob }> {
  if (!cornersUsable(corners, photoIn.width, photoIn.height)) throw new ScanError("The corners do not make a sheet", "failed");
  let number = photoNumbers.get(photoIn);
  if (number === undefined) {
    number = nextPhoto++;
    photoNumbers.set(photoIn, number);
  }
  const request: ScanRequest = {
    op: "process", photo: number, mode, shape,
    corners: corners.map(([x, y]) => [x, y]) as Corners,
  };
  try {
    let reply = await scanWorker().call<ProcessReply>(request);
    // The worker no longer has the photo (another one came after it, or the worker is new): send
    // it, as a bitmap, or as pixels when the worker cannot read one.
    for (let attempt = 0; reply.missing && attempt < 2; attempt++) {
      try {
        if (workerDecodes) {
          reply = await scanWorker().call<ProcessReply>({ ...request, source: photoIn.image });
        } else {
          const pixels = await pixelsOf(photoIn.image);
          reply = await scanWorker().call<ProcessReply>({ ...request, source: pixels }, [pixels.data.buffer]);
        }
      } catch (e) {
        if (codeOf(e) !== "no-canvas") throw e;
        workerDecodes = false;
      }
    }
    if (reply.missing) throw new ScanError("The photo could not be sent to the scan", "failed");
    const bytes = await bytesOf(reply.page);
    if (bytes.byteLength > MAX_IMAGE_BYTES) throw new ScanError("The page is too large for the PDF", "failed");
    const preview = await bytesOf(reply.preview);
    return { bytes, width: reply.width, height: reply.height, dpi: reply.dpi, preview: new Blob([preview], { type: "image/jpeg" }) };
  } catch (e) {
    if (e instanceof NoCanvas) throw new ScanError("This browser cannot draw the photo", "failed");
    throw scanError(e);
  }
}
