// Edit mode overlay of one page's images: every placement as a box (a real button) over the part
// of it that shows, and, over the selected one, a frame that follows the picture (rotated,
// flipped or skewed too), with its handles and its context bar (Replace, Rotate, Delete,
// Deselect).
//
// The boxes stack below the text lines, so a line drawn over a picture can still be clicked;
// the frame and its bar stack above them (viewer.css). On touch screens the boxes and the frame
// keep the page's own one-finger scrolling, even over a full-page scan: there a picture moves
// by its round grip (in the middle, or just below a picture too small to hold it beside its
// corners), and its corner and rotation handles are the only parts that take a finger. A second
// finger cancels a gesture (the picture goes back), so the pinch zoom of gestures.ts still works,
// and no gesture starts until every finger has lifted. With a mouse (or a fine pointer) the whole
// frame drags, and edge handles stretch one side. The rotation knob sits above the picture, or
// below it when above it could not be reached (a picture at the top of the first page).
//
// During a gesture nothing is written: the frame follows the pointer, a dashed ghost marks where
// the picture was, and its sprite (the picture alone, from the engine) is drawn at the new
// place. Releasing writes one edit; while it is written the frame keeps the new place, and the
// sprite stays until the page's canvas shows the edit. Keyboard moves, stretches, scales and
// turns add up the same way and are written as one edit 600 ms after the last key, or at once
// when the selection changes or the app needs it (registerEditor: downloads, undo, leaving edit
// mode...). The bar's move and size buttons (ui/NudgeControls.tsx, the way that needs no
// dragging) are the arrow and + − keys by other means: they add up with them, the frame moves at
// once, and the same pause writes it all as one edit. The frame is an "application" for screen
// readers, so its keys reach it; after each change is written, its status region says where the
// picture now is.
//
// The selection survives its own edit (transform and replace keep the image's index): the frame
// stays mounted while the page's images are read again, so it keeps the keyboard focus. When it
// goes, a focus it had goes back to the image's box, or to the scroller when the page changed.
// The boxes too stay as they were while the images are read again after any change of the page
// (an edit, an undo or redo), as the canvas does until it is drawn again, so a focused box keeps
// the focus (they are keyed by the image's index; until the images are fresh, a box selects
// nothing); a box that goes while it has the focus (its picture deleted or undone) hands it to
// the scroller, never to <body>.
// While any image edit waits or runs (imageEditsPending: a Delete queued behind a download, say)
// the frame shows as pending and takes no gesture, key or click.
//
// Wherever the text writer is on (Compila e firma, and Modifica with Aggiungi testo) the layer
// shows only the pictures the user added (only="added": signatures, initials, photos), stacked
// above the form fields (viewer.css) and named by what they are ("Firma: Mario Rossi", else
// "Immagine N" counting those pictures only), lets taps through to the fill layer under it
// everywhere else, and its context bar may carry one more action ("On every page…" on the
// initials placed last: extraAction); nothing there depends on which of the two tools is on. A
// frame that comes with a new selection takes the keyboard focus unless the user is typing
// somewhere (a form field, the text writer): a signature landing never pulls the focus (and a
// phone's keyboard) out of what is being filled. The app's focusRequest for an image of the page
// is taken here too. When Modifica's sub-tool (or the tool) changes, this layer and the full one
// swap: a box with the focus hands it to the same picture's box in the other one, else to the
// scroller (the action that changed it sees to that first: ui/actions.ts, focusAfterLayers).
import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import {
  MAX_IMAGE_SIDE, MIN_IMAGE_SIDE, type ImageInfo, type ImageRenderResult, type Matrix, type Rect,
} from "../engine/protocol";
import { formatMm, t } from "../i18n";
import {
  busy, devicePixelRatio, focusRequest, imageEditsPending, registerEditor, selectedImage, sessionSignatures,
} from "../state";
import { chooseReplacement, deleteImage, lockReasonText, selectImage, transformImage } from "../ui/actions";
import { rescueFocus, viewerScroller } from "../ui/focus";
import { IconDeselect, IconImage, IconMove, IconRotate, IconTrash } from "../ui/icons";
import { isCoarse } from "../ui/media";
import { NudgeControls, nudgeOpen } from "../ui/NudgeControls";
import { addedDescription, honourFocusRequest, mayTakeFocus } from "./added";
import {
  beyondEdge, boundsOf, centre, clampCentre, corners, cssBox, handlePoint, nearlyEqual, pagePoint, previewTransform,
  resize, rotate90, rotateAbout, rotateTo, rotationDeg, scaleAbout, sides, stretchOnScreen, translateBy,
  type Handle, type Point,
} from "./imageGeometry";
import { ensureImages, loadSprite, releaseSprite } from "./images";
import type { PageModel } from "./model";

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

const CORNERS: Handle[] = ["nw", "ne", "se", "sw"];
const EDGES: Handle[] = ["n", "e", "s", "w"];
/** Standard resize cursors by the handle's direction from the centre, in 45° steps from "east". */
const RESIZE_CURSORS = ["ew-resize", "nwse-resize", "ns-resize", "nesw-resize"];
const ARROWS: Record<string, Point> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

/**
 * A pointer must travel this far (px) before a press becomes a drag: a mouse a little, a finger
 * or a pen as far as a browser's own touch slop, so that a tap that drifts is still a tap.
 */
const DRAG_THRESHOLD_MOUSE = 3;
const DRAG_THRESHOLD_TOUCH = 10;
/** Keyboard changes are written this long (ms) after the last key. */
const KEY_COMMIT_DELAY = 600;
/** Arrow keys move by 1 pt, Shift + arrow keys by 10 pt; with Alt they stretch by as much. */
const NUDGE = 1;
const NUDGE_FAR = 10;
/** Comma and full stop turn by 1°, with Shift by 15°. */
const TURN = 1;
const TURN_FAR = 15;
/** + and − scale by 5 % about the centre. */
const SCALE_STEP = 1.05;
/** No side is made shorter than this on screen (px), nor shorter than MIN_IMAGE_SIDE in points. */
const MIN_SIDE_PX = 8;
/** Edge handles show only on sides at least this long on screen (px): on shorter ones they would crowd the corners. */
const EDGE_HANDLE_MIN = 48;
/** Distance (px) from the top edge to the rotation knob: --image-stem in viewer.css. */
const STEM_FINE = 24;
const STEM_COARSE = 32;
/** Half the rotation knob's target (px): 20 px with a mouse, 44 px on touch (viewer.css). */
const KNOB_REACH_FINE = 10;
const KNOB_REACH_COARSE = 22;
/** Touch: the grip and the corner targets are 44 px; under twice that a side has no room for the grip between its corners. */
const TOUCH_TARGET = 44;
const GRIP_INSIDE_MIN = 2 * TOUCH_TARGET;
/** Touch, a small picture: from its bottom edge to the grip's centre (clear of the corner targets), and to the knob below the grip (viewer.css). */
const GRIP_OUTSIDE = 48;
const STEM_PAST_GRIP = 96;
/** Room (px) the visible handles and the knob take around the picture, kept clear of the context bar. */
const HANDLE_ROOM_FINE = 8;
const HANDLE_ROOM_COARSE = 12;
/** Room (px) the grip takes around its centre (its white ring included). */
const GRIP_ROOM = 24;
/** Space between the selection (handles included) and the context bar. */
const BAR_GAP = 8;
/** Closest the context bar comes to the sides of the viewport when it is moved to stay in view. */
const VIEW_EDGE = 8;
/** Space between the items of the context bar (.context-bar's gap in viewer.css). */
const BAR_ITEM_GAP = 4;
/** Before the bar is measured: on narrower pages it shows its icons only (each keeps its name and tooltip). */
const LABELS_MIN_PAGE = 440;
/** Pixel budget of a sprite (the engine keeps it within 4 000 000 pixels too). */
const SPRITE_PIXELS = window.matchMedia("(pointer: coarse)").matches ? 2_000_000 : 4_000_000;
/** A sprite at another zoom is asked for once the zoom has been still this long (ms). */
const SPRITE_DELAY = 150;
/** How long (ms) a box that had the focus is waited for after a keyboard edit, before giving up on it. */
const FOCUS_BACK_WAIT = 3000;

/** Width and height in millimetres (one decimal below 10 mm), for the labels. */
function sizeMm(m: Matrix) {
  const { width, height } = sides(m);
  return { w: formatMm(width), h: formatMm(height) };
}

/** Where the picture is, in words: what the status region says after a change is written. */
function placedText(page: PageModel, m: Matrix): string {
  const [x0, y0] = boundsOf(m);
  return t("image.status.placed", {
    ...sizeMm(m),
    x: formatMm(x0 - page.bounds[0]),
    y: formatMm(y0 - page.bounds[1]),
    deg: Math.round(rotationDeg(m)) % 360,
  });
}

/** Rect (page space) → px inside the page element. */
function rectBox(page: PageModel, [x0, y0, x1, y1]: Rect, zoom: number): Box {
  return {
    left: (x0 - page.bounds[0]) * zoom,
    top: (y0 - page.bounds[1]) * zoom,
    width: Math.max(1, (x1 - x0) * zoom),
    height: Math.max(1, (y1 - y0) * zoom),
  };
}

const px = (b: Box) => ({ left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px` });

/** Style of an element that covers the picture's quad exactly (see cssBox). */
function quadStyle(page: PageModel, m: Matrix, zoom: number) {
  const b = cssBox(m, [page.bounds[0], page.bounds[1]], zoom);
  return { ...px(b), transform: b.transform };
}

/** The standard resize cursor closest to the direction of `handle` from the centre, as the picture is now. */
function resizeCursor(m: Matrix, handle: Handle): string {
  const [cx, cy] = centre(m);
  const [x, y] = handlePoint(m, handle);
  const deg = ((Math.atan2(y - cy, x - cx) * 180) / Math.PI + 360) % 180;
  return RESIZE_CURSORS[Math.round(deg / 45) % 4];
}

/**
 * Every number finite, and each side kept within what the engine accepts (the same rule as its
 * own): not made shorter than `minSide` unless it already was (it then does not shrink), nor
 * longer than MAX_IMAGE_SIDE unless it already was (it then does not grow). So a picture that is
 * already smaller or larger can still be moved, turned and stretched along its other side.
 */
function acceptable(m: Matrix, base: Matrix, minSide: number): boolean {
  if (!m.every(Number.isFinite)) return false;
  const s = sides(m);
  const b = sides(base);
  const fits = (side: number, was: number) =>
    side >= Math.min(minSide, was) - 1e-6 && side <= Math.max(MAX_IMAGE_SIDE, was) + 1e-6;
  return fits(s.width, b.width) && fits(s.height, b.height);
}

/** Pixels per point for the sprite: as sharp as the screen, within its pixel budget, to 1/1000 (never 0). */
function spriteScale(image: ImageInfo, zoom: number, ratio: number): number {
  const [x0, y0, x1, y1] = image.visible;
  const area = Math.max(1, (x1 - x0) * (y1 - y0));
  const scale = Math.min(zoom * ratio, Math.sqrt(SPRITE_PIXELS / area));
  return Math.max(1, Math.floor(scale * 1000)) / 1000;
}

/** Where the frame's knob and (touch) grip go, and which edge handles it shows. */
interface FrameLayout {
  /** The rotation knob is below the picture: above it, it could not be reached. */
  knobBelow: boolean;
  /** Touch: the grip is below the picture, which has no room for it between its corner targets. */
  gripOutside: boolean;
  /** Mouse: the n and s handles (on the top and bottom edges), and the e and w ones. */
  edgesH: boolean;
  edgesV: boolean;
}

/** The rotation knob's position (page space) for `layout`. */
function knobPoint(m: Matrix, zoom: number, coarse: boolean, layout: Pick<FrameLayout, "knobBelow" | "gripOutside">): Point {
  const stem = coarse ? STEM_COARSE : STEM_FINE;
  if (!layout.knobBelow) return beyondEdge(m, "top", stem / zoom);
  return beyondEdge(m, "bottom", (layout.gripOutside ? STEM_PAST_GRIP : stem) / zoom);
}

/**
 * Where the knob and the grip go for the picture at `m`, and which edge handles show. The grip
 * goes below a picture that is too small on screen to hold it clear of the corner targets. The
 * knob goes below the picture when, above it, its target would stick out of the page at the top
 * or the left: the scroll content ends a few pixels past the first page's top and the pages' left
 * edge, so it might not be reachable there (below or right of a page there is always room to
 * scroll to). Edge handles show only on sides long enough not to crowd the corners.
 */
function frameLayout(page: PageModel, m: Matrix, zoom: number, coarse: boolean): FrameLayout {
  const { width, height } = sides(m);
  const gripOutside = coarse && Math.min(width * zoom, height * zoom) < GRIP_INSIDE_MIN;
  const reach = coarse ? KNOB_REACH_COARSE : KNOB_REACH_FINE;
  const sticksOut = (knobBelow: boolean) => {
    const [x, y] = knobPoint(m, zoom, coarse, { knobBelow, gripOutside });
    return (x - page.bounds[0]) * zoom - reach < 0 || (y - page.bounds[1]) * zoom - reach < 0;
  };
  return {
    knobBelow: sticksOut(false) && !sticksOut(true),
    gripOutside,
    edgesH: !coarse && width * zoom >= EDGE_HANDLE_MIN,
    edgesV: !coarse && height * zoom >= EDGE_HANDLE_MIN,
  };
}

/**
 * The box (px inside the page) that the selection takes on screen: the picture's quad, the
 * rotation knob, the grip when it is outside the picture and the room of the visible handles.
 * The context bar keeps clear of it.
 */
function selectionExtent(page: PageModel, m: Matrix, zoom: number, coarse: boolean, layout: FrameLayout): Box {
  const toPx = ([x, y]: Point): Point => [(x - page.bounds[0]) * zoom, (y - page.bounds[1]) * zoom];
  const points = [...corners(m), knobPoint(m, zoom, coarse, layout)].map(toPx);
  const room = coarse ? HANDLE_ROOM_COARSE : HANDLE_ROOM_FINE;
  let left = Math.min(...points.map((p) => p[0])) - room, right = Math.max(...points.map((p) => p[0])) + room;
  let top = Math.min(...points.map((p) => p[1])) - room, bottom = Math.max(...points.map((p) => p[1])) + room;
  if (layout.gripOutside) {
    const [gx, gy] = toPx(beyondEdge(m, "bottom", GRIP_OUTSIDE / zoom));
    left = Math.min(left, gx - GRIP_ROOM);
    right = Math.max(right, gx + GRIP_ROOM);
    top = Math.min(top, gy - GRIP_ROOM);
    bottom = Math.max(bottom, gy + GRIP_ROOM);
  }
  return { left, top, width: right - left, height: bottom - top };
}

// --- Touches -----------------------------------------------------------------------------------
// Fingers down anywhere in the window, so that a finger landing on a handle while another one is
// down (a pinch beginning) starts nothing. Tracked from the first selection on, for good.

const touchesDown = new Set<number>();
let trackingTouches = false;

function trackTouches() {
  if (trackingTouches) return;
  trackingTouches = true;
  const options = { capture: true, passive: true };
  window.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch") return;
    // The first finger of a new touch: every other one has lifted (also one whose end was missed).
    if (e.isPrimary) touchesDown.clear();
    touchesDown.add(e.pointerId);
  }, options);
  const end = (e: PointerEvent) => {
    if (e.pointerType === "touch") touchesDown.delete(e.pointerId);
  };
  window.addEventListener("pointerup", end, options);
  window.addEventListener("pointercancel", end, options);
}

/** A finger other than `pointerId` is down. */
const otherTouchDown = (pointerId: number) => [...touchesDown].some((id) => id !== pointerId);

// --- Focus -------------------------------------------------------------------------------------

/**
 * A change is about to be written while the focus is on a line or image box of the page (Shift+Tab
 * from the frame lands on one; Enter on a line box writes a waiting keyboard change first): the
 * write reads the page's boxes again, and the focused one goes meanwhile. Once they are back, the
 * focus goes back to the same box; when it is not there, to the selection frame, else to the
 * scroller, so that it never stays on <body>.
 */
function keepBoxFocus(page: PageModel, pageEl: Element) {
  const box = document.activeElement;
  if (!(box instanceof HTMLElement) || !pageEl.contains(box)) return;
  const { image, line } = box.dataset;
  if (image === undefined && line === undefined) return;
  const selector = image !== undefined ? `[data-image="${image}"]` : `[data-line="${line}"]`;
  const cached = image !== undefined ? page.images : page.lines;
  const scroller = pageEl.closest<HTMLElement>(".scroller");
  const until = performance.now() + FOCUS_BACK_WAIT;
  let backFor = 0; // frames since the boxes were read again
  const step = () => {
    const now = document.activeElement;
    if (now && now !== document.body) {
      // Still on the box (the page has not changed yet, or the edit was refused): wait on, a while.
      if (now === box && performance.now() < until) requestAnimationFrame(step);
      return; // or the user went somewhere else
    }
    if (!pageEl.isConnected) return; // the document was closed
    if (cached.peek()?.rev === page.rev.peek()) backFor++;
    const again = backFor > 0 ? pageEl.querySelector<HTMLElement>(selector) : null;
    if (again) {
      again.focus({ preventScroll: true });
      return;
    }
    // Wait for the boxes (and a frame after them, for the page to show them); then give up on this one.
    if (backFor < 2 && performance.now() < until) {
      requestAnimationFrame(step);
      return;
    }
    (pageEl.querySelector<HTMLElement>(".image-frame") ?? scroller)?.focus({ preventScroll: true });
  };
  requestAnimationFrame(step);
}

type GestureKind = "move" | "resize" | "rotate";

interface Gesture {
  kind: GestureKind;
  handle: Handle | null;
  pointerId: number;
  /** The element holding the pointer capture. */
  el: Element;
  /** How far (px) the pointer must travel before the press becomes a drag. */
  threshold: number;
  /** Where the press was (client px) and the page point under it. */
  startX: number;
  startY: number;
  start: Point;
  /** Resize: from the pointer to the handle's exact point, so the handle does not jump to the pointer. */
  grab: Point;
  /** The matrix when the gesture began. */
  m0: Matrix;
  /** Past the drag threshold. */
  started: boolean;
  /** The latest pointer position and Shift state. */
  x: number;
  y: number;
  shift: boolean;
  /** The latest acceptable target. */
  target: Matrix;
  /** Removes the window listeners added for this gesture. */
  off: () => void;
}

interface SpriteState {
  result: ImageRenderResult;
  /** Where the picture was when it was rendered. */
  from: Matrix;
  /** The page revision it was rendered at: after a Replace, the old one shows another picture. */
  rev: number;
}

/** The picture alone on a transparent bitmap, drawn at `to` while it is moved (hidden otherwise). */
function Sprite({ page, zoom, sprite, to }: {
  page: PageModel;
  zoom: number;
  sprite: SpriteState;
  to: Matrix | null;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  // Drawn once per sprite: the canvas keeps its own copy, so the cached bitmap may be closed later.
  useLayoutEffect(() => {
    const c = canvas.current;
    const { bitmap, width, height } = sprite.result;
    if (!c) return;
    c.width = width;
    c.height = height;
    try {
      c.getContext("2d")?.drawImage(bitmap, 0, 0);
    } catch {
      // Closed meanwhile (replaced by a newer sprite): an empty sprite, the frame still moves.
    }
  }, [sprite]);
  const rect = sprite.result.rect;
  const style = to ? { ...px(rectBox(page, rect, zoom)), transform: previewTransform(rect, sprite.from, to, zoom) } : undefined;
  return <canvas ref={canvas} class="image-sprite" aria-hidden="true" hidden={!to} style={style} />;
}

/** One more button in the selected image's context bar (before Deselect). */
export interface ImageAction {
  id: string;
  label: string;
  tip: string;
  icon: ComponentChildren;
  onClick: () => void;
}

interface SelectedProps {
  page: PageModel;
  zoom: number;
  image: ImageInfo;
  /** The page revision `image` was read at. */
  imageRev: number;
  /** The page's images are being read again after an edit: `image` is the last known one. */
  waiting: boolean;
  /** The page revision the page's canvas shows. */
  canvasRev: number;
  /** The extra action for this image, if any. */
  extra: ImageAction | null;
  /** What the picture is, for its name ("Firma: Mario Rossi"), or null; and its number for "Immagine N". */
  name: string | null;
  n: number;
}

function SelectedImage({ page, zoom, image, imageRev, waiting, canvasRev, extra, name, n }: SelectedProps) {
  const frame = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const measureMark = useRef<HTMLSpanElement>(null);
  const coarse = isCoarse.value;
  const ratio = devicePixelRatio.value;

  /** Where a gesture or the keyboard is taking the picture (shown, not written yet). */
  const [live, setLive] = useState<Matrix | null>(null);
  /** The target being written, and the image it was written for (until the canvas shows it). */
  const [committed, setCommitted] = useState<{ matrix: Matrix; from: ImageInfo } | null>(null);
  const [writing, setWriting] = useState(false);
  /** The pointer gesture under way, past its threshold (hides the context bar). */
  const [dragging, setDragging] = useState<GestureKind | null>(null);
  const [sprite, setSprite] = useState<SpriteState | null>(null);
  /** Context bar position worked out from the screen: top (px in the page) and sideways shift. */
  const [placed, setPlaced] = useState<{ top: number; below: boolean; nudge: number } | null>(null);
  /**
   * What the bar has room for, on the page and on screen (measured): its buttons' labels, and the
   * words "Writing…" beside them while an edit is written (else the spinner alone).
   */
  const [fit, setFit] = useState(() => {
    const wide = page.width * zoom >= LABELS_MIN_PAGE;
    return { labels: wide, writing: wide };
  });
  /** What the status region says once nothing is being written: where the picture went. */
  const [announce, setAnnounce] = useState("");

  const gesture = useRef<Gesture | null>(null);
  /** A cancelled gesture's pointer, still down: it keeps its capture, and its events are ignored. */
  const cancelledPointer = useRef<number | null>(null);
  const frameReq = useRef(0);
  const keyTarget = useRef<Matrix | null>(null);
  const keyTimer = useRef(0);
  const inflight = useRef<Promise<void> | null>(null);
  const unregister = useRef<(() => void) | null>(null);

  const pending = writing || waiting || busy.value === "edit" || imageEditsPending.value > 0;
  // The latest values, for handlers that outlive a render (timers, window listeners, registerEditor).
  const latest = useRef({ image, imageRev, zoom, pending });
  latest.current = { image, imageRev, zoom, pending };

  const shown = live ?? committed?.matrix ?? image.matrix;
  const minSide = () => Math.max(MIN_IMAGE_SIDE, MIN_SIDE_PX / latest.current.zoom);

  const dropRegistration = () => {
    unregister.current?.();
    unregister.current = null;
  };

  /** Write `target` as one edit (a release, the keyboard's pause, Rotate). */
  const commit = (target: Matrix): Promise<void> => {
    if (inflight.current) return inflight.current;
    clearTimeout(keyTimer.current);
    keyTimer.current = 0;
    keyTarget.current = null;
    const { image: img, imageRev: rev } = latest.current;
    if (nearlyEqual(target, img.matrix)) {
      setLive(null);
      dropRegistration();
      return Promise.resolve();
    }
    const before = page.rev.peek();
    const pageEl = frame.current?.closest(".page");
    if (pageEl) keepBoxFocus(page, pageEl);
    setCommitted({ matrix: target, from: img });
    setLive(null);
    setWriting(true);
    const run = transformImage(page, img, target, rev)
      .catch((e: unknown) => console.error(e))
      .then(() => {
        inflight.current = null;
        setWriting(false);
        // Refused or failed: the picture is where it was. Otherwise the target stays shown until
        // the images are read again and the canvas shows the edit, and the status says where it is.
        if (page.rev.peek() === before) setCommitted(null);
        else setAnnounce(placedText(page, target));
        dropRegistration();
      });
    inflight.current = run;
    return run;
  };

  /** Write what the keyboard has done so far (also what flushEditor calls). */
  const flushKeys = (): Promise<void> => {
    if (inflight.current) return inflight.current;
    const target = keyTarget.current;
    if (!target) {
      dropRegistration();
      return Promise.resolve();
    }
    return commit(target);
  };

  /** Drop what the keyboard has done (Delete and Replace work on the picture as it is). */
  const dropKeys = () => {
    clearTimeout(keyTimer.current);
    keyTimer.current = 0;
    keyTarget.current = null;
    setLive(null);
    dropRegistration();
  };

  /** A keyboard change: shown at once, written after a pause. */
  const keyChange = (change: (m: Matrix) => Matrix) => {
    const base = keyTarget.current ?? latest.current.image.matrix;
    const next = clampCentre(change(base), page.bounds);
    if (!acceptable(next, base, minSide())) return;
    keyTarget.current = next;
    setLive(next);
    if (!unregister.current) {
      unregister.current = registerEditor({ changed: () => true, commit: () => flushKeys() });
    }
    clearTimeout(keyTimer.current);
    keyTimer.current = window.setTimeout(() => void flushKeys(), KEY_COMMIT_DELAY);
  };

  // --- Pointer gestures ------------------------------------------------------------------------

  const pagePointAt = (x: number, y: number): Point => {
    const pageEl = frame.current?.closest<HTMLElement>(".page");
    const r = pageEl?.getBoundingClientRect() ?? { left: 0, top: 0 };
    return pagePoint(x, y, r, [page.bounds[0], page.bounds[1]], latest.current.zoom);
  };

  const targetOf = (g: Gesture): Matrix => {
    const p = pagePointAt(g.x, g.y);
    let next: Matrix;
    if (g.kind === "move") {
      next = translateBy(g.m0, p[0] - g.start[0], p[1] - g.start[1]);
    } else if (g.kind === "resize" && g.handle) {
      const keepAspect = CORNERS.includes(g.handle) && !g.shift;
      next = resize(g.m0, g.handle, [p[0] + g.grab[0], p[1] + g.grab[1]], { keepAspect, minSide: minSide() });
    } else {
      next = rotateTo(g.m0, g.start, p, { snap: g.shift });
    }
    next = clampCentre(next, page.bounds);
    return acceptable(next, g.m0, minSide()) ? next : g.target;
  };

  const update = () => {
    frameReq.current = 0;
    const g = gesture.current;
    if (!g || !g.started) return;
    g.target = targetOf(g);
    setLive(g.target);
  };

  const onWindowKey = (e: KeyboardEvent) => {
    const g = gesture.current;
    if (!g) return;
    if (e.type === "keydown" && e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation(); // only the gesture is cancelled: not the selection, not edit mode
      cancelGesture();
    } else if (e.key === "Shift" && g.shift !== (e.type === "keydown")) {
      g.shift = e.type === "keydown";
      if (g.started && !frameReq.current) frameReq.current = requestAnimationFrame(update);
    }
  };

  // A second finger (a pinch beginning) or another pointer: give the gesture up.
  const onWindowPointerDown = (e: PointerEvent) => {
    const g = gesture.current;
    if (g && e.pointerId !== g.pointerId) cancelGesture();
  };

  /**
   * End the gesture. A finished one gives its pointer capture back. A cancelled one whose pointer
   * is still down keeps it until that pointer lifts, ignoring its events meanwhile: the click
   * that follows then lands on the frame (not on the page, which would deselect), and the
   * scroller, which holds the frame, still sees the finger lift (gestures.ts counts fingers).
   */
  const endGesture = (how: "done" | "cancelled" | "gone"): Gesture | null => {
    const g = gesture.current;
    if (!g) return null;
    gesture.current = null;
    if (frameReq.current) cancelAnimationFrame(frameReq.current);
    frameReq.current = 0;
    g.off();
    if (how === "cancelled") {
      cancelledPointer.current = g.pointerId;
    } else {
      try {
        if (g.el.hasPointerCapture(g.pointerId)) g.el.releasePointerCapture(g.pointerId);
      } catch {
        // The pointer is gone already.
      }
    }
    setDragging(null);
    return g;
  };

  /** Escape, a second finger, a cancelled pointer: back to where the picture was (or the keyboard had it). */
  function cancelGesture(pointerGone = false) {
    if (!endGesture(pointerGone ? "gone" : "cancelled")) return;
    setLive(keyTarget.current);
    if (keyTarget.current) keyTimer.current = window.setTimeout(() => void flushKeys(), KEY_COMMIT_DELAY);
  }

  const startGesture = (e: PointerEvent, kind: GestureKind, handle: Handle | null) => {
    if (gesture.current || latest.current.pending) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    // Only the first finger (or the mouse, or a pen), and never while another finger is down: a
    // pinch that lands on a handle zooms, and moves nothing.
    if (!e.isPrimary || (e.pointerType === "touch" && otherTouchDown(e.pointerId))) return;
    const el = e.currentTarget as Element;
    if (e.pointerType === "mouse") e.preventDefault(); // no text selection, no native drag
    frame.current?.focus({ preventScroll: true });
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      return; // the pointer is already gone
    }
    // A pending keyboard change is part of this gesture: it is written with it.
    clearTimeout(keyTimer.current);
    keyTimer.current = 0;
    const m0 = keyTarget.current ?? latest.current.image.matrix;
    const start = pagePointAt(e.clientX, e.clientY);
    const at = handle ? handlePoint(m0, handle) : start;
    // These very functions are removed at the end (later renders make new ones).
    const onKey = onWindowKey;
    const onDown = onWindowPointerDown;
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    window.addEventListener("pointerdown", onDown, true);
    cancelledPointer.current = null;
    gesture.current = {
      kind, handle, pointerId: e.pointerId, el,
      threshold: e.pointerType === "mouse" ? DRAG_THRESHOLD_MOUSE : DRAG_THRESHOLD_TOUCH,
      startX: e.clientX, startY: e.clientY, start, grab: [at[0] - start[0], at[1] - start[1]],
      m0, started: false, x: e.clientX, y: e.clientY, shift: e.shiftKey, target: m0,
      off: () => {
        window.removeEventListener("keydown", onKey, true);
        window.removeEventListener("keyup", onKey, true);
        window.removeEventListener("pointerdown", onDown, true);
      },
    };
  };

  const onPointerMove = (e: PointerEvent) => {
    const g = gesture.current;
    if (!g || e.pointerId !== g.pointerId) return; // a cancelled gesture's pointer too
    g.x = e.clientX;
    g.y = e.clientY;
    g.shift = e.shiftKey;
    if (!g.started) {
      if (Math.hypot(g.x - g.startX, g.y - g.startY) < g.threshold) return;
      g.started = true;
      setDragging(g.kind);
    }
    if (!frameReq.current) frameReq.current = requestAnimationFrame(update);
  };

  const onPointerUp = (e: PointerEvent) => {
    if (e.pointerId === cancelledPointer.current) {
      cancelledPointer.current = null; // lifted: the browser gives its capture back
      return;
    }
    const g = gesture.current;
    if (!g || e.pointerId !== g.pointerId) return;
    g.x = e.clientX;
    g.y = e.clientY;
    g.shift = e.shiftKey;
    const started = g.started;
    if (started) g.target = targetOf(g);
    endGesture("done");
    if (!started) {
      // A press without a drag: a keyboard change waiting for it goes on waiting.
      if (keyTarget.current) keyTimer.current = window.setTimeout(() => void flushKeys(), KEY_COMMIT_DELAY);
      return;
    }
    void commit(g.target);
  };

  /** The pointer was cancelled by the browser, or its capture lost: the gesture is over. */
  const onPointerCancel = (e: PointerEvent) => {
    if (e.pointerId === cancelledPointer.current) {
      cancelledPointer.current = null;
      return;
    }
    const g = gesture.current;
    if (g && e.pointerId === g.pointerId) cancelGesture(true);
  };

  /** The frame itself: drags with a mouse anywhere, with any pointer on fine-pointer devices. */
  const onFrameDown = (e: PointerEvent) => {
    if (gesture.current) return; // a handle inside took it
    if (isCoarse.peek() && e.pointerType !== "mouse") return; // touch: the page scrolls
    startGesture(e, "move", null);
  };

  // --- Keyboard and context bar ----------------------------------------------------------------

  const deselect = () => void selectImage(page.index, null);

  const rotate = () => {
    if (latest.current.pending) return;
    const base = keyTarget.current ?? latest.current.image.matrix;
    void commit(clampCentre(rotate90(base), page.bounds));
  };

  const remove = () => {
    if (latest.current.pending) return;
    dropKeys();
    void deleteImage(page, latest.current.image, latest.current.imageRev);
  };

  const replace = () => {
    if (latest.current.pending) return;
    // A keyboard change not written yet is written first (chooseReplacement flushes it), so the
    // new picture goes into the box the user sees.
    chooseReplacement(page, latest.current.image, latest.current.imageRev);
  };

  const done = () => {
    if (!latest.current.pending) deselect();
  };

  const onFrameKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation(); // not also "leave edit mode" (ui/shortcuts.ts)
      if (gesture.current) cancelGesture();
      else deselect();
      return;
    }
    if (e.ctrlKey || e.metaKey) return; // Ctrl + / − zoom the document, Ctrl+Z undoes
    const dir = ARROWS[e.key];
    if (e.altKey && !dir) return; // Alt goes only with the arrows (stretch)
    // Comma and full stop by the key's place, so that Shift and the layout do not matter (by the
    // character only from keyboards that give no place, such as some on-screen ones).
    const code = e.code || (e.key === "," ? "Comma" : e.key === "." ? "Period" : "");
    const turn = code === "Comma" ? -1 : code === "Period" ? 1 : 0;
    const scale = e.key === "+" || e.key === "=" ? SCALE_STEP : e.key === "-" ? 1 / SCALE_STEP : 0;
    const del = e.key === "Delete" || e.key === "Backspace";
    if (!dir && !turn && !scale && !del) return;
    e.preventDefault(); // arrows must not scroll the page meanwhile, nor Alt + ← go back a page
    if (latest.current.pending || gesture.current) return;
    if (dir) {
      const step = e.shiftKey ? NUDGE_FAR : NUDGE;
      // As seen: → wider and ↓ taller on screen, also when the picture is turned a quarter.
      if (e.altKey) keyChange((m) => stretchOnScreen(m, dir[0] * step, dir[1] * step));
      else keyChange((m) => translateBy(m, dir[0] * step, dir[1] * step));
    } else if (turn) {
      const deg = turn * (e.shiftKey ? TURN_FAR : TURN);
      keyChange((m) => rotateAbout(m, centre(m), deg));
    } else if (scale) {
      keyChange((m) => scaleAbout(m, centre(m), scale));
    } else {
      remove();
    }
  };

  /** The bar's move and size buttons: what the arrow and + − keys do, by other steps. */
  const nudge = (dx: number, dy: number) => {
    if (!latest.current.pending && !gesture.current) keyChange((m) => translateBy(m, dx, dy));
  };
  const nudgeScale = (factor: number) => {
    if (!latest.current.pending && !gesture.current) keyChange((m) => scaleAbout(m, centre(m), factor));
  };

  const onBarKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation(); // not also "leave edit mode" (ui/shortcuts.ts)
      deselect();
      return;
    }
    // Toolbar pattern: the arrow keys move between its buttons.
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    const buttons = [...(bar.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    if (!buttons.length) return;
    e.preventDefault();
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const n = buttons.length;
    const next = e.key === "Home" ? 0 : e.key === "End" ? n - 1 : (i + (e.key === "ArrowRight" ? 1 : -1) + n) % n;
    buttons[next].focus();
  };

  // --- Placing the context bar -----------------------------------------------------------------

  // Where the knob and the grip go, and which edge handles show: kept as they were while a
  // gesture runs, so they do not jump to the other side under the pointer (nor does the handle
  // being dragged go away with its pointer capture).
  const layoutRef = useRef<FrameLayout | null>(null);
  const layout = dragging && layoutRef.current ? layoutRef.current : frameLayout(page, shown, zoom, coarse);
  layoutRef.current = layout;

  const extent = selectionExtent(page, shown, zoom, coarse, layout);
  const extentRef = useRef(extent);
  extentRef.current = extent;

  /**
   * Keep the context bar on screen and on the page: above the selection, else below it (each side
   * with room for the move buttons' row, also while it is closed), else (a
   * picture taller than the room there, such as a full-page scan) over the picture at the top of
   * what shows of it; shifted sideways when the selection starts near (or past) an edge of the
   * viewport. Its labels show only when the labelled bar fits on the page and on screen. Worked
   * out from the page's position, so it can run again after a scroll or a zoom.
   */
  const place = () => {
    const barEl = bar.current;
    const pageEl = frame.current?.closest<HTMLElement>(".page");
    const scroller = pageEl?.closest<HTMLElement>(".scroller");
    if (!barEl || !pageEl || !scroller) return;
    const s = scroller.getBoundingClientRect();
    const p = pageEl.getBoundingClientRect();
    // What is visible of the scroller: without its scrollbars, and (phones) within the visual viewport.
    const vv = window.visualViewport;
    const viewTop = Math.max(s.top, vv ? vv.offsetTop : -Infinity);
    const viewBottom = Math.min(s.top + scroller.clientHeight, vv ? vv.offsetTop + vv.height : Infinity);
    const viewLeft = Math.max(s.left, vv ? vv.offsetLeft : -Infinity);
    const viewRight = Math.min(s.left + scroller.clientWidth, vv ? vv.offsetLeft + vv.width : Infinity);
    const all = measure.current?.offsetWidth ?? 0;
    if (all > 0) {
      const room = Math.min(p.width, viewRight - viewLeft - 2 * VIEW_EDGE);
      const buttons = all - (measureMark.current?.offsetWidth ?? 0) - BAR_ITEM_GAP;
      const next = { labels: buttons <= room, writing: all <= room };
      setFit((prev) => (prev.labels === next.labels && prev.writing === next.writing ? prev : next));
    }
    const ext = extentRef.current;
    const extBottom = ext.top + ext.height;
    if (p.top + extBottom <= viewTop || p.top + ext.top >= viewBottom ||
      p.left + ext.left + ext.width <= viewLeft || p.left + ext.left >= viewRight) return;
    const h = barEl.offsetHeight;
    const w = barEl.offsetWidth;
    const pageH = p.height;
    const above = ext.top - BAR_GAP - h;
    const belowTop = extBottom + BAR_GAP;
    // The move buttons' row, closed: its room kept on the side it grows to, so opening it never
    // flips the bar; when neither side has that much, the sides are tried again without it (better
    // a flip than covering the picture).
    const toggle = barEl.querySelector<HTMLElement>(".nudge-toggle");
    const reserve = nudgeOpen.peek() || !toggle ? 0 : toggle.offsetHeight + BAR_ITEM_GAP;
    const fitsAbove = (more: number) => above - more >= 0 && p.top + above - more >= viewTop;
    const fitsBelow = (more: number) => belowTop + h + more <= pageH && p.top + belowTop + h + more <= viewBottom;
    let top: number;
    let below = false;
    if (fitsAbove(reserve) || (!fitsBelow(reserve) && fitsAbove(0))) {
      top = above;
    } else if (fitsBelow(reserve) || fitsBelow(0)) {
      top = belowTop;
      below = true;
    } else {
      const shownTop = Math.max(ext.top, viewTop - p.top);
      const shownBottom = Math.min(extBottom, viewBottom - p.top);
      top = Math.min(shownTop + BAR_GAP, shownBottom - BAR_GAP - h);
      top = Math.max(0, Math.min(top, pageH - h));
      below = true;
    }
    const wanted = p.left + ext.left;
    const left = Math.max(viewLeft + VIEW_EDGE, Math.min(wanted, viewRight - VIEW_EDGE - w));
    const next = { top: Math.round(top), below, nudge: Math.round(left - wanted) };
    setPlaced((prev) => (prev && prev.top === next.top && prev.below === next.below && prev.nudge === next.nudge ? prev : next));
  };
  const placeRef = useRef(place);
  placeRef.current = place;

  // --- Lifetime --------------------------------------------------------------------------------

  useLayoutEffect(() => {
    const el = frame.current;
    if (!el) return;
    trackTouches();
    // Not out of a form field or the text writer the user is typing in (a signature landing
    // while they type): there the frame waits for a click, a tap or Tab.
    if (mayTakeFocus()) el.focus({ preventScroll: true });
    const scroller = el.closest<HTMLElement>(".scroller");
    const viewport: EventTarget = window.visualViewport ?? window;
    let raf = 0;
    const onMove = () => {
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; placeRef.current(); });
    };
    scroller?.addEventListener("scroll", onMove, { passive: true });
    viewport.addEventListener("resize", onMove);
    viewport.addEventListener("scroll", onMove);
    // The bar's size changed (the move buttons' row shown or hidden): placed again before it is
    // drawn, so the row grows away from the picture and the bar's buttons stay where they were.
    const resized = new ResizeObserver(() => placeRef.current());
    if (bar.current) resized.observe(bar.current);
    return () => {
      resized.disconnect();
      scroller?.removeEventListener("scroll", onMove);
      viewport.removeEventListener("resize", onMove);
      viewport.removeEventListener("scroll", onMove);
      if (raf) cancelAnimationFrame(raf);
      cancelGesture();
      // A keyboard change not written yet is written now (its registration stays until it is in).
      void flushKeys();
      releaseSprite();
      // The frame (or its context bar) had the focus: keep it in the document instead of dropping
      // it to <body>. Back to the image's box when the page stays as it is; to the scroller when it
      // changed or is about to (an edit, undo or redo running). (Both are still in the page here.)
      const active = document.activeElement;
      if (active !== el && !(active && bar.current?.contains(active))) return;
      const pageEl = el.closest(".page");
      const index = latest.current.image.index;
      const unchanged = page.rev.peek() === latest.current.imageRev && busy.peek() === null;
      requestAnimationFrame(() => {
        const now = document.activeElement;
        if (now && now !== document.body) return; // something else took the focus meanwhile
        const box = unchanged ? pageEl?.querySelector<HTMLElement>(`[data-image="${index}"]`) : null;
        (box ?? scroller)?.focus({ preventScroll: true });
      });
    };
  }, []);

  // The selection moved, was resized, the zoom changed or the bar's texts did: place the bar again
  // (after the viewer has re-anchored the scroll on a zoom).
  const shownKey = shown.join(",");
  const labels = [t("image.replace"), t("image.rotate"), t("image.delete"), t("image.done")];
  const labelsKey = [...labels, extra?.label ?? "", t("image.writing")].join("|");
  useLayoutEffect(() => {
    if (dragging) return;
    const frameId = requestAnimationFrame(() => placeRef.current());
    placeRef.current();
    return () => cancelAnimationFrame(frameId);
  }, [shownKey, zoom, dragging, pending, labelsKey, fit]);

  // The images were read again after the edit: drop the committed target once the canvas shows it
  // (or will not: the page is far away).
  useEffect(() => {
    if (!committed || writing || waiting || image === committed.from) return;
    if (canvasRev === page.rev.peek() || !page.near.peek()) setCommitted(null);
  }, [committed, writing, waiting, image, canvasRev]);

  // The sprite, for the preview: when the image is selected (and after each edit, at once), and
  // again at a new zoom once it has been still a moment.
  const scale = spriteScale(image, zoom, ratio);
  const spriteRev = sprite?.rev;
  useEffect(() => {
    if (waiting) return;
    let cancelled = false;
    const from = image.matrix;
    const timer = setTimeout(() => {
      void loadSprite(page, image.index, imageRev, scale).then((result) => {
        if (!cancelled && result) setSprite({ result, from, rev: imageRev });
      });
    }, spriteRev === imageRev ? SPRITE_DELAY : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [page, image, imageRev, scale, waiting]);

  // --- Render ----------------------------------------------------------------------------------

  const moved = !nearlyEqual(shown, image.matrix);
  // While dragged, the picture moves only as the sprite of what the page shows now (after a
  // Replace, the old picture's sprite is not shown); while written, the sprite it was dragged with.
  const spriteTo = live ? (sprite?.rev === imageRev ? shown : null) : committed ? shown : null;
  const box = cssBox(shown, [page.bounds[0], page.bounds[1]], zoom);
  const helpId = `image-keys-${page.index}`;

  // Before the first measurement: above the selection if it fits on the page, else below, else over it.
  const barHeight = coarse ? 44 : 36; // as in viewer.css
  const pageHeight = page.height * zoom;
  const fallbackTop = extent.top - BAR_GAP - barHeight >= 0
    ? extent.top - BAR_GAP - barHeight
    : extent.top + extent.height + BAR_GAP + barHeight <= pageHeight
      ? extent.top + extent.height + BAR_GAP
      : Math.max(0, Math.min(extent.top + BAR_GAP, pageHeight - barHeight));
  const barTop = placed?.top ?? fallbackTop;
  const below = placed ? placed.below : barTop > extent.top;
  const indent = Math.max(0, extent.left + (placed?.nudge ?? 0));

  const frameClass = [
    "image-frame",
    pending && "is-pending",
    dragging && "is-dragging",
    dragging === "rotate" && "is-rotating",
  ].filter(Boolean).join(" ");
  // Touch: the corner targets reach into the picture at most this far (px), short of its middle.
  const reach = (side: number) => `${Math.max(0, Math.min(TOUCH_TARGET / 2, side / 2 - 2))}px`;
  const frameStyle = {
    ...px(box),
    transform: box.transform,
    ...(coarse ? { "--reach-x": reach(box.width), "--reach-y": reach(box.height) } : {}),
  };
  const knobClass = !layout.knobBelow
    ? "image-rotate"
    : layout.gripOutside ? "image-rotate is-below is-past-grip" : "image-rotate is-below";

  const handle = (which: Handle) => (
    <span
      key={which}
      class={`image-handle is-${which}`}
      style={{ cursor: resizeCursor(shown, which) }}
      title={t("image.handle.resize")}
      aria-hidden="true"
      onPointerDown={(e) => startGesture(e, "resize", which)}
    />
  );

  const runExtra = () => {
    if (!latest.current.pending) extra?.onClick();
  };
  const actions: (ImageAction & { primary?: boolean })[] = [
    { id: "replace", label: labels[0], tip: t("image.replaceTip"), icon: <IconImage />, onClick: replace },
    { id: "rotate", label: labels[1], tip: t("image.rotateTip"), icon: <IconRotate />, onClick: rotate },
    { id: "delete", label: labels[2], tip: t("image.deleteTip", { key: t("key.delete") }), icon: <IconTrash />, onClick: remove },
    ...(extra ? [{ ...extra, onClick: runExtra }] : []),
    { id: "done", label: labels[3], tip: t("image.doneTip", { key: t("key.esc") }), icon: <IconDeselect />, onClick: done, primary: true },
  ];
  const showLabels = fit.labels;
  const actionButton = (a: (typeof actions)[number]) => (
    <button
      type="button"
      key={a.id}
      class={`btn context-btn${a.primary ? " btn-primary" : ""}${showLabels ? "" : " is-icon"}`}
      title={a.tip}
      aria-label={showLabels ? undefined : a.label}
      aria-disabled={pending || undefined}
      onClick={a.onClick}
    >
      {a.icon}
      {showLabels && <span>{a.label}</span>}
    </button>
  );

  return (
    <>
      {sprite && <Sprite page={page} zoom={zoom} sprite={sprite} to={spriteTo} />}
      {moved && <div class="image-ghost" aria-hidden="true" style={quadStyle(page, image.matrix, zoom)} />}
      <div
        ref={frame}
        class={frameClass}
        style={frameStyle}
        tabIndex={0}
        // An application, so that screen readers pass its keys on (they would read on in a group).
        role="application"
        aria-roledescription={t("image.roleDescription")}
        aria-label={name
          ? t("image.namedLabel", { name, ...sizeMm(image.matrix) })
          : t("image.selectedLabel", { n, ...sizeMm(image.matrix) })}
        aria-describedby={helpId}
        aria-busy={pending}
        onPointerDown={onFrameDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onLostPointerCapture={onPointerCancel}
        onKeyDown={onFrameKeyDown}
      >
        {/* Handles first, so the knob and the grip stack above their touch targets (viewer.css). */}
        {EDGES.filter((edge) => (edge === "n" || edge === "s" ? layout.edgesH : layout.edgesV)).map(handle)}
        {CORNERS.map(handle)}
        <span
          class={knobClass}
          title={t("image.handle.rotate")}
          aria-hidden="true"
          onPointerDown={(e) => startGesture(e, "rotate", null)}
        />
        {coarse && (
          <span
            class={layout.gripOutside ? "image-grip is-outside" : "image-grip"}
            title={t("image.handle.move")}
            aria-hidden="true"
            onPointerDown={(e) => startGesture(e, "move", null)}
          >
            <IconMove />
          </span>
        )}
      </div>
      <span id={helpId} hidden>{t("image.keysHelp")}</span>
      {/* The slot spans the page; the indent before the bar shrinks so the bar stays on it. It
          stays in the page during a drag (only hidden), so its status region is there before
          "Writing…" fills it in, and the bar's buttons stay while an edit is written, so a focus
          on one of them stays there. */}
      <div class={["context-slot", below && "is-below", dragging && "is-hidden"].filter(Boolean).join(" ")} style={{ top: `${barTop}px` }}>
        <span class="context-indent" style={{ flexBasis: `${indent}px` }} />
        <div
          ref={bar}
          class="context-bar image-bar"
          role="toolbar"
          aria-label={t("image.toolbar")}
          onKeyDown={onBarKeyDown}
        >
          {actions.slice(0, 2).map(actionButton)}
          {/* The buttons after the toggle go before its row, which is drawn last (below the picture). */}
          <NudgeControls onMove={nudge} onScale={nudgeScale} disabled={pending}>
            {actions.slice(2).map(actionButton)}
          </NudgeControls>
          {/* "Writing…" beside the buttons (for screen readers it is in the status region). */}
          {pending && (
            <span class="context-writing" aria-hidden="true">
              <span class="spinner" />
              {fit.writing && t("image.writing")}
            </span>
          )}
        </div>
        {/* The bar with its labels and "Writing…", measured (never seen) to tell what fits. It
            sits in a box of no size that clips it, so that, wider than a phone's page, it does
            not widen what the page can be scrolled across. */}
        <div class="image-measure" aria-hidden="true">
          <div ref={measure} class="context-bar image-bar is-measure">
            {actions.map((a) => (
              <span key={a.id} class={`btn context-btn${a.primary ? " btn-primary" : ""}`}>
                {a.icon}
                <span>{a.label}</span>
              </span>
            ))}
            <span class="btn context-btn is-icon">
              <IconMove />
            </span>
            <span ref={measureMark} class="context-writing">
              <span class="spinner" />
              {t("image.writing")}
            </span>
          </div>
        </div>
        <span class="sr-only" role="status">{pending ? t("image.writing") : announce}</span>
      </div>
    </>
  );
}

/**
 * The box over an image that is not selected: a real button (a click, Enter or Space selects
 * it). When it goes while it has the keyboard focus (its picture deleted or undone, the layer
 * gone with the tool or with Modifica's sub-tool), the focus goes on to a box of the same image
 * if there is one again (the other layer's), else to the scroller, instead of <body>; a frame
 * that comes for it (the image selected) takes the focus itself.
 */
function ImageBox({ index, box, label, locked, onSelect }: {
  index: number; box: Box; label: string; locked: boolean; onSelect: () => void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const node = button.current;
    return () => {
      if (!node || document.activeElement !== node) return;
      const pageEl = node.closest(".page");
      const again = () => (pageEl?.isConnected ? pageEl.querySelector<HTMLElement>(`[data-image="${index}"]`) : null);
      rescueFocus(() => again() ?? viewerScroller());
    };
  }, []);
  return (
    <button
      ref={button}
      type="button"
      class={locked ? "image-box is-locked" : "image-box"}
      data-image={index}
      style={px(box)}
      aria-label={label}
      aria-disabled={locked || undefined}
      onClick={onSelect}
    />
  );
}

export interface ImageLayerProps {
  page: PageModel;
  zoom: number;
  canvasRev: number;
  /**
   * "added": only the pictures the user added (Compila e firma, Modifica with Aggiungi testo);
   * "all" (Modifica with Cambia) by default.
   */
  only?: "all" | "added";
  /** One more action for the selected image's context bar, or null for that image. */
  extraAction?: (image: ImageInfo) => ImageAction | null;
}

export function ImageLayer({ page, zoom, canvasRev, only = "all", extraAction }: ImageLayerProps) {
  const rev = page.rev.value;
  const cached = page.images.value;
  const selected = selectedImage.value;
  const request = focusRequest.value;
  const signatures = only === "added" ? sessionSignatures.value : null;
  const layer = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ensureImages(page);
  }, [page, rev, cached]);

  // The images read at the page's current revision (null while they are read again), and the
  // boxes shown: those, or meanwhile the last ones read, so a box with the focus keeps it (like
  // the canvas, they show the page as it was a moment ago; a click on one does nothing until the
  // images are fresh).
  const all = cached && cached.rev === rev ? cached.images : null;
  const images = all && only === "added" ? all.filter((i) => i.added) : all;
  const lastImages = useRef<ImageInfo[] | null>(null);
  if (images) lastImages.current = images;
  const boxes = images ?? lastImages.current;
  const selectedIndex = selected && selected.pageIndex === page.index ? selected.index : null;

  /**
   * How a picture is named: with only="added" a signature or initials by their description, any
   * other picture by its number among the pictures the user added on the page (the only ones
   * shown there); with all the images (Cambia) by its number among all the page's images.
   */
  const ranks = useRef(new Map<number, number>());
  if (signatures && images) ranks.current = new Map(images.map((image, i) => [image.index, i + 1]));
  const nameOf = (image: ImageInfo): { name: string | null; n: number } => {
    if (!signatures) return { name: null, n: image.index + 1 };
    // While the images are read again, the frame keeps the name and number it had.
    return { name: addedDescription(image, signatures), n: ranks.current.get(image.index) ?? image.index + 1 };
  };

  // The app asks for an image of this page to get the focus: its frame when it is selected, else its box.
  useEffect(() => {
    honourFocusRequest(page.index, "image", images !== null, (id) => {
      const el = layer.current;
      if (!el || typeof id !== "number" || !images?.some((i) => i.index === id)) return null;
      return id === selectedIndex
        ? el.querySelector<HTMLElement>(".image-frame")
        : el.querySelector<HTMLElement>(`[data-image="${id}"]`);
    });
  }, [request, images, selectedIndex]);

  // The selected image, resolved against the current list. While the list is read again after an
  // edit of it (the selection then keeps its index), the frame stays with the last image known,
  // pending, so that it keeps the focus; an index that is not in the list shows nothing.
  const last = useRef<{ image: ImageInfo; rev: number } | null>(null);
  let shown: { image: ImageInfo; rev: number; waiting: boolean } | null = null;
  if (selectedIndex !== null) {
    const found = images?.find((i) => i.index === selectedIndex && i.movable);
    if (found) shown = { image: found, rev, waiting: false };
    else if (!images && last.current?.image.index === selectedIndex) shown = { ...last.current, waiting: true };
  }
  if (!shown) last.current = null;
  else if (!shown.waiting) last.current = { image: shown.image, rev: shown.rev };

  return (
    <div
      ref={layer}
      class={only === "added" ? "images is-added-only" : "images"}
      onClick={(e) => {
        // A click on the page itself (no line, no image): the selection goes.
        if (e.target === e.currentTarget && selectedIndex !== null) void selectImage(page.index, null);
      }}
    >
      {boxes?.map((image) => {
        if (image.index === shown?.image.index) return null; // the frame stands for it
        const [x0, y0, x1, y1] = image.visible;
        if (!(x1 > x0 && y1 > y0)) return null; // clipped away: nothing to click
        const locked = !image.movable;
        const { name, n } = nameOf(image);
        return (
          <ImageBox
            key={image.index}
            index={image.index}
            box={rectBox(page, image.visible, zoom)}
            label={locked
              ? t("image.lockedLabel", { n, reason: lockReasonText(image.reason) })
              : name
                ? t("image.namedLabel", { name, ...sizeMm(image.matrix) })
                : t("image.label", { n, ...sizeMm(image.matrix) })}
            locked={locked}
            onSelect={() => {
              // Read again after a change of the page: a moment, and it is the real one. An image
              // edit waits or runs: the indices may be about to change.
              if (!images || imageEditsPending.peek() > 0) return;
              // selectImage waits for a line edit still being written, and says why a locked one stays.
              void selectImage(page.index, image, rev);
            }}
          />
        );
      })}
      {shown && (
        <SelectedImage
          key={shown.image.index}
          page={page}
          zoom={zoom}
          image={shown.image}
          imageRev={shown.rev}
          waiting={shown.waiting}
          canvasRev={canvasRev}
          extra={extraAction?.(shown.image) ?? null}
          {...nameOf(shown.image)}
        />
      )}
    </div>
  );
}
