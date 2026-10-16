// App-wide state, all in @preact/signals: the engine, the open document, the edit history
// (and whether it has been downloaded), the viewer settings (the tool: Modifica or Compila e
// firma; the line being edited, the selected image and the image edits still on their way),
// what Compila e firma holds (its sub-tool, the text writer, the signatures of this session, a
// signature waiting to be placed, the focused form field and whether it takes typing, where the
// keyboard focus is to go next), toasts and dialogs (the download options, the PDF/A questions,
// the signature sheet and the fill-and-sign questions among them).
// The actions that change it live in src/ui/actions.ts.
import { batch, computed, signal } from "@preact/signals";
import { EngineClient, EngineError } from "./engine/client";
import type {
  HistoryState, LineInfo, PdfaBlockerCode, PdfaIssue, PdfaRemovalCode, PdfaWarningCode, Rect,
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

/**
 * Drop the cached lines, images, form fields and added texts of these pages and re-render them
 * (after an undo, the field overlays read the values again).
 */
export function invalidatePages(indices: readonly number[]) {
  const d = doc.peek();
  if (!d) return;
  batch(() => {
    for (const i of indices) {
      const page = d.pages[i];
      if (!page) continue;
      page.lines.value = null;
      page.images.value = null;
      page.fields.value = null;
      page.added.value = null;
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

/**
 * The tool that is on: "edit" (Modifica: the document's own lines and images), "fill" (Compila e
 * firma: form fields, text written anywhere, signatures, pictures), or none (browse, where the
 * form fields still work). One at a time; changed only through setTool (actions.ts).
 */
export type Tool = "edit" | "fill" | null;
export const tool = signal<Tool>(null);
/** Kept for the existing readers: true in Modifica. Read-only (a computed). */
export const editMode = computed(() => tool.value === "edit");
/** True in Compila e firma. */
export const fillMode = computed(() => tool.value === "fill");

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
 * The image selected in Modifica, or in Compila e firma a picture the user added (moved,
 * resized, rotated... with its frame and context bar). One at a time, and never together with an
 * open line editor or text writer: selecting one closes the other. After an edit of the image it
 * follows the image's new index; undo, redo and a change of tool clear it.
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

// ---------------------------------------------------------------------------------------------
// Compila e firma

/**
 * The sub-tool a tap uses in Compila e firma: write text (the default), a tick, a cross, today's
 * date, a signature, initials, a picture. Tick, cross and date stay on after use; Firma and Sigla
 * go back to Testo after one placement. "image" is an action (the picture picker), never left on.
 */
export type FillTool = "text" | "check" | "cross" | "date" | "signature" | "initials" | "image";
export const fillTool = signal<FillTool>("text");

/** The two inks of what the user writes and signs: black (the default) and ballpoint blue. */
export type InkColor = "black" | "blue";
/** The inks in sRGB 0..1, as TextStyle wants them: #000000 and #1F3B94. */
export const INK: Record<InkColor, [number, number, number]> = {
  black: [0, 0, 0],
  blue: [0x1f / 255, 0x3b / 255, 0x94 / 255],
};
/** Size (points) and ink of the next text written: the last ones used, for the session. */
export const writerStyle = signal<{ size: number; color: InkColor }>({ size: 11, color: "black" });

/**
 * The text writer open on a page: a new text (or a mark, or a date) at `origin`, or one written
 * before, reopened (`editing`). The writer component holds what is typed; commitWriter writes it.
 */
export interface OpenWriter {
  pageIndex: number;
  /** Baseline start, page space. */
  origin: [number, number];
  /** The text it opened with. */
  text: string;
  size: number;
  color: InkColor;
  kind: "text" | "date" | "check" | "cross";
  /** AddedText.id when reopening one; null for a new text. */
  editing: number | null;
  /** page.rev when opened. */
  rev: number;
}
export const openWriter = signal<OpenWriter | null>(null);

/** A signature or initials made in the sheet (drawn, typed or from a photo): a trimmed PNG with alpha. */
export interface Signature {
  id: string;
  kind: "signature" | "initials";
  png: Blob;
  /** Pixel size of the PNG. */
  width: number;
  height: number;
  /** What screen readers say, and the /Alt on tagged pages: "Firma: Mario Rossi", "Firma". */
  description: string;
  source: "draw" | "type" | "photo";
  /** When it was saved on this device; null: this session only. */
  savedAt: number | null;
}
/**
 * The signatures this session knows, newest first: those made since the app started (for every
 * document, until reload) and those saved on this device (savedAt set), read once a document is
 * open (loadSavedSignatures).
 */
export const sessionSignatures = signal<readonly Signature[]>([]);
/** The saved ones ("Firme salvate (N)" in the More menu and sheet). */
export const savedSignatures = computed(() => sessionSignatures.value.filter((s) => s.savedAt !== null));
/** The signature or initials chosen and not placed yet: the next tap on a page places it. */
export const pendingPlacement = signal<Signature | null>(null);
/**
 * The form field that has the focus (its widget on that page), or the one the app asks the form
 * layer to focus (the first empty required field, "Fill them in"; the next field).
 */
export const focusedField = signal<{ pageIndex: number; name: string; index: number } | null>(null);
/**
 * A form control that brings up the keyboard (a text field, one on several lines) holds the
 * focus; not a check box, a radio button or a list. Set by the form layer from each control's own
 * focus and blur, so it follows the control that really has the focus, also when the app moves it
 * ("Next empty field", the keyboard's next). The phone's tab bar, strip and page indicator make
 * room for the keyboard while it is true. False again when the document goes or Modifica comes on
 * (no form controls there).
 */
export const typingField = signal(false);

/** What focusRequest asks to focus: an added text's box, an image frame, a form field. */
export interface FocusRequest {
  pageIndex: number;
  kind: "added" | "image" | "field";
  /** AddedText.id for "added", the image's index for "image", the field's name for "field". */
  id: number | string;
}
/**
 * A request to move the keyboard focus to something just placed or written (a mark or a date put
 * in the middle with "Put it in the middle", a signature placed from the keyboard, a text written
 * from the keyboard). The viewer layers honour it once the element exists (also after the page is
 * read again) and then clear it. Cleared too by a change of tool and by another document.
 */
export const focusRequest = signal<FocusRequest | null>(null);

/**
 * The initials placed last, while they can still be found: what "On every page…" copies (its
 * picture and where it is). Followed through moves like the selection; gone after a delete,
 * undo, redo, or another document. ImageLayer offers "On every page…" on this image only.
 */
export const initialsSource = signal<{ docId: number; pageIndex: number; imageIndex: number; sig: Signature } | null>(null);

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
 * registers one too while a keyboard move or resize of it waits to be written (ImageLayer), and
 * so does the open text writer of Compila e firma (FillLayer: commitWriter).
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
 * Write what the open line editor or text writer holds (or the image's keyboard move), so a
 * download, share, open, close, update, undo, redo or a change of tool includes it.
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
  }
  /**
   * The signature sheet: choose one of this session's or the device's signatures (or initials),
   * or make a new one. `forField`: opened from "Sign here" on an unsigned signature field, the
   * signature goes inside that box (useSignature), turned with the field's text (`rotation`,
   * FieldWidget.rotation: clockwise, page /Rotate plus the widget's own).
   */
  | {
    kind: "signature";
    mode: "signature" | "initials";
    forField: { pageIndex: number; rect: Rect; rotation: 0 | 90 | 180 | 270 } | null;
  }
  /**
   * "On every page…" for the initials `imageIndex` of page `pageIndex`: resolves with the pages
   * to put them on, or null on Cancel.
   */
  | { kind: "initials-pages"; pageIndex: number; imageIndex: number; resolve: (pages: number[] | null) => void }
  /**
   * `count` required fields are still empty at download: "fill" to fill them in, "download" to
   * download anyway, null on Cancel.
   */
  | { kind: "missing-fields"; count: number; resolve: (go: "fill" | "download" | null) => void };

export const dialog = signal<DialogState | null>(null);

/** Answer `question` "no" (Cancel), so its caller goes on. */
function answerNo(question: DialogState) {
  switch (question.kind) {
    case "confirm":
    case "pdfa-blocked":
    case "pdfa-confirm":
      question.resolve(false);
      break;
    case "initials-pages":
    case "missing-fields":
      question.resolve(null);
      break;
  }
}

/** Show `next` (or nothing). A question still open is answered "no" first, so its caller goes on. */
export function showDialog(next: DialogState | null) {
  const prev = dialog.peek();
  if (prev) answerNo(prev);
  dialog.value = next;
}

/** Ask a yes/no question; resolves false on Cancel or Escape. */
export function confirmDialog(opts: { title: string; body: string; confirmLabel: string }): Promise<boolean> {
  return new Promise((resolve) => {
    showDialog({ kind: "confirm", ...opts, resolve });
  });
}
