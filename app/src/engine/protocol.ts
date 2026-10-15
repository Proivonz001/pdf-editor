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
  /** The source was encrypted: with a password to open it, or with restrictions only. */
  encrypted: boolean;
  /**
   * Opening it needed a password (the user password, or the owner password, which opens it
   * too). The engine keeps that password in memory, so a download can be protected with it
   * again (SavePassword "keep") when canKeepPassword says so.
   */
  needsPassword: boolean;
  /**
   * A download can be protected with that same password ("keep"). False when passwordProblem
   * refuses it (characters MuPDF cannot carry or PDF readers would hash differently, too long),
   * and when the file was opened with its owner password only: as the copy's one password it
   * would replace the user password the recipients know, so the user has to choose one.
   */
  canKeepPassword: boolean;
  /** The PDF/A part and conformance the file claims in its XMP metadata ("2B", "1A"...), or null. */
  pdfa: string | null;
  /** Signature fields that hold a digital signature: any change, and any re-save, invalidates them. */
  signatures: number;
  title: string | null;
}

// ---------------------------------------------------------------------------------------------
// Saving (download)

/** "pdf": a normal PDF. "pdfa-2b": PDF/A for archiving (ISO 19005-2, level B). */
export type SaveFormat = "pdf" | "pdfa-2b";

export type SavePassword =
  /** No password. */
  | { mode: "none" }
  /** The password the file was opened with (only when DocInfo.canKeepPassword). */
  | { mode: "keep" }
  /** A new password chosen by the user (check it with passwordProblem first). */
  | { mode: "set"; password: string };

export interface SaveOptions {
  format: SaveFormat;
  /** Must be "none" with "pdfa-2b": PDF/A forbids encryption. */
  password: SavePassword;
}

/** Nothing can make the file PDF/A without changing how it looks or what it is. */
export type PdfaBlockerCode =
  /** A font used for drawing is not in the file and has no standard equivalent (detail: font). */
  | "font-not-embedded"
  /** Embedding the standard equivalent would draw other glyphs (detail: font). */
  | "font-changed"
  /** An embedded font's widths disagree with its program (detail: font). */
  | "font-widths"
  /** Text drawn with the missing-glyph box (.notdef). */
  | "notdef"
  /** Print colours (CMYK) without a profile we may embed. */
  | "cmyk"
  /** A colour profile in the file is broken or too new. */
  | "icc-invalid"
  /** A dynamic Adobe XFA form: the pages are only a placeholder. */
  | "xfa-dynamic"
  /** A PDF portfolio (a collection of attached files). */
  | "portfolio"
  /** Content that lives outside the file (reference or PostScript XObjects). */
  | "external-content";

/** Content the conversion removes or changes: the UI asks before. */
export type PdfaRemovalCode =
  /** Scripts (JavaScript), count. */
  | "javascript"
  /** Other actions PDF/A forbids (launching files, sounds, any action of a form button or field...), count. */
  | "actions"
  /** Attached files, count. */
  | "attachments"
  /** Hidden or forbidden annotations (notes, sounds, 3D...), count. */
  | "annotations"
  /** Hidden form fields that become visible, count. */
  | "hidden-fields-shown"
  /** The data of a static XFA form (the normal form fields stay). */
  | "xfa-data";

/** Worth telling, no content lost. */
export type PdfaWarningCode =
  /** A missing font is drawn with a standard one whose widths differ: text may shift (detail: font). */
  | "text-may-shift"
  /** The file is digitally signed: the new file's signatures are no longer valid. */
  | "signature-invalid"
  /** A non-standard blend mode was replaced (count). */
  | "blend-mode"
  /** The file's colour declaration (output intent) was replaced with sRGB. */
  | "output-intent-replaced";

export interface PdfaIssue<C extends string = string> {
  code: C;
  /** The font name, the attachment name... when there is one. */
  detail?: string;
  /** How many, when the issue counts things. */
  count?: number;
}

export interface PdfaReport {
  /** Non-empty: no PDF/A file can be written (save refuses with "pdfa-blocked"). */
  blockers: PdfaIssue<PdfaBlockerCode>[];
  removals: PdfaIssue<PdfaRemovalCode>[];
  warnings: PdfaIssue<PdfaWarningCode>[];
  /** Number of silent technical fixes (fonts embedded, colour profile, metadata...), for logs. */
  fixes: number;
}

export interface SaveResult {
  bytes: ArrayBuffer;
  /** The conversion report, for "pdfa-2b"; null for "pdf". */
  pdfa: PdfaReport | null;
}

/** Longest password accepted for SavePassword "set" (AES-256 passwords are UTF-8, at most 127 bytes). */
export const MAX_PASSWORD_BYTES = 127;

/**
 * Why `password` cannot protect a download, or null when it can. "unsupported" (the engine
 * refuses it with "bad-request") has two causes:
 * - MuPDF cannot carry it into the file: a comma (MuPDF reads its save options as
 *   "key=value,key=value", so a comma would end the password there, and MuPDF.js's object form
 *   turns commas into colons), U+0000 (it cuts the string short on its way into MuPDF);
 * - PDF readers would disagree on it. ISO 32000-2 (Algorithm 2.A) has a reader prepare an
 *   AES-256 password with SASLprep (RFC 4013) before hashing it, and Acrobat and PDFBox do;
 *   MuPDF hashes the UTF-8 bytes as typed, and so does pdf.js. A password SASLprep would change
 *   (NFKC: a no-break space, "²", "º", "µ", full-width letters, an accent typed as a combining
 *   mark; characters it maps to nothing, such as the emoji variation selector U+FE0F) or prohibit
 *   (controls, private use, non-characters, bidi controls, tags, right-to-left letters mixed
 *   with left-to-right ones) would open the file in some readers and not in others. Refusing it
 *   leaves passwords SASLprep keeps as they are, which every reader hashes the same.
 *   Code points Unicode 3.2 (stringprep's tables) did not assign, such as most emoji, pass
 *   through SASLprep unchanged when a file is opened, so they stay allowed.
 * Spaces, quotes, "=", accents, emoji, CJK... all round-trip (tests/save.test.ts). Longer than
 * MAX_PASSWORD_BYTES makes MuPDF 1.27 fail ("memory access out of bounds").
 */
export function passwordProblem(password: string): "empty" | "too-long" | "unsupported" | null {
  if (password === "") return "empty";
  if (new TextEncoder().encode(password).length > MAX_PASSWORD_BYTES) return "too-long";
  type Ranges = readonly (readonly [number, number])[];
  const within = (c: number, ranges: Ranges) => ranges.some(([from, to]) => c >= from && c <= to);
  // What SASLprep (RFC 3454 tables) maps to nothing (B.1) or to a space (C.1.2), or prohibits
  // (C.2 to C.9), beyond the ASCII controls; plane ends (xFFFE, xFFFF) are tested apart.
  const prepared: Ranges = [
    [0x80, 0xa0], [0xad, 0xad], [0x340, 0x341], [0x34f, 0x34f], [0x6dd, 0x6dd], [0x70f, 0x70f],
    [0x1680, 0x1680], [0x1806, 0x1806], [0x180b, 0x180e], [0x2000, 0x200f], [0x2028, 0x202f],
    [0x205f, 0x2063], [0x206a, 0x206f], [0x2ff0, 0x2ffb], [0x3000, 0x3000], [0xd800, 0xdfff],
    [0xe000, 0xf8ff], [0xfdd0, 0xfdef], [0xfe00, 0xfe0f], [0xfeff, 0xfeff], [0xfff9, 0xfffd],
    [0x1d173, 0x1d17a], [0xe0001, 0xe0001], [0xe0020, 0xe007f], [0xf0000, 0x10ffff],
  ];
  for (const ch of password) {
    const c = ch.codePointAt(0)!;
    if (ch === "," || c < 0x20 || c === 0x7f || within(c, prepared) || (c & 0xfffe) === 0xfffe) return "unsupported";
  }
  // Everything NFKC changes: compatibility characters, and text not in composed form.
  if (password.normalize("NFKC") !== password) return "unsupported";

  // The bidi rule (RFC 3454 section 6): with a right-to-left letter in it, the password may have
  // no left-to-right letter, and must start and end with a right-to-left character. Stringprep's
  // right-to-left characters are table D.1 (Unicode 3.2); readers on newer tables also count the
  // letters of later right-to-left scripts, so both readings are met. JavaScript cannot read a
  // character's bidi class, so next to right-to-left letters only the right-to-left blocks and
  // ASCII digits, spaces and punctuation are allowed: refusing a harmless symbol is the safe side.
  const randAL: Ranges = [
    [0x5be, 0x5be], [0x5c0, 0x5c0], [0x5c3, 0x5c3], [0x5d0, 0x5ea], [0x5f0, 0x5f4], [0x61b, 0x61b],
    [0x61f, 0x61f], [0x621, 0x63a], [0x640, 0x64a], [0x66d, 0x66f], [0x671, 0x6d5], [0x6dd, 0x6dd],
    [0x6e5, 0x6e6], [0x6fa, 0x6fe], [0x700, 0x70d], [0x710, 0x710], [0x712, 0x72c], [0x780, 0x7a5],
    [0x7b1, 0x7b1], [0x200f, 0x200f], [0xfb1d, 0xfb1d], [0xfb1f, 0xfb28], [0xfb2a, 0xfb36],
    [0xfb38, 0xfb3c], [0xfb3e, 0xfb3e], [0xfb40, 0xfb41], [0xfb43, 0xfb44], [0xfb46, 0xfbb1],
    [0xfbd3, 0xfd3d], [0xfd50, 0xfd8f], [0xfd92, 0xfdc7], [0xfdf0, 0xfdfc], [0xfe70, 0xfe74],
    [0xfe76, 0xfefc],
  ];
  const rtlBlocks: Ranges = [[0x590, 0x8ff], [0xfb1d, 0xfdff], [0xfe70, 0xfefc], [0x10800, 0x10fff], [0x1e800, 0x1efff]];
  const chars = Array.from(password, (ch) => ({ ch, c: ch.codePointAt(0)! }));
  const inD1 = (x: { c: number }) => within(x.c, randAL);
  const rtl = (x: { ch: string; c: number }) => inD1(x) || (within(x.c, rtlBlocks) && /\p{L}/u.test(x.ch));
  if (chars.some(rtl)) {
    const ends = [chars[0], chars[chars.length - 1]];
    if (!ends.every(rtl) || (chars.some(inD1) && !ends.every(inD1))) return "unsupported";
    if (!chars.every((x) => within(x.c, rtlBlocks) || /^[\x20-\x40\x5b-\x60\x7b-\x7e]$/.test(x.ch))) return "unsupported";
  }
  return null;
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
  | { op: "save"; options: SaveOptions }
  /** What converting to PDF/A would do, without writing a file (to ask the user first). */
  | { op: "pdfaCheck" }
  | { op: "close" };

export interface ResultMap {
  open: OpenResult;
  render: RenderResult;
  lines: LineInfo[];
  replaceLine: EditResult;
  undo: HistoryState;
  redo: HistoryState;
  save: SaveResult;
  pdfaCheck: PdfaReport;
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
 * "pdfa-blocked" (save as "pdfa-2b" found blockers: ask pdfaCheck first),
 * "engine" (anything else). The client adds "init" and "crashed".
 */

/** Worker → main thread. `ready` is posted once, after MuPDF has loaded. */
export type ResponseMessage =
  | { type: "ready" }
  | { type: "init-error"; error: string }
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string; code?: string };
