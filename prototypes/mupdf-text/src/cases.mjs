// Test matrix shared by the Node runner and the browser page.
// Each case opens one fixture, applies its edits, saves once, re-verifies.
export const CASES = [
	// Chrome/Skia: Type0 Identity-H, CIDFontType2 subsets with ToUnicode.
	{ id: "chrome-calibri", file: "chrome-subset.pdf", edits: [{ find: "prezzo", replace: "importo" }] },
	{ id: "chrome-specials", file: "chrome-subset.pdf", edits: [{ find: "speciale", replace: "“nuova” è l’€ già perché città" }] },
	{ id: "chrome-missing-glyphs", file: "chrome-subset.pdf", edits: [{ find: "concordato", replace: "più Größe ñ Ω ✓" }] },
	{ id: "chrome-georgia", file: "chrome-subset.pdf", edits: [{ find: "venerdì", replace: "sabato" }] },
	{ id: "chrome-consolas", file: "chrome-subset.pdf", edits: [{ find: "99,90", replace: "149,00" }] },
	{ id: "chrome-bold", file: "chrome-subset.pdf", edits: [{ find: "Pagamento", replace: "Saldo" }] },
	{ id: "chrome-red", file: "chrome-subset.pdf", edits: [{ find: "Importante", replace: "Urgente" }] },
	{
		id: "chrome-multi", file: "chrome-subset.pdf", edits: [
			{ find: "prezzo", replace: "costo" },
			{ find: "venerdì", replace: "lunedì" },
			{ find: "Milano", replace: "Forlì" },
		],
	},
	// Fully embedded font, ToUnicode and /W list only the used glyphs:
	// exercises the font-cmap path, the /W patch and the ToUnicode extension.
	{ id: "fullfont-identity-path", file: "fullfont-partial-tounicode.pdf", edits: [{ find: "base", replace: "unitario “ÀÉ” – ñ" }] },
	// CID-keyed CFF subset (CIDFontType0C in FontFile3), as InDesign/Acrobat write.
	{ id: "cff-cid-subset", file: "cff-subset.pdf", edits: [{ find: "prezzo", replace: "costo € “ok”" }] },
	{ id: "std14-times-bold", file: "cff-subset.pdf", edits: [{ find: "grassetto", replace: "nero più" }] },
	// Text inside a Form XObject under a scaling CTM, with a link over the word;
	// and a line with Tz 105 / Tc 1.5 (spacing is not carried over).
	{ id: "xobject-cm-link", file: "xobject-tz-link.pdf", edits: [{ find: "totale", replace: "saldo €" }] },
	{ id: "tz-tc-spacing", file: "xobject-tz-link.pdf", edits: [{ find: "largo", replace: "stretto" }] },
	// Line granularity (what the editor does): longer text, nothing to overlap.
	{ id: "chrome-whole-line", file: "chrome-subset.pdf", edits: [{ find: "Firmato: Ufficio Commerciale — Milano", replace: "Firmato: Direzione Commerciale — Forlì (FC), 15/10/2026" }] },
	// Word: simple TrueType WinAnsi subsets (no ToUnicode) mixed with Type0.
	{ id: "word-calibri", file: "word-winansi.pdf", edits: [{ find: "prezzo", replace: "importo “è” l’€" }] },
	{ id: "word-cambria", file: "word-winansi.pdf", edits: [{ find: "venerdì", replace: "lunedì" }] },
	// reportlab: non-embedded standard-14, custom-encoded TrueType subset, AcroForm.
	{ id: "rl-helvetica-std14", file: "reportlab-form.pdf", edits: [{ find: "saldo", replace: "acconto è “ok” l’€" }] },
	{ id: "rl-arial-custom-enc", file: "reportlab-form.pdf", edits: [{ find: "Rossi", replace: "Bianchi & C. più" }] },
	{ id: "rl-green", file: "reportlab-form.pdf", edits: [{ find: "venerdì", replace: "lunedì" }] },
	// Geometry: /Rotate 90 with upright content, and /Rotate 90 + offset CropBox.
	{ id: "rl-rotate90-upright", file: "reportlab-form.pdf", page: 1, edits: [{ find: "prezzo", replace: "costo" }] },
	{ id: "chrome-rotate90-crop", file: "chrome-rotate90-crop.pdf", edits: [{ find: "prezzo", replace: "importo" }] },
	// Encryption: owner-only opens without password; user password required.
	{ id: "enc-owner-aes256", file: "enc-owner-aes256.pdf", edits: [{ find: "prezzo", replace: "importo" }] },
	{ id: "enc-user-rc4", file: "enc-user-rc4.pdf", password: "utente", edits: [{ find: "prezzo", replace: "importo" }] },
	{ id: "enc-user-aes128", file: "enc-user-aes128.pdf", password: "utente", edits: [{ find: "prezzo", replace: "importo" }] },
	// pdfTeX-style Type1 in /FontFile: Cork /Differences naming every code, no
	// ToUnicode, fi ligature. "5" and "z" have codes and widths but no glyph.
	{ id: "type1-pdftex", file: "type1-pdftex.pdf", edits: [{ find: "prezzo", replace: "costo più" }] },
	{ id: "type1-missing-glyphs", file: "type1-pdftex.pdf", edits: [{ find: "12", replace: "15 € zero" }] },
	{ id: "type1-ligature", file: "type1-pdftex.pdf", edits: [{ find: "verifica", replace: "fine" }] },
	// Distiller/Ghostscript-style simple Type1C (bare CFF in FontFile3), WinAnsi.
	{ id: "type1c-simple", file: "type1c-simple.pdf", edits: [{ find: "totale", replace: "saldo €" }] },
	{ id: "type1c-missing-glyphs", file: "type1c-simple.pdf", edits: [{ find: "lunedì", replace: "venerdì" }] },
	// matplotlib Type3 fonts (glyph procedures): reused when the procedure
	// exists, per-character fallback otherwise; € lives in a second Type3 dict.
	{ id: "type3-matplotlib", file: "type3-matplotlib.pdf", edits: [{ find: "prezzo", replace: "costo" }] },
	{ id: "type3-fallback", file: "type3-matplotlib.pdf", edits: [{ find: "Totale", replace: "Iva €" }] },
	{ id: "type3-bold-chart", file: "type3-matplotlib.pdf", edits: [{ find: "Vendite", replace: "Ricavi" }, { find: "Milano", replace: "Roma" }] },
	// CJK. Non-embedded STSong-Light with Unicode CMaps (UniGB-UCS2-H/-V), a
	// Shift-JIS CMap (90ms-RKSJ-H, not handled: falls back), and an embedded
	// subset behind Identity-V (vertical) and Identity-H dicts.
	{ id: "cjk-ucs2-h", file: "cjk-reportlab.pdf", edits: [{ find: "星期五", replace: "星期一" }] },
	{ id: "cjk-ucs2-v", file: "cjk-reportlab.pdf", edits: [{ find: "账单", replace: "费用" }] },
	{ id: "cjk-rksj-fallback", file: "cjk-reportlab.pdf", edits: [{ find: "金曜日", replace: "月曜日" }] },
	{ id: "cjk-identity-v", file: "cjk-identity-v.pdf", edits: [{ find: "星期五", replace: "星期一" }] },
	{ id: "cjk-identity-v-fallback", file: "cjk-identity-v.pdf", edits: [{ find: "签署", replace: "盖章" }] },
	{ id: "cjk-identity-h-sibling", file: "cjk-identity-v.pdf", edits: [{ find: "联系人", replace: "负责人" }] },
	// Tagged PDF (Word, structure tags on), line granularity: the whole
	// marked-content sequence of the line is replaced.
	{ id: "word-tagged-whole-line", file: "word-winansi.pdf", edits: [{ find: "Il prezzo concordato è di 1.250 € – l’offerta “speciale” è valida perché già approvata.", replace: "Il prezzo concordato è di 1.300 € – offerta valida." }] },
];
