// The document viewer: a scroller with the pages stacked vertically, laid out from their sizes
// in points × zoom. Only pages near the viewport are rendered (see PageView). Above it, for a
// digitally signed PDF, a notice until it is dismissed, and in Edit or Fill mode the banner of
// that tool (what to do, and "Done"; in Fill mode also its sub-tools on desktop, ui/fill/
// FillBar.tsx); over it, the page indicator and the busy bar. On phones in Fill mode, the strip
// of sub-tools sits below it, right above the tab bar. When a document with a form opens, a
// toast says so, once.
//
// Zoom keeps a point in place: every zoom change records an anchor (a point on a page, in
// points) and the viewport position it must stay at; after the new layout is committed the
// scroll position is set so the anchor lands there again.
import type { RefObject } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { t } from "../i18n";
import {
  busy, currentPage, editingStopped, editMode, engine, fillMode, fitMode, pendingPlacement, selectedImage,
  signedNoticeDismissed, zoom,
} from "../state";
import { setEditMode } from "../ui/actions";
import { announceForm, FillBanner, FillStrip } from "../ui/fill/FillBar";
import { rescueFocus, viewerScroller } from "../ui/focus";
import { IconCheck, IconInfo } from "../ui/icons";
import { isCoarse, isNarrow, prefersReducedMotion } from "../ui/media";
import { bottomBarsHidden } from "../ui/TabBar";
import { installZoomGestures, type Anchor } from "./gestures";
import { clampZoom, computeLayout, fitWidthZoom, pageIndexAt, spacing, type Layout } from "./layout";
import type { OpenDoc } from "./model";
import { PageView } from "./PageView";
import { RenderQueue } from "./renderQueue";
import { setZoomController } from "./zoom";
import { PageVisibility } from "./visibility";

type View = [number, number];

type BannerKind = "edit" | "fill" | "stopped";

/**
 * The bar above the pages: in edit mode, how to edit and a "Done" button; in Fill mode the
 * tool's own bar (FillBanner); once editing has stopped for this file (see actions.ts), why, in
 * the danger colours and with no button.
 */
function EditBanner({ kind, doc, elRef }: { kind: BannerKind; doc: OpenDoc; elRef: RefObject<HTMLDivElement> }) {
  if (kind === "stopped") {
    return (
      <div ref={elRef} class="edit-banner is-stopped">
        <IconInfo />
        <p class="edit-banner-text" role="note">{t("broken.note")}</p>
      </div>
    );
  }
  if (kind === "fill") return <FillBanner doc={doc} elRef={elRef} />;
  return (
    <div ref={elRef} class="edit-banner">
      <span class="edit-banner-mark" aria-hidden="true" />
      <p class="edit-banner-text" role="note">{t(isCoarse.value ? "edit.hintTouch" : "edit.hint")}</p>
      <button
        type="button"
        class="btn btn-secondary edit-banner-done"
        title={t("edit.doneTip", { key: t("key.esc") })}
        onClick={() => void setEditMode(false)}
      >
        <IconCheck />
        <span>{t("edit.done")}</span>
      </button>
    </div>
  );
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

export function Viewer({ doc }: { doc: OpenDoc }) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [services, setServices] = useState<{ vis: PageVisibility; queue: RenderQueue } | null>(null);
  const z = zoom.value;

  const layout = useMemo(() => computeLayout(doc.pages, z, viewportWidth), [doc, z, viewportWidth]);
  // The layout that is (or is about to be) on screen, for the event handlers below.
  const layoutRef = useRef<Layout>(layout);
  layoutRef.current = layout;
  const pending = useRef<{ anchor: Anchor; view: View } | null>(null);
  /**
   * The page picked with goToPage (a thumbnail): it counts as the current page while the viewer
   * scrolls there and as long as it stays there, even when another page is at the centre of
   * the viewport (low zoom, or the last pages, which cannot scroll to the top).
   */
  const picked = useRef<{ index: number; top: number; until: number } | null>(null);
  const banner: BannerKind | null = editingStopped.value
    ? "stopped"
    : editMode.value ? "edit" : fillMode.value ? "fill" : null;
  const bannerRef = useRef<HTMLDivElement>(null);
  /**
   * Fill mode's banner changes height when a signature waits to be placed (its Cancel and "Put
   * it in the middle"): that counts as a new banner for the scroll compensation below.
   */
  const bannerShape = banner === "fill" && pendingPlacement.value ? "fill-pending" : banner;
  /**
   * Phones in Fill mode: the sub-tools in a strip above the tab bar, hidden like the tab bar while
   * a line editor or a writer is open or a field takes typing (the keyboard needs the room).
   */
  const strip = banner === "fill" && isNarrow.value && !bottomBarsHidden();
  const signedNotice = doc.info.signatures > 0 && signedNoticeDismissed.value !== doc.id;
  const noticeRef = useRef<HTMLDivElement>(null);
  /**
   * Height of the bars above the scroller (signed notice and edit banner; 0 when there are none);
   * null before the first layout.
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
      currentPage.value = pageIndexAt(layoutRef.current, el.scrollTop + el.clientHeight / 2);
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
      removeGestures();
      resize.disconnect();
      el.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
      vis.disconnect();
      queue.dispose();
    };
  }, [doc]);

  // After a zoom or resize: put the anchor back where it was, then update the page indicator.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const p = pending.current;
    if (p) {
      pending.current = null;
      scrollToAnchor(el, layout, p.anchor, p.view);
    }
    picked.current = null; // the page positions changed
    currentPage.value = pageIndexAt(layout, el.scrollTop + el.clientHeight / 2);
  }, [layout]);

  // The edit banner (and the signed notice) push the scroller down when they come and let it up
  // when they go: scroll by the same amount, so the document stays still on screen (not on the
  // first layout).
  useLayoutEffect(() => {
    const before = bannerHeight.current;
    const after = (bannerRef.current?.offsetHeight ?? 0) + (noticeRef.current?.offsetHeight ?? 0);
    bannerHeight.current = after;
    const el = scrollerRef.current;
    if (!el || before === null || after === before) return;
    const from = lastScrollTop.current;
    el.scrollTop = from + after - before;
    // A page picked from the thumbnails that the viewer had reached stays the current page: the
    // document did not move on screen, so the pick moves with the scroll.
    const p = picked.current;
    if (p && Math.abs(from - p.top) < 2) p.top = el.scrollTop;
  }, [bannerShape, signedNotice]);

  // A form: said once when the document opens (its fields work without choosing a tool, D2), from
  // what the engine counted at open (no page's fields are read for it).
  useEffect(() => {
    announceForm(doc);
  }, [doc]);

  return (
    <div class="viewer">
      {signedNotice && <SignedNotice docId={doc.id} elRef={noticeRef} />}
      {banner && <EditBanner kind={banner} doc={doc} elRef={bannerRef} />}
      <div class="viewer-body">
        <div ref={scrollerRef} class="scroller" tabIndex={0} role="region" aria-label={t("viewer.label")}>
          {services && (
            <div class="pages" style={{ width: `${layout.contentWidth}px`, height: `${layout.contentHeight}px` }}>
              {doc.pages.map((page, i) => (
                <PageView
                  key={i}
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
      {strip && <FillStrip />}
    </div>
  );
}

function scrollToAnchor(el: HTMLElement, L: Layout, a: Anchor, view: View) {
  if (a.page >= L.tops.length) return;
  el.scrollLeft = L.lefts[a.page] + a.pt[0] * L.zoom - view[0];
  el.scrollTop = L.tops[a.page] + a.pt[1] * L.zoom - view[1];
}
