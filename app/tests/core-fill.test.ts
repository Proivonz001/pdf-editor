// core.js additions for release 3 ("Compila e firma"), in Node on the worker's mupdf build:
// ZapfDingbats in the fallback chain (✓ ✗ ✔ ✘ drawable), the face of a fallback segment
// (`program`), encodeWithFallbacks (the fallback fonts shared by the form-field writer and new
// text) and subsetFallbackFonts on fonts used only in annotation appearances.
import { readFileSync } from "node:fs";
import * as mupdf from "mupdf";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureGlyphs,
  encodeWithFallbacks,
  extractLines,
  fallbackFontState,
  fontKey,
  openPdf,
  releaseFallbackFonts,
  releasePage,
  renderPixmap,
  replaceText,
  savePdf,
  subsetFallbackFonts,
} from "../src/engine/core.js";
import type { LineInfo } from "../src/engine/protocol";
import { EngineSession } from "../src/engine/session";

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

function session(name: string) {
  const s = new EngineSession(mupdf);
  const r = s.open(fixture(name));
  if (!r.ok) throw new Error(`${name} did not open: ${r.reason}`);
  return s;
}

function lineWith(lines: LineInfo[], needle: string): LineInfo {
  const line = lines.find((l) => l.text.includes(needle));
  if (!line) throw new Error(`no line contains "${needle}"`);
  return line;
}

const texts = (s: EngineSession, page = 0) => s.lines(page).map((l) => l.text.trim());

const SANS = { family: "sans", bold: false, italic: false } as const;

/** A new document with one empty page of `w` x `h` points. */
function blankDoc(w = 600, h = 300) {
  const doc = keep(new mupdf.PDFDocument());
  doc.insertPage(-1, doc.addPage([0, 0, w, h], 0, {}, ""));
  return doc;
}

/** Decoded length of a Type0 font's program (FontFile, FontFile2 or FontFile3). */
function programLength(type0: mupdf.PDFObject): number {
  const fd = type0.get("DescendantFonts", 0).get("FontDescriptor");
  for (const k of ["FontFile", "FontFile2", "FontFile3"]) {
    const ff = fd.get(k);
    if (ff.isStream()) {
      const buf = ff.readStream();
      try {
        return buf.getLength();
      } finally {
        buf.destroy();
      }
    }
  }
  return 0;
}

/** Pixels that differ (any channel by more than 40) between two renders of the same size. */
function changedPixels(a: mupdf.Pixmap, b: mupdf.Pixmap) {
  expect([b.getWidth(), b.getHeight()]).toEqual([a.getWidth(), a.getHeight()]);
  const pa = a.getPixels(), pb = b.getPixels();
  let n = 0;
  for (let i = 0; i < pa.length; i += 4)
    if (Math.abs(pa[i] - pb[i]) > 40 || Math.abs(pa[i + 1] - pb[i + 1]) > 40 || Math.abs(pa[i + 2] - pb[i + 2]) > 40) n++;
  return n;
}

/** Dark pixels inside `rect` (page space) of a render at `scale`. */
function inkIn(pix: mupdf.Pixmap, rect: [number, number, number, number], scale: number) {
  const px = pix.getPixels(), w = pix.getWidth(), x0 = pix.getX(), y0 = pix.getY();
  let n = 0;
  for (let y = Math.floor(rect[1] * scale); y < Math.ceil(rect[3] * scale); y++)
    for (let x = Math.floor(rect[0] * scale); x < Math.ceil(rect[2] * scale); x++) {
      const i = ((y - y0) * w + (x - x0)) * 4;
      if (px[i] < 128 && px[i + 1] < 128 && px[i + 2] < 128) n++;
    }
  return n;
}

describe("ZapfDingbats in the fallback chain", () => {
  it("✓ ✗ ✔ ✘ written by replaceLine come back exactly, also from the saved file", () => {
    const s = session("chrome-subset.pdf");
    const text = "Note: sì ✓ no ✗ ok ✔ ko ✘";
    const r = s.replaceLine(0, lineWith(s.lines(0), "Note").index, text);
    expect(r.missingChars).toEqual([]);
    expect(r.segments.map((x) => x.text).join("")).toBe(text);
    // The marks come from ZapfDingbats (before release 3: ✓ from the CJK font, ✗ ✔ ✘ missing).
    const marks = r.segments.filter((x) => /[✓✗✔✘]/.test(x.text));
    expect(marks.every((x) => x.source === "fallback" && x.fontName === "ZapfDingbats")).toBe(true);
    expect(texts(s)).toContain(text);

    for (const format of ["pdf", "pdfa-2b"] as const) {
      // PDF/A: the Dingbats subset passes the conversion and the engine's own check.
      const saved = s.save({ format, password: { mode: "none" } });
      const again = new EngineSession(mupdf);
      expect(again.open(saved.bytes).ok).toBe(true);
      expect(texts(again)).toContain(text);
      if (format === "pdfa-2b") expect(saved.pdfa?.blockers).toEqual([]);
      again.close();
    }
  });

  it("a line with ✗ edited again keeps it, from the same embedded font", () => {
    const s = session("chrome-subset.pdf");
    s.replaceLine(0, lineWith(s.lines(0), "Note").index, "Note ✗");
    const r = s.replaceLine(0, lineWith(s.lines(0), "Note ✗").index, "Note ✗ ✓");
    expect(r.missingChars).toEqual([]);
    expect(texts(s)).toContain("Note ✗ ✓");
    const state = fallbackFontState((s as unknown as { doc: mupdf.PDFDocument }).doc);
    expect(state.filter((f) => f.name === "ZapfDingbats")).toHaveLength(1);
  });
});

describe("replaceText segments", () => {
  it("a fallback segment names the face MuPDF reads the text back with (program)", () => {
    const { doc } = openPdf(mupdf, fixture("chrome-subset.pdf"));
    const pdf = keep(doc.asPDF()!);
    const page0 = pdf.loadPage(0);
    const lines0 = extractLines(page0);
    const line = lines0.find((l) => l.text.includes("Note"))!.text;
    releasePage(page0, lines0);

    const result = replaceText(mupdf, pdf, 0, line, "Note Ω ✗ 中");
    const fallbacks = result.segments.filter((x) => x.source === "fallback");
    expect(fallbacks.map((x) => x.text.trim())).toEqual(["Ω", "✗", "中"]);
    // The dict is named as asked (Helvetica-Bold, ZapfDingbats...), the program as MuPDF reports it.
    expect(fallbacks.map((x) => x.program)).toEqual(["NimbusSans-Bold", "Dingbats", "Droid Sans Fallback Regular"]);
    expect(result.segments.filter((x) => x.source !== "fallback").every((x) => !("program" in x))).toBe(true);

    const page = pdf.loadPage(0);
    const lines = extractLines(page);
    const edited = lines.find((l) => l.text.includes("Note Ω"))!;
    const faceOf = (c: string) => edited.chars.find((ch: { c: string }) => ch.c === c)!.fontName;
    expect([faceOf("Ω"), faceOf("✗"), faceOf("中")]).toEqual(fallbacks.map((x) => x.program));
    releasePage(page, lines);
  });
});

describe("encodeWithFallbacks", () => {
  it("shapes a line with the chain: runs per font, codes that read back exactly", () => {
    const doc = blankDoc();
    const text = "Città: Łódź ✓ ✗ 中文 Ωμέγα";
    const { runs, missing } = encodeWithFallbacks(mupdf, doc, text, SANS);
    expect(missing).toEqual([]);
    expect(runs.map((r) => r.text).join("")).toBe(text);
    expect(runs.map((r) => r.key)).toEqual([
      "Helvetica", "ZapfDingbats", "Helvetica", "ZapfDingbats", "Helvetica", "CJK (zh-Hans)", "Helvetica",
    ]);
    // Runs with the same key share one indirect Type0 dict (Identity-H, 2-byte codes).
    const nums = new Map<string, number>();
    for (const r of runs) {
      expect(r.font.isIndirect()).toBe(true);
      expect(r.font.get("Subtype").asName()).toBe("Type0");
      expect(r.font.get("Encoding").asName()).toBe("Identity-H");
      expect(r.hex).toMatch(/^([0-9a-f]{4})+$/);
      expect(r.hex.length).toBe(4 * [...r.text].length);
      if (nums.has(r.key)) expect(r.font.asIndirect()).toBe(nums.get(r.key));
      nums.set(r.key, r.font.asIndirect());
    }

    const pageObj = doc.findPage(0);
    let ops = "BT\n1 0 0 1 20 100 Tm\n";
    for (const r of runs) ops += `/${fontKey(doc, pageObj, r.font)} 14 Tf <${r.hex}> Tj\n`;
    pageObj.put("Contents", doc.addStream(ops + "ET\n", {}));
    const page = doc.loadPage(0);
    const lines = extractLines(page);
    expect(lines.map((l) => l.text)).toEqual([text]);
    releasePage(page, lines);
  });

  it("widths are the advances MuPDF draws with (at size 1)", () => {
    const doc = blankDoc(1200, 200);
    // MuPDF writes /W truncated to whole units: for Droid Sans Fallback's IPA and Vietnamese
    // letters that is up to 0.9/1000 em less than the program's advance.
    const style = { family: "serif", bold: true, italic: false } as const;
    const parts = ["Città Łódź ", "✓✗✔✘", " 中文日本", "ɯɱɸẼẾỀ", " Ωμέγα — fine"];
    const encoded = parts.map((p) => encodeWithFallbacks(mupdf, doc, p, style));
    const runs = encoded.flatMap((e) => e.runs);
    const end = encodeWithFallbacks(mupdf, doc, "|", style).runs[0];
    const size = 17.5, x0 = 20;
    const pageObj = doc.findPage(0);
    let ops = `BT\n1 0 0 1 ${x0} 100 Tm\n`;
    for (const r of [...runs, end]) ops += `/${fontKey(doc, pageObj, r.font)} ${size} Tf <${r.hex}> Tj\n`;
    pageObj.put("Contents", doc.addStream(ops + "ET\n", {}));

    const page = doc.loadPage(0);
    const glyphs = captureGlyphs(mupdf, page);
    try {
      // Each run starts where the widths of the runs before it end; the bar after the last run too.
      let x = x0, at = 0;
      for (const r of [...runs, end]) {
        expect(glyphs[at].m[4]).toBeCloseTo(x, 3);
        x += r.width * size;
        at += r.hex.length / 4;
      }
      expect(at).toBe(glyphs.length);
      // The program's own advances would put the end of that run 0.0024 em (0.04 pt here) further.
      const ipa = runs.find((r) => r.text === "ɯɱɸẼẾỀ")!;
      expect(ipa.key).toBe("CJK (zh-Hans)");
      const from = runs.indexOf(ipa), first = runs.slice(0, from).reduce((n, r) => n + r.hex.length / 4, 0);
      const program = glyphs.slice(first, first + 6).reduce((n, g) => n + g.font.advanceGlyph(g.gid, 0), 0);
      expect(program - ipa.width).toBeGreaterThan(0.002);
    } finally {
      releasePage(page, [], glyphs);
    }
  });

  it("leaves out what no font can draw, and anything above U+FFFF", () => {
    const doc = blankDoc();
    const { runs, missing } = encodeWithFallbacks(mupdf, doc, "ok 👍 𝑥 שלום 👍 fine", SANS);
    expect(missing).toEqual(["👍", "𝑥", "ש", "ל", "ו", "ם"]);
    expect(runs.map((r) => r.text).join("")).toBe("ok     fine");
    expect(encodeWithFallbacks(mupdf, doc, "👍", SANS)).toEqual({ runs: [], missing: ["👍"] });
    expect(() => encodeWithFallbacks(mupdf, doc, "x", { family: "cursive" as "sans", bold: false, italic: false })).toThrow();
  });

  it("picks the face of the style and the CJK font of the script", () => {
    const doc = blankDoc();
    const key = (text: string, style: { family: "sans" | "serif" | "mono"; bold: boolean; italic: boolean }) =>
      encodeWithFallbacks(mupdf, doc, text, style).runs.map((r) => r.key);
    expect(key("a", { family: "serif", bold: false, italic: true })).toEqual(["Times-Italic"]);
    expect(key("a", { family: "mono", bold: true, italic: true })).toEqual(["Courier-BoldOblique"]);
    expect(key("a", { family: "sans", bold: true, italic: false })).toEqual(["Helvetica-Bold"]);
    expect(key("ひらがな", SANS)).toEqual(["CJK (ja)"]);
    expect(key("한국어", SANS)).toEqual(["CJK (ko)"]);
  });

  it("shares the fonts with line edits: one copy per document, every glyph marked used", () => {
    const { doc } = openPdf(mupdf, fixture("chrome-subset.pdf"));
    const pdf = keep(doc.asPDF()!);
    const page0 = pdf.loadPage(0);
    const lines0 = extractLines(page0);
    const line = lines0.find((l) => l.text.includes("Note"))!.text;
    releasePage(page0, lines0);
    const edit = replaceText(mupdf, pdf, 0, line, "Note Ω");
    expect(edit.style).toMatchObject({ family: "sans", bold: true });
    const fromEdit = pdf.findPage(0).get("Resources", "Font").get(edit.segments.find((x) => x.source === "fallback")!.resource);

    const { runs } = encodeWithFallbacks(mupdf, pdf, "Ψ ✓", { family: "sans", bold: true, italic: false });
    expect(runs[0].key).toBe("Helvetica-Bold");
    expect(runs[0].font.asIndirect()).toBe(fromEdit.asIndirect());
    const state = fallbackFontState(pdf);
    expect(state.map((f) => f.name).sort()).toEqual(["Helvetica-Bold", "ZapfDingbats"]);
    const used = new Set(state.find((f) => f.name === "Helvetica-Bold")!.used);
    // Ω from the line edit, Ψ and the space from encodeWithFallbacks.
    const helv = new mupdf.Font("Helvetica-Bold");
    try {
      for (const c of "ΩΨ ") expect(used.has(helv.encodeCharacter(c.codePointAt(0)!))).toBe(true);
    } finally {
      helv.destroy();
    }
  });
});

describe("subsetFallbackFonts and annotation appearances", () => {
  /**
   * A page with a text field and a check box whose appearances alone draw with fallback fonts
   * (as the forms writer does), the check box with /N and /D state dictionaries; the page's own
   * content draws nothing.
   */
  function formDoc() {
    const doc = blankDoc(400, 200);
    const pageObj = doc.findPage(0);
    const appearance = (text: string, w: number, h: number) => {
      const ap = doc.addStream("", { Type: "XObject", Subtype: "Form", BBox: [0, 0, w, h], Resources: {} });
      let ops = "/Tx BMC\nq\nBT\n0 g\n2 6 Td\n";
      for (const r of encodeWithFallbacks(mupdf, doc, text, SANS).runs) ops += `/${fontKey(doc, ap, r.font)} 14 Tf <${r.hex}> Tj\n`;
      ap.writeStream(ops + "ET\nQ\nEMC\n");
      return ap;
    };
    const off = doc.addStream("", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 20, 20], Resources: {} });
    const text = doc.addObject({
      Type: "Annot", Subtype: "Widget", FT: "Tx", T: "(nome)", V: "(Zażółć gęślą)", F: 4,
      Rect: [20, 140, 220, 164], P: pageObj, AP: { N: appearance("Zażółć gęślą", 200, 24) },
    });
    const check = doc.addObject({
      Type: "Annot", Subtype: "Widget", FT: "Btn", T: "(ok)", V: "Si", AS: "Si", F: 4,
      Rect: [20, 100, 40, 120], P: pageObj,
      AP: { N: { Si: appearance("✓", 20, 20), Off: off }, D: { Si: appearance("✘", 20, 20), Off: off } },
    });
    pageObj.put("Annots", [text, check]);
    doc.getTrailer().get("Root").put("AcroForm", { Fields: [text, check] });
    return doc;
  }

  const fontsOf = (stream: mupdf.PDFObject) => {
    const out: mupdf.PDFObject[] = [];
    stream.get("Resources", "Font").forEach((v) => out.push(v));
    return out;
  };

  it("a fallback font used only in an appearance is subset at save, and still draws", () => {
    const doc = formDoc();
    const whole = new Map(fallbackFontState(doc).map((f) => [f.name, programLength(doc.newIndirect(f.ref))]));
    expect(whole.get("Helvetica")).toBeGreaterThan(20_000);
    expect(whole.get("ZapfDingbats")).toBeGreaterThan(20_000);
    const page = doc.loadPage(0);
    const before = renderPixmap(mupdf, page, 2);
    page.destroy();

    const { bytes } = savePdf(mupdf, doc);
    const saved = openBytes(bytes);
    const annots = saved.findPage(0).get("Annots");
    const [text, check] = [annots.get(0), annots.get(1)];
    const appearanceFonts = [
      ...fontsOf(text.get("AP", "N")),
      ...fontsOf(check.get("AP", "N", "Si")),
      ...fontsOf(check.get("AP", "D", "Si")),
    ];
    expect(appearanceFonts.length).toBe(3);
    for (const f of appearanceFonts) {
      const name = f.get("BaseFont").asName().replace(/^[A-Z]{6}\+/, ""); // the dict's own name: Helvetica, ZapfDingbats
      expect(programLength(f)).toBeLessThan(whole.get(name)! / 2);
    }
    // Only the subsets are in the file: the whole programs went with garbage collection (the
    // file is smaller than either whole program alone, which MuPDF stores uncompressed).
    expect(bytes.byteLength).toBeLessThan(Math.min(...whole.values()));

    const savedPage = saved.loadPage(0);
    const after = renderPixmap(mupdf, savedPage, 2);
    savedPage.destroy();
    try {
      // The widgets' boxes in page space (y down on the 200 pt page).
      expect(inkIn(after, [20, 36, 220, 60], 2)).toBeGreaterThan(100);
      expect(inkIn(after, [20, 80, 40, 100], 2)).toBeGreaterThan(20);
      expect(changedPixels(before, after)).toBe(0);
    } finally {
      before.destroy();
      after.destroy();
    }
  });

  it("a glyph needed after subsetting gets a whole copy, and subsetting again shrinks it", () => {
    const doc = formDoc();
    expect(subsetFallbackFonts(mupdf, doc)).toBe(2);
    const subsetRef = doc.findPage(0).get("Annots").get(0).get("AP", "N", "Resources", "Font");
    const subsetNums: number[] = [];
    subsetRef.forEach((v) => subsetNums.push(v.asIndirect()));
    expect(subsetFallbackFonts(mupdf, doc)).toBe(0); // nothing new: left as it is

    // As the PDF/A conversion drawing a field again would: a glyph the subset lacks.
    const reuse = encodeWithFallbacks(mupdf, doc, "Zaż", SANS).runs;
    expect(reuse.map((r) => r.font.asIndirect())).toEqual([subsetNums[0]]); // all in the subset
    const fresh = encodeWithFallbacks(mupdf, doc, "Q", SANS).runs[0];
    expect(fresh.font.asIndirect()).not.toBe(subsetNums[0]);
    expect(programLength(fresh.font)).toBeGreaterThan(20_000);

    const pageObj = doc.findPage(0);
    pageObj.put("Contents", doc.addStream(`BT /${fontKey(doc, pageObj, fresh.font)} 40 Tf 1 0 0 1 300 40 Tm <${fresh.hex}> Tj ET`, {}));
    expect(subsetFallbackFonts(mupdf, doc)).toBe(1);
    const shrunk = doc.findPage(0).get("Resources", "Font");
    let length = 0;
    shrunk.forEach((v) => (length = programLength(v)));
    expect(length).toBeGreaterThan(0);
    expect(length).toBeLessThan(10_000);

    const saved = openBytes(savePdf(mupdf, doc).bytes);
    const page = saved.loadPage(0);
    const lines = extractLines(page);
    expect(lines.map((l) => l.text)).toEqual(["Q"]);
    const pix = renderPixmap(mupdf, page, 2);
    try {
      expect(inkIn(pix, [300, 120, 340, 165], 2)).toBeGreaterThan(200); // the Q, y down from 200
      expect(inkIn(pix, [20, 36, 220, 60], 2)).toBeGreaterThan(100); // the field, from the first subset
    } finally {
      pix.destroy();
      releasePage(page, lines);
    }
  });
});

// Decorations (phase 3): the links core.replaceText's redaction takes off the page go back as the
// very objects they were, at their place in /Annots, with /F, /Border and /StructParent (a tagged
// PDF's structure tree points at the object), instead of new ones made with createLink.
describe("replaceText puts the original links back", () => {
  /**
   * Three lines, each under a link (/F 4, /Border [0 0 0]); the middle one is in the structure
   * tree too (/StructParent 1, an OBJR in a /Link element).
   */
  function linkedPage(): mupdf.PDFDocument {
    const doc = keep(new mupdf.PDFDocument());
    const font = new mupdf.Font("Helvetica");
    const helv = doc.addSimpleFont(font);
    font.destroy();
    const ys = [700, 650, 600];
    const content = ys.map((y, k) => `/P <</MCID ${k}>> BDC BT /F1 12 Tf 50 ${y} Td (Line number ${k + 1}) Tj ET EMC`).join("\n");
    doc.insertPage(-1, doc.addPage([0, 0, 400, 800], 0, { Font: { F1: helv } }, content));
    const page = doc.findPage(0);
    const links = ys.map((y, k) => doc.addObject({
      Type: "Annot", Subtype: "Link", Rect: [48, y - 4, 140, y + 12], Border: [0, 0, 0], F: 4,
      ...(k === 1 ? { StructParent: 1 } : {}), A: { S: "URI", URI: doc.newString(`https://example.com/${k + 1}`) },
    }));
    const annots = doc.newArray();
    for (const l of links) annots.push(l);
    page.put("Annots", annots);
    page.put("StructParents", 0);
    const root = doc.addObject({ Type: "StructTreeRoot" });
    const part = doc.addObject({ Type: "StructElem", S: "Document", P: root });
    const paragraphs = [0, 1, 2].map((k) => doc.addObject({ Type: "StructElem", S: k === 1 ? "Link" : "P", P: part, Pg: page, K: k }));
    const objr = doc.newDictionary();
    objr.put("Type", doc.newName("OBJR"));
    objr.put("Obj", links[1]);
    objr.put("Pg", page);
    paragraphs[1].put("K", [1, objr]);
    part.put("K", paragraphs);
    root.put("K", part);
    root.put("ParentTree", { Nums: [0, paragraphs, 1, paragraphs[1]] });
    root.put("ParentTreeNextKey", 2);
    doc.getTrailer().get("Root").put("StructTreeRoot", root);
    doc.getTrailer().get("Root").put("MarkInfo", { Marked: true });
    return doc;
  }

  const annotsOf = (doc: mupdf.PDFDocument) => {
    const annots = doc.findPage(0).get("Annots");
    const out: mupdf.PDFObject[] = [];
    annots.forEach((a) => out.push(a));
    return out;
  };

  it("a link with /F 4, /Border and /StructParent keeps them and its place after a line edit, and after save and re-open", () => {
    const doc = linkedPage();
    const before = annotsOf(doc).map((a) => a.asIndirect());
    const r = replaceText(mupdf, doc, 0, "Line number 2", "Line number 2, edited");
    expect(r.linksRestored).toBe(1);
    const after = annotsOf(doc);
    expect(after.map((a) => a.asIndirect())).toEqual(before); // the same objects, in the same order
    const link = after[1].resolve();
    expect(link.get("StructParent").asNumber()).toBe(1);
    expect(link.get("F").asNumber()).toBe(4);
    expect(link.get("Border").toString()).toBe("[0 0 0]");

    const saved = openBytes(savePdf(mupdf, doc).bytes);
    const again = annotsOf(saved);
    expect(again).toHaveLength(3);
    const uris = again.map((a) => a.resolve().get("A", "URI").asString());
    expect(uris).toEqual(["https://example.com/1", "https://example.com/2", "https://example.com/3"]);
    const kept = again[1].resolve();
    expect([kept.get("StructParent").asNumber(), kept.get("F").asNumber(), kept.get("Border").toString()]).toEqual([1, 4, "[0 0 0]"]);
    // The structure tree's object reference still names that very annotation (the edit's new
    // /Span went in the same element, after the old text's MCID).
    const kids = saved.getTrailer().get("Root", "StructTreeRoot", "ParentTree", "Nums").get(3).get("K");
    const refs: number[] = [];
    kids.forEach((k) => { if (k.isDictionary() && k.get("Type").asName() === "OBJR") refs.push(k.get("Obj").asIndirect()); });
    expect(refs).toEqual([again[1].asIndirect()]);
    const page = saved.loadPage(0);
    const links = page.getLinks();
    expect(links.map((l) => l.getURI())).toEqual(uris);
    expect(links[1].getBounds()).toEqual([48, 138, 140, 154]); // page space (800 - 662, 800 - 646): not mirrored
    for (const l of links) l.destroy();
    page.destroy();
  });

  it("links the redaction did not touch are left as they were, after save and re-open too", () => {
    const doc = linkedPage();
    const before = annotsOf(doc).map((a) => a.asIndirect());
    expect(replaceText(mupdf, doc, 0, "Line number 1", "First").linksRestored).toBe(1);
    expect(replaceText(mupdf, doc, 0, "Line number 3", "").linksRestored).toBe(1); // a delete keeps the link too
    expect(annotsOf(doc).map((a) => a.asIndirect())).toEqual(before);
    const saved = openBytes(savePdf(mupdf, doc).bytes);
    expect(annotsOf(saved).map(summary)).toEqual(["Link https://example.com/1", "Link https://example.com/2", "Link https://example.com/3"]);
  });

  // ---- decorations fix round 1 (review D9, D10, D14)

  /**
   * A page (400 x 800) with one Helvetica 12 pt line per entry of `lines`, line k with its
   * baseline at y 700 - 50k from x 50 (PDF space), and in /Annots the entries `annots` returns,
   * in that order.
   */
  function pageWith(lines: string[], annots: (doc: mupdf.PDFDocument, page: mupdf.PDFObject) => mupdf.PDFObject[]) {
    const doc = keep(new mupdf.PDFDocument());
    const font = new mupdf.Font("Helvetica");
    const helv = doc.addSimpleFont(font);
    font.destroy();
    const content = lines.map((text, k) => `BT /F1 12 Tf 50 ${700 - 50 * k} Td (${text}) Tj ET`).join("\n");
    doc.insertPage(-1, doc.addPage([0, 0, 400, 800], 0, { Font: { F1: helv } }, content));
    const page = doc.findPage(0);
    const list = doc.newArray();
    for (const a of annots(doc, page)) list.push(a);
    page.put("Annots", list);
    return doc;
  }
  /** A rect (PDF space) over line k of pageWith, from x0 to x1. */
  const over = (k: number, x0 = 48, x1 = 250) => [x0, 700 - 50 * k - 4, x1, 700 - 50 * k + 12];
  const quadsOf = (r: number[]) => [r[0], r[3], r[2], r[3], r[0], r[1], r[2], r[1]];
  const linkAt = (doc: mupdf.PDFDocument, rect: number[], uri: string) => doc.addObject({
    Type: "Annot", Subtype: "Link", Rect: rect, Border: [0, 0, 0], F: 4, A: { S: "URI", URI: doc.newString(uri) },
  });
  /** A text field's widget over `rect`, registered in /AcroForm /Fields. */
  const fieldAt = (doc: mupdf.PDFDocument, page: mupdf.PDFObject, rect: number[]) => {
    const widget = doc.addObject({ Type: "Annot", Subtype: "Widget", FT: "Tx", T: doc.newString("name"), Rect: rect, F: 4, P: page });
    doc.getTrailer().get("Root").put("AcroForm", { Fields: [widget] });
    return widget;
  };
  /** An /Annots entry, said so that two documents compare: its subtype, and a link's URI. */
  function summary(entry: mupdf.PDFObject) {
    if (entry.isNull()) return "null";
    const d = entry.resolve();
    if (!d.isDictionary()) return "nothing";
    const subtype = d.get("Subtype").asName();
    return subtype === "Link" ? `Link ${d.get("A", "URI").asString()}` : subtype;
  }
  /** The text of page 0's lines, as MuPDF reads it, in reading order. */
  function linesOf(doc: mupdf.PDFDocument) {
    const page = doc.loadPage(0);
    const lines = extractLines(page);
    try {
      return lines.map((l) => l.text.trim()).filter(Boolean).sort();
    } finally {
      releasePage(page, lines);
    }
  }
  /** What a freshly loaded page 0 lists: its annotations' types (no links, widgets or popups), its widgets, its links. */
  function loaded(doc: mupdf.PDFDocument) {
    const page = doc.loadPage(0);
    try {
      const links = page.getLinks();
      const out = { annots: page.getAnnotations().map((a) => a.getType()), widgets: page.getWidgets().length, links: links.map((l) => l.getURI()) };
      for (const l of links) l.destroy();
      return out;
    } finally {
      page.destroy();
    }
  }
  const fields = (doc: mupdf.PDFDocument) => {
    const out: number[] = [];
    doc.getTrailer().get("Root", "AcroForm", "Fields").forEach((f) => out.push(f.asIndirect()));
    return out;
  };

  it("several links lost at once go back in their order, among annotations that are not links (D14)", () => {
    // "Terms Privacy Cookies", a link on each word: one replaceText loses the three. In /Annots the
    // first link has nothing before it, the other two follow each other after a note, and a
    // widget and a square (not links: the redaction leaves them) come after.
    const doc = pageWith(["Terms Privacy Cookies", "Name"], (doc, page) => [
      linkAt(doc, [49, 696, 84, 712], "https://example.com/terms"),
      doc.addObject({ Type: "Annot", Subtype: "Text", Rect: [300, 690, 320, 710], F: 4, Contents: doc.newString("note") }),
      linkAt(doc, [87, 696, 127, 712], "https://example.com/privacy"),
      linkAt(doc, [130, 696, 174, 712], "https://example.com/cookies"),
      fieldAt(doc, page, over(0, 180, 250)),
      doc.addObject({ Type: "Annot", Subtype: "Square", Rect: over(0, 40, 260), F: 4 }),
    ]);
    const before = annotsOf(doc).map((a) => a.asIndirect());
    const r = replaceText(mupdf, doc, 0, "Terms Privacy Cookies", "Terms, Privacy and Cookies");
    expect(r.linksRestored).toBe(3); // the three were lost at once
    expect(r.otherAnnotsRestored).toBe(0);
    expect(annotsOf(doc).map((a) => a.asIndirect())).toEqual(before);
    expect(loaded(doc).links).toEqual(["https://example.com/terms", "https://example.com/privacy", "https://example.com/cookies"]);

    const saved = openBytes(savePdf(mupdf, doc).bytes);
    expect(annotsOf(saved).map(summary)).toEqual([
      "Link https://example.com/terms", "Text", "Link https://example.com/privacy", "Link https://example.com/cookies", "Widget", "Square",
    ]);
    expect(linesOf(saved)).toEqual(["Name", "Terms, Privacy and Cookies"]);
  });

  it("every annotation the redaction drops goes back, not only links: a FreeText over the line and its Popup (D10)", () => {
    // Every common type over the edited line. MuPDF's redaction drops the link and the FreeText
    // (a typewriter text, a comment box), and with the FreeText its Popup.
    const others = ["Text", "Square", "Circle", "Line", "Ink", "Stamp", "Caret", "Highlight", "Underline", "StrikeOut",
      "Squiggly", "Polygon", "PolyLine", "FileAttachment"];
    let free = 0, popup = 0, widget = 0;
    const doc = pageWith(["Pay online for the order", "Second line"], (doc, page) => {
      const f = doc.addObject({
        Type: "Annot", Subtype: "FreeText", Rect: over(0), F: 4, Contents: doc.newString("typed"), DA: doc.newString("0 g /Helv 10 Tf"),
      });
      const p = doc.addObject({ Type: "Annot", Subtype: "Popup", Rect: [250, 600, 380, 700], Parent: f, Open: false });
      f.put("Popup", p);
      const w = fieldAt(doc, page, over(0, 150, 250));
      [free, popup, widget] = [f.asIndirect(), p.asIndirect(), w.asIndirect()];
      return [
        doc.addObject({ Type: "Annot", Subtype: "Text", Rect: [300, 690, 320, 710], F: 4 }),
        f,
        linkAt(doc, over(0, 48, 110), "https://example.com/pay"),
        p,
        w,
        ...others.map((subtype) => doc.addObject({ Type: "Annot", Subtype: subtype, Rect: over(0), F: 4 })),
      ];
    });
    const before = annotsOf(doc).map((a) => a.asIndirect());
    const r = replaceText(mupdf, doc, 0, "Pay online for the order", "Pay online for the order now");
    expect(r.linksRestored).toBe(1); // (links only, as before)
    expect(r.otherAnnotsRestored).toBe(2); // the FreeText and its Popup
    expect(annotsOf(doc).map((a) => a.asIndirect())).toEqual(before); // the same objects, at their places
    const at = (num: number) => annotsOf(doc).find((a) => a.asIndirect() === num)!.resolve();
    expect(at(free).get("Popup").asIndirect()).toBe(popup);
    expect(at(popup).get("Parent").asIndirect()).toBe(free);
    expect(at(free).get("Contents").asString()).toBe("typed");
    // The widget is not dropped (MuPDF 1.27): its field is still in /AcroForm /Fields. (If a later
    // MuPDF dropped it, deleting a widget takes it out of /Fields too, and this would say so.)
    expect(fields(doc)).toEqual([widget]);
    const live = loaded(doc); // a page loaded now reads the annotations put back
    expect(live.annots).toContain("FreeText");
    expect(live.widgets).toBe(1);
    expect(live.links).toEqual(["https://example.com/pay"]);

    const saved = openBytes(savePdf(mupdf, doc).bytes);
    const again = annotsOf(saved);
    expect(again.map(summary)).toEqual(["Text", "FreeText", "Link https://example.com/pay", "Popup", "Widget", ...others]);
    expect(again[3].resolve().get("Parent").asIndirect()).toBe(again[1].asIndirect());
    expect(again[1].resolve().get("Popup").asIndirect()).toBe(again[3].asIndirect());
    expect(fields(saved)).toEqual([again[4].asIndirect()]);
    const reread = loaded(saved);
    expect(reread.annots).toContain("FreeText");
    expect(reread.widgets).toBe(1);
    expect(linesOf(saved)).toEqual(["Pay online for the order now", "Second line"]);
  });

  it("Redact annotations the page already has (marked, not applied) are not applied by a line edit (D9)", () => {
    // A mark over another line ("Account 12345678 secret") and one over the edited line itself.
    const doc = pageWith(["Line to fix", "Account 12345678 secret"], (doc) => {
      const mark = (k: number) => doc.addObject({
        Type: "Annot", Subtype: "Redact", Rect: over(k), QuadPoints: quadsOf(over(k)), F: 4, OverlayText: doc.newString("REDACTED"),
      });
      return [mark(1), linkAt(doc, over(0, 48, 120), "https://example.com/fix"), mark(0)];
    });
    const before = annotsOf(doc);
    const marks = [before[0], before[2]].map((a) => a.resolve().toString());
    const quads = [before[0], before[2]].map((a) => a.resolve().get("QuadPoints").toString());
    const r = replaceText(mupdf, doc, 0, "Line to fix", "Line fixed");
    expect(linesOf(doc)).toEqual(["Account 12345678 secret", "Line fixed"]); // the marked text is still there
    const after = annotsOf(doc);
    expect(after.map((a) => a.asIndirect())).toEqual(before.map((a) => a.asIndirect())); // the marks too, at their places
    expect([after[0], after[2]].map((a) => a.resolve().toString())).toEqual(marks); // unchanged (/Subtype /Redact)
    expect(r.linksRestored).toBe(1);
    expect(r.otherAnnotsRestored).toBe(0);
    expect(loaded(doc)).toEqual({ annots: ["Redact", "Redact"], widgets: 0, links: ["https://example.com/fix"] });

    const saved = openBytes(savePdf(mupdf, doc).bytes);
    expect(annotsOf(saved).map(summary)).toEqual(["Redact", "Link https://example.com/fix", "Redact"]);
    expect([0, 2].map((k) => annotsOf(saved)[k].resolve().get("QuadPoints").toString())).toEqual(quads);
    expect(linesOf(saved)).toEqual(["Account 12345678 secret", "Line fixed"]);
    // And the marks still work: applying them now is the user's choice.
    const page = saved.loadPage(0);
    page.applyRedactions(false, 0, 0, 0);
    page.destroy();
    expect(linesOf(saved)).toEqual([]);
  });

  it("through the session (replaceLine, undo, redo, save): the marked line, its mark and a FreeText over the edited line stay", () => {
    const doc = pageWith(["Line to fix", "Account 12345678 secret"], (doc) => [
      doc.addObject({ Type: "Annot", Subtype: "Redact", Rect: over(1), QuadPoints: quadsOf(over(1)), F: 4 }),
      doc.addObject({ Type: "Annot", Subtype: "FreeText", Rect: over(0, 130, 250), F: 4, Contents: doc.newString("typed"), DA: doc.newString("0 g /Helv 10 Tf") }),
    ]);
    const s = new EngineSession(mupdf);
    expect(s.open(savePdf(mupdf, doc).bytes).ok).toBe(true);
    try {
      s.replaceLine(0, lineWith(s.lines(0), "Line to fix").index, "Line fixed");
      expect(texts(s).sort()).toEqual(["Account 12345678 secret", "Line fixed"]);
      s.undo();
      s.redo(); // (a replay of the edit)
      expect(texts(s).sort()).toEqual(["Account 12345678 secret", "Line fixed"]);
      const saved = openBytes(new Uint8Array(s.save().bytes));
      expect(annotsOf(saved).map(summary)).toEqual(["Redact", "FreeText"]);
      expect(linesOf(saved)).toEqual(["Account 12345678 secret", "Line fixed"]);
    } finally {
      s.close();
    }
  });

  it("a null entry or a reference to nothing in /Annots is skipped, not a failure", () => {
    const doc = pageWith(["Pay online"], (doc) => [doc.newNull(), linkAt(doc, over(0, 48, 110), "https://example.com/pay"), doc.newIndirect(9999)]);
    const r = replaceText(mupdf, doc, 0, "Pay online", "Pay onlineeeeee");
    expect(r.linksRestored).toBe(1);
    expect(annotsOf(doc).map(summary)).toEqual(["null", "Link https://example.com/pay", "nothing"]);
    const saved = openBytes(savePdf(mupdf, doc).bytes);
    expect(loaded(saved).links).toEqual(["https://example.com/pay"]);
    expect(linesOf(saved)).toEqual(["Pay onlineeeeee"]);
  });
});
