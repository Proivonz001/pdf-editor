// The area waiting in Bianchetto or Oscura (Modifica's sub-tools "whiteout" and "redact"): the
// box the user marked on a page (a drag, a tap, a line, "Metti al centro") and can still move or
// resize, until Sbianca or Oscura in its context bar writes it as one edit (ui/redact/actions.ts,
// redactNow) or Annulla, Esc or a tap away drops it (viewer/RedactLayer.tsx). One at a time, on
// one page. Nothing is written while it waits, and it is not an open editor: it never registers
// with registerEditor, so a download, an undo or a change of tool (flushEditor) can never apply a
// redaction the user has not pressed; they drop it instead.
// It goes by itself when the tool, Modifica's sub-tool or the document changes (the effects
// below; "Usa Oscura" carries it from Bianchetto to Oscura on purpose) and when its page changes
// (its own edit, an edit, undo or redo of that page, or a page operation moving or removing it:
// the page's revision is no longer the one it was marked at).
import { computed, effect, signal } from "@preact/signals";
import type { Rect, RedactMode } from "../../engine/protocol";
import { currentPage, doc, editingStopped, editTool, tool } from "../../state";
import type { Point } from "../../viewer/imageGeometry";
import type { PageModel } from "../../viewer/model";
import { setEditTool, visiblePart } from "../actions";
import { defaultBox } from "./geometry";

export interface PendingRedact {
  /** Unique per area marked (moving or resizing it keeps it): what its box is keyed by. */
  id: number;
  /** The document (OpenDoc.id) and the page it was marked on, and the page's revision then. */
  docId: number;
  page: PageModel;
  rev: number;
  /** The area as the box shows it, page space. */
  rect: Rect;
  /**
   * What is sent and previewed: [rect], or a line's pieces (areasForQuads: a turned line's are
   * thin ones along it, keeping off the lines beside it), whose bounds `rect` is, until the box is
   * moved or resized: then the plain rectangle it shows.
   */
  rects: Rect[];
  /** The line (LineInfo.index) whose box it is, or null: the focus goes back to that line's box when it is dropped. */
  line: number | null;
  /** It takes the keyboard focus when it shows (made from the keyboard or with the mouse, or moved there). */
  focus: boolean;
}

export const pendingRedact = signal<PendingRedact | null>(null);

/** Modifica is on with Bianchetto ("whiteout") or Oscura ("redact"): that mode, else null. */
export const redactMode = computed<RedactMode | null>(() => {
  if (tool.value !== "edit" || editingStopped.value) return null;
  const sub = editTool.value;
  return sub === "whiteout" || sub === "redact" ? sub : null;
});

// The tool, the sub-tool or the document changed: the waiting area goes (it was for them).
let context = "";
effect(() => {
  const now = `${doc.value?.id ?? 0}|${tool.value ?? ""}|${editTool.value}`;
  if (now === context) return;
  context = now;
  if (pendingRedact.peek()) pendingRedact.value = null;
});

// Its page changed (applyLayout bumps the revision of a page that moved or went too).
effect(() => {
  const box = pendingRedact.value;
  if (box && box.page.rev.value !== box.rev) pendingRedact.value = null;
});

let nextId = 1;

/** Mark `rect` on `page` as the waiting area (in place of any other); `rects`: what goes, within it (a line's pieces). */
export function markArea(
  page: PageModel, rect: Rect, opts: { line?: number | null; focus?: boolean; rects?: Rect[] } = {},
): void {
  const d = doc.peek();
  if (!d || redactMode.peek() === null || d.pages[page.index] !== page) return;
  pendingRedact.value = {
    id: nextId++, docId: d.id, page, rev: page.rev.peek(), rect, rects: opts.rects ?? [rect],
    line: opts.line ?? null, focus: opts.focus ?? false,
  };
}

/** The waiting area, moved or resized to `rect`, which is now all it takes (nothing is written). */
export function moveArea(box: PendingRedact, rect: Rect): void {
  if (pendingRedact.peek() !== box) return;
  pendingRedact.value = { ...box, rect, rects: [rect], focus: false };
}

/** Drop the waiting area, if there is one; true when there was. */
export function cancelPendingRedact(): boolean {
  if (!pendingRedact.peek()) return false;
  pendingRedact.value = null;
  return true;
}

/**
 * "Metti al centro" in Bianchetto and Oscura: a default box in the middle of what shows of the
 * current page, taking the keyboard focus (the way for the keyboard, screen readers and switch
 * access, on phones too).
 */
export function placeAreaAtCentre(): void {
  const d = doc.peek();
  if (!d || !d.pages.length || redactMode.peek() === null) return;
  const pageIndex = Math.min(Math.max(0, currentPage.peek()), d.pages.length - 1);
  const page = d.pages[pageIndex];
  const view = visiblePart(pageIndex);
  const centre: Point = [(view[0] + view[2]) / 2, (view[1] + view[3]) / 2];
  markArea(page, defaultBox(centre, page.bounds), { focus: true });
}

/**
 * "Usa Oscura", from Bianchetto's note over a picture: Modifica goes on to Oscura with the same
 * area waiting (and the focus on it), so the picture under it is really cleared.
 */
export async function useRedactInstead(): Promise<void> {
  const box = pendingRedact.peek();
  await setEditTool("redact");
  if (!box || redactMode.peek() !== "redact" || doc.peek()?.id !== box.docId) return;
  if (box.page.rev.peek() !== box.rev || pendingRedact.peek()) return;
  pendingRedact.value = { ...box, focus: true };
}
