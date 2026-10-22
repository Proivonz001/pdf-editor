// Cerca (src/engine/search.ts), in Node on the worker's mupdf build (1.27.0): every case of the
// release 5 research's table (case, accents, apostrophes and quotes, dashes, spaces, ligatures,
// a decomposed accent, TeX accents, hyphenated line ends, lines, vertical and rotated text, CJK,
// notes, text a reader does not see), quads equal to MuPDF's own search wherever MuPDF finds the
// hit too, the three options, visible form fields (not password fields, not Hidden or NoView
// widgets), characters beyond U+FFFF, every fixture of the app and of the prototype, every MuPDF
// object destroyed, the size of a PageText and the speed over 600 dense pages.
//
// Fixtures (no personal data): search-chrome-it.pdf (headless Chrome, Calibri and Cambria:
// justified and hyphenated Italian, ligatures, a soft hyphen, vertical-rl Japanese, text rotated
// by 90° and slanted by 30°, NBSP), search-dense-it.pdf (two dense pages, two columns of 10 pt
// justified Italian, Chrome), the prototype's cjk-identity-v.pdf (vertical text, wmode 1); the
// research's synth.pdf, apos.pdf and hidden-text page, a form, and pages with characters beyond
// U+FFFF are built here with MuPDF's object API.
import { readFileSync, readdirSync } from "node:fs";
import * as mupdf from "mupdf";
import { afterEach, describe, expect, it } from "vitest";
import { applyFieldEdit, planFieldEdit } from "../src/engine/forms";
import { MAX_SEARCH_CHARS, type Quad, type Rect, type SearchHit, type SearchOptions } from "../src/engine/protocol";
import { normalizeQuery, readPageText, searchPageText, type PageText } from "../src/engine/search";

const FIXTURES = new URL("./fixtures/", import.meta.url);
const PROTOTYPE_FIXTURES = new URL("../../prototypes/mupdf-text/fixtures/", import.meta.url);
const fixture = (name: string, dir = FIXTURES) => new Uint8Array(readFileSync(new URL(name, dir)));

/** Documents opened by a test, destroyed after it (rule 5). */
let opened: mupdf.PDFDocument[] = [];
afterEach(() => {
  for (const doc of opened) doc.destroy();
  opened = [];
});
const openBytes = (bytes: Uint8Array) => {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf").asPDF()!;
  opened.push(doc);
  return doc;
};

function saveBytes(doc: mupdf.PDFDocument, options = "garbage=compact"): Uint8Array {
  const buf = doc.saveToBuffer(options);
  try {
    return buf.asUint8Array().slice();
  } finally {
    buf.destroy();
  }
}

/** Builds a document with `make` on a new PDFDocument, saved and opened again (as a user's file). */
function built(make: (doc: mupdf.PDFDocument) => void): mupdf.PDFDocument {
  const doc = new mupdf.PDFDocument();
  try {
    make(doc);
    return openBytes(saveBytes(doc));
  } finally {
    doc.destroy();
  }
}

const texts = (doc: mupdf.PDFDocument) => Array.from({ length: doc.countPages() }, (_, p) => readPageText(mupdf, doc, p));
const searchAll = (pages: PageText[], query: string, options: SearchOptions = {}) => pages.flatMap((t) => searchPageText(t, query, options, 10_000));
const find = (doc: mupdf.PDFDocument, query: string, options: SearchOptions = {}) => searchAll(texts(doc), query, options);
const matches = (hits: SearchHit[]) => hits.map((h) => h.match);
const onPage = (hits: SearchHit[], p: number) => hits.filter((h) => h.pageIndex === p);

/** MuPDF's own search, page by page: each hit's quads. */
function muSearch(doc: mupdf.PDFDocument, query: string): { pageIndex: number; quads: Quad[] }[] {
  const out: { pageIndex: number; quads: Quad[] }[] = [];
  for (let p = 0; p < doc.countPages(); p++) {
    const page = doc.loadPage(p);
    try {
      for (const quads of page.search(query, 1000)) out.push({ pageIndex: p, quads: quads.map((q) => [...q] as Quad) });
    } finally {
      page.destroy();
    }
  }
  return out;
}

/** The largest difference between two hits' quad corners (Infinity when they have not as many quads). */
function cornerDifference(a: Quad[], b: Quad[]): number {
  if (a.length !== b.length) return Infinity;
  let worst = 0;
  a.forEach((q, k) => q.forEach((v, j) => (worst = Math.max(worst, Math.abs(v - b[k][j])))));
  return worst;
}

const isQuad = (q: Quad) => q.length === 8 && q.every(Number.isFinite);
/** Whether page-space rect r lies inside `pdfRect` (PDF space, y up) of an A4 page without /Rotate. */
const inside = (r: Rect, pdfRect: Rect, slack = 0.5) => {
  const outer = [pdfRect[0], 842 - pdfRect[3], pdfRect[2], 842 - pdfRect[1]];
  return r[0] >= outer[0] - slack && r[1] >= outer[1] - slack && r[2] <= outer[2] + slack && r[3] <= outer[3] + slack;
};

// ---------------------------------------------------------------------------------------------
// Built documents

/** WinAnsi codes of the few characters outside Latin-1 used here. */
const WIN: Record<string, number> = { "’": 0x92, "‘": 0x91, "“": 0x93, "”": 0x94, "–": 0x96, "—": 0x97, "Œ": 0x8c, "œ": 0x9c, "€": 0x80 };
/** Text as a PDF hex string in WinAnsi (or any one-byte encoding: codes below 256 as they are). */
const hex = (s: string) => "<" + [...s].map((c) => (WIN[c] ?? c.charCodeAt(0)).toString(16).padStart(2, "0")).join("") + ">";
const NL = String.fromCharCode(10);

function addBase14(doc: mupdf.PDFDocument, name = "Times-Roman"): mupdf.PDFObject {
  const font = new mupdf.Font(name);
  try {
    return doc.addSimpleFont(font, "Latin");
  } finally {
    font.destroy();
  }
}

/** A /ToUnicode CMap for one-byte codes, from "<code> <UTF-16BE>" pairs. */
const toUnicode = (pairs: string[]) => [
  "/CIDInit /ProcSet findresource begin 12 dict begin begincmap",
  "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
  "/CMapName /Adobe-Identity-UCS def /CMapType 2 def",
  "1 begincodespacerange <00> <FF> endcodespacerange",
  `${pairs.length} beginbfchar ${pairs.join(" ")} endbfchar`,
  "endcmap CMapName currentdict /CMap defineresource pop end end",
].join(NL);

/**
 * The research's synth.pdf: WinAnsi Italian, ligatures from glyph names (F2) and from /ToUnicode
 * (F3), a decomposed accent from /ToUnicode, a TeX OT1 grave accent kerned back over the next
 * letter, a word hyphenated at a line end, a sentence over two lines, three spaces, a kerned TJ,
 * a Td gap; the same page with /Rotate 90 and 270; a page with notes (FreeText, Text, Highlight).
 */
function synth(): mupdf.PDFDocument {
  return built((doc) => {
    const F1 = addBase14(doc);
    const lig = (unicode: boolean) => {
      const d = doc.addObject({
        Type: "Font", Subtype: "Type1", BaseFont: "Times-Roman",
        Encoding: { BaseEncoding: "WinAnsiEncoding", Differences: [1, "fi", "fl", 5, "eacute", 6, "grave"] },
      });
      if (unicode) d.put("ToUnicode", doc.addStream(toUnicode(["<01> <00660069>", "<02> <0066006C>", "<05> <00650301>"]), {}));
      return d;
    };
    const F2 = lig(false), F3 = lig(true);
    const rows: [string, number, number, string][] = [
      ["F1", 50, 800, `${hex("Università di Bologna, perché è così. È UNIVERSITÀ.")} Tj`],
      ["F1", 50, 784, `${hex(`L’Aquila e l'Aquila, “citazione” e "virgolette", «guillemets».`)} Tj`],
      ["F1", 50, 768, `${hex("Straße, Œuvre, cœur, Æsop, 2020–2021, prezzo 100 €.")} Tj`],
      ["F1", 50, 752, `${hex("Un’infor-")} Tj`],
      ["F1", 50, 736, `${hex("mazione completa e una parola-chiave nel mezzo.")} Tj`],
      ["F1", 50, 720, `${hex("alla fine della")} Tj`],
      ["F1", 50, 704, `${hex("frase spezzata su due righe.")} Tj`],
      ["F1", 50, 688, `${hex("doppio   spazio qui.")} Tj`],
      ["F1", 50, 672, `[${hex("Uni")} -60 ${hex("versità")} 400 ${hex("separata")}] TJ`],
      ["F1", 50, 656, `${hex("parola")} Tj 60 0 Td ${hex("seguente")} Tj`],
      ["F2", 50, 640, `${hex("uf\x01cio \x02uido of\x01cina")} Tj`],
      ["F3", 50, 624, `${hex("uf\x01cio \x02uido of\x01cina caf\x05")} Tj`],
      ["F2", 50, 608, `[${hex("Universit\x06")} 333 ${hex("a e citt\x06")} 333 ${hex("a")}] TJ`],
      ["F1", 300, 608, `${hex("ultima riga")} Tj`],
    ];
    const page = (ops: string, rotate: 0 | 90 | 270 = 0) => doc.insertPage(-1, doc.addPage([0, 0, 595, 842], rotate, { Font: { F1, F2, F3 } }, ops));
    const body = "BT" + NL + rows.map(([f, x, y, show]) => `/${f} 12 Tf 1 0 0 1 ${x} ${y} Tm ${show}`).join(NL) + NL + "ET";
    page(body);
    page(body, 90);
    page(body, 270);
    page(`BT /F1 12 Tf 50 800 Td ${hex("Pagina con annotazioni.")} Tj ET`);
    const p = doc.loadPage(3);
    try {
      const ft = p.createAnnotation("FreeText");
      ft.setRect([50, 100, 300, 140]);
      ft.setContents("Nota a margine importantissima");
      ft.setDefaultAppearance("Helv", 12, [0, 0, 0]);
      ft.update();
      const tx = p.createAnnotation("Text");
      tx.setRect([400, 100, 420, 120]);
      tx.setContents("Commento nascosto nella nota");
      tx.update();
      const hl = p.createAnnotation("Highlight");
      hl.setQuadPoints([[50, 30, 200, 30, 50, 45, 200, 45]]);
      hl.setContents("Spiegazione del passaggio evidenziato");
      hl.update();
      p.update();
      for (const a of [ft, tx, hl]) a.destroy();
    } finally {
      p.destroy();
    }
  });
}

/** The research's apos.pdf: Italian accents typed as apostrophes, and the same words with accents. */
function apos(): mupdf.PDFDocument {
  return built((doc) => {
    const F1 = addBase14(doc);
    const ops = `BT /F1 12 Tf 50 800 Td ${hex("E' vero, perche' la citta' e' bella. Un po' di piu'. L'acqua dell'Universita'")} Tj ` +
      `0 -16 Td ${hex("È vero, perché la città è bella. Un po’ di più.")} Tj ET`;
    doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { Font: { F1 } }, ops));
  });
}

/** Text a reader does not see: invisible (Tr 3), under a white box, outside the page, in a layer switched off. */
function hiddenText(): mupdf.PDFDocument {
  return built((doc) => {
    const F1 = addBase14(doc, "Helvetica");
    const ocg = doc.addObject({ Type: "OCG", Name: "(Nascosto)" });
    doc.getTrailer().get("Root").put("OCProperties", doc.addObject({ OCGs: [ocg], D: { OFF: [ocg] } }));
    const ops = [
      `BT /F1 12 Tf 50 800 Td ${hex("Testo visibile")} Tj ET`,
      `BT 3 Tr /F1 12 Tf 50 780 Td ${hex("Testo invisibile OCR")} Tj ET`,
      `BT /F1 12 Tf 50 760 Td ${hex("Testo coperto")} Tj ET 1 g 45 755 120 20 re f 0 g`,
      `BT /F1 12 Tf 50 1000 Td ${hex("Testo fuori pagina")} Tj ET`,
      `/OC /oc1 BDC BT /F1 12 Tf 50 740 Td ${hex("Testo livello spento")} Tj ET EMC`,
    ].join(NL);
    doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { Font: { F1 }, Properties: { oc1: ocg } }, ops));
  });
}

const PRINT = 4, HIDDEN = 2, NOVIEW = 32, TX_PASSWORD = 1 << 13;
const FIELD_RECTS: Record<string, Rect> = { nome: [150, 795, 400, 812], "anagrafica.cognome": [150, 765, 400, 782] };

/**
 * A form: "nome" filled by the app ("Mario Società"), "anagrafica.cognome" (a field under a
 * parent) filled by the app ("Rossi"), and three widgets whose appearance another tool drew with
 * a secret in it: a password field, a Hidden widget and a NoView widget; the page's text "Nome".
 */
function form(): mupdf.PDFDocument {
  const doc = built((doc) => {
    const helv = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" });
    doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { Font: { F1: helv } }, `BT /F1 9 Tf 40 800 Td ${hex("Nome")} Tj ET`));
    const page = doc.findPage(0);
    const annots = doc.newArray(), fields = doc.newArray();
    page.put("Annots", annots);
    const DA = "(/Helv 10 Tf 0 g)";
    const widget = (dict: Record<string, unknown>) => {
      const o = doc.addObject({ Type: "Annot", Subtype: "Widget", F: PRINT, P: page, ...dict });
      annots.push(o);
      return o;
    };
    const drawn = (text: string) =>
      doc.addStream(`/Tx BMC BT /Helv 10 Tf 2 4 Td ${hex(text)} Tj ET EMC`, { Type: "XObject", Subtype: "Form", BBox: [0, 0, 150, 18], Resources: { Font: { Helv: helv } } });
    fields.push(widget({ FT: "Tx", T: "(nome)", DA, Rect: FIELD_RECTS.nome }));
    const parent = doc.addObject({ T: "(anagrafica)", Kids: [] });
    fields.push(parent);
    parent.get("Kids").push(widget({ FT: "Tx", T: "(cognome)", Parent: parent, DA, Rect: FIELD_RECTS["anagrafica.cognome"] }));
    fields.push(widget({ FT: "Tx", T: "(pin)", Ff: TX_PASSWORD, V: "(Segretissimo)", DA, Rect: [150, 735, 300, 753], AP: { N: drawn("Segretissimo") } }));
    fields.push(widget({ FT: "Tx", T: "(nascosto)", F: PRINT | HIDDEN, V: "(Nascostissimo)", DA, Rect: [150, 705, 300, 723], AP: { N: drawn("Nascostissimo") } }));
    fields.push(widget({ FT: "Tx", T: "(schermo)", F: PRINT | NOVIEW, V: "(Invisibilissimo)", DA, Rect: [150, 675, 300, 693], AP: { N: drawn("Invisibilissimo") } }));
    doc.getTrailer().get("Root").put("AcroForm", doc.addObject({ Fields: fields, DR: { Font: { Helv: helv } }, DA }));
  });
  for (const [name, text] of [["nome", "Mario Società"], ["anagrafica.cognome", "Rossi"]]) {
    const edit = planFieldEdit(mupdf, doc, name, { kind: "text", text });
    applyFieldEdit(mupdf, doc, edit!);
  }
  return openBytes(saveBytes(doc));
}

/**
 * Characters beyond U+FFFF through /ToUnicode: code A is U+1D465 (a maths italic x), B U+1F600
 * (an emoji), C U+D465 (a Hangul syllable: what MuPDF.js's walk turns U+1D465 into), D "a".
 * Lines "a𝑥a" and "a😀a퍥". With `nul`, the page starts with "a" and an ActualText U+0000: the
 * structured text as text no longer lines up with the walk, so the drawn glyphs give the
 * characters back (all of them come after the NUL).
 */
function astral(nul = false): mupdf.PDFDocument {
  return built((doc) => {
    const font = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" });
    font.put("ToUnicode", doc.addStream(toUnicode(["<41> <D835DC65>", "<42> <D83DDE00>", "<43> <D465>", "<44> <0061>"]), {}));
    const lead = nul ? "<44> Tj /Span << /ActualText <FEFF0000> >> BDC <44> Tj EMC " : "";
    const ops = `BT /F1 14 Tf 50 800 Td ${lead}<444144> Tj 0 -20 Td <44424443> Tj ET`;
    doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { Font: { F1: font } }, ops));
  });
}

/** One page of Times text, one line per string. */
function lines(...rows: string[]): mupdf.PDFDocument {
  return built((doc) => {
    const F1 = addBase14(doc);
    const ops = rows.map((r, i) => `BT /F1 12 Tf 50 ${800 - 16 * i} Td ${hex(r)} Tj ET`).join(NL);
    doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { Font: { F1 } }, ops));
  });
}

/** One page of Helvetica text (WinAnsi), one line per string, the text of some codes given by /ToUnicode ("<code> <UTF-16BE>"). */
function mapped(rows: string[], pairs: string[]): mupdf.PDFDocument {
  return built((doc) => {
    const F1 = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" });
    F1.put("ToUnicode", doc.addStream(toUnicode(pairs), {}));
    const ops = rows.map((r, i) => `BT /F1 12 Tf 50 ${800 - 16 * i} Td ${hex(r)} Tj ET`).join(NL);
    doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { Font: { F1 } }, ops));
  });
}

const TX_COMB = 1 << 24;

/**
 * Two comb fields of 16 cells (as a codice fiscale's): "cf" filled by the app, "altro" with an
 * appearance MuPDF drew (as another tool would have saved it).
 */
function combForm(): mupdf.PDFDocument {
  const doc = built((doc) => {
    const helv = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" });
    doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { Font: { F1: helv } }, `BT /F1 9 Tf 40 800 Td ${hex("Codice fiscale")} Tj ET`));
    const page = doc.findPage(0);
    const annots = doc.newArray(), fields = doc.newArray();
    page.put("Annots", annots);
    const DA = "(/Helv 12 Tf 0 g)";
    for (const [name, y] of [["cf", 700], ["altro", 650]] as const) {
      const w = doc.addObject({ Type: "Annot", Subtype: "Widget", F: PRINT, P: page, FT: "Tx", T: `(${name})`, Ff: TX_COMB, MaxLen: 16, DA, Rect: [72, y, 72 + 16 * 14, y + 20] });
      annots.push(w);
      fields.push(w);
    }
    doc.getTrailer().get("Root").put("AcroForm", doc.addObject({ Fields: fields, DR: { Font: { Helv: helv } }, DA }));
  });
  applyFieldEdit(mupdf, doc, planFieldEdit(mupdf, doc, "cf", { kind: "text", text: "RSSMRA85T10A562S" })!);
  const page = doc.loadPage(0) as mupdf.PDFPage;
  const widgets = [...page.getWidgets()];
  try {
    const altro = widgets.find((w) => w.getName() === "altro")!;
    altro.setTextValue("VRDLGU70A01H501Z");
    altro.update();
  } finally {
    for (const w of widgets) w.destroy();
    page.destroy();
  }
  return openBytes(saveBytes(doc));
}

// ---------------------------------------------------------------------------------------------

describe("the research's table: what MuPDF's own search misses is found", () => {
  it("ignores case, including accented capitals", () => {
    const hits = onPage(find(synth(), "UNIVERSITÀ"), 0);
    expect(matches(hits)).toEqual(["Università", "UNIVERSITÀ", "Università", "Universit`a"]);
  });

  it("ignores accents ('Universita' finds 'Università'), where MuPDF finds nothing", () => {
    const doc = synth();
    expect(matches(onPage(find(doc, "Universita"), 0))).toEqual(["Università", "UNIVERSITÀ", "Università", "Universit`a"]);
    expect(matches(find(doc, "perche"))).toEqual(["perché", "perché", "perché"]);
    expect(muSearch(doc, "Universita")).toEqual([]);
    expect(muSearch(doc, "perche")).toEqual([]);
  });

  it("equates apostrophes, quotes and dashes, and folds ß, Œ, œ, Æ", () => {
    const doc = synth(), pages = texts(doc).slice(0, 1);
    expect(matches(searchAll(pages, "L'Aquila"))).toEqual(["L’Aquila", "l'Aquila"]);
    expect(matches(searchAll(pages, "L’aquila"))).toEqual(["L’Aquila", "l'Aquila"]);
    expect(matches(searchAll(pages, '"citazione"'))).toEqual(["“citazione”"]);
    expect(matches(searchAll(pages, '"guillemets"'))).toEqual(["«guillemets»"]);
    expect(matches(searchAll(pages, "Strasse"))).toEqual(["Straße"]);
    expect(matches(searchAll(pages, "oeuvre"))).toEqual(["Œuvre"]);
    expect(matches(searchAll(pages, "coeur"))).toEqual(["cœur"]);
    expect(matches(searchAll(pages, "aesop"))).toEqual(["Æsop"]);
    expect(matches(searchAll(pages, "2020-2021"))).toEqual(["2020–2021"]);
    expect(matches(searchAll(pages, "2020—2021"))).toEqual(["2020–2021"]);
    for (const q of ["L'Aquila", '"citazione"', "Strasse", "oeuvre", "2020-2021"]) expect(muSearch(doc, q).filter((h) => h.pageIndex === 0)).toHaveLength(q === "L'Aquila" ? 1 : 0);
  });

  it("reads runs of spaces and NBSP as one space", () => {
    expect(matches(onPage(find(synth(), "doppio spazio"), 0))).toEqual(["doppio spazio"]);
    const chrome = openBytes(fixture("search-chrome-it.pdf"));
    expect(matches(find(chrome, "prezzo 100 €"))).toEqual(["Prezzo 100 €"]);
    expect(matches(find(chrome, "due   spazi qui"))).toEqual(["due spazi qui"]);
  });

  it("finds across lines, one quad per line", () => {
    const [hit] = onPage(find(synth(), "della frase"), 0);
    expect(hit.match).toBe("della frase");
    expect(hit.quads).toHaveLength(2);
  });

  it("finds a word hyphenated at a line end whole, and as written", () => {
    const doc = synth();
    const [whole] = onPage(find(doc, "informazione"), 0);
    expect(whole.match).toBe("infor-mazione");
    expect(whole.quads).toHaveLength(2);
    expect(matches(onPage(find(doc, "infor-mazione"), 0))).toEqual(["infor-mazione"]);
    expect(matches(onPage(find(doc, "parola-chiave"), 0))).toEqual(["parola-chiave"]);
    expect(onPage(find(doc, "parolachiave"), 0)).toEqual([]); // a hyphen inside a line stays
    // Chrome's soft hyphen at a line end, drawn as a hyphen
    const chrome = find(openBytes(fixture("search-chrome-it.pdf")), "informazioni");
    expect(chrome).toHaveLength(1);
    expect(chrome[0].quads).toHaveLength(2);
  });

  it("finds a word broken at a line end by a soft hyphen (U+00AD, as office tools write it), as MuPDF does", () => {
    const doc = mapped(["Il signor Mario Ros\xad", "si abita a Bologna. Una infor\xad", "mazione riservata."], ["<AD> <00AD>"]);
    for (const q of ["Rossi", "informazione"]) {
      const ours = find(doc, q), theirs = muSearch(doc, q);
      expect(matches(ours), q).toEqual([q]);
      expect(theirs).toHaveLength(1);
      expect(cornerDifference(ours[0].quads, theirs[0].quads), q).toBeLessThan(0.02);
    }
  });

  it("ignores bidi marks, embeddings and isolates inside a word (U+200E, U+202B, U+2066)", () => {
    const doc = mapped(["Ros\x01si e Bian\x02chi, Ver\x03di."], ["<01> <200E>", "<02> <2066>", "<03> <202B>"]);
    for (const q of ["rossi", "bianchi", "verdi", "ros\u200fsi", "rossi e bianchi"]) expect(find(doc, q), q).toHaveLength(1);
  });

  it("finds ligatures, from glyph names and from /ToUnicode", () => {
    const pages = texts(synth()).slice(0, 1);
    for (const q of ["ufficio", "fluido", "officina"]) expect(searchAll(pages, q)).toHaveLength(2);
    const chrome = texts(openBytes(fixture("search-chrome-it.pdf")));
    for (const q of ["efficienza", "afflusso", "fluidi", "difficile", "finanza"]) expect(searchAll(chrome, q)).toHaveLength(1);
  });

  it("finds an accent written as a combining mark ('cafe' finds 'café', e + U+0301)", () => {
    const pages = texts(synth()).slice(0, 1);
    expect(matches(searchAll(pages, "cafe"))).toEqual(["cafe\u0301"]);
    expect(matches(searchAll(pages, "café"))).toEqual(["cafe\u0301"]);
    expect(searchAll(pages, "cafe", { matchDiacritics: true })).toEqual([]);
    expect(matches(searchAll(pages, "café", { matchDiacritics: true }))).toEqual(["cafe\u0301"]);
  });

  it("finds a TeX OT1 accent drawn over the next letter, dropped or composed", () => {
    const pages = texts(synth()).slice(0, 1);
    expect(matches(searchAll(pages, "citta"))).toEqual(["citt`a"]);
    expect(matches(searchAll(pages, "città"))).toEqual(["citt`a"]);
    expect(matches(searchAll(pages, "città", { matchDiacritics: true }))).toEqual(["citt`a"]);
    expect(searchAll(pages, "citta", { matchDiacritics: true })).toEqual([]);
    expect(matches(searchAll(pages, "Università", { matchDiacritics: true }))).toEqual(["Università", "UNIVERSITÀ", "Università", "Universit`a"]);
  });

  it("finds vertical text (wmode 1, Identity-V), where MuPDF finds nothing", () => {
    const doc = openBytes(fixture("cjk-identity-v.pdf", PROTOTYPE_FIXTURES));
    const hits = find(doc, "价格是十二元");
    expect(hits).toHaveLength(1);
    expect(muSearch(doc, "价格是十二元")).toEqual([]);
    const [x0, y0, x1, y1] = hits[0].rect;
    expect(y1 - y0).toBeGreaterThan(3 * (x1 - x0)); // one column, six characters down
    expect(find(doc, "合同已签署")).toHaveLength(1);
  });

  it("finds Chrome's vertical-rl Japanese (one character per line), where MuPDF finds nothing", () => {
    const doc = openBytes(fixture("search-chrome-it.pdf"));
    const hits = find(doc, "縦書きの日本語");
    expect(matches(hits)).toEqual(["縦書きの日本語"]);
    expect(hits[0].quads).toHaveLength(7);
    expect(muSearch(doc, "縦書きの日本語")).toEqual([]);
    expect(matches(find(doc, "日本語テキスト"))).toEqual(["日本語テキスト"]);
  });

  it("finds text on pages with /Rotate 90 and 270, rotated and slanted text", () => {
    const hits = find(synth(), "perché");
    expect(hits.map((h) => h.pageIndex)).toEqual([0, 1, 2]);
    const chrome = openBytes(fixture("search-chrome-it.pdf"));
    expect(matches(find(chrome, "ruotato di novanta"))).toEqual(["ruotato di novanta"]);
    expect(matches(find(chrome, "inclinato trenta"))).toEqual(["inclinato trenta"]);
  });

  it("does not search notes: FreeText appearances, /Contents of notes and highlights", () => {
    const doc = synth();
    for (const q of ["importantissima", "Commento nascosto", "evidenziato"]) expect(find(doc, q)).toEqual([]);
    expect(matches(find(doc, "annotazioni"))).toEqual(["annotazioni"]);
  });

  it("finds invisible text, text under a box and in a layer switched off; not text outside the page", () => {
    const doc = hiddenText();
    expect(matches(find(doc, "visibile", { wholeWord: true }))).toEqual(["visibile"]);
    expect(matches(find(doc, "invisibile OCR"))).toEqual(["invisibile OCR"]);
    expect(matches(find(doc, "coperto"))).toEqual(["coperto"]);
    expect(matches(find(doc, "livello spento"))).toEqual(["livello spento"]);
    expect(find(doc, "fuori pagina")).toEqual([]);
  });
});

describe("Italian accents typed as apostrophes", () => {
  it("'perche'' finds 'perché', 'è vero' finds 'E' vero', 'po'' finds 'po’'", () => {
    const doc = apos();
    expect(matches(find(doc, "perche'"))).toEqual(["perche", "perché"]);
    expect(matches(find(doc, "perché"))).toEqual(["perche", "perché"]);
    expect(matches(find(doc, "è vero"))).toEqual(["E' vero", "È vero"]);
    expect(matches(find(doc, "E' vero"))).toEqual(["E' vero", "È vero"]);
    expect(matches(find(doc, "citta'"))).toEqual(["citta", "città"]);
    expect(matches(find(doc, "po'"))).toEqual(["po", "po"]);
    expect(matches(find(doc, "dell'Universita'"))).toEqual(["dell'Universita"]);
  });

  it("keeps apostrophes when accents count", () => {
    const doc = apos();
    expect(matches(find(doc, "perche'", { matchDiacritics: true }))).toEqual(["perche'"]);
    expect(matches(find(doc, "perché", { matchDiacritics: true }))).toEqual(["perché"]);
    expect(matches(find(doc, "po'", { matchDiacritics: true }))).toEqual(["po'", "po’"]);
  });

  it("drops a spacing accent typed at the end of a word only ('perche`'), not inside one ('x^2')", () => {
    const doc = lines("Formula x^2 e file~1.", "Perché è vero.");
    expect(matches(find(doc, "x^2"))).toEqual(["x^2"]);
    expect(matches(find(doc, "file~1"))).toEqual(["file~1"]);
    expect(matches(find(doc, "perche`"))).toEqual(["Perché"]);
    expect(matches(find(doc, "perche´"))).toEqual(["Perché"]);
  });
});

describe("options", () => {
  it("wholeWord: no letter or digit on either side, but at CJK edges and after an elision", () => {
    const doc = lines("Rossi e Rossini, ROSSI2 e ROSSI.", "dell'Università è qui");
    expect(matches(find(doc, "rossi"))).toEqual(["Rossi", "Rossi", "ROSSI", "ROSSI"]);
    expect(matches(find(doc, "rossi", { wholeWord: true }))).toEqual(["Rossi", "ROSSI"]);
    expect(matches(find(doc, "universita", { wholeWord: true }))).toEqual(["Università"]);
    expect(matches(find(openBytes(fixture("search-chrome-it.pdf")), "日本語", { wholeWord: true }))).toEqual(["日本語"]);
  });

  it("caseSensitive: case counts, accents still do not", () => {
    const pages = texts(synth()).slice(0, 1);
    expect(matches(searchAll(pages, "UNIVERSITÀ", { caseSensitive: true }))).toEqual(["UNIVERSITÀ"]);
    expect(matches(searchAll(pages, "UNIVERSITA", { caseSensitive: true }))).toEqual(["UNIVERSITÀ"]);
    expect(searchAll(pages, "università", { caseSensitive: true })).toEqual([]);
    expect(matches(searchAll(pages, "STRASSE", { caseSensitive: false }))).toEqual(["Straße"]);
  });

  it("caseSensitive: Œ Æ Ø Ł Đ Ħ ẞ are capitals (OE, AE, O...), œ æ ß lower case", () => {
    const [page] = texts(mapped(["Œuvre æs Æsop Øre \x01odz \x02uro \x03ala GRO\x04E straße"], ["<01> <0141>", "<02> <0110>", "<03> <0126>", "<04> <1E9E>"]));
    const cs = (q: string) => matches(searchPageText(page, q, { caseSensitive: true }));
    expect(cs("OEuvre")).toEqual(["Œuvre"]);
    expect(cs("oeuvre")).toEqual([]);
    expect(cs("AEs")).toEqual(["Æs"]);
    expect(cs("æs")).toEqual(["æs"]);
    expect(cs("aesop")).toEqual([]);
    expect(cs("Ore")).toEqual(["Øre"]);
    expect(cs("Lodz")).toEqual(["Łodz"]);
    expect(cs("lodz")).toEqual([]);
    expect(cs("Duro")).toEqual(["Đuro"]);
    expect(cs("Hala")).toEqual(["Ħala"]);
    expect(cs("GROSSE")).toEqual(["GROẞE"]);
    expect(cs("grosse")).toEqual([]);
    expect(cs("strasse")).toEqual(["straße"]);
    expect(cs("STRASSE")).toEqual([]);
    // With case ignored, all of them are one
    expect(matches(searchPageText(page, "aes"))).toEqual(["æs", "Æs"]);
    expect(matches(searchPageText(page, "grosse"))).toEqual(["GROẞE"]);
    expect(matches(searchPageText(page, "LODZ"))).toEqual(["Łodz"]);
  });

  it("matchDiacritics: 'e' does not find 'è'", () => {
    const pages = texts(synth()).slice(0, 1);
    expect(searchAll(pages, "Universita", { matchDiacritics: true })).toEqual([]);
    expect(searchAll(pages, "perche", { matchDiacritics: true })).toEqual([]);
    expect(matches(searchAll(pages, "perché", { matchDiacritics: true }))).toEqual(["perché"]);
    expect(matches(searchAll(pages, "Università", { matchDiacritics: true, caseSensitive: true }))).toEqual(["Università", "Università", "Universit`a"]);
  });

  it("hits do not overlap, and at most maxHits are given", () => {
    const [page] = texts(lines("aaaa aaa"));
    expect(searchPageText(page, "aa", {}, 100)).toHaveLength(3);
    expect(searchPageText(page, "aa", {}, 2)).toHaveLength(2);
    expect(searchPageText(page, "aa", {}, 0)).toEqual([]);
  });
});

describe("quads", () => {
  it("are MuPDF's own search quads wherever MuPDF finds the hit too", () => {
    const cases: [mupdf.PDFDocument, string[]][] = [
      [synth(), ["Università", "perché", "della frase", "parola seguente", "ufficio", "fluido", "café", "doppio spazio", "informazione", "parola-chiave", "100 €"]],
      [openBytes(fixture("search-chrome-it.pdf")), ["ufficio", "ruotato", "inclinato trenta", "manifestazioni internazionali", "citazione", "efficienza", "informazioni", "Prezzo 100 €"]],
      [openBytes(fixture("chrome-rotate90-crop.pdf")), ["prezzo concordato", "Preventivo", "consegna"]],
      [openBytes(fixture("search-dense-it.pdf")), ["Università di Bologna", "responsabilità", "trasparenza"]],
    ];
    let compared = 0;
    for (const [doc, queries] of cases) {
      const pages = texts(doc);
      for (const q of queries) {
        const ours = searchAll(pages, q), theirs = muSearch(doc, q);
        expect(theirs.length, q).toBeGreaterThan(0);
        for (const mu of theirs) {
          const best = Math.min(...ours.filter((h) => h.pageIndex === mu.pageIndex).map((h) => cornerDifference(h.quads, mu.quads)));
          expect(best, `${q} on page ${mu.pageIndex + 1}`).toBeLessThan(0.02);
          compared++;
        }
      }
    }
    expect(compared).toBeGreaterThan(60);
  });

  it("leave out the hyphen a hyphenated match read through", () => {
    const [whole] = onPage(find(synth(), "informazione"), 0);
    const [literal] = onPage(find(synth(), "infor-mazione"), 0);
    expect(whole.quads[0][2]).toBeLessThan(literal.quads[0][2] - 1); // the first line's quad ends before the hyphen
  });

  it("give rect as the quads' bounds", () => {
    for (const h of find(synth(), "della frase")) {
      const xs = h.quads.flatMap((q) => [q[0], q[2], q[4], q[6]]), ys = h.quads.flatMap((q) => [q[1], q[3], q[5], q[7]]);
      expect(h.rect).toEqual([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
    }
  });
});

describe("form fields", () => {
  it("finds visible fields' appearances, by full name, inside the widget", () => {
    const doc = form();
    const hits = find(doc, "mario società");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ in: "field", field: "nome", match: "Mario Società", pageIndex: 0 });
    expect(inside(hits[0].rect, FIELD_RECTS.nome)).toBe(true);
    const [rossi] = find(doc, "rossi");
    expect(rossi).toMatchObject({ in: "field", field: "anagrafica.cognome", match: "Rossi" });
    expect(inside(rossi.rect, FIELD_RECTS["anagrafica.cognome"])).toBe(true);
    const [label] = find(doc, "nome");
    expect(label.in).toBe("page");
    expect(label.field).toBeUndefined();
  });

  it("finds a comb field's value as typed (a codice fiscale), filled by the app or drawn by another tool", () => {
    const doc = combForm();
    expect(find(doc, "RSSMRA85T10A562S")).toMatchObject([{ in: "field", field: "cf", match: "RSSMRA85T10A562S" }]);
    expect(find(doc, "vrdlgu70")).toMatchObject([{ in: "field", field: "altro", match: "VRDLGU70" }]);
    expect(find(doc, "R S S M")).toEqual([]);
  });

  it("leaves out password fields and Hidden or NoView widgets", () => {
    const doc = form();
    for (const q of ["Segretissimo", "Nascostissimo", "Invisibilissimo"]) expect(find(doc, q)).toEqual([]);
  });

  it("finds a value typed into reportlab's form after the app fills it", () => {
    const doc = openBytes(fixture("reportlab-form.pdf"));
    expect(find(doc, "Zanzibar")).toEqual([]);
    const name = (() => {
      const page = doc.loadPage(0) as mupdf.PDFPage;
      try {
        const widgets = [...page.getWidgets()];
        try {
          const w = widgets.find((x) => x.getFieldType() === "text" && !x.isReadOnly());
          return w?.getName();
        } finally {
          for (const w of widgets) w.destroy();
        }
      } finally {
        page.destroy();
      }
    })();
    expect(name).toBeTruthy();
    applyFieldEdit(mupdf, doc, planFieldEdit(mupdf, doc, name, { kind: "text", text: "Zanzibar" })!);
    expect(find(doc, "zanzibar")).toMatchObject([{ in: "field", field: name, match: "Zanzibar" }]);
  });
});

describe("characters beyond U+FFFF", () => {
  for (const nul of [false, true])
    it(`are read whole and never match by mistake (${nul ? "from the drawn glyphs" : "from the text"})`, () => {
      const [page] = texts(astral(nul));
      const one = (q: string) => searchPageText(page, q, {}, 100);
      expect(matches(one("\u{1D465}"))).toEqual(["\u{1D465}"]);
      expect(matches(one("a\u{1D465}a"))).toEqual(["a\u{1D465}a"]);
      expect(matches(one("x"))).toEqual(["\u{1D465}"]); // its compatibility form
      expect(matches(one("\u{1F600}"))).toEqual(["\u{1F600}"]);
      // the real U+D465 on the second line, never the cut U+1D465; the cut U+1F600 is nowhere
      const hangul = one("\ud465");
      expect(hangul).toHaveLength(1);
      expect(hangul[0].before).toBe((nul ? "a " : "") + "a\u{1D465}a a\u{1F600}a"); // (the NUL reads as a space)
      expect(one("\uf600")).toEqual([]);
      // a lone surrogate matches nothing (not half of a pair)
      expect(one("\ud835")).toEqual([]);
      expect(one("\ude00")).toEqual([]);
      for (const h of one("a")) expect(h.quads.every(isQuad)).toBe(true);
    });
});

describe("normalizeQuery", () => {
  it("trims spaces and invisible characters; null when nothing is left", () => {
    expect(normalizeQuery("  Università \u200b")).toBe("Università");
    expect(normalizeQuery("\ufeff\u00a0 \t")).toBeNull();
    expect(normalizeQuery("")).toBeNull();
    expect(normalizeQuery(42 as unknown as string)).toBeNull();
    expect(normalizeQuery("a  b")).toBe("a  b");
  });

  it("cuts at MAX_SEARCH_CHARS, never inside a character", () => {
    expect(normalizeQuery("x".repeat(MAX_SEARCH_CHARS + 50))).toHaveLength(MAX_SEARCH_CHARS);
    const q = normalizeQuery("x".repeat(MAX_SEARCH_CHARS - 1) + "\u{1D465}")!;
    expect(q).toBe("x".repeat(MAX_SEARCH_CHARS - 1));
  });

  it("a query that folds to nothing finds nothing", () => {
    const [page] = texts(synth());
    for (const q of ["", "   ", "\u00ad", "\u200b"]) expect(searchPageText(page, q, {}, 100)).toEqual([]);
  });
});

describe("hits", () => {
  it("say a little of the text around them, cut at a space", () => {
    const [hit] = onPage(find(synth(), "perché"), 0);
    expect(hit).toMatchObject({ pageIndex: 0, in: "page", before: "Università di Bologna, ", match: "perché" });
    expect(hit.after.startsWith(" è così. È UNIVERSITÀ.")).toBe(true);
    expect(hit.after.endsWith("\u2026")).toBe(true);
    expect(hit.after.length).toBeLessThanOrEqual(41);
    const [late] = onPage(find(synth(), "ultima riga"), 0);
    expect(late.before.startsWith("\u2026")).toBe(true);
    expect(late.after).toBe("");
  });

  it("are on the PageText's pageIndex (a cache sets it when a page moves)", () => {
    const [page] = texts(synth());
    page.pageIndex = 7;
    expect(searchPageText(page, "perché", {}, 10).map((h) => h.pageIndex)).toEqual([7]);
  });
});

describe("robustness", () => {
  const pdfs = (dir: URL) => readdirSync(dir).filter((f) => f.endsWith(".pdf")).map((f) => [f, dir] as const);

  it("reads every fixture of the app and the prototype: finite quads, and every word finds itself", () => {
    let docs = 0, words = 0;
    for (const [name, dir] of [...pdfs(FIXTURES), ...pdfs(PROTOTYPE_FIXTURES)]) {
      const doc = openBytes(fixture(name, dir));
      if (doc.needsPassword()) continue;
      docs++;
      const pages = texts(doc);
      for (const q of ["e", "a", "di", "the"])
        for (const h of searchAll(pages, q)) {
          expect(h.quads.length, name).toBeGreaterThan(0);
          expect(h.quads.every(isQuad), name).toBe(true);
        }
      for (const page of pages.slice(0, 5))
        for (const seg of page.segments) {
          const own = seg.text.split(/[\s\x01-\x04]+/).filter((w) => w.length > 3).slice(0, 60);
          for (const w of own) {
            words++;
            expect(searchPageText({ ...page, segments: [seg] }, w, {}, 1), `${name}: ${w}`).toHaveLength(1);
          }
        }
    }
    expect(docs).toBeGreaterThanOrEqual(25);
    expect(words).toBeGreaterThan(700);
  });

  it("destroys every MuPDF object it makes (pages, widgets, structured texts, display lists, fonts, device pass)", () => {
    const docs = [synth(), form(), astral(true), openBytes(fixture("search-chrome-it.pdf"))];
    const classes = [
      mupdf.Font, mupdf.StructuredText, mupdf.DisplayList, mupdf.Page, mupdf.PDFPage, mupdf.PDFAnnotation, mupdf.PDFWidget,
      mupdf.Device, mupdf.Text, mupdf.ColorSpace, mupdf.StrokeState, mupdf.Image, mupdf.Path, mupdf.Buffer, mupdf.Pixmap,
    ] as unknown as object[];
    const live = new Map<object, string>();
    const saved = classes.map((c) => Object.getOwnPropertyDescriptor(c, "_finalizer"));
    let made = 0;
    try {
      // MuPDF.js registers every wrapper with its class's _finalizer and unregisters it on destroy().
      for (const c of classes)
        Object.defineProperty(c, "_finalizer", {
          configurable: true,
          writable: true,
          value: {
            register: (_o: object, _p: number, token: object) => (made++, live.set(token, (c as { name: string }).name)),
            unregister: (token: object) => live.delete(token),
          },
        });
      for (const doc of docs) for (let p = 0; p < doc.countPages(); p++) readPageText(mupdf, doc, p);
    } finally {
      classes.forEach((c, i) => {
        const d = saved[i];
        if (d) Object.defineProperty(c, "_finalizer", d);
        else delete (c as { _finalizer?: unknown })._finalizer;
      });
    }
    expect(made).toBeGreaterThan(1000);
    expect([...live.values()]).toEqual([]);
  });
});

describe("size and speed", () => {
  /** 600 dense pages: search-dense-it.pdf's two pages 300 times, resources shared. */
  function dense600(): mupdf.PDFDocument {
    const src = openBytes(fixture("search-dense-it.pdf"));
    return built((doc) => {
      const map = doc.newGraftMap();
      try {
        for (let i = 0; i < 300; i++) for (let p = 0; p < 2; p++) map.graftPage(-1, src, p);
      } finally {
        map.destroy();
      }
    });
  }

  it("keeps a dense page in about 7 bytes a character", () => {
    // 2 for the text (it has ’), 4 for the geometry, the rest per line and run (with two float32
    // per character it was 11)
    const [page] = texts(openBytes(fixture("search-dense-it.pdf")));
    const chars = page.segments[0].text.length;
    expect(chars).toBeGreaterThan(5000);
    expect(page.bytes / chars).toBeLessThan(8);
    // a page of Latin-1 text costs a byte a character less
    const [latin] = texts(lines("Università di Bologna, perché è così.".repeat(3)));
    expect(latin.bytes).toBeLessThan(latin.segments[0].text.length * 6 + 400);
  });

  it("reads 600 dense pages and searches them within a robust bound per page", () => {
    const two = texts(openBytes(fixture("search-dense-it.pdf")));
    const perTwo = (q: string) => searchAll(two, q).length;
    const doc = dense600();
    expect(doc.countPages()).toBe(600);
    let t0 = performance.now();
    const pages = texts(doc);
    const read = (performance.now() - t0) / 600;
    t0 = performance.now();
    const rare = searchAll(pages, "Università di Bologna");
    const searchRare = (performance.now() - t0) / 600;
    t0 = performance.now();
    const common = searchAll(pages, "responsabilità");
    const searchCommon = (performance.now() - t0) / 600;
    const bytes = pages.reduce((n, p) => n + p.bytes, 0);
    // Measured on a desktop: about 8 ms a page to read, under 1 ms to search; the bounds leave room for a slow machine.
    expect(read).toBeLessThan(60);
    expect(searchRare).toBeLessThan(10);
    expect(searchCommon).toBeLessThan(15);
    expect(rare.length).toBe(300 * perTwo("Università di Bologna"));
    expect(common.length).toBe(300 * perTwo("responsabilità"));
    expect(common.length).toBeGreaterThan(600);
    expect(bytes).toBeLessThan(25 * 1024 * 1024);
    console.log(`600 dense pages: read ${read.toFixed(1)} ms/page, search ${searchRare.toFixed(2)} / ${searchCommon.toFixed(2)} ms/page, ${(bytes / 1048576).toFixed(1)} MB of page texts`);
  });
});
