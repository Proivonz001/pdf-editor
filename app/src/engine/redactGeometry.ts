// The areas Bianchetto and Oscura take (release 5), plain geometry shared by the engine
// (redact.ts) and the UI (the box over a tapped line, "Oscura tutti i risultati"). No MuPDF here.
//
// MuPDF's redaction removes a character when its box (advance × ascender..descender, the quad
// MuPDF's structured text gives), shrunk by 10 % on each side, meets the area. Those boxes are
// taller than the line spacing (16.5 pt for 12 pt Helvetica): a search hit's or a line's quads
// used as the area took letters from the lines above and below at 12 and 14.4 pt spacing. So an
// area made from quads keeps only their middle half across the line (as core.replaceText's
// shrinkQuad does, fy 0.5), which every character of the run still meets, and stops a little
// short of the run's ends (5 % of its height, 10 % of its length at most), which the characters
// at the ends still meet (the neighbours on the same line never did: their own 10 % stays out).
//
// A run turned from the page's axes (a skewed scan's text layer, a rotated label) is the same
// test with boxes upright on the page: the run's bounds grow across it by its length times the
// turn, and its characters' boxes, and those of the lines beside it, grow as well. Its area is cut
// along into pieces, each kept so close to the run's middle line that its bounds reach no further
// across than an upright run's area, and less the more it is turned. Measured on 12 pt Helvetica
// at 12 and 14.4 pt spacing, slanted too, at every angle: every letter of the hit goes and the
// lines beside it keep theirs. What cannot be kept (the boxes are MuPDF's): on a line turned
// between about 30° and 80°, the letter just before or after the hit on its own line can go too.
import type { Quad, Rect } from "./protocol";

/** Most rects one redaction takes on one page (redact.ts refuses more: "bad-request"). */
export const MAX_REDACT_RECTS = 1000;

/** The part of a quad's height an area keeps, centred (core.replaceText's shrinkQuad, fy). */
const KEEP_ACROSS = 0.5;
/** How far an area stops short of a run's ends: this much of its height, at most END_LENGTH of its length. */
const END_HEIGHT = 0.05;
const END_LENGTH = 0.1;
/** Below this sin 2θ (about 0.03°), a quad counts as upright. */
const TURNED = 1e-3;
/**
 * A turned run's area reaches across this much less of its height for each unit of sin 2θ: the
 * boxes of the characters on the lines beside it grow towards it, by about 0.4 × their width ×
 * sin 2θ.
 */
const TURN_ACROSS = 0.2;
/** Most pieces a turned run is cut in (a longer one's then reach a little further, never less of the run). */
const MAX_PIECES = 128;

/**
 * Areas safe for neighbouring lines from a hit's or a line's quads (one per run along a line, in
 * page space): each quad shrunk across to its middle half and a little along, as its page-space
 * bounds. A quad turned from the page's axes (a skewed scan's text, a rotated label) has bounds
 * taller than itself, by its length times the turn, which would reach over the lines beside it: it
 * is shrunk across to its middle quarter or less and cut along into pieces (at most MAX_PIECES),
 * so that no piece's bounds reach further from the line's middle than an upright run's area does,
 * less the more it is turned. Quads of no length or no height give nothing.
 */
export function areasForQuads(quads: Quad[]): Rect[] {
  const out: Rect[] = [];
  for (const q of quads) {
    if (!q.every(Number.isFinite)) continue;
    // u: ul → ur (along the baseline), v: ul → ll (across, ascent to descent)
    const ux = q[2] - q[0], uy = q[3] - q[1], vx = q[4] - q[0], vy = q[5] - q[1];
    const length = Math.hypot(ux, uy), height = Math.hypot(vx, vy);
    if (length <= 0 || height <= 0) continue;
    const end = Math.min(END_HEIGHT * height, END_LENGTH * length) / length; // as a fraction of u
    const at = (s: number, t: number): [number, number] => [q[0] + s * ux + t * vx, q[1] + s * uy + t * vy];
    const bounds = (s0: number, s1: number, t0: number, t1: number): Rect => {
      const corners = [at(s0, t0), at(s1, t0), at(s0, t1), at(s1, t1)];
      const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1]);
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    };
    // How far the run is turned from the page's axes: sin 2θ (0 upright or a quarter turn, 1 at 45°).
    const turn = Math.abs(2 * ux * uy) / (length * length);
    if (turn < TURNED) {
      const across = (1 - KEEP_ACROSS) / 2;
      out.push(bounds(end, 1 - end, across, 1 - across));
      continue;
    }
    // A turned run. Reach: how far a piece's bounds stand from the run's middle line, across it
    // (n: its normal): its band's reach, and turn / 2 of its length. At most `limit`: what an upright
    // run's area reaches (KEEP_ACROSS / 2 of its height), less as the turn grows.
    const nx = -uy / length, ny = ux / length;
    const thick = Math.abs(ux * vy - uy * vx) / length; // the run's height across it
    const limit = (KEEP_ACROSS / 2 - TURN_ACROSS * turn) * thick, perT = Math.abs(vx * nx) + Math.abs(vy * ny);
    if (!(limit > 0)) continue;
    const half = Math.min(KEEP_ACROSS / 4, limit / 2 / perT), band = half * perT;
    const pieces = Math.min(MAX_PIECES, Math.max(1, Math.ceil(((1 - 2 * end) * length * turn) / 2 / (limit - band))));
    for (let k = 0; k < pieces; k++) {
      const s0 = end + ((1 - 2 * end) * k) / pieces, s1 = end + ((1 - 2 * end) * (k + 1)) / pieces;
      out.push(bounds(s0, s1, 0.5 - half, 0.5 + half));
    }
  }
  return out;
}

/**
 * Rects clipped to the page bounds (page space), empty ones (and any with a coordinate that is not
 * a finite number) dropped, at most MAX_REDACT_RECTS (the first ones). A rect given with its
 * corners the other way round counts as the same rect.
 */
export function clampAreas(rects: Rect[], bounds: Rect): Rect[] {
  const out: Rect[] = [];
  for (const r of rects) {
    if (out.length >= MAX_REDACT_RECTS) break;
    if (!Array.isArray(r) || r.length !== 4 || !r.every((v) => typeof v === "number" && Number.isFinite(v))) continue;
    const x0 = Math.max(Math.min(r[0], r[2]), bounds[0]), y0 = Math.max(Math.min(r[1], r[3]), bounds[1]);
    const x1 = Math.min(Math.max(r[0], r[2]), bounds[2]), y1 = Math.min(Math.max(r[1], r[3]), bounds[3]);
    if (x1 > x0 && y1 > y0) out.push([x0, y0, x1, y1]);
  }
  return out;
}
