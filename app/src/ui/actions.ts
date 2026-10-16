// What the buttons, shortcuts and the line editor do: open, close, edit mode, edit, undo/redo,
// download (one tap, or with options: PDF/A, password), share, update. Engine changes run one at
// a time (a promise chain), so an Undo clicked while an edit is being written applies after it,
// never in between. Download, share, open, close, update and leaving edit mode first write what
// is still typed in the line editor (flushEditor), so it is neither left out of the file nor
// lost without a warning.
import { batch } from "@preact/signals";
import { EngineError } from "../engine/client";
import type { DocInfo, LineInfo, PdfaReport, SaveFormat, SaveOptions, SavePassword } from "../engine/protocol";
import { t } from "../i18n";
import { applyUpdate } from "../platform/pwa";
import {
  busy, confirmDialog, currentPage, dialog, dismissToast, doc, downloadRunning, editingLine, editingStopped, editMode,
  engine, engineStatus, fitMode, flushEditor, hasUnsavedWork, history, markSaved, opening, recordHistory,
  resetHistory, saveKey, sheet, showDialog, showToast, type BusyKind, type DialogState, type SavePurpose,
} from "../state";
import { createPages, type OpenDoc, type PageModel } from "../viewer/model";
import { rescueFocus, viewerScroller } from "./focus";

// ---------------------------------------------------------------------------------------------
// Helpers

let chain: Promise<unknown> = Promise.resolve();

/** Run engine changes one after the other, with `busy` set while each runs. */
function exclusive<T>(kind: BusyKind, fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    busy.value = kind;
    try {
      return await fn();
    } finally {
      busy.value = null;
    }
  });
  chain = run.catch(() => undefined);
  return run;
}

function isAbort(e: unknown) {
  return e instanceof DOMException && e.name === "AbortError";
}

/**
 * Show an engine failure: a crashed worker, a line the engine refuses to rewrite and a document
 * the engine could not restore are reported as such, anything else with `message`.
 */
function reportEngineError(e: unknown, message: string) {
  const code = e instanceof EngineError ? e.code : undefined;
  if (code === "not-editable") {
    showToast("info", t("edit.notEditable"));
    return;
  }
  console.error(e);
  if (code === "crashed" || code === "init") {
    engineStatus.value = "error";
    showToast("error", t("engine.crashed"));
  } else if (code === "broken") {
    // The first time: stop editing and explain. Later (e.g. a download that could not rebuild
    // the last good state either): say that this action failed too.
    if (editingStopped.peek()) showToast("error", message);
    else stopEditing();
  } else {
    showToast("error", message);
  }
}

/**
 * An edit failed and the engine could not put the document back ("broken"): no more edits,
 * undo or redo on it. What it holds can still be downloaded; a reload starts clean.
 */
function stopEditing() {
  if (editingStopped.peek()) return;
  batch(() => {
    editingStopped.value = true;
    editMode.value = false;
    editingLine.value = null;
  });
  showDialog({ kind: "alert", title: t("broken.title"), body: t("broken.body") });
}

export function isPdfFile(file: File) {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}

/**
 * "report.pdf" → "report-edited.pdf" (IT: "report-modificato.pdf"); as PDF/A
 * "report-edited-PDFA.pdf" (a source already called "…-PDFA" does not get it twice).
 */
export function outputName(fileName: string, format: SaveFormat = "pdf") {
  const base = fileName.replace(/\.pdf$/i, "") || "document";
  if (format === "pdf") return `${base}${t("download.suffix")}.pdf`;
  return `${base.replace(/-PDFA$/i, "") || "document"}${t("download.suffix")}-PDFA.pdf`;
}

// ---------------------------------------------------------------------------------------------
// Open

let openSeq = 0;

/**
 * Open `file`. Asks first when there are edits not downloaded (unless `confirmed`), and shows
 * the password dialog or a clear error when the engine cannot open it.
 */
export async function openFile(file: File, opts: { password?: string; confirmed?: boolean } = {}) {
  await flushEditor(); // typed text becomes an edit, so the question below covers it
  if (!opts.confirmed && hasUnsavedWork()) {
    const ok = await confirmDialog({
      title: t("unsaved.title"),
      body: t("unsaved.openBody"),
      confirmLabel: t("unsaved.openConfirm"),
    });
    if (!ok) return;
  }
  const seq = ++openSeq;
  batch(() => {
    editingLine.value = null;
    editingStopped.value = false;
    sheet.value = null;
    doc.value = null;
    opening.value = file.name;
  });
  resetHistory();
  try {
    const bytes = await file.arrayBuffer();
    // Another open started while this file was being read (a second drop, "Open with" on two
    // files): it goes to the engine instead. Sending this one too could reach the worker after
    // it, leaving the engine with a different file than the one on screen.
    if (seq !== openSeq) return;
    const result = await engine().open(bytes, opts.password);
    if (seq !== openSeq) return;
    if (result.ok) {
      const info: DocInfo = {
        pageCount: result.pageCount, pages: result.pages, encrypted: result.encrypted,
        needsPassword: result.needsPassword, canKeepPassword: result.canKeepPassword, pdfa: result.pdfa,
        signatures: result.signatures, title: result.title,
      };
      batch(() => {
        fitMode.value = true;
        currentPage.value = 0;
        doc.value = { id: seq, fileName: file.name, info, pages: createPages(info) };
      });
    } else if (result.reason === "damaged") {
      showDialog({ kind: "alert", title: t("open.damagedTitle"), body: t("open.damaged", { name: file.name }) });
    } else {
      // A password was given and still "required": it was wrong.
      const wrong = result.reason === "wrong-password" || opts.password !== undefined;
      showDialog({ kind: "password", file, wrong });
    }
  } catch (e) {
    if (seq !== openSeq) return;
    console.error(e);
    if (e instanceof EngineError && (e.code === "crashed" || e.code === "init")) {
      engineStatus.value = "error"; // the empty state explains it
    } else {
      showDialog({ kind: "alert", title: t("open.damagedTitle"), body: t("open.failed", { name: file.name }) });
    }
  } finally {
    if (seq === openSeq) opening.value = null;
  }
}

let homeFocus = false;

/**
 * For the home page, once when it mounts: true right after closeDocument(), when the focus should
 * move to it (the Close or Back button that had it is gone). Not on the first load.
 */
export function takeHomeFocus(): boolean {
  const take = homeFocus;
  homeFocus = false;
  return take;
}

/**
 * Close the document and go back to the home screen. Asks first when there are edits not
 * downloaded. An open still being read is abandoned too.
 */
export async function closeDocument() {
  await flushEditor();
  if (hasUnsavedWork()) {
    const ok = await confirmDialog({
      title: t("unsaved.title"),
      body: t("unsaved.closeBody"),
      confirmLabel: t("unsaved.closeConfirm"),
    });
    if (!ok) return;
  }
  const hadDoc = doc.peek() !== null;
  ++openSeq; // an open still in progress lands nowhere
  homeFocus = true; // the control that closed it is about to go: the home page takes the focus
  batch(() => {
    editingLine.value = null;
    editingStopped.value = false;
    editMode.value = false;
    sheet.value = null;
    doc.value = null;
    opening.value = null;
  });
  resetHistory();
  // Free the engine's copy (and its undo checkpoints). Nothing to report if it fails: the next
  // open replaces the document anyway.
  if (hadDoc) engine().close().catch((e: unknown) => console.warn("Closing the document failed", e));
}

// ---------------------------------------------------------------------------------------------
// Edit, undo, redo

/**
 * Turn edit mode on or off. Turning it off first writes what the line editor holds (a tap on a
 * tab does not always take the focus away from the field, so blur cannot be relied on).
 */
export async function setEditMode(on: boolean) {
  const before = document.activeElement;
  if (!on) await flushEditor();
  batch(() => {
    editingLine.value = null;
    editMode.value = on && doc.peek() !== null && !editingStopped.peek();
  });
  // The control that did it may go with the change (Done in the edit banner, Edit text in the
  // details panel, a line box when Esc leaves edit mode): keep the focus on the document.
  if (before && before !== document.body) rescueFocus(viewerScroller);
}

/**
 * Replace a whole line (rule 1: whole lines only). `rev` is the page revision the line was
 * read at: if the page changed since, its line indices are stale and nothing is written.
 */
export function replaceLine(page: PageModel, line: LineInfo, text: string, rev: number): Promise<void> {
  const d = doc.peek();
  return exclusive("edit", async () => {
    if (!d || doc.peek() !== d || editingStopped.peek()) return;
    if (page.rev.peek() !== rev) {
      showToast("error", t("edit.failed"));
      return;
    }
    try {
      const result = await engine().replaceLine(page.index, line.index, text);
      if (doc.peek() !== d) return;
      recordHistory(result, "edit");
      if (result.fallbackChars.length) {
        showToast("warn", t("edit.fallback", { chars: result.fallbackChars.join(" ") }));
      }
      if (result.missingChars.length) {
        showToast("error", t("edit.missing", { chars: result.missingChars.join(" ") }));
      }
    } catch (e) {
      reportEngineError(e, t("edit.failed"));
    }
  });
}

function historyStep(step: "undo" | "redo") {
  const d = doc.peek();
  if (!d) return Promise.resolve();
  return exclusive(step, async () => {
    if (doc.peek() !== d || editingStopped.peek()) return;
    const h = history.peek();
    if (step === "undo" ? !h.canUndo : !h.canRedo) return;
    editingLine.value = null;
    try {
      const state = step === "undo" ? await engine().undo() : await engine().redo();
      if (doc.peek() === d) recordHistory(state, step);
    } catch (e) {
      reportEngineError(e, t("history.failed"));
    }
  });
}

export const undo = () => historyStep("undo");
export const redo = () => historyStep("redo");

// ---------------------------------------------------------------------------------------------
// Download and share
//
// One tap (Download, Ctrl+S, Share) keeps what the file is: a PDF/A stays PDF/A, a PDF that needed
// a password to open stays protected with it. "More download options" picks the format and the
// password for one download (or one share, when a password must be chosen anew for it). Before a
// PDF/A the engine checks what the conversion would do: what makes it impossible is explained (a
// normal PDF is offered instead), what it removes or changes is asked first, and a clean file
// downloads straight away.

/** What one download writes: the format, and the password the file gets as a normal PDF. */
export interface DownloadChoice {
  format: SaveFormat;
  /** Not sent for a PDF/A (which cannot have one), but kept for the normal PDF offered instead. */
  password: SavePassword;
}

/**
 * The one-tap choice for a document. A file that needs a password cannot be a valid PDF/A
 * (PDF/A forbids encryption), whatever its metadata claims: there the password wins, so a
 * protected file never comes out unprotected without being asked.
 */
export function defaultChoice(info: DocInfo): DownloadChoice {
  return {
    format: info.pdfa && !info.needsPassword ? "pdfa-2b" : "pdf",
    password: info.canKeepPassword ? { mode: "keep" } : { mode: "none" },
  };
}

/**
 * A file that needed a password the download cannot be protected with again (one the engine
 * cannot carry or other readers would read differently, or the owner password it was opened
 * with): one tap must not quietly drop the protection, so it opens the download options, where
 * the user picks a new password or none.
 */
const mustChoosePassword = (info: DocInfo) => info.needsPassword && !info.canKeepPassword;

/**
 * The regular PDF offered instead of a PDF/A carries the one-tap password, which is none for
 * such a file: written as it is, it would drop the protection without asking.
 */
const dropsProtection = (d: OpenDoc, choice: DownloadChoice) =>
  choice.format === "pdf" && choice.password.mode === "none" && mustChoosePassword(d.info);

/** What the engine is asked for: a PDF/A never carries a password. */
export function saveOptionsFor(choice: DownloadChoice): SaveOptions {
  return choice.format === "pdfa-2b"
    ? { format: "pdfa-2b", password: { mode: "none" } }
    : { format: "pdf", password: choice.password };
}

/**
 * Removals always need a yes; of the warnings, only text that may move and a signature that
 * stops being valid. A replaced blend mode or colour declaration is not worth a question.
 */
export function pdfaNeedsConfirm(report: PdfaReport): boolean {
  return report.removals.length > 0 ||
    report.warnings.some((w) => w.code === "text-may-shift" || w.code === "signature-invalid");
}

// The File System Access API is not in TypeScript's DOM types yet.
interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: { description?: string; accept: Record<string, string[]> }[];
}
type SaveFilePicker = (options?: SaveFilePickerOptions) => Promise<FileSystemFileHandle>;

type PdfaQuestion = Extract<DialogState, { kind: "pdfa-blocked" | "pdfa-confirm" }>;
/** A question without its answer callback (Omit applied to each kind separately). */
type Unanswered<Q> = Q extends unknown ? Omit<Q, "resolve"> : never;

/**
 * Ask a PDF/A question; resolves false on Cancel, Escape, or another dialog taking its place.
 * The check takes a while, and Close, Open and Update still work meanwhile: when the user has
 * opened one of their questions (or any other dialog), that one stays, and this download stops
 * with a word instead of answering it "no" behind their back.
 */
function ask(question: Unanswered<PdfaQuestion>): Promise<boolean> {
  if (dialog.peek()) {
    showToast("info", question.purpose === "share" ? t("share.cancelled") : t("download.cancelled"));
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    showDialog({ ...question, resolve } as PdfaQuestion);
  });
}

/** Run the engine's PDF/A check, with a status toast while it works. Null when it failed. */
async function checkPdfa(d: OpenDoc): Promise<PdfaReport | null> {
  const status = showToast("info", t("pdfa.checking"), 0);
  try {
    return await exclusive("check", async () => {
      if (doc.peek() !== d) return null;
      try {
        return await engine().pdfaCheck();
      } catch (e) {
        reportEngineError(e, t("pdfa.checkFailed"));
        return null;
      }
    });
  } finally {
    dismissToast(status);
  }
}

/**
 * What a download ends with: nothing more to do, or "choose-password" when the regular PDF taken
 * instead of a PDF/A would drop the file's password (dropsProtection): the options open then.
 */
type Delivered = "choose-password" | void;

/**
 * For a PDF/A: check first, then explain or ask. Returns what to write (the normal PDF when the
 * user took it instead), "choose-password" (see Delivered), or null to stop. Any other choice
 * goes through unchanged.
 */
async function settleChoice(
  d: OpenDoc, choice: DownloadChoice, purpose: SavePurpose,
): Promise<DownloadChoice | "choose-password" | null> {
  if (choice.format !== "pdfa-2b") return choice;
  await flushEditor(); // the check must see the text still in the line editor
  const report = await checkPdfa(d);
  if (!report || doc.peek() !== d) return null;
  let ok = true;
  if (report.blockers.length) {
    ok = await ask({ kind: "pdfa-blocked", blockers: report.blockers, purpose });
    choice = { format: "pdf", password: choice.password };
  } else if (pdfaNeedsConfirm(report)) {
    ok = await ask({ kind: "pdfa-confirm", removals: report.removals, warnings: report.warnings, purpose });
  }
  if (!ok || doc.peek() !== d) return null;
  return dropsProtection(d, choice) ? "choose-password" : choice;
}

/**
 * Build the file in the engine. "blocked": the engine refused the PDF/A when writing it (its own
 * final check); null: it failed, and the user was told.
 */
async function buildPdf(choice: DownloadChoice): Promise<ArrayBuffer | "blocked" | null> {
  try {
    return (await engine().save(saveOptionsFor(choice))).bytes;
  } catch (e) {
    if (e instanceof EngineError && e.code === "pdfa-blocked") return "blocked";
    reportEngineError(e, t("download.failed"));
    return null;
  }
}

/** Plain browser download through a temporary blob URL. */
function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.append(a);
  a.click();
  a.remove();
  // Revoked later, not right away: some browsers start reading the blob after click() returns.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function doneMessage(choice: DownloadChoice, name: string): string {
  if (choice.format === "pdfa-2b") return t("download.donePdfa", { name });
  if (choice.password.mode !== "none") return t("download.doneProtected", { name });
  return t("download.done", { name });
}

/**
 * Download the edited PDF as "<name>-edited.pdf" ("…-PDFA.pdf" for a PDF/A), with `choice` from
 * the download options, or else the one-tap choice. With the File System Access API the user
 * picks where, asked while the click still counts as a user gesture (the click that started it,
 * or the one that answered a PDF/A question); otherwise, or when the gesture has expired
 * meanwhile, it is a normal download. Afterwards the edits count as saved.
 *
 * One download at a time: a second click or Ctrl+S while the save dialog is open is ignored
 * (Chrome would refuse a second dialog, and that must not turn into an extra plain download).
 */
export function download(choice?: DownloadChoice) {
  return start("download", choice);
}

/**
 * Share the edited PDF through the system share sheet (touch devices), with `choice` from the
 * options, or else the one-tap choice. A building that outlasts the tap's user gesture asks for
 * one more tap (shareFile).
 */
export function share(choice?: DownloadChoice) {
  return start("share", choice);
}

/** Download or share, one at a time (downloadRunning), its PDF/A questions included. */
async function start(purpose: SavePurpose, choice: DownloadChoice | undefined) {
  const d = doc.peek();
  if (!d) return;
  if (downloadRunning.peek()) {
    // A one-tap repeat is simply ignored; a choice made in the options must not vanish silently.
    if (choice) showToast("info", t("download.busy"));
    return;
  }
  if (!choice && mustChoosePassword(d.info)) {
    openDownloadOptions(purpose);
    return;
  }
  downloadRunning.value = true;
  let next: Delivered;
  try {
    next = await deliver(d, choice ?? defaultChoice(d.info), purpose);
  } finally {
    downloadRunning.value = false;
  }
  // The options open once this download is over (they refuse to open while one runs).
  if (next === "choose-password" && doc.peek() === d) openDownloadOptions(purpose);
}

/** Settle the choice and write the file; when the engine still refuses the PDF/A, offer a normal PDF. */
async function deliver(d: OpenDoc, choice: DownloadChoice, purpose: SavePurpose): Promise<Delivered> {
  const settled = await settleChoice(d, choice, purpose);
  if (settled === null) return;
  if (settled === "choose-password") return settled;
  const outcome = purpose === "download" ? await writeDownload(d, settled) : await writeShare(d, settled);
  if (outcome !== "blocked") return;
  const fallback = await ask({ kind: "pdfa-blocked", blockers: [], purpose });
  if (!fallback || doc.peek() !== d) return;
  const regular: DownloadChoice = { format: "pdf", password: settled.password };
  return dropsProtection(d, regular) ? "choose-password" : deliver(d, regular, purpose);
}

async function writeDownload(d: OpenDoc, choice: DownloadChoice): Promise<"blocked" | void> {
  const name = outputName(d.fileName, choice.format);
  const picker = (window as unknown as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
  let handle: FileSystemFileHandle | null = null;
  if (picker) {
    try {
      handle = await picker({
        suggestedName: name,
        types: [{ description: "PDF", accept: { "application/pdf": [".pdf"] } }],
      });
    } catch (e) {
      if (isAbort(e)) return; // the user closed the dialog
      // The picker cannot be used here (sandboxed frame, the gesture expired, options refused):
      // fall back to a normal download. Anything else (e.g. NotAllowedError) is a refusal.
      const unusable = e instanceof TypeError || (e instanceof DOMException && e.name === "SecurityError");
      if (!unusable) {
        console.error(e);
        showToast("error", t("download.failed"));
        return;
      }
    }
  }
  await flushEditor();
  return exclusive("save", async () => {
    if (doc.peek() !== d) return;
    const key = saveKey();
    const bytes = await buildPdf(choice);
    if (bytes === "blocked") return "blocked";
    if (!bytes) return;
    try {
      if (handle) {
        const writable = await handle.createWritable();
        await writable.write(bytes);
        await writable.close();
      } else {
        downloadBlob(new Blob([bytes], { type: "application/pdf" }), name);
      }
      markSaved(key); // ignored if another file was opened while writing
      showToast("info", doneMessage(choice, handle?.name ?? name));
    } catch (e) {
      console.error(e);
      showToast("error", t("download.failed"));
    }
  });
}

async function writeShare(d: OpenDoc, choice: DownloadChoice): Promise<"blocked" | void> {
  await flushEditor();
  return exclusive("save", async () => {
    if (doc.peek() !== d) return;
    const key = saveKey();
    const bytes = await buildPdf(choice);
    if (bytes === "blocked") return "blocked";
    if (!bytes) return;
    const file = new File([bytes], outputName(d.fileName, choice.format), { type: "application/pdf" });
    await shareFile(file, key, true);
  });
}

/**
 * "More download options": format and password for one download, or one share when a file whose
 * password must be chosen anew is shared (a dialog; a sheet on phones). Not while a download
 * runs: the choice made there would be refused, or a PDF/A question would take its place. The
 * top bar's chevron is off then; the phone's "Download with options…" row gets a word instead.
 */
export function openDownloadOptions(purpose: SavePurpose = "download") {
  if (!doc.peek() || dialog.peek()) return;
  if (downloadRunning.peek()) {
    showToast("info", t("download.busy"));
    return;
  }
  showDialog({ kind: "download-options", purpose });
}

/**
 * Open the share sheet for `file`. If building the PDF took long enough for the tap to stop
 * counting as a user gesture, the browser refuses: then (when `askAgain`) a small dialog asks
 * for one more tap.
 */
export async function shareFile(file: File, key: string, askAgain: boolean) {
  try {
    await navigator.share({ files: [file], title: file.name });
    markSaved(key);
  } catch (e) {
    if (isAbort(e)) return;
    if (askAgain && e instanceof DOMException && e.name === "NotAllowedError") {
      showDialog({ kind: "share", file, saveKey: key });
      return;
    }
    console.error(e);
    showToast("error", t("share.failed"));
  }
}

// ---------------------------------------------------------------------------------------------
// App update and leaving the page

let leaving = false;

/** True while the page should warn before closing (edits not downloaded, or still being typed). */
export function shouldWarnBeforeUnload() {
  return hasUnsavedWork() && !leaving;
}

/** Install the waiting version (asks first when there are edits not downloaded). */
export async function updateApp() {
  await flushEditor();
  if (hasUnsavedWork()) {
    const ok = await confirmDialog({
      title: t("unsaved.title"),
      body: t("unsaved.updateBody"),
      confirmLabel: t("unsaved.updateConfirm"),
    });
    if (!ok) return;
  }
  leaving = true; // already confirmed: no second warning from beforeunload
  applyUpdate();
  // Normally the page is gone long before this. If no reload came after all, edits made from
  // now on must be protected again.
  setTimeout(() => { leaving = false; }, 10_000);
}
