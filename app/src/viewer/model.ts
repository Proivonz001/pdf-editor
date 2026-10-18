// The viewer's model of an open document: one PageModel per page, with small signals so that
// a page component re-renders only when something about *that* page changes.
//
// Pages change with page operations (release 4: move, delete, insert, duplicate, rotate, and
// their undo and redo): applyLayout rebuilds the page list from the engine's new layout, in place,
// on the same OpenDoc (the many "is this still the document I started with?" checks keep meaning
// "another document"). A page that stays keeps its PageModel (and with it its key, its edit marks
// and its component), found through the layout's `from`; a page made by the step gets a new one.
// Every page whose position or size changed gets a new revision and loses what was read of it:
// a read or a render still on its way for its old index must not land on it. The OpenDoc's
// `layout` counts these changes, and reading its `pages` or `info` reads `layout` too, so any
// component, computed or effect that reads them follows page operations by itself.
import { signal, untracked, type Signal } from "@preact/signals";
import type { AddedText, DocInfo, FieldWidget, ImageInfo, LineInfo, PageLayout, Rect } from "../engine/protocol";

/** Text lines of a page, tagged with the page revision they were read at. */
export interface PageLines {
  rev: number;
  lines: LineInfo[];
  /** Reading the lines failed: nothing to show, and no retry until the page changes. */
  failed?: boolean;
}

/** Images of a page (placements, in painting order), tagged with the page revision they were read at. */
export interface PageImages {
  rev: number;
  images: ImageInfo[];
  /** Reading the images failed: nothing to show, and no retry until the page changes. */
  failed?: boolean;
}

/** Form field widgets of a page (in its tab order), tagged with the page revision they were read at. */
export interface PageFields {
  rev: number;
  fields: FieldWidget[];
  /** Reading the fields failed: nothing to show, and no retry until the page changes. */
  failed?: boolean;
}

/** Texts the app wrote on a page (addText), tagged with the page revision they were read at. */
export interface PageAdded {
  rev: number;
  texts: AddedText[];
  /** Reading them failed: nothing to show, and no retry until the page changes. */
  failed?: boolean;
}

export interface PageModel {
  /**
   * Unique per PageModel and never reused, in any document: what components are keyed by and
   * what edit marks hold, so both follow the page wherever page operations move it.
   */
  readonly key: number;
  /** The page's position in the document now (`doc.pages[page.index] === page`); changed by applyLayout. */
  index: number;
  /** Page bounds in page space (points, y down). Changed by applyLayout (a rotation). */
  bounds: Rect;
  /** Size in points. */
  width: number;
  height: number;
  /** Within about one screen of the viewport: gets a rendered bitmap (and lines in Modifica with Cambia). */
  near: Signal<boolean>;
  /** Within about three screens: keeps its canvas. Pages further away release it. */
  keep: Signal<boolean>;
  /** Bumped whenever the page's appearance changes (edit, undo, redo), or its position or size. */
  rev: Signal<number>;
  /** Cached text lines (Modifica with Cambia). Null = not read yet or dropped after a change. */
  lines: Signal<PageLines | null>;
  /**
   * Cached images, all of the page's (Modifica with Cambia shows them all; wherever the text
   * writer is on, Compila e firma and Modifica with Aggiungi testo, only the ones the user added
   * show). Null = not read yet or dropped after a change.
   */
  images: Signal<PageImages | null>;
  /** Cached form field widgets (fill and browse modes). Null = not read yet or dropped after a change. */
  fields: Signal<PageFields | null>;
  /**
   * Cached texts the app wrote, read wherever the text writer is on (Compila e firma, Modifica
   * with Aggiungi testo). Null = not read yet or dropped after a change.
   */
  added: Signal<PageAdded | null>;
}

export interface OpenDoc {
  /** Unique per open: components key on it so that nothing leaks between documents. */
  readonly id: number;
  readonly fileName: string;
  /**
   * The document's facts: those of the open, with the page count, the pages, the form and the
   * signature count as they are now (applyLayout). Reading it reads `layout` (createDoc).
   */
  info: DocInfo;
  /** One PageModel per page, in page order. Changed in place by applyLayout. Reading it reads `layout` (createDoc). */
  pages: PageModel[];
  /** Bumped whenever the pages change (applyLayout): count, order, size or rotation. */
  readonly layout: Signal<number>;
}

/** Keys of PageModels: never reused while the app runs. */
let nextKey = 1;

function newPage(index: number, bounds: Rect): PageModel {
  return {
    key: nextKey++,
    index,
    bounds: [...bounds] as Rect,
    width: Math.max(1, bounds[2] - bounds[0]),
    height: Math.max(1, bounds[3] - bounds[1]),
    near: signal(false),
    keep: signal(false),
    rev: signal(0),
    lines: signal<PageLines | null>(null),
    images: signal<PageImages | null>(null),
    fields: signal<PageFields | null>(null),
    added: signal<PageAdded | null>(null),
  };
}

export function createPages(info: DocInfo): PageModel[] {
  return info.pages.map((p, i) => newPage(i, p.bounds));
}

/**
 * The OpenDoc createDoc makes: `pages` and `info` read `layout` when read, so a component that
 * shows the page count (or the form, the signatures) re-renders after a page operation without
 * having to know about it.
 */
class LiveDoc implements OpenDoc {
  readonly layout = signal(0);
  #info: DocInfo;
  #pages: PageModel[];

  constructor(readonly id: number, readonly fileName: string, info: DocInfo) {
    this.#info = info;
    this.#pages = createPages(info);
  }

  get info(): DocInfo {
    void this.layout.value;
    return this.#info;
  }

  set info(info: DocInfo) {
    this.#info = info;
  }

  get pages(): PageModel[] {
    void this.layout.value;
    return this.#pages;
  }

  set pages(pages: PageModel[]) {
    this.#pages = pages;
  }
}

/** The model of a document just opened: `id` (unique per open), its name, what the engine said of it. */
export function createDoc(id: number, fileName: string, info: DocInfo): OpenDoc {
  return new LiveDoc(id, fileName, info);
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-3);
}

/** What was read of `page` is stale: dropped, and a new revision (a render or read on its way for it is dropped too). */
function refresh(page: PageModel) {
  page.lines.value = null;
  page.images.value = null;
  page.fields.value = null;
  page.added.value = null;
  page.rev.value = page.rev.peek() + 1;
}

/**
 * The pages of `d` after a step that changed them (a page operation, its undo or redo): `layout`
 * as the engine returned it. Rebuilds `d.pages` in place: page k is the PageModel of the page it
 * was (`layout.from[k]`), or `reuse[k]` when given and consistent with `from` (undo and redo of a
 * page operation: the PageModels the pages had then, deleted ones included, so their marks come
 * back with them), or a new PageModel for a page the step made. Each gets its index and bounds;
 * a page whose index or bounds changed, one brought back, and one that went get a new revision
 * and lose what was read of them. `d.info` gets the new page count, pages, form and signature
 * count (the rest is as at open), and `d.layout` is bumped. Call it inside a batch, together with
 * what else the step changes (the history: state.ts, recordHistory).
 */
export function applyLayout(d: OpenDoc, layout: PageLayout, reuse?: readonly PageModel[]): void {
  untracked(() => {
    const old = d.pages.slice();
    const before = new Set(old);
    const n = layout.pages.length;
    const fromOf = (k: number): number | null => {
      const f = layout.from[k];
      return typeof f === "number" && Number.isInteger(f) && f >= 0 && f < old.length ? f : null;
    };
    // The models the pages had are trusted when there is one per page, each once, and none
    // contradicts where the engine says a page came from.
    const fits = !!reuse && reuse.length === n && new Set(reuse).size === n &&
      reuse.every((p, k) => {
        const f = fromOf(k);
        return f === null ? true : old[f] === p;
      });
    const used = new Set<PageModel>();
    const next: PageModel[] = [];
    for (let k = 0; k < n; k++) {
      const bounds = layout.pages[k].bounds;
      let page: PageModel | undefined = fits ? reuse![k] : undefined;
      if (!page) {
        const f = fromOf(k);
        page = f === null ? undefined : old[f];
      }
      if (!page || used.has(page)) {
        page = newPage(k, bounds);
      } else {
        const changed = page.index !== k || !before.has(page) || !sameRect(page.bounds, bounds);
        page.index = k;
        if (!sameRect(page.bounds, bounds)) {
          page.bounds = [...bounds] as Rect;
          page.width = Math.max(1, bounds[2] - bounds[0]);
          page.height = Math.max(1, bounds[3] - bounds[1]);
        }
        if (changed) refresh(page);
      }
      used.add(page);
      next.push(page);
    }
    // Pages that went: anything on its way for them is stale; they are no longer on screen.
    for (const page of old) {
      if (used.has(page)) continue;
      refresh(page);
      page.near.value = false;
      page.keep.value = false;
    }
    const pages = d.pages;
    pages.length = 0;
    for (const page of next) pages.push(page);
    d.info = {
      ...d.info,
      pageCount: n,
      pages: next.map((p) => ({ index: p.index, bounds: p.bounds })),
      form: layout.form,
      signatures: layout.signatures,
    };
    // (An OpenDoc a test builds by hand may have no `layout`.)
    if (d.layout) d.layout.value = d.layout.peek() + 1;
  });
}
