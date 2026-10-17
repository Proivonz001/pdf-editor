// Form field widgets of a page, read from the engine on demand (fill and browse modes, page near
// the viewport) and cached in page.fields until the page changes (invalidatePages() drops the
// cache), like the lines in lines.ts. Also what the field overlay needs to know about a widget:
// whether it gets a control that takes the focus, its name for people, whether it is the last
// one the keyboard's "next" reaches, and the next one on the same page (so Enter can move the
// focus at once, within the key press, and a phone keeps its keyboard up; further pages go
// through focusNextField in actions.ts); the pages whose fields Tab and Shift+Tab reach next
// (their form layers stay in the page, however far away they are; pages whose widgets take no
// focus are passed over); whether the focus is still within a field (its control, or the chip's
// "Today"); and, on touch screens, how far each check box's or radio button's target may grow
// without covering a neighbour.
import { computed, signal } from "@preact/signals";
import type { FieldWidget, Rect } from "../engine/protocol";
import { doc, engine } from "../state";
import type { PageModel } from "./model";

const loading = new WeakMap<PageModel, { rev: number; promise: Promise<FieldWidget[]> }>();

/** The fields of `page` read at its current revision, or null when they are not (yet). */
export function cachedFields(page: PageModel): FieldWidget[] | null {
  const cached = page.fields.peek();
  return cached && cached.rev === page.rev.peek() ? cached.fields : null;
}

/**
 * The fields of `page` at its current revision: from the cache, or read from the engine (once,
 * however many ask meanwhile). A failed read gives an empty list, and no retry until the page
 * changes.
 */
export function loadFields(page: PageModel): Promise<FieldWidget[]> {
  const rev = page.rev.peek();
  const cached = cachedFields(page);
  if (cached) return Promise.resolve(cached);
  const running = loading.get(page);
  if (running && running.rev === rev) return running.promise;
  const promise = engine()
    .fields(page.index)
    .then(
      (fields) => {
        // A change landed while reading: these are stale, the next render asks again.
        if (page.rev.peek() === rev) page.fields.value = { rev, fields };
        return fields;
      },
      (err: unknown) => {
        console.warn(`Reading the form fields of page ${page.index + 1} failed`, err);
        if (page.rev.peek() === rev) page.fields.value = { rev, fields: [], failed: true };
        return [] as FieldWidget[];
      },
    )
    .finally(() => {
      if (loading.get(page)?.promise === promise) loading.delete(page);
    });
  loading.set(page, { rev, promise });
  return promise;
}

/** Read the fields of `page` unless they are cached for its current revision or already loading. */
export function ensureFields(page: PageModel) {
  void loadFields(page);
}

/** The page has form field widgets at all (DocInfo.form), so asking the engine is worth it. */
export function pageHasFields(pageIndex: number): boolean {
  return (doc.value?.info.form?.fieldsPerPage[pageIndex] ?? 0) > 0;
}

/** A signature field that holds no digital signature: it gets a "Sign here" button. */
export const isUnsignedSignature = (f: FieldWidget) => f.type === "signature" && !f.signed;

/** A widget the app fills in (the same rule as actions.ts: no buttons, signatures or locked fields). */
export const isFillable = (f: FieldWidget) => f.locked === null && f.type !== "button" && f.type !== "signature";

/**
 * A widget whose control takes the keyboard focus (as FormLayer draws them): one the app fills
 * in, or "Sign here" on an unsigned signature field. Locked fields, push buttons and signed
 * signatures take none.
 */
export const takesFocus = (f: FieldWidget) => isFillable(f) || isUnsignedSignature(f);

/**
 * The focus is within the field whose control is `control`: on the control itself, or on what
 * its box holds besides it (the chip's "Today" button). Moving between the two is not leaving
 * the field: it stays the focused one, and nothing pulls the focus back to the control.
 */
export function focusWithinField(control: Element, active: Element | null): boolean {
  if (!active) return false;
  if (active === control) return true;
  const box = control.closest(".form-field");
  return !!box && box.contains(active);
}

/** What the fields read last for a page say (kept while they are read again after a change of the page). */
interface PageSummary {
  /** A control on the page takes the focus. */
  focus: boolean;
  /** A field on the page is one the app fills in (the keyboard's "next" goes to it). */
  fill: boolean;
}

const summaries = new WeakMap<PageModel, PageSummary>();

/**
 * What the fields of `page` say, from what was read last (in a computed, reading page.fields
 * makes it follow them): a change of the page changes values, never which widgets are there or
 * whether they are locked, so the summary stays while they are read again. Null: never read.
 */
function summaryOf(page: PageModel | undefined, track: boolean): PageSummary | null {
  if (!page) return null;
  const cached = track ? page.fields.value : page.fields.peek();
  if (cached) {
    const summary = { focus: cached.fields.some(takesFocus), fill: cached.fields.some(isFillable) };
    summaries.set(page, summary);
    return summary;
  }
  return summaries.get(page) ?? null;
}

/**
 * The field's name for people: its tooltip (/TU) as written, or its own partial name made
 * readable ("data_di_nascita" → "data di nascita") when it looks like an identifier.
 */
export function fieldLabel(f: FieldWidget): string {
  const raw = (f.label || f.name.split(".").pop() || f.name).trim();
  if (/\s/.test(raw)) return raw;
  return raw.replace(/[_\-]+/g, " ").replace(/\s+/g, " ").trim() || raw;
}

/** A field for an Italian tax code ("codice fiscale", "CF"): typed in capitals. */
export function isTaxCodeField(f: FieldWidget): boolean {
  return /fiscale|(^|[^a-z])cf([^a-z]|$)/i.test(`${f.label} ${f.name}`);
}

/**
 * The next widget after `f` on the same page that the keyboard's "next" goes to (the other
 * buttons of its radio group are skipped, as Tab does), or null when the next one is on a later
 * page or there is none.
 */
export function nextOnPage(f: FieldWidget, pageFields: readonly FieldWidget[]): FieldWidget | null {
  return pageFields.find((o) => o.index > f.index && isFillable(o) && o.name !== f.name) ?? null;
}

/**
 * No field after `f` for the keyboard's "next" (on this page or a later one): Enter says "done".
 * A later page with widgets counts unless its fields, read before, have none the app fills in.
 */
export function isLastField(pageIndex: number, f: FieldWidget, pageFields: readonly FieldWidget[]): boolean {
  if (nextOnPage(f, pageFields)) return false;
  const d = doc.peek();
  const perPage = d?.info.form?.fieldsPerPage ?? [];
  for (let p = pageIndex + 1; p < perPage.length; p++) {
    if ((perPage[p] ?? 0) > 0 && summaryOf(d?.pages[p], false)?.fill !== false) return false;
  }
  return true;
}

// --- Tab across pages ------------------------------------------------------------------------
// Tab and Shift+Tab follow the page's DOM, and a page's form layer is in it only while the page is
// near the viewport (PageView). So the pages with fields just before and after the page whose
// field had the focus last stay mounted too: Tab from the last field of a page reaches the first
// field of the next page with fields, Shift+Tab from the first one the previous page's last,
// however far away (zoomed in, or pages without fields between); the browser scrolls it into view.
// A page whose widgets take no focus (all read-only or otherwise locked, push buttons, signed
// signatures) is passed over: its layer would hold nothing for Tab, and the focus would leave
// the viewer. A page whose fields were never read counts until they are: its layer, mounted,
// reads them, and if none takes the focus the next page with fields is mounted instead (one
// small engine read per such page, long before the user presses Tab).

/**
 * The page of the form field that had the focus last, in the document `docId`. Kept when the
 * focus leaves the field: between the blur of one field and the focus of the next (a Tab), the
 * next page's fields must stay in the page.
 */
export const lastFieldFocus = signal<{ docId: number; pageIndex: number } | null>(null);

/** A field of page `pageIndex` of the open document has the focus (FormLayer). */
export function noteFieldFocus(pageIndex: number) {
  const docId = doc.peek()?.id;
  if (docId === undefined) return;
  const now = lastFieldFocus.peek();
  if (now?.docId !== docId || now.pageIndex !== pageIndex) lastFieldFocus.value = { docId, pageIndex };
}

/**
 * The pages with fields before and after `pageIndex` (null: none), given the number of widgets on
 * each page (FormInfo.fieldsPerPage) and whether a page's widgets take the focus (`takeFocus`:
 * false passes the page over; null, not known yet, counts it).
 */
export function fieldPagesAround(
  fieldsPerPage: readonly number[], pageIndex: number, takeFocus: (page: number) => boolean | null = () => null,
): [number | null, number | null] {
  const counts = (p: number) => (fieldsPerPage[p] ?? 0) > 0 && takeFocus(p) !== false;
  let before: number | null = null;
  let after: number | null = null;
  for (let p = pageIndex - 1; p >= 0; p--) {
    if (counts(p)) {
      before = p;
      break;
    }
  }
  for (let p = pageIndex + 1; p < fieldsPerPage.length; p++) {
    if (counts(p)) {
      after = p;
      break;
    }
  }
  return [before, after];
}

const aroundFieldFocus = computed<[number | null, number | null]>(() => {
  const last = lastFieldFocus.value;
  const d = doc.value;
  if (!last || !d || last.docId !== d.id) return [null, null];
  // Reading each page's fields here makes the pages follow them as they are read.
  return fieldPagesAround(d.info.form?.fieldsPerPage ?? [], last.pageIndex, (p) => summaryOf(d.pages[p], true)?.focus ?? null);
});

/** Page `pageIndex` is the page with fields just before or just after the one whose field had the focus last. */
export function nextToFieldFocus(pageIndex: number): boolean {
  const [before, after] = aroundFieldFocus.value;
  return pageIndex === before || pageIndex === after;
}

// --- Touch targets ---------------------------------------------------------------------------

/**
 * Touch screens: the target of each widget that `grows` (a check box or a radio button), and
 * the others' own boxes. A growing target reaches out towards `side` × `side` round its widget,
 * but never more than halfway to another widget whose full target it would meet: such two are
 * kept apart along the axis where their boxes are further apart, each getting at most half the
 * gap there. So a target never covers another widget's box or another target, and a finger on a
 * box always lands on that box's own control; in a dense column the targets are just smaller.
 * Rects as [x0, y0, x1, y1], all in one unit (`side` too).
 */
export function touchTargets(rects: readonly Rect[], grows: readonly boolean[], side: number): Rect[] {
  const want = rects.map(([x0, y0, x1, y1], i): [number, number] =>
    grows[i] ? [Math.max(0, (side - (x1 - x0)) / 2), Math.max(0, (side - (y1 - y0)) / 2)] : [0, 0]);
  // How far each target reaches past its box: left, top, right, bottom.
  const reach = want.map(([ex, ey]) => [ex, ey, ex, ey]);
  for (let i = 0; i < rects.length; i++) {
    if (!grows[i]) continue;
    const [ax0, ay0, ax1, ay1] = rects[i];
    const [aex, aey] = want[i];
    const r = reach[i];
    for (let j = 0; j < rects.length; j++) {
      if (j === i) continue;
      const [bx0, by0, bx1, by1] = rects[j];
      const [bex, bey] = want[j];
      // Their full targets do not meet: nothing to share.
      if (ax0 - aex >= bx1 + bex || bx0 - bex >= ax1 + aex || ay0 - aey >= by1 + bey || by0 - bey >= ay1 + aey) continue;
      const gapX = Math.max(bx0 - ax1, ax0 - bx1);
      const gapY = Math.max(by0 - ay1, ay0 - by1);
      const half = Math.max(0, Math.max(gapX, gapY) / 2);
      if (gapX >= gapY) {
        if (bx0 + bx1 >= ax0 + ax1) r[2] = Math.min(r[2], half);
        else r[0] = Math.min(r[0], half);
      } else if (by0 + by1 >= ay0 + ay1) {
        r[3] = Math.min(r[3], half);
      } else {
        r[1] = Math.min(r[1], half);
      }
    }
  }
  return rects.map(([x0, y0, x1, y1], i): Rect => [x0 - reach[i][0], y0 - reach[i][1], x1 + reach[i][2], y1 + reach[i][3]]);
}
