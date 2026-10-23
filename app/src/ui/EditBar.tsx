// The chrome of Modifica around the pages:
// - EditBanner, the bar above the pages in Modifica. On desktop, a first row with the tool's mark
//   and name, its sub-tools (Cambia, Aggiungi testo, Aggiungi immagine, Bianchetto, Oscura: the
//   toolbar Compila e firma's bar uses too, ui/SubTools.tsx, icons only when the bar is narrow, at
//   the same width as Compila e firma's: styles/redact.css), "Metti al centro" with Aggiungi testo,
//   Bianchetto and Oscura (an icon: a writer, or a box to white out or redact, in the middle of
//   what shows: the path for the keyboard and screen readers) and "Fine"; a second with the hint
//   for the sub-tool, and with Bianchetto and Oscura the note that what goes is gone for good from
//   the file downloaded. On phones: the hint, "Metti al centro" and "Fine" (the note is said in
//   the waiting box's bar instead: viewer/RedactLayer.tsx); the sub-tools are in EditStrip.
// - EditStrip, the phone strip of sub-tools, right above the tab bar, as Compila e firma's: with
//   short labels (Testo, Immagine), so all five fit at 320 px.
// Cambia (what Modifica does when it comes on: a tap opens a line to change it, or selects an
// image to move it), Aggiungi testo (a tap opens the text writer), Bianchetto and Oscura (mark an
// area, then apply it: viewer/RedactLayer.tsx) are toggles: setEditTool. Aggiungi immagine is an
// action: chooseNewPicture opens the picker from within the click (iOS opens pickers only then);
// the picture lands in the middle of what shows, selected.
// Styled by styles/shell.css (the banner's tools) and styles/phone.css (the strip).
import type { RefObject } from "preact";
import { t } from "../i18n";
import { editTool, type EditTool } from "../state";
import type { OpenDoc } from "../viewer/model";
import { chooseNewPicture, setEditTool, setTool } from "./actions";
import { IconCheck, IconEditText, IconFont, IconImage, IconRedact, IconWhiteout } from "./icons";
import { isCoarse, isNarrow } from "./media";
import { placeAreaAtCentre } from "./redact/pending";
import { PlaceCentreButton, SubTools, ToolStrip, type SubToolItem } from "./SubTools";

/**
 * Modifica's sub-tools as its toolbar shows them, `current` lit (Aggiungi immagine never is);
 * `short`: the phone strip's short labels (the tooltips stay whole).
 */
export function editToolItems(current: EditTool, touch: boolean, short = false): SubToolItem[] {
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
      label: t(short ? "edit.addTextShort" : "edit.addText"),
      tip: t(touch ? "edit.addTextTipTouch" : "edit.addTextTip"),
      pressed: current === "addText",
      onChoose: () => void setEditTool("addText"),
    },
    {
      id: "addImage",
      Icon: IconImage,
      label: t(short ? "edit.addImageShort" : "edit.addImage"),
      tip: t("edit.addImageTip"),
      onChoose: chooseNewPicture,
    },
    {
      id: "whiteout",
      Icon: IconWhiteout,
      label: t("edit.whiteout"),
      tip: t("edit.whiteoutTip"),
      pressed: current === "whiteout",
      onChoose: () => void setEditTool("whiteout"),
    },
    {
      id: "redact",
      Icon: IconRedact,
      label: t("edit.redact"),
      tip: t("edit.redactTip"),
      pressed: current === "redact",
      onChoose: () => void setEditTool("redact"),
    },
  ];
}

/** The banner's hint: what a tap on the page does with the sub-tool `current`. */
export function editHint(current: EditTool, touch: boolean): string {
  if (current === "addText") return t(touch ? "edit.hintAddTextTouch" : "edit.hintAddText");
  if (current === "whiteout") return t(touch ? "edit.hintWhiteoutTouch" : "edit.hintWhiteout");
  if (current === "redact") return t(touch ? "edit.hintRedactTouch" : "edit.hintRedact");
  return t(touch ? "edit.hintTouch" : "edit.hint");
}

/** Phones: the sub-tools in a strip right above the tab bar (Viewer decides when it shows). */
export function EditStrip() {
  return <ToolStrip label={t("edit.toolbar")} items={editToolItems(editTool.value, isCoarse.value, true)} />;
}

/** Modifica's bar above the pages (Viewer.tsx mounts it as the banner of this mode). */
export function EditBanner({ elRef }: { doc: OpenDoc; elRef: RefObject<HTMLDivElement> }) {
  const narrow = isNarrow.value;
  const touch = isCoarse.value;
  const current = editTool.value;
  const area = current === "whiteout" || current === "redact";

  // A status: the hint changes with the sub-tool, and that is said. On phones the banner keeps to
  // it (the bars round the page take room enough): the waiting box's bar says the note instead.
  const info = (
    <div class="tool-banner-info">
      <p class="edit-banner-text" role="status">{editHint(current, touch)}</p>
      {area && !narrow && <p class="fill-banner-note">{t("edit.redactNote")}</p>}
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
        {area && <PlaceCentreButton onClick={placeAreaAtCentre} />}
        {/* Esc leaves Modifica from Cambia (after closing what is open); from the other sub-tools
            it goes back to Cambia first, so the tooltip names no key there. */}
        <button
          type="button"
          class="btn btn-secondary edit-banner-done"
          title={current !== "change" ? t("edit.doneTipNoKey") : t("edit.doneTip", { key: t("key.esc") })}
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
