// Where a PDF file dragged in from outside adds its pages instead of opening (release 4): the
// thumbnails, which register here while they are on screen (viewer/Thumbnails.tsx). The window's
// drop handling (ui/DropOverlay.tsx) asks which zone, if any, the file is over: there it shows
// where the pages would go (a marker between the thumbnails), says so in its overlay, and hands
// the dropped PDF to the zone; anywhere else the PDF is opened, as before.

export interface PdfDropZone {
  /** The element the zone covers (the thumbnails' scroller). */
  readonly element: Element;
  /** It takes files now (not while editing has stopped). */
  accepts(): boolean;
  /** A file is dragged over the point (client px), or no longer over the zone (null). */
  hover(point: { x: number; y: number } | null): void;
  /** A PDF was dropped at the point (client px). */
  drop(file: File, point: { x: number; y: number }): void;
}

const zones = new Set<PdfDropZone>();

/** Register `zone` while it is on screen; returns the function that removes it. */
export function registerPdfDropZone(zone: PdfDropZone): () => void {
  zones.add(zone);
  return () => {
    zones.delete(zone);
  };
}

/** The zone that `target` (an event's target) is in and that takes files now, or null. */
export function pdfDropZoneAt(target: EventTarget | null): PdfDropZone | null {
  if (!target || typeof (target as Node).nodeType !== "number") return null;
  for (const zone of zones) if (zone.element.contains(target as Node) && zone.accepts()) return zone;
  return null;
}
