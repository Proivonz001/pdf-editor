// The whole window is a drop target for PDF files. Only drags that carry files are taken over:
// dragging text (e.g. inside the line editor) keeps working as usual.
import { useEffect, useState } from "preact/hooks";
import { t } from "../i18n";
import { dialog, showToast } from "../state";
import { isPdfFile, openFile } from "./actions";

function carriesFiles(e: DragEvent) {
  return !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");
}

export function DropOverlay() {
  const [active, setActive] = useState(false);

  useEffect(() => {
    let depth = 0; // dragenter/dragleave fire for every child element crossed
    const onEnter = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      depth++;
      setActive(true);
    };
    const onOver = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault(); // allow the drop
      if (e.dataTransfer) e.dataTransfer.dropEffect = dialog.peek() ? "none" : "copy";
    };
    const onLeave = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setActive(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault(); // never let the browser navigate to the file
      depth = 0;
      setActive(false);
      if (dialog.peek()) return;
      const files = [...(e.dataTransfer?.files ?? [])];
      const pdf = files.find(isPdfFile);
      if (pdf) void openFile(pdf);
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
    };
  }, []);

  if (!active) return null;
  return (
    <div class="drop-overlay" aria-hidden="true">
      <div class="drop-card">{t("drop.overlay")}</div>
    </div>
  );
}
