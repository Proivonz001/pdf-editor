// Forme (release 6; ARCHITECTURE.md, "Forme"): lines, arrows, rectangles, ellipses, freehand
// strokes and highlights drawn on a page by the app.
//
// They are real page content, not annotations (Rule 7): each shape is a marked block of its own,
// appended after everything else with newcontent.appendSafely, never tagged:
//   /Artifact <</PEShape id /PEDef <</V 1 /K /line /P [x y x y] /C [r g b] /W w /D /solid /H 0>>>> BDC
//   q w J j M d RG rg  <path> S  <heads> f  Q  EMC
// (a highlight: q /PEHighlightN gs rg <box> f Q, under an ExtGState that multiplies at HIGHLIGHT_ALPHA,
// so it darkens nothing it covers and hides nothing even where a reader has no blend modes).
// Annotations would fight Bianchetto and Oscura (left on top, or deleted whole), could be moved or
// deleted by whoever receives the file, and some print and portal paths drop them. Nothing is
// filled opaque: a filled box would look like Oscura while the text stays in the file.
//
// /PEDef is the shape's own definition: kind, points in the page's user space (so a page turned,
// copied or moved by the organizer keeps it where it is seen), colour, width in points as seen,
// dash, heads. It is what the app reads back, never the drawing operators, which a line edit's
// redaction filter re-serialises (it keeps an inline /PEDef as written: tests/shapes.test.ts). The
// drawing is shapeGeometry.drawing of the shape as seen (page space): the paths the viewer's SVG
// preview draws, taken to user space point by point (each starts and runs as the preview's, so the
// dashes fall the same), the width and dashes divided by the page transform's scale (/UserUnit).
// Every stroke parameter is set inside the block: appendSafely does not reset them (a page may
// end with `5 w [3] 0 d` outside any q). The heads are one fill path, so a Bianchetto or Oscura
// removes an arrow whole or not at all (MuPDF removes line art only when one path lies wholly
// under the area); a block that paints less than its definition (emptied, or cut) is not listed.
// Nor is one that is not plainly the app's (a crafted file's): a /PEDef out of what the session
// takes, paths reaching past the box the definition draws or stroked wider than it (deleting it
// would delete them), past MAX_LISTED_SHAPES or MAX_LISTED_POINTS on the page. Those are line
// art, never rewritten.
//
// The id (/PEShape) is unique on the page (newcontent.nextId over the page's /PEShape ids), stable
// across edits, undo, redo and Riprendi; an edit rewrites the block in place, keeping its id and
// its place in the painting order. Coordinates are page space (points, y down, /Rotate and
// CropBox applied) unless said; matrices are PDF row-vector matrices. MuPDF objects: pages are
// destroyed here (rule 5); PDFObject wrappers are left to the garbage collector.
import type * as MuPDF from "mupdf";
import { contentStreams, invert, latin1, num, operations, streamBytes, writeStream, type Operand } from "./images";
import { ContentError, appendSafely, endProblem, isId, nextId, scanContent } from "./newcontent";
import {
  HIGHLIGHT_ALPHA, MAX_PEN_POINTS, MAX_SHAPE_WIDTH, MIN_SHAPE_WIDTH, type Matrix, type Rect, type Shape, type ShapeDash, type ShapeInfo, type ShapeKind,
} from "./protocol";
import { apply, boxOf, drawing, mapShape, shapeBox, type Point, type Segment } from "./shapeGeometry";

type MuPDFModule = typeof MuPDF;
type Doc = MuPDF.PDFDocument;
type Obj = MuPDF.PDFObject;

export const SHAPE_KINDS: readonly ShapeKind[] = ["line", "rect", "ellipse", "pen", "highlight"];
export const SHAPE_DASHES: readonly ShapeDash[] = ["solid", "dashed", "dotted"];

/** Most shapes, and most points of theirs in all, listed on a page: past them a crafted file's blocks are line art. */
export const MAX_LISTED_SHAPES = 2000;
export const MAX_LISTED_POINTS = 200_000;
/** How far (points, as seen) a block's path may reach past the box its definition draws: rounding, a filter writing it again. */
const BOX_SLACK = 1;

const PAINTS = new Set(["S", "s", "f", "F", "f*", "B", "B*", "b", "b*"]);
/** The painting operators that stroke. */
const STROKES = new Set(["S", "s", "B", "B*", "b", "b*"]);
/** The largest miter limit a block of the app's may set (it writes 4): a long one paints past the box. */
const MAX_MITER = 10;
/** The path operators, with how many numbers each takes. */
const PATH_ARGS = new Map([["m", 2], ["l", 2], ["c", 6], ["v", 4], ["y", 4], ["re", 4]]);
/** What a block of the app's may hold, as written or as MuPDF's filter writes it again; anything else is not ours to rewrite. */
const PLAIN = new Set([
  ...PAINTS, "n", "q", "Q", "w", "J", "j", "M", "d", "i", "ri", "gs", "RG", "rg", "G", "g", "K", "k", "CS", "cs", "SC", "SCN", "sc", "scn",
  "m", "l", "c", "v", "y", "h", "re",
]);

/** A shape block as found in a page's content (shapeBlocksIn). */
export interface ShapeBlock {
  id: number;
  /** The /Contents entry it is in, and where: from its tag's first byte to just after its EMC. */
  stream: number;
  start: number;
  end: number;
  /** Its /PEDef: points in user space, width as seen (null: missing, unreadable, or out of what the session takes). */
  def: Shape | null;
  /** How many paths it paints (a redaction may have emptied it). */
  paints: number;
  /** The box of its paths' points, user space (null: none). */
  box: Rect | null;
  /** The widest line width it sets (`w`), user space (0: none). */
  wide: number;
  /** The largest miter limit it sets (`M`; the app writes 4). */
  miter: number;
  /** It sets a graphics state (`gs`: the app writes one only for a highlight), and how many paths it strokes. */
  gs: boolean;
  strokes: number;
  /** It holds only what the app writes (PLAIN): only then is it rewritten. */
  plain: boolean;
}

/**
 * The shape a /PEDef dictionary describes (points in user space), or null when it is not one the app
 * writes: within what session.shapeFrom takes (a width in MIN_SHAPE_WIDTH..MAX_SHAPE_WIDTH, a
 * highlight's 0; heads on a line only; a pen stroke and a highlight solid). The size is not checked:
 * user space may be scaled (/UserUnit), and a shape a hair short draws nothing out of place.
 */
function defFrom(d: Record<string, Operand> | undefined): Shape | null {
  if (!d || d.V?.num !== 1) return null;
  const kind = d.K?.name as ShapeKind, dash = d.D?.name as ShapeDash, heads = d.H?.num, width = d.W?.num;
  const flat = d.P?.arr?.map((x) => x.num), color = d.C?.arr?.map((x) => x.num);
  if (!SHAPE_KINDS.includes(kind) || !SHAPE_DASHES.includes(dash) || (heads !== 0 && heads !== 1 && heads !== 2)) return null;
  if (typeof width !== "number" || !(kind === "highlight" ? width === 0 : width >= MIN_SHAPE_WIDTH && width <= MAX_SHAPE_WIDTH)) return null;
  if ((kind !== "line" && heads !== 0) || ((kind === "pen" || kind === "highlight") && dash !== "solid")) return null;
  if (!flat || flat.length % 2 || !flat.every((v) => typeof v === "number" && Number.isFinite(v))) return null;
  if (!color || color.length !== 3 || !color.every((v) => typeof v === "number" && v >= 0 && v <= 1)) return null;
  const points: [number, number][] = [];
  for (let k = 0; k < flat.length; k += 2) points.push([flat[k]!, flat[k + 1]!]);
  if (kind === "pen" ? points.length < 2 || points.length > MAX_PEN_POINTS : points.length !== 2) return null;
  return { kind, points, color: color as [number, number, number], width, dash, heads };
}

/**
 * The app's shape blocks in `texts` (a page's streams as MuPDF reads them), in content order:
 * blocks marked /PEShape with a valid id, each within one stream; a second block with an id already
 * found, or one inside another, is not the app's (only a crafted file has one).
 */
export function shapeBlocksIn(texts: string[]): ShapeBlock[] {
  const out: ShapeBlock[] = [];
  // A page without shapes is not lexed (heavy vector pages take hundreds of ms).
  if (!texts.some((t) => t.includes("PEShape"))) return out;
  const found = new Set<number>(); // (a crafted page may hold many thousands: no search of `out`)
  let marks = 0;
  let cur: (ShapeBlock & { depth: number }) | null = null;
  texts.forEach((s, k) => {
    for (const o of operations(s)) {
      if (o.op === "BDC" || o.op === "BMC") {
        marks++;
        const d = o.op === "BDC" ? o.args[o.args.length - 1]?.dict : undefined, id = d?.PEShape?.num;
        if (!cur && isId(id)) cur = { id, stream: k, start: o.start, end: -1, def: defFrom(d!.PEDef?.dict), paints: 0, box: null, wide: 0, miter: 0, gs: false, strokes: 0, plain: true, depth: marks };
        else if (cur) cur.plain = false;
      } else if (o.op === "EMC") {
        if (cur && marks === cur.depth) {
          if (cur.stream === k && !found.has(cur.id)) {
            found.add(cur.id);
            const { depth: _depth, ...block } = cur;
            out.push({ ...block, end: o.end });
          }
          cur = null;
        }
        if (marks > 0) marks--;
      } else if (cur) {
        if (PAINTS.has(o.op)) cur.paints++;
        if (STROKES.has(o.op)) cur.strokes++;
        if (!PLAIN.has(o.op)) cur.plain = false;
        if (o.op === "w") cur.wide = Math.max(cur.wide, Math.abs(o.args[0]?.num ?? 0));
        if (o.op === "M") cur.miter = Math.max(cur.miter, Math.abs(o.args[0]?.num ?? 0));
        if (o.op === "gs") cur.gs = true;
        const count = PATH_ARGS.get(o.op);
        if (count !== undefined) {
          const v = o.args.map((a) => a.num);
          if (v.length !== count || !v.every((x): x is number => typeof x === "number" && Number.isFinite(x))) cur.plain = false;
          else {
            const pts: Point[] = [];
            for (let j = 0; j < count; j += 2) pts.push([v[j], v[j + 1]]);
            if (o.op === "re") pts[1] = [v[0] + v[2], v[1] + v[3]];
            if (cur.box) pts.push([cur.box[0], cur.box[1]], [cur.box[2], cur.box[3]]);
            cur.box = boxOf(pts);
          }
        }
      }
    }
  });
  return out;
}

/** The paths drawing() gives `def`: what a block paints when nothing took any of it (redact.ts too). */
export const pathsOf = (def: Shape) => {
  const d = drawing(def);
  return (d.stroke.length ? 1 : 0) + (d.fill.length ? 1 : 0);
};

/**
 * The shapes of `blocks` the app lists and rewrites, as seen (T the page transform), in painting
 * order: blocks of its own, readable, painting all of their definition and nothing past the box it
 * draws (BOX_SLACK) nor wider than it (no long miter, a graphics state only on a highlight), at
 * most MAX_LISTED_SHAPES of them with MAX_LISTED_POINTS points in all.
 */
function listed(blocks: readonly ShapeBlock[], T: Matrix): ShapeInfo[] {
  return listing(blocks, T).out;
}

/** listed(), with the points it holds and whether it stopped at a cap (more shapes would not be listed). */
function listing(blocks: readonly ShapeBlock[], T: Matrix): { out: ShapeInfo[]; points: number; stopped: boolean } {
  const out: ShapeInfo[] = [];
  const scale = Math.sqrt(Math.abs(T[0] * T[3] - T[1] * T[2]));
  let points = 0, stopped = false;
  for (const b of blocks) {
    if (!b.plain || !b.def || b.paints === 0 || b.paints !== pathsOf(b.def) || b.wide * scale > b.def.width * 1.001 + 0.001) continue;
    // A graphics state may set a line width of its own (/LW): only a highlight's, which strokes nothing.
    if (b.miter > MAX_MITER || (b.gs && (b.def.kind !== "highlight" || b.strokes > 0))) continue;
    const shape = mapShape(b.def, T), bbox = shapeBox(shape);
    if (b.box) {
      const [x0, y0, x1, y1] = b.box;
      const [a0, b0, a1, b1] = boxOf(([[x0, y0], [x1, y0], [x1, y1], [x0, y1]] as Point[]).map((p) => apply(T, p)));
      if (a0 < bbox[0] - BOX_SLACK || b0 < bbox[1] - BOX_SLACK || a1 > bbox[2] + BOX_SLACK || b1 > bbox[3] + BOX_SLACK) continue;
    }
    if (out.length === MAX_LISTED_SHAPES || points + shape.points.length > MAX_LISTED_POINTS) {
      stopped = true;
      break;
    }
    points += shape.points.length;
    out.push({ id: b.id, shape, bbox });
  }
  return { out, points, stopped };
}

/** The page's streams as text, and the shape blocks in them. */
function readShapes(page: MuPDF.PDFPage): { texts: string[]; blocks: ShapeBlock[] } {
  const texts = contentStreams(page.getObject()).map((s) => (s.isStream() ? latin1(streamBytes(s)) : ""));
  return { texts, blocks: shapeBlocksIn(texts) };
}

const lookup = (obj: Obj, key: string): Obj => (obj.isDictionary() ? obj.get(key) : obj);

/** Whether `o` is the graphics state the app gives highlights (exactly /Type, /BM /Multiply and /ca). */
function isHighlightState(o: Obj): boolean {
  if (!o.isDictionary()) return false;
  const keys: string[] = [];
  o.forEach((_v, k) => keys.push(String(k)));
  const ca = o.get("ca"), bm = o.get("BM"), type = o.get("Type");
  return keys.every((k) => k === "Type" || k === "BM" || k === "ca") && bm.isName() && bm.asName() === "Multiply" &&
    ca.isNumber() && Math.abs(ca.asNumber() - HIGHLIGHT_ALPHA) < 1e-4 && (type.isNull() || (type.isName() && type.asName() === "ExtGState"));
}

/**
 * The name under which the page's resources list the highlight's graphics state, added when they
 * have none: looked up again at every write, since a redaction gives the page new resources and
 * may rename them. The page first gets its own shallow copy of /Resources and of /ExtGState (as
 * images.ownXObjects does), so other pages sharing them keep theirs.
 */
function highlightState(doc: Doc, pageObj: Obj): string {
  const res = pageObj.getInheritable("Resources"), states = lookup(res, "ExtGState");
  let found: string | null = null;
  // (only a name that is written as it reads: it goes into the content as it is)
  if (states.isDictionary()) states.forEach((v, k) => { if (found === null && /^[\w.-]+$/.test(String(k)) && isHighlightState(v)) found = String(k); });
  if (found !== null) return found;
  const own = doc.newDictionary(), ownStates = doc.newDictionary();
  if (res.isDictionary()) res.forEach((v, k) => { if (k !== "ExtGState") own.put(k, v); });
  if (states.isDictionary()) states.forEach((v, k) => ownStates.put(k, v));
  let n = 1, name: string;
  do name = `PEHighlight${n++}`;
  while (!ownStates.get(name).isNull());
  const gs = doc.newDictionary();
  gs.put("Type", doc.newName("ExtGState"));
  gs.put("BM", doc.newName("Multiply"));
  gs.put("ca", HIGHLIGHT_ALPHA);
  ownStates.put(name, doc.addObject(gs));
  own.put("ExtGState", ownStates);
  pageObj.put("Resources", own);
  return name;
}

/** Page-space point `q` taken through `m` (to user space), as written in content. */
const userPoint = (m: Matrix, q: Point) => apply(m, q).map(num).join(" ");

/** `segs` (page space) taken through `m` to user space, as path construction operators (m, l, c, h). */
function pathOps(segs: readonly Segment[], m: Matrix): string {
  const p = (q: Point) => userPoint(m, q);
  return segs.map((s) => (s.op === "Z" ? "h" : s.op === "C" ? `${p(s.c1)} ${p(s.c2)} ${p(s.p)} c` : `${p(s.p)} ${s.op === "M" ? "m" : "l"}`)).join("\n");
}

/**
 * The block that draws `shape` (page space; checked by the session) as shape `id`, from the page's
 * initial graphics state (where appendSafely puts it, and where it stays: a redaction's filter
 * keeps what it draws with): the definition (points in user space through T⁻¹, T the page
 * transform; the width as seen), the paths of drawing() of the shape as seen taken to user space,
 * every stroke parameter set (lengths divided by T's scale), DeviceRGB.
 */
function blockOps(doc: Doc, pageObj: Obj, id: number, shape: Shape, T: Matrix): string {
  const Ti = invert(T), scale = Math.sqrt(Math.abs(T[0] * T[3] - T[1] * T[2]));
  const d = drawing(shape);
  const colour = shape.color.map((v) => num(Math.min(1, Math.max(0, v)))).join(" ");
  const def = `<</V 1 /K /${shape.kind} /P [${shape.points.map((p) => userPoint(Ti, p)).join(" ")}] /C [${colour}] ` +
    `/W ${num(shape.width)} /D /${shape.dash} /H ${shape.heads}>>`;
  let body: string;
  if (shape.kind === "highlight") body = `/${highlightState(doc, pageObj)} gs\n${colour} rg\n${pathOps(d.fill, Ti)}\nf\n`;
  else {
    body = `${num(shape.width / scale)} w ${d.cap} J ${d.join} j 4 M [${d.dash.map((v) => num(v / scale)).join(" ")}] 0 d\n${colour} RG ${colour} rg\n`;
    if (d.stroke.length) body += `${pathOps(d.stroke, Ti)}\nS\n`;
    if (d.fill.length) body += `${pathOps(d.fill, Ti)}\nf\n`;
  }
  return `/Artifact <</PEShape ${id} /PEDef ${def}>> BDC\nq\n${body}Q\nEMC\n`;
}

/**
 * Draws `shape` (page space, checked by the session) over everything else on page `pageIndex`, as
 * a new block of its own. Returns its id (one more than the page's largest: newcontent.nextId).
 * Throws ContentError "not-editable" when the page content cannot take an addition, or the page
 * holds as many shapes as listShapes lists (MAX_LISTED_SHAPES, MAX_LISTED_POINTS); nothing is
 * changed then.
 */
export function addShape(mupdf: MuPDFModule, doc: Doc, pageIndex: number, shape: Shape): { id: number } {
  const page = doc.loadPage(pageIndex);
  try {
    const pageObj = page.getObject();
    const scan = scanContent(pageObj);
    const problem = endProblem(scan.end);
    if (problem) throw new ContentError(problem, "not-editable");
    const T = page.getTransform() as Matrix;
    // A shape past the listing's caps would be drawn but never listed (no selecting, moving or
    // deleting it): refused instead, as a page that cannot take more.
    const now = listing(readShapes(page).blocks, T);
    if (now.stopped || now.out.length >= MAX_LISTED_SHAPES || now.points + shape.points.length > MAX_LISTED_POINTS) {
      throw new ContentError("The page holds as many shapes as the app can list", "not-editable");
    }
    const id = nextId(scan.shapeIds);
    appendSafely(mupdf, doc, pageObj, blockOps(doc, pageObj, id, shape, T), scan.end);
    return { id };
  } finally {
    page.destroy();
  }
}

/** The shapes the app drew on page `pageIndex`, page space, in painting order (as `listed` takes them). */
export function listShapes(_mupdf: MuPDFModule, doc: Doc, pageIndex: number): ShapeInfo[] {
  const page = doc.loadPage(pageIndex);
  try {
    return listed(readShapes(page).blocks, page.getTransform() as Matrix);
  } finally {
    page.destroy();
  }
}

/**
 * Rewrites shape `id` of page `pageIndex` in place (the same id, the same place in the painting
 * order) to draw `shape` (page space, checked by the session), or removes its block (null).
 * Returns the id (null after a delete). Throws ContentError: "bad-request" when the page has no
 * such shape (listShapes does not list it), "not-editable" when its block holds anything the app
 * does not write.
 */
export function rewriteShape(mupdf: MuPDFModule, doc: Doc, pageIndex: number, id: number, shape: Shape | null): { id: number | null } {
  const page = doc.loadPage(pageIndex);
  try {
    const { texts, blocks } = readShapes(page);
    const T = page.getTransform() as Matrix;
    const b = blocks.find((x) => x.id === id);
    if (b && !b.plain) throw new ContentError(`The shape ${id} on page ${pageIndex + 1} holds other content`, "not-editable");
    if (!b || !listed(blocks, T).some((x) => x.id === id)) throw new ContentError(`No shape ${id} drawn by the app on page ${pageIndex + 1}`, "bad-request");
    const pageObj = page.getObject();
    const ops = shape ? blockOps(doc, pageObj, id, shape, T) : "";
    const s = texts[b.stream];
    // (kept apart from what comes before it, without piling up newlines over many rewrites)
    const gap = b.start > 0 && !/[\0\t\n\f\r ]/.test(s[b.start - 1]) ? "\n" : "";
    writeStream(mupdf, doc, pageObj, b.stream, s.slice(0, b.start) + gap + ops + s.slice(b.end));
    return { id: shape ? id : null };
  } finally {
    page.destroy();
  }
}
