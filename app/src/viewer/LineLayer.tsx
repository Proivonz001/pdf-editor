// Edit mode overlay of one page (Modifica with Cambia): every text line as a highlighter-tinted
// box (a real button), and, over the line being edited, the inline single-line editor with its
// context bar.
//
// Rule 1: whole lines only. The editor is prefilled with the full line; Enter, Apply or leaving
// the field writes it, Escape or Cancel cancels, and a download, share, open, close, update or
// leaving edit mode writes it first (registerEditor). Vertical lines use the same horizontal
// editor, placed at their box.
// Lines the engine cannot rewrite (LineInfo.editable false) get a dashed box and no editor. Lines
// the user wrote (in Compila e firma, or with Aggiungi testo: LineInfo.added) get a dotted
// underline instead of the solid one, as the fill layer marks them; they are edited the same way.
// When the layer goes with the focus on a line's box (Modifica off, or on to Aggiungi testo), the
// focus goes on to the scroller, not to <body>.
//
// The context bar belongs to the editor: pressing it never takes the focus from the field (a
// blur would write the line before Cancel could run), and tabbing from the field into the bar
// does not count as leaving the field. It floats above the line, or below it when there is no
// room above (on the page or on screen) and more below; when it fits on neither side (a short
// page, a low zoom), on the side with more room, counting on screen only what the pages' box does
// not clip (viewer.css .pages: past the margin above the first page and below the last). Sideways
// it stays inside the page box.
//
// Decorations: when the editor opens it asks the engine, without waiting, what follows the line's
// text if it is edited (underlines, strike-throughs and links do so by themselves; a background
// or border round the text is an option). The answer goes in editingDecorations, for the details
// panel. When there is a background to offer, the bar gets a toggle that looks like a check box:
// "Allunga anche lo sfondo" ("Togli anche lo sfondo" while the field is empty: the line will be
// deleted), ticked as the engine suggests. It comes on a row of its own, on the side of the bar
// away from the line, at least as wide as the buttons' row and wider only as far as the page and
// the screen leave room, its words wrapping in what room there is: they are never cut, the bar is
// never narrower than Cancel and Apply, and those do not move under the finger when the answer
// comes (the bar's side and place are chosen for that row from the start, with its words wrapped
// as the tallest of them would be at its width: barRoom, barAcross, optionHeight). A write before
// the answer, or after an engine that could not say, lets the engine do as it suggests.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { LineDecorations, LineEditOptions, LineInfo } from "../engine/protocol";
import { formatFontSize, t } from "../i18n";
import { busy, editingDecorations, editingLine, engine, registerEditor, showToast } from "../state";
import { openLine, replaceLine } from "../ui/actions";
import { rescueFocus, viewerScroller } from "../ui/focus";
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
/** Px between the line and its context bar: the editor's ring and the gap after it. */
export const BAR_OFFSET = RING + BAR_GAP;
/** The context bar's border and padding, both sides together (px), as in viewer.css. */
const BAR_CHROME = 8;
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

/**
 * The background option's words (LineDecorations.box: a background, a border, or both): it
 * stretches them with the new text, or, `removing` (the field is empty: the line goes), removes
 * them with it. Always shown whole (they wrap on a narrow bar): they are also the toggle's name.
 */
export function boxOptionText(box: { fill: boolean; stroke: boolean }, removing: boolean): string {
  const what = box.fill && box.stroke ? "Both" : box.stroke ? "Border" : "Background";
  return t(`deco.${removing ? "remove" : "stretch"}${what}`);
}

/**
 * Every set of words the background option can show, in the current language: for a background, a
 * border or both, stretched or removed. The engine says which only after the bar is placed, and the
 * field may be emptied at any time, so the bar is placed for the tallest of them (optionHeight).
 */
export function boxOptionTexts(): string[] {
  const kinds = [{ fill: true, stroke: false }, { fill: false, stroke: true }, { fill: true, stroke: true }];
  return [false, true].flatMap((removing) => kinds.map((kind) => boxOptionText(kind, removing)));
}

/**
 * The height (px) the context bar is placed for: its row of buttons (36, 44 on touch screens, as
 * in viewer.css), the gap and the row the background option gets if the engine offers one:
 * `option` px tall, its words wrapped as they will be (optionHeight, measured when the bar is
 * placed); without it, one line of words (the row's minimum height). The engine answers after the
 * bar is placed, so its side of the line is chosen for both rows from the start: the option's
 * coming never flips the bar, and Cancel and Apply stay where they were.
 */
export function barRoom(coarse: boolean, option?: number): number {
  return (coarse ? 44 : 36) + 4 + (option ?? (coarse ? 36 : 28));
}

/**
 * Whether the context bar, with the option's row of `option` px (barRoom), fits in the `room` px
 * above the line.
 */
export function barFitsAbove(room: number, coarse: boolean, option?: number): boolean {
  return room >= BAR_OFFSET + barRoom(coarse, option);
}

/**
 * Whether the context bar goes under the line: not enough room above it for the bar (barRoom,
 * with the option's row of `option` px) and more room below (so it goes below when it fits there,
 * and to the side with more room when it fits on neither). `above` and `below` are the px between
 * the line and the edges of what shows of the viewer (shownBand), or of the line's page.
 */
export function barGoesBelow(above: number, below: number, coarse: boolean, option?: number): boolean {
  return !barFitsAbove(above, coarse, option) && below > above;
}

/**
 * Where on screen (px, top and bottom) the context bar can be seen: what shows of the viewer
 * (`view`), within the box of the pages (`pages`), which clips what stands out of it (viewer.css
 * .pages): past the margin above the first page, and below the last page when the document ends
 * on screen. Scrolling cannot bring a clipped part into view, so that room does not count.
 */
export function shownBand(
  view: { top: number; bottom: number }, pages?: { top: number; bottom: number },
): { top: number; bottom: number } {
  if (!pages) return { top: view.top, bottom: view.bottom };
  return { top: Math.max(view.top, pages.top), bottom: Math.min(view.bottom, pages.bottom) };
}

/**
 * How tall (px) the background option's row would be in the context bar `barEl` with the tallest
 * of `texts` (boxOptionTexts), at the width it gets there: as wide as the row of buttons
 * (`rowWidth`, px) and wider, up to `room` (barAcross's optionRoom), as far as its words need. Set
 * in a hidden copy of the option (viewer.css: .is-probe) that is taken out again at once.
 */
export function optionHeight(barEl: HTMLElement, texts: string[], rowWidth: number, room: number): number {
  const probe = document.createElement("span");
  probe.className = "btn context-btn context-option is-probe";
  probe.setAttribute("aria-hidden", "true");
  // As the option's min-width (the bar's width, which the row of buttons sets) and max-width.
  probe.style.minWidth = `${rowWidth}px`;
  probe.style.maxWidth = `${Math.max(rowWidth, room)}px`;
  probe.appendChild(document.createElement("span")).className = "context-option-box";
  const words = probe.appendChild(document.createElement("span"));
  words.className = "context-option-text";
  barEl.appendChild(probe);
  let tallest = 0;
  for (const text of texts) {
    words.textContent = text;
    tallest = Math.max(tallest, probe.getBoundingClientRect().height);
  }
  probe.remove();
  return Math.ceil(tallest);
}

/**
 * Where the context bar goes sideways (screen px). `left`: its left edge, at the line's (`wanted`)
 * unless that would take it within VIEW_EDGE of an edge of what shows of the viewer (`view`).
 * `optionRoom`: the widest the background option's row may make the bar (its content), up to the
 * right edge of the page or of the view, whichever comes first; the slot keeps the bar on the page,
 * so this starts where the bar really is. `width` is the bar with its row of buttons alone, so
 * neither changes when the option comes: it never moves the bar, its words wrap in less room.
 */
export function barAcross(
  wanted: number, width: number, view: { left: number; right: number }, page: { left: number; right: number },
): { left: number; optionRoom: number } {
  const left = Math.max(view.left + VIEW_EDGE, Math.min(wanted, view.right - VIEW_EDGE - width));
  const placed = Math.max(page.left, Math.min(left, page.right - width));
  const optionRoom = Math.max(0, Math.floor(Math.min(page.right, view.right - VIEW_EDGE) - placed) - BAR_CHROME);
  return { left, optionRoom };
}

/**
 * The choices sent with the edit: whether the background follows the text too, only when the
 * option was offered (`info.box`); otherwise none, and the engine does as it suggests.
 */
export function lineEditOptions(info: LineDecorations | null, box: boolean): LineEditOptions | undefined {
  return info?.box ? { box } : undefined;
}

/**
 * Ask the engine what follows `line` of `page` if it is edited (its decorations), for the editor
 * that opened on it at page revision `rev`. When the answer comes, and only if the page is still
 * at `rev` and `stillOpen()`, it goes in editingDecorations (for the details panel) and is
 * returned. Otherwise, or when the engine could not say (told in the console only: the editor
 * works as it does without decorations), null.
 */
export async function askDecorations(
  page: PageModel, line: LineInfo, rev: number, stillOpen: () => boolean,
): Promise<LineDecorations | null> {
  let info: LineDecorations;
  try {
    info = await engine().lineDecorations(page.index, line.index);
  } catch (e) {
    console.warn("The line's decorations could not be read", e);
    return null;
  }
  if (!stillOpen() || page.rev.peek() !== rev) return null;
  editingDecorations.value = { pageIndex: page.index, lineIndex: line.index, rev, info };
  return info;
}

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
  /** The widest (px) the background option's row may make the context bar (barAcross); 0 until placed. */
  const [optionRoom, setOptionRoom] = useState(0);
  /** How tall (px) that row would be with its tallest words (optionHeight); one line until placed. */
  const [optionTall, setOptionTall] = useState<number | undefined>(undefined);
  /** The last optionHeight measured and what for, so a scroll does not measure again. */
  const measured = useRef<{ key: string; height: number } | null>(null);
  /** What follows the line if it is edited, once the engine has said (askDecorations). */
  const [decorations, setDecorations] = useState<LineDecorations | null>(null);
  /** The background option is ticked (shown when decorations.box is offered); tickedRef for commit. */
  const [ticked, setTicked] = useState(false);
  const tickedRef = useRef(false);
  /** The field is empty: the line will be deleted, and the option says so. */
  const [empty, setEmpty] = useState(() => line.text.trim() === "");

  const close = () => {
    if (editingLine.peek()?.line === line) editingLine.value = null;
  };

  const cancel = () => {
    if (done.current) return;
    done.current = Promise.resolve();
    close();
  };

  /** The focus is in the context bar (it got there with Tab). */
  const focusInBar = () => !!bar.current?.contains(document.activeElement);

  /** Write the typed text (Enter, Apply, leaving the field, or a download/open asking for it). */
  const commit = (): Promise<void> => {
    if (done.current) return done.current;
    const text = input.current?.value ?? line.text;
    // Only the option changed: not an edit, as with the same text.
    if (sameText(text, line.text)) {
      done.current = Promise.resolve();
      close();
      return done.current;
    }
    // "Writing…" takes the place of the bar's buttons: with the focus on one of them (Apply, the
    // option, from the keyboard), hand it back to the field first, so it is not lost (and goes
    // back to the line afterwards).
    if (focusInBar()) input.current?.focus({ preventScroll: true });
    writing.current = true;
    setPending(true);
    const options = lineEditOptions(decorations, tickedRef.current);
    done.current = replaceLine(page, line, text, startRev.current, options)
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

  /** The background option: ticked or not. Not an edit by itself, and never writes. */
  const toggleOption = () => {
    tickedRef.current = !tickedRef.current;
    setTicked(tickedRef.current);
  };

  /**
   * Keep the context bar on screen: under the line when the line is too close to the top of the
   * viewport (and there is more room below it, within the pages' box: shownBand), and shifted
   * sideways when the line starts near (or past) an edge of it. Worked out from the field's
   * position alone, so it can run again after a zoom or a scroll.
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
    // For the bar's planned size and its row of buttons' width, not its size now: the background
    // option's row may come, and then it only grows the bar away from the line, by as many lines
    // as its words take at its width, and to the right, as far as optionRoom.
    const coarse = isCoarse.peek();
    const row = barEl.querySelector<HTMLElement>(".context-row");
    const p = field.closest<HTMLElement>(".page")?.getBoundingClientRect();
    const wanted = f.left - RING;
    const across = barAcross(
      wanted, row ? row.offsetWidth + BAR_CHROME : barEl.offsetWidth,
      { left: viewLeft, right: viewRight }, p ?? { left: -Infinity, right: Infinity },
    );
    const room = p ? across.optionRoom : 0;
    // While the edit is written the row holds "Writing…" alone and the option cannot come: the bar
    // keeps the height it was placed for.
    let tall = measured.current?.height;
    if (row && !writing.current) {
      const texts = boxOptionTexts();
      const rowWidth = row.getBoundingClientRect().width;
      const key = [rowWidth, room, coarse, ...texts].join("\n");
      if (measured.current?.key !== key) {
        measured.current = { key, height: optionHeight(barEl, texts, rowWidth, room) };
      }
      tall = measured.current.height;
    }
    // Above and below, only what the pages' box does not clip counts (a short document ends on
    // screen: the room under its last page is not the viewer's).
    const shown = shownBand(
      { top: viewTop, bottom: viewBottom }, field.closest<HTMLElement>(".pages")?.getBoundingClientRect(),
    );
    setNudge(Math.round(across.left - wanted));
    setOptionRoom(room);
    setOptionTall(tall);
    setFlip(barGoesBelow(f.top - shown.top, shown.bottom - f.bottom, coarse, tall));
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

  // What follows the line if it is edited: asked once, without waiting (the field works at once;
  // the engine answers after what is already in its queue, renders say). Kept only while this
  // editor is open on the page as it opened; forgotten when it closes.
  useEffect(() => {
    let open = true;
    void askDecorations(page, line, startRev.current, () => open && !done.current).then((info) => {
      if (!info || !open) return;
      tickedRef.current = info.box?.suggested ?? false;
      setTicked(tickedRef.current);
      setDecorations(info);
    });
    return () => {
      open = false;
      const mine = editingDecorations.peek();
      if (mine && mine.pageIndex === page.index && mine.lineIndex === line.index && mine.rev === startRev.current) {
        editingDecorations.value = null;
      }
    };
  }, []);

  // The option, when the engine offers one. Its row neither moves the bar nor changes its side
  // (barRoom, barAcross, optionHeight), so the bar is not placed again when it comes.
  const offered = decorations?.box ?? null;

  // The page changed under the editor (undo/redo elsewhere): its line index is stale.
  const rev = page.rev.value;
  useEffect(() => {
    if (rev !== startRev.current && !done.current) {
      done.current = Promise.resolve();
      close();
    }
  }, [rev]);

  // From the keyboard the focus is on Apply, which the "writing" state replaces: commit hands it
  // back to the field first.
  const apply = () => void commit();

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

  // Context bar: above the field unless it would leave the page (or the screen) there, with the
  // option's row that may come, its words wrapped (barRoom, optionTall), and there is more room
  // below: on a page too short for it on either side, on the side with more room.
  const above = top - BAR_OFFSET;
  const below = flip || barGoesBelow(top, page.height * zoom - (top + height), isCoarse.value, optionTall);
  const slot = below
    ? { top: `${top + height + RING + BAR_GAP}px` }
    : { bottom: `${page.height * zoom - above}px` };
  const fontInfo = t("edit.fontInfo", {
    font: fontDisplayName(line.fontName) || t("details.fontUnknown"),
    size: formatFontSize(line.size),
  });
  const showFont = pageWidth >= FONT_CHIP_MIN_PAGE;
  const option = offered ? boxOptionText(offered, empty) : null;

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
        onInput={(e) => setEmpty(e.currentTarget.value.trim() === "")}
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
          class={showFont ? "context-bar line-bar has-font" : "context-bar line-bar"}
          style={{ "--option-room": `${optionRoom}px` }}
          role="toolbar"
          aria-label={t("edit.inputLabel")}
          onPointerDown={keepFocus}
          onMouseDown={keepFocus}
          onKeyDown={onBarKeyDown}
          onFocusOut={onBarFocusOut}
        >
          {/* The background option: a toggle (a button, so the bar's arrow keys reach it) that looks
              like a check box, on a row of its own, away from the line (viewer.css). */}
          {option && !pending && (
            <button type="button" class="btn context-btn context-option" aria-pressed={ticked} onClick={toggleOption}>
              <span class="context-option-box" aria-hidden="true">{ticked && <IconCheck />}</span>
              <span class="context-option-text">{option}</span>
            </button>
          )}
          <div class="context-row">
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
      </div>
    </>
  );
}

export function LineLayer({ page, zoom }: { page: PageModel; zoom: number }) {
  const rev = page.rev.value;
  const cached = page.lines.value;
  const editing = editingLine.value;
  const layer = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ensureLines(page);
  }, [page, rev, cached]);

  // The layer goes (another tool, or Aggiungi testo) while a line's box has the focus: on to the
  // scroller. (The open editor hands its own focus on itself.)
  useLayoutEffect(() => {
    const node = layer.current;
    return () => {
      if (node?.contains(document.activeElement)) rescueFocus(viewerScroller);
    };
  }, []);

  // Stale lines (the page changed) are hidden until they are read again.
  const lines = cached && cached.rev === rev ? cached.lines : null;
  const editingHere = editing && editing.pageIndex === page.index ? editing.line : null;

  return (
    <div ref={layer} class="lines">
      {lines?.map((line) => {
        if (line === editingHere) return null;
        const b = lineBox(page, line, zoom);
        const locked = line.editable === false;
        return (
          <button
            type="button"
            key={line.index}
            class={locked ? "line is-locked" : line.added ? "line is-added" : "line"}
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
              void openLine(page.index, line); // deselects the selected image too
            }}
          />
        );
      })}
      {editingHere && <LineEditor key={editingHere.index} page={page} line={editingHere} zoom={zoom} />}
    </div>
  );
}
