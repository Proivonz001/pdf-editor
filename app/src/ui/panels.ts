// Which side panels are open on desktop: the page thumbnails (left) and the details (right).
// Each follows the window width until the user toggles it; that choice is remembered on this
// device. On phones neither is shown: thumbnails open in a sheet from the tab bar instead.
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

/** The details panel can be shown (from 1200 px). */
export const detailsPanelAvailable = isWide;

/** The details panel is shown: from 1200 px, open by default. */
export const detailsPanelOpen = computed(() => isWide.value && (detailsPref.value ?? true));

export function togglePagesPanel() {
  pagesPref.value = !pagesPanelOpen.peek();
  save();
}

export function toggleDetailsPanel() {
  detailsPref.value = !detailsPanelOpen.peek();
  save();
}
