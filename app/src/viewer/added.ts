// Texts the app wrote on a page (addText: words, ticks, crosses, dates), read from the engine on
// demand (fill mode, page near the viewport) and cached in page.added until the page changes
// (invalidatePages() drops the cache), like the lines in lines.ts. The fill layer draws a box over
// each one, so a tap reopens it in the text writer; their ids are stable across edits, undo and
// redo (AddedText.id), so a box read before an edit still names the same text after it.
//
// Also, for what the user added: the words screen readers say for a picture they placed (a
// signature's description), and the app's requests to move the keyboard focus onto something
// just placed or written (focusRequest), which the page's layers take once it is there.
import type { ImageInfo } from "../engine/protocol";
import { engine, focusRequest, type Signature } from "../state";
import type { PageModel } from "./model";

const loading = new WeakMap<PageModel, number>();

/** Read the added texts of `page` unless they are cached for its current revision or already loading. */
export function ensureAdded(page: PageModel) {
  const rev = page.rev.peek();
  const cached = page.added.peek();
  if (cached && cached.rev === rev) return;
  if (loading.get(page) === rev) return;
  loading.set(page, rev);
  engine()
    .addedTexts(page.index)
    .then(
      (texts) => {
        // A change landed while reading: these are stale, the next render asks again.
        if (page.rev.peek() === rev) page.added.value = { rev, texts };
      },
      (err: unknown) => {
        console.warn(`Reading the added texts of page ${page.index + 1} failed`, err);
        if (page.rev.peek() === rev) page.added.value = { rev, texts: [], failed: true };
      },
    )
    .finally(() => {
      if (loading.get(page) === rev) loading.delete(page);
    });
}

// --- What a picture the user added is ----------------------------------------------------------

/**
 * The description a picture the user added was placed with ("Firma: Mario Rossi", "Sigla"), for
 * its box and its selection frame; null for a photo, or when it cannot be told. ImageInfo carries
 * no /Alt (protocol.ts), so the picture is matched with the signatures this session knows
 * (`signatures`: sessionSignatures, saved ones included) by its pixel size: a signature's PNG
 * keeps it in the page (Signature.width × height is ImageInfo.pixelWidth × pixelHeight), across
 * moves, undo and redo, and on every page its initials were copied to. Signatures of the same
 * size with different descriptions say nothing (null): a wrong name is worse than a plain one.
 * Nothing has to be recorded when a signature is placed, by any path (a tap, "Sign here", "Put
 * it in the middle", "On every page…").
 */
export function addedDescription(
  image: Pick<ImageInfo, "added" | "pixelWidth" | "pixelHeight">, signatures: readonly Signature[],
): string | null {
  if (!image.added) return null;
  let found: string | null = null;
  for (const sig of signatures) {
    if (sig.width !== image.pixelWidth || sig.height !== image.pixelHeight) continue;
    const description = sig.description.trim();
    if (!description) continue;
    if (found !== null && found !== description) return null;
    found = description;
  }
  return found;
}

// --- Focus requests ------------------------------------------------------------------------------

/** How long (ms) a focus request may wait for what it names (an edit still being written, the page read again). */
const FOCUS_REQUEST_WAIT = 4000;
/** When each request was first looked at by a layer. */
const firstSeen = new WeakMap<object, number>();

/**
 * Something may take the keyboard focus now: the user is not typing (a text field, the writer, a
 * select, the phone's hidden keyboard holder), not on a form field (a check box just ticked), not
 * in the writer's bar and not in a dialog. A "Sign here" button may give it up: the signature
 * placed in its field takes it.
 */
export function mayTakeFocus(): boolean {
  if (typeof document === "undefined" || typeof HTMLElement === "undefined") return true;
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || active === document.body) return true;
  if (active.closest("dialog, [role='dialog'], [role='alertdialog'], .writer, .writer-bar")) return false;
  if (active.closest(".form-fields") && !active.classList.contains("form-field-sign")) return false;
  if (active.isContentEditable || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement) return false;
  if (active instanceof HTMLInputElement) {
    return ["button", "submit", "reset", "image", "checkbox", "radio", "range", "color", "file"].includes(active.type);
  }
  return true;
}

/**
 * Take the app's focusRequest (state.ts) when it is for something of `kind` on page `pageIndex`
 * and the layer showing it has read the page at its current revision (`ready`): `find` gives the
 * element for the request's id, or null when it is not there (yet). Found, the request is done, and
 * the element gets the focus if it may (mayTakeFocus; the user went on typing somewhere: it stays
 * there). Not found, it waits, for a few seconds: what it names may still be on its way. A request
 * older than that is dropped, found or not, so a late one never moves the focus out of the blue.
 */
export function honourFocusRequest(
  pageIndex: number, kind: "added" | "image" | "field", ready: boolean, find: (id: number | string) => HTMLElement | null,
) {
  const request = focusRequest.peek();
  if (!request || request.kind !== kind || request.pageIndex !== pageIndex || !ready) return;
  const now = performance.now();
  const seen = firstSeen.get(request) ?? now;
  firstSeen.set(request, seen);
  const late = now - seen > FOCUS_REQUEST_WAIT;
  const el = late ? null : find(request.id);
  if (!el && !late) return;
  focusRequest.value = null;
  if (el && mayTakeFocus()) el.focus();
}
