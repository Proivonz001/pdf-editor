// Cerca through EngineSession (release 5), in Node on the worker's mupdf build: the search is
// stateless steps the client drives (from a page up to another, within a time budget and a number
// of hits; cancelled by not asking for the next one; wrapped by the client), over a cache of page
// texts that follows the history: a page is read once, read again only after a step changed it (a
// line edit, a field filled in, a redaction, their undo), moved with its page by a page operation
// (a turned or new page is read again), and the cache is emptied with the document. Every request
// is checked. search.ts itself is tested in search.test.ts.
import * as mupdf from "mupdf";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_SEARCH_CHARS, type SearchHit, type TextStyle } from "../src/engine/protocol";
import { areasForQuads } from "../src/engine/redactGeometry";
import { EngineSession, MAX_SEARCH_HITS, SessionError } from "../src/engine/session";
import { formPdf, plainPdf, smallPng } from "./helpers/richPdf";

/** The pages search.readPageText read (the cache's misses), in order; `bytes`, when set, is the size each text says it takes. */
const reads = vi.hoisted(() => ({ pages: [] as number[], bytes: 0 }));
vi.mock("../src/engine/search", async (importOriginal) => {
  const search = await importOriginal<typeof import("../src/engine/search")>();
  return {
    ...search,
    readPageText: (...args: Parameters<typeof search.readPageText>) => {
      reads.pages.push(args[2]);
      const text = search.readPageText(...args);
      return reads.bytes ? { ...text, bytes: reads.bytes } : text;
    },
  };
});
// The clock stands still (every step reads all it is asked to), but where a test moves it.
beforeEach(() => ticking(0));
afterEach(() => {
  vi.restoreAllMocks();
});

const SANS: TextStyle = { size: 12, color: [0, 0, 0], family: "sans", bold: false, italic: false };

function session(bytes: Uint8Array) {
  const s = new EngineSession(mupdf);
  const opened = s.open(bytes);
  if (!opened.ok) throw new Error(`did not open: ${opened.reason}`);
  reads.pages = [];
  reads.bytes = 0;
  return s;
}

function errorOf(fn: () => unknown): SessionError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(SessionError);
    return e as SessionError;
  }
  throw new Error("expected a SessionError");
}

/** Where the hits are and what they read: page, match and the text after it. */
const where = (hits: SearchHit[]) => hits.map((h) => `${h.pageIndex}:${h.match}${h.after}`);

/** A clock that moves `ms` every time it is read (the step reads it before and after each page). */
function ticking(ms: number) {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => (now += ms));
}

describe("steps", () => {
  it("finds hits page by page; from a page to the end, then from the start back to it, is the whole", () => {
    const s = session(plainPdf(["Mario Rossi", "Pagina due", "Luigi Rossi e Anna ROSSI", "Ultima"]));
    s.addText(1, [72, 300], "Università di Roma", SANS);
    const all = s.search("rossi", 0);
    expect(all.next).toBeNull();
    expect(all.truncated).toBe(false);
    expect(where(all.hits)).toEqual(["0:Rossi", "2:Rossi e Anna ROSSI", "2:ROSSI"]);
    expect(all.hits.every((h) => h.in === "page" && h.quads.length === 1)).toBe(true);
    const tail = s.search("rossi", 2), head = s.search("rossi", 0, { to: 2 });
    expect(head.next).toBeNull();
    expect([...tail.hits, ...head.hits].map((h) => h.pageIndex).sort()).toEqual([0, 2, 2]);
    // Accents ignored by default; counted with matchDiacritics.
    expect(where(s.search("universita", 0).hits)).toEqual(["1:Università di Roma"]);
    expect(s.search("universita", 0, { options: { matchDiacritics: true } }).hits).toEqual([]);
    expect(s.search("ROSSI", 0, { options: { caseSensitive: true } }).hits.map((h) => h.pageIndex)).toEqual([2]);
    // A query is trimmed and cut at MAX_SEARCH_CHARS; one left empty finds nothing.
    expect(s.search(`  Rossi${" ".repeat(MAX_SEARCH_CHARS)}zzz`, 0).hits).toHaveLength(3);
    expect(s.search(" ­ ", 0)).toEqual({ hits: [], next: null, truncated: false });
    expect(s.search("rossi", 4)).toEqual({ hits: [], next: null, truncated: false });
  });

  it("a step reads at least one page, then stops once its budget is spent (5..200 ms, default 20)", () => {
    const s = session(plainPdf(Array.from({ length: 30 }, (_, k) => `Pagina ${k} Rossi`)));
    ticking(10);
    expect(s.search("rossi", 0, { budgetMs: 1 }).next).toBe(1); // (5 ms: one page)
    expect(s.search("rossi", 5).next).toBe(7); // (20 ms: two pages)
    expect(s.search("rossi", 0, { budgetMs: 1e9 }).next).toBe(20); // (200 ms: 20 pages)
    expect(s.search("rossi", 25, { budgetMs: 1e9 }).next).toBeNull();
    // Stepping on from `next` gives what one search of everything gives.
    const stepped: SearchHit[] = [];
    for (let from: number | null = 0; from !== null; ) {
      const step = s.search("rossi", from, { budgetMs: 5 });
      expect(step.hits.every((h) => h.pageIndex === from)).toBe(true);
      stepped.push(...step.hits);
      from = step.next;
    }
    ticking(0);
    expect(stepped).toEqual(s.search("rossi", 0).hits);
    expect(stepped).toHaveLength(30);
  });

  it("at most maxHits a step (and MAX_SEARCH_HITS): truncated says the last page read had more", () => {
    const s = session(plainPdf(["Rossi Rossi Rossi Rossi Rossi", "Rossi", "Rossi"]));
    expect(MAX_SEARCH_HITS).toBe(10_000);
    expect(s.search("rossi", 0, { maxHits: 3 })).toMatchObject({ next: 1, truncated: true });
    expect(s.search("rossi", 0, { maxHits: 3 }).hits).toHaveLength(3);
    expect(s.search("rossi", 0, { maxHits: 5 })).toMatchObject({ next: 1, truncated: false });
    expect(s.search("rossi", 0, { maxHits: 6 })).toMatchObject({ next: 2, truncated: false });
    expect(s.search("rossi", 0, { maxHits: 50_000 })).toMatchObject({ next: null, truncated: false });
    expect(s.search("rossi", 0, { maxHits: 50_000 }).hits).toHaveLength(7);
  });

  it("is stateless: a step of another query in between changes nothing (cancelling is not asking for more)", () => {
    const s = session(plainPdf(["Mario Rossi", "Pagina due", "Luigi Rossi"]));
    const first = s.search("rossi", 0, { to: 1 });
    expect(s.search("pagina", 0).hits).toHaveLength(1);
    const rest = s.search("rossi", first.next ?? 1);
    expect([...first.hits, ...rest.hits]).toEqual(s.search("rossi", 0).hits);
  });

  it("checks every request", () => {
    const s = session(plainPdf(["Mario Rossi", "Pagina due"]));
    const bad = (query: unknown, from: unknown, opts: unknown = {}) =>
      expect(errorOf(() => s.search(query as string, from as number, opts as Parameters<EngineSession["search"]>[2])).code).toBe("bad-request");
    bad(5, 0);
    bad(null, 0);
    bad("rossi", -1);
    bad("rossi", 0.5);
    bad("rossi", 3);
    bad("rossi", "0");
    bad("rossi", 1, { to: 0 });
    bad("rossi", 0, { to: 3 });
    bad("rossi", 0, { budgetMs: "20" });
    bad("rossi", 0, { budgetMs: Number.NaN });
    bad("rossi", 0, { maxHits: 0 });
    bad("rossi", 0, { maxHits: -1 });
    bad("rossi", 0, { maxHits: 2.5 });
    bad("rossi", 0, { options: "wholeWord" });
    bad("rossi", 0, { options: { wholeWord: 1 } });
    expect(s.search("rossi", 0, { options: { wholeWord: true, caseSensitive: false } }).hits).toHaveLength(1);
    s.close();
    expect(errorOf(() => s.search("rossi", 0)).code).toBe("no-document");
  });
});

describe("the page texts follow the history", () => {
  it("a page is read once; an edit, its undo and redo read only the page they changed again", () => {
    const s = session(plainPdf(["Mario Rossi", "Pagina due", "Luigi Rossi"]));
    expect(s.search("rossi", 0).hits.map((h) => h.pageIndex)).toEqual([0, 2]);
    expect(s.search("pagina", 0).hits).toHaveLength(1);
    expect(reads.pages).toEqual([0, 1, 2]);
    s.replaceLine(0, 0, "Mario Bianchi");
    expect(s.search("rossi", 0).hits.map((h) => h.pageIndex)).toEqual([2]);
    expect(where(s.search("bianchi", 0).hits)).toEqual(["0:Bianchi"]);
    s.undo();
    expect(s.search("rossi", 0).hits.map((h) => h.pageIndex)).toEqual([0, 2]);
    s.redo();
    expect(s.search("bianchi", 0).hits).toHaveLength(1);
    expect(reads.pages).toEqual([0, 1, 2, 0, 0, 0]);
    s.addText(2, [72, 300], "Rossi aggiunto", SANS);
    expect(s.search("rossi", 0).hits.map((h) => h.pageIndex)).toEqual([2, 2]);
    expect(reads.pages.slice(6)).toEqual([2]);
  });

  it("a field filled in is found in the field; Oscura over every hit leaves none", () => {
    const s = session(formPdf());
    expect(s.search("zanzibar", 0).hits).toEqual([]);
    s.setField("nome", { kind: "text", text: "Zanzibar" });
    const [hit] = s.search("zanzibar", 0).hits;
    expect(hit).toMatchObject({ pageIndex: 0, in: "field", field: "nome", match: "Zanzibar" });

    const t = session(plainPdf(["Mario Rossi e Rossi", "Pagina due Rossi"]));
    const hits = t.search("rossi", 0).hits;
    expect(hits).toHaveLength(3);
    const areas = [0, 1].map((p) => ({ pageIndex: p, rects: hits.filter((h) => h.pageIndex === p).flatMap((h) => areasForQuads(h.quads)) }));
    expect(t.redact(areas, "redact").changedPages).toEqual([0, 1]);
    expect(t.search("rossi", 0).hits).toEqual([]);
    expect(where(t.search("mario", 0).hits)).toEqual(["0:Mario e"]);
    expect(where(t.search("pagina", 0).hits)).toEqual(["1:Pagina due"]);
    t.undo();
    expect(t.search("rossi", 0).hits).toHaveLength(3);
  });

  it("a page operation moves the texts with their pages; turned and new pages are read again", () => {
    const s = session(plainPdf(["Pagina Alfa", "Pagina Beta", "Pagina Gamma"]));
    const order = () => s.search("pagina", 0).hits.map((h) => `${h.pageIndex}:${h.after.trim()}`);
    expect(order()).toEqual(["0:Alfa", "1:Beta", "2:Gamma"]);
    expect(reads.pages).toEqual([0, 1, 2]);
    s.editPages({ kind: "move", order: [2, 0, 1] });
    expect(order()).toEqual(["0:Gamma", "1:Alfa", "2:Beta"]);
    s.editPages({ kind: "delete", pages: [0] });
    expect(order()).toEqual(["0:Alfa", "1:Beta"]);
    s.undo();
    s.undo();
    expect(order()).toEqual(["0:Alfa", "1:Beta", "2:Gamma"]);
    expect(reads.pages).toEqual([0, 1, 2, 2]); // (the deleted page came back, at its old place: read again)
    s.editPages({ kind: "blank", at: 0 });
    expect(order()).toEqual(["1:Alfa", "2:Beta", "3:Gamma"]);
    const before = s.search("beta", 0).hits[0].quads[0];
    s.editPages({ kind: "rotate", pages: [2], by: 90 });
    const after = s.search("beta", 0).hits[0].quads[0];
    expect(after).not.toEqual(before);
    expect(reads.pages.slice(4)).toEqual([0, 2]);
  });

  it("past its 32 MB, the cache keeps the pages it has: a search reads only the rest again", () => {
    const s = session(plainPdf(Array.from({ length: 40 }, (_, k) => `Pagina ${k}`)));
    reads.bytes = 1024 * 1024; // (each page's text says 1 MB: 32 of the 40 pages fit)
    /** As the runner searches: from page `start` to the end, then from the first page back to it (the clock stands still: one step each). */
    const run = (query: string, start: number) => [...s.search(query, start).hits, ...s.search(query, 0, { to: start }).hits];
    const rest = Array.from({ length: 8 }, (_, k) => 32 + k);
    expect(s.search("pagina", 0).hits).toHaveLength(40);
    expect(reads.pages).toEqual(Array.from({ length: 40 }, (_, k) => k));
    reads.pages = [];
    expect(s.search("pagin", 0).hits).toHaveLength(40);
    expect(reads.pages).toEqual(rest); // (not all 40: the first ones read were not pushed out by the last)
    reads.pages = [];
    expect(run("pagi", 10)).toHaveLength(40);
    expect(reads.pages).toEqual(rest);
    // A page an edit changed leaves the cache and makes room: read again, it is kept.
    s.addText(5, [72, 300], "Aggiunta", SANS);
    reads.pages = [];
    s.search("pagina", 0);
    expect(reads.pages).toEqual([5, ...rest]);
    reads.pages = [];
    s.search("pagina", 0);
    expect(reads.pages).toEqual(rest);
  });

  it("a new document empties the cache: open, newFromPictures, resumeSession, close", () => {
    const s = session(plainPdf(["Alfa"]));
    expect(s.search("alfa", 0).hits).toHaveLength(1);
    s.open(plainPdf(["Beta"]));
    expect(s.search("alfa", 0).hits).toEqual([]);
    expect(s.search("beta", 0).hits).toHaveLength(1);
    s.addText(0, [72, 300], "Gamma", SANS);
    const kept = s.exportSession()!;
    const png = smallPng();
    s.newFromPictures([{ bytes: png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer, width: 60, height: 30, dpi: 72 }]);
    expect(s.search("beta", 0).hits).toEqual([]);
    const resumed = s.resumeSession(kept.original, kept.log);
    expect(resumed.ok).toBe(true);
    expect(s.search("gamma", 0).hits).toHaveLength(1);
    expect(s.search("beta", 0).hits).toHaveLength(1);
  });
});
