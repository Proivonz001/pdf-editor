// App-wide state, all in @preact/signals: the engine, the open document, the edit history
// (and whether it has been downloaded), the viewer settings (edit mode, the line being edited,
// the selected image and the image edits still on their way), toasts and dialogs (the download
// options and the PDF/A questions among them).
// The actions that change it live in src/ui/actions.ts.
import { batch, computed, signal } from "@preact/signals";
import { EngineClient, EngineError } from "./engine/client";
import type {
  HistoryState, LineInfo, PdfaBlockerCode, PdfaIssue, PdfaRemovalCode, PdfaWarningCode,
} from "./engine/protocol";
import type { OpenDoc } from "./viewer/model";

// ---------------------------------------------------------------------------------------------
// Engine

export type EngineStatus = "loading" | "ready" | "error";
/** "loading" until MuPDF has loaded in the worker (about 10 MB the first time, then cached). */
export const engineStatus = signal<EngineStatus>("loading");

let client: EngineClient | null = null;

/** Start the worker early, so MuPDF loads while the user is still choosing a file. */
export function startEngine() {
  if (client) return;
  try {
    client = new EngineClient();
  } catch (e) {
    console.error("PDF engine: worker could not start", e);
    engineStatus.value = "error";
    return;
  }
  client.ready.then(
    () => { engineStatus.value = "ready"; },
    (e: unknown) => {
      console.error("PDF engine: init failed", e);
      engineStatus.value = "error";
    },
  );
}

export function engine(): EngineClient {
  startEngine();
  if (!client) throw new EngineError("The PDF engine could not start", "init");
  return client;
}

// ---------------------------------------------------------------------------------------------
// Document

export const doc = signal<OpenDoc | null>(null);
/** Name of the file being opened (shown while the engine parses it). */
export const opening = signal<string | null>(null);

export type BusyKind = "edit" | "undo" | "redo" | "save" | "check";
/** A change, a save or a PDF/A check is running in the engine. */
export const busy = signal<BusyKind | null>(null);
/**
 * A download or share is under way, from the click to the file written: the PDF/A check and its
 * questions, the save dialog, and the wait behind an edit still being written. One at a time.
 */
export const downloadRunning = signal(false);

// ---------------------------------------------------------------------------------------------
// History and "edits not downloaded"
//
// The worker owns the history; the UI mirrors it as a stack of edit ids, so it can tell exactly
// whether the current state is the one last downloaded (undoing back to it counts as clean,
// a different edit with the same count does not).

export const EMPTY_HISTORY: HistoryState = { editCount: 0, canUndo: false, canRedo: false, changedPages: [] };
export const history = signal<HistoryState>(EMPTY_HISTORY);

const applied = signal<readonly number[]>([]);
let redoStack: number[] = [];
let nextEditId = 1;
const savedKey = signal("");
/** The pages each edit changed, by edit id (for editedPages). */
const editPages = new Map<number, readonly number[]>();

/** There are edits that have not been downloaded (or shared) yet. */
export const dirty = computed(() => applied.value.join(",") !== savedKey.value);

/** Indices of the pages that hold at least one applied edit (marked in the thumbnails). */
export const editedPages = computed(() => {
  const pages = new Set<number>();
  for (const id of applied.value) for (const p of editPages.get(id) ?? []) pages.add(p);
  return pages as ReadonlySet<number>;
});

export function resetHistory() {
  batch(() => {
    history.value = EMPTY_HISTORY;
    applied.value = [];
    savedKey.value = "";
  });
  redoStack = [];
  editPages.clear();
}

/**
 * Record a history step returned by the engine and refresh the pages it changed. An edit that
 * changed no page (e.g. only spaces around the text) is not one: the engine did not log it.
 */
export function recordHistory(state: HistoryState, step: "edit" | "undo" | "redo") {
  if (step === "edit" && state.changedPages.length === 0) {
    history.value = state;
    return;
  }
  batch(() => {
    const ids = [...applied.value];
    if (step === "edit") {
      const id = nextEditId++;
      ids.push(id);
      editPages.set(id, state.changedPages);
      for (const dropped of redoStack) editPages.delete(dropped);
      redoStack = [];
    } else if (step === "undo") {
      const id = ids.pop();
      if (id !== undefined) redoStack.push(id);
    } else {
      const id = redoStack.pop();
      if (id !== undefined) ids.push(id);
    }
    applied.value = ids;
    history.value = state;
    invalidatePages(state.changedPages);
  });
}

/**
 * Identifies the open document and the current state of its edits; pass it to markSaved() once
 * the bytes are out.
 */
export function saveKey(): string {
  return `${doc.peek()?.id ?? 0}:${applied.peek().join(",")}`;
}

/** The bytes of `key` are out. Ignored when another document was opened meanwhile. */
export function markSaved(key: string) {
  const sep = key.indexOf(":");
  if (key.slice(0, sep) !== String(doc.peek()?.id ?? 0)) return;
  savedKey.value = key.slice(sep + 1);
}

/** Drop the cached lines and images of these pages and re-render them. */
export function invalidatePages(indices: readonly number[]) {
  const d = doc.peek();
  if (!d) return;
  batch(() => {
    for (const i of indices) {
      const page = d.pages[i];
      if (!page) continue;
      page.lines.value = null;
      page.images.value = null;
      page.rev.value++;
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Viewer

/** CSS pixels per PDF point. */
export const zoom = signal(1);
/** Zoom follows the width of the window (the default, on open and on resize). */
export const fitMode = signal(true);
/**
 * Index of the current page: the page at the centre of the viewport, or the page picked from the
 * thumbnails while the viewer scrolls to it and stays there (see Viewer, `picked`).
 */
export const currentPage = signal(0);

/**
 * Device pixels per CSS pixel. It changes with the browser's page zoom and when the window moves
 * to a screen with another density (which fires no resize event): watched from the start, with
 * or without a document open, so pages and thumbnails always render sharp.
 */
export const devicePixelRatio = signal(typeof window === "undefined" ? 1 : window.devicePixelRatio || 1);
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  const update = () => { devicePixelRatio.value = window.devicePixelRatio || 1; };
  window.addEventListener("resize", update); // browsers without dppx resolution queries
  // Matches only the current ratio, so "change" fires when it changes; then watch the new one.
  const watch = () => {
    window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
      .addEventListener("change", () => { update(); watch(); }, { once: true });
  };
  watch();
}

export const editMode = signal(false);
export interface EditingLine {
  pageIndex: number;
  line: LineInfo;
}
/** The line whose inline editor is open. */
export const editingLine = signal<EditingLine | null>(null);

export interface SelectedImage {
  pageIndex: number;
  /** ImageInfo.index in the page's current image list. */
  index: number;
}
/**
 * The image selected in edit mode (moved, resized, rotated... with its frame and context bar).
 * One at a time, and never together with an open line editor: selecting one closes the other.
 * After an edit of the image it follows the image's new index; undo and redo clear it.
 */
export const selectedImage = signal<SelectedImage | null>(null);
/**
 * Image edits (moves, resizes, rotations, deletions, replacements) of the open document asked
 * for and not finished yet: waiting in the engine's queue (behind a download, say), being
 * prepared or being written. While there are any, image indices may be about to change: the
 * selected image's frame shows as pending, and no other image is selected nor line opened.
 * Edits of a document closed since do not count (resetImageEdits).
 */
export const imageEditsPending = signal(0);

/** Bumped by resetImageEdits: an edit counted before it no longer changes the count. */
let imageEditsGeneration = 0;

/**
 * Another document is opened, or this one closed: from now on only that one's image edits
 * count. Those of the one before still end on their own (written nowhere), uncounted.
 */
export function resetImageEdits() {
  imageEditsGeneration++;
  imageEditsPending.value = 0;
}

/**
 * Count one image edit of the open document in imageEditsPending; returns the function that ends
 * it (once; nothing then when another document was opened, or this one closed, meanwhile).
 */
export function countImageEdit(): () => void {
  const generation = imageEditsGeneration;
  imageEditsPending.value++;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    if (generation === imageEditsGeneration) imageEditsPending.value--;
  };
}

export type SheetKind = "pages" | "more";
/** The bottom sheet open on phones (page thumbnails, or the "More" actions). */
export const sheet = signal<SheetKind | null>(null);
/**
 * The engine could not restore the document after a failed edit ("broken"): editing, undo and
 * redo stay off until another file is opened. Downloading still works.
 */
export const editingStopped = signal(false);
/**
 * The id of the open document whose "digitally signed" notice was dismissed: it stays away for
 * that document only (in memory), and comes back for the next file opened.
 */
export const signedNoticeDismissed = signal<number | null>(null);

/**
 * What the open line editor offers to the rest of the app (see LineLayer). The selected image
 * registers one too while a keyboard move or resize of it waits to be written (ImageLayer).
 */
export interface LineEditorHandle {
  /** The typed text differs from the line (surrounding spaces aside), or the image was moved. */
  changed(): boolean;
  /** Write the typed text, as Enter would (or the image's move); resolves once it is in the engine's history. */
  commit(): Promise<void>;
}

let openEditor: LineEditorHandle | null = null;

/** Called by the line editor when it opens (or the image frame); returns the function to call when it closes. */
export function registerEditor(handle: LineEditorHandle): () => void {
  openEditor = handle;
  return () => {
    if (openEditor === handle) openEditor = null;
  };
}

/**
 * Write what the open line editor holds (or the image's keyboard move), so a download, share,
 * open, close, update, undo, redo or leaving edit mode includes it.
 */
export async function flushEditor() {
  await openEditor?.commit();
}

/**
 * Edits not downloaded, counting text typed in the line editor (or an image move) not written
 * yet, and the open document's image edits still waiting in the queue.
 */
export function hasUnsavedWork() {
  return dirty.peek() || imageEditsPending.peek() > 0 || (openEditor?.changed() ?? false);
}

// ---------------------------------------------------------------------------------------------
// Toasts

export type ToastKind = "info" | "warn" | "error";
export interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
}
export const toasts = signal<readonly Toast[]>([]);
let nextToastId = 1;
const MAX_TOASTS = 4;

/**
 * Show a toast for `ms` milliseconds; with `ms` 0 it stays until dismissToast() (a status such as
 * "Checking the PDF/A…", taken away when the work ends). Returns its id.
 */
export function showToast(kind: ToastKind, text: string, ms = kind === "info" ? 4000 : 10000): number {
  // The same message is already on screen (e.g. a locked line clicked twice): not again.
  const same = toasts.peek().find((x) => x.kind === kind && x.text === text);
  if (same) return same.id;
  const id = nextToastId++;
  toasts.value = [...toasts.value, { id, kind, text }].slice(-MAX_TOASTS);
  if (ms > 0) setTimeout(() => dismissToast(id), ms);
  return id;
}

export function dismissToast(id: number) {
  toasts.value = toasts.value.filter((x) => x.id !== id);
}

// ---------------------------------------------------------------------------------------------
// Dialogs (one at a time)

/** What the bytes are for: the buttons of the PDF/A questions say "Download" or "Share". */
export type SavePurpose = "download" | "share";

export type DialogState =
  | { kind: "confirm"; title: string; body: string; confirmLabel: string; resolve: (ok: boolean) => void }
  | { kind: "alert"; title: string; body: string }
  | { kind: "password"; file: File; wrong: boolean }
  | { kind: "share"; file: File; saveKey: string }
  /**
   * "How do you want to download it?" (or "…share it?"): format and password, for one download
   * or share, which `purpose` says.
   */
  | { kind: "download-options"; purpose: SavePurpose }
  /**
   * No PDF/A can be written; resolves true when the user takes a normal PDF instead. `blockers`
   * is empty when only the engine's final check refused it (no details to list).
   */
  | {
    kind: "pdfa-blocked";
    blockers: PdfaIssue<PdfaBlockerCode>[];
    purpose: SavePurpose;
    resolve: (fallback: boolean) => void;
  }
  /** The conversion removes or changes something: resolves true to go on. */
  | {
    kind: "pdfa-confirm";
    removals: PdfaIssue<PdfaRemovalCode>[];
    warnings: PdfaIssue<PdfaWarningCode>[];
    purpose: SavePurpose;
    resolve: (ok: boolean) => void;
  };

export const dialog = signal<DialogState | null>(null);

/** Show `next` (or nothing). A question still open is answered "no" first, so its caller goes on. */
export function showDialog(next: DialogState | null) {
  const prev = dialog.peek();
  if (prev && "resolve" in prev) prev.resolve(false);
  dialog.value = next;
}

/** Ask a yes/no question; resolves false on Cancel or Escape. */
export function confirmDialog(opts: { title: string; body: string; confirmLabel: string }): Promise<boolean> {
  return new Promise((resolve) => {
    showDialog({ kind: "confirm", ...opts, resolve });
  });
}
