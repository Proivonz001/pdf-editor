// Zoom gestures on the scroller: Ctrl/Cmd + wheel (also what desktop trackpad pinch sends in
// Chromium and Firefox), Safari's trackpad gesture events, and two-finger pinch on touch screens.
//
// Touch: the scroller has `touch-action: pan-x pan-y`, so one finger scrolls natively and the
// browser never zooms the page; two fingers are tracked with pointer events and zoom the
// document, keeping the point under the fingers stable (and following them as they move).
//
// Except while the browser's own zoom is on (a pinch on a sheet or a dialog zoomed the whole
// page, which can push the top bar and the tab bar out of view): then pinches on the scroller
// are left to the browser, so the user can zoom the page back out, and the scroller gets the
// class "is-page-zoomed" (viewer.css), which lets the browser zoom and pan the page from there.
// A changed touch-action applies from the next touch; so does the app's pinch, once the page is
// back at its normal scale.
import { zoom } from "../state";

/** A point on a page, in points from the page's top-left corner. */
export interface Anchor {
  page: number;
  pt: [number, number];
}

export interface GestureHost {
  scroller: HTMLElement;
  /** The page point currently shown at `view` (px from the scroller's top-left). */
  anchorAt(view: [number, number]): Anchor;
  /** Zoom to `z` and scroll so that `anchor` ends up at `view`. */
  zoomAround(z: number, anchor: Anchor, view: [number, number]): void;
}

// Safari's non-standard GestureEvent (trackpad pinch on macOS, also fired on iOS).
type GestureEvent = Event & { scale: number; clientX: number; clientY: number };

/** Ctrl + wheel sensitivity: one mouse-wheel notch (deltaY 100) ≈ 18 %. */
const WHEEL_ZOOM_SPEED = 0.002;

/** The browser has zoomed the whole page in (its scale at rest is 1; a little slack for rounding). */
const pageZoomed = () => (window.visualViewport?.scale ?? 1) > 1.01;

export function installZoomGestures(host: GestureHost): () => void {
  const el = host.scroller;
  const local = (x: number, y: number): [number, number] => {
    const r = el.getBoundingClientRect();
    return [x - r.left, y - r.top];
  };

  // --- Ctrl/Cmd + wheel ----------------------------------------------------------------------
  const onWheel = (e: WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault(); // no browser zoom
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1;
    const factor = Math.exp(-e.deltaY * unit * WHEEL_ZOOM_SPEED);
    const view = local(e.clientX, e.clientY);
    host.zoomAround(zoom.peek() * factor, host.anchorAt(view), view);
  };

  // --- Two-finger pinch (pointer events) -----------------------------------------------------
  const touches = new Map<number, { x: number; y: number }>();
  let pinch: { d0: number; z0: number; anchor: Anchor } | null = null;
  let frame = 0;

  const twoFingers = () => {
    const [a, b] = [...touches.values()];
    return { mid: local((a.x + b.x) / 2, (a.y + b.y) / 2), dist: Math.hypot(a.x - b.x, a.y - b.y) };
  };
  const startPinch = () => {
    const { mid, dist } = twoFingers();
    pinch = { d0: Math.max(dist, 1), z0: zoom.peek(), anchor: host.anchorAt(mid) };
  };
  const applyPinch = () => {
    frame = 0;
    if (!pinch || touches.size < 2) return;
    const { mid, dist } = twoFingers();
    host.zoomAround((pinch.z0 * dist) / pinch.d0, pinch.anchor, mid);
  };

  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType !== "touch") return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 2 && !pageZoomed()) startPinch();
  };
  const onPointerMove = (e: PointerEvent) => {
    const p = touches.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX;
    p.y = e.clientY;
    if (pinch && !frame) frame = requestAnimationFrame(applyPinch);
  };
  const onPointerEnd = (e: PointerEvent) => {
    if (!touches.delete(e.pointerId)) return;
    if (touches.size >= 2 && pinch) startPinch(); // a third finger lifted: continue with the other two
    else pinch = null;
  };

  // While two fingers are down, stop the browser from also panning (which would cancel the
  // pointers). Needs non-passive touch listeners; one-finger scrolling stays native.
  const onTouch = (e: TouchEvent) => {
    if (e.touches.length >= 2 && e.cancelable && !pageZoomed()) e.preventDefault();
  };

  // --- Safari trackpad pinch -----------------------------------------------------------------
  let gesture: { z0: number; anchor: Anchor; view: [number, number] } | null = null;
  /** The current gesture began while the page was zoomed: it is the browser's until it ends. */
  let browserGesture = false;
  const onGestureStart = (e: Event) => {
    browserGesture = pageZoomed();
    if (browserGesture) return;
    e.preventDefault();
    if (touches.size) return; // iOS: the pointer-based pinch handles it
    const g = e as GestureEvent;
    const view = local(g.clientX, g.clientY);
    gesture = { z0: zoom.peek(), anchor: host.anchorAt(view), view };
  };
  const onGestureChange = (e: Event) => {
    if (browserGesture) return;
    e.preventDefault();
    if (!gesture || touches.size) return;
    host.zoomAround(gesture.z0 * (e as GestureEvent).scale, gesture.anchor, gesture.view);
  };
  const onGestureEnd = (e: Event) => {
    if (!browserGesture) e.preventDefault();
    gesture = null;
    browserGesture = false;
  };

  // --- The browser's own zoom ----------------------------------------------------------------
  // Its scale changes fire "resize" on the visual viewport. The class is not part of the
  // scroller's class prop, so a re-render of the viewer leaves it in place.
  const viewport = window.visualViewport;
  const markPageZoom = () => {
    el.classList.toggle("is-page-zoomed", pageZoomed());
  };
  markPageZoom();

  const nonPassive = { passive: false } as const;
  el.addEventListener("wheel", onWheel, nonPassive);
  el.addEventListener("pointerdown", onPointerDown);
  el.addEventListener("pointermove", onPointerMove);
  el.addEventListener("pointerup", onPointerEnd);
  el.addEventListener("pointercancel", onPointerEnd);
  el.addEventListener("touchstart", onTouch, nonPassive);
  el.addEventListener("touchmove", onTouch, nonPassive);
  el.addEventListener("gesturestart", onGestureStart);
  el.addEventListener("gesturechange", onGestureChange);
  el.addEventListener("gestureend", onGestureEnd);
  viewport?.addEventListener("resize", markPageZoom);

  return () => {
    if (frame) cancelAnimationFrame(frame);
    el.removeEventListener("wheel", onWheel);
    el.removeEventListener("pointerdown", onPointerDown);
    el.removeEventListener("pointermove", onPointerMove);
    el.removeEventListener("pointerup", onPointerEnd);
    el.removeEventListener("pointercancel", onPointerEnd);
    el.removeEventListener("touchstart", onTouch);
    el.removeEventListener("touchmove", onTouch);
    el.removeEventListener("gesturestart", onGestureStart);
    el.removeEventListener("gesturechange", onGestureChange);
    el.removeEventListener("gestureend", onGestureEnd);
    viewport?.removeEventListener("resize", markPageZoom);
    el.classList.remove("is-page-zoomed");
  };
}
