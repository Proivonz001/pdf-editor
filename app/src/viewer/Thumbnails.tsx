// Page thumbnails, shared by the desktop pages panel ("list": one column) and the phone pages
// sheet ("grid": as many columns as fit). Picking one moves the viewer to that page.
//
// The component is its own scroller and the root of its IntersectionObservers: only thumbnails
// within about a screen of the visible part get a bitmap, and canvases further than about four
// screens are released, so a 200-page document stays light. Bitmaps come through a render queue
// of its own (one request at a time: the thumbnails on screen first, then by distance from the
// current page), never the viewer's, and every request waits until the list has been still for
// ~150 ms after mounting, scrolling or a page change, so the thumbnails never hold up the main
// viewer. The scale follows the thumbnail's CSS width × devicePixelRatio, within a pixel budget.
//
// The current page's thumbnail is kept in view while the viewer moves, unless the user scrolled
// the thumbnails in the last second. The list is a single tab stop (a roving tabindex), so a long
// document does not put hundreds of stops between the tools and the page: Tab reaches the
// thumbnail focused last, or the current page's once the viewer has moved while the focus was
// elsewhere. The arrow keys (all four in the grid), Home and End move the focus between them.
import { signal, useComputed } from "@preact/signals";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { t } from "../i18n";
import { currentPage, devicePixelRatio, editedPages, engine } from "../state";
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

interface ThumbTarget {
  index: number;
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
  /** Indices of the thumbnails on screen. */
  readonly seen = new Set<number>();

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
        if (on) this.seen.add(x.index);
        else this.seen.delete(x.index);
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
    if (target) this.seen.delete(target.index);
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

/** What the thumbnails of one mounted list share: observers, render queue and scroll state. */
class ThumbServices {
  readonly obs = new ThumbObserver();
  readonly queue = new RenderQueue(
    engine(),
    (i) => (this.obs.seen.has(i) ? 0 : OFFSCREEN) + Math.abs(i - currentPage.peek()),
    1,
  );
  /** Index of the one thumbnail in the Tab order (tabindex 0; all the others have -1). */
  readonly roving = signal(currentPage.peek());
  /** When the list last scrolled (or was created): requests wait for QUIET_MS after it. */
  lastScroll = performance.now();
  /** When the user last scrolled the list (wheel, touch, scrollbar, keyboard). */
  private userScrollAt = -Infinity;
  /** scrollTop right after our own last scroll, to tell it apart from the user's. */
  private autoTop = 0;
  private root: HTMLElement | null = null;

  connect(root: HTMLElement) {
    this.root = root;
    this.autoTop = root.scrollTop;
    this.obs.connect(root);
  }

  dispose() {
    this.root = null;
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

  item(index: number): HTMLElement | null {
    const node = this.root?.children[index];
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
  onPick: (index: number) => void;
}

function Thumb({ page, services, sizeKey, onPick }: ThumbProps) {
  const index = page.index;
  const el = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLSpanElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  /** What the canvas currently shows. */
  const drawn = useRef<{ scale: number; rev: number } | null>(null);
  const [near, setNear] = useState(false);
  const [keep, setKeep] = useState(false);
  const [ready, setReady] = useState(false);
  // Computed per thumbnail: a page change (or a move of the tab stop) re-renders the two
  // thumbnails concerned, not all.
  const current = useComputed(() => currentPage.value === index).value;
  const tabbable = useComputed(() => services.roving.value === index).value;
  const edited = useComputed(() => editedPages.value.has(index)).value;
  const rev = page.rev.value;
  const ratio = devicePixelRatio.value;
  const hasCanvas = keep || near;

  useLayoutEffect(() => {
    const node = el.current!;
    services.obs.observe(node, { index, setNear, setKeep });
    return () => services.obs.unobserve(node);
  }, [services, index]);

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
  // first wait also lets the viewer ask for its own pages first (on open, and after an edit).
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
      void services.queue.request(index, scale, () => !cancelled).then((result) => {
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
        drawn.current = { scale, rev };
        setReady(true);
      });
    };
    timer = window.setTimeout(ask, QUIET_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [near, rev, ratio, sizeKey, page, services]);

  const number = index + 1;
  const label = edited ? t("pages.thumbEdited", { page: number }) : t("viewer.page", { page: number });
  return (
    <button
      ref={el}
      type="button"
      class="thumb"
      aria-label={label}
      title={label}
      aria-current={current ? "page" : undefined}
      tabIndex={tabbable ? 0 : -1}
      data-index={index}
      onClick={() => onPick(index)}
    >
      <span class="thumb-slot">
        <span
          ref={box}
          class={ready ? "thumb-page is-ready" : "thumb-page"}
          style={{ "--ar": String(page.width / page.height) }}
        >
          {hasCanvas && <canvas ref={canvas} class="thumb-canvas" aria-hidden="true" />}
          {edited && <span class="thumb-flag" title={t("pages.edited")} aria-hidden="true" />}
        </span>
      </span>
      <span class="thumb-num" aria-hidden="true">{number}</span>
    </button>
  );
}

export function PageThumbnails({ doc, variant, onPick }: PageThumbnailsProps) {
  const ref = useRef<HTMLDivElement>(null);
  // One set per document (the parents also remount per document, keyed on its id).
  const services = useMemo(() => new ThumbServices(), [doc]);
  const ratio = useMemo(() => slotRatio(doc.pages), [doc]);
  const [sizeKey, setSizeKey] = useState(0);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const pick = useCallback((index: number) => {
    goToPage(index);
    onPickRef.current?.(index);
  }, []);

  useLayoutEffect(() => {
    const el = ref.current!;
    services.connect(el);

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
    const stopFollowing = currentPage.subscribe((page) => {
      // The tab stop follows the viewer too, but never away from a thumbnail that has the focus:
      // Tab and Shift+Tab leave the list in one press only from the tab stop itself.
      if (!el.contains(document.activeElement)) services.roving.value = page;
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

    return () => {
      stopFollowing();
      if (frame) cancelAnimationFrame(frame);
      el.removeEventListener("scroll", onScroll);
      resize.disconnect();
      services.dispose();
    };
  }, [services]);

  /** Index of the thumbnail of this list that `target` is in, or -1. */
  const thumbIndex = (target: EventTarget | null): number => {
    const list = ref.current;
    const item = target instanceof HTMLElement ? target.closest<HTMLElement>(".thumb") : null;
    return list && item?.parentElement === list ? Number(item.dataset.index) : -1;
  };

  // Whatever focused a thumbnail (a click, the arrow keys, the sheet opening on the current page),
  // Tab comes back to it.
  const onFocusIn = (e: FocusEvent) => {
    const i = thumbIndex(e.target);
    if (i >= 0) services.roving.value = i;
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const el = ref.current;
    const i = thumbIndex(e.target);
    if (!el || i < 0) return;
    const last = el.children.length - 1;
    const grid = variant === "grid";
    const cols = grid ? columnCount(el) : 1;
    let next: number;
    switch (e.key) {
      case "ArrowUp":
        next = i - cols;
        break;
      case "ArrowDown":
        next = i + cols;
        // Below is a shorter last row: go to its last thumbnail.
        if (next > last) next = Math.floor(i / cols) < Math.floor(last / cols) ? last : i;
        break;
      case "ArrowLeft":
        if (!grid) return;
        next = i - 1;
        break;
      case "ArrowRight":
        if (!grid) return;
        next = i + 1;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = last;
        break;
      default:
        return;
    }
    e.preventDefault(); // the list does not scroll by itself: the focus moves
    if (next >= 0 && next <= last && next !== i) services.focus(next);
  };

  return (
    <div
      ref={ref}
      class={`thumbs thumbs-${variant}`}
      style={variant === "grid" ? { "--slot-ratio": ratio.toFixed(4) } : undefined}
      onFocusIn={onFocusIn}
      onKeyDown={onKeyDown}
    >
      {doc.pages.map((page) => (
        <Thumb key={`${doc.id}:${page.index}`} page={page} services={services} sizeKey={sizeKey} onPick={pick} />
      ))}
    </div>
  );
}
