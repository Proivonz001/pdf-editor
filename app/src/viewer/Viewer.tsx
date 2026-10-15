// The document viewer: a scroller with the pages stacked vertically, laid out from their sizes
// in points × zoom. Only pages near the viewport are rendered (see PageView).
//
// Zoom keeps a point in place: every zoom change records an anchor (a point on a page, in
// points) and the viewport position it must stay at; after the new layout is committed the
// scroll position is set so the anchor lands there again.
import { useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { t } from "../i18n";
import { busy, currentPage, devicePixelRatio, editingStopped, editMode, engine, fitMode, zoom } from "../state";
import { isCoarse } from "../ui/media";
import { installZoomGestures, type Anchor } from "./gestures";
import { clampZoom, computeLayout, fitWidthZoom, pageIndexAt, type Layout } from "./layout";
import type { OpenDoc } from "./model";
import { PageView } from "./PageView";
import { RenderQueue } from "./renderQueue";
import { setZoomController } from "./zoom";
import { PageVisibility } from "./visibility";

type View = [number, number];

function PageIndicator({ count }: { count: number }) {
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
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; updateCurrentPage(); });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    const onWindowResize = () => { devicePixelRatio.value = window.devicePixelRatio || 1; };
    window.addEventListener("resize", onWindowResize);

    return () => {
      setZoomController(null);
      removeGestures();
      resize.disconnect();
      el.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onWindowResize);
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
    currentPage.value = pageIndexAt(layout, el.scrollTop + el.clientHeight / 2);
  }, [layout]);

  return (
    <div class="viewer">
      {editingStopped.value ? (
        <p class="edit-hint" role="note">{t("broken.note")}</p>
      ) : editMode.value && (
        <p class="edit-hint" role="note">{isCoarse.value ? t("edit.hintTouch") : t("edit.hint")}</p>
      )}
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
    </div>
  );
}

function scrollToAnchor(el: HTMLElement, L: Layout, a: Anchor, view: View) {
  if (a.page >= L.tops.length) return;
  el.scrollLeft = L.lefts[a.page] + a.pt[0] * L.zoom - view[0];
  el.scrollTop = L.tops[a.page] + a.pt[1] * L.zoom - view[1];
}
