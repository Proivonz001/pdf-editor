// Test documents for Bianchetto and Oscura (release 5), built here with MuPDF: no user file.
// Page 1 holds a secret in every channel a redaction of LEAK_AREA must clear, each marked with a
// token (SEGRETO_...), and next to it what must stay (LEGIT_..., CONDIVISO_...):
//
//   inside the area   text (visible; invisible, 3 Tr; in a font nothing else uses, whose dict
//                     carries a token; under a named property list /MC0 with /ActualText; in a
//                     hidden layer; in a Form XObject drawn only here, which has its own /Metadata
//                     and /PieceInfo; in a tiling pattern's cell, the pattern fill wholly inside;
//                     in a form tagged through an MCR /Stm, and in one tagged whole by an OBJR
//                     with /Alt), an inline /ActualText, a picture drawn mirrored in a Form
//                     XObject with an /ActualText there, structure elements with /ActualText and
//                     /E (one under a /Sect with /ActualText, /Alt and /T), line art wholly
//                     inside, pictures across the area's lower edge (a JPEG, a Flate RGB, a
//                     signature-like picture whose shape is only in its soft mask, in an app
//                     /PEImage block under a /Figure with /Alt and /T, a stencil /ImageMask, an
//                     inline picture, a picture with an explicit stencil /Mask) and one wholly
//                     inside (tagged by an OBJR, with /Alt), a tagged link (/URI, its element's
//                     /Alt), a tagged note (its element's /Alt) with its popup and a reply
//                     (outside the area, /IRT), a FreeText, a highlight, field "codice" (/V, in
//                     /CO, its /Form element's /ActualText) and one widget of field "nome" (its
//                     other widget on page 2), the page's /Thumb, /PieceInfo and /Metadata;
//   outside the area  a line (its element's /Alt), a picture, field "fuori", the reply;
//   elsewhere         page 2 (draws the shared form, whose /Metadata stays, the other "nome"
//                     widget), page 3, a bookmark, Info, XMP, an attached file; the XMP also
//                     holds a thumbnail of page 1 (xmp:Thumbnails, as Adobe applications write
//                     it: its picture's data stands as SEGRETOMINIATURA, base64 letters).
//
// Pages 1 and 2 share one /Resources dictionary ("shared", as FPDF and TCPDF write), or inherit
// it from the page tree ("inherited"), or page 1 has its own ("own"). Pictures are 100 × 100
// pixels drawn 60 pt wide: their rows 0..49 are inside the area, 50..99 below it; the secret is
// in rows 10..40 and columns 30..70 (SECRET_RGB, or a checkerboard in a mask), what must stay in
// rows 60..90 (LEGIT_RGB, or a checkerboard). The checks (tokenPlaces, pictureScan) read a saved
// file: every object, raw and decoded, and every picture and mask, as stored and as drawn.
//
// The other documents: a Separation picture, a picture too big to clear, resources shared with a
// page that cannot be read, softMaskPdf, a fill shown through a soft mask whose group holds text
// and a picture under the area (design tools write opacity masks, image-in-text and shadows so),
// reusedMaskPdf, one soft mask set twice under two CTMs, its group drawing under the area or not,
// sharedDrawingPdf, pictures and a form under the area that another page draws another way,
// listedOnlyPdf, ones that other content only lists, maskedPicturePdf, a picture across the
// area whose shape is in its /Mask, unusedHolderPdf, a picture and a form under the area that
// content another page never draws names, taggedPdf, descriptions the structure tree holds where
// the ParentTree alone does not tell, annotatedPdf, a popup naming its note by /Parent alone and
// a signature whose certificate /DSS keeps, cmykPicturePdf, the secret colour in CMYK, and
// resourcelessPdf, a form or a soft mask's group without resources of its own, across the area.
import * as mupdf from "mupdf";
import type { Rect } from "../../src/engine/protocol";

type Doc = mupdf.PDFDocument;
type Obj = mupdf.PDFObject;

/** How a download is written. */
import { SAVE_OPTIONS } from "../../src/engine/session";
export { SAVE_OPTIONS };

/** The area redacted on page 1 (index 0), page space (A4, user y = 842 - page y). */
export const LEAK_AREA: Rect = [100, 200, 500, 500];

/**
 * Tokens both modes remove: text in forms the structure tree names (MCR /Stm, OBJR), descriptions
 * of what changed (the elements' and their ancestors', titles included), the forms' and the page's
 * metadata, the document XMP's thumbnail of the page.
 */
const TAGS_AND_METADATA_GONE = [
  "SEGRETO_FORMA_STM", "SEGRETO_FORMA_OBJR", "SEGRETO_ALT_FORMA", "SEGRETO_AT_SEZIONE", "SEGRETO_ALT_SEZIONE", "SEGRETO_TITOLO_SEZIONE",
  "SEGRETO_ALT_LINK", "SEGRETO_XMP_FORMA", "SEGRETO_PIECEINFO_FORMA", "SEGRETO_XMP_PAGINA", "SEGRETOMINIATURA",
];

/** Tokens that only Oscura's area holds: none may stay in the file after Oscura. */
export const OSCURA_GONE = [
  "SEGRETO_VISIBILE", "SEGRETO_AT_INLINE", "SEGRETO_INVISIBILE", "SEGRETO_FONTTEXT", "SEGRETO_CARATTERE", "SEGRETO_AT_NOME",
  "SEGRETO_LIVELLO", "SEGRETO_FORM", "SEGRETO_PATTERN", "SEGRETO_LINK", "SEGRETO_NOTA", "SEGRETO_RISPOSTA", "SEGRETO_FREETEXT",
  "SEGRETO_EVIDENZIA", "SEGRETO_CAMPO", "SEGRETO_ALT", "SEGRETO_AT_ELEM", "SEGRETO_ABBREVIAZIONE", "SEGRETO_THUMB", "SEGRETO_PIECEINFO",
  "NASCOSTO_MC", "SEGRETO_AT_FORMA", ...TAGS_AND_METADATA_GONE, "SEGRETO_FOTO_OBJR", "SEGRETO_ALT_FOTO", "SEGRETO_TITOLO",
  "SEGRETO_ALT_NOTA", "SEGRETO_AT_CAMPO",
];

/** What Bianchetto removes for good: text, its descriptions, the link wholly inside, the page's thumbnail and private data. */
export const WHITEOUT_GONE = [
  "SEGRETO_VISIBILE", "SEGRETO_AT_INLINE", "SEGRETO_INVISIBILE", "SEGRETO_FONTTEXT", "SEGRETO_CARATTERE", "SEGRETO_AT_NOME",
  "SEGRETO_LIVELLO", "SEGRETO_FORM", "SEGRETO_PATTERN", "SEGRETO_LINK", "SEGRETO_AT_ELEM", "SEGRETO_ABBREVIAZIONE", "SEGRETO_THUMB",
  "SEGRETO_PIECEINFO", "NASCOSTO_MC", ...TAGS_AND_METADATA_GONE,
];

/** What Bianchetto leaves on top (notes, fields, their elements' descriptions) or only covers (the pictures, their descriptions). */
export const WHITEOUT_KEPT = [
  "SEGRETO_NOTA", "SEGRETO_RISPOSTA", "SEGRETO_FREETEXT", "SEGRETO_EVIDENZIA", "SEGRETO_CAMPO", "SEGRETO_ALT", "SEGRETO_AT_FORMA",
  "SEGRETO_FOTO_OBJR", "SEGRETO_ALT_FOTO", "SEGRETO_TITOLO", "SEGRETO_ALT_NOTA", "SEGRETO_AT_CAMPO",
];

/** Tokens outside the area or elsewhere in the document: every one stays. */
export const LEGIT = [
  "LEGIT_FUORI", "LEGIT_PAGINA2", "LEGIT_PAGINA3", "CONDIVISO_FORM", "CONDIVISO_CAMPO", "LEGIT_CAMPO", "LEGIT_SEGNALIBRO",
  "LEGIT_INFO", "LEGIT_XMP", "LEGIT_ALLEGATO", "LEGIT_ALT", "LEGIT_XMP_CONDIVISO",
];

export const SECRET_RGB = [17, 200, 34];
export const LEGIT_RGB = [200, 30, 30];
const GREY = [128, 128, 128];
const SIDE = 100;

/** Rows 10..40, columns 30..70: the secret part of a picture (inside the area). */
const inSecret = (x: number, y: number) => x >= 30 && x < 70 && y >= 10 && y < 40;
/** Rows 60..90, columns 30..70: the part that stays (below the area). */
const inLegit = (x: number, y: number) => x >= 30 && x < 70 && y >= 60 && y < 90;
/** A checkerboard of 2 × 2 pixel squares. */
const checker = (x: number, y: number) => ((x >> 1) + (y >> 1)) % 2 === 0;

function stream(doc: Doc, content: string | Uint8Array, dict: Record<string, unknown> = {}): Obj {
  const buf = typeof content === "string" ? new mupdf.Buffer(content) : new mupdf.Buffer(content);
  try {
    return doc.addStream(buf, dict);
  } finally {
    buf.destroy();
  }
}

function saved(doc: Doc, options = "compress=no"): Uint8Array {
  const buf = doc.saveToBuffer(options);
  try {
    return buf.asUint8Array().slice();
  } finally {
    buf.destroy();
  }
}

export function openPdf(bytes: Uint8Array): Doc {
  return mupdf.Document.openDocument(bytes, "application/pdf").asPDF()!;
}

/** A document's download, as the app writes it. */
export function download(doc: Doc): Uint8Array {
  return saved(doc, SAVE_OPTIONS);
}

/** An RGB pixmap 100 × 100: grey, the secret square in SECRET_RGB, the part that stays in LEGIT_RGB. */
function picturePixmap(): mupdf.Pixmap {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, SIDE, SIDE], false);
  const px = pix.getPixels(), stride = pix.getStride();
  for (let y = 0; y < SIDE; y++)
    for (let x = 0; x < SIDE; x++) {
      const c = inSecret(x, y) ? SECRET_RGB : inLegit(x, y) ? LEGIT_RGB : GREY;
      for (let k = 0; k < 3; k++) px[y * stride + x * 3 + k] = c[k];
    }
  return pix;
}

function imageOf(doc: Doc, image: mupdf.Image): Obj {
  try {
    return doc.addImage(image);
  } finally {
    image.destroy();
  }
}

/** The JPEG version of picturePixmap (DCTDecode). */
function jpegPicture(doc: Doc): Obj {
  const pix = picturePixmap();
  try {
    return imageOf(doc, new mupdf.Image(pix.asJPEG(95, false)));
  } finally {
    pix.destroy();
  }
}

/** picturePixmap as a lossless picture. */
function flatePicture(doc: Doc): Obj {
  const pix = picturePixmap();
  try {
    return imageOf(doc, new mupdf.Image(pix));
  } finally {
    pix.destroy();
  }
}

/** A signature-like picture: uniform blue ink, its shape only in the soft mask (checkerboards in both parts). */
function signaturePicture(doc: Doc): Obj {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, SIDE, SIDE], true);
  try {
    const px = pix.getPixels(), stride = pix.getStride();
    for (let y = 0; y < SIDE; y++)
      for (let x = 0; x < SIDE; x++) {
        const ink = (inSecret(x, y) || inLegit(x, y)) && checker(x, y);
        const o = y * stride + x * 4;
        // (premultiplied: transparent pixels are 0)
        px[o] = 0;
        px[o + 1] = 0;
        px[o + 2] = ink ? 200 : 0;
        px[o + 3] = ink ? 255 : 0;
      }
    return imageOf(doc, new mupdf.Image(pix));
  } finally {
    pix.destroy();
  }
}

/** 1-bit samples 100 × 100, 0 where `paint` (an image mask's painting value), rows padded to bytes. */
function maskBits(paint: (x: number, y: number) => boolean): Uint8Array {
  const rowBytes = Math.ceil(SIDE / 8);
  const bits = new Uint8Array(rowBytes * SIDE).fill(0xff);
  for (let y = 0; y < SIDE; y++) for (let x = 0; x < SIDE; x++) if (paint(x, y)) bits[y * rowBytes + (x >> 3)] &= ~(0x80 >> (x & 7));
  return bits;
}

const shape = (x: number, y: number) => (inSecret(x, y) || inLegit(x, y)) && checker(x, y);

function hexOfPixmap(): string {
  const pix = picturePixmap();
  try {
    const px = pix.getPixels();
    let hex = "";
    for (let i = 0; i < SIDE * SIDE * 3; i++) hex += px[i].toString(16).padStart(2, "0");
    return hex;
  } finally {
    pix.destroy();
  }
}

/** A plain RGB picture of one colour. */
function solidPicture(doc: Doc, rgb: number[], side = 20): Obj {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, side, side], false);
  try {
    const px = pix.getPixels();
    for (let i = 0; i < side * side; i++) for (let k = 0; k < 3; k++) px[i * 3 + k] = rgb[k];
    return imageOf(doc, new mupdf.Image(pix));
  } finally {
    pix.destroy();
  }
}

function annotate(doc: Doc, page: Obj, dict: Record<string, unknown>): Obj {
  const a = doc.addObject(dict);
  a.put("P", page);
  let arr = page.get("Annots");
  if (!arr.isArray()) arr = page.put("Annots", doc.newArray());
  arr.push(a);
  return a;
}

const form = (doc: Doc, content: string, w: number, h: number, resources: unknown = {}) =>
  stream(doc, content, { Type: "XObject", Subtype: "Form", BBox: [0, 0, w, h], Resources: resources });

export type LeakResources = "shared" | "inherited" | "own";

/** The document described in the header. */
export function leakPdf(resources: LeakResources = "shared"): Uint8Array {
  const doc = new mupdf.PDFDocument();
  try {
    buildLeak(doc, resources);
    return saved(doc);
  } finally {
    doc.destroy();
  }
}

function buildLeak(doc: Doc, mode: LeakResources) {
  const str = (s: string) => doc.newString(s);
  const root = doc.getTrailer().get("Root");
  const helv = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" });
  const secretFont = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Courier", Encoding: "WinAnsiEncoding", PENote: str("SEGRETO_CARATTERE") });
  const ocg = doc.addObject({ Type: "OCG", Name: str("Livello nascosto") });
  const xmpOf = (text: string) => stream(doc, `<x:xmpmeta xmlns:x="adobe:ns:meta/">${text}</x:xmpmeta>`, { Type: "Metadata", Subtype: "XML" });
  const formOnly = form(doc, "BT /F1 10 Tf 120 520 Td (SEGRETO_FORM) Tj ET", 595, 842, { Font: { F1: helv } });
  formOnly.put("Metadata", xmpOf("SEGRETO_XMP_FORMA"));
  formOnly.put("PieceInfo", doc.addObject({ PEApp: { Private: str("SEGRETO_PIECEINFO_FORMA"), LastModified: str("D:20200101000000Z") } }));
  const formShared = form(doc, "BT /F1 10 Tf 300 520 Td (CONDIVISO_FORM) Tj ET", 595, 842, { Font: { F1: helv } });
  formShared.put("Metadata", xmpOf("LEGIT_XMP_CONDIVISO"));
  // Tagged inside: through a marked-content reference into the form (/Stm), and whole, by an object reference.
  const formStm = form(doc, "/Span <</MCID 0>> BDC BT /F1 10 Tf 120 500 Td (SEGRETO_FORMA_STM) Tj ET EMC", 595, 842, { Font: { F1: helv } });
  formStm.put("StructParents", 20);
  const formObjr = form(doc, "BT /F1 10 Tf 120 510 Td (SEGRETO_FORMA_OBJR) Tj ET", 595, 842, { Font: { F1: helv } });
  formObjr.put("StructParent", 21);
  const inside = solidPicture(doc, SECRET_RGB);
  inside.put("StructParent", 22);
  inside.put("PENote", str("SEGRETO_FOTO_OBJR"));
  // Drawn upside down (rows 0..49 inside the area, at the bottom of its box), described inside the form.
  const formPicture = form(doc, "/Span <</ActualText (SEGRETO_AT_FORMA)>> BDC q 60 0 0 -60 120 672 cm /ImF Do Q EMC", 595, 842, { XObject: { ImF: flatePicture(doc) } });
  const plain = flatePicture(doc);
  plain.put("PEOrientation", 6); // as the app records a photo's EXIF turn (images.pictureObject)
  const pattern = stream(doc, "BT /F1 6 Tf 0 2 Td (SEGRETO_PATTERN) Tj ET", {
    Type: "Pattern", PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 60, 10], XStep: 60, YStep: 10, Resources: { Font: { F1: helv } },
  });
  const stencil = stream(doc, maskBits(shape), { Type: "XObject", Subtype: "Image", Width: SIDE, Height: SIDE, ImageMask: true, BitsPerComponent: 1 });
  const explicitMask = stream(doc, maskBits(shape), { Type: "XObject", Subtype: "Image", Width: SIDE, Height: SIDE, ImageMask: true, BitsPerComponent: 1 });
  const masked = stream(doc, new Uint8Array(SIDE * SIDE * 3).map((_, i) => (i % 3 === 1 ? 150 : 0)), {
    Type: "XObject", Subtype: "Image", Width: SIDE, Height: SIDE, ColorSpace: "DeviceRGB", BitsPerComponent: 8, Mask: explicitMask,
  });
  const res = doc.addObject({
    Font: { F1: helv, F9: secretFont },
    XObject: {
      FxOnly: formOnly, FxShared: formShared, FxPic: formPicture, FxStm: formStm, FxObjr: formObjr, ImJ: jpegPicture(doc), ImP: plain,
      PEImg1: signaturePicture(doc), ImM: stencil, ImK: masked, ImIn: inside, ImOut: solidPicture(doc, LEGIT_RGB),
    },
    Pattern: { P1: pattern },
    Properties: { MC0: { MCID: 2, ActualText: str("SEGRETO_AT_NOME") }, oc1: ocg },
  });

  const content1 = [
    "/P <</MCID 0>> BDC BT /F1 12 Tf 120 760 Td (LEGIT_FUORI) Tj ET EMC",
    "/Span <</MCID 1 /ActualText (SEGRETO_AT_INLINE)>> BDC BT /F1 12 Tf 120 620 Td (SEGRETO_VISIBILE) Tj ET EMC",
    "BT 3 Tr /F1 12 Tf 120 600 Td (SEGRETO_INVISIBILE) Tj ET",
    "BT /F9 12 Tf 120 580 Td (SEGRETO_FONTTEXT) Tj ET",
    "/Span /MC0 BDC BT /F1 12 Tf 120 560 Td (NASCOSTO_MC) Tj ET EMC",
    "/OC /oc1 BDC BT /F1 12 Tf 120 540 Td (SEGRETO_LIVELLO) Tj ET EMC",
    "/FxOnly Do /FxShared Do /FxPic Do /FxStm Do /FxObjr Do",
    "q /Pattern cs /P1 scn 300 420 60 40 re f Q",
    "q 0 0 1 RG 2 w 130 400 m 250 410 l S Q",
    "q 60 0 0 60 110 312 cm /ImJ Do Q",
    "q 60 0 0 60 175 312 cm /ImP Do Q",
    "/Figure <</MCID 3 /PEImage 1>> BDC q 60 0 0 60 240 312 cm /PEImg1 Do Q EMC",
    "q 1 0 0 rg 60 0 0 60 305 312 cm /ImM Do Q",
    `q 60 0 0 60 370 312 cm BI /W ${SIDE} /H ${SIDE} /CS /RGB /BPC 8 /F /AHx ID ${hexOfPixmap()}> EI Q`,
    "q 60 0 0 60 435 312 cm /ImK Do Q",
    "q 40 0 0 40 400 420 cm /ImIn Do Q",
    "q 40 0 0 40 40 100 cm /ImOut Do Q",
  ].join("\n");
  const page1 = doc.addPage([0, 0, 595, 842], 0, res, content1);
  doc.insertPage(-1, page1);
  const page2 = doc.addPage([0, 0, 595, 842], 0, res, "BT /F1 12 Tf 120 760 Td (LEGIT_PAGINA2) Tj ET /FxShared Do");
  doc.insertPage(-1, page2);
  const page3 = doc.addPage([0, 0, 595, 842], 0, { Font: { F1: helv } }, "BT /F1 12 Tf 120 760 Td (LEGIT_PAGINA3) Tj ET");
  doc.insertPage(-1, page3);
  const p1 = doc.findPage(0), p2 = doc.findPage(1);
  if (mode === "inherited") {
    root.get("Pages").put("Resources", res);
    p1.delete("Resources");
    p2.delete("Resources");
  } else if (mode === "own") {
    const own = doc.newDictionary();
    res.forEach((v, k) => own.put(k, v));
    p1.put("Resources", own);
  }

  // Annotations of page 1.
  const link = annotate(doc, p1, {
    Type: "Annot", Subtype: "Link", Rect: [300, 600, 420, 615], Border: [0, 0, 0], StructParent: 10,
    A: doc.addObject({ S: "URI", URI: str("https://example.com/SEGRETO_LINK") }),
  });
  const note = annotate(doc, p1, { Type: "Annot", Subtype: "Text", Rect: [440, 600, 460, 620], Contents: str("SEGRETO_NOTA"), F: 4, StructParent: 12 });
  const popup = annotate(doc, p1, { Type: "Annot", Subtype: "Popup", Rect: [460, 560, 580, 620], Parent: note, Open: false });
  note.put("Popup", popup);
  annotate(doc, p1, { Type: "Annot", Subtype: "Text", Rect: [40, 760, 60, 780], Contents: str("SEGRETO_RISPOSTA"), IRT: note, F: 4 });
  annotate(doc, p1, {
    Type: "Annot", Subtype: "FreeText", Rect: [300, 570, 420, 590], Contents: str("SEGRETO_FREETEXT"), DA: str("/Helv 10 Tf 0 g"), F: 4,
    AP: { N: form(doc, "BT /Helv 10 Tf 2 5 Td (SEGRETO_FREETEXT) Tj ET", 120, 20, { Font: { Helv: helv } }) },
  });
  annotate(doc, p1, {
    Type: "Annot", Subtype: "Highlight", Rect: [300, 540, 420, 555], QuadPoints: [300, 555, 420, 555, 300, 540, 420, 540], C: [1, 1, 0],
    Contents: str("SEGRETO_EVIDENZIA"), F: 4, AP: { N: form(doc, "1 1 0 rg 0 0 120 15 re f", 120, 15) },
  });

  // The form: "codice" here (in /CO), "nome" here and on page 2, "fuori" outside the area.
  const appearance = (text: string) => ({ N: form(doc, `/Tx BMC BT /Helv 10 Tf 2 5 Td (${text}) Tj ET EMC`, 160, 20, { Font: { Helv: helv } }) });
  const codice = annotate(doc, p1, {
    Type: "Annot", Subtype: "Widget", FT: "Tx", T: str("codice"), V: str("SEGRETO_CAMPO"), Rect: [120, 470, 280, 490], F: 4,
    DA: str("/Helv 10 Tf 0 g"), AP: appearance("SEGRETO_CAMPO"), StructParent: 13,
  });
  const nome = doc.addObject({ FT: "Tx", T: str("nome"), V: str("CONDIVISO_CAMPO"), DA: str("/Helv 10 Tf 0 g") });
  const nomeKids = doc.newArray();
  for (const [page, rect] of [[p1, [300, 470, 460, 490]], [p2, [120, 700, 280, 720]]] as const) {
    const w = annotate(doc, page, { Type: "Annot", Subtype: "Widget", Rect: rect, F: 4, AP: appearance("CONDIVISO_CAMPO") });
    w.put("Parent", nome);
    nomeKids.push(w);
  }
  nome.put("Kids", nomeKids);
  const fuori = annotate(doc, p1, {
    Type: "Annot", Subtype: "Widget", FT: "Tx", T: str("fuori"), V: str("LEGIT_CAMPO"), Rect: [120, 720, 280, 740], F: 4,
    DA: str("/Helv 10 Tf 0 g"), AP: appearance("LEGIT_CAMPO"),
  });
  root.put("AcroForm", doc.addObject({ Fields: [codice, nome, fuori], DR: { Font: { Helv: helv } }, DA: str("/Helv 0 Tf 0 g"), CO: [codice] }));

  // Tags: Document > P (MCID 0, /Alt), Sect (/ActualText, /Alt, /T) > Span (1, /ActualText); Span (2, /E), Figure (3,
  // /Alt, /T); Link, Annot and Form (OBJR, /Alt or /ActualText); Span (an MCR into the form); Figure (OBJR to the
  // form, /Alt), Figure (OBJR to the picture wholly inside, /Alt).
  const tree = doc.addObject({ Type: "StructTreeRoot" });
  const top = doc.addObject({ Type: "StructElem", S: "Document", P: tree });
  const el = (s: string, k: unknown, extra: Record<string, unknown> = {}, parent = top) => doc.addObject({ Type: "StructElem", S: s, P: parent, Pg: p1, K: k, ...extra });
  const reference = (type: "OBJR" | "MCR", key: "Obj" | "Stm", o: Obj, mcid?: number) => {
    const d = doc.newDictionary();
    d.put("Type", doc.newName(type));
    if (mcid !== undefined) d.put("MCID", mcid);
    d.put(key, o);
    d.put("Pg", p1);
    return d;
  };
  const sect = doc.addObject({
    Type: "StructElem", S: "Sect", P: top, ActualText: str("SEGRETO_AT_SEZIONE"), Alt: str("SEGRETO_ALT_SEZIONE"), T: str("SEGRETO_TITOLO_SEZIONE"),
  });
  const elems = [
    el("P", 0, { Alt: str("LEGIT_ALT") }), el("Span", 1, { ActualText: str("SEGRETO_AT_ELEM") }, sect), el("Span", 2, { E: str("SEGRETO_ABBREVIAZIONE") }),
    el("Figure", 3, { Alt: str("SEGRETO_ALT"), T: str("SEGRETO_TITOLO") }),
  ];
  sect.put("K", [elems[1]]);
  const linkElem = el("Link", reference("OBJR", "Obj", link), { Alt: str("SEGRETO_ALT_LINK") });
  const noteElem = el("Annot", reference("OBJR", "Obj", note), { Alt: str("SEGRETO_ALT_NOTA") });
  const fieldElem = el("Form", reference("OBJR", "Obj", codice), { ActualText: str("SEGRETO_AT_CAMPO") });
  const stmElem = el("Span", reference("MCR", "Stm", formStm, 0));
  const formElem = el("Figure", reference("OBJR", "Obj", formObjr), { Alt: str("SEGRETO_ALT_FORMA") });
  const pictureElem = el("Figure", reference("OBJR", "Obj", inside), { Alt: str("SEGRETO_ALT_FOTO") });
  top.put("K", [elems[0], sect, elems[2], elems[3], linkElem, noteElem, fieldElem, stmElem, formElem, pictureElem]);
  tree.put("K", top);
  const parents = doc.newArray();
  for (const e of elems) parents.push(e);
  const nums = doc.newArray();
  for (const [key, value] of [[0, parents], [10, linkElem], [12, noteElem], [13, fieldElem], [20, [stmElem]], [21, formElem], [22, pictureElem]] as const) {
    nums.push(key);
    nums.push(value);
  }
  tree.put("ParentTree", doc.addObject({ Nums: nums }));
  tree.put("ParentTreeNextKey", 23);
  p1.put("StructParents", 0);
  root.put("StructTreeRoot", tree);
  root.put("MarkInfo", { Marked: true });

  // Hidden layer, the page's thumbnail and private data.
  const ocgs = doc.newArray(), off = doc.newArray();
  ocgs.push(ocg);
  off.push(ocg);
  root.put("OCProperties", doc.addObject({ OCGs: ocgs, D: { OFF: off } }));
  p1.put("Thumb", stream(doc, new Uint8Array(100).fill(90), { Width: 10, Height: 10, ColorSpace: "DeviceGray", BitsPerComponent: 8, PENote: str("SEGRETO_THUMB") }));
  p1.put("PieceInfo", doc.addObject({ PEApp: { Private: str("SEGRETO_PIECEINFO"), LastModified: str("D:20200101000000Z") } }));
  p1.put("Metadata", xmpOf("SEGRETO_XMP_PAGINA"));

  // Elsewhere: a bookmark, Info, XMP, an attached file.
  const outlines = doc.addObject({ Type: "Outlines" });
  const item = doc.addObject({ Title: str("LEGIT_SEGNALIBRO"), Parent: outlines, Dest: [p1, doc.newName("Fit")] });
  outlines.put("First", item);
  outlines.put("Last", item);
  outlines.put("Count", 1);
  root.put("Outlines", outlines);
  doc.getTrailer().put("Info", doc.addObject({ Author: str("LEGIT_INFO"), Title: str("Prova") }));
  const xmp = '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
    + '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator><rdf:Seq><rdf:li>LEGIT_XMP</rdf:li></rdf:Seq></dc:creator>'
    + '</rdf:Description><rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:xmpGImg="http://ns.adobe.com/xap/1.0/g/img/">'
    + '<xmp:Thumbnails><rdf:Alt><rdf:li rdf:parseType="Resource"><xmpGImg:width>64</xmpGImg:width><xmpGImg:format>JPEG</xmpGImg:format>'
    + '<xmpGImg:image>SEGRETOMINIATURA</xmpGImg:image></rdf:li></rdf:Alt></xmp:Thumbnails>'
    + '</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
  root.put("Metadata", stream(doc, xmp, { Type: "Metadata", Subtype: "XML" }));
  const when = new Date(Date.UTC(2020, 0, 1));
  const spec = doc.addEmbeddedFile("allegato.txt", "text/plain", "LEGIT_ALLEGATO", when, when);
  doc.insertEmbeddedFile("allegato.txt", spec);
}

/**
 * A page with a picture in printing colours (Separation, 8-bit, 100 × 100) across LEAK_AREA's
 * lower edge, and a line of text inside the area.
 */
export function separationPdf(): Uint8Array {
  const doc = new mupdf.PDFDocument();
  try {
    const helv = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" });
    const tint = doc.addObject({ FunctionType: 2, Domain: [0, 1], C0: [0, 0, 0, 0], C1: [0, 1, 0, 0], N: 1 });
    const spot = doc.addObject([doc.newName("Separation"), doc.newName("Spot"), doc.newName("DeviceCMYK"), tint]);
    const im = stream(doc, new Uint8Array(SIDE * SIDE).map((_, i) => i & 255), {
      Type: "XObject", Subtype: "Image", Width: SIDE, Height: SIDE, ColorSpace: spot, BitsPerComponent: 8,
    });
    const page = doc.addPage([0, 0, 595, 842], 0, { Font: { F1: helv }, XObject: { Im: im } },
      "BT /F1 12 Tf 120 620 Td (SEGRETO_VISIBILE) Tj ET q 60 0 0 60 110 312 cm /Im Do Q");
    doc.insertPage(-1, page);
    return saved(doc);
  } finally {
    doc.destroy();
  }
}

/** A page with a picture of `width` × `height` pixels (grey, all 0) across LEAK_AREA, and text inside the area. */
export function bigPicturePdf(width: number, height: number): Uint8Array {
  const doc = new mupdf.PDFDocument();
  try {
    const helv = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" });
    const im = stream(doc, new Uint8Array(width * height), { Type: "XObject", Subtype: "Image", Width: width, Height: height, ColorSpace: "DeviceGray", BitsPerComponent: 8 });
    const page = doc.addPage([0, 0, 595, 842], 0, { Font: { F1: helv }, XObject: { Im: im } },
      "q 400 0 0 400 50 300 cm /Im Do Q BT /F1 12 Tf 120 620 Td (SEGRETO_VISIBILE) Tj ET");
    doc.insertPage(-1, page);
    return saved(doc, "compress=yes");
  } finally {
    doc.destroy();
  }
}

/**
 * Two pages sharing one /Resources that lists a picture page 1 draws in LEAK_AREA; page 2 has a
 * stamp whose appearance (with no resources of its own, so it draws with the page's) MuPDF cannot
 * decode: what page 2 draws is not known for sure.
 */
export function unsurePdf(): Uint8Array {
  const doc = new mupdf.PDFDocument();
  try {
    const helv = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" });
    const res = doc.addObject({ Font: { F1: helv }, XObject: { Im: flatePicture(doc) } });
    doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, res, "BT /F1 12 Tf 120 620 Td (SEGRETO_VISIBILE) Tj ET q 60 0 0 60 110 312 cm /Im Do Q"));
    doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, res, "BT /F1 12 Tf 120 760 Td (LEGIT_PAGINA2) Tj ET"));
    const buf = new mupdf.Buffer(new Uint8Array(64).fill(0x41));
    let ap: Obj;
    try {
      ap = doc.addRawStream(buf, { Type: "XObject", Subtype: "Form", BBox: [0, 0, 10, 10], Filter: "FlateDecode", DecodeParms: { Predictor: 12, Colors: 100, Columns: 1 } });
    } finally {
      buf.destroy();
    }
    annotate(doc, doc.findPage(1), { Type: "Annot", Subtype: "Stamp", Rect: [400, 400, 410, 410], F: 4, AP: { N: ap } });
    return saved(doc);
  } finally {
    doc.destroy();
  }
}

/**
 * A fill shown through a soft mask (an ExtGState's luminosity /SMask) whose group holds the text
 * SEGRETO_MASCHERA and a picture (as the others: rows 0..49 inside) under LEAK_AREA. The fill lies
 * wholly inside the area, or crosses its lower edge ("form": in a Form XObject, whose resources
 * hold the graphics state); "twice" sets the same graphics state again, under another CTM, also
 * inside the area (one cleaned group cannot serve both); "hidden" draws the crossing fill in a
 * hidden layer, "unpainted" sets the graphics state and paints nothing (MuPDF runs neither
 * group). Pages 1 and 2 share one /Resources; page 2 draws LEGIT_PAGINA2 alone.
 */
export function softMaskPdf(fill: "inside" | "crossing" | "form" | "twice" | "hidden" | "unpainted"): Uint8Array {
  const doc = new mupdf.PDFDocument();
  try {
    const helv = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" });
    const group = stream(doc, "BT /F1 10 Tf 1 g 120 450 Td (SEGRETO_MASCHERA) Tj ET q 60 0 0 60 175 312 cm /ImG Do Q", {
      Type: "XObject", Subtype: "Form", BBox: [0, 0, 595, 842], Group: { S: "Transparency", CS: "DeviceGray" },
      Resources: { Font: { F1: helv }, XObject: { ImG: flatePicture(doc) } },
    });
    const state = doc.addObject({ Type: "ExtGState", SMask: { Type: "Mask", S: "Luminosity", G: group } });
    const masked = `q /GSm gs 0 0 1 rg ${fill === "inside" || fill === "twice" ? "110 350 380 280" : "110 300 380 330"} re f Q`;
    const res = doc.addObject({ Font: { F1: helv }, ExtGState: { GSm: state } });
    if (fill === "form") res.put("XObject", { Fx: form(doc, masked, 595, 842, { ExtGState: { GSm: state } }) });
    let content = `BT /F1 12 Tf 120 760 Td (LEGIT_FUORI) Tj ET ${fill === "form" ? "/Fx Do" : fill === "hidden" ? `/OC /oc1 BDC ${masked} EMC` : fill === "unpainted" ? "q /GSm gs Q" : masked}`;
    if (fill === "twice") content += " q 1 0 0 1 0 -20 cm /GSm gs 0 0 1 rg 110 380 380 200 re f Q";
    if (fill === "hidden") {
      const layer = doc.addObject({ Type: "OCG", Name: doc.newString("nascosto") });
      doc.getTrailer().get("Root").put("OCProperties", doc.addObject({ OCGs: [layer], D: { OFF: [layer], Order: [layer] } }));
      res.put("Properties", { oc1: layer });
    }
    doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, res, content));
    doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, res, "BT /F1 12 Tf 120 760 Td (LEGIT_PAGINA2) Tj ET"));
    return saved(doc);
  } finally {
    doc.destroy();
  }
}

/** What reusedMaskPdf's group draws under LEAK_AREA. */
export type Reused = "nothing" | "text" | "hidden text" | "invisible text" | "nested mask" | "gradient" | "clipped gradient";

/**
 * A soft mask's graphics state set twice, under two CTMs, at the page's foot (a shadow reused, as
 * design tools write it), its group's box page-sized: the group draws a grey square there and,
 * under LEAK_AREA where the first sets it, what `under` names: SEGRETO_OMBRA as text, in a layer
 * the document hides, invisible (3 Tr), or in the group of a mask of its own set with nothing
 * painted through it; or a gradient filling an outline (its corner at x 333.125), as a shading
 * pattern's fill or as a clip then sh. The page has SEGRETO_VISIBILE under the area and
 * LEGIT_FUORI outside it.
 */
export function reusedMaskPdf(under: Reused): Uint8Array {
  const doc = new mupdf.PDFDocument();
  try {
    const helv = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" });
    const text = `BT /F1 10 Tf 1 g ${under === "invisible text" ? "3 Tr " : ""}130 400 Td (SEGRETO_OMBRA) Tj ET`;
    const groupOf = (content: string, resources: Record<string, unknown>) =>
      stream(doc, content, { Type: "XObject", Subtype: "Form", BBox: [0, 0, 595, 842], Group: { S: "Transparency", CS: "DeviceGray" }, Resources: resources });
    const res: Record<string, unknown> = { Font: { F1: helv } };
    let content = "0.5 g 0 0 100 100 re f";
    if (under === "text" || under === "invisible text") content += ` ${text}`;
    if (under === "hidden text") {
      const layer = doc.addObject({ Type: "OCG", Name: doc.newString("nascosto") });
      doc.getTrailer().get("Root").put("OCProperties", doc.addObject({ OCGs: [layer], D: { OFF: [layer], Order: [layer] } }));
      res.Properties = { oc1: layer };
      content += ` /OC /oc1 BDC ${text} EMC`;
    }
    if (under === "nested mask") {
      res.ExtGState = { GSi: { Type: "ExtGState", SMask: { Type: "Mask", S: "Luminosity", G: groupOf(text, { Font: { F1: helv } }) } } };
      content += " q /GSi gs Q";
    }
    const shading = () => doc.addObject({ ShadingType: 2, ColorSpace: "DeviceGray", Coords: [0, 0, 300, 0], Function: { FunctionType: 2, Domain: [0, 1], C0: [0], C1: [1], N: 1 } });
    const outline = "130 380 m 333.125 380 l 333.125 420 l 130 420 l h";
    if (under === "gradient") {
      res.Pattern = { Sp: doc.addObject({ Type: "Pattern", PatternType: 2, Shading: shading() }) };
      content += ` /Pattern cs /Sp scn ${outline} f`;
    }
    if (under === "clipped gradient") {
      res.Shading = { Sh0: shading() };
      content += ` q ${outline} W n /Sh0 sh Q`;
    }
    const state = doc.addObject({ Type: "ExtGState", SMask: { Type: "Mask", S: "Luminosity", G: groupOf(content, res) } });
    doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { Font: { F1: helv }, ExtGState: { GSm: state } },
      "q 1 0 0 1 20 50 cm /GSm gs 0 0 1 rg 0 0 100 100 re f Q q 1 0 0 1 400 50 cm /GSm gs 0 0 1 rg 0 0 100 100 re f Q " +
      "BT /F1 12 Tf 150 500 Td (SEGRETO_VISIBILE) Tj ET BT /F1 12 Tf 120 760 Td (LEGIT_FUORI) Tj ET"));
    return saved(doc);
  } finally {
    doc.destroy();
  }
}

/** What resourcelessPdf's form draws outside the area. */
export type Drawn = "picture" | "nested form" | "graphics state" | "pattern" | "shading";

/**
 * A form without /Resources of its own (PDF 1.1: it draws with those of the content that draws
 * it), drawn by the page or as a soft mask's group over a fill: text under LEAK_AREA
 * (SEGRETO_SENZA_RISORSE) and, outside it, what `drawn` names, all named in the page's resources.
 */
export function resourcelessPdf(drawn: Drawn, holder: "form" | "mask group"): Uint8Array {
  const doc = new mupdf.PDFDocument();
  try {
    const helv = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" });
    const pattern = stream(doc, "0 1 0 rg 0 0 5 5 re f", { Type: "Pattern", PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 10, 10], XStep: 10, YStep: 10, Resources: {} });
    const shading = doc.addObject({ ShadingType: 2, ColorSpace: "DeviceRGB", Coords: [150, 100, 210, 100], Function: { FunctionType: 2, Domain: [0, 1], C0: [1, 0, 0], C1: [0, 0, 1], N: 1 } });
    const ops: Record<Drawn, string> = {
      picture: "q 60 0 0 60 150 100 cm /Im Do Q", "nested form": "/Fy Do", "graphics state": "q /Ga gs 1 0 0 rg 150 100 60 60 re f Q",
      pattern: "q /Pattern cs /Pt scn 150 100 60 60 re f Q", shading: "q 150 100 60 60 re W n /Sh sh Q",
    };
    const fx = stream(doc, `BT /F1 12 Tf 1 g 120 600 Td (SEGRETO_SENZA_RISORSE) Tj ET ${ops[drawn]}`, { Type: "XObject", Subtype: "Form", BBox: [0, 0, 595, 842] });
    const res: Record<string, unknown> = {
      Font: { F1: helv }, XObject: { Im: solidPicture(doc, LEGIT_RGB), Fy: form(doc, "0 0 1 rg 150 100 60 60 re f", 595, 842) },
      ExtGState: { Ga: { CA: 0.5, ca: 0.5 } }, Pattern: { Pt: pattern }, Shading: { Sh: shading },
    };
    let content = "BT /F1 12 Tf 120 760 Td (LEGIT_FUORI) Tj ET ";
    if (holder === "form") {
      (res.XObject as Record<string, unknown>).Fx = fx;
      content += "/Fx Do";
    } else {
      fx.put("Group", { S: "Transparency", CS: "DeviceGray" });
      (res.ExtGState as Record<string, unknown>).GSm = { Type: "ExtGState", SMask: { Type: "Mask", S: "Luminosity", G: fx } };
      content += "q /GSm gs 0 0 1 rg 110 60 380 700 re f Q";
    }
    doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, res, content));
    return saved(doc);
  } finally {
    doc.destroy();
  }
}

/**
 * Page 1 draws, under LEAK_AREA, pictures and a form that page 2 draws another way (as after a
 * tool merged identical objects): picture M (tagged by an OBJR with /Alt SEGRETO_ALT_MASCHERA) is
 * the /SMask of page 2's picture, form G (across the area) the soft mask's group of a fill on page
 * 2, picture I the /Alternates of another, picture T page 2's /Thumb. Page 1 also has the text
 * SEGRETO_VISIBILE under the area and LEGIT_FUORI outside it.
 */
export function sharedDrawingPdf(): Uint8Array {
  const doc = new mupdf.PDFDocument();
  try {
    const root = doc.getTrailer().get("Root");
    const helv = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" });
    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, SIDE, SIDE], false);
    let mask: Obj;
    try {
      const px = pix.getPixels();
      for (let y = 0; y < SIDE; y++) for (let x = 0; x < SIDE; x++) px[y * SIDE + x] = checker(x, y) ? 255 : 0;
      mask = imageOf(doc, new mupdf.Image(pix));
    } finally {
      pix.destroy();
    }
    mask.put("StructParent", 0);
    const group = form(doc, "1 g 100 300 200 400 re f", 595, 842);
    group.put("Group", { S: "Transparency", CS: "DeviceGray" });
    const alternate = solidPicture(doc, SECRET_RGB), thumb = solidPicture(doc, SECRET_RGB, 10);
    const shown = solidPicture(doc, LEGIT_RGB, SIDE), other = solidPicture(doc, LEGIT_RGB);
    shown.put("SMask", mask);
    other.put("Alternates", [{ Image: alternate }]);
    doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { Font: { F1: helv }, XObject: { M: mask, G: group, I: alternate, T: thumb } }, [
      "BT /F1 12 Tf 120 760 Td (LEGIT_FUORI) Tj ET BT /F1 12 Tf 120 620 Td (SEGRETO_VISIBILE) Tj ET",
      "q 60 0 0 60 200 400 cm /M Do Q /G Do q 60 0 0 60 300 400 cm /I Do Q q 40 0 0 40 400 420 cm /T Do Q",
    ].join("\n")));
    const state = doc.addObject({ Type: "ExtGState", SMask: { Type: "Mask", S: "Luminosity", G: group } });
    doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { XObject: { P: shown, Q: other }, ExtGState: { GS: state } },
      "q 100 0 0 100 50 50 cm /P Do Q q /GS gs 1 0 0 rg 50 250 400 500 re f Q q 50 0 0 50 450 50 cm /Q Do Q"));
    const p1 = doc.findPage(0);
    doc.findPage(1).put("Thumb", thumb);
    const tree = doc.addObject({ Type: "StructTreeRoot" });
    const figure = doc.addObject({ Type: "StructElem", S: "Figure", P: tree, Pg: p1, Alt: doc.newString("SEGRETO_ALT_MASCHERA") });
    const objr = doc.newDictionary();
    objr.put("Type", doc.newName("OBJR"));
    objr.put("Obj", mask);
    objr.put("Pg", p1);
    figure.put("K", objr);
    tree.put("K", figure);
    tree.put("ParentTree", doc.addObject({ Nums: [0, figure] }));
    root.put("StructTreeRoot", tree);
    return saved(doc);
  } finally {
    doc.destroy();
  }
}

/**
 * Page 1 draws under LEAK_AREA what other content lists and never draws: picture I (token
 * SEGRETO_ALTERNATIVA), the /Alternates of picture K that page 1 draws outside the area; picture M
 * (SEGRETO_MASCHERA_ELENCATA), the /SMask of a picture page 2 lists; form G (the text
 * SEGRETO_GRUPPO), the soft mask's group of a graphics state page 2 lists. Page 1 also has
 * LEGIT_FUORI outside the area, page 2 draws LEGIT_PAGINA2 alone.
 */
export function listedOnlyPdf(): Uint8Array {
  const doc = new mupdf.PDFDocument();
  try {
    const helv = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" });
    const alternate = solidPicture(doc, SECRET_RGB), shown = solidPicture(doc, LEGIT_RGB), listed = solidPicture(doc, LEGIT_RGB);
    alternate.put("PENote", doc.newString("SEGRETO_ALTERNATIVA"));
    shown.put("Alternates", [{ Image: alternate }]);
    const mask = stream(doc, new Uint8Array(400).fill(128), { Type: "XObject", Subtype: "Image", Width: 20, Height: 20, ColorSpace: "DeviceGray", BitsPerComponent: 8 });
    mask.put("PENote", doc.newString("SEGRETO_MASCHERA_ELENCATA"));
    listed.put("SMask", mask);
    const group = form(doc, "BT /F1 12 Tf 120 600 Td (SEGRETO_GRUPPO) Tj ET", 595, 842, { Font: { F1: helv } });
    group.put("Group", { S: "Transparency", CS: "DeviceGray" });
    const state = doc.addObject({ Type: "ExtGState", SMask: { Type: "Mask", S: "Luminosity", G: group } });
    doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { Font: { F1: helv }, XObject: { I: alternate, K: shown, M: mask, G: group } }, [
      "BT /F1 12 Tf 120 760 Td (LEGIT_FUORI) Tj ET",
      "q 40 0 0 40 150 420 cm /I Do Q q 40 0 0 40 250 420 cm /M Do Q /G Do q 40 0 0 40 40 100 cm /K Do Q",
    ].join("\n")));
    doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { Font: { F1: helv }, XObject: { P: listed }, ExtGState: { GS: state } },
      "BT /F1 12 Tf 120 760 Td (LEGIT_PAGINA2) Tj ET"));
    return saved(doc);
  } finally {
    doc.destroy();
  }
}

/** How maskedPicturePdf's picture holds its shape. */
export type PictureMask = "stencil" | "colour-key" | "key and soft mask" | "indexed key" | "16-bit key" | "decoded key";

/**
 * A picture in LEGIT_RGB across LEAK_AREA's lower edge (as the others: rows 0..49 inside) whose
 * shape, a checkerboard in both parts (secret and legitimate), is in its /Mask alone: a stencil, or
 * a colour key (the picture white where the shape is not), on 8-bit RGB samples, on a palette's
 * indices (as PNG's transparency is written), on 16-bit samples, or on samples a /Decode inverts;
 * or a colour key and a soft mask that holds the shape (it wins: the key is not drawn).
 */
export function maskedPicturePdf(mask: PictureMask): Uint8Array {
  const doc = new mupdf.PDFDocument();
  try {
    const samples = new Uint8Array(SIDE * SIDE * 3);
    for (let y = 0; y < SIDE; y++) for (let x = 0; x < SIDE; x++) samples.set(mask === "stencil" || shape(x, y) ? LEGIT_RGB : [255, 255, 255], (y * SIDE + x) * 3);
    const dict: Record<string, unknown> = { Type: "XObject", Subtype: "Image", Width: SIDE, Height: SIDE, ColorSpace: "DeviceRGB", BitsPerComponent: 8 };
    let data = samples;
    if (mask === "indexed key") {
      data = new Uint8Array(SIDE * SIDE);
      for (let y = 0; y < SIDE; y++) for (let x = 0; x < SIDE; x++) data[y * SIDE + x] = shape(x, y) ? 1 : 0;
      dict.ColorSpace = ["Indexed", "DeviceRGB", 1, doc.newByteString(new Uint8Array([255, 255, 255, ...LEGIT_RGB]))];
      dict.Mask = [0, 0];
    } else if (mask === "16-bit key") {
      data = new Uint8Array(samples.length * 2);
      samples.forEach((v, i) => data.set([v, v], i * 2));
      dict.BitsPerComponent = 16;
      dict.Mask = [64000, 65535, 64000, 65535, 64000, 65535];
    } else if (mask === "decoded key") {
      data = samples.map((v) => 255 - v);
      dict.Decode = [1, 0, 1, 0, 1, 0];
      dict.Mask = [0, 5, 0, 5, 0, 5];
    } else if (mask !== "stencil") dict.Mask = [250, 255, 250, 255, 250, 255];
    const im = stream(doc, data, dict);
    if (mask === "stencil") im.put("Mask", stream(doc, maskBits(shape), { Type: "XObject", Subtype: "Image", Width: SIDE, Height: SIDE, ImageMask: true, BitsPerComponent: 1 }));
    else if (mask === "key and soft mask") {
      // (half see-through where the shape is not, more so to the left)
      const soft = new Uint8Array(SIDE * SIDE);
      for (let y = 0; y < SIDE; y++) for (let x = 0; x < SIDE; x++) soft[y * SIDE + x] = shape(x, y) ? 255 : Math.round((x / SIDE) * 200);
      im.put("SMask", stream(doc, soft, { Type: "XObject", Subtype: "Image", Width: SIDE, Height: SIDE, ColorSpace: "DeviceGray", BitsPerComponent: 8 }));
    }
    doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { XObject: { Im: im } }, "0 0 1 rg 90 290 120 100 re f q 60 0 0 60 110 312 cm /Im Do Q"));
    return saved(doc);
  } finally {
    doc.destroy();
  }
}

/** Where unusedHolderPdf keeps what names page 1's secrets: content never drawn (all but the last five), or drawn (the last five). */
export type Holder =
  | "form" | "pattern" | "mask" | "type3" | "nested" | "bare mask" | "unshown glyph" | "fields" | "listed group" | "unpainted pattern"
  | "unpainted stroke pattern" | "pattern nothing paints with" | "pattern at a form's end" | "shown glyph" | "set mask" | "painted pattern"
  | "pattern a Type 3 glyph fills" | "pattern a Type 3 glyph strokes";

/**
 * Page 1 draws under LEAK_AREA picture I (/PENote SEGRETO_ELENCO_FOTO) and form S (the text
 * SEGRETO_ELENCO_TESTO; with "listed group", the soft mask's group of a fill there instead), and
 * LEGIT_FUORI outside it; page 2 draws LEGIT_PAGINA2, and holds content that names I and S: a
 * form, pattern, soft mask's group or Type 3 font with resources of its own listing them, never
 * drawn ("form", "pattern", "mask", "type3"); a form page 2 draws that lists such a form it never
 * draws ("nested"); a soft mask's group without resources, which a graphics state page 2 never
 * sets names ("bare mask"); a Type 3 font without resources, whose glyph page 2 never shows draws
 * them ("unshown glyph"); page 2's resources list I and S then. Or the form fields' default
 * resources list them, and a graphics state whose group is S ("fields"); or page 2 lists the
 * group ("listed group"), or selects the pattern as its fill colour and paints in another
 * ("unpainted pattern"), as its stroke colour and only fills ("unpainted stroke pattern"), as both
 * and paints with neither (a path ended with n, invisible text, a picture, the page's end: "pattern
 * nothing paints with"), or draws a form, with resources of its own listing the pattern, that
 * selects it at its end ("pattern at a form's end"). Drawn: a Type 3 glyph page 2 shows ("shown glyph"), a soft mask's group
 * without resources page 2 paints through ("set mask"), the pattern page 2 paints with ("painted
 * pattern"), the fill pattern a Type 3 glyph fills with although the text is only stroked (1 Tr:
 * "pattern a Type 3 glyph fills"), the stroke pattern a d0 glyph strokes with although the text is
 * only filled ("pattern a Type 3 glyph strokes").
 */
export function unusedHolderPdf(holder: Holder): Uint8Array {
  const doc = new mupdf.PDFDocument();
  try {
    const helv = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" });
    const pic = solidPicture(doc, SECRET_RGB);
    pic.put("PENote", doc.newString("SEGRETO_ELENCO_FOTO"));
    const text = form(doc, "BT /F1 20 Tf 0 g 150 450 Td (SEGRETO_ELENCO_TESTO) Tj ET", 595, 842, { Font: { F1: helv } });
    text.put("Group", { S: "Transparency", CS: "DeviceGray" });
    const both = { I: pic, S: text }, draws = "q 60 0 0 60 10 10 cm /I Do Q /S Do";
    const masking = (group: Obj) => doc.addObject({ Type: "ExtGState", SMask: { Type: "Mask", S: "Luminosity", G: group } });
    const group = (resources?: unknown) => {
      const g = stream(doc, draws, { Type: "XObject", Subtype: "Form", BBox: [0, 0, 595, 842], Group: { S: "Transparency", CS: "DeviceGray" } });
      if (resources) g.put("Resources", resources);
      return g;
    };
    // (glyph a paints a box, glyph b draws I and S)
    const type3 = (resources?: unknown) => {
      const procs = { a: stream(doc, "1000 0 0 0 1000 1000 d1 0 0 1000 1000 re f"), b: stream(doc, `1000 0 0 0 1000 1000 d1 ${draws}`) };
      return doc.addObject({
        Type: "Font", Subtype: "Type3", FontBBox: [0, 0, 1000, 1000], FontMatrix: [0.001, 0, 0, 0.001, 0, 0], FirstChar: 97, LastChar: 98, Widths: [1000, 1000],
        Encoding: { Type: "Encoding", Differences: [97, doc.newName("a"), doc.newName("b")] }, CharProcs: procs, ...(resources ? { Resources: resources } : {}),
      });
    };
    const listed = holder === "listed group";
    const res1: Record<string, unknown> = { Font: { F1: helv }, XObject: listed ? { I: pic } : both };
    if (listed) res1.ExtGState = { GS: masking(text) };
    doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, res1,
      `BT /F1 12 Tf 120 760 Td (LEGIT_FUORI) Tj ET q 60 0 0 60 200 400 cm /I Do Q ${listed ? "q /GS gs 0 0 1 rg 110 350 380 280 re f Q" : "/S Do"}`));
    const res2: Record<string, unknown> = { Font: { F1: helv } };
    let content = "BT /F1 12 Tf 120 760 Td (LEGIT_PAGINA2) Tj ET";
    const pattern = () => stream(doc, draws, { Type: "Pattern", PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 20, 20], XStep: 20, YStep: 20, Resources: { XObject: both } });
    if (holder === "form") res2.XObject = { F: form(doc, draws, 595, 842, { XObject: both }) };
    else if (holder === "pattern" || holder === "unpainted pattern" || holder === "painted pattern") {
      res2.Pattern = { Pt: pattern() };
      if (holder !== "pattern") content += ` /Pattern cs /Pt scn ${holder === "unpainted pattern" ? "0 0 1 rg " : ""}50 50 200 200 re f`;
    } else if (holder === "unpainted stroke pattern") {
      res2.Pattern = { Pt: pattern() };
      content += " /Pattern CS /Pt SCN 0 0 1 rg 50 50 200 200 re f";
    } else if (holder === "pattern nothing paints with") {
      Object.assign(res2, { Pattern: { Pt: pattern() }, XObject: { O: solidPicture(doc, [0, 0, 255]) } });
      content += " /Pattern cs /Pt scn /Pattern CS /Pt SCN 50 50 200 200 re n BT /F1 12 Tf 3 Tr 300 300 Td (x) Tj ET q 20 0 0 20 300 400 cm /O Do Q";
    } else if (holder === "pattern at a form's end") {
      res2.XObject = { F: form(doc, "/Pattern cs /Pt scn", 595, 842, { Pattern: { Pt: pattern() } }) };
      content += " /F Do 0 0 1 rg 50 50 200 200 re f";
    } else if (holder === "pattern a Type 3 glyph fills" || holder === "pattern a Type 3 glyph strokes") {
      const fills = holder === "pattern a Type 3 glyph fills";
      const strokes = doc.addObject({
        Type: "Font", Subtype: "Type3", FontBBox: [0, 0, 1000, 1000], FontMatrix: [0.001, 0, 0, 0.001, 0, 0], FirstChar: 97, LastChar: 97, Widths: [1000],
        Encoding: { Type: "Encoding", Differences: [97, doc.newName("a")] }, CharProcs: { a: stream(doc, "1000 0 d0 150 w 100 100 800 800 re S") },
      });
      Object.assign(res2, { Pattern: { Pt: pattern() }, Font: { F1: helv, T3: fills ? type3() : strokes } });
      content += fills ? " /Pattern cs /Pt scn 0 G BT /T3 80 Tf 1 Tr 50 50 Td (a) Tj ET" : " /Pattern CS /Pt SCN 0 g BT /T3 80 Tf 50 50 Td (a) Tj ET";
    } else if (holder === "mask") res2.ExtGState = { GS: masking(group({ XObject: both })) };
    else if (holder === "type3") res2.Font = { F1: helv, T3: type3({ XObject: both }) };
    else if (holder === "nested") {
      res2.XObject = { F: form(doc, "0 1 0 rg 300 300 40 40 re f", 595, 842, { XObject: { F2: form(doc, draws, 595, 842, { XObject: both }) } }) };
      content += " /F Do";
    } else if (holder === "bare mask" || holder === "set mask") {
      Object.assign(res2, { XObject: both, ExtGState: { GS: masking(group()) } });
      if (holder === "set mask") content += " q /GS gs 0 0 1 rg 50 50 200 200 re f Q";
    } else if (holder === "unshown glyph") {
      Object.assign(res2, { XObject: both, Font: { F1: helv, T3: type3() } });
      content += " BT /T3 40 Tf 100 600 Td (a) Tj ET";
    } else if (holder === "shown glyph") {
      res2.Font = { F1: helv, T3: type3({ XObject: both }) };
      content += " BT /T3 40 Tf 100 600 Td (b) Tj ET";
    } else if (holder === "fields")
      doc.getTrailer().get("Root").put("AcroForm", doc.addObject({ Fields: [], DR: { Font: { Helv: helv }, XObject: both, ExtGState: { GS: masking(text) } } }));
    else if (listed) res2.XObject = { S: text };
    doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, res2, content));
    return saved(doc);
  } finally {
    doc.destroy();
  }
}

/** How taggedPdf's structure names what lies under the area. */
export type Tagging =
  | "form without parents" | "form without parents in a form with them" | "wrong limits" | "not in the parent tree" | "untagged annotations" | "inline picture in a form";

/**
 * A tagged page whose structure names what lies under LEAK_AREA where the ParentTree alone does
 * not tell: marked content in a form without /StructParents, which readers take for the page's
 * (a Span, /ActualText SEGRETO_AT_SENZA_SP, and a Figure, /Alt SEGRETO_ALT_SENZA_SP), or in one
 * drawn by a form that has them, whose ParentTree array and an MCR naming it hold the Span
 * (/ActualText SEGRETO_AT_FORMA_ESTERNA); a ParentTree
 * kid with wrong /Limits (SEGRETO_AT_LIMITI); a ParentTree without the page, the elements naming
 * their MCIDs with /Pg (SEGRETO_AT_SENZA_PT); a link and a field tagged by object references, the
 * annotations without /StructParent (SEGRETO_ALT_LINK_SENZA_SP, SEGRETO_ALT_CAMPO_SENZA_SP); an
 * inline picture across the area's edge in a form, under a /Figure with an inline /Alt
 * (SEGRETO_ALT_INLINE_FORMA). Outside the area, LEGIT_FUORI under a P with /Alt LEGIT_ALT.
 */
export function taggedPdf(how: Tagging): Uint8Array {
  const doc = new mupdf.PDFDocument();
  try {
    const str = (s: string) => doc.newString(s);
    const helv = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" });
    const legit = "/P <</MCID 0>> BDC BT /F1 12 Tf 120 760 Td (LEGIT_FUORI) Tj ET EMC";
    const span = "/Span <</MCID 1>> BDC BT /F1 12 Tf 120 600 Td (testo segreto) Tj ET EMC";
    const res: Record<string, unknown> = { Font: { F1: helv } };
    let content = `${legit} ${span}`, outer: Obj | null = null;
    if (how === "form without parents in a form with them") {
      outer = form(doc, "/Fy Do", 595, 842, { XObject: { Fy: form(doc, span, 595, 842, { Font: { F1: helv } }) } });
      outer.put("StructParents", 5);
      res.XObject = { Fx: outer };
      content = `${legit} /Fx Do`;
    } else if (how === "form without parents") {
      const im = solidPicture(doc, SECRET_RGB);
      res.XObject = { Fx: form(doc, `${span} /Figure <</MCID 2>> BDC q 60 0 0 60 150 400 cm /Im Do Q EMC`, 595, 842, { Font: { F1: helv }, XObject: { Im: im } }) };
      content = `${legit} /Fx Do`;
    } else if (how === "inline picture in a form") {
      const hex = Array.from({ length: 20 * 20 }, () => "11c822").join("");
      res.XObject = { Fx: form(doc, `/Figure <</Alt (SEGRETO_ALT_INLINE_FORMA)>> BDC q 120 0 0 120 300 300 cm BI /W 20 /H 20 /CS /RGB /BPC 8 /F /AHx ID ${hex}> EI Q EMC`, 595, 842) };
      content = `${legit} /Fx Do`;
    }
    doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, res, content));
    const p1 = doc.findPage(0), root = doc.getTrailer().get("Root");
    const tree = doc.addObject({ Type: "StructTreeRoot" });
    const top = doc.addObject({ Type: "StructElem", S: "Document", P: tree });
    const elem = (S: string, K: unknown, key: string, text: string) => doc.addObject({ Type: "StructElem", S, P: top, Pg: p1, K, [key]: str(text) });
    const elems = [elem("P", 0, "Alt", "LEGIT_ALT")];
    if (how === "form without parents") elems.push(elem("Span", 1, "ActualText", "SEGRETO_AT_SENZA_SP"), elem("Figure", 2, "Alt", "SEGRETO_ALT_SENZA_SP"));
    else if (outer) elems.push(elem("Span", doc.addObject({ Type: "MCR", MCID: 1, Stm: outer }), "ActualText", "SEGRETO_AT_FORMA_ESTERNA"));
    else if (how === "wrong limits") elems.push(elem("Span", 1, "ActualText", "SEGRETO_AT_LIMITI"));
    else if (how === "not in the parent tree") elems.push(elem("Span", 1, "ActualText", "SEGRETO_AT_SENZA_PT"));
    else if (how === "untagged annotations") {
      const objr = (o: Obj) => doc.addObject({ Type: "OBJR", Obj: o, Pg: p1 });
      const link = annotate(doc, p1, { Type: "Annot", Subtype: "Link", Rect: [200, 450, 300, 470], Border: [0, 0, 0], A: { S: "URI", URI: str("https://example.com/") } });
      const field = annotate(doc, p1, { Type: "Annot", Subtype: "Widget", FT: "Tx", T: str("cf"), V: str("x"), Rect: [200, 400, 300, 420], F: 4 });
      root.put("AcroForm", doc.addObject({ Fields: [field] }));
      elems.push(elem("Link", objr(link), "Alt", "SEGRETO_ALT_LINK_SENZA_SP"), elem("Form", objr(field), "Alt", "SEGRETO_ALT_CAMPO_SENZA_SP"));
    }
    top.put("K", elems);
    tree.put("K", top);
    const parents = doc.newArray();
    for (const e of elems) if (e.get("K").isNumber()) parents.push(e);
    const nums = doc.addObject({ Nums: how === "not in the parent tree" ? [] : outer ? [0, parents, 5, elems] : [0, parents] });
    if (how === "wrong limits") nums.put("Limits", [5, 9]); // (key 0 is not within them)
    tree.put("ParentTree", how === "wrong limits" ? doc.addObject({ Kids: [nums] }) : nums);
    root.put("StructTreeRoot", tree);
    root.put("MarkInfo", { Marked: true });
    p1.put("StructParents", 0);
    return saved(doc);
  } finally {
    doc.destroy();
  }
}

/**
 * Other channels of what lies under LEAK_AREA: a note (/Contents SEGRETO_NOTA_SENZA_POPUP) whose
 * popup, outside the area, names it by its /Parent alone and holds its own /Contents
 * (SEGRETO_POPUP_PROPRIO), and so does another, listed on page 2 (SEGRETO_POPUP_ALTROVE: writers
 * should not, a reader may still show it); a signature field's widget, signed (/Name
 * SEGRETO_NOME_FIRMA), whose certificate the document's /DSS keeps (SEGRETO_CERT_FIRMATARIO).
 * LEGIT_FUORI outside the area, LEGIT_PAGINA2 on page 2.
 */
export function annotatedPdf(): Uint8Array {
  const doc = new mupdf.PDFDocument();
  try {
    const str = (s: string) => doc.newString(s);
    const helv = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" });
    doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { Font: { F1: helv } }, "BT /F1 12 Tf 120 760 Td (LEGIT_FUORI) Tj ET"));
    const p1 = doc.findPage(0), root = doc.getTrailer().get("Root");
    const note = annotate(doc, p1, { Type: "Annot", Subtype: "Text", Rect: [200, 400, 220, 420], Contents: str("SEGRETO_NOTA_SENZA_POPUP") });
    annotate(doc, p1, { Type: "Annot", Subtype: "Popup", Rect: [400, 700, 580, 800], Parent: note, Contents: str("SEGRETO_POPUP_PROPRIO") });
    doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { Font: { F1: helv } }, "BT /F1 12 Tf 120 760 Td (LEGIT_PAGINA2) Tj ET"));
    annotate(doc, doc.findPage(1), { Type: "Annot", Subtype: "Popup", Rect: [400, 700, 580, 800], Parent: note, Contents: str("SEGRETO_POPUP_ALTROVE") });
    const cert = stream(doc, "fake DER CN=SEGRETO_CERT_FIRMATARIO O=Ditta");
    const value = doc.addObject({ Type: "Sig", Filter: "Adobe.PPKLite", SubFilter: "ETSI.CAdES.detached", Name: str("SEGRETO_NOME_FIRMA"), ByteRange: [0, 10, 20, 30], Contents: str("PKCS7") });
    const widget = annotate(doc, p1, { Type: "Annot", Subtype: "Widget", FT: "Sig", T: str("Firma1"), V: value, Rect: [150, 450, 350, 490], F: 4 });
    root.put("AcroForm", doc.addObject({ Fields: [widget], SigFlags: 3 }));
    root.put("DSS", doc.addObject({ Certs: [cert], VRI: { ABCDEF0123456789ABCDEF0123456789ABCDEF01: { Cert: [cert] } } }));
    return saved(doc);
  } finally {
    doc.destroy();
  }
}

/** A page drawing, outside any area, a DeviceCMYK picture of SECRET_RGB (as MuPDF converts it). */
export function cmykPicturePdf(): Uint8Array {
  const doc = new mupdf.PDFDocument();
  try {
    const rgb = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 20, 20], false);
    let cmyk: mupdf.Pixmap;
    try {
      const px = rgb.getPixels();
      for (let i = 0; i < 400; i++) px.set(SECRET_RGB, i * 3);
      cmyk = rgb.convertToColorSpace(mupdf.ColorSpace.DeviceCMYK);
    } finally {
      rgb.destroy();
    }
    let im: Obj;
    try {
      im = imageOf(doc, new mupdf.Image(cmyk));
    } finally {
      cmyk.destroy();
    }
    doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { XObject: { Im: im } }, "q 60 0 0 60 20 20 cm /Im Do Q"));
    return saved(doc);
  } finally {
    doc.destroy();
  }
}

// ---------------------------------------------------------------------------------------------
// Checks on a saved file

const latin1 = (u8: Uint8Array) => {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return s;
};
const utf16be = (s: string) => [...s].map((c) => "\0" + c).join("");
const hexOf = (s: string) => [...s].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");

/**
 * Where `token` is in the file: its raw bytes; every object's strings (as bytes, as text) and
 * names; every stream as stored and decoded, in Latin-1, UTF-16BE and hex. [] when nowhere.
 */
export function tokenPlaces(bytes: Uint8Array, token: string): string[] {
  const places: string[] = [];
  const forms = [token, utf16be(token), hexOf(token), hexOf(token).toUpperCase()];
  const holds = (s: string) => forms.some((f) => s.includes(f));
  if (holds(latin1(bytes))) places.push("raw file");
  const doc = openPdf(bytes);
  try {
    const visit = (o: Obj, where: string, depth: number) => {
      if (depth > 32) return;
      if (o.isString()) {
        if (holds(latin1(o.asByteString())) || o.asString().includes(token)) places.push(`${where} string`);
      } else if (o.isName()) {
        if (o.asName().includes(token)) places.push(`${where} name`);
      } else if (o.isArray()) {
        for (let k = 0; k < o.length; k++) {
          const v = o.get(k);
          if (!v.isIndirect()) visit(v, `${where}[${k}]`, depth + 1);
        }
      } else if (o.isDictionary()) {
        o.forEach((v, k) => {
          if (!v.isIndirect()) visit(v, `${where}/${k}`, depth + 1);
        });
      }
    };
    visit(doc.getTrailer(), "trailer", 0);
    for (let n = 1; n < doc.countObjects(); n++) {
      const ref = doc.newIndirect(n);
      let o: Obj;
      try {
        o = ref.resolve();
      } catch {
        continue;
      }
      if (o.isNull()) continue;
      visit(o, `obj ${n}`, 0);
      if (!ref.isStream()) continue;
      for (const [kind, read] of [["stored", () => ref.readRawStream()], ["decoded", () => ref.readStream()]] as const) {
        let buf: mupdf.Buffer | null = null;
        try {
          buf = read();
          if (holds(latin1(buf.asUint8Array()))) places.push(`obj ${n} stream ${kind}`);
        } catch {
          // a stream MuPDF cannot decode: its stored bytes were read
        } finally {
          buf?.destroy();
        }
      }
    }
  } finally {
    doc.destroy();
  }
  return places;
}

/** What the pictures of a file hold: their secret and legitimate parts (see the header). */
export interface PictureScan {
  /** Pixels within a few levels of SECRET_RGB, in every picture (objects, inline ones as drawn). */
  secretPixels: number;
  legitPixels: number;
  /** Masks, stencils, grey pictures and pictures' alpha (a colour key's), 100 × 100, with a checkerboard in the secret rows (any one is a leak). */
  secretMasks: number;
  legitMasks: number;
}

/** Whether the pixel at `o` is within a few levels of colour `c` (as many components as it has). */
const near = (px: ArrayLike<number>, o: number, c: number[]) => c.reduce((d, v, k) => d + Math.abs(px[o + k] - v), 0) < 60;

/** An RGB colour in CMYK, as MuPDF converts it (as a tool printing the secret in CMYK would). */
function inCMYK(rgb: number[]): number[] {
  const one = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 1, 1], false);
  try {
    one.getPixels().set(rgb);
    const cmyk = one.convertToColorSpace(mupdf.ColorSpace.DeviceCMYK);
    try {
      return Array.from(cmyk.getPixels());
    } finally {
      cmyk.destroy();
    }
  } finally {
    one.destroy();
  }
}

function scanPixmap(pix: mupdf.Pixmap, out: PictureScan) {
  // (samples per pixel, alpha included: a stencil's pixmap is alpha alone)
  const w = pix.getWidth(), h = pix.getHeight(), stride = pix.getStride(), n = stride / w;
  const px = pix.getPixels();
  // Colours: a CMYK picture's against the secret's in CMYK; another space's (Lab, DeviceN...) in RGB, as it shows.
  const cs = pix.getColorSpace();
  const cmyk = !!cs?.isCMYK();
  const rgb = cs && !cs.isRGB() && !cs.isGray() && !cmyk ? pix.convertToColorSpace(mupdf.ColorSpace.DeviceRGB) : pix;
  cs?.destroy();
  const [secret, legit] = cmyk ? [inCMYK(SECRET_RGB), inCMYK(LEGIT_RGB)] : [SECRET_RGB, LEGIT_RGB];
  try {
    const cstride = rgb.getStride(), cn = cstride / w, cpx = rgb.getPixels();
    if (cn >= 3) {
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const o = y * cstride + x * cn;
          if (near(cpx, o, secret)) out.secretPixels++;
          else if (near(cpx, o, legit)) out.legitPixels++;
        }
    }
  } finally {
    if (rgb !== pix) rgb.destroy();
  }
  // A mask: a grey or alpha-only pixmap, or a picture's alpha (where a colour key's shape shows).
  const at = n === 1 ? 0 : n >= 3 && pix.getAlpha() ? n - 1 : -1;
  if (at < 0 || w !== SIDE || h !== SIDE) return;
  /** Whether the part is a checkerboard: high and low samples both common. */
  const board = (part: (x: number, y: number) => boolean) => {
    let hi = 0, lo = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (part(x, y)) (px[y * stride + x * n + at] > 127 ? hi++ : lo++);
    return hi > 100 && lo > 100;
  };
  if (board(inSecret)) out.secretMasks++;
  if (board(inLegit)) out.legitMasks++;
}

function scanImage(image: mupdf.Image, out: PictureScan) {
  const pix = image.toPixmap();
  try {
    scanPixmap(pix, out);
  } finally {
    pix.destroy();
  }
  const mask = image.getMask();
  if (mask) {
    try {
      scanImage(mask, out);
    } finally {
      mask.destroy();
    }
  }
}

/**
 * Every picture of a saved file, decoded: every image object (soft masks and stencils
 * included), and every picture its pages draw (inline ones, and the masks MuPDF applies).
 */
export function pictureScan(bytes: Uint8Array): PictureScan {
  const out: PictureScan = { secretPixels: 0, legitPixels: 0, secretMasks: 0, legitMasks: 0 };
  const doc = openPdf(bytes);
  try {
    for (let n = 1; n < doc.countObjects(); n++) {
      const ref = doc.newIndirect(n);
      if (!ref.isStream() || ref.get("Subtype").toString() !== "/Image") continue;
      const image = doc.loadImage(ref);
      try {
        const pix = image.toPixmap();
        try {
          scanPixmap(pix, out);
        } finally {
          pix.destroy();
        }
      } finally {
        image.destroy();
      }
    }
    for (let i = 0; i < doc.countPages(); i++) {
      const page = doc.loadPage(i);
      const errors: unknown[] = [];
      const take = (image: mupdf.Image) => {
        try {
          scanImage(image, out);
        } catch (e) {
          errors.push(e);
        } finally {
          image.destroy();
        }
      };
      const dev = new mupdf.Device({
        fillImage(image) { take(image); },
        fillImageMask(image, _ctm, cs) { take(image); cs.destroy(); },
      });
      try {
        page.runPageContents(dev, mupdf.Matrix.identity);
        dev.close();
      } finally {
        dev.destroy();
        page.destroy();
      }
      if (errors.length) throw errors[0];
    }
  } finally {
    doc.destroy();
  }
  return out;
}

/** The page's text as MuPDF extracts it. */
export function pageText(doc: Doc, pageIndex: number): string {
  const page = doc.loadPage(pageIndex);
  try {
    const st = page.toStructuredText("preserve-whitespace");
    try {
      return st.asText();
    } finally {
      st.destroy();
    }
  } finally {
    page.destroy();
  }
}
