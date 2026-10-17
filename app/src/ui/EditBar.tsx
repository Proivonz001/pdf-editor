// The chrome of Modifica around the pages:
// - EditBanner, the bar above the pages in Modifica. On desktop, a first row with the tool's mark
//   and name, its sub-tools (Cambia, Aggiungi testo, Aggiungi immagine: the toolbar Compila e
//   firma's bar uses too, ui/SubTools.tsx, icons only when the bar is narrow), "Metti al centro"
//   with Aggiungi testo (an icon: a writer in the middle of what shows, the path for the keyboard
//   and screen readers) and "Fine"; a second with the hint for the sub-tool. On phones: the hint,
//   "Metti al centro" with Aggiungi testo and "Fine"; the sub-tools are in EditStrip.
// - EditStrip, the phone strip of sub-tools, right above the tab bar, as Compila e firma's.
// Cambia (what Modifica does when it comes on: a tap opens a line to change it, or selects an
// image to move it) and Aggiungi testo (a tap opens the text writer) are toggles: setEditTool.
// Aggiungi immagine is an action: chooseNewPicture opens the picker from within the click (iOS
// opens pickers only then); the picture lands in the middle of what shows, selected.
// Styled by styles/shell.css (the banner's tools) and styles/phone.css (the strip).
import type { RefObject } from "preact";
import { t } from "../i18n";
import { editTool, type EditTool } from "../state";
import type { OpenDoc } from "../viewer/model";
import { chooseNewPicture, setEditTool, setTool } from "./actions";
import { IconCheck, IconEditText, IconFont, IconImage } from "./icons";
import { isCoarse, isNarrow } from "./media";
import { PlaceCentreButton, SubTools, ToolStrip, type SubToolItem } from "./SubTools";

/** Modifica's sub-tools as its toolbar shows them, `current` lit (Aggiungi immagine never is). */
export function editToolItems(current: EditTool, touch: boolean): SubToolItem[] {
  return [
    {
      id: "change",
      Icon: IconEditText,
      label: t("edit.change"),
      tip: t("edit.changeTip"),
      pressed: current === "change",
      onChoose: () => void setEditTool("change"),
    },
    {
      id: "addText",
      Icon: IconFont,
      label: t("edit.addText"),
      tip: t(touch ? "edit.addTextTipTouch" : "edit.addTextTip"),
      pressed: current === "addText",
      onChoose: () => void setEditTool("addText"),
    },
    { id: "addImage", Icon: IconImage, label: t("edit.addImage"), tip: t("edit.addImageTip"), onChoose: chooseNewPicture },
  ];
}

/** The banner's hint: what a tap on the page does with the sub-tool `current`. */
export function editHint(current: EditTool, touch: boolean): string {
  if (current === "addText") return t(touch ? "edit.hintAddTextTouch" : "edit.hintAddText");
  return t(touch ? "edit.hintTouch" : "edit.hint");
}

/** Phones: the sub-tools in a strip right above the tab bar (Viewer decides when it shows). */
export function EditStrip() {
  return <ToolStrip label={t("edit.toolbar")} items={editToolItems(editTool.value, isCoarse.value)} />;
}

/** Modifica's bar above the pages (Viewer.tsx mounts it as the banner of this mode). */
export function EditBanner({ elRef }: { doc: OpenDoc; elRef: RefObject<HTMLDivElement> }) {
  const narrow = isNarrow.value;
  const touch = isCoarse.value;
  const current = editTool.value;

  // A status: the hint changes with the sub-tool, and that is said.
  const info = (
    <div class="tool-banner-info">
      <p class="edit-banner-text" role="status">{editHint(current, touch)}</p>
    </div>
  );

  // Desktop: the tools and the buttons on the first row, so they never move; the hint on the
  // second. Phones: the hint first, the buttons beside it. The DOM follows what is seen (Tab order).
  return (
    <div ref={elRef} class={narrow ? "edit-banner is-tools is-edit is-compact" : "edit-banner is-tools is-edit"}>
      {narrow ? (
        <span class="edit-banner-mark" aria-hidden="true" />
      ) : (
        <div class="tool-banner-lead">
          <span class="edit-banner-mark" aria-hidden="true" />
          <span class="tool-banner-title">{t("tools.editText")}</span>
          <SubTools variant="banner" label={t("edit.toolbar")} items={editToolItems(current, touch)} />
        </div>
      )}
      {narrow && info}
      <div class="tool-banner-actions">
        {current === "addText" && <PlaceCentreButton />}
        {/* Esc leaves Modifica from Cambia (after closing what is open); from Aggiungi testo it
            goes back to Cambia first, so the tooltip names no key there. */}
        <button
          type="button"
          class="btn btn-secondary edit-banner-done"
          title={current === "addText" ? t("edit.doneTipNoKey") : t("edit.doneTip", { key: t("key.esc") })}
          onClick={() => void setTool(null)}
        >
          <IconCheck />
          <span>{t("edit.done")}</span>
        </button>
      </div>
      {!narrow && info}
    </div>
  );
}
