// Which side panels are open in the desktop layout: the page thumbnails (left) and the details
// (right). Both are docked in their own grid column, so the page area gets narrower when one
// opens. Each follows the window width until the user toggles it (thumbnails open by default from
// 1024 px, details from 1200 px; closed by default below), and that one choice is remembered on
// this device and holds at every desktop width. On phones neither is shown: the thumbnails open in
// a sheet from the tab bar, the details in a sheet from the More sheet (PhoneSheets).
import { computed, signal } from "@preact/signals";
import { isNarrow, isRoomy, isWide } from "./media";

const STORAGE_KEY = "pdf-editor.panels";

interface Saved {
  pages?: boolean;
  details?: boolean;
}

function load(): Saved {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return v && typeof v === "object" ? (v as Saved) : {};
  } catch {
    return {}; // storage blocked or garbled: defaults
  }
}

const saved = load();
const pagesPref = signal<boolean | undefined>(typeof saved.pages === "boolean" ? saved.pages : undefined);
const detailsPref = signal<boolean | undefined>(typeof saved.details === "boolean" ? saved.details : undefined);

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ pages: pagesPref.peek(), details: detailsPref.peek() }));
  } catch {
    // Not remembered: it still applies to this visit.
  }
}

/** The thumbnails panel is shown: never on phones, by default from 1024 px. */
export const pagesPanelOpen = computed(() => !isNarrow.value && (pagesPref.value ?? isRoomy.value));

/** The details panel is shown, docked: never on phones, by default from 1200 px. */
export const detailsPanelOpen = computed(() => !isNarrow.value && (detailsPref.value ?? isWide.value));

export function togglePagesPanel() {
  pagesPref.value = !pagesPanelOpen.peek();
  save();
}

/** The rail's Details button. Nothing on phones (the sheet is opened from the More sheet). */
export function toggleDetailsPanel() {
  if (isNarrow.peek()) return;
  detailsPref.value = !detailsPanelOpen.peek();
  save();
}
