// "Riprendi da dove eri" on the home page (styles/resume.css): what this device kept of the last
// document (its edits, platform/resume.ts; kept by autosave.ts) and of an unfinished scan, each
// with Riprendi and Dimentica, and a short note that it stays on this device only (with how it
// works, and that PDFs that need a password are never kept). Nothing shows when nothing is kept,
// or where the storage cannot be used. The card reads only signals (the tests call it); what it
// shows is read again whenever the home page shows, and while it shows whenever what is kept
// changes, here or in another tab (refreshResume, from autosave.ts).
//
// Riprendi a document: the engine opens the kept file again and applies its edits one by one
// (resumeSession), the document opens as after any open (actions.ts, adoptOpened, sequenced with
// the other opens: one asked for meanwhile wins) with those edits in its history (undo takes them
// back; they count as not downloaded), and the view comes back: the page, the zoom, fit-width.
// When an edit no longer applies (the app changed since), the ones before it are kept and a toast
// says so. A document made here (from photos or scans) whose original was not downloaded as it is
// counts as not downloaded, also once its edits are undone, as it did when it was kept; a file from
// the device does not (the user has it): the record says which (neverDownloaded). A record with no
// edit log (the file itself: an earlier build of this release kept a document made here that way)
// opens as it is, counted the same; from then on the autosave keeps it as the engine says (a
// document opened from bytes is not one made here: kept once it has an edit). What no longer opens
// is forgotten (that very record); what cannot be read just now (a slow or failing read) is said,
// with Dimentica in the toast, and stays offered.
// Riprendi a scan: the scan flow opens again with its tray (ui/scan, resumeScan); after a document,
// a scan that was adding pages to that very document (by name: SavedScan.doc) is offered in a toast
// (the home page is gone by then), and never one meant for another document, whose pages would
// land in this one. The card names the document a scan's pages are for.
//
// Dimentica hides the entry at once and says so in a toast with "Annulla"; it is forgotten for good
// when that toast goes (or the page is hidden or left: settlePendingForgets), unless Annulla was
// pressed: exactly the record it was pressed for (its stamp), whatever is open by then and whoever
// wrote it (another tab too), unless a newer save has replaced it (that one is left alone: a
// document opened and edited meanwhile, a tray kept by the scan flow, another tab's save). A scan
// flow opened meanwhile carries out the scan's at once: its toast is under the flow's modal, and
// the flow must not offer back, as one kept from before, the scan the user has just forgotten.
import { batch, effect, signal } from "@preact/signals";
import type { JSX } from "preact";
import { EngineError } from "../../engine/client";
import type { HistoryState, OpenResult } from "../../engine/protocol";
import { locale, pageCount, t } from "../../i18n";
import {
  forgetScan, forgetSession, loadScan, loadSession, scanSummary, sessionSummary,
  type SavedView, type ScanSummary, type SessionSummary,
} from "../../platform/resume";
import {
  dismissToast, doc, engine, engineStatus, fitMode, opening, scanFlow, showDialog, showToast, toasts, zoom,
} from "../../state";
import { clampZoom } from "../../viewer/layout";
import { goToPage } from "../../viewer/zoom";
import { adoptOpened, beginOpen } from "../actions";
import { dateLocale, dateText } from "../fill/dates";
import { rescueFocus } from "../focus";
import { IconImage, IconPages } from "../icons";
import { resumeScan } from "../scan/ScanFlow";

/** The two things kept: the document (session) and the unfinished scan. */
export type KeptKind = "session" | "scan";

/** What this device keeps, as the home page last read it. */
export interface KeptState {
  session: SessionSummary | null;
  scan: ScanSummary | null;
}

/** What is kept (null until read: nothing shows). */
export const resumeState = signal<KeptState | null>(null);
/** A Riprendi under way: its buttons wait. */
export const resuming = signal<KeptKind | null>(null);
/** Entries forgotten with Dimentica whose toast still offers Annulla: not shown. */
export const forgetting = signal<ReadonlySet<KeptKind>>(new Set());

let reads = 0;

/** Read what is kept again (the summaries only, never the bytes). Never throws. */
export async function refreshResume(): Promise<void> {
  const seq = ++reads;
  let next: KeptState = { session: null, scan: null };
  try {
    const [session, scan] = await Promise.all([sessionSummary(), scanSummary()]);
    next = { session, scan };
  } catch (e) {
    console.warn("Riprendi: what is kept could not be read", e);
  }
  if (seq === reads) resumeState.value = next;
}

// ---------------------------------------------------------------------------------------------
// Words

function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/**
 * When something was kept, for people: "poco fa", "5 min fa", "oggi alle 14:05", "ieri alle
 * 18:30", else the date ("16/10/2026"), in local time.
 */
export function whenText(savedAt: number, now = Date.now()): string {
  const ago = now - savedAt;
  if (ago < 60_000) return t("resume.justNow"); // also a time ahead of now (the clock was changed)
  if (ago < 3_600_000) return t("resume.minutesAgo", { count: Math.floor(ago / 60_000) });
  const then = new Date(savedAt);
  const today = new Date(now);
  const languages = typeof navigator !== "undefined" ? navigator.languages ?? [] : [];
  const time = new Intl.DateTimeFormat(dateLocale(locale.value, languages), { hour: "2-digit", minute: "2-digit" })
    .format(then);
  if (sameDay(then, today)) return t("resume.today", { time });
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (sameDay(then, yesterday)) return t("resume.yesterday", { time });
  return dateText(then, locale.value, languages);
}

/**
 * "3 modifiche · oggi alle 14:05"; a document kept with no edits (one made here, the only kind the
 * engine keeps so) that was not downloaded as it is: "2 pagine, non ancora scaricato · …"; one
 * downloaded as it is (the record's neverDownloaded false): "2 pagine · …".
 */
export function sessionMeta(s: SessionSummary, now = Date.now()): string {
  const pages = pageCount(s.pageCount);
  const what = s.editCount > 0
    ? s.editCount === 1 ? t("resume.editsOne") : t("resume.edits", { count: s.editCount })
    : s.neverDownloaded ? t("resume.newDocument", { pages }) : pages;
  return t("resume.meta", { what, when: whenText(s.savedAt, now) });
}

/** What a resume that stopped at an edit says: `applied` edits were applied again. */
export function partialText(applied: number): string {
  if (applied <= 0) return t("resume.partialNone");
  return applied === 1 ? t("resume.partialOne") : t("resume.partial", { count: applied });
}

// ---------------------------------------------------------------------------------------------
// Riprendi

/**
 * The document kept is not opened again (said while its open is still the current one): the
 * alert, and what no longer opens is forgotten (`gone`: the record loaded, by its stamp; a newer
 * save since stays).
 */
function cannotResume(name: string, gone: string | null) {
  opening.value = null;
  showDialog({
    kind: "alert",
    title: t("resume.failedTitle", { name }),
    body: gone !== null ? t("resume.damaged") : t("resume.failed", { name }),
  });
  if (gone !== null) void forgetSession({ stamp: gone });
  void refreshResume(); // after the forget: the store runs them in order
}

/**
 * The view as it was: the zoom (unless it fitted the width, as a document opens), and the page,
 * shown once the viewer has mounted and laid the pages out at its width (a frame later).
 */
function restoreView(view: SavedView | null, pages: number) {
  if (!view) return;
  if (!view.fit) {
    batch(() => {
      fitMode.value = false;
      zoom.value = clampZoom(view.zoom);
    });
  }
  const page = Math.min(view.page, pages - 1);
  if (page <= 0) return;
  const d = doc.peek();
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (doc.peek() === d) goToPage(page);
  }));
}

/**
 * Resumed the document `fileName` while a scan meant for it (its pages to add) is kept too: the
 * home page, where the scan is offered, is gone, so a toast offers it. Not a scan meant for
 * another document (or whose document is not known): its pages are not this one's.
 */
function offerScan(fileName: string) {
  const scan = resumeState.peek()?.scan;
  if (!scan || scan.target.kind !== "insert" || scan.doc?.fileName !== fileName || forgetting.peek().has("scan")) return;
  showToast("info", t("resume.scanToo", { pages: pageCount(scan.pages) }), undefined, {
    label: t("resume.resumeScan"),
    run: () => void resumeScanAction(),
  });
}

/**
 * Riprendi found nothing to load (loadSession or loadScan gave null): gone since the card was read
 * (forgotten or replaced, perhaps in another tab), or still there but not readable just now (a
 * read too slow for a big file on a slow phone, a storage error, damaged records). The summary,
 * read again, tells them apart: the same record (its stamp) still there, Riprendi failed, and the
 * toast offers Dimentica (the card keeps offering both: a retry may work); else it is no longer
 * kept. The card is read again either way.
 */
async function notLoaded(kind: KeptKind, shown: SessionSummary | ScanSummary | null) {
  let now: SessionSummary | ScanSummary | null = null;
  try {
    now = kind === "session" ? await sessionSummary() : await scanSummary();
  } catch (e) {
    console.warn("Riprendi: what is kept could not be read", e);
  }
  const same = shown !== null && now !== null && now.stamp === shown.stamp;
  await refreshResume();
  if (!same) {
    showToast("error", t(kind === "session" ? "resume.gone" : "resume.scanGone"));
    return;
  }
  const text = shown && "fileName" in shown ? t("resume.unreadable", { name: shown.fileName }) : t("resume.scanUnreadable");
  showToast("error", text, undefined, { label: t("resume.forget"), run: () => forgetKept(kind) });
}

/**
 * Riprendi the document kept: opened again with its edits, in place of the home page (the
 * "opening…" card shows meanwhile). Nothing when another document is open or opening. Whatever is
 * opened or closed meanwhile (a file dropped, a new PDF) takes over: this resume then lands
 * nowhere, on screen as in the engine (beginOpen).
 */
export async function resumeDocument(): Promise<void> {
  const summary = resumeState.peek()?.session;
  if (!summary || forgetting.peek().has("session") || resuming.peek()) return;
  if (doc.peek() !== null || opening.peek() !== null || engineStatus.peek() === "error") return;
  const name = summary.fileName;
  resuming.value = "session";
  const ticket = beginOpen(name);
  const mine = () => ticket.current() && doc.peek() === null;
  /** The record loaded (its stamp): what is forgotten when it no longer opens. */
  let loaded = summary.stamp;
  try {
    const saved = await loadSession();
    if (!mine()) return;
    if (!saved) {
      opening.value = null;
      await notLoaded("session", summary);
      return;
    }
    if (saved.stamp) loaded = saved.stamp;
    // Kept as the file itself (no log: an earlier build, see the header): opened as it is.
    const fileOnly = saved.log === null;
    let opened: Extract<OpenResult, { ok: true }>;
    let history: HistoryState | undefined;
    let partial: number | null = null;
    if (fileOnly) {
      const result = await engine().open(saved.original);
      if (!mine()) return;
      if (!result.ok) return cannotResume(name, loaded);
      opened = result;
    } else {
      const result = await engine().resumeSession(saved.original, saved.log);
      if (!mine()) return;
      if (!result.ok) return cannotResume(name, loaded);
      opened = result;
      history = result.history;
      if (result.failedAt !== null) partial = result.applied;
    }
    // Synchronously after the open, before the viewer mounts with it: the history and the zoom.
    // Counted as not downloaded as it was when kept: for good when its original exists nowhere else.
    const adopted = adoptOpened(opened, saved.fileName, history, { ticket, unsaved: saved.neverDownloaded !== false });
    restoreView(saved.view, opened.pageCount);
    if (!(await adopted)) return;
    if (partial !== null) showToast("warn", partialText(partial));
    offerScan(saved.fileName);
  } catch (e) {
    if (!mine()) return;
    console.error(e);
    if (e instanceof EngineError && (e.code === "crashed" || e.code === "init")) {
      opening.value = null;
      engineStatus.value = "error"; // the home page explains it; what is kept stays
      return;
    }
    // A log the engine refuses as malformed will never apply: forgotten too.
    cannotResume(name, e instanceof EngineError && e.code === "bad-request" ? loaded : null);
  } finally {
    resuming.value = null;
  }
}

/** Riprendi the unfinished scan: its flow opens again with the tray as it was. */
export async function resumeScanAction(): Promise<void> {
  if (resuming.peek() || scanFlow.peek() !== null || forgetting.peek().has("scan")) return;
  const shown = resumeState.peek()?.scan ?? null;
  resuming.value = "scan";
  try {
    const saved = await loadScan();
    if (scanFlow.peek() !== null) return; // another scan started meanwhile
    if (!saved) {
      await notLoaded("scan", shown);
      return;
    }
    resumeScan(saved);
  } catch (e) {
    console.error(e);
    showToast("error", t("resume.scanFailed"));
  } finally {
    resuming.value = null;
  }
}

// ---------------------------------------------------------------------------------------------
// Dimentica

/** A Dimentica waiting for its toast to go: the record it was pressed for (its stamp), its toast, and the watches on them. */
const pendingForgets = new Map<KeptKind, { stamp: string; toast: number; stop: () => void }>();

function setForgetting(kind: KeptKind, on: boolean) {
  const next = new Set(forgetting.peek());
  if (on) next.add(kind);
  else next.delete(kind);
  forgetting.value = next;
}

/**
 * The Dimentica of `kind` ends: forgotten for good (`forget`: the very record it was pressed for,
 * unless a newer save has replaced it, whatever is open now), or taken back (Annulla).
 */
function endForget(kind: KeptKind, forget: boolean) {
  const pending = pendingForgets.get(kind);
  if (!pending) return;
  pendingForgets.delete(kind);
  pending.stop();
  const which = { stamp: pending.stamp };
  if (forget) void (kind === "session" ? forgetSession(which) : forgetScan(which));
  // Read again after the forget (the store runs them in order), then shown as it is.
  void refreshResume().then(() => setForgetting(kind, false));
}

/**
 * Dimentica: the entry goes at once, and a toast says so with "Annulla"; forgotten for good when
 * the toast goes, unless Annulla was pressed (the scan's at once when a scan flow opens: see the
 * header). The focus goes to what is left of the card, or the home page's heading, never <body>.
 */
export function forgetKept(kind: KeptKind): void {
  const state = resumeState.peek();
  const entry = kind === "session" ? state?.session : state?.scan;
  if (!entry || pendingForgets.has(kind) || resuming.peek() === kind) return;
  setForgetting(kind, true);
  let undone = false;
  const text = kind === "session" && state?.session
    ? t("resume.forgotten", { name: state.session.fileName })
    : t("resume.scanForgotten");
  const toast = showToast("info", text, undefined, { label: t("resume.undo"), run: () => { undone = true; } });
  let pending: { stamp: string; toast: number; stop: () => void } | null = null;
  const stop = effect(() => {
    const shown = toasts.value.some((x) => x.id === toast);
    const flowOpen = kind === "scan" && scanFlow.value !== null;
    if (shown && !flowOpen) return;
    // Gone: its time ran out, it was closed, or Annulla was pressed (the toast is dismissed first,
    // then the action runs): decided once that has run. A scan flow opened: carried out now.
    queueMicrotask(() => {
      if (!pending || pendingForgets.get(kind) !== pending) return; // ended already
      endForget(kind, !undone);
      if (flowOpen) dismissToast(toast);
    });
  });
  pending = { stamp: entry.stamp, toast, stop };
  pendingForgets.set(kind, pending);
  rescueFocus(() => document.querySelector<HTMLElement>(".resume .btn-primary") ?? document.getElementById("home-title"));
}

/** The page is hidden or left: every Dimentica still offering Annulla is carried out now. */
export function settlePendingForgets(): void {
  for (const [kind, pending] of [...pendingForgets]) {
    endForget(kind, true);
    dismissToast(pending.toast);
  }
}

// ---------------------------------------------------------------------------------------------
// The card

/** One thing kept, as the card lists it. */
interface EntryProps {
  kind: KeptKind;
  icon: JSX.Element;
  title: string;
  meta: string;
  /** The buttons' names, with what they act on ("Riprendi “nome.pdf”"). */
  resumeLabel: string;
  forgetLabel: string;
  onResume: () => void;
}

/**
 * One thing kept: what it is, when, and its two buttons. A plain function, not a component, so the
 * card is one tree (the tests read it). While a Riprendi runs, the buttons wait (aria-disabled,
 * still focusable); with the engine down, Riprendi is off.
 */
function entry(p: EntryProps): JSX.Element {
  const waiting = resuming.value !== null;
  return (
    <li class="resume-item" data-kind={p.kind}>
      <span class="resume-icon">{p.icon}</span>
      <div class="resume-text">
        <p class="resume-title">{p.title}</p>
        <p class="resume-meta">{p.meta}</p>
      </div>
      <div class="resume-actions">
        <button
          type="button"
          class="btn btn-primary resume-go"
          aria-label={p.resumeLabel}
          disabled={engineStatus.value === "error"}
          aria-disabled={waiting || undefined}
          onClick={() => { if (resuming.peek() === null) p.onResume(); }}
        >
          {t("resume.resume")}
        </button>
        <button
          type="button"
          class="btn btn-secondary resume-forget"
          aria-label={p.forgetLabel}
          aria-disabled={waiting || undefined}
          onClick={() => { if (resuming.peek() === null) forgetKept(p.kind); }}
        >
          {t("resume.forget")}
        </button>
      </div>
    </li>
  );
}

/**
 * The home page's card: the document kept ("Riprendi “nome.pdf”", "N modifiche · quando") and/or
 * the unfinished scan ("Scansione non finita (N pagine)", "Per “nome.pdf” · quando" when its pages
 * are for a document), each with Riprendi and Dimentica, and the note. Null when nothing is kept
 * (or not read yet, or the storage cannot be used). Reads only signals (no hooks).
 */
export function ResumeCard(): JSX.Element | null {
  const state = resumeState.value;
  const hidden = forgetting.value;
  const session = state?.session && !hidden.has("session") ? state.session : null;
  const scan = state?.scan && !hidden.has("scan") ? state.scan : null;
  if (!session && !scan) return null;
  return (
    <section class="resume" aria-label={t("resume.label")}>
      <ul class="resume-list" role="list">
        {session && entry({
          kind: "session",
          icon: <IconPages />,
          title: t("resume.document", { name: session.fileName }),
          meta: sessionMeta(session),
          resumeLabel: t("resume.resumeLabel", { name: session.fileName }),
          forgetLabel: t("resume.forgetLabel", { name: session.fileName }),
          onResume: () => void resumeDocument(),
        })}
        {scan && entry({
          kind: "scan",
          icon: <IconImage />,
          title: t("resume.scan", { pages: pageCount(scan.pages) }),
          meta: scan.doc
            ? t("resume.scanFor", { name: scan.doc.fileName, when: whenText(scan.savedAt) })
            : whenText(scan.savedAt),
          resumeLabel: t("resume.resumeScanLabel"),
          forgetLabel: t("resume.forgetScanLabel"),
          onResume: () => void resumeScanAction(),
        })}
      </ul>
      <details class="resume-about">
        <summary>{t("resume.note")}</summary>
        <p>{t("resume.about")}</p>
      </details>
    </section>
  );
}
