// Images (phase 3, release 2): finding the pictures of a page and moving, resizing, rotating,
// deleting or replacing one placement at a time, through EngineSession in Node, on the same
// mupdf build the worker uses (1.27.0). Every edit is checked against MuPDF's own interpreter: a
// trace of every drawing call, in order, with page-space matrices and glyph positions.
//
// Fixtures: a synthetic PDF built here (the prototype's 9 hard cases on a tagged page, and a page
// with /Rotate 90 and an offset CropBox), and two real producers' files without personal
// metadata: chrome-images.pdf (headless Chrome 122, Skia) and word-images.pdf (Word 365, tagged).
import { readFileSync } from "node:fs";
import * as mupdf from "mupdf";
import { describe, expect, it } from "vitest";
import { srgbProfile } from "../src/engine/icc";
import {
  FLIP, MAX_CLIP_CHECKS, MAX_PLACEMENTS, MAX_WALK_OPERATIONS, bboxOf, concat, containFit, embedsProfile, findPlacements, invert, nameFrom,
  num, operations, type PagePlacements,
} from "../src/engine/images";
import { MAX_IMAGE_BYTES, MAX_IMAGE_SIDE, type ImageInfo, type Matrix, type Rect } from "../src/engine/protocol";
import { CHECKPOINT_EVERY, EngineSession, MAX_SPRITE_PIXELS, MIN_SPRITE_SCALE, SessionError } from "../src/engine/session";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

function saveBytes(doc: mupdf.PDFDocument, options: string): Uint8Array {
  const buf = doc.saveToBuffer(options);
  try {
    return buf.asUint8Array().slice();
  } finally {
    buf.destroy();
  }
}

/** A PDF made here with MuPDF. */
function makePdf(build: (doc: mupdf.PDFDocument) => void): Uint8Array {
  const doc = new mupdf.PDFDocument();
  try {
    build(doc);
    return saveBytes(doc, "compress=no");
  } finally {
    doc.destroy();
  }
}

/** An RGB image XObject (with an /SMask when `alpha`) whose pixels `colour` gives (premultiplied when alpha). */
function rgbImage(doc: mupdf.PDFDocument, w: number, h: number, colour: (x: number, y: number) => number[], alpha = false) {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], alpha);
  try {
    const px = pix.getPixels(), n = alpha ? 4 : 3, stride = pix.getStride();
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const c = colour(x, y), o = y * stride + x * n;
        for (let k = 0; k < n; k++) px[o + k] = c[k];
      }
    const img = new mupdf.Image(pix);
    try {
      return doc.addImage(img);
    } finally {
      img.destroy();
    }
  } finally {
    pix.destroy();
  }
}

function helvetica(doc: mupdf.PDFDocument) {
  const font = new mupdf.Font("Helvetica");
  try {
    return doc.addSimpleFont(font);
  } finally {
    font.destroy();
  }
}

/**
 * The prototype's fixture (build-fixture.mjs). Page 1 (612 × 792, tagged), in painting order:
 *   #0 A  /Im4 background texture, under B
 *   #1 B  /Im1, in /Figure MCID 0, with the text "Text over image" over it
 *   #2 C  /Im1 again (the same XObject), /Figure MCID 2, over A
 *   #3 D  /Im2 with alpha (SMask), cropped by a clip in its own q..Q
 *   #4 E  /Fx1, a Form XObject that only draws /Im3
 *   #5 F  /Fx2, a Form XObject drawing /Im3 and a caption: locked ("group")
 *   #6 G  an inline image (BI..ID..EI)
 *   #7 H  /Im3 in a q..Q block that also strokes a frame (no block of its own: the Do is wrapped)
 *   #8 I  /Im1 with "q", "cm Do" and "Q" on separate lines
 * plus a blue bar and the text "Footer line". Page 2: /Rotate 90 and an offset CropBox, one /Im1
 * and the text "Rotated page". The structure tree describes B and C (/Alt).
 */
function buildFixture(): Uint8Array {
  return makePdf((doc) => {
    // Im1: gradient with a black "F" in the top-left, so the orientation shows.
    const im1 = rgbImage(doc, 64, 48, (x, y) => {
      const F = (x >= 8 && x < 12 && y >= 6 && y < 30) || (y >= 6 && y < 10 && x >= 8 && x < 26) || (y >= 16 && y < 20 && x >= 8 && x < 22);
      return F ? [0, 0, 0] : [40 + x * 3, 90 + y, 230 - x * 3];
    });
    // Im2: green striped ellipse, transparent outside it.
    const im2 = rgbImage(doc, 80, 40, (x, y) => {
      const a = ((x - 40) / 40) ** 2 + ((y - 20) / 20) ** 2 <= 1 ? 255 : 0;
      return [x % 10 < 5 ? 30 : 120, 170, 60].map((c) => (c * a) / 255).concat(a);
    }, true);
    // Im3: red and white checkerboard; Im4: light grey texture.
    const im3 = rgbImage(doc, 32, 32, (x, y) => (((x >> 2) + (y >> 2)) % 2 ? [220, 40, 40] : [255, 255, 255]));
    const im4 = rgbImage(doc, 46, 28, (x, y) => { const v = 200 + ((x * 7 + y * 13) % 40); return [v, v, v]; });
    const helv = helvetica(doc);
    const fx1 = doc.addStream("q 150 0 0 100 0 0 cm /Im3 Do Q\n", {
      Type: "XObject", Subtype: "Form", BBox: [0, 0, 150, 100], Resources: { XObject: { Im3: im3 } },
    });
    const fx2 = doc.addStream("q 100 0 0 60 0 20 cm /Im3 Do Q BT /F1 10 Tf 0 0 0 rg 0 6 Td (Caption in form) Tj ET\n", {
      Type: "XObject", Subtype: "Form", BBox: [0, 0, 120, 80], Resources: { XObject: { Im3: im3 }, Font: { F1: helv } },
    });
    let hex = ""; // a 4 × 4 RGB inline image, ASCIIHex so the content stays text
    for (let i = 0; i < 16; i++) hex += i % 2 ? "ffcc00" : "3344aa";
    const content1 = `
q 230 0 0 140 330 580 cm /Im4 Do Q
/Figure <</MCID 0>> BDC
q 200 0 0 150 50 550 cm /Im1 Do Q
EMC
/P <</MCID 1>> BDC
BT /F1 24 Tf 0 0 0 rg 60 620 Td (Text over image) Tj ET
EMC
/Figure <</MCID 2>> BDC
q 120 0 0 90 350 600 cm /Im1 Do Q
EMC
q 300 430 120 100 re W n 280 0 0 140 260 410 cm /Im2 Do Q
q 1 0 0 1 60 250 cm /Fx1 Do Q
q 1 0 0 1 250 240 cm /Fx2 Do Q
q 60 0 0 40 400 250 cm BI /W 4 /H 4 /CS /RGB /BPC 8 /F /AHx ID ${hex}> EI Q
q 100 0 0 80 450 330 cm /Im3 Do 0 0.6 0 RG 0.03 w 0 0 1 1 re S Q
q
50 0 0 40 480 120 cm /Im1 Do
Q
0 0 1 rg 50 100 200 30 re f
BT /F1 12 Tf 0 0 0 rg 50 80 Td (Footer line) Tj ET
`;
    const p1 = doc.addPage([0, 0, 612, 792], 0, { Font: { F1: helv }, XObject: { Im1: im1, Im2: im2, Im3: im3, Im4: im4, Fx1: fx1, Fx2: fx2 } }, content1);
    doc.insertPage(-1, p1);
    const content2 = "q 150 0 0 100 100 500 cm /Im1 Do Q\nBT /F1 18 Tf 0 0 0 rg 100 470 Td (Rotated page) Tj ET\n";
    const p2 = doc.addPage([0, 0, 612, 792], 90, { Font: { F1: helv }, XObject: { Im1: im1 } }, content2);
    p2.put("CropBox", [20, 20, 592, 772]);
    doc.insertPage(-1, p2);
    // Structure tree of page 1: Document > Figure (MCID 0), P (1), Figure (2).
    const pageRef = doc.findPage(0);
    pageRef.put("StructParents", 0);
    const docElem = doc.addObject({ Type: "StructElem", S: "Document" });
    // (a JS string becomes a name: /Alt and /ActualText are text strings)
    const fig0 = doc.addObject({ Type: "StructElem", S: "Figure", P: docElem, Pg: pageRef, K: 0, Alt: doc.newString("A gradient with an F") });
    const para = doc.addObject({ Type: "StructElem", S: "P", P: docElem, Pg: pageRef, K: 1 });
    const fig2 = doc.addObject({ Type: "StructElem", S: "Figure", P: docElem, Pg: pageRef, K: 2, Alt: doc.newString("The gradient again") });
    docElem.put("K", [fig0, para, fig2]);
    const tree = doc.addObject({ Type: "StructTreeRoot", K: docElem, ParentTree: { Nums: [0, [fig0, para, fig2]] }, ParentTreeNextKey: 1 });
    docElem.put("P", tree);
    const root = doc.getTrailer().get("Root");
    root.put("StructTreeRoot", tree);
    root.put("MarkInfo", { Marked: true });
  });
}

const SYNTHETIC = buildFixture();

/**
 * Content the prototype did not try, all movable:
 *   #0 an image in a form inside a form (only the image)
 *   #1 #2 one form drawn twice
 *   #3 an unfiltered inline image whose data holds " EI " (skipped by its length, not by searching)
 *   #4 a stencil mask (/ImageMask: painted with the fill colour, fillImageMask)
 *   #5 an image in a form that also draws itself (MuPDF skips the loop, and so does the walk)
 */
function oddContent(): Uint8Array {
  return makePdf((doc) => {
    const im = rgbImage(doc, 16, 8, (x, y) => [x * 16, y * 32, 90]);
    const form = (content: string, xobjects: Record<string, unknown>) =>
      doc.addStream(content, { Type: "XObject", Subtype: "Form", BBox: [0, 0, 200, 200], Resources: { XObject: xobjects } });
    const inner = form("q 60 0 0 40 0 0 cm /Im Do Q", { Im: im });
    const outer = form("q 1 0 0 1 10 10 cm /Inner Do Q", { Inner: inner });
    const twice = form("q 60 0 0 40 0 0 cm /Im Do Q", { Im: im });
    const loop = doc.addStream("/Loop Do q 30 0 0 30 0 0 cm /Im Do Q", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 200, 200] });
    loop.put("Resources", { XObject: { Loop: loop, Im: im } });
    const mask = doc.addStream(new Uint8Array([0x0f, 0xf0, 0x0f, 0xf0, 0x0f, 0xf0, 0x0f, 0xf0]), {
      Type: "XObject", Subtype: "Image", Width: 8, Height: 8, ImageMask: true, BitsPerComponent: 1,
    });
    const content = [
      "q 1 0 0 1 50 50 cm /Outer Do Q",
      "q 1 0 0 1 300 50 cm /Twice Do Q",
      "q 1 0 0 1 300 200 cm /Twice Do Q",
      "q 40 0 0 10 50 400 cm BI /W 4 /H 1 /CS /G /BPC 8 ID  EI \nEI Q",
      "q 0.8 0.1 0.1 rg 50 0 0 50 300 400 cm /Mask Do Q",
      "q 1 0 0 1 50 600 cm /Loop Do Q",
    ].join("\n");
    doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, { XObject: { Outer: outer, Twice: twice, Mask: mask, Loop: loop } }, content));
  });
}

// ---------------------------------------------------------------------------------------------
// MuPDF's view: every drawing call

interface Drawn {
  t: string;
  /** Clips (and soft masks) in effect. */
  clips: number;
  ctm?: number[];
  w?: number;
  h?: number;
  alpha?: number;
  bbox?: number[];
  color?: number[];
  glyphs?: number[][];
}

const r3 = (v: number) => Math.round(v * 1000) / 1000 || 0; // no -0
const NO_STROKE = null as unknown as mupdf.StrokeState;

/** Every drawing call of the page's content, in order. Images inside tiling patterns are left out. */
function deviceTrace(page: mupdf.PDFPage): Drawn[] {
  const ev: Drawn[] = [];
  const clips: unknown[] = [];
  let tile = 0;
  const push = (e: Omit<Drawn, "clips">) => { if (!tile) ev.push({ ...e, clips: clips.length }); };
  const bounds = (path: mupdf.Path, ctm: mupdf.Matrix, stroke = NO_STROKE) => path.getBounds(stroke, ctm).map(r3);
  const glyphs = (text: mupdf.Text, ctm: mupdf.Matrix) => {
    const g: number[][] = [];
    text.walk({
      showGlyph(font, trm, _gid, uni) {
        const m = mupdf.Matrix.concat(trm, ctm);
        g.push([uni, r3(m[4]), r3(m[5])]);
        font.destroy();
      },
    });
    text.destroy();
    return g;
  };
  const dev = new mupdf.Device({
    fillImage(img, ctm, alpha) { push({ t: "image", w: img.getWidth(), h: img.getHeight(), ctm: ctm.map(r3), alpha: r3(alpha) }); img.destroy(); },
    fillImageMask(img, ctm, cs) { push({ t: "imagemask", w: img.getWidth(), h: img.getHeight(), ctm: ctm.map(r3) }); img.destroy(); cs.destroy(); },
    fillPath(path, _eo, ctm, cs, color) { push({ t: "fill", bbox: bounds(path, ctm), color: color.map(r3) }); path.destroy(); cs.destroy(); },
    strokePath(path, stroke, ctm, cs, color) { push({ t: "stroke", bbox: bounds(path, ctm, stroke), color: color.map(r3) }); path.destroy(); stroke.destroy(); cs.destroy(); },
    clipPath(path, _eo, ctm) { push({ t: "clip", bbox: bounds(path, ctm) }); clips.push(1); path.destroy(); },
    clipStrokePath(path, stroke, ctm) { push({ t: "clipstroke", bbox: bounds(path, ctm, stroke) }); clips.push(1); path.destroy(); stroke.destroy(); },
    clipText(text, ctm) { push({ t: "cliptext", glyphs: glyphs(text, ctm) }); clips.push(1); },
    clipStrokeText(text, stroke, ctm) { push({ t: "cliptext", glyphs: glyphs(text, ctm) }); clips.push(1); stroke.destroy(); },
    clipImageMask(img, ctm) { push({ t: "clipmask", ctm: ctm.map(r3) }); clips.push(1); img.destroy(); },
    popClip() { clips.pop(); },
    fillText(text, ctm, cs, color) { push({ t: "text", glyphs: glyphs(text, ctm), color: color.map(r3) }); cs.destroy(); },
    strokeText(text, stroke, ctm, cs) { push({ t: "stroketext", glyphs: glyphs(text, ctm) }); stroke.destroy(); cs.destroy(); },
    ignoreText(text, ctm) { push({ t: "invisibletext", glyphs: glyphs(text, ctm) }); },
    beginTile() { tile++; return 0; },
    endTile() { tile--; },
    beginMask(bbox, _luminosity, cs) { push({ t: "beginMask", bbox: bbox.map(r3) }); clips.push(1); cs.destroy(); },
    endMask() { push({ t: "endMask" }); },
    beginGroup(_bbox, cs) { push({ t: "beginGroup" }); cs.destroy(); },
    endGroup() { push({ t: "endGroup" }); },
  });
  try {
    page.runPageContents(dev, mupdf.Matrix.identity);
    dev.close();
  } finally {
    dev.destroy();
  }
  return ev;
}

/** The session's working document (read only here). */
const docOf = (s: EngineSession) => (s as unknown as { doc: mupdf.PDFDocument }).doc;

function traceOf(doc: mupdf.PDFDocument, pageIndex: number): Drawn[] {
  const page = doc.loadPage(pageIndex);
  try {
    return deviceTrace(page);
  } finally {
    page.destroy();
  }
}

const liveTrace = (s: EngineSession, pageIndex: number) => traceOf(docOf(s), pageIndex);

/** findPlacements on a page of the session's working document. */
function placementsOf(s: EngineSession, pageIndex: number): PagePlacements {
  const page = docOf(s).loadPage(pageIndex);
  try {
    return findPlacements(mupdf, page);
  } finally {
    page.destroy();
  }
}

function pageBounds(s: EngineSession, pageIndex: number): Rect {
  const page = docOf(s).loadPage(pageIndex);
  try {
    return page.getBounds() as Rect;
  } finally {
    page.destroy();
  }
}

/** The trace of a page of saved bytes, opened again. */
function savedTrace(bytes: ArrayBuffer | Uint8Array, pageIndex: number): Drawn[] {
  const doc = mupdf.Document.openDocument(new Uint8Array(bytes), "application/pdf").asPDF()!;
  try {
    return traceOf(doc, pageIndex);
  } finally {
    doc.destroy();
  }
}

const CLIP_CALLS = new Set(["clip", "clipstroke", "cliptext", "clipmask"]);
/** Without the clip calls themselves (a deleted form takes its /BBox clip with it); the clip counts stay. */
const withoutClips = (ev: Drawn[]) => ev.filter((e) => !CLIP_CALLS.has(e.t));
/**
 * Without the transparency group MuPDF puts around a whole page whose resources use transparency:
 * a picture with a soft mask that leaves the page's resources can take it away.
 */
const withoutPageGroup = (ev: Drawn[]) => (ev[0]?.t === "beginGroup" && ev[ev.length - 1].t === "endGroup" ? ev.slice(1, -1) : ev);
/** The calls that pushed the clips (and soft masks) in effect at call k, bottom first: for each depth, the last push to it. */
function clipsAt(ev: Drawn[], k: number): number[] {
  const pushes = (e: Drawn) => CLIP_CALLS.has(e.t) || e.t === "beginMask";
  return Array.from({ length: ev[k].clips }, (_, depth) => {
    for (let i = k - 1; i >= 0; i--) if (pushes(ev[i]) && ev[i].clips === depth) return i;
    return -1;
  });
}
const isImage = (e: Drawn) => e.t === "image" || e.t === "imagemask";
const imageCalls = (ev: Drawn[]) => ev.flatMap((e, i) => (isImage(e) ? [i] : []));
const imageMatrices = (ev: Drawn[]) => ev.filter(isImage).map((e) => e.ctm!);

function expectMatrix(got: readonly number[] | undefined, want: readonly number[], eps = 0.01) {
  expect(got, "matrix").toBeDefined();
  for (let i = 0; i < 6; i++) expect(Math.abs(got![i] - want[i]), `[${got}] vs [${want}]`).toBeLessThanOrEqual(eps);
}

function expectBox(got: readonly number[] | undefined, want: readonly number[], eps = 0.02) {
  expect(got, "box").toBeDefined();
  for (let i = 0; i < 4; i++) expect(Math.abs(got![i] - want[i]), `[${got}] vs [${want}]`).toBeLessThanOrEqual(eps);
}

/** The bounding box of a rect's corners mapped through m. */
const mappedBox = (r: readonly number[], m: Matrix) =>
  bboxOf([[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]].map(([x, y]): [number, number] => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]]));

// ---------------------------------------------------------------------------------------------
// Sessions and matrices

function open(bytes: Uint8Array | ArrayBuffer): EngineSession {
  const s = new EngineSession(mupdf);
  const r = s.open(bytes);
  if (!r.ok) throw new Error(`did not open: ${r.reason}`);
  return s;
}

function expectSessionError(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(SessionError);
    expect((err as SessionError).code, (err as Error).message).toBe(code);
    return;
  }
  throw new Error(`expected a SessionError "${code}"`);
}

const translation = (x: number, y: number): Matrix => [1, 0, 0, 1, x, y];
const scaling = (x: number, y: number): Matrix => [x, 0, 0, y, 0, 0];
const rotation = (deg: number): Matrix => {
  const r = (deg * Math.PI) / 180;
  return [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0];
};
const centreOf = (m: Matrix): [number, number] => [(m[0] + m[2]) / 2 + m[4], (m[1] + m[3]) / 2 + m[5]];
const moved = (m: Matrix, dx: number, dy: number) => concat(m, translation(dx, dy));
/** `m` changed by `change` about its own centre. */
function aboutCentre(m: Matrix, change: Matrix): Matrix {
  const [cx, cy] = centreOf(m);
  return concat(m, concat(concat(translation(-cx, -cy), change), translation(cx, cy)));
}
const sides = (m: Matrix) => [Math.hypot(m[0], m[1]), Math.hypot(m[2], m[3])];
const angle = (m: Matrix) => (Math.atan2(m[1], m[0]) * 180) / Math.PI;

/** A picture file: `w` × `h` pixels, JPEG or PNG (with alpha when `colour` gives four values, premultiplied). */
function pictureFile(format: "jpeg" | "png", w: number, h: number, colour: (x: number, y: number) => number[]): Uint8Array {
  const alpha = colour(0, 0).length === 4;
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], alpha);
  try {
    const px = pix.getPixels(), n = alpha ? 4 : 3, stride = pix.getStride();
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const c = colour(x, y), o = y * stride + x * n;
        for (let k = 0; k < n; k++) px[o + k] = c[k];
      }
    return (format === "jpeg" ? pix.asJPEG(90) : pix.asPNG()).slice();
  } finally {
    pix.destroy();
  }
}

/** A JPEG file with an ICC profile embedded (an APP2 ICC_PROFILE segment right after SOI). */
function withProfile(jpeg: Uint8Array, icc: Uint8Array): Uint8Array {
  const sig = new TextEncoder().encode("ICC_PROFILE\0");
  const length = 2 + sig.length + 2 + icc.length;
  const segment = new Uint8Array(2 + length);
  segment.set([0xff, 0xe2, length >> 8, length & 255]);
  segment.set(sig, 4);
  segment.set([1, 1], 4 + sig.length); // part 1 of 1
  segment.set(icc, 6 + sig.length);
  const out = new Uint8Array(jpeg.length + segment.length);
  out.set(jpeg.subarray(0, 2));
  out.set(segment, 2);
  out.set(jpeg.subarray(2), 2 + segment.length);
  return out;
}

/** Every image XObject of a file (its object number and pixel size), and what each stream holds as text. */
function objectsOf(bytes: ArrayBuffer | Uint8Array) {
  const doc = mupdf.Document.openDocument(new Uint8Array(bytes), "application/pdf").asPDF()!;
  try {
    const images: { num: number; size: string }[] = [], texts: string[] = [];
    for (let k = 1; k < doc.countObjects(); k++) {
      const o = doc.newIndirect(k);
      if (!o.isStream()) continue;
      if (o.get("Subtype").isName() && o.get("Subtype").asName() === "Image") images.push({ num: k, size: `${o.get("Width").asNumber()}x${o.get("Height").asNumber()}` });
      const buf = o.readStream();
      try {
        texts.push(Array.from(buf.asUint8Array(), (c) => String.fromCharCode(c)).join(""));
      } finally {
        buf.destroy();
      }
    }
    return { images, sizes: images.map((i) => i.size).sort(), texts };
  } finally {
    doc.destroy();
  }
}

/** The pixel sizes of every image XObject of a file, sorted (its dictionaries only: no stream is decoded). */
function imageSizes(bytes: ArrayBuffer | Uint8Array): string[] {
  const doc = mupdf.Document.openDocument(new Uint8Array(bytes), "application/pdf").asPDF()!;
  try {
    const sizes: string[] = [];
    for (let k = 1; k < doc.countObjects(); k++) {
      const o = doc.newIndirect(k);
      if (o.isStream() && o.get("Subtype").isName() && o.get("Subtype").asName() === "Image") sizes.push(`${o.get("Width").asNumber()}x${o.get("Height").asNumber()}`);
    }
    return sizes.sort();
  } finally {
    doc.destroy();
  }
}

/** A page of a file as MuPDF shows it, annotations included: RGB pixels at 1 pixel per point. */
function pagePixels(bytes: ArrayBuffer | Uint8Array, pageIndex: number) {
  const doc = mupdf.Document.openDocument(new Uint8Array(bytes), "application/pdf");
  try {
    const page = doc.loadPage(pageIndex);
    try {
      const pix = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
      try {
        return { width: pix.getWidth(), height: pix.getHeight(), rgb: pix.getPixels().slice() };
      } finally {
        pix.destroy();
      }
    } finally {
      page.destroy();
    }
  } finally {
    doc.destroy();
  }
}

/** How many pixels differ between two renders, leaving out those within a rect (and 1 px around it). */
function changedOutside(a: ReturnType<typeof pagePixels>, b: ReturnType<typeof pagePixels>, rect: Rect): number {
  let n = 0;
  for (let y = 0; y < a.height; y++)
    for (let x = 0; x < a.width; x++) {
      if (x >= rect[0] - 1 && x <= rect[2] + 1 && y >= rect[1] - 1 && y <= rect[3] + 1) continue;
      const o = (y * a.width + x) * 3;
      if ([0, 1, 2].some((c) => Math.abs(a.rgb[o + c] - b.rgb[o + c]) > 8)) n++;
    }
  return n;
}

/** A stream MuPDF refuses to decode (a predictor for more colour components than it allows), with `dict`. */
function undecodable(doc: mupdf.PDFDocument, dict: Record<string, unknown>): mupdf.PDFObject {
  const buf = new mupdf.Buffer(new Uint8Array(64).fill(0x41));
  try {
    return doc.addRawStream(buf, { ...dict, Filter: "FlateDecode", DecodeParms: { Predictor: 12, Colors: 100, Columns: 1 } });
  } finally {
    buf.destroy();
  }
}

/** The names of page `pageIndex`'s /Resources /XObject in a file. */
function xobjectNames(bytes: ArrayBuffer | Uint8Array, pageIndex: number): string[] {
  const doc = mupdf.Document.openDocument(new Uint8Array(bytes), "application/pdf").asPDF()!;
  try {
    const names: string[] = [];
    doc.findPage(pageIndex).getInheritable("Resources").get("XObject").forEach((_v, k) => names.push(String(k)));
    return names.sort();
  } finally {
    doc.destroy();
  }
}

/** Every structure element of the saved file's tree, as plain data (S, Alt, ActualText). */
function structElements(bytes: ArrayBuffer | Uint8Array) {
  const doc = mupdf.Document.openDocument(new Uint8Array(bytes), "application/pdf").asPDF()!;
  try {
    const out: { S: string; Alt: string | null; ActualText: string | null }[] = [];
    const text = (o: mupdf.PDFObject) => (o.isString() ? o.asString() : null);
    const visit = (e: mupdf.PDFObject) => {
      if (e.isArray()) return e.forEach(visit);
      if (!e.isDictionary() || !e.get("S").isName()) return;
      out.push({ S: e.get("S").asName(), Alt: text(e.get("Alt")), ActualText: text(e.get("ActualText")) });
      visit(e.get("K"));
    };
    visit(doc.getTrailer().get("Root", "StructTreeRoot", "K"));
    return out;
  } finally {
    doc.destroy();
  }
}

const SAVE_PDFA = { format: "pdfa-2b", password: { mode: "none" } } as const;

/** The page's /Resources /XObject entry `name`. */
const xobject = (s: EngineSession, pageIndex: number, name: string) => docOf(s).findPage(pageIndex).get("Resources", "XObject", name);

/** The page's content, all streams decoded, as text. */
function contentOf(s: EngineSession, pageIndex: number): string {
  const c = docOf(s).findPage(pageIndex).get("Contents");
  const streams = c.isArray() ? Array.from({ length: c.length }, (_, k) => c.get(k)) : [c];
  return streams.map((st) => {
    const buf = st.readStream();
    try {
      return buf.asString();
    } finally {
      buf.destroy();
    }
  }).join("\n");
}

const SOURCES: [string, Uint8Array, number][] = [
  ["the synthetic fixture", SYNTHETIC, 9],
  ["odd content", oddContent(), 6],
  ["chrome-images.pdf", fixture("chrome-images.pdf"), 6],
  ["word-images.pdf", fixture("word-images.pdf"), 6],
];

// ---------------------------------------------------------------------------------------------

describe("finding images", () => {
  it.each(SOURCES)("%s: the walk matches MuPDF's device pass", (_name, bytes, movable) => {
    const s = open(bytes);
    let movables = 0;
    for (let p = 0; p < docOf(s).countPages(); p++) {
      // The walk itself is trusted (one that is not lists MuPDF's own images, all locked).
      expect(placementsOf(s, p).agreed, `page ${p + 1}`).toBe(true);
      const images = s.images(p), drawn = liveTrace(s, p).filter(isImage), [px0, py0, px1, py1] = pageBounds(s, p);
      expect(images.length).toBe(drawn.length);
      expect(images.length).toBeGreaterThan(0);
      images.forEach((img, k) => {
        expect(img.index).toBe(k);
        expectMatrix(img.matrix, drawn[k].ctm!);
        expect([img.pixelWidth, img.pixelHeight]).toEqual([drawn[k].w, drawn[k].h]);
        // bbox is the whole picture; visible is inside it, and inside the page
        const quad = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([x, y]) => [x * img.matrix[0] + y * img.matrix[2] + img.matrix[4], x * img.matrix[1] + y * img.matrix[3] + img.matrix[5]]);
        expect(img.bbox[0]).toBeCloseTo(Math.min(...quad.map((q) => q[0])), 6);
        expect(img.bbox[1]).toBeCloseTo(Math.min(...quad.map((q) => q[1])), 6);
        expect(img.bbox[2]).toBeCloseTo(Math.max(...quad.map((q) => q[0])), 6);
        expect(img.bbox[3]).toBeCloseTo(Math.max(...quad.map((q) => q[1])), 6);
        const [x0, y0, x1, y1] = img.visible;
        expect(x0).toBeGreaterThanOrEqual(Math.max(img.bbox[0], px0) - 0.01);
        expect(y0).toBeGreaterThanOrEqual(Math.max(img.bbox[1], py0) - 0.01);
        expect(x1).toBeLessThanOrEqual(Math.min(img.bbox[2], px1) + 0.01);
        expect(y1).toBeLessThanOrEqual(Math.min(img.bbox[3], py1) + 0.01);
        expect(x1).toBeGreaterThanOrEqual(x0);
        expect(y1).toBeGreaterThanOrEqual(y0);
        expect(img.reason === null).toBe(img.movable);
        if (img.movable) movables++;
        else expect(img.reason).toBe("group"); // the synthetic fixture's F, the only one locked
      });
    }
    expect(movables).toBe(movable);
  });

  it("the synthetic fixture: what can move, the crop, the rotated page", () => {
    const s = open(SYNTHETIC);
    const images = s.images(0);
    expect(images.map((i) => i.reason)).toEqual([null, null, null, null, null, "group", null, null, null]);
    // A (#0): upright 230 × 140 pt with its top-left corner at (330, 72).
    expect(images[0].matrix.map(r3)).toEqual([230, 0, 0, 140, 330, 72]);
    // D (#3) is cropped by the clip in its own block: it shows only there, and stays movable.
    expect(images[3].visible.map(r3)).toEqual([300, 262, 420, 362]);
    expect(images[3].bbox.map(r3)).toEqual([260, 242, 540, 382]);
    expect([images[6].pixelWidth, images[6].pixelHeight]).toEqual([4, 4]); // the inline image
    // Page 2 (/Rotate 90, CropBox): the picture is seen turned 90° clockwise.
    const [rotated] = s.images(1);
    expectMatrix(rotated.matrix, [0, 150, -100, 0, 580, 80]);
    expect(rotated.movable).toBe(true);
  });

  it("odd content: nested forms, a form drawn twice, a form that draws itself, \" EI \" in inline data, a stencil mask", () => {
    const s = open(oddContent());
    const images = s.images(0);
    expect(images.map((i) => i.reason)).toEqual([null, null, null, null, null, null]);
    expect(images.map((i) => [i.pixelWidth, i.pixelHeight])).toEqual([[16, 8], [16, 8], [16, 8], [4, 1], [8, 8], [16, 8]]);
    expect(liveTrace(s, 0).filter(isImage).map((e) => e.t)).toEqual(["image", "image", "image", "image", "imagemask", "image"]);
    // Moving one drawing of the form drawn twice leaves the other.
    s.transformImage(0, 1, moved(images[1].matrix, 0, -300));
    expectMatrix(s.images(0)[2].matrix, images[2].matrix);
    expectMatrix(s.images(0)[1].matrix, moved(images[1].matrix, 0, -300));
  });

  it("the real files: Chrome's page clip outside the blocks does not crop, so everything moves", () => {
    for (const name of ["chrome-images.pdf", "word-images.pdf"]) {
      const s = open(fixture(name));
      expect(s.images(0).every((i) => i.movable), name).toBe(true);
    }
    // Chrome's pre-cropped "object-fit: cover" picture is clipped in its own block.
    const chrome = open(fixture("chrome-images.pdf")).images(0);
    expect(chrome[3].visible[3] - chrome[3].visible[1]).toBeLessThan(chrome[3].bbox[3] - chrome[3].bbox[1]);
    expect(angle(chrome[5].matrix)).toBeCloseTo(20, 0); // rotated by CSS
  });

  it("names as MuPDF reads them: #-escapes decoded, UTF-8", () => {
    expect(nameFrom("Logo#20A")).toBe("Logo A");
    expect(nameFrom("#41#4a#4B")).toBe("AJK");
    expect(nameFrom("A#00B")).toBe("A#00B"); // MuPDF keeps #00 as written
    expect(nameFrom("x#4")).toBe("x#4");
    expect(nameFrom("x#G1")).toBe("x#G1");
    expect(nameFrom("Caf#C3#A9")).toBe("Café");
    expect(nameFrom("Caf\xc3\xa9")).toBe("Café"); // the bytes as written (content is read as Latin-1)
    expect([...operations("/Logo#20A Do /Fm#231 Do")].map((o) => o.args[0].name)).toEqual(["Logo A", "Fm#1"]);
  });

  it("a picture drawn under a #-escaped name is found, also on a page that paints with a pattern", () => {
    for (const pattern of [false, true]) {
      const bytes = makePdf((doc) => {
        const cell = doc.addStream("0 1 0 rg 0 0 50 50 re f", { Type: "Pattern", PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 50, 50], XStep: 50, YStep: 50 });
        const content = (pattern ? "q /Pattern cs /P0 scn 50 50 200 200 re f Q\n" : "") + "q 100 0 0 100 50 600 cm /Logo#20A Do Q q 100 0 0 100 300 300 cm /Other Do Q";
        doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, { XObject: { "Logo A": rgbImage(doc, 16, 16, () => [220, 30, 30]), Other: rgbImage(doc, 16, 16, () => [30, 30, 220]) }, Pattern: { P0: cell } }, content));
      });
      const images = open(bytes).images(0);
      expect(images.map((i) => [i.movable, i.reason]), `pattern: ${pattern}`).toEqual([[true, null], [true, null]]);
      expectMatrix(images[0].matrix, [100, 0, 0, 100, 50, 92]);
    }
  });

  it("the other repository fixtures: no images, and the walk agrees with MuPDF", () => {
    const files: [string, string?][] = [
      ["chrome-rotate90-crop.pdf"], ["chrome-subset.pdf"], ["enc-user-aes128.pdf", "utente"],
      ["reportlab-form.pdf"], ["type3-matplotlib.pdf"], ["word-winansi.pdf"],
    ];
    for (const [name, password] of files) {
      const doc: mupdf.PDFDocument = mupdf.Document.openDocument(fixture(name), "application/pdf").asPDF()!;
      try {
        if (password) doc.authenticatePassword(password);
        for (let p = 0; p < doc.countPages(); p++) {
          const page = doc.loadPage(p);
          try {
            const found = findPlacements(mupdf, page);
            expect(found.agreed, `${name} page ${p + 1}`).toBe(true);
            expect(found.placements.length).toBe(deviceTrace(page).filter(isImage).length);
          } finally {
            page.destroy();
          }
        }
      } finally {
        doc.destroy();
      }
    }
  });
});

describe("locked images", () => {
  /** An image XObject for the cases below. */
  const grey = (doc: mupdf.PDFDocument) => rgbImage(doc, 8, 8, (x, y) => [100 + x * 10, 100 + y * 10, 150]);

  it("an image in a group with a caption", () => {
    const s = open(SYNTHETIC);
    const group = s.images(0)[5];
    expect(group).toMatchObject({ movable: false, reason: "group" });
    expectSessionError(() => s.transformImage(0, 5, moved(group.matrix, 10, 10)), "not-editable");
    expectSessionError(() => s.deleteImage(0, 5), "not-editable");
    expectSessionError(() => s.replaceImage(0, 5, pictureFile("png", 4, 4, () => [0, 0, 0])), "not-editable");
    expect(s.edits()).toEqual([]);
  });

  // In these pages the blocks around a clip or a soft mask also paint a small square: a block that
  // painted only the image would be the image's own block, and what it sets would move with it.
  it("soft masks: set outside the image's block it locks the image, inside it does not", () => {
    const bytes = makePdf((doc) => {
      const im = grey(doc);
      // The mask's group draws an image too: not a placement, and not counted by the safety check.
      const group = doc.addStream("q 0 0 612 792 re W n q 300 0 0 300 0 0 cm /Im Do Q Q", {
        Type: "XObject", Subtype: "Form", BBox: [0, 0, 612, 792], Group: { S: "Transparency", CS: "DeviceRGB" }, Resources: { XObject: { Im: im } },
      });
      const gs = doc.addObject({ Type: "ExtGState", SMask: { Type: "Mask", S: "Luminosity", G: group } });
      const content = "q /GS1 gs 0.5 g 0 0 5 5 re f q 100 0 0 100 50 50 cm /Im Do Q Q\nq /GS1 gs 100 0 0 100 300 50 cm /Im Do Q\nq 100 0 0 100 300 300 cm /Im Do Q";
      doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, { XObject: { Im: im }, ExtGState: { GS1: gs } }, content));
    });
    const s = open(bytes);
    expect(s.images(0).map((i) => i.reason)).toEqual(["soft-mask", null, null]);
    const target = moved(s.images(0)[1].matrix, 0, -200);
    s.transformImage(0, 1, target);
    expectMatrix(s.images(0)[1].matrix, target);
  });

  it("clips set outside the image's block: locked only when they crop it as a frame would", () => {
    const bytes = makePdf((doc) => {
      const im = grey(doc);
      const helv = helvetica(doc);
      const fmt = (m: Matrix) => m.map(num).join(" ");
      /** A circle by four Béziers, then W n. */
      const circle = (cx: number, cy: number, r: number) => {
        const k = 0.5523 * r;
        return `${cx + r} ${cy} m ${cx + r} ${cy + k} ${cx + k} ${cy + r} ${cx} ${cy + r} c ${cx - k} ${cy + r} ${cx - r} ${cy + k} ${cx - r} ${cy} c `
          + `${cx - r} ${cy - k} ${cx - k} ${cy - r} ${cx} ${cy - r} c ${cx + k} ${cy - r} ${cx + r} ${cy - k} ${cx + r} ${cy} c h W n`;
      };
      const square = "0.5 g 0 0 5 5 re f"; // something else painted in the clip's block
      const content = [
        // #0 a frame that cuts the picture: "cropped"
        `q 50 50 60 60 re W n ${square} q 100 0 0 100 50 50 cm /Im Do Q Q`,
        // #1 a page-size rectangle (as Chrome writes): fine
        `q 0 0 612 792 re W n ${square} q 100 0 0 100 200 50 cm /Im Do Q Q`,
        // #2 a rotated rectangle that holds the whole picture: fine
        `q ${fmt(rotation(30))} cm 350 -150 150 150 re W n ${fmt(rotation(-30))} cm ${square} q 60 0 0 60 380 120 cm /Im Do Q Q`,
        // #3 a circle larger than the picture, around it: not a frame, fine
        `q ${circle(450, 650, 100)} ${square} q 60 0 0 60 420 620 cm /Im Do Q Q`,
        // #4 a circle inside the picture (a round photo): curves are not measured, it crops as a frame
        `q ${circle(290, 690, 30)} ${square} q 80 0 0 80 250 650 cm /Im Do Q Q`,
        // #5 text used as a clip: not measured either
        `q BT 7 Tr /F1 60 Tf 50 300 Td (CLIP) Tj ET q 100 0 0 100 50 280 cm /Im Do Q Q`,
        // #6 a clip inside the image's own block, which crops: moves with it, fine
        "q q 50 450 50 50 re W n 100 0 0 100 50 450 cm /Im Do Q Q",
        // #7 the image's own block is the outer one (it paints nothing else): its clip is inside, fine
        "q 400 300 50 50 re W n q 100 0 0 100 400 300 cm /Im Do Q Q",
      ].join("\n");
      doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, { XObject: { Im: im }, Font: { F1: helv } }, content));
    });
    const s = open(bytes);
    const images = s.images(0);
    expect(images.map((i) => i.reason)).toEqual(["cropped", null, null, null, "cropped", "cropped", null, null]);
    expect(images[0].visible.map(r3)).toEqual([50, 682, 110, 742]); // only the clip's part shows
    // A clip set outside but not a frame: moving the picture partly under it, and back, is fine.
    const free = images[1].matrix;
    s.transformImage(0, 1, [100, 0, 0, 100, -40, 600]);
    expect(s.images(0)[1].movable).toBe(true);
    s.transformImage(0, 1, free);
    expectMatrix(s.images(0)[1].matrix, free);
  });

  it("a page MuPDF draws differently from what the walk reads: every image locked as \"unreadable\"", () => {
    const bytes = makePdf((doc) => {
      const im = grey(doc);
      const layer = doc.addObject({ Type: "OCG", Name: "Hidden layer" });
      doc.getTrailer().get("Root").put("OCProperties", { OCGs: [layer], D: { OFF: [layer], Order: [layer] } });
      // The first image is on a layer that is off: MuPDF does not draw it, the walk counts it.
      const content = "/OC /L1 BDC q 100 0 0 100 50 50 cm /Im Do Q EMC\nq 100 0 0 100 300 300 cm /Im Do Q";
      doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, { XObject: { Im: im }, Properties: { L1: layer } }, content));
      doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, { XObject: { Im: im } }, "q 100 0 0 100 300 300 cm /Im Do Q"));
    });
    const s = open(bytes);
    const [only] = s.images(0);
    expect(s.images(0)).toHaveLength(1); // listed as MuPDF draws them
    expect(only).toMatchObject({ index: 0, movable: false, reason: "unreadable" });
    expectMatrix(only.matrix, [100, 0, 0, 100, 300, 392]);
    expectSessionError(() => s.transformImage(0, 0, moved(only.matrix, 10, 0)), "not-editable");
    expectSessionError(() => s.deleteImage(0, 0), "not-editable");
    // Another page of the same file is fine.
    expect(s.images(1)[0].movable).toBe(true);
    // The preview still works on a locked image.
    expect(s.renderImage(0, 0, 1).width).toBe(100);
  });

  it("as many images as MuPDF draws, but at other matrices (content MuPDF reads otherwise): every image locked", () => {
    // "--50" and a cm with seven operands: MuPDF still draws the first picture (at its own reading
    // of the content), the walk reads it elsewhere. Only the matrix check of the gate sees it.
    for (const odd of ["q 100 0 0 100 --50 50 cm /Im Do Q", "q 1 100 0 0 100 50 50 cm /Im Do Q"]) {
      const bytes = makePdf((doc) => {
        const im = grey(doc);
        doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, { XObject: { Im: im } }, `${odd}\nq 100 0 0 100 300 300 cm /Im Do Q`));
      });
      const s = open(bytes);
      expect(placementsOf(s, 0).agreed, odd).toBe(false);
      const images = s.images(0);
      expect(images, odd).toHaveLength(2);
      expect(images.map((i) => i.reason)).toEqual(["unreadable", "unreadable"]);
      expectMatrix(images[1].matrix, [100, 0, 0, 100, 300, 392]);
      expectSessionError(() => s.transformImage(0, 1, moved(images[1].matrix, 10, 0)), "not-editable");
      expectSessionError(() => s.deleteImage(0, 0), "not-editable");
    }
  });

  it("the cells of a small pattern fill, and a stencil mask painted with a pattern, do not lock the page", () => {
    const bytes = makePdf((doc) => {
      const im = grey(doc);
      // A cell larger than the area it fills: MuPDF draws the cell's picture as a plain image.
      const pattern = doc.addStream("q 100 0 0 100 0 0 cm /Im Do Q", {
        Type: "Pattern", PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 100, 100], XStep: 100, YStep: 100, Resources: { XObject: { Im: im } },
      });
      const checks = doc.addStream("0 0 1 rg 0 0 5 5 re f 1 0 0 rg 5 5 5 5 re f", {
        Type: "Pattern", PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 10, 10], XStep: 10, YStep: 10,
      });
      const mask = doc.addStream(new Uint8Array([0x0f, 0xf0, 0x0f, 0xf0, 0x0f, 0xf0, 0x0f, 0xf0]), {
        Type: "XObject", Subtype: "Image", Width: 8, Height: 8, ImageMask: true, BitsPerComponent: 1,
      });
      const content = [
        "q /Pattern cs /P0 scn 50 50 80 80 re f Q",
        "q /Pattern cs /P1 scn 100 0 0 100 50 300 cm /Mask Do Q",
        "q 100 0 0 100 300 300 cm /Im Do Q",
        "q /Pattern cs /P0 scn 50 400 300 300 re f Q",
      ].join("\n");
      doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, { XObject: { Im: im, Mask: mask }, Pattern: { P0: pattern, P1: checks } }, content));
    });
    const s = open(bytes);
    expect(liveTrace(s, 0).filter(isImage).length).toBeGreaterThan(1); // the cell's picture, drawn as an image
    const [img, ...more] = s.images(0);
    expect(more).toEqual([]);
    expect(img).toMatchObject({ movable: true, reason: null });
    expectMatrix(img.matrix, [100, 0, 0, 100, 300, 392]);
    // The sprite is of this image, not of the pattern's cell drawn before it.
    const r = s.renderImage(0, 0, 1);
    expect(r.rect).toEqual([300, 392, 400, 492]);
    s.transformImage(0, 0, moved(img.matrix, 50, 0));
    expectMatrix(s.images(0)[0].matrix, moved(img.matrix, 50, 0));
  });

  it("an image MuPDF draws that the walk does not see locks a page without patterns", () => {
    // A name with a byte that is not UTF-8 (Latin-1 "é", written as it is in the content and in
    // the dictionary): MuPDF matches the bytes and draws the picture, but MuPDF.js gives and looks
    // up keys as UTF-8 strings, so the walk cannot find it. Images MuPDF draws beyond the
    // placements are only accepted where patterns or Type 3 fonts can explain them: here they
    // mean the walk missed something.
    const written = makePdf((doc) => {
      const im = grey(doc);
      doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, { XObject: { Im: im, ImX: im } }, "q 100 0 0 100 50 50 cm /ImX Do Q\nq 100 0 0 100 300 300 cm /Im Do Q"));
    });
    const text = Array.from(written, (c) => String.fromCharCode(c)).join("");
    expect(text.split("/ImX").length).toBe(3); // in the dictionary and in the content (the same length after)
    const s = open(Uint8Array.from(text.replaceAll("/ImX", "/Im\xe9"), (c) => c.charCodeAt(0)));
    expect(liveTrace(s, 0).filter(isImage)).toHaveLength(2);
    expect(s.images(0).map((i) => i.reason)).toEqual(["unreadable", "unreadable"]);
  });
});

describe("moving and deleting every image", () => {
  for (const [name, bytes, movable] of SOURCES) {
    it(`${name}: each image moved, scaled and rotated; nothing else changes, also after saving`, () => {
      const ref = open(bytes);
      let checked = 0;
      for (let p = 0; p < docOf(ref).countPages(); p++) {
        const before = liveTrace(ref, p), calls = imageCalls(before), found = placementsOf(ref, p);
        for (const info of ref.images(p).filter((i) => i.movable)) {
          const s = open(bytes);
          const target = aboutCentre(moved(info.matrix, 17, 23), concat(scaling(0.9, 0.9), rotation(10)));
          const r = s.transformImage(p, info.index, target);
          expect(r).toMatchObject({ pageIndex: p, imageIndex: info.index, editCount: 1, canUndo: true, changedPages: [p] });
          const after = liveTrace(s, p), k = calls[info.index];
          // The image is exactly there, in the same place of the painting order...
          expect(after.length).toBe(before.length);
          expectMatrix(after[k].ctm, target);
          // ...its soft mask (MuPDF clips to it right before drawing it) with it...
          const own = new Set<number>(), stack = clipsAt(before, k);
          while (stack.length && before[stack[stack.length - 1]].t === "clipmask") {
            const i = stack.pop()!;
            own.add(i);
            expectMatrix(after[i].ctm, target);
          }
          // ...the clips set in its own block (or in its form: a crop, a /BBox) moved exactly as the
          // picture did (they are rectangles in these files: their boxes map corner to corner)...
          const inside = found.placements[info.index].inside.length, M = concat(invert(info.matrix), target);
          for (const i of inside ? stack.slice(-inside) : []) {
            own.add(i);
            expect({ ...after[i], bbox: null }).toEqual({ ...before[i], bbox: null });
            expectBox(after[i].bbox, mappedBox(before[i].bbox!, M));
          }
          // ...and every other drawing call (glyph positions, line art, other images, the other clips) is the same.
          expect(after.filter((_, i) => i !== k && !own.has(i))).toEqual(before.filter((_, i) => i !== k && !own.has(i)));
          // It keeps its index, and the saved file draws the same.
          expectMatrix(s.images(p)[info.index].matrix, target);
          expect(savedTrace(s.save().bytes, p)).toEqual(liveTrace(s, p));
          checked++;
        }
      }
      expect(checked).toBe(movable);
    });

    it(`${name}: each image deleted; nothing else changes, also after saving`, () => {
      const ref = open(bytes);
      let checked = 0;
      for (let p = 0; p < docOf(ref).countPages(); p++) {
        const before = withoutPageGroup(withoutClips(liveTrace(ref, p))), calls = imageCalls(before), count = ref.images(p).length;
        for (const info of ref.images(p).filter((i) => i.movable)) {
          const s = open(bytes);
          expect(s.deleteImage(p, info.index)).toMatchObject({ pageIndex: p, imageIndex: null, editCount: 1, changedPages: [p] });
          const after = withoutPageGroup(withoutClips(liveTrace(s, p)));
          expect(after).toEqual(before.filter((_, i) => i !== calls[info.index]));
          expect(s.images(p)).toHaveLength(count - 1);
          expect(savedTrace(s.save().bytes, p)).toEqual(liveTrace(s, p));
          checked++;
        }
      }
      expect(checked).toBe(movable);
    });
  }

  it("the rotated page: the move is in page space, and only the picture's area changes", () => {
    const s = open(SYNTHETIC);
    const [img] = s.images(1);
    const shown = s.render(1, 1);
    const target = moved(img.matrix, 50, 100);
    s.transformImage(1, 0, target);
    expectMatrix(s.images(1)[0].matrix, target);
    const after = s.render(1, 1);
    let box: Rect | null = null;
    for (let y = 0; y < shown.height; y++)
      for (let x = 0; x < shown.width; x++) {
        const o = (y * shown.width + x) * 4;
        if (Math.abs(shown.rgba[o] - after.rgba[o]) + Math.abs(shown.rgba[o + 1] - after.rgba[o + 1]) + Math.abs(shown.rgba[o + 2] - after.rgba[o + 2]) > 6)
          box = box ? [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x + 1), Math.max(box[3], y + 1)] : [x, y, x + 1, y + 1];
      }
    const old = img.bbox, now = s.images(1)[0].bbox;
    expect(box).not.toBeNull();
    expect(box![0]).toBeGreaterThanOrEqual(Math.min(old[0], now[0]) - 1);
    expect(box![1]).toBeGreaterThanOrEqual(Math.min(old[1], now[1]) - 1);
    expect(box![2]).toBeLessThanOrEqual(Math.max(old[2], now[2]) + 1);
    expect(box![3]).toBeLessThanOrEqual(Math.max(old[3], now[3]) + 1);
  });

  it("tags, the other placements of the same picture and the structure tree stay", () => {
    const s = open(SYNTHETIC);
    const images = s.images(0);
    s.transformImage(0, 1, moved(images[1].matrix, 280, 300));
    s.deleteImage(0, 2);
    const page = docOf(s).loadPage(0);
    try {
      const found = findPlacements(mupdf, page);
      expect(found.placements[1].mcid).toBe(0); // still inside its /Figure
      expect(found.placements[7].matrix).toEqual(images[8].matrix); // the other /Im1 placement
    } finally {
      page.destroy();
    }
    const saved = mupdf.Document.openDocument(new Uint8Array(s.save().bytes), "application/pdf").asPDF()!;
    try {
      expect(saved.getTrailer().get("Root", "StructTreeRoot", "K", "K").length).toBe(3);
    } finally {
      saved.destroy();
    }
  });

  it("an image moved where an outer clip hides it is still found (the safety check agrees)", () => {
    const s = open(fixture("chrome-images.pdf"));
    // Into the corner, outside Chrome's page clip (28 pt margins): MuPDF still reports the draw.
    s.transformImage(0, 0, [20, 0, 0, 20, 2, 2]);
    const [img] = s.images(0);
    expect(img.movable).toBe(true);
    expectMatrix(img.matrix, [20, 0, 0, 20, 2, 2]);
    s.transformImage(0, 0, [180, 0, 0, 120, 50.5, 119.5]);
    expectMatrix(s.images(0)[0].matrix, [180, 0, 0, 120, 50.5, 119.5]);
  });

  it("20 moves in a row are folded into the block's own cm: the content does not grow", () => {
    const s = open(SYNTHETIC);
    const start = s.images(0)[1].matrix, size = contentOf(s, 0).length;
    for (let k = 0; k < 20; k++) s.transformImage(0, 1, moved(s.images(0)[1].matrix, 3, -2));
    expectMatrix(s.images(0)[1].matrix, moved(start, 60, -40), 1e-3);
    expect(Math.abs(contentOf(s, 0).length - size)).toBeLessThan(8);
    expect(s.edits()).toHaveLength(20);
  });

  it("an image without a block of its own is wrapped, and moves again by its new block", () => {
    const s = open(SYNTHETIC);
    const h = s.images(0)[7]; // the frame stroked in the same block stays where it was
    s.transformImage(0, 7, moved(h.matrix, -120, 0));
    const size = contentOf(s, 0).length;
    s.transformImage(0, 7, moved(s.images(0)[7].matrix, 5, 5));
    expectMatrix(s.images(0)[7].matrix, moved(h.matrix, -115, 5));
    expect(Math.abs(contentOf(s, 0).length - size)).toBeLessThan(8);
    const strokes = (ev: Drawn[]) => ev.filter((e) => e.t === "stroke");
    expect(strokes(liveTrace(s, 0))).toEqual(strokes(liveTrace(open(SYNTHETIC), 0)));
  });

  it("numbers are written without exponents", () => {
    expect(num(1e-7)).toBe("0");
    expect(num(0.000123456)).toBe("0.000123");
    expect(num(-12345678.9)).toBe("-12345679");
    expect(num(1 / 3)).toBe("0.333333");
    expect(num(-0.0000001)).toBe("0");
    expect(num(612)).toBe("612");
    const s = open(SYNTHETIC);
    s.transformImage(0, 1, aboutCentre(s.images(0)[1].matrix, concat(scaling(0.01, 0.01), rotation(33.3))));
    for (const o of operations(contentOf(s, 0))) for (const a of o.args) expect(String(a.num ?? "")).not.toMatch(/e/i);
    expect(contentOf(s, 0)).not.toMatch(/\d[eE][+-]?\d/);
  });
});

describe("checks", () => {
  it("refuses a bad matrix, image or page: nothing is logged", () => {
    const s = open(SYNTHETIC);
    const m = s.images(0)[1].matrix;
    const bad: unknown[] = [
      [NaN, 0, 0, 150, 50, 92], [Infinity, 0, 0, 150, 50, 92], [200, 0, 0, 150, 50], [200, 0, 0, 150, 50, 92, 1],
      ["200", 0, 0, 150, 50, 92], null, "matrix", { 0: 1 },
      [200, 100, 400, 200, 50, 92], // degenerate: both sides along one line
      [0.5, 0, 0, 150, 50, 92], [200, 0, 0, 0.9, 50, 92], // a side shorter than MIN_IMAGE_SIDE
      [MAX_IMAGE_SIDE + 1, 0, 0, 150, -7000, 92], // longer than MAX_IMAGE_SIDE
      [200, 0, 0, 150, 600, 92], [200, 0, 0, 150, 50, -100], // the centre off the page
    ];
    for (const matrix of bad) expectSessionError(() => s.transformImage(0, 1, matrix as Matrix), "bad-request");
    for (const index of [-1, 9, 1.5, NaN, "1" as unknown as number]) {
      expectSessionError(() => s.transformImage(0, index, m), "bad-request");
      expectSessionError(() => s.deleteImage(0, index), "bad-request");
      expectSessionError(() => s.renderImage(0, index, 1), "bad-request");
    }
    expectSessionError(() => s.images(2), "bad-request");
    expectSessionError(() => s.transformImage(5, 0, m), "bad-request");
    expectSessionError(() => s.renderImage(0, 1, 0), "bad-request");
    expectSessionError(() => s.renderImage(0, 1, Infinity), "bad-request");
    expect(s.edits()).toEqual([]);
    // A rotated picture whose quad leaves the page is fine as long as its centre is on it.
    s.transformImage(0, 1, [200, 0, 0, 150, 500, 700]);
    expect(s.edits()).toHaveLength(1);
    expectSessionError(() => new EngineSession(mupdf).images(0), "no-document");
  });

  it("a picture with a side under 1 pt can be moved and turned, not made thinner", () => {
    const bytes = makePdf((doc) => {
      const im = rgbImage(doc, 1, 1, () => [0, 0, 0]);
      // A 1-pixel spacer drawn at 0.75 pt (as HTML-to-PDF writes them) and a 0.5 pt rule.
      doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, { XObject: { Im: im } }, "q 0.75 0 0 0.75 100 100 cm /Im Do Q\nq 200 0 0 0.5 100 400 cm /Im Do Q"));
    });
    const s = open(bytes);
    for (const k of [0, 1]) {
      const m = s.images(0)[k];
      expect(m.movable).toBe(true);
      s.transformImage(0, k, moved(m.matrix, 10, 0));
      s.transformImage(0, k, aboutCentre(s.images(0)[k].matrix, rotation(90)));
      expect(sides(s.images(0)[k].matrix).map(r3)).toEqual(sides(m.matrix).map(r3));
    }
    // (scaled along the picture's own sides)
    const rule = s.images(0)[1].matrix;
    expectSessionError(() => s.transformImage(0, 1, concat(scaling(1, 0.5), rule)), "bad-request");
    s.transformImage(0, 1, concat(scaling(0.5, 1), rule)); // the long side may change
    s.transformImage(0, 1, concat(scaling(1, 4), s.images(0)[1].matrix)); // and the short one grow
    expect(Math.min(...sides(s.images(0)[1].matrix))).toBeCloseTo(2, 3);
  });

  it("the image's own matrix is a no-op: nothing logged, redo kept", () => {
    const s = open(SYNTHETIC);
    const m = s.images(0)[1].matrix;
    s.transformImage(0, 1, moved(m, 10, 10));
    s.undo();
    const r = s.transformImage(0, 1, moved(m, 0.0004, -0.0004));
    expect(r).toEqual({ editCount: 0, canUndo: false, canRedo: true, changedPages: [], pageIndex: 0, imageIndex: 1 });
    expect(s.edits()).toEqual([]);
    expect(s.redo().editCount).toBe(1);
  });

  it("edits() returns copies of the log, as plain data", () => {
    const s = open(SYNTHETIC);
    const m = s.images(0)[1].matrix, target = moved(m, 10, 10);
    s.transformImage(0, 1, target);
    const [edit] = s.edits();
    expect(edit).toEqual({ kind: "image", pageIndex: 0, imageIndex: 1, expect: m, op: "transform", matrix: target });
    if (edit.kind === "image" && edit.op === "transform") edit.matrix[4] = 999;
    expect(s.edits()[0]).toMatchObject({ matrix: target });
    const line = s.lines(0).find((l) => l.text.trim() === "Footer line")!;
    s.replaceLine(0, line.index, "Footer");
    expect(s.edits()[1]).toEqual({ kind: "text", pageIndex: 0, find: "Footer line", occurrence: 0, replacement: "Footer" });
  });
});

describe("replacing an image", () => {
  const JPEG = pictureFile("jpeg", 100, 40, (x) => [200, 60 + x, 40]);

  it("a JPEG: embedded as it is, fitted inside the old box, the other placements of the picture stay", () => {
    const s = open(SYNTHETIC);
    const before = s.images(0);
    const r = s.replaceImage(0, 2, JPEG);
    expect(r).toMatchObject({ pageIndex: 0, imageIndex: 2, editCount: 1, changedPages: [0] });
    const after = s.images(0);
    expect(after).toHaveLength(9);
    // 100:40 inside 120 × 90: 120 × 48, centred.
    expectMatrix(after[2].matrix, [120, 0, 0, 48, 350, 123]);
    expect([after[2].pixelWidth, after[2].pixelHeight]).toEqual([100, 40]);
    for (const k of [1, 8]) expect(after[k]).toEqual(before[k]); // /Im1 elsewhere: unchanged
    const added = xobject(s, 0, "PEImg1");
    expect(added.get("Filter").asName()).toBe("DCTDecode");
    const raw = added.readRawStream();
    try {
      expect(raw.getLength()).toBe(JPEG.length);
    } finally {
      raw.destroy();
    }
    // In the saved file too, and the painting order is kept (#2 still drawn after #1, before #3).
    const ev = withoutClips(savedTrace(s.save().bytes, 0)).filter(isImage);
    expect(ev[2]).toMatchObject({ w: 100, h: 40 });
    expectMatrix(ev[2].ctm, [120, 0, 0, 48, 350, 123]);
  });

  it("keeps the rotation, the centre and the proportions of the new picture", () => {
    const s = open(SYNTHETIC);
    const c = s.images(0)[2].matrix;
    s.transformImage(0, 2, aboutCentre(c, rotation(30)));
    const rotated = s.images(0)[2].matrix;
    s.replaceImage(0, 2, pictureFile("jpeg", 80, 40, () => [10, 200, 10]));
    const m = s.images(0)[2].matrix;
    // (the numbers written into the content have about 7 significant digits)
    expect(angle(m)).toBeCloseTo(angle(rotated), 4);
    expect(centreOf(m)[0]).toBeCloseTo(centreOf(rotated)[0], 3);
    expect(centreOf(m)[1]).toBeCloseTo(centreOf(rotated)[1], 3);
    const [w, h] = sides(m), [W, H] = sides(rotated);
    expect(w / h).toBeCloseTo(2, 4);
    expect(w).toBeCloseTo(W, 3); // 2:1 is wider than 120:90: the width fills the box
    expect(h).toBeLessThan(H);
  });

  it("a PNG with transparency: an /SMask, and the page shows through", () => {
    const s = open(SYNTHETIC);
    // Left half transparent, right half opaque blue (premultiplied pixels).
    const png = pictureFile("png", 60, 60, (x) => (x < 30 ? [0, 0, 0, 0] : [20, 40, 220, 255]));
    s.replaceImage(0, 1, png);
    const m = s.images(0)[1].matrix; // 150 × 150 square in the 200 × 150 box
    expectMatrix(m, [150, 0, 0, 150, 75, 92]);
    expect(xobject(s, 0, "PEImg1").get("SMask").isStream()).toBe(true);
    const shown = s.render(0, 1);
    const at = (x: number, y: number) => Array.from(shown.rgba.slice((Math.floor(y) * shown.width + Math.floor(x)) * 4, (Math.floor(y) * shown.width + Math.floor(x)) * 4 + 3));
    expect(at(90, 120)).toEqual([255, 255, 255]); // transparent part: the white page
    const right = at(200, 120);
    expect(right[2]).toBeGreaterThan(200);
    expect(right[0]).toBeLessThan(60);
  });

  it("refuses what is not a picture, before anything is done", () => {
    const s = open(SYNTHETIC);
    const garbage = new Uint8Array(4096).map((_, i) => (i * 7919) % 251);
    for (const bytes of [garbage, new Uint8Array(0), new TextEncoder().encode("%PDF-1.7 not a picture"), "abc" as unknown as Uint8Array])
      expectSessionError(() => s.replaceImage(0, 1, bytes), "bad-request");
    const huge = new Uint8Array(MAX_IMAGE_BYTES + 1);
    huge.set(JPEG);
    expectSessionError(() => s.replaceImage(0, 1, huge), "bad-request");
    expect(s.edits()).toEqual([]);
    // An ArrayBuffer works as well as a view, and the caller's bytes are copied.
    const copy = JPEG.slice();
    s.replaceImage(0, 1, copy.buffer);
    copy.fill(0);
    s.undo();
    s.redo();
    expect(s.images(0)[1]).toMatchObject({ pixelWidth: 100, pixelHeight: 40 });
  });

  it("replacing twice leaves only the last picture in the page's resources", () => {
    const s = open(SYNTHETIC);
    s.replaceImage(0, 2, JPEG);
    s.replaceImage(0, 2, pictureFile("jpeg", 50, 50, () => [0, 0, 0]));
    expect(xobject(s, 0, "PEImg1").isNull()).toBe(true);
    expect(xobject(s, 0, "PEImg2").isStream()).toBe(true);
    s.deleteImage(0, 2);
    expect(xobject(s, 0, "PEImg2").isNull()).toBe(true);
    expect(xobject(s, 0, "Im1").isStream()).toBe(true); // still drawn by B and I
  });

  it("a cropped picture: the new one fits the part that showed, and a form's /BBox still crops", () => {
    const bytes = makePdf((doc) => {
      const im = rgbImage(doc, 100, 100, (x, y) => [x * 2, y * 2, 120]);
      // #0 a 400 × 400 photo shown through a 100 × 100 /BBox; #1 a 600 × 600 photo cropped to its
      // bottom-left 100 × 100 by a clip in its own block. Text to the right of #0.
      const form = doc.addStream("q 400 0 0 400 0 0 cm /Im Do Q", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 100, 100], Resources: { XObject: { Im: im } } });
      const helv = helvetica(doc);
      const content = "q 1 0 0 1 50 600 cm /Fx Do Q\nq 300 50 100 100 re W n 600 0 0 600 300 50 cm /Im Do Q\nBT /F1 12 Tf 0 0 0 rg 160 640 Td (Neighbour) Tj ET";
      doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, { XObject: { Im: im, Fx: form }, Font: { F1: helv } }, content));
    });
    const s = open(bytes);
    const before = s.images(0), shown = s.render(0, 1);
    expect(before.map((i) => i.visible.map(r3))).toEqual([[50, 92, 150, 192], [300, 642, 400, 742]]);
    s.replaceImage(0, 0, pictureFile("jpeg", 100, 100, () => [230, 30, 30]));
    s.replaceImage(0, 1, pictureFile("jpeg", 200, 100, () => [30, 30, 230]));
    const after = s.images(0);
    // Square into the square that showed; 2:1 into it, centred: all of each new picture shows.
    expectMatrix(after[0].matrix, [100, 0, 0, 100, 50, 92]);
    expect(after[0].visible.map(r3)).toEqual([50, 92, 150, 192]);
    expectMatrix(after[1].matrix, [100, 0, 0, 50, 300, 667]);
    expect(after[1].visible.map(r3)).toEqual([300, 667, 400, 717]);
    expect(after.every((i) => i.movable)).toBe(true);
    // Nothing outside the parts that showed changed (the neighbouring text included).
    const now = s.render(0, 1);
    for (let y = 0; y < shown.height; y++)
      for (let x = 0; x < shown.width; x++) {
        const inside = before.some(({ visible: v }) => x >= v[0] - 1 && x < v[2] + 1 && y >= v[1] - 1 && y < v[3] + 1);
        const o = (y * shown.width + x) * 4;
        if (!inside) expect(Math.abs(shown.rgba[o] - now.rgba[o]) + Math.abs(shown.rgba[o + 1] - now.rgba[o + 1]), `${x},${y}`).toBeLessThan(6);
      }
    // The form's /BBox is written again around the new picture, as a clip.
    expect(contentOf(s, 0)).toMatch(/q 50 600 m 150 600 l 150 700 l 50 700 l h W n q 100 0 0 100 50 600 cm \/PEImg\d Do Q Q/);
  });

  it("every movable picture replaced: inside what showed of the old one, all of it showing, nothing else changed", () => {
    const file = pictureFile("jpeg", 90, 30, (x) => [x * 2, 100, 200]); // 3:1, unlike any of them
    for (const [name, bytes, movable] of SOURCES) {
      const ref = open(bytes);
      let checked = 0;
      for (let p = 0; p < docOf(ref).countPages(); p++) {
        const before = withoutPageGroup(withoutClips(liveTrace(ref, p))), calls = imageCalls(before), bounds = pageBounds(ref, p);
        for (const info of ref.images(p).filter((i) => i.movable)) {
          const s = open(bytes);
          s.replaceImage(p, info.index, file);
          const now = s.images(p)[info.index], k = calls[info.index];
          expect([now.pixelWidth, now.pixelHeight], name).toEqual([90, 30]);
          // Inside the part of the old picture that showed...
          for (let i = 0; i < 2; i++) expect(now.visible[i], `${name} #${info.index}`).toBeGreaterThanOrEqual(info.visible[i] - 0.5);
          for (let i = 2; i < 4; i++) expect(now.visible[i], `${name} #${info.index}`).toBeLessThanOrEqual(info.visible[i] + 0.5);
          // ...not cut by any clip (what shows is its whole box, within the page)...
          const shownBox = [Math.max(now.bbox[0], bounds[0]), Math.max(now.bbox[1], bounds[1]), Math.min(now.bbox[2], bounds[2]), Math.min(now.bbox[3], bounds[3])];
          expectBox(now.visible, shownBox, 0.5);
          // ...drawn where the old one was in the painting order, at its rotation, not mirrored; everything else as it was.
          const after = withoutPageGroup(withoutClips(liveTrace(s, p)));
          expect(after.length).toBe(before.length);
          expectMatrix(after[k].ctm, now.matrix);
          expect(Math.atan2(now.matrix[1], now.matrix[0])).toBeCloseTo(Math.atan2(info.matrix[1], info.matrix[0]), 3);
          expect(now.matrix[0] * now.matrix[3] - now.matrix[1] * now.matrix[2]).toBeGreaterThan(0);
          expect(after.filter((_, i) => i !== k)).toEqual(before.filter((_, i) => i !== k));
          expect(withoutPageGroup(withoutClips(savedTrace(s.save().bytes, p)))).toEqual(after);
          checked++;
        }
      }
      expect(checked).toBe(movable);
    }
  });

  it("a picture stored upside down, or mirrored: the new one is upright and not mirrored", () => {
    const bytes = makePdf((doc) => {
      // A mark in the bottom-left corner of the data, drawn flipped: it shows at the top left.
      const im = rgbImage(doc, 40, 20, (x, y) => (x < 8 && y >= 12 ? [0, 0, 0] : [200, 200, 255]));
      // #0 stored bottom-up and drawn upright; #1 mirrored left to right ("Flip horizontal").
      doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, { XObject: { Im: im } }, "q 200 0 0 -100 100 600 cm /Im Do Q\nq -200 0 0 100 500 100 cm /Im Do Q"));
    });
    const s = open(bytes);
    const old = s.images(0).map((i) => i.matrix);
    expect(old.map((m) => m[0] * m[3] - m[1] * m[2] < 0)).toEqual([true, true]);
    // The new picture has a black mark in its top-left corner.
    const png = pictureFile("png", 40, 20, (x, y) => (x < 8 && y < 5 ? [0, 0, 0] : [255, 200, 200]));
    s.replaceImage(0, 0, png);
    s.replaceImage(0, 1, png);
    const [a, b] = s.images(0);
    expectMatrix(a.matrix, [200, 0, 0, 100, 100, 192]); // the same box, upright
    expectMatrix(b.matrix, [200, 0, 0, 100, 300, 592]);
    const r = s.render(0, 1);
    const at = (x: number, y: number) => Array.from(r.rgba.slice((y * r.width + x) * 4, (y * r.width + x) * 4 + 3));
    expect(at(105, 197)).toEqual([0, 0, 0]); // top left: the mark
    expect(at(105, 287)).toEqual([255, 200, 200]); // bottom left
    expect(at(305, 597)).toEqual([0, 0, 0]);
    expect(at(495, 597)).toEqual([255, 200, 200]); // top right
  });

  it("replacing again takes the place of the replacement: no nesting, fitted inside the picture that is there", () => {
    const s = open(SYNTHETIC);
    const qs = () => [...operations(contentOf(s, 0))].filter((o) => o.op === "q").length;
    const start = qs();
    s.replaceImage(0, 2, pictureFile("jpeg", 50, 100, () => [250, 0, 0]));
    const first = s.images(0)[2].matrix;
    expect(qs()).toBe(start); // "q 120 0 0 90 350 600 cm /Im1 Do Q" became the replacement's own block
    for (let k = 0; k < 5; k++) s.replaceImage(0, 2, pictureFile("jpeg", 100, 100, () => [0, 250, k * 40]));
    expect(qs()).toBe(start);
    expectMatrix(s.images(0)[2].matrix, containFit(first, 1, 1));
    // And a form's (E) replacement, whose clip is written again: one block more, once.
    s.replaceImage(0, 4, pictureFile("jpeg", 40, 40, () => [10, 200, 10]));
    const withForm = qs();
    s.replaceImage(0, 4, pictureFile("jpeg", 60, 40, () => [10, 20, 200]));
    expect(qs()).toBe(withForm);
    // (the second fitted inside the first: E's /BBox is 150 × 100, the first 100 × 100 in it)
    expect(s.images(0)[4].visible.map(r3)).toEqual([85, 458.667, 185, 525.333]);
  });

  it("the same picture put in several places is embedded once", () => {
    const bytes = makePdf((doc) => {
      const logo = rgbImage(doc, 8, 8, (x, y) => [x * 30, y * 30, 100]);
      for (let p = 0; p < 4; p++) doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, { XObject: { Logo: logo } }, "q 100 0 0 100 50 650 cm /Logo Do Q"));
    });
    const s = open(bytes);
    const jpeg = pictureFile("jpeg", 300, 200, (x, y) => [x % 256, y % 256, 90]);
    for (let p = 0; p < 4; p++) s.replaceImage(p, 0, jpeg);
    const saved = s.save().bytes;
    expect(objectsOf(saved).sizes).toEqual(["300x200"]);
    expect(saved.byteLength).toBeLessThan(jpeg.length * 2);
    // Replays build the same pages.
    s.undo();
    s.redo();
    expect(s.images(3)[0]).toMatchObject({ pixelWidth: 300, pixelHeight: 200 });
  });

  it("no colour profile of MuPDF's (Artifex's) in the download: device colour, or the picture's own profile", () => {
    // word-images.pdf has none to begin with.
    const pictures: [Uint8Array, string][] = [
      [pictureFile("jpeg", 20, 10, () => [200, 30, 30]), "DeviceRGB"],
      [pictureFile("png", 20, 10, (x) => (x < 10 ? [0, 0, 0, 0] : [20, 40, 220, 255])), "DeviceRGB"],
      [(() => {
        const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, 8, 8], true);
        try {
          pix.clear(100);
          return pix.asPNG().slice();
        } finally {
          pix.destroy();
        }
      })(), "DeviceGray"],
    ];
    const s = open(fixture("word-images.pdf"));
    expect(objectsOf(s.save().bytes).texts.some((t) => t.includes("Artifex"))).toBe(false);
    pictures.forEach(([file, space], k) => {
      expect(embedsProfile(file)).toBe(false);
      s.replaceImage(0, k, file);
      const added = xobject(s, 0, `PEImg${k + 1}`);
      expect(added.get("ColorSpace").asName()).toBe(space);
      if (added.get("SMask").isStream()) expect(added.get("SMask").get("ColorSpace").asName()).toBe("DeviceGray");
    });
    // A JPEG with a profile of its own keeps it.
    const icc = srgbProfile(), own = withProfile(pictureFile("jpeg", 20, 10, () => [30, 200, 30]), icc);
    expect(embedsProfile(own)).toBe(true);
    s.replaceImage(0, 3, own);
    const cs = xobject(s, 0, "PEImg4").get("ColorSpace");
    expect(cs.get(0).asName()).toBe("ICCBased");
    const buf = cs.get(1).readStream();
    try {
      expect(buf.asUint8Array()).toEqual(icc);
    } finally {
      buf.destroy();
    }
    for (const bytes of [s.save().bytes, s.save(SAVE_PDFA).bytes]) expect(objectsOf(bytes).texts.some((t) => t.includes("Artifex"))).toBe(false);
  });

  it("a picture in a layer (optional content): the new one is in that layer too", () => {
    const bytes = makePdf((doc) => {
      const im = rgbImage(doc, 8, 8, () => [200, 0, 0]);
      const watermark = doc.addObject({ Type: "OCG", Name: doc.newString("Watermark"), Usage: { Print: { PrintState: "OFF" } } });
      const extra = doc.addObject({ Type: "OCG", Name: doc.newString("Extra") });
      doc.getTrailer().get("Root").put("OCProperties", { OCGs: [watermark, extra], D: { ON: [watermark, extra], Order: [watermark, extra] } });
      const layered = rgbImage(doc, 8, 8, () => [0, 0, 200]);
      layered.put("OC", watermark);
      // #1: a form in the "Extra" layer drawing the layered picture.
      const form = doc.addStream("q 100 0 0 100 0 0 cm /WM Do Q", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 100, 100], Resources: { XObject: { WM: layered } } });
      form.put("OC", extra);
      doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, { XObject: { Im: im, WM: layered, F: form } },
        "q 100 0 0 100 50 50 cm /WM Do Q\nq 1 0 0 1 300 300 cm /F Do Q\nq 100 0 0 100 50 300 cm /Im Do Q"));
    });
    const s = open(bytes);
    expect(s.images(0).map((i) => i.movable)).toEqual([true, true, true]);
    for (const k of [0, 1, 2]) s.replaceImage(0, k, pictureFile("jpeg", 20, 20, () => [0, 200, 0]));
    const saved = new Uint8Array(s.save().bytes);
    const layerOf = (doc: mupdf.PDFDocument, k: number) => doc.findPage(0).get("Resources", "XObject", `PEImg${k}`).get("OC");
    // The pictures drawn with layer `name` switched off.
    const drawnWithOff = (name: string) => {
      const doc = mupdf.Document.openDocument(saved, "application/pdf").asPDF()!;
      try {
        expect(layerOf(doc, 1).get("Name").asString()).toBe("Watermark");
        expect(layerOf(doc, 3).isNull()).toBe(true);
        // The form's layer and the picture's: shown only when both are on. (MuPDF 1.27 itself
        // does not hide what such a dictionary says to hide; other readers do.)
        const both = layerOf(doc, 2);
        expect(both.get("P").asName()).toBe("AllOn");
        expect([0, 1].map((k) => both.get("OCGs").get(k).get("Name").asString())).toEqual(["Extra", "Watermark"]);
        const ocgs = doc.getTrailer().get("Root", "OCProperties", "OCGs");
        const off = doc.newArray();
        for (let k = 0; k < ocgs.length; k++) if (ocgs.get(k).get("Name").asString() === name) off.push(ocgs.get(k));
        doc.getTrailer().get("Root", "OCProperties", "D").put("OFF", off);
        doc.getTrailer().get("Root", "OCProperties", "D").delete("ON");
        return savedTrace(saveBytes(doc, ""), 0).filter(isImage).map((e) => e.ctm);
      } finally {
        doc.destroy();
      }
    };
    const first = s.images(0)[0].matrix, last = s.images(0)[2].matrix;
    expect(drawnWithOff("Watermark")).not.toContainEqual(first);
    expect(drawnWithOff("Watermark")).toContainEqual(last);
    expect(drawnWithOff("Extra")).toContainEqual(first);
  });
});

describe("what leaves the file", () => {
  it("a deleted or replaced picture is not in the download (normal or PDF/A) when nothing else draws it", () => {
    // word-images.pdf #3 is its only placement of a 147 × 133 photo (/Image15).
    const ref = open(fixture("word-images.pdf"));
    expect(objectsOf(ref.save().bytes).sizes).toContain("147x133");
    for (const edit of ["delete", "replace"]) {
      const s = open(fixture("word-images.pdf"));
      if (edit === "delete") s.deleteImage(0, 3);
      else s.replaceImage(0, 3, pictureFile("jpeg", 20, 10, () => [200, 0, 0]));
      for (const bytes of [s.save().bytes, s.save(SAVE_PDFA).bytes]) {
        expect(objectsOf(bytes).sizes, edit).not.toContain("147x133");
        expect(xobjectNames(bytes, 0), edit).not.toContain("Image15");
      }
      // The other pictures stay.
      expect(objectsOf(s.save().bytes).sizes).toEqual(expect.arrayContaining(["240x160", "120x120"]));
    }
    // Chrome's #3 (240 × 97, /X13) too.
    const chrome = open(fixture("chrome-images.pdf"));
    chrome.deleteImage(0, 3);
    expect(objectsOf(chrome.save().bytes).sizes).not.toContain("240x97");
  });

  it("a picture another placement, another page or a form still draws stays", () => {
    // The synthetic fixture draws /Im1 three times: deleting one leaves the others.
    const s = open(SYNTHETIC);
    s.deleteImage(0, 2);
    expect(xobject(s, 0, "Im1").isStream()).toBe(true);
    expect(objectsOf(s.save().bytes).sizes).toContain("64x48");
    // Two pages sharing one /Resources dictionary (as many producers write it), and a form
    // without resources of its own, which draws with the page's.
    const bytes = makePdf((doc) => {
      const im = rgbImage(doc, 6, 6, (x, y) => [x * 40, y * 40, 90]);
      const form = doc.addStream("q 50 0 0 50 0 0 cm /Im Do Q", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 60, 60] });
      const resources = doc.addObject({ XObject: { Im: im, F: form } });
      doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, {}, "q 100 0 0 100 50 50 cm /Im Do Q\nq 1 0 0 1 300 300 cm /F Do Q"));
      doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, {}, "q 100 0 0 100 300 300 cm /Im Do Q"));
      doc.findPage(0).put("Resources", resources);
      doc.findPage(1).put("Resources", resources);
    });
    const second = savedTrace(bytes, 1);
    // #0 deleted: the form still draws /Im with the page's resources.
    const a = open(bytes);
    a.deleteImage(0, 0);
    expect(xobject(a, 0, "Im").isStream()).toBe(true);
    // ...and the form deleted too: /Im and /F leave page 1's resources. Page 2 keeps /Im; /F,
    // which only page 1 drew, leaves the dictionary the pages shared too.
    a.deleteImage(0, 0);
    expect(a.images(0)).toEqual([]);
    const saved = a.save().bytes;
    expect(xobjectNames(saved, 0)).toEqual([]);
    expect(xobjectNames(saved, 1)).toEqual(["Im"]);
    expect(savedTrace(saved, 1)).toEqual(second);
    expect(objectsOf(saved).sizes).toEqual(["6x6"]);
  });

  it("a replacement replaced again after a text edit renamed it is not kept either", () => {
    const s = open(SYNTHETIC);
    s.replaceImage(0, 2, pictureFile("jpeg", 30, 30, () => [250, 0, 0]));
    // The text edit's redaction rewrites the page's content and renames its resources (PEImg1 too).
    s.replaceLine(0, s.lines(0).find((l) => l.text.trim() === "Footer line")!.index, "Footer edited");
    s.replaceImage(0, 2, pictureFile("jpeg", 40, 20, () => [0, 0, 250]));
    expect(objectsOf(s.save().bytes).sizes).not.toContain("30x30");
    expect(objectsOf(s.save().bytes).sizes).toContain("40x20");
  });

  /** A picture of w × h pixels, all one colour. */
  const plain = (doc: mupdf.PDFDocument, w: number, h: number, v = 90) => rgbImage(doc, w, h, () => [v, v, v]);

  it("one /Resources for every page (FPDF, TCPDF): a picture drawn only on the edited page leaves it, one another page draws stays", () => {
    // A logo on both pages; a signature and a stamp on page 1 only.
    const bytes = makePdf((doc) => {
      const resources = doc.addObject({ XObject: { Logo: plain(doc, 50, 20), Sig: plain(doc, 77, 33), Stamp: plain(doc, 60, 60) } });
      doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, resources, "q 100 0 0 40 50 780 cm /Logo Do Q q 154 0 0 66 300 100 cm /Sig Do Q q 60 0 0 60 400 300 cm /Stamp Do Q"));
      doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, resources, "q 100 0 0 40 50 780 cm /Logo Do Q"));
    });
    const second = savedTrace(bytes, 1);
    for (const edit of ["delete", "replace"]) {
      const s = open(bytes);
      if (edit === "delete") s.deleteImage(0, 1);
      else s.replaceImage(0, 1, pictureFile("jpeg", 20, 10, () => [200, 0, 0]));
      for (const saved of [s.save().bytes, s.save(SAVE_PDFA).bytes]) {
        expect(imageSizes(saved), edit).not.toContain("77x33");
        expect(imageSizes(saved), edit).toEqual(expect.arrayContaining(["50x20", "60x60"]));
        expect(xobjectNames(saved, 1), edit).toEqual(["Logo", "Stamp"]); // the stamp: page 1 still draws it
      }
      expect(savedTrace(s.save().bytes, 1), edit).toEqual(second);
      // A second edit of the page (which has resources of its own by now): the stamp leaves the shared dictionary too.
      s.deleteImage(0, s.images(0).findIndex((i) => i.pixelWidth === 60));
      const saved = s.save().bytes;
      expect(imageSizes(saved), edit).not.toContain("60x60");
      expect(xobjectNames(saved, 1), edit).toEqual(["Logo"]);
      expect(savedTrace(saved, 1), edit).toEqual(second);
    }
  });

  it("resources inherited from the page tree: the picture leaves them too when no page draws it", () => {
    const build = (pages: string[]) => makePdf((doc) => {
      for (const content of pages) {
        const page = doc.addPage([0, 0, 595, 842], 0, {}, content);
        page.delete("Resources");
        doc.insertPage(-1, page);
      }
      doc.getTrailer().get("Root", "Pages").put("Resources", doc.addObject({ XObject: { Logo: plain(doc, 50, 20), Sig: plain(doc, 77, 33) } }));
    });
    // One page: what it inherited stays in the page tree, without the signature.
    const one = open(build(["q 154 0 0 66 300 100 cm /Sig Do Q"]));
    one.deleteImage(0, 0);
    expect(one.images(0)).toEqual([]);
    for (const saved of [one.save().bytes, one.save(SAVE_PDFA).bytes]) expect(imageSizes(saved)).not.toContain("77x33");
    // Two pages: the second inherits the logo and keeps it.
    const two = build(["q 100 0 0 40 50 780 cm /Logo Do Q q 154 0 0 66 300 100 cm /Sig Do Q", "q 100 0 0 40 50 780 cm /Logo Do Q"]);
    const second = savedTrace(two, 1);
    const s = open(two);
    s.deleteImage(0, 1);
    const saved = s.save().bytes;
    expect(imageSizes(saved)).toEqual(["50x20"]);
    expect(savedTrace(saved, 1)).toEqual(second);
  });

  it("after a text edit gave the page resources of its own, the picture leaves the dictionary the other pages keep", () => {
    const bytes = makePdf((doc) => {
      const resources = doc.addObject({ XObject: { Logo: plain(doc, 50, 20), Sig: plain(doc, 77, 33) }, Font: { F1: helvetica(doc) } });
      doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, resources, "q 100 0 0 40 50 780 cm /Logo Do Q BT /F1 12 Tf 50 600 Td (Invoice line one) Tj ET q 154 0 0 66 300 100 cm /Sig Do Q"));
      doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, resources, "q 100 0 0 40 50 780 cm /Logo Do Q BT /F1 12 Tf 50 600 Td (Second page) Tj ET"));
    });
    const second = savedTrace(bytes, 1);
    const s = open(bytes);
    // The redaction behind a text edit gives page 1 new resources, renamed; page 2 keeps the shared ones.
    s.replaceLine(0, s.lines(0).find((l) => l.text.includes("Invoice"))!.index, "Invoice line edited");
    expect(docOf(s).findPage(0).get("Resources").isIndirect()).toBe(false);
    s.deleteImage(0, s.images(0).findIndex((i) => i.pixelWidth === 77));
    const saved = s.save().bytes;
    expect(imageSizes(saved)).toEqual(["50x20"]);
    expect(savedTrace(saved, 1)).toEqual(second);
    expect(s.lines(0).map((l) => l.text.trim())).toContain("Invoice line edited");
  });

  it("a form whose /Resources is the page's own dictionary: the picture leaves it too", () => {
    const bytes = makePdf((doc) => {
      const resources = doc.addObject({ XObject: { Sig: plain(doc, 77, 33) } });
      const form = doc.addStream("0 0 1 rg 0 0 50 50 re f", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 50, 50], Group: { S: "Transparency" } });
      form.put("Resources", resources);
      resources.get("XObject").put("Fm0", form);
      doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, resources, "q 154 0 0 66 100 100 cm /Sig Do Q q 1 0 0 1 300 300 cm /Fm0 Do Q"));
    });
    const square = savedTrace(bytes, 0).filter((e) => e.t === "fill");
    const s = open(bytes);
    s.deleteImage(0, 0);
    expect(s.images(0)).toEqual([]);
    for (const saved of [s.save().bytes, s.save(SAVE_PDFA).bytes]) expect(imageSizes(saved)).toEqual([]);
    expect(savedTrace(s.save().bytes, 0).filter((e) => e.t === "fill")).toEqual(square); // the form still draws its square
  });

  it("what another page draws cannot be read, or names what the dictionary lacks: the shared dictionary keeps everything", () => {
    for (const other of ["unreadable", "unknown name"]) {
      const bytes = makePdf((doc) => {
        const resources = doc.addObject({ XObject: { Logo: plain(doc, 50, 20), Sig: plain(doc, 77, 33) } });
        doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, resources, "q 154 0 0 66 300 100 cm /Sig Do Q"));
        doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, resources, "q 100 0 0 40 50 780 cm /Logo Do Q q 10 0 0 10 0 0 cm /Missing Do Q"));
        if (other === "unreadable") doc.findPage(1).put("Contents", undecodable(doc, {}));
      });
      const s = open(bytes);
      s.deleteImage(0, 0);
      expect(s.images(0), other).toEqual([]);
      const saved = s.save().bytes;
      expect(xobjectNames(saved, 0), other).toEqual([]); // the page's own copy
      expect(xobjectNames(saved, 1), other).toEqual(["Logo", "Sig"]);
      expect(imageSizes(saved), other).toContain("77x33");
    }
  });

  it("a name written with #-escapes is the name MuPDF reads: the cleanup keeps what is drawn under it", () => {
    // "/Logo#20A" draws the key "Logo A": in an annotation's appearance (with no resources of its
    // own, so the page's), in a pattern's cell, and on a page that also paints with a pattern or
    // a Type 3 font (where MuPDF may draw images that are not placements). The other picture is
    // deleted.
    for (const where of ["appearance", "pattern cell", "page with a pattern", "page with a Type 3 font"]) {
      const bytes = makePdf((doc) => {
        const resources: Record<string, unknown> = { XObject: { "Logo A": rgbImage(doc, 16, 16, () => [220, 30, 30]), Other: rgbImage(doc, 16, 16, () => [30, 30, 220]) } };
        let content = "q 100 0 0 100 300 300 cm /Other Do Q\n";
        if (where === "pattern cell" || where === "page with a pattern") {
          const cell = where === "pattern cell" ? "q 50 0 0 50 0 0 cm /Logo#20A Do Q" : "0 1 0 rg 0 0 50 50 re f";
          resources.Pattern = { P0: doc.addStream(cell, { Type: "Pattern", PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 50, 50], XStep: 50, YStep: 50 }) };
          content += "q /Pattern cs /P0 scn 50 50 200 200 re f Q\n";
        }
        if (where === "page with a Type 3 font") {
          const glyph = doc.addStream("1000 0 d0 0 0 1000 1000 re f", {});
          const encoding = doc.addObject({ Type: "Encoding", Differences: [97, doc.newName("a")] });
          resources.Font = { T3: doc.addObject({ Type: "Font", Subtype: "Type3", FontBBox: [0, 0, 1000, 1000], FontMatrix: [0.001, 0, 0, 0.001, 0, 0], CharProcs: { a: glyph }, Encoding: encoding, FirstChar: 97, LastChar: 97, Widths: [1000] }) };
          content += "BT /T3 20 Tf 400 700 Td (a) Tj ET\n";
        }
        if (where.startsWith("page with")) content += "q 100 0 0 100 50 600 cm /Logo#20A Do Q\n";
        const page = doc.addPage([0, 0, 612, 792], 0, doc.addObject(resources), content);
        if (where === "appearance") {
          const ap = doc.addStream("q 100 0 0 100 0 0 cm /Logo#20A Do Q", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 100, 100] });
          page.put("Annots", [doc.addObject({ Type: "Annot", Subtype: "Stamp", Rect: [50, 600, 150, 700], AP: { N: ap }, F: 4 })]);
        }
        doc.insertPage(-1, page);
      });
      const s = open(bytes);
      const other = s.images(0).findIndex((i) => Math.abs(i.matrix[4] - 300) < 0.01);
      s.deleteImage(0, other);
      const saved = s.save().bytes;
      expect(xobjectNames(saved, 0), where).toEqual(["Logo A"]);
      expect(changedOutside(pagePixels(bytes, 0), pagePixels(saved, 0), [300, 392, 400, 492]), where).toBe(0);
    }
  });

  it("an appearance, a pattern or Type 3 glyphs the cleanup cannot decode: delete and replace work, nothing is pruned", () => {
    for (const where of ["none", "appearance", "pattern", "Type 3 glyph"]) {
      const bytes = makePdf((doc) => {
        const im = rgbImage(doc, 8, 8, () => [200, 0, 0]);
        const resources: Record<string, unknown> = { XObject: { Im: im, Spare: plain(doc, 5, 5) } };
        if (where === "pattern") resources.Pattern = { P0: undecodable(doc, { Type: "Pattern", PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 10, 10], XStep: 10, YStep: 10 }) };
        if (where === "Type 3 glyph") {
          const encoding = doc.addObject({ Type: "Encoding", Differences: [97, doc.newName("a")] });
          resources.Font = { T3: doc.addObject({ Type: "Font", Subtype: "Type3", FontBBox: [0, 0, 1000, 1000], FontMatrix: [0.001, 0, 0, 0.001, 0, 0], CharProcs: { a: undecodable(doc, {}) }, Encoding: encoding, FirstChar: 97, LastChar: 97, Widths: [1000] }) };
        }
        const page = doc.addPage([0, 0, 612, 792], 0, doc.addObject(resources), "q 100 0 0 100 100 100 cm /Im Do Q q 50 0 0 50 300 300 cm /Im Do Q");
        if (where === "appearance")
          page.put("Annots", [doc.addObject({ Type: "Annot", Subtype: "Stamp", Rect: [400, 400, 410, 410], AP: { N: undecodable(doc, { Type: "XObject", Subtype: "Form", BBox: [0, 0, 10, 10] }) }, F: 4 })]);
        doc.insertPage(-1, page);
      });
      const s = open(bytes);
      expect(s.images(0).map((i) => i.movable), where).toEqual([true, true]);
      s.deleteImage(0, 1);
      s.replaceImage(0, 0, pictureFile("jpeg", 10, 10, () => [0, 200, 0]));
      expect(s.images(0).map((i) => i.pixelWidth), where).toEqual([10]);
      // /Spare, which nothing draws, is pruned only when everything that may draw it can be read.
      expect(xobject(s, 0, "Spare").isStream(), where).toBe(where !== "none");
      expect(s.save().bytes.byteLength).toBeGreaterThan(0);
    }
  });

  it("the structure element of a replaced or deleted picture loses its description", () => {
    const s = open(SYNTHETIC);
    s.replaceImage(0, 1, pictureFile("jpeg", 30, 30, () => [250, 0, 0])); // B, /Figure MCID 0
    s.deleteImage(0, 2); // C, /Figure MCID 2
    const elements = structElements(s.save().bytes);
    expect(elements).toEqual([
      { S: "Document", Alt: null, ActualText: null },
      { S: "Figure", Alt: null, ActualText: null },
      { S: "P", Alt: null, ActualText: null },
      { S: "Figure", Alt: null, ActualText: null },
    ]);
    expect(structElements(SYNTHETIC).map((e) => e.Alt)).toEqual([null, "A gradient with an F", null, "The gradient again"]);
    // A moved picture keeps it.
    const moving = open(SYNTHETIC);
    moving.transformImage(0, 1, moved(moving.images(0)[1].matrix, 10, 10));
    expect(structElements(moving.save().bytes)[1].Alt).toBe("A gradient with an F");
    // /ActualText goes too.
    const bytes = makePdf((doc) => {
      const im = rgbImage(doc, 8, 8, () => [200, 0, 0]);
      doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, { XObject: { Im: im } }, "/Figure <</MCID 0>> BDC q 100 0 0 100 50 50 cm /Im Do Q EMC"));
      const pageRef = doc.findPage(0);
      pageRef.put("StructParents", 0);
      const fig = doc.addObject({ Type: "StructElem", S: "Figure", Pg: pageRef, K: 0, Alt: doc.newString("Logo"), ActualText: doc.newString("ACME") });
      const tree = doc.addObject({ Type: "StructTreeRoot", K: fig, ParentTree: { Nums: [0, [fig]] }, ParentTreeNextKey: 1 });
      fig.put("P", tree);
      doc.getTrailer().get("Root").put("StructTreeRoot", tree);
    });
    expect(structElements(bytes)).toEqual([{ S: "Figure", Alt: "Logo", ActualText: "ACME" }]);
    const logo = open(bytes);
    logo.deleteImage(0, 0);
    expect(structElements(logo.save().bytes)).toEqual([{ S: "Figure", Alt: null, ActualText: null }]);
    // Word's tagged file: "Photo, first" describes #1.
    expect(structElements(fixture("word-images.pdf")).map((e) => e.Alt)).toContain("Photo, first");
    const word = open(fixture("word-images.pdf"));
    word.replaceImage(0, 1, pictureFile("jpeg", 30, 30, () => [250, 0, 0]));
    expect(structElements(word.save().bytes).map((e) => e.Alt)).not.toContain("Photo, first");
  });

  describe("descriptions of elements that are not only the picture", () => {
    /**
     * A tagged page: `content` (Helvetica as /F1, an 8 × 8 picture as /Im) and the structure tree
     * `elements` makes (the top elements, and the element of each MCID for the ParentTree).
     */
    const tagged = (content: string, elements: (doc: mupdf.PDFDocument, page: mupdf.PDFObject) => { top: mupdf.PDFObject[]; byMcid: mupdf.PDFObject[] }, roles?: Record<string, string>) =>
      makePdf((doc) => {
        doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, { XObject: { Im: rgbImage(doc, 8, 8, () => [200, 0, 0]) }, Font: { F1: helvetica(doc) } }, content));
        const page = doc.findPage(0);
        page.put("StructParents", 0);
        const { top, byMcid } = elements(doc, page);
        const tree = doc.addObject({ Type: "StructTreeRoot", K: top, ParentTree: { Nums: [0, byMcid] }, ParentTreeNextKey: 1, ...(roles ? { RoleMap: roles } : {}) });
        for (const e of top) e.put("P", tree);
        doc.getTrailer().get("Root").put("StructTreeRoot", tree);
      });
    const element = (doc: mupdf.PDFDocument, page: mupdf.PDFObject, S: string, K: unknown, alt: string, actual?: string) =>
      doc.addObject({ Type: "StructElem", S, Pg: page, K, Alt: doc.newString(alt), ...(actual ? { ActualText: doc.newString(actual) } : {}) });
    const text = "BT /F1 20 Tf 50 700 Td (H2O level) Tj ET";
    const icon = "q 20 0 0 20 200 695 cm /Im Do Q";

    it("a paragraph with text and an inline icon in one sequence keeps them, after a delete or a replace", () => {
      const bytes = tagged(`/P <</MCID 0>> BDC ${text} ${icon} EMC`, (doc, page) => {
        const p = element(doc, page, "P", 0, "Water level", "Water level, with the gauge icon");
        return { top: [p], byMcid: [p] };
      });
      const kept = [{ S: "P", Alt: "Water level", ActualText: "Water level, with the gauge icon" }];
      expect(structElements(bytes)).toEqual(kept);
      for (const edit of ["delete", "replace"]) {
        const s = open(bytes);
        if (edit === "delete") s.deleteImage(0, 0);
        else s.replaceImage(0, 0, pictureFile("jpeg", 30, 30, () => [0, 0, 250]));
        expect(structElements(s.save().bytes), edit).toEqual(kept);
        expect(s.lines(0).map((l) => l.text), edit).toEqual(["Water level, with the gauge icon"]); // MuPDF reads the text through it
      }
    });

    it("an element with other content keeps them; one that held only the picture loses them", () => {
      // P: the text (MCID 0) and a Span holding only the icon (MCID 1).
      const bytes = tagged(`/P <</MCID 0>> BDC ${text} EMC /Span <</MCID 1>> BDC ${icon} EMC`, (doc, page) => {
        const span = element(doc, page, "Span", 1, "Gauge icon");
        const p = element(doc, page, "P", [0, span], "Water level", "Water level, with the gauge icon");
        span.put("P", p);
        return { top: [p], byMcid: [p, span] };
      });
      const s = open(bytes);
      s.deleteImage(0, 0);
      expect(structElements(s.save().bytes)).toEqual([
        { S: "P", Alt: "Water level", ActualText: "Water level, with the gauge icon" },
        { S: "Span", Alt: null, ActualText: null },
      ]);
      // The icon's sequence in the paragraph's own content (K [0, 1]): the paragraph keeps them.
      const own = tagged(`/P <</MCID 0>> BDC ${text} EMC /P <</MCID 1>> BDC ${icon} EMC`, (doc, page) => {
        const p = element(doc, page, "P", [0, 1], "Water level", "Water level, with the gauge icon");
        return { top: [p], byMcid: [p, p] };
      });
      const t = open(own);
      t.deleteImage(0, 0);
      expect(structElements(t.save().bytes)).toEqual([{ S: "P", Alt: "Water level", ActualText: "Water level, with the gauge icon" }]);
    });

    it("a custom type the RoleMap makes a Figure loses them, even with a caption in its sequence", () => {
      const build = (roles?: Record<string, string>) => tagged(`/Logo <</MCID 0>> BDC ${icon} ${text} EMC`, (doc, page) => {
        const logo = element(doc, page, "Logo", 0, "ACME logo");
        return { top: [logo], byMcid: [logo] };
      }, roles);
      const mapped = open(build({ Logo: "Figure" }));
      mapped.deleteImage(0, 0);
      expect(structElements(mapped.save().bytes)).toEqual([{ S: "Logo", Alt: null, ActualText: null }]);
      const unmapped = open(build());
      unmapped.deleteImage(0, 0);
      expect(structElements(unmapped.save().bytes)).toEqual([{ S: "Logo", Alt: "ACME logo", ActualText: null }]);
    });
  });
});

describe("history", () => {
  /** What pages 1 and 2 look like to MuPDF, as one string. */
  const look = (doc: mupdf.PDFDocument) => JSON.stringify([traceOf(doc, 0), traceOf(doc, 1)]);
  const lineIndex = (s: EngineSession, page: number, text: string) => s.lines(page).find((l) => l.text.trim() === text)!.index;

  it("text and image edits mix; undo, redo and replays (from the original or a checkpoint) give the same pages", () => {
    const s = open(SYNTHETIC);
    const jpeg = pictureFile("jpeg", 100, 40, (x, y) => [x * 2, y * 5, 128]);
    const img = (page: number, index: number) => s.images(page)[index].matrix;
    const steps: [string, () => void][] = [
      ["move B", () => s.transformImage(0, 1, moved(img(0, 1), 280, 300))],
      ["text over B", () => s.replaceLine(0, lineIndex(s, 0, "Text over image"), "Text still in place")],
      ["rotate the cropped D", () => s.transformImage(0, 3, aboutCentre(img(0, 3), rotation(-15)))],
      ["footer text", () => s.replaceLine(0, lineIndex(s, 0, "Footer line"), "Footer edited after image moves")],
      ["delete I", () => s.deleteImage(0, 8)],
      ["move B again", () => s.transformImage(0, 1, moved(img(0, 1), -20, -30))],
      ["replace C", () => s.replaceImage(0, 2, jpeg)],
      ["text on the rotated page", () => s.replaceLine(1, lineIndex(s, 1, "Rotated page"), "Rotated page, edited")],
      ["move on the rotated page", () => s.transformImage(1, 0, moved(img(1, 0), 50, 100))],
      ["widen the inline G", () => s.transformImage(0, 6, [120, 0, 0, 40, 340, 520])],
      ["text again", () => s.replaceLine(0, lineIndex(s, 0, "Text still in place"), "Text again")],
      ["delete the background A", () => s.deleteImage(0, 0)],
    ];
    expect(steps.length).toBeGreaterThan(CHECKPOINT_EVERY);
    const checkpoints = () => (s as unknown as { checkpoints: { editCount: number }[] }).checkpoints.map((c) => c.editCount);
    const states = [look(docOf(s))];
    for (const [what, step] of steps) {
      const imagesBefore = [0, 1].map((p) => imageMatrices(liveTrace(s, p)));
      step();
      if (what.includes("text")) // a text edit leaves every image where it was
        expect([0, 1].map((p) => imageMatrices(liveTrace(s, p))), what).toEqual(imagesBefore);
      states.push(look(docOf(s)));
    }
    expect(s.lines(0).map((l) => l.text.trim())).toContain("Text again");
    expect(s.images(0)).toHaveLength(7);
    expect(checkpoints()).toEqual([CHECKPOINT_EVERY]); // replays from n >= 8 start there

    // Replaying the first n edits from the original (n < 8) or from the checkpoint (n >= 8).
    const rebuild = (n: number) => (s as unknown as { rebuild(n: number): mupdf.PDFDocument }).rebuild(n);
    for (let n = 0; n <= steps.length; n++) {
      const doc = rebuild(n);
      try {
        expect(look(doc), `replay of ${n} edits`).toBe(states[n]);
      } finally {
        doc.destroy();
      }
    }
    for (let n = steps.length; n > 0; n--) {
      s.undo();
      expect(look(docOf(s)), `undo to ${n - 1}`).toBe(states[n - 1]);
    }
    for (let n = 1; n <= steps.length; n++) {
      s.redo();
      expect(look(docOf(s)), `redo to ${n}`).toBe(states[n]);
    }
    // And the download draws the same.
    const bytes = s.save().bytes;
    expect(JSON.stringify([savedTrace(bytes, 0), savedTrace(bytes, 1)])).toBe(states[steps.length]);
  });

  it("a content stream shared by two pages, resources inherited from the page tree: only the edited page changes", () => {
    const bytes = makePdf((doc) => {
      const im = rgbImage(doc, 8, 8, (x, y) => [x * 30, y * 30, 200]);
      const resources = { XObject: { Im: im } };
      const content = "q 100 0 0 100 50 50 cm /Im Do Q q 50 0 0 50 300 300 cm /Im Do Q";
      doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, resources, content));
      doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, resources, ""));
      const [first, second] = [doc.findPage(0), doc.findPage(1)];
      second.put("Contents", first.get("Contents"));
      doc.getTrailer().get("Root", "Pages").put("Resources", first.get("Resources"));
      first.delete("Resources");
      second.delete("Resources");
    });
    const s = open(bytes);
    const second = liveTrace(s, 1);
    expect(s.images(1)).toHaveLength(2);
    s.transformImage(0, 0, moved(s.images(0)[0].matrix, 100, 0));
    s.replaceImage(0, 1, pictureFile("jpeg", 20, 10, () => [250, 250, 0]));
    s.deleteImage(0, 0);
    expect(liveTrace(s, 1)).toEqual(second);
    expect(s.images(0)).toHaveLength(1);
    expect(s.images(0)[0]).toMatchObject({ pixelWidth: 20, pixelHeight: 10 });
    // The edited page got its own resources (the inherited ones copied), where /Im, which it no
    // longer draws, is gone; the other page still inherits it.
    const pages = [docOf(s).findPage(0), docOf(s).findPage(1)];
    expect(pages[0].get("Resources", "XObject", "Im").isNull()).toBe(true);
    expect(pages[0].get("Resources", "XObject", "PEImg1").isStream()).toBe(true);
    expect(pages[1].get("Resources").isNull()).toBe(true);
    expect(pages[1].getInheritable("Resources").get("XObject", "Im").isStream()).toBe(true);
    expect(savedTrace(s.save().bytes, 1)).toEqual(second);
  });

  it("a log entry that no longer fits the document is refused (\"edit-failed\"), not applied elsewhere", () => {
    const s = open(SYNTHETIC);
    const m = s.images(0)[1].matrix;
    s.transformImage(0, 1, moved(m, 10, 10));
    s.undo();
    const shown = look(docOf(s));
    // The undone entry, as if the document had changed under it: the image is not where it expects.
    const redo = (s as unknown as { redoStack: { expect: Matrix }[] }).redoStack;
    redo[0].expect = moved(m, 5, 0);
    expectSessionError(() => s.redo(), "edit-failed");
    expect(look(docOf(s))).toBe(shown);
    expect(s.edits()).toEqual([]);
  });
});

describe("the preview sprite", () => {
  const alphaAt = (r: { width: number; rgba: Uint8ClampedArray }, x: number, y: number) => r.rgba[(y * r.width + x) * 4 + 3];

  it("covers the visible part, transparent outside the picture and opaque inside", () => {
    const s = open(SYNTHETIC);
    const b = s.images(0)[1].matrix;
    s.transformImage(0, 1, aboutCentre(b, rotation(45)));
    const img = s.images(0)[1];
    const r = s.renderImage(0, 1, 2);
    expect(r.scale).toBe(2);
    expect(r.width).toBe(Math.ceil(img.visible[2] * 2) - Math.floor(img.visible[0] * 2));
    expect(r.height).toBe(Math.ceil(img.visible[3] * 2) - Math.floor(img.visible[1] * 2));
    expect(r.rect).toEqual([Math.floor(img.visible[0] * 2) / 2, Math.floor(img.visible[1] * 2) / 2, Math.ceil(img.visible[2] * 2) / 2, Math.ceil(img.visible[3] * 2) / 2]);
    // Rotated by 45°: the corners of its box are empty, its centre is the picture.
    expect(alphaAt(r, 1, 1)).toBe(0);
    expect(alphaAt(r, r.width - 2, r.height - 2)).toBe(0);
    expect(alphaAt(r, r.width >> 1, r.height >> 1)).toBe(255);
    // Only the picture: the text drawn over it ("Text over image") is not in the sprite, which is
    // the same as the sprite of a copy without that text.
    const withoutText = (() => {
      const doc = mupdf.Document.openDocument(SYNTHETIC, "application/pdf").asPDF()!;
      try {
        const content = doc.findPage(0).get("Contents");
        const buf = content.readStream();
        const text = buf.asString();
        buf.destroy();
        expect(text).toContain("(Text over image) Tj");
        const edited = new mupdf.Buffer(new TextEncoder().encode(text.replace("(Text over image) Tj", "")));
        content.writeStream(edited);
        edited.destroy();
        return saveBytes(doc, "compress=no");
      } finally {
        doc.destroy();
      }
    })();
    const t = open(withoutText);
    t.transformImage(0, 1, aboutCentre(b, rotation(45)));
    const plain = t.renderImage(0, 1, 2);
    expect([plain.width, plain.height]).toEqual([r.width, r.height]);
    let differ = 0;
    for (let i = 0; i < r.rgba.length; i++) if (Math.abs(r.rgba[i] - plain.rgba[i]) > 2) differ++;
    expect(differ).toBe(0);
  });

  it("with its clip, and straight alpha (what ImageData expects)", () => {
    const s = open(SYNTHETIC);
    const d = s.renderImage(0, 3, 1); // cropped by its own clip: only the clip's box
    expect(d.rect).toEqual([300, 262, 420, 362]);
    expect([d.width, d.height]).toEqual([120, 100]);
    expect(alphaAt(d, 100, 50)).toBe(255); // inside the ellipse
    // A half-transparent red picture: straight red 255, alpha about 128 (premultiplied would be 128, 128).
    s.replaceImage(0, 1, pictureFile("png", 10, 10, () => [128, 0, 0, 128]));
    const r = s.renderImage(0, 1, 1);
    const o = ((r.height >> 1) * r.width + (r.width >> 1)) * 4;
    expect(r.rgba[o + 3]).toBeGreaterThan(110);
    expect(r.rgba[o + 3]).toBeLessThan(145);
    expect(r.rgba[o]).toBeGreaterThan(240);
    expect(r.rgba[o + 1]).toBeLessThan(10);
  });

  it("lowers the scale to stay within the pixel limit", () => {
    const s = open(SYNTHETIC);
    const r = s.renderImage(0, 0, 100);
    expect(r.scale).toBeLessThan(100);
    expect(r.width * r.height).toBeLessThanOrEqual(MAX_SPRITE_PIXELS);
    expect(r.width * r.height).toBeGreaterThan(MAX_SPRITE_PIXELS * 0.9);
    const v = s.images(0)[0].visible;
    expect(r.rect[0]).toBeLessThanOrEqual(v[0]);
    expect(r.rect[2]).toBeGreaterThanOrEqual(v[2]);
    expect(r.rgba.length).toBe(r.width * r.height * 4);
  });
});

describe("limits", () => {
  const grey = (doc: mupdf.PDFDocument) => rgbImage(doc, 4, 4, (x, y) => [x * 60, y * 60, 128]);
  const page = (content: string, extra: (doc: mupdf.PDFDocument, im: mupdf.PDFObject) => Record<string, unknown> = () => ({})) =>
    makePdf((doc) => {
      const im = grey(doc);
      doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, { XObject: { Im: im, ...extra(doc, im) } }, content));
    });

  it("80,000 clips in effect: images() stays fast", () => {
    const s = open(page("0 0 600 700 re W n ".repeat(80_000) + "q 100 0 0 100 50 50 cm /Im Do Q"));
    const t = performance.now();
    const [img] = s.images(0);
    expect(performance.now() - t).toBeLessThan(5000); // about 0.3 s; copying the clips made it 20 s
    expect(img.movable).toBe(true);
  });

  it("past the walk's caps, the page's images are listed as MuPDF draws them, locked", () => {
    // Forms drawing forms, ten times each, four deep: 10,000 placements from a few KB.
    const nested = page("q 0.5 0 0 0.5 10 10 cm /F0 Do Q", (doc, im) => {
      let name = "Im", obj = im;
      for (let level = 3; level >= 0; level--) {
        const body = Array.from({ length: 10 }, (_, i) => `q 1 0 0 1 ${i} 0 cm /${name} Do Q`).join(" ");
        obj = doc.addStream(body, { Type: "XObject", Subtype: "Form", BBox: [0, 0, 600, 800], Resources: { XObject: { [name]: obj } } });
        name = `F${level}`;
      }
      return { F0: obj };
    });
    const many = open(nested).images(0);
    expect(many).toHaveLength(MAX_PLACEMENTS);
    expect(many.every((i) => i.reason === "unreadable")).toBe(true);
    // A form drawn many times: more operations than the walk reads.
    const busy = page("q 1 0 0 1 0 0 cm /Busy Do Q ".repeat(Math.ceil(MAX_WALK_OPERATIONS / 20_000) + 1) + "q 100 0 0 100 300 300 cm /Im Do Q", (doc) => ({
      Busy: doc.addStream("0 0 1 1 re n ".repeat(10_000), { Type: "XObject", Subtype: "Form", BBox: [0, 0, 10, 10] }),
    }));
    expect(open(busy).images(0).map((i) => i.reason)).toEqual(["unreadable"]);
    // 5,000 pictures under 401 clips: more clips to check than the walk checks.
    const clips = Math.floor(MAX_CLIP_CHECKS / MAX_PLACEMENTS) + 1;
    const crowded = page("0 0 600 700 re W n ".repeat(clips) + "q 1 0 0 1 50 50 cm /Im Do Q ".repeat(MAX_PLACEMENTS));
    const listed = open(crowded).images(0);
    expect(listed).toHaveLength(MAX_PLACEMENTS);
    expect(listed.every((i) => i.reason === "unreadable")).toBe(true);
  });

  it("moves write the page's content stream in place: the working document does not grow", () => {
    const s = open(fixture("chrome-images.pdf"));
    const size = () => {
      const buf = docOf(s).saveToBuffer("encrypt=none");
      try {
        return buf.getLength();
      } finally {
        buf.destroy();
      }
    };
    const start = size();
    for (let k = 0; k < 24; k++) s.transformImage(0, 1, moved(s.images(0)[1].matrix, 1, 0));
    expect(size() - start).toBeLessThan(4096); // a copy of the content per move would be +50 KB
    expect(s.edits()).toHaveLength(24);
  });

  it("a picture MuPDF cannot draw: renderImage fails cleanly, again and again, and MuPDF keeps working", () => {
    // 3 bits per component, unfiltered: listed (the device pass does not decode it), not drawable.
    // An exception unwinding through MuPDF's C frames broke the shared module after about 20 of these.
    const bad = page("q 100 0 0 100 50 50 cm /Bad Do Q q 100 0 0 100 300 300 cm /Im Do Q", (doc) => {
      const buf = new mupdf.Buffer(new Uint8Array(100).fill(100));
      try {
        return { Bad: doc.addRawStream(buf, { Type: "XObject", Subtype: "Image", Width: 8, Height: 8, ColorSpace: "DeviceRGB", BitsPerComponent: 3 }) };
      } finally {
        buf.destroy();
      }
    });
    const s = open(bad);
    s.transformImage(0, 1, moved(s.images(0)[1].matrix, 10, 0));
    for (let k = 0; k < 40; k++) expectSessionError(() => s.renderImage(0, 0, 1), "edit-failed");
    expect(s.images(0)).toHaveLength(2);
    expect(s.renderImage(0, 1, 1).width).toBe(100);
    expect(s.save().bytes.byteLength).toBeGreaterThan(0);
    s.undo();
    expect(open(SYNTHETIC).render(0, 0.5).width).toBeGreaterThan(0);
  });

  describe("nested clips that are not rectangles, around a full-page picture", () => {
    // Each holds a mask and a copy of its area in the draw device: about 9.4 MB at scale 2 here.
    const clip = "-10 -10 m 700 -10 l 700 900 l -10 900 l -12 400 l h W n ";
    const framed = (clips: number) => open(page(clip.repeat(clips) + "q 600 0 0 780 6 6 cm /Im Do Q"));
    const alphaAt = (r: { width: number; rgba: Uint8ClampedArray }, x: number, y: number) => r.rgba[(y * r.width + x) * 4 + 3];

    it("30 of them (rounded or turned frames from a design tool) at scale 2: a sprite, at a lower scale", () => {
      const r = framed(30).renderImage(0, 0, 2);
      expect(r.scale).toBeLessThan(2);
      expect(r.scale).toBeGreaterThan(1); // as sharp as the memory allows: 30 × 9.4 MB at 2, for 128 MB
      expect([r.width, r.height]).toEqual([Math.ceil(606 * r.scale) - Math.floor(6 * r.scale), Math.ceil(786 * r.scale) - Math.floor(6 * r.scale)]);
      expect(alphaAt(r, r.width >> 1, r.height >> 1)).toBe(255);
      // As many as fit stay at the scale asked.
      expect(framed(12).renderImage(0, 0, 2).scale).toBe(2);
    });

    it("hundreds: still a sprite, down to the lowest scale", () => {
      const r = framed(300).renderImage(0, 0, 2);
      expect(r.scale).toBeLessThan(1);
      expect(r.scale).toBeGreaterThanOrEqual(MIN_SPRITE_SCALE);
      expect(alphaAt(r, r.width >> 1, r.height >> 1)).toBe(255);
    });

    it("thousands: refused before MuPDF runs out of memory, unless asked small", () => {
      const s = framed(3000);
      expectSessionError(() => s.renderImage(0, 0, 2), "edit-failed");
      expectSessionError(() => s.renderImage(0, 0, MIN_SPRITE_SCALE), "edit-failed");
      expect(s.renderImage(0, 0, 0.05).width).toBeGreaterThan(0); // small enough, it is drawn
      s.transformImage(0, 0, [500, 0, 0, 700, 50, 50]);
      expect(s.save().bytes.byteLength).toBeGreaterThan(0);
    });

    it("clips that end before the picture do not count", () => {
      const s = open(page(`q ${clip.repeat(3000)}0 0 1 rg 0 0 10 10 re f Q q 600 0 0 780 6 6 cm /Im Do Q`));
      expect(s.renderImage(0, 0, 2).scale).toBe(2);
    });

    it("rectangles cost the draw device nothing: as many of those are fine", () => {
      const rects = open(page("-10 -10 700 900 re W n ".repeat(3000) + "q 600 0 0 780 6 6 cm /Im Do Q"));
      expect(rects.renderImage(0, 0, 2).width).toBe(1200);
    });
  });
});

/** ImageInfo.matrix and the PDF image matrix differ by the flip, its own inverse. */
it("FLIP is its own inverse", () => {
  const m: Matrix = [10, 2, -3, 7, 100, 200];
  expect(concat(FLIP, concat(FLIP, m)).map(r3)).toEqual(m);
  const info: Pick<ImageInfo, "matrix"> = { matrix: [230, 0, 0, 140, 330, 72] };
  expect(concat(FLIP, info.matrix).map(r3)).toEqual([230, 0, 0, -140, 330, 212]);
});
