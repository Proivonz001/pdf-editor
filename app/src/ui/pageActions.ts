// Page operations (release 4, "Pagine"): move, delete, turn, duplicate, a blank page, pages of
// another PDF, pictures as pages (photos and scans), and pages taken out into a new PDF ("Estrai").
// The organizer (the thumbnails, ui/organizer) and the scan flow (ui/scan) call these.
//
// Each operation is one edit in the history, made like any other: what is typed is written first,
// what is open on the pages closes (every page index is about to change), the edits asked for
// before land, then the operation runs in the engine's queue (actions.ts: prepareForPages,
// exclusive). The engine answers with the new pages (PagesResult.layout): the page list is
// rebuilt and the history recorded in one batch (state.ts, recordHistory: the pages that stay
// keep their PageModels, so their marks and components follow them), and the page the operation
// is about becomes the current page (the viewer brings it into view). Undo and redo of it go
// through the usual undo and redo (actions.ts), which bring the old PageModels back.
//
// The pages an operation names are taken as PageModels when it is asked for, and turned into
// indices only in the engine's queue: a page operation still queued before it (two quick
// deletes, a drag right after a turn) moves them, and this one follows. A page that went
// meanwhile is left out (or the operation is dropped when nothing is left of it); a keyboard move
// (Alt+↑/↓) is worked out whole in the queue, from where its pages are by then (runPagesEdit with
// a PagesAsk). From the moment it is asked for until it has run (behind a download, say, or a
// large insert taking seconds), no text writer, line editor or image selection opens on the pages
// (actions.ts, pagesChanging): the operation would close it when it lands, and what was typed in
// it would be lost. An undo or a redo asked for after it runs after it, although the operation
// first waits for what was asked before it (actions.ts, takePlaceInLine). A move that finds
// nothing to do (Alt+↑ on the first page, a drop where the pages are) touches nothing: when no
// step that changes the pages is on its way, what the queue would find is what is there now, so
// it is known at once, before anything is written or closed (a signature waiting to be placed,
// the image selected, the field focused last stay as they are); in the queue, it is known before
// anything closes there.
//
// No confirmation dialogs: a delete says what it did, with "Annulla" in its toast (it undoes that
// very delete, while it is the last edit, checked again in the engine's queue). Never every page:
// one always stays. The engine's report is said too: links that led to pages that are gone,
// fields renamed to keep them apart, digital signatures of an added PDF that are no longer valid.
import { batch } from "@preact/signals";
import { EngineError } from "../engine/client";
import {
  MAX_SOURCE_BYTES,
  type PageLayout, type PagePicture, type PagesEdit, type PagesReport, type PagesResult, type RenderResult,
  type SaveOptions, type SourceResult,
} from "../engine/protocol";
import { t } from "../i18n";
import {
  confirmDialog, currentPage, doc, downloadRunning, editingStopped, engine, isApplied, lastEditId, recordHistory,
  showToast,
} from "../state";
import type { OpenDoc, PageModel } from "../viewer/model";
import {
  closeForPageStep, closePageWork, countPagesStep, downloadBytes, exclusive, focusInPages, mustChoosePassword,
  pagesChanging, prepareForPages, reportEngineError, takePlaceInLine, undoEdit,
} from "./actions";
import { rescueFocus, viewerScroller } from "./focus";

// ---------------------------------------------------------------------------------------------
// Pure helpers

/**
 * The order of a move (PagesEdit "move": `order[k]` is the page that goes to position k) that
 * puts `pages` (indices, in their order in the document) before page `before` of `count` pages
 * (`count`: at the end). Pages out of range are ignored.
 */
export function moveOrder(count: number, pages: readonly number[], before: number): number[] {
  const moving = [...new Set(pages)].filter((i) => Number.isInteger(i) && i >= 0 && i < count).sort((a, b) => a - b);
  const set = new Set(moving);
  const rest: number[] = [];
  for (let i = 0; i < count; i++) if (!set.has(i)) rest.push(i);
  const b = Math.min(Math.max(0, Math.floor(before)), count);
  const pos = rest.filter((i) => i < b).length;
  return [...rest.slice(0, pos), ...moving, ...rest.slice(pos)];
}

/** Page numbers for people, from sorted indices: runs as ranges ("2-4, 7"). */
export function pageRanges(sorted: readonly number[]): string {
  const runs: string[] = [];
  for (let k = 0; k < sorted.length; k++) {
    const first = sorted[k];
    while (k + 1 < sorted.length && sorted[k + 1] === sorted[k] + 1) k++;
    runs.push(first === sorted[k] ? `${first + 1}` : `${first + 1}-${sorted[k] + 1}`);
  }
  return runs.join(", ");
}

/** The name of the file "Estrai" downloads: "<name> - pagine 2-4.pdf", "<name> - pagina 3.pdf". */
export function extractName(fileName: string, pages: readonly number[]): string {
  const name = fileName.replace(/\.pdf$/i, "") || "document";
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  if (sorted.length === 1) return t("pageOps.extractNameOne", { name, page: sorted[0] + 1 });
  return t("pageOps.extractName", { name, pages: pageRanges(sorted) });
}

// ---------------------------------------------------------------------------------------------
// Pages taken now, indices worked out in the engine's queue

/** The pages of `d` at `indices`, each once, in page order; null when one is not a page of `d`. */
function pagesAt(d: OpenDoc, indices: readonly number[]): PageModel[] | null {
  const pages: PageModel[] = [];
  for (const i of [...new Set(indices)].sort((a, b) => a - b)) {
    const page = Number.isInteger(i) ? d.pages[i] : undefined;
    if (!page) return null;
    pages.push(page);
  }
  return pages;
}

/** Page `page` is still one of `d`'s. */
function isPageOf(d: OpenDoc, page: PageModel): boolean {
  return d.pages[page.index] === page;
}

/** Where `pages` are now, in page order; those that went are left out. */
function indicesNow(d: OpenDoc, pages: readonly PageModel[]): number[] {
  return pages.filter((p) => isPageOf(d, p)).map((p) => p.index).sort((a, b) => a - b);
}

/** A place between pages: before the page that was at `at` (it moves with page operations), or at the end. */
interface Place {
  before: PageModel | null;
  at: number;
}

function placeAt(d: OpenDoc, at: number): Place {
  const i = Math.min(Math.max(0, Math.floor(Number.isFinite(at) ? at : d.pages.length)), d.pages.length);
  return { before: d.pages[i] ?? null, at: i };
}

/** The index the place is at now: before its page wherever it went; where it was when that page went; the end. */
function placeNow(d: OpenDoc, place: Place): number {
  if (!place.before) return d.pages.length;
  return isPageOf(d, place.before) ? place.before.index : Math.min(place.at, d.pages.length);
}

// ---------------------------------------------------------------------------------------------
// One page operation

/**
 * A page operation as it is sent (worked out in the engine's queue), and the page to show after
 * it: an index in the new pages, or null for the page shown before, followed.
 */
interface Asked {
  edit: PagesEdit;
  show: (layout: PageLayout) => number | null;
}

/** What the engine's report says, in toasts (nothing when it says nothing). */
function reportToasts(report: PagesReport | undefined) {
  if (!report) return;
  const links = report.linksRemoved;
  if (links > 0) showToast("info", links === 1 ? t("pageOps.linkRemoved") : t("pageOps.linksRemoved", { count: links }));
  if (report.fieldsRenamed > 0) showToast("info", t("pageOps.fieldsRenamed"));
  if (report.signaturesAdded > 0) showToast("warn", t("pageOps.signaturesInvalid"));
}

/**
 * Run one page operation on the open document: `ask` works it out in the engine's queue (from
 * the pages taken when it was asked for), or says null to drop it (gone, nothing to do: it says
 * why itself when that is worth a word). Then the page list and the history in one batch, what
 * opened meanwhile closed, the page to show made the current one; `said` gives the operation's
 * toast (with the new edit's id), then the engine's report. The result, or null.
 * `early`: when no step that changes the pages is on its way (pagesChanging), `ask` is asked once
 * now too, and its null drops the operation at once, before anything is written, closed or
 * waited for (a move with nothing to do touches nothing); for an `ask` whose only effect is its
 * answer (a word said with its null is said once: the operation ends there).
 */
async function pagesStep(
  ask: (d: OpenDoc) => Asked | null, said?: (result: PagesResult, id: number | null) => void, early = false,
): Promise<PagesResult | null> {
  const d = doc.peek();
  if (!d || editingStopped.peek()) return null;
  // Nothing that changes the pages lands before it: what the queue would find is what is there now.
  if (early && !pagesChanging() && !ask(d)) return null;
  // From now until it has run, nothing that holds typed text opens on the pages (pagesChanging);
  // until it has its place in the queue, an undo or a redo asked for after it waits (takePlaceInLine).
  const end = countPagesStep(d);
  const placed = takePlaceInLine();
  try {
    await prepareForPages();
    if (doc.peek() !== d) return null;
    const run = exclusive("edit", async () => {
      if (doc.peek() !== d || editingStopped.peek()) return null;
      const asked = ask(d);
      if (!asked) return null; // nothing to do by now: nothing opened meanwhile is closed either
      closeForPageStep(); // nothing should be open now; what is, names the pages as they are
      const inPages = focusInPages();
      let result: PagesResult;
      try {
        result = await engine().editPages(asked.edit);
      } catch (e) {
        reportEngineError(e, t("pageOps.failed"), t("pageOps.notEditable"));
        return null;
      }
      if (doc.peek() !== d) return null;
      let id: number | null = null;
      batch(() => {
        id = recordHistory(result, "edit");
        closePageWork(); // what opened while it ran named the old pages
        const show = asked.show(result.layout);
        if (show !== null) currentPage.value = Math.min(Math.max(0, show), Math.max(0, d.pages.length - 1));
      });
      if (inPages) rescueFocus(viewerScroller); // the field or frame that had it may have gone with its page
      said?.(result, id);
      reportToasts(result.report);
      return result;
    });
    placed();
    return await run;
  } finally {
    placed();
    end();
  }
}

/** The page an operation is about when its caller does not say: the first one it made, turned, or the one after those it deleted. */
function defaultShow(edit: PagesEdit, layout: PageLayout): number | null {
  switch (edit.kind) {
    case "move":
      return null; // the page shown before, wherever it went
    case "delete":
      return Math.min(Math.min(...edit.pages), layout.pages.length - 1);
    case "rotate":
      return Math.min(...edit.pages);
    case "blank":
    case "duplicate":
    case "insert":
    case "pictures":
      return edit.at;
  }
}

/**
 * The edit `edit` (indices of `d` as it is now) as it will be in the engine's queue, from the
 * pages and places it names: null when it does not fit the document (not a permutation, a page
 * that is not there), and, in the queue, when a page it moves went or nothing is left of it.
 */
function capture(d: OpenDoc, edit: PagesEdit): ((now: OpenDoc) => PagesEdit | null) | null {
  const count = d.pages.length;
  const inRange = (at: number) => Number.isInteger(at) && at >= 0 && at <= count;
  switch (edit.kind) {
    case "move": {
      const pages = edit.order.map((i) => d.pages[i]);
      if (edit.order.length !== count || new Set(pages).size !== count || pages.some((p) => !p)) return null;
      return (now) => {
        if (now.pages.length !== pages.length || !pages.every((p) => isPageOf(now, p))) return null;
        return { kind: "move", order: pages.map((p) => p.index) };
      };
    }
    case "delete":
    case "rotate": {
      const pages = pagesAt(d, edit.pages);
      if (!pages || !pages.length) return null;
      return (now) => {
        const at = indicesNow(now, pages);
        if (!at.length || (edit.kind === "delete" && at.length >= now.pages.length)) return null;
        return { ...edit, pages: at };
      };
    }
    case "duplicate": {
      const pages = pagesAt(d, edit.pages);
      if (!pages || !pages.length || !inRange(edit.at)) return null;
      const place = placeAt(d, edit.at);
      return (now) => {
        const at = indicesNow(now, pages);
        return at.length ? { kind: "duplicate", pages: at, at: placeNow(now, place) } : null;
      };
    }
    case "blank":
    case "insert":
    case "pictures": {
      if (!inRange(edit.at)) return null;
      const place = placeAt(d, edit.at);
      return (now) => ({ ...edit, at: placeNow(now, place) });
    }
  }
}

/**
 * A page operation worked out when its turn comes in the engine's queue (runPagesEdit), from the
 * open document as it is then (`now`, the changes asked for before it landed): the edit (indices
 * of `now`), and the page to show after it (an index in the new pages; none: the page the edit is
 * about); null when there is nothing to do by then, which drops it without a word. When no step
 * that changes the pages is on its way, it is also asked once right away, on the pages as they
 * are (what the queue will find): its null then drops the operation before anything is written,
 * closed or waited for, so it gives its answer and does nothing else (the last call is the one in
 * the queue).
 */
export type PagesAsk = (now: OpenDoc) => { edit: PagesEdit; show?: number } | null;

/**
 * Run one page operation: written open work first, open things closed, through the engine's
 * queue; the page list rebuilt, the history recorded, `show` (an index in the new layout) made
 * the current page. Resolves with the result, or null when refused or failed (the user was told),
 * or dropped. When a page operation queued before it lands first, its pages follow (and `show`
 * gives way to the page it is about). `edit` may instead be worked out in the queue (PagesAsk:
 * Alt+↑/↓ moves the pages one place from where they are by then, `show` then comes with it): it
 * takes its place among the changes when it is asked for all the same, so an undo asked after it
 * undoes it; and when it finds nothing to do with nothing on its way that changes the pages, it
 * is dropped at once and touches nothing (Alt+↑ on the first page leaves a signature waiting to
 * be placed, the image selected, the field focused last as they are).
 */
export function runPagesEdit(edit: PagesEdit | PagesAsk, show?: number): Promise<PagesResult | null> {
  const d = doc.peek();
  if (!d) return Promise.resolve(null);
  if (typeof edit === "function") return pagesStep((now) => askedNow(now, edit), undefined, true);
  const asked = d.layout?.peek(); // (none on an OpenDoc a test builds by hand)
  const remap = capture(d, edit);
  if (!remap) {
    showToast("error", t("pageOps.failed"));
    return Promise.resolve(null);
  }
  return pagesStep((now) => {
    const same = now.layout?.peek() === asked;
    const sent = same ? edit : remap(now);
    if (!sent) {
      showToast("error", t("pageOps.failed"));
      return null;
    }
    return { edit: sent, show: (layout) => (same && show !== undefined ? show : defaultShow(sent, layout)) };
  });
}

/**
 * What `ask` works out on `now`, in the engine's queue (or right away, for pagesStep's early
 * check): null when nothing is to be done, or (with a word) when it does not fit.
 */
function askedNow(now: OpenDoc, ask: PagesAsk): Asked | null {
  const asked = ask(now);
  if (!asked) return null;
  if (!capture(now, asked.edit)) {
    showToast("error", t("pageOps.failed"));
    return null;
  }
  const { edit, show } = asked;
  return { edit, show: (layout) => (show !== undefined ? show : defaultShow(edit, layout)) };
}

/**
 * The toast action that undoes edit `id` of `d`, and only that one: while it is the last edit;
 * else a word why not. Checked again in the engine's queue (undoEdit): text still in the writer
 * when the button is pressed is written first and becomes the last edit, an edit on its way lands
 * first; then nothing is undone (the toast says why), rather than what was just written.
 */
function undoAction(d: OpenDoc, id: number | null) {
  return {
    label: t("pageOps.undo"),
    run: () => {
      if (doc.peek() !== d || id === null || !isApplied(id)) return; // undone already, or another document
      if (lastEditId() !== id) {
        showToast("info", t("pageOps.undoGone"));
        return;
      }
      void undoEdit(id);
    },
  };
}

/**
 * Delete `pages` (indices), cleanly (what was on them leaves the file), as one edit. Refused when
 * it would delete every page. The toast says how many went, with "Annulla".
 */
export async function deletePagesAction(pages: number[]): Promise<void> {
  const d = doc.peek();
  if (!d) return;
  const chosen = pagesAt(d, pages);
  if (!chosen || !chosen.length) return;
  if (chosen.length >= d.pages.length) {
    showToast("info", t("pageOps.keepOne"));
    return;
  }
  let count = 0;
  await pagesStep((now) => {
    const at = indicesNow(now, chosen);
    if (!at.length) return null; // gone already
    if (at.length >= now.pages.length) {
      showToast("info", t("pageOps.keepOne"));
      return null;
    }
    count = at.length;
    return { edit: { kind: "delete", pages: at }, show: (layout) => Math.min(at[0], layout.pages.length - 1) };
  }, (_result, id) => {
    const text = count === 1 ? t("pageOps.deletedOne") : t("pageOps.deleted", { count });
    showToast("info", text, undefined, undoAction(d, id));
  });
}

/**
 * Move the selected `pages` (indices), in their order in the document, before page `before`
 * (`pageCount`: at the end), as one edit; the first of them becomes the current page. Nothing
 * when they are there already (touching nothing, when that is known at once: pagesStep, early).
 */
export async function movePagesTo(pages: number[], before: number): Promise<void> {
  const d = doc.peek();
  if (!d) return;
  const moving = pagesAt(d, pages);
  if (!moving || !moving.length) return;
  const place = placeAt(d, before);
  await pagesStep((now) => {
    const at = indicesNow(now, moving);
    if (!at.length) return null;
    const order = moveOrder(now.pages.length, at, placeNow(now, place));
    if (order.every((o, k) => o === k)) return null; // there already
    return { edit: { kind: "move", order }, show: () => order.indexOf(at[0]) };
  }, undefined, true);
}

/** Turn `pages` (indices) clockwise by `by` degrees, as one edit; it shows at once. */
export async function rotatePagesAction(pages: number[], by: 90 | 180 | 270): Promise<void> {
  const d = doc.peek();
  if (!d) return;
  const chosen = pagesAt(d, pages);
  if (!chosen || !chosen.length) return;
  await pagesStep((now) => {
    const at = indicesNow(now, chosen);
    return at.length ? { edit: { kind: "rotate", pages: at, by }, show: () => at[0] } : null;
  });
}

/** Copies of `pages` (indices), together right after the last of them, as one edit; the first copy shows. */
export async function duplicatePagesAction(pages: number[]): Promise<void> {
  const d = doc.peek();
  if (!d) return;
  const chosen = pagesAt(d, pages);
  if (!chosen || !chosen.length) return;
  let count = 0;
  await pagesStep((now) => {
    const at = indicesNow(now, chosen);
    if (!at.length) return null;
    count = at.length;
    const after = at[at.length - 1] + 1;
    return { edit: { kind: "duplicate", pages: at, at: after }, show: () => after };
  }, () => {
    showToast("info", count === 1 ? t("pageOps.duplicatedOne") : t("pageOps.duplicated", { count }));
  });
}

/** How many pages a step added (the ones it made: no `from`). */
function addedCount(result: PagesResult): number {
  return result.layout.from.filter((f) => f === null).length;
}

/** A toast for pages added: "1 pagina aggiunta.", "3 pagine aggiunte." (none when it added none). */
function sayAdded(result: PagesResult) {
  const count = addedCount(result);
  if (count > 0) showToast("info", count === 1 ? t("pageOps.addedOne") : t("pageOps.added", { count }));
}

/** A blank page at `at` (0 … pageCount), the size of the page next to it, as one edit; it shows. */
export async function insertBlankPage(at: number): Promise<void> {
  const d = doc.peek();
  if (!d) return;
  const place = placeAt(d, at);
  await pagesStep((now) => {
    const i = placeNow(now, place);
    return { edit: { kind: "blank", at: i }, show: () => i };
  }, () => showToast("info", t("pageOps.blankAdded")));
}

/**
 * Pages of the other PDF open in the engine (`source`, openSourceFile): all of them, or `pages`
 * in that order, at `at` (0 … pageCount), with a bookmark `title` that leads to them (null: none),
 * as one edit; the first of them shows. The source stays open (closeSourceFile).
 */
export async function insertFromSource(source: number, pages: number[] | "all", at: number, title: string | null): Promise<void> {
  const d = doc.peek();
  if (!d) return;
  const place = placeAt(d, at);
  await pagesStep((now) => {
    const i = placeNow(now, place);
    return { edit: { kind: "insert", at: i, source, pages: pages === "all" ? "all" : [...pages], title }, show: () => i };
  }, sayAdded);
}

/**
 * Pictures as pages of their own (photos, scanned sheets: ui/scan), at `at` (0 … pageCount), in
 * order, as one edit; the first of them shows. The pictures' bytes are transferred to the engine
 * (emptied): keep a copy where it must survive a failure.
 */
export async function insertPictures(at: number, pictures: PagePicture[]): Promise<void> {
  const d = doc.peek();
  if (!d || !pictures.length) return;
  const place = placeAt(d, at);
  await pagesStep((now) => {
    const i = placeNow(now, place);
    return { edit: { kind: "pictures", at: i, pictures }, show: () => i };
  }, sayAdded);
}

/**
 * "Estrai": a new PDF with only `pages` (indices) of the document as it is, downloaded as
 * "<name> - pagine 2-4.pdf" through the normal download path (the save dialog where there is
 * one, else a normal download); the document does not change. A regular PDF, with the document's
 * password when it can carry it; when the document needed one it cannot carry, asks first.
 */
export async function extractPagesAction(pages: number[]): Promise<void> {
  const d = doc.peek();
  if (!d) return;
  const chosen = pagesAt(d, pages);
  if (!chosen || !chosen.length) return;
  if (downloadRunning.peek()) {
    showToast("info", t("download.busy"));
    return;
  }
  if (mustChoosePassword(d.info)) {
    const ok = await confirmDialog({
      title: t("pageOps.extractPlainTitle"),
      body: t("pageOps.extractPlainBody"),
      confirmLabel: t("pageOps.extractPlainConfirm"),
    });
    if (!ok || doc.peek() !== d || downloadRunning.peek()) return;
  }
  const options: SaveOptions = {
    format: "pdf",
    password: d.info.canKeepPassword ? { mode: "keep" } : { mode: "none" },
  };
  const name = extractName(d.fileName, chosen.map((p) => p.index));
  downloadRunning.value = true;
  try {
    await downloadBytes(d, name, async () => {
      // In the engine's queue: after the changes asked for before, with the pages where they are now.
      const at = indicesNow(d, chosen);
      if (at.length !== chosen.length) {
        showToast("error", t("pageOps.extractFailed"));
        return null;
      }
      try {
        return (await engine().extractPages(at, options)).bytes;
      } catch (e) {
        reportEngineError(e, t("pageOps.extractFailed"));
        return null;
      }
    }, (saved) => t("download.done", { name: saved }));
  } finally {
    downloadRunning.value = false;
  }
}

// ---------------------------------------------------------------------------------------------
// The other PDF of "Da un altro PDF…" (its page picker)

/**
 * Open `file` read-only beside the document, for the page picker (one at a time: opening
 * another closes it), with `password` when it needs one. A file over MAX_SOURCE_BYTES is refused
 * as "too-big" before it is read; one that cannot be read or opened is "damaged".
 */
export async function openSourceFile(file: File, password?: string): Promise<SourceResult> {
  if (typeof file.size === "number" && file.size > MAX_SOURCE_BYTES) return { ok: false, reason: "too-big" };
  let bytes: ArrayBuffer;
  try {
    bytes = await file.arrayBuffer();
  } catch (e) {
    console.warn("The other PDF could not be read", e);
    return { ok: false, reason: "damaged" };
  }
  if (bytes.byteLength > MAX_SOURCE_BYTES) return { ok: false, reason: "too-big" };
  try {
    return await engine().openSource(bytes, password);
  } catch (e) {
    if (e instanceof EngineError && (e.code === "crashed" || e.code === "init")) reportEngineError(e, t("pageOps.failed"));
    else console.warn("The other PDF could not be opened", e);
    return { ok: false, reason: "damaged" };
  }
}

/** Close the other PDF (the page picker closed). Nothing to report if it fails: the next open replaces it. */
export async function closeSourceFile(source: number): Promise<void> {
  try {
    await engine().closeSource(source);
  } catch (e) {
    console.warn("Closing the other PDF failed", e);
  }
}

/** A page of the other PDF, rendered at `scale` (the caller owns the bitmap and closes it), or null when it failed. */
export async function renderSourcePage(source: number, pageIndex: number, scale: number): Promise<RenderResult | null> {
  try {
    return await engine().renderSource(source, pageIndex, scale);
  } catch (e) {
    console.warn(`Rendering page ${pageIndex + 1} of the other PDF failed`, e);
    return null;
  }
}
