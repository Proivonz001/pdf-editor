// "Riprendi", the saving side: the open document and its edits are kept on this device as the user
// works (platform/resume.ts, IndexedDB), so that after the tab was closed or killed (Android kills
// it while the camera app is open) the home page can offer them back (ResumeCard.tsx).
//
// What is kept follows the document on screen, ONE document, by one rule: whatever the engine's
// exportSession gives (the file as opened and the edit log) is kept, and when it gives null what
// this page kept is forgotten instead. So:
// - after an edit, an undo, a redo or a page operation (the history changes), about a second
//   later (AUTOSAVE_DELAY_MS, one save for a burst of edits; edits that never pause still get one
//   every AUTOSAVE_MAX_WAIT_MS): the export goes to saveSession, with the view (page, zoom, fit)
//   to restore; also about a second after a document opens (with nothing to keep, what this page
//   kept of the one before goes), and at once for a document made here (below);
// - right away when the page is hidden or left (visibilitychange, pagehide: the last chance on a
//   phone), when a save is due or only the view changed;
// - the engine gives null for a document that needed a password to open (its edits would sit
//   unencrypted on the device; the app does not even ask then), for one holding pages from such a
//   PDF, and for a file from the device with no edits (the user has that file, also while a scan
//   to add pages to it is open: the scan flow keeps the scan, and the card then offers the scan);
// - it gives a document made here (from photos or scans: SessionExport.madeHere, which its log
//   carries across a resume) even with no edits, and after a download too: it exists nowhere else
//   (or, undone after a download, in that state nowhere else). It is kept at once when it opens,
//   so a new scan is not lost when the tab is killed before any edit (the camera open again for
//   one more page);
// - the scan flow's Fine asks for a save at once (keepOpenDocument: the scanned pages are now in
//   the open document, or are a new one) and lets the scan it kept on the device go only once that
//   save has answered, so a tab killed in between still finds the pages in one of the two;
// - each record says whether the document as it was opened exists nowhere else (neverDownloaded:
//   made here, and not downloaded as it is since), for the card ("non ancora scaricato" with no
//   edits) and for Riprendi, which counts the resumed document the same (see recordFlag);
// - closing the document (Chiudi) forgets it. An open that fails leaves what was kept as it is
//   (the home page offers it again).
//
// One save at a time, never more than one export in flight. A save waits while the engine writes
// an edit (busy) and while a download or share runs (downloadRunning: its bytes must not wait
// behind an export), and runs once they are done; the export is then answered after every edit
// sent before it (the worker serves requests in order). It goes straight to the engine, not
// through the actions' queue (actions.ts, exclusive), which would show the app as busy. A save
// whose document went meanwhile (closed, another opened) stores nothing new, and once it has
// reached the store, what is kept counts as not known until the forget or the save of what came
// next has run after it (the store runs its calls in order): so a document closed while its save
// is being written is still forgotten.
//
// Two tabs: what this tab forgets is only what it saved or resumed itself (forgetSession "own",
// platform/resume.ts), so a tab that opens a file just to read it leaves alone what another tab
// keeps of a document with edits (or what an earlier visit kept: still offered on the home page,
// until a document with edits takes its place or Dimentica). A save replaces whatever is kept:
// with edits in two tabs, the last one saved is kept.
//
// Storage that cannot be used (private browsing, blocked) makes this do nothing at all (no export
// either); a save the storage refuses (a full disk) is said once per run of the app, in a toast.
// To make room it may first forget what this page itself kept of another document, and try once
// more; never another tab's record (it may be that tab's only copy of its edits) nor an earlier
// visit's (the user may still want it: Dimentica is theirs to press): then nothing new is kept.
// The home page's card is read again whenever the home page shows, and while it shows, whenever
// what is kept changes (resumeChanged: a scan the scan flow keeps or forgets, another tab's saves).
import { effect, untracked } from "@preact/signals";
import type { HistoryState } from "../../engine/protocol";
import { t } from "../../i18n";
import {
  forgetSession, resumeAvailable, resumeChanged, saveSession, type SavedSession, type SavedView,
} from "../../platform/resume";
import {
  busy, currentPage, dirty, doc, downloadRunning, engine, engineStatus, fitMode, history, neverDownloaded, opening,
  showToast, zoom,
} from "../../state";
import type { OpenDoc } from "../../viewer/model";
import { refreshResume, resuming, settlePendingForgets } from "./ResumeCard";

/** How long after the last change a save runs (a burst of edits makes one save). */
export const AUTOSAVE_DELAY_MS = 1000;
/** A save due this long is not put off any more by changes that keep coming (edits without a pause). */
export const AUTOSAVE_MAX_WAIT_MS = 10_000;

/** What a save of the open document does (planFor). */
type Plan = "forget" | "export";

/**
 * What the store holds of this page's, as far as this run of the app knows: the state of document
 * `docId` (saved with `view`), nothing ("none", after a forget), or not known ("unknown": at the
 * start, a record of an earlier visit may be there; and while a save is being written, and after
 * one whose document went meanwhile).
 */
type Kept = { docId: number; view: SavedView } | "none" | "unknown";

let started = false;
/** Counts startAutosave calls that started: an answer meant for an earlier one is dropped. */
let starts = 0;
let stops: (() => void)[] = [];

/** Whether the store can be used: null until resumeAvailable answers. */
let available: boolean | null = null;
let kept: Kept = "unknown";
/** A store refusal was said (once per run of the app). */
let warned = false;

let timer: ReturnType<typeof setTimeout> | null = null;
/** A save is due (the history or the document changed since the last one started), since `dueSince`. */
let wanted = false;
let dueSince = 0;
/** A save waits for the engine or a download to be done (the idle effect runs it). */
let waiting = false;
/** The save in flight, if any; and, once it is being written, the document and view it keeps. */
let inFlight: Promise<void> | null = null;
let writing: { docId: number; view: SavedView } | null = null;
/** Another save was asked for while one was in flight (`againNow`: at once, for a hidden page). */
let again = false;
let againNow = false;
/** Waiting for keepOpenDocument: answered when the next save to start has ended (or the document went). */
let askers: ((outcome: KeepOutcome) => void)[] = [];
/** Bumped whenever the document on screen changes or goes: a save started before stores nothing. */
let generation = 0;

/** What the state effect saw last; and the last change of what is kept that the card was read for. */
let lastDoc: OpenDoc | null = null;
let lastHistory: HistoryState | null = null;
let lastDirty = false;
let lastHome = false;
let lastChange = 0;

/**
 * Keep the open document for Riprendi from now on (see the header). Once, from main.tsx, before
 * the first render; calling it again does nothing.
 */
export function startAutosave(): void {
  if (started) return;
  started = true;
  const me = ++starts;
  // Until it answers, saves are tried (and fail quietly where storage is blocked).
  resumeAvailable().then(
    (ok) => { if (me === starts) available = ok; },
    () => { if (me === starts) available = false; },
  );
  stops.push(effect(() => {
    const d = doc.value;
    const o = opening.value;
    const h = history.value;
    const isDirty = dirty.value;
    untracked(() => onState(d, o, h, isDirty));
  }));
  // A save that waited for the engine or a download runs once both are done.
  stops.push(effect(() => {
    const idle = !downloadRunning.value && busy.value === null;
    if (idle && waiting) untracked(() => run(false));
  }));
  // What is kept changed (a scan the scan flow kept or forgot, a save or a forget in another tab)
  // while the home page shows: its card is read again. With a document open it is read when the
  // home page shows again.
  lastChange = resumeChanged.peek();
  stops.push(effect(() => {
    const change = resumeChanged.value;
    untracked(() => {
      if (change === lastChange) return;
      lastChange = change;
      if (doc.peek() === null && opening.peek() === null) void refreshResume();
    });
  }));
  const onVisibility = () => {
    if (document.visibilityState === "hidden") flushAutosave();
  };
  const onPageHide = () => flushAutosave();
  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("visibilitychange", onVisibility);
    stops.push(() => document.removeEventListener("visibilitychange", onVisibility));
  }
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("pagehide", onPageHide);
    stops.push(() => window.removeEventListener("pagehide", onPageHide));
  }
}

/**
 * Stop keeping the document and start over (for the tests). A save in flight still ends, storing
 * nothing, and does not hold up the next start.
 */
export function stopAutosave(): void {
  for (const stop of stops) stop();
  stops = [];
  cancelTimer();
  started = false;
  available = null;
  kept = "unknown";
  warned = false;
  wanted = waiting = again = againNow = false;
  answer("none");
  inFlight = null;
  writing = null;
  generation++;
  lastDoc = null;
  lastHistory = null;
  lastDirty = false;
  lastHome = false;
}

/** Resolves once no save is in flight (for the tests). */
export async function autosaveIdle(): Promise<void> {
  while (inFlight) await inFlight;
}

/**
 * How a save asked by keepOpenDocumentOutcome ended: "kept", the device keeps the document as it
 * is now; "none", nothing will be kept of it (nothing to keep, a password, storage that cannot be
 * used, the document gone meanwhile, the autosave not started); "failed", the save was tried and
 * did not happen (the engine stopped, the store refused or failed), so what the device keeps may
 * lack the latest edits.
 */
export type KeepOutcome = "kept" | "none" | "failed";

/**
 * Keep the open document now (the scan flow's Fine: the scanned pages are in it, or are it), as
 * the autosave would a second later. Resolves once that save has answered: true when the device
 * now keeps the document as it is, false otherwise. Never rejects. See keepOpenDocumentOutcome.
 */
export function keepOpenDocument(): Promise<boolean> {
  return keepOpenDocumentOutcome().then((outcome) => outcome === "kept");
}

/**
 * keepOpenDocument with the reason: after the edits sent before, while no download runs and the
 * engine writes no edit; resolves once that save has answered (KeepOutcome). Never rejects.
 */
export function keepOpenDocumentOutcome(): Promise<KeepOutcome> {
  if (!started || available === false || !doc.peek()) return Promise.resolve("none");
  return new Promise((resolve) => {
    askers.push(resolve);
    if (!wanted) dueSince = Date.now();
    wanted = true;
    cancelTimer();
    run(false);
  });
}

/** Answer everyone waiting in keepOpenDocument. */
function answer(outcome: KeepOutcome) {
  const waiting = askers;
  askers = [];
  for (const resolve of waiting) resolve(outcome);
}

/**
 * The page is being hidden or left: what is due is saved now, without waiting for the delay, the
 * engine or a download (the page may never come back); also when only the view changed since the
 * last save. A "Dimentica" still offering "Annulla" is carried out.
 */
export function flushAutosave(): void {
  settlePendingForgets();
  const d = doc.peek();
  if (!d || available === false) return;
  const saved = writing ?? (typeof kept === "object" ? kept : null);
  const viewChanged = saved !== null && saved.docId === d.id && !sameView(saved.view, viewNow());
  if (!wanted && !waiting && !again && !viewChanged) return;
  cancelTimer();
  run(true);
}

// ---------------------------------------------------------------------------------------------
// When

function onState(d: OpenDoc | null, o: string | null, h: HistoryState, isDirty: boolean) {
  if (d !== lastDoc) {
    const had = lastDoc;
    lastDoc = d;
    generation++; // a save of the one before stores nothing now
    cancelTimer();
    wanted = waiting = again = againNow = false;
    answer("none"); // what they asked to keep has gone
    // Resumed with Riprendi: what is kept is this document's (a save that the storage refuses
    // must not forget it to make room).
    if (d && resuming.peek() === "session") kept = { docId: d.id, view: viewNow() };
    // A document made here (from photos or scans: not downloaded, no edits) exists nowhere else,
    // the scan flow has let its pages go: kept at once.
    if (d) schedule(isDirty && h.editCount === 0 ? 0 : AUTOSAVE_DELAY_MS);
    else if (had && o === null) forget(); // closed by the user (an open in progress sets `opening`)
  } else if (d && (h !== lastHistory || (isDirty !== lastDirty && h.editCount === 0))) {
    // An edit, undo, redo or page operation; or, with no edits, downloaded (or not any more).
    schedule();
  }
  lastHistory = h;
  lastDirty = isDirty;
  // The home page shows (at the start, after a close, after an open that failed): its card is read again.
  const home = d === null && o === null;
  if (home && !lastHome) void refreshResume();
  lastHome = home;
}

/** A save is due: in `after` ms from now, or sooner when it has been due for long. */
function schedule(after = AUTOSAVE_DELAY_MS) {
  const now = Date.now();
  if (!wanted) dueSince = now;
  wanted = true;
  cancelTimer();
  if (available === false) return;
  const delay = Math.max(0, Math.min(after, dueSince + AUTOSAVE_MAX_WAIT_MS - now));
  timer = setTimeout(() => {
    timer = null;
    run(false);
  }, delay);
}

function cancelTimer() {
  if (timer) clearTimeout(timer);
  timer = null;
}

/** Save now (`now`: also while the engine or a download is busy), or once the one in flight ends. */
function run(now: boolean) {
  if (inFlight) {
    again = true;
    if (now) againNow = true;
    return;
  }
  if (!now && (downloadRunning.peek() || busy.peek() !== null)) {
    waiting = true;
    return;
  }
  waiting = false;
  wanted = false;
  const asked = askers; // this save keeps what they asked for
  askers = [];
  const flight: Promise<void> = keepNow()
    .catch((e: unknown): KeepOutcome => {
      console.warn("Riprendi: the document could not be kept", e);
      return "failed";
    })
    .then((outcome) => {
      for (const resolve of asked) resolve(outcome);
    })
    .finally(() => {
      if (inFlight !== flight) return; // dropped by stopAutosave
      inFlight = null;
      if (!again) return;
      const n = againNow;
      again = againNow = false;
      run(n);
    });
  inFlight = flight;
}

// ---------------------------------------------------------------------------------------------
// What

/**
 * What keeping `d` means now: nothing for a document that needed a password (forget what was
 * kept, without asking the engine: it would say null); else what the engine's export gives (null:
 * forget), see the header.
 */
function planFor(d: OpenDoc): Plan {
  return d.info.needsPassword ? "forget" : "export";
}

/**
 * The record's neverDownloaded (platform/resume.ts): whether the document as it was opened, its
 * original without the edits kept, exists nowhere else, as far as this page knows. A document
 * never downloaded since it was made here (or resumed as such: state.ts neverDownloaded) or one
 * made here (`madeHere`, the engine's) and not downloaded as it is: with no edits, the state on
 * screen was not the one downloaded (`dirty`: downloaded with an edit, then undone); with edits,
 * whether its original was ever downloaded as it is cannot be known (only the last download is),
 * so it counts as not (the safe side: Riprendi then counts it not downloaded, also once its edits
 * are undone). A file from the device: false, the user has it.
 */
function recordFlag(madeHere: boolean, editCount: number): boolean {
  return neverDownloaded() || (madeHere && (editCount > 0 || dirty.peek()));
}

function viewNow(): SavedView {
  return { page: Math.max(0, currentPage.peek()), zoom: zoom.peek(), fit: fitMode.peek() };
}

function sameView(a: SavedView, b: SavedView) {
  return a.page === b.page && a.fit === b.fit && Math.abs(a.zoom - b.zoom) < 1e-4;
}

/** Forget what this page kept (only its own: another tab's record stays, see the header). */
function forget() {
  if (kept === "none") return;
  kept = "none";
  void forgetSession("own");
}

/** Keep the open document now (see the header): "kept" when the device keeps it as it is now. */
async function keepNow(): Promise<KeepOutcome> {
  const d = doc.peek();
  if (!d || available === false) return "none";
  if (engineStatus.peek() === "error") return "failed";
  const gen = generation;
  const plan = planFor(d);
  if (plan === "forget") {
    forget();
    return "none";
  }
  const view = viewNow();
  const exported = await engine().exportSession();
  if (gen !== generation) return "none";
  if (!exported) { // nothing to keep (the engine knows best: see the header)
    forget();
    return "none";
  }
  const { original, log, editCount } = exported;
  const record: SavedSession = {
    fileName: d.fileName, savedAt: Date.now(), editCount, pageCount: d.pages.length,
    // Whether its original exists nowhere else: the card says so, and Riprendi opens it counted
    // the same (adoptOpened's `unsaved`).
    neverDownloaded: recordFlag(exported.madeHere === true, editCount),
    original, log, view,
  };
  // From here until it has answered the store may end up with this record or the one before: a
  // forget asked meanwhile (the document closed, another opened) must run, and runs after it.
  const before = kept;
  kept = "unknown";
  const mine = { docId: d.id, view };
  writing = mine;
  let ok: boolean;
  let freed = false;
  try {
    ok = await saveSession(record);
    if (!ok && gen === generation && !(typeof before === "object" && before.docId === d.id)) {
      // A full disk counts what a save writes before what it replaces: when what is kept is
      // another document this page kept, it goes first, and the save is tried once more. Another
      // tab's record or an earlier visit's stays (forget "own" leaves it: see the header), and
      // nothing new is kept; an older state of this document stays too (better than nothing).
      freed = await forgetSession("own");
      if (freed && gen === generation) ok = await saveSession(record);
    }
  } finally {
    if (writing === mine) writing = null;
  }
  if (gen !== generation) return "none"; // what came next forgets it or saves over it, after it in the store
  if (ok) {
    kept = { docId: d.id, view };
    return "kept";
  }
  if (!freed) kept = before; // refused: the store still holds what it held
  if (!warned && (await resumeAvailable())) {
    warned = true;
    showToast("warn", t("resume.cantKeep"));
  }
  return "failed";
}
