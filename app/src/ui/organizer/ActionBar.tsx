// The organizer's action bar: what can be done with the selected pages. Ruota a destra (90°) and
// a sinistra, Duplica, Estrai (a new PDF with them, downloaded), Sposta in posizione… (the
// keyboard and screen-reader way to move them, and a precise one: the move-pages dialog),
// Elimina. Elimina stays in the Tab order but does nothing when it would delete every page
// (aria-disabled, with the reason as its description and in a toast when pressed). Once editing
// has stopped, only Estrai is left (a download still works). Each icon has a short label under it
// (its name says the whole action: "Ruota a destra" shows "Destra").
// - "panel" (desktop, under the thumbnails): always there while the panel is open (release 6:
//   deleting a page in plain sight). With pages selected: the count and Deseleziona, then the
//   actions for them; with none: "Pagina N" and the actions for the page shown (the current page).
//   In rows of three (the panel is 168 px wide);
// - "sheet" (the phone's "Organizza", in "Seleziona"): one row, its buttons doing nothing until a
//   page is selected.
// After an action that takes the focused button away, the focus goes to the thumbnails: the last
// selected pages deleted, the panel's bar turns to the page shown with buttons made anew (keyed by
// what they act on), so a focused Elimina never silently moves on to a page nobody chose. The
// second click of a double-click on Elimina does nothing: the first may have moved it on already;
// nor does a held Enter (the key's repeats activate no button, ignoreRepeat): one press, one action.
import type { ComponentChildren } from "preact";
import { useId } from "preact/hooks";
import { t } from "../../i18n";
import { editingStopped, showToast } from "../../state";
import { thumbFocusTarget } from "../../viewer/Thumbnails";
import type { OpenDoc, PageModel } from "../../viewer/model";
import { rescueFocus } from "../focus";
import { IconClose, IconCopy, IconPageExtract, IconPageMove, IconRotate, IconRotateLeft, IconTrash } from "../icons";
import {
  askMovePages, deletePages, duplicatePages, extractPages, rotatePages, shownPage,
} from "./commands";
import { canDelete, clearSelection, selectedIn, selectedText, selection } from "./model";

/** A held Enter or Space activates nothing more: Elimina with nothing selected would delete page after page. */
export function ignoreRepeat(e: KeyboardEvent) {
  if (e.repeat && (e.key === "Enter" || e.key === " ")) e.preventDefault();
}

function Action(p: {
  icon: ComponentChildren;
  label: string;
  /** The visible label (the name above says it whole). */
  short?: string;
  tip?: string;
  /** It does nothing now (it says why, `reason`), but keeps the focus. */
  blocked?: boolean;
  reason?: string;
  danger?: boolean;
  opensDialog?: boolean;
  onClick: (e: MouseEvent) => void;
}) {
  const reasonId = useId();
  const cls = ["btn", "tool", "org-action", "has-label", p.danger && "is-danger"].filter(Boolean).join(" ");
  return (
    <>
      <button
        type="button"
        class={cls}
        aria-label={p.label}
        title={p.blocked && p.reason ? p.reason : p.tip ?? p.label}
        aria-disabled={p.blocked || undefined}
        aria-describedby={p.blocked && p.reason ? reasonId : undefined}
        aria-haspopup={p.opensDialog ? "dialog" : undefined}
        onKeyDown={ignoreRepeat}
        onClick={(e) => {
          if (p.blocked) {
            if (p.reason) showToast("info", p.reason);
            return;
          }
          p.onClick(e);
        }}
      >
        {p.icon}
        <span class="org-action-label" aria-hidden="true">{p.short ?? p.label}</span>
      </button>
      {p.blocked && p.reason && <span id={reasonId} class="sr-only">{p.reason}</span>}
    </>
  );
}

/** Run `action` on `pages`; if the focus fell to <body> meanwhile (its button went), the thumbnails take it. */
function run(action: (pages: PageModel[]) => Promise<unknown> | void, pages: PageModel[]) {
  void Promise.resolve(action(pages)).finally(() => rescueFocus(thumbFocusTarget));
}

/**
 * The bar for the selected pages of `doc`. "panel": with none selected, for the page shown;
 * "sheet": its buttons doing nothing until a page is selected (the phone's "Seleziona" is on).
 */
export function ActionBar({ doc, variant }: { doc: OpenDoc; variant: "panel" | "sheet" }) {
  const selected = selectedIn(doc, selection.value); // (reads doc.pages: follows page operations)
  const sheet = variant === "sheet";
  const stopped = editingStopped.value;
  const current = sheet || selected.length ? null : shownPage(doc);
  const pages = current ? [current] : selected;
  const none = pages.length === 0;
  const total = doc.pages.length;
  const deleteBlocked = !canDelete(pages.length, total);
  const keepOne = pages.length >= total ? t("pageOps.keepOne") : undefined;
  const pageName = current && t("viewer.page", { page: current.index + 1 });
  return (
    <div class={`org-bar org-bar-${variant}`} role="toolbar" aria-label={pageName || t("org.actions")}>
      {!sheet && (
        <div class="org-bar-head">
          <span class="org-bar-count">{pageName || selectedText(pages.length)}</span>
          {!current && (
            <button
              type="button"
              class="btn tool org-bar-clear"
              aria-label={t("org.deselect")}
              title={t("org.deselect")}
              onClick={() => {
                clearSelection();
                rescueFocus(thumbFocusTarget);
              }}
            >
              <IconClose />
            </button>
          )}
        </div>
      )}
      {/* Keyed: when a delete empties the selection, the focused button goes and the focus is rescued (run). */}
      <div class="org-bar-actions" key={current ? "page" : "selection"}>
        {!stopped && (
          <>
            <Action icon={<IconRotate />} label={t("org.rotateRight")} short={t("org.rotateRightShort")}
              blocked={none} onClick={() => run((p) => rotatePages(p, 90), pages)} />
            <Action icon={<IconRotateLeft />} label={t("org.rotateLeft")} short={t("org.rotateLeftShort")}
              blocked={none} onClick={() => run((p) => rotatePages(p, 270), pages)} />
            <Action icon={<IconCopy />} label={t("org.duplicate")} blocked={none}
              onClick={() => run(duplicatePages, pages)} />
          </>
        )}
        <Action icon={<IconPageExtract />} label={t("org.extract")} tip={t("org.extractTip")} blocked={none}
          onClick={() => run(extractPages, pages)} />
        {!stopped && (
          <>
            <Action icon={<IconPageMove />} label={t("org.move")} short={t("org.moveShort")} blocked={none}
              opensDialog onClick={() => askMovePages(pages)} />
            <Action icon={<IconTrash />} label={t("org.delete")} danger blocked={deleteBlocked}
              reason={keepOne} onClick={(e) => {
                if (e.detail < 2) run(deletePages, pages); // a double-click deletes once
              }} />
          </>
        )}
      </div>
    </div>
  );
}
