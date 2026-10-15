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
import { checkPdfA, convertToPdfA, countSignatures, dropPdfaClaim, pdfaClaim } from "./pdfa";
import { passwordProblem } from "./protocol";
import type {
  DocInfo,
  EditResult,
  EditSegment,
  HistoryState,
  LineInfo,
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
export interface LoggedEdit {
  pageIndex: number;
  /** The text the edit replaced (one whole line, without its leading/trailing whitespace). */
  find: string;
  /** Which match of `find` on the page, counted the way core.findInLines counts. */
  occurrence: number;
  replacement: string;
}

export type SessionErrorCode =
  /** No document is open. */
  | "no-document"
  /** Page or line index out of range, invalid scale. */
  | "bad-request"
  /** MuPDF could not apply the edit; the document is back to the state before it. */
  | "edit-failed"
  /** The line has characters the engine cannot rewrite safely (LineInfo.editable is false). */
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

    const edit: LoggedEdit = { pageIndex, find, occurrence, replacement };
    let result: ReturnType<typeof replaceText>;
    try {
      result = this.apply(doc, edit);
    } catch (err) {
      throw this.recover(`Could not edit the line: ${errorMessage(err)}`);
    }
    // Checkpoints beyond this point hold undone edits, which this one replaces for good.
    this.checkpoints = this.checkpoints.filter((c) => c.editCount <= this.log.length);
    this.log.push(edit);
    this.redoStack = [];
    this.checkpoint(doc);

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
    return this.log.map((e) => ({ ...e }));
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

  private apply(doc: MuPDF.PDFDocument, edit: LoggedEdit) {
    return replaceText(this.mupdf, doc, edit.pageIndex, edit.find, edit.replacement, { occurrence: edit.occurrence });
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
