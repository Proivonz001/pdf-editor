// The drawing pad of the signature sheet ("Disegna", ui/fill/SignatureSheet.tsx): a canvas the
// user signs on with a finger, a pen, the mouse or a trackpad. Only the strokes are kept, as
// points with their time (and a pen's pressure), never the pixels: the pad is drawn again from
// them after a resize (a canvas is cleared when its size changes), and the signature's PNG is
// painted from the same points at print resolution when the user takes it (renderStrokes).
//
// The line is signatureImage.ts's: strokePieces makes quadratic curves through the midpoints of
// the points, thinner where the hand moves fast (signature_pad's model) or as a pen presses, and
// drawPieces paints them; the pad uses both, live, so what is drawn is what the PDF gets. Only
// the primary pointer draws, so a palm or a second finger is ignored; it is captured, so a
// stroke that runs off the pad goes on until the finger lifts; and the coalesced events are read
// where the browser has them, so a fast stroke stays smooth between frames. The canvas has
// touch-action: none (fill.css): a finger on it draws, it does not scroll the sheet. Strokes and
// their colour belong to the parent, which keeps them while another tab is shown; the pad
// reports each finished stroke (onStrokes).
//
// When the pad gets smaller than the ink (the phone turned upright after signing sideways), it
// shows the strokes smaller, at a view scale (fitScale), and maps new points through it; the
// strokes keep the coordinates they were drawn in, so neither their shape nor their weight
// changes. A stroke drawn while the view is smaller records that scale: its speed is measured as
// the hand moved, and its line weight is the others' (strokePieces), on the pad and in the PNG.
// When the pad grows again, or the stroke that did not fit is undone, the view goes back
// towards 1.
import { useLayoutEffect, useRef } from "preact/hooks";
import { devicePixelRatio, INK, type InkColor } from "../../state";
import {
  drawPieces, fitScale, refitView, STROKE_OPTIONS, strokePieces, type Stroke, type StrokePiece, type StrokePoint,
} from "./signatureImage";

/** The CSS colour of an ink (INK holds sRGB 0..1). */
export function inkCss(color: InkColor): string {
  const [r, g, b] = INK[color].map((v) => Math.round(v * 255));
  return `rgb(${r}, ${g}, ${b})`;
}

/** The stroke being drawn. */
interface Live {
  pointer: number;
  /** The canvas box when it started: the sheet does not move under a finger that draws. */
  left: number;
  top: number;
  /** The view scale when it started (CSS px per pad px): its points are mapped through it. */
  scale: number;
  pen: boolean;
  /** The pen's last pressure over 0: the point where it lifts has none (pointerup reports 0). */
  pressure: number | null;
  points: StrokePoint[];
  /** Pieces painted so far (all but the straight end, which the next point turns into a curve). */
  painted: number;
}

export interface SignaturePadProps {
  /** Initials get a lower pad (fill.css). */
  kind: "signature" | "initials";
  color: InkColor;
  strokes: readonly Stroke[];
  /** A stroke ended: the strokes with it. */
  onStrokes(next: readonly Stroke[]): void;
  /** The canvas's accessible name (it is role="img"). */
  label: string;
  describedBy?: string;
}

export function SignaturePad(p: SignaturePadProps) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const latest = useRef(p);
  latest.current = p;
  /**
   * The strokes as the pad last knew them: the parent's, or with a stroke just ended that the
   * parent has not rendered yet (a second stroke ending before that must not drop the first).
   */
  const strokes = useRef({ from: p.strokes, now: p.strokes });
  if (strokes.current.from !== p.strokes) strokes.current = { from: p.strokes, now: p.strokes };
  const report = (next: readonly Stroke[]) => {
    strokes.current.now = next;
    latest.current.onStrokes(next);
  };
  /** The canvas's size in CSS px (0 while its tab is hidden) and the pixel ratio it was sized for. */
  const size = useRef({ w: 0, h: 0, dpr: 1 });
  /** CSS px per pad px: 1, or less while the ink would not fit otherwise. */
  const view = useRef(1);
  /** The size changed while a stroke was under way: the view is fitted again when it ends. */
  const refit = useRef(false);
  const live = useRef<Live | null>(null);
  const dpr = devicePixelRatio.value;

  const paint = (pieces: readonly StrokePiece[]) => {
    const ctx = canvas.current?.getContext("2d");
    if (ctx && pieces.length) drawPieces(ctx, pieces, inkCss(latest.current.color), size.current.dpr * view.current);
  };

  /** Everything again: the strokes, then the one being drawn. */
  const redraw = () => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;
    const l = live.current;
    // Nothing left to show smaller (cleared): back to the pad's own size.
    if (!strokes.current.now.length && !l) view.current = 1;
    ctx.clearRect(0, 0, el.width, el.height);
    for (const s of strokes.current.now) paint(strokePieces(s));
    if (l) {
      const pieces = strokePieces({ points: l.points, scale: l.scale });
      // One point is a dot, not a piece of the stroke to come (see onDown).
      l.painted = l.points.length === 1 ? 0 : pieces.length - 1;
      paint(l.points.length === 1 ? pieces : pieces.slice(0, -1));
    }
  };

  /** Follow the box's size: a sharp canvas at the device's pixel ratio, drawn again. */
  const resize = () => {
    const el = canvas.current, b = box.current;
    if (!el || !b) return;
    const w = b.clientWidth, h = b.clientHeight;
    if (!w || !h) return; // its tab is hidden: keep the last size until it shows again
    const ratio = window.devicePixelRatio || 1;
    const before = size.current;
    if (w === before.w && h === before.h && ratio === before.dpr) return;
    el.width = Math.round(w * ratio);
    el.height = Math.round(h * ratio);
    size.current = { w, h, dpr: ratio };
    // A new size: the ink shown as large as it fits, up to as drawn (after the stroke under way,
    // if any: its points are mapped through the scale it started with).
    if (w !== before.w || h !== before.h) {
      if (live.current) refit.current = true;
      else view.current = fitScale(strokes.current.now, w, h);
    }
    redraw();
  };

  useLayoutEffect(() => {
    const b = box.current;
    if (!b) return;
    const observer = new ResizeObserver(resize);
    observer.observe(b);
    resize();
    return () => observer.disconnect();
  }, []);
  // The pixel ratio changes with the browser's zoom, which a ResizeObserver does not report.
  useLayoutEffect(resize, [dpr]);
  /** The strokes changed (one ended, Undo, Clear): the view grows back as far as they now fit (refitView). */
  const strokesChanged = () => {
    if (!live.current) view.current = refitView(strokes.current.now, view.current, size.current.w, size.current.h);
    redraw();
  };
  useLayoutEffect(strokesChanged, [p.strokes, p.color]);

  const pointOf = (l: Live, e: PointerEvent): StrokePoint | null => {
    const x = (e.clientX - l.left) / l.scale, y = (e.clientY - l.top) / l.scale;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    // A pen's pressure sets the width; a finger's or a mouse's (0.5 while pressed, or 0) does not.
    if (!l.pen) return { x, y, time: e.timeStamp };
    if (e.pressure > 0) l.pressure = e.pressure;
    return l.pressure === null ? { x, y, time: e.timeStamp } : { x, y, time: e.timeStamp, pressure: l.pressure };
  };

  /**
   * Add a point, unless it is closer than strokePieces' minimum to the last one (then it would
   * drop it anyway, and the pieces painted so far would not stay the ones it makes). The point
   * where the pen lifts is always added: strokePieces ends the stroke there.
   */
  const add = (l: Live, e: PointerEvent, last: boolean) => {
    const q = pointOf(l, e);
    if (!q) return;
    const prev = l.points[l.points.length - 1];
    const distance = Math.hypot(q.x - prev.x, q.y - prev.y) * l.scale; // on the screen, as strokePieces measures
    if (last ? distance === 0 : distance < STROKE_OPTIONS.minDistance) return;
    l.points.push(q);
    if (last) return; // the parent draws the finished stroke
    const pieces = strokePieces({ points: l.points, scale: l.scale });
    paint(pieces.slice(l.painted, -1));
    l.painted = pieces.length - 1;
  };

  const onDown = (e: PointerEvent) => {
    const el = canvas.current;
    if (!el || !e.isPrimary || live.current) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault(); // no text selection, no focus moving away, no emulated mouse events
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // Not capturable (the pointer is already gone): it still draws while over the pad.
    }
    const r = el.getBoundingClientRect();
    const l: Live = {
      pointer: e.pointerId, left: r.left, top: r.top, scale: view.current, pen: e.pointerType === "pen", pressure: null,
      points: [], painted: 0,
    };
    const q = pointOf(l, e);
    if (!q) return;
    l.points.push(q);
    live.current = l;
    // A dot where it starts: a tap stays one (the dot of an i). The first piece starts on it with
    // the same width, so it disappears under the stroke.
    paint(strokePieces({ points: l.points, scale: l.scale }));
    l.painted = 0;
  };

  const onMove = (e: PointerEvent) => {
    const l = live.current;
    if (!l || e.pointerId !== l.pointer) return;
    const events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
    for (const one of events.length ? events : [e]) add(l, one, false);
  };

  const onEnd = (e: PointerEvent) => {
    const l = live.current;
    if (!l || e.pointerId !== l.pointer) return;
    if (e.type === "pointerup") add(l, e, true);
    live.current = null;
    // The parent keeps it, and the pad draws everything again (the stroke's end too).
    report([...strokes.current.now, { points: l.points, scale: l.scale }]);
    if (refit.current) {
      refit.current = false;
      view.current = fitScale(strokes.current.now, size.current.w, size.current.h);
    }
    redraw();
  };

  return (
    <div ref={box} class={p.kind === "initials" ? "sig-pad is-initials" : "sig-pad"}>
      <span class="sig-pad-baseline" aria-hidden="true" />
      <canvas
        ref={canvas}
        class="sig-pad-canvas"
        role="img"
        aria-label={p.label}
        aria-describedby={p.describedBy}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onEnd}
        onPointerCancel={onEnd}
        onLostPointerCapture={onEnd}
        onContextMenu={(e) => e.preventDefault()}
      />
    </div>
  );
}
