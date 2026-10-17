// Device facts the UI adapts to: the phone layout, room for the top bar's zoom controls and for
// the side panels, touch (coarse pointer), reduced motion, Mac shortcuts, and whether the system
// share sheet accepts PDF files.
import { signal } from "@preact/signals";

function mediaSignal(query: string) {
  const mq = window.matchMedia(query);
  const s = signal(mq.matches);
  mq.addEventListener("change", (e) => { s.value = e.matches; });
  return s;
}

/** Phone layout (< 640 px): compact top bar, tab bar at the bottom, sheets instead of panels. */
export const isNarrow = mediaSignal("(max-width: 639.98px)");
/** Room for the thumbnails panel by default (>= 1024 px). */
export const isRoomy = mediaSignal("(min-width: 1024px)");
/** Room for the details panel beside the page and the thumbnails: open by default (>= 1200 px). */
export const isWide = mediaSignal("(min-width: 1200px)");
/** Room in the desktop top bar for the zoom controls (>= 768 px); below, they are in the More menu. */
export const hasZoomRoom = mediaSignal("(min-width: 768px)");
/** The user asked for less motion: no sheet slide, no smooth scrolling. */
export const prefersReducedMotion = mediaSignal("(prefers-reduced-motion: reduce)");
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
