// App-wide state, all in @preact/signals: the engine, the open document, the edit history
// (and whether it has been downloaded), the viewer settings, toasts and dialogs.
// The actions that change it live in src/ui/actions.ts.
import { batch, computed, signal } from "@preact/signals";
import { EngineClient, EngineError } from "./engine/client";
import type { HistoryState, LineInfo } from "./engine/protocol";
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

export type BusyKind = "edit" | "undo" | "redo" | "save";
/** A change or a save is running in the engine. */
export const busy = signal<BusyKind | null>(null);

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

/** Drop the cached lines of these pages and re-render them. */
export function invalidatePages(indices: readonly number[]) {
  const d = doc.peek();
  if (!d) return;
  batch(() => {
    for (const i of indices) {
      const page = d.pages[i];
      if (!page) continue;
      page.lines.value = null;
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

export type SheetKind = "pages" | "more";
/** The bottom sheet open on phones (page thumbnails, or the "More" actions). */
export const sheet = signal<SheetKind | null>(null);
/**
 * The engine could not restore the document after a failed edit ("broken"): editing, undo and
 * redo stay off until another file is opened. Downloading still works.
 */
export const editingStopped = signal(false);

/** What the open line editor offers to the rest of the app (see LineLayer). */
export interface LineEditorHandle {
  /** The typed text differs from the line (surrounding spaces aside). */
  changed(): boolean;
  /** Write the typed text, as Enter would; resolves once it is in the engine's history. */
  commit(): Promise<void>;
}

let openEditor: LineEditorHandle | null = null;

/** Called by the line editor when it opens; returns the function to call when it closes. */
export function registerEditor(handle: LineEditorHandle): () => void {
  openEditor = handle;
  return () => {
    if (openEditor === handle) openEditor = null;
  };
}

/** Write what the open line editor holds, so a download, share, open, close, update or leaving edit mode includes it. */
export async function flushEditor() {
  await openEditor?.commit();
}

/** Edits not downloaded, counting text typed in the line editor but not written yet. */
export function hasUnsavedWork() {
  return dirty.peek() || (openEditor?.changed() ?? false);
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

export function showToast(kind: ToastKind, text: string, ms = kind === "info" ? 4000 : 10000) {
  // The same message is already on screen (e.g. a locked line clicked twice): not again.
  if (toasts.peek().some((x) => x.kind === kind && x.text === text)) return;
  const id = nextToastId++;
  toasts.value = [...toasts.value, { id, kind, text }].slice(-MAX_TOASTS);
  setTimeout(() => dismissToast(id), ms);
}

export function dismissToast(id: number) {
  toasts.value = toasts.value.filter((x) => x.id !== id);
}

// ---------------------------------------------------------------------------------------------
// Dialogs (one at a time)

export type DialogState =
  | { kind: "confirm"; title: string; body: string; confirmLabel: string; resolve: (ok: boolean) => void }
  | { kind: "alert"; title: string; body: string }
  | { kind: "password"; file: File; wrong: boolean }
  | { kind: "share"; file: File; saveKey: string };

export const dialog = signal<DialogState | null>(null);

export function showDialog(next: DialogState | null) {
  const prev = dialog.peek();
  if (prev?.kind === "confirm") prev.resolve(false);
  dialog.value = next;
}

/** Ask a yes/no question; resolves false on Cancel or Escape. */
export function confirmDialog(opts: { title: string; body: string; confirmLabel: string }): Promise<boolean> {
  return new Promise((resolve) => {
    showDialog({ kind: "confirm", ...opts, resolve });
  });
}
