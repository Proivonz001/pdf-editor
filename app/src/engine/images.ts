// The pictures drawn on a PDF page, and edits of one placement at a time: move, resize, rotate,
// delete, replace (ARCHITECTURE.md, "Images").
//
// MuPDF.js 1.27 has no content-stream processor or filter, so placements are found by walking
// the page's content ourselves: a small lexer, the graphics-state stack (q/Q/cm), Form XObjects
// (recursively, with /Matrix, /BBox and /Resources, guarded against loops), inline images
// (BI..ID..EI), clips (set inside or outside the image's own q..Q block), soft masks set with
// gs, marked content, and pages with several content streams. The walk is capped (operations,
// placements, clips checked), so a crafted page cannot keep the worker busy for long. Then a
// safety gate: MuPDF's own interpreter runs the page through a device, and the walk is trusted
// only when each placement it found is, in the same order, an image MuPDF draws at the same
// matrix. MuPDF may draw more images than there are placements (the cells of a pattern fill);
// those are not placements. If the walk is not trusted, every image of the page is listed as the
// device saw it and locked ("unreadable").
//
// An edit changes the bytes of one placement only: the leading cm of the image's own q..Q block
// (folded, so repeated moves do not make the stream grow), a cm inserted after that block's q,
// or, without such a block, the painting operator wrapped in "q M cm ... Q". Nothing else in the
// stream moves, so the drawing order, the text over the picture, marked content (tags) and the
// clips inside the block stay as they were. The edited stream is written in place, or as a new
// stream object when another page shares it. A name the page no longer draws after a delete or a
// replace leaves the page's resources, and the picture behind it leaves the other dictionaries
// that list it (shared with other pages, inherited, a form's) when what draws with them does not
// draw it, so the picture is not carried into the saved file.
//
// Ported from the phase 3 prototype (images.mjs, verified on a synthetic PDF with 9 hard cases,
// a Chrome PDF and a tagged Word PDF). Coordinates are page space (points, y down, /Rotate and
// CropBox applied); matrices are PDF row-vector matrices, concat(A, B) = "A then B".
//
// MuPDF objects: devices, buffers, pixmaps and what device callbacks receive (images, paths,
// texts, stroke states, colour spaces) are destroyed explicitly (ARCHITECTURE.md rule 5). No
// fillShade handler is ever defined: MuPDF.js 1.27 wraps the shade without taking a reference,
// so its finalizer would drop one it never took. No exception ever leaves a device callback:
// one that unwinds through MuPDF's C frames corrupts the shared WebAssembly module (every later
// call fails). Callbacks catch, the failure is recorded and thrown after the pass. PDFObject
// wrappers are left to the garbage collector, as everywhere else in the engine.
//
// Release 3: pictures the app places itself (newcontent.ts: signatures, initials, photos) sit in
// a marked block carrying /PEImage, and their placements say so (Placement.added). A picture
// file is checked once (checkPicture): a JPEG loses the metadata that describes the photo rather
// than draws it (EXIF with the GPS position and a thumbnail, XMP, comments, anything after its
// end, stray bytes between its segments), losslessly, and its EXIF orientation, which MuPDF and
// PDF readers ignore, turns the placement instead, so a phone photo stored sideways shows upright
// (replacePlacement, and newcontent.addImage). The picture object records that orientation
// (/PEOrientation), so a later replace fits the new picture to the old one as seen.
import type * as MuPDF from "mupdf";
import { structParents } from "./core.js";
import { MAX_IMAGE_BYTES, type ImageLockReason, type Matrix, type Rect } from "./protocol";

type MuPDFModule = typeof MuPDF;
type Doc = MuPDF.PDFDocument;
type Obj = MuPDF.PDFObject;
type Point = [number, number];

/** Most placements listed for a page: beyond, the page's images are listed as MuPDF draws them (that many at most), locked. */
export const MAX_PLACEMENTS = 5_000;
/** Most content-stream operations the walk reads for a page, the contents of forms counted each time they are drawn. */
export const MAX_WALK_OPERATIONS = 1_000_000;
/** Most clips checked for a page: the clips in effect at each placement, summed. */
export const MAX_CLIP_CHECKS = 2_000_000;
/** Most images the device pass keeps for a page (pattern cells included): beyond, the page is locked. */
const MAX_DRAWN = 2 * MAX_PLACEMENTS;
/**
 * Most memory the clips around a sprite may hold in MuPDF's draw device: each clip that is not a
 * rectangle along the pixel grid keeps a mask and a copy of its area (about 5 bytes a pixel) until
 * it is popped, and hundreds of nested clips would run the WebAssembly heap out of memory.
 */
export const MAX_SPRITE_CLIP_BYTES = 128 * 1024 * 1024;
const CLIP_BYTES_PER_PIXEL = 5;

/** The walk read more than its caps allow: the page is listed as MuPDF draws it, locked. */
class WalkLimit extends Error {}

/** MuPDF failed inside a device pass (a picture it cannot decode, out of memory): caught there, thrown after the pass. */
export class DevicePassError extends Error {}

// ---------------------------------------------------------------------------------------------
// Matrices

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/**
 * Between the PDF image matrix P (the unit square of image space, y up, onto the page) and
 * ImageInfo.matrix Q (the picture's unit square as seen, (0, 0) its top-left corner): MuPDF draws
 * an image through this flip, so Q = concat(FLIP, P) and P = concat(FLIP, Q). It is its own inverse.
 * In unit space it is also the vertical mirror.
 */
export const FLIP: Matrix = [1, 0, 0, -1, 0, 1];
/** The horizontal mirror of the unit square. */
const MIRROR: Matrix = [-1, 0, 0, 1, 1, 0];

/** "a then b" (PDF row-vector order). */
export function concat(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

export function invert(m: Matrix): Matrix {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!det) throw new Error("singular matrix");
  const a = m[3] / det, b = -m[1] / det, c = -m[2] / det, d = m[0] / det;
  return [a, b, c, d, -(m[4] * a + m[5] * c), -(m[4] * b + m[5] * d)];
}

const translate = (x: number, y: number): Matrix => [1, 0, 0, 1, x, y];
const scaling = (x: number, y: number): Matrix => [x, 0, 0, y, 0, 0];
/** Where point (x, y) goes under m (exported for decorations.ts). */
export const applyTo = (m: Matrix, x: number, y: number): Point => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
const det = (m: Matrix) => m[0] * m[3] - m[1] * m[2];

/** The corners of the unit square under m: (0, 0), (1, 0), (1, 1), (0, 1), going round. */
const quadOf = (m: Matrix): Point[] => [applyTo(m, 0, 0), applyTo(m, 1, 0), applyTo(m, 1, 1), applyTo(m, 0, 1)];

export function bboxOf(points: Point[]): Rect {
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** The corners of a rect, going round. */
const cornersOf = (r: Rect): Point[] => [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]];

/** The intersection, empty ones kept as a zero-size rect at the edge (never inverted). */
function intersect(a: Rect, b: Rect): Rect {
  const x0 = Math.max(a[0], b[0]), y0 = Math.max(a[1], b[1]);
  return [x0, y0, Math.max(x0, Math.min(a[2], b[2])), Math.max(y0, Math.min(a[3], b[3]))];
}

/** Matrices that agree within 0.01 pt (plus MuPDF's float precision on large values). */
export function nearlyEqual(a: Matrix, b: Matrix, eps = 0.01): boolean {
  return a.every((v, i) => Math.abs(v - b[i]) <= eps + 1e-6 * Math.max(Math.abs(v), Math.abs(b[i])));
}

/**
 * The matrix M that, applied where the CTM is X, moves an image drawn at P to P':
 * M = X · P⁻¹ · P′ · X⁻¹ (the image ends at R · M · X = P′ for P = R · X).
 */
const between = (X: Matrix, P: Matrix, target: Matrix) => concat(concat(concat(X, invert(P)), target), invert(X));

/** A PDF number: fixed notation (PDF has no exponents), about 7 significant digits, trailing zeros dropped. */
export function num(v: number): string {
  if (Math.abs(v) < 1e-9) return "0";
  let s = v.toFixed(Math.max(0, 6 - Math.max(0, Math.floor(Math.log10(Math.abs(v))))));
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s === "-0" ? "0" : s;
}
const fmtMatrix = (m: Matrix) => m.map(num).join(" ");

/**
 * Where a picture of `width` × `height` pixels goes when it replaces the placement at `matrix`
 * (ImageInfo convention): inside the old box keeping its own proportions ("contain"), centred,
 * along the old box's axes (so with the same rotation).
 */
export function containFit(matrix: Matrix, width: number, height: number): Matrix {
  const have = Math.hypot(matrix[0], matrix[1]) / Math.hypot(matrix[2], matrix[3]), want = width / height;
  const sx = want < have ? want / have : 1, sy = want < have ? 1 : have / want;
  const inner = concat(concat(translate(-0.5, -0.5), scaling(sx, sy)), translate(0.5, 0.5));
  return concat(inner, matrix);
}

/**
 * A mirrored target (negative determinant) as a picture that is not mirrored, covering the same
 * box. A mirrored matrix reads as a picture turned by some angle and stored upside down (as some
 * printer drivers store pictures bottom-up), or turned by that angle plus 180° and mirrored left
 * to right (a "Flip horizontal"): the old picture is taken to be the more upright of the two, and
 * the new one is drawn at that angle. A new photo is never shown mirrored or upside down.
 */
export function unmirrored(target: Matrix): Matrix {
  if (det(target) >= 0) return target;
  const tilt = (m: Matrix) => Math.abs(Math.atan2(m[1], m[0]));
  const keepX = concat(FLIP, target), keepY = concat(MIRROR, target);
  return tilt(keepY) < tilt(keepX) - 1e-9 ? keepY : keepX;
}

// ---------------------------------------------------------------------------------------------
// Bytes

/** A stream's decoded bytes, copied out of the WebAssembly heap. */
export function streamBytes(obj: Obj): Uint8Array {
  const buf = obj.readStream();
  try {
    return buf.asUint8Array().slice();
  } finally {
    buf.destroy();
  }
}

/** Bytes as a string of char codes 0..255 (byte offsets = string offsets; binary data survives). */
export function latin1(u8: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode(...u8.subarray(i, i + 8192));
  return s;
}

/** The inverse of latin1: each char code (0..255) one byte. */
export function toBytes(s: string): Uint8Array {
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 255;
  return u;
}

/** Adds a stream made from `bytes`, destroying the temporary MuPDF Buffer. */
export function addStream(mupdf: MuPDFModule, doc: Doc, bytes: Uint8Array): Obj {
  const buf = new mupdf.Buffer(bytes);
  try {
    return doc.addStream(buf, {});
  } finally {
    buf.destroy();
  }
}

/** An image MuPDF can draw, from file bytes (JPEG, PNG...); throws when it cannot read them. */
export function openImage(mupdf: MuPDFModule, bytes: Uint8Array): MuPDF.Image {
  const buf = new mupdf.Buffer(bytes);
  try {
    return new mupdf.Image(buf); // keeps its own reference to the buffer
  } finally {
    buf.destroy();
  }
}

/**
 * Whether a picture file embeds a colour profile: a JPEG's APP2 ICC_PROFILE segment, a PNG's
 * iCCP chunk. Null for other formats (not read here).
 */
export function embedsProfile(bytes: Uint8Array): boolean | null {
  const at = (i: number) => bytes[i] ?? 0;
  const ascii = (i: number, s: string) => [...s].every((c, k) => at(i + k) === c.charCodeAt(0));
  if (at(0) === 0xff && at(1) === 0xd8) {
    for (let i = 2; i + 3 < bytes.length; ) {
      if (at(i) !== 0xff) return false; // lost in the segments: no profile found
      const marker = at(i + 1);
      if (marker === 0xff) { i++; continue; } // fill byte
      if (marker === 0xd9 || marker === 0xda) return false; // end of image, start of scan: no more headers
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; } // no length
      if (marker === 0xe2 && ascii(i + 4, "ICC_PROFILE\0")) return true;
      i += 2 + ((at(i + 2) << 8) | at(i + 3));
    }
    return false;
  }
  if (ascii(0, "\x89PNG\r\n\x1a\n")) {
    for (let i = 8; i + 8 <= bytes.length; ) {
      const length = ((at(i) << 24) | (at(i + 1) << 16) | (at(i + 2) << 8) | at(i + 3)) >>> 0;
      if (ascii(i + 4, "iCCP")) return true;
      if (ascii(i + 4, "IDAT") || ascii(i + 4, "IEND")) return false; // a profile comes before the data
      i += 12 + length;
    }
    return false;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Picture files (release 3)

/**
 * Where a JPEG's stored pixels go for each EXIF orientation (1..8): the stored picture's unit
 * square ((0, 0) its top-left corner) onto the picture as it is meant to be seen. A picture to be
 * seen at `target` (ImageInfo convention) is drawn at concat(ORIENTATION[o], target). MuPDF
 * ignores the tag, and so does every PDF reader for a DCTDecode stream: the placement turns it.
 * 2, 4, 5 and 7 are mirrored (negative determinant), as the camera stored them.
 */
export const ORIENTATION: Readonly<Record<number, Matrix>> = {
  1: [1, 0, 0, 1, 0, 0],
  2: [-1, 0, 0, 1, 1, 0],
  3: [-1, 0, 0, -1, 1, 1],
  4: [1, 0, 0, -1, 0, 1],
  5: [0, 1, 1, 0, 0, 0],
  6: [0, 1, -1, 0, 1, 0],
  7: [0, -1, -1, 0, 1, 1],
  8: [0, -1, 1, 0, 0, 1],
};

/** A picture checked for placing (checkPicture). Plain data: it goes into the edit log as it is. */
export interface Picture {
  /** The file's bytes, a JPEG without its metadata (withoutMetadata). */
  bytes: Uint8Array;
  /** The JPEG's EXIF orientation (1..8), 1 for anything else: ORIENTATION turns the placement upright. */
  orientation: number;
  /** Size in pixels as seen: the stored sides swapped for orientations 5 to 8. */
  width: number;
  height: number;
}

/** A picture file the engine does not take (checkPicture): the session refuses it ("bad-request"). */
export class BadPicture extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadPicture";
  }
}

/**
 * A picture file as the engine places it: at most MAX_IMAGE_BYTES, readable by MuPDF, with
 * pixels; a JPEG without the metadata that describes the photo (withoutMetadata) and with its
 * EXIF orientation read (jpegOrientation). Throws BadPicture otherwise. `bytes` itself is
 * returned when nothing had to go, so the caller decides whether to copy it.
 */
export function checkPicture(mupdf: MuPDFModule, bytes: Uint8Array): Picture {
  if (bytes.byteLength === 0) throw new BadPicture("The picture is empty");
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new BadPicture(`The picture is larger than ${MAX_IMAGE_BYTES} bytes`);
  const orientation = jpegOrientation(bytes);
  const clean = withoutMetadata(bytes);
  let image: MuPDF.Image;
  try {
    image = openImage(mupdf, clean);
  } catch (err) {
    throw new BadPicture(`The picture cannot be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const w = image.getWidth(), h = image.getHeight();
    if (!(w > 0 && h > 0)) throw new BadPicture("The picture has no pixels");
    const turned = orientation >= 5;
    return { bytes: clean, orientation, width: turned ? h : w, height: turned ? w : h };
  } finally {
    image.destroy();
  }
}

/** A piece of a JPEG file: a marker segment (marker 0x01..0xFE, start at its 0xFF) or entropy-coded data (marker -1). */
interface JpegPart {
  marker: number;
  start: number;
  end: number;
}

/**
 * A JPEG's parts after the start-of-image marker, in file order, up to and with its end-of-image
 * marker: what comes after it (the extra pictures of a multi-picture file, the video of a "motion
 * photo") is not listed. The coded data after each start-of-scan runs to the next marker that is
 * not a restart (0xFF00 is a stuffed byte, 0xFFFF a fill). Read as libjpeg (and so MuPDF) reads
 * it: stray bytes between segments, and a stuffed 0xFF00 there, are skipped up to the next
 * marker ("Corrupt JPEG data: extraneous bytes before marker"), and are not listed; a segment
 * whose length runs past the end of the file ends the reading (libjpeg reads no further: it
 * stops at the end of the data), and so does a marker cut off by the end. Whatever is not listed
 * is not drawn. Null when the bytes are not a JPEG.
 */
function jpegParts(b: Uint8Array): JpegPart[] | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  const out: JpegPart[] = [];
  for (let i = 2; i < b.length; ) {
    if (b[i] !== 0xff) { i++; continue; } // a stray byte
    if (i + 1 >= b.length) break;
    if (b[i + 1] === 0xff) { i++; continue; } // fill byte before a marker
    if (b[i + 1] === 0x00) { i += 2; continue; } // a stuffed zero outside the coded data
    const marker = b[i + 1];
    if (marker === 0xd9) {
      out.push({ marker, start: i, end: i + 2 });
      return out;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { // no length
      out.push({ marker, start: i, end: i + 2 });
      i += 2;
      continue;
    }
    if (i + 3 >= b.length) break;
    // (a length under 2 covers the length itself, as libjpeg skips it)
    const length = (b[i + 2] << 8) | b[i + 3], end = i + 2 + Math.max(2, length);
    if (end > b.length) break;
    out.push({ marker, start: i, end });
    i = end;
    if (marker !== 0xda) continue;
    let j = i;
    while (j + 1 < b.length && !(b[j] === 0xff && b[j + 1] !== 0x00 && b[j + 1] !== 0xff && !(b[j + 1] >= 0xd0 && b[j + 1] <= 0xd7))) j++;
    if (j + 1 >= b.length) j = b.length; // no end of image: a truncated file, its data kept to the end
    out.push({ marker: -1, start: i, end: j });
    i = j;
  }
  return out;
}

/** The EXIF orientation (1..8) of a JPEG, 1 when it has none or it cannot be read. */
export function jpegOrientation(b: Uint8Array): number {
  for (const s of jpegParts(b) ?? []) {
    if (s.marker === 0xda) break; // the headers are over
    if (s.marker !== 0xe1 || s.end - s.start < 4 + 6 + 8) continue;
    const at = s.start + 4;
    if (String.fromCharCode(...b.subarray(at, at + 6)) !== "Exif\0\0") continue;
    const t = at + 6, le = b[t] === 0x49 && b[t + 1] === 0x49;
    if (!le && !(b[t] === 0x4d && b[t + 1] === 0x4d)) continue;
    const inside = (o: number, n: number) => o >= 0 && t + o + n <= s.end;
    const u16 = (o: number) => (le ? b[t + o] | (b[t + o + 1] << 8) : (b[t + o] << 8) | b[t + o + 1]);
    const u32 = (o: number) => (le ? u16(o) + u16(o + 2) * 65536 : u16(o) * 65536 + u16(o + 2));
    const ifd = u32(4);
    if (!inside(ifd, 2)) continue;
    for (let k = 0, n = u16(ifd); k < n; k++) {
      const e = ifd + 2 + k * 12;
      if (!inside(e, 12)) break;
      if (u16(e) !== 0x0112) continue; // Orientation, a SHORT: its value in the entry's first two bytes
      const v = u16(e + 8);
      return v >= 1 && v <= 8 ? v : 1;
    }
  }
  return 1;
}

/**
 * The JPEG without what describes the photo rather than draws it: EXIF (the GPS position, the
 * camera, the date, a thumbnail), XMP, IPTC and Photoshop data, comments, the other application
 * segments (a JFXX thumbnail too), and whatever follows the end of the image (the extra pictures
 * of a multi-picture file, the video of a "motion photo"). Kept: JFIF (APP0), the colour profile (APP2
 * ICC_PROFILE), Adobe's segment (APP14: it says how CMYK and YCCK are coded) and everything that
 * codes the pixels, which are not coded again. Bytes jpegParts does not list (stray bytes between
 * segments, what follows a segment cut off by the end of the file) go too: no decoder draws them.
 * Other formats come back as they are; so does a JPEG with nothing to drop (the same array).
 */
export function withoutMetadata(b: Uint8Array): Uint8Array {
  const parts = jpegParts(b);
  if (!parts) return b;
  const says = (p: JpegPart, id: string) => String.fromCharCode(...b.subarray(p.start + 4, p.start + 4 + id.length)) === id;
  const describes = (p: JpegPart) =>
    p.marker === 0xfe || // COM
    (p.marker >= 0xe1 && p.marker <= 0xef && p.marker !== 0xe2 && p.marker !== 0xee) ||
    (p.marker === 0xe2 && !says(p, "ICC_PROFILE\0")) ||
    (p.marker === 0xe0 && !says(p, "JFIF\0")); // a JFXX extension holds only a thumbnail
  const kept = parts.filter((p) => !describes(p));
  // (the parts are in file order and do not overlap: they cover the file when their sizes add up to it)
  if (kept.length === parts.length && 2 + parts.reduce((n, p) => n + p.end - p.start, 0) === b.length) return b;
  const out = new Uint8Array(2 + kept.reduce((n, p) => n + p.end - p.start, 0));
  out.set(b.subarray(0, 2));
  let o = 2;
  for (const p of kept) {
    out.set(b.subarray(p.start, p.end), o);
    o += p.end - p.start;
  }
  return out;
}

/** FNV-1a, 32 bits: the key under which a replacement picture is found again (bytes compared too). */
function hashOf(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 0x01000193);
  return h >>> 0;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---------------------------------------------------------------------------------------------
// Lexer

/** A content-stream token: an operand (one field set) or an operator (`op`). */
export interface Operand {
  num?: number;
  name?: string;
  str?: string;
  hex?: string;
  arr?: Operand[];
  dict?: Record<string, Operand>;
  bool?: boolean;
  nul?: true;
  op?: string;
}

export interface Operation {
  op: string;
  args: Operand[];
  /** Byte offset of the first operand (or of the operator when it has none). */
  start: number;
  /** Byte offset just after the operator (after EI for an inline image). */
  end: number;
}

const WS = new Uint8Array(256), DELIM = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) WS[c] = 1;
for (const c of "()<>[]{}/%") DELIM[c.charCodeAt(0)] = 1;
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)$/;
const UTF8 = new TextDecoder();

/**
 * A name as MuPDF reads it, from its bytes as written (without the slash): #xx escapes decoded
 * ("Logo#20A" is the name "Logo A"; MuPDF keeps "#00" as written), then the bytes taken as UTF-8,
 * which is how MuPDF.js gives and looks up dictionary keys. So the walk and the cleanup find the
 * resources MuPDF draws.
 */
export function nameFrom(raw: string): string {
  const bytes = raw.includes("#")
    ? raw.replace(/#([0-9A-Fa-f]{2})/g, (escape, hex: string) => (hex === "00" ? escape : String.fromCharCode(parseInt(hex, 16))))
    : raw;
  return /[^\x00-\x7f]/.test(bytes) ? UTF8.decode(toBytes(bytes)) : bytes;
}

/**
 * The operations of a content stream, from byte `from` on. Names come decoded (nameFrom). An
 * inline image comes out as one operation "BI" spanning BI..EI, with its dictionary (keys as
 * written, often abbreviated) as its only operand.
 */
export function* operations(s: string, from = 0): Generator<Operation> {
  const n = s.length;
  let i = from, args: Operand[] = [], start = -1;
  const skipWS = () => {
    for (;;) {
      while (i < n && WS[s.charCodeAt(i)]) i++;
      if (s[i] === "%") {
        while (i < n && s[i] !== "\n" && s[i] !== "\r") i++;
        continue;
      }
      return;
    }
  };
  // One token at i (not whitespace); always moves i forward.
  const value = (): Operand => {
    const c = s[i];
    if (c === "(") {
      let depth = 0, out = "";
      for (; i < n; i++) {
        const ch = s[i];
        if (ch === "\\") {
          out += ch + (s[++i] ?? "");
          continue;
        }
        if (ch === "(") {
          if (depth++ === 0) continue;
        } else if (ch === ")" && --depth === 0) {
          i++;
          break;
        }
        out += ch;
      }
      return { str: out };
    }
    if (c === "<" && s[i + 1] === "<") {
      i += 2;
      const d: Record<string, Operand> = {};
      for (;;) {
        skipWS();
        if (i >= n) break;
        if (s[i] === ">" && s[i + 1] === ">") {
          i += 2;
          break;
        }
        const k = value();
        skipWS();
        d[k.name ?? String(k.op ?? k.num)] = value();
      }
      return { dict: d };
    }
    if (c === "<") {
      let j = s.indexOf(">", i);
      if (j < 0) j = n;
      const hex = s.slice(i + 1, j);
      i = j + 1;
      return { hex };
    }
    if (c === "[") {
      i++;
      const arr: Operand[] = [];
      for (;;) {
        skipWS();
        if (i >= n || s[i] === "]") {
          i++;
          break;
        }
        arr.push(value());
      }
      return { arr };
    }
    let j = i + 1;
    while (j < n && !WS[s.charCodeAt(j)] && !DELIM[s.charCodeAt(j)]) j++;
    const tok = s.slice(i, j);
    i = j;
    if (c === "/") return { name: nameFrom(tok.slice(1)) };
    if (NUMBER.test(tok)) return { num: +tok };
    if (tok === "true" || tok === "false") return { bool: tok === "true" };
    if (tok === "null") return { nul: true };
    return { op: tok };
  };
  for (;;) {
    skipWS();
    if (i >= n) return;
    if (start < 0) start = i;
    const v = value();
    if (v.op === undefined) {
      args.push(v);
      continue;
    }
    if (v.op === "BI") {
      const dict: Record<string, Operand> = {};
      for (;;) {
        skipWS();
        if (i >= n) break;
        const k = value();
        if (k.op === "ID") break;
        skipWS();
        dict[k.name ?? String(k.op ?? k.num)] = value();
      }
      const end = inlineImageEnd(s, i + 1, dict); // the data starts one whitespace byte after ID
      i = end;
      yield { op: "BI", args: [{ dict }], start, end };
    } else {
      yield { op: v.op, args, start, end: i };
    }
    args = [];
    start = -1;
  }
}

const INLINE_COMPONENTS: Record<string, number> = { G: 1, DeviceGray: 1, RGB: 3, DeviceRGB: 3, CMYK: 4, DeviceCMYK: 4 };

/**
 * Where an inline image ends (just after EI). With its length given (/L, PDF 2.0) or unfiltered
 * data of a known size, the data is skipped exactly; otherwise the first "EI" between whitespace.
 * A misread here shows as a disagreement with MuPDF in the safety gate.
 */
function inlineImageEnd(s: string, from: number, d: Record<string, Operand>): number {
  const filter = d.F ?? d.Filter, w = (d.W ?? d.Width)?.num, h = (d.H ?? d.Height)?.num;
  const bpc = (d.BPC ?? d.BitsPerComponent)?.num ?? 1, mask = (d.IM ?? d.ImageMask)?.bool;
  const cs = (d.CS ?? d.ColorSpace)?.name;
  const comps = mask ? 1 : cs ? INLINE_COMPONENTS[cs] : undefined;
  const length = (d.L ?? d.Length)?.num;
  let at = from;
  if (length !== undefined) at = from + length;
  else if (!filter && w && h && comps) at = from + Math.ceil((w * comps * bpc) / 8) * h;
  const re = /[\0\t\n\f\r ]EI(?=[\0\t\n\f\r ]|$)/g;
  re.lastIndex = Math.max(from, at - 1);
  const m = re.exec(s);
  return m ? m.index + 3 : s.length;
}

// ---------------------------------------------------------------------------------------------
// The walk

/** The painting operators: paths, shadings, text shown (exported for decorations.ts, with PATH). */
export const PAINT = new Set(["S", "s", "f", "F", "f*", "B", "B*", "b", "b*", "sh", "Tj", "TJ", "'", "\""]);
const SHOW_TEXT = new Set(["Tj", "TJ", "'", "\""]);
/** The path-construction operators. */
export const PATH = new Set(["m", "l", "c", "v", "y", "h", "re"]);

/** The path that made a clip, as written, so that it can be written again elsewhere. */
interface ClipPath {
  /** Its path-construction operations (m, l, c, v, y, h, re), as in the content. */
  text: string;
  /** The CTM they were written under (page space). */
  ctm: Matrix;
  evenOdd: boolean;
}

/** A clip in effect: its page-space bounds, and its outline when it is one convex polygon. */
interface Clip {
  /** Null when unknown (text used as a clip). */
  rect: Rect | null;
  /** The outline (page space) when the clip is a single straight-edged convex shape: a rectangle, a rotated one... */
  poly: Point[] | null;
  /** The path that made it (null for text used as a clip). */
  path: ClipPath | null;
  /** q depth and form level where it was set. */
  depth: number;
  level: number;
}

/**
 * The clips in effect, newest first, as a list whose tails are shared: the state saved by q keeps
 * its list, and adding a clip copies nothing (a copied array made pages with many clips quadratic).
 */
interface ClipNode {
  clip: Clip;
  prev: ClipNode | null;
  /** How many clips the list holds. */
  size: number;
}

interface GState {
  ctm: Matrix;
  clips: ClipNode | null;
  /** q depth and form level where a soft mask was set with gs (-1: none). */
  smaskDepth: number;
  smaskLevel: number;
  /** Text rendering mode (Tr): 4 to 7 add the text to the clip. */
  textRender: number;
  /** W or W* seen: the path is a clip once painted (or ended with n). */
  pendingClip: boolean;
  /** ...and the path, as written. */
  pendingClipPath?: ClipPath;
  /** The fill or the stroke colour is a pattern (MuPDF may draw the images of its cells as plain images). */
  fillPattern: boolean;
  strokePattern: boolean;
  /** The font set with Tf is a Type 3 font (whose glyphs MuPDF may draw as images). */
  type3: boolean;
}

/** A q..Q block of the page content (level 0). */
interface Block {
  stream: number;
  /** Offset of its q, and just after it. */
  qStart: number;
  qEnd: number;
  /** Offset just after its Q, when that Q is in the same stream. */
  end?: number;
  /** The CTM at its q. */
  X: Matrix;
  /** The q depth inside it. */
  depth: number;
  /** Paints inside it, the contents of forms counted. */
  paints: number;
  /** The image placement of its first paint (null: something else came first). */
  first: Walked | null | undefined;
}

/** The page-level operation that paints a placement: the Do, the BI..EI, or the Do of the form holding it. */
interface TopOp {
  stream: number;
  start: number;
  end: number;
  /** The CTM where it is drawn. */
  X: Matrix;
  /** The XObject name it draws (null for an inline image). */
  name: string | null;
}

/** A marked-content sequence (BDC or BMC .. EMC) as the walk read it. */
interface Mark {
  mcid: number | null;
  /** The form whose /StructParents the MCID belongs to (null: the page's). */
  host: Obj | null;
  /** The paints counted when it began; once it has ended, how many it holds (the contents of forms counted). */
  from: number;
  paints?: number;
  /** A page-level block of a picture the app placed (its property list has /PEImage: newcontent.addImage). */
  added: boolean;
}

/** A placement as the walk found it. */
interface Walked {
  kind: "xobject" | "inline" | "form";
  /** The PDF image matrix in page space. */
  P: Matrix;
  clips: ClipNode | null;
  smaskDepth: number;
  smaskLevel: number;
  /** The innermost marked-content sequence around it that has an MCID. */
  mark: Mark | null;
  /** The /OC (optional content) of the forms it is drawn in and of the image, outermost first. */
  layers: Obj[];
  top: TopOp;
  /** The outermost q..Q block (in one stream) around `top` that paints nothing else. */
  unit: Block | null;
  /** The innermost q..Q block of the page around `top`. */
  inner: Block | null;
  /** Inside a form that also paints other things. */
  group: boolean;
  /** Inside a block marked /PEImage: a picture the app placed. */
  added: boolean;
  /** The EXIF orientation its picture object records (turnOf), 1 for any other picture. */
  turn: number;
}

interface WalkResult {
  walked: Walked[];
  texts: string[];
  /** Something was painted with a pattern colour or a Type 3 font: MuPDF may draw images that are not placements. */
  extraDraws: boolean;
}

/** The page's content streams, in /Contents order (none when it has no content). */
export function contentStreams(pageObj: Obj): Obj[] {
  const c = pageObj.get("Contents");
  const list: Obj[] = [];
  if (c.isArray()) for (let k = 0; k < c.length; k++) list.push(c.get(k));
  else if (c.isStream()) list.push(c);
  return list;
}

/**
 * obj[key][key]..., or the null object when anything on the way is missing: MuPDF.js's get() on
 * the null object throws, a path given to get() on a dictionary does not.
 */
function lookup(obj: Obj, ...path: string[]): Obj {
  return obj.isNull() ? obj : obj.get(...path);
}

const nameOf = (o: Obj) => (o.isName() ? o.asName() : null);
export const isNumeric = (args: Operand[], count: number) => args.length === count && args.every((x) => x.num !== undefined);
export const numbersOf = (args: Operand[]) => args.map((x) => x.num!);

function matrixOf(o: Obj): Matrix {
  if (!o.isArray() || o.length !== 6) return IDENTITY;
  const m = [0, 1, 2, 3, 4, 5].map((k) => o.get(k).asNumber());
  return m.every(Number.isFinite) ? (m as Matrix) : IDENTITY;
}

/** Whether colour space `name` (of the resources) is /Pattern. */
function isPatternSpace(res: Obj, name: string | undefined): boolean {
  if (name === undefined) return false;
  if (name === "Pattern") return true;
  const cs = lookup(res, "ColorSpace", name);
  return nameOf(cs) === "Pattern" || (cs.isArray() && cs.length > 0 && nameOf(cs.get(0)) === "Pattern");
}

/** A clip from a path: its outline is kept when it is one straight-edged convex shape. */
function pathClip(subpaths: Point[][], curved: boolean, path: ClipPath | null, depth: number, level: number): Clip | null {
  const points = subpaths.flat();
  if (!points.length) return null;
  const outline = subpaths.length === 1 && !curved ? subpaths[0] : null;
  const poly = outline && outline.length >= 3 && outline.length <= 16 && isConvex(outline) ? outline : null;
  return { rect: bboxOf(points), poly, path, depth, level };
}

function cross(o: Point, a: Point, b: Point) {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

/** Edges that turn one way only (collinear and repeated points ignored). */
function isConvex(poly: Point[]): boolean {
  let sign = 0;
  for (let k = 0; k < poly.length; k++) {
    const c = cross(poly[k], poly[(k + 1) % poly.length], poly[(k + 2) % poly.length]);
    if (Math.abs(c) < 1e-9) continue;
    if (sign === 0) sign = Math.sign(c);
    else if (Math.sign(c) !== sign) return false;
  }
  return sign !== 0;
}

/** Whether every point lies inside the convex polygon (0.01 pt of slack). */
function insideConvex(poly: Point[], points: Point[]): boolean {
  let sign = 0;
  for (let k = 0; k < poly.length && !sign; k++) {
    const c = cross(poly[k], poly[(k + 1) % poly.length], poly[(k + 2) % poly.length]);
    if (Math.abs(c) >= 1e-9) sign = Math.sign(c);
  }
  for (let k = 0; k < poly.length; k++) {
    const a = poly[k], b = poly[(k + 1) % poly.length], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-9) continue;
    for (const p of points) if ((sign * cross(a, b, p)) / len < -0.01) return false;
  }
  return true;
}

/**
 * Whether a clip set outside the picture's own block crops it as a frame would: it cuts part of
 * the picture off now, and it lies within the picture's box (1 pt of slack), as the frame of a
 * cropped photo does. Moved, such a picture would show another part of itself, so it is locked.
 * A larger clip that the picture reaches, such as the page-margin clip Chrome writes around
 * everything, is not a frame: the picture may move, also back out of it after a move that took it
 * partly under the margin. A shape that cannot be measured (curves, text) counts as cutting.
 */
function cropsAsFrame(clip: Clip, quad: Point[], bbox: Rect): boolean {
  if (clip.poly && insideConvex(clip.poly, quad)) return false;
  if (!clip.rect) return true;
  const [x0, y0, x1, y1] = clip.rect;
  return x0 >= bbox[0] - 1 && y0 >= bbox[1] - 1 && x1 <= bbox[2] + 1 && y1 <= bbox[3] + 1;
}

/**
 * The image placements of a page's content, in painting order, as written. Throws on content it
 * cannot read, and past MAX_WALK_OPERATIONS, MAX_PLACEMENTS or MAX_CLIP_CHECKS (WalkLimit).
 */
function walkPage(page: MuPDF.PDFPage): WalkResult {
  const pageObj = page.getObject();
  const streams = contentStreams(pageObj);
  const texts = streams.map((st) => latin1(streamBytes(st)));
  const resources = pageObj.getInheritable("Resources");
  const walked: Walked[] = [];
  const blocks: Block[] = [];
  /** The content of each form drawn, read once. */
  const formTexts = new Map<number, string>();
  /** Paints so far, at any level (the contents of forms counted one by one). */
  let operationsRead = 0, clipChecks = 0, extraDraws = false, painted = 0;

  let gs: GState = {
    ctm: page.getTransform(), clips: null, smaskDepth: -1, smaskLevel: 0, textRender: 0, pendingClip: false,
    fillPattern: false, strokePattern: false, type3: false,
  };
  const gstack: GState[] = [];
  /** The open q blocks of the page level. */
  const open: Block[] = [];
  /** The marked-content sequences open, innermost last. */
  const marks: Mark[] = [];
  /** Ends the marked-content sequences open past `depth`. */
  const endMarks = (depth: number) => {
    while (marks.length > depth) {
      const m = marks.pop()!;
      m.paints = painted - m.from;
    }
  };
  /** The /OC of the forms being walked. */
  const layers: Obj[] = [];
  let subpaths: Point[][] = [], curved = false;
  /** Text shown in a clipping mode since BT: it becomes a clip at ET. */
  let textClip = false;

  const paintAtTop = (count: number, placement: Walked | null) => {
    if (!count) return;
    for (const b of open) {
      b.paints += count;
      if (b.first === undefined) b.first = placement;
    }
  };
  const addClip = (clip: Clip | null) => {
    if (clip) gs.clips = { clip, prev: gs.clips, size: (gs.clips?.size ?? 0) + 1 };
  };
  const point = (x: number, y: number) => applyTo(gs.ctm, x, y);
  const record = (o: Operation, level: number, stream: number, top: TopOp | null, kind: Walked["kind"], name: string | null, layer: Obj | null) => {
    if (walked.length >= MAX_PLACEMENTS) throw new WalkLimit(`More than ${MAX_PLACEMENTS} images`);
    clipChecks += gs.clips?.size ?? 0;
    if (clipChecks > MAX_CLIP_CHECKS) throw new WalkLimit("Too many clips");
    // Content belongs to the innermost marked-content sequence that has an id.
    const mark = marks.findLast((m) => m.mcid !== null) ?? null;
    const w: Walked = {
      kind,
      P: gs.ctm,
      clips: gs.clips,
      smaskDepth: gs.smaskDepth,
      smaskLevel: gs.smaskLevel,
      mark,
      layers: layer ? [...layers, layer] : layers.slice(),
      top: level === 0 ? { stream, start: o.start, end: o.end, X: gs.ctm, name } : top!,
      unit: null,
      inner: open.length ? open[open.length - 1] : null,
      group: false,
      added: marks.some((m) => m.added),
      turn: 1,
    };
    walked.push(w);
    return w;
  };

  // Walks one content string; `level` 0 is the page, `top` the page-level operation being
  // expanded below it, `host` the form being walked (null: the page). Returns the number of
  // paints (a form counts what it paints).
  function walk(s: string, res: Obj, level: number, stream: number, top: TopOp | null, chain: number[], host: Obj | null): number {
    let paints = 0;
    /** Where the path being built starts in `s` (-1: no path). */
    let pathFrom = -1;
    // As MuPDF: a Q never restores past the state a form began with. The page's streams are one
    // content (a q in one may close in the next), so the page level starts from the bottom.
    const floor = level === 0 ? 0 : gstack.length;
    for (const o of operations(s)) {
      if (++operationsRead > MAX_WALK_OPERATIONS) throw new WalkLimit(`More than ${MAX_WALK_OPERATIONS} operations`);
      const a = o.args;
      if (pathFrom < 0 && PATH.has(o.op)) pathFrom = o.start;
      switch (o.op) {
        case "q":
          gstack.push(gs);
          gs = { ...gs };
          if (level === 0) open.push({ stream, qStart: o.start, qEnd: o.end, X: gs.ctm, depth: gstack.length, paints: 0, first: undefined });
          break;
        case "Q":
          if (gstack.length > floor) {
            gs = gstack.pop()!;
            const b = level === 0 ? open.pop() : undefined;
            if (b && b.stream === stream) {
              b.end = o.end;
              blocks.push(b);
            }
          }
          break;
        case "cm":
          if (isNumeric(a, 6)) gs.ctm = concat(numbersOf(a) as Matrix, gs.ctm);
          break;
        case "BDC":
        case "BMC": {
          // (the property list is the last operand: operands a content left without an operator come first)
          const p = o.op === "BDC" ? a[a.length - 1] : undefined;
          let mcid = p?.dict?.MCID?.num ?? null;
          let added = p?.dict?.PEImage?.num !== undefined;
          if (p?.name) {
            const prop = lookup(res, "Properties", p.name);
            if (prop.isDictionary()) {
              if (mcid === null && prop.get("MCID").isNumber()) mcid = prop.get("MCID").asNumber();
              added ||= prop.get("PEImage").isNumber();
            }
          }
          // (only the page's own blocks: the app never places a picture inside a form)
          marks.push({ mcid, host, from: painted, added: added && level === 0 });
          break;
        }
        case "EMC":
          endMarks(marks.length - 1);
          break;
        case "gs": {
          const eg = lookup(res, "ExtGState", a[0]?.name ?? "");
          if (eg.isDictionary()) {
            const sm = eg.get("SMask");
            if (sm.isDictionary()) {
              gs.smaskDepth = gstack.length;
              gs.smaskLevel = level;
            } else if (sm.isName()) gs.smaskDepth = -1; // /None
          }
          break;
        }
        case "cs":
          gs.fillPattern = isPatternSpace(res, a[0]?.name);
          break;
        case "CS":
          gs.strokePattern = isPatternSpace(res, a[0]?.name);
          break;
        case "g":
        case "rg":
        case "k":
          gs.fillPattern = false;
          break;
        case "G":
        case "RG":
        case "K":
          gs.strokePattern = false;
          break;
        case "Tf":
          gs.type3 = nameOf(lookup(res, "Font", a[0]?.name ?? "", "Subtype")) === "Type3";
          break;
        case "Tr":
          if (isNumeric(a, 1)) gs.textRender = a[0].num!;
          break;
        case "BT":
          textClip = false;
          break;
        case "ET":
          if (textClip) addClip({ rect: null, poly: null, path: null, depth: gstack.length, level });
          textClip = false;
          break;
        case "re":
          if (isNumeric(a, 4)) {
            const [x, y, w, h] = numbersOf(a);
            subpaths.push([point(x, y), point(x + w, y), point(x + w, y + h), point(x, y + h)]);
          }
          break;
        case "m":
          if (isNumeric(a, 2)) subpaths.push([point(a[0].num!, a[1].num!)]);
          break;
        case "l":
          if (isNumeric(a, 2)) {
            if (!subpaths.length) subpaths.push([]);
            subpaths[subpaths.length - 1].push(point(a[0].num!, a[1].num!));
          }
          break;
        case "c":
        case "v":
        case "y": // control points: the bounds may be a little large, and the shape is not measured
          if (!subpaths.length) subpaths.push([]);
          for (let k = 0; k + 1 < a.length; k += 2) subpaths[subpaths.length - 1].push(point(a[k].num ?? 0, a[k + 1].num ?? 0));
          curved = true;
          break;
        case "W":
        case "W*":
          gs.pendingClip = true;
          if (pathFrom >= 0) gs.pendingClipPath = { text: s.slice(pathFrom, o.start), ctm: gs.ctm, evenOdd: o.op === "W*" };
          break;
        case "BI": {
          paints++;
          painted++;
          const im = a[0]?.dict;
          if ((im?.IM ?? im?.ImageMask)?.bool === true && gs.fillPattern) {
            // A stencil mask painted with a pattern: MuPDF clips to it and draws the pattern, it
            // draws no image (and the pattern's cells may come as images).
            extraDraws = true;
            if (level === 0) paintAtTop(1, null);
            break;
          }
          const w = record(o, level, stream, top, level === 0 ? "inline" : "form", null, null);
          if (level === 0) paintAtTop(1, w);
          break;
        }
        case "Do": {
          const name = a[0]?.name;
          if (name === undefined) break;
          const xo = lookup(res, "XObject", name);
          if (!xo.isStream()) break;
          const subtype = nameOf(xo.get("Subtype"));
          const layer = xo.get("OC");
          if (subtype === "Image") {
            paints++;
            painted++;
            const stencil = xo.get("ImageMask");
            if (stencil.isBoolean() && stencil.asBoolean() && gs.fillPattern) {
              extraDraws = true; // as for an inline stencil mask above
              if (level === 0) paintAtTop(1, null);
              break;
            }
            const w = record(o, level, stream, top, level === 0 ? "xobject" : "form", name, layer.isDictionary() ? layer : null);
            w.turn = turnOf(xo);
            if (level === 0) paintAtTop(1, w);
          } else if (subtype === "Form") {
            const objNum = xo.isIndirect() ? xo.asIndirect() : -1;
            if (objNum >= 0 && chain.includes(objNum)) break; // MuPDF skips a form that draws itself
            const before = walked.length, depthBefore = gstack.length, marksBefore = marks.length;
            const outer = gs;
            gstack.push(gs);
            gs = { ...gs, ctm: concat(matrixOf(xo.get("Matrix")), gs.ctm) };
            const bb = xo.get("BBox");
            if (bb.isArray() && bb.length === 4) {
              const [x0, y0, x1, y1] = [0, 1, 2, 3].map((k) => bb.get(k).asNumber());
              const path = { text: `${num(x0)} ${num(y0)} ${num(x1 - x0)} ${num(y1 - y0)} re`, ctm: gs.ctm, evenOdd: false };
              addClip(pathClip([[point(x0, y0), point(x1, y0), point(x1, y1), point(x0, y1)]], false, path, gstack.length, level + 1));
            }
            const fres = xo.get("Resources");
            const topOp = level === 0 ? { stream, start: o.start, end: o.end, X: outer.ctm, name } : top!;
            let text = objNum >= 0 ? formTexts.get(objNum) : undefined;
            if (text === undefined) {
              text = latin1(streamBytes(xo));
              if (objNum >= 0) formTexts.set(objNum, text);
            }
            if (layer.isDictionary()) layers.push(layer);
            const inner = walk(text, fres.isDictionary() ? fres : res, level + 1, stream, topOp, objNum >= 0 ? [...chain, objNum] : chain, xo);
            if (layer.isDictionary()) layers.pop();
            gstack.length = depthBefore + 1; // whatever the form left open is closed with it
            gs = gstack.pop()!;
            endMarks(marksBefore); // a sequence the form left open ends with it
            subpaths = [];
            curved = false;
            pathFrom = -1;
            paints += inner;
            if (level === 0) {
              const mine = walked.slice(before);
              // A form moves as a whole: only when it paints exactly one image.
              if (inner !== 1) for (const w of mine) w.group = true;
              paintAtTop(inner, inner === 1 && mine.length === 1 ? mine[0] : null);
            }
          }
          break;
        }
        default:
          if (PAINT.has(o.op) || o.op === "n") {
            if (gs.pendingClip) addClip(pathClip(subpaths, curved, gs.pendingClipPath ?? null, gstack.length, level));
            gs.pendingClip = false;
            gs.pendingClipPath = undefined;
            subpaths = [];
            curved = false;
            pathFrom = -1;
            if (o.op !== "n") {
              paints++;
              painted++;
              if (level === 0) paintAtTop(1, null);
              if (SHOW_TEXT.has(o.op) && gs.textRender >= 4) textClip = true;
              if (gs.fillPattern || gs.strokePattern || (gs.type3 && SHOW_TEXT.has(o.op))) extraDraws = true;
            }
          }
      }
    }
    return paints;
  }

  streams.forEach((_, k) => walk(texts[k], resources, 0, k, null, [], null));
  endMarks(0); // (sequences left open end with the page)
  // Blocks close inner-first, so the last block found for a placement is the outermost.
  for (const b of blocks) if (b.paints === 1 && b.first) b.first.unit = b;
  return { walked, texts, extraDraws };
}

// ---------------------------------------------------------------------------------------------
// The device pass (MuPDF's own interpreter)

/** An image as MuPDF draws it. */
interface Drawn {
  /** ImageInfo convention (MuPDF reports exactly that). */
  matrix: Matrix;
  width: number;
  height: number;
  /** Its bounding box within the clips in effect and the page. */
  visible: Rect;
}

/** Stroke state "none" for getBounds (MuPDF accepts null; the types do not say so). */
export const NO_STROKE = null as unknown as MuPDF.StrokeState;

/** What a device callback receives and must destroy. */
type Received = { destroy(): void };

/**
 * Callbacks that never throw: `work` runs unless a callback failed already, its error is kept
 * (the first one), and what the callback received is destroyed in any case. An exception must not
 * leave a device callback, since it would unwind through MuPDF's C frames.
 */
export function guarded() {
  let failure: { error: unknown } | null = null;
  return {
    attempt<T>(work: () => T, ...received: Received[]): T | undefined {
      let result: T | undefined;
      try {
        if (!failure) result = work();
      } catch (error) {
        failure ??= { error };
      }
      for (const o of received)
        try {
          o.destroy();
        } catch (error) {
          failure ??= { error };
        }
      return result;
    },
    get failed() {
      return failure !== null;
    },
    /** Throws the failure (if any) as a DevicePassError, now that MuPDF is no longer below us. */
    check(what: string) {
      if (failure) {
        const { error } = failure;
        throw new DevicePassError(`${what}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}

/**
 * Every image MuPDF draws on the page, in order (at most MAX_DRAWN kept; `count` counts them all).
 * Images inside tiling patterns (beginTile..endTile) and inside soft-mask groups
 * (beginMask..endMask) are left out: they are not placements, and the walk does not enter
 * patterns or masks either. renderPlacement counts the same way.
 */
function devicePass(mupdf: MuPDFModule, page: MuPDF.PDFPage): { drawn: Drawn[]; count: number } {
  const out: Drawn[] = [];
  /** For each clip in effect, the page area left visible by it and those under it (the bottom: the page). */
  const region: Rect[] = [page.getBounds() as Rect];
  let tile = 0, mask = 0, count = 0;
  const g = guarded();
  const take = (img: MuPDF.Image, ctm: Matrix) => {
    if (tile || mask) return;
    if (++count > MAX_DRAWN) return;
    const visible = intersect(bboxOf(quadOf(ctm)), region[region.length - 1]);
    out.push({ matrix: [...ctm] as Matrix, width: img.getWidth(), height: img.getHeight(), visible });
  };
  /** A clip pushed (always, so that popClip stays in step), narrowing the visible area by `bounds` when known. */
  const pushClip = (bounds: () => Rect | null, ...received: Received[]) => {
    const r = g.attempt(bounds, ...received);
    const under = region[region.length - 1];
    region.push(r ? intersect(under, r) : under);
  };
  const dev = new mupdf.Device({
    fillImage(img, ctm) { g.attempt(() => take(img, ctm as Matrix), img); },
    fillImageMask(img, ctm, cs) { g.attempt(() => take(img, ctm as Matrix), img, cs); },
    clipPath(path, _evenOdd, ctm) { pushClip(() => path.getBounds(NO_STROKE, ctm) as Rect, path); },
    clipStrokePath(path, stroke, ctm) { pushClip(() => path.getBounds(stroke, ctm) as Rect, path, stroke); },
    clipText(text, ctm) { pushClip(() => text.getBounds(NO_STROKE, ctm) as Rect, text); },
    clipStrokeText(text, stroke, ctm) { pushClip(() => text.getBounds(stroke, ctm) as Rect, text, stroke); },
    clipImageMask(img, ctm) { pushClip(() => bboxOf(quadOf(ctm as Matrix)), img); },
    beginMask(_area, _luminosity, cs) { pushClip(() => null, cs); mask++; },
    endMask() { mask--; },
    popClip() { if (region.length > 1) region.pop(); },
    beginTile() { tile++; return 0; },
    endTile() { tile--; },
  });
  try {
    page.runPageContents(dev, mupdf.Matrix.identity);
    dev.close();
  } finally {
    dev.destroy();
  }
  g.check("MuPDF could not read the page's images");
  return { drawn: out, count };
}

// ---------------------------------------------------------------------------------------------
// Placements

/** One placement of a picture on the page (the protocol's ImageInfo, plus where it is in the content). */
export interface Placement {
  index: number;
  kind: "xobject" | "inline" | "form";
  /** ImageInfo.matrix: the picture's unit square as seen, onto the page. */
  matrix: Matrix;
  bbox: Rect;
  visible: Rect;
  pixelWidth: number;
  pixelHeight: number;
  movable: boolean;
  reason: ImageLockReason | null;
  /** Its position among the images MuPDF draws (renderPlacement counts that way). */
  drawIndex: number;
  /** The innermost marked-content id around it (tagged PDFs), and the form whose /StructParents it belongs to (null: the page's). */
  mcid: number | null;
  mcidHost: Obj | null;
  /** That marked-content sequence holds nothing but this placement. */
  alone: boolean;
  /** The /OC of the image and of the forms it is drawn in, outermost first. */
  layers: Obj[];
  /** The clips that move with it (set inside its own block, or inside the form holding it), oldest first. */
  inside: Clip[];
  /** The painting operation and its own block; null when the walk was not trusted. */
  top: TopOp | null;
  unit: Block | null;
  inner: Block | null;
  /** A picture the app placed (inside a block marked /PEImage: ImageInfo.added); false when the walk was not trusted. */
  added: boolean;
  /**
   * The EXIF orientation (1..8) that turned the stored pixels of a picture the app placed or put
   * in as a replacement (its picture object records it: pictureObject), so `matrix` (the stored
   * pixels') is concat(ORIENTATION[turn], the picture as seen). 1 for any other picture.
   */
  turn: number;
}

export interface PagePlacements {
  placements: Placement[];
  /** The page's content streams as walked (one string per /Contents entry). */
  texts: string[];
  /** The walk agreed with MuPDF's device pass (false: every placement is locked "unreadable"). */
  agreed: boolean;
}

/**
 * For each walked placement, in order, the next image MuPDF draws at its matrix: indices into
 * `drawn`, or null when one has none (the walk read something MuPDF does not draw, or reads
 * differently). Images MuPDF draws that no placement matches are skipped: the cells of a pattern
 * fill smaller than one cell come without beginTile.
 */
function matchDrawn(walked: Walked[], drawn: Drawn[]): number[] | null {
  const out: number[] = [];
  let j = 0;
  for (const w of walked) {
    const q = concat(FLIP, w.P);
    while (j < drawn.length && !nearlyEqual(q, drawn[j].matrix)) j++;
    if (j === drawn.length) return null;
    out.push(j++);
  }
  return out;
}

/**
 * The image placements of a page, in painting order: the walk, checked against the device pass.
 * When they disagree (or the content cannot be read, or is beyond the walk's caps), the images
 * are listed as MuPDF draws them (MAX_PLACEMENTS at most), all locked with reason "unreadable".
 */
export function findPlacements(mupdf: MuPDFModule, page: MuPDF.PDFPage): PagePlacements {
  const { drawn, count } = devicePass(mupdf, page);
  let walk: WalkResult | null = null;
  try {
    walk = walkPage(page);
  } catch {
    walk = null;
  }
  let matched = walk && count <= MAX_DRAWN ? matchDrawn(walk.walked, drawn) : null;
  // Images MuPDF draws that are not placements only come from patterns and Type 3 glyphs: on any
  // other page they mean the walk missed something, and its blocks cannot be trusted.
  if (matched && walk && matched.length < drawn.length && !walk.extraDraws) matched = null;
  const match = matched;
  if (!walk || !match) {
    const placements = drawn.slice(0, MAX_PLACEMENTS).map((d, index): Placement => ({
      index, kind: "xobject", matrix: d.matrix, bbox: bboxOf(quadOf(d.matrix)), visible: d.visible,
      pixelWidth: d.width, pixelHeight: d.height, movable: false, reason: "unreadable", drawIndex: index,
      mcid: null, mcidHost: null, alone: false, layers: [], inside: [], top: null, unit: null, inner: null, added: false, turn: 1,
    }));
    return { placements, texts: walk?.texts ?? [], agreed: false };
  }
  const placements = walk.walked.map((w, index): Placement => {
    const matrix = concat(FLIP, w.P), quad = quadOf(matrix), bbox = bboxOf(quad), d = drawn[match[index]];
    // Clips and soft masks set inside the edited block (or inside the form being moved) move with it.
    const inside = (depth: number, level: number) => (w.unit ? depth >= w.unit.depth : level > 0);
    const moving: Clip[] = [];
    let node = w.clips;
    for (; node && inside(node.clip.depth, node.clip.level); node = node.prev) moving.unshift(node.clip);
    let reason: ImageLockReason | null = null;
    if (Math.abs(det(w.P)) < 1e-9) reason = "unreadable"; // drawn with no area: nothing to move
    else if (w.group) reason = "group";
    else if (w.smaskDepth >= 0 && !inside(w.smaskDepth, w.smaskLevel)) reason = "soft-mask";
    else {
      // The clips below the moving ones were set outside: those that crop the picture as a frame lock it.
      for (; node && reason === null; node = node.prev) if (cropsAsFrame(node.clip, quad, bbox)) reason = "cropped";
    }
    return {
      index, kind: w.kind, matrix, bbox, visible: d.visible, pixelWidth: d.width, pixelHeight: d.height,
      movable: reason === null, reason, drawIndex: match[index], mcid: w.mark?.mcid ?? null, mcidHost: w.mark?.host ?? null,
      alone: w.mark?.paints === 1, layers: w.layers, inside: moving, top: w.top, unit: w.unit, inner: w.inner, added: w.added, turn: w.turn,
    };
  });
  return { placements, texts: walk.texts, agreed: true };
}

// ---------------------------------------------------------------------------------------------
// Edits

/**
 * Writes `text` in place of /Contents entry `index` of the page: into the same stream object, or,
 * when another page draws that stream too (or this page draws it twice), into a new one.
 */
export function writeStream(mupdf: MuPDFModule, doc: Doc, pageObj: Obj, index: number, text: string) {
  const c = pageObj.get("Contents");
  const old = c.isArray() ? c.get(index) : c;
  if (old.isIndirect() && old.isStream() && !sharedStream(doc, old.asIndirect())) {
    // Overwritten: a new object for every edit would leave a dead copy of the page's content in
    // the working document and in every checkpoint (the download drops them, snapshots do not).
    const buf = new mupdf.Buffer(toBytes(text));
    try {
      old.writeStream(buf);
    } finally {
      buf.destroy();
    }
    return;
  }
  const fresh = addStream(mupdf, doc, toBytes(text));
  if (c.isArray()) {
    // A new array too: the old one may be shared with another page.
    const arr = doc.newArray();
    for (let k = 0; k < c.length; k++) arr.push(k === index ? fresh : c.get(k));
    pageObj.put("Contents", arr);
  } else pageObj.put("Contents", fresh);
}

/** Whether content stream `num` is drawn more than once: by two pages, or twice by one. */
function sharedStream(doc: Doc, num: number): boolean {
  let uses = 0;
  for (let k = 0, n = doc.countPages(); k < n && uses < 2; k++) {
    const c = doc.findPage(k).get("Contents");
    if (c.isArray()) {
      for (let i = 0; i < c.length; i++) if (c.get(i).asIndirect() === num) uses++;
    } else if (c.asIndirect() === num) uses++;
  }
  return uses > 1;
}

/**
 * `s` with bytes start..end replaced by `insert`, kept apart from its neighbours by a space where
 * no whitespace does it already (so that replacing again and again does not pile spaces up).
 */
export function splice(s: string, start: number, end: number, insert: string): string {
  const spaceBefore = start > 0 && !WS[s.charCodeAt(start - 1)], spaceAfter = end < s.length && !WS[s.charCodeAt(end)];
  if (!insert) return s.slice(0, start) + (spaceBefore && spaceAfter ? " " : "") + s.slice(end);
  return s.slice(0, start) + (spaceBefore ? " " : "") + insert + (spaceAfter ? " " : "") + s.slice(end);
}

function editable(p: Placement): asserts p is Placement & { top: TopOp } {
  if (!p.movable || !p.top) throw new Error(`Image ${p.index} cannot be changed (${p.reason})`);
}

/** Moves, resizes or rotates placement `p` so that it is drawn at `target` (ImageInfo convention). */
export function transformPlacement(mupdf: MuPDFModule, doc: Doc, page: MuPDF.PDFPage, found: PagePlacements, p: Placement, target: Matrix) {
  editable(p);
  const P = concat(FLIP, p.matrix), Pt = concat(FLIP, target);
  let out: string, stream: number;
  if (p.unit) {
    const { X, qEnd } = p.unit;
    stream = p.unit.stream;
    const s = found.texts[stream];
    const M = between(X, P, Pt);
    // A block that starts with "q a b c d e f cm" takes M into that cm: repeated moves do not grow it.
    const first = operations(s, qEnd).next().value;
    if (first && first.op === "cm" && isNumeric(first.args, 6))
      out = s.slice(0, qEnd) + " " + fmtMatrix(concat(numbersOf(first.args) as Matrix, M)) + " cm" + s.slice(first.end);
    else out = s.slice(0, qEnd) + " " + fmtMatrix(M) + " cm" + s.slice(qEnd);
  } else {
    stream = p.top.stream;
    const s = found.texts[stream];
    const M = between(p.top.X, P, Pt);
    out = s.slice(0, p.top.start) + " q " + fmtMatrix(M) + " cm " + s.slice(p.top.start, p.top.end) + " Q " + s.slice(p.top.end);
  }
  writeStream(mupdf, doc, page.getObject(), stream, out);
}

/**
 * Removes placement `p`: only its painting operator, so q/Q and marked content stay balanced. Its
 * picture leaves the page's resources when the page no longer draws it, and the other
 * dictionaries that list it when nothing drawing with them does (dropUnusedNames); the structure
 * element of its marked content may lose the description of the picture (/Alt, /ActualText:
 * forgetDescription).
 */
export function deletePlacement(mupdf: MuPDFModule, doc: Doc, page: MuPDF.PDFPage, found: PagePlacements, p: Placement) {
  editable(p);
  const { stream, start, end } = p.top;
  const pageObj = page.getObject();
  const texts = found.texts.slice();
  texts[stream] = splice(texts[stream], start, end, "");
  writeStream(mupdf, doc, pageObj, stream, texts[stream]);
  dropUnusedNames(doc, pageObj, texts);
  forgetDescription(doc, pageObj, p);
}

/**
 * Replaces placement `p` with `image` (read from the file `bytes`): fitted inside the part of the
 * old picture that showed (its box within the clips that move with it), keeping its own
 * proportions, centred, along the old box's axes (so with the same rotation), and never mirrored
 * (unmirrored). The image becomes an XObject in the page's own /Resources, under a name not used
 * there yet (PEImg1, PEImg2...); other placements of the old picture stay as they are, and the old
 * picture leaves the page's resources, and the other dictionaries that list it, when nothing
 * draws it any more (dropUnusedNames). Returns where the new picture is drawn.
 *
 * It is drawn as "q K cm /PEImgN Do Q", in place of the painting operation, or of the innermost
 * block around it when that block holds only a cm and the operation (so that a second replace
 * takes the place of the first instead of nesting inside it). A form's own clips (its /BBox and
 * those set inside it) would go with the form: they are written again around the new picture.
 *
 * `orientation` is the picture's EXIF orientation (Picture.orientation): the fit is made for the
 * picture as it is meant to be seen, and its stored pixels are drawn turned (ORIENTATION), so a
 * photo stored sideways shows upright. The matrix returned is then the stored pixels' one, what
 * images() lists for the new picture. The old picture is taken as seen too: when it was itself
 * turned by its EXIF orientation (Placement.turn: a photo the app placed or put in before), that
 * turn is taken out of its matrix first, so the new picture is not drawn a quarter turn off.
 */
export function replacePlacement(
  mupdf: MuPDFModule, doc: Doc, page: MuPDF.PDFPage, found: PagePlacements, p: Placement, image: MuPDF.Image, bytes: Uint8Array,
  orientation = 1,
): Matrix {
  editable(p);
  const pageObj = page.getObject();
  const xobjects = ownXObjects(doc, pageObj);
  let k = 1, name: string;
  do name = `PEImg${k++}`;
  while (!xobjects.get(name).isNull());
  xobjects.put(name, pictureObject(doc, image, bytes, layerOf(doc, p.layers), orientation));

  const turned = orientation >= 5 && orientation <= 8;
  const [w, h] = turned ? [image.getHeight(), image.getWidth()] : [image.getWidth(), image.getHeight()];
  // (the old turn maps the unit square onto itself: the box is the same, its corners named as seen)
  const seen = concat(invert(ORIENTATION[p.turn] ?? IDENTITY), concat(visiblePart(p), p.matrix));
  const target = concat(ORIENTATION[orientation] ?? IDENTITY, unmirrored(containFit(seen, w, h)));
  const { stream } = p.top;
  const s = found.texts[stream], slot = slotOf(s, p);
  const K = concat(concat(FLIP, target), invert(slot.X)); // in the user space of the slot
  const picture = `q ${fmtMatrix(K)} cm /${name} Do Q`;
  const clips = p.kind === "form" ? p.inside.filter((c) => c.level > 0).map((c) => clipIn(c, slot.X)).filter(Boolean) : [];
  const texts = found.texts.slice();
  texts[stream] = splice(s, slot.start, slot.end, clips.length ? `q ${clips.join(" ")} ${picture} Q` : picture);
  writeStream(mupdf, doc, pageObj, stream, texts[stream]);
  dropUnusedNames(doc, pageObj, texts, xobjects);
  forgetDescription(doc, pageObj, p);
  return target;
}

/**
 * The part of placement `p`'s unit square (ImageInfo convention) that shows: the square within
 * the clips that move with it, each taken by its bounding box along the picture's axes. As a
 * matrix from the unit square onto that part; the whole square when nothing is left of it.
 */
function visiblePart(p: Placement): Matrix {
  let part: Rect = [0, 0, 1, 1];
  const toUnit = invert(p.matrix);
  for (const c of p.inside) {
    const points = c.poly ?? (c.rect ? cornersOf(c.rect) : null);
    if (points) part = intersect(part, bboxOf(points.map(([x, y]) => applyTo(toUnit, x, y))));
  }
  const [u0, v0, u1, v1] = part;
  return u1 - u0 > 1e-6 && v1 - v0 > 1e-6 ? [u1 - u0, 0, 0, v1 - v0, u0, v0] : IDENTITY;
}

/**
 * Where a replacement goes in content `s`: the innermost q..Q block around `p`'s painting
 * operation when it holds only "a b c d e f cm" and that operation (as many producers write a
 * picture, and as a replacement leaves it), else the operation alone. X is the CTM there.
 */
function slotOf(s: string, p: Placement & { top: TopOp }): { start: number; end: number; X: Matrix } {
  const b = p.inner;
  if (b && b.end !== undefined && b.stream === p.top.stream) {
    const ops = operations(s, b.qEnd);
    const cm = ops.next().value, op = ops.next().value, close = ops.next().value;
    if (cm && cm.op === "cm" && isNumeric(cm.args, 6) && op && op.start === p.top.start && op.end === p.top.end && close && close.op === "Q" && close.end === b.end)
      return { start: b.qStart, end: b.end, X: b.X };
  }
  return { start: p.top.start, end: p.top.end, X: p.top.X };
}

/** How many numbers each path-construction operator takes. */
const PATH_OPERANDS: Record<string, number> = { m: 2, l: 2, c: 6, v: 4, y: 4, h: 0, re: 4 };

/**
 * A clip written again in the user space whose CTM is X: its path with every point mapped there
 * (a rectangle becomes four lines, as it may be turned), then "W n" or "W* n". A path this cannot
 * read, or text used as a clip, is written as its bounding box. Null when nothing is known of it.
 */
function clipIn(c: Clip, X: Matrix): string | null {
  const toX = invert(X);
  const fromPath = (path: ClipPath): string | null => {
    const rel = concat(path.ctm, toX);
    const pt = (x: number, y: number) => applyTo(rel, x, y).map(num).join(" ");
    const out: string[] = [];
    for (const o of operations(path.text)) {
      if (!o.args.every((a) => a.num !== undefined)) return null;
      const v = numbersOf(o.args);
      const operands = PATH_OPERANDS[o.op];
      if (operands === undefined || v.length !== operands) return null;
      if (o.op === "re") {
        const [x, y, w, h] = v;
        out.push(`${pt(x, y)} m ${pt(x + w, y)} l ${pt(x + w, y + h)} l ${pt(x, y + h)} l h`);
      } else {
        const coords: string[] = [];
        for (let k = 0; k < v.length; k += 2) coords.push(pt(v[k], v[k + 1]));
        out.push([...coords, o.op].join(" "));
      }
    }
    return out.length ? `${out.join(" ")} ${path.evenOdd ? "W*" : "W"} n` : null;
  };
  const written = c.path ? fromPath(c.path) : null;
  if (written) return written;
  if (!c.rect) return null;
  const [a, b, d, e] = cornersOf(c.rect).map(([x, y]) => applyTo(toX, x, y).map(num).join(" "));
  return `${a} m ${b} l ${d} l ${e} l h W n`;
}

/** Pictures added as replacements, per document: found again by their bytes, so that one picture put in many places is embedded once. */
const added = new WeakMap<Doc, Map<string, { bytes: Uint8Array; num: number }[]>>();

/**
 * The key of an image XObject the app made (pictureObject) that records the EXIF orientation
 * (2..8) its placements turn the stored pixels by: the pixels say nothing of it once the JPEG has
 * lost its metadata, and a replace must take the turn out to fit the new picture as seen
 * (Placement.turn). Readers ignore a key they do not know.
 */
const TURN_KEY = "PEOrientation";

/**
 * The EXIF orientation an image XObject records (TURN_KEY), 1 when it records none. Two image
 * objects with the same bytes but another orientation are not the same picture to place.
 */
export function turnOf(xo: Obj): number {
  const v = xo.get(TURN_KEY);
  const o = v.isNumber() ? v.asNumber() : 1;
  return Number.isInteger(o) && o >= 1 && o <= 8 ? o : 1;
}

/**
 * The image XObject of a replacement picture: the one added before for the same bytes, the same
 * layer and the same EXIF `orientation`, or a new one. MuPDF backs pictures without a colour
 * profile with its own (Artifex's) profiles, which the app does not ship (see icc.ts): those get
 * the device colour space instead. `layer` becomes its /OC, and an orientation other than 1 is
 * recorded in it (TURN_KEY).
 */
export function pictureObject(doc: Doc, image: MuPDF.Image, bytes: Uint8Array, layer: Obj | null, orientation = 1): Obj {
  const reusable = !layer || layer.isIndirect();
  const turn = Number.isInteger(orientation) && orientation >= 2 && orientation <= 8 ? orientation : 1;
  const key = `${bytes.length}:${hashOf(bytes)}:${layer ? layer.asIndirect() : 0}:${turn}`;
  let seen = added.get(doc);
  if (!seen) added.set(doc, (seen = new Map()));
  if (reusable)
    for (const known of seen.get(key) ?? []) {
      // (still that picture: an object number freed by an edit could have been given to another)
      const obj = doc.newIndirect(known.num), size = (key: string) => obj.get(key).asNumber();
      if (sameBytes(known.bytes, bytes) && obj.isStream() && nameOf(obj.get("Subtype")) === "Image"
        && size("Width") === image.getWidth() && size("Height") === image.getHeight() && turnOf(obj) === turn) return obj;
    }
  const obj = doc.addImage(image); // a JPEG stays as it is (DCTDecode)
  const own = embedsProfile(bytes);
  for (const target of [obj, obj.get("SMask")]) {
    if (!target.isStream()) continue;
    const device = deviceSpace(target.get("ColorSpace"), own === null);
    if (device && own !== true) target.put("ColorSpace", doc.newName(device));
  }
  if (layer) obj.put("OC", layer);
  if (turn !== 1) obj.put(TURN_KEY, turn);
  if (reusable) seen.set(key, [...(seen.get(key) ?? []), { bytes, num: obj.asIndirect() }]);
  return obj;
}

const DEVICE_SPACES: Record<number, string> = { 1: "DeviceGray", 3: "DeviceRGB", 4: "DeviceCMYK" };

/**
 * The device colour space for an /ICCBased colour space (by its number of components), or null.
 * With `onlyMuPDFs`, only for MuPDF's own profiles (their description names Artifex): the file's
 * format was not read, so a profile of its own may be in it.
 */
function deviceSpace(cs: Obj, onlyMuPDFs: boolean): string | null {
  if (!cs.isArray() || cs.length !== 2 || nameOf(cs.get(0)) !== "ICCBased") return null;
  const profile = cs.get(1);
  if (!profile.isStream()) return null;
  if (onlyMuPDFs && !latin1(streamBytes(profile)).includes("Artifex")) return null;
  return DEVICE_SPACES[profile.get("N").asNumber()] ?? null;
}

/**
 * The /OC a replacement picture needs to show and hide as the old one did: the layer of the image
 * or of a form it was drawn in, or, with several, an optional-content membership dictionary that
 * shows it only when all of them do. Null when there is none.
 */
function layerOf(doc: Doc, layers: Obj[]): Obj | null {
  if (layers.length <= 1) return layers[0] ?? null;
  const isMembership = (oc: Obj) => nameOf(oc.get("Type")) === "OCMD";
  // Groups, and memberships that need all their groups on: one /OCGs list with /P /AllOn (PDF
  // 1.5), the form readers know best. (MuPDF 1.27 applies neither that nor visibility expressions:
  // in the app, where every layer is shown, that changes nothing.)
  const groups: Obj[] = [];
  const allOn = layers.every((oc) => {
    if (!isMembership(oc)) return groups.push(oc) > 0;
    const listed = oc.get("OCGs"), policy = nameOf(oc.get("P")) ?? "AnyOn";
    if (oc.get("VE").isArray()) return false;
    if (listed.isDictionary()) return groups.push(listed) > 0; // one group: AnyOn and AllOn agree
    if (!listed.isArray() || (policy !== "AllOn" && !(listed.length === 1 && policy === "AnyOn"))) return false;
    for (let k = 0; k < listed.length; k++) groups.push(listed.get(k));
    return true;
  });
  const ocmd = doc.newDictionary();
  ocmd.put("Type", doc.newName("OCMD"));
  if (allOn) {
    const list = doc.newArray();
    for (const g of groups) list.push(g);
    ocmd.put("OCGs", list);
    ocmd.put("P", doc.newName("AllOn"));
    return doc.addObject(ocmd);
  }
  // Otherwise a visibility expression (PDF 1.6): a group is itself, a membership dictionary its
  // /VE or the expression its /OCGs and /P stand for.
  const expressions = layers.map((oc) => {
    if (nameOf(oc.get("Type")) !== "OCMD") return oc;
    if (oc.get("VE").isArray()) return oc.get("VE");
    const groups = oc.get("OCGs");
    const list = doc.newArray();
    if (groups.isArray()) for (let k = 0; k < groups.length; k++) list.push(groups.get(k));
    else if (groups.isDictionary()) list.push(groups);
    const policy = nameOf(oc.get("P")) ?? "AnyOn";
    const all = policy === "AllOn" || policy === "AnyOff";
    const ve = doc.newArray();
    ve.push(doc.newName(all ? "And" : "Or"));
    for (let k = 0; k < list.length; k++) ve.push(list.get(k));
    if (policy !== "AllOff" && policy !== "AnyOff") return ve;
    const not = doc.newArray();
    not.push(doc.newName("Not"));
    not.push(ve);
    return not;
  });
  const ve = doc.newArray();
  ve.push(doc.newName("And"));
  for (const e of expressions) ve.push(e);
  ocmd.put("VE", ve);
  return doc.addObject(ocmd);
}

/**
 * The page's /XObject dictionary, made its own first: the page gets a shallow copy of its
 * /Resources (inherited or shared with other pages: many producers give every page the same
 * dictionary) holding a shallow copy of /XObject, so that adding or removing a name changes no
 * other page or form.
 */
export function ownXObjects(doc: Doc, pageObj: Obj): Obj {
  const current = pageObj.getInheritable("Resources");
  const res = doc.newDictionary(), xobjects = doc.newDictionary();
  if (current.isDictionary()) current.forEach((v, k) => { if (k !== "XObject") res.put(k, v); });
  const old = lookup(current, "XObject");
  if (old.isDictionary()) old.forEach((v, k) => xobjects.put(k, v));
  res.put("XObject", xobjects);
  pageObj.put("Resources", res);
  return xobjects;
}

/** The same object: the same indirect object, or the same direct one in memory (as pdfa.ts compares them). */
const identity = (o: Obj) => (o.isIndirect() ? `n${o.asIndirect()}` : `p${o.pointer}`);

function keysOf(dict: Obj): string[] {
  const keys: string[] = [];
  dict.forEach((_v, k) => keys.push(String(k)));
  return keys;
}

/** Content the cleanup cannot read with certainty: nothing more is pruned for that edit (the edit is made all the same). */
class Unsure extends Error {}

/** Most content-stream operations the cleanup reads for one edit. */
const MAX_CLEANUP_OPERATIONS = 4_000_000;
/** Most resource dictionaries, forms, patterns, Type 3 fonts, appearances and page tree nodes the cleanup looks through for one edit. */
const MAX_CLEANUP_OBJECTS = 200_000;

/**
 * Reads the XObject names that content draws (the operands of its Do operators) for the cleanup,
 * each stream once however many pages or forms draw it. Throws Unsure for a stream MuPDF cannot
 * decode, and past MAX_CLEANUP_OPERATIONS.
 */
function namesReader() {
  const cache = new Map<string, Set<string>>();
  let operationsRead = 0;
  const read = (s: string) => {
    const names = new Set<string>();
    for (const o of operations(s)) {
      if (++operationsRead > MAX_CLEANUP_OPERATIONS) throw new Unsure();
      const name = o.op === "Do" ? o.args[0]?.name : undefined;
      if (name !== undefined) names.add(name);
    }
    return names;
  };
  return {
    text: read,
    stream(stream: Obj): Set<string> {
      const id = identity(stream);
      let names = cache.get(id);
      if (!names) {
        let s: string;
        try {
          s = latin1(streamBytes(stream));
        } catch {
          throw new Unsure(); // a filter or /DecodeParms MuPDF refuses: what it draws is not known
        }
        cache.set(id, (names = read(s)));
      }
      return names;
    },
  };
}
type NamesReader = ReturnType<typeof namesReader>;

/** An annotation's appearance streams: normal, rollover and down, each a stream or one per state. */
function appearances(annot: Obj): Obj[] {
  const out: Obj[] = [];
  for (const k of ["N", "R", "D"]) {
    const ap = lookup(annot, "AP", k);
    if (ap.isStream()) out.push(ap);
    else ap.forEach((state) => { if (state.isStream()) out.push(state); });
  }
  return out;
}

/**
 * The XObject names drawn with `resources`: by `contents` (the content of a page, or of a form,
 * pattern, Type 3 font or appearance whose /Resources these are; as text or as streams) and by
 * the content that uses the same resources because it has none of its own: the forms it draws,
 * Type 3 glyphs, patterns, soft-mask groups, and the appearances of `annots`. Throws Unsure when
 * some of it cannot be read, or draws a name that is not a key of the resources' /XObject: the
 * cleanup would then not see what MuPDF draws.
 */
function drawnWith(read: NamesReader, resources: Obj, contents: (string | Obj)[], annots: Obj | null): Set<string> {
  const drawn = new Set<string>(), seen = new Set<string>();
  const xobjects = lookup(resources, "XObject");
  /** Content that uses these resources because it has none of its own, still to read (each once). */
  const pending: Obj[] = [];
  const using = (stream: Obj) => {
    if (!stream.isStream() || stream.get("Resources").isDictionary()) return;
    const id = identity(stream);
    if (seen.has(id)) return;
    seen.add(id);
    pending.push(stream);
  };
  const add = (names: Set<string>) => {
    for (const name of names) {
      if (drawn.has(name)) continue;
      const xo = lookup(xobjects, name);
      if (xo.isNull()) throw new Unsure();
      drawn.add(name);
      if (xo.isStream() && nameOf(xo.get("Subtype")) === "Form") using(xo);
    }
  };
  for (const c of contents) add(typeof c === "string" ? read.text(c) : read.stream(c));
  // (forEach on the null object does nothing)
  lookup(resources, "Font").forEach((font) => {
    if (nameOf(lookup(font, "Subtype")) !== "Type3" || lookup(font, "Resources").isDictionary()) return;
    lookup(font, "CharProcs").forEach(using);
  });
  lookup(resources, "Pattern").forEach(using);
  lookup(resources, "ExtGState").forEach((eg) => using(lookup(eg, "SMask", "G")));
  annots?.forEach((annot) => appearances(annot).forEach(using));
  while (pending.length) add(read.stream(pending.pop()!));
  return drawn;
}

/** Content that draws with one resources dictionary: a page (with its annotations' appearances), or a form, pattern, Type 3 font or appearance whose own /Resources it is. */
interface ResourceUser {
  resources: Obj;
  contents: Obj[];
  annots: Obj | null;
}

/** An XObject dictionary of the document that lists some of the pictures an edit took off a page. */
interface Listing {
  xobjects: Obj;
  /** Its names for those pictures. */
  names: string[];
  /** What draws with it. */
  users: ResourceUser[];
  /** Something draws with it that the cleanup cannot read (the form fields' default resources). */
  unknown: boolean;
}

/**
 * The XObject dictionaries of the document that list any of the objects `gone` (by object
 * number), with what draws with each: every /Resources reachable from the pages (inherited ones
 * included), the page tree's own (inherited by no page any more, they are still in the file),
 * those of the forms, patterns, Type 3 fonts, soft-mask groups and annotation appearances found
 * in them, and the form fields' default resources (/AcroForm /DR, whose use is not known). Each
 * dictionary is looked through once. Throws Unsure past MAX_CLEANUP_OBJECTS.
 */
function listings(doc: Doc, gone: Set<number>): Listing[] {
  const byDict = new Map<string, Listing>();
  const seen = new Set<string>();
  const first = (o: Obj) => {
    const id = identity(o);
    if (seen.has(id)) return false;
    if (seen.size >= MAX_CLEANUP_OBJECTS) throw new Unsure();
    seen.add(id);
    return true;
  };
  /** The listing of the /XObject of `res`, made when first seen (null: none, or one that lists nothing gone). */
  const listingOf = (res: Obj): Listing | null => {
    const xobjects = lookup(res, "XObject");
    if (!xobjects.isDictionary()) return null;
    const id = identity(xobjects);
    let listing = byDict.get(id);
    if (!listing) {
      const names: string[] = [];
      xobjects.forEach((v, k) => { if (v.isIndirect() && gone.has(v.asIndirect())) names.push(String(k)); });
      byDict.set(id, (listing = { xobjects, names, users: [], unknown: false }));
    }
    return listing.names.length ? listing : null;
  };
  /** Resources dictionaries still to look through. */
  const pending: Obj[] = [];
  /** A form, pattern, Type 3 font or appearance: its own resources, when it has some, are a user's and are looked through. */
  const holder = (obj: Obj, contents: () => Obj[]) => {
    const res = obj.get("Resources");
    if (!res.isDictionary() || !first(obj)) return;
    listingOf(res)?.users.push({ resources: res, contents: contents(), annots: null });
    pending.push(res);
  };
  const lookThrough = (res: Obj) => {
    if (!res.isDictionary() || !first(res)) return;
    listingOf(res);
    lookup(res, "XObject").forEach((xo) => { if (xo.isStream() && nameOf(xo.get("Subtype")) === "Form") holder(xo, () => [xo]); });
    lookup(res, "Pattern").forEach((pattern) => { if (pattern.isStream()) holder(pattern, () => [pattern]); });
    lookup(res, "Font").forEach((font) => {
      if (nameOf(lookup(font, "Subtype")) !== "Type3") return;
      holder(font, () => {
        const procs: Obj[] = [];
        lookup(font, "CharProcs").forEach((proc) => { if (proc.isStream()) procs.push(proc); });
        return procs;
      });
    });
    lookup(res, "ExtGState").forEach((eg) => {
      const group = lookup(eg, "SMask", "G");
      if (group.isStream()) holder(group, () => [group]);
    });
  };
  const drain = () => { while (pending.length) lookThrough(pending.pop()!); };
  for (let k = 0, n = doc.countPages(); k < n; k++) {
    const pageObj = doc.findPage(k);
    const res = pageObj.getInheritable("Resources"), annots = pageObj.get("Annots");
    listingOf(res)?.users.push({ resources: res, contents: contentStreams(pageObj), annots });
    pending.push(res);
    annots.forEach((annot) => appearances(annot).forEach((ap) => holder(ap, () => [ap])));
    for (let node = pageObj.get("Parent"), up = 0; node.isDictionary() && up < 64 && first(node); node = node.get("Parent"), up++)
      pending.push(node.get("Resources"));
    drain();
  }
  const fields = doc.getTrailer().get("Root", "AcroForm", "DR");
  const listed = listingOf(fields);
  if (listed) listed.unknown = true;
  pending.push(fields);
  drain();
  return [...byDict.values()].filter((l) => l.names.length);
}

/**
 * Pictures the edit took off a page (the objects `gone`) may still be listed elsewhere: in the
 * /Resources the page shared with other pages (FPDF and TCPDF write one for all), inherited from
 * the page tree, given to a form as its /Resources, or left to the other pages when a text edit
 * gave this one resources of its own. Each such name leaves its dictionary when nothing that
 * draws with that dictionary draws it; one that something draws stays, and so does the picture.
 * Throws Unsure, before removing anything, when what one of them draws is not known for sure.
 */
function pruneElsewhere(doc: Doc, gone: Set<number>, read: NamesReader) {
  const prune: [Obj, string[]][] = [];
  for (const listing of listings(doc, gone)) {
    if (listing.unknown) continue;
    const left = new Set(listing.names);
    for (const user of listing.users) {
      for (const name of drawnWith(read, user.resources, user.contents, user.annots)) left.delete(name);
      if (!left.size) break;
    }
    if (left.size) prune.push([listing.xobjects, [...left]]);
  }
  for (const [xobjects, names] of prune) for (const name of names) xobjects.delete(name);
}

/**
 * After a delete or a replace: the XObject names that nothing of the page draws any more (any
 * name: the one of the operation removed, those a form drew that went with it...) leave its
 * resources, in a copy of its own (see ownXObjects; `own` when a replace made it already), and
 * the dictionaries elsewhere in the document that list the same pictures lose them too when what
 * draws with them does not draw them (pruneElsewhere), so the pictures are not carried into the
 * saved file unless something draws them. What the page draws: its content (`texts`, as edited),
 * and the content that uses the page's resources because it has none of its own (drawnWith).
 * When some content cannot be read, or draws a name the resources do not have, nothing more is
 * pruned: the edit is made all the same.
 */
function dropUnusedNames(doc: Doc, pageObj: Obj, texts: string[], own?: Obj) {
  try {
    const resources = pageObj.getInheritable("Resources"), xobjects = lookup(resources, "XObject");
    const read = namesReader();
    const drawn = drawnWith(read, resources, texts, pageObj.get("Annots"));
    const unused = keysOf(xobjects).filter((n) => !drawn.has(n));
    if (!unused.length) return;
    const gone = new Set<number>();
    for (const n of unused) {
      const v = xobjects.get(n);
      if (v.isIndirect()) gone.add(v.asIndirect());
    }
    const mine = own ?? ownXObjects(doc, pageObj);
    for (const n of unused) mine.delete(n);
    if (gone.size) pruneElsewhere(doc, gone, read);
  } catch (err) {
    if (!(err instanceof Unsure)) throw err;
  }
}

/** Structure types whose /Alt and /ActualText describe a picture (ISO 32000-1, 14.8.4.5). */
const PICTURE_TYPES = new Set(["Figure", "Formula"]);

/**
 * The description of a removed or replaced picture leaves its structure element (tagged PDFs):
 * the element that owns its marked content (found through /StructParents and the ParentTree)
 * loses /Alt and /ActualText, which described the old picture, when it is a Figure or a Formula
 * (by its own type or, for a custom one, the type the RoleMap gives it), or when the picture was
 * all it held (its marked-content sequence painted nothing else, and the element has no other
 * content). Any other element keeps them: a paragraph with an inline icon has them for its text
 * too. Nothing happens when the file has no structure tree or it cannot be read.
 */
function forgetDescription(doc: Doc, pageObj: Obj, p: Placement) {
  if (p.mcid === null) return;
  try {
    const parents = structParents(doc, p.mcidHost ?? pageObj);
    const owner = parents ? parents.get(p.mcid) : null;
    if (!owner || !owner.isDictionary()) return;
    if (!isPictureElement(doc, owner) && !(p.alone && holdsOnly(owner, p.mcid))) return;
    owner.delete("Alt");
    owner.delete("ActualText");
  } catch {
    // a structure tree that cannot be read: the picture is changed all the same
  }
}

/** Whether a structure element is a Figure or a Formula, by its type or the RoleMap's. */
function isPictureElement(doc: Doc, element: Obj): boolean {
  const roles = doc.getTrailer().get("Root", "StructTreeRoot", "RoleMap");
  let type = nameOf(element.get("S"));
  for (let k = 0; type !== null && k < 16; k++) {
    if (PICTURE_TYPES.has(type)) return true;
    type = nameOf(lookup(roles, type));
  }
  return false;
}

/** Whether a structure element's content (/K) is marked-content sequence `mcid` alone. */
function holdsOnly(element: Obj, mcid: number): boolean {
  let kid = element.get("K");
  if (kid.isArray()) {
    if (kid.length !== 1) return false;
    kid = kid.get(0);
  }
  if (kid.isNumber()) return kid.asNumber() === mcid;
  // A marked-content reference (/Type /MCR, which may be left out): no structure element, no object reference.
  if (!kid.isDictionary() || kid.get("S").isName() || !kid.get("Obj").isNull()) return false;
  const ref = kid.get("MCID");
  return ref.isNumber() && ref.asNumber() === mcid;
}

// ---------------------------------------------------------------------------------------------
// The sprite (the picture alone, for the preview while it is dragged)

/** A rect of no area: what a clip costs that holds no memory. */
const EMPTY: Rect = [0, 0, 0, 0];

/**
 * Whether a path is one rectangle with its sides along the device's axes: MuPDF's draw device
 * clips to such a path by narrowing its scissor, holding no memory for it.
 */
function isGridRectangle(path: MuPDF.Path, ctm: Matrix): boolean {
  const points: Point[] = [];
  let moves = 0, curves = 0;
  // (called back from MuPDF: nothing in these can throw)
  path.walk({
    moveTo(x, y) { moves++; points.push(applyTo(ctm, x, y)); },
    lineTo(x, y) { points.push(applyTo(ctm, x, y)); },
    curveTo() { curves++; },
  });
  const close = (a: Point, b: Point) => Math.abs(a[0] - b[0]) < 0.01 && Math.abs(a[1] - b[1]) < 0.01;
  if (points.length === 5 && close(points[0], points[4])) points.pop();
  if (moves !== 1 || curves || points.length !== 4) return false;
  return points.every((a, k) => {
    const b = points[(k + 1) % 4];
    return Math.abs(a[0] - b[0]) < 0.01 || Math.abs(a[1] - b[1]) < 0.01;
  });
}

/**
 * The clips in effect around the image would hold more than MAX_SPRITE_CLIP_BYTES in the draw
 * device at the scale asked: `bytes` is what they would hold. They hold a fixed amount per pixel,
 * so the sprite fits at a scale lower by sqrt(MAX_SPRITE_CLIP_BYTES / bytes).
 */
export class SpriteClipBudget extends DevicePassError {
  constructor(readonly bytes: number) {
    super(`The clips around the image would take ${Math.ceil(bytes / 2 ** 20)} MB to draw it alone`);
  }
}

/**
 * Renders the `drawIndex`-th image MuPDF draws (Placement.drawIndex) alone, with the clips in
 * effect, on a transparent pixmap covering `box` (device pixels at `scale` pixels per point). Only
 * that image and the clips are forwarded from a JS device to a DrawDevice; images are counted the
 * way the device pass counts them. A clip that would take the clips held past
 * MAX_SPRITE_CLIP_BYTES is not forwarded, so the memory stays within it; if such a clip is still
 * in effect when the image comes, the image is not drawn and the pass ends with SpriteClipBudget
 * (clips set and ended elsewhere on the page do not matter). Anything MuPDF fails to draw ends it
 * with a DevicePassError. Both are thrown after the pass: nothing leaves a device callback. The
 * caller destroys the pixmap; its pixels are premultiplied (straightRGBA undoes that).
 */
export function renderPlacement(mupdf: MuPDFModule, page: MuPDF.PDFPage, drawIndex: number, scale: number, box: Rect): MuPDF.Pixmap {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, box, true);
  try {
    pix.clear(); // transparent (clear(0) would make it opaque black: a value clears to an opaque colour)
    const draw = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
    const g = guarded();
    /** What the clips in effect would have held when the image came, when that was too much (0: they fitted). */
    let over = 0;
    try {
      let n = -1, tile = 0, mask = 0;
      /** What the clips in effect that were forwarded hold in the draw device, and what all those in effect would hold. */
      let held = 0, wanted = 0;
      /** For each clip pushed: the bytes it would hold in the draw device (none in soft masks and pattern cells, which are not forwarded), and whether it was forwarded. */
      const pushed: { bytes: number; forwarded: boolean }[] = [];
      const counted = () => !tile && !mask && ++n === drawIndex;
      const clip = (bounds: () => Rect, forward: () => void, ...received: Received[]) => {
        const entry = g.attempt(() => {
          if (tile || mask) return { bytes: 0, forwarded: false };
          const r = intersect(bounds(), box);
          const bytes = (r[2] - r[0]) * (r[3] - r[1]) * CLIP_BYTES_PER_PIXEL;
          wanted += bytes;
          // Every clip in effect below this one was forwarded when `wanted` fits: so the image is
          // drawn with all its clips, or not at all.
          if (held + bytes > MAX_SPRITE_CLIP_BYTES) return { bytes, forwarded: false };
          forward();
          held += bytes;
          return { bytes, forwarded: true };
        }, ...received);
        pushed.push(entry ?? { bytes: 0, forwarded: false });
      };
      const image = (paint: () => void) => {
        if (!counted()) return;
        if (wanted > MAX_SPRITE_CLIP_BYTES) over = wanted; // a clip around it was left out
        else paint();
      };
      const fwd = new mupdf.Device({
        fillImage(img, ctm, alpha) { g.attempt(() => image(() => draw.fillImage(img, ctm, alpha)), img); },
        fillImageMask(img, ctm, cs, color, alpha) {
          g.attempt(() => image(() => draw.fillImageMask(img, ctm, cs, color as MuPDF.Color, alpha)), img, cs);
        },
        clipPath(path, evenOdd, ctm) {
          clip(() => (isGridRectangle(path, ctm as Matrix) ? EMPTY : path.getBounds(NO_STROKE, ctm) as Rect), () => draw.clipPath(path, evenOdd, ctm), path);
        },
        clipStrokePath(path, stroke, ctm) {
          clip(() => path.getBounds(stroke, ctm) as Rect, () => draw.clipStrokePath(path, stroke, ctm), path, stroke);
        },
        clipText(text, ctm) { clip(() => text.getBounds(NO_STROKE, ctm) as Rect, () => draw.clipText(text, ctm), text); },
        clipStrokeText(text, stroke, ctm) {
          clip(() => text.getBounds(stroke, ctm) as Rect, () => draw.clipStrokeText(text, stroke, ctm), text, stroke);
        },
        clipImageMask(img, ctm) { clip(() => bboxOf(quadOf(ctm as Matrix)), () => draw.clipImageMask(img, ctm), img); },
        beginMask(_area, _luminosity, cs) { g.attempt(() => {}, cs); pushed.push({ bytes: 0, forwarded: false }); mask++; },
        endMask() { mask--; },
        popClip() {
          const entry = pushed.pop();
          if (!entry) return;
          wanted -= entry.bytes;
          if (!entry.forwarded) return;
          held -= entry.bytes;
          g.attempt(() => draw.popClip());
        },
        beginTile() { tile++; return 0; },
        endTile() { tile--; },
      });
      try {
        page.runPageContents(fwd, mupdf.Matrix.scale(scale, scale));
        fwd.close();
      } finally {
        fwd.destroy();
      }
      if (!g.failed) draw.close(); // after a failure its clips are unbalanced: it is only destroyed
    } finally {
      draw.destroy();
    }
    g.check("The image could not be drawn alone");
    if (over) throw new SpriteClipBudget(over);
    return pix;
  } catch (err) {
    pix.destroy();
    throw err;
  }
}

/**
 * A pixmap with alpha as straight (not premultiplied) RGBA, which is what ImageData expects:
 * MuPDF's pixmaps with alpha are premultiplied, so a half-transparent red would otherwise come
 * out dark red.
 */
export function straightRGBA(pix: MuPDF.Pixmap): { width: number; height: number; rgba: Uint8ClampedArray<ArrayBuffer> } {
  const width = pix.getWidth(), height = pix.getHeight(), stride = pix.getStride(), src = pix.getPixels();
  if (pix.getNumberOfComponents() !== 4) throw new Error("Expected an RGB pixmap with alpha");
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0, s = y * stride, d = y * width * 4; x < width; x++, s += 4, d += 4) {
      const a = src[s + 3];
      rgba[d + 3] = a;
      if (a === 255) {
        rgba[d] = src[s];
        rgba[d + 1] = src[s + 1];
        rgba[d + 2] = src[s + 2];
      } else if (a > 0) {
        rgba[d] = Math.round((src[s] * 255) / a);
        rgba[d + 1] = Math.round((src[s + 1] * 255) / a);
        rgba[d + 2] = Math.round((src[s + 2] * 255) / a);
      }
    }
  }
  return { width, height, rgba };
}
