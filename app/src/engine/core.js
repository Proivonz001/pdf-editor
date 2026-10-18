// MuPDF-only text replacement, shared by the Node runner and the Web Worker.
// Every function takes the mupdf module explicitly so the same code runs in
// both places. Coordinates: "page space" is MuPDF's (y down, rotation and
// CropBox applied, what stext/annotations use); "user space" is raw PDF.
// Release 3 shares the fallback fonts with the form-field writer (forms.ts) and
// new text (newcontent.ts): encodeWithFallbacks, one copy per document.

import { AGL, MacRomanEncoding, StandardEncoding, WinAnsiEncoding } from "./tables.js";

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
// decrypt: write without encryption. App change: this uses "encrypt=none"
// instead of the prototype's "decrypt=yes" (same result on 1.27, and
// "decrypt" is deprecated from MuPDF 1.28).
// Note: subsetting swaps the fallback fonts of `doc` for subsets, so later
// edits that need more glyphs of them would break; the app saves a scratch
// copy of the document, never the one being edited (see session.ts).
export function savePdf(mupdf, doc, { garbage = "compact", decrypt = true, subset = "fallback" } = {}) {
	if (subset === "all") doc.subsetFonts();
	else if (subset === "fallback") subsetFallbackFonts(mupdf, doc);
	const opts = `garbage=${garbage},compress=yes${decrypt ? ",encrypt=none" : ""}`;
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
			let glyphOrigin = origin;
			if (cur.wmode === 1) {
				// MuPDF 1.27 starts a vertical character's quad at the glyph origin
				// (pen - v) instead of the pen, so the quad sits v.y = 0.88 em (the
				// DW2 default) too far down the column and covers half of the next
				// glyph (pdfium's boxes agree with the ink, not with MuPDF). Move it
				// back; the glyph origin is the corner where the raw quad started.
				glyphOrigin = [quad[6], quad[7]];
				const s = 0.88 * size;
				quad = quad.map((v, i) => v - s * cur.dir[i % 2]);
			}
			cur.chars.push({
				c, origin, glyphOrigin, quad, size, color, font, wmode: cur.wmode,
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
	return joinVerticalLines(lines);
}

// App addition (rule 5): the stext walker and captureGlyphs create one Font
// wrapper per character. Release them, and the page, once they are used.
export function releasePage(page, lines = [], glyphs = []) {
	for (const l of lines) for (const ch of l.chars) ch.font.destroy();
	for (const g of glyphs) g.font.destroy();
	page.destroy();
}

// Where a character's glyph is drawn (the glyph matrix origin): the stext
// origin for horizontal text; for vertical text (wmode 1) MuPDF puts the stext
// origin one advance further down, see extractLines.
const glyphStart = (ch) => ch.glyphOrigin;

// MuPDF 1.27 gives every character of vertical text a line of its own. Join
// consecutive ones that continue each other down the same column.
function joinVerticalLines(lines) {
	const out = [];
	for (const l of lines) {
		const prev = out[out.length - 1];
		const a = prev && prev.chars[prev.chars.length - 1], b = l.chars[0];
		if (a && b && l.wmode === 1 && prev.wmode === 1 && l.dir[0] === prev.dir[0] && l.dir[1] === prev.dir[1]) {
			const [bx, by] = glyphStart(b);
			const dx = bx - a.origin[0], dy = by - a.origin[1];
			const along = dx * l.dir[0] + dy * l.dir[1], across = Math.abs(dx * l.dir[1] - dy * l.dir[0]);
			if (across < 0.1 * a.size && along > -0.1 * a.size && along < 0.6 * a.size) {
				prev.chars.push(...l.chars);
				prev.text += l.text;
				prev.bbox = [Math.min(prev.bbox[0], l.bbox[0]), Math.min(prev.bbox[1], l.bbox[1]),
					Math.max(prev.bbox[2], l.bbox[2]), Math.max(prev.bbox[3], l.bbox[3])];
				continue;
			}
		}
		out.push(l);
	}
	return out;
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
	const [ox, oy] = glyphStart(ch);
	let best = null, bestD = ch.wmode === 1 ? 0.25 : 0.1; // vertical quads are rounded more
	for (const g of glyphs) {
		if (g.uni !== cp) continue;
		const d = Math.hypot(g.m[4] - ox, g.m[5] - oy);
		if (d < bestD || (d === bestD && g.mode === "fill")) { best = g; bestD = d; }
	}
	return best;
}

// ------------------------------------------------- 3. PDF font dictionaries

// MuPDF keeps font names in a 32-byte buffer, so long BaseFonts get truncated.
const nameMatches = (baseFont, fzName) =>
	baseFont === fzName || (fzName.length >= 31 && baseFont.startsWith(fzName));
// The names MuPDF may report for a font dict: /BaseFont, or for Type3 /Name
// (MuPDF names a Type3 font without /Name "Unnamed-T3").
function dictNames(ref) {
	const base = ref.get("BaseFont").asName() || "";
	if (ref.get("Subtype").asName() !== "Type3") return [base];
	return [ref.get("Name").asName() || "Unnamed-T3", base].filter(Boolean);
}
const dictMatches = (ref, fzName) => dictNames(ref).some((n) => nameMatches(n, fzName));
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
	for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
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
	else if (symbolic || subtype === "Type3") table = new Array(256).fill(0); // built-in/none: only ToUnicode or Differences tell
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
		this.baseFont = dictNames(ref)[0];
		this.isType0 = this.subtype === "Type0";
		this.supported = true;
		this.identityGid = false;
		this.vertical = false;
		if (this.isType0) {
			const enc = ref.get("Encoding");
			this.encodingName = enc.isName() ? enc.asName() : "(embedded CMap)";
			// Identity-H/V: code = CID. Unicode CMaps (UniGB-UCS2-H, UniJIS-UTF16-V,
			// ...): code = the UTF-16 unit, whatever font the viewer substitutes.
			// Other CMaps (Shift-JIS, GBK, ...) are not handled and fall back.
			this.identity = /^Identity-[HV]$/.test(this.encodingName);
			this.unicodeCMap = /^Uni(GB|CNS|JIS|KS)-(UCS2|UTF16)-[HV]$/.test(this.encodingName);
			this.supported = this.identity || this.unicodeCMap;
			this.vertical = /-V$/.test(this.encodingName);
			const desc = ref.get("DescendantFonts", 0);
			this.cidSubtype = desc.get("Subtype").asName();
			this.ordering = desc.get("CIDSystemInfo", "Ordering").asString();
			const c2g = desc.get("CIDToGIDMap");
			this.identityGid = this.cidSubtype === "CIDFontType2" && (c2g.isNull() || (c2g.isName() && c2g.asName() === "Identity"));
			this.bytes = 2;
			this.embedded = ["FontFile", "FontFile2", "FontFile3"].some((k) => !desc.get("FontDescriptor", k).isNull());
		} else {
			// Simple fonts, Type3 included: a Type3 glyph is a content procedure
			// the probe can draw like any other glyph.
			this.bytes = 1;
			this.encoding = simpleEncoding(ref, this.subtype);
			this.embedded = ["FontFile", "FontFile2", "FontFile3"].some((k) => !ref.get("FontDescriptor", k).isNull());
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
		} else if (this.unicodeCMap) {
			if (cp <= 0xffff) push(cp, "Unicode CMap");
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
		// A vertical font is probed through its horizontal twin (same CMap with
		// -H): same glyphs and widths, and the probe layout stays horizontal.
		if (font.vertical) f.put("Encoding", scratch.newName(font.encodingName.replace(/-V$/, "-H")));
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
		// The page and every glyph's Font wrapper hold the scratch document (and
		// its copy of the font program) alive until JS GC: release them now.
		for (const g of glyphs) g.font.destroy();
		page.destroy();
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
		// A non-embedded font is drawn with whatever the viewer substitutes,
		// scaled to the PDF widths, so only embedded programs are compared.
		let needWidth = false;
		const off = Math.abs(p.pdfAdvance - p.glyphAdvance);
		if (c.how !== "ToUnicode" && (font.embedded || !font.isType0) && p.glyphAdvance > 0 && off > 0.01 + 0.02 * p.glyphAdvance) {
			if (font.isType0 && !font.identity) { why = "no width for this code in /W"; continue; } // /W is by CID, not code
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
	const mono = ch.mono || /mono|courier|consola|code|typewriter/i.test(n);
	// MuPDF only knows serif from sans for TrueType/OpenType (OS/2 class): bare
	// CFF and Type1 programs always report serif, so a sans name wins.
	const sans = /sans|gothic|grotesk|arial|helvetica|verdana|tahoma|calibri|segoe|frutiger|univers|futura|myriad/i.test(n);
	const serif = !mono && !sans && (ch.serif || /times|georgia|cambria|garamond|serif|roman|book|minion|palatino/i.test(n));
	const bold = ch.bold || /bold|black|heavy|semibold/i.test(n);
	const italic = ch.italic || /italic|oblique/i.test(n);
	return { family: mono ? "mono" : serif ? "serif" : "sans", bold, italic };
}

const fallbackCache = new WeakMap(); // PDFDocument -> Map(name -> {font, ref})

// Built-in Base-14 (Nimbus) matching the original's style, then any extra
// font the caller bundles (e.g. Noto Sans), then ZapfDingbats, then MuPDF's
// built-in CJK font for the original's CID ordering (or the script of the text).
// Exported for the forms writer and new text (release 3), with fallbackFor.
// Release 3 change: ZapfDingbats (URW's Dingbats, embedded like the Nimbus
// faces) comes before the CJK font, for ✓ ✗ ✔ ✘ and the other dingbats: Droid
// Sans Fallback lacks ✗ (U+2717), ✔ and ✘, so a line edit lost them. It only
// changes characters Nimbus lacks and Dingbats has (① ● ★ ✓ ❶ ➔ ...), which came
// from the CJK font before or could not be drawn at all.
export function fallbackChain(mupdf, style, extraFonts = [], cjk = "zh-Hans") {
	const names = [BASE14[style.family][(style.bold ? 1 : 0) + (style.italic ? 2 : 0)]];
	return [...names.map((n) => ({ name: n, make: () => new mupdf.Font(n) })),
		...extraFonts.map((f) => ({ name: f.name, make: () => new mupdf.Font(f.name, f.bytes) })),
		{ name: "ZapfDingbats", make: () => new mupdf.Font("ZapfDingbats") },
		{ name: `CJK (${cjk})`, make: () => new mupdf.Font(cjk) }];
}

const CJK_BY_ORDERING = { GB1: "zh-Hans", CNS1: "zh-Hant", Japan1: "ja", Korea1: "ko" };
// The CJK language of the fallback: the original font's CID ordering, else the
// script of the text (kana: Japanese, hangul: Korean, anything else: Chinese).
export function cjkLanguage(font, text) {
	if (font && CJK_BY_ORDERING[font.ordering]) return CJK_BY_ORDERING[font.ordering];
	if (/[\u3040-\u30ff]/.test(text)) return "ja"; // kana
	if (/[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/.test(text)) return "ko"; // hangul
	return "zh-Hans";
}

// The same Type0 font addressed vertically: a copy of the dict with
// /Identity-V (default vertical metrics: advance 1 em down, glyph centred).
function verticalTwin(doc, ref) {
	const d = doc.newDictionary();
	for (const [k, v] of dictEntries(ref)) {
		if (v.isArray() && !v.isIndirect()) {
			const a = doc.newArray();
			v.forEach((x) => a.push(x));
			d.put(k, a);
		} else d.put(k, v);
	}
	d.put("Encoding", doc.newName("Identity-V"));
	return doc.addObject(d);
}

// Vertical metrics of a CID: v = (vx, vy) from /W2, else (w0/2, DW2[0]); w0
// from /W or /DW. cid < 0 (code -> CID unknown) gives the defaults.
function verticalMetrics(font, cid) {
	let w0 = 1000, vy = 880;
	if (font && font.isType0) {
		const desc = font.ref.get("DescendantFonts", 0);
		if (desc.get("DW").isNumber()) w0 = desc.get("DW").asNumber();
		if (desc.get("DW2").isArray()) vy = desc.get("DW2").get(0).asNumber();
		if (cid >= 0) {
			const w = cidLookup(desc.get("W"), cid, 1);
			if (w) w0 = w[0];
			const v = cidLookup(desc.get("W2"), cid, 3);
			if (v) return { vx: v[1], vy: v[2] };
		}
	}
	return { vx: w0 / 2, vy };
}

// /W and /W2: "c [n values per CID ...]" lists or "c1 c2 values" ranges.
function cidLookup(arr, cid, n) {
	if (!arr.isArray()) return null;
	const num = (o) => o.asNumber();
	for (let i = 0; i + 1 < arr.length;) {
		const c1 = num(arr.get(i)), next = arr.get(i + 1);
		if (next.isArray()) {
			const k = (cid - c1) * n;
			if (cid >= c1 && k + n <= next.length) return Array.from({ length: n }, (_, j) => num(next.get(k + j)));
			i += 2;
		} else {
			if (cid >= c1 && cid <= num(next)) return Array.from({ length: n }, (_, j) => num(arr.get(i + 2 + j)));
			i += 2 + n;
		}
	}
	return null;
}

// App addition: the fallback font (or its Identity-V twin) that `ref` points to, if any.
function fallbackOwning(doc, ref) {
	const cache = fallbackCache.get(doc);
	if (!cache || !ref || !ref.isIndirect()) return null;
	const num = ref.asIndirect();
	for (const fb of cache.values()) {
		if (fb.ref && fb.ref.asIndirect() === num) return fb;
		if (fb.refV && fb.refV.asIndirect() === num) return fb;
	}
	return null;
}

// The first font of `chain` that has the code point `cp`, embedded in `doc` on
// first use (one copy per document, shared by every edit), and its glyph id:
// { fb, gid }, or null when no font has it. The caller adds the gid to
// fb.used when it writes it: what saving keeps in the subset when it cannot
// read what the document draws (subsetFallbackFonts).
export function fallbackFor(mupdf, doc, chain, cp) {
	let cache = fallbackCache.get(doc);
	if (!cache) fallbackCache.set(doc, (cache = new Map()));
	for (const entry of chain) {
		let fb = cache.get(entry.name);
		if (!fb) {
			const font = entry.make();
			// App change: `make` is kept so restoreFallbackFonts can load the font again.
			fb = { font, ref: null, name: entry.name, make: entry.make, used: new Set() };
			cache.set(entry.name, fb);
		}
		const gid = fb.font.encodeCharacter(cp);
		if (gid > 0) {
			// Type0 / Identity-H + ToUnicode. App change: CIDToGIDMap written (identityCidToGid).
			if (!fb.ref) fb.ref = identityCidToGid(doc.addFont(fb.font));
			else if (fb.subset && !fb.subset.has(gid)) {
				// App addition (release 3): this document's copy was subset for a save
				// (subsetFallbackFonts) and lacks the glyph, as when the PDF/A conversion
				// draws a form field's appearance afterwards. A whole copy takes over for
				// what is written from now on; what the subset draws keeps drawing it, and
				// a second subsetFallbackFonts shrinks the new copy.
				fb.ref = identityCidToGid(doc.addFont(fb.font));
				fb.refV = null;
				fb.subset = null;
				fb.used = new Set();
			}
			return { fb, gid };
		}
	}
	return null;
}

// App addition (release 3): the advance of each glyph of a fallback font as
// viewers draw it, from its /W (code = CID = glyph id), per mille of the size.
// MuPDF writes /W truncated to whole units, so it can differ from the
// program's own advance by up to 1/1000 em (Droid Sans Fallback). Read once per
// font object, then kept with the font's bookkeeping.
function fallbackWidths(fb) {
	const num = fb.ref.asIndirect();
	if (fb.widths && fb.widths.num === num) return fb.widths;
	const desc = fb.ref.get("DescendantFonts", 0);
	const dw = desc.get("DW").isNumber() ? desc.get("DW").asNumber() : 1000;
	const map = new Map();
	const w = desc.get("W");
	for (let i = 0, n = w.isArray() ? w.length : 0; i + 1 < n;) {
		const c1 = w.get(i).asNumber(), next = w.get(i + 1);
		if (next.isArray()) {
			for (let k = 0; k < next.length; k++) map.set(c1 + k, next.get(k).asNumber());
			i += 2;
		} else {
			const c2 = next.asNumber(), width = w.get(i + 2).asNumber();
			for (let c = c1; c <= c2; c++) map.set(c, width);
			i += 3;
		}
	}
	fb.widths = { num, map, dw };
	return fb.widths;
}

/**
 * App addition (release 3): `text` (one line) shaped with the app's fallback
 * fonts alone, for writing it where no original font applies: a form field's
 * appearance (forms.ts) and new text on a page (newcontent.ts). The fonts are
 * the ones replaceText falls back to (fallbackChain: the Nimbus face of
 * `style`, ZapfDingbats, the CJK font for the script of the text), embedded
 * once per document and shared with line edits; the glyphs are marked used
 * (saving keeps in the subset those the document still draws, annotation
 * appearances included: subsetFallbackFonts). Characters no font has, and any above U+FFFF (MuPDF.js
 * 1.27 reads them back truncated), are left out and listed once in `missing`.
 *
 * Each run is consecutive characters drawn by one font: `font` is its indirect
 * Type0 font dictionary (Identity-H: put it in the resources the text is drawn
 * with, e.g. fontKey(doc, streamOrPageObj, font)), `key` the fallback font's
 * name in the document's cache ("Helvetica", "ZapfDingbats", "CJK (zh-Hans)"):
 * the same key, the same font; `hex` the operand of Tj without < >; `width`
 * the advance at size 1 (sum of the /W widths, what viewers draw with).
 *
 * @param {typeof import("mupdf")} mupdf
 * @param {import("mupdf").PDFDocument} doc
 * @param {string} text
 * @param {{ family: "sans" | "serif" | "mono"; bold: boolean; italic: boolean }} style
 * @returns {{ runs: { font: import("mupdf").PDFObject; key: string; hex: string; width: number; text: string }[]; missing: string[] }}
 */
export function encodeWithFallbacks(mupdf, doc, text, style) {
	if (!BASE14[style.family]) throw new Error(`unknown font family ${String(style.family)}`);
	const chain = fallbackChain(mupdf, { family: style.family, bold: !!style.bold, italic: !!style.italic }, [], cjkLanguage(null, text));
	const runs = [], missing = [];
	let last = null;
	for (const ch of text) {
		const cp = ch.codePointAt(0);
		const found = cp > 0xffff ? null : fallbackFor(mupdf, doc, chain, cp);
		if (!found) {
			if (!missing.includes(ch)) missing.push(ch);
			continue;
		}
		const { fb, gid } = found;
		fb.used.add(gid);
		const widths = fallbackWidths(fb);
		const width = (widths.map.has(gid) ? widths.map.get(gid) : widths.dw) / 1000;
		// A new run when the font object changes (also the same font after a whole copy took over).
		if (last && last.font.asIndirect() === fb.ref.asIndirect()) {
			last.hex += hexCode(gid, 2);
			last.width += width;
			last.text += ch;
		} else {
			last = { font: fb.ref, key: fb.name, hex: hexCode(gid, 2), width, text: ch };
			runs.push(last);
		}
	}
	return { runs, missing };
}

// App addition: addFont() writes a TrueType program (the CJK fallback) as a
// CIDFontType2 without /CIDToGIDMap. Identity is the default, and the mapping
// MuPDF draws with, but PDF/A-2 (6.2.11.3.2) wants it written: it is, so every
// download carries it. Returns `ref`.
function identityCidToGid(ref) {
	const d = ref.get("DescendantFonts", 0);
	if (d.isDictionary() && d.get("Subtype").isName() && d.get("Subtype").asName() === "CIDFontType2" && d.get("CIDToGIDMap").isNull())
		d.put("CIDToGIDMap", "Identity");
	return ref;
}

// App addition: destroys the fallback Font objects cached for `doc`. Call it
// before destroying the document; otherwise they live until the JS garbage
// collector runs (ARCHITECTURE.md rule 5).
export function releaseFallbackFonts(doc) {
	const cache = fallbackCache.get(doc);
	if (!cache) return;
	for (const fb of cache.values()) fb.font.destroy();
	fallbackCache.delete(doc);
}

// App addition: the fallback fonts embedded in `doc`, by object number, so the
// bookkeeping outlives `doc`. Saved without garbage collection, a document keeps
// its object numbers: restoreFallbackFonts gives a document opened from those
// bytes the same bookkeeping, so its later edits reuse the fonts already
// embedded and subsetFallbackFonts shrinks them to the glyphs drawn with them.
export function fallbackFontState(doc) {
	const cache = fallbackCache.get(doc);
	if (!cache) return [];
	return [...cache.values()].filter((fb) => fb.ref).map((fb) => ({
		name: fb.name, make: fb.make, used: [...fb.used],
		ref: fb.ref.asIndirect(), refV: fb.refV ? fb.refV.asIndirect() : 0,
	}));
}

export function restoreFallbackFonts(doc, state) {
	releaseFallbackFonts(doc);
	if (!state.length) return;
	const cache = new Map();
	for (const s of state) {
		const fb = { font: s.make(), ref: doc.newIndirect(s.ref), name: s.name, make: s.make, used: new Set(s.used) };
		if (s.refV) fb.refV = doc.newIndirect(s.refV);
		cache.set(s.name, fb);
	}
	fallbackCache.set(doc, cache);
}

// A fallback font is embedded whole by addFont() (Nimbus ~30-60 KB, the CJK
// font ~1.7 MB). Subset it in a scratch document that uses exactly the glyphs
// the document draws with it, then point the pages at the grafted subset.
// Original fonts are never touched. Codes stay valid: for Identity-H CID fonts
// MuPDF's subsetter keeps glyph ids (unused glyphs are emptied, not renumbered).
// App change (release 3): annotation appearances are pointed at the subset
// too (form fields filled with a fallback font, encodeWithFallbacks).
// App change (release 4): the glyphs are those the document still draws with
// the font (fallbackUse: its pages' content and annotation appearances, as
// they are now), not every glyph ever written with it (fb.used), which would
// keep in a download the outlines of text the user wrote on a page deleted
// since, on a page an extract leaves out, or in a line deleted or rewritten
// since: a subset's glyphs tell which characters were written. A font already
// subset is left as it is while it still draws the same glyphs, and subset
// again from its whole program when they changed (the PDF/A conversion may
// remove or redraw what drew with it); a whole copy fallbackFor added since is
// subset too (see there). When the document cannot be read that way, fb.used
// decides, as before. A font nothing draws with any more but a page or an
// appearance still lists is subset to its .notdef glyph alone.
export function subsetFallbackFonts(mupdf, doc) {
	const cache = fallbackCache.get(doc);
	if (!cache) return 0;
	let use = null;
	try {
		use = fallbackUse(doc, cache);
	} catch {
		use = null; // (a document MuPDF reads but this reader cannot: every glyph written, as before)
	}
	const swap = new Map(); // object number of a font (or its vertical twin) -> its subset
	let n = 0;
	for (const fb of cache.values()) {
		if (!fb.ref) continue;
		const glyphs = use ? use.glyphs.get(fb) : fb.used;
		// Left as it is: a subset of just these glyphs already, or a font nothing draws with and
		// nothing lists (garbage collection drops it); without `use`, as before release 4.
		const done = use
			? fb.subset ? sameGlyphs(fb.subset, glyphs) : !glyphs.size && !use.listed.has(fb)
			: !glyphs.size || fb.subset;
		if (done) continue;
		const scratch = new mupdf.PDFDocument();
		try {
			const ref = scratch.addFont(fb.font);
			const hex = glyphs.size ? [...glyphs].sort((a, b) => a - b).map((g) => hexCode(g, 2)).join("") : "0000";
			scratch.insertPage(-1, scratch.addPage([0, 0, 100, 100], 0, { Font: { F: ref } }, `BT /F 10 Tf <${hex}> Tj ET`));
			scratch.subsetFonts();
			const small = identityCidToGid(doc.graftObject(ref)); // App change: see identityCidToGid
			const smallV = fb.refV ? verticalTwin(doc, small) : null;
			swap.set(fb.ref.asIndirect(), small);
			if (fb.refV) swap.set(fb.refV.asIndirect(), smallV);
			fb.ref = small;
			fb.refV = smallV;
			fb.subset = new Set(glyphs); // the glyphs the subset has
			n++;
		} finally {
			scratch.destroy();
		}
	}
	if (!n) return 0;
	const swapIn = (fonts) => {
		for (const [k, v] of dictEntries(fonts)) if (v.isIndirect() && swap.has(v.asIndirect())) fonts.put(k, swap.get(v.asIndirect()));
	};
	const seen = new Set(); // appearance streams and their forms, each once
	for (let i = 0; i < doc.countPages(); i++) {
		const pageObj = doc.findPage(i);
		swapIn(pageObj.get("Resources", "Font"));
		const annots = pageObj.get("Annots");
		if (annots.isArray()) annots.forEach((annot) => swapInAppearance(annot, swapIn, seen));
	}
	// ...and every other /Font dictionary or ExtGState /Font the reader found one in (a form's).
	if (use) {
		for (const fonts of use.fontDicts) swapIn(fonts);
		for (const pair of use.stateFonts) {
			const v = pair.get(0);
			if (v.isIndirect() && swap.has(v.asIndirect())) pair.put(0, swap.get(v.asIndirect()));
		}
	}
	return n;
}

const sameGlyphs = (a, b) => a.size === b.size && [...a].every((g) => b.has(g));

// App addition (release 4): what the fallback fonts of `cache` draw in `doc` now,
// for subsetFallbackFonts: `glyphs`, each font's glyph ids (Identity-H/V: a
// code is a glyph id) shown by the text operators (Tj ' " TJ) of every page's
// content and every annotation's appearances (/N, /D, /R), through the forms
// they draw (Do), the tiling patterns and Type3 glyphs of the resources they
// draw with, the font chosen by Tf (or an ExtGState's /Font) and kept by q/Q,
// a form starting with its caller's font; `listed`, the fonts some /Font
// dictionary or ExtGState of those holds; `fontDicts` and `stateFonts`, those
// dictionaries and ExtGState /Font arrays, to point at the subsets. Content
// whose resources can reach no fallback font is not read. Throws when the
// document cannot be read so (the caller then keeps every glyph written).
function fallbackUse(doc, cache) {
	const byNum = new Map(); // object number of a fallback font or its vertical twin -> its bookkeeping
	for (const fb of cache.values()) {
		if (!fb.ref) continue;
		byNum.set(fb.ref.asIndirect(), fb);
		if (fb.refV) byNum.set(fb.refV.asIndirect(), fb);
	}
	const glyphs = new Map([...cache.values()].map((fb) => [fb, new Set()]));
	const listed = new Set(), fontDicts = [], stateFonts = [];
	const fallbackAt = (ref) => (ref && ref.isIndirect() ? byNum.get(ref.asIndirect()) || null : null);
	const dictOf = (o, key) => {
		if (!o || !o.isDictionary()) return null;
		const v = o.get(key);
		return v.isDictionary() ? v : null;
	};
	const named = (res, kind, name) => {
		const d = dictOf(res, kind);
		return d && typeof name === "string" ? d.get(name) : null;
	};
	const isForm = (x) => x && x.isStream() && x.get("Subtype").isName() && x.get("Subtype").asName() === "Form";
	const isTiling = (p) => p && p.isStream() && p.get("PatternType").isNumber() && p.get("PatternType").asNumber() === 1;
	const isType3 = (f) => f && f.isDictionary() && f.get("Subtype").isName() && f.get("Subtype").asName() === "Type3";

	// Whether anything drawn with `res` can draw with a fallback font (by object number, once).
	const reach = new Map();
	const canDraw = (res, depth = 0) => {
		if (!res || !res.isDictionary() || depth > 32) return false;
		const key = res.isIndirect() ? res.asIndirect() : 0;
		if (key && reach.has(key)) return reach.get(key);
		if (key) reach.set(key, false); // (a loop draws nothing more)
		let found = false, holds = false;
		const fonts = dictOf(res, "Font");
		for (const [, f] of dictEntries(fonts)) {
			const fb = fallbackAt(f);
			if (fb) {
				listed.add(fb);
				found = holds = true;
			} else if (isType3(f) && canDraw(dictOf(f, "Resources"), depth + 1)) found = true;
		}
		if (holds) fontDicts.push(fonts); // (a direct one may come twice: swapping it twice changes nothing)
		for (const [, gs] of dictEntries(dictOf(res, "ExtGState"))) {
			const pair = gs.isDictionary() ? gs.get("Font") : null;
			const fb = pair && pair.isArray() && pair.length ? fallbackAt(pair.get(0)) : null;
			if (!fb) continue;
			listed.add(fb);
			stateFonts.push(pair);
			found = true;
		}
		for (const [, x] of dictEntries(dictOf(res, "XObject"))) if (isForm(x) && canDraw(dictOf(x, "Resources"), depth + 1)) found = true;
		for (const [, p] of dictEntries(dictOf(res, "Pattern"))) if (isTiling(p) && canDraw(dictOf(p, "Resources"), depth + 1)) found = true;
		if (key) reach.set(key, found);
		return found;
	};

	const visited = new Set(); // forms (with the font they start with), patterns and glyph procedures read
	const show = (fb, s) => {
		if (!fb || !(s instanceof Uint8Array)) return;
		const set = glyphs.get(fb);
		for (let k = 0; k + 1 < s.length; k += 2) set.add((s[k] << 8) | s[k + 1]);
	};
	const read = (bytes, res, start, depth) => {
		if (depth > 32 || (!start && !canDraw(res))) return;
		let font = start;
		const saved = [];
		readOps(bytes, (op, args) => {
			const last = args[args.length - 1];
			switch (op) {
				case "q": saved.push(font); break;
				case "Q": if (saved.length) font = saved.pop(); break;
				case "Tf": {
					const name = args[args.length - 2];
					font = name && typeof name === "object" && "name" in name ? fallbackAt(named(res, "Font", name.name)) : null;
					break;
				}
				case "gs": {
					const gs = last && last.name !== undefined ? named(res, "ExtGState", last.name) : null;
					const pair = gs && gs.isDictionary() ? gs.get("Font") : null;
					if (pair && pair.isArray() && pair.length) font = fallbackAt(pair.get(0));
					break;
				}
				case "Tj": case "'": case "\"": show(font, last); break;
				case "TJ": if (Array.isArray(last)) for (const x of last) show(font, x); break;
				case "Do": {
					const x = last && last.name !== undefined ? named(res, "XObject", last.name) : null;
					if (isForm(x)) form(x, res, font, depth + 1);
					break;
				}
			}
		});
		// What these resources draw elsewhere: tiling patterns, and the glyphs of Type3 fonts.
		for (const [, p] of dictEntries(dictOf(res, "Pattern"))) if (isTiling(p)) form(p, res, null, depth + 1);
		for (const [, f] of dictEntries(dictOf(res, "Font"))) {
			if (!isType3(f)) continue;
			const own = dictOf(f, "Resources") || res;
			for (const [, proc] of dictEntries(dictOf(f, "CharProcs"))) {
				if (!proc.isStream() || visited.has(`p${proc.asIndirect()}`)) continue;
				visited.add(`p${proc.asIndirect()}`);
				read(streamBytes(proc), own, null, depth + 1);
			}
		}
	};
	const form = (x, parent, font, depth) => {
		const key = `${x.asIndirect()} ${font ? font.name : ""}`;
		if (visited.has(key)) return;
		visited.add(key);
		read(streamBytes(x), dictOf(x, "Resources") || parent, font, depth);
	};

	for (let i = 0; i < doc.countPages(); i++) {
		const pageObj = doc.findPage(i);
		const res = pageObj.getInheritable("Resources");
		const contents = pageObj.get("Contents");
		const parts = [];
		if (contents.isArray()) contents.forEach((c) => { if (c.isStream()) parts.push(streamBytes(c)); });
		else if (contents.isStream()) parts.push(streamBytes(contents));
		if (parts.length && canDraw(res)) read(joinBytes(parts), res, null, 0);
		const annots = pageObj.get("Annots");
		if (!annots.isArray()) continue;
		annots.forEach((annot) => {
			const ap = dictOf(annot, "AP");
			for (const key of ["N", "D", "R"]) {
				const v = ap ? ap.get(key) : null;
				if (!v) continue;
				if (v.isStream()) form(v, res, null, 1);
				else if (v.isDictionary()) for (const [, state] of dictEntries(v)) if (state.isStream()) form(state, res, null, 1);
			}
		});
	}
	return { glyphs, listed, fontDicts, stateFonts };
}

// A stream's decoded bytes, copied out of the wasm heap (MuPDF calls made while
// they are read may move it).
function streamBytes(stm) {
	const buf = stm.readStream();
	try {
		return buf.asUint8Array().slice();
	} finally {
		buf.destroy();
	}
}

// Content streams one after the other, as MuPDF reads a page's /Contents array.
function joinBytes(parts) {
	if (parts.length === 1) return parts[0];
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length + 1, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		out[at + p.length] = 10;
		at += p.length + 1;
	}
	return out;
}

// App addition (release 4): a small content-stream reader for fallbackUse:
// calls onOp(op, operands) for each operator, the operands numbers, names
// ({ name }, #xx decoded), strings (their bytes, a Uint8Array), null for other
// values, and arrays of those; dictionaries (a BDC's property list) are read
// past and an inline image's data jumped over (up to EI between white space).
// Not a full PDF parser.
function readOps(s, onOp) {
	const n = s.length;
	let i = 0, args = [], dict = 0;
	const arrays = [];
	const push = (v) => {
		if (!dict) (arrays.length ? arrays[arrays.length - 1] : args).push(v);
	};
	while (i < n) {
		const c = s[i];
		if (CLASS[c] === 1) { i++; continue; }
		if (c === 37) { while (i < n && s[i] !== 10 && s[i] !== 13) i++; continue; } // %comment
		if (c === 40) { // (literal string)
			const out = [];
			let depth = 1;
			for (i++; i < n;) {
				const x = s[i++];
				if (x === 92) { // backslash
					const y = s[i++];
					if (y >= 48 && y <= 55) {
						let v = y - 48;
						for (let d = 0; d < 2 && i < n && s[i] >= 48 && s[i] <= 55; d++) v = v * 8 + (s[i++] - 48);
						out.push(v & 255);
					} else if (y === 110) out.push(10);
					else if (y === 114) out.push(13);
					else if (y === 116) out.push(9);
					else if (y === 98) out.push(8);
					else if (y === 102) out.push(12);
					else if (y === 13) { if (s[i] === 10) i++; } // a line continued
					else if (y !== 10 && y !== undefined) out.push(y);
					continue;
				}
				if (x === 40) depth++;
				else if (x === 41 && --depth === 0) break;
				out.push(x);
			}
			push(Uint8Array.from(out));
			continue;
		}
		if (c === 60) {
			if (s[i + 1] === 60) { dict++; i += 2; continue; } // << dictionary
			const out = []; // <hex string>
			let hi = -1;
			for (i++; i < n && s[i] !== 62; i++) {
				const v = HEX[s[i]];
				if (v < 0) continue;
				if (hi < 0) hi = v;
				else { out.push(hi * 16 + v); hi = -1; }
			}
			if (hi >= 0) out.push(hi * 16);
			i++;
			push(Uint8Array.from(out));
			continue;
		}
		if (c === 62) {
			if (s[i + 1] === 62) { i += 2; if (dict && --dict === 0) push(null); } else i++;
			continue;
		}
		if (c === 91) { i++; if (!dict) arrays.push([]); continue; }
		if (c === 93) { i++; if (!dict && arrays.length) push(arrays.pop()); continue; }
		if (c === 47) { // /name
			let j = i + 1;
			while (j < n && !CLASS[s[j]]) j++;
			push({ name: nameText(s, i + 1, j) });
			i = j;
			continue;
		}
		if (CLASS[c] === 2) { i++; continue; } // a stray ) { }
		let j = i;
		while (j < n && !CLASS[s[j]]) j++;
		const word = j - i > 32 ? "" : String.fromCharCode(...s.subarray(i, j));
		i = j;
		if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) { push(Number(word)); continue; }
		if (dict) continue;
		if (word === "true" || word === "false" || word === "null" || !word) { push(null); continue; }
		if (word === "ID") { // inline image data: binary, up to EI between white space
			let k = i + 1;
			while (k + 1 < n && !(s[k] === 69 && s[k + 1] === 73 && CLASS[s[k - 1]] === 1 && (k + 2 >= n || CLASS[s[k + 2]] === 1))) k++;
			i = k + 2;
			args = [];
			arrays.length = 0;
			continue;
		}
		arrays.length = 0; // an operator ends any array left open
		onOp(word, args);
		args = [];
	}
}

// A name's characters (from just after its slash), its #xx escapes decoded.
function nameText(s, from, to) {
	let out = "";
	for (let i = from; i < to; i++) {
		if (s[i] === 35 && i + 2 < to && HEX[s[i + 1]] >= 0 && HEX[s[i + 2]] >= 0) {
			out += String.fromCharCode(HEX[s[i + 1]] * 16 + HEX[s[i + 2]]);
			i += 2;
		} else out += String.fromCharCode(s[i]);
	}
	return out;
}

// App addition (release 3): calls swapIn on the /Font dictionaries an
// annotation's appearance draws with: /AP /N, /D and /R, each a stream or a
// dictionary of state streams (check boxes, radio buttons), and the forms
// those draw (with a loop guard).
function swapInAppearance(annot, swapIn, seen) {
	const ap = annot.isDictionary() ? annot.get("AP") : null;
	if (!ap || !ap.isDictionary()) return;
	const visit = (xobj) => {
		if (!xobj.isStream()) return;
		if (xobj.isIndirect()) {
			if (seen.has(xobj.asIndirect())) return;
			seen.add(xobj.asIndirect());
		}
		const res = xobj.get("Resources");
		if (!res.isDictionary()) return;
		swapIn(res.get("Font"));
		for (const [, x] of dictEntries(res.get("XObject"))) if (x.get("Subtype").asName() === "Form") visit(x);
	};
	for (const key of ["N", "D", "R"]) {
		const v = ap.get(key);
		if (v.isStream()) visit(v);
		else if (v.isDictionary()) for (const [, state] of dictEntries(v)) visit(state);
	}
}

// ------------------------------------------------------------- page edits

// The page's own /Resources, made first when it has none (exported for new
// content, release 3). Works on a form XObject or an appearance stream too.
export function resourcesOf(doc, pageObj) {
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
// adding it (under a fresh name) when the page no longer lists it. Exported
// (release 3); `pageObj` may also be a form XObject or an appearance stream.
export function fontKey(doc, pageObj, ref) {
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

// Exported (release 3). Each call nests the old content one q level deeper:
// harmless after a redaction, which rewrites the content flat, but new content
// that is never redacted should use newcontent.ts's appendSafely instead.
export function appendContent(doc, pageObj, ops) {
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

// ------------------------------------------------------------ tagged PDF

// The page's content streams as one Latin-1 string.
function contentText(pageObj) {
	const c = pageObj.get("Contents");
	const parts = [];
	if (c.isArray()) c.forEach((s) => parts.push(streamText(s)));
	else if (c.isStream()) parts.push(streamText(c));
	return parts.join("\n");
}

// Byte classes: 1 = whitespace, 2 = delimiter.
const CLASS = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) CLASS[c] = 1;
for (const c of [40, 41, 60, 62, 91, 93, 123, 125, 47, 37]) CLASS[c] = 2;
const HEX = new Int8Array(256).fill(-1);
for (let c = 0; c < 256; c++) {
	const v = parseInt(String.fromCharCode(c), 16);
	if (!Number.isNaN(v)) HEX[c] = v;
}

// Minimal content-stream lexer, just enough to follow marked content: per
// MCID, the bytes its text operators show; text shown outside any MCID or
// /Artifact is counted as untagged. Named property lists (/P /MC0 BDC) are
// looked up in `props` (the page's /Properties). App addition (release 3):
// `added` holds the MCIDs of the lines the app wrote (newcontent.addText:
// a property list with /PEText), which never own a line edit's replacement.
export function markedContent(s, props = null) {
	const byMcid = new Map(), order = [], added = new Set();
	let untagged = 0, artifact = 0, maxMcid = -1, i = 0;
	const stack = [], marks = [];
	const n = s.length;
	const show = (bytes) => {
		let mcid = null, art = false;
		for (let k = marks.length - 1; k >= 0; k--) {
			if (mcid === null && marks[k].mcid !== null) mcid = marks[k].mcid;
			if (marks[k].tag === "Artifact") art = true;
		}
		if (mcid !== null) {
			if (!byMcid.has(mcid)) { byMcid.set(mcid, ""); order.push(mcid); }
			byMcid.set(mcid, byMcid.get(mcid) + bytes);
		} else if (art) artifact++;
		else untagged++;
	};
	const literal = () => { // at "(": returns the string's bytes
		let out = "", depth = 1;
		for (i++; i < n; i++) {
			const ch = s[i];
			if (ch === "\\") {
				const e = s[++i];
				const esc = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" }[e];
				if (esc) out += esc;
				else if (e >= "0" && e <= "7") {
					let o = e;
					while (o.length < 3 && s[i + 1] >= "0" && s[i + 1] <= "7") o += s[++i];
					out += String.fromCharCode(parseInt(o, 8) & 255);
				} else if (e === "\r") { if (s[i + 1] === "\n") i++; } else if (e !== "\n") out += e;
			} else if (ch === "(") { depth++; out += ch; } else if (ch === ")") { if (--depth === 0) { i++; return out; } out += ch; } else out += ch;
		}
		return out;
	};
	while (i < n) {
		const c = s.charCodeAt(i);
		if (CLASS[c] === 1) { i++; continue; }
		if (c === 37) { while (i < n && s[i] !== "\n" && s[i] !== "\r") i++; continue; } // %comment
		if (c === 40) { stack.push({ str: literal() }); continue; }
		if (c === 60 && s[i + 1] === "<") { stack.push("<<"); i += 2; continue; }
		if (c === 62 && s[i + 1] === ">") {
			const d = {};
			let k = stack.lastIndexOf("<<");
			const items = stack.splice(k);
			for (k = 1; k + 1 < items.length; k += 2) if (items[k] && items[k].name) d[items[k].name] = items[k + 1];
			stack.push({ dict: d });
			i += 2;
			continue;
		}
		if (c === 60) { // <hex>
			const j = s.indexOf(">", i);
			let out = "", hi = -1;
			for (let k = i + 1; k < j; k++) {
				const v = HEX[s.charCodeAt(k)];
				if (v < 0) continue;
				if (hi < 0) hi = v;
				else { out += String.fromCharCode(hi * 16 + v); hi = -1; }
			}
			if (hi >= 0) out += String.fromCharCode(hi * 16);
			stack.push({ str: out });
			i = j + 1;
			continue;
		}
		if (c === 91) { stack.push("["); i++; continue; }
		if (c === 93) { const k = stack.lastIndexOf("["); stack.push({ arr: stack.splice(k).slice(1) }); i++; continue; }
		if (c === 123 || c === 125) { i++; continue; }
		let j = i + 1;
		while (j < n && !CLASS[s.charCodeAt(j)]) j++;
		const tok = s.slice(i, j);
		i = j;
		if (c === 47) { stack.push({ name: tok.slice(1) }); continue; }
		if ((c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) { stack.push({ num: +tok }); continue; } // no operator starts so
		if (tok === "true" || tok === "false" || tok === "null") { stack.push({}); continue; }
		// operators
		if (tok === "BDC" || tok === "BMC") {
			const tag = tok === "BDC" ? stack[stack.length - 2] : stack[stack.length - 1];
			let p = tok === "BDC" ? stack[stack.length - 1] : null;
			if (p && p.name && props) p = { dict: props(p.name) || {} };
			const m = p && p.dict && p.dict.MCID && p.dict.MCID.num;
			const mcid = Number.isInteger(m) ? m : null;
			if (mcid !== null) maxMcid = Math.max(maxMcid, mcid);
			if (mcid !== null && p.dict.PEText) added.add(mcid);
			marks.push({ tag: tag && tag.name, mcid });
		} else if (tok === "EMC") marks.pop();
		else if (tok === "Tj" || tok === "'" || tok === "\"") {
			const t = stack[stack.length - 1];
			if (t && t.str !== undefined) show(t.str);
		} else if (tok === "TJ") {
			const a = stack[stack.length - 1];
			if (a && a.arr) show(a.arr.map((x) => x.str || "").join(""));
		} else if (tok === "ID") { // inline image data: skip to EI
			const m = /\sEI(?=[\s]|$)/g;
			m.lastIndex = i + 1;
			const r = m.exec(s);
			i = r ? r.index + 3 : n;
		}
		stack.length = 0;
	}
	return { byMcid, order, untagged, artifact, maxMcid, added };
}

function propsLookup(pageObj) {
	const p = pageObj.getInheritable("Resources").get("Properties");
	if (!p.isDictionary()) return null;
	return (name) => {
		const d = p.get(name);
		return d.isDictionary() && d.get("MCID").isNumber() ? { MCID: { num: d.get("MCID").asNumber() } } : {};
	};
}

// Number tree lookup (/Nums leaves, /Kids with /Limits).
function numberTreeGet(node, key) {
	if (!node.isDictionary()) return null;
	const nums = node.get("Nums");
	if (nums.isArray()) for (let i = 0; i + 1 < nums.length; i += 2) if (nums.get(i).asNumber() === key) return nums.get(i + 1);
	const kids = node.get("Kids");
	if (kids.isArray()) {
		for (let i = 0; i < kids.length; i++) {
			const kid = kids.get(i), lim = kid.get("Limits");
			if (lim.isArray() && (key < lim.get(0).asNumber() || key > lim.get(1).asNumber())) continue;
			const r = numberTreeGet(kid, key);
			if (r) return r;
		}
	}
	return null;
}

// For a tagged page: the ParentTree array that maps this page's MCIDs to
// their structure elements. null when the document or page is not tagged.
export function structParents(doc, pageObj) {
	const tree = doc.getTrailer().get("Root", "StructTreeRoot");
	const sp = pageObj.get("StructParents");
	if (!tree.isDictionary() || !sp.isNumber()) return null;
	const arr = numberTreeGet(tree.get("ParentTree"), sp.asNumber());
	return arr && arr.isArray() ? arr : null;
}

function arrayInsert(arr, at, value) {
	if (at >= arr.length) { arr.push(value); return; }
	arr.push(arr.get(arr.length - 1));
	for (let i = arr.length - 2; i > at; i--) arr.put(i, arr.get(i - 1));
	arr.put(at, value);
}

// Tags the replacement: a new /Span structure element, child of the element
// that owned the old word, placed right after the old word's MCID in that
// element's /K, and registered in the ParentTree under a new MCID. Returns
// the MCID the new text must be marked with.
// App change (release 3): an MCID far beyond the ParentTree's end (a crafted file can mark content
// with MCID 99999999 or 1e21) would make the padding loop below run for minutes; such a page is
// left untagged instead, as newcontent.tagNew does (same limit).
const MAX_MCID_GAP = 10_000;

function tagReplacement(doc, pageRef, parents, ownerMcid, newMcid) {
	if (!Number.isSafeInteger(newMcid) || newMcid - parents.length > MAX_MCID_GAP) return null;
	const owner = parents.get(ownerMcid);
	if (!owner.isDictionary()) return null;
	const span = doc.addObject({ Type: "StructElem", S: "Span", P: owner, Pg: pageRef, K: newMcid });
	const isOld = (x) => (x.isNumber() && x.asNumber() === ownerMcid) ||
		(x.isDictionary() && x.get("Type").asName() === "MCR" && x.get("MCID").asNumber() === ownerMcid);
	const k = owner.get("K");
	if (k.isArray()) {
		let at = k.length - 1;
		for (let i = 0; i < k.length; i++) if (isOld(k.get(i))) at = i;
		arrayInsert(k, at + 1, span);
	} else owner.put("K", k.isNull() ? [span] : [k, span]);
	while (parents.length < newMcid) parents.push(null);
	if (parents.length === newMcid) parents.push(span);
	else parents.put(newMcid, span);
	return { newMcid, ownerType: owner.get("S").asName(), ownerMcid };
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

// App addition (decorations): the entries of the page's /Annots, in order (references as written,
// or the dictionaries themselves when written directly in the array).
function annotEntries(pageObj) {
	const annots = pageObj.get("Annots");
	const out = [];
	if (annots.isArray()) annots.forEach((entry) => out.push(entry));
	return out;
}

// The same annotation: the same indirect object, or the same direct one in memory.
const annotIdentity = (o) => (o.isIndirect() ? `n${o.asIndirect()}` : `p${o.pointer}`);

// App addition (decorations fix): an /Annots entry's /Subtype, or "" for a null entry or a
// reference to nothing (some tools delete an annotation by writing null in its place).
function annotSubtype(entry) {
	if (entry.isNull()) return "";
	const dict = entry.resolve();
	return dict.isDictionary() ? dict.get("Subtype").asName() : "";
}

// App addition (decorations fix): under this /Subtype, which MuPDF does not know, the page's own
// Redact annotations sit out the edit's redaction (replaceText).
const PENDING_REDACT = "PdfEditPendingRedact";

// App addition (decorations): the annotations that the redaction took out of /Annots (`before`,
// annotEntries before it) go back in, each the original object, so that it keeps its /F, /Border,
// /StructParent (the tagged PDF's structure points at that object) and whatever else it had, at
// its place among the annotations still there: right after the nearest one that came before it.
// createLink made a new link at the end, without them.
// App change (decorations fix): every annotation goes back, not only links. MuPDF's redaction
// also deletes a FreeText it touches (a typewriter text, a comment box), and with it the FreeText's
// Popup (its /Parent and the FreeText's /Popup stay right: the objects are the same). The app's
// own Redact is not in `before`. Widgets are not dropped (MuPDF 1.27; deleting one would also take
// it out of /AcroForm /Fields, which core-fill.test.ts checks). Returns how many went back: the
// links, and the other annotations.
function restoreAnnots(doc, pageObj, before) {
	let annots = pageObj.get("Annots");
	const present = new Set();
	if (annots.isArray()) annots.forEach((entry) => present.add(annotIdentity(entry)));
	const lost = before.filter((entry) => !entry.isNull() && !present.has(annotIdentity(entry)));
	if (!lost.length) return { links: 0, others: 0 };
	if (!annots.isArray()) annots = pageObj.put("Annots", doc.newArray());
	const indexOf = (entry) => {
		const id = annotIdentity(entry);
		for (let k = 0; k < annots.length; k++) if (annotIdentity(annots.get(k)) === id) return k;
		return -1;
	};
	for (const entry of lost) {
		let at = 0;
		for (let k = before.indexOf(entry) - 1; k >= 0; k--) {
			const there = indexOf(before[k]);
			if (there >= 0) {
				at = there + 1;
				break;
			}
		}
		arrayInsert(annots, at, entry);
	}
	const links = lost.filter((entry) => annotSubtype(entry) === "Link").length;
	return { links, others: lost.length - links };
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
	if (!hit) {
		releasePage(page, lines);
		throw new Error(`"${find}" not found on page ${pageIndex + 1}`);
	}
	t0 = now();
	const glyphs = captureGlyphs(mupdf, page);
	const orig = hit.chars.map((ch) => matchGlyph(ch, glyphs));
	t.glyphs = now() - t0;
	const first = hit.chars[0], g0 = orig[0];
	if (!g0) {
		releasePage(page, lines, glyphs);
		throw new Error("could not match the stext char to a drawn glyph");
	}
	const vertical = g0.wmode === 1;
	// Vertical text: after redaction MuPDF keeps the rest of the column in
	// place with a TJ offset. The spec applies that offset vertically (MuPDF
	// does), pdfium/Chrome applies it horizontally and the rest of the column
	// jumps sideways. So the rest of the column is redacted and rewritten too
	// (same characters, same fonts): nothing is left that needs an offset.
	const rest = vertical && opts.rewriteRest !== false ? hit.line.chars.slice(hit.start + hit.chars.length) : [];
	const written = replacement + rest.map((c) => c.c).join("");

	// ---- find the font dict the original glyphs came from, and prove it:
	// drawing the original word's codes with it must yield the same glyph ids.
	t0 = now();
	const pageObj = page.getObject();
	const all = collectFonts(pageObj.getInheritable("Resources"), [], new Set(), []);
	const cands = all.filter((f) => dictMatches(f.ref, g0.fontName));
	let font = null, fontEntry = null, verifiedGids = 0, firstCode = -1;
	const seenObj = new Set();
	for (const entry of cands) {
		const num = entry.ref.isIndirect() ? entry.ref.asIndirect() : -1;
		if (num >= 0 && seenObj.has(num)) continue;
		seenObj.add(num);
		const f = new PdfFont(entry.ref, g0.font);
		if (f.vertical !== vertical) continue; // same program, other writing mode
		let match = 0, code0 = -1;
		hit.chars.forEach((ch, i) => {
			const r = resolveInOriginal(mupdf, f, ch.c);
			if (r.ok && orig[i] && (r.gid === orig[i].gid || !f.embedded)) { match++; if (i === 0) code0 = r.code; }
		});
		if (!font || match > verifiedGids) { font = f; fontEntry = entry; verifiedGids = match; firstCode = code0; }
		if (match === hit.chars.length) break;
	}
	t.fontAnalysis = now() - t0;

	// Producers sometimes split one face into several dicts (Word writes a
	// WinAnsi TrueType and an Identity-H Type0 subset of the same font): those
	// are still the original font, so they are tried before any fallback, as
	// long as they write in the same direction (Identity-H vs Identity-V).
	const originals = [];
	if (font) {
		originals.push(font);
		const seen = new Set([font.ref.isIndirect() ? font.ref.asIndirect() : -1]);
		for (const e of all) {
			const bf = dictNames(e.ref)[0];
			const num = e.ref.isIndirect() ? e.ref.asIndirect() : -1;
			if (seen.has(num) || untag(bf) !== untag(font.baseFont)) continue;
			seen.add(num);
			const fz = glyphs.find((g) => nameMatches(bf, g.fontName));
			const f = new PdfFont(e.ref, fz ? fz.font : null);
			if (f.vertical === vertical) originals.push(f);
		}
	}

	// ---- plan: one segment per run of characters drawn by the same font
	t0 = now();
	const style = styleOf(first);
	const chain = fallbackChain(mupdf, style, opts.extraFonts, cjkLanguage(font, written));
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
			const e = all.find((e) => dictMatches(e.ref, name));
			if (!e) continue;
			const num = e.ref.isIndirect() ? e.ref.asIndirect() : -1;
			if (!byNum.has(num)) {
				const fz = glyphs.find((g) => g.fontName === name);
				byNum.set(num, Object.assign(new PdfFont(e.ref, fz ? fz.font : null), { sameLine: true }));
			}
			if (byNum.get(num).sameLine && byNum.get(num).vertical === vertical) out.push(byNum.get(num));
		}
		return out;
	};
	for (const ch of written) {
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
	// area (and FreeText ones). An editor must keep them, so snapshot the
	// annotations and restore any lost.
	t0 = now();
	// Tagged page: note which MCID each run of shown bytes belongs to, so the
	// marked-content sequence that loses the word can be found after redaction.
	let tTag = now();
	const parents = structParents(doc, pageObj);
	const props = parents && propsLookup(pageObj);
	const mcBefore = parents && markedContent(contentText(pageObj), props);
	tTag = now() - tTag;
	// App change (decorations): the links are put back as the very objects they were, at their
	// place in /Annots (restoreAnnots), instead of new ones made with createLink.
	const annotsBefore = annotEntries(pageObj);
	// App change (decorations fix): applyRedactions applies every Redact annotation of the page,
	// and the page may have some of its own: marks waiting to be applied (made in Acrobat, say),
	// which are not this edit's to apply. They sit out the call under another /Subtype and get
	// /Redact back whatever happens, untouched, in their place. (Taking them out of /Annots would
	// not do: MuPDF reads a page's annotations when it loads the page.)
	const pending = annotsBefore.filter((entry) => annotSubtype(entry) === "Redact").map((entry) => entry.resolve());
	const annot = page.createAnnotation("Redact");
	annot.setQuadPoints(hit.chars.concat(rest).map((ch) => shrinkQuad(ch.quad)));
	for (const dict of pending) dict.put("Subtype", doc.newName(PENDING_REDACT));
	try {
		page.applyRedactions(false, 0, 0, 0); // no black box, keep images & line art
	} finally {
		for (const dict of pending) dict.put("Subtype", doc.newName("Redact"));
		annot.destroy(); // (rule 5; the redaction took it off the page)
	}
	const restored = restoreAnnots(doc, page.getObject(), annotsBefore);
	const linksRestored = restored.links, otherAnnotsRestored = restored.others;

	// ---- tag the replacement where the old word was (tagged PDFs)
	// Redaction keeps every BDC/EMC and the structure tree, but text appended
	// to the page would be untagged: screen readers and tag-based extraction
	// (Acrobat reading order, PDF/UA checks) would never see it. So it gets a
	// /Span of its own, child of the element that held the old word.
	let tag = null;
	const tTag2 = now();
	// App change: an empty replacement (deleting a line) gets no structure element.
	if (parents && written) {
		const mcAfter = markedContent(contentText(page.getObject()), props);
		const changed = mcBefore.order.filter((id) => (mcAfter.byMcid.get(id) || "") !== mcBefore.byMcid.get(id));
		const newMcid = Math.max(parents.length, mcBefore.maxMcid + 1, mcAfter.maxMcid + 1);
		// App change (release 3): a line the app wrote over the edited one loses glyphs to the
		// redaction too (protectAdded writes them back), and it comes first in content order from
		// the second edit of that line on (the first edit's replacement is appended after it). It
		// is not the line's owner: the first changed MCID that is not the app's is, unless only
		// the app's lines changed.
		const owner = changed.find((id) => !mcBefore.added.has(id)) ?? changed[0];
		if (changed.length) tag = tagReplacement(doc, doc.findPage(pageIndex), parents, owner, newMcid);
		tag = tag || { untagged: changed.length ? "owner is not a structure element" : "old word was not in marked content" };
	}
	t.redact = now() - t0;
	t.taggingPartOfRedact = tTag + now() - tTag2;

	// ---- write the replacement at the same baseline (user-space glyph matrix)
	t0 = now();
	// Split the glyph matrix into font size (vertical scale), horizontal
	// scaling Tz and a unit Tm, so the editor sees "11 pt, 105 %".
	const m = mupdf.Matrix.concat(g0.m, mupdf.Matrix.invert(page.getTransform()));
	const sx = Math.hypot(m[0], m[1]), size = Math.hypot(m[2], m[3]), th = sx / size;
	const tm = [m[0] / sx, m[1] / sx, m[2] / size, m[3] / size, m[4], m[5]];
	if (vertical) {
		// A vertical glyph is drawn at pen - v (v = (w0/2, 880) per mille of
		// the size by default); Tm must hold the pen, so add v back. For
		// non-Identity CMaps the CID is unknown and the defaults are used.
		const { vx, vy } = verticalMetrics(font, font && font.identity ? firstCode : -1);
		tm[4] += (vx / 1000) * m[0] / th + (vy / 1000) * m[2];
		tm[5] += (vx / 1000) * m[1] / th + (vy / 1000) * m[3];
	}
	// Letter spacing (Tc) is not in the matrix: estimate it from how far apart
	// the original glyphs sit versus their own advances. Tc is the same for
	// every pair while kerning is not, so only a uniform offset counts.
	const est = [];
	for (let i = 0; i + 1 < orig.length && !vertical; i++) {
		const a = orig[i], b = orig[i + 1];
		if (!a || !b || a.font !== b.font || isSpace(hit.chars[i].c)) continue;
		const d = ((b.m[4] - a.m[4]) * g0.m[0] + (b.m[5] - a.m[5]) * g0.m[1]) / Math.hypot(g0.m[0], g0.m[1]);
		est.push(d / th - a.font.advanceGlyph(a.gid) * size);
	}
	est.sort((x, y) => x - y);
	const uniform = est.length >= 2 && est[est.length - 1] - est[0] < 0.01 * size;
	const tc = uniform ? est[est.length >> 1] : 0;
	const pObj = page.getObject();
	let ops = (tag && tag.newMcid !== undefined ? `/Span <</MCID ${tag.newMcid}>> BDC\n` : "") + "q\nBT\n" + colorOp(g0, first.color) + "\n";
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
		// In vertical text a fallback goes through the font's Identity-V twin.
		if (seg.fb && vertical && !seg.fb.refV) seg.fb.refV = verticalTwin(doc, seg.fb.ref);
		const ref = seg.pdfFont ? seg.pdfFont.ref : vertical ? seg.fb.refV : seg.fb.ref;
		const bytes = seg.pdfFont ? seg.pdfFont.bytes : 2;
		seg.resName = fontKey(doc, pObj, ref);
		if (seg.fb) for (const c of seg.codes) seg.fb.used.add(c);
		else {
			// App change: a fallback font added by an earlier edit can be picked as the "original"
			// font when the same line is rewritten again. Its glyphs must still count as used, or
			// subsetting the fallback fonts at save time drops them (codes are glyph ids there).
			const owner = fallbackOwning(doc, seg.pdfFont.ref);
			if (owner) for (const c of seg.codes) owner.used.add(c);
		}
		seg.fontName = seg.pdfFont ? seg.pdfFont.baseFont : seg.fb.ref.get("BaseFont").asName();
		seg.hex = seg.codes.map((c) => hexCode(c, bytes));
		ops += `/${seg.resName} ${fmt(size)} Tf <${seg.hex.join("")}> Tj\n`;
	}
	ops += "ET\nQ\n" + (tag && tag.newMcid !== undefined ? "EMC\n" : "");
	// App change: an empty replacement only removes; no empty text object is written.
	if (written) appendContent(doc, pObj, ops);
	t.write = now() - t0;
	releasePage(page, lines, glyphs);
	// App addition: MuPDF keeps every font it has loaded in its resource store, keyed by the font
	// dict, and does not see that the dict's /ToUnicode or /W just changed. The document would
	// go on reading U+FFFD for the codes added (which the next edit of the line writes into the
	// file) and drawing them with the old widths, while the saved bytes, a checkpoint included,
	// read right. Emptying the store makes MuPDF load the font again. It also drops the decoded
	// images and every other cached resource, so it is done only when a font was changed.
	if (toUnicodeAdded || widthsAdded) mupdf.emptyStore();

	return {
		find, replacement, page: pageIndex,
		original: {
			fontName: g0.fontName, pdfFont: font && { key: fontEntry.key, path: fontEntry.path, subtype: font.subtype + (font.isType0 ? "/" + font.cidSubtype : ""), encoding: font.isType0 ? font.encodingName : "simple", embedded: font.embedded, toUnicode: font.hasToUnicode },
			fontDictVerified: `${verifiedGids}/${hit.chars.length} glyph ids reproduced`,
			size: +first.size.toFixed(3), fontSize: +size.toFixed(3), horizontalScale: +(th * 100).toFixed(2), charSpacing: +tc.toFixed(3),
			color: first.color, colorspace: g0.csType, mode: g0.mode,
			origin: first.origin, dir: hit.line.dir, wmode: vertical ? 1 : 0, bbox: quadBounds(hit.chars.map((c) => c.quad)),
			gids: Object.fromEntries(hit.chars.map((ch, i) => [ch.c, orig[i] && orig[i].gid])),
		},
		segments: plan.map((s) => ({
			text: s.text, source: s.kind, fontName: s.fontName, resource: s.resName, codes: s.hex.join(" "),
			// App addition (release 3): for a fallback, the face MuPDF reports when it reads the
			// text back (NimbusSans-Regular, Dingbats for the dict addFont named Helvetica or
			// ZapfDingbats), so the session can tell a fallback in the very face the line had.
			...(s.fb ? { program: s.fb.ref.get("DescendantFonts", 0).get("BaseFont").asName() } : {}),
			...(s.why ? { why: s.why } : {}), ...(s.how ? { how: s.how } : {}),
		})),
		missing, toUnicodeAdded, widthsAdded, linksRestored, otherAnnotsRestored, style, ops, timings: t,
		...(rest.length ? { rewrittenRest: rest.map((c) => c.c).join("") } : {}),
		...(tag ? { tag } : {}),
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

export function countStructElems(doc) {
	const tree = doc.getTrailer().get("Root", "StructTreeRoot");
	if (!tree.isDictionary()) return 0;
	const seen = new Set();
	let n = 0;
	const walk = (k) => {
		if (k.isArray()) { k.forEach(walk); return; }
		if (!k.isDictionary()) return;
		if (k.isIndirect()) { if (seen.has(k.asIndirect())) return; seen.add(k.asIndirect()); }
		const type = k.get("Type").asName();
		if (type === "MCR" || type === "OBJR") return;
		n++;
		walk(k.get("K"));
	};
	walk(tree.get("K"));
	return n;
}

// Tagged pages: text shown outside any MCID/Artifact (should not grow), and
// each tagged replacement must be a /Span under the old word's element.
function checkTags(before, after, edits) {
	if (!before.getTrailer().get("Root", "StructTreeRoot").isDictionary()) return null;
	const pages = [...new Set(edits.map((e) => e.page))];
	const untagged = (doc, p) => {
		const o = doc.findPage(p);
		return structParents(doc, o) ? markedContent(contentText(o), propsLookup(o)).untagged : null;
	};
	const res = { structElems: `${countStructElems(before)}->${countStructElems(after)}`, untaggedShows: {}, edits: [] };
	for (const p of pages) res.untaggedShows[p + 1] = `${untagged(before, p)}->${untagged(after, p)}`;
	let tagged = 0;
	for (const e of edits) {
		if (!e.tag || e.tag.newMcid === undefined) { res.edits.push(e.tag ? e.tag.untagged : "page not tagged"); continue; }
		tagged++;
		const o = after.findPage(e.page);
		const parents = structParents(after, o);
		const span = parents && parents.get(e.tag.newMcid), owner = parents && parents.get(e.tag.ownerMcid);
		const shown = markedContent(contentText(o), propsLookup(o)).byMcid.get(e.tag.newMcid) || "";
		let inK = false;
		if (owner && owner.isDictionary()) {
			const k = owner.get("K");
			(k.isArray() ? k : [k]).forEach((x) => { if (x.isIndirect && x.isIndirect() && x.asIndirect() === span.asIndirect()) inK = true; });
		}
		const ok = !!span && span.isDictionary() && span.get("S").asName() === "Span" && inK &&
			span.get("P").asIndirect() === owner.asIndirect() && shown.length > 0;
		res.edits.push(ok ? `Span MCID ${e.tag.newMcid} in ${e.tag.ownerType} (after MCID ${e.tag.ownerMcid})` : "BROKEN");
	}
	const [b, a] = res.structElems.split("->").map(Number);
	res.ok = a === b + tagged && !res.edits.includes("BROKEN") &&
		Object.values(res.untaggedShows).every((s) => { const [x, y] = s.split("->"); return x === y; });
	return res;
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
	const tags = checkTags(before, after, edits);
	if (tags) result.tags = tags;
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
