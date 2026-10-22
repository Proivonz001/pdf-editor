// Bianchetto and Oscura (release 5): redact.ts and redactGeometry.ts, through the engine functions
// the session calls, on the documents of helpers/leakPdf.ts (a secret in every channel a
// redaction must clear) and on small pages built here. Every check of what is left reads the
// download as the app writes it (SAVE_OPTIONS): every object, raw and decoded, every picture and
// mask decoded, the page rendered.
import { readFileSync } from "node:fs";
import * as mupdf from "mupdf";
import { describe, expect, it, vi } from "vitest";
import { detectDecorations } from "../src/engine/decorations";
import { findPlacements } from "../src/engine/images";
import { addText, addedTexts } from "../src/engine/newcontent";
import type { Quad, Rect, RedactArea, TextStyle } from "../src/engine/protocol";
import { MAX_REDACT_PIXELS, RedactError, previewRedaction, redactAreas } from "../src/engine/redact";
import { MAX_REDACT_RECTS, areasForQuads, clampAreas } from "../src/engine/redactGeometry";
import {
  LEAK_AREA, LEGIT, OSCURA_GONE, SECRET_RGB, WHITEOUT_GONE, WHITEOUT_KEPT, annotatedPdf, bigPicturePdf, cmykPicturePdf, download, leakPdf, listedOnlyPdf,
  maskedPicturePdf, openPdf, pageText, pictureScan, resourcelessPdf, reusedMaskPdf, separationPdf, sharedDrawingPdf, softMaskPdf, taggedPdf, tokenPlaces, unsurePdf, unusedHolderPdf,
  type Holder, type Tagging,
} from "./helpers/leakPdf";

type Doc = mupdf.PDFDocument;

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

const AREA: RedactArea[] = [{ pageIndex: 0, rects: [LEAK_AREA] }];
const SANS: TextStyle = { size: 12, color: [0, 0, 0], family: "sans", bold: false, italic: false };

const leaksIn = (bytes: Uint8Array, tokens: string[]) => tokens.filter((t) => tokenPlaces(bytes, t).length > 0);
const missingIn = (bytes: Uint8Array, tokens: string[]) => tokens.filter((t) => tokenPlaces(bytes, t).length === 0);

/** Every object of the working document as text (streams by their bytes): equal before and after means nothing changed. */
function snapshot(doc: Doc): string {
  const parts: string[] = [doc.getTrailer().toString()];
  for (let n = 1; n < doc.countObjects(); n++) {
    const o = doc.newIndirect(n);
    parts.push(`${n}: ${o.resolve().toString()}`);
    if (o.isStream()) {
      const buf = o.readRawStream();
      try {
        parts.push(Array.from(buf.asUint8Array(), (b) => b.toString(16)).join(""));
      } finally {
        buf.destroy();
      }
    }
  }
  return parts.join("\n");
}

/** A page rendered at `scale` (RGB, annotations included). */
function render(doc: Doc, pageIndex: number, scale = 1) {
  const page = doc.loadPage(pageIndex);
  try {
    const pix = page.toPixmap([scale, 0, 0, scale, 0, 0], mupdf.ColorSpace.DeviceRGB, false, true);
    try {
      return { w: pix.getWidth(), h: pix.getHeight(), stride: pix.getStride(), px: pix.getPixels().slice() };
    } finally {
      pix.destroy();
    }
  } finally {
    page.destroy();
  }
}

/** Pixels inside `r` (page space, shrunk by `inset`) that are not `rgb` (within 40 per channel). */
function otherThan(img: ReturnType<typeof render>, r: Rect, rgb: number[], inset = 2): number {
  let n = 0;
  for (let y = Math.ceil(r[1] + inset); y < r[3] - inset; y++)
    for (let x = Math.ceil(r[0] + inset); x < r[2] - inset; x++) {
      const o = y * img.stride + x * 3;
      if ([0, 1, 2].some((k) => Math.abs(img.px[o + k] - rgb[k]) > 40)) n++;
    }
  return n;
}

/** Pixels that differ (any channel by more than 8) between two renders of the same size. */
function changed(a: ReturnType<typeof render>, b: ReturnType<typeof render>): number {
  let n = 0;
  for (let i = 0; i < a.px.length; i++) if (Math.abs(a.px[i] - b.px[i]) > 8) n++;
  return n;
}

/** Pixels that differ (any channel by more than 8) outside `r` widened by `margin` (page space, renders at scale 1): what a redaction of `r` leaves as it was. */
function changedOutside(a: ReturnType<typeof render>, b: ReturnType<typeof render>, r: Rect, margin = 2): number {
  let n = 0;
  for (let y = 0; y < a.h; y++)
    for (let x = 0; x < a.w; x++) {
      if (x > r[0] - margin && x < r[2] + margin && y > r[1] - margin && y < r[3] + margin) continue;
      const o = y * a.stride + x * 3;
      if ([0, 1, 2].some((k) => Math.abs(a.px[o + k] - b.px[o + k]) > 8)) n++;
    }
  return n;
}

/** The page's text as one line (MuPDF may split a line where removed text left a gap). */
const flatText = (doc: Doc, pageIndex: number) => pageText(doc, pageIndex).replace(/\s+/g, " ").trim();

/** The page's content streams, decoded and joined. */
function pageContent(doc: Doc, pageIndex: number): string {
  const c = doc.findPage(pageIndex).get("Contents");
  let out = "";
  for (const s of c.isArray() ? Array.from({ length: c.length }, (_, i) => c.get(i)) : [c]) {
    const buf = s.readStream();
    try {
      out += buf.asString();
    } finally {
      buf.destroy();
    }
  }
  return out;
}

/** Paths MuPDF paints that lie wholly inside `r` (page space), and are smaller than it (the box is not). */
function paintsInside(doc: Doc, pageIndex: number, r: Rect): number {
  const page = doc.loadPage(pageIndex);
  let n = 0;
  const count = (b: number[]) => { if (b[0] > r[0] + 1 && b[1] > r[1] + 1 && b[2] < r[2] - 1 && b[3] < r[3] - 1) n++; };
  const dev = new mupdf.Device({
    fillPath(p, _e, ctm, cs) { count(p.getBounds(null as unknown as mupdf.StrokeState, ctm)); p.destroy(); cs.destroy(); },
    strokePath(p, stroke, ctm, cs) { count(p.getBounds(stroke, ctm)); p.destroy(); stroke.destroy(); cs.destroy(); },
    // (a pattern fill's area comes in pattern space, `ctm` takes it to the page)
    beginTile(area, _view, _xs, _ys, ctm) { count(mupdf.Rect.transform(area, ctm)); return 0; },
  });
  try {
    page.runPageContents(dev, mupdf.Matrix.identity);
    dev.close();
  } finally {
    dev.destroy();
    page.destroy();
  }
  return n;
}

/**
 * The structure tree's elements (S, and their descriptions and titles), the OBJRs it holds, and
 * whether every object it references (OBJR /Obj, MCR /Stm) is one page 1 lists now: an
 * annotation, or a picture or form it draws.
 */
function structureOf(bytes: Uint8Array) {
  const doc = openPdf(bytes);
  try {
    const elems: { S: string; Alt: string | null; ActualText: string | null; E: string | null; T: string | null }[] = [];
    let objrs = 0;
    const targets: number[] = [];
    const seen = new Set<number>();
    const walk = (o: mupdf.PDFObject, depth: number) => {
      if (depth > 32) return;
      if (o.isArray()) {
        for (let i = 0; i < o.length; i++) walk(o.get(i), depth + 1);
        return;
      }
      if (!o.isDictionary()) return;
      if (o.isIndirect()) {
        if (seen.has(o.asIndirect())) return;
        seen.add(o.asIndirect());
      }
      const type = o.get("Type").toString();
      if (type === "/OBJR" || type === "/MCR") {
        if (type === "/OBJR") objrs++;
        const target = o.get(type === "/OBJR" ? "Obj" : "Stm");
        if (target.isIndirect()) targets.push(target.asIndirect());
        return;
      }
      const s = (k: string) => (o.get(k).isString() ? o.get(k).asString() : null);
      if (o.get("S").isName()) elems.push({ S: o.get("S").asName(), Alt: s("Alt"), ActualText: s("ActualText"), E: s("E"), T: s("T") });
      walk(o.get("K"), depth + 1);
    };
    walk(doc.getTrailer().get("Root", "StructTreeRoot", "K"), 0);
    const page1 = new Set<number>();
    const p1 = doc.findPage(0);
    p1.get("Annots").forEach((a) => { if (a.isIndirect()) page1.add(a.asIndirect()); });
    p1.get("Resources", "XObject").forEach((x) => { if (x.isIndirect()) page1.add(x.asIndirect()); });
    return { elems, objrs, targets: targets.length, onPage1: targets.every((n) => page1.has(n)) };
  } finally {
    doc.destroy();
  }
}

/** The form's fields by full name, with their values and how many widgets each has. */
function fieldsOf(bytes: Uint8Array): Record<string, { value: string | null; widgets: number }> {
  const doc = openPdf(bytes);
  try {
    const out: Record<string, { value: string | null; widgets: number }> = {};
    const fields = doc.getTrailer().get("Root", "AcroForm", "Fields");
    for (let i = 0; i < fields.length; i++) {
      const f = fields.get(i);
      const kids = f.get("Kids");
      out[f.get("T").asString()] = { value: f.get("V").isString() ? f.get("V").asString() : null, widgets: kids.isArray() ? kids.length : 1 };
    }
    return out;
  } finally {
    doc.destroy();
  }
}

/** MuPDF's redaction alone (no clean-ups), as research §redact measured it. */
function rawRedaction(doc: Doc, pageIndex: number, rects: Rect[], image: number) {
  const page = doc.loadPage(pageIndex);
  try {
    const made = rects.map((r) => {
      const a = page.createAnnotation("Redact");
      a.setRect(r);
      return a;
    });
    page.applyRedactions(false, image, 1, 0);
    for (const a of made) a.destroy();
  } finally {
    page.destroy();
  }
}

describe("the leak document", () => {
  it("leaks with MuPDF's redaction alone: the checks see it", () => {
    const doc = openPdf(leakPdf("shared"));
    try {
      rawRedaction(doc, 0, [LEAK_AREA], 2);
      const out = download(doc);
      // Annotations, field values, descriptions, the unused font, the thumbnail, private data, the
      // original pictures and masks; forms and a picture the structure tree keeps, ancestors'
      // descriptions and titles, the forms' and the page's metadata.
      expect(leaksIn(out, OSCURA_GONE)).toEqual(expect.arrayContaining([
        "SEGRETO_AT_INLINE", "SEGRETO_CARATTERE", "SEGRETO_AT_NOME", "SEGRETO_FORM", "SEGRETO_PATTERN", "SEGRETO_NOTA", "SEGRETO_RISPOSTA",
        "SEGRETO_EVIDENZIA", "SEGRETO_CAMPO", "SEGRETO_ALT", "SEGRETO_THUMB", "SEGRETO_PIECEINFO", "SEGRETO_FORMA_STM", "SEGRETO_FORMA_OBJR",
        "SEGRETO_FOTO_OBJR", "SEGRETO_AT_SEZIONE", "SEGRETO_TITOLO", "SEGRETO_ALT_LINK", "SEGRETO_XMP_FORMA", "SEGRETO_PIECEINFO_FORMA",
        "SEGRETO_XMP_PAGINA",
      ]));
      const pictures = pictureScan(out);
      expect(pictures.secretPixels).toBeGreaterThan(0);
      expect(pictures.secretMasks).toBeGreaterThan(0);
    } finally {
      doc.destroy();
    }
  });

  it("sees the secret colour in a CMYK picture too", () => {
    expect(pictureScan(cmykPicturePdf()).secretPixels).toBe(800); // (the object's 400, and as drawn)
  });

  it("holds every token and picture part before any redaction", () => {
    const out = download(openPdf(leakPdf("shared")));
    expect(missingIn(out, [...OSCURA_GONE, ...LEGIT])).toEqual([]);
    expect(pictureScan(out)).toEqual({ secretPixels: 9200, legitPixels: 9200, secretMasks: 6, legitMasks: 6 });
  });
});

describe("Oscura", () => {
  for (const resources of ["shared", "inherited", "own"] as const) {
    it(`leaves nothing of what was under the area in the file (${resources} resources)`, () => {
      const doc = openPdf(leakPdf(resources));
      try {
        const page2 = openPdf(download(doc));
        const before = render(page2, 1);
        page2.destroy();
        const { report, formChanged } = redactAreas(mupdf, doc, AREA, "redact");
        const out = download(doc);
        expect(leaksIn(out, OSCURA_GONE)).toEqual([]);
        expect(missingIn(out, LEGIT)).toEqual([]);
        const pictures = pictureScan(out);
        expect(pictures.secretPixels).toBe(0);
        expect(pictures.secretMasks).toBe(0);
        expect(pictures.legitPixels).toBeGreaterThan(4000); // the parts below the area, each picture's
        expect(pictures.legitMasks).toBeGreaterThan(2);

        // The area is black (the box), the page outside it as it was; page 2 untouched.
        const saved = openPdf(out);
        try {
          expect(otherThan(render(saved, 0), LEAK_AREA, [0, 0, 0])).toBe(0);
          expect(changed(render(saved, 1), before)).toBe(0);
          expect(pageText(saved, 0)).toContain("LEGIT_FUORI");
          expect(pageText(saved, 0)).not.toMatch(/SEGRETO|NASCOSTO/);
          expect(pageText(saved, 1)).toContain("CONDIVISO_FORM");
          expect(paintsInside(saved, 0, LEAK_AREA)).toBe(0); // the line art and the pattern fill went
        } finally {
          saved.destroy();
        }

        // The form: "codice" gone (and out of /CO), "nome" keeps its value and its page 2 widget, "fuori" stays.
        expect(fieldsOf(out)).toEqual({ nome: { value: "CONDIVISO_CAMPO", widgets: 1 }, fuori: { value: "LEGIT_CAMPO", widgets: 1 } });
        const s = openPdf(out);
        try {
          expect(s.getTrailer().get("Root", "AcroForm", "CO").length).toBe(0);
        } finally {
          s.destroy();
        }
        expect(formChanged).toBe(true);

        // Tags: the descriptions and titles of what went are gone, their ancestors' too; the
        // references to the annotations and to the picture no longer drawn too; the form tagged
        // whole and the one tagged inside name the copies page 1 draws now. Outside, the P keeps its /Alt.
        const tags = structureOf(out);
        expect(tags.objrs).toBe(1);
        expect(tags).toMatchObject({ targets: 2, onPage1: true });
        expect(tags.elems.map((e) => e.S)).toEqual(["Document", "P", "Sect", "Span", "Span", "Figure", "Link", "Annot", "Form", "Span", "Figure", "Figure"]);
        expect(tags.elems.filter((e) => e.Alt || e.ActualText || e.E || e.T)).toEqual([{ S: "P", Alt: "LEGIT_ALT", ActualText: null, E: null, T: null }]);

        expect(report).toMatchObject({
          pictures: 8, fields: ["codice", "nome"], links: 1, annotations: 4, crossing: false, attachments: 1, fieldsElsewhere: ["nome"],
        });
        expect(report.text).toContain("SEGRETO_INVISIBILE");
        expect(report.text).not.toContain("LEGIT");
        expect(report.growth).toBeGreaterThanOrEqual(0);
      } finally {
        doc.destroy();
      }
    });
  }

  it("keeps the new pictures in the app's terms: device colours, /OC, JPEG for a JPEG, the signature still the app's", () => {
    const doc = openPdf(leakPdf("shared"));
    try {
      redactAreas(mupdf, doc, AREA, "redact");
      const out = openPdf(download(doc));
      try {
        const images: mupdf.PDFObject[] = [];
        out.findPage(0).get("Resources", "XObject").forEach((v) => { if (v.get("Subtype").toString() === "/Image") images.push(v); });
        const cleared = images.filter((v) => v.get("Width").asNumber() === 100); // (the one outside the area is 20 wide)
        // The JPEG is a JPEG again, the others lossless; device colours, no Artifex profile; the app's turn kept.
        expect(cleared.map((v) => v.get("Filter").toString()).sort()).toEqual(["/CCITTFaxDecode", "/DCTDecode", "/FlateDecode", "/FlateDecode", "/FlateDecode"]);
        expect(cleared.filter((v) => v.get("ColorSpace").isArray()).length).toBe(0);
        expect(cleared.filter((v) => v.get("SMask").isStream()).length).toBe(2); // the signature, the /Mask picture
        expect(cleared.filter((v) => v.get("PEOrientation").isNumber() && v.get("PEOrientation").asNumber() === 6).length).toBe(1);
        const page = out.loadPage(0);
        try {
          const found = findPlacements(mupdf, page);
          expect(found.agreed).toBe(true);
          expect(found.placements.filter((p) => p.added).length).toBe(1); // the signature's /PEImage block
        } finally {
          page.destroy();
        }
      } finally {
        out.destroy();
      }
    } finally {
      doc.destroy();
    }
  });

  for (const mask of ["stencil", "colour-key", "key and soft mask", "indexed key", "16-bit key", "decoded key"] as const)
    it(`a picture whose shape is in its /Mask (${mask}): outside the area it shows as before, its mask keeps nothing of the shape under it`, () => {
      // (MuPDF's copy holds the mask as an /SMask, which fixPicture clears under the area)
      expect(pictureScan(maskedPicturePdf(mask)).secretMasks).toBeGreaterThan(0);
      const doc = openPdf(maskedPicturePdf(mask));
      try {
        const before = render(doc, 0);
        redactAreas(mupdf, doc, AREA, "redact");
        const out = download(doc);
        const pictures = pictureScan(out);
        expect(pictures.secretMasks).toBe(0);
        expect(pictures.legitMasks).toBeGreaterThan(0);
        const saved = openPdf(out);
        try {
          expect(changedOutside(render(saved, 0), before, LEAK_AREA)).toBe(0);
        } finally {
          saved.destroy();
        }
      } finally {
        doc.destroy();
      }
    });

  for (const [angle, kind] of [[10, "lossless"], [3, "lossless"], [20, "lossless"], [10, "a JPEG"], [10, "a soft mask"]] as const)
    it(`a picture drawn turned (${angle}°, ${kind}): outside the area it shows as before, nothing of the secret under it stays`, () => {
      // (MuPDF whitens the area's bounds in the picture's own space, its soft mask's too: more than the area)
      const W = 200, H = 200, jpeg = kind === "a JPEG", alpha = kind === "a soft mask";
      const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, W, H], alpha);
      const px = pix.getPixels(), n = alpha ? 4 : 3;
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const seen = !alpha || (x >> 3) % 2 === 0; // (see-through stripes, premultiplied: black there)
          px.set([...(!seen ? [0, 0, 0] : y >= 90 && y < 110 && x >= 60 && x < 140 ? SECRET_RGB : [(x * 255) / W, 128, (y * 255) / H]), ...(alpha ? [seen ? 255 : 0] : [])], (y * W + x) * n);
        }
      const image = jpeg ? new mupdf.Image(pix.asJPEG(95, false)) : new mupdf.Image(pix);
      pix.destroy();
      const doc = new mupdf.PDFDocument();
      const im = doc.addImage(image);
      image.destroy();
      // 200 pt square, turned about its middle (page 300, 421)
      const a = (angle * Math.PI) / 180, c = 200 * Math.cos(a), s = 200 * Math.sin(a);
      const m = [c, s, -s, c, 300 - (c - s) / 2, 421 - (s + c) / 2].map((v) => v.toFixed(4)).join(" ");
      doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { XObject: { Im: im } }, `0.9 0.9 0.2 rg 150 250 300 350 re f q ${m} cm /Im Do Q`));
      try {
        const area: Rect = [180, 395, 420, 447];
        const before = render(doc, 0);
        redactAreas(mupdf, doc, [{ pageIndex: 0, rects: [area] }], "redact");
        const out = download(doc);
        expect(pictureScan(out).secretPixels).toBe(0);
        const saved = openPdf(out);
        try {
          const after = render(saved, 0);
          if (jpeg) {
            // (JPEG noise outside the area, no white wedge)
            let white = 0;
            for (let y = 0; y < after.h; y++)
              for (let x = 0; x < after.w; x++) {
                if (x > area[0] - 2 && x < area[2] + 2 && y > area[1] - 2 && y < area[3] + 2) continue;
                const o = y * after.stride + x * 3;
                if (after.px[o] > 240 && after.px[o + 1] > 240 && after.px[o + 2] > 240 && !(before.px[o] > 240 && before.px[o + 1] > 240 && before.px[o + 2] > 240)) white++;
              }
            expect(white).toBe(0);
          } else expect(changedOutside(after, before, area, 4)).toBe(0); // (the samples the area's edge cuts, 1 pt each, go whole)
        } finally {
          saved.destroy();
        }
      } finally {
        doc.destroy();
      }
    });

  // (a deskewed bilevel scan, a stencil painted in a colour, a photo whose shape is a stencil /Mask: 1-bit samples)
  for (const [angle, kind] of [[3, "a bilevel scan"], [10, "a bilevel scan"], [10, "a stencil"], [10, "a stencil /Mask"]] as const)
    it(`a picture drawn turned (${angle}°, ${kind}): outside the area it shows as before, nothing of it under the area stays`, () => {
      const S = 200, row = S / 8;
      const bits = new Uint8Array(row * S), rgb = new Uint8Array(S * S * 3);
      for (let y = 0; y < S; y++)
        for (let x = 0; x < S; x++) {
          if (((x >> 2) + (y >> 2)) % 2) bits[y * row + (x >> 3)] |= 0x80 >> (x & 7);
          rgb.set([200, x, y], (y * S + x) * 3);
        }
      const doc = new mupdf.PDFDocument();
      const picture = (data: Uint8Array, dict: Record<string, unknown>) => {
        const buf = new mupdf.Buffer(data);
        try {
          return doc.addStream(buf, { Type: "XObject", Subtype: "Image", Width: S, Height: S, BitsPerComponent: 1, ...dict });
        } finally {
          buf.destroy();
        }
      };
      const im = kind === "a bilevel scan" ? picture(bits, { ColorSpace: "DeviceGray" })
        : kind === "a stencil" ? picture(bits, { ImageMask: true })
        : picture(rgb, { ColorSpace: "DeviceRGB", BitsPerComponent: 8, Mask: picture(bits, { ImageMask: true }) });
      const a = (angle * Math.PI) / 180, c = 200 * Math.cos(a), s = 200 * Math.sin(a);
      const m = [c, s, -s, c, 300 - (c - s) / 2, 421 - (s + c) / 2].map((v) => +v.toFixed(4));
      doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { XObject: { Im: im } }, `0.9 0.9 0.2 rg 150 250 300 350 re f 0 0 1 rg q ${m.join(" ")} cm /Im Do Q`));
      try {
        const area: Rect = [180, 395, 420, 447];
        const before = render(doc, 0);
        redactAreas(mupdf, doc, [{ pageIndex: 0, rects: [area] }], "redact");
        const out = download(doc);
        // Every picture and mask left, decoded: what of it lies inside the area (2 pt in) shows nothing.
        const saved = openPdf(out);
        try {
          const masks = new Set<number>(), pictures: mupdf.PDFObject[] = [];
          for (let k = 1; k < saved.countObjects(); k++) {
            const o = saved.newIndirect(k);
            if (!o.isStream() || o.get("Subtype").toString() !== "/Image") continue;
            pictures.push(o);
            for (const key of ["SMask", "Mask"]) if (o.get(key).isIndirect()) masks.add(o.get(key).asIndirect());
          }
          let shown = 0;
          for (const o of pictures) {
            const image = saved.loadImage(o);
            const pix = image.toPixmap();
            try {
              const w = pix.getWidth(), h = pix.getHeight(), stride = pix.getStride(), n = stride / w, px = pix.getPixels();
              const clear = pix.getAlpha() || masks.has(o.asIndirect()) ? 0 : 255; // (a stencil's or a mask's: nothing shows; a picture's: white)
              for (let y = 0; y < h; y++)
                for (let x = 0; x < w; x++) {
                  const u = (x + 0.5) / w, v = 1 - (y + 0.5) / h; // (the first stored row is the picture's top)
                  const px0 = m[0] * u + m[2] * v + m[4], py0 = 842 - (m[1] * u + m[3] * v + m[5]);
                  if (px0 > area[0] + 2 && px0 < area[2] - 2 && py0 > area[1] + 2 && py0 < area[3] - 2 && px.subarray(y * stride + x * n, (y * stride + x * n) + n).some((v) => v !== clear)) shown++;
                }
            } finally {
              pix.destroy();
              image.destroy();
            }
          }
          expect(pictures.length).toBeGreaterThan(0);
          expect(shown).toBe(0);
          expect(changedOutside(render(saved, 0), before, area, 4)).toBe(0); // (the samples the area's edge cuts, 1 pt each, go whole)
        } finally {
          saved.destroy();
        }
      } finally {
        doc.destroy();
      }
    });

  it("a picture tagged by an object reference keeps its /StructParent, the reference names the new picture", () => {
    const doc = new mupdf.PDFDocument();
    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 50, 50], false);
    pix.clear(90);
    const image = new mupdf.Image(pix);
    const im = doc.addImage(image);
    image.destroy();
    pix.destroy();
    im.put("StructParent", 0);
    doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { XObject: { Im: im } }, "q 100 0 0 100 100 600 cm /Im Do Q"));
    const objr = doc.newDictionary();
    objr.put("Type", doc.newName("OBJR"));
    objr.put("Obj", im);
    const figure = doc.addObject({ Type: "StructElem", S: "Figure", K: objr, Alt: doc.newString("Logo") });
    const tree = doc.addObject({ Type: "StructTreeRoot", K: figure, ParentTree: { Nums: [0, figure] }, ParentTreeNextKey: 1 });
    figure.put("P", tree);
    doc.getTrailer().get("Root").put("StructTreeRoot", tree);
    try {
      redactAreas(mupdf, doc, [{ pageIndex: 0, rects: [[130, 160, 170, 200]] }], "redact");
      let now: mupdf.PDFObject | null = null;
      doc.findPage(0).get("Resources", "XObject").forEach((v) => { now = v; });
      const picture = now as unknown as mupdf.PDFObject;
      expect(picture.asIndirect()).not.toBe(im.asIndirect());
      expect(picture.get("StructParent").asNumber()).toBe(0);
      expect(figure.get("K").get("Obj").asIndirect()).toBe(picture.asIndirect());
      expect(figure.get("Alt").isNull()).toBe(true); // its picture changed
    } finally {
      doc.destroy();
    }
  });

  it("two edits over one signature: each clears its own part of the shape, the first part stays cleared", () => {
    const doc = new mupdf.PDFDocument();
    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 90, 30], true);
    const px = pix.getPixels();
    for (let i = 0; i < 90 * 30; i++) {
      px[i * 4 + 2] = 200;
      px[i * 4 + 3] = 255; // ink everywhere: the shape is the whole mask
    }
    const image = new mupdf.Image(pix);
    const im = doc.addImage(image);
    image.destroy();
    pix.destroy();
    doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { XObject: { Sig: im } }, "q 90 0 0 30 100 700 cm /Sig Do Q"));
    try {
      // (page space: the picture is x 100..190, y 112..142, 1 pt a pixel)
      redactAreas(mupdf, doc, [{ pageIndex: 0, rects: [[100, 112, 130, 142]] }], "redact");
      redactAreas(mupdf, doc, [{ pageIndex: 0, rects: [[160, 112, 190, 142]] }], "redact");
      const saved = openPdf(download(doc));
      try {
        let mask: mupdf.PDFObject | null = null;
        saved.findPage(0).get("Resources", "XObject").forEach((v) => { mask = v.get("SMask"); });
        const m = saved.loadImage(mask as unknown as mupdf.PDFObject);
        const mp = m.toPixmap();
        const opaque = (x0: number, x1: number) => {
          let n = 0;
          for (let y = 0; y < 30; y++) for (let x = x0; x < x1; x++) if (mp.getPixels()[y * mp.getStride() + x] > 127) n++;
          return n;
        };
        expect([opaque(0, 30), opaque(32, 58), opaque(60, 90)]).toEqual([0, 30 * 26, 0]);
        mp.destroy();
        m.destroy();
      } finally {
        saved.destroy();
      }
    } finally {
      doc.destroy();
    }
  });

  it("a named description another page uses too stays there; the redacted page's copy loses it", () => {
    const doc = new mupdf.PDFDocument();
    const helv = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica" });
    const res = doc.addObject({ Font: { F1: helv }, Properties: { MC0: { ActualText: doc.newString("DESCRITTO") } } });
    doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, res, "/Span /MC0 BDC BT /F1 12 Tf 120 620 Td (uno) Tj ET EMC"));
    doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, res, "/Span /MC0 BDC BT /F1 12 Tf 120 620 Td (due) Tj ET EMC"));
    try {
      redactAreas(mupdf, doc, AREA, "redact");
      expect(doc.findPage(0).get("Resources", "Properties", "MC0").get("ActualText").isNull()).toBe(true);
      expect(doc.findPage(1).get("Resources", "Properties", "MC0").get("ActualText").asString()).toBe("DESCRITTO");
      expect(tokenPlaces(download(doc), "DESCRITTO").length).toBeGreaterThan(0);
    } finally {
      doc.destroy();
    }
  });

  it("a picture in a hidden layer stays hidden (its /OC comes back)", () => {
    const doc = new mupdf.PDFDocument();
    const ocg = doc.addObject({ Type: "OCG", Name: doc.newString("Nascosto") });
    doc.getTrailer().get("Root").put("OCProperties", doc.addObject({ OCGs: [ocg], D: { OFF: [ocg] } }));
    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 50, 50], false);
    pix.clear(0);
    const image = new mupdf.Image(pix);
    const im = doc.addImage(image);
    image.destroy();
    pix.destroy();
    im.put("OC", ocg);
    doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { XObject: { Im: im } }, "q 100 0 0 100 100 600 cm /Im Do Q"));
    try {
      redactAreas(mupdf, doc, [{ pageIndex: 0, rects: [[130, 160, 170, 200]] }], "redact");
      const xo = doc.findPage(0).get("Resources", "XObject");
      let oc = 0;
      xo.forEach((v) => { if (v.get("OC").isDictionary()) oc++; });
      expect(oc).toBe(1);
      // Hidden: nothing of it shows outside the box.
      const img = render(doc, 0);
      expect(otherThan(img, [102, 144, 198, 240], [255, 255, 255], 0) - otherThan(img, [130, 160, 170, 200], [255, 255, 255], -1)).toBe(0);
    } finally {
      doc.destroy();
    }
  });

  it("removes a reply's thread, popups and the link from the structure, and keeps pending Redact marks", () => {
    const doc = openPdf(leakPdf("shared"));
    try {
      const page = doc.findPage(0);
      const pending = doc.addObject({ Type: "Annot", Subtype: "Redact", Rect: [130, 400, 200, 420], OverlayText: doc.newString("in sospeso"), P: page });
      page.get("Annots").push(pending);
      const pendingText = pending.toString();
      redactAreas(mupdf, doc, AREA, "redact");
      const kinds: string[] = [];
      page.get("Annots").forEach((a) => kinds.push(a.get("Subtype").asName()));
      expect(kinds).toEqual(["Widget", "Redact"]); // "fuori", and the pending mark, as it was
      expect(pending.toString()).toBe(pendingText);
      const tree = doc.getTrailer().get("Root", "StructTreeRoot", "ParentTree", "Nums");
      expect(tree.length).toBe(6); // keys 10, 12, 13 (the link, the note, the field) and 22 (the picture no longer drawn) are gone
    } finally {
      doc.destroy();
    }
  });

  it("hands every stream it writes to MuPDF in a Buffer of its own, destroyed (rule 5: a JPEG would wait for the garbage collector)", () => {
    const doc = openPdf(leakPdf("shared"));
    // (spies call through: they only record what each call was given)
    const raw = vi.spyOn(mupdf.PDFObject.prototype, "writeRawStream");
    const spies = [raw, vi.spyOn(mupdf.PDFObject.prototype, "writeStream"), vi.spyOn(mupdf.PDFDocument.prototype, "addStream"), vi.spyOn(mupdf.PDFDocument.prototype, "addRawStream")];
    try {
      redactAreas(mupdf, doc, AREA, "redact");
      expect(raw).toHaveBeenCalled(); // the JPEG written again
      const given = spies.flatMap((s) => s.mock.calls.map((c) => c[0]));
      expect(given.filter((b) => !(b instanceof mupdf.Buffer) || b.pointer !== 0)).toEqual([]);
    } finally {
      spies.forEach((s) => s.mockRestore());
      doc.destroy();
    }
  });
});

describe("Bianchetto", () => {
  it("removes the text and drawings for good, covers the pictures and leaves annotations and fields on top", () => {
    const doc = openPdf(leakPdf("shared"));
    try {
      const picturesBefore = pictureScan(download(doc));
      const { report, formChanged } = redactAreas(mupdf, doc, AREA, "whiteout");
      const out = download(doc);
      expect(leaksIn(out, WHITEOUT_GONE)).toEqual([]);
      expect(missingIn(out, [...WHITEOUT_KEPT, ...LEGIT])).toEqual([]);
      // Pictures are only covered: all their pixels are still in the file.
      expect(pictureScan(out)).toEqual(picturesBefore);
      expect(fieldsOf(out)).toEqual({
        codice: { value: "SEGRETO_CAMPO", widgets: 1 }, nome: { value: "CONDIVISO_CAMPO", widgets: 2 }, fuori: { value: "LEGIT_CAMPO", widgets: 1 },
      });
      expect(formChanged).toBe(false);
      const saved = openPdf(out);
      try {
        const kinds: string[] = [];
        saved.findPage(0).get("Annots").forEach((a) => kinds.push(a.get("Subtype").asName()));
        // The link wholly inside the area goes (MuPDF took it); the FreeText it took comes back.
        expect(kinds.sort()).toEqual(["FreeText", "Highlight", "Popup", "Text", "Text", "Widget", "Widget", "Widget"]);
        // (the covered picture keeps its description)
        expect(pageText(saved, 0).replace("SEGRETO_AT_FORMA", "")).not.toMatch(/SEGRETO|NASCOSTO/);
        // The box is white (where nothing is on top of it: the line art's place).
        expect(otherThan(render(saved, 0), [125, 425, 255, 445], [255, 255, 255])).toBe(0);
      } finally {
        saved.destroy();
      }
      // The note, the field and the picture stay tagged; the forms' references name the copies page 1 draws.
      expect(structureOf(out)).toMatchObject({ objrs: 4, targets: 5, onPage1: true });
      expect(report).toMatchObject({ pictures: 8, fields: ["codice", "nome"], links: 0, linksRemoved: 1, annotations: 3, crossing: false, attachments: 1, growth: 0 });
    } finally {
      doc.destroy();
    }
  });

  it("says the links it removes (wholly inside the area) apart from those it leaves on top", () => {
    const doc = new mupdf.PDFDocument();
    const page = doc.addPage([0, 0, 595, 842], 0, {}, "");
    doc.insertPage(-1, page);
    // (page space: the area is x 100..500, y 200..500) One wholly inside, one across the right edge.
    const link = (rect: number[], uri: string) => doc.addObject({ Type: "Annot", Subtype: "Link", Rect: rect, A: { S: "URI", URI: doc.newString(uri) } });
    doc.findPage(0).put("Annots", [link([150, 400, 250, 420], "https://example.com/SEGRETO_LINK"), link([450, 400, 550, 420], "https://example.com/LEGIT_LINK")]);
    try {
      expect(previewRedaction(mupdf, doc, AREA, "whiteout").pages[0]).toMatchObject({ links: 1, linksRemoved: 1 });
      const black = previewRedaction(mupdf, doc, AREA, "redact").pages[0];
      expect([black.links, black.linksRemoved]).toEqual([2, undefined]); // (Oscura counts them in `links`)
      const { report } = redactAreas(mupdf, doc, AREA, "whiteout");
      expect(report).toMatchObject({ links: 1, linksRemoved: 1 });
      const out = download(doc);
      expect(leaksIn(out, ["SEGRETO_LINK"])).toEqual([]);
      expect(missingIn(out, ["LEGIT_LINK"])).toEqual([]);
    } finally {
      doc.destroy();
    }
  });
});

describe("soft masks: the group of a mask set over the area is redacted as well", () => {
  for (const mode of ["redact", "whiteout"] as const)
    for (const fill of ["inside", "crossing", "form"] as const)
      it(`${mode === "redact" ? "Oscura" : "Bianchetto"}, the masked fill ${fill === "inside" ? "wholly inside the area" : fill === "form" ? "across its edge, in a form" : "across its edge"}`, () => {
        const doc = openPdf(softMaskPdf(fill));
        try {
          const before = snapshot(doc);
          expect(previewRedaction(mupdf, doc, AREA, mode).refused).toBeNull();
          expect(snapshot(doc)).toBe(before);
          const { report } = redactAreas(mupdf, doc, AREA, mode);
          const out = download(doc);
          // (the group is redacted on the page itself for a moment: a replay must make the same file)
          const again = openPdf(softMaskPdf(fill));
          try {
            redactAreas(mupdf, again, AREA, mode);
            const noId = (bytes: Uint8Array) => new TextDecoder("latin1").decode(bytes).replace(/\/ID\s*\[\s*<[0-9A-Fa-f]*>\s*<[0-9A-Fa-f]*>\s*\]/g, "");
            expect(noId(download(again))).toBe(noId(out));
          } finally {
            again.destroy();
          }
          expect(leaksIn(out, ["SEGRETO_MASCHERA"])).toEqual([]);
          expect(missingIn(out, ["LEGIT_FUORI", "LEGIT_PAGINA2"])).toEqual([]);
          expect(report).toMatchObject({ pictures: 1, crossing: fill !== "inside" });
          const saved = openPdf(out);
          try {
            expect(pageText(saved, 0)).not.toContain("SEGRETO");
          } finally {
            saved.destroy();
          }
          const pictures = pictureScan(out);
          // Oscura clears the group's picture under the area; Bianchetto only covers pictures.
          if (mode === "redact") expect(pictures.secretPixels).toBe(0);
          else expect(pictures.secretPixels).toBeGreaterThan(0);
          expect(pictures.legitPixels).toBeGreaterThan(0);
        } finally {
          doc.destroy();
        }
      });
});

describe("soft masks MuPDF never runs: the walk finds them, their group is redacted all the same", () => {
  for (const mode of ["redact", "whiteout"] as const)
    for (const fill of ["hidden", "unpainted"] as const)
      it(`${mode === "redact" ? "Oscura" : "Bianchetto"}, the mask ${fill === "hidden" ? "set in a hidden layer" : "set with nothing painted through it"}`, () => {
        const doc = openPdf(softMaskPdf(fill));
        try {
          const page1 = render(doc, 0), page2 = render(doc, 1);
          redactAreas(mupdf, doc, AREA, mode);
          const out = download(doc);
          expect(leaksIn(out, ["SEGRETO_MASCHERA"])).toEqual([]);
          expect(missingIn(out, ["LEGIT_FUORI", "LEGIT_PAGINA2"])).toEqual([]);
          if (mode === "redact") expect(pictureScan(out).secretPixels).toBe(0);
          const saved = openPdf(out);
          try {
            expect(changedOutside(render(saved, 0), page1, LEAK_AREA)).toBe(0);
            expect(changed(render(saved, 1), page2)).toBe(0);
          } finally {
            saved.destroy();
          }
        } finally {
          doc.destroy();
        }
      });
});

describe("what another page draws another way stays: only what nothing draws loses its references", () => {
  for (const mode of ["redact", "whiteout"] as const)
    it(`a picture's /SMask, a soft mask's group, an /Alternates, a /Thumb (${mode === "redact" ? "Oscura" : "Bianchetto"})`, () => {
      const doc = openPdf(sharedDrawingPdf());
      try {
        const before = render(doc, 1);
        redactAreas(mupdf, doc, AREA, mode);
        const out = download(doc);
        expect(leaksIn(out, ["SEGRETO_VISIBILE"])).toEqual([]);
        const saved = openPdf(out);
        try {
          expect(otherThan(render(saved, 0), LEAK_AREA, mode === "redact" ? [0, 0, 0] : [255, 255, 255])).toBe(0);
          expect(pageText(saved, 0)).toContain("LEGIT_FUORI");
          expect(changed(render(saved, 1), before)).toBe(0);
          const p2 = saved.findPage(1), xobjects = p2.get("Resources", "XObject");
          expect(xobjects.get("P", "SMask").isStream()).toBe(true);
          expect(p2.get("Resources", "ExtGState", "GS", "SMask", "G").isStream()).toBe(true);
          expect(xobjects.get("Q", "Alternates").get(0).get("Image").isStream()).toBe(true);
          expect(p2.get("Thumb").isStream()).toBe(true);
        } finally {
          saved.destroy();
        }
        // The redacted page's tags no longer name the picture it stopped drawing (page 2 still draws it, as a mask).
        if (mode === "redact") {
          expect(structureOf(out).objrs).toBe(0);
          expect(leaksIn(out, ["SEGRETO_ALT_MASCHERA"])).toEqual([]);
        }
      } finally {
        doc.destroy();
      }
    });

  for (const mode of ["redact", "whiteout"] as const)
    it(`what content only lists, and the /Alternates of a picture only the redacted page draws, keep nothing (${mode === "redact" ? "Oscura" : "Bianchetto"})`, () => {
      const doc = openPdf(listedOnlyPdf());
      try {
        const page1 = render(doc, 0), page2 = render(doc, 1);
        redactAreas(mupdf, doc, AREA, mode);
        const out = download(doc);
        // (Bianchetto only covers the pictures: page 1 still draws them, under the box)
        expect(leaksIn(out, mode === "redact" ? ["SEGRETO_GRUPPO", "SEGRETO_ALTERNATIVA", "SEGRETO_MASCHERA_ELENCATA"] : ["SEGRETO_GRUPPO"])).toEqual([]);
        const saved = openPdf(out);
        try {
          expect(changedOutside(render(saved, 0), page1, LEAK_AREA)).toBe(0);
          expect(changed(render(saved, 1), page2)).toBe(0);
          expect(pageText(saved, 0)).toContain("LEGIT_FUORI");
          expect(pageText(saved, 1)).toContain("LEGIT_PAGINA2");
        } finally {
          saved.destroy();
        }
      } finally {
        doc.destroy();
      }
    });
});

describe("what nothing draws keeps nothing: content only listed, a glyph never shown, the fields' resources", () => {
  const never: Holder[] = [
    "form", "pattern", "mask", "type3", "nested", "bare mask", "unshown glyph", "fields", "listed group", "unpainted pattern", "unpainted stroke pattern",
    "pattern nothing paints with", "pattern at a form's end",
  ];
  for (const mode of ["redact", "whiteout"] as const)
    for (const holder of [...never, "shown glyph", "set mask", "painted pattern", "pattern a Type 3 glyph fills", "pattern a Type 3 glyph strokes"] as Holder[])
      it(`${holder}: ${never.includes(holder) ? "the originals leave the file" : "drawn on page 2, they stay"} (${mode === "redact" ? "Oscura" : "Bianchetto"})`, () => {
        const doc = openPdf(unusedHolderPdf(holder));
        try {
          const page1 = render(doc, 0), page2 = render(doc, 1);
          redactAreas(mupdf, doc, AREA, mode);
          const out = download(doc);
          // (Bianchetto only covers the picture: page 1 still draws it, under the box)
          const secrets = mode === "redact" ? ["SEGRETO_ELENCO_TESTO", "SEGRETO_ELENCO_FOTO"] : ["SEGRETO_ELENCO_TESTO"];
          if (never.includes(holder)) expect(leaksIn(out, secrets)).toEqual([]);
          else expect(missingIn(out, secrets)).toEqual([]);
          const saved = openPdf(out);
          try {
            expect(changedOutside(render(saved, 0), page1, LEAK_AREA)).toBe(0);
            expect(changed(render(saved, 1), page2)).toBe(0);
            expect(pageText(saved, 0)).toContain("LEGIT_FUORI");
            expect(pageText(saved, 1)).toContain("LEGIT_PAGINA2");
          } finally {
            saved.destroy();
          }
        } finally {
          doc.destroy();
        }
      });
});

describe("descriptions the structure holds where the ParentTree does not say: they go all the same", () => {
  // [how, what both modes remove, what Oscura removes too (a picture's, an annotation's: Bianchetto leaves those)]
  const cases: [Tagging, string[], string[]][] = [
    ["form without parents", ["SEGRETO_AT_SENZA_SP"], ["SEGRETO_ALT_SENZA_SP"]],
    ["form without parents in a form with them", ["SEGRETO_AT_FORMA_ESTERNA"], []],
    ["wrong limits", ["SEGRETO_AT_LIMITI"], []],
    ["not in the parent tree", ["SEGRETO_AT_SENZA_PT"], []],
    ["untagged annotations", ["SEGRETO_ALT_LINK_SENZA_SP"], ["SEGRETO_ALT_CAMPO_SENZA_SP"]],
    ["inline picture in a form", [], ["SEGRETO_ALT_INLINE_FORMA"]],
  ];
  for (const mode of ["redact", "whiteout"] as const)
    for (const [how, both, oscura] of cases)
      it(`${how} (${mode === "redact" ? "Oscura" : "Bianchetto"})`, () => {
        const doc = openPdf(taggedPdf(how));
        try {
          redactAreas(mupdf, doc, AREA, mode);
          const out = download(doc);
          expect(leaksIn(out, [...both, ...(mode === "redact" ? oscura : [])])).toEqual([]);
          if (mode === "whiteout") expect(missingIn(out, oscura)).toEqual([]);
          expect(missingIn(out, ["LEGIT_ALT", "LEGIT_FUORI"])).toEqual([]);
        } finally {
          doc.destroy();
        }
      });
});

describe("forms without resources of their own (PDF 1.1: they draw with those of the content that draws them)", () => {
  for (const drawn of ["picture", "nested form", "graphics state", "pattern", "shading"] as const) {
    for (const mode of ["redact", "whiteout"] as const)
      it(`what such a form draws outside the area stays (${drawn}, ${mode === "redact" ? "Oscura" : "Bianchetto"})`, () => {
        const doc = openPdf(resourcelessPdf(drawn, "form"));
        try {
          const before = render(doc, 0);
          redactAreas(mupdf, doc, AREA, mode);
          const out = download(doc);
          expect(leaksIn(out, ["SEGRETO_SENZA_RISORSE"])).toEqual([]);
          expect(missingIn(out, ["LEGIT_FUORI"])).toEqual([]);
          const saved = openPdf(out);
          try {
            expect(changedOutside(render(saved, 0), before, LEAK_AREA)).toBe(0);
          } finally {
            saved.destroy();
          }
        } finally {
          doc.destroy();
        }
      });

    // (MuPDF does not copy a soft mask's group: it would lose what it names from the page's new resources)
    it(`a soft mask's group without resources of its own that names some is refused, nothing changed (${drawn})`, () => {
      const doc = openPdf(resourcelessPdf(drawn, "mask group"));
      try {
        const before = snapshot(doc);
        expect(previewRedaction(mupdf, doc, AREA, "redact").refused).toEqual({ reason: "locked", pageIndex: 0 });
        expect(() => redactAreas(mupdf, doc, AREA, "whiteout")).toThrow(expect.objectContaining({ refusal: "locked", changed: false }));
        expect(snapshot(doc)).toBe(before);
      } finally {
        doc.destroy();
      }
    });
  }

  // (a gradient as Chrome, Word and LibreOffice write it: a shading pattern is a dictionary, with no content to name anything)
  for (const used of ["outside the area", "under it", "listed only"] as const)
    for (const mode of ["redact", "whiteout"] as const)
      it(`a shading pattern (PatternType 2) ${used} is no reason to refuse (${mode === "redact" ? "Oscura" : "Bianchetto"})`, () => {
        const doc = new mupdf.PDFDocument();
        try {
          const helv = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" });
          const shading = doc.addObject({ ShadingType: 2, ColorSpace: "DeviceRGB", Coords: [0, 0, 100, 0], Function: { FunctionType: 2, Domain: [0, 1], C0: [1, 0, 0], C1: [0, 0, 1], N: 1 }, Extend: [true, true] });
          const fill = { "outside the area": "q /Pattern cs /P0 scn 50 700 100 50 re f Q", "under it": "q /Pattern cs /P0 scn 150 450 100 50 re f Q", "listed only": "" }[used];
          const res = { Font: { F1: helv }, Pattern: { P0: doc.addObject({ Type: "Pattern", PatternType: 2, Shading: shading, Matrix: [1, 0, 0, 1, 50, 700] }) } };
          doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, res, `BT /F1 12 Tf 120 760 Td (LEGIT_FUORI) Tj ET ${fill} BT /F1 12 Tf 150 500 Td (SEGRETO_SFUMATURA) Tj ET`));
          const before = render(doc, 0);
          expect(previewRedaction(mupdf, doc, AREA, mode).refused).toBeNull();
          redactAreas(mupdf, doc, AREA, mode);
          const out = download(doc);
          expect(leaksIn(out, ["SEGRETO_SFUMATURA"])).toEqual([]);
          expect(missingIn(out, ["LEGIT_FUORI"])).toEqual([]);
          const saved = openPdf(out);
          try {
            expect(changedOutside(render(saved, 0), before, LEAK_AREA)).toBe(0);
          } finally {
            saved.destroy();
          }
        } finally {
          doc.destroy();
        }
      });
});

describe("annotations and signatures: what hangs elsewhere goes with them", () => {
  const secrets = ["SEGRETO_NOTA_SENZA_POPUP", "SEGRETO_POPUP_PROPRIO", "SEGRETO_POPUP_ALTROVE", "SEGRETO_NOME_FIRMA", "SEGRETO_CERT_FIRMATARIO"];
  it("Oscura: a popup naming its note by /Parent alone leaves with it, on another page too; the signer's certificate leaves /DSS", () => {
    const doc = openPdf(annotatedPdf());
    try {
      redactAreas(mupdf, doc, AREA, "redact");
      const out = download(doc);
      expect(leaksIn(out, secrets)).toEqual([]);
      expect(missingIn(out, ["LEGIT_FUORI", "LEGIT_PAGINA2"])).toEqual([]);
    } finally {
      doc.destroy();
    }
  });

  it("Bianchetto leaves the note, its popup and the signature on top, the /DSS with them", () => {
    const doc = openPdf(annotatedPdf());
    try {
      redactAreas(mupdf, doc, AREA, "whiteout");
      expect(missingIn(download(doc), [...secrets, "LEGIT_FUORI"])).toEqual([]);
    } finally {
      doc.destroy();
    }
  });
});

describe("refusals: nothing changes", () => {
  const refused = (bytes: Uint8Array, mode: "redact" | "whiteout", reason: string) => {
    const doc = openPdf(bytes);
    try {
      const before = snapshot(doc);
      const preview = previewRedaction(mupdf, doc, AREA, mode);
      expect(preview.refused).toEqual({ reason, pageIndex: 0 });
      let error: unknown = null;
      try {
        redactAreas(mupdf, doc, AREA, mode);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(RedactError);
      // (found before any change: the session keeps its document as it is, no rebuild)
      expect(error).toMatchObject({ code: "not-editable", refusal: reason, pageIndex: 0, changed: false });
      expect(snapshot(doc)).toBe(before);
    } finally {
      doc.destroy();
    }
  };

  it("a Separation picture under the area (Oscura); Bianchetto covers it", () => {
    refused(separationPdf(), "redact", "separation");
    const doc = openPdf(separationPdf());
    try {
      redactAreas(mupdf, doc, AREA, "whiteout");
      expect(leaksIn(download(doc), ["SEGRETO_VISIBILE"])).toEqual([]);
    } finally {
      doc.destroy();
    }
  });

  it("a picture too large to clear", () => {
    expect(MAX_REDACT_PIXELS).toBe(50_000_000);
    refused(bigPicturePdf(7100, 7100), "redact", "too-big");
    const doc = openPdf(bigPicturePdf(7000, 7000)); // 49 million: allowed (checked only)
    try {
      expect(previewRedaction(mupdf, doc, AREA, "redact").refused).toBeNull();
    } finally {
      doc.destroy();
    }
  });

  it("resources shared with a page whose drawing cannot be read for sure", () => {
    refused(unsurePdf(), "redact", "shared");
    refused(unsurePdf(), "whiteout", "shared");
  });

  it("content that cannot take the box", () => {
    const doc = new mupdf.PDFDocument();
    const helv = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica" });
    doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { Font: { F1: helv } }, "BT /F1 12 Tf 120 620 Td (SEGRETO) Tj ET (aperta"));
    const bytes = new Uint8Array(doc.saveToBuffer("compress=no").asUint8Array());
    doc.destroy();
    refused(bytes, "redact", "locked");
  });

  it("a soft mask set twice over the area under different CTMs: one redacted group cannot serve both", () => {
    refused(softMaskPdf("twice"), "redact", "locked");
    refused(softMaskPdf("twice"), "whiteout", "locked");
    // (its group's box reaches the area, and the group draws there: hidden, invisible, through a mask of its own, a gradient)
    for (const under of ["text", "hidden text", "invisible text", "nested mask", "gradient", "clipped gradient"] as const)
      for (const mode of ["redact", "whiteout"] as const) refused(reusedMaskPdf(under), mode, "locked");
  });

  for (const mode of ["redact", "whiteout"] as const)
    it(`a soft mask set twice whose group draws nothing under the area is left alone, not refused (a reused shadow, ${mode === "redact" ? "Oscura" : "Bianchetto"})`, () => {
      const doc = openPdf(reusedMaskPdf("nothing"));
      try {
        const before = render(doc, 0);
        expect(previewRedaction(mupdf, doc, AREA, mode).refused).toBeNull();
        redactAreas(mupdf, doc, AREA, mode);
        const out = download(doc);
        expect(leaksIn(out, ["SEGRETO_VISIBILE"])).toEqual([]);
        expect(missingIn(out, ["LEGIT_FUORI"])).toEqual([]);
        const saved = openPdf(out);
        try {
          expect(changedOutside(render(saved, 0), before, LEAK_AREA)).toBe(0);
        } finally {
          saved.destroy();
        }
      } finally {
        doc.destroy();
      }
    });

  it("found only after the change (a page elsewhere, unreadable, lists the font that went): `changed`, for the rollback", () => {
    // Pages 1 and 2 list one font in resources of their own; page 2 has a stamp whose appearance
    // (drawn with the page's resources) MuPDF cannot decode. The checks read only what shares page
    // 1's dictionaries; the cleanup after the change looks for the font page 1 no longer draws.
    const doc = new mupdf.PDFDocument();
    const helv = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica" });
    doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { Font: { F1: helv } }, "BT /F1 12 Tf 120 620 Td (SEGRETO) Tj ET"));
    doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { Font: { F1: helv } }, "BT /F1 12 Tf 120 760 Td (LEGIT) Tj ET"));
    const buf = new mupdf.Buffer(new Uint8Array(64).fill(0x41));
    const ap = doc.addRawStream(buf, { Type: "XObject", Subtype: "Form", BBox: [0, 0, 10, 10], Filter: "FlateDecode", DecodeParms: { Predictor: 12, Colors: 100, Columns: 1 } });
    buf.destroy();
    doc.findPage(1).put("Annots", [doc.addObject({ Type: "Annot", Subtype: "Stamp", Rect: [400, 400, 410, 410], F: 4, AP: { N: ap } })]);
    try {
      expect(previewRedaction(mupdf, doc, AREA, "redact").refused).toBeNull();
      const before = snapshot(doc);
      let error: unknown = null;
      try {
        redactAreas(mupdf, doc, AREA, "redact");
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(RedactError);
      expect(error).toMatchObject({ code: "not-editable", refusal: "shared", pageIndex: 0, changed: true });
      expect(snapshot(doc)).not.toBe(before);
    } finally {
      doc.destroy();
    }
  });

  it("found only after the change (an unreadable page alone could still draw what went, as the mask of a picture it lists)", () => {
    // Page 1 draws picture M wholly under the area; page 2 lists a picture whose /SMask is M, and
    // has a stamp whose appearance (drawn with the page's resources) MuPDF cannot decode.
    const doc = new mupdf.PDFDocument();
    const grey = (fill: number) => {
      const buf = new mupdf.Buffer(new Uint8Array(400).fill(fill));
      try {
        return doc.addStream(buf, { Type: "XObject", Subtype: "Image", Width: 20, Height: 20, ColorSpace: "DeviceGray", BitsPerComponent: 8 });
      } finally {
        buf.destroy();
      }
    };
    const mask = grey(128), listed = grey(60);
    listed.put("SMask", mask);
    doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { XObject: { M: mask } }, "q 40 0 0 40 150 420 cm /M Do Q"));
    doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { XObject: { P: listed } }, "0 0 1 rg 10 10 50 50 re f"));
    const buf = new mupdf.Buffer(new Uint8Array(64).fill(0x41));
    const ap = doc.addRawStream(buf, { Type: "XObject", Subtype: "Form", BBox: [0, 0, 10, 10], Filter: "FlateDecode", DecodeParms: { Predictor: 12, Colors: 100, Columns: 1 } });
    buf.destroy();
    doc.findPage(1).put("Annots", [doc.addObject({ Type: "Annot", Subtype: "Stamp", Rect: [400, 400, 410, 410], F: 4, AP: { N: ap } })]);
    try {
      expect(previewRedaction(mupdf, doc, AREA, "redact").refused).toBeNull();
      expect(() => redactAreas(mupdf, doc, AREA, "redact")).toThrow(expect.objectContaining({ refusal: "shared", pageIndex: 0, changed: true }));
    } finally {
      doc.destroy();
    }
  });

  it("names the page whose resources the unreadable page shares, not the first of the request (before the change, and after it)", () => {
    // Pages 1 and 2 redacted; page 3, whose stamp MuPDF cannot decode, shares page 2's /Resources
    // (found by the checks), or lists the font only page 2's text used (found after the change).
    for (const shares of [true, false]) {
      const doc = new mupdf.PDFDocument();
      const helv = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica" });
      const courier = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Courier" });
      const res = doc.addObject({ Font: { F1: courier } });
      doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { Font: { F1: helv } }, "BT /F1 12 Tf 120 620 Td (SEGRETO) Tj ET"));
      doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, shares ? res : { Font: { F1: courier } }, "BT /F1 12 Tf 120 620 Td (SEGRETO) Tj ET"));
      doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, shares ? res : { Font: { F1: courier } }, "BT /F1 12 Tf 120 760 Td (LEGIT) Tj ET"));
      const buf = new mupdf.Buffer(new Uint8Array(64).fill(0x41));
      const ap = doc.addRawStream(buf, { Type: "XObject", Subtype: "Form", BBox: [0, 0, 10, 10], Filter: "FlateDecode", DecodeParms: { Predictor: 12, Colors: 100, Columns: 1 } });
      buf.destroy();
      doc.findPage(2).put("Annots", [doc.addObject({ Type: "Annot", Subtype: "Stamp", Rect: [400, 400, 410, 410], F: 4, AP: { N: ap } })]);
      const areas: RedactArea[] = [{ pageIndex: 0, rects: [LEAK_AREA] }, { pageIndex: 1, rects: [LEAK_AREA] }];
      try {
        expect(previewRedaction(mupdf, doc, areas, "redact").refused).toEqual(shares ? { reason: "shared", pageIndex: 1 } : null);
        expect(() => redactAreas(mupdf, doc, areas, "redact")).toThrow(expect.objectContaining({ refusal: "shared", pageIndex: 1, changed: !shares }));
      } finally {
        doc.destroy();
      }
    }
  });
});

describe("the request", () => {
  it("areas out of bounds are bad requests; areas outside the page do nothing", () => {
    const doc = openPdf(leakPdf("own"));
    try {
      const before = snapshot(doc);
      for (const areas of [
        [], [{ pageIndex: 3, rects: [LEAK_AREA] }], [{ pageIndex: -1, rects: [LEAK_AREA] }], [{ pageIndex: 0.5, rects: [LEAK_AREA] }],
        [{ pageIndex: 0, rects: [[0, 0, NaN, 10]] }], [{ pageIndex: 0, rects: [[0, 0, 10]] }], [{ pageIndex: 0 }],
        [{ pageIndex: 0, rects: Array.from({ length: MAX_REDACT_RECTS + 1 }, (_, i) => [i % 500, 10, (i % 500) + 1, 20]) }],
        [{ pageIndex: 0, rects: [[700, 900, 800, 1000]] }],
      ] as unknown as RedactArea[][]) {
        expect(() => redactAreas(mupdf, doc, areas, "redact"), JSON.stringify(areas).slice(0, 60)).toThrow(RedactError);
        // (found before any change: the session keeps its document as it is, no rebuild)
        expect(() => redactAreas(mupdf, doc, areas, "redact")).toThrow(expect.objectContaining({ code: "bad-request", changed: false }));
        expect(() => previewRedaction(mupdf, doc, areas, "redact")).toThrow(expect.objectContaining({ code: "bad-request" }));
      }
      expect(snapshot(doc)).toBe(before);
    } finally {
      doc.destroy();
    }
  });

  it("the preview tells what the edit then does, and changes nothing", () => {
    const doc = openPdf(leakPdf("shared"));
    try {
      const before = snapshot(doc);
      const preview = previewRedaction(mupdf, doc, AREA, "redact");
      expect(snapshot(doc)).toBe(before);
      expect(preview.attachments).toBe(1);
      expect(preview.refused).toBeNull();
      const { report } = redactAreas(mupdf, doc, AREA, "redact");
      const { pageIndex, ...facts } = preview.pages[0];
      expect(pageIndex).toBe(0);
      expect(facts).toEqual({ text: report.text, pictures: report.pictures, fields: report.fields, links: report.links, annotations: report.annotations, crossing: report.crossing });
    } finally {
      doc.destroy();
    }
  });

  it("is deterministic: two copies give the same file (but /ID)", () => {
    const bytes = leakPdf("shared");
    const run = () => {
      const doc = openPdf(bytes);
      try {
        redactAreas(mupdf, doc, AREA, "redact");
        redactAreas(mupdf, doc, [{ pageIndex: 2, rects: [[100, 60, 300, 100]] }], "whiteout");
        return new TextDecoder("latin1").decode(download(doc)).replace(/\/ID\s*\[\s*<[0-9A-Fa-f]*>\s*<[0-9A-Fa-f]*>\s*\]/g, "");
      } finally {
        doc.destroy();
      }
    };
    expect(run()).toBe(run());
  });

  it("several pages in one edit; a field whose widgets all go leaves whole", () => {
    const doc = openPdf(leakPdf("shared"));
    try {
      const { report } = redactAreas(mupdf, doc, [{ pageIndex: 0, rects: [LEAK_AREA] }, { pageIndex: 1, rects: [[100, 100, 300, 160]] }], "redact");
      const out = download(doc);
      expect(report.fieldsElsewhere).toEqual([]);
      expect(Object.keys(fieldsOf(out))).toEqual(["fuori"]);
      expect(leaksIn(out, ["CONDIVISO_CAMPO"])).toEqual([]);
      expect(missingIn(out, ["LEGIT_PAGINA2", "LEGIT_CAMPO"])).toEqual([]);
    } finally {
      doc.destroy();
    }
  });

  it("the document's XMP in UTF-16 (either byte order) loses its pictures as well, its text stays", () => {
    const xmp = '﻿<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
      + '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator><rdf:Seq><rdf:li>LEGIT_XMP</rdf:li></rdf:Seq></dc:creator></rdf:Description>'
      + '<rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:xmpGImg="http://ns.adobe.com/xap/1.0/g/img/"><xmp:Thumbnails><rdf:Alt><rdf:li rdf:parseType="Resource">'
      + "<xmpGImg:image>SEGRETOMINIATURA</xmpGImg:image></rdf:li></rdf:Alt></xmp:Thumbnails></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end=\"w\"?>";
    for (const le of [false, true]) {
      const bytes = new Uint8Array(xmp.length * 2);
      for (let i = 0; i < xmp.length; i++) bytes.set(le ? [xmp.charCodeAt(i) & 255, xmp.charCodeAt(i) >> 8] : [xmp.charCodeAt(i) >> 8, xmp.charCodeAt(i) & 255], 2 * i);
      const doc = new mupdf.PDFDocument();
      try {
        const helv = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica" });
        doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { Font: { F1: helv } }, "BT /F1 12 Tf 150 500 Td (SEGRETO_VISIBILE) Tj ET"));
        const buf = new mupdf.Buffer(bytes);
        try {
          doc.getTrailer().get("Root").put("Metadata", doc.addStream(buf, { Type: "Metadata", Subtype: "XML" }));
        } finally {
          buf.destroy();
        }
        redactAreas(mupdf, doc, AREA, "whiteout");
        const saved = openPdf(download(doc));
        try {
          const data = saved.getTrailer().get("Root", "Metadata").readStream();
          try {
            const text = new TextDecoder(le ? "utf-16le" : "utf-16be").decode(data.asUint8Array());
            expect(text).not.toContain("SEGRETOMINIATURA");
            expect(text).toContain("<rdf:li>LEGIT_XMP</rdf:li>");
          } finally {
            data.destroy();
          }
        } finally {
          saved.destroy();
        }
      } finally {
        doc.destroy();
      }
    }
  });

  it("counts the attached files wherever they hang (a form's and a page's /AF, the catalog's), each once", () => {
    const doc = new mupdf.PDFDocument();
    const helv = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica" });
    const file = (text: string) => {
      const buf = new mupdf.Buffer(text);
      try {
        return doc.addStream(buf, { Type: "EmbeddedFile", Subtype: "text/csv" });
      } finally {
        buf.destroy();
      }
    };
    // A chart's source data on the form under the area (a direct file specification), another on the page.
    const source = doc.newDictionary();
    source.put("Type", doc.newName("Filespec"));
    source.put("F", doc.newString("dati.csv"));
    source.put("AFRelationship", doc.newName("Source"));
    source.put("EF", { F: file("Mario,SEGRETO_AFDATA") });
    const buf = new mupdf.Buffer("BT /F1 12 Tf 120 600 Td (SEGRETO_GRAFICO) Tj ET");
    const chart = doc.addStream(buf, { Type: "XObject", Subtype: "Form", BBox: [0, 0, 595, 842], Resources: { Font: { F1: helv } }, AF: [source] });
    buf.destroy();
    doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { XObject: { Fx: chart } }, "/Fx Do"));
    const page = doc.addObject({ Type: "Filespec", F: doc.newString("pagina.csv"), EF: { F: file("SEGRETO_PAGEAF") } });
    doc.findPage(0).put("AF", [page]);
    // One in /EmbeddedFiles that a FileAttachment annotation shows too: one file.
    const spec = doc.addEmbeddedFile("allegato.txt", "text/plain", "LEGIT_ALLEGATO", new Date(0), new Date(0));
    doc.insertEmbeddedFile("allegato.txt", spec);
    doc.findPage(0).put("Annots", [doc.addObject({ Type: "Annot", Subtype: "FileAttachment", Rect: [500, 50, 520, 70], FS: spec })]);
    try {
      expect(previewRedaction(mupdf, doc, AREA, "redact").attachments).toBe(3);
      const { report } = redactAreas(mupdf, doc, AREA, "redact");
      expect(report.attachments).toBe(3); // (the form MuPDF copied keeps its /AF: the file stays, said)
      expect(missingIn(download(doc), ["SEGRETO_AFDATA", "SEGRETO_PAGEAF", "LEGIT_ALLEGATO"])).toEqual([]);
    } finally {
      doc.destroy();
    }
  });

  it("a pattern fill across the area is a crossing drawing (its area taken from pattern space to the page)", () => {
    const pattern = (fill: string) => {
      const doc = new mupdf.PDFDocument();
      const helv = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica" });
      const buf = new mupdf.Buffer("BT /F1 6 Tf 0 2 Td (SEGRETO_CELLA) Tj ET");
      const pat = doc.addStream(buf, { Type: "Pattern", PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 60, 10], XStep: 60, YStep: 10, Resources: { Font: { F1: helv } } });
      buf.destroy();
      doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { Pattern: { P1: pat } }, `q /Pattern cs /P1 scn ${fill} re f Q`));
      return doc;
    };
    // (page space: the area is y 200..500) Across its top edge (y 142..242); wholly below it (y 592..692),
    // where the fill's user space, y up, would meet the area.
    for (const [fill, crossing] of [["120 600 200 100", true], ["120 150 200 100", false]] as const) {
      const doc = pattern(fill);
      try {
        for (const mode of ["redact", "whiteout"] as const) expect(previewRedaction(mupdf, doc, AREA, mode).pages[0].crossing, `${fill} ${mode}`).toBe(crossing);
        expect(redactAreas(mupdf, doc, AREA, "redact").report.crossing).toBe(crossing);
      } finally {
        doc.destroy();
      }
    }
  });

  it("a drawing of several shapes crosses the edge only where one of them does; the app's own boxes never do", () => {
    // A grid drawn as one path (page space: the area is y 200..500): its shapes lie above and below the area, or one crosses it.
    for (const [path, crossing] of [["120 100 50 30 re 120 700 50 30 re", false], ["120 100 50 30 re 120 320 50 30 re", true]] as const) {
      const doc = new mupdf.PDFDocument();
      doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, {}, `0 0 1 rg ${path} f`));
      try {
        expect(previewRedaction(mupdf, doc, AREA, "redact").pages[0].crossing, path).toBe(crossing);
      } finally {
        doc.destroy();
      }
    }
    // An earlier edit's box over two lines (one shape each), then an area between them, and one over half of the first box.
    const doc = openPdf(fixture("search-chrome-it.pdf"));
    try {
      const between: RedactArea[] = [{ pageIndex: 0, rects: [[62, 123, 201, 132]] }];
      expect(previewRedaction(mupdf, doc, between, "redact").pages[0].crossing).toBe(false);
      redactAreas(mupdf, doc, [{ pageIndex: 0, rects: [[62, 70, 110, 78], [380, 180, 430, 188]] }], "redact");
      expect(previewRedaction(mupdf, doc, between, "redact").pages[0].crossing).toBe(false);
      expect(previewRedaction(mupdf, doc, [{ pageIndex: 0, rects: [[85, 60, 140, 90]] }], "whiteout").pages[0].crossing).toBe(false);
    } finally {
      doc.destroy();
    }
  });
});

/** A page of three lines of 12 pt Helvetica `spacing` apart, the middle one "Nome: Mario Rossi, via Roma". */
function linesPdf(spacing: number, font = "Helvetica"): Uint8Array {
  const doc = new mupdf.PDFDocument();
  try {
    const f = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: font, Encoding: "WinAnsiEncoding" });
    const lines = ["ABCDEFGHIJKLMNOP", "Nome: Mario Rossi, via Roma", "abcdefghijklmnopqrst"];
    const content = lines.map((l, i) => `BT /F1 12 Tf 72 ${700 - i * spacing} Td (${l}) Tj ET`).join("\n");
    doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { Font: { F1: f } }, content));
    const buf = doc.saveToBuffer("compress=no");
    try {
      return buf.asUint8Array().slice();
    } finally {
      buf.destroy();
    }
  } finally {
    doc.destroy();
  }
}

/** Three lines of 12 pt Helvetica `spacing` apart, turned `angle`° about the page's middle (a skewed scan's text layer, a rotated label), the middle one holding SEGRETOLUNGOSEGRETO. */
function turnedLinesPdf(angle: number, spacing: number): Uint8Array {
  const doc = new mupdf.PDFDocument();
  try {
    const f = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" });
    const a = (angle * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    const tm = [c, s, -s, c, 300 - 120 * c, 421 - 120 * s].map((v) => v.toFixed(5)).join(" ");
    const lines = ["Prima riga AAAAAAAAAAAAAAAAAAAA fine", "Mario Rossi codice SEGRETOLUNGOSEGRETO qui", "Terza riga BBBBBBBBBBBBBBBBBBBB fine"];
    doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { Font: { F1: f } }, `BT /F1 12 Tf ${tm} Tm ${spacing} TL ${lines.map((l) => `(${l}) Tj T*`).join(" ")} ET`));
    const buf = doc.saveToBuffer("compress=no");
    try {
      return buf.asUint8Array().slice();
    } finally {
      buf.destroy();
    }
  } finally {
    doc.destroy();
  }
}

function hitQuads(doc: Doc, needle: string): Quad[] {
  const page = doc.loadPage(0);
  try {
    return page.search(needle, 10)[0] as unknown as Quad[];
  } finally {
    page.destroy();
  }
}

describe("damage: only what is under the area goes", () => {
  for (const [spacing, font] of [[12, "Helvetica"], [14.4, "Helvetica"], [13.8, "Times-Roman"]] as const)
    it(`a search hit's areas take the hit and nothing of the lines around it (${font}, ${spacing} pt)`, () => {
      const doc = openPdf(linesPdf(spacing, font));
      try {
        const quads = hitQuads(doc, "Rossi");
        // A hit's boxes as they are would take letters from the lines above and below (research §critic B).
        const raw = openPdf(linesPdf(spacing, font));
        try {
          rawRedaction(raw, 0, quads.map((q) => [q[0], q[1], q[6], q[7]] as Rect), 0);
          expect(flatText(raw, 0)).not.toBe("ABCDEFGHIJKLMNOP Nome: Mario , via Roma abcdefghijklmnopqrst");
        } finally {
          raw.destroy();
        }
        redactAreas(mupdf, doc, [{ pageIndex: 0, rects: areasForQuads(quads) }], "redact");
        expect(flatText(doc, 0)).toBe("ABCDEFGHIJKLMNOP Nome: Mario , via Roma abcdefghijklmnopqrst");
      } finally {
        doc.destroy();
      }
    });

  for (const [angle, spacing] of [[2, 14.4], [5, 12], [15, 12], [25, 14.4], [45, 14.4]] as const)
    it(`a search hit on a line turned ${angle}° takes the hit and nothing of the lines beside it (${spacing} pt)`, () => {
      const doc = openPdf(turnedLinesPdf(angle, spacing));
      try {
        redactAreas(mupdf, doc, [{ pageIndex: 0, rects: areasForQuads(hitQuads(doc, "SEGRETOLUNGOSEGRETO")) }], "redact");
        const text = flatText(doc, 0);
        // (from about 30°, the letter beside the hit on its own line can go too: redactGeometry.ts)
        if (angle < 30) expect(text).toBe("Prima riga AAAAAAAAAAAAAAAAAAAA fine Mario Rossi codice qui Terza riga BBBBBBBBBBBBBBBBBBBB fine");
        else {
          expect(text).toMatch(/^Prima riga AAAAAAAAAAAAAAAAAAAA fine Mario Rossi codic?e? q?ui Terza riga BBBBBBBBBBBBBBBBBBBB fine$/);
        }
      } finally {
        doc.destroy();
      }
    });

  it("a line's quads make a box over that line alone", () => {
    const doc = openPdf(linesPdf(12));
    try {
      const page = doc.loadPage(0);
      const quads: Quad[] = [];
      try {
        const st = page.toStructuredText("preserve-whitespace");
        let line = -1;
        st.walk({ beginLine() { line++; }, onChar(_c, _o, font, _s, quad) { font.destroy(); if (line === 1) quads.push(quad as Quad); } });
        st.destroy();
      } finally {
        page.destroy();
      }
      const box = [Math.min(...quads.map((q) => q[0])), quads[0][1], Math.max(...quads.map((q) => q[2])), quads[0][5]];
      redactAreas(mupdf, doc, [{ pageIndex: 0, rects: areasForQuads([[box[0], box[1], box[2], box[1], box[0], box[3], box[2], box[3]]]) }], "whiteout");
      expect(flatText(doc, 0)).toBe("ABCDEFGHIJKLMNOP abcdefghijklmnopqrst");
    } finally {
      doc.destroy();
    }
  });

  for (const mode of ["whiteout", "redact"] as const)
    it(`a line taken off a Chrome-made page leaves the other lines' ligatures as they were (${mode})`, () => {
      // Chrome writes /Span <</ActualText (ti)>> BDC around each ligature glyph; MuPDF drops the one
      // it empties, so the sequences before and after do not pair one for one.
      const doc = openPdf(fixture("chrome-subset.pdf"));
      try {
        const before = flatText(doc, 0);
        redactAreas(mupdf, doc, [{ pageIndex: 0, rects: [[63.5, 81.7, 293.1, 96.4]] }], mode);
        const after = flatText(doc, 0);
        expect(before).toContain("Preventivo");
        expect(after).not.toContain("Preventivo");
        for (const word of ["città", "resti"]) {
          expect(before).toContain(word);
          expect(after).toContain(word);
        }
      } finally {
        doc.destroy();
      }
    });

  for (const mode of ["whiteout", "redact"] as const)
    it(`a span emptied under the area is not taken for the next one alike but for its glyph: that one keeps its /ActualText (${mode})`, () => {
      // Two ligature spans as Chrome writes them, with the same /ActualText: MuPDF drops the first
      // (under the area, user y 342..642), the second (above it) is the one left.
      const doc = new mupdf.PDFDocument();
      const helv = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica" });
      doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { Font: { F1: helv } }, [
        "BT /F1 12 Tf 120 600 Td (Pre) Tj /Span <</ActualText (ti)>> BDC (X) Tj EMC ET",
        "BT /F1 12 Tf 120 760 Td (res) Tj /Span <</ActualText (ti)>> BDC (Y) Tj EMC ET",
      ].join("\n")));
      try {
        redactAreas(mupdf, doc, AREA, mode);
        const content = pageContent(doc, 0);
        expect(content.match(/ActualText/g) ?? []).toHaveLength(1);
        expect(content).toMatch(/\/ActualText\s*\(ti\)\s*>>\s*BDC\s*\(Y\)/);
      } finally {
        doc.destroy();
      }
    });

  for (const mode of ["whiteout", "redact"] as const)
    it(`a span partly under the area is not taken for a dropped one alike that showed what is left: its /ActualText goes (${mode})`, () => {
      // Two spans with one /ActualText: one shows X above the area and SY under it, the other X
      // under it alone. MuPDF drops the second and takes SY from the first, which then shows what the
      // second showed: either can be the one left, in either order. A span outside keeps its own.
      const partial = "BT /F1 12 Tf 120 760 Td (res) Tj /Span <</ActualText (SEGRETO_DESCRITTO)>> BDC (X) Tj 0 -160 Td (SY) Tj EMC ET";
      const dropped = "BT /F1 12 Tf 120 600 Td (Pre) Tj /Span <</ActualText (SEGRETO_DESCRITTO)>> BDC (X) Tj EMC ET";
      const outside = "BT /F1 12 Tf 120 780 Td /Span <</ActualText (LEGIT_DESCRITTO)>> BDC (Z) Tj EMC ET";
      for (const content of [[partial, dropped, outside], [dropped, partial, outside]]) {
        const doc = new mupdf.PDFDocument();
        const helv = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica" });
        doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { Font: { F1: helv } }, content.join("\n")));
        try {
          redactAreas(mupdf, doc, AREA, mode);
          const out = download(doc);
          expect(leaksIn(out, ["SEGRETO_DESCRITTO"])).toEqual([]);
          expect(missingIn(out, ["LEGIT_DESCRITTO"])).toEqual([]);
          expect(flatText(doc, 0)).toContain("resX");
        } finally {
          doc.destroy();
        }
      }
    });

  it("a rotated page: the area is in page space, the box lands over it", () => {
    const doc = new mupdf.PDFDocument();
    const helv = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica" });
    const p = doc.addPage([0, 0, 595, 842], 90, { Font: { F1: helv } }, "BT /F1 12 Tf 100 700 Td (SEGRETO_RUOTATO) Tj ET BT /F1 12 Tf 100 300 Td (resta) Tj ET");
    doc.insertPage(-1, p);
    try {
      const quads = hitQuads(doc, "SEGRETO_RUOTATO");
      const rects = areasForQuads(quads);
      redactAreas(mupdf, doc, [{ pageIndex: 0, rects }], "redact");
      expect(pageText(doc, 0).trim()).toBe("resta");
      const r = rects[0];
      expect(otherThan(render(doc, 0), r, [0, 0, 0], 1)).toBe(0);
    } finally {
      doc.destroy();
    }
  });

  it("a figure's /ActualText after the area's line is not said to go, nor boxed: MuPDF leaves it (its characters sit at the pen, with no width)", () => {
    const run = (figure: boolean) => {
      const doc = new mupdf.PDFDocument();
      const helv = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" });
      const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 40, 20], false);
      pix.clear(90);
      const image = new mupdf.Image(pix);
      const im = doc.addImage(image);
      image.destroy();
      pix.destroy();
      const fig = figure ? "/Figure <</ActualText (FIRMA DI MARIO ROSSI)>> BDC q 100 0 0 50 300 400 cm /Im Do Q EMC\n" : "";
      doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { Font: { F1: helv }, XObject: { Im: im } },
        `BT /F1 12 Tf 72 700 Td (Nome: Mario) Tj ET\n${fig}BT /F1 12 Tf 72 686 Td (Riga due) Tj 0 -14 Td (Riga tre) Tj 0 -14 Td (Riga quattro) Tj ET`));
      try {
        const area: RedactArea[] = [{ pageIndex: 0, rects: [[105, 128, 145, 146]] }];
        const preview = previewRedaction(mupdf, doc, area, "redact").pages[0].text;
        const { report } = redactAreas(mupdf, doc, area, "redact");
        const box = /\/PERedact \d+>> BDC\n([\s\S]*?)EMC/.exec(pageContent(doc, 0))?.[1];
        return { preview, report: report.text, box, text: flatText(doc, 0) };
      } finally {
        doc.destroy();
      }
    };
    const plain = run(false), figured = run(true);
    expect(figured.text).toContain("FIRMA DI MARIO ROSSI");
    expect(figured.preview).toBe(plain.preview);
    expect(figured.report).toBe(plain.report);
    expect(figured.box).toBe(plain.box);
  });

  it("a ligature's later letters and glyphs with no advance go with their glyph, and the excerpt says so", () => {
    // (Chrome writes a ligature as /ActualText over one glyph: MuPDF gives its later letters no width, at the glyph's end)
    for (const name of ["search-dense-it.pdf", "search-chrome-it.pdf"]) {
      const doc = openPdf(fixture(name));
      try {
        const lines: { text: string; bbox: Rect }[] = [];
        const page = doc.loadPage(0);
        const st = page.toStructuredText("preserve-whitespace");
        let text = "";
        st.walk({ beginLine() { text = ""; }, onChar(c, _o, font) { font.destroy(); text += c; }, endLine() { lines.push({ text, bbox: [0, 0, 0, 0] }); } });
        let k = 0;
        st.walk({ beginLine(b) { lines[k++].bbox = [b[0], b[1], b[2], b[3]]; } });
        st.destroy();
        page.destroy();
        const ligatures = lines.filter((l) => /ff|fi|fl|ti|tt/.test(l.text)).slice(0, 6);
        expect(ligatures.length).toBeGreaterThan(0);
        for (const { text: line, bbox: [x0, y0, x1, y1] } of ligatures) {
          const h = y1 - y0;
          const area: RedactArea[] = [{ pageIndex: 0, rects: [[x0 - 1, y0 + 0.35 * h, x1 + 1, y1 - 0.35 * h]] }];
          expect(previewRedaction(mupdf, doc, area, "redact").pages[0].text).toBe(line.replace(/\s+/g, " ").trim().slice(0, 200));
        }
      } finally {
        doc.destroy();
      }
    }
    const doc = new mupdf.PDFDocument();
    try {
      const widths = Array.from({ length: 95 }, (_, i) => (i + 32 === 0x5a ? 0 : 600)); // ('Z' has no advance)
      const courier = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Courier", FirstChar: 32, LastChar: 126, Widths: widths, Encoding: "WinAnsiEncoding" });
      doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { Font: { F1: courier } }, "BT /F1 20 Tf 120 500 Td (AZBZSEGRETOZ) Tj ET BT /F1 20 Tf 120 700 Td (FUORI) Tj ET"));
      const area: RedactArea[] = [{ pageIndex: 0, rects: [[100, 320, 400, 360]] }];
      expect(previewRedaction(mupdf, doc, area, "redact").pages[0].text).toBe("AZBZSEGRETOZ");
      expect(redactAreas(mupdf, doc, area, "redact").report.text).toBe("AZBZSEGRETOZ");
      expect(flatText(doc, 0)).toBe("FUORI");
    } finally {
      doc.destroy();
    }
  });
});

describe("the app's own lines and boxes", () => {
  it("an emptied added line is removed and untagged, a cut one becomes printed text", () => {
    const doc = openPdf(leakPdf("own"));
    try {
      // (page space: the area is x 100..500, y 200..500)
      const whole = addText(mupdf, doc, 0, [150, 250], "Riga aggiunta dentro", SANS);
      const cut = addText(mupdf, doc, 0, [450, 230], "Riga tagliata a metà", SANS);
      expect(addedTexts(mupdf, doc, 0).map((t) => t.id)).toEqual([whole.id, cut.id]);
      const elemsBefore = structureOf(download(doc)).elems.length;
      redactAreas(mupdf, doc, AREA, "redact");
      expect(addedTexts(mupdf, doc, 0)).toEqual([]);
      const text = pageText(doc, 0);
      expect(text).not.toContain("Riga aggiunta");
      expect(text).toMatch(/metà/);
      const out = download(doc);
      expect(new TextDecoder("latin1").decode(out)).not.toMatch(/PEText/);
      // The emptied line's /P left the structure tree; the cut one's stays.
      expect(structureOf(out).elems.length).toBe(elemsBefore - 1);
    } finally {
      doc.destroy();
    }
  });

  for (const mode of ["redact", "whiteout"] as const)
    it(`the box over a search hit is one shape for its letters, not one each: their widths are not in the file (${mode})`, () => {
      const doc = openPdf(linesPdf(14.4));
      try {
        const quads = hitQuads(doc, "Rossi");
        const rects = areasForQuads(quads);
        redactAreas(mupdf, doc, [{ pageIndex: 0, rects }], mode);
        const box = /\/PERedact \d+>> BDC\n([\s\S]*?)EMC/.exec(pageContent(doc, 0))?.[1] ?? "";
        // The area (the middle half of the hit, across) and the run of the five letters (70 % of their height).
        expect(box.match(/ m /g)?.length).toBe(rects.length + 1);
        // Their place covered: black, or white, from the first letter to the last.
        const q = quads[0], h = q[5] - q[1];
        expect(otherThan(render(doc, 0), [q[0] + 1, q[1] + 0.2 * h, q[2] - 1, q[5] - 0.2 * h], mode === "redact" ? [0, 0, 0] : [255, 255, 255], 0)).toBe(0);
      } finally {
        doc.destroy();
      }
    });

  it("decorations.ts does not take the box for a line's underline", () => {
    const doc = new mupdf.PDFDocument();
    const helv = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" });
    doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { Font: { F1: helv } }, "BT /F1 12 Tf 72 700 Td (Pay online today) Tj ET"));
    try {
      const quads = hitQuads(doc, "Pay online today");
      const q = quads[0];
      // A thin area at the foot of the line's boxes: the letters stay, the box looks like an underline.
      const h = q[5] - q[1];
      redactAreas(mupdf, doc, [{ pageIndex: 0, rects: [[q[0], q[5] - 0.08 * h, q[2], q[5] - 0.02 * h]] }], "redact");
      expect(pageText(doc, 0).trim()).toBe("Pay online today");
      expect(detectDecorations(mupdf, doc, 0, "Pay online today", 0).shapes).toEqual([]);
    } finally {
      doc.destroy();
    }
  });
});

describe("cost", () => {
  it("a heavy page: 20,000 paths and 2,000 lines of text", () => {
    const doc = new mupdf.PDFDocument();
    const helv = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica" });
    let content = "";
    for (let i = 0; i < 20_000; i++) content += `${(i * 7) % 580} ${(i * 13) % 830} 3 3 re f\n`;
    for (let i = 0; i < 2_000; i++) content += `BT /F1 4 Tf ${(i % 4) * 140 + 10} ${(Math.floor(i / 4) * 1.6) % 830} Td (riga ${i} di testo) Tj ET\n`;
    doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { Font: { F1: helv } }, content));
    try {
      const t0 = performance.now();
      const { report } = redactAreas(mupdf, doc, [{ pageIndex: 0, rects: [[200, 300, 400, 500]] }], "redact");
      expect(performance.now() - t0).toBeLessThan(15_000);
      expect(report.crossing).toBe(true);
      expect(report.text.length).toBeGreaterThan(0);
    } finally {
      doc.destroy();
    }
  });

  it("a long document whose pages share a font: only what the redacted page stopped drawing is looked for elsewhere", () => {
    // 1,100 pages of 4,000 operations each: more than the cleanup reads for one edit
    // (images.ts MAX_CLEANUP_OPERATIONS), were every page that lists the font read.
    const doc = new mupdf.PDFDocument();
    const helv = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica" });
    const filler = "n\n".repeat(4000);
    for (let i = 0; i < 1100; i++) doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { Font: { F1: helv } }, `BT /F1 12 Tf 72 700 Td (Pagina ${i}) Tj ET\n${filler}`));
    try {
      const t0 = performance.now();
      expect(previewRedaction(mupdf, doc, [{ pageIndex: 0, rects: [[60, 130, 200, 150]] }], "redact").refused).toBeNull();
      redactAreas(mupdf, doc, [{ pageIndex: 0, rects: [[60, 130, 200, 150]] }], "redact");
      expect(performance.now() - t0).toBeLessThan(10_000);
      expect(flatText(doc, 0)).toBe("");
      expect(flatText(doc, 1)).toBe("Pagina 1");
    } finally {
      doc.destroy();
    }
  });

  /** Page 1 draws picture M under the area; `pages` more list picture P, whose /SMask is M, and never draw it (`content`: one stream for all, or one each). */
  const listingPdf = (pages: number, content: "shared" | "own") => {
    const doc = new mupdf.PDFDocument();
    const grey = () => {
      const buf = new mupdf.Buffer(new Uint8Array(400).fill(128));
      try {
        return doc.addStream(buf, { Type: "XObject", Subtype: "Image", Width: 20, Height: 20, ColorSpace: "DeviceGray", BitsPerComponent: 8 });
      } finally {
        buf.destroy();
      }
    };
    const m = grey(), p = grey();
    p.put("SMask", m);
    doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { XObject: { M: m } }, "q 60 0 0 60 200 400 cm /M Do Q"));
    const filler = "n\n".repeat(20_000);
    const buf = new mupdf.Buffer(filler);
    const one = doc.addStream(buf, {});
    buf.destroy();
    for (let i = 0; i < pages; i++) {
      const page = doc.addPage([0, 0, 595, 842], 0, { XObject: { P: p } }, content === "own" ? filler : "");
      if (content === "shared") page.put("Contents", one);
      doc.insertPage(-1, page);
    }
    return doc;
  };

  it("what may still draw a picture that went is read once for all pages, within one budget", () => {
    // 1,000 pages share one content stream of 20,000 operations: it is read once, not once a page.
    let doc = listingPdf(1_000, "shared");
    try {
      const t0 = performance.now();
      redactAreas(mupdf, doc, AREA, "redact");
      expect(performance.now() - t0).toBeLessThan(1_000);
    } finally {
      doc.destroy();
    }
    // 1,100 pages of 20,000 operations each: 22 million, past the budget; refused (the session rolls the edit back).
    doc = listingPdf(1_100, "own");
    try {
      expect(() => redactAreas(mupdf, doc, AREA, "redact")).toThrow(expect.objectContaining({ refusal: "shared", changed: true }));
    } finally {
      doc.destroy();
    }
  });

  it("a 300 dpi A4 scan: cleared, a JPEG again, the growth reported", () => {
    const W = 2480, H = 3508;
    const doc = new mupdf.PDFDocument();
    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, W, H], false);
    const px = pix.getPixels();
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 3, ink = (x >> 4) % 7 === 0 && (y >> 3) % 5 === 0;
        const c = ink ? SECRET_RGB : [235 + ((x * y) & 15), 232, 228];
        px[o] = c[0];
        px[o + 1] = c[1];
        px[o + 2] = c[2];
      }
    const image = new mupdf.Image(pix.asJPEG(90, false));
    pix.destroy();
    const im = doc.addImage(image);
    image.destroy();
    doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { XObject: { Scan: im } }, "q 595 0 0 842 0 0 cm /Scan Do Q"));
    try {
      const size = download(doc).length;
      const t0 = performance.now();
      const { report } = redactAreas(mupdf, doc, [{ pageIndex: 0, rects: [[50, 100, 545, 300]] }], "redact");
      const ms = performance.now() - t0;
      expect(ms).toBeLessThan(30_000);
      const out = download(doc);
      expect(report.pictures).toBe(1);
      expect(report.growth).toBeGreaterThanOrEqual(0);
      expect(out.length - size).toBeLessThanOrEqual(report.growth + 300_000);
      const saved = openPdf(out);
      try {
        const scan = saved.findPage(0).get("Resources", "XObject");
        let filters = "";
        scan.forEach((v) => { filters += v.get("Filter").toString(); });
        expect(filters).toBe("/DCTDecode");
        const img = render(saved, 0);
        expect(otherThan(img, [50, 100, 545, 300], [0, 0, 0])).toBe(0);
      } finally {
        saved.destroy();
      }
    } finally {
      doc.destroy();
    }
  });

  it("a CMYK JPEG is a CMYK JPEG again, its colours as they were, the growth reported", () => {
    const W = 600, H = 450;
    const rgb = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, W, H], false);
    const px = rgb.getPixels();
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) px.set([(x * 255) / W, (y * 255) / H, 255 - (x * 255) / W], (y * W + x) * 3);
    const cmyk = rgb.convertToColorSpace(mupdf.ColorSpace.DeviceCMYK);
    rgb.destroy();
    const doc = new mupdf.PDFDocument();
    // (as a print PDF holds one: the JPEG's bytes, DeviceCMYK)
    const buf = new mupdf.Buffer(cmyk.asJPEG(90, false));
    cmyk.destroy();
    const im = doc.addRawStream(buf, { Type: "XObject", Subtype: "Image", Width: W, Height: H, ColorSpace: "DeviceCMYK", BitsPerComponent: 8, Filter: "DCTDecode" });
    buf.destroy();
    doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { XObject: { Photo: im } }, "q 300 0 0 225 150 300 cm /Photo Do Q"));
    try {
      const before = render(doc, 0), size = download(doc).length;
      const area: Rect = [100, 400, 500, 430];
      const { report } = redactAreas(mupdf, doc, [{ pageIndex: 0, rects: [area] }], "redact");
      const out = download(doc);
      expect(out.length - size).toBeLessThanOrEqual(report.growth + 100_000);
      const saved = openPdf(out);
      try {
        let photo: mupdf.PDFObject | null = null;
        saved.findPage(0).get("Resources", "XObject").forEach((v) => { photo = v; });
        expect([photo!.get("Filter").toString(), photo!.get("ColorSpace").toString()]).toEqual(["/DCTDecode", "/DeviceCMYK"]);
        // (JPEG noise only: not a colour turned)
        const after = render(saved, 0);
        let worst = 0;
        for (let y = 0; y < after.h; y++)
          for (let x = 0; x < after.w; x++) {
            if (y > area[1] - 4 && y < area[3] + 4) continue;
            for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(after.px[y * after.stride + x * 3 + k] - before.px[y * before.stride + x * 3 + k]));
          }
        expect(worst).toBeLessThan(24);
      } finally {
        saved.destroy();
      }
    } finally {
      doc.destroy();
    }
  });
});

describe("Oscura tutti i risultati: one edit over many pages", () => {
  it("60 pages sharing their resources, a name on each: one call, the name gone everywhere, the rest intact", () => {
    const doc = new mupdf.PDFDocument();
    const helv = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" });
    const res = doc.addObject({ Font: { F1: helv } });
    for (let i = 0; i < 60; i++) {
      let content = "";
      for (let l = 0; l < 40; l++) content += `BT /F1 10 Tf 72 ${780 - l * 14} Td (Riga ${l} della pagina ${i}${l === 7 ? ": Mario Rossi" : ""}) Tj ET\n`;
      doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, res, content));
    }
    try {
      const areas: RedactArea[] = [];
      for (let i = 0; i < 60; i++) {
        const page = doc.loadPage(i);
        try {
          areas.push({ pageIndex: i, rects: areasForQuads(page.search("Rossi", 10).flat() as unknown as Quad[]) });
        } finally {
          page.destroy();
        }
      }
      const t0 = performance.now();
      redactAreas(mupdf, doc, areas, "redact");
      expect(performance.now() - t0).toBeLessThan(30_000);
      for (const i of [0, 31, 59]) {
        const text = flatText(doc, i);
        expect(text).not.toContain("Rossi");
        expect(text).toContain(`Riga 7 della pagina ${i}: Mario`);
        expect(text).toContain(`Riga 6 della pagina ${i}`);
        expect(text).toContain(`Riga 8 della pagina ${i}`);
      }
      expect(leaksIn(download(doc), ["Rossi"])).toEqual([]);
    } finally {
      doc.destroy();
    }
  });
});

describe("redactGeometry", () => {
  it("areasForQuads keeps the middle half across and stops a little short along", () => {
    // A run 100 pt long, 20 pt tall, upright: ul (10, 100), ur (110, 100), ll (10, 120), lr (110, 120).
    expect(areasForQuads([[10, 100, 110, 100, 10, 120, 110, 120]])).toEqual([[11, 105, 109, 115]]);
    // A short one: the ends stop at 10 % of its length.
    expect(areasForQuads([[0, 0, 4, 0, 0, 20, 4, 20]])).toEqual([[0.4, 5, 3.6, 15]]);
    // Turned a quarter (text going down the page): across is x.
    const [r] = areasForQuads([[120, 10, 120, 110, 100, 10, 100, 110]]);
    expect(r.map((v) => Math.round(v * 1000) / 1000)).toEqual([105, 11, 115, 109]);
    expect(areasForQuads([[0, 0, 0, 0, 0, 0, 0, 0], [0, 0, NaN, 0, 0, 1, 1, 1]])).toEqual([]);
    // Turned 10°: pieces whose bounds stay as close to the run's middle line as an upright run's area (a quarter of its height).
    const a = (10 * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    const turned: Quad = [0, 0, 100 * c, 100 * s, -20 * s, 20 * c, 100 * c - 20 * s, 100 * s + 20 * c];
    const pieces = areasForQuads([turned]);
    expect(pieces.length).toBeGreaterThan(1);
    const reach = (x: number, y: number) => Math.abs((x + 10 * s) * -s + (y - 10 * c) * c); // from the middle line, across it
    for (const r of pieces) for (const [x, y] of [[r[0], r[1]], [r[2], r[1]], [r[0], r[3]], [r[2], r[3]]]) expect(reach(x, y)).toBeLessThanOrEqual(5);
  });

  it("clampAreas clips to the page, drops what is empty or not numbers, takes corners either way, keeps at most MAX_REDACT_RECTS", () => {
    const bounds: Rect = [0, 0, 595, 842];
    expect(clampAreas([[-10, -10, 50, 50], [600, 0, 700, 10], [50, 50, 10, 10], [5, 5, 5, 40], [0, 0, NaN, 1]], bounds))
      .toEqual([[0, 0, 50, 50], [10, 10, 50, 50]]);
    expect(clampAreas(Array.from({ length: MAX_REDACT_RECTS + 5 }, () => [1, 1, 2, 2] as Rect), bounds).length).toBe(MAX_REDACT_RECTS);
  });
});
