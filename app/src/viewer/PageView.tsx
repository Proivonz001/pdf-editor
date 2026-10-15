// One page: a box sized from the page bounds × zoom, a canvas while the page is near the
// viewport, and the line overlay in edit mode.
//
// Rendering: at zoom × devicePixelRatio (capped in pixels on touch devices), through the shared
// render queue. On a zoom change the old bitmap stays, stretched by CSS, and the new one is
// asked for once the zoom has been still for ~150 ms. After an edit (page revision bump) the
// page is re-rendered at once.
import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../i18n";
import { devicePixelRatio, editingLine, editMode } from "../state";
import { LineLayer } from "./LineLayer";
import type { PageModel } from "./model";
import type { RenderQueue } from "./renderQueue";
import type { PageVisibility } from "./visibility";

const ZOOM_RENDER_DELAY = 150;
/** Pixel budget per page: phones and tablets run out of canvas memory quickly. */
const MAX_PIXELS = window.matchMedia("(pointer: coarse)").matches ? 8_000_000 : 16_000_000;
/**
 * Longest side of a canvas, in pixels (Chrome and Firefox refuse more). The engine rounds the
 * scaled page bounds outwards, which can add a pixel at each end: hence the 2 px margin.
 */
const MAX_SIDE = 32_767 - 2;

/** Pixels per point for rendering `page` at `zoom` on a screen with `ratio` device pixels per CSS px. */
export function renderScale(page: PageModel, zoom: number, ratio: number): number {
  const wanted = zoom * ratio;
  const area = page.width * page.height;
  // Very long or wide pages (a receipt roll, a banner) hit the side limit well before the area one.
  const scale = Math.min(wanted, Math.sqrt(MAX_PIXELS / area), MAX_SIDE / page.width, MAX_SIDE / page.height);
  // To 1/1000; down when capped, so the limits still hold (never 0: the engine refuses it).
  return Math.max(1, scale < wanted ? Math.floor(scale * 1000) : Math.round(scale * 1000)) / 1000;
}

export interface PageViewProps {
  page: PageModel;
  left: number;
  top: number;
  width: number;
  height: number;
  zoom: number;
  queue: RenderQueue;
  vis: PageVisibility;
}

export function PageView({ page, left, top, width, height, zoom, queue, vis }: PageViewProps) {
  const el = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  /** What the canvas currently shows. */
  const drawn = useRef<{ scale: number; rev: number } | null>(null);
  const [ready, setReady] = useState(false);

  const near = page.near.value;
  const keep = page.keep.value || near;
  const rev = page.rev.value;
  const ratio = devicePixelRatio.value;
  // Line overlay: near pages in edit mode, and the page whose line editor is open even if it
  // scrolled away (unmounting the editor would lose what was typed).
  const showLines = editMode.value && (near || editingLine.value?.pageIndex === page.index);

  useEffect(() => {
    const node = el.current!;
    vis.observe(node, page);
    return () => vis.unobserve(node);
  }, [vis, page]);

  // Far away: give the canvas memory back (width = 0 frees the backing store at once).
  useEffect(() => {
    if (!keep) return;
    const c = canvas.current;
    return () => {
      if (c) {
        c.width = 0;
        c.height = 0;
      }
      drawn.current = null;
      setReady(false);
    };
  }, [keep]);

  // Near: make sure the canvas shows this revision at the right scale.
  useEffect(() => {
    if (!near) return;
    const scale = renderScale(page, zoom, ratio);
    const current = drawn.current;
    if (current && current.rev === rev && current.scale === scale) return;
    let cancelled = false;
    // Same content at another zoom: keep the stretched bitmap a moment, the zoom may still move.
    const delay = current && current.rev === rev ? ZOOM_RENDER_DELAY : 0;
    const timer = setTimeout(() => {
      void queue.request(page.index, scale, () => !cancelled && page.near.peek()).then((result) => {
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
    }, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [near, zoom, rev, ratio, page, queue]);

  return (
    <div
      ref={el}
      class={ready ? "page is-ready" : "page"}
      style={{ left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` }}
      role="group"
      aria-label={t("viewer.page", { page: page.index + 1 })}
      data-page={page.index}
    >
      {keep && <canvas ref={canvas} class="page-canvas" aria-hidden="true" />}
      {showLines && <LineLayer page={page} zoom={zoom} />}
    </div>
  );
}
