// "Oscura tutti i risultati…" (the `redact-all` dialog, from Cerca's options): the review before
// one Oscura over many hits. What it does and what it cannot reach (writing inside photos and
// scans is not text: Cerca does not find it; past 1000 hits, only the first ones are here and the
// rest are searched for again afterwards), then the hits grouped by page, each with a little
// of the text around it and a ticked check box (Acrobat's model), and "Oscura {n}" for the ones
// still ticked, which writes them as one edit (actions.ts, redactHits). A dialog on desktop, a
// bottom sheet on phones, chosen when it opens. Styled by styles/redact.css and overlays.css.
import { useState } from "preact/hooks";
import type { SearchHit } from "../../engine/protocol";
import { t } from "../../i18n";
import { showDialog } from "../../state";
import { Dialog } from "../Dialog";
import { isNarrow } from "../media";
import { Sheet } from "../Sheet";
import { redactHits, reviewHasMore, type RedactAllState } from "./actions";

/** The hits by page, in page order. */
export function hitsByPage(hits: readonly SearchHit[]): [page: number, hits: SearchHit[]][] {
  const pages = new Map<number, SearchHit[]>();
  for (const hit of hits) {
    const list = pages.get(hit.pageIndex);
    if (list) list.push(hit);
    else pages.set(hit.pageIndex, [hit]);
  }
  return [...pages].sort((a, b) => a[0] - b[0]);
}

/**
 * The review's title and text: "Oscurare 12 risultati?", "«Rossi» compare 12 volte in 5 pagine. …";
 * `more`: Cerca found more than `hits` (the first ones): it says so, and that the rest are
 * searched for again afterwards.
 */
export function redactAllTexts(query: string, hits: readonly SearchHit[], more = false): { title: string; body: string } {
  const text = query.trim();
  const count = hits.length;
  const pages = new Set(hits.map((h) => h.pageIndex));
  if (more) return { title: t("redact.allTitle", { count }), body: t("redact.allBodyMore", { text, count }) };
  if (count === 1) return { title: t("redact.allTitleOne"), body: t("redact.allBodyOne", { text, page: hits[0].pageIndex + 1 }) };
  const title = t("redact.allTitle", { count });
  if (pages.size === 1) return { title, body: t("redact.allBodyOnePage", { text, count, page: hits[0].pageIndex + 1 }) };
  return { title, body: t("redact.allBody", { text, count, pages: pages.size }) };
}

function HitChoice({ hit, on, toggle }: { hit: SearchHit; on: boolean; toggle: () => void }) {
  return (
    <label class="redact-all-hit">
      <input type="checkbox" class="dl-checkbox" checked={on} onChange={toggle} />
      <span class="redact-all-context">
        {hit.before}
        <mark class="redact-all-match">{hit.match}</mark>
        {hit.after}
        {hit.in === "field" && hit.field && <span class="redact-all-where"> ({t("redact.inField", { name: hit.field })})</span>}
      </span>
    </label>
  );
}

function RedactAllForm({ state, heading }: { state: RedactAllState; heading: boolean }) {
  const [off, setOff] = useState<ReadonlySet<SearchHit>>(() => new Set());
  const { title, body } = redactAllTexts(state.query, state.hits, reviewHasMore(state));
  const chosen = state.hits.filter((h) => !off.has(h));
  const toggle = (hit: SearchHit) => setOff((was) => {
    const next = new Set(was);
    if (!next.delete(hit)) next.add(hit);
    return next;
  });
  const close = () => showDialog(null);
  const submit = (e: Event) => {
    e.preventDefault();
    if (!chosen.length) return;
    close();
    void redactHits(state, chosen);
  };
  return (
    <form class="dialog-form" onSubmit={submit} noValidate>
      <div class="dialog-text">
        {heading && <h2 id="dlg-title" class="dialog-title">{title}</h2>}
        <p id="dlg-body" class="dialog-body">{body}</p>
      </div>
      <p class="dl-note">{t("redact.allCaveat")}</p>
      <div class="redact-all-list">
        {hitsByPage(state.hits).map(([page, hits]) => (
          <fieldset key={page} class="dl-group">
            <legend class="dl-legend">{t("redact.allPage", { page: page + 1 })}</legend>
            {hits.map((hit, i) => <HitChoice key={i} hit={hit} on={!off.has(hit)} toggle={() => toggle(hit)} />)}
          </fieldset>
        ))}
      </div>
      {!chosen.length && <p class="dl-hint" role="status">{t("redact.allNone")}</p>}
      <div class="dialog-actions">
        <button type="button" class="btn btn-secondary" data-autofocus onClick={close}>{t("common.cancel")}</button>
        <button type="submit" class="btn btn-danger" disabled={!chosen.length}>{t("redact.allConfirm", { count: chosen.length })}</button>
      </div>
    </form>
  );
}

/** The review: a dialog on desktop, a bottom sheet on phones (chosen once, when it opens: turning the phone keeps the ticks). */
export function RedactAllDialog({ state }: { state: RedactAllState }) {
  const close = () => showDialog(null);
  const [narrow] = useState(() => isNarrow.peek());
  if (narrow) {
    return (
      <Sheet title={redactAllTexts(state.query, state.hits, reviewHasMore(state)).title} class="sheet-redact-all" onClose={close}>
        <RedactAllForm state={state} heading={false} />
      </Sheet>
    );
  }
  return (
    <Dialog labelledBy="dlg-title" describedBy="dlg-body" onCancel={close}>
      <RedactAllForm state={state} heading />
    </Dialog>
  );
}
