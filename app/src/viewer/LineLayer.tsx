// Edit mode overlay of one page: every text line as a subtle hoverable box (a real button),
// and the inline single-line editor over the line being edited.
//
// Rule 1: whole lines only. The editor is prefilled with the full line; Enter or leaving the
// field writes it, Escape cancels, and a download, share, open or update writes it first
// (registerEditor). Vertical lines use the same horizontal editor, placed at their box. Lines
// the engine cannot rewrite (LineInfo.editable false) get a dashed box and no editor.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { LineInfo } from "../engine/protocol";
import { t } from "../i18n";
import { busy, editingLine, registerEditor, showToast } from "../state";
import { replaceLine } from "../ui/actions";
import { ensureLines } from "./lines";
import type { PageModel } from "./model";

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

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
 * from the file, so only letters, digits and spaces are kept.
 */
function fontFamily(line: LineInfo): string {
  const generic = line.mono ? "var(--font-mono)" : line.serif ? "var(--font-serif)" : "var(--font-sans)";
  const base = line.fontName
    .replace(/^[A-Z]{6}\+/, "") // subset tag
    .split(/[-,]/)[0]
    .replace(/(PSMT|PS|MT)$/, "")
    .replace(/[^A-Za-z0-9 ]/g, "")
    .trim();
  if (!base) return generic;
  const spaced = base.replace(/([a-z])([A-Z])/g, "$1 $2");
  return spaced !== base ? `"${base}", "${spaced}", ${generic}` : `"${base}", ${generic}`;
}

function cssColor([r, g, b]: [number, number, number]) {
  const c = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return `rgb(${c(r)} ${c(g)} ${c(b)})`;
}

/**
 * A line the engine cannot rewrite: grey and dashed, with no hover highlight. Inline, so it
 * wins over the .line:hover rule; the keyboard focus outline stays.
 */
const LOCKED_STYLE = {
  borderStyle: "dashed",
  borderColor: "rgba(90, 90, 90, 0.6)",
  background: "transparent",
  cursor: "not-allowed",
};

/** Spaces around a line are not part of it: the engine ignores a change to them. */
const sameText = (a: string, b: string) => a.trim() === b.trim();

function LineEditor({ page, line, zoom }: { page: PageModel; line: LineInfo; zoom: number }) {
  const input = useRef<HTMLInputElement>(null);
  /** Set once the editor is done (cancelled or committed); resolves when that is complete. */
  const done = useRef<Promise<void> | null>(null);
  /** An edit is being written. */
  const writing = useRef(false);
  const startRev = useRef(page.rev.peek());
  const [pending, setPending] = useState(false);

  const close = () => {
    if (editingLine.peek()?.line === line) editingLine.value = null;
  };

  const cancel = () => {
    if (done.current) return;
    done.current = Promise.resolve();
    close();
  };

  /** Write the typed text (Enter, leaving the field, or a download/open asking for it). */
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

  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);

    const unregister = registerEditor({
      changed: () => writing.current || (!done.current && !sameText(el.value, line.text)),
      commit: () => commitRef.current(),
    });
    return () => {
      unregister();
      // Closed from outside (undo/redo, edit mode off): nothing typed is written later, even if
      // the browser fires blur while removing the field.
      if (!done.current) done.current = Promise.resolve();
      // The field had keyboard focus: keep it in the document instead of dropping it to
      // <body>. Back to the line's box when the page stays as it is; when it changed or is
      // about to (an edit, undo or redo running), its boxes are re-read, so to the scroller.
      // (The field is still in the page at this point.)
      if (document.activeElement !== el) return;
      const pageEl = el.closest(".page");
      const scroller = el.closest<HTMLElement>(".scroller");
      const unchanged = page.rev.peek() === startRev.current && busy.peek() === null;
      requestAnimationFrame(() => {
        const active = document.activeElement;
        if (active && active !== document.body) return; // something else took focus meanwhile
        const box = unchanged ? pageEl?.querySelector<HTMLElement>(`[data-line="${line.index}"]`) : null;
        (box ?? scroller)?.focus({ preventScroll: true });
      });
    };
  }, []);

  // The page changed under the editor (undo/redo elsewhere): its line index is stale.
  const rev = page.rev.value;
  useEffect(() => {
    if (rev !== startRev.current && !done.current) {
      done.current = Promise.resolve();
      close();
    }
  }, [rev]);

  const box = lineBox(page, line, zoom);
  const fontSize = Math.max(4, line.size * zoom);
  const height = Math.max(box.height, fontSize * 1.3);
  const style = {
    left: `${box.left}px`,
    top: `${box.top - (height - box.height) / 2}px`,
    height: `${height}px`,
    minWidth: `${Math.max(box.width, fontSize * 2)}px`,
    maxWidth: `${Math.max(page.width * zoom - box.left, fontSize * 4)}px`,
    fontSize: `${fontSize}px`,
    fontFamily: fontFamily(line),
    fontWeight: line.bold ? "700" : "400",
    fontStyle: line.italic ? "italic" : "normal",
    color: cssColor(line.color),
  };

  return (
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
      onBlur={() => void commit()}
    />
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
        const pos = { left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px` };
        const locked = line.editable === false;
        return (
          <button
            type="button"
            key={line.index}
            class={locked ? "line is-locked" : "line"}
            data-line={line.index}
            style={locked ? { ...pos, ...LOCKED_STYLE } : pos}
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
