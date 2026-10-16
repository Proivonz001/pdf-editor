// Form fields (src/engine/forms.ts), in Node on the worker's mupdf build: listing every field
// type, the checks before an edit, filling in with MuPDF's drawing (WinAnsi) and with the app's
// own writer (anything else, laid out where MuPDF lays out WinAnsi text), buttons without
// MuPDF's toggle() (radio groups without appearances, state names in Latin-1), choices, values
// another tool wrote (CR line breaks, decomposed accents), passwords never drawn, JavaScript that
// never runs, XFA, NeedAppearances, fields on several pages, replays from snapshots mixed with
// line and image edits. Fixtures are built here with MuPDF's object API (as the research's
// build-forms.mjs), plus reportlab-form.pdf. PDF/A of filled forms is in pdfa.test.ts ("filled
// forms").
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as mupdf from "mupdf";
import { afterEach, describe, expect, it } from "vitest";
import {
  extractLines,
  fallbackFontState,
  releaseFallbackFonts,
  releasePage,
  replaceText,
  restoreFallbackFonts,
  savePdf,
} from "../src/engine/core.js";
import {
  FieldError,
  applyFieldEdit,
  fieldTypeOf,
  formChanged,
  formInfo,
  fullName,
  hidePasswords,
  isWinAnsi,
  pageFields,
  planFieldEdit,
  type FieldEdit,
} from "../src/engine/forms";
import { deletePlacement, findPlacements, transformPlacement } from "../src/engine/images";
import type { FieldValue, FieldWidget, Matrix } from "../src/engine/protocol";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

/** Documents opened by a test, destroyed after it with their fallback fonts (rule 5). */
let opened: mupdf.PDFDocument[] = [];
afterEach(() => {
  for (const doc of opened) {
    releaseFallbackFonts(doc);
    doc.destroy();
  }
  opened = [];
});
const keep = (doc: mupdf.PDFDocument) => (opened.push(doc), doc);
const openBytes = (bytes: Uint8Array) => keep(mupdf.Document.openDocument(bytes, "application/pdf").asPDF()!);

function saveBytes(doc: mupdf.PDFDocument, options = "encrypt=none"): Uint8Array {
  const buf = doc.saveToBuffer(options);
  try {
    return buf.asUint8Array().slice();
  } finally {
    buf.destroy();
  }
}

// ---------------------------------------------------------------------------------------------
// Synthetic forms

const TX_MULTI = 1 << 12, TX_PASSWORD = 1 << 13, TX_FILE = 1 << 20, TX_COMB = 1 << 24;
const BTN_NO_TOGGLE = 1 << 14, BTN_RADIO = 1 << 15, BTN_PUSH = 1 << 16, BTN_UNISON = 1 << 25;
const CH_COMBO = 1 << 17, CH_EDIT = 1 << 18, CH_MULTI = 1 << 21;
const PRINT = 4;

/**
 * Every field type on two pages, as build-forms.mjs: single-line, multi-line, comb (MaxLen 16),
 * password, file select, a check box with export "Si" and its own appearances, a radio group of
 * three with NoToggleToOff, combos (with and without export pairs, editable), list boxes (single,
 * multi), a push button with a script, an unsigned signature field, read-only, required, a field
 * with keystroke/format/validate scripts, a calculated one (/CO), a field with widgets on two
 * pages, hierarchical names, document and open-action scripts.
 */
function buildForm({ needAppearances = false, xfa = false, rotate = 0 as 0 | 90 | 180 | 270 } = {}): Uint8Array {
  const doc = new mupdf.PDFDocument();
  try {
    const helv = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" });
    const zadb = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "ZapfDingbats" });
    doc.insertPage(-1, doc.addPage([0, 0, 595, 842], rotate, { Font: { F1: helv } }, "BT /F1 9 Tf 40 800 Td (Nome) Tj ET\n"));
    doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { Font: { F1: helv } }, "BT /F1 9 Tf 40 790 Td (Pagina 2) Tj ET\n"));
    const page1 = doc.findPage(0), page2 = doc.findPage(1);
    const annots1 = doc.newArray(), annots2 = doc.newArray();
    page1.put("Annots", annots1);
    page2.put("Annots", annots2);
    const fields = doc.newArray();
    const DA = "(/Helv 10 Tf 0 g)";
    const widget = (dict: Record<string, unknown>, page = page1, annots = annots1) => {
      const o = doc.addObject({ Type: "Annot", Subtype: "Widget", F: PRINT, P: page, ...dict });
      annots.push(o);
      return o;
    };
    const field = (dict: Record<string, unknown>, page = page1, annots = annots1) => {
      const o = widget(dict, page, annots);
      fields.push(o);
      return o;
    };
    const zres = { Font: { ZaDb: zadb } };
    const mark = (ch: string) => doc.addStream(`q 0 g BT /ZaDb 12 Tf 1.5 2 Td (${ch}) Tj ET Q\n`, { Type: "XObject", Subtype: "Form", BBox: [0, 0, 14, 14], Resources: zres });
    const off = doc.addStream("", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 14, 14] });

    field({ FT: "Tx", T: "(nome)", TU: "(Nome e cognome)", DA, Rect: [150, 795, 400, 812] });
    field({ FT: "Tx", T: "(note)", Ff: TX_MULTI, DA, Rect: [150, 720, 400, 772] });
    field({ FT: "Tx", T: "(cf)", Ff: TX_COMB, MaxLen: 16, DA, Rect: [150, 694, 406, 712] });
    field({ FT: "Tx", T: "(pin)", Ff: TX_PASSWORD, V: "(segreto)", DA, Rect: [150, 664, 300, 682] });
    field({ FT: "Tx", T: "(allegato)", Ff: TX_FILE, DA, Rect: [150, 634, 400, 652] });
    field({ FT: "Btn", T: "(privacy)", V: "Off", AS: "Off", DA: "(/ZaDb 0 Tf 0 g)", MK: { CA: "(4)" }, AP: { N: { Si: mark("4"), Off: off } }, Rect: [150, 600, 164, 614] });
    const radio = doc.addObject({ FT: "Btn", T: "(sesso)", Ff: BTN_RADIO | BTN_NO_TOGGLE, V: "Off", Kids: [] });
    fields.push(radio);
    ["M", "F", "X"].forEach((state, i) => {
      radio.get("Kids").push(widget({ Parent: radio, AS: "Off", DA: "(/ZaDb 0 Tf 0 g)", MK: { CA: "(l)" }, AP: { N: { [state]: mark("l"), Off: off } }, Rect: [150 + 50 * i, 570, 164 + 50 * i, 584] }));
    });
    field({ FT: "Ch", T: "(citta)", Ff: CH_COMBO, Opt: ["(Roma)", "(Milano)", "(Forlì)"], DA, Rect: [150, 544, 300, 562] });
    const prov = field({ FT: "Ch", T: "(provincia)", Ff: CH_COMBO | CH_EDIT, DA, Rect: [320, 544, 450, 562] });
    const opt = doc.newArray();
    for (const [e, d] of [["RM", "Roma"], ["MI", "Milano"], ["FC", "Forlì-Cesena"], ["BV", "Brașov"]]) {
      const pair = doc.newArray();
      pair.push(doc.newString(e));
      pair.push(doc.newString(d));
      opt.push(pair);
    }
    prov.put("Opt", opt);
    field({ FT: "Ch", T: "(lingua)", Opt: ["(Italiano)", "(English)", "(Deutsch)", "(Français)"], DA, Rect: [150, 470, 300, 530] });
    field({ FT: "Ch", T: "(interessi)", Ff: CH_MULTI, Opt: ["(Sport)", "(Musica)", "(Arte)", "(Cucina)", "(Viaggi)", "(Lettura)", "(Cinema)"], DA, Rect: [320, 470, 450, 530] });
    field({ FT: "Btn", T: "(invia)", Ff: BTN_PUSH, DA, MK: { CA: "(Invia)", BG: [0.9, 0.9, 0.9] }, A: { S: "JavaScript", JS: "(app.alert('premuto');)" }, Rect: [150, 432, 250, 455] });
    field({ FT: "Sig", T: "(firma)", Rect: [150, 372, 350, 420] });
    field({ FT: "Tx", T: "(codice)", Ff: 1, V: "(ABC123)", DA, Rect: [150, 344, 300, 362] });
    field({ FT: "Tx", T: "(email)", Ff: 2, DA, Rect: [320, 344, 450, 362] });
    field({
      FT: "Tx", T: "(importo)", DA, Rect: [150, 314, 300, 332],
      AA: {
        K:{ S: "JavaScript", JS: doc.newString('AFNumber_Keystroke(2, 0, 0, 0, "€", true);') },
        F: { S: "JavaScript", JS: doc.newString('AFNumber_Format(2, 0, 0, 0, "€", true);') },
        V: { S: "JavaScript", JS: "(event.rc = event.value < 1000;)" },
      },
    });
    const totale = field({ FT: "Tx", T: "(totale)", Ff: 1, DA, Rect: [320, 314, 450, 332], AA: { C: { S: "JavaScript", JS: "(event.value = this.getField(\"importo\").value * 2;)" } } });
    field({ FT: "Tx", T: "(nascita)", DA, Rect: [460, 314, 560, 332], AA: { F: { S: "JavaScript", JS: "(AFDate_FormatEx(\"dd/mm/yyyy\");)" } } });
    const head = doc.addObject({ FT: "Tx", T: "(intestazione)", DA, Kids: [] });
    fields.push(head);
    head.get("Kids").push(widget({ Parent: head, Rect: [150, 284, 400, 302] }));
    head.get("Kids").push(widget({ Parent: head, Rect: [150, 772, 400, 790] }, page2, annots2));
    const a = doc.addObject({ T: "(a)", Kids: [] });
    fields.push(a);
    const b = doc.addObject({ T: "(b)", Parent: a, Kids: [] });
    a.get("Kids").push(b);
    b.get("Kids").push(widget({ FT: "Tx", T: "(c)", Parent: b, DA, Rect: [150, 254, 300, 272] }));
    a.get("Kids").push(widget({ FT: "Tx", T: "(e)", Parent: a, DA, Rect: [320, 254, 450, 272] }));
    field({ FT: "Tx", T: "(nascosto)", F: PRINT | 2, DA, Rect: [150, 224, 300, 242] });
    field({ FT: "Tx", T: "(zero)", DA, Rect: [150, 200, 150, 200] });

    const acro: Record<string, unknown> = { Fields: fields, DR: { Font: { Helv: helv, ZaDb: zadb } }, DA, CO: [totale] };
    if (needAppearances) acro.NeedAppearances = true;
    const root = doc.getTrailer().get("Root");
    root.put("AcroForm", doc.addObject(acro));
    if (xfa) {
      const arr = doc.newArray();
      arr.push(doc.newString("datasets"));
      arr.push(doc.addStream("<xfa:datasets xmlns:xfa=\"http://www.xfa.org/schema/xfa-data/1.0/\"><xfa:data><form1><nome>XFA value</nome></form1></xfa:data></xfa:datasets>", {}));
      root.get("AcroForm").put("XFA", arr);
    }
    // (MuPDF.js takes a "(...)" JS string as the text inside the parentheses, escapes and all.)
    const js = doc.addObject({ S: "JavaScript", JS: "(this.getField(\"nome\").value = \"JS RAN\";)" });
    root.put("Names", { JavaScript: { Names: ["(init)", js] } });
    root.put("OpenAction", { S: "JavaScript", JS: "(this.getField(\"note\").value = \"OPEN RAN\";)" });
    return saveBytes(doc);
  } finally {
    doc.destroy();
  }
}

/** A one-page form with the given widgets (fields and widgets in one dictionary each). */
function formOf(defs: Record<string, unknown>[], { pageSize = [0, 0, 600, 400] as [number, number, number, number], acro = {} as Record<string, unknown>, tabs = "" } = {}): Uint8Array {
  const doc = new mupdf.PDFDocument();
  try {
    const helv = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" });
    doc.insertPage(-1, doc.addPage(pageSize, 0, {}, "0.93 g 0 0 600 400 re f"));
    const page = doc.findPage(0);
    if (tabs) page.put("Tabs", doc.newName(tabs));
    const annots = doc.newArray();
    page.put("Annots", annots);
    const fields = doc.newArray();
    for (const def of defs) {
      const o = doc.addObject({ Type: "Annot", Subtype: "Widget", F: PRINT, P: page, ...def });
      annots.push(o);
      fields.push(o);
    }
    doc.getTrailer().get("Root").put("AcroForm", doc.addObject({ Fields: fields, DR: { Font: { Helv: helv } }, ...acro }));
    return saveBytes(doc);
  } finally {
    doc.destroy();
  }
}

// ---------------------------------------------------------------------------------------------
// Helpers

/** Plans and applies a field edit as the session will; null when it is a no-op. */
function fill(doc: mupdf.PDFDocument, name: string, value: FieldValue) {
  const edit = planFieldEdit(mupdf, doc, name, value);
  if (!edit) return null;
  return { edit, ...applyFieldEdit(mupdf, doc, edit) };
}
const text = (t: string): FieldValue => ({ kind: "text", text: t });
const state = (s: string): FieldValue => ({ kind: "state", state: s });
const choice = (...values: string[]): FieldValue => ({ kind: "choice", values });

const fieldsOf = (doc: mupdf.PDFDocument, page = 0) => pageFields(mupdf, doc, page);
function field(doc: mupdf.PDFDocument, name: string, page = 0, k = 0): FieldWidget {
  const f = fieldsOf(doc, page).filter((x) => x.name === name)[k];
  if (!f) throw new Error(`no field ${name} on page ${page}`);
  return f;
}

/** The refusal planFieldEdit gives, as "code: message". */
function refusal(doc: mupdf.PDFDocument, name: unknown, value: unknown): string {
  try {
    planFieldEdit(mupdf, doc, name, value);
  } catch (err) {
    if (err instanceof FieldError) return err.code;
    throw err;
  }
  return "accepted";
}

/** Runs `fn` on each widget of page `p` named `name`, then destroys them and the page. */
function onWidgets<T>(doc: mupdf.PDFDocument, p: number, name: string, fn: (w: mupdf.PDFWidget, page: mupdf.PDFPage) => T): T[] {
  const page = doc.loadPage(p);
  const widgets = [...page.getWidgets()];
  try {
    return widgets.filter((w) => fullName(w.getObject()) === name).map((w) => fn(w, page));
  } finally {
    for (const w of widgets) w.destroy();
    page.destroy();
  }
}

interface Glyph { x: number; y: number; size: number; gid: number; uni: number; font: string }

/** The glyphs a widget's appearance draws, in page space. */
function glyphsOf(w: mupdf.PDFWidget): Glyph[] {
  const out: Glyph[] = [];
  let failure: unknown = null;
  const dev = new mupdf.Device({
    fillText(t, ctm, cs) {
      try {
        t.walk({
          showGlyph(font, trm, gid, uni) {
            const m = mupdf.Matrix.concat(trm, ctm);
            out.push({ x: m[4], y: m[5], size: Math.hypot(m[2], m[3]), gid, uni, font: font.getName() });
            font.destroy();
          },
        });
      } catch (err) {
        failure ??= err;
      }
      t.destroy();
      cs.destroy();
    },
  });
  try {
    w.run(dev, mupdf.Matrix.identity);
    dev.close();
  } finally {
    dev.destroy();
  }
  if (failure) throw failure;
  return out;
}

const glyphs = (doc: mupdf.PDFDocument, name: string, p = 0, k = 0) => onWidgets(doc, p, name, (w) => glyphsOf(w))[k];
const drawn = (g: Glyph[]) => g.map((x) => String.fromCodePoint(x.uni)).join("");

/** Glyphs drawn outside the widget's rectangle (page space, with half a point of slack). */
function outside(doc: mupdf.PDFDocument, name: string, p = 0): number {
  return onWidgets(doc, p, name, (w) => {
    const r = w.getRect();
    return glyphsOf(w).filter((g) => g.x < r[0] - 0.5 || g.x > r[2] + 0.5 || g.y < r[1] - 0.5 || g.y > r[3] + 0.5).length;
  }).reduce((a, b) => a + b, 0);
}

const obj = (doc: mupdf.PDFDocument, name: string, p = 0, k = 0) => onWidgets(doc, p, name, (w) => w.getObject())[k];
/** A field entry the widget inherits. */
function inheritedOf(o: mupdf.PDFObject, key: string): mupdf.PDFObject {
  for (let node = o, depth = 0; node.isDictionary() && depth < 32; node = node.get("Parent"), depth++) if (!node.get(key).isNull()) return node.get(key);
  return mupdf.PDFObject.Null;
}

function apContent(o: mupdf.PDFObject, stateName?: string): string {
  let n = o.get("AP", "N");
  if (stateName && n.isDictionary() && !n.isStream()) n = n.get(stateName);
  if (!n.isStream()) return "";
  const buf = n.readStream();
  try {
    return buf.asString();
  } finally {
    buf.destroy();
  }
}

/** The fonts an appearance stream draws with: [key, BaseFont, embedded, program bytes]. */
function apFonts(o: mupdf.PDFObject): { base: string; embedded: boolean; bytes: number }[] {
  const n = o.get("AP", "N");
  const fonts = n.isStream() ? n.get("Resources", "Font") : mupdf.PDFObject.Null;
  const out: { base: string; embedded: boolean; bytes: number }[] = [];
  if (!fonts.isDictionary()) return out;
  fonts.forEach((f) => {
    const desc = f.get("DescendantFonts");
    const fd = desc.isArray() ? desc.get(0).get("FontDescriptor") : f.get("FontDescriptor");
    let bytes = 0;
    for (const k of ["FontFile", "FontFile2", "FontFile3"]) {
      const s = fd.isDictionary() ? fd.get(k) : mupdf.PDFObject.Null;
      if (s.isStream()) {
        const buf = s.readStream();
        bytes = buf.getLength();
        buf.destroy();
      }
    }
    out.push({ base: f.get("BaseFont").isName() ? f.get("BaseFont").asName() : "", embedded: bytes > 0, bytes });
  });
  return out;
}

/** Dark pixels in a page-space rectangle of a render of page `p` at scale 2. */
function ink(doc: mupdf.PDFDocument, rect: number[], p = 0, test = (r: number, g: number, b: number) => r < 100 && g < 100 && b < 100): number {
  const page = doc.loadPage(p);
  const pix = page.toPixmap(mupdf.Matrix.scale(2, 2), mupdf.ColorSpace.DeviceRGB, false, true);
  try {
    const w = pix.getWidth(), px = pix.getPixels(), n = pix.getNumberOfComponents();
    let count = 0;
    for (let y = Math.max(0, Math.floor(rect[1] * 2)); y < Math.min(pix.getHeight(), Math.ceil(rect[3] * 2)); y++)
      for (let x = Math.max(0, Math.floor(rect[0] * 2)); x < Math.min(w, Math.ceil(rect[2] * 2)); x++) {
        const i = (y * w + x) * n;
        if (test(px[i], px[i + 1], px[i + 2])) count++;
      }
    return count;
  } finally {
    pix.destroy();
    page.destroy();
  }
}

/** The document saved (encrypt=none, no garbage collection) and opened again. */
const reopen = (doc: mupdf.PDFDocument) => openBytes(saveBytes(doc));

// ---------------------------------------------------------------------------------------------

describe("listing fields", () => {
  it("every type, with flags, locks, options and on states", () => {
    const doc = openBytes(buildForm());
    const list = fieldsOf(doc);
    const by = (name: string) => list.find((f) => f.name === name)!;
    expect(list.map((f) => f.index)).toEqual(list.map((_, i) => i));
    expect(list.map((f) => [f.name, f.type, f.locked])).toEqual([
      ["nome", "text", null], ["note", "text", null], ["cf", "text", null], ["pin", "text", "password"],
      ["allegato", "text", "file-select"], ["privacy", "checkbox", null],
      ["sesso", "radio", null], ["sesso", "radio", null], ["sesso", "radio", null],
      ["citta", "combo", null], ["provincia", "combo", null], ["lingua", "list", null], ["interessi", "list", null],
      ["invia", "button", "push-button"], ["firma", "signature", "signature"], ["codice", "text", "read-only"],
      ["email", "text", null], ["importo", "text", null], ["totale", "text", "read-only"], ["nascita", "text", null],
      ["intestazione", "text", null], ["a.b.c", "text", null], ["a.e", "text", null],
    ]); // "nascosto" (hidden) and "zero" (no area) are left out
    expect(by("nome")).toMatchObject({ label: "Nome e cognome", value: "", multiline: false, comb: false, maxLen: 0, fontSize: 10, color: [0, 0, 0], align: 0, rotation: 0, required: false, scripted: false, format: null });
    expect(by("nome").rect.map(Math.round)).toEqual([150, 30, 400, 47]); // page space, y down
    expect(by("note")).toMatchObject({ multiline: true });
    expect(by("cf")).toMatchObject({ comb: true, maxLen: 16 });
    expect(by("pin").value).toBe(""); // a password is never shown
    expect(by("privacy")).toMatchObject({ value: "Off", onState: "Si" });
    expect(list.filter((f) => f.name === "sesso").map((f) => f.onState)).toEqual(["M", "F", "X"]);
    expect(by("citta")).toMatchObject({ editable: false, value: "", displayValue: "", options: [{ label: "Roma", value: "Roma" }, { label: "Milano", value: "Milano" }, { label: "Forlì", value: "Forlì" }] });
    expect(by("provincia")).toMatchObject({ editable: true });
    expect(by("provincia").options![2]).toEqual({ label: "Forlì-Cesena", value: "FC" });
    expect(by("interessi")).toMatchObject({ multiSelect: true, values: [], value: "" });
    expect(by("firma")).toMatchObject({ signed: false });
    expect(by("email").required).toBe(true);
    expect(by("importo")).toMatchObject({ scripted: true, format: { kind: "number", decimals: 2, currency: "€" } });
    expect(by("totale").scripted).toBe(true); // calculated (/CO, /AA /C)
    expect(by("nascita").format).toEqual({ kind: "date", pattern: "dd/mm/yyyy" });
    expect(by("a.b.c").label).toBe("c");
    expect(field(doc, "intestazione", 1).rect.map(Math.round)).toEqual([150, 52, 400, 70]);
  });

  it("names as MuPDF reads them: hierarchy, non-ASCII, a period inside /T, kids without /T", () => {
    const doc = keep(new mupdf.PDFDocument());
    doc.insertPage(-1, doc.addPage([0, 0, 400, 400], 0, {}, ""));
    const pg = doc.findPage(0);
    const annots = doc.newArray();
    pg.put("Annots", annots);
    const fields = doc.newArray();
    const W = (o: Record<string, unknown>) => { const x = doc.addObject({ Type: "Annot", Subtype: "Widget", F: 4, P: pg, ...o }); annots.push(x); return x; };
    fields.push(W({ FT: "Tx", T: doc.newString("Città di nascita"), Rect: [20, 360, 200, 378] }));
    fields.push(W({ FT: "Tx", T: "(dati.anagrafici)", Rect: [20, 330, 200, 348] }));
    const parent = doc.addObject({ T: "(dati)", Kids: [] });
    fields.push(parent);
    parent.get("Kids").push(W({ FT: "Tx", T: "(anagrafici)", Parent: parent, Rect: [20, 300, 200, 318] }));
    const radio = doc.addObject({ FT: "Btn", T: "(scelta)", Ff: BTN_RADIO, Kids: [], Opt: ["(Roma)", "(Milano)"] });
    fields.push(radio);
    for (const [s, i] of [["0", 0], ["1", 1]] as const) {
      const on = doc.addStream("0 g 2 2 10 10 re f", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 14, 14] });
      radio.get("Kids").push(W({ Parent: radio, AS: "Off", AP: { N: { [s]: on } }, Rect: [20 + 30 * i, 260, 34 + 30 * i, 274] }));
    }
    const notAField = W({ Rect: [20, 200, 100, 220] }); // a widget with no /FT anywhere
    void notAField;
    doc.getTrailer().get("Root").put("AcroForm", doc.addObject({ Fields: fields }));
    const page = doc.loadPage(0);
    const widgets = [...page.getWidgets()];
    try {
      for (const w of widgets) expect(fullName(w.getObject())).toBe(w.getName());
      expect(widgets.map((w) => fieldTypeOf(w.getObject()))).toEqual(["text", "text", "text", "radio", "radio", null]);
    } finally {
      for (const w of widgets) w.destroy();
      page.destroy();
    }
    const list = fieldsOf(doc);
    expect(list.map((f) => f.name)).toEqual(["Città di nascita", "dati.anagrafici", "dati.anagrafici", "scelta", "scelta"]);
    expect(list[3].options).toEqual([{ label: "Roma", value: "0" }, { label: "Milano", value: "1" }]);
    // Two dictionaries named "dati.anagrafici": one field, filled together.
    const r = fill(doc, "dati.anagrafici", text("Rossi"))!;
    expect(r.edit.pages).toEqual([0]);
    expect(fieldsOf(doc).filter((f) => f.name === "dati.anagrafici").map((f) => f.value)).toEqual(["Rossi", "Rossi"]);
  });

  it("names agree with MuPDF on reportlab-form, which fills too", () => {
    const doc = openBytes(fixture("reportlab-form.pdf"));
    for (let p = 0; p < doc.countPages(); p++) {
      const page = doc.loadPage(p);
      const widgets = [...page.getWidgets()];
      try {
        for (const w of widgets) {
          expect(fullName(w.getObject())).toBe(w.getName());
          const t = { text: "text", checkbox: "checkbox", radiobutton: "radio", combobox: "combo", listbox: "list", button: "button", signature: "signature" }[w.getFieldType()];
          expect(fieldTypeOf(w.getObject())).toBe(t);
        }
      } finally {
        for (const w of widgets) w.destroy();
        page.destroy();
      }
    }
    const info = formInfo(mupdf, doc)!;
    expect(info.fieldsPerPage.reduce((a, b) => a + b, 0)).toBe(fieldsOf(doc).length + (doc.countPages() > 1 ? info.fieldsPerPage.slice(1).reduce((a, b) => a + b, 0) : 0));
    const nome = fieldsOf(doc).find((f) => f.type === "text")!;
    fill(doc, nome.name, text("Città: Forlì – 1.234,56 € «ok»"));
    expect(field(doc, nome.name).value).toBe("Città: Forlì – 1.234,56 € «ok»");
    expect(outside(doc, nome.name)).toBe(0);
  });

  it("a rotated page: rects in page space, text direction with /MK /R", () => {
    const doc = openBytes(buildForm({ rotate: 90 }));
    const nome = field(doc, "nome");
    // On a page turned 90° clockwise, user (x, y) goes to page (y, x).
    expect(nome.rect.map(Math.round)).toEqual([795, 150, 812, 400]);
    expect(nome.rotation).toBe(90);
    // Turned 90° or 270°, the text runs along the box's height: those boxes are tall.
    const box = (r: number, i: number) => (r % 180 ? [20 + 130 * i, 20, 37 + 130 * i, 120] : [20 + 130 * i, 300, 120 + 130 * i, 317]);
    const turned = openBytes(formOf([0, 90, 180, 270].map((r, i) => ({ FT: "Tx", T: `(r${r})`, DA: "(/Helv 10 Tf 0 g)", Rect: box(r, i), MK: { R: r } }))));
    expect(fieldsOf(turned).map((f) => f.rotation)).toEqual([0, 270, 180, 90]);
    for (const r of [0, 90, 180, 270]) {
      fill(turned, `r${r}`, text("Łódź ż"));
      expect(outside(turned, `r${r}`), `r${r}`).toBe(0);
      expect(drawn(glyphs(turned, `r${r}`))).toBe("Łódź ż");
    }
  });

  it("the page's tab order: rows (/Tabs /R), columns (/C), else /Annots", () => {
    const defs = [
      { T: "(c2)", Rect: [300, 300, 400, 318] }, { T: "(a1)", Rect: [20, 350, 120, 368] },
      { T: "(b1)", Rect: [20, 300, 120, 316] }, { T: "(a2)", Rect: [300, 352, 400, 366] },
    ].map((d) => ({ FT: "Tx", DA: "(/Helv 10 Tf 0 g)", ...d }));
    expect(fieldsOf(openBytes(formOf(defs))).map((f) => f.name)).toEqual(["c2", "a1", "b1", "a2"]);
    expect(fieldsOf(openBytes(formOf(defs, { tabs: "S" }))).map((f) => f.name)).toEqual(["c2", "a1", "b1", "a2"]);
    expect(fieldsOf(openBytes(formOf(defs, { tabs: "R" }))).map((f) => f.name)).toEqual(["a1", "a2", "b1", "c2"]);
    expect(fieldsOf(openBytes(formOf(defs, { tabs: "C" }))).map((f) => f.name)).toEqual(["a1", "b1", "a2", "c2"]);
  });

  it("formInfo: widgets per page, fillable fields, required, XFA, scripts; null without a form", () => {
    const doc = openBytes(buildForm());
    const info = formInfo(mupdf, doc)!;
    expect(info.fieldsPerPage).toEqual([fieldsOf(doc, 0).length, fieldsOf(doc, 1).length]);
    expect(info).toMatchObject({ fieldsPerPage: [23, 1], xfa: "none", scripts: true });
    // Distinct names the user can fill in: not the push button "invia", the signature field
    // "firma", the password "pin", the file select "allegato", the read-only "codice" and
    // "totale". Required and fillable: "email".
    const listed = [...fieldsOf(doc, 0), ...fieldsOf(doc, 1)];
    expect(info.fields).toBe(new Set(listed.filter((f) => f.locked === null).map((f) => f.name)).size);
    expect(info.fields).toBe(15);
    expect(info.required).toBe(1);
    expect(formInfo(mupdf, openBytes(buildForm({ xfa: true })))!.xfa).toBe("static");
    expect(formInfo(mupdf, openBytes(fixture("chrome-subset.pdf")))).toBeNull();
    const plain = openBytes(formOf([{ FT: "Tx", T: "(x)", Rect: [10, 10, 100, 30] }]));
    expect(formInfo(mupdf, plain)).toMatchObject({ fieldsPerPage: [1], fields: 1, required: 0, xfa: "none", scripts: false });
    // Push buttons only: nothing to fill.
    expect(formInfo(mupdf, openBytes(formOf([{ FT: "Btn", Ff: BTN_PUSH, T: "(stampa)", Rect: [10, 10, 100, 30] }])))).toBeNull();
    // A check box whose value is written as a string: its state all the same.
    const loose = openBytes(formOf([{ FT: "Btn", T: "(ok)", V: "(Yes)", AS: "Yes", Rect: [10, 10, 24, 24] }]));
    expect(field(loose, "ok")).toMatchObject({ value: "Yes", onState: "Yes" });
  });

  it("signature fields: signed or not, never filled; a zero-area one (an invisible signature) is not listed", () => {
    const doc = keep(new mupdf.PDFDocument());
    doc.insertPage(-1, doc.addPage([0, 0, 400, 400], 0, {}, ""));
    const pg = doc.findPage(0);
    const sig = doc.addObject({ Type: "Sig", Filter: "Adobe.PPKLite", SubFilter: "adbe.pkcs7.detached", ByteRange: [0, 10, 20, 30], Contents: doc.newByteString(new Uint8Array(16)) });
    const signed = doc.addObject({ Type: "Annot", Subtype: "Widget", F: 4, P: pg, FT: "Sig", T: "(firmato)", V: sig, Rect: [20, 20, 220, 70] });
    const unsigned = doc.addObject({ Type: "Annot", Subtype: "Widget", F: 4, P: pg, FT: "Sig", T: "(da firmare)", Rect: [20, 100, 220, 150] });
    const invisible = doc.addObject({ Type: "Annot", Subtype: "Widget", F: 132, P: pg, FT: "Sig", T: "(invisibile)", V: sig, Rect: [0, 400, 0, 400] });
    pg.put("Annots", [signed, unsigned, invisible]);
    doc.getTrailer().get("Root").put("AcroForm", doc.addObject({ Fields: [signed, unsigned, invisible], SigFlags: 3 }));
    expect(fieldsOf(doc).map((f) => [f.name, f.signed, f.locked])).toEqual([["firmato", true, "signature"], ["da firmare", false, "signature"]]);
    // Listed, but nothing to fill in: signature fields are signed with the Sign tool. The form is
    // still a form (something to sign).
    expect(formInfo(mupdf, doc)).toMatchObject({ fieldsPerPage: [2], fields: 0, required: 0 });
    expect(refusal(doc, "da firmare", text("Mario"))).toBe("not-editable");
    expect(inheritedOf(unsigned, "V").isNull()).toBe(true);
  });

  it("dynamic XFA: no widgets, form.xfa dynamic", () => {
    const doc = keep(new mupdf.PDFDocument());
    doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, {}, ""));
    const root = doc.getTrailer().get("Root");
    root.put("NeedsRendering", true);
    const arr = doc.newArray();
    arr.push(doc.newString("template"));
    arr.push(doc.addStream("<template/>", {}));
    root.put("AcroForm", doc.addObject({ Fields: [], XFA: arr }));
    expect(formInfo(mupdf, doc)).toEqual({ fieldsPerPage: [0], fields: 0, required: 0, xfa: "dynamic", scripts: false });
    expect(fieldsOf(doc)).toEqual([]);
    expect(refusal(doc, "nome", text("x"))).toBe("bad-request");
  });
});

describe("refusals", () => {
  it("every lock is not-editable, an unknown name or a wrong value bad-request, the same value a no-op", () => {
    const doc = openBytes(buildForm());
    for (const name of ["pin", "allegato", "invia", "firma", "codice", "totale"]) expect(refusal(doc, name, text("HACKED"))).toBe("not-editable");
    expect(refusal(doc, "nessuno", text("x"))).toBe("bad-request");
    expect(refusal(doc, 42, text("x"))).toBe("bad-request");
    expect(refusal(doc, "nome", null)).toBe("bad-request");
    expect(refusal(doc, "nome", state("Si"))).toBe("bad-request");
    expect(refusal(doc, "nome", text("a\u0000b"))).toBe("bad-request");
    expect(refusal(doc, "nome", { kind: "text", text: 7 })).toBe("bad-request");
    expect(refusal(doc, "nome", text("x".repeat(10_001)))).toBe("bad-request");
    expect(refusal(doc, "nome", text("\ud800 broken"))).toBe("bad-request");
    expect(refusal(doc, "privacy", state("Yes"))).toBe("bad-request");
    expect(refusal(doc, "privacy", text("Si"))).toBe("bad-request");
    expect(refusal(doc, "citta", choice("Napoli"))).toBe("bad-request");
    expect(refusal(doc, "citta", text("Napoli"))).toBe("bad-request"); // not editable
    expect(refusal(doc, "lingua", choice("English", "Deutsch"))).toBe("bad-request"); // single select
    expect(refusal(doc, "interessi", choice("Arte", "Arte"))).toBe("bad-request");
    expect(refusal(doc, "interessi", { kind: "choice", values: "Arte" })).toBe("bad-request");
    expect(planFieldEdit(mupdf, doc, "nome", text(""))).toBeNull();
    expect(planFieldEdit(mupdf, doc, "privacy", state("Off"))).toBeNull();
    expect(planFieldEdit(mupdf, doc, "interessi", choice())).toBeNull();
    fill(doc, "nome", text("Mario"));
    expect(planFieldEdit(mupdf, doc, "nome", text("Mario"))).toBeNull();
    // Nothing was written by the refusals: MuPDF itself would have taken them all.
    expect(field(doc, "codice").value).toBe("ABC123");
    expect(inheritedOf(obj(doc, "invia"), "V").isNull()).toBe(true);
    expect(inheritedOf(obj(doc, "firma"), "V").isNull()).toBe(true);
  });

  it("text is cleaned: controls go, a single line has no line breaks", () => {
    const doc = openBytes(buildForm());
    expect(planFieldEdit(mupdf, doc, "nome", text("Ma\trio\r\nRossi\u0007"))!.value).toEqual(text("Ma rio Rossi"));
    expect(planFieldEdit(mupdf, doc, "note", text("uno\r\ndue\rtre\u001b"))!.value).toEqual(text("uno\ndue\ntre"));
  });

  it("same-named fields of different types conflict", () => {
    const doc = openBytes(formOf([
      { FT: "Tx", T: "(dato)", Rect: [20, 20, 120, 40] },
      { FT: "Btn", T: "(dato)", Rect: [200, 20, 214, 34] },
    ]));
    expect(fieldsOf(doc).map((f) => f.locked)).toEqual(["conflict", "conflict"]);
    expect(refusal(doc, "dato", text("x"))).toBe("not-editable");
    expect(formInfo(mupdf, doc)).toMatchObject({ fieldsPerPage: [2], fields: 0, required: 0 });
  });

  it("a field's lock and required flag are those of all the widgets with its name, as planFieldEdit sees them", () => {
    // Two dictionaries named "data": one of them read-only. Two named "nome": one required.
    const doc = openBytes(formOf([
      { FT: "Tx", T: "(data)", DA: "(/Helv 10 Tf 0 g)", Rect: [20, 340, 220, 357] },
      { FT: "Tx", T: "(data)", Ff: 1, DA: "(/Helv 10 Tf 0 g)", Rect: [20, 300, 220, 317] },
      { FT: "Tx", T: "(nome)", DA: "(/Helv 10 Tf 0 g)", Rect: [240, 340, 440, 357] },
      { FT: "Tx", T: "(nome)", Ff: 2, DA: "(/Helv 10 Tf 0 g)", Rect: [240, 300, 440, 317] },
    ]));
    expect(fieldsOf(doc).map((f) => [f.name, f.locked, f.required])).toEqual([
      ["data", "read-only", false], ["data", "read-only", false], ["nome", null, true], ["nome", null, true],
    ]);
    expect(refusal(doc, "data", text("1/1/2026"))).toBe("not-editable");
    expect(formInfo(mupdf, doc)).toMatchObject({ fieldsPerPage: [4], fields: 1, required: 1 });
  });

  it("a comb takes MaxLen characters at most, exactly that many fits", () => {
    const doc = openBytes(buildForm());
    expect(refusal(doc, "cf", text("RSSMRA80A01H501UX"))).toBe("bad-request");
    const r = fill(doc, "cf", text("RSSMRA80A01H501U"))!;
    expect(r.overflow).toBe(false);
    expect(field(doc, "cf").value).toBe("RSSMRA80A01H501U");
    expect(drawn(glyphs(doc, "cf"))).toBe("RSSMRA80A01H501U");
    expect(outside(doc, "cf")).toBe(0);
  });
});

describe("text values", () => {
  it("WinAnsi: MuPDF's own drawing, kept after saving and opening again", () => {
    const doc = openBytes(buildForm());
    const value = "Città: Forlì – 1.234,56 € «ok» \\(x\\)";
    const r = fill(doc, "nome", text(value))!;
    expect(r).toMatchObject({ missingChars: [], overflow: false, edit: { kind: "field", name: "nome", type: "text", pageIndex: 0, pages: [0] } });
    expect(isWinAnsi(value)).toBe(true);
    const o = obj(doc, "nome");
    expect(apContent(o)).toMatch(/\/Helv 10 Tf/);
    expect(apFonts(o).map((f) => f.base)).toEqual(["Helvetica"]);
    expect(drawn(glyphs(doc, "nome")).replace(/ /g, "")).toBe(value.replace(/ /g, ""));
    const again = reopen(doc);
    expect(field(again, "nome").value).toBe(value);
    expect(fullName(obj(again, "nome"))).toBe("nome");
  });

  for (const [script, value] of [
    ["Polish", "Zażółć gęślą jaźń"], ["Romanian", "Ștefan Țara"], ["Greek", "Καλημέρα κόσμε"],
    ["Cyrillic", "Привет мир"], ["CJK", "東京 你好"], ["Czech, centred", "Příliš žluťoučký kůň"],
  ] as const) {
    it(`${script}: the app's writer, every glyph inside the box, embedded, no .notdef`, () => {
      const doc = openBytes(buildForm());
      const r = fill(doc, "nome", text(value))!;
      expect(r.missingChars).toEqual([]);
      const g = glyphs(doc, "nome");
      expect(drawn(g)).toBe(value);
      expect(g.every((x) => x.gid > 0)).toBe(true);
      expect(outside(doc, "nome")).toBe(0);
      // Size 10 as the DA says, baseline where MuPDF puts WinAnsi text: (h - 0.6 s) / 2 above the bottom.
      expect(g[0].size).toBeCloseTo(10, 3);
      expect(g[0].y).toBeCloseTo(842 - 795 - (17 - 6) / 2, 2);
      expect(apFonts(obj(doc, "nome")).every((f) => f.embedded)).toBe(true);
      const again = reopen(doc);
      expect(field(again, "nome").value).toBe(value);
      expect(drawn(glyphs(again, "nome"))).toBe(value);
    });
  }

  it("the appearance font is the subset object after saving, and still draws", () => {
    const doc = openBytes(buildForm());
    fill(doc, "nome", text("Łukasz Ștefan"));
    const whole = apFonts(obj(doc, "nome"))[0].bytes;
    expect(whole).toBeGreaterThan(20_000);
    const saved = openBytes(savePdf(mupdf, doc).bytes);
    const font = apFonts(obj(saved, "nome"))[0];
    expect(font.embedded).toBe(true);
    expect(font.bytes).toBeLessThan(whole / 4);
    expect(drawn(glyphs(saved, "nome"))).toBe("Łukasz Ștefan");
  });

  it("emoji and Hebrew: listed as missing, kept in the value, left out of the drawing", () => {
    const doc = openBytes(buildForm());
    const r = fill(doc, "nome", text("OK 👍 שלום ż"))!;
    expect(r.missingChars).toEqual(["👍", "ש", "ל", "ו", "ם"]);
    expect(field(doc, "nome").value).toBe("OK 👍 שלום ż");
    expect(drawn(glyphs(doc, "nome")).replace(/ /g, "")).toBe("OKż");
    expect(field(reopen(doc), "nome").value).toBe("OK 👍 שלום ż");
  });

  it("multi-line: wrapped inside the box; too much text says overflow", () => {
    const doc = openBytes(buildForm());
    const r = fill(doc, "note", text("Riga uno: Łódź\nRiga due, più lunga di quanto stia in una riga sola del campo, ż"))!;
    expect(r.overflow).toBe(false);
    expect(outside(doc, "note")).toBe(0);
    const lines = new Set(glyphs(doc, "note").map((g) => Math.round(g.y)));
    expect(lines.size).toBe(3);
    const long = fill(doc, "note", text(Array.from({ length: 12 }, (_, i) => `riga ${i + 1}`).join("\n")))!;
    expect(long.overflow).toBe(true);
    // The same through MuPDF's drawing (WinAnsi): overflow measured the same way.
    expect(fill(doc, "note", text(Array.from({ length: 12 }, (_, i) => `Riga ${i + 1}`).join("\n")))!.overflow).toBe(true);
    expect(fill(doc, "note", text("Due righe\ncorte"))!.overflow).toBe(false);
    expect(fill(doc, "nome", text("x".repeat(80)))!.overflow).toBe(true); // a fixed size of 10 pt
  });

  it("from the writer back to MuPDF's drawing: no stale fonts in the appearance", () => {
    const doc = openBytes(buildForm());
    fill(doc, "nome", text("Łukasz"));
    fill(doc, "nome", text("Luca"));
    expect(apFonts(obj(doc, "nome")).map((f) => f.base)).toEqual(["Helvetica"]);
    expect(drawn(glyphs(doc, "nome"))).toBe("Luca");
  });

  it("a rich-text value (/RV) goes: plain /V is what is drawn", () => {
    const doc = openBytes(formOf([{ FT: "Tx", T: "(ricco)", Ff: 1 << 25, DA: "(/Helv 10 Tf 0 g)", V: "(vecchio)", RV: "(<body><p>vecchio</p></body>)", Rect: [20, 20, 220, 40] }]));
    fill(doc, "ricco", text("nuovo ż"));
    expect(obj(doc, "ricco").get("RV").isNull()).toBe(true);
    expect(drawn(glyphs(doc, "ricco"))).toBe("nuovo ż");
  });

  it("decomposed accents are composed and format characters dropped: MuPDF's drawing, nothing missing", () => {
    const doc = openBytes(buildForm());
    const r = fill(doc, "nome", text("Forli\u0300 Citta\u0300"))!; // as macOS pastes it (NFD)
    expect(r.edit.value).toEqual(text("Forlì Città"));
    expect(r.missingChars).toEqual([]);
    expect(drawn(glyphs(doc, "nome")).replace(/ /g, "")).toBe("ForlìCittà");
    expect(apFonts(obj(doc, "nome")).map((f) => f.base)).toEqual(["Helvetica"]);
    expect(planFieldEdit(mupdf, doc, "nome", text("\ufeffMa\u200brio\u2060"))!.value).toEqual(text("Mario"));
    // MaxLen counts the composed characters.
    expect(fill(doc, "cf", text("Ü".normalize("NFD").repeat(16)))!.edit.value).toEqual(text("Ü".repeat(16)));
    // A value another tool wrote decomposed is drawn composed; its /V stays as it was.
    const na = openBytes(formOf([
      { FT: "Tx", T: "(a)", DA: "(/Helv 10 Tf 0 g)", Rect: [20, 340, 220, 357] },
      { FT: "Tx", T: "(b)", DA: "(/Helv 10 Tf 0 g)", Rect: [20, 300, 220, 317] },
    ], { acro: { NeedAppearances: true } }));
    obj(na, "b").put("V", na.newString("Forli\u0300\u200b"));
    expect(fill(na, "a", text("Mario"))!.missingChars).toEqual([]);
    expect(drawn(glyphs(na, "b"))).toBe("Forlì");
    expect(obj(na, "b").get("V").asString()).toBe("Forli\u0300\u200b");
  });

  it("ZWNJ, ZWJ, LRM and RLM stay in the value; they are left out of the drawing and are never missing", () => {
    const doc = openBytes(buildForm());
    // German: a ZWNJ keeps f and l apart (no ligature). Without it the text is WinAnsi: MuPDF's drawing.
    const r = fill(doc, "nome", text("Auf\u200clage"))!;
    expect(r.edit.value).toEqual(text("Auf\u200clage"));
    expect(r.missingChars).toEqual([]);
    expect(field(doc, "nome").value).toBe("Auf\u200clage");
    expect(drawn(glyphs(doc, "nome"))).toBe("Auflage");
    expect(apFonts(obj(doc, "nome")).map((f) => f.base)).toEqual(["Helvetica"]);
    expect(field(reopen(doc), "nome").value).toBe("Auf\u200clage");
    expect(planFieldEdit(mupdf, doc, "nome", text("Auf\u200clage"))).toBeNull();
    // Persian (a ZWNJ inside a word), Hebrew after an RLM, an emoji family (ZWJ), Polish after an
    // LRM (the app's writer).
    for (const value of ["\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645", "\u200f\u05e9\u05dc\u05d5\u05dd 123", "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}", "\u200e\u0141\u00f3d\u017a"]) {
      const s = fill(doc, "nome", text(value))!;
      expect(s.edit.value).toEqual(text(value));
      expect(field(doc, "nome").value).toBe(value);
      expect(s.missingChars.filter((ch) => /[\u200c-\u200f]/.test(ch))).toEqual([]);
      expect(drawn(glyphs(doc, "nome"))).not.toMatch(/[\u200c-\u200f]/);
      expect(outside(doc, "nome")).toBe(0);
    }
    expect(drawn(glyphs(doc, "nome"))).toBe("\u0141\u00f3d\u017a");
    // Zero-width spaces, word joiners and BOMs still go; MaxLen counts the marks that stay.
    expect(planFieldEdit(mupdf, doc, "nome", text("\ufeffMa\u200brio\u2060 Ro\u200dssi"))!.value).toEqual(text("Mario Ro\u200dssi"));
    expect(refusal(doc, "cf", text("RSSMRA80A01H501\u200cU"))).toBe("bad-request");
    // A value another tool wrote with them is drawn without them; its /V stays.
    const na = openBytes(formOf([
      { FT: "Tx", T: "(a)", DA: "(/Helv 10 Tf 0 g)", Rect: [20, 340, 220, 357] },
      { FT: "Tx", T: "(b)", DA: "(/Helv 10 Tf 0 g)", Rect: [20, 300, 220, 317] },
    ], { acro: { NeedAppearances: true } }));
    obj(na, "b").put("V", na.newString("\u200fAuf\u200clage"));
    expect(fill(na, "a", text("Mario"))!.missingChars).toEqual([]);
    expect(drawn(glyphs(na, "b"))).toBe("Auflage");
    expect(obj(na, "b").get("V").asString()).toBe("\u200fAuf\u200clage");
  });

  it("values with CR line breaks (Acrobat's) keep them: drawn on their lines, /V as it was", () => {
    const doc = openBytes(formOf([
      { FT: "Tx", T: "(a)", DA: "(/Helv 10 Tf 0 g)", Rect: [20, 340, 220, 357] },
      { FT: "Tx", T: "(note)", Ff: TX_MULTI, DA: "(/Helv 10 Tf 0 g)", Rect: [20, 200, 220, 300] },
      { FT: "Tx", T: "(nota)", Ff: TX_MULTI, DA: "(/Helv 10 Tf 0 g)", Rect: [240, 200, 440, 300] },
      { FT: "Tx", T: "(riga)", DA: "(/Helv 10 Tf 0 g)", Rect: [240, 340, 440, 357] },
    ], { acro: { NeedAppearances: true }, pageSize: [0, 0, 460, 400] }));
    obj(doc, "note").put("V", doc.newString("Riga uno\rRiga due\r\nRiga tre"));
    obj(doc, "nota").put("V", doc.newString("Łódź\rKraków"));
    obj(doc, "riga").put("V", doc.newString("uno\rdue"));
    const r = fill(doc, "a", text("Mario"))!;
    expect(r).toMatchObject({ missingChars: [], overflow: false });
    const lines = (name: string) => new Set(glyphs(doc, name).map((g) => Math.round(g.y))).size;
    expect([lines("note"), lines("nota"), lines("riga")]).toEqual([3, 2, 1]);
    expect(apContent(obj(doc, "note"))).not.toMatch(/FPE/); // WinAnsi: MuPDF's own drawing
    expect(drawn(glyphs(doc, "nota"))).toBe("ŁódźKraków");
    expect(drawn(glyphs(doc, "riga")).replace(/ /g, "")).toBe("unodue"); // a single line
    expect(obj(doc, "note").get("V").asString()).toBe("Riga uno\rRiga due\r\nRiga tre");
  });

  it("an in-place rewrite of the appearance shows in the next render", () => {
    const doc = openBytes(fixture("reportlab-form.pdf"));
    const nome = fieldsOf(doc).find((f) => f.type === "text")!;
    const before = ink(doc, nome.rect);
    fill(doc, nome.name, text("Łukasz Ștefan Wiśniewski"));
    const after = ink(doc, nome.rect);
    expect(after).toBeGreaterThan(before + 50);
    fill(doc, nome.name, text("Ż"));
    expect(ink(doc, nome.rect)).toBeLessThan(after);
  });
});

describe("the writer lays out as MuPDF", () => {
  // A character no font has forces the writer and draws nothing, so the writer's glyphs for the
  // rest of the text must sit where MuPDF puts the same WinAnsi text (so a field does not jump
  // when "Mario" becomes "Łukasz").
  const CASES: [string, Record<string, unknown>, string][] = [
    ["h17 s10", { Rect: [50, 300, 250, 317], DA: "(/Helv 10 Tf 0 g)" }, "Mario Rossi"],
    ["h17 auto", { Rect: [50, 300, 250, 317], DA: "(/Helv 0 Tf 0 g)" }, "Mario Rossi"],
    ["h17 auto long", { Rect: [50, 300, 110, 317], DA: "(/Helv 0 Tf 0 g)" }, "Mario Rossi della Valle"],
    ["h30 bw2 auto", { Rect: [50, 300, 250, 330], DA: "(/Helv 0 Tf 0 g)", BS: { W: 2 }, MK: { BC: [1, 0, 0], BG: [1, 1, 0.8] } }, "Mario"],
    ["Q1", { Rect: [50, 300, 250, 317], DA: "(/Helv 10 Tf 0 g)", Q: 1 }, "Mario"],
    ["Q2", { Rect: [50, 300, 250, 317], DA: "(/Helv 10 Tf 0 g)", Q: 2 }, "Mario"],
    ["TiRo", { Rect: [50, 300, 250, 317], DA: "(/TiRo 11 Tf 0 0 1 rg)" }, "Mario Rossi"],
    ["Cour", { Rect: [50, 300, 250, 317], DA: "(/Cour 9 Tf 0 g)" }, "Mario Rossi"],
    ["multi s10", { Rect: [50, 300, 130, 340], DA: "(/Helv 10 Tf 0 g)", Ff: TX_MULTI }, "one two three four five six"],
    ["multi auto", { Rect: [50, 300, 130, 360], DA: "(/Helv 0 Tf 0 g)", Ff: TX_MULTI }, "one two three four five six"],
    ["multi Q1", { Rect: [50, 300, 130, 360], DA: "(/Helv 10 Tf 0 g)", Ff: TX_MULTI, Q: 1 }, "one two three four five six"],
    ["multi Q2", { Rect: [50, 300, 130, 360], DA: "(/Helv 10 Tf 0 g)", Ff: TX_MULTI, Q: 2 }, "one two three four five six"],
    ["multi spaces", { Rect: [50, 300, 130, 360], DA: "(/Helv 10 Tf 0 g)", Ff: TX_MULTI }, "one  two   three four  five six"],
    ["multi long word", { Rect: [50, 300, 130, 360], DA: "(/Helv 10 Tf 0 g)", Ff: TX_MULTI }, "a supercalifragilistic word"],
    ["multi breaks", { Rect: [50, 300, 130, 360], DA: "(/Helv 10 Tf 0 g)", Ff: TX_MULTI }, "one\ntwo\n\nthree"],
    ["comb s10", { Rect: [50, 300, 150, 317], DA: "(/Helv 10 Tf 0 g)", Ff: TX_COMB, MaxLen: 6 }, "AB12"],
    ["comb auto", { Rect: [50, 300, 150, 317], DA: "(/Helv 0 Tf 0 g)", Ff: TX_COMB, MaxLen: 6, MK: { BC: [0, 0, 1] } }, "AB12"],
    // Multi-line boxes about one line tall: MuPDF keeps the first baseline 0.2 size above the
    // bottom (inside the padding), not a line below the top.
    ["multi h12 s10", { Rect: [50, 300, 250, 312], DA: "(/Helv 10 Tf 0 g)", Ff: TX_MULTI }, "Stefan Tara Lodz"],
    ["multi h12 s12", { Rect: [50, 300, 250, 312], DA: "(/Helv 12 Tf 0 g)", Ff: TX_MULTI }, "Stefan Tara Lodz"],
    ["multi h14 s12", { Rect: [50, 300, 250, 314], DA: "(/Helv 12 Tf 0 g)", Ff: TX_MULTI, MK: { BC: [0, 0, 0] } }, "Stefan Tara Lodz"],
    ["multi h14 auto", { Rect: [50, 300, 250, 314], DA: "(/Helv 0 Tf 0 g)", Ff: TX_MULTI }, "Stefan Tara Lodz"],
    ["multi h16 s10", { Rect: [50, 300, 250, 316], DA: "(/Helv 10 Tf 0 g)", Ff: TX_MULTI }, "Stefan Tara Lodz"],
    ["multi h16 auto Q1", { Rect: [50, 300, 250, 316], DA: "(/Helv 0 Tf 0 g)", Ff: TX_MULTI, Q: 1 }, "Stefan Tara Lodz"],
    ["multi h14 bw2", { Rect: [50, 300, 250, 314], DA: "(/Helv 10 Tf 0 g)", Ff: TX_MULTI, BS: { W: 2 }, MK: { BC: [1, 0, 0] } }, "Mario"],
    ["multi h12 s12 wrapped", { Rect: [50, 300, 110, 312], DA: "(/Helv 12 Tf 0 g)", Ff: TX_MULTI }, "one two three"],
  ];
  for (const [label, def, value] of CASES) {
    it(label, () => {
      const mu = openBytes(formOf([{ FT: "Tx", T: "(f)", ...def }]));
      fill(mu, "f", text(value));
      const ours = openBytes(formOf([{ FT: "Tx", T: "(f)", ...def }]));
      const r = fill(ours, "f", text(value + "👍"))!;
      expect(r.missingChars).toEqual(["👍"]);
      const a = glyphs(mu, "f"), b = glyphs(ours, "f");
      expect(a.length).toBeGreaterThan(0);
      expect(b.map((g) => g.uni)).toEqual(a.map((g) => g.uni));
      expect(apContent(obj(ours, "f"))).toMatch(/\/FPE1 [\d.]+ Tf <[0-9a-f]+> Tj/); // the writer's, not MuPDF's
      expect(apContent(obj(mu, "f"))).not.toMatch(/FPE1/);
      for (let i = 0; i < a.length; i++) {
        expect(Math.abs(a[i].x - b[i].x), `${label} glyph ${i} x`).toBeLessThan(0.01);
        expect(Math.abs(a[i].y - b[i].y), `${label} glyph ${i} y`).toBeLessThan(0.01);
        expect(Math.abs(a[i].size - b[i].size), `${label} glyph ${i} size`).toBeLessThan(0.01);
      }
      // The frame stays: background, border and comb dividers drawn alike.
      expect(ink(ours, [40, 70, 260, 110], 0, (r, g, b) => Math.abs(r - g) > 40 || Math.abs(g - b) > 40))
        .toBe(ink(mu, [40, 70, 260, 110], 0, (r, g, b) => Math.abs(r - g) > 40 || Math.abs(g - b) > 40));
    });
  }

  it("short multi-line fields: Polish and Romanian sit inside the box, where MuPDF puts Latin text, and fit", () => {
    for (const [h, size] of [[12, 10], [12, 0], [14, 12], [14, 0], [16, 10], [16, 0]]) {
      const def = { FT: "Tx", T: "(f)", Ff: TX_MULTI, DA: `(/Helv ${size} Tf 0 g)`, Rect: [50, 300, 250, 300 + h] };
      const latin = openBytes(formOf([def])), other = openBytes(formOf([def]));
      expect(fill(latin, "f", text("Stefan Tara Lodz"))!.overflow, `h${h} s${size} MuPDF`).toBe(false);
      expect(fill(other, "f", text("Ștefan Țara Łódź"))!.overflow, `h${h} s${size} writer`).toBe(false);
      expect(apContent(obj(other, "f"))).toMatch(/FPE1/);
      expect(outside(latin, "f") + outside(other, "f"), `h${h} s${size}`).toBe(0);
      expect(glyphs(other, "f")[0].y).toBeCloseTo(glyphs(latin, "f")[0].y, 2);
    }
    // Two lines in a box one line tall: the second is below it.
    const short = openBytes(formOf([{ FT: "Tx", T: "(f)", Ff: TX_MULTI, DA: "(/Helv 12 Tf 0 g)", Rect: [50, 300, 250, 314] }]));
    expect(fill(short, "f", text("Riga uno\nRiga due"))!.overflow).toBe(true);
  });

  // A list box: MuPDF draws its options as multi-line text, aligned by /Q (the writer draws the
  // rows, and the selected ones' highlight, at the same places).
  for (const [label, def] of [
    ["list Q0", {}], ["list Q1", { Q: 1 }], ["list Q2", { Q: 2 }], ["list auto Q2", { Q: 2, DA: "(/Helv 0 Tf 0 g)" }],
    ["list bw2 Q1", { Q: 1, BS: { W: 2 }, MK: { BC: [0, 0, 1] } }], ["list short Q1", { Q: 1, Rect: [50, 300, 200, 312] }],
  ] as [string, Record<string, unknown>][]) {
    it(label, () => {
      const make = () => openBytes(formOf([{ FT: "Ch", T: "(l)", Ff: CH_MULTI, DA: "(/Helv 10 Tf 0 g)", Rect: [50, 300, 200, 360], Opt: ["(Sport)", "(Musica)", "(Arte)", "(Cucina)", "(Viaggi)", "(Lettura)", "(Cinema)"], ...def }]));
      const mu = make();
      onWidgets(mu, 0, "l", (w) => {
        w.setChoiceValue("Sport");
        w.update();
      });
      const ours = make();
      fill(ours, "l", choice("Sport"));
      const a = glyphs(mu, "l"), b = glyphs(ours, "l");
      expect(b.length).toBeGreaterThan(0);
      // The writer leaves out the rows far below the box; MuPDF draws them all.
      expect(b.map((g) => g.uni)).toEqual(a.slice(0, b.length).map((g) => g.uni));
      for (let i = 0; i < b.length; i++) {
        expect(Math.abs(a[i].x - b[i].x), `${label} glyph ${i} x`).toBeLessThan(0.01);
        expect(Math.abs(a[i].y - b[i].y), `${label} glyph ${i} y`).toBeLessThan(0.01);
      }
    });
  }
});

describe("check boxes and radio buttons", () => {
  it("a check box with export value Si, on and off", () => {
    const doc = openBytes(buildForm());
    fill(doc, "privacy", state("Si"));
    expect(field(doc, "privacy").value).toBe("Si");
    expect(obj(doc, "privacy").get("AS").asName()).toBe("Si");
    fill(doc, "privacy", state("Off"));
    expect(obj(doc, "privacy").get("AS").asName()).toBe("Off");
    expect(field(reopen(doc), "privacy").value).toBe("Off");
  });

  it("radio with NoToggleToOff: exactly one widget on, and another choice works", () => {
    const doc = openBytes(buildForm());
    const as = (d: mupdf.PDFDocument) => onWidgets(d, 0, "sesso", (w) => w.getObject().get("AS").asName());
    fill(doc, "sesso", state("F"));
    expect(as(doc)).toEqual(["Off", "F", "Off"]);
    expect(fieldsOf(doc).filter((f) => f.name === "sesso").map((f) => f.value)).toEqual(["F", "F", "F"]);
    fill(doc, "sesso", state("X"));
    expect(as(doc)).toEqual(["Off", "Off", "X"]);
    expect(as(reopen(doc))).toEqual(["Off", "Off", "X"]);
    // One on, two off, as rendered: only the third circle is drawn.
    const ring = (i: number) => ink(doc, [150 + 50 * i, 842 - 584, 164 + 50 * i, 842 - 570]);
    expect([ring(0) === 0, ring(1) === 0, ring(2) > 0]).toEqual([true, true, true]);
  });

  it("a wrong /AS everywhere (the toggle bug) is not a no-op: it gets fixed", () => {
    const doc = openBytes(buildForm());
    onWidgets(doc, 0, "sesso", (w) => w.getObject().put("AS", doc.newName(onState(w.getObject()))));
    obj(doc, "sesso").get("Parent").put("V", doc.newName("F"));
    expect(planFieldEdit(mupdf, doc, "sesso", state("F"))).not.toBeNull();
    fill(doc, "sesso", state("F"));
    expect(onWidgets(doc, 0, "sesso", (w) => w.getObject().get("AS").asName())).toEqual(["Off", "F", "Off"]);
  });

  it("RadiosInUnison, same-named check boxes, a radio group with /Opt", () => {
    const doc = keep(new mupdf.PDFDocument());
    doc.insertPage(-1, doc.addPage([0, 0, 400, 400], 0, {}, ""));
    const pg = doc.findPage(0);
    const annots = doc.newArray();
    pg.put("Annots", annots);
    const fields = doc.newArray();
    const on = () => doc.addStream("0 g 2 2 10 10 re f", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 14, 14] });
    const group = (t: string, ff: number, states: string[], extra: Record<string, unknown> = {}) => {
      const parent = doc.addObject({ FT: "Btn", T: `(${t})`, Ff: ff, V: "Off", Kids: [], ...extra });
      fields.push(parent);
      states.forEach((s, i) => {
        const x = doc.addObject({ Type: "Annot", Subtype: "Widget", F: 4, P: pg, Parent: parent, AS: "Off", AP: { N: { [s]: on(), Off: on() } }, Rect: [20 + 30 * i, 300, 34 + 30 * i, 314] });
        annots.push(x);
        parent.get("Kids").push(x);
      });
    };
    group("unison", BTN_RADIO | BTN_UNISON, ["A", "B", "A"]);
    group("lingue", 0, ["IT", "EN"]);
    group("scelta", BTN_RADIO, ["0", "1", "2"], { Opt: ["(Roma)", "(Milano)", "(Napoli)"] });
    doc.getTrailer().get("Root").put("AcroForm", doc.addObject({ Fields: fields }));
    const as = (name: string) => onWidgets(doc, 0, name, (w) => w.getObject().get("AS").asName());
    fill(doc, "unison", state("A"));
    expect(as("unison")).toEqual(["A", "Off", "A"]);
    expect(fieldsOf(doc).filter((f) => f.name === "lingue").map((f) => f.type)).toEqual(["checkbox", "checkbox"]);
    fill(doc, "lingue", state("EN"));
    expect(as("lingue")).toEqual(["Off", "EN"]);
    fill(doc, "lingue", state("IT"));
    expect(as("lingue")).toEqual(["IT", "Off"]);
    const scelta = fieldsOf(doc).filter((f) => f.name === "scelta");
    expect(scelta[0].options).toEqual([{ label: "Roma", value: "0" }, { label: "Milano", value: "1" }, { label: "Napoli", value: "2" }]);
    fill(doc, "scelta", state("1"));
    expect(as("scelta")).toEqual(["Off", "1", "Off"]);
  });

  it("a check box without appearances gets states, in the saved file too", () => {
    const doc = openBytes(formOf([{ FT: "Btn", T: "(cb)", Rect: [20, 20, 34, 34], DA: "(/ZaDb 0 Tf 0 0 1 rg)", MK: { CA: "(4)", BC: [0, 0, 0] } }]));
    expect(field(doc, "cb")).toMatchObject({ value: "Off", onState: "Yes" });
    fill(doc, "cb", state("Yes"));
    const saved = openBytes(savePdf(mupdf, doc).bytes);
    const o = obj(saved, "cb");
    const states: string[] = [];
    o.get("AP", "N").forEach((_v, k) => states.push(String(k)));
    expect(states.sort()).toEqual(["Off", "Yes"]);
    expect(o.get("AS").asName()).toBe("Yes");
    // The tick is drawn with an embedded font (the subset of ZapfDingbats).
    const tickFonts = o.get("AP", "N", "Yes", "Resources", "Font");
    let embedded = 0;
    tickFonts.forEach((f) => { if (f.get("DescendantFonts", 0, "FontDescriptor", "FontFile2").isStream() || f.get("DescendantFonts", 0, "FontDescriptor", "FontFile3").isStream() || f.get("DescendantFonts", 0, "FontDescriptor", "FontFile").isStream()) embedded++; });
    expect(embedded).toBe(1);
    expect(ink(saved, [20, 400 - 34, 34, 400 - 20], 0, (r, g, b) => b > 150 && r < 100 && g < 100)).toBeGreaterThan(10); // the blue tick
    fill(saved, "cb", state("Off"));
    expect(ink(saved, [21, 400 - 33, 33, 400 - 21], 0, (r, g, b) => b > 150 && r < 100 && g < 100)).toBe(0);
  });

  it("radio buttons without appearance states: each its own on state, never the group's value", () => {
    for (const [needAppearances, opt] of [[false, false], [true, false], [false, true]]) {
      const doc = openBytes(radioGroup(["Off", "B", "Off"], { V: "B", needAppearances, opt }));
      const radios = () => fieldsOf(doc).filter((f) => f.name === "r");
      const as = (d = doc) => onWidgets(d, 0, "r", (w) => w.getObject().get("AS").asName());
      const dots = () => [20, 60, 100].map((x) => ink(doc, [x + 3, 400 - 311, x + 11, 400 - 303]) > 0);
      // The button that is on keeps its state; the others take their place among the kids.
      expect(radios().map((f) => [f.onState, f.value, f.locked])).toEqual([["0", "B", null], ["B", "B", null], ["2", "B", null]]);
      if (opt) expect(radios()[0].options).toEqual([{ label: "Alfa", value: "0" }, { label: "Beta", value: "B" }, { label: "Gamma", value: "2" }]);
      if (needAppearances) {
        // The first edit of another field gives the group its appearances: still one button on.
        fill(doc, "a", text("Mario"));
        expect(as()).toEqual(["Off", "B", "Off"]);
        expect(dots()).toEqual([false, true, false]);
      }
      fill(doc, "r", state("0"));
      expect(as()).toEqual(["0", "Off", "Off"]);
      expect(dots()).toEqual([true, false, false]);
      fill(doc, "r", state("2"));
      expect(as()).toEqual(["Off", "Off", "2"]);
      expect(radios().map((f) => [f.onState, f.value])).toEqual([["0", "2"], ["B", "2"], ["2", "2"]]);
      expect(as(reopen(doc))).toEqual(["Off", "Off", "2"]);
      expect(dots()).toEqual([false, false, true]);
    }
    const onStates = (bytes: Uint8Array) => fieldsOf(openBytes(bytes)).filter((f) => f.name === "r").map((f) => f.onState);
    // Every button off: their places.
    expect(onStates(radioGroup(["Off", "Off", "Off"], { V: "Off" }))).toEqual(["0", "1", "2"]);
    // The toggle bug left two buttons on with one state: the first keeps it, the other its place.
    expect(onStates(radioGroup(["B", "B", "Off"], { V: "B" }))).toEqual(["B", "1", "2"]);
  });

  it("radio buttons whose states cannot be told apart are locked, never filled", () => {
    // The second button is on as "0", the first one's place: no state of its own for the first.
    const doc = openBytes(radioGroup(["Off", "0", "Off"], { V: "0", needAppearances: true }));
    expect(fieldsOf(doc).filter((f) => f.name === "r").map((f) => f.locked)).toEqual(["conflict", "conflict", "conflict"]);
    expect(refusal(doc, "r", state("0"))).toBe("not-editable");
    // A NeedAppearances settle leaves the group as it is.
    fill(doc, "a", text("Mario"));
    expect(onWidgets(doc, 0, "r", (w) => [w.getObject().get("AS").asName(), w.getObject().get("AP").isNull()])).toEqual([["Off", true], ["0", true], ["Off", true]]);
  });

  it("check boxes without appearance states shown twice keep one state (unlike radio buttons)", () => {
    const doc = keep(new mupdf.PDFDocument());
    doc.insertPage(-1, doc.addPage([0, 0, 400, 400], 0, {}, ""));
    const pg = doc.findPage(0);
    const parent = doc.addObject({ FT: "Btn", T: "(ok)", V: "Off", Kids: [] });
    const annots = doc.newArray();
    pg.put("Annots", annots);
    for (const x of [20, 60]) {
      const kid = doc.addObject({ Type: "Annot", Subtype: "Widget", F: 4, P: pg, Parent: parent, AS: "Off", DA: "(/ZaDb 0 Tf 0 g)", Rect: [x, 300, x + 14, 314] });
      parent.get("Kids").push(kid);
      annots.push(kid);
    }
    doc.getTrailer().get("Root").put("AcroForm", doc.addObject({ Fields: [parent] }));
    expect(fieldsOf(doc).map((f) => f.onState)).toEqual(["Yes", "Yes"]);
    fill(doc, "ok", state("Yes"));
    expect(onWidgets(doc, 0, "ok", (w) => w.getObject().get("AS").asName())).toEqual(["Yes", "Yes"]);
  });

  it("state names in Latin-1 (an older producer's /S#EC for Sì): read as Sì, written back with the same bytes", () => {
    for (const [token, latin1] of [["S#EC", true], ["S#C3#AC", false]] as const) {
      const doc = openBytes(latin1Box(token));
      expect(field(doc, "cb")).toMatchObject({ onState: "Sì", value: "Off", locked: null });
      const r = fill(doc, "cb", state("Sì"))!;
      expect(r.edit.value).toEqual(state("Sì"));
      const raw = new TextDecoder("latin1").decode(saveBytes(doc, "decompress"));
      const spelt = latin1 ? "S#EC" : "S#C3#AC";
      expect(raw, token).toMatch(new RegExp(`/AS\\s*/${spelt}\\b`, "i"));
      expect(raw, token).toMatch(new RegExp(`/V\\s*/${spelt}\\b`, "i"));
      expect(ink(doc, [20, 200 - 34, 34, 200 - 20]), token).toBeGreaterThan(50); // the tick shows
      expect(field(reopen(doc), "cb").value).toBe("Sì");
      expect(planFieldEdit(mupdf, doc, "cb", state("Sì"))).toBeNull();
      // A replay on the original writes the same.
      const replay = openBytes(latin1Box(token));
      applyFieldEdit(mupdf, replay, r.edit);
      expect(new TextDecoder("latin1").decode(saveBytes(replay, "decompress")).match(/\/(AS|V)\s*\/[^\s/>]+/g)).toEqual(raw.match(/\/(AS|V)\s*\/[^\s/>]+/g));
      fill(doc, "cb", state("Off"));
      expect(ink(doc, [20, 200 - 34, 34, 200 - 20])).toBe(0);
    }
  });
});

/**
 * A one-page form with a text field "a" and a radio group "r" of three buttons without
 * appearance states (/AS as given), NoToggleToOff, as NeedAppearances or FDF-filled forms have.
 */
function radioGroup(as: string[], { V = "Off", needAppearances = false, opt = false } = {}): Uint8Array {
  const doc = openBytes(formOf([{ FT: "Tx", T: "(a)", DA: "(/Helv 10 Tf 0 g)", Rect: [20, 340, 220, 357] }], { acro: needAppearances ? { NeedAppearances: true } : {} }));
  const page = doc.findPage(0);
  const radio = doc.addObject({ FT: "Btn", T: "(r)", Ff: BTN_RADIO | BTN_NO_TOGGLE, Kids: [] });
  radio.put("V", doc.newName(V));
  if (opt) radio.put("Opt", ["(Alfa)", "(Beta)", "(Gamma)"]);
  as.forEach((s, i) => {
    const w = doc.addObject({ Type: "Annot", Subtype: "Widget", F: PRINT, P: page, Parent: radio, DA: "(/ZaDb 0 Tf 0 g)", MK: { CA: "(l)" }, Rect: [20 + 40 * i, 300, 34 + 40 * i, 314] });
    w.put("AS", doc.newName(s));
    radio.get("Kids").push(w);
    page.get("Annots").push(w);
  });
  doc.getTrailer().get("Root", "AcroForm", "Fields").push(radio);
  return saveBytes(doc);
}

/** A check box whose on state is the name `token` as written in the file (/S#EC: Latin-1 "Sì"). */
function latin1Box(token: string): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R] >> >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Annots [4 0 R] /Contents 7 0 R >>",
    `<< /Type /Annot /Subtype /Widget /FT /Btn /T (cb) /F 4 /Rect [20 20 34 34] /V /Off /AS /Off /AP << /N << /${token} 5 0 R /Off 6 0 R >> >> >>`,
    "<< /Type /XObject /Subtype /Form /BBox [0 0 14 14] /Length 18 >>\nstream\n0 g 2 2 10 10 re f\nendstream",
    "<< /Type /XObject /Subtype /Form /BBox [0 0 14 14] /Length 0 >>\nstream\n\nendstream",
    "<< /Length 0 >>\nstream\n\nendstream",
  ];
  let pdf = "%PDF-1.7\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, "0")} 00000 n \n`).join("")}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

/** A check box or radio widget's on state (its appearance state other than Off). */
function onState(o: mupdf.PDFObject): string {
  let s = "Yes";
  o.get("AP", "N").forEach((_v, k) => { if (String(k) !== "Off") s = String(k); });
  return s;
}

describe("choices", () => {
  it("a combo with export pairs: /V the export value, the appearance its label", () => {
    const doc = openBytes(buildForm());
    fill(doc, "provincia", choice("FC"));
    expect(field(doc, "provincia")).toMatchObject({ value: "FC", displayValue: "Forlì-Cesena" });
    expect(inheritedOf(obj(doc, "provincia"), "V").asString()).toBe("FC");
    expect(drawn(glyphs(doc, "provincia"))).toBe("Forlì-Cesena");
    // A label outside WinAnsi: the writer.
    fill(doc, "provincia", choice("BV"));
    expect(drawn(glyphs(doc, "provincia"))).toBe("Brașov");
    expect(outside(doc, "provincia")).toBe(0);
    // The custom text of an editable combo.
    fill(doc, "provincia", text("Rimini"));
    expect(field(doc, "provincia")).toMatchObject({ value: "Rimini", displayValue: "Rimini" });
    expect(drawn(glyphs(doc, "provincia"))).toBe("Rimini");
    // An option's export value typed in is that option.
    expect(fill(doc, "provincia", text("MI"))!.edit.value).toEqual(choice("MI"));
    expect(drawn(glyphs(doc, "provincia"))).toBe("Milano");
    fill(doc, "provincia", choice());
    expect(field(doc, "provincia").value).toBe("");
    expect(inheritedOf(obj(doc, "provincia"), "V").isNull()).toBe(true);
  });

  it("list boxes: /V, /I, the selected rows highlighted, scrolled into view", () => {
    const doc = openBytes(buildForm());
    const blue = (r: number, _g: number, b: number) => b > 200 && r < 180 && r > 120;
    fill(doc, "lingua", choice("Deutsch"));
    const o = obj(doc, "lingua");
    expect(o.get("V").asString()).toBe("Deutsch");
    expect(o.get("I").length).toBe(1);
    expect(o.get("I").get(0).asNumber()).toBe(2);
    expect(field(doc, "lingua")).toMatchObject({ value: "Deutsch", values: ["Deutsch"] });
    // Rows of 11.16 pt from the top (y 842 - 530 = 312): Deutsch is the third.
    const row = (i: number) => [152, 312 + 2 + 11.16 * i + 1, 298, 312 + 2 + 11.16 * (i + 1) - 1];
    expect(ink(doc, row(2), 0, blue)).toBeGreaterThan(50);
    expect(ink(doc, row(0), 0, blue)).toBe(0);
    fill(doc, "interessi", choice("Cinema", "Sport"));
    const m = obj(doc, "interessi");
    const list = (o: mupdf.PDFObject) => {
      const out: (string | number)[] = [];
      o.forEach((x) => out.push(x.isString() ? x.asString() : x.asNumber()));
      return out;
    };
    expect(list(m.get("V"))).toEqual(["Sport", "Cinema"]);
    expect(list(m.get("I"))).toEqual([0, 6]);
    expect(m.get("TI").isNull()).toBe(true); // Sport, the first selected, is visible from the top
    fill(doc, "interessi", choice("Cinema"));
    expect(m.get("TI").asNumber()).toBeGreaterThan(0); // scrolled so that Cinema shows
    expect(drawn(glyphs(doc, "interessi"))).toContain("Cinema");
    expect(outside(doc, "interessi")).toBe(0);
    fill(doc, "interessi", choice());
    expect(field(doc, "interessi").values).toEqual([]);
    expect(obj(doc, "interessi").get("I").isNull()).toBe(true);
  });
});

describe("what the form does not do here", () => {
  it("JavaScript never runs: document, open action, keystroke, format, calculate", () => {
    const doc = openBytes(buildForm());
    expect(doc.isJSSupported()).toBe(false);
    fill(doc, "importo", text("5000abc")); // a keystroke script would refuse it, a validate script too
    fill(doc, "nome", text("Mario"));
    expect(field(doc, "importo").value).toBe("5000abc");
    expect(field(doc, "totale").value).toBe(""); // never calculated
    expect(field(doc, "nome").value).toBe("Mario");
    expect(field(doc, "note").value).toBe("");
    expect(doc.isJSSupported()).toBe(false);
  });

  it("static XFA: the first field edit removes it (a replay of the original has it)", () => {
    const bytes = buildForm({ xfa: true });
    const doc = openBytes(bytes);
    expect(doc.getTrailer().get("Root", "AcroForm", "XFA").isNull()).toBe(false);
    expect(planFieldEdit(mupdf, doc, "nome", text(""))).toBeNull(); // a no-op changes nothing
    expect(doc.getTrailer().get("Root", "AcroForm", "XFA").isNull()).toBe(false);
    const r = fill(doc, "nome", text("Valore"))!;
    expect(doc.getTrailer().get("Root", "AcroForm", "XFA").isNull()).toBe(true);
    expect(formInfo(mupdf, doc)!.xfa).toBe("none");
    expect(openBytes(bytes).getTrailer().get("Root", "AcroForm", "XFA").isNull()).toBe(false);
    // Replayed on the original: the same.
    const replay = openBytes(bytes);
    applyFieldEdit(mupdf, replay, r.edit);
    expect(replay.getTrailer().get("Root", "AcroForm", "XFA").isNull()).toBe(true);
  });

  it("NeedAppearances: the first field edit gives every field its appearance and the flag goes", () => {
    const doc = openBytes(buildForm({ needAppearances: true }));
    // A value set by another tool, outside WinAnsi, which MuPDF would draw cut off.
    obj(doc, "a.e").put("V", doc.newString("Zażółć gęślą"));
    const r = fill(doc, "nome", text("Ștefan"))!;
    expect(r.edit.pages).toEqual([0, 1]); // every page with a field changes, not only the field's
    expect(doc.getTrailer().get("Root", "AcroForm", "NeedAppearances").isNull()).toBe(true);
    for (const name of ["nome", "a.e"]) expect(outside(doc, name)).toBe(0);
    expect(drawn(glyphs(doc, "a.e"))).toBe("Zażółć gęślą");
    // A page loaded again draws what was written (with the flag, MuPDF would draw its own).
    const again = reopen(doc);
    expect(drawn(glyphs(again, "a.e"))).toBe("Zażółć gęślą");
    expect(outside(again, "a.e")).toBe(0);
    // Every variable-text widget has an appearance; the password its frame only (it is never drawn).
    for (const name of ["note", "cf", "email", "citta", "lingua", "a.b.c"]) expect(apContent(obj(again, name)), name).not.toBe("");
    expect(obj(again, "pin").get("AP", "N").isStream()).toBe(true);
    expect(apContent(obj(again, "pin"))).not.toMatch(/Tj|segreto/);
    // Replayed on the original (undo, redo), the same document.
    const replay = openBytes(buildForm({ needAppearances: true }));
    obj(replay, "a.e").put("V", replay.newString("Zażółć gęślą"));
    applyFieldEdit(mupdf, replay, r.edit);
    expect(fingerprint(replay)).toBe(fingerprint(doc));
  });

  it("NeedAppearances: what other fields cannot show is not reported as the edited field's", () => {
    const doc = openBytes(formOf([
      { FT: "Tx", T: "(a)", DA: "(/Helv 10 Tf 0 g)", Rect: [20, 340, 220, 357] },
      { FT: "Tx", T: "(b)", DA: "(/Helv 10 Tf 0 g)", Rect: [20, 300, 220, 317] },
      { FT: "Tx", T: "(c)", DA: "(/Helv 10 Tf 0 g)", V: `(${"x".repeat(80)})`, Rect: [20, 260, 220, 277] },
    ], { acro: { NeedAppearances: true } }));
    obj(doc, "b").put("V", doc.newString("OK 👍 ok"));
    expect(fill(doc, "a", text("Mario"))).toMatchObject({ missingChars: [], overflow: false });
    // The edited field's own outcome still counts.
    const again = openBytes(formOf([{ FT: "Tx", T: "(a)", DA: "(/Helv 10 Tf 0 g)", Rect: [20, 340, 220, 357] }], { acro: { NeedAppearances: true } }));
    expect(fill(again, "a", text("OK 👍"))!.missingChars).toEqual(["👍"]);
  });
});

describe("password fields", () => {
  const pin = (extra: Record<string, unknown> = {}) => ({ FT: "Tx", T: "(pin)", Ff: TX_PASSWORD, DA: "(/Helv 10 Tf 0 g)", V: "(segreto123)", Rect: [20, 300, 220, 317], ...extra });
  const other = { FT: "Tx", T: "(a)", DA: "(/Helv 10 Tf 0 g)", Rect: [20, 340, 220, 357] };
  /** Dark pixels inside the password box (its border and background are not dark). */
  const shown = (doc: mupdf.PDFDocument) => ink(doc, [22, 400 - 315, 218, 400 - 302]);

  it("a password widget without an appearance gets its frame only: the value is drawn nowhere", () => {
    for (const needAppearances of [false, true]) {
      const doc = openBytes(formOf([pin({ MK: { BC: [0, 0, 1], BG: [1, 1, 0.85] } }), other], { acro: needAppearances ? { NeedAppearances: true } : {} }));
      // MuPDF draws the value of a widget without an appearance in clear (and every widget's, with NeedAppearances).
      expect(shown(doc)).toBeGreaterThan(100);
      expect(planFieldEdit(mupdf, doc, "a", text("Mario"))!.pages).toEqual([0]);
      fill(doc, "a", text("Mario"));
      expect(shown(doc), `NeedAppearances ${needAppearances}`).toBe(0);
      const ap = apContent(obj(doc, "pin"));
      expect(ap).not.toMatch(/Tj|segreto/);
      expect(ap).toMatch(/re\nf\n/); // the background...
      expect(ap).toMatch(/re\ns\n/); // ...and the border
      expect(field(doc, "pin")).toMatchObject({ value: "", locked: "password" });
      expect(inheritedOf(obj(doc, "pin"), "V").asString()).toBe("segreto123"); // the value is not the app's to remove
      const saved = openBytes(savePdf(mupdf, doc).bytes);
      expect(shown(saved)).toBe(0);
      expect(apContent(obj(saved, "pin"))).not.toMatch(/segreto/);
    }
  });

  it("hidePasswords: the pages changed, once; an appearance the widget has is kept", () => {
    const doc = openBytes(formOf([pin(), other]));
    expect(hidePasswords(mupdf, doc)).toEqual([0]);
    expect(shown(doc)).toBe(0);
    const ap = obj(doc, "pin").get("AP", "N");
    expect(hidePasswords(mupdf, doc)).toEqual([]);
    expect(obj(doc, "pin").get("AP", "N").asIndirect()).toBe(ap.asIndirect());
    // Its own appearance (here a mask of dots) stays as it is.
    const own = openBytes(formOf([pin(), other]));
    obj(own, "pin").put("AP", { N: own.addStream("0 g 10 5 4 4 re f\n", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 200, 17] }) });
    expect(hidePasswords(mupdf, own)).toEqual([]);
    fill(own, "a", text("Mario"));
    expect(apContent(obj(own, "pin"))).toBe("0 g 10 5 4 4 re f\n");
    // The edit that hides it reports its page (here a second one), and a replay does the same.
    const two = keep(new mupdf.PDFDocument());
    for (let i = 0; i < 2; i++) two.insertPage(-1, two.addPage([0, 0, 400, 400], 0, {}, ""));
    const fields = two.newArray();
    for (const [i, def] of [[0, other], [1, pin()]] as const) {
      const w = two.addObject({ Type: "Annot", Subtype: "Widget", F: PRINT, P: two.findPage(i), ...def });
      two.findPage(i).put("Annots", [w]);
      fields.push(w);
    }
    two.getTrailer().get("Root").put("AcroForm", two.addObject({ Fields: fields }));
    const original = saveBytes(two);
    const r = fill(two, "a", text("Mario"))!;
    expect(r.edit.pages).toEqual([0, 1]);
    const replay = openBytes(original);
    applyFieldEdit(mupdf, replay, r.edit);
    expect(fingerprint(replay)).toBe(fingerprint(two));
  });
});

/**
 * A long form, as the review's mkbigform.mjs: `pages` pages, each with `per` text fields and one
 * required check box with its own appearance states.
 */
function bigForm(pages: number, per: number): Uint8Array {
  const doc = new mupdf.PDFDocument();
  try {
    const helv = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" });
    const yes = doc.addStream("0 0 1 rg 2 2 12 12 re f", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 16, 16] });
    const off = doc.addStream("", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 16, 16] });
    const fields = doc.newArray();
    for (let p = 0; p < pages; p++) {
      let content = "";
      for (let i = 0; i < per; i++) content += `BT /F1 10 Tf 40 ${800 - i * 36} Td (Campo ${p + 1}.${i + 1}) Tj ET\n`;
      doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { Font: { F1: helv } }, content));
      const page = doc.findPage(p);
      const annots = doc.newArray();
      page.put("Annots", annots);
      for (let i = 0; i < per; i++) {
        const w = doc.addObject({ Type: "Annot", Subtype: "Widget", F: PRINT, P: page, FT: "Tx", T: doc.newString(`p${p + 1}_f${i + 1}`), DA: "(/Helv 10 Tf 0 g)", Rect: [150, 795 - i * 36, 450, 813 - i * 36] });
        annots.push(w);
        fields.push(w);
      }
      const box = doc.addObject({ Type: "Annot", Subtype: "Widget", F: PRINT, P: page, FT: "Btn", Ff: 2, T: doc.newString(`p${p + 1}_ok`), V: "Off", AS: "Off", AP: { N: { Yes: yes, Off: off } }, Rect: [40, 40, 56, 56] });
      annots.push(box);
      fields.push(box);
    }
    doc.getTrailer().get("Root").put("AcroForm", doc.addObject({ Fields: fields, DR: { Font: { Helv: helv } }, DA: "(/Helv 10 Tf 0 g)" }));
    return saveBytes(doc, "compress");
  } finally {
    doc.destroy();
  }
}

describe("fields on several pages", () => {
  it("a 300-page form with 21 fields a page: the whole form read once, each page's fields at the cost of that page", () => {
    const doc = openBytes(bigForm(300, 20));
    const start = performance.now();
    const info = formInfo(mupdf, doc)!; // reads the whole form once
    const scanned = performance.now();
    let listed = 0;
    for (let p = 0; p < doc.countPages(); p++) listed += fieldsOf(doc, p).length;
    const listing = performance.now() - scanned, scan = Math.max(scanned - start, 1);
    expect(info).toMatchObject({ fields: 300 * 21, required: 300, xfa: "none", scripts: false });
    expect(info.fieldsPerPage).toEqual(Array(300).fill(21));
    expect(listed).toBe(300 * 21);
    // Before the index was kept, every page's listing read the whole form again: in the browser,
    // 120-210 ms a page for this form, 43 s in all. Now listing all 300 pages costs about what
    // reading the form once does (about 0.45 s in all in Node). Compared with the scan rather
    // than with a fixed time, so a busy machine cannot make it fail: reading the whole form for
    // every page would cost about 300 scans.
    expect(listing).toBeLessThan(30 * scan);
    // Filling in the last field: one page changed, and its listing shows the value.
    expect(fill(doc, "p300_f20", text("Fine"))!.edit.pages).toEqual([299]);
    expect(field(doc, "p300_f20", 299).value).toBe("Fine");
    expect(field(doc, "p1_ok", 0)).toMatchObject({ type: "checkbox", required: true, locked: null, onState: "Yes" });
  });

  it("the fields are read again after formChanged, after a field edit and when the pages change", () => {
    const doc = openBytes(formOf([
      { FT: "Tx", T: "(a)", DA: "(/Helv 10 Tf 0 g)", Rect: [20, 340, 220, 357] },
      { FT: "Tx", T: "(b)", DA: "(/Helv 10 Tf 0 g)", Rect: [20, 300, 220, 317] },
    ]));
    expect(field(doc, "a").locked).toBeNull();
    expect(formInfo(mupdf, doc)).toMatchObject({ fields: 2 });
    // A change that is no field edit. A widget's own flags are read with its page, and an edit
    // checks the field afresh; what the whole form holds (the counts, the other widgets of a
    // name) is kept until the session says the document changed, after every edit it applies.
    obj(doc, "a").put("Ff", 1);
    expect(field(doc, "a").locked).toBe("read-only");
    expect(refusal(doc, "a", text("x"))).toBe("not-editable");
    expect(formInfo(mupdf, doc)).toMatchObject({ fields: 2 });
    formChanged(doc);
    expect(formInfo(mupdf, doc)).toMatchObject({ fields: 1 });
    // A field edit says so itself.
    obj(doc, "a").put("Ff", 0);
    expect(formInfo(mupdf, doc)).toMatchObject({ fields: 1 });
    fill(doc, "b", text("Mario"));
    expect(formInfo(mupdf, doc)).toMatchObject({ fields: 2 });
    // A page added with a field of its own.
    doc.insertPage(-1, doc.addPage([0, 0, 600, 400], 0, {}, ""));
    const page = doc.findPage(1);
    const w = doc.addObject({ Type: "Annot", Subtype: "Widget", F: PRINT, P: page, FT: "Tx", T: "(c)", Ff: 2, DA: "(/Helv 10 Tf 0 g)", Rect: [20, 340, 220, 357] });
    page.put("Annots", [w]);
    doc.getTrailer().get("Root", "AcroForm", "Fields").push(w);
    expect(fieldsOf(doc, 1).map((f) => [f.name, f.required, f.locked])).toEqual([["c", true, null]]);
    expect(formInfo(mupdf, doc)).toMatchObject({ fieldsPerPage: [2, 1], fields: 3, required: 1 });
  });

  it("one field with widgets on two pages: both drawn, both pages reported", () => {
    const doc = openBytes(buildForm());
    const r = fill(doc, "intestazione", text("ACME S.p.A. – Łódź"))!;
    expect(r.edit).toMatchObject({ pageIndex: 0, pages: [0, 1] });
    expect(drawn(glyphs(doc, "intestazione", 0))).toBe("ACME S.p.A. – Łódź");
    expect(drawn(glyphs(doc, "intestazione", 1))).toBe("ACME S.p.A. – Łódź");
    expect(outside(doc, "intestazione", 0) + outside(doc, "intestazione", 1)).toBe(0);
    fill(doc, "intestazione", text("ACME"));
    expect(drawn(glyphs(doc, "intestazione", 1))).toBe("ACME");
  });

  it("two field dictionaries with one name on two pages: both filled", () => {
    const doc = keep(new mupdf.PDFDocument());
    const helv = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" });
    const fields = doc.newArray();
    for (let i = 0; i < 2; i++) {
      doc.insertPage(-1, doc.addPage([0, 0, 300, 100], 0, {}, ""));
      const pg = doc.findPage(i);
      const a = doc.newArray();
      pg.put("Annots", a);
      const f = doc.addObject({ Type: "Annot", Subtype: "Widget", F: 4, P: pg, FT: "Tx", T: "(data)", DA: "(/Helv 10 Tf 0 g)", Rect: [20, 20, 200, 40] });
      a.push(f);
      fields.push(f);
    }
    doc.getTrailer().get("Root").put("AcroForm", doc.addObject({ Fields: fields, DR: { Font: { Helv: helv } } }));
    for (const value of ["16/10/2026", "16 października 2026"]) {
      const r = fill(doc, "data", text(value))!;
      expect(r.edit.pages).toEqual([0, 1]);
      expect([field(doc, "data", 0).value, field(doc, "data", 1).value]).toEqual([value, value]);
      expect([drawn(glyphs(doc, "data", 0)), drawn(glyphs(doc, "data", 1))]).toEqual([value, value]);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// History: field edits mixed with line and image edits, replayed from the original and from
// snapshots (as the session's checkpoints), give the same document at every step.

type Step =
  | { kind: "field"; edit: FieldEdit }
  | { kind: "text"; pageIndex: number; find: string; replacement: string }
  | { kind: "image"; op: "move" | "delete"; expect: Matrix };

/** A picture added to page 1 of `bytes`, for image edits. */
function withImage(bytes: Uint8Array): Uint8Array {
  const doc = openBytes(bytes);
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 16, 16], false);
  pix.clear(90);
  const image = new mupdf.Image(pix);
  const img = doc.addImage(image);
  image.destroy();
  pix.destroy();
  const pageObj = doc.findPage(0);
  pageObj.get("Resources").put("XObject", { ImX: img });
  const arr = doc.newArray();
  arr.push(pageObj.get("Contents"));
  arr.push(doc.addStream("q 50 0 0 50 480 700 cm /ImX Do Q\n", {}));
  pageObj.put("Contents", arr);
  return saveBytes(doc);
}

function applyStep(doc: mupdf.PDFDocument, step: Step) {
  if (step.kind === "field") applyFieldEdit(mupdf, doc, step.edit);
  else if (step.kind === "text") replaceText(mupdf, doc, step.pageIndex, step.find, step.replacement);
  else {
    const page = doc.loadPage(0);
    try {
      const found = findPlacements(mupdf, page);
      const p = found.placements.find((x) => x.matrix.every((v, i) => Math.abs(v - step.expect[i]) < 0.01));
      if (!p) throw new Error("image not found");
      if (step.op === "move") transformPlacement(mupdf, doc, page, found, p, [p.matrix[0], p.matrix[1], p.matrix[2], p.matrix[3], p.matrix[4] - 30, p.matrix[5] + 10]);
      else deletePlacement(mupdf, doc, page, found, p);
    } finally {
      page.destroy();
    }
  }
}

/** Values, states, appearance hashes and page text of every page: what a replay must reproduce. */
function fingerprint(doc: mupdf.PDFDocument): string {
  // Without garbage collection: it would renumber the objects of `doc` itself (the session's
  // snapshots never collect either), and the fallback-font bookkeeping goes by object number.
  const bytes = saveBytes(doc);
  const d = mupdf.Document.openDocument(bytes, "application/pdf").asPDF()!;
  const out: string[] = [];
  try {
    for (let p = 0; p < d.countPages(); p++) {
      const page = d.loadPage(p) as mupdf.PDFPage;
      const widgets = [...page.getWidgets()];
      try {
        for (const w of widgets) {
          const o = w.getObject();
          let n = o.get("AP", "N");
          if (n.isDictionary() && !n.isStream()) n = o.get("AS").isName() ? n.get(o.get("AS").asName()) : mupdf.PDFObject.Null;
          let hash = "-";
          if (n.isStream()) {
            const buf = n.readStream();
            hash = createHash("sha1").update(buf.asUint8Array()).digest("hex").slice(0, 10);
            buf.destroy();
          }
          out.push(`${p}:${w.getName()}=${JSON.stringify(w.getValue())}/${String(o.get("AS"))}/${hash}`);
        }
        const images = findPlacements(mupdf, page).placements.map((x) => x.matrix.map((v) => v.toFixed(2)).join(" "));
        out.push(`${p}:images=${images.join("|")}`);
        const lines = extractLines(page);
        out.push(`${p}:text=${lines.map((l: { text: string }) => l.text).join("|")}`);
        releasePage(page, lines); // (destroys the page)
      } finally {
        for (const w of widgets) w.destroy();
      }
    }
  } finally {
    d.destroy();
  }
  return out.join("\n");
}

describe("history", () => {
  it("18 mixed steps: replays from the original and from snapshots equal the edited document", () => {
    const original = withImage(buildForm());
    const doc = openBytes(original);
    const planned = (name: string, value: FieldValue): Step => ({ kind: "field", edit: planFieldEdit(mupdf, doc, name, value)! });
    const imageAt = () => {
      const page = doc.loadPage(0);
      try {
        return findPlacements(mupdf, page).placements[0].matrix as Matrix;
      } finally {
        page.destroy();
      }
    };
    const steps: (() => Step)[] = [
      () => planned("nome", text("Mario Rossi")),
      () => planned("privacy", state("Si")),
      () => ({ kind: "text", pageIndex: 0, find: "Nome", replacement: "Nome e cognome" }),
      () => planned("sesso", state("F")),
      () => ({ kind: "image", op: "move", expect: imageAt() }),
      () => planned("citta", choice("Forlì")),
      () => planned("cf", text("RSSMRA80A01H501U")),
      () => planned("nome", text("Łukasz Ștefan")),
      () => planned("note", text("Riga uno\nRiga due 東京")),
      () => ({ kind: "text", pageIndex: 1, find: "Pagina 2", replacement: "Pagina 2 – ż" }),
      () => planned("intestazione", text("ACME S.p.A.")),
      () => planned("sesso", state("M")),
      () => ({ kind: "image", op: "delete", expect: imageAt() }),
      () => planned("a.b.c", text("Привет")),
      () => planned("interessi", choice("Sport", "Arte")),
      () => planned("provincia", choice("BV")),
      () => planned("privacy", state("Off")),
      () => planned("lingua", choice("English")),
    ];
    const log: Step[] = [];
    const states = [fingerprint(doc)];
    const snapshots = new Map<number, { bytes: Uint8Array; fonts: ReturnType<typeof fallbackFontState> }>();
    for (const make of steps) {
      const step = make();
      applyStep(doc, step);
      log.push(step);
      states.push(fingerprint(doc));
      if (log.length % 8 === 0) snapshots.set(log.length, { bytes: saveBytes(doc), fonts: fallbackFontState(doc) });
    }
    expect(log.length).toBe(18);
    expect(new Set(states).size).toBe(19); // every step changed something
    for (let k = 0; k <= log.length; k++) {
      const fresh = openBytes(original);
      for (const step of log.slice(0, k)) applyStep(fresh, step);
      expect(fingerprint(fresh), `replay of ${k} from the original`).toBe(states[k]);
      const base = [...snapshots.keys()].filter((n) => n <= k).pop();
      if (base === undefined) continue;
      const snap = openBytes(snapshots.get(base)!.bytes);
      restoreFallbackFonts(snap, snapshots.get(base)!.fonts);
      for (const step of log.slice(base, k)) applyStep(snap, step);
      expect(fingerprint(snap), `replay of ${k} from the snapshot at ${base}`).toBe(states[k]);
    }
    // The log is plain data: a JSON round trip replays the same.
    const copied = JSON.parse(JSON.stringify(log.filter((s) => s.kind === "field"))) as Step[];
    expect(copied.length).toBe(14);
  });
});

describe("line and image edits on pages with fields", () => {
  it("editing and deleting the printed line under a field keeps the field", () => {
    const doc = keep(new mupdf.PDFDocument());
    const helv = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" });
    doc.insertPage(-1, doc.addPage([0, 0, 400, 200], 0, { Font: { F1: helv } },
      "BT /F1 12 Tf 20 150 Td (Nome: ____________________________) Tj ET BT /F1 12 Tf 20 100 Td (Data: ______________) Tj ET"));
    const page = doc.findPage(0);
    const annots = doc.newArray();
    page.put("Annots", annots);
    const fields = doc.newArray();
    for (const [name, rect] of [["nome", [60, 146, 300, 164]], ["data", [55, 96, 160, 114]]] as const) {
      const o = doc.addObject({ Type: "Annot", Subtype: "Widget", F: 4, P: page, FT: "Tx", T: `(${name})`, DA: "(/Helv 11 Tf 0 0 1 rg)", Rect: [...rect] });
      annots.push(o);
      fields.push(o);
    }
    doc.getTrailer().get("Root").put("AcroForm", doc.addObject({ Fields: fields, DR: { Font: { Helv: helv } } }));
    fill(doc, "nome", text("Mario Rossi"));
    fill(doc, "data", text("16 października"));
    const before = fieldsOf(doc).map((f) => [f.name, f.value, f.rect.map(Math.round)]);
    replaceText(mupdf, doc, 0, "Nome: ____________________________", "Nome (in stampatello): ______");
    replaceText(mupdf, doc, 0, "Data: ______________", "");
    expect(fieldsOf(doc).map((f) => [f.name, f.value, f.rect.map(Math.round)])).toEqual(before);
    expect(drawn(glyphs(doc, "nome"))).toBe("Mario Rossi");
    expect(drawn(glyphs(doc, "data"))).toBe("16 października");
    // The fields' text is never a line of the page.
    const p = doc.loadPage(0);
    const lines = extractLines(p);
    expect(lines.map((l: { text: string }) => l.text).join("|")).not.toMatch(/Mario|października/);
    releasePage(p, lines);
  });

  it("moving and deleting a picture keeps the filled fields", () => {
    const doc = openBytes(withImage(buildForm()));
    fill(doc, "nome", text("Anna Łęcka"));
    fill(doc, "privacy", state("Si"));
    const onlyFields = (l: string) => !l.includes(":text=") && !l.includes(":images=");
    const before = fingerprint(doc).split("\n").filter(onlyFields);
    const page = doc.loadPage(0);
    try {
      let found = findPlacements(mupdf, page);
      const m = found.placements[0].matrix;
      transformPlacement(mupdf, doc, page, found, found.placements[0], [m[0] * 1.5, m[1], m[2], m[3] * 1.5, m[4] - 100, m[5] + 50]);
      found = findPlacements(mupdf, page);
      deletePlacement(mupdf, doc, page, found, found.placements[0]);
    } finally {
      page.destroy();
    }
    expect(fingerprint(doc).split("\n").filter(onlyFields)).toEqual(before);
  });
});
