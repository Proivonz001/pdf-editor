// What Forme does (Modifica's "shapes" sub-tool), for viewer/ShapeLayer.tsx:
// - shapesMode: Forme is on (Modifica, "shapes", editing not stopped): the layer is mounted then;
// - pageShapes / ensureShapes: a page's shapes, read from the engine when the layer needs them and
//   kept until the page's revision changes (an edit, an undo or redo, a page operation), like the
//   lines in viewer/lines.ts (PageModel has no slot for them: they live here, by page);
// - addShape / editShape: one shape added, changed or deleted, as one edit in the engine's queue
//   like every other edit (exclusive "edit"), recorded in the history; the shape added is
//   selected (but a pen stroke or a highlight, which the next one follows: then nothing is; and
//   a selection the user made while it was written stays), the
//   one deleted deselected and dropped from the page's shapes at once (ids are stable: no stale
//   button for it while they are read again). A shape is no text: the page's lines read before an
//   edit stay its lines after it. The page is held by its PageModel, so an edit asked before a
//   page operation that lands first follows it. The engine's refusals are said in words:
//   "not-editable" (the page's content cannot take an addition), "bad-request" (a shape it does
//   not take, a shape no longer there);
// - newShape: the next shape of the kind chosen, in the style chosen (shapeStyle); shapeName: what
//   a shape is called ("Freccia rossa", "Rettangolo blu tratteggiato"), shapeLabel with its size,
//   placedText with where it is on the page;
// - "Metti al centro" (the banner bumps shapeCentreRequest): a default shape of the kind chosen in
//   the middle of what shows of the current page, selected (its frame then takes the focus);
// - sayShape / shapeSaid: what the layer of a page says in its status region ("Rettangolo
//   aggiunto", where a shape moved or resized now is, "Forma eliminata"), each time under a new
//   key so the same words said again are heard again.
import { computed, effect, signal, untracked, type Signal } from "@preact/signals";
import { EngineError } from "../../engine/client";
import type { Rect, Shape, ShapeInfo, ShapeKind, ShapeResult } from "../../engine/protocol";
import { boxOf } from "../../engine/shapeGeometry";
import { formatMm, t } from "../../i18n";
import {
  currentPage, doc, editingStopped, editTool, engine, recordHistory, selectedShape, SHAPE_COLORS, shapeCentreRequest,
  shapeKind, shapeStyle, showToast, tool, type ShapeColor, type ShapeToolKind,
} from "../../state";
import type { PageModel } from "../../viewer/model";
import { exclusive, reportEngineError, upperFirst, visiblePart } from "../actions";
import { defaultPoints } from "./geometry";

/** Forme is on: Modifica with its "shapes" sub-tool, while editing has not stopped. */
export const shapesMode = computed(() => tool.value === "edit" && editTool.value === "shapes" && !editingStopped.value);

// --- Reading --------------------------------------------------------------------------------------

/** A page's shapes in painting order, tagged with the page revision they were read at. */
export interface PageShapes {
  rev: number;
  shapes: ShapeInfo[];
  /** Reading them failed: nothing to show, and no retry until the page changes. */
  failed?: boolean;
}

const cache = new WeakMap<PageModel, Signal<PageShapes | null>>();
const loading = new WeakMap<PageModel, number>();

/** The shapes read of `page` (null: not read yet); stale when their `rev` is not the page's. */
export function pageShapes(page: PageModel): Signal<PageShapes | null> {
  let s = cache.get(page);
  if (!s) {
    s = signal<PageShapes | null>(null);
    cache.set(page, s);
  }
  return s;
}

/** Read the shapes of `page` unless they are read for its current revision or being read. */
export function ensureShapes(page: PageModel): void {
  const rev = page.rev.peek();
  const cached = pageShapes(page);
  if (cached.peek()?.rev === rev || loading.get(page) === rev) return;
  loading.set(page, rev);
  engine()
    .shapes(page.index)
    .then(
      (shapes) => {
        // A change landed while reading: these are stale, the next render asks again.
        if (page.rev.peek() === rev) cached.value = { rev, shapes };
      },
      (err: unknown) => {
        console.warn(`Reading the shapes of page ${page.index + 1} failed`, err);
        if (page.rev.peek() === rev) cached.value = { rev, shapes: [], failed: true };
      },
    )
    .finally(() => {
      if (loading.get(page) === rev) loading.delete(page);
    });
}

// --- Writing --------------------------------------------------------------------------------------

/**
 * One shape edit of `page` in the engine's queue: `send` gets the page's index then. Recorded in
 * the history; a refusal is said (`bad`: what "bad-request" means here) and resolves null, like
 * a failure, another document meanwhile or the page gone.
 */
function write(page: PageModel, send: (pageIndex: number) => Promise<ShapeResult>, bad: string): Promise<ShapeResult | null> {
  const d = doc.peek();
  return exclusive("edit", async () => {
    if (!d || doc.peek() !== d || editingStopped.peek() || d.pages[page.index] !== page) return null;
    try {
      const result = await send(page.index);
      if (doc.peek() !== d) return null;
      const rev = page.rev.peek(), lines = page.lines.peek();
      recordHistory(result, "edit");
      // The lines stay right (a shape is no text): a click of the highlighter needs not wait for them.
      if (lines?.rev === rev && page.rev.peek() === rev + 1) page.lines.value = { ...lines, rev: rev + 1 };
      return result;
    } catch (e) {
      const code = e instanceof EngineError ? e.code : undefined;
      if (code === "bad-request") {
        console.warn(e);
        showToast("error", bad);
        return null;
      }
      reportEngineError(e, t("shapes.failed"), t("shapes.notEditable"));
      return null;
    }
  });
}

/** The selection addShape made last: a shape drawn while another was being written may follow it. */
let addedSelection: ReturnType<typeof selectedShape.peek> | undefined;

/**
 * Add `shape` to `page` as one edit; while Forme is on the new shape is selected, or with `select`
 * false (a pen stroke, a highlight: the next one follows it) nothing is; unless the user changed
 * the selection while it was written (picked a shape meanwhile; a shape added meanwhile and
 * selected by this function does not count, so of two drawn quickly the last is selected).
 * Resolves its id, or null.
 */
export async function addShape(page: PageModel, shape: Shape, select = true): Promise<number | null> {
  const before = selectedShape.peek(); // (each selection is a new object)
  const result = await write(page, (i) => engine().addShape(i, shape), t("shapes.badShape"));
  if (result?.id == null) return null;
  const now = selectedShape.peek();
  if (shapesMode.peek() && doc.peek()?.pages[result.pageIndex] === page && (now === before || (now !== null && now === addedSelection))) {
    selectedShape.value = select ? { pageIndex: result.pageIndex, id: result.id } : null;
    addedSelection = selectedShape.peek();
  }
  return result.id;
}

/**
 * Change the shape `id` of `page` to `shape`, or delete it (null), as one edit; a shape deleted is
 * deselected, and gone from the page's shapes at once when they were read just before (ids are
 * stable: that is what reading them again gives). Resolves true when it was written.
 */
export async function editShape(page: PageModel, id: number, shape: Shape | null): Promise<boolean> {
  const cached = pageShapes(page);
  let known: PageShapes | null = null;
  const result = await write(page, (i) => {
    const now = cached.peek();
    known = now?.rev === page.rev.peek() && !now.failed ? now : null;
    return engine().editShape(i, id, shape);
  }, t("shapes.badEdit"));
  const sel = selectedShape.peek();
  if (result && shape === null) {
    const before = known as PageShapes | null;
    if (before && page.rev.peek() === before.rev + 1) cached.value = { rev: before.rev + 1, shapes: before.shapes.filter((s) => s.id !== id) };
    if (sel?.id === id && sel.pageIndex === page.index) selectedShape.value = null;
  }
  return result !== null;
}

// --- Style and names ------------------------------------------------------------------------------

/** The next shape of tool kind `kind` through `points`, in `style` (an arrow: a line with style.heads). */
export function newShape(kind: ShapeToolKind, points: [number, number][], style = shapeStyle.peek()): Shape {
  const k: ShapeKind = kind === "arrow" ? "line" : kind;
  return {
    kind: k,
    points,
    color: SHAPE_COLORS[k === "highlight" ? style.highlight : style.color],
    width: k === "highlight" ? 0 : style.width,
    dash: k === "pen" || k === "highlight" ? "solid" : style.dash,
    heads: kind === "arrow" ? style.heads : 0,
  };
}

/** The palette colour closest to `rgb` (a shape's colour is always one of them). */
export function colorOf(rgb: readonly number[]): ShapeColor {
  let best: ShapeColor = "black";
  let gap = Infinity;
  for (const [name, c] of Object.entries(SHAPE_COLORS) as [ShapeColor, number[]][]) {
    const d = c.reduce((sum, v, i) => sum + (v - (rgb[i] ?? 0)) ** 2, 0);
    if (d < gap) [best, gap] = [name, d];
  }
  return best;
}

/** What a shape is, as Forme's kinds name it: a line with one head is an arrow, with two a double arrow. */
export type ShapeName = "line" | "arrow" | "arrowBoth" | "rect" | "ellipse" | "pen" | "highlight";
export function nameKind(shape: Pick<Shape, "kind" | "heads">): ShapeName {
  if (shape.kind !== "line" || !shape.heads) return shape.kind;
  return shape.heads === 2 ? "arrowBoth" : "arrow";
}

/** The palette colour's name, agreeing with the name of `kind` where the language wants it ("rossa"). */
export function colorName(color: ShapeColor, kind: ShapeName = "rect"): string {
  return t(t(`shapes.gender.${kind}`) === "f" ? `shapes.colorF.${color}` : `shapes.colorM.${color}`);
}

const DASHED = { solid: "", dashed: "Dashed", dotted: "Dotted" } as const;

/** "Freccia rossa", "Rettangolo blu tratteggiato", "Evidenziazione gialla", "Tratto a mano libera nero"... */
export function shapeName(shape: Shape): string {
  const kind = nameKind(shape);
  const color = colorName(colorOf(shape.color), kind);
  if (kind === "pen" || kind === "highlight") return upperFirst(t(`shapes.name.${kind}`, { color }));
  return upperFirst(t(`shapes.name.${kind}${DASHED[shape.dash]}`, { color }));
}

/** A shape's button and frame: its name and size ("Freccia rossa, 40 mm", "Rettangolo blu, 30 × 20 mm"). */
export function shapeLabel(shape: Shape): string {
  const name = shapeName(shape);
  if (shape.kind === "line") {
    const [[x0, y0], [x1, y1]] = shape.points;
    return t("shapes.lineLabel", { name, length: formatMm(Math.hypot(x1 - x0, y1 - y0)) });
  }
  const [x0, y0, x1, y1] = boxOf(shape.points);
  return t("shapes.boxLabel", { name, w: formatMm(x1 - x0), h: formatMm(y1 - y0) });
}

/**
 * Where `shape` is, in words: its label (shapeLabel) and how far its points' box is from the left
 * and the top of the page of `bounds` ("Freccia rossa, 40 mm, a 35 mm da sinistra e 20 mm dall'alto").
 */
export function placedText(shape: Shape, bounds: Rect): string {
  const [x0, y0] = boxOf(shape.points);
  return t("shapes.placed", { label: shapeLabel(shape), x: formatMm(x0 - bounds[0]), y: formatMm(y0 - bounds[1]) });
}

/** "Rettangolo aggiunto", "Freccia aggiunta"...: what the status region says when `shape` is added. */
export function addedText(shape: Shape): string {
  const kind = nameKind(shape);
  return t(`shapes.added.${kind === "arrowBoth" ? "arrow" : kind}`);
}

// --- The status region ----------------------------------------------------------------------------

/** What the layer of page `pageIndex` says, under a new key each time. */
export const shapeSaid = signal<{ id: number; pageIndex: number; text: string } | null>(null);
let saidId = 0;

export function sayShape(pageIndex: number, text: string): void {
  shapeSaid.value = { id: ++saidId, pageIndex, text };
}

// --- "Metti al centro" ----------------------------------------------------------------------------

/**
 * "Metti al centro" in Forme: a default shape of the kind chosen (not the pen, which is only
 * drawn) in the middle of what shows of the current page, written and selected, and said.
 */
export async function placeShapeAtCentre(): Promise<void> {
  const d = doc.peek();
  const kind = shapeKind.peek();
  if (!d || !d.pages.length || !shapesMode.peek() || kind === "pen") return;
  const pageIndex = Math.min(Math.max(0, currentPage.peek()), d.pages.length - 1);
  const page = d.pages[pageIndex];
  const view = visiblePart(pageIndex);
  const points = defaultPoints(kind === "arrow" ? "line" : kind, [(view[0] + view[2]) / 2, (view[1] + view[3]) / 2], page.bounds);
  if (!points) return;
  const shape = newShape(kind, points as [number, number][]);
  if ((await addShape(page, shape)) !== null) sayShape(page.index, addedText(shape));
}

// The banner's button bumps the counter: each new value is one shape (not the value found at start).
let centreSeen = shapeCentreRequest.peek();
effect(() => {
  const asked = shapeCentreRequest.value;
  if (asked === centreSeen) return;
  centreSeen = asked;
  untracked(() => void placeShapeAtCentre());
});
