// Keyboard shortcuts: Ctrl/Cmd + Z (undo), Ctrl+Shift+Z / Ctrl+Y (redo), Ctrl + + / − / 0
// (zoom in, out, fit width), Ctrl+O (open), Ctrl+S (download), Cerca's Ctrl+F (open the search, or
// give its field the focus again; also from a text field, as Ctrl+O, never the browser's own find
// while a document is open), F3 and Ctrl+G (the next result; with Shift the previous one; they
// open the search when it is closed; Enter and Esc are the search bar's own), and Escape, one step
// at a time: in Modifica it closes the text writer of Aggiungi testo (nothing written), else
// deselects the selected image, else drops the area waiting in Bianchetto or Oscura, else goes from
// Aggiungi testo, Bianchetto or Oscura back to Cambia, else leaves Modifica (the line
// editor, the writer's field and the image frame handle their own Escape first; the frame also its
// arrows, with Shift or Alt, + / −, comma and full stop, and Delete); in Compila e firma it closes
// the text writer (nothing written), else cancels the signature waiting to be placed (back to
// Testo), else deselects the picture, else leaves Compila e firma. Where the writer writes text
// (Compila e firma with Testo, Modifica with Aggiungi testo), Enter on the page region (the
// viewer's scroll area, where the focus goes when a writer closes) opens a writer in the middle of
// what shows, as "Put it in the middle" does (no pointer needed). Undo/redo are left to the field
// while typing in one; nothing is handled while a dialog, a sheet or the scan flow is open (a
// modal: the document under it is not to change unseen; the scan flow's Escape is its own).
import {
  dialog, doc, editingLine, editMode, editTool, fillMode, openWriter, pendingPlacement, scanFlow, selectedImage,
  sheet, writerKind, writerOn,
} from "../state";
import { fitWidth, zoomIn, zoomOut } from "../viewer/zoom";
import {
  cancelPlacement, cancelWriter, download, placeAtCentre, redo, selectImage, setEditTool, setTool, undo,
} from "./actions";
import { openFilePicker } from "./filePicker";
import { viewerScroller } from "./focus";
import { cancelPendingRedact } from "./redact/pending";
import { goToResult, openSearch, searchOpen } from "./search/state";

function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement ||
    (target instanceof HTMLInputElement && !["button", "checkbox", "radio", "submit", "reset", "file"].includes(target.type));
}

/** Escape with nothing else to close it: the next step back (see the header). False when there is none. */
function escapeStep(): boolean {
  const selected = selectedImage.peek();
  if (editMode.peek()) {
    if (editingLine.peek()) return false; // the line editor's own
    if (openWriter.peek()) cancelWriter(); // as in Compila e firma: from the writer's context bar
    else if (selected) void selectImage(selected.pageIndex, null);
    else if (editTool.peek() !== "change") {
      if (!cancelPendingRedact()) void setEditTool("change"); // Bianchetto and Oscura: the waiting area first
    }
    else void setTool(null);
    return true;
  }
  if (!fillMode.peek()) return false;
  if (openWriter.peek()) cancelWriter(); // its field handles Escape itself; this is from its context bar
  else if (pendingPlacement.peek()) cancelPlacement();
  else if (selected) void selectImage(selected.pageIndex, null);
  else void setTool(null);
  return true;
}

/**
 * Enter on the page region where a tap writes text (Compila e firma with Testo, Modifica with
 * Aggiungi testo), with nothing waiting to be placed and no writer open: a writer in the middle of
 * what shows. False when it is not that (Enter is left alone).
 */
function writeOnEnter(target: EventTarget | null): boolean {
  if (!writerOn.peek() || writerKind.peek() !== "text" || pendingPlacement.peek() || openWriter.peek()) return false;
  if (!target || target !== viewerScroller()) return false;
  void placeAtCentre("text");
  return true;
}

/** F3, Ctrl+G (with Shift: `dir` -1): the next result when the search is open, else open it. */
function nextResult(dir: 1 | -1): void {
  if (searchOpen.peek()) goToResult(dir);
  else openSearch();
}

/** A modal is open: a dialog, a sheet, or the scan flow (its own signal). */
function modalOpen(): boolean {
  return !!(dialog.peek() || sheet.peek() || scanFlow.peek());
}

function onKeyDown(e: KeyboardEvent) {
  const plain = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
  if (e.key === "Escape" && plain) {
    if (!modalOpen() && !isTypingTarget(e.target) && escapeStep()) e.preventDefault();
    return;
  }
  if (e.key === "Enter" && plain) {
    if (!e.defaultPrevented && !e.repeat && !modalOpen() && writeOnEnter(e.target)) e.preventDefault();
    return;
  }
  if (e.key === "F3" && !e.ctrlKey && !e.metaKey && !e.altKey) {
    if (modalOpen() || !doc.peek()) return;
    e.preventDefault();
    nextResult(e.shiftKey ? -1 : 1);
    return;
  }
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  if (modalOpen()) return;
  const key = e.key.toLowerCase();
  const hasDoc = doc.peek() !== null;

  // Cerca: ours while a document is open, from a text field too.
  if (hasDoc && key === "f" && !e.shiftKey) {
    e.preventDefault();
    openSearch();
    return;
  }
  if (hasDoc && key === "g") {
    e.preventDefault();
    nextResult(e.shiftKey ? -1 : 1);
    return;
  }

  // Zoom: always ours while a document is open (never the browser's page zoom).
  if (hasDoc && (key === "+" || key === "=" || key === "-" || key === "_" || key === "0")) {
    e.preventDefault();
    if (key === "0") fitWidth();
    else if (key === "-" || key === "_") zoomOut();
    else zoomIn();
    return;
  }
  if (key === "o") {
    e.preventDefault();
    openFilePicker();
    return;
  }
  if (key === "s" && hasDoc) {
    e.preventDefault();
    void download();
    return;
  }
  if (!hasDoc || isTypingTarget(e.target)) return;
  if (key === "z") {
    e.preventDefault();
    void (e.shiftKey ? redo() : undo());
  } else if (key === "y") {
    e.preventDefault();
    void redo();
  }
}

export function installShortcuts(): () => void {
  window.addEventListener("keydown", onKeyDown);
  return () => window.removeEventListener("keydown", onKeyDown);
}
