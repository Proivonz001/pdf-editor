// Cerca for the UI (release 5): whether the search is open (the find bar at the top of the
// viewer on desktop, the search in place of the top bar on phones), what its field holds, the
// three options (all off: case, accents, apostrophes and dashes are ignored, parts of words are
// found), the field asking for the focus, what the status region says, and the actions of the
// field, its buttons, the options menu and the keys (ui/shortcuts.ts). The search itself runs in
// runner.ts; this module starts it, moves through its hits and says what happens.
//
// The field searches as you type, once typing pauses (SEARCH_DEBOUNCE_MS), and at once on Enter.
// Enter, the next button, F3 and Ctrl+G then go to the next hit, with Shift to the previous one,
// wrapping round at the ends ("Ricomincio dall'inizio"). The current hit is scrolled into the
// middle of the view (the viewer registers how: setHitRevealer) and said to screen readers with its
// page and the words round it, since the page itself is a picture to them. The status region never
// keeps words that are no longer so: a new search, the field emptied, an edit, an undo, a redo or
// a page operation empty it (hits that come back that way are not said). Closing the search
// (Esc, ✕, the rail's Cerca again) forgets the hits and puts the focus back where it was; the text
// typed stays for the next time, but not for another document. Opening it again searches that
// text again.
import { batch, computed, signal, untracked, type ReadonlySignal } from "@preact/signals";
import type { SearchHit, SearchOptions } from "../../engine/protocol";
import { t } from "../../i18n";
import { doc, editingStopped, history } from "../../state";
import type { OpenDoc } from "../../viewer/model";
import { rescueFocus, viewerScroller } from "../focus";
import { isMac, isNarrow } from "../media";
import type { MenuItem } from "../Menu";
import {
  currentHitIndex, MAX_HITS, moveCurrent, runSearch, sameOptions, searchableQuery, searchBusy, searchedOptions,
  searchFailed, searchHits, searchProgress, searchQuery, searchSkipped, searchTooMany, setSearchHooks, stopSearch,
} from "./runner";

export { searchHits, searchQuery } from "./runner";

/** Typing pauses this long (ms) before the field searches by itself. */
export const SEARCH_DEBOUNCE_MS = 300;
/** A run still going after this long (ms) is said to be going, once. */
const SAY_PROGRESS_MS = 1500;

/** Ctrl+F (⌘F on a Mac): the tooltips name it. */
export const searchShortcut = isMac ? "⌘F" : "Ctrl+F";
/** The same keys for aria-keyshortcuts. */
export const searchKeys = isMac ? "Meta+F" : "Control+F";

const openSignal = signal(false);
const inputSignal = signal("");
const optionsSignal = signal<SearchOptions>({});
const typingSignal = signal(false);
const focusSignal = signal(0);
const statusSignal = signal<{ id: number; text: string } | null>(null);
const noticeSignal = signal<"wrapped" | "wrappedEnd" | null>(null);

/** The search is open: the find bar (desktop) or the search in place of the top bar (phones). */
export const searchOpen: ReadonlySignal<boolean> = openSignal;
/** What the search field holds. */
export const searchInput: ReadonlySignal<string> = inputSignal;
/** The options the next search uses (the menu's check boxes). */
export const searchOptions: ReadonlySignal<SearchOptions> = optionsSignal;
/** Bumped to ask the search field for the focus, with its text selected (SearchBar.tsx). */
export const searchFocus: ReadonlySignal<number> = focusSignal;
/** What the search's status region says; `id` changes every time, so the same words are said again. */
export const searchStatus: ReadonlySignal<{ id: number; text: string } | null> = statusSignal;

/** The field takes the focus or lets it go. */
export function setSearchTyping(on: boolean): void {
  typingSignal.value = on;
}

let statusId = 0;
/** Say `text` in the search's status region (polite). */
function say(text: string) {
  statusSignal.value = { id: ++statusId, text };
}

// ---------------------------------------------------------------------------------------------
// Scrolling to a hit

type Revealer = (hit: SearchHit) => void;
let revealer: Revealer | null = null;

/** The viewer registers how to bring a hit into the middle of the view (null when it goes). */
export function setHitRevealer(next: Revealer | null): void {
  revealer = next;
}

function reveal(hit: SearchHit) {
  revealer?.(hit);
}

// ---------------------------------------------------------------------------------------------
// What is shown and said

/** The words round a hit, for screen readers: "…before match after…", spaces made single. */
function contextOf(hit: SearchHit): string {
  return `${hit.before}${hit.match}${hit.after}`.replace(/\s+/g, " ").trim();
}

/** What screen readers hear for the hit `index` of `total` (as the count shows it: "1000+"). */
export function announceText(hit: SearchHit, index: number, total: number | string): string {
  const common = { current: index + 1, total, page: hit.pageIndex + 1, context: contextOf(hit) };
  return hit.in === "field" && hit.field
    ? t("search.announceField", { ...common, field: hit.field })
    : t("search.announce", common);
}

/** The hits shown, as the count says them: "1000+" when there are more. */
function totalText(): string | number {
  const n = searchHits.value.length;
  return searchTooMany.value ? `${n}+` : n;
}

/**
 * The count in the search field: "3 di 12" (`short`, on phones: "3/12"); null when nothing is
 * searched, and on desktop while nothing is found (the note says why). On phones "0/0" for no
 * results and "…" while the first ones are being looked for.
 */
export function searchCountText(short: boolean): string | null {
  if (!searchQuery.value) return null;
  const hits = searchHits.value;
  if (!hits.length) {
    if (!short) return null;
    if (searchProgress.value) return "…";
    return t("search.countShort", { current: 0, total: 0 });
  }
  const current = Math.max(0, currentHitIndex.value + 1);
  return t(short ? "search.countShort" : "search.count", { current, total: totalText() });
}

/** Pages the last run could not read, said; null when there were none. */
function skippedText(): string | null {
  const count = searchSkipped.value;
  return count ? t(count === 1 ? "search.skippedOne" : "search.skipped", { count }) : null;
}

/**
 * The note beside the count on desktop (on phones the line under the search): the run going
 * ("Cerco… pagina 37 di 220"), a failure, pages that could not be read, more than MAX_HITS, no
 * results, or the wrap just made. Null when there is nothing to say.
 */
export function searchNoteText(): string | null {
  if (!searchQuery.value) return null;
  if (searchFailed.value) return t("search.failed");
  const progress = searchProgress.value;
  if (progress) return t("search.searching", { page: progress.page, pages: progress.pages });
  const skipped = skippedText();
  if (skipped) return skipped;
  if (searchTooMany.value) return t("search.tooMany", { limit: MAX_HITS });
  if (!searchHits.value.length) return t("search.none");
  const notice = noticeSignal.value;
  if (notice) return t(notice === "wrapped" ? "search.wrapped" : "search.wrappedEnd");
  return null;
}

// ---------------------------------------------------------------------------------------------
// Running the search

let timer: ReturnType<typeof setTimeout> | null = null;
let progressTimer: ReturnType<typeof setTimeout> | null = null;

function clearTimers() {
  if (timer) clearTimeout(timer);
  if (progressTimer) clearTimeout(progressTimer);
  timer = null;
  progressTimer = null;
}

/** The hits shown are for what the field holds now, with the options set now. */
function searchedNow(): boolean {
  return timer === null && !searchFailed.peek() && searchQuery.peek() !== "" &&
    searchQuery.peek() === searchableQuery(inputSignal.peek()) && sameOptions(searchedOptions.peek(), optionsSignal.peek());
}

/** Search for what the field holds now, with the options set now (nothing in it: no search). */
function runNow(): void {
  clearTimers();
  noticeSignal.value = null;
  statusSignal.value = null;
  const query = searchableQuery(inputSignal.peek());
  if (!query) {
    stopSearch();
    return;
  }
  void runSearch(query, optionsSignal.peek());
  progressTimer = setTimeout(() => {
    progressTimer = null;
    const progress = searchProgress.peek();
    if (progress) say(t("search.searching", { page: progress.page, pages: progress.pages }));
  }, SAY_PROGRESS_MS);
}

// What the runner tells: the first hit of a run is scrolled to; at the end of a run, the current
// hit (or "no results", or "more than 1000") is said. Runs asked for by rerunSearch are quiet.
setSearchHooks({
  chosen(hit, quiet) {
    if (!quiet) reveal(hit);
  },
  ended(hits, quiet) {
    if (progressTimer) clearTimeout(progressTimer);
    progressTimer = null;
    if (quiet || !openSignal.peek()) return;
    if (searchFailed.peek()) {
      say(t("search.failed"));
      return;
    }
    const index = Math.max(0, currentHitIndex.peek());
    const said = [
      untracked(skippedText),
      searchTooMany.peek() ? t("search.tooMany", { limit: MAX_HITS }) : null,
      hits.length ? announceText(hits[index], index, untracked(totalText)) : t("search.none"),
    ];
    say(said.filter(Boolean).join(". "));
  },
});

// ---------------------------------------------------------------------------------------------
// Actions

/** What had the focus before the search opened: it gets it back when the search closes. */
let returnFocus: HTMLElement | null = null;

function focusedElement(): HTMLElement | null {
  if (typeof document === "undefined" || typeof HTMLElement === "undefined") return null;
  const active = document.activeElement;
  return active instanceof HTMLElement && active !== document.body ? active : null;
}

/**
 * Open the search (Ctrl/⌘+F, the rail's Cerca, the phone's magnifier), or, when it is open, give
 * its field the focus again; its text is selected, so typing replaces it. Opened with text in the
 * field (kept from last time), it searches that again. Nothing without a document.
 */
export function openSearch(): void {
  if (!doc.peek()) return;
  batch(() => {
    if (!openSignal.peek()) {
      // Not the bar itself, nor the hidden field that holds the phone's keyboard (SearchBar.tsx).
      const active = focusedElement();
      returnFocus = active && !active.closest?.("[data-search-bar], [data-search-keeper]") ? active : null;
      openSignal.value = true;
      if (searchableQuery(inputSignal.peek())) runNow();
    }
    focusSignal.value++;
  });
}

/**
 * Close the search: the hits and their highlights go, what runs stops, and the focus goes back
 * to what had it before (or, when that went, to the button that opens the search, else the page).
 */
export function closeSearch(): void {
  if (!openSignal.peek()) return;
  clearTimers();
  batch(() => {
    openSignal.value = false;
    typingSignal.value = false;
    noticeSignal.value = null;
    statusSignal.value = null;
  });
  stopSearch();
  const back = returnFocus;
  returnFocus = null;
  if (typeof document === "undefined") return;
  // On phones the magnifier that opened it is back in the top bar; on desktop the page.
  rescueFocus(() => (back?.isConnected ? back : null) ??
    (isNarrow.peek() ? document.querySelector<HTMLElement>("[data-search-toggle]") : null) ?? viewerScroller());
}

/** The rail's Cerca: open the search, or close it when it is open. */
export function toggleSearch(): void {
  if (openSignal.peek()) closeSearch();
  else openSearch();
}

/** The field's text changed: search once typing pauses; emptied, the hits go at once. */
export function setSearchInput(text: string): void {
  inputSignal.value = text;
  if (timer) clearTimeout(timer);
  timer = null;
  if (!searchableQuery(text)) {
    clearTimers();
    noticeSignal.value = null;
    statusSignal.value = null;
    stopSearch();
    return;
  }
  if (searchQuery.peek() === searchableQuery(text) && sameOptions(searchedOptions.peek(), optionsSignal.peek()) &&
    !searchFailed.peek()) return; // only spaces changed round it
  timer = setTimeout(() => {
    timer = null;
    runNow();
  }, SEARCH_DEBOUNCE_MS);
}

/**
 * Go to the next hit (`dir` 1) or the previous one (-1): Enter in the field, the arrows, F3,
 * Ctrl+G. When the hits shown are not for what the field holds (typing has not paused yet, an
 * option changed), it searches first instead. The hit is scrolled to and said; a wrap round the
 * end is said too.
 */
export function goToResult(dir: 1 | -1): void {
  if (!openSignal.peek()) return;
  if (!searchedNow()) {
    runNow();
    return;
  }
  const moved = moveCurrent(dir);
  if (!moved) {
    if (!searchBusy.peek()) say(t("search.none"));
    return;
  }
  const notice = moved.wrapped ? (dir > 0 ? "wrapped" : "wrappedEnd") : null;
  noticeSignal.value = notice;
  reveal(moved.hit);
  const text = announceText(moved.hit, moved.index, untracked(totalText));
  say(notice ? `${t(notice === "wrapped" ? "search.wrapped" : "search.wrappedEnd")}. ${text}` : text);
}

export type SearchOptionKey = "wholeWord" | "caseSensitive" | "matchDiacritics";

/** Turn an option on or off; with text in the field, search again at once. */
export function toggleSearchOption(key: SearchOptionKey): void {
  const options = { ...optionsSignal.peek() };
  if (options[key]) delete options[key]; // only the options that are on: {} is the default
  else options[key] = true;
  optionsSignal.value = options;
  if (openSignal.peek() && searchableQuery(inputSignal.peek())) runNow();
}

/**
 * "Oscura tutti i risultati…" can be offered: there are hits, every page has been read (no run
 * and no page read again after an edit still going, none failed or skipped: the list is whole
 * and up to date), and the document can still be edited.
 */
export const canRedactAll = computed(() =>
  searchHits.value.length > 0 && !searchBusy.value && !searchFailed.value && !searchSkipped.value &&
  searchQuery.value !== "" && !editingStopped.value);

/**
 * The options menu (ui/Menu.tsx): the check boxes Parole intere, Maiuscole/minuscole, Distingui le
 * lettere accentate, then the action "Oscura tutti i risultati…", which hands the hits shown,
 * their query and their options to `redactAll` (the review dialog of ui/redact).
 */
export function searchMenuItems(
  redactAll: (hits: SearchHit[], query: string, options: SearchOptions) => void,
): MenuItem[] {
  const o = optionsSignal.value;
  return [
    { key: "wholeWord", label: t("search.wholeWords"), checked: !!o.wholeWord, onSelect: () => toggleSearchOption("wholeWord") },
    { key: "caseSensitive", label: t("search.matchCase"), checked: !!o.caseSensitive, onSelect: () => toggleSearchOption("caseSensitive") },
    {
      key: "matchDiacritics", label: t("search.matchAccents"), checked: !!o.matchDiacritics,
      onSelect: () => toggleSearchOption("matchDiacritics"),
    },
    {
      key: "redactAll", label: t("search.redactAll"), disabled: !canRedactAll.value, divider: true,
      onSelect: () => {
        if (!canRedactAll.peek()) return;
        redactAll([...searchHits.peek()], searchQuery.peek(), { ...searchedOptions.peek() });
      },
    },
  ];
}

/** The search is shown on phones and its field takes typing: the bars at the bottom make room. */
export function searchTakesTyping(): boolean {
  return typingSignal.value && openSignal.value && isNarrow.value;
}

// An edit, an undo, a redo or a page operation: the hits go, come back or move without a word
// (runner.ts), so what the status region said about them is no longer so and goes.
history.subscribe(() => {
  statusSignal.value = null;
});

// Another document (or none): the search closes and forgets its text, which belongs to the
// document it was typed for. The options stay, for the session.
let seenDoc: OpenDoc | null = doc.peek();
doc.subscribe((d) => {
  if (d === seenDoc) return;
  seenDoc = d;
  untracked(() => {
    clearTimers();
    returnFocus = null;
    batch(() => {
      openSignal.value = false;
      typingSignal.value = false;
      inputSignal.value = "";
      noticeSignal.value = null;
      statusSignal.value = null;
    });
    stopSearch();
  });
});
