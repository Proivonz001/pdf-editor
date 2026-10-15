// Contract between the UI (main thread) and the PDF engine (MuPDF in a Web Worker).
//
// Coordinates: "page space", in PDF points, y pointing down, with the page's /Rotate and
// CropBox already applied — what the user sees. MuPDF's structured text, annotations and
// rendering all use it. The UI converts to screen pixels with: px = (pt - bounds origin) * zoom.
//
// The worker owns the document. The UI never holds a copy of it: it asks for page bitmaps
// and text lines, sends edits, and asks for the bytes when the user downloads.

/** x0, y0, x1, y1 in page space (points, y down). */
export type Rect = [number, number, number, number];

export interface PageInfo {
  index: number;
  /** Page bounds in page space. Width = bounds[2] - bounds[0]. Usually starts at 0,0. */
  bounds: Rect;
}

export interface DocInfo {
  pageCount: number;
  pages: PageInfo[];
  /** The source was encrypted (it is saved without encryption). */
  encrypted: boolean;
  title: string | null;
}

export type OpenResult =
  | ({ ok: true } & DocInfo)
  | { ok: false; reason: "password-required" | "wrong-password" | "damaged"; message?: string };

/** One line of text as MuPDF's structured text sees it. */
export interface LineInfo {
  /** Position in the page's current line list. Changes after an edit: always re-read lines. */
  index: number;
  text: string;
  bbox: Rect;
  /** Font size of the first character, in points. */
  size: number;
  fontName: string;
  bold: boolean;
  italic: boolean;
  serif: boolean;
  mono: boolean;
  /** sRGB 0..1 of the first character. */
  color: [number, number, number];
  vertical: boolean;
  /** Writing direction unit vector in page space ([1, 0] for normal text). */
  dir: [number, number];
  /**
   * False when the line cannot be rewritten safely (it contains characters outside the Basic
   * Multilingual Plane, e.g. math italic letters or emoji, which MuPDF.js 1.27 reports
   * truncated). The UI shows it but offers no editor; replaceLine refuses it ("not-editable").
   */
  editable: boolean;
}

export type SegmentSource = "original" | "original-sibling" | "document-same-line" | "fallback";

export interface EditSegment {
  text: string;
  source: SegmentSource;
  fontName: string;
}

export interface HistoryState {
  /** Number of edits currently applied. */
  editCount: number;
  canUndo: boolean;
  canRedo: boolean;
  /** Pages whose appearance changed in this step: the UI re-renders them and re-reads their lines. */
  changedPages: number[];
}

export interface EditResult extends HistoryState {
  pageIndex: number;
  before: string;
  after: string;
  segments: EditSegment[];
  /** Characters written with a fallback font because the original font does not contain them. */
  fallbackChars: string[];
  /** Characters no available font could draw (left out). */
  missingChars: string[];
}

export interface RenderResult {
  bitmap: ImageBitmap;
  /** Pixel size of the bitmap. */
  width: number;
  height: number;
  /** Pixels per point used. */
  scale: number;
}

export type Request =
  | { op: "open"; bytes: ArrayBuffer; password?: string }
  | { op: "render"; pageIndex: number; scale: number }
  | { op: "lines"; pageIndex: number }
  | { op: "replaceLine"; pageIndex: number; lineIndex: number; text: string }
  | { op: "undo" }
  | { op: "redo" }
  | { op: "save" }
  | { op: "close" };

export interface ResultMap {
  open: OpenResult;
  render: RenderResult;
  lines: LineInfo[];
  replaceLine: EditResult;
  undo: HistoryState;
  redo: HistoryState;
  save: { bytes: ArrayBuffer };
  close: null;
}

export type Op = Request["op"];
export type RequestOf<K extends Op> = Extract<Request, { op: K }>;

/** Main thread → worker. */
export type RequestMessage = { id: number } & Request;

/**
 * Error codes in `{ ok: false, code }` replies: "no-document", "bad-request", "edit-failed",
 * "not-editable" (the line has characters the engine cannot rewrite safely), "broken" (an edit
 * failed and the document could not be restored: the UI must stop editing and offer to reload),
 * "engine" (anything else). The client adds "init" and "crashed".
 */

/** Worker → main thread. `ready` is posted once, after MuPDF has loaded. */
export type ResponseMessage =
  | { type: "ready" }
  | { type: "init-error"; error: string }
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string; code?: string };
