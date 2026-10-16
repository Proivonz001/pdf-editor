// PDF/A-2b ("PDF/A per l'archivio", ISO 19005-2 level B) with MuPDF only.
//
// convertToPdfA rewrites an open document in place (the session gives it a scratch copy) and
// reports, as protocol codes, what stops the conversion (blockers), what it removes or changes
// (removals, which the UI confirms first), what is worth telling (warnings) and how many silent
// technical fixes it made. checkPdfA re-opens the saved bytes and checks them again: the
// session never hands out a file that fails it. Neither replaces veraPDF, the reference
// validator, which runs on the test corpus in CI (ARCHITECTURE.md, "PDF/A").
//
// Ported from the phase 3 prototype (pdfa-lib.mjs, validated on 10 files). What it does:
// - fonts: every font used for drawing must be embedded. Missing standard fonts and their metric
//   twins (Arial = Helvetica, Times New Roman = Times, Courier New = Courier) get MuPDF's
//   built-in URW program, with the widths of that program; any other missing font blocks.
//   Widths in embedded fonts must agree with their programs, and no text may use the .notdef
//   glyph: both block, since fixing them would move or change text;
// - colour: our own sRGB profile (icc.ts) as the output intent, unless the file has a usable one
//   of its own: an RGB one, or a CMYK one when nothing uses DeviceRGB (a print PDF/A). DeviceCMYK
//   with an RGB intent blocks (no CMYK profile with a clear licence of our own yet), and so does
//   a broken or too new ICC profile;
// - JavaScript, forbidden actions, form button actions, attachments, hidden or forbidden
//   annotations and static XFA data are removed; dynamic XFA, portfolios and external content
//   block. Signature values are removed too: a re-saved signature is broken, and PDF/A forbids a
//   signature whose byte range does not cover the file;
// - XMP metadata (pdfaid part 2, conformance B, in step with the Info dictionary; none on other
//   objects), a file /ID, annotation appearances and flags, and the small structural fixes (LZW,
//   Interpolate, transfer functions, rendering intents, optional content names, font
//   dictionaries).
//
// Which fonts are "used" is decided the way veraPDF decides it: a font selected with Tf in a
// content stream (pages, form XObjects, every annotation appearance state, patterns, soft masks,
// Type 3 glyphs), whatever layer it is on. Text drawn invisibly (rendering mode 3, OCR layers)
// needs no embedded font and no widths that match a program, but PDF/A rules hold for it
// otherwise: no .notdef glyph, and a complete font dictionary. Colours are read the same way,
// from the content as written: veraPDF does not hide what a layer that is off or an appearance
// state not shown would hide.
//
// MuPDF objects: pages, documents, devices, buffers, fonts and the wrappers device callbacks
// receive are destroyed explicitly (ARCHITECTURE.md rule 5). PDFObject wrappers are left to the
// garbage collector, as everywhere else in the engine.
import type * as MuPDF from "mupdf";
import { SRGB_PROFILE_NAME, srgbProfile } from "./icc";
import type { PdfaBlockerCode, PdfaIssue, PdfaRemovalCode, PdfaReport, PdfaWarningCode } from "./protocol";

type MuPDFModule = typeof MuPDF;
type Doc = MuPDF.PDFDocument;
type Obj = MuPDF.PDFObject;

/** Options for convertToPdfA (the tests fix the date). */
export interface ConvertOptions {
  /** The modification date written into the metadata. Default: now. */
  now?: Date;
}

// ---------------------------------------------------------------------------------------------
// Rules

/** Action types PDF/A-2 allows (ISO 19005-2 6.5.1); Named actions only for page navigation. */
const ALLOWED_ACTIONS = new Set(["GoTo", "GoToR", "GoToE", "Thread", "URI", "Named", "SubmitForm"]);
const ALLOWED_NAMED = new Set(["NextPage", "PrevPage", "FirstPage", "LastPage"]);
/** Annotation types of ISO 32000-1; anything else is not allowed in PDF/A-2. */
const ISO_ANNOTS = new Set(["Text", "Link", "FreeText", "Line", "Square", "Circle", "Polygon", "PolyLine",
  "Highlight", "Underline", "Squiggly", "StrikeOut", "Stamp", "Caret", "Ink", "Popup", "FileAttachment", "Sound",
  "Movie", "Widget", "Screen", "PrinterMark", "TrapNet", "Watermark", "3D", "Redact"]);
/** ...and of those, the ones PDF/A-2 forbids (a FileAttachment would need a PDF/A attachment). */
const FORBIDDEN_ANNOTS = new Set(["3D", "Sound", "Screen", "Movie", "FileAttachment"]);
const STANDARD_BLEND = new Set(["Normal", "Compatible", "Multiply", "Screen", "Overlay", "Darken", "Lighten",
  "ColorDodge", "ColorBurn", "HardLight", "SoftLight", "Difference", "Exclusion", "Hue", "Saturation", "Color",
  "Luminosity"]);
/** The rendering intents of ISO 32000-1 (8.6.5.8); PDF/A-2 allows no other (6.2.6). */
const STANDARD_INTENTS = new Set(["RelativeColorimetric", "AbsoluteColorimetric", "Perceptual", "Saturation"]);
const F_INVISIBLE = 1, F_HIDDEN = 2, F_PRINT = 4, F_NOVIEW = 32, F_TOGGLENOVIEW = 256;
const HIDING_FLAGS = F_INVISIBLE | F_HIDDEN | F_NOVIEW | F_TOGGLENOVIEW;
/** Button field flags (Ff): radio button, push button. */
const FF_RADIO = 1 << 15, FF_PUSHBUTTON = 1 << 16;
const FONT_SUBTYPES = new Set(["Type1", "MMType1", "TrueType", "Type3", "Type0", "CIDFontType0", "CIDFontType2"]);
const SIMPLE_FONTS = new Set(["Type1", "MMType1", "TrueType"]);

/** The value written as the output intent's condition: the profile describes standard sRGB. */
const OUTPUT_CONDITION = "sRGB IEC61966-2.1";

// ---------------------------------------------------------------------------------------------
// Small object helpers

function nameOf(o: Obj, key: string): string | null {
  const v = o.get(key);
  return v.isName() ? v.asName() : null;
}

function intOf(o: Obj, key: string): number {
  const v = o.get(key);
  return v.isNumber() ? v.asNumber() : 0;
}

function boolOf(o: Obj, key: string): boolean {
  const v = o.get(key);
  return v.isBoolean() && v.asBoolean();
}

const untag = (name: string) => name.replace(/^[A-Z]{6}\+/, "");

/** A stable key for an object: its number when indirect, else its MuPDF pointer. */
const objKey = (o: Obj) => (o.isIndirect() ? `n${o.asIndirect()}` : `p${o.pointer}`);

/** A stream's decoded bytes, copied out of the wasm heap. */
function streamBytes(o: Obj): Uint8Array {
  const buf = o.readStream();
  try {
    return buf.asUint8Array().slice();
  } finally {
    buf.destroy();
  }
}

/** Adds a stream made from `bytes`, destroying the temporary MuPDF Buffer. */
function addStream(mupdf: MuPDFModule, doc: Doc, bytes: Uint8Array | string, dict: Record<string, unknown>): Obj {
  // Two calls: the constructor's overloads each take one of the types.
  const buf = typeof bytes === "string" ? new mupdf.Buffer(bytes) : new mupdf.Buffer(bytes);
  try {
    return doc.addStream(buf, dict);
  } finally {
    buf.destroy();
  }
}

const catalog = (doc: Doc) => doc.getTrailer().get("Root");

/**
 * An object's content as text (an indirect one resolved), for keys of the probe caches: two
 * objects that print the same, references included, behave the same.
 */
const serialized = (o: Obj) => (o.isNull() ? "" : o.isIndirect() ? o.resolve().toString(true) : o.toString(true));

/** Whether a dictionary holds at least one stream (an appearance state dictionary). */
function hasStream(dict: Obj): boolean {
  let found = false;
  dict.forEach((v) => { if (v.isStream()) found = true; });
  return found;
}

/**
 * A field entry a widget inherits (FT, Ff, V): its own, else its parent field's and so on up, as
 * viewers and veraPDF resolve it. null when no field in the chain has it.
 */
function inheritedField(o: Obj, key: string): Obj | null {
  let node = o;
  const seen = new Set<string>();
  for (let depth = 0; depth < 32 && node.isDictionary(); depth++) {
    const v = node.get(key);
    if (!v.isNull()) return v;
    const k = objKey(node);
    if (seen.has(k)) break;
    seen.add(k);
    node = node.get("Parent");
  }
  return null;
}

/** A widget of a button field (push button, check box, radio button). */
function isButton(o: Obj): boolean {
  const ft = inheritedField(o, "FT");
  return !!ft && ft.isName() && ft.asName() === "Btn";
}

interface WalkContext {
  /** The key under which the object was found (for an array element: the array's key). */
  key: string;
  /** The key under which its container was found. */
  parentKey: string | null;
}

/**
 * Visits every dictionary and array reachable from the trailer once (indirect objects by number;
 * direct ones cannot form cycles). Streams are visited as their dictionaries. `visit` returning
 * false skips the object's children, so a key it deletes is never walked into.
 */
function walk(doc: Doc, visit: (o: Obj, ctx: WalkContext) => boolean | void) {
  const seen = new Set<number>();
  const stack: [Obj, WalkContext][] = [[doc.getTrailer(), { key: "trailer", parentKey: null }]];
  while (stack.length) {
    const [o, ctx] = stack.pop()!;
    if (o.isIndirect()) {
      const n = o.asIndirect();
      if (seen.has(n)) continue;
      seen.add(n);
    }
    if (o.isDictionary()) {
      if (visit(o, ctx) === false) continue;
      o.forEach((v, k) => {
        if (v.isDictionary() || v.isArray()) stack.push([v, { key: String(k), parentKey: ctx.key }]);
      });
    } else if (o.isArray()) {
      if (visit(o, ctx) === false) continue;
      o.forEach((v) => {
        if (v.isDictionary() || v.isArray()) stack.push([v, { key: ctx.key, parentKey: ctx.parentKey }]);
      });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Reading what a file claims (also used by EngineSession.describe)

const PDFAID_NS = "http://www.aiim.org/pdfa/ns/id/";

/**
 * The PDF/A part and conformance claimed in the catalog's XMP metadata ("2B", "1A"; "4" when a
 * part has no conformance level), or null when there is none or it cannot be read. Accepts the
 * attribute form (pdfaid:part="2") and the element form (<pdfaid:part>2</pdfaid:part>).
 */
export function pdfaClaim(doc: Doc): string | null {
  try {
    const meta = catalog(doc).get("Metadata");
    if (!meta.isStream()) return null;
    const xmp = new TextDecoder().decode(streamBytes(meta));
    // The namespace prefix is nearly always "pdfaid", but any prefix bound to the namespace counts.
    const prefixes = new Set(["pdfaid"]);
    for (const m of xmp.matchAll(/xmlns:([\w.-]+)\s*=\s*["']([^"']*)["']/g)) if (m[2] === PDFAID_NS) prefixes.add(m[1]);
    const read = (prop: string) => {
      for (const p of prefixes) {
        const q = `${p}:${prop}`;
        const m = new RegExp(`${q}\\s*=\\s*["']\\s*([^"'<\\s]+)\\s*["']`).exec(xmp) ??
          new RegExp(`<${q}>\\s*([^<\\s]+)\\s*</${q}>`).exec(xmp);
        if (m) return m[1];
      }
      return null;
    };
    const part = read("part");
    if (!part || !/^\d+$/.test(part)) return null;
    return part + (read("conformance") ?? "").toUpperCase();
  } catch {
    return null;
  }
}

/**
 * Removes the PDF/A claim (pdfaid part, conformance, amd, rev) from the catalog's XMP, for a file
 * saved as a normal PDF after edits: nothing checked that it still conforms, so it must not say
 * it does. The rest of the metadata stays. Returns whether there was a claim to remove.
 */
export function dropPdfaClaim(mupdf: MuPDFModule, doc: Doc): boolean {
  if (pdfaClaim(doc) === null) return false;
  const cat = catalog(doc);
  const meta = cat.get("Metadata");
  const xmp = new TextDecoder().decode(streamBytes(meta));
  const prefixes = new Set(["pdfaid"]);
  for (const m of xmp.matchAll(/xmlns:([\w.-]+)\s*=\s*["']([^"']*)["']/g)) if (m[2] === PDFAID_NS) prefixes.add(m[1]);
  let out = xmp;
  for (const p of prefixes) {
    for (const prop of ["part", "conformance", "amd", "rev"]) {
      const q = `${p}:${prop}`;
      out = out
        .replace(new RegExp(`\\s${q}\\s*=\\s*(["'])[^"']*\\1`, "g"), "")
        .replace(new RegExp(`\\s*<${q}>[^<]*</${q}>`, "g"), "");
    }
  }
  // A new stream (the old one may be shared or filtered); MuPDF leaves Metadata streams unfiltered.
  cat.put("Metadata", addStream(mupdf, doc, out, { Type: "Metadata", Subtype: "XML" }));
  return true;
}

/**
 * Signature fields that hold a signature: the AcroForm field tree (/Fields, /Kids, with /FT
 * inherited from the parent) walked for fields of type /Sig with a signature dictionary as /V.
 * Reads no page.
 */
function signedFields(doc: Doc): Obj[] {
  const acro = catalog(doc).get("AcroForm");
  if (!acro.isDictionary()) return [];
  const fields = acro.get("Fields");
  if (!fields.isArray()) return [];
  const seen = new Set<number>();
  const signed: Obj[] = [];
  const visit = (field: Obj, inheritedType: string | null, depth: number) => {
    if (depth > 32 || !field.isDictionary()) return;
    if (field.isIndirect()) {
      if (seen.has(field.asIndirect())) return;
      seen.add(field.asIndirect());
    }
    const type = nameOf(field, "FT") ?? inheritedType;
    if (type === "Sig" && field.get("V").isDictionary()) signed.push(field);
    const kids = field.get("Kids");
    if (kids.isArray()) for (let i = 0; i < kids.length; i++) visit(kids.get(i), type, depth + 1);
  };
  for (let i = 0; i < fields.length; i++) visit(fields.get(i), null, 0);
  return signed;
}

/** How many signature fields hold a digital signature (DocInfo.signatures). */
export const countSignatures = (doc: Doc) => signedFields(doc).length;

// ---------------------------------------------------------------------------------------------
// Fonts

const BASE14 = ["Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique",
  "Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique",
  "Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic", "Symbol", "ZapfDingbats"];
const BASE14_FLAGS: Record<string, number> = { Courier: 33, Helvetica: 32, Times: 34, Symbol: 4, ZapfDingbats: 4 };
const CAP_HEIGHT: Record<string, number> = { Courier: 562, Helvetica: 718, Times: 662 };

/**
 * The standard font a non-embedded font can be embedded as without changing its look: the 14
 * standard names, and the metric-compatible names Acrobat treats as aliases (Arial = Helvetica,
 * Times New Roman = Times, Courier New = Courier). null for anything else.
 */
export function standardFontFor(baseFont: string): string | null {
  const n = untag(baseFont);
  if (BASE14.includes(n)) return n;
  if (n === "Times") return "Times-Roman";
  const m = /^(Arial|ArialMT|Helvetica|TimesNewRoman|TimesNewRomanPS|TimesNewRomanPSMT|Times|CourierNew|CourierNewPSMT|CourierNewPS|Courier)(?:[,-](Bold|Italic|Oblique|BoldItalic|BoldOblique)(?:MT)?)?$/.exec(n.replace(/ /g, ""));
  if (!m) return null;
  const family = /^Arial|^Helvetica/.test(m[1]) ? "Helvetica" : /^Times/.test(m[1]) ? "Times" : "Courier";
  const style = m[2] ?? "";
  const bold = style.includes("Bold"), italic = /Italic|Oblique/.test(style);
  if (family === "Times") return ["Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic"][(bold ? 1 : 0) + (italic ? 2 : 0)];
  return family + (bold && italic ? "-BoldOblique" : bold ? "-Bold" : italic ? "-Oblique" : "");
}

const familyOf = (std: string) =>
  std.startsWith("Times") ? "Times" : std.startsWith("Courier") ? "Courier" : std.startsWith("Helvetica") ? "Helvetica" : std;

/** Font dictionaries: Type /Font, or a font Subtype with a BaseFont or CharProcs. */
function isFontDict(o: Obj): boolean {
  if (nameOf(o, "Type") === "Font") return true;
  const st = nameOf(o, "Subtype");
  return st !== null && FONT_SUBTYPES.has(st) && (!o.get("BaseFont").isNull() || !o.get("CharProcs").isNull());
}

interface FontStatus {
  subtype: string;
  base: string;
  embedded: boolean;
  /** The descriptor holding the font program (the descendant's for a Type 0 font). */
  descriptor: Obj;
}

function fontStatus(font: Obj): FontStatus {
  const subtype = nameOf(font, "Subtype") ?? "?";
  const base = nameOf(font, "BaseFont") ?? "";
  if (subtype === "Type3") return { subtype, base, embedded: true, descriptor: font.get("FontDescriptor") };
  const fd = subtype === "Type0" ? font.get("DescendantFonts", 0, "FontDescriptor") : font.get("FontDescriptor");
  const embedded = fd.isDictionary() && ["FontFile", "FontFile2", "FontFile3"].some((k) => !fd.get(k).isNull());
  return { subtype, base, embedded, descriptor: fd };
}

/** Bytes per character code: 1 for simple fonts, 2 for Identity-H/V Type 0 fonts, 0 when unknown. */
function codeLength(font: Obj): 0 | 1 | 2 {
  const subtype = nameOf(font, "Subtype");
  if (subtype !== "Type0") return 1;
  const enc = nameOf(font, "Encoding");
  return enc === "Identity-H" || enc === "Identity-V" ? 2 : 0;
}

/** How a font is used by the content. */
interface FontUse {
  /** The codes drawn visibly, or null when the code length is not known (a CMap other than Identity). */
  codes: Set<number> | null;
  /** The codes shown in any rendering mode (3, invisible, included), or null likewise. */
  allCodes: Set<number> | null;
  /** Shown at least once in any rendering mode. */
  shown: boolean;
  /** Shown at least once in a rendering mode that paints or clips (not 3, invisible). */
  shownVisibly: boolean;
}

/** A font needs embedding when it draws visibly, or is selected and never shown (to be safe). */
const drawsVisibly = (u: FontUse | undefined) => !!u && (u.shownVisibly || !u.shown);

/** Rendering intent names PDF/A does not know, found in one content stream (or a page's array). */
interface IntentNames {
  /** The content stream, or the array of a page's /Contents (then `page` is that page). */
  content: Obj;
  page: Obj | null;
  /** The bytes read (an array's streams joined) and where the names (with their "/") are in them. */
  bytes: Uint8Array;
  ranges: [number, number][];
}

/** What the content streams draw, read from the streams as written. */
interface ContentUse {
  /** The fonts selected (Tf) and the codes shown with them, by objKey. */
  fonts: Map<string, FontUse>;
  /** DeviceCMYK set by an operator (k, K, cs, CS) or an inline image, with no DefaultCMYK in force. */
  deviceCMYK: boolean;
  /** The same for DeviceRGB (rg, RG...). */
  deviceRGB: boolean;
  /** Rendering intents outside the four standard ones (ri operands, inline image /Intent). */
  intents: IntentNames[];
}

/** Whether a DefaultCMYK / DefaultRGB colour space stands in for the device one (ISO 32000-1 8.6.5.6). */
interface Defaults {
  cmyk: boolean;
  rgb: boolean;
}
const NO_DEFAULTS: Defaults = { cmyk: false, rgb: false };

/**
 * Reads every content stream the pages can draw: page contents, every state of every annotation
 * appearance (/N), form XObjects, tiling patterns, soft masks and Type 3 glyph procedures,
 * whatever their layer (/OC) or state, as veraPDF does. Notes the fonts selected (Tf) and the
 * codes shown with them, tracking the text rendering mode across q/Q and into forms, the device
 * colour spaces set (MuPDF's device sees only what it draws: not a layer that is off, nor an
 * appearance state not shown) and the rendering intents.
 */
function contentUse(doc: Doc): ContentUse {
  const use: ContentUse = { fonts: new Map(), deviceCMYK: false, deviceRGB: false, intents: [] };
  const entered = new Set<string>();
  const withIntents = new Set<string>();

  const lookup = (res: Obj | null, category: string, name: string): Obj | null => {
    if (!res || !res.isDictionary()) return null;
    const dict = res.get(category);
    if (!dict.isDictionary()) return null;
    const v = dict.get(name);
    return v.isNull() ? null : v;
  };
  const resourcesOf = (stream: Obj, fallback: Obj | null) => {
    const r = stream.get("Resources");
    return r.isDictionary() ? r : fallback;
  };
  /**
   * The device space an operand selects: a device name, a resource name, an inline image's
   * abbreviation (CMYK, RGB) or Indexed array ([/I /RGB 255 <...>]).
   */
  const spaceOf = (v: Operand | undefined, res: Obj | null, inline: boolean): "cmyk" | "rgb" | null => {
    if (isName(v)) {
      if (v.name === "DeviceCMYK") return "cmyk";
      if (v.name === "DeviceRGB") return "rgb";
      const cs = lookup(res, "ColorSpace", v.name);
      if (cs) return isCMYK(cs) ? "cmyk" : isRGB(cs) ? "rgb" : null;
      if (inline && v.name === "CMYK") return "cmyk";
      if (inline && v.name === "RGB") return "rgb";
      return null;
    }
    if (Array.isArray(v) && v.length > 1 && isName(v[0]) && (v[0].name === "I" || v[0].name === "Indexed")) return spaceOf(v[1], res, inline);
    return null;
  };

  const run = (content: Obj, res: Obj | null, initialMode: number, depth: number, inherited: Defaults, page: Obj | null) => {
    if (depth > 16) return; // a malformed file could nest forms without end
    const own = defaultSpaces(res);
    const defaults: Defaults = { cmyk: inherited.cmyk || own.cmyk, rgb: inherited.rgb || own.rgb };
    const set = (space: "cmyk" | "rgb" | null) => {
      if (space === "cmyk" && !defaults.cmyk) use.deviceCMYK = true;
      if (space === "rgb" && !defaults.rgb) use.deviceRGB = true;
    };
    let mode = initialMode;
    const modes: number[] = [];
    let font: FontUse | undefined;
    let bytesPerCode: 0 | 1 | 2 = 1;
    const ranges: [number, number][] = [];
    const unknownIntent = (v: Operand | undefined) => {
      if (isName(v) && !STANDARD_INTENTS.has(v.name)) ranges.push([v.at, v.end]);
    };
    const enter = (stream: Obj, r: Obj | null, m: number, d: Defaults) => {
      const key = `${objKey(stream)}:${m === 3 ? "i" : "v"}:${+d.cmyk}${+d.rgb}`;
      if (entered.has(key)) return;
      entered.add(key);
      run(stream, r, m, depth + 1, d, null);
    };
    const show = (s: Uint8Array) => {
      if (!font) return;
      font.shown = true;
      const visible = mode !== 3;
      if (visible) font.shownVisibly = true;
      if (!font.allCodes || !font.codes) return;
      const add = (code: number) => {
        font!.allCodes!.add(code);
        if (visible) font!.codes!.add(code);
      };
      if (bytesPerCode === 1) for (const b of s) add(b);
      else for (let i = 0; i + 1 < s.length; i += 2) add((s[i] << 8) | s[i + 1]);
    };
    const bytes = contentBytes(content);
    scanContent(bytes, (op, args) => {
      const last = args[args.length - 1];
      const lastName = isName(last) ? last.name : null;
      switch (op) {
        case "q":
          modes.push(mode);
          break;
        case "Q":
          if (modes.length) mode = modes.pop()!;
          break;
        case "Tr":
          if (typeof last === "number") mode = last;
          break;
        case "Tf": {
          const nm = args[args.length - 2];
          const dict = isName(nm) ? lookup(res, "Font", nm.name) : null;
          if (!dict || !dict.isDictionary()) {
            font = undefined;
            break;
          }
          const key = objKey(dict);
          bytesPerCode = codeLength(dict);
          font = use.fonts.get(key);
          if (!font) {
            font = { codes: bytesPerCode ? new Set() : null, allCodes: bytesPerCode ? new Set() : null, shown: false, shownVisibly: false };
            use.fonts.set(key, font);
            // A Type 3 font's glyphs are content streams too (they may draw text themselves).
            if (nameOf(dict, "Subtype") === "Type3") {
              const procs = dict.get("CharProcs");
              const r = resourcesOf(dict, res);
              if (procs.isDictionary()) procs.forEach((p) => { if (p.isStream()) enter(p, r, 0, defaults); });
            }
          }
          break;
        }
        case "Tj":
        case "'":
        case '"':
          if (last instanceof Uint8Array) show(last);
          break;
        case "TJ":
          if (Array.isArray(last)) for (const x of last) if (x instanceof Uint8Array) show(x);
          break;
        case "Do": {
          const x = lastName ? lookup(res, "XObject", lastName) : null;
          if (x && x.isStream() && nameOf(x, "Subtype") === "Form") enter(x, resourcesOf(x, res), mode, defaults);
          break;
        }
        case "scn":
        case "SCN": {
          const p = lastName ? lookup(res, "Pattern", lastName) : null;
          if (p && p.isStream()) enter(p, resourcesOf(p, res), 0, defaults); // tiling pattern
          break;
        }
        case "gs": {
          const gs = lastName ? lookup(res, "ExtGState", lastName) : null;
          const smask = gs && gs.isDictionary() ? gs.get("SMask") : null;
          const group = smask && smask.isDictionary() ? smask.get("G") : null;
          if (group && group.isStream()) enter(group, resourcesOf(group, res), 0, defaults);
          break;
        }
        case "k":
        case "K":
          set("cmyk");
          break;
        case "rg":
        case "RG":
          set("rgb");
          break;
        case "cs":
        case "CS":
          set(spaceOf(last, res, false));
          break;
        case "ri":
          unknownIntent(last);
          break;
        case "ID":
          // An inline image: its dictionary's entries are the operands, in key/value pairs.
          for (let i = 0; i + 1 < args.length; i += 2) {
            const key = args[i];
            if (!isName(key)) continue;
            if (key.name === "CS" || key.name === "ColorSpace") set(spaceOf(args[i + 1], res, true));
            else if (key.name === "Intent") unknownIntent(args[i + 1]);
          }
          break;
      }
    });
    const key = objKey(content);
    if (ranges.length && !withIntents.has(key)) {
      withIntents.add(key);
      use.intents.push({ content, page: content.isStream() ? null : page, bytes, ranges });
    }
  };

  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.findPage(i);
    const res = page.getInheritable("Resources");
    run(page.get("Contents"), res.isDictionary() ? res : null, 0, 0, NO_DEFAULTS, page);
    const annots = page.get("Annots");
    if (!annots.isArray()) continue;
    for (let k = 0; k < annots.length; k++) {
      const annot = annots.get(k);
      if (!annot.isDictionary()) continue;
      const n = annot.get("AP", "N");
      const streams: Obj[] = [];
      if (n.isStream()) streams.push(n);
      else if (n.isDictionary()) n.forEach((v) => { if (v.isStream()) streams.push(v); });
      for (const s of streams) {
        const key = `${objKey(s)}:v:00`;
        if (entered.has(key)) continue;
        entered.add(key);
        const r = s.get("Resources");
        run(s, r.isDictionary() ? r : null, 0, 1, NO_DEFAULTS, null);
      }
    }
  }
  return use;
}

/**
 * Writes the rendering intents PDF/A does not know as RelativeColorimetric, what readers use for
 * an intent they do not recognise (ISO 32000-1 8.6.5.8): nothing looks different. A page whose
 * contents are an array of streams gets one stream with them joined.
 */
function fixContentIntents(mupdf: MuPDFModule, doc: Doc, found: IntentNames[], out: Findings) {
  const name = new TextEncoder().encode("/RelativeColorimetric");
  for (const f of found) {
    const parts: Uint8Array[] = [];
    let at = 0;
    for (const [start, end] of [...f.ranges].sort((a, b) => a[0] - b[0])) {
      if (start < at) continue;
      parts.push(f.bytes.subarray(at, start), name);
      at = end;
    }
    parts.push(f.bytes.subarray(at));
    const bytes = joinBytes(parts);
    if (f.content.isStream()) {
      const buf = new mupdf.Buffer(bytes);
      try {
        f.content.writeStream(buf);
      } finally {
        buf.destroy();
      }
    } else if (f.page) f.page.put("Contents", addStream(mupdf, doc, bytes, {}));
    else continue;
    out.fixes++;
  }
}

function joinBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The content of a stream, or of an array of streams joined (they split only between tokens). */
function contentBytes(content: Obj): Uint8Array {
  if (content.isStream()) return streamBytes(content);
  if (!content.isArray()) return new Uint8Array(0);
  const parts: Uint8Array[] = [];
  for (let i = 0; i < content.length; i++) {
    const s = content.get(i);
    if (s.isStream()) parts.push(streamBytes(s), new Uint8Array([10]));
  }
  return joinBytes(parts);
}

/** What one probe of a character code found. */
interface Probed {
  gid: number;
  /** The glyph's advance in the font program, in 1/1000 em. */
  advance: number;
  /** The advance the PDF's widths give the code, in 1/1000 em (null if it could not be measured). */
  pdfAdvance: number | null;
}

/** What probing a font found: by code, and MuPDF's name for the font (the one its devices report). */
interface Probe {
  glyphs: Map<number, Probed>;
  name: string;
}

/**
 * Draws each code twice with `font` on a page of a scratch document (the document worked on is
 * untouched) and reads, through a device, the glyph MuPDF picks, its advance in the font program
 * and the gap between the two copies: the advance the PDF's widths give it. MuPDF picks the same
 * program it renders with: for a non-embedded standard font, its built-in URW clone.
 */
function probeFont(mupdf: MuPDFModule, font: Obj, codes: number[], bytesPerCode: 1 | 2): Probe {
  const out: Probe = { glyphs: new Map(), name: "" };
  if (!codes.length) return out;
  const COLS = 32, CELL_W = 100, CELL_H = 20, SIZE = 10, MARGIN = 10;
  const scratch = new mupdf.PDFDocument();
  try {
    const f = scratch.graftObject(font);
    let ops = `BT /F ${SIZE} Tf\n`;
    codes.forEach((code, i) => {
      const hex = code.toString(16).padStart(bytesPerCode * 2, "0");
      ops += `1 0 0 1 ${MARGIN + (i % COLS) * CELL_W} ${MARGIN + Math.floor(i / COLS) * CELL_H} Tm <${hex}${hex}> Tj\n`;
    });
    ops += "ET\n";
    const rows = Math.ceil(codes.length / COLS);
    scratch.insertPage(-1, scratch.addPage([0, 0, COLS * CELL_W + 2 * MARGIN, rows * CELL_H + 2 * MARGIN], 0, { Font: { F: f } }, ops));
    // Glyphs by cell; Page.run with the identity matrix reports user space (y up).
    const cells = new Map<number, { x: number; gid: number; advance: number }[]>();
    const fonts = new Set<MuPDF.Font>();
    const take = (text: MuPDF.Text) => {
      text.walk({
        showGlyph(fnt, trm, gid) {
          fonts.add(fnt);
          if (!out.name) out.name = untag(fnt.getName());
          // Glyph -1 carries the further characters of a code whose ToUnicode maps to several
          // (a ligature): nothing is drawn for it.
          if (gid < 0) return;
          const col = Math.floor((trm[4] - MARGIN + 0.5) / CELL_W), row = Math.round((trm[5] - MARGIN) / CELL_H);
          const cell = row * COLS + col;
          let list = cells.get(cell);
          if (!list) cells.set(cell, (list = []));
          list.push({ x: trm[4], gid, advance: fnt.advanceGlyph(gid, 0) * 1000 });
        },
      });
      text.destroy();
    };
    const page = scratch.loadPage(0);
    const dev = new mupdf.Device({
      fillText(text, _ctm, cs) {
        cs.destroy();
        take(text);
      },
    });
    try {
      page.run(dev, mupdf.Matrix.identity);
      dev.close();
    } finally {
      dev.destroy();
      page.destroy();
      for (const fnt of fonts) fnt.destroy();
    }
    codes.forEach((code, i) => {
      const here = cells.get(i)?.sort((a, b) => a.x - b.x);
      if (!here?.length) return;
      out.glyphs.set(code, {
        gid: here[0].gid,
        advance: here[0].advance,
        pdfAdvance: here.length > 1 ? ((here[1].x - here[0].x) / SIZE) * 1000 : null,
      });
    });
  } finally {
    scratch.destroy();
  }
  return out;
}

/** A URW program from MuPDF, added to `doc` once per standard font. */
interface Program {
  file: Obj;
  bbox: number[];
  ascent: number;
  descent: number;
  stemV: number;
}

/** What embedding a standard font found, kept for the next dictionary that asks the same. */
interface Embedding {
  /** The glyphs before (MuPDF's stand-in) and after (the program embedded), for all 256 codes. */
  before: Probe;
  after: Probe;
  descriptor: Obj;
  widths: number[];
}

/**
 * What one conversion or check learns about its fonts, so that each is probed once: merged files
 * often give every page its own copy of the same font dictionary, and each probe builds a
 * scratch document. Keys are the dictionaries as text (see `serialized`).
 */
class FontProbes {
  private readonly probes = new Map<string, Probe>();
  /** MuPDF's URW programs added to the document, by standard font name. */
  readonly programs = new Map<string, Program>();
  /** Standard fonts embedded, by what decides the glyphs (embedKey). */
  readonly embeddings = new Map<string, Embedding>();

  constructor(readonly mupdf: MuPDFModule) {}

  probe(font: Obj, codes: Iterable<number>, bytesPerCode: 1 | 2): Probe {
    const list = [...codes].sort((a, b) => a - b);
    const key = `${bytesPerCode}|${list.join(",")}|${serialized(font)}`;
    let p = this.probes.get(key);
    if (!p) this.probes.set(key, (p = probeFont(this.mupdf, font, list, bytesPerCode)));
    return p;
  }
}

/** The visible codes of an embedded font whose PDF width and program width differ by more than 1/1000 em. */
function widthMismatches(probe: Probe, codes: Set<number>): number {
  let bad = 0;
  for (const c of codes) {
    const p = probe.glyphs.get(c);
    if (p && p.gid !== 0 && p.pdfAdvance !== null && Math.abs(p.pdfAdvance - p.advance) > 1) bad++;
  }
  return bad;
}

/** How many of `codes` draw glyph 0, .notdef. */
function notdefCodes(probe: Probe, codes: Iterable<number>): number {
  let n = 0;
  for (const c of codes) if (probe.glyphs.get(c)?.gid === 0) n++;
  return n;
}

/** Whether to probe a font (widths, .notdef), and with how many bytes per code. */
function widthCheckable(font: Obj, status: FontStatus): 0 | 1 | 2 {
  if (SIMPLE_FONTS.has(status.subtype)) return 1;
  // Type 0: horizontal Identity fonts only (the probe lays codes out left to right).
  return status.subtype === "Type0" && nameOf(font, "Encoding") === "Identity-H" ? 2 : 0;
}

/** A standard font left unembedded: PDF/A's font dictionary rules let it go without widths. */
const unembeddedStandard = (status: FontStatus) =>
  status.subtype === "Type1" && !status.embedded && BASE14.includes(untag(status.base));

/** FirstChar, LastChar and Widths of a simple font, present and of matching length (6.2.11.2). */
function hasWidths(font: Obj): boolean {
  const first = font.get("FirstChar"), last = font.get("LastChar"), widths = font.get("Widths");
  return first.isNumber() && last.isNumber() && widths.isArray() && widths.length === last.asNumber() - first.asNumber() + 1;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Writes FirstChar, LastChar and Widths into a simple font that lacks them (or whose Widths
 * have the wrong length), from the advances MuPDF lays its text out with now: for an embedded
 * font those of its program, for a missing one those of MuPDF's stand-in. Nothing moves in
 * MuPDF; other readers may place invisible (OCR) text slightly differently, never visible text
 * of an embedded font, whose program gives the same advances. Returns whether it wrote them.
 */
function completeWidths(probes: FontProbes, font: Obj): boolean {
  if (hasWidths(font)) return false;
  const all = [...Array(256).keys()];
  const probe = probes.probe(font, all, 1);
  font.put("FirstChar", 0);
  font.put("LastChar", 255);
  font.put("Widths", all.map((c) => {
    const p = probe.glyphs.get(c);
    return p ? round2(p.pdfAdvance ?? p.advance) : 0;
  }));
  return true;
}

/**
 * 6.2.11.3.2: an embedded CIDFontType2 needs /CIDToGIDMap. A missing (or unusable) one becomes
 * Identity, the default ISO 32000-1 gives it and the mapping MuPDF already draws with.
 */
function fixCidToGid(doc: Doc, cidFont: Obj): boolean {
  if (nameOf(cidFont, "Subtype") !== "CIDFontType2" || cidToGidOk(cidFont)) return false;
  cidFont.put("CIDToGIDMap", doc.newName("Identity"));
  return true;
}

const cidToGidOk = (cidFont: Obj) => {
  const map = cidFont.get("CIDToGIDMap");
  return map.isStream() || (map.isName() && map.asName() === "Identity");
};

/** MuPDF's built-in program for a standard font (a CFF), added to `doc` as a FontFile3 stream. */
function builtinProgram(mupdf: MuPDFModule, doc: Doc, std: string): Program {
  const scratch = new mupdf.PDFDocument();
  const font = new mupdf.Font(std);
  try {
    // addFont embeds the whole program (as a Type 0 font): read it back from there.
    const ref = scratch.addFont(font);
    const fd = ref.get("DescendantFonts", 0, "FontDescriptor");
    const buf = fd.get("FontFile3").readStream();
    let file: Obj;
    try {
      file = doc.addStream(buf, { Subtype: "Type1C" });
    } finally {
      buf.destroy();
    }
    const bbox: number[] = [];
    fd.get("FontBBox").forEach((v) => bbox.push(v.asNumber()));
    return { file, bbox, ascent: intOf(fd, "Ascent"), descent: intOf(fd, "Descent"), stemV: intOf(fd, "StemV") || 80 };
  } finally {
    font.destroy();
    scratch.destroy();
  }
}

/** What embedding a standard font did, for the codes the content draws. */
interface Embedded {
  /** Codes that draw another glyph than before (must be 0: the look would change). */
  glyphChanges: number;
  /** Codes whose width in the file differed from the program's by more than 1/1000 em. */
  widthChanges: number;
  /** The glyphs after embedding, for all 256 codes. */
  after: Probe;
}

/**
 * Embeds MuPDF's built-in URW program in a non-embedded standard (or alias) simple font, keeping
 * its Encoding so every code selects the same glyph, and writes Widths from the program so the
 * dictionary and the program agree (PDF/A-2 6.2.11.5). A TrueType alias becomes the Type 1
 * standard font. `codes`: the codes drawn (null = unknown, all 256 count).
 *
 * Dictionaries that pick their glyphs the same way (same standard font, type, name, encoding and
 * descriptor; their own widths do not change which glyph a code draws) share one probe pair and
 * one font descriptor.
 */
function embedStandardFont(probes: FontProbes, doc: Doc, font: Obj, std: string, codes: Set<number> | null): Embedded {
  const all = [...Array(256).keys()];
  const key = [std, nameOf(font, "Subtype"), nameOf(font, "BaseFont"), serialized(font.get("Encoding")), serialized(font.get("FontDescriptor"))].join("|");
  let known = probes.embeddings.get(key);
  const before = known?.before ?? probes.probe(font, all, 1);
  if (!known) {
    let program = probes.programs.get(std);
    if (!program) probes.programs.set(std, (program = builtinProgram(probes.mupdf, doc, std)));
    const family = familyOf(std);
    let flags = BASE14_FLAGS[family] ?? 32;
    if (/Oblique|Italic/.test(std)) flags |= 64;
    const descriptor = doc.addObject({
      Type: "FontDescriptor", FontName: std, Flags: flags, FontBBox: program.bbox,
      ItalicAngle: std.includes("Oblique") ? -12 : std.includes("Italic") ? -15.5 : 0,
      Ascent: program.ascent, Descent: program.descent, CapHeight: CAP_HEIGHT[family] ?? program.ascent,
      StemV: program.stemV, FontFile3: program.file,
    });
    const widths = all.map((c) => {
      const p = before.glyphs.get(c);
      return p ? round2(p.advance) : 0;
    });
    known = { before, after: before, descriptor, widths };
  }
  const counted = (c: number) => !codes || codes.has(c);
  // Only fonts that had their own widths move: without, viewers already used the standard ones.
  const oldWidths = font.get("Widths");
  const oldFirst = intOf(font, "FirstChar");
  let widthChanges = 0;
  if (oldWidths.isArray())
    for (const c of all) {
      if (!counted(c) || c < oldFirst || c - oldFirst >= oldWidths.length) continue;
      const old = oldWidths.get(c - oldFirst);
      if (old.isNumber() && Math.abs(old.asNumber() - known.widths[c]) > 1) widthChanges++;
    }
  font.put("Type", "Font");
  font.put("Subtype", "Type1");
  font.put("BaseFont", std);
  font.put("FontDescriptor", known.descriptor);
  font.put("FirstChar", 0);
  font.put("LastChar", 255);
  font.put("Widths", known.widths);
  if (!probes.embeddings.has(key)) {
    // After embedding, every drawn code must still draw the same glyph.
    known.after = probes.probe(font, all, 1);
    probes.embeddings.set(key, known);
  }
  let glyphChanges = 0;
  for (const [c, p] of known.before.glyphs) if (counted(c) && known.after.glyphs.get(c)?.gid !== p.gid) glyphChanges++;
  return { glyphChanges, widthChanges, after: known.after };
}

// ---------------------------------------------------------------------------------------------
// What the pages paint

interface Painted {
  /** Glyphs drawn with .notdef (glyph 0) in a font the file embeds, Type 3 aside, by font name. */
  notdef: Map<string, number>;
  /** Something is painted in DeviceCMYK (paths, text, images). */
  deviceCMYK: boolean;
  /** Something is painted in DeviceRGB. */
  deviceRGB: boolean;
}

/**
 * Runs every page (with annotations) through a device and notes what MuPDF paints: a second
 * opinion beside the reading of the content (contentUse), for what only MuPDF sees, such as text
 * in fonts with other CMaps or the colour space inside image data. Invisible text (rendering
 * mode 3, which reaches ignoreText) counts for .notdef too, since 6.2.11.8 holds in every mode;
 * glyph 0 of a font the file does not embed is MuPDF's stand-in's, not one the file refers to.
 * The device is given the space the content sets, even where a DefaultCMYK or DefaultRGB stands
 * in for it: on a page that has one, the reading of the content decides alone.
 */
function deviceScan(mupdf: MuPDFModule, doc: Doc, type3Names: Set<string>, nonEmbedded: Set<string>): Painted {
  const painted: Painted = { notdef: new Map(), deviceCMYK: false, deviceRGB: false };
  const fonts = new Set<MuPDF.Font>();
  let defaults = NO_DEFAULTS;
  const colour = (cs: MuPDF.ColorSpace | null) => {
    if (!cs) return;
    const name = cs.getName();
    if (name === "DeviceCMYK" && !defaults.cmyk) painted.deviceCMYK = true;
    else if (name === "DeviceRGB" && !defaults.rgb) painted.deviceRGB = true;
    cs.destroy();
  };
  const glyphs = (text: MuPDF.Text) => {
    text.walk({
      showGlyph(font, _trm, gid) {
        fonts.add(font);
        if (gid !== 0) return;
        const name = untag(font.getName());
        if (!type3Names.has(name) && !nonEmbedded.has(name)) painted.notdef.set(name, (painted.notdef.get(name) ?? 0) + 1);
      },
    });
    text.destroy();
  };
  const dev = new mupdf.Device({
    fillPath(path, _eo, _ctm, cs) { path.destroy(); colour(cs); },
    strokePath(path, stroke, _ctm, cs) { path.destroy(); stroke.destroy(); colour(cs); },
    fillText(text, _ctm, cs) { colour(cs); glyphs(text); },
    strokeText(text, stroke, _ctm, cs) { stroke.destroy(); colour(cs); glyphs(text); },
    clipText(text) { glyphs(text); },
    clipStrokeText(text, stroke) { stroke.destroy(); glyphs(text); },
    ignoreText(text) { glyphs(text); },
    fillImage(image) { colour(image.getColorSpace()); image.destroy(); },
    fillImageMask(image, _ctm, cs) { image.destroy(); colour(cs); },
  });
  try {
    for (let i = 0; i < doc.countPages(); i++) {
      defaults = defaultSpaces(doc.findPage(i).getInheritable("Resources"));
      const page = doc.loadPage(i);
      try {
        page.run(dev, mupdf.Matrix.identity);
      } finally {
        page.destroy();
      }
    }
    dev.close();
  } finally {
    dev.destroy();
    for (const f of fonts) f.destroy();
  }
  return painted;
}

/** Whether a resource dictionary sets DefaultCMYK / DefaultRGB (to something else than the device space). */
function defaultSpaces(res: Obj | null): Defaults {
  const spaces = res?.isDictionary() ? res.get("ColorSpace") : null;
  const has = (key: string, isDevice: (cs: Obj) => boolean) => {
    if (!spaces?.isDictionary()) return false;
    const d = spaces.get(key);
    return !d.isNull() && !isDevice(d);
  };
  return { cmyk: has("DefaultCMYK", isCMYK), rgb: has("DefaultRGB", isRGB) };
}

/** The names MuPDF gives Type 3 fonts (their /Name, else "Unnamed-T3"; /BaseFont when set). */
function type3NamesOf(fonts: Obj[]): Set<string> {
  const names = new Set<string>();
  for (const f of fonts) {
    if (nameOf(f, "Subtype") !== "Type3") continue;
    names.add(nameOf(f, "Name") ?? "Unnamed-T3");
    const base = nameOf(f, "BaseFont");
    if (base) names.add(untag(base));
  }
  return names;
}

/** The names of the fonts the file does not embed (MuPDF reports its stand-ins under them). */
function nonEmbeddedNames(fonts: Obj[]): Set<string> {
  const names = new Set<string>();
  for (const f of fonts) {
    const status = fontStatus(f);
    if (status.subtype !== "Type3" && !status.embedded && status.base) names.add(untag(status.base));
  }
  return names;
}

/** .notdef glyphs found by probing and by the device scan, one count per font name. */
function mergeNotdef(probed: Map<string, number>, painted: Map<string, number>): Map<string, number> {
  const all = new Map(probed);
  for (const [name, n] of painted) all.set(name, Math.max(all.get(name) ?? 0, n));
  return all;
}

const CMYK_NAMES = ["DeviceCMYK", "CMYK"], RGB_NAMES = ["DeviceRGB", "RGB"];

/**
 * Whether a colour space (a name, or an array such as [/Indexed /DeviceCMYK ...] or
 * [/Separation /Gold /DeviceCMYK fn]) is or falls back to a device space named in `names`.
 */
function fallsBackTo(cs: Obj, names: readonly string[], depth = 0): boolean {
  if (depth > 4) return false;
  if (cs.isName()) return names.includes(cs.asName());
  if (!cs.isArray() || cs.length < 2 || !cs.get(0).isName()) return false;
  switch (cs.get(0).asName()) {
    case "Indexed":
    case "I":
    case "Pattern":
      return fallsBackTo(cs.get(1), names, depth + 1);
    case "Separation":
    case "DeviceN":
      return cs.length > 2 && fallsBackTo(cs.get(2), names, depth + 1);
  }
  return false;
}

const isCMYK = (cs: Obj) => fallsBackTo(cs, CMYK_NAMES);
const isRGB = (cs: Obj) => fallsBackTo(cs, RGB_NAMES);

/**
 * Whether an object declares a device space where a colour space goes: an image's or shading's
 * /ColorSpace, a transparency group's /CS, a colour space in a resource dictionary. Catches
 * what the device scan cannot see (shadings, Separation alternates, group spaces).
 */
function declares(o: Obj, test: (cs: Obj) => boolean): boolean {
  const cs = o.get("ColorSpace");
  if (test(cs) || test(o.get("CS"))) return true;
  if (!cs.isDictionary()) return false;
  let found = false;
  cs.forEach((v) => { if (test(v)) found = true; });
  return found;
}

// ---------------------------------------------------------------------------------------------
// Colour profiles

/** Four header bytes of an ICC profile as text ("mntr", "RGB "...). */
const iccSig = (bytes: Uint8Array, at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));

/** Device classes PDF/A-2 accepts in a profile (6.2.4.2); an output intent's must be prtr or mntr (6.2.3). */
const ICC_CLASSES = new Set(["prtr", "mntr", "scnr", "spac"]);
/** Colour spaces PDF/A-2 accepts in a profile, and their component counts. */
const ICC_COMPONENTS: Record<string, number> = { GRAY: 1, "RGB ": 3, "Lab ": 3, CMYK: 4 };

/** Why an ICC profile cannot be used in PDF/A-2, or null. `n`: the stream's /N, when known. */
function iccProblem(mupdf: MuPDFModule, bytes: Uint8Array, n: number | null): string | null {
  if (bytes.length < 132) return "too short to be an ICC profile";
  if (iccSig(bytes, 36) !== "acsp") return "not an ICC profile";
  if (bytes[8] >= 5) return `ICC version ${bytes[8]} (PDF/A-2 allows up to 4)`;
  const deviceClass = iccSig(bytes, 12), space = iccSig(bytes, 16);
  if (!ICC_CLASSES.has(deviceClass)) return `profile class ${deviceClass.trim()}`;
  const components = ICC_COMPONENTS[space];
  if (components === undefined) return `colour space ${space.trim()}`;
  if (n !== null && components !== n) return `${n} components declared for a ${space.trim()} profile`;
  const buf = new mupdf.Buffer(bytes);
  try {
    new mupdf.ColorSpace(buf, "PDF/A check").destroy();
  } catch {
    return "MuPDF cannot read it";
  } finally {
    buf.destroy();
  }
  return null;
}

/**
 * The components (3 for RGB, 4 for CMYK) of an output intent profile PDF/A-2 accepts as the
 * document's colour declaration, or why not: class prtr or mntr (6.2.3), and RGB or CMYK, the
 * spaces DeviceRGB and DeviceCMYK need (a grey or Lab one would allow neither).
 */
function intentProfile(mupdf: MuPDFModule, profile: Obj): 3 | 4 | string {
  if (!profile.isStream()) return "missing";
  const bytes = streamBytes(profile);
  const n = profile.get("N").isNumber() ? intOf(profile, "N") : null;
  const problem = iccProblem(mupdf, bytes, n);
  if (problem) return problem;
  const deviceClass = iccSig(bytes, 12), space = iccSig(bytes, 16);
  if (deviceClass !== "prtr" && deviceClass !== "mntr") return `profile class ${deviceClass.trim()} (an output intent needs prtr or mntr)`;
  if (space === "RGB " && n === 3) return 3;
  if (space === "CMYK" && n === 4) return 4;
  return n === null ? "no /N" : `colour space ${space.trim()} (the app needs RGB or CMYK)`;
}

/**
 * The output intent the file can keep, by components (3 RGB, 4 CMYK), or 0: there must be
 * exactly one, of type GTS_PDFA1, with a usable profile. Then the file keeps the colour
 * declaration its author chose. (Whether a CMYK one stays depends on the content: see step 7.)
 */
function keptIntent(mupdf: MuPDFModule, intents: Obj): 0 | 3 | 4 {
  if (!intents.isArray() || intents.length !== 1) return 0;
  const oi = intents.get(0);
  if (nameOf(oi, "S") !== "GTS_PDFA1" || oi.get("OutputConditionIdentifier").isNull()) return 0;
  const n = intentProfile(mupdf, oi.get("DestOutputProfile"));
  return typeof n === "number" ? n : 0;
}

// ---------------------------------------------------------------------------------------------
// Metadata

/** XML 1.0 forbids most control characters, lone surrogates and U+FFFE/U+FFFF. */
const XML_INVALID = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const xmlUnescape = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** "D:20231005120000+02'00'" becomes "2023-10-05T12:00:00+02:00"; null when it does not parse. */
export function pdfDateToXmp(date: string | null | undefined): string | null {
  const m = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(Z|[+-]\d{2}'?\d{2}'?|[+-]\d{2})?/.exec(date ?? "");
  if (!m) return null;
  const [, y, mo = "01", d = "01", h = "00", mi = "00", s = "00", tz] = m;
  let zone = "";
  if (tz === "Z") zone = "Z";
  else if (tz) {
    const t = tz.replace(/'/g, "");
    zone = `${t.slice(0, 3)}:${t.slice(3, 5) || "00"}`;
  }
  return `${y}-${mo}-${d}T${h}:${mi}:${s}${zone}`;
}

function dateToPdf(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `D:${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
}

interface XmpValues {
  title: string | null;
  author: string | null;
  subject: string | null;
  keywords: string | null;
  creator: string | null;
  producer: string | null;
  created: string | null;
  modified: string;
}

/**
 * The XMP packet: pdfaid (part 2, conformance B) and the Dublin Core, XMP basic and Adobe PDF
 * properties that mirror the Info dictionary. Only predefined schemas, so no extension schema
 * has to be declared. The header has no bytes/encoding attributes (6.6.2.1); trailing padding
 * lets editors grow it in place.
 */
function buildXmp(v: XmpValues): string {
  const alt = (s: string) => `<rdf:Alt><rdf:li xml:lang="x-default">${xmlEscape(s)}</rdf:li></rdf:Alt>`;
  const lines = (...items: (string | false)[]) => items.filter(Boolean).join("\n   ");
  return `<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:pdfaid="${PDFAID_NS}">
   <pdfaid:part>2</pdfaid:part>
   <pdfaid:conformance>B</pdfaid:conformance>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
   ${lines(
     "<dc:format>application/pdf</dc:format>",
     v.title !== null && `<dc:title>${alt(v.title)}</dc:title>`,
     v.author !== null && `<dc:creator><rdf:Seq><rdf:li>${xmlEscape(v.author)}</rdf:li></rdf:Seq></dc:creator>`,
     v.subject !== null && `<dc:description>${alt(v.subject)}</dc:description>`,
   )}
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/">
   ${lines(
     v.created !== null && `<xmp:CreateDate>${v.created}</xmp:CreateDate>`,
     `<xmp:ModifyDate>${v.modified}</xmp:ModifyDate>`,
     `<xmp:MetadataDate>${v.modified}</xmp:MetadataDate>`,
     v.creator !== null && `<xmp:CreatorTool>${xmlEscape(v.creator)}</xmp:CreatorTool>`,
   )}
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
   ${lines(
     v.producer !== null && `<pdf:Producer>${xmlEscape(v.producer)}</pdf:Producer>`,
     v.keywords !== null && `<pdf:Keywords>${xmlEscape(v.keywords)}</pdf:Keywords>`,
   )}
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
${" ".repeat(100)}
<?xpacket end="w"?>`;
}

/** Info keys and where the XMP above carries them (for the check). */
const INFO_IN_XMP: [string, RegExp][] = [
  ["Title", /<dc:title><rdf:Alt><rdf:li xml:lang="x-default">([\s\S]*?)<\/rdf:li>/],
  ["Author", /<dc:creator><rdf:Seq><rdf:li>([\s\S]*?)<\/rdf:li>/],
  ["Subject", /<dc:description><rdf:Alt><rdf:li xml:lang="x-default">([\s\S]*?)<\/rdf:li>/],
  ["Keywords", /<pdf:Keywords>([\s\S]*?)<\/pdf:Keywords>/],
  ["Creator", /<xmp:CreatorTool>([\s\S]*?)<\/xmp:CreatorTool>/],
  ["Producer", /<pdf:Producer>([\s\S]*?)<\/pdf:Producer>/],
  ["CreationDate", /<xmp:CreateDate>([\s\S]*?)<\/xmp:CreateDate>/],
  ["ModDate", /<xmp:ModifyDate>([\s\S]*?)<\/xmp:ModifyDate>/],
];

// ---------------------------------------------------------------------------------------------
// The conversion

/** Collects the report, merging issues with the same code and detail. */
class Findings {
  readonly blockers: PdfaIssue<PdfaBlockerCode>[] = [];
  readonly removals: PdfaIssue<PdfaRemovalCode>[] = [];
  readonly warnings: PdfaIssue<PdfaWarningCode>[] = [];
  fixes = 0;

  block(code: PdfaBlockerCode, detail?: string, count?: number) { add(this.blockers, code, detail, count); }
  /** Removals count what goes (all but "xfa-data", which is one form's data). */
  remove(code: PdfaRemovalCode, count?: number, detail?: string) { add(this.removals, code, detail, count); }
  warn(code: PdfaWarningCode, detail?: string, count?: number) { add(this.warnings, code, detail, count); }

  report(): PdfaReport {
    return { blockers: this.blockers, removals: this.removals, warnings: this.warnings, fixes: this.fixes };
  }
}

function add<C extends string>(list: PdfaIssue<C>[], code: C, detail?: string, count?: number) {
  const same = list.find((i) => i.code === code && i.detail === detail);
  if (same) {
    if (count !== undefined) same.count = (same.count ?? 0) + count;
    return;
  }
  const issue: PdfaIssue<C> = { code };
  if (detail !== undefined) issue.detail = detail;
  if (count !== undefined) issue.count = count;
  list.push(issue);
}

/** An action PDF/A-2 does not allow (6.5.1): JavaScript, Launch, Sound, Hide, most Named... */
function forbiddenAction(action: Obj): boolean {
  const S = nameOf(action, "S");
  if (!S) return false;
  return !ALLOWED_ACTIONS.has(S) || (S === "Named" && !ALLOWED_NAMED.has(nameOf(action, "N") ?? ""));
}

/** An annotation dictionary: Type /Annot, or an annotation Subtype with a /Rect (Type is optional). */
const isAnnotation = (o: Obj, type: string | null, subtype: string | null) =>
  type === "Annot" || (subtype !== null && ISO_ANNOTS.has(subtype) && !o.get("Rect").isNull());

/** Actions in an action chain (the action and its /Next ones): [JavaScript, others]. */
function countActions(action: Obj, depth = 0): [number, number] {
  if (depth > 16) return [0, 0];
  if (action.isArray()) {
    let js = 0, other = 0;
    for (let i = 0; i < action.length; i++) {
      const [a, b] = countActions(action.get(i), depth + 1);
      js += a;
      other += b;
    }
    return [js, other];
  }
  if (!action.isDictionary()) return [0, 0];
  const own: [number, number] = nameOf(action, "S") === "JavaScript" ? [1, 0] : [0, 1];
  const [a, b] = countActions(action.get("Next"), depth + 1);
  return [own[0] + a, own[1] + b];
}

/** Entries of a name tree (Names arrays and Kids), as [key, value] pairs. */
function nameTreeEntries(node: Obj, depth = 0, out: [string, Obj][] = []): [string, Obj][] {
  if (depth > 16 || !node.isDictionary()) return out;
  const names = node.get("Names");
  if (names.isArray())
    for (let i = 0; i + 1 < names.length; i += 2) {
      const k = names.get(i);
      out.push([k.isString() ? k.asString() : "", names.get(i + 1)]);
    }
  const kids = node.get("Kids");
  if (kids.isArray()) for (let i = 0; i < kids.length; i++) nameTreeEntries(kids.get(i), depth + 1, out);
  return out;
}

/** The file name of a file specification. */
function fileSpecName(spec: Obj): string {
  if (spec.isString()) return spec.asString();
  if (!spec.isDictionary()) return "";
  for (const k of ["UF", "F"]) {
    const v = spec.get(k);
    if (v.isString()) return v.asString();
  }
  return "";
}

/** /Rect as numbers (PDFAnnotation.getRect throws for some annotation types). */
function rectOf(o: Obj): number[] {
  const r: number[] = [];
  const v = o.get("Rect");
  if (v.isArray()) v.forEach((x) => r.push(x.isNumber() ? x.asNumber() : 0));
  return r;
}

/**
 * 6.3.3: a button widget's normal appearance (/AP /N) must be a dictionary of states, every
 * other annotation's a single stream. Rewritten so that viewers draw what they drew before: a
 * button's one stream becomes its one state, which /AS names; elsewhere a state dictionary gives
 * way to the state shown (/AS), or to an empty appearance when none was shown. `empty`: an empty
 * form XObject. Returns whether it changed anything.
 */
function fixNormalAppearance(doc: Doc, o: Obj, subtype: string | null, empty: () => Obj): boolean {
  const ap = o.get("AP");
  if (!ap.isDictionary()) return false;
  const n = ap.get("N");
  if (n.isNull()) return false;
  const as = o.get("AS");
  const state = as.isName() ? as.asName() : null;
  if (subtype === "Widget" && isButton(o)) {
    if (n.isDictionary() && !n.isStream() && hasStream(n)) return false;
    const ff = inheritedField(o, "Ff");
    const flags = ff?.isNumber() ? ff.asNumber() : 0;
    const v = inheritedField(o, "V");
    // The state shown, else a push button's usual "On", or a check box's value (a radio button's
    // value names another button of the group).
    const name = state ?? (flags & FF_PUSHBUTTON ? "On" : !(flags & FF_RADIO) && v?.isName() ? v.asName() : "Off");
    const states = n.isDictionary() && !n.isStream() ? n : doc.newDictionary();
    states.put(doc.newName(name), n.isStream() ? n : empty());
    ap.put("N", states);
    if (state === null) o.put("AS", doc.newName(name));
    return true;
  }
  if (n.isStream()) return false;
  const shown = state !== null && n.isDictionary() ? n.get(state) : null;
  ap.put("N", shown?.isStream() ? shown : empty());
  o.delete("AS");
  return true;
}

/** A rendering intent entry (/RI of a graphics state, /Intent of an image) PDF/A does not know. */
function badIntent(o: Obj, key: string): boolean {
  const v = o.get(key);
  return !v.isNull() && !(v.isName() && STANDARD_INTENTS.has(v.asName()));
}

/**
 * Rewrites `doc` as PDF/A-2b, in place (give it a scratch copy: with blockers it is left half
 * converted). The report says what blocks, what was removed or changed, and what to tell.
 */
export function convertToPdfA(mupdf: MuPDFModule, doc: Doc, options: ConvertOptions = {}): PdfaReport {
  const out = new Findings();
  const root = catalog(doc);
  let emptyForm: Obj | null = null;
  /** An empty appearance (made once): for a field MuPDF cannot draw, or a state never shown. */
  const empty = () => (emptyForm ??= addStream(mupdf, doc, "", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 0, 0] }));

  // 1. What cannot be converted without changing what the document is.
  const acro = root.get("AcroForm");
  if (acro.isDictionary() && !acro.get("XFA").isNull()) {
    const fields = acro.get("Fields");
    if (boolOf(root, "NeedsRendering") || !fields.isArray() || fields.length === 0) out.block("xfa-dynamic");
    else {
      acro.delete("XFA"); // a static XFA form: its AcroForm fields stay, and draw the same
      out.remove("xfa-data");
    }
  }
  if (!root.get("NeedsRendering").isNull()) {
    root.delete("NeedsRendering");
    out.fixes++;
  }
  if (!root.get("Collection").isNull()) out.block("portfolio");
  // A signature covers the file's bytes (/ByteRange), so any new file breaks it, and PDF/A-2
  // (6.4.3) requires the byte range to cover the whole file: a broken signature cannot stay.
  // The value goes; the field and its visible appearance stay, ready to be signed again.
  const signed = signedFields(doc);
  if (signed.length) {
    for (const field of signed) field.delete("V");
    root.delete("Perms"); // certification and usage-rights signatures (DocMDP, UR3)
    if (acro.isDictionary()) acro.delete("SigFlags");
    out.warn("signature-invalid", undefined, signed.length);
  }

  // 2. Document-level scripts, attachments and alternate presentations (slide shows, 6.10).
  const attachments: string[] = [];
  const names = root.get("Names");
  if (names.isDictionary()) {
    const js = names.get("JavaScript");
    if (!js.isNull()) {
      out.remove("javascript", Math.max(1, nameTreeEntries(js).length));
      names.delete("JavaScript");
    }
    const files = names.get("EmbeddedFiles");
    if (!files.isNull()) {
      for (const [key, spec] of nameTreeEntries(files)) attachments.push(fileSpecName(spec) || key);
      names.delete("EmbeddedFiles");
    }
    if (!names.get("AlternatePresentations").isNull()) {
      names.delete("AlternatePresentations");
      out.fixes++;
    }
  }
  const associated = root.get("AF"); // associated files (PDF 2.0, PDF/A-3): not part of PDF/A-2
  if (!associated.isNull()) {
    if (associated.isArray()) associated.forEach((spec) => attachments.push(fileSpecName(spec)));
    root.delete("AF");
  }

  // 3. Annotations: forbidden and hidden ones go, hidden fields show, appearances are created.
  // Before the font step: MuPDF's appearances use non-embedded standard fonts that it embeds.
  convertAnnotations(doc, acro, out, attachments, empty);

  // 4. One pass over every object.
  const fonts: Obj[] = [];
  const profiles: Obj[] = [];
  const removedActions = new Set<string>();
  /** Counts a removed action chain once, even when several objects point to it. */
  const dropActions = (action: Obj) => {
    const key = objKey(action);
    if (removedActions.has(key)) return;
    removedActions.add(key);
    const [js, other] = countActions(action);
    if (js) out.remove("javascript", js);
    if (other) out.remove("actions", other);
  };
  let cmyk = false, rgb = false;
  walk(doc, (o, { parentKey }) => {
    if (o.isArray()) {
      if (isCMYK(o)) cmyk = true;
      if (isRGB(o)) rgb = true;
      if (o.length >= 2 && o.get(0).isName() && o.get(0).asName() === "ICCBased" && o.get(1).isStream()) profiles.push(o.get(1));
      return;
    }
    const type = nameOf(o, "Type"), subtype = nameOf(o, "Subtype");
    // A widget or form field may have no action at all (6.4.1), allowed types included: a form
    // button's submit, link or page turn goes with it (the button stays).
    if ((subtype === "Widget" || !o.get("FT").isNull()) && !o.get("A").isNull()) {
      dropActions(o.get("A"));
      o.delete("A");
    }
    // Actions are removed where they are referenced (/A of links and outline items, the
    // catalog's /OpenAction, /Next of another action), from every object that points to them:
    // the walk visits a shared action only once.
    for (const key of ["A", "OpenAction", "Next"]) {
      const v = o.get(key);
      if (v.isDictionary() && forbiddenAction(v)) {
        dropActions(v);
        o.delete(key);
      } else if (v.isArray() && key === "Next") {
        for (let i = v.length - 1; i >= 0; i--) {
          const a = v.get(i);
          if (a.isDictionary() && forbiddenAction(a)) {
            dropActions(a);
            v.delete(i);
          }
        }
      }
    }
    // Additional actions (on open, on close, keystroke scripts...): none allowed on the catalog,
    // pages, annotations or fields, the only places they live.
    const aa = o.get("AA");
    if (aa.isDictionary()) {
      aa.forEach((action) => dropActions(action));
      o.delete("AA");
    }
    // XMP of pages, images, fonts... (6.6.2): it would have to follow every rule the document's
    // follows, and PDF/A-2b needs none of it. It goes (the save's garbage collection drops it);
    // nothing visible changes.
    if (!o.get("Metadata").isNull() && type !== "Catalog" && !(o.isIndirect() && root.isIndirect() && o.asIndirect() === root.asIndirect())) {
      o.delete("Metadata");
      out.fixes++;
    }
    if (type === "Page" && !o.get("PresSteps").isNull()) { o.delete("PresSteps"); out.fixes++; } // 6.10
    if (isAnnotation(o, type, subtype)) {
      if (subtype === "Popup") {
        // A Popup may go without F (6.3.2), and without it does not print on its own, as with
        // a clear Print flag; a hidden one is closed instead.
        const f = intOf(o, "F");
        if (!o.get("F").isNull() && (!(f & F_PRINT) || f & HIDING_FLAGS)) {
          if (f & HIDING_FLAGS) o.put("Open", false);
          o.delete("F");
          out.fixes++;
        }
      } else {
        const f = intOf(o, "F");
        const fixed = (f | F_PRINT) & ~HIDING_FLAGS;
        if (fixed !== f) {
          o.put("F", fixed);
          out.fixes++;
        }
      }
      const ap = o.get("AP");
      if (ap.isDictionary() && (!ap.get("D").isNull() || !ap.get("R").isNull())) {
        ap.delete("D"); // only the normal appearance is allowed
        ap.delete("R");
        out.fixes++;
      }
      // After convertAnnotations: MuPDF's page update would write a button's stream again.
      if (fixNormalAppearance(doc, o, subtype, empty)) out.fixes++;
    }
    if (subtype === "Image") {
      for (const k of ["Alternates", "OPI"]) if (!o.get(k).isNull()) { o.delete(k); out.fixes++; }
      if (boolOf(o, "Interpolate")) { o.delete("Interpolate"); out.fixes++; }
      // An intent readers do not know is read as RelativeColorimetric (ISO 32000-1 8.6.5.8).
      if (badIntent(o, "Intent")) { o.put("Intent", "RelativeColorimetric"); out.fixes++; }
    }
    if (subtype === "Form") {
      if (!o.get("OPI").isNull()) { o.delete("OPI"); out.fixes++; }
      if (!o.get("Ref").isNull() || nameOf(o, "Subtype2") === "PS" || !o.get("PS").isNull()) out.block("external-content", undefined, 1);
    }
    if (subtype === "PS") out.block("external-content", undefined, 1);
    if (type === "ExtGState" || parentKey === "ExtGState") {
      if (!o.get("TR").isNull()) { o.delete("TR"); out.fixes++; }
      if (!o.get("TR2").isNull() && nameOf(o, "TR2") !== "Default") { o.delete("TR2"); out.fixes++; }
      if (!o.get("HTP").isNull()) { o.delete("HTP"); out.fixes++; }
      if (badIntent(o, "RI")) { o.put("RI", "RelativeColorimetric"); out.fixes++; }
      const bm = o.get("BM");
      const blend = bm.isName() ? bm.asName() : bm.isArray() && bm.length && bm.get(0).isName() ? bm.get(0).asName() : null;
      if (blend && !STANDARD_BLEND.has(blend)) {
        o.put("BM", "Normal");
        out.warn("blend-mode", undefined, 1);
      }
    }
    if (o.isStream()) {
      // Data in another file (F/FFilter/FDecodeParms on a stream).
      if (!o.get("F").isNull() || !o.get("FFilter").isNull()) out.block("external-content", undefined, 1);
      const filter = o.get("Filter");
      const filters: string[] = [];
      if (filter.isName()) filters.push(filter.asName());
      else if (filter.isArray()) filter.forEach((f) => { if (f.isName()) filters.push(f.asName()); });
      if (filters.includes("LZWDecode")) {
        // Rewritten unfiltered; the save compresses it with Flate.
        const buf = o.readStream();
        try {
          o.writeStream(buf);
        } finally {
          buf.destroy();
        }
        out.fixes++;
      }
    }
    // An embedded file still reachable another way (a GoToE target, a leftover file spec).
    if (!o.get("EF").isNull() && (type === "Filespec" || !o.get("F").isNull() || !o.get("UF").isNull())) {
      attachments.push(fileSpecName(o));
      o.delete("EF");
    }
    if (declares(o, isCMYK)) cmyk = true;
    if (declares(o, isRGB)) rgb = true;
    if (isFontDict(o)) {
      if (type !== "Font") { o.put("Type", "Font"); out.fixes++; } // 6.2.11.2
      fonts.push(o);
    }
  });
  if (attachments.length) out.remove("attachments", attachments.length, attachments.length === 1 && attachments[0] ? attachments[0] : undefined);
  if (!root.get("Requirements").isNull()) { root.delete("Requirements"); out.fixes++; }

  // 5. Optional content (layers): every configuration needs a unique Name and no AS, and an
  // Order that lists every layer (6.9).
  fixOptionalContent(doc, root.get("OCProperties"), out);

  // 6. What the content streams draw (every layer and appearance state), and their intents.
  const content = contentUse(doc);
  fixContentIntents(mupdf, doc, content.intents, out);

  // 7. Fonts.
  const probedNotdef = convertFonts(mupdf, doc, fonts, content.fonts, out);

  // 8. Colour: one output intent, ours (sRGB) unless the file has a usable one, DeviceCMYK only
  // with a CMYK intent, only valid profiles. A CMYK intent stays when nothing uses DeviceRGB (a
  // print PDF/A, whose own profile it is); with both in use no intent allows everything.
  const painted = deviceScan(mupdf, doc, type3NamesOf(fonts), nonEmbeddedNames(fonts));
  const usesCMYK = cmyk || content.deviceCMYK || painted.deviceCMYK;
  const usesRGB = rgb || content.deviceRGB || painted.deviceRGB;
  const intents = root.get("OutputIntents");
  const kept = keptIntent(mupdf, intents);
  const intent = kept === 3 || (kept === 4 && !usesRGB) ? kept : 3;
  if (intent !== kept) {
    if (!intents.isNull()) {
      root.delete("OutputIntents");
      out.warn("output-intent-replaced");
    }
    const profile = addStream(mupdf, doc, srgbProfile(), { N: 3 });
    root.put("OutputIntents", [doc.addObject({
      Type: "OutputIntent", S: "GTS_PDFA1", OutputConditionIdentifier: `(${OUTPUT_CONDITION})`,
      Info: `(${SRGB_PROFILE_NAME})`, RegistryName: "(http://www.color.org)", DestOutputProfile: profile,
    })]);
    out.fixes++;
  }
  if (intent === 3 && usesCMYK) out.block("cmyk");
  for (const [font, count] of mergeNotdef(probedNotdef, painted.notdef)) out.block("notdef", font, count);
  const checkedProfiles = new Set<string>();
  for (const p of profiles) {
    const key = objKey(p);
    if (checkedProfiles.has(key)) continue;
    checkedProfiles.add(key);
    if (iccProblem(mupdf, streamBytes(p), p.get("N").isNumber() ? intOf(p, "N") : null)) out.block("icc-invalid", undefined, 1);
  }

  // 9. Metadata: Info and XMP from the same values.
  writeMetadata(mupdf, doc, options.now ?? new Date());
  out.fixes++;

  // 10. File identifier: MuPDF keeps or renews an existing /ID but never creates one. The trailer
  // is fetched again here: one fetched before the document's first change is detached, and what
  // is written to it is lost on save (MuPDF.js 1.27).
  const id = doc.getTrailer().get("ID");
  if (!id.isArray() || id.length !== 2) {
    const value = doc.newByteString(globalThis.crypto.getRandomValues(new Uint8Array(16)));
    const arr = doc.newArray();
    arr.push(value);
    arr.push(value);
    doc.getTrailer().put("ID", arr);
    out.fixes++;
  }
  return out.report();
}

function convertAnnotations(doc: Doc, acro: Obj, out: Findings, attachments: string[], empty: () => Obj) {
  const needAppearances = acro.isDictionary() && boolOf(acro, "NeedAppearances");
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.loadPage(i);
    // Lists of their own: deleteAnnotation edits MuPDF's cached one. (MuPDF leaves Link and
    // Popup annotations out of getAnnotations; the object pass fixes their flags.)
    const annots = [...page.getAnnotations()];
    const widgets = [...page.getWidgets()];
    try {
      for (const a of annots) {
        const o = a.getObject();
        const subtype = nameOf(o, "Subtype") ?? "";
        if (!ISO_ANNOTS.has(subtype) || FORBIDDEN_ANNOTS.has(subtype)) {
          if (subtype === "FileAttachment") attachments.push(fileSpecName(o.get("FS")));
          else out.remove("annotations", 1);
          page.deleteAnnotation(a);
          continue;
        }
        // PDF/A wants every annotation printable and visible; a hidden one is meant not to show.
        if (subtype !== "Popup" && intOf(o, "F") & (F_HIDDEN | F_NOVIEW)) {
          page.deleteAnnotation(a);
          out.remove("annotations", 1);
          continue;
        }
        if (!ensureAppearance(a, o, subtype, false, out)) {
          page.deleteAnnotation(a);
          out.remove("annotations", 1);
        }
      }
      for (const w of widgets) {
        const o = w.getObject();
        const flags = intOf(o, "F");
        if (flags & (F_HIDDEN | F_NOVIEW)) {
          o.put("F", (flags | F_PRINT) & ~HIDING_FLAGS);
          out.remove("hidden-fields-shown", 1);
        }
        // With NeedAppearances, the appearances in the file may be stale: viewers redraw them.
        if (!ensureAppearance(w, o, "Widget", needAppearances, out)) {
          // A field MuPDF cannot draw (broken, or zero width): an empty appearance keeps the
          // field and its value, and draws what it drew before, nothing.
          const ap = o.get("AP");
          if (ap.isDictionary()) ap.put("N", empty());
          else o.put("AP", { N: empty() });
          out.fixes++;
        }
      }
      page.update();
    } finally {
      for (const a of annots) a.destroy();
      for (const w of widgets) w.destroy();
      page.destroy();
    }
  }
  if (needAppearances) {
    acro.delete("NeedAppearances");
    out.fixes++;
  }
}

/**
 * Gives an annotation a normal appearance (/AP /N) when it needs one: all but Popup, Link and
 * zero-size ones, whose Rect has no width AND no height (6.3.3). Returns false when MuPDF cannot
 * make one.
 */
function ensureAppearance(a: MuPDF.PDFAnnotation, o: Obj, subtype: string, regenerate: boolean, out: Findings): boolean {
  const rect = rectOf(o);
  if (subtype === "Popup" || subtype === "Link" || (rect.length === 4 && rect[0] === rect[2] && rect[1] === rect[3])) return true;
  const has = () => !o.get("AP", "N").isNull();
  if (has() && !regenerate) return true;
  try {
    a.update();
  } catch {
    // tried again below
  }
  if (!has() || regenerate) {
    // update() only rebuilds what MuPDF thinks changed: touching the contents forces it.
    try {
      a.setContents(a.getContents());
      a.update();
    } catch {
      // checked below
    }
  }
  if (has()) out.fixes++;
  return has();
}

function fixOptionalContent(doc: Doc, ocp: Obj, out: Findings) {
  if (!ocp.isDictionary()) return;
  const all: Obj[] = [];
  const groups = ocp.get("OCGs");
  if (groups.isArray()) groups.forEach((g) => { if (g.isIndirect()) all.push(g); });
  const configs: Obj[] = [ocp.get("D")];
  const more = ocp.get("Configs");
  if (more.isArray()) more.forEach((c) => configs.push(c));
  const used = new Set<string>();
  configs.forEach((c, i) => {
    if (!c.isDictionary()) return;
    let name = c.get("Name").isString() ? c.get("Name").asString() : "";
    if (!name || used.has(name)) {
      let n = i + 1;
      while (used.has(`Layers ${n}`)) n++;
      name = `Layers ${n}`;
      c.put("Name", doc.newString(name));
      out.fixes++;
    }
    used.add(name);
    if (!c.get("AS").isNull()) {
      c.delete("AS");
      out.fixes++;
    }
    const order = c.get("Order");
    if (order.isArray()) {
      const listed = new Set<number>();
      const collect = (arr: Obj, depth: number) => {
        if (depth > 16) return;
        arr.forEach((v) => {
          if (v.isArray()) collect(v, depth + 1);
          else if (v.isIndirect()) listed.add(v.asIndirect());
        });
      };
      collect(order, 0);
      for (const g of all)
        if (!listed.has(g.asIndirect())) {
          order.push(g);
          out.fixes++;
        }
    }
  });
}

/**
 * Makes every font PDF/A-2b: standard fonts embedded, the rest checked. Returns the .notdef
 * glyphs that text shows in embedded fonts, in any rendering mode, by font name (MuPDF's, as the
 * device scan reports it); the caller blocks on them with what the device scan found.
 */
function convertFonts(mupdf: MuPDFModule, doc: Doc, fonts: Obj[], uses: Map<string, FontUse>, out: Findings): Map<string, number> {
  const probes = new FontProbes(mupdf);
  const notdef = new Map<string, number>();
  const countNotdef = (probe: Probe, codes: Set<number>, fallback: string) => {
    const n = notdefCodes(probe, codes);
    const name = probe.name || fallback;
    if (n) notdef.set(name, Math.max(notdef.get(name) ?? 0, n));
  };
  for (const font of fonts) {
    const status = fontStatus(font);
    if (status.subtype === "Type3") continue;
    const use = uses.get(objKey(font));
    const visible = drawsVisibly(use);
    const name = untag(status.base) || "?";
    // 6.2.11.2: a simple font that text uses, in any rendering mode, needs FirstChar, LastChar
    // and Widths (standard fonts get them below, when embedded).
    const needsWidths = !!use && SIMPLE_FONTS.has(status.subtype);
    if (status.embedded) {
      // PDF/A-2: CIDSet and CharSet are optional but must be complete; subsetting tools often
      // leave them stale. Dropping them is always safe for part 2.
      const fd = status.descriptor;
      for (const k of ["CIDSet", "CharSet"]) if (fd.isDictionary() && !fd.get(k).isNull()) { fd.delete(k); out.fixes++; }
      // A descendant reached only through its Type 0 parent (a direct object) is fixed here too.
      if (fixCidToGid(doc, font)) out.fixes++;
      if (status.subtype === "Type0" && fixCidToGid(doc, font.get("DescendantFonts", 0))) out.fixes++;
      if (needsWidths && completeWidths(probes, font)) out.fixes++;
      const bytesPerCode = widthCheckable(font, status);
      if (use?.allCodes?.size && bytesPerCode) {
        const probe = probes.probe(font, use.allCodes, bytesPerCode);
        countNotdef(probe, use.allCodes, name);
        if (visible && use.codes && widthMismatches(probe, use.codes)) out.block("font-widths", name);
      }
      continue;
    }
    // A descendant CIDFont is judged with its Type 0 parent.
    if (status.subtype.startsWith("CIDFont")) continue;
    const std = status.subtype === "Type0" ? null : standardFontFor(status.base);
    // A symbolic TrueType font draws by glyph index: a standard font would draw other glyphs.
    const symbolicTrueType = status.subtype === "TrueType" && status.descriptor.isDictionary() &&
      (intOf(status.descriptor, "Flags") & 4) !== 0 && std !== "Symbol" && std !== "ZapfDingbats";
    if (!std || symbolicTrueType) {
      // Not embedded and nothing equivalent to embed: blocks if it draws anything visible.
      // Invisible text (OCR) may keep it, with complete widths.
      if (visible) out.block("font-not-embedded", name);
      else if (needsWidths && completeWidths(probes, font)) out.fixes++;
      continue;
    }
    // Embedded even when unused: cheap, and it leaves no font that could be taken for missing.
    const r = embedStandardFont(probes, doc, font, std, visible ? use?.codes ?? null : new Set());
    out.fixes++;
    if (use?.allCodes) countNotdef(r.after, use.allCodes, std);
    if (!visible) continue;
    if (r.glyphChanges) out.block("font-changed", name);
    else if (r.widthChanges) out.warn("text-may-shift", name);
  }
  return notdef;
}

function writeMetadata(mupdf: MuPDFModule, doc: Doc, now: Date) {
  let info = doc.getTrailer().get("Info");
  if (!info.isDictionary()) {
    info = doc.addObject(doc.newDictionary());
    doc.getTrailer().put("Info", info);
  }
  // Text values: the XMP must be valid XML, so characters XML cannot hold are dropped from both.
  const text = (key: string): string | null => {
    const raw = doc.getMetaData(`info:${key}`);
    if (raw === undefined || raw === "") return null;
    const clean = raw.replace(XML_INVALID, "");
    if (clean !== raw) info.put(key, doc.newString(clean));
    return clean || null;
  };
  const values = {
    title: text("Title"), author: text("Author"), subject: text("Subject"),
    keywords: text("Keywords"), creator: text("Creator"), producer: text("Producer"),
  };
  const created = pdfDateToXmp(doc.getMetaData("info:CreationDate"));
  if (!created && !info.get("CreationDate").isNull()) info.delete("CreationDate"); // unreadable
  const modified = dateToPdf(now);
  info.put("ModDate", doc.newString(modified));
  if (!info.get("Trapped").isNull()) info.delete("Trapped"); // a prepress flag, with values PDF/A-1 restricts
  const xmp = buildXmp({ ...values, created, modified: pdfDateToXmp(modified)! });
  // Written with addStream: MuPDF's compress=yes leaves Metadata streams unfiltered.
  catalog(doc).put("Metadata", addStream(mupdf, doc, xmp, { Type: "Metadata", Subtype: "XML" }));
}

// ---------------------------------------------------------------------------------------------
// The check of a saved file

/**
 * Re-opens a saved PDF/A file and checks what this engine knows of PDF/A-2b. Returns the
 * problems found (English, for the error message and the logs); empty when the file passes.
 * Not a validator: veraPDF is (CI). It catches a conversion that did not land in the bytes.
 */
export function checkPdfA(mupdf: MuPDFModule, bytes: Uint8Array): string[] {
  const problems: string[] = [];
  const fail = (what: string) => problems.push(what);

  // File structure (6.1.2, 6.1.3): the header, a binary comment, nothing after %%EOF.
  const head = latin1(bytes, 0, 20);
  const m = /^%PDF-1\.[0-7](\r\n|\r|\n)%/.exec(head);
  if (!m || ![1, 2, 3, 4].every((k) => bytes[m[0].length - 1 + k] > 127)) fail("header: %PDF-1.n then a comment with 4 bytes above 127");
  const tail = latin1(bytes, Math.max(0, bytes.length - 64), bytes.length);
  const eof = tail.lastIndexOf("%%EOF");
  if (eof < 0 || !/^(\r\n|\r|\n)?$/.test(tail.slice(eof + 5))) fail("something after %%EOF");

  const doc = mupdf.Document.openDocument(bytes, "application/pdf").asPDF();
  if (!doc) return [...problems, "not a PDF"];
  try {
    const trailer = doc.getTrailer();
    if (doc.needsPassword() || !trailer.get("Encrypt").isNull()) fail("encrypted");
    const id = trailer.get("ID");
    if (!id.isArray() || id.length !== 2) fail("no file identifier (/ID)");
    const root = trailer.get("Root");

    // Output intent (6.2.3): its profile's components decide which device space is allowed.
    const intents = root.get("OutputIntents");
    let intentComponents = 0;
    if (!intents.isArray() || intents.length !== 1) fail("not exactly one output intent");
    else {
      const oi = intents.get(0);
      if (nameOf(oi, "S") !== "GTS_PDFA1" || oi.get("OutputConditionIdentifier").isNull()) fail("output intent is not GTS_PDFA1");
      const profile = intentProfile(mupdf, oi.get("DestOutputProfile"));
      if (typeof profile === "string") fail(`output intent profile: ${profile}`);
      else intentComponents = profile;
    }

    // Metadata (6.6).
    const meta = root.get("Metadata");
    let xmp = "";
    if (!meta.isStream()) fail("no XMP metadata");
    else {
      if (!meta.get("Filter").isNull()) fail("XMP metadata is compressed");
      xmp = new TextDecoder().decode(streamBytes(meta));
    }
    if (pdfaClaim(doc) !== "2B") fail("XMP does not claim PDF/A-2B");
    if (!/^<\?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"\?>/.test(xmp)) fail("XMP packet header");
    const mismatched = INFO_IN_XMP.filter(([key, re]) => {
      const info = doc.getMetaData(`info:${key}`) || null;
      const want = key.endsWith("Date") ? pdfDateToXmp(info) : info;
      const found = re.exec(xmp);
      return (want ?? null) !== (found ? xmlUnescape(found[1]) : null);
    });
    if (mismatched.length) fail(`Info and XMP differ: ${mismatched.map(([k]) => k).join(", ")}`);

    // Document level.
    if (!root.get("Collection").isNull()) fail("portfolio");
    if (!root.get("AA").isNull()) fail("catalog additional actions");
    const names = root.get("Names");
    if (names.isDictionary() && (!names.get("JavaScript").isNull() || !names.get("EmbeddedFiles").isNull())) fail("document JavaScript or attached files");
    if (names.isDictionary() && !names.get("AlternatePresentations").isNull()) fail("alternate presentations");
    const acro = root.get("AcroForm");
    if (acro.isDictionary() && (boolOf(acro, "NeedAppearances") || !acro.get("XFA").isNull())) fail("NeedAppearances or XFA");
    if (signedFields(doc).length) fail("a signature (its byte range cannot cover this new file)");

    // Every object.
    const fonts: Obj[] = [];
    const found = new Set<string>();
    let cmyk = false, rgb = false;
    walk(doc, (o, ctx) => {
      if (o.isArray()) {
        if (isCMYK(o)) cmyk = true;
        if (isRGB(o)) rgb = true;
        if (o.length >= 2 && o.get(0).isName() && o.get(0).asName() === "ICCBased" && o.get(1).isStream()) {
          const p = o.get(1);
          if (iccProblem(mupdf, streamBytes(p), p.get("N").isNumber() ? intOf(p, "N") : null)) found.add("invalid ICC profile");
        }
        return;
      }
      const type = nameOf(o, "Type"), subtype = nameOf(o, "Subtype"), S = nameOf(o, "S");
      if (isFontDict(o)) {
        fonts.push(o);
        if (type !== "Font") found.add("font dictionary without /Type /Font");
      }
      if (S && (type === "Action" || ["A", "OpenAction", "Next"].includes(ctx.key)) &&
        (!ALLOWED_ACTIONS.has(S) || (S === "Named" && !ALLOWED_NAMED.has(nameOf(o, "N") ?? "")))) found.add(`forbidden action ${S}`);
      if (!o.get("AA").isNull()) found.add("additional actions (AA)");
      if ((subtype === "Widget" || !o.get("FT").isNull()) && !o.get("A").isNull()) found.add("widget action (A)");
      if (o.get("Metadata").isStream() && type !== "Catalog") found.add("object-level XMP metadata");
      if (type === "Page" && !o.get("PresSteps").isNull()) found.add("presentation steps (PresSteps)");
      if (isAnnotation(o, type, subtype)) {
        const f = intOf(o, "F");
        // A Popup may omit F; with it, the same rule as every annotation.
        if ((subtype !== "Popup" || !o.get("F").isNull()) && (!(f & F_PRINT) || f & HIDING_FLAGS)) found.add("annotation flags (Print, hidden)");
        if (!subtype || !ISO_ANNOTS.has(subtype) || FORBIDDEN_ANNOTS.has(subtype)) found.add(`forbidden annotation ${subtype}`);
        const rect = rectOf(o);
        const zero = rect.length === 4 && rect[0] === rect[2] && rect[1] === rect[3];
        const n = o.get("AP", "N");
        if (subtype !== "Popup" && subtype !== "Link" && !zero && n.isNull()) found.add("annotation without appearance");
        const ap = o.get("AP");
        if (ap.isDictionary() && (!ap.get("D").isNull() || !ap.get("R").isNull())) found.add("annotation with D/R appearances");
        if (!n.isNull()) {
          if (subtype === "Widget" && isButton(o)) {
            if (n.isStream() || !n.isDictionary() || !hasStream(n)) found.add("button appearance (N) is not a dictionary of states");
          } else if (!n.isStream()) found.add("appearance (N) is not a stream");
        }
      }
      if (subtype === "Image" && (boolOf(o, "Interpolate") || !o.get("Alternates").isNull() || !o.get("OPI").isNull())) found.add("image Interpolate/Alternates/OPI");
      if (subtype === "Image" && badIntent(o, "Intent")) found.add("image rendering intent");
      if (subtype === "PS" || (subtype === "Form" && (!o.get("Ref").isNull() || !o.get("PS").isNull()))) found.add("external content");
      if (type === "ExtGState" || ctx.parentKey === "ExtGState") {
        if (!o.get("TR").isNull() || (!o.get("TR2").isNull() && nameOf(o, "TR2") !== "Default")) found.add("transfer function");
        if (badIntent(o, "RI")) found.add("graphics state rendering intent");
        const bm = o.get("BM");
        const blend = bm.isName() ? bm.asName() : bm.isArray() && bm.length && bm.get(0).isName() ? bm.get(0).asName() : null;
        if (blend && !STANDARD_BLEND.has(blend)) found.add(`blend mode ${blend}`);
      }
      if (o.isStream()) {
        if (!o.get("F").isNull() || !o.get("FFilter").isNull()) found.add("stream data in an external file");
        if (o.get("Filter").toString().includes("LZWDecode")) found.add("LZW compression");
      }
      if (!o.get("EF").isNull()) found.add("embedded file");
      if (declares(o, isCMYK)) cmyk = true;
      if (declares(o, isRGB)) rgb = true;
    });
    for (const f of found) fail(f);

    // Fonts (6.2.11): dictionaries complete, programs embedded where text is drawn, widths in step
    // with them, no .notdef in any rendering mode.
    const content = contentUse(doc);
    const probes = new FontProbes(mupdf);
    const notdef = new Set<string>();
    const fontProblems = new Set<string>();
    for (const font of fonts) {
      const status = fontStatus(font);
      const name = untag(status.base);
      if (status.subtype === "CIDFontType2" && status.embedded && !cidToGidOk(font)) fontProblems.add(`font ${name}: CIDFontType2 without CIDToGIDMap`);
      const use = content.fonts.get(objKey(font));
      if (status.subtype === "Type3" || status.subtype.startsWith("CIDFont") || !use) continue;
      if (SIMPLE_FONTS.has(status.subtype) && !unembeddedStandard(status) && !hasWidths(font)) fontProblems.add(`font ${name}: FirstChar, LastChar or Widths missing`);
      const bytesPerCode = widthCheckable(font, status);
      if (status.embedded && bytesPerCode && use.allCodes?.size) {
        const probe = probes.probe(font, use.allCodes, bytesPerCode);
        if (notdefCodes(probe, use.allCodes)) notdef.add(probe.name || name);
        if (drawsVisibly(use) && use.codes && widthMismatches(probe, use.codes)) fontProblems.add(`font ${name}: widths differ from the program`);
      }
      if (drawsVisibly(use) && !status.embedded) fontProblems.add(`font ${name} not embedded`);
    }
    for (const f of fontProblems) fail(f);

    // Colour (6.2.4.3) and what is painted (6.2.11.8).
    const painted = deviceScan(mupdf, doc, type3NamesOf(fonts), nonEmbeddedNames(fonts));
    if (intentComponents !== 4 && (cmyk || content.deviceCMYK || painted.deviceCMYK)) fail("DeviceCMYK");
    if (intentComponents === 4 && (rgb || content.deviceRGB || painted.deviceRGB)) fail("DeviceRGB with a CMYK output intent");
    if (content.intents.length) fail("rendering intent in content (ri, inline image)");
    for (const font of painted.notdef.keys()) notdef.add(font);
    for (const font of notdef) fail(`.notdef glyph drawn (${font})`);
  } finally {
    doc.destroy();
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Content streams

/**
 * An operand: a number, a name (with where its token, "/" included, is in the stream), a
 * string's bytes, an array, or null (a dictionary, a boolean...).
 */
type Operand = number | NameOperand | Uint8Array | Operand[] | null;
interface NameOperand {
  name: string;
  at: number;
  end: number;
}

const isName = (v: Operand | undefined): v is NameOperand =>
  typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array);

const WHITE = 1, DELIMITER = 2;
const CHAR_CLASS = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) CHAR_CLASS[c] = WHITE;
for (const c of "()<>[]{}/%") CHAR_CLASS[c.charCodeAt(0)] = DELIMITER;

function hexValue(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x37;
  if (c >= 0x61 && c <= 0x66) return c - 0x57;
  return -1;
}

function latin1(s: Uint8Array, from: number, to: number): string {
  let out = "";
  for (let i = from; i < to; i++) out += String.fromCharCode(s[i]);
  return out;
}

/** A name token's text, with #xx escapes decoded. */
function decodeName(s: Uint8Array, from: number, to: number): string {
  let out = "";
  for (let i = from; i < to; i++) {
    if (s[i] === 0x23 && i + 2 < to && hexValue(s[i + 1]) >= 0 && hexValue(s[i + 2]) >= 0) {
      out += String.fromCharCode(hexValue(s[i + 1]) * 16 + hexValue(s[i + 2]));
      i += 2;
    } else out += String.fromCharCode(s[i]);
  }
  return out;
}

/**
 * A small content-stream reader: calls `onOp` with each operator and its operands. Enough for
 * fonts, text and colours (strings, arrays, names, numbers); dictionaries are skipped whole. An
 * inline image's dictionary entries reach `onOp` as the operands of "ID", then its data is
 * jumped over. Not a full PDF parser.
 */
function scanContent(s: Uint8Array, onOp: (op: string, args: Operand[]) => void) {
  const n = s.length;
  let i = 0;
  let args: Operand[] = [];
  const arrays: Operand[][] = [];
  let dictDepth = 0;
  const push = (v: Operand) => {
    if (dictDepth > 0) return;
    (arrays.length ? arrays[arrays.length - 1] : args).push(v);
  };
  while (i < n) {
    const c = s[i];
    if (CHAR_CLASS[c] === WHITE) {
      i++;
    } else if (c === 0x25) { // % comment
      while (i < n && s[i] !== 10 && s[i] !== 13) i++;
    } else if (c === 0x28) { // (literal string)
      const out: number[] = [];
      let depth = 1;
      i++;
      while (i < n) {
        const x = s[i++];
        if (x === 0x5c) {
          const y = s[i++];
          if (y >= 0x30 && y <= 0x37) {
            let v = y - 0x30;
            for (let d = 0; d < 2 && i < n && s[i] >= 0x30 && s[i] <= 0x37; d++) v = v * 8 + (s[i++] - 0x30);
            out.push(v & 255);
          } else if (y === 0x6e) out.push(10);
          else if (y === 0x72) out.push(13);
          else if (y === 0x74) out.push(9);
          else if (y === 0x62) out.push(8);
          else if (y === 0x66) out.push(12);
          else if (y === 13) { if (s[i] === 10) i++; } // line continuation
          else if (y !== 10 && y !== undefined) out.push(y);
          continue;
        }
        if (x === 0x28) depth++;
        else if (x === 0x29 && --depth === 0) break;
        out.push(x);
      }
      push(Uint8Array.from(out));
    } else if (c === 0x3c) {
      if (s[i + 1] === 0x3c) { // << dictionary
        dictDepth++;
        i += 2;
        continue;
      }
      const out: number[] = []; // <hex string>
      let high = -1;
      for (i++; i < n && s[i] !== 0x3e; i++) {
        const h = hexValue(s[i]);
        if (h < 0) continue;
        if (high < 0) high = h;
        else {
          out.push(high * 16 + h);
          high = -1;
        }
      }
      if (high >= 0) out.push(high * 16);
      i++;
      push(Uint8Array.from(out));
    } else if (c === 0x3e) {
      if (s[i + 1] === 0x3e) {
        i += 2;
        if (dictDepth > 0 && --dictDepth === 0) push(null);
      } else i++;
    } else if (c === 0x5b) {
      i++;
      if (dictDepth === 0) arrays.push([]);
    } else if (c === 0x5d) {
      i++;
      if (dictDepth === 0 && arrays.length) push(arrays.pop()!);
    } else if (c === 0x2f) { // /name
      let j = i + 1;
      while (j < n && CHAR_CLASS[s[j]] === 0) j++;
      push({ name: decodeName(s, i + 1, j), at: i, end: j });
      i = j;
    } else if (CHAR_CLASS[c] === DELIMITER) {
      i++; // a stray ) { }
    } else {
      let j = i;
      while (j < n && CHAR_CLASS[s[j]] === 0) j++;
      const word = j - i > 64 ? "" : latin1(s, i, j);
      i = j;
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) push(Number(word));
      else if (word === "true" || word === "false" || word === "null" || word === "") push(null);
      else if (dictDepth > 0) continue;
      else if (word === "ID") {
        arrays.length = 0;
        onOp("ID", args);
        // Inline image data: binary, up to "EI" between white space.
        let k = i + 1;
        while (k + 1 < n && !(s[k] === 0x45 && s[k + 1] === 0x49 && CHAR_CLASS[s[k - 1]] === WHITE && (k + 2 >= n || CHAR_CLASS[s[k + 2]] === WHITE))) k++;
        i = k + 2;
        args = [];
        arrays.length = 0;
      } else {
        arrays.length = 0; // an operator ends any unclosed array
        onOp(word, args);
        args = [];
      }
    }
  }
}
