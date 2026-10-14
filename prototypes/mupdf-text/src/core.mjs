// MuPDF-only text replacement, shared by the Node runner and the Web Worker.
// Every function takes the mupdf module explicitly so the same code runs in
// both places. Coordinates: "page space" is MuPDF's (y down, rotation and
// CropBox applied, what stext/annotations use); "user space" is raw PDF.

import { AGL, MacRomanEncoding, StandardEncoding, WinAnsiEncoding } from "./tables.mjs";

export const now = () => performance.now();

// ---------------------------------------------------------------- open / save

export function openPdf(mupdf, bytes, password = "") {
	const doc = mupdf.Document.openDocument(bytes, "application/pdf");
	const info = { needsPassword: doc.needsPassword(), auth: null };
	if (info.needsPassword) {
		info.auth = doc.authenticatePassword(password); // 0 = wrong password
		if (!info.auth) throw new Error("wrong password");
	}
	return { doc, info };
}

// subset: "fallback" shrinks only the fallback fonts we embedded (default),
// "all" runs MuPDF's subsetFonts() on every font, "none" keeps them whole.
export function savePdf(mupdf, doc, { garbage = "compact", decrypt = true, subset = "fallback" } = {}) {
	if (subset === "all") doc.subsetFonts();
	else if (subset === "fallback") subsetFallbackFonts(mupdf, doc);
	const opts = `garbage=${garbage},compress=yes${decrypt ? ",decrypt=yes" : ""}`;
	const buf = doc.saveToBuffer(opts);
	const bytes = buf.asUint8Array().slice(); // copy out of the wasm heap
	buf.destroy();
	return { bytes, opts };
}

// --------------------------------------------------------------- 1. render

// Renders a page (or a page-space clip rectangle) to an opaque RGBA pixmap.
export function renderPixmap(mupdf, page, scale = 1.5, clip = null) {
	const m = mupdf.Matrix.scale(scale, scale);
	const r = mupdf.Rect.transform(clip || page.getBounds(), m);
	const bbox = [Math.floor(r[0]), Math.floor(r[1]), Math.ceil(r[2]), Math.ceil(r[3])];
	const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, bbox, true);
	pix.clear(255); // opaque white: premultiplied == straight alpha
	const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
	page.run(dev, m);
	dev.close();
	dev.destroy();
	return pix;
}

export function pixmapToRGBA(pix) {
	return {
		width: pix.getWidth(),
		height: pix.getHeight(),
		rgba: new Uint8ClampedArray(pix.getPixels()), // copy before the heap moves
	};
}

// ------------------------------------------------------ 2. structured text

export function extractLines(page, options = "preserve-whitespace") {
	const st = page.toStructuredText(options);
	const lines = [];
	let cur = null;
	st.walk({
		beginLine(bbox, wmode, dir) {
			cur = { bbox, wmode, dir, chars: [] };
		},
		onChar(c, origin, font, size, quad, color) {
			cur.chars.push({
				c, origin, quad, size, color, font,
				fontName: font.getName(),
				bold: font.isBold(), italic: font.isItalic(),
				serif: font.isSerif(), mono: font.isMono(),
			});
		},
		endLine() {
			cur.text = cur.chars.map((ch) => ch.c).join("");
			lines.push(cur);
		},
	});
	st.destroy();
	return lines;
}

export function pageText(lines) {
	return lines.map((l) => l.text).join("\n");
}

export function findInLines(lines, needle, occurrence = 0) {
	let seen = 0;
	for (const line of lines) {
		let from = 0;
		for (;;) {
			const at = line.text.indexOf(needle, from);
			if (at < 0) break;
			if (seen++ === occurrence)
				return { line, start: at, chars: line.chars.slice(at, at + needle.length) };
			from = at + 1;
		}
	}
	return null;
}

export function countOccurrences(text, needle) {
	let n = 0;
	for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) n++;
	return n;
}

// Exact per-glyph data the stext walker does not give: glyph id, the full
// glyph matrix (font size, Tz, rise, rotation) and the paint colour space.
export function captureGlyphs(mupdf, page) {
	const out = [];
	const take = (text, ctm, paint) => {
		text.walk({
			showGlyph(font, trm, gid, uni, wmode) {
				out.push({ font, fontName: font.getName(), gid, uni, wmode, m: mupdf.Matrix.concat(trm, ctm), ...paint });
			},
		});
		text.destroy();
	};
	const dev = new mupdf.Device({
		fillText(text, ctm, cs, color, alpha) { take(text, ctm, { mode: "fill", csType: cs.getType(), color, alpha }); },
		strokeText(text, _s, ctm, cs, color, alpha) { take(text, ctm, { mode: "stroke", csType: cs.getType(), color, alpha }); },
		clipText(text, ctm) { take(text, ctm, { mode: "clip" }); },
		clipStrokeText(text, _s, ctm) { take(text, ctm, { mode: "clip" }); },
		ignoreText(text, ctm) { take(text, ctm, { mode: "invisible" }); },
	});
	page.runPageContents(dev, mupdf.Matrix.identity);
	dev.close();
	dev.destroy();
	return out;
}

function matchGlyph(ch, glyphs) {
	const cp = ch.c.codePointAt(0);
	let best = null, bestD = 0.1;
	for (const g of glyphs) {
		if (g.uni !== cp) continue;
		const d = Math.hypot(g.m[4] - ch.origin[0], g.m[5] - ch.origin[1]);
		if (d < bestD || (d === bestD && g.mode === "fill")) { best = g; bestD = d; }
	}
	return best;
}

// ------------------------------------------------- 3. PDF font dictionaries

// MuPDF keeps font names in a 32-byte buffer, so long BaseFonts get truncated.
const nameMatches = (baseFont, fzName) =>
	baseFont === fzName || (fzName.length >= 31 && baseFont.startsWith(fzName));
// Same face, ignoring the subset tag that subsetFonts() may add on save.
const untag = (n) => n.replace(/^[A-Z]{6}\+/, "");
const sameFace = (a, b) => untag(a) === untag(b) || (untag(b).length >= 24 && untag(a).startsWith(untag(b)));

function dictEntries(obj) {
	const list = [];
	if (obj && obj.isDictionary()) obj.forEach((v, k) => list.push([k, v]));
	return list;
}

// All font dicts reachable from the page, including inside Form XObjects.
function collectFonts(resources, path, seen, out) {
	if (!resources || !resources.isDictionary()) return out;
	for (const [key, ref] of dictEntries(resources.get("Font"))) out.push({ key, ref, path });
	for (const [key, xo] of dictEntries(resources.get("XObject"))) {
		if (xo.isIndirect()) {
			if (seen.has(xo.asIndirect())) continue;
			seen.add(xo.asIndirect());
		}
		if (xo.get("Subtype").asName() === "Form")
			collectFonts(xo.get("Resources"), path.concat(key), seen, out);
	}
	return out;
}

function hexToInt(tok) {
	return parseInt(tok.slice(1, -1).replace(/\s+/g, "") || "0", 16);
}

function hexToUnicode(tok) {
	const h = tok.slice(1, -1).replace(/\s+/g, "");
	const units = [];
	for (let i = 0; i + 4 <= h.length; i += 4) units.push(parseInt(h.slice(i, i + 4), 16));
	if (h.length === 2) units.push(parseInt(h, 16));
	return String.fromCharCode(...units);
}

// ToUnicode CMap -> Map(code -> string). Handles bfchar and both bfrange forms.
export function parseToUnicode(text) {
	const map = new Map();
	const tok = text.match(/<[0-9A-Fa-f\s]*>|\[|\]|[^\s<>[\]]+/g) || [];
	for (let i = 0; i < tok.length; i++) {
		if (tok[i] === "beginbfchar") {
			for (i++; i + 1 < tok.length && tok[i] !== "endbfchar"; i += 2)
				if (tok[i + 1].startsWith("<")) map.set(hexToInt(tok[i]), hexToUnicode(tok[i + 1]));
		} else if (tok[i] === "beginbfrange") {
			for (i++; i + 2 < tok.length && tok[i] !== "endbfrange";) {
				const lo = hexToInt(tok[i]), hi = Math.min(hexToInt(tok[i + 1]), lo + 0xffff);
				if (tok[i + 2] === "[") {
					let j = i + 3;
					for (let c = lo; tok[j] !== "]" && j < tok.length; j++, c++) map.set(c, hexToUnicode(tok[j]));
					i = j + 1;
				} else {
					const base = hexToUnicode(tok[i + 2]);
					const head = base.slice(0, -1), last = base.charCodeAt(base.length - 1);
					for (let c = lo; c <= hi; c++) map.set(c, head + String.fromCharCode(last + c - lo));
					i += 3;
				}
			}
		}
	}
	return map;
}

function streamText(stm) {
	const buf = stm.readStream();
	const bytes = buf.asUint8Array();
	let s = "";
	for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
	buf.destroy();
	return s;
}

function glyphNameToUnicode(name) {
	if (AGL[name] !== undefined) return AGL[name];
	let m = /^uni([0-9A-Fa-f]{4})/.exec(name) || /^u([0-9A-Fa-f]{4,6})$/.exec(name);
	if (m) return parseInt(m[1], 16);
	const dot = name.indexOf(".");
	return dot > 0 ? glyphNameToUnicode(name.slice(0, dot)) : 0;
}

// Simple fonts: code -> Unicode from /Encoding (+ /Differences).
function simpleEncoding(fontObj, subtype) {
	const enc = fontObj.get("Encoding");
	const flags = fontObj.get("FontDescriptor", "Flags");
	const symbolic = flags.isNumber() && (flags.asNumber() & 4) !== 0;
	let base = enc.isName() ? enc.asName() : null;
	let diffs = null;
	if (enc.isDictionary()) {
		const b = enc.get("BaseEncoding");
		if (b.isName()) base = b.asName();
		diffs = enc.get("Differences");
	}
	let table;
	if (base === "WinAnsiEncoding") table = WinAnsiEncoding;
	else if (base === "MacRomanEncoding") table = MacRomanEncoding;
	else if (base === "StandardEncoding") table = StandardEncoding;
	else if (symbolic) table = new Array(256).fill(0); // built-in encoding: only ToUnicode can tell
	else table = subtype === "TrueType" ? WinAnsiEncoding : StandardEncoding;
	table = table.slice();
	if (diffs && diffs.isArray()) {
		let code = 0;
		diffs.forEach((item) => {
			if (item.isNumber()) code = item.asNumber();
			else if (item.isName()) table[code++] = glyphNameToUnicode(item.asName());
		});
	}
	return table;
}

// What we know about one PDF font dict, and how to address its glyphs.
export class PdfFont {
	constructor(ref, fzFont) {
		this.ref = ref;
		this.fzFont = fzFont;
		this.subtype = ref.get("Subtype").asName();
		this.baseFont = ref.get("BaseFont").asName();
		this.isType0 = this.subtype === "Type0";
		this.supported = true;
		this.identityGid = false;
		if (this.isType0) {
			const enc = ref.get("Encoding");
			this.encodingName = enc.isName() ? enc.asName() : "(embedded CMap)";
			this.supported = this.encodingName === "Identity-H";
			const desc = ref.get("DescendantFonts", 0);
			this.cidSubtype = desc.get("Subtype").asName();
			const c2g = desc.get("CIDToGIDMap");
			this.identityGid = this.cidSubtype === "CIDFontType2" && (c2g.isNull() || (c2g.isName() && c2g.asName() === "Identity"));
			this.bytes = 2;
			this.embedded = ["FontFile", "FontFile2", "FontFile3"].some((k) => !desc.get("FontDescriptor", k).isNull());
		} else {
			this.bytes = 1;
			this.encoding = simpleEncoding(ref, this.subtype);
			this.embedded = ["FontFile", "FontFile2", "FontFile3"].some((k) => !ref.get("FontDescriptor", k).isNull());
			if (this.subtype === "Type3") this.supported = false;
		}
		const tu = ref.get("ToUnicode");
		this.toUnicode = tu.isStream() ? parseToUnicode(streamText(tu)) : new Map();
		this.hasToUnicode = tu.isStream();
		this.reverse = new Map(); // char -> [codes]
		for (const [code, str] of this.toUnicode) {
			if (!this.reverse.has(str)) this.reverse.set(str, []);
			this.reverse.get(str).push(code);
		}
		this.probed = new Map(); // code -> {gid, uni, ink}
	}

	// Codes that might draw `ch`, best first, with where each guess came from.
	candidates(ch) {
		const out = [];
		const push = (code, how) => { if (!out.some((c) => c.code === code)) out.push({ code, how }); };
		for (const code of this.reverse.get(ch) || []) push(code, "ToUnicode");
		const cp = ch.codePointAt(0);
		if (!this.isType0) {
			for (let code = 0; code < 256; code++) if (this.encoding[code] === cp) push(code, "Encoding");
		} else if (this.identityGid && this.fzFont) {
			const gid = this.fzFont.encodeCharacter(cp);
			if (gid > 0) push(gid, "font cmap (Identity CID=GID)");
		}
		return out;
	}
}

export function hexCode(code, bytes) {
	return code.toString(16).padStart(bytes * 2, "0");
}

// Draws each candidate code twice with the ORIGINAL font dict in a scratch
// document (grafted copy, the user's document is untouched) and reports, per
// code: the glyph id MuPDF resolves, the Unicode it extracts, how much ink the
// glyph puts down, and the advance the PDF widths give it versus the glyph's
// own advance. This catches codes whose glyph was dropped from a subset
// (empty outline or .notdef) and codes with no width entry, before writing.
export function probeCodes(mupdf, font, codes) {
	const todo = codes.filter((c) => !font.probed.has(c));
	if (!todo.length) return;
	const CW = 100, CH = 48, COLS = 8, SIZE = 30;
	const rows = Math.ceil(todo.length / COLS), H = rows * CH;
	const scratch = new mupdf.PDFDocument();
	try {
		const f = scratch.graftObject(font.ref);
		let ops = "BT\n/P " + SIZE + " Tf\n";
		todo.forEach((code, i) => {
			const x = (i % COLS) * CW + 9, y = H - (Math.floor(i / COLS) + 1) * CH + 12;
			const hex = hexCode(code, font.bytes);
			ops += `1 0 0 1 ${x} ${y} Tm <${hex}${hex}> Tj\n`;
		});
		ops += "ET\n";
		const pageObj = scratch.addPage([0, 0, COLS * CW, H], 0, { Font: { P: f } }, ops);
		scratch.insertPage(-1, pageObj);
		const page = scratch.loadPage(0);
		const glyphs = captureGlyphs(mupdf, page);
		const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, COLS * CW, H], false);
		pix.clear(255);
		const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
		page.run(dev, mupdf.Matrix.identity);
		dev.close();
		const px = pix.getPixels(), stride = pix.getStride();
		todo.forEach((code, i) => {
			const cx = (i % COLS) * CW, cy = Math.floor(i / COLS) * CH;
			let ink = 0;
			for (let y = cy; y < cy + CH; y++)
				for (let x = cx; x < cx + CW; x++) if (px[y * stride + x] < 160) ink++;
			// First glyph origin in page space: x = cx + 9, baseline at cy + CH - 12.
			const base = cy + CH - 12;
			const g = glyphs.find((g) => Math.abs(g.m[4] - (cx + 9)) < 0.5 && Math.abs(g.m[5] - base) < 0.5);
			const g2 = g && glyphs.find((h) => h !== g && Math.abs(h.m[5] - base) < 0.5 && h.m[4] > g.m[4] - 0.01 && h.m[4] < cx + CW);
			font.probed.set(code, {
				gid: g ? g.gid : -1, uni: g ? g.uni : -1, ink,
				pdfAdvance: g2 ? (g2.m[4] - g.m[4]) / SIZE : 0, // what viewers will use (em)
				glyphAdvance: g && g.gid > 0 ? g.font.advanceGlyph(g.gid) : 0, // font program (em)
			});
		});
		dev.destroy();
		pix.destroy();
	} finally {
		scratch.destroy();
	}
}

const isSpace = (ch) => ch === " " || ch === " ";

// Decide, per character, whether this original font dict can draw it.
function resolveInOriginal(mupdf, font, ch) {
	if (!font.supported) return { ok: false, why: `font type not handled (${font.subtype} ${font.encodingName || ""})` };
	const cands = font.candidates(ch);
	if (!cands.length) return { ok: false, why: "no code maps to this character" };
	probeCodes(mupdf, font, cands.map((c) => c.code));
	let why = "glyph not in the embedded subset (no ink)";
	for (const c of cands) {
		const p = font.probed.get(c.code);
		if (p.gid <= 0 && font.embedded) continue; // .notdef in an embedded font
		if (!isSpace(ch) && p.ink === 0) continue;
		// Codes the document already uses (ToUnicode) keep the document's widths.
		// Any other code must get the glyph's real advance from the PDF widths;
		// Type0 widths can be patched (/W), simple-font /Widths ranges cannot.
		let needWidth = false;
		const off = Math.abs(p.pdfAdvance - p.glyphAdvance);
		if (c.how !== "ToUnicode" && p.glyphAdvance > 0 && off > 0.01 + 0.02 * p.glyphAdvance) {
			if (!font.isType0) { why = "no width for this code in /Widths"; continue; }
			needWidth = true;
		}
		return {
			ok: true, code: c.code, how: c.how, gid: p.gid, needWidth,
			width: Math.round(p.glyphAdvance * 1000), extracts: p.uni === ch.codePointAt(0),
		};
	}
	return { ok: false, why };
}

// Adds /W entries (CID widths) for codes we newly address in a Type0 font.
function extendWidths(doc, font, entries) {
	if (!entries.length) return 0;
	const desc = font.ref.get("DescendantFonts", 0);
	let w = desc.get("W");
	if (!w.isArray()) w = desc.put("W", doc.newArray());
	for (const [cid, width] of entries) {
		w.push(cid);
		w.push([width]);
	}
	return entries.length;
}

// ---------------------------------------------------------- fallback fonts

const BASE14 = {
	sans: ["Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique"],
	serif: ["Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic"],
	mono: ["Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique"],
};

function styleOf(ch) {
	const n = ch.fontName.replace(/^[A-Z]{6}\+/, "");
	const mono = ch.mono || /mono|courier|consola|code/i.test(n);
	const serif = !mono && (ch.serif || /times|georgia|cambria|garamond|serif|roman|book|minion|palatino/i.test(n));
	const bold = ch.bold || /bold|black|heavy|semibold/i.test(n);
	const italic = ch.italic || /italic|oblique/i.test(n);
	return { family: mono ? "mono" : serif ? "serif" : "sans", bold, italic };
}

const fallbackCache = new WeakMap(); // PDFDocument -> Map(name -> {font, ref})

// Built-in Base-14 (Nimbus) matching the original's style, then any extra
// font the caller bundles (e.g. Noto Sans), then MuPDF's built-in CJK font.
function fallbackChain(mupdf, style, extraFonts = []) {
	const names = [BASE14[style.family][(style.bold ? 1 : 0) + (style.italic ? 2 : 0)]];
	return [...names.map((n) => ({ name: n, make: () => new mupdf.Font(n) })),
		...extraFonts.map((f) => ({ name: f.name, make: () => new mupdf.Font(f.name, f.bytes) })),
		{ name: "CJK (zh-Hans)", make: () => new mupdf.Font("zh-Hans") }];
}

function fallbackFor(mupdf, doc, chain, cp) {
	let cache = fallbackCache.get(doc);
	if (!cache) fallbackCache.set(doc, (cache = new Map()));
	for (const entry of chain) {
		let fb = cache.get(entry.name);
		if (!fb) {
			const font = entry.make();
			fb = { font, ref: null, name: entry.name, used: new Set() };
			cache.set(entry.name, fb);
		}
		const gid = fb.font.encodeCharacter(cp);
		if (gid > 0) {
			if (!fb.ref) fb.ref = doc.addFont(fb.font); // Type0 / Identity-H + ToUnicode
			return { fb, gid };
		}
	}
	return null;
}

// A fallback font is embedded whole by addFont() (Nimbus ~30-60 KB, the CJK
// font ~1.7 MB). Subset it in a scratch document that uses exactly the glyphs
// we wrote, then point the pages at the grafted subset. Original fonts are
// never touched. Codes stay valid: for Identity-H CID fonts MuPDF's subsetter
// keeps glyph ids (unused glyphs are emptied, not renumbered).
export function subsetFallbackFonts(mupdf, doc) {
	const cache = fallbackCache.get(doc);
	if (!cache) return 0;
	let n = 0;
	for (const fb of cache.values()) {
		if (!fb.ref || !fb.used.size) continue;
		const scratch = new mupdf.PDFDocument();
		try {
			const ref = scratch.addFont(fb.font);
			const hex = [...fb.used].map((g) => hexCode(g, 2)).join("");
			scratch.insertPage(-1, scratch.addPage([0, 0, 100, 100], 0, { Font: { F: ref } }, `BT /F 10 Tf <${hex}> Tj ET`));
			scratch.subsetFonts();
			const small = doc.graftObject(ref);
			const oldNum = fb.ref.asIndirect();
			for (let i = 0; i < doc.countPages(); i++) {
				const fonts = doc.findPage(i).get("Resources", "Font");
				for (const [k, v] of dictEntries(fonts)) if (v.isIndirect() && v.asIndirect() === oldNum) fonts.put(k, small);
			}
			fb.ref = small;
			n++;
		} finally {
			scratch.destroy();
		}
	}
	return n;
}

// ------------------------------------------------------------- page edits

function resourcesOf(doc, pageObj) {
	let res = pageObj.get("Resources");
	if (!res.isDictionary()) {
		// Inherited (or missing): give the page its own shallow copy.
		const inh = pageObj.getInheritable("Resources");
		res = doc.newDictionary();
		for (const [k, v] of dictEntries(inh)) res.put(k, v);
		pageObj.put("Resources", res);
	}
	return res;
}

// Returns the resource name under which `ref` is reachable from the page,
// adding it (under a fresh name) when the page no longer lists it.
function fontKey(doc, pageObj, ref) {
	const res = resourcesOf(doc, pageObj);
	let fonts = res.get("Font");
	if (!fonts.isDictionary()) fonts = res.put("Font", doc.newDictionary());
	const num = ref.isIndirect() ? ref.asIndirect() : -1;
	for (const [k, v] of dictEntries(fonts)) if (v.isIndirect() && v.asIndirect() === num) return k;
	let i = 1, key;
	do key = "FPE" + i++; while (!fonts.get(key).isNull());
	fonts.put(key, ref);
	return key;
}

function appendContent(doc, pageObj, ops) {
	// Wrap the existing content in q/Q so our text starts from a clean state.
	const old = pageObj.get("Contents");
	const arr = doc.newArray();
	arr.push(doc.addStream("q\n", {}));
	if (old.isArray()) old.forEach((s) => arr.push(s));
	else if (!old.isNull()) arr.push(old);
	arr.push(doc.addStream("Q\n" + ops, {}));
	pageObj.put("Contents", arr);
}

// Adds bfchar entries to an existing ToUnicode CMap (only for codes it lacks),
// so other viewers extract the right text for glyphs we newly address.
function extendToUnicode(doc, font, entries) {
	const tu = font.ref.get("ToUnicode");
	if (!tu.isStream() || !entries.length) return 0;
	const text = streamText(tu);
	const body = entries.map(([code, ch]) =>
		`<${hexCode(code, font.bytes)}> <${[...ch].map((c) => c.charCodeAt(0).toString(16).padStart(4, "0")).join("")}>`).join("\n");
	const block = `${entries.length} beginbfchar\n${body}\nendbfchar\n`;
	const at = text.lastIndexOf("endcmap");
	if (at < 0) return 0;
	tu.writeStream(text.slice(0, at) + block + text.slice(at));
	for (const [code, ch] of entries) font.toUnicode.set(code, ch);
	return entries.length;
}

const fmt = (v) => String(+v.toFixed(4));

function colorOp(paint, stextColor) {
	const c = paint.color || [];
	if (paint.csType === "Gray" && c.length === 1) return `${fmt(c[0])} g`;
	if (paint.csType === "RGB" && c.length === 3) return `${c.map(fmt).join(" ")} rg`;
	if (paint.csType === "CMYK" && c.length === 4) return `${c.map(fmt).join(" ")} k`;
	return `${stextColor.map(fmt).join(" ")} rg`; // ICC/Separation/...: sRGB approximation
}

function shrinkQuad(q, fx = 0.7, fy = 0.5) {
	const cx = (q[0] + q[2] + q[4] + q[6]) / 4, cy = (q[1] + q[3] + q[5] + q[7]) / 4;
	const ux = (q[2] - q[0]) / 2, uy = (q[3] - q[1]) / 2; // half baseline vector
	const vx = (q[4] - q[0]) / 2, vy = (q[5] - q[1]) / 2; // half ascent->descent vector
	const p = (su, sv) => [cx + su * fx * ux + sv * fy * vx, cy + su * fx * uy + sv * fy * vy];
	return [...p(-1, -1), ...p(1, -1), ...p(-1, 1), ...p(1, 1)];
}

function quadBounds(quads) {
	const xs = quads.flatMap((q) => [q[0], q[2], q[4], q[6]]), ys = quads.flatMap((q) => [q[1], q[3], q[5], q[7]]);
	return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

// Replace the `occurrence`-th match of `find` on a page with `replacement`,
// reusing the original embedded font for every glyph it really contains.
export function replaceText(mupdf, doc, pageIndex, find, replacement, opts = {}) {
	const t = {};
	let t0 = now();
	const page = doc.loadPage(pageIndex);
	const lines = extractLines(page);
	t.stext = now() - t0;

	const hit = findInLines(lines, find, opts.occurrence || 0);
	if (!hit) throw new Error(`"${find}" not found on page ${pageIndex + 1}`);
	t0 = now();
	const glyphs = captureGlyphs(mupdf, page);
	const orig = hit.chars.map((ch) => matchGlyph(ch, glyphs));
	t.glyphs = now() - t0;
	const first = hit.chars[0], g0 = orig[0];
	if (!g0) throw new Error("could not match the stext char to a drawn glyph");

	// ---- find the font dict the original glyphs came from, and prove it:
	// drawing the original word's codes with it must yield the same glyph ids.
	t0 = now();
	const pageObj = page.getObject();
	const all = collectFonts(pageObj.getInheritable("Resources"), [], new Set(), []);
	const cands = all.filter((f) => nameMatches(f.ref.get("BaseFont").asName() || "", g0.fontName));
	let font = null, fontEntry = null, verifiedGids = 0;
	const seenObj = new Set();
	for (const entry of cands) {
		const num = entry.ref.isIndirect() ? entry.ref.asIndirect() : -1;
		if (num >= 0 && seenObj.has(num)) continue;
		seenObj.add(num);
		const f = new PdfFont(entry.ref, g0.font);
		let match = 0;
		hit.chars.forEach((ch, i) => {
			const r = resolveInOriginal(mupdf, f, ch.c);
			if (r.ok && orig[i] && (r.gid === orig[i].gid || !f.embedded)) match++;
		});
		if (!font || match > verifiedGids) { font = f; fontEntry = entry; verifiedGids = match; }
		if (match === hit.chars.length) break;
	}
	t.fontAnalysis = now() - t0;

	// Producers sometimes split one face into several dicts (Word writes a
	// WinAnsi TrueType and an Identity-H Type0 subset of the same font): those
	// are still the original font, so they are tried before any fallback.
	const originals = [];
	if (font) {
		originals.push(font);
		const seen = new Set([font.ref.isIndirect() ? font.ref.asIndirect() : -1]);
		for (const e of all) {
			const bf = e.ref.get("BaseFont").asName() || "";
			const num = e.ref.isIndirect() ? e.ref.asIndirect() : -1;
			if (seen.has(num) || untag(bf) !== untag(font.baseFont)) continue;
			seen.add(num);
			const fz = glyphs.find((g) => nameMatches(bf, g.fontName));
			originals.push(new PdfFont(e.ref, fz ? fz.font : null));
		}
	}

	// ---- plan: one segment per run of characters drawn by the same font
	t0 = now();
	const style = styleOf(first);
	const chain = fallbackChain(mupdf, style, opts.extraFonts);
	const plan = [];
	const missing = [];
	const toUnicodeAdds = new Map(); // PdfFont -> [[code, char]]
	const widthAdds = new Map(); // PdfFont -> [[cid, width]]
	const addOnce = (map, key, val) => {
		if (!map.has(key)) map.set(key, []);
		if (!map.get(key).some(([c]) => c === val[0])) map.get(key).push(val);
	};
	// Last resort before a fallback: the embedded font the document itself
	// used for this very character on the same line (Word, for instance, draws
	// à/ì/ù/’ with its East Asian font slot when the run is tagged that way).
	const byNum = new Map(originals.map((f) => [f.ref.isIndirect() ? f.ref.asIndirect() : -1, f]));
	const lineFontsFor = (ch) => {
		const out = [];
		const same = (c) => { const a = styleOf(c); return a.bold === style.bold && a.italic === style.italic; };
		for (const name of new Set(hit.line.chars.filter((c) => c.c === ch && same(c)).map((c) => c.fontName))) {
			const e = all.find((e) => nameMatches(e.ref.get("BaseFont").asName() || "", name));
			if (!e) continue;
			const num = e.ref.isIndirect() ? e.ref.asIndirect() : -1;
			if (!byNum.has(num)) {
				const fz = glyphs.find((g) => g.fontName === name);
				byNum.set(num, Object.assign(new PdfFont(e.ref, fz ? fz.font : null), { sameLine: true }));
			}
			if (byNum.get(num).sameLine) out.push(byNum.get(num));
		}
		return out;
	};
	for (const ch of replacement) {
		let target = null, why = font ? "" : "original font dict not found";
		for (const f of [...originals, ...lineFontsFor(ch)]) {
			const r = resolveInOriginal(mupdf, f, ch);
			if (!r.ok) { why = why || r.why; continue; }
			const kind = f === font ? "original" : f.sameLine ? "document-same-line" : "original-sibling";
			target = { kind, pdfFont: f, code: r.code, how: r.how };
			if (f.hasToUnicode && !f.toUnicode.has(r.code)) addOnce(toUnicodeAdds, f, [r.code, ch]);
			if (r.needWidth) addOnce(widthAdds, f, [r.code, r.width]);
			break;
		}
		if (!target) {
			const fb = fallbackFor(mupdf, doc, chain, ch.codePointAt(0));
			if (!fb) { missing.push(ch); continue; }
			target = { kind: "fallback", fb: fb.fb, code: fb.gid, why };
		}
		const last = plan[plan.length - 1];
		if (last && last.kind === target.kind && last.pdfFont === target.pdfFont && last.fb === target.fb) {
			last.text += ch;
			last.codes.push(target.code);
		} else {
			plan.push({ ...target, text: ch, codes: [target.code] });
		}
	}
	t.plan = now() - t0;

	// ---- remove the old word: Redact annotation over shrunk char quads
	// Redaction is a privacy tool: it also deletes link annotations touching the
	// area. An editor must keep them, so snapshot the links and restore any lost.
	t0 = now();
	const linkKey = (l) => JSON.stringify([l.getBounds().map((v) => +v.toFixed(2)), l.getURI()]);
	const linksBefore = page.getLinks().map((l) => ({ key: linkKey(l), bounds: l.getBounds(), uri: l.getURI() }));
	const annot = page.createAnnotation("Redact");
	annot.setQuadPoints(hit.chars.map((ch) => shrinkQuad(ch.quad)));
	page.applyRedactions(false, 0, 0, 0); // no black box, keep images & line art
	const linksAfter = new Set(page.getLinks().map(linkKey));
	let linksRestored = 0;
	for (const l of linksBefore) if (!linksAfter.has(l.key)) { page.createLink(l.bounds, l.uri); linksRestored++; }
	t.redact = now() - t0;

	// ---- write the replacement at the same baseline (user-space glyph matrix)
	t0 = now();
	// Split the glyph matrix into font size (vertical scale), horizontal
	// scaling Tz and a unit Tm, so the editor sees "11 pt, 105 %".
	const m = mupdf.Matrix.concat(g0.m, mupdf.Matrix.invert(page.getTransform()));
	const sx = Math.hypot(m[0], m[1]), size = Math.hypot(m[2], m[3]), th = sx / size;
	const tm = [m[0] / sx, m[1] / sx, m[2] / size, m[3] / size, m[4], m[5]];
	// Letter spacing (Tc) is not in the matrix: estimate it from how far apart
	// the original glyphs sit versus their own advances. Tc is the same for
	// every pair while kerning is not, so only a uniform offset counts.
	const est = [];
	for (let i = 0; i + 1 < orig.length; i++) {
		const a = orig[i], b = orig[i + 1];
		if (!a || !b || a.font !== b.font || isSpace(hit.chars[i].c)) continue;
		const d = ((b.m[4] - a.m[4]) * g0.m[0] + (b.m[5] - a.m[5]) * g0.m[1]) / Math.hypot(g0.m[0], g0.m[1]);
		est.push(d / th - a.font.advanceGlyph(a.gid) * size);
	}
	est.sort((x, y) => x - y);
	const uniform = est.length >= 2 && est[est.length - 1] - est[0] < 0.01 * size;
	const tc = uniform ? est[est.length >> 1] : 0;
	const pObj = page.getObject();
	let ops = "q\nBT\n" + colorOp(g0, first.color) + "\n";
	if (Math.abs(th - 1) > 0.002) ops += `${fmt(th * 100)} Tz\n`;
	if (Math.abs(tc) > 0.02 * size) ops += `${fmt(tc)} Tc\n`;
	if (g0.mode === "invisible") ops += "3 Tr\n";
	if (g0.alpha !== undefined && g0.alpha < 1) {
		const res = resourcesOf(doc, pObj);
		let gs = res.get("ExtGState");
		if (!gs.isDictionary()) gs = res.put("ExtGState", doc.newDictionary());
		gs.put("GSPE", doc.addObject({ Type: "ExtGState", ca: g0.alpha }));
		ops += "/GSPE gs\n";
	}
	ops += tm.map(fmt).join(" ") + " Tm\n";
	let toUnicodeAdded = 0, widthsAdded = 0;
	for (const [f, list] of toUnicodeAdds) toUnicodeAdded += extendToUnicode(doc, f, list);
	for (const [f, list] of widthAdds) widthsAdded += extendWidths(doc, f, list);
	for (const seg of plan) {
		const ref = seg.pdfFont ? seg.pdfFont.ref : seg.fb.ref;
		const bytes = seg.pdfFont ? seg.pdfFont.bytes : 2;
		seg.resName = fontKey(doc, pObj, ref);
		if (seg.fb) for (const c of seg.codes) seg.fb.used.add(c);
		seg.fontName = seg.pdfFont ? seg.pdfFont.baseFont : seg.fb.ref.get("BaseFont").asName();
		seg.hex = seg.codes.map((c) => hexCode(c, bytes));
		ops += `/${seg.resName} ${fmt(size)} Tf <${seg.hex.join("")}> Tj\n`;
	}
	ops += "ET\nQ\n";
	appendContent(doc, pObj, ops);
	t.write = now() - t0;

	return {
		find, replacement, page: pageIndex,
		original: {
			fontName: g0.fontName, pdfFont: font && { key: fontEntry.key, path: fontEntry.path, subtype: font.subtype + (font.isType0 ? "/" + font.cidSubtype : ""), encoding: font.isType0 ? font.encodingName : "simple", embedded: font.embedded, toUnicode: font.hasToUnicode },
			fontDictVerified: `${verifiedGids}/${hit.chars.length} glyph ids reproduced`,
			size: +first.size.toFixed(3), fontSize: +size.toFixed(3), horizontalScale: +(th * 100).toFixed(2), charSpacing: +tc.toFixed(3),
			color: first.color, colorspace: g0.csType, mode: g0.mode,
			origin: first.origin, dir: hit.line.dir, bbox: quadBounds(hit.chars.map((c) => c.quad)),
			gids: Object.fromEntries(hit.chars.map((ch, i) => [ch.c, orig[i] && orig[i].gid])),
		},
		segments: plan.map((s) => ({
			text: s.text, source: s.kind, fontName: s.fontName, resource: s.resName, codes: s.hex.join(" "),
			...(s.why ? { why: s.why } : {}), ...(s.how ? { how: s.how } : {}),
		})),
		missing, toUnicodeAdded, widthsAdded, linksRestored, style, ops, timings: t,
	};
}

// -------------------------------------------------------------- checks

export function docStructure(doc) {
	const countOutline = (items) => (items || []).reduce((n, it) => n + 1 + countOutline(it.down), 0);
	const root = doc.getTrailer().get("Root");
	const fields = root.get("AcroForm", "Fields");
	const widgets = [], links = [];
	const n = doc.countPages();
	for (let i = 0; i < n; i++) {
		const p = doc.loadPage(i);
		for (const w of p.getWidgets()) widgets.push({ page: i, name: w.getName(), type: w.getFieldType(), value: w.getValue() });
		for (const l of p.getLinks()) links.push({ page: i, uri: l.getURI() });
	}
	return {
		pages: n,
		outlineItems: countOutline(doc.loadOutline()),
		acroFormFields: fields.isArray() ? fields.length : 0,
		widgets,
		links,
	};
}

// Re-open the saved bytes and check every edit really happened where expected.
export function verifyEdits(mupdf, origBytes, outBytes, password, edits) {
	const { doc: before } = openPdf(mupdf, origBytes, password);
	const { doc: after, info } = openPdf(mupdf, outBytes, "");
	const result = { reopenedWithoutPassword: !info.needsPassword, edits: [], pixelsChangedOutsideEdits: {} };
	const areasByPage = new Map();
	for (const edit of edits) {
		const pb = before.loadPage(edit.page), pa = after.loadPage(edit.page);
		const linesB = extractLines(pb), linesA = extractLines(pa);
		const textB = pageText(linesB), textA = pageText(linesA);
		const res = { find: edit.find, replacement: edit.replacement };
		res.oldWordGone = countOccurrences(textA, edit.find) === countOccurrences(textB, edit.find) - 1;
		const hit = findInLines(linesA, edit.replacement);
		res.newTextExtracts = !!hit;
		// Neighbour text on the edited line must survive the redaction.
		const lineB = linesB.find((l) => l.text.includes(edit.find));
		if (lineB) {
			const [pre, post] = lineB.text.split(edit.find);
			const words = (pre + " " + post).split(/\s+/).map((w) => w.replace(/[.,;:]$/, "")).filter((w) => w.length > 1);
			const lost = words.filter((w) => !textA.includes(w));
			res.neighboursKept = lost.length === 0;
			if (lost.length) res.lostNeighbours = lost;
		}
		let area = edit.original.bbox;
		if (hit) {
			const c0 = hit.chars[0];
			res.baselineDelta = +Math.hypot(c0.origin[0] - edit.original.origin[0], c0.origin[1] - edit.original.origin[1]).toFixed(4);
			res.sizeDelta = +Math.abs(c0.size - edit.original.size).toFixed(4);
			res.colorSame = c0.color.every((v, i) => Math.abs(v - edit.original.color[i]) < 0.01);
			res.dirSame = Math.abs(hit.line.dir[0] - edit.original.dir[0]) < 1e-3 && Math.abs(hit.line.dir[1] - edit.original.dir[1]) < 1e-3;
			// Each char must come from the font the plan said, and characters drawn
			// with an original font must use the very same glyph id as the same
			// character drawn by that font elsewhere on the saved page (subsetting
			// may renumber glyphs, so compare within the saved file).
			const expect = [];
			for (const s of edit.segments) for (const _ of s.text) expect.push(s);
			const glyphsA = captureGlyphs(mupdf, pa);
			const newGlyphs = new Set(hit.chars.map((ch) => matchGlyph(ch, glyphsA)));
			const gidsElsewhere = new Map();
			for (const g of glyphsA) if (!newGlyphs.has(g)) gidsElsewhere.set(g.fontName + ":" + g.uni, g.gid);
			const origNames = edit.segments.filter((x) => x.source !== "fallback").map((x) => x.fontName).concat(edit.original.fontName);
			let fontOk = 0, gidSame = 0, gidKnown = 0;
			hit.chars.forEach((ch, i) => {
				const s = expect[i];
				if (!s) return;
				// Fallbacks get renamed on reload (Helvetica -> NimbusSans-Regular), so
				// for them it is enough that the glyph is not from an original font.
				if (s.source === "fallback" ? !origNames.some((n) => sameFace(n, ch.fontName)) : sameFace(s.fontName, ch.fontName)) fontOk++;
				if (s.source !== "fallback") {
					const g = matchGlyph(ch, glyphsA);
					const was = gidsElsewhere.get(ch.fontName + ":" + ch.c.codePointAt(0));
					if (was !== undefined) { gidKnown++; if (g && g.gid === was) gidSame++; }
				}
			});
			res.fontsAsPlanned = `${fontOk}/${hit.chars.length}`;
			res.glyphIdsSameAsElsewhere = `${gidSame}/${gidKnown}`;
			const qa = quadBounds(hit.chars.map((c) => c.quad));
			res.newBBox = qa.map((v) => +v.toFixed(2));
			area = [Math.min(qa[0], area[0]), Math.min(qa[1], area[1]), Math.max(qa[2], area[2]), Math.max(qa[3], area[3])];
		}
		if (!areasByPage.has(edit.page)) areasByPage.set(edit.page, []);
		areasByPage.get(edit.page).push([area[0] - 2, area[1] - 2, area[2] + 2, area[3] + 2]);
		result.edits.push(res);
	}
	// Pixel regression: outside the old+new text areas nothing may change.
	for (const [pageIndex, areas] of areasByPage)
		result.pixelsChangedOutsideEdits[pageIndex + 1] = pixelDiffOutside(mupdf, before.loadPage(pageIndex), after.loadPage(pageIndex), areas, 2);
	result.structureBefore = docStructure(before);
	result.structureAfter = docStructure(after);
	before.destroy();
	after.destroy();
	return result;
}

function pixelDiffOutside(mupdf, pb, pa, areas, scale) {
	const a = renderPixmap(mupdf, pb, scale), b = renderPixmap(mupdf, pa, scale);
	const w = a.getWidth(), h = a.getHeight(), x0 = a.getX(), y0 = a.getY();
	const pa_ = a.getPixels(), pb_ = b.getPixels(), stride = a.getStride();
	let changed = 0;
	for (let y = 0; y < h; y++) {
		const py = (y + y0) / scale;
		for (let x = 0; x < w; x++) {
			const px = (x + x0) / scale;
			if (areas.some((r) => px >= r[0] && px <= r[2] && py >= r[1] && py <= r[3])) continue;
			const i = y * stride + x * 4;
			if (Math.abs(pa_[i] - pb_[i]) > 40 || Math.abs(pa_[i + 1] - pb_[i + 1]) > 40 || Math.abs(pa_[i + 2] - pb_[i + 2]) > 40) changed++;
		}
	}
	a.destroy();
	b.destroy();
	return changed;
}
