// "Sposta in posizione…" (the `move-pages` dialog): where the selected pages go, before page N or
// at the end, chosen from a list. The keyboard and screen-reader way to move pages (dragging has
// it as its alternative, with Alt+↑/↓ for one place), and a precise one in a long document. The
// pages keep their order; a place where they already are is said, and "Sposta" waits for another.
// A page operation can land while it is open (one asked before it, an undo): the pages it moves
// and the place chosen are held by their PageModels (commands.movingPages, a GapPlace), so its
// title, its list and "Sposta" follow them; when none of its pages is left, it closes.
import { useEffect, useId, useState } from "preact/hooks";
import { t } from "../../i18n";
import { doc, showDialog, type DialogState } from "../../state";
import { Dialog } from "../Dialog";
import { moveOrder } from "../pageActions";
import { movePagesBefore, movingPages } from "./commands";
import { gapOfPlace, placeOfGap, type GapPlace } from "./model";

/** The places pages can go in a document of `count` pages: before page 1 … before page `count`, then the end (`count`). */
export function movePositions(count: number): { before: number; label: string }[] {
  const places = Array.from({ length: count }, (_, k) => ({ before: k, label: t("org.moveBefore", { page: k + 1 }) }));
  places.push({ before: count, label: t("org.moveEnd") });
  return places;
}

/** Moving `pages` (indices) before `before` changes nothing: they are there already. */
export function moveIsNoop(count: number, pages: readonly number[], before: number): boolean {
  return moveOrder(count, pages, before).every((o, k) => o === k);
}

/** Where the dialog starts: the end, or the start when the pages are at the end already. */
export function defaultBefore(count: number, pages: readonly number[]): number {
  return moveIsNoop(count, pages, count) ? 0 : count;
}

export function MovePagesDialog({ state }: { state: Extract<DialogState, { kind: "move-pages" }> }) {
  const d = doc.value;
  const count = d?.pages.length ?? 0; // (reads d.layout: drawn again when the pages change)
  const models = movingPages(state);
  const pages = models.map((p) => p.index);
  /** The place chosen, held by the page it is before (null page: the end). */
  const [place, setPlace] = useState<GapPlace | null>(() => (d ? placeOfGap(d.pages, defaultBefore(count, pages)) : null));
  const before = d && place ? gapOfPlace(d.pages, place) : count;
  const fieldId = useId();
  const noteId = useId();
  const close = () => showDialog(null);
  const gone = !d || !pages.length;
  useEffect(() => {
    if (gone) close(); // the document went meanwhile, or the pages did: nothing to move
  }, [gone]);
  if (gone) return null;
  const one = pages.length === 1;
  const noop = moveIsNoop(count, pages, before);
  const submit = (e: Event) => {
    e.preventDefault();
    if (noop) return;
    close();
    void movePagesBefore(models, before);
  };
  return (
    <Dialog labelledBy="dlg-title" describedBy="dlg-body" onCancel={close}>
      <form class="dialog-form" onSubmit={submit} noValidate>
        <div class="dialog-text">
          <h2 id="dlg-title" class="dialog-title">
            {one ? t("org.moveTitleOne", { page: pages[0] + 1 }) : t("org.moveTitle", { count: pages.length })}
          </h2>
          <p id="dlg-body" class="dialog-body">{one ? t("org.moveBodyOne") : t("org.moveBody")}</p>
        </div>
        <div class="field-group">
          <label class="field-label" for={fieldId}>{t("org.movePosition")}</label>
          <select
            id={fieldId}
            class="field"
            data-autofocus
            value={String(before)}
            aria-describedby={noop ? noteId : undefined}
            onChange={(e) => setPlace(placeOfGap(d.pages, Number(e.currentTarget.value)))}
          >
            {movePositions(count).map((p) => <option key={p.before} value={String(p.before)}>{p.label}</option>)}
          </select>
          {noop && <p id={noteId} class="dl-hint">{one ? t("org.moveNoopOne") : t("org.moveNoop")}</p>}
        </div>
        <div class="dialog-actions">
          <button type="button" class="btn btn-secondary" onClick={close}>{t("common.cancel")}</button>
          <button type="submit" class="btn btn-primary" disabled={noop}>{t("org.moveConfirm")}</button>
        </div>
      </form>
    </Dialog>
  );
}
