// New content on a page (phase 3, release 3, "Compila e firma"): new lines of real text (a name
// written on a form's line, a date, a check mark) and new pictures (a signature, initials, a
// photo), drawn over the page's content (ARCHITECTURE.md, "Fill and sign").
//
// Both are appended at the end of the page's content and drawn from its initial graphics state
// (appendSafely). When the content already ends in that state (q and Q balanced, nothing that
// would change the new content set outside a q, no text object, marked-content sequence or path
// left open, no operand left without its operator), the new operations go in a stream of their
// own after it. Otherwise the old content
// is wrapped once in q .. Q, closing first what it left open, and from then on the page ends
// clean, so later additions do not nest deeper (core.appendContent nests one level per call,
// which redaction flattens for line edits, but additions are never redacted). A content that
// ends inside a string, an array, a dictionary or an inline image would swallow whatever comes
// after it, and one that restores more states than it saves would draw differently once
// wrapped: both are refused ("not-editable").
//
// Text is written with the app's own embedded fallback fonts (core.encodeWithFallbacks: the
// Nimbus face of the style, ZapfDingbats for ✓ ✗ ✔ ✘, the CJK font), Identity-H Type0 fonts with
// a complete /ToUnicode and /W, so the line is searchable and extracts exactly. Each line is a
// marked block of its own, which the app finds again after a redaction rewrote the page, in a
// later session and after save and re-open:
//   /P <</MCID n /PEText id>> BDC q BT r g b rg Tm (/F size Tf <codes> Tj)... ET Q EMC
// (/Span <</PEText id>> on a page that is not tagged). `id` is unique on the page. Editing,
// moving, restyling or deleting such a line rewrites only its block (rewriteAdded), never by
// redaction, which is geometric and would take with it what lies under the line (a form's
// underscores, the box of a check mark). The other way round, a line edit's redaction may take
// part of an added line lying over the edited one: protectAdded notes the page's added lines
// before it and writes back any the redaction changed.
//
// Pictures are image XObjects in the page's own /Resources (images.pictureObject: no third-party
// colour profile, the same bytes embedded once per document, so initials on every page share one
// object), each placement a block of its own that images.findPlacements lists as movable:
//   /Figure <</MCID n /PEImage id>> BDC q K cm /PEImgN Do Q EMC
// (/Artifact <</PEImage id>> BDC ... EMC when it has no description or the page is not tagged).
//
// Tagged documents: a new line becomes a /P structure element and a described picture a /Figure
// with /Alt, appended at the end of the document's top structure element (read last: placing it
// next to the nearest label is a later step) and registered in the page's ParentTree under a new
// MCID; a page that has no /StructParents gets one. A structure tree that cannot be read leaves
// the content untagged.
//
// Ported from the release 3 prototype (r3-research/new-content: engine-proto/newcontent.ts, 37
// prototype tests and the app's 197 run against it). Coordinates are page space (points, y down,
// /Rotate and CropBox applied); matrices are PDF row-vector matrices, concat(A, B) = "A then B".
// MuPDF objects: pages and the fonts loaded to check characters are destroyed here (rule 5);
// PDFObject wrappers are left to the garbage collector, as everywhere else in the engine.
import type * as MuPDF from "mupdf";
import { cjkLanguage, encodeWithFallbacks, extractLines, fallbackChain, findInLines, fontKey, parseToUnicode, structParents } from "./core.js";
import {
  FLIP, IDENTITY, ORIENTATION, addStream, concat, contentStreams, findPlacements, invert, latin1, nearlyEqual, num, openImage, operations,
  ownXObjects, pictureObject, streamBytes, toBytes, writeStream, type Operand, type Picture,
} from "./images";
import type { AddedText, FontFamily, ImageTarget, Matrix, Rect, TextStyle } from "./protocol";

type MuPDFModule = typeof MuPDF;
type Doc = MuPDF.PDFDocument;
type Obj = MuPDF.PDFObject;
type Point = [number, number];
/** A line as core.extractLines returns it (with MuPDF Font objects inside). */
type RawLine = ReturnType<typeof extractLines>[number];

/**
 * A refusal: "bad-request" (no such added text, no character that can be drawn) or
 * "not-editable" (the page's content cannot take an addition safely, an added block holding
 * other content). addText, rewriteAdded and addImage throw it before they change anything, so
 * the session can report it with that code without rolling back.
 */
export class ContentError extends Error {
  constructor(message: string, readonly code: "bad-request" | "not-editable") {
    super(message);
    this.name = "ContentError";
  }
}

/** The obj[key][key]... or the null object, without get() on the null object (which throws in MuPDF.js). */
function lookup(obj: Obj, ...path: string[]): Obj {
  return obj.isNull() ? obj : obj.get(...path);
}

const applyTo = (m: Matrix, x: number, y: number): Point => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
const near = (a: readonly number[], b: readonly number[], eps = 0.01) => Math.hypot(a[0] - b[0], a[1] - b[1]) < eps;
const isNumeric = (args: Operand[], count: number) => args.length === count && args.every((x) => x.num !== undefined);
const matrixOf = (args: Operand[]) => args.map((x) => x.num!) as Matrix;

// ---------------------------------------------------------------------------------------------
// Characters

/**
 * The characters of `text` that no font of the app can draw in `style` (each once, in order),
 * touching no document: those beyond U+FFFF (emoji, math letters: MuPDF.js 1.27 reads them back
 * truncated, so the line could not be edited later) and those no font of the chain has. What
 * addText leaves out; the session refuses a text made only of them. The fonts are loaded and
 * released here.
 */
export function missingChars(mupdf: MuPDFModule, text: string, style: { family: FontFamily; bold: boolean; italic: boolean }): string[] {
  const chain: { make(): MuPDF.Font }[] = fallbackChain(mupdf, { family: style.family, bold: style.bold, italic: style.italic }, [], cjkLanguage(null, text));
  const fonts: (MuPDF.Font | null)[] = chain.map(() => null);
  const out: string[] = [];
  try {
    for (const ch of text) {
      if (out.includes(ch)) continue;
      const cp = ch.codePointAt(0)!;
      let ok = false;
      for (let k = 0; cp <= 0xffff && k < chain.length && !ok; k++) ok = (fonts[k] ??= chain[k].make()).encodeCharacter(cp) > 0;
      if (!ok) out.push(ch);
    }
  } finally {
    for (const f of fonts) f?.destroy();
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Appending to the page content

/**
 * Operators whose effect outside any q would change what is appended after them: the CTM, the
 * clip, the extended graphics state (alpha, blend mode, soft mask...) and the text state the new
 * text does not set itself. (Colours and the font are set by the new content; stroke parameters
 * do not apply to it.)
 */
const STATE_OPS = new Set(["cm", "gs", "W", "W*", "Tc", "Tw", "Tz", "Tr", "Ts"]);
const PATH_OPS = new Set(["m", "l", "c", "v", "y", "h", "re"]);
const PATH_ENDS = new Set(["S", "s", "f", "F", "f*", "B", "B*", "b", "b*", "n"]);

/** Most graphics states, marked-content sequences and text objects open at once that appendSafely closes (real files nest a few dozen deep). */
export const MAX_OPEN = 256;

/** How the page content leaves things at its end. */
export interface EndState {
  /** How many are left open: graphics states, marked-content sequences and a text object. */
  open: number;
  /** What is left open, innermost last: "q" a saved graphics state, "m" a marked-content sequence, "t" a text object. */
  stack: ("q" | "m" | "t")[];
  /** More than MAX_OPEN were open at once somewhere: `stack` is not known, so a content that does not end clean takes nothing. */
  deep: boolean;
  pendingPath: boolean;
  /** Something in STATE_OPS was set outside any q: the state at the end is not the initial one. */
  changed: boolean;
  /** Q's that found no state saved. MuPDF (and other readers) ignore them; wrapped, they would restore our q. */
  underflow: number;
  /** It ends inside a string, an array, a dictionary or an inline image: what follows would be read into it. */
  inside: boolean;
  /**
   * Operands after its last operator, which no operator takes ("ET /Foo", "ET 0 0 1"): appended
   * as they are, they would become the first operands of the new content's first operator (a
   * BDC would read them as its tag and property list), so the content is wrapped and the Q
   * that closes the wrap takes them.
   */
  dangling: boolean;
}

export const isClean = (s: EndState) => !s.open && !s.pendingPath && !s.changed && !s.dangling;

/**
 * Whether `tail` (what follows the content's last operator: operands only) leaves a string, a
 * hex string, an array or a dictionary open.
 */
function endsInside(tail: string): boolean {
  let depth = 0;
  const n = tail.length;
  for (let i = 0; i < n; ) {
    const c = tail[i];
    if (c === "%") {
      while (i < n && tail[i] !== "\n" && tail[i] !== "\r") i++;
    } else if (c === "(") {
      let d = 0;
      for (; i < n; i++) {
        if (tail[i] === "\\") i++;
        else if (tail[i] === "(") d++;
        else if (tail[i] === ")" && --d === 0) break;
      }
      if (i >= n) return true;
      i++;
    } else if (c === "<" && tail[i + 1] === "<") {
      depth++;
      i += 2;
    } else if (c === ">" && tail[i + 1] === ">") {
      depth--;
      i += 2;
    } else if (c === "<") {
      const j = tail.indexOf(">", i);
      if (j < 0) return true;
      i = j + 1;
    } else {
      if (c === "[") depth++;
      else if (c === "]") depth--;
      i++;
    }
  }
  return depth > 0;
}

/** Whether `tail` (what follows the content's last operator) holds anything but whitespace and comments. */
function holdsOperands(tail: string): boolean {
  for (let i = 0; i < tail.length; i++) {
    const c = tail[i];
    if (c === "%") while (i < tail.length && tail[i] !== "\n" && tail[i] !== "\r") i++;
    else if (!/[\0\t\n\f\r ]/.test(c)) return true;
  }
  return false;
}

/** How content `s` (a page's streams joined by a space, as MuPDF reads them) leaves things at its end. */
export function endState(s: string): EndState {
  return scanText(s, null).end;
}

/**
 * The largest /PEText or /PEImage id the app reads or writes. Ids are whole numbers from 1 to
 * this: a larger one in a file (only a crafted file has one) is not the app's, so it is neither
 * read as an added line nor counted when a new id is chosen. Beyond 2^53 a new id "max + 1" would
 * equal the file's, and from 1e21 it would be written as "1e+21", which is not a PDF number.
 */
export const MAX_ID = 2 ** 31 - 1;

/** A /PEText or /PEImage id the app takes as its own (1..MAX_ID). */
const isId = (v: number | undefined): v is number => Number.isSafeInteger(v) && v! >= 1 && v! <= MAX_ID;

/** An MCID the app reads and writes again: a whole number from 0 to 2^53 (null for anything else: a fraction, a negative, beyond). */
const mcidOf = (v: number | undefined): number | null => (Number.isSafeInteger(v) && v! >= 0 ? v! : null);

/** The id for a new block among `used`: one more than the largest, or, past MAX_ID, the smallest one free. */
function nextId(used: Set<number>): number {
  let max = 0;
  for (const id of used) max = Math.max(max, id);
  if (max < MAX_ID) return max + 1;
  let id = 1;
  while (used.has(id)) id++;
  return id;
}

/** What one pass over a page's content tells: how it ends, and the ids it marks. */
interface ContentScan {
  end: EndState;
  /** The largest MCID marked (inline or named property lists), -1 if none. */
  maxMcid: number;
  /** The /PEText and /PEImage ids of the app's blocks (isId). */
  textIds: Set<number>;
  imageIds: Set<number>;
}

function scanText(s: string, properties: Obj | null): ContentScan {
  const stack: ("q" | "m" | "t")[] = [];
  let saved = 0, marks = 0, inText = false, deep = false, pendingPath = false, changed = false, underflow = 0;
  let maxMcid = -1, lastEnd = 0, last = "", lastStart = 0;
  const textIds = new Set<number>(), imageIds = new Set<number>();
  // (the counters say whether there is one to close, so the stack is only searched when there is)
  const open = (x: "q" | "m" | "t") => {
    if (stack.length >= MAX_OPEN) deep = true;
    else if (!deep) stack.push(x);
  };
  const close = (x: "q" | "m" | "t") => {
    if (!deep) stack.splice(stack.lastIndexOf(x), 1);
  };
  for (const o of operations(s)) {
    const op = o.op;
    lastEnd = o.end;
    last = op;
    lastStart = o.start;
    switch (op) {
      case "q":
        saved++;
        open("q");
        break;
      case "Q":
        if (!saved) underflow++;
        else {
          saved--;
          close("q");
        }
        break;
      case "BMC":
      case "BDC": {
        marks++;
        open("m");
        if (op === "BMC") break;
        // The property list is the last operand (and the tag the one before it): operands left
        // before them by the content (dangling, see EndState) come first.
        const p = o.args[o.args.length - 1];
        let mcid = p?.dict?.MCID?.num;
        if (mcid === undefined && p?.name && properties) {
          const named = lookup(properties, p.name);
          if (named.isDictionary() && named.get("MCID").isNumber()) mcid = named.get("MCID").asNumber();
        }
        const text = p?.dict?.PEText?.num, image = p?.dict?.PEImage?.num, m = mcidOf(mcid);
        if (m !== null) maxMcid = Math.max(maxMcid, m);
        if (isId(text)) textIds.add(text);
        if (isId(image)) imageIds.add(image);
        break;
      }
      case "EMC":
        if (marks) {
          marks--;
          close("m");
        }
        break;
      case "BT":
        if (!inText) {
          inText = true;
          open("t");
        }
        break;
      case "ET":
        if (inText) {
          inText = false;
          close("t");
        }
        break;
      default:
        if (PATH_OPS.has(op)) pendingPath = true;
        else if (PATH_ENDS.has(op)) pendingPath = false;
    }
    if (saved === 0 && STATE_OPS.has(op)) changed = true;
  }
  // An inline image without its EI runs to the end (images.operations); otherwise anything after
  // the last operator is operands, and an open string, array or dictionary there takes the rest.
  const imageOpen = last === "BI" && lastEnd === s.length && !(s.length - 3 >= lastStart && /^[\0\t\n\f\r ]EI$/.test(s.slice(-3)));
  const inside = imageOpen || endsInside(s.slice(lastEnd));
  const dangling = !inside && holdsOperands(s.slice(lastEnd));
  const end: EndState = { open: saved + marks + (inText ? 1 : 0), stack, deep, pendingPath, changed, underflow, inside, dangling };
  return { end, maxMcid, textIds, imageIds };
}

/** One pass over the page's content (its streams read as MuPDF reads them: one content, a space between them). */
function scanContent(pageObj: Obj): ContentScan {
  const text = contentStreams(pageObj).map((s) => latin1(streamBytes(s))).join(" ");
  const properties = lookup(pageObj.getInheritable("Resources"), "Properties");
  return scanText(text, properties.isDictionary() ? properties : null);
}

/** Why nothing can be appended after content that ends so (null: it can). */
function endProblem(end: EndState): string | null {
  if (end.inside) return "The page's content ends inside a string, an array, a dictionary or an inline image";
  if (isClean(end)) return null;
  if (end.deep) return `The page's content nests more than ${MAX_OPEN} levels deep`;
  if (end.underflow) return "The page's content restores more graphics states than it saves";
  return null;
}

/**
 * Why new content cannot be added to page `pageIndex` (null: it can): the session refuses
 * addText and addImage there with "not-editable", before anything is changed.
 */
export function appendProblem(doc: Doc, pageIndex: number): string | null {
  const page = doc.loadPage(pageIndex);
  try {
    return endProblem(scanContent(page.getObject()).end);
  } finally {
    page.destroy();
  }
}

/**
 * Appends `ops` (balanced: q..Q, BDC..EMC) at the end of the page content, drawn from the initial
 * graphics state; `end` is how the content ends now (one pass over it, when not given). Builds a
 * new /Contents array (the old one may be shared with another page), the old streams unchanged:
 * after them a stream with `ops`, or, when the content does not end clean, before them "q" and
 * after them what closes what they left open (a path with n, then ET, EMC and Q, innermost
 * first) and that q (the first of these takes the operands the content left without an operator),
 * then `ops`. Every new stream starts on a new line, so a comment that ends the old content
 * cannot take the first line of ours. Returns whether the old content was wrapped. Throws
 * ContentError ("not-editable") for content that cannot take an addition (endProblem).
 */
export function appendSafely(mupdf: MuPDFModule, doc: Doc, pageObj: Obj, ops: string, end: EndState = scanContent(pageObj).end): boolean {
  const problem = endProblem(end);
  if (problem) throw new ContentError(problem, "not-editable");
  const stream = (text: string) => addStream(mupdf, doc, toBytes(text));
  const arr = doc.newArray();
  const wrap = !isClean(end);
  if (wrap) arr.push(stream("q\n"));
  for (const s of contentStreams(pageObj)) arr.push(s);
  const close = { q: "Q\n", m: "EMC\n", t: "ET\n" };
  const closers = wrap ? (end.pendingPath ? "n\n" : "") + [...end.stack].reverse().map((x) => close[x]).join("") + "Q\n" : "";
  arr.push(stream("\n" + closers + ops));
  pageObj.put("Contents", arr);
  return wrap;
}

// ---------------------------------------------------------------------------------------------
// Tagging new content

/** The ParentTree's last /Nums leaf (descending the last kid), with the nodes passed on the way. */
function lastLeaf(node: Obj): { leaf: Obj; path: Obj[] } | null {
  const path: Obj[] = [];
  for (let k = 0; k < 64 && node.isDictionary(); k++) {
    if (node.get("Nums").isArray()) return { leaf: node, path };
    const kids = node.get("Kids");
    if (!kids.isArray() || kids.length === 0) return null;
    path.push(node);
    node = kids.get(kids.length - 1);
  }
  return null;
}

/**
 * For a tagged document's page without /StructParents: a new ParentTree entry (an empty array)
 * under the next free key (ParentTreeNextKey, and beyond every key and /Limits on the way to the
 * last leaf), the page given that key. Null when the tree cannot be extended.
 */
function newParentsEntry(doc: Doc, root: Obj, pageObj: Obj): Obj | null {
  let tree = root.get("ParentTree");
  if (!tree.isDictionary()) {
    tree = doc.addObject(doc.newDictionary());
    tree.put("Nums", doc.newArray());
    root.put("ParentTree", tree);
  }
  const found = lastLeaf(tree);
  if (!found) return null;
  const nums = found.leaf.get("Nums");
  const nodes = [...found.path, found.leaf];
  let key = root.get("ParentTreeNextKey").isNumber() ? root.get("ParentTreeNextKey").asNumber() : 0;
  for (let i = 0; i + 1 < nums.length; i += 2) key = Math.max(key, nums.get(i).asNumber() + 1);
  for (const n of nodes) {
    const lim = n.get("Limits");
    if (lim.isArray() && lim.length === 2) key = Math.max(key, lim.get(1).asNumber() + 1);
  }
  const arr = doc.addObject(doc.newArray());
  nums.push(key);
  nums.push(arr);
  for (const n of nodes) {
    const lim = n.get("Limits");
    if (lim.isArray() && lim.length === 2) lim.put(1, key);
  }
  pageObj.put("StructParents", key);
  root.put("ParentTreeNextKey", key + 1);
  return arr;
}

/** The structure element new content was given. */
interface NewTag {
  mcid: number;
}

/**
 * The most null entries tagNew adds to a page's ParentTree array to reach a new MCID: the
 * content marks MCIDs far beyond the array's end only in a crafted file (one MCID of 1e9 would
 * otherwise keep the worker filling the array for minutes). Beyond, the content goes in untagged.
 */
const MAX_MCID_GAP = 10_000;

/**
 * Tags new content of page `pageIndex` in a tagged document: a new structure element of `type`
 * (P, Figure) with `alt`, the last child of the document's top element (the root's only kid when
 * it has one, as Word and Acrobat write /Document, else the root), registered in the page's
 * ParentTree array under a new MCID: above every MCID the content marks (`maxMcid`) and every
 * entry of that array. Null when the document is not tagged, its structure tree cannot be read
 * or extended, or that MCID is beyond the array's end by more than MAX_MCID_GAP: the content is
 * then added untagged.
 */
function tagNew(doc: Doc, pageIndex: number, type: "P" | "Figure", alt: string | null, maxMcid: number): NewTag | null {
  const root = doc.getTrailer().get("Root", "StructTreeRoot");
  if (!root.isDictionary()) return null;
  try {
    const pageRef = doc.findPage(pageIndex);
    let parents: Obj | null = structParents(doc, pageRef);
    if (maxMcid + 1 - (parents?.length ?? 0) > MAX_MCID_GAP) return null;
    if (!parents) {
      if (pageRef.get("StructParents").isNumber()) return null; // a key the ParentTree does not have: left alone
      parents = newParentsEntry(doc, root, pageRef);
    }
    if (!parents) return null;
    const mcid = Math.max(parents.length, maxMcid + 1);
    let top: Obj = root, k = root.get("K");
    if (k.isArray() && k.length === 1) k = k.get(0);
    if (k.isDictionary() && k.get("S").isName() && k.get("Type").asName() !== "MCR" && k.get("Type").asName() !== "OBJR") top = k;
    const elem = doc.addObject(doc.newDictionary());
    elem.put("Type", doc.newName("StructElem"));
    elem.put("S", doc.newName(type));
    elem.put("P", top);
    elem.put("Pg", pageRef);
    elem.put("K", mcid);
    if (alt) elem.put("Alt", doc.newString(alt));
    const kids = top.get("K");
    if (kids.isArray()) kids.push(elem);
    else {
      const list = doc.newArray();
      if (!kids.isNull()) list.push(kids);
      list.push(elem);
      top.put("K", list);
    }
    while (parents.length < mcid) parents.push(doc.newNull());
    if (parents.length === mcid) parents.push(elem);
    else parents.put(mcid, elem);
    return { mcid };
  } catch {
    return null; // a structure tree that cannot be read: the content goes in untagged
  }
}

/** The same object (both indirect, the same number). */
const sameObject = (a: Obj, b: Obj) => a.isIndirect() && b.isIndirect() && a.asIndirect() === b.asIndirect();

/**
 * Marked content `mcid` of the page leaves the structure tree (an added line deleted): its
 * ParentTree entry becomes null, and the element (the app's /P) leaves its parent, or, when it
 * holds other content too (a line edit tagged its replacement under it), keeps that content.
 */
function untag(doc: Doc, pageIndex: number, mcid: number) {
  try {
    const parents = structParents(doc, doc.findPage(pageIndex));
    if (!parents || mcid >= parents.length) return;
    const elem = parents.get(mcid);
    if (!elem.isDictionary()) return;
    parents.put(mcid, doc.newNull());
    const k = elem.get("K"), items: Obj[] = [];
    if (k.isArray()) for (let i = 0; i < k.length; i++) items.push(k.get(i));
    else if (!k.isNull()) items.push(k);
    const others = items.filter((x) => !(x.isNumber() && x.asNumber() === mcid));
    if (others.length) {
      const list = doc.newArray();
      for (const x of others) list.push(x);
      elem.put("K", list);
      return;
    }
    const parent = elem.get("P"), kids = parent.isDictionary() ? parent.get("K") : parent;
    if (kids.isArray()) {
      const keep = doc.newArray();
      for (let i = 0; i < kids.length; i++) if (!sameObject(kids.get(i), elem)) keep.push(kids.get(i));
      parent.put("K", keep);
    } else if (sameObject(kids, elem)) parent.delete("K");
  } catch {
    // a structure tree that cannot be read: the line is removed all the same
  }
}

/** The tag that opens a block of new content: `/Tag <</MCID n /Key id>> BDC`. */
const openMark = (tag: string, mcid: number | null, key: "PEText" | "PEImage", id: number) =>
  `/${tag} <<${mcid !== null ? `/MCID ${mcid} ` : ""}/${key} ${id}>> BDC\n`;

// ---------------------------------------------------------------------------------------------
// New text

/**
 * The operations that draw `text` with its baseline starting at `origin` (page space) where the
 * CTM is `ctm`, horizontal as seen: q BT colour Tm (Tf Tj)... ET Q, one Tf Tj per run of one
 * fallback font, and the characters left out. Throws ContentError ("bad-request") when no
 * character can be drawn.
 */
function textOps(mupdf: MuPDFModule, doc: Doc, pageObj: Obj, ctm: Matrix, origin: Point, text: string, style: TextStyle) {
  const { runs, missing }: { runs: { font: Obj; hex: string }[]; missing: string[] } = encodeWithFallbacks(mupdf, doc, text, style);
  if (!runs.length) throw new ContentError("No character of the text can be drawn", "bad-request");
  // Tm × CTM = [1 0 0 -1 x y]: unit, upright as seen (page space is y down).
  const tm = concat([1, 0, 0, -1, origin[0], origin[1]], invert(ctm));
  const colour = style.color.map((v) => num(Math.min(1, Math.max(0, v)))).join(" ");
  let body = `q\nBT\n${colour} rg\n${tm.map(num).join(" ")} Tm\n`;
  for (const run of runs) body += `/${fontKey(doc, pageObj, run.font)} ${num(style.size)} Tf <${run.hex}> Tj\n`;
  return { body: body + "ET\nQ\n", missing };
}

/**
 * Writes `text` (one line, already checked: at least one character that can be drawn) as a new
 * line of real text on page `pageIndex`, its baseline starting at `origin` (page space: as seen,
 * rotation and CropBox applied), horizontal as seen, in the app's fonts of `style`. Returns its
 * id (one more than the largest on the page: nextId) and the characters left out (missingChars). Throws
 * ContentError: "not-editable" when the page content cannot take it, "bad-request" when nothing
 * can be drawn; nothing is changed then.
 */
export function addText(mupdf: MuPDFModule, doc: Doc, pageIndex: number, origin: [number, number], text: string, style: TextStyle): { id: number; missing: string[] } {
  const page = doc.loadPage(pageIndex);
  try {
    const pageObj = page.getObject();
    const scan = scanContent(pageObj);
    const problem = endProblem(scan.end);
    if (problem) throw new ContentError(problem, "not-editable");
    const { body, missing } = textOps(mupdf, doc, pageObj, page.getTransform() as Matrix, origin, text, style);
    const id = nextId(scan.textIds);
    const tag = tagNew(doc, pageIndex, "P", null, scan.maxMcid);
    appendSafely(mupdf, doc, pageObj, openMark(tag ? "P" : "Span", tag?.mcid ?? null, "PEText", id) + body + "EMC\n", scan.end);
    return { id, missing };
  } finally {
    page.destroy();
  }
}

/** A line of text the app wrote, as found in the page content (addedBlocks). */
export interface AddedBlock {
  id: number;
  /** The /Contents entry it is in, and where: from its tag's first byte to just after its EMC. */
  stream: number;
  start: number;
  end: number;
  /** Its tag (P, Span) and MCID (null: not tagged). */
  tagName: string;
  mcid: number | null;
  /** The CTM where it starts (page space). */
  ctm: Matrix;
  /** Its text matrix in page space (Tm × CTM) where it starts showing; null when it shows nothing (any more). */
  matrix: Matrix | null;
  /** The size of its first Tf, and its fill colour. */
  size: number;
  color: [number, number, number];
  /** What it shows, in order: the font's resource name, 2-byte codes, and a TJ adjustment before them (thousandths of the size). */
  shows: { font: string; codes: number[]; kern: number }[];
  /** It holds only what addText writes (q, Q, BT, ET, rg, Tm, Tf, Tj; TJ, which a redaction writes): only then is it rewritten. */
  plain: boolean;
}

const BLOCK_OPS = new Set(["q", "Q", "BT", "ET", "rg", "Tm", "Tf", "Tj", "TJ"]);

/** A literal string's bytes from its text between the parentheses as written (escapes undone, PDF 7.3.4.2). */
function literalBytes(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const e = raw[++i];
    if (e === undefined) break;
    const simple = ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" } as Record<string, string>)[e];
    if (simple) out += simple;
    else if (e >= "0" && e <= "7") {
      let o = e;
      while (o.length < 3 && raw[i + 1] >= "0" && raw[i + 1] <= "7") o += raw[++i];
      out += String.fromCharCode(parseInt(o, 8) & 255);
    } else if (e === "\r") {
      if (raw[i + 1] === "\n") i++; // a line continuation
    } else if (e !== "\n") out += e;
  }
  return out;
}

/**
 * The 2-byte codes a Tj operand shows: a hex string (as addText writes it) or a literal string (as
 * MuPDF's redaction filter writes one whose bytes are all printable, CJK glyph ids often are).
 * Null for anything else.
 */
function codesOf(x: Operand | undefined): number[] | null {
  let bytes: string;
  if (x?.hex !== undefined) {
    const h = x.hex.replace(/[^0-9A-Fa-f]/g, "");
    bytes = "";
    for (let i = 0; i < h.length; i += 2) bytes += String.fromCharCode(parseInt(h.slice(i, i + 2).padEnd(2, "0"), 16));
  } else if (x?.str !== undefined) bytes = literalBytes(x.str);
  else return null;
  const codes: number[] = [];
  for (let i = 0; i + 1 < bytes.length; i += 2) codes.push((bytes.charCodeAt(i) << 8) | bytes.charCodeAt(i + 1));
  return codes;
}

/** The page's streams as text, and the app's added lines in them, in content order. */
function readBlocks(page: MuPDF.PDFPage): { texts: string[]; blocks: AddedBlock[] } {
  const texts = contentStreams(page.getObject()).map((st) => latin1(streamBytes(st)));
  // A page the app wrote no text on is not lexed (heavy vector pages take hundreds of ms).
  if (!texts.some((t) => t.includes("PEText"))) return { texts, blocks: [] };
  const blocks: AddedBlock[] = [];
  type GState = { ctm: Matrix; color: [number, number, number] };
  let gs: GState = { ctm: page.getTransform() as Matrix, color: [0, 0, 0] };
  const saved: GState[] = [];
  let marks = 0, font = "", size = 0, tm: Matrix = IDENTITY, tlm: Matrix = IDENTITY;
  let cur: (AddedBlock & { depth: number; tms: number }) | null = null;
  texts.forEach((s, k) => {
    for (const o of operations(s)) {
      const a = o.args;
      switch (o.op) {
        case "q":
          saved.push(gs);
          gs = { ...gs };
          break;
        case "Q":
          if (saved.length) gs = saved.pop()!;
          break;
        case "cm":
          if (isNumeric(a, 6)) gs.ctm = concat(matrixOf(a), gs.ctm);
          break;
        case "rg":
          if (isNumeric(a, 3)) gs.color = a.map((x) => Math.min(1, Math.max(0, x.num!))) as [number, number, number];
          break;
        case "BT":
          tm = tlm = IDENTITY;
          break;
        case "Tm":
          if (isNumeric(a, 6)) tm = tlm = matrixOf(a);
          break;
        case "Td":
        case "TD":
          if (isNumeric(a, 2)) tm = tlm = concat([1, 0, 0, 1, a[0].num!, a[1].num!], tlm);
          break;
        case "Tf":
          font = a[0]?.name ?? "";
          size = a[1]?.num ?? 0;
          break;
        case "BMC":
          marks++;
          if (cur) cur.plain = false;
          continue;
        case "BDC": {
          marks++;
          // (the property list is the last operand and the tag the one before: see scanText)
          const d = a[a.length - 1]?.dict, id = d?.PEText?.num;
          if (!cur && isId(id))
            cur = {
              id, stream: k, start: o.start, end: -1, tagName: a[a.length - 2]?.name ?? "Span", mcid: mcidOf(d!.MCID?.num),
              ctm: gs.ctm, matrix: null, size: 0, color: gs.color, shows: [], plain: true, depth: marks, tms: 0,
            };
          else if (cur) cur.plain = false;
          continue;
        }
        case "EMC":
          if (cur && marks === cur.depth) {
            // (a second block with an id already found is not the app's: only a crafted file has one)
            if (cur.stream === k && !blocks.some((b) => b.id === cur!.id)) {
              const { depth: _depth, tms: _tms, ...block } = cur;
              blocks.push({ ...block, end: o.end });
            }
            cur = null;
          }
          if (marks > 0) marks--;
          continue;
      }
      if (!cur) continue;
      if (!BLOCK_OPS.has(o.op)) {
        cur.plain = false;
        continue;
      }
      if (o.op === "Tm" && ++cur.tms > 1) cur.plain = false; // addText writes one
      else if (o.op === "Tf" && !cur.size) cur.size = size;
      else if (o.op === "Tj" || o.op === "TJ") {
        const items = o.op === "Tj" ? [a[0]] : (a[0]?.arr ?? []);
        let kern = 0;
        for (const x of items) {
          if (x?.num !== undefined) {
            kern += x.num;
            continue;
          }
          const codes = codesOf(x);
          if (!codes) {
            cur.plain = false;
            continue;
          }
          if (!cur.matrix) {
            cur.matrix = concat(tm, gs.ctm);
            cur.color = gs.color;
            cur.size ||= size;
          }
          cur.shows.push({ font, codes, kern });
          kern = 0;
        }
      }
    }
  });
  return { texts, blocks };
}

/** The app's added lines on the page, in content order (nothing is read when the content has no "PEText"). */
export function addedBlocks(page: MuPDF.PDFPage): AddedBlock[] {
  return readBlocks(page).blocks;
}

/** addedBlocks of page `pageIndex`. */
export function pageBlocks(doc: Doc, pageIndex: number): AddedBlock[] {
  const page = doc.loadPage(pageIndex);
  try {
    return addedBlocks(page);
  } finally {
    page.destroy();
  }
}

/** The Base-14 names addFont gives the app's fallback fonts (core.fallbackChain), and the style each stands for. */
const FACES: Record<string, [FontFamily, boolean, boolean]> = {
  Helvetica: ["sans", false, false], "Helvetica-Bold": ["sans", true, false],
  "Helvetica-Oblique": ["sans", false, true], "Helvetica-BoldOblique": ["sans", true, true],
  "Times-Roman": ["serif", false, false], "Times-Bold": ["serif", true, false],
  "Times-Italic": ["serif", false, true], "Times-BoldItalic": ["serif", true, true],
  Courier: ["mono", false, false], "Courier-Bold": ["mono", true, false],
  "Courier-Oblique": ["mono", false, true], "Courier-BoldOblique": ["mono", true, true],
};

/** What a block needs of one of its fonts. */
interface FontFacts {
  toUnicode: Map<number, string>;
  /** Advances by code (= CID: Identity-H), per mille of the size, and the default one. */
  widths: Map<number, number>;
  dw: number;
  /** Ascent and descent per mille (FontDescriptor). */
  ascent: number;
  descent: number;
  /** The style its name stands for (null: the Dingbats or CJK font, which says nothing about it). */
  style: [FontFamily, boolean, boolean] | null;
}

/** A reader of the page's fonts by resource name, each read once. */
function fontReader(page: MuPDF.PDFPage): (name: string) => FontFacts | null {
  const fonts = lookup(page.getObject().getInheritable("Resources"), "Font");
  const cache = new Map<string, FontFacts | null>();
  return (name) => {
    if (cache.has(name)) return cache.get(name)!;
    let facts: FontFacts | null = null;
    const f = lookup(fonts, name);
    if (f.isDictionary()) {
      const tu = f.get("ToUnicode");
      const toUnicode: Map<number, string> = tu.isStream() ? parseToUnicode(latin1(streamBytes(tu))) : new Map();
      const desc = lookup(f, "DescendantFonts").isArray() ? f.get("DescendantFonts", 0) : f;
      const widths = new Map<number, number>();
      const w = lookup(desc, "W");
      for (let i = 0, n = w.isArray() ? w.length : 0; i + 1 < n; ) {
        const first = w.get(i).asNumber(), next = w.get(i + 1);
        if (next.isArray()) {
          for (let j = 0; j < next.length; j++) widths.set(first + j, next.get(j).asNumber());
          i += 2;
        } else {
          const lastCode = next.asNumber(), width = i + 2 < n ? w.get(i + 2).asNumber() : 0;
          for (let c = first; c <= lastCode && c - first < 65536; c++) widths.set(c, width);
          i += 3;
        }
      }
      const fd = lookup(desc, "FontDescriptor");
      const metric = (key: string, fallback: number) => (lookup(fd, key).isNumber() ? fd.get(key).asNumber() : fallback);
      const dw = lookup(desc, "DW").isNumber() ? desc.get("DW").asNumber() : 1000;
      const base = f.get("BaseFont").isName() ? f.get("BaseFont").asName().replace(/^[A-Z]{6}\+/, "") : "";
      facts = { toUnicode, widths, dw, ascent: metric("Ascent", 800), descent: metric("Descent", -200), style: FACES[base] ?? null };
    }
    cache.set(name, facts);
    return facts;
  };
}

/** A block read back: its text (through its fonts' /ToUnicode), style (from their names), origin and box (page space). */
function readBlock(b: AddedBlock & { matrix: Matrix }, fonts: (name: string) => FontFacts | null) {
  let text = "", advance = 0, ascent = 0, descent = 0, style: [FontFamily, boolean, boolean] | null = null;
  for (const sh of b.shows) {
    const f = fonts(sh.font);
    advance -= (sh.kern / 1000) * b.size;
    for (const c of sh.codes) {
      text += f?.toUnicode.get(c) ?? "�";
      advance += ((f ? (f.widths.get(c) ?? f.dw) : 0) / 1000) * b.size;
    }
    if (f) {
      ascent = Math.max(ascent, f.ascent);
      descent = Math.min(descent, f.descent);
      style ??= f.style;
    }
  }
  if (ascent <= descent) [ascent, descent] = [800, -200];
  const m = b.matrix;
  const corners = [applyTo(m, 0, (descent / 1000) * b.size), applyTo(m, advance, (descent / 1000) * b.size),
    applyTo(m, advance, (ascent / 1000) * b.size), applyTo(m, 0, (ascent / 1000) * b.size)];
  const xs = corners.map((p) => p[0]), ys = corners.map((p) => p[1]);
  const bbox: Rect = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  const [family, bold, italic] = style ?? ["sans", false, false];
  const size = Math.round(b.size * Math.hypot(m[2], m[3]) * 1000) / 1000;
  const textStyle: TextStyle = { size, color: [...b.color] as [number, number, number], family, bold, italic };
  return { text, style: textStyle, origin: [m[4], m[5]] as Point, bbox };
}

/** A block the app may rewrite and read: its own, plain, still showing something. */
const usable = (b: AddedBlock): b is AddedBlock & { matrix: Matrix } => b.plain && b.matrix !== null && b.shows.length > 0;

/** The page's texts written by the app (AddedText), in content order. */
export function addedTexts(_mupdf: MuPDFModule, doc: Doc, pageIndex: number): AddedText[] {
  const page = doc.loadPage(pageIndex);
  try {
    const fonts = fontReader(page);
    const out: AddedText[] = [];
    for (const b of addedBlocks(page)) {
      if (!usable(b)) continue;
      const r = readBlock(b, fonts);
      if (r.text.trim()) out.push({ id: b.id, text: r.text, origin: r.origin, style: r.style, bbox: r.bbox });
    }
    return out;
  } finally {
    page.destroy();
  }
}

/**
 * Writes block `b` of the page again in place (same tag, MCID and id, the same place in the
 * painting order): `text` in `style` at `origin`, positioned for the CTM where the block is. An
 * empty text removes the block, and its structure element on a tagged page.
 */
function rewriteBlock(
  mupdf: MuPDFModule, doc: Doc, page: MuPDF.PDFPage, pageIndex: number, texts: string[], b: AddedBlock,
  text: string, style: TextStyle, origin: Point,
): { id: number | null; missing: string[] } {
  const pageObj = page.getObject();
  const s = texts[b.stream];
  let ops = "", missing: string[] = [];
  if (text) {
    const t = textOps(mupdf, doc, pageObj, b.ctm, origin, text, style);
    ops = openMark(b.tagName, b.mcid, "PEText", b.id) + t.body + "EMC\n";
    missing = t.missing;
  } else if (b.mcid !== null) untag(doc, pageIndex, b.mcid);
  // (kept apart from what comes before it, without piling up newlines over many rewrites)
  const gap = b.start > 0 && !/[\0\t\n\f\r ]/.test(s[b.start - 1]) ? "\n" : "";
  writeStream(mupdf, doc, pageObj, b.stream, s.slice(0, b.start) + gap + ops + s.slice(b.end));
  return { id: text ? b.id : null, missing };
}

/**
 * Rewrites the app's added line `id` on page `pageIndex` in place: its block gets `patch.text`
 * in `patch.style` at `patch.origin` (each defaults to the block's own), keeping its tag and MCID
 * (its structure element stays) and its place in the painting order. An empty text deletes it,
 * and on a tagged page its structure element. Returns the id (null after a delete) and the
 * characters left out. Throws ContentError: "bad-request" when there is no such line or nothing
 * of the text can be drawn, "not-editable" when its block holds anything addText does not write.
 */
export function rewriteAdded(
  mupdf: MuPDFModule, doc: Doc, pageIndex: number, id: number, patch: { text?: string; origin?: [number, number]; style?: TextStyle },
): { id: number | null; missing: string[] } {
  const page = doc.loadPage(pageIndex);
  try {
    const { texts, blocks } = readBlocks(page);
    const b = blocks.find((x) => x.id === id);
    if (!b) throw new ContentError(`No text ${id} written by the app on page ${pageIndex + 1}`, "bad-request");
    if (!usable(b)) throw new ContentError(`The text ${id} on page ${pageIndex + 1} holds other content`, "not-editable");
    const old = readBlock(b, fontReader(page));
    return rewriteBlock(mupdf, doc, page, pageIndex, texts, b, patch.text ?? old.text, patch.style ?? old.style, patch.origin ?? old.origin);
  } finally {
    page.destroy();
  }
}

/** The letters MuPDF's structured text reads for the ligatures U+FB00..U+FB06 (one glyph each). */
const LIGATURES: Record<string, string> = {
  "ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl", "ﬅ": "st", "ﬆ": "st",
};

/**
 * `text` as a line's visible characters are compared: ligatures as the letters MuPDF reads for
 * them, and no whitespace (what trim() takes away; U+180E as well, which MuPDF counts as a space
 * and JavaScript no longer does).
 */
const visibleText = (text: string) =>
  [...text].map((ch) => LIGATURES[ch] ?? (ch === "᠎" || ch.trim() === "" ? "" : ch)).join("");

/** The text of each block, read through its fonts' /ToUnicode once per block (the blocks of one read are reused for every line). */
const shownTexts = new WeakMap<AddedBlock, string>();

/** shownTexts of `blocks` (usable blocks of page `pageIndex`), reading the page's fonts only for those not read yet. */
function textsOfBlocks(doc: Doc, pageIndex: number, blocks: (AddedBlock & { matrix: Matrix })[]): string[] {
  const todo = blocks.filter((b) => !shownTexts.has(b));
  if (todo.length) {
    const page = doc.loadPage(pageIndex);
    try {
      const fonts = fontReader(page);
      for (const b of todo) shownTexts.set(b, readBlock(b, fonts).text);
    } finally {
      page.destroy();
    }
  }
  return blocks.map((b) => shownTexts.get(b)!);
}

/**
 * The ids of the added blocks that draw `line` (a core.extractLines line of page `pageIndex`), in
 * the order the line reads them, or null when the line is not made only of added text. Its
 * blocks are those starting at one of its characters, and its visible text must be exactly
 * theirs one after the other (visibleText: ligatures as their letters, whitespace left out, so
 * the space MuPDF adds between two blocks written one after the other on one baseline does not
 * count). Comparing texts, not character counts: a value with spaces written just before a short
 * printed word ("Via Roma 1 B" before "n.") has as many glyphs as the line has visible
 * characters, and must still go the mixed-line way. The session routes such a line's edit to
 * rewriteAdded. `blocks` saves reading the page again for each line (pageBlocks); their texts
 * are read once.
 */
export function addedLineIds(_mupdf: MuPDFModule, doc: Doc, pageIndex: number, line: RawLine, blocks?: AddedBlock[]): number[] | null {
  const list = (blocks ?? pageBlocks(doc, pageIndex)).filter(usable);
  if (!list.length) return null;
  const chars = line.chars as { c: string; origin: number[] }[];
  const at = (m: Matrix) => chars.findIndex((c) => near(c.origin, [m[4], m[5]]));
  const mine = list.map((b) => ({ b, k: at(b.matrix) })).filter((x) => x.k >= 0).sort((x, y) => x.k - y.k);
  if (!mine.length) return null;
  const read = visibleText(chars.map((c) => c.c).join(""));
  const drawn = visibleText(textsOfBlocks(doc, pageIndex, mine.map((x) => x.b)).join(""));
  return read !== "" && read === drawn ? mine.map((x) => x.b.id) : null;
}

/** An added line as protectAdded notes it, to write it again as it was. */
interface Noted {
  id: number;
  tagName: string;
  mcid: number | null;
  text: string;
  style: TextStyle;
  origin: Point;
}

/**
 * Before a line edit (core.replaceText) on page `pageIndex`: notes the page's added lines, and
 * returns a function to call after it, which writes back, as they were, those whose text or
 * place the edit's redaction changed (it is geometric: a name written over the line being edited
 * loses the glyphs over it) or whose block it emptied. Lines drawing part of the edited line
 * itself (`edited`, the edit's find and occurrence: MuPDF read them as part of it) are left to
 * the edit, which replaces them. Part of the edit, so every replay does the same.
 */
export function protectAdded(mupdf: MuPDFModule, doc: Doc, pageIndex: number, edited?: { find: string; occurrence: number }): () => void {
  const noted: Noted[] = [];
  const page = doc.loadPage(pageIndex);
  try {
    const blocks = addedBlocks(page).filter(usable);
    if (blocks.length) {
      let onLine: number[][] = [];
      if (edited) {
        const raw: RawLine[] = extractLines(page);
        try {
          const hit = findInLines(raw, edited.find, edited.occurrence);
          onLine = hit ? (hit.line.chars as { origin: number[] }[]).map((c) => c.origin) : [];
        } finally {
          for (const l of raw) for (const ch of l.chars) ch.font.destroy();
        }
      }
      const fonts = fontReader(page);
      for (const b of blocks) {
        if (onLine.some((o) => near(o, [b.matrix[4], b.matrix[5]]))) continue;
        const r = readBlock(b, fonts);
        if (r.text.trim()) noted.push({ id: b.id, tagName: b.tagName, mcid: b.mcid, text: r.text, style: r.style, origin: r.origin });
      }
    }
  } finally {
    page.destroy();
  }
  return () => {
    if (!noted.length) return;
    // One read to find what the edit changed; each of those (usually none) is then written again.
    const page = doc.loadPage(pageIndex);
    let damaged: Noted[];
    try {
      const blocks = addedBlocks(page), fonts = fontReader(page);
      damaged = noted.filter((n) => {
        const b = blocks.find((x) => x.id === n.id);
        if (!b || !usable(b)) return true;
        const now = readBlock(b, fonts);
        return now.text !== n.text || !near(now.origin, n.origin);
      });
    } finally {
      page.destroy();
    }
    for (const n of damaged) restoreBlock(mupdf, doc, pageIndex, n);
  };
}

/** Writes the added line `n` noted by protectAdded again (its block no longer draws it as it did). */
function restoreBlock(mupdf: MuPDFModule, doc: Doc, pageIndex: number, n: Noted) {
  const page = doc.loadPage(pageIndex);
  try {
    const { texts, blocks } = readBlocks(page);
    const b = blocks.find((x) => x.id === n.id);
    if (b) {
      // Damaged or emptied by the redaction (which keeps the marked block): written again in place.
      rewriteBlock(mupdf, doc, page, pageIndex, texts, b, n.text, n.style, n.origin);
      return;
    }
    // Gone altogether (a filter that drops blocks painting nothing): drawn again last, with its
    // id, tag and MCID (its structure element is still there).
    const pageObj = page.getObject();
    const { body } = textOps(mupdf, doc, pageObj, page.getTransform() as Matrix, n.origin, n.text, n.style);
    appendSafely(mupdf, doc, pageObj, openMark(n.tagName, n.mcid, "PEText", n.id) + body + "EMC\n");
  } finally {
    page.destroy();
  }
}

// ---------------------------------------------------------------------------------------------
// New picture

/**
 * Draws `picture` (images.checkPicture) at each target (ImageInfo.matrix convention: where the
 * picture is seen; its EXIF orientation turns the stored pixels upright), over everything else
 * on that page, in a block of its own marked /PEImage: a /Figure described by `alt` on a tagged
 * page, an /Artifact without a description or on an untagged page. The picture is embedded once
 * for all targets. Every target page is checked first (appendProblem: ContentError
 * "not-editable"), so nothing is changed when one cannot take it. Returns, for each target, the
 * new placement's index in its page's images (images.findPlacements), or null when that page's
 * images are locked ("unreadable") or `locate` is false (a replay, which does not need it).
 */
export function addImage(
  mupdf: MuPDFModule, doc: Doc, picture: Picture, targets: ImageTarget[], alt: string | null, { locate = true } = {},
): { pageIndex: number; imageIndex: number | null }[] {
  const scans = targets.map((t) => {
    const page = doc.loadPage(t.pageIndex);
    try {
      const scan = scanContent(page.getObject());
      const problem = endProblem(scan.end);
      if (problem) throw new ContentError(`Page ${t.pageIndex + 1}: ${problem}`, "not-editable");
      return scan;
    } finally {
      page.destroy();
    }
  });
  const turn = ORIENTATION[picture.orientation] ?? IDENTITY;
  const drawn = targets.map((t) => concat(turn, t.matrix));
  const description = alt?.trim() || null;
  const image = openImage(mupdf, picture.bytes);
  try {
    // (a page given twice is read again for its second picture)
    targets.forEach((t, k) =>
      placePicture(mupdf, doc, t.pageIndex, image, picture, drawn[k], description, targets.slice(0, k).some((u) => u.pageIndex === t.pageIndex) ? null : scans[k]));
  } finally {
    image.destroy();
  }
  return targets.map((t, k) => ({ pageIndex: t.pageIndex, imageIndex: locate ? locatePicture(mupdf, doc, t.pageIndex, drawn[k]) : null }));
}

/**
 * Draws `image` (opened from `picture.bytes`) on page `pageIndex` at `drawn` (ImageInfo
 * convention, the stored pixels). The picture object records the picture's EXIF orientation
 * (images.pictureObject), so a later replace fits the new picture to the frame as seen.
 */
function placePicture(
  mupdf: MuPDFModule, doc: Doc, pageIndex: number, image: MuPDF.Image, picture: Picture, drawn: Matrix, alt: string | null, known: ContentScan | null,
) {
  const page = doc.loadPage(pageIndex);
  try {
    const pageObj = page.getObject();
    const scan = known ?? scanContent(pageObj);
    const xobjects = ownXObjects(doc, pageObj);
    let k = 1, name: string;
    do name = `PEImg${k++}`;
    while (!xobjects.get(name).isNull());
    xobjects.put(name, pictureObject(doc, image, picture.bytes, null, picture.orientation));
    // The unit square onto user space, from the page's initial CTM: P = FLIP · drawn, K = P · CTM⁻¹.
    const K = concat(concat(FLIP, drawn), invert(page.getTransform() as Matrix));
    const id = nextId(scan.imageIds);
    const tag = alt ? tagNew(doc, pageIndex, "Figure", alt, scan.maxMcid) : null;
    const mark = tag ? openMark("Figure", tag.mcid, "PEImage", id) : openMark("Artifact", null, "PEImage", id);
    appendSafely(mupdf, doc, pageObj, `${mark}q ${K.map(num).join(" ")} cm /${name} Do Q\nEMC\n`, scan.end);
  } finally {
    page.destroy();
  }
}

/**
 * The index of the picture just placed at `drawn` among the page's images: the last added
 * placement drawn there, when it is movable. Null when the page's images are locked, or reading
 * them fails (the picture is placed all the same).
 */
function locatePicture(mupdf: MuPDFModule, doc: Doc, pageIndex: number, drawn: Matrix): number | null {
  try {
    const page = doc.loadPage(pageIndex);
    try {
      const found = findPlacements(mupdf, page);
      if (!found.agreed) return null;
      const k = found.placements.findLastIndex((p) => p.added && nearlyEqual(p.matrix, drawn));
      return k >= 0 && found.placements[k].movable ? k : null;
    } finally {
      page.destroy();
    }
  } catch {
    return null;
  }
}
