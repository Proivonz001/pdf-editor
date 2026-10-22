// Cerca (release 5): finding text the way a reader expects to, in the page's own text and in the
// visible form fields. Ported from the release 5 research prototype (r5/search/search2.mjs),
// verified on the app's fixtures, the prototype's and Chrome-made Italian pages.
//
// MuPDF 1.27's own search cannot be used: it takes no options, respects accents ("Universita"
// finds nothing in "Università"), equates no apostrophe, quote or dash variants, finds nothing in
// vertical text (each glyph is a line of its own there) and does not look into field values. So:
//
// - readPageText reads a page once, with one light structured-text walk (the same
//   "preserve-whitespace" option as core.extractLines, the 0.88 em fix of vertical characters'
//   quads, consecutive vertical lines joined with core.joinVerticalLines), and keeps a compact
//   PageText (a session caches hundreds): the characters in reading order with one separator
//   between lines (control characters, so a Latin-1 page stays a one-byte string), per character
//   only where it starts and ends along its line in 16-bit steps of that line (4 bytes; a step
//   is the line's extent / 65535, under 0.01 pt on a printed line), the extent across the line
//   once per run of characters that share it, and per line its direction, start and step. Each
//   visible form field's appearance is read the same way, as a text of its own (hits there say
//   `in: "field"` and the field's full name; a comb field's with "inhibit-spaces", else MuPDF
//   reads a space between every two of its cells and a codice fiscale is never found as typed).
//   Password fields and Hidden or NoView widgets are left out; so are notes' and other
//   annotations' /Contents (not in v1), and text outside the page (MuPDF's structured text
//   leaves it out). Invisible text (OCR layers) and text in a layer that is switched off are
//   found: they are in the page, and Oscura removes them too.
// - The separator says how the line break reads, decided once from the geometry: a space (an
//   ordinary break), nothing (MuPDF split one word in two lines touching on one baseline), a
//   hyphenated word (the line ends in a hyphen or a soft hyphen between letters and the next
//   line starts on another baseline) or a soft break (both sides in a script written without
//   spaces: CJK, kana, Thai, Lao, Khmer, Myanmar).
// - searchPageText (pure: no MuPDF) folds the text twice, each folded string mapped back to text
//   offsets: `joined` (hyphenated words whole, no-space scripts running on across lines) and
//   `literal` (the line-end hyphens kept), so "informazione" and "infor-mazione" are both found.
//   A native indexOf runs on both; overlapping hits are merged. Folding, by default (accents and
//   case ignored): NFKD with the diacritic marks dropped (only the combining blocks: Indic and
//   Thai vowel signs and kana voicing marks are letters), lower case, ς as σ, ß ẞ as ss, æ ae,
//   œ oe, ø o, ł l, đ d, ħ h, ı i (when case counts, a capital as capitals: Æ AE, ẞ SS);
//   apostrophes ’ ‘ ‛ ′ ʼ as ', quotes “ ” „ « » ‹ › as ", dashes ‐ ‑ ‒ – — ― − as -, any run of
//   spaces (NBSP, U+202F...) as one, soft hyphens, zero-width characters and bidi marks (LRM,
//   embeddings, isolates) as nothing; a TeX OT1 accent drawn over the next letter (a spacing
//   accent whose quad covers more than half of the letter's) is dropped, or composed with the
//   letter when accents count ("città" finds "citt`a"). With accents ignored, an apostrophe right after a
//   vowel that ends a word is dropped in the text and the query alike: Italian writes an accent
//   it cannot type that way ("perche'" finds "perché", "è vero" finds "E' vero"); a spacing
//   accent typed at the end of a word of the query goes too ("perche`"), not one inside a word
//   ("x^2", "file~1" are found as written). Options:
//   caseSensitive, matchDiacritics (NFC, combining marks composed onto the character before),
//   wholeWord (no letter or digit on either side, except at the edges of CJK; "dell'Università"
//   holds the whole word "Università").
// - A hit's quads: one per line run, the run's extent along the line by its characters' extent
//   across it, in MuPDF's corner order (ul, ur, ll, lr), equal to MuPDF's own search quads (to
//   the step above) where MuPDF finds the hit too; a hyphen the match read through is left out,
//   trailing combining marks are in. `before` and `after` are about 40 characters of the text
//   around it, cut at a space with "…". These are exact character boxes, full line height: an
//   area made from them must be shrunk, not grown, before a redaction
//   (redactGeometry.areasForQuads).
//
// Characters beyond U+FFFF: MuPDF.js 1.27's walk reads a character with String.fromCharCode,
// which keeps the low 16 bits (U+1D465, a maths x, arrives as U+D465, a Hangul syllable), so a
// query could match a character that is not there. The page's structured text as text (asText,
// UTF-8, every code point whole) is aligned with the walk and gives each such character back
// whole (two UTF-16 units in the text); when the two cannot be aligned (a NUL in the text), the
// drawn glyphs are read (a device pass, as session.linesBeyondBMP does) and matched by code and
// position. Any lone surrogate left becomes U+FFFD; a lone surrogate in a query matches nothing.
//
// MuPDF objects: the structured texts, the widgets' display lists, the Font wrapper the walk
// hands out for every character, the widgets and the page are destroyed here (ARCHITECTURE.md
// rule 5); the device pass destroys everything its callbacks receive and lets no exception leave
// a callback (images.guarded). Nothing is logged.
import type * as MuPDF from "mupdf";
import { joinVerticalLines } from "./core.js";
import { fieldTypeOf, fullName, isPasswordField } from "./forms";
import { guarded } from "./images";
import { MAX_SEARCH_CHARS } from "./protocol";
import type { Quad, Rect, SearchHit, SearchOptions } from "./protocol";

type MuPDFModule = typeof MuPDF;
type Doc = MuPDF.PDFDocument;
type Point = [number, number];

/**
 * A page's text for searching: the page's own text and each visible form field's appearance,
 * with the geometry its hits need, compact (typed arrays, no object per character: a session
 * keeps hundreds of them). Opaque to callers, but for `pageIndex` and `bytes`.
 */
export interface PageText {
  /**
   * The page its hits are on. A cache that keeps a PageText for a page that moved (a page
   * operation's layout.from) sets the page's new index here.
   */
  pageIndex: number;
  /** About how much memory it holds, in bytes (for a cache bound). */
  readonly bytes: number;
  /** The page's own text first (when it has any), then each visible field's, in /Annots order. */
  readonly segments: readonly TextSegment[];
}

/**
 * One text of a page: the page's own, or one field's appearance. `text` has the characters in
 * reading order (one UTF-16 unit each, two for a character beyond U+FFFF) and one separator
 * (SEP_*) between lines; the geometry arrays are indexed by text offset, line or run.
 */
interface TextSegment {
  /** Null for the page's own text, else the field's full name. */
  readonly field: string | null;
  readonly text: string;
  /** Offsets of TeX spacing accents drawn over the next letter, ascending (mostly NO_ACCENTS). */
  readonly accents: Int32Array;
  /**
   * Per text offset, two values: where the character starts and ends along its line's direction,
   * in steps of its line (the line's start + its step × value); 0, 0 on separators.
   */
  readonly along: Uint16Array;
  /** First text offset of each line, ascending. */
  readonly lineStart: Int32Array;
  /** Per line, four numbers: its direction (a unit vector), where its steps start along it, one step. */
  readonly lines: Float32Array;
  /** First text offset of each run of characters of one line sharing their extent across it, ascending. */
  readonly runStart: Int32Array;
  /** Per run: the extent across the line (min, max), across = y·dx − x·dy. */
  readonly runAcross: Float32Array;
}

/** What the stext walk is asked for: as core.extractLines, so lines and hits agree. */
const STEXT_OPTIONS = "preserve-whitespace";

// Separators between lines: control characters (one from a page is kept as a space, which is how
// a control character folds anyway), so a page of Latin-1 text stays a one-byte string in memory.
/** A line break: one space. */
const SEP_SPACE = "\x01";
/** MuPDF split one word in two lines touching on one baseline: nothing. */
const SEP_NONE = "\x02";
/** A word hyphenated at the line end: the hyphens before it are dropped in `joined`. */
const SEP_HYPHEN = "\x03";
/** A break between two characters of a script written without spaces (CJK, Thai): nothing in `joined`. */
const SEP_SOFT = "\x04";
const isSep = (c: string) => c >= SEP_SPACE && c <= SEP_SOFT;
/** What a lone surrogate of a query folds to: a character no folded text holds, so it matches nothing. */
const NEVER = "\x00";
/** Into how many steps a line's extent along it is cut (its characters' ends are kept as 16-bit steps). */
const STEPS = 0xffff;
const NO_ACCENTS = new Int32Array(0);

// ---------------------------------------------------------------------------------------------
// Reading a page

/** A character as the walk reads it. */
interface WalkedChar {
  c: string;
  origin: Point;
  /** Where the glyph is drawn (core.extractLines' glyphOrigin): the origin, but for vertical text. */
  glyphOrigin: Point;
  quad: Quad;
  size: number;
}

/** A line as the walk reads it, in the shape core.joinVerticalLines takes (`text` unused here). */
interface WalkedLine {
  bbox: Rect;
  wmode: number;
  dir: Point;
  chars: WalkedChar[];
  text: string;
  /** How many text blocks end after it (asText writes an empty line for each). */
  blockEnds: number;
}

/**
 * The page's text for searching: its own text (MuPDF's structured text of the page contents, as
 * core.extractLines reads it) and the appearance of each visible form field that is not a
 * password field. Loads the page and destroys everything it made.
 */
export function readPageText(mupdf: MuPDFModule, doc: Doc, pageIndex: number): PageText {
  const page = doc.loadPage(pageIndex);
  let widgets: MuPDF.PDFWidget[] = [];
  try {
    const segments: TextSegment[] = [];
    const own = segmentOf(mupdf, page.toStructuredText(STEXT_OPTIONS), (dev) => page.runPageContents(dev, mupdf.Matrix.identity), null);
    if (own) segments.push(own);
    widgets = [...page.getWidgets()];
    for (const w of widgets) {
      const o = w.getObject();
      if (!searchedField(o)) continue;
      // A comb field (a codice fiscale's boxes) draws each character in a cell of its own: MuPDF
      // would read a space between every two of them, and the value as typed would never match.
      const options = w.isComb() ? `${STEXT_OPTIONS},inhibit-spaces` : STEXT_OPTIONS;
      const dl = w.toDisplayList();
      try {
        const seg = segmentOf(mupdf, dl.toStructuredText(options), (dev) => dl.run(dev, mupdf.Matrix.identity), fullName(o));
        if (seg) segments.push(seg);
      } finally {
        dl.destroy();
      }
    }
    return pageTextOf(pageIndex, segments);
  } finally {
    for (const w of widgets) w.destroy();
    page.destroy();
  }
}

const F_HIDDEN = 2, F_NOVIEW = 32;

/** A widget whose appearance is searched: a form field, shown (not Hidden, not NoView), not a password. */
function searchedField(o: MuPDF.PDFObject): boolean {
  const f = o.get("F");
  if (f.isNumber() && f.asNumber() & (F_HIDDEN | F_NOVIEW)) return false;
  return fieldTypeOf(o) !== null && !isPasswordField(o);
}

/** A PageText of these segments, with its size: one byte per character of a Latin-1 text, else two. */
function pageTextOf(pageIndex: number, segments: TextSegment[]): PageText {
  let bytes = 64;
  for (const s of segments)
    bytes += 96 + (/[^\x00-\xff]/.test(s.text) ? 2 : 1) * s.text.length + 2 * (s.field?.length ?? 0) + s.accents.byteLength +
      s.along.byteLength + s.lineStart.byteLength + s.lines.byteLength + s.runStart.byteLength + s.runAcross.byteLength;
  return { pageIndex, bytes, segments };
}

/**
 * One text read from a structured text (destroyed here): walked, characters beyond U+FFFF given
 * back whole, vertical lines joined, laid out with separators. `run` draws the same content on a
 * device (for the rare page whose text and walk cannot be aligned). Null when it holds no text.
 */
function segmentOf(
  mupdf: MuPDFModule, st: MuPDF.StructuredText, run: (dev: MuPDF.Device) => void, field: string | null,
): TextSegment | null {
  let lines: WalkedLine[], leading: number, aligned: boolean;
  try {
    ({ lines, leading } = walk(st));
    aligned = restoreWide(lines, leading, st.asText());
  } finally {
    st.destroy();
  }
  if (!aligned) restoreWideFromGlyphs(mupdf, lines, run);
  return buildSegment(joinVerticalLines(lines.filter((l) => l.chars.length > 0)) as WalkedLine[], field);
}

/** A quad with every corner finite: a broken font's NaN or infinite box becomes a point at the origin. */
function finiteQuad(quad: Quad, origin: Point): Quad {
  if (quad.every(Number.isFinite)) return quad;
  const [x, y] = origin.every(Number.isFinite) ? origin : [0, 0];
  return [x, y, x, y, x, y, x, y];
}

/** The structured text's lines, as core.extractLines reads them (vertical quads moved back). */
function walk(st: MuPDF.StructuredText): { lines: WalkedLine[]; leading: number } {
  const lines: WalkedLine[] = [];
  let cur: WalkedLine | null = null, leading = 0;
  st.walk({
    beginLine(bbox, wmode, dir) {
      cur = { bbox, wmode, dir: [dir[0], dir[1]], chars: [], text: "", blockEnds: 0 };
      lines.push(cur);
    },
    onChar(c, origin, font, size, quad) {
      font.destroy();
      if (!cur) return;
      let glyphOrigin: Point = origin;
      if (cur.wmode === 1) {
        // MuPDF 1.27 starts a vertical character's quad at the glyph origin, 0.88 em too far
        // down the column (core.extractLines): moved back; the glyph origin is where it started.
        glyphOrigin = [quad[6], quad[7]];
        const s = 0.88 * size, d = cur.dir;
        quad = quad.map((v, i) => v - s * d[i % 2]) as Quad;
      }
      cur.chars.push({ c, origin, glyphOrigin, quad: finiteQuad(quad as Quad, origin), size: Number.isFinite(size) ? size : 0 });
    },
    endLine() {
      cur = null;
    },
    endTextBlock() {
      if (lines.length) lines[lines.length - 1].blockEnds++;
      else leading++;
    },
  });
  return { lines, leading };
}

/**
 * Gives characters beyond U+FFFF back whole, from the structured text as text (`asText`: each
 * line's characters then a line break, a line break after each block). False when the two do
 * not line up; the characters lined up so far are given back all the same.
 */
function restoreWide(lines: WalkedLine[], leading: number, text: string): boolean {
  let i = 0;
  const newline = () => text.charCodeAt(i) === 10 && ++i > 0;
  for (let k = 0; k < leading; k++) if (!newline()) return false;
  for (const l of lines) {
    for (const ch of l.chars) {
      const cp = text.codePointAt(i);
      if (cp === undefined) return false;
      const code = ch.c.charCodeAt(0);
      if (cp === code) i++;
      else if (cp > 0xffff && (cp & 0xffff) === code) {
        ch.c = String.fromCodePoint(cp);
        i += 2;
      } else return false;
    }
    for (let k = 0; k <= l.blockEnds; k++) if (!newline()) return false;
  }
  return i === text.length;
}

/**
 * The fallback of restoreWide: the drawn glyphs beyond U+FFFF (a device pass over the content),
 * each matched to a character with its cut code drawn at its place (as session.linesBeyondBMP).
 */
function restoreWideFromGlyphs(mupdf: MuPDFModule, lines: WalkedLine[], run: (dev: MuPDF.Device) => void) {
  const wide: { uni: number; x: number; y: number }[] = [];
  const g = guarded();
  const text = (t: MuPDF.Text, ctm: MuPDF.Matrix) => {
    // The glyph walk hands out Font wrappers (one shared while the font is the same): destroyed
    // once it is done, as decorations.devicePass does.
    const fonts = new Set<MuPDF.Font>();
    try {
      t.walk({
        beginSpan(font) { fonts.add(font); },
        showGlyph(font, trm, _gid, uni) {
          fonts.add(font);
          if (uni > 0xffff) {
            const m = mupdf.Matrix.concat(trm, ctm);
            wide.push({ uni, x: m[4], y: m[5] });
          }
        },
      });
    } finally {
      for (const f of fonts) f.destroy();
    }
  };
  const dev = new mupdf.Device({
    fillText(t, ctm, cs) { g.attempt(() => text(t, ctm), t, cs); },
    strokeText(t, stroke, ctm, cs) { g.attempt(() => text(t, ctm), t, stroke, cs); },
    clipText(t, ctm) { g.attempt(() => text(t, ctm), t); },
    clipStrokeText(t, stroke, ctm) { g.attempt(() => text(t, ctm), t, stroke); },
    ignoreText(t, ctm) { g.attempt(() => text(t, ctm), t); },
  });
  try {
    run(dev);
    dev.close();
  } finally {
    dev.destroy();
  }
  g.check("reading the page's glyphs");
  if (!wide.length) return;
  for (const l of lines)
    for (const ch of l.chars) {
      if (ch.c.length !== 1) continue;
      const code = ch.c.charCodeAt(0), [x, y] = ch.glyphOrigin, near = Math.max(1, ch.size / 2);
      const glyph = wide.find((w) => (w.uni & 0xffff) === code && Math.hypot(w.x - x, w.y - y) < near);
      if (glyph) ch.c = String.fromCodePoint(glyph.uni);
    }
}

const BLANK = /^[\s\u00a0\u00ad\u200b\ufeff]$/;
/** A character that reads as nothing at a line's ends: whitespace, soft hyphens, controls. */
const isBlank = (c: string) => BLANK.test(c) || c < " ";
const HYPHEN_AT_END = new Set(["-", "\u2010", "\u2011", "\u00ad"]);
const WORD = /[\p{L}\p{N}]/u;
const NOSPACE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\u3000-\u303f\uff00-\uffef]/u;
/** Spacing accents (TeX's OT1 fonts draw these over the next letter) and their combining marks. */
const SPACING_ACCENT = new Map<number, string>([
  [0x60, "\u0300"], [0xb4, "\u0301"], [0xa8, "\u0308"], [0x2c6, "\u0302"], [0x5e, "\u0302"], [0x2dc, "\u0303"], [0x7e, "\u0303"],
  [0xaf, "\u0304"], [0x2d8, "\u0306"], [0x2d9, "\u0307"], [0x2da, "\u030a"], [0x2dd, "\u030b"], [0x2c7, "\u030c"], [0xb8, "\u0327"],
  [0x2db, "\u0328"],
]);

/** Where a quad starts and ends along direction d (the middles of its two short sides). */
const along0 = (q: Quad, d: Point) => ((q[0] + q[4]) / 2) * d[0] + ((q[1] + q[5]) / 2) * d[1];
const along1 = (q: Quad, d: Point) => ((q[2] + q[6]) / 2) * d[0] + ((q[3] + q[7]) / 2) * d[1];
/** A point's position across direction d. */
const across = (x: number, y: number, d: Point) => y * d[0] - x * d[1];

/** The separator between the line ending at `prev.chars[last]` and the one starting at `l.chars[first]`. */
function lineBreak(prev: WalkedLine, last: number, l: WalkedLine, first: number): string {
  const a = prev.chars[last], b = l.chars[first];
  const size = Math.max(a.size, b.size);
  const sameDir = prev.dir[0] === l.dir[0] && prev.dir[1] === l.dir[1];
  const sameRow = sameDir && Math.abs(across(a.quad[4], a.quad[5], l.dir) - across(b.quad[4], b.quad[5], l.dir)) < 0.3 * size;
  if (sameRow && Math.abs(along0(b.quad, l.dir) - along1(a.quad, l.dir)) < 0.15 * size) return SEP_NONE;
  if (!sameRow && HYPHEN_AT_END.has(a.c)) {
    let h = last;
    while (h > 0 && HYPHEN_AT_END.has(prev.chars[h - 1].c)) h--;
    if (h > 0 && WORD.test(prev.chars[h - 1].c) && WORD.test(b.c)) return SEP_HYPHEN;
  }
  if (NOSPACE.test(a.c) && NOSPACE.test(b.c)) return SEP_SOFT;
  return SEP_SPACE;
}

/** Whether quad qa covers more than half of qb's extent along d (an accent drawn over a letter). */
function overlaps(qa: Quad, qb: Quad, d: Point): boolean {
  const a0 = along0(qa, d), a1 = along1(qa, d), b0 = along0(qb, d), b1 = along1(qb, d);
  return Math.min(a1, b1) - Math.max(a0, b0) > 0.5 * Math.max(1e-6, a1 - a0);
}

/** A character as kept in the text: a control character is a space (separators never come from a page), a lone surrogate U+FFFD. */
function keptChar(c: string): string {
  if (c.length !== 1) return c;
  const code = c.charCodeAt(0);
  return code < 0x20 ? " " : code >= 0xd800 && code <= 0xdfff ? "\ufffd" : c;
}

/** The lines laid out as one text with separators, and their geometry; null when there is no text. */
function buildSegment(lines: WalkedLine[], field: string | null): TextSegment | null {
  const units: string[] = [], along: number[] = [], accents: number[] = [];
  const lineStart: number[] = [], geometry: number[] = [], runStart: number[] = [], runAcross: number[] = [];
  const ends: number[] = []; // the current line's characters' ends along it, before they become steps
  let n = 0, prev: WalkedLine | null = null, prevLast = 0;
  for (const l of lines) {
    const chars = l.chars;
    let first = 0, last = chars.length - 1;
    while (first <= last && isBlank(chars[first].c)) first++;
    // (a soft hyphen at the end stays: lineBreak reads it as a hyphenated word's)
    while (last >= first && isBlank(chars[last].c) && chars[last].c !== "\u00ad") last--;
    if (first > last) continue; // a blank line reads as nothing
    if (prev) {
      units.push(lineBreak(prev, prevLast, l, first));
      along.push(0, 0);
      n++;
    }
    lineStart.push(n);
    const [d0, d1] = l.dir;
    let r0 = NaN, r1 = NaN, start = Infinity, end = -Infinity;
    ends.length = 0;
    for (let k = first; k <= last; k++) {
      const ch = chars[k], q = ch.quad, c = keptChar(ch.c);
      if (c.length === 1 && SPACING_ACCENT.has(c.charCodeAt(0)) && k < last && overlaps(q, chars[k + 1].quad, l.dir)) accents.push(n);
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (let j = 0; j < 8; j += 2) {
        const u = q[j] * d0 + q[j + 1] * d1, v = q[j + 1] * d0 - q[j] * d1;
        if (u < u0) u0 = u;
        if (u > u1) u1 = u;
        if (v < v0) v0 = v;
        if (v > v1) v1 = v;
      }
      if (u0 < start) start = u0;
      if (u1 > end) end = u1;
      const f0 = Math.fround(v0), f1 = Math.fround(v1);
      if (k === first || f0 !== r0 || f1 !== r1) {
        runStart.push(n);
        runAcross.push(f0, f1);
        r0 = f0;
        r1 = f1;
      }
      for (let j = 0; j < c.length; j++) ends.push(u0, u1);
      units.push(c);
      n += c.length;
    }
    // The line's extent in STEPS steps, start and step as float32 (as kept), each end rounded to its nearest step.
    const s0 = Math.fround(start), step = Math.fround((end - start) / STEPS);
    geometry.push(d0, d1, s0, step);
    for (const u of ends) along.push(step > 0 ? Math.min(STEPS, Math.max(0, Math.round((u - s0) / step))) : 0);
    prev = l;
    prevLast = last;
  }
  if (!n) return null;
  return {
    field,
    text: units.join(""),
    accents: accents.length ? Int32Array.from(accents) : NO_ACCENTS,
    along: Uint16Array.from(along),
    lineStart: Int32Array.from(lineStart),
    lines: Float32Array.from(geometry),
    runStart: Int32Array.from(runStart),
    runAcross: Float32Array.from(runAcross),
  };
}

// ---------------------------------------------------------------------------------------------
// Folding

/** The options as matching uses them. */
interface Mode {
  caseSensitive: boolean;
  wholeWord: boolean;
  matchDiacritics: boolean;
}

const COMBINING = /[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]/gu;
/** One combining mark (the blocks COMBINING drops). */
const MARK = /^[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]$/;
/** Soft hyphens, zero-width characters and the bidi marks, embeddings and isolates: nothing to a reader. */
const INVISIBLE = /[\u00ad\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\u061c\ufeff\u034f\u180e]/;
const SPACE = /[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;
const APOS = /[\u2019\u2018\u201b\u2032\u02bc\u02bb\uff07]/;
const QUOTE = /[\u201c\u201d\u201e\u201f\u00ab\u00bb\u2039\u203a\u2033\u301d\u301e\uff02]/;
const DASH = /[\u2010-\u2015\u2212\ufe58\ufe63\uff0d]/;
/** Letters NFKD leaves whole; a capital as capitals (with case ignored it was made lower case first). */
const SPECIAL: Record<string, string> = {
  "\u00df": "ss", "\u1e9e": "SS", "\u00e6": "ae", "\u00c6": "AE", "\u0153": "oe", "\u0152": "OE", "\u00f8": "o", "\u00d8": "O",
  "\u0142": "l", "\u0141": "L", "\u0111": "d", "\u0110": "D", "\u0127": "h", "\u0126": "H", "\u0131": "i", "\u0140": "l", "\u013f": "L",
};
const SPECIALS = /[\u00df\u1e9e\u00e6\u00c6\u0153\u0152\u00f8\u00d8\u0142\u0141\u0111\u0110\u0127\u0126\u0131\u0140\u013f]/g;

/** Folded characters, per case and accent mode (a few thousand distinct characters at most). */
const memo = new Map<string, Map<string, string>>();

/** A character (one UTF-16 unit, or a surrogate pair) as search compares it: "" (ignored), " ", or one or more units. */
function foldChar(c: string, o: Mode): string {
  const key = (o.caseSensitive ? "C" : "c") + (o.matchDiacritics ? "D" : "d");
  let m = memo.get(key);
  if (!m) memo.set(key, (m = new Map()));
  let f = m.get(c);
  if (f === undefined) {
    f = foldSlow(c, o);
    m.set(c, f);
  }
  return f;
}

function foldSlow(c: string, o: Mode): string {
  if (INVISIBLE.test(c)) return "";
  if (SPACE.test(c) || c < " ") return " ";
  if (APOS.test(c)) return "'";
  if (QUOTE.test(c)) return '"';
  if (DASH.test(c)) return "-";
  let f: string;
  if (!o.matchDiacritics) {
    f = c.normalize("NFKD").replace(COMBINING, "");
    if (!o.caseSensitive) f = f.toLowerCase();
    f = f.replace(SPECIALS, (x) => SPECIAL[x]);
    f = f.normalize("NFKD").replace(COMBINING, "");
  } else {
    f = c.normalize("NFKC");
    if (!o.caseSensitive) f = f.toLowerCase().replace(/\u00df|\u1e9e/g, "ss");
  }
  if (!o.caseSensitive) f = f.replace(/\u03c2/g, "\u03c3");
  return f;
}

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** The character (a unit, or a surrogate pair) starting at unit k of `s`. */
function charAt(s: ArrayLike<string> & { length: number }, k: number): string {
  const a = s[k];
  if (a === undefined) return "";
  const b = s[k + 1];
  return a.length === 1 && isHigh(a.charCodeAt(0)) && b !== undefined && isLow(b.charCodeAt(0)) ? a + b : a;
}

/** The character (a unit, or a surrogate pair) ending at unit k of `s`. */
function charEndingAt(s: ArrayLike<string> & { length: number }, k: number): string {
  const b = s[k];
  if (b === undefined) return "";
  const a = s[k - 1];
  return b.length === 1 && isLow(b.charCodeAt(0)) && a !== undefined && isHigh(a.charCodeAt(0)) ? a + b : b;
}

const VOWEL = /^[aeiouAEIOU]$/;

/** A folded string being built: its units and, for each, the text offset it came from (-1: a line break). */
interface Builder {
  s: string[];
  src: number[];
}

/**
 * Italian writes an accent it cannot type as an apostrophe ("perche'", "citta'", "E' vero"): with
 * diacritics ignored, an apostrophe right after a vowel that ends a word is dropped, in the text
 * and in the query alike, so "perche'" finds "perché" and "è" finds "E'" ("po'" reads "po").
 */
function dropAccentApostrophes(B: Builder) {
  const { s, src } = B;
  let w = 0;
  for (let k = 0; k < s.length; k++) {
    if (s[k] === "'" && k > 0 && VOWEL.test(s[k - 1]) && !WORD.test(charAt(s, k + 1))) continue;
    s[w] = s[k];
    src[w] = src[k];
    w++;
  }
  s.length = w;
  src.length = w;
}

/** The query folded as the text is; runs of spaces one space; trimmed. */
function foldQuery(query: string, o: Mode): string {
  const chars = [...(o.matchDiacritics ? query.normalize("NFC") : query)];
  let s = "";
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i], code = c.charCodeAt(0);
    // "perche`": a spacing accent typed at the end of a word is an accent, dropped with the others
    // (inside a word it is itself: "x^2", "file~1" are found as written)
    const ends = i + 1 === chars.length || !WORD.test(chars[i + 1]);
    if (!o.matchDiacritics && c.length === 1 && SPACING_ACCENT.has(code) && i > 0 && WORD.test(chars[i - 1]) && ends) continue;
    s += c.length === 1 && (isHigh(code) || isLow(code)) ? NEVER : foldChar(c, o);
  }
  if (o.matchDiacritics) s = s.normalize("NFC");
  else {
    const B: Builder = { s: s.split(""), src: [] };
    B.src.length = B.s.length;
    dropAccentApostrophes(B);
    s = B.s.join("");
  }
  return s.replace(/ +/g, " ").trim();
}

/** A folded text: the folded string and, per unit, the text offset it came from (-1: a line break). */
interface Folded {
  s: string;
  src: Int32Array;
}

/**
 * The text folded twice: `joined` (hyphenated words whole, no-space scripts run on) and `literal`
 * (the line-end hyphens kept). Runs of spaces are one space.
 */
function foldSegment(seg: TextSegment, o: Mode): { joined: Folded; literal: Folded } {
  const text = seg.text, acc = seg.accents;
  const J: Builder = { s: [], src: [] }, L: Builder = { s: [], src: [] };
  const put = (B: Builder, f: string, i: number) => {
    for (let k = 0; k < f.length; k++) {
      B.s.push(f[k]);
      B.src.push(i);
    }
  };
  const space = (B: Builder, i: number) => {
    if (B.s.length && B.s[B.s.length - 1] !== " ") put(B, " ", i);
  };
  let mark = "", ai = 0;
  for (let i = 0; i < text.length; i++) {
    let c = text[i];
    if (isSep(c)) {
      mark = "";
      if (c === SEP_SPACE) {
        space(J, -1);
        space(L, -1);
      } else if (c === SEP_SOFT) space(L, -1);
      else if (c === SEP_HYPHEN)
        while (J.s.length && J.src[J.src.length - 1] >= 0 && HYPHEN_AT_END.has(text[J.src[J.src.length - 1]])) {
          J.s.pop();
          J.src.pop();
        }
      continue;
    }
    while (ai < acc.length && acc[ai] < i) ai++;
    if (ai < acc.length && acc[ai] === i) {
      if (o.matchDiacritics) mark = SPACING_ACCENT.get(c.charCodeAt(0)) ?? "";
      continue;
    }
    const wide = isHigh(c.charCodeAt(0)) && i + 1 < text.length && isLow(text.charCodeAt(i + 1));
    if (wide) c = text.slice(i, i + 2);
    let f = foldChar(c, o);
    if (mark) {
      f = (f + mark).normalize("NFC");
      mark = "";
    }
    if (f === " ") {
      space(J, i);
      space(L, i);
    } else if (o.matchDiacritics && f && f.replace(COMBINING, "") === "") {
      // a combining mark: onto the character before
      for (const B of [J, L]) {
        const k = B.s.length - 1, comp = k >= 0 && B.src[k] >= 0 ? (B.s[k] + f).normalize("NFC") : "";
        if (comp.length === 1) B.s[k] = comp;
        else put(B, f, i);
      }
    } else {
      put(J, f, i);
      put(L, f, i);
    }
    if (wide) i++;
  }
  if (!o.matchDiacritics) {
    dropAccentApostrophes(J);
    dropAccentApostrophes(L);
  }
  const fin = (B: Builder): Folded => ({ s: B.s.join(""), src: Int32Array.from(B.src) });
  return { joined: fin(J), literal: fin(L) };
}

// ---------------------------------------------------------------------------------------------
// Matching

/** A hit: the first and last text offsets it covers, and whether it was found in `joined`. */
type Span = [lo: number, hi: number, joined: boolean];

function findIn(B: Folded, text: string, q: string, o: Mode, out: Span[], joined: boolean) {
  const s = B.s;
  for (let at = s.indexOf(q); at >= 0; ) {
    const end = at + q.length;
    if (o.wholeWord) {
      const b = charEndingAt(s, at - 1), e = charAt(s, end);
      if ((b && WORD.test(b) && !NOSPACE.test(charAt(s, at))) || (e && WORD.test(e) && !NOSPACE.test(charEndingAt(s, end - 1)))) {
        at = s.indexOf(q, at + 1);
        continue;
      }
    }
    let lo = -1, hi = -1;
    for (let k = at; k < end; k++) {
      const i = B.src[k];
      if (i >= 0) {
        if (lo < 0) lo = i;
        hi = i;
      }
    }
    at = s.indexOf(q, end);
    if (lo < 0) continue;
    if (isHigh(text.charCodeAt(hi)) && isLow(text.charCodeAt(hi + 1))) hi++; // the whole character
    // trailing soft hyphens, zero-width characters and combining marks belong to the hit
    while (hi + 1 < text.length && !isSep(text[hi + 1]) && foldChar(text[hi + 1], o) === "") hi++;
    while (hi + 1 < text.length && MARK.test(text[hi + 1])) hi++;
    out.push([lo, hi, joined]);
  }
}

/** The hits of folded query `q` in a segment: text offsets, in reading order, not overlapping. */
function findInSegment(folded: { joined: Folded; literal: Folded }, text: string, q: string, o: Mode): Span[] {
  const all: Span[] = [];
  findIn(folded.joined, text, q, o, all, true);
  if (folded.literal.s !== folded.joined.s) findIn(folded.literal, text, q, o, all, false);
  all.sort((x, y) => x[0] - y[0] || y[1] - x[1]);
  const kept: Span[] = [];
  for (const h of all) {
    const p = kept[kept.length - 1];
    if (p && h[0] <= p[1]) continue;
    kept.push(h);
  }
  return kept;
}

/** The index of the last entry of `starts` (ascending) at or before offset i. */
function lastAtOrBefore(starts: Int32Array, i: number): number {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= i) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Whether the hyphens from offset i on end at a hyphenated line break. */
function hyphenBeforeBreak(text: string, i: number): boolean {
  while (HYPHEN_AT_END.has(text[i])) i++;
  return text[i] === SEP_HYPHEN;
}

/** One quad per line the hit runs over (MuPDF's corner order: ul, ur, ll, lr). */
function hitQuads(seg: TextSegment, [lo, hi, joined]: Span): Quad[] {
  const { text, along, lines, runStart, runAcross } = seg;
  const out: Quad[] = [];
  let line = lastAtOrBefore(seg.lineStart, lo), run = lastAtOrBefore(runStart, lo);
  let a0 = Infinity, a1 = -Infinity, n0 = Infinity, n1 = -Infinity, any = false;
  const flush = () => {
    if (!any) return;
    const d0 = lines[4 * line], d1 = lines[4 * line + 1], start = lines[4 * line + 2], step = lines[4 * line + 3];
    // back from the line's frame (u along d, in steps from its start; v across it: the normal is (-d1, d0))
    const P = (a: number, v: number): Point => {
      const u = start + a * step;
      return [u * d0 - v * d1, u * d1 + v * d0];
    };
    out.push([...P(a0, n0), ...P(a1, n0), ...P(a0, n1), ...P(a1, n1)] as Quad);
    a0 = n0 = Infinity;
    a1 = n1 = -Infinity;
    any = false;
  };
  for (let i = lo; i <= hi; i++) {
    const c = text[i];
    if (isSep(c)) {
      flush();
      line++;
      continue;
    }
    if (!any && isBlank(c)) continue;
    if (joined && HYPHEN_AT_END.has(c) && hyphenBeforeBreak(text, i)) continue; // the hyphen the match read through
    while (run + 1 < runStart.length && runStart[run + 1] <= i) run++;
    const u0 = along[2 * i], u1 = along[2 * i + 1], v0 = runAcross[2 * run], v1 = runAcross[2 * run + 1];
    if (u0 < a0) a0 = u0;
    if (u1 > a1) a1 = u1;
    if (v0 < n0) n0 = v0;
    if (v1 > n1) n1 = v1;
    any = true;
  }
  flush();
  return out;
}

/** The text as a reader reads it: separators as a space or nothing, soft hyphens out, spaces one. */
const display = (t: string) => t.replace(/[\x02-\x04\u00ad]/g, "").replace(/[\x01\s\u00a0]+/g, " ");

/** The text around a hit, for a result list: about `width` characters each side, cut at a space. */
function hitContext(text: string, lo: number, hi: number, width = 40): { before: string; match: string; after: string } {
  let before = display(text.slice(Math.max(0, lo - 3 * width), lo)), after = display(text.slice(hi + 1, hi + 1 + 3 * width));
  if (before.length > width) {
    before = before.slice(-width);
    if (isLow(before.charCodeAt(0))) before = before.slice(1);
    const sp = before.indexOf(" ");
    before = "\u2026" + (sp >= 0 && sp < width / 2 ? before.slice(sp + 1) : before);
  }
  if (after.length > width) {
    after = after.slice(0, width);
    if (isHigh(after.charCodeAt(after.length - 1))) after = after.slice(0, -1);
    const sp = after.lastIndexOf(" ");
    after = (sp > width / 2 ? after.slice(0, sp) : after) + "\u2026";
  }
  return { before, match: display(text.slice(lo, hi + 1)), after };
}

/** The quads' bounds. */
function bounds(quads: Quad[]): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const q of quads)
    for (let k = 0; k < 8; k += 2) {
      if (q[k] < x0) x0 = q[k];
      if (q[k] > x1) x1 = q[k];
      if (q[k + 1] < y0) y0 = q[k + 1];
      if (q[k + 1] > y1) y1 = q[k + 1];
    }
  return [x0, y0, x1, y1];
}

/**
 * The hits of `query` in a page's text, in order (the page's own text in reading order, then
 * each field's), at most `maxHits`. Pure: reads nothing but `text`. The query is folded here
 * (normalizeQuery first, for the limits); one that folds to nothing finds nothing.
 */
export function searchPageText(text: PageText, query: string, options: SearchOptions = {}, maxHits = Infinity): SearchHit[] {
  const o: Mode = { caseSensitive: !!options.caseSensitive, wholeWord: !!options.wholeWord, matchDiacritics: !!options.matchDiacritics };
  const hits: SearchHit[] = [];
  const q = typeof query === "string" ? foldQuery(query, o) : "";
  if (!q || !(maxHits >= 1)) return hits;
  for (const seg of text.segments) {
    for (const span of findInSegment(foldSegment(seg, o), seg.text, q, o)) {
      if (hits.length >= maxHits) return hits;
      const quads = hitQuads(seg, span);
      if (!quads.length) continue;
      const hit: SearchHit = { pageIndex: text.pageIndex, quads, rect: bounds(quads), in: seg.field === null ? "page" : "field", before: "", match: "", after: "" };
      if (seg.field !== null) hit.field = seg.field;
      Object.assign(hit, hitContext(seg.text, span[0], span[1]));
      hits.push(hit);
    }
  }
  return hits;
}

/** Whitespace and invisible characters (INVISIBLE's) at a query's ends. */
const EDGES = /^[\s\u00ad\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\u061c\ufeff\u034f\u180e]+|[\s\u00ad\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\u061c\ufeff\u034f\u180e]+$/g;

/**
 * A query as the session searches it: trimmed (spaces and invisible characters), at most
 * MAX_SEARCH_CHARS UTF-16 units (cut, never inside a character); null when nothing is left or
 * it is no string.
 */
export function normalizeQuery(query: string): string | null {
  if (typeof query !== "string") return null;
  let q = query.replace(EDGES, "");
  if (q.length > MAX_SEARCH_CHARS) {
    q = q.slice(0, MAX_SEARCH_CHARS);
    if (isHigh(q.charCodeAt(q.length - 1))) q = q.slice(0, -1);
    q = q.replace(EDGES, "");
  }
  return q ? q : null;
}
