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
