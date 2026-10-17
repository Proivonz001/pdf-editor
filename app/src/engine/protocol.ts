// Contract between the UI (main thread) and the PDF engine (MuPDF in a Web Worker).
//
// Coordinates: "page space", in PDF points, y pointing down, with the page's /Rotate and
// CropBox already applied — what the user sees. MuPDF's structured text, annotations and
// rendering all use it. The UI converts to screen pixels with: px = (pt - bounds origin) * zoom.
//
// The worker owns the document. The UI never holds a copy of it: it asks for page bitmaps,
// text lines and images, sends edits, and asks for the bytes when the user downloads.

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
  /** The file's fillable form (AcroForm with widgets), or null when it has none. */
  form: FormInfo | null;
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
  /**
   * The line is text the app wrote (addText), drawn only by its own marked blocks: replaceLine
   * rewrites those blocks instead of redacting, so nothing under or over them is touched.
   */
  added: boolean;
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

// ---------------------------------------------------------------------------------------------
// Images (phase 3, release 2): the pictures drawn on a page, which can be moved, resized,
// rotated, deleted or replaced one placement at a time (the same picture drawn twice is two
// placements). Only the drawing instruction of that placement changes: the text over it stays
// over it, other placements of the same picture stay as they are (ARCHITECTURE.md, "Images").

/**
 * An affine matrix [a, b, c, d, e, f] in the PDF layout: it maps (x, y) to
 * (a·x + c·y + e, b·x + d·y + f), the same layout as CSS matrix(a, b, c, d, e, f).
 */
export type Matrix = [number, number, number, number, number, number];

/** Why an image cannot be moved, resized, rotated, deleted or replaced (ImageInfo.reason). */
export type ImageLockReason =
  /** Drawn inside a group (a Form XObject) that also draws other content, such as a caption. */
  | "group"
  /** A transparency mask (soft mask) set outside the image's own drawing block applies to it. */
  | "soft-mask"
  /** Cropped by a clip set outside its own drawing block: moved, it would show another part. */
  | "cropped"
  /** The page's drawing instructions could not be read with certainty (the engine's safety check disagreed). */
  | "unreadable";

/** One placement of a picture on a page, in painting order. */
export interface ImageInfo {
  /** Position in the page's image list (painting order). Changes after an edit: always re-read images. */
  index: number;
  /**
   * Where the picture is drawn, in page space: the matrix maps the picture's unit square, with
   * (0, 0) its top-left corner and (1, 1) its bottom-right corner as the picture is seen, onto
   * the page. An upright picture W × H pt with its top-left corner at (x, y) has
   * [W, 0, 0, H, x, y]; a rotated or flipped one has the rotation in a, b, c, d.
   */
  matrix: Matrix;
  /** Bounding box of the whole picture (page space). */
  bbox: Rect;
  /** The part of bbox that shows (clips applied): where the user can click it. */
  visible: Rect;
  /** Size of the picture in pixels. */
  pixelWidth: number;
  pixelHeight: number;
  /** False when the image cannot be edited; `reason` says why. */
  movable: boolean;
  reason: ImageLockReason | null;
  /** A picture the app placed (addImage: a signature, initials, a photo), recognised by its marked block. */
  added: boolean;
}

export interface ImageEditResult extends HistoryState {
  pageIndex: number;
  /** The edited image's index in the page's new image list (the same as before for a move or a replace); null after a delete. */
  imageIndex: number | null;
}

// ---------------------------------------------------------------------------------------------
// Fill and sign (phase 3, release 3): form fields (AcroForm), new text written on the page, and
// new pictures (signatures, initials, photos). New text and pictures are real page content in
// marked blocks of their own (ARCHITECTURE.md, "Fill and sign"), not annotations.

export type FieldType = "text" | "checkbox" | "radio" | "combo" | "list" | "button" | "signature";

/** Why the app does not fill a field (FieldWidget.locked); setField refuses it ("not-editable"). */
export type FieldLock =
  /** The form marks it read-only. */
  | "read-only"
  /** A password field: its value should never be stored in a file (and MuPDF draws it in clear). */
  | "password"
  /** A file-select field. */
  | "file-select"
  /** A push button: it has no value. */
  | "push-button"
  /** A signature field: signed with the Sign tool (a picture placed in its box), never "filled". */
  | "signature"
  /** It has no name, so an edit could not find it again when replayed. */
  | "no-name"
  /** Fields with this full name have different types. */
  | "conflict";

export interface FieldOption {
  label: string;
  /** The export value, what the field's value holds. */
  value: string;
}

/** One widget of a field on a page. Hidden, NoView and zero-area widgets are left out. */
export interface FieldWidget {
  /** Full field name ("a.b.c"): the identity setField uses; the widgets of one field share it. */
  name: string;
  /** Position among the page's listed widgets (the page's /Tabs order when it has one, else /Annots). */
  index: number;
  type: FieldType;
  /** The widget's box in page space. */
  rect: Rect;
  /** Direction of the text in the box, clockwise: page /Rotate plus the widget's own rotation. */
  rotation: 0 | 90 | 180 | 270;
  /** /TU, else the partial name. */
  label: string;
  /** Text; combo and list: the (first) export value; check box and radio: the field's state ("Off" when off). */
  value: string;
  /** List boxes: every selected export value. */
  values?: string[];
  /** Combo boxes: the label of `value` (or the custom text of an editable combo). */
  displayValue?: string;
  /** Check box and radio: this widget's on state. */
  onState?: string;
  /** Combo and list: the choices; radio: the /Opt labels when the form has them. */
  options?: FieldOption[];
  multiline: boolean;
  comb: boolean;
  /** 0: no limit. */
  maxLen: number;
  multiSelect: boolean;
  /** Combo boxes that also accept a custom text. */
  editable: boolean;
  required: boolean;
  /** It has format, keystroke, validate or calculate scripts: they never run in this app. */
  scripted: boolean;
  /** A hint read from the form's format script (data only, never run). */
  format: { kind: "date"; pattern: string } | { kind: "number"; decimals: number; currency: string | null } | null;
  /** Text size from the form, in points; 0 = automatic. */
  fontSize: number;
  /** sRGB 0..1. */
  color: [number, number, number];
  /** 0 left, 1 centre, 2 right. */
  align: 0 | 1 | 2;
  /** Signature fields: it holds a digital signature. */
  signed?: boolean;
  locked: FieldLock | null;
}

export type FieldValue =
  /** Text fields, and the custom text of an editable combo. */
  | { kind: "text"; text: string }
  /** Check box and radio: one of the field's on states, or "Off". */
  | { kind: "state"; state: string }
  /** Combo and list: export values (0 or 1, or several for a multi-select list). */
  | { kind: "choice"; values: string[] };

/** The document's form as it is at open (DocInfo.form), read in one pass over every widget without loading pages. */
export interface FormInfo {
  /**
   * Listed widgets per page (index = page index): every widget the overlay shows (not hidden,
   * NoView or of zero area), push buttons, locked and signature fields included.
   */
  fieldsPerPage: number[];
  /**
   * Fields the user can fill in: distinct full names with a listed widget that are not locked
   * (FieldWidget.locked null, decided with the flags of all the widgets of the name, as setField
   * does). Signature fields, push buttons, read-only, password, file-select and conflicting
   * fields are not counted.
   */
  fields: number;
  /** How many of those fillable fields are required. */
  required: number;
  /** "static": the first field edit removes the XFA part (it would go stale); "dynamic": not fillable here. */
  xfa: "none" | "static" | "dynamic";
  /** The form has calculations or formatting scripts, which never run here. */
  scripts: boolean;
}

export interface FieldEditResult extends HistoryState {
  name: string;
  /** Characters no font can draw: kept in the value, left out of the appearance. */
  missingChars: string[];
  /** The text does not fit the box. */
  overflow: boolean;
}

export type FontFamily = "sans" | "serif" | "mono";

export interface TextStyle {
  /** Points, MIN_TEXT_SIZE..MAX_TEXT_SIZE. */
  size: number;
  /** sRGB 0..1. */
  color: [number, number, number];
  family: FontFamily;
  bold: boolean;
  italic: boolean;
}

/** A line of text the app wrote (addText), as the fill layer needs it to reopen it. */
export interface AddedText {
  /** Stable for this text across edits, undo and redo (its marked block's id). */
  id: number;
  text: string;
  /** Baseline start, page space. */
  origin: [number, number];
  style: TextStyle;
  bbox: Rect;
}

export interface AddTextResult extends HistoryState {
  pageIndex: number;
  /** The text's id (the same as before for an edit); null when an edit deleted it. */
  id: number | null;
  /** Characters no font could draw (left out). */
  missingChars: string[];
}

export interface ImageTarget {
  pageIndex: number;
  /** Where the picture goes (ImageInfo.matrix convention). */
  matrix: Matrix;
}

export interface AddImageResult extends HistoryState {
  /** For each target: the new picture's index in its page's image list (null when that page's images are locked). */
  placed: { pageIndex: number; imageIndex: number | null }[];
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
  /** The page's images (ImageInfo), in painting order. */
  | { op: "images"; pageIndex: number }
  /**
   * Move, resize or rotate one image: `matrix` is where it must be drawn (ImageInfo.matrix
   * convention). Refused ("bad-request") when the matrix is not finite or degenerate, a side is
   * shorter than MIN_IMAGE_SIDE or longer than MAX_IMAGE_SIDE, or its centre is off the page.
   */
  | { op: "transformImage"; pageIndex: number; imageIndex: number; matrix: Matrix }
  | { op: "deleteImage"; pageIndex: number; imageIndex: number }
  /**
   * Replace one placement with another picture (JPEG or PNG bytes, at most MAX_IMAGE_BYTES,
   * transferred): fitted inside the old one's box keeping its own proportions, centred, with the
   * same rotation. Other placements of the old picture stay.
   */
  | { op: "replaceImage"; pageIndex: number; imageIndex: number; bytes: ArrayBuffer }
  /** One image alone on a transparent bitmap, with its clips (the preview while it is dragged). */
  | { op: "renderImage"; pageIndex: number; imageIndex: number; scale: number }
  /** The page's form field widgets (FieldWidget), in the page's tab order. */
  | { op: "fields"; pageIndex: number }
  /**
   * Fill a field: every widget of every field with that full name. The same value is a no-op.
   * Refused: unknown name ("bad-request"), a locked field ("not-editable"), a value the field
   * cannot take ("bad-request": a choice not offered, text longer than MaxLen...).
   */
  | { op: "setField"; name: string; value: FieldValue }
  /** Write a new line of real text: `origin` is the baseline start in page space. */
  | { op: "addText"; pageIndex: number; origin: [number, number]; text: string; style: TextStyle }
  /** The page's texts written by the app (AddedText). */
  | { op: "addedTexts"; pageIndex: number }
  /** Change a text the app wrote: its text (empty = delete it), its place, its style. */
  | { op: "editAddedText"; pageIndex: number; addedId: number; text?: string; origin?: [number, number]; style?: TextStyle }
  /**
   * Place a new picture (JPEG or PNG bytes, at most MAX_IMAGE_BYTES, transferred) on one or
   * more pages, as one edit (initials on every page). `alt` describes it for screen readers on
   * tagged pages ("Firma: Mario Rossi"); null marks it as decoration.
   */
  | { op: "addImage"; bytes: ArrayBuffer; targets: ImageTarget[]; alt: string | null }
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
  images: ImageInfo[];
  transformImage: ImageEditResult;
  deleteImage: ImageEditResult;
  replaceImage: ImageEditResult;
  renderImage: ImageRenderResult;
  fields: FieldWidget[];
  setField: FieldEditResult;
  addText: AddTextResult;
  addedTexts: AddedText[];
  editAddedText: AddTextResult;
  addImage: AddImageResult;
  undo: HistoryState;
  redo: HistoryState;
  save: SaveResult;
  pdfaCheck: PdfaReport;
  close: null;
}

/** renderImage: the bitmap covers `rect` (page space), the image's visible box rounded out to whole pixels. */
export interface ImageRenderResult extends RenderResult {
  rect: Rect;
}

/** Shortest side an image may be given, in points. */
export const MIN_IMAGE_SIDE = 1;
/** Longest side an image may be given, in points (PDF's own limit for a page side). */
export const MAX_IMAGE_SIDE = 14_400;
/** Largest picture accepted by replaceImage and addImage, in bytes. */
export const MAX_IMAGE_BYTES = 30 * 1024 * 1024;

/** Text size limits for addText, in points. */
export const MIN_TEXT_SIZE = 1;
export const MAX_TEXT_SIZE = 500;
/** Longest text addText takes, in characters. */
export const MAX_TEXT_CHARS = 2000;
/** Longest field value setField takes, in characters. */
export const MAX_FIELD_CHARS = 10_000;
/** Longest description addImage takes, in characters. */
export const MAX_ALT_CHARS = 1000;

export type Op = Request["op"];
export type RequestOf<K extends Op> = Extract<Request, { op: K }>;

/** Main thread → worker. */
export type RequestMessage = { id: number } & Request;

/**
 * No request may have a field named `id`, even an optional one: it would clash with the message
 * id (the client now sends the message id last, so the request's own id would be lost instead).
 * Fails to compile if one does.
 */
type WithId<T> = T extends unknown ? ("id" extends keyof T ? T : never) : never;
const requestsHaveNoId: [WithId<Request>] extends [never] ? true : never = true;
void requestsHaveNoId;

/**
 * Error codes in `{ ok: false, code }` replies: "no-document", "bad-request", "edit-failed",
 * "not-editable" (the line has characters the engine cannot rewrite safely, or the image is
 * locked: ImageInfo.movable false), "broken" (an edit
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
