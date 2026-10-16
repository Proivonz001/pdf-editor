// Compila e firma overlay of one page (fill mode): the tap catcher under everything else, a box
// over each text the user wrote (a tap reopens it), the text writer, and the copies that keep
// what was just written on screen until the page's canvas shows it. The form fields (FormLayer)
// and the pictures the user added (ImageLayer, only="added") stack above the catcher, so a tap on
// one of them goes to it (viewer.css).
//
// A tap is one pointer, a few px of travel, at most 600 ms and no scroll in between (isTap): one
// finger still scrolls the page (the catcher has touch-action: pan-x pan-y) and two fingers still
// zoom it (gestures.ts). What it does, by sub-tool: Testo opens a writer, its baseline 0.2 em above
// the tap (writerOrigin), in the size of a label on the same row (8–14 pt), else the last size
// used; ✓ and ✗ are written centred on the tap, and Data writes today's date there, at once (near
// an edge they are moved onto the page, and the copy shown meanwhile and what is said follow them
// to where openWriterAt really wrote them); a signature or initials waiting to be placed lands
// there (signatureRect). An open writer is written first (openWriterAt). While a picture is
// selected or a field has the focus, a tap only deselects it or leaves the field. On touch
// screens the press does not take the focus from the writer, and a tap that opens a writer first
// gives the focus to a small hidden field, within the tap: iOS shows its keyboard only for a focus
// given during the user's gesture, and the new writer appears only once the text before it is
// written (what is typed meanwhile goes into it). With a mouse a crosshair, and a ghost of what
// would land, follow the pointer.
//
// The writer is release 2's line editor (LineEditor in LineLayer.tsx) made movable: the same
// field, context bar, focus rules, registerEditor and visualViewport placement. Its bar holds Move
// (drag it, or the arrow keys: 1 pt, Shift 10 pt), A− / A+ with the size, black or blue, and by
// kind "Line below" (Shift+Enter), "Change to ✗ / ✓" or the date's other format; Delete on a text
// written before; Cancel and Apply. On touch screens a round grip before the field moves it too,
// and the viewer zooms in once so the text shows at least 16 px tall (zoomForWriting). Enter,
// Apply, leaving the field, a tap elsewhere or flushEditor write it (commitWriter, which closes the
// writer at once); a copy of the text stays drawn until the canvas shows the edit. Escape or
// Cancel drop it. Where it is, and what was written, is said in status regions.
//
// The keyboard focus never falls to <body> here: a text written from the keyboard gives it to its
// box, and so does the app's focusRequest (a mark put in the middle of the page); while the texts
// are read again after an edit, undo or redo the boxes stay as they were, so a focused one keeps
// it; a box that goes while it has it (its text deleted or undone) hands it to the scroller.
import { batch } from "@preact/signals";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { AddedText, ImageInfo, LineInfo, Rect } from "../engine/protocol";
import { formatFontSize, formatMm, locale, t } from "../i18n";
import {
  doc, editingStopped, fillMode, fillTool, fitMode, focusRequest, INK, initialsSource, openWriter, pendingPlacement,
  registerEditor, selectedImage, writerStyle, zoom, type InkColor, type OpenWriter, type Signature,
} from "../state";
import {
  commitWriter, deleteAdded, openWriterAt, originOnPage, placeInitialsOnPages, placeSignature, reopenAdded, selectImage,
  setFillTool, todayText, writeAndNewLine,
} from "../ui/actions";
import { rescueFocus, viewerScroller } from "../ui/focus";
import { dateText } from "../ui/fill/dates";
import { isTap, rectMatrix, signatureRect, writerOrigin, zoomToWrite } from "../ui/fill/geometry";
import { IconCheck, IconClose, IconMinus, IconMove, IconNewLine, IconPages, IconPlus, IconTrash } from "../ui/icons";
import { isCoarse } from "../ui/media";
import { ensureAdded, honourFocusRequest } from "./added";
import { pagePoint, type Point } from "./imageGeometry";
import type { ImageAction } from "./ImageLayer";
import { ensureLines } from "./lines";
import type { PageModel } from "./model";

/** The writer's text sizes (A− / A+), in points. */
const SIZE_STEPS = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24];
/** A tick or a cross is drawn this much larger than the text around it (as in actions.ts). */
const MARK_SCALE = 1.1;
/** A tap near a label takes its size, kept within these (points). */
const LABEL_SIZE_MIN = 8;
const LABEL_SIZE_MAX = 14;
/** The writer's field is this many times its font size tall (its line height). */
const LINE_HEIGHT = 1.3;
/** The writer's highlighter ring (padding of .writer in viewer.css), and the field's own side padding, in px. */
const RING = 5;
const PAD = 2;
/** Space between the writer (its ring) and its context bar, and the bar's distance from the sides of the viewport. */
const BAR_GAP = 8;
const VIEW_EDGE = 8;
/** Touch screens: the field's text is never smaller than this (px), so iOS does not zoom the page into it. */
const MIN_TOUCH_FONT = 16;
/** Arrow keys on Move: 1 pt, Shift + arrow keys 10 pt. */
const NUDGE = 1;
const NUDGE_FAR = 10;
/** With a mouse, a press on the ring must travel this far (px) before it moves the writer. */
const DRAG_THRESHOLD_MOUSE = 3;
/** Where less of the page than this shows (px), the bar's buttons show their icons only (each keeps its name and tooltip). */
const COMPACT_PAGE = 560;
/** The touch grip: 44 px, this far from the field's ring. */
const GRIP = 44;
const GRIP_GAP = 6;
/** How long (ms) the box of a text just written is waited for, to give it the keyboard focus. */
const FOCUS_NEW_WAIT = 4000;
/** A real pointer that hovers (desktop): the ghost of what a click would put there follows it. */
const CAN_HOVER = typeof window !== "undefined" && typeof window.matchMedia === "function" &&
  window.matchMedia("(hover: hover)").matches;

// --- Small helpers, shared with FormLayer ------------------------------------------------------

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Rect (page space) → px inside the page element. */
export function rectBox(page: PageModel, [x0, y0, x1, y1]: Rect, zoom: number): Box {
  return {
    left: (x0 - page.bounds[0]) * zoom,
    top: (y0 - page.bounds[1]) * zoom,
    width: Math.max(1, (x1 - x0) * zoom),
    height: Math.max(1, (y1 - y0) * zoom),
  };
}

export const px = (b: Box) => ({ left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px` });

/** sRGB 0..1 → a CSS colour. */
export function cssRgb([r, g, b]: readonly number[]): string {
  const c = (v: number) => Math.round(Math.min(1, Math.max(0, v ?? 0)) * 255);
  return `rgb(${c(r)} ${c(g)} ${c(b)})`;
}

const inkCss = (ink: InkColor) => cssRgb(INK[ink]);

/**
 * Touch screens: when text of `sizePt` points would show under 14.4 px at the current zoom, zoom
 * in to 16 px (zoomToWrite: capped, never out) and keep the point `at` (page space) where it is
 * on screen. With a mouse nothing changes. The zoom jumps (no animation), and stays afterwards:
 * fit width is one tap in More.
 */
export function zoomForWriting(pageEl: Element | null, page: PageModel, at: Point, sizePt: number) {
  if (!pageEl || !isCoarse.peek()) return;
  const before = zoom.peek();
  const target = zoomToWrite(sizePt, before, true);
  if (!(target > before * 1.001)) return;
  const scroller = pageEl.closest<HTMLElement>(".scroller");
  if (!scroller) return;
  const s = scroller.getBoundingClientRect();
  const p = pageEl.getBoundingClientRect();
  const off: Point = [at[0] - page.bounds[0], at[1] - page.bounds[1]];
  const view: Point = [p.left + off[0] * before - s.left, p.top + off[1] * before - s.top];
  batch(() => {
    fitMode.value = false;
    zoom.value = target;
  });
  // The viewer lays the pages out again at the new zoom before the next frame: then the point is
  // put back where it was, before anything is painted.
  requestAnimationFrame(() => {
    if (!pageEl.isConnected) return;
    const s2 = scroller.getBoundingClientRect();
    const p2 = pageEl.getBoundingClientRect();
    const z = zoom.peek();
    scroller.scrollLeft += p2.left + off[0] * z - s2.left - view[0];
    scroller.scrollTop += p2.top + off[1] * z - s2.top - view[1];
  });
}

/** Where the writer is, in words (its description, and what is said after it moves). */
function positionText(page: PageModel, [x, y]: Point): string {
  return t("writer.position", { x: formatMm(x - page.bounds[0]), y: formatMm(y - page.bounds[1]) });
}

/** The baseline start that centres a ✓ or ✗ of `size` points on `at` (Dingbats: about 0.8 em wide, 0.7 em tall). */
function markOrigin([x, y]: Point, size: number): [number, number] {
  return [x - 0.4 * size, y + 0.35 * size];
}

/**
 * Where a mark or a date tapped at `origin` will be written: kept on the page with the text
 * inside it, as openWriterAt does (originOnPage, with the same width estimate: a mark 0.8 em, a
 * text 0.56 em a character). The copy starts there; where it was really written (openWriterAt's
 * result) then has the last word.
 */
function writtenAt(page: PageModel, origin: Point, text: string, size: number, mark: boolean): [number, number] {
  const width = mark ? 0.8 * size : 0.56 * size * Math.max(2, [...text].length);
  return originOnPage(page.bounds, [origin[0], origin[1]], size, width);
}

/** A writer's origin kept on the page. */
function onPage(page: PageModel, [x, y]: Point): [number, number] {
  const [x0, y0, x1, y1] = page.bounds;
  return [Math.min(Math.max(x, x0), x1 - 1), Math.min(Math.max(y, y0 + 1), y1)];
}

/** The next text size up (1) or down (-1) from `size`, or null at the end of the steps. */
function stepSize(size: number, dir: 1 | -1): number | null {
  if (dir > 0) return SIZE_STEPS.find((s) => s > size + 0.05) ?? null;
  for (let i = SIZE_STEPS.length - 1; i >= 0; i--) if (SIZE_STEPS[i] < size - 0.05) return SIZE_STEPS[i];
  return null;
}

/**
 * The size of a printed label next to a tap at `at` ("Nome:", then the blank after it): a
 * horizontal line whose baseline is within 1.5 lines of the tap, which starts a little before the
 * tap or ends before it. Its size, kept within 8–14 pt; null when there is none.
 */
function labelSize(lines: readonly LineInfo[] | null, [x, y]: Point): number | null {
  let best: { d: number; size: number } | null = null;
  for (const line of lines ?? []) {
    const s = line.size;
    if (!(s > 0) || line.vertical || Math.abs(line.dir[0] - 1) > 0.01) continue;
    const [x0, , x1, y1] = line.bbox;
    if (x < x0 - 2 * s || x > x1 + 25 * s) continue;
    const baseline = y1 - 0.22 * s; // the bottom of the box is the descenders'
    const d = Math.abs(y - baseline);
    if (d > 1.5 * 1.2 * s) continue;
    if (!best || d < best.d) best = { d, size: s };
  }
  if (!best) return null;
  return Math.round(Math.min(LABEL_SIZE_MAX, Math.max(LABEL_SIZE_MIN, best.size)) * 2) / 2;
}

/** The lines of `page` as read for its current revision (fill mode reads them for the label size). */
function currentLines(page: PageModel): readonly LineInfo[] | null {
  const cached = page.lines.peek();
  return cached && cached.rev === page.rev.peek() ? cached.lines : null;
}

/** navigator.languages, for dates. */
function languages(): string[] {
  return typeof navigator === "undefined" ? [] : [...(navigator.languages ?? [navigator.language])];
}

/**
 * The day a date written by Data reads as (so its other format can be offered), by formatting the
 * days of its year until one reads the same; null when none does.
 */
function parseDate(text: string): Date | null {
  const s = text.trim();
  const year = /\d{4}/.exec(s)?.[0];
  if (!year) return null;
  const style = /^\d{1,2}\D\d{1,2}\D\d{4}$/.test(s) ? "short" : "long";
  const y = Number(year);
  const langs = languages();
  for (let m = 0; m < 12; m++) {
    for (let d = 1; d <= 31; d++) {
      const date = new Date(y, m, d);
      if (date.getMonth() !== m) break;
      if (dateText(date, locale.peek(), langs, style) === s) return date;
    }
  }
  return null;
}

/** Pressing the writer's bar or grip must leave the focus (and the caret) in the field. */
const keepFocus = (e: Event) => e.preventDefault();

/** One key per writer opened (the same OpenWriter object for its whole life). */
const serials = new WeakMap<OpenWriter, number>();
let nextSerial = 1;
function serialOf(w: OpenWriter): number {
  let n = serials.get(w);
  if (n === undefined) {
    n = nextSerial++;
    serials.set(w, n);
  }
  return n;
}

/**
 * "On every page…" in the context bar of the initials placed last (initialsSource), on a
 * document with more pages. Null for any other picture.
 */
export function everyPageAction(page: PageModel, image: ImageInfo): ImageAction | null {
  const source = initialsSource.value;
  const d = doc.value;
  if (!source || !d || source.docId !== d.id || source.pageIndex !== page.index || source.imageIndex !== image.index) return null;
  if (d.pages.length < 2) return null;
  return {
    id: "every-page",
    label: t("initials.everyPage"),
    tip: t("initials.everyPageTip"),
    icon: <IconPages />,
    onClick: () => void placeInitialsOnPages(page.index, image.index),
  };
}

// --- The writer --------------------------------------------------------------------------------

/** What was just written, drawn until the page's canvas shows it. */
interface CopyText {
  text: string;
  origin: [number, number];
  size: number;
  color: InkColor;
}

interface WriterProps {
  page: PageModel;
  zoom: number;
  w: OpenWriter;
  /** What was typed into the hidden field while the writer was on its way (touch screens). */
  takeEarly: () => string;
  /** `copy` is being written by `run`; `focusBack`: the focus goes to its box once it is there. */
  onWrite: (copy: CopyText, run: Promise<void>, focusBack: boolean) => void;
}

function TextWriter({ page, zoom, w, takeEarly, onWrite }: WriterProps) {
  const input = useRef<HTMLInputElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const grip = useRef<HTMLSpanElement>(null);
  /** Set once the writer is done (cancelled, written or deleted); resolves when that is complete. */
  const done = useRef<Promise<void> | null>(null);
  /** Delete was pressed: the text's box is about to go, so the focus does not go back to it. */
  const deleting = useRef(false);
  const coarse = isCoarse.value;

  // What the writer holds besides its text (which is in the field): commitWriter gets them.
  const [origin, setOrigin] = useState<[number, number]>(w.origin);
  const [size, setSize] = useState(w.size);
  const [color, setColor] = useState<InkColor>(w.color);
  const [kind, setKind] = useState(w.kind);
  /** The context bar goes under the writer: no room for it above, on screen. */
  const [flip, setFlip] = useState(false);
  /** Sideways shift (px) that keeps the context bar inside the viewport. */
  const [nudge, setNudge] = useState(0);
  /** The widest the bar may be (px): what shows of the viewer; past that, its buttons wrap to a second row. */
  const [barMax, setBarMax] = useState<number | null>(null);
  /** What the status region says: where the writer went after a move. */
  const [moved, setMoved] = useState("");
  const [dragging, setDragging] = useState(false);
  /** The day of a date (its other format), read from the text it opened with. */
  const day = useRef<Date | null>(null);
  if (day.current === null && w.kind === "date") day.current = parseDate(w.text) ?? new Date();

  const latest = useRef({ origin, size, color, zoom });
  latest.current = { origin, size, color, zoom };

  const helpId = `writer-help-${page.index}`;

  /** Nothing to write: an empty new writer, or a reopened text with nothing changed. */
  const unchanged = () => {
    const text = input.current?.value ?? w.text;
    if (w.editing === null) return !text.trim();
    const now = latest.current;
    return text === w.text && now.origin[0] === w.origin[0] && now.origin[1] === w.origin[1] &&
      now.size === w.size && now.color === w.color;
  };

  const close = () => {
    if (openWriter.peek() === w) openWriter.value = null;
  };

  const cancel = () => {
    if (done.current) return;
    done.current = Promise.resolve();
    close();
  };

  /** Write it (Enter, Apply: `focusBack`; leaving the field, a tap elsewhere, flushEditor). */
  const commit = (focusBack = false): Promise<void> => {
    if (done.current) return done.current;
    const text = input.current?.value ?? w.text;
    if (unchanged()) {
      done.current = Promise.resolve();
      close();
      return done.current;
    }
    const now = latest.current;
    const run = commitWriter(w, text, now.origin, now.size, now.color);
    done.current = run.catch((e: unknown) => console.error(e));
    if (text.trim()) onWrite({ text, origin: now.origin, size: now.size, color: now.color }, run, focusBack);
    return done.current;
  };

  // The latest commit, for the rest of the app (flushEditor / hasUnsavedWork in state.ts).
  const commitRef = useRef(commit);
  commitRef.current = commit;

  /** "Line below": write this line, and a new writer opens one line below it (Shift+Enter). */
  const newLine = () => {
    if (done.current) return;
    const text = input.current?.value ?? w.text;
    const now = latest.current;
    const run = writeAndNewLine(w, text, now.origin, now.size, now.color);
    done.current = run.catch((e: unknown) => console.error(e));
    if (text.trim() && !unchanged()) onWrite({ text, origin: now.origin, size: now.size, color: now.color }, run, false);
  };

  const remove = () => {
    if (done.current || w.editing === null) return;
    deleting.current = true;
    done.current = deleteAdded(page.index, w.editing, w.rev).catch((e: unknown) => console.error(e));
  };

  /** The focus is somewhere in the writer: its field, its bar, its grip. */
  const inWriter = (node: Node | null) =>
    !!node && (node === input.current || !!bar.current?.contains(node) || !!grip.current?.contains(node) ||
      !!wrap.current?.contains(node));

  // --- Moving ----------------------------------------------------------------------------------

  const moveTo = (next: [number, number], announce: boolean) => {
    const p = onPage(page, next);
    setOrigin(p);
    if (announce) setMoved(positionText(page, p));
  };

  const moveBy = (dx: number, dy: number) => {
    const [x, y] = latest.current.origin;
    moveTo([x + dx, y + dy], true);
  };

  const drag = useRef<{
    id: number; el: Element; x0: number; y0: number; from: [number, number]; threshold: number; started: boolean;
  } | null>(null);

  const startDrag = (e: PointerEvent) => {
    if (done.current || drag.current) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (!e.isPrimary) return;
    e.preventDefault(); // the focus stays in the field; no text selection, no native drag
    const el = e.currentTarget as Element;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      return; // the pointer is already gone
    }
    drag.current = {
      id: e.pointerId, el, x0: e.clientX, y0: e.clientY, from: latest.current.origin,
      threshold: e.pointerType === "mouse" ? DRAG_THRESHOLD_MOUSE : 0, started: false,
    };
  };

  const onDragMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    const dx = e.clientX - d.x0, dy = e.clientY - d.y0;
    if (!d.started) {
      if (Math.hypot(dx, dy) < d.threshold) return;
      d.started = true;
      setDragging(true);
    }
    const z = latest.current.zoom;
    moveTo([d.from[0] + dx / z, d.from[1] + dy / z], false);
  };

  const endDrag = (e: PointerEvent) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    drag.current = null;
    try {
      if (d.el.hasPointerCapture(d.id)) d.el.releasePointerCapture(d.id);
    } catch {
      // The pointer is gone already.
    }
    if (d.started) {
      setDragging(false);
      setMoved(positionText(page, latest.current.origin));
    }
  };

  /** The ring round the field: a mouse or a pen drags the writer by it (the field itself takes the caret). */
  const onRingDown = (e: PointerEvent) => {
    if (e.target !== e.currentTarget || e.pointerType === "touch") return;
    startDrag(e);
  };

  const dragHandlers = {
    onPointerDown: startDrag,
    onPointerMove: onDragMove,
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
    onLostPointerCapture: endDrag,
  };

  // --- Size, ink, kind ---------------------------------------------------------------------------

  const resize = (dir: 1 | -1) => {
    const next = stepSize(latest.current.size, dir);
    if (next === null) return;
    setSize(next);
  };

  const swapMark = () => {
    const el = input.current;
    if (!el || (kind !== "check" && kind !== "cross")) return;
    const next = kind === "check" ? "cross" : "check";
    el.value = next === "check" ? "✓" : "✗";
    setKind(next);
  };

  /** The date in its other format: short "16/10/2026", long "16 ottobre 2026". */
  const dateFormats = () => {
    const date = day.current ?? new Date();
    const short = dateText(date, locale.value, languages(), "short");
    const long = dateText(date, locale.value, languages(), "long");
    return { short, long };
  };
  const [dateShown, setDateShown] = useState(w.text);
  const otherDate = () => {
    const { short, long } = dateFormats();
    return dateShown.trim() === short ? long : short;
  };
  const swapDate = () => {
    const el = input.current;
    if (!el) return;
    el.value = otherDate();
    setDateShown(el.value);
  };

  // --- The context bar on screen -----------------------------------------------------------------

  /**
   * Keep the context bar on screen: under the writer when it is too close to the top of the
   * viewport (and there is more room below), shifted sideways when it starts near (or past) an
   * edge of it. Worked out from the field's position alone, so it can run again after a zoom, a
   * scroll or a move.
   */
  const place = () => {
    const field = wrap.current;
    const barEl = bar.current;
    const scroller = field?.closest<HTMLElement>(".scroller");
    if (!field || !barEl || !scroller) return;
    const s = scroller.getBoundingClientRect();
    const f = field.getBoundingClientRect();
    const vv = window.visualViewport;
    const viewTop = Math.max(s.top, vv ? vv.offsetTop : -Infinity);
    const viewBottom = Math.min(s.top + scroller.clientHeight, vv ? vv.offsetTop + vv.height : Infinity);
    const viewLeft = Math.max(s.left, vv ? vv.offsetLeft : -Infinity);
    const viewRight = Math.min(s.left + scroller.clientWidth, vv ? vv.offsetLeft + vv.width : Infinity);
    const widest = Math.max(160, Math.floor(viewRight - viewLeft - 2 * VIEW_EDGE));
    setBarMax((prev) => (prev === widest ? prev : widest));
    if (f.bottom <= viewTop || f.top >= viewBottom || f.right <= viewLeft || f.left >= viewRight) return;
    const roomAbove = f.top - viewTop;
    setFlip(roomAbove < BAR_GAP + barEl.offsetHeight && viewBottom - f.bottom > roomAbove);
    const wanted = f.left;
    const left = Math.max(viewLeft + VIEW_EDGE, Math.min(wanted, viewRight - VIEW_EDGE - barEl.offsetWidth));
    setNudge(Math.round(left - wanted));
  };
  const placeRef = useRef(place);
  placeRef.current = place;

  // --- Lifetime ----------------------------------------------------------------------------------

  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    const early = takeEarly();
    if (early) el.value += early;
    el.size = Math.max(4, el.value.length + 1);
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
    zoomForWriting(el.closest(".page"), page, w.origin, w.size);
    placeRef.current();
    const barEl = bar.current;

    const scroller = el.closest<HTMLElement>(".scroller");
    const viewport: EventTarget = window.visualViewport ?? window;
    let frame = 0;
    const onMove = () => {
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; placeRef.current(); });
    };
    scroller?.addEventListener("scroll", onMove, { passive: true });
    viewport.addEventListener("resize", onMove);
    viewport.addEventListener("scroll", onMove);

    const unregister = registerEditor({
      changed: () => !done.current && !unchanged(),
      commit: () => commitRef.current(),
    });
    return () => {
      unregister();
      scroller?.removeEventListener("scroll", onMove);
      viewport.removeEventListener("resize", onMove);
      viewport.removeEventListener("scroll", onMove);
      if (frame) cancelAnimationFrame(frame);
      // Closed from outside (undo/redo, another tool): nothing typed is written later, even if
      // the browser fires blur while removing the field.
      if (!done.current) done.current = Promise.resolve();
      // The writer had the keyboard focus: keep it in the document instead of dropping it to
      // <body>: back to the box of the text it reopened (not one being deleted), else to the
      // scroller (the box of a text just written takes it once it is there: FillLayer).
      const active = document.activeElement;
      if (active !== el && !(active && barEl?.contains(active))) return;
      const pageEl = el.closest(".page");
      const back = w.editing !== null && !deleting.current ? w.editing : null;
      requestAnimationFrame(() => {
        const now = document.activeElement;
        if (now && now !== document.body) return; // something else took the focus meanwhile
        const box = back !== null ? pageEl?.querySelector<HTMLElement>(`[data-added="${back}"]`) : null;
        (box ?? scroller)?.focus({ preventScroll: true });
      });
    };
  }, []);

  // A zoom, a move or a new size moves the writer: place the bar again (after the viewer has
  // re-anchored the scroll on a zoom).
  useEffect(() => {
    const frame = requestAnimationFrame(() => placeRef.current());
    return () => cancelAnimationFrame(frame);
  }, [zoom, origin[0], origin[1], size, kind, dragging, barMax]);

  // --- Keys ----------------------------------------------------------------------------------------

  const onFieldKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing || e.keyCode === 229) return; // IME composition in progress
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey && kind === "text") newLine();
      else void commit(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation(); // not also the next step of Escape (ui/shortcuts.ts)
      cancel();
    }
  };

  const onMoveKeyDown = (e: KeyboardEvent) => {
    const arrows: Record<string, Point> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const dir = arrows[e.key];
    if (dir) {
      e.preventDefault();
      e.stopPropagation(); // here the arrows move the writer, not the focus along the bar
      const step = e.shiftKey ? NUDGE_FAR : NUDGE;
      moveBy(dir[0] * step, dir[1] * step);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      input.current?.focus({ preventScroll: true }); // back to the text
    }
  };

  const onBarKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancel();
      return;
    }
    // The bar is part of the field: as there, Ctrl+Z / Ctrl+Y are not the document's undo and redo.
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && (k === "z" || k === "y")) {
      e.stopPropagation();
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

  const onBarFocusOut = (e: FocusEvent) => {
    if (inWriter(e.relatedTarget as Node | null)) return;
    void commit(); // the focus left the writer: the same as leaving the field
  };

  const apply = () => {
    // From the keyboard the focus is on Apply: hand it back to the field first, so it goes on to
    // the text's box afterwards.
    if (bar.current?.contains(document.activeElement)) input.current?.focus({ preventScroll: true });
    void commit(true);
  };

  // --- Render ------------------------------------------------------------------------------------

  const F = Math.max(coarse ? MIN_TOUCH_FONT : 4, size * zoom);
  const H = Math.round(F * LINE_HEIGHT);
  const baseline = (origin[1] - page.bounds[1]) * zoom;
  // With its line height of 1.3 em, the field's text baseline is about 1 em below its top.
  const top = baseline - H / 2 - 0.35 * F;
  const left = (origin[0] - page.bounds[0]) * zoom - PAD;
  const pageWidth = page.width * zoom;
  const compact = Math.min(pageWidth, barMax ?? Infinity) < COMPACT_PAGE;

  // Touch: the round grip before the field, or under its start when there is no room before it.
  const gripBelow = coarse && left - RING - GRIP_GAP - GRIP < -GRIP / 2;
  const gripStyle = gripBelow
    ? { left: `${left - RING}px`, top: `${top + H + RING + GRIP_GAP}px` }
    : { left: `${left - RING - GRIP_GAP - GRIP}px`, top: `${top + H / 2 - GRIP / 2}px` };

  // Context bar: above the writer unless it would leave the page (or the screen) there.
  const barHeight = bar.current?.offsetHeight || (coarse ? 44 : 36);
  const above = top - RING - BAR_GAP;
  const below = flip || above - barHeight < 0;
  const belowTop = top + H + RING + BAR_GAP + (gripBelow ? GRIP + GRIP_GAP : 0);
  const slot = below ? { top: `${belowTop}px` } : { bottom: `${page.height * zoom - above}px` };

  const mark = kind === "check" || kind === "cross";
  const smaller = stepSize(size, -1), bigger = stepSize(size, 1);
  const iconOnly = (label: string) => (compact ? { "aria-label": label } : {});

  return (
    <>
      <div
        ref={wrap}
        class={dragging ? "writer is-dragging" : "writer"}
        style={{ left: `${left - RING}px`, top: `${top - RING}px` }}
        onPointerDown={onRingDown}
        onPointerMove={onDragMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
      >
        <input
          ref={input}
          class="writer-input"
          type="text"
          defaultValue={w.text}
          style={{
            height: `${H}px`,
            lineHeight: `${H}px`,
            fontSize: `${F}px`,
            minWidth: `${F * 3}px`,
            maxWidth: `${Math.max(pageWidth - left, F * 4)}px`,
            color: inkCss(color),
          }}
          aria-label={t("writer.label", { page: page.index + 1 })}
          aria-describedby={helpId}
          autocomplete="off"
          spellcheck={false}
          enterKeyHint="done"
          onInput={(e) => {
            const el = e.currentTarget;
            el.size = Math.max(4, el.value.length + 1); // where field-sizing is not supported
            if (kind === "date") setDateShown(el.value);
          }}
          onKeyDown={onFieldKeyDown}
          onBlur={(e) => {
            if (inWriter(e.relatedTarget as Node | null)) return; // Tab into the bar, a press on the grip
            void commit();
          }}
        />
      </div>
      <span id={helpId} hidden>{`${positionText(page, origin)}. ${t("writer.keys")}`}</span>
      {coarse && (
        <span
          ref={grip}
          class="writer-grip"
          style={gripStyle}
          title={t("writer.moveTip")}
          aria-hidden="true"
          {...dragHandlers}
        >
          <IconMove />
        </span>
      )}
      {/* The slot spans the page; the indent before the bar shrinks so the bar stays on it. */}
      <div class={["context-slot", below && "is-below", dragging && "is-hidden"].filter(Boolean).join(" ")} style={slot}>
        <span class="context-indent" style={{ flexBasis: `${Math.max(0, left - RING + nudge)}px` }} />
        <div
          ref={bar}
          class="context-bar writer-bar"
          style={barMax ? { maxWidth: `${barMax}px` } : undefined}
          role="toolbar"
          aria-label={t("writer.label", { page: page.index + 1 })}
          onPointerDown={keepFocus}
          onMouseDown={keepFocus}
          onKeyDown={onBarKeyDown}
          onFocusOut={onBarFocusOut}
        >
          <button
            type="button"
            class="btn context-btn is-icon writer-move"
            title={t("writer.moveTip")}
            aria-label={t("writer.move")}
            onKeyDown={onMoveKeyDown}
            {...dragHandlers}
          >
            <IconMove />
          </button>
          <span class="context-sep" aria-hidden="true" />
          <button
            type="button"
            class="btn context-btn is-icon"
            title={t("writer.smaller")}
            aria-label={t("writer.smaller")}
            aria-disabled={smaller === null || undefined}
            onClick={() => resize(-1)}
          >
            <IconMinus />
          </button>
          <span class="writer-size">{t("writer.size", { size: formatFontSize(size) })}</span>
          <button
            type="button"
            class="btn context-btn is-icon"
            title={t("writer.bigger")}
            aria-label={t("writer.bigger")}
            aria-disabled={bigger === null || undefined}
            onClick={() => resize(1)}
          >
            <IconPlus />
          </button>
          <span class="context-sep" aria-hidden="true" />
          <span class="writer-inks" role="group" aria-label={t("writer.color")}>
            {(["black", "blue"] as const).map((ink) => (
              <button
                type="button"
                key={ink}
                class="btn context-btn is-icon writer-ink"
                title={t(ink === "black" ? "writer.black" : "writer.blue")}
                aria-label={t(ink === "black" ? "writer.black" : "writer.blue")}
                aria-pressed={color === ink}
                onClick={() => setColor(ink)}
              >
                <span class="writer-swatch" style={{ background: inkCss(ink) }} />
              </button>
            ))}
          </span>
          <span class="context-sep" aria-hidden="true" />
          {kind === "text" && (
            <button
              type="button"
              class={compact ? "btn context-btn is-icon" : "btn context-btn"}
              title={t("writer.newLineTip")}
              {...iconOnly(t("writer.newLine"))}
              onClick={newLine}
            >
              <IconNewLine />
              {!compact && <span>{t("writer.newLine")}</span>}
            </button>
          )}
          {mark && (
            <button type="button" class="btn context-btn" onClick={swapMark}>
              <span>{t(kind === "check" ? "mark.toCross" : "mark.toCheck")}</span>
            </button>
          )}
          {kind === "date" && (
            <button type="button" class="btn context-btn" title={t("writer.dateFormat")} onClick={swapDate}>
              <span>{otherDate()}</span>
            </button>
          )}
          {w.editing !== null && (
            <button
              type="button"
              class={compact ? "btn context-btn is-icon" : "btn context-btn"}
              title={t("writer.deleteTip")}
              {...iconOnly(t("writer.delete"))}
              onClick={remove}
            >
              <IconTrash />
              {!compact && <span>{t("writer.delete")}</span>}
            </button>
          )}
          <button
            type="button"
            class={compact ? "btn context-btn is-icon" : "btn context-btn"}
            title={t("edit.cancelTip", { key: t("key.esc") })}
            {...iconOnly(t("edit.cancel"))}
            onClick={cancel}
          >
            <IconClose />
            {!compact && <span>{t("edit.cancel")}</span>}
          </button>
          <button
            type="button"
            class={compact ? "btn btn-primary context-btn is-icon" : "btn btn-primary context-btn"}
            title={t("edit.applyTip", { key: t("key.enter") })}
            {...iconOnly(t("edit.apply"))}
            onClick={apply}
          >
            <IconCheck />
            {!compact && <span>{t("edit.apply")}</span>}
          </button>
          <span class="sr-only" role="status">{moved}</span>
        </div>
      </div>
    </>
  );
}

// --- The ghost (desktop) -----------------------------------------------------------------------

/** An object URL for `blob` while it is needed (the ghost of the signature waiting to be placed). */
function useObjectUrl(blob: Blob | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url;
}

const aspectOf = (sig: Signature) => sig.width / Math.max(1, sig.height);

/** What a click at `at` would put there, half transparent: the signature, a mark, the date, or "Aa". */
function Ghost({ page, zoom, at, sig, sigUrl }: {
  page: PageModel; zoom: number; at: Point; sig: Signature | null; sigUrl: string | null;
}) {
  if (sig) {
    if (!sigUrl) return null;
    const r = signatureRect(page.bounds, sig.kind, aspectOf(sig), at);
    return <img class="fill-ghost is-picture" src={sigUrl} alt="" aria-hidden="true" style={px(rectBox(page, r, zoom))} />;
  }
  const sub = fillTool.value;
  if (sub === "signature" || sub === "initials" || sub === "image") return null;
  const style = writerStyle.value;
  const mark = sub === "check" || sub === "cross";
  const size = mark ? style.size * MARK_SCALE : style.size;
  const origin = mark ? markOrigin(at, size) : writerOrigin(at, size);
  const text = sub === "check" ? "✓" : sub === "cross" ? "✗" : sub === "date" ? todayText() : "Aa";
  const F = size * zoom;
  return (
    <span
      class={sub === "text" ? "fill-ghost is-text" : "fill-ghost"}
      aria-hidden="true"
      style={{
        left: `${(origin[0] - page.bounds[0]) * zoom}px`,
        // Line height 1: the baseline is about 0.85 em below the top.
        top: `${(origin[1] - page.bounds[1]) * zoom - 0.85 * F}px`,
        fontSize: `${F}px`,
        color: inkCss(style.color),
      }}
    >
      {text}
    </span>
  );
}

// --- What the user wrote -----------------------------------------------------------------------

/**
 * The box over a text the user wrote: a real button (a tap or Enter reopens the text). When it
 * goes while it has the keyboard focus (its text deleted, or undone), the focus goes on to the
 * scroller instead of <body>; a writer reopening it takes the focus itself.
 */
function AddedBox({ page, zoom, added, onPress, onOpen }: {
  page: PageModel;
  zoom: number;
  added: AddedText;
  onPress: (e: PointerEvent) => void;
  onOpen: (e: MouseEvent, added: AddedText) => void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const node = button.current;
    return () => {
      if (node && document.activeElement === node) rescueFocus(viewerScroller);
    };
  }, []);
  return (
    <button
      ref={button}
      type="button"
      class="added-box"
      data-added={added.id}
      style={px(rectBox(page, added.bbox, zoom))}
      aria-label={t("fill.addedLabel", { text: added.text })}
      onPointerDown={onPress}
      onClick={(e) => onOpen(e, added)}
    />
  );
}

// --- The layer ---------------------------------------------------------------------------------

interface Copy extends CopyText {
  id: number;
  /** The page revision whose canvas shows it; null while it is being written. */
  until: number | null;
}

let nextCopyId = 1;

interface PressState {
  id: number;
  x: number;
  y: number;
  at: number;
  coarse: boolean;
  pointers: number;
  scrolled: boolean;
  /** A form field had the focus when the press began (a mouse press has taken it away already). */
  inField: boolean;
  off: () => void;
}

/** The focus is in a form field's control (FormLayer). */
const fieldHasFocus = () => {
  const active = document.activeElement;
  return active instanceof HTMLElement && !!active.closest(".form-fields");
};

export function FillLayer({ page, zoom, canvasRev }: { page: PageModel; zoom: number; canvasRev: number }) {
  const rev = page.rev.value;
  const cached = page.added.value;
  const w = openWriter.value;
  const sig = pendingPlacement.value;
  const request = focusRequest.value;
  const coarse = isCoarse.value;
  const layer = useRef<HTMLDivElement>(null);
  const keeper = useRef<HTMLInputElement>(null);
  const press = useRef<PressState | null>(null);
  /** The kind of pointer that pressed an added text's box last ("touch" keeps the keyboard up). */
  const boxPointer = useRef("mouse");
  const [copies, setCopies] = useState<Copy[]>([]);
  const [hover, setHover] = useState<Point | null>(null);
  const hoverFrame = useRef(0);
  const hoverAt = useRef<Point | null>(null);
  const [status, setStatus] = useState("");
  /** A text written from the keyboard: its box takes the focus once the added texts are read again. */
  const focusNew = useRef<{ origin: Point; until: number } | null>(null);
  const sigUrl = useObjectUrl(CAN_HOVER ? sig?.png ?? null : null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  // Fill mode reads the page's added texts (their boxes) and its lines (a label's size).
  useEffect(() => {
    ensureAdded(page);
    ensureLines(page);
  }, [page, rev, cached]);

  // While the texts are read again after a change of the page, their boxes stay as they were (as
  // the canvas does until it is drawn again), so a box with the focus keeps it: ids are stable,
  // and a box whose text is still there is the same element afterwards. Until then a box does
  // not reopen its text (what it holds may be stale).
  const last = useRef<AddedText[] | null>(null);
  const fresh = cached && cached.rev === rev ? cached.texts : null;
  if (fresh) last.current = fresh;
  const texts = fresh ?? last.current;
  const isFresh = useRef(false);
  isFresh.current = fresh !== null;

  // A copy goes once the canvas shows the revision with its text (or will not: the page is far).
  useEffect(() => {
    const gone = (c: Copy) => c.until !== null && (canvasRev >= c.until || !page.near.peek());
    if (copies.some(gone)) setCopies((cs) => cs.filter((c) => !gone(c)));
  }, [copies, canvasRev]);

  // The box of a text just written from the keyboard takes the focus (if nothing else took it).
  useEffect(() => {
    const f = focusNew.current;
    if (!f || !fresh) return;
    if (performance.now() > f.until) {
      focusNew.current = null;
      return;
    }
    const found = fresh.find((a) => Math.abs(a.origin[0] - f.origin[0]) < 0.5 && Math.abs(a.origin[1] - f.origin[1]) < 0.5);
    if (!found) return;
    focusNew.current = null;
    const now = document.activeElement;
    if (now && now !== document.body && !now.classList.contains("scroller")) return;
    layer.current?.querySelector<HTMLElement>(`[data-added="${found.id}"]`)?.focus({ preventScroll: true });
  }, [fresh]);

  // The app asks for the box of a text of this page to get the focus (a mark put in the middle).
  useEffect(() => {
    honourFocusRequest(page.index, "added", fresh !== null, (id) =>
      layer.current?.querySelector<HTMLElement>(`.added-box[data-added="${id}"]`) ?? null);
  }, [request, fresh, w]);

  // Leaving fill mode or the page going away: no press left listening.
  useEffect(() => () => {
    press.current?.off();
    press.current = null;
    if (hoverFrame.current) cancelAnimationFrame(hoverFrame.current);
  }, []);

  const pointAt = (clientX: number, clientY: number): Point => {
    const r = layer.current?.getBoundingClientRect() ?? { left: 0, top: 0 };
    return pagePoint(clientX, clientY, r, [page.bounds[0], page.bounds[1]], zoomRef.current);
  };

  // --- What was written, on screen until the canvas has it ---------------------------------------

  /**
   * Keep `copy` drawn while `run` writes it, then until the canvas shows it; say it is written.
   * A mark or a date (`what`) is said with where it is. `run` resolves with where it was really
   * written when that is known (openWriterAt: the copy moves there), null when nothing was.
   */
  const track = (copy: CopyText, run: Promise<[number, number] | null | void>, what: "text" | "mark" | "date") => {
    const id = nextCopyId++;
    const before = page.rev.peek();
    setCopies((cs) => [...cs, { ...copy, id, until: null }]);
    void run.catch(() => null).then((at) => {
      const now = page.rev.peek();
      if (at === null || now === before) {
        setCopies((cs) => cs.filter((c) => c.id !== id)); // refused or failed: it is not there
        return;
      }
      const origin = Array.isArray(at) ? at : copy.origin;
      setCopies((cs) => cs.map((c) => (c.id === id ? { ...c, origin, until: now } : c)));
      const p = page.index + 1;
      const where = { page: p, x: formatMm(origin[0] - page.bounds[0]), y: formatMm(origin[1] - page.bounds[1]) };
      if (what === "mark") setStatus(t("mark.placedAt", where));
      else if (what === "date") setStatus(t("writer.doneAt", where));
      else setStatus(t("writer.done", { page: p }));
    });
  };

  const onWrite = (copy: CopyText, run: Promise<void>, focusBack: boolean) => {
    if (focusBack) focusNew.current = { origin: copy.origin, until: performance.now() + FOCUS_NEW_WAIT };
    track(copy, run, "text");
  };

  // --- The phone's keyboard across writers ---------------------------------------------------------

  /** Within a tap: give the focus to the hidden field at `at`, so the keyboard comes (or stays) up. */
  const holdKeyboard = (at: Point) => {
    const k = keeper.current;
    if (!k) return;
    const z = zoomRef.current;
    k.style.left = `${(at[0] - page.bounds[0]) * z}px`;
    k.style.top = `${(at[1] - page.bounds[1]) * z}px`;
    k.value = "";
    k.focus({ preventScroll: true });
  };

  /** No writer came after all: the hidden field lets the focus (and the keyboard) go. */
  const releaseKeyboard = () => {
    const k = keeper.current;
    if (!k || document.activeElement !== k) return;
    k.blur();
    rescueFocus(viewerScroller);
  };

  /** What was typed into the hidden field meanwhile, for the writer that opens. */
  const takeEarly = () => {
    const k = keeper.current;
    if (!k || document.activeElement !== k) return "";
    const typed = k.value;
    k.value = "";
    return typed;
  };

  /** After an open: no writer on this page means none came. */
  const afterOpen = () => {
    if (openWriter.peek()?.pageIndex !== page.index) releaseKeyboard();
  };

  // --- Taps ------------------------------------------------------------------------------------

  /** A tap at `at` (page space) on the page itself: what the sub-tool does there. */
  const tap = (at: Point, touch: boolean, inField: boolean) => {
    if (!fillMode.peek() || editingStopped.peek()) return;
    // A picture selected: the tap deselects it. A field with the focus: the tap leaves it.
    if (selectedImage.peek()) {
      void selectImage(page.index, null);
      return;
    }
    if (inField) {
      if (fieldHasFocus()) (document.activeElement as HTMLElement).blur(); // its blur writes it
      return;
    }
    const pending = pendingPlacement.peek();
    if (pending) {
      void placeSignature(page.index, pending, rectMatrix(signatureRect(page.bounds, pending.kind, aspectOf(pending), at)));
      return;
    }
    const sub = fillTool.peek();
    const style = writerStyle.peek();
    if (sub === "check" || sub === "cross") {
      const size = style.size * MARK_SCALE;
      const origin = markOrigin(at, size);
      const text = sub === "check" ? "✓" : "✗";
      const copy = { text, origin: writtenAt(page, origin, text, size, true), size, color: style.color };
      track(copy, openWriterAt(page.index, origin, sub, text, { size }), "mark");
      return;
    }
    if (sub === "date") {
      const text = todayText();
      const origin = writerOrigin(at, style.size);
      const copy = { text, origin: writtenAt(page, origin, text, style.size, false), size: style.size, color: style.color };
      track(copy, openWriterAt(page.index, origin, "date", text), "date");
      return;
    }
    if (sub === "signature" || sub === "initials") {
      setFillTool(sub); // nothing chosen yet: the chooser again
      return;
    }
    // Testo (Immagine never stays on).
    if (touch) holdKeyboard(at);
    const label = labelSize(currentLines(page), at);
    const size = label ?? style.size;
    void openWriterAt(page.index, writerOrigin(at, size), "text", undefined, label === null ? {} : { size: label })
      .then(afterOpen, afterOpen);
  };

  const endPress = () => {
    press.current?.off();
    press.current = null;
  };

  const onDown = (e: PointerEvent) => {
    const p = press.current;
    if (p) {
      p.pointers++; // a second finger: a pinch, not a tap
      return;
    }
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const touch = e.pointerType !== "mouse";
    // Touch: the press keeps the focus (and the phone's keyboard) where it is; the tap decides.
    if (touch) e.preventDefault();
    const scroller = layer.current?.closest(".scroller");
    const onScroll = () => {
      if (press.current) press.current.scrolled = true;
    };
    const onOther = (ev: PointerEvent) => {
      if (press.current && ev.pointerId !== press.current.id) press.current.pointers++;
    };
    scroller?.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pointerdown", onOther, true);
    press.current = {
      id: e.pointerId, x: e.clientX, y: e.clientY, at: performance.now(), coarse: touch, pointers: 1, scrolled: false,
      inField: fieldHasFocus(),
      off: () => {
        scroller?.removeEventListener("scroll", onScroll);
        window.removeEventListener("pointerdown", onOther, true);
      },
    };
  };

  const onUp = (e: PointerEvent) => {
    const p = press.current;
    if (!p || e.pointerId !== p.id) return;
    endPress();
    const tapped = isTap({
      dx: e.clientX - p.x, dy: e.clientY - p.y, ms: performance.now() - p.at,
      pointers: p.pointers, scrolled: p.scrolled, coarse: p.coarse,
    });
    if (tapped) tap(pointAt(e.clientX, e.clientY), p.coarse, p.inField);
  };

  const onCancel = (e: PointerEvent) => {
    if (press.current?.id === e.pointerId) endPress(); // the browser took it to scroll
  };

  const onHover = (e: PointerEvent) => {
    if (!CAN_HOVER || e.pointerType !== "mouse") return;
    hoverAt.current = pointAt(e.clientX, e.clientY);
    if (!hoverFrame.current) {
      hoverFrame.current = requestAnimationFrame(() => {
        hoverFrame.current = 0;
        setHover(hoverAt.current);
      });
    }
  };

  const onLeave = () => {
    hoverAt.current = null;
    if (hoverFrame.current) cancelAnimationFrame(hoverFrame.current);
    hoverFrame.current = 0;
    setHover(null);
  };

  /** A tap or click on a text the user wrote: reopen it (or place the signature waiting there). */
  const onAddedClick = (e: MouseEvent, added: AddedText) => {
    if (!fillMode.peek() || editingStopped.peek()) return;
    const pending = pendingPlacement.peek();
    if (pending) {
      const [x0, y0, x1, y1] = added.bbox;
      const at: Point = e.detail > 0 ? pointAt(e.clientX, e.clientY) : [(x0 + x1) / 2, (y0 + y1) / 2];
      void placeSignature(page.index, pending, rectMatrix(signatureRect(page.bounds, pending.kind, aspectOf(pending), at)));
      return;
    }
    if (!isFresh.current) return; // the texts are being read again: a moment, and it is the real one
    if (boxPointer.current !== "mouse" && e.detail > 0) holdKeyboard(added.origin);
    void reopenAdded(page.index, added).then(afterOpen, afterOpen);
  };

  const onBoxPress = (e: PointerEvent) => {
    boxPointer.current = e.pointerType;
    if (e.pointerType !== "mouse") e.preventDefault(); // keep the keyboard up until the writer has it
  };

  const writer = w && w.pageIndex === page.index ? w : null;

  return (
    <div ref={layer} class="fill-layer">
      <div
        class="fill-catcher"
        aria-hidden="true"
        onPointerDown={onDown}
        onPointerUp={onUp}
        onPointerCancel={onCancel}
        onPointerMove={onHover}
        onPointerLeave={onLeave}
      />
      {coarse && (
        <input ref={keeper} class="fill-keeper" type="text" tabIndex={-1} aria-hidden="true" autocomplete="off" />
      )}
      {copies.map((c) => {
        const F = c.size * zoom;
        return (
          <span
            key={c.id}
            class="writer-copy"
            aria-hidden="true"
            style={{
              left: `${(c.origin[0] - page.bounds[0]) * zoom}px`,
              top: `${(c.origin[1] - page.bounds[1]) * zoom - 0.85 * F}px`,
              fontSize: `${F}px`,
              color: inkCss(c.color),
            }}
          >
            {c.text}
          </span>
        );
      })}
      {texts?.map((added) => {
        if (writer?.editing === added.id) return null; // the writer stands for it
        return <AddedBox key={added.id} page={page} zoom={zoom} added={added} onPress={onBoxPress} onOpen={onAddedClick} />;
      })}
      {hover && <Ghost page={page} zoom={zoom} at={hover} sig={sig} sigUrl={sigUrl} />}
      {writer && (
        <TextWriter key={serialOf(writer)} page={page} zoom={zoom} w={writer} takeEarly={takeEarly} onWrite={onWrite} />
      )}
      <span class="sr-only" role="status">{status}</span>
    </div>
  );
}
