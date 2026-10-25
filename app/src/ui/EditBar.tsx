// The chrome of Modifica around the pages:
// - EditBanner, the bar above the pages in Modifica. On desktop, a first row with the tool's mark
//   and name, its sub-tools (Cambia, Aggiungi testo, Aggiungi immagine, Forme, Bianchetto, Oscura:
//   the toolbar Compila e firma's bar uses too, ui/SubTools.tsx, icons only when the bar is narrow:
//   styles/shell.css), "Metti al centro" with Aggiungi testo, Forme (but not with Penna),
//   Bianchetto and Oscura (an icon: a writer, a shape, or a box to white out or redact, in the
//   middle of what shows: the path for the keyboard and screen readers) and "Fine"; a second with
//   the hint for the sub-tool (with Forme, after the kind picker), and with Bianchetto and Oscura
//   the note that what goes is gone for good from the file downloaded. On phones: the hint,
//   "Metti al centro" and "Fine", and with Forme the kind picker on a row of its own (the note is
//   said in the waiting box's bar instead: viewer/RedactLayer.tsx); the sub-tools are in EditStrip.
// - EditStrip, the phone strip of sub-tools, right above the tab bar, as Compila e firma's: with
//   short labels (Testo, Immagine), so all six fit at 320 px (styles/phone.css).
// - ShapeKindPicker, Forme's kind picker (release 6): Linea, Freccia, Rettangolo, Ellisse, Penna,
//   Evidenzia, as a radio group bound to `shapeKind`; what the next drag or tap draws
//   (viewer/ShapeLayer.tsx draws it; ui/shapes/actions.ts puts one in the middle when "Metti al
//   centro" bumps `shapeCentreRequest`).
// Cambia (what Modifica does when it comes on: a tap opens a line to change it, or selects an
// image to move it), Aggiungi testo (a tap opens the text writer), Forme (draw shapes), Bianchetto
// and Oscura (mark an area, then apply it: viewer/RedactLayer.tsx) are toggles: setEditTool.
// Aggiungi immagine is an action: chooseNewPicture opens the picker from within the click (iOS
// opens pickers only then); the picture lands in the middle of what shows, selected.
// Styled by styles/shell.css (the banner's tools), styles/shapes.css (the kind picker, its block
// at the end) and styles/phone.css (the strip, the picker on phones).
import type { FunctionComponent, RefObject } from "preact";
import { useRef } from "preact/hooks";
import { t } from "../i18n";
import { editTool, shapeCentreRequest, shapeKind, type EditTool, type ShapeToolKind } from "../state";
import type { OpenDoc } from "../viewer/model";
import { chooseNewPicture, setEditTool, setShapeKind, setTool } from "./actions";
import {
  IconCheck, IconEditText, IconFont, IconImage, IconRedact, IconShapeArrow, IconShapeEllipse, IconShapeHighlight,
  IconShapeLine, IconShapePen, IconShapeRect, IconShapes, IconWhiteout,
} from "./icons";
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
      id: "shapes",
      Icon: IconShapes,
      label: t("edit.shapes"),
      tip: t("edit.shapesTip"),
      pressed: current === "shapes",
      onChoose: () => void setEditTool("shapes"),
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

/** Forme's kinds, in the picker's order, with their icons (the details panel lists them in this order too). */
export const SHAPE_TOOL_KINDS: readonly { kind: ShapeToolKind; Icon: FunctionComponent }[] = [
  { kind: "line", Icon: IconShapeLine },
  { kind: "arrow", Icon: IconShapeArrow },
  { kind: "rect", Icon: IconShapeRect },
  { kind: "ellipse", Icon: IconShapeEllipse },
  { kind: "pen", Icon: IconShapePen },
  { kind: "highlight", Icon: IconShapeHighlight },
];

/**
 * The banner's hint: what a tap on the page does with the sub-tool `current` (with Forme, with
 * the kind `kind`: the pen and the highlighter are drawn their own way).
 */
export function editHint(current: EditTool, touch: boolean, kind: ShapeToolKind = shapeKind.value): string {
  if (current === "addText") return t(touch ? "edit.hintAddTextTouch" : "edit.hintAddText");
  if (current === "whiteout") return t(touch ? "edit.hintWhiteoutTouch" : "edit.hintWhiteout");
  if (current === "redact") return t(touch ? "edit.hintRedactTouch" : "edit.hintRedact");
  if (current === "shapes" && kind === "pen") return t(touch ? "edit.hintPenTouch" : "edit.hintPen");
  if (current === "shapes" && kind === "highlight") return t(touch ? "edit.hintHighlightTouch" : "edit.hintHighlight");
  if (current === "shapes") return t(touch ? "edit.hintShapesTouch" : "edit.hintShapes");
  return t(touch ? "edit.hintTouch" : "edit.hint");
}

/** Forme's "Metti al centro": ui/shapes/actions.ts puts a shape of the current kind on the current page (placeShapeAtCentre). */
function askShapeAtCentre() {
  shapeCentreRequest.value++;
}

/**
 * Forme's kind picker: a radio group with one Tab stop, on the chosen kind; the arrow keys (Home,
 * End) move the choice, as radio buttons do. Each kind is its icon, named by aria-label and its
 * tooltip, with its name beside it where the banner has room (styles/shapes.css). Choosing a kind
 * deselects the selected shape (setShapeKind).
 */
export function ShapeKindPicker() {
  const ref = useRef<HTMLDivElement>(null);
  const current = shapeKind.value;

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>(".shape-kind") ?? [])];
    // From the focused one, not the signal: keys pressed faster than a render still step one by one.
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const i = at >= 0 ? at : SHAPE_TOOL_KINDS.findIndex((x) => x.kind === current);
    const n = SHAPE_TOOL_KINDS.length;
    let next = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (i + 1) % n;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (i - 1 + n) % n;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    if (next < 0) return;
    e.preventDefault();
    void setShapeKind(SHAPE_TOOL_KINDS[next].kind);
    buttons[next]?.focus();
  };

  return (
    <div ref={ref} class="shape-kinds" role="radiogroup" aria-label={t("edit.shapeKinds")} onKeyDown={onKeyDown}>
      {SHAPE_TOOL_KINDS.map(({ kind, Icon }) => {
        const name = t(`edit.shapeKind.${kind}`);
        const checked = kind === current;
        return (
          <button
            key={kind}
            type="button"
            role="radio"
            class="btn shape-kind"
            aria-checked={checked}
            aria-label={name}
            title={name}
            tabIndex={checked ? 0 : -1}
            onClick={() => void setShapeKind(kind)}
          >
            <Icon />
            <span class="shape-kind-label" aria-hidden="true">{name}</span>
          </button>
        );
      })}
    </div>
  );
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
  const shapes = current === "shapes";
  // Penna has nothing to put in the middle: a stroke is drawn by hand.
  const shapeCentre = shapes && shapeKind.value !== "pen";

  // A status: the hint changes with the sub-tool (and Forme's kind), and that is said. On phones
  // the banner keeps to it (the bars round the page take room enough): the waiting box's bar says
  // the note instead. On desktop Forme's picker leads the hint's row.
  const info = (
    <div class="tool-banner-info">
      {shapes && !narrow && <ShapeKindPicker />}
      <p class="edit-banner-text" role="status">{editHint(current, touch)}</p>
      {area && !narrow && <p class="fill-banner-note">{t("edit.redactNote")}</p>}
    </div>
  );

  // Desktop: the tools and the buttons on the first row, so they never move; the hint on the
  // second. Phones: the hint first, the buttons beside it, Forme's picker on a row of its own
  // under them. The DOM follows what is seen (Tab order).
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
        {shapeCentre && (
          <PlaceCentreButton onClick={askShapeAtCentre} tip={t(touch ? "edit.shapeCentreTipTouch" : "edit.shapeCentreTip")} />
        )}
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
      {shapes && narrow && <ShapeKindPicker />}
    </div>
  );
}
