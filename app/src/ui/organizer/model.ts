// The page organizer's state and its rules (release 4, "Pagine"): which pages are selected, the
// phone's "Seleziona" mode, what a click, a tap or a key does to the selection, the order a
// keyboard move makes (Alt+↑/↓), where a dragged page lands between the thumbnails and where the
// line between two of them is, the places between pages (their names, and a place held by its
// page while page operations land: GapPlace), and what the organizer says to screen readers.
//
// The selection holds PageModel keys (viewer/model.ts), never indices: keys are unique and never
// reused, so the selection follows its pages through every page operation, a deleted page
// simply drops out of it (and comes back selected with an undo), and a page of another document
// can never be selected by mistake. Everything here but the signals is pure, so the tests can
// check it without a browser (tests/organizer.test.ts).
import { signal } from "@preact/signals";
import { t } from "../../i18n";
import type { OpenDoc, PageModel } from "../../viewer/model";

// ---------------------------------------------------------------------------------------------
// Selection

/** The selected pages, by PageModel key, and the page a Shift range starts from (its key). */
export interface Selection {
  keys: ReadonlySet<number>;
  anchor: number | null;
}

export const NO_SELECTION: Selection = { keys: new Set(), anchor: null };

/** The pages selected in the organizer (the desktop panel, the phone's "Organizza" sheet). */
export const selection = signal<Selection>(NO_SELECTION);

/**
 * Phone: "Seleziona" is on, so a tap selects a page (its check box) instead of showing it, and
 * the action bar is there. Off again when the sheet closes.
 */
export const selectMode = signal(false);

export function clearSelection() {
  selection.value = NO_SELECTION;
}

/** The selected pages of `d` that are pages of it now, in page order. */
export function selectedIn(d: OpenDoc, sel: Selection = selection.value): PageModel[] {
  return sel.keys.size ? d.pages.filter((p) => sel.keys.has(p.key)) : [];
}

/** How a click or a key changes the selection: only this page, this page in or out, a range from the anchor to it. */
export type SelectHow = "only" | "toggle" | "range";

/**
 * The selection after choosing the page at `index` of `order` (the pages' keys in page order).
 * "only": that page alone (it becomes the anchor); "toggle": that page in or out, the others as
 * they were (it becomes the anchor); "range": the pages from the anchor to it, in place of the
 * others (the anchor stays; without one, that page alone, as the anchor).
 */
export function selectAt(order: readonly number[], current: Selection, index: number, how: SelectHow): Selection {
  const key = order[index];
  if (key === undefined) return current;
  if (how === "only") return { keys: new Set([key]), anchor: key };
  if (how === "toggle") {
    const keys = new Set(current.keys);
    if (keys.has(key)) keys.delete(key);
    else keys.add(key);
    return { keys, anchor: key };
  }
  const from = current.anchor === null ? -1 : order.indexOf(current.anchor);
  if (from < 0) return { keys: new Set([key]), anchor: key };
  const [a, b] = from <= index ? [from, index] : [index, from];
  return { keys: new Set(order.slice(a, b + 1)), anchor: current.anchor };
}

/** Every page of `order` (the keys in page order), the first one as the anchor. */
export function selectAll(order: readonly number[]): Selection {
  return { keys: new Set(order), anchor: order[0] ?? null };
}

/** "1 page selected" / "3 pages selected". */
export function selectedText(count: number): string {
  return count === 1 ? t("org.selectedOne") : t("org.selected", { count });
}

/** Deleting `count` of `pageCount` pages is allowed: never all of them (one always stays). */
export function canDelete(count: number, pageCount: number): boolean {
  return count > 0 && count < pageCount;
}

// ---------------------------------------------------------------------------------------------
// Moving pages: the keyboard's one step, and where a drop lands

/**
 * The order of a move (PagesEdit "move": `order[k]` is the page that goes to position k) that
 * takes each of `selected` (indices of `count` pages) one place up (`dir` -1) or down (+1), past
 * the page next to it that is not selected, as the WAI-ARIA rearrangeable listbox does: a block
 * of selected pages moves as one, and a page already at the top (or the bottom) stays, with the
 * selected pages right after it. Null when nothing would move.
 */
export function nudgeOrder(count: number, selected: readonly number[], dir: -1 | 1): number[] | null {
  const chosen = new Set(selected.filter((i) => Number.isInteger(i) && i >= 0 && i < count));
  if (!chosen.size) return null;
  const order = Array.from({ length: count }, (_, i) => i);
  const swap = (a: number, b: number) => {
    [order[a], order[b]] = [order[b], order[a]];
  };
  if (dir < 0) {
    for (let k = 1; k < count; k++) if (chosen.has(order[k]) && !chosen.has(order[k - 1])) swap(k, k - 1);
  } else {
    for (let k = count - 2; k >= 0; k--) if (chosen.has(order[k]) && !chosen.has(order[k + 1])) swap(k, k + 1);
  }
  return order.every((o, k) => o === k) ? null : order;
}

/** A thumbnail's box in the scroller's content (CSS px): where drops and the insert point are worked out. */
export interface Slot {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The place between pages (0 … slots.length: before page k, or at the end) nearest to the point
 * (x, y) in the scroller's content, for a drop or the insert point. One column ("list"): before
 * the first thumbnail whose middle is below the point. A grid: on the row the point is on (the
 * last row below them all), before the first thumbnail whose middle is right of it, else after
 * the row's last one.
 */
export function dropGap(slots: readonly Slot[], x: number, y: number, grid: boolean): number {
  const n = slots.length;
  if (!n) return 0;
  if (!grid) {
    for (let i = 0; i < n; i++) if (y < slots[i].top + slots[i].height / 2) return i;
    return n;
  }
  // Rows: runs of thumbnails at the same height.
  let start = 0;
  while (start < n) {
    let end = start;
    while (end + 1 < n && Math.abs(slots[end + 1].top - slots[start].top) < 1) end++;
    const bottom = Math.max(...slots.slice(start, end + 1).map((s) => s.top + s.height));
    if (y < bottom || end === n - 1) {
      for (let i = start; i <= end; i++) if (x < slots[i].left + slots[i].width / 2) return i;
      return end + 1;
    }
    start = end + 1;
  }
  return n;
}

/**
 * Where place `gap` is in the scroller's content: the middle of the line between two thumbnails
 * (a row in the list, a column in the grid), and how long that line is; null when there are no
 * thumbnails, or the boxes it needs were not measured. A place past either end (one held across
 * a page operation that took pages away) is taken as that end: never a box that is not there.
 */
export function gapLine(slots: readonly (Slot | undefined)[], gap: number, grid: boolean): { x: number; y: number; length: number } | null {
  const n = slots.length;
  if (!n) return null;
  const at = clampGap(gap, n);
  const before = slots[Math.min(at, n - 1)];
  if (!before) return null;
  if (!grid) {
    const prev = at > 0 ? slots[at - 1] : null;
    const next = at < n ? slots[at] : null;
    if (prev === undefined || next === undefined || (!prev && !next)) return null;
    const y = prev && next ? (prev.top + prev.height + next.top) / 2 : next ? next.top - 2 : prev!.top + prev!.height + 2;
    return { x: before.left + before.width / 2, y, length: before.width };
  }
  const x = at === n ? before.left + before.width + 2 : before.left - 2;
  return { x, y: before.top + before.height / 2, length: before.height };
}

/** Place `gap` within 0 … `count` (a whole number): a place held from before a page operation never names one past the end. */
export function clampGap(gap: number, count: number): number {
  const n = Math.max(0, Math.floor(count));
  return Number.isFinite(gap) ? Math.min(Math.max(0, Math.floor(gap)), n) : n;
}

/**
 * A place between pages held while page operations may land (an open "+" menu, the page picker's
 * "after page 3", the move dialog's "before page 5"): before page `before` wherever it goes, or at
 * the end (null). `at` is where it was, for when that page goes.
 */
export interface GapPlace {
  readonly before: PageModel | null;
  readonly at: number;
}

/** The place `gap` (0 … pageCount) of `pages` (a document's pages now), to hold. */
export function placeOfGap(pages: readonly PageModel[], gap: number): GapPlace {
  const at = clampGap(gap, pages.length);
  return { before: pages[at] ?? null, at };
}

/** Where `place` is in `pages` now (0 … pageCount): before its page, where it was when that page went, or the end. */
export function gapOfPlace(pages: readonly PageModel[], place: GapPlace): number {
  const page = place.before;
  if (!page) return pages.length;
  return pages[page.index] === page ? page.index : clampGap(place.at, pages.length);
}

// ---------------------------------------------------------------------------------------------
// Keys

/** Where a key moves the focus among the thumbnails. */
export type FocusMove = "prev" | "next" | "up" | "down" | "first" | "last";

/** What a key on a thumbnail does (thumbKeyAction). */
export type KeyAction =
  | { kind: "focus"; move: FocusMove; extend: boolean }
  | { kind: "nudge"; dir: -1 | 1 }
  | { kind: "toggle" }
  | { kind: "range" }
  | { kind: "pick" }
  | { kind: "delete" }
  | { kind: "all" }
  | { kind: "escape" };

export interface KeyInput {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/**
 * The organizer's keys on a thumbnail (null: not one of them, left to the browser and the app):
 * the arrows (← and → in the grid only), Home and End move the focus, with Shift they extend the
 * selection; Alt+↑ and Alt+↓ move the selected pages one place (Alt+← and → are left alone: the
 * browser's Back and Forward); Space selects or deselects (with Shift: a range), Enter shows the
 * page, Delete and Backspace delete, Ctrl/Cmd+A selects every page, Escape clears the selection.
 */
export function thumbKeyAction(e: KeyInput, grid: boolean): KeyAction | null {
  const command = e.ctrlKey || e.metaKey;
  const arrows: Record<string, FocusMove> = { ArrowUp: "up", ArrowDown: "down", Home: "first", End: "last" };
  if (grid) Object.assign(arrows, { ArrowLeft: "prev", ArrowRight: "next" });
  if (e.altKey) {
    if (command || e.shiftKey) return null;
    if (e.key === "ArrowUp") return { kind: "nudge", dir: -1 };
    if (e.key === "ArrowDown") return { kind: "nudge", dir: 1 };
    return null;
  }
  const move = arrows[e.key];
  if (move) return command ? null : { kind: "focus", move, extend: e.shiftKey };
  if (command) return !e.shiftKey && (e.key === "a" || e.key === "A") ? { kind: "all" } : null;
  if (e.key === " " || e.key === "Spacebar") return e.shiftKey ? { kind: "range" } : { kind: "toggle" };
  if (e.shiftKey) return null;
  if (e.key === "Enter") return { kind: "pick" };
  if (e.key === "Delete" || e.key === "Backspace") return { kind: "delete" };
  if (e.key === "Escape") return { kind: "escape" };
  return null;
}

/**
 * The thumbnail the focus goes to from `i` (0 … `last`) in `cols` columns (1 in the list): one
 * row up or down, the one before or after, the first, the last. Down onto a shorter last row goes
 * to its last thumbnail; past an edge it stays (`i`).
 */
export function nextFocus(i: number, last: number, cols: number, move: FocusMove): number {
  let next: number;
  switch (move) {
    case "up":
      next = i - cols;
      break;
    case "down":
      next = i + cols;
      if (next > last) next = Math.floor(i / cols) < Math.floor(last / cols) ? last : i;
      break;
    case "prev":
      next = i - 1;
      break;
    case "next":
      next = i + 1;
      break;
    case "first":
      next = 0;
      break;
    case "last":
      next = last;
      break;
  }
  return next >= 0 && next <= last ? next : i;
}

// ---------------------------------------------------------------------------------------------
// Places between pages

/** Place `gap` (0 … pageCount) in words: "at the start", "after page 3". */
export function gapText(gap: number): string {
  return gap <= 0 ? t("org.atStart") : t("org.afterPage", { page: gap });
}

/** The name of the "+" at place `gap`: "Add pages after page 3". */
export function insertLabel(gap: number): string {
  return t("org.insertAt", { where: gapText(gap) });
}

// ---------------------------------------------------------------------------------------------
// What the organizer says

/**
 * The organizer's own words for screen readers (a status region in the panel and in the sheet):
 * what a move or a turn did, which shows at once and has no toast. `id` changes every time, so
 * the same words are said again.
 */
export const orgStatus = signal<{ id: number; text: string } | null>(null);
let statusId = 0;

export function announce(text: string) {
  orgStatus.value = { id: ++statusId, text };
}

/**
 * Turns waiting to show: by PageModel key, the degrees (clockwise) a page was turned since its
 * thumbnail was drawn, at the page revision the turn gave it. Until the new bitmap comes, the
 * thumbnail shows the old one turned, so a rotation shows at once; at any other revision (an
 * undo, another change) the turn no longer applies.
 */
export const pageTurns = signal<ReadonlyMap<number, { deg: number; rev: number }>>(new Map());

/**
 * `pages` were just turned by `by` degrees, in one step, each to the revision it has now; `before`
 * gives, by PageModel key, the revision each had right before that step (read in the engine's
 * queue as the step was sent: commands.ts, rotatePages). One more turn when the turn shown was
 * still the page's right before the step (two quick turns, whatever else landed between them
 * without changing that page: the old bitmap shows both, 180° after two of 90°), else a fresh one
 * (an undo, or another change of the page, came between). Not "the revision before this one": a
 * 90° turn gives a page two new revisions (one for its new size, one for the page it changed).
 */
export function addTurns(pages: readonly PageModel[], by: number, before: ReadonlyMap<number, number>) {
  const turns = new Map(pageTurns.peek());
  for (const page of pages) {
    const rev = page.rev.peek();
    const prior = turns.get(page.key);
    const still = prior !== undefined && before.has(page.key) && prior.rev === before.get(page.key);
    const deg = ((still ? prior.deg : 0) + by) % 360;
    if (deg) turns.set(page.key, { deg, rev });
    else turns.delete(page.key);
  }
  pageTurns.value = turns;
}

/** The thumbnail of `key` has drawn its page again: no turn to show any more. */
export function dropTurn(key: number) {
  if (!pageTurns.peek().has(key)) return;
  const turns = new Map(pageTurns.peek());
  turns.delete(key);
  pageTurns.value = turns;
}
