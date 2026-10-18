// App-wide state, all in @preact/signals: the engine, the open document, the edit history
// (and whether it has been downloaded), the viewer settings (the tool: Modifica, with its
// sub-tool Cambia or Aggiungi testo, or Compila e firma; where the text writer is on and what a
// tap writes there; the line being edited and what follows its text, the selected image and the
// image edits still on their way), the text writer (Compila e firma's, and Modifica's with Aggiungi testo: writerOn,
// writerKind), what Compila e firma holds (its sub-tool, the signatures of this session, a
// signature waiting to be placed, the focused form field and whether it takes typing), where the
// keyboard focus is to go next, toasts (one may carry a button: the first download's "Install the
// app") and dialogs (the download options, the PDF/A questions, the signature sheet, the
// fill-and-sign questions and the install steps among them).
// The actions that change it live in src/ui/actions.ts.
import { batch, computed, signal } from "@preact/signals";
import { EngineClient, EngineError } from "./engine/client";
import type {
  HistoryState, LineDecorations, LineInfo, PdfaBlockerCode, PdfaIssue, PdfaRemovalCode, PdfaWarningCode, Rect,
} from "./engine/protocol";
import { applyLayout, type OpenDoc, type PageModel } from "./viewer/model";

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
//
// Edit marks (the thumbnails' "edited") are kept by page, not by index: the PageModel keys of
// the pages each edit changed (model.ts), so they follow the pages through page operations, go
// with a deleted page and come back with it on undo. A step that changed the pages themselves
// (release 4: a page operation, its undo or redo) carries the new layout (HistoryState.layout):
// recordHistory rebuilds the page list from it (applyLayout), and keeps, for each page operation,
// the PageModels before and after it, so that its undo and redo bring back those very models.
// The undos and redos asked for and not run yet are kept too, in order (stepAsked): gone through
// on the mirror, they say whether one on its way will change the pages (stepsAheadChangePages).

export const EMPTY_HISTORY: HistoryState = { editCount: 0, canUndo: false, canRedo: false, changedPages: [] };
export const history = signal<HistoryState>(EMPTY_HISTORY);

const applied = signal<readonly number[]>([]);
let redoStack: number[] = [];
let nextEditId = 1;
const savedKey = signal("");
/**
 * A saved key no state of the edits has: a document that exists nowhere else yet (one made from
 * scans) is not downloaded until it is, edits or not.
 */
const NEVER_SAVED = "-";

/**
 * The pages each edit changed, by edit id: the keys of their PageModels; an index with no page
 * there (no document open, or a page the UI does not have) is kept as the bare index.
 */
const editMarks = new Map<number, { keys: readonly number[]; indices: readonly number[] }>();
/** For each page operation, by edit id: the document's PageModels before and after it, in page order. */
const editLayouts = new Map<number, { before: readonly PageModel[]; after: readonly PageModel[] }>();
/** Edits the engine had before the UI saw them (a history resumed with Riprendi): their pages are not known. */
const unknownEdits = new Set<number>();

/** There are edits that have not been downloaded (or shared) yet. */
export const dirty = computed(() => applied.value.join(",") !== savedKey.value);

/** Keys of the PageModels (PageModel.key) that hold at least one applied edit. */
export const editedKeys = computed(() => {
  const keys = new Set<number>();
  for (const id of applied.value) for (const k of editMarks.get(id)?.keys ?? []) keys.add(k);
  return keys as ReadonlySet<number>;
});

/**
 * Indices of the pages that hold at least one applied edit (marked in the thumbnails), in the
 * pages as they are now: it follows page operations (reading doc.pages follows `layout`).
 */
export const editedPages = computed(() => {
  const pages = new Set<number>();
  const keys = editedKeys.value;
  const d = doc.value;
  if (d && keys.size) for (const p of d.pages) if (keys.has(p.key)) pages.add(p.index);
  for (const id of applied.value) for (const i of editMarks.get(id)?.indices ?? []) pages.add(i);
  return pages as ReadonlySet<number>;
});

function forgetEdit(id: number) {
  editMarks.delete(id);
  editLayouts.delete(id);
  unknownEdits.delete(id);
}

export function resetHistory() {
  batch(() => {
    history.value = EMPTY_HISTORY;
    applied.value = [];
    savedKey.value = "";
  });
  redoStack = [];
  editMarks.clear();
  editLayouts.clear();
  unknownEdits.clear();
}

/**
 * The open document exists nowhere else yet: made here (from scans), or resumed with Riprendi
 * without knowing that the file it was kept from is somewhere else, and not downloaded or shared
 * in any state since. An undo back to its start does not make it clean (dirty stays true). What
 * Riprendi's record keeps, so the resumed document counts the same (adoptOpened's `unsaved`).
 */
export function neverDownloaded(): boolean {
  return savedKey.peek() === NEVER_SAVED;
}

/**
 * The history of a document just opened, as the engine has it: none (a file opened), or `state`
 * (Riprendi: `state.editCount` edits applied, which can be undone; which pages they changed is not
 * known, so no page is marked; they are not downloaded). `unsaved`: the document itself exists
 * nowhere else yet (made from scans, or resumed as such): it counts as not downloaded until it
 * is, also once every edit is undone (neverDownloaded).
 */
export function startHistory(state?: HistoryState, unsaved = false) {
  resetHistory();
  const ids: number[] = [];
  const count = state ? Math.max(0, Math.floor(state.editCount)) : 0;
  for (let k = 0; k < count; k++) {
    const id = nextEditId++;
    ids.push(id);
    unknownEdits.add(id);
  }
  batch(() => {
    if (state) {
      history.value = { editCount: state.editCount, canUndo: state.canUndo, canRedo: false, changedPages: [] };
    }
    applied.value = ids;
    if (unsaved) savedKey.value = NEVER_SAVED;
  });
}

/** The marks of an edit that changed `indices` of `d` (the pages as they are after it). */
function marksOf(d: OpenDoc | null, indices: readonly number[]) {
  const keys: number[] = [];
  const loose: number[] = [];
  for (const i of indices) {
    const page = d?.pages[i];
    if (page && typeof page.key === "number") keys.push(page.key);
    else loose.push(i);
  }
  return { keys, indices: loose };
}

/**
 * The page to show after a step that changed the pages: the one shown before (`shown`, among
 * `before`), wherever it is now; when it went, the nearest page after it that stayed, else before.
 */
function pageAfter(before: readonly PageModel[], after: readonly PageModel[], shown: PageModel | undefined): number {
  const now = new Set(after);
  const at = shown ? before.indexOf(shown) : -1;
  if (shown && now.has(shown)) return shown.index;
  for (let i = at + 1; i < before.length; i++) if (now.has(before[i])) return before[i].index;
  for (let i = at - 1; i >= 0; i--) if (now.has(before[i])) return before[i].index;
  return 0;
}

/**
 * Whether the edit an undo would take back (or a redo apply again) changed the pages themselves
 * (a page operation): true or false, or null when it is not known (a history resumed with
 * Riprendi). False when there is nothing to undo (or redo).
 */
export function stepChangesPages(step: "undo" | "redo"): boolean | null {
  const id = step === "undo" ? applied.peek().at(-1) : redoStack.at(-1);
  if (id === undefined) return false;
  if (unknownEdits.has(id)) return null;
  return editLayouts.has(id);
}

/** An undo or a redo asked for and not run yet: its document, and for an "Annulla" the edit it is for. */
interface StepAhead {
  doc: OpenDoc;
  step: "undo" | "redo";
  expected?: number;
}

/** The undos and redos on their way (asked for, not run yet), in the order asked (actions.ts, historyStep). */
const stepsAhead: StepAhead[] = [];

/**
 * Count an undo or a redo of `d` (`expected`: the edit an "Annulla" is for) as on its way, from
 * now until the function it returns is called (once): when it has run, in the same moment as
 * recordHistory records it, or when it was dropped.
 */
export function stepAsked(d: OpenDoc, step: "undo" | "redo", expected?: number): () => void {
  const entry: StepAhead = { doc: d, step, expected };
  stepsAhead.push(entry);
  return () => {
    const i = stepsAhead.indexOf(entry);
    if (i >= 0) stepsAhead.splice(i, 1);
  };
}

/**
 * One of the undos and redos of `d` on its way (stepAsked) will take back, or apply again, a page
 * operation (or an edit whose pages are not known: a history resumed with Riprendi). Each is taken
 * in turn on the mirror as the ones before it leave it, as they will run: two undos reach the last
 * two edits; an "Annulla" whose edit is not the last one by then does nothing; nothing to undo or
 * redo, nothing. Worked out anew from the mirror each time, so edits landing meanwhile count.
 */
export function stepsAheadChangePages(d: OpenDoc): boolean {
  const ids = [...applied.peek()];
  const redo = [...redoStack];
  for (const ahead of stepsAhead) {
    if (ahead.doc !== d) continue;
    let id: number | undefined;
    if (ahead.step === "undo") {
      if (ahead.expected !== undefined && ids.at(-1) !== ahead.expected) continue;
      id = ids.pop();
      if (id !== undefined) redo.push(id);
    } else {
      id = redo.pop();
      if (id !== undefined) ids.push(id);
    }
    if (id !== undefined && (unknownEdits.has(id) || editLayouts.has(id))) return true;
  }
  return false;
}

/** The id of the last edit applied (for an action that offers to undo that very edit), or null. */
export function lastEditId(): number | null {
  return applied.peek().at(-1) ?? null;
}

/** Edit `id` (recordHistory's) is applied: not undone, and not dropped by another document. */
export function isApplied(id: number): boolean {
  return applied.peek().includes(id);
}

/**
 * Record a history step returned by the engine and refresh the pages it changed. An edit that
 * changed no page (e.g. only spaces around the text) is not one: the engine did not log it;
 * unless it changed the pages themselves (`layout`: a delete changes no page that stays). With a
 * `layout`, the page list is rebuilt first (applyLayout: an undo or a redo brings back the
 * PageModels the pages had then), and the current page follows the page it showed (or its
 * nearest neighbour that stayed); the indices of `changedPages` are those of the new pages.
 * Returns the new edit's id (for "edit"), else null.
 */
export function recordHistory(state: HistoryState, step: "edit" | "undo" | "redo"): number | null {
  const layout = state.layout;
  if (step === "edit" && state.changedPages.length === 0 && !layout) {
    history.value = state;
    return null;
  }
  let recorded: number | null = null;
  batch(() => {
    const d = doc.peek();
    const ids = [...applied.value];
    let id: number | undefined;
    if (step === "edit") {
      id = nextEditId++;
      ids.push(id);
      for (const dropped of redoStack) forgetEdit(dropped);
      redoStack = [];
      recorded = id;
    } else if (step === "undo") {
      id = ids.pop();
      if (id !== undefined) redoStack.push(id);
    } else {
      id = redoStack.pop();
      if (id !== undefined) ids.push(id);
    }
    if (layout && d) {
      const known = id === undefined ? undefined : editLayouts.get(id);
      const before = d.pages.slice();
      const shown = before[Math.min(Math.max(0, currentPage.peek()), before.length - 1)];
      applyLayout(d, layout, step === "undo" ? known?.before : step === "redo" ? known?.after : undefined);
      if (step === "edit" && id !== undefined) editLayouts.set(id, { before, after: d.pages.slice() });
      currentPage.value = pageAfter(before, d.pages, shown);
    }
    if (step === "edit" && id !== undefined) editMarks.set(id, marksOf(d, state.changedPages));
    applied.value = ids;
    history.value = state;
    invalidatePages(state.changedPages);
  });
  return recorded;
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
 * The tool that is on: "edit" (Modifica: the document's own lines and images, and new text and
 * pictures), "fill" (Compila e firma: form fields, text written anywhere, marks, the date,
 * signatures), or none (browse, where the form fields still work). One at a time; changed only
 * through setTool (actions.ts).
 */
export type Tool = "edit" | "fill" | null;
export const tool = signal<Tool>(null);
/** Kept for the existing readers: true in Modifica. Read-only (a computed). */
export const editMode = computed(() => tool.value === "edit");
/** True in Compila e firma. */
export const fillMode = computed(() => tool.value === "fill");

/**
 * What a tap does in Modifica: "change" (the default: open a line to change it, select an image
 * to move it) or "addText" (write a new text where the user taps, with the same writer as Testo
 * in Compila e firma). "Aggiungi immagine" is an action (the picture picker), never left on.
 * Back to "change" whenever the tool changes (setTool).
 */
export type EditTool = "change" | "addText";
export const editTool = signal<EditTool>("change");

/**
 * The text writer can be used: in Compila e firma, and in Modifica with Aggiungi testo. Its
 * taps, the boxes over what the user wrote and the writer itself (FillLayer) are on the pages.
 */
export const writerOn = computed(() => tool.value === "fill" || (tool.value === "edit" && editTool.value === "addText"));

/**
 * What a tap on the page writes while the writer is on: Compila e firma's sub-tool, or Testo in
 * Modifica (Aggiungi testo writes text only).
 */
export const writerKind = computed<FillTool>(() => (tool.value === "edit" ? "text" : fillTool.value));

export interface EditingLine {
  pageIndex: number;
  line: LineInfo;
}
/** The line whose inline editor is open. */
export const editingLine = signal<EditingLine | null>(null);

/**
 * The decorations of the line open in the line editor, once the engine has said (for the details
 * panel): what follows its text if it is edited (underlines, strike-throughs, links), the
 * background it may stretch too, and what stays as it is. Set by the editor when the answer comes
 * (only while it is open on that page revision, `rev`), cleared when it closes or another line opens.
 */
export const editingDecorations = signal<{ pageIndex: number; lineIndex: number; rev: number; info: LineDecorations } | null>(null);

export interface SelectedImage {
  pageIndex: number;
  /** ImageInfo.index in the page's current image list. */
  index: number;
}
/**
 * The image selected (moved, resized, rotated... with its frame and context bar): any image in
 * Modifica with Cambia, only a picture the user added wherever the text writer is on (Compila e
 * firma, Modifica with Aggiungi testo: writerOn). One at a time, and never together with an open
 * line editor or text writer: selecting one closes the other. After an edit of the image it
 * follows the image's new index; undo, redo and a change of tool or of Modifica's sub-tool clear it.
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
// Compila e firma, and the text writer (also Modifica's, with Aggiungi testo)

/**
 * The sub-tool a tap uses in Compila e firma: write text (the default), a tick, a cross, today's
 * date, a signature, initials. Tick, cross and date stay on after use; Firma and Sigla go back to
 * Testo after one placement. Pictures are added from Modifica (Aggiungi immagine).
 */
export type FillTool = "text" | "check" | "cross" | "date" | "signature" | "initials";
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
 * The text writer open on a page (Compila e firma, or Modifica with Aggiungi testo, which writes
 * text only): a new text (or a mark, or a date) at `origin`, or one written before, reopened
 * (`editing`). The writer component holds what is typed; commitWriter writes it.
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
 * read again) and then clear it. Cleared too by a change of tool or of Modifica's sub-tool, and by
 * another document.
 */
export const focusRequest = signal<FocusRequest | null>(null);

/**
 * The initials placed last, while they can still be found: what "On every page…" copies (its
 * picture and where it is). Followed through moves like the selection; gone after a delete,
 * undo, redo, or another document. ImageLayer offers "On every page…" on this image only.
 */
export const initialsSource = signal<{ docId: number; pageIndex: number; imageIndex: number; sig: Signature } | null>(null);

export type SheetKind = "pages" | "more" | "details";
/** The bottom sheet open on phones (page thumbnails, the "More" actions, or the details). */
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
 * so does the open text writer, wherever it is on (FillLayer: commitWriter).
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
 * download, share, open, close, update, undo, redo or a change of tool or of Modifica's sub-tool
 * includes it.
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
/**
 * A button in a toast, after its text (the first download's "Install the app"): pressing it
 * dismisses the toast, then runs `run`.
 */
export interface ToastAction {
  label: string;
  run: () => void;
}
export interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
  action?: ToastAction;
}
export const toasts = signal<readonly Toast[]>([]);
let nextToastId = 1;
const MAX_TOASTS = 4;
/** A toast with a button stays a little longer, so there is time to reach it (Tab, a tap). */
export const TOAST_ACTION_MS = 10_000;
/** A toast let go with less time than this left (holdToast) gets this much, to finish reading it. */
export const TOAST_RESUME_MS = 2000;

/** What keeps a toast on screen past its time: the keyboard focus inside it, the pointer on it. */
export type ToastHold = "focus" | "pointer";

/**
 * The clock of a timed toast: the time it has left, counted from `since` while it runs. Stopped
 * (no `timer`) while anything holds it: the focus inside it, the pointer on it.
 */
interface ToastClock {
  left: number;
  since: number;
  timer: ReturnType<typeof setTimeout> | null;
  holds: Set<ToastHold>;
}
const clocks = new Map<number, ToastClock>();

function runClock(id: number, clock: ToastClock) {
  clock.since = Date.now();
  clock.timer = setTimeout(() => dismissToast(id), clock.left);
}

/**
 * Show a toast for `ms` milliseconds (by default 4 s for info, 10 s for warnings, errors and a
 * toast with an `action`); with `ms` 0 it stays until dismissToast() (a status such as "Checking
 * the PDF/A…", taken away when the work ends). The time stops while the toast holds the focus or
 * the pointer (holdToast). Returns its id.
 */
export function showToast(kind: ToastKind, text: string, ms?: number, action?: ToastAction): number {
  // The same message is already on screen (e.g. a locked line clicked twice): not again. One
  // with a button takes its place instead, so the button is not lost.
  const same = toasts.peek().find((x) => x.kind === kind && x.text === text);
  if (same && !action) return same.id;
  const id = nextToastId++;
  const rest = same ? toasts.peek().filter((x) => x !== same) : toasts.peek();
  toasts.value = [...rest, { id, kind, text, ...(action ? { action } : {}) }].slice(-MAX_TOASTS);
  // The one replaced, and the oldest beyond MAX_TOASTS, are gone: so are their clocks.
  for (const [other, clock] of clocks) {
    if (toasts.value.some((x) => x.id === other)) continue;
    if (clock.timer) clearTimeout(clock.timer);
    clocks.delete(other);
  }
  const life = ms ?? (action ? TOAST_ACTION_MS : kind === "info" ? 4000 : 10000);
  if (life > 0) {
    const clock: ToastClock = { left: life, since: 0, timer: null, holds: new Set() };
    clocks.set(id, clock);
    runClock(id, clock);
  }
  return id;
}

/**
 * Stop the time of toast `id` while `why` holds it (`held`), and let it go on when nothing does:
 * with the time it had left, at least TOAST_RESUME_MS. So a toast is never taken away under the
 * focus or the pointer (its button being reached with Tab, its text being read). Nothing for a
 * toast that is gone or not timed.
 */
export function holdToast(id: number, why: ToastHold, held: boolean) {
  const clock = clocks.get(id);
  if (!clock) return;
  const wasHeld = clock.holds.size > 0;
  if (held) clock.holds.add(why);
  else clock.holds.delete(why);
  const isHeld = clock.holds.size > 0;
  if (isHeld && !wasHeld && clock.timer) {
    clearTimeout(clock.timer);
    clock.timer = null;
    clock.left -= Date.now() - clock.since;
  } else if (!isHeld && wasHeld) {
    clock.left = Math.max(clock.left, TOAST_RESUME_MS);
    runClock(id, clock);
  }
}

export function dismissToast(id: number) {
  const clock = clocks.get(id);
  if (clock?.timer) clearTimeout(clock.timer);
  clocks.delete(id);
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
  | { kind: "missing-fields"; count: number; resolve: (go: "fill" | "download" | null) => void }
  /**
   * "Install the app": why, and this browser's steps (ui/InstallDialog.tsx), where the browser
   * has no install dialog of its own ready (openInstall, ui/actions.ts).
   */
  | { kind: "install" }
  /**
   * Release 4: "Da un altro PDF…": choose a PDF, then all its pages or some, inserted at `at`
   * (ui/organizer: the page picker; the source is open in the engine while the dialog is).
   */
  | { kind: "insert-from-pdf"; at: number }
  /** Release 4: "Sposta in posizione…" for `pages` (the keyboard and screen-reader way to move pages). */
  | { kind: "move-pages"; pages: number[] };

export const dialog = signal<DialogState | null>(null);

/**
 * Release 4: the scan flow is open (ui/scan): to make a new PDF from photos or scans, or to
 * insert them into the open document at `at`. Null when it is closed.
 */
export type ScanTarget = { kind: "new" } | { kind: "insert"; at: number };
export const scanFlow = signal<ScanTarget | null>(null);

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
