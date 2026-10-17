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
// number and core.restoreFallbackFonts finds the fallback fonts again in the re-opened copy. Its
// uncompressed pictures are compressed (MuPDF stores a PNG's pixels raw: a 2000×1500 photo would
// make every checkpoint 9 MB on a form of a few KB). Compressing is slow, so it is done once per
// picture: after every snapshot (a checkpoint, a save, the PDF/A check) the session carries on
// with that snapshot re-opened (continueOn), as undo carries on with a rebuilt document, and the
// next snapshots copy the compressed pictures as they are.
//
// forms.ts keeps the document's field index between calls; the session tells it whenever the
// document changes or is replaced (forms.formChanged).
//
// Fill and sign (release 3, ARCHITECTURE.md "Fill and sign") adds four kinds of logged edit, all
// plain data and replayed like the others: a form field filled in (forms.ts, identified by its
// full name and the type it must still have), a new line of text, a change to a line the app
// wrote, and a new picture on one or more pages (newcontent.ts). Lines and pictures the app
// writes sit in marked blocks of their own: an edit of such a line rewrites its block instead of
// redacting (replaceLine routes it), and a normal line edit puts back any added line its
// redaction damaged (protectAdded), so both are part of the logged edit and every replay does the
// same. A line MuPDF reads as printed text and added text together (a date written just after its
// label) is edited part by part: the printed part by redaction, each added line in its block and
// its own style. A picture the app embeds is kept once per document also across checkpoints
// (sharePicture).
//
// Decorations (ARCHITECTURE.md, "Decorations"): an edit of a plain printed line also stretches or
// shrinks its underline, its strike-through and its links, and its background or border when the
// user chooses, or removes them with its text (decorations.ts): part of the same logged edit. The
// TextEdit logs the plan as it was carried out (shapes by their page-space bounds and paint, links
// by rect and URI, each with the characters it decorates: no resource names, no offsets), and
// every replay applies it as logged, failing like an image edit when the page does not have what
// it says.
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
import { applyDecorations, beforeEdit, detectDecorations, mapRun, planOf, summaryOf, type DecorationPlan, type Detected } from "./decorations";
import { FieldError, applyFieldEdit, formChanged, formInfo, hidePasswords, pageFields, planFieldEdit, type FieldEdit } from "./forms";
import {
  BadPicture,
  DevicePassError,
  MAX_SPRITE_CLIP_BYTES,
  SpriteClipBudget,
  checkPicture as readPicture,
  deletePlacement,
  findPlacements,
  nearlyEqual,
  openImage,
  renderPlacement,
  replacePlacement,
  straightRGBA,
  transformPlacement,
  turnOf,
  type PagePlacements,
  type Picture,
  type Placement,
} from "./images";
import {
  ContentError,
  addImage as addPicture,
  addText as addLine,
  addedBlocks,
  addedLineIds,
  addedTexts,
  missingChars,
  protectAdded,
  rewriteAdded,
} from "./newcontent";
import { checkPdfA, convertToPdfA, countSignatures, dropPdfaClaim, pdfaClaim } from "./pdfa";
import { MAX_ALT_CHARS, MAX_IMAGE_SIDE, MAX_TEXT_CHARS, MAX_TEXT_SIZE, MIN_IMAGE_SIDE, MIN_TEXT_SIZE, passwordProblem } from "./protocol";
import type {
  AddImageResult,
  AddTextResult,
  AddedText,
  DecorationReport,
  DocInfo,
  EditResult,
  EditSegment,
  FieldEditResult,
  FieldValue,
  FieldWidget,
  FormInfo,
  HistoryState,
  ImageEditResult,
  ImageInfo,
  ImageTarget,
  LineDecorations,
  LineEditOptions,
  LineInfo,
  Matrix,
  OpenResult,
  PageInfo,
  PdfaReport,
  Rect,
  SaveOptions,
  SaveResult,
  SegmentSource,
  TextStyle,
} from "./protocol";

export type { FieldEdit } from "./forms";

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
 * Image streams without a filter are compressed (Flate; numbers stay the same): MuPDF embeds a
 * PNG as raw pixels, about seven times the file, which every checkpoint would otherwise hold in
 * the worker's memory (a 1200×400 signature on a small form: 1.5 MB a checkpoint instead of 70
 * KB). Streams that have a filter already (JPEG, Flate...) are copied as they are, which is quick;
 * compressing is not: in Node, about 10 ms for that signature and 50 to 300 ms for a 2000×1500
 * PNG with transparency (12 MB of pixels; the more detail, the slower), several times that on a
 * phone. So the session carries on with every snapshot it takes re-opened (continueOn): each
 * picture is compressed once, by the first snapshot after it was embedded, and never again (four
 * such photos: the first checkpoint after them takes about 1 s, the next ones under 20 ms).
 */
const SNAPSHOT_OPTIONS = "encrypt=none,compress-images=yes";

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
  /** The pictures the app had embedded in it (sharePicture). */
  pictures: readonly EmbeddedPicture[];
}

/**
 * A picture the app embedded (addImage, a replace) and the image XObject that holds it: what
 * sharePicture needs to keep one copy of a picture per document. Object numbers survive a
 * snapshot (no garbage collection), so the list goes with the checkpoints as it is.
 */
interface EmbeddedPicture {
  /** The picture file's bytes (Picture.bytes: what images.pictureObject compares). */
  bytes: Uint8Array;
  num: number;
  /** Its /OC: 0 for none, else the layer's object number (a replacement keeps the old picture's layer). */
  layer: number;
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
export type LoggedEdit = TextEdit | ImageEdit | FieldEdit | AddTextEdit | AddedTextEdit | AddImageEdit | MixedLineEdit;

/** One whole line of text replaced (deleted when `replacement` is empty). */
export interface TextEdit {
  kind: "text";
  pageIndex: number;
  /**
   * The text the edit replaced (one whole line, without its leading/trailing whitespace; or the
   * printed part of a line that holds text the app wrote too: see MixedLineEdit).
   */
  find: string;
  /** Which match of `find` on the page, counted the way core.findInLines counts. */
  occurrence: number;
  replacement: string;
  /**
   * The line's shapes and links that follow the new text, or go with it (decorations.ts): what
   * the edit did to them when it was new, applied as it is by every replay. Absent when it did
   * nothing to any (always for the printed part of a MixedLineEdit).
   */
  decorations?: DecorationPlan;
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
  /**
   * Replaced with this picture (images.checkPicture: the file's bytes, a JPEG without its
   * metadata, a private copy undo replays; its EXIF orientation turns it upright).
   */
  | { op: "replace"; picture: Picture }
);

/**
 * A new line of text (newcontent.addText): `text` already checked and made one line, its baseline
 * starting at `origin` (page space). `id` is the one the line got (its marked block's /PEText):
 * a replay that gives another one no longer fits the log, since later edits of the line name it.
 */
export interface AddTextEdit {
  kind: "addText";
  pageIndex: number;
  origin: [number, number];
  text: string;
  style: TextStyle;
  id: number;
}

/**
 * A line the app wrote (AddedText.id) rewritten in its own block (newcontent.rewriteAdded): what
 * is given changes, the rest stays; an empty `text` deletes it. Made by editAddedText, and by
 * replaceLine for a line made only of added text: there `absorb` lists the other added lines
 * MuPDF reads as part of the same line (written one after the other on one baseline), which go,
 * their text being in `text`. replaceLine also makes one (alone or in a MixedLineEdit) for the
 * added part of a line that has printed text too.
 */
export interface AddedTextEdit {
  kind: "editAdded";
  pageIndex: number;
  id: number;
  text?: string;
  origin?: [number, number];
  style?: TextStyle;
  absorb?: number[];
}

/**
 * One line edit of a line MuPDF reads as printed text and text the app wrote together (a label
 * and the date written just after it, on its baseline), made by replaceLine when more than one
 * part of it changes, or when its printed part changes and added lines follow it (which move
 * right when it grows): the printed part by redaction (at most one TextEdit, first: its
 * occurrence is counted on the page as it was) and each added line in its own block
 * (AddedTextEdits: text, place), so the user's text keeps its style and stays theirs. Applied in
 * order.
 */
export interface MixedLineEdit {
  kind: "mixed";
  pageIndex: number;
  edits: (TextEdit | AddedTextEdit)[];
}

/**
 * A new picture (newcontent.addImage) at each target, one per page: one edit, the picture
 * embedded once (initials on every page). `picture` is a private copy, as for a replace.
 */
export interface AddImageEdit {
  kind: "addImage";
  /** The first target's page (code that reads LoggedEdit.pageIndex); pagesOf gives them all. */
  pageIndex: number;
  picture: Picture;
  targets: ImageTarget[];
  /** The description on tagged pages (a Figure's /Alt), null for decoration (an Artifact). */
  alt: string | null;
}

/** The pages an edit changes, ascending: what undo and redo report as changedPages. */
export function pagesOf(e: LoggedEdit): number[] {
  switch (e.kind) {
    case "field":
      return [...e.pages];
    case "addImage":
      return [...new Set(e.targets.map((t) => t.pageIndex))].sort((a, b) => a - b);
    default:
      return [e.pageIndex];
  }
}

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
   * The line has characters the engine cannot rewrite safely (LineInfo.editable is false), the
   * image is locked (ImageInfo.movable is false), the form field is locked (FieldWidget.locked),
   * or the page's content cannot take new text or a new picture safely (newcontent.ts).
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

/** Control characters and lone surrogates: they draw nothing, and no font has them. */
const UNDRAWN = /[\u0000-\u001f\u007f-\u009f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * Text from the main thread for a line the app writes (addText, editAddedText), checked as
 * untrusted: a string ("bad-request" otherwise), made one line (normalizeLineText), without the
 * characters that draw nothing, at most MAX_TEXT_CHARS characters. May be empty.
 */
function lineFrom(text: unknown): string {
  if (typeof text !== "string") throw new SessionError("The text must be a string", "bad-request");
  const line = normalizeLineText(text).replace(UNDRAWN, "").trim();
  if ([...line].length > MAX_TEXT_CHARS) throw new SessionError(`A line holds at most ${MAX_TEXT_CHARS} characters`, "bad-request");
  return line;
}

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
  /** The pictures the app embedded in each document, the working one and those being rebuilt (sharePicture; never changed in place). */
  private pictures = new WeakMap<MuPDF.PDFDocument, readonly EmbeddedPicture[]>();

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
      // A stored password value is never drawn in clear on screen (forms.hidePasswords): the
      // original is given the same frame-only appearance at every open, so every base a replay
      // starts from (this, openOriginal, checkpoints taken from it) is the same.
      hidePasswords(this.mupdf, doc);
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
      form: readForm(this.mupdf, doc),
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

  /**
   * The page's text lines, in MuPDF's reading order; whitespace-only lines are left out. Form
   * field values are not lines (MuPDF leaves widget appearances out); a line the app wrote is
   * marked `added`.
   */
  lines(pageIndex: number): LineInfo[] {
    const doc = this.requireDoc();
    this.checkPage(doc, pageIndex);
    const page = doc.loadPage(pageIndex);
    let raw: RawLine[] = [], glyphs: Glyph[] = [];
    try {
      raw = extractLines(page);
      glyphs = captureGlyphs(this.mupdf, page);
      const locked = linesBeyondBMP(raw, glyphs);
      const blocks = addedBlocks(page); // (nothing is read on a page the app wrote no text on)
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
          added: blocks.length > 0 && addedLineIds(this.mupdf, doc, pageIndex, line, blocks) !== null,
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
   * - A line made only of text the app wrote (LineInfo.added) is rewritten in its own marked
   *   blocks, never redacted, so what lies under it (a form's underscores, a box) stays: logged
   *   as an AddedTextEdit, in the app's fonts of its first block (no segments, no fallbackChars).
   * - A line MuPDF reads as printed text and text the app wrote together (written just after a
   *   label, on its baseline: LineInfo.added is false) is edited part by part (splitLine): only
   *   the parts that change, the printed one by redaction, each added line in its own block and
   *   style (a TextEdit or an AddedTextEdit, or a MixedLineEdit of them). A change of nothing but
   *   the space between the parts is a no-op; one that would rewrite two printed parts is
   *   refused ("not-editable"). When the printed part ends further right than before, the
   *   added lines after it move right as much.
   * - Any other line is redacted and written again (core.replaceText); the lines the app wrote
   *   over or under it that the redaction damaged are written back as they were (protectAdded).
   *   Its decorations (decorations.ts) go with the text, in the same edit: the underlines,
   *   strike-throughs and links that follow it by themselves, and the background or border
   *   around it (LineDecorations.box) when `options.box` says so (absent: as suggested); found
   *   on the page before the edit, stretched or shrunk to the new text after it, or removed with
   *   it. EditResult.decorations says what followed, what went and what stayed as it was (and
   *   why: what stays is said when the edit changed or moved its characters, or deleted the
   *   line); it is absent when there is nothing to say. A vertical line's (wmode 1) all stay,
   *   with the reason ("direction").
   * - `options` that are not an object with at most a boolean `box` are refused ("bad-request"),
   *   with nothing done; mixed and added lines leave them aside.
   */
  replaceLine(pageIndex: number, lineIndex: number, text: string, options?: LineEditOptions): EditResult {
    const doc = this.requireDoc();
    this.checkPage(doc, pageIndex);
    const box = boxOption(options);
    const replacement = normalizeLineText(text);
    const { find, occurrence, added, parts } = this.locateLine(doc, pageIndex, lineIndex);
    const unchanged: EditResult = {
      ...this.history([]),
      pageIndex,
      before: find,
      after: find,
      segments: [],
      fallbackChars: [],
      missingChars: [],
    };
    if (replacement === find) return unchanged;

    if (parts) {
      const { edits, printed } = mixedLineEdits(pageIndex, find, replacement, parts);
      for (const e of edits) if (e.kind === "editAdded" && e.text) this.checkDrawable(e.text, parts.find((p) => p.id === e.id)!.style!);
      if (!edits.length) return unchanged;
      // The added lines after a printed part that changes move with its end (applyLine).
      const followers = printed ? parts.filter((p) => p.id && p.start >= printed.end) : [];
      const flow: LineFlow | null = printed && followers.length
        ? { start: printed.origin, right: printed.right, maxX: this.boundsOf(doc, pageIndex)[2], followers: followers.map((p) => ({ id: p.id, origin: p.origin })) }
        : null;
      const edit: LineEdit = edits.length === 1 && !flow ? edits[0] : { kind: "mixed", pageIndex, edits };
      const r = this.commit(doc, edit, () => this.applyLine(doc, edit, flow), "Could not edit the line");
      const told = r.text ? textOutcome(r.text) : { segments: [], fallbackChars: [], missingChars: [] };
      return {
        ...this.history([pageIndex]),
        pageIndex,
        before: find,
        after: replacement,
        ...told,
        missingChars: visibleChars([...told.missingChars, ...r.missing]),
      };
    }

    if (added) {
      const edit: AddedTextEdit = { kind: "editAdded", pageIndex, id: added[0], text: replacement };
      if (added.length > 1) edit.absorb = added.slice(1);
      const r = this.commit(doc, edit, () => this.applyAdded(doc, edit), "Could not edit the line");
      return {
        ...this.history([pageIndex]),
        pageIndex,
        before: find,
        after: replacement,
        segments: [],
        fallbackChars: [],
        missingChars: visibleChars(r.missing),
      };
    }

    // (A vertical line's decorations are all "left", with "direction": nothing is planned.)
    const detected = this.detectDecorations(doc, pageIndex, find, occurrence);
    const edit: TextEdit = { kind: "text", pageIndex, find, occurrence, replacement };
    const plan = detected ? planOf(detected, box) : null;
    if (plan && (plan.shapes.length || plan.links.length)) edit.decorations = plan;
    const r = this.commit(doc, edit, () => this.applyText(doc, edit, "new"), "Could not edit the line");
    return {
      ...this.history([pageIndex]),
      pageIndex,
      before: find,
      after: replacement,
      ...textOutcome(r.text),
      ...decorationOutcome(detected, r.decorations, find, r.written),
    };
  }

  /**
   * What follows line `lineIndex` (LineInfo.index) of the page if it is edited, for the line
   * editor (decorations.ts): the underlines, strike-throughs and links that follow by themselves,
   * the background or border that may follow (the option, and whether it starts ticked), and
   * what stays as it is (with the reason: on a vertical line, everything, "direction"). Nothing
   * for a line that holds text the app wrote (mixed or added: replaceLine leaves their
   * decorations as they are).
   */
  lineDecorations(pageIndex: number, lineIndex: number): LineDecorations {
    const doc = this.requireDoc();
    this.checkPage(doc, pageIndex);
    const { find, occurrence, added, parts } = this.locateLine(doc, pageIndex, lineIndex);
    const detected = added || parts ? null : this.detectDecorations(doc, pageIndex, find, occurrence);
    return detected ? summaryOf(detected) : { underlines: 0, strikes: 0, links: 0, box: null, left: [] };
  }

  /**
   * The decorations of a plain printed line (decorations.detectDecorations: `find` at
   * `occurrence`), or null when they could not be read: the decorations are an extra, so the
   * line is then edited as it would be without them (and lineDecorations says so: nothing).
   */
  private detectDecorations(doc: MuPDF.PDFDocument, pageIndex: number, find: string, occurrence: number): Detected | null {
    try {
      return detectDecorations(this.mupdf, doc, pageIndex, find, occurrence);
    } catch {
      return null;
    }
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
   * the same rotation, never mirrored (images.replacePlacement); a JPEG is embedded as it is
   * (without the metadata that describes the photo: EXIF, GPS, XMP, comments; its EXIF
   * orientation turns the placement, so a photo stored sideways shows upright), the same bytes
   * once however many places they go, in the old picture's layer (/OC). Other placements of the
   * old picture stay. More than MAX_IMAGE_BYTES, or bytes that are not a picture, are refused
   * ("bad-request") before anything is done. `bytes` is copied, unless `transfer` is set (as for
   * open()).
   */
  replaceImage(pageIndex: number, imageIndex: number, bytes: ArrayBuffer | Uint8Array, { transfer = false } = {}): ImageEditResult {
    const doc = this.requireDoc();
    this.checkPage(doc, pageIndex);
    const picture = this.checkPicture(bytes, transfer);
    this.editImage(doc, pageIndex, imageIndex, "Could not replace the image", (p) =>
      ({ kind: "image", pageIndex, imageIndex, expect: p.matrix, op: "replace", picture }));
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
      this.commit(doc, edit, () => this.applyPlacementEdit(doc, page, found, p, edit), failure);
      return true;
    } finally {
      page.destroy(); // its document may be gone already (a rollback, or a checkpoint's continueOn): the page kept it alive until here
    }
  }

  /**
   * A picture file for a replace or an addition, checked as untrusted (images.checkPicture: at
   * most MAX_IMAGE_BYTES, readable, a JPEG without its metadata, its orientation read;
   * "bad-request" otherwise), its bytes a private copy unless transferred.
   */
  private checkPicture(bytes: ArrayBuffer | Uint8Array, transfer: boolean): Picture {
    if (!(bytes instanceof ArrayBuffer) && !(bytes instanceof Uint8Array)) throw new SessionError("No picture given", "bad-request");
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let picture: Picture;
    try {
      picture = readPicture(this.mupdf, view);
    } catch (err) {
      throw err instanceof BadPicture ? new SessionError(err.message, "bad-request") : err;
    }
    // (checkPicture gives the caller's own bytes back when it had nothing to take out)
    return picture.bytes === view && !transfer ? { ...picture, bytes: view.slice() } : picture;
  }

  // ------------------------------------------------------------------ fill and sign

  /**
   * The page's form field widgets (FieldWidget), in its tab order: hidden, NoView and zero-area
   * widgets left out, each with what the overlay needs and why the app does not fill it (locked).
   */
  fields(pageIndex: number): FieldWidget[] {
    const doc = this.requireDoc();
    this.checkPage(doc, pageIndex);
    return pageFields(this.mupdf, doc, pageIndex);
  }

  /**
   * Fills in the field named `name` (its full name): every field dictionary with that name and
   * all their widgets, on every page, one edit (forms.ts: MuPDF's drawing for WinAnsi text, the
   * app's writer for anything else and for list boxes; never MuPDF's toggle() for buttons; a
   * static XFA part goes on the first field edit). changedPages lists every page with a widget of
   * the field (all pages with widgets when the form had /NeedAppearances: the first edit gives
   * every field its appearance).
   *
   * - A value the field holds already (every dictionary with the name) is a no-op: nothing is
   *   logged, the redo stack is kept and changedPages is empty.
   * - An unknown name, or a value the field cannot take (a choice it does not offer, more
   *   characters than MaxLen or MAX_FIELD_CHARS, a state it does not have), is refused
   *   ("bad-request"); a locked field (FieldWidget.locked) too ("not-editable"); nothing is done.
   * - Characters no font of the app has stay in the value and are left out of the drawing
   *   (missingChars); `overflow` says the text does not fit the box.
   */
  setField(name: string, value: FieldValue): FieldEditResult {
    const doc = this.requireDoc();
    let edit: FieldEdit | null;
    try {
      edit = planFieldEdit(this.mupdf, doc, name, value);
    } catch (err) {
      throw err instanceof FieldError ? new SessionError(err.message, err.code) : err;
    }
    if (!edit) return { ...this.history([]), name, missingChars: [], overflow: false };
    const planned = edit;
    const r = this.commit(doc, planned, () => applyFieldEdit(this.mupdf, doc, planned), "Could not fill in the field");
    return { ...this.history(pagesOf(planned)), name: planned.name, missingChars: visibleChars(r.missingChars), overflow: r.overflow };
  }

  /**
   * Writes a new line of real text on the page (newcontent.addText): `text` made one line (line
   * breaks and tabs become spaces, leading and trailing whitespace and characters that draw
   * nothing dropped), its baseline starting at `origin` (page space), horizontal as seen, in the
   * app's embedded fonts of `style`, over the page's content, in a marked block of its own.
   * Characters no font of the app has (emoji, beyond U+FFFF) are left out and listed in
   * missingChars. Refused, with nothing done: an origin off the page, an empty text or one longer
   * than MAX_TEXT_CHARS, a style out of range, a text with nothing that can be drawn
   * ("bad-request"); a page whose content cannot take an addition ("not-editable").
   */
  addText(pageIndex: number, origin: [number, number], text: string, style: TextStyle): AddTextResult {
    const doc = this.requireDoc();
    this.checkPage(doc, pageIndex);
    const at = this.pointOnPage(doc, pageIndex, origin);
    const line = lineFrom(text);
    if (!line) throw new SessionError("The text is empty", "bad-request");
    const st = styleFrom(style);
    this.checkDrawable(line, st);
    const edit: AddTextEdit = { kind: "addText", pageIndex, origin: at, text: line, style: st, id: 0 };
    const r = this.commit(doc, edit, () => {
      const out = addLine(this.mupdf, doc, pageIndex, at, line, st);
      edit.id = out.id; // logged right after this: replays must give the line the same id
      return out;
    }, "Could not add the text");
    return { ...this.history([pageIndex]), pageIndex, id: r.id, missingChars: visibleChars(r.missing) };
  }

  /** The page's texts written by the app (AddedText), in content order, each with its id to edit it. */
  addedTexts(pageIndex: number): AddedText[] {
    const doc = this.requireDoc();
    this.checkPage(doc, pageIndex);
    return addedTexts(this.mupdf, doc, pageIndex);
  }

  /**
   * Changes the text the app wrote with id `id` (AddedText.id) in place, in its own block: its
   * text (checked as addText checks it; empty deletes it), its baseline start (on the page) and
   * its style, each when given. The id stays (null after a delete). Nothing new is a no-op
   * (nothing logged, changedPages empty). Refused ("bad-request"): no such text on the page, a
   * patch out of range, a text with nothing that can be drawn.
   */
  editAddedText(pageIndex: number, id: number, patch: { text?: string; origin?: [number, number]; style?: TextStyle } = {}): AddTextResult {
    const doc = this.requireDoc();
    this.checkPage(doc, pageIndex);
    if (!Number.isInteger(id) || id < 1) throw new SessionError(`No text ${id} written by the app on page ${pageIndex + 1}`, "bad-request");
    const current = addedTexts(this.mupdf, doc, pageIndex).find((t) => t.id === id);
    if (!current) throw new SessionError(`No text ${id} written by the app on page ${pageIndex + 1}`, "bad-request");
    const change = (patch ?? {}) as { text?: unknown; origin?: unknown; style?: unknown };
    const edit: AddedTextEdit = { kind: "editAdded", pageIndex, id };
    if (change.text !== undefined) edit.text = lineFrom(change.text);
    if (change.origin !== undefined) edit.origin = this.pointOnPage(doc, pageIndex, change.origin);
    if (change.style !== undefined) edit.style = styleFrom(change.style);
    const unchanged =
      (edit.text === undefined || edit.text === current.text) &&
      (edit.origin === undefined || Math.hypot(edit.origin[0] - current.origin[0], edit.origin[1] - current.origin[1]) < 0.001) &&
      (edit.style === undefined || sameStyle(edit.style, current.style));
    if (unchanged) return { ...this.history([]), pageIndex, id, missingChars: [] };
    if (edit.text) this.checkDrawable(edit.text, edit.style ?? current.style);
    const r = this.commit(doc, edit, () => this.applyAdded(doc, edit), "Could not change the text");
    return { ...this.history([pageIndex]), pageIndex, id: r.id, missingChars: visibleChars(r.missing) };
  }

  /**
   * Draws a new picture (file bytes MuPDF can read: JPEG, PNG...; a JPEG without its metadata and
   * turned upright by its EXIF orientation) at each target (ImageInfo.matrix convention), over the
   * page's content, in a marked block of its own: one edit, the picture embedded once (initials on
   * every page). On a tagged page it is a Figure described by `alt` (at most MAX_ALT_CHARS), or an
   * Artifact when `alt` is null. `placed` gives each new placement's index in its page's images
   * (null when that page's images are locked). Refused, with nothing done ("bad-request"): no
   * target or more than one per page, a matrix checked as transformImage checks a move (each side
   * within MIN_IMAGE_SIDE..MAX_IMAGE_SIDE, the centre on the page), a bad description, bytes that
   * are not a picture or more than MAX_IMAGE_BYTES; a page whose content cannot take an addition
   * ("not-editable"). `bytes` is copied, unless `transfer` is set (as for open()).
   */
  addImage(bytes: ArrayBuffer | Uint8Array, targets: ImageTarget[], alt: string | null, { transfer = false } = {}): AddImageResult {
    const doc = this.requireDoc();
    if (!Array.isArray(targets) || targets.length === 0) throw new SessionError("A picture needs at least one target", "bad-request");
    const checked: ImageTarget[] = [];
    for (const t of targets as unknown[]) {
      const pageIndex = (t as Partial<ImageTarget> | null)?.pageIndex as number;
      this.checkPage(doc, pageIndex);
      if (checked.some((c) => c.pageIndex === pageIndex)) throw new SessionError(`Two targets on page ${pageIndex + 1}`, "bad-request");
      const matrix = matrixFrom((t as Partial<ImageTarget>).matrix);
      checkTarget(matrix, this.boundsOf(doc, pageIndex), UNIT_SQUARE);
      checked.push({ pageIndex, matrix });
    }
    const description = altFrom(alt);
    const picture = this.checkPicture(bytes, transfer);
    const edit: AddImageEdit = { kind: "addImage", pageIndex: checked[0].pageIndex, picture, targets: checked, alt: description };
    const placed = this.commit(doc, edit, () => this.applyAddImage(doc, edit, true), "Could not add the picture");
    return { ...this.history(pagesOf(edit)), placed };
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
    return this.history(pagesOf(last));
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
    return this.history(pagesOf(next));
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
   * working document (re-opened twice: as the copy, and as the working document from now on,
   * continueOn), or, when the session is broken (the working document may be half-edited),
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
    const fonts = fallbackFontState(doc);
    const snapshot = doc.saveToBuffer(SNAPSHOT_OPTIONS);
    let scratch: MuPDF.PDFDocument;
    try {
      scratch = this.openSnapshot(snapshot); // the document keeps its own reference to the buffer
      try {
        restoreFallbackFonts(scratch, fonts);
      } catch (err) {
        this.dispose(scratch);
        throw err;
      }
      // The snapshot compressed the pictures embedded since the last one: the next one (save after
      // the PDF/A check, a checkpoint) need not do it again.
      this.continueOn(doc, snapshot, fonts);
    } finally {
      snapshot.destroy();
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

  /** The page's bounds (page space). */
  private boundsOf(doc: MuPDF.PDFDocument, pageIndex: number): Rect {
    const page = doc.loadPage(pageIndex);
    try {
      return toRect(page.getBounds());
    } finally {
      page.destroy();
    }
  }

  /** A point from the main thread, checked as untrusted: two finite numbers on the page ("bad-request" otherwise). */
  private pointOnPage(doc: MuPDF.PDFDocument, pageIndex: number, p: unknown): [number, number] {
    if (!Array.isArray(p) || p.length !== 2 || !p.every((v) => typeof v === "number" && Number.isFinite(v)))
      throw new SessionError("A point is two finite numbers", "bad-request");
    const [x0, y0, x1, y1] = this.boundsOf(doc, pageIndex);
    if (!(p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1)) throw new SessionError("The point is off the page", "bad-request");
    return [p[0], p[1]];
  }

  /** Refuses ("bad-request") a text none of whose characters a font of the app can draw in `style`. */
  private checkDrawable(text: string, style: TextStyle) {
    const missing = missingChars(this.mupdf, text, style);
    if ([...text].every((c) => c.trim() === "" || missing.includes(c)))
      throw new SessionError("No character of the text can be drawn", "bad-request");
  }

  /**
   * The text an edit of this line must find, which occurrence on the page is this line, the ids
   * of the app's added blocks it consists of (null: it is not made only of added text, the usual
   * case), and its parts when it holds both printed text and text the app wrote (lineParts; null
   * otherwise), each printed part with its own occurrence. core.findInLines counts every match
   * in line order, including matches inside other lines (a line "Note" also matches inside an
   * earlier "Note bene"), so the occurrence is the number of matches in the lines before this
   * one. Within the line itself the trimmed text can only match at its own start: what precedes
   * it is whitespace (a part counts the matches before it in the line too).
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
      const blocks = addedBlocks(page);
      const added = blocks.length ? addedLineIds(this.mupdf, doc, pageIndex, target, blocks) : null;
      let parts: LinePart[] | null = null;
      if (blocks.length && !added && target.wmode !== 1) {
        parts = lineParts(target, addedTexts(this.mupdf, doc, pageIndex));
        const lead = target.text.length - target.text.trimStart().length;
        for (const p of parts ?? []) {
          if (p.id) continue;
          const at = lead + p.start;
          p.occurrence = raw.slice(0, raw.indexOf(target)).reduce((n, l) => n + countOccurrences(l.text, p.text), 0);
          for (let i = target.text.indexOf(p.text); i >= 0 && i < at; i = target.text.indexOf(p.text, i + 1)) p.occurrence++;
          const part = findInLines(raw, p.text, p.occurrence);
          if (!part || part.line !== target || part.start !== at) throw new Error("line lookup mismatch");
        }
      }
      return { find, occurrence, added, parts };
    } finally {
      releasePage(page, raw, glyphs);
    }
  }

  /**
   * Applies a new edit through `run` and records it: if it fails the document is rolled back
   * (recover, "edit-failed"); if not, the edit is logged, the redo stack cleared and a checkpoint
   * taken when due (after which `doc` is no longer the working document: continueOn). A refusal
   * of newcontent.ts (the page's content cannot take an addition, nothing of a text can be drawn)
   * keeps its own code after the rollback.
   */
  private commit<T>(doc: MuPDF.PDFDocument, edit: LoggedEdit, run: () => T, failure: string): T {
    let result: T;
    try {
      result = run();
    } catch (err) {
      const recovered = this.recover(`${failure}: ${errorMessage(err)}`);
      if (recovered.code === "edit-failed" && err instanceof ContentError) throw new SessionError(err.message, err.code);
      throw recovered;
    }
    formChanged(doc);
    // Checkpoints beyond this point hold undone edits, which this one replaces for good.
    this.checkpoints = this.checkpoints.filter((c) => c.editCount <= this.log.length);
    this.log.push(edit);
    this.redoStack = [];
    this.checkpoint(doc);
    return result;
  }

  /**
   * Applies a logged edit again (redo, rebuild), and tells forms.ts the document changed. Throws
   * when the document no longer fits it (the caller then drops the document).
   */
  private apply(doc: MuPDF.PDFDocument, edit: LoggedEdit) {
    switch (edit.kind) {
      case "text":
        this.applyText(doc, edit, "replay");
        break;
      case "image":
        this.applyImage(doc, edit);
        break;
      case "field":
        applyFieldEdit(this.mupdf, doc, edit);
        break;
      case "addText": {
        const { id } = addLine(this.mupdf, doc, edit.pageIndex, edit.origin, edit.text, edit.style);
        if (id !== edit.id) throw new Error(`The new text on page ${edit.pageIndex + 1} got id ${id}, the log has ${edit.id}`);
        break;
      }
      case "editAdded":
        this.applyAdded(doc, edit);
        break;
      case "mixed":
        this.applyLine(doc, edit);
        break;
      case "addImage":
        this.applyAddImage(doc, edit, false);
        break;
      default: {
        const unknown: never = edit;
        throw new Error(`Unknown edit ${JSON.stringify(unknown)}`);
      }
    }
    formChanged(doc);
  }

  /**
   * A line edit (core.replaceText). Its redaction is geometric: it removes whatever lies under
   * the line's characters, the lines the app wrote there included (a name written over a form's
   * line, a check mark over a box). protectAdded notes them first and writes back, as they were,
   * those the redaction damaged: all of the page's, since a TextEdit never covers text the app
   * wrote (replaceLine routes a line holding some to its blocks, or edits only its printed part).
   * Part of the edit: every replay does it.
   *
   * With `edit.decorations`, the line's place is read first (decorations.beforeEdit), and once
   * the new text is written and the added lines are back, the planned shapes and links follow it
   * or go with it (applyDecorations; `written`: what replaceText wrote as MuPDF reads it on the
   * page, writtenText). `mode` "new" (replaceLine): what of the plan cannot be carried out stays
   * as it is and is reported, and the edit keeps the plan as carried out (none: no decorations),
   * which commit then logs; "replay" (redo, rebuild): the plan is applied as logged, and a page
   * that does not fit it fails the replay (DecorationMismatch), as an image edit's `expect` does.
   * Returns replaceText's result, the decorations' report (null without a plan) and `written`.
   */
  private applyText(doc: MuPDF.PDFDocument, edit: TextEdit, mode: "new" | "replay") {
    const plan = edit.decorations;
    const before = plan ? beforeEdit(this.mupdf, doc, edit.pageIndex, edit.find, edit.occurrence) : null;
    const restore = protectAdded(this.mupdf, doc, edit.pageIndex);
    const text = replaceText(this.mupdf, doc, edit.pageIndex, edit.find, edit.replacement, { occurrence: edit.occurrence });
    restore();
    const written = writtenText(doc, edit.pageIndex, text);
    if (!plan || !before) return { text, decorations: null, written };
    const { applied, report } = applyDecorations(this.mupdf, doc, edit.pageIndex, plan, before, edit.find, written, mode === "replay");
    if (mode === "new") {
      if (applied.shapes.length || applied.links.length) edit.decorations = applied;
      else delete edit.decorations;
    }
    return { text, decorations: report, written };
  }

  /** Rewrites a line the app wrote in its own block, and removes the blocks it absorbs (AddedTextEdit). */
  private applyAdded(doc: MuPDF.PDFDocument, edit: AddedTextEdit) {
    const r = rewriteAdded(this.mupdf, doc, edit.pageIndex, edit.id, { text: edit.text, origin: edit.origin, style: edit.style });
    for (const id of edit.absorb ?? []) rewriteAdded(this.mupdf, doc, edit.pageIndex, id, { text: "" });
    return r;
  }

  /**
   * Applies the edit replaceLine made of a line with printed and added parts, in order. Returns
   * the printed part's core.replaceText result (null when it did not change) and the characters
   * the added lines left out. With `flow` (the edit is new, not a replay), once the printed part
   * is written: if it now ends further right than it did, the added lines after it on the line
   * move right as much, so that the line does not run into itself ("Data:" made "Data di
   * nascita:" before a date written after it). The moves join the edit's AddedTextEdits, so
   * replays make them as they are logged.
   */
  private applyLine(doc: MuPDF.PDFDocument, edit: LineEdit, flow: LineFlow | null = null): { text: ReturnType<typeof replaceText> | null; missing: string[] } {
    let text: ReturnType<typeof replaceText> | null = null;
    const missing: string[] = [];
    const list = edit.kind === "mixed" ? edit.edits : [edit];
    for (let k = 0; k < list.length; k++) { // (the flow below may add to the list)
      const e = list[k];
      if (e.kind === "editAdded") {
        missing.push(...this.applyAdded(doc, e).missing);
        continue;
      }
      // (Its printed part carries no decorations: a new edit or a replay, it is the same.)
      text = this.applyText(doc, e, "replay").text;
      const drawn = drawnText(text);
      const right = flow && drawn ? printedRight(doc, e.pageIndex, flow.start, drawn) : null;
      const shift = right === null ? 0 : right - flow!.right;
      if (!(shift > 0.01)) continue;
      for (const f of flow!.followers) {
        const x = f.origin[0] + shift;
        if (x > flow!.maxX) continue; // (the origin must stay on the page)
        const planned = list.find((d): d is AddedTextEdit => d.kind === "editAdded" && d.id === f.id);
        if (!planned) list.push({ kind: "editAdded", pageIndex: e.pageIndex, id: f.id, origin: [x, f.origin[1]] });
        else if (planned.text !== "") planned.origin = [x, f.origin[1]];
      }
    }
    return { text, missing };
  }

  /** A new picture (newcontent.addImage), its copy shared (sharePicture); `locate`: find the new placements (not needed by a replay). */
  private applyAddImage(doc: MuPDF.PDFDocument, edit: AddImageEdit, locate: boolean) {
    return this.sharePicture(doc, pagesOf(edit), edit.picture, () =>
      addPicture(this.mupdf, doc, edit.picture, edit.targets, edit.alt, { locate }));
  }

  /** Does what a logged image edit says to placement `p` (found on `page` just before); a replacement picture's copy is shared (sharePicture). */
  private applyPlacementEdit(doc: MuPDF.PDFDocument, page: MuPDF.PDFPage, found: PagePlacements, p: Placement, edit: ImageEdit) {
    if (edit.op !== "replace") return applyImageEdit(this.mupdf, doc, page, found, p, edit);
    return this.sharePicture(doc, [edit.pageIndex], edit.picture, () => applyImageEdit(this.mupdf, doc, page, found, p, edit));
  }

  /**
   * Runs `embed`, an edit that draws `picture` on `pages`, so that the document holds one copy of
   * the picture however the history got there. images.pictureObject finds a picture embedded
   * before through a map of its own per document, which a document re-opened from a checkpoint
   * starts without: a replay after the checkpoint (undo, a rollback) would embed a second copy,
   * which the download would carry too (garbage collection does not merge copies), and every
   * later placement of it would use that one. So each name the edit adds to those pages' /XObject
   * is pointed at the copy the app embedded first, when the document still holds it (an image of
   * the same size, layer and EXIF orientation, noted with the same bytes); a picture not seen before is noted. The
   * notes go with the checkpoints. Part of the edit: every replay does it.
   */
  private sharePicture<T>(doc: MuPDF.PDFDocument, pages: number[], picture: Picture, embed: () => T): T {
    const before = pages.map((p) => namesOf(xobjectsOf(doc, p)));
    const result = embed();
    let known = this.pictures.get(doc) ?? [];
    pages.forEach((pageIndex, k) => {
      const xobjects = xobjectsOf(doc, pageIndex);
      if (!xobjects) return;
      for (const name of namesOf(xobjects)) {
        const ref = xobjects.get(name);
        if (before[k].has(name) || !ref.isIndirect() || !isImage(ref)) continue;
        const num = ref.asIndirect(), layer = layerOf(ref);
        if (layer < 0) continue; // (a direct /OC: pictureObject does not reuse those either)
        const i = known.findIndex((e) => e.layer === layer && sameBytes(e.bytes, picture.bytes));
        if (i < 0) known = [...known, { bytes: picture.bytes, num, layer }];
        else if (known[i].num !== num) {
          const first = doc.newIndirect(known[i].num);
          if (isImage(first) && layerOf(first) === layer && sameSize(first, ref) && turnOf(first) === turnOf(ref)) xobjects.put(name, first);
          else known = known.map((e, j) => (j === i ? { ...e, num } : e)); // (gone: this copy is the one now)
        }
      }
    });
    this.pictures.set(doc, known);
    return result;
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
      this.applyPlacementEdit(doc, page, found, p, edit);
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
    hidePasswords(this.mupdf, doc); // as open() did
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
      this.pictures.set(doc, base ? base.pictures : []);
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

  /**
   * Takes a checkpoint of the working document when the log has just reached a multiple of
   * CHECKPOINT_EVERY, and carries on with it (continueOn): `doc` is no longer the working
   * document after this.
   */
  private checkpoint(doc: MuPDF.PDFDocument) {
    const editCount = this.log.length;
    if (editCount % CHECKPOINT_EVERY !== 0 || this.checkpoints.some((c) => c.editCount === editCount)) return;
    const fonts = fallbackFontState(doc), pictures = this.pictures.get(doc) ?? [];
    let bytes: Uint8Array;
    try {
      const buf = doc.saveToBuffer(SNAPSHOT_OPTIONS);
      try {
        bytes = buf.asUint8Array().slice(); // out of the wasm heap
        this.continueOn(doc, buf, fonts);
      } finally {
        buf.destroy();
      }
    } catch {
      return; // a checkpoint only saves time: undo then starts from an earlier one
    }
    this.checkpoints.push({ editCount, bytes, fonts, pictures });
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

  /**
   * Carries on with `snapshot` (a Buffer that saveToBuffer(SNAPSHOT_OPTIONS) just gave for the
   * working document `doc`) re-opened in place of `doc`, with `fonts` (core.fallbackFontState of
   * `doc`) and the pictures noted for it: the same document, but with its pictures compressed,
   * so the next snapshots copy them instead of compressing them again; what undo carries on with
   * after a rebuild from a checkpoint. Not done when `doc` is not the working document; when the
   * snapshot does not open, the session goes on with `doc`.
   */
  private continueOn(doc: MuPDF.PDFDocument, snapshot: MuPDF.Buffer, fonts: ReturnType<typeof fallbackFontState>) {
    if (doc !== this.doc || this.broken) return;
    let fresh: MuPDF.PDFDocument | null = null;
    try {
      fresh = this.openSnapshot(snapshot); // (it keeps its own reference to the buffer)
      restoreFallbackFonts(fresh, fonts);
    } catch {
      if (fresh) this.dispose(fresh);
      return;
    }
    this.pictures.set(fresh, this.pictures.get(doc) ?? []);
    this.replaceDoc(fresh);
  }

  /** Makes `fresh` the working document (undo, recover, continueOn), closing the one before. */
  private replaceDoc(fresh: MuPDF.PDFDocument) {
    if (this.doc) this.dispose(this.doc);
    this.doc = fresh;
    formChanged(fresh);
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

const copyStyle = (s: TextStyle): TextStyle => ({ ...s, color: [s.color[0], s.color[1], s.color[2]] });
const copyPoint = (p: [number, number]): [number, number] => [p[0], p[1]];
const copyPicture = (p: Picture): Picture => ({ ...p, bytes: p.bytes.slice() });
const copyRect = (r: Rect): Rect => [r[0], r[1], r[2], r[3]];
const copyPlan = (p: DecorationPlan): DecorationPlan => ({
  shapes: p.shapes.map((s) => ({ kind: s.kind, paint: s.paint, bbox: copyRect(s.bbox), range: [s.range[0], s.range[1]] })),
  links: p.links.map((l) => ({ bounds: copyRect(l.bounds), uri: l.uri, range: [l.range[0], l.range[1]] })),
});

/** A copy of a log entry, its matrices, points, styles, values and bytes included. */
function copyEdit(e: LoggedEdit): LoggedEdit {
  switch (e.kind) {
    case "text": {
      const out: TextEdit = { ...e };
      if (e.decorations) out.decorations = copyPlan(e.decorations);
      return out;
    }
    case "field": {
      const v = e.value;
      const value: FieldValue = v.kind === "choice" ? { kind: "choice", values: [...v.values] } : { ...v };
      return { ...e, value, pages: [...e.pages] };
    }
    case "addText":
      return { ...e, origin: copyPoint(e.origin), style: copyStyle(e.style) };
    case "editAdded": {
      const out: AddedTextEdit = { ...e };
      if (e.origin) out.origin = copyPoint(e.origin);
      if (e.style) out.style = copyStyle(e.style);
      if (e.absorb) out.absorb = [...e.absorb];
      return out;
    }
    case "addImage":
      return { ...e, picture: copyPicture(e.picture), targets: e.targets.map((t) => ({ pageIndex: t.pageIndex, matrix: [...t.matrix] as Matrix })) };
    case "mixed":
      return { ...e, edits: e.edits.map((x) => copyEdit(x) as TextEdit | AddedTextEdit) };
    case "image": {
      const expect = [...e.expect] as Matrix;
      switch (e.op) {
        case "transform":
          return { ...e, expect, matrix: [...e.matrix] as Matrix };
        case "replace":
          return { ...e, expect, picture: copyPicture(e.picture) };
        default:
          return { ...e, expect };
      }
    }
  }
}

/** What replaceLine logs for a line with printed and added parts. */
type LineEdit = TextEdit | AddedTextEdit | MixedLineEdit;

/** What an EditResult tells of a core.replaceText result: its segments, the fallbacks the user can see, the characters left out. */
function textOutcome(result: ReturnType<typeof replaceText>): Pick<EditResult, "segments" | "fallbackChars" | "missingChars"> {
  // core's segment kinds are exactly the protocol's SegmentSource values.
  const segments: EditSegment[] = result.segments.map((s) => ({
    text: String(s.text),
    source: s.source as SegmentSource,
    fontName: untag(String(s.fontName)),
  }));
  // Spaces are left out: a space from a fallback font looks the same (Type3 fonts often lack one).
  // So is a fallback in the very face the line was drawn with (`program`: a line an earlier edit
  // wrote in the app's fonts): nothing changes that the user could see.
  const face = untag(String(result.original.fontName));
  const fallbackChars = visibleChars(
    result.segments
      .filter((s) => s.source === "fallback" && untag(String(s.program ?? "")) !== face)
      .flatMap((s) => [...String(s.text)]),
  );
  return { segments, fallbackChars, missingChars: visibleChars(result.missing as string[]) };
}

/**
 * What an EditResult tells of a line's decorations: what the edit did to them (`report`, null
 * when it planned nothing), with what stays as it is: what the edit left (in `report`), and what
 * the detection before it (`detected`) found would stay, when the edit reached its characters
 * (`find` made `written`: reached). A dashed underline under a word the edit did not touch is
 * still right under it, and nothing is said of it. Nothing at all when there is nothing to say.
 */
function decorationOutcome(detected: Detected | null, report: DecorationReport | null, find: string, written: string): Pick<EditResult, "decorations"> {
  const stays = detected
    ? summaryOf({
      ...detected,
      shapes: detected.shapes.filter((s) => s.level !== "left" || reached(s.plan.range, find, written)),
      links: detected.links.filter((l) => l.level !== "left" || reached(l.plan.range, find, written)),
    }).left
    : [];
  const left = [...stays, ...(report?.left ?? [])];
  const moved = report ? [...report.moved] : [], removed = report ? [...report.removed] : [];
  const linksMoved = report?.linksMoved ?? 0, linksRemoved = report?.linksRemoved ?? 0;
  if (!moved.length && !removed.length && !linksMoved && !linksRemoved && !left.length) return {};
  return { decorations: { moved, removed, linksMoved, linksRemoved, left } };
}

/**
 * Whether an edit that makes a line read `now` instead of `old` reaches the characters [a, b) of
 * `old` (a decoration's run): it does when it deletes the line, and for a run at or after the
 * change (the first character where the two texts differ: its characters change, or move with
 * the text before them); a run before the change is reached only when it no longer covers the
 * same characters (decorations.mapRun: text typed right after a run continues it).
 */
function reached([a, b]: [number, number], old: string, now: string): boolean {
  if (!now) return true;
  let p = 0;
  while (p < old.length && p < now.length && old[p] === now[p]) p++;
  if (b > p) return true;
  const m = mapRun([a, b], old, now);
  return !("range" in m) || m.range[0] !== a || m.range[1] !== b;
}

/**
 * replaceLine's `options` from the main thread, checked as untrusted: absent, or an object whose
 * only key is an optional boolean `box` ("bad-request" otherwise). Gives `box`.
 */
function boxOption(options: unknown): boolean | undefined {
  if (options === undefined) return undefined;
  if (!options || typeof options !== "object" || Array.isArray(options))
    throw new SessionError("The line edit's options are an object", "bad-request");
  const { box, ...rest } = options as { box?: unknown };
  if (Object.keys(rest).length) throw new SessionError(`Unknown line edit option ${Object.keys(rest)[0]}`, "bad-request");
  if (box !== undefined && typeof box !== "boolean") throw new SessionError("The option box is true or false", "bad-request");
  return box;
}

/**
 * A run of a line MuPDF reads as printed text and text the app wrote together (lineParts):
 * printed text, or one whole line the app wrote.
 */
interface LinePart {
  /** 0 for printed text, else the AddedText.id of the line the app wrote that draws it. */
  id: number;
  /** Where it is in the line's text without its leading whitespace (end excluded), and what it reads there. */
  start: number;
  end: number;
  text: string;
  /** Printed text: which match of `text` on the page it is (TextEdit.occurrence; locateLine counts it). */
  occurrence: number;
  /** The added line's style (null for printed text). */
  style: TextStyle | null;
  /** Where its first character starts (page space): the added line's origin, or the printed text's first glyph. */
  origin: [number, number];
  /** How far right its characters' boxes reach (page space). */
  right: number;
}

/** What applyLine needs to move the added lines after a printed part that grows (replaceLine). */
interface LineFlow {
  /** The printed part's first character's origin, and how far right it reached before the edit. */
  start: [number, number];
  right: number;
  /** The page's right edge: an added line is not moved off the page. */
  maxX: number;
  /** The added lines after it on the line, and their origins. */
  followers: { id: number; origin: [number, number] }[];
}

/** The ligatures MuPDF's structured text reads as their letters (an added "ﬁ" is "fi" in a line). */
const LIGATURES: Readonly<Record<string, string>> = { "ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl", "ﬅ": "st", "ﬆ": "st" };
const asRead = (text: string) => text.replace(/[ﬀ-ﬆ]/g, (c) => LIGATURES[c]);

/** How far right the boxes of characters reach (a quad's four x). */
const rightOf = (chars: { quad: number[] }[]) => Math.max(...chars.flatMap((c) => [c.quad[0], c.quad[2], c.quad[4], c.quad[6]]));

/** A character as core.extractLines gives it (what is read here). */
type RawChar = { c: string; origin: number[]; quad: number[] };

/** What a core.replaceText result drew: its segments' text joined (without the characters no font has). */
const drawnText = (result: ReturnType<typeof replaceText>) => result.segments.map((s) => String(s.text)).join("");

/** A space other than U+0020 (a no-break space, an en space...): MuPDF may read it back as U+0020. */
const OTHER_SPACE = /[^\S ]/;

/**
 * The characters of a text core.replaceText drew (`drawn`, drawnText) on the page, as MuPDF reads
 * them, from the one whose origin is `start` (replaceText writes the replacement where the old
 * text's first character was), and the text they read; null when they are not there. MuPDF reads
 * a ligature as its letters ("ﬁ" is "fi": asRead), and a space other than U+0020 as itself or as
 * U+0020, depending on the code the font draws it with (the original font's own space, as Chrome's
 * fonts give a no-break space, or a code of its own): either reading is taken.
 */
function readWritten(lines: RawLine[], start: ArrayLike<number>, drawn: string): { chars: RawChar[]; text: string } | null {
  const want = asRead(drawn);
  for (const line of lines) {
    const chars = line.chars as RawChar[];
    for (let k = 0; k + want.length <= chars.length; k++) {
      if (Math.hypot(chars[k].origin[0] - start[0], chars[k].origin[1] - start[1]) >= 0.05) continue;
      const got = chars.slice(k, k + want.length);
      if (got.every((ch, i) => ch.c === want[i] || (ch.c === " " && OTHER_SPACE.test(want[i]))))
        return { chars: got, text: got.map((ch) => ch.c).join("") };
    }
  }
  return null;
}

/**
 * The text a core.replaceText result wrote, as MuPDF reads it on the page (readWritten): what
 * decorations.applyDecorations must find there and maps the old line's characters onto, and what
 * tells which of them the edit reached (decorationOutcome). It is read on the page only when it
 * holds a space other than U+0020, whose reading depends on the font; otherwise it is the text
 * drawn, its ligatures as letters. When it is not found, the text drawn that way (applyDecorations
 * then does not find it either, and leaves the decorations as they are). Read after protectAdded's
 * restore, in a new edit and in every replay alike, so a replay reads what the new edit read.
 */
function writtenText(doc: MuPDF.PDFDocument, pageIndex: number, result: ReturnType<typeof replaceText>): string {
  const drawn = drawnText(result);
  const want = asRead(drawn);
  if (!OTHER_SPACE.test(want)) return want;
  const page = doc.loadPage(pageIndex);
  let raw: RawLine[] = [];
  try {
    raw = extractLines(page);
    return readWritten(raw, result.original.origin as number[], drawn)?.text ?? want;
  } finally {
    releasePage(page, raw);
  }
}

/**
 * After a printed part was written again: how far right the characters it drew (`drawn`,
 * drawnText) reach, read on the page from the character that starts at `start` (readWritten).
 * Null when they cannot be found.
 */
function printedRight(doc: MuPDF.PDFDocument, pageIndex: number, start: [number, number], drawn: string): number | null {
  const page = doc.loadPage(pageIndex);
  let raw: RawLine[] = [];
  try {
    raw = extractLines(page);
    const found = readWritten(raw, start, drawn);
    return found && found.chars.length ? rightOf(found.chars) : null;
  } finally {
    releasePage(page, raw);
  }
}

/**
 * The parts of `line` (a core.extractLines line) when some of its characters are drawn by lines
 * the app wrote (`added`, the page's AddedText) and others are printed: MuPDF reads an added text
 * that starts within a few points of a label's end, on about its baseline, as part of the label's
 * line ("Data di nascita: 12/03/1980"). An added line is part of it when the line reads its whole
 * text from a character at its origin: not by place alone, since a name written over a form's
 * underscores lies on their baseline but is a line of its own. In order: runs of printed text,
 * without the whitespace at their ends (a space MuPDF puts in a gap belongs to no part), and the
 * runs of one added line each. Null when the line holds no added line.
 */
function lineParts(line: RawLine, added: AddedText[]): LinePart[] | null {
  const chars = line.chars as { c: string; origin: number[]; quad: number[] }[];
  const owner = chars.map(() => 0);
  for (const t of added) {
    const read = asRead(t.text);
    for (let k = 0; k < chars.length; k++) {
      if (Math.hypot(chars[k].origin[0] - t.origin[0], chars[k].origin[1] - t.origin[1]) >= 0.05 || !line.text.startsWith(read, k)) continue;
      if (owner.slice(k, k + read.length).every((id) => !id)) owner.fill(t.id, k, k + read.length);
      break;
    }
  }
  if (!owner.some((id) => id > 0)) return null;
  const lead = line.text.length - line.text.trimStart().length, end = line.text.trimEnd().length;
  const parts: LinePart[] = [];
  const space = (k: number) => chars[k].c.trim() === "";
  for (let i = lead; i < end; ) {
    let j = i + 1;
    while (j < end && owner[j] === owner[i]) j++;
    let a = i, b = j;
    if (!owner[i]) {
      while (a < b && space(a)) a++;
      while (b > a && space(b - 1)) b--;
    }
    if (a < b) {
      const t = added.find((x) => x.id === owner[i]);
      parts.push({
        id: owner[i], start: a - lead, end: b - lead, text: line.text.slice(a, b), occurrence: 0, style: t ? t.style : null,
        origin: t ? [t.origin[0], t.origin[1]] : [chars[a].origin[0], chars[a].origin[1]], right: rightOf(chars.slice(a, b)),
      });
    }
    i = j;
  }
  return parts;
}

/**
 * The edits that make a line with printed and added parts (lineParts) read `next` instead of
 * `old` (both without leading and trailing whitespace): each part's new text (splitLine), the
 * printed part that changes as a TextEdit (first: its occurrence was counted on the page as it
 * is), each added line that changes as an AddedTextEdit (its text checked as addText checks it;
 * empty deletes it), and the printed part that changes (null: none). No edits when no part
 * changes. A change that would rewrite two printed parts is refused ("not-editable"): the second
 * one's occurrence would have to be counted again after the first is written.
 */
function mixedLineEdits(pageIndex: number, old: string, next: string, parts: LinePart[]): { edits: (TextEdit | AddedTextEdit)[]; printed: LinePart | null } {
  const texts = splitLine(old, next, parts);
  const printed: [TextEdit, LinePart][] = [], added: AddedTextEdit[] = [];
  parts.forEach((p, k) => {
    if (!p.id) {
      const replacement = normalizeLineText(texts[k]);
      if (replacement !== p.text) printed.push([{ kind: "text", pageIndex, find: p.text, occurrence: p.occurrence, replacement }, p]);
    } else {
      const text = lineFrom(texts[k]);
      if (text !== p.text) added.push({ kind: "editAdded", pageIndex, id: p.id, text });
    }
  });
  if (printed.length > 1)
    throw new SessionError("The edit changes two printed parts of a line that holds text the app wrote", "not-editable");
  return { edits: [...printed.map(([e]) => e), ...added], printed: printed[0]?.[1] ?? null };
}

/**
 * What each part of a line with printed and added parts (lineParts, in order) reads once the line
 * reads `next` instead of `old` (both without leading and trailing whitespace; the parts' places
 * are in `old`):
 * - an empty line empties every part;
 * - one change (what lies between the common start and the common end) inside one part goes to
 *   that part, text typed where two parts meet to the first; a change of nothing but the space
 *   between two parts changes nothing (MuPDF puts that space in the gap), and text typed there
 *   goes to the part before it;
 * - otherwise, with two parts (a label and what was written after it), the new text is cut where
 *   the space between them still is (anywhere, when they touch), each side as close as possible
 *   to the part it replaces, when together they keep at least half of the old text (splitAtGap);
 * - otherwise the parts the change runs across become the first of them: it gets the new text,
 *   the others lose what the change took of them (a line typed again from scratch is one line).
 */
export function splitLine(old: string, next: string, parts: readonly { start: number; end: number; text: string }[]): string[] {
  const texts = parts.map((p) => p.text);
  if (!next) return texts.map(() => "");
  let a = 0;
  while (a < old.length && a < next.length && old[a] === next[a]) a++;
  let s = 0;
  while (s < old.length - a && s < next.length - a && old[old.length - 1 - s] === next[next.length - 1 - s]) s++;
  const b = old.length - s, typed = next.slice(a, next.length - s);
  const inside = parts.findIndex((p) => p.start <= a && b <= p.end);
  if (inside >= 0) {
    const p = parts[inside];
    texts[inside] = p.text.slice(0, a - p.start) + typed + p.text.slice(b - p.start);
    return texts;
  }
  const touched = parts.flatMap((p, k) => (p.start < b && a < p.end ? [k] : []));
  if (!touched.length) {
    if (!typed.trim()) return texts;
    const k = Math.max(0, parts.findLastIndex((p) => p.end <= a));
    texts[k] += old.slice(parts[k].end, a) + typed;
    return texts;
  }
  if (parts.length === 2) {
    const split = splitAtGap(old, next, parts);
    if (split) return split;
  }
  const first = parts[touched[0]], last = parts[touched[touched.length - 1]];
  for (const k of touched) texts[k] = "";
  texts[touched[0]] = first.text.slice(0, Math.max(0, a - first.start)) + typed + last.text.slice(Math.max(0, b - last.start));
  return texts;
}

/** Longest new line splitAtGap looks for a cut in (it takes time with the square of the length). */
const MAX_SPLIT_CHARS = 2000;

/**
 * `next` cut in two for two parts that a change runs across (splitLine): around a run of
 * whitespace when the parts had a space between them, anywhere when they touched; the cut whose
 * sides are closest to the parts' old texts (edit distance), when together they are at most half
 * of the old texts' length away. Null when there is no such cut.
 */
function splitAtGap(old: string, next: string, [p, q]: readonly { start: number; end: number; text: string }[]): string[] | null {
  if (next.length > MAX_SPLIT_CHARS) return null;
  const cuts: [number, number][] = [];
  if (old.slice(p.end, q.start)) for (const m of next.matchAll(/\s+/g)) cuts.push([m.index, m.index + m[0].length]);
  else for (let x = 1; x < next.length; x++) cuts.push([x, x]);
  const reverse = (t: string) => t.split("").reverse().join("");
  const head = prefixDistances(p.text, next), tail = prefixDistances(reverse(q.text), reverse(next));
  let best: [number, number] | null = null, cost = Infinity;
  for (const [i, j] of cuts) {
    const c = head[i] + tail[next.length - j];
    if (c < cost) [best, cost] = [[i, j], c];
  }
  return best && 2 * cost <= p.text.length + q.text.length ? [next.slice(0, best[0]), next.slice(best[1])] : null;
}

/** The edit distance (Levenshtein, in UTF-16 units) between `a` and each start of `b`: out[x] for b.slice(0, x). */
function prefixDistances(a: string, b: string): number[] {
  let row = Array.from({ length: a.length + 1 }, (_, k) => k);
  const out = [a.length];
  for (let x = 1; x <= b.length; x++) {
    const next = [x];
    for (let k = 1; k <= a.length; k++) next[k] = Math.min(row[k] + 1, next[k - 1] + 1, row[k - 1] + (b[x - 1] === a[k - 1] ? 0 : 1));
    row = next;
    out.push(row[a.length]);
  }
  return out;
}

/** Page `pageIndex`'s /XObject dictionary (inherited, shared or its own), or null. */
function xobjectsOf(doc: MuPDF.PDFDocument, pageIndex: number): MuPDF.PDFObject | null {
  const res = doc.findPage(pageIndex).getInheritable("Resources");
  const xobjects = res.isDictionary() ? res.get("XObject") : null;
  return xobjects?.isDictionary() ? xobjects : null;
}

function namesOf(dict: MuPDF.PDFObject | null): Set<string> {
  const names = new Set<string>();
  dict?.forEach((_v, k) => names.add(String(k)));
  return names;
}

const isImage = (o: MuPDF.PDFObject) => o.isStream() && o.get("Subtype").isName() && o.get("Subtype").asName() === "Image";

/** An image's /OC as EmbeddedPicture.layer has it: 0 for none, the object number of an indirect one, -1 for a direct one. */
function layerOf(o: MuPDF.PDFObject): number {
  const oc = o.get("OC");
  return oc.isNull() ? 0 : oc.isIndirect() ? oc.asIndirect() : -1;
}

const sameSize = (a: MuPDF.PDFObject, b: MuPDF.PDFObject) =>
  ["Width", "Height"].every((k) => a.get(k).isNumber() && b.get(k).isNumber() && a.get(k).asNumber() === b.get(k).asNumber());

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
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
  added: p.added,
});

/** The document's form (DocInfo.form): a form whose objects cannot be read counts as none, so the file still opens. */
function readForm(mupdf: MuPDFModule, doc: MuPDF.PDFDocument): FormInfo | null {
  try {
    return formInfo(mupdf, doc);
  } catch {
    return null;
  }
}

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
      const { bytes, orientation } = edit.picture;
      const image = openImage(mupdf, bytes);
      try {
        replacePlacement(mupdf, doc, page, found, p, image, bytes, orientation);
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

/** What checkTarget compares a new picture's sides with: none yet, so each must be within MIN_IMAGE_SIDE..MAX_IMAGE_SIDE. */
const UNIT_SQUARE: Matrix = [MIN_IMAGE_SIDE, 0, 0, MIN_IMAGE_SIDE, 0, 0];

/**
 * A text style from the main thread, checked as untrusted ("bad-request" otherwise): a size
 * within MIN_TEXT_SIZE..MAX_TEXT_SIZE, an sRGB colour of three numbers within 0..1, a family
 * the app has, bold and italic as booleans.
 */
function styleFrom(s: unknown): TextStyle {
  const o = (s && typeof s === "object" ? s : {}) as Partial<Record<keyof TextStyle, unknown>>;
  const { size, color, family, bold, italic } = o;
  if (typeof size !== "number" || !(size >= MIN_TEXT_SIZE && size <= MAX_TEXT_SIZE))
    throw new SessionError(`A text size is ${MIN_TEXT_SIZE} to ${MAX_TEXT_SIZE} points`, "bad-request");
  if (!Array.isArray(color) || color.length !== 3 || !color.every((v) => typeof v === "number" && v >= 0 && v <= 1))
    throw new SessionError("A text colour is three numbers from 0 to 1", "bad-request");
  if (family !== "sans" && family !== "serif" && family !== "mono") throw new SessionError("Unknown font family", "bad-request");
  if (typeof bold !== "boolean" || typeof italic !== "boolean") throw new SessionError("Bold and italic are true or false", "bad-request");
  return { size, color: [color[0], color[1], color[2]], family, bold, italic };
}

/** The same style, as an added line reads back (its size and colour to 0.001). */
function sameStyle(a: TextStyle, b: TextStyle): boolean {
  return a.family === b.family && a.bold === b.bold && a.italic === b.italic && Math.abs(a.size - b.size) < 0.001 &&
    a.color.every((v, k) => Math.abs(v - b.color[k]) < 0.001);
}

/**
 * A picture's description from the main thread, checked as untrusted: null, or a string of at
 * most MAX_ALT_CHARS characters ("bad-request" otherwise), its control characters made spaces
 * (U+0000 would cut it short in MuPDF); blank is null.
 */
function altFrom(alt: unknown): string | null {
  if (alt === null) return null;
  if (typeof alt !== "string" || [...alt].length > MAX_ALT_CHARS)
    throw new SessionError(`A description is at most ${MAX_ALT_CHARS} characters`, "bad-request");
  return alt.replace(UNDRAWN, " ").replace(/\s+/g, " ").trim() || null;
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
