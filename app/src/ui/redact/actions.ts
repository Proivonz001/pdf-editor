// What Bianchetto and Oscura do (Modifica's sub-tools "whiteout" and "redact", and "Oscura tutti
// i risultati…" from Cerca):
// - previewFor: what an area would remove or leave, asked of the engine without changing anything
//   (the waiting area's context bar shows it before it is applied: viewer/RedactLayer.tsx);
// - redactNow: one area or many, on one page or several, written as one edit, in the engine's
//   queue like every other edit (exclusive "edit": an Undo pressed meanwhile applies after it),
//   recorded in the history, and followed by a toast only for what the user must know (texts.ts,
//   reportNotes). The pages are held by their PageModels, so an edit asked before a page operation
//   that lands first follows them; when a page changed since it was looked at (its revision), or
//   went, nothing is written and that is said. A refusal from the engine (a picture it cannot
//   clear, resources shared in a way it cannot clean, a picture too big for the device) changes
//   nothing and is said in words. Afterwards the selected image and the initials "On every page…"
//   remembers let go of the pages it changed (their image indices may have changed);
// - openRedactAll / redactHits: the review of Cerca's hits (RedactAllDialog.tsx, "redact-all"),
//   then one Oscura over the areas of the chosen hits (areasForQuads: each hit's quads shrunk so
//   that the lines above and below keep their letters; more than one edit only when a page has
//   more rects than one edit takes, each hit whole in one of them unless it alone has more), the
//   toast "Oscurati 12 risultati in 5 pagine." with Annulla (undoing every edit),
//   and Cerca runs again (rerunSearch): "Nessun risultato: oscurati tutti.", or how many are still
//   found and why (not chosen, not redacted, in form fields, or elsewhere). A refusal says what
//   was redacted (nothing, or the hits of the edits before it) and which page refused; so does an
//   engine failure after the first edits. Hits with no area at all (text with no place on the
//   page, such as an /ActualText over a picture) are not sent: when no chosen hit has one, that is
//   said; when some do, Cerca run again counts the others as "couldn't be redacted".
import type {
  Rect, RedactArea, RedactMode, RedactPreview, RedactRefusal, RedactResult, SearchHit,
} from "../../engine/protocol";
import { EngineError } from "../../engine/client";
import { areasForQuads, clampAreas, MAX_REDACT_RECTS } from "../../engine/redactGeometry";
import { t } from "../../i18n";
import {
  dialog, doc, editingStopped, engine, flushEditor, initialsSource, isApplied, lastEditId, recordHistory,
  selectedImage, showDialog, showToast, type DialogState, type ToastAction,
} from "../../state";
import type { OpenDoc, PageModel } from "../../viewer/model";
import { exclusive, listText, reportEngineError, undoEdit } from "../actions";
import { undoAction } from "../pageActions";
import { rerunSearch, searchTooMany } from "../search/runner";
import { sameRect } from "./geometry";
import { refusalText, reportNotes } from "./texts";

export type RedactAllState = Extract<DialogState, { kind: "redact-all" }>;

/** An edit written: the engine's result and the history's id for it (null when nothing changed). */
export interface RedactDone {
  result: RedactResult;
  id: number | null;
}

const REFUSALS: readonly RedactRefusal[] = ["separation", "shared", "too-big", "locked"];

/**
 * The reason a refusal names, from the engine's "not-editable" error (its message names it), or
 * null for any other error. A refusal whose reason cannot be read is "locked".
 */
export function refusalOf(e: unknown): RedactRefusal | null {
  if (!(e instanceof EngineError) || e.code !== "not-editable") return null;
  return REFUSALS.find((r) => new RegExp(`\\b${r}\\b`).test(e.message)) ?? "locked";
}

/** The page (1-based) a refusal names ("Refused (too-big) on page 3: …"), or null. */
function refusedPage(e: unknown): number | null {
  const m = e instanceof Error ? /\bon page (\d+)\b/.exec(e.message) : null;
  return m ? Number(m[1]) : null;
}

/**
 * What redact(`areas`, `mode`) would remove or leave, without changing anything; null when there is
 * no document, editing has stopped, another document took its place meanwhile, or the engine
 * could not say (said in the console only: the area can still be applied).
 */
export async function previewFor(areas: RedactArea[], mode: RedactMode): Promise<RedactPreview | null> {
  const d = doc.peek();
  if (!d || editingStopped.peek() || !areas.length) return null;
  try {
    const preview = await engine().redactPreview(areas, mode);
    return doc.peek() === d ? preview : null;
  } catch (e) {
    console.warn("What the area would remove could not be read", e);
    return null;
  }
}

/**
 * Bianchetto or Oscura over `areas` (page space; one or more pages), as one edit, after the
 * changes asked before it. `revs`: the revisions the pages were looked at (the waiting area's,
 * the search's); when one changed since, or its page went, nothing is written and `changed` (or
 * "the page changed meanwhile") is said. `refused`: what a refusal says instead of refusalText
 * (as a warning), from its reason and the page the engine names (1-based); null when the caller
 * says it. `failed`: true when the caller says an engine failure (a crash or a broken document
 * is still said as such). Resolves with the result and the history's id, or null when nothing was
 * written (refused, failed, another document).
 */
export function redactNow(
  areas: RedactArea[], mode: RedactMode,
  opts: {
    revs?: ReadonlyMap<PageModel, number>;
    changed?: string;
    refused?: (reason: RedactRefusal, page: number | null) => string | null;
    failed?: () => boolean;
  } = {},
): Promise<RedactDone | null> {
  const d = doc.peek();
  // Held by their pages from now on, so that a page operation landing first leaves them right.
  const held = d ? areas.map((a) => ({ page: d.pages[a.pageIndex], rects: a.rects.map((r) => [...r] as Rect) })) : [];
  const changedText = opts.changed ?? t("redact.changed");
  return exclusive("edit", async () => {
    if (!d || doc.peek() !== d || editingStopped.peek() || !held.length) return null;
    const stale = held.some(({ page }) => !page || d.pages[page.index] !== page) ||
      [...(opts.revs ?? [])].some(([page, rev]) => page.rev.peek() !== rev || d.pages[page.index] !== page);
    if (stale) {
      showToast("error", changedText);
      return null;
    }
    const now: RedactArea[] = held.map(({ page, rects }) => ({ pageIndex: page.index, rects }));
    try {
      const result = await engine().redact(now, mode);
      if (doc.peek() !== d) return null;
      const id = recordHistory(result, "edit");
      letGoOfPages(d, result.changedPages);
      const notes = reportNotes(result.report, mode);
      if (notes.length) {
        const warn = result.report.fieldsElsewhere.length > 0 || (mode === "redact" && result.report.attachments > 0);
        showToast(warn ? "warn" : "info", notes.join(" "));
      }
      return { result, id };
    } catch (e) {
      const reason = refusalOf(e);
      if (reason) {
        const text = opts.refused ? opts.refused(reason, refusedPage(e)) : null;
        if (text) showToast("warn", text);
        else if (!opts.refused) showToast("info", refusalText(reason));
        return null;
      }
      const code = e instanceof EngineError ? e.code : undefined;
      if (code !== "crashed" && code !== "init" && code !== "broken" && opts.failed?.()) {
        console.error(e);
        return null;
      }
      reportEngineError(e, t(mode === "redact" ? "redact.failed" : "redact.failedWhiteout"));
      return null;
    }
  });
}

/**
 * The pages `changed` were redacted: their image indices may have changed (a picture cleared
 * whole goes from the list), so the selection and the initials "On every page…" would copy let
 * go of them, as after an undo.
 */
function letGoOfPages(d: OpenDoc, changed: readonly number[]) {
  const on = new Set(changed);
  if (selectedImage.peek() && on.has(selectedImage.peek()!.pageIndex)) selectedImage.value = null;
  const initials = initialsSource.peek();
  if (initials && initials.docId === d.id && on.has(initials.pageIndex)) initialsSource.value = null;
}

/**
 * The toast's "Annulla" for the edits `ids` of `d` (one "Oscura tutti"): the page operations'
 * (ui/pageActions.ts) for one edit; for several (a page with more rects than one edit takes),
 * each in turn from the last, by the same rule: while it is the last edit, else a word why not.
 */
function undoAllAction(d: OpenDoc, ids: readonly number[]): ToastAction {
  const last = undoAction(d, ids.at(-1) ?? null);
  if (ids.length < 2) return last;
  return {
    label: last.label,
    run: async () => {
      for (const id of [...ids].reverse()) {
        if (doc.peek() !== d || !isApplied(id)) return;
        if (lastEditId() !== id) {
          showToast("info", t("pageOps.undoGone"));
          return;
        }
        await undoEdit(id);
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// "Oscura tutti i risultati…"

/**
 * What the review was opened with, besides its hits: the document, its pages' revisions then, and
 * whether Cerca had found more hits than it shows (searchTooMany).
 */
interface Asked {
  doc: OpenDoc;
  revs: Map<PageModel, number>;
  more: boolean;
}
const asked = new WeakMap<RedactAllState, Asked>();

/** The review shows only the first hits Cerca found: there are more (the rest are searched for again after it). */
export function reviewHasMore(state: RedactAllState): boolean {
  return asked.get(state)?.more ?? false;
}

/**
 * "Oscura tutti i risultati…" (Cerca's options): the review of `hits` for `query` as a dialog (a
 * sheet on phones), every hit chosen. Nothing without hits, without a document, or while another
 * dialog is open; once editing has stopped, a word instead.
 */
export function openRedactAll(hits: readonly SearchHit[], query: string): void {
  const d = doc.peek();
  if (!d || !hits.length || dialog.peek()) return;
  if (editingStopped.peek()) {
    showToast("info", t("broken.note"));
    return;
  }
  const state: RedactAllState = { kind: "redact-all", hits: [...hits], query };
  const revs = new Map<PageModel, number>();
  for (const hit of hits) {
    const page = d.pages[hit.pageIndex];
    if (page) revs.set(page, page.rev.peek());
  }
  asked.set(state, { doc: d, revs, more: searchTooMany.peek() });
  showDialog(state);
}

/**
 * One edit of "Oscura tutti": its areas by page, in page order, and the hits they cover; `cut`,
 * those of them (too big for one edit) whose first rects went in the edit `from`.
 */
export interface HitsRound {
  areas: RedactArea[];
  hits: SearchHit[];
  cut: { hit: SearchHit; from: number }[];
}

/**
 * The areas of `hits`: each hit's quads shrunk so the lines above and below keep their letters
 * (areasForQuads: on a turned page, many thin pieces each), on its page, by page in page order, in
 * the edits the engine takes (at most MAX_REDACT_RECTS rects on a page each, filled in turn):
 * almost always one, more only for a page with hundreds of hits across line ends or turned. Each
 * hit goes whole in one edit (the next one when this one has no room left for it), so a refused
 * edit leaves its hits as they were; only a hit of more rects than one edit takes is cut, and it
 * counts in the edit its last rect goes in. Hits off their page are left out.
 */
export function roundsOfHits(d: OpenDoc, hits: readonly SearchHit[]): HitsRound[] {
  const rounds: HitsRound[] = [];
  const byPage = new Map<number, Rect[][]>(); // a page's rects, edit by edit
  for (const hit of hits) {
    const page = d.pages[hit.pageIndex];
    // Rect by rect: clampAreas keeps only the first MAX_REDACT_RECTS, and a hit can have more.
    const rects = page ? areasForQuads(hit.quads).flatMap((r) => clampAreas([r], page.bounds)) : [];
    if (!rects.length) continue;
    const edits = byPage.get(hit.pageIndex) ?? [[]];
    byPage.set(hit.pageIndex, edits);
    if (rects.length <= MAX_REDACT_RECTS && edits.at(-1)!.length + rects.length > MAX_REDACT_RECTS) edits.push([]);
    let from = -1;
    for (const r of rects) {
      if (edits.at(-1)!.length === MAX_REDACT_RECTS) edits.push([]);
      if (from < 0) from = edits.length - 1;
      edits.at(-1)!.push(r);
    }
    const round = (rounds[edits.length - 1] ??= { areas: [], hits: [], cut: [] });
    round.hits.push(hit);
    if (from < edits.length - 1) round.cut.push({ hit, from });
  }
  for (const pageIndex of [...byPage.keys()].sort((a, b) => a - b)) {
    byPage.get(pageIndex)!.forEach((rects, k) => (rounds[k] ??= { areas: [], hits: [], cut: [] }).areas.push({ pageIndex, rects }));
  }
  return rounds;
}

/** A refused "Oscura tutti": nothing was redacted, why, and the page that refused (when the engine names it). */
export function allRefusedText(reason: RedactRefusal, page: number | null): string {
  const why = refusalText(reason);
  return page === null ? t("redact.allRefused", { why }) : t("redact.allRefusedPage", { why, page });
}

/**
 * "Oscura tutti" refused (or failed: `reason` null) after its first edits: `count` of the `total`
 * chosen were redacted, the others not, why, the page that refused, and how many of the others
 * (`cut`: too big for one edit) were redacted only in part.
 */
export function allPartlyText(count: number, total: number, reason: RedactRefusal | null, page: number | null, cut = 0): string {
  const why = reason ? refusalText(reason) : t("redact.allFailed");
  const text = page === null
    ? t("redact.allPartly", { count, total, why })
    : t("redact.allPartlyPage", { count, total, why, page });
  if (!cut) return text;
  return `${text} ${cut === 1 ? t("redact.allCutOne") : t("redact.allCut", { count: cut })}`;
}

/** "Oscurati 12 risultati in 5 pagine." (one result, one page: in the singular). */
export function allDoneText(count: number, pages: number): string {
  if (count === 1) return t("redact.allDoneOne");
  return pages === 1 ? t("redact.allDoneOnePage", { count }) : t("redact.allDone", { count, pages });
}

/**
 * What the search after "Oscura tutti" says: "Nessun risultato: oscurati tutti.", or how many times
 * `query` is still found, and why: hits the user did not choose (`skipped`, found again where they
 * were), chosen hits whose edit was not written (`notDone`: refused), hits in form fields, and others.
 */
export function leftText(
  query: string, left: readonly SearchHit[], skipped: readonly SearchHit[], notDone: readonly SearchHit[] = [],
): string {
  if (!left.length) return t("redact.allVerified");
  const among = (list: readonly SearchHit[], hit: SearchHit) =>
    list.some((s) => s.pageIndex === hit.pageIndex && sameRect(s.rect, hit.rect));
  let notChosen = 0, refused = 0, inFields = 0, other = 0;
  for (const hit of left) {
    if (among(skipped, hit)) notChosen++;
    else if (among(notDone, hit)) refused++;
    else if (hit.in === "field") inFields++;
    else other++;
  }
  const why: string[] = [];
  if (notChosen) why.push(t("redact.leftSkipped", { count: notChosen }));
  if (refused) why.push(t("redact.leftNotDone", { count: refused }));
  if (inFields) why.push(inFields === 1 ? t("redact.leftFieldsOne") : t("redact.leftFields", { count: inFields }));
  if (other) why.push(t("redact.leftOther", { count: other }));
  const text = query.trim();
  return left.length === 1
    ? t("redact.allLeftOne", { text, why: listText(why) })
    : t("redact.allLeft", { text, count: left.length, why: listText(why) });
}

/**
 * Oscura over the `chosen` hits of the review `state`, as one edit (see the header; several only
 * when a page has more rects than one takes): then the toast, counting the hits written (of how
 * many, when a later edit was refused), with Annulla, and Cerca runs the same query again
 * (rerunSearch), whose hits say what is left.
 * Nothing when the review was for another document, or none is chosen.
 */
export async function redactHits(state: RedactAllState, chosen: readonly SearchHit[]): Promise<void> {
  const d = doc.peek();
  const was = asked.get(state);
  if (!d || !was || was.doc !== d || !chosen.length) return;
  await flushEditor(); // what is typed is written first (Cerca works in every tool)
  if (doc.peek() !== d) return;
  const rounds = roundsOfHits(d, chosen);
  if (!rounds.length) {
    // No chosen hit has an area: text with no place on the page (an /ActualText over a picture,
    // quads of no width; a hit's rect there sits where the text before it ended, so it is not grown
    // into one), or their pages went. Never silent.
    const gone = chosen.some((h) => !d.pages[h.pageIndex]);
    showToast("warn", gone ? t("redact.allChanged") : t("redact.allRefused", { why: t("redact.allNoArea") }));
    return;
  }
  // The pages as the review saw them; for a later edit, as the one before left them.
  let revs = new Map<PageModel, number>();
  for (const { pageIndex } of chosen) {
    const page = d.pages[pageIndex];
    const rev = page ? was.revs.get(page) : undefined;
    if (page && rev !== undefined) revs.set(page, rev);
  }
  const ids: number[] = [];
  const sent: SearchHit[] = [];
  // Edits written: an edit may hold only the first part of a hit too big for one (it counts in a later one).
  let edits = 0;
  /** A refusal (or a failure: reason null) after the first edits were written: said below, with what they redacted. */
  const late: { reason: RedactRefusal | null; page: number | null }[] = [];
  for (const round of rounds) {
    const done = await redactNow(round.areas, "redact", {
      revs,
      changed: t("redact.allChanged"),
      refused: (reason, page) => {
        if (!edits) return allRefusedText(reason, page); // nothing written yet: "nothing was redacted"
        late.push({ reason, page });
        return null;
      },
      failed: () => {
        if (!edits) return false;
        late.push({ reason: null, page: null });
        return true;
      },
    });
    if (!done || doc.peek() !== d) break;
    edits++;
    if (done.id !== null) ids.push(done.id);
    sent.push(...round.hits);
    revs = new Map([...revs.keys()].map((page) => [page, page.rev.peek()]));
  }
  if (!edits || doc.peek() !== d) return;
  const undo = undoAllAction(d, ids);
  const [refusal] = late;
  // Hits too big for one edit whose first part was written, the rest not.
  const cut = rounds.slice(edits).flatMap((r) => r.cut.filter((c) => c.from < edits)).length;
  if (refusal) showToast("warn", allPartlyText(sent.length, chosen.length, refusal.reason, refusal.page, cut), undefined, undo);
  else showToast("info", allDoneText(sent.length, new Set(sent.map((h) => h.pageIndex)).size), undefined, undo);
  const skipped = state.hits.filter((h) => !chosen.includes(h));
  const written = new Set(sent);
  const notDone = chosen.filter((h) => !written.has(h));
  let left: readonly SearchHit[] | null = null;
  try {
    left = await rerunSearch();
  } catch (e) {
    console.warn("Searching again failed", e);
  }
  if (left === null || doc.peek() !== d) return; // replaced by another search, or closed: nothing to say
  // A hit cut between edits whose later part was refused is no longer found: "all redacted" would not be true.
  if (!left.length && notDone.length) return;
  showToast(left.length ? "warn" : "info", leftText(state.query, left, skipped, notDone));
}
