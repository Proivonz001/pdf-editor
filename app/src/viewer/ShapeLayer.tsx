// The overlay of one page in Modifica with Forme (release 6): the shapes the app drew on it, a new
// one being drawn, and the selected one with its frame, handles and context bar.
//
// Drawing (the kind and style chosen in the banner: shapeKind, shapeStyle): with a mouse, press
// and drag (3 px) draws, previewed in SVG with the very paths the engine writes (shapeGeometry's
// drawing and svgPath); Shift makes a square, a circle, a line at 45° steps. Releasing writes one
// edit (ui/shapes/actions.ts, addShape) and the new shape is selected, but a pen stroke or a
// highlight, so that the next one can follow it (nothing is selected then); its preview stays
// until the page's canvas shows it. On touch screens one finger still scrolls the page (the
// catcher keeps touch-action: pan-x pan-y) and two fingers zoom it (gestures.ts): a tap on the
// empty page puts a default shape there (ui/shapes/geometry.ts, defaultPoints), or first drops the
// selection. The pen (Penna) draws with a mouse and with one finger (its catcher takes
// touch-action: none; a second finger gives the stroke up and lets gestures.ts zoom and pan), its
// points thinned as they come (addPenPoint, coalesced events included), from the press: an accent
// or a dot is drawn too (penStroke), even next to a stroke, but a tap on a shape's ink selects it
// and a tap with one selected drops it (or selects the one whose ink it is on). The highlighter
// (Evidenzia) drags a box, or a click or tap on a text line highlights that line (lineBoxAt: a
// justified line's pieces joined); the lines (viewer/lines.ts) are read when Forme comes on, and a
// click that comes first waits for them; a double click's second click is no click (one highlight,
// not two stacked while the first is written). From the keyboard, "Metti al centro" in the banner
// puts a default shape in the middle of what shows (actions.ts). New points always stay on the
// page. Esc gives a drawing up, and its release is no click.
//
// Each shape is a button over what it covers (Tab goes through them in painting order), named by
// what it is ("Freccia rossa, 40 mm"): Enter, Space or an assistive technology's click selects it.
// The buttons let the pointer through: a click or tap is hit-tested against the shapes themselves
// (near the stroke, inside a highlight or an arrow head, the topmost first: hitTest; a finger
// reaches 22 px, a mouse 6, the pen only the ink, and the highlighter's tap on a text line only the
// stroke's own width, so the lines round a shape can still be highlighted), so a click inside a
// large rectangle's empty middle still reaches the page.
//
// The selected shape: a box frame with the image frame's handles (corners, and edges on long
// sides with a mouse; 44 px corner targets and the round grip on touch), a line with a handle on
// each end and the grip in its middle; elsewhere a line's frame (with the pen, any shape's: the
// next stroke may start in it) lets presses through to the page (a mouse press on the shape itself
// moves it: the layer hands it over, Grab; a finger or a stylus there scrolls or draws), and on
// touch a tap inside a box frame is a tap on the page there (another shape selected, or none). A
// drag previews in SVG (the old drawing stays on the canvas, with a dashed ghost round it; a
// change of style alone, or none, is not drawn over it, only once the canvas shows it) and
// releasing writes one edit (editShape), whose preview stays until the canvas shows it. The
// frame is an "application" for
// screen readers: arrows move it (1 pt, Shift 10 pt), Alt + arrows stretch a box or move a line's
// end, Delete removes it, Esc deselects; keys, the context bar's style choices and NudgeControls
// add up and are written as one edit 600 ms after the last change, or at once when the app needs
// it (registerEditor: a download, an undo, a change of tool; a drag released meanwhile is written
// after it). While an edit is written the frame shows pending and takes nothing. The context bar:
// colour (5, or the highlighter's 4), width, line style and arrow heads as radio groups, the move
// and size buttons (NudgeControls; its Stretch makes the arrows change a box's width and height,
// or move a line's end: its direction and length, all without dragging), Elimina and
// Deseleziona; a style chosen there is also the next shape's. It is placed as the image bar is
// (placeBar): below the shape (a highlight's above, so the next lines of text stay free), else
// on the other side, where the whole bar is in what shows and among the pages (it may stand out
// of its page, over the gap and the next one), room kept for the move buttons' row while it is
// closed (opening it never flips the bar), else over the shape; shifted sideways into view; again
// on a scroll, a zoom, or its own size changing. The layer's status region says what happened
// ("Rettangolo aggiunto"; a shape moved or resized: its name, size and place, "Freccia rossa,
// 40 mm, a 35 mm da sinistra e 20 mm dall'alto"; "Forma
// eliminata"), never again what was said before the layer came. When the frame goes with the
// focus inside, the focus goes to its shape's button, else (deleted) to the scroller, never to
// <body>.
// Styled by styles/shapes.css (the handles and the grip are the image frame's: viewer.css).
import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { HIGHLIGHT_ALPHA, type LineInfo, type Rect, type Shape, type ShapeDash, type ShapeInfo } from "../engine/protocol";
import { drawing, isShapeDrawable, svgPath, type Point } from "../engine/shapeGeometry";
import { t } from "../i18n";
import {
  busy, HIGHLIGHT_COLORS, registerEditor, selectedShape, SHAPE_COLORS, SHAPE_WIDTHS, shapeKind, shapeStyle,
  type ShapeColor, type ShapeToolKind,
} from "../state";
import { deselectShape, upperFirst } from "../ui/actions";
import { rescueFocus, viewerScroller } from "../ui/focus";
import {
  IconDashDashed, IconDashDotted, IconDashSolid, IconDeselect, IconMove, IconShapeArrow, IconShapeArrowBoth, IconShapeLine,
  IconTrash,
} from "../ui/icons";
import { isCoarse } from "../ui/media";
import { NudgeControls, nudgeOpen } from "../ui/NudgeControls";
import { handlePoint, MIN_BOX_SIDE } from "../ui/redact/geometry";
import {
  addedText, addShape, colorName, colorOf, editShape, ensureShapes, newShape, pageShapes, placedText, sayShape, shapeLabel,
  shapeSaid, shapesMode,
} from "../ui/shapes/actions";
import {
  addPenPoint, changeOf, clampPoint, defaultPoints, dragPoints, HIT_PX_TOUCH, hitTest, INK_PT, lineBoxAt,
  lineHighlight, moveEnd, moveShape, penStroke, pointsBox, resizeShape, sameShape, scaleShape, stretchShape,
} from "../ui/shapes/geometry";
import { cssRgb, px, rectBox } from "./FillLayer";
import { pagePoint, type Handle } from "./imageGeometry";
import { ensureLines } from "./lines";
import type { PageModel } from "./model";

const CORNERS: Handle[] = ["nw", "ne", "se", "sw"];
const EDGES: Handle[] = ["n", "e", "s", "w"];
const CURSORS: Record<Handle, string> = {
  nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize",
  n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize",
};
const ARROWS: Record<string, Point> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
const COLORS: readonly ShapeColor[] = ["black", "red", "blue", "green", "yellow"];
const DASHES: readonly ShapeDash[] = ["solid", "dashed", "dotted"];
/** A press becomes a drag past this many px: a mouse a little, a finger as far as a browser's touch slop. */
const DRAG_THRESHOLD_MOUSE = 3;
const DRAG_THRESHOLD_TOUCH = 10;
/** Keyboard, bar and nudge changes are written this long (ms) after the last one. */
const KEY_COMMIT_DELAY = 600;
/** Arrow keys move (or stretch) by 1 pt, with Shift by 10 pt. */
const NUDGE = 1;
const NUDGE_FAR = 10;
/** No side (nor line) is made shorter than this on screen (px), nor than MIN_BOX_SIDE in points. */
const MIN_SIDE_PX = 4;
/** Edge handles show only on sides at least this long on screen (px), as on the image frame. */
const EDGE_HANDLE_MIN = 48;
/** Touch: the grip goes below a box (or a line) shorter than this on screen (px), clear of the 44 px targets. */
const GRIP_INSIDE_MIN = 88;
/** Px the handles take round the frame (and the grip below a small one), kept clear of the context bar. */
const HANDLE_ROOM_FINE = 9;
const GRIP_ROOM = 90;
const BAR_GAP = 8;
const CORNER_TARGET = 44;
/** Touch: a corner target reaches this far into the box (redact.css and shapes.css), the rest out. */
const reach = (side: number) => Math.max(0, Math.min(22, side / 2 - 2));
/** The context bar keeps this far (px) from the edges of what shows (as ImageLayer's). */
const VIEW_EDGE = 8;
/** The context bar's gap (px) between its rows (viewer.css): the move buttons' row adds one and its height. */
const ROW_GAP = 4;
/** The context bar's height (px) until it is measured: one row (viewer.css). */
const BAR_GUESS_FINE = 36;
const BAR_GUESS_COARSE = 44;
/** Pages narrower than this (px) get icon-only Elimina and Deseleziona (each keeps its name and tooltip). */
const LABELS_MIN_PAGE = 440;
/** The selection frame is at least this big on screen (px), however flat the shape. */
const FRAME_MIN_PX = 12;

/**
 * The frame round `box` (page space) in px inside the page: at least FRAME_MIN_PX on each side,
 * centred, so a flat line or stroke can still be grabbed and focused.
 */
function framePx(page: PageModel, box: Rect, zoom: number) {
  const b = rectBox(page, box, zoom);
  const grow = (start: number, size: number) => (size >= FRAME_MIN_PX ? [start, size] : [start - (FRAME_MIN_PX - size) / 2, FRAME_MIN_PX]);
  const [left, width] = grow(b.left, b.width);
  const [top, height] = grow(b.top, b.height);
  return { left, top, width, height };
}

/** The shape a click at `p` hits (hitTest): with the pen (`pen`) only on a stroke's ink, next to it a tap is a dot; else within `px`. */
const hitAt = <T extends { shape: Shape }>(shapes: readonly T[], p: Point, zoom: number, pen: boolean, px?: number) =>
  (pen ? hitTest(shapes, p, zoom, 0, INK_PT) : hitTest(shapes, p, zoom, px));

/** Where the context bar goes, in px inside the page: its top, whether it is below the selection, and px to the side. */
export interface BarPlace {
  top: number;
  below: boolean;
  nudge: number;
}

/** No view to keep in: the page alone (before the bar is measured). */
const ANYWHERE = { top: -Infinity, bottom: Infinity, left: -Infinity, right: Infinity };

/**
 * Where the context bar goes (as ImageLayer's): on the first side that has the whole bar within
 * `page.min`..`page.max` and in `view` (client px: what shows of the scroller), below the selection
 * or (`preferAbove`: a highlight, so the next lines of text stay free) above it first, with
 * `reserve` px more on the side away from the selection (the move buttons' row, closed: where it
 * grows when it opens, so that opening it never flips the bar; when neither side has that much,
 * the sides are tried again without it: better a flip than covering the selection); else over
 * what shows of the selection, within min..max. Shifted sideways (`nudge`) to show whole. `sel`: the selection and
 * what it shows round it (handles, the grip), px inside the page; `page`: the page's client rect,
 * and the room the bar may take, px inside the page (the pages' box: it may stand out of its page,
 * over the gap and the next one; by default the page alone).
 */
export function placeBar(
  sel: { top: number; bottom: number; left: number },
  bar: { width: number; height: number },
  page: { top: number; left: number; height: number; min?: number; max?: number },
  view: { top: number; bottom: number; left: number; right: number },
  preferAbove: boolean,
  reserve = 0,
): BarPlace {
  const h = bar.height;
  const { min = 0, max = page.height } = page;
  const fits = (t0: number, t1: number) => t0 >= min && t1 <= max && page.top + t0 >= view.top && page.top + t1 <= view.bottom;
  const above = sel.top - BAR_GAP - h;
  const below = sel.bottom + BAR_GAP;
  const side = (more: number) => {
    const fitsAbove = fits(above - more, above + h), fitsBelow = fits(below, below + h + more);
    return preferAbove && fitsAbove ? above : fitsBelow ? below : fitsAbove ? above : undefined;
  };
  let top = side(reserve) ?? (reserve ? side(0) : undefined);
  if (top === undefined) {
    const shownTop = Math.max(sel.top, view.top - page.top);
    const shownBottom = Math.min(sel.bottom, view.bottom - page.top);
    top = Math.max(min, Math.min(shownTop + BAR_GAP, shownBottom - BAR_GAP - h, max - h));
  }
  const wanted = page.left + sel.left;
  const left = Math.max(view.left + VIEW_EDGE, Math.min(wanted, view.right - VIEW_EDGE - bar.width));
  return { top: Math.round(top), below: top !== above, nudge: Math.round(left - wanted) };
}

/**
 * A shape drawn in SVG over the page, in page space: what the engine will write, or has written (a
 * highlight at the engine's HIGHLIGHT_ALPHA, multiplied: shapes.css).
 */
function ShapeSvg({ page, shape }: { page: PageModel; shape: Shape }) {
  const d = drawing(shape);
  const color = cssRgb(shape.color);
  return (
    <svg
      class={shape.kind === "highlight" ? "shape-svg is-highlight" : "shape-svg"}
      viewBox={`${page.bounds[0]} ${page.bounds[1]} ${page.width} ${page.height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {d.fill.length > 0 && <path d={svgPath(d.fill)} fill={color} fill-opacity={shape.kind === "highlight" ? HIGHLIGHT_ALPHA : undefined} />}
      {d.stroke.length > 0 && (
        <path
          d={svgPath(d.stroke)}
          fill="none"
          stroke={color}
          stroke-width={shape.width}
          stroke-linecap={d.cap ? "round" : "butt"}
          stroke-linejoin={d.join ? "round" : "miter"}
          stroke-miterlimit={4}
          stroke-dasharray={d.dash.length ? d.dash.join(" ") : undefined}
        />
      )}
    </svg>
  );
}

/** One choice of the context bar (colour, width, line style, heads): a radio group, arrows move the choice. */
function Radios<V extends string | number>({ label, value, options, disabled, onPick }: {
  label: string;
  value: V;
  options: { value: V; label: string; icon: ComponentChildren }[];
  disabled: boolean;
  onPick: (value: V) => void;
}) {
  const checked = options.findIndex((o) => o.value === value);
  const onKeyDown = (e: KeyboardEvent) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    e.stopPropagation();
    const radios = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role="radio"]')];
    const next = (Math.max(0, radios.indexOf(document.activeElement as HTMLElement)) + step + options.length) % options.length;
    radios[next]?.focus();
    if (!disabled) onPick(options[next].value);
  };
  return (
    <div class="shape-radios" role="radiogroup" aria-label={label} onKeyDown={onKeyDown}>
      {options.map((o, i) => (
        <button
          type="button"
          key={String(o.value)}
          role="radio"
          aria-checked={i === checked}
          tabIndex={i === Math.max(0, checked) ? 0 : -1}
          class="btn context-btn is-icon shape-radio"
          title={o.label}
          aria-label={o.label}
          aria-disabled={disabled || undefined}
          onClick={() => {
            if (!disabled) onPick(o.value);
          }}
        >
          {o.icon}
        </button>
      ))}
    </div>
  );
}

type GestureKind = Handle | "move" | "end0" | "end1";

interface Gesture {
  kind: GestureKind;
  pointerId: number;
  el: Element;
  threshold: number;
  startX: number;
  startY: number;
  start: Point;
  /** From the pointer to the handle's exact point, so the handle does not jump to the pointer. */
  grab: Point;
  s0: Shape;
  started: boolean;
  target: Shape;
  off: () => void;
}

/**
 * A selected line's frame (with the pen, any shape's) lets presses through to the page: the layer
 * hands it a mouse press on the shape itself (`down`: true when it is the shape's), then that
 * pointer's events, captured by the layer's catcher. A finger or a stylus there scrolls the page
 * (or, with the pen, draws), as everywhere else on it.
 */
interface Grab {
  id: number;
  down: (e: PointerEvent) => boolean;
  move: (e: PointerEvent) => void;
  up: (e: PointerEvent) => void;
  cancel: (e: PointerEvent) => void;
}

interface SelectedProps {
  page: PageModel;
  zoom: number;
  info: ShapeInfo;
  /** The page's shapes are being read again after an edit: `info` is the last known. */
  waiting: boolean;
  canvasRev: number;
  /** The page's shapes, for a click on the frame that means another shape on top of it. */
  shapes: readonly ShapeInfo[];
  /** Where a line (with the pen, any shape) puts its hand-over for the layer (else null). */
  grab: { current: Grab | null };
}

function SelectedShape({ page, zoom, info, waiting, canvasRev, shapes, grab }: SelectedProps) {
  const frame = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const coarse = isCoarse.value;
  /** The kind of the last pointer pressed on the frame (a click event does not always say). */
  const framePointer = useRef("mouse");
  /** Deleted (asked): when the frame goes, the focus goes to the scroller, not to a button of the shape. */
  const deleted = useRef(false);
  /** Where a gesture, the keys or the bar are taking the shape (shown, not written yet). */
  const [live, setLive] = useState<Shape | null>(null);
  /** The shape being written, then (with its page revision) until the canvas shows it; what the edit changed. */
  const [committed, setCommitted] = useState<{ shape: Shape; rev: number | null; change: ReturnType<typeof changeOf> } | null>(null);
  const [writing, setWriting] = useState(false);
  const [dragging, setDragging] = useState(false);
  /** Where the context bar is (placeBar), once measured. */
  const [placed, setPlaced] = useState<BarPlace | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const keyTarget = useRef<Shape | null>(null);
  const keyTimer = useRef(0);
  const inflight = useRef<Promise<void> | null>(null);
  const unregister = useRef<(() => void) | null>(null);

  const pending = writing || waiting || busy.value === "edit";
  // The latest values, for handlers that outlive a render (timers, window listeners, registerEditor).
  const latest = useRef({ info, zoom, pending, shapes });
  latest.current = { info, zoom, pending, shapes };
  const bounds = page.bounds;
  const shown = live ?? committed?.shape ?? info.shape;
  const minSide = () => Math.max(MIN_BOX_SIDE, MIN_SIDE_PX / latest.current.zoom);

  const dropRegistration = () => {
    unregister.current?.();
    unregister.current = null;
  };

  /** Write `target` as one edit (a release, the keys' pause, flushEditor). */
  const commit = (target: Shape): Promise<void> => {
    // A drag released while the keys' change is written (flushEditor took it meanwhile): written after it.
    if (inflight.current) return inflight.current.then(() => commit(target));
    clearTimeout(keyTimer.current);
    keyTimer.current = 0;
    keyTarget.current = null;
    const change = changeOf(latest.current.info.shape, target);
    if (!change) {
      setLive(null);
      dropRegistration();
      return Promise.resolve();
    }
    const before = page.rev.peek();
    setCommitted({ shape: target, rev: null, change });
    setLive(null);
    setWriting(true);
    const run = editShape(page, latest.current.info.id, target)
      .catch((e: unknown) => {
        console.error(e);
        return false;
      })
      .then((done) => {
        inflight.current = null;
        setWriting(false);
        // Refused or failed: the shape is as it was. Written: the preview stays until the canvas shows it.
        if (done && page.rev.peek() !== before) {
          setCommitted({ shape: target, rev: page.rev.peek(), change });
          sayShape(page.index, change === "restyled" ? t("shapes.restyled") : placedText(target, bounds));
        } else {
          setCommitted(null);
        }
        dropRegistration();
      });
    inflight.current = run;
    return run;
  };

  /** Write what the keys, the bar and the nudge buttons have done so far (also what flushEditor calls). */
  const flushKeys = (): Promise<void> => {
    if (inflight.current) return inflight.current;
    const target = keyTarget.current;
    if (!target) {
      dropRegistration();
      return Promise.resolve();
    }
    return commit(target);
  };

  /** A change from the keys, the bar or the nudge buttons: shown at once, written after a pause. */
  const keyChange = (change: (s: Shape) => Shape) => {
    if (latest.current.pending || gesture.current) return;
    const base = keyTarget.current ?? latest.current.info.shape;
    const next = change(base);
    if (sameShape(next, base)) return;
    keyTarget.current = next;
    setLive(next);
    if (!unregister.current) unregister.current = registerEditor({ changed: () => true, commit: () => flushKeys() });
    clearTimeout(keyTimer.current);
    keyTimer.current = window.setTimeout(() => void flushKeys(), KEY_COMMIT_DELAY);
  };

  // --- Pointer gestures (handles, the touch grip, the frame itself with a mouse) -------------------

  const pointAt = (x: number, y: number): Point => {
    const r = frame.current?.closest<HTMLElement>(".page")?.getBoundingClientRect() ?? { left: 0, top: 0 };
    return pagePoint(x, y, r, [bounds[0], bounds[1]], latest.current.zoom);
  };

  const targetOf = (g: Gesture, x: number, y: number, shift: boolean): Shape => {
    const p = pointAt(x, y);
    const q: Point = [p[0] + g.grab[0], p[1] + g.grab[1]];
    if (g.kind === "move") return moveShape(g.s0, p[0] - g.start[0], p[1] - g.start[1], bounds);
    if (g.kind === "end0" || g.kind === "end1") return moveEnd(g.s0, g.kind === "end0" ? 0 : 1, q, bounds, shift, minSide());
    return resizeShape(g.s0, g.kind, q, bounds, minSide());
  };

  const endGesture = (): Gesture | null => {
    const g = gesture.current;
    if (!g) return null;
    gesture.current = null;
    g.off();
    try {
      if (g.el.hasPointerCapture(g.pointerId)) g.el.releasePointerCapture(g.pointerId);
    } catch {
      // The pointer is gone already.
    }
    setDragging(false);
    return g;
  };

  /** Escape, a second finger, a pointer the browser took: back to where the shape was (or the keys had it). */
  function cancelGesture() {
    if (!endGesture()) return;
    setLive(keyTarget.current);
    if (keyTarget.current) keyTimer.current = window.setTimeout(() => void flushKeys(), KEY_COMMIT_DELAY);
  }

  const startGesture = (e: PointerEvent, kind: GestureKind) => {
    if (gesture.current || latest.current.pending) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (!e.isPrimary) return; // a second finger: the pinch zooms
    const el = e.currentTarget as Element;
    if (e.pointerType === "mouse") e.preventDefault(); // no text selection, no native drag
    frame.current?.focus({ preventScroll: true });
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      return; // the pointer is gone already
    }
    // A change the keys made and not written yet is part of this gesture: it is written with it.
    clearTimeout(keyTimer.current);
    keyTimer.current = 0;
    const s0 = keyTarget.current ?? latest.current.info.shape;
    const start = pointAt(e.clientX, e.clientY);
    const at = kind === "move" ? start : kind === "end0" ? s0.points[0] : kind === "end1" ? s0.points[1] : handlePoint(pointsBox(s0), kind);
    const onKey = (k: KeyboardEvent) => {
      if (k.key !== "Escape") return;
      k.preventDefault();
      k.stopPropagation(); // only the gesture is cancelled, not the selection
      cancelGesture();
    };
    const onOther = (p: PointerEvent) => {
      if (p.pointerId !== e.pointerId) cancelGesture();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onOther, true);
    gesture.current = {
      kind, pointerId: e.pointerId, el,
      threshold: e.pointerType === "mouse" ? DRAG_THRESHOLD_MOUSE : DRAG_THRESHOLD_TOUCH,
      startX: e.clientX, startY: e.clientY, start, grab: [at[0] - start[0], at[1] - start[1]], s0, started: false, target: s0,
      off: () => {
        window.removeEventListener("keydown", onKey, true);
        window.removeEventListener("pointerdown", onOther, true);
      },
    };
  };

  const onPointerMove = (e: PointerEvent) => {
    const g = gesture.current;
    if (!g || e.pointerId !== g.pointerId) return;
    if (!g.started) {
      if (Math.hypot(e.clientX - g.startX, e.clientY - g.startY) < g.threshold) return;
      g.started = true;
      setDragging(true);
    }
    g.target = targetOf(g, e.clientX, e.clientY, e.shiftKey);
    setLive(g.target);
  };

  const onPointerUp = (e: PointerEvent) => {
    const g = gesture.current;
    if (!g || e.pointerId !== g.pointerId) return;
    const started = g.started;
    const target = started ? targetOf(g, e.clientX, e.clientY, e.shiftKey) : g.target;
    endGesture();
    if (started) {
      void commit(target);
      return;
    }
    // A press without a drag: a change of the keys waiting for it goes on waiting...
    if (keyTarget.current) keyTimer.current = window.setTimeout(() => void flushKeys(), KEY_COMMIT_DELAY);
    // ...and a click on the frame where another shape lies on top selects that one.
    if (g.kind !== "move") return;
    const p = pointAt(e.clientX, e.clientY);
    const hit = hitAt(latest.current.shapes, p, latest.current.zoom, shapeKind.peek() === "pen", e.pointerType === "mouse" ? undefined : HIT_PX_TOUCH);
    if (hit && hit.id !== latest.current.info.id) selectedShape.value = { pageIndex: page.index, id: hit.id };
  };

  const onPointerCancel = (e: PointerEvent) => {
    if (gesture.current?.pointerId === e.pointerId) cancelGesture();
  };

  /** The frame itself drags with a mouse (or any pointer where pointers are fine); on touch the page scrolls. */
  const onFrameDown = (e: PointerEvent) => {
    framePointer.current = e.pointerType;
    if (gesture.current) return; // a handle inside took it
    if (coarse && e.pointerType !== "mouse") return;
    startGesture(e, "move");
  };

  /**
   * Touch: a tap inside the frame (not on a handle or the grip) is a tap on the page there:
   * another shape under it is selected, no shape drops the selection.
   */
  const onFrameClick = (e: MouseEvent) => {
    if (!coarse || framePointer.current === "mouse" || e.target !== frame.current || latest.current.pending) return;
    const hit = hitAt(latest.current.shapes, pointAt(e.clientX, e.clientY), latest.current.zoom, shapeKind.peek() === "pen", HIT_PX_TOUCH);
    if (!hit) deselect();
    else if (hit.id !== latest.current.info.id) selectedShape.value = { pageIndex: page.index, id: hit.id };
  };

  // --- Keys and the context bar -------------------------------------------------------------------

  /** Deselect (a change not written yet is written first). */
  const deselect = () => {
    const sel = selectedShape.peek();
    if (sel?.id === latest.current.info.id && sel.pageIndex === page.index) void deselectShape();
  };

  const remove = () => {
    if (latest.current.pending) return;
    clearTimeout(keyTimer.current);
    keyTimer.current = 0;
    keyTarget.current = null;
    setLive(null);
    dropRegistration();
    setWriting(true);
    deleted.current = true;
    void editShape(page, latest.current.info.id, null).then((done) => {
      deleted.current = done;
      setWriting(false);
      if (done) sayShape(page.index, t("shapes.deleted"));
    });
  };

  /** A style chosen in the bar: the selected shape takes it (with the keys' pause), and so does the next shape. */
  const restyle = (change: Partial<Shape>, next: Partial<typeof shapeStyle.value>) => {
    if (latest.current.pending || gesture.current) return;
    keyChange((s) => ({ ...s, ...change }));
    shapeStyle.value = { ...shapeStyle.peek(), ...next };
  };

  const onFrameKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation(); // not also "back to Cambia" (ui/shortcuts.ts)
      if (gesture.current) cancelGesture();
      else deselect();
      return;
    }
    if (e.ctrlKey || e.metaKey) return; // Ctrl + / − zoom, Ctrl+Z undoes
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      e.stopPropagation();
      remove();
      return;
    }
    const dir = ARROWS[e.key];
    if (!dir) return;
    e.preventDefault(); // arrows must not scroll the page, nor Alt + ← go back a page
    const step = e.shiftKey ? NUDGE_FAR : NUDGE;
    const [dx, dy] = [dir[0] * step, dir[1] * step];
    keyChange((s) => (e.altKey ? stretchShape(s, dx, dy, bounds, minSide()) : moveShape(s, dx, dy, bounds)));
  };

  const onBarKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    deselect();
  };

  // --- Lifetime -----------------------------------------------------------------------------------

  // Selected: the frame takes the keyboard focus. Going (deselected, deleted, the layer gone): the
  // gesture is given up, a change not written yet is written, and a focus inside goes back to the
  // shape's button, else (deleted: its button, read before, may still be there) to the scroller
  // (never to <body>).
  useLayoutEffect(() => {
    const el = frame.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    return () => {
      cancelGesture();
      void flushKeys();
      const active = document.activeElement;
      if (active !== el && !(active && bar.current?.contains(active))) return;
      const pageEl = el.closest(".page");
      const id = latest.current.info.id;
      rescueFocus(() => (!deleted.current && pageEl?.isConnected ? pageEl.querySelector<HTMLElement>(`[data-shape="${id}"]`) : null) ?? viewerScroller());
    };
  }, []);

  // Written and read again: the preview goes once the canvas shows the edit (or will not: the page is far away).
  useEffect(() => {
    if (!committed || committed.rev === null || writing) return;
    if (canvasRev >= committed.rev || !page.near.peek()) setCommitted(null);
  }, [committed, writing, canvasRev]);

  // --- Render -------------------------------------------------------------------------------------

  const line = shown.kind === "line";
  const pen = shapeKind.value === "pen";
  // A mouse press on the line itself (near its stroke; with the pen, on any shape's ink) moves it;
  // elsewhere in its box it is the page's (shapes.css), and so is a finger's or a stylus's anywhere.
  grab.current = line || pen
    ? {
      id: info.id,
      down: (e) => {
        if (e.pointerType !== "mouse" || !hitAt([{ shape: shown }], pointAt(e.clientX, e.clientY), latest.current.zoom, pen)) return false;
        startGesture(e, "move");
        return true;
      },
      move: onPointerMove,
      up: onPointerUp,
      cancel: onPointerCancel,
    }
    : null;
  const b = framePx(page, pointsBox(shown), zoom);
  const [a0, a1] = shown.points;
  const length = line ? Math.hypot(a1[0] - a0[0], a1[1] - a0[1]) * zoom : 0;
  const gripOutside = coarse && (line ? length : Math.min(b.width, b.height)) < GRIP_INSIDE_MIN;
  const room = coarse ? CORNER_TARGET - reach(line ? 0 : b.height) : HANDLE_ROOM_FINE;
  const kind = shown.kind;
  const labels = page.width * zoom >= LABELS_MIN_PAGE;

  // The context bar: placed from its measured size and where the page shows (placeBar), again
  // after a scroll, a zoom or the bar's size changing (the move buttons' row shown, a wrap) before
  // it is drawn, so that the row grows away from the shape and the bar's buttons stay put; until it
  // is measured, from the page alone and one row's height.
  const sel = { top: b.top - room, bottom: b.top + b.height + (gripOutside ? GRIP_ROOM : room), left: b.left };
  const preferAbove = kind === "highlight";
  const place = () => {
    const barEl = bar.current;
    const pageEl = frame.current?.closest<HTMLElement>(".page");
    const scroller = pageEl?.closest<HTMLElement>(".scroller");
    if (!barEl || !pageEl || !scroller) return;
    const s = scroller.getBoundingClientRect();
    const p = pageEl.getBoundingClientRect();
    // The pages' box: the bar may stand out of its page over the gap and the next page, not past
    // the last one (.pages clips).
    const pages = pageEl.parentElement?.getBoundingClientRect() ?? p;
    // What is visible of the scroller: without its scrollbars, and (phones) within the visual viewport.
    const vv = window.visualViewport;
    const view = {
      top: Math.max(s.top, vv ? vv.offsetTop : -Infinity),
      bottom: Math.min(s.top + scroller.clientHeight, vv ? vv.offsetTop + vv.height : Infinity),
      left: Math.max(s.left, vv ? vv.offsetLeft : -Infinity),
      right: Math.min(s.left + scroller.clientWidth, vv ? vv.offsetLeft + vv.width : Infinity),
    };
    if (p.top + sel.bottom <= view.top || p.top + sel.top >= view.bottom) return; // out of sight: it stays
    // The move buttons' row, closed: its room kept, so that opening it never flips the bar.
    const toggle = barEl.querySelector<HTMLElement>(".nudge-toggle");
    const reserve = nudgeOpen.peek() || !toggle ? 0 : toggle.offsetHeight + ROW_GAP;
    const extent = { top: p.top, left: p.left, height: p.height, min: pages.top - p.top, max: pages.bottom - p.top };
    const next = placeBar(sel, { width: barEl.offsetWidth, height: barEl.offsetHeight }, extent, view, preferAbove, reserve);
    setPlaced((prev) => (prev && prev.top === next.top && prev.below === next.below && prev.nudge === next.nudge ? prev : next));
  };
  const placeRef = useRef(place);
  placeRef.current = place;
  useLayoutEffect(() => {
    const scroller = frame.current?.closest<HTMLElement>(".scroller");
    const viewport: EventTarget = window.visualViewport ?? window;
    let raf = 0;
    const onMove = () => {
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; placeRef.current(); });
    };
    scroller?.addEventListener("scroll", onMove, { passive: true });
    viewport.addEventListener("resize", onMove);
    viewport.addEventListener("scroll", onMove);
    const resized = new ResizeObserver(() => placeRef.current());
    if (bar.current) resized.observe(bar.current);
    return () => {
      resized.disconnect();
      scroller?.removeEventListener("scroll", onMove);
      viewport.removeEventListener("resize", onMove);
      viewport.removeEventListener("scroll", onMove);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);
  // The shape moved or resized, the zoom changed, the bar's choices did: placed again (and after the
  // viewer has re-anchored the scroll on a zoom).
  const placeKey = [sel.top, sel.bottom, sel.left, kind, labels, pending].join(",");
  useLayoutEffect(() => {
    if (dragging) return;
    const id = requestAnimationFrame(() => placeRef.current());
    placeRef.current();
    return () => cancelAnimationFrame(id);
  }, [placeKey, zoom, dragging]);
  const guess = { width: 0, height: coarse ? BAR_GUESS_COARSE : BAR_GUESS_FINE };
  const at = placed ?? placeBar(sel, guess, { top: 0, left: 0, height: page.height * zoom }, ANYWHERE, preferAbove);
  const frameStyle = { ...px(b), ...(coarse && !line ? { "--reach-x": `${reach(b.width)}px`, "--reach-y": `${reach(b.height)}px` } : {}) };
  const edges = coarse || line ? [] : EDGES.filter((h) => (h === "n" || h === "s" ? b.width : b.height) >= EDGE_HANDLE_MIN);
  const handle = (which: Handle) => (
    <span
      key={which}
      class={`image-handle is-${which}`}
      style={{ cursor: CURSORS[which] }}
      title={t("image.handle.resize")}
      aria-hidden="true"
      onPointerDown={(e) => startGesture(e, which)}
    />
  );
  const end = (i: 0 | 1) => (
    <span
      key={`end${i}`}
      class="image-handle shape-end"
      style={{
        left: `${(shown.points[i][0] - page.bounds[0]) * zoom - b.left}px`,
        top: `${(shown.points[i][1] - page.bounds[1]) * zoom - b.top}px`,
      }}
      title={t("shapes.handle.end")}
      aria-hidden="true"
      onPointerDown={(e) => startGesture(e, i ? "end1" : "end0")}
    />
  );
  // A change of style alone is not drawn over the old drawing (two dash patterns, two colours
  // multiplied): the canvas shows it once written. (What a written edit changed is kept with it:
  // once the shapes are read again, info.shape is already the new one.)
  // (Back where it was, unchanged: nothing is drawn over it either.)
  const moved = live !== null ? (changeOf(info.shape, live) ?? "restyled") !== "restyled" : committed !== null && committed.change !== "restyled";
  const helpId = `shape-keys-${page.index}`;
  const frameClass = [
    "shape-frame", line ? "is-line" : "is-box", pending && "is-pending", dragging && "is-dragging",
  ].filter(Boolean).join(" ");

  return (
    <>
      {moved && !sameShape(shown, info.shape) && <div class="shape-ghost" aria-hidden="true" style={px(rectBox(page, info.bbox, zoom))} />}
      {moved && <ShapeSvg page={page} shape={shown} />}
      <div
        ref={frame}
        class={frameClass}
        style={frameStyle}
        data-shape-frame={info.id}
        tabIndex={0}
        // An application, so that screen readers pass its keys on.
        role="application"
        aria-roledescription={t("shapes.roleDescription")}
        aria-label={shapeLabel(info.shape)}
        aria-describedby={helpId}
        aria-busy={pending}
        onPointerDown={onFrameDown}
        onClick={onFrameClick}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onLostPointerCapture={onPointerCancel}
        onKeyDown={onFrameKeyDown}
      >
        {line ? [end(0), end(1)] : [...edges.map(handle), ...CORNERS.map(handle)]}
        {coarse && (
          <span
            class={gripOutside ? "image-grip is-outside" : "image-grip"}
            title={t("image.handle.move")}
            aria-hidden="true"
            onPointerDown={(e) => startGesture(e, "move")}
          >
            <IconMove />
          </span>
        )}
      </div>
      <span id={helpId} hidden>{t(line ? "shapes.keysHelpLine" : "shapes.keysHelp")}</span>
      <div class={["context-slot", at.below && "is-below", dragging && "is-hidden"].filter(Boolean).join(" ")} style={{ top: `${at.top}px` }}>
        <span class="context-indent" style={{ flexBasis: `${Math.max(0, b.left + at.nudge)}px` }} />
        <div ref={bar} class="context-bar shape-bar" role="group" aria-label={t("shapes.toolbar")} onKeyDown={onBarKeyDown}>
          <Radios
            label={t("shapes.colors")}
            value={colorOf(shown.color)}
            disabled={pending}
            options={(kind === "highlight" ? HIGHLIGHT_COLORS : COLORS).map((c) => ({
              value: c,
              label: upperFirst(colorName(c)),
              icon: <span class="shape-swatch" style={{ background: cssRgb(SHAPE_COLORS[c]) }} />,
            }))}
            onPick={(c) => restyle({ color: SHAPE_COLORS[c] }, kind === "highlight" ? { highlight: c } : { color: c })}
          />
          {kind !== "highlight" && (
            <Radios
              label={t("shapes.widths")}
              value={shown.width}
              disabled={pending}
              options={SHAPE_WIDTHS.map((w) => ({
                value: w,
                label: t("shapes.width", { n: w }),
                icon: <span class="shape-width" style={{ height: `${w + 1}px` }} />,
              }))}
              onPick={(w) => restyle({ width: w }, { width: w as (typeof SHAPE_WIDTHS)[number] })}
            />
          )}
          {kind !== "pen" && kind !== "highlight" && (
            <Radios
              label={t("shapes.dashes")}
              value={shown.dash}
              disabled={pending}
              options={DASHES.map((d) => ({
                value: d,
                label: t(`shapes.dash.${d}`),
                icon: d === "solid" ? <IconDashSolid /> : d === "dashed" ? <IconDashDashed /> : <IconDashDotted />,
              }))}
              onPick={(d) => restyle({ dash: d }, { dash: d })}
            />
          )}
          {line && (
            <Radios
              label={t("shapes.heads")}
              value={shown.heads}
              disabled={pending}
              options={([0, 1, 2] as const).map((h) => ({
                value: h,
                label: t(`shapes.heads.${h}`),
                icon: h === 0 ? <IconShapeLine /> : h === 1 ? <IconShapeArrow /> : <IconShapeArrowBoth />,
              }))}
              onPick={(h) => restyle({ heads: h }, h ? { heads: h } : {})}
            />
          )}
          <NudgeControls
            onMove={(dx, dy) => keyChange((s) => moveShape(s, dx, dy, bounds))}
            onScale={(factor) => keyChange((s) => scaleShape(s, factor, bounds, minSide()))}
            onStretch={(dx, dy) => keyChange((s) => stretchShape(s, dx, dy, bounds, minSide()))}
            stretchEnd={line}
            disabled={pending}
          >
            <button
              type="button"
              class={`btn context-btn${labels ? "" : " is-icon"}`}
              title={t("shapes.deleteTip", { key: t("key.delete") })}
              aria-label={labels ? undefined : t("shapes.delete")}
              aria-disabled={pending || undefined}
              onClick={remove}
            >
              <IconTrash />
              {labels && <span>{t("shapes.delete")}</span>}
            </button>
            <button
              type="button"
              class={`btn btn-primary context-btn${labels ? "" : " is-icon"}`}
              title={t("shapes.doneTip", { key: t("key.esc") })}
              aria-label={labels ? undefined : t("shapes.done")}
              onClick={deselect}
            >
              <IconDeselect />
              {labels && <span>{t("shapes.done")}</span>}
            </button>
          </NudgeControls>
          {pending && (
            <span class="context-writing" aria-hidden="true">
              <span class="spinner" />
            </span>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * The button over a shape that is not selected: a click, Enter or Space (or an assistive
 * technology's click) selects it; pointers go through it to the layer's hit test. When it goes
 * with the focus (its shape deleted or undone, the layer gone), the focus goes to a button of the
 * same shape again if there is one, else to the scroller, never to <body>.
 */
function ShapeBox({ page, zoom, info, hover, onSelect }: {
  page: PageModel; zoom: number; info: ShapeInfo; hover: boolean; onSelect: () => void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const node = button.current;
    return () => {
      if (!node || document.activeElement !== node) return;
      const pageEl = node.closest(".page");
      rescueFocus(() => (pageEl?.isConnected ? pageEl.querySelector<HTMLElement>(`[data-shape="${info.id}"]`) : null) ?? viewerScroller());
    };
  }, []);
  return (
    <button
      ref={button}
      type="button"
      class={hover ? "shape-box is-hover" : "shape-box"}
      data-shape={info.id}
      style={px(rectBox(page, info.bbox, zoom))}
      aria-label={shapeLabel(info.shape)}
      onClick={onSelect}
    />
  );
}

interface Draw {
  tool: ShapeToolKind;
  pointerId: number;
  el: Element;
  x: number;
  y: number;
  threshold: number;
  start: Point;
  end: Point;
  shift: boolean;
  started: boolean;
  /** The pen's points so far (null for the other kinds). */
  points: Point[] | null;
  off: () => void;
}

/** A shape written and not shown by the canvas yet (its page revision, once written). */
interface Placed {
  key: number;
  shape: Shape;
  rev: number | null;
}
let placedKey = 0;

export function ShapeLayer({ page, zoom, canvasRev }: { page: PageModel; zoom: number; canvasRev: number }) {
  const rev = page.rev.value;
  const cached = pageShapes(page).value;
  const cachedLines = page.lines.value;
  const kind = shapeKind.value;
  const sel = selectedShape.value;
  const said = shapeSaid.value;
  const layer = useRef<HTMLDivElement>(null);
  /** The shape being drawn (page space). */
  const [drawn, setDrawn] = useState<Shape | null>(null);
  const [placed, setPlaced] = useState<readonly Placed[]>([]);
  /** The shape under the mouse (its button shows it), or null. */
  const [hover, setHover] = useState<number | null>(null);
  /** What was said before this layer came (another tool, the page scrolled back near): not put in its new status region. */
  const [seen] = useState(shapeSaid.peek()?.id ?? 0);
  const draw = useRef<Draw | null>(null);
  const frameReq = useRef(0);
  /** The kind of the last pointer pressed here (a click event does not always say). */
  const lastPointer = useRef("mouse");
  /** A drag just ended (or was given up, or was the selected line's): the click that follows it is not a click. */
  const drew = useRef(false);
  const last = useRef<ShapeInfo[]>([]);
  /** The selected line's hand-over (SelectedShape puts it here). */
  const grab = useRef<Grab | null>(null);

  useEffect(() => {
    ensureShapes(page);
  }, [page, rev, cached]);

  // The text lines, for the highlighter: read as soon as Forme is on, whatever the kind (as Cambia does).
  useEffect(() => {
    ensureLines(page);
  }, [page, rev, cachedLines]);

  // The shapes read at the page's revision (null while they are read again), and those shown: the
  // last ones read meanwhile, so the selection's frame and a focused button stay (ids are stable).
  const fresh = cached && cached.rev === rev ? cached.shapes : null;
  if (fresh) last.current = fresh;
  const shapes = fresh ?? last.current;
  const selectedId = sel?.pageIndex === page.index ? sel.id : null;
  const selected = selectedId === null ? null : shapes.find((s) => s.id === selectedId) ?? null;
  const lines = cachedLines && cachedLines.rev === rev ? cachedLines.lines : null;

  // Read again without the selected shape (an undo, a redo, a Bianchetto over it): nothing is selected.
  useEffect(() => {
    if (fresh && selectedId !== null && !fresh.some((s) => s.id === selectedId)) selectedShape.value = null;
  }, [fresh, selectedId]);

  // Shapes written: their previews go once the canvas shows them (or will not: the page is far away).
  useEffect(() => {
    if (placed.some((p) => p.rev !== null && (canvasRev >= p.rev || !page.near.peek()))) {
      setPlaced((now) => now.filter((p) => p.rev === null || (canvasRev < p.rev && page.near.peek())));
    }
  }, [placed, canvasRev]);

  // The layer goes (another sub-tool, Modifica off) with the focus on one of its buttons: to the scroller.
  useLayoutEffect(() => {
    const node = layer.current;
    return () => {
      if (frameReq.current) cancelAnimationFrame(frameReq.current);
      draw.current?.off();
      if (node?.contains(document.activeElement)) rescueFocus(viewerScroller);
    };
  }, []);

  const pointAt = (x: number, y: number): Point => {
    const r = layer.current?.getBoundingClientRect() ?? { left: 0, top: 0 };
    return pagePoint(x, y, r, [page.bounds[0], page.bounds[1]], zoom);
  };

  const select = (id: number) => {
    selectedShape.value = { pageIndex: page.index, id };
  };

  /**
   * Write `shape` as a new one (selected, unless `select` is false): shown at once, said once
   * written, its preview kept until the canvas has it.
   */
  const place = (shape: Shape, select = true) => {
    if (!isShapeDrawable(shape)) return; // the engine's own rule: too small is dropped silently
    const before = page.rev.peek();
    const key = ++placedKey;
    setPlaced((now) => [...now, { key, shape, rev: null }]);
    void addShape(page, shape, select).then((id) => {
      const written = id !== null && page.rev.peek() !== before;
      setPlaced((now) => (written
        ? now.map((p) => (p.key === key ? { ...p, rev: page.rev.peek() } : p))
        : now.filter((p) => p.key !== key)));
      if (written) sayShape(page.index, addedText(shape));
    });
  };

  // --- Drawing (a mouse; the pen with a finger too) -------------------------------------------------

  /** What `d` draws now. */
  const shapeOf = (d: Draw): Shape => (d.points
    ? newShape("pen", penStroke(d.points, page.bounds))
    : newShape(d.tool, dragPoints(d.tool === "arrow" || d.tool === "pen" ? "line" : d.tool, d.start, d.end, d.shift, page.bounds)));

  const stopDraw = (): Draw | null => {
    const d = draw.current;
    if (!d) return null;
    draw.current = null;
    d.off();
    if (frameReq.current) cancelAnimationFrame(frameReq.current);
    frameReq.current = 0;
    try {
      if (d.el.hasPointerCapture(d.pointerId)) d.el.releasePointerCapture(d.pointerId);
    } catch {
      // The pointer is gone already.
    }
    setDrawn(null);
    return d;
  };

  const onDown = (e: PointerEvent) => {
    lastPointer.current = e.pointerType;
    drew.current = false; // a press comes before its click: set again below when this one is no click
    if (draw.current || !e.isPrimary) return;
    if (selected && grab.current?.id === selected.id && grab.current.down(e)) {
      drew.current = true;
      return;
    }
    const pen = kind === "pen";
    // Touch: one finger scrolls and a tap places a shape (onClick), except with the pen, which draws.
    if (e.pointerType === "mouse" ? e.button !== 0 : !pen) return;
    if (e.pointerType === "mouse") e.preventDefault(); // no text selection
    const el = e.currentTarget as Element;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      return;
    }
    const start = clampPoint(pointAt(e.clientX, e.clientY), page.bounds);
    const onKey = (k: KeyboardEvent) => {
      if (k.key !== "Escape") return;
      k.preventDefault();
      k.stopPropagation(); // only the drawing is given up
      stopDraw();
      drew.current = true; // and the click of its release is no click (a highlight on a line, a deselect)
    };
    // A second finger: the stroke is given up, and the pinch zooms or pans (gestures.ts).
    const onOther = (p: PointerEvent) => {
      if (p.pointerId !== e.pointerId) stopDraw();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onOther, true);
    draw.current = {
      tool: kind, pointerId: e.pointerId, el, x: e.clientX, y: e.clientY,
      // The pen's catcher does not scroll: its threshold only tells a tap from a stroke.
      threshold: pen || e.pointerType === "mouse" ? DRAG_THRESHOLD_MOUSE : DRAG_THRESHOLD_TOUCH,
      start, end: start, shift: e.shiftKey, started: false, points: pen ? [start] : null,
      off: () => {
        window.removeEventListener("keydown", onKey, true);
        window.removeEventListener("pointerdown", onOther, true);
      },
    };
  };

  const follow = (d: Draw, e: PointerEvent) => {
    if (d.points) {
      const events = e.getCoalescedEvents?.() ?? [];
      for (const c of events.length ? events : [e]) addPenPoint(d.points, clampPoint(pointAt(c.clientX, c.clientY), page.bounds));
    } else {
      d.end = pointAt(e.clientX, e.clientY);
      d.shift = e.shiftKey;
    }
  };

  const onMove = (e: PointerEvent) => {
    grab.current?.move(e);
    const d = draw.current;
    if (!d) {
      if (e.pointerType === "mouse") setHover(hitAt(shapes, pointAt(e.clientX, e.clientY), zoom, kind === "pen")?.id ?? null);
      return;
    }
    if (e.pointerId !== d.pointerId) return;
    if (!d.started && Math.hypot(e.clientX - d.x, e.clientY - d.y) >= d.threshold) d.started = true;
    if (!d.started && !d.points) return; // the pen keeps its points from the press (an accent, a dot)
    follow(d, e);
    if (!frameReq.current) {
      frameReq.current = requestAnimationFrame(() => {
        frameReq.current = 0;
        if (draw.current === d) setDrawn(shapeOf(d));
      });
    }
  };

  const onUp = (e: PointerEvent) => {
    grab.current?.up(e);
    const d = draw.current;
    if (!d || e.pointerId !== d.pointerId) return;
    if (d.started || d.points) follow(d, e);
    stopDraw();
    // A click or a tap: onClick decides (select, deselect, a default shape); the pen's off every
    // stroke's ink (next to one too) is a dot.
    if (!d.started && (!d.points || selectedShape.peek() || hitAt(shapes, d.start, zoom, true))) return;
    // Its click, if one comes (a touch tap's can come after a timer would have run), is no click;
    // the next press clears it (onDown).
    drew.current = true;
    // A pen stroke or a highlight is not selected: the next one follows it.
    place(shapeOf(d), !d.points && d.tool !== "highlight");
  };

  const onCancel = (e: PointerEvent) => {
    grab.current?.cancel(e);
    if (draw.current?.pointerId === e.pointerId) stopDraw();
  };

  // --- Clicks and taps ------------------------------------------------------------------------------

  /** A click or tap on no shape, with the page's lines `read`: a text line highlighted, else the selection dropped, else (touch) a default shape. */
  const clickAway = (p: Point, touch: boolean, read: readonly LineInfo[] | null) => {
    const box = kind === "highlight" ? lineBoxAt(read, p) : null;
    if (box) {
      place(newShape("highlight", lineHighlight(box, page.bounds)), false);
      return;
    }
    if (selectedShape.peek()) {
      void deselectShape(); // a click away drops the selection first
      return;
    }
    if (!touch || kind === "pen") return; // with a mouse: drag (the hint says so)
    const points = defaultPoints(kind === "arrow" ? "line" : kind, p, page.bounds);
    if (points) place(newShape(kind, points as [number, number][]));
  };

  const onClick = (e: MouseEvent) => {
    // A double click's second: no second shape (a highlight written twice, stacked) while the first
    // is written. With a mouse only: a phone counts two quick taps on neighbouring lines as one too.
    if (drew.current || (e.detail >= 2 && lastPointer.current === "mouse")) return;
    const p = pointAt(e.clientX, e.clientY);
    const touch = lastPointer.current !== "mouse";
    // A finger reaches 22 px, but on a text line with the highlighter only a shape's own stroke:
    // a tap is the only way to highlight a line on touch.
    const onLine = touch && kind === "highlight" && lineBoxAt(lines, p) !== null;
    const hit = hitAt(shapes, p, zoom, kind === "pen", !touch ? undefined : onLine ? 0 : HIT_PX_TOUCH);
    if (hit) {
      select(hit.id);
      return;
    }
    if (kind === "highlight" && !lines) {
      // The lines are not read yet (the first time on this page): the click waits for them.
      void ensureLines(page).then(() => {
        if (shapeKind.peek() !== "highlight" || !shapesMode.peek()) return;
        const read = page.lines.peek();
        clickAway(p, touch, read?.rev === page.rev.peek() ? read.lines : null);
      });
      return;
    }
    clickAway(p, touch, lines);
  };

  return (
    <div ref={layer} class={kind === "pen" ? "shapes-layer is-pen" : "shapes-layer"}>
      <div
        // (over the selected shape, a press moves it: a line's frame lets presses through to here)
        class={hover === null ? "shapes-catcher" : hover === selectedId ? "shapes-catcher is-over is-selected" : "shapes-catcher is-over"}
        aria-hidden="true"
        onClick={onClick}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onCancel}
        onLostPointerCapture={onCancel}
        onPointerLeave={() => setHover(null)}
      />
      {placed.map((p) => <ShapeSvg key={p.key} page={page} shape={p.shape} />)}
      {drawn && <ShapeSvg page={page} shape={drawn} />}
      {shapes.map((info) => (info.id === selected?.id
        ? (
          <SelectedShape
            key={`selected-${info.id}`}
            page={page}
            zoom={zoom}
            info={info}
            waiting={fresh === null}
            canvasRev={canvasRev}
            shapes={shapes}
            grab={grab}
          />
        )
        : <ShapeBox key={info.id} page={page} zoom={zoom} info={info} hover={hover === info.id} onSelect={() => select(info.id)} />))}
      <span class="sr-only" role="status">{said && said.pageIndex === page.index && said.id > seen && <span key={said.id}>{said.text}</span>}</span>
    </div>
  );
}
