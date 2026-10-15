// Desktop pages panel (left, next to the tool rail): a header with the page count, then the page
// thumbnails in one column filling the rest. app.tsx mounts it while pagesPanelOpen; the rail's
// Pages button points at it through aria-controls, hence the fixed id.
import { pageCount, t } from "../i18n";
import type { OpenDoc } from "../viewer/model";
import { PageThumbnails } from "../viewer/Thumbnails";

export function PagesPanel({ doc }: { doc: OpenDoc }) {
  return (
    <aside class="pages-panel" id="pages-panel" aria-label={t("pages.title")}>
      <header class="pages-head">
        <h2 class="section-label">{t("pages.title")}</h2>
        <span class="pages-count">{pageCount(doc.pages.length)}</span>
      </header>
      <PageThumbnails doc={doc} variant="list" />
    </aside>
  );
}
