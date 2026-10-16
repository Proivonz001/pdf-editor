// Keyboard shortcuts: Ctrl/Cmd + Z (undo), Ctrl+Shift+Z / Ctrl+Y (redo), Ctrl + + / − / 0
// (zoom in, out, fit width), Ctrl+O (open), Ctrl+S (download), and Escape, one step at a time:
// in Modifica it deselects the selected image, or else leaves Modifica (the line editor and the
// image frame handle their own Escape first; the frame also its arrows, with Shift or Alt, + / −,
// comma and full stop, and Delete); in Compila e firma it closes the text writer (nothing
// written), else cancels the signature waiting to be placed (back to Testo), else deselects the
// picture, else leaves Compila e firma. In Compila e firma with Testo, Enter on the page region
// (the viewer's scroll area, where the focus goes when a writer closes) opens a writer in the
// middle of what shows, as "Put it in the middle" does (no pointer needed). Undo/redo are left to
// the field while typing in one; nothing is handled while a dialog or a sheet is open.
import {
  dialog, doc, editingLine, editMode, fillMode, fillTool, openWriter, pendingPlacement, selectedImage, sheet,
} from "../state";
import { fitWidth, zoomIn, zoomOut } from "../viewer/zoom";
import { cancelPlacement, cancelWriter, download, placeAtCentre, redo, selectImage, setTool, undo } from "./actions";
import { openFilePicker } from "./filePicker";
import { viewerScroller } from "./focus";

function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement ||
    (target instanceof HTMLInputElement && !["button", "checkbox", "radio", "submit", "reset", "file"].includes(target.type));
}

/** Escape with nothing else to close it: the next step back (see the header). False when there is none. */
function escapeStep(): boolean {
  if (editMode.peek()) {
    if (editingLine.peek()) return false; // the line editor's own
    const selected = selectedImage.peek();
    if (selected) void selectImage(selected.pageIndex, null);
    else void setTool(null);
    return true;
  }
  if (!fillMode.peek()) return false;
  const selected = selectedImage.peek();
  if (openWriter.peek()) cancelWriter(); // its field handles Escape itself; this is from its context bar
  else if (pendingPlacement.peek()) cancelPlacement();
  else if (selected) void selectImage(selected.pageIndex, null);
  else void setTool(null);
  return true;
}

/**
 * Enter on the page region in Compila e firma with Testo (nothing waiting to be placed, no writer
 * open): a writer in the middle of what shows. False when it is not that (Enter is left alone).
 */
function writeOnEnter(target: EventTarget | null): boolean {
  if (!fillMode.peek() || fillTool.peek() !== "text" || pendingPlacement.peek() || openWriter.peek()) return false;
  if (!target || target !== viewerScroller()) return false;
  void placeAtCentre("text");
  return true;
}

function onKeyDown(e: KeyboardEvent) {
  const plain = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
  if (e.key === "Escape" && plain) {
    if (!dialog.peek() && !sheet.peek() && !isTypingTarget(e.target) && escapeStep()) e.preventDefault();
    return;
  }
  if (e.key === "Enter" && plain) {
    if (!e.defaultPrevented && !e.repeat && !dialog.peek() && !sheet.peek() && writeOnEnter(e.target)) e.preventDefault();
    return;
  }
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  if (dialog.peek() || sheet.peek()) return;
  const key = e.key.toLowerCase();
  const hasDoc = doc.peek() !== null;

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
