// The organizer's action bar: what can be done with the selected pages. Ruota a destra (90°) and
// a sinistra, Duplica, Estrai (a new PDF with them, downloaded), Sposta in posizione… (the
// keyboard and screen-reader way to move them, and a precise one: the move-pages dialog),
// Elimina. Elimina stays in the Tab order but does nothing when it would delete every page
// (aria-disabled, with the reason as its description and in a toast when pressed). Once editing
// has stopped, only Estrai is left (a download still works).
// - "panel" (desktop, under the thumbnails): the count and Deseleziona, then icon buttons with
//   tooltips, in rows of three (the panel is 168 px wide);
// - "sheet" (the phone's "Organizza", in "Seleziona"): one row of icons over short labels (their
//   names say the whole action: "Ruota a destra" shows "Destra").
// After an action that takes the focused button away (the last selected pages deleted), the
// focus goes to the thumbnails.
import type { ComponentChildren } from "preact";
import { useId } from "preact/hooks";
import { t } from "../../i18n";
import { editingStopped, showToast } from "../../state";
import { thumbFocusTarget } from "../../viewer/Thumbnails";
import type { OpenDoc, PageModel } from "../../viewer/model";
import { rescueFocus } from "../focus";
import { IconClose, IconCopy, IconPageExtract, IconPageMove, IconRotate, IconRotateLeft, IconTrash } from "../icons";
import {
  askMovePages, deletePages, duplicatePages, extractPages, rotatePages,
} from "./commands";
import { canDelete, clearSelection, selectedIn, selectedText, selection } from "./model";

function Action(p: {
  icon: ComponentChildren;
  label: string;
  /** The visible label in the sheet (the name above says it whole). */
  short?: string;
  tip?: string;
  sheet: boolean;
  /** It does nothing now (it says why, `reason`), but keeps the focus. */
  blocked?: boolean;
  reason?: string;
  danger?: boolean;
  opensDialog?: boolean;
  onClick: () => void;
}) {
  const reasonId = useId();
  const cls = ["btn", "tool", "org-action", p.sheet && "has-label", p.danger && "is-danger"].filter(Boolean).join(" ");
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
        onClick={() => {
          if (p.blocked) {
            if (p.reason) showToast("info", p.reason);
            return;
          }
          p.onClick();
        }}
      >
        {p.icon}
        {p.sheet && <span class="org-action-label" aria-hidden="true">{p.short ?? p.label}</span>}
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
 * The bar for the selected pages of `doc`. "panel": shown only while some are selected; "sheet":
 * always (the phone's "Seleziona" is on), its buttons doing nothing until a page is selected.
 */
export function ActionBar({ doc, variant }: { doc: OpenDoc; variant: "panel" | "sheet" }) {
  const pages = selectedIn(doc, selection.value); // (reads doc.pages: follows page operations)
  const sheet = variant === "sheet";
  const stopped = editingStopped.value;
  if (!pages.length && !sheet) return null;
  const none = pages.length === 0;
  const total = doc.pages.length;
  const deleteBlocked = !canDelete(pages.length, total);
  const keepOne = pages.length >= total ? t("pageOps.keepOne") : undefined;
  return (
    <div class={`org-bar org-bar-${variant}`} role="toolbar" aria-label={t("org.actions")}>
      {!sheet && (
        <div class="org-bar-head">
          <span class="org-bar-count">{selectedText(pages.length)}</span>
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
        </div>
      )}
      <div class="org-bar-actions">
        {!stopped && (
          <>
            <Action icon={<IconRotate />} label={t("org.rotateRight")} short={t("org.rotateRightShort")} sheet={sheet}
              blocked={none} onClick={() => run((p) => rotatePages(p, 90), pages)} />
            <Action icon={<IconRotateLeft />} label={t("org.rotateLeft")} short={t("org.rotateLeftShort")} sheet={sheet}
              blocked={none} onClick={() => run((p) => rotatePages(p, 270), pages)} />
            <Action icon={<IconCopy />} label={t("org.duplicate")} sheet={sheet} blocked={none}
              onClick={() => run(duplicatePages, pages)} />
          </>
        )}
        <Action icon={<IconPageExtract />} label={t("org.extract")} tip={t("org.extractTip")} sheet={sheet} blocked={none}
          onClick={() => run(extractPages, pages)} />
        {!stopped && (
          <>
            <Action icon={<IconPageMove />} label={t("org.move")} short={t("org.moveShort")} sheet={sheet} blocked={none}
              opensDialog onClick={() => askMovePages(pages)} />
            <Action icon={<IconTrash />} label={t("org.delete")} sheet={sheet} danger blocked={deleteBlocked}
              reason={keepOne} onClick={() => run(deletePages, pages)} />
          </>
        )}
      </div>
    </div>
  );
}
