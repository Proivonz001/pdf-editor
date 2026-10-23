// Page operations (release 4, "Pagine"): move, delete, blank pages, copies, rotation, pages of
// another PDF, and "keep only these" (extract). EngineSession logs each one as an edit and
// replays it through these functions, so they depend only on their arguments and on the
// document's state: the same call on the same document makes the same objects in the same order
// (field renames, label repairs, where a bookmark goes), and a replay after undo or from a
// checkpoint repeats it exactly. Ported from the release 4 research prototypes (ops6-lib.mjs,
// dup.mjs, importer.mjs: feedback-r3/report-pages.md), with the gaps the integration map listed
// (r4/maps.md, "protos" section 1) fixed, or named below as out of scope.
//
// MuPDF's ready-made calls cannot be used as they are: rearrangePages rebuilds the catalog
// (form, tags, labels, metadata gone) and puts a repeated page in two places; deletePage leaves
// fields, tags, bookmarks and destinations pointing at the page, which keeps it, and whatever the
// user wrote on it, in every download; graftPage copies no annotation and drags the source's
// whole page tree in through any reference to one of its pages. So:
//
// - The page tree is written in one pass (writePageTree), never through MuPDF's deletePage and
//   insertPage: each of those costs time in proportion to the page count, so calling them once
//   per page took seconds on a long document (a one-page move re-inserted every page, an extract
//   deleted the others one at a time). Every operation that changes the pages writes them, in
//   their new order, as the /Kids of the tree's root; the /Pages nodes below it leave the tree.
// - Inherited attributes. A page may inherit MediaBox, CropBox, Rotate and Resources from its
//   /Pages nodes. Before it goes under the root, a page gets its own copy of what it inherited
//   and would get otherwise from the root alone (Resources as a dictionary of its own, never the
//   node's), and a new page (blank, copy, added) its own CropBox, Rotate and Resources where it
//   would take the root's (a blank page under a cropped node came out cropped).
// - Indices are checked as untrusted (PagesError "bad-request"): whole numbers in range, each
//   once; a move takes a permutation of every page; a delete never takes every page.
// - Page labels are read before and written back after, so MuPDF's own repairs never decide them:
//   a move keeps the labels by position (i ii 1 2 stays i ii 1 2); a delete shifts the ranges as
//   MuPDF does (a range whose pages are all gone goes); inserted pages join the range of the page
//   before them, or the first range when they go first (MuPDF would start a new "1"), and a file
//   without labels gets none (MuPDF would make "1 1 2" for a page inserted first).
// - Destinations that name their page by number (`[2 /Fit]`; ISO 32000 asks for the page object,
//   but MuPDF and the importer read a number as the page's index). Before an operation numbers
//   the pages again (move, delete, keep, blank pages, copies, an insert), each one is pinned to
//   its page object (pinNumberedDestinations): it then follows its page, goes with it, is copied
//   with it, as any other reference to the page. A copy of another PDF kept to the chosen pages
//   (the session logs an insert so) therefore inserts as the whole file would. Remote GoTo
//   actions (GoToR, GoToE) name pages of another file by number, as they should: left alone.
// - Delete (deletePages, keepPages) cleans every reference to a deleted page and its annotations
//   before the tree is written without it: links on other pages that lead there (explicit
//   destinations, GoTo actions, named destinations), named destinations themselves (in a /Dests
//   name tree with /Kids, and in the old /Root/Dests dictionary), GoTo actions of buttons and
//   other widgets, /AA actions of pages, widgets, fields and the document, /Next chains, the
//   OpenAction; widgets on the page leave their fields and fields left empty leave the form
//   (/Fields, /CO; a static XFA part goes, it would keep their data); bookmarks (one with
//   children stays, without a target; /Count recomputed); article thread beads (a thread left
//   empty goes); the structure tree: content items of the page (MCIDs, marked-content and object
//   references, tagged annotations' OBJR) leave their elements, an element left empty goes, one
//   whose /Pg was the page but which holds content of other pages stays without /Pg, and the
//   ParentTree (with /Kids) loses the page's and its annotations' keys. All of it in one pass,
//   whatever the number of pages deleted. Then, as a safety net, every object still reachable
//   from the trailer is read once, and any reference left to what was removed is cut (a
//   dictionary entry goes, a list element goes, a pair goes from a name or number tree, any other
//   array element becomes null). So nothing of a deleted page, or of what the user wrote on it,
//   is reachable in a downloaded file (garbage collected). The report's linksRemoved counts what
//   the user could see go: links, buttons' actions and bookmarks (PagesOutcome.bookmarksRemoved:
//   how many were bookmarks); not named destinations or /AA actions, which nothing shows (a LaTeX
//   file names a destination for every page and section).
// - Copy (duplicatePages): a new page dictionary, never the same object twice in the tree:
//   content streams copied, resources shared (the copy gets its own /Resources dictionary, one
//   level deep, holding the same fonts and images), annotations copied with their appearance
//   streams (direct sub-objects copied too) and /P to the copy, popups paired again, /IRT
//   remapped when its target is copied too, fields copied as new fields renamed "<name>_copia1"
//   (copies of a signature field hold no signature), no /StructParents: editing the copy never
//   changes the original.
// - Pages of another PDF (insertPages): the source is only read. Its pages, annotations, fields,
//   actions and bookmarks are copied by hand into the document, and every value on the way is
//   copied through one graft map only when nothing it reaches is a page, a /Pages node, the
//   catalog, an annotation, a field or the structure or outline root of the source; a value that
//   does reach one is copied piece by piece and the reference cut there. So no page that was not
//   chosen comes in (a button's GoTo, a note's /IRT, a link's /Next chain, a signature's /Data
//   reference to the catalog...). Links and GoTo actions lead to the copied pages or go (counted);
//   named destinations become explicit ones; /P, /StructParent and /StructParents are left out;
//   fields keep their values, their widgets on pages not chosen are left out, a top field whose
//   name the document has is renamed "nome_2", the form's /DR fonts are merged (a name used for
//   another font gets a new name, and the copied fields' /DA follow it), the source's default
//   /DA and /Q go on its top fields, signatures stay (counted: they are no longer valid here), a
//   static XFA part of the document goes, password fields get hidePasswords, and a source form
//   with /NeedAppearances gets real appearances for the copied fields (the app's field writer,
//   forms.applyFieldEdit with each field's own value) rather than the flag, which would make
//   MuPDF redraw every field of the document; layers used by the copied pages join
//   /OCProperties with the state they had (BaseState, ON, OFF, Locked, RBGroups; the /D
//   configuration may be missing in the source); with a title, one bookmark leads to the first
//   added page, the source's bookmarks to added pages under it (an entry whose children all went
//   goes too), placed among the document's top bookmarks in page order.
//
// Layers caveat for the session: MuPDF reads a document's layer list once, the first time it
// draws optional content. Layers an insert adds after that are missing from it, so they draw as
// visible (lines, render, text occurrences) until the document is re-opened. insertPages returns
// how many it added (PagesOutcome.layers); with any, the caller must re-open the working document
// (as a checkpoint does) before it draws again, so results do not depend on the path taken.
//
// Out of scope here: tag merging (added and copied pages come in untagged; their content keeps
// its MCIDs, which no element claims); a structure element that holds content of a deleted page
// and of others keeps its /Alt and /ActualText; copies and added pages do not get /Metadata,
// /PieceInfo, /Thumb, article beads, the source's named destinations, its layer /AS, /Configs or
// /Intent, or its page labels; scripts of copied and added fields still name the old fields; a
// destination whose number names no page of the document is left as it is (MuPDF cannot follow
// it: resolveLink throws).
//
// Values of the wrong kind: MuPDF hands a literal `null` in an array or a dictionary (some files
// have them in /Annots, /Kids, /Fields, name trees, /DR...) back as the null object, and
// PDFObject.get on the null object throws, as put and delete on anything that is no dictionary
// do. So whatever is read from a list or a dictionary is checked to be a dictionary (or an
// array) before anything is read from or written into it, lookups along a path go through
// `lookup`, and `entries` leaves null entries out (ISO 32000: an entry whose value is null is no
// entry): such a value is skipped, never the cause of a failed operation. Tests put nulls and
// numbers everywhere the operations walk.
//
// MuPDF objects (ARCHITECTURE.md rule 5): the graft map and every Buffer are destroyed in
// `finally`; no page is loaded here, no PDFPage held across a page change; PDFObject wrappers are
// left to the garbage collector, as everywhere else in the engine. JS strings given to MuPDF
// would become names, so strings are made with newString.
import type * as MuPDF from "mupdf";
import { applyFieldEdit, fieldTypeOf, formChanged, fullName, hidePasswords, isPasswordField, type FieldEdit } from "./forms";
import { MAX_IMAGE_SIDE, MIN_IMAGE_SIDE } from "./protocol";
import type { FieldType, FieldValue, PagesReport } from "./protocol";

type MuPDFModule = typeof MuPDF;
type Doc = MuPDF.PDFDocument;
type Obj = MuPDF.PDFObject;

/** A refusal: "bad-request" (indices, sizes, a title that cannot be), "not-editable" (a page tree that cannot be read). */
export class PagesError extends Error {
  constructor(message: string, readonly code: "bad-request" | "not-editable") {
    super(message);
    this.name = "PagesError";
  }
}

/** What a page operation did besides the pages themselves. */
export interface PagesOutcome {
  report: PagesReport;
  /**
   * insertPages only: the layers (optional content groups) it added to the document. When not 0,
   * the working document must be re-opened before it draws again (see the header).
   */
  layers?: number;
  /**
   * deletePages and keepPages only: how many of report.linksRemoved were bookmarks. An insert
   * from a copy of the other PDF kept to the chosen pages (keepPages) reports, with
   * `kept.report.linksRemoved - kept.bookmarksRemoved + inserted.report.linksRemoved`, what an
   * insert from the whole file reports (it never counts the other file's bookmarks it leaves out).
   */
  bookmarksRemoved?: number;
}

/** Most new pages one operation makes (blank pages, pictures). */
export const MAX_NEW_PAGES = 10_000;
/** Longest bookmark title insertPages takes, in characters. */
export const MAX_TITLE_CHARS = 1000;

const bad = (message: string) => new PagesError(message, "bad-request");
const noReport = (): PagesReport => ({ linksRemoved: 0, fieldsRenamed: 0, signaturesAdded: 0 });

// ---------------------------------------------------------------------------------------------
// Small object helpers

/** obj[key][key]..., or the null object when anything on the way is missing (get() on the null object throws). */
function lookup(obj: Obj, ...path: string[]): Obj {
  return obj.isNull() ? obj : obj.get(...path);
}

const nameOf = (o: Obj) => (o.isName() ? o.asName() : null);
/** The text of a string or a name (destination names come as both), else null. */
const textOf = (o: Obj) => (o.isString() ? o.asString() : o.isName() ? o.asName() : null);
/** The same object: the same indirect object, or the same direct one in memory. */
const keyOf = (o: Obj) => (o.isIndirect() ? `n${o.asIndirect()}` : `p${o.pointer}`);
const catalog = (doc: Doc) => doc.getTrailer().get("Root");

function items(arr: Obj): Obj[] {
  const out: Obj[] = [];
  if (arr.isArray()) for (let i = 0; i < arr.length; i++) out.push(arr.get(i));
  return out;
}

/** A dictionary's entries, without those whose value is null (ISO 32000: an entry with a null value is no entry). */
function entries(dict: Obj): [string, Obj][] {
  const out: [string, Obj][] = [];
  if (dict.isDictionary()) dict.forEach((v, k) => {
    if (!v.isNull()) out.push([String(k), v]);
  });
  return out;
}

/** A copy of a direct value (dictionaries and arrays all the way down); indirect references stay the same objects. */
function copyDirect(doc: Doc, v: Obj): Obj {
  if (v.isIndirect()) return v;
  if (v.isDictionary()) {
    const n = doc.newDictionary();
    for (const [k, x] of entries(v)) n.put(k, copyDirect(doc, x));
    return n;
  }
  if (v.isArray()) {
    const n = doc.newArray();
    v.forEach((x) => n.push(copyDirect(doc, x)));
    return n;
  }
  return v;
}

/** A box (MediaBox, CropBox...) as a new array of four numbers, or null when it is no box. */
function copyBox(doc: Doc, v: Obj): Obj | null {
  if (!v.isArray() || v.length !== 4) return null;
  const out = doc.newArray();
  for (let i = 0; i < 4; i++) {
    const x = v.get(i);
    out.push(x.isNumber() ? x.asNumber() : 0);
  }
  return out;
}

/** A /Resources dictionary of its own (one level deep: its sub-dictionaries copied too, the fonts and images in them shared). */
function copyResources(doc: Doc, v: Obj): Obj {
  const out = doc.newDictionary();
  for (const [k, x] of entries(v)) out.put(k, x.isIndirect() || !x.isDictionary() ? x : copyDirect(doc, x));
  return out;
}

/** Puts `kid` in the /Kids of a field copy, made when the copy has none (a widget that was its own field, met as a parent). */
function pushKid(doc: Doc, parent: Obj, kid: Obj) {
  let kids = parent.get("Kids");
  if (!kids.isArray()) {
    kids = doc.newArray();
    parent.put("Kids", kids);
  }
  kids.push(kid);
}

/** /Rotate as MuPDF reads it (the page's own or inherited): a multiple of 90 in 0..270. */
function rotationOf(node: Obj): number {
  const r = node.getInheritable("Rotate");
  const deg = r.isNumber() ? r.asNumber() : 0;
  return (((Math.round(deg / 90) * 90) % 360) + 360) % 360;
}

/** The same value: both missing, the same indirect object, or direct values that print the same. */
function sameValue(a: Obj, b: Obj): boolean {
  if (a.isNull() || b.isNull()) return a.isNull() && b.isNull();
  if (a.isIndirect() && b.isIndirect()) return a.asIndirect() === b.asIndirect();
  return a.toString() === b.toString();
}

/** What a page shows without a MediaBox of its own or inherited (MuPDF's default): Letter. */
const LETTER = [0, 0, 612, 792];

/**
 * Makes what the page shows independent of where it sits before it goes under `root` (the page
 * tree's root, writePageTree): each attribute it may inherit (MediaBox, CropBox, Rotate,
 * Resources) that it does not have itself, and that it would get differently from the root, is
 * set on the page: a copy of what it has now (Resources as a dictionary of its own, one level
 * deep, never a node's), or, when it has none now, the value that means none (its MediaBox as
 * CropBox, Rotate 0, empty Resources, a Letter MediaBox). So a moved page keeps its size, turn
 * and fonts, and a new page takes nothing from the root. A page already under the root, or under
 * nodes that hand down nothing the root does not, is left as it is.
 */
function ownAttributes(doc: Doc, page: Obj, root: Obj) {
  const parent = page.get("Parent");
  if (parent.isIndirect() && root.isIndirect() && parent.asIndirect() === root.asIndirect()) return;
  for (const key of ["MediaBox", "CropBox", "Rotate", "Resources"] as const) {
    if (!page.get(key).isNull()) continue;
    if (key === "Rotate") {
      const deg = rotationOf(page);
      if (deg !== rotationOf(root)) page.put("Rotate", deg);
      continue;
    }
    const now = page.getInheritable(key);
    if (sameValue(now, root.getInheritable(key))) continue;
    if (key === "Resources") page.put(key, now.isNull() ? doc.newDictionary() : copyResources(doc, now));
    else if (!now.isNull()) {
      const box = copyBox(doc, now);
      if (box) page.put(key, box);
    } else if (key === "MediaBox") page.put(key, LETTER);
    else {
      const box = copyBox(doc, page.getInheritable("MediaBox"));
      page.put(key, box ?? LETTER);
    }
  }
}

/**
 * Writes the page tree in one pass: `pages` (page objects, in page order) become the /Kids of
 * the tree's root, each with /Parent the root, and /Count their number. Each one first gets what
 * it would no longer inherit (ownAttributes, all of them before any moves). The /Pages nodes
 * below the root are left out of the tree (the next garbage-collected save drops them).
 *
 * Why not MuPDF's deletePage and insertPage: each call costs time in proportion to the page
 * count (it forgets the page map, which the next lookup reads again), so an operation calling
 * them once per page took seconds on a long document (review P8). MuPDF forgets its page map
 * when any object changes, so its next lookup reads this tree; pageObjects checked the root.
 */
function writePageTree(doc: Doc, pages: Obj[]) {
  let root = lookup(catalog(doc), "Pages");
  if (!root.isIndirect()) {
    // A direct root would be written into every page as its /Parent: it becomes an object of its own.
    root = doc.addObject(root);
    catalog(doc).put("Pages", root);
  }
  for (const page of pages) ownAttributes(doc, page, root);
  const kids = doc.newArray();
  for (const page of pages) {
    kids.push(page);
    page.put("Parent", root);
  }
  root.put("Kids", kids);
  root.put("Count", pages.length);
}

/** `pages` with `added` put in before position `at` (0..pages.length). */
const spliced = (pages: Obj[], at: number, added: Obj[]) => [...pages.slice(0, at), ...added, ...pages.slice(at)];

/**
 * Pins every local destination that names its page by number (`[2 /Fit]`: ISO 32000 asks for
 * the page object, but MuPDF and the importer read a number as the page's index) to the page
 * object, `objs[n]`, before an operation numbers the pages again: from then on it is a reference
 * to its page like any other, so it follows the page and goes with it (review, fix round 1: a
 * copy of another PDF kept to the chosen pages, as the session logs an insert, sent such links
 * to other pages or dropped them). Where: /Dest of annotations and bookmarks, GoTo actions (and
 * their /Next chains) in /A of annotations, fields and bookmarks, in /AA of pages, annotations,
 * fields and the document, and in /OpenAction; the values of named destinations (the /Dests name
 * tree, the old /Root/Dests). A GoToR or GoToE names a page of another file by number, as it
 * should: left alone. A number that names no page of the document stays as it is.
 */
function pinNumberedDestinations(doc: Doc, objs: Obj[]) {
  const done = new Set<string>();
  const pin = (d: Obj, depth = 0) => {
    if (d.isDictionary() && depth < 8) return pin(d.get("D"), depth + 1); // a named destination's value may be { D: [...] }
    if (!d.isArray() || d.length === 0) return;
    const first = d.get(0);
    if (!first.isInteger()) return;
    const n = first.asNumber();
    if (n >= 0 && n < objs.length) d.put(0, objs[n]);
  };
  const action = (a: Obj, depth = 0) => {
    if (!a.isDictionary() || depth > 16 || done.has(keyOf(a))) return;
    done.add(keyOf(a));
    if (nameOf(a.get("S")) === "GoTo") pin(a.get("D"));
    const next = a.get("Next");
    for (const x of next.isArray() ? items(next) : [next]) action(x, depth + 1);
  };
  const actions = (aa: Obj) => {
    for (const [, a] of entries(aa)) action(a);
  };
  for (const page of objs) {
    actions(page.get("AA"));
    for (const a of items(page.get("Annots"))) {
      if (!a.isDictionary()) continue;
      pin(a.get("Dest"));
      action(a.get("A"));
      actions(a.get("AA"));
    }
  }
  const root = catalog(doc);
  const open = root.get("OpenAction");
  if (open.isArray()) pin(open);
  else action(open);
  actions(root.get("AA"));
  const outline = (parent: Obj, seen: Set<string>, depth: number) => {
    if (depth > 64) return;
    for (const item of outlineKids(parent, seen)) {
      pin(item.get("Dest"));
      action(item.get("A"));
      outline(item, seen, depth + 1);
    }
  };
  const outlines = root.get("Outlines");
  if (outlines.isDictionary()) outline(outlines, new Set(), 0);
  eachLeaf(lookup(root, "Names", "Dests"), "Names", (_, v) => pin(v));
  for (const [, v] of entries(root.get("Dests"))) pin(v);
  const fields = (list: Obj, seen: Set<string>, depth: number) => {
    for (const f of items(list)) {
      if (!f.isDictionary() || depth > 32 || seen.has(keyOf(f))) continue;
      seen.add(keyOf(f));
      action(f.get("A"));
      actions(f.get("AA"));
      fields(f.get("Kids"), seen, depth + 1);
    }
  };
  fields(lookup(root, "AcroForm", "Fields"), new Set(), 0);
}

// ---------------------------------------------------------------------------------------------
// Checking what the caller asks

/** The page objects in page order; "not-editable" when the page tree (its root a dictionary in the catalog) cannot be read. */
function pageObjects(doc: Doc, what = "document"): Obj[] {
  const out: Obj[] = [];
  try {
    if (!lookup(catalog(doc), "Pages").isDictionary()) throw new Error("there is no page tree");
    const count = doc.countPages();
    for (let i = 0; i < count; i++) {
      const o = doc.findPage(i);
      if (!o.isDictionary() || !o.isIndirect()) throw new Error(`page ${i + 1} is no page object`);
      out.push(o);
    }
  } catch (err) {
    throw new PagesError(`The ${what}'s pages cannot be read: ${err instanceof Error ? err.message : String(err)}`, "not-editable");
  }
  return out;
}

/** Page indices from the caller, checked as untrusted: a non-empty list of whole numbers in 0..count-1, each once. */
function checkPages(pages: unknown, count: number): number[] {
  if (!Array.isArray(pages) || pages.length === 0) throw bad("No pages given");
  if (pages.length > count) throw bad("More pages given than there are");
  const seen = new Set<number>();
  for (const p of pages) {
    if (typeof p !== "number" || !Number.isInteger(p) || p < 0 || p >= count) throw bad(`No page ${String(p)}`);
    if (seen.has(p)) throw bad(`Page ${p + 1} is given twice`);
    seen.add(p);
  }
  return pages.slice() as number[];
}

/** An insertion point from the caller: 0..count (count: at the end). */
function checkAt(at: unknown, count: number): number {
  if (typeof at !== "number" || !Number.isInteger(at) || at < 0 || at > count) throw bad(`Cannot insert at ${String(at)}`);
  return at;
}

/** The page objects' numbers in page order (the session maps PageLayout.from with them). */
export function pageObjectNumbers(doc: Doc): number[] {
  const out: number[] = [];
  for (let i = 0; i < doc.countPages(); i++) out.push(doc.findPage(i).asIndirect());
  return out;
}

// ---------------------------------------------------------------------------------------------
// Page labels: read before an operation, written back after it as the operation wants them.

interface LabelRange {
  start: number;
  /** The label dictionary (/S, /P, /St): the same indirect object, or a copy of a direct one. */
  style: Obj;
}

/** Calls `fn` for each key/value of a number or name tree (/Nums or /Names leaves, /Kids), each node once. */
function eachLeaf(node: Obj, leafKey: "Nums" | "Names", fn: (key: Obj, value: Obj) => void, seen = new Set<string>(), depth = 0) {
  if (!node.isDictionary() || depth > 32 || seen.has(keyOf(node))) return;
  seen.add(keyOf(node));
  const leaf = node.get(leafKey);
  if (leaf.isArray()) for (let i = 0; i + 1 < leaf.length; i += 2) fn(leaf.get(i), leaf.get(i + 1));
  for (const kid of items(node.get("Kids"))) eachLeaf(kid, leafKey, fn, seen, depth + 1);
}

/** The label ranges by first page, or null when the document has no /PageLabels. */
function readLabels(doc: Doc): LabelRange[] | null {
  const tree = lookup(catalog(doc), "PageLabels");
  if (!tree.isDictionary()) return null;
  const byStart = new Map<number, Obj>();
  eachLeaf(tree, "Nums", (k, v) => {
    const start = k.isNumber() ? k.asNumber() : -1;
    if (Number.isInteger(start) && start >= 0 && v.isDictionary()) byStart.set(start, copyDirect(doc, v));
  });
  return [...byStart].sort((a, b) => a[0] - b[0]).map(([start, style]) => ({ start, style }));
}

/** Writes the ranges as one flat /Nums (in the same /PageLabels object when there is one); null: no labels. */
function writeLabels(doc: Doc, ranges: LabelRange[] | null) {
  const root = catalog(doc);
  const count = doc.countPages();
  const byStart = new Map<number, Obj>();
  for (const r of ranges ?? []) if (r.start < count) byStart.set(r.start, r.style); // a later range at the same page wins
  if (!byStart.size) {
    if (!root.get("PageLabels").isNull()) root.delete("PageLabels");
    return;
  }
  const nums = doc.newArray();
  for (const [start, style] of [...byStart].sort((a, b) => a[0] - b[0])) {
    nums.push(start);
    nums.push(style);
  }
  const tree = root.get("PageLabels");
  if (tree.isDictionary()) {
    tree.put("Nums", nums);
    tree.delete("Kids");
    tree.delete("Limits");
  } else {
    const fresh = doc.newDictionary();
    fresh.put("Nums", nums);
    root.put("PageLabels", doc.addObject(fresh));
  }
}

/** `n` pages inserted at `at` join the range of the page before them (the first range when at is 0). */
function labelsAfterInsert(ranges: LabelRange[] | null, at: number, n: number): LabelRange[] | null {
  if (!ranges) return null;
  return ranges.map((r) => ({ ...r, start: r.start > at || (r.start === at && at > 0) ? r.start + n : r.start }));
}

/** The pages `deleted` (old indices, ascending) gone: each range moves up by the deleted pages before it, as MuPDF's deletePage does. */
function labelsAfterDelete(ranges: LabelRange[] | null, deleted: number[]): LabelRange[] | null {
  if (!ranges) return null;
  /** How many deleted pages come before page `p` (a binary search: a range may start at every page). */
  const before = (p: number) => {
    let lo = 0, hi = deleted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (deleted[mid] < p) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return ranges.map((r) => ({ ...r, start: r.start - before(r.start) }));
}

// ---------------------------------------------------------------------------------------------
// Name and number trees

/** Removes the pairs `drop` picks from a name or number tree, its /Limits fixed and kids left empty dropped; returns how many went. */
function pruneTree(node: Obj, leafKey: "Nums" | "Names", drop: (key: Obj, value: Obj) => boolean, seen = new Set<string>(), depth = 0): number {
  if (!node.isDictionary() || depth > 32 || seen.has(keyOf(node))) return 0;
  seen.add(keyOf(node));
  let removed = 0;
  const leaf = node.get(leafKey);
  if (leaf.isArray()) {
    for (let i = leaf.length - (leaf.length % 2) - 2; i >= 0; i -= 2) {
      if (!drop(leaf.get(i), leaf.get(i + 1))) continue;
      leaf.delete(i + 1);
      leaf.delete(i);
      removed++;
    }
  }
  const kids = node.get("Kids");
  if (kids.isArray()) {
    for (let i = kids.length - 1; i >= 0; i--) {
      const kid = kids.get(i);
      const r = pruneTree(kid, leafKey, drop, seen, depth + 1);
      removed += r;
      if (r && items(kid.get(leafKey)).length === 0 && items(kid.get("Kids")).length === 0) kids.delete(i);
    }
  }
  if (removed && node.get("Limits").isArray()) {
    // Keys and kids as they are: a null or a value of another kind is no key, and a kid that is no dictionary has no limits.
    const isKey = (k: Obj) => (leafKey === "Names" ? k.isString() || k.isName() : k.isNumber());
    const keys = leaf.isArray() ? items(leaf).filter((k, i) => i % 2 === 0 && isKey(k)) : [];
    const kidLimits = items(node.get("Kids"))
      .filter((k) => k.isDictionary())
      .map((k) => k.get("Limits"))
      .filter((l) => l.isArray() && l.length === 2);
    const first = keys[0] ?? kidLimits[0]?.get(0);
    const last = keys.length ? keys[keys.length - 1] : kidLimits[kidLimits.length - 1]?.get(1);
    if (first && last) node.put("Limits", [first, last]);
  }
  return removed;
}

// ---------------------------------------------------------------------------------------------
// Bookmarks

/** The outline children of `item` (First / Next chain), each once. */
function outlineKids(item: Obj, seen: Set<string>): Obj[] {
  const out: Obj[] = [];
  let it = item.get("First");
  while (it.isDictionary() && !seen.has(keyOf(it)) && out.length < 100_000) {
    seen.add(keyOf(it));
    out.push(it);
    it = it.get("Next");
  }
  return out;
}

/** Links `kids` as the children of `parent` (Parent, Prev, Next, First, Last); none: the keys go. */
function linkOutline(parent: Obj, kids: Obj[]) {
  kids.forEach((o, k) => {
    o.put("Parent", parent);
    if (k) o.put("Prev", kids[k - 1]);
    else o.delete("Prev");
    if (k < kids.length - 1) o.put("Next", kids[k + 1]);
    else o.delete("Next");
  });
  if (kids.length) {
    parent.put("First", kids[0]);
    parent.put("Last", kids[kids.length - 1]);
  } else {
    parent.delete("First");
    parent.delete("Last");
    parent.delete("Count");
  }
}

/**
 * Sets /Count all the way down, as ISO 32000 defines it: the entries visible under an item when it
 * is open (its children, and theirs under open ones), positive when open, negative when closed (an
 * item without /Count or with a negative one is closed); the root holds the entries visible at
 * every level. Returns the number for `item`.
 */
function recountOutline(item: Obj, root: boolean, seen = new Set<string>(), depth = 0): number {
  if (depth > 64) return 0;
  let n = 0;
  for (const kid of outlineKids(item, seen)) {
    const open = kid.get("Count").isNumber() && kid.get("Count").asNumber() > 0;
    const below = recountOutline(kid, false, seen, depth + 1);
    n += 1 + (open ? below : 0);
  }
  if (n === 0) item.delete("Count");
  else if (root) item.put("Count", n);
  else {
    const open = item.get("Count").isNumber() && item.get("Count").asNumber() > 0;
    item.put("Count", open ? n : -n);
  }
  return n;
}

// ---------------------------------------------------------------------------------------------
// The safety net of a delete: references left to removed objects are cut.

/** "12 0 R" in MuPDF's printing of an object (strings with other characters print as hex, so they cannot fake one). */
const REF = /(?<![\w.#])(\d+) (\d+) R(?!\w)/g;
/** Keys whose arrays are lists: a reference to an object that left is taken out of them. */
const LIST_KEYS = new Set(["Annots", "Kids", "Fields", "CO", "OCGs", "ON", "OFF", "Locked", "Order", "K", "Threads", "B", "Next", "RBGroups"]);
/** Keys whose arrays hold key/value pairs (name and number trees): the pair goes. */
const PAIR_KEYS = new Set(["Names", "Nums"]);

/** The object numbers a printing of an object references (exported for redact.ts, as cutReferences). */
export const refsIn = (text: string) => Array.from(text.matchAll(REF), (m) => Number(m[1]));

/** Cuts the references to `gone` inside `o` and its direct sub-objects; returns how many. */
function cutIn(o: Obj, gone: Set<number>, parentKey: string, depth: number): number {
  if (depth > 64) return 0;
  let cut = 0;
  if (o.isDictionary()) {
    const drop: string[] = [];
    o.forEach((v, k) => {
      if (v.isIndirect()) {
        if (gone.has(v.asIndirect())) drop.push(String(k));
      } else if (v.isDictionary() || v.isArray()) cut += cutIn(v, gone, String(k), depth + 1);
    });
    for (const k of drop) o.delete(k);
    return cut + drop.length;
  }
  if (!o.isArray()) return 0;
  for (let i = o.length - 1; i >= 0; i--) {
    const v = o.get(i);
    if (!v.isIndirect()) {
      if (v.isDictionary() || v.isArray()) cut += cutIn(v, gone, parentKey, depth + 1);
      continue;
    }
    if (!gone.has(v.asIndirect())) continue;
    cut++;
    if (PAIR_KEYS.has(parentKey) && i % 2 === 1) {
      o.delete(i);
      o.delete(i - 1);
      i--;
    } else if (LIST_KEYS.has(parentKey)) o.delete(i);
    else o.put(i, null);
  }
  return cut;
}

/**
 * Reads every object reachable from the trailer once (never through a removed one) and cuts the
 * references left to `gone`: afterwards none of them is reachable, so a garbage-collected save
 * leaves them out. Returns how many references were cut. (Also redact.ts's safety net.)
 */
export function cutReferences(doc: Doc, gone: Set<number>): number {
  if (!gone.size) return 0;
  const total = doc.countObjects();
  const seen = new Set<number>();
  const queue: number[] = [];
  let cut = 0;
  const visit = (o: Obj) => {
    let hit = false;
    for (const n of refsIn(o.toString())) {
      if (gone.has(n)) hit = true;
      else if (n > 0 && n < total && !seen.has(n)) {
        seen.add(n);
        queue.push(n);
      }
    }
    if (hit) cut += cutIn(o, gone, "", 0);
  };
  visit(doc.getTrailer());
  while (queue.length) visit(doc.newIndirect(queue.pop()!).resolve());
  return cut;
}

// ---------------------------------------------------------------------------------------------
// Fields (shared by copies and inserts)

/** The form's dictionary, made when the document has none (with /Fields). */
function ensureAcroForm(doc: Doc): Obj {
  const root = catalog(doc);
  let acro = root.get("AcroForm");
  if (!acro.isDictionary()) {
    acro = doc.addObject(doc.newDictionary());
    root.put("AcroForm", acro);
  }
  if (!acro.get("Fields").isArray()) acro.put("Fields", doc.newArray());
  return acro;
}

/** The nodes that give a field tree its top names: the node itself when it has /T, else its named descendants nearest to it. */
function namedLevel(node: Obj, depth = 0): Obj[] {
  if (!node.get("T").isNull() || depth > 32) return [node];
  return items(node.get("Kids")).filter((k) => k.isDictionary() && nameOf(k.get("Subtype")) !== "Widget").flatMap((k) => namedLevel(k, depth + 1));
}

/** The top-level field names of the document (as namedLevel sees them). */
function topNames(doc: Doc): Set<string> {
  const out = new Set<string>();
  for (const top of items(lookup(catalog(doc), "AcroForm", "Fields"))) {
    if (!top.isDictionary()) continue;
    for (const n of namedLevel(top)) {
      const t = textOf(n.get("T"));
      if (t !== null) out.add(t);
    }
  }
  return out;
}

/** Puts `item` in an array of `dict` (made when missing), once. */
function pushOnce(doc: Doc, dict: Obj, key: string, item: Obj) {
  let arr = dict.get(key);
  if (!arr.isArray()) {
    arr = doc.newArray();
    dict.put(key, arr);
  }
  if (item.isIndirect() && items(arr).some((x) => x.isIndirect() && x.asIndirect() === item.asIndirect())) return;
  arr.push(item);
}

// ---------------------------------------------------------------------------------------------
// Move

/** Puts the pages in `order`: `order[k]` is the index of the page that goes to position k (a permutation of all pages). */
export function movePages(_mupdf: MuPDFModule, doc: Doc, order: number[]): PagesOutcome {
  const objs = pageObjects(doc);
  if (!Array.isArray(order) || order.length !== objs.length) throw bad("A move lists every page once");
  checkPages(order, objs.length);
  if (order.every((p, k) => p === k)) return { report: noReport() };
  const labels = readLabels(doc);
  pinNumberedDestinations(doc, objs);
  writePageTree(doc, order.map((i) => objs[i]));
  writeLabels(doc, labels); // by position: the numbering stays as it was
  formChanged(doc);
  return { report: noReport() };
}

// ---------------------------------------------------------------------------------------------
// Rotate

/** Turns the pages clockwise by `by` degrees (their own /Rotate, after what they inherit). */
export function rotatePages(_mupdf: MuPDFModule, doc: Doc, pages: number[], by: 90 | 180 | 270): PagesOutcome {
  const objs = pageObjects(doc);
  const list = checkPages(pages, objs.length);
  if (by !== 90 && by !== 180 && by !== 270) throw bad(`Cannot rotate by ${String(by)}`);
  const done = new Set<number>(); // a page object listed twice in the tree turns once
  for (const i of list) {
    const o = objs[i];
    if (done.has(o.asIndirect())) continue;
    done.add(o.asIndirect());
    o.put("Rotate", (rotationOf(o) + by) % 360);
  }
  formChanged(doc);
  return { report: noReport() };
}

// ---------------------------------------------------------------------------------------------
// Blank pages

/** `sizes.length` new empty pages at `at`, each [width, height] in points. */
export function insertBlankPages(mupdf: MuPDFModule, doc: Doc, at: number, sizes: [number, number][]): PagesOutcome {
  const objs = pageObjects(doc);
  checkAt(at, objs.length);
  if (!Array.isArray(sizes) || sizes.length === 0 || sizes.length > MAX_NEW_PAGES) throw bad("No page sizes given");
  for (const s of sizes) {
    const ok = Array.isArray(s) && s.length === 2 && s.every((v) => typeof v === "number" && Number.isFinite(v) && v >= MIN_IMAGE_SIDE && v <= MAX_IMAGE_SIDE);
    if (!ok) throw bad("A page side is a number of points from 1 to 14,400");
  }
  const labels = readLabels(doc);
  pinNumberedDestinations(doc, objs);
  const added = sizes.map(([w, h]) => {
    const contents = new mupdf.Buffer("");
    try {
      return doc.addPage([0, 0, w, h], 0, {}, contents);
    } finally {
      contents.destroy();
    }
  });
  writePageTree(doc, spliced(objs, at, added));
  writeLabels(doc, labelsAfterInsert(labels, at, sizes.length));
  formChanged(doc);
  return { report: noReport() };
}

// ---------------------------------------------------------------------------------------------
// Delete

/** Deletes the pages cleanly (header: "Delete"); never every page. */
export function deletePages(_mupdf: MuPDFModule, doc: Doc, pages: number[]): PagesOutcome {
  const objs = pageObjects(doc);
  const list = checkPages(pages, objs.length);
  if (list.length >= objs.length) throw bad("A document keeps at least one page");
  return new Removal(doc, objs, new Set(list)).run();
}

/**
 * Keeps only `pages` (the others deleted cleanly), in the document's order whatever their order
 * here: for extractPages on a scratch copy, and for the session's copy of another PDF that keeps
 * only the pages an insert takes (the insert then names them by their index in what is kept:
 * the rank of each among the chosen ones, in the order the user chose them). Every page given:
 * nothing changes.
 */
export function keepPages(_mupdf: MuPDFModule, doc: Doc, pages: number[]): PagesOutcome {
  const objs = pageObjects(doc);
  const keep = new Set(checkPages(pages, objs.length));
  const drop = new Set(objs.map((_, i) => i).filter((i) => !keep.has(i)));
  if (!drop.size) return { report: noReport(), bookmarksRemoved: 0 };
  return new Removal(doc, objs, drop).run();
}

/**
 * One clean delete, in one pass whatever the number of pages: what references the deleted pages
 * is cleaned, then the page tree is written without them (writePageTree), then the safety net runs.
 */
class Removal {
  /** Object numbers of the deleted page objects (not those also shown at a page that stays). */
  private readonly gonePages = new Set<number>();
  /** Everything that leaves with them: the pages, their annotations, emptied fields and elements, removed links... */
  private readonly gone = new Set<number>();
  /** Annotation dictionaries that leave (their /StructParent keys leave the ParentTree). */
  private readonly goneAnnots: Obj[] = [];
  /** Named destinations that lead to a deleted page. */
  private readonly goneNames = new Set<string>();
  private readonly survivors: Obj[] = [];
  private fieldsRemoved = 0;
  private linksRemoved = 0;
  /** The bookmarks among linksRemoved. */
  private bookmarksRemoved = 0;

  constructor(private readonly doc: Doc, private readonly objs: Obj[], private readonly deleted: Set<number>) {
    const kept = new Set<number>();
    objs.forEach((o, i) => {
      if (deleted.has(i)) return;
      if (!kept.has(o.asIndirect())) this.survivors.push(o);
      kept.add(o.asIndirect());
    });
    for (const i of deleted) if (!kept.has(objs[i].asIndirect())) this.gonePages.add(objs[i].asIndirect());
    const keptAnnots = new Set<number>();
    for (const o of this.survivors) for (const a of items(o.get("Annots"))) if (a.isIndirect()) keptAnnots.add(a.asIndirect());
    for (const num of this.gonePages) {
      this.gone.add(num);
      for (const a of items(doc.newIndirect(num).get("Annots"))) {
        if (!a.isDictionary() || (a.isIndirect() && keptAnnots.has(a.asIndirect()))) continue;
        this.leave(a);
        this.goneAnnots.push(a);
      }
    }
  }

  run(): PagesOutcome {
    const doc = this.doc;
    const root = catalog(doc);
    const labels = readLabels(doc);
    pinNumberedDestinations(doc, this.objs); // so leadsAway sees them as references to their pages
    this.namedDestinations(root);
    this.annotations();
    this.fields(root);
    this.outline(root);
    this.structure(root);
    this.threads(root);
    const open = root.get("OpenAction");
    if (open.isArray() && this.leadsAway(open)) root.delete("OpenAction");
    else if (open.isDictionary()) this.pruneActionAt(root, "OpenAction");
    this.pruneAA(root);
    for (const page of this.survivors) this.pruneAA(page);
    // The pages that stay, in their order (a page object the tree shows twice stays where it is kept).
    writePageTree(doc, this.objs.filter((_, i) => !this.deleted.has(i)));
    writeLabels(doc, labelsAfterDelete(labels, [...this.deleted].sort((a, b) => a - b)));
    cutReferences(doc, this.gone);
    formChanged(doc);
    return { report: { linksRemoved: this.linksRemoved, fieldsRenamed: 0, signaturesAdded: 0 }, bookmarksRemoved: this.bookmarksRemoved };
  }

  /** Marks an object as leaving (the safety net cuts what still points to it). */
  private leave(o: Obj) {
    if (o.isIndirect()) this.gone.add(o.asIndirect());
  }

  /**
   * Whether a destination (array, name, string, or a dictionary with /D) leads to a deleted page
   * (one that named its page by number names the page object by now: pinNumberedDestinations).
   */
  private leadsAway(d: Obj, depth = 0): boolean {
    if (d.isNull() || depth > 8) return false;
    const name = textOf(d);
    if (name !== null) return this.goneNames.has(name);
    if (d.isDictionary()) return this.leadsAway(d.get("D"), depth + 1);
    if (!d.isArray() || d.length === 0) return false;
    const page = d.get(0);
    return page.isIndirect() && this.gonePages.has(page.asIndirect());
  }

  /** Whether a reference points to something that leaves. */
  private isGone(o: Obj) {
    return o.isIndirect() && this.gone.has(o.asIndirect());
  }

  /**
   * The action without what led to a deleted page (or to something else that leaves): the same
   * object, edited, or null when the action itself goes. Its /Next chain keeps the actions that
   * stay; one that goes takes its own /Next with it.
   */
  private pruneAction(action: Obj, depth = 0): Obj | null {
    if (!action.isDictionary() || depth > 16) return action;
    let goes = false;
    switch (nameOf(action.get("S"))) {
      case "GoTo":
        goes = this.leadsAway(action.get("D"));
        break;
      case "Thread":
        goes = this.isGone(action.get("D")) || this.isGone(action.get("B"));
        break;
      case "Rendition":
      case "Movie":
        goes = this.isGone(action.get("AN")) || this.isGone(action.get("Annotation"));
        break;
      case "Hide":
      case "SubmitForm":
      case "ResetForm": {
        const key = nameOf(action.get("S")) === "Hide" ? "T" : "Fields";
        const list = action.get(key);
        if (this.isGone(list)) goes = true;
        else if (list.isArray()) {
          const before = list.length;
          for (let i = list.length - 1; i >= 0; i--) if (this.isGone(list.get(i))) list.delete(i);
          if (before > 0 && list.length === 0) goes = true; // an empty list would mean every field
        }
        break;
      }
    }
    if (goes) return null;
    const next = action.get("Next");
    if (next.isDictionary()) {
      const kept = this.pruneAction(next, depth + 1);
      if (kept === null) action.delete("Next");
    } else if (next.isArray()) {
      for (let i = next.length - 1; i >= 0; i--) if (this.pruneAction(next.get(i), depth + 1) === null) next.delete(i);
      if (next.length === 0) action.delete("Next");
    }
    return action;
  }

  /** dict[key] pruned as an action: removed when it goes (counted as a removed link). */
  private pruneActionAt(dict: Obj, key: string): boolean {
    const a = dict.get(key);
    if (a.isNull() || this.pruneAction(a) !== null) return false;
    dict.delete(key);
    return true;
  }

  /** The /AA (additional actions) of a page, annotation, field or the catalog, pruned; an empty one goes (not counted: nothing shows it). */
  private pruneAA(dict: Obj) {
    const aa = dict.get("AA");
    if (!aa.isDictionary()) return;
    for (const [k] of entries(aa)) this.pruneActionAt(aa, k);
    if (entries(aa).length === 0) dict.delete("AA");
  }

  /**
   * Named destinations that lead to a deleted page leave the /Dests name tree and the old
   * /Root/Dests dictionary (a name gone from either counts as gone: readers differ in which they
   * read). Not counted in the report: nothing shows them, and the links and bookmarks that used
   * them are counted themselves.
   */
  private namedDestinations(root: Obj) {
    const tree = lookup(root, "Names", "Dests");
    const dict = root.get("Dests");
    // Their values are explicit destinations (arrays, or dictionaries with /D), never names.
    eachLeaf(tree, "Names", (k, v) => {
      const name = textOf(k);
      if (name !== null && this.leadsAway(v)) this.goneNames.add(name);
    });
    for (const [name, v] of entries(dict)) if (this.leadsAway(v)) this.goneNames.add(name);
    pruneTree(tree, "Names", (k) => this.goneNames.has(textOf(k) ?? ""));
    for (const [name] of entries(dict)) if (this.goneNames.has(name)) dict.delete(name);
  }

  /** On the pages that stay: links that lead away go, other annotations lose actions that do. */
  private annotations() {
    for (const page of this.survivors) {
      const annots = page.get("Annots");
      if (!annots.isArray()) continue;
      for (let k = annots.length - 1; k >= 0; k--) {
        const a = annots.get(k);
        if (!a.isDictionary()) continue;
        if (nameOf(a.get("Subtype")) === "Link") {
          const dest = a.get("Dest");
          if ((!dest.isNull() && this.leadsAway(dest)) || (!a.get("A").isNull() && this.pruneAction(a.get("A")) === null)) {
            annots.delete(k);
            this.leave(a);
            this.goneAnnots.push(a);
            this.linksRemoved++;
            continue;
          }
        } else if (this.pruneActionAt(a, "A")) this.linksRemoved++;
        this.pruneAA(a);
      }
    }
  }

  /** Widgets of deleted pages leave their fields; fields left without widgets leave the form and /CO. */
  private fields(root: Obj) {
    const acro = root.get("AcroForm");
    if (!acro.isDictionary()) return;
    const fields = acro.get("Fields");
    if (fields.isArray()) this.pruneFields(fields, new Set(), 0);
    const co = acro.get("CO");
    if (co.isArray()) for (let i = co.length - 1; i >= 0; i--) if (this.isGone(co.get(i))) co.delete(i);
    if (!this.fieldsRemoved) return;
    // A static XFA part would keep the removed fields' data (forms.ts drops it on a field edit too).
    const needsRendering = root.get("NeedsRendering");
    if (!acro.get("XFA").isNull() && !(needsRendering.isBoolean() && needsRendering.asBoolean())) acro.delete("XFA");
  }

  private pruneFields(list: Obj, seen: Set<string>, depth: number) {
    for (let k = list.length - 1; k >= 0; k--) {
      const f = list.get(k);
      if (!f.isDictionary() || depth > 32 || seen.has(keyOf(f))) continue;
      seen.add(keyOf(f));
      const kids = f.get("Kids");
      const widget = nameOf(f.get("Subtype")) === "Widget";
      if (widget && (this.isGone(f) || (f.get("P").isIndirect() && this.gonePages.has(f.get("P").asIndirect())))) {
        list.delete(k);
        this.removeField(f);
        continue;
      }
      if (kids.isArray() && kids.length > 0) {
        this.pruneFields(kids, seen, depth + 1);
        if (kids.length === 0) {
          list.delete(k);
          this.removeField(f);
          continue;
        }
      }
      if (!widget) this.pruneAA(f); // a widget's own /AA: annotations() (it is on a page that stays)
    }
  }

  /** A field (or widget) leaves the form; a signature it held leaves with it (/Perms may point to it). */
  private removeField(f: Obj) {
    this.leave(f);
    this.fieldsRemoved++;
    const v = f.get("V");
    if (fieldTypeOf(f) === "signature" && v.isIndirect() && v.isDictionary()) this.gone.add(v.asIndirect());
  }

  /** Bookmarks to deleted pages go (one with children stays, without a target); /Count recomputed. */
  private outline(root: Obj) {
    const outlines = root.get("Outlines");
    if (!outlines.isDictionary()) return;
    const before = this.linksRemoved;
    this.pruneOutline(outlines, new Set(), 0);
    if (this.linksRemoved !== before) recountOutline(outlines, true);
  }

  private pruneOutline(parent: Obj, seen: Set<string>, depth: number) {
    if (depth > 64) return;
    const kids = outlineKids(parent, seen);
    const kept: Obj[] = [];
    let changed = false;
    for (const item of kids) {
      this.pruneOutline(item, seen, depth + 1);
      const dest = item.get("Dest");
      let away = !dest.isNull() && this.leadsAway(dest);
      if (!away && !item.get("A").isNull() && this.pruneAction(item.get("A")) === null) away = true;
      if (!away) {
        kept.push(item);
        continue;
      }
      this.linksRemoved++;
      this.bookmarksRemoved++;
      changed = true;
      if (!item.get("First").isNull()) {
        item.delete("Dest");
        item.delete("A");
        kept.push(item);
      } else this.leave(item);
    }
    if (changed) linkOutline(parent, kept);
  }

  /** The structure tree loses the deleted pages' content items and the elements left empty; the ParentTree their keys. */
  private structure(root: Obj) {
    const tree = root.get("StructTreeRoot");
    if (!tree.isDictionary()) return;
    const keys = new Set<number>();
    for (const num of this.gonePages) {
      const sp = this.doc.newIndirect(num).get("StructParents");
      if (sp.isNumber()) keys.add(sp.asNumber());
    }
    for (const a of this.goneAnnots) {
      const sp = a.get("StructParent");
      if (sp.isNumber()) keys.add(sp.asNumber());
    }
    if (keys.size) pruneTree(tree.get("ParentTree"), "Nums", (k) => k.isNumber() && keys.has(k.asNumber()));
    this.pruneElement(tree, null, new Set(), 0, true);
  }

  /** Whether the element keeps any content after its items of deleted pages left; `page`: the /Pg it inherits. */
  private pruneElement(e: Obj, page: number | null, seen: Set<string>, depth: number, isRoot = false): boolean {
    const own = e.get("Pg");
    const pg = own.isIndirect() ? own.asIndirect() : page;
    const k = e.get("K");
    const ownGone = own.isIndirect() && this.gonePages.has(own.asIndirect());
    if (k.isNull()) {
      if (ownGone && !isRoot) this.leave(e);
      return !ownGone;
    }
    const list = k.isArray() ? items(k) : [k];
    const keep = list.map((item) => this.keepItem(item, pg, seen, depth));
    if (keep.some((x) => !x)) {
      if (k.isArray()) {
        for (let i = keep.length - 1; i >= 0; i--) if (!keep[i]) k.delete(i);
      } else e.delete("K");
    }
    if (!keep.some(Boolean) && !isRoot) {
      this.leave(e);
      return false;
    }
    if (ownGone) e.delete("Pg"); // what it still holds is on other pages, which say so themselves
    return true;
  }

  private keepItem(item: Obj, page: number | null, seen: Set<string>, depth: number): boolean {
    /** The item is on a deleted page: its own /Pg, else the one of its element. */
    const goneAt = (pg: Obj | null) => {
      const num = pg?.isIndirect() ? pg.asIndirect() : page;
      return num !== null && this.gonePages.has(num);
    };
    if (item.isNumber()) return !goneAt(null); // an MCID, on the element's page
    if (!item.isDictionary()) return true;
    const type = nameOf(item.get("Type"));
    if (type === "MCR") return !goneAt(item.get("Pg"));
    if (type === "OBJR") {
      const o = item.get("Obj");
      if (o.isIndirect() && (this.gone.has(o.asIndirect()) || this.gonePages.has(o.asIndirect()))) return false;
      return !goneAt(item.get("Pg"));
    }
    if (seen.has(keyOf(item)) || depth > 256) return true;
    seen.add(keyOf(item));
    return this.pruneElement(item, page, seen, depth + 1);
  }

  /** Article thread beads on deleted pages leave their threads; a thread left without beads goes. */
  private threads(root: Obj) {
    const threads = root.get("Threads");
    if (!threads.isArray()) return;
    for (let t = threads.length - 1; t >= 0; t--) {
      const thread = threads.get(t);
      const beads: Obj[] = [];
      const seen = new Set<string>();
      for (let b = thread.isDictionary() ? thread.get("F") : thread; b.isDictionary() && !seen.has(keyOf(b)) && beads.length < 100_000; b = b.get("N")) {
        seen.add(keyOf(b));
        beads.push(b);
      }
      const kept = beads.filter((b) => !(b.get("P").isIndirect() && this.gonePages.has(b.get("P").asIndirect())));
      if (kept.length === beads.length) continue;
      const stays = new Set(kept);
      for (const b of beads) if (!stays.has(b)) this.leave(b);
      if (!kept.length) {
        threads.delete(t);
        this.leave(thread);
        continue;
      }
      kept.forEach((b, i) => {
        b.put("N", kept[(i + 1) % kept.length]);
        b.put("V", kept[(i + kept.length - 1) % kept.length]);
      });
      thread.put("F", kept[0]);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Copies of pages in the same document

/** Copies of `pages`, inserted together at `at`, in that order (header: "Copy"). */
export function duplicatePages(mupdf: MuPDFModule, doc: Doc, pages: number[], at: number): PagesOutcome {
  const objs = pageObjects(doc);
  const list = checkPages(pages, objs.length);
  checkAt(at, objs.length);
  const labels = readLabels(doc);
  pinNumberedDestinations(doc, objs); // before the copies are made: they lead where the originals do
  const copier = new Duplicator(doc);
  const originals = list.map((i) => objs[i]);
  const copies = originals.map((o) => copier.page(o));
  writePageTree(doc, spliced(objs, at, copies));
  originals.forEach((o, k) => copier.annotations(o, copies[k]));
  copier.relate();
  const renamed = copier.finishFields();
  writeLabels(doc, labelsAfterInsert(labels, at, list.length));
  formChanged(doc);
  hidePasswords(mupdf, doc);
  return { report: { linksRemoved: 0, fieldsRenamed: renamed, signaturesAdded: 0 } };
}

/** Page keys a copy takes as they are (direct values copied), besides the inherited ones, /Contents and /Annots. */
const COPIED_PAGE_KEYS = ["BleedBox", "TrimBox", "ArtBox", "BoxColorInfo", "UserUnit", "Tabs", "Group", "VP", "Dur", "Trans", "AA"];

class Duplicator {
  /** Field dictionaries copied in this operation, by original (widgets of one field on several copied pages share one copy). */
  private readonly fieldCopies = new Map<string, Obj>();
  private readonly tops: Obj[] = [];
  /** Annotations copied in this operation, by original, and the pairs (original, copy) in order. */
  private readonly annotCopies = new Map<string, Obj>();
  private readonly pairs: [Obj, Obj][] = [];

  constructor(private readonly doc: Doc) {}

  /** A new page dictionary like `src` (not inserted yet, no annotations yet). */
  page(src: Obj): Obj {
    const doc = this.doc;
    const page = doc.newDictionary();
    page.put("Type", doc.newName("Page"));
    page.put("MediaBox", copyBox(doc, src.getInheritable("MediaBox")) ?? [0, 0, 612, 792]);
    const crop = copyBox(doc, src.getInheritable("CropBox"));
    if (crop) page.put("CropBox", crop);
    page.put("Rotate", rotationOf(src));
    page.put("Resources", copyResources(doc, src.getInheritable("Resources")));
    for (const key of COPIED_PAGE_KEYS) {
      const v = src.get(key);
      if (key.endsWith("Box")) {
        const box = copyBox(doc, v);
        if (box) page.put(key, box);
      } else if (!v.isNull()) page.put(key, copyDirect(doc, v));
    }
    const contents = src.get("Contents");
    if (contents.isArray()) {
      const arr = doc.newArray();
      for (const s of items(contents)) if (s.isStream()) arr.push(this.stream(s));
      page.put("Contents", arr);
    } else if (contents.isStream()) page.put("Contents", this.stream(contents));
    return doc.addObject(page);
  }

  /** A new stream with the same raw bytes and dictionary (a direct /Resources copied one level deep). */
  private stream(s: Obj): Obj {
    const doc = this.doc;
    const dict = doc.newDictionary();
    for (const [k, v] of entries(s)) {
      if (k === "Length") continue;
      dict.put(k, k === "Resources" && !v.isIndirect() ? copyResources(doc, v) : copyDirect(doc, v));
    }
    const raw = s.readRawStream();
    try {
      return doc.addRawStream(raw, dict);
    } finally {
      raw.destroy();
    }
  }

  /** An appearance (/AP): dictionaries copied, streams copied. */
  private appearance(ap: Obj, depth = 0): Obj {
    if (ap.isStream()) return this.stream(ap);
    if (ap.isDictionary() && depth < 4) {
      const out = this.doc.newDictionary();
      for (const [k, v] of entries(ap)) out.put(k, this.appearance(v, depth + 1));
      return out;
    }
    return copyDirect(this.doc, ap);
  }

  /** The annotations of `src` copied onto `copy` (relate() then pairs them, once every page is copied). */
  annotations(src: Obj, copy: Obj) {
    const doc = this.doc;
    const list = items(src.get("Annots")).filter((a) => a.isDictionary());
    if (!list.length) return;
    const annots = doc.newArray();
    for (const a of list) {
      const n = doc.newDictionary();
      for (const [k, v] of entries(a)) {
        // (/Kids too: a widget is no parent; its copy must not name the original's kids.)
        if (k === "P" || k === "Popup" || k === "Parent" || k === "IRT" || k === "AP" || k === "StructParent" || k === "Kids") continue;
        n.put(k, copyDirect(doc, v));
      }
      if (!a.get("AP").isNull()) n.put("AP", this.appearance(a.get("AP")));
      n.put("P", copy);
      const obj = doc.addObject(n);
      this.annotCopies.set(keyOf(a), obj);
      this.pairs.push([a, obj]);
      annots.push(obj);
    }
    copy.put("Annots", annots);
  }

  /** Popups paired again, replies (/IRT) to a copied note to its copy (to another, to that one), widgets to their copied fields. */
  relate() {
    const copyOf = (o: Obj) => (o.isDictionary() ? this.annotCopies.get(keyOf(o)) : undefined);
    for (const [a, n] of this.pairs) {
      const popup = copyOf(a.get("Popup"));
      if (popup) n.put("Popup", popup);
      const irt = a.get("IRT");
      if (irt.isDictionary()) n.put("IRT", copyOf(irt) ?? irt);
      const parent = a.get("Parent");
      if (nameOf(a.get("Subtype")) === "Widget") {
        if (parent.isDictionary()) {
          const f = this.field(parent, 0);
          n.put("Parent", f);
          pushKid(this.doc, f, n);
        } else if (!a.get("T").isNull() || !a.get("FT").isNull()) {
          // A widget that is its own field.
          if (fieldTypeOf(a) === "signature") n.delete("V");
          this.tops.push(n);
          this.fieldCopies.set(keyOf(a), n);
        }
      } else {
        const markup = copyOf(parent); // a popup's markup annotation
        if (markup) n.put("Parent", markup);
      }
    }
  }

  /** A copy of a field dictionary and of its parents up to the top, as new fields (their /Kids: the copies only). */
  private field(f: Obj, depth: number): Obj {
    const done = this.fieldCopies.get(keyOf(f));
    if (done) return done;
    const doc = this.doc;
    const n = doc.newDictionary();
    for (const [k, v] of entries(f)) if (k !== "Kids" && k !== "Parent") n.put(k, copyDirect(doc, v));
    if (fieldTypeOf(f) === "signature") n.delete("V");
    n.put("Kids", doc.newArray());
    const obj = doc.addObject(n);
    this.fieldCopies.set(keyOf(f), obj);
    const parent = f.get("Parent");
    if (parent.isDictionary() && depth < 32) {
      const p = this.field(parent, depth + 1);
      obj.put("Parent", p);
      pushKid(doc, p, obj);
    } else this.tops.push(obj);
    return obj;
  }

  /** The copied top fields renamed "<name>_copia<k>" and added to the form (and to /CO beside their originals). Returns how many names changed. */
  finishFields(): number {
    if (!this.tops.length) return 0;
    const doc = this.doc;
    const acro = ensureAcroForm(doc);
    const used = topNames(doc);
    const renames = new Map<string, string>();
    let renamed = 0;
    for (const top of this.tops) {
      for (const node of namedLevel(top)) {
        const name = textOf(node.get("T"));
        if (name === null) continue;
        let fresh = renames.get(name);
        if (fresh === undefined) {
          let k = 1;
          do fresh = `${name}_copia${k++}`;
          while (used.has(fresh));
          used.add(fresh);
          renames.set(name, fresh);
          renamed++;
        }
        node.put("T", doc.newString(fresh));
      }
      acro.get("Fields").push(top);
    }
    const co = acro.get("CO");
    if (co.isArray()) {
      for (const original of items(co)) {
        const copy = original.isIndirect() ? this.fieldCopies.get(keyOf(original)) : undefined;
        if (copy) co.push(copy);
      }
    }
    return renamed;
  }
}

// ---------------------------------------------------------------------------------------------
// Pages of another PDF

/**
 * Pages of `source` (all, or those listed, in that order) inserted at `at`; `title` names the
 * bookmark that leads to them (null: none) (header: "Pages of another PDF"). `source` is only
 * read, never changed: the caller opened it (unencrypted, or authenticated) and destroys it.
 */
export function insertPages(mupdf: MuPDFModule, doc: Doc, source: Doc, pages: number[] | "all", at: number, title: string | null): PagesOutcome {
  const objs = pageObjects(doc);
  checkAt(at, objs.length);
  const srcObjs = pageObjects(source, "other PDF");
  if (!srcObjs.length) throw bad("The other PDF has no pages");
  const chosen = pages === "all" ? srcObjs.map((_, i) => i) : checkPages(pages, srcObjs.length);
  if (title !== null && typeof title !== "string") throw bad("A bookmark title is a string");
  const name = title === null ? null : title.replace(/[\r\n\t\u2028\u2029]+/g, " ").trim() || null;
  if (name !== null && [...name].length > MAX_TITLE_CHARS) throw bad(`A bookmark title holds at most ${MAX_TITLE_CHARS} characters`);
  const labels = readLabels(doc);
  pinNumberedDestinations(doc, objs); // the document's own (the source's: Importer.dest reads its numbers)
  const importer = new Importer(doc, source, srcObjs, chosen);
  let outcome: PagesOutcome;
  try {
    outcome = importer.run(objs, at, name);
  } finally {
    importer.destroy();
  }
  writeLabels(doc, labelsAfterInsert(labels, at, chosen.length));
  formChanged(doc);
  hidePasswords(mupdf, doc);
  // A source form with /NeedAppearances: the copied fields get real appearances from their values.
  for (const edit of importer.repaint) {
    try {
      applyFieldEdit(mupdf, doc, edit);
    } catch {
      // left with the appearance it came with
    }
  }
  formChanged(doc);
  return outcome;
}

/** Annotation keys the importer sets itself (or leaves out). */
const IMPORT_SKIPPED_KEYS = new Set(["P", "Popup", "Parent", "IRT", "StructParent", "Dest", "A", "AA", "Kids"]);
/** Page keys an added page takes besides the inherited ones, /Contents, /Annots and /AA. */
const IMPORTED_PAGE_KEYS = ["BoxColorInfo", "UserUnit", "Tabs", "Group", "VP", "Dur", "Trans"];
/** A dictionary MuPDF prints with /Type /OCG (not /OCMD). */
const OCG_TYPE = /\/Type\/OCG(?![\w#])/;

class Importer {
  private readonly gm: MuPDF.PDFGraftMap;
  private readonly srcCount: number;
  /** Source objects never grafted as they are: its pages and /Pages nodes, catalog, annotations, fields, document-level roots. */
  private readonly forbidden = new Set<number>();
  /** Source objects known to reach a forbidden one (true) or not (false). */
  private readonly reaching = new Map<number, boolean>();
  /** Source objects copied by hand (they reach a forbidden one), by number. */
  private readonly byHand = new Map<number, Obj>();
  private readonly busy = new Set<number>();
  /** Source layers (OCGs) met on the way: the ones the copied pages use. */
  private readonly ocgs = new Set<number>();
  /** Chosen source page object number → its new page. */
  private readonly pageMap = new Map<number, Obj>();
  private readonly annotMap = new Map<string, Obj>();
  private readonly fieldMap = new Map<string, Obj>();
  private readonly tops: Obj[] = [];
  private readonly widgets: Obj[] = [];
  private names: ((name: Obj) => Obj | null) | null = null;
  readonly report = noReport();
  /** Field edits that give the copied fields appearances from their values (a source with /NeedAppearances). */
  repaint: FieldEdit[] = [];

  constructor(private readonly doc: Doc, private readonly src: Doc, private readonly srcObjs: Obj[], private readonly chosen: number[]) {
    this.gm = doc.newGraftMap();
    this.srcCount = src.countObjects();
    const root = catalog(src);
    const forbid = (o: Obj) => {
      if (o.isIndirect()) this.forbidden.add(o.asIndirect());
    };
    forbid(src.getTrailer().get("Root"));
    for (const key of ["Pages", "AcroForm", "StructTreeRoot", "Outlines", "OCProperties", "Names", "Dests", "Threads", "Perms", "PageLabels"]) forbid(root.get(key));
    for (const page of srcObjs) {
      forbid(page);
      let node = page.get("Parent");
      for (let depth = 0; node.isDictionary() && depth < 64; depth++, node = node.get("Parent")) forbid(node);
      for (const a of items(page.get("Annots"))) forbid(a);
    }
    const fields = (list: Obj, seen: Set<string>, depth: number) => {
      for (const f of items(list)) {
        if (!f.isDictionary() || depth > 32 || seen.has(keyOf(f))) continue;
        seen.add(keyOf(f));
        forbid(f);
        fields(f.get("Kids"), seen, depth + 1);
      }
    };
    fields(lookup(root, "AcroForm", "Fields"), new Set(), 0);
  }

  destroy() {
    this.gm.destroy();
  }

  /** Adds the chosen pages before page `at` of the document, whose pages are `objs`. */
  run(objs: Obj[], at: number, title: string | null): PagesOutcome {
    const doc = this.doc;
    // The pages first, without annotations, so that every destination finds the page it names.
    const added = this.chosen.map((i) => {
      const page = this.page(this.srcObjs[i]);
      this.pageMap.set(this.srcObjs[i].asIndirect(), page);
      return page;
    });
    writePageTree(doc, spliced(objs, at, added));
    const pairs: [Obj, Obj][] = [];
    this.chosen.forEach((i, k) => {
      const src = this.srcObjs[i];
      const aa = this.actions(src.get("AA"));
      if (aa) added[k].put("AA", aa);
      const annots = doc.newArray();
      for (const a of items(src.get("Annots"))) {
        if (!a.isDictionary() || this.annotMap.has(keyOf(a))) continue;
        const n = this.annotation(a, added[k]);
        if (!n) continue;
        this.annotMap.set(keyOf(a), n);
        pairs.push([a, n]);
        annots.push(n);
      }
      if (annots.length) added[k].put("Annots", annots);
    });
    // Popups, replies and fields, once every annotation has its copy.
    for (const [a, n] of pairs) this.relate(a, n);
    this.form();
    const layers = this.layers();
    if (title !== null) this.bookmark(title, added, at);
    return { report: this.report, layers };
  }

  // ------------------------------------------------------------------ copying values

  /**
   * A copy of a source value in the document, or null when the value is a forbidden object
   * itself. Copied through the graft map (so shared objects are copied once) when nothing it
   * reaches is forbidden; otherwise piece by piece, the references to forbidden objects cut (left
   * out of dictionaries, null in arrays).
   */
  private copy(v: Obj): Obj | null {
    if (v.isNull()) return null;
    if (v.isIndirect()) {
      const n = v.asIndirect();
      if (this.forbidden.has(n)) return null;
      if (!this.reaches([n])) return this.gm.graftObject(v);
      return this.byHandIndirect(v);
    }
    if (!v.isDictionary() && !v.isArray()) return this.gm.graftObject(v);
    if (!this.reaches(refsIn(v.toString()))) return this.gm.graftObject(v);
    if (v.isArray()) {
      const out = this.doc.newArray();
      for (const x of items(v)) out.push(this.copy(x));
      return out;
    }
    const out = this.doc.newDictionary();
    for (const [k, x] of entries(v)) {
      const c = this.copy(x);
      if (c) out.put(k, c);
    }
    return out;
  }

  private byHandIndirect(v: Obj): Obj | null {
    const n = v.asIndirect();
    const done = this.byHand.get(n);
    if (done) return done;
    const doc = this.doc;
    if (v.isStream()) {
      if (this.busy.has(n)) return null;
      this.busy.add(n);
      try {
        const dict = doc.newDictionary();
        for (const [k, x] of entries(v)) {
          if (k === "Length") continue;
          const c = this.copy(x);
          if (c) dict.put(k, c);
        }
        const raw = v.readRawStream();
        try {
          const s = doc.addRawStream(raw, dict);
          this.byHand.set(n, s);
          return s;
        } finally {
          raw.destroy();
        }
      } finally {
        this.busy.delete(n);
      }
    }
    if (v.isArray()) {
      const out = doc.addObject(doc.newArray());
      this.byHand.set(n, out);
      for (const x of items(v)) out.push(this.copy(x));
      return out;
    }
    if (v.isDictionary()) {
      const out = doc.addObject(doc.newDictionary());
      this.byHand.set(n, out);
      for (const [k, x] of entries(v)) {
        const c = this.copy(x);
        if (c) out.put(k, c);
      }
      return out;
    }
    return this.gm.graftObject(v);
  }

  /**
   * Whether any of these source objects reaches a forbidden one (a depth-first walk over MuPDF's
   * printing of each object). Remembered soundly: when a forbidden object is found, for the
   * objects on the path to it; when none is, for every object the walk saw.
   */
  private reaches(start: number[]): boolean {
    const visited: number[] = [];
    const local = new Set<number>();
    const stack: { num: number; refs: number[]; at: number }[] = [];
    const open = (n: number): "forbidden" | "known" | "new" => {
      if (this.forbidden.has(n) || this.reaching.get(n) === true) return "forbidden";
      if (this.reaching.get(n) === false || local.has(n)) return "known";
      local.add(n);
      visited.push(n);
      return "new";
    };
    for (const first of start) {
      const r = open(first);
      if (r === "forbidden") return true;
      if (r === "known") continue;
      stack.push({ num: first, refs: this.refsOf(first), at: 0 });
      while (stack.length) {
        const top = stack[stack.length - 1];
        if (top.at >= top.refs.length) {
          stack.pop();
          continue;
        }
        const n = top.refs[top.at++];
        const s = open(n);
        if (s === "forbidden") {
          for (const f of stack) this.reaching.set(f.num, true);
          return true;
        }
        if (s === "new") stack.push({ num: n, refs: this.refsOf(n), at: 0 });
      }
    }
    for (const n of visited) this.reaching.set(n, false);
    return false;
  }

  /** The objects a source object refers to; a layer is noted on the way. */
  private refsOf(n: number): number[] {
    if (n <= 0 || n >= this.srcCount) return [];
    const text = this.src.newIndirect(n).resolve().toString();
    if (OCG_TYPE.test(text)) this.ocgs.add(n);
    return refsIn(text);
  }

  // ------------------------------------------------------------------ pages, annotations, actions

  /** A new page dictionary with what the source page shows (no annotations yet). */
  private page(src: Obj): Obj {
    const doc = this.doc;
    const page = doc.newDictionary();
    page.put("Type", doc.newName("Page"));
    page.put("MediaBox", copyBox(doc, src.getInheritable("MediaBox")) ?? [0, 0, 612, 792]);
    const crop = copyBox(doc, src.getInheritable("CropBox"));
    if (crop) page.put("CropBox", crop);
    page.put("Rotate", rotationOf(src));
    const res = src.getInheritable("Resources");
    page.put("Resources", (res.isNull() ? null : this.copy(res)) ?? doc.newDictionary());
    for (const key of ["BleedBox", "TrimBox", "ArtBox"]) {
      const box = copyBox(doc, src.get(key));
      if (box) page.put(key, box);
    }
    for (const key of IMPORTED_PAGE_KEYS) {
      const v = src.get(key);
      const c = v.isNull() ? null : this.copy(v);
      if (c) page.put(key, c);
    }
    const contents = src.get("Contents");
    const c = contents.isNull() ? null : this.copy(contents);
    if (c) page.put("Contents", c);
    return doc.addObject(page);
  }

  /** A copy of an annotation on `page`, or null for a link whose target was not added (counted). */
  private annotation(a: Obj, page: Obj): Obj | null {
    const doc = this.doc;
    const link = nameOf(a.get("Subtype")) === "Link";
    // Where it leads, decided first.
    let dest: Obj | null = null, action: Obj | null = null;
    const d = a.get("Dest");
    if (!d.isNull()) {
      dest = this.dest(d);
      if (!dest) {
        this.report.linksRemoved++;
        if (link) return null;
      }
    }
    const act = a.get("A");
    if (!act.isNull()) {
      action = this.action(act);
      if (!action) {
        this.report.linksRemoved++;
        if (link) return null;
      }
    }
    const n = doc.newDictionary();
    for (const [k, v] of entries(a)) {
      if (IMPORT_SKIPPED_KEYS.has(k)) continue;
      const c = this.copy(v);
      if (c) n.put(k, c);
    }
    if (dest) n.put("Dest", dest);
    if (action) n.put("A", action);
    const aa = this.actions(a.get("AA"));
    if (aa) n.put("AA", aa);
    n.put("P", page);
    return doc.addObject(n);
  }

  /** Popup pairs, replies (/IRT, cut when the note it answers was not added) and the field of a widget. */
  private relate(a: Obj, n: Obj) {
    const popup = a.get("Popup");
    const p = popup.isDictionary() ? this.annotMap.get(keyOf(popup)) : undefined;
    if (p) n.put("Popup", p);
    const irt = a.get("IRT");
    const r = irt.isDictionary() ? this.annotMap.get(keyOf(irt)) : undefined;
    if (r) n.put("IRT", r);
    const parent = a.get("Parent");
    if (nameOf(a.get("Subtype")) === "Widget") {
      this.widgets.push(n);
      if (parent.isDictionary()) {
        const f = this.field(parent, 0);
        n.put("Parent", f);
        pushKid(this.doc, f, n);
      } else if (!a.get("T").isNull() || !a.get("FT").isNull()) {
        this.tops.push(n); // a widget that is its own field
        this.fieldMap.set(keyOf(a), n);
      }
    } else if (parent.isDictionary()) {
      const m = this.annotMap.get(keyOf(parent)); // a popup's markup annotation
      if (m) n.put("Parent", m);
    }
  }

  /** A copy of a field and its parents up to the top (their /Kids: the copies only). */
  private field(f: Obj, depth: number): Obj {
    const done = this.fieldMap.get(keyOf(f));
    if (done) return done;
    const doc = this.doc;
    const n = doc.addObject(doc.newDictionary());
    this.fieldMap.set(keyOf(f), n);
    for (const [k, v] of entries(f)) {
      if (k === "Kids" || k === "Parent") continue;
      const c = k === "AA" ? this.actions(v) : this.copy(v);
      if (c) n.put(k, c);
    }
    n.put("Kids", doc.newArray());
    const parent = f.get("Parent");
    if (parent.isDictionary() && depth < 32) {
      const p = this.field(parent, depth + 1);
      n.put("Parent", p);
      pushKid(doc, p, n);
    } else this.tops.push(n);
    return n;
  }

  /** A source destination as an explicit one to the page's copy, or null when it does not lead to an added page. */
  private dest(d: Obj, depth = 0): Obj | null {
    if (d.isNull() || depth > 8) return null;
    if (d.isString() || d.isName()) {
      this.names ??= namedDestinations(this.src);
      const v = this.names(d);
      return v ? this.dest(v, depth + 1) : null;
    }
    if (d.isDictionary()) return this.dest(d.get("D"), depth + 1);
    if (!d.isArray() || d.length === 0) return null;
    const first = d.get(0);
    const srcPage = first.isIndirect() ? first : first.isInteger() ? this.srcObjs[first.asNumber()] : undefined;
    const page = srcPage?.isIndirect() ? this.pageMap.get(srcPage.asIndirect()) : undefined;
    if (!page) return null;
    const out = this.doc.newArray();
    out.push(page);
    for (let i = 1; i < d.length; i++) {
      const v = d.get(i);
      out.push(v.isNumber() || v.isName() ? this.copy(v) : null);
    }
    return out;
  }

  /**
   * A copy of an action, or null when it goes: a GoTo to a page not added; Thread, Rendition,
   * Movie and 3D view actions (they name objects of pages of their own); Hide, SubmitForm and
   * ResetForm that named fields or annotations only by reference (an empty list would mean every
   * field). Its /Next chain keeps the actions that stay.
   */
  private action(a: Obj, depth = 0): Obj | null {
    if (!a.isDictionary() || depth > 16) return null;
    const doc = this.doc;
    const kind = nameOf(a.get("S"));
    let head: Obj | null = null;
    switch (kind) {
      case "GoTo": {
        const d = this.dest(a.get("D"));
        if (d) {
          head = doc.newDictionary();
          head.put("S", doc.newName("GoTo"));
          head.put("D", d);
        }
        break;
      }
      case "Thread":
      case "Rendition":
      case "Movie":
      case "GoTo3DView":
        break;
      case "Hide":
      case "SubmitForm":
      case "ResetForm": {
        const key = kind === "Hide" ? "T" : "Fields";
        const list = a.get(key);
        const named = (list.isArray() ? items(list) : list.isNull() ? [] : [list]).filter((x) => x.isString());
        const had = list.isArray() ? list.length : list.isNull() ? 0 : 1;
        if (had > 0 && named.length === 0) break;
        head = this.plainAction(a, key);
        if (had > 0) {
          const arr = doc.newArray();
          for (const s of named) arr.push(this.copy(s));
          head.put(key, arr);
        }
        break;
      }
      default:
        head = this.plainAction(a, null);
    }
    if (!head) return null;
    const next = a.get("Next");
    const chain = (next.isArray() ? items(next) : next.isDictionary() ? [next] : [])
      .map((x) => this.action(x, depth + 1))
      .filter((x): x is Obj => x !== null);
    if (chain.length === 1) head.put("Next", chain[0]);
    else if (chain.length > 1) {
      const arr = doc.newArray();
      for (const c of chain) arr.push(c);
      head.put("Next", arr);
    }
    return head;
  }

  private plainAction(a: Obj, skip: string | null): Obj {
    const out = this.doc.newDictionary();
    for (const [k, v] of entries(a)) {
      if (k === "Next" || k === skip) continue;
      const c = this.copy(v);
      if (c) out.put(k, c);
    }
    return out;
  }

  /** A copy of an /AA dictionary with the actions that stay, or null when none does. */
  private actions(aa: Obj): Obj | null {
    if (!aa.isDictionary()) return null;
    const out = this.doc.newDictionary();
    let any = false;
    for (const [k, v] of entries(aa)) {
      const c = this.action(v);
      if (!c) continue;
      out.put(k, c);
      any = true;
    }
    return any ? out : null;
  }

  // ------------------------------------------------------------------ the form

  /** The copied top fields join the form, renamed on a clash; /DR, /DA, /Q, /CO, signatures, XFA, NeedAppearances. */
  private form() {
    if (!this.tops.length) return;
    const doc = this.doc;
    const root = catalog(doc);
    const srcAcro = lookup(catalog(this.src), "AcroForm");
    const hadFields = items(lookup(root, "AcroForm", "Fields")).length > 0;
    const acro = ensureAcroForm(doc);
    // A static XFA part would not know the new fields (forms.ts drops it on a field edit too).
    const needsRendering = root.get("NeedsRendering");
    if (hadFields && !acro.get("XFA").isNull() && !(needsRendering.isBoolean() && needsRendering.asBoolean())) acro.delete("XFA");
    const fonts = this.mergeResources(srcAcro, acro);
    const srcDa = lookup(srcAcro, "DA");
    const da = srcDa.isString() ? renameFonts(srcDa.asString(), fonts) : null;
    const q = lookup(srcAcro, "Q");
    const used = topNames(doc);
    const renames = new Map<string, string>();
    for (const top of new Set(this.tops)) {
      for (const node of namedLevel(top)) {
        const name = textOf(node.get("T"));
        if (name === null) continue;
        let fresh = renames.get(name);
        if (fresh === undefined) {
          fresh = name;
          if (used.has(name)) {
            let k = 2;
            while (used.has(`${name}_${k}`)) k++;
            fresh = `${name}_${k}`;
            this.report.fieldsRenamed++;
          }
          used.add(fresh);
          renames.set(name, fresh);
        }
        if (fresh !== name) node.put("T", doc.newString(fresh));
      }
      if (da !== null && top.get("DA").isNull()) top.put("DA", doc.newString(da));
      if (q.isNumber() && top.get("Q").isNull()) top.put("Q", q.asNumber());
      acro.get("Fields").push(top);
    }
    if (fonts.size) {
      for (const o of [...this.fieldMap.values(), ...this.widgets]) {
        const s = o.get("DA");
        if (!s.isString()) continue;
        const t = renameFonts(s.asString(), fonts);
        if (t !== s.asString()) o.put("DA", doc.newString(t));
      }
    }
    for (const f of items(lookup(srcAcro, "CO"))) {
      const copy = this.fieldMap.get(keyOf(f));
      if (copy) pushOnce(doc, acro, "CO", copy);
    }
    let signed = 0;
    for (const o of this.fieldMap.values()) if (fieldTypeOf(o) === "signature" && o.get("V").isDictionary()) signed++;
    this.report.signaturesAdded = signed;
    if (signed) {
      const flags = acro.get("SigFlags");
      acro.put("SigFlags", (flags.isNumber() ? flags.asNumber() : 0) | 1);
    }
    const need = lookup(srcAcro, "NeedAppearances");
    if (need.isBoolean() && need.asBoolean()) this.repaint = this.repaintEdits();
  }

  /** The source form's /DR joins the document's: names it lacks are added; a font name it uses for another font gets a new name (returned: old → new). */
  private mergeResources(srcAcro: Obj, acro: Obj): Map<string, string> {
    const renames = new Map<string, string>();
    const sdr = lookup(srcAcro, "DR");
    if (!sdr.isDictionary()) return renames;
    const doc = this.doc;
    let dr = acro.get("DR");
    if (!dr.isDictionary()) {
      dr = doc.newDictionary();
      acro.put("DR", dr);
    }
    for (const [kind, sdict] of entries(sdr)) {
      if (!sdict.isDictionary()) continue;
      let dict = dr.get(kind);
      if (!dict.isDictionary()) {
        dict = doc.newDictionary();
        dr.put(kind, dict);
      }
      for (const [name, res] of entries(sdict)) {
        if (kind === "Font" && !res.isDictionary()) continue; // no font (entries already left out a null one)
        const mine = dict.get(name);
        if (mine.isNull()) {
          const c = this.copy(res);
          if (c) dict.put(name, c);
          continue;
        }
        if (kind !== "Font" || sameFont(mine, res)) continue;
        let k = 2;
        while (!dict.get(`${name}_${k}`).isNull()) k++;
        const c = this.copy(res);
        if (!c) continue;
        dict.put(`${name}_${k}`, c);
        renames.set(name, `${name}_${k}`);
      }
    }
    return renames;
  }

  /** Field edits with each copied text, combo and list field's own value (never a password or file-select field). */
  private repaintEdits(): FieldEdit[] {
    const out: FieldEdit[] = [];
    const seen = new Set<string>();
    for (const w of this.widgets) {
      const name = fullName(w);
      const type = fieldTypeOf(w);
      if (!name || seen.has(name) || !type || isPasswordField(w) || inheritedFlags(w) & FF_FILE_SELECT) continue;
      const value = currentValue(w, type);
      if (!value) continue;
      seen.add(name);
      out.push({ kind: "field", name, type, value, pageIndex: 0, pages: [] });
    }
    return out;
  }

  // ------------------------------------------------------------------ layers and the bookmark

  /** The layers the copied pages use join /OCProperties with the state they had in the source; returns how many. */
  private layers(): number {
    if (!this.ocgs.size) return 0;
    const doc = this.doc;
    const soc = lookup(catalog(this.src), "OCProperties");
    const sd = lookup(soc, "D"); // may be missing: every layer is then on
    const set = (key: string) => new Set(items(lookup(sd, key)).filter((o) => o.isIndirect()).map((o) => o.asIndirect()));
    const on = set("ON"), off = set("OFF"), locked = set("Locked");
    const srcBase = nameOf(lookup(sd, "BaseState")) ?? "ON";
    const listed = items(lookup(soc, "OCGs")).filter((o) => o.isIndirect()).map((o) => o.asIndirect());
    const order = [...new Set([...listed.filter((n) => this.ocgs.has(n)), ...this.ocgs])];
    const root = catalog(doc);
    let oc = root.get("OCProperties");
    const created = !oc.isDictionary();
    if (created) {
      oc = doc.addObject(doc.newDictionary());
      root.put("OCProperties", oc);
    }
    let groups = oc.get("OCGs");
    if (!groups.isArray()) {
      groups = doc.newArray();
      oc.put("OCGs", groups);
    }
    let d = oc.get("D");
    if (!d.isDictionary()) {
      d = doc.newDictionary();
      oc.put("D", d);
    }
    const base = nameOf(d.get("BaseState")) ?? "ON";
    const ordered = created || d.get("Order").isArray();
    const have = new Set(items(groups).filter((o) => o.isIndirect()).map((o) => o.asIndirect()));
    const mapped = new Map<number, Obj>();
    let added = 0;
    for (const n of order) {
      const g = this.gm.graftObject(this.src.newIndirect(n));
      mapped.set(n, g);
      if (have.has(g.asIndirect())) continue;
      have.add(g.asIndirect());
      groups.push(g);
      added++;
      const visible = srcBase === "OFF" ? on.has(n) : !off.has(n);
      if (visible && base === "OFF") pushOnce(doc, d, "ON", g);
      if (!visible && base !== "OFF") pushOnce(doc, d, "OFF", g);
      if (locked.has(n)) pushOnce(doc, d, "Locked", g);
      if (ordered) pushOnce(doc, d, "Order", g);
    }
    for (const group of items(lookup(sd, "RBGroups"))) {
      const members = items(group).filter((o) => o.isIndirect() && mapped.has(o.asIndirect()));
      if (!members.length) continue;
      const arr = doc.newArray();
      for (const m of members) arr.push(mapped.get(m.asIndirect())!);
      pushOnce(doc, d, "RBGroups", arr);
    }
    return added;
  }

  /** One bookmark `title` → the first added page, the source's bookmarks to added pages under it (closed), among the top ones in page order. */
  private bookmark(title: string, added: Obj[], at: number) {
    const doc = this.doc;
    const root = catalog(doc);
    let outlines = root.get("Outlines");
    if (!outlines.isDictionary()) {
      outlines = doc.addObject(doc.newDictionary());
      outlines.put("Type", doc.newName("Outlines"));
      root.put("Outlines", outlines);
    }
    const top = doc.addObject(doc.newDictionary());
    top.put("Title", doc.newString(title));
    const dest = doc.newArray();
    dest.push(added[0]);
    dest.push(doc.newName("Fit"));
    top.put("Dest", dest);
    const kids = this.outlineItems(lookup(catalog(this.src), "Outlines"), new Set(), 0);
    if (kids.length) {
      linkOutline(top, kids);
      top.put("Count", -1); // closed (recountOutline sets the number)
    }
    const index = new Map(pageObjectNumbers(doc).map((n, i) => [n, i]));
    const siblings = outlineKids(outlines, new Set());
    const names = lazyNamedDestinations(doc); // read once for every sibling
    let pos = siblings.findIndex((s) => (targetPage(s, index, names) ?? -1) >= at + added.length);
    if (pos < 0) pos = siblings.length;
    siblings.splice(pos, 0, top);
    linkOutline(outlines, siblings);
    recountOutline(outlines, true);
  }

  /** Copies of the source bookmarks under `parent` that lead to added pages, or hold some that do (or a web address...). */
  private outlineItems(parent: Obj, seen: Set<string>, depth: number): Obj[] {
    if (!parent.isDictionary() || depth > 64) return [];
    const doc = this.doc;
    const out: Obj[] = [];
    for (const item of outlineKids(parent, seen)) {
      const kids = this.outlineItems(item, seen, depth + 1);
      const d = item.get("Dest");
      const dest = d.isNull() ? null : this.dest(d);
      const a = item.get("A");
      const action = a.isNull() ? null : this.action(a);
      if (!dest && !action && !kids.length) continue;
      const n = doc.addObject(doc.newDictionary());
      n.put("Title", this.copy(item.get("Title")) ?? doc.newString(""));
      if (dest) n.put("Dest", dest);
      if (action) n.put("A", action);
      for (const key of ["C", "F"]) {
        const v = item.get(key);
        const c = v.isNull() ? null : this.copy(v);
        if (c) n.put(key, c);
      }
      if (kids.length) {
        linkOutline(n, kids);
        const count = item.get("Count");
        n.put("Count", count.isNumber() && count.asNumber() > 0 ? 1 : -1);
      }
      out.push(n);
    }
    return out;
  }
}

/**
 * The document's named destinations, looked up as PDF readers do: a name in the old /Root/Dests
 * dictionary first (PDF 1.1), a string in the /Dests name tree first (PDF 1.2), each falling back
 * to the other (MuPDF itself reads only the dictionary when there is one).
 */
function namedDestinations(doc: Doc): (name: Obj) => Obj | null {
  const root = catalog(doc);
  const tree = new Map<string, Obj>();
  eachLeaf(lookup(root, "Names", "Dests"), "Names", (k, v) => {
    const t = textOf(k);
    if (t !== null && !tree.has(t)) tree.set(t, v);
  });
  const dict = new Map(entries(root.get("Dests")));
  return (name) => {
    const t = textOf(name);
    if (t === null) return null;
    const [first, second] = name.isName() ? [dict, tree] : [tree, dict];
    return first.get(t) ?? second.get(t) ?? null;
  };
}

/** namedDestinations(doc), read the first time a name is looked up. */
function lazyNamedDestinations(doc: Doc): (name: Obj) => Obj | null {
  let names: ((name: Obj) => Obj | null) | null = null;
  return (name) => (names ??= namedDestinations(doc))(name);
}

/** The index of the page a bookmark leads to (explicit or named destination, GoTo action), or null; `index`: page object number → index. */
function targetPage(item: Obj, index: Map<number, number>, names: (name: Obj) => Obj | null): number | null {
  let d = item.get("Dest");
  if (d.isNull() && nameOf(lookup(item, "A", "S")) === "GoTo") d = lookup(item, "A", "D");
  for (let depth = 0; depth < 8 && !d.isNull(); depth++) {
    if (d.isString() || d.isName()) {
      const found = names(d);
      if (!found) return null;
      d = found;
    } else if (d.isDictionary()) d = d.get("D");
    else if (d.isArray() && d.length > 0 && d.get(0).isIndirect()) return index.get(d.get(0).asIndirect()) ?? null;
    else return null;
  }
  return null;
}

/** /Ff bit of a file-select text field. */
const FF_FILE_SELECT = 1 << 20;

/** A field's /Ff, its own or its nearest parent's. */
function inheritedFlags(o: Obj): number {
  let node = o;
  for (let depth = 0; node.isDictionary() && depth < 32; depth++, node = node.get("Parent")) {
    const ff = node.get("Ff");
    if (ff.isNumber()) return ff.asNumber();
  }
  return 0;
}

/** A field's /V, its own or its nearest parent's, or null. */
function inheritedValue(o: Obj): Obj | null {
  let node = o;
  for (let depth = 0; node.isDictionary() && depth < 32; depth++, node = node.get("Parent")) {
    const v = node.get("V");
    if (!v.isNull()) return v;
  }
  return null;
}

/** The value a field holds, as a field edit takes it (text, combo and list fields), or null. */
function currentValue(w: Obj, type: FieldType): FieldValue | null {
  const v = inheritedValue(w);
  const strings = (o: Obj | null) =>
    o === null ? [] : o.isArray() ? items(o).filter((x) => x.isString()).map((x) => x.asString()) : o.isString() ? [o.asString()] : [];
  switch (type) {
    case "text":
      if (v !== null && !v.isString()) return null; // a stream: kept as it is
      return { kind: "text", text: v === null ? "" : v.asString() };
    case "combo": {
      const values = strings(v);
      if (!values.length) return { kind: "choice", values: [] };
      let opt: Obj | null = null;
      let node = w;
      for (let depth = 0; node.isDictionary() && depth < 32 && !opt; depth++, node = node.get("Parent")) if (node.get("Opt").isArray()) opt = node.get("Opt");
      const exports = opt ? items(opt).map((x) => textOf(x.isArray() ? x.get(0) : x)) : [];
      return exports.includes(values[0]) ? { kind: "choice", values: [values[0]] } : { kind: "text", text: values[0] };
    }
    case "list":
      return { kind: "choice", values: strings(v) };
    default:
      return null;
  }
}

/** The same font in both forms: the same standard font (not embedded, no encoding of its own); never a value that is no dictionary. */
function sameFont(a: Obj, b: Obj): boolean {
  const signature = (f: Obj) => {
    if (!f.isDictionary()) return null;
    const enc = f.get("Encoding");
    const desc = f.get("FontDescriptor");
    if (enc.isDictionary() || (desc.isDictionary() && ["FontFile", "FontFile2", "FontFile3"].some((k) => !desc.get(k).isNull()))) return null;
    return [nameOf(f.get("Subtype")), nameOf(f.get("BaseFont")), nameOf(enc)].join("|");
  };
  const s = signature(a);
  return s !== null && s === signature(b);
}

const decodeName = (s: string) => s.replace(/#([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
const encodeName = (s: string) => s.replace(/[^!-~]|[#/()<>[\]{}%]/g, (c) => `#${c.charCodeAt(0).toString(16).padStart(2, "0")}`);

/** A /DA string with its font names renamed (the name before "size Tf"). */
function renameFonts(da: string, renames: Map<string, string>): string {
  if (!renames.size) return da;
  return da.replace(/\/([^\s/[\]()<>{}%]+)(\s+[-+]?(?:\d+\.?\d*|\.\d+)\s+Tf)/g, (all, name: string, rest: string) => {
    const fresh = renames.get(decodeName(name));
    return fresh === undefined ? all : `/${encodeName(fresh)}${rest}`;
  });
}
