// Cerca in the UI (release 5) against the app's real modules with a fake engine that finds a word
// in page texts the test sets (no browser): the runner (steps from the current page to the end,
// then from the first page, hits in page order, the first one found current; at most 1000 with
// "more than 1000"; a new query cancelling the old one's steps; after an edit only its pages read
// again, the current hit following; a page operation starting over (quietly once the run's end
// was said, else showing and saying its result), a layout that keeps every page reading its pages
// again; the cap judged when hits come in, also with pages read again meanwhile, and a run stopped
// at the cap starting over when an edit leaves fewer; a page the engine cannot read skipped and
// said; rerunSearch quiet; a failure said; another document forgetting it all), the bar's logic
// (searching once typing pauses or on Enter, next and previous wrapping and said, the count and
// the note, the options searching again, the options menu and "Oscura tutti i risultati…",
// closing and opening again, Enter and Escape of an input method left alone, the phone's note
// shown, the find bar's height not following the count), the keys (Ctrl+F also from a text field,
// F3 and Ctrl+G, Escape in Bianchetto and Oscura), the rail's Cerca, the phone's bars hidden while
// the field takes typing, and the highlights on a page.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Rect, SearchHit, SearchOptions } from "../src/engine/protocol";
import "./stubs/browser-globals";

/**
 * Hooks outside a render (no DOM here), so the bars can be called as functions to see what they
 * show: state from `hooks.state` when set (else its first value), its setter noted in `sets`;
 * refs that stay empty, ids, effects that do not run.
 */
const hooks = vi.hoisted(() => ({ state: undefined as unknown, sets: [] as unknown[], ids: 0 }));
vi.mock("preact/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("preact/hooks")>()),
  useState: (init: unknown) => [hooks.state ?? init, (v: unknown) => {
    hooks.sets.push(v);
  }],
  useRef: (init: unknown) => ({ current: init }),
  useId: () => `id${++hooks.ids}`,
  useEffect: () => undefined,
  useLayoutEffect: () => undefined,
}));

vi.mock("../src/engine/client.ts", () => {
  class EngineError extends Error {
    constructor(message: string, readonly code?: string) {
      super(message);
    }
  }
  const e = () => (globalThis as any).__searchEngine;
  class EngineClient {
    ready = Promise.resolve();
    search(query: string, from: number, opts: unknown) { return e().search(query, from, opts); }
    lines() { return Promise.resolve([]); }
    images() { return Promise.resolve([]); }
    fields() { return Promise.resolve([]); }
    addedTexts() { return Promise.resolve([]); }
    close() { return Promise.resolve(null); }
  }
  return { EngineError, EngineClient };
});

vi.mock("../src/ui/fill/signatureStore.ts", () => ({
  MAX_SAVED: 5,
  available: async () => false,
  list: async () => [],
  save: async () => null,
  forget: async () => false,
}));

vi.mock("../src/ui/imageFile.ts", () => {
  class PictureError extends Error {
    constructor(message: string, readonly code: "too-big" | "unreadable") {
      super(message);
    }
  }
  return {
    MAX_PICTURE_SIDE: 2000,
    MAX_PICTURE_FILE: 50 * 1024 * 1024,
    PictureError,
    fitWithin: () => ({ width: 1, height: 1 }),
    hasTransparency: () => false,
    preparePicture: () => Promise.reject(new PictureError("no pictures here", "unreadable")),
  };
});

// No real DOM: nothing to give the focus back to.
(globalThis as any).document.querySelector = () => null;

// ---------------------------------------------------------------------------------------------
// The fake engine: one text per page; a step reads `perStep` pages (or stops at maxHits).

interface Call { query: string; from: number; to: number; budgetMs?: number; maxHits?: number; options?: SearchOptions }
const fake = {
  texts: [] as string[],
  perStep: 2,
  calls: [] as Call[],
  /** While set, every step waits for it. */
  gate: null as Promise<void> | null,
  /** While set, every step waits here until answer() lets it go, oldest first: the worker's order. */
  held: null as (() => void)[] | null,
  fail: false,
  /** A page the engine cannot read (MuPDF fails on it); -1 for none. */
  unreadable: -1,
};

/** Let the oldest step held go, and what follows from its answer run. */
async function answer() {
  fake.held!.shift()!();
  await new Promise((r) => setTimeout(r, 0));
}

function hitAt(pageIndex: number, at: number, length: number, text: string): SearchHit {
  const x = 10 + at * 6;
  return {
    pageIndex, quads: [[x, 100, x + length * 6, 100, x, 112, x + length * 6, 112]], rect: [x, 100, x + length * 6, 112],
    in: "page", before: text.slice(Math.max(0, at - 10), at), match: text.slice(at, at + length),
    after: text.slice(at + length, at + length + 10),
  };
}

(globalThis as any).__searchEngine = {
  async search(query: string, from: number, opts: { options?: SearchOptions; to?: number; budgetMs?: number; maxHits?: number } = {}) {
    const to = opts.to ?? fake.texts.length;
    fake.calls.push({ query, from, to, budgetMs: opts.budgetMs, maxHits: opts.maxHits, options: opts.options });
    if (fake.held) await new Promise<void>((go) => fake.held!.push(go));
    if (fake.gate) await fake.gate;
    if (fake.fail) throw new Error("the engine said no");
    if (opts.maxHits !== undefined && opts.maxHits < 1) throw new Error("A search finds at least one hit"); // as session.search
    const exact = !!opts.options?.caseSensitive;
    const needle = exact ? query : query.toLowerCase();
    const maxHits = opts.maxHits ?? 10_000;
    const hits: SearchHit[] = [];
    const end = Math.min(to, from + fake.perStep);
    let p = from;
    for (; p < end; p++) {
      if (p === fake.unreadable) {
        const { EngineError } = await import("../src/engine/client");
        throw new EngineError("MuPDF could not read the page", "engine"); // as the worker says it
      }
      const text = fake.texts[p] ?? "";
      const hay = exact ? text : text.toLowerCase();
      for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) {
        hits.push(hitAt(p, at, query.length, text));
        if (hits.length >= maxHits) return { hits, next: p + 1 < to ? p + 1 : null, truncated: true };
      }
    }
    return { hits, next: p < to ? p : null, truncated: false };
  },
};

let state: typeof import("../src/state");
let model: typeof import("../src/viewer/model");
let runner: typeof import("../src/ui/search/runner");
let search: typeof import("../src/ui/search/state");
let i18n: typeof import("../src/i18n");
let media: typeof import("../src/ui/media");

beforeAll(async () => {
  state = await import("../src/state");
  model = await import("../src/viewer/model");
  runner = await import("../src/ui/search/runner");
  search = await import("../src/ui/search/state");
  i18n = await import("../src/i18n");
  media = await import("../src/ui/media");
});

let nextDocId = 5000;
const BOUNDS: Rect = [0, 0, 600, 800];

/** A document of these page texts, open, at page `current`. */
function openDoc(texts: string[], current = 0) {
  fake.texts = texts;
  const pages = texts.map((_, index) => ({ index, bounds: [...BOUNDS] as Rect }));
  const d = model.createDoc(nextDocId++, "test.pdf", {
    pageCount: texts.length, pages, encrypted: false, needsPassword: false, canKeepPassword: false, pdfa: null,
    signatures: 0, form: null, title: null,
  });
  state.doc.value = d;
  state.startHistory();
  state.currentPage.value = current;
  fake.calls.length = 0;
  return d;
}

const pagesOf = (hits: readonly SearchHit[]) => hits.map((h) => h.pageIndex);
const edit = (changedPages: number[], extra: Record<string, unknown> = {}) =>
  state.recordHistory({ editCount: 1, canUndo: true, canRedo: false, changedPages, ...extra }, "edit");

beforeEach(() => {
  i18n.setLocale("en");
  fake.perStep = 2;
  fake.gate = null;
  fake.held = null;
  fake.fail = false;
  fake.unreadable = -1;
  hooks.state = undefined;
  hooks.sets.length = 0;
  search.setHitRevealer(null);
});

const many = (n: number) => "x ".repeat(n);
const settled = () => vi.waitFor(() => expect(runner.searchBusy.value).toBe(false));

/** Every vnode in `node` (a component's output, not rendered: the components in it stay vnodes), in order. */
function vnodes(node: any, out: any[] = []): any[] {
  if (Array.isArray(node)) {
    for (const child of node) vnodes(child, out);
  } else if (node && typeof node === "object" && node.props) {
    out.push(node);
    vnodes(node.props.children, out);
  }
  return out;
}

/** A key press for the bar's handlers. */
function keyPress(key: string, keyCode: number) {
  const e: any = {
    key, keyCode, isComposing: false, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, defaultPrevented: false,
    preventDefault() { e.defaultPrevented = true; }, stopPropagation: () => undefined,
  };
  return e;
}

afterEach(() => {
  search.closeSearch();
  runner.stopSearch();
  vi.useRealTimers();
});

describe("S1 the runner", () => {
  it("goes from the current page to the end, then from the first page; hits in page order, the first found current", async () => {
    openDoc(["", "Rossi", "", "Mario Rossi", "", "rossi e Rossi"], 3);
    const hits = await runner.runSearch("rossi");
    expect(fake.calls.map((c) => [c.from, c.to])).toEqual([[3, 6], [5, 6], [0, 3], [2, 3]]);
    expect(fake.calls.every((c) => c.budgetMs === runner.STEP_MS && c.query === "rossi")).toBe(true);
    expect(pagesOf(hits!)).toEqual([1, 3, 5, 5]);
    expect(runner.searchHits.value).toBe(hits);
    expect(runner.currentSearchHit.value?.pageIndex).toBe(3); // the first one found
    expect(runner.currentHitIndex.value).toBe(1);
    expect(runner.searchProgress.value).toBeNull();
    expect(runner.searchQuery.value).toBe("rossi");
    expect([...runner.hitsByPage.value.keys()]).toEqual([1, 3, 5]);
  });

  it("says where it is while it goes: the page it reads next, of how many", async () => {
    openDoc(["a", "b", "c", "d"], 1);
    let release!: () => void;
    fake.gate = new Promise((r) => { release = r; });
    const done = runner.runSearch("x");
    expect(runner.searchProgress.value).toEqual({ page: 2, pages: 4 });
    expect(runner.searchBusy.value).toBe(true);
    fake.gate = null;
    release();
    await done;
    expect(runner.searchProgress.value).toBeNull();
    expect(runner.searchBusy.value).toBe(false);
  });

  it("stops at 1000 hits, keeps the first found and says there are more", async () => {
    fake.perStep = 1;
    openDoc(["x ".repeat(600), "x ".repeat(600), "x ".repeat(600)]);
    const hits = await runner.runSearch("x");
    expect(hits!.length).toBe(runner.MAX_HITS);
    expect(runner.searchTooMany.value).toBe(true);
    expect(pagesOf(hits!).filter((p) => p === 0).length).toBe(600);
    expect(pagesOf(hits!).filter((p) => p === 1).length).toBe(400);
    expect(fake.calls.map((c) => c.maxHits)).toEqual([1001, 1001]); // one more than MAX_HITS: "more than" is known
    expect(fake.calls.length).toBe(2); // nothing read after the cap
  });

  it("judges the cap when hits come in: a page read again meanwhile never takes it past 1000, nor makes a step ask for less than one", async () => {
    fake.perStep = 1;
    fake.held = [];
    openDoc([many(600), "", many(500), many(1)]);
    const done = runner.runSearch("x");
    await answer(); // page 0: 600
    edit([0]); // its hits go and it is read again, asked after the run's step for page 1
    await answer(); // page 1: none
    await answer(); // page 0 again: 600
    await answer(); // page 2: 500, of which 400 fit
    while (fake.held.length) await answer();
    const hits = await done;
    expect(hits!.length).toBe(runner.MAX_HITS);
    expect(pagesOf(hits!).filter((p) => p === 2).length).toBe(400);
    expect(runner.searchTooMany.value).toBe(true);
    expect(runner.searchFailed.value).toBe(false);

    // The run over at 900, two edits (two undos) each raise a page to 700, both read again before either is back.
    fake.held = null;
    openDoc([many(300), many(300), many(300)]);
    expect((await runner.runSearch("x"))!.length).toBe(900);
    fake.held = [];
    fake.texts[0] = many(700);
    fake.texts[1] = many(700);
    edit([0]);
    edit([1]);
    await answer();
    await answer();
    expect(runner.searchHits.value.length).toBe(runner.MAX_HITS);
    expect(runner.searchTooMany.value).toBe(true);
    expect(search.searchCountText(false)).toBe("1 of 1000+");
    expect(fake.calls.every((c) => c.maxHits === runner.MAX_HITS + 1)).toBe(true);
  });

  it("stopped at the cap, an edit that leaves fewer starts over quietly and reads the pages it never reached", async () => {
    fake.perStep = 1;
    const revealed: SearchHit[] = [];
    openDoc([many(600), many(600), many(300)]);
    search.setHitRevealer((hit) => revealed.push(hit));
    search.openSearch();
    search.setSearchInput("x");
    search.goToResult(1);
    await settled();
    expect(runner.searchTooMany.value).toBe(true);
    revealed.length = 0;
    fake.calls.length = 0;
    fake.texts[0] = "";
    edit([0]);
    await settled();
    expect(runner.searchHits.value.length).toBe(900);
    expect(runner.searchTooMany.value).toBe(false);
    expect(search.searchNoteText()).toBeNull();
    expect(fake.calls.some((c) => c.from === 2)).toBe(true); // never reached before
    expect(revealed).toEqual([]);
    expect(search.searchStatus.value).toBeNull(); // nothing said, and the old words about the hits went with them

    // The page where it stopped, read only in part, is read again after an edit too.
    openDoc([many(600), many(600), many(300)]);
    await runner.runSearch("x");
    expect(runner.searchTooMany.value).toBe(true);
    fake.texts[1] = many(10);
    edit([1]);
    await settled();
    expect(runner.searchHits.value.length).toBe(910);
    expect(runner.searchTooMany.value).toBe(false);
  });

  it("a page the engine cannot read is skipped and said: the pages after it are still searched, Oscura tutti is not offered", async () => {
    openDoc(["Rossi", "Rossi", "Rossi", "Rossi", "Rossi", "Rossi"]);
    fake.unreadable = 3;
    search.openSearch();
    search.setSearchInput("Rossi");
    search.goToResult(1);
    await settled();
    // A step that fails is asked again for its first page alone; that page failing too, it is skipped.
    expect(fake.calls.map((c) => [c.from, c.to])).toEqual([[0, 6], [2, 6], [2, 3], [3, 6], [3, 4], [4, 6]]);
    expect(pagesOf(runner.searchHits.value)).toEqual([0, 1, 2, 4, 5]);
    expect(runner.searchSkipped.value).toBe(1);
    expect(runner.searchFailed.value).toBe(false);
    expect(search.searchNoteText()).toBe("1 page couldn't be read, so it wasn't searched");
    expect(search.searchStatus.value?.text).toBe("1 page couldn't be read, so it wasn't searched. Result 1 of 5, page 1: Rossi");
    expect(search.canRedactAll.value).toBe(false);
    expect(search.searchMenuItems(() => undefined)[3].disabled).toBe(true);
    expect(await runner.rerunSearch()).toBeNull(); // not every page read: nothing to say what is left

    // Read again after an edit, a page that cannot be read now is skipped too.
    fake.unreadable = 0;
    edit([0]);
    await settled();
    expect(pagesOf(runner.searchHits.value)).toEqual([1, 2, 4, 5]);
    expect(runner.searchSkipped.value).toBe(2);
    expect(search.searchNoteText()).toBe("2 pages couldn't be read, so they weren't searched");
    expect(runner.searchFailed.value).toBe(false);
  });

  it("a new query cancels the old one: its steps stop, and what comes back for it is dropped", async () => {
    openDoc(["aaa bbb", "aaa bbb", "aaa bbb", "aaa bbb"]);
    let release!: () => void;
    fake.gate = new Promise((r) => { release = r; });
    const first = runner.runSearch("aaa");
    const second = runner.runSearch("bbb");
    fake.gate = null;
    release();
    expect(await first).toBeNull();
    const hits = await second;
    expect(hits!.map((h) => h.match)).toEqual(["bbb", "bbb", "bbb", "bbb"]);
    expect(fake.calls.filter((c) => c.query === "aaa").length).toBe(1);
  });

  it("after an edit only the pages it changed are read again, and the current hit stays on its page", async () => {
    const d = openDoc(["Rossi", "", "", "Rossi", "", "Rossi"], 3);
    await runner.runSearch("rossi");
    expect(runner.currentSearchHit.value?.pageIndex).toBe(3);
    fake.texts[3] = "Rossi, Rossi";
    fake.calls.length = 0;
    edit([3]);
    await vi.waitFor(() => expect(runner.searchBusy.value).toBe(false));
    expect(fake.calls.map((c) => [c.from, c.to])).toEqual([[3, 4]]);
    expect(pagesOf(runner.searchHits.value)).toEqual([0, 3, 3, 5]);
    expect(runner.currentSearchHit.value?.pageIndex).toBe(3);
    expect(runner.currentHitIndex.value).toBe(1);

    // The hit goes from its page (Oscura): the current one becomes the next one after it.
    fake.texts[3] = "";
    edit([3]);
    await vi.waitFor(() => expect(runner.searchBusy.value).toBe(false));
    expect(pagesOf(runner.searchHits.value)).toEqual([0, 5]);
    expect(runner.currentSearchHit.value?.pageIndex).toBe(5);
    expect(d.pages.length).toBe(6);
  });

  it("an edit of a page the run has not read yet is left to the run", async () => {
    openDoc(["", "", "", "Rossi"]);
    let release!: () => void;
    fake.gate = new Promise((r) => { release = r; });
    const done = runner.runSearch("rossi");
    edit([3]); // the run is still on its first step
    fake.gate = null;
    release();
    await done;
    expect(fake.calls.map((c) => [c.from, c.to])).toEqual([[0, 4], [2, 4]]);
    expect(pagesOf(runner.searchHits.value)).toEqual([3]);
  });

  it("a page operation starts over from the page shown; a layout that keeps every page only reads its pages again", async () => {
    const d = openDoc(["Rossi", "", "Rossi", ""], 2);
    await runner.runSearch("rossi");
    // Move page 2 to the front: the current page follows it (state.ts), the run starts over there.
    fake.texts = ["Rossi", "Rossi", "", ""];
    fake.calls.length = 0;
    edit([], {
      layout: { pages: d.pages.map((p, index) => ({ index, bounds: p.bounds })), from: [2, 0, 1, 3], form: null, signatures: 0 },
    });
    await vi.waitFor(() => expect(runner.searchBusy.value).toBe(false));
    expect(state.currentPage.value).toBe(0);
    expect(fake.calls[0]).toMatchObject({ from: 0, to: 4 });
    expect(pagesOf(runner.searchHits.value)).toEqual([0, 1]);

    // Oscura removed a field (the form changed): the same pages in the same places.
    fake.texts[1] = "";
    fake.calls.length = 0;
    edit([1], {
      layout: { pages: d.pages.map((p, index) => ({ index, bounds: p.bounds })), from: [0, 1, 2, 3], form: null, signatures: 0 },
    });
    await vi.waitFor(() => expect(runner.searchBusy.value).toBe(false));
    expect(fake.calls.map((c) => [c.from, c.to])).toEqual([[1, 2]]);
    expect(pagesOf(runner.searchHits.value)).toEqual([0]);
  });

  it("starting over after a page operation is quiet: the view stays on the page operated on, nothing is said again", async () => {
    const texts = ["", "Rossi", "", "", "Rossi"];
    const d = openDoc(texts);
    const revealed: number[] = [];
    search.setHitRevealer((hit) => revealed.push(hit.pageIndex));
    search.openSearch();
    search.setSearchInput("Rossi");
    search.goToResult(1);
    await settled();
    search.goToResult(1);
    expect(revealed).toEqual([1, 4]);
    state.currentPage.value = 2;
    const from = [0, 1, 3, 2, 4]; // pages 3 and 4 change places
    fake.texts = from.map((i) => texts[i]);
    edit([], { layout: { pages: d.pages.map((p, index) => ({ index, bounds: p.bounds })), from, form: null, signatures: 0 } });
    await settled();
    expect(pagesOf(runner.searchHits.value)).toEqual([1, 4]);
    expect(revealed).toEqual([1, 4]);
    expect(search.searchStatus.value).toBeNull(); // nothing said, and the old words about the hits went with them
  });

  it("a page operation while the run asked for is still going: the one that starts over shows its first hit and says its end", async () => {
    fake.perStep = 1;
    fake.held = [];
    const texts = ["", "", "", "", "Rossi", ""];
    const d = openDoc(texts);
    const revealed: number[] = [];
    search.setHitRevealer((hit) => revealed.push(hit.pageIndex));
    search.openSearch();
    search.setSearchInput("Rossi");
    search.goToResult(1);
    await answer(); // page 0: nothing yet
    const from = [1, 0, 2, 3, 4, 5]; // pages 1 and 2 change places
    fake.texts = from.map((i) => texts[i]);
    edit([], { layout: { pages: d.pages.map((p, index) => ({ index, bounds: p.bounds })), from, form: null, signatures: 0 } });
    while (fake.held.length) await answer();
    await settled();
    expect(pagesOf(runner.searchHits.value)).toEqual([4]);
    expect(revealed).toEqual([4]);
    expect(search.searchStatus.value?.text).toBe("Result 1 of 1, page 5: Rossi");
  });

  it("a page operation after a failed run starts over quietly: its failure was said", async () => {
    fake.held = [];
    const texts = ["", "Rossi", "", "", "Rossi"];
    const d = openDoc(texts);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const revealed: number[] = [];
    search.setHitRevealer((hit) => revealed.push(hit.pageIndex));
    search.openSearch();
    search.setSearchInput("Rossi");
    search.goToResult(1);
    await answer(); // pages 0 and 1: the first hit, shown
    fake.fail = true;
    await answer(); // pages 2 and 3: the engine says no
    expect(runner.searchFailed.value).toBe(true);
    expect(revealed).toEqual([1]);
    const said = search.searchStatus.value;
    expect(said?.text).toBe(i18n.t("search.failed"));
    fake.fail = false;
    fake.held = null;
    state.currentPage.value = 2;
    const from = [0, 1, 3, 2, 4]; // pages 3 and 4 change places
    fake.texts = from.map((i) => texts[i]);
    edit([], { layout: { pages: d.pages.map((p, index) => ({ index, bounds: p.bounds })), from, form: null, signatures: 0 } });
    await settled();
    expect(pagesOf(runner.searchHits.value)).toEqual([1, 4]);
    expect(revealed).toEqual([1]);
    expect(search.searchStatus.value).toBeNull(); // nothing said, and the old words about the hits went with them
    vi.mocked(console.error).mockRestore();
  });

  it("rerunSearch looks again for the same query and options, quietly: nothing is scrolled to", async () => {
    openDoc(["Rossi", "ROSSI"]);
    const revealed: SearchHit[] = [];
    search.setHitRevealer((hit) => revealed.push(hit));
    search.openSearch();
    search.setSearchInput("Rossi");
    search.toggleSearchOption("caseSensitive"); // searches at once
    await vi.waitFor(() => expect(runner.searchProgress.value).toBeNull());
    expect(pagesOf(runner.searchHits.value)).toEqual([0]);
    expect(revealed.length).toBe(1);
    fake.calls.length = 0;
    const again = await runner.rerunSearch();
    expect(pagesOf(again!)).toEqual([0]);
    expect(fake.calls.every((c) => c.query === "Rossi" && c.options?.caseSensitive === true)).toBe(true);
    expect(revealed.length).toBe(1);
    search.toggleSearchOption("caseSensitive");
  });

  it("a failed step says so and keeps what was found", async () => {
    openDoc(["Rossi", "Rossi", "Rossi", "Rossi"]);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const done = runner.runSearch("rossi");
    fake.fail = true;
    expect(await done).toBeNull();
    expect(runner.searchFailed.value).toBe(true);
    expect(runner.searchHits.value.length).toBe(2);
    expect(state.toasts.value.at(-1)?.text).toBe(i18n.t("search.failed"));
    expect(search.canRedactAll.value).toBe(false); // only part of the list
    vi.mocked(console.error).mockRestore();
  });

  it("another document stops the search and forgets its text", async () => {
    openDoc(["Rossi"]);
    search.openSearch();
    search.setSearchInput("Rossi");
    search.goToResult(1); // Enter: at once
    await vi.waitFor(() => expect(runner.searchHits.value.length).toBe(1));
    openDoc(["Rossi"]);
    expect(search.searchOpen.value).toBe(false);
    expect(search.searchInput.value).toBe("");
    expect(runner.searchHits.value).toEqual([]);
    expect(runner.searchQuery.value).toBe("");
  });
});

describe("S2 the bar", () => {
  it("searches once typing pauses, not on every key; Enter searches at once", async () => {
    vi.useFakeTimers();
    openDoc(["Rossi", "Ross"]);
    search.openSearch();
    for (const text of ["R", "Ro", "Ros", "Ross"]) {
      search.setSearchInput(text);
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(fake.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(search.SEARCH_DEBOUNCE_MS);
    await vi.waitFor(() => expect(runner.searchProgress.value).toBeNull());
    expect(new Set(fake.calls.map((c) => c.query))).toEqual(new Set(["Ross"]));
    expect(runner.searchHits.value.length).toBe(2);

    fake.calls.length = 0;
    search.setSearchInput("Rossi");
    search.goToResult(1); // Enter before the pause
    await vi.waitFor(() => expect(runner.searchProgress.value).toBeNull());
    expect(runner.searchQuery.value).toBe("Rossi");
    await vi.advanceTimersByTimeAsync(search.SEARCH_DEBOUNCE_MS * 2);
    expect(new Set(fake.calls.map((c) => c.query))).toEqual(new Set(["Rossi"])); // no second run after the pause

    search.setSearchInput("  ");
    expect(runner.searchQuery.value).toBe("");
    expect(runner.searchHits.value).toEqual([]);
  });

  it("next and previous go round the ends, say the result with its page and words, and the wrap", async () => {
    const d = openDoc(["Mario Rossi", "", "Luca Rossi"]);
    const revealed: SearchHit[] = [];
    search.setHitRevealer((hit) => revealed.push(hit));
    search.openSearch();
    search.setSearchInput("Rossi");
    search.goToResult(1);
    await vi.waitFor(() => expect(runner.searchProgress.value).toBeNull());
    expect(revealed.map((h) => h.pageIndex)).toEqual([0]); // the first found is shown
    expect(search.searchStatus.value?.text).toBe("Result 1 of 2, page 1: Mario Rossi");
    expect(search.searchCountText(false)).toBe("1 of 2");
    expect(search.searchCountText(true)).toBe("1/2");

    search.goToResult(1);
    expect(runner.currentHitIndex.value).toBe(1);
    expect(search.searchStatus.value?.text).toBe("Result 2 of 2, page 3: Luca Rossi");
    search.goToResult(1);
    expect(runner.currentHitIndex.value).toBe(0);
    expect(search.searchStatus.value?.text).toBe("Back to the start. Result 1 of 2, page 1: Mario Rossi");
    expect(search.searchNoteText()).toBe("Back to the start");
    search.goToResult(-1);
    expect(runner.currentHitIndex.value).toBe(1);
    expect(search.searchNoteText()).toBe("Back to the end");
    expect(revealed.map((h) => h.pageIndex)).toEqual([0, 2, 0, 2]);
    expect(d.pages.length).toBe(3);

    // The same words said twice are two messages (a new id), so they are said again.
    const id = search.searchStatus.value!.id;
    search.goToResult(1);
    search.goToResult(-1);
    expect(search.searchStatus.value!.id).toBeGreaterThan(id + 1);
  });

  it("says when nothing is found, and when there are more than 1000", async () => {
    openDoc(["nothing here"]);
    search.openSearch();
    search.setSearchInput("Rossi");
    search.goToResult(1);
    await vi.waitFor(() => expect(runner.searchProgress.value).toBeNull());
    expect(search.searchCountText(false)).toBeNull();
    expect(search.searchCountText(true)).toBe("0/0");
    expect(search.searchNoteText()).toBe("No results");
    expect(search.searchStatus.value?.text).toBe("No results");

    fake.perStep = 1;
    openDoc(["x ".repeat(700), "x ".repeat(700)]);
    search.openSearch();
    search.setSearchInput("x");
    search.goToResult(1);
    await vi.waitFor(() => expect(runner.searchProgress.value).toBeNull());
    expect(search.searchCountText(false)).toBe("1 of 1000+");
    expect(search.searchNoteText()).toBe("More than 1000 results: showing the first 1000");
    expect(search.searchStatus.value?.text).toMatch(/^More than 1000 results: showing the first 1000\. Result 1 of 1000\+, page 1: /);
    // Next and previous say the total as the count shows it.
    search.goToResult(1);
    expect(search.searchCountText(false)).toBe("2 of 1000+");
    expect(search.searchStatus.value?.text).toMatch(/^Result 2 of 1000\+, page 1: /);
  });

  it("hits that come back with none current (Oscura tutti, then Annulla): the first from the page shown is current, quietly; the region never keeps old words", async () => {
    const texts = ["Rossi", "Mario Rossi", "Rossi"];
    openDoc(texts);
    const revealed: number[] = [];
    search.setHitRevealer((hit) => revealed.push(hit.pageIndex));
    search.openSearch();
    search.setSearchInput("rossi");
    search.goToResult(1);
    await settled();
    expect(search.searchStatus.value?.text).toBe("Result 1 of 3, page 1: Rossi");
    fake.texts = ["", "Mario ", ""]; // what Oscura tutti leaves
    edit([0, 1, 2], { redactions: 1 });
    expect(await runner.rerunSearch()).toEqual([]);
    expect(search.searchNoteText()).toBe("No results");
    expect(search.searchStatus.value).toBeNull(); // not "Result 1 of 3": those hits are gone
    state.currentPage.value = 2;
    fake.texts = [...texts]; // Annulla
    state.recordHistory({ editCount: 0, canUndo: false, canRedo: true, changedPages: [0, 1, 2] }, "undo");
    await settled();
    expect(runner.currentSearchHit.value?.pageIndex).toBe(2); // as ▼ would choose
    expect(search.searchCountText(false)).toBe("3 of 3");
    expect(search.searchCountText(true)).toBe("3/3");
    expect(revealed).toEqual([0]);
    expect(search.searchStatus.value).toBeNull();

    // Nothing found, then an edit writes the word in.
    openDoc(["nulla", "ancora nulla", "fine"]);
    search.openSearch();
    search.setSearchInput("rossi");
    search.goToResult(1);
    await settled();
    expect(search.searchStatus.value?.text).toBe("No results");
    fake.texts[1] = "ancora Rossi";
    edit([1]);
    await settled();
    expect(search.searchCountText(false)).toBe("1 of 1");
    expect(search.searchNoteText()).toBeNull();
    expect(search.searchStatus.value).toBeNull();

    // The field emptied: the hits go, and what was said about them.
    search.goToResult(1);
    expect(search.searchStatus.value?.text).toMatch(/Result 1 of 1, page 2: ancora Rossi$/);
    search.setSearchInput("");
    expect(search.searchStatus.value).toBeNull();
  });

  it("▼ while pages are read again is the user's choice, also when it wraps onto the hit chosen quietly: the pages after it do not move it", async () => {
    openDoc(["Rossi", "", "Rossi"]);
    search.openSearch();
    search.setSearchInput("rossi");
    search.goToResult(1);
    await settled();
    fake.texts = ["", "", ""];
    edit([0, 2]);
    await settled();
    state.currentPage.value = 1;
    fake.held = [];
    fake.texts = ["Rossi", "", "Rossi"]; // Annulla
    state.recordHistory({ editCount: 0, canUndo: false, canRedo: true, changedPages: [0, 2] }, "undo");
    await answer(); // page 0 back: none on or after page 2 yet, so its hit is current, quietly
    search.goToResult(1); // the one hit there is so far: it wraps onto it, and says so
    const picked = runner.currentSearchHit.value;
    expect(search.searchStatus.value?.text).toBe("Back to the start. Result 1 of 1, page 1: Rossi");
    await answer(); // page 2 back
    fake.held = null;
    await settled();
    expect(runner.currentSearchHit.value).toBe(picked);
    expect(search.searchCountText(false)).toBe("1 of 2");
  });

  it("a hit an edit brings back while the run asked for has found none yet is the run's first: shown, and said at its end", async () => {
    fake.perStep = 1;
    fake.held = [];
    openDoc(["", "", "", "", "", "Rossi"]);
    const revealed: number[] = [];
    search.setHitRevealer((hit) => revealed.push(hit.pageIndex));
    search.openSearch();
    search.setSearchInput("rossi");
    search.goToResult(1);
    await answer(); // page 0: nothing
    await answer(); // page 1: nothing
    fake.texts[0] = "Rossi";
    edit([0]); // read again after the run's step for page 2
    while (fake.held.length) await answer();
    fake.held = null;
    await settled();
    expect(revealed).toEqual([0]);
    expect(search.searchCountText(false)).toBe("1 of 2");
    expect(search.searchStatus.value?.text).toBe("Result 1 of 2, page 1: Rossi");
  });

  it("an option searches again at once with it; the options stay for the next document", async () => {
    openDoc(["Rossini", "Rossi"]);
    search.openSearch();
    search.setSearchInput("Rossi");
    search.goToResult(1);
    await vi.waitFor(() => expect(runner.searchProgress.value).toBeNull());
    expect(runner.searchHits.value.length).toBe(2);
    fake.calls.length = 0;
    search.toggleSearchOption("wholeWord");
    expect(search.searchOptions.value).toEqual({ wholeWord: true });
    await vi.waitFor(() => expect(runner.searchProgress.value).toBeNull());
    expect(fake.calls.every((c) => c.options?.wholeWord === true)).toBe(true);
    openDoc(["x"]);
    expect(search.searchOptions.value).toEqual({ wholeWord: true });
    search.toggleSearchOption("wholeWord");
  });

  it("the options menu: three check boxes, then “Redact all results…”, offered once every page is read", async () => {
    openDoc(["Rossi", "Rossi"]);
    const asked: unknown[][] = [];
    const items = () => search.searchMenuItems((...args) => asked.push(args));
    expect(items().map((i) => [i.label, i.checked ?? null, !!i.disabled])).toEqual([
      ["Whole words", false, false], ["Match case", false, false], ["Match accents", false, false],
      ["Redact all results…", null, true],
    ]);
    search.openSearch();
    search.setSearchInput("Rossi");
    let release!: () => void;
    fake.gate = new Promise((r) => { release = r; });
    search.goToResult(1);
    expect(items()[3].disabled).toBe(true); // still searching
    fake.gate = null;
    release();
    await vi.waitFor(() => expect(runner.searchProgress.value).toBeNull());
    const redactAll = items()[3];
    expect(redactAll.disabled).toBe(false);
    redactAll.onSelect();
    expect(asked).toEqual([[runner.searchHits.value, "Rossi", {}]]);
    state.editingStopped.value = true;
    expect(items()[3].disabled).toBe(true);
    state.editingStopped.value = false;
  });

  it("closing forgets the hits but keeps the text; opening again searches it again", async () => {
    openDoc(["Rossi"]);
    search.openSearch();
    search.setSearchInput("Rossi");
    search.goToResult(1);
    await vi.waitFor(() => expect(runner.searchHits.value.length).toBe(1));
    search.closeSearch();
    expect(search.searchOpen.value).toBe(false);
    expect(runner.searchHits.value).toEqual([]);
    expect(search.searchInput.value).toBe("Rossi");
    const asks = search.searchFocus.value;
    search.openSearch();
    expect(search.searchFocus.value).toBe(asks + 1); // the field takes the focus, its text selected
    await vi.waitFor(() => expect(runner.searchHits.value.length).toBe(1));
    search.openSearch(); // open already: only the focus again
    expect(search.searchFocus.value).toBe(asks + 2);
  });

  it("Opzioni is the app's menu (ui/Menu.tsx): its check boxes are menuitemcheckbox and leave it open; an action closes it", async () => {
    openDoc(["Rossi"]);
    const { FindBar } = await import("../src/ui/search/SearchBar");
    const { MenuButton } = await import("../src/ui/Menu");
    const options = vnodes(FindBar({ elRef: { current: null } })).find((v) => v.type?.name === "OptionsMenu");
    const button = options.type(options.props);
    expect(button.type).toBe(MenuButton);
    hooks.state = true; // open
    const rows = vnodes(MenuButton(button.props)).filter((v) => v.props.class === "menu-item");
    expect(rows.map((r) => [r.props.role, r.props["aria-checked"] ?? null])).toEqual([
      ["menuitemcheckbox", false], ["menuitemcheckbox", false], ["menuitemcheckbox", false], ["menuitem", null],
    ]);
    rows[0].props.onClick();
    expect(search.searchOptions.value).toEqual({ wholeWord: true });
    expect(hooks.sets).toEqual([]); // still open
    search.toggleSearchOption("wholeWord");

    const chosen: string[] = [];
    const more = MenuButton({ label: "More", icon: null, items: [{ key: "a", label: "A", onSelect: () => chosen.push("a") }] });
    const row = vnodes(more).find((v) => v.props.class === "menu-item");
    expect(row.props.role).toBe("menuitem");
    row.props.onClick();
    expect(hooks.sets).toEqual([false]); // closed
    expect(chosen).toEqual(["a"]);
  });

  it("Enter and Escape that end an input method's composition (Safari: keyCode 229 only) are left to it", async () => {
    openDoc(["Rossi", "Rossi"]);
    search.openSearch();
    search.setSearchInput("Rossi");
    search.goToResult(1);
    await settled();
    const { FindBar } = await import("../src/ui/search/SearchBar");
    const bar: any = FindBar({ elRef: { current: null } });
    const field = vnodes(bar).find((v) => v.type?.name === "SearchField");
    const input = field.type(field.props);
    const composed = keyPress("Enter", 229);
    input.props.onKeyDown(composed);
    expect(composed.defaultPrevented).toBe(false);
    expect(runner.currentHitIndex.value).toBe(0);
    input.props.onKeyDown(keyPress("Enter", 13));
    expect(runner.currentHitIndex.value).toBe(1);
    bar.props.onKeyDown(keyPress("Escape", 229));
    expect(search.searchOpen.value).toBe(true);
    bar.props.onKeyDown(keyPress("Escape", 27));
    expect(search.searchOpen.value).toBe(false);
  });

  it("on phones what is going on is shown in a line under the search, not only said", async () => {
    openDoc(["Rossi", "Rossi"]);
    const { PhoneSearch } = await import("../src/ui/search/SearchBar");
    const note = () => {
      const shown = vnodes(PhoneSearch());
      const id = shown.find((v) => v.type?.name === "SearchField").props.describedBy.split(" ")[1];
      return shown.find((v) => v.props.id === id);
    };
    search.openSearch();
    search.setSearchInput("Rossi");
    let release!: () => void;
    fake.gate = new Promise((r) => { release = r; });
    search.goToResult(1);
    expect(note().props.class).toBe("phone-search-note");
    expect(note().props.children).toBe("Searching… page 1 of 2");
    fake.gate = null;
    release();
    await settled();
    expect(note().props.children).toBeNull();
  });

  it("the find bar keeps its height whatever the count says: the count and the note start from room for the widest count", async () => {
    const css = readFileSync(new URL("../src/styles/search.css", import.meta.url), "utf8");
    const rule = (selector: string) => new RegExp(`\\n\\${selector} \\{([^}]*)\\}`).exec(css)?.[1] ?? "";
    // The count's digits are tabular, 1ch each; its other characters are narrower.
    const [, grow, room] = /flex: (\d+) 1 (\d+)ch;/.exec(rule(".find-status")) ?? [];
    expect(rule(".find-count")).toMatch(/font-variant-numeric: tabular-nums;/);
    for (const locale of ["en", "it"] as const) {
      i18n.setLocale(locale);
      expect(i18n.t("search.count", { current: runner.MAX_HITS, total: `${runner.MAX_HITS}+` }).length).toBeLessThanOrEqual(Number(room));
    }
    expect(rule(".find-status")).toMatch(/min-width: 0;/); // nor the note's text
    // The field takes the free room first, up to its 300 px.
    expect(Number(/flex: (\d+) 1 120px;/.exec(rule(".search-field"))?.[1])).toBeGreaterThan(Number(grow));
    const { FindBar } = await import("../src/ui/search/SearchBar");
    const status = vnodes(FindBar({ elRef: { current: null } })).find((v) => v.props.class === "find-status");
    expect(vnodes(status.props.children).map((v) => v.props.class)).toEqual(["find-count", "find-note"]);
  });
});

/** The keyboard shortcuts installed on a fake window; returns press() and the function that removes them. */
async function keyboard() {
  const g = globalThis as any;
  const saved = { add: g.addEventListener, remove: g.removeEventListener, element: g.HTMLElement };
  const listeners: Record<string, (e: unknown) => void> = {};
  g.addEventListener = (type: string, fn: (e: unknown) => void) => { listeners[type] = fn; };
  g.removeEventListener = () => undefined;
  g.HTMLElement ??= class {};
  const { installShortcuts } = await import("../src/ui/shortcuts");
  const uninstall = installShortcuts();
  const press = (key: string, mods: Record<string, unknown> = {}) => {
    const e: any = {
      key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, target: null, defaultPrevented: false,
      preventDefault() { e.defaultPrevented = true; }, ...mods,
    };
    listeners.keydown(e);
    return e;
  };
  const restore = () => {
    uninstall();
    g.addEventListener = saved.add;
    g.removeEventListener = saved.remove;
    g.HTMLElement = saved.element;
  };
  return { press, restore };
}

describe("S3 keys", () => {
  it("Ctrl+F opens the search, also from a text field, while a document is open; F3 and Ctrl+G go to the next result", async () => {
    const { press, restore } = await keyboard();
    try {
      state.doc.value = null;
      expect(press("f", { ctrlKey: true }).defaultPrevented).toBe(false); // the browser's own then
      openDoc(["Rossi", "Rossi", "Rossi"]);
      const field = Object.assign(new (globalThis as any).HTMLElement(), { isContentEditable: true });
      expect(press("f", { ctrlKey: true, target: field }).defaultPrevented).toBe(true);
      expect(search.searchOpen.value).toBe(true);
      search.setSearchInput("Rossi");
      search.goToResult(1);
      await vi.waitFor(() => expect(runner.searchProgress.value).toBeNull());
      expect(runner.currentHitIndex.value).toBe(0);
      expect(press("F3").defaultPrevented).toBe(true);
      expect(runner.currentHitIndex.value).toBe(1);
      press("g", { ctrlKey: true });
      expect(runner.currentHitIndex.value).toBe(2);
      press("G", { ctrlKey: true, shiftKey: true });
      expect(runner.currentHitIndex.value).toBe(1);
      press("F3", { shiftKey: true });
      expect(runner.currentHitIndex.value).toBe(0);
      search.closeSearch();
      press("F3"); // closed: F3 opens it
      expect(search.searchOpen.value).toBe(true);
    } finally {
      restore();
    }
  });

  it("Escape in Bianchetto and Oscura drops the waiting area first, then goes back to Cambia", async () => {
    const { press, restore } = await keyboard();
    const pending = await import("../src/ui/redact/pending");
    try {
      const d = openDoc(["text"]);
      state.tool.value = "edit";
      state.editTool.value = "redact";
      pending.markArea(d.pages[0], [10, 10, 100, 40]);
      expect(pending.pendingRedact.value).not.toBeNull();
      expect(press("Escape").defaultPrevented).toBe(true);
      expect(pending.pendingRedact.value).toBeNull();
      expect(state.editTool.value).toBe("redact");
      press("Escape");
      await vi.waitFor(() => expect(state.editTool.value).toBe("change"));
      expect(state.tool.value).toBe("edit");
      state.editTool.value = "whiteout";
      press("Escape");
      await vi.waitFor(() => expect(state.editTool.value).toBe("change"));
    } finally {
      state.tool.value = null;
      restore();
    }
  });
});

describe("S4 the rail, the phone's bars, the highlights", () => {
  /** The vnodes in `node` (a component's output, not rendered) with a `label` prop, in order. */
  const labelled = (node: any) => vnodes(node).filter((v) => typeof v.props.label === "string");

  it("the rail's Cerca, in the Vista group before Pagine, opens and closes the find bar", async () => {
    openDoc(["Rossi"]);
    const { ToolRail } = await import("../src/ui/ToolRail");
    const buttons = () => labelled(ToolRail());
    const cerca = () => buttons().find((b) => b.props.label === "Search");
    const labels = buttons().map((b) => b.props.label);
    expect(labels.indexOf("Search")).toBe(labels.indexOf(i18n.t("tools.pages")) - 1);
    expect(cerca().props).toMatchObject({ pressed: false, controls: undefined, keys: "Control+F" });
    expect(cerca().props.tip).toBe("Search the document (Ctrl+F)");
    cerca().props.onClick();
    expect(search.searchOpen.value).toBe(true);
    expect(cerca().props).toMatchObject({ pressed: true, controls: "find-bar" });
    cerca().props.onClick();
    expect(search.searchOpen.value).toBe(false);
  });

  it("on phones the bars at the bottom make room while the search field takes typing", async () => {
    openDoc(["Rossi"]);
    const { bottomBarsHidden } = await import("../src/ui/TabBar");
    search.openSearch();
    search.setSearchTyping(true);
    expect(bottomBarsHidden()).toBe(false); // desktop: nothing at the bottom to hide
    media.isNarrow.value = true;
    try {
      expect(bottomBarsHidden()).toBe(true);
      search.setSearchTyping(false);
      expect(bottomBarsHidden()).toBe(false);
      search.setSearchTyping(true);
      search.closeSearch();
      expect(bottomBarsHidden()).toBe(false);
    } finally {
      media.isNarrow.value = false;
    }
  });

  it("each page draws its hits from their quads, the current one outlined and last", async () => {
    const d = openDoc(["", "Rossi Rossi", ""], 1);
    await runner.runSearch("rossi");
    const { SearchLayer, quadPoints } = await import("../src/viewer/SearchLayer");
    expect(SearchLayer({ page: d.pages[0], zoom: 2 })).toBeNull();
    const svg: any = SearchLayer({ page: d.pages[1], zoom: 2 });
    expect(svg.props["aria-hidden"]).toBe("true");
    const shapes = svg.props.children.flat();
    expect(shapes.map((s: any) => s.props.class)).toEqual(["search-hit", "search-hit is-current"]);
    // The first hit found is current: drawn last. ul → ur → lr → ll, at zoom 2.
    expect(shapes[1].props.points).toBe("20,200 80,200 80,224 20,224");
    expect(quadPoints([10, 10, 20, 10, 10, 20, 20, 20], [5, 5], 1.5)).toBe("7.5,7.5 22.5,7.5 22.5,22.5 7.5,22.5");
    runner.moveCurrent(1);
    const again: any = SearchLayer({ page: d.pages[1], zoom: 1 });
    expect(again.props.children.flat()[1].props.points).toBe("46,100 76,100 76,112 46,112");
  });
});
