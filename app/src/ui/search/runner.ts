// Cerca's runner (release 5): the search of the open document, driven from here in short engine
// steps (engine().search, about STEP_MS of work each), so that a render or an edit never waits
// long behind a search of 600 pages. The engine keeps nothing between steps but a cache of page
// texts: not asking for the next step is all it takes to cancel.
//
// A run starts at the current page, goes on to the last one, then wraps round from the first page
// back to where it started. Its hits are kept by page and shown in page order (searchHits), at
// most MAX_HITS: every step asks for one more, so that "more than 1000" is known, and the cap is
// judged when a step's hits come in, against the hits held then (pages read again after an edit
// may have come in or gone while the step was out); the first ones found are kept. The first hit
// found becomes the current one; the current hit is followed by identity as more hits come in, so
// its index can move while its place does not. A page the engine cannot read (MuPDF fails on it)
// is skipped and counted (searchSkipped), so that it does not hide the pages after it.
//
// A generation counter cancels: a new query or new options, a page operation (the pages are laid
// out anew, so the run starts over from the page shown, quietly once its end was told: the viewer
// shows the page operated on), another document, or closing the search bump it, and a step that
// comes back for an older generation is dropped. After an edit, an undo or a redo (also one whose layout keeps
// every page in place: Oscura removing form fields), the hits of the pages it changed are dropped
// and those pages read again, one step each (the session drops its cached texts of those pages
// too); when that leaves fewer than MAX_HITS after a run stopped at the cap, it starts over
// quietly, to read the pages it never reached. Pages the run has not read yet are read by the run
// itself, after the edit. The worker answers in order, so a step sent before an edit comes back
// before it: its hits are in by the time the edit's pages are read again.
//
// rerunSearch() runs the same query again (after "Oscura tutti i risultati…", ui/redact).
import { batch, computed, signal, untracked, type ReadonlySignal } from "@preact/signals";
import { EngineError } from "../../engine/client";
import { MAX_SEARCH_CHARS, type HistoryState, type SearchHit, type SearchOptions, type SearchStep } from "../../engine/protocol";
import { t } from "../../i18n";
import { currentPage, doc, engine, history } from "../../state";
import type { OpenDoc } from "../../viewer/model";
import { reportEngineError } from "../actions";

/** Most hits shown ("Più di 1000 risultati: mostro i primi 1000"). */
export const MAX_HITS = 1000;
/** About how long one step keeps the engine, in milliseconds. */
export const STEP_MS = 20;

/** Where a run is: the page it reads next (1-based) of how many. */
export interface SearchProgress {
  page: number;
  pages: number;
}

const hitsSignal = signal<readonly SearchHit[]>([]);
const querySignal = signal("");
const optionsSignal = signal<SearchOptions>({});
const progressSignal = signal<SearchProgress | null>(null);
const tooManySignal = signal(false);
const failedSignal = signal(false);
const skippedSignal = signal(0);
const currentSignal = signal<SearchHit | null>(null);
/** Pages being read again after an edit, not back yet. */
const rereadingSignal = signal(0);

/** The hits of the last search, in page order (at most MAX_HITS); empty when there is none. */
export const searchHits: ReadonlySignal<readonly SearchHit[]> = hitsSignal;
/** The query those hits are for (trimmed); "" when nothing is searched. */
export const searchQuery: ReadonlySignal<string> = querySignal;
/** The options those hits are for. */
export const searchedOptions: ReadonlySignal<SearchOptions> = optionsSignal;
/** A run is going: the page it reads next. Null once it has read every page (or stopped). */
export const searchProgress: ReadonlySignal<SearchProgress | null> = progressSignal;
/** There are more than MAX_HITS hits: only the first ones found are in searchHits. */
export const searchTooMany: ReadonlySignal<boolean> = tooManySignal;
/** The last run failed (the engine refused or stopped): what it found before is kept. */
export const searchFailed: ReadonlySignal<boolean> = failedSignal;
/** Pages of the last run the engine could not read: not searched, their hits (if any) unknown. */
export const searchSkipped: ReadonlySignal<number> = skippedSignal;
/** The current hit (outlined, scrolled to); null when there is none. */
export const currentSearchHit: ReadonlySignal<SearchHit | null> = currentSignal;
/** The current hit's index in searchHits; -1 when there is none (or while its page is read again). */
export const currentHitIndex = computed(() => {
  const current = currentSignal.value;
  return current ? hitsSignal.value.indexOf(current) : -1;
});
/** The hits by page index, for the pages' highlights (viewer/SearchLayer.tsx). */
export const hitsByPage = computed(() => {
  const pages = new Map<number, SearchHit[]>();
  for (const hit of hitsSignal.value) {
    const list = pages.get(hit.pageIndex);
    if (list) list.push(hit);
    else pages.set(hit.pageIndex, [hit]);
  }
  return pages as ReadonlyMap<number, readonly SearchHit[]>;
});
/** Something is still being read: a run, or pages read again after an edit. */
export const searchBusy = computed(() => progressSignal.value !== null || rereadingSignal.value > 0);

/** What the UI is told (ui/search/state.ts): `quiet` for a run asked by rerunSearch (its caller speaks). */
export interface SearchHooks {
  /** A run found its first hit and made it the current one. */
  chosen?(hit: SearchHit, quiet: boolean): void;
  /** A run read every page, stopped at MAX_HITS, or failed. */
  ended?(hits: readonly SearchHit[], quiet: boolean): void;
}

let hooks: SearchHooks = {};

/** Set what the runner tells the UI. */
export function setSearchHooks(next: SearchHooks): void {
  hooks = next;
}

interface Run {
  gen: number;
  doc: OpenDoc;
  query: string;
  options: SearchOptions;
  /** The page it started at, and how many pages the document had then. */
  start: number;
  count: number;
  /** The hits by page, as last read. */
  pages: Map<number, SearchHit[]>;
  /**
   * Pages this run has read (and not dropped since), which an edit reads again: whole, but for
   * the one where it stopped at MAX_HITS, read up to there.
   */
  covered: Set<number>;
  quiet: boolean;
  /** Its end (or its failure) was told (hooks.ended): starting over after a page operation, it need not be told again. */
  told: boolean;
}

let generation = 0;
let run: Run | null = null;

/** Callers waiting for the end of a run of their query and options (runSearch, rerunSearch). */
const waiters: { key: string; resolve: (hits: readonly SearchHit[] | null) => void }[] = [];

function keyOf(query: string, options: SearchOptions): string {
  return JSON.stringify([query, !!options.caseSensitive, !!options.wholeWord, !!options.matchDiacritics]);
}

/** Resolve the waiters whose key is `key` (all of them for null) with `hits`. */
function settle(key: string | null, hits: readonly SearchHit[] | null) {
  for (let i = waiters.length - 1; i >= 0; i--) {
    if (key !== null && waiters[i].key !== key) continue;
    const [w] = waiters.splice(i, 1);
    w.resolve(hits);
  }
}

/** The query as it is sent: trimmed, at most MAX_SEARCH_CHARS (never half a surrogate pair). */
export function searchableQuery(text: string): string {
  let q = text.trim();
  if (q.length > MAX_SEARCH_CHARS) {
    q = q.slice(0, MAX_SEARCH_CHARS);
    if (/[\uD800-\uDBFF]$/.test(q)) q = q.slice(0, -1);
    q = q.trimEnd();
  }
  return q;
}

/** Two sets of options match the same way. */
export function sameOptions(a: SearchOptions, b: SearchOptions): boolean {
  return !!a.caseSensitive === !!b.caseSensitive && !!a.wholeWord === !!b.wholeWord &&
    !!a.matchDiacritics === !!b.matchDiacritics;
}

function live(r: Run): boolean {
  return run === r && r.gen === generation && doc.peek() === r.doc;
}

function count(r: Run): number {
  let n = 0;
  for (const list of r.pages.values()) n += list.length;
  return n;
}

/** The run's hits, in page order, into searchHits; a current hit no longer among them stays (its page is being read again). */
function publish(r: Run) {
  const all: SearchHit[] = [];
  for (const p of [...r.pages.keys()].sort((a, b) => a - b)) all.push(...r.pages.get(p)!);
  hitsSignal.value = all;
}

/** What every step asks for: one more than MAX_HITS, so that "more than" is known. */
const ASK_HITS = MAX_HITS + 1;

/** How many more hits the run can take now, counting the one over the cap (`page`'s, about to be replaced, aside). */
function roomFor(r: Run, page = -1): number {
  return ASK_HITS - count(r) + (r.pages.get(page)?.length ?? 0);
}

/**
 * Take a step's hits into the run: the pages from `from` up to `next` (or `to`) were read whole,
 * unless the cap was passed, judged now from the hits the run holds. Returns true when the cap
 * was passed (the extra hits are dropped: the first ones found are kept).
 */
function take(r: Run, from: number, to: number, step: SearchStep): boolean {
  const room = roomFor(r);
  const upto = step.next === null ? to : Math.min(Math.max(step.next, from), to);
  const capped = step.hits.length >= room;
  const kept = capped ? step.hits.slice(0, Math.max(0, room - 1)) : step.hits;
  // With the cap passed, the page of the extra hit was not read whole, and none after it was read.
  const extra = capped ? step.hits[Math.max(0, room - 1)].pageIndex : null;
  const whole = extra === null ? upto : Math.max(from, Math.min(extra, to));
  const last = Math.min(extra === null ? upto : whole + 1, to, r.doc.pages.length);
  const byPage = new Map<number, SearchHit[]>();
  for (const hit of kept) {
    if (hit.pageIndex < from || hit.pageIndex >= last) continue;
    const list = byPage.get(hit.pageIndex);
    if (list) list.push(hit);
    else byPage.set(hit.pageIndex, [hit]);
  }
  for (let p = from; p < last; p++) {
    const list = byPage.get(p);
    if (list) r.pages.set(p, list);
    else r.pages.delete(p);
    r.covered.add(p);
  }
  return capped;
}

function chooseFirst(r: Run, step: readonly SearchHit[]) {
  if (currentSignal.peek() || !step.length) return;
  const hit = step.find((h) => r.pages.get(h.pageIndex)?.includes(h));
  if (!hit) return;
  currentSignal.value = hit;
  hooks.chosen?.(hit, r.quiet);
}

/** The run is over (every page read, or the cap reached): its waiters get the hits (null when pages were skipped). */
function end(r: Run) {
  progressSignal.value = null;
  const hits = hitsSignal.peek();
  r.told = true;
  hooks.ended?.(hits, r.quiet);
  settle(keyOf(r.query, r.options), skippedSignal.peek() ? null : hits);
}

/** The error of a page the engine cannot read (MuPDF failed on it), not of the search or the engine. */
function unreadable(e: unknown): boolean {
  return e instanceof EngineError && e.code === "engine";
}

/** One step of `r`: the pages from `from` up to `to`, within STEP_MS. */
function ask(r: Run, from: number, to: number): Promise<SearchStep> {
  return engine().search(r.query, from, { options: r.options, to, budgetMs: STEP_MS, maxHits: ASK_HITS });
}

/**
 * One step of `r` from `from` up to `to` (`upto` says how far it was asked). A step that fails on
 * a page the engine cannot read is asked again for its first page alone; null when that fails too:
 * that page is to be skipped.
 */
async function stepAt(r: Run, from: number, to: number): Promise<{ step: SearchStep; upto: number } | null> {
  try {
    return { step: await ask(r, from, to), upto: to };
  } catch (e) {
    if (!unreadable(e) || !live(r)) throw e;
  }
  try {
    return { step: await ask(r, from, from + 1), upto: from + 1 };
  } catch (e) {
    if (unreadable(e)) return null;
    throw e;
  }
}

async function drive(r: Run): Promise<void> {
  const n = r.doc.pages.length;
  const passes: [number, number][] = r.start > 0 ? [[r.start, n], [0, r.start]] : [[0, n]];
  try {
    for (const [first, to] of passes) {
      let from: number | null = first;
      while (from !== null && from < to) {
        if (!live(r)) return;
        progressSignal.value = { page: from + 1, pages: n };
        const read = await stepAt(r, from, to);
        if (!live(r)) return;
        if (!read) {
          skippedSignal.value++;
          from++;
          continue;
        }
        const { step, upto } = read;
        let capped = false;
        batch(() => {
          capped = take(r, from!, upto, step);
          publish(r);
          chooseFirst(r, step.hits);
          if (capped) tooManySignal.value = true;
        });
        if (capped) {
          end(r);
          return;
        }
        // No way forward (an engine that answers with the same page): this pass is over.
        if (step.next !== null && step.next <= from) break;
        from = step.next ?? (upto < to ? upto : null);
      }
    }
  } catch (e) {
    if (!live(r)) return;
    batch(() => {
      failedSignal.value = true;
      progressSignal.value = null;
    });
    reportEngineError(e, t("search.failed"));
    r.told = true;
    hooks.ended?.(hitsSignal.peek(), r.quiet);
    settle(keyOf(r.query, r.options), null);
    return;
  }
  if (live(r)) end(r);
}

/** Cancel what is running: its steps that come back are dropped. */
function cancel() {
  generation++;
  run = null;
}

/**
 * Search the open document for `query` with `options`: a new run, from the current page (what was
 * found before goes). Resolves with the hits once it has read every page or stopped at MAX_HITS,
 * also when it had to start over after a page operation; null when it was replaced by another
 * query, stopped, failed, or skipped pages it could not read. An empty query just clears the
 * search (null).
 */
export function runSearch(query: string, options: SearchOptions = {}, quiet = false): Promise<readonly SearchHit[] | null> {
  const q = searchableQuery(query);
  const d = doc.peek();
  const key = keyOf(q, options);
  cancel();
  // Waiting for another query: that one is not coming.
  for (let i = waiters.length - 1; i >= 0; i--) {
    if (waiters[i].key !== key) waiters.splice(i, 1)[0].resolve(null);
  }
  if (!d || !q || d.pages.length === 0) {
    clear();
    settle(null, null);
    return Promise.resolve(null);
  }
  const start = Math.min(Math.max(0, currentPage.peek()), d.pages.length - 1);
  const r: Run = {
    gen: generation, doc: d, query: q, options: { ...options }, start, count: d.pages.length, pages: new Map(),
    covered: new Set(), quiet, told: false,
  };
  run = r;
  batch(() => {
    hitsSignal.value = [];
    querySignal.value = q;
    optionsSignal.value = { ...options };
    tooManySignal.value = false;
    failedSignal.value = false;
    skippedSignal.value = 0;
    currentSignal.value = null;
    rereadingSignal.value = 0;
    progressSignal.value = { page: start + 1, pages: d.pages.length };
  });
  const done = new Promise<readonly SearchHit[] | null>((resolve) => waiters.push({ key, resolve }));
  void drive(r);
  return done;
}

/**
 * Search again for the query and options of the hits shown, from the current page (after
 * "Oscura tutti i risultati…": what is left of them, ui/redact). Quiet: nothing is scrolled to or
 * said, the caller says what is left. Resolves as runSearch does; null at once when nothing is
 * searched.
 */
export function rerunSearch(): Promise<readonly SearchHit[] | null> {
  const q = querySignal.peek();
  if (!q) return Promise.resolve(null);
  return runSearch(q, optionsSignal.peek(), true);
}

function clear() {
  batch(() => {
    hitsSignal.value = [];
    querySignal.value = "";
    optionsSignal.value = {};
    progressSignal.value = null;
    tooManySignal.value = false;
    failedSignal.value = false;
    skippedSignal.value = 0;
    currentSignal.value = null;
    rereadingSignal.value = 0;
  });
}

/** Stop and forget the search: no hits, no query (the search bar closed, another document). */
export function stopSearch(): void {
  cancel();
  clear();
  settle(null, null);
}

/** Bumped by every next or previous (moveCurrent), also one that lands on the hit already current. */
let moves = 0;

/**
 * Make the hit `index` steps away from the current one current (dir 1: the next, -1: the
 * previous), wrapping round at either end. With no current hit: the first on or after the current
 * page (the last on or before it, going back). Null when there are no hits.
 */
export function moveCurrent(dir: 1 | -1): { hit: SearchHit; index: number; wrapped: boolean } | null {
  const hits = hitsSignal.peek();
  if (!hits.length) return null;
  const at = currentHitIndex.peek();
  let index: number;
  let wrapped = false;
  if (at < 0) {
    const page = currentPage.peek();
    if (dir > 0) {
      index = hits.findIndex((h) => h.pageIndex >= page);
      if (index < 0) {
        index = 0;
        wrapped = true;
      }
    } else {
      index = hits.findLastIndex((h) => h.pageIndex <= page);
      if (index < 0) {
        index = hits.length - 1;
        wrapped = true;
      }
    }
  } else {
    index = at + dir;
    if (index >= hits.length) {
      index = 0;
      wrapped = true;
    } else if (index < 0) {
      index = hits.length - 1;
      wrapped = true;
    }
  }
  const hit = hits[index];
  moves++;
  currentSignal.value = hit;
  return { hit, index, wrapped };
}

/**
 * Read `indices` again (an edit, an undo or a redo changed them): their hits go now, and come
 * back as the engine finds them now. Only pages the run has read: the others it reads itself.
 * The current hit on such a page is followed to the hit in the same place on the page, else the
 * next one after it; with none current, hits that come back make the first on or after the page
 * shown current (not scrolled to: an undo of "Oscura tutti" shows "1 di 3", not "0 di 3"), until
 * next or previous is pressed; while the run has not ended, the first that comes back is its first
 * hit, shown as it would show it. A page the engine cannot read now is skipped (searchSkipped). When the run
 * had stopped at MAX_HITS and fewer are left, it starts over (quietly): its last pages were never
 * read.
 */
async function reread(r: Run, indices: readonly number[]): Promise<void> {
  const n = r.doc.pages.length;
  const list = [...new Set(indices)]
    .filter((p) => Number.isInteger(p) && p >= 0 && p < n && r.covered.has(p))
    .sort((a, b) => a - b);
  if (!list.length) return;
  const current = currentSignal.peek();
  const follow = current && list.includes(current.pageIndex)
    ? { page: current.pageIndex, ordinal: Math.max(0, (r.pages.get(current.pageIndex) ?? []).indexOf(current)) }
    : null;
  /** The hit made current here while there was none (below), until somebody chooses another. */
  let chosen: SearchHit | null = null;
  const movesThen = moves;
  batch(() => {
    for (const p of list) {
      r.pages.delete(p);
      r.covered.delete(p);
    }
    publish(r);
    rereadingSignal.value += list.length;
  });
  let left = list.length;
  try {
    for (const p of list) {
      if (!live(r)) return;
      const step = await ask(r, p, p + 1).catch((e: unknown) => {
        if (unreadable(e)) return null;
        throw e;
      });
      if (!live(r)) return;
      batch(() => {
        const room = roomFor(r, p);
        const found = step ? step.hits.filter((h) => h.pageIndex === p) : [];
        const capped = found.length >= room;
        const hits = capped ? found.slice(0, Math.max(0, room - 1)) : found;
        if (hits.length) r.pages.set(p, hits);
        else r.pages.delete(p);
        if (step) r.covered.add(p);
        else skippedSignal.value++;
        if (capped) tooManySignal.value = true;
        publish(r);
        // Followed only while nobody chose another hit meanwhile (next or previous pressed).
        if (follow?.page === p && currentSignal.peek() === current) {
          const all = hitsSignal.peek();
          const next = hits.length
            ? hits[Math.min(follow.ordinal, hits.length - 1)]
            : all.find((h) => h.pageIndex > p) ?? all[0] ?? null;
          currentSignal.value = next;
        }
        // None current (none before, or the one followed went with none after it): while the run
        // has not ended, the first that comes back is its first hit (shown, as the run's own);
        // after, the first on or after the page shown, as ▼ would choose it, quietly, chosen again
        // as more pages come back until next or previous is pressed (also onto that same hit).
        if (moves === movesThen && currentSignal.peek() === chosen) {
          if (!r.told) chooseFirst(r, hits);
          else {
            const all = hitsSignal.peek();
            currentSignal.value = chosen = all.find((h) => h.pageIndex >= currentPage.peek()) ?? all[0] ?? null;
          }
        }
        rereadingSignal.value = Math.max(0, rereadingSignal.peek() - 1);
        left--;
      });
    }
    if (live(r) && tooManySignal.peek() && count(r) < MAX_HITS) void runSearch(r.query, r.options, true);
  } catch (e) {
    if (!live(r)) return;
    failedSignal.value = true;
    reportEngineError(e, t("search.failed"));
  } finally {
    if (live(r) && left > 0) rereadingSignal.value = Math.max(0, rereadingSignal.peek() - left);
  }
}

/** A history step landed (an edit, an undo, a redo, a page operation): what it means for the run. */
function afterHistory(h: HistoryState) {
  const r = run;
  if (!r || !live(r)) return;
  // A layout that keeps every page where it was (Oscura removed fields, so the form changed)
  // moves nothing: only its changed pages are read again.
  const from = h.layout?.from;
  if (from && !(from.length === r.count && from.every((f, i) => f === i))) {
    // The pages were laid out anew: every index may name another page now. Start over; quietly
    // once the run was told (the viewer shows the page operated on, the hit shown is not news),
    // else as it was asked: its first hit is still to be shown, its end still to be said.
    void runSearch(r.query, r.options, r.quiet || r.told);
    return;
  }
  if (h.changedPages.length) void reread(r, h.changedPages);
}

// Watch the document and its history from the start: another document stops the search; a step
// of the history reads its pages again (or starts over).
let seenHistory: HistoryState = history.peek();
history.subscribe((h) => {
  if (h === seenHistory) return;
  seenHistory = h;
  untracked(() => afterHistory(h));
});
let seenDoc: OpenDoc | null = doc.peek();
doc.subscribe((d) => {
  if (d === seenDoc) return;
  seenDoc = d;
  untracked(() => {
    if (run || querySignal.peek()) stopSearch();
  });
});
