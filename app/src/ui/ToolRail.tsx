// Desktop tool rail (left, from 640 px, document open): the editing tools (Browse, Edit text)
// and the view toggles (thumbnails, details panel). Each button shows its icon with a short
// label under it; the tooltip says what it does. Edit mode always goes through setEditMode,
// so text still typed in the line editor is written before leaving it.
import type { ComponentChildren } from "preact";
import { t } from "../i18n";
import { editingStopped, editMode } from "../state";
import { setEditMode } from "./actions";
import { IconDetails, IconEditText, IconPages, IconPointer } from "./icons";
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
  const editing = editMode.value;
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
          pressed={!editing}
          onClick={() => void setEditMode(false)}
        />
        <RailButton
          icon={<IconEditText />}
          label={t("tools.editText")}
          tip={t("tools.editTextTip")}
          pressed={editing}
          disabled={editingStopped.value}
          onClick={() => void setEditMode(true)}
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
