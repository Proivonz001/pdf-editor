// The scan flow's tray (ui/scan/ScanFlow.tsx): the pages made so far, in order, each with its
// preview and four buttons: move up, move down, retake (a new photo that takes its place once it
// is made) and delete. No question before a delete: a page is quick to take again, and nothing
// leaves the device. Styled by styles/scan.css (.scan-tray, .scan-page).
//
// The buttons keep the focus where it was: a move up or down re-orders the rows (Preact moves the
// row, which drops the focus in some browsers), so the same button of the page that moved gets it
// back; at the top (or the bottom) that button is aria-disabled, not disabled, so it can keep it.
// After a delete, the focus goes to the same button of the page that took its place, else of the
// one before; the last page gone, the flow's next step takes it (ScanFlow).
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../../i18n";
import { IconArrowDown, IconArrowUp, IconPageScan, IconTrash } from "../icons";
import { movePage, removePage, type TrayPage } from "./flow";

type Act = "up" | "down" | "retake" | "delete";

/** The page's preview, from its JPEG bytes (an object URL, revoked when it goes). */
function Preview({ page }: { page: TrayPage }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!page.preview.byteLength) return;
    const u = URL.createObjectURL(new Blob([page.preview], { type: "image/jpeg" }));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [page.preview]);
  const ratio = page.picture.width / page.picture.height;
  return (
    <span class="scan-thumb" style={{ "--ar": Number.isFinite(ratio) && ratio > 0 ? ratio.toFixed(4) : "0.7071" }} aria-hidden="true">
      {url && <img src={url} alt="" draggable={false} />}
    </span>
  );
}

export function Tray(p: {
  pages: readonly TrayPage[];
  /** Fine is running, or "Più tardi" waits for the device: nothing changes. */
  busy: boolean;
  /** Rifai on page `id`: the flow opens the camera (or the picker) for its new photo. */
  onRetake: (id: number) => void;
}) {
  const list = useRef<HTMLOListElement>(null);

  /** After a change of the rows: the focus to `act` of page `id`, else to its other move button. */
  const focusLater = (id: number, act: Act) => {
    requestAnimationFrame(() => {
      const el = list.current;
      if (!el) return; // the last page went: the flow's next step has the focus
      const button = (a: Act) => el.querySelector<HTMLElement>(`[data-page="${id}"][data-act="${a}"]`);
      const first = button(act);
      const target = first?.getAttribute("aria-disabled") === "true" ? button(act === "up" ? "down" : "up") ?? first : first;
      target?.focus({ preventScroll: false });
    });
  };

  const run = (page: TrayPage, act: Act, index: number) => {
    if (p.busy) return;
    if (act === "retake") {
      p.onRetake(page.id);
      return;
    }
    if (act === "delete") {
      const rest = p.pages.filter((x) => x.id !== page.id);
      const next = rest[Math.min(index, rest.length - 1)] ?? null;
      removePage(page.id);
      if (next) focusLater(next.id, "delete");
      return;
    }
    if (movePage(page.id, act === "up" ? -1 : 1)) focusLater(page.id, act);
  };

  const count = p.pages.length;
  return (
    <ol ref={list} class="scan-tray">
      {p.pages.map((page, i) => {
        const n = i + 1;
        const button = (act: Act, label: string, icon: ComponentChildren, off = false) => (
          <button
            type="button"
            class={act === "delete" ? "btn tool scan-page-btn is-danger" : "btn tool scan-page-btn"}
            data-page={page.id}
            data-act={act}
            aria-label={label}
            title={label}
            aria-disabled={off || p.busy ? "true" : undefined}
            onClick={() => {
              if (!off) run(page, act, i);
            }}
          >
            {icon}
          </button>
        );
        return (
          <li key={page.id} class="scan-page">
            <Preview page={page} />
            <span class="scan-page-name">{t("scan.pageN", { n })}</span>
            <span class="scan-page-actions">
              {button("up", t("scan.moveUp", { n }), <IconArrowUp />, i === 0)}
              {button("down", t("scan.moveDown", { n }), <IconArrowDown />, i === count - 1)}
              {button("retake", t("scan.retake", { n }), <IconPageScan />)}
              {button("delete", t("scan.delete", { n }), <IconTrash />)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
