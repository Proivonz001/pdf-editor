// Edit mode overlay of one page: every text line as a highlighter-tinted box (a real button),
// and, over the line being edited, the inline single-line editor with its context bar.
//
// Rule 1: whole lines only. The editor is prefilled with the full line; Enter, Apply or leaving
// the field writes it, Escape or Cancel cancels, and a download, share, open, close, update or
// leaving edit mode writes it first (registerEditor). Vertical lines use the same horizontal
// editor, placed at their box.
// Lines the engine cannot rewrite (LineInfo.editable false) get a dashed box and no editor.
//
// The context bar belongs to the editor: pressing it never takes the focus from the field (a
// blur would write the line before Cancel could run), and tabbing from the field into the bar
// does not count as leaving the field. It floats above the line, or below it when there is no
// room above (on the page or on screen), and stays inside the page box.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { LineInfo } from "../engine/protocol";
import { formatFontSize, t } from "../i18n";
import { busy, editingLine, registerEditor, showToast } from "../state";
import { replaceLine } from "../ui/actions";
import { IconCheck, IconClose, IconFont } from "../ui/icons";
import { isCoarse } from "../ui/media";
import { fontDisplayName, fontRawFamily } from "./fontName";
import { ensureLines } from "./lines";
import type { PageModel } from "./model";

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The editor's yellow ring (the box-shadow spread of .line-editor in viewer.css), in px. */
const RING = 5;
/** Space between that ring (the visible edge of the editor) and the context bar. */
const BAR_GAP = 8;
/** Closest the context bar comes to the sides of the viewport when it is moved to stay in view. */
const VIEW_EDGE = 8;
/** On narrower pages the context bar leaves the font out, so its buttons keep their room. */
const FONT_CHIP_MIN_PAGE = 360;
/**
 * Touch screens: the field's text is never smaller than this (px), even when the line is tiny at
 * the current zoom. Smaller text is hard to read on a phone, and iOS zooms the whole page in
 * when a field with smaller text gets the focus.
 */
const MIN_TOUCH_FONT = 16;

/** Line bbox (page space, points) → px inside the page element. */
function lineBox(page: PageModel, line: LineInfo, zoom: number): Box {
  const [x0, y0, x1, y1] = line.bbox;
  return {
    left: (x0 - page.bounds[0]) * zoom,
    top: (y0 - page.bounds[1]) * zoom,
    width: Math.max(1, (x1 - x0) * zoom),
    height: Math.max(1, (y1 - y0) * zoom),
  };
}

/**
 * CSS font-family for a line: the PDF font's family name first (in case it is installed, so
 * the editor looks like the page), then a generic family from the line's flags. The name comes
 * from the file, so only letters, digits and spaces are kept (see fontName.ts).
 */
function fontFamily(line: LineInfo): string {
  const generic = line.mono ? "var(--font-mono)" : line.serif ? "var(--font-serif)" : "var(--font-sans)";
  const base = fontRawFamily(line.fontName);
  if (!base) return generic;
  const spaced = fontDisplayName(line.fontName);
  return spaced !== base ? `"${base}", "${spaced}", ${generic}` : `"${base}", ${generic}`;
}

function cssColor([r, g, b]: [number, number, number]) {
  const c = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return `rgb(${c(r)} ${c(g)} ${c(b)})`;
}

/** Spaces around a line are not part of it: the engine ignores a change to them. */
const sameText = (a: string, b: string) => a.trim() === b.trim();

/** Pressing the context bar must leave the focus (and the caret) in the field. */
const keepFocus = (e: Event) => e.preventDefault();

function LineEditor({ page, line, zoom }: { page: PageModel; line: LineInfo; zoom: number }) {
  const input = useRef<HTMLInputElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  /** Set once the editor is done (cancelled or committed); resolves when that is complete. */
  const done = useRef<Promise<void> | null>(null);
  /** An edit is being written. */
  const writing = useRef(false);
  const startRev = useRef(page.rev.peek());
  const [pending, setPending] = useState(false);
  /** The context bar goes under the line: no room for it above, on screen. */
  const [flip, setFlip] = useState(false);
  /** Sideways shift (px) that keeps the context bar inside the viewport. */
  const [nudge, setNudge] = useState(0);

  const close = () => {
    if (editingLine.peek()?.line === line) editingLine.value = null;
  };

  const cancel = () => {
    if (done.current) return;
    done.current = Promise.resolve();
    close();
  };

  /** Write the typed text (Enter, Apply, leaving the field, or a download/open asking for it). */
  const commit = (): Promise<void> => {
    if (done.current) return done.current;
    const text = input.current?.value ?? line.text;
    if (sameText(text, line.text)) {
      done.current = Promise.resolve();
      close();
      return done.current;
    }
    writing.current = true;
    setPending(true);
    done.current = replaceLine(page, line, text, startRev.current)
      .catch((e: unknown) => console.error(e))
      .then(() => {
        writing.current = false;
        close();
      });
    return done.current;
  };

  // The latest commit, for the rest of the app (flushEditor / hasUnsavedWork in state.ts).
  const commitRef = useRef(commit);
  commitRef.current = commit;

  /** The focus is in the context bar (it got there with Tab). */
  const focusInBar = () => !!bar.current?.contains(document.activeElement);

  /**
   * Keep the context bar on screen: under the line when the line is too close to the top of the
   * viewport (and there is more room below it), and shifted sideways when the line starts near
   * (or past) an edge of it. Worked out from the field's position alone, so it can run again
   * after a zoom or a scroll.
   */
  const place = () => {
    const field = input.current;
    const barEl = bar.current;
    const scroller = field?.closest<HTMLElement>(".scroller");
    if (!field || !barEl || !scroller) return;
    const s = scroller.getBoundingClientRect();
    const f = field.getBoundingClientRect();
    // What is visible of the scroller: without its scrollbars, and (phones) within the visual
    // viewport, which the on-screen keyboard shrinks and may pan.
    const vv = window.visualViewport;
    const viewTop = Math.max(s.top, vv ? vv.offsetTop : -Infinity);
    const viewBottom = Math.min(s.top + scroller.clientHeight, vv ? vv.offsetTop + vv.height : Infinity);
    const viewLeft = Math.max(s.left, vv ? vv.offsetLeft : -Infinity);
    const viewRight = Math.min(s.left + scroller.clientWidth, vv ? vv.offsetLeft + vv.width : Infinity);
    if (f.bottom <= viewTop || f.top >= viewBottom || f.right <= viewLeft || f.left >= viewRight) return;
    const roomAbove = f.top - viewTop;
    setFlip(roomAbove < RING + BAR_GAP + barEl.offsetHeight && viewBottom - f.bottom > roomAbove);
    const wanted = f.left - RING;
    const left = Math.max(viewLeft + VIEW_EDGE, Math.min(wanted, viewRight - VIEW_EDGE - barEl.offsetWidth));
    setNudge(Math.round(left - wanted));
  };

  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
    place(); // after focus(), which may have scrolled the field into view
    const barEl = bar.current;

    // Scrolling (by hand, or the browser bringing the field above the on-screen keyboard) and the
    // keyboard itself can take the room above the line away: place the bar again, once per
    // frame at most.
    const scroller = el.closest<HTMLElement>(".scroller");
    const viewport: EventTarget = window.visualViewport ?? window;
    let frame = 0;
    const onMove = () => {
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; place(); });
    };
    scroller?.addEventListener("scroll", onMove, { passive: true });
    viewport.addEventListener("resize", onMove);
    viewport.addEventListener("scroll", onMove);

    const unregister = registerEditor({
      changed: () => writing.current || (!done.current && !sameText(el.value, line.text)),
      commit: () => commitRef.current(),
    });
    return () => {
      unregister();
      scroller?.removeEventListener("scroll", onMove);
      viewport.removeEventListener("resize", onMove);
      viewport.removeEventListener("scroll", onMove);
      if (frame) cancelAnimationFrame(frame);
      // Closed from outside (undo/redo, edit mode off): nothing typed is written later, even if
      // the browser fires blur while removing the field.
      if (!done.current) done.current = Promise.resolve();
      // The field (or its context bar) had keyboard focus: keep it in the document instead of
      // dropping it to <body>. Back to the line's box when the page stays as it is; when it
      // changed or is about to (an edit, undo or redo running), its boxes are re-read, so to the
      // scroller. (The field is still in the page at this point.)
      const active = document.activeElement;
      if (active !== el && !(active && barEl?.contains(active))) return;
      const pageEl = el.closest(".page");
      const unchanged = page.rev.peek() === startRev.current && busy.peek() === null;
      requestAnimationFrame(() => {
        const now = document.activeElement;
        if (now && now !== document.body) return; // something else took focus meanwhile
        const box = unchanged ? pageEl?.querySelector<HTMLElement>(`[data-line="${line.index}"]`) : null;
        (box ?? scroller)?.focus({ preventScroll: true });
      });
    };
  }, []);

  // A zoom moves the line: place the bar again once the viewer has re-anchored the scroll.
  useEffect(() => {
    const frame = requestAnimationFrame(place);
    return () => cancelAnimationFrame(frame);
  }, [zoom]);

  // The page changed under the editor (undo/redo elsewhere): its line index is stale.
  const rev = page.rev.value;
  useEffect(() => {
    if (rev !== startRev.current && !done.current) {
      done.current = Promise.resolve();
      close();
    }
  }, [rev]);

  const apply = () => {
    // From the keyboard the focus is on Apply, which the "writing" state replaces: hand it back
    // to the field first, so it is not lost (and goes back to the line afterwards).
    if (focusInBar()) input.current?.focus({ preventScroll: true });
    void commit();
  };

  const onBarKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation(); // not also "leave edit mode" (ui/shortcuts.ts)
      cancel();
      return;
    }
    // The bar is part of the field: as there, Ctrl+Z / Ctrl+Y are not the document's undo and
    // redo (which would close the editor and drop what was typed without a word).
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
    const next = e.relatedTarget as Node | null;
    if (next && (next === input.current || bar.current?.contains(next))) return;
    void commit(); // the focus left the editor: the same as leaving the field
  };

  const box = lineBox(page, line, zoom);
  const fontSize = Math.max(isCoarse.value ? MIN_TOUCH_FONT : 4, line.size * zoom);
  const height = Math.max(box.height, fontSize * 1.3);
  const top = box.top - (height - box.height) / 2;
  const pageWidth = page.width * zoom;
  const style = {
    left: `${box.left}px`,
    top: `${top}px`,
    height: `${height}px`,
    minWidth: `${Math.max(box.width, fontSize * 2)}px`,
    maxWidth: `${Math.max(pageWidth - box.left, fontSize * 4)}px`,
    fontSize: `${fontSize}px`,
    fontFamily: fontFamily(line),
    fontWeight: line.bold ? "700" : "400",
    fontStyle: line.italic ? "italic" : "normal",
    color: cssColor(line.color),
  };

  // Context bar: above the field unless it would leave the page (or the screen) there.
  const barHeight = isCoarse.value ? 44 : 36; // as in viewer.css
  const above = top - RING - BAR_GAP;
  const below = flip || above - barHeight < 0;
  const slot = below
    ? { top: `${top + height + RING + BAR_GAP}px` }
    : { bottom: `${page.height * zoom - above}px` };
  const fontInfo = t("edit.fontInfo", {
    font: fontDisplayName(line.fontName) || t("details.fontUnknown"),
    size: formatFontSize(line.size),
  });
  const showFont = pageWidth >= FONT_CHIP_MIN_PAGE;

  return (
    <>
      <input
        ref={input}
        class={`line-editor${pending ? " is-pending" : ""}`}
        type="text"
        defaultValue={line.text}
        size={Math.max(4, line.text.length + 1)}
        style={style}
        readOnly={pending}
        aria-busy={pending}
        aria-label={t("edit.inputLabel")}
        autocomplete="off"
        spellcheck={false}
        enterKeyHint="done"
        onKeyDown={(e) => {
          if (e.isComposing || e.keyCode === 229) return; // IME composition in progress
          if (e.key === "Enter") {
            e.preventDefault();
            void commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            cancel();
          }
        }}
        onBlur={(e) => {
          if (bar.current?.contains(e.relatedTarget as Node | null)) return; // Tab into the bar
          void commit();
        }}
      />
      {/* The slot spans the page; the indent before the bar shrinks so the bar stays on it. */}
      <div class={below ? "context-slot is-below" : "context-slot"} style={slot}>
        <span class="context-indent" style={{ flexBasis: `${Math.max(0, box.left - RING + nudge)}px` }} />
        <div
          ref={bar}
          class={showFont ? "context-bar has-font" : "context-bar"}
          role="toolbar"
          aria-label={t("edit.inputLabel")}
          onPointerDown={keepFocus}
          onMouseDown={keepFocus}
          onKeyDown={onBarKeyDown}
          onFocusOut={onBarFocusOut}
        >
          {showFont && (
            <>
              <span class="context-font" title={fontInfo}>
                <IconFont />
                <span class="context-font-text">{fontInfo}</span>
              </span>
              <span class="context-sep" aria-hidden="true" />
            </>
          )}
          {/* Always in the page, so screen readers announce "Writing…" when it fills in. */}
          <span class={pending ? "context-writing" : "sr-only"} role="status">
            {pending && (
              <>
                <span class="spinner" aria-hidden="true" />
                {t("edit.writing")}
              </>
            )}
          </span>
          {!pending && (
            <>
              <button
                type="button"
                class="btn context-btn"
                title={t("edit.cancelTip", { key: t("key.esc") })}
                onClick={cancel}
              >
                <IconClose />
                <span>{t("edit.cancel")}</span>
              </button>
              <button
                type="button"
                class="btn btn-primary context-btn"
                title={t("edit.applyTip", { key: t("key.enter") })}
                onClick={apply}
              >
                <IconCheck />
                <span>{t("edit.apply")}</span>
              </button>
            </>
          )}
        </div>
      </div>
    </>
  );
}

export function LineLayer({ page, zoom }: { page: PageModel; zoom: number }) {
  const rev = page.rev.value;
  const cached = page.lines.value;
  const editing = editingLine.value;

  useEffect(() => {
    ensureLines(page);
  }, [page, rev, cached]);

  // Stale lines (the page changed) are hidden until they are read again.
  const lines = cached && cached.rev === rev ? cached.lines : null;
  const editingHere = editing && editing.pageIndex === page.index ? editing.line : null;

  return (
    <div class="lines">
      {lines?.map((line) => {
        if (line === editingHere) return null;
        const b = lineBox(page, line, zoom);
        const locked = line.editable === false;
        return (
          <button
            type="button"
            key={line.index}
            class={locked ? "line is-locked" : "line"}
            data-line={line.index}
            style={{ left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px` }}
            aria-label={t(locked ? "edit.lockedLabel" : "edit.lineLabel", { text: line.text })}
            aria-disabled={locked || undefined}
            onClick={() => {
              if (locked) {
                showToast("info", t("edit.notEditable"));
                return;
              }
              if (busy.peek() === "edit") return; // the previous edit is still being written
              editingLine.value = { pageIndex: page.index, line };
            }}
          />
        );
      })}
      {editingHere && <LineEditor key={editingHere.index} page={page} line={editingHere} zoom={zoom} />}
    </div>
  );
}
