// Page operations (release 4, engine/pages.ts) on the worker's mupdf build (1.27.0) in Node: move,
// delete, blank pages, copies, rotation, pages of another PDF and "keep only these", each on the
// rich fixture (tests/helpers/richPdf.ts: tags, links of every kind, notes and popups, a form with
// a field over two pages, bookmarks, labels i ii 1 2, a hidden layer, two /Pages nodes handing
// down MediaBox, Rotate and Resources) and the repo fixtures; then saved as a download is
// (session.ts's SAVE_OPTIONS), opened again and read with the app's own engine (lines, fields,
// edits). The clean delete is checked by searching the saved file for what was on the deleted
// page; the import by the objects and text it must not have brought in. The same operation on two
// copies of a document saves to the same bytes (a replay repeats it exactly). Fix round 1: null
// entries and values of the wrong kind wherever the operations walk (every operation on documents
// with nulls or numbers put everywhere: it works as without them, or refuses, never fails); the
// page tree written in one pass (a deep tree whose nodes hand down different things: every page
// shows what it showed); keepPages on a copy of another PDF, as the session logs an insert (the
// same result and report as from the whole file, nothing of the other pages in the copy); and
// long documents (no per-page MuPDF deletePage or insertPage, time linear in the pages). Fix round
// 2: destinations that name their page by number ([2 /Fit]) follow their page through every
// operation that numbers the pages again, and go with it (an insert through a kept copy then
// sends them where the whole file does, through the session too).
import { readFileSync, readdirSync } from "node:fs";
import * as mupdf from "mupdf";
import { describe, expect, it } from "vitest";
import { fullName } from "../src/engine/forms";
import {
  PagesError, deletePages, duplicatePages, insertBlankPages, insertPages, keepPages, movePages, pageObjectNumbers, rotatePages,
} from "../src/engine/pages";
import { EngineSession } from "../src/engine/session";
import { addStream, appEdited, formPdf, layersPdf, oldDestsPdf, openPdf, plainPdf, richPdf, saveBytes, smallPng } from "./helpers/richPdf";

type Doc = mupdf.PDFDocument;
type Obj = mupdf.PDFObject;

/** How a download is written (session.ts SAVE_OPTIONS): garbage collected, compressed, unencrypted. */
const SAVE_OPTIONS = "garbage=compact,compress=yes,encrypt=none";
const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

const RICH = richPdf();
const rich = () => openPdf(RICH);

// ---------------------------------------------------------------------------------------------
// Reading documents

function items(arr: Obj): Obj[] {
  const out: Obj[] = [];
  if (arr.isArray()) for (let i = 0; i < arr.length; i++) out.push(arr.get(i));
  return out;
}

const reopen = (doc: Doc) => openPdf(saveBytes(doc, SAVE_OPTIONS));

function eachPage<T>(doc: Doc, fn: (page: mupdf.PDFPage, i: number) => T): T[] {
  const out: T[] = [];
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.loadPage(i);
    try {
      out.push(fn(page, i));
    } finally {
      page.destroy();
    }
  }
  return out;
}

/** Every page's text, whitespace collapsed. */
const texts = (doc: Doc) =>
  eachPage(doc, (p) => {
    const st = p.toStructuredText();
    try {
      return st.asText().replace(/\s+/g, " ").trim();
    } finally {
      st.destroy();
    }
  });
const labels = (doc: Doc) => eachPage(doc, (p) => p.getLabel());
const bounds = (doc: Doc) => eachPage(doc, (p) => p.getBounds().map(Math.round));
/** The links of a page: the index of the page each leads to, or its web address. */
const links = (doc: Doc, i: number) => {
  const page = doc.loadPage(i);
  try {
    return page.getLinks().map((l) => (l.isExternal() ? l.getURI() : doc.resolveLink(l)));
  } finally {
    page.destroy();
  }
};
/** The bookmarks, flattened: "title->page" with the children in brackets. */
type OutlineItem = NonNullable<ReturnType<Doc["loadOutline"]>>[number];
function outline(doc: Doc): string[] {
  const flat = (o: OutlineItem): string => `${o.title}->${o.page ?? o.uri}` + (o.down?.length ? `[${o.down.map(flat).join(",")}]` : "");
  return (doc.loadOutline() ?? []).map(flat);
}
const root = (doc: Doc) => doc.getTrailer().get("Root");
const nameOf = (o: Obj) => (o.isName() ? o.asName() : null);

/** The annotation dictionaries of page `i` (a null or other value in /Annots left out). */
const annotsOf = (doc: Doc, i: number) => items(doc.findPage(i).get("Annots")).filter((a) => a.isDictionary());

/** Field full names with the pages of their widgets, read from the pages. */
function fieldPages(doc: Doc): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (let i = 0; i < doc.countPages(); i++)
    for (const a of annotsOf(doc, i)) if (nameOf(a.get("Subtype")) === "Widget") (out[fullName(a)] ??= []).push(i);
  return out;
}

/** Object numbers of the widgets the form's field tree reaches (from /Fields). */
function formWidgets(doc: Doc): Set<number> {
  const out = new Set<number>();
  const walk = (list: Obj, depth: number) => {
    for (const f of items(list)) {
      if (depth > 32 || !f.isDictionary()) continue;
      if (nameOf(f.get("Subtype")) === "Widget" && f.isIndirect()) out.add(f.asIndirect());
      walk(f.get("Kids"), depth + 1);
    }
  };
  const fields = root(doc).get("AcroForm");
  if (fields.isDictionary()) walk(fields.get("Fields"), 0);
  return out;
}

/** Every widget on the pages is in the field tree, and the other way round. */
function formIsWhole(doc: Doc) {
  const onPages = new Set<number>();
  for (let i = 0; i < doc.countPages(); i++)
    for (const a of annotsOf(doc, i)) if (nameOf(a.get("Subtype")) === "Widget") onPages.add(a.asIndirect());
  expect([...formWidgets(doc)].sort()).toEqual([...onPages].sort());
}

/** Keys of a name or number tree. */
function treeKeys(node: Obj, leaf: "Names" | "Nums"): (string | number)[] {
  const out: (string | number)[] = [];
  const walk = (n: Obj, depth: number) => {
    if (!n.isDictionary() || depth > 16) return;
    const arr = n.get(leaf);
    for (let i = 0; i + 1 < (arr.isArray() ? arr.length : 0); i += 2) out.push(leaf === "Names" ? arr.get(i).asString() : arr.get(i).asNumber());
    for (const k of items(n.get("Kids"))) walk(k, depth + 1);
  };
  walk(node, 0);
  return out;
}

/** The structure elements as "S@page" (page index, "?" when its /Pg is no page of the document, "-" without /Pg). */
function elements(doc: Doc): string[] {
  const index = new Map(pageObjectNumbers(doc).map((n, i) => [n, i]));
  const out: string[] = [];
  const walk = (k: Obj, depth: number) => {
    if (depth > 64) return;
    for (const e of k.isArray() ? items(k) : [k]) {
      if (!e.isDictionary() || e.get("S").isNull()) continue;
      const pg = e.get("Pg");
      out.push(`${nameOf(e.get("S"))}@${pg.isNull() ? "-" : index.get(pg.asIndirect()) ?? "?"}`);
      walk(e.get("K"), depth + 1);
    }
  };
  walk(root(doc).get("StructTreeRoot").get("K"), 0);
  return out;
}

/** How many objects of the saved file hold each text (decoded streams, and printed objects for strings). */
function found(bytes: Uint8Array, needles: string[]): Record<string, number> {
  const doc = openPdf(bytes);
  const out: Record<string, number> = Object.fromEntries(needles.map((n) => [n, 0]));
  for (let i = 1; i < doc.countObjects(); i++) {
    const ref = doc.newIndirect(i);
    let text = ref.resolve().toString();
    if (ref.isStream()) {
      const buf = ref.readStream();
      try {
        text += buf.asString();
      } finally {
        buf.destroy();
      }
    }
    for (const n of needles) if (text.includes(n)) out[n]++;
  }
  return out;
}

/** How many objects of the document print with this text (e.g. "/Type/Page/", "/Subtype/Image"). */
function countObjects(doc: Doc, pattern: RegExp): number {
  let n = 0;
  for (let i = 1; i < doc.countObjects(); i++) if (pattern.test(doc.newIndirect(i).resolve().toString())) n++;
  return n;
}

/** The app's engine on the bytes. */
function engine(bytes: Uint8Array): EngineSession {
  const s = new EngineSession(mupdf);
  const r = s.open(bytes);
  if (!r.ok) throw new Error(`the engine cannot open it: ${r.reason}`);
  return s;
}

const fieldValues = (s: EngineSession, page: number) => Object.fromEntries(s.fields(page).map((f) => [f.name, f.value]));

function refusal(fn: () => unknown): string | null {
  try {
    fn();
  } catch (err) {
    if (err instanceof PagesError) return err.code;
    throw err;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------

describe("the rich fixture", () => {
  it("is what the tests expect", () => {
    const d = rich();
    expect(texts(d)).toEqual(["Pagina 1 Segreto 1", "Pagina 2 Segreto 2", "Pagina 3 Segreto 3", "Pagina 4 Segreto 4"]);
    expect(labels(d)).toEqual(["i", "ii", "1", "2"]);
    expect(bounds(d)).toEqual([[0, 0, 595, 842], [0, 0, 595, 842], [0, 0, 800, 600], [0, 0, 800, 600]]);
    // Inherited from the /Pages nodes, not the pages' own.
    expect(d.findPage(2).get("MediaBox").isNull()).toBe(true);
    expect(d.findPage(2).get("Rotate").isNull()).toBe(true);
    expect(links(d, 0)).toEqual([2, 3, "https://example.org", 2, 1]);
    expect(outline(d)).toEqual(["Capitolo 1->0", "Capitolo 2->1", "Capitolo 3->2[Sezione 3.1->3]", "Sito->https://example.org", "Al p3 per nome->2"]);
    expect(fieldPages(d)).toEqual({ condiviso: [0, 2], vai: [0], nome: [1], accetto: [1], scelta: [1, 1], codice: [1], totale: [2] });
    formIsWhole(d);
    expect(elements(d)).toEqual(["Document@-", "P@0", "Span@0", "P@1", "Span@1", "P@2", "Span@2", "P@3", "Span@3", "Sect@2", "Link@0"]);
    const s = engine(RICH);
    expect(s.fields(1).map((f) => f.name)).toEqual(["nome", "accetto", "scelta", "scelta", "codice"]);
    s.close();
  });
});

describe("movePages", () => {
  it("refuses anything but a permutation of every page, and changes nothing then", () => {
    const d = rich();
    const before = pageObjectNumbers(d);
    for (const order of [[0, 1, 2], [0, 0, 1, 2], [0, 1, 2, 4], [0, 1.5, 2, 3], [-1, 0, 1, 2], "x", null])
      expect(refusal(() => movePages(mupdf, d, order as number[]))).toBe("bad-request");
    expect(pageObjectNumbers(d)).toEqual(before);
  });

  it("leaves the document as it is for the order it has", () => {
    const d = rich();
    movePages(mupdf, d, [0, 1, 2, 3]);
    expect(saveBytes(d, SAVE_OPTIONS)).toEqual(saveBytes(rich(), SAVE_OPTIONS));
  });

  it("moves the page objects themselves, each keeping its size, rotation, links, fields, tags and the labels by position", () => {
    const d = rich();
    const nums = pageObjectNumbers(d);
    const report = movePages(mupdf, d, [3, 0, 1, 2]).report;
    expect(report).toEqual({ linksRemoved: 0, fieldsRenamed: 0, signaturesAdded: 0 });
    expect(pageObjectNumbers(d)).toEqual([nums[3], nums[0], nums[1], nums[2]]);
    // No page took the size or rotation of the /Pages node it now sits under; the empty nodes went.
    expect(items(root(d).get("Pages").get("Kids")).map((k) => nameOf(k.get("Type")))).toEqual(["Page", "Page", "Page", "Page"]);
    // Each page has its own copy of what it inherited: a /Resources of its own, never the node's.
    for (let i = 0; i < 4; i++) {
      const p = d.findPage(i);
      expect(p.get("MediaBox").isArray()).toBe(true);
      expect(p.get("Resources").isDictionary()).toBe(true);
    }
    d.findPage(1).get("Resources").get("Font").put("FX", d.newName("Prova"));
    expect(d.findPage(2).get("Resources").get("Font").get("FX").isNull()).toBe(true);
    expect(d.findPage(3).get("Rotate").asNumber()).toBe(90);
    for (const r of [d, reopen(d)]) {
      expect(texts(r)).toEqual(["Pagina 4 Segreto 4", "Pagina 1 Segreto 1", "Pagina 2 Segreto 2", "Pagina 3 Segreto 3"]);
      expect(bounds(r)).toEqual([[0, 0, 800, 600], [0, 0, 595, 842], [0, 0, 595, 842], [0, 0, 800, 600]]);
      expect(labels(r)).toEqual(["i", "ii", "1", "2"]);
      expect(links(r, 1)).toEqual([3, 0, "https://example.org", 3, 2]);
      expect(outline(r)).toEqual(["Capitolo 1->1", "Capitolo 2->2", "Capitolo 3->3[Sezione 3.1->0]", "Sito->https://example.org", "Al p3 per nome->3"]);
      expect(fieldPages(r)).toEqual({ condiviso: [1, 3], vai: [1], nome: [2], accetto: [2], scelta: [2, 2], codice: [2], totale: [3] });
      expect(elements(r)).toEqual(["Document@-", "P@1", "Span@1", "P@2", "Span@2", "P@3", "Span@3", "P@0", "Span@0", "Sect@3", "Link@1"]);
    }
    // The hidden layer stays hidden, and the app's engine works on the moved pages.
    const s = engine(saveBytes(d, SAVE_OPTIONS));
    expect(s.lines(0).map((l) => l.text)).toEqual(["Pagina 4", "Segreto 4"]);
    s.setField("nome", { kind: "text", text: "Anna" });
    expect(fieldValues(s, 2).nome).toBe("Anna");
    const line = s.lines(3).findIndex((l) => l.text === "Pagina 3");
    s.replaceLine(3, line, "Pagina tre");
    expect(s.lines(3).map((l) => l.text)).toContain("Pagina tre");
    expect(s.pdfaCheck().blockers).toEqual([]);
    s.close();
  });

  it("reverses 120 pages quickly", () => {
    const d = openPdf(plainPdf(Array.from({ length: 120 }, (_, i) => `Pagina ${i + 1}`)));
    const t0 = performance.now();
    movePages(mupdf, d, Array.from({ length: 120 }, (_, i) => 119 - i));
    const ms = performance.now() - t0;
    console.log(`move: 120 pages reversed in ${ms.toFixed(1)} ms`);
    expect(texts(d)[0]).toBe("Pagina 120");
    expect(texts(d)[119]).toBe("Pagina 1");
  });
});

describe("deletePages", () => {
  it("refuses every page, repeated, missing or no pages", () => {
    const d = rich();
    for (const pages of [[0, 1, 2, 3], [1, 1], [4], [-1], [], [0.5], "x"]) expect(refusal(() => deletePages(mupdf, d, pages as number[]))).toBe("bad-request");
    expect(d.countPages()).toBe(4);
  });

  it("takes away everything that led to the page, and keeps what did not", () => {
    const d = rich();
    const report = deletePages(mupdf, d, [2]).report;
    // Two links (to page 3, and to /p3), a bookmark (Al p3 per nome) and Capitolo 3's target.
    expect(report).toEqual({ linksRemoved: 4, fieldsRenamed: 0, signaturesAdded: 0 });
    for (const r of [d, reopen(d)]) {
      expect(texts(r)).toEqual(["Pagina 1 Segreto 1", "Pagina 2 Segreto 2", "Pagina 4 Segreto 4"]);
      expect(labels(r)).toEqual(["i", "ii", "1"]);
      expect(links(r, 0)).toEqual([2, "https://example.org", 1]);
      expect(outline(r)).toEqual(["Capitolo 1->0", "Capitolo 2->1", "Capitolo 3->undefined[Sezione 3.1->2]", "Sito->https://example.org"]);
      expect(root(r).get("Outlines").get("Count").asNumber()).toBe(5);
      // Named destinations: /p3 went, its name tree leaf has its /Limits right.
      expect(treeKeys(root(r).get("Names").get("Dests"), "Names")).toEqual(["cap2", "cap4"]);
      expect(items(root(r).get("Names").get("Dests").get("Kids").get(0).get("Limits")).map((l) => l.asString())).toEqual(["cap2", "cap4"]);
      // The form: "totale" (only on page 3) went, from /CO too; "condiviso" kept its widget on page 1.
      expect(fieldPages(r)).toEqual({ condiviso: [0], vai: [0], nome: [1], accetto: [1], scelta: [1, 1], codice: [1] });
      formIsWhole(r);
      expect(items(root(r).get("AcroForm").get("CO"))).toEqual([]);
      // Actions that went there: the page's open action, the field's /AA.
      expect(r.findPage(1).get("AA").isNull()).toBe(true);
      expect(items(r.findPage(1).get("Annots")).some((a) => !a.get("AA").isNull())).toBe(false);
      // The tags: page 3's elements went, the Sect keeps page 4's content without /Pg, the
      // tagged link (to /p3) went with its OBJR; the ParentTree and the IDTree lost their keys.
      expect(elements(r)).toEqual(["Document@-", "P@0", "Span@0", "P@1", "Span@1", "P@2", "Span@2", "Sect@-"]);
      const st = root(r).get("StructTreeRoot");
      expect(treeKeys(st.get("ParentTree"), "Nums")).toEqual([0, 1, 3]);
      expect(treeKeys(st.get("IDTree"), "Names")).toEqual([]);
      // The article: one bead left, a ring of itself.
      const bead = items(root(r).get("Threads"))[0].get("F");
      expect(bead.get("N").asIndirect()).toBe(bead.asIndirect());
      expect(bead.get("P").asIndirect()).toBe(r.findPage(1).asIndirect());
      // Every page object of the file is a page of the document.
      expect(countObjects(r, /\/Type\/Page(?!s)/)).toBe(r === d ? countObjects(r, /\/Type\/Page(?!s)/) : 3);
    }
    const s = engine(saveBytes(d, SAVE_OPTIONS));
    s.setField("nome", { kind: "text", text: "Anna" });
    expect(fieldValues(s, 1).nome).toBe("Anna");
    expect(s.pdfaCheck().blockers).toEqual([]);
    s.close();
  });

  it("leaves nothing of the deleted page, or of what the user wrote on it, in a downloaded file", () => {
    const edited = appEdited(RICH);
    const secrets = ["Pagina 3", "Segreto 3", "Segreto campo", "Nota pagina 3", "Testo segreto pagina 3", "id-p3", "/PEText"];
    const before = found(edited, secrets);
    for (const s of secrets) expect(before[s], s).toBeGreaterThan(0);
    expect(before["/PEText"]).toBe(2); // "Mario Rossi" on page 2, "Via Segreta 7" on page 3
    const d = openPdf(edited);
    expect(countObjects(d, /\/Subtype\/Image/)).toBe(1); // the picture on page 3
    deletePages(mupdf, d, [2]);
    const bytes = saveBytes(d, SAVE_OPTIONS);
    const after = found(bytes, secrets);
    expect(after).toEqual({ ...Object.fromEntries(secrets.map((s) => [s, 0])), "/PEText": 1 });
    const saved = openPdf(bytes);
    expect(countObjects(saved, /\/Subtype\/Image/)).toBe(0);
    expect(countObjects(saved, /\/Type\/Page(?!s)/)).toBe(3);
    // What stays is the user's too: "Mario Rossi" on page 2 and the value of "nome".
    const s = engine(bytes);
    expect(s.addedTexts(1).map((t) => t.text)).toEqual(["Mario Rossi"]);
    expect(fieldValues(s, 1).nome).toBe("Mario");
    s.close();
  });

  it("removes the open action, a button's GoTo and the /Next of a link that led to the page", () => {
    const d = rich();
    // The link to cap4, the button's action, Sezione 3.1 (the Named link only loses its /Next: it stays).
    expect(deletePages(mupdf, d, [3]).report.linksRemoved).toBe(3);
    expect(root(d).get("OpenAction").isNull()).toBe(true);
    expect(treeKeys(root(d).get("Names").get("Dests"), "Names")).toEqual(["cap2", "p3"]);
    const annots = items(d.findPage(0).get("Annots"));
    const vai = annots.find((a) => fullName(a) === "vai")!;
    expect(vai.get("A").isNull()).toBe(true); // the button stays, without its action
    const named = annots.find((a) => nameOf(a.get("A", "S")) === "Named")!;
    expect(named.get("A").get("Next").isNull()).toBe(true);
    expect(outline(d)).toEqual(["Capitolo 1->0", "Capitolo 2->1", "Capitolo 3->2", "Sito->https://example.org", "Al p3 per nome->2"]);
    expect(root(d).get("Outlines").get("First").get("Next").get("Next").get("Count").isNull()).toBe(true);
  });

  it("cleans the old /Root/Dests dictionary", () => {
    const d = openPdf(oldDestsPdf());
    expect(links(d, 0)).toEqual([2]);
    expect(deletePages(mupdf, d, [2]).report.linksRemoved).toBe(2);
    expect(root(d).get("Dests").get("p3").isNull()).toBe(true);
    expect(root(d).get("Dests").get("p1").isNull()).toBe(false);
    expect(links(d, 0)).toEqual([]);
    expect(links(d, 1)).toEqual([0]);
    expect(outline(d)).toEqual([]);
  });

  it("shifts the labels as MuPDF does", () => {
    const labelled = () => {
      const d = openPdf(plainPdf(Array.from({ length: 10 }, (_, i) => `P${i}`)));
      d.setPageLabels(0, "r");
      d.setPageLabels(3, "D", "", 1);
      d.setPageLabels(7, "A", "App-", 1);
      return d;
    };
    for (const del of [[3], [3, 4, 5, 6], [0], [0, 1, 2], [9], [7, 8, 9], [2, 3, 8]]) {
      const ours = labelled();
      deletePages(mupdf, ours, del);
      const theirs = labelled();
      for (const i of [...del].sort((a, b) => b - a)) theirs.deletePage(i);
      expect(labels(ours), JSON.stringify(del)).toEqual(labels(theirs));
    }
  });

  it("keeps a page object the tree shows twice, and its fields", () => {
    const d = rich();
    d.insertPage(4, d.findPage(1)); // page 2's object again at the end
    deletePages(mupdf, d, [1]);
    expect(texts(d)).toEqual(["Pagina 1 Segreto 1", "Pagina 3 Segreto 3", "Pagina 4 Segreto 4", "Pagina 2 Segreto 2"]);
    expect(fieldPages(d).nome).toEqual([3]);
    expect(d.findPage(3).get("AA").isNull()).toBe(false);
  });

  it("is quick on 600 tagged pages", () => {
    const doc = new mupdf.PDFDocument();
    const helv = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica" });
    const st = doc.addObject({ Type: "StructTreeRoot" });
    const top = doc.addObject({ Type: "StructElem", S: "Document", P: st });
    const kids = doc.newArray(), nums = doc.newArray();
    for (let i = 0; i < 600; i++) {
      let c = "";
      for (let k = 0; k < 20; k++) c += `/P <</MCID ${k}>> BDC BT /F1 10 Tf 72 ${700 - k * 20} Td (Riga ${k}) Tj ET EMC\n`;
      const buf = new mupdf.Buffer(c);
      try {
        doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { Font: { F1: helv } }, buf));
      } finally {
        buf.destroy();
      }
      const pg = doc.findPage(i);
      pg.put("StructParents", i);
      const arr = doc.newArray();
      for (let k = 0; k < 20; k++) {
        const e = doc.addObject({ Type: "StructElem", S: "P", P: top, Pg: pg, K: k });
        kids.push(e);
        arr.push(e);
      }
      nums.push(i);
      nums.push(arr);
    }
    top.put("K", kids);
    st.put("K", top);
    st.put("ParentTree", doc.addObject({ Nums: nums }));
    doc.getTrailer().get("Root").put("StructTreeRoot", st);
    const d = openPdf(saveBytes(doc));
    const t0 = performance.now();
    deletePages(mupdf, d, [0, 299, 599]);
    const ms = performance.now() - t0;
    console.log(`delete: 3 of 600 tagged pages (${d.countObjects()} objects) in ${ms.toFixed(1)} ms`);
    expect(d.countPages()).toBe(597);
    expect(treeKeys(root(d).get("StructTreeRoot").get("ParentTree"), "Nums").length).toBe(597);
  });
});

describe("keepPages", () => {
  it("keeps only the pages given, in the document's order, cleanly", () => {
    const d = openPdf(appEdited(RICH));
    expect(keepPages(mupdf, d, [3, 0]).report.linksRemoved).toBe(5);
    expect(texts(d)).toEqual(["Pagina 1 Segreto 1", "Pagina 4 Segreto 4"]);
    expect(found(saveBytes(d, SAVE_OPTIONS), ["Pagina 2", "Pagina 3", "Mario Rossi", "Segreto campo"])).toEqual({ "Pagina 2": 0, "Pagina 3": 0, "Mario Rossi": 0, "Segreto campo": 0 });
  });

  it("changes nothing when every page is kept, and refuses repeated pages", () => {
    const d = rich();
    expect(keepPages(mupdf, d, [0, 1, 2, 3]).report.linksRemoved).toBe(0);
    expect(saveBytes(d, SAVE_OPTIONS)).toEqual(saveBytes(rich(), SAVE_OPTIONS));
    expect(refusal(() => keepPages(mupdf, d, [1, 1]))).toBe("bad-request");
  });
});

describe("insertBlankPages", () => {
  it("refuses a place or a size that cannot be", () => {
    const d = rich();
    expect(refusal(() => insertBlankPages(mupdf, d, -1, [[595, 842]]))).toBe("bad-request");
    expect(refusal(() => insertBlankPages(mupdf, d, 5, [[595, 842]]))).toBe("bad-request");
    expect(refusal(() => insertBlankPages(mupdf, d, 1.5, [[595, 842]]))).toBe("bad-request");
    for (const sizes of [[], [[0, 842]], [[595, Number.NaN]], [[20000, 842]], [[595]], "x"]) expect(refusal(() => insertBlankPages(mupdf, d, 0, sizes as [number, number][]))).toBe("bad-request");
    expect(d.countPages()).toBe(4);
  });

  it("makes no labels in a file without them (MuPDF would read 1 1 2)", () => {
    const d = openPdf(plainPdf(["Uno", "Due"]));
    insertBlankPages(mupdf, d, 0, [[300, 400]]);
    expect(root(d).get("PageLabels").isNull()).toBe(true);
    expect(labels(d)).toEqual(["", "", ""]);
    expect(texts(d)).toEqual(["", "Uno", "Due"]);
    expect(bounds(d)[0]).toEqual([0, 0, 300, 400]);
  });

  it("puts new pages in the range of the page before them, the first range when they go first", () => {
    const at = (where: number, n = 1) => {
      const d = rich();
      insertBlankPages(mupdf, d, where, Array.from({ length: n }, () => [595, 842] as [number, number]));
      return labels(reopen(d));
    };
    expect(at(0)).toEqual(["i", "ii", "iii", "1", "2"]);
    expect(at(2)).toEqual(["i", "ii", "iii", "1", "2"]);
    expect(at(3)).toEqual(["i", "ii", "1", "2", "3"]);
    expect(at(4)).toEqual(["i", "ii", "1", "2", "3"]);
    expect(at(1, 2)).toEqual(["i", "ii", "iii", "iv", "1", "2"]);
  });

  it("does not take the crop box or the rotation of the /Pages node it lands under", () => {
    const d = rich();
    root(d).get("Pages").get("Kids").get(1).put("CropBox", [10, 10, 300, 300]); // the node of pages 3-4 (Rotate 90)
    insertBlankPages(mupdf, d, 3, [[200, 100]]);
    expect(bounds(d)[3]).toEqual([0, 0, 200, 100]);
    const s = engine(saveBytes(d, SAVE_OPTIONS));
    s.addText(3, [20, 50], "Sulla pagina nuova", { size: 12, color: [0, 0, 0], family: "sans", bold: false, italic: false });
    expect(s.lines(3).map((l) => l.text)).toEqual(["Sulla pagina nuova"]);
    // A picture over the whole new page (what the session does for a scanned page), on a tagged document.
    const placed = s.addImage(smallPng(), [{ pageIndex: 3, matrix: [200, 0, 0, 100, 0, 0] }], "Pagina scansionata").placed;
    expect(placed).toEqual([{ pageIndex: 3, imageIndex: 0 }]);
    expect(s.images(3)[0]).toMatchObject({ added: true, movable: true, bbox: [0, 0, 200, 100] });
    s.close();
  });
});

describe("rotatePages", () => {
  it("refuses an angle or pages that cannot be", () => {
    const d = rich();
    expect(refusal(() => rotatePages(mupdf, d, [0], 45 as 90))).toBe("bad-request");
    expect(refusal(() => rotatePages(mupdf, d, [0, 0], 90))).toBe("bad-request");
    expect(refusal(() => rotatePages(mupdf, d, [], 90))).toBe("bad-request");
  });

  it("turns the page's own /Rotate, after what it inherits", () => {
    const d = rich();
    rotatePages(mupdf, d, [2], 90);
    rotatePages(mupdf, d, [0], 270);
    expect(d.findPage(2).get("Rotate").asNumber()).toBe(180);
    expect(d.findPage(3).get("Rotate").isNull()).toBe(true);
    expect(bounds(d)).toEqual([[0, 0, 842, 595], [0, 0, 595, 842], [0, 0, 600, 800], [0, 0, 800, 600]]);
    for (let k = 0; k < 4; k++) rotatePages(mupdf, d, [1], 90);
    expect(d.findPage(1).get("Rotate").asNumber()).toBe(0);
    const s = engine(saveBytes(d, SAVE_OPTIONS));
    expect(s.lines(2).map((l) => l.text)).toEqual(["Pagina 3", "Segreto 3"]);
    s.close();
  });
});

describe("duplicatePages", () => {
  it("refuses repeated pages or a place that cannot be", () => {
    const d = rich();
    expect(refusal(() => duplicatePages(mupdf, d, [1, 1], 2))).toBe("bad-request");
    expect(refusal(() => duplicatePages(mupdf, d, [1], 5))).toBe("bad-request");
    expect(d.countPages()).toBe(4);
  });

  it("makes a new page: content copied, resources shared, fields copied and renamed", () => {
    const d = rich();
    const report = duplicatePages(mupdf, d, [1], 2).report;
    expect(report.fieldsRenamed).toBe(4);
    const [orig, copy] = [d.findPage(1), d.findPage(2)];
    expect(copy.asIndirect()).not.toBe(orig.asIndirect());
    expect(copy.get("Contents").asIndirect()).not.toBe(orig.get("Contents").asIndirect());
    expect(copy.get("Resources").get("Font").get("F1").asIndirect()).toBe(orig.getInheritable("Resources").get("Font").get("F1").asIndirect());
    expect(copy.get("StructParents").isNull()).toBe(true);
    for (const a of items(copy.get("Annots"))) expect(a.get("P").asIndirect()).toBe(copy.asIndirect());
    for (const r of [d, reopen(d)]) {
      expect(texts(r)).toEqual(["Pagina 1 Segreto 1", "Pagina 2 Segreto 2", "Pagina 2 Segreto 2", "Pagina 3 Segreto 3", "Pagina 4 Segreto 4"]);
      expect(labels(r)).toEqual(["i", "ii", "iii", "1", "2"]);
      expect(fieldPages(r)).toMatchObject({ nome: [1], nome_copia1: [2], accetto_copia1: [2], scelta_copia1: [2, 2], codice_copia1: [2] });
      formIsWhole(r);
    }
    // Editing the copy never changes the original.
    const s = engine(saveBytes(d, SAVE_OPTIONS));
    s.setField("nome", { kind: "text", text: "Originale" });
    s.setField("nome_copia1", { kind: "text", text: "Copia" });
    s.setField("scelta_copia1", { kind: "state", state: "B" });
    expect(fieldValues(s, 1)).toMatchObject({ nome: "Originale", scelta: "Off" });
    expect(fieldValues(s, 2)).toMatchObject({ nome_copia1: "Copia", scelta_copia1: "B" });
    s.replaceLine(2, s.lines(2).findIndex((l) => l.text === "Pagina 2"), "Pagina copiata");
    s.addText(2, [72, 300], "Solo sulla copia", { size: 12, color: [0, 0, 0], family: "sans", bold: false, italic: false });
    expect(s.lines(1).map((l) => l.text)).toEqual(["Pagina 2", "Segreto 2"]);
    expect(s.lines(2).map((l) => l.text).sort()).toEqual(["Pagina copiata", "Segreto 2", "Solo sulla copia"]);
    s.close();
  });

  it("copies several pages together: one copy of a field over both, popups and replies paired among the copies", () => {
    const d = rich();
    duplicatePages(mupdf, d, [0, 2], 4);
    expect(texts(d).slice(4)).toEqual(["Pagina 1 Segreto 1", "Pagina 3 Segreto 3"]);
    expect(fieldPages(d)).toMatchObject({ condiviso: [0, 2], condiviso_copia1: [4, 5], vai_copia1: [4], totale_copia1: [5] });
    const annots = items(d.findPage(4).get("Annots"));
    const note = annots.find((a) => nameOf(a.get("Subtype")) === "Text" && !a.get("Popup").isNull())!;
    expect(note.get("Popup").get("Parent").asIndirect()).toBe(note.asIndirect());
    expect(items(d.findPage(4).get("Annots")).some((a) => a.asIndirect() === note.get("Popup").asIndirect())).toBe(true);
    const reply = annots.find((a) => !a.get("IRT").isNull())!;
    expect(reply.get("IRT").get("P").asIndirect()).toBe(d.findPage(5).asIndirect()); // the copy of the highlight
    // Links on the copy still lead where they did (the pages 3 and 4 of the document); the copy of "totale" joins /CO.
    expect(links(d, 4)).toEqual([2, 3, "https://example.org", 2, 5]);
    expect(items(root(d).get("AcroForm").get("CO")).map((f) => fullName(f))).toEqual(["totale", "totale_copia1"]);
  });

  it("numbers further copies, and a copy of a signed field holds no signature", () => {
    const d = rich();
    duplicatePages(mupdf, d, [1], 2);
    duplicatePages(mupdf, d, [1], 3);
    expect(Object.keys(fieldPages(d)).filter((n) => n.startsWith("nome"))).toEqual(["nome", "nome_copia1", "nome_copia2"]);
    const signed = openPdf(formPdf({ signed: true }));
    duplicatePages(mupdf, signed, [0], 1);
    const firme = items(signed.findPage(1).get("Annots")).filter((a) => fullName(a) === "firma_copia1");
    expect(firme.length).toBe(1);
    expect(firme[0].get("V").isNull()).toBe(true);
    expect(items(signed.findPage(0).get("Annots")).find((a) => fullName(a) === "firma")!.get("V").isDictionary()).toBe(true);
  });
});

describe("insertPages", () => {
  it("refuses pages, a place or a title that cannot be", () => {
    const d = openPdf(plainPdf(["Uno"]));
    const src = rich();
    expect(refusal(() => insertPages(mupdf, d, src, [0, 0], 1, null))).toBe("bad-request");
    expect(refusal(() => insertPages(mupdf, d, src, [4], 1, null))).toBe("bad-request");
    expect(refusal(() => insertPages(mupdf, d, src, [], 1, null))).toBe("bad-request");
    expect(refusal(() => insertPages(mupdf, d, src, "all", 2, null))).toBe("bad-request");
    expect(refusal(() => insertPages(mupdf, d, src, "all", 1, 3 as unknown as string))).toBe("bad-request");
    expect(refusal(() => insertPages(mupdf, d, src, "all", 1, "x".repeat(1001)))).toBe("bad-request");
    expect(d.countPages()).toBe(1);
  });

  it("adds every page with its links, notes, fields, layers and bookmarks, and never changes the source", () => {
    const d = openPdf(plainPdf(["Uno", "Due"]));
    const src = rich();
    const srcBefore = saveBytes(src, "");
    const outcome = insertPages(mupdf, d, src, "all", 1, "rich.pdf");
    expect(outcome).toEqual({ report: { linksRemoved: 0, fieldsRenamed: 0, signaturesAdded: 0 }, layers: 1 });
    expect(saveBytes(src, "")).toEqual(srcBefore);
    const r = reopen(d);
    expect(texts(r)).toEqual(["Uno", "Pagina 1 Segreto 1", "Pagina 2 Segreto 2", "Pagina 3 Segreto 3", "Pagina 4 Segreto 4", "Due"]);
    expect(bounds(r).slice(1, 5)).toEqual([[0, 0, 595, 842], [0, 0, 595, 842], [0, 0, 800, 600], [0, 0, 800, 600]]);
    expect(labels(r)).toEqual(["", "", "", "", "", ""]);
    expect(links(r, 1)).toEqual([3, 4, "https://example.org", 3, 2]);
    expect(outline(r)).toEqual(["rich.pdf->1[Capitolo 1->1,Capitolo 2->2,Capitolo 3->3[Sezione 3.1->4],Sito->https://example.org,Al p3 per nome->3]"]);
    expect(root(r).get("Outlines").get("First").get("Count").asNumber()).toBe(-6); // closed
    expect(fieldPages(r)).toEqual({ condiviso: [1, 3], vai: [1], nome: [2], accetto: [2], scelta: [2, 2], codice: [2], totale: [3] });
    formIsWhole(r);
    // Notes: the popup pair and the reply to the highlight on page 3, all among the new pages.
    const annots = items(r.findPage(1).get("Annots"));
    const note = annots.find((a) => !a.get("Popup").isNull())!;
    expect(note.get("Popup").get("Parent").asIndirect()).toBe(note.asIndirect());
    expect(annots.find((a) => !a.get("IRT").isNull())!.get("IRT").get("P").asIndirect()).toBe(r.findPage(3).asIndirect());
    // Untagged: no /StructParents, no /StructParent, no /P that is not their page.
    for (let i = 1; i <= 4; i++) {
      expect(r.findPage(i).get("StructParents").isNull()).toBe(true);
      for (const a of items(r.findPage(i).get("Annots"))) {
        expect(a.get("StructParent").isNull()).toBe(true);
        expect(a.get("P").asIndirect()).toBe(r.findPage(i).asIndirect());
      }
    }
    // The hidden layer stays hidden (once the document is opened again: see the header's caveat).
    expect(texts(r)[4]).not.toContain("Testo nel livello");
    expect(r.countLayers()).toBe(1);
    expect(r.isLayerVisible(0)).toBe(false);
    const s = engine(saveBytes(d, SAVE_OPTIONS));
    s.setField("nome", { kind: "text", text: "Luigi" });
    expect(fieldValues(s, 2).nome).toBe("Luigi");
    expect(s.lines(3).map((l) => l.text)).toEqual(["Pagina 3", "Segreto 3"]);
    expect(s.pdfaCheck().blockers).toEqual([]);
    s.close();
  });

  it("renames fields the document has, merging the labels, and puts the bookmark in page order", () => {
    const d = rich();
    const report = insertPages(mupdf, d, rich(), "all", 4, "Di nuovo").report;
    expect(report.fieldsRenamed).toBe(7);
    expect(Object.keys(fieldPages(d)).sort()).toEqual(
      ["accetto", "accetto_2", "codice", "codice_2", "condiviso", "condiviso_2", "nome", "nome_2", "scelta", "scelta_2", "totale", "totale_2", "vai", "vai_2"],
    );
    expect(labels(d)).toEqual(["i", "ii", "1", "2", "3", "4", "5", "6"]);
    expect(outline(d).map((o) => o.split("[")[0])).toEqual(["Capitolo 1->0", "Capitolo 2->1", "Capitolo 3->2", "Sito->https://example.org", "Al p3 per nome->2", "Di nuovo->4"]);
    const s = engine(saveBytes(d, SAVE_OPTIONS));
    s.setField("nome", { kind: "text", text: "Primo" });
    s.setField("nome_2", { kind: "text", text: "Secondo" });
    expect(fieldValues(s, 1).nome).toBe("Primo");
    expect(fieldValues(s, 5).nome_2).toBe("Secondo");
    s.close();
    const first = rich();
    insertPages(mupdf, first, openPdf(plainPdf(["Prima"])), "all", 0, "Copertina");
    expect(outline(first)[0]).toBe("Copertina->0");
    expect(labels(first)).toEqual(["i", "ii", "iii", "1", "2"]);
  });

  it("never brings in pages that were not chosen", () => {
    const one = openPdf(plainPdf(["Uno"]));
    const report = insertPages(mupdf, one, rich(), [0], 1, "x").report;
    // The links to pages 3 and 4 (explicit, named, by name) and the button's GoTo.
    expect(report.linksRemoved).toBe(4);
    const bytes = saveBytes(one, SAVE_OPTIONS);
    expect(found(bytes, ["Pagina 2", "Pagina 3", "Pagina 4", "Segreto 2", "Segreto 3", "Segreto 4", "Nota pagina 3"])).toEqual(
      { "Pagina 2": 0, "Pagina 3": 0, "Pagina 4": 0, "Segreto 2": 0, "Segreto 3": 0, "Segreto 4": 0, "Nota pagina 3": 0 },
    );
    const r = openPdf(bytes);
    expect(countObjects(r, /\/Type\/Page(?!s)/)).toBe(2);
    expect(countObjects(r, /\/Type\/Catalog/)).toBe(1);
    const all = openPdf(plainPdf(["Uno"]));
    insertPages(mupdf, all, rich(), "all", 1, "x");
    console.log(`import: page 1 of the rich file saves to ${r.countObjects()} objects, all four pages to ${reopen(all).countObjects()}`);
    expect(r.countObjects()).toBeLessThan(45);
    expect(links(r, 1)).toEqual(["https://example.org", 1]);
    // The reply to the highlight on page 3 stands alone; the button stays, without its action.
    const annots = items(r.findPage(1).get("Annots"));
    expect(annots.every((a) => a.get("IRT").isNull())).toBe(true);
    expect(annots.find((a) => fullName(a) === "vai")!.get("A").isNull()).toBe(true);
    expect(fieldPages(r)).toEqual({ condiviso: [1], vai: [1] });
    formIsWhole(r);
    expect(outline(r)).toEqual(["x->1[Capitolo 1->1,Sito->https://example.org]"]);
  });

  it("reads a source opened with its password", () => {
    const src = openPdf(fixture("enc-user-aes128.pdf"), "utente");
    const expected = texts(src);
    const d = openPdf(plainPdf(["Uno"]));
    insertPages(mupdf, d, src, "all", 1, null);
    expect(texts(reopen(d)).slice(1)).toEqual(expected);
    expect(outline(d)).toEqual([]);
  });

  it("merges the form's fonts, giving another font under the same name a name of its own", () => {
    const d = openPdf(formPdf());
    insertPages(mupdf, d, openPdf(formPdf({ courierHelv: true, value: "Luigi" })), "all", 1, null);
    const fonts = root(d).get("AcroForm").get("DR").get("Font");
    expect(fonts.get("Helv").get("BaseFont").asName()).toBe("Helvetica");
    expect(fonts.get("Helv_2").get("BaseFont").asName()).toBe("Courier");
    const nome2 = items(d.findPage(1).get("Annots")).find((a) => fullName(a) === "nome_2")!;
    expect(nome2.get("DA").asString()).toBe("/Helv_2 12 Tf 0 g");
    const s = engine(saveBytes(d, SAVE_OPTIONS));
    expect(fieldValues(s, 1).nome_2).toBe("Luigi");
    s.setField("nome_2", { kind: "text", text: "Marco" });
    expect(fieldValues(s, 0).nome).toBe("");
    s.close();
    // The same standard font under the same name stays one.
    const same = openPdf(formPdf());
    insertPages(mupdf, same, openPdf(formPdf({ value: "Luigi" })), "all", 1, null);
    expect(root(same).get("AcroForm").get("DR").get("Font").get("Helv_2").isNull()).toBe(true);
  });

  it("gives the fields of a /NeedAppearances form real appearances, not the flag", () => {
    for (const value of ["Mario", "Zażółć"]) {
      const d = openPdf(plainPdf(["Uno"]));
      insertPages(mupdf, d, openPdf(formPdf({ needAppearances: true, value })), "all", 1, null);
      expect(root(d).get("AcroForm").get("NeedAppearances").isNull()).toBe(true);
      const w = items(d.findPage(1).get("Annots"))[0];
      const ap = w.get("AP").get("N");
      const buf = ap.readStream();
      const content = buf.asString();
      buf.destroy();
      expect(content).not.toContain("1 0 0 rg 0 0 228 20 re f"); // the stale red box
      expect(content).toMatch(/T[jJ]/);
      const s = engine(saveBytes(d, SAVE_OPTIONS));
      expect(fieldValues(s, 1).nome).toBe(value);
      s.close();
    }
  });

  it("keeps a signature (counted), without dragging in the source's catalog", () => {
    const d = openPdf(plainPdf(["Uno"]));
    expect(insertPages(mupdf, d, openPdf(formPdf({ signed: true })), "all", 1, null).report.signaturesAdded).toBe(1);
    const acro = root(d).get("AcroForm");
    expect(acro.get("SigFlags").asNumber() & 1).toBe(1);
    const firma = items(d.findPage(1).get("Annots")).find((a) => fullName(a) === "firma")!;
    expect(firma.get("V").get("Name").asString()).toBe("Firmatario Prova");
    expect(firma.get("V").get("Reference").get(0).get("Data").isNull()).toBe(true);
    const r = reopen(d);
    expect(countObjects(r, /\/Type\/Catalog/)).toBe(1);
    expect(countObjects(r, /\/Type\/Page(?!s)/)).toBe(2);
  });

  it("hides the value of a password field it adds", () => {
    const d = openPdf(plainPdf(["Uno"]));
    insertPages(mupdf, d, openPdf(formPdf({ password: "parola-segreta" })), "all", 1, null);
    const pin = items(d.findPage(1).get("Annots")).find((a) => fullName(a) === "pin")!;
    expect(pin.get("AP").get("N").isStream()).toBe(true);
    expect(found(saveBytes(d, SAVE_OPTIONS), ["(parola-segreta) Tj"])["(parola-segreta) Tj"]).toBe(0);
  });

  it("adds layers with the state they had, with or without a /D configuration", () => {
    const cases = { none: ["Pagina 1 Strato 1", "Pagina 2 Strato 2"], off: ["Pagina 1", "Pagina 2 Strato 2"], default: ["Pagina 1", "Pagina 2 Strato 2"] } as const;
    for (const [config, expected] of Object.entries(cases)) {
      const d = openPdf(plainPdf(["Uno"]));
      expect(insertPages(mupdf, d, openPdf(layersPdf(config as "none")), "all", 1, null).layers).toBe(2);
      const r = reopen(d);
      expect(texts(r).slice(1), config).toEqual(expected);
      expect(r.countLayers()).toBe(2);
    }
    // Into a document with layers of its own, only the layers the chosen pages use.
    const d = rich();
    expect(insertPages(mupdf, d, openPdf(layersPdf("default")), [1], 4, null).layers).toBe(1);
    const oc = root(d).get("OCProperties");
    expect(items(oc.get("OCGs")).map((g) => g.get("Name").asString())).toEqual(["Livello A", "Livello 2"]);
    expect(items(oc.get("D").get("Order")).length).toBe(2);
    expect(items(oc.get("D").get("OFF")).map((g) => g.get("Name").asString())).toEqual(["Livello A"]);
  });

  it("returns the layers it added: MuPDF draws them only once the document is opened again (the session re-opens it)", () => {
    const d = rich();
    expect(texts(d)[3]).toBe("Pagina 4 Segreto 4"); // its own layer drawn: MuPDF has read the layer list
    expect(insertPages(mupdf, d, openPdf(layersPdf("default")), [0], 4, null).layers).toBe(1);
    expect(texts(d)[4]).toBe("Pagina 1 Strato 1"); // the caveat: drawn as visible here
    expect(d.countLayers()).toBe(1);
    const r = reopen(d);
    expect(texts(r)[4]).toBe("Pagina 1");
    expect(r.countLayers()).toBe(2);
  });

  it("makes no labels in a file without them, wherever the pages go", () => {
    for (const at of [0, 1, 2]) {
      const d = openPdf(plainPdf(["Uno", "Due"]));
      insertPages(mupdf, d, openPdf(plainPdf(["Altra"])), "all", at, null);
      duplicatePages(mupdf, d, [0], 0);
      expect(root(d).get("PageLabels").isNull()).toBe(true);
    }
  });

  it("resolves named destinations of the old /Root/Dests dictionary", () => {
    const d = openPdf(plainPdf(["Prima"]));
    insertPages(mupdf, d, openPdf(oldDestsPdf()), "all", 1, "Vecchio");
    expect(links(d, 1)).toEqual([3]);
    expect(links(d, 2)).toEqual([1]);
    expect(outline(d)).toEqual(["Vecchio->1[Tre->3]"]);
  });
});

describe("pageObjectNumbers", () => {
  it("tells the pages that stayed from those an operation made", () => {
    const d = rich();
    const before = pageObjectNumbers(d);
    duplicatePages(mupdf, d, [1], 0);
    insertPages(mupdf, d, rich(), [0], 5, null);
    deletePages(mupdf, d, [3]);
    const after = pageObjectNumbers(d);
    const from = after.map((n) => (before.includes(n) ? before.indexOf(n) : null));
    expect(from).toEqual([null, 0, 1, 3, null]);
  });
});

describe("larger files (when the local fixtures are there)", () => {
  const local = (name: string) => {
    try {
      return new Uint8Array(readFileSync(new URL(`../node_modules/pdf-fixtures/${name}`, import.meta.url)));
    } catch {
      return null;
    }
  };
  const long = local("long120.pdf");
  it.skipIf(!long)("long120: a copy, a move, an import of all of it, a delete", () => {
    const d = openPdf(long!);
    const time = (label: string, fn: () => void) => {
      const t0 = performance.now();
      fn();
      console.log(`long120: ${label} in ${(performance.now() - t0).toFixed(1)} ms`);
    };
    time("copy of page 1", () => duplicatePages(mupdf, d, [0], 1));
    time("121 pages reversed", () => movePages(mupdf, d, Array.from({ length: 121 }, (_, i) => 120 - i)));
    time("120 pages of another copy inserted", () => insertPages(mupdf, d, openPdf(long!), "all", 121, "long120.pdf"));
    time("60 pages deleted", () => deletePages(mupdf, d, Array.from({ length: 60 }, (_, i) => i * 4)));
    expect(d.countPages()).toBe(181);
    const s = engine(saveBytes(d, SAVE_OPTIONS));
    expect(s.lines(0).length).toBeGreaterThan(0);
    s.close();
  });
});

describe("determinism", () => {
  const ops: [string, (d: Doc) => void][] = [
    ["move", (d) => movePages(mupdf, d, [2, 3, 1, 0])],
    ["delete", (d) => deletePages(mupdf, d, [1, 2])],
    ["blank", (d) => insertBlankPages(mupdf, d, 2, [[300, 300], [400, 400]])],
    ["duplicate", (d) => duplicatePages(mupdf, d, [0, 1, 2], 1)],
    ["rotate", (d) => rotatePages(mupdf, d, [0, 3], 270)],
    ["insert", (d) => insertPages(mupdf, d, rich(), [3, 0, 1], 2, "Altro")],
    ["keep", (d) => keepPages(mupdf, d, [1, 3])],
  ];
  it.each(ops)("%s: the same operation on two copies saves to the same bytes", (_, op) => {
    const [a, b] = [openPdf(appEdited(RICH)), openPdf(appEdited(RICH))];
    op(a);
    op(b);
    expect(saveBytes(a, SAVE_OPTIONS)).toEqual(saveBytes(b, SAVE_OPTIONS));
    // ...and a snapshot (no garbage collection, as checkpoints are taken) too.
    expect(saveBytes(a, "encrypt=none,compress-images=yes")).toEqual(saveBytes(b, "encrypt=none,compress-images=yes"));
  });
});

describe("the app's own edits on pages that moved, were copied or came from another PDF", () => {
  it("keeps the lines and pictures the app wrote, and their ids", () => {
    const d = openPdf(appEdited(RICH));
    movePages(mupdf, d, [2, 0, 1, 3]); // Via Segreta 7 and the picture first
    duplicatePages(mupdf, d, [0], 4);
    insertPages(mupdf, d, openPdf(appEdited(RICH)), [1], 5, null);
    const s = engine(saveBytes(d, SAVE_OPTIONS));
    expect(s.addedTexts(0).map((t) => [t.id, t.text])).toEqual([[1, "Via Segreta 7"]]);
    expect(s.addedTexts(4).map((t) => [t.id, t.text])).toEqual([[1, "Via Segreta 7"]]);
    expect(s.addedTexts(5).map((t) => [t.id, t.text])).toEqual([[1, "Mario Rossi"]]);
    expect(s.images(0).filter((i) => i.added && i.movable).length).toBe(1);
    expect(s.images(4).filter((i) => i.added && i.movable).length).toBe(1);
    s.editAddedText(4, 1, { text: "Solo nella copia" });
    expect(s.addedTexts(0)[0].text).toBe("Via Segreta 7");
    const im = s.images(4).find((i) => i.added)!;
    s.transformImage(4, im.index, [im.matrix[0], 0, 0, im.matrix[3], im.matrix[4] + 20, im.matrix[5]]);
    expect(s.images(0).find((i) => i.added)!.matrix).toEqual(im.matrix);
    expect(fieldValues(s, 2).nome).toBe("Mario");
    expect(fieldValues(s, 5).nome_2).toBe("Mario");
    // New text on an added page and on a copy of a tagged document: they get structure of their own.
    const style = { size: 12, color: [0, 0, 0] as [number, number, number], family: "sans" as const, bold: false, italic: false };
    expect(s.addText(5, [72, 200], "Sulla pagina aggiunta", style).id).toBe(2);
    expect(s.addText(4, [72, 200], "Sulla copia", style).id).toBe(2);
    expect(s.addedTexts(5).map((t) => t.text)).toEqual(["Mario Rossi", "Sulla pagina aggiunta"]);
    const pdfa = s.save({ format: "pdfa-2b", password: { mode: "none" } });
    expect(pdfa.pdfa?.blockers).toEqual([]);
    s.close();
  });
});

// ---------------------------------------------------------------------------------------------
// Null entries and other values of the wrong kind (review P7): PDFObject.get on the null object
// throws, and MuPDF hands a literal `null` of an array or a dictionary back as that object.

/** `bytes` changed by `fn`, saved as they are (MuPDF writes a null it is given as a literal null). */
function changed(bytes: Uint8Array, fn: (d: Doc) => void): Uint8Array {
  const d = openPdf(bytes);
  fn(d);
  return saveBytes(d, "");
}

/** The entries of a dictionary as "key=value" (Null printed as such). */
const printed = (dict: Obj) => {
  const out: string[] = [];
  dict.forEach((v, k) => out.push(`${k}=${v.isNull() ? "Null" : v.toString()}`));
  return out;
};

/** Keys whose arrays the page operations walk as lists (and Dest/D/Limits, which they read by position). */
const WALKED = new Set(["Annots", "Kids", "Fields", "CO", "OCGs", "ON", "OFF", "Locked", "Order", "RBGroups", "Threads", "B", "K", "Names", "Nums", "Next", "Limits", "Dest", "D", "T", "Opt"]);

/**
 * Every object of the document changed: each dictionary (direct ones inside objects too) by
 * `dict`, each list (an array under a WALKED key; never a /Pages node's /Kids) by `list`; each
 * object read once, its direct parts first.
 */
function everywhere(bytes: Uint8Array, change: { list?: (arr: Obj) => void; dict?: (dict: Obj) => void }): Uint8Array {
  return changed(bytes, (d) => {
    const visit = (o: Obj, key: string, depth: number) => {
      if (depth > 32 || o.isIndirect()) return;
      if (o.isDictionary()) {
        const kids: [string, Obj][] = [];
        o.forEach((v, k) => kids.push([String(k), v]));
        const pagesNode = nameOf(o.get("Type")) === "Pages";
        for (const [k, v] of kids) if (!(pagesNode && k === "Kids")) visit(v, k, depth + 1);
        change.dict?.(o);
      } else if (o.isArray()) {
        const kids: Obj[] = [];
        o.forEach((v) => kids.push(v));
        for (const v of kids) visit(v, key, depth + 1);
        if (WALKED.has(key)) change.list?.(o);
      }
    };
    for (let i = 1; i < d.countObjects(); i++) {
      const o = d.newIndirect(i).resolve();
      if (!o.isNull()) visit(o, "", 0);
    }
  });
}

const once = (list: number[]) => [...new Set(list)];

/** Each page operation once, on `make()` (a fresh document each time; any number of pages); `other` the PDF pages are added from. */
function everyOperation(make: () => Doc, other: () => Doc): [string, () => Doc][] {
  const n = make().countPages(), m = other().countPages();
  const run = (fn: (d: Doc) => unknown) => () => {
    const d = make();
    fn(d);
    return d;
  };
  const ops: [string, () => Doc][] = [
    ["move", run((d) => movePages(mupdf, d, Array.from({ length: n }, (_, i) => (i + n - 1) % n)))],
    ["keep", run((d) => keepPages(mupdf, d, once([n - 1, 0])))],
    ["blank", run((d) => insertBlankPages(mupdf, d, Math.min(2, n), [[300, 300]]))],
    ["duplicate", run((d) => duplicatePages(mupdf, d, once([0, 1, 2].map((i) => Math.min(i, n - 1))), Math.min(1, n)))],
    ["rotate", run((d) => rotatePages(mupdf, d, once([0, n - 1]), 90))],
    ["insert all", run((d) => insertPages(mupdf, d, other(), "all", 1, "Altro"))],
    ["insert some", run((d) => insertPages(mupdf, d, other(), once([m - 1, 0, Math.min(1, m - 1)]), Math.min(2, n), "Altro"))],
    ["insert into a plain file", () => {
      const d = openPdf(plainPdf(["Uno"]));
      insertPages(mupdf, d, make(), once([0, n - 1]), 1, "Altro");
      return d;
    }],
  ];
  if (n > 1) {
    ops.push(["delete the middle page", run((d) => deletePages(mupdf, d, [n >> 1]))]);
    ops.push(["delete page 1", run((d) => deletePages(mupdf, d, [0]))]);
    ops.push(["delete all but page 1", run((d) => deletePages(mupdf, d, Array.from({ length: n - 1 }, (_, i) => i + 1)))]);
  }
  return ops;
}

/** Runs each operation; an error fails the test, naming the operation, unless `refusals` and it is a refusal (PagesError). */
function eachRun(ops: [string, () => Doc][], refusals: boolean, check: (op: string, d: Doc, k: number) => void) {
  ops.forEach(([op, run], k) => {
    let d: Doc;
    try {
      d = run();
    } catch (err) {
      if (refusals && err instanceof PagesError) return;
      throw new Error(`${op}: ${err instanceof Error ? err.stack : String(err)}`);
    }
    check(op, d, k);
  });
}

describe("null entries and values of the wrong kind", () => {
  it("an insert skips a null font in the other form's /DR (the document has a font of that name)", () => {
    const src = changed(formPdf({ value: "Luigi" }), (d) => root(d).get("AcroForm").get("DR").get("Font").put("Helv", null));
    expect(printed(root(openPdf(src)).get("AcroForm").get("DR").get("Font"))).toEqual(["Helv=Null"]);
    const d = openPdf(formPdf());
    insertPages(mupdf, d, openPdf(src), "all", 1, null);
    expect(fieldPages(d)).toEqual({ nome: [0], nome_2: [1] });
    expect(root(d).get("AcroForm").get("DR").get("Font").get("Helv").get("BaseFont").asName()).toBe("Helvetica");
    const s = engine(saveBytes(d, SAVE_OPTIONS));
    expect(fieldValues(s, 1).nome_2).toBe("Luigi");
    s.close();
    // ...and a font of another kind (a number) under that name, the other way round.
    const junk = changed(formPdf(), (x) => root(x).get("AcroForm").get("DR").get("Font").put("Helv", 7));
    insertPages(mupdf, openPdf(junk), openPdf(formPdf({ value: "Luigi" })), "all", 1, null);
  });

  it("a delete and an extract skip a null kid in the destinations' name tree", () => {
    const bytes = changed(RICH, (d) => {
      const dests = root(d).get("Names").get("Dests");
      const kids = d.newArray();
      kids.push(null);
      kids.push(dests.get("Kids").get(0));
      const top = d.newArray();
      top.push(d.addObject({ Kids: kids, Limits: [d.newString("cap2"), d.newString("p3")] }));
      dests.put("Kids", top);
    });
    const mid = () => root(openPdf(bytes)).get("Names").get("Dests").get("Kids").get(0);
    expect(mid().get("Kids").get(0).isNull()).toBe(true);
    const d = openPdf(bytes);
    deletePages(mupdf, d, [2]);
    const dests = root(d).get("Names").get("Dests");
    expect(treeKeys(dests, "Names")).toEqual(["cap2", "cap4"]);
    expect(items(dests.get("Kids").get(0).get("Limits")).map((l) => l.asString())).toEqual(["cap2", "cap4"]);
    const k = openPdf(bytes);
    keepPages(mupdf, k, [0, 1]);
    expect(treeKeys(root(k).get("Names").get("Dests"), "Names")).toEqual(["cap2"]);
    expect(found(saveBytes(k, SAVE_OPTIONS), ["Pagina 3", "Pagina 4"])).toEqual({ "Pagina 3": 0, "Pagina 4": 0 });
  });

  it("a delete skips a null kid in the ParentTree", () => {
    const bytes = changed(RICH, (d) => {
      const kidsOfTree = root(d).get("StructTreeRoot").get("ParentTree").get("Kids");
      const kids = d.newArray();
      kids.push(null);
      kids.push(kidsOfTree.get(1));
      kidsOfTree.put(1, d.addObject({ Kids: kids, Limits: [2, 10] }));
    });
    const d = openPdf(bytes);
    deletePages(mupdf, d, [2]);
    const tree = root(d).get("StructTreeRoot").get("ParentTree");
    expect(treeKeys(tree, "Nums")).toEqual([0, 1, 3]);
    expect(items(tree.get("Kids").get(1).get("Limits")).map((l) => l.asNumber())).toEqual([3, 3]);
  });

  it("a page tree with a null kid: an operation works, or is refused as not editable, never crashes", () => {
    const atEnd = changed(RICH, (d) => root(d).get("Pages").get("Kids").get(0).get("Kids").push(null));
    const first = changed(RICH, (d) => {
      const kids = root(d).get("Pages").get("Kids");
      const arr = d.newArray();
      arr.push(null);
      for (const k of items(kids)) arr.push(k);
      root(d).get("Pages").put("Kids", arr);
    });
    // MuPDF counts the pages by /Count: a null after them is never reached, a null first is page 1.
    eachRun(everyOperation(() => openPdf(atEnd), rich), false, (op, d) => expect(texts(reopen(d)).length, op).toBe(d.countPages()));
    let refused = 0;
    for (const [op, run] of everyOperation(() => openPdf(first), rich)) {
      try {
        run();
      } catch (err) {
        expect(err instanceof PagesError ? err.code : String(err), op).toBe("not-editable");
        refused++;
      }
    }
    expect(refused).toBeGreaterThan(0);
  });

  // The operations on documents with a null at the end of every list they walk, or a null entry
  // in every dictionary, must work as on the document itself: a null in a list is skipped, a null
  // entry is no entry.
  const bases: [string, Uint8Array][] = [
    ["rich", RICH],
    ["rich, edited by the app", appEdited(RICH)],
    ["a /NeedAppearances form", formPdf({ needAppearances: true, value: "Mario" })],
    ["a signed form with a password field", formPdf({ signed: true, password: "segreta" })],
    ["layers", layersPdf("off")],
    ["old /Root/Dests", oldDestsPdf()],
  ];
  const fixtures = readdirSync(new URL("./fixtures/", import.meta.url)).filter((n) => n.endsWith(".pdf") && !n.startsWith("enc-"));
  const preserving: [string, Uint8Array, Uint8Array][] = [];
  for (const [name, bytes] of bases) {
    preserving.push([`${name}: a null at the end of every list`, bytes, everywhere(bytes, { list: (a) => a.push(null) })]);
    preserving.push([`${name}: a null entry in every dictionary`, bytes, everywhere(bytes, { dict: (o) => o.put("Zz", null) })]);
  }
  for (const name of fixtures) preserving.push([`${name}: a null at the end of every list`, fixture(name), everywhere(fixture(name), { list: (a) => a.push(null) })]);
  it.each(preserving)("%s: every operation as on the document itself", (_, bytes, mutated) => {
    const plain = everyOperation(() => openPdf(bytes), rich);
    eachRun(everyOperation(() => openPdf(mutated), rich), false, (op, d, k) => {
      const r = reopen(d);
      const expected = reopen(plain[k][1]());
      expect(texts(r), op).toEqual(texts(expected));
      expect(outline(r), op).toEqual(outline(expected));
      expect(fieldPages(r), op).toEqual(fieldPages(expected));
      expect(bounds(r), op).toEqual(bounds(expected));
    });
  });

  // Lists that start with a null (name and number trees then read keys as values), and values of
  // the wrong kind (null, a number) where a dictionary is expected: an operation may then work on
  // less (a link it cannot read stays as it is...), but never fails.
  const listsStart = everywhere(RICH, {
    list: (a) => {
      const kids: Obj[] = [];
      a.forEach((v) => kids.push(v));
      while (a.length) a.delete(a.length - 1);
      a.push(null);
      for (const v of kids) a.push(v);
    },
  });
  const KEYS = ["Parent", "P", "Popup", "IRT", "A", "AA", "D", "DR", "Font", "AP", "N", "MK", "First", "Next", "Limits", "ParentTree", "StructTreeRoot",
    "OCProperties", "Outlines", "Names", "Dests", "AcroForm", "Threads", "F", "Pg", "K", "Obj", "Dest", "S", "V", "T", "Kids", "Fields", "Annots", "Resources",
    "MediaBox", "CropBox", "Rotate", "Contents", "Nums", "OCGs", "Order", "OFF", "CO", "Opt", "BaseState"];
  const variants: [string, Uint8Array][] = [["a null at the start of every list", listsStart]];
  for (const key of KEYS)
    for (const junk of [null, 7] as const)
      variants.push([`/${key} ${junk}`, everywhere(RICH, {
        dict: (o) => {
          const type = nameOf(o.get("Type"));
          if (o.get(key).isNull() || ((type === "Pages" || type === "Page") && (key === "Parent" || key === "Kids"))) return;
          o.put(key, junk);
        },
      })]);
  it.each(variants)("%s: no operation fails but by refusing", (_, bytes) => {
    eachRun(everyOperation(() => openPdf(bytes), () => openPdf(bytes)), true, (op, d) => {
      expect(reopen(d).countPages(), op).toBe(d.countPages());
    });
  });
});

// ---------------------------------------------------------------------------------------------
// The page tree, written in one pass

/** Each page as it shows: its text, its bounds and the font of its first line. */
function shown(doc: Doc): string[] {
  return eachPage(doc, (p) => {
    const st = p.toStructuredText();
    try {
      const json = JSON.parse(st.asJSON()) as { blocks: { lines?: { font: { name: string } }[] }[] };
      const font = json.blocks.flatMap((b) => b.lines ?? [])[0]?.font.name ?? "-";
      return `${st.asText().trim()} ${p.getBounds().map(Math.round).join(",")} ${font}`;
    } finally {
      st.destroy();
    }
  });
}

/**
 * 27 pages "Foglio 1".."Foglio 27" in a page tree three levels deep, whose nodes hand down
 * different things: the root a MediaBox, Rotate 180 and Helvetica as F1; under it three nodes
 * (the first its own MediaBox, the second Rotate 90 and a CropBox, the third Courier as F1),
 * under each a page and two nodes of four pages (the second with Rotate 270). Every 7th page
 * has a Rotate of its own, every 5th a MediaBox.
 */
function deepTreePdf(): Uint8Array {
  const doc = new mupdf.PDFDocument();
  const font = (name: string) => doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: name, Encoding: "WinAnsiEncoding" });
  const [helv, cour] = [font("Helvetica"), font("Courier")];
  const top = root(doc).get("Pages");
  top.put("MediaBox", [0, 0, 500, 700]);
  top.put("Rotate", 180);
  top.put("Resources", { Font: { F1: helv } });
  let n = 0;
  const node = (parent: Obj, attrs: Record<string, unknown>, fill: (o: Obj) => Obj[]) => {
    const o = doc.addObject({ Type: "Pages", ...attrs });
    o.put("Parent", parent);
    const kids = fill(o);
    const arr = doc.newArray();
    for (const k of kids) arr.push(k);
    o.put("Kids", arr);
    o.put("Count", kids.reduce((c, k) => c + (nameOf(k.get("Type")) === "Pages" ? k.get("Count").asNumber() : 1), 0));
    return o;
  };
  const page = (parent: Obj) => {
    n++;
    const p = doc.addObject({ Type: "Page", Contents: addStream(doc, `BT /F1 20 Tf 40 300 Td (Foglio ${n}) Tj ET`) });
    p.put("Parent", parent);
    if (n % 7 === 0) p.put("Rotate", 90);
    if (n % 5 === 0) p.put("MediaBox", [0, 0, 400, 400]);
    return p;
  };
  const level = [{ MediaBox: [0, 0, 595, 842] }, { Rotate: 90, CropBox: [20, 20, 400, 500] }, { Resources: { Font: { F1: cour } } }];
  const kids = level.map((attrs) => node(top, attrs, (a) => [page(a), ...[{}, { Rotate: 270 }].map((sub) => node(a, sub, (b) => [0, 1, 2, 3].map(() => page(b))))]));
  const arr = doc.newArray();
  for (const k of kids) arr.push(k);
  top.put("Kids", arr);
  top.put("Count", 27);
  return saveBytes(doc);
}

describe("the page tree, written in one pass", () => {
  const DEEP = deepTreePdf();
  const before = shown(openPdf(DEEP));
  const blank = (w: number, h: number) => ` 0,0,${w},${h} -`;

  it("the deep fixture is what the test expects", () => {
    expect(before.length).toBe(27);
    expect(new Set(before.map((s) => s.split(" ").pop())).size).toBe(2); // two fonts
    expect(new Set(before.map((s) => s.split(" ")[2])).size).toBeGreaterThan(4); // sizes and turns
  });

  const cases: [string, (d: Doc) => unknown, string[]][] = [
    ["reversed", (d) => movePages(mupdf, d, Array.from({ length: 27 }, (_, i) => 26 - i)), [...before].reverse()],
    ["shuffled", (d) => movePages(mupdf, d, Array.from({ length: 27 }, (_, i) => (i * 10) % 27)), Array.from({ length: 27 }, (_, i) => before[(i * 10) % 27])],
    ["pages deleted", (d) => deletePages(mupdf, d, [0, 5, 13, 26]), before.filter((_, i) => ![0, 5, 13, 26].includes(i))],
    ["pages kept", (d) => keepPages(mupdf, d, [20, 2, 9]), [before[2], before[9], before[20]]],
    ["blank pages", (d) => insertBlankPages(mupdf, d, 5, [[200, 100], [300, 300]]), [...before.slice(0, 5), blank(200, 100), blank(300, 300), ...before.slice(5)]],
    ["a blank page at the end", (d) => insertBlankPages(mupdf, d, 27, [[200, 100]]), [...before, blank(200, 100)]],
    ["copies", (d) => duplicatePages(mupdf, d, [4, 12, 25], 9), [...before.slice(0, 9), before[4], before[12], before[25], ...before.slice(9)]],
    ["pages of another copy", (d) => insertPages(mupdf, d, openPdf(DEEP), [26, 0, 13], 4, null), [...before.slice(0, 4), before[26], before[0], before[13], ...before.slice(4)]],
  ];
  it.each(cases)("%s: every page shows what it showed, a new page nothing it did not bring", (_, op, expected) => {
    const d = openPdf(DEEP);
    op(d);
    expect(shown(d)).toEqual(expected); // the working document, read again by MuPDF at once
    expect(shown(reopen(d))).toEqual(expected);
    // One /Pages node, the root; every page's /Parent is it.
    const top = root(d).get("Pages");
    expect(items(top.get("Kids")).every((k) => nameOf(k.get("Type")) === "Page" && k.get("Parent").asIndirect() === top.asIndirect())).toBe(true);
    expect(top.get("Count").asNumber()).toBe(expected.length);
    // A second operation on the tree as it is now.
    movePages(mupdf, d, Array.from({ length: expected.length }, (_, i) => expected.length - 1 - i));
    expect(shown(reopen(d))).toEqual([...expected].reverse());
  });

  it("a tree root written in the catalog itself becomes an object of its own (pages name it as /Parent)", () => {
    const bytes = changed(plainPdf(["Uno", "Due", "Tre"]), (d) => root(d).put("Pages", root(d).get("Pages").resolve()));
    const d = openPdf(bytes);
    expect(root(d).get("Pages").isIndirect()).toBe(false);
    movePages(mupdf, d, [2, 0, 1]);
    deletePages(mupdf, d, [1]);
    expect(texts(d)).toEqual(["Tre", "Due"]);
    const top = root(d).get("Pages");
    expect(top.isIndirect()).toBe(true);
    expect(d.findPage(1).get("Parent").asIndirect()).toBe(top.asIndirect());
    expect(texts(reopen(d))).toEqual(["Tre", "Due"]);
  });

  it("pages keep what they showed, and a new page takes nothing, when the root hands things down too", () => {
    const make = () => {
      const d = rich();
      const top = root(d).get("Pages");
      top.put("CropBox", [0, 0, 550, 700]);
      top.put("Rotate", 180);
      return d;
    };
    const b = bounds(make());
    expect(b).toEqual([[0, 0, 550, 700], [0, 0, 550, 700], [0, 0, 700, 550], [0, 0, 700, 550]]);
    const cases: [(d: Doc) => unknown, number[][]][] = [
      [(d) => movePages(mupdf, d, [3, 0, 1, 2]), [b[3], b[0], b[1], b[2]]],
      [(d) => deletePages(mupdf, d, [0]), b.slice(1)],
      [(d) => insertBlankPages(mupdf, d, 3, [[200, 100]]), [...b.slice(0, 3), [0, 0, 200, 100], b[3]]],
      [(d) => duplicatePages(mupdf, d, [2], 0), [b[2], ...b]],
      // Pages of a file without those: as they were there (page 3 of rich turned by 90, page 1 not).
      [(d) => insertPages(mupdf, d, rich(), [2, 0], 1, null), [b[0], [0, 0, 800, 600], [0, 0, 595, 842], ...b.slice(1)]],
    ];
    for (const [op, expected] of cases) {
      const d = make();
      op(d);
      expect(bounds(d)).toEqual(expected);
      expect(bounds(reopen(d))).toEqual(expected);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// keepPages on a copy of the other PDF: what the session logs for an insert (review P6), so
// that only the chosen pages are kept in memory, in exports and on the device.

describe("keepPages for an insert", () => {
  it.each([[[0]], [[1]], [[3, 0, 2]], [[2, 0, 1, 3]]])("pages %j: a copy kept to them inserts as the whole file, with the same report", (chosen) => {
    const whole = openPdf(plainPdf(["Uno", "Due"]));
    const expected = insertPages(mupdf, whole, rich(), chosen, 1, "Altro").report;
    const copy = rich();
    const kept = keepPages(mupdf, copy, chosen);
    const part = saveBytes(copy, SAVE_OPTIONS);
    // Nothing of the pages not chosen is in the copy.
    const others = [0, 1, 2, 3].filter((p) => !chosen.includes(p));
    const needles = others.flatMap((p) => [`Pagina ${p + 1}`, `Segreto ${p + 1}`]).concat(others.includes(2) ? ["Nota pagina 3", "Testo segreto pagina 3"] : []);
    expect(found(part, needles)).toEqual(Object.fromEntries(needles.map((s) => [s, 0])));
    expect(openPdf(part).countPages()).toBe(chosen.length);
    // The insert names the kept pages by their rank among the chosen ones, in the order chosen.
    const sorted = [...chosen].sort((x, y) => x - y);
    const viaCopy = openPdf(plainPdf(["Uno", "Due"]));
    const report = insertPages(mupdf, viaCopy, openPdf(part), chosen.map((p) => sorted.indexOf(p)), 1, "Altro").report;
    const [a, b] = [reopen(whole), reopen(viaCopy)];
    expect(texts(b)).toEqual(texts(a));
    expect(labels(b)).toEqual(labels(a));
    for (let i = 0; i < a.countPages(); i++) expect(links(b, i), `links of page ${i + 1}`).toEqual(links(a, i));
    expect(outline(b)).toEqual(outline(a));
    expect(fieldPages(b)).toEqual(fieldPages(a));
    formIsWhole(b);
    expect(b.countLayers()).toBe(a.countLayers());
    expect({ ...report, linksRemoved: kept.report.linksRemoved - (kept.bookmarksRemoved ?? 0) + report.linksRemoved }).toEqual(expected);
  });

  it("every page given changes nothing (the insert names them in the order chosen)", () => {
    const d = rich();
    expect(keepPages(mupdf, d, [2, 0, 1, 3])).toEqual({ report: { linksRemoved: 0, fieldsRenamed: 0, signaturesAdded: 0 }, bookmarksRemoved: 0 });
    expect(saveBytes(d, SAVE_OPTIONS)).toEqual(saveBytes(rich(), SAVE_OPTIONS));
  });

  it("works on a copy of a source that needed a password, written without it", () => {
    const src = openPdf(fixture("enc-user-aes128.pdf"), "utente");
    const n = src.countPages();
    const plainCopy = openPdf(saveBytes(src, "encrypt=none"));
    expect(plainCopy.needsPassword()).toBe(false);
    keepPages(mupdf, plainCopy, [n - 1]);
    const part = saveBytes(plainCopy, SAVE_OPTIONS);
    expect(openPdf(part).countPages()).toBe(1);
    expect(texts(openPdf(part))).toEqual([texts(src)[n - 1]]);
  });
});

// ---------------------------------------------------------------------------------------------
// Destinations that name their page by number (fix round 2): `[2 /Fit]` instead of the page
// object. ISO 32000 asks for the page object in a local destination, but MuPDF and the importer
// read a number as the page's index, so the operations take such a destination as a reference
// to that page: it follows the page when the pages are renumbered and goes with it when it goes.
// The case that mattered: the session logs an insert as a copy of the other PDF kept to the
// chosen pages (keepPages), and the kept copy renumbers its pages.

/**
 * Four pages "Pagina 1".."Pagina 4" whose local destinations all name their page by number: on
 * page 1 a link to page 3 and one to page 4 (/Dest), a link whose GoTo leads to page 2, a link to
 * the name (n4) (its value [3 /Fit] in the /Dests name tree), a button "vai" whose GoTo leads to
 * page 3, and an annotation whose /AA leads to page 2; page 2's /AA opens on page 4; bookmarks
 * "Tre" ([2 /Fit]), "Quattro" (a GoTo [3 /XYZ 0 800 0]) and "Due" ([1 /Fit]); the OpenAction
 * [3 /Fit]; and a link on page 2 whose GoToR names page 1 of another file (a number, as it should).
 */
function numberedPdf(): Uint8Array {
  const d = openPdf(plainPdf(["Pagina 1", "Pagina 2", "Pagina 3", "Pagina 4"]));
  const dest = (n: number, ...tail: (string | number)[]) => {
    const a = d.newArray();
    a.push(n);
    for (const t of tail) a.push(typeof t === "string" ? d.newName(t) : t);
    return a;
  };
  const goTo = (D: Obj) => d.addObject({ S: "GoTo", D });
  const list = (...objs: Obj[]) => {
    const a = d.newArray();
    for (const o of objs) a.push(o);
    return a;
  };
  const [p1, p2] = [d.findPage(0), d.findPage(1)];
  const annot = (page: Obj, y: number, entries: Record<string, unknown>) => {
    const a = d.addObject({ Type: "Annot", Subtype: "Link", Rect: [72, y, 300, y + 20], Border: [0, 0, 0], ...entries });
    a.put("P", page);
    return a;
  };
  const vai = annot(p1, 540, { Subtype: "Widget", FT: "Btn", Ff: 65536, T: d.newString("vai"), A: goTo(dest(2, "Fit")) });
  p1.put("Annots", list(
    annot(p1, 700, { Dest: dest(2, "Fit") }),
    annot(p1, 660, { Dest: dest(3, "Fit") }),
    annot(p1, 620, { A: goTo(dest(1, "XYZ", 0, 800, 0)) }),
    annot(p1, 580, { Dest: d.newString("n4") }),
    vai,
    annot(p1, 500, { Subtype: "Square", AA: d.addObject({ E: goTo(dest(1, "Fit")) }) }),
  ));
  p2.put("AA", d.addObject({ O: goTo(dest(3, "Fit")) }));
  p2.put("Annots", list(annot(p2, 700, { A: d.addObject({ S: "GoToR", F: d.newString("altro.pdf"), D: dest(0, "Fit") }) })));
  const r = root(d);
  r.put("AcroForm", d.addObject({ Fields: list(vai) }));
  r.put("Names", d.addObject({ Dests: d.addObject({ Names: list(d.newString("n4"), dest(3, "Fit")) }) }));
  r.put("OpenAction", dest(3, "Fit"));
  const outlines = d.addObject({ Type: "Outlines" });
  const marks = [
    d.addObject({ Title: d.newString("Tre"), Dest: dest(2, "Fit") }),
    d.addObject({ Title: d.newString("Quattro"), A: goTo(dest(3, "XYZ", 0, 800, 0)) }),
    d.addObject({ Title: d.newString("Due"), Dest: dest(1, "Fit") }),
  ];
  marks.forEach((m, k) => {
    m.put("Parent", outlines);
    if (k) m.put("Prev", marks[k - 1]);
    if (k < marks.length - 1) m.put("Next", marks[k + 1]);
  });
  outlines.put("First", marks[0]);
  outlines.put("Last", marks[2]);
  outlines.put("Count", 3);
  r.put("Outlines", outlines);
  return saveBytes(d);
}

/** The index of the page a destination leads to (a page object or a number), or null. */
function destIndex(doc: Doc, d: Obj): number | null {
  for (let depth = 0; depth < 8 && d.isDictionary(); depth++) d = d.get("D");
  if (!d.isArray() || d.length === 0) return null;
  const first = d.get(0);
  if (first.isInteger()) return first.asNumber();
  return first.isIndirect() ? pageObjectNumbers(doc).indexOf(first.asIndirect()) : null;
}

/** Where the button "vai" on page `i` leads (its GoTo), null when it has no action. */
function buttonTarget(doc: Doc, i: number): number | null {
  const vai = annotsOf(doc, i).find((a) => fullName(a) === "vai")!;
  return vai.get("A").isNull() ? null : destIndex(doc, vai.get("A").get("D"));
}

/** The first element of every local destination the fixture has (bookmarks, links, actions, names, OpenAction), as "page" or the number. */
function firstElements(doc: Doc): string[] {
  const out: string[] = [];
  const add = (d: Obj) => {
    for (let depth = 0; depth < 8 && d.isDictionary(); depth++) d = d.get("D");
    if (d.isArray() && d.length) out.push(d.get(0).isIndirect() ? "page" : d.get(0).toString());
  };
  const action = (a: Obj) => {
    if (a.isDictionary() && nameOf(a.get("S")) === "GoTo") add(a.get("D"));
  };
  const actions = (aa: Obj) => {
    if (aa.isDictionary()) aa.forEach((a) => action(a));
  };
  for (let i = 0; i < doc.countPages(); i++) {
    for (const a of annotsOf(doc, i)) {
      add(a.get("Dest"));
      action(a.get("A"));
      actions(a.get("AA"));
    }
    actions(doc.findPage(i).get("AA"));
  }
  const outlines = root(doc).get("Outlines");
  for (let m = outlines.isDictionary() ? outlines.get("First") : outlines; m.isDictionary(); m = m.get("Next")) {
    add(m.get("Dest"));
    action(m.get("A"));
  }
  const tree = root(doc).get("Names");
  const dests = tree.isDictionary() ? tree.get("Dests") : tree;
  const names = dests.isDictionary() ? dests.get("Names") : dests;
  for (let i = 1; i < (names.isArray() ? names.length : 0); i += 2) add(names.get(i));
  add(root(doc).get("OpenAction"));
  return out;
}

describe("destinations that name their page by number", () => {
  const NUMBERED = numberedPdf();
  const numbered = () => openPdf(NUMBERED);

  it("the fixture is what the tests expect (MuPDF reads the numbers as pages)", () => {
    const d = numbered();
    expect(links(d, 0)).toEqual([2, 3, 1, 3]);
    expect(outline(d)).toEqual(["Tre->2", "Quattro->3", "Due->1"]);
    expect(buttonTarget(d, 0)).toBe(2);
    // Page 1's links, button and note; page 2's /AA; the bookmarks; n4; the OpenAction.
    expect(firstElements(d)).toEqual(["2", "3", "1", "2", "1", "3", "2", "3", "1", "3", "3"]);
    expect(d.resolveLink("#nameddest=n4")).toBe(3);
  });

  // The session logs an insert as a copy of the other PDF kept to the chosen pages (review P6):
  // through it, the links, buttons and bookmarks of the chosen pages must lead where an insert
  // from the whole file sends them (the review's cases: the link to page 4 lost for [0, 3], sent
  // to the wrong page for [0, 2, 3], a link to a page not chosen sent to another for [0, 1, 3]).
  const cases: [number[], (number | string)[], number | null, string, number][] = [
    // chosen, links of the copy of page 1 (at index 1, or 2 for [3, 0]), the button's target, the bookmarks, links removed
    [[0, 3], [2, 2], null, "Altro->1[Quattro->2]", 3],
    [[0, 2, 3], [2, 3, 3], 2, "Altro->1[Tre->2,Quattro->3]", 1],
    [[0, 1, 3], [3, 2, 3], null, "Altro->1[Quattro->3,Due->2]", 2],
    [[3, 0], [1, 1], null, "Altro->1[Quattro->1]", 3],
  ];
  it.each(cases)("pages %j: a copy kept to them inserts as the whole file", (chosen, pageLinks, button, bookmarks, removed) => {
    const where = chosen.indexOf(0) + 1;
    const whole = openPdf(plainPdf(["Uno", "Due"]));
    const expected = insertPages(mupdf, whole, numbered(), chosen, 1, "Altro").report;
    expect(expected.linksRemoved).toBe(removed);
    const copy = numbered();
    const kept = keepPages(mupdf, copy, chosen);
    // The copy's destinations name page objects now: its pages are numbered again.
    const firsts = firstElements(copy);
    expect(firsts.length).toBeGreaterThan(0);
    expect(firsts.every((f) => f === "page"), firsts.join(" ")).toBe(true);
    const part = saveBytes(copy, SAVE_OPTIONS);
    const others = [0, 1, 2, 3].filter((p) => !chosen.includes(p)).map((p) => `Pagina ${p + 1}`);
    expect(found(part, others)).toEqual(Object.fromEntries(others.map((s) => [s, 0])));
    const sorted = [...chosen].sort((x, y) => x - y);
    const viaCopy = openPdf(plainPdf(["Uno", "Due"]));
    const report = insertPages(mupdf, viaCopy, openPdf(part), chosen.map((p) => sorted.indexOf(p)), 1, "Altro").report;
    const [a, b] = [reopen(whole), reopen(viaCopy)];
    expect(links(a, where)).toEqual(pageLinks);
    expect(buttonTarget(a, where)).toBe(button);
    expect(outline(a)).toEqual([bookmarks]);
    expect(texts(b)).toEqual(texts(a));
    for (let i = 0; i < a.countPages(); i++) expect(links(b, i), `links of page ${i + 1}`).toEqual(links(a, i));
    expect(buttonTarget(b, where)).toBe(button);
    expect(outline(b)).toEqual(outline(a));
    expect(kept.report.linksRemoved - (kept.bookmarksRemoved ?? 0) + report.linksRemoved).toBe(removed);
  });

  it("an insert through the session sends them where the whole file does (pages 1, 2 and 4)", () => {
    const whole = openPdf(plainPdf(["Uno", "Due"]));
    insertPages(mupdf, whole, numbered(), [0, 1, 3], 1, "Altro");
    const s = engine(plainPdf(["Uno", "Due"]));
    const source = s.openSource(NUMBERED);
    if (!source.ok) throw new Error(source.reason);
    expect(s.editPages({ kind: "insert", at: 1, source: source.source, pages: [0, 1, 3], title: "Altro" }).report.linksRemoved).toBe(2);
    const check = () => {
      const r = openPdf(new Uint8Array(s.save().bytes));
      for (let i = 0; i < r.countPages(); i++) expect(links(r, i), `links of page ${i + 1}`).toEqual(links(whole, i));
      expect(links(r, 1)).toEqual([3, 2, 3]);
      expect(outline(r)).toEqual(outline(whole));
    };
    check();
    s.undo();
    s.redo(); // replayed from the logged part
    check();
    s.close();
  });

  it("a delete takes them as references to their pages: gone with the page, pinned to the page object otherwise", () => {
    // Page 3: the link to it, the button's GoTo and the bookmark "Tre" go; the rest is pinned.
    const d = numbered();
    expect(deletePages(mupdf, d, [2]).report.linksRemoved).toBe(3);
    expect(firstElements(d)).toEqual(Array(8).fill("page"));
    for (const r of [d, reopen(d)]) {
      expect(links(r, 0)).toEqual([2, 1, 2]);
      expect(buttonTarget(r, 0)).toBeNull();
      expect(outline(r)).toEqual(["Quattro->2", "Due->1"]);
      expect(destIndex(r, root(r).get("OpenAction"))).toBe(2);
      expect(destIndex(r, r.findPage(1).get("AA").get("O").get("D"))).toBe(2);
    }
    // Page 4: the links to it (the number, the name n4), "Quattro", the OpenAction, page 2's /AA and n4 itself.
    const e = numbered();
    expect(deletePages(mupdf, e, [3]).report.linksRemoved).toBe(3);
    for (const r of [e, reopen(e)]) {
      expect(links(r, 0)).toEqual([2, 1]);
      expect(buttonTarget(r, 0)).toBe(2);
      expect(outline(r)).toEqual(["Tre->2", "Due->1"]);
      expect(root(r).get("OpenAction").isNull()).toBe(true);
      expect(r.findPage(1).get("AA").isNull()).toBe(true);
      expect(treeKeys(root(r).get("Names").get("Dests"), "Names")).toEqual([]);
    }
    // Page 1: every number names another page now (the bookmark "Tre" would have led to page 4).
    const f = numbered();
    expect(deletePages(mupdf, f, [0]).report.linksRemoved).toBe(0);
    for (const r of [f, reopen(f)]) {
      expect(outline(r)).toEqual(["Tre->1", "Quattro->2", "Due->0"]);
      expect(destIndex(r, root(r).get("OpenAction"))).toBe(2);
      expect(destIndex(r, r.findPage(0).get("AA").get("O").get("D"))).toBe(2);
      expect(r.resolveLink("#nameddest=n4")).toBe(2);
    }
    // The GoToR names a page of the other file: left as it was.
    const goToR = (r: Doc) => annotsOf(r, 0)[0].get("A");
    expect(nameOf(goToR(f).get("S"))).toBe("GoToR");
    expect(goToR(f).get("D").get(0).isInteger()).toBe(true);
    expect(goToR(f).get("D").get(0).asNumber()).toBe(0);
  });

  it("an extract keeps them leading to the pages kept", () => {
    const d = numbered();
    keepPages(mupdf, d, [0, 3]);
    for (const r of [d, reopen(d)]) {
      expect(texts(r)).toEqual(["Pagina 1", "Pagina 4"]);
      expect(links(r, 0)).toEqual([1, 1]);
      expect(outline(r)).toEqual(["Quattro->1"]);
      expect(destIndex(r, root(r).get("OpenAction"))).toBe(1);
    }
  });

  // The other operations renumber pages too: a number would then name another page.
  const renumbering: [string, (d: Doc) => unknown, number, (number | string)[], string[]][] = [
    // operation, where page 1 is then, its links, the bookmarks
    ["move", (d) => movePages(mupdf, d, [3, 2, 1, 0]), 3, [1, 0, 2, 0], ["Tre->1", "Quattro->0", "Due->2"]],
    ["blank page first", (d) => insertBlankPages(mupdf, d, 0, [[300, 300]]), 1, [3, 4, 2, 4], ["Tre->3", "Quattro->4", "Due->2"]],
    ["copy first", (d) => duplicatePages(mupdf, d, [0], 0), 1, [3, 4, 2, 4], ["Tre->3", "Quattro->4", "Due->2"]],
    ["another PDF first", (d) => insertPages(mupdf, d, openPdf(plainPdf(["Altra"])), "all", 0, "Altra"), 1, [3, 4, 2, 4], ["Altra->0", "Tre->3", "Quattro->4", "Due->2"]],
  ];
  it.each(renumbering)("%s: they keep leading to the same pages", (_, op, at, pageLinks, bookmarks) => {
    const d = numbered();
    op(d);
    const four = texts(d).indexOf("Pagina 4");
    for (const r of [d, reopen(d)]) {
      expect(links(r, at)).toEqual(pageLinks);
      expect(outline(r)).toEqual(bookmarks);
      expect(buttonTarget(r, at)).toBe(texts(r).indexOf("Pagina 3"));
      expect(destIndex(r, root(r).get("OpenAction"))).toBe(four);
      expect(r.resolveLink("#nameddest=n4")).toBe(four);
    }
    // A copy's links lead where the original's do.
    if (texts(d).filter((t) => t === "Pagina 1").length > 1) expect(links(d, 0)).toEqual(pageLinks);
  });

  it("pinning them stays linear on a long document with links, bookmarks and names on every page", () => {
    /** `n` pages, each with four links (two by number, two by page object), a bookmark by number and a named destination. */
    const make = (n: number) => {
      const d = openPdf(plainPdf(Array.from({ length: n }, (_, i) => `Pagina ${i + 1}`)));
      const objs = Array.from({ length: n }, (_, i) => d.findPage(i));
      const outlines = d.addObject({ Type: "Outlines" });
      const names = d.newArray();
      let prev: Obj | null = null;
      for (let i = 0; i < n; i++) {
        const annots = d.newArray();
        for (const [k, target] of [(i + 1) % n, (i + 7) % n, (i + n - 1) % n, (i * 3) % n].entries()) {
          const dest = d.newArray();
          dest.push(k < 2 ? target : objs[target]);
          dest.push(d.newName("Fit"));
          annots.push(d.addObject({ Type: "Annot", Subtype: "Link", Rect: [72, 700 - k * 30, 300, 720 - k * 30], Dest: dest, P: objs[i] }));
        }
        objs[i].put("Annots", annots);
        const dest = d.newArray();
        dest.push((i + 2) % n);
        dest.push(d.newName("Fit"));
        const mark: Obj = d.addObject({ Title: d.newString(`Capitolo ${i + 1}`), Parent: outlines, Dest: dest });
        if (prev) {
          prev.put("Next", mark);
          mark.put("Prev", prev);
        } else outlines.put("First", mark);
        prev = mark;
        names.push(d.newString(`p${String(i).padStart(5, "0")}`));
        names.push(dest);
      }
      outlines.put("Last", prev!);
      outlines.put("Count", n);
      root(d).put("Outlines", outlines);
      root(d).put("Names", d.addObject({ Dests: d.addObject({ Names: names }) }));
      return saveBytes(d);
    };
    const sizes = [600, 2000];
    const best = sizes.map((n) => {
      const bytes = make(n);
      let ms = Infinity;
      for (let k = 0; k < 3; k++) {
        const d = openPdf(bytes);
        const t0 = performance.now();
        movePages(mupdf, d, Array.from({ length: n }, (_, i) => (i === 0 ? 1 : i === 1 ? 0 : i)));
        ms = Math.min(ms, performance.now() - t0);
        // Page 1 is second now; its links lead to pages 2, 8, n and 1 as they did.
        expect(links(d, 1)).toEqual([0, 7, n - 1, 1]);
      }
      return ms;
    });
    console.log(`numbered destinations: one page one place down, links on every page: ${sizes.map((n, k) => `${n} pages ${best[k].toFixed(0)} ms`).join(", ")}`);
    expect(best[1]).toBeLessThan(6 * Math.max(best[0], 15));
    expect(best[1]).toBeLessThan(3000);
  });

  it("an insert leaves the other PDF as it was, numbers and all", () => {
    const src = numbered();
    const before = saveBytes(src, "");
    insertPages(mupdf, openPdf(plainPdf(["Uno"])), src, [0, 3], 1, null);
    expect(saveBytes(src, "")).toEqual(before);
  });
});

// ---------------------------------------------------------------------------------------------
// Long documents (review P8): MuPDF's deletePage and insertPage each cost time in proportion to
// the page count, so an operation must not call them once per page.

describe("long documents", () => {
  const sizes = [600, 2000];
  const docs = new Map(sizes.map((n) => [n, plainPdf(Array.from({ length: n }, (_, i) => `Pagina ${i + 1}`))]));
  /** Counts the calls of MuPDF's deletePage and insertPage on this document. */
  const spy = (d: Doc) => {
    const calls = { n: 0 };
    const target = d as unknown as Record<string, (...args: unknown[]) => unknown>;
    for (const m of ["deletePage", "insertPage"]) {
      const original = target[m].bind(d);
      target[m] = (...args: unknown[]) => {
        calls.n++;
        return original(...args);
      };
    }
    return calls;
  };
  const ops: [string, (d: Doc, n: number, other: Doc) => unknown, (n: number) => number][] = [
    ["one page one place down", (d, n) => movePages(mupdf, d, Array.from({ length: n }, (_, i) => (i === 0 ? 1 : i === 1 ? 0 : i))), (n) => n],
    ["the last page first", (d, n) => movePages(mupdf, d, Array.from({ length: n }, (_, i) => (i + n - 1) % n)), (n) => n],
    ["every page reversed", (d, n) => movePages(mupdf, d, Array.from({ length: n }, (_, i) => n - 1 - i)), (n) => n],
    ["one page deleted", (d, n) => deletePages(mupdf, d, [n >> 1]), (n) => n - 1],
    ["every other page deleted", (d, n) => deletePages(mupdf, d, Array.from({ length: n >> 1 }, (_, i) => i * 2)), (n) => n - (n >> 1)],
    ["one page kept (extract)", (d, n) => keepPages(mupdf, d, [n >> 1]), () => 1],
    ["every page duplicated", (d, n) => duplicatePages(mupdf, d, Array.from({ length: n }, (_, i) => i), n), (n) => 2 * n],
    ["as many blank pages", (d, n) => insertBlankPages(mupdf, d, 1, Array.from({ length: n }, () => [595, 842] as [number, number])), (n) => 2 * n],
    ["every page of another copy", (d, n, other) => insertPages(mupdf, d, other, "all", n >> 1, null), (n) => 2 * n],
  ];
  it.each(ops)("%s: in time linear in the pages, without MuPDF's per-page calls", (label, op, count) => {
    const best = sizes.map((n) => {
      let ms = Infinity;
      for (let k = 0; k < 3; k++) {
        const d = openPdf(docs.get(n)!);
        const other = openPdf(docs.get(n)!);
        const calls = [spy(d), spy(other)];
        const t0 = performance.now();
        op(d, n, other);
        ms = Math.min(ms, performance.now() - t0);
        expect(calls.map((c) => c.n)).toEqual([0, 0]);
        expect(d.countPages()).toBe(count(n));
      }
      return ms;
    });
    console.log(`long documents: ${label}: ${sizes.map((n, k) => `${n} pages ${best[k].toFixed(0)} ms`).join(", ")}`);
    // Linear: 2000 pages take about 3.3 times as long as 600 (it was 8 to 10 times, and growing);
    // the floor keeps timer noise on short runs from failing the test.
    expect(best[1]).toBeLessThan(6 * Math.max(best[0], 15));
    expect(best[1]).toBeLessThan(3000);
  });

  it("every page is where it should be after a shuffle, a delete and an insert on a long document", () => {
    const d = openPdf(docs.get(600)!);
    const order = Array.from({ length: 600 }, (_, k) => (k * 7) % 600); // 7 and 600 have no common factor: a permutation
    movePages(mupdf, d, order);
    deletePages(mupdf, d, Array.from({ length: 100 }, (_, k) => k * 6));
    insertBlankPages(mupdf, d, 250, [[100, 100]]);
    const expected = order.filter((_, k) => k % 6 !== 0).map((p) => `Pagina ${p + 1}`);
    expected.splice(250, 0, "");
    expect(texts(d)).toEqual(expected);
    expect(texts(reopen(d))).toEqual(expected);
  });
});

describe("the repo fixtures", () => {
  const names = readdirSync(new URL("./fixtures/", import.meta.url)).filter((n) => n.endsWith(".pdf") && !n.startsWith("enc-"));
  it.each(names)("%s: every operation, then the engine opens it", (name) => {
    const bytes = fixture(name);
    const d = openPdf(bytes);
    const n = d.countPages();
    rotatePages(mupdf, d, [0], 90);
    duplicatePages(mupdf, d, [0], n);
    movePages(mupdf, d, Array.from({ length: n + 1 }, (_, i) => n - i));
    insertPages(mupdf, d, openPdf(bytes), [0], 1, name);
    insertBlankPages(mupdf, d, 0, [[595, 842]]);
    deletePages(mupdf, d, [0]);
    // Now: the copy of page 1 (turned), page 1 from the source, the other pages in reverse, page 1 (turned).
    expect(d.countPages()).toBe(n + 2);
    const s = engine(saveBytes(d, SAVE_OPTIONS));
    const original = engine(bytes);
    const firstLines = original.lines(0).map((l) => l.text);
    for (const i of [0, 1, n + 1]) expect(s.lines(i).map((l) => l.text), `page ${i}`).toEqual(firstLines);
    if (n > 1) expect(s.lines(2).map((l) => l.text)).toEqual(original.lines(n - 1).map((l) => l.text));
    s.close();
    original.close();
  });
});
