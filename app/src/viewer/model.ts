// The viewer's model of an open document: one PageModel per page, with small signals so that
// a page component re-renders only when something about *that* page changes.
import { signal, type Signal } from "@preact/signals";
import type { DocInfo, LineInfo, Rect } from "../engine/protocol";

/** Text lines of a page, tagged with the page revision they were read at. */
export interface PageLines {
  rev: number;
  lines: LineInfo[];
  /** Reading the lines failed: nothing to show, and no retry until the page changes. */
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
  }));
}
