// The overlay of one page in Modifica with Bianchetto ("whiteout") or Oscura ("redact"): where an
// area is marked, then waits, as a box with handles and its context bar, until it is applied.
//
// Marking an area: with a mouse, press and drag (3 px) anywhere on the page draws a rectangle; a
// click on a text line makes a box over the line, from the line's quad along its direction at any
// angle (lineQuad), shrunk across it (areasForQuads, as core.js's replaceText shrinks its quads) so
// the lines above and below keep their letters: a turned line's area goes as the thin pieces
// areasForQuads cuts it in, the box showing their bounds, until it is moved or resized (then it
// takes the plain rectangle it shows; the preview always asks about what goes); a click on the
// empty page drops the waiting box, or does nothing (the hint says what to do). On touch screens
// one finger still scrolls the page (the catcher keeps touch-action: pan-x pan-y) and two fingers
// still zoom it (gestures.ts): a tap on a line makes the line's box, a tap on the empty page puts
// a default box there (50 × 8 mm), or first drops the one waiting. From the keyboard each line is
// a Tab stop ("Oscura la riga: …"), and "Metti al centro" in the banner puts a default box in the
// middle of what shows (ui/redact/pending.ts).
//
// The waiting box (ui/redact/pending.ts) writes nothing. It has the image frame's handles (44 px
// on touch, however thin the box, with the round grip to move it; with a mouse the box itself
// drags, and edge handles show on long sides), a second finger cancels a gesture, and it is an
// "application" for screen readers: the arrows move it (1 pt, Shift 10 pt), Alt with the arrows
// changes its width or height, Enter applies, Esc or Delete cancels. Its context bar has
// [Annulla] [Sbianca | Oscura] and, once the engine has said (previewFor, asked again a moment
// after the box stops moving), what goes
// ("Toglie: «…»"), the warnings (a picture only covered, with "Usa Oscura"; a picture turned black
// and the file growing; fields, links and comments; a drawing crossing the edge; attached files),
// or, instead of the apply button, why the engine refuses the area (said again on Enter). The
// notes region is always there (empty until the preview), so what comes into it is heard. On a
// phone the banner keeps to its hint, and the bar says the banner's note ("Nel file che scarichi…")
// where the decision is made, until something is redacted in the document. Applying is one edit
// (redactNow), said in this layer's status region (the same words again are said again); the box
// goes with its page's new revision. When the box goes with the keyboard focus (applied,
// cancelled), the focus goes to its line's box, or the nearest line's, once the page shows its
// lines (after an apply they are read again: the scroller meanwhile), else to the scroller, never
// to <body> (refocusLine, in the layout effect after the render the box went in: no frame waited for).
// Styled by styles/redact.css (the handles and the grip are the image frame's: viewer.css).
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { LineInfo, Rect, RedactMode, RedactPreview } from "../engine/protocol";
import { areasForQuads, clampAreas } from "../engine/redactGeometry";
import { formatMm, t } from "../i18n";
import { busy, history } from "../state";
import { rescueFocus, viewerScroller } from "../ui/focus";
import { IconCheck, IconClose, IconMove } from "../ui/icons";
import { isCoarse, isNarrow } from "../ui/media";
import { previewFor, redactNow } from "../ui/redact/actions";
import {
  boundsOfRects, clipToPage, defaultBox, handlePoint, isUsable, lineQuad, moveBox, rectBetween, resizeBox, stretchBox,
} from "../ui/redact/geometry";
import { cancelPendingRedact, markArea, moveArea, pendingRedact, useRedactInstead, type PendingRedact } from "../ui/redact/pending";
import { previewNotes, refusalText } from "../ui/redact/texts";
import { px, rectBox } from "./FillLayer";
import { pagePoint, type Handle, type Point } from "./imageGeometry";
import { ensureLines } from "./lines";
import type { PageModel } from "./model";

const CORNERS: Handle[] = ["nw", "ne", "se", "sw"];
const EDGES: Handle[] = ["n", "e", "s", "w"];
const CURSORS: Record<Handle, string> = {
  nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize",
  n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize",
};
const ARROWS: Record<string, Point> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
/** A press becomes a drag past this many px: a mouse a little, a finger as far as a browser's touch slop (as ImageLayer). */
const DRAG_THRESHOLD_MOUSE = 3;
const DRAG_THRESHOLD_TOUCH = 10;
/** Arrow keys move or stretch the box by 1 pt, with Shift by 10 pt. */
const NUDGE = 1;
const NUDGE_FAR = 10;
/** The preview is asked for once the box has been still this long (ms). */
const PREVIEW_DELAY = 250;
/** Edge handles show only on sides at least this long on screen (px), as on the image frame. */
const EDGE_HANDLE_MIN = 48;
/** Touch: the grip goes below a box shorter or narrower than this on screen (px), clear of its corner targets. */
const GRIP_INSIDE_MIN = 88;
/** Px the handles take round the box (and the grip below a small one), kept clear of the context bar. */
const HANDLE_ROOM_FINE = 8;
const GRIP_ROOM = 90;
const BAR_GAP = 8;
/** Touch: a corner target's side (px), however thin the box (redact.css); it reaches `reach` px into the box, the rest out. */
const CORNER_TARGET = 44;
const reach = (side: number) => Math.max(0, Math.min(22, side / 2 - 2));
/**
 * The context bar goes below the box, growing down with its notes, when the page has this much
 * room (px) below it; else on the side with more room.
 */
const BAR_BELOW_MIN = 220;
/** The last status said (RedactLayer): each one a new key. */
let statusId = 0;

/**
 * The area a click on `line` marks: the line's quad shrunk across it, as the pieces areasForQuads
 * cuts it in (one for a line along the page's axes), on the page.
 */
export function lineArea(line: Pick<LineInfo, "bbox" | "dir" | "size">, bounds: Rect): Rect[] {
  const pieces = clampAreas(areasForQuads([lineQuad(line)]), bounds);
  return pieces.length ? pieces : [clipToPage(line.bbox, bounds)];
}

/**
 * The waiting box went with the keyboard focus, from the box of line `line` (null: none): the
 * focus goes to that line's box in `layer`, or the nearest line's, else to the scroller; nothing
 * when it is somewhere else by then (not <body>, not the scroller this put it on). False while
 * `linesShown` is false and the line's box may still come (the page's lines being read again):
 * call again once they show.
 */
export function refocusLine(layer: ParentNode | null, line: number | null, linesShown: boolean): boolean {
  const scroller = viewerScroller();
  const active = document.activeElement;
  if (active && active !== document.body && active !== scroller) return true;
  let target: HTMLElement | null = null;
  let gap = Infinity;
  if (line !== null) {
    for (const box of layer?.querySelectorAll<HTMLElement>(".redact-line") ?? []) {
      const d = Math.abs(Number(box.dataset.redactLine) - line);
      if (d < gap) [target, gap] = [box, d];
    }
  }
  if (target) {
    target.focus({ preventScroll: true });
    return true;
  }
  if (active !== scroller) scroller?.focus({ preventScroll: true });
  return linesShown || line === null;
}

interface Gesture {
  kind: Handle | "move";
  pointerId: number;
  el: Element;
  threshold: number;
  startX: number;
  startY: number;
  start: Point;
  /** Resize: from the pointer to the handle's exact point, so the edge does not jump to the pointer. */
  grab: Point;
  r0: Rect;
  started: boolean;
  target: Rect;
  off: () => void;
}

function AreaBox({ page, zoom, box, mode, onDone, onFocusGone }: {
  page: PageModel; zoom: number; box: PendingRedact; mode: RedactMode; onDone: (text: string) => void;
  /** It goes with the keyboard focus, from the box of line `line` (null: none). */
  onFocusGone: (line: number | null) => void;
}) {
  const el = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const coarse = isCoarse.value;
  /** Where a gesture is taking the box (shown, not marked yet). */
  const [live, setLive] = useState<Rect | null>(null);
  const [dragging, setDragging] = useState(false);
  const [writing, setWriting] = useState(false);
  const [preview, setPreview] = useState<{ key: string; value: RedactPreview | null } | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const latest = useRef({ box, zoom, writing });
  latest.current = { box, zoom, writing };

  const pending = writing || busy.value === "edit";
  const rect = live ?? box.rect;
  const bounds = page.bounds;

  // --- Gestures (handles, the touch grip, the box itself with a mouse) ---------------------------

  const pointAt = (x: number, y: number): Point => {
    const r = el.current?.closest<HTMLElement>(".page")?.getBoundingClientRect() ?? { left: 0, top: 0 };
    return pagePoint(x, y, r, [bounds[0], bounds[1]], latest.current.zoom);
  };

  const targetOf = (g: Gesture, x: number, y: number): Rect => {
    const p = pointAt(x, y);
    if (g.kind === "move") return moveBox(g.r0, p[0] - g.start[0], p[1] - g.start[1], bounds);
    return resizeBox(g.r0, g.kind, [p[0] + g.grab[0], p[1] + g.grab[1]], bounds);
  };

  const endGesture = (): Gesture | null => {
    const g = gesture.current;
    if (!g) return null;
    gesture.current = null;
    g.off();
    setDragging(false);
    return g;
  };

  /** Escape, a second finger, a pointer the browser took: the box stays where it was. */
  const cancelGesture = () => {
    if (endGesture()) setLive(null);
  };

  const startGesture = (e: PointerEvent, kind: Gesture["kind"]) => {
    if (gesture.current || latest.current.writing) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (!e.isPrimary) return; // a second finger: the pinch zooms
    const target = e.currentTarget as Element;
    if (e.pointerType === "mouse") e.preventDefault(); // no text selection, no native drag
    el.current?.focus({ preventScroll: true });
    try {
      target.setPointerCapture(e.pointerId);
    } catch {
      return; // the pointer is gone already
    }
    const r0 = latest.current.box.rect;
    const start = pointAt(e.clientX, e.clientY);
    const at = kind === "move" ? start : handlePoint(r0, kind);
    const onKey = (k: KeyboardEvent) => {
      if (k.key !== "Escape") return;
      k.preventDefault();
      k.stopPropagation(); // only the gesture is cancelled, not the box
      cancelGesture();
    };
    const onOther = (p: PointerEvent) => {
      if (p.pointerId !== e.pointerId) cancelGesture();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onOther, true);
    gesture.current = {
      kind, pointerId: e.pointerId, el: target,
      threshold: e.pointerType === "mouse" ? DRAG_THRESHOLD_MOUSE : DRAG_THRESHOLD_TOUCH,
      startX: e.clientX, startY: e.clientY, start, grab: [at[0] - start[0], at[1] - start[1]], r0, started: false, target: r0,
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
    g.target = targetOf(g, e.clientX, e.clientY);
    setLive(g.target);
  };

  const onPointerUp = (e: PointerEvent) => {
    const g = gesture.current;
    if (!g || e.pointerId !== g.pointerId) return;
    const started = g.started;
    const target = started ? targetOf(g, e.clientX, e.clientY) : g.target;
    endGesture();
    try {
      if (g.el.hasPointerCapture(g.pointerId)) g.el.releasePointerCapture(g.pointerId);
    } catch {
      // The pointer is gone already.
    }
    setLive(null);
    const now = pendingRedact.peek();
    if (started && now?.id === latest.current.box.id) moveArea(now, target);
  };

  const onPointerCancel = (e: PointerEvent) => {
    if (gesture.current?.pointerId === e.pointerId) cancelGesture();
  };

  /** The box itself drags with a mouse (or any pointer where pointers are fine); on touch the page scrolls. */
  const onBoxDown = (e: PointerEvent) => {
    if (gesture.current) return; // a handle inside took it
    if (coarse && e.pointerType !== "mouse") return;
    startGesture(e, "move");
  };

  useEffect(() => () => cancelGesture(), []);

  // --- Preview, apply, cancel ----------------------------------------------------------------

  const key = `${mode}|${box.rects.join(";")}`;
  useEffect(() => {
    if (dragging) return;
    let gone = false;
    const timer = setTimeout(() => {
      void previewFor([{ pageIndex: page.index, rects: box.rects }], mode).then((value) => {
        if (!gone) setPreview({ key, value });
      });
    }, PREVIEW_DELAY);
    return () => {
      gone = true;
      clearTimeout(timer);
    };
  }, [key, dragging]);
  const known = preview?.key === key ? preview.value : null;
  const refused = known?.refused ?? null;
  const facts = known?.pages.find((p) => p.pageIndex === page.index) ?? null;
  const notes = refused ? [] : previewNotes(facts, mode, known?.attachments ?? 0);

  const apply = async () => {
    const now = pendingRedact.peek();
    if (latest.current.writing || now?.id !== latest.current.box.id) return;
    if (refused) {
      onDone(refusalText(refused.reason)); // Enter: why again, for whoever did not hear it come
      return;
    }
    setWriting(true);
    const pageNo = page.index + 1;
    const done = await redactNow([{ pageIndex: page.index, rects: now.rects }], mode, { revs: new Map([[page, now.rev]]) });
    setWriting(false);
    if (!done) return;
    onDone(t(mode === "redact" ? "redact.doneRedact" : "redact.doneWhiteout", { page: pageNo }));
    if (pendingRedact.peek()?.id === now.id) cancelPendingRedact(); // (it goes with the page's new revision anyway)
  };

  const cancel = () => {
    if (!latest.current.writing) cancelPendingRedact();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" || e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      e.stopPropagation(); // not also "back to Cambia" (ui/shortcuts.ts)
      if (gesture.current) cancelGesture();
      else cancel();
      return;
    }
    if (e.ctrlKey || e.metaKey) return; // Ctrl + / − zoom, Ctrl+Z undoes
    if (e.key === "Enter") {
      e.preventDefault();
      if (!e.repeat) void apply();
      return;
    }
    const dir = ARROWS[e.key];
    if (!dir) return;
    e.preventDefault(); // arrows must not scroll the page, nor Alt + ← go back a page
    if (gesture.current || latest.current.writing) return;
    // From the box as it is now: a key repeating faster than the renders adds up.
    const now = pendingRedact.peek();
    if (now?.id !== latest.current.box.id) return;
    const step = e.shiftKey ? NUDGE_FAR : NUDGE;
    moveArea(now, e.altKey
      ? stretchBox(now.rect, dir[0] * step, dir[1] * step, bounds)
      : moveBox(now.rect, dir[0] * step, dir[1] * step, bounds));
  };

  const onBarKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    cancel();
  };

  // --- Focus ---------------------------------------------------------------------------------

  // Made from the keyboard, with a mouse or moved here: the box takes the focus.
  useLayoutEffect(() => {
    if (box.focus) el.current?.focus({ preventScroll: true });
  }, [box.id, box.focus]);

  // Going with the focus inside (applied, cancelled, the page changed): the layer puts it back (refocusLine).
  useLayoutEffect(() => {
    const node = el.current;
    return () => {
      const active = document.activeElement;
      if (node && (active === node || (active && bar.current?.contains(active)))) onFocusGone(latest.current.box.line);
    };
  }, []);

  // --- Render --------------------------------------------------------------------------------

  const b = rectBox(page, rect, zoom);
  const helpId = `redact-keys-${page.index}`;
  const notesId = `redact-notes-${page.index}`;
  const gripOutside = coarse && Math.min(b.width, b.height) < GRIP_INSIDE_MIN;
  const room = coarse ? CORNER_TARGET - reach(b.height) : HANDLE_ROOM_FINE;
  const pageHeight = page.height * zoom;
  const roomBelow = pageHeight - (b.top + b.height);
  const above = roomBelow < BAR_BELOW_MIN && b.top > roomBelow;
  // Above: the bar grows up from just above the box; below: down from under it (and the grip).
  const slot = above
    ? { bottom: `${pageHeight - (b.top - room - BAR_GAP)}px` }
    : { top: `${b.top + b.height + (gripOutside ? GRIP_ROOM : room) + BAR_GAP}px` };
  const style = { ...px(b), ...(coarse ? { "--reach-x": `${reach(b.width)}px`, "--reach-y": `${reach(b.height)}px` } : {}) };
  const edges = coarse ? [] : EDGES.filter((h) => (h === "n" || h === "s" ? b.width : b.height) >= EDGE_HANDLE_MIN);
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
  const [x0, y0, x1, y1] = box.rect;
  // A phone's banner keeps to its hint: its note is said here, until something is redacted.
  const phoneNote = isNarrow.value && !refused && !((history.value.redactions ?? 0) > 0);

  return (
    <>
      <div
        ref={el}
        class={["redact-box", `is-${mode}`, pending && "is-pending", dragging && "is-dragging"].filter(Boolean).join(" ")}
        style={style}
        tabIndex={0}
        role="application"
        aria-roledescription={t(mode === "redact" ? "redact.roleRedact" : "redact.roleWhiteout")}
        aria-label={t("redact.boxLabel", { w: formatMm(x1 - x0), h: formatMm(y1 - y0), page: page.index + 1 })}
        aria-describedby={`${helpId} ${notesId}`}
        aria-busy={pending}
        onPointerDown={onBoxDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onLostPointerCapture={onPointerCancel}
        onKeyDown={onKeyDown}
      >
        {edges.map(handle)}
        {CORNERS.map(handle)}
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
      <span id={helpId} hidden>{t("redact.keysHelp")}</span>
      <div class={["context-slot", !above && "is-below", dragging && "is-hidden"].filter(Boolean).join(" ")} style={slot}>
        <span class="context-indent" style={{ flexBasis: `${Math.max(0, b.left)}px` }} />
        <div ref={bar} class="context-bar redact-bar" role="group" aria-label={t("redact.toolbar")} onKeyDown={onBarKeyDown}>
          <div id={notesId} class="redact-notes" aria-live="polite">
            {refused && <p class="redact-note is-refused">{refusalText(refused.reason)}</p>}
            {notes.map((note) => (
              <p key={note.text} class={`redact-note is-${note.kind}`}>
                <span>{note.text}</span>
                {note.useRedact && (
                  <button type="button" class="btn redact-use" onClick={() => void useRedactInstead()}>{t("redact.useRedact")}</button>
                )}
              </p>
            ))}
            {phoneNote && <p class="redact-note is-info">{t("edit.redactNote")}</p>}
          </div>
          <div class="redact-row">
            <span class={writing ? "context-writing" : "sr-only"} role="status">
              {writing && (
                <>
                  <span class="spinner" aria-hidden="true" />
                  {t("edit.writing")}
                </>
              )}
            </span>
            {!writing && (
              <>
                <button type="button" class="btn context-btn" title={t("edit.cancelTip", { key: t("key.esc") })} onClick={cancel}>
                  <IconClose />
                  <span>{t("edit.cancel")}</span>
                </button>
                {!refused && (
                  <button
                    type="button"
                    class="btn btn-primary context-btn"
                    title={t("edit.applyTip", { key: t("key.enter") })}
                    aria-disabled={pending || undefined}
                    onClick={() => void apply()}
                  >
                    <IconCheck />
                    <span>{t(mode === "redact" ? "redact.applyRedact" : "redact.applyWhiteout")}</span>
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

interface Draw {
  pointerId: number;
  el: Element;
  x: number;
  y: number;
  start: Point;
  started: boolean;
}

export function RedactLayer({ page, zoom, mode }: { page: PageModel; zoom: number; mode: RedactMode }) {
  const rev = page.rev.value;
  const cached = page.lines.value;
  const waiting = pendingRedact.value;
  const box = waiting && waiting.page === page ? waiting : null;
  const layer = useRef<HTMLDivElement>(null);
  /** The rectangle being dragged out with the mouse (page space). */
  const [drawing, setDrawing] = useState<Rect | null>(null);
  /** What the status region says, keyed by `id` so that the same words said again are heard again. */
  const [status, setStatus] = useState<{ id: number; text: string } | null>(null);
  const say = (text: string) => setStatus({ id: ++statusId, text });
  /** The waiting box went with the keyboard focus, from the box of this line (null: none): refocusLine has not placed it yet. */
  const refocus = useRef<{ line: number | null } | null>(null);
  const draw = useRef<Draw | null>(null);
  /** The kind of the last pointer pressed here (a click event does not always say). */
  const lastPointer = useRef("mouse");
  /** A drag just ended: the click that follows it is not a click. */
  const drew = useRef(false);

  useEffect(() => {
    ensureLines(page);
  }, [page, rev, cached]);

  // The layer goes (another sub-tool, Modifica off) with the focus on one of its boxes: to the scroller.
  useLayoutEffect(() => {
    const node = layer.current;
    return () => {
      if (node?.contains(document.activeElement)) rescueFocus(viewerScroller);
    };
  }, []);

  const lines = cached && cached.rev === rev ? cached.lines : null;

  // After the render the waiting box went in (its DOM is gone, the focus on <body>), and after the
  // one that shows the page's lines again: the focus to its line's box.
  useLayoutEffect(() => {
    if (refocus.current && refocusLine(layer.current, refocus.current.line, lines !== null)) refocus.current = null;
  });

  const pointAt = (x: number, y: number): Point => {
    const r = layer.current?.getBoundingClientRect() ?? { left: 0, top: 0 };
    return pagePoint(x, y, r, [page.bounds[0], page.bounds[1]], zoom);
  };

  // --- Drawing with the mouse ----------------------------------------------------------------

  const onDown = (e: PointerEvent) => {
    lastPointer.current = e.pointerType;
    if (e.pointerType !== "mouse" || e.button !== 0 || draw.current) return;
    e.preventDefault(); // no text selection
    const el = e.currentTarget as Element;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      return;
    }
    draw.current = { pointerId: e.pointerId, el, x: e.clientX, y: e.clientY, start: pointAt(e.clientX, e.clientY), started: false };
  };

  const onMove = (e: PointerEvent) => {
    const d = draw.current;
    if (!d || e.pointerId !== d.pointerId) return;
    if (!d.started && Math.hypot(e.clientX - d.x, e.clientY - d.y) < DRAG_THRESHOLD_MOUSE) return;
    d.started = true;
    setDrawing(clipToPage(rectBetween(d.start, pointAt(e.clientX, e.clientY)), page.bounds));
  };

  const onUp = (e: PointerEvent) => {
    const d = draw.current;
    if (!d || e.pointerId !== d.pointerId) return;
    draw.current = null;
    setDrawing(null);
    if (!d.started) return; // a click: the click decides
    drew.current = true;
    setTimeout(() => { drew.current = false; }, 0);
    const r = clipToPage(rectBetween(d.start, pointAt(e.clientX, e.clientY)), page.bounds);
    if (isUsable(r)) markArea(page, r, { focus: true });
  };

  const onCancel = (e: PointerEvent) => {
    if (draw.current?.pointerId !== e.pointerId) return;
    draw.current = null;
    setDrawing(null);
  };

  // --- Clicks and taps -----------------------------------------------------------------------

  const onEmptyClick = (e: MouseEvent) => {
    if (drew.current) return;
    if (cancelPendingRedact()) return; // a click away drops the waiting box
    if (lastPointer.current === "mouse") return; // with a mouse: drag, or click a line (the hint says so)
    markArea(page, defaultBox(pointAt(e.clientX, e.clientY), page.bounds));
  };

  const onLineClick = (e: MouseEvent, line: LineInfo) => {
    if (drew.current) return;
    const fromKeys = e.detail === 0;
    const rects = lineArea(line, page.bounds);
    const shown = boundsOfRects(rects);
    if (shown) markArea(page, shown, { rects, line: line.index, focus: fromKeys || lastPointer.current === "mouse" });
  };

  const handlers = { onPointerDown: onDown, onPointerMove: onMove, onPointerUp: onUp, onPointerCancel: onCancel };
  const lineKey = mode === "redact" ? "redact.lineRedact" : "redact.lineWhiteout";

  return (
    <div ref={layer} class="redact-layer">
      <div class="redact-catcher" aria-hidden="true" onClick={onEmptyClick} {...handlers} />
      {lines?.map((line) => {
        if (!line.text.trim()) return null;
        const b = rectBox(page, line.bbox, zoom);
        return (
          <button
            type="button"
            key={line.index}
            class="redact-line"
            data-redact-line={line.index}
            style={px(b)}
            aria-label={t(lineKey, { text: line.text.replace(/\s+/g, " ").trim() })}
            onClick={(e) => onLineClick(e, line)}
            {...handlers}
          />
        );
      })}
      {drawing && <div class={`redact-drawing is-${mode}`} aria-hidden="true" style={px(rectBox(page, drawing, zoom))} />}
      {box && (
        <AreaBox
          key={box.id}
          page={page}
          zoom={zoom}
          box={box}
          mode={mode}
          onDone={say}
          onFocusGone={(line) => { refocus.current = { line }; }}
        />
      )}
      <span class="sr-only" role="status">{status && <span key={status.id}>{status.text}</span>}</span>
    </div>
  );
}
