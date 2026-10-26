// One page: a box sized from the page bounds × zoom, a canvas while the page is near the
// viewport, and the overlays of the tool that is on (layersFor): in Modifica with Cambia its text
// lines and its images; wherever the text writer is on (Compila e firma, and Modifica with
// Aggiungi testo) the fill layer (taps, the writer, what the user wrote) and the pictures the user
// added, and in Compila e firma its form fields too; with no tool on (browse), its form fields
// alone; in Modifica with Bianchetto or Oscura (release 5) the layer that marks an area to white
// out or redact (RedactLayer) instead of the lines and images, and with Forme (release 6) the
// shapes the app drew, with what draws new ones (ShapeLayer), instead of them too. Form fields
// never show in Modifica.
// Cerca's highlights (SearchLayer) go on every near page with hits, whatever the tool. Overlays
// are mounted for near pages, and also for a page far away that holds what is open or focused
// (the area waiting to be applied and the selected shape too), what the app asks to focus
// (focusRequest), or, for its form fields, the next or previous page with fields from the field
// focused last (so Tab and Shift+Tab reach them: fields.ts). Switching Modifica's sub-tool swaps
// the layers: a box that had the keyboard focus hands it to the same picture's box in the new
// layer when there is one, else to the scroller, never to <body> (ui/actions.ts, focusAfterLayers).
//
// Rendering: at zoom × devicePixelRatio (capped in pixels on touch devices), through the shared
// render queue. On a zoom change the old bitmap stays, stretched by CSS, and the new one is
// asked for once the zoom has been still for ~150 ms. After an edit (page revision bump) the
// page is re-rendered at once.
import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../i18n";
import {
  devicePixelRatio, editingLine, editingStopped, editTool, focusedField, focusRequest, openWriter, selectedImage,
  selectedShape, tool, type EditTool, type Tool,
} from "../state";
import { pendingRedact, redactMode } from "../ui/redact/pending";
import { shapesMode } from "../ui/shapes/actions";
import { hitsByPage } from "../ui/search/runner";
import { nextToFieldFocus, pageHasFields } from "./fields";
import { everyPageAction, FillLayer } from "./FillLayer";
import { FormLayer } from "./FormLayer";
import { ImageLayer } from "./ImageLayer";
import { LineLayer } from "./LineLayer";
import type { PageModel } from "./model";
import { RedactLayer } from "./RedactLayer";
import { SearchLayer } from "./SearchLayer";
import { ShapeLayer } from "./ShapeLayer";
import type { RenderQueue } from "./renderQueue";
import type { PageVisibility } from "./visibility";

const ZOOM_RENDER_DELAY = 150;
/** Pixel budget per page: phones and tablets run out of canvas memory quickly. */
const MAX_PIXELS = window.matchMedia("(pointer: coarse)").matches ? 8_000_000 : 16_000_000;
/**
 * Longest side of a canvas, in pixels (Chrome and Firefox refuse more). The engine rounds the
 * scaled page bounds outwards, which can add a pixel at each end: hence the 2 px margin.
 */
const MAX_SIDE = 32_767 - 2;

/** Pixels per point for rendering `page` at `zoom` on a screen with `ratio` device pixels per CSS px. */
export function renderScale(page: PageModel, zoom: number, ratio: number): number {
  const wanted = zoom * ratio;
  const area = page.width * page.height;
  // Very long or wide pages (a receipt roll, a banner) hit the side limit well before the area one.
  const scale = Math.min(wanted, Math.sqrt(MAX_PIXELS / area), MAX_SIDE / page.width, MAX_SIDE / page.height);
  // To 1/1000; down when capped, so the limits still hold (never 0: the engine refuses it).
  return Math.max(1, scale < wanted ? Math.floor(scale * 1000) : Math.round(scale * 1000)) / 1000;
}

/** The overlays a tool calls for on a page (PageView then mounts them on the pages that need them). */
export interface PageLayers {
  /** LineLayer and the full ImageLayer: Modifica with Cambia. */
  edit: boolean;
  /** FillLayer and the ImageLayer of the pictures the user added: wherever the text writer is on. */
  writer: boolean;
  /** FormLayer: Compila e firma and browse, never Modifica. */
  fields: boolean;
}

/**
 * Which overlays the tool `on` calls for, with Modifica's sub-tool `sub`. Once editing has
 * stopped there is no writer and there are no form fields (the tool goes off then too).
 */
export function layersFor(on: Tool, sub: EditTool, stopped: boolean): PageLayers {
  const writer = on === "fill" || (on === "edit" && sub === "addText");
  return {
    edit: on === "edit" && sub === "change",
    writer: writer && !stopped,
    fields: on !== "edit" && !stopped,
  };
}

export interface PageViewProps {
  page: PageModel;
  left: number;
  top: number;
  width: number;
  height: number;
  zoom: number;
  queue: RenderQueue;
  vis: PageVisibility;
}

export function PageView({ page, left, top, width, height, zoom, queue, vis }: PageViewProps) {
  const el = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  /** What the canvas currently shows. */
  const drawn = useRef<{ scale: number; rev: number } | null>(null);
  const [ready, setReady] = useState(false);
  /** The page revision the canvas shows (the overlays keep what was just written drawn until then). */
  const [shownRev, setShownRev] = useState(-1);

  const near = page.near.value;
  const keep = page.keep.value || near;
  const rev = page.rev.value;
  const ratio = devicePixelRatio.value;
  const layers = layersFor(tool.value, editTool.value, editingStopped.value);
  /** What is open on this page: kept mounted even if the page scrolled away (unmounting would lose it). */
  const here = (x: { pageIndex: number } | null) => x?.pageIndex === page.index;
  const sel = selectedImage.value;
  const request = focusRequest.value;
  const asked = here(request);
  // Modifica with Cambia: near pages, and the page whose line editor is open or that holds the
  // selected image (or an image the app asks to focus).
  const editOverlays = layers.edit &&
    (near || here(editingLine.value) || here(sel) || (asked && request?.kind === "image"));
  // The writer (Compila e firma, Modifica with Aggiungi testo): near pages, and the page with the
  // writer, the selected picture, the focused field, or a text or picture the app asks to focus.
  const fillOverlays = layers.writer &&
    (near || here(openWriter.value) || here(sel) || here(focusedField.value) || (asked && request?.kind !== "field"));
  // Form fields: in Compila e firma and in browse mode; also the page whose field has (or is asked
  // to get) the focus, and the pages with fields just before and after the one whose field had it
  // last (Tab and Shift+Tab go on to them).
  const formOverlay = layers.fields && pageHasFields(page.index) &&
    (near || here(focusedField.value) || (asked && request?.kind === "field") || nextToFieldFocus(page.index));
  // Bianchetto and Oscura: near pages, and the page with the area waiting to be applied.
  const redact = redactMode.value;
  const redactOverlay = redact !== null && (near || pendingRedact.value?.page === page);
  // Forme: near pages, and the page with the selected shape.
  const shapesOverlay = shapesMode.value && (near || here(selectedShape.value));
  const searchOverlay = near && hitsByPage.value.has(page.index);

  useEffect(() => {
    const node = el.current!;
    vis.observe(node, page);
    return () => vis.unobserve(node);
  }, [vis, page]);

  // Far away: give the canvas memory back (width = 0 frees the backing store at once).
  useEffect(() => {
    if (!keep) return;
    const c = canvas.current;
    return () => {
      if (c) {
        c.width = 0;
        c.height = 0;
      }
      drawn.current = null;
      setReady(false);
      setShownRev(-1);
    };
  }, [keep]);

  // Near: make sure the canvas shows this revision at the right scale.
  useEffect(() => {
    if (!near) return;
    const scale = renderScale(page, zoom, ratio);
    const current = drawn.current;
    if (current && current.rev === rev && current.scale === scale) return;
    let cancelled = false;
    // Same content at another zoom: keep the stretched bitmap a moment, the zoom may still move.
    const delay = current && current.rev === rev ? ZOOM_RENDER_DELAY : 0;
    const timer = setTimeout(() => {
      void queue.request(page.index, scale, () => !cancelled && page.near.peek()).then((result) => {
        if (!result) return;
        const c = canvas.current;
        if (cancelled || !c) {
          result.bitmap.close();
          return;
        }
        c.width = result.width;
        c.height = result.height;
        c.getContext("2d")?.drawImage(result.bitmap, 0, 0);
        result.bitmap.close();
        drawn.current = { scale, rev };
        setReady(true);
        setShownRev(rev);
      });
    }, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [near, zoom, rev, ratio, page, queue]);

  return (
    <div
      ref={el}
      class={ready ? "page is-ready" : "page"}
      style={{ left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` }}
      role="group"
      aria-label={t("viewer.page", { page: page.index + 1 })}
      data-page={page.index}
    >
      {keep && <canvas ref={canvas} class="page-canvas" aria-hidden="true" />}
      {/* Lines first, so Tab reaches them before the images; the images stack below them (viewer.css). */}
      {editOverlays && <LineLayer key="lines" page={page} zoom={zoom} />}
      {editOverlays && <ImageLayer key="images" page={page} zoom={zoom} canvasRev={shownRev} />}
      {/* Fields first, then what the user wrote, then the pictures they added (Tab order); the
          fill layer's tap catcher stacks below them all (viewer.css). */}
      {formOverlay && <FormLayer key="fields" page={page} zoom={zoom} canvasRev={shownRev} />}
      {fillOverlays && <FillLayer key="fill" page={page} zoom={zoom} canvasRev={shownRev} />}
      {fillOverlays && (
        <ImageLayer
          key="added-images"
          page={page}
          zoom={zoom}
          canvasRev={shownRev}
          only="added"
          extraAction={(image) => everyPageAction(page, image)}
        />
      )}
      {searchOverlay && <SearchLayer key="search" page={page} zoom={zoom} />}
      {redactOverlay && <RedactLayer key="redact" page={page} zoom={zoom} mode={redact} />}
      {shapesOverlay && <ShapeLayer key="shapes" page={page} zoom={zoom} canvasRev={shownRev} />}
    </div>
  );
}
