// Decorations that follow an edited line (ARCHITECTURE.md, "Decorations"): the underline, the
// strike-through, the background or border around the text (a pill, a button, a chip, a
// highlight) and the links over it.
//
// PDF has no underline attribute: producers draw an underline, a strike-through or a pill as
// shapes of their own, and a link as an annotation, so a line edit (core.replaceText) left them
// as long as the old text, and a deleted line left a broken underline, an empty pill and a link
// over blank space. Here, around a line edit:
// - detectDecorations, before it, finds the shapes and links that belong to the line, with MuPDF's
//   own interpreter (a device pass over the page) and rules in the line's frame (t along the
//   baseline, v across it, towards the descent; S the font size):
//   - a thin rule (thickness at most max(0.2 S, 2.5 pt)) whose ends sit on the edges of the
//     line's characters (within max(0.15 S, 0.75 pt)) is an underline (v from -0.05 S to 0.4 S),
//     a strike-through (-0.5 S to -0.12 S) or an overline (-1.15 S to -0.7 S). An underline or a
//     strike-through in the text's own colour, solid, isolated, in the page's own content, follows
//     the text by itself ("auto"); anything else that looks like one stays, with the reason;
//   - a box (a background when filled, a border when stroked) that covers a run of the line's
//     characters across their height (at most 3.5 S high, each side margin from -0.1 S to
//     2.5 S), holds no other line's characters, touches no other shape and is drawn before the
//     text (or translucent over it), is offered as an option ("Allunga anche lo sfondo"),
//     suggested when every box offered hugs the text (both margins at most 1.5 S, differing by at
//     most 0.5 S): a pill, a button, a highlight;
//   - a rule or a box that is one of a row or a column of like shapes that are not the line's
//     (the bottom borders or the backgrounds of a table's cells, spaced so that they do not
//     touch) is the layout's: it stays ("shared");
//   - a link whose rect covers one run of the line's characters and no other line's, and hugs it
//     (not a block link over a picture and its caption), on a line that runs along the page's
//     axes, follows by itself, unless another page shows it too (merged or repeated pages can
//     share one annotation object, or one /Annots array): then it stays ("shared").
// - applyDecorations, after it, stretches or shrinks those shapes and moves those links with the
//   new text, or removes them with the text they decorated, as part of the same edit (one undo).
//   Where the new text is: read on the page, from the old first character's origin (where
//   replaceText writes the replacement), checked against the text it wrote. Which characters a
//   decoration covers then (mapRun): the whole line's decoration covers the whole new line, text
//   typed right after a decorated run continues it, a run whose text is gone is removed, and an
//   edit across a run's edge leaves it as it was ("ambiguous"). A shape is found again in the
//   page's own content by its page-space bounds (within 0.02 pt) among paths painted the same way,
//   exactly once; its points past its middle along t move by the change at the run's end, the
//   others by the change at its start (so a pill's round ends stay exact; for text narrower than
//   they are, the pill becomes just its two ends, from where it starts); a rectangle stays a
//   rectangle when it can. The skip-ink holes a clip cuts in an underline under the descenders
//   (Chrome) keep their place under unchanged characters, move with the text after the change and
//   go in the change. A link's rect (and its /QuadPoints) moves the same way along the line;
//   removed, it leaves /Annots and, on a tagged page, the structure tree.
// The plan of an edit (DecorationPlan: shapes by bounds and paint, links by rect and URI, each
// with the characters it decorates) is plain data, logged with the edit (session.ts): a replay
// applies it as logged and fails (DecorationMismatch) when the page does not have what it says,
// so a later change of these rules cannot change old history.
//
// The device pass follows images.ts's discipline: no fillShade handler (MuPDF.js 1.27 drops a
// reference it never took), no exception leaves a callback (guarded: caught, thrown after the
// pass), everything a callback receives is destroyed (paths, stroke states, colour spaces, texts,
// the fonts their glyph walk gives), and the contents of tiling patterns and soft masks are left
// out. Content streams are written with images.writeStream only (bytes, shared streams). Nothing
// here is logged with resource names or content offsets: the plan holds page-space bounds and
// character ranges.
//
// Ported from the prototype (feedback-r3/decorations, proto.mjs), with its known gaps (maps.md
// §proto §8) fixed or left out on purpose:
//  1. links are written in user space (Link.setBounds takes it): not mirrored after a save;
//  2. core.replaceText puts the original link objects back (restoreLinks), with /F, /Border and
//     /StructParent, at their place in /Annots;
//  3. links move on lines along any of the page's axes (/Rotate 90 included); on a slanted line
//     they stay, with the reason ("direction");
//  4. deleting a line removes its decorations, partial ones included (an empty new text leaves
//     nothing ambiguous), and its links, from the structure tree too (a link that cannot leave it
//     for sure stays, "shared"; with no structure tree, a /StructParent left by a merge names
//     nothing, and the link just goes);
//  5. an overline is never automatic ("overline"); a rule in an overline's place that is the
//     underline of the line above is not this line's at all; a rule that is both lines' (under an
//     addend, over a total of the same width: a sum column) stays on both ("shared");
//  6. dashed rules (more than one subpath, or a stroke with a dash pattern) and dotted ones are
//     reported ("pattern"): a row of three or more like pieces, as long as each other, with gaps
//     as long as each other that fall across the words (the first and the last piece may be
//     shorter, or run past the text's ends, by at most a piece and a gap), is one rule however
//     long the dashes, and so are two or more short pieces in a row (each at most 1.5 S); none
//     of them is a rule on its own. A row of other pieces that spans a run only together is one
//     too. Underlines of whole words one after the other are no pattern: long ones (words between
//     blanks, each underline right on its word's edges, within 0.3 pt) follow their words; short
//     ones (words between blanks or punctuation, brackets, slashes, dashes: a language switch
//     "EN IT" or "EN/IT", pagination "1 2 3", "1, 2, 3" or "(1) (2)") stay as the layout's
//     ("shared"). A row of long dashes whose ends happen to fall near punctuation ("Rev. 2.1
//     (draft)") is a dashed rule all the same. A wavy underline is a picture and is not seen;
//  7. the new text is checked (it must read what replaceText wrote, missing characters left out):
//     otherwise every shape stays ("complex");
//  8. the line is the one core.replaceText edits: `find` at `occurrence`, ranges in `find`;
//  9. fill-and-stroke paths (B, b, B*, b*) count as both fill and stroke, and an underline painted
//     both ways is one underline;
// 10. a shape inside a Form XObject is found out at detection ("form");
// 11. a shape whose path spans two content streams stays ("complex");
// 12. edits are de-duplicated (two shapes sharing a clip or a path) and applied from the end of
//     each stream;
// 13. the box option is suggested by the margins rule above;
// 14. vertical text (wmode 1) and slanted lines are left ("direction"); mixed and added lines
//     never come here (session.ts); protectAdded runs between, the walk reads the content after
//     it; caps, beyond which the shapes are "complex": 200,000 path paints (MAX_PATHS, those of
//     forms counted as often as they are drawn), 2,000,000 points near the line (a path of more
//     than 10,000 is no candidate), 5,000 thin pieces in the line's bands, 200 candidates,
//     2,000,000 shape-against-shape checks, images.MAX_WALK_OPERATIONS; the work grows about as
//     n log n (pieces sorted into rows, paths found through a grid and a sorted index). A
//     /Contents entry that is not a stream (null, a missing object) is skipped, as MuPDF skips
//     it. The log and replay model is the plan. Out of scope: new skip-ink holes under new
//     descenders, keeping right or centre alignment (the text grows to the right, as today);
// 15. size and colour changes: out of scope (the line editor cannot change them yet);
// 16. clips are edited only when set inside the decoration's own block, the outermost q..Q around
//     it that paints nothing else (Chrome sets the skip-ink clip there, outside the q..Q of the
//     rule's cm), so nothing else drawn under them changes; a clip that bounds the decoration
//     stretches with it; holes under changed characters go even when the run's ends stay;
// 17. text typed onto the front of a decorated word ("here" made "there") takes the decoration;
// 18. colours are compared in the device's own terms: the same colour space (or DeviceGray and
//     DeviceRGB, or an ICC space and the device space of its kind, which is how replaceText
//     writes such a line's text), the same components; anything else is unknown and the rule
//     stays ("colour");
// 19. the order of the line's own glyphs (not of text objects overlapping its box) decides
//     whether a box is drawn over the text ("cover");
// 20. every MuPDF object is destroyed (pages and the fonts of lines through core.releasePage,
//     links, what device callbacks receive);
// 21. tolerances: bounds 0.02 pt, origin 0.05 pt, links 0.05 pt, no move under 0.005 pt, axes
//     1e-6, isolation 0.5 pt (containment 0.01 pt), holes within 0.5 pt of the rule and at most
//     2 S wide, long words' underlines in a row 0.3 pt.
//
// Links do not depend on the paths: on a page too complex for its shapes they still follow. A
// link is found again by its rect and its URI as MuPDF reads it (one with no scheme, such as
// "www.example.com", after the document's /URI /Base or "file://"), and its annotation in
// /Annots by the same; an /Annots entry that is null or names no object is skipped, as MuPDF
// skips it. Whether another page shows a link is a look at every page's /Annots, made only for a
// link that would follow (about 15 ms for 5,000 pages of 10 links each).
// ARCHITECTURE.md rule 6 does not apply here: page content streams and annotation dictionaries
// are not resources MuPDF keeps loaded in its store (fonts, images and colour spaces are).
//
// Cost (Node 22, the worker's MuPDF build, measured): on decorations-chrome.pdf (117 paints, 30
// lines) detection takes 1 to 8 ms a line, about 4 on average, on top of the editor's own line
// read (it reads the page's lines again, runs the device pass, and walks the content only when
// something may follow); on the prototype's page of 70,000 paths (perf.mjs) about 400 ms (its
// line read 50 ms, the device pass and the content walk about 150 ms each), and applying an edit
// there about 200 ms (the new line read and the walk). A page that paints more than MAX_PATHS
// paths answers from the pass's first MAX_PATHS (about 600 ms at 210,000: its shapes
// "complex"); beyond twice that it answers from a count of its operators alone (each form's read
// once), in about the time of its line read, with no shapes: about 400 ms for 500,000 paths in
// the page's content, about 1.5 s for a form of 2,000 paths drawn 1,500 times (whose line read
// takes as long). 40,000 dots in the line's bands take about 0.2 s, 20,000 copies of one
// underline 0.1 s (they took 14 and 19 s when every piece was compared with every other).
import type * as MuPDF from "mupdf";
import { extractLines, findInLines, releasePage } from "./core.js";
import {
  MAX_WALK_OPERATIONS, NO_STROKE, PAINT, PATH, applyTo, bboxOf, concat, contentStreams, guarded, invert, isNumeric, latin1, nameFrom,
  num, numbersOf, operations, splice, streamBytes, writeStream,
} from "./images";
import type { DecorationKind, DecorationLeftReason, DecorationReport, LineDecorations, Matrix, Rect } from "./protocol";

type MuPDFModule = typeof MuPDF;
type Doc = MuPDF.PDFDocument;
type Obj = MuPDF.PDFObject;
type Point = [number, number];

/** A character as core.extractLines gives it (only what is used here). */
interface LineChar {
  c: string;
  origin: number[];
  glyphOrigin: number[];
  quad: number[];
  size: number;
}
interface Line {
  wmode: number;
  dir: number[];
  chars: LineChar[];
  text: string;
  /** Its bounds in page space. */
  bbox?: number[];
}

// ---------------------------------------------------------------------------------------------
// The contract (protocol.ts has the RPC side)

/** A shape the session logs with a text edit: what to find again and which characters it decorates. Plain JSON. */
export interface ShapePlan {
  kind: DecorationKind;
  paint: "fill" | "stroke";
  /** Its bounds in page space before the edit (path points, as the device pass saw them). */
  bbox: Rect;
  /** The characters of the edited text (`find`, the trimmed line) it decorates: [start, end). */
  range: [number, number];
}

/** A link the session logs with a text edit. Plain JSON. */
export interface LinkPlan {
  /** Its rect in page space before the edit. */
  bounds: Rect;
  uri: string;
  range: [number, number];
}

export interface DecorationPlan {
  shapes: ShapePlan[];
  links: LinkPlan[];
}

/** What the line has, before an edit. Ranges index `find`. */
export interface Detected {
  shapes: { plan: ShapePlan; level: "auto" | "option" | "left"; reason?: DecorationLeftReason }[];
  links: { plan: LinkPlan; level: "auto" | "left"; reason?: DecorationLeftReason }[];
  /** The option's box: which kinds it holds and whether it starts ticked; null when none is offered. */
  box: { fill: boolean; stroke: boolean; suggested: boolean } | null;
}

/** What applyDecorations needs from the line before core.replaceText changes it. Plain data. */
export interface Before {
  /** The line's direction (a unit vector in page space) and writing mode. */
  dir: Point;
  wmode: number;
  /** The font size of the first character of `find` (S). */
  size: number;
  /** Where `find` starts in the raw line (its leading whitespace). */
  start: number;
  /** The characters of `find`: quads and origins in page space. */
  chars: { c: string; quad: number[]; origin: Point }[];
}

/** Thrown on a replay when a planned shape or link is not found where the log says. */
export class DecorationMismatch extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecorationMismatch";
  }
}

// ---------------------------------------------------------------------------------------------
// Limits and tolerances

/** Most path paints read for a page: beyond, its shapes are "complex" (left as they are). */
export const MAX_PATHS = 200_000;
/** Most path points read near the line: beyond, its shapes are "complex". */
const MAX_POINTS = 2_000_000;
/**
 * Most points kept of one path: a longer one (a plot, a map's outline) cannot be a decoration. Only
 * its bounds are kept, for isolation.
 */
const MAX_PATH_POINTS = 10_000;
/** Most thin pieces (rules, dots, dashes) in the line's bands, and most shapes found for it: beyond, its shapes are "complex". */
const MAX_PIECES = 5_000;
const MAX_CANDIDATES = 200;
/** Most shape-against-shape checks (isolation, layout) for one line: beyond, its shapes are "complex". */
const MAX_CHECKS = 2_000_000;
/** Most levels of forms drawn inside forms that the paint count enters. */
const MAX_FORM_DEPTH = 12;
/** Shapes of a layout (table cells) line up within this (pt). */
const LAYOUT_EPS = 0.25;
/** The dashes or dots of one dashed or dotted rule are as long as each other, and as far apart, within this (pt). */
const PATTERN_EPS = 0.25;
/**
 * A long word's own underline, one of a row, ends on its characters' edges within this (pt):
 * producers draw it to the glyphs' advances, while a dash of a dashed rule lands that near a
 * word's edges only by chance.
 */
const WORD_HUG = 0.3;
/** A shape is found again by its page-space bounds within this (pt). */
const BOUNDS_EPS = 0.02;
/** The new text is found by its first character's origin within this (pt), as session.ts's printedRight does. */
const ORIGIN_EPS = 0.05;
/** A link is found again by its rect within this (pt). */
const LINK_EPS = 0.05;
/** Below this (pt) nothing moves. */
const NO_MOVE = 0.005;
/**
 * What is kept of a path's straight sides (pt) when the text is narrower than its two ends allow:
 * enough for the next edit to tell the ends apart along t (with no side at all, the two ends would
 * share their join points, and a second narrowing edit would bend one end into the other), far
 * too little to see.
 */
const SLIVER = 0.02;
/** A direction counts as along the page's axes within this. */
const AXIS_EPS = 1e-6;
/** Shapes nearer than this (pt) touch (isolation); one holds the other within CONTAIN_EPS. */
const TOUCH = 0.5;
const CONTAIN_EPS = 0.01;
/** A colour component counts as the same within this. */
const COLOUR_EPS = 0.02;
/** A glyph drawn at a character's origin within this (pt) is that character's. */
const GLYPH_EPS = 0.1;

/** When several reasons apply to a shape, the one said is the first of these. */
const REASONS: DecorationLeftReason[] = ["direction", "complex", "form", "pattern", "overline", "cover", "shared", "colour", "ambiguous"];

// ---------------------------------------------------------------------------------------------
// The line's frame

/** t along the baseline from the origin O, v across it (positive towards the descent); S the font size. */
interface Frame {
  u: Point;
  n: Point;
  O: Point;
  S: number;
}

const frameOf = (u: Point, O: Point, S: number): Frame => ({ u, n: [-u[1], u[0]], O, S });
const tOf = (F: Frame, p: Point) => (p[0] - F.O[0]) * F.u[0] + (p[1] - F.O[1]) * F.u[1];
const vOf = (F: Frame, p: Point) => (p[0] - F.O[0]) * F.n[0] + (p[1] - F.O[1]) * F.n[1];
/** The page-space point at (t, v). */
const atTV = (F: Frame, t: number, v: number): Point => [F.O[0] + t * F.u[0] + v * F.n[0], F.O[1] + t * F.u[1] + v * F.n[1]];

/** A character in the frame: its box along t and v, and its centre in page space. */
interface Placed {
  c: string;
  t0: number;
  t1: number;
  v0: number;
  v1: number;
  centre: Point;
  blank: boolean;
}

function placed(F: Frame, ch: { c: string; quad: number[] }): Placed {
  const q = ch.quad;
  const corners: Point[] = [[q[0], q[1]], [q[2], q[3]], [q[4], q[5]], [q[6], q[7]]];
  const ts = corners.map((p) => tOf(F, p)), vs = corners.map((p) => vOf(F, p));
  return {
    c: ch.c,
    t0: Math.min(ts[0], ts[2]), t1: Math.max(ts[1], ts[3]),
    v0: Math.min(vs[0], vs[1]), v1: Math.max(vs[2], vs[3]),
    centre: [(q[0] + q[2] + q[4] + q[6]) / 4, (q[1] + q[3] + q[5] + q[7]) / 4],
    blank: !ch.c.trim(),
  };
}

/** Along one of the page's axes (also /Rotate 90 or 270), the only directions handled. */
const alongAxes = (u: Point) => Math.abs(u[0]) < AXIS_EPS || Math.abs(u[1]) < AXIS_EPS;

const inRect = (r: Rect, p: Point) => p[0] >= r[0] && p[0] <= r[2] && p[1] >= r[1] && p[1] <= r[3];
const meets = (a: Rect, b: Rect) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
const holds = (a: Rect, b: Rect) =>
  a[0] <= b[0] + CONTAIN_EPS && a[1] <= b[1] + CONTAIN_EPS && a[2] >= b[2] - CONTAIN_EPS && a[3] >= b[3] - CONTAIN_EPS;
const nearRect = (a: Rect, b: Rect, eps: number) => a.every((v, i) => Math.abs(v - b[i]) <= eps);
const grown = (r: Rect, e: number): Rect => [r[0] - e, r[1] - e, r[2] + e, r[3] + e];

/** The line `find` at `occurrence`, as core.replaceText finds it; throws when it is not there. */
function lineHit(lines: Line[], find: string, occurrence: number, pageIndex: number) {
  const hit = findInLines(lines, find, occurrence) as { line: Line; start: number; chars: LineChar[] } | null;
  if (!hit || !find) throw new Error(`"${find}" not found on page ${pageIndex + 1}`);
  return hit;
}

// ---------------------------------------------------------------------------------------------
// Colours

/** A colour in its own colour space, as the device pass sees it. */
interface Colour {
  space: string;
  type: string;
  values: number[];
}

function colourOf(cs: MuPDF.ColorSpace, values: number[]): Colour {
  return { space: cs.getName(), type: cs.getType(), values: [...values] };
}

/** The device colour space of each kind MuPDF types colour spaces by. */
const DEVICE_SPACE: Record<string, string> = { Gray: "DeviceGray", RGB: "DeviceRGB", CMYK: "DeviceCMYK" };

/**
 * Whether two colours are the same, in the device's own terms: the same colour space (gray, RGB
 * or CMYK, as MuPDF types it) and the same components; DeviceGray and DeviceRGB, which convert
 * exactly; or a space of one of those kinds (an ICC profile: macOS exports draw everything in one)
 * and the device space of the same kind, with the same components. That last one is how
 * core.replaceText writes a line drawn in such a space (colorOp: `rg` with its components), so a
 * line edited once still has its rule's colour. Anything else (two different profiles,
 * Separation, Indexed, Lab, an unknown colour) cannot be called the same.
 */
function sameColour(a: Colour | null, b: Colour | null): boolean {
  if (!a || !b) return false;
  const simple = (c: Colour) => c.type in DEVICE_SPACE;
  if (!simple(a) || !simple(b)) return false;
  let x: number[] | null = a.values, y: number[] | null = b.values;
  const deviceTwin = a.type === b.type && (a.space === DEVICE_SPACE[a.type] || b.space === DEVICE_SPACE[b.type]);
  if (a.space !== b.space && !deviceTwin) {
    const rgb = (c: Colour) => (c.space === "DeviceRGB" ? c.values : c.space === "DeviceGray" ? [c.values[0], c.values[0], c.values[0]] : null);
    x = rgb(a);
    y = rgb(b);
  }
  return !!x && !!y && x.length === y.length && x.every((v, i) => Math.abs(v - y[i]) <= COLOUR_EPS);
}

/** The very same colour: one colour space, the same components (shapes of one layout). */
const sameValues = (a: Colour, b: Colour) =>
  a.space === b.space && a.values.length === b.values.length && a.values.every((v, i) => Math.abs(v - b.values[i]) <= COLOUR_EPS);

// ---------------------------------------------------------------------------------------------
// The device pass (MuPDF's own interpreter)

/** A path MuPDF paints near the line. */
interface Drawn {
  /** Its place in the painting order (paths and texts). */
  order: number;
  paint: "fill" | "stroke";
  /** Its points in page space (control points included) and their bounds. */
  points: Point[];
  bbox: Rect;
  subpaths: number;
  colour: Colour;
  alpha: number;
  /** A stroke's line width (user space), the CTM it is drawn with, and whether it is dashed. */
  lineWidth: number;
  ctm: Matrix;
  dashed: boolean;
  /** More than MAX_PATH_POINTS points: `points` are only its bounds' corners, and it is no candidate. */
  huge: boolean;
}

/** Text MuPDF paints near the line: where its glyphs are (page space). */
interface TextPaint {
  order: number;
  origins: Point[];
  colour: Colour | null;
}

interface Pass {
  drawn: Drawn[];
  texts: TextPaint[];
  /** The page paints more paths than MAX_PATHS, or MuPDF failed to read it: what was read may be incomplete. */
  complex: boolean;
}

/**
 * The paths MuPDF paints whose bounds meet `region`, and the texts whose bounds meet `textRegion`,
 * in painting order. Never throws for what the page holds: a failure inside the pass, or more
 * than MAX_PATHS paths, makes it "complex".
 */
function devicePass(mupdf: MuPDFModule, page: MuPDF.PDFPage, region: Rect, textRegion: Rect): Pass {
  const drawn: Drawn[] = [], texts: TextPaint[] = [];
  let order = 0, paths = 0, points = 0, tile = 0, mask = 0, over = false;
  const g = guarded();
  const path = (
    p: MuPDF.Path, paint: Drawn["paint"], ctm: Matrix, cs: MuPDF.ColorSpace, color: number[], alpha: number, stroke: MuPDF.StrokeState | null,
  ) => {
    order++;
    if (tile || mask || over) return;
    if (++paths > MAX_PATHS) {
      over = true;
      return;
    }
    if (!meets(p.getBounds(stroke ?? NO_STROKE, ctm) as Rect, region)) return;
    // Bounds kept as the walk goes (no spread of the points: V8 throws past about 120,000), and
    // the points themselves only up to MAX_PATH_POINTS.
    const pts: Point[] = [];
    let subpaths = 0, n = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const add = (x: number, y: number) => {
      const q = applyTo(ctm, x, y);
      if (q[0] < x0) x0 = q[0];
      if (q[0] > x1) x1 = q[0];
      if (q[1] < y0) y0 = q[1];
      if (q[1] > y1) y1 = q[1];
      if (++n <= MAX_PATH_POINTS) pts.push(q);
    };
    // (called back from MuPDF: nothing in these can throw)
    p.walk({
      moveTo(x, y) { subpaths++; add(x, y); },
      lineTo(x, y) { add(x, y); },
      curveTo(xa, ya, xb, yb, xc, yc) { add(xa, ya); add(xb, yb); add(xc, yc); },
    });
    points += n;
    if (points > MAX_POINTS) {
      over = true;
      return;
    }
    if (!n) return;
    const bbox: Rect = [x0, y0, x1, y1], huge = n > MAX_PATH_POINTS;
    const dashes = stroke?.getDashes();
    drawn.push({
      order, paint, points: huge ? [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] : pts, bbox, subpaths, colour: colourOf(cs, color), alpha,
      lineWidth: stroke ? stroke.getLineWidth() : 0, ctm: [...ctm] as Matrix, dashed: !!dashes && dashes.some((d) => d > 0), huge,
    });
  };
  const text = (t: MuPDF.Text, ctm: Matrix, colour: () => Colour | null) => {
    order++;
    if (tile || mask) return;
    if (!meets(t.getBounds(NO_STROKE, ctm) as Rect, textRegion)) return;
    const origins: Point[] = [];
    // The glyph walk hands out Font wrappers (one shared while the font is the same): destroyed
    // once it is done, as core.releasePage destroys core.captureGlyphs' ones.
    const fonts = new Set<MuPDF.Font>();
    try {
      t.walk({
        beginSpan(font) { fonts.add(font); },
        showGlyph(font, trm) { fonts.add(font); origins.push(applyTo(ctm, trm[4], trm[5])); },
      });
    } finally {
      for (const f of fonts) f.destroy();
    }
    texts.push({ order, origins, colour: colour() });
  };
  const dev = new mupdf.Device({
    fillPath(p, _evenOdd, ctm, cs, color, alpha) { g.attempt(() => path(p, "fill", ctm, cs, color, alpha, null), p, cs); },
    strokePath(p, stroke, ctm, cs, color, alpha) { g.attempt(() => path(p, "stroke", ctm, cs, color, alpha, stroke), p, stroke, cs); },
    fillText(t, ctm, cs, color) { g.attempt(() => text(t, ctm, () => colourOf(cs, color)), t, cs); },
    strokeText(t, stroke, ctm, cs, color) { g.attempt(() => text(t, ctm, () => colourOf(cs, color)), t, stroke, cs); },
    ignoreText(t, ctm) { g.attempt(() => text(t, ctm, () => null), t); },
    beginMask(_area, _luminosity, cs) {
      mask++;
      g.attempt(() => {}, cs);
    },
    endMask() { mask--; },
    beginTile() { tile++; return 0; },
    endTile() { tile--; },
  });
  try {
    page.runPageContents(dev, mupdf.Matrix.identity);
    dev.close();
  } finally {
    dev.destroy();
  }
  return { drawn, texts, complex: over || g.failed };
}

// ---------------------------------------------------------------------------------------------
// The content walk (the page's own content streams)

/** How many numbers each path-construction operator takes. */
const PATH_OPERANDS: Record<string, number> = { m: 2, l: 2, c: 6, v: 4, y: 4, h: 0, re: 4 };
const FILLS = new Set(["f", "F", "f*", "B", "B*", "b", "b*"]);
const STROKES = new Set(["S", "s", "B", "B*", "b", "b*"]);

/** A path-construction operation as written. */
interface PathOp {
  op: string;
  nums: number[];
  stream: number;
  start: number;
  end: number;
}

/** A clip set with a path (W or W*), in effect where a path is painted. */
interface WalkClip {
  ops: PathOp[];
  ctm: Matrix;
  /** The q depth where it was set. */
  depth: number;
}
interface ClipNode {
  clip: WalkClip;
  prev: ClipNode | null;
}

/** A q..Q block of the page content. */
interface Block {
  stream: number;
  /** The q depth inside it. */
  depth: number;
  /** What it paints (forms, images, text, shadings and paths, one each). */
  paints: number;
  /** Its first paint, when that is a path (null: something else came first). */
  first: Painted | null | undefined;
}

/** A path painted by the page's own content. */
interface Painted {
  ops: PathOp[];
  paint: { op: string; stream: number; start: number; end: number };
  /** User space to page space where it is painted. */
  ctm: Matrix;
  /** Its points' bounds in page space (control points included). */
  bbox: Rect;
  fill: boolean;
  stroke: boolean;
  /** Not to be rewritten: it is also a clip, an operand cannot be read, or it spans two streams. */
  odd: boolean;
  /** The clips in effect, newest first. */
  clips: ClipNode | null;
  /** The outermost q..Q block around it, in one stream, that paints nothing else. */
  unit: Block | null;
}

/** The content walk read more than images.MAX_WALK_OPERATIONS operations. */
class WalkLimit extends Error {}

/**
 * The page's content as MuPDF reads it: its /Contents entries that are streams (a null or a
 * missing object is skipped, as MuPDF skips it), with each one's place in /Contents (what
 * images.writeStream takes). `broken`: a stream could not be decoded (MuPDF may still draw part of
 * it), so a shape not found in the others is not known to be in a form.
 */
interface Content {
  index: number[];
  bytes: Uint8Array[];
  broken: boolean;
}

function readContent(pageObj: Obj): Content {
  const out: Content = { index: [], bytes: [], broken: false };
  contentStreams(pageObj).forEach((st, k) => {
    if (!st.isStream()) return;
    try {
      out.bytes.push(streamBytes(st));
      out.index.push(k);
    } catch {
      out.broken = true;
    }
  });
  return out;
}

/** Points of a path operation (user space), control points included. */
function pointsOf(o: PathOp): Point[] {
  const v = o.nums;
  if (o.op === "re") return [[v[0], v[1]], [v[0] + v[2], v[1]], [v[0] + v[2], v[1] + v[3]], [v[0], v[1] + v[3]]];
  const out: Point[] = [];
  for (let k = 0; k + 1 < v.length; k += 2) out.push([v[k], v[k + 1]]);
  return out;
}

/** The page-space bounds of a path's points (control points included); NaN when it has none. */
function boundsOf(path: PathOp[], m: Matrix): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x: number, y: number) => {
    const px = x * m[0] + y * m[2] + m[4], py = x * m[1] + y * m[3] + m[5];
    if (px < x0) x0 = px;
    if (px > x1) x1 = px;
    if (py < y0) y0 = py;
    if (py > y1) y1 = py;
  };
  for (const o of path) {
    const v = o.nums;
    if (o.op === "re") {
      add(v[0], v[1]);
      add(v[0] + v[2], v[1]);
      add(v[0] + v[2], v[1] + v[3]);
      add(v[0], v[1] + v[3]);
    } else for (let k = 0; k + 1 < v.length; k += 2) add(v[k], v[k + 1]);
  }
  return x0 <= x1 ? [x0, y0, x1, y1] : [NaN, NaN, NaN, NaN];
}

/**
 * The paths the page's own content paints, in order, with the CTM, the clips in effect and the
 * block that holds each. The page's streams are one content (a q in one may close in the next).
 * Forms are not entered: a shape drawn inside one is not found here. Throws WalkLimit past
 * images.MAX_WALK_OPERATIONS.
 */
function walkContent(page: MuPDF.PDFPage, texts: string[]): Painted[] {
  const painted: Painted[] = [];
  let gs = { ctm: page.getTransform() as Matrix, clips: null as ClipNode | null };
  const saved: (typeof gs)[] = [];
  const open: Block[] = [], closed: Block[] = [];
  let path: PathOp[] = [], clip = false, read = 0;
  const paintsOne = (p: Painted | null) => {
    for (const b of open) {
      b.paints++;
      if (b.first === undefined) b.first = p;
    }
  };
  texts.forEach((s, stream) => {
    for (const o of operations(s)) {
      if (++read > MAX_WALK_OPERATIONS) throw new WalkLimit(`More than ${MAX_WALK_OPERATIONS} operations`);
      if (PATH.has(o.op)) {
        path.push({ op: o.op, nums: isNumeric(o.args, PATH_OPERANDS[o.op]) ? numbersOf(o.args) : [NaN], stream, start: o.start, end: o.end });
        continue;
      }
      switch (o.op) {
        case "q":
          saved.push(gs);
          gs = { ...gs };
          open.push({ stream, depth: saved.length, paints: 0, first: undefined });
          break;
        case "Q":
          if (saved.length) {
            gs = saved.pop()!;
            const b = open.pop();
            if (b && b.stream === stream) closed.push(b);
          }
          break;
        case "cm":
          if (isNumeric(o.args, 6)) gs.ctm = concat(numbersOf(o.args) as Matrix, gs.ctm);
          break;
        case "W":
        case "W*":
          clip = true;
          break;
        case "n":
          if (clip && path.length) gs.clips = { clip: { ops: path, ctm: gs.ctm, depth: saved.length }, prev: gs.clips };
          path = [];
          clip = false;
          break;
        case "Do":
        case "BI":
          paintsOne(null);
          break;
        default:
          if (!PAINT.has(o.op)) break;
          if ((FILLS.has(o.op) || STROKES.has(o.op)) && path.length) {
            const p: Painted = {
              ops: path,
              paint: { op: o.op, stream, start: o.start, end: o.end },
              ctm: gs.ctm,
              bbox: boundsOf(path, gs.ctm),
              fill: FILLS.has(o.op),
              stroke: STROKES.has(o.op),
              odd: clip || path.some((q) => q.nums.some((v) => !Number.isFinite(v)) || q.stream !== stream),
              clips: gs.clips,
              unit: null,
            };
            painted.push(p);
            paintsOne(p);
            if (clip) gs.clips = { clip: { ops: path, ctm: gs.ctm, depth: saved.length }, prev: gs.clips };
          } else paintsOne(null); // text shown, a shading
          path = [];
          clip = false;
      }
    }
  });
  // Blocks close inner-first, so the last one found for a path is the outermost.
  for (const b of closed) if (b.paints === 1 && b.first) b.first.unit = b;
  return painted;
}

/**
 * The painted paths a shape can be: painted the same way (B and b count as both), at its bounds.
 * They are sorted by their left edge once, so that each shape looks only at those near its own.
 */
function matcher(painted: Painted[]): (paint: "fill" | "stroke", bbox: Rect) => Painted[] {
  const sorted = painted.filter((p) => Number.isFinite(p.bbox[0])).sort((a, b) => a.bbox[0] - b.bbox[0]);
  return (paint, bbox) => {
    let lo = 0, hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid].bbox[0] < bbox[0] - BOUNDS_EPS) lo = mid + 1;
      else hi = mid;
    }
    const out: Painted[] = [];
    for (let k = lo; k < sorted.length && sorted[k].bbox[0] <= bbox[0] + BOUNDS_EPS; k++) {
      const p = sorted[k];
      if ((paint === "fill" ? p.fill : p.stroke) && nearRect(p.bbox, bbox, BOUNDS_EPS)) out.push(p);
    }
    return out;
  };
}

/** Bytes that end a token: whitespace and delimiters. */
const SEPARATOR = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32, ..."()<>[]{}/%"].map((x) => (typeof x === "number" ? x : x.charCodeAt(0)))) SEPARATOR[c] = 1;

/**
 * The path paints of some content (f F f* S s B B* b b*), counted fast on its bytes (a string that
 * holds such a word adds one), up to just past `cap`; and in `draws`, how many times it draws each
 * XObject (`/Name Do`).
 */
function scanPaints(streams: Uint8Array[], draws: Map<string, number>, cap: number): number {
  let n = 0;
  for (const b of streams) {
    let name: string | null = null;
    for (let i = 0; i < b.length; ) {
      const c = b[i];
      if (SEPARATOR[c] && c !== 47) {
        i++;
        continue;
      }
      let j = i + 1;
      while (j < b.length && !SEPARATOR[b[j]]) j++;
      if (c === 47) {
        // A name, remembered for a Do right after it.
        name = latin1(b.subarray(i + 1, j));
        i = j;
        continue;
      }
      const len = j - i;
      if (len === 2 && c === 68 && b[i + 1] === 111) {
        if (name !== null) draws.set(name, (draws.get(name) ?? 0) + 1); // Do
      } else if ((len === 1 && (c === 102 || c === 70 || c === 83 || c === 115 || c === 66 || c === 98)) ||
        (len === 2 && b[i + 1] === 42 && (c === 102 || c === 66 || c === 98))) {
        if (++n > cap) return n; // f F S s B b, f* B* b*
      }
      name = null;
      i = j;
    }
  }
  return n;
}

/**
 * The path paints MuPDF runs for the page: those of its own content and those of the forms it
 * draws, each form as many times as it is drawn (forms inside forms too), counted on their bytes
 * up to just past `cap`. A form is read once, however often it is drawn.
 */
function countPaints(streams: Uint8Array[], resources: Obj, cap: number): number {
  const forms = new Map<number, number>();
  const count = (content: Uint8Array[], res: Obj, depth: number, inside: number[]): number => {
    const draws = new Map<string, number>();
    let n = scanPaints(content, draws, cap);
    const xobjects = res.isDictionary() ? res.get("XObject") : null;
    if (n > cap || !draws.size || depth >= MAX_FORM_DEPTH || !xobjects?.isDictionary()) return n;
    for (const [raw, times] of draws) {
      const xo = xobjects.get(nameFrom(raw));
      if (!xo.isStream() || !xo.isIndirect()) continue;
      const subtype = xo.get("Subtype");
      if (!subtype.isName() || subtype.asName() !== "Form") continue;
      const num = xo.asIndirect();
      if (inside.includes(num)) continue; // a form that draws itself (MuPDF stops it too)
      let each = forms.get(num);
      if (each === undefined) {
        let bytes: Uint8Array;
        try {
          bytes = streamBytes(xo);
        } catch {
          continue;
        }
        const own = xo.get("Resources");
        each = count([bytes], own.isDictionary() ? own : res, depth + 1, [...inside, num]);
        forms.set(num, each);
      }
      n += each * times;
      if (n > cap) return n;
    }
    return n;
  };
  return count(streams, resources, 0, []);
}

// ---------------------------------------------------------------------------------------------
// Detection

/** A shape found for the line, while it is decided. */
interface Candidate {
  drawn: Drawn;
  plan: ShapePlan;
  level: "auto" | "option" | "left";
  reasons: Set<DecorationLeftReason>;
  /** The side margins of a box (pt). */
  margins?: [number, number];
  /** A dotted or dashed rule made of several pieces (`drawn` is the first): never looked for in the content. */
  pieces?: Drawn[];
}

const reasonOf = (reasons: Set<DecorationLeftReason>) => REASONS.find((r) => reasons.has(r));

/** Where a thin rule's middle sits across the line: the kind of rule, or null. */
function bandOf(vc: number, S: number): "underline" | "strike" | "overline" | null {
  if (vc >= -0.05 * S && vc <= 0.4 * S) return "underline";
  if (vc >= -0.5 * S && vc <= -0.12 * S) return "strike";
  if (vc >= -1.15 * S && vc <= -0.7 * S) return "overline";
  return null;
}

/**
 * The run of characters whose left edge is at t0 and right edge at t1 (within `tol`, or `tolEnd`
 * at the end; `inside`: the left edge may also be up to inside[0] after t0, the right edge up to
 * inside[1] before t1, for a shape that runs past the text): the best match for each end, the
 * nearest (the first on a tie at the start, the last at the end). Null when there is none.
 */
function runAt(chars: Placed[], t0: number, t1: number, tol: number, tolEnd = tol, inside: [number, number] = [0, 0]): [number, number] | null {
  let a = -1, b = -1, da = Infinity, db = Infinity;
  for (let k = 0; k < chars.length; k++) {
    const c = chars[k], d0 = Math.abs(c.t0 - t0), d1 = Math.abs(c.t1 - t1);
    if ((d0 <= tol || (c.t0 > t0 && d0 <= inside[0])) && d0 < da - 1e-9) {
      a = k;
      da = d0;
    }
    if ((d1 <= tolEnd || (c.t1 < t1 && d1 <= inside[1])) && d1 <= db + 1e-9) {
      b = k + 1;
      db = d1;
    }
  }
  return a >= 0 && b > a ? [a, b] : null;
}

/** Whether [a, b) starts and ends where a word does (or the line, or at a blank). */
const wordAligned = (chars: Placed[], [a, b]: [number, number]) =>
  (a === 0 || chars[a - 1].blank || chars[a].blank) && (b === chars.length || chars[b].blank || chars[b - 1].blank);

/** A character of a word: a letter or a digit (or a mark on one). */
const WORD_CHAR = /^[\p{L}\p{N}\p{M}]+$/u;
/** Whether a word starts or ends between characters k - 1 and k: the line's ends, or a character that is not a word's (a blank, punctuation, a bracket, a slash, a dash) on either side. */
const wordEdge = (chars: Placed[], k: number) => k <= 0 || k >= chars.length || !WORD_CHAR.test(chars[k - 1].c) || !WORD_CHAR.test(chars[k].c);
/** Whether [a, b) is one or more whole words: "EN" and "IT" in "EN/IT", "1" in "(1)" or "1, 2". */
const wholeWords = (chars: Placed[], [a, b]: [number, number]) => wordEdge(chars, a) && wordEdge(chars, b);

/** [a, b) without the blank characters at its ends (null when nothing else is left). */
function trimmed(chars: Placed[], a: number, b: number): [number, number] | null {
  while (a < b && chars[a].blank) a++;
  while (b > a && chars[b - 1].blank) b--;
  return b > a ? [a, b] : null;
}

/** The shape's extent in the frame (a stroke's half-width added across, measured along the line's normal). */
function extentOf(F: Frame, d: Drawn) {
  let t0 = Infinity, t1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const p of d.points) {
    const t = tOf(F, p), v = vOf(F, p);
    if (t < t0) t0 = t;
    if (t > t1) t1 = t;
    if (v < v0) v0 = v;
    if (v > v1) v1 = v;
  }
  if (d.paint === "stroke") {
    // The pen is the user-space circle of the line width under the CTM: its reach along the
    // page-space normal n is half the width times |A n| (A the CTM's linear part).
    const m = d.ctm, n = F.n;
    const reach = (d.lineWidth / 2) * Math.hypot(m[0] * n[0] + m[1] * n[1], m[2] * n[0] + m[3] * n[1]);
    v0 -= reach;
    v1 += reach;
  }
  return { t0, t1, v0, v1 };
}

/**
 * Find the line's decorations on page `pageIndex` as it is now. The line is located exactly as
 * core.replaceText locates it: `find` (the trimmed line text) at `occurrence` (core.findInLines).
 * Throws only for a missing line; a page too complex to read gives every candidate "left" with
 * "complex" (or nothing, when not even the candidates can be read), never a throw.
 */
export function detectDecorations(mupdf: MuPDFModule, doc: Doc, pageIndex: number, find: string, occurrence: number): Detected {
  const page = doc.loadPage(pageIndex);
  let lines: Line[] = [];
  try {
    lines = extractLines(page) as Line[];
    const hit = lineHit(lines, find, occurrence, pageIndex);
    const S = hit.chars[0].size;
    const u: Point = [hit.line.dir[0], hit.line.dir[1]];
    const F = frameOf(u, [hit.chars[0].origin[0], hit.chars[0].origin[1]], S);
    const chars = hit.chars.map((ch) => placed(F, ch));
    const direction = hit.line.wmode === 1 || !alongAxes(u);
    const others: Point[] = [];
    for (const l of lines) if (l !== hit.line) for (const ch of l.chars) if (ch.c.trim()) others.push(placed(F, ch).centre);

    const shapes = findShapes(mupdf, page, lines, hit, F, chars, others, direction);
    const links = findLinks(doc, pageIndex, page, F, chars, others, direction);

    const out: Detected = {
      shapes: shapes.map((c) => ({
        plan: c.plan, level: c.level, ...(c.level === "left" ? { reason: reasonOf(c.reasons) ?? "complex" } : {}),
      })),
      links,
      box: null,
    };
    const offered = shapes.filter((c) => c.level === "option");
    if (offered.length) {
      // Ticked when every box offered hugs the text: both margins at most 1.5 S, about equal.
      const snug = offered.every(({ margins: [ml, mr] = [Infinity, Infinity] }) =>
        ml <= 1.5 * S && mr <= 1.5 * S && Math.abs(ml - mr) <= 0.5 * S);
      out.box = {
        fill: offered.some((c) => c.plan.paint === "fill"), stroke: offered.some((c) => c.plan.paint === "stroke"), suggested: snug,
      };
    }
    return out;
  } finally {
    releasePage(page, lines);
  }
}

function leave(c: Candidate, reason: DecorationLeftReason) {
  c.level = "left";
  c.reasons.add(reason);
}

/** A thin shape in one of the line's bands (a rule, a dot, a dash), in the line's frame: along t, its middle and thickness across. */
type Piece = { d: Drawn; kind: "underline" | "strike" | "overline"; t0: number; t1: number; vc: number; thick: number };

/** The extent of a shape in the line's frame (extentOf). */
type Extent = ReturnType<typeof extentOf>;

/**
 * The line's shapes: the device pass, the rules (the pieces of dotted and dashed ones first), the
 * boxes, isolation and layout, then where each is in the page's own content.
 */
function findShapes(
  mupdf: MuPDFModule, page: MuPDF.PDFPage, lines: Line[], hit: { line: Line; chars: LineChar[] }, F: Frame, chars: Placed[], others: Point[],
  direction: boolean,
): Candidate[] {
  const S = F.S;
  const ink = chars.filter((c) => !c.blank);
  if (!ink.length) return [];
  let tMin = Infinity, tMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  for (const c of ink) {
    tMin = Math.min(tMin, c.t0);
    tMax = Math.max(tMax, c.t1);
    vMin = Math.min(vMin, c.v0);
    vMax = Math.max(vMax, c.v1);
  }
  // Where a candidate, or a shape touching or lining up with one, can be: the line's characters
  // and 4.5 S along, 5 S across.
  const region = frameBox(F, tMin - 4.5 * S - 2, tMax + 4.5 * S + 2, vMin - 5 * S - 2, vMax + 5 * S + 2);
  const lineBox = grown(pointBounds(ink.flatMap((c) => [atTV(F, c.t0, c.v0), atTV(F, c.t1, c.v1)])), 1);

  let content: Content;
  try {
    content = readContent(page.getObject());
  } catch {
    return []; // the content cannot be read: not even the candidates
  }
  // Far beyond the cap, even the device pass would keep the worker busy: nothing is read. Up to
  // it, the pass reads the first MAX_PATHS paths, and what it finds is "complex". A form counts
  // as often as it is drawn: MuPDF runs it each time.
  if (countPaints(content.bytes, page.getObject().getInheritable("Resources"), 2 * MAX_PATHS) > 2 * MAX_PATHS) return [];
  const pass = devicePass(mupdf, page, region, lineBox);

  // The paint of each character's glyph (the first drawn at its origin).
  const glyphPaint = hit.chars.map((ch) => {
    if (!ch.c.trim()) return null;
    const o = ch.glyphOrigin ?? ch.origin;
    return pass.texts.find((tp) => tp.origins.some((g) => Math.abs(g[0] - o[0]) < GLYPH_EPS && Math.abs(g[1] - o[1]) < GLYPH_EPS)) ?? null;
  });
  const paintOf = (a: number, b: number) => glyphPaint.slice(a, b).find((p) => p) ?? null;
  const firstText = (a: number, b: number) => {
    let order = Infinity;
    for (const p of glyphPaint.slice(a, b)) if (p) order = Math.min(order, p.order);
    return order;
  };

  const thin = Math.max(0.2 * S, 2.5), tol = Math.max(0.15 * S, 0.75);
  const out: Candidate[] = [];
  const pieces: Piece[] = [];
  const first = chars.findIndex((c) => !c.blank), last = chars.length - 1 - [...chars].reverse().findIndex((c) => !c.blank);
  for (const d of pass.drawn) {
    if (d.huge) continue; // (it still counts for isolation)
    const { t0, t1, v0, v1 } = extentOf(F, d);
    const thick = v1 - v0, len = t1 - t0;
    if (t1 < chars[first].t0 - 3 * S || t0 > chars[last].t1 + 3 * S) continue;
    if (thick <= thin) {
      const vc = (v0 + v1) / 2, kind = bandOf(vc, S);
      if (kind) pieces.push({ d, kind, t0, t1, vc, thick });
      continue;
    }
    // A box: it covers a run of characters across their height, with small margins.
    if (len < 0.3 * S || thick > 3.5 * S || t1 < tMin || t0 > tMax) continue;
    const covered = chars.map((c, k) => ((c.t0 + c.t1) / 2 >= t0 && (c.t0 + c.t1) / 2 <= t1 ? k : -1)).filter((k) => k >= 0);
    if (!covered.length || covered.length !== covered[covered.length - 1] - covered[0] + 1) continue;
    const run = trimmed(chars, covered[0], covered[covered.length - 1] + 1);
    if (!run) continue;
    let vTop = Infinity, vBot = -Infinity;
    for (const c of chars.slice(run[0], run[1])) if (!c.blank) {
      vTop = Math.min(vTop, c.v0);
      vBot = Math.max(vBot, c.v1);
    }
    if (!(v0 <= vTop + 0.3 * S && v1 >= vBot - 0.3 * S)) continue;
    const ml = chars[run[0]].t0 - t0, mr = t1 - chars[run[1] - 1].t1;
    if (ml < -0.1 * S || mr < -0.1 * S || ml > 2.5 * S || mr > 2.5 * S) continue;
    const c: Candidate = {
      drawn: d, plan: { kind: d.paint === "stroke" ? "border" : "background", paint: d.paint, bbox: d.bbox, range: run },
      level: "option", reasons: new Set(), margins: [ml, mr],
    };
    if (others.some((p) => inRect(d.bbox, p))) leave(c, "shared");
    const text = firstText(run[0], run[1]);
    if (!Number.isFinite(text)) leave(c, "complex"); // where the text is painted is not known
    else if (d.order > text && !(d.alpha < 1)) leave(c, "cover");
    out.push(c);
  }

  /**
   * The rule a piece is when its ends sit on a run of the line's characters ("not": none; "other":
   * another line's). A piece shorter than 0.3 S (a dot) is none, unless `short`.
   */
  const ruleOf = (p: Piece, short = false): Candidate | "not" | "other" => {
    const run = short || p.t1 - p.t0 >= 0.3 * S ? runAt(chars, p.t0, p.t1, tol) : null;
    if (!run) return "not"; // not on the characters' edges: a form's rule, a table's, a heading's...
    const other = otherLine(lines, hit.line, p.d, p.kind);
    if (other === "above") return "other";
    const c: Candidate = { drawn: p.d, plan: { kind: p.kind, paint: p.d.paint, bbox: p.d.bbox, range: run }, level: "auto", reasons: new Set() };
    if (p.d.subpaths > 1 || p.d.dashed) leave(c, "pattern");
    if (other === "same") leave(c, "shared"); // a sum column's rule: under one line, over the next
    else if (p.kind === "overline") leave(c, "overline");
    if (!sameColour(p.d.colour, paintOf(run[0], run[1])?.colour ?? null)) leave(c, "colour");
    return c;
  };

  if (pieces.length > MAX_PIECES) {
    // Too many to sort out (a dense hatching, dots everywhere): what matches a run stays.
    for (const p of pieces) {
      const c = ruleOf(p);
      if (typeof c !== "string") out.push(c);
      if (out.length > MAX_CANDIDATES) break;
    }
    return crowded(out);
  }
  /**
   * The rules of pieces in a row when each is a run of whole words of the line, after the one
   * before: words underlined one by one (a language switch "EN IT" or "EN/IT", pagination "1 2 3",
   * "1 | 2 | 3", "1, 2, 3" or "(1) (2) (3)"); null when one is not. A short piece (at most 1.5 S)
   * may end at punctuation, a bracket, a slash or a dash (wholeWords); a long one only at a blank
   * or the line's end (wordAligned), and right on its characters' edges (within WORD_HUG): the
   * long dashes of a dashed rule often end within `tol` of punctuation ("Rev. 2.1 (draft)",
   * "17/10/2026"), and they would then follow the text piece by piece.
   */
  const wordsOf = (row: Piece[]): Candidate[] | null => {
    const words: Candidate[] = [];
    for (const p of row) {
      const c = ruleOf(p, true);
      if (typeof c === "string" || (words.length && c.plan.range[0] < words[words.length - 1].plan.range[1])) return null;
      const [a, b] = c.plan.range;
      const word = p.t1 - p.t0 <= 1.5 * S
        ? wholeWords(chars, c.plan.range)
        : wordAligned(chars, c.plan.range) && Math.abs(chars[a].t0 - p.t0) <= WORD_HUG && Math.abs(chars[b - 1].t1 - p.t1) <= WORD_HUG;
      if (!word) return null;
      words.push(c);
    }
    return words;
  };
  /**
   * Two or more short pieces one after the other that are no regular dashed or dotted rule: words
   * underlined one by one (wordsOf), left as the layout's ("shared"); otherwise a dotted rule all
   * the same, left as a whole ("pattern").
   */
  const shortRow = (dots: Piece[]): Candidate[] => {
    const words = wordsOf(dots);
    if (words) {
      for (const c of words) leave(c, "shared");
      return words;
    }
    const dotted = patternOf(dots, chars, tol);
    return dotted ? [dotted] : [];
  };
  // Dots and dashes first, so that none of them is a rule on its own: a row that is a regular
  // row of like pieces (patternIn), however long they are, whose gaps fall across the words and
  // which is not words underlined one by one, is one dashed or dotted rule, left as a whole
  // ("pattern"); of the other pieces, two or more short ones one after the other are one too, or
  // words underlined one by one (shortRow).
  const alone: Piece[] = [];
  for (const row of rowsOf(pieces, S)) {
    let stretches = [row];
    const [i, j] = patternIn(row);
    if (j > i) {
      const run = row.slice(i, j);
      // (Gaps between the words: a table's cells as wide as each other, or underlined words.)
      if (acrossWords(run, ink) && !wordsOf(run)) {
        const c = patternOf(run, chars, tol);
        if (c) out.push(c);
        stretches = [row.slice(0, i), row.slice(j)];
      }
    }
    for (const stretch of stretches) {
      let dots: Piece[] = [];
      const flush = () => {
        if (dots.length >= 2) out.push(...shortRow(dots));
        else alone.push(...dots);
        dots = [];
      };
      for (const p of stretch) {
        if (p.t1 - p.t0 <= 1.5 * S) dots.push(p);
        else {
          flush();
          alone.push(p);
        }
      }
      flush();
    }
  }
  const rest: Piece[] = [];
  for (const p of alone) {
    const c = ruleOf(p);
    if (c === "not") rest.push(p);
    else if (c !== "other") out.push(c);
  }
  out.push(...dottedRules(rest, chars, S, tol));
  if (out.length > MAX_CANDIDATES) return crowded(out);
  out.sort((a, b) => a.drawn.order - b.drawn.order);

  // Isolation: a shape that touches another one, neither holding the other, is part of a layout.
  // Layout: a shape one of a row or a column of like shapes that are not this line's (the
  // cells of a table with spacing between them: they do not touch). The line's own shapes, the
  // pieces of a dotted rule included, do not count.
  const mine = new Set(out.flatMap((c) => c.pieces ?? [c.drawn]));
  const near = gridOf(pass.drawn, Math.max(2 * S, 4));
  const extents = new Map<Drawn, Extent>();
  const extent = (d: Drawn) => {
    let e = extents.get(d);
    if (!e) extents.set(d, (e = extentOf(F, d)));
    return e;
  };
  let checks = 0;
  for (const c of out) {
    const B = grown(c.drawn.bbox, TOUCH);
    const around = near(B);
    checks += around.length;
    if (around.some((d) => !mine.has(d) && meets(d.bbox, B) && !holds(d.bbox, c.drawn.bbox) && !holds(c.drawn.bbox, d.bbox))) leave(c, "shared");
    else if (!c.pieces) {
      const e = extent(c.drawn);
      const like = near(frameBox(F, e.t0 - S - 1, e.t1 + S + 1, e.v0 - 3.5 * S, e.v1 + 3.5 * S));
      checks += like.length;
      if (inLayout(c, e, like, mine, extent, S)) leave(c, "shared");
    }
    if (checks > MAX_CHECKS) break;
  }
  if (checks > MAX_CHECKS) for (const c of out) leave(c, "complex");
  if (direction) for (const c of out) leave(c, "direction");
  if (pass.complex) for (const c of out) leave(c, "complex");
  else if (out.some((c) => c.level !== "left")) {
    const twice = locateInContent(page, content, out);
    return out.filter((c) => !twice.has(c));
  }
  return out;
}

/** The page-space bounds of the frame's box t0..t1 along, v0..v1 across. */
const frameBox = (F: Frame, t0: number, t1: number, v0: number, v1: number): Rect =>
  pointBounds([atTV(F, t0, v0), atTV(F, t1, v0), atTV(F, t1, v1), atTV(F, t0, v1)]);

/** The bounds of points, however many (no spread: V8 throws past about 120,000 arguments). */
function pointBounds(points: Point[]): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of points) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

/** Too many shapes to look at one by one: one of each kind is said, "complex", and none follows. */
function crowded(out: Candidate[]): Candidate[] {
  const kinds = new Set<DecorationKind>();
  return out.filter((c) => {
    if (kinds.has(c.plan.kind)) return false;
    kinds.add(c.plan.kind);
    leave(c, "complex");
    return true;
  });
}

/**
 * The paths of a pass by where they are (square cells of `size` pt), to find those whose bounds
 * may meet a rect without looking at them all. A path over many cells (a page's background) is
 * looked at for every rect.
 */
function gridOf(drawn: Drawn[], size: number): (r: Rect) => Drawn[] {
  const LIMIT = 1 << 20;
  const cell = (v: number) => Math.max(-LIMIT, Math.min(LIMIT - 1, Math.floor(v / size)));
  const key = (i: number, j: number) => (i + LIMIT) * 2 * LIMIT + (j + LIMIT);
  const cells = new Map<number, Drawn[]>(), wide: Drawn[] = [];
  for (const d of drawn) {
    const i0 = cell(d.bbox[0]), i1 = cell(d.bbox[2]), j0 = cell(d.bbox[1]), j1 = cell(d.bbox[3]);
    if ((i1 - i0 + 1) * (j1 - j0 + 1) > 64) {
      wide.push(d);
      continue;
    }
    for (let i = i0; i <= i1; i++)
      for (let j = j0; j <= j1; j++) {
        const k = key(i, j), list = cells.get(k);
        if (list) list.push(d);
        else cells.set(k, [d]);
      }
  }
  return (r) => {
    const found = new Set<Drawn>(wide);
    const i0 = cell(r[0]), i1 = cell(r[2]), j0 = cell(r[1]), j1 = cell(r[3]);
    if ((i1 - i0 + 1) * (j1 - j0 + 1) > 4096) return drawn; // (a rect over most of the page: all of them)
    for (let i = i0; i <= i1; i++)
      for (let j = j0; j <= j1; j++) for (const d of cells.get(key(i, j)) ?? []) found.add(d);
    return [...found];
  };
}

/**
 * Whether candidate `c` is one of a row or a column of like shapes that are not this line's: the
 * cells of a table (their bottom borders, or their backgrounds) with spacing between them, which
 * do not touch. Like: painted the same way, in the very same colour, as thick (a rule) or as high
 * (a box, in a row). A row: at the same height across, the next one at most S away along. A
 * column: the same extent along; the next box at most S away across, the next rule 0.6 to 3 S
 * away (a row of a table further down, not this line's own double rule or strike-through, which
 * are its shapes anyway).
 */
function inLayout(c: Candidate, e: Extent, near: Drawn[], mine: Set<Drawn>, extent: (d: Drawn) => Extent, S: number): boolean {
  const rule = c.plan.kind !== "background" && c.plan.kind !== "border";
  const same = (a: number, b: number) => Math.abs(a - b) <= LAYOUT_EPS;
  for (const d of near) {
    if (d === c.drawn || mine.has(d) || d.paint !== c.drawn.paint || !sameValues(d.colour, c.drawn.colour)) continue;
    const x = extent(d);
    if (same(x.v0, e.v0) && same(x.v1, e.v1) && Math.max(x.t0 - e.t1, e.t0 - x.t1) <= S) return true;
    if (!same(x.t0, e.t0) || !same(x.t1, e.t1)) continue;
    if (!rule) {
      if (Math.max(x.v0 - e.v1, e.v0 - x.v1) <= S) return true;
      continue;
    }
    const pitch = Math.abs((x.v0 + x.v1) / 2 - (e.v0 + e.v1) / 2);
    if (same(x.v1 - x.v0, e.v1 - e.v0) && pitch > 0.6 * S && pitch <= 3 * S) return true;
  }
  return false;
}

/**
 * How a rule of this line's (in its `kind` band, its ends on its characters) stands to the other
 * lines in the same direction:
 * - "same": it is in another line's opposite band (the overline band of the line below for an
 *   underline, the underline band of the line above for an overline), its ends right on a run of
 *   that line's words too (within 0.3 pt: the same text typeset alike, a rule drawn to it). A sum
 *   column's rule, under an addend and over a total of the same width, is both lines' or neither's.
 * - "above": an overline that is in the underline band of the line above and under its
 *   characters, its ends not on them: that line's underline (tight leading), not this line's.
 * Null otherwise. (Lines one under the other start at the same place: one end on another line's
 * characters says nothing; both, at a word's edges and that close, do. A word's edge here is a
 * blank or the line's end only, wordAligned, not punctuation as for words underlined one by one:
 * at the usual leading every underline is in the next line's overline band, and more edges would
 * leave more real underlines by chance.)
 */
function otherLine(lines: Line[], line: Line, d: Drawn, kind: Piece["kind"]): "same" | "above" | null {
  if (kind === "strike") return null;
  const band = kind === "underline" ? "overline" : "underline";
  let above = false;
  for (const l of lines) {
    if (l === line || !l.chars.length || l.dir[0] !== line.dir[0] || l.dir[1] !== line.dir[1]) continue;
    const ch = l.chars.find((c) => c.c.trim()) ?? l.chars[0];
    if (l.bbox && !meets(grown(l.bbox as Rect, 2 * ch.size), d.bbox)) continue;
    const G = frameOf([l.dir[0], l.dir[1]], [ch.origin[0], ch.origin[1]], ch.size);
    const { t0, t1, v0, v1 } = extentOf(G, d);
    if (bandOf((v0 + v1) / 2, G.S) !== band) continue;
    const own = l.chars.map((c) => placed(G, c));
    const run = runAt(own, t0, t1, 0.3);
    if (run && wordAligned(own, run)) return "same";
    if (kind !== "overline") continue;
    let a = Infinity, b = -Infinity;
    for (const c of own) if (!c.blank) {
      a = Math.min(a, c.t0);
      b = Math.max(b, c.t1);
    }
    if (t1 > a && t0 < b) above = true;
  }
  return above ? "above" : null;
}

/**
 * The pieces in rows: in one band, at the same height (within 0.25 pt), one after the other
 * along the line with gaps of at most S. Sorted, then swept: n log n.
 */
function rowsOf(pieces: Piece[], S: number): Piece[][] {
  const sorted = [...pieces].sort((a, b) => (a.kind === b.kind ? a.vc - b.vc : a.kind < b.kind ? -1 : 1));
  const rows: Piece[][] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i + 1;
    while (j < sorted.length && sorted[j].kind === sorted[i].kind && sorted[j].vc - sorted[i].vc <= 0.25) j++;
    const level = sorted.slice(i, j).sort((a, b) => a.t0 - b.t0);
    let row = [level[0]], end = level[0].t1;
    for (const q of level.slice(1)) {
      if (q.t0 - end > S) {
        rows.push(row);
        row = [];
      }
      row.push(q);
      end = row.length === 1 ? q.t1 : Math.max(end, q.t1);
    }
    rows.push(row);
    i = j;
  }
  return rows;
}

/**
 * The part [i, j) of a row (of rowsOf, by t) that is a regular row of pieces (patternEnd): the
 * whole row, or all of it but one piece at either end or both (an underlined word next to a
 * dashed one); [0, 0] when there is none. Only the whole row: three pieces that happen to be
 * alike inside a row of others (a dense hatching) are none.
 */
function patternIn(row: Piece[]): [number, number] {
  const n = row.length;
  for (const i of [0, 1])
    for (const j of [n, n - 1]) if (j - i >= 3 && patternEnd(row, i) === j) return [i, j];
  return [0, 0];
}

/**
 * Where the regular row of pieces that starts at row[i] ends, or i when none starts there: three
 * or more like pieces (painted the same way, in the very same colour, as thick), as long as each
 * other, one after the other with gaps as long as each other (more than PATTERN_EPS: pieces that
 * touch are a rule drawn in parts); the first and the last may be shorter (where the pattern is
 * cut), and at least two are whole. A dashed or dotted rule whatever the length of its dashes,
 * or words underlined one by one as long as each other ("1 2 3"), or a table's cells as wide as
 * each other: acrossWords and whether each piece is a word's tell them apart.
 */
function patternEnd(row: Piece[], i: number): number {
  if (i + 2 >= row.length) return i;
  const a = row[i], b = row[i + 1];
  const len = (p: Piece) => p.t1 - p.t0;
  const same = (x: number, y: number) => Math.abs(x - y) <= PATTERN_EPS;
  const like = (p: Piece) => p.d.paint === a.d.paint && sameValues(p.d.colour, a.d.colour) && same(p.thick, a.thick);
  const L = len(b), gap = b.t0 - a.t1;
  if (gap <= PATTERN_EPS || !like(b) || len(a) > L + PATTERN_EPS) return i;
  let whole = same(len(a), L) ? 2 : 1, j = i + 2;
  while (j < row.length) {
    const p = row[j];
    if (!like(p) || !same(p.t0 - row[j - 1].t1, gap) || len(p) > L + PATTERN_EPS) break;
    j++;
    if (!same(len(p), L)) break; // a shorter last piece
    whole++;
  }
  return j - i >= 3 && whole >= 2 ? j : i;
}

/**
 * Whether a gap between the pieces of a row falls on one of the line's characters (`ink`, its
 * characters that are not blank): a dashed or dotted rule is drawn across the words, while a
 * table's cells (and most words underlined one by one) leave their gaps between the words.
 */
function acrossWords(run: Piece[], ink: Placed[]): boolean {
  for (let k = 1; k < run.length; k++) {
    const mid = (run[k - 1].t1 + run[k].t0) / 2;
    if (ink.some((c) => c.t0 < mid && mid < c.t1)) return true;
  }
  return false;
}

/**
 * A dotted or dashed rule (`dots`: its pieces in a row) as one shape, left as it is ("pattern"),
 * when it spans a run of the line's characters: the run starts at the row's start, or in its first
 * piece or the gap after it; it ends at the row's end, in its last piece or the gap before it (a
 * pattern drawn in whole dashes, the last one past the text), or up to a gap past it (a pattern
 * stopped short of the text's end). Null when it spans none.
 */
function patternOf(dots: Piece[], chars: Placed[], tol: number): Candidate | null {
  let end = -Infinity, gap = 0, last = dots[0];
  dots.forEach((q, k) => {
    if (k) gap = Math.max(gap, q.t0 - end);
    end = Math.max(end, q.t1);
    if (q.t1 >= last.t1) last = q;
  });
  const first = dots[0];
  const run = runAt(chars, first.t0, end, tol, tol + gap, [first.t1 - first.t0 + gap + tol, last.t1 - last.t0 + gap + tol]);
  if (!run) return null;
  return {
    drawn: dots[0].d, pieces: dots.map((q) => q.d), level: "left", reasons: new Set(["pattern"]),
    plan: { kind: dots[0].kind, paint: dots[0].d.paint, bbox: pointBounds(dots.flatMap((q) => q.d.points)), range: run },
  };
}

/**
 * Rows of thin pieces that match no run by themselves but together span one (an underline drawn
 * in pieces, a dotted rule of long dashes): one shape each, left as they are ("pattern"). The row
 * may start at any of its pieces; it ends at its last.
 */
function dottedRules(pieces: Piece[], chars: Placed[], S: number, tol: number): Candidate[] {
  const out: Candidate[] = [];
  for (const row of rowsOf(pieces, S)) {
    if (row.length < 2) continue;
    let end = -Infinity;
    for (const q of row) end = Math.max(end, q.t1);
    for (let k = 0; k + 1 < row.length; k++) {
      const run = runAt(chars, row[k].t0, end, tol);
      if (!run) continue;
      const part = row.slice(k);
      out.push({
        drawn: part[0].d, pieces: part.map((q) => q.d), level: "left", reasons: new Set(["pattern"]),
        plan: { kind: part[0].kind, paint: part[0].d.paint, bbox: pointBounds(part.flatMap((q) => q.d.points)), range: run },
      });
      break;
    }
  }
  return out;
}

/**
 * Where each candidate is in the page's own content: exactly one path painted the same way at
 * its bounds. None: drawn inside a Form XObject (or by something else than the page's content),
 * "form" (or "complex" when a content stream could not be read); several, a path spanning two
 * streams, a path that is also a clip: "complex" (a shape already left keeps its own reason). A
 * fill and a stroke of one path (B, b) are one shape to rewrite: they must be decided alike, and
 * when both are the same kind (an underline filled and stroked) they are one decoration: the
 * candidates returned are the second ones, to drop.
 */
function locateInContent(page: MuPDF.PDFPage, content: Content, out: Candidate[]): Set<Candidate> {
  const twice = new Set<Candidate>();
  let find: ReturnType<typeof matcher>;
  try {
    find = matcher(walkContent(page, content.bytes.map(latin1)));
  } catch {
    for (const c of out) leave(c, "complex");
    return twice;
  }
  const byPath = new Map<Painted, Candidate[]>();
  for (const c of out) {
    if (c.pieces) continue;
    const found = find(c.plan.paint, c.plan.bbox);
    if (found.length === 1 && !found[0].odd) byPath.set(found[0], [...(byPath.get(found[0]) ?? []), c]);
    else if (c.level !== "left") leave(c, found.length || content.broken ? "complex" : "form");
  }
  for (const group of byPath.values()) {
    const kinds = new Set<DecorationKind>();
    for (const c of group) {
      if (kinds.has(c.plan.kind)) twice.add(c);
      kinds.add(c.plan.kind);
    }
    if (group.every((c) => c.level === group[0].level)) continue;
    const left = group.find((c) => c.level === "left");
    for (const c of group) leave(c, left ? reasonOf(left.reasons) ?? "complex" : "complex");
  }
  return twice;
}

/**
 * Whether a link's rect hugs the run of characters it covers: its sides along the line at most
 * 2.5 S past the run's ends (a button's padding, as for a box), and across at most 1.5 S past
 * the characters. A block link over a picture or a card and its caption does not: it is not the
 * caption's.
 */
function hugs(F: Frame, chars: Placed[], [a, b]: [number, number], r: Rect): boolean {
  const corners: Point[] = [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]];
  let t0 = Infinity, t1 = -Infinity, v0 = Infinity, v1 = -Infinity, cv0 = Infinity, cv1 = -Infinity;
  for (const p of corners) {
    const t = tOf(F, p), v = vOf(F, p);
    t0 = Math.min(t0, t);
    t1 = Math.max(t1, t);
    v0 = Math.min(v0, v);
    v1 = Math.max(v1, v);
  }
  for (const c of chars.slice(a, b)) if (!c.blank) {
    cv0 = Math.min(cv0, c.v0);
    cv1 = Math.max(cv1, c.v1);
  }
  const S = F.S;
  return chars[a].t0 - t0 <= 2.5 * S && t1 - chars[b - 1].t1 <= 2.5 * S && cv0 - v0 <= 1.5 * S && v1 - cv1 <= 1.5 * S;
}

/**
 * The line's links: those over its characters, each followed when it covers one run of them only,
 * hugs it, and is this page's only (not another page's too).
 */
function findLinks(
  doc: Doc, pageIndex: number, page: MuPDF.PDFPage, F: Frame, chars: Placed[], others: Point[], direction: boolean,
): Detected["links"] {
  const out: Detected["links"] = [];
  const links = page.getLinks();
  try {
    const all = links.map((l) => ({ bounds: l.getBounds() as Rect, uri: l.getURI() }));
    const dicts = linkDicts(doc, page);
    for (const { bounds, uri } of all) {
      const cov = chars.map((c, k) => (!c.blank && inRect(bounds, c.centre) ? k : -1)).filter((k) => k >= 0);
      if (!cov.length) continue;
      const run: [number, number] = [cov[0], cov[cov.length - 1] + 1];
      const plan: LinkPlan = { bounds, uri, range: run };
      const contiguous = chars.slice(run[0], run[1]).every((c) => c.blank || inRect(bounds, c.centre));
      const dict = all.filter((l) => l.uri === uri && nearRect(l.bounds, bounds, LINK_EPS)).length === 1 ? dictOf(dicts, bounds, uri) : null;
      if (direction) out.push({ plan, level: "left", reason: "direction" });
      else if (!contiguous || others.some((p) => inRect(bounds, p)) || !hugs(F, chars, run, bounds))
        out.push({ plan, level: "left", reason: "shared" });
      else if (!dict) out.push({ plan, level: "left", reason: "complex" });
      else if (sharedLink(doc, pageIndex, dict)) out.push({ plan, level: "left", reason: "shared" });
      else out.push({ plan, level: "auto" });
    }
  } finally {
    for (const l of links) l.destroy();
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Links as annotations

/**
 * A link annotation of the page: its /Annots entry, its dictionary, its rect in page space and,
 * when its action is a URI action, the URI as MuPDF gives it (Link.getURI).
 */
interface LinkDict {
  entry: Obj;
  dict: Obj;
  rect: Rect;
  uri: string | null;
}

/** The page's link annotations; an /Annots entry that is null or names no object is skipped, as MuPDF skips it. */
function linkDicts(doc: Doc, page: MuPDF.PDFPage): LinkDict[] {
  const out: LinkDict[] = [];
  const T = page.getTransform() as Matrix;
  const annots = page.getObject().get("Annots");
  if (!annots.isArray()) return out;
  annots.forEach((entry) => {
    if (entry.isNull()) return; // (PDFObject.Null cannot resolve)
    const dict = entry.resolve(); // (a missing object: null, no dictionary)
    if (!dict.isDictionary() || dict.get("Subtype").asName() !== "Link") return;
    const r = dict.get("Rect");
    if (!r.isArray() || r.length !== 4) return;
    const v = [0, 1, 2, 3].map((k) => r.get(k).asNumber());
    if (!v.every(Number.isFinite)) return;
    const action = dict.get("A");
    const uri = action.isDictionary() && action.get("S").asName() === "URI" ? uriOf(doc, action) : null;
    const rect = bboxOf([applyTo(T, v[0], v[1]), applyTo(T, v[2], v[1]), applyTo(T, v[2], v[3]), applyTo(T, v[0], v[3])]);
    out.push({ entry, dict, rect, uri });
  });
  return out;
}

/**
 * A URI action's URI as MuPDF reads it for Link.getURI (pdf_parse_link_action): one with no
 * scheme ("www.example.com/pay", "#total", a relative path) after the document's /URI /Base, or
 * after "file://" when it has none.
 */
function uriOf(doc: Doc, action: Obj): string {
  const uri = action.get("URI").asString();
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(uri)) return uri;
  const base = doc.getTrailer().get("Root", "URI", "Base");
  return (base.isNull() ? "file://" : base.asString()) + uri;
}

/**
 * Whether another page shows this link too: the same object in its /Annots, or this page's
 * /Annots array itself (an annotation is one page's, but merged or repeated pages can share one),
 * as images.ts's sharedStream asks of content streams. Moving or removing it for this page's line
 * would change the other page, so it stays ("shared"). (A copy for this page to edit would leave
 * the structure tree's object reference, and anything else that names the object, on the other
 * page's link: not worth it for files that break the rule.)
 */
function sharedLink(doc: Doc, pageIndex: number, link: LinkDict): boolean {
  const own = doc.findPage(pageIndex).get("Annots");
  const array = own.isIndirect() ? own.asIndirect() : 0;
  const num = link.entry.isIndirect() ? link.entry.asIndirect() : 0;
  for (let k = 0, n = doc.countPages(); k < n; k++) {
    if (k === pageIndex) continue;
    const annots = doc.findPage(k).get("Annots");
    if (array && annots.isIndirect() && annots.asIndirect() === array) return true;
    if (num && annots.isArray()) for (let i = 0; i < annots.length; i++) if (annots.get(i).asIndirect() === num) return true;
  }
  return false;
}

/** The annotation of the link at `bounds` with `uri`: one only (a URI action that says another URI is not it), or null. */
function dictOf(dicts: LinkDict[], bounds: Rect, uri: string): LinkDict | null {
  const found = dicts.filter((d) => nearRect(d.rect, bounds, LINK_EPS) && (d.uri === null || d.uri === uri));
  return found.length === 1 ? found[0] : null;
}

const annotIdentity = (o: Obj) => (o.isIndirect() ? `n${o.asIndirect()}` : `p${o.pointer}`);

/**
 * Takes a link annotation off the page: out of /Annots and, when it has a /StructParent and the
 * document a structure tree (tagged PDF), its object reference out of the structure element that
 * holds it and out of the parent tree. False, with nothing changed, when that cannot be done for
 * sure (the structure is not as expected): the link then stays. With no structure tree (pages
 * merged or copied from a tagged PDF keep /StructParent but lose the tree) nothing can name the
 * link: it just goes.
 */
function removeLink(doc: Doc, pageObj: Obj, link: LinkDict): boolean {
  const sp = link.dict.get("StructParent");
  const undo: (() => void)[] = [];
  const tagged = doc.getTrailer().get("Root", "StructTreeRoot").isDictionary();
  if (sp.isNumber() && tagged && !dropObjectReference(doc, link, sp.asNumber(), undo)) return false;
  const annots = pageObj.get("Annots");
  const id = annotIdentity(link.entry);
  for (let k = 0; annots.isArray() && k < annots.length; k++) {
    if (annotIdentity(annots.get(k)) !== id) continue;
    annots.delete(k);
    return true;
  }
  for (const f of undo.reverse()) f();
  return false;
}

/**
 * The structure element that parent tree key `key` names must hold exactly one object reference
 * (/Type /OBJR) to the link: that reference leaves the element's /K, and the key its parent-tree
 * leaf. `undo` gets what puts both back.
 */
function dropObjectReference(doc: Doc, link: LinkDict, key: number, undo: (() => void)[]): boolean {
  const tree = doc.getTrailer().get("Root", "StructTreeRoot");
  if (!tree.isDictionary()) return false;
  const leaf = numberTreeLeaf(tree.get("ParentTree"), key, 0);
  if (!leaf) return false;
  const element = leaf.nums.get(leaf.at + 1);
  if (!element.isDictionary()) return false;
  const target = link.entry.isIndirect() ? link.entry.asIndirect() : -1;
  const isRef = (k: Obj) =>
    k.isDictionary() && k.get("Type").asName() === "OBJR" && k.get("Obj").isIndirect() && k.get("Obj").asIndirect() === target;
  if (target < 0) return false;
  const kids = element.get("K");
  if (kids.isArray()) {
    const at: number[] = [];
    for (let k = 0; k < kids.length; k++) if (isRef(kids.get(k))) at.push(k);
    if (at.length !== 1) return false;
    const ref = kids.get(at[0]);
    kids.delete(at[0]);
    undo.push(() => insertAt(kids, at[0], ref));
  } else if (isRef(kids)) {
    element.delete("K");
    undo.push(() => element.put("K", kids));
  } else return false;
  const value = leaf.nums.get(leaf.at + 1), name = leaf.nums.get(leaf.at);
  leaf.nums.delete(leaf.at + 1);
  leaf.nums.delete(leaf.at);
  undo.push(() => {
    insertAt(leaf.nums, leaf.at, name);
    insertAt(leaf.nums, leaf.at + 1, value);
  });
  return true;
}

function insertAt(arr: Obj, at: number, value: Obj) {
  arr.push(value);
  for (let i = arr.length - 1; i > at; i--) arr.put(i, arr.get(i - 1));
  arr.put(at, value);
}

/** The /Nums array of the number tree holding `key`, and where the key is in it. */
function numberTreeLeaf(node: Obj, key: number, depth: number): { nums: Obj; at: number } | null {
  if (!node.isDictionary() || depth > 32) return null;
  const nums = node.get("Nums");
  if (nums.isArray())
    for (let i = 0; i + 1 < nums.length; i += 2) if (nums.get(i).isNumber() && nums.get(i).asNumber() === key) return { nums, at: i };
  const kids = node.get("Kids");
  if (kids.isArray())
    for (let i = 0; i < kids.length; i++) {
      const kid = kids.get(i);
      if (!kid.isDictionary()) continue;
      const lim = kid.get("Limits");
      if (lim.isArray() && (key < lim.get(0).asNumber() || key > lim.get(1).asNumber())) continue;
      const found = numberTreeLeaf(kid, key, depth + 1);
      if (found) return found;
    }
  return null;
}

// ---------------------------------------------------------------------------------------------
// The plan and the summary

/** The plan for an edit: everything "auto", and the box's shapes when `box` (absent: box.suggested). */
export function planOf(d: Detected, box: boolean | undefined): DecorationPlan {
  const withBox = box ?? d.box?.suggested ?? false;
  return {
    shapes: d.shapes.filter((s) => s.level === "auto" || (withBox && s.level === "option")).map((s) => copyShape(s.plan)),
    links: d.links.filter((l) => l.level === "auto").map((l) => copyLink(l.plan)),
  };
}

const copyShape = (s: ShapePlan): ShapePlan => ({ kind: s.kind, paint: s.paint, bbox: [...s.bbox] as Rect, range: [s.range[0], s.range[1]] });
const copyLink = (l: LinkPlan): LinkPlan => ({ bounds: [...l.bounds] as Rect, uri: l.uri, range: [l.range[0], l.range[1]] });

/** LineDecorations (the RPC) from a detection. */
export function summaryOf(d: Detected): LineDecorations {
  const auto = d.shapes.filter((s) => s.level === "auto");
  return {
    underlines: auto.filter((s) => s.plan.kind === "underline").length,
    strikes: auto.filter((s) => s.plan.kind === "strike").length,
    links: d.links.filter((l) => l.level === "auto").length,
    box: d.box ? { ...d.box } : null,
    left: [
      ...d.shapes.filter((s) => s.level === "left").map((s) => ({ kind: s.plan.kind, reason: s.reason ?? "complex" })),
      ...d.links.filter((l) => l.level === "left").map((l) => ({ kind: "link" as const, reason: l.reason ?? "complex" })),
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// Characters: what a decorated run becomes

/** What becomes of a run of characters when the line's text changes. */
export type Mapped = { range: [number, number] } | { removed: true } | { ambiguous: true };
const REMOVED: Mapped = { removed: true };
const AMBIGUOUS: Mapped = { ambiguous: true };
const isBlank = (ch: string | undefined) => ch === undefined || !ch.trim();

/**
 * What the characters [a, b) of `old` (a decorated run) become when the line reads `now`. The
 * edit is taken as one change: the common prefix and suffix stay, what is between them in `old`
 * becomes what is between them in `now`.
 * - The whole line's run covers the whole new line; with no new text, every run is removed.
 * - A run before or after the change stays on its characters (moved with them).
 * - Text typed right after a run continues it; text typed right before it does too at the start
 *   of the line, or when it sticks to the front of the decorated word ("here" made "there").
 * - A change inside a run changes it (its words replaced: the new words).
 * - A run inside the change is removed when its text went with nothing in its place; with other
 *   text in its place, or a change across one of its ends, which characters it should cover is
 *   not clear: "ambiguous".
 */
export function mapRun([a, b]: [number, number], old: string, now: string): Mapped {
  const no = old.length, nn = now.length;
  if (!nn) return REMOVED;
  if (a <= 0 && b >= no) return { range: [0, nn] };
  if (old === now) return { range: [a, b] };
  let p = 0;
  while (p < no && p < nn && old[p] === now[p]) p++;
  let s = 0;
  while (s < no - p && s < nn - p && old[no - 1 - s] === now[nn - 1 - s]) s++;
  const end = no - s, endNow = nn - s, d = nn - no;
  /** Nothing of the old text went: now[p, endNow) was typed at p. */
  const typed = end === p;
  const run = (x: number, y: number): Mapped => (y > x ? { range: [x, y] } : REMOVED);
  if (b < p || (b === p && !typed)) return run(a, b);
  if (b === p) return run(a, endNow);
  if (a > end || (a === end && !typed)) return run(a + d, b + d);
  if (a === end) {
    const sticks = a === 0 || (isBlank(old[a - 1]) && !isBlank(now[endNow - 1]) && !isBlank(old[a]));
    return sticks ? run(a, b + d) : run(a + d, b + d);
  }
  if (typed) return run(a, b + d); // typed inside the run
  if (a <= p && end <= b) return run(a, b + d); // the change lies within the run
  if (p <= a && b <= end) {
    if (p === a && end === b) return run(p, endNow);
    if (endNow === p) return REMOVED;
  }
  return AMBIGUOUS;
}

/**
 * Where old characters k0..k1 (those over a skip-ink hole) are after the edit: at the same place
 * in the unchanged start, moved with the unchanged end; null when the change touches them (or
 * text was typed between them).
 */
function survivor(k0: number, k1: number, old: string, now: string): number | null {
  const no = old.length, nn = now.length;
  let p = 0;
  while (p < no && p < nn && old[p] === now[p]) p++;
  let s = 0;
  while (s < no - p && s < nn - p && old[no - 1 - s] === now[nn - 1 - s]) s++;
  if (k1 < p) return k0;
  if (k0 >= no - s) return k0 + nn - no;
  return null;
}

// ---------------------------------------------------------------------------------------------
// After the edit

/** What applyDecorations needs from the line before core.replaceText changes it. */
export function beforeEdit(mupdf: MuPDFModule, doc: Doc, pageIndex: number, find: string, occurrence: number): Before {
  void mupdf;
  const page = doc.loadPage(pageIndex);
  let lines: Line[] = [];
  try {
    lines = extractLines(page) as Line[];
    const hit = lineHit(lines, find, occurrence, pageIndex);
    return {
      dir: [hit.line.dir[0], hit.line.dir[1]],
      wmode: hit.line.wmode,
      size: hit.chars[0].size,
      start: hit.start,
      chars: hit.chars.map((ch) => ({ c: ch.c, quad: [...ch.quad], origin: [ch.origin[0], ch.origin[1]] as Point })),
    };
  } finally {
    releasePage(page, lines);
  }
}

/** A stream edit: bytes start..end of content stream `stream` become `text`. */
interface Edit {
  stream: number;
  start: number;
  end: number;
  text: string;
}

/**
 * After core.replaceText (and protectAdded's restore) on that page: stretch or shrink the planned
 * shapes and move the planned links to the new text, or remove them when the text they decorate
 * was deleted. `written` is the text replaceText really wrote (its segments' text joined: it may
 * lack characters no font could draw). A new edit (`replay` false) drops a planned item it cannot
 * find exactly once, or whose edit is ambiguous, and reports it in `left`; `applied` is the plan
 * actually carried out, which the session logs. A replay (`replay` true) applies the logged plan
 * and throws DecorationMismatch when an item is not found exactly once.
 */
export function applyDecorations(
  mupdf: MuPDFModule, doc: Doc, pageIndex: number, plan: DecorationPlan,
  before: Before, find: string, written: string, replay: boolean,
): { applied: DecorationPlan; report: DecorationReport } {
  const applied: DecorationPlan = { shapes: [], links: [] };
  const report: DecorationReport = { moved: [], removed: [], linksMoved: 0, linksRemoved: 0, left: [] };
  if (!plan.shapes.length && !plan.links.length) return { applied, report };
  const left = (kind: DecorationKind | "link", reason: DecorationLeftReason, what: string) => {
    if (replay) throw new DecorationMismatch(`${what} on page ${pageIndex + 1}`);
    report.left.push({ kind, reason });
  };
  const page = doc.loadPage(pageIndex);
  let lines: Line[] = [];
  try {
    const u = before.dir;
    const F = frameOf(u, before.chars[0].origin, before.size);
    const old = before.chars.map((ch) => placed(F, ch));
    const leaveAll = (reason: DecorationLeftReason, what: string) => {
      for (const s of plan.shapes) left(s.kind, reason, `${what} (the ${s.kind})`);
      plan.links.forEach(() => left("link", reason, `${what} (a link)`));
    };
    if (old.length !== find.length) {
      leaveAll("complex", "The line before the edit does not read the text edited");
      return { applied, report };
    }
    if (before.wmode === 1 || !alongAxes(u)) {
      leaveAll("direction", "The line does not run along the page's axes");
      return { applied, report };
    }
    // Where the new text is: written from the old first character's origin.
    let now: Placed[] = [];
    if (written) {
      lines = extractLines(page) as Line[];
      const found = newText(lines, before.chars[0].origin, written);
      if (!found) {
        leaveAll("complex", "The new text was not found");
        return { applied, report };
      }
      now = found.map((ch) => placed(F, ch));
    }
    /** How far the run's start and end move along the line, or what else becomes of it. */
    const motion = (range: [number, number]): Motion => {
      const m = mapRun(range, find, written);
      if (!("range" in m)) return m;
      const [a2, b2] = m.range;
      return { dl: now[a2].t0 - old[range[0]].t0, dr: now[b2 - 1].t1 - old[range[1] - 1].t1, range: m.range };
    };
    if (plan.shapes.length) moveShapes(mupdf, doc, page, plan.shapes, F, old, now, find, written, motion, applied, report, left);
    if (plan.links.length) moveLinks(doc, pageIndex, page, plan.links, F, motion, applied, report, left);
    return { applied, report };
  } finally {
    releasePage(page, lines);
  }
}

/** The characters of `written` on the page, from the one whose origin is `start`; null when they are not there. */
function newText(lines: Line[], start: Point, written: string): LineChar[] | null {
  for (const line of lines)
    for (let k = 0; k < line.chars.length; k++) {
      const o = line.chars[k].origin;
      if (Math.hypot(o[0] - start[0], o[1] - start[1]) < ORIGIN_EPS && line.text.startsWith(written, k)) return line.chars.slice(k, k + written.length);
    }
  return null;
}

type Motion = { removed: true } | { ambiguous: true } | { dl: number; dr: number; range: [number, number] };
type Leave = (kind: DecorationKind | "link", reason: DecorationLeftReason, what: string) => void;

/** One path's rewrite: removed, or moved by dl / dr on either side of tMid (page space, along the line). */
type Rewrite = { remove: true } | { dl: number; dr: number };

function moveShapes(
  mupdf: MuPDFModule, doc: Doc, page: MuPDF.PDFPage, shapes: ShapePlan[], F: Frame, old: Placed[], now: Placed[],
  find: string, written: string, motion: (r: [number, number]) => Motion, applied: DecorationPlan, report: DecorationReport, left: Leave,
) {
  const pageObj = page.getObject();
  let content: Content, texts: string[], find2: ReturnType<typeof matcher>;
  try {
    content = readContent(pageObj);
    texts = content.bytes.map(latin1);
    find2 = matcher(walkContent(page, texts));
  } catch {
    for (const s of shapes) left(s.kind, "complex", `The ${s.kind} could not be read`);
    return;
  }
  const edits = new Map<string, Edit>();
  /** What each path found got, so that a fill and a stroke of one path (B) rewrite it once. */
  const done = new Map<Painted, { rewrite: Rewrite; made: boolean }>();
  for (const shape of shapes) {
    const found = find2(shape.paint, shape.bbox);
    if (found.length !== 1 || found[0].odd) {
      left(shape.kind, "complex", `The ${shape.kind} at ${shape.bbox.map(num).join(" ")} was found ${found.length} times`);
      continue;
    }
    const p = found[0];
    const m = motion(shape.range);
    if ("ambiguous" in m) {
      left(shape.kind, "ambiguous", `The ${shape.kind}'s edit is ambiguous`);
      continue;
    }
    const rewrite: Rewrite = "removed" in m ? { remove: true } : { dl: m.dl, dr: m.dr };
    const already = done.get(p);
    if (already) {
      if (!sameRewrite(already.rewrite, rewrite)) left(shape.kind, "complex", `The ${shape.kind} shares its path with another shape`);
      else if (already.made) record(shape, rewrite, applied, report);
      continue;
    }
    let mine: Edit[] | null;
    if ("remove" in rewrite) mine = removal(p);
    else if (Math.abs(rewrite.dl) < NO_MOVE && Math.abs(rewrite.dr) < NO_MOVE) {
      // Its ends stay; but a skip-ink hole under a character that changed goes all the same
      // ("Pay" made "Pas": the hole under the "y" would cut the underline under the "s").
      mine = find === written ? [] : clipEdits(p, F, spanOf(p, F), 0, 0, old, now, find, written);
      if (!mine.length) {
        done.set(p, { rewrite, made: false });
        continue; // nothing moves
      }
    } else mine = stretch(p, F, rewrite.dl, rewrite.dr, old, now, find, written);
    if (!mine || mine.some((e) => conflicts(edits, e))) {
      left(shape.kind, "complex", `The ${shape.kind} cannot be rewritten`);
      continue;
    }
    for (const e of mine) edits.set(keyOf(e), e);
    done.set(p, { rewrite, made: true });
    record(shape, rewrite, applied, report);
  }
  // Applied from the end of each stream, so the offsets before stay right.
  const byStream = new Map<number, Edit[]>();
  for (const e of edits.values()) byStream.set(e.stream, [...(byStream.get(e.stream) ?? []), e]);
  for (const [stream, list] of byStream) {
    list.sort((x, y) => y.start - x.start);
    let s = texts[stream];
    for (const e of list) s = splice(s, e.start, e.end, e.text);
    writeStream(mupdf, doc, pageObj, content.index[stream], s);
  }
}

const keyOf = (e: Edit) => `${e.stream}:${e.start}:${e.end}`;
const conflicts = (edits: Map<string, Edit>, e: Edit) => {
  const there = edits.get(keyOf(e));
  if (there) return there.text !== e.text;
  for (const o of edits.values()) if (o.stream === e.stream && o.start < e.end && e.start < o.end) return true;
  return false;
};
const sameRewrite = (a: Rewrite, b: Rewrite) =>
  "remove" in a ? "remove" in b : !("remove" in b) && Math.abs(a.dl - b.dl) < NO_MOVE && Math.abs(a.dr - b.dr) < NO_MOVE;

function record(shape: ShapePlan, rewrite: Rewrite, applied: DecorationPlan, report: DecorationReport) {
  applied.shapes.push(copyShape(shape));
  if ("remove" in rewrite) report.removed.push(shape.kind);
  else report.moved.push(shape.kind);
}

/** The path and its painting operator go; the state around them (q/Q, cm, colour, gs, clips) stays. */
function removal(p: Painted): Edit[] {
  return [...p.ops, p.paint].map((o) => ({ stream: o.stream, start: o.start, end: o.end, text: "" }));
}

/** A path's extent in the frame (its points, control points included, under its CTM). */
function spanOf(p: { ops: PathOp[]; ctm: Matrix }, F: Frame) {
  let t0 = Infinity, t1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const o of p.ops)
    for (const [x, y] of pointsOf(o)) {
      const q = applyTo(p.ctm, x, y), t = tOf(F, q), v = vOf(F, q);
      if (t < t0) t0 = t;
      if (t > t1) t1 = t;
      if (v < v0) v0 = v;
      if (v > v1) v1 = v;
    }
  return { t0, t1, v0, v1 };
}

/**
 * The path stretched: points past its middle along t move by dr, the others by dl (both along
 * the line, in page space, taken to the path's user space with its inverse CTM). Curves move
 * point by point, so round ends stay exact; a rectangle stays one when it is still along the
 * user-space axes. The clips set inside the path's own block move too (clipEdits). When the text
 * gets narrower than the path's two ends (a pill's round ends) allow, its two sides would cross:
 * it becomes as narrow as they allow, its ends still exact, hugging the short text as closely as
 * it can. Its left side goes where the text says, as the text starts where it did; its right
 * side's start stays SLIVER past the left side's end, so a later edit still tells the ends apart.
 * (Centred on the text, it would go past where it was on the left, where a clip may be: Chrome
 * clips the page's content at its margins.) Null when the sides of a path with no such ends would
 * cross (a rule turned around).
 */
function stretch(p: Painted, F: Frame, dl: number, dr: number, old: Placed[], now: Placed[], find: string, written: string): Edit[] | null {
  const span = spanOf(p, F), mid = (span.t0 + span.t1) / 2;
  let leftEnd = -Infinity, rightStart = Infinity;
  for (const o of p.ops)
    for (const [x, y] of pointsOf(o)) {
      const t = tOf(F, applyTo(p.ctm, x, y));
      if (t <= mid) leftEnd = Math.max(leftEnd, t);
      else rightStart = Math.min(rightStart, t);
    }
  if (leftEnd + dl + SLIVER > rightStart + dr + NO_MOVE) {
    if (!(leftEnd - span.t0 + (span.t1 - rightStart) > NO_MOVE)) return null;
    dr = leftEnd + dl + SLIVER - rightStart;
  }
  const edits = moved(p.ops, p.ctm, F, mid, dl, dr);
  if (!edits) return null;
  return [...edits, ...clipEdits(p, F, span, dl, dr, old, now, find, written)];
}

/**
 * What becomes of the clips set inside the path's own block when the path moves by dl / dr (both
 * may be 0: the text changed, its ends did not): a skip-ink hole stays under its character (kept,
 * or moved with the text after the change; dropped in the change), and a clip as long as the path
 * itself stretches with it.
 */
function clipEdits(
  p: Painted, F: Frame, span: ReturnType<typeof spanOf>, dl: number, dr: number, old: Placed[], now: Placed[], find: string, written: string,
): Edit[] {
  const edits: Edit[] = [];
  if (!p.unit) return edits;
  const { t0, t1 } = span, mid = (t0 + t1) / 2;
  // The rule's own extent across the line, for its holes.
  const v0 = span.v0 - 0.5, v1 = span.v1 + 0.5;
  for (let node = p.clips; node && node.clip.depth >= p.unit.depth; node = node.prev) {
    const clip = node.clip;
    if (clip.ops.some((o) => o.stream !== clip.ops[0].stream || o.nums.some((v) => !Number.isFinite(v)))) continue;
    const subpaths = splitSubpaths(clip.ops);
    for (const sub of subpaths) {
      const h = spanOf({ ops: sub, ctm: clip.ctm }, F);
      if (!Number.isFinite(h.t0)) continue;
      if (h.t0 <= t0 + TOUCH && h.t1 >= t1 - TOUCH && h.t0 >= t0 - F.S && h.t1 <= t1 + F.S) {
        // It covers the whole path and little more (it bounds the decoration): it stretches with it.
        const e = Math.abs(dl) < NO_MOVE && Math.abs(dr) < NO_MOVE ? null : moved(sub, clip.ctm, F, mid, dl, dr);
        if (e) edits.push(...e);
        continue;
      }
      if (subpaths.length < 2 || h.t1 - h.t0 > 2 * F.S || h.v1 < v0 || h.v0 > v1) continue; // not a hole under a glyph
      const under = old.map((c, k) => (!c.blank && c.t1 > h.t0 && c.t0 < h.t1 ? k : -1)).filter((k) => k >= 0);
      if (!under.length) continue;
      const k2 = survivor(under[0], under[under.length - 1], find, written);
      if (k2 === null || !now[k2]) {
        for (const o of sub) edits.push({ stream: o.stream, start: o.start, end: o.end, text: "" });
        continue;
      }
      const shift = now[k2].t0 - old[under[0]].t0;
      if (Math.abs(shift) < NO_MOVE) continue;
      const e = moved(sub, clip.ctm, F, -Infinity, shift, shift);
      if (e) edits.push(...e);
    }
  }
  return edits;
}

/** The subpaths of a path: a new one at each m or re. */
function splitSubpaths(ops: PathOp[]): PathOp[][] {
  const out: PathOp[][] = [];
  for (const o of ops) {
    if (o.op === "m" || o.op === "re" || !out.length) out.push([]);
    out[out.length - 1].push(o);
  }
  return out;
}

/** The edits that move a path's points by dl or dr along the line (by their side of tMid); null when the CTM cannot be inverted. */
function moved(ops: PathOp[], M: Matrix, F: Frame, tMid: number, dl: number, dr: number): Edit[] | null {
  let Mi: Matrix;
  try {
    Mi = invert(M);
  } catch {
    return null;
  }
  const shift = ([x, y]: Point): Point => {
    const d = tOf(F, applyTo(M, x, y)) > tMid ? dr : dl;
    const sx = d * F.u[0], sy = d * F.u[1];
    return [x + sx * Mi[0] + sy * Mi[2], y + sx * Mi[1] + sy * Mi[3]];
  };
  const pt = (q: Point) => `${num(q[0])} ${num(q[1])}`;
  const same = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
  const out: Edit[] = [];
  for (const o of ops) {
    if (o.op === "h") continue;
    const C = pointsOf(o).map(shift);
    let text: string;
    if (o.op === "re") {
      const aligned = same(C[0][1], C[1][1]) && same(C[2][1], C[3][1]) && same(C[0][0], C[3][0]) && same(C[1][0], C[2][0]);
      text = aligned
        ? `${pt(C[0])} ${num(C[1][0] - C[0][0])} ${num(C[3][1] - C[0][1])} re`
        : `${pt(C[0])} m ${pt(C[1])} l ${pt(C[2])} l ${pt(C[3])} l h`;
    } else text = `${C.map(pt).join(" ")} ${o.op}`;
    out.push({ stream: o.stream, start: o.start, end: o.end, text });
  }
  return out;
}

/**
 * The planned links: found again by URI and rect, then moved along the line or removed; never one
 * another page shows too (sharedLink), which stays.
 */
function moveLinks(
  doc: Doc, pageIndex: number, page: MuPDF.PDFPage, plan: LinkPlan[], F: Frame, motion: (r: [number, number]) => Motion,
  applied: DecorationPlan, report: DecorationReport, left: Leave,
) {
  const links = page.getLinks();
  try {
    const dicts = linkDicts(doc, page);
    const T = page.getTransform() as Matrix, Ti = invert(T);
    const pageObj = page.getObject();
    const gone: { dict: LinkDict; plan: LinkPlan }[] = [];
    for (const lp of plan) {
      const found = links.filter((l) => l.getURI() === lp.uri && nearRect(l.getBounds() as Rect, lp.bounds, LINK_EPS));
      const dict = found.length === 1 ? dictOf(dicts, lp.bounds, lp.uri) : null;
      if (!dict) {
        left("link", "complex", `The link to ${lp.uri} was found ${found.length} times`);
        continue;
      }
      if (sharedLink(doc, pageIndex, dict)) {
        left("link", "shared", "The link is another page's too");
        continue;
      }
      const m = motion(lp.range);
      if ("ambiguous" in m) {
        left("link", "ambiguous", "The link's edit is ambiguous");
        continue;
      }
      if ("removed" in m) {
        gone.push({ dict, plan: lp }); // (after the moves: removing changes /Annots)
        continue;
      }
      if (Math.abs(m.dl) < NO_MOVE && Math.abs(m.dr) < NO_MOVE) continue;
      // The rect's sides across the line move with the run's ends.
      const R = [...lp.bounds] as Rect;
      const [i0, i1] = Math.abs(F.u[0]) > Math.abs(F.u[1]) ? [0, 2] : [1, 3];
      const forward = F.u[i0] > 0;
      if (forward) {
        R[i0] += m.dl;
        R[i1] += m.dr;
      } else {
        R[i1] -= m.dl;
        R[i0] -= m.dr;
      }
      if (!(R[2] > R[0] && R[3] > R[1])) {
        left("link", "complex", "The link would have no area");
        continue;
      }
      // Link.setBounds writes /Rect as it is given: user space.
      found[0].setBounds(bboxOf([applyTo(Ti, R[0], R[1]), applyTo(Ti, R[2], R[1]), applyTo(Ti, R[2], R[3]), applyTo(Ti, R[0], R[3])]));
      moveQuadPoints(doc, dict, T, Ti, F, lp.bounds, m.dl, m.dr);
      applied.links.push(copyLink(lp));
      report.linksMoved++;
    }
    for (const { dict, plan: lp } of gone) {
      if (removeLink(doc, pageObj, dict)) {
        applied.links.push(copyLink(lp));
        report.linksRemoved++;
      } else left("link", "shared", "The link could not leave the structure tree"); // so it stays
    }
  } finally {
    for (const l of links) l.destroy();
  }
}

/** A link's /QuadPoints (if any) moved like path points: by dl or dr along the line, by their side of the rect's middle. */
function moveQuadPoints(doc: Doc, link: LinkDict, T: Matrix, Ti: Matrix, F: Frame, bounds: Rect, dl: number, dr: number) {
  const q = link.dict.get("QuadPoints");
  if (!q.isArray() || q.length < 8 || q.length % 8) return;
  const v: number[] = [];
  for (let k = 0; k < q.length; k++) v.push(q.get(k).asNumber());
  if (!v.every(Number.isFinite)) return;
  const corners: Point[] = [[bounds[0], bounds[1]], [bounds[2], bounds[3]]];
  const mid = (tOf(F, corners[0]) + tOf(F, corners[1])) / 2;
  const out = doc.newArray();
  for (let k = 0; k < v.length; k += 2) {
    const P = applyTo(T, v[k], v[k + 1]);
    const d = tOf(F, P) > mid ? dr : dl;
    const user = applyTo(Ti, P[0] + d * F.u[0], P[1] + d * F.u[1]);
    out.push(+num(user[0]));
    out.push(+num(user[1]));
  }
  link.dict.put("QuadPoints", out);
}
