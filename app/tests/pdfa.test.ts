// PDF/A-2b ("PDF/A per l'archivio"): the conversion (src/engine/pdfa.ts) through EngineSession,
// the engine's own check of the saved bytes, and our sRGB profile (src/engine/icc.ts).
//
// These tests check what the engine knows of PDF/A; veraPDF, the reference validator, checks
// the files themselves in CI: when the environment variable PDFA_OUT is set, every converted
// file is written there as <name>.pdf, and every file the conversion must refuse is written to
// PDFA_OUT/refused/<name>.pdf as a normal PDF (.github/workflows/app.yml, job "pdfa").
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as mupdf from "mupdf";
import { describe, expect, it, vi } from "vitest";
import { SRGB_PROFILE_NAME, srgbProfile, srgbToLinear } from "../src/engine/icc";
import { checkPdfA, convertToPdfA, standardFontFor } from "../src/engine/pdfa";
import type { DocInfo, PdfaIssue, PdfaReport, SaveOptions } from "../src/engine/protocol";
import { EngineSession, SessionError, type RenderPixels } from "../src/engine/session";

const PDFA: SaveOptions = { format: "pdfa-2b", password: { mode: "none" } };

const OUT = process.env.PDFA_OUT;
if (OUT) mkdirSync(join(OUT, "refused"), { recursive: true });
/** A converted file, for veraPDF (expected compliant). */
const keepConverted = (name: string, bytes: ArrayBuffer | Uint8Array) =>
  OUT && writeFileSync(join(OUT, `${name}.pdf`), new Uint8Array(bytes));
/** A file the app refuses to convert, saved as a normal PDF, for veraPDF (expected to fail). */
const keepRefused = (name: string, bytes: ArrayBuffer | Uint8Array) =>
  OUT && writeFileSync(join(OUT, "refused", `${name}.pdf`), new Uint8Array(bytes));

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
/** The larger files of the prototype (not in the repository): used when present. */
const EXTRA = new URL("../node_modules/pdf-fixtures/", import.meta.url);

/** A session with `bytes` open, and what open reported. */
function open(bytes: Uint8Array | ArrayBuffer, password?: string): { s: EngineSession; info: DocInfo } {
  const s = new EngineSession(mupdf);
  const r = s.open(bytes, password);
  if (!r.ok) throw new Error(`did not open: ${r.reason}`);
  return { s, info: r };
}

/**
 * Pixels that differ between two renders by more than 2 levels in a channel (colour management
 * may round a level). Same size required.
 */
function changedPixels(a: RenderPixels, b: RenderPixels): number {
  expect([b.width, b.height]).toEqual([a.width, a.height]);
  let changed = 0;
  for (let i = 0; i < a.rgba.length; i += 4)
    if (Math.abs(a.rgba[i] - b.rgba[i]) > 2 || Math.abs(a.rgba[i + 1] - b.rgba[i + 1]) > 2 || Math.abs(a.rgba[i + 2] - b.rgba[i + 2]) > 2) changed++;
  return changed;
}

/** The first pages look the same in both sessions (at low resolution, to stay fast). */
function expectSameLook(before: EngineSession, after: EngineSession, pages: number) {
  for (let p = 0; p < pages; p++) expect(changedPixels(before.render(p, 0.5), after.render(p, 0.5)), `page ${p + 1}`).toBe(0);
}

const codes = (issues: PdfaIssue[]) => issues.map((i) => i.code + (i.detail ? `:${i.detail}` : "") + (i.count ? `x${i.count}` : "")).sort();

/**
 * Converts through the session the way the app does (pdfaCheck, then save) and checks the
 * result: no blockers, the same report twice, a file that passes the engine's check and claims
 * PDF/A-2B when opened again, without a password. Written to PDFA_OUT as `name` (null: a file
 * already written under another name).
 */
function convert(name: string | null, s: EngineSession) {
  const report = s.pdfaCheck();
  expect(report.blockers).toEqual([]);
  const saved = s.save(PDFA);
  expect(saved.pdfa).toEqual(report);
  const bytes = new Uint8Array(saved.bytes);
  expect(checkPdfA(mupdf, bytes)).toEqual([]);
  if (name) keepConverted(name, saved.bytes);
  const again = open(bytes);
  expect(again.info).toMatchObject({ pdfa: "2B", encrypted: false, needsPassword: false, signatures: 0 });
  return { report, bytes, again: again.s };
}

/** The conversion is refused: pdfaCheck lists blockers and save says "pdfa-blocked". */
function expectRefused(name: string, s: EngineSession): PdfaReport {
  const report = s.pdfaCheck();
  expect(report.blockers.length).toBeGreaterThan(0);
  try {
    s.save(PDFA);
    throw new Error("saved as PDF/A");
  } catch (err) {
    expect(err).toBeInstanceOf(SessionError);
    expect((err as SessionError).code).toBe("pdfa-blocked");
  }
  keepRefused(name, s.save().bytes);
  return report;
}

/**
 * What the engine's check says of a file converted in spite of its blockers: it must not pass
 * what the conversion refuses (the session would otherwise hand out a false PDF/A).
 */
function forcedCheck(bytes: Uint8Array): string[] {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf").asPDF()!;
  try {
    convertToPdfA(mupdf, doc, { now: new Date("2026-10-15T12:00:00Z") });
    return checkPdfA(mupdf, saveBytes(doc, "garbage=compact,compress=yes,encrypt=none"));
  } finally {
    doc.destroy();
  }
}

/** The engine's check of `bytes` after `change` (a converted file spoilt on purpose). */
function checkTampered(bytes: Uint8Array, change: (doc: mupdf.PDFDocument) => void, options = ""): string[] {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf").asPDF()!;
  try {
    change(doc);
    return checkPdfA(mupdf, saveBytes(doc, options));
  } finally {
    doc.destroy();
  }
}

function saveBytes(doc: mupdf.PDFDocument, options: string): Uint8Array {
  const buf = doc.saveToBuffer(options);
  try {
    return buf.asUint8Array().slice();
  } finally {
    buf.destroy();
  }
}

/** Opens `bytes` with MuPDF for a look at its objects. */
function inspect<T>(bytes: Uint8Array, look: (doc: mupdf.PDFDocument) => T): T {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf").asPDF()!;
  try {
    return look(doc);
  } finally {
    doc.destroy();
  }
}

/** Every indirect object of a document that is a dictionary (or stream). */
function dictionaries(doc: mupdf.PDFDocument): mupdf.PDFObject[] {
  const out: mupdf.PDFObject[] = [];
  for (let n = 1; n < doc.countObjects(); n++) {
    const o = doc.newIndirect(n);
    if (o.isDictionary()) out.push(o);
  }
  return out;
}

const nameOf = (o: mupdf.PDFObject, key: string) => (o.get(key).isName() ? o.get(key).asName() : null);

/** The annotations of page 1, by field name (T, or the parent field's) or else Subtype. */
function annotsOf(doc: mupdf.PDFDocument): Map<string, mupdf.PDFObject> {
  const out = new Map<string, mupdf.PDFObject>();
  const annots = doc.findPage(0).get("Annots");
  for (let i = 0; i < annots.length; i++) {
    const a = annots.get(i);
    const t = a.get("T").isString() ? a.get("T") : a.get("Parent", "T");
    out.set(t.isString() ? t.asString() : nameOf(a, "Subtype") ?? "?", a);
  }
  return out;
}

/** The decoded content of page 1 as text. */
function pageContent(doc: mupdf.PDFDocument): string {
  const buf = doc.findPage(0).get("Contents").readStream();
  try {
    return new TextDecoder("latin1").decode(buf.asUint8Array());
  } finally {
    buf.destroy();
  }
}

// ---------------------------------------------------------------------------------------------
// Synthetic files, made here with MuPDF

function makePdf(build: (doc: mupdf.PDFDocument) => void): Uint8Array {
  const doc = new mupdf.PDFDocument();
  try {
    build(doc);
    const buf = doc.saveToBuffer("compress=yes");
    try {
      return buf.asUint8Array().slice();
    } finally {
      buf.destroy();
    }
  } finally {
    doc.destroy();
  }
}

function setInfo(doc: mupdf.PDFDocument, info: Record<string, string>) {
  const dict = doc.addObject({});
  for (const [k, v] of Object.entries(info)) dict.put(k, doc.newString(v));
  doc.getTrailer().put("Info", dict);
  doc.getTrailer().get("Root").delete("Info"); // MuPDF 1.27 leaves a stray Info in a new Catalog
}

/** A standard font as MuPDF's addSimpleFont makes it: NOT embedded. */
function simpleFont(doc: mupdf.PDFDocument, name: string) {
  const font = new mupdf.Font(name);
  try {
    return doc.addSimpleFont(font);
  } finally {
    font.destroy();
  }
}

const WIN_ANSI: Record<string, number> = { "€": 0x80, "–": 0x96, "’": 0x92, "“": 0x93, "”": 0x94 };
const winAnsi = (s: string) => [...s].map((ch) => (WIN_ANSI[ch] ?? ch.charCodeAt(0)).toString(16).padStart(2, "0")).join("");

/** Non-embedded Helvetica, WinAnsi text with accents and the euro sign, an Info dictionary. */
const helveticaPdf = () => makePdf((doc) => {
  const helv = simpleFont(doc, "Helvetica");
  const lines = ["Fattura n. 12 – città di Forlì", "Totale: 1.250,00 € “saldo” dell’anno", "ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz 0123456789"];
  const ops = `BT /F1 18 Tf 72 760 Td 22 TL\n${lines.map((l) => `<${winAnsi(l)}> Tj T*`).join("\n")}\nET`;
  doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { Font: { F1: helv } }, ops));
  setInfo(doc, { Title: "Fattura n. 12 – città <prova> & co.", Author: "Società Rossi", CreationDate: "D:20261015103000+02'00'" });
});

/**
 * Most of what PDF/A-2b does not allow but a conversion may fix or remove: Times-Bold without
 * an Encoding, a non-embedded TrueType "Arial,Bold" with widths of its own, a non-standard
 * blend mode, an interpolated image, JavaScript (open action, document level, on a link), a
 * Launch action, an attached file, MuPDF-made annotations (highlight, free text), a hidden
 * note, a square without the Print flag, a hidden form field, a signed signature field and
 * static XFA data. With `refuse`, also what blocks: CMYK and a non-embedded "Calibri".
 */
const nastyPdf = (refuse: boolean) => makePdf((doc) => {
  const helv = simpleFont(doc, "Helvetica");
  const timesB = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Times-Bold" });
  const widths: number[] = [];
  for (let c = 32; c <= 255; c++) widths.push(c === 0x61 ? 560 : c === 0x6f ? 600 : 556); // crude, on purpose
  const arialB = doc.addObject({
    Type: "Font", Subtype: "TrueType", BaseFont: "Arial,Bold", FirstChar: 32, LastChar: 255, Widths: widths, Encoding: "WinAnsiEncoding",
    FontDescriptor: doc.addObject({ Type: "FontDescriptor", FontName: "Arial,Bold", Flags: 32, FontBBox: [-628, -376, 2000, 1010], ItalicAngle: 0, Ascent: 905, Descent: -212, CapHeight: 716, StemV: 165 }),
  });
  const calibri = doc.addObject({
    Type: "Font", Subtype: "TrueType", BaseFont: "Calibri", FirstChar: 32, LastChar: 126, Widths: Array(95).fill(500), Encoding: "WinAnsiEncoding",
    FontDescriptor: doc.addObject({ Type: "FontDescriptor", FontName: "Calibri", Flags: 32, FontBBox: [-503, -250, 1240, 750], ItalicAngle: 0, Ascent: 750, Descent: -250, CapHeight: 632, StemV: 80 }),
  });
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 16, 16], false);
  pix.clear(200);
  const image = new mupdf.Image(pix);
  const img = doc.addImage(image);
  image.destroy();
  pix.destroy();
  img.put("Interpolate", true);
  const ops = [
    "BT /F1 16 Tf 72 780 Td (Helvetica non incorporato) Tj ET",
    "BT /F2 16 Tf 72 756 Td (Times-Bold senza Encoding: fi fl) Tj ET",
    "BT /F3 16 Tf 72 732 Td (Arial,Bold TrueType non incorporato: aoaoao) Tj ET",
    "q /GS1 gs 1 0 0 rg 150 620 200 80 re f Q",
    "q /GS2 gs 0 0 1 rg 380 620 60 60 re f Q",
    "q 64 0 0 64 460 600 cm /Im1 Do Q",
    ...(refuse ? ["0.1 0.6 0 0 k 72 600 60 60 re f", "BT /F4 16 Tf 72 708 Td (Calibri non incorporato) Tj ET"] : []),
  ].join("\n");
  const resources = {
    Font: { F1: helv, F2: timesB, F3: arialB, ...(refuse ? { F4: calibri } : {}) },
    ExtGState: { GS1: doc.addObject({ Type: "ExtGState", ca: 0.5, CA: 0.5 }), GS2: doc.addObject({ Type: "ExtGState", BM: "Fancy" }) },
    XObject: { Im1: img },
  };
  doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, resources, ops));
  const page = doc.loadPage(0);
  const highlight = page.createAnnotation("Highlight");
  highlight.setQuadPoints([[72, 58, 300, 58, 72, 80, 300, 80]]);
  highlight.update();
  const freeText = page.createAnnotation("FreeText");
  freeText.setRect([72, 300, 300, 340]);
  freeText.setContents("Nota: testo libero");
  freeText.update();
  const note = page.createAnnotation("Text");
  note.setRect([400, 300, 420, 320]);
  note.setContents("nota nascosta");
  note.update();
  note.setFlags(note.getFlags() | 2); // Hidden
  const square = page.createAnnotation("Square");
  square.setRect([72, 400, 200, 460]);
  square.update();
  square.setFlags(0); // not printable
  page.createLink([72, 776, 300, 796], "https://example.org").destroy();
  page.createLink([72, 752, 300, 772], "https://example.org/2").destroy();
  page.update();
  for (const a of [highlight, freeText, note, square]) a.destroy();
  const pageObj = page.getObject();
  page.destroy();
  const annots = pageObj.get("Annots");
  let links = 0;
  for (let i = 0; i < annots.length; i++) {
    const a = annots.get(i);
    if (a.get("Subtype").asName() === "Highlight") {
      // The highlight's pop-up note, with F but no Print flag (NoZoom, NoRotate).
      const popup = doc.addObject({ Type: "Annot", Subtype: "Popup", Rect: [320, 60, 470, 120], F: 24, Open: false, Parent: a, P: pageObj });
      a.put("Popup", popup);
      annots.push(popup);
    }
    if (a.get("Subtype").asName() !== "Link") continue;
    a.put("A", links++ === 0
      ? doc.addObject({ Type: "Action", S: "JavaScript", JS: "(app.alert('ciao'))" })
      : doc.addObject({ Type: "Action", S: "Launch", F: "(calc.exe)" }));
  }
  // A hidden text field (with its own appearance) and a signed signature field.
  const hidden = doc.addObject({
    Type: "Annot", Subtype: "Widget", FT: "Tx", T: "(Nascosto)", Rect: [72, 200, 172, 220], F: 2, P: pageObj,
    AP: { N: doc.addStream("0 0 1 RG 0.5 0.5 99 19 re S", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 100, 20], Resources: {} }) },
  });
  const signature = doc.addObject({
    Type: "Sig", Filter: "Adobe.PPKLite", SubFilter: "adbe.pkcs7.detached", ByteRange: [0, 100, 200, 300],
    Contents: doc.newByteString(new Uint8Array(64)), M: "(D:20261015120000Z)",
  });
  const sigField = doc.addObject({ Type: "Annot", Subtype: "Widget", FT: "Sig", T: "(Firma)", Rect: [0, 0, 0, 0], F: 132, P: pageObj, V: signature });
  annots.push(hidden);
  annots.push(sigField);
  const root = doc.getTrailer().get("Root");
  root.put("AcroForm", doc.addObject({ Fields: [hidden, sigField], SigFlags: 3, XFA: doc.addStream("<xdp:xdp/>", {}) }));
  root.put("OpenAction", doc.addObject({ S: "JavaScript", JS: "(this.print())" }));
  root.put("Names", doc.addObject({ JavaScript: doc.addObject({ Names: ["(init)", doc.addObject({ S: "JavaScript", JS: "(var x = 1;)" })] }) }));
  const now = new Date("2026-10-15T10:00:00Z");
  doc.insertEmbeddedFile("dati.csv", doc.addEmbeddedFile("dati.csv", "text/csv", "a;b\n1;2\n", now, now));
  setInfo(doc, { Title: "Prova <PDF/A> & co.", Author: "Ufficio tecnico", Subject: "Collaudo", Keywords: "pdfa, prova", CreationDate: "D:20250102030405Z", Trapped: "False" });
});

const FF_PUSHBUTTON = 1 << 16;

/** A form XObject of `w` x `h` that runs `ops`, for appearance streams. */
const look = (doc: mupdf.PDFDocument, ops: string, w = 80, h = 20) =>
  doc.addStream(ops, { Type: "XObject", Subtype: "Form", BBox: [0, 0, w, h], Resources: {} });

/**
 * Form buttons as forms tools write them: a push button that submits the form (field and widget
 * in one dictionary, its appearance a stream), a push button widget whose field (type, flags) is
 * its parent and whose action opens a web page, a ticked check box with a single appearance
 * stream and no /AS, a text field whose appearance is a dictionary of states, and a link.
 * Every action but the link's goes.
 */
const buttonsPdf = () => makePdf((doc) => {
  doc.insertPage(-1, doc.addPage([0, 0, 300, 200], 0, {}, "0.9 g 0 0 300 200 re f"));
  const pageObj = doc.findPage(0);
  const submit = doc.addObject({
    Type: "Annot", Subtype: "Widget", FT: "Btn", Ff: FF_PUSHBUTTON, T: "(Invia)", Rect: [20, 20, 100, 40], F: 4, P: pageObj,
    AP: { N: look(doc, "0.2 0.4 0.8 rg 0 0 80 20 re f") },
    A: doc.addObject({ S: "SubmitForm", F: doc.addObject({ FS: "URL", F: "(https://example.org/invia)" }), Flags: 4 }),
  });
  // (Its field carries an action too, allowed elsewhere but not on a field: 6.4.1.)
  const print = doc.addObject({ FT: "Btn", Ff: FF_PUSHBUTTON, T: "(Stampa)", A: doc.addObject({ S: "Named", N: "NextPage" }) });
  const printWidget = doc.addObject({
    Type: "Annot", Subtype: "Widget", Parent: print, Rect: [120, 20, 200, 40], F: 4, P: pageObj,
    AP: { N: look(doc, "0.8 0.2 0.2 rg 0 0 80 20 re f") }, A: doc.addObject({ S: "URI", URI: "(https://example.org/stampa)" }),
  });
  print.put("Kids", [printWidget]);
  const check = doc.addObject({
    Type: "Annot", Subtype: "Widget", FT: "Btn", T: "(Conferma)", V: "Yes", Rect: [20, 60, 40, 80], F: 4, P: pageObj,
    AP: { N: look(doc, "0 g 3 3 14 14 re f", 20, 20) },
  });
  const text = doc.addObject({
    Type: "Annot", Subtype: "Widget", FT: "Tx", T: "(Nome)", V: "(Mario)", Rect: [20, 100, 200, 120], F: 4, P: pageObj, AS: "Pieno",
    DA: "(/Helv 10 Tf 0 g)", AP: { N: { Pieno: look(doc, "1 1 0.6 rg 0 0 180 20 re f", 180), Vuoto: look(doc, "", 180) } },
  });
  pageObj.put("Annots", [submit, printWidget, check, text]);
  doc.getTrailer().get("Root").put("AcroForm", doc.addObject({ Fields: [submit, print, check, text] }));
  const page = doc.loadPage(0);
  page.createLink([20, 150, 200, 170], "https://example.org/info").destroy();
  page.destroy();
});

/**
 * A CMYK printer profile, made here for the tests (ICC v2.1, class prtr, PCS Lab): coarse
 * 2-point lookup tables, good for colour management to run, not for real printing.
 */
function cmykProfile(): Uint8Array {
  const ascii = (out: Uint8Array, at: number, s: string) => { for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i); };
  /** A lut16Type ("mft2") with identity curves and a grid of 2 points per input. */
  const lut = (inputs: number, outputs: number, f: (x: number[]) => number[]) => {
    const points = 2 ** inputs;
    const data = new Uint8Array(52 + inputs * 4 + points * outputs * 2 + outputs * 4);
    const view = new DataView(data.buffer);
    ascii(data, 0, "mft2");
    data.set([inputs, outputs, 2], 8);
    for (let i = 0; i < 3; i++) view.setInt32(12 + 16 * i, 0x10000); // identity matrix
    view.setUint16(48, 2);
    view.setUint16(50, 2);
    let at = 52;
    const curve = () => { view.setUint16(at, 0); view.setUint16(at + 2, 65535); at += 4; };
    for (let i = 0; i < inputs; i++) curve();
    for (let p = 0; p < points; p++) {
      const x = [...Array(inputs).keys()].map((i) => (p >> (inputs - 1 - i)) & 1);
      for (const v of f(x)) { view.setUint16(at, Math.round(Math.min(1, Math.max(0, v)) * 65535)); at += 2; }
    }
    for (let i = 0; i < outputs; i++) curve();
    return data;
  };
  // Lab in the version 2 16-bit encoding: L 0..100 on 0..0xff00, a and b +128 on 0..0xffff.
  const lab = (l: number, a: number, b: number) => [(l / 100) * 0xff00 / 65535, ((a + 128) * 256) / 65535, ((b + 128) * 256) / 65535];
  const toLab = lut(4, 3, ([c, m, y, k]) => lab(100 * (1 - 0.4 * c - 0.3 * m - 0.1 * y) * (1 - 0.9 * k), 60 * m - 40 * c, 70 * y - 30 * c - 20 * m));
  const fromLab = lut(3, 4, ([l]) => [0, 0, 0, 1 - l]);
  const text = new Uint8Array(8 + 13);
  ascii(text, 0, "text");
  ascii(text, 8, "No copyright");
  const desc = new Uint8Array(12 + 10 + 78);
  ascii(desc, 0, "desc");
  new DataView(desc.buffer).setUint32(8, 10);
  ascii(desc, 12, "Test CMYK");
  const white = new Uint8Array(20);
  ascii(white, 0, "XYZ ");
  [0xf6d6, 0x10000, 0xd32d].forEach((v, i) => new DataView(white.buffer).setInt32(8 + 4 * i, v));
  const tags: [string, Uint8Array][] = [["desc", desc], ["cprt", text], ["wtpt", white], ["A2B0", toLab], ["B2A0", fromLab]];
  let size = 128 + 4 + 12 * tags.length;
  const offsets = tags.map(([, d]) => { const at = size; size += (d.length + 3) & ~3; return at; });
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  view.setUint32(0, size);
  view.setUint32(8, 0x02100000);
  ascii(out, 12, "prtr");
  ascii(out, 16, "CMYK");
  ascii(out, 20, "Lab ");
  [2026, 10, 15, 0, 0, 0].forEach((v, i) => view.setUint16(24 + 2 * i, v));
  ascii(out, 36, "acsp");
  [0xf6d6, 0x10000, 0xd32d].forEach((v, i) => view.setInt32(68 + 4 * i, v));
  view.setUint32(128, tags.length);
  tags.forEach(([sig, d], i) => {
    ascii(out, 132 + 12 * i, sig);
    view.setUint32(136 + 12 * i, offsets[i]);
    view.setUint32(140 + 12 * i, d.length);
    out.set(d, offsets[i]);
  });
  return out;
}

/** An XMP packet claiming PDF/A `part` and `conformance`, as a PDF/A source carries it. */
const claimXmp = (part: number, conformance: string) => `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"><pdfaid:part>${part}</pdfaid:part><pdfaid:conformance>${conformance}</pdfaid:conformance></rdf:Description>
</rdf:RDF></x:xmpmeta>
<?xpacket end="w"?>`;

/**
 * A PDF/A-1b from a print workflow: one GTS_PDFA1 output intent with a CMYK profile, text and
 * paths in DeviceCMYK. `rgb`: also something in DeviceRGB ("content": a path; "annotation": a
 * square note, whose appearance MuPDF draws in RGB).
 */
const printPdf = (rgb: "none" | "content" | "annotation") => makePdf((doc) => {
  const helv = simpleFont(doc, "Helvetica");
  const ops = ["0 0 0 1 k BT /F1 14 Tf 20 60 Td (Stampa in quadricromia) Tj ET", "0.1 0.6 0 0 k 20 10 80 30 re f", ...(rgb === "content" ? ["1 0 0 rg 120 10 40 30 re f"] : [])];
  doc.insertPage(-1, doc.addPage([0, 0, 300, 100], 0, { Font: { F1: helv } }, ops.join("\n")));
  const root = doc.getTrailer().get("Root");
  root.put("OutputIntents", [doc.addObject({
    Type: "OutputIntent", S: "GTS_PDFA1", OutputConditionIdentifier: "(Test CMYK)", DestOutputProfile: doc.addStream(cmykProfile(), { N: 4 }),
  })]);
  root.put("Metadata", doc.addStream(claimXmp(1, "B"), { Type: "Metadata", Subtype: "XML" }));
  if (rgb === "annotation") {
    const page = doc.loadPage(0);
    const square = page.createAnnotation("Square");
    square.setRect([200, 20, 280, 80]);
    square.setColor([1, 0, 0]);
    square.update();
    page.update();
    square.destroy();
    page.destroy();
  }
});

// ---------------------------------------------------------------------------------------------

describe("our sRGB profile", () => {
  const icc = srgbProfile();
  const view = new DataView(icc.buffer, icc.byteOffset, icc.byteLength);
  const ascii = (at: number) => String.fromCharCode(...icc.subarray(at, at + 4));

  it("has a well-formed ICC version 2.1 display header", () => {
    expect(view.getUint32(0)).toBe(icc.length);
    expect(view.getUint32(8)).toBe(0x02100000);
    expect([ascii(12), ascii(16), ascii(20), ascii(36)]).toEqual(["mntr", "RGB ", "XYZ ", "acsp"]);
    expect([view.getInt32(68), view.getInt32(72), view.getInt32(76)]).toEqual([0xf6d6, 0x10000, 0xd32d]); // D50
    expect(icc.subarray(84, 128).every((b) => b === 0)).toBe(true); // no profile ID in version 2
  });

  it("has a well-formed tag table with the required tags", () => {
    const count = view.getUint32(128);
    const tags = new Map<string, [number, number]>();
    for (let i = 0; i < count; i++) {
      const at = 132 + 12 * i;
      const [offset, size] = [view.getUint32(at + 4), view.getUint32(at + 8)];
      expect(offset % 4).toBe(0);
      expect(offset).toBeGreaterThanOrEqual(132 + 12 * count);
      expect(offset + size).toBeLessThanOrEqual(icc.length);
      tags.set(ascii(at), [offset, size]);
    }
    expect([...tags.keys()].sort()).toEqual(["bTRC", "bXYZ", "cprt", "desc", "gTRC", "gXYZ", "rTRC", "rXYZ", "wtpt"]);
    const type = (sig: string) => ascii(tags.get(sig)![0]);
    expect([type("desc"), type("cprt"), type("wtpt"), type("rXYZ"), type("rTRC")]).toEqual(["desc", "text", "XYZ ", "XYZ ", "curv"]);
    const [descAt] = tags.get("desc")!;
    const n = view.getUint32(descAt + 8);
    expect(String.fromCharCode(...icc.subarray(descAt + 12, descAt + 12 + n - 1))).toBe(SRGB_PROFILE_NAME);
    // The primaries add up to the D50 white, and the curve follows sRGB.
    const xyz = (sig: string) => [0, 1, 2].map((k) => view.getInt32(tags.get(sig)![0] + 8 + 4 * k) / 65536);
    const sum = [0, 1, 2].map((k) => xyz("rXYZ")[k] + xyz("gXYZ")[k] + xyz("bXYZ")[k]);
    expect(sum[0]).toBeCloseTo(0.9642, 3);
    expect(sum[1]).toBeCloseTo(1, 3);
    expect(sum[2]).toBeCloseTo(0.8249, 2);
    const [curveAt] = tags.get("rTRC")!;
    const points = view.getUint32(curveAt + 8);
    const sample = (i: number) => view.getUint16(curveAt + 12 + 2 * i);
    expect([sample(0), sample(points - 1)]).toEqual([0, 65535]);
    expect(sample(512) / 65535).toBeCloseTo(srgbToLinear(512 / (points - 1)), 4);
    expect(tags.get("gTRC")).toEqual(tags.get("rTRC")); // one curve, shared
  });

  it("is built the same every time, and these are its bytes", async () => {
    // A build of its own (the module caches the first one): a date or a random ID would differ.
    vi.resetModules();
    const fresh = (await import("../src/engine/icc")).srgbProfile();
    expect(fresh).toEqual(icc);
    // The bytes, pinned: any change to the profile must be deliberate (and update this).
    expect(icc.length).toBe(2524);
    expect([0, 1, 2, 3, 4, 5].map((i) => view.getUint16(24 + 2 * i))).toEqual([2026, 10, 15, 0, 0, 0]);
    expect(createHash("sha256").update(icc).digest("hex")).toBe("915ffab0a7f7b617770be98089e4c2006710567a8e4facc5ec726ce7057a3da4");
  });

  it("MuPDF loads it as an RGB profile", () => {
    const cs = new mupdf.ColorSpace(icc, "check");
    try {
      expect(cs.isRGB()).toBe(true);
      expect(cs.getNumberOfComponents()).toBe(3);
    } finally {
      cs.destroy();
    }
  });

  it("as the output intent, leaves the render of an RGB page unchanged", () => {
    const page = (withIntent: boolean) => makePdf((doc) => {
      doc.insertPage(-1, doc.addPage([0, 0, 200, 100], 0, {}, "1 0 0 rg 0 0 50 100 re f 0.2 0.6 0.4 rg 50 0 50 100 re f 0.5 g 100 0 50 100 re f 0.9 0.8 0.1 rg 150 0 50 100 re f"));
      if (withIntent) {
        const profile = doc.addStream(srgbProfile(), { N: 3 });
        doc.getTrailer().get("Root").put("OutputIntents", [doc.addObject({ Type: "OutputIntent", S: "GTS_PDFA1", OutputConditionIdentifier: "(sRGB)", DestOutputProfile: profile })]);
      }
    });
    expect(changedPixels(open(page(false)).s.render(0, 1), open(page(true)).s.render(0, 1))).toBe(0);
  });
});

describe("standard fonts", () => {
  it("embeds the 14 standard fonts and their metric twins, nothing else", () => {
    expect(standardFontFor("Helvetica")).toBe("Helvetica");
    expect(standardFontFor("ABCDEF+Times-Bold")).toBe("Times-Bold");
    expect(standardFontFor("Arial")).toBe("Helvetica");
    expect(standardFontFor("Arial,BoldItalic")).toBe("Helvetica-BoldOblique");
    expect(standardFontFor("Arial-BoldMT")).toBe("Helvetica-Bold");
    expect(standardFontFor("TimesNewRomanPS-ItalicMT")).toBe("Times-Italic");
    expect(standardFontFor("Times New Roman,Bold")).toBe("Times-Bold");
    expect(standardFontFor("CourierNewPSMT")).toBe("Courier");
    expect(standardFontFor("ZapfDingbats")).toBe("ZapfDingbats");
    for (const other of ["Calibri", "ArialNarrow", "Arial Narrow", "Verdana", "Helvetica Neue"]) expect(standardFontFor(other)).toBeNull();
  });
});

describe("converting files", () => {
  const fixtures: [string, string?][] = [
    ["chrome-rotate90-crop.pdf"], ["chrome-subset.pdf"], ["enc-user-aes128.pdf", "utente"],
    ["reportlab-form.pdf"], ["type3-matplotlib.pdf"], ["word-winansi.pdf"],
  ];
  for (const [name, password] of fixtures)
    it(`${name}: converts, passes the check, looks the same`, () => {
      const { s, info } = open(fixture(name), password);
      expect(info.pdfa).toBeNull();
      const { report, again } = convert(name.replace(/\.pdf$/, ""), s);
      expect(report.removals).toEqual([]);
      expect(report.warnings).toEqual([]);
      expectSameLook(s, again, Math.min(info.pageCount, 3));
    });

  for (const name of ["typical.pdf", "typical10.pdf", "dense.pdf", "long120.pdf"])
    it.skipIf(!existsSync(new URL(name, EXTRA)))(`${name} (when present): converts and looks the same`, () => {
      const { s, info } = open(new Uint8Array(readFileSync(new URL(name, EXTRA))));
      const { again } = convert(name.replace(/\.pdf$/, ""), s);
      expectSameLook(s, again, Math.min(info.pageCount, 2));
    });

  it("the encrypted file comes out without a password", () => {
    const { s } = open(fixture("enc-user-aes128.pdf"), "utente");
    const { bytes } = convert(null, s);
    const doc = mupdf.Document.openDocument(bytes, "application/pdf");
    try {
      expect(doc.needsPassword()).toBe(false);
    } finally {
      doc.destroy();
    }
  });

  it("embeds a non-embedded Helvetica: same look, metadata in step", () => {
    const { s } = open(helveticaPdf());
    const { report, bytes, again } = convert("synthetic-helvetica", s);
    expect(report).toMatchObject({ blockers: [], removals: [], warnings: [] });
    expect(report.fixes).toBeGreaterThan(0);
    expectSameLook(s, again, 1);
    const doc = mupdf.Document.openDocument(bytes, "application/pdf").asPDF()!;
    try {
      const font = doc.findPage(0).get("Resources", "Font", "F1");
      expect(font.get("FontDescriptor", "FontFile3").isStream()).toBe(true);
      expect(doc.getMetaData("info:Title")).toBe("Fattura n. 12 – città <prova> & co.");
      const xmp = new TextDecoder().decode(doc.getTrailer().get("Root", "Metadata").readStream().asUint8Array());
      expect(xmp).toContain("<rdf:li xml:lang=\"x-default\">Fattura n. 12 – città &lt;prova&gt; &amp; co.</rdf:li>");
      expect(xmp).toContain("<xmp:CreateDate>2026-10-15T10:30:00+02:00</xmp:CreateDate>");
    } finally {
      doc.destroy();
    }
  });

  it("removes scripts, actions, the attachment, the hidden note and the signature, and says so", () => {
    const source = nastyPdf(false);
    expect(open(source).info).toMatchObject({ signatures: 1, pdfa: null });
    const { s } = open(source);
    const { report, bytes, again } = convert("synthetic-fixable", s);
    expect(codes(report.removals)).toEqual([
      "actionsx1", "annotationsx1", "attachments:dati.csvx1", "hidden-fields-shownx1", "javascriptx3", "xfa-data",
    ]);
    expect(codes(report.warnings)).toEqual(["blend-modex1", "signature-invalidx1", "text-may-shift:Arial,Bold"]);
    // Only the Arial line moves (its widths become Helvetica-Bold's): the rest looks the same.
    const before = s.render(0, 0.5), after = again.render(0, 0.5);
    const changed = changedPixels(before, after);
    expect(changed).toBeGreaterThan(0);
    expect(changed).toBeLessThan(before.width * before.height * 0.02);
    // The pop-up note keeps no F (it may omit it: 6.3.2), so it still does not print on its own.
    expect(inspect(bytes, (doc) => annotsOf(doc).get("Popup")!.get("F").isNull())).toBe(true);
    expect(checkTampered(bytes, (d) => annotsOf(d).get("Popup")!.put("F", 24))).toContain("annotation flags (Print, hidden)");
  });

  it("refuses CMYK and a font it cannot embed, and still lists what it would remove", () => {
    const { s } = open(nastyPdf(true));
    const report = expectRefused("synthetic-nasty", s);
    expect(codes(report.blockers)).toEqual(["cmyk", "font-not-embedded:Calibri"]);
    expect(codes(report.removals)).toContain("javascriptx3");
    expect(codes(report.removals)).toContain("attachments:dati.csvx1");
    expect(codes(report.removals)).toContain("annotationsx1");
  });

  it("converts an app edit written with fallback fonts", () => {
    const { s } = open(fixture("word-winansi.pdf"));
    const line = s.lines(0).find((l) => l.text.startsWith("Relazione tecnica"))!;
    const edit = s.replaceLine(0, line.index, "Relazione tecnica 2027 – Ω ≈ π →");
    expect(edit.fallbackChars.length).toBeGreaterThan(0);
    const shown = s.render(0, 0.5);
    const { report, again } = convert("word-winansi-edited", s);
    expect(report).toMatchObject({ blockers: [], removals: [], warnings: [] });
    expect(changedPixels(shown, again.render(0, 0.5))).toBe(0);
    expect(again.lines(0).map((l) => l.text.trim())).toContain("Relazione tecnica 2027 – Ω ≈ π →");
  });

  /** The embedded CIDFontType2 fonts of a file, and whether each has a CIDToGIDMap. */
  const cidFontType2 = (bytes: Uint8Array) => inspect(bytes, (doc) => dictionaries(doc)
    .filter((o) => nameOf(o, "Subtype") === "CIDFontType2" && o.get("FontDescriptor", "FontFile2").isStream())
    .map((o) => ({ name: nameOf(o, "BaseFont"), map: o.get("CIDToGIDMap").toString() })));

  it("converts an app edit written with the symbol and CJK fallback (a CIDFontType2)", () => {
    const { s } = open(fixture("word-winansi.pdf"));
    const line = s.lines(0).find((l) => l.text.startsWith("Relazione tecnica"))!;
    const edit = s.replaceLine(0, line.index, "Relazione tecnica ✓ ● 日本");
    expect(edit.fallbackChars.length).toBeGreaterThan(0);
    expect(edit.missingChars).toEqual([]);
    expect(edit.segments.some((seg) => seg.source === "fallback" && /Droid/.test(seg.fontName))).toBe(true);
    // A normal download already writes the map (core.js), so the font is the same in both.
    const plain = cidFontType2(new Uint8Array(s.save().bytes));
    expect(plain.length).toBeGreaterThan(0);
    expect(plain.every((f) => f.map === "/Identity")).toBe(true);
    const shown = s.render(0, 0.5);
    const { report, bytes, again } = convert("word-winansi-edited-symbols", s);
    expect(report).toMatchObject({ blockers: [], removals: [], warnings: [] });
    expect(cidFontType2(bytes).every((f) => f.map === "/Identity")).toBe(true);
    expect(changedPixels(shown, again.render(0, 0.5))).toBe(0);
    expect(again.lines(0).map((l) => l.text.trim())).toContain("Relazione tecnica ✓ ● 日本");
  });

  it("gives a CIDFontType2 without CIDToGIDMap the Identity one, which changes nothing", () => {
    const source = makePdf((doc) => {
      const font = new mupdf.Font("zh-Hans");
      const f = doc.addFont(font); // MuPDF writes no CIDToGIDMap
      const gids = [..."日本語"].map((ch) => font.encodeCharacter(ch.codePointAt(0)!).toString(16).padStart(4, "0")).join("");
      font.destroy();
      doc.insertPage(-1, doc.addPage([0, 0, 300, 100], 0, { Font: { F: f } }, `BT /F 24 Tf 20 40 Td <${gids}> Tj ET`));
      doc.subsetFonts(); // the whole CJK program is megabytes
    });
    expect(cidFontType2(source).map((f) => f.map)).toEqual(["null"]);
    const { s } = open(source);
    const { bytes, again } = convert("synthetic-cidfonttype2", s);
    expect(cidFontType2(bytes).map((f) => f.map)).toEqual(["/Identity"]);
    expectSameLook(s, again, 1);
    // The engine's check refuses the font without it.
    const problems = checkTampered(bytes, (doc) => {
      for (const o of dictionaries(doc)) if (nameOf(o, "Subtype") === "CIDFontType2") o.delete("CIDToGIDMap");
    });
    expect(problems.some((p) => p.includes("CIDFontType2 without CIDToGIDMap"))).toBe(true);
  });

  it("buttons: one appearance state each, no actions on widgets; a link keeps its action", () => {
    const { s } = open(buttonsPdf());
    const { report, bytes, again } = convert("synthetic-buttons", s);
    expect(codes(report.removals)).toEqual(["actionsx3"]); // the submit, the web page, the page turn
    expect(report.warnings).toEqual([]);
    expectSameLook(s, again, 1);
    inspect(bytes, (doc) => {
      const a = annotsOf(doc);
      for (const [name, state] of [["Invia", "On"], ["Stampa", "On"], ["Conferma", "Yes"]]) {
        const w = a.get(name)!;
        expect(w.get("A").isNull(), name).toBe(true);
        expect(nameOf(w, "AS"), name).toBe(state);
        const n = w.get("AP", "N");
        expect(n.isStream(), name).toBe(false);
        expect(n.get(state).isStream(), name).toBe(true);
      }
      expect(a.get("Stampa")!.get("Parent", "A").isNull()).toBe(true); // the field's own
      const text = a.get("Nome")!;
      expect(text.get("AP", "N").isStream()).toBe(true);
      expect(text.get("AS").isNull()).toBe(true);
      expect(nameOf(a.get("Link")!.get("A"), "S")).toBe("URI");
    });
    // The engine's check refuses each one undone.
    const widget = (doc: mupdf.PDFDocument, name: string) => annotsOf(doc).get(name)!;
    expect(checkTampered(bytes, (d) => widget(d, "Invia").get("AP").put("N", widget(d, "Invia").get("AP", "N", "On")))).toContain("button appearance (N) is not a dictionary of states");
    expect(checkTampered(bytes, (d) => widget(d, "Stampa").put("A", d.addObject({ S: "URI", URI: "(https://example.org)" })))).toContain("widget action (A)");
    expect(checkTampered(bytes, (d) => widget(d, "Nome").get("AP").put("N", { Pieno: widget(d, "Nome").get("AP", "N") }))).toContain("appearance (N) is not a stream");
  });

  it("removes the XMP of pages and images (design tools' schemas), nothing else", () => {
    const xmp = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:illustrator="http://ns.adobe.com/illustrator/1.0/"><illustrator:Type>Document</illustrator:Type></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
    const { s } = open(makePdf((doc) => {
      const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 8, 8], false);
      pix.clear(120);
      const image = new mupdf.Image(pix);
      const img = doc.addImage(image);
      image.destroy();
      pix.destroy();
      img.put("Metadata", doc.addStream(xmp, { Type: "Metadata", Subtype: "XML" }));
      doc.insertPage(-1, doc.addPage([0, 0, 200, 100], 0, { XObject: { Im1: img } }, "q 50 0 0 50 10 10 cm /Im1 Do Q"));
      doc.findPage(0).put("Metadata", doc.addStream(xmp, { Type: "Metadata", Subtype: "XML" }));
    }));
    const { report, bytes, again } = convert("synthetic-object-xmp", s);
    expect(report).toMatchObject({ blockers: [], removals: [], warnings: [] });
    expectSameLook(s, again, 1);
    inspect(bytes, (doc) => {
      const withXmp = dictionaries(doc).filter((o) => !o.get("Metadata").isNull()).map((o) => nameOf(o, "Type"));
      expect(withXmp).toEqual(["Catalog"]);
    });
    expect(checkTampered(bytes, (d) => d.findPage(0).put("Metadata", d.addStream(xmp, { Type: "Metadata", Subtype: "XML" })))).toContain("object-level XMP metadata");
  });

  it("annotations of zero width (not zero size) get an appearance", () => {
    const { s } = open(makePdf((doc) => {
      const helv = simpleFont(doc, "Helvetica");
      doc.insertPage(-1, doc.addPage([0, 0, 300, 300], 0, {}, "0 0 1 rg 10 10 50 50 re f"));
      const pageObj = doc.findPage(0);
      const square = doc.addObject({ Type: "Annot", Subtype: "Square", Rect: [100, 100, 100, 200], F: 4, P: pageObj, C: [1, 0, 0] });
      const field = doc.addObject({ Type: "Annot", Subtype: "Widget", FT: "Tx", T: "(Stretto)", V: "(x)", Rect: [150, 100, 150, 200], F: 4, P: pageObj, DA: "(/Helv 10 Tf 0 g)" });
      pageObj.put("Annots", [square, field]);
      doc.getTrailer().get("Root").put("AcroForm", doc.addObject({ Fields: [field], DR: { Font: { Helv: helv } } }));
    }));
    const { report, bytes } = convert("synthetic-zero-width", s);
    expect(report).toMatchObject({ blockers: [], removals: [], warnings: [] });
    inspect(bytes, (doc) => {
      for (const name of ["Square", "Stretto"]) expect(annotsOf(doc).get(name)!.get("AP", "N").isStream(), name).toBe(true);
    });
    for (const name of ["Square", "Stretto"])
      expect(checkTampered(bytes, (d) => annotsOf(d).get(name)!.delete("AP"))).toContain("annotation without appearance");
    // Zero size, width AND height, needs none.
    expect(checkTampered(bytes, (d) => {
      const square = annotsOf(d).get("Square")!;
      square.delete("AP");
      square.put("Rect", [100, 100, 100, 100]);
    })).toEqual([]);
  });

  it("replaces an output intent whose profile is of another class or colour space", () => {
    const profile = (cls: string, space: string) => {
      const p = srgbProfile();
      for (let i = 0; i < 4; i++) {
        p[12 + i] = cls.charCodeAt(i);
        p[16 + i] = space.charCodeAt(i);
      }
      return p;
    };
    const withIntent = (bytes: Uint8Array) => makePdf((doc) => {
      doc.insertPage(-1, doc.addPage([0, 0, 200, 100], 0, {}, "0 0 1 rg 10 10 50 50 re f"));
      doc.getTrailer().get("Root").put("OutputIntents", [doc.addObject({ Type: "OutputIntent", S: "GTS_PDFA1", OutputConditionIdentifier: "(x)", DestOutputProfile: doc.addStream(bytes, { N: 3 }) })]);
    });
    const intentClass = (bytes: Uint8Array) => inspect(bytes, (doc) => {
      const p = doc.getTrailer().get("Root", "OutputIntents", 0, "DestOutputProfile").readStream();
      try {
        return String.fromCharCode(...p.asUint8Array().subarray(12, 20));
      } finally {
        p.destroy();
      }
    });
    const { report, bytes } = convert("synthetic-output-intent-class", open(withIntent(profile("scnr", "Lab "))).s);
    expect(codes(report.warnings)).toEqual(["output-intent-replaced"]);
    expect(intentClass(bytes)).toBe("mntrRGB ");
    expect(codes(convert(null, open(withIntent(profile("spac", "RGB "))).s).report.warnings)).toEqual(["output-intent-replaced"]);
    // A valid display profile of the file's own stays.
    expect(convert(null, open(withIntent(srgbProfile())).s).report.warnings).toEqual([]);
    // The engine's check refuses a scanner profile as the output intent.
    const problems = checkTampered(bytes, (d) => d.getTrailer().get("Root", "OutputIntents", 0).put("DestOutputProfile", d.addStream(profile("scnr", "RGB "), { N: 3 })));
    expect(problems).toContain("output intent profile: profile class scnr (an output intent needs prtr or mntr)");
  });

  it("fixes alternate presentations, page steps, rendering intents and font types", () => {
    const { s } = open(makePdf((doc) => {
      const helv = doc.addObject({ Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" }); // no /Type
      const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 8, 8], false);
      pix.clear(80);
      const image = new mupdf.Image(pix);
      const img = doc.addImage(image);
      image.destroy();
      pix.destroy();
      img.put("Intent", "Vivid");
      const ops = [
        "q /GS1 gs /Unknown ri 0 0 1 rg 10 10 50 50 re f Q",
        "BT /F1 12 Tf 10 80 Td (Intenti di resa) Tj ET",
        "q 20 0 0 20 80 10 cm BI /W 2 /H 2 /CS /RGB /BPC 8 /Intent /Vivid /F /AHx ID ff000000ff000000ffffffff> EI Q",
        "q 30 0 0 30 120 10 cm /Im1 Do Q",
      ].join("\n");
      doc.insertPage(-1, doc.addPage([0, 0, 200, 100], 0, {
        Font: { F1: helv }, XObject: { Im1: img }, ExtGState: { GS1: doc.addObject({ Type: "ExtGState", RI: "Fancy" }) },
      }, ops));
      doc.findPage(0).put("PresSteps", doc.addObject({ Type: "NavNode" }));
      const root = doc.getTrailer().get("Root");
      root.put("Names", doc.addObject({ AlternatePresentations: doc.addObject({ Names: ["(show)", doc.addObject({ Type: "SlideShow", Subtype: "Embedded" })] }) }));
    }));
    const { report, bytes, again } = convert("synthetic-small-rules", s);
    expect(report).toMatchObject({ blockers: [], removals: [], warnings: [] });
    expectSameLook(s, again, 1);
    inspect(bytes, (doc) => {
      const page = doc.findPage(0);
      expect(page.get("PresSteps").isNull()).toBe(true);
      expect(doc.getTrailer().get("Root", "Names", "AlternatePresentations").isNull()).toBe(true);
      expect(nameOf(page.get("Resources", "Font", "F1"), "Type")).toBe("Font");
      expect(nameOf(page.get("Resources", "ExtGState", "GS1"), "RI")).toBe("RelativeColorimetric");
      expect(nameOf(page.get("Resources", "XObject", "Im1"), "Intent")).toBe("RelativeColorimetric");
      const content = pageContent(doc);
      expect(content).toContain("/RelativeColorimetric ri");
      expect(content).toContain("/Intent /RelativeColorimetric");
      expect(content).not.toMatch(/Unknown|Vivid/);
    });
    // The engine's check refuses each one undone.
    const res = (d: mupdf.PDFDocument, ...path: string[]) => d.findPage(0).get("Resources", ...path);
    expect(checkTampered(bytes, (d) => d.findPage(0).put("PresSteps", d.addObject({ Type: "NavNode" })))).toContain("presentation steps (PresSteps)");
    expect(checkTampered(bytes, (d) => d.getTrailer().get("Root").put("Names", d.addObject({ AlternatePresentations: d.addObject({ Names: [] }) })))).toContain("alternate presentations");
    expect(checkTampered(bytes, (d) => res(d, "Font", "F1").delete("Type"))).toContain("font dictionary without /Type /Font");
    expect(checkTampered(bytes, (d) => res(d, "ExtGState", "GS1").put("RI", "Fancy"))).toContain("graphics state rendering intent");
    expect(checkTampered(bytes, (d) => res(d, "XObject", "Im1").put("Intent", "Vivid"))).toContain("image rendering intent");
    expect(checkTampered(bytes, (d) => d.findPage(0).put("Contents", d.addStream("/Unknown ri 0 0 1 rg 10 10 50 50 re f", {})))).toContain("rendering intent in content (ri, inline image)");
  });

  it("keeps the CMYK output intent of a print PDF/A, and its DeviceCMYK", () => {
    const { s, info } = open(printPdf("none"));
    expect(info.pdfa).toBe("1B");
    const { report, bytes, again } = convert("synthetic-cmyk-intent", s);
    expect(report).toMatchObject({ blockers: [], removals: [], warnings: [] });
    expectSameLook(s, again, 1);
    inspect(bytes, (doc) => {
      const p = doc.getTrailer().get("Root", "OutputIntents", 0, "DestOutputProfile");
      const buf = p.readStream();
      try {
        expect(buf.asUint8Array().slice()).toEqual(cmykProfile());
      } finally {
        buf.destroy();
      }
    });
    // The engine's check refuses RGB under that intent.
    expect(checkTampered(bytes, (d) => d.findPage(0).put("Contents", d.addStream("1 0 0 rg 10 10 50 50 re f", {})))).toContain("DeviceRGB with a CMYK output intent");
  });

  it("refuses a CMYK-intent file that also paints in RGB (an annotation), and checks the same", () => {
    const source = printPdf("annotation");
    const report = expectRefused("cmyk-intent-with-rgb", open(source).s);
    expect(codes(report.blockers)).toEqual(["cmyk"]);
    expect(forcedCheck(source)).toContain("DeviceCMYK");
  });

  it("gives a CMYK-intent file that paints only in RGB our sRGB intent", () => {
    const { s } = open(makePdf((doc) => {
      doc.insertPage(-1, doc.addPage([0, 0, 200, 100], 0, {}, "1 0 0 rg 10 10 50 50 re f"));
      doc.getTrailer().get("Root").put("OutputIntents", [doc.addObject({ Type: "OutputIntent", S: "GTS_PDFA1", OutputConditionIdentifier: "(Test CMYK)", DestOutputProfile: doc.addStream(cmykProfile(), { N: 4 }) })]);
    }));
    const { report } = convert("synthetic-cmyk-intent-rgb-only", s);
    expect(codes(report.warnings)).toEqual(["output-intent-replaced"]);
  });

  it("CMYK under a DefaultCMYK profile is not DeviceCMYK: it converts with our sRGB intent", () => {
    const { s } = open(makePdf((doc) => {
      const cmyk = doc.addStream(cmykProfile(), { N: 4 });
      doc.insertPage(-1, doc.addPage([0, 0, 200, 100], 0, { ColorSpace: { DefaultCMYK: ["ICCBased", cmyk] } }, "0.1 0.6 0 0 k 10 10 50 50 re f 0 0 0 1 K 2 w 80 10 50 50 re S"));
    }));
    const { report, again } = convert("synthetic-default-cmyk", s);
    expect(report).toMatchObject({ blockers: [], removals: [], warnings: [] });
    expectSameLook(s, again, 1);
  });

  it("merged files: a standard font dictionary on every page is probed and described once", () => {
    const pages = 12;
    const { s } = open(makePdf((doc) => {
      for (let i = 0; i < pages; i++) {
        const helv = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" });
        doc.insertPage(-1, doc.addPage([0, 0, 200, 100], 0, { Font: { F1: helv } }, `BT /F1 12 Tf 10 50 Td (Pagina ${i + 1}) Tj ET`));
      }
    }));
    const { report, bytes, again } = convert("synthetic-merged", s);
    expect(report).toMatchObject({ blockers: [], removals: [], warnings: [] });
    expectSameLook(s, again, 2);
    const descriptors = inspect(bytes, (doc) => new Set([...Array(pages).keys()].map((i) => doc.findPage(i).get("Resources", "Font", "F1", "FontDescriptor").asIndirect())));
    expect(descriptors.size).toBe(1);
  });

  it("converting a PDF/A file again changes nothing that matters", () => {
    const first = convert(null, open(helveticaPdf()).s);
    const second = convert("synthetic-helvetica-twice", first.again);
    expect(second.report).toMatchObject({ blockers: [], removals: [], warnings: [] });
    expect(Math.abs(second.bytes.length - first.bytes.length)).toBeLessThan(200);
    expectSameLook(first.again, second.again, 1);
  });

  it("replaces an output intent PDF/A cannot use, and says so", () => {
    const { s } = open(makePdf((doc) => {
      doc.insertPage(-1, doc.addPage([0, 0, 200, 100], 0, {}, "0 0 1 rg 10 10 50 50 re f"));
      const profile = doc.addStream(srgbProfile(), { N: 3 });
      doc.getTrailer().get("Root").put("OutputIntents", [doc.addObject({ Type: "OutputIntent", S: "GTS_PDFX", OutputConditionIdentifier: "(x)", DestOutputProfile: profile })]);
    }));
    const { report } = convert("synthetic-output-intent", s);
    expect(codes(report.warnings)).toEqual(["output-intent-replaced"]);
  });
});

describe("what blocks", () => {
  const page = (doc: mupdf.PDFDocument, resources: Record<string, unknown>, ops: string) =>
    doc.insertPage(-1, doc.addPage([0, 0, 300, 100], 0, resources, ops));
  /** A layer (optional content group) that is off by default. */
  const hiddenLayer = (doc: mupdf.PDFDocument) => {
    const ocg = doc.addObject({ Type: "OCG", Name: "(Segni di stampa)" });
    doc.getTrailer().get("Root").put("OCProperties", doc.addObject({ OCGs: [ocg], D: { Name: "(Predefinita)", Order: [ocg], OFF: [ocg] } }));
    return ocg;
  };
  /** Helvetica embedded, Identity-H: <0000> is glyph 0, .notdef. */
  const embeddedHelvetica = (doc: mupdf.PDFDocument) => {
    const font = new mupdf.Font("Helvetica");
    try {
      return doc.addFont(font);
    } finally {
      font.destroy();
    }
  };
  const NOTDEF = ".notdef glyph drawn (NimbusSans-Regular)";

  /** Name, file, the blockers, and what the engine's check says of it converted all the same. */
  const cases: [string, () => Uint8Array, string[], string][] = [
    ["notdef", () => makePdf((doc) => {
      const font = new mupdf.Font("Helvetica");
      const f = doc.addFont(font); // embedded, Identity-H: <0000> is glyph 0, .notdef
      font.destroy();
      page(doc, { Font: { F: f } }, "BT /F 20 Tf 10 50 Td <00000024> Tj ET");
    }), ["notdef:NimbusSans-Regularx1"], NOTDEF],
    ["icc-invalid", () => makePdf((doc) => {
      const bad = doc.addStream("not an ICC profile, only text pretending", { N: 3 });
      page(doc, { ColorSpace: { CS0: ["ICCBased", bad] } }, "/CS0 cs 1 0 0 sc 10 10 100 50 re f");
    }), ["icc-invalidx1"], "invalid ICC profile"],
    ["external-content", () => makePdf((doc) => {
      const form = doc.addStream("0 0 1 rg 0 0 10 10 re f", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 10, 10], Ref: { F: "(other.pdf)", Page: 0 } });
      page(doc, { XObject: { Fm0: form } }, "/Fm0 Do");
    }), ["external-contentx1"], "external content"],
    ["xfa-dynamic", () => makePdf((doc) => {
      page(doc, {}, "0 0 1 rg 10 10 50 50 re f");
      doc.getTrailer().get("Root").put("AcroForm", doc.addObject({ Fields: [], XFA: doc.addStream("<xdp:xdp/>", {}) }));
    }), ["xfa-dynamic"], "NeedAppearances or XFA"],
    ["portfolio", () => makePdf((doc) => {
      page(doc, {}, "0 0 1 rg 10 10 50 50 re f");
      doc.getTrailer().get("Root").put("Collection", doc.addObject({ Type: "Collection", View: "D" }));
    }), ["portfolio"], "portfolio"],
    ["cmyk-shading", () => makePdf((doc) => {
      // DeviceCMYK only in a shading, which the device scan does not report.
      const shading = doc.addObject({ ShadingType: 2, ColorSpace: "DeviceCMYK", Coords: [0, 0, 300, 0], Function: { FunctionType: 2, Domain: [0, 1], C0: [0, 0, 0, 0], C1: [1, 0, 0, 0], N: 1 } });
      page(doc, { Shading: { Sh0: shading } }, "/Sh0 sh");
    }), ["cmyk"], "DeviceCMYK"],
    // What MuPDF does not draw, but veraPDF reads all the same: a layer that is off, a form
    // XObject in such a layer, an appearance state not shown, invisible text.
    ["cmyk-hidden-layer", () => makePdf((doc) => {
      const ocg = hiddenLayer(doc);
      page(doc, { Properties: { oc1: ocg } }, "0 0 1 rg 10 10 50 50 re f /OC /oc1 BDC 0 0 0 1 k 100 10 50 50 re f EMC");
    }), ["cmyk"], "DeviceCMYK"],
    ["cmyk-inline-image-hidden", () => makePdf((doc) => {
      const ocg = hiddenLayer(doc);
      page(doc, { Properties: { oc1: ocg } }, "0 0 1 rg 10 10 50 50 re f /OC /oc1 BDC q 20 0 0 20 100 10 cm BI /W 1 /H 1 /CS /CMYK /BPC 8 /F /AHx ID 00ff00ff> EI Q EMC");
    }), ["cmyk"], "DeviceCMYK"],
    ["cmyk-checkbox-state", () => makePdf((doc) => {
      page(doc, {}, "0 0 1 rg 10 10 50 50 re f");
      const pageObj = doc.findPage(0);
      // Not ticked: the "Yes" appearance, in CMYK, is never drawn.
      const box = doc.addObject({
        Type: "Annot", Subtype: "Widget", FT: "Btn", T: "(Spunta)", V: "Off", AS: "Off", Rect: [100, 20, 120, 40], F: 4, P: pageObj,
        AP: { N: { Yes: look(doc, "0 0 0 1 k 3 3 14 14 re f", 20, 20), Off: look(doc, "0.5 g 0 0 20 20 re S", 20, 20) } },
      });
      pageObj.put("Annots", [box]);
      doc.getTrailer().get("Root").put("AcroForm", doc.addObject({ Fields: [box] }));
    }), ["cmyk"], "DeviceCMYK"],
    ["notdef-hidden-layer", () => makePdf((doc) => {
      const ocg = hiddenLayer(doc);
      page(doc, { Font: { F: embeddedHelvetica(doc) }, Properties: { oc1: ocg } }, "BT /F 20 Tf 10 50 Td <0024> Tj ET /OC /oc1 BDC BT /F 20 Tf 10 20 Td <0000> Tj ET EMC");
    }), ["notdef:NimbusSans-Regularx1"], NOTDEF],
    ["notdef-hidden-form", () => makePdf((doc) => {
      const ocg = hiddenLayer(doc);
      const form = doc.addStream("BT /F 20 Tf 0 0 Td <0000> Tj ET", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 100, 30], OC: ocg, Resources: { Font: { F: embeddedHelvetica(doc) } } });
      page(doc, { XObject: { Fm0: form } }, "0 0 1 rg 10 10 50 50 re f q 1 0 0 1 100 20 cm /Fm0 Do Q");
    }), ["notdef:NimbusSans-Regularx1"], NOTDEF],
    ["notdef-invisible", () => makePdf((doc) => {
      page(doc, { Font: { F: embeddedHelvetica(doc) } }, "BT /F 20 Tf 10 50 Td <0024> Tj ET BT 3 Tr /F 20 Tf 10 20 Td <0000> Tj ET");
    }), ["notdef:NimbusSans-Regularx1"], NOTDEF],
  ];
  for (const [name, make, expected, check] of cases)
    it(name, () => {
      const source = make();
      const report = expectRefused(name, open(source).s);
      expect(codes(report.blockers)).toEqual(expected);
      // Converted all the same, the file fails the engine's check: it is never handed out.
      expect(forcedCheck(source)).toContain(check);
    });

  it("widths that disagree with an embedded font program", () => {
    const { bytes } = convert(null, open(helveticaPdf()).s);
    // The converted file, with one width of the embedded Helvetica changed.
    const doc = mupdf.Document.openDocument(bytes, "application/pdf").asPDF()!;
    let tampered: Uint8Array;
    try {
      doc.findPage(0).get("Resources", "Font", "F1", "Widths").put(65, 300); // "A"
      const buf = doc.saveToBuffer("");
      tampered = buf.asUint8Array().slice();
      buf.destroy();
    } finally {
      doc.destroy();
    }
    expect(checkPdfA(mupdf, tampered)).toContain("font Helvetica: widths differ from the program");
    const report = expectRefused("font-widths", open(tampered).s);
    expect(codes(report.blockers)).toEqual(["font-widths:Helvetica"]);
  });

  // PDF/A requires embedding only the fonts used to draw. veraPDF reaches fonts through the
  // text-showing operators of the content, in every rendering mode, and applies the other font
  // rules to invisible text too: these files test that reading in CI.
  /** A complete dictionary for a TrueType "Calibri" that the file does not embed. */
  const calibriDict = (doc: mupdf.PDFDocument) => doc.addObject({
    Type: "Font", Subtype: "TrueType", BaseFont: "Calibri", FirstChar: 32, LastChar: 126, Widths: Array(95).fill(500), Encoding: "WinAnsiEncoding",
    FontDescriptor: doc.addObject({ Type: "FontDescriptor", FontName: "Calibri", Flags: 32, FontBBox: [-503, -250, 1240, 750], ItalicAngle: 0, Ascent: 750, Descent: -250, CapHeight: 632, StemV: 80 }),
  });

  it("a non-embedded font used only for invisible text (OCR) does not block", () => {
    const { s } = open(makePdf((doc) => {
      page(doc, { Font: { F: calibriDict(doc) } }, "0 0 1 rg 10 10 50 50 re f BT 3 Tr /F 12 Tf 10 50 Td (testo OCR) Tj ET");
    }));
    convert("synthetic-invisible-text", s);
  });

  it("an OCR font without widths gets them, and its text stays where it was", () => {
    const { s } = open(makePdf((doc) => {
      const calibri = calibriDict(doc);
      for (const key of ["FirstChar", "LastChar", "Widths"]) calibri.delete(key);
      page(doc, { Font: { F: calibri } }, "0 0 1 rg 10 10 50 50 re f BT 3 Tr /F 12 Tf 10 50 Td (testo OCR senza larghezze) Tj ET");
    }));
    const before = s.lines(0).map((l) => [l.text, l.bbox]);
    const { report, bytes, again } = convert("synthetic-invisible-text-no-widths", s);
    expect(report).toMatchObject({ blockers: [], removals: [], warnings: [] });
    expect(again.lines(0).map((l) => [l.text, l.bbox])).toEqual(before);
    inspect(bytes, (doc) => {
      const font = doc.findPage(0).get("Resources", "Font", "F");
      expect([font.get("FirstChar").asNumber(), font.get("LastChar").asNumber(), font.get("Widths").length]).toEqual([0, 255, 256]);
      expect(font.get("FontDescriptor", "FontFile2").isNull()).toBe(true); // still not embedded
    });
    expect(checkTampered(bytes, (d) => d.findPage(0).get("Resources", "Font", "F").delete("Widths"))).toContain("font Calibri: FirstChar, LastChar or Widths missing");
  });

  it("a missing CJK font in invisible text: no .notdef from MuPDF's stand-in, no blocker", () => {
    const { s } = open(makePdf((doc) => {
      const gothic = doc.addObject({
        Type: "Font", Subtype: "Type0", BaseFont: "MSGothic", Encoding: "Identity-H",
        DescendantFonts: [doc.addObject({
          Type: "Font", Subtype: "CIDFontType2", BaseFont: "MSGothic", CIDSystemInfo: { Registry: "(Adobe)", Ordering: "(Identity)", Supplement: 0 },
          FontDescriptor: doc.addObject({ Type: "FontDescriptor", FontName: "MSGothic", Flags: 4, FontBBox: [0, -141, 1000, 859], ItalicAngle: 0, Ascent: 859, Descent: -141, CapHeight: 769, StemV: 80 }),
        })],
      });
      page(doc, { Font: { F: gothic } }, "0 0 1 rg 10 10 50 50 re f BT 3 Tr /F 12 Tf 10 50 Td <30423042FFFF> Tj ET");
    }));
    const { bytes } = convert("synthetic-invisible-cjk", s);
    expect(checkPdfA(mupdf, bytes)).toEqual([]);
  });

  it("a non-embedded font that nothing draws with does not block", () => {
    const { s } = open(makePdf((doc) => {
      page(doc, { Font: { F: calibriDict(doc) } }, "0 0 1 rg 10 10 50 50 re f");
    }));
    convert("synthetic-unused-font", s);
  });
});

describe("the engine's check", () => {
  it("catches what a conversion must have done", () => {
    const { bytes } = convert(null, open(helveticaPdf()).s);
    const tamper = (change: (doc: mupdf.PDFDocument) => void, options = "") => checkTampered(bytes, change, options);
    const root = (doc: mupdf.PDFDocument) => doc.getTrailer().get("Root");
    expect(tamper(() => {})).toEqual([]);
    expect(tamper((d) => root(d).delete("OutputIntents"))).toContain("not exactly one output intent");
    expect(tamper((d) => root(d).delete("Metadata"))).toContain("no XMP metadata");
    expect(tamper((d) => d.getTrailer().get("Info").put("Title", d.newString("altro")))).toContain("Info and XMP differ: Title");
    expect(tamper((d) => d.findPage(0).get("Resources", "Font", "F1", "FontDescriptor").delete("FontFile3"))).toContain("font Helvetica not embedded");
    expect(tamper((d) => root(d).put("OpenAction", d.addObject({ S: "JavaScript", JS: "(1)" })))).toContain("forbidden action JavaScript");
    expect(tamper(() => {}, "encrypt=aes-256,user-password=x,owner-password=x")).toContain("encrypted");
  });

  it("fails a file saved without the conversion, and passes it converted", () => {
    const plain = new Uint8Array(open(fixture("chrome-subset.pdf")).s.save().bytes);
    expect(checkPdfA(mupdf, plain)).toEqual(expect.arrayContaining(["no file identifier (/ID)", "not exactly one output intent", "no XMP metadata"]));
    const doc = mupdf.Document.openDocument(plain, "application/pdf").asPDF()!;
    try {
      expect(convertToPdfA(mupdf, doc, { now: new Date("2026-10-15T12:00:00Z") }).blockers).toEqual([]);
      const buf = doc.saveToBuffer("garbage=compact,compress=yes,encrypt=none");
      try {
        expect(checkPdfA(mupdf, buf.asUint8Array().slice())).toEqual([]);
      } finally {
        buf.destroy();
      }
    } finally {
      doc.destroy();
    }
  });
});
