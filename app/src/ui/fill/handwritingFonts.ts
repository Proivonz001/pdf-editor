// The handwriting styles offered by "Scrivi" (a typed signature): the device's own script fonts,
// found by measuring text on a canvas. Nothing is bundled or downloaded (decision D5), and the
// typed name is drawn into a picture (signatureImage.renderTyped), so no font goes into the PDF.
//
// Tried in this order, keeping at most 3 that look different (report-ux §3):
// - Windows: Segoe Script, Ink Free, Segoe Print;
// - macOS and iOS: Snell Roundhand, Savoye LET, Bradley Hand, Apple Chancery (Mac);
// - then the generic `cursive` (Android: Dancing Script), only when it is a font of its own: not
//   the default sans, serif or monospace, not one already chosen, and never Comic Sans MS (what
//   Windows browsers give for `cursive`) or Gabriola, which do not read as a signature.
// A font counts as installed when text in it, with monospace or serif behind it, measures
// differently from monospace or serif alone: document.fonts.check() says nothing useful about
// system fonts. Linux, ChromeOS or a browser that hides fonts may have none: the Scrivi tab then
// points to Disegna.

/** Families tried, as CSS font-family values. */
const CANDIDATES = [
  '"Segoe Script"', '"Ink Free"', '"Segoe Print"',
  '"Snell Roundhand"', '"Savoye LET"', '"Bradley Hand"', '"Apple Chancery"',
];
/** Never offered as a signature, also when `cursive` is one of them. */
const EXCLUDED = ['"Comic Sans MS"', '"Gabriola"'];
const GENERIC = "cursive";
const MAX_STYLES = 3;
/** Measured at a large size, with letters of every shape, so that two fonts rarely tie. */
const SAMPLE = "Mario Rossi Forlì";
const SIZE = "72px";

/** Width of SAMPLE in a CSS `font` shorthand ("72px \"Segoe Script\", serif"). */
export type MeasureFont = (font: string) => number;

/**
 * The handwriting styles `measure` finds, at most 3, each a CSS font-family value ready for
 * `font-family` and a canvas `font` ('"Segoe Script"', or 'cursive').
 */
export function detectHandwritingFonts(measure: MeasureFont): string[] {
  const width = (family: string) => measure(`${SIZE} ${family}`);
  const mono = width("monospace"), serif = width("serif"), sans = width("sans-serif");
  const installed = (family: string) =>
    measure(`${SIZE} ${family}, monospace`) !== mono || measure(`${SIZE} ${family}, serif`) !== serif;
  const chosen: string[] = [];
  const widths: number[] = [];
  for (const family of CANDIDATES) {
    if (chosen.length >= MAX_STYLES) break;
    if (!installed(family)) continue;
    const w = width(family);
    // Another name for a font already chosen (an alias) adds no style.
    if (widths.includes(w)) continue;
    chosen.push(family);
    widths.push(w);
  }
  if (chosen.length < MAX_STYLES) {
    const w = width(GENERIC);
    const plain = [mono, serif, sans, ...widths, ...EXCLUDED.filter(installed).map(width)];
    if (Number.isFinite(w) && w > 0 && !plain.includes(w)) chosen.push(GENERIC);
  }
  return chosen;
}

/** The handwriting styles of this device (see detectHandwritingFonts); none when there is no canvas. */
export function availableHandwritingFonts(): string[] {
  try {
    const ctx = measuringContext();
    if (!ctx) return [];
    return detectHandwritingFonts((font) => {
      ctx.font = font;
      return ctx.measureText(SAMPLE).width;
    });
  } catch {
    return [];
  }
}

function measuringContext(): OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null {
  if (typeof OffscreenCanvas === "function") {
    const ctx = new OffscreenCanvas(1, 1).getContext("2d");
    if (ctx) return ctx;
  }
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  return typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;
}
