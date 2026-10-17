// Form fields (AcroForm): listing them for the overlay, and filling them in as logged edits
// (ARCHITECTURE.md, "Fill and sign"). Ported from the release 3 research prototypes
// (forms-proto.ts, writer-proto.ts), verified on reportlab-form and synthetic forms.
//
// MuPDF.js 1.27 reads every field type correctly but checks nothing when a value is set: it
// ignores ReadOnly and MaxLen, takes any combo value, and writes V=(x) even on push buttons and
// signature fields. So every check is made here, before anything is logged (planFieldEdit), and
// applyFieldEdit, shared by the first application and every replay, only does what a plan says:
//
// - identity is the field's full name ("a.b.c"): an edit fills every field dictionary with that
//   name and all their widgets, on every page, as readers group same-named fields;
// - text, combo and list values: MuPDF's own setters and update() draw the appearance when the
//   text is all WinAnsi, the one case MuPDF draws right. Anything else (Polish, Romanian, Greek,
//   CJK...) MuPDF puts under the field's bottom edge or draws with fonts it does not embed, so the
//   app writes the text itself, inside the frame MuPDF drew for an empty value (background,
//   border, clip, /Matrix), with core.js's embedded fallback fonts (encodeWithFallbacks), laid
//   out as MuPDF lays out WinAnsi text (to within 0.01 pt). List boxes always go through the
//   writer: MuPDF draws no highlight for the selected rows;
// - check boxes and radio buttons: never MuPDF's toggle(), which in 1.27 turns on /AS of every
//   widget of a group (all radios drawn on, and NoToggleToOff refusing any later choice). The
//   field's /V and each widget's /AS are set here; a widget without appearance states gets a
//   small pair drawn with ZapfDingbats, each radio button of a group an on state of its own;
//   state names are written back with the bytes the file spells them with (an older producer's
//   Latin-1 "Sì", which MuPDF.js would read and write as other bytes);
// - text is kept and drawn Unicode composed (NFC), line breaks of every kind as line breaks,
//   without controls, zero-width spaces, word joiners or BOMs; ZWNJ, ZWJ, LRM and RLM are kept in
//   the value (they spell Persian and Hindi words, emoji sequences, the order of Hebrew text) and
//   left out of the drawing only, which cannot show those scripts anyway; values another tool
//   wrote are made so for drawing only (their /V stays);
// - a password is never drawn: a password widget without an appearance gets its frame only
//   (hidePasswords), since MuPDF draws the value of such a widget in clear;
// - JavaScript never runs (this MuPDF build has none): keystroke, format, validate and calculate
//   scripts are reported (FieldWidget.scripted, FormInfo.scripts), never executed;
// - a static XFA part is removed on the first field edit (it would keep the old data), and a form
//   with /NeedAppearances gets real appearances for all its fields and loses the flag: with it,
//   MuPDF redraws every field on every page load with its own drawing, which shows non-WinAnsi
//   values cut off, and the app's appearances would never be seen.
//
// pdfa.ts uses drawFieldsWithWriter and hidePasswords for the same reasons when it gives fields
// their appearances.
//
// The document's fields by name (which pages, types, flags) are read in one pass over every
// widget, kept per working document and reused until the session says the document changed
// (formChanged, after every applied edit, undo, redo, rebuild and recover; a field edit also says
// so itself): listing one page's fields costs that page only, not the whole form, and formInfo's
// counts come from the same pass.
//
// MuPDF objects: widget wrappers are destroyed before their page (they hold annotation
// references whose page pointer would dangle), pages, buffers and fonts explicitly
// (ARCHITECTURE.md rule 5). PDFObject wrappers are left to the garbage collector, as everywhere
// else in the engine; the kept index holds plain data only. A page's getWidgets() is read once
// per loaded page: MuPDF.js caches the wrappers on the page, destroyed ones included.
import type * as MuPDF from "mupdf";
import { encodeWithFallbacks, fontKey } from "./core.js";
import { MAX_FIELD_CHARS } from "./protocol";
import type { FieldLock, FieldOption, FieldType, FieldValue, FieldWidget, FontFamily, FormInfo, Rect } from "./protocol";
import { WinAnsiEncoding } from "./tables.js";

type MuPDFModule = typeof MuPDF;
type Doc = MuPDF.PDFDocument;
type Obj = MuPDF.PDFObject;
type Widget = MuPDF.PDFWidget;
type Page = MuPDF.PDFPage;

/** A refusal of planFieldEdit, with the session's error code ("bad-request" or "not-editable"). */
export class FieldError extends Error {
  constructor(message: string, readonly code: "bad-request" | "not-editable") {
    super(message);
    this.name = "FieldError";
  }
}

/** A field filled in, as the session logs it (plain data: replayed by undo, redo and checkpoints). */
export interface FieldEdit {
  kind: "field";
  /** Full name: every field dictionary with that name gets the value. */
  name: string;
  /** The type the field must still have: a replay that finds another type, or no field, fails. */
  type: FieldType;
  /** Already checked and normalised by planFieldEdit. */
  value: FieldValue;
  /** First page with a widget of the field. */
  pageIndex: number;
  /**
   * Every page with a widget of the field, ascending (HistoryState.changedPages); with
   * /NeedAppearances, every page with a widget (the edit gives all fields their appearances).
   */
  pages: number[];
}

/** What applying a field edit could not do perfectly. */
export interface FieldEditOutcome {
  /** Characters no font can draw: kept in the value, left out of the appearance. */
  missingChars: string[];
  /** Some text does not fit its box (multi-line, or single-line with a fixed size). */
  overflow: boolean;
}

// ---------------------------------------------------------------------------------------------
// Flags and small object helpers

const FF_READ_ONLY = 1, FF_REQUIRED = 2;
const FF_MULTILINE = 1 << 12, FF_PASSWORD = 1 << 13, FF_FILE_SELECT = 1 << 20, FF_COMB = 1 << 24;
const FF_RADIO = 1 << 15, FF_PUSHBUTTON = 1 << 16;
const FF_COMBO = 1 << 17, FF_EDIT = 1 << 18, FF_MULTI_SELECT = 1 << 21;
const F_HIDDEN = 2, F_NOVIEW = 32;
/** How deep a field's /Parent chain is followed (a loop guard). */
const MAX_DEPTH = 32;

/** Acrobat's highlight colour for the selected rows of a list box. */
const LIST_HIGHLIGHT = "0.6 0.757 0.855 rg";
/** Line height of multi-line text and list rows, per point of size (MuPDF's). */
const LINE_HEIGHT = 1.116;

/** The Unicode characters WinAnsi can encode (MuPDF draws these right with its Helv, TiRo, Cour). */
const WIN_ANSI = new Set<number>((WinAnsiEncoding as number[]).filter((u) => u >= 0x20 && u !== 0x7f));

/** Text MuPDF's own appearance drawing gets right: WinAnsi characters and line breaks only. */
export function isWinAnsi(text: string): boolean {
  for (const ch of text) if (ch !== "\n" && !WIN_ANSI.has(ch.codePointAt(0)!)) return false;
  return true;
}

/** Format characters that mean nothing in a value (ZWSP, word joiner, BOM): left out of what is kept. */
const EMPTY_CHARS = /[\u200b\u2060\ufeff]/g;
/**
 * Format characters that are part of the text (ZWNJ, ZWJ, LRM, RLM: Persian and Hindi spelling,
 * emoji sequences, the direction of Hebrew and Arabic): kept in the value, left out of the
 * drawing, since they draw nothing and no font has a glyph for them.
 */
const JOINERS_AND_MARKS = /[\u200c-\u200f]/g;
/** Controls other than the line break (C0, DEL, C1): they draw nothing and confuse other readers. */
const CONTROLS = /[\u0001-\u0009\u000b-\u001f\u007f-\u009f]/g;

/**
 * A field's text as the app keeps it: composed (NFC: a decomposed accent, as macOS pastes it,
 * has no glyph of its own in the fonts), every kind of line break a "\n" (Acrobat stores CR), or
 * a space in a single-line field, tabs as spaces, zero-width spaces, word joiners, BOMs and
 * controls left out; ZWNJ, ZWJ, LRM and RLM kept (drawnText leaves them out). Idempotent: text
 * from the main thread is made so before it is logged (cleanText).
 */
function normalText(text: string, multiline: boolean): string {
  let out = text.normalize("NFC").replace(/\r\n?|[\u2028\u2029]/g, "\n").replace(/\t/g, " ").replace(EMPTY_CHARS, "");
  if (!multiline) out = out.replace(/\n/g, " ");
  return out.replace(CONTROLS, "");
}

/**
 * A field's text as the appearance draws it: normalText without the joiners and marks it keeps,
 * so they are never drawn nor reported missing. Values another tool wrote are drawn so too
 * (their /V stays as it is).
 */
function drawnText(text: string, multiline: boolean): string {
  return normalText(text, multiline).replace(JOINERS_AND_MARKS, "");
}

const fmt = (v: number) => String(+v.toFixed(3));

/** Writes `content` into a stream object through a Buffer destroyed right after (rule 5). */
function writeContent(mupdf: MuPDFModule, stream: Obj, content: string) {
  const buf = new mupdf.Buffer(content);
  try {
    stream.writeStream(buf);
  } finally {
    buf.destroy();
  }
}

/** A new stream object with `content`, through a Buffer destroyed right after (rule 5). */
function addContent(mupdf: MuPDFModule, doc: Doc, content: string, dict: Record<string, unknown>): Obj {
  const buf = new mupdf.Buffer(content);
  try {
    return doc.addStream(buf, dict);
  } finally {
    buf.destroy();
  }
}

/** The node and its /Parent chain, nearest first (each object once, at most MAX_DEPTH). */
function chainOf(o: Obj): Obj[] {
  const out: Obj[] = [];
  const seen = new Set<number>();
  let node = o;
  while (node.isDictionary() && out.length < MAX_DEPTH) {
    if (node.isIndirect()) {
      if (seen.has(node.asIndirect())) break;
      seen.add(node.asIndirect());
    }
    out.push(node);
    node = node.get("Parent");
  }
  return out;
}

/** A field entry the widget inherits (FT, Ff, V, Q, Opt...): its own, else its nearest parent's. */
function inherited(o: Obj, key: string): Obj | null {
  for (const node of chainOf(o)) {
    const v = node.get(key);
    if (!v.isNull()) return v;
  }
  return null;
}

const intOf = (o: Obj | null) => (o && o.isNumber() ? o.asNumber() : 0);
const nameOf = (o: Obj | null) => (o && o.isName() ? o.asName() : null);

/**
 * The full field name, as ISO 32000 defines it and MuPDF's getName() reads it: the partial
 * names (/T) from the root down joined with periods; a dictionary without /T adds nothing.
 */
export function fullName(o: Obj): string {
  const parts: string[] = [];
  for (const node of chainOf(o)) {
    const t = node.get("T");
    const s = t.isString() ? t.asString() : "";
    if (s) parts.push(s);
  }
  return parts.reverse().join(".");
}

/** The field type, from the inherited /FT and /Ff, as MuPDF reads it; null when it is no field. */
export function fieldTypeOf(o: Obj): FieldType | null {
  const ff = intOf(inherited(o, "Ff"));
  switch (nameOf(inherited(o, "FT"))) {
    case "Btn":
      return ff & FF_PUSHBUTTON ? "button" : ff & FF_RADIO ? "radio" : "checkbox";
    case "Tx":
      return "text";
    case "Ch":
      return ff & FF_COMBO ? "combo" : "list";
    case "Sig":
      return "signature";
    default:
      return null;
  }
}

/**
 * The field dictionary a widget belongs to: the nearest node of its chain with a partial name
 * (itself when the field and its only widget are one dictionary). Its /V is the field's value;
 * MuPDF's setters write there too.
 */
function fieldDictOf(o: Obj): Obj {
  for (const node of chainOf(o)) if (!node.get("T").isNull()) return node;
  return o;
}

/** A stable key for an object: its number when indirect, else its MuPDF pointer. */
const keyOf = (o: Obj) => (o.isIndirect() ? `n${o.asIndirect()}` : `p${o.pointer}`);

/** /Rect as four numbers (zeros when it is broken). */
function rectOf(o: Obj): Rect {
  const r = o.get("Rect");
  const n = (i: number) => (r.isArray() && r.get(i).isNumber() ? r.get(i).asNumber() : 0);
  return [Math.min(n(0), n(2)), Math.min(n(1), n(3)), Math.max(n(0), n(2)), Math.max(n(1), n(3))];
}

/** A widget the overlay shows: not hidden, not NoView, with some area. */
function isListed(o: Obj): boolean {
  if (intOf(o.get("F")) & (F_HIDDEN | F_NOVIEW)) return false;
  const r = rectOf(o);
  return r[2] - r[0] > 0 && r[3] - r[1] > 0;
}

/** The widget annotations listed in the page's /Annots (read without loading the page). */
function widgetAnnots(doc: Doc, pageIndex: number): Obj[] {
  const annots = doc.findPage(pageIndex).get("Annots");
  const out: Obj[] = [];
  if (!annots.isArray()) return out;
  for (let i = 0; i < annots.length; i++) {
    const a = annots.get(i);
    if (a.isDictionary() && nameOf(a.get("Subtype")) === "Widget") out.push(a);
  }
  return out;
}

/** Runs `fn` on a loaded page and its widgets, then destroys the widgets and the page (rule 5). */
function withWidgets<T>(doc: Doc, pageIndex: number, fn: (page: Page, widgets: Widget[]) => T): T {
  const page = doc.loadPage(pageIndex);
  let widgets: Widget[] = [];
  try {
    widgets = [...page.getWidgets()];
    return fn(page, widgets);
  } finally {
    for (const w of widgets) w.destroy();
    page.destroy();
  }
}

/** The text of a JavaScript action's /JS (a string or a stream), "" for other actions. */
function scriptOf(action: Obj): string {
  if (!action.isDictionary() || nameOf(action.get("S")) !== "JavaScript") return "";
  const js = action.get("JS");
  if (js.isString()) return js.asString();
  if (js.isStream()) {
    const buf = js.readStream();
    try {
      return buf.asString();
    } finally {
      buf.destroy();
    }
  }
  return "";
}

/** The field's keystroke, format, validate and calculate scripts (/AA K, F, V, C), along its chain. */
function fieldScripts(o: Obj): { any: boolean; format: string } {
  let any = false, format = "";
  for (const node of chainOf(o)) {
    const aa = node.get("AA");
    if (!aa.isDictionary()) continue;
    for (const key of ["K", "F", "V", "C"]) {
      const js = scriptOf(aa.get(key));
      if (!js) continue;
      any = true;
      if (key === "F" && !format) format = js;
    }
  }
  return { any, format };
}

/** Object numbers of the fields the form calculates (/AcroForm /CO). */
function calculated(doc: Doc): Set<number> {
  const co = doc.getTrailer().get("Root", "AcroForm", "CO");
  const out = new Set<number>();
  if (co.isArray()) for (let i = 0; i < co.length; i++) if (co.get(i).isIndirect()) out.add(co.get(i).asIndirect());
  return out;
}

// Acrobat's AFDate_Format(n) formats.
const AF_DATE_FORMATS = ["m/d", "m/d/yy", "mm/dd/yy", "mm/yy", "d-mmm", "d-mmm-yy", "dd-mmm-yy", "yy-mm-dd",
  "mmm-yy", "mmmm-yy", "mmm d, yyyy", "mmmm d, yyyy", "m/d/yy h:MM tt", "m/d/yy HH:MM"];

/** A hint read from a format script (never run): AFDate_FormatEx / AFDate_Format / AFNumber_Format. */
function formatHint(js: string): FieldWidget["format"] {
  const unescape = (s: string) => s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))).replace(/\\(.)/g, "$1");
  let m = /AFDate_FormatEx\s*\(\s*(["'])((?:\\.|(?!\1).)*)\1/.exec(js);
  if (m) return { kind: "date", pattern: unescape(m[2]) };
  m = /AFDate_Format\s*\(\s*(\d+)\s*\)/.exec(js);
  if (m && AF_DATE_FORMATS[+m[1]]) return { kind: "date", pattern: AF_DATE_FORMATS[+m[1]] };
  m = /AFNumber_Format\s*\(\s*(\d+)\s*,[^,]*,[^,]*,[^,]*,\s*(["'])((?:\\.|(?!\2).)*)\2/.exec(js);
  if (m) return { kind: "number", decimals: Math.min(+m[1], 10), currency: unescape(m[3]).trim() || null };
  m = /AFNumber_Format\s*\(\s*(\d+)/.exec(js);
  if (m) return { kind: "number", decimals: Math.min(+m[1], 10), currency: null };
  return null;
}

// ---------------------------------------------------------------------------------------------
// Appearance state names
//
// A state name (a button's /V and /AS, the keys of /AP /N) is a string of bytes. MuPDF.js reads
// names as UTF-8 and makes them from UTF-8 only, so a name in another encoding (older producers
// write "Sì" in Latin-1: /S#EC) would read as "S\ufffd" and be written back as other bytes,
// matching no appearance state: the box would be drawn empty everywhere. Here a name's text is
// its bytes as UTF-8 when they are UTF-8, else as Latin-1, and a state is written back with the
// bytes the widget's appearance states spell it with (Painter.stateName).

const UTF8 = new TextDecoder("utf-8", { fatal: true });
/** How MuPDF.js decodes names (a bad byte becomes U+FFFD). */
const LOSSY_UTF8 = new TextDecoder("utf-8");
/** Bytes a name spells with a #xx escape: white space, delimiters, "#", and all but printable ASCII. */
const NAME_ESCAPED = new Set([..."#/()<>[]{}%"].map((c) => c.charCodeAt(0)));

/** The bytes of a name token as MuPDF prints it ("/S#EC": every byte outside printable ASCII escaped). */
function printedNameBytes(token: string): number[] {
  const out: number[] = [];
  for (let i = 1; i < token.length; i++) {
    const hex = token[i] === "#" ? token.slice(i + 1, i + 3) : "";
    if (/^[0-9a-fA-F]{2}$/.test(hex)) {
      out.push(parseInt(hex, 16));
      i += 2;
    } else out.push(token.charCodeAt(i) & 0xff);
  }
  return out;
}

const isUtf8 = (bytes: number[]) => {
  try {
    UTF8.decode(new Uint8Array(bytes));
    return true;
  } catch {
    return false;
  }
};
/** A name's text from its bytes: UTF-8, else Latin-1 (one character per byte, so it maps back). */
const bytesText = (bytes: number[]) => (isUtf8(bytes) ? UTF8.decode(new Uint8Array(bytes)) : String.fromCharCode(...bytes));

/** A name object's text (bytesText); null for anything that is no name. */
function nameText(o: Obj | null): string | null {
  if (!o || !o.isName()) return null;
  const s = o.asName();
  return s.includes("\ufffd") ? bytesText(printedNameBytes(o.resolve().toString(true, true))) : s;
}

/**
 * A widget's normal appearance states (/AP /N as a dictionary of streams): each name's text, and
 * its bytes when they are not UTF-8. Null when a name cannot be read back (the field is then not
 * filled: it could not be shown).
 */
function stateKeys(o: Obj): { text: string; bytes: number[] | null }[] | null {
  const n = o.get("AP", "N");
  const out: { text: string; bytes: number[] | null }[] = [];
  if (!n.isDictionary() || n.isStream()) return out;
  let printed: string | null = null, unreadable = false;
  n.forEach((v, k) => {
    if (!v.isStream()) return;
    const key = String(k);
    if (!key.includes("\ufffd")) {
      out.push({ text: key, bytes: null });
      return;
    }
    // forEach gives the key as MuPDF.js decodes it: its bytes are read from the dictionary as
    // MuPDF prints it, the key in front of its value's reference (state streams are indirect).
    printed ??= n.toString(true, true);
    const bytes = v.isIndirect() ? keyBytes(printed, key, v.asIndirect()) : null;
    if (bytes) out.push({ text: bytesText(bytes), bytes: isUtf8(bytes) ? null : bytes });
    else unreadable = true;
  });
  return unreadable ? null : out;
}

/** The bytes of the key MuPDF.js decoded as `lossy`, whose value is object `num`, in a printed dictionary. */
function keyBytes(printed: string, lossy: string, num: number): number[] | null {
  for (const m of printed.matchAll(new RegExp(`(/[^\\s/<>\\[\\]()%{}]*)\\s+${num}\\s+\\d+\\s+R`, "g"))) {
    const bytes = printedNameBytes(m[1]);
    if (LOSSY_UTF8.decode(new Uint8Array(bytes)) === lossy) return bytes;
  }
  return null;
}

/** The names of a widget's normal appearance states, as texts; null when one cannot be read back. */
function stateNames(o: Obj): string[] | null {
  return stateKeys(o)?.map((k) => k.text) ?? null;
}

/**
 * A name object with these bytes, which are not UTF-8: MuPDF.js makes names from UTF-8 only, so
 * it is read from a tiny PDF made for it, then grafted into `doc` (names belong to no document).
 */
function rawName(mupdf: MuPDFModule, doc: Doc, bytes: number[]): Obj {
  const token = "/" + bytes.map((b) => (b > 0x20 && b < 0x7f && !NAME_ESCAPED.has(b) ? String.fromCharCode(b) : `#${b.toString(16).padStart(2, "0")}`)).join("");
  const objects = [`<</Type/Catalog/Pages 2 0 R/PEName ${token}>>`, "<</Type/Pages/Kids[]/Count 0>>"];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, "0")} 00000 n \n`).join("")}`;
  pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  const tiny = mupdf.Document.openDocument(new TextEncoder().encode(pdf), "application/pdf");
  try {
    const name = tiny.asPDF()?.getTrailer().get("Root", "PEName");
    if (!name || !name.isName()) throw new Error("A state name could not be made");
    return doc.graftObject(name);
  } finally {
    tiny.destroy();
  }
}

/**
 * The on state of a check box or radio widget: its appearance state other than Off. Without
 * states, a radio button of a group (the kids of a field) gets one of its own (radioStates),
 * never the group's value, which every button would get (all drawn on, none other choosable); a
 * check box or a lone radio button the field's value or its /AS when on (a check box shown on
 * several pages has one state on all of them), else "Yes" (what Acrobat uses). Null: no on state
 * the app could tell apart or show (the field is locked, "conflict").
 */
function onStateOf(o: Obj): string | null {
  const names = stateNames(o);
  if (!names) return null;
  const named = names.find((s) => s !== "Off");
  if (named) return named;
  if (names.length === 0 && fieldTypeOf(o) === "radio") {
    const group = radioStates(o);
    if (group) return group.get(keyOf(o)) ?? null;
  }
  for (const v of [inherited(o, "V"), o.get("AS")]) {
    const s = nameText(v);
    if (s && s !== "Off") return s;
  }
  return "Yes";
}

/**
 * On states for the radio buttons without appearance states in `o`'s group (the kids of its
 * field), by keyOf; null when `o` is a field on its own. A button takes its /AS when it is on
 * and no other button of the group has that state, else its place among the kids ("0", "1"...,
 * the names Acrobat gives with /Opt, whose entries go by the same place). Taken by another
 * button: null (no state of its own). Each button keeps its state once it has appearances
 * (makeStates), so the names stay the same while an edit draws the group button by button.
 */
function radioStates(o: Obj): Map<string, string | null> | null {
  const field = fieldDictOf(o);
  const kids = field.get("Kids");
  if (keyOf(field) === keyOf(o) || !kids.isArray()) return null;
  const taken = new Set<string>();
  const bare: { kid: Obj; place: number }[] = [];
  for (let i = 0; i < kids.length; i++) {
    const kid = kids.get(i);
    if (!kid.isDictionary()) continue;
    const names = stateNames(kid);
    if (names === null) continue;
    if (names.length) {
      for (const s of names) if (s !== "Off") taken.add(s);
    } else bare.push({ kid, place: i });
  }
  const out = new Map<string, string | null>();
  const rest: typeof bare = [];
  for (const b of bare) {
    const as = nameText(b.kid.get("AS"));
    if (as && as !== "Off" && !taken.has(as)) {
      out.set(keyOf(b.kid), as);
      taken.add(as);
    } else rest.push(b);
  }
  for (const b of rest) {
    const s = String(b.place);
    out.set(keyOf(b.kid), taken.has(s) ? null : s);
    taken.add(s);
  }
  return out;
}

/** Check boxes and radio buttons whose on state the app cannot tell apart are not filled. */
const noOnState = (o: Obj, type: FieldType) => (type === "checkbox" || type === "radio") && onStateOf(o) === null;

/** The state a button field holds: its /V name (a string, as some tools write it), "Off" when it has none. */
function stateOf(dict: Obj): string {
  const v = inherited(dict, "V");
  return nameText(v) ?? (v && v.isString() && v.asString() ? v.asString() : "Off");
}

/** The export values a choice field holds (/V: a string, or an array of them; "" counts as none). */
function choicesOf(dict: Obj): string[] {
  const v = inherited(dict, "V");
  if (!v) return [];
  if (v.isString()) return v.asString() === "" ? [] : [v.asString()];
  const out: string[] = [];
  if (v.isArray()) for (let i = 0; i < v.length; i++) if (v.get(i).isString()) out.push(v.get(i).asString());
  return out;
}

/** The text a field holds (/V as a text string, or the text of a stream). */
function textOf(dict: Obj): string {
  const v = inherited(dict, "V");
  if (!v) return "";
  if (v.isString()) return v.asString();
  if (v.isStream()) {
    const buf = v.readStream();
    try {
      return buf.asString();
    } finally {
      buf.destroy();
    }
  }
  return "";
}

/** A choice field's options from /Opt: label and export value. */
function choiceOptions(o: Obj): FieldOption[] {
  const opt = inherited(o, "Opt");
  const out: FieldOption[] = [];
  if (!opt || !opt.isArray()) return out;
  for (let i = 0; i < opt.length; i++) {
    const e = opt.get(i);
    if (e.isString()) out.push({ label: e.asString(), value: e.asString() });
    else if (e.isArray() && e.length >= 2) {
      const value = e.get(0).isString() ? e.get(0).asString() : "";
      out.push({ label: e.get(1).isString() ? e.get(1).asString() : value, value });
    }
  }
  return out;
}

/** A radio or check box field's /Opt: the label of each kid widget, with that kid's on state. */
function buttonOptions(o: Obj): FieldOption[] | undefined {
  const dict = fieldDictOf(o);
  const opt = inherited(o, "Opt"), kids = dict.get("Kids");
  if (!opt || !opt.isArray() || !kids.isArray()) return undefined;
  const out: FieldOption[] = [];
  for (let i = 0; i < Math.min(opt.length, kids.length); i++) {
    const e = opt.get(i);
    const label = e.isString() ? e.asString() : e.isArray() && e.length && e.get(0).isString() ? e.get(0).asString() : "";
    out.push({ label, value: onStateOf(kids.get(i)) ?? "" });
  }
  return out.length ? out : undefined;
}

/** sRGB of an annotation colour (gray, RGB or CMYK; empty is black). */
function srgbOf(color: number[]): [number, number, number] {
  if (color.length === 1) return [color[0], color[0], color[0]];
  if (color.length === 3) return [color[0], color[1], color[2]];
  if (color.length === 4) {
    const k = 1 - color[3];
    return [(1 - color[0]) * k, (1 - color[1]) * k, (1 - color[2]) * k];
  }
  return [0, 0, 0];
}

/** The fill-colour operator of an annotation colour. */
function colorOp(color: number[], stroke = false): string {
  const op = (s: string) => (stroke ? s.toUpperCase() : s);
  if (color.length === 1) return `${fmt(color[0])} ${op("g")}`;
  if (color.length === 3) return `${color.map(fmt).join(" ")} ${op("rg")}`;
  if (color.length === 4) return `${color.map(fmt).join(" ")} ${op("k")}`;
  return `0 ${op("g")}`;
}

/** An annotation colour array (MK /BG, /BC) as numbers, or null. */
function colorArray(o: Obj): number[] | null {
  if (!o.isArray() || ![1, 3, 4].includes(o.length)) return null;
  const out: number[] = [];
  for (let i = 0; i < o.length; i++) out.push(o.get(i).isNumber() ? o.get(i).asNumber() : 0);
  return out;
}

/** The widget's default appearance as MuPDF maps it (Helv, TiRo, Cour, ZaDb), or its fallback. */
function daOf(w: Widget): { font: string; size: number; color: number[] } {
  try {
    const da = w.getDefaultAppearance();
    return { font: da.font, size: Number.isFinite(da.size) && da.size > 0 ? da.size : 0, color: [...(da.color as number[])] };
  } catch {
    return { font: "Helv", size: 0, color: [] };
  }
}

/** The font family MuPDF draws a DA font with (it never uses the form's own /DR fonts). */
const familyOf = (daFont: string): FontFamily => (daFont === "TiRo" ? "serif" : daFont === "Cour" ? "mono" : "sans");

/** Quadding (/Q) along the widget's chain, as MuPDF reads it: 0 left, 1 centre, 2 right. */
function alignOf(o: Obj): 0 | 1 | 2 {
  const q = intOf(inherited(o, "Q"));
  return q === 1 ? 1 : q === 2 ? 2 : 0;
}

/** Border width as MuPDF reads it for a widget: /BS /W, else /Border [h v w], else 1. */
function borderWidthOf(o: Obj): number {
  const w = o.get("BS", "W");
  if (w.isNumber()) return Math.max(0, w.asNumber());
  const border = o.get("Border");
  if (border.isArray() && border.length >= 3 && border.get(2).isNumber()) return Math.max(0, border.get(2).asNumber());
  return 1;
}

/** /MK /R (the widget's own rotation, counter-clockwise), 0, 90, 180 or 270. */
function mkRotation(o: Obj): number {
  const r = intOf(o.get("MK", "R"));
  return ((Math.round(r / 90) * 90) % 360 + 360) % 360;
}

/**
 * The direction of the text in the widget's box on the page, clockwise in page space: /MK /R
 * turns the text counter-clockwise in user space, then the page transform (/Rotate) applies.
 */
function rotationOf(o: Obj, transform: number[]): 0 | 90 | 180 | 270 {
  const r = (mkRotation(o) * Math.PI) / 180;
  const ux = Math.round(Math.cos(r)), uy = Math.round(Math.sin(r));
  const dx = transform[0] * ux + transform[2] * uy, dy = transform[1] * ux + transform[3] * uy;
  const deg = ((Math.round((Math.atan2(dy, dx) * 180) / Math.PI / 90) * 90) % 360 + 360) % 360;
  return deg as 0 | 90 | 180 | 270;
}

// ---------------------------------------------------------------------------------------------
// The document's fields by name

interface NamedWidgets {
  /** The types found among the widgets with this name (more than one: a conflict). */
  types: Set<FieldType>;
  /** Pages with a widget of that name, ascending. */
  pages: number[];
  /** A check box or radio widget with that name has no on state the app can tell apart (noOnState). */
  noOnState: boolean;
  /** The /Ff of every widget with that name, OR-ed: what planFieldEdit checks (read-only, required...). */
  flags: number;
  /** A widget with that name is listed (isListed) and is no push button: the overlay shows something to fill or sign. */
  shown: boolean;
}

/** What one pass over every widget of a document finds (scanForm). */
interface FormScan {
  /** doc.countPages() when it was made: a page added or removed makes it stale. */
  pageCount: number;
  /** Every field widget by full name. */
  index: Map<string, NamedWidgets>;
  /** Listed widgets per page (FormInfo.fieldsPerPage). */
  perPage: number[];
  /** Pages with any widget annotation, ascending. */
  widgetPages: number[];
  /** Pages with a widget of a password field, ascending. */
  passwordPages: number[];
  /** Object numbers of the fields the form calculates (/AcroForm /CO). */
  co: Set<number>;
  /** A field has keystroke, format, validate or calculate scripts, or the form calculates fields. */
  scripts: boolean;
}

/** Each working document's scan, until formChanged (or a page count that differs) drops it. */
const scans = new WeakMap<Doc, FormScan>();

/**
 * The document's fields may have changed: the next listing or edit reads them all again. The
 * session calls it after every edit it applies, undo, redo, rebuild and recover (a document
 * re-opened from a snapshot is a new object, which has no scan anyway); applyFieldEdit and
 * drawFieldsWithWriter call it themselves. Loading or rendering a page changes nothing the scan
 * holds (MuPDF.js writes no appearance into the document then), nor does hidePasswords.
 */
export function formChanged(doc: Doc): void {
  scans.delete(doc);
}

/**
 * Every widget of the document by full name, the listed widgets per page and the rest of
 * FormScan, read from the page objects in one pass (no page is loaded), once per working
 * document state (formChanged).
 */
function scanForm(doc: Doc): FormScan {
  const pageCount = doc.countPages();
  const kept = scans.get(doc);
  if (kept && kept.pageCount === pageCount) return kept;
  const co = calculated(doc);
  const scan: FormScan = { pageCount, index: new Map(), perPage: [], widgetPages: [], passwordPages: [], co, scripts: co.size > 0 };
  for (let p = 0; p < pageCount; p++) {
    const annots = widgetAnnots(doc, p);
    let listed = 0, password = false;
    for (const o of annots) {
      const type = fieldTypeOf(o);
      if (!type) continue;
      const name = fullName(o);
      const ff = intOf(inherited(o, "Ff"));
      let entry = scan.index.get(name);
      if (!entry) scan.index.set(name, (entry = { types: new Set(), pages: [], noOnState: false, flags: 0, shown: false }));
      entry.types.add(type);
      entry.flags |= ff;
      if (entry.pages[entry.pages.length - 1] !== p) entry.pages.push(p);
      if (!entry.noOnState && noOnState(o, type)) entry.noOnState = true;
      if (type === "text" && ff & FF_PASSWORD) password = true;
      if (!scan.scripts && (fieldScripts(o).any || chainOf(o).some((n) => n.isIndirect() && co.has(n.asIndirect())))) scan.scripts = true;
      if (!isListed(o)) continue;
      listed++;
      if (type !== "button") entry.shown = true;
    }
    scan.perPage.push(listed);
    if (annots.length) scan.widgetPages.push(p);
    if (password) scan.passwordPages.push(p);
  }
  scans.set(doc, scan);
  return scan;
}

/** Every widget of the document by full name (scanForm). */
const fieldIndex = (doc: Doc) => scanForm(doc).index;

/** Whether a field of this name is locked as "conflict" (lockOf). */
const conflicting = (entry: NamedWidgets | undefined) => !!entry && (entry.types.size > 1 || entry.noOnState);

/**
 * Why the app does not fill this widget's field, or null. `conflict`: same-named fields of
 * different types, or check boxes and radio buttons whose states cannot be told apart or read
 * back (noOnState): every widget of the name, which the field could not show.
 */
function lockOf(type: FieldType, ff: number, name: string, conflict: boolean): FieldLock | null {
  if (type === "button") return "push-button";
  if (type === "signature") return "signature";
  if (name === "") return "no-name";
  if (conflict) return "conflict";
  if (ff & FF_READ_ONLY) return "read-only";
  if (type === "text" && ff & FF_PASSWORD) return "password";
  if (type === "text" && ff & FF_FILE_SELECT) return "file-select";
  return null;
}

/**
 * The form of `doc` (DocInfo.form), or null when it has none: no AcroForm, or no listed widget
 * other than push buttons and no XFA. `fields` and `required` count what the user can fill in:
 * distinct full names with a listed widget that are not locked (no push buttons, signature
 * fields, read-only, password or file-select fields...). Read from the objects only, without
 * loading pages, in the one pass of scanForm (describe() runs it on open; the scan it makes is
 * the one the first page listings use).
 */
export function formInfo(_mupdf: MuPDFModule, doc: Doc): FormInfo | null {
  const acro = doc.getTrailer().get("Root", "AcroForm");
  if (!acro.isDictionary()) return null;
  const xfa = formXfa(doc);
  const scan = scanForm(doc);
  let shown = false, fields = 0, required = 0;
  for (const [name, entry] of scan.index) {
    if (!entry.shown) continue;
    shown = true;
    // Locked as planFieldEdit decides it: with the flags of all the widgets of the name.
    if (lockOf([...entry.types][0], entry.flags, name, conflicting(entry)) !== null) continue;
    fields++;
    if (entry.flags & FF_REQUIRED) required++;
  }
  // Nothing to fill or sign (no widgets, or push buttons only), and no XFA to tell about.
  if (!shown && xfa === "none") return null;
  return { fieldsPerPage: [...scan.perPage], fields, required, xfa, scripts: scan.scripts };
}

/** The form's XFA part: none, static (AcroForm fields beside it) or dynamic (the pages are a placeholder). */
function formXfa(doc: Doc): FormInfo["xfa"] {
  const root = doc.getTrailer().get("Root");
  const acro = root.get("AcroForm");
  if (!acro.isDictionary() || acro.get("XFA").isNull()) return "none";
  const fields = acro.get("Fields");
  const needsRendering = root.get("NeedsRendering");
  if ((needsRendering.isBoolean() && needsRendering.asBoolean()) || !fields.isArray() || fields.length === 0) return "dynamic";
  return "static";
}

// ---------------------------------------------------------------------------------------------
// Listing a page's fields

/**
 * The page's form field widgets for the overlay, in the page's tab order (/Tabs R: rows, C:
 * columns, otherwise /Annots order). Hidden, NoView and zero-area widgets, and annotations that
 * are no field, are left out. A widget's lock and `required` are its field's (all the widgets
 * with its name), as planFieldEdit and formInfo see them. Costs this page's widgets only: the
 * whole form is read once per document state (scanForm).
 */
export function pageFields(_mupdf: MuPDFModule, doc: Doc, pageIndex: number): FieldWidget[] {
  if (!widgetAnnots(doc, pageIndex).length) return [];
  const { index, co } = scanForm(doc);
  const tabs = nameOf(doc.findPage(pageIndex).get("Tabs"));
  const listed = withWidgets(doc, pageIndex, (page, widgets) => {
    const transform = page.getTransform();
    const out: Omit<FieldWidget, "index">[] = [];
    for (const w of widgets) {
      const o = w.getObject();
      const type = fieldTypeOf(o);
      if (!type || !isListed(o)) continue;
      out.push(describeWidget(w, o, type, index, co, transform));
    }
    return out;
  });
  return tabOrder(listed, tabs).map((f, index) => ({ ...f, index }));
}

function describeWidget(
  w: Widget, o: Obj, type: FieldType, index: Map<string, NamedWidgets>, co: Set<number>, transform: number[],
): Omit<FieldWidget, "index"> {
  const name = fullName(o);
  const ff = intOf(inherited(o, "Ff"));
  const entry = index.get(name);
  // The field's flags (every widget with the name): its lock, whether it is required or a password.
  const fieldFlags = entry ? entry.flags | ff : ff;
  const dict = fieldDictOf(o);
  const da = daOf(w);
  const scripts = fieldScripts(o);
  const maxLen = type === "text" ? Math.max(0, w.getMaxLen()) : 0;
  const multiline = type === "text" && (ff & FF_MULTILINE) !== 0;
  const f: Omit<FieldWidget, "index"> = {
    name,
    type,
    rect: [...w.getRect()] as Rect,
    rotation: rotationOf(o, transform),
    label: w.getLabel(),
    value: "",
    multiline,
    comb: type === "text" && (ff & FF_COMB) !== 0 && maxLen > 0 && !(ff & (FF_MULTILINE | FF_PASSWORD | FF_FILE_SELECT)),
    maxLen,
    multiSelect: type === "list" && (ff & FF_MULTI_SELECT) !== 0,
    editable: type === "combo" && (ff & FF_EDIT) !== 0,
    required: (fieldFlags & FF_REQUIRED) !== 0,
    scripted: scripts.any || chainOf(o).some((n) => n.isIndirect() && co.has(n.asIndirect())),
    format: scripts.format ? formatHint(scripts.format) : null,
    fontSize: da.size,
    color: srgbOf(da.color),
    align: alignOf(o),
    locked: lockOf(type, fieldFlags, name, conflicting(entry)),
  };
  switch (type) {
    case "text":
      // A password is never shown (MuPDF would even draw it in clear).
      f.value = fieldFlags & FF_PASSWORD ? "" : textOf(dict);
      break;
    case "combo": {
      const options = choiceOptions(o);
      const value = choicesOf(dict)[0] ?? "";
      f.options = options;
      f.value = value;
      f.displayValue = options.find((x) => x.value === value)?.label ?? value;
      break;
    }
    case "list": {
      f.options = choiceOptions(o);
      f.values = choicesOf(dict);
      f.value = f.values[0] ?? "";
      break;
    }
    case "checkbox":
    case "radio": {
      f.value = stateOf(dict);
      const on = onStateOf(o);
      if (on !== null) f.onState = on; // none: locked ("conflict")
      const options = buttonOptions(o);
      if (options) f.options = options;
      break;
    }
    case "signature":
      f.signed = (inherited(o, "V")?.isDictionary() ?? false);
      break;
    case "button":
      break;
  }
  return f;
}

/**
 * The widgets in the page's tab order: rows top to bottom, each left to right (/Tabs /R), columns
 * left to right, each top to bottom (/C), else as listed (/Annots order; /S, structure order, is
 * close to it). A widget joins a row when its vertical centre lies within the row's first one.
 */
function tabOrder<T extends { rect: Rect }>(widgets: T[], tabs: string | null): T[] {
  if (tabs !== "R" && tabs !== "C") return widgets;
  const across = tabs === "R" ? 0 : 1, down = 1 - across; // R: rows along x; C: columns along y
  const sorted = widgets.map((w, i) => ({ w, i })).sort((a, b) => center(a.w.rect, down) - center(b.w.rect, down) || a.i - b.i);
  const out: T[] = [];
  let rowEnd = -Infinity; // the far edge of the row's first widget
  let row: { w: T; i: number }[] = [];
  const flush = () => {
    row.sort((a, b) => a.w.rect[across] - b.w.rect[across] || a.i - b.i);
    out.push(...row.map((x) => x.w));
    row = [];
  };
  for (const x of sorted) {
    if (center(x.w.rect, down) > rowEnd) {
      flush();
      rowEnd = x.w.rect[down + 2];
    }
    row.push(x);
  }
  flush();
  return out;
}

const center = (r: Rect, axis: number) => (r[axis] + r[axis + 2]) / 2;

// ---------------------------------------------------------------------------------------------
// Planning a field edit (validation)

/** Every widget with `name`, read from MuPDF on the pages the index names. */
interface Found {
  type: FieldType;
  pages: number[];
  /** Flags of each widget, OR-ed. */
  flags: number;
  maxLen: number;
  options: FieldOption[];
  onStates: Set<string>;
  /** A check box or radio widget without an on state the app can tell apart (noOnState). */
  noOnState: boolean;
  /** Each field dictionary with the name, once: its current value. */
  dicts: { text: string; choices: string[]; state: string }[];
  /** Each widget's /AS against the state it should show for a given field state. */
  widgets: { as: string | null; states: string[] }[];
}

function findField(doc: Doc, name: string): Found | null {
  const entry = fieldIndex(doc).get(name);
  if (!entry) return null;
  if (entry.types.size > 1) throw new FieldError(`Fields named "${name}" have different types`, "not-editable");
  const type = [...entry.types][0];
  const found: Found = { type, pages: entry.pages, flags: 0, maxLen: 0, options: [], onStates: new Set(), noOnState: false, dicts: [], widgets: [] };
  const seen = new Set<string>();
  for (const p of entry.pages) {
    withWidgets(doc, p, (_page, widgets) => {
      for (const w of widgets) {
        const o = w.getObject();
        if (fieldTypeOf(o) !== type || fullName(o) !== name) continue;
        found.flags |= intOf(inherited(o, "Ff"));
        if (type === "text") {
          const m = w.getMaxLen();
          if (m > 0) found.maxLen = found.maxLen ? Math.min(found.maxLen, m) : m;
        }
        if ((type === "combo" || type === "list") && !found.options.length) found.options = choiceOptions(o);
        if (type === "checkbox" || type === "radio") {
          const on = onStateOf(o);
          if (on === null) found.noOnState = true;
          else found.onStates.add(on);
          found.widgets.push({ as: nameText(o.get("AS")), states: stateNames(o) ?? [] });
        }
        const dict = fieldDictOf(o);
        if (seen.has(keyOf(dict))) continue;
        seen.add(keyOf(dict));
        found.dicts.push({ text: textOf(dict), choices: choicesOf(dict), state: stateOf(dict) });
      }
    });
  }
  return found;
}

/**
 * The pages an edit of a field on `pages` changes: those, the pages with a password widget the
 * edit gives its frame (hidePasswords), and, when it gives a form with /NeedAppearances its
 * appearances (settleNeedAppearances), every page with a widget.
 */
function editedPages(doc: Doc, pages: number[]): number[] {
  const out = new Set([...pages, ...passwordPages(doc)]);
  const flag = doc.getTrailer().get("Root", "AcroForm", "NeedAppearances");
  if (flag.isBoolean() && flag.asBoolean()) for (const p of scanForm(doc).widgetPages) out.add(p);
  return [...out].sort((a, b) => a - b);
}

/**
 * Text from the main thread made ready for a field: checked as untrusted ("bad-request"), then
 * normalised (normalText) before MaxLen counts its characters (the drawing's WinAnsi test is
 * made on drawnText).
 */
function cleanText(text: unknown, multiline: boolean): string {
  if (typeof text !== "string") throw new FieldError("A field's text must be a string", "bad-request");
  if (text.includes("\u0000")) throw new FieldError("A field's text cannot hold U+0000", "bad-request");
  if (/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text))
    throw new FieldError("A field's text must be valid Unicode", "bad-request");
  const out = normalText(text, multiline);
  if ([...out].length > MAX_FIELD_CHARS) throw new FieldError(`A field's text is at most ${MAX_FIELD_CHARS} characters`, "bad-request");
  return out;
}

/**
 * Checks a value for field `name` and makes the edit to log, or null when it changes nothing (the
 * field, every dictionary with that name, holds it already). Refused with FieldError: an unknown
 * name or a value the field cannot take ("bad-request": a choice it does not offer, text longer
 * than MaxLen...), a locked field ("not-editable": read-only, password, file select, push
 * button, signature, no name, same-named fields of different types).
 */
export function planFieldEdit(_mupdf: MuPDFModule, doc: Doc, name: unknown, value: unknown): FieldEdit | null {
  if (typeof name !== "string") throw new FieldError("No field name given", "bad-request");
  const found = findField(doc, name);
  if (!found) throw new FieldError(`There is no field "${name}"`, "bad-request");
  const lock = lockOf(found.type, found.flags, name, false);
  if (lock) throw new FieldError(`The field "${name}" cannot be filled in (${lock})`, "not-editable");
  if (!value || typeof value !== "object") throw new FieldError("No field value given", "bad-request");
  const v = value as { kind?: unknown; text?: unknown; state?: unknown; values?: unknown };
  const edit = (normalised: FieldValue): FieldEdit => ({
    kind: "field", name, type: found.type, value: normalised, pageIndex: found.pages[0], pages: editedPages(doc, found.pages),
  });

  switch (found.type) {
    case "text": {
      if (v.kind !== "text") throw new FieldError("A text field takes text", "bad-request");
      const text = cleanText(v.text, (found.flags & FF_MULTILINE) !== 0);
      if (found.maxLen > 0 && [...text].length > found.maxLen)
        throw new FieldError(`The field "${name}" takes at most ${found.maxLen} characters`, "bad-request");
      return found.dicts.every((d) => d.text === text) ? null : edit({ kind: "text", text });
    }
    case "combo":
    case "list": {
      let values: string[];
      if (v.kind === "text") {
        // The custom text of an editable combo box (an option's export value is that option).
        if (found.type !== "combo" || !(found.flags & FF_EDIT)) throw new FieldError(`The field "${name}" takes one of its options`, "bad-request");
        const text = cleanText(v.text, false);
        values = text === "" ? [] : [text];
      } else if (v.kind === "choice") {
        if (!Array.isArray(v.values) || !v.values.every((x) => typeof x === "string"))
          throw new FieldError("A choice is a list of export values", "bad-request");
        const asked = v.values as string[];
        if (new Set(asked).size !== asked.length) throw new FieldError("A choice names each value once", "bad-request");
        const multi = found.type === "list" && (found.flags & FF_MULTI_SELECT) !== 0;
        if (asked.length > 1 && !multi) throw new FieldError(`The field "${name}" takes one choice`, "bad-request");
        const offered = found.options.map((o) => o.value);
        for (const x of asked) if (!offered.includes(x)) throw new FieldError(`The field "${name}" does not offer "${x}"`, "bad-request");
        // In the order of the options, as /I lists them.
        values = offered.filter((x, i) => asked.includes(x) && offered.indexOf(x) === i);
      } else throw new FieldError("A choice field takes a choice", "bad-request");
      const same = (a: string[]) => a.length === values.length && a.every((x, i) => x === values[i]);
      if (found.dicts.every((d) => same(d.choices))) return null;
      if (v.kind === "text" && values.length && !found.options.some((o) => o.value === values[0])) return edit({ kind: "text", text: values[0] });
      return edit({ kind: "choice", values });
    }
    case "checkbox":
    case "radio": {
      if (found.noOnState) throw new FieldError(`The field "${name}" cannot be filled in (its states cannot be told apart)`, "not-editable");
      if (v.kind !== "state" || typeof v.state !== "string") throw new FieldError("A check box or radio button takes a state", "bad-request");
      const state = v.state;
      if (state !== "Off" && !found.onStates.has(state)) throw new FieldError(`The field "${name}" has no state "${state}"`, "bad-request");
      const shown = (w: { as: string | null; states: string[] }) => (w.as ?? "Off") === (w.states.includes(state) ? state : "Off");
      // Also when the value is right but a widget shows the wrong state (the toggle bug of other tools).
      if (found.dicts.every((d) => d.state === state) && found.widgets.every(shown)) return null;
      return edit({ kind: "state", state });
    }
    default:
      throw new FieldError(`The field "${name}" cannot be filled in`, "not-editable");
  }
}

// ---------------------------------------------------------------------------------------------
// Applying a field edit

/**
 * Fills the field as the edit says (shared by the first application and every replay). Throws
 * when the document no longer fits the log (no field of that name, or of another type) or MuPDF's
 * appearance is not what the writer expects: the session rolls back ("edit-failed").
 */
export function applyFieldEdit(mupdf: MuPDFModule, doc: Doc, edit: FieldEdit): FieldEditOutcome {
  const entry = fieldIndex(doc).get(edit.name);
  if (!entry) throw new Error(`There is no field "${edit.name}"`);
  if (entry.types.size !== 1 || !entry.types.has(edit.type)) throw new Error(`The field "${edit.name}" is no longer a ${edit.type}`);
  const painter = new Painter(mupdf, doc);
  try {
    dropStaticXfa(doc);
    hidePasswords(mupdf, doc);
    settleNeedAppearances(painter);
    // What the settle could not draw in other fields is not this edit's outcome.
    painter.missing.clear();
    painter.overflow = false;
    painter.paint(new Map([[edit.name, { type: edit.type, value: edit.value }]]), entry.pages);
    return { missingChars: [...painter.missing], overflow: painter.overflow };
  } finally {
    painter.destroy();
    // Appearance states made for buttons, values: read again from the document as it is now.
    formChanged(doc);
  }
}

/** A widget of a password text field. */
export function isPasswordField(o: Obj): boolean {
  return fieldTypeOf(o) === "text" && (intOf(inherited(o, "Ff")) & FF_PASSWORD) !== 0;
}

/** A password widget MuPDF would draw the value of: without a normal appearance, and of some size. */
function showsPassword(o: Obj): boolean {
  if (!isPasswordField(o) || !o.get("AP", "N").isNull()) return false;
  const r = rectOf(o);
  return r[2] > r[0] || r[3] > r[1];
}

/** The pages with a password widget hidePasswords would change (looked for on the pages with a password field only). */
function passwordPages(doc: Doc): number[] {
  return scanForm(doc).passwordPages.filter((p) => widgetAnnots(doc, p).some(showsPassword));
}

/**
 * A password is never drawn (ISO 32000 even asks that it never be stored, but some tools do):
 * every password widget without a normal appearance gets one with its frame only (the /MK
 * background and border), since MuPDF draws the value of a widget without an appearance in
 * clear, on screen and into any appearance it makes from it. Appearances a widget has are kept.
 * Idempotent; every field edit runs it (so a filled form's saves never rely on a viewer masking
 * the value), and pdfa.ts. Returns the pages changed.
 */
export function hidePasswords(mupdf: MuPDFModule, doc: Doc): number[] {
  const pages = passwordPages(doc);
  for (const p of pages)
    for (const o of widgetAnnots(doc, p)) {
      if (!showsPassword(o)) continue;
      const [x0, y0, x1, y1] = rectOf(o);
      const frame = frameOps(o, x1 - x0, y1 - y0);
      const n = formXObject(mupdf, doc, frame ? `q\n${frame}Q\n` : "", x1 - x0, y1 - y0);
      const ap = o.get("AP");
      if (ap.isDictionary()) ap.put("N", n);
      else o.put("AP", { N: n });
    }
  return pages;
}

/**
 * A widget's /MK background and border as content in a box of its size (what MuPDF draws
 * around an empty value): the same whatever /MK /R turns the text by.
 */
function frameOps(o: Obj, width: number, height: number): string {
  const mk = o.get("MK");
  const bg = mk.isDictionary() ? colorArray(mk.get("BG")) : null;
  const bc = mk.isDictionary() ? colorArray(mk.get("BC")) : null;
  const bw = borderWidthOf(o);
  let frame = "";
  if (bg) frame += `${colorOp(bg)}\n0 0 ${fmt(width)} ${fmt(height)} re\nf\n`;
  if (bc && bw > 0) frame += `${fmt(bw)} w\n${colorOp(bc, true)}\n${fmt(bw / 2)} ${fmt(bw / 2)} ${fmt(width - bw)} ${fmt(height - bw)} re\ns\n`;
  return frame;
}

/** A new form XObject of this size with `content` (an appearance stream). */
const formXObject = (mupdf: MuPDFModule, doc: Doc, content: string, width: number, height: number) =>
  addContent(mupdf, doc, content, { Type: "XObject", Subtype: "Form", BBox: [0, 0, width, height], Resources: {} });

/** A static XFA part would keep the old data beside the new values: it goes (idempotent). */
function dropStaticXfa(doc: Doc) {
  if (formXfa(doc) === "static") doc.getTrailer().get("Root", "AcroForm").delete("XFA");
}

/**
 * A form with /NeedAppearances: every field gets a real appearance from its value (the writer
 * where MuPDF draws wrongly), check boxes and radio buttons without appearance states a pair,
 * and the flag goes. Password and file-select fields keep theirs (a password is never drawn:
 * hidePasswords gave one without an appearance its frame).
 */
function settleNeedAppearances(painter: Painter) {
  const acro = painter.doc.getTrailer().get("Root", "AcroForm");
  const flag = acro.get("NeedAppearances");
  if (!(flag.isBoolean() && flag.asBoolean())) return;
  painter.paintCurrent(() => true);
  acro.delete("NeedAppearances");
}

/**
 * For pdfa.ts: draws as a field edit does, every widget of such a field, what MuPDF would draw
 * wrongly from the values fields hold: text, combo and list fields with a value outside WinAnsi;
 * a list box with a selection (MuPDF draws no highlight); a combo box holding an option's export
 * value (MuPDF would draw the export value, not the option's label); check boxes and radio
 * buttons without appearance states (MuPDF gives every button of a group the same on state).
 * `all`: every field of the document (a form with /NeedAppearances, whose appearances may be
 * stale); otherwise only fields with a widget that has no appearance. Returns the object numbers
 * of the widgets drawn, which the conversion then leaves as they are.
 */
export function drawFieldsWithWriter(mupdf: MuPDFModule, doc: Doc, all: boolean): Set<number> {
  // The conversion changes the copy's objects on its own: its fields are read as they are now.
  formChanged(doc);
  const painter = new Painter(mupdf, doc);
  try {
    // Fields with a widget lacking an appearance, by name.
    let missing: Set<string> | null = null;
    if (!all) {
      missing = new Set();
      for (let p = 0; p < doc.countPages(); p++)
        for (const o of widgetAnnots(doc, p)) if (o.get("AP", "N").isNull()) missing.add(fullName(o));
    }
    painter.writerOnly = true;
    painter.paintCurrent((name) => missing === null || missing.has(name));
    return painter.drawn;
  } finally {
    painter.destroy();
    formChanged(doc);
  }
}

interface Target {
  type: FieldType;
  value: FieldValue;
}

/** A glyph to draw: its character, font (the Type0 dict), code (4 hex digits), advance at size 1. */
interface Cell {
  ch: string;
  font: Obj;
  hex: string;
  width: number;
}

/** A line laid out in the appearance's box: its cells, start and baseline. */
interface Placed {
  cells: Cell[];
  x: number;
  y: number;
}

/** What the layout needs of a widget's appearance box. */
interface Box {
  W: number;
  H: number;
  bw: number;
  q: 0 | 1 | 2;
  /** DA size, 0 = automatic. */
  size: number;
}

/**
 * Draws field values into widget appearances, page by page (each page loaded once), and keeps
 * what one edit or one pass needs: the measuring fonts, the widths of the fallback fonts, which
 * field dictionaries were set already, what could not be drawn.
 */
class Painter {
  readonly missing = new Set<string>();
  overflow = false;
  /** Object numbers of the widgets drawn (drawFieldsWithWriter). */
  readonly drawn = new Set<number>();
  /**
   * Only fields the writer must draw (pdfa.ts): the others are left to MuPDF, and a field the
   * writer fails on is drawn by MuPDF instead of failing the conversion.
   */
  writerOnly = false;
  /** An edit (not a redraw of the values fields hold): a rich-text value (/RV) goes. */
  private editing = false;
  private readonly measureFonts = new Map<string, MuPDF.Font>();
  private readonly widths = new Map<number, { map: Map<number, number>; dw: number }>();
  /** Field dictionaries whose value MuPDF's setter wrote in this pass (one setter call each). */
  private readonly set = new Set<string>();
  /** Field dictionaries to give their final value once every widget is drawn. */
  private readonly finals = new Map<string, { dict: Obj; target: Target }>();
  /** States whose names are not UTF-8, as the widgets drawn in this pass spell them: what /V gets. */
  private readonly stateObjects = new Map<string, Obj>();
  /** Names made from bytes that are not UTF-8 (rawName), by their bytes. */
  private readonly rawNames = new Map<string, Obj>();

  constructor(readonly mupdf: MuPDFModule, readonly doc: Doc) {}

  destroy() {
    for (const f of this.measureFonts.values()) f.destroy();
    this.measureFonts.clear();
  }

  /** Every widget of the named fields gets the value given (one edit). */
  paint(targets: Map<string, Target>, pages: number[]) {
    this.editing = true;
    for (const p of pages) this.paintPage(p, (o) => targets.get(fullName(o)) ?? null);
    this.finish();
    this.editing = false;
  }

  /** The text, combo and list fields `wanted` names (and buttons without states) drawn from the values they hold. */
  paintCurrent(wanted: (name: string) => boolean) {
    const current = new Map<string, Target | null>();
    const { index, widgetPages } = scanForm(this.doc);
    for (const p of widgetPages) {
      this.paintPage(p, (o) => {
        const name = fullName(o);
        // Buttons whose states cannot be told apart are left as they are (locked).
        if (!wanted(name) || index.get(name)?.noOnState) return null;
        const dict = fieldDictOf(o);
        const key = keyOf(dict);
        if (!current.has(key)) current.set(key, this.currentTarget(o, dict));
        return current.get(key)!;
      });
    }
    this.finish();
  }

  /** What a field holds, as a target to draw it again; null for what is left alone. */
  private currentTarget(o: Obj, dict: Obj): Target | null {
    const type = fieldTypeOf(o);
    const ff = intOf(inherited(o, "Ff"));
    switch (type) {
      case "text":
        if (ff & (FF_PASSWORD | FF_FILE_SELECT)) return null;
        return { type, value: { kind: "text", text: textOf(dict) } };
      case "combo": {
        const values = choicesOf(dict);
        const custom = values.length === 1 && !choiceOptions(o).some((x) => x.value === values[0]);
        return { type, value: custom ? { kind: "text", text: values[0] } : { kind: "choice", values } };
      }
      case "list":
        return { type, value: { kind: "choice", values: choicesOf(dict) } };
      case "checkbox":
      case "radio": {
        // Only those without appearance states need anything.
        const names = stateNames(o);
        if (names === null || names.length) return null;
        return { type, value: { kind: "state", state: stateOf(dict) } };
      }
      default:
        return null;
    }
  }

  private paintPage(pageIndex: number, targetOf: (o: Obj) => Target | null) {
    withWidgets(this.doc, pageIndex, (page, widgets) => {
      let changed = false;
      for (const w of widgets) {
        const o = w.getObject();
        const type = fieldTypeOf(o);
        if (!type) continue;
        const target = targetOf(o);
        if (!target || target.type !== type) continue;
        let painted: boolean;
        try {
          painted = this.paintWidget(w, o, target);
        } catch (err) {
          if (!this.writerOnly) throw err;
          painted = this.drawWithMupdf(w, o, target);
        }
        if (painted) changed = true;
      }
      if (changed) page.update();
    });
  }

  /** Draws one widget; returns whether it changed anything. */
  private paintWidget(w: Widget, o: Obj, target: Target): boolean {
    const dict = fieldDictOf(o);
    const key = keyOf(dict);
    const value = target.value;
    if (target.type === "checkbox" || target.type === "radio") {
      if (value.kind !== "state") return false;
      this.finals.set(key, { dict, target });
      const changed = this.setState(w, o, value.state);
      if (changed && this.writerOnly && o.isIndirect()) this.drawn.add(o.asIndirect());
      return changed;
    }
    const da = daOf(w);
    const family = familyOf(da.font);
    const multiline = target.type === "text" && (intOf(inherited(o, "Ff")) & FF_MULTILINE) !== 0;
    if (target.type === "list") {
      const options = choiceOptions(o);
      const values = value.kind === "choice" ? value.values : [];
      if (this.writerOnly && !values.length && options.every((x) => isWinAnsi(x.label))) return false;
      this.finals.set(key, { dict, target });
      this.frame(w, key, true);
      this.writeList(w, o, da, options, values);
      return true;
    }
    // Text, or a combo box's label (the custom text of an editable one), drawn as drawnText
    // makes it (a value another tool wrote may hold CR line breaks or decomposed accents, any
    // value joiners and direction marks; /V keeps it as it is: finish() writes the target's text).
    const options = target.type === "combo" ? choiceOptions(o) : [];
    const exported = target.type === "combo" && value.kind === "choice" && value.values.length > 0;
    const label = exported ? options.find((x) => x.value === value.values[0])?.label ?? value.values[0] : "";
    const text = drawnText(value.kind === "text" ? value.text : label, multiline);
    const writer = !isWinAnsi(text);
    // pdfa.ts leaves the rest to MuPDF, which draws /V: for a combo box, the export value.
    if (this.writerOnly && !writer && !(exported && label !== value.values[0])) return false;
    this.finals.set(key, { dict, target });
    if (!writer) {
      // MuPDF's drawing; the value written twice so that MuPDF always sees a change and redraws.
      if (!this.set.has(key)) {
        this.set.add(key);
        if (this.editing) dict.delete("RV"); // rich text: readers would draw from it, not from /V
        setValue(w, target.type === "combo", text);
      }
      w.update();
      if (this.writerOnly && o.isIndirect()) this.drawn.add(o.asIndirect());
      this.measureOverflow(w, o, da, family, text, multiline);
      return true;
    }
    this.frame(w, key, target.type === "combo");
    this.writeText(w, o, da, family, text, multiline);
    return true;
  }

  /** pdfa.ts's fallback when the writer fails on a widget: MuPDF draws the value as it can. */
  private drawWithMupdf(w: Widget, o: Obj, target: Target): boolean {
    const v = target.value;
    const dict = fieldDictOf(o);
    this.finals.set(keyOf(dict), { dict, target });
    const options = choiceOptions(o);
    const multiline = target.type === "text" && (intOf(inherited(o, "Ff")) & FF_MULTILINE) !== 0;
    const text = drawnText(v.kind === "text" ? v.text
      : v.kind === "choice" && v.values.length ? options.find((x) => x.value === v.values[0])?.label ?? v.values[0] : "", multiline);
    try {
      setValue(w, target.type === "combo" || target.type === "list", text);
      w.update();
    } catch {
      // left as MuPDF leaves it; the value is written back by finish()
    }
    if (o.isIndirect()) this.drawn.delete(o.asIndirect());
    return true;
  }

  /** MuPDF draws the widget for an empty value: the frame the writer writes into. */
  private frame(w: Widget, key: string, choice: boolean) {
    if (!this.set.has(key)) {
      this.set.add(key);
      if (this.editing) fieldDictOf(w.getObject()).delete("RV");
      setValue(w, choice, "");
    }
    w.update();
  }

  /** Every field dictionary drawn gets its final value: MuPDF's setters wrote what they drew. */
  private finish() {
    for (const { dict, target } of this.finals.values()) {
      const v = target.value;
      if (v.kind === "state") {
        dict.put("V", this.stateObjects.get(v.state) ?? this.doc.newName(v.state));
        continue;
      }
      if (target.type === "text" || (target.type === "combo" && v.kind === "text")) {
        dict.put("V", this.doc.newString(v.kind === "text" ? v.text : ""));
        dict.delete("I");
        continue;
      }
      const values = v.kind === "choice" ? v.values : [];
      if (!values.length) dict.delete("V");
      else if (values.length === 1) dict.put("V", this.doc.newString(values[0]));
      else {
        const arr = this.doc.newArray();
        for (const x of values) arr.push(this.doc.newString(x));
        dict.put("V", arr);
      }
      const offered = choiceOptions(dict).map((o) => o.value);
      const indices = values.map((x) => offered.indexOf(x)).filter((i) => i >= 0).sort((a, b) => a - b);
      if (target.type === "list" && indices.length) {
        const arr = this.doc.newArray();
        for (const i of indices) arr.push(i);
        dict.put("I", arr);
      } else dict.delete("I");
    }
    this.finals.clear();
    this.set.clear();
    this.stateObjects.clear();
  }

  // ------------------------------------------------------------------- check boxes and radios

  /** The widget shows `state` when it has it, else Off; one without states gets a pair first. */
  private setState(w: Widget, o: Obj, state: string): boolean {
    let names = stateNames(o);
    if (names === null) return false; // locked: never filled
    const made = !names.length;
    if (made) {
      if (!this.makeStates(w, o)) return false;
      names = stateNames(o) ?? [];
    }
    const shown = names.includes(state) ? state : "Off";
    if (!made && nameText(o.get("AS")) === shown) return false;
    o.put("AS", this.stateName(o, shown));
    return true;
  }

  /**
   * The name to write for state `text` on widget `o`: with the bytes its appearance states spell
   * it with when they are not UTF-8 (kept for /V too), else the text as UTF-8.
   */
  private stateName(o: Obj, text: string): Obj {
    const bytes = text === "Off" ? null : stateKeys(o)?.find((k) => k.text === text)?.bytes ?? null;
    if (!bytes) return this.doc.newName(text);
    const id = bytes.join(",");
    let name = this.rawNames.get(id);
    if (!name) this.rawNames.set(id, (name = rawName(this.mupdf, this.doc, bytes)));
    if (!this.stateObjects.has(text)) this.stateObjects.set(text, name);
    return name;
  }

  /**
   * A check box or radio widget without appearance states: /N << on-state, Off >>, the on one
   * with its /MK /CA mark (✔ for check boxes, ● for radio buttons by default) in the DA size and
   * colour, both with the /MK background and border. A single stream it had becomes its on state.
   * False when it has no on state of its own (onStateOf): nothing is made.
   */
  private makeStates(w: Widget, o: Obj): boolean {
    const doc = this.doc;
    const [x0, y0, x1, y1] = rectOf(o);
    const width = x1 - x0, height = y1 - y0;
    const on = onStateOf(o);
    if (on === null) return false;
    const mk = o.get("MK");
    const frame = frameOps(o, width, height);
    const form = (content: string) => formXObject(this.mupdf, doc, content, width, height);
    const n = o.get("AP", "N");
    const onStream = n.isStream() ? n : form("");
    if (!n.isStream()) {
      const ca = mk.isDictionary() && mk.get("CA").isString() ? mk.get("CA").asString() : "";
      const mark = DINGBATS[ca] ?? (fieldTypeOf(o) === "radio" ? "●" : "✔");
      const da = daOf(w);
      const size = da.size || Math.max(1, Math.min(width, height) * 0.8);
      const { runs, missing } = encodeWithFallbacks(this.mupdf, doc, mark, { family: "sans", bold: false, italic: false });
      for (const ch of missing) this.missing.add(ch);
      let text = "";
      if (runs.length) {
        const advance = runs.reduce((s, r) => s + r.width, 0) * size;
        text = `BT\n${colorOp(da.color)}\n1 0 0 1 ${fmt((width - advance) / 2)} ${fmt((height - 0.7 * size) / 2)} Tm\n`;
        for (const r of runs) text += `/${fontKey(doc, onStream, r.font)} ${fmt(size)} Tf <${r.hex}> Tj\n`;
        text += "ET\n";
      }
      writeContent(this.mupdf, onStream, `q\n${frame}${text}Q\n`);
    }
    // The on state keeps the bytes of the /V or /AS it came from (a Latin-1 "Sì" stays Latin-1).
    const named = [inherited(o, "V"), o.get("AS")].find((v) => v && nameText(v) === on && v.asName() !== on);
    const states = doc.newDictionary();
    states.put(named ? named.resolve() : doc.newName(on), onStream);
    states.put(doc.newName("Off"), form(frame ? `q\n${frame}Q\n` : ""));
    let ap = o.get("AP");
    if (!ap.isDictionary()) {
      ap = doc.newDictionary();
      o.put("AP", ap);
    }
    ap.put("N", states);
    ap.delete("D");
    return true;
  }

  // ------------------------------------------------------------------- the writer

  /** The widget's appearance after frame(): its stream, the text-free part MuPDF drew, its box. */
  private appearance(o: Obj, da: { size: number }): { stream: Obj; frame: string; box: Box } | null {
    const n = o.get("AP", "N");
    if (!n.isStream()) {
      const r = rectOf(o);
      if (r[2] - r[0] > 0 && r[3] - r[1] > 0) throw new Error(`MuPDF made no appearance for the field "${fullName(o)}"`);
      return null; // a widget of no size: nothing to draw into
    }
    const buf = n.readStream();
    let s: string;
    try {
      s = buf.asString();
    } finally {
      buf.destroy();
    }
    // MuPDF's layout: "/Tx BMC q [background] [border] <clip> W n [comb dividers] BT ... ET Q EMC".
    const clip = s.indexOf("W\nn\n");
    const text = clip < 0 ? -1 : s.indexOf("BT\n", clip);
    if (!s.startsWith("/Tx BMC\nq\n") || text < 0 || !s.endsWith("ET\nQ\nEMC\n"))
      throw new Error(`The appearance of the field "${fullName(o)}" is not laid out as expected`);
    const bbox = n.get("BBox");
    const num = (i: number) => (bbox.isArray() && bbox.get(i).isNumber() ? bbox.get(i).asNumber() : 0);
    const box: Box = { W: num(2) - num(0), H: num(3) - num(1), bw: borderWidthOf(o), q: alignOf(o), size: da.size };
    return { stream: n, frame: s.slice(0, text), box };
  }

  /** Writes the text objects into the appearance, its fonts into the appearance's resources. */
  private write(o: Obj, stream: Obj, frame: string, color: number[], size: number, lines: Placed[], before = "") {
    let ops = before + `BT\n${colorOp(color)}\n`;
    // The appearance's fonts are exactly the ones these text objects use: MuPDF's frame lists its
    // own (not embedded, and drawing nothing now), which would stay in the file for no use.
    const fonts = this.doc.newDictionary();
    const keys = new Map<number, string>();
    for (const line of lines) {
      if (!line.cells.length) continue;
      ops += `1 0 0 1 ${fmt(line.x)} ${fmt(line.y)} Tm\n`;
      let run: Cell[] = [];
      const flush = () => {
        if (!run.length) return;
        const num = run[0].font.asIndirect();
        let key = keys.get(num);
        if (!key) {
          keys.set(num, (key = `FPE${keys.size + 1}`));
          fonts.put(key, run[0].font);
        }
        ops += `/${key} ${fmt(size)} Tf <${run.map((c) => c.hex).join("")}> Tj\n`;
        run = [];
      };
      for (const c of line.cells) {
        if (run.length && run[0].font.asIndirect() !== c.font.asIndirect()) flush();
        run.push(c);
      }
      flush();
    }
    writeContent(this.mupdf, stream, frame + ops + "ET\nQ\nEMC\n");
    let res = stream.get("Resources");
    if (!res.isDictionary()) {
      res = this.doc.newDictionary();
      stream.put("Resources", res);
    }
    res.put("Font", fonts);
    this.drawn.add(o.isIndirect() ? o.asIndirect() : -1);
  }

  /** A text field's (or combo box's) value, laid out as MuPDF lays out WinAnsi text. */
  private writeText(w: Widget, o: Obj, da: { size: number; color: number[] }, family: FontFamily, text: string, multiline: boolean) {
    const ap = this.appearance(o, da);
    if (!ap) return;
    const { box } = ap;
    const paragraphs = this.shape(text, family);
    const maxLen = w.getMaxLen();
    const ff = intOf(inherited(o, "Ff"));
    let layout: { size: number; lines: Placed[]; overflow: boolean };
    if (multiline) layout = layoutMulti(paragraphs, box);
    else if (ff & FF_COMB && maxLen > 0 && fieldTypeOf(o) === "text") layout = layoutComb(paragraphs.flat(), box, maxLen);
    else layout = layoutSingle(paragraphs.flat(), box);
    if (layout.overflow) this.overflow = true;
    this.write(o, ap.stream, ap.frame, da.color, layout.size, layout.lines);
  }

  /**
   * A list box: one row per option from /TI, the selected rows highlighted, each row placed as
   * MuPDF places the lines of the list (it draws one as multi-line text): aligned by /Q, the
   * first baseline as layoutMulti's.
   */
  private writeList(w: Widget, o: Obj, da: { size: number; color: number[] }, options: FieldOption[], values: string[]) {
    const ap = this.appearance(o, da);
    if (!ap) return;
    const { box } = ap;
    const { W, H, bw } = box;
    const size = da.size || 12, lh = LINE_HEIGHT * size;
    const selected = options.map((x, i) => (values.includes(x.value) ? i : -1)).filter((i) => i >= 0);
    const dict = fieldDictOf(o);
    // The first row shown: /TI, moved so that the first selected row is visible.
    const visible = Math.max(1, Math.floor((H - 2 * bw) / lh));
    let top = Math.max(0, Math.min(intOf(inherited(o, "TI")), Math.max(0, options.length - 1)));
    if (selected.length && (selected[0] < top || selected[0] >= top + visible)) top = Math.max(0, Math.min(selected[0], options.length - visible));
    if (top > 0) dict.put("TI", top);
    else dict.delete("TI");
    const family = familyOf(daOf(w).font);
    const lines: Placed[] = [];
    let highlight = "";
    const first = firstBaseline(box, size);
    for (let i = top, row = 0; i < options.length; i++, row++) {
      const y = first - row * lh;
      if (y < -size) break;
      if (selected.includes(i)) highlight += `${fmt(bw)} ${fmt(y - 0.25 * size)} ${fmt(W - 2 * bw)} ${fmt(lh)} re\n`;
      const cells = this.shape(drawnText(options[i].label, false), family).flat();
      lines.push({ cells, x: startX(box, alignedWidth(cells) * size), y });
    }
    const before = highlight ? `q\n${LIST_HIGHLIGHT}\n${highlight}f\nQ\n` : "";
    this.write(o, ap.stream, ap.frame, da.color, size, lines, before);
  }

  /**
   * `text` as cells, one array per paragraph (line breaks split them): shaped once with
   * core.encodeWithFallbacks (the same fonts as line edits, one CJK font for the whole value),
   * each advance from the font's /W, what viewers draw with. Characters no font has are left out.
   */
  private shape(text: string, family: FontFamily): Cell[][] {
    const chars = [...text];
    const { runs, missing } = encodeWithFallbacks(this.mupdf, this.doc, text.replace(/\n/g, " "), { family, bold: false, italic: false });
    for (const ch of missing) this.missing.add(ch);
    const cells: Cell[] = [];
    for (const run of runs) {
      const widths = this.widthsOf(run.font);
      let i = 0;
      for (const ch of run.text) {
        const hex = run.hex.slice(4 * i, 4 * i + 4);
        const gid = parseInt(hex, 16);
        cells.push({ ch, font: run.font, hex, width: (widths.map.get(gid) ?? widths.dw) / 1000 });
        i++;
      }
    }
    const out: Cell[][] = [[]];
    let next = 0;
    for (const ch of chars) {
      if (ch === "\n") {
        out.push([]);
        if (!missing.includes(" ")) next++; // drawn as a space in the shaped text
        continue;
      }
      if (missing.includes(ch)) continue;
      out[out.length - 1].push(cells[next++]);
    }
    return out;
  }

  /** A fallback font's advances from its /W (glyph id = CID), read once per font object. */
  private widthsOf(font: Obj): { map: Map<number, number>; dw: number } {
    const num = font.asIndirect();
    let cached = this.widths.get(num);
    if (cached) return cached;
    const desc = font.get("DescendantFonts", 0);
    const dw = desc.get("DW").isNumber() ? desc.get("DW").asNumber() : 1000;
    const map = new Map<number, number>();
    const W = desc.get("W");
    for (let i = 0, n = W.isArray() ? W.length : 0; i + 1 < n;) {
      const c1 = W.get(i).asNumber(), next = W.get(i + 1);
      if (next.isArray()) {
        for (let k = 0; k < next.length; k++) map.set(c1 + k, next.get(k).asNumber());
        i += 2;
      } else {
        const c2 = next.asNumber(), width = W.get(i + 2).asNumber();
        for (let c = c1; c <= c2; c++) map.set(c, width);
        i += 3;
      }
    }
    this.widths.set(num, (cached = { map, dw }));
    return cached;
  }

  /**
   * Whether WinAnsi text MuPDF drew fits its box: the same layout, measured with the font MuPDF
   * drew it with (its built-in Helvetica, Times or Courier), without embedding anything.
   */
  private measureOverflow(w: Widget, o: Obj, da: { size: number }, family: FontFamily, text: string, multiline: boolean) {
    const n = o.get("AP", "N");
    if (!n.isStream() || !text) return;
    const bbox = n.get("BBox");
    const num = (i: number) => (bbox.isArray() && bbox.get(i).isNumber() ? bbox.get(i).asNumber() : 0);
    const box: Box = { W: num(2) - num(0), H: num(3) - num(1), bw: borderWidthOf(o), q: alignOf(o), size: da.size };
    const name = family === "serif" ? "Times-Roman" : family === "mono" ? "Courier" : "Helvetica";
    let font = this.measureFonts.get(name);
    if (!font) this.measureFonts.set(name, (font = new this.mupdf.Font(name)));
    const f = font;
    const paragraphs = text.split("\n").map((p) => [...p].map((ch): Cell => {
      const gid = f.encodeCharacter(ch.codePointAt(0)!);
      return { ch, font: n, hex: "", width: f.advanceGlyph(gid, 0) };
    }));
    const ff = intOf(inherited(o, "Ff"));
    const maxLen = w.getMaxLen();
    const layout = multiline ? layoutMulti(paragraphs, box)
      : ff & FF_COMB && maxLen > 0 ? layoutComb(paragraphs.flat(), box, maxLen) : layoutSingle(paragraphs.flat(), box);
    if (layout.overflow) this.overflow = true;
  }
}

/** MuPDF's setter for the widget's kind, given a different value first so that it always marks the field changed. */
function setValue(w: Widget, choice: boolean, value: string) {
  const set = (v: string) => (choice ? w.setChoiceValue(v) : w.setTextValue(v));
  set(value === "" ? " " : "");
  set(value);
}

/** ZapfDingbats marks (/MK /CA, in the font's own encoding) as Unicode. */
const DINGBATS: Record<string, string> = {
  "3": "✓", "4": "✔", "7": "✗", "8": "✘", l: "●", n: "■", u: "◆", H: "★",
};

// ---------------------------------------------------------------------------------------------
// Layout (MuPDF's, measured in report-forms §2)

const widthOf = (cells: Cell[]) => cells.reduce((s, c) => s + c.width, 0);
/** Width without the spaces at the end: what alignment uses (they stay drawn, as MuPDF does). */
const alignedWidth = (cells: Cell[]) => {
  let end = cells.length;
  while (end > 0 && cells[end - 1].ch === " ") end--;
  return widthOf(cells.slice(0, end));
};
const startX = (box: Box, tw: number) => (box.q === 1 ? (box.W - tw) / 2 : box.q === 2 ? box.W - 2 * box.bw - tw : 2 * box.bw);

/**
 * One line: the DA size, or automatic (the box height less 4 border widths, shrunk to fit the
 * width; MuPDF's can reach 0 with a thick border, so it is floored at 4 pt), baseline at
 * (h - 0.6 size) / 2.
 */
function layoutSingle(cells: Cell[], box: Box) {
  const tw = widthOf(cells);
  const room = box.W - 4 * box.bw;
  let size = box.size, overflow = false;
  if (!size) {
    size = box.H - 4 * box.bw;
    if (tw * size > room && tw > 0) size = room / tw;
    size = Math.max(size, Math.min(4, box.H));
  } else overflow = tw * size > room + 0.01;
  return { size, lines: [{ cells, x: startX(box, tw * size), y: (box.H - 0.6 * size) / 2 }], overflow };
}

/**
 * The first baseline of multi-line text (and of a list box's rows), as MuPDF's
 * write_variable_text puts it (pdf-appearance.c, with adjust_baseline): a line (1.116 size)
 * below the top of the box inside the padding (2 border widths on each side), unless that leaves
 * less than 0.2 size above the bottom of that box, where it is then put: in a box about one line
 * tall the text sits up, inside it.
 */
function firstBaseline(box: Box, size: number): number {
  const padding = 2 * box.bw, h = box.H - 2 * padding;
  let baseline = LINE_HEIGHT * size;
  if (baseline + 0.2 * size > h) baseline = h - 0.2 * size;
  return padding + h - baseline;
}

/**
 * Several lines: the DA size or 12, line height 1.116 size, the first baseline as
 * firstBaseline puts it, wrapped at spaces (a space stays at the end of its line; a word longer
 * than the line stays whole). Overflow: a word wider than the box, or lines below it.
 */
function layoutMulti(paragraphs: Cell[][], box: Box) {
  const size = box.size || 12, lh = LINE_HEIGHT * size, room = box.W - 4 * box.bw;
  const lines: Cell[][] = [];
  for (const para of paragraphs) {
    // Words with their trailing spaces.
    const words: Cell[][] = [];
    for (const c of para) {
      const last = words[words.length - 1];
      if (last && !(c.ch !== " " && last[last.length - 1].ch === " ")) last.push(c);
      else words.push([c]);
    }
    let cur: Cell[] = [];
    for (const word of words) {
      if (cur.length && alignedWidth([...cur, ...word]) * size > room) {
        lines.push(cur);
        cur = word;
      } else cur = [...cur, ...word];
    }
    lines.push(cur);
  }
  let overflow = false;
  const first = firstBaseline(box, size);
  const placed = lines.map((cells, i) => {
    const tw = alignedWidth(cells) * size;
    if (tw > room + 0.01) overflow = true;
    return { cells, x: startX(box, tw), y: first - i * lh };
  });
  const last = placed[placed.length - 1];
  if (last && last.cells.length && last.y - 0.15 * size < 0) overflow = true;
  return { size, lines: placed, overflow };
}

/** A comb: each character centred in its cell (width / MaxLen); automatic size: the height, shrunk to the widest character. */
function layoutComb(cells: Cell[], box: Box, maxLen: number) {
  const cell = box.W / maxLen;
  const chars = cells.slice(0, maxLen);
  let size = box.size || box.H;
  if (!box.size) {
    const widest = Math.max(0.001, ...chars.map((c) => c.width));
    size = Math.min(size, cell / widest);
  }
  const y = (box.H - 0.6 * size) / 2;
  return { size, lines: chars.map((c, i) => ({ cells: [c], x: i * cell + (cell - c.width * size) / 2, y })), overflow: false };
}
