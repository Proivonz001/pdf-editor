// Test documents for the page operations (release 4), built here with MuPDF: no user file.
// Ported from the research prototype make-rich.mjs (feedback-r3/pages), with what the clean
// delete and the import must handle added to it, each thing on a known page:
//
//   page 1 (index 0)  "Pagina 1"   links: to page 3 (explicit), to "cap4" (named, string), a web
//                                  address, to /p3 (named, a name; its value a dictionary with
//                                  /D), and a Named action with a /Next GoTo to page 4; a square, a note with
//                                  its popup, a reply (/IRT) to the highlight on page 3; field
//                                  "condiviso" (one of its two widgets); push button "vai" (GoTo
//                                  page 4); a tagged link (/StructParent, OBJR).
//   page 2 (index 1)  "Pagina 2"   fields "nome" (its /AA goes to page 3), "accetto" (check box),
//                                  "scelta" (radio, two buttons), "codice" (password); /AA (open:
//                                  GoTo page 3); an article bead.
//   page 3 (index 2)  "Pagina 3"   a highlight "Nota pagina 3", field "totale" (in /CO), the other
//                                  "condiviso" widget; an article bead; its tag element has
//                                  /Alt and an ID in the IDTree.
//   page 4 (index 3)  "Pagina 4"   "Testo nel livello" in a hidden layer, whose marked content an
//                                  element of page 3 (a Sect) holds through an MCR.
//
// Every page also shows "Segreto <n>". Pages 1-2 sit under one /Pages node and 3-4 under another,
// each handing down MediaBox, Resources (and Rotate 90 for 3-4) without the pages having their own.
// Bookmarks: Capitolo 1..3 (Sezione 3.1 under 3), "Sito" (a web address), "Al p3 per nome" (GoTo
// /p3). Page labels i ii 1 2. Named destinations in a name tree with /Kids. The ParentTree has
// /Kids. OpenAction: GoTo "cap4". Tagged (MarkInfo, StructTreeRoot), language "it".
import * as mupdf from "mupdf";
import { EngineSession } from "../../src/engine/session";

type Doc = mupdf.PDFDocument;
type Obj = mupdf.PDFObject;

/** Bytes of a document's save (the Buffer destroyed). */
export function saveBytes(doc: Doc, options = "garbage=compact,compress=yes"): Uint8Array {
  const buf = doc.saveToBuffer(options);
  try {
    return buf.asUint8Array().slice();
  } finally {
    buf.destroy();
  }
}

export function openPdf(bytes: Uint8Array, password?: string): Doc {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf").asPDF()!;
  if (password) doc.authenticatePassword(password);
  return doc;
}

/** A new stream object with `content` (the Buffer destroyed). */
export function addStream(doc: Doc, content: string, dict: Record<string, unknown> = {}): Obj {
  const buf = new mupdf.Buffer(content);
  try {
    return doc.addStream(buf, dict);
  } finally {
    buf.destroy();
  }
}

/** A Form XObject of this size drawing `content` (an appearance). */
const form = (doc: Doc, content: string, w: number, h: number, resources: unknown = {}) =>
  addStream(doc, content, { Type: "XObject", Subtype: "Form", BBox: [0, 0, w, h], Resources: resources });

const pdfString = (doc: Doc, s: string) => doc.newString(s);

function destTo(doc: Doc, page: Obj, ...tail: (number | string | null)[]): Obj {
  const a = doc.newArray();
  a.push(page);
  for (const t of tail) a.push(typeof t === "string" ? doc.newName(t) : t);
  return a;
}

function annotate(doc: Doc, page: Obj, dict: Record<string, unknown>): Obj {
  const a = doc.addObject(dict);
  a.put("P", page);
  let arr = page.get("Annots");
  if (!arr.isArray()) {
    arr = doc.newArray();
    page.put("Annots", arr);
  }
  arr.push(a);
  return a;
}

/** The rich document described in the header. */
export function richPdf(): Uint8Array {
  const doc = new mupdf.PDFDocument();
  try {
    buildRich(doc);
    return saveBytes(doc);
  } finally {
    doc.destroy();
  }
}

function buildRich(doc: Doc) {
  const root = doc.getTrailer().get("Root");
  const top = root.get("Pages");
  const helv = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" });
  const cour = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Courier", Encoding: "WinAnsiEncoding" });
  const zadb = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "ZapfDingbats" });
  const ocg = doc.addObject({ Type: "OCG", Name: pdfString(doc, "Livello A") });
  const nodeA = doc.addObject({ Type: "Pages", MediaBox: [0, 0, 595, 842], Resources: { Font: { F1: helv }, Properties: { oc1: ocg } } });
  const nodeB = doc.addObject({ Type: "Pages", MediaBox: [0, 0, 600, 800], Rotate: 90, Resources: { Font: { F1: cour }, Properties: { oc1: ocg } } });
  const kidsA = doc.newArray(), kidsB = doc.newArray();
  const pages: Obj[] = [];
  for (let i = 0; i < 4; i++) {
    let c = `/P <</MCID 0>> BDC BT /F1 24 Tf 72 720 Td (Pagina ${i + 1}) Tj ET EMC\n`;
    c += `/Span <</MCID 1>> BDC BT /F1 10 Tf 72 690 Td (Segreto ${i + 1}) Tj ET EMC\n`;
    if (i === 3) c += `/OC /oc1 BDC /Span <</MCID 2>> BDC BT /F1 18 Tf 72 600 Td (Testo nel livello) Tj ET EMC EMC\n`;
    const p = doc.addObject({ Type: "Page", Contents: addStream(doc, c) });
    p.put("Parent", i < 2 ? nodeA : nodeB);
    (i < 2 ? kidsA : kidsB).push(p);
    pages.push(p);
  }
  nodeA.put("Kids", kidsA);
  nodeA.put("Count", 2);
  nodeA.put("Parent", top);
  nodeB.put("Kids", kidsB);
  nodeB.put("Count", 2);
  nodeB.put("Parent", top);
  const tk = doc.newArray();
  tk.push(nodeA);
  tk.push(nodeB);
  top.put("Kids", tk);
  top.put("Count", 4);

  // Named destinations: a name tree with /Kids (MuPDF reads the old /Root/Dests dictionary
  // instead when there is one: oldDestsPdf has that).
  const leaf = doc.newArray();
  leaf.push(pdfString(doc, "cap2"));
  leaf.push(destTo(doc, pages[1], "Fit"));
  leaf.push(pdfString(doc, "cap4"));
  leaf.push(destTo(doc, pages[3], "XYZ", 0, 800, 0));
  leaf.push(pdfString(doc, "p3"));
  leaf.push(doc.addObject({ D: destTo(doc, pages[2], "Fit") }));
  const destsLeaf = doc.addObject({ Names: leaf, Limits: [pdfString(doc, "cap2"), pdfString(doc, "p3")] });
  const destsKids = doc.newArray();
  destsKids.push(destsLeaf);
  root.put("Names", doc.addObject({ Dests: doc.addObject({ Kids: destsKids }) }));

  // Links on page 1.
  const link = (rect: number[]) => annotate(doc, pages[0], { Type: "Annot", Subtype: "Link", Rect: rect, Border: [0, 0, 0] });
  link([72, 650, 200, 670]).put("Dest", destTo(doc, pages[2], "Fit"));
  link([72, 620, 200, 640]).put("A", doc.addObject({ S: "GoTo", D: pdfString(doc, "cap4") }));
  link([72, 590, 200, 610]).put("A", doc.addObject({ S: "URI", URI: pdfString(doc, "https://example.org") }));
  link([72, 560, 200, 580]).put("Dest", doc.newName("p3"));
  link([72, 530, 200, 550]).put("A", doc.addObject({ S: "Named", N: "NextPage", Next: doc.addObject({ S: "GoTo", D: destTo(doc, pages[3], "Fit") }) }));

  // Notes: a square and a note with its popup on page 1, a highlight on page 3, a reply to it on page 1.
  annotate(doc, pages[0], { Type: "Annot", Subtype: "Square", Rect: [300, 600, 400, 700], C: [1, 0, 0], AP: { N: form(doc, "1 0 0 RG 2 w 1 1 98 98 re S", 100, 100) } });
  const note = annotate(doc, pages[0], { Type: "Annot", Subtype: "Text", Rect: [450, 700, 470, 720], Contents: pdfString(doc, "Nota pagina 1"), Open: false });
  const popup = annotate(doc, pages[0], { Type: "Annot", Subtype: "Popup", Rect: [470, 600, 590, 700], Open: false });
  note.put("Popup", popup);
  popup.put("Parent", note);
  const highlight = annotate(doc, pages[2], {
    Type: "Annot", Subtype: "Highlight", Rect: [72, 715, 250, 745], QuadPoints: [72, 745, 250, 745, 72, 715, 250, 715], C: [1, 1, 0],
    Contents: pdfString(doc, "Nota pagina 3"), AP: { N: form(doc, "1 1 0 rg 0 0 178 30 re f", 178, 30) },
  });
  annotate(doc, pages[0], { Type: "Annot", Subtype: "Text", Rect: [500, 700, 520, 720], Contents: pdfString(doc, "Risposta"), IRT: highlight });

  // The form.
  const fields = doc.newArray();
  const widget = (page: number, dict: Record<string, unknown>) => annotate(doc, pages[page], { Type: "Annot", Subtype: "Widget", F: 4, ...dict });
  const nome = widget(1, { FT: "Tx", T: pdfString(doc, "nome"), Rect: [72, 600, 300, 620], DA: pdfString(doc, "/Helv 12 Tf 0 g") });
  nome.put("AA", doc.addObject({ U: doc.addObject({ S: "GoTo", D: destTo(doc, pages[2], "Fit") }) }));
  fields.push(nome);
  const box = (on: string) => ({
    N: doc.addObject({ [on]: form(doc, "q BT /ZaDb 12 Tf 2 3 Td (4) Tj ET Q", 18, 18, { Font: { ZaDb: zadb } }), Off: form(doc, "", 18, 18) }),
  });
  fields.push(widget(1, { FT: "Btn", T: pdfString(doc, "accetto"), Rect: [72, 560, 90, 578], V: doc.newName("Off"), AS: doc.newName("Off"), AP: box("Yes"), DA: pdfString(doc, "/ZaDb 0 Tf 0 g") }));
  const radio = doc.addObject({ FT: "Btn", Ff: 49152, T: pdfString(doc, "scelta"), V: doc.newName("Off") });
  const radioKids = doc.newArray();
  for (const [state, x] of [["A", 72], ["B", 120]] as const) {
    const w = widget(1, { Rect: [x, 520, x + 18, 538], AS: doc.newName("Off"), AP: box(state) });
    w.put("Parent", radio);
    radioKids.push(w);
  }
  radio.put("Kids", radioKids);
  fields.push(radio);
  fields.push(widget(1, { FT: "Tx", Ff: 8192, T: pdfString(doc, "codice"), Rect: [72, 480, 300, 500], DA: pdfString(doc, "/Helv 12 Tf 0 g") }));
  const shared = doc.addObject({ FT: "Tx", T: pdfString(doc, "condiviso"), DA: pdfString(doc, "/Helv 10 Tf 0 g") });
  const sharedKids = doc.newArray();
  for (const page of [0, 2]) {
    const w = widget(page, { Rect: [300, 100, 500, 120] });
    w.put("Parent", shared);
    sharedKids.push(w);
  }
  shared.put("Kids", sharedKids);
  fields.push(shared);
  const totale = widget(2, { FT: "Tx", T: pdfString(doc, "totale"), Rect: [72, 200, 300, 220], DA: pdfString(doc, "/Helv 12 Tf 0 g") });
  fields.push(totale);
  const vai = widget(0, { FT: "Btn", Ff: 65536, T: pdfString(doc, "vai"), Rect: [400, 100, 450, 120], MK: { CA: pdfString(doc, "Vai") } });
  vai.put("A", doc.addObject({ S: "GoTo", D: destTo(doc, pages[3], "Fit") }));
  fields.push(vai);
  const co = doc.newArray();
  co.push(totale);
  root.put("AcroForm", doc.addObject({ Fields: fields, DR: { Font: { Helv: helv, ZaDb: zadb } }, DA: pdfString(doc, "/Helv 0 Tf 0 g"), CO: co }));
  // Appearances for the text fields (MuPDF draws them).
  for (const i of [0, 1, 2]) {
    const p = doc.loadPage(i);
    try {
      for (const w of p.getWidgets()) {
        if (w.getFieldType() === "text") w.update();
        w.destroy();
      }
    } finally {
      p.destroy();
    }
  }

  // Page 2 opens with a GoTo to page 3; article beads on pages 2 and 3.
  pages[1].put("AA", doc.addObject({ O: doc.addObject({ S: "GoTo", D: destTo(doc, pages[2], "Fit") }) }));
  const thread = doc.addObject({ Type: "Thread", I: { Title: pdfString(doc, "Articolo") } });
  const bead1 = doc.addObject({ Type: "Bead", T: thread, R: [72, 72, 300, 300], P: pages[1] });
  const bead2 = doc.addObject({ Type: "Bead", R: [72, 72, 300, 300], P: pages[2] });
  bead1.put("N", bead2);
  bead1.put("V", bead2);
  bead2.put("N", bead1);
  bead2.put("V", bead1);
  thread.put("F", bead1);
  for (const [k, b] of [[1, bead1], [2, bead2]] as const) {
    const arr = doc.newArray();
    arr.push(b);
    pages[k].put("B", arr);
  }
  const threads = doc.newArray();
  threads.push(thread);
  root.put("Threads", threads);

  // Tags: Document > P and Span per page; page 3's P has /ActualText and an ID; a Sect with /Pg
  // page 3 holds page 4's layer text through an MCR; the Name-form link on page 1 is tagged.
  const st = doc.addObject({ Type: "StructTreeRoot" });
  const docElem = doc.addObject({ Type: "StructElem", S: "Document", P: st });
  const kids = doc.newArray();
  const parents: Obj[][] = [];
  for (let i = 0; i < 4; i++) {
    const p = doc.addObject({ Type: "StructElem", S: "P", P: docElem, Pg: pages[i], K: 0 });
    const span = doc.addObject({ Type: "StructElem", S: "Span", P: docElem, Pg: pages[i], K: 1 });
    if (i === 2) {
      p.put("Alt", pdfString(doc, "Testo segreto pagina 3"));
      p.put("ID", pdfString(doc, "id-p3"));
    }
    kids.push(p);
    kids.push(span);
    parents.push([p, span]);
    pages[i].put("StructParents", i);
  }
  const sect = doc.addObject({ Type: "StructElem", S: "Sect", P: docElem, Pg: pages[2] });
  const mcr = doc.newDictionary();
  mcr.put("Type", doc.newName("MCR"));
  mcr.put("Pg", pages[3]);
  mcr.put("MCID", 2);
  const sectKids = doc.newArray();
  sectKids.push(mcr);
  sect.put("K", sectKids);
  kids.push(sect);
  parents[3].push(sect);
  const tagged = items(pages[0].get("Annots"))[3]; // the link to /p3
  tagged.put("StructParent", 10);
  const objr = doc.newDictionary();
  objr.put("Type", doc.newName("OBJR"));
  objr.put("Obj", tagged);
  const linkElem = doc.addObject({ Type: "StructElem", S: "Link", P: docElem, Pg: pages[0] });
  linkElem.put("K", objr);
  kids.push(linkElem);
  docElem.put("K", kids);
  st.put("K", docElem);
  const numsOf = (keys: number[]) => {
    const nums = doc.newArray();
    for (const k of keys) {
      nums.push(k);
      if (k === 10) nums.push(linkElem);
      else {
        const arr = doc.newArray();
        for (const e of parents[k]) arr.push(e);
        nums.push(arr);
      }
    }
    return nums;
  };
  const ptKids = doc.newArray();
  ptKids.push(doc.addObject({ Limits: [0, 1], Nums: numsOf([0, 1]) }));
  ptKids.push(doc.addObject({ Limits: [2, 10], Nums: numsOf([2, 3, 10]) }));
  st.put("ParentTree", doc.addObject({ Kids: ptKids }));
  st.put("ParentTreeNextKey", 11);
  const ids = doc.newArray();
  ids.push(pdfString(doc, "id-p3"));
  ids.push(parents[2][0]);
  st.put("IDTree", doc.addObject({ Names: ids }));
  root.put("StructTreeRoot", st);
  root.put("MarkInfo", { Marked: true });
  root.put("Lang", pdfString(doc, "it"));

  // Bookmarks.
  const outlines = doc.addObject({ Type: "Outlines" });
  const item = (title: string, parent: Obj, target: (o: Obj) => void) => {
    const o = doc.addObject({ Title: pdfString(doc, title), Parent: parent });
    target(o);
    return o;
  };
  const toPage = (i: number) => (o: Obj) => o.put("Dest", destTo(doc, pages[i], "Fit"));
  const o1 = item("Capitolo 1", outlines, toPage(0));
  const o2 = item("Capitolo 2", outlines, toPage(1));
  const o3 = item("Capitolo 3", outlines, toPage(2));
  const o31 = item("Sezione 3.1", o3, toPage(3));
  const o4 = item("Sito", outlines, (o) => o.put("A", doc.addObject({ S: "URI", URI: pdfString(doc, "https://example.org") })));
  const o5 = item("Al p3 per nome", outlines, (o) => o.put("A", doc.addObject({ S: "GoTo", D: doc.newName("p3") })));
  const chain = [o1, o2, o3, o4, o5];
  chain.forEach((o, k) => {
    if (k) o.put("Prev", chain[k - 1]);
    if (k < chain.length - 1) o.put("Next", chain[k + 1]);
  });
  o3.put("First", o31);
  o3.put("Last", o31);
  o3.put("Count", 1);
  outlines.put("First", o1);
  outlines.put("Last", o5);
  outlines.put("Count", 6);
  root.put("Outlines", outlines);

  // Page labels i ii 1 2; the hidden layer; the open action.
  const pl = doc.newArray();
  pl.push(0);
  pl.push(doc.addObject({ S: doc.newName("r") }));
  pl.push(2);
  pl.push(doc.addObject({ S: doc.newName("D"), St: 1 }));
  root.put("PageLabels", doc.addObject({ Nums: pl }));
  const ocgs = doc.newArray(), order = doc.newArray(), off = doc.newArray();
  ocgs.push(ocg);
  order.push(ocg);
  off.push(ocg);
  root.put("OCProperties", doc.addObject({ OCGs: ocgs, D: { Order: order, OFF: off } }));
  root.put("OpenAction", doc.addObject({ S: "GoTo", D: pdfString(doc, "cap4") }));
}

function items(arr: Obj): Obj[] {
  const out: Obj[] = [];
  if (arr.isArray()) for (let i = 0; i < arr.length; i++) out.push(arr.get(i));
  return out;
}

/** A plain document: one page per text, each showing it in Helvetica (595 × 842 unless given). */
export function plainPdf(texts: string[], size: [number, number] = [595, 842]): Uint8Array {
  const doc = new mupdf.PDFDocument();
  try {
    const helv = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" });
    for (const t of texts) {
      const buf = new mupdf.Buffer(`BT /F1 20 Tf 72 ${size[1] - 100} Td (${t}) Tj ET`);
      try {
        doc.insertPage(-1, doc.addPage([0, 0, size[0], size[1]], 0, { Font: { F1: helv } }, buf));
      } finally {
        buf.destroy();
      }
    }
    return saveBytes(doc);
  } finally {
    doc.destroy();
  }
}

/**
 * Three pages "Uno", "Due", "Tre" whose named destinations are in the old /Root/Dests dictionary
 * (PDF 1.1): a link on page 1 to /p3 (a name), one on page 2 to (p1) (a string), a bookmark "Tre"
 * with a GoTo /p3.
 */
export function oldDestsPdf(): Uint8Array {
  const doc = new mupdf.PDFDocument();
  try {
    const helv = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" });
    for (const t of ["Uno", "Due", "Tre"]) {
      const buf = new mupdf.Buffer(`BT /F1 20 Tf 72 742 Td (${t}) Tj ET`);
      try {
        doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { Font: { F1: helv } }, buf));
      } finally {
        buf.destroy();
      }
    }
    const root = doc.getTrailer().get("Root");
    const pages = [0, 1, 2].map((i) => doc.findPage(i));
    const dests = doc.newDictionary();
    dests.put("p3", destTo(doc, pages[2], "Fit"));
    dests.put("p1", destTo(doc, pages[0], "Fit"));
    root.put("Dests", doc.addObject(dests));
    annotate(doc, pages[0], { Type: "Annot", Subtype: "Link", Rect: [72, 600, 200, 620], Dest: doc.newName("p3") });
    annotate(doc, pages[1], { Type: "Annot", Subtype: "Link", Rect: [72, 600, 200, 620], A: doc.addObject({ S: "GoTo", D: pdfString(doc, "p1") }) });
    const outlines = doc.addObject({ Type: "Outlines" });
    const tre = doc.addObject({ Title: pdfString(doc, "Tre"), Parent: outlines, A: doc.addObject({ S: "GoTo", D: doc.newName("p3") }) });
    outlines.put("First", tre);
    outlines.put("Last", tre);
    outlines.put("Count", 1);
    root.put("Outlines", outlines);
    return saveBytes(doc);
  } finally {
    doc.destroy();
  }
}

export interface FormOptions {
  /** /DR /Helv is Courier (another font than the usual Helvetica). */
  courierHelv?: boolean;
  /** /NeedAppearances true, and the field's appearance a stale red box. */
  needAppearances?: boolean;
  /** A signature field "firma" holding a signature (its /Reference /Data points to the catalog, as DocMDP does). */
  signed?: boolean;
  /** The value of "nome". */
  value?: string;
  /** A password field "pin" holding this value, without an appearance (MuPDF would draw it in clear). */
  password?: string;
}

/** One page "Modulo" with a text field "nome" (and what `options` add). */
export function formPdf(options: FormOptions = {}): Uint8Array {
  const doc = new mupdf.PDFDocument();
  try {
    const font = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: options.courierHelv ? "Courier" : "Helvetica", Encoding: "WinAnsiEncoding" });
    const buf = new mupdf.Buffer("BT /F1 20 Tf 72 742 Td (Modulo) Tj ET");
    try {
      doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { Font: { F1: font } }, buf));
    } finally {
      buf.destroy();
    }
    const root = doc.getTrailer().get("Root");
    const page = doc.findPage(0);
    const fields = doc.newArray();
    const nome = annotate(doc, page, {
      Type: "Annot", Subtype: "Widget", F: 4, FT: "Tx", T: pdfString(doc, "nome"), Rect: [72, 600, 300, 620], DA: pdfString(doc, "/Helv 12 Tf 0 g"),
    });
    if (options.value !== undefined) nome.put("V", pdfString(doc, options.value));
    if (options.needAppearances) nome.put("AP", { N: form(doc, "1 0 0 rg 0 0 228 20 re f", 228, 20) });
    fields.push(nome);
    const acro = doc.addObject({ Fields: fields, DR: { Font: { Helv: font } }, DA: pdfString(doc, "/Helv 0 Tf 0 g") });
    if (options.needAppearances) acro.put("NeedAppearances", true);
    if (options.signed) {
      const ref = doc.newDictionary();
      ref.put("Type", doc.newName("SigRef"));
      ref.put("TransformMethod", doc.newName("DocMDP"));
      ref.put("Data", root);
      const refs = doc.newArray();
      refs.push(ref);
      const sig = doc.addObject({
        Type: "Sig", Filter: "Adobe.PPKLite", SubFilter: "adbe.pkcs7.detached", Name: pdfString(doc, "Firmatario Prova"),
        ByteRange: [0, 10, 20, 10], Contents: doc.newByteString([1, 2, 3, 4]), Reference: refs,
      });
      fields.push(annotate(doc, page, { Type: "Annot", Subtype: "Widget", F: 4, FT: "Sig", T: pdfString(doc, "firma"), Rect: [72, 500, 300, 540], V: sig }));
      acro.put("SigFlags", 3);
    }
    root.put("AcroForm", acro);
    if (!options.needAppearances) {
      const p = doc.loadPage(0);
      try {
        for (const w of p.getWidgets()) {
          if (w.getFieldType() === "text") w.update();
          w.destroy();
        }
      } finally {
        p.destroy();
      }
    }
    if (options.password !== undefined) {
      fields.push(annotate(doc, page, {
        Type: "Annot", Subtype: "Widget", F: 4, FT: "Tx", Ff: 8192, T: pdfString(doc, "pin"), V: pdfString(doc, options.password),
        Rect: [72, 400, 300, 420], DA: pdfString(doc, "/Helv 12 Tf 0 g"), MK: { BG: [0.9, 0.9, 0.9] },
      }));
    }
    return saveBytes(doc);
  } finally {
    doc.destroy();
  }
}

/**
 * Two pages with a layer each ("Livello 1" on page 1, "Livello 2" on page 2), its text drawn in
 * it. `config`: the source's /D configuration ("none": no /D; "off": BaseState OFF with layer 2
 * in /ON; "default": layer 1 in /OFF).
 */
export function layersPdf(config: "none" | "off" | "default"): Uint8Array {
  const doc = new mupdf.PDFDocument();
  try {
    const helv = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" });
    const groups = [1, 2].map((n) => doc.addObject({ Type: "OCG", Name: pdfString(doc, `Livello ${n}`) }));
    groups.forEach((g, i) => {
      const buf = new mupdf.Buffer(`BT /F1 20 Tf 72 742 Td (Pagina ${i + 1}) Tj ET /OC /L BDC BT /F1 20 Tf 72 700 Td (Strato ${i + 1}) Tj ET EMC`);
      try {
        doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { Font: { F1: helv }, Properties: { L: g } }, buf));
      } finally {
        buf.destroy();
      }
    });
    const ocgs = doc.newArray();
    for (const g of groups) ocgs.push(g);
    const oc = doc.addObject({ OCGs: ocgs });
    if (config === "off") {
      const on = doc.newArray();
      on.push(groups[1]);
      oc.put("D", { BaseState: "OFF", ON: on });
    } else if (config === "default") {
      const off = doc.newArray();
      off.push(groups[0]);
      oc.put("D", { OFF: off });
    }
    doc.getTrailer().get("Root").put("OCProperties", oc);
    return saveBytes(doc);
  } finally {
    doc.destroy();
  }
}

/** A small opaque PNG (the picture the app-edited variant places). */
export function smallPng(): Uint8Array {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 60, 30], false);
  try {
    pix.clear(100);
    const buf = pix.asPNG();
    return buf.slice();
  } finally {
    pix.destroy();
  }
}

/**
 * `bytes` after what release 3 writes, through the app's own engine: "Mario Rossi" on page 2,
 * "Via Segreta 7" on page 3, a picture on page 3, "nome" = "Mario", "totale" = "Segreto campo".
 */
export function appEdited(bytes: Uint8Array): Uint8Array {
  const s = new EngineSession(mupdf);
  try {
    const opened = s.open(bytes);
    if (!opened.ok) throw new Error(`cannot open: ${opened.reason}`);
    const style = { size: 14, color: [0, 0, 0.6] as [number, number, number], family: "sans" as const, bold: false, italic: false };
    s.addText(1, [72, 400], "Mario Rossi", style);
    s.addText(2, [72, 300], "Via Segreta 7", style);
    s.addImage(smallPng(), [{ pageIndex: 2, matrix: [120, 0, 0, 60, 300, 400] }], "Firma");
    s.setField("nome", { kind: "text", text: "Mario" });
    s.setField("totale", { kind: "text", text: "Segreto campo" });
    return new Uint8Array(s.save().bytes);
  } finally {
    s.close();
  }
}
