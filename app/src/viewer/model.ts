// The viewer's model of an open document: one PageModel per page, with small signals so that
// a page component re-renders only when something about *that* page changes.
import { signal, type Signal } from "@preact/signals";
import type { AddedText, DocInfo, FieldWidget, ImageInfo, LineInfo, Rect } from "../engine/protocol";

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
  index: number;
  /** Page bounds in page space (points, y down). */
  bounds: Rect;
  /** Size in points. */
  width: number;
  height: number;
  /** Within about one screen of the viewport: gets a rendered bitmap (and lines in edit mode). */
  near: Signal<boolean>;
  /** Within about three screens: keeps its canvas. Pages further away release it. */
  keep: Signal<boolean>;
  /** Bumped whenever the page's appearance changes (edit, undo, redo). */
  rev: Signal<number>;
  /** Cached text lines (edit mode). Null = not read yet or dropped after a change. */
  lines: Signal<PageLines | null>;
  /** Cached images (edit mode; the added ones in fill mode). Null = not read yet or dropped after a change. */
  images: Signal<PageImages | null>;
  /** Cached form field widgets (fill and browse modes). Null = not read yet or dropped after a change. */
  fields: Signal<PageFields | null>;
  /** Cached texts the app wrote (fill mode). Null = not read yet or dropped after a change. */
  added: Signal<PageAdded | null>;
}

export interface OpenDoc {
  /** Unique per open: components key on it so that nothing leaks between documents. */
  id: number;
  fileName: string;
  info: DocInfo;
  pages: PageModel[];
}

export function createPages(info: DocInfo): PageModel[] {
  return info.pages.map((p) => ({
    index: p.index,
    bounds: p.bounds,
    width: Math.max(1, p.bounds[2] - p.bounds[0]),
    height: Math.max(1, p.bounds[3] - p.bounds[1]),
    near: signal(false),
    keep: signal(false),
    rev: signal(0),
    lines: signal<PageLines | null>(null),
    images: signal<PageImages | null>(null),
    fields: signal<PageFields | null>(null),
    added: signal<PageAdded | null>(null),
  }));
}
