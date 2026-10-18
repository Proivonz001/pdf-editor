// Page thumbnails, which are also the page organizer (release 4), shared by the desktop pages
// panel ("list": one column) and the phone's "Organizza" sheet ("grid": as many columns as fit).
//
// Bitmaps: the component is its own scroller and the root of its IntersectionObservers: only
// thumbnails within about a screen of the visible part get a bitmap, and canvases further than
// about four screens are released, so a 200-page document stays light. Bitmaps come through a
// render queue of its own (one request at a time: the thumbnails on screen first, then by distance
// from the current page), never the viewer's, and every request waits until the list has been
// still for ~150 ms after mounting, scrolling or a page change, so the thumbnails never hold up
// the main viewer. The scale follows the thumbnail's CSS width × devicePixelRatio, within a pixel
// budget. The current page's thumbnail is kept in view while the viewer moves, unless the user
// scrolled the thumbnails in the last second.
//
// Organizing: the thumbnails are a listbox with aria-multiselectable, one option per page, keyed
// by PageModel.key, so after a page operation each thumbnail (its bitmap, its state) stays with
// its own page; a page turned shows its old bitmap turned until the new one comes. The listbox
// holds only the options: the "+" between pages, the "+" at the end, the drop marker and the
// dragged pages' label sit beside it in the scroller.
// - Desktop: a click shows the page and selects it alone; Ctrl/Cmd+click adds or removes a page,
//   Shift+click selects a range. Phone: a tap shows the page (and closes the sheet); with
//   "Seleziona" on (ui/organizer: selectMode) a tap selects instead, with check boxes. A long
//   press without moving selects too (on the phone it turns "Seleziona" on).
// - Drag to reorder, with pointer events: the mouse drags once it moved a few pixels; touch and
//   pen after a long press (~350 ms) without moving, so a swipe still scrolls; near the top or the
//   bottom edge the list scrolls by itself; a marker shows where the pages will go. A selected
//   page drags the whole selection. Escape cancels.
// - Keys (one tab stop, a roving tabindex that follows the current page while the focus is
//   elsewhere): arrows (all four in the grid), Home and End move the focus, with Shift they extend
//   the selection; Space selects, Enter shows the page, Ctrl/Cmd+A selects all, Alt+↑/↓ move the
//   selected pages (or the focused one) one place, Delete deletes them, Escape clears the
//   selection (or leaves "Seleziona"). After a page operation the focus stays on its page, or on
//   the page that took the place of a deleted one.
// - "+": at the end of the list always, and between pages where the mouse is (or before the
//   thumbnail with the focus: the next tab stop), with a menu: a blank page, pages of another PDF,
//   a photo or a scan. A PDF file dragged in from outside and dropped between thumbnails adds its
//   pages there (ui/organizer/dropZone.ts, ui/DropOverlay.tsx).
// - A page operation can land at any time (one asked before, an undo): what is held from before
//   it follows it or is worked out again, never naming a page that is not there: the "+" menu's
//   place is held by its page, the mouse's place is forgotten, a drag's boxes and a dragged file's
//   are measured again.
// - Nothing changes the pages once editing has stopped: no drag, no "+", no keys that change them.
// Every change goes through ui/organizer/commands.ts and ui/pageActions.ts, one edit each.
import { computed, signal, useComputed, type ReadonlySignal } from "@preact/signals";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { t } from "../i18n";
import { currentPage, devicePixelRatio, editedKeys, editingStopped, engine } from "../state";
import {
  deletePages, dragText, movePagesBefore, nudgePages, openInsertFromPdf, pagesFor,
} from "../ui/organizer/commands";
import { registerPdfDropZone } from "../ui/organizer/dropZone";
import { InsertMenu } from "../ui/organizer/InsertMenu";
import {
  clampGap, clearSelection, dropGap, dropTurn, gapLine, gapOfPlace, insertLabel, nextFocus, pageTurns, placeOfGap,
  selectAll, selectAt, selection, selectMode, thumbKeyAction, type GapPlace, type SelectHow, type Slot,
} from "../ui/organizer/model";
import { IconCheck, IconPlus } from "../ui/icons";
import { moveOrder } from "../ui/pageActions";
import type { OpenDoc, PageModel } from "./model";
import { RenderQueue } from "./renderQueue";
import { goToPage } from "./zoom";

export interface PageThumbnailsProps {
  doc: OpenDoc;
  /** "list": one column (desktop panel); "grid": as many columns as fit (phone sheet). */
  variant: "list" | "grid";
  /** Called after a thumbnail was chosen and the viewer moved to its page. */
  onPick?: (index: number) => void;
}

/** Ask for a bitmap only once the list has been still this long (ms). */
const QUIET_MS = 150;
/** After the user scrolls the thumbnails, the current page is not followed for this long (ms). */
const USER_SCROLL_HOLD_MS = 1000;
/** Pixel budget of one thumbnail bitmap. */
const MAX_PIXELS = 300_000;
/** Bitmap for thumbnails within about one screen of the visible part... */
const NEAR_MARGIN = "100% 0px";
/** ...and the canvas kept within about four; further away it is released. */
const KEEP_MARGIN = "400% 0px";
/** Priority penalty of a thumbnail that is not on screen (it waits for all those that are). */
const OFFSCREEN = 1_000_000;
/** Room left between a revealed thumbnail and the edge of the list (px). */
const EDGE = 8;
/** Grid slots are as tall as the tallest page shape, within these height / width ratios. */
const MIN_SLOT_RATIO = 0.5;
const MAX_SLOT_RATIO = 1.5;
/** A redraw is worth it when the box needs a scale this much above the one drawn. */
const SHARPER = 1.05;
/** A touch held this long without moving starts a drag (or, released, selects) (ms). */
const LONG_PRESS_MS = 350;
/** A mouse drag starts once the pointer moved this far (px)... */
const MOUSE_SLOP = 5;
/** ...a touch that moves this far before the long press is a scroll (px). */
const TOUCH_SLOP = 10;
/** While dragging, the list scrolls by itself within this distance of its top or bottom edge (px)... */
const SCROLL_EDGE = 48;
/** ...by up to this many pixels a frame. */
const SCROLL_STEP = 14;
/** A click this soon after a drag or a long press ended belongs to it (ms). */
const CLICK_AFTER_MS = 600;
/** Size of the "+" between pages (px; organizer.css). */
const PLUS = 28;

/** Pixels per point for a thumbnail `cssWidth` CSS px wide on a screen with `ratio` device px per CSS px. */
export function thumbScale(page: PageModel, cssWidth: number, ratio: number): number {
  const wanted = (cssWidth * ratio) / page.width;
  const scale = Math.min(wanted, Math.sqrt(MAX_PIXELS / (page.width * page.height)));
  // To 1/1000, down so the budget holds (never 0: the engine refuses it).
  return Math.max(1, Math.floor(scale * 1000)) / 1000;
}

/** Height / width of the grid slots: the document's tallest page shape, within limits. */
function slotRatio(pages: readonly PageModel[]): number {
  let tallest = 0;
  for (const p of pages) tallest = Math.max(tallest, p.height / p.width);
  return Math.min(MAX_SLOT_RATIO, Math.max(MIN_SLOT_RATIO, tallest || Math.SQRT2));
}

/**
 * The thumbnail in the Tab order of the thumbnails on screen, if any: where the focus goes when
 * the control that had it went with an action (the action bar's Delete, its last pages gone).
 */
export function thumbFocusTarget(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.thumbs [role="option"][tabindex="0"]');
}

interface ThumbTarget {
  page: PageModel;
  setNear(near: boolean): void;
  setKeep(keep: boolean): void;
}

/**
 * Three IntersectionObservers on the list: "seen" (on screen: rendered first), "near" (about one
 * screen around: gets a bitmap) and "keep" (about four: keeps its canvas). Thumbnails register
 * before the list is connected (child effects run first): they are observed once it is.
 */
class ThumbObserver {
  private observers: IntersectionObserver[] = [];
  private readonly targets = new Map<Element, ThumbTarget>();
  /** The pages whose thumbnails are on screen. */
  readonly seen = new Set<PageModel>();

  connect(root: HTMLElement) {
    const watch = (rootMargin: string, update: (target: ThumbTarget, on: boolean) => void) =>
      new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const target = this.targets.get(entry.target);
            if (target) update(target, entry.isIntersecting);
          }
        },
        { root, rootMargin },
      );
    this.observers = [
      watch("0px", (x, on) => {
        if (on) this.seen.add(x.page);
        else this.seen.delete(x.page);
      }),
      watch(NEAR_MARGIN, (x, on) => x.setNear(on)),
      watch(KEEP_MARGIN, (x, on) => x.setKeep(on)),
    ];
    for (const el of this.targets.keys()) for (const o of this.observers) o.observe(el);
  }

  observe(el: Element, target: ThumbTarget) {
    this.targets.set(el, target);
    for (const o of this.observers) o.observe(el);
  }

  unobserve(el: Element) {
    const target = this.targets.get(el);
    if (target) this.seen.delete(target.page);
    this.targets.delete(el);
    for (const o of this.observers) o.unobserve(el);
  }

  disconnect() {
    for (const o of this.observers) o.disconnect();
    this.observers = [];
    this.targets.clear();
    this.seen.clear();
  }
}

/** What the thumbnails of one mounted list share: observers, render queue, scroll and focus state. */
class ThumbServices {
  readonly obs = new ThumbObserver();
  readonly queue: RenderQueue;
  /** The thumbnail in the Tab order, by PageModel key; null: the current page's. */
  readonly roving = signal<number | null>(null);
  /** The key that is tabbable: `roving` while it is a page of the document, else the current page's. */
  readonly rovingKey: ReadonlySignal<number | null>;
  /** Its index: the keyboard's "+" is right before it. */
  readonly rovingIndex: ReadonlySignal<number>;
  /**
   * The place between pages (0 … pageCount) where the mouse is, for the "+"; null when it is not
   * over the list. Forgotten when the pages change (the next move of the mouse sets it again).
   */
  readonly hoverGap = signal<number | null>(null);
  /** The place whose "+" menu is open, held by its page (it follows page operations), or null. */
  readonly menuPlace = signal<GapPlace | null>(null);
  /** The pages being dragged (shown faded), by key. */
  readonly dragKeys = signal<ReadonlySet<number>>(new Set());
  /** When the list last scrolled (or was created): requests wait for QUIET_MS after it. */
  lastScroll = performance.now();
  /** The thumbnail that had the focus last, and where it was: the focus goes back there after a page operation. */
  focusKey: number | null = null;
  focusIndex = 0;
  /** The focus is in the list (or was, until a page operation took its thumbnail away). */
  focusInList = false;
  /** When the user last scrolled the list (wheel, touch, scrollbar, keyboard). */
  private userScrollAt = -Infinity;
  /** scrollTop right after our own last scroll, to tell it apart from the user's. */
  private autoTop = 0;
  root: HTMLElement | null = null;
  list: HTMLElement | null = null;

  constructor(readonly doc: OpenDoc) {
    this.queue = new RenderQueue(
      engine(),
      (i) => (this.obs.seen.has(this.doc.pages[i]) ? 0 : OFFSCREEN) + Math.abs(i - currentPage.peek()),
      1,
    );
    this.rovingKey = computed(() => {
      const pages = this.doc.pages; // (reads doc.layout: follows page operations)
      const key = this.roving.value;
      if (key !== null && pages.some((p) => p.key === key)) return key;
      return pages[Math.min(Math.max(0, currentPage.value), pages.length - 1)]?.key ?? null;
    });
    this.rovingIndex = computed(() => {
      const key = this.rovingKey.value;
      return Math.max(0, this.doc.pages.findIndex((p) => p.key === key));
    });
  }

  connect(root: HTMLElement, list: HTMLElement) {
    this.root = root;
    this.list = list;
    this.autoTop = root.scrollTop;
    this.obs.connect(root);
  }

  dispose() {
    this.root = null;
    this.list = null;
    this.obs.disconnect();
    this.queue.dispose();
  }

  /** Milliseconds until the list has been still for QUIET_MS (0 or less: now). */
  quietIn(): number {
    return this.lastScroll + QUIET_MS - performance.now();
  }

  onScroll() {
    const el = this.root;
    if (!el) return;
    this.lastScroll = performance.now();
    if (Math.abs(el.scrollTop - this.autoTop) > 1) this.userScrollAt = this.lastScroll;
  }

  userScrolledRecently(): boolean {
    return performance.now() - this.userScrollAt < USER_SCROLL_HOLD_MS;
  }

  /** Scrolled by the list itself (a drag near an edge): not the user browsing it. */
  scrollBy(dy: number) {
    const el = this.root;
    if (!el) return;
    el.scrollTop += dy;
    this.autoTop = el.scrollTop;
  }

  item(index: number): HTMLElement | null {
    const node = this.list?.children[index];
    return node instanceof HTMLElement ? node : null;
  }

  /**
   * Scroll the list (only the list: scrollIntoView would move the sheet or the page too) so that
   * thumbnail `index` is in view: centred, or else by the least amount ("nearest").
   */
  reveal(index: number, centre: boolean) {
    const el = this.root;
    const item = this.item(index);
    if (!el || !item || el.clientHeight === 0) return;
    const view = el.getBoundingClientRect();
    const r = item.getBoundingClientRect();
    let delta: number;
    if (centre) delta = r.top + r.height / 2 - (view.top + view.height / 2);
    else if (r.top >= view.top && r.bottom <= view.bottom) return;
    else if (r.top < view.top || r.height > view.height - 2 * EDGE) delta = r.top - view.top - EDGE;
    else delta = r.bottom - view.bottom + EDGE;
    if (Math.abs(delta) < 1) return;
    el.scrollTop += delta;
    this.autoTop = el.scrollTop;
  }

  /** Keyboard: move the focus to thumbnail `index` and bring it into view. */
  focus(index: number) {
    const item = this.item(index);
    if (!item) return;
    item.focus({ preventScroll: true });
    this.reveal(index, false);
    this.userScrollAt = performance.now(); // browsing the thumbnails: do not pull them back
  }

  /** The thumbnails' boxes in the scroller's content, in page order (for drops). */
  slots(): Slot[] {
    const list = this.list;
    if (!list) return [];
    return [...list.children].map((c) => slotOf(c as HTMLElement));
  }

  /** The same, measuring only the boxes on either side of place `gap` and the last one (for the "+"). */
  slotsAround(gap: number): Slot[] {
    const items = this.list?.children;
    const slots: Slot[] = [];
    if (!items) return slots;
    slots.length = items.length;
    for (const i of [gap - 1, gap, items.length - 1]) {
      if (i >= 0 && i < items.length) slots[i] = slotOf(items[i] as HTMLElement);
    }
    return slots;
  }

  /** The client point (x, y) in the scroller's content. */
  toContent(x: number, y: number): [number, number] {
    const el = this.root;
    if (!el) return [x, y];
    const r = el.getBoundingClientRect();
    return [x - r.left - el.clientLeft + el.scrollLeft, y - r.top - el.clientTop + el.scrollTop];
  }
}

/** A thumbnail's box in the scroller's content (its offsetParent: .thumbs is positioned, the listbox is not). */
function slotOf(el: HTMLElement): Slot {
  return { left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight };
}

/** Number of columns of the grid: the thumbnails on the same row as the first one. */
function columnCount(el: HTMLElement): number {
  const items = el.children;
  const first = items[0];
  if (!(first instanceof HTMLElement)) return 1;
  let n = 1;
  while (n < items.length) {
    const item = items[n];
    if (!(item instanceof HTMLElement) || item.offsetTop !== first.offsetTop) break;
    n++;
  }
  return n;
}

interface ThumbProps {
  page: PageModel;
  services: ThumbServices;
  /** Changes when the list's width changed enough to re-check the scale. */
  sizeKey: number;
  /** The phone's "Seleziona": check boxes on every thumbnail. */
  checkboxes: boolean;
}

function Thumb({ page, services, sizeKey, checkboxes }: ThumbProps) {
  const el = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLSpanElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  /** What the canvas currently shows: at which scale, revision and page shape (width / height). */
  const drawn = useRef<{ scale: number; rev: number; ar: number } | null>(null);
  const [near, setNear] = useState(false);
  const [keep, setKeep] = useState(false);
  const [ready, setReady] = useState(false);
  const layout = services.doc.layout;
  // Computed per thumbnail: a page change (or a move of the tab stop, a selection) re-renders the
  // thumbnails concerned, not all. The index is read again whenever the pages change (`layout`).
  const current = useComputed(() => {
    void layout.value;
    return currentPage.value === page.index;
  }).value;
  const tabbable = useComputed(() => services.rovingKey.value === page.key).value;
  const edited = useComputed(() => editedKeys.value.has(page.key)).value;
  const selected = useComputed(() => selection.value.keys.has(page.key)).value;
  const dragging = useComputed(() => services.dragKeys.value.has(page.key)).value;
  const turn = useComputed(() => pageTurns.value.get(page.key) ?? null).value;
  const rev = page.rev.value;
  const ratio = devicePixelRatio.value;
  const hasCanvas = keep || near;
  const index = page.index;

  useLayoutEffect(() => {
    const node = el.current!;
    services.obs.observe(node, { page, setNear, setKeep });
    return () => services.obs.unobserve(node);
  }, [services, page]);

  // Far away: give the canvas memory back (width = 0 frees the backing store at once).
  useEffect(() => {
    if (!hasCanvas) return;
    const c = canvas.current;
    return () => {
      if (c) {
        c.width = 0;
        c.height = 0;
      }
      drawn.current = null;
      setReady(false);
    };
  }, [hasCanvas]);

  // Near: once the list is still, make sure the canvas shows this revision sharply enough. The
  // first wait also lets the viewer ask for its own pages first (on open, and after an edit). A
  // page that moved has a new revision too: it is drawn again at its new index.
  useEffect(() => {
    if (!near) return;
    let cancelled = false;
    let timer = 0;
    const ask = () => {
      const wait = services.quietIn();
      const width = box.current?.clientWidth ?? 0;
      if (wait > 0 || width === 0) {
        timer = window.setTimeout(ask, wait > 0 ? wait : QUIET_MS);
        return;
      }
      const scale = thumbScale(page, width, ratio);
      const shown = drawn.current;
      if (shown && shown.rev === rev && shown.scale * SHARPER >= scale) return;
      void services.queue.request(page.index, scale, () => !cancelled).then((result) => {
        if (!result) return;
        const c = canvas.current;
        if (cancelled || !c) {
          result.bitmap.close();
          return;
        }
        c.width = result.width;
        c.height = result.height;
        c.getContext("2d")?.drawImage(result.bitmap, 0, 0);
        result.bitmap.close();
        drawn.current = { scale, rev, ar: page.width / page.height };
        dropTurn(page.key);
        setReady(true);
      });
    };
    timer = window.setTimeout(ask, QUIET_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [near, rev, ratio, sizeKey, page, services]);

  // Until the new bitmap comes, the old one: turned, after a turn of the page (so it shows at
  // once); hidden, when the page changed shape any other way (an undo of a turn, say); as it is
  // otherwise (an edit of its content).
  const ar = page.width / page.height;
  const shown = drawn.current;
  let canvasStyle: Record<string, string> | undefined;
  let visible = ready;
  if (ready && shown && shown.rev !== rev) {
    if (turn && turn.rev === rev && turn.deg % 180 !== 0) {
      canvasStyle = {
        inset: "auto",
        left: "50%",
        top: "50%",
        width: `${100 / ar}%`,
        height: `${100 * ar}%`,
        transform: `translate(-50%, -50%) rotate(${turn.deg}deg)`,
      };
    } else if (turn && turn.rev === rev) {
      canvasStyle = { transform: `rotate(${turn.deg}deg)` };
    } else if (Math.abs(shown.ar - ar) > 0.01) {
      visible = false;
    }
  }

  const number = index + 1;
  const label = edited ? t("pages.thumbEdited", { page: number }) : t("viewer.page", { page: number });
  const cls = ["thumb", selected && "is-selected", dragging && "is-dragged", checkboxes && "has-check"]
    .filter(Boolean).join(" ");
  return (
    <div
      ref={el}
      role="option"
      class={cls}
      aria-label={label}
      title={label}
      aria-selected={selected}
      aria-current={current ? "page" : undefined}
      tabIndex={tabbable ? 0 : -1}
      data-key={page.key}
    >
      <span class="thumb-slot">
        <span
          ref={box}
          class={visible ? "thumb-page is-ready" : "thumb-page"}
          style={{ "--ar": String(ar) }}
        >
          {hasCanvas && <canvas ref={canvas} class="thumb-canvas" style={canvasStyle} aria-hidden="true" />}
          {edited && <span class="thumb-flag" title={t("pages.edited")} aria-hidden="true" />}
          {(checkboxes || selected) && (
            <span class="thumb-check" aria-hidden="true">{selected && <IconCheck />}</span>
          )}
        </span>
      </span>
      <span class="thumb-num" aria-hidden="true">{number}</span>
    </div>
  );
}

/**
 * The "+" between pages: where the mouse is over the list, else right before the thumbnail in the
 * Tab order (the next tab stop after the list; it shows when it has the focus). Its menu adds
 * pages at that place.
 */
function InsertPoint({ services, grid, onOpen }: {
  services: ThumbServices;
  grid: boolean;
  onOpen: (gap: number, anchor: HTMLElement) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const pages = services.doc.pages; // (reads doc.layout: placed again after a page operation)
  const place = services.menuPlace.value;
  const open = place ? gapOfPlace(pages, place) : null;
  const hover = services.hoverGap.value;
  // Within the pages there are now, whatever was held from before a page operation.
  const gap = clampGap(open ?? hover ?? services.rovingIndex.value, pages.length);
  const shown = open !== null || hover !== null;

  useLayoutEffect(() => {
    const button = ref.current;
    if (!button) return;
    const line = gapLine(services.slotsAround(gap), gap, grid);
    if (!line) return;
    const root = services.root;
    const maxX = (root?.clientWidth ?? 0) - PLUS - 2;
    // The list: at the left end of the line between the pages, in the margin beside them (clear of
    // their numbers, the edited mark and the check badge); the grid: on the column between them, a
    // little above the middle.
    const x = grid ? line.x - PLUS / 2 : 2;
    const y = grid ? line.y - PLUS : line.y - PLUS / 2;
    button.style.left = `${Math.max(2, Math.min(x, maxX))}px`;
    button.style.top = `${Math.max(2, y)}px`;
  });

  const label = insertLabel(gap);
  return (
    <button
      ref={ref}
      type="button"
      class={shown ? "thumbs-insert is-shown" : "thumbs-insert"}
      aria-label={label}
      title={label}
      aria-haspopup="menu"
      aria-expanded={open !== null}
      onClick={(e) => onOpen(gap, e.currentTarget)}
    >
      <IconPlus />
    </button>
  );
}

/** A press on a thumbnail that may become a drag. */
interface Press {
  pointer: number;
  /** Touch or pen: a long press starts the drag. */
  touch: boolean;
  x: number;
  y: number;
  page: PageModel;
  /** Touch: held long enough (the drag may start, or the release selects). */
  armed: boolean;
  dragging: boolean;
  timer: number;
  /**
   * The pages that move, the thumbnails' boxes (null: to measure again, the pages changed during
   * the drag) and the place they would go (null: where they are).
   */
  pages: PageModel[];
  slots: Slot[] | null;
  gap: number | null;
  lastX: number;
  lastY: number;
  frame: number;
}

export function PageThumbnails({ doc, variant, onPick }: PageThumbnailsProps) {
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const markerRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  // One set per document (the parents also remount per document, keyed on its id).
  const services = useMemo(() => new ThumbServices(doc), [doc]);
  const pagesRev = doc.layout.value; // re-rendered by every page operation
  const pages = doc.pages;
  const grid = variant === "grid";
  const selecting = grid && selectMode.value;
  const stopped = editingStopped.value;
  const ratio = slotRatio(pages);
  const hintId = useId();
  const [sizeKey, setSizeKey] = useState(0);
  /**
   * The "+" menu, opened from the "+" between pages ("point") or the one at the end, and its place,
   * held by its page: a page operation landing while it is open moves the place with its page.
   */
  const [menu, setMenu] = useState<{ place: GapPlace; anchor: HTMLElement; from: "point" | "end" } | null>(null);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const press = useRef<Press | null>(null);
  /** A click to ignore: the one that ends a drag or a long press. */
  const swallowUntil = useRef(0);

  useLayoutEffect(() => {
    const el = ref.current!;
    const list = listRef.current!;
    services.connect(el, list);

    let frame = 0;
    // Open on the current page, centred: now if the list is laid out (desktop panel), else on the
    // next frame (the phone sheet's <dialog> opens just after this runs, and is closed until then).
    const openOnCurrent = () => services.reveal(currentPage.peek(), true);
    if (el.clientHeight > 0) openOnCurrent();
    else frame = requestAnimationFrame(() => {
      frame = 0;
      openOnCurrent();
    });

    // Then follow the viewer, once per frame at most, unless the user is browsing the list.
    let primed = false;
    const stopFollowing = currentPage.subscribe(() => {
      // The tab stop follows the viewer too, but never away from a thumbnail that has the focus:
      // Tab and Shift+Tab leave the list in one press only from the tab stop itself.
      if (!list.contains(document.activeElement)) services.roving.value = null;
      if (!primed) {
        primed = true; // subscribe() calls back at once: that is the opening reveal above
        return;
      }
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!services.userScrolledRecently()) services.reveal(currentPage.peek(), false);
      });
    });

    const onScroll = () => services.onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });

    // A different width (a grid column, the screen's pixel density): re-check the scales. Not on
    // the first measurement: thumbnails measure their own box when they ask for a bitmap.
    let width = el.clientWidth;
    const resize = new ResizeObserver(() => {
      const w = el.clientWidth;
      if (w === 0 || (width > 0 && Math.abs(w - width) < 8)) return;
      const first = width === 0;
      width = w;
      if (!first) setSizeKey((k) => k + 1);
    });
    resize.observe(el);

    // A touch held for a drag must not scroll the list: only a listener that is not passive can
    // stop that, once the press has become a drag (before, the swipe scrolls as usual).
    const onTouchMove = (e: TouchEvent) => {
      const p = press.current;
      if (p && (p.armed || p.dragging) && e.cancelable) e.preventDefault();
    };
    list.addEventListener("touchmove", onTouchMove, { passive: false });

    // A press anywhere else: the focus is going elsewhere on purpose.
    const onDocDown = (e: PointerEvent) => {
      if (!list.contains(e.target as Node)) services.focusInList = false;
    };
    document.addEventListener("pointerdown", onDocDown, true);

    // A PDF dragged in from outside and dropped between the thumbnails adds its pages there.
    let fileSlots: Slot[] | null = null;
    const stopZone = registerPdfDropZone({
      element: el,
      accepts: () => !editingStopped.peek(),
      hover: (point) => {
        if (!point) {
          fileSlots = null;
          el.classList.remove("is-file-over");
          showMarker(null, []);
          return;
        }
        el.classList.add("is-file-over");
        fileSlots ??= services.slots();
        const r = el.getBoundingClientRect();
        if (point.y < r.top + SCROLL_EDGE) services.scrollBy(-SCROLL_STEP);
        else if (point.y > r.bottom - SCROLL_EDGE) services.scrollBy(SCROLL_STEP);
        const [x, y] = services.toContent(point.x, point.y);
        showMarker(dropGap(fileSlots, x, y, grid), fileSlots);
      },
      drop: (file, point) => {
        const slots = fileSlots ?? services.slots();
        const [x, y] = services.toContent(point.x, point.y);
        openInsertFromPdf(dropGap(slots, x, y, grid), file);
      },
    });

    // The pages changed (a page operation, its undo or redo landed): every place and box held from
    // before names the pages as they were. The mouse's place is forgotten (its next move sets it
    // again), the boxes of a file dragged in are measured again, and a drag goes on with its boxes
    // measured again and no place until the pointer moves (let go before that, nothing moves).
    // Right as the pages change, before anything is drawn with them.
    let layoutSeen = doc.layout.peek();
    const stopLayout = doc.layout.subscribe((layout) => {
      if (layout === layoutSeen) return;
      layoutSeen = layout;
      services.hoverGap.value = null;
      fileSlots = null;
      const p = press.current;
      if (p?.dragging) {
        p.slots = null;
        p.gap = null;
        showMarker(null, []);
      }
    });

    return () => {
      stopFollowing();
      stopLayout();
      if (frame) cancelAnimationFrame(frame);
      el.removeEventListener("scroll", onScroll);
      resize.disconnect();
      list.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("pointerdown", onDocDown, true);
      stopZone();
      endPress();
      services.dispose();
    };
  }, [services]);

  // After a page operation, the focus stays on its page: a thumbnail moved in the list may lose
  // it (moving an element blurs it), and a deleted one takes it away (then the page that took its
  // place gets it). Not when the focus went somewhere else.
  useLayoutEffect(() => {
    const list = listRef.current;
    const i = doc.pages.findIndex((p) => p.key === services.focusKey);
    const at = i >= 0 ? i : Math.min(services.focusIndex, doc.pages.length - 1);
    if (i >= 0) services.focusIndex = i; // where it is now: a delete next gives the focus to the page after it
    if (!list || !services.focusInList || at < 0) return;
    const active = document.activeElement;
    if (active && active !== document.body && active !== document.documentElement) return;
    services.focus(at);
  }, [pagesRev]);

  // ------------------------------------------------------------------------------------------
  // Choosing pages

  const keys = () => doc.pages.map((p) => p.key);

  const select = (index: number, how: SelectHow) => {
    selection.value = selectAt(keys(), selection.peek(), index, how);
  };

  /** Show page `index` in the viewer (and leave the sheet, on the phone). */
  const show = (index: number) => {
    goToPage(index);
    onPickRef.current?.(index);
  };

  /** A click, a tap or Enter on thumbnail `index`: "plain", or with Ctrl/Cmd ("toggle") or Shift ("range"). */
  const choose = (index: number, how: "plain" | "toggle" | "range") => {
    if (grid) {
      if (selectMode.peek() || how !== "plain") {
        selectMode.value = true;
        select(index, how === "range" ? "range" : "toggle");
      } else {
        show(index);
      }
      return;
    }
    if (how === "plain") {
      select(index, "only");
      show(index);
    } else {
      select(index, how);
    }
  };

  /** The index of the thumbnail of this list that `target` is in, or -1. */
  const optionIndex = (target: EventTarget | null): number => {
    const list = listRef.current;
    const item = target instanceof Element ? target.closest<HTMLElement>('[role="option"]') : null;
    if (!list || !item || item.parentElement !== list) return -1;
    const key = Number(item.dataset.key);
    return doc.pages.findIndex((p) => p.key === key);
  };

  const onClick = (e: MouseEvent) => {
    if (performance.now() < swallowUntil.current) {
      swallowUntil.current = 0;
      return;
    }
    const i = optionIndex(e.target);
    if (i < 0) return;
    choose(i, e.ctrlKey || e.metaKey ? "toggle" : e.shiftKey ? "range" : "plain");
  };

  // Whatever focused a thumbnail (a click, the arrow keys, the sheet opening on the current page),
  // Tab comes back to it, and a page operation keeps it there.
  const onFocusIn = (e: FocusEvent) => {
    const i = optionIndex(e.target);
    if (i < 0) return;
    const page = doc.pages[i];
    services.roving.value = page.key;
    services.focusKey = page.key;
    services.focusIndex = i;
    services.focusInList = true;
  };

  const onFocusOut = (e: FocusEvent) => {
    const to = e.relatedTarget;
    if (to instanceof Node && !listRef.current?.contains(to)) services.focusInList = false;
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const list = listRef.current;
    const i = optionIndex(e.target);
    if (!list || i < 0) return;
    if (press.current?.dragging && e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      endPress();
      return;
    }
    const action = thumbKeyAction(e, grid);
    if (!action) return;
    const page = doc.pages[i];
    const last = doc.pages.length - 1;
    switch (action.kind) {
      case "focus": {
        e.preventDefault(); // the list does not scroll by itself: the focus moves
        const next = nextFocus(i, last, grid ? columnCount(list) : 1, action.move);
        if (action.extend) {
          if (selection.peek().anchor === null) select(i, "only");
          if (grid) selectMode.value = true;
          select(next, "range");
        }
        if (next !== i) services.focus(next);
        return;
      }
      case "toggle":
      case "range":
        e.preventDefault();
        choose(i, action.kind);
        return;
      case "pick":
        e.preventDefault();
        choose(i, "plain");
        return;
      case "all":
        e.preventDefault();
        selection.value = selectAll(keys());
        if (grid) selectMode.value = true;
        return;
      case "escape":
        if (grid && selectMode.peek()) {
          selectMode.value = false;
          clearSelection();
        } else if (!grid && selection.peek().keys.size) {
          clearSelection();
        } else {
          return; // the app's own Escape
        }
        e.preventDefault(); // (in the sheet: it stays open)
        e.stopPropagation();
        return;
      case "delete":
        if (stopped) return;
        e.preventDefault();
        void deletePages(pagesFor(doc, page));
        return;
      case "nudge":
        if (stopped) return;
        e.preventDefault();
        void nudgePages(pagesFor(doc, page), action.dir, page);
        return;
    }
  };

  // ------------------------------------------------------------------------------------------
  // Dragging

  /** The drop marker at place `gap` (null: hidden), on the boxes `slots`. */
  function showMarker(gap: number | null, slots: readonly Slot[]) {
    const marker = markerRef.current;
    if (!marker) return;
    const line = gap === null ? null : gapLine(slots, gap, grid);
    if (!line) {
      marker.hidden = true;
      return;
    }
    marker.hidden = false;
    marker.className = grid ? "thumbs-marker is-column" : "thumbs-marker";
    const s = marker.style;
    if (grid) {
      s.left = `${line.x - 1.5}px`;
      s.top = `${line.y - line.length / 2}px`;
      s.width = "";
      s.height = `${line.length}px`;
    } else {
      s.left = `${line.x - line.length / 2}px`;
      s.top = `${line.y - 1.5}px`;
      s.width = `${line.length}px`;
      s.height = "";
    }
  }

  /** Where the dragged pages would go for the pointer at (x, y) (client px); null: where they are. */
  function dragTo(p: Press, x: number, y: number) {
    p.lastX = x;
    p.lastY = y;
    const remeasure = p.slots === null; // the pages changed during the drag
    const slots = (p.slots ??= services.slots());
    const still = p.pages.filter((pg) => doc.pages[pg.index] === pg); // the dragged pages still there
    const [cx, cy] = services.toContent(x, y);
    const gap = dropGap(slots, cx, cy, grid);
    const at = still.map((pg) => pg.index);
    p.gap = !at.length || moveOrder(doc.pages.length, at, gap).every((o, k) => o === k) ? null : gap;
    showMarker(p.gap, slots);
    const ghost = ghostRef.current;
    if (ghost) {
      if (remeasure && still.length) ghost.textContent = dragText(still); // its page number may have changed
      ghost.style.left = `${x + 14}px`;
      ghost.style.top = `${y + 14}px`;
    }
  }

  /** Near the top or the bottom edge while dragging: the list scrolls, once a frame. */
  function autoScroll(p: Press) {
    p.frame = requestAnimationFrame(() => {
      if (press.current !== p || !p.dragging) return;
      const el = ref.current;
      if (el) {
        const r = el.getBoundingClientRect();
        const edge = Math.min(SCROLL_EDGE, r.height / 4);
        let dy = 0;
        if (p.lastY < r.top + edge) dy = -SCROLL_STEP * (1 - Math.max(0, p.lastY - r.top) / edge);
        else if (p.lastY > r.bottom - edge) dy = SCROLL_STEP * (1 - Math.max(0, r.bottom - p.lastY) / edge);
        if (dy) {
          services.scrollBy(Math.round(dy) || Math.sign(dy));
          dragTo(p, p.lastX, p.lastY);
        }
      }
      autoScroll(p);
    });
  }

  function startDrag(p: Press) {
    p.dragging = true;
    p.pages = pagesFor(doc, p.page);
    p.slots = services.slots();
    services.dragKeys.value = new Set(p.pages.map((pg) => pg.key));
    services.hoverGap.value = null;
    listRef.current?.querySelector(".is-pressed")?.classList.remove("is-pressed");
    try {
      listRef.current?.setPointerCapture(p.pointer);
    } catch {
      // (the pointer is gone already: its pointerup or pointercancel ends the drag)
    }
    const ghost = ghostRef.current;
    if (ghost) {
      ghost.textContent = dragText(p.pages);
      ghost.hidden = false;
    }
    dragTo(p, p.lastX, p.lastY);
    autoScroll(p);
  }

  /** The press is over (dropped, cancelled, unmounted): nothing of it stays on screen. */
  function endPress() {
    const p = press.current;
    if (!p) return;
    press.current = null;
    window.clearTimeout(p.timer);
    cancelAnimationFrame(p.frame);
    listRef.current?.querySelector(".is-pressed")?.classList.remove("is-pressed");
    if (p.dragging) {
      services.dragKeys.value = new Set();
      try {
        listRef.current?.releasePointerCapture(p.pointer);
      } catch {
        // (released already)
      }
    }
    showMarker(null, []);
    if (ghostRef.current) ghostRef.current.hidden = true;
  }

  const onPointerDown = (e: PointerEvent) => {
    if (!e.isPrimary || press.current) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const i = optionIndex(e.target);
    if (i < 0 || stopped) return;
    const touch = e.pointerType !== "mouse";
    const p: Press = {
      pointer: e.pointerId, touch, x: e.clientX, y: e.clientY, page: doc.pages[i], armed: !touch, dragging: false,
      timer: 0, pages: [], slots: [], gap: null, lastX: e.clientX, lastY: e.clientY, frame: 0,
    };
    if (touch) {
      const option = (e.target as Element).closest('[role="option"]');
      p.timer = window.setTimeout(() => {
        if (press.current !== p) return;
        p.armed = true;
        option?.classList.add("is-pressed");
      }, LONG_PRESS_MS);
    }
    press.current = p;
  };

  const onPointerMove = (e: PointerEvent) => {
    const p = press.current;
    if (!p) {
      // The mouse over the list: the "+" goes to the place between pages nearest to it.
      if (e.pointerType !== "mouse" || stopped || selecting || menu) return;
      const i = optionIndex(e.target);
      const item = i >= 0 ? services.item(i) : null;
      if (!item) return;
      const r = item.getBoundingClientRect();
      const after = grid ? e.clientX > r.left + r.width / 2 : e.clientY > r.top + r.height / 2;
      services.hoverGap.value = after ? i + 1 : i;
      return;
    }
    if (e.pointerId !== p.pointer) return;
    if (p.dragging) {
      dragTo(p, e.clientX, e.clientY);
      return;
    }
    const moved = Math.hypot(e.clientX - p.x, e.clientY - p.y);
    p.lastX = e.clientX;
    p.lastY = e.clientY;
    if (!p.armed) {
      if (moved > TOUCH_SLOP) endPress(); // a swipe: the list scrolls
      return;
    }
    if (moved > (p.touch ? 4 : MOUSE_SLOP)) startDrag(p);
  };

  const onPointerUp = (e: PointerEvent) => {
    const p = press.current;
    if (!p || e.pointerId !== p.pointer) return;
    const dropped = p.dragging ? { pages: p.pages, gap: p.gap } : null;
    const held = !p.dragging && p.touch && p.armed;
    endPress();
    if (dropped) {
      swallowUntil.current = performance.now() + CLICK_AFTER_MS;
      if (dropped.gap !== null) void movePagesBefore(dropped.pages, dropped.gap);
    } else if (held) {
      // A long press let go without moving: that page selected (on the phone, "Seleziona" on).
      swallowUntil.current = performance.now() + CLICK_AFTER_MS;
      const i = doc.pages.indexOf(p.page);
      if (i >= 0) {
        if (grid) selectMode.value = true;
        select(i, "toggle");
      }
    }
  };

  const onPointerCancel = (e: PointerEvent) => {
    if (press.current?.pointer === e.pointerId) endPress();
  };

  // A long press on a touch screen: no context menu or callout over the drag.
  const onContextMenu = (e: MouseEvent) => {
    if (press.current?.touch) e.preventDefault();
  };

  // ------------------------------------------------------------------------------------------
  // The "+" menu

  const openMenu = (gap: number, anchor: HTMLElement, from: "point" | "end") => {
    if (menu?.anchor === anchor) {
      closeMenu(false); // its own "+" again: it closes, as a menu button does
      return;
    }
    const place = placeOfGap(doc.pages, gap);
    if (from === "point") services.menuPlace.value = place; // the "+" stays there while its menu is open
    setMenu({ place, anchor, from });
  };

  const closeMenu = (refocus: boolean) => {
    const open = menu;
    services.menuPlace.value = null;
    setMenu(null);
    if (refocus) open?.anchor.focus();
  };

  const editable = !stopped;
  const end = pages.length;
  return (
    <div
      ref={ref}
      class={`thumbs thumbs-${variant}`}
      style={grid ? { "--slot-ratio": ratio.toFixed(4) } : undefined}
      onPointerLeave={(e) => {
        if (e.pointerType === "mouse" && !menu) services.hoverGap.value = null;
      }}
    >
      <div
        ref={listRef}
        role="listbox"
        aria-multiselectable="true"
        aria-label={t("pages.title")}
        aria-describedby={hintId}
        class="thumbs-options"
        onClick={onClick}
        onFocusIn={onFocusIn}
        onFocusOut={onFocusOut}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onContextMenu={onContextMenu}
      >
        {pages.map((page) => (
          <Thumb key={page.key} page={page} services={services} sizeKey={sizeKey} checkboxes={selecting} />
        ))}
      </div>
      <p id={hintId} class="sr-only">{grid ? t("org.hintGrid") : t("org.hintList")}</p>
      {editable && !selecting && (
        <InsertPoint services={services} grid={grid} onOpen={(gap, anchor) => openMenu(gap, anchor, "point")} />
      )}
      {editable && !selecting && (
        <button
          type="button"
          class="thumbs-add"
          aria-label={t("org.insertEnd")}
          title={t("org.insertEnd")}
          aria-haspopup="menu"
          aria-expanded={menu?.from === "end"}
          onClick={(e) => openMenu(end, e.currentTarget, "end")}
        >
          <IconPlus />
          <span aria-hidden="true">{t("org.add")}</span>
        </button>
      )}
      <div ref={markerRef} class="thumbs-marker" hidden aria-hidden="true" />
      <div ref={ghostRef} class="thumbs-ghost" hidden aria-hidden="true" />
      {menu && <InsertMenu gap={gapOfPlace(pages, menu.place)} anchor={menu.anchor} onClose={closeMenu} />}
    </div>
  );
}
