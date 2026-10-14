// Save-option experiments:  node prototypes/mupdf-text/experiments.mjs
// Keep vs drop encryption, re-encrypt with new passwords, incremental save.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { extractLines, openPdf, pageText, replaceText } from "./src/core.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const mupdf = await import(pathToFileURL(path.join(here, "../../lib/mupdf.js")).href);
const fixture = (f) => new Uint8Array(fs.readFileSync(path.join(here, "fixtures", f)));
const out = {};

function editAndSave(file, password, opts) {
	const bytes = fixture(file);
	const { doc } = openPdf(mupdf, bytes, password);
	replaceText(mupdf, doc, 0, "prezzo", "importo");
	const t0 = performance.now();
	const buf = doc.saveToBuffer(opts);
	const ms = +(performance.now() - t0).toFixed(1);
	const saved = buf.asUint8Array().slice();
	doc.destroy();
	return { bytes, saved, ms };
}

function reopen(saved, password) {
	const doc = mupdf.Document.openDocument(saved, "application/pdf");
	const needs = doc.needsPassword();
	const auth = needs ? doc.authenticatePassword(password) : null;
	const text = auth === 0 ? "" : pageText(extractLines(doc.loadPage(0)));
	return { needsPassword: needs, auth, hasNewWord: text.includes("importo"), oldGone: !text.includes("prezzo") };
}

// 1. Default save keeps the original encryption (same passwords).
{
	const r = editAndSave("enc-user-aes128.pdf", "utente", "garbage=compact,compress=yes");
	out.keepEncryption = { ...reopen(r.saved, "utente"), wrongPassword: reopen(r.saved, "nope").auth, ms: r.ms };
}
// 2. decrypt=yes writes a plain file.
{
	const r = editAndSave("enc-user-aes128.pdf", "utente", "garbage=compact,compress=yes,decrypt=yes");
	out.decrypt = { ...reopen(r.saved, ""), ms: r.ms };
}
// 3. Re-encrypt with new passwords (a "protect" feature for free).
{
	const r = editAndSave("chrome-subset.pdf", "", "garbage=compact,compress=yes,encrypt=aes-256,user-password=nuova,owner-password=admin,permissions=-1");
	out.reEncryptAes256 = { ...reopen(r.saved, "nuova"), ms: r.ms };
}
// 4. Incremental save: original bytes untouched, changes appended (keeps
//    earlier signatures valid as a revision). Not combinable with garbage.
{
	const r = editAndSave("chrome-subset.pdf", "", "incremental");
	const prefixSame = Buffer.compare(Buffer.from(r.saved.subarray(0, r.bytes.length)), Buffer.from(r.bytes)) === 0;
	out.incremental = { ...reopen(r.saved, ""), originalBytesArePrefix: prefixSame, sizeIn: r.bytes.length, sizeOut: r.saved.length, ms: r.ms };
}
console.log(JSON.stringify(out, null, 1));
fs.mkdirSync(path.join(here, "out"), { recursive: true });
fs.writeFileSync(path.join(here, "out", "experiments.json"), JSON.stringify(out, null, 1));
