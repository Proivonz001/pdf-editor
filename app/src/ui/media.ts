// Device facts the UI adapts to: narrow screen, touch (coarse pointer), Mac shortcuts, and
// whether the system share sheet accepts PDF files.
import { signal } from "@preact/signals";

function mediaSignal(query: string) {
  const mq = window.matchMedia(query);
  const s = signal(mq.matches);
  mq.addEventListener("change", (e) => { s.value = e.matches; });
  return s;
}

/** Phone-sized layout (< 640 px): icon buttons, secondary actions in a menu. */
export const isNarrow = mediaSignal("(max-width: 639.98px)");
/** Touch screen as the main pointer. */
export const isCoarse = mediaSignal("(pointer: coarse)");

export const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

/** Keyboard shortcut labels for tooltips. */
export const shortcuts = {
  open: isMac ? "⌘O" : "Ctrl+O",
  save: isMac ? "⌘S" : "Ctrl+S",
  undo: isMac ? "⌘Z" : "Ctrl+Z",
  redo: isMac ? "⇧⌘Z" : "Ctrl+Y",
  zoomIn: isMac ? "⌘+" : "Ctrl++",
  zoomOut: isMac ? "⌘−" : "Ctrl+−",
  fit: isMac ? "⌘0" : "Ctrl+0",
};

/** The share sheet can take a PDF file (offered on touch devices only). */
export function canSharePdf(): boolean {
  if (!isCoarse.value) return false;
  try {
    return typeof navigator.canShare === "function" &&
      navigator.canShare({ files: [new File([""], "document.pdf", { type: "application/pdf" })] });
  } catch {
    return false;
  }
}
