// Page layout: pages stacked vertically and centred, sized from their bounds in points × zoom.
// The layout is computed here (not measured from the DOM), so zoom anchoring and the current
// page can be worked out exactly, before the browser has laid anything out.
import type { PageModel } from "./model";

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 4;
/** Steps used by the zoom buttons and Ctrl +/−. */
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];

export interface Layout {
  zoom: number;
  viewportWidth: number;
  /** Per page, in CSS px relative to the scroll content. */
  lefts: Float64Array;
  tops: Float64Array;
  widths: Float64Array;
  heights: Float64Array;
  contentWidth: number;
  contentHeight: number;
}

/** Margin around the pages and gap between them (smaller on phones). */
export function spacing(viewportWidth: number) {
  return viewportWidth < 640 ? { pad: 8, gap: 8 } : { pad: 24, gap: 16 };
}

export function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

/** Next zoom step up (dir = 1) or down (dir = -1) from `z`. */
export function stepZoom(z: number, dir: 1 | -1): number {
  if (dir > 0) return ZOOM_STEPS.find((s) => s > z * 1.001) ?? MAX_ZOOM;
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) if (ZOOM_STEPS[i] < z * 0.999) return ZOOM_STEPS[i];
  return MIN_ZOOM;
}

/** Zoom at which the widest page fills the viewport width. */
export function fitWidthZoom(pages: readonly PageModel[], viewportWidth: number): number {
  if (viewportWidth <= 0 || pages.length === 0) return 1;
  let maxW = 0;
  for (const p of pages) maxW = Math.max(maxW, p.width);
  const { pad } = spacing(viewportWidth);
  return clampZoom((viewportWidth - 2 * pad) / maxW);
}

export function computeLayout(pages: readonly PageModel[], zoom: number, viewportWidth: number): Layout {
  const n = pages.length;
  const { pad, gap } = spacing(viewportWidth);
  const widths = new Float64Array(n), heights = new Float64Array(n);
  const lefts = new Float64Array(n), tops = new Float64Array(n);
  let maxW = 0;
  for (let i = 0; i < n; i++) {
    widths[i] = pages[i].width * zoom;
    heights[i] = pages[i].height * zoom;
    maxW = Math.max(maxW, widths[i]);
  }
  const contentWidth = Math.max(viewportWidth, maxW + 2 * pad);
  let y = pad;
  for (let i = 0; i < n; i++) {
    tops[i] = y;
    lefts[i] = (contentWidth - widths[i]) / 2;
    y += heights[i] + gap;
  }
  const contentHeight = n ? y - gap + pad : 0;
  return { zoom, viewportWidth, lefts, tops, widths, heights, contentWidth, contentHeight };
}

/** Index of the page at content offset `y` (the last page that starts at or above it). */
export function pageIndexAt(layout: Layout, y: number): number {
  const { tops } = layout;
  let lo = 0, hi = tops.length - 1;
  if (hi < 0) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tops[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
