// The document viewer: a scroller with the pages stacked vertically, laid out from their sizes
// in points × zoom. Only pages near the viewport are rendered (see PageView). Above it, for a
// digitally signed PDF, a notice until it is dismissed, and in Modifica or Compila e firma the
// banner of that tool (its sub-tools on desktop, the hint, "Done": ui/EditBar.tsx, ui/fill/
// FillBar.tsx); over it, the page indicator and the busy bar. On phones in either tool, the strip
// of its sub-tools sits below it, right above the tab bar. When a document with a form opens, a
// toast says so, once.
//
// Zoom keeps a point in place: every zoom change records an anchor (a point on a page, in
// points) and the viewport position it must stay at; after the new layout is committed the
// scroll position is set so the anchor lands there again.
//
// Page operations (release 4) change the pages in place on the same document (doc.layout counts
// them): the pages are laid out again, each PageView follows its own page (keyed by PageModel.key,
// not by position), fit-width fits again when the widest page changed, and the page the operation
// is about (currentPage, set with the change: ui/pageActions.ts, state.ts) is brought into view.
//
// Cerca (release 5): on desktop its find bar is docked above the notice and the banner while the
// search is open (ui/search/SearchBar.tsx; on phones it takes the top bar's place instead), and the
// current result is brought into the middle of the view when it is not well in view already.
import type { RefObject } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { t } from "../i18n";
import {
  busy, currentPage, editingStopped, editMode, editTool, engine, fillMode, fitMode, pendingPlacement, selectedImage,
  signedNoticeDismissed, zoom,
} from "../state";
import { EditBanner, EditStrip } from "../ui/EditBar";
import { announceForm, FillBanner, FillStrip } from "../ui/fill/FillBar";
import { rescueFocus, viewerScroller } from "../ui/focus";
import { IconInfo } from "../ui/icons";
import { isNarrow, prefersReducedMotion } from "../ui/media";
import { FindBar } from "../ui/search/SearchBar";
import { searchOpen, setHitRevealer } from "../ui/search/state";
import { bottomBarsHidden } from "../ui/TabBar";
import { installZoomGestures, type Anchor } from "./gestures";
import { clampZoom, computeLayout, fitWidthZoom, pageIndexAt, spacing, type Layout } from "./layout";
import type { OpenDoc } from "./model";
import { PageView } from "./PageView";
import { RenderQueue } from "./renderQueue";
import { setZoomController } from "./zoom";
import { PageVisibility } from "./visibility";

type View = [number, number];

export type BannerKind = "edit" | "fill" | "stopped";

/**
 * The strip of sub-tools below the viewer, right above the tab bar: on phones in either tool (the
 * `banner` of that tool), hidden like the tab bar while a line editor or a writer is open or a
 * field takes typing (the keyboard needs the room).
 */
export function stripFor(banner: BannerKind | null): "edit" | "fill" | null {
  return (banner === "edit" || banner === "fill") && isNarrow.value && !bottomBarsHidden() ? banner : null;
}

/**
 * The bar above the pages: the bar of the tool that is on (EditBanner in Modifica, FillBanner in
 * Compila e firma); once editing has stopped for this file (see actions.ts), why, in the danger
 * colours and with no button.
 */
function ToolBanner({ kind, doc, elRef }: { kind: BannerKind; doc: OpenDoc; elRef: RefObject<HTMLDivElement> }) {
  if (kind === "stopped") {
    return (
      <div ref={elRef} class="edit-banner is-stopped">
        <IconInfo />
        <p class="edit-banner-text" role="note">{t("broken.note")}</p>
      </div>
    );
  }
  if (kind === "fill") return <FillBanner doc={doc} elRef={elRef} />;
  return <EditBanner doc={doc} elRef={elRef} />;
}

/**
 * A digitally signed PDF: every downloaded copy is written anew, edited or not, so its signature
 * is no longer valid there (a PDF/A copy has it removed). Said once per document, above the edit
 * banner, until "Got it".
 */
function SignedNotice({ docId, elRef }: { docId: number; elRef: RefObject<HTMLDivElement> }) {
  return (
    <div ref={elRef} class="signed-notice">
      <IconInfo />
      <p class="signed-notice-text" role="note">{t("signed.notice")}</p>
      <button
        type="button"
        class="btn btn-secondary signed-notice-ok"
        onClick={() => {
          signedNoticeDismissed.value = docId;
          rescueFocus(viewerScroller); // the button goes with the notice
        }}
      >
        {t("signed.dismiss")}
      </button>
    </div>
  );
}

/**
 * "2 / 9" at the bottom centre. Not while a line editor or a text writer is open, a form field
 * takes typing (the keyboard is up; a ticked box keeps the pill: bottomBarsHidden) or an image is
 * selected: the pill could cover the field or the context bar. It reads those signals itself, so
 * opening a line, selecting an image or focusing a field re-renders only the pill.
 */
function PageIndicator({ count }: { count: number }) {
  if (bottomBarsHidden() || selectedImage.value) return null;
  const page = Math.min(currentPage.value, count - 1) + 1;
  return (
    <div class="page-indicator">
      <span class="sr-only">{t("viewer.indicatorLabel", { page, count })}</span>
      <span aria-hidden="true">{t("viewer.indicator", { page, count })}</span>
    </div>
  );
}

/**
 * The current page at the scroll position of `el` (the indicator's "N", what "Elimina pagina N"
 * and the pages panel's bar act on): the page in the middle of the view, except within half a
 * view of either end of the scroll, where the point slides to the view's top edge (scrolled to the
 * start) or its bottom edge (scrolled to the end). So the first and the last page are current at
 * either end even when they are too short to reach the middle (landscape pages on a phone, a
 * document zoomed out), every page is current somewhere on the way, and in a long document the
 * page named is the one in the middle of what shows. A scroll shorter than the view slides the
 * point over the whole view; a view that does not scroll counts as scrolled to the start (the
 * other pages become current through `picked`: a thumbnail, a search hit, a page operation).
 */
export function currentPageAt(layout: Layout, el: Pick<HTMLElement, "scrollTop" | "clientHeight" | "scrollHeight">): number {
  const max = el.scrollHeight - el.clientHeight, h = el.clientHeight, t = el.scrollTop;
  let at = h / 2;
  if (max <= 0) at = 0;
  else if (max <= h) at = h * (t / max);
  else if (t < h / 2) at = t;
  else if (max - t < h / 2) at = h - (max - t);
  return pageIndexAt(layout, t + at);
}

export function Viewer({ doc }: { doc: OpenDoc }) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [services, setServices] = useState<{ vis: PageVisibility; queue: RenderQueue } | null>(null);
  const z = zoom.value;
  /** Bumped by every page operation: the pages changed in place. */
  const pagesRev = doc.layout.value;

  const layout = useMemo(() => computeLayout(doc.pages, z, viewportWidth), [doc, z, viewportWidth, pagesRev]);
  // The layout that is (or is about to be) on screen, for the event handlers below.
  const layoutRef = useRef<Layout>(layout);
  layoutRef.current = layout;
  const pending = useRef<{ anchor: Anchor; view: View } | null>(null);
  /**
   * The page picked with goToPage (a thumbnail): it counts as the current page while the viewer
   * scrolls there and as long as it stays there, even when the scroll position names another
   * page (currentPageAt: low zoom, or the last pages, which cannot scroll to the top).
   */
  const picked = useRef<{ index: number; top: number; until: number } | null>(null);
  /** The page operation seen last (doc.layout), and the page it is about while it waits to be shown. */
  const shownPages = useRef(pagesRev);
  const showing = useRef<number | null>(null);
  const banner: BannerKind | null = editingStopped.value
    ? "stopped"
    : editMode.value ? "edit" : fillMode.value ? "fill" : null;
  const bannerRef = useRef<HTMLDivElement>(null);
  /**
   * The banner can change height without going: Fill mode's when a signature waits to be placed
   * (its hint, its Cancel), Modifica's with the sub-tool (its hint, "Put it in the middle"). That
   * counts as a new banner for the scroll compensation below.
   */
  const bannerShape = banner === "fill" && pendingPlacement.value
    ? "fill-pending"
    : banner === "edit" ? `edit-${editTool.value}` : banner;
  const strip = stripFor(banner);
  const signedNotice = doc.info.signatures > 0 && signedNoticeDismissed.value !== doc.id;
  const noticeRef = useRef<HTMLDivElement>(null);
  /** Cerca's find bar, above them all (desktop only: on phones the search is in the top bar). */
  const findBar = searchOpen.value && !isNarrow.value;
  const findRef = useRef<HTMLDivElement>(null);
  /**
   * Height of the bars above the scroller (find bar, signed notice and edit banner; 0 when there
   * are none); null before the first layout.
   */
  const bannerHeight = useRef<number | null>(null);
  /**
   * The scroll position as of the last scroll event. When the banner goes, the scroller grows and
   * the browser has already pulled scrollTop into the smaller range by the time the effect below
   * runs; this is the position from before that.
   */
  const lastScrollTop = useRef(0);

  // Set up once per document: observers, render queue, gestures, zoom commands, resize, scroll.
  useLayoutEffect(() => {
    const el = scrollerRef.current!;

    const anchorAt = (view: View): Anchor => {
      const L = layoutRef.current;
      const x = el.scrollLeft + view[0], y = el.scrollTop + view[1];
      const i = pageIndexAt(L, y);
      return { page: i, pt: [(x - L.lefts[i]) / L.zoom, (y - L.tops[i]) / L.zoom] };
    };
    const applyZoom = (target: number, anchor: Anchor, view: View) => {
      const next = clampZoom(target);
      if (Math.abs(next - zoom.peek()) < 1e-4) {
        scrollToAnchor(el, layoutRef.current, anchor, view); // same zoom: just follow the fingers
        return;
      }
      pending.current = { anchor, view };
      zoom.value = next;
    };
    const zoomAround = (target: number, anchor: Anchor, view: View) => {
      fitMode.value = false;
      applyZoom(target, anchor, view);
    };
    const updateCurrentPage = () => {
      const p = picked.current;
      if (p) {
        const there = Math.abs(el.scrollTop - p.top) < 2;
        if (there) p.until = 0; // arrived: from now on, any other position ends it
        if (there || performance.now() < p.until) {
          currentPage.value = p.index;
          return;
        }
        picked.current = null;
      }
      currentPage.value = currentPageAt(layoutRef.current, el);
    };

    const vis = new PageVisibility(el);
    const queue = new RenderQueue(engine(), (i) => Math.abs(i - currentPage.peek()));
    const width = el.clientWidth;
    setViewportWidth(width);
    if (fitMode.peek()) zoom.value = fitWidthZoom(doc.pages, width);
    setServices({ vis, queue });

    setZoomController({
      zoomTo: (target, view) => {
        const v: View = view ?? [el.clientWidth / 2, el.clientHeight / 2];
        zoomAround(target, anchorAt(v), v);
      },
      fitWidth: () => {
        const v: View = [el.clientWidth / 2, 0];
        fitMode.value = true;
        applyZoom(fitWidthZoom(doc.pages, el.clientWidth), anchorAt(v), v);
      },
      goToPage: (index) => {
        const L = layoutRef.current;
        if (index < 0 || index >= L.tops.length) return;
        const top = Math.max(0, Math.min(L.tops[index] - spacing(L.viewportWidth).gap, el.scrollHeight - el.clientHeight));
        // Smooth only for short hops: a long smooth scroll would ask for every page on the way.
        const near = Math.abs(index - currentPage.peek()) <= 3;
        const smooth = near && !prefersReducedMotion.peek();
        // A smooth scroll that the user interrupts never arrives: then the pick expires.
        picked.current = { index, top, until: performance.now() + (smooth ? 1500 : 300) };
        currentPage.value = index;
        el.scrollTo({ top, behavior: smooth ? "smooth" : "auto" });
      },
    });
    // Cerca's current result: left where it is when it is well in view (clear of the edges and of
    // the page indicator), else brought to the middle (sideways only when it is out of view
    // across), its page then counting as the current page, as a page picked from the thumbnails.
    setHitRevealer((hit) => {
      const L = layoutRef.current;
      const i = hit.pageIndex;
      const page = doc.pages[i];
      if (!page || i >= L.tops.length) return;
      const [bx, by] = page.bounds;
      const x0 = L.lefts[i] + (hit.rect[0] - bx) * L.zoom, x1 = L.lefts[i] + (hit.rect[2] - bx) * L.zoom;
      const y0 = L.tops[i] + (hit.rect[1] - by) * L.zoom, y1 = L.tops[i] + (hit.rect[3] - by) * L.zoom;
      const h = el.clientHeight, w = el.clientWidth;
      const margin = Math.min(64, h / 6);
      const inViewDown = y0 >= el.scrollTop + margin && y1 <= el.scrollTop + h - margin;
      const inViewAcross = x0 >= el.scrollLeft && x1 <= el.scrollLeft + w;
      if (inViewDown && inViewAcross) return;
      const clamp = (v: number, max: number) => Math.max(0, Math.min(v, max));
      const top = inViewDown ? el.scrollTop : clamp((y0 + y1) / 2 - h / 2, el.scrollHeight - h);
      const left = inViewAcross ? el.scrollLeft : clamp((x0 + x1) / 2 - w / 2, el.scrollWidth - w);
      const smooth = Math.abs(i - currentPage.peek()) <= 3 && !prefersReducedMotion.peek();
      picked.current = { index: i, top, until: performance.now() + (smooth ? 1500 : 300) };
      currentPage.value = i;
      el.scrollTo({ top, left, behavior: smooth ? "smooth" : "auto" });
    });
    const removeGestures = installZoomGestures({ scroller: el, anchorAt, zoomAround });

    // Width changes (window resize, rotation): re-centre, and re-fit in fit-width mode. Height
    // changes (e.g. the on-screen keyboard) need nothing.
    const resize = new ResizeObserver(() => {
      const w = el.clientWidth;
      const old = layoutRef.current.viewportWidth;
      if (w === old || w === 0) return;
      if (old > 0) pending.current = { anchor: anchorAt([old / 2, 0]), view: [w / 2, 0] };
      setViewportWidth(w);
      if (fitMode.peek()) zoom.value = fitWidthZoom(doc.pages, w);
    });
    resize.observe(el);

    let frame = 0;
    const onScroll = () => {
      lastScrollTop.current = el.scrollTop;
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; updateCurrentPage(); });
    };
    el.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      setZoomController(null);
      setHitRevealer(null);
      removeGestures();
      resize.disconnect();
      el.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
      vis.disconnect();
      queue.dispose();
    };
  }, [doc]);

  // After a page operation (before the layout effect below, which then shows its page): the page
  // it is about is the current page, set with it; in fit-width mode the zoom fits the widest page
  // again (a page turned or added may be wider), and the page is shown at that zoom. An anchor
  // from a zoom still on its way names the pages as they were: dropped.
  useLayoutEffect(() => {
    if (shownPages.current === pagesRev) return;
    shownPages.current = pagesRev;
    const el = scrollerRef.current;
    if (!el) return;
    pending.current = null;
    showing.current = currentPage.peek();
    if (!fitMode.peek()) return;
    const fit = fitWidthZoom(doc.pages, el.clientWidth);
    if (Math.abs(fit - zoom.peek()) > 1e-4) zoom.value = fit;
  }, [pagesRev]);

  // After a zoom or resize: put the anchor back where it was, then update the page indicator.
  // After a page operation: bring its page into view (unless it is in view whole already) and
  // keep it the current page, as a page picked from the thumbnails is.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const show = showing.current;
    if (show !== null && layout.tops.length > 0) {
      if (Math.abs(layout.zoom - zoom.peek()) > 1e-4) return; // fitting again: shown at the new zoom
      showing.current = null;
      pending.current = null;
      const i = Math.min(Math.max(0, show), layout.tops.length - 1);
      const top = layout.tops[i], bottom = top + layout.heights[i];
      if (top < el.scrollTop || bottom > el.scrollTop + el.clientHeight) {
        el.scrollTop = Math.max(0, Math.min(top - spacing(layout.viewportWidth).gap, el.scrollHeight - el.clientHeight));
      }
      picked.current = { index: i, top: el.scrollTop, until: performance.now() + 300 };
      currentPage.value = i;
      return;
    }
    const p = pending.current;
    if (p) {
      pending.current = null;
      scrollToAnchor(el, layout, p.anchor, p.view);
    }
    picked.current = null; // the page positions changed
    currentPage.value = currentPageAt(layout, el);
  }, [layout]);

  // The edit banner (and the signed notice, and the find bar) push the scroller down when they come
  // and let it up when they go: scroll by the same amount, so the document stays still on screen
  // (not on the first layout).
  useLayoutEffect(() => {
    const before = bannerHeight.current;
    const after = (bannerRef.current?.offsetHeight ?? 0) + (noticeRef.current?.offsetHeight ?? 0) +
      (findRef.current?.offsetHeight ?? 0);
    bannerHeight.current = after;
    const el = scrollerRef.current;
    if (!el || before === null || after === before) return;
    const from = lastScrollTop.current;
    el.scrollTop = from + after - before;
    // A page picked from the thumbnails that the viewer had reached stays the current page: the
    // document did not move on screen, so the pick moves with the scroll.
    const p = picked.current;
    if (p && Math.abs(from - p.top) < 2) p.top = el.scrollTop;
  }, [bannerShape, signedNotice, findBar]);

  // A form: said once when the document opens (its fields work without choosing a tool, D2), from
  // what the engine counted at open (no page's fields are read for it).
  useEffect(() => {
    announceForm(doc);
  }, [doc]);

  return (
    <div class="viewer">
      {findBar && <FindBar elRef={findRef} />}
      {signedNotice && <SignedNotice docId={doc.id} elRef={noticeRef} />}
      {banner && <ToolBanner kind={banner} doc={doc} elRef={bannerRef} />}
      <div class="viewer-body">
        <div ref={scrollerRef} class="scroller" tabIndex={0} role="region" aria-label={t("viewer.label")}>
          {services && (
            <div class="pages" style={{ width: `${layout.contentWidth}px`, height: `${layout.contentHeight}px` }}>
              {/* Keyed by page, not by position: after a page operation each component (its
                  bitmap, its layers' state) stays with its own page. */}
              {doc.pages.map((page, i) => (
                <PageView
                  key={page.key}
                  page={page}
                  left={layout.lefts[i]}
                  top={layout.tops[i]}
                  width={layout.widths[i]}
                  height={layout.heights[i]}
                  zoom={z}
                  queue={services.queue}
                  vis={services.vis}
                />
              ))}
            </div>
          )}
        </div>
        <PageIndicator count={doc.pages.length} />
        {busy.value && <div class="busy-bar" role="progressbar" aria-label={t("viewer.working")} />}
      </div>
      {strip === "fill" && <FillStrip />}
      {strip === "edit" && <EditStrip />}
    </div>
  );
}

function scrollToAnchor(el: HTMLElement, L: Layout, a: Anchor, view: View) {
  if (a.page >= L.tops.length) return;
  el.scrollLeft = L.lefts[a.page] + a.pt[0] * L.zoom - view[0];
  el.scrollTop = L.tops[a.page] + a.pt[1] * L.zoom - view[1];
}
