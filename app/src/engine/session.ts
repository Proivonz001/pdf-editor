// One open document and its edit history: everything the worker does, as plain TypeScript.
//
// The mupdf module is passed in, so the Web Worker and the Node tests run exactly this code.
// Results are the protocol types, made of plain data only: no MuPDF object ever leaves.
//
// History (ARCHITECTURE.md, "Undo"): the session keeps the original bytes, the password, the
// log of applied edits and checkpoints, snapshots of the document taken every CHECKPOINT_EVERY
// edits. Undo re-opens the nearest checkpoint below the target (or the original) and replays
// the few edits after it. Save writes the working document out as it is, re-opens that as a
// scratch copy and saves the copy, because saving subsets the fallback fonts of the document it
// saves (core.subsetFallbackFonts), which would break later edits that need more glyphs of them.
// The PDF/A conversion (pdfa.ts) works on such a scratch copy too.
//
// Image edits (images.ts) are logged like text edits, and found again at every replay by their
// position in the page's painting order plus the matrix they must still have: resource names and
// offsets in the content are not stable, since a text edit rewrites the stream.
//
// A snapshot is written unencrypted and without garbage collection, so every object keeps its
// number and core.restoreFallbackFonts finds the fallback fonts again in the re-opened copy.
import type * as MuPDF from "mupdf";
import {
  captureGlyphs,
  countOccurrences,
  extractLines,
  fallbackFontState,
  findInLines,
  pixmapToRGBA,
  releaseFallbackFonts,
  releasePage,
  renderPixmap,
  replaceText,
  restoreFallbackFonts,
  subsetFallbackFonts,
} from "./core.js";
import {
  DevicePassError,
  MAX_SPRITE_CLIP_BYTES,
  SpriteClipBudget,
  deletePlacement,
  findPlacements,
  nearlyEqual,
  openImage,
  renderPlacement,
  replacePlacement,
  straightRGBA,
  transformPlacement,
  type PagePlacements,
  type Placement,
} from "./images";
import { checkPdfA, convertToPdfA, countSignatures, dropPdfaClaim, pdfaClaim } from "./pdfa";
import { MAX_IMAGE_BYTES, MAX_IMAGE_SIDE, MIN_IMAGE_SIDE, passwordProblem } from "./protocol";
import type {
  DocInfo,
  EditResult,
  EditSegment,
  HistoryState,
  ImageEditResult,
  ImageInfo,
  LineInfo,
  Matrix,
  OpenResult,
  PageInfo,
  PdfaReport,
  Rect,
  SaveOptions,
  SaveResult,
  SegmentSource,
} from "./protocol";

export type MuPDFModule = typeof MuPDF;

/** A line as core.extractLines returns it (with MuPDF Font objects inside: never returned). */
type RawLine = ReturnType<typeof extractLines>[number];
/** A drawn glyph as core.captureGlyphs returns it (with its MuPDF Font). */
type Glyph = ReturnType<typeof captureGlyphs>[number];

/** Largest bitmap render() returns, in pixels: iOS Safari refuses bigger canvases (about 16.7 M). */
export const MAX_RENDER_PIXELS = 16_000_000;
/** Longest side of a bitmap render() returns, in pixels: Chromium and Firefox refuse longer canvases. */
export const MAX_RENDER_SIDE = 32_767;
/** Largest bitmap renderImage() returns, in pixels (a preview: it need not be as sharp as the page). */
export const MAX_SPRITE_PIXELS = 4_000_000;
/** Lowest scale renderImage() goes down to when the clips around a picture are too many to draw it sharper (pixels per point). */
export const MIN_SPRITE_SCALE = 0.25;

/** A checkpoint is taken every CHECKPOINT_EVERY applied edits. */
export const CHECKPOINT_EVERY = 8;
/**
 * Checkpoints kept (each is about the size of the PDF). Beyond that they are thinned out rather
 * than dropped oldest-first, so they stay spread over the whole session: undo to any point
 * replays a bounded number of edits (CHECKPOINT_EVERY - 1 within the last few dozen edits, a few
 * more further back) instead of everything since the original.
 */
export const MAX_CHECKPOINTS = 12;
/** ...and fewer for a large PDF: they are thinned out while together they are larger than this. */
const MAX_CHECKPOINT_BYTES = 256 * 1024 * 1024;

/**
 * How a snapshot is written: unencrypted (it re-opens without the password) and without garbage
 * collection, so object numbers stay the same. MuPDF drops /Encrypt from the trailer of the
 * document it writes this way; the working document still decrypts with the key it opened with.
 */
const SNAPSHOT_OPTIONS = "encrypt=none";

/**
 * How a download is written (rule 4): garbage collected and compressed, unencrypted. PDF/A uses
 * exactly this too: MuPDF leaves the XMP metadata stream uncompressed, as PDF/A wants.
 */
const SAVE_OPTIONS = "garbage=compact,compress=yes,encrypt=none";

/**
 * ...or protected with a password: AES-256, with the same password as user and owner password,
 * so whoever knows it keeps full control (no restrictions to lift). MuPDF reads these options as
 * a comma-separated string, which is why passwordProblem refuses commas.
 */
const encryptedSaveOptions = (password: string) =>
  `garbage=compact,compress=yes,encrypt=aes-256,user-password=${password},owner-password=${password}`;

/** The default of save(): a normal PDF without password, what the app has always written. */
const PLAIN_PDF: SaveOptions = { format: "pdf", password: { mode: "none" } };

/** The document after the first `editCount` edits of the log, serialized. */
interface Checkpoint {
  editCount: number;
  bytes: Uint8Array;
  /** core.fallbackFontState of the document it was taken from. */
  fonts: ReturnType<typeof fallbackFontState>;
}

/** What render() returns in the session; the worker turns `rgba` into a transferable ImageBitmap. */
export interface RenderPixels {
  width: number;
  height: number;
  /** Straight (= premultiplied: the page is opaque) RGBA, width * height * 4 bytes. */
  rgba: Uint8ClampedArray<ArrayBuffer>;
  /** Pixels per point actually used: lower than asked when the bitmap would be too large. */
  scale: number;
}

/** One applied edit, as replayed by undo. Plain data, so it can be stored later. */
export type LoggedEdit = TextEdit | ImageEdit;

/** One whole line of text replaced (deleted when `replacement` is empty). */
export interface TextEdit {
  kind: "text";
  pageIndex: number;
  /** The text the edit replaced (one whole line, without its leading/trailing whitespace). */
  find: string;
  /** Which match of `find` on the page, counted the way core.findInLines counts. */
  occurrence: number;
  replacement: string;
}

/**
 * One image placement moved (resized, rotated), deleted or replaced. It is found again at every
 * replay: image `imageIndex` in the page's painting order, which must still be drawn at `expect`
 * (ImageInfo.matrix, within 0.01 pt), or the entry no longer fits the document and the edit fails.
 */
export type ImageEdit = { kind: "image"; pageIndex: number; imageIndex: number; expect: Matrix } & (
  /** Drawn at `matrix` instead (ImageInfo.matrix convention). */
  | { op: "transform"; matrix: Matrix }
  | { op: "delete" }
  /** Replaced with this picture (the file's bytes, a private copy: undo replays it). */
  | { op: "replace"; bytes: Uint8Array }
);

export type SessionErrorCode =
  /** No document is open. */
  | "no-document"
  /** Page, line or image index out of range, invalid scale, image matrix or picture. */
  | "bad-request"
  /**
   * MuPDF could not apply the edit; the document is back to the state before it. Also: MuPDF
   * failed while reading a page's images or drawing one alone (images, renderImage, and the image
   * edits before anything is changed), say on a picture it cannot decode: nothing changed.
   */
  | "edit-failed"
  /**
   * The line has characters the engine cannot rewrite safely (LineInfo.editable is false), or the
   * image is locked (ImageInfo.movable is false).
   */
  | "not-editable"
  /** An edit failed and the document could not be restored: only close and open still work. */
  | "broken"
  /** Saving as PDF/A found something that blocks the conversion (pdfaCheck lists it). */
  | "pdfa-blocked";

export class SessionError extends Error {
  constructor(message: string, readonly code: SessionErrorCode) {
    super(message);
    this.name = "SessionError";
  }
}

/** Subset fonts are named "ABCDEF+Calibri": the UI shows the face name only. */
const untag = (name: string) => name.replace(/^[A-Z]{6}\+/, "");

/**
 * Line breaks and tabs become spaces (an edit is one line), and leading/trailing whitespace is
 * dropped: the replacement starts where the line's first visible character was.
 */
const normalizeLineText = (text: string) => text.replace(/[\r\n\t\u2028\u2029]+/g, " ").trim();

/** Lines made only of whitespace (often spaces MuPDF synthesized from gaps) are not editable. */
const isBlank = (text: string) => text.trim() === "";

export class EngineSession {
  private doc: MuPDF.PDFDocument | null = null;
  private original: Uint8Array | null = null;
  /** The password the user gave to open the document ("" when none was needed). */
  private password = "";
  /** Opening needed that password (DocInfo.needsPassword): a download may keep it. */
  private neededPassword = false;
  /**
   * That password was the owner password, not the user password. "keep" would then write it as
   * the copy's one password, so the user password the recipients know would stop opening it:
   * the session refuses "keep" and the user chooses (DocInfo.canKeepPassword is false).
   */
  private ownerPasswordOnly = false;
  private log: LoggedEdit[] = [];
  private redoStack: LoggedEdit[] = [];
  /** Ascending editCount. After undo some lie beyond the log: redo reaches them again. */
  private checkpoints: Checkpoint[] = [];
  private broken = false;

  constructor(private readonly mupdf: MuPDFModule) {}

  // ------------------------------------------------------------------ open / close

  /**
   * Opens a PDF, replacing the document open before (which is closed first, even if this one
   * fails to open). `bytes` is copied, so the caller may reuse its buffer, unless `transfer` is
   * set: then the caller hands the buffer over and never touches it again (the worker, which
   * received it transferred), and the session keeps it as the original instead of a copy.
   */
  open(bytes: ArrayBuffer | Uint8Array, password?: string, { transfer = false } = {}): OpenResult {
    this.close();
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const original = transfer ? view : view.slice();
    let doc: MuPDF.PDFDocument | null = null;
    try {
      const opened = this.mupdf.Document.openDocument(original, "application/pdf");
      doc = opened.asPDF();
      if (!doc) {
        opened.destroy();
        return { ok: false, reason: "damaged", message: "Not a PDF document" };
      }
      let neededPassword = false, ownerPasswordOnly = false;
      if (doc.needsPassword()) {
        if (!password) {
          this.dispose(doc);
          return { ok: false, reason: "password-required" };
        }
        // MuPDF's result is a bit set: 2 the user password matched, 4 the owner password (6 when
        // they are the same). 4 alone: the file was opened with its owner password only.
        const auth = doc.authenticatePassword(password);
        if (!auth) {
          this.dispose(doc);
          return { ok: false, reason: "wrong-password" };
        }
        neededPassword = true;
        ownerPasswordOnly = (auth & 2) === 0;
      }
      const info = this.describe(doc, neededPassword, password ?? "", ownerPasswordOnly);
      if (info.pageCount === 0) {
        this.dispose(doc);
        return { ok: false, reason: "damaged", message: "The document has no pages" };
      }
      this.doc = doc;
      this.original = original;
      this.password = password ?? "";
      this.neededPassword = neededPassword;
      this.ownerPasswordOnly = ownerPasswordOnly;
      return { ok: true, ...info };
    } catch (err) {
      if (doc) this.dispose(doc);
      return { ok: false, reason: "damaged", message: errorMessage(err) };
    }
  }

  /** Closes the document and forgets its history. Safe to call when nothing is open. */
  close(): null {
    if (this.doc) this.dispose(this.doc);
    this.doc = null;
    this.original = null;
    this.password = "";
    this.neededPassword = false;
    this.ownerPasswordOnly = false;
    this.log = [];
    this.redoStack = [];
    this.checkpoints = [];
    this.broken = false;
    return null;
  }

  private describe(doc: MuPDF.PDFDocument, neededPassword: boolean, password: string, ownerPasswordOnly: boolean): DocInfo {
    // Owner-password-only files open without a password but are encrypted all the same.
    const trailer = doc.getTrailer();
    const encryptObj = trailer.get("Encrypt");
    const encrypted = neededPassword || !encryptObj.isNull();
    encryptObj.destroy(); // (destroying the shared PDFObject.Null is a no-op)
    trailer.destroy();
    const pageCount = doc.countPages();
    const pages: PageInfo[] = [];
    for (let index = 0; index < pageCount; index++) {
      const page = doc.loadPage(index);
      try {
        pages.push({ index, bounds: toRect(page.getBounds()) });
      } finally {
        page.destroy();
      }
    }
    const title = doc.getMetaData("info:Title")?.trim();
    return {
      pageCount,
      pages,
      encrypted,
      needsPassword: neededPassword,
      // The same rule as savePassword's "keep": what this says is possible, save does.
      canKeepPassword: neededPassword && !ownerPasswordOnly && passwordProblem(password) === null,
      pdfa: pdfaClaim(doc),
      signatures: countSignatures(doc),
      title: title || null,
    };
  }

  // ------------------------------------------------------------------ reading

  /** Renders a page at `scale` pixels per point, lowered if needed to stay within the canvas limits. */
  render(pageIndex: number, scale: number): RenderPixels {
    const doc = this.requireDoc();
    this.checkPage(doc, pageIndex);
    if (!(scale > 0) || !Number.isFinite(scale)) throw new SessionError(`Invalid scale ${scale}`, "bad-request");
    const page = doc.loadPage(pageIndex);
    try {
      const used = fitScale(page.getBounds(), scale);
      const pix = renderPixmap(this.mupdf, page, used);
      try {
        const { width, height, rgba } = pixmapToRGBA(pix);
        return { width, height, rgba: rgba as Uint8ClampedArray<ArrayBuffer>, scale: used };
      } finally {
        pix.destroy();
      }
    } finally {
      page.destroy();
    }
  }

  /** The page's text lines, in MuPDF's reading order; whitespace-only lines are left out. */
  lines(pageIndex: number): LineInfo[] {
    const doc = this.requireDoc();
    this.checkPage(doc, pageIndex);
    const page = doc.loadPage(pageIndex);
    let raw: RawLine[] = [], glyphs: Glyph[] = [];
    try {
      raw = extractLines(page);
      glyphs = captureGlyphs(this.mupdf, page);
      const locked = linesBeyondBMP(raw, glyphs);
      const out: LineInfo[] = [];
      for (const line of raw) {
        if (isBlank(line.text)) continue;
        const ch = line.chars[0];
        out.push({
          index: out.length,
          text: line.text,
          bbox: toRect(line.bbox),
          size: ch.size,
          fontName: untag(ch.fontName),
          bold: ch.bold,
          italic: ch.italic,
          serif: ch.serif,
          mono: ch.mono,
          color: [ch.color[0], ch.color[1], ch.color[2]],
          vertical: line.wmode === 1,
          dir: [line.dir[0], line.dir[1]],
          editable: !locked.has(line),
        });
      }
      return out;
    } finally {
      releasePage(page, raw, glyphs);
    }
  }

  // ------------------------------------------------------------------ editing

  /**
   * Replaces one whole line (rule 1 of ARCHITECTURE.md). `lineIndex` is LineInfo.index from the
   * latest lines() of that page.
   *
   * - Text equal to the line's (ignoring leading/trailing whitespace) is a no-op: nothing is
   *   logged, the redo stack is kept and changedPages is empty.
   * - Empty or whitespace-only text deletes the line: it is redacted and nothing is written.
   * - A line that is not editable (LineInfo.editable) is refused ("not-editable"), unchanged.
   */
  replaceLine(pageIndex: number, lineIndex: number, text: string): EditResult {
    const doc = this.requireDoc();
    this.checkPage(doc, pageIndex);
    const replacement = normalizeLineText(text);
    const { find, occurrence } = this.locateLine(doc, pageIndex, lineIndex);

    if (replacement === find) {
      return {
        ...this.history([]),
        pageIndex,
        before: find,
        after: find,
        segments: [],
        fallbackChars: [],
        missingChars: [],
      };
    }

    const edit: TextEdit = { kind: "text", pageIndex, find, occurrence, replacement };
    const result = this.commit(doc, edit, () => this.applyText(doc, edit), "Could not edit the line");

    // core's segment kinds are exactly the protocol's SegmentSource values.
    const segments: EditSegment[] = result.segments.map((s) => ({
      text: String(s.text),
      source: s.source as SegmentSource,
      fontName: untag(String(s.fontName)),
    }));
    // Spaces are left out: a space from a fallback font looks the same (Type3 fonts often lack one).
    const fallbackChars = visibleChars(segments.filter((s) => s.source === "fallback").flatMap((s) => [...s.text]));
    return {
      ...this.history([pageIndex]),
      pageIndex,
      before: find,
      after: replacement,
      segments,
      fallbackChars,
      missingChars: visibleChars(result.missing as string[]),
    };
  }

  // ------------------------------------------------------------------ images

  /** The page's images (placements), in painting order, locked ones included (with the reason). */
  images(pageIndex: number): ImageInfo[] {
    const doc = this.requireDoc();
    this.checkPage(doc, pageIndex);
    const page = doc.loadPage(pageIndex);
    try {
      return placementsOf(this.mupdf, page).placements.map(imageInfo);
    } finally {
      page.destroy();
    }
  }

  /**
   * Moves, resizes or rotates one image so that it is drawn at `matrix` (ImageInfo.matrix
   * convention). `imageIndex` is ImageInfo.index from the latest images() of that page; the
   * image keeps it (its painting position does not change).
   *
   * - A matrix that is not six finite numbers, is degenerate, makes a side shorter than
   *   MIN_IMAGE_SIDE or longer than MAX_IMAGE_SIDE, or puts the centre off the page is refused
   *   ("bad-request"). A side that is already outside those limits may stay as it is, or come
   *   closer to them: a 0.5 pt rule can be moved and turned.
   * - The image's current matrix (within 0.001) is a no-op: nothing is logged, the redo stack is
   *   kept and changedPages is empty.
   * - A locked image (ImageInfo.movable false) is refused ("not-editable"), unchanged.
   */
  transformImage(pageIndex: number, imageIndex: number, matrix: Matrix): ImageEditResult {
    const doc = this.requireDoc();
    this.checkPage(doc, pageIndex);
    const target = matrixFrom(matrix);
    const changed = this.editImage(doc, pageIndex, imageIndex, "Could not move the image", (p, page) => {
      checkTarget(target, page.getBounds() as Rect, p.matrix);
      if (nearlyEqual(target, p.matrix, 0.001)) return null;
      return { kind: "image", pageIndex, imageIndex, expect: p.matrix, op: "transform", matrix: target };
    });
    return { ...this.history(changed ? [pageIndex] : []), pageIndex, imageIndex };
  }

  /**
   * Deletes one image placement: only its drawing instruction (tags and other placements stay).
   * The picture leaves the page's resources, and the dictionaries other pages or forms draw with
   * (shared, inherited), and so the download, when nothing else draws it; the structure element
   * of a tagged picture (a Figure, or one that held only the picture) loses its description
   * (/Alt, /ActualText).
   */
  deleteImage(pageIndex: number, imageIndex: number): ImageEditResult {
    const doc = this.requireDoc();
    this.checkPage(doc, pageIndex);
    this.editImage(doc, pageIndex, imageIndex, "Could not delete the image", (p) =>
      ({ kind: "image", pageIndex, imageIndex, expect: p.matrix, op: "delete" }));
    return { ...this.history([pageIndex]), pageIndex, imageIndex: null };
  }

  /**
   * Replaces one image placement with another picture (file bytes MuPDF can read: JPEG, PNG...),
   * fitted inside the part of the old one that showed, keeping its own proportions, centred, with
   * the same rotation, never mirrored (images.replacePlacement); a JPEG is embedded as it is, the
   * same bytes once however many places they go, in the old picture's layer (/OC). Other
   * placements of the old picture stay. More than MAX_IMAGE_BYTES, or bytes that are not a
   * picture, are refused ("bad-request") before anything is done. `bytes` is copied, unless
   * `transfer` is set (as for open()).
   */
  replaceImage(pageIndex: number, imageIndex: number, bytes: ArrayBuffer | Uint8Array, { transfer = false } = {}): ImageEditResult {
    const doc = this.requireDoc();
    this.checkPage(doc, pageIndex);
    const picture = this.checkPicture(bytes, transfer);
    this.editImage(doc, pageIndex, imageIndex, "Could not replace the image", (p) =>
      ({ kind: "image", pageIndex, imageIndex, expect: p.matrix, op: "replace", bytes: picture }));
    return { ...this.history([pageIndex]), pageIndex, imageIndex };
  }

  /**
   * One image alone on a transparent bitmap, with the clips that apply to it: the preview while it
   * is dragged. The bitmap covers the image's visible box rounded out to whole pixels at `scale`
   * pixels per point (lowered to stay within MAX_SPRITE_PIXELS and MAX_RENDER_SIDE); `rect` is that
   * box in page space. The RGBA is straight (not premultiplied) alpha. When the clips around the
   * image would take too much memory to draw at that scale (images.MAX_SPRITE_CLIP_BYTES: nested
   * rounded or turned frames from design tools), it is drawn at the lower scale where they fit,
   * down to MIN_SPRITE_SCALE. A picture MuPDF cannot draw, or clips too many even there, fail with
   * "edit-failed", leaving everything as it was.
   */
  renderImage(pageIndex: number, imageIndex: number, scale: number): RenderPixels & { rect: Rect } {
    const doc = this.requireDoc();
    this.checkPage(doc, pageIndex);
    if (!(scale > 0) || !Number.isFinite(scale)) throw new SessionError(`Invalid scale ${scale}`, "bad-request");
    const page = doc.loadPage(pageIndex);
    try {
      const p = pickImage(placementsOf(this.mupdf, page), pageIndex, imageIndex);
      let { scale: used, box } = spriteBox(p.visible, scale);
      let pix: MuPDF.Pixmap;
      for (let attempt = 1; ; attempt++) {
        try {
          pix = renderPlacement(this.mupdf, page, p.drawIndex, used, box);
          break;
        } catch (err) {
          const lower = err instanceof SpriteClipBudget && attempt < 4 ? scaleWithin(err.bytes, used) : null;
          if (lower === null) throw err instanceof DevicePassError ? new SessionError(err.message, "edit-failed") : err;
          ({ scale: used, box } = spriteBox(p.visible, lower));
        }
      }
      try {
        const { width, height, rgba } = straightRGBA(pix);
        return { width, height, rgba, scale: used, rect: [box[0] / used, box[1] / used, box[2] / used, box[3] / used] };
      } finally {
        pix.destroy();
      }
    } finally {
      page.destroy();
    }
  }

  /**
   * Finds image `imageIndex` of the page ("bad-request" when there is none, "not-editable" when
   * it is locked), lets `plan` make the edit to log (null: nothing to do), then applies it on the
   * placements just found and records it. Returns whether an edit was made.
   */
  private editImage(
    doc: MuPDF.PDFDocument,
    pageIndex: number,
    imageIndex: number,
    failure: string,
    plan: (p: Placement, page: MuPDF.PDFPage) => ImageEdit | null,
  ): boolean {
    const page = doc.loadPage(pageIndex);
    try {
      const found = placementsOf(this.mupdf, page);
      const p = pickImage(found, pageIndex, imageIndex);
      if (!p.movable)
        throw new SessionError(`Image ${imageIndex} on page ${pageIndex + 1} cannot be changed (${p.reason})`, "not-editable");
      const edit = plan(p, page);
      if (!edit) return false;
      this.commit(doc, edit, () => applyImageEdit(this.mupdf, doc, page, found, p, edit), failure);
      return true;
    } finally {
      page.destroy(); // after a failed edit its document may be gone already: the page kept it alive until here
    }
  }

  /** The picture's bytes for a replace, checked as untrusted ("bad-request"), as a private copy unless transferred. */
  private checkPicture(bytes: ArrayBuffer | Uint8Array, transfer: boolean): Uint8Array {
    if (!(bytes instanceof ArrayBuffer) && !(bytes instanceof Uint8Array)) throw new SessionError("No picture given", "bad-request");
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (view.byteLength === 0) throw new SessionError("The picture is empty", "bad-request");
    if (view.byteLength > MAX_IMAGE_BYTES)
      throw new SessionError(`The picture is larger than ${MAX_IMAGE_BYTES} bytes`, "bad-request");
    let image: MuPDF.Image;
    try {
      image = openImage(this.mupdf, view);
    } catch (err) {
      throw new SessionError(`The picture cannot be read: ${errorMessage(err)}`, "bad-request");
    }
    try {
      if (!(image.getWidth() > 0 && image.getHeight() > 0)) throw new SessionError("The picture has no pixels", "bad-request");
    } finally {
      image.destroy();
    }
    return transfer ? view : view.slice();
  }

  /** Undoes the last edit: re-opens the nearest checkpoint (or the original) and replays from there. */
  undo(): HistoryState {
    this.requireDoc();
    const last = this.log[this.log.length - 1];
    if (!last) return this.history([]);
    const fresh = this.rebuild(this.log.length - 1);
    this.replaceDoc(fresh);
    this.log.pop();
    this.redoStack.push(last);
    return this.history([last.pageIndex]);
  }

  /** Re-applies the last undone edit. */
  redo(): HistoryState {
    const doc = this.requireDoc();
    const next = this.redoStack[this.redoStack.length - 1];
    if (!next) return this.history([]);
    try {
      this.apply(doc, next);
    } catch (err) {
      throw this.recover(`Could not redo the edit: ${errorMessage(err)}`);
    }
    this.redoStack.pop();
    this.log.push(next);
    this.checkpoint(doc);
    return this.history([next.pageIndex]);
  }

  /** The edits currently applied, oldest first (a copy). */
  edits(): LoggedEdit[] {
    return this.log.map(copyEdit);
  }

  // ------------------------------------------------------------------ saving

  /**
   * The edited document as a file to download (rule 4). The working document is left untouched:
   * a snapshot of it is re-opened with its fallback-font bookkeeping, and that scratch copy is
   * saved (fallback fonts subset, garbage collected) and destroyed. Nothing is replayed.
   *
   * - format "pdf": a normal PDF, unencrypted, or AES-256 with the chosen password ("keep": the
   *   one the file was opened with, only when DocInfo.canKeepPassword was true; "set": a new one
   *   that passes passwordProblem).
   * - format "pdfa-2b": the scratch copy is converted (pdfa.ts); blockers refuse the download
   *   ("pdfa-blocked"), and the written bytes must pass the engine's own check, or the save
   *   fails rather than hand out a file that only claims to be PDF/A. PDF/A takes no password.
   *
   * Invalid options are refused ("bad-request") before anything is done.
   */
  save(options: SaveOptions = PLAIN_PDF): SaveResult {
    if (!this.doc) throw new SessionError("No document is open", "no-document");
    const password = this.savePassword(options);
    const scratch = this.scratchCopy();
    try {
      subsetFallbackFonts(this.mupdf, scratch);
      if (options.format === "pdf") {
        // An edited PDF/A saved as a normal PDF: nothing re-checked it, so it stops claiming PDF/A.
        if (this.log.length > 0) dropPdfaClaim(this.mupdf, scratch);
        return { bytes: writeBytes(scratch, password === null ? SAVE_OPTIONS : encryptedSaveOptions(password)), pdfa: null };
      }
      const report = convertToPdfA(this.mupdf, scratch);
      if (report.blockers.length)
        throw new SessionError(`Cannot be saved as PDF/A: ${report.blockers.map((b) => b.code).join(", ")}`, "pdfa-blocked");
      const bytes = writeBytes(scratch, SAVE_OPTIONS);
      const problems = checkPdfA(this.mupdf, new Uint8Array(bytes));
      // Not a SessionError: the worker reports it as "engine", an engine bug, never as a file.
      if (problems.length) throw new Error(`The PDF/A file failed the engine's own check: ${problems.join("; ")}`);
      return { bytes, pdfa: report };
    } finally {
      this.dispose(scratch);
    }
  }

  /**
   * What saving as PDF/A would do, without writing a file: the same conversion as save() on a
   * scratch copy, so the UI can ask before removing anything or explain why it cannot.
   */
  pdfaCheck(): PdfaReport {
    if (!this.doc) throw new SessionError("No document is open", "no-document");
    const scratch = this.scratchCopy();
    try {
      subsetFallbackFonts(this.mupdf, scratch);
      return convertToPdfA(this.mupdf, scratch);
    } finally {
      this.dispose(scratch);
    }
  }

  /** The password to protect the download with (null: none), or "bad-request". */
  private savePassword(options: SaveOptions): string | null {
    // Checked as untrusted: the options arrive from the main thread as plain data.
    const format = options?.format, password = options?.password;
    if (format !== "pdf" && format !== "pdfa-2b") throw new SessionError(`Unknown format ${String(format)}`, "bad-request");
    let chosen: string | null;
    switch (password?.mode) {
      case "none":
        chosen = null;
        break;
      case "keep":
        if (!this.neededPassword) throw new SessionError("The document was opened without a password: there is none to keep", "bad-request");
        if (this.ownerPasswordOnly)
          throw new SessionError("The document was opened with its owner password: keeping it would lock out the user password", "bad-request");
        chosen = this.password; // passwordProblem below, as for DocInfo.canKeepPassword
        break;
      case "set":
        if (typeof password.password !== "string") throw new SessionError("No password given", "bad-request");
        chosen = password.password;
        break;
      default:
        throw new SessionError("Unknown password option", "bad-request");
    }
    if (chosen !== null) {
      const problem = passwordProblem(chosen);
      if (problem) throw new SessionError(`The password cannot protect the download (${problem})`, "bad-request");
      if (format === "pdfa-2b") throw new SessionError("A PDF/A file cannot have a password", "bad-request");
    }
    return chosen;
  }

  /**
   * A scratch copy of the current state, with its fallback-font bookkeeping: a snapshot of the
   * working document, or, when the session is broken (the working document may be half-edited),
   * the last good state rebuilt from the log (that failed once already, so it can fail again:
   * then still "broken").
   */
  private scratchCopy(): MuPDF.PDFDocument {
    const doc = this.doc!;
    if (this.broken) {
      try {
        return this.rebuild(this.log.length);
      } catch (err) {
        throw new SessionError(`The document could not be rebuilt: ${errorMessage(err)}`, "broken");
      }
    }
    const snapshot = doc.saveToBuffer(SNAPSHOT_OPTIONS);
    let scratch: MuPDF.PDFDocument;
    try {
      scratch = this.openSnapshot(snapshot); // the document keeps its own reference to the buffer
    } finally {
      snapshot.destroy();
    }
    try {
      restoreFallbackFonts(scratch, fallbackFontState(doc));
    } catch (err) {
      this.dispose(scratch);
      throw err;
    }
    return scratch;
  }

  // ------------------------------------------------------------------ internals

  private history(changedPages: number[]): HistoryState {
    return {
      editCount: this.log.length,
      canUndo: this.log.length > 0,
      canRedo: this.redoStack.length > 0,
      changedPages,
    };
  }

  private requireDoc(): MuPDF.PDFDocument {
    if (!this.doc) throw new SessionError("No document is open", "no-document");
    if (this.broken) throw new SessionError("An edit failed and the document could not be restored", "broken");
    return this.doc;
  }

  private checkPage(doc: MuPDF.PDFDocument, pageIndex: number) {
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= doc.countPages())
      throw new SessionError(`No page ${pageIndex}`, "bad-request");
  }

  /**
   * The text an edit of this line must find, and which occurrence on the page is this line.
   * core.findInLines counts every match in line order, including matches inside other lines
   * (a line "Note" also matches inside an earlier "Note bene"), so the occurrence is the number
   * of matches in the lines before this one. Within the line itself the trimmed text can only
   * match at its own start: what precedes it is whitespace.
   */
  private locateLine(doc: MuPDF.PDFDocument, pageIndex: number, lineIndex: number) {
    const page = doc.loadPage(pageIndex);
    let raw: RawLine[] = [], glyphs: Glyph[] = [];
    try {
      raw = extractLines(page);
      const listed = raw.filter((l) => !isBlank(l.text));
      const target = Number.isInteger(lineIndex) ? listed[lineIndex] : undefined;
      if (!target) throw new SessionError(`No line ${lineIndex} on page ${pageIndex + 1}`, "bad-request");
      glyphs = captureGlyphs(this.mupdf, page);
      if (linesBeyondBMP([target], glyphs).size)
        throw new SessionError(`Line ${lineIndex} on page ${pageIndex + 1} has characters that cannot be rewritten`, "not-editable");
      const find = normalizeLineText(target.text);
      let occurrence = 0;
      for (const line of raw) {
        if (line === target) break;
        occurrence += countOccurrences(line.text, find);
      }
      // Belt and braces: the edit must land on exactly this line.
      const hit = findInLines(raw, find, occurrence);
      if (!hit || hit.line !== target) throw new Error("line lookup mismatch");
      return { find, occurrence };
    } finally {
      releasePage(page, raw, glyphs);
    }
  }

  /**
   * Applies a new edit through `run` and records it: if it fails the document is rolled back
   * (recover, "edit-failed"); if not, the edit is logged, the redo stack cleared and a checkpoint
   * taken when due.
   */
  private commit<T>(doc: MuPDF.PDFDocument, edit: LoggedEdit, run: () => T, failure: string): T {
    let result: T;
    try {
      result = run();
    } catch (err) {
      throw this.recover(`${failure}: ${errorMessage(err)}`);
    }
    // Checkpoints beyond this point hold undone edits, which this one replaces for good.
    this.checkpoints = this.checkpoints.filter((c) => c.editCount <= this.log.length);
    this.log.push(edit);
    this.redoStack = [];
    this.checkpoint(doc);
    return result;
  }

  /** Applies a logged edit again (redo, rebuild). */
  private apply(doc: MuPDF.PDFDocument, edit: LoggedEdit) {
    if (edit.kind === "image") this.applyImage(doc, edit);
    else this.applyText(doc, edit);
  }

  private applyText(doc: MuPDF.PDFDocument, edit: TextEdit) {
    return replaceText(this.mupdf, doc, edit.pageIndex, edit.find, edit.replacement, { occurrence: edit.occurrence });
  }

  /**
   * Finds the edit's image again (walk and safety gate) and applies the edit. Throws when the
   * image is missing, locked, or not drawn where the entry expects it: the log no longer fits.
   */
  private applyImage(doc: MuPDF.PDFDocument, edit: ImageEdit) {
    const page = doc.loadPage(edit.pageIndex);
    try {
      const found = findPlacements(this.mupdf, page);
      const p = found.placements[edit.imageIndex];
      const where = `image ${edit.imageIndex} on page ${edit.pageIndex + 1}`;
      if (!p) throw new Error(`There is no ${where}`);
      if (!p.movable) throw new Error(`The ${where} cannot be changed (${p.reason})`);
      if (!nearlyEqual(p.matrix, edit.expect)) throw new Error(`The ${where} is not where the edit expects it`);
      applyImageEdit(this.mupdf, doc, page, found, p, edit);
    } finally {
      page.destroy();
    }
  }

  /** Opens the original bytes again, with the password the user gave. */
  private openOriginal(): MuPDF.PDFDocument {
    if (!this.original) throw new SessionError("No document is open", "no-document");
    const doc = this.mupdf.Document.openDocument(this.original, "application/pdf").asPDF()!;
    if (doc.needsPassword() && !doc.authenticatePassword(this.password)) {
      doc.destroy();
      throw new Error("The original no longer opens with its password");
    }
    return doc;
  }

  /** Opens a snapshot (checkpoint bytes, or a Buffer straight from saveToBuffer): no password. */
  private openSnapshot(bytes: Uint8Array | MuPDF.Buffer): MuPDF.PDFDocument {
    return this.mupdf.Document.openDocument(bytes, "application/pdf").asPDF()!;
  }

  /**
   * A fresh document with the first `count` edits of the log applied: the nearest checkpoint at
   * or below `count`, or the original, plus the edits after it (at most CHECKPOINT_EVERY - 1).
   */
  private rebuild(count: number): MuPDF.PDFDocument {
    const base = this.checkpoints.findLast((c) => c.editCount <= count);
    const doc = base ? this.openSnapshot(base.bytes) : this.openOriginal();
    try {
      if (base) restoreFallbackFonts(doc, base.fonts);
      for (const edit of this.log.slice(base ? base.editCount : 0, count)) this.apply(doc, edit);
      return doc;
    } catch (err) {
      this.dispose(doc);
      throw err;
    }
  }

  /**
   * After a failed edit or redo, which may have changed the document half way: rebuild it from
   * the log. Returns the error to throw; if even the rebuild fails, the session is broken.
   */
  private recover(message: string): SessionError {
    try {
      this.replaceDoc(this.rebuild(this.log.length));
      return new SessionError(message, "edit-failed");
    } catch (err) {
      this.broken = true;
      return new SessionError(`${message}. The document could not be restored: ${errorMessage(err)}`, "broken");
    }
  }

  /** Takes a checkpoint of the working document when the log has just reached a multiple of CHECKPOINT_EVERY. */
  private checkpoint(doc: MuPDF.PDFDocument) {
    const editCount = this.log.length;
    if (editCount % CHECKPOINT_EVERY !== 0 || this.checkpoints.some((c) => c.editCount === editCount)) return;
    let bytes: Uint8Array;
    try {
      const buf = doc.saveToBuffer(SNAPSHOT_OPTIONS);
      try {
        bytes = buf.asUint8Array().slice(); // out of the wasm heap
      } finally {
        buf.destroy();
      }
    } catch {
      return; // a checkpoint only saves time: undo then starts from an earlier one
    }
    this.checkpoints.push({ editCount, bytes, fonts: fallbackFontState(doc) });
    this.checkpoints.sort((a, b) => a.editCount - b.editCount);
    let total = this.checkpoints.reduce((n, c) => n + c.bytes.byteLength, 0);
    while (this.checkpoints.length > MAX_CHECKPOINTS || (total > MAX_CHECKPOINT_BYTES && this.checkpoints.length > 0))
      total -= this.checkpoints.splice(this.thinningIndex(), 1)[0].bytes.byteLength;
  }

  /**
   * Which checkpoint to drop: the one whose removal leaves the smallest gap between its
   * neighbours (the original counts as edit 0), oldest first on ties. The newest is kept while
   * there is another one, since undo usually goes back only a few steps.
   */
  private thinningIndex(): number {
    const cps = this.checkpoints;
    if (cps.length === 1) return 0;
    let best = 0, bestGap = Infinity;
    for (let i = 0; i < cps.length - 1; i++) {
      const gap = cps[i + 1].editCount - (i > 0 ? cps[i - 1].editCount : 0);
      if (gap < bestGap) { best = i; bestGap = gap; }
    }
    return best;
  }

  private replaceDoc(fresh: MuPDF.PDFDocument) {
    if (this.doc) this.dispose(this.doc);
    this.doc = fresh;
  }

  /** Destroys a document and the fallback fonts core.js cached for it (rule 5). */
  private dispose(doc: MuPDF.PDFDocument) {
    releaseFallbackFonts(doc);
    doc.destroy();
  }
}

/**
 * The largest scale <= `scale` whose bitmap stays within MAX_RENDER_PIXELS and MAX_RENDER_SIDE,
 * computed the way core.renderPixmap sizes its pixmap (page bounds scaled, rounded outwards).
 */
export function fitScale(bounds: number[], scale: number): number {
  const [x0, y0, x1, y1] = bounds;
  const w = x1 - x0, h = y1 - y0;
  if (!(w > 0 && h > 0)) throw new SessionError("The page has no area", "bad-request");
  const fits = (s: number) => {
    const pw = Math.ceil(x1 * s) - Math.floor(x0 * s), ph = Math.ceil(y1 * s) - Math.floor(y0 * s);
    return pw * ph <= MAX_RENDER_PIXELS && pw <= MAX_RENDER_SIDE && ph <= MAX_RENDER_SIDE;
  };
  let s = Math.min(scale, Math.sqrt(MAX_RENDER_PIXELS / (w * h)), MAX_RENDER_SIDE / w, MAX_RENDER_SIDE / h);
  while (!fits(s)) s *= 0.999;
  return s;
}

/**
 * The lines holding a character outside the Basic Multilingual Plane. MuPDF.js 1.27 reads a
 * structured-text character with String.fromCharCode, which keeps the low 16 bits of the code
 * point: U+1D465 (math italic x) arrives as U+D465, a Hangul syllable, and emoji as private-use
 * characters, so an edit would write those instead. The drawn glyphs (core.captureGlyphs) carry
 * the full code point; a character is matched to such a glyph by its cut code and position.
 */
function linesBeyondBMP(lines: RawLine[], glyphs: Glyph[]): Set<RawLine> {
  const out = new Set<RawLine>();
  const wide = glyphs.filter((g) => g.uni > 0xffff);
  if (!wide.length) return out;
  for (const line of lines)
    for (const ch of line.chars) {
      const code = ch.c.charCodeAt(0), [x, y] = ch.glyphOrigin;
      if (wide.some((g) => (g.uni & 0xffff) === code && Math.hypot(g.m[4] - x, g.m[5] - y) < Math.max(1, ch.size / 2))) {
        out.add(line);
        break;
      }
    }
  return out;
}

const toRect = (r: ArrayLike<number>): Rect => [r[0], r[1], r[2], r[3]];

/** A copy of a log entry, its matrices and bytes included. */
function copyEdit(e: LoggedEdit): LoggedEdit {
  if (e.kind === "text") return { ...e };
  const expect = [...e.expect] as Matrix;
  switch (e.op) {
    case "transform":
      return { ...e, expect, matrix: [...e.matrix] as Matrix };
    case "replace":
      return { ...e, expect, bytes: e.bytes.slice() };
    default:
      return { ...e, expect };
  }
}

const imageInfo = (p: Placement): ImageInfo => ({
  index: p.index,
  matrix: [...p.matrix] as Matrix,
  bbox: toRect(p.bbox),
  visible: toRect(p.visible),
  pixelWidth: p.pixelWidth,
  pixelHeight: p.pixelHeight,
  movable: p.movable,
  reason: p.reason,
});

/** The page's placements (images.findPlacements), a failure of MuPDF while reading them reported as "edit-failed". */
function placementsOf(mupdf: MuPDFModule, page: MuPDF.PDFPage): PagePlacements {
  try {
    return findPlacements(mupdf, page);
  } catch (err) {
    throw err instanceof DevicePassError ? new SessionError(err.message, "edit-failed") : err;
  }
}

/** Image `imageIndex` of the placements found, or "bad-request". */
function pickImage(found: PagePlacements, pageIndex: number, imageIndex: number): Placement {
  const p = Number.isInteger(imageIndex) ? found.placements[imageIndex] : undefined;
  if (!p) throw new SessionError(`No image ${imageIndex} on page ${pageIndex + 1}`, "bad-request");
  return p;
}

/** Does what a logged image edit says to placement `p` (found on `page` just before). */
function applyImageEdit(mupdf: MuPDFModule, doc: MuPDF.PDFDocument, page: MuPDF.PDFPage, found: PagePlacements, p: Placement, edit: ImageEdit) {
  switch (edit.op) {
    case "transform":
      transformPlacement(mupdf, doc, page, found, p, edit.matrix);
      break;
    case "delete":
      deletePlacement(mupdf, doc, page, found, p);
      break;
    case "replace": {
      const image = openImage(mupdf, edit.bytes);
      try {
        replacePlacement(mupdf, doc, page, found, p, image, edit.bytes);
      } finally {
        image.destroy();
      }
      break;
    }
  }
}

/** A matrix from the main thread, checked as untrusted: six finite numbers ("bad-request" otherwise). */
function matrixFrom(matrix: unknown): Matrix {
  if (!Array.isArray(matrix) || matrix.length !== 6 || !matrix.every((v) => typeof v === "number" && Number.isFinite(v)))
    throw new SessionError("An image matrix is six finite numbers", "bad-request");
  return [...matrix] as Matrix;
}

/**
 * Where an image now drawn at `current` may be drawn ("bad-request" otherwise): not degenerate,
 * each side within MIN_IMAGE_SIDE..MAX_IMAGE_SIDE, the centre on the page (so it can always be
 * grabbed again). A side already outside those limits only may not get further from them: it is
 * refused when shorter than both MIN_IMAGE_SIDE and its current length, or longer than both
 * MAX_IMAGE_SIDE and its current length (a 0.5 pt rule, or a 1-pixel spacer drawn at 0.75 pt, can
 * be moved and turned; a side is matched with the same side of `current`).
 */
function checkTarget(m: Matrix, bounds: Rect, current: Matrix) {
  if (!(Math.abs(m[0] * m[3] - m[1] * m[2]) > 1e-6)) throw new SessionError("The image matrix is degenerate", "bad-request");
  const sidesOf = (x: Matrix) => [Math.hypot(x[0], x[1]), Math.hypot(x[2], x[3])];
  const now = sidesOf(current);
  sidesOf(m).forEach((side, k) => {
    // (a little slack: a turn computed in floating point may shorten a side by a rounding error)
    const min = Math.min(MIN_IMAGE_SIDE, now[k] * (1 - 1e-6)), max = Math.max(MAX_IMAGE_SIDE, now[k] * (1 + 1e-6));
    if (!(side >= min && side <= max))
      throw new SessionError(`An image side of ${side} pt is outside ${MIN_IMAGE_SIDE}..${MAX_IMAGE_SIDE}`, "bad-request");
  });
  const cx = (m[0] + m[2]) / 2 + m[4], cy = (m[1] + m[3]) / 2 + m[5];
  if (!(cx >= bounds[0] && cx <= bounds[2] && cy >= bounds[1] && cy <= bounds[3]))
    throw new SessionError("The image's centre would be off the page", "bad-request");
}

/**
 * The scale and pixel box of a sprite covering `rect` (page space): the box rounded out to whole
 * pixels, at least one pixel each way, the scale lowered until it fits MAX_SPRITE_PIXELS and
 * MAX_RENDER_SIDE.
 */
export function spriteBox(rect: Rect, scale: number): { scale: number; box: Rect } {
  const w = Math.max(rect[2] - rect[0], 1e-3), h = Math.max(rect[3] - rect[1], 1e-3);
  const boxAt = (s: number): Rect => {
    const x0 = Math.floor(rect[0] * s), y0 = Math.floor(rect[1] * s);
    return [x0, y0, Math.max(x0 + 1, Math.ceil(rect[2] * s)), Math.max(y0 + 1, Math.ceil(rect[3] * s))];
  };
  const fits = ([x0, y0, x1, y1]: Rect) =>
    (x1 - x0) * (y1 - y0) <= MAX_SPRITE_PIXELS && x1 - x0 <= MAX_RENDER_SIDE && y1 - y0 <= MAX_RENDER_SIDE;
  let s = Math.min(scale, Math.sqrt(MAX_SPRITE_PIXELS / (w * h)), MAX_RENDER_SIDE / w, MAX_RENDER_SIDE / h);
  while (!fits(boxAt(s))) s *= 0.999;
  return { scale: s, box: boxAt(s) };
}

/**
 * The scale to draw a sprite at when the clips around it would hold `bytes` in the draw device at
 * `scale`: what they hold goes with the pixels, so with the square of the scale. Null when even
 * MIN_SPRITE_SCALE would be too much, or `scale` is that low already.
 */
function scaleWithin(bytes: number, scale: number): number | null {
  if (scale <= MIN_SPRITE_SCALE || bytes * (MIN_SPRITE_SCALE / scale) ** 2 > MAX_SPRITE_CLIP_BYTES) return null;
  return Math.max(MIN_SPRITE_SCALE, Math.min(scale * Math.sqrt(MAX_SPRITE_CLIP_BYTES / bytes) * 0.9, scale * 0.9));
}

/** Writes `doc` with MuPDF save `options`, copied out of the wasm heap: the buffer is exactly the file. */
function writeBytes(doc: MuPDF.PDFDocument, options: string): ArrayBuffer {
  const buf = doc.saveToBuffer(options);
  try {
    return buf.asUint8Array().slice().buffer;
  } finally {
    buf.destroy();
  }
}

/** Each non-whitespace character once, in order. */
function visibleChars(chars: string[]): string[] {
  return [...new Set(chars)].filter((c) => c.trim() !== "");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
