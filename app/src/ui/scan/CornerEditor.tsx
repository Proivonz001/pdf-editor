// The scan flow's corner editor (ui/scan/ScanFlow.tsx): the photo, with the sheet's four corners
// as handles, the sides between them and what lies outside dimmed. Styled by styles/scan.css
// (.scan-area, .scan-frame, .scan-handle, .scan-loupe).
//
// - The photo fits the space the flow gives it, both ways (a ResizeObserver on that space), and
//   is drawn on a canvas at the size it shows (device pixels, at most MAX_DRAW_SIDE), never at
//   the working photo's full 3500 px.
// - A press near a corner (within GRAB_PX, more for a finger) takes it, by touch or mouse, and
//   it follows the pointer, kept at the offset it was taken at and inside the photo. Meanwhile a
//   magnifier shows the photo around that corner, LOUPE_ZOOM times larger, with the sides and a
//   cross on the corner, in the top corner of the photo away from it (the finger hides the rest).
// - Each corner is a real button (Tab reaches the four): the arrow keys move the focused one by a
//   quarter of a per cent of the photo's longer side, with Shift ten times that, and show the
//   magnifier until it loses the focus. Its name says where it is (per cent from the left and
//   from the top).
// The corners are in the photo's pixels (as analysePhoto returned it), in TL TR BR BL order.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { t } from "../../i18n";
import type { AnalysedPhoto } from "../../scan/scanClient";
import type { Corners, Point } from "../../scan/types";
import { devicePixelRatio } from "../../state";
import { withCorner } from "./flow";

const CORNER_NAMES = ["scan.cornerTopLeft", "scan.cornerTopRight", "scan.cornerBottomRight", "scan.cornerBottomLeft"] as const;
/** Longest side of the canvas that shows the photo, in device pixels. */
const MAX_DRAW_SIDE = 2048;
/** A press this close to a corner (CSS pixels) takes it: with a mouse, and with a finger or a pen. */
const GRAB_PX = { mouse: 28, touch: 44 };
/** The magnifier's side in CSS pixels, and how much it enlarges the photo as it shows. */
const LOUPE_PX = 112;
const LOUPE_ZOOM = 3;
/** The arrow keys move a corner by this share of the photo's longer side; with Shift, STEP_BIG. */
const STEP = 0.0025;
const STEP_BIG = 0.025;

/** A CSS custom property of `el` (a colour token), or `fallback` when there is none. */
function cssToken(el: Element | null, name: string, fallback: string): string {
  if (!el) return fallback;
  return getComputedStyle(el).getPropertyValue(name).trim() || fallback;
}

export function CornerEditor(p: {
  photo: AnalysedPhoto;
  corners: Corners;
  onCorners: (corners: Corners) => void;
  /** While the page is being made: nothing moves. */
  disabled: boolean;
  /** The id of the text that says how to move them. */
  describedBy: string;
}) {
  const W = p.photo.width, H = p.photo.height;
  const area = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const loupe = useRef<HTMLCanvasElement>(null);
  const handles = useRef<(HTMLButtonElement | null)[]>([]);
  /** The photo's size on screen, CSS pixels. */
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  /** The corner the magnifier shows (being dragged, or moved with the keys), or null. */
  const [magnified, setMagnified] = useState<number | null>(null);
  const drag = useRef<{ corner: number; pointer: number; dx: number; dy: number } | null>(null);
  const latest = useRef(p);
  latest.current = p;
  const dpr = Math.max(1, devicePixelRatio.value);

  // Fit the photo inside the space it has (inside its padding, the handles' room), now and
  // whenever that space changes size.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    const fit = () => {
      const s = getComputedStyle(el);
      const w = el.clientWidth - (parseFloat(s.paddingLeft) || 0) - (parseFloat(s.paddingRight) || 0);
      const h = el.clientHeight - (parseFloat(s.paddingTop) || 0) - (parseFloat(s.paddingBottom) || 0);
      const scale = Math.min(w / W, h / H);
      if (!(scale > 0) || !Number.isFinite(scale)) return;
      const next = { w: Math.max(1, Math.floor(W * scale)), h: Math.max(1, Math.floor(H * scale)) };
      setSize((s) => (s && s.w === next.w && s.h === next.h ? s : next));
    };
    fit();
    if (typeof ResizeObserver === "function") {
      const observer = new ResizeObserver(fit);
      observer.observe(el);
      return () => observer.disconnect();
    }
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [W, H]);

  // Draw the photo at the size it shows.
  useLayoutEffect(() => {
    const el = canvas.current;
    if (!el || !size) return;
    const k = Math.min(1, (size.w * dpr) / W, MAX_DRAW_SIDE / Math.max(W, H));
    const cw = Math.max(1, Math.round(W * k)), ch = Math.max(1, Math.round(H * k));
    if (el.width !== cw || el.height !== ch) {
      el.width = cw;
      el.height = ch;
    }
    const ctx = el.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(p.photo.image, 0, 0, cw, ch);
  }, [size, p.photo, dpr, W, H]);

  // Canvases hold their pixels until they are emptied (iOS counts them against a total).
  useEffect(() => {
    const shown = canvas.current;
    return () => {
      for (const el of [shown, loupe.current]) {
        if (!el) continue;
        el.width = 0;
        el.height = 0;
      }
    };
  }, []);

  // The magnifier, around the corner it follows.
  useLayoutEffect(() => {
    const el = loupe.current;
    if (!el || magnified === null || !size) return;
    const side = Math.round(LOUPE_PX * dpr);
    if (el.width !== side) {
      el.width = side;
      el.height = side;
    }
    const ctx = el.getContext("2d");
    if (!ctx) return;
    const [cx, cy] = p.corners[magnified];
    const span = LOUPE_PX / ((size.w / W) * LOUPE_ZOOM); // photo pixels across the magnifier
    const x0 = cx - span / 2, y0 = cy - span / 2, k = side / span;
    ctx.fillStyle = cssToken(frame.current, "--ws", "#808080");
    ctx.fillRect(0, 0, side, side);
    // Only the part inside the photo is drawn (a source rectangle reaching outside it is not
    // drawn the same way everywhere).
    const sx = Math.max(0, x0), sy = Math.max(0, y0), ex = Math.min(W, x0 + span), ey = Math.min(H, y0 + span);
    if (ex > sx && ey > sy) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(p.photo.image, sx, sy, ex - sx, ey - sy, (sx - x0) * k, (sy - y0) * k, (ex - sx) * k, (ey - sy) * k);
    }
    ctx.lineWidth = 2 * dpr;
    ctx.strokeStyle = cssToken(frame.current, "--accent", "#2747d8");
    ctx.beginPath();
    p.corners.forEach(([x, y], i) => {
      const at: Point = [(x - x0) * k, (y - y0) * k];
      if (i === 0) ctx.moveTo(at[0], at[1]);
      else ctx.lineTo(at[0], at[1]);
    });
    ctx.closePath();
    ctx.stroke();
    // A cross on the corner, white with a dark rim, readable on paper and on a dark desk.
    const mid = side / 2, arm = 9 * dpr;
    for (const [colour, width] of [["rgba(0, 0, 0, 0.7)", 3.5], ["#fff", 1.5]] as const) {
      ctx.strokeStyle = colour;
      ctx.lineWidth = width * dpr;
      ctx.beginPath();
      ctx.moveTo(mid - arm, mid);
      ctx.lineTo(mid + arm, mid);
      ctx.moveTo(mid, mid - arm);
      ctx.lineTo(mid, mid + arm);
      ctx.stroke();
    }
  }, [magnified, p.corners, p.photo, size, dpr, W, H]);

  /** A pointer's position in photo pixels. */
  const toPhoto = (e: PointerEvent): Point | null => {
    const r = frame.current?.getBoundingClientRect();
    if (!r || !r.width || !r.height) return null;
    return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H];
  };

  const onDown = (e: PointerEvent) => {
    const l = latest.current;
    if (l.disabled || !e.isPrimary || (e.pointerType === "mouse" && e.button !== 0) || !size) return;
    const at = toPhoto(e);
    if (!at) return;
    const scale = size.w / W;
    let corner = -1, nearest = Infinity;
    l.corners.forEach(([x, y], i) => {
      const d = Math.hypot((x - at[0]) * scale, (y - at[1]) * scale);
      if (d < nearest) {
        nearest = d;
        corner = i;
      }
    });
    if (corner < 0 || nearest > (e.pointerType === "mouse" ? GRAB_PX.mouse : GRAB_PX.touch)) return;
    e.preventDefault(); // no text selection, no scrolling, no mouse emulation
    handles.current[corner]?.focus({ preventScroll: true });
    try {
      frame.current?.setPointerCapture(e.pointerId);
    } catch {
      // It still follows while over the photo.
    }
    const [x, y] = l.corners[corner];
    drag.current = { corner, pointer: e.pointerId, dx: x - at[0], dy: y - at[1] };
    setMagnified(corner);
  };
  const onMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    const at = toPhoto(e);
    if (!at) return;
    const l = latest.current;
    l.onCorners(withCorner(l.corners, d.corner, [at[0] + d.dx, at[1] + d.dy], W, H));
  };
  const onEnd = (e: PointerEvent) => {
    if (drag.current?.pointer !== e.pointerId) return;
    drag.current = null;
    setMagnified(null);
  };
  const onKey = (corner: number) => (e: KeyboardEvent) => {
    const dx = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
    const dy = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
    if (!dx && !dy) return;
    e.preventDefault();
    const l = latest.current;
    if (l.disabled) return;
    const step = Math.max(1, Math.max(W, H) * (e.shiftKey ? STEP_BIG : STEP));
    const [x, y] = l.corners[corner];
    l.onCorners(withCorner(l.corners, corner, [x + dx * step, y + dy * step], W, H));
    setMagnified(corner);
  };

  const pct = (v: number, of: number) => `${(v / of) * 100}%`;
  const points = p.corners.map(([x, y]) => `${x},${y}`).join(" ");
  const shade = `M0 0H${W}V${H}H0Z M${p.corners.map(([x, y]) => `${x} ${y}`).join(" L")}Z`;
  // The magnifier goes to the top corner away from the corner it shows.
  const loupeSide = magnified !== null && p.corners[magnified][0] < W / 2 ? "right" : "left";

  return (
    <div ref={area} class="scan-area">
      <div
        ref={frame}
        class={p.disabled ? "scan-frame is-disabled" : "scan-frame"}
        role="group"
        aria-label={t("scan.photoLabel")}
        style={size ? { width: `${size.w}px`, height: `${size.h}px` } : { visibility: "hidden" }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onEnd}
        onPointerCancel={onEnd}
        onLostPointerCapture={onEnd}
      >
        <canvas ref={canvas} class="scan-photo" aria-hidden="true" />
        <svg class="scan-quad" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
          <path class="scan-quad-shade" d={shade} fill-rule="evenodd" />
          <polygon class="scan-quad-line" points={points} vector-effect="non-scaling-stroke" />
        </svg>
        {p.corners.map(([x, y], i) => (
          <button
            key={i}
            ref={(el) => {
              handles.current[i] = el;
            }}
            type="button"
            class="scan-handle"
            style={{ left: pct(x, W), top: pct(y, H) }}
            aria-label={t("scan.cornerAt", {
              corner: t(CORNER_NAMES[i]), x: Math.round((x / W) * 100), y: Math.round((y / H) * 100),
            })}
            aria-describedby={p.describedBy}
            aria-disabled={p.disabled ? "true" : undefined}
            onKeyDown={onKey(i)}
            onBlur={() => {
              if (!drag.current) setMagnified(null);
            }}
          />
        ))}
        {magnified !== null && <canvas ref={loupe} class={`scan-loupe is-${loupeSide}`} aria-hidden="true" />}
      </div>
    </div>
  );
}
