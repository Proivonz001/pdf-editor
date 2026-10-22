// Bianchetto and Oscura (release 5; ARCHITECTURE.md, release 5): what lies under
// areas of one or more pages really leaves the file, as one edit, and a box of the app's own
// marks where it was (white for Bianchetto, black for Oscura).
//
// MuPDF's redaction (a Redact annotation per rect, page.applyRedactions) does the core of it:
// text (every render mode, hidden layers, Form XObjects copied for this page), line art lying
// wholly inside a rect (REMOVE_IF_COVERED: a path crossing the edge stays, covered by the box), and
// for Oscura picture pixels (PIXELS: the picture becomes a new object, its pixels under the area
// white; one wholly under it is no longer drawn). On its own it leaves a lot in the file (research
// §redact, §critic), so around it, as part of the same edit:
// - Oscura removes, before loading the page for the redaction (MuPDF reads annotations then),
//   every annotation whose /Rect meets an area, whole: links, notes with their popups (named by the
//   note's /Popup or by the popup's /Parent, on another page too) and the replies to them (/IRT),
//   FreeText, highlights, form widgets (a field left without widgets leaves the form, its value
//   with it, a signature's with the document's /DSS, the signers' certificates and revocation
//   data: the save breaks every signature anyway; one with widgets elsewhere keeps its value
//   there: the report says so); they leave the structure tree too, and every reference left to
//   them is cut, so a garbage-collected save leaves them out. Bianchetto leaves annotations and
//   fields on top (said before applying), but a link MuPDF removed comes back unless it lay
//   wholly inside.
// - Pending Redact annotations the file already had sit out the call (under another /Subtype, as
//   core.replaceText does) and are put back as they were. A form without resources of its own (PDF
//   1.1: it draws with those of the content that draws it) has them as its own for the call:
//   MuPDF's copy of it would get its fonts alone, and lose its pictures, forms, graphics states,
//   patterns and shadings, outside the area too. A pattern, Type 3 font or soft mask's group
//   without resources of its own that names one is refused ("locked"): MuPDF does not copy those,
//   and the page's new resources list only what its content names.
// - New pictures (Oscura): MuPDF's colour profiles (Artifex's, which the app does not ship) become
//   device colour spaces; the soft mask, which MuPDF copies unchanged (a signature's shape would
//   survive in it), is cleared under the area (wholly for a picture MuPDF does not draw, a hidden
//   layer's: its matrix cannot be checked), and so is the one MuPDF makes of a /Mask (a stencil, or
//   a colour key, which then comes back as a key over the old picture's own samples, palette, bits
//   and /Decode; not over a JPEG's or JPX's, whose shapes keep a dark edge outside the area; a soft
//   mask of its own wins over a key); a picture drawn turned (not by right angles) takes the old
//   picture's samples (at their own bits: a bilevel scan's, a stencil's) and soft mask or stencil
//   /Mask again, cleared under the area: MuPDF whitens the area's bounds in
//   the picture's own space, wedges outside the area (but a Lab one's, whose white is not all ones);
//   /OC (a hidden picture stays hidden), /StructParent and the app's /PEOrientation come back from
//   the old picture; a picture that was a JPEG is a JPEG again (quality 85, grey, RGB or CMYK;
//   others stay lossless). Pictures are followed through the content walk
//   (images.walkedPictures: hidden layers too, which MuPDF clears as well). The store is emptied
//   afterwards (rule 6: MuPDF loaded these pictures before they were fixed).
// - Soft masks: MuPDF filters what is painted through a soft mask, not the mask's transparency
//   group, and keeps the gs that sets it, so text or a picture in the group (an opacity mask, an
//   image-in-text effect, a picture's shadow) would stay. Each group whose box meets the area where
//   it is set (images.walkedSoftMasks: in hidden layers too, and one nothing is painted through,
//   which MuPDF never runs) is redacted the same way, drawn as the page's content for a
//   moment, and a copy of the graphics state names the redacted copy. Refused ("locked") when what
//   a mask's group draws under the area is not found by the walk, or one graphics state is set
//   twice by the same content under different CTMs and its group draws something under the area
//   at one of them (one redacted group cannot serve both; drawn alone in a scratch document, every
//   layer showing); one whose group draws nothing there, a reused shadow, is left alone.
// - Descriptions: marked-content sequences are paired before and after, in order, each after with
//   every one before it can have been (MuPDF keeps every BDC and EMC but those of a sequence it
//   empties inside a text object, as Chrome writes around each ligature, and only takes glyphs out:
//   one alike that shows what it showed or part of it); one whose painting changed (its text, its
//   drawings, a picture replaced or under the area), or that can have been one that painted
//   otherwise (positions are not known here), loses /ActualText, /Alt and /E from its
//   property list, inline or named (a named one copied first: other pages may share it), and so
//   does the structure element of its MCID (through the ParentTree, every kid read; a form without
//   /StructParents marks that of the form drawing it that has them, or the page's, and the page's,
//   as readers may take it), with its /T, and every element above it
//   (their descriptions stood for it too); in the forms MuPDF copied too (it copies every form the
//   page draws, descriptions included; a picture under the area counts in the form that draws it),
//   and a copy that paints otherwise loses the original's /Metadata, /PieceInfo and /LastModified.
//   When the sequences cannot be paired, every one of that content loses them. A picture or form
//   tagged by an object reference (its own /StructParent) under the area loses its element's
//   descriptions; so do the elements of the annotations Oscura removes. Then the structure tree is
//   walked once (forgetByTree): an element whose /K names such marked content (by /Pg or an MCR) or
//   an object that left (an OBJR) loses them too, so a ParentTree that leaves them out, or an
//   annotation without /StructParent, hides none.
// - The structure tree keeps no original: an object reference (OBJR) or a marked-content reference
//   into a form (MCR /Stm) naming a picture or form no resources list any more names the copy MuPDF
//   drew instead, or leaves its element; any other reference to such an object is cut, so a
//   garbage-collected save leaves the original out, unless content still draws it another way, by
//   a name it uses (an annotation's appearance, another picture's /SMask, /Mask or /Alternates, a
//   soft mask's group, another page's /Thumb: stillDrawn); what a dictionary only lists, a form,
//   pattern, soft mask's group or Type 3 glyph nothing drawn names (Do, scn then a paint, gs; Tf and
//   the glyph shown), what the form fields' default resources list but fonts, and the /Alternates of a
//   picture only the redacted pages draw (never shown), keep nothing.
// - The app's blocks: an emptied /PEText line is removed and untagged, a line partly under the area
//   loses /PEText (it is printed text from then on). The edit never goes through protectAdded.
// - Resources: MuPDF gives the page new resources, which can still list what nothing draws (a
//   pattern whose fill went, a property list): the page's own (and those of the forms it copied)
//   lose the names it no longer uses. Then whatever the page's resources listed before (pictures,
//   forms, fonts, graphics states, patterns, shadings, named property lists, its forms' too) and
//   no longer do leaves every dictionary of the document that lists it, unless something drawn
//   draws it, as stillDrawn reads it (every page, each stream once, within MAX_CLEANUP_OPERATIONS
//   in all: past them "shared"; images.pruneUnused, object by object: shared and inherited
//   /Resources, and copies of a direct object a save wrote once per page), so a font only the
//   removed text used, the original picture or form, the pattern, do not reach the saved file.
// - The page's /Thumb, /PieceInfo and /Metadata go, and the pictures of the document's XMP (Adobe's
//   thumbnail of the first page, InDesign's of each, in UTF-8 or UTF-16: dropXmpPictures).
// - The box: /Artifact <</PERedact id>> BDC q 0 g (1 g) ... f Q EMC through newcontent.appendSafely,
//   over the rects and the characters the redaction took: one shape for each run of them on a line
//   (one for each character would keep every one's width in the file, enough to tell a name back),
//   kept to 70 % of their height, so it does not reach over the neighbouring lines (the characters
//   MuPDF gives an /ActualText over a picture, at the pen with no width, are not among them: the
//   redaction leaves them, and the excerpt does not name them). decorations.ts ignores it, and so
//   does the next edit's crossing check (nothing is under it; a drawing of several shapes crosses
//   an edge only where one of them does).
//
// All or nothing: every page is checked first (previewRedaction's checks, reading only), and a
// refusal (RedactRefusal: a Separation or DeviceN picture under the area, a picture past
// MAX_REDACT_PIXELS, content that cannot take the box or whose pictures the walk cannot follow,
// resources the cleanup cannot read for sure: everything that draws with the dictionaries the
// pages' resources are is read first, soft masks the redaction of their group cannot follow)
// throws RedactError before anything changes (`changed` false). A few cases are found only after
// the change: another page whose drawing cannot be read lists an object the redaction took off, or
// alone could still draw one (RedactError "shared" then too), the content after the redaction does
// not let a soft mask's group be redacted as the checks found ("locked"); the session rolls the
// edit back, as for any failure of MuPDF. The edit is deterministic: a replay of the same areas on
// the same document does exactly the same.
//
// What cannot be guaranteed (said in the UI): the length of the removed text (its width stays as
// a TJ offset), characters still in embedded fonts the rest of the page shares, the part of a
// drawing that only crosses the area, shadings and the contents of pattern cells that cross it,
// the outline of a clip under it (MuPDF's line-art filter keeps clip paths: the shape a gradient
// fills through one, W n then sh, stays, covered), text outside the CropBox, what a soft mask's
// group draws outside its own box, the same words elsewhere, attached files (counted wherever
// they hang: /EmbeddedFiles, associated files, file attachments), and the original file and the
// Riprendi record on the device.
//
// MuPDF objects: pages, structured text and the fonts its walk gives, devices and what their
// callbacks receive, pixmaps, images, buffers and annotation wrappers are destroyed here (rule
// 5). PDFObject wrappers are left to the garbage collector, as everywhere else in the engine.
// Nothing is logged, resource names and offsets least of all.
import type * as MuPDF from "mupdf";
import { PENDING_REDACT, annotEntries, restoreAnnots } from "./core.js";
import { fieldTypeOf, fullName } from "./forms";
import {
  NO_STROKE, RESOURCE_KINDS, Unsure, appearances, applyTo, bboxOf, bytesOf, concat, contentStreams, deviceSpace, directKey, findPlacements, guarded,
  invert, latin1, matrixOf, namesReader, namesUsed, nearlyEqual, num, objectIdentity, operations, pruneUnused, shownGlyphs, streamBytes, toBytes, walkedPictures,
  walkedSoftMasks, writeStream, type Operand, type ResourceKind, type SoftMaskUse,
} from "./images";
import { addedBlocks, appendProblem, appendSafely, untag } from "./newcontent";
import { cutReferences, refsIn } from "./pages";
import type { Matrix, Quad, Rect, RedactArea, RedactFacts, RedactMode, RedactPreview, RedactRefusal, RedactReport } from "./protocol";
import { MAX_REDACT_RECTS, clampAreas } from "./redactGeometry";

type MuPDFModule = typeof MuPDF;
type Doc = MuPDF.PDFDocument;
type Obj = MuPDF.PDFObject;
type Point = [number, number];
/** The pictures of a page as the walk reads them (images.walkedPictures). */
type Walked = NonNullable<ReturnType<typeof walkedPictures>>;

/**
 * A redaction that cannot be made: a request out of bounds ("bad-request") or a refusal
 * ("not-editable", with the reason and the page). `changed` false: found before anything changed
 * (the bad requests, check()'s refusals), the document needs no rollback; true for the few found
 * after the change ("shared" from the cleanup, "locked" from the soft masks), which the caller
 * rolls back. True unless said: an error nobody marked is rolled back, never kept half done.
 */
export class RedactError extends Error {
  constructor(
    message: string, readonly code: "bad-request" | "not-editable", readonly refusal?: RedactRefusal, readonly pageIndex?: number, readonly changed = true,
  ) {
    super(message);
    this.name = "RedactError";
  }
}

/**
 * Most pixels a picture Oscura clears may have: 50 million (a 600 dpi A4 scan has 35 million).
 * Decoded in RGB that is 150 MB, and MuPDF holds two or three copies while it clears one: more
 * would not fit in a phone's memory. A bigger picture under the area is refused ("too-big").
 */
export const MAX_REDACT_PIXELS = 50_000_000;
/** Most characters of the excerpt of what goes ("Toglie: «…»"). */
const MAX_EXCERPT = 200;
/**
 * Most content operations the cleanup reads for one redaction (images.pruneUnused; the image edits
 * read at most 4 million): about 4 s on a desktop, several times that on a phone, reached only
 * when many pages share or inherit the redacted page's resources (FPDF writes one set for all).
 * Past it, the redaction is refused ("shared").
 */
const MAX_CLEANUP_OPERATIONS = 20_000_000;
/** Most cells of the tables that pair a content's marked-content sequences before and after (partnersOf): 8 MB. */
const MAX_PAIRING_CELLS = 4_000_000;
/** Most paths whose bounds the checks look at; past them, a crossing drawing is assumed. */
const MAX_CHECKED_PATHS = 500_000;
/** JPEG quality of a cleared picture that was a JPEG (research §redact: 0.93 MB scan → 1.08 MB). */
const JPEG_QUALITY = 85;
/** MuPDF.js PDFPage.REDACT_* values. */
const IMAGE_NONE = 0, IMAGE_PIXELS = 2, LINE_ART_IF_COVERED = 1, TEXT_REMOVE = 0;
/** What describes content for readers and assistive technology. */
const DESCRIPTION_KEYS = ["ActualText", "Alt", "E"];
/** What a structure element says of its content: its descriptions and its title (MuPDF drops the title of the text it removes). */
const ELEMENT_KEYS = [...DESCRIPTION_KEYS, "T"];
/** What a form copy keeps of the original that shows or holds what it painted: its XMP (a placed graphic's own, with a preview of it) and an application's private data. */
const FORM_METADATA_KEYS = ["Metadata", "PieceInfo", "LastModified"];
/** The name a soft mask's group is drawn by, as the page's content for a moment (redactGroup). */
const MASK_GROUP = "PERedactMask";
/** An inline description in a property list as MuPDF writes it (nested parentheses come escaped). */
const DESCRIBED = /\/(?:ActualText|Alt|E)(?![\w#.-])\s*(?:\((?:\\[\s\S]|[^\\)])*\)|<[0-9A-Fa-f\s]*>)/g;
const PAINTS = new Set(["S", "s", "f", "F", "f*", "B", "B*", "b", "b*"]);

const identity = objectIdentity;
const nameOf = (o: Obj) => (o.isName() ? o.asName() : null);
const lookup = (obj: Obj, ...path: string[]): Obj => (obj.isNull() ? obj : obj.get(...path));
const meets = (a: Rect, b: Rect) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
const within = (a: Rect, b: Rect) => a[0] >= b[0] - 0.01 && a[1] >= b[1] - 0.01 && a[2] <= b[2] + 0.01 && a[3] <= b[3] + 0.01;
const quadBounds = (q: Quad): Rect => bboxOf([[q[0], q[1]], [q[2], q[3]], [q[4], q[5]], [q[6], q[7]]]);
const unitBounds = (m: Matrix): Rect => bboxOf([applyTo(m, 0, 0), applyTo(m, 1, 0), applyTo(m, 0, 1), applyTo(m, 1, 1)]);
const bad = (message: string) => new RedactError(message, "bad-request", undefined, undefined, false);

function excerpt(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > MAX_EXCERPT ? `${t.slice(0, MAX_EXCERPT - 1)}…` : t;
}

// ---------------------------------------------------------------------------------------------
// The request

/** The areas of a request by page (in page order), checked and clipped to each page: throws RedactError "bad-request". */
function readAreas(doc: Doc, areas: RedactArea[]): { pageIndex: number; rects: Rect[] }[] {
  if (!Array.isArray(areas) || areas.length === 0) throw bad("No area to redact");
  const count = doc.countPages();
  const byPage = new Map<number, Rect[]>();
  for (const a of areas) {
    const pageIndex = (a as Partial<RedactArea> | null)?.pageIndex;
    if (typeof pageIndex !== "number" || !Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= count) throw bad("Page out of range");
    const rects = (a as RedactArea).rects;
    if (!Array.isArray(rects)) throw bad("Rects missing");
    for (const r of rects)
      if (!Array.isArray(r) || r.length !== 4 || !r.every((v) => typeof v === "number" && Number.isFinite(v))) throw bad("A rect is not four finite numbers");
    const all = [...(byPage.get(pageIndex) ?? []), ...rects];
    if (all.length > MAX_REDACT_RECTS) throw bad(`More than ${MAX_REDACT_RECTS} rects on one page`);
    byPage.set(pageIndex, all);
  }
  const out: { pageIndex: number; rects: Rect[] }[] = [];
  for (const pageIndex of [...byPage.keys()].sort((x, y) => x - y)) {
    const page = doc.loadPage(pageIndex);
    try {
      const rects = clampAreas(byPage.get(pageIndex)!, page.getBounds() as Rect);
      if (rects.length) out.push({ pageIndex, rects });
    } finally {
      page.destroy();
    }
  }
  if (!out.length) throw bad("The areas are outside the pages");
  return out;
}

// ---------------------------------------------------------------------------------------------
// The checks (reading only): what goes, what stays, whether to refuse

/** What one page's redaction would do. */
interface PageCheck {
  pageIndex: number;
  rects: Rect[];
  facts: RedactFacts;
  /** The widgets whose /Rect meets an area (Oscura removes them). */
  widgets: Obj[];
  refusal: RedactRefusal | null;
  /** Where the characters the redaction takes are: one box for each run of them on a line, for the box drawn over them. */
  runs: Quad[];
  /** Soft masks set over the area (what MuPDF's pass saw, or the walk found): their groups are redacted too (redactSoftMasks). */
  masked: boolean;
}

/**
 * MuPDF's rule (measured, research §redact 1): a character goes when its box, the structured
 * text's quad, shrunk by 10 % on each side, meets a rect; a rotated one by its quad's bounds.
 */
function goes(quad: Quad, rects: Rect[]): boolean {
  const b = quadBounds(quad);
  const w = b[2] - b[0], h = b[3] - b[1];
  const s: Rect = [b[0] + w / 10, b[1] + h / 10, b[2] - w / 10, b[3] - h / 10];
  return rects.some((r) => meets(s, r));
}

/**
 * The characters that go: an excerpt of their text, and where they are as drawn: one box for each
 * run of them on a line (ul, ur, ll, lr as a quad: along the line, then across), the bounds of its
 * characters' boxes in the line's direction. A box for each character would keep every one's
 * width in the file (the removed text's total width stays anyway, as a TJ offset).
 */
function textThatGoes(page: MuPDF.PDFPage, rects: Rect[]): { text: string; runs: Quad[] } {
  const st = page.toStructuredText("preserve-whitespace");
  let text = "", gap = false, wmode = 0, dir: Point = [1, 0];
  const runs: Quad[] = [];
  let run: Point[] = []; // the corners of the run's characters, along the line (u) and across it (v)
  let last: { quad: number[]; went: boolean } | null = null; // the line's previous character
  const end = () => {
    if (!run.length) return;
    const [u0, v0, u1, v1] = bboxOf(run);
    const at = (u: number, v: number) => [u * dir[0] - v * dir[1], u * dir[1] + v * dir[0]];
    runs.push([...at(u0, v0), ...at(u1, v0), ...at(u0, v1), ...at(u1, v1)] as Quad);
    run = [];
  };
  try {
    st.walk({
      beginLine(_bbox, mode, d) {
        end();
        wmode = mode;
        const length = Math.hypot(d[0], d[1]) || 1;
        dir = [d[0] / length, d[1] / length];
        if (text) gap = true;
        last = null;
      },
      onChar(c, _origin, font, size, quad) {
        font.destroy();
        const was = last;
        if (Math.hypot(quad[2] - quad[0], quad[3] - quad[1]) < 1e-3) {
          // A character with no width on the end edge of the one before goes with it: a ligature's
          // later letters (Chrome writes /ActualText over one glyph), a glyph with no advance. One
          // elsewhere is an /ActualText over a picture or a drawing (MuPDF puts it at the pen's last
          // place, sized by the picture) that the redaction leaves: neither the excerpt nor the box takes it.
          const tail = !!was?.went && [0, 1, 4, 5].every((k) => Math.abs(quad[k] - was.quad[k + 2]) < 0.01);
          last = { quad, went: tail };
          if (tail) text += c;
          return;
        }
        last = { quad, went: false };
        if (!quad.every(Number.isFinite) || !goes(quad as Quad, rects)) {
          end();
          if (text) gap = true;
          return;
        }
        last.went = true;
        if (gap) text += " ";
        gap = false;
        text += c;
        // (MuPDF 1.27 puts a vertical character's quad 0.88 em down its column: core.extractLines)
        const q = wmode === 1 ? quad.map((v, i) => v - 0.88 * size * dir[i % 2]) : quad;
        for (let k = 0; k < 8; k += 2) run.push([q[k] * dir[0] + q[k + 1] * dir[1], q[k + 1] * dir[0] - q[k] * dir[1]]);
      },
    });
    end();
  } finally {
    st.destroy();
  }
  return { text: excerpt(text), runs };
}

/**
 * What MuPDF draws on the page that meets the areas: pictures (and whether they can be cleared),
 * drawings crossing an edge (a path of several shapes, a grid or an earlier edit's box over two
 * lines, when one of its shapes does; the boxes of earlier edits never: nothing is under them),
 * and whether a soft mask's group draws anything there (`masked`; its pictures counted in
 * `maskedPictures` too). Pattern cells are left out: they are never redacted.
 */
function drawnUnder(mupdf: MuPDFModule, page: MuPDF.PDFPage, rects: Rect[]) {
  let pictures = 0, maskedPictures = 0, separation = false, tooBig = false, crossing = false, masked = false, paths = 0, tile = 0, mask = 0;
  const g = guarded();
  const boxes = boxesOn(page.getObject(), page.getTransform() as Matrix);
  const crosses = (b: Rect) => rects.some((r) => meets(b, r)) && !rects.some((r) => within(b, r));
  const path = (bounds: Rect, shapes?: () => Rect[]) => {
    if (tile) return;
    const meeting = rects.some((r) => meets(bounds, r));
    if (mask && meeting) masked = true;
    if (crossing) return;
    if (++paths > MAX_CHECKED_PATHS) crossing = true;
    else if (crosses(bounds) && !boxes.some((b) => b.every((v, k) => Math.abs(v - bounds[k]) < 0.05)) && (shapes?.() ?? [bounds]).some(crosses)) crossing = true;
  };
  /** The page-space bounds of each shape (subpath) of a path, control points included, grown by `grow` (a stroke's reach). */
  const shapesOf = (p: MuPDF.Path, ctm: Matrix, grow = 0) => () => {
    const out: Rect[] = [];
    let points: Point[] = [];
    const flush = () => {
      if (points.length) {
        const b = bboxOf(points);
        out.push([b[0] - grow, b[1] - grow, b[2] + grow, b[3] + grow]);
      }
      points = [];
    };
    const add = (x: number, y: number) => { points.push(applyTo(ctm, x, y)); };
    p.walk({
      moveTo(x, y) { flush(); add(x, y); },
      lineTo: add,
      curveTo(x1, y1, x2, y2, x3, y3) { add(x1, y1); add(x2, y2); add(x3, y3); },
    });
    flush();
    return out;
  };
  const stroked = (p: MuPDF.Path, stroke: MuPDF.StrokeState, ctm: Matrix) => {
    const bare = p.getBounds(NO_STROKE, ctm), full = p.getBounds(stroke, ctm);
    path(full as Rect, shapesOf(p, ctm, Math.max(0, bare[0] - full[0], bare[1] - full[1], full[2] - bare[2], full[3] - bare[3])));
  };
  const text = (bounds: Rect) => {
    if (mask && !tile && rects.some((r) => meets(bounds, r))) masked = true;
  };
  const picture = (img: MuPDF.Image, ctm: Matrix) => {
    if (tile || !rects.some((r) => meets(unitBounds(ctm), r))) return;
    pictures++;
    if (mask) {
      masked = true;
      maskedPictures++;
    }
    if (img.getWidth() * img.getHeight() > MAX_REDACT_PIXELS) tooBig = true;
    const cs = img.getColorSpace();
    if (!cs) return;
    try {
      const type = cs.getType();
      // (MuPDF calls DeviceN "Separation" too; an indexed picture can be printed in them)
      if (type === "Separation" || cs.isDeviceN() || (type === "Indexed" && /Separation|DeviceN/.test(cs.getName()))) separation = true;
    } finally {
      cs.destroy();
    }
  };
  const dev = new mupdf.Device({
    fillPath(p, _evenOdd, ctm, cs) { g.attempt(() => path(p.getBounds(NO_STROKE, ctm) as Rect, shapesOf(p, ctm as Matrix)), p, cs); },
    strokePath(p, stroke, ctm, cs) { g.attempt(() => stroked(p, stroke, ctm as Matrix), p, stroke, cs); },
    fillImage(img, ctm) { g.attempt(() => picture(img, ctm as Matrix), img); },
    fillImageMask(img, ctm, cs) { g.attempt(() => picture(img, ctm as Matrix), img, cs); },
    // (text matters here only inside a soft mask's group: textThatGoes reads the page's)
    fillText(t, ctm, cs) { g.attempt(() => mask && text(t.getBounds(NO_STROKE, ctm) as Rect), t, cs); },
    strokeText(t, stroke, ctm, cs) { g.attempt(() => mask && text(t.getBounds(stroke, ctm) as Rect), t, stroke, cs); },
    clipText(t, ctm) { g.attempt(() => mask && text(t.getBounds(NO_STROKE, ctm) as Rect), t); },
    ignoreText(t, ctm) { g.attempt(() => mask && text(t.getBounds(NO_STROKE, ctm) as Rect), t); },
    beginTile(area, _view, _xstep, _ystep, ctm) {
      // A pattern fill: its cells are never redacted, so one that crosses the area leaves what it
      // holds. (Its area comes in pattern space: `ctm` takes it to the page.)
      if (!tile) path(mupdf.Rect.transform(area, ctm) as Rect);
      tile++;
      return 0;
    },
    endTile() { tile--; },
    beginMask(_area, _luminosity, cs) { mask++; g.attempt(() => {}, cs); },
    endMask() { mask--; },
  });
  try {
    page.runPageContents(dev, mupdf.Matrix.identity);
    dev.close();
  } finally {
    dev.destroy();
  }
  return { pictures, maskedPictures, separation, tooBig, crossing, masked, failed: g.failed };
}

/** An /Annots entry's /Subtype, "" for a null entry or one naming nothing. */
function subtypeOf(entry: Obj): string {
  if (entry.isNull()) return "";
  const d = entry.resolve();
  return d.isDictionary() ? (nameOf(d.get("Subtype")) ?? "") : "";
}

/** An annotation's /Rect in page space, null when it has none. */
function rectOnPage(dict: Obj, T: Matrix): Rect | null {
  const r = dict.get("Rect");
  if (!r.isArray() || r.length < 4) return null;
  const v = [0, 1, 2, 3].map((k) => r.get(k).asNumber());
  if (!v.every(Number.isFinite)) return null;
  return bboxOf([applyTo(T, v[0], v[1]), applyTo(T, v[2], v[1]), applyTo(T, v[0], v[3]), applyTo(T, v[2], v[3])]);
}

/** Annotations a redaction never takes: the page's pending marks, and popups (they go with their annotation). */
const sitsOut = (subtype: string) => subtype === "" || subtype === "Redact" || subtype === PENDING_REDACT || subtype === "Popup";

/** Whether a picture's colour space prints in named colourants (Separation, DeviceN, or an indexed space over them): MuPDF cannot clear those. */
function printingColours(cs: Obj, depth = 0): boolean {
  const kind = cs.isArray() && cs.length > 0 ? nameOf(cs.get(0)) : nameOf(cs);
  if (kind === "Separation" || kind === "DeviceN") return true;
  return (kind === "Indexed" || kind === "I") && cs.isArray() && cs.length > 1 && depth < 4 && printingColours(cs.get(1), depth + 1);
}

/** A picture's decoded size in pixels, from its dictionary (0 when it does not say). */
function pixelsOf(xo: Obj): number {
  const w = xo.get("Width"), h = xo.get("Height");
  return w.isNumber() && h.isNumber() ? w.asNumber() * h.asNumber() : 0;
}

/** The annotations among `entries` whose /Rect meets an area (pending marks and popups left out), and whether each lies wholly inside one rect. */
function annotationsUnder(entries: Obj[], T: Matrix, rects: Rect[]): { entry: Obj; subtype: string; inside: boolean }[] {
  const out: { entry: Obj; subtype: string; inside: boolean }[] = [];
  for (const entry of entries) {
    const subtype = subtypeOf(entry);
    if (sitsOut(subtype)) continue;
    const r = rectOnPage(entry.resolve(), T);
    if (r && rects.some((a) => meets(r, a))) out.push({ entry, subtype, inside: rects.some((a) => within(r, a)) });
  }
  return out;
}

/** The replies (/IRT) among `entries` to the annotations `going` (identities), and the replies to those: added to `going`, and returned. */
function repliesTo(entries: Obj[], going: Set<string>): Obj[] {
  const out: Obj[] = [];
  for (let changed = true; changed; ) {
    changed = false;
    for (const e of entries) {
      if (e.isNull() || going.has(identity(e))) continue;
      const d = e.resolve();
      if (!d.isDictionary()) continue;
      const irt = d.get("IRT");
      if (!irt.isNull() && going.has(identity(irt))) {
        going.add(identity(e));
        out.push(e);
        changed = true;
      }
    }
  }
  return out;
}

/** Reads the page: what goes, what stays on top, and whether to refuse (all but "shared", checked for all pages at once). */
function inspectPage(mupdf: MuPDFModule, doc: Doc, pageIndex: number, rects: Rect[], mode: RedactMode): PageCheck {
  const black = mode === "redact";
  const page = doc.loadPage(pageIndex);
  try {
    const pageObj = page.getObject(), T = page.getTransform() as Matrix;
    const { text, runs } = textThatGoes(page, rects);
    const drawn = drawnUnder(mupdf, page, rects);
    // Oscura: every picture the content draws, hidden layers too (MuPDF's redaction clears those as
    // well), as the walk reads it. (Bianchetto only covers what shows.)
    const walked = black ? walkedPictures(page) : null;
    const pictured = walked?.filter((w) => rects.some((r) => meets(unitBounds(w.matrix), r))) ?? [];
    // (the walk does not enter soft masks' groups: their pictures are counted as MuPDF draws them)
    const pictures = walked ? pictured.length + drawn.maskedPictures : drawn.pictures;
    // A soft mask's group drawing under the area is redacted where it is set: each mask the walk
    // finds whose group's box meets the area (hidden layers too, and one nothing is painted through,
    // which MuPDF's pass never runs), set once (by content drawn once: MuPDF copies a form for each
    // time it is drawn); refused when the pass saw one the walk does not find.
    const drawnOnce = (u: SoftMaskUse) => (u.host ? `${identity(u.host)}@${u.top?.stream}:${u.top?.start}` : "page");
    const over = masksOver(mupdf, page, rects, drawnOnce);
    const maskProblem = (drawn.masked && !over?.length) || (!!over?.length && setTwice(over, drawnOnce));
    const separation = drawn.separation || pictured.some((w) => w.xobject !== null && printingColours(w.xobject.get("ColorSpace")));
    const tooBig = drawn.tooBig || pictured.some((w) => w.xobject !== null && pixelsOf(w.xobject) > MAX_REDACT_PIXELS);
    const entries = annotEntries(pageObj);
    const under = annotationsUnder(entries, T, rects);
    const widgets = under.filter((a) => a.subtype === "Widget").map((a) => a.entry);
    const links = under.filter((a) => a.subtype === "Link" && (black || !a.inside)).length;
    // (Bianchetto removes a link wholly inside, redactPage step 4: said apart from those left on top)
    const linksRemoved = black ? {} : { linksRemoved: under.filter((a) => a.subtype === "Link" && a.inside).length };
    let annotations = under.filter((a) => a.subtype !== "Widget" && a.subtype !== "Link").length;
    if (black) annotations += repliesTo(entries, new Set(under.map((a) => identity(a.entry)))).length;
    const fields = [...new Set(widgets.map((w) => fullName(w)).filter(Boolean))];
    let refusal: RedactRefusal | null = null;
    if (black && separation) refusal = "separation";
    else if (black && tooBig) refusal = "too-big";
    else if (drawn.failed || maskProblem || appendProblem(doc, pageIndex) !== null) refusal = "locked";
    else if (!resourcelessForms(pageObj.getInheritable("Resources")) || losesNames(pageObj.getInheritable("Resources"))) refusal = "locked";
    // (the pictures Oscura replaces are followed through the walk of the page's content)
    else if (black && pictures && walked === null) refusal = "locked";
    return {
      pageIndex, rects, widgets, refusal, runs, masked: drawn.masked || !!over?.length,
      facts: { text, pictures, fields, links, ...linksRemoved, annotations, crossing: drawn.crossing },
    };
  } finally {
    page.destroy();
  }
}

/** What a page's resources list: every object (by identity, the wrappers kept so that a direct one's key stays its own), and the dictionaries of each kind. */
interface Listed {
  objects: Map<string, Obj>;
  dicts: Set<string>;
  /** The first of the pages (its place among them) that lists each object and dictionary: the page a "shared" refusal names. */
  pageOf: Map<string, number>;
}

/**
 * Adds to `into` every object the resources `res` (of the `page`-th page) list, of every kind the
 * cleanup follows, in their forms', patterns', Type 3 fonts' and soft-mask groups' resources too,
 * and those dictionaries. A direct object also by what it holds (images.directKey): a save writes
 * a shared one once per page that lists it. Throws Unsure past a sane count.
 */
function listedBy(res: Obj, into: Listed, page: number, seen = new Set<string>(), depth = 0) {
  if (!res.isDictionary() || depth > 32 || seen.has(identity(res))) return;
  seen.add(identity(res));
  if (into.objects.size > 200_000) throw new Unsure();
  const inner = (o: Obj) => {
    const own = lookup(o, "Resources");
    if (own.isDictionary()) listedBy(own, into, page, seen, depth + 1);
  };
  const note = (key: string) => { if (!into.pageOf.has(key)) into.pageOf.set(key, page); };
  const add = (v: Obj) => {
    for (const key of v.isIndirect() ? [identity(v)] : [identity(v), directKey(v)]) {
      into.objects.set(key, v);
      note(key);
    }
  };
  for (const kind of RESOURCE_KINDS) {
    const dict = lookup(res, kind);
    if (!dict.isDictionary()) continue;
    into.dicts.add(identity(dict));
    note(identity(dict));
    dict.forEach((v) => {
      if (v.isNull()) return;
      add(v);
      if (kind === "XObject" && v.isStream() && nameOf(v.get("Subtype")) === "Form") inner(v);
      else if (kind === "Pattern") inner(v);
      else if (kind === "Font" && nameOf(lookup(v, "Subtype")) === "Type3") inner(v);
      else if (kind === "ExtGState") {
        // (the group too: redactSoftMasks points the page at a redacted copy, and another dictionary may list the original)
        const group = lookup(v, "SMask", "G");
        if (group.isStream()) add(group);
        inner(group);
      }
    });
  }
}

/** Whether a resource holds content that draws with resources of its own or the ones it is listed in: a form, a pattern, a Type 3 font, a graphics state with a soft mask's group. */
function holdsContent(o: Obj): boolean {
  if (!o.isDictionary() && !o.isStream()) return false;
  const subtype = nameOf(o.get("Subtype"));
  return subtype === "Form" || subtype === "Type3" || o.get("PatternType").isNumber() || lookup(o, "SMask", "G").isStream();
}

const listedOf = (pageObjs: Obj[]): Listed => {
  const into: Listed = { objects: new Map(), dicts: new Set(), pageOf: new Map() };
  pageObjs.forEach((pageObj, k) => listedBy(pageObj.getInheritable("Resources"), into, k));
  return into;
};

/** The page a "shared" refusal names: the first of `pages` that listed what the cleanup was looking into when it could not read for sure (the first page when that is not known). */
const sharedPage = (pages: { pageIndex: number }[], listed: Listed, err: Unsure) => pages[listed.pageOf.get(err.key ?? "") ?? 0].pageIndex;

/**
 * After the redaction, the page's own resources (MuPDF gives the page new ones) and those of the
 * forms it copied (from object `n0` on) lose the names the page no longer uses: their dictionaries
 * are replaced by copies without them, so no other page or form sharing one is touched. Throws
 * Unsure when the page's content cannot be read for sure.
 */
function pruneOwn(doc: Doc, holder: Obj, isPage: boolean, n0: number, seen = new Set<string>(), depth = 0) {
  if (depth > 16 || seen.has(identity(holder))) return;
  seen.add(identity(holder));
  const res = isPage ? holder.getInheritable("Resources") : holder.get("Resources");
  if (!res.isDictionary()) return;
  const used = namesUsed(res, isPage ? contentStreams(holder) : [holder], isPage ? holder.get("Annots") : null);
  let own: Obj | null = null;
  for (const kind of RESOURCE_KINDS) {
    const dict = lookup(res, kind);
    if (!dict.isDictionary()) continue;
    const kept = doc.newDictionary();
    let dropped = false;
    dict.forEach((v, k) => {
      if (used[kind].has(String(k))) kept.put(k, v);
      else dropped = true;
    });
    if (!dropped) continue;
    if (!own) {
      own = doc.newDictionary();
      res.forEach((v, k) => own!.put(k, v));
      holder.put("Resources", own);
    }
    own.put(kind, kept);
  }
  lookup(res, "XObject").forEach((xo, name) => {
    if (used.XObject.has(String(name)) && xo.isStream() && nameOf(xo.get("Subtype")) === "Form" && xo.isIndirect() && xo.asIndirect() >= n0)
      pruneOwn(doc, xo, false, n0, seen, depth + 1);
  });
}

/**
 * The files embedded in the document, each once (by its stream): those its /EmbeddedFiles, its
 * FileAttachment annotations and its associated files (/AF) hold, wherever they hang: the catalog,
 * a page, a form (a chart's source data), a picture, an annotation, a structure element. What a
 * save keeps: every object reachable from the trailer is read once (as pages.ts cutReferences),
 * those that hold a file specification's /EF looked into.
 */
function attachmentCount(doc: Doc): number {
  const files = new Set<string>();
  const total = doc.countObjects();
  const seen = new Set<number>();
  const queue: number[] = [];
  // (the file specifications in `o` and its direct sub-objects)
  const embedded = (o: Obj, depth: number) => {
    if (depth > 32 || (!o.isDictionary() && !o.isArray())) return;
    const ef = o.isDictionary() ? o.get("EF") : null;
    if (ef?.isDictionary()) ef.forEach((f) => { if (f.isStream()) files.add(identity(f)); });
    o.forEach((v) => { if (!v.isIndirect()) embedded(v, depth + 1); });
  };
  const visit = (o: Obj) => {
    const text = o.toString();
    if (text.includes("/EF")) embedded(o, 0);
    for (const n of refsIn(text))
      if (n > 0 && n < total && !seen.has(n)) {
        seen.add(n);
        queue.push(n);
      }
  };
  visit(doc.getTrailer());
  while (queue.length) visit(doc.newIndirect(queue.pop()!).resolve());
  return files.size;
}

/** The field a widget belongs to: the nearest of it and its parents with a partial name (as forms.ts reads it). */
function fieldOf(widget: Obj): Obj {
  let node = widget;
  for (let depth = 0; depth < 32 && node.isDictionary(); depth++, node = node.get("Parent")) if (!node.get("T").isNull()) return node;
  return widget;
}

/** The widgets under a field node: the leaves of its /Kids (itself, for a field merged with its only widget). */
function widgetsOf(node: Obj, depth = 0, seen = new Set<string>()): Obj[] {
  const kids = node.get("Kids");
  if (!kids.isArray() || depth > 32 || seen.has(identity(node))) return [node];
  seen.add(identity(node));
  const out: Obj[] = [];
  for (let k = 0; k < kids.length; k++) if (kids.get(k).isDictionary()) out.push(...widgetsOf(kids.get(k), depth + 1, seen));
  return out;
}

/** The fields among `widgets`' that keep a widget elsewhere (another page, or outside the areas): their values stay there. */
function fieldsElsewhere(widgets: Obj[]): string[] {
  const going = new Set(widgets.map(identity));
  const out = new Set<string>();
  for (const w of widgets) if (widgetsOf(fieldOf(w)).some((x) => !going.has(identity(x)))) out.add(fullName(w));
  return [...out].filter(Boolean);
}

interface Checked {
  pages: { pageIndex: number; rects: Rect[] }[];
  checks: PageCheck[];
  /** What the pages' resources list now (the candidates of the cleanup after the edit). */
  listed: Listed;
  refused: { reason: RedactRefusal; pageIndex: number } | null;
}

/**
 * Every page checked (reading only), the first refusal found; "shared" last, for all pages at
 * once: what draws with the dictionaries the pages' resources are (the pages themselves, the
 * pages and forms sharing or inheriting them) is read, all of it, as the cleanup after the edit
 * may need to.
 */
function check(mupdf: MuPDFModule, doc: Doc, areas: RedactArea[], mode: RedactMode): Checked {
  const pages = readAreas(doc, areas);
  const checks = pages.map((p) => inspectPage(mupdf, doc, p.pageIndex, p.rects, mode));
  let listed: Listed = { objects: new Map(), dicts: new Set(), pageOf: new Map() };
  const first = checks.find((c) => c.refusal);
  if (first) return { pages, checks, listed, refused: { reason: first.refusal!, pageIndex: first.pageIndex } };
  try {
    listed = listedOf(pages.map((p) => doc.findPage(p.pageIndex)));
    pruneUnused(doc, new Set(listed.objects.keys()), RESOURCE_KINDS, { dryRun: true, only: listed.dicts, maxOperations: MAX_CLEANUP_OPERATIONS });
  } catch (err) {
    if (!(err instanceof Unsure)) throw err;
    return { pages, checks, listed, refused: { reason: "shared", pageIndex: sharedPage(pages, listed, err) } };
  }
  return { pages, checks, listed, refused: null };
}

const REFUSALS: Record<RedactRefusal, string> = {
  separation: "A picture in printing colours (Separation or DeviceN) is under the area",
  "too-big": "A picture under the area is too large to clear on this device",
  shared: "The page shares what it draws with other pages in a way that cannot be cleaned for sure",
  locked: "The page's content cannot be changed safely",
};

/**
 * What redactAreas would do: per page what goes (or, Bianchetto, stays on top), the attached files,
 * and the refusal if it would refuse. Changes nothing. Throws RedactError ("bad-request") for
 * areas out of bounds.
 */
export function previewRedaction(mupdf: MuPDFModule, doc: Doc, areas: RedactArea[], mode: RedactMode): RedactPreview {
  const { checks, refused } = check(mupdf, doc, areas, mode);
  return { pages: checks.map((c) => ({ pageIndex: c.pageIndex, ...c.facts })), attachments: attachmentCount(doc), refused };
}

// ---------------------------------------------------------------------------------------------
// The edit

/** What an edit gathers across its pages. */
interface Run {
  /** Objects that leave (annotations, widgets, fields, pictures and forms nothing draws now): every reference left to them is cut at the end. */
  gone: Set<number>;
  /** The forms MuPDF copied: the original's object number → the copy the page draws (the first, when it draws several). */
  copies: Map<number, Obj>;
  /** The MCIDs whose elements lose their descriptions, by the content they mark (a page's or a form's, by identity): forgetByTree. */
  forgotten: Map<string, Set<number>>;
  fieldsRemoved: number;
  picturesFixed: number;
  growth: number;
}

/**
 * Bianchetto or Oscura over `areas` (one or more pages, page space), one edit: every page is
 * checked first, and a refusal throws RedactError ("not-editable", with the reason and the page)
 * before anything changes; areas out of bounds throw RedactError ("bad-request"). Deterministic.
 * Returns the report and whether the form changed (Oscura removed widgets: forms.formChanged and
 * the document's form facts are the caller's).
 */
export function redactAreas(mupdf: MuPDFModule, doc: Doc, areas: RedactArea[], mode: RedactMode): { report: RedactReport; formChanged: boolean } {
  const { checks, listed, refused, pages } = check(mupdf, doc, areas, mode);
  if (refused) throw new RedactError(REFUSALS[refused.reason], "not-editable", refused.reason, refused.pageIndex, false);
  const run: Run = { gone: new Set(), copies: new Map(), forgotten: new Map(), fieldsRemoved: 0, picturesFixed: 0, growth: 0 };
  const elsewhere = mode === "redact" ? fieldsElsewhere(checks.flatMap((c) => c.widgets)) : [];
  const firsts = checks.map((c) => redactPage(mupdf, doc, c, mode, run));
  // What the pages listed and no longer draw leaves the file, unless something else draws it.
  const gone = new Set<string>();
  let left: Set<number>, drawn: Set<number>;
  try {
    const pageObjs = pages.map((p) => doc.findPage(p.pageIndex));
    pageObjs.forEach((pageObj, k) => {
      try {
        pruneOwn(doc, pageObj, true, firsts[k]);
      } catch (err) {
        throw err instanceof Unsure ? new RedactError(REFUSALS.shared, "not-editable", "shared", pages[k].pageIndex) : err;
      }
    });
    const still = listedOf(pageObjs).objects;
    for (const [key, o] of listed.objects) if (!still.has(identity(o))) gone.add(key);
    // A pass keeps what a holder of content (a form, pattern, Type 3 font, soft mask) leaving in the
    // same pass draws: it was still listed then. So while a pass lets a holder go, another follows.
    let kept = pruneUnused(doc, gone, RESOURCE_KINDS, { byObject: true, maxOperations: MAX_CLEANUP_OPERATIONS });
    let holders = [...gone].some((key) => !kept.has(key) && holdsContent(listed.objects.get(key)!));
    for (let pass = 1; holders && pass < 8; pass++) {
      const again = pruneUnused(doc, gone, RESOURCE_KINDS, { byObject: true, maxOperations: MAX_CLEANUP_OPERATIONS });
      holders = [...kept].some((key) => !again.has(key) && holdsContent(listed.objects.get(key)!));
      kept = again;
    }
    // The pictures and forms no resources list now: the structure tree names the copies instead, or
    // lets them go, and no other reference keeps them (with what was under the area) in the saved
    // file, unless something still draws them another way (another page's mask, alternate, thumbnail).
    left = leftXObjects(doc, gone, kept);
    retag(doc, run.copies, left);
    drawn = left.size ? stillDrawn(doc, left, new Set(pages.map((p) => p.pageIndex))) : new Set();
  } catch (err) {
    // (the page's own content and what shares its resources were read before the change: only an
    // unreadable page elsewhere listing the same objects, or alone able to draw one that went, gets
    // here; the session rolls the edit back)
    if (err instanceof Unsure) throw new RedactError(REFUSALS.shared, "not-editable", "shared", sharedPage(pages, listed, err));
    throw err;
  }
  for (const n of left) if (!drawn.has(n)) run.gone.add(n);
  strayPopups(doc, run);
  forgetByTree(doc, run);
  cutReferences(doc, run.gone);
  if (run.fieldsRemoved) dropXfa(doc);
  dropXmpPictures(mupdf, doc);
  if (run.picturesFixed) mupdf.emptyStore(); // rule 6: the fixed pictures were loaded before they were fixed
  const sum = (count: (f: RedactFacts) => number) => checks.reduce((n, c) => n + count(c.facts), 0);
  const report: RedactReport = {
    text: excerpt(checks.map((c) => c.facts.text).filter(Boolean).join(" … ")),
    pictures: sum((f) => f.pictures),
    fields: [...new Set(checks.flatMap((c) => c.facts.fields))],
    links: sum((f) => f.links),
    ...(mode === "redact" ? {} : { linksRemoved: sum((f) => f.linksRemoved ?? 0) }),
    annotations: sum((f) => f.annotations),
    crossing: checks.some((c) => c.facts.crossing),
    growth: run.growth,
    attachments: attachmentCount(doc),
    fieldsElsewhere: elsewhere,
  };
  return { report, formChanged: mode === "redact" && checks.some((c) => c.widgets.length > 0) };
}

/** One page of the edit (checked already). Returns the first object number the redaction made (its forms, pictures). */
function redactPage(mupdf: MuPDFModule, doc: Doc, c: PageCheck, mode: RedactMode, run: Run): number {
  const black = mode === "redact";
  const { pageIndex, rects } = c;
  const pageObj = doc.findPage(pageIndex);
  // 1. The page as it is: its content, the app's lines, the pictures (Oscura, when some are under the area).
  let page = doc.loadPage(pageIndex);
  let T: Matrix, before: Content, blocksBefore: ReturnType<typeof addedBlocks>, pictures: Walked | null;
  try {
    T = page.getTransform() as Matrix;
    before = readPageContent(pageObj);
    blocksBefore = addedBlocks(page);
    pictures = black ? walkedPictures(page) : null;
  } finally {
    page.destroy();
  }
  // A picture tagged by an object reference (its own /StructParent) loses its element's description too.
  for (const p of pictures ?? []) {
    const sp = p.xobject?.get("StructParent");
    if (sp?.isNumber() && rects.some((r) => meets(unitBounds(p.matrix), r))) forgetReferenced(doc, sp.asNumber());
  }
  const n0 = doc.countObjects();

  // 2. Oscura: the annotations meeting the area leave, before the page is loaded for the redaction.
  if (black) removeAnnotations(doc, pageObj, annotationsUnder(annotEntries(pageObj), T, rects).map((a) => a.entry), run);
  const listed = annotEntries(pageObj);

  // 3. The redaction, the page's own pending marks sitting it out.
  page = doc.loadPage(pageIndex);
  try {
    applyRedaction(doc, page, pageIndex, listed, rects, black ? IMAGE_PIXELS : IMAGE_NONE);
  } finally {
    page.destroy();
  }

  // 4. What MuPDF took off /Annots on its own (links, FreeText): Oscura lets it go for good, cleanly;
  // Bianchetto puts it back (core.js restoreAnnots, as replaceText does), but a link that lay wholly
  // inside a rect (said: linksRemoved).
  const present = new Set(annotEntries(pageObj).map(identity));
  const lost = listed.filter((e) => !present.has(identity(e)) && !["", "Redact"].includes(subtypeOf(e)));
  if (black) removeAnnotations(doc, pageObj, lost, run);
  else {
    const inside = annotationsUnder(lost, T, rects).filter((a) => a.subtype === "Link" && a.inside).map((a) => a.entry);
    const out = new Set(inside.map(identity));
    restoreAnnots(doc, pageObj, listed.filter((e) => !out.has(identity(e)) && subtypeOf(e) !== "Redact"));
    removeAnnotations(doc, pageObj, inside, run);
  }

  // 5. Oscura: the new pictures.
  if (black) {
    page = doc.loadPage(pageIndex);
    try {
      fixPictures(mupdf, doc, page, pictures ?? [], rects, n0, run);
    } finally {
      page.destroy();
    }
  }

  // 6. Descriptions and the app's lines.
  page = doc.loadPage(pageIndex);
  let blocksAfter: ReturnType<typeof addedBlocks>;
  try {
    blocksAfter = addedBlocks(page);
  } finally {
    page.destroy();
  }
  rewriteContent(mupdf, doc, pageIndex, before, pictures, rects, blocksBefore, blocksAfter, n0, run);

  // 6b. The groups of the soft masks set over the area.
  if (c.masked) redactSoftMasks(mupdf, doc, pageIndex, rects, mode, run, n0);

  // 7. The page's thumbnail, private data and metadata, which show or hold what it was.
  for (const key of ["Thumb", "PieceInfo", "Metadata"]) pageObj.delete(key);

  // 8. The box.
  appendSafely(mupdf, doc, pageObj, boxOps(pageObj, rects, c.runs, T, black));
  return n0;
}

/**
 * The forms without /Resources of their own (PDF 1.1: they draw with those of the content that
 * draws them) that `res` lists, and the forms' resources it lists in turn, each with the resources
 * it draws with; null when one is listed under two (MuPDF's one copy of it cannot draw as both).
 */
function resourcelessForms(res: Obj, out = new Map<string, [Obj, Obj]>(), seen = new Set<string>(), depth = 0): Map<string, [Obj, Obj]> | null {
  if (!res.isDictionary() || depth > 16 || seen.has(identity(res))) return out;
  seen.add(identity(res));
  let clash = false;
  lookup(res, "XObject").forEach((xo) => {
    if (clash || !xo.isStream() || nameOf(xo.get("Subtype")) !== "Form") return;
    const own = xo.get("Resources"), was = out.get(identity(xo));
    if (own.isDictionary()) clash = resourcelessForms(own, out, seen, depth + 1) === null;
    else if (was && identity(was[1]) !== identity(res)) clash = true;
    else out.set(identity(xo), [xo, res]);
  });
  return clash ? null : out;
}

/**
 * Whether `res` lists (itself, or in the resources of the forms, patterns, Type 3 fonts and soft
 * masks' groups it lists) a pattern, a Type 3 font or a soft mask's group without resources of its
 * own whose content names one: MuPDF gives the page, and each form it copies, new resources that
 * list what their content names, not what those name, so they would lose what they draw, outside
 * the area too (forms are lent theirs: applyRedaction). Content that cannot be read counts.
 */
function losesNames(res: Obj, seen = new Set<string>(), depth = 0): boolean {
  if (!res.isDictionary() || depth > 16 || seen.has(identity(res))) return false;
  seen.add(identity(res));
  const holders: [Obj, Obj[]][] = []; // (each with its content: a Type 3 font's glyphs)
  lookup(res, "XObject").forEach((xo) => { if (xo.isStream() && nameOf(xo.get("Subtype")) === "Form" && xo.get("Resources").isDictionary()) holders.push([xo, []]); });
  // (a shading pattern, a gradient, is a dictionary: no content, nothing named)
  lookup(res, "Pattern").forEach((pattern) => { if (pattern.isStream()) holders.push([pattern, [pattern]]); });
  lookup(res, "ExtGState").forEach((eg) => { if (lookup(eg, "SMask", "G").isStream()) holders.push([lookup(eg, "SMask", "G"), [lookup(eg, "SMask", "G")]]); });
  lookup(res, "Font").forEach((font) => {
    const procs: Obj[] = [];
    if (nameOf(lookup(font, "Subtype")) === "Type3") lookup(font, "CharProcs").forEach((proc) => procs.push(proc));
    if (procs.length) holders.push([font, procs]);
  });
  return holders.some(([holder, contents]) => {
    const own = lookup(holder, "Resources");
    if (own.isDictionary()) return losesNames(own, seen, depth + 1);
    try {
      const used = namesUsed(res, contents, null);
      return RESOURCE_KINDS.some((kind) => used[kind].size > 0);
    } catch {
      return true;
    }
  });
}

/**
 * Redact annotations over `rects`, applied with `image` (NONE or PIXELS), line art when covered,
 * text removed; MuPDF's own boxes off. MuPDF copies every form the page draws, and the copy of one
 * without resources of its own gets new ones that hold its fonts alone: what else it draws
 * (pictures, forms, graphics states, patterns, shadings) would vanish, outside the area too. So
 * for the call each has the resources it draws with as its own (resourcelessForms), and then none
 * again; RedactError "locked" for one that draws with two.
 */
function applyRedaction(doc: Doc, page: MuPDF.PDFPage, pageIndex: number, listed: Obj[], rects: Rect[], image: number) {
  const forms = resourcelessForms(page.getObject().getInheritable("Resources"));
  if (!forms) throw locked(pageIndex);
  const pending = listed.filter((e) => subtypeOf(e) === "Redact").map((e) => e.resolve());
  const made: MuPDF.PDFAnnotation[] = [];
  for (const d of pending) d.put("Subtype", doc.newName(PENDING_REDACT));
  for (const [xo, res] of forms.values()) xo.put("Resources", res);
  try {
    for (const r of rects) {
      const a = page.createAnnotation("Redact");
      made.push(a);
      a.setRect(r);
    }
    page.applyRedactions(false, image, LINE_ART_IF_COVERED, TEXT_REMOVE);
  } catch (err) {
    for (const a of made) {
      try {
        page.deleteAnnotation(a);
      } catch {
        // already gone
      }
    }
    throw err;
  } finally {
    for (const d of pending) d.put("Subtype", doc.newName("Redact"));
    for (const [xo] of forms.values()) xo.delete("Resources");
    for (const a of made) a.destroy();
  }
}

// ---------------------------------------------------------------------------------------------
// Annotations and fields

/**
 * The annotations `targets` (/Annots entries, or entries MuPDF already took off) leave the page,
 * whole: with their popups and the replies to them (and theirs), out of /Annots, out of the
 * structure tree; widgets out of their fields, and a field left without widgets out of the form
 * (/Fields, its parent's /Kids, /CO). Every object that leaves is noted in `run.gone` (the
 * references left to it are cut at the end).
 */
function removeAnnotations(doc: Doc, pageObj: Obj, targets: Obj[], run: Run) {
  if (!targets.length) return;
  const entries = annotEntries(pageObj);
  const going = new Set(targets.map(identity));
  const leaving: Obj[] = [...targets, ...repliesTo(entries, going)];
  for (const e of [...leaving]) {
    const popup = e.resolve().get("Popup");
    if (popup.isDictionary() && !going.has(identity(popup))) {
      going.add(identity(popup));
      leaving.push(popup);
    }
  }
  // (a popup may name its annotation by its /Parent alone: its own /Contents would show once that is cut)
  for (const e of entries)
    if (subtypeOf(e) === "Popup" && !going.has(identity(e)) && going.has(identity(e.resolve().get("Parent")))) {
      going.add(identity(e));
      leaving.push(e);
    }
  const annots = pageObj.get("Annots");
  if (annots.isArray()) for (let k = annots.length - 1; k >= 0; k--) if (going.has(identity(annots.get(k)))) annots.delete(k);
  // (by the entries as written: a resolved dictionary is not the indirect object its references name)
  for (const e of leaving) {
    const d = e.resolve();
    if (!d.isDictionary()) continue;
    if (e.isIndirect()) run.gone.add(e.asIndirect());
    untagAnnotation(doc, e);
    if (nameOf(d.get("Subtype")) === "Widget") leaveForm(doc, e, run);
  }
}

/** Popups another page lists (writers should not, a reader may still show them) whose /Parent left (`run.gone`): they leave too, with their own /Contents. */
function strayPopups(doc: Doc, run: Run) {
  for (let k = 0, n = doc.countPages(); k < n && run.gone.size; k++) {
    const pageObj = doc.findPage(k);
    const strays = annotEntries(pageObj).filter((e) => {
      const parent = subtypeOf(e) === "Popup" ? e.resolve().get("Parent") : null;
      return !!parent?.isIndirect() && run.gone.has(parent.asIndirect());
    });
    removeAnnotations(doc, pageObj, strays, run);
  }
}

/**
 * A widget leaves its parent's /Kids (or /Fields, when it is its own field); a parent left without
 * kids leaves its own parent, and so on up: a field that goes takes its value with it (a
 * signature's too), and leaves /CO. A field that keeps other widgets keeps its value.
 */
function leaveForm(doc: Doc, widget: Obj, run: Run) {
  const acro = doc.getTrailer().get("Root", "AcroForm");
  const same = (a: Obj, b: Obj) => identity(a) === identity(b);
  const removeFrom = (list: Obj, node: Obj) => {
    if (list.isArray()) for (let k = list.length - 1; k >= 0; k--) if (same(list.get(k), node)) list.delete(k);
  };
  let node: Obj = widget;
  for (let depth = 0; depth < 32; depth++) {
    const parent = node.get("Parent");
    if (!node.get("T").isNull()) {
      // a field goes (the widget object itself was noted by removeAnnotations)
      if (node.isIndirect()) run.gone.add(node.asIndirect());
      run.fieldsRemoved++;
      if (fieldTypeOf(node) === "signature" && !node.get("V").isNull()) {
        if (node.get("V").isIndirect()) run.gone.add(node.get("V").asIndirect());
        // (the signer's certificates and revocation data: the save breaks every signature anyway)
        doc.getTrailer().get("Root").delete("DSS");
      }
    } else if (!same(node, widget) && node.isIndirect()) run.gone.add(node.asIndirect());
    removeFrom(lookup(acro, "CO"), node);
    if (!parent.isDictionary()) {
      removeFrom(lookup(acro, "Fields"), node);
      return;
    }
    const kids = parent.get("Kids");
    removeFrom(kids, node);
    if (kids.isArray() && kids.length > 0) return; // the parent keeps other kids (a field keeps its value)
    node = parent;
  }
}

/** XMP's namespace for pictures (xmpGImg). */
const XMP_PICTURES = "http://ns.adobe.com/xap/1.0/g/img/";

/**
 * The document's XMP loses the pictures it holds (xmpGImg:image): Adobe applications write a JPEG
 * of the first page there (xmp:Thumbnails), InDesign one of each page (xmp:PageInfo), renderings
 * of what the edit removed. Its text (title, author) stays: it stands elsewhere too, as Info.
 * XMP may be UTF-16, either byte order (its first bytes tell: a BOM, or its markup's zero bytes),
 * read and written so; one in UTF-32, or that cannot be decoded, goes whole.
 */
function dropXmpPictures(mupdf: MuPDFModule, doc: Doc) {
  const root = doc.getTrailer().get("Root"), meta = root.get("Metadata");
  if (!meta.isStream()) return;
  let bytes: Uint8Array;
  try {
    bytes = streamBytes(meta);
  } catch {
    root.delete("Metadata");
    return;
  }
  const [b0, b1, b2, b3] = bytes;
  if ((b0 === 0 && b1 === 0) || (b2 === 0 && b3 === 0)) {
    root.delete("Metadata");
    return;
  }
  const order = (b0 === 0xfe && b1 === 0xff) || (b0 === 0 && b1 !== undefined) ? "be" : (b0 === 0xff && b1 === 0xfe) || (b0 !== 0 && b1 === 0) ? "le" : null;
  const xml = order ? new TextDecoder(`utf-16${order}`, { ignoreBOM: true }).decode(bytes) : latin1(bytes);
  let out = xml;
  for (const [, prefix, ns] of xml.matchAll(/xmlns:([\w.-]+)\s*=\s*["']([^"']*)["']/g)) {
    if (ns !== XMP_PICTURES) continue;
    const p = prefix.replace(/\./g, "\\.");
    // (an element, or an attribute in RDF's short form)
    out = out.replace(new RegExp(`<${p}:image\\b[^>]*?(?:/>|>[\\s\\S]*?</${p}:image\\s*>)`, "g"), "");
    out = out.replace(new RegExp(`\\s${p}:image\\s*=\\s*(?:"[^"]*"|'[^']*')`, "g"), "");
  }
  if (out === xml) return;
  let data = toBytes(out);
  if (order) {
    data = new Uint8Array(out.length * 2);
    for (let i = 0; i < out.length; i++) data.set(order === "le" ? [out.charCodeAt(i) & 255, out.charCodeAt(i) >> 8] : [out.charCodeAt(i) >> 8, out.charCodeAt(i) & 255], 2 * i);
  }
  const buf = new mupdf.Buffer(data);
  try {
    meta.writeStream(buf);
  } finally {
    buf.destroy();
  }
}

/** A static XFA form would keep the removed fields' data (as pages.ts and forms.ts drop it). */
function dropXfa(doc: Doc) {
  const root = doc.getTrailer().get("Root");
  const acro = root.get("AcroForm"), needsRendering = root.get("NeedsRendering");
  if (acro.isDictionary() && !acro.get("XFA").isNull() && !(needsRendering.isBoolean() && needsRendering.asBoolean())) acro.delete("XFA");
}

/**
 * Number tree lookup (/Nums leaves, /Kids), every kid read: not core.js's, which trusts /Limits. A
 * writer's wrong /Limits must not hide the element whose descriptions must go (numberTreeDelete
 * reads every kid too).
 */
function numberTreeGet(node: Obj, key: number, depth = 0): Obj | null {
  if (!node.isDictionary() || depth > 32) return null;
  const nums = node.get("Nums");
  if (nums.isArray()) for (let i = 0; i + 1 < nums.length; i += 2) if (nums.get(i).asNumber() === key) return nums.get(i + 1);
  const kids = node.get("Kids");
  if (kids.isArray())
    for (let i = 0; i < kids.length; i++) {
      const found = numberTreeGet(kids.get(i), key, depth + 1);
      if (found) return found;
    }
  return null;
}

/** Removes `key` from a number tree. */
function numberTreeDelete(node: Obj, key: number, depth = 0) {
  if (!node.isDictionary() || depth > 32) return;
  const nums = node.get("Nums");
  if (nums.isArray())
    for (let i = nums.length - 2; i >= 0; i -= 2)
      if (nums.get(i).isNumber() && nums.get(i).asNumber() === key) {
        nums.delete(i + 1);
        nums.delete(i);
      }
  node.get("Kids").forEach((kid) => numberTreeDelete(kid, key, depth + 1));
}

/**
 * An annotation leaves the structure tree: its element's object reference, and its ParentTree key;
 * the element loses its descriptions (of the link, field or note: forget).
 */
function untagAnnotation(doc: Doc, annot: Obj) {
  const sp = annot.get("StructParent");
  if (!sp.isNumber()) return;
  try {
    const tree = doc.getTrailer().get("Root", "StructTreeRoot", "ParentTree");
    const elem = numberTreeGet(tree, sp.asNumber());
    if (elem?.isDictionary()) {
      forget(elem);
      const isRef = (x: Obj) => x.isDictionary() && nameOf(x.get("Type")) === "OBJR" && identity(x.get("Obj")) === identity(annot);
      const k = elem.get("K");
      if (k.isArray()) {
        for (let i = k.length - 1; i >= 0; i--) if (isRef(k.get(i))) k.delete(i);
      } else if (isRef(k)) elem.delete("K");
    }
    numberTreeDelete(tree, sp.asNumber());
  } catch {
    // a structure tree that cannot be read: the references are cut all the same (cutReferences)
  }
}

/**
 * A structure element whose content the redaction changed or took loses its descriptions and its
 * title, and so does every element above it: an ancestor's /ActualText or /Alt stands for its
 * whole subtree, what went included (privacy over the descriptions of what stays).
 */
function forget(elem: Obj) {
  const seen = new Set<string>();
  for (let node = elem, depth = 0; node.isDictionary() && node.get("S").isName() && depth < 64 && !seen.has(identity(node)); node = node.get("P"), depth++) {
    seen.add(identity(node));
    for (const k of ELEMENT_KEYS) node.delete(k);
  }
}

/**
 * The pictures and forms among `gone` (identity keys of what the pages listed before and no
 * longer do) that no resources list now (pruneUnused `kept` those something draws by name), but
 * those an annotation shows as its appearance.
 */
function leftXObjects(doc: Doc, gone: Set<string>, kept: Set<string>): Set<number> {
  const out = new Set<number>();
  for (const key of gone) {
    if (!key.startsWith("n") || kept.has(key)) continue;
    const n = Number(key.slice(1)), o = doc.newIndirect(n);
    const subtype = o.isStream() ? nameOf(o.get("Subtype")) : null;
    if (subtype === "Image" || subtype === "Form") out.add(n);
  }
  for (let i = 0, count = out.size ? doc.countPages() : 0; i < count; i++)
    for (const e of annotEntries(doc.findPage(i))) if (!e.isNull()) for (const ap of appearances(e.resolve())) if (ap.isIndirect()) out.delete(ap.asIndirect());
  return out;
}

/**
 * The pictures and forms (object numbers) something still draws, asked for those of `left` (no
 * resources list them now): what each page's content uses by name, its annotations' appearances
 * and its /Thumb, through the forms, patterns, Type 3 fonts and soft masks' groups so named (and
 * the names their own content uses), and a picture's /SMask, /Mask and /Alternates; the Type 3
 * fonts of the form fields' default resources (a field's /DA names fonts alone). An
 * entry a dictionary lists and no content names draws nothing; nor does the /Alternates of a
 * picture only the `redacted` pages draw (never shown, it would keep an original of the area alive
 * from the page redacted). Nothing else counts (a structure tree's reference least of all): what
 * only such a reference holds is cut. Throws Unsure when only content that cannot be read for sure
 * could still draw one of `left`, or past MAX_CLEANUP_OPERATIONS read in all (each stream once:
 * many pages may share one), as the cleanup refuses past them.
 */
function stillDrawn(doc: Doc, left: Set<number>, redacted: Set<number>): Set<number> {
  const read = namesReader(MAX_CLEANUP_OPERATIONS);
  /** What is drawn when content draws every name its resources list ("listed": nothing read, more than the others), the names it uses ("used"; none for content that cannot be read), or those and every name for that content ("lenient"). */
  const drawnBy = (mode: "listed" | "used" | "lenient") => {
    const out = new Set<number>(), seen = new Set<string>(), queue: [Obj, Obj | null][] = [];
    let unsure = false, alternates = true;
    /** `o` is drawn (with `res`: a Type 3 glyph, its font's resources). */
    const reach = (o: Obj, res: Obj | null = null) => {
      if ((!o.isDictionary() && !o.isStream()) || seen.has(identity(o))) return;
      seen.add(identity(o));
      queue.push([o, res]);
    };
    /** What `contents` (and `annots`' appearances) draw with the resources `res`. */
    const drawsWith = (res: Obj, contents: Obj[], annots: Obj | null, all = mode === "listed") => {
      if (!res.isDictionary()) return;
      let used: ReturnType<typeof namesUsed> | null = null;
      if (!all)
        try {
          used = namesUsed(res, contents, annots, read);
        } catch (err) {
          if (!(err instanceof Unsure)) throw err;
          unsure = true;
          if (mode === "used") return;
        }
      const named = (kind: ResourceKind, take: (v: Obj, k: string) => void) => lookup(res, kind).forEach((v, k) => { if (!used || used[kind].has(String(k))) take(v, String(k)); });
      named("XObject", (xo) => reach(xo));
      named("Pattern", (pattern) => reach(pattern));
      // (the glyphs shown, of a font with resources of its own: namesUsed read the others')
      named("Font", (font, k) => {
        const own = lookup(font, "Resources");
        if (nameOf(lookup(font, "Subtype")) !== "Type3" || !own.isDictionary()) return;
        const shown = used ? shownGlyphs(font, k, used) : "all";
        lookup(font, "CharProcs").forEach((proc, glyph) => { if (shown === "all" || shown.has(String(glyph))) reach(proc, own); });
      });
      named("ExtGState", (eg) => reach(lookup(eg, "SMask", "G")));
    };
    const drain = () => {
      while (queue.length) {
        const [o, res] = queue.pop()!, subtype = nameOf(o.get("Subtype"));
        if (o.isStream() && o.isIndirect()) out.add(o.asIndirect());
        if (subtype === "Image") {
          reach(o.get("SMask"));
          reach(o.get("Mask")); // (a stencil; a colour key is an array)
          if (alternates) lookup(o, "Alternates").forEach((alt) => reach(lookup(alt, "Image")));
        } else drawsWith(res ?? o.get("Resources"), [o], null); // (content without resources of its own was read with its user's)
      }
    };
    const page = (i: number) => {
      const pageObj = doc.findPage(i);
      drawsWith(pageObj.getInheritable("Resources"), contentStreams(pageObj), pageObj.get("Annots"));
      reach(pageObj.get("Thumb"));
      for (const e of annotEntries(pageObj)) if (!e.isNull()) appearances(e.resolve()).forEach((ap) => reach(ap));
      drain();
    };
    for (let i = 0, count = doc.countPages(); i < count; i++) if (!redacted.has(i)) page(i);
    // (a field's /DA names fonts alone: nothing else the fields' resources list is drawn)
    lookup(doc.getTrailer().get("Root", "AcroForm", "DR"), "Font").forEach((font) => {
      if (nameOf(lookup(font, "Subtype")) === "Type3") lookup(font, "CharProcs").forEach((proc) => reach(proc, lookup(font, "Resources")));
    });
    drain();
    // What only the redacted pages draw, last: its /Alternates are not followed.
    alternates = false;
    for (const i of redacted) page(i);
    return { out, unsure };
  };
  const listed = drawnBy("listed").out;
  if (![...left].some((n) => listed.has(n))) return listed;
  const used = drawnBy("used");
  if (used.unsure) {
    const lenient = drawnBy("lenient").out;
    if ([...left].some((n) => lenient.has(n) && !used.out.has(n))) throw new Unsure();
  }
  return used.out;
}

/**
 * The structure tree after the edit: an object reference (OBJR /Obj) or a reference to marked
 * content in a form (MCR /Stm) naming a picture or form of `left` (no resources list it now) names
 * the copy MuPDF drew in its place, when there is one; otherwise it leaves its element (an OBJR
 * with its ParentTree key), and the element loses its descriptions (forget). Left as they are, they
 * would keep the original, with what was under the area, in the saved file (or, for one another
 * page still draws as a mask, tagged as the redacted page's).
 */
function retag(doc: Doc, copies: Map<number, Obj>, left: Set<number>) {
  const root = doc.getTrailer().get("Root", "StructTreeRoot");
  if (!left.size || !root.isDictionary()) return;
  const tree = root.get("ParentTree");
  const seen = new Set<string>();
  const visit = (elem: Obj, depth: number) => {
    if (depth > 64 || seen.has(identity(elem))) return;
    seen.add(identity(elem));
    const k = elem.get("K"), items: Obj[] = [], keep: Obj[] = [];
    if (k.isArray()) for (let i = 0; i < k.length; i++) items.push(k.get(i));
    else if (!k.isNull()) items.push(k);
    for (const item of items) {
      const type = item.isDictionary() ? nameOf(item.get("Type")) : null;
      const key = type === "OBJR" ? "Obj" : type === "MCR" ? "Stm" : null;
      const target = key ? item.get(key) : null;
      if (key && target?.isIndirect() && left.has(target.asIndirect())) {
        const copy = copies.get(target.asIndirect());
        if (copy) item.put(key, copy);
        else {
          const sp = target.get("StructParent");
          if (type === "OBJR" && sp.isNumber()) numberTreeDelete(tree, sp.asNumber());
          continue;
        }
      } else if (!key && item.isDictionary()) visit(item, depth + 1);
      keep.push(item);
    }
    if (keep.length === items.length) return;
    forget(elem);
    if (!keep.length) elem.delete("K");
    else {
      const list = doc.newArray();
      for (const x of keep) list.push(x);
      elem.put("K", list);
    }
  };
  try {
    visit(root, 0);
  } catch {
    // a structure tree that cannot be read: the references are cut all the same (cutReferences)
  }
}

// ---------------------------------------------------------------------------------------------
// Pictures (Oscura)

/** Whether a picture was stored as a JPEG. */
function isJpeg(xo: Obj): boolean {
  const f = xo.get("Filter");
  if (f.isName()) return f.asName() === "DCTDecode";
  if (!f.isArray()) return false;
  for (let k = 0; k < f.length; k++) if (nameOf(f.get(k)) === "DCTDecode") return true;
  return false;
}

/** A colour space's number of components, when it is DeviceGray, DeviceRGB, DeviceCMYK or an ICC profile of 1, 3 or 4 (what a JPEG takes); null otherwise. */
function jpegComponents(cs: Obj): 1 | 3 | 4 | null {
  const name = nameOf(cs);
  if (name === "DeviceGray") return 1;
  if (name === "DeviceRGB") return 3;
  if (name === "DeviceCMYK") return 4;
  if (cs.isArray() && cs.length === 2 && nameOf(cs.get(0)) === "ICCBased") {
    const n = cs.get(1).isStream() ? cs.get(1).get("N") : cs.get(1);
    if (n.isNumber() && [1, 3, 4].includes(n.asNumber())) return n.asNumber() as 1 | 3 | 4;
  }
  return null;
}

/** Whether a colour space is an ICC profile of Lab (as MuPDF writes Lab). */
const labProfile = (cs: Obj) => cs.isArray() && cs.length === 2 && cs.get(1).isStream() && latin1(streamBytes(cs.get(1)).subarray(16, 20)) === "Lab ";

/** An Artifex profile MuPDF attached becomes the device space of its kind (images.deviceSpace), but a Lab one (no device space is Lab). */
function deviceColours(doc: Doc, target: Obj) {
  const cs = target.get("ColorSpace");
  if (labProfile(cs)) return;
  const device = deviceSpace(cs, true);
  if (device) target.put("ColorSpace", doc.newName(device));
}

/** The stored bytes of a stream (for the growth estimate). */
function storedLength(xo: Obj): number {
  const buf = xo.readRawStream();
  try {
    return buf.getLength();
  } finally {
    buf.destroy();
  }
}

/**
 * Sets to `value` the samples of a picture (`w` × `h`, `n` per pixel, rows as stored) that `rects`
 * meet, the picture drawn at `m` (ImageInfo convention: the unit square, (0, 0) the first stored
 * sample). A sample goes when its square on the page (its bounds) meets a rect: more than the
 * area rather than less.
 */
function clearUnder(samples: Uint8Array, w: number, h: number, n: number, m: Matrix, rects: Rect[], value: number) {
  const inv = invert(m);
  // Half a sample's extent on the page.
  const hx = (Math.abs(m[0]) / w + Math.abs(m[2]) / h) / 2, hy = (Math.abs(m[1]) / w + Math.abs(m[3]) / h) / 2;
  for (const r of rects) {
    const corners = [applyTo(inv, r[0], r[1]), applyTo(inv, r[2], r[1]), applyTo(inv, r[0], r[3]), applyTo(inv, r[2], r[3])];
    const b = bboxOf(corners);
    const x0 = Math.max(0, Math.floor(b[0] * w) - 1), x1 = Math.min(w, Math.ceil(b[2] * w) + 1);
    const y0 = Math.max(0, Math.floor(b[1] * h) - 1), y1 = Math.min(h, Math.ceil(b[3] * h) + 1);
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const [px, py] = applyTo(m, (x + 0.5) / w, (y + 0.5) / h);
        if (px + hx <= r[0] || px - hx >= r[2] || py + hy <= r[1] || py - hy >= r[3]) continue;
        samples.fill(value, (y * w + x) * n, (y * w + x + 1) * n);
      }
  }
}

/** A soft mask with its samples under `rects` (all of them, without `m`) cleared (0: nothing of the picture shows there), as a new 8-bit DeviceGray object. */
function clearedMask(mupdf: MuPDFModule, doc: Doc, mask: Obj, m: Matrix | null, rects: Rect[]): Obj {
  const image = doc.loadImage(mask);
  let pix: MuPDF.Pixmap;
  try {
    pix = image.toPixmap();
  } finally {
    image.destroy();
  }
  let samples: Uint8Array, w: number, h: number;
  try {
    w = pix.getWidth();
    h = pix.getHeight();
    const stride = pix.getStride(), n = stride / w, px = pix.getPixels();
    samples = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) samples[y * w + x] = px[y * stride + x * n];
  } finally {
    pix.destroy();
  }
  if (m) clearUnder(samples, w, h, 1, m, rects, 0);
  else samples.fill(0);
  const buf = new mupdf.Buffer(samples);
  try {
    const out = doc.addStream(buf, {});
    out.put("Type", doc.newName("XObject"));
    out.put("Subtype", doc.newName("Image"));
    out.put("Width", w);
    out.put("Height", h);
    out.put("ColorSpace", doc.newName("DeviceGray"));
    out.put("BitsPerComponent", 8);
    const matte = mask.get("Matte");
    if (!matte.isNull()) out.put("Matte", matte);
    return out;
  } finally {
    buf.destroy();
  }
}

/** The pictures (image XObjects) from object `n0` on that the page's resources list, its forms' too: what the redaction made. */
function newPictures(pageObj: Obj, n0: number): Obj[] {
  const out: Obj[] = [];
  const seen = new Set<string>();
  const visit = (res: Obj, depth: number) => {
    if (!res.isDictionary() || depth > 16 || seen.has(identity(res))) return;
    seen.add(identity(res));
    lookup(res, "XObject").forEach((xo) => {
      if (!xo.isStream()) return;
      const subtype = nameOf(xo.get("Subtype"));
      if (subtype === "Image" && xo.isIndirect() && xo.asIndirect() >= n0) out.push(xo);
      else if (subtype === "Form") visit(xo.get("Resources"), depth + 1);
    });
  };
  visit(pageObj.getInheritable("Resources"), 0);
  return out;
}

/**
 * The pictures the redaction replaced (new objects, from `n0` on) are fixed (fixPicture). Each is
 * found by the walk after the redaction and matched, in order, with the picture drawn before at
 * the same matrix (MuPDF moves nothing), whose keys come back. Its soft mask is cleared under the
 * area at the walk's matrix when MuPDF draws the picture there too; one MuPDF does not draw (a
 * hidden layer's), or that the walk does not find, has its soft mask cleared whole.
 */
function fixPictures(mupdf: MuPDFModule, doc: Doc, page: MuPDF.PDFPage, before: Walked, rects: Rect[], n0: number, run: Run) {
  const after = walkedPictures(page) ?? [];
  let drawn: { matrix: Matrix }[] = [];
  try {
    drawn = findPlacements(mupdf, page).placements; // as MuPDF draws them (the walk's own when they agree)
  } catch {
    // MuPDF cannot draw them: every soft mask is cleared whole
  }
  const done = new Set<number>();
  let next = 0;
  for (const a of after) {
    let k = next;
    while (k < before.length && !nearlyEqual(before[k].matrix, a.matrix)) k++;
    const old = k < before.length ? before[k].xobject : null;
    if (k < before.length) next = k + 1;
    const N = a.xobject;
    if (!N || !N.isIndirect() || N.asIndirect() < n0 || done.has(N.asIndirect())) continue;
    done.add(N.asIndirect());
    fixPicture(mupdf, doc, N, old, drawn.some((p) => nearlyEqual(p.matrix, a.matrix)) ? a.matrix : null, rects, run);
  }
  for (const N of newPictures(page.getObject(), n0)) {
    if (done.has(N.asIndirect())) continue;
    done.add(N.asIndirect());
    fixPicture(mupdf, doc, N, null, null, rects, run);
  }
}

/** A colour space's number of components (an indexed one's samples are its indices: one), null when it is none of these. */
function componentsOf(cs: Obj): number | null {
  const kind = cs.isArray() && cs.length > 0 ? nameOf(cs.get(0)) : nameOf(cs);
  if (kind === "DeviceGray" || kind === "CalGray" || kind === "Indexed" || kind === "G" || kind === "I") return 1;
  if (kind === "DeviceRGB" || kind === "CalRGB" || kind === "Lab" || kind === "RGB") return 3;
  if (kind === "DeviceCMYK" || kind === "CMYK") return 4;
  const n = kind === "ICCBased" && cs.length === 2 ? cs.get(1).get("N") : null;
  return n?.isNumber() ? n.asNumber() : null;
}

/**
 * MuPDF's copy `N` of a picture `O` masked by a colour key (its /Mask array) holds the key as an
 * /SMask, over samples it made black where the key hid them: drawn smaller, every shape the key
 * cut gets a dark edge. So the key comes back instead, over the old picture's own samples (its
 * colour space, an indexed one's palette, its bits and /Decode with them): the samples the cleared
 * mask hides (the area's among them) take the key's lowest values (as stored: a key is compared
 * before /Decode), and the /SMask goes. Not for a JPEG's or JPX's samples, which are not exact
 * (their shapes keep a dark edge outside the area: nothing of the area's is left).
 */
function keyBack(mupdf: MuPDFModule, doc: Doc, N: Obj, O: Obj): boolean {
  const key = O.get("Mask"), mask = N.get("SMask"), bpc = O.get("BitsPerComponent");
  const w = N.get("Width").asNumber(), h = N.get("Height").asNumber();
  const comps = componentsOf(O.get("ColorSpace")), bits = bpc.isNumber() ? bpc.asNumber() : 0;
  const isJpx = O.get("Filter").toString().includes("JPXDecode");
  if (!comps || key.length !== 2 * comps || ![1, 2, 4, 8, 16].includes(bits) || !mask.isStream() || isJpeg(O) || isJpx) return false;
  if (O.get("Width").asNumber() !== w || O.get("Height").asNumber() !== h) return false;
  const stride = Math.ceil((w * comps * bits) / 8), max = 2 ** bits - 1;
  let hidden: Uint8Array, samples: Uint8Array;
  try {
    hidden = streamBytes(mask);
    samples = streamBytes(O);
  } catch {
    return false;
  }
  if (hidden.length !== w * h || samples.length !== stride * h) return false;
  const low = Array.from({ length: comps }, (_, c) => key.get(2 * c).asNumber());
  if (!low.every((v, c) => Number.isInteger(v) && v >= 0 && v <= Math.min(max, key.get(2 * c + 1).asNumber()))) return false;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (hidden[y * w + x] >= 128) continue;
      for (let c = 0; c < comps; c++) {
        const bit = (x * comps + c) * bits, o = y * stride + (bit >> 3), v = low[c];
        if (bits === 16) samples.set([v >> 8, v & 255], o);
        else if (bits === 8) samples[o] = v;
        else {
          const shift = 8 - bits - (bit & 7);
          samples[o] = (samples[o] & ~(max << shift)) | (v << shift);
        }
      }
    }
  const buf = new mupdf.Buffer(samples);
  try {
    N.writeStream(buf);
  } finally {
    buf.destroy();
  }
  for (const k of ["ColorSpace", "BitsPerComponent", "Decode"]) {
    const v = O.get(k);
    if (v.isNull()) N.delete(k);
    else N.put(k, v);
  }
  const copy = doc.newArray();
  key.forEach((v) => copy.push(v));
  N.put("Mask", copy);
  N.delete("SMask");
  return true;
}

/** Whether a picture drawn at `m` is turned on the page by other than right angles, or slanted. */
function turned(m: Matrix): boolean {
  const off = (a: number, b: number) => Math.min(Math.abs(a), Math.abs(b)) > 1e-4 * Math.max(Math.abs(a), Math.abs(b));
  return off(m[0], m[1]) || off(m[2], m[3]);
}

/**
 * 8-bit samples (`n` per pixel) at `bits` per sample, rows padded to whole bytes as PDF stores
 * them; a stencil's (`stencil`: 255 where it paints) as an /ImageMask takes them, 0 where it paints.
 */
function packed(samples: Uint8Array, w: number, h: number, n: number, bits: number, stencil: boolean): Uint8Array {
  const max = 2 ** bits - 1, stride = Math.ceil((w * n * bits) / 8), out = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++)
    for (let k = 0; k < w * n; k++) {
      const s = samples[y * w * n + k], bit = k * bits;
      out[y * stride + (bit >> 3)] |= (stencil ? +(s < 128) : Math.round((s * max) / 255)) << (8 - bits - (bit & 7));
    }
  return out;
}

/**
 * A picture drawn turned: MuPDF whitens the samples under the area's bounds in the picture's own
 * space, which reach outside the area (white wedges beside the box). So the new picture `N`
 * (`n` components, or a stencil, drawn at `m`) takes the old picture's samples again, decoded,
 * those under the area (clearUnder: more than the area rather than less) white, or for a stencil
 * not painted, at N's own bits (MuPDF keeps a bilevel scan's 1 bit: the old samples, exactly).
 */
function samplesBack(mupdf: MuPDFModule, doc: Doc, N: Obj, O: Obj, n: 1 | 3 | 4, m: Matrix, rects: Rect[]) {
  const w = N.get("Width").asNumber(), h = N.get("Height").asNumber();
  const stencil = N.get("ImageMask").isBoolean() && N.get("ImageMask").asBoolean();
  const bits = N.get("BitsPerComponent").isNumber() ? N.get("BitsPerComponent").asNumber() : stencil ? 1 : 8;
  const image = doc.loadImage(O);
  let pix: MuPDF.Pixmap;
  try {
    pix = image.toPixmap();
  } finally {
    image.destroy();
  }
  let own: MuPDF.Pixmap | null = null;
  try {
    // (a stencil's pixmap is its alpha alone)
    if (pix.getWidth() !== w || pix.getHeight() !== h || (stencil && pix.getStride() !== w)) return;
    if (!stencil && (pix.getAlpha() || pix.getNumberOfComponents() !== n))
      own = pix.convertToColorSpace([mupdf.ColorSpace.DeviceGray, mupdf.ColorSpace.DeviceRGB, mupdf.ColorSpace.DeviceCMYK][[1, 3, 4].indexOf(n)], false);
    const p = own ?? pix, stride = p.getStride(), px = p.getPixels();
    const samples = new Uint8Array(w * h * n);
    for (let y = 0; y < h; y++) samples.set(px.subarray(y * stride, y * stride + w * n), y * w * n);
    clearUnder(samples, w, h, n, m, rects, stencil || n === 4 ? 0 : 255);
    const buf = new mupdf.Buffer(bits === 8 ? samples : packed(samples, w, h, n, bits, stencil));
    try {
      N.writeStream(buf);
    } finally {
      buf.destroy();
    }
  } finally {
    own?.destroy();
    pix.destroy();
  }
}

/**
 * One new picture `N` (from the old `O`, when known): MuPDF's profiles become device colour spaces,
 * its soft mask is cleared under `rects` where it is drawn at `m` (wholly, without `m`), a colour
 * key comes back (keyBack), the old picture's /OC, /PEOrientation and /StructParent (with the
 * structure's reference) come back, and a picture that was a JPEG is one again. Adds to
 * `run.growth` about what it adds to a download.
 */
function fixPicture(mupdf: MuPDFModule, doc: Doc, N: Obj, O: Obj | null, m: Matrix | null, rects: Rect[], run: Run) {
  run.picturesFixed++;
  deviceColours(doc, N);
  const mask = N.get("SMask");
  if (mask.isStream()) {
    // (drawn turned, MuPDF's copy is whitened past the area as the samples are: the old one, a soft
    // mask or a stencil /Mask, is cleared instead)
    const own = O && m && turned(m) ? [O.get("SMask"), O.get("Mask")].find((x) => x.isStream()) : undefined;
    N.put("SMask", clearedMask(mupdf, doc, own ?? mask, m, rects));
    run.growth += Math.round(N.get("Width").asNumber() * N.get("Height").asNumber() * 0.1); // shortcut: a mask deflates to about a tenth; measure if it ever matters
  }
  // (a soft mask of its own wins over the key: MuPDF's copy holds that one)
  const keyed = !!O?.get("Mask").isArray() && !O.get("SMask").isStream() && keyBack(mupdf, doc, N, O);
  if (O) {
    for (const key of ["OC", "PEOrientation"]) {
      const v = O.get(key);
      if (!v.isNull()) N.put(key, v);
    }
    const sp = O.get("StructParent");
    if (sp.isNumber()) {
      N.put("StructParent", sp);
      const elem = numberTreeGet(doc.getTrailer().get("Root", "StructTreeRoot", "ParentTree"), sp.asNumber());
      const k = elem?.isDictionary() ? elem.get("K") : null;
      const repoint = (x: Obj) => { if (x.isDictionary() && identity(x.get("Obj")) === identity(O)) x.put("Obj", N); };
      if (k?.isArray()) for (let i = 0; i < k.length; i++) repoint(k.get(i));
      else if (k) repoint(k);
    }
  }
  const w = N.get("Width").asNumber(), h = N.get("Height").asNumber();
  const old = O ? storedLength(O) : 0;
  const comps = jpegComponents(N.get("ColorSpace"));
  const stencil = N.get("ImageMask").isBoolean() && N.get("ImageMask").asBoolean();
  const bits = N.get("BitsPerComponent").isNumber() ? N.get("BitsPerComponent").asNumber() : stencil ? 1 : 8;
  const exact = [1, 2, 4, 8].includes(bits) && N.get("Decode").isNull();
  const plain = exact && bits === 8 && !stencil;
  // shortcut: a Lab picture keeps MuPDF's white wedges (its white is not all ones); decode its white if one shows up
  if (O && m && !keyed && (stencil || comps) && exact && turned(m) && !labProfile(N.get("ColorSpace"))) samplesBack(mupdf, doc, N, O, stencil ? 1 : comps!, m, rects);
  if (O && isJpeg(O) && comps && plain) {
    const data = N.readStream();
    try {
      const bytes = data.asUint8Array();
      if (bytes.length === w * h * comps) {
        const pix = new mupdf.Pixmap([mupdf.ColorSpace.DeviceGray, mupdf.ColorSpace.DeviceRGB, mupdf.ColorSpace.DeviceCMYK][[1, 3, 4].indexOf(comps)], [0, 0, w, h], false);
        try {
          if (pix.getStride() === w * comps) {
            pix.getPixels().set(bytes);
            // (CMYK as PDF takes it: not inverted as Adobe's JPEG files are, which a /Decode would undo)
            const jpeg = pix.asJPEG(JPEG_QUALITY, false);
            const buf = new mupdf.Buffer(jpeg);
            try {
              N.writeRawStream(buf);
            } finally {
              buf.destroy();
            }
            N.put("Filter", doc.newName("DCTDecode"));
            N.delete("DecodeParms");
            run.growth += Math.max(0, jpeg.length - old);
            return;
          }
        } finally {
          pix.destroy();
        }
      }
    } finally {
      data.destroy();
    }
  }
  // A lossless original comes back about as big; another (a JPEG MuPDF cannot write back, JPX, a
  // fax scan) about half its samples. shortcut: an estimate for the "much bigger" warning, not a measure.
  const lossless = O && ["FlateDecode", "LZWDecode", "RunLengthDecode"].some((f) => O.get("Filter").toString().includes(f));
  const samples = (w * h * (N.get("ImageMask").isBoolean() ? 1 : (componentsOf(N.get("ColorSpace")) ?? 3)) * bits) / 8;
  if (!lossless) run.growth += Math.max(0, Math.round(samples / 2) - old);
}

// ---------------------------------------------------------------------------------------------
// Soft masks

/** A dictionary with the same entries (an empty one for the null object). */
function copyOf(doc: Doc, dict: Obj): Obj {
  const out = doc.newDictionary();
  dict.forEach((v, k) => out.put(k, v));
  return out;
}

/**
 * The soft masks the page's content sets whose group's box (where it is set) meets an area; null
 * when the walk cannot read the page. A graphics state one content (`content` tells it) sets under
 * different CTMs is left out when its group draws nothing under the area at any of them (a reused
 * shadow): one redacted group could not serve them all, and setTwice refuses those left.
 */
function masksOver(mupdf: MuPDFModule, page: MuPDF.PDFPage, rects: Rect[], content: (u: SoftMaskUse) => string): SoftMaskUse[] | null {
  const over = walkedSoftMasks(page)?.filter((u) => {
    const bb = u.group.get("BBox");
    if (!bb.isArray() || bb.length !== 4) return true;
    const v = [0, 1, 2, 3].map((k) => bb.get(k).asNumber());
    if (!v.every(Number.isFinite)) return true;
    const m = concat(matrixOf(u.group.get("Matrix")), u.ctm);
    const box = bboxOf([applyTo(m, v[0], v[1]), applyTo(m, v[2], v[1]), applyTo(m, v[0], v[3]), applyTo(m, v[2], v[3])]);
    return rects.some((r) => meets(box, r));
  });
  if (!over) return null;
  const byState = new Map<string, SoftMaskUse[]>();
  for (const u of over) {
    const key = `${content(u)}|${u.name}`, uses = byState.get(key);
    if (uses) uses.push(u);
    else byState.set(key, [u]);
  }
  const idle = new Set<SoftMaskUse>();
  for (const uses of byState.values())
    if (setTwice(uses, content) && !groupDrawsUnder(mupdf, uses[0].group, uses.map((u) => u.ctm), rects)) uses.forEach((u) => idle.add(u));
  return over.filter((u) => !idle.has(u));
}

/**
 * Whether a soft mask's group draws anything under the areas where it is set at any of `ctms`
 * (page space): text (invisible too), line art, a picture, a pattern fill, a gradient (by the clip
 * it fills: the group's box at least), or a soft mask of its own (which a pass need not run:
 * counted). It is drawn alone, as a page of a scratch document
 * (the one worked on is untouched), where every layer shows: that one has no /OCProperties.
 * Content that cannot be read counts.
 */
function groupDrawsUnder(mupdf: MuPDFModule, group: Obj, ctms: Matrix[], rects: Rect[]): boolean {
  const scratch = new mupdf.PDFDocument();
  try {
    scratch.insertPage(-1, scratch.addPage([0, 0, 1, 1], 0, { XObject: { [MASK_GROUP]: scratch.graftObject(group) } }, `/${MASK_GROUP} Do`));
    const page = scratch.loadPage(0);
    try {
      if (walkedSoftMasks(page)?.length !== 0) return true;
      let under = false, tile = 0;
      const g = guarded();
      const at = (b: Rect) => { if (!tile && rects.some((r) => meets(b, r))) under = true; };
      /** For each clip in effect, the area it and those under it leave (the bottom: no clip; the group's box is the first). */
      const clips: Rect[] = [[-Infinity, -Infinity, Infinity, Infinity]];
      /** A clip pushed (always, so that popClip stays in step), counted as drawn there when `drawn`. */
      const clip = (bounds: Rect | null, drawn: boolean) => {
        const t = clips[clips.length - 1];
        clips.push(bounds ? [Math.max(t[0], bounds[0]), Math.max(t[1], bounds[1]), Math.min(t[2], bounds[2]), Math.min(t[3], bounds[3])] : t);
        if (bounds && drawn) at(bounds);
      };
      const dev = new mupdf.Device({
        fillPath(p, _evenOdd, ctm, cs) { g.attempt(() => at(p.getBounds(NO_STROKE, ctm) as Rect), p, cs); },
        strokePath(p, stroke, ctm, cs) { g.attempt(() => at(p.getBounds(stroke, ctm) as Rect), p, stroke, cs); },
        fillText(t, ctm, cs) { g.attempt(() => at(t.getBounds(NO_STROKE, ctm) as Rect), t, cs); },
        strokeText(t, stroke, ctm, cs) { g.attempt(() => at(t.getBounds(stroke, ctm) as Rect), t, stroke, cs); },
        ignoreText(t, ctm) { g.attempt(() => at(t.getBounds(NO_STROKE, ctm) as Rect), t); },
        fillImage(img, ctm) { g.attempt(() => at(unitBounds(ctm as Matrix)), img); },
        fillImageMask(img, ctm, cs) { g.attempt(() => at(unitBounds(ctm as Matrix)), img, cs); },
        clipPath(p, _evenOdd, ctm) { clip(g.attempt(() => p.getBounds(NO_STROKE, ctm) as Rect, p) ?? null, false); },
        clipStrokePath(p, stroke, ctm) { clip(g.attempt(() => p.getBounds(stroke, ctm) as Rect, p, stroke) ?? null, false); },
        clipText(t, ctm) { clip(g.attempt(() => t.getBounds(NO_STROKE, ctm) as Rect, t) ?? null, true); },
        clipStrokeText(t, stroke, ctm) { clip(g.attempt(() => t.getBounds(stroke, ctm) as Rect, t, stroke) ?? null, true); },
        clipImageMask(img, ctm) { clip(g.attempt(() => unitBounds(ctm as Matrix), img) ?? null, true); },
        popClip() { if (clips.length > 1) clips.pop(); },
        // A gradient (sh, or a shading pattern's fill) paints the clip it is under. MuPDF.js 1.27
        // wraps the shade without taking a reference: its finalizer is taken off, so it never drops one.
        fillShade(shade) {
          g.attempt(() => at(clips[clips.length - 1]));
          try {
            (shade.constructor as unknown as { _finalizer: FinalizationRegistry<number> })._finalizer.unregister(shade);
          } catch {}
        },
        beginTile(area, _view, _xstep, _ystep, ctm) {
          if (!tile) at(mupdf.Rect.transform(area, ctm) as Rect);
          tile++;
          return 0;
        },
        endTile() { tile--; },
        beginMask(_area, _luminosity, cs) { g.attempt(() => {}, cs); clip(null, false); },
      });
      try {
        // (the scratch page's own transform undone: what it draws lands where `ctm` puts the group)
        const T = page.getTransform() as Matrix;
        for (const ctm of ctms) if (!under) page.runPageContents(dev, concat(invert(T), ctm));
        dev.close();
      } finally {
        dev.destroy();
      }
      return under || g.failed;
    } finally {
      page.destroy();
    }
  } finally {
    scratch.destroy();
  }
}

/** Whether two of `uses` set one graphics state in the same content (`content` tells it) under different CTMs: one redacted group cannot serve both. */
function setTwice(uses: SoftMaskUse[], content: (u: SoftMaskUse) => string): boolean {
  const ctms = new Map<string, Matrix>();
  for (const u of uses) {
    const key = `${content(u)}|${u.name}`;
    const ctm = ctms.get(key);
    if (ctm && !nearlyEqual(ctm, u.ctm)) return true;
    ctms.set(key, u.ctm);
  }
  return false;
}

const locked = (pageIndex: number) => new RedactError(REFUSALS.locked, "not-editable", "locked", pageIndex);

/**
 * Step 6b, when the checks found a soft mask's group drawing under the area: MuPDF's redaction
 * filters what is painted through a mask, not the mask, and keeps the gs that sets it, so the
 * group's text and pictures there would stay in the file. Each group set over the area is
 * redacted too (redactGroup), and the graphics state, copied, names the redacted copy, in a copy
 * of the resources of the content that sets it (the page, or a form MuPDF copied for it). Throws
 * RedactError "locked" (the session rolls the edit back) when the content after the redaction does
 * not let that be done as the checks found.
 */
function redactSoftMasks(mupdf: MuPDFModule, doc: Doc, pageIndex: number, rects: Rect[], mode: RedactMode, run: Run, n0: number, depth = 0) {
  const pageObj = doc.findPage(pageIndex);
  const page = doc.loadPage(pageIndex);
  const setter = (u: SoftMaskUse) => (u.host ? identity(u.host) : "page");
  let over: SoftMaskUse[] | null, T: Matrix;
  try {
    over = masksOver(mupdf, page, rects, setter);
    T = page.getTransform() as Matrix;
  } finally {
    page.destroy();
  }
  if (!over || setTwice(over, setter) || (over.length && depth > 4)) throw locked(pageIndex);
  const done = new Set<string>();
  for (const u of over) {
    // (MuPDF copies every form the page draws, once for each time: a form set it, a copy of its own)
    if (u.host && (!u.host.isIndirect() || u.host.asIndirect() < n0)) throw locked(pageIndex);
    const owner = u.host ?? pageObj, key = `${identity(owner)}|${u.name}`;
    if (done.has(key)) continue;
    done.add(key);
    const group = redactGroup(mupdf, doc, pageIndex, u, concat(u.ctm, invert(T)), rects, mode, run, depth);
    const state = copyOf(doc, u.extGState), mask = copyOf(doc, u.extGState.get("SMask"));
    mask.put("G", group);
    state.put("SMask", mask);
    const own = owner.get("Resources");
    const current = owner === pageObj ? pageObj.getInheritable("Resources") : own.isDictionary() ? own : u.resources;
    const res = copyOf(doc, current), states = copyOf(doc, lookup(current, "ExtGState"));
    states.put(u.name, state);
    res.put("ExtGState", states);
    owner.put("Resources", res);
  }
}

/**
 * The group of soft mask `u`, redacted as the page's content is, by drawing it as the page's
 * content for a moment (MuPDF redacts pages only): the same page, so the same page space and rects,
 * the group drawn at `ctm` (user space, the CTM at the gs) with the resources in effect there. Its
 * pictures (Oscura), descriptions, unused resources and own soft masks are seen to as the page's
 * are. Returns the copy MuPDF made; the page's content, resources and annotations come back as
 * they were.
 */
function redactGroup(mupdf: MuPDFModule, doc: Doc, pageIndex: number, u: SoftMaskUse, ctm: Matrix, rects: Rect[], mode: RedactMode, run: Run, depth: number): Obj {
  const black = mode === "redact";
  const pageObj = doc.findPage(pageIndex);
  const saved = (["Contents", "Resources", "Annots"] as const).map((k) => [k, pageObj.get(k)] as const);
  const res = copyOf(doc, u.resources), xobjects = copyOf(doc, lookup(u.resources, "XObject"));
  xobjects.put(MASK_GROUP, u.group);
  res.put("XObject", xobjects);
  const buf = new mupdf.Buffer(`q ${ctm.map(num).join(" ")} cm /${MASK_GROUP} Do Q`);
  try {
    pageObj.put("Contents", doc.addStream(buf, {}));
  } finally {
    buf.destroy();
  }
  pageObj.put("Resources", res);
  pageObj.delete("Annots");
  try {
    let page = doc.loadPage(pageIndex);
    let before: Content, pictures: Walked | null;
    try {
      before = readPageContent(pageObj);
      pictures = black ? walkedPictures(page) : null;
    } finally {
      page.destroy();
    }
    const n1 = doc.countObjects();
    page = doc.loadPage(pageIndex);
    try {
      applyRedaction(doc, page, pageIndex, [], rects, black ? IMAGE_PIXELS : IMAGE_NONE);
      if (black) fixPictures(mupdf, doc, page, pictures ?? [], rects, n1, run);
    } finally {
      page.destroy();
    }
    rewriteContent(mupdf, doc, pageIndex, before, pictures, rects, [], [], n1, run);
    pruneOwn(doc, pageObj, true, n1);
    redactSoftMasks(mupdf, doc, pageIndex, rects, mode, run, n1, depth + 1);
    // (MuPDF names it again, Fm1 or so: it is the one form the content draws)
    const drawn = readPageContent(pageObj).forms;
    if (drawn.length !== 1 || !drawn[0].isIndirect() || drawn[0].asIndirect() < n1) throw locked(pageIndex);
    return drawn[0];
  } finally {
    for (const [k, v] of saved) {
      if (v.isNull()) pageObj.delete(k);
      else pageObj.put(k, v);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Content: descriptions and the app's lines

/** A marked-content sequence as written: its BDC (or BMC) operation, its property list, and what it paints. */
interface Sequence {
  start: number;
  end: number;
  /** Just after its EMC (-1: not closed). */
  close: number;
  tag: string;
  dict: Record<string, Operand> | null;
  /** A named property list (/Tag /Name BDC). */
  name: string | null;
  mcid: number | null;
  /** What it paints, comparable before and after: the bytes of its text, its paths, its pictures, its forms' content. */
  sig: string;
  /** The bytes of the text it shows, in order (the redaction only takes some out). */
  glyphs: string;
}

interface Content {
  text: string;
  /** Where each content stream starts in `text` (they are joined with a newline). */
  starts: number[];
  seqs: Sequence[];
  /** The forms drawn, in order. */
  forms: Obj[];
  /** What the whole content paints. */
  sig: string;
}

/** Reads content: its sequences and their signatures (forms by what they paint: `formSig`). */
function readContent(text: string, res: Obj, formSig: (xo: Obj, res: Obj) => string): Omit<Content, "starts"> {
  const seqs: Sequence[] = [], forms: Obj[] = [], stack: Sequence[] = [];
  const all = { sig: "" };
  const paint = (piece: string, glyphs = "") => {
    all.sig += piece;
    for (const s of stack) {
      s.sig += piece;
      s.glyphs += glyphs;
    }
  };
  const show = (glyphs: string) => paint(`T${glyphs}|`, glyphs);
  for (const o of operations(text)) {
    const a = o.args;
    switch (o.op) {
      case "BDC":
      case "BMC": {
        const p = o.op === "BDC" ? a[a.length - 1] : undefined;
        const dict = p?.dict ?? null, name = p?.name ?? null;
        let mcid = dict?.MCID?.num;
        if (mcid === undefined && name !== null) {
          const prop = lookup(res, "Properties", name);
          if (prop.isDictionary() && prop.get("MCID").isNumber()) mcid = prop.get("MCID").asNumber();
        }
        const s: Sequence = {
          start: o.start, end: o.end, close: -1, tag: a[a.length - (o.op === "BDC" ? 2 : 1)]?.name ?? "", dict, name,
          mcid: mcid !== undefined && Number.isSafeInteger(mcid) && mcid >= 0 ? mcid : null, sig: "", glyphs: "",
        };
        seqs.push(s);
        stack.push(s);
        break;
      }
      case "EMC": {
        const s = stack.pop();
        if (s) s.close = o.end;
        break;
      }
      case "Tj":
      case "'":
      case "\"":
        show(bytesOf(a[a.length - 1]));
        break;
      case "TJ":
        show((a[0]?.arr ?? []).map(bytesOf).join(""));
        break;
      case "BI": {
        const d = a[0]?.dict ?? {};
        paint(`I${(d.W ?? d.Width)?.num}x${(d.H ?? d.Height)?.num}|`);
        break;
      }
      case "Do": {
        const xo = lookup(res, "XObject", a[0]?.name ?? "");
        if (!xo.isStream()) break;
        if (nameOf(xo.get("Subtype")) === "Form") {
          forms.push(xo);
          paint(`F{${formSig(xo, res)}}`);
        } else paint(`X${identity(xo)}|`);
        break;
      }
      case "sh":
        paint("H");
        break;
      default:
        if (PAINTS.has(o.op)) paint("P");
    }
  }
  return { text, seqs, forms, sig: all.sig };
}

/** The forms' signatures, each form's read once (a form that draws itself, or one that cannot be read, has its own). */
function formSigs() {
  const memo = new Map<string, string>();
  const busy = new Set<string>();
  const sig = (xo: Obj, res: Obj): string => {
    const id = identity(xo);
    const known = memo.get(id);
    if (known !== undefined) return known;
    if (busy.has(id) || busy.size > 32) return `loop ${id}`;
    busy.add(id);
    let out: string;
    try {
      const own = xo.get("Resources");
      out = readContent(latin1(streamBytes(xo)), own.isDictionary() ? own : res, sig).sig;
    } catch {
      out = `unreadable ${id}`;
    } finally {
      busy.delete(id);
    }
    memo.set(id, out);
    return out;
  };
  return sig;
}

/** The page's content (its streams joined, as MuPDF reads them), read. */
function readPageContent(pageObj: Obj): Content {
  const texts = contentStreams(pageObj).map((s) => (s.isStream() ? latin1(streamBytes(s)) : ""));
  const starts: number[] = [];
  let at = 0;
  for (const t of texts) {
    starts.push(at);
    at += t.length + 1;
  }
  return { ...readContent(texts.join("\n"), pageObj.getInheritable("Resources"), formSigs()), starts };
}

/**
 * The sequences (indices) of the content before that hold a picture meeting the area (inline ones
 * are not told apart by their signature): the page's, around the page-level operation that draws
 * it, or with `form` that form's own, around the picture's operation in it.
 */
function touchedSequences(before: Omit<Content, "starts"> & { starts?: number[] }, pictures: Walked, rects: Rect[], form: Obj | null = null): Set<number> {
  const out = new Set<number>();
  for (const p of pictures) {
    if (!rects.some((r) => meets(unitBounds(p.matrix), r))) continue;
    if (form && (!p.host || identity(p.host) !== identity(form))) continue;
    const at = form ? p.at : (before.starts?.[p.stream] ?? 0) + p.start;
    before.seqs.forEach((s, k) => { if (s.start <= at && (s.close < 0 || at < s.close)) out.add(k); });
  }
  return out;
}

/** Whether a property list (inline, or the named one's dictionary) holds a description. */
const describes = (dict: Record<string, Operand> | null) => !!dict && DESCRIPTION_KEYS.some((k) => dict[k] !== undefined);

/** A name as written in content (#xx for what needs it). */
const writtenName = (name: string) =>
  [...new TextEncoder().encode(name)].map((b) => (b > 0x20 && b < 0x7f && !"#/()<>[]{}%".includes(String.fromCharCode(b)) ? String.fromCharCode(b) : `#${b.toString(16).padStart(2, "0")}`)).join("");

/**
 * The BDC operation `op` (its text) without descriptions and, with `dropKey`, without that key and
 * its number (/PEText id). When the result still reads with one (an unusual way of writing it), the
 * operation is written again with its tag and MCID alone.
 */
function stripOperation(op: string, s: Sequence, dropDescriptions: boolean, dropKey: string | null): string {
  let out = dropDescriptions ? op.replace(DESCRIBED, "") : op;
  if (dropKey) out = out.replace(new RegExp(`/${dropKey}\\s+\\d+`), "");
  const parsed = [...operations(out)][0];
  const d = parsed?.op === "BDC" ? parsed.args[parsed.args.length - 1]?.dict : undefined;
  if (d && !(dropDescriptions && describes(d)) && !(dropKey && d[dropKey] !== undefined)) return out;
  return `/${writtenName(s.tag || "Span")} <<${s.mcid !== null ? `/MCID ${s.mcid}` : ""}>> BDC`;
}

/**
 * The structure element of marked content `mcid` of `host` (the page `at.page`, or a form: a copy
 * MuPDF made, of `original`) loses its descriptions, its ancestors too (forget): found through the
 * ParentTree (every kid read); for a form without /StructParents, both ways readers take its marked
 * content: as that of `outer` (the nearest content drawing it that has them: a form, its copy and
 * original, or the page) and as the page's. Noted in Run.forgotten for forgetByTree too.
 */
function forgetElement(doc: Doc, host: Obj, mcid: number, at: Describing, original: Obj | null = null, outer: (Obj | null)[] = [at.page]) {
  const markers = host.get("StructParents").isNumber() ? [host, original] : [host, original, ...outer, at.page];
  for (const o of markers) {
    if (!o) continue;
    const key = identity(o), mcids = at.run.forgotten.get(key);
    if (mcids) mcids.add(mcid);
    else at.run.forgotten.set(key, new Set([mcid]));
  }
  try {
    for (const o of markers) {
      const sp = o?.get("StructParents");
      const parents = sp?.isNumber() ? numberTreeGet(doc.getTrailer().get("Root", "StructTreeRoot", "ParentTree"), sp.asNumber()) : null;
      const elem = parents?.isArray() && mcid < parents.length ? parents.get(mcid) : null;
      if (elem?.isDictionary()) forget(elem);
    }
  } catch {
    // a structure tree that cannot be read: the content is changed all the same
  }
}

/**
 * The structure tree once, after the edit: an element whose /K names marked content forgotten
 * (forgetElement: an MCID with its /Pg, inherited, or an MCR by its /Pg or /Stm) or an object that
 * left (an OBJR: an annotation, a widget, a picture) loses its descriptions, its ancestors too. So
 * a ParentTree that leaves the page or the MCID out, or an annotation without /StructParent, hides
 * no description of what went.
 */
function forgetByTree(doc: Doc, run: Run) {
  const root = doc.getTrailer().get("Root", "StructTreeRoot");
  if (!root.isDictionary() || (!run.forgotten.size && !run.gone.size)) return;
  const seen = new Set<string>();
  const marked = (content: Obj | null, mcid: Obj) => !!content && mcid.isNumber() && !!run.forgotten.get(identity(content))?.has(mcid.asNumber());
  const visit = (elem: Obj, pg: Obj | null, depth: number) => {
    if (depth > 64 || seen.has(identity(elem))) return;
    seen.add(identity(elem));
    const page = elem.get("Pg").isDictionary() ? elem.get("Pg") : pg;
    const k = elem.get("K"), items: Obj[] = [];
    if (k.isArray()) for (let i = 0; i < k.length; i++) items.push(k.get(i));
    else items.push(k);
    let hit = false;
    for (const item of items) {
      if (item.isNumber()) hit ||= marked(page, item);
      else if (!item.isDictionary()) continue;
      else if (nameOf(item.get("Type")) === "MCR") {
        const stm = item.get("Stm");
        hit ||= marked(stm.isStream() ? stm : item.get("Pg").isDictionary() ? item.get("Pg") : page, item.get("MCID"));
      } else if (nameOf(item.get("Type")) === "OBJR") hit ||= item.get("Obj").isIndirect() && run.gone.has(item.get("Obj").asIndirect());
      else visit(item, page, depth + 1);
    }
    if (hit) forget(elem);
  };
  try {
    visit(root, null, 0);
  } catch {
    // a structure tree that cannot be read: the content is changed all the same
  }
}

/** The structure element that /StructParent `key` names (an object reference's) loses its descriptions, its ancestors too (forget). */
function forgetReferenced(doc: Doc, key: number) {
  try {
    const elem = numberTreeGet(doc.getTrailer().get("Root", "StructTreeRoot", "ParentTree"), key);
    if (elem?.isDictionary()) forget(elem);
  } catch {
    // a structure tree that cannot be read: the picture is cleared all the same
  }
}

/** The named property lists `names` of `host` (page or form) lose their descriptions: copies in a /Properties of its own. */
function forgetNamed(doc: Doc, host: Obj, isPage: boolean, names: Set<string>) {
  const current = isPage ? host.getInheritable("Resources") : host.get("Resources");
  const props = lookup(current, "Properties");
  let own: Obj | null = null;
  for (const name of names) {
    const prop = lookup(props, name);
    if (!prop.isDictionary() || !DESCRIPTION_KEYS.some((k) => !prop.get(k).isNull())) continue;
    if (!own) {
      // The page's (or form's) resources and /Properties of its own: other pages may share them.
      const res = doc.newDictionary();
      current.forEach((v, k) => { if (k !== "Properties") res.put(k, v); });
      own = doc.newDictionary();
      props.forEach((v, k) => own!.put(k, v));
      res.put("Properties", own);
      host.put("Resources", res);
    }
    const copy = doc.newDictionary();
    prop.forEach((v, k) => { if (!DESCRIPTION_KEYS.includes(String(k))) copy.put(k, v); });
    own.put(name, copy);
  }
}

/** A change to content text: bytes start..end become `insert`. */
type TextEdit = { start: number; end: number; insert: string };

function applyEdits(text: string, edits: TextEdit[]): string {
  let out = text;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.insert + out.slice(e.end);
  return out;
}

/** An operand as text, strings by their bytes (MuPDF writes them again, maybe otherwise), dictionary keys in order. */
function operandKey(o: Operand): string {
  if (o.dict) return `<<${Object.keys(o.dict).sort().map((k) => `/${k} ${operandKey(o.dict![k])}`).join(" ")}>>`;
  if (o.arr) return `[${o.arr.map(operandKey).join(" ")}]`;
  if (o.str !== undefined || o.hex !== undefined) return JSON.stringify(bytesOf(o));
  return JSON.stringify(o);
}

/** What a sequence is across the redaction: its tag, MCID and property list (MuPDF writes them again as they were). */
const sequenceKey = (s: Sequence) => `${s.tag}|${s.mcid}|${s.name}|${s.dict ? operandKey({ dict: s.dict }) : ""}`;

/** Whether `part` is `whole` with some characters taken out (or none). */
function isPartOf(part: string, whole: string): boolean {
  let i = 0;
  for (let k = 0; k < whole.length && i < part.length; k++) if (whole[k] === part[i]) i++;
  return i === part.length;
}

/**
 * The sequences before the redaction that each one after it can have been (their indices); null
 * when they cannot be paired. MuPDF keeps every sequence but those it empties inside a text object
 * (Chrome marks each ligature so, with its /ActualText), which it drops, and it only takes glyphs
 * out: the ones after are the ones before but some, in order, each the same sequence (sequenceKey)
 * showing what it showed or part of it. Every pairing that says so counts, positions being unknown
 * here: a span partly under the area can pass for a dropped one alike that showed what is left
 * (describeLevel strips it unless every one it can have been paints what it paints). Two tables of
 * after.length × (dropped + 1) cells, at most MAX_PAIRING_CELLS.
 */
function partnersOf(before: Sequence[], after: Sequence[]): number[][] | null {
  const m = after.length, w = before.length - m + 1; // after's k-th is before's k + j-th, j < w, never less than the k - 1-th's
  // shortcut: past MAX_PAIRING_CELLS (thousands of sequences dropped at once) every description of the content goes; pair run by run of keys if that shows up
  if (w < 1 || m * w > MAX_PAIRING_CELLS) return null;
  const keys = before.map(sequenceKey), wanted = after.map(sequenceKey);
  const fits = (k: number, i: number) => keys[i] === wanted[k] && isPartOf(after[k].glyphs, before[i].glyphs);
  // from[k * w + j]: after's first k + 1 pair in order, the k-th with before's k + j-th; to: the ones after it as well
  const from = new Uint8Array(m * w), to = new Uint8Array(m * w);
  for (let k = 0; k < m; k++)
    for (let j = 0, any = k === 0; j < w; j++) {
      if (k > 0 && from[(k - 1) * w + j]) any = true;
      from[k * w + j] = any && fits(k, k + j) ? 1 : 0;
    }
  for (let k = m - 1; k >= 0; k--)
    for (let j = w - 1, any = k === m - 1; j >= 0; j--) {
      if (k < m - 1 && to[(k + 1) * w + j]) any = true;
      to[k * w + j] = any && from[k * w + j] ? 1 : 0;
    }
  const out: number[][] = [];
  for (let k = 0; k < m; k++) {
    const can: number[] = [];
    for (let j = 0; j < w; j++) if (to[k * w + j]) can.push(k + j);
    if (!can.length) return null;
    out.push(can);
  }
  return out;
}

/** What describeLevel reads a page's content with: the page, the edit's Run (copies, forgotten), and the sequences of a form's content before (`form`, the original) that hold a picture under the area. */
interface Describing {
  page: Obj;
  run: Run;
  touchedIn: (form: Obj, content: Omit<Content, "starts">) => Set<number>;
}

/**
 * The descriptions of what changed, at one level (the page, or a form MuPDF copied for it):
 * sequences paired (partnersOf); one that changed or can have been one that painted otherwise (or
 * every one, when they cannot be paired) loses its inline and named descriptions and its element's,
 * and one that may have been dropped its element's.
 * Returns the edits of `after`'s text (the caller adds its own and writes them). The forms drawn
 * are followed the same way (`touched` in each: Describing.touchedIn): a copy that paints
 * otherwise also loses its metadata (and the element of an object reference to it its
 * descriptions), and each copy is noted in Run.copies against its original (retag).
 */
function describeLevel(
  mupdf: MuPDFModule, doc: Doc, before: Omit<Content, "starts"> | null, after: Omit<Content, "starts">, host: Obj, isPage: boolean, touched: Set<number>, n0: number,
  sig: ReturnType<typeof formSigs>, at: Describing, original: Obj | null = null, depth = 0, outer: (Obj | null)[] = [at.page],
): Map<number, boolean> {
  const copies = at.run.copies;
  const strip = new Map<number, boolean>(); // after's sequence index → its operation loses descriptions
  // (nothing changed at this level when it paints the same: its forms are still followed, for `copies`)
  if (!before || before.sig !== after.sig || touched.size) {
    const partners = before && partnersOf(before.seqs, after.seqs);
    // (one before is surely still there when it is the only one a sequence after can have been)
    const sure = new Set(partners?.filter((p) => p.length === 1).map((p) => p[0]));
    before?.seqs.forEach((s, i) => { if (!sure.has(i) && s.mcid !== null) forgetElement(doc, host, s.mcid, at, original, outer); });
    const named = new Set<string>();
    after.seqs.forEach((s, k) => {
      if (partners?.[k].every((i) => before!.seqs[i].sig === s.sig && !touched.has(i))) return;
      if (describes(s.dict)) strip.set(k, true);
      if (s.name !== null) named.add(s.name);
      if (s.mcid !== null) forgetElement(doc, host, s.mcid, at, original, outer);
    });
    if (named.size) forgetNamed(doc, host, isPage, named);
  }
  // The forms: MuPDF copies each one the page draws (new objects); a copy that paints otherwise is read the same way.
  if (depth < 16) {
    const inner = host.get("StructParents").isNumber() ? [host, original] : outer; // (whose marked content theirs is when they have no /StructParents)
    const formPairs = before && before.forms.length === after.forms.length;
    after.forms.forEach((a, k) => {
      if (!a.isIndirect() || a.asIndirect() < n0) return;
      const b = formPairs ? before!.forms[k] : null;
      if (b?.isIndirect() && b.asIndirect() < n0 && !copies.has(b.asIndirect())) copies.set(b.asIndirect(), a);
      const res = a.get("Resources");
      let text: string;
      try {
        text = latin1(streamBytes(a));
      } catch {
        return;
      }
      const afterForm = readContent(text, res.isDictionary() ? res : host.getInheritable("Resources"), sig);
      let beforeForm: Omit<Content, "starts"> | null = null;
      if (b) {
        try {
          const bres = b.get("Resources");
          beforeForm = readContent(latin1(streamBytes(b)), bres.isDictionary() ? bres : host.getInheritable("Resources"), sig);
        } catch {
          beforeForm = null;
        }
      }
      if (!beforeForm || beforeForm.sig !== afterForm.sig) {
        for (const key of FORM_METADATA_KEYS) a.delete(key);
        const sp = a.get("StructParent"); // (a copy keeps every key of the original but its content and resources)
        if (sp.isNumber()) forgetReferenced(doc, sp.asNumber());
      }
      const marks = describeLevel(mupdf, doc, beforeForm, afterForm, a, false, b && beforeForm ? at.touchedIn(b, beforeForm) : new Set(), n0, sig, at, b, depth + 1, inner);
      const edits: TextEdit[] = [];
      for (const [i] of marks) {
        const s = afterForm.seqs[i];
        edits.push({ start: s.start, end: s.end, insert: stripOperation(text.slice(s.start, s.end), s, true, null) });
      }
      if (edits.length) {
        const buf = new mupdf.Buffer(toBytes(applyEdits(text, edits)));
        try {
          a.writeStream(buf);
        } finally {
          buf.destroy();
        }
      }
    });
  }
  return strip;
}

/**
 * After the redaction: descriptions of what changed go (describeLevel), and the app's lines it
 * touched: an emptied one is removed and untagged, a cut one loses /PEText. The page's content is
 * written back as one stream when anything changed.
 */
function rewriteContent(
  mupdf: MuPDFModule, doc: Doc, pageIndex: number, before: Content, pictures: Walked | null, rects: Rect[], blocksBefore: ReturnType<typeof addedBlocks>,
  blocksAfter: ReturnType<typeof addedBlocks>, n0: number, run: Run,
) {
  const pageObj = doc.findPage(pageIndex);
  const after = readPageContent(pageObj);
  const at: Describing = { page: pageObj, run, touchedIn: (form, content) => (pictures ? touchedSequences(content, pictures, rects, form) : new Set()) };
  const touched = pictures ? touchedSequences(before, pictures, rects) : new Set<number>();
  const strip = describeLevel(mupdf, doc, before, after, pageObj, true, touched, n0, formSigs(), at);
  const edits: TextEdit[] = [];
  const removed: [number, number][] = [];
  const dropKey = new Map<number, string>(); // after's sequence start → key to drop
  for (const b of blocksAfter) {
    const was = blocksBefore.find((x) => x.id === b.id);
    if (!was || JSON.stringify(was.shows) === JSON.stringify(b.shows)) continue;
    const start = (after.starts[b.stream] ?? 0) + b.start, end = (after.starts[b.stream] ?? 0) + b.end;
    if (b.shows.length === 0) {
      removed.push([start, end]);
      edits.push({ start, end, insert: "" });
      if (b.mcid !== null) {
        forgetElement(doc, pageObj, b.mcid, at); // (its ancestors described the line too)
        untag(doc, pageIndex, b.mcid);
      }
    } else dropKey.set(start, "PEText");
  }
  after.seqs.forEach((s, k) => {
    if (removed.some(([a, z]) => s.start >= a && s.start < z)) return;
    const key = dropKey.get(s.start) ?? null;
    if (!strip.has(k) && !key) return;
    edits.push({ start: s.start, end: s.end, insert: stripOperation(after.text.slice(s.start, s.end), s, strip.has(k), key) });
  });
  if (!edits.length) return;
  const text = applyEdits(after.text, edits);
  if (contentStreams(pageObj).length === 1) writeStream(mupdf, doc, pageObj, 0, text);
  else {
    const buf = new mupdf.Buffer(toBytes(text));
    try {
      pageObj.put("Contents", doc.addStream(buf, {}));
    } finally {
      buf.destroy();
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The box

/**
 * The page-space bounds of the boxes earlier edits drew (boxOps: /Artifact <</PERedact id>> BDC
 * ... EMC appended from the page's initial state, its path of m and l in the page's user space),
 * each one fill.
 */
function boxesOn(pageObj: Obj, T: Matrix): Rect[] {
  const out: Rect[] = [];
  for (const s of contentStreams(pageObj)) {
    const text = s.isStream() ? latin1(streamBytes(s)) : "";
    if (!text.includes("PERedact")) continue;
    let depth = 0, inside = 0, points: Point[] = [];
    for (const o of operations(text)) {
      if (o.op === "BDC" || o.op === "BMC") {
        depth++;
        if (!inside && o.op === "BDC" && o.args[o.args.length - 1]?.dict?.PERedact !== undefined) inside = depth;
      } else if (o.op === "EMC") {
        if (inside && depth === inside) {
          if (points.length) out.push(bboxOf(points.map(([x, y]) => applyTo(T, x, y))));
          points = [];
          inside = 0;
        }
        if (depth > 0) depth--;
      } else if (inside && (o.op === "m" || o.op === "l") && o.args.length === 2 && o.args.every((a) => a.num !== undefined)) points.push([o.args[0].num!, o.args[1].num!]);
    }
  }
  return out;
}

/**
 * The box drawn where the redaction was: the rects and the runs of characters it took (textThatGoes:
 * one shape each, kept to 70 % of its height, centred: the characters' full boxes reach over the
 * neighbouring lines), in the page's user space, as the app's own block. Its id is one more than
 * the page's largest.
 */
function boxOps(pageObj: Obj, rects: Rect[], runs: Quad[], T: Matrix, black: boolean): string {
  const inv = invert(T);
  const quads: Point[][] = rects.map((r) => [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]]);
  for (const q of runs) {
    // u along the line (ul → ur), v across (ul → ll); the middle 70 % across
    const vx = q[4] - q[0], vy = q[5] - q[1], s = 0.15;
    const ul: Point = [q[0] + s * vx, q[1] + s * vy], ur: Point = [q[2] + s * vx, q[3] + s * vy];
    const lr: Point = [q[6] - s * vx, q[7] - s * vy], ll: Point = [q[4] - s * vx, q[5] - s * vy];
    const b = bboxOf([ul, ur, lr, ll]);
    // (one inside a rect adds nothing but bytes. The run's own shape, turned as its line is, and as
    // the rects: the same way round, so the nonzero fill joins them; a turned line's bounds would
    // reach over the lines beside it)
    if (b.every(Number.isFinite) && b[2] > b[0] && b[3] > b[1] && !rects.some((r) => within(b, r))) quads.push([ul, ur, lr, ll]);
  }
  const path = quads.map((pts) => {
    const u = pts.map((p) => applyTo(inv, p[0], p[1]).map(num).join(" "));
    return `${u[0]} m ${u[1]} l ${u[2]} l ${u[3]} l h`;
  }).join("\n");
  let id = 0;
  for (const s of contentStreams(pageObj)) {
    if (!s.isStream()) continue;
    for (const m of latin1(streamBytes(s)).matchAll(/\/PERedact\s+(\d+)/g)) id = Math.max(id, Number(m[1]));
  }
  return `/Artifact <</PERedact ${id + 1}>> BDC\nq ${black ? "0" : "1"} g\n${path}\nf\nQ\nEMC\n`;
}
