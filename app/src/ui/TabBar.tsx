// Phone tab bar (below 640 px, with a document): Edit, Fill & sign, Pages and More, each an icon
// in a pill over a short label (D1, D12). Edit and Fill & sign are the tools: exclusive toggles,
// and tapping the lit one turns it off, which is browsing (there is no Browse tab on phones). They
// go through setTool, which first writes what the line editor or a writer holds. Fill & sign has a
// wider column so its whole label fits; where it still does not (a narrow font, large text), the
// short "Compila" takes its place (a container query, phone.css). Pages and More open their bottom
// sheet (PhoneSheets), focusing their own button first: WebKit does not focus a tapped button, and
// the sheet gives the focus back to whatever had it when it opened.
// Not shown while a line editor or a writer is open or a form field takes typing, so the
// keyboard and the page get the room (a ticked box or a list keeps it: bottomBarsHidden). Styled
// by styles/phone.css (.tabbar).
import type { ComponentChildren } from "preact";
import { t } from "../i18n";
import { updateReady } from "../platform/pwa";
import { editingLine, editingStopped, openWriter, sheet, tool, typingField, type SheetKind, type Tool } from "../state";
import { setTool } from "./actions";
import { IconEditText, IconMore, IconPages, IconSign } from "./icons";

/**
 * The bars at the bottom of a phone (the tab bar, the Fill & sign strip, the page indicator) make
 * room for the on-screen keyboard: a line editor or a writer is open, or a form control that
 * brings up the keyboard (a text field, a text area) holds the focus. That last one is
 * `typingField`, which the form layer sets from each control's own focus and blur, so it follows
 * the control that really has the focus, however it got there (a tap, Tab, the keyboard's
 * "next", "Next empty field"). Check boxes, radio buttons, lists and "Sign here" raise no
 * keyboard, though Android keeps the focus on them after a tap: then the bars stay. Reactive.
 */
export function bottomBarsHidden(): boolean {
  return editingLine.value !== null || openWriter.value !== null || typingField.value;
}

interface TabProps {
  icon: ComponentChildren;
  label: string;
  /** A shorter label, shown instead when the tab is too narrow for `label`. */
  short?: string;
  /** Tooltip; defaults to the label (with a badge: the label and the badge). */
  tip?: string;
  onClick: (e: MouseEvent) => void;
  /** Edit / Fill & sign: whether this tool is on. */
  pressed?: boolean;
  disabled?: boolean;
  /** Opens a sheet: whether it is open (and aria-haspopup="dialog"). */
  expanded?: boolean;
  /** What a small dot on the icon stands for; it joins the accessible name and the tooltip. */
  badge?: string;
  class?: string;
}

/** Open a sheet from its tab, so that the sheet's focus restore lands back on that tab. */
function openSheet(e: MouseEvent, kind: SheetKind) {
  if (e.currentTarget instanceof HTMLElement) e.currentTarget.focus({ preventScroll: true });
  sheet.value = kind;
}

/** The tool after tapping the tab of `pressed`: it toggles, so tapping the lit one turns it off. */
export function toolAfterTap(current: Tool, pressed: Exclude<Tool, null>): Tool {
  return current === pressed ? null : pressed;
}

function Tab(p: TabProps) {
  // With a badge, the name says what it stands for. The tooltip is the same text, so screen
  // readers do not read it a second time as a description.
  const named = p.badge ? `${p.label}, ${p.badge}` : undefined;
  return (
    <button
      type="button"
      class={p.class ? `tab ${p.class}` : "tab"}
      title={named ?? p.tip ?? p.label}
      aria-label={named}
      aria-pressed={p.pressed}
      aria-haspopup={p.expanded === undefined ? undefined : "dialog"}
      aria-expanded={p.expanded}
      disabled={p.disabled}
      onClick={p.onClick}
    >
      <span class="tab-pill" aria-hidden="true">
        {p.icon}
        {p.badge && <span class="badge" />}
      </span>
      {/* Only one of the two shows (phone.css): the accessible name is the visible one. */}
      <span class={p.short ? "tab-label tab-label-full" : "tab-label"}>{p.label}</span>
      {p.short && <span class="tab-label tab-label-short">{p.short}</span>}
    </button>
  );
}

export function TabBar() {
  if (bottomBarsHidden()) return null;
  const current = tool.value;
  const stopped = editingStopped.value;
  const open = sheet.value;
  return (
    <nav class="tabbar" aria-label={t("tools.label")}>
      <Tab
        icon={<IconEditText />}
        label={t("tools.editShort")}
        tip={t("tools.editTextTip")}
        pressed={current === "edit"}
        disabled={stopped}
        onClick={() => void setTool(toolAfterTap(tool.peek(), "edit"))}
      />
      <Tab
        icon={<IconSign />}
        label={t("tools.fill")}
        short={t("tools.fillShort")}
        tip={t("tools.fillTip")}
        pressed={current === "fill"}
        disabled={stopped}
        class="tab-fill"
        onClick={() => void setTool(toolAfterTap(tool.peek(), "fill"))}
      />
      <Tab
        icon={<IconPages />}
        label={t("tools.pages")}
        expanded={open === "pages"}
        onClick={(e) => openSheet(e, "pages")}
      />
      <Tab
        icon={<IconMore />}
        label={t("tools.more")}
        expanded={open === "more"}
        badge={updateReady.value ? t("toolbar.update") : undefined}
        onClick={(e) => openSheet(e, "more")}
      />
    </nav>
  );
}
