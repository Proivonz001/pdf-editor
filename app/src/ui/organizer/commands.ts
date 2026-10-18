// What the organizer's buttons, keys, drags and "+" menu do (release 4, "Pagine"), on the pages
// they name: turn, duplicate, extract, delete, move (one place with Alt+↑/↓, to where a drag
// dropped them, to a position chosen in "Sposta in posizione…"), and add pages at a place between
// them: a blank page, pages of another PDF (its file chosen here, or dropped there), photos or
// scans (the scan flow, ui/scan). Every page operation goes through ui/pageActions.ts, which makes
// it one edit and says what it did in a toast; the organizer adds its own words for what shows at
// once and has no toast (a move, a turn), for screen readers (model.ts, announce).
//
// The pages are taken as PageModels and turned into their indices only here, as the action
// starts; the dialogs that stay open while page operations may land ("Sposta in posizione…", the
// page picker of another PDF) hold their pages and their place by PageModel too, and work out
// the indices only when their button is pressed. Moves of one place (Alt+↑/↓) take their place
// among the changes when they are pressed and are worked out in the engine's queue, from the
// order the changes before them left: Alt+↑ pressed three times moves a page three places, one
// pressed while a delete is on its way moves the page one place from where the delete left it,
// and Ctrl+Z pressed after it undoes the move. One that finds nothing to do (Alt+↑ on the first
// page), like a drop where the pages are, touches nothing: a signature waiting to be placed, the
// image selected and the field focused last stay as they are (pageActions, runPagesEdit). A turn
// is worked out in the queue too, so that the thumbnail can show two quick turns added up
// (rotatePages, model.ts addTurns).
import { t, pageCount } from "../../i18n";
import { doc, scanFlow, showDialog, showToast, type DialogState } from "../../state";
import type { OpenDoc, PageModel } from "../../viewer/model";
import {
  deletePagesAction, duplicatePagesAction, extractPagesAction, insertBlankPage, moveOrder, movePagesTo, runPagesEdit,
} from "../pageActions";
import {
  addTurns, announce, canDelete, clampGap, gapOfPlace, nudgeOrder, placeOfGap, selectedIn, type GapPlace,
} from "./model";

/** Where the pages are now (those still in the document), in page order. */
function indicesOf(d: OpenDoc, pages: readonly PageModel[]): number[] {
  return pages.filter((p) => d.pages[p.index] === p).map((p) => p.index).sort((a, b) => a - b);
}

/** The pages still in the open document `d`, in page order (none when another document is open). */
function present(d: OpenDoc | null, pages: readonly PageModel[]): PageModel[] {
  if (!d || doc.peek() !== d) return [];
  return pages.filter((p) => d.pages[p.index] === p).sort((a, b) => a.index - b.index);
}

/**
 * What an action on page `page` (a key on its thumbnail, a drag of it) applies to: the selection
 * when that page is in it, else that page alone.
 */
export function pagesFor(d: OpenDoc, page: PageModel): PageModel[] {
  const chosen = selectedIn(d);
  return chosen.includes(page) ? chosen : [page];
}

/** Ran a page operation that shows at once: the document's pages changed (it was not refused). */
async function changed(d: OpenDoc, run: () => Promise<unknown>): Promise<boolean> {
  const before = d.layout.peek();
  await run();
  return doc.peek() === d && d.layout.peek() !== before;
}

/**
 * Turn `pages` clockwise by `by` degrees, as one edit (as pageActions' rotatePagesAction does: the
 * pages where they are when its turn comes in the engine's queue, the first of them shown); their
 * thumbnails show it at once. Their revisions right before the turn is sent are read there too,
 * so that a turn right after another one adds up with it (addTurns): a turn changes a page's
 * revision more than once, and other steps may land between the two.
 */
export async function rotatePages(pages: readonly PageModel[], by: 90 | 180 | 270): Promise<void> {
  const d = doc.peek();
  const chosen = present(d, pages);
  if (!d || !chosen.length) return;
  let before: ReadonlyMap<number, number> = new Map();
  const result = await runPagesEdit((now) => {
    const at = indicesOf(now, chosen);
    if (!at.length) return null;
    before = new Map(chosen.map((p) => [p.key, p.rev.peek()]));
    return { edit: { kind: "rotate", pages: at, by }, show: at[0] };
  });
  if (!result || doc.peek() !== d) return;
  const turned = present(d, chosen);
  if (!turned.length) return;
  addTurns(turned, by, before);
  announce(turned.length === 1 ? t("org.rotatedOne", { page: turned[0].index + 1 }) : t("org.rotated", { count: turned.length }));
}

/** Copies of `pages`, right after the last of them (pageActions says it). */
export async function duplicatePages(pages: readonly PageModel[]): Promise<void> {
  const d = doc.peek();
  const chosen = present(d, pages);
  if (d && chosen.length) await duplicatePagesAction(indicesOf(d, chosen));
}

/** "Estrai": `pages` downloaded as a new PDF; the document stays as it is. */
export async function extractPages(pages: readonly PageModel[]): Promise<void> {
  const d = doc.peek();
  const chosen = present(d, pages);
  if (d && chosen.length) await extractPagesAction(indicesOf(d, chosen));
}

/** Delete `pages`; never every page (refused with a word why). The toast offers "Annulla". */
export async function deletePages(pages: readonly PageModel[]): Promise<void> {
  const d = doc.peek();
  const chosen = present(d, pages);
  if (!d || !chosen.length) return;
  if (!canDelete(chosen.length, d.pages.length)) {
    showToast("info", t("pageOps.keepOne"));
    return;
  }
  await deletePagesAction(indicesOf(d, chosen));
}

type MoveAsk = Extract<DialogState, { kind: "move-pages" }>;
type PdfAsk = Extract<DialogState, { kind: "insert-from-pdf" }>;

/** The pages each move dialog asked about, by its state: its `pages` are the indices as they were then. */
const movesAsked = new WeakMap<MoveAsk, { doc: OpenDoc; pages: PageModel[] }>();

/** "Sposta in posizione…": the dialog that asks where `pages` go. */
export function askMovePages(pages: readonly PageModel[]) {
  const d = doc.peek();
  const chosen = present(d, pages);
  if (!d || !chosen.length) return;
  const ask: MoveAsk = { kind: "move-pages", pages: indicesOf(d, chosen) };
  movesAsked.set(ask, { doc: d, pages: chosen });
  showDialog(ask);
}

/**
 * The pages the move dialog `ask` is about, as they are now: those still in the open document,
 * in page order (none when another document took its place). Taken as PageModels when it was
 * asked for, so a page operation landing while it is open (one asked before it, an undo) moves
 * them, and the dialog follows; `ask.pages` (indices) count only for a dialog made elsewhere,
 * read against the pages the first time it is asked about.
 */
export function movingPages(ask: MoveAsk): PageModel[] {
  const d = doc.peek();
  let held = movesAsked.get(ask);
  if (!held && d) {
    held = { doc: d, pages: ask.pages.filter((i) => Number.isInteger(i)).map((i) => d.pages[i]).filter((p) => !!p) };
    movesAsked.set(ask, held);
  }
  return held && held.doc === d ? present(d, held.pages) : [];
}

/** What a move said: where the one page is now, or how many moved. */
function sayMoved(d: OpenDoc, pages: readonly PageModel[]) {
  const moved = present(d, pages);
  if (!moved.length) return;
  announce(moved.length === 1 ? t("org.movedOne", { page: moved[0].index + 1 }) : t("org.moved", { count: moved.length }));
}

/**
 * Move `pages`, in their order in the document, before page `before` (pageCount: at the end), as
 * a drag dropped them or the move dialog asked; the first of them becomes the current page.
 */
export async function movePagesBefore(pages: readonly PageModel[], before: number): Promise<void> {
  const d = doc.peek();
  const chosen = present(d, pages);
  if (!d || !chosen.length) return;
  const at = indicesOf(d, chosen);
  if (moveOrder(d.pages.length, at, before).every((o, k) => o === k)) return; // there already
  if (await changed(d, () => movePagesTo(at, before))) sayMoved(d, chosen);
}

/**
 * Alt+↑ / Alt+↓: `pages` one place up (-1) or down (+1) from where they are when it runs, as one
 * edit; `focus` (one of them, the thumbnail with the focus) becomes the current page. Nothing when
 * they cannot go further by then, or went meanwhile. It takes its place among the changes when it
 * is pressed (an undo pressed after it undoes the move, even behind a download or a long insert),
 * and the order is worked out when its turn comes in the engine's queue (runPagesEdit with a
 * PagesAsk), from where the pages are then: the moves asked for before, and any other page
 * operation (a delete, an undo), have landed, so none makes it fail and it moves the pages one
 * place from where they left them. When nothing that changes the pages is on its way and they
 * cannot go further (Alt+↑ on the first page), that is known at once and nothing is touched: no
 * place taken in the queue, nothing open on the pages closed.
 */
export async function nudgePages(pages: readonly PageModel[], dir: -1 | 1, focus?: PageModel): Promise<void> {
  const d = doc.peek();
  if (!d || !present(d, pages).length) return;
  let moved: PageModel[] = [];
  const result = await runPagesEdit((now) => {
    const chosen = present(now, pages);
    const order = chosen.length ? nudgeOrder(now.pages.length, indicesOf(now, chosen), dir) : null;
    if (!order) return null;
    moved = chosen;
    const shown = focus && chosen.includes(focus) ? focus : chosen[0];
    return { edit: { kind: "move", order }, show: order.indexOf(shown.index) };
  });
  if (result && doc.peek() === d) sayMoved(d, moved);
}

// ---------------------------------------------------------------------------------------------
// The "+" menu: pages added at a place between pages (0 … pageCount)

/** "Pagina vuota": a blank page at `gap`, the size of the page next to it. */
export function insertBlankAt(gap: number): Promise<void> {
  return insertBlankPage(gap);
}

/** "Foto o scansione": the scan flow, for pages that go at `gap`. */
export function insertScanAt(gap: number) {
  if (!doc.peek()) return;
  scanFlow.value = { kind: "insert", at: gap };
}

/** The file dropped between the thumbnails (or chosen before the dialog), for the dialog to take. */
let pendingSource: File | null = null;

/** The place each page picker adds its pages at, by its state, held by its page: its `at` is the index as it was then. */
const placesAsked = new WeakMap<PdfAsk, { doc: OpenDoc; place: GapPlace }>();

/** The page picker for `place` of `d` (the open document), with `file` already chosen or to choose. */
function askPdf(d: OpenDoc, place: GapPlace, file: File | null) {
  pendingSource = file;
  const ask: PdfAsk = { kind: "insert-from-pdf", at: gapOfPlace(d.pages, place) };
  placesAsked.set(ask, { doc: d, place });
  showDialog(ask);
}

/** "Da un altro PDF…" for the place `gap`: the page picker, with `file` already chosen (a drop) or to choose. */
export function openInsertFromPdf(gap: number, file?: File) {
  const d = doc.peek();
  if (d) askPdf(d, placeOfGap(d.pages, gap), file ?? null);
}

/**
 * Where the page picker `ask` adds its pages now (0 … pageCount): its place follows the page
 * operations that land while it is open (a delete asked before it, an undo), so "after page 3"
 * stays next to the same page; `ask.at` counts only for a picker opened elsewhere, read against
 * the pages the first time it is asked about.
 */
export function insertGap(ask: PdfAsk): number {
  const d = doc.peek();
  if (!d) return 0;
  let held = placesAsked.get(ask);
  if (!held) {
    held = { doc: d, place: placeOfGap(d.pages, ask.at) };
    placesAsked.set(ask, held);
  }
  return held.doc === d ? gapOfPlace(d.pages, held.place) : clampGap(ask.at, d.pages.length);
}

/** The file the page picker opens with (once), or null: it asks for one. */
export function takePendingSource(): File | null {
  const file = pendingSource;
  pendingSource = null;
  return file;
}

let picker: HTMLInputElement | null = null;

/**
 * The system picker for a PDF, opened right here, within the tap or click (iOS opens pickers only
 * then). Its hidden input goes inside the modal that `from` is in (the phone sheet, a dialog):
 * everything outside a modal is inert, and an inert input opens nothing. Cancelled, nothing.
 */
export function pickPdf(from: Element | null, onPick: (file: File) => void) {
  picker?.remove(); // left over from a pick cancelled where "cancel" is not fired
  const input = document.createElement("input");
  picker = input;
  input.type = "file";
  input.accept = "application/pdf,.pdf";
  input.hidden = true;
  input.tabIndex = -1;
  input.setAttribute("aria-hidden", "true");
  const done = () => {
    input.remove();
    if (picker === input) picker = null;
  };
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    done();
    if (file) onPick(file);
  });
  input.addEventListener("cancel", done);
  const modal = from?.closest?.("dialog");
  (modal ?? document.body).append(input);
  input.click();
}

/**
 * "Da un altro PDF…" from the "+" menu: the picker now, then the page picker with that file, for
 * the place as it was chosen (held by its page while the system picker is open).
 */
export function chooseOtherPdf(gap: number, from: Element | null) {
  const d = doc.peek();
  if (!d) return;
  const place = placeOfGap(d.pages, gap);
  pickPdf(from, (file) => {
    if (doc.peek() === d) askPdf(d, place, file);
  });
}

/** An item of the "+" menu: its label, and what it does (`from`: the element it was chosen from). */
export interface InsertItem {
  key: "blank" | "pdf" | "scan";
  label: string;
  run: (from: Element | null) => void;
}

/** The "+" menu at place `gap`: Pagina vuota, Da un altro PDF…, Foto o scansione. */
export function insertItems(gap: number): InsertItem[] {
  return [
    { key: "blank", label: t("org.blank"), run: () => void insertBlankAt(gap) },
    { key: "pdf", label: t("org.fromPdf"), run: (from) => chooseOtherPdf(gap, from) },
    { key: "scan", label: t("org.scan"), run: () => insertScanAt(gap) },
  ];
}

/** What a dragged thumbnail says under the finger: "Page 3", "3 pages". */
export function dragText(pages: readonly PageModel[]): string {
  return pages.length === 1 ? t("viewer.page", { page: pages[0].index + 1 }) : pageCount(pages.length);
}
