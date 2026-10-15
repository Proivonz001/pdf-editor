// Phone tab bar (below 640 px, with a document): Browse, Edit, Pages and More, each an icon in a
// pill over a short label. Browse and Edit switch edit mode through setEditMode (which first
// writes what the line editor holds); Pages and More open their bottom sheet (PhoneSheets),
// focusing their own button first: WebKit does not focus a tapped button, and the sheet gives the
// focus back to whatever had it when it opened.
// Not shown while a line editor is open, so the keyboard and the page get the room.
// Styled by styles/phone.css (.tabbar).
import type { ComponentChildren } from "preact";
import { t } from "../i18n";
import { updateReady } from "../platform/pwa";
import { editingLine, editingStopped, editMode, sheet, type SheetKind } from "../state";
import { setEditMode } from "./actions";
import { IconEditText, IconMore, IconPages, IconPointer } from "./icons";

interface TabProps {
  icon: ComponentChildren;
  label: string;
  /** Tooltip; defaults to the label (with a badge: the label and the badge). */
  tip?: string;
  onClick: (e: MouseEvent) => void;
  /** Browse / Edit: whether this mode is on. */
  pressed?: boolean;
  disabled?: boolean;
  /** Opens a sheet: whether it is open (and aria-haspopup="dialog"). */
  expanded?: boolean;
  /** What a small dot on the icon stands for; it joins the accessible name and the tooltip. */
  badge?: string;
}

/** Open a sheet from its tab, so that the sheet's focus restore lands back on that tab. */
function openSheet(e: MouseEvent, kind: SheetKind) {
  if (e.currentTarget instanceof HTMLElement) e.currentTarget.focus({ preventScroll: true });
  sheet.value = kind;
}

function Tab(p: TabProps) {
  // With a badge, the name says what it stands for. The tooltip is the same text, so screen
  // readers do not read it a second time as a description.
  const named = p.badge ? `${p.label}, ${p.badge}` : undefined;
  return (
    <button
      type="button"
      class="tab"
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
      <span class="tab-label">{p.label}</span>
    </button>
  );
}

export function TabBar() {
  if (editingLine.value !== null) return null;
  const editing = editMode.value;
  const open = sheet.value;
  return (
    <nav class="tabbar" aria-label={t("tools.label")}>
      <Tab
        icon={<IconPointer />}
        label={t("tools.browse")}
        tip={t("tools.browseTip", { key: t("key.esc") })}
        pressed={!editing}
        onClick={() => void setEditMode(false)}
      />
      <Tab
        icon={<IconEditText />}
        label={t("tools.editShort")}
        tip={t("tools.editTextTip")}
        pressed={editing}
        disabled={editingStopped.value}
        onClick={() => void setEditMode(true)}
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
