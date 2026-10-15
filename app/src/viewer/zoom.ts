// Zoom and page commands for the rest of the UI (top bar, keyboard, thumbnails). The mounted
// Viewer registers the controller that knows the layout and the scroll position, so the point
// at the centre of the screen stays in place.
import { zoom } from "../state";
import { stepZoom } from "./layout";

export interface ZoomController {
  /** Set the zoom, keeping the content under `view` (px from the scroller's top-left) in place. */
  zoomTo(z: number, view?: [number, number]): void;
  /** Turn on fit-width mode and apply it. */
  fitWidth(): void;
  /** Scroll so that page `index` starts at the top of the viewport. */
  goToPage(index: number): void;
}

let active: ZoomController | null = null;

export function setZoomController(controller: ZoomController | null) {
  active = controller;
}

export function zoomIn() {
  active?.zoomTo(stepZoom(zoom.peek(), 1));
}

export function zoomOut() {
  active?.zoomTo(stepZoom(zoom.peek(), -1));
}

export function fitWidth() {
  active?.fitWidth();
}

export function goToPage(index: number) {
  active?.goToPage(index);
}
