// The page organizer around the thumbnails (viewer/Thumbnails.tsx), in its two places:
// - the desktop pages panel (ui/PagesPanel.tsx): the thumbnails, then the action bar while pages
//   are selected (PanelOrganizer);
// - the phone's "Organizza" sheet (ui/PhoneSheets.tsx), full screen: a bar with Undo and Redo, a
//   short hint and "Seleziona" (in "Seleziona": the count, "Tutte" or "Nessuna", and "Fine"),
//   the grid of thumbnails, and in "Seleziona" the action bar (SheetOrganizer). The sheet is a
//   modal: the app's toasts behind it are out of reach (and not read out), so it shows them itself,
//   with their buttons (a delete's "Annulla"); and the app's Ctrl+Z is off while a sheet is open,
//   hence its own Undo and Redo.
// Both carry the organizer's status region: what a move or a turn did, for screen readers.
import { useEffect, useRef } from "preact/hooks";
import { t } from "../../i18n";
import { busy, dismissToast, editingStopped, history, holdToast, toasts, type Toast } from "../../state";
import type { OpenDoc } from "../../viewer/model";
import { PageThumbnails, thumbFocusTarget } from "../../viewer/Thumbnails";
import { redo, undo } from "../actions";
import { ToolButton } from "../Button";
import { rescueFocus } from "../focus";
import { IconClose, IconRedo, IconUndo } from "../icons";
import { shortcuts } from "../media";
import { ActionBar } from "./ActionBar";
import { clearSelection, orgStatus, selectAll, selectedIn, selectedText, selection, selectMode } from "./model";

/** What the organizer says to screen readers (a move, a turn): visually hidden. */
export function OrganizerStatus() {
  const status = orgStatus.value;
  return (
    <div class="sr-only" role="status" aria-live="polite">
      {status && <span key={status.id}>{status.text}</span>}
    </div>
  );
}

/**
 * The desktop panel's organizer: the thumbnails in one column, and the action bar under them.
 * The selection goes with the panel (hidden, another document, the phone layout): one nobody can
 * see must not be what a key acts on.
 */
export function PanelOrganizer({ doc }: { doc: OpenDoc }) {
  useEffect(() => clearSelection, []);
  return (
    <>
      <PageThumbnails doc={doc} variant="list" />
      <ActionBar doc={doc} variant="panel" />
      <OrganizerStatus />
    </>
  );
}

/**
 * One toast inside the sheet: its text, its button, and ✕ (as ui/Toasts.tsx shows it). When it
 * goes with the focus inside, the thumbnails take it.
 */
function SheetToast({ toast }: { toast: Toast }) {
  const action = toast.action;
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => () => {
    if (box.current?.contains(document.activeElement)) rescueFocus(thumbFocusTarget);
  }, []);
  return (
    <div
      ref={box}
      class={`toast toast-${toast.kind}${action ? " has-action" : ""}`}
      onFocusIn={() => holdToast(toast.id, "focus", true)}
      onFocusOut={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) holdToast(toast.id, "focus", false);
      }}
      onPointerEnter={() => holdToast(toast.id, "pointer", true)}
      onPointerLeave={() => holdToast(toast.id, "pointer", false)}
    >
      <p class="toast-text">{toast.text}</p>
      {action && (
        <button
          type="button"
          class="btn toast-action"
          onClick={() => {
            dismissToast(toast.id);
            action.run();
          }}
        >
          {action.label}
        </button>
      )}
      <button type="button" class="btn tool toast-close" aria-label={t("common.close")} title={t("common.close")}
        onClick={() => dismissToast(toast.id)}>
        <IconClose />
      </button>
    </div>
  );
}

/** The app's toasts, in the sheet (the ones behind the modal can be neither seen nor pressed). */
function SheetToasts() {
  const list = toasts.value;
  return (
    <div class="org-toasts">
      <div role="status" aria-live="polite" class="toast-region">
        {list.filter((x) => x.kind !== "error").map((x) => <SheetToast key={x.id} toast={x} />)}
      </div>
      <div role="alert" aria-live="assertive" class="toast-region">
        {list.filter((x) => x.kind === "error").map((x) => <SheetToast key={x.id} toast={x} />)}
      </div>
    </div>
  );
}

/** Undo and Redo, in the sheet (the top bar's are under it, and Ctrl+Z is off while it is open). */
function SheetUndoRedo() {
  const h = history.value;
  const stopped = editingStopped.value;
  return (
    <div class="org-sheet-history">
      <ToolButton icon={<IconUndo />} label={t("toolbar.undo")} tip={t("toolbar.undoTip", { shortcut: shortcuts.undo })}
        disabled={stopped || (!h.canUndo && busy.value !== "edit")} onClick={() => void undo()} />
      <ToolButton icon={<IconRedo />} label={t("toolbar.redo")} tip={t("toolbar.redoTip", { shortcut: shortcuts.redo })}
        disabled={stopped || !h.canRedo} onClick={() => void redo()} />
    </div>
  );
}

/** The bar at the top of the sheet: Undo, Redo, the hint and "Seleziona"; or the selection's count, "Tutte" or "Nessuna", and "Fine". */
function SheetBar({ doc }: { doc: OpenDoc }) {
  if (!selectMode.value) {
    return (
      <div class="org-sheet-bar">
        <SheetUndoRedo />
        <p class="org-sheet-hint">{t("org.hintGrid")}</p>
        <button type="button" class="btn btn-secondary org-sheet-select" title={t("org.selectTip")}
          onClick={() => {
            selectMode.value = true;
            rescueFocus(thumbFocusTarget); // its button goes: on to the pages, to choose them
          }}>
          {t("org.select")}
        </button>
      </div>
    );
  }
  const count = selectedIn(doc, selection.value).length;
  const all = count === doc.pages.length;
  return (
    <div class="org-sheet-bar">
      <p class="org-sheet-count" aria-live="polite">{count ? selectedText(count) : t("org.noneSelected")}</p>
      <button type="button" class="btn btn-secondary"
        onClick={() => {
          if (all) clearSelection();
          else selection.value = selectAll(doc.pages.map((p) => p.key));
        }}>
        {all ? t("org.selectNone") : t("org.selectAll")}
      </button>
      <button type="button" class="btn btn-primary"
        onClick={() => {
          selectMode.value = false;
          clearSelection();
          rescueFocus(() => document.querySelector<HTMLElement>(".org-sheet-select"));
        }}>
        {t("org.done")}
      </button>
    </div>
  );
}

/**
 * The phone's "Organizza" sheet content: `onPick` (a page tapped outside "Seleziona") closes the
 * sheet. Leaving the sheet leaves "Seleziona" and the selection too.
 */
export function SheetOrganizer({ doc, onPick }: { doc: OpenDoc; onPick: () => void }) {
  useEffect(() => () => {
    selectMode.value = false;
    clearSelection();
  }, []);
  return (
    <>
      <SheetBar doc={doc} />
      <div class="org-sheet-body">
        <PageThumbnails doc={doc} variant="grid" onPick={onPick} />
        <SheetToasts />
      </div>
      {selectMode.value && <ActionBar doc={doc} variant="sheet" />}
      <OrganizerStatus />
    </>
  );
}
