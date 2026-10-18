// The scan flow's state and what its buttons do (release 4, "Foto e scansione"): photos from the
// camera or the gallery become pages, which wait in a tray until "Fine" makes them a new PDF or
// adds them to the open document. ScanFlow.tsx shows it (a full-screen sheet on phones, a dialog
// on desktop) while `scanFlow` (state.ts) is set; this module holds no DOM, so the tests run it
// in Node with a fake scan client and a fake device store.
//
// The steps, in `phase`:
// - "start": nothing in the tray yet: Fotocamera and Galleria (one "Scegli immagini" with a mouse);
// - "kept": an unfinished scan from before is kept on the device: Continua or Ricomincia (below);
// - "reading": a photo is read and the sheet looked for (scanClient.analysePhoto, in the scan
//   worker); photos picked together wait in a queue and come one after the other;
// - "corners": the corner editor on that photo, with the mode and the page shape; the corners
//   found are only a start (the whole photo when the sheet was not found or not surely), never a
//   silent crop. "Aggiungi pagina" makes the page (processPhoto); "Scarta la foto" drops it;
// - "tray": the pages so far: move up and down, retake (a new photo takes that page's place once
//   it is made), delete, another page, Fine.
//
// Android may kill the tab while its camera app is open, so every change of the tray is kept on
// the device at once (platform/resume.ts, saveScan: the tray as it is), and the home page offers
// to resume it (resumeScan); Cancel forgets it, and so does Fine, once the document now holding
// the pages has been kept for Riprendi (autosave.ts, keepOpenDocument) or is known not to be: never
// before, so a tab killed in between still finds the pages in one of the two (a new opening
// meanwhile waits for that forget, and never offers back pages just used). Every save and forget
// goes through platform/resume.ts, whose change signal the home page's card follows. The tray
// keeps the pages' own buffers: the store copies what it keeps, and the engine gets copies (it
// empties what it is sent), so a Fine that fails or is refused leaves the tray as it was.
//
// Pages added to a document are for that document only (`Destination`). Opened from the
// organizer's "+", the flow takes the open document and the place there the moment `scanFlow` is
// set, holding the place by the page it goes before (organizer/model.ts, GapPlace), so page
// operations that land while the flow is open (one asked for before it, waiting in the engine's
// queue) move it with them. It becomes an index again only at Fine, and in what is kept on the
// device, with the document's file name (SavedScan.doc), kept again when a page operation moves
// it. A scan kept for a document goes into an open document only of that name: resumed (the home
// page's Riprendi, or the toast after resuming its document) or continued (a new opening's
// Continua) with another document open, or none, its pages wait for theirs (the orphan case
// below), and the flow names the document they are for.
//
// The device keeps ONE unfinished scan, so a new opening never replaces or forgets one kept from
// before (`claim`): it first asks the store, and when a scan is kept it asks the user ("kept":
// Continua, its pages back in the tray, or Ricomincia, and only then it is forgotten); photos
// picked meanwhile wait. Closed before that, it leaves the kept scan alone. A scan resumed with
// Riprendi is the flow's own from the start.
//
// Pages that cannot be used now are never lost by leaving: when the engine is down (Fine says so)
// or the document a resumed or continued scan's pages are for is not open (an "insert" with
// nothing to insert into: Fine offers a new PDF instead, and "Più tardi" keeps the scan for when
// that document is open again), Cancel closes the flow and keeps the scan on the device, without
// the "lost" question. Only while the
// device keeps the tray as it is (`notKept` follows the latest save's answer): when it could not,
// leaving would lose pages, so there is no "Più tardi", Cancel asks as usual, and the hint says
// that only a new PDF keeps them. A save still on its way is waited for first (`leaving`).
//
// One photo is in memory at a time: its working copy (an ImageBitmap of up to 3500 px) is closed
// once its page is made or the photo is dropped, and the scan worker, with what it holds, is
// terminated when the flow closes (flowClosed, from ScanFlow's unmount), and again once a call
// still on its way then has ended (a photo decoded on the main thread starts a worker afterwards),
// unless a flow is open again by then. Answers that come after the flow closed (or after it
// opened again) are dropped: each opening is a new generation.
//
// While the flow is open the toasts are under its modal (inert): what happens is said inside it
// (`said` for the polite status line, `alerted` for failures). Questions (leaving with pages,
// unsaved edits before a new PDF) are the app's own dialogs, which open over it.
import { batch, effect, signal, untracked } from "@preact/signals";
import type { PagePicture } from "../../engine/protocol";
import { t } from "../../i18n";
import {
  forgetScan, loadScan, saveScan, scanSummary, sessionSummary, type SavedScan, type SavedScanPage, type ScanSummary,
} from "../../platform/resume";
import { FOUND_CONFIDENCE } from "../../scan/detect";
import { analysePhoto, disposeScanWorker, processPhoto, type AnalysedPhoto } from "../../scan/scanClient";
import { cornersUsable, wholeFrame } from "../../scan/sizes";
import { ScanError, type Corners, type PageShape, type Point, type ScanMode } from "../../scan/types";
import { confirmDialog, doc, engineStatus, scanFlow, showToast, type ScanTarget } from "../../state";
import type { OpenDoc } from "../../viewer/model";
import { newFromPicturesAction } from "../actions";
import { isCoarse } from "../media";
import { gapOfPlace, placeOfGap, type GapPlace } from "../organizer/model";
import { runPagesEdit } from "../pageActions";
import { keepOpenDocumentOutcome, type KeepOutcome } from "../resume/autosave";

// ---------------------------------------------------------------------------------------------
// The tray, and pure helpers on it

/** A finished page in the tray. */
export interface TrayPage {
  /** Unique in this run of the app (never reused): Preact keys, the buttons' targets. */
  id: number;
  /** The page as processPhoto made it (JPEG, or a 1-bit PNG for "bw"). These bytes stay here. */
  picture: PagePicture;
  /** The tray's small JPEG. */
  preview: ArrayBuffer;
}

let nextPageId = 1;

/** A tray page for `picture` and its preview, with a new id. */
export function trayPage(picture: PagePicture, preview: ArrayBuffer): TrayPage {
  const { bytes, width, height, dpi } = picture;
  return { id: nextPageId++, picture: { bytes, width, height, dpi }, preview };
}

/** `tray` with `page` in place of page `replace` (when it is still there), else at the end. */
export function withPage(tray: readonly TrayPage[], page: TrayPage, replace: number | null): TrayPage[] {
  const at = replace === null ? -1 : tray.findIndex((p) => p.id === replace);
  if (at < 0) return [...tray, page];
  const next = tray.slice();
  next[at] = page;
  return next;
}

/** `tray` without page `id`. */
export function withoutPage(tray: readonly TrayPage[], id: number): TrayPage[] {
  return tray.filter((p) => p.id !== id);
}

/** `tray` with page `id` moved `by` places (−1 up, +1 down); null when it cannot move that way. */
export function movedPage(tray: readonly TrayPage[], id: number, by: number): TrayPage[] | null {
  const from = tray.findIndex((p) => p.id === id);
  const to = from + by;
  if (from < 0 || !Number.isInteger(by) || by === 0 || to < 0 || to >= tray.length) return null;
  const next = tray.slice();
  const [page] = next.splice(from, 1);
  next.splice(to, 0, page);
  return next;
}

/**
 * What the device keeps of the tray (saveScan): the pages in order, with their previews, for
 * `target`; for an insert, the document they are for (`fileName`, null when not known).
 */
export function savedScanOf(
  target: ScanTarget, tray: readonly TrayPage[], savedAt = Date.now(), fileName: string | null = null,
): SavedScan {
  const pages: SavedScanPage[] = tray.map((p) => ({
    bytes: p.picture.bytes, width: p.picture.width, height: p.picture.height, dpi: p.picture.dpi, preview: p.preview,
  }));
  if (target.kind !== "insert") return { target: { kind: "new" }, doc: null, savedAt, pages };
  return { target: { kind: "insert", at: target.at }, doc: fileName ? { fileName } : null, savedAt, pages };
}

/** The tray of a scan kept on the device (resumeScan), each page with a new id. */
export function trayOf(saved: SavedScan): TrayPage[] {
  return saved.pages.map((p) => trayPage({ bytes: p.bytes, width: p.width, height: p.height, dpi: p.dpi }, p.preview));
}

/** "2026-10-17": the local date, for the new PDF's name. */
export function isoDate(now: Date): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
}

/** The new PDF's name: "Scansione 2026-10-17.pdf" ("Scan 2026-10-17.pdf" in English). */
export function scanFileName(now: Date): string {
  return t("scan.fileName", { date: isoDate(now) });
}

/**
 * What Fine does for `target`, with `pageCount` pages open (null: no document): a new PDF, or
 * the pages inserted at `at`, kept within the document. An insert with no document open (a scan
 * resumed from the home page before its document) makes a new PDF.
 */
export type FinishPlan = { kind: "new"; fileName: string } | { kind: "insert"; at: number };

export function finishPlan(target: ScanTarget, pageCount: number | null, now: Date): FinishPlan {
  if (target.kind === "insert" && pageCount !== null && pageCount > 0) {
    const at = Number.isFinite(target.at) ? Math.floor(target.at) : pageCount;
    return { kind: "insert", at: Math.min(Math.max(0, at), pageCount) };
  }
  return { kind: "new", fileName: scanFileName(now) };
}

/**
 * Where the pages of a flow go when they are for a document (see the header): `fileName`, the
 * document they are for (null: not known, a scan kept by an earlier build); `open`, that document
 * while it is the open one, with the place in it held by the page it goes before (null: it is not
 * open, the pages wait for it); `at`, the index kept on the device while it is not open.
 */
interface Destination {
  readonly fileName: string | null;
  readonly open: { readonly doc: OpenDoc; readonly place: GapPlace } | null;
  readonly at: number;
}

/** Each opening's (by its target object, as ScanFlow's key): none for a new PDF. */
const destinations = new WeakMap<ScanTarget, Destination>();

/** Pages for `d` (the open document), at its place `at` as its pages are now. */
function into(d: OpenDoc, at: number): Destination {
  return { fileName: d.fileName, open: { doc: d, place: placeOfGap(d.pages, at) }, at };
}

/**
 * Pages for the document named `fileName`, at `at` (as kept on the device): placed in it when it
 * is the one open, else they wait for it.
 */
function destinationFor(fileName: string | null, at: number): Destination {
  const d = doc.peek();
  return fileName !== null && d && d.fileName === fileName ? into(d, at) : { fileName, open: null, at };
}

/**
 * Where the pages of the flow opened for `target` go: null for a new PDF; for an insert, the
 * document open when it opened (`scanFlow` set, seen by the effect below: the organizer's "+"),
 * or what resumeTray or continueKept said.
 */
function destinationOf(target: ScanTarget): Destination | null {
  let dest = destinations.get(target);
  if (!dest && target.kind === "insert") {
    const d = doc.peek();
    dest = d ? into(d, target.at) : { fileName: null, open: null, at: target.at };
    destinations.set(target, dest);
  }
  return dest ?? null;
}

/** The target as Fine would use it now (see finishPlan): what the flow says and its Fine button. */
export function targetNow(target: ScanTarget): ScanTarget {
  const dest = destinationOf(target);
  const d = doc.peek();
  if (!dest?.open || !d || dest.open.doc !== d) return { kind: "new" };
  const plan = finishPlan({ kind: "insert", at: gapOfPlace(d.pages, dest.open.place) }, d.pages.length, new Date());
  return plan.kind === "insert" ? { kind: "insert", at: plan.at } : { kind: "new" };
}

/** The document the flow's pages are for (an insert, or pages kept for one), or null: a new PDF, or not known. */
export function documentFor(target: ScanTarget): string | null {
  return destinationOf(target)?.fileName ?? null;
}

/**
 * Pages meant for a document that is not open (a scan resumed from the home page before its
 * document, or resumed or continued with another document open): Fine would make a new PDF of
 * them instead, so the flow says why and, while the device keeps them, offers to keep them for
 * later ("Più tardi", see orphanOffer).
 */
export function waitsForDocument(target: ScanTarget): boolean {
  return destinationOf(target) !== null && targetNow(target).kind === "new";
}

/** Where the device keeps a tray's pages as going: the target (an index, for an insert) and the document. */
interface KeptForm {
  readonly target: ScanTarget;
  readonly fileName: string | null;
}

/** What the device keeps for `target` now (keep): the place as an index now, and the document. */
function keptForm(target: ScanTarget): KeptForm {
  const dest = destinationOf(target);
  if (!dest) return { target: { kind: "new" }, fileName: null };
  const now = targetNow(target);
  return { target: { kind: "insert", at: now.kind === "insert" ? now.at : dest.at }, fileName: dest.fileName };
}

/** How `saved` (kept on the device) has its pages going. */
function formOf(saved: SavedScan): KeptForm {
  return { target: saved.target, fileName: saved.target.kind === "insert" ? saved.doc?.fileName ?? null : null };
}

function sameForm(a: KeptForm, b: KeptForm): boolean {
  if (a.target.kind === "new" || b.target.kind === "new") return a.target.kind === b.target.kind;
  return a.target.at === b.target.at && a.fileName === b.fileName;
}

/**
 * What the tray offers for pages meant for a document that is not open: "later", the device keeps
 * the tray, so "Più tardi" leaves them for that document; "unkept", it could not keep them
 * (notKept), so leaving would lose them: no "Più tardi", and the hint says that only a new PDF
 * keeps them. Null when they are not waiting for a document (waitsForDocument). Reads `notKept`
 * as a component does (`.value`): the component that calls it follows it.
 */
export function orphanOffer(target: ScanTarget): "later" | "unkept" | null {
  if (!waitsForDocument(target)) return null;
  return notKept.value ? "unkept" : "later";
}

/** The same corners (within a hundredth of a pixel). */
export function sameCorners(a: Corners, b: Corners): boolean {
  return a.every((p, i) => Math.abs(p[0] - b[i][0]) < 0.01 && Math.abs(p[1] - b[i][1]) < 0.01);
}

/** `corners` with corner `i` at `to`, kept inside the `width` × `height` photo. */
export function withCorner(corners: Corners, i: number, to: Point, width: number, height: number): Corners {
  const next = corners.map((p) => [p[0], p[1]] as Point) as Corners;
  next[i] = [Math.min(width, Math.max(0, to[0])), Math.min(height, Math.max(0, to[1]))];
  return next;
}

/**
 * Why a photo could not be used, in words for the user: too large, not readable here (HEIC in a
 * browser that cannot decode it says so, and to take it with the camera only where the flow has
 * a camera button: `coarse`, a touch screen, as ScanFlow decides), or anything else. With
 * `named`, the file's name first (several photos were picked together).
 */
export function photoErrorText(
  e: unknown, file: { name?: string; type?: string }, named: boolean, coarse = isCoarse.peek(),
): string {
  const code = e instanceof ScanError ? e.code : "failed";
  const heic = /^image\/hei[cf]/i.test(file.type ?? "") || /\.hei[cf]$/i.test(file.name ?? "");
  const reason = code === "too-big" ? t("image.pictureTooBig")
    : code === "unreadable" ? (heic ? t(coarse ? "scan.photoHeic" : "scan.photoHeicDesktop") : t("image.pictureUnreadable"))
    : t("scan.photoFailed");
  return named && file.name ? t("scan.photoNamed", { name: file.name, reason }) : reason;
}

const PICTURE_NAME = /\.(jpe?g|jfif|png|webp|gif|bmp|avif|hei[cf]|tiff?)$/i;

/** A picture by its type or, when the browser gives none (HEIC on some systems), its name. */
export function isPictureFile(file: { name?: string; type?: string }): boolean {
  return /^image\//i.test(file.type ?? "") || PICTURE_NAME.test(file.name ?? "");
}

// ---------------------------------------------------------------------------------------------
// State

export type Phase =
  | { step: "start" }
  /**
   * An unfinished scan of `pages` pages is kept on the device from before: continue it, or start
   * over (which forgets it). `for`: the document its pages are for (left out: a new PDF, or not
   * known). `busy`: the answer is being carried out.
   */
  | { step: "kept"; pages: number; for?: string; busy: boolean }
  /** Photo `index` of `total` (picked together) is being read. */
  | { step: "reading"; index: number; total: number }
  /**
   * The corner editor on `photo`. `found`: the corners the detector was sure of (null when it was
   * not: `corners` started as the whole photo). `replaces`: the tray page its page is to take the
   * place of (Rifai), or null. `making`: its page is being made.
   */
  | {
    step: "corners";
    photo: AnalysedPhoto;
    corners: Corners;
    found: Corners | null;
    replaces: number | null;
    index: number;
    total: number;
    making: boolean;
  }
  /** `finishing`: Fine is running (a new PDF being made, or the pages being added). */
  | { step: "tray"; finishing: boolean };

export const phase = signal<Phase>({ step: "start" });
export const tray = signal<readonly TrayPage[]>([]);
/** A message for the polite status line (`n` makes the same words a new message). */
export const said = signal<{ n: number; text: string } | null>(null);
/** A failure, shown and announced inside the flow until the next photo or page. */
export const alerted = signal<{ n: number; text: string } | null>(null);
/**
 * The device refused to keep the tray as it is now (storage blocked or full): said under the pages.
 * The latest save's answer: false again once a later save of the tray has worked.
 */
export const notKept = signal(false);
/** "Più tardi" (or Cancel) waits for the tray's save on its way before the flow closes: nothing else runs meanwhile. */
export const leaving = signal(false);

const SETTINGS_KEY = "pdf-editor.scan";
const MODES: readonly ScanMode[] = ["document", "grey", "bw", "original"];
const SHAPES: readonly PageShape[] = ["a4", "photo"];

/** The mode and page shape used last, remembered on this device (a convenience: nothing if storage refuses). */
function remembered(): { mode: ScanMode; shape: PageShape } {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null") as { mode?: unknown; shape?: unknown } | null;
    return {
      mode: MODES.includes(saved?.mode as ScanMode) ? (saved!.mode as ScanMode) : "document",
      shape: SHAPES.includes(saved?.shape as PageShape) ? (saved!.shape as PageShape) : "a4",
    };
  } catch {
    return { mode: "document", shape: "a4" };
  }
}

const start = remembered();
/** Documento (the default), Grigio, Bianco e nero, Originale: for the next pages. */
export const scanMode = signal<ScanMode>(start.mode);
/** A4 (portrait or landscape, by the sheet; the default) or the sheet's own proportions. */
export const pageShape = signal<PageShape>(start.shape);

function remember() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ mode: scanMode.peek(), shape: pageShape.peek() }));
  } catch {
    // Not remembered: it still applies until the app closes.
  }
}

export function setScanMode(mode: ScanMode) {
  scanMode.value = mode;
  remember();
}

export function setPageShape(shape: PageShape) {
  pageShape.value = shape;
  remember();
}

/** Bumped when the flow closes: work still on its way for an older generation lands nowhere. */
let generation = 0;
/** Photos picked and not read yet, and where the current batch is (index of total). */
let queue: File[] = [];
let read = 0;
let total = 0;
/** The tray page the photos being read are to replace (Rifai), or null to add pages. */
let replacing: number | null = null;
let messages = 0;

/**
 * Whether the scan the device keeps is this opening's to replace and forget (see the header):
 * null, not asked yet; "checking", the store is being asked (`checking` settles when it has
 * answered); "asking", a scan from before is kept and the user is asked (phase "kept"); "mine",
 * resumed from it, nothing was kept, or the user has chosen.
 */
let claim: "checking" | "asking" | "mine" | null = null;
let checking: Promise<void> | null = null;

/** What the device keeps is this opening's (read afresh: it changes across an await). */
function claimed(): boolean {
  return claim === "mine";
}

/** Scan client calls still on their way (of any opening), and whether the worker is to go once they have ended. */
let calls = 0;
let disposeWhenDone = false;

function say(text: string) {
  said.value = { n: ++messages, text };
}

function fail(text: string) {
  alerted.value = { n: ++messages, text };
}

/** A toast once the flow's modal has gone, so it is seen and announced. */
function toastAfterClose(text: string) {
  requestAnimationFrame(() => showToast("info", text));
}

/** The tray's latest save (keep) while it is on its way: settled once `notKept` has its answer. */
let saving: Promise<void> | null = null;
let saves = 0;
/** How this opening last had the device keep its pages going (keep, or what it resumed), or null. */
let lastKept: KeptForm | null = null;

/** The tray's save on its way, or null (read afresh: it changes across an await). */
function pendingSave(): Promise<void> | null {
  return saving;
}

/**
 * Keep the tray on the device as it is now (an empty one is forgotten), for where its pages go
 * now. `notKept` takes the answer of the latest save only (the store answers in order; an earlier
 * one is out of date).
 */
function keep() {
  const target = scanFlow.peek();
  if (!target || claim !== "mine") return; // a scan kept from before is not replaced unasked
  const g = generation;
  const n = ++saves;
  const kept = keptForm(target);
  lastKept = kept;
  const saved = savedScanOf(kept.target, tray.peek(), Date.now(), kept.fileName);
  saving = saveScan(saved).then((ok) => ok, () => false).then((ok) => {
    if (g !== generation || n !== saves) return; // the flow closed, or a later save has the say
    saving = null;
    notKept.value = !ok;
  });
}

/**
 * The tray kept on the device again when a page operation has moved its place since it was last
 * kept (a tab killed then finds the place as the document is kept). Not while Fine runs: its own
 * pages landing move it, and the scan is let go then anyway.
 */
function keepIfMoved(target: ScanTarget) {
  const p = phase.peek();
  if (claim !== "mine" || !lastKept || !tray.peek().length || (p.step === "tray" && p.finishing)) return;
  if (!sameForm(lastKept, keptForm(target))) keep();
}

// The place is taken the moment the flow is asked for, from the pages as the user saw them when
// tapping: a page operation landing before ScanFlow mounts must not shift it. While the flow is
// open, a page operation that moves it has the tray kept again.
effect(() => {
  const target = scanFlow.value;
  void doc.value?.layout?.value; // the pages changed
  if (!target) return;
  untracked(() => {
    destinationOf(target);
    keepIfMoved(target);
  });
});

/** The phase to rest on when no photo is being worked on: the tray, or the start when it is empty. */
function idle(): Phase {
  return tray.peek().length ? { step: "tray", finishing: false } : { step: "start" };
}

/** On from the start or the "kept" question: the photos picked meanwhile, or the tray (the start). */
function goOn(g: number) {
  if (g !== generation) return;
  if (queue.length) void nextPhoto(g);
  else phase.value = idle();
}

/**
 * A call to the scan client, counted while it is on its way: when the flow has closed meanwhile,
 * the worker is terminated again once the last such call has ended (it may have started a new
 * one: a photo decoded on the main thread is sent to a worker afterwards), unless a flow is open
 * again by then (its own close ends it).
 */
function scanCall<T>(call: () => Promise<T>): Promise<T> {
  calls++;
  let p: Promise<T>;
  try {
    p = call();
  } catch (e) {
    p = Promise.reject(e);
  }
  return p.finally(() => {
    calls--;
    if (calls > 0 || !disposeWhenDone) return;
    disposeWhenDone = false;
    if (!scanFlow.peek()) disposeScanWorker();
  });
}

/**
 * The pages cannot be used now, but can later, and the device keeps them (as far as it has
 * answered): leaving keeps them (no "lost" question). Not while Fine runs.
 */
function usableLater(): boolean {
  const target = scanFlow.peek();
  const p = phase.peek();
  if (!target || !tray.peek().length || notKept.peek() || (p.step === "tray" && p.finishing)) return false;
  return engineStatus.peek() === "error" || waitsForDocument(target);
}

/** Fine is running, or "Più tardi" waits for the device: the tray stays as it is. */
function held(): boolean {
  const p = phase.peek();
  return leaving.peek() || (p.step === "tray" && p.finishing);
}

// ---------------------------------------------------------------------------------------------
// Opening and closing

/**
 * Open the scan flow with a saved tray (the home page's "Riprendi" on an unfinished scan, or the
 * toast after resuming its document): its pages, for its target. An insert goes into the open
 * document only when that is the one its pages are for (by name); else they wait for it. Nothing
 * when the flow is already open or the scan has no pages.
 */
export function resumeTray(saved: SavedScan): void {
  if (scanFlow.peek() || !saved?.pages?.length) return;
  const pages = trayOf(saved);
  claim = "mine"; // what the device keeps is this tray
  checking = null;
  const target: ScanTarget = saved.target.kind === "insert" ? { kind: "insert", at: saved.target.at } : { kind: "new" };
  if (target.kind === "insert") destinations.set(target, destinationFor(saved.doc?.fileName ?? null, target.at));
  lastKept = formOf(saved); // what the device has
  batch(() => {
    tray.value = pages;
    phase.value = { step: "tray", finishing: false };
    scanFlow.value = target;
  });
}

/** The "kept" question about a scan kept from before, as its summary says. */
function keptPhase(kept: Pick<ScanSummary, "pages" | "doc">): Phase {
  const { pages, doc: d } = kept;
  return d ? { step: "kept", pages, for: d.fileName, busy: false } : { step: "kept", pages, busy: false };
}

/**
 * Fine has used the tray's pages (in the open document, or a new one): the scan kept on the
 * device is forgotten once that document has been kept, or is known not to be (see the header).
 * A save that was tried and failed (the engine stopped, the store refused) keeps the scan as it
 * is: what the device keeps of the document may lack its pages, and Riprendi may then offer them
 * twice, never not at all. Settled once that has been decided; until then a new opening waits
 * before asking the device (flowOpened).
 */
let handingOver: Promise<void> | null = null;

function handOver(): Promise<void> {
  const done = keepOpenDocumentOutcome()
    .catch((): KeepOutcome => "failed")
    .then((outcome) => (outcome === "failed" ? undefined : forgetScan()))
    .then(() => undefined, () => undefined);
  handingOver = done;
  void done.then(() => {
    if (handingOver === done) handingOver = null;
  });
  return done;
}

/**
 * The flow has opened (ScanFlow mounted): unless it was resumed, ask the device whether a scan
 * from before is kept; if so the user is asked (phase "kept") before anything replaces it. Also
 * started by the first photo, whichever comes first; once per opening.
 */
export function flowOpened(): void {
  if (claim !== null || !scanFlow.peek()) return;
  claim = "checking";
  const g = generation;
  // A scan Fine has just used is not one "kept from before": its forget runs first.
  const ask = handingOver ? handingOver.then(() => scanSummary()) : scanSummary();
  checking = ask.then((s) => s, () => null).then((kept) => {
    if (g !== generation) return;
    checking = null;
    if (!kept || kept.pages <= 0) {
      claim = "mine";
      return;
    }
    claim = "asking";
    phase.value = keptPhase(kept);
  });
}

/**
 * "Continua la scansione": the pages kept from before come back in the tray, then the photos
 * picked meanwhile, for where this opening puts them (kept again so); unless they were for a
 * document other than the one this opening adds to (or whose is not known): then they stay that
 * document's and wait for it (the orphan case: Fine makes a new PDF, "Più tardi" keeps them for
 * it). When they cannot be read now, it says so and the question stays; when they have gone, an
 * empty start.
 */
export async function continueKept(): Promise<void> {
  const p = phase.peek();
  if (p.step !== "kept" || p.busy || claim !== "asking") return;
  const g = generation;
  alerted.value = null;
  phase.value = { ...p, busy: true };
  const saved = await loadScan().catch(() => null);
  if (g !== generation) return;
  if (!saved?.pages.length) {
    const still = await scanSummary().catch(() => null);
    if (g !== generation) return;
    if (still && still.pages > 0) {
      phase.value = keptPhase(still);
      fail(t("scan.keptUnreadable"));
      return;
    }
    claim = "mine";
    fail(t("resume.scanGone"));
    goOn(g);
    return;
  }
  claim = "mine";
  const target = scanFlow.peek();
  if (target && saved.target.kind === "insert") {
    const name = saved.doc?.fileName ?? null;
    const here = destinationOf(target);
    // Another document's pages (or pages whose document is not known) do not go into this one.
    if (!here?.open || name === null || here.fileName !== name) {
      destinations.set(target, destinationFor(name, saved.target.at));
    }
  }
  tray.value = [...trayOf(saved), ...tray.peek()];
  lastKept = formOf(saved); // what the device has
  if (target && !sameForm(lastKept, keptForm(target))) keep(); // kept again for where the pages go now
  say(t("scan.keptContinued"));
  goOn(g);
}

/** "Ricomincia da capo": the scan kept from before is forgotten (only now), and this one starts empty. */
export async function startOver(): Promise<void> {
  const p = phase.peek();
  if (p.step !== "kept" || p.busy || claim !== "asking") return;
  const g = generation;
  alerted.value = null;
  phase.value = { ...p, busy: true };
  await forgetScan();
  if (g !== generation) return;
  claim = "mine";
  if (tray.peek().length) keep();
  say(t("scan.keptStartedOver"));
  goOn(g);
}

/**
 * The flow is gone (ScanFlow unmounted, whatever closed it): the photo on screen closed, the
 * queue dropped, the scan worker terminated (its memory goes; again once a call still on its way
 * has ended), and a clean state for the next opening. What the device keeps is not touched here
 * (Fine and Cancel forget it, when it is this opening's).
 */
export function flowClosed(): void {
  generation++;
  const p = phase.peek();
  if (p.step === "corners") p.photo.image.close();
  queue = [];
  read = total = 0;
  replacing = null;
  claim = null;
  checking = null;
  saving = null; // still written by the store, its answer lands nowhere
  lastKept = null;
  batch(() => {
    phase.value = { step: "start" };
    tray.value = [];
    said.value = null;
    alerted.value = null;
    notKept.value = false;
    leaving.value = false;
  });
  disposeScanWorker();
  if (calls > 0) disposeWhenDone = true;
}

/**
 * Close the flow; with `forget`, forgetting the scan kept on the device, when it is this
 * opening's (never one kept from before that the user was not asked about).
 */
function closeFlow(forget: boolean) {
  if (forget && claim === "mine") void forgetScan();
  scanFlow.value = null;
}

/**
 * "Più tardi" (and Cancel) while the pages cannot be used now (a resumed scan whose document is
 * not open, the engine down) and the device keeps them: the flow closes and the scan stays on the
 * device, for the home page's Riprendi or "Foto o scansione" once the document is open. A save of
 * the tray still on its way is waited for first (`leaving`, usually a moment): refused, the flow
 * stays and says so (no "Più tardi" any more). False when nothing was done: not that case (or
 * not any more), or already waiting.
 */
export async function keepForLater(): Promise<boolean> {
  if (leaving.peek() || !usableLater()) return false;
  const g = generation;
  if (pendingSave()) {
    leaving.value = true;
    for (let s = pendingSave(); s && g === generation; s = pendingSave()) await s; // and any made meanwhile
    if (g !== generation) return false;
    leaving.value = false;
    if (!usableLater()) {
      if (notKept.peek()) fail(t("scan.laterFailed"));
      return false;
    }
  }
  closeFlow(false);
  toastAfterClose(t("scan.keptForLater"));
  return true;
}

/**
 * Cancel (the close button, Escape, the back gesture): asks first only when the tray has pages,
 * which would be lost; pages that can only be used later are kept instead (keepForLater). Not
 * while Fine is running, nor while "Più tardi" waits. True when the flow closed.
 */
export async function cancelScan(): Promise<boolean> {
  const p = phase.peek();
  if (!scanFlow.peek() || leaving.peek() || (p.step === "tray" && p.finishing)) return false;
  const g = generation;
  if (await keepForLater()) return true;
  if (g !== generation || !scanFlow.peek()) return false;
  const count = tray.peek().length;
  if (count > 0) {
    const ok = await confirmDialog({
      title: t("scan.cancelTitle"),
      body: count === 1 ? t("scan.cancelBodyOne") : t("scan.cancelBody", { count }),
      confirmLabel: t("scan.cancelConfirm"),
    });
    if (!ok || g !== generation || !scanFlow.peek()) return false;
  }
  closeFlow(true);
  return true;
}

// ---------------------------------------------------------------------------------------------
// Photos

/**
 * Photos picked (the camera's one, or several from the gallery, or dropped on the flow): read one
 * after the other, each to the corner editor. With `replace` (Rifai on a tray page), the first
 * photo's page takes that page's place. Photos picked while others are still being worked on, or
 * while the "kept" question is open, wait their turn.
 */
export function addPhotos(files: readonly File[], replace: number | null = null): void {
  if (!scanFlow.peek()) return;
  const picked = [...files].filter(Boolean);
  if (!picked.length) return;
  const p = phase.peek();
  if (p.step === "reading" || p.step === "corners" || p.step === "kept") {
    queue.push(...picked);
    total += picked.length;
    return;
  }
  if (held()) return;
  alerted.value = null;
  replacing = replace;
  queue = replace === null ? picked : picked.slice(0, 1);
  read = 0;
  total = queue.length;
  void nextPhoto(generation);
}

/** Photos can join now: the flow is open, Fine is not running and "Più tardi" is not waiting. */
export function takesPhotos(): boolean {
  return scanFlow.peek() !== null && !held();
}

/**
 * Files dropped onto the flow: the pictures among them join as photos picked from the gallery
 * (in the order dropped); when there is none (a PDF, a document), it says so inside the flow.
 */
export function dropPhotos(files: readonly File[]): void {
  if (!takesPhotos() || !files.length) return;
  const pictures = files.filter(isPictureFile);
  if (!pictures.length) {
    fail(t("scan.dropNotPicture"));
    return;
  }
  addPhotos(pictures);
}

/** Read the next photo of the queue and open the corner editor on it; the tray (or the start) when none is left. */
async function nextPhoto(g: number): Promise<void> {
  if (!claimed()) {
    // Nothing is made before the device has said whether a scan from before is kept.
    if (claim === "asking") return;
    phase.value = { step: "reading", index: read + 1, total };
    flowOpened();
    await checking;
    if (g !== generation || !claimed()) return; // the "kept" question: its answer goes on
  }
  for (;;) {
    const file = queue.shift();
    if (!file) {
      replacing = null;
      phase.value = idle();
      return;
    }
    read++;
    phase.value = { step: "reading", index: read, total };
    let photo: AnalysedPhoto;
    try {
      photo = await scanCall(() => analysePhoto(file));
    } catch (e) {
      if (g !== generation) return;
      if (!(e instanceof ScanError) || e.code === "failed") console.warn("The photo could not be read", e);
      fail(photoErrorText(e, file, total > 1));
      continue;
    }
    if (g !== generation) {
      photo.image.close(); // the flow closed meanwhile
      return;
    }
    const found = photo.confidence >= FOUND_CONFIDENCE ? photo.corners : null;
    phase.value = {
      step: "corners", photo, corners: found ?? wholeFrame(photo.width, photo.height), found, replaces: replacing,
      index: read, total, making: false,
    };
    return;
  }
}

/** The corners moved in the editor. */
export function setCorners(corners: Corners): void {
  const p = phase.peek();
  if (p.step !== "corners" || p.making) return;
  phase.value = { ...p, corners };
}

/** "Tutta la foto": the corners on the photo's own corners; pressed again, back to the edges found. */
export function toggleWholePhoto(): void {
  const p = phase.peek();
  if (p.step !== "corners" || p.making) return;
  const whole = wholeFrame(p.photo.width, p.photo.height);
  const corners = p.found && sameCorners(p.corners, whole) ? p.found : whole;
  phase.value = { ...p, corners };
}

/**
 * What "Tutta la foto" would do now: "whole" (put the corners on the photo's), "found" (back to
 * the edges found), or null (nothing: they are on the photo's corners and nothing was found).
 */
export function wholePhotoAction(p: Extract<Phase, { step: "corners" }>): "whole" | "found" | null {
  if (!sameCorners(p.corners, wholeFrame(p.photo.width, p.photo.height))) return "whole";
  return p.found ? "found" : null;
}

/** "Scarta la foto": this photo makes no page; on to the next one (or back to the tray). */
export function discardPhoto(): void {
  const p = phase.peek();
  if (p.step !== "corners" || p.making) return;
  if (!queue.length) replacing = null;
  const going = nextPhoto(generation); // the editor leaves the screen first, then its photo is closed
  p.photo.image.close();
  void going;
}

/**
 * "Aggiungi pagina": the page made from the photo inside the corners, in the mode and page shape
 * chosen, joins the tray (or takes the place of the page being retaken), kept on the device at
 * once; then the next photo. A failure is said and the editor stays, to try again.
 */
export async function makePage(): Promise<void> {
  const p = phase.peek();
  if (p.step !== "corners" || p.making) return;
  if (!cornersUsable(p.corners, p.photo.width, p.photo.height)) {
    fail(t("scan.cornersCrossed"));
    return;
  }
  const g = generation;
  alerted.value = null;
  const editing: Extract<Phase, { step: "corners" }> = { ...p, making: true };
  phase.value = editing;
  say(t("scan.making"));
  let page: TrayPage;
  try {
    const made = await scanCall(() => processPhoto(p.photo, p.corners, scanMode.peek(), pageShape.peek()));
    if (g !== generation) return;
    page = trayPage(made, await made.preview.arrayBuffer());
  } catch (e) {
    if (g !== generation) return;
    console.warn("The page could not be made", e);
    if (phase.peek() === editing) phase.value = { ...editing, making: false };
    said.value = null;
    fail(t("scan.makeFailed"));
    return;
  }
  if (g !== generation) return;
  const before = tray.peek();
  const replaced = p.replaces !== null && before.some((x) => x.id === p.replaces);
  const next = withPage(before, page, p.replaces);
  replacing = null; // only the first photo of a retake replaces
  tray.value = next;
  keep();
  const n = next.indexOf(page) + 1;
  say(replaced ? t("scan.replaced", { n }) : t("scan.added", { n }));
  const going = nextPhoto(g); // the editor leaves the screen first, then its photo is closed
  p.photo.image.close();
  await going;
}

// ---------------------------------------------------------------------------------------------
// The tray

/** Delete page `id` from the tray (kept on the device at once). */
export function removePage(id: number): void {
  const p = phase.peek();
  if (held()) return;
  const before = tray.peek();
  const at = before.findIndex((x) => x.id === id);
  if (at < 0) return;
  alerted.value = null;
  tray.value = withoutPage(before, id);
  keep();
  say(t("scan.deleted", { n: at + 1 }));
  if (p.step === "tray" && !tray.peek().length) phase.value = { step: "start" };
}

/** Move page `id` up (−1) or down (+1) in the tray (kept on the device at once). False when it cannot. */
export function movePage(id: number, by: -1 | 1): boolean {
  if (held()) return false;
  const next = movedPage(tray.peek(), id, by);
  if (!next) return false;
  alerted.value = null;
  tray.value = next;
  keep();
  say(t("scan.moved", { n: next.findIndex((x) => x.id === id) + 1 }));
  return true;
}

/** The engine is down (crashed, or never loaded): said inside the flow, with what becomes of the pages. */
function failEngineDown() {
  fail(t(notKept.peek() ? "scan.engineDownNotKept" : "scan.engineDown"));
}

/** Fine was refused or failed: the tray as it was, to try again (kept again if its place moved meanwhile). */
function backToTray() {
  phase.value = { step: "tray", finishing: false };
  said.value = null;
  const target = scanFlow.peek();
  if (target) keepIfMoved(target);
}

/**
 * Fine: the tray's pages become a new PDF ("Scansione AAAA-MM-GG.pdf", asking first when the
 * open document has edits not downloaded), or join the open document at their place as it is now
 * (see the header), as one edit. Pages meant for a document that is not open make a new PDF,
 * asking first when the device keeps a document for Riprendi, which the new one would replace
 * there. Done: the flow closes, and the scan is forgotten on the device once the document holding
 * its pages has been kept (handOver: this resolves after it). Refused or failed: the tray stays as
 * it was (the engine got copies of the pages); with the engine down, said inside the flow (nothing
 * is tried: a new PDF would first leave the open document). Not while "Più tardi" waits. True
 * when it worked.
 */
export async function finishScan(): Promise<boolean> {
  const target = scanFlow.peek();
  const pages = tray.peek();
  const p = phase.peek();
  if (!target || !pages.length || p.step !== "tray" || p.finishing || leaving.peek()) return false;
  const g = generation;
  alerted.value = null;
  if (engineStatus.peek() === "error") {
    failEngineDown();
    return false;
  }
  phase.value = { step: "tray", finishing: true };
  const plan = finishPlan(targetNow(target), doc.peek()?.pages.length ?? null, new Date());
  if (plan.kind === "new" && destinationOf(target) !== null) {
    const kept = await sessionSummary().catch(() => null);
    if (g !== generation) return false;
    if (kept) {
      const ok = await confirmDialog({
        title: t("scan.orphanNewTitle"),
        body: t("scan.orphanNewBody", { name: kept.fileName }),
        confirmLabel: t("scan.orphanNewConfirm"),
      });
      if (g !== generation) return false;
      if (!ok) {
        backToTray();
        return false;
      }
    }
  }
  say(t(plan.kind === "new" ? "scan.finishingNew" : "scan.finishingInsert"));
  // Copies: the engine empties the buffers it is sent, and the tray must survive a failure.
  const pictures: PagePicture[] = pages.map((x) => ({ ...x.picture, bytes: x.picture.bytes.slice(0) }));
  let done = false;
  let added = 0;
  try {
    if (plan.kind === "new") {
      done = await newFromPicturesAction(pictures, plan.fileName);
    } else {
      // runPagesEdit rather than insertPictures: Fine must know whether the pages went in. It
      // holds the place by its page from here, should a page operation asked before land first.
      const result = await runPagesEdit({ kind: "pictures", at: plan.at, pictures }, plan.at);
      done = result !== null;
      added = result ? result.layout.from.filter((f) => f === null).length : 0;
    }
  } catch (e) {
    console.error("The scanned pages could not be used", e);
    done = false;
  }
  if (g !== generation) return done;
  if (!done) {
    backToTray();
    // The engine stopped (or never loaded): nothing else says so, the home page is under the modal.
    if (engineStatus.peek() === "error") failEngineDown();
    // A new PDF that failed otherwise was said by its own dialog (or the user said no to losing edits).
    else if (plan.kind === "insert") fail(t("scan.insertFailed"));
    return false;
  }
  const mine = claim === "mine";
  closeFlow(false);
  if (added > 0) toastAfterClose(added === 1 ? t("pageOps.addedOne") : t("pageOps.added", { count: added }));
  if (mine) await handOver();
  return true;
}
