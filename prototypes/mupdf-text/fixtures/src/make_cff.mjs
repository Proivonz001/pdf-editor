// Builds fixtures/cff-subset.pdf with MuPDF itself: one CID-keyed CFF font
// (Type0 / CIDFontType0, FontFile3, subset) plus a bold title in a simple font
// (MuPDF writes base-14 simple fonts as non-embedded references). Fonts: the
// built-in Nimbus (URW base35) that MuPDF ships.
//   node prototypes/mupdf-text/fixtures/src/make_cff.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WinAnsiEncoding } from "../../src/tables.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const mupdf = await import(pathToFileURL(path.join(here, "../../../../lib/mupdf.js")).href);

const doc = new mupdf.PDFDocument();
const cidFont = new mupdf.Font("Times-Roman");
const simpleFont = new mupdf.Font("Times-Bold");
const cidRef = doc.addFont(cidFont); // Type0 Identity-H, CIDFontType0 (CFF)
const simpleRef = doc.addSimpleFont(simpleFont, "Latin"); // base-14: not embedded

const cidHex = (s) => [...s].map((c) => cidFont.encodeCharacter(c.codePointAt(0)).toString(16).padStart(4, "0")).join("");
const simpleHex = (s) => [...s].map((c) => WinAnsiEncoding.indexOf(c.codePointAt(0)).toString(16).padStart(2, "0")).join("");

const content = [
	`BT /FS 18 Tf 72 760 Td <${simpleHex("Titolo grassetto: perché più")}> Tj ET`,
	`BT /FC 12 Tf 72 730 Td <${cidHex("Relazione: il prezzo è 12 € – “ok” l’anno.")}> Tj ET`,
	`BT /FC 12 Tf 72 712 Td <${cidHex("Seconda riga in Times, con città e così.")}> Tj ET`,
].join("\n");
doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { Font: { FC: cidRef, FS: simpleRef } }, content));
doc.subsetFonts();
const out = path.join(here, "..", "cff-subset.pdf");
fs.writeFileSync(out, doc.saveToBuffer("garbage=compact,compress=yes").asUint8Array());
console.log("wrote", out, fs.statSync(out).size, "bytes");
console.log("encoding of simple font:", doc.loadPage(0).getObject().get("Resources", "Font", "FS", "Encoding").toString());
