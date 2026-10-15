// Page size for the details panel: PDF points → whole millimetres, plus the name of a standard
// paper size when the page matches one (in either orientation, within ±3 pt, because PDF
// writers round A4 to 595×842, 595.28×841.89 or 596×843).

const MM_PER_PT = 25.4 / 72;
const TOLERANCE_PT = 3;

/** Standard sizes, portrait, in points. The names are the same in every language. */
const NAMED_SIZES: readonly (readonly [name: string, width: number, height: number])[] = [
  ["A3", 842, 1191],
  ["A4", 595, 842],
  ["A5", 420, 595],
  ["Letter", 612, 792],
  ["Legal", 612, 1008],
];

export interface PageSize {
  /** "A4", "Letter"… or null for any other size. */
  name: string | null;
  widthMm: number;
  heightMm: number;
}

export function pageSize(widthPt: number, heightPt: number): PageSize {
  const short = Math.min(widthPt, heightPt);
  const long = Math.max(widthPt, heightPt);
  const match = NAMED_SIZES.find(
    ([, w, h]) => Math.abs(short - w) <= TOLERANCE_PT && Math.abs(long - h) <= TOLERANCE_PT,
  );
  return {
    name: match ? match[0] : null,
    widthMm: Math.round(widthPt * MM_PER_PT),
    heightMm: Math.round(heightPt * MM_PER_PT),
  };
}
