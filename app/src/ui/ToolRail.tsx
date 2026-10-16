// Desktop tool rail (left, from 640 px, document open): the editing tools (Browse, Edit, Fill &
// sign) and the view toggles (thumbnails, details panel). Each button shows its icon with a short
// label under it ("Compila e firma" wraps to two lines); the tooltip says what it does. The tools
// are exclusive and always go through setTool, so text still typed in the line editor or a writer
// is written before leaving it. Browse stays on the rail (on phones no tool lit is browsing).
import type { ComponentChildren } from "preact";
import { t } from "../i18n";
import { editingStopped, tool } from "../state";
import { setTool } from "./actions";
import { IconDetails, IconEditText, IconPages, IconPointer, IconSign } from "./icons";
import { detailsPanelAvailable, detailsPanelOpen, pagesPanelOpen, toggleDetailsPanel, togglePagesPanel } from "./panels";

interface RailButtonProps {
  icon: ComponentChildren;
  label: string;
  tip: string;
  pressed: boolean;
  onClick: () => void;
  disabled?: boolean;
  controls?: string;
}

function RailButton(p: RailButtonProps) {
  return (
    <button
      type="button"
      class="btn rail-btn"
      title={p.tip}
      aria-pressed={p.pressed}
      aria-controls={p.controls}
      disabled={p.disabled}
      onClick={p.onClick}
    >
      {p.icon}
      <span class="rail-btn-label">{p.label}</span>
    </button>
  );
}

export function ToolRail() {
  const current = tool.value;
  const stopped = editingStopped.value;
  const pagesOpen = pagesPanelOpen.value;
  const detailsOpen = detailsPanelOpen.value;

  return (
    <nav class="rail" aria-label={t("tools.label")}>
      <div class="rail-group" role="group" aria-labelledby="rail-group-edit">
        <span class="section-label rail-label" id="rail-group-edit">{t("tools.groupEdit")}</span>
        <RailButton
          icon={<IconPointer />}
          label={t("tools.browse")}
          tip={t("tools.browseTip", { key: t("key.esc") })}
          pressed={current === null}
          onClick={() => void setTool(null)}
        />
        <RailButton
          icon={<IconEditText />}
          label={t("tools.editText")}
          tip={t("tools.editTextTip")}
          pressed={current === "edit"}
          disabled={stopped}
          onClick={() => void setTool("edit")}
        />
        <RailButton
          icon={<IconSign />}
          label={t("tools.fill")}
          tip={t("tools.fillTip")}
          pressed={current === "fill"}
          disabled={stopped}
          onClick={() => void setTool("fill")}
        />
      </div>
      <span class="rail-sep" aria-hidden="true" />
      <div class="rail-group" role="group" aria-labelledby="rail-group-view">
        <span class="section-label rail-label" id="rail-group-view">{t("tools.groupView")}</span>
        <RailButton
          icon={<IconPages />}
          label={t("tools.pages")}
          tip={t("tools.pagesTip")}
          pressed={pagesOpen}
          controls={pagesOpen ? "pages-panel" : undefined}
          onClick={togglePagesPanel}
        />
        {detailsPanelAvailable.value && (
          <RailButton
            icon={<IconDetails />}
            label={t("tools.details")}
            tip={t("tools.detailsTip")}
            pressed={detailsOpen}
            controls={detailsOpen ? "details-panel" : undefined}
            onClick={toggleDetailsPanel}
          />
        )}
      </div>
    </nav>
  );
}
