// The scan pipeline's shared types (release 4, "Foto e scansione"): the corners of a sheet in a
// photo, the modes and page shapes the user picks, the pixels the steps pass along, the error
// the main thread sees, and the messages between scanClient.ts (main thread) and the scan worker
// (scanWorker.ts). The steps themselves are plain functions in detect.ts, warp.ts, enhance.ts,
// png1.ts and pipeline.ts, so the tests run them in Node; only encode.ts touches a canvas.

export type Point = [number, number];
/**
 * The sheet's corners in the photo's pixels (as analysePhoto returned the photo): top-left,
 * top-right, bottom-right, bottom-left. Continuous coordinates: pixel (i, j) covers the square
 * from (i, j) to (i + 1, j + 1), so the whole frame is (0, 0), (width, 0), (width, height), (0, height).
 */
export type Corners = [Point, Point, Point, Point];
/**
 * "document": the light flattened (shadows out, paper white, ink darker), colour kept;
 * "grey": the same in grey; "bw": black and white, 1 bit per pixel; "original": only straightened.
 */
export type ScanMode = "document" | "grey" | "bw" | "original";
/** "a4": the page is A4 (portrait or landscape, by the sheet); "photo": the sheet's own proportions. */
export type PageShape = "a4" | "photo";

/**
 * Pixels as ImageData holds them: RGBA, 4 bytes per pixel, rows top to bottom with no padding.
 * Photos are opaque (decodePhoto puts a picture with transparency on white): the alpha byte is
 * ignored when read and written as 255.
 */
export interface Pixels {
  width: number;
  height: number;
  data: Uint8ClampedArray<ArrayBuffer>;
}

/** A failure the scan flow tells the user about. */
export class ScanError extends Error {
  /**
   * "unreadable": not a picture this browser can decode (HEIC outside Safari, a damaged file);
   * "too-big": the file is larger than the app takes; "failed": anything else (the scan worker
   * stopped, the corners make no sheet, the page could not be encoded).
   */
  constructor(message: string, readonly code: "unreadable" | "too-big" | "failed") {
    super(message);
    this.name = "ScanError";
  }
}

// ---------------------------------------------------------------------------------------------
// Messages between scanClient.ts and scanWorker.ts. Photos are numbered by the client (numbers
// never reused, across workers too); the worker keeps the pixels of the last photo it analysed
// or processed, so processing it needs no second decode.

/** A picture as the worker gives it back: encoded, or its pixels for the main thread to encode (no canvas in the worker). */
export type ScanOutput = { bytes: ArrayBuffer } | { pixels: Pixels; quality: number };

export type ScanRequest =
  /** Decode `blob` upright, scale it to the working size, find the sheet. */
  | { op: "analyse"; photo: number; blob: Blob }
  /** The same with the photo decoded on the main thread (a worker without OffscreenCanvas, or a picture only an <img> reads). */
  | { op: "analysePixels"; photo: number; pixels: Pixels }
  /**
   * Straighten, enhance and encode photo `photo`. Without `source` the worker uses the pixels it
   * kept, or answers `{ missing: true }`; then the client sends the photo again as `source`.
   */
  | { op: "process"; photo: number; corners: Corners; mode: ScanMode; shape: PageShape; source?: ImageBitmap | Pixels };

export interface AnalyseReply {
  /** The working photo for the corner editor, or null when the main thread made it (analysePixels). */
  image: ImageBitmap | null;
  width: number;
  height: number;
  corners: Corners;
  confidence: number;
}

export type ProcessReply =
  | { missing: true }
  | { missing?: false; page: ScanOutput; width: number; height: number; dpi: number; preview: ScanOutput };

export type ScanReplyMessage =
  | { id: number; ok: true; result: AnalyseReply | ProcessReply }
  /** `code`: a ScanError code, or "no-canvas" when the worker cannot decode a photo by itself. */
  | { id: number; ok: false; error: string; code: string };
