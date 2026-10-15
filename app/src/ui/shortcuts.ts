// Keyboard shortcuts: Ctrl/Cmd + Z (undo), Ctrl+Shift+Z / Ctrl+Y (redo), Ctrl + + / − / 0
// (zoom in, out, fit width), Ctrl+O (open), Ctrl+S (download), and Escape to leave edit mode
// (the line editor handles its own Escape first). Undo/redo are left to the field while typing
// in one; nothing is handled while a dialog or a sheet is open.
import { dialog, doc, editingLine, editMode, sheet } from "../state";
import { fitWidth, zoomIn, zoomOut } from "../viewer/zoom";
import { download, redo, setEditMode, undo } from "./actions";
import { openFilePicker } from "./filePicker";

function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement ||
    (target instanceof HTMLInputElement && !["button", "checkbox", "radio", "submit", "reset", "file"].includes(target.type));
}

function onKeyDown(e: KeyboardEvent) {
  if (e.key === "Escape" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
    if (editMode.peek() && !editingLine.peek() && !dialog.peek() && !sheet.peek() && !isTypingTarget(e.target)) {
      e.preventDefault();
      void setEditMode(false);
    }
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
