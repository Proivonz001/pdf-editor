// The whole window is a drop target for PDF files. Only drags that carry files are taken over:
// dragging text (e.g. inside the line editor) keeps working as usual. While a file is dragged
// over the window, a tinted overlay with a dashed frame and the brand card says what a drop
// does (styles/overlays.css); it is decorative, the drop itself is the action. While a dialog
// is open, a drop is ignored and no overlay is shown; so while the scan flow is open, which takes
// the pictures dropped on it itself (ui/scan/ScanFlow.tsx): no PDF opens beneath it.
//
// Over the page thumbnails (release 4: a drop zone, ui/organizer/dropZone.ts), a PDF dropped
// adds its pages there instead of opening: the thumbnails show where (above the overlay) and
// the overlay says so; the page picker of "From another PDF…" then opens on that file.
import { useEffect, useState } from "preact/hooks";
import { t } from "../i18n";
import { dialog, scanFlow, showToast } from "../state";
import { isPdfFile, openFile } from "./actions";
import { Logo } from "./Logo";
import { pdfDropZoneAt, type PdfDropZone } from "./organizer/dropZone";

function carriesFiles(e: DragEvent) {
  return !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");
}

export function DropOverlay() {
  const [active, setActive] = useState(false);
  /** The file is over the thumbnails: a drop adds its pages. */
  const [inserting, setInserting] = useState(false);

  useEffect(() => {
    let depth = 0; // dragenter/dragleave fire for every child element crossed
    let zone: PdfDropZone | null = null;
    /** The zone the file is over now (null: none): the one before is told it left. */
    const over = (next: PdfDropZone | null, e: DragEvent | null) => {
      if (zone !== next) zone?.hover(null);
      zone = next;
      setInserting(next !== null);
      if (next && e) next.hover({ x: e.clientX, y: e.clientY });
    };
    const onEnter = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      depth++;
      // A drop is ignored while a dialog (or the scan flow) is open: then the overlay would promise too much.
      if (!dialog.peek() && !scanFlow.peek()) setActive(true);
    };
    const onOver = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault(); // allow the drop
      // The scan flow's own dragover has said whether it takes the files (unless a dialog is over it).
      if (e.dataTransfer && (dialog.peek() || !scanFlow.peek())) e.dataTransfer.dropEffect = dialog.peek() ? "none" : "copy";
      over(dialog.peek() || scanFlow.peek() ? null : pdfDropZoneAt(e.target), e);
    };
    const onLeave = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) {
        setActive(false);
        over(null, null);
      }
    };
    const onDrop = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault(); // never let the browser navigate to the file
      depth = 0;
      setActive(false);
      const ignored = !!(dialog.peek() || scanFlow.peek()); // the scan flow has taken its own drop
      const target = ignored ? null : pdfDropZoneAt(e.target);
      over(null, null);
      if (ignored) return;
      const files = [...(e.dataTransfer?.files ?? [])];
      const pdf = files.find(isPdfFile);
      if (pdf && target) target.drop(pdf, { x: e.clientX, y: e.clientY });
      else if (pdf) void openFile(pdf);
      else if (files.length) showToast("error", t("drop.notPdf"));
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
      zone?.hover(null);
    };
  }, []);

  if (!active) return null;
  return (
    <div class={inserting ? "drop-overlay is-inserting" : "drop-overlay"} aria-hidden="true">
      <div class="drop-card">
        <Logo size={44} />
        <p class="drop-text">{inserting ? t("org.dropInsert") : t("drop.overlay")}</p>
      </div>
    </div>
  );
}
