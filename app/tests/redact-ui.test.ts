// Bianchetto and Oscura in the UI (release 5) against the app's real modules with a fake engine
// (no browser): the geometry of the waiting box (dragged, a default box, moved, resized, stretched,
// a line's box shrunk across the line), the box's life (only in Modifica with Bianchetto or Oscura,
// gone with a change of sub-tool or of its page, "Metti al centro", "Usa Oscura"), what its context
// bar says from the engine's preview and why an area is refused, applying it as one edit (the
// engine's call, the history's count of redactions, the toasts only for what the user must know, a
// page changed meanwhile, a refusal), "Oscura tutti i risultati…" (its review's texts, the hits'
// areas by page, one edit (several, all undone by Annulla, for a page with more rects than one
// takes), the toast with Annulla, a refusal naming its page, more hits than Cerca shows, Cerca run
// again and what is left), Modifica's bar with six sub-tools (short labels on the phone strip,
// the hints, the banner note, "Metti al centro", 44 px targets on touch), and the download named
// "-oscurato" with its toast, also after Riprendi, and named by the history the bytes come from.
// RU7 calls the layer and its box as functions (hooks mocked): what they say and where the focus goes.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "./stubs/browser-globals";

/**
 * Hooks outside a render (no DOM here), so the layer and its box can be called as functions to
 * see what they show (as tests/search-ui.test.ts does): the i-th useState of a call gives
 * `hooks.states[i]` when set (else its first value), its setter noted in `hooks.sets`; refs that
 * stay empty; effects that do not run (useEffect runs once, its clean-up never, while `hooks.effects`).
 */
const hooks = vi.hoisted(() => ({ states: [] as unknown[], at: 0, sets: [] as unknown[], effects: false }));
vi.mock("preact/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("preact/hooks")>()),
  useState: (init: unknown) => {
    const i = hooks.at++;
    return [hooks.states[i] ?? init, (v: unknown) => { hooks.sets.push(v); }];
  },
  useRef: (init: unknown) => ({ current: init }),
  useEffect: (effect: () => unknown) => { if (hooks.effects) effect(); },
  useLayoutEffect: () => undefined,
}));

vi.mock("../src/engine/client.ts", () => {
  class EngineError extends Error {
    constructor(message: string, readonly code?: string) {
      super(message);
    }
  }
  const e = () => (globalThis as any).__redactEngine;
  class EngineClient {
    ready = Promise.resolve();
    open(bytes: ArrayBuffer) { return e().open(bytes); }
    lines(p: number) { return e().lines(p); }
    images() { return Promise.resolve([]); }
    addedTexts() { return Promise.resolve([]); }
    fields() { return Promise.resolve([]); }
    redact(areas: unknown, mode: unknown) { return e().redact(areas, mode); }
    redactPreview(areas: unknown, mode: unknown) { return e().redactPreview(areas, mode); }
    search(query: string, from: number, opts: unknown) { return e().search(query, from, opts); }
    save(options: unknown) { return e().save(options); }
    undo() { return e().undo(); }
    close() { return Promise.resolve(null); }
  }
  return { EngineError, EngineClient };
});

vi.mock("../src/ui/fill/signatureStore.ts", () => ({
  MAX_SAVED: 5,
  available: async () => false,
  list: async () => [],
  save: async () => null,
  forget: async () => false,
}));

const PAGE: [number, number, number, number] = [0, 0, 600, 800];
const MM = 72 / 25.4;
const calls: any[] = [];
/** What the next redact() does: its result, or an error to throw. */
let redactWith: (areas: any, mode: any) => any = () => result();
/** The hits the fake search finds now. */
let found: any[] = [];

function report(extra: Record<string, unknown> = {}) {
  return { text: "", pictures: 0, fields: [], links: 0, annotations: 0, crossing: false, growth: 0, attachments: 0, fieldsElsewhere: [], ...extra };
}
function result(extra: Record<string, unknown> = {}, pages = [0]) {
  return { editCount: 1, canUndo: true, canRedo: false, changedPages: pages, redactions: 1, report: report(extra) };
}
function hit(pageIndex: number, x0: number, y0: number, x1: number, y1: number, extra: Record<string, unknown> = {}) {
  return {
    pageIndex, quads: [[x0, y0, x1, y0, x0, y1, x1, y1]], rect: [x0, y0, x1, y1], in: "page",
    before: "Sig. ", match: "Rossi", after: " Mario", ...extra,
  };
}

(globalThis as any).__redactEngine = {
  open: async () => ({
    ok: true, pageCount: 3, pages: [0, 1, 2].map((index) => ({ index, bounds: PAGE })), encrypted: false,
    needsPassword: false, canKeepPassword: false, pdfa: null, signatures: 0, title: null, form: null,
  }),
  lines: async () => [],
  redact: async (areas: any, mode: any) => {
    calls.push(["redact", areas, mode]);
    return redactWith(areas, mode);
  },
  redactPreview: async (areas: any, mode: any) => {
    calls.push(["redactPreview", areas, mode]);
    return { pages: [{ pageIndex: 0, ...report({ text: "Mario Rossi" }) }], attachments: 0, refused: null };
  },
  search: async (_query: string, from: number, opts: any) => ({
    hits: found.filter((h) => h.pageIndex >= from && h.pageIndex < (opts?.to ?? 3)), next: null, truncated: false,
  }),
  save: async () => ({ bytes: new ArrayBuffer(4), pdfa: null }),
  undo: async () => ({ editCount: 0, canUndo: false, canRedo: true, changedPages: [0], redactions: 0 }),
};

let state: typeof import("../src/state");
let actions: typeof import("../src/ui/actions");
let i18n: typeof import("../src/i18n");
let geo: typeof import("../src/ui/redact/geometry");
let pending: typeof import("../src/ui/redact/pending");
let texts: typeof import("../src/ui/redact/texts");
let redact: typeof import("../src/ui/redact/actions");
let client: typeof import("../src/engine/client");

beforeAll(async () => {
  state = await import("../src/state");
  actions = await import("../src/ui/actions");
  i18n = await import("../src/i18n");
  geo = await import("../src/ui/redact/geometry");
  pending = await import("../src/ui/redact/pending");
  texts = await import("../src/ui/redact/texts");
  redact = await import("../src/ui/redact/actions");
  client = await import("../src/engine/client");
});

beforeEach(() => {
  i18n.setLocale("en");
  calls.length = 0;
  redactWith = () => result();
  found = [];
});

/** Lets an action that awaits flushEditor or the engine end. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const toastTexts = () => state.toasts.value.map((x) => x.text);

async function open(name: string) {
  const file = { name, type: "application/pdf", arrayBuffer: async () => new TextEncoder().encode(name).buffer } as unknown as File;
  await actions.openFile(file, { confirmed: true });
  state.toasts.value = [];
  calls.length = 0;
  return state.doc.value!;
}

async function inMode(name: string, mode: "whiteout" | "redact") {
  const d = await open(name);
  await actions.setTool("edit");
  await actions.setEditTool(mode);
  return d;
}

describe("RU1 the box's geometry", () => {
  it("a drag either way, a default box on the page, never off it", () => {
    expect(geo.rectBetween([50, 40], [10, 90])).toEqual([10, 40, 50, 90]);
    const box = geo.defaultBox([300, 400], PAGE);
    expect(box[2] - box[0]).toBeCloseTo(50 * MM);
    expect(box[3] - box[1]).toBeCloseTo(8 * MM);
    expect((box[0] + box[2]) / 2).toBeCloseTo(300);
    // At the edge: moved onto the page, its size kept; on a page smaller than it, shrunk.
    geo.defaultBox([2, 799], PAGE).forEach((v, i) => expect(v).toBeCloseTo([0, 800 - 8 * MM, 50 * MM, 800][i]));
    const small = geo.defaultBox([10, 10], [0, 0, 40, 10]);
    expect(small).toEqual([0, 0, 40, 10]);
    expect(geo.clipToPage([-10, 5, 700, 900], PAGE)).toEqual([0, 5, 600, 800]);
    expect(geo.isUsable([0, 0, 1, 10])).toBe(false);
    expect(geo.isUsable([0, 0, 2, 2])).toBe(true);
    expect(geo.isUsable([0, 0, Number.NaN, 2])).toBe(false);
  });

  it("moved, resized by a handle, stretched by the keyboard: on the page, never thinner than the minimum", () => {
    const r: [number, number, number, number] = [100, 100, 200, 120];
    expect(geo.moveBox(r, 10, -5, PAGE)).toEqual([110, 95, 210, 115]);
    expect(geo.moveBox(r, 1000, 0, PAGE)).toEqual([500, 100, 600, 120]);
    expect(geo.resizeBox(r, "se", [250, 160], PAGE)).toEqual([100, 100, 250, 160]);
    expect(geo.resizeBox(r, "nw", [-50, 90], PAGE)).toEqual([0, 90, 200, 120]);
    // An edge stops short of the other one instead of crossing it.
    expect(geo.resizeBox(r, "e", [50, 0], PAGE)).toEqual([100, 100, 100 + geo.MIN_BOX_SIDE, 120]);
    expect(geo.resizeBox(r, "n", [0, 300], PAGE)).toEqual([100, 120 - geo.MIN_BOX_SIDE, 200, 120]);
    expect(geo.stretchBox(r, 10, -30, PAGE)).toEqual([100, 100, 210, 100 + geo.MIN_BOX_SIDE]);
    expect(geo.stretchBox([590, 0, 600, 10], 10, 0, PAGE)).toEqual([590, 0, 600, 10]);
    expect(geo.handlePoint(r, "ne")).toEqual([200, 100]);
    expect(geo.handlePoint(r, "s")).toEqual([150, 120]);
  });

  it("a line's quad runs along the line, so the shrink goes across it; bounds of rects", () => {
    expect(geo.lineQuad({ bbox: [10, 20, 110, 32], dir: [1, 0], size: 12 })).toEqual([10, 20, 110, 20, 10, 32, 110, 32]);
    // A vertical line runs down the page: its quad's top edge is the right side.
    expect(geo.lineQuad({ bbox: [10, 20, 22, 200], dir: [0, 1], size: 12 })).toEqual([22, 20, 22, 200, 10, 20, 10, 200]);
    expect(geo.boundsOfRects([[0, 0, 0, 5], [10, 20, 30, 40], [5, 30, 15, 50]])).toEqual([5, 20, 30, 50]);
    expect(geo.boundsOfRects([[0, 0, 0, 0]])).toBeNull();
  });

  it("a slanted line's quad runs along it, recovered from its bbox (near 45°: its height from the font size)", () => {
    // A run 130 pt long and 14.6 pt high turned by 30°, and its upright bbox.
    const [c, s, L, H] = [Math.cos(Math.PI / 6), Math.sin(Math.PI / 6), 130, 14.6];
    const ul = [100, 100];
    const quad = [ul[0], ul[1], ul[0] + c * L, ul[1] + s * L, ul[0] - s * H, ul[1] + c * H, ul[0] + c * L - s * H, ul[1] + s * L + c * H];
    const xs = [quad[0], quad[2], quad[4], quad[6]], ys = [quad[1], quad[3], quad[5], quad[7]];
    const bbox: [number, number, number, number] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    geo.lineQuad({ bbox, dir: [c, s], size: 12 }).forEach((v, i) => expect(v).toBeCloseTo(quad[i], 6));
    // At 45° the bbox cannot tell length from height: the height is the font size.
    const r2 = Math.SQRT1_2;
    const q45 = geo.lineQuad({ bbox: [0, 0, 100, 100], dir: [r2, r2], size: 10 });
    expect(Math.hypot(q45[4] - q45[0], q45[5] - q45[1])).toBeCloseTo(10);
    expect(Math.hypot(q45[2] - q45[0], q45[3] - q45[1])).toBeCloseTo(100 / r2 - 10);
  });

  it("a click on the fixture's slanted line (30°) marks the whole line, its first and last letters too", async () => {
    const mupdf = await import("mupdf");
    const { EngineSession } = await import("../src/engine/session");
    const { lineArea } = await import("../src/viewer/RedactLayer");
    const s = new EngineSession(mupdf as any);
    const opened = s.open(new Uint8Array(readFileSync(new URL("./fixtures/search-chrome-it.pdf", import.meta.url))));
    if (!opened.ok) throw new Error("did not open");
    const line = s.lines(0).find((l) => /inclinato/.test(l.text))!;
    expect(Math.abs(line.dir[1])).toBeGreaterThan(0.3); // slanted, not horizontal nor vertical
    const preview = s.redactPreview([{ pageIndex: 0, rects: lineArea(line, opened.pages[0].bounds) }], "redact");
    expect(texts.excerpt(preview.pages[0].text)).toBe(texts.excerpt(line.text));
  });

  it("a click on a line marks the whole line, shrunk across it only: the lines above and below keep their letters", async () => {
    const { lineArea } = await import("../src/viewer/RedactLayer");
    const [r, ...more] = lineArea({ bbox: [50, 100, 250, 116.5], dir: [1, 0], size: 12 }, PAGE);
    expect(more).toEqual([]); // along the page's axes: one rect
    // Along the line it reaches (about) both ends, or the first and last letters would stay.
    expect(r[0]).toBeGreaterThanOrEqual(50 - 1e-6);
    expect(r[0]).toBeLessThan(52);
    expect(r[2]).toBeLessThanOrEqual(250 + 1e-6);
    expect(r[2]).toBeGreaterThan(248);
    expect(r[1]).toBeGreaterThan(100);
    expect(r[3]).toBeLessThan(116.5);
    // A vertical line: shrunk across it, sideways.
    const [v] = lineArea({ bbox: [300, 100, 316.5, 400], dir: [0, 1], size: 12 }, PAGE);
    expect([v[0] > 300, v[2] < 316.5, v[1] < 102, v[3] > 398]).toEqual([true, true, true, true]);
  });
});

describe("RU2 what the box says before and after", () => {
  it("what goes, a picture only covered (with Usa Oscura) or turned black, fields and links, a crossing drawing, attachments", () => {
    const facts = report({ text: "  Mario\n Rossi ", pictures: 1, fields: ["codice"], links: 1, annotations: 2, crossing: true });
    expect(texts.previewNotes(facts, "whiteout", 1)).toEqual([
      { kind: "removes", text: "Removes: “Mario Rossi”" },
      { kind: "warn", text: "On photos and scans white-out only covers: the picture underneath stays in the file.", useRedact: true },
      { kind: "warn", text: "Left on top as they are: the field “codice”, 1 link and 2 comments." },
      { kind: "info", text: "A drawing crosses the edge: the part inside is only covered." },
    ]);
    const notes = texts.previewNotes(facts, "redact", 2).map((n) => n.text);
    expect(notes).toEqual([
      "Removes: “Mario Rossi”",
      "The part of the picture underneath turns black too: the file may get bigger.",
      "Also removed whole: the field “codice”, 1 link and 2 comments.",
      "A drawing crosses the edge: the part inside is only covered.",
      "The PDF has 2 attached files: Redact doesn't touch them, and they may hold the same data.",
    ]);
    expect(texts.previewNotes(null, "redact", 0)).toEqual([]);
    expect(texts.previewNotes(report(), "redact", 0)).toEqual([{ kind: "info", text: "No text under it." }]);
    i18n.setLocale("it");
    expect(texts.previewNotes(report({ text: "Mario", fields: ["a", "b"] }), "redact", 0).map((n) => n.text)).toEqual([
      "Toglie: «Mario»",
      "Tolti per intero anche: i campi «a» e «b».",
    ]);
    expect(texts.excerpt("x".repeat(200))).toHaveLength(80);
  });

  it("why an area is refused, in words; after an edit only what the user must know", () => {
    for (const reason of ["separation", "shared", "too-big", "locked"] as const) {
      expect(texts.refusalText(reason)).not.toMatch(/redact\.refused/);
    }
    expect(texts.reportNotes(report({ fields: ["codice"] }) as any, "redact")).toEqual(["The field “codice” was removed too."]);
    // White-out removes no field: the ones it names stay on top, said before it is applied.
    expect(texts.reportNotes(report({ fields: ["codice"] }) as any, "whiteout")).toEqual([]);
    expect(texts.reportNotes(report({ fieldsElsewhere: ["nome"], attachments: 1, growth: 5.6 * 1024 * 1024 }) as any, "redact")).toEqual([
      "The field “nome” is on other pages too: its value stays there.",
      "The PDF has 1 attached file: Redact doesn't touch it, and it may hold the same data.",
      "The file is about 5.6 MB bigger.",
    ]);
    expect(texts.reportNotes(report({ growth: 900 * 1024 }) as any, "redact")).toEqual([]);
    i18n.setLocale("it");
    expect(texts.reportNotes(report({ growth: 5.6 * 1024 * 1024, fields: ["a", "b"] }) as any, "redact")).toEqual([
      "Anche i campi «a» e «b» sono stati tolti.",
      "Il file è più grande di circa 5,6 MB.",
    ]);
  });

  it("white-out says the links wholly inside the area go, before and after; redact counts them in its own list", () => {
    expect(texts.previewNotes(report({ text: "Mario", links: 1, linksRemoved: 2 }), "whiteout", 0).map((n) => [n.kind, n.text])).toEqual([
      ["removes", "Removes: “Mario”"],
      ["warn", "Left on top as it is: 1 link."],
      ["warn", "Also removed whole: 2 links."],
    ]);
    expect(texts.previewNotes(report({ text: "Mario", linksRemoved: 1 }), "redact", 0).map((n) => n.text)).toEqual(["Removes: “Mario”"]);
    expect(texts.reportNotes(report({ linksRemoved: 1 }) as any, "whiteout")).toEqual(["1 link was removed too."]);
    expect(texts.reportNotes(report({ linksRemoved: 3 }) as any, "redact")).toEqual([]);
    i18n.setLocale("it");
    expect(texts.previewNotes(report({ linksRemoved: 1 }), "whiteout", 0).map((n) => n.text)).toEqual([
      "Sotto non c'è testo.", "Tolto per intero anche: 1 link.",
    ]);
    expect(texts.reportNotes(report({ linksRemoved: 2 }) as any, "whiteout")).toEqual(["Sono stati tolti anche 2 link."]);
  });

  it("one thing that goes or stays is said in the singular; over a filled field it does not say there is no text", () => {
    expect(texts.previewNotes(report({ fields: ["codice"] }), "redact", 0).map((n) => n.text)).toEqual([
      "Also removed whole: the field “codice”.",
    ]);
    expect(texts.previewNotes(report({ fields: ["codice"] }), "whiteout", 0).map((n) => n.text)).toEqual([
      "Left on top as it is: the field “codice”.",
    ]);
    i18n.setLocale("it");
    expect(texts.previewNotes(report({ fields: ["codice"] }), "redact", 0).map((n) => n.text)).toEqual([
      "Tolto per intero anche: il campo «codice».",
    ]);
    expect(texts.previewNotes(report({ text: "x", annotations: 1 }), "whiteout", 0).map((n) => n.text)).toEqual([
      "Toglie: «x»", "Resta sopra com'è: 1 commento.",
    ]);
    expect(texts.previewNotes(report({ fields: ["a"], links: 1 }), "redact", 0).map((n) => n.text)).toEqual([
      "Tolti per intero anche: il campo «a» e 1 link.",
    ]);
    // The box is an "area" (feminine): the keys' help agrees with it.
    expect(i18n.t("redact.roleRedact")).toBe("area da oscurare");
    expect(i18n.t("redact.keysHelp")).toMatch(/^Le frecce la spostano/);
  });

  it("a refusal is read from the engine's not-editable error", () => {
    const { EngineError } = client;
    expect(redact.refusalOf(new EngineError("Refused (separation) on page 2", "not-editable"))).toBe("separation");
    expect(redact.refusalOf(new EngineError("refused: too-big", "not-editable"))).toBe("too-big");
    expect(redact.refusalOf(new EngineError("something else", "not-editable"))).toBe("locked");
    expect(redact.refusalOf(new EngineError("shared", "bad-request"))).toBeNull();
    expect(redact.refusalOf(new Error("shared"))).toBeNull();
  });
});

describe("RU3 the waiting box", () => {
  it("only in Modifica with Bianchetto or Oscura; it goes with the sub-tool, the tool and its page's revision", async () => {
    const d = await open("box.pdf");
    pending.markArea(d.pages[0], [10, 10, 100, 40]);
    expect(pending.pendingRedact.value).toBeNull(); // no tool on
    await actions.setTool("edit");
    pending.markArea(d.pages[0], [10, 10, 100, 40]);
    expect(pending.pendingRedact.value).toBeNull(); // Cambia
    await actions.setEditTool("redact");
    expect(pending.redactMode.value).toBe("redact");
    pending.markArea(d.pages[1], [10, 10, 100, 40], { line: 3, focus: true });
    const box = pending.pendingRedact.value!;
    expect([box.page, box.rect, box.line, box.focus, box.rev]).toEqual([d.pages[1], [10, 10, 100, 40], 3, true, d.pages[1].rev.peek()]);
    // Moved: the same box (its id), not focused again; a stale box is not moved.
    pending.moveArea(box, [20, 10, 110, 40]);
    expect([pending.pendingRedact.value!.id, pending.pendingRedact.value!.rect, pending.pendingRedact.value!.focus]).toEqual([box.id, [20, 10, 110, 40], false]);
    pending.moveArea(box, [0, 0, 5, 5]);
    expect(pending.pendingRedact.value!.rect).toEqual([20, 10, 110, 40]);
    // An edit, undo or redo of another page leaves it; of its page, it goes.
    state.invalidatePages([0]);
    expect(pending.pendingRedact.value).not.toBeNull();
    state.invalidatePages([1]);
    expect(pending.pendingRedact.value).toBeNull();
    pending.markArea(d.pages[0], [10, 10, 100, 40]);
    await actions.setEditTool("whiteout");
    expect(pending.pendingRedact.value).toBeNull();
    pending.markArea(d.pages[0], [10, 10, 100, 40]);
    await actions.setTool(null);
    expect([pending.pendingRedact.value, pending.redactMode.value]).toEqual([null, null]);
    expect(pending.cancelPendingRedact()).toBe(false);
  });

  it("'Metti al centro' puts a default box in the middle of what shows; 'Usa Oscura' carries the box over", async () => {
    const d = await inMode("centre.pdf", "whiteout");
    state.currentPage.value = 2;
    pending.placeAreaAtCentre();
    const box = pending.pendingRedact.value!;
    expect(box.page).toBe(d.pages[2]);
    expect(box.focus).toBe(true);
    expect((box.rect[0] + box.rect[2]) / 2).toBeCloseTo(300);
    expect((box.rect[1] + box.rect[3]) / 2).toBeCloseTo(400);
    await pending.useRedactInstead();
    expect(state.editTool.value).toBe("redact");
    expect([pending.pendingRedact.value!.rect, pending.pendingRedact.value!.focus]).toEqual([box.rect, true]);
    state.currentPage.value = 0;
    await actions.setTool(null);
  });
});

describe("RU4 applying an area", () => {
  it("one edit through the engine's queue: recorded, counted as a redaction, the box gone; a toast only when there is something to know", async () => {
    const d = await inMode("apply.pdf", "redact");
    pending.markArea(d.pages[0], [10, 10, 100, 40]);
    const done = await redact.redactNow([{ pageIndex: 0, rects: [[10, 10, 100, 40]] }], "redact", { revs: new Map([[d.pages[0], d.pages[0].rev.peek()]]) });
    expect(calls).toEqual([["redact", [{ pageIndex: 0, rects: [[10, 10, 100, 40]] }], "redact"]]);
    expect(done?.id).not.toBeNull();
    expect(state.history.value.redactions).toBe(1);
    expect(pending.pendingRedact.value).toBeNull(); // its page has a new revision
    expect(toastTexts()).toEqual([]);

    redactWith = () => result({ fields: ["codice"], fieldsElsewhere: ["nome"] });
    await redact.redactNow([{ pageIndex: 0, rects: [[10, 10, 100, 40]] }], "redact");
    expect(state.toasts.value.map((x) => [x.kind, x.text])).toEqual([
      ["warn", "The field “codice” was removed too. The field “nome” is on other pages too: its value stays there."],
    ]);
    await actions.setTool(null);
  });

  it("a page changed since the box was marked, a refusal, a failure: nothing written, said in words", async () => {
    const d = await inMode("refuse.pdf", "redact");
    const page = d.pages[0];
    const rev = page.rev.peek();
    state.invalidatePages([0]);
    expect(await redact.redactNow([{ pageIndex: 0, rects: [[1, 1, 50, 50]] }], "redact", { revs: new Map([[page, rev]]) })).toBeNull();
    expect(calls).toEqual([]);
    expect(toastTexts()).toEqual(["The page changed meanwhile: mark the area again."]);

    state.toasts.value = [];
    redactWith = () => { throw new client.EngineError("Refused: separation", "not-editable"); };
    expect(await redact.redactNow([{ pageIndex: 0, rects: [[1, 1, 50, 50]] }], "redact")).toBeNull();
    expect(toastTexts()).toEqual([texts.refusalText("separation")]);
    expect(state.history.value.redactions ?? 0).toBe(0);

    state.toasts.value = [];
    redactWith = () => { throw new client.EngineError("boom", "failed"); };
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await redact.redactNow([{ pageIndex: 0, rects: [[1, 1, 50, 50]] }], "whiteout")).toBeNull();
    error.mockRestore();
    expect(toastTexts()).toEqual(["Couldn't white out this area."]);
    await actions.setTool(null);
  });

  it("the preview asks the engine and changes nothing; an engine that cannot say gives null", async () => {
    await inMode("preview.pdf", "whiteout");
    const preview = await redact.previewFor([{ pageIndex: 0, rects: [[1, 1, 50, 50]] }], "whiteout");
    expect(preview?.pages[0].text).toBe("Mario Rossi");
    expect(calls).toEqual([["redactPreview", [{ pageIndex: 0, rects: [[1, 1, 50, 50]] }], "whiteout"]]);
    const engine = (globalThis as any).__redactEngine;
    const was = engine.redactPreview;
    engine.redactPreview = async () => { throw new Error("no"); };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await redact.previewFor([{ pageIndex: 0, rects: [[1, 1, 50, 50]] }], "whiteout")).toBeNull();
    warn.mockRestore();
    engine.redactPreview = was;
    expect(await redact.previewFor([], "whiteout")).toBeNull();
    await actions.setTool(null);
  });
});

describe("RU5 Oscura tutti i risultati", () => {
  it("the review's title and text, singular and plural; the hits by page", async () => {
    const { redactAllTexts, hitsByPage } = await import("../src/ui/redact/RedactAllDialog");
    const many = [hit(2, 10, 10, 50, 26), hit(0, 10, 10, 50, 26), hit(0, 10, 50, 50, 66)] as any[];
    expect(redactAllTexts(" Rossi ", many)).toEqual({
      title: "Redact 3 results?",
      body: "“Rossi” appears 3 times on 2 pages. In the file you download they become black boxes and the text underneath is gone. While the document is open you can undo it.",
    });
    expect(redactAllTexts("Rossi", [many[0]]).title).toBe("Redact 1 result?");
    expect(redactAllTexts("Rossi", many.slice(1)).body).toMatch(/^“Rossi” appears 2 times on page 1\./);
    expect(hitsByPage(many).map(([p, hits]) => [p, hits.length])).toEqual([[0, 2], [2, 1]]);
    i18n.setLocale("it");
    expect(redactAllTexts("Rossi", many).title).toBe("Oscurare 3 risultati?");
  });

  it("each hit's quads shrunk on its page, grouped by page in page order", async () => {
    const d = await open("areas.pdf");
    const rounds = redact.roundsOfHits(d, [hit(2, 10, 10, 50, 26.5), hit(0, 100, 100, 160, 116.5), hit(0, 100, 200, 160, 216.5)] as any[]);
    expect(rounds).toHaveLength(1);
    const { areas } = rounds[0];
    expect(areas.map((a) => [a.pageIndex, a.rects.length])).toEqual([[0, 2], [2, 1]]);
    const [r] = areas[1].rects;
    expect(r[1]).toBeGreaterThan(10);
    expect(r[3]).toBeLessThan(26.5);
    expect(r[0]).toBeGreaterThanOrEqual(10 - 1e-6);
    expect(r[0]).toBeLessThan(12);
    expect(r[2]).toBeLessThanOrEqual(50 + 1e-6);
    expect(r[2]).toBeGreaterThan(48);
  });

  it("opens the review; the chosen hits go as one edit, with Annulla; Cerca runs again and says what is left", async () => {
    const d = await open("all.pdf");
    const runner = await import("../src/ui/search/runner");
    found = [hit(0, 100, 100, 160, 116.5), hit(1, 100, 100, 160, 116.5), hit(1, 100, 300, 160, 316.5)];
    const hits = await runner.runSearch("Rossi");
    expect(hits).toHaveLength(3);
    redact.openRedactAll(hits!, "Rossi");
    const review = state.dialog.value as any;
    expect([review.kind, review.hits.length, review.query]).toEqual(["redact-all", 3, "Rossi"]);
    // All but the last one chosen: one redact call for both pages; afterwards the one skipped is still found.
    redactWith = () => result({}, [0, 1]);
    found = [found[2]];
    state.dialog.value = null;
    await redact.redactHits(review, review.hits.slice(0, 2));
    expect(calls.filter((c) => c[0] === "redact").map((c) => [c[1].map((a: any) => [a.pageIndex, a.rects.length]), c[2]])).toEqual([
      [[[0, 1], [1, 1]], "redact"],
    ]);
    const toasts = state.toasts.value;
    expect(toasts.map((x) => x.text)).toEqual([
      "Redacted 2 results on 2 pages.",
      "“Rossi” is still found once: 1 you didn't choose.",
    ]);
    expect(toasts[0].action?.label).toBe("Undo");
    expect(state.history.value.redactions).toBe(1);
    // Annulla undoes that very edit.
    toasts[0].action!.run();
    await vi.waitFor(() => expect(state.history.value.canUndo).toBe(false));
    runner.stopSearch();
    expect(d).toBe(state.doc.value);
  });

  it("all of them gone: 'Nessun risultato: oscurati tutti.'; what is left is told apart", async () => {
    await open("verified.pdf");
    const runner = await import("../src/ui/search/runner");
    found = [hit(0, 100, 100, 160, 116.5)];
    const hits = await runner.runSearch("Rossi");
    redact.openRedactAll(hits!, "Rossi");
    const review = state.dialog.value as any;
    state.dialog.value = null;
    found = [];
    await redact.redactHits(review, review.hits);
    expect(toastTexts()).toEqual(["Redacted 1 result.", "No results: all redacted."]);
    runner.stopSearch();
    const field = hit(0, 1, 1, 9, 9, { in: "field", field: "nome" });
    expect(redact.leftText("Rossi", [field, hit(1, 1, 1, 9, 9), hit(2, 1, 1, 9, 9)] as any[], [hit(2, 1, 1, 9, 9)] as any[]))
      .toBe("“Rossi” is still found 3 times: 1 you didn't choose, 1 in a form field and 1 elsewhere on the pages.");
    i18n.setLocale("it");
    expect(redact.allDoneText(12, 5)).toBe("Oscurati 12 risultati in 5 pagine.");
    expect(redact.leftText("Rossi", [], [])).toBe("Nessun risultato: oscurati tutti.");
  });

  it("nothing opens without hits or once editing has stopped", async () => {
    await open("none.pdf");
    redact.openRedactAll([], "x");
    expect(state.dialog.value).toBeNull();
    state.editingStopped.value = true;
    redact.openRedactAll([hit(0, 1, 1, 9, 9)] as any[], "x");
    expect(state.dialog.value).toBeNull();
    expect(toastTexts()).toEqual([i18n.t("broken.note")]);
    state.editingStopped.value = false;
  });

  it("hits with no place on the page (text over a picture, quads of no width): nothing sent, and that is said", async () => {
    await open("noarea.pdf");
    const runner = await import("../src/ui/search/runner");
    const flat = { quads: [[132.7, 70, 132.7, 70, 132.7, 125, 132.7, 125]], rect: [132.7, 70, 132.7, 125] };
    found = [hit(0, 0, 0, 0, 0, flat)];
    const hits = await runner.runSearch("Rossini");
    redact.openRedactAll(hits!, "Rossini");
    const review = state.dialog.value as any;
    state.dialog.value = null;
    await redact.redactHits(review, review.hits);
    expect(calls.filter((c) => c[0] === "redact")).toEqual([]);
    expect(state.toasts.value.map((x) => [x.kind, x.text])).toEqual([[
      "warn",
      "No result was redacted. Search found this text where it has no place on the page (for example, words that describe a picture): to remove it, draw a box by hand over what it describes.",
    ]]);
    runner.stopSearch();
  });

  /** A hit across a line break: two quads, one per line (600 of them make 1200 rects on page 0). */
  function twoLineHit(i: number) {
    const y = 10 + (i % 40) * 18;
    const x = 10 + Math.floor(i / 40) * 30;
    return {
      pageIndex: 0, quads: [[x, y, x + 12, y, x, y + 8, x + 12, y + 8], [x, y + 9, x + 12, y + 9, x, y + 17, x + 12, y + 17]],
      rect: [x, y, x + 12, y + 17], in: "page", before: "", match: "ab", after: "",
    };
  }

  it("a page with more rects than one edit takes: several edits, nothing dropped, Annulla undoes them all", async () => {
    await open("many.pdf");
    const runner = await import("../src/ui/search/runner");
    found = Array.from({ length: 600 }, (_, i) => twoLineHit(i));
    const hits = await runner.runSearch("ab");
    expect(hits).toHaveLength(600);
    redact.openRedactAll(hits!, "ab");
    const review = state.dialog.value as any;
    state.dialog.value = null;
    found = [];
    await redact.redactHits(review, review.hits);
    const sent = calls.filter((c) => c[0] === "redact").map((c) => c[1].map((a: any) => [a.pageIndex, a.rects.length]));
    expect(sent).toEqual([[[0, 1000]], [[0, 200]]]);
    const toasts = state.toasts.value;
    expect(toasts.map((x) => x.text)).toEqual(["Redacted 600 results on 1 page.", "No results: all redacted."]);
    // Annulla undoes both edits, the last first.
    const engine = (globalThis as any).__redactEngine;
    const was = engine.undo;
    let left = 2;
    engine.undo = async () => {
      calls.push(["undo"]);
      left--;
      return { editCount: left, canUndo: left > 0, canRedo: true, changedPages: [0], redactions: left };
    };
    toasts[0].action!.run();
    await vi.waitFor(() => expect(state.history.value.canUndo).toBe(false));
    engine.undo = was;
    expect(calls.filter((c) => c[0] === "undo")).toHaveLength(2);
    runner.stopSearch();
  });

  /** A hit on a page turned 45°: one quad per line it crosses (200 pt long, 10 high), each cut in 128 pieces by areasForQuads. */
  function turnedHit(i: number, lines = 1) {
    const L = 200, H = 10, r2 = Math.SQRT1_2;
    const quads = Array.from({ length: lines }, (_, k) => {
      const x = 10 + 3 * k, y = 160 + 10 * i + 3 * k;
      return [x, y, x + L * r2, y - L * r2, x + H * r2, y + H * r2, x + (L + H) * r2, y + (H - L) * r2];
    });
    const y = 160 + 10 * i;
    return { pageIndex: 0, quads, rect: [10, y - L * r2, 10 + (L + H) * r2, y + H * r2], in: "page", before: "", match: "ab", after: "" };
  }

  it("a turned page's hits (many pieces each): every piece sent, each hit whole in one edit", async () => {
    const pieces = (await import("../src/engine/redactGeometry")).areasForQuads(turnedHit(0).quads as any).length;
    expect(pieces).toBe(128);
    // 50 hits of 128 pieces: 6400 rects, 7 whole hits (896) an edit, so 8 edits.
    await open("turned.pdf");
    const runner = await import("../src/ui/search/runner");
    found = Array.from({ length: 50 }, (_, i) => turnedHit(i));
    const hits = await runner.runSearch("ab");
    redact.openRedactAll(hits!, "ab");
    const review = state.dialog.value as any;
    state.dialog.value = null;
    found = [];
    await redact.redactHits(review, review.hits);
    const sent = calls.filter((c) => c[0] === "redact").map((c) => c[1].map((a: any) => [a.pageIndex, a.rects.length]));
    expect(sent).toEqual([...Array(7).fill([[0, 896]]), [[0, 128]]]);
    expect(toastTexts()).toEqual(["Redacted 50 results on 1 page.", "No results: all redacted."]);
    // One hit across 10 turned lines: 1280 pieces, none left out (an edit takes 1000).
    const d = state.doc.value!;
    const rounds = redact.roundsOfHits(d, [turnedHit(0, 10)] as any[]);
    expect(rounds.map((r) => [r.areas.map((a) => a.rects.length), r.hits.length])).toEqual([[[1000], 0], [[280], 1]]);
    runner.stopSearch();
  });

  it("a hit is never cut between two edits: the next one takes it whole, so a refusal leaves it as it was, found again", async () => {
    const { areasForQuads } = await import("../src/engine/redactGeometry");
    await open("split.pdf");
    const runner = await import("../src/ui/search/runner");
    // 8 hits of 128 pieces: 7 fit in an edit (896), the 8th goes whole in the next.
    found = Array.from({ length: 8 }, (_, i) => turnedHit(i));
    const hits = await runner.runSearch("ab");
    const d = state.doc.value!;
    expect(redact.roundsOfHits(d, hits!).map((r) => [r.areas.map((a) => a.rects.length), r.hits.length])).toEqual([[[896], 7], [[128], 1]]);
    redact.openRedactAll(hits!, "ab");
    const review = state.dialog.value as any;
    state.dialog.value = null;
    found = [found[7]]; // the refused hit, untouched, is found again
    let n = 0;
    redactWith = () => {
      if (++n === 2) throw new client.EngineError("Refused (too-big) on page 1: a picture too big", "not-editable");
      return result();
    };
    await redact.redactHits(review, review.hits);
    const [first] = calls.filter((c) => c[0] === "redact");
    expect(first[1][0].rects).toEqual(hits!.slice(0, 7).flatMap((h) => areasForQuads(h.quads)));
    expect(state.toasts.value.map((x) => [x.kind, x.text, x.action?.label ?? null])).toEqual([
      ["warn", "Redacted 7 of the 8 results; the others weren't: the problem is on page 1. This area can't be cleared: a picture under it is too big to clear on this device.", "Undo"],
      ["warn", "“ab” is still found once: 1 that couldn't be redacted.", null],
    ]);
    runner.stopSearch();
  });

  it("a hit of more rects than one edit takes, its later part refused: Annulla for the part written, never 'all redacted'", async () => {
    await open("cut.pdf");
    const runner = await import("../src/ui/search/runner");
    found = [turnedHit(0, 10)]; // 1280 pieces: [1000], then [280]
    const hits = await runner.runSearch("ab");
    redact.openRedactAll(hits!, "ab");
    const review = state.dialog.value as any;
    state.dialog.value = null;
    found = []; // cut, it is no longer found
    let n = 0;
    redactWith = () => {
      if (++n === 2) throw new client.EngineError("Refused (too-big) on page 1: a picture too big", "not-editable");
      return result();
    };
    await redact.redactHits(review, review.hits);
    expect(state.toasts.value.map((x) => [x.kind, x.text, x.action?.label ?? null])).toEqual([
      ["warn", "Redacted 0 of the 1 results; the others weren't: the problem is on page 1. This area can't be cleared: a picture under it is too big to clear on this device. One of them is redacted only in part.", "Undo"],
    ]);
    i18n.setLocale("it");
    expect(redact.allPartlyText(0, 3, null, null, 2)).toBe(
      "Oscurati 0 risultati su 3; gli altri no. Qualcosa è andato storto. Riprova. 2 di questi sono oscurati solo in parte.",
    );
    runner.stopSearch();
  });

  it("only the hits really written are counted: a later edit refused says how many were redacted, that the others were not, and its page", async () => {
    await open("partly.pdf");
    const runner = await import("../src/ui/search/runner");
    found = Array.from({ length: 600 }, (_, i) => twoLineHit(i));
    const hits = await runner.runSearch("ab");
    redact.openRedactAll(hits!, "ab");
    const review = state.dialog.value as any;
    state.dialog.value = null;
    found = found.slice(500);
    let n = 0;
    redactWith = () => {
      if (++n === 2) throw new client.EngineError("Refused (too-big) on page 1: a picture too big", "not-editable");
      return result();
    };
    await redact.redactHits(review, review.hits);
    const toasts = state.toasts.value;
    expect(toasts.map((x) => [x.kind, x.text])).toEqual([
      ["warn", "Redacted 500 of the 600 results; the others weren't: the problem is on page 1. This area can't be cleared: a picture under it is too big to clear on this device."],
      ["warn", "“ab” is still found 100 times: 100 that couldn't be redacted."],
    ]);
    expect(toasts[0].action?.label).toBe("Undo");
    i18n.setLocale("it");
    expect(redact.allPartlyText(500, 600, "locked", null)).toBe(
      "Oscurati 500 risultati su 600; gli altri no. Il contenuto di questa pagina non si può cambiare in sicurezza.",
    );
    runner.stopSearch();
  });

  it("a later edit that fails (not refused) says the same: how many were redacted, and that the others were not", async () => {
    await open("partlyfailed.pdf");
    const runner = await import("../src/ui/search/runner");
    found = Array.from({ length: 600 }, (_, i) => twoLineHit(i));
    const hits = await runner.runSearch("ab");
    redact.openRedactAll(hits!, "ab");
    const review = state.dialog.value as any;
    state.dialog.value = null;
    found = found.slice(500);
    let n = 0;
    redactWith = () => {
      if (++n === 2) throw new client.EngineError("MuPDF broke", "engine");
      return result();
    };
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await redact.redactHits(review, review.hits);
    const toasts = state.toasts.value;
    expect(toasts.map((x) => [x.kind, x.text])).toEqual([
      ["warn", "Redacted 500 of the 600 results; the others weren't. Something went wrong. Try again."],
      ["warn", "“ab” is still found 100 times: 100 that couldn't be redacted."],
    ]);
    expect(toasts[0].action?.label).toBe("Undo");
    i18n.setLocale("it");
    expect(redact.allPartlyText(500, 600, null, null)).toBe("Oscurati 500 risultati su 600; gli altri no. Qualcosa è andato storto. Riprova.");
    vi.mocked(console.error).mockRestore();
    runner.stopSearch();
  });

  it("refused: says that nothing was redacted, and which page refused", async () => {
    await open("refused.pdf");
    const runner = await import("../src/ui/search/runner");
    found = [hit(0, 100, 100, 160, 116.5), hit(2, 100, 100, 160, 116.5)];
    const hits = await runner.runSearch("Rossi");
    redact.openRedactAll(hits!, "Rossi");
    const review = state.dialog.value as any;
    state.dialog.value = null;
    redactWith = () => { throw new client.EngineError("Refused (too-big) on page 3: a picture too big", "not-editable"); };
    await redact.redactHits(review, review.hits);
    expect(state.toasts.value.map((x) => [x.kind, x.text])).toEqual([[
      "warn",
      "No result was redacted: the problem is on page 3. This area can't be cleared: a picture under it is too big to clear on this device. Untick that page's results and try again.",
    ]]);
    expect(state.history.value.redactions ?? 0).toBe(0);
    i18n.setLocale("it");
    expect(redact.allRefusedText("locked", null)).toBe(
      "Nessun risultato è stato oscurato. Il contenuto di questa pagina non si può cambiare in sicurezza.",
    );
    runner.stopSearch();
  });

  it("more hits than Cerca shows: the review says these are the first ones, and the rest are searched for again", async () => {
    await open("toomany.pdf");
    const runner = await import("../src/ui/search/runner");
    found = Array.from({ length: runner.MAX_HITS + 1 }, (_, i) => hit(i % 3, 10 + (i % 20) * 25, 10 + Math.floor(i / 60) * 20, 30 + (i % 20) * 25, 26 + Math.floor(i / 60) * 20));
    const hits = await runner.runSearch("Rossi");
    expect(runner.searchTooMany.value).toBe(true);
    redact.openRedactAll(hits!, "Rossi");
    const review = state.dialog.value as any;
    state.dialog.value = null;
    expect(redact.reviewHasMore(review)).toBe(true);
    const { redactAllTexts } = await import("../src/ui/redact/RedactAllDialog");
    expect(redactAllTexts("Rossi", found.slice(0, 1000) as any[], true).body).toMatch(/^“Rossi” appears more than 1000 times: here are the first 1000, then the rest are searched for again\./);
    runner.stopSearch();
    // A review of every hit says nothing of the kind.
    found = [hit(0, 100, 100, 160, 116.5)];
    redact.openRedactAll((await runner.runSearch("Rossi"))!, "Rossi");
    expect(redact.reviewHasMore(state.dialog.value as any)).toBe(false);
    state.dialog.value = null;
    runner.stopSearch();
  });
});

describe("RU6 Modifica's bar and the download", () => {
  let edit: typeof import("../src/ui/EditBar");
  let media: typeof import("../src/ui/media");
  let sub: typeof import("../src/ui/SubTools");
  beforeAll(async () => {
    edit = await import("../src/ui/EditBar");
    media = await import("../src/ui/media");
    sub = await import("../src/ui/SubTools");
  });

  function nodes(node: any): any[] {
    if (node == null || typeof node !== "object") return [];
    if (Array.isArray(node)) return node.flatMap(nodes);
    return [node, ...nodes(node.props?.children)];
  }
  const ofType = (node: any, type: unknown) => nodes(node).filter((n) => n.type === type);

  it("six sub-tools, Bianchetto and Oscura toggles after Forme; short labels on the phone strip", async () => {
    const d = await inMode("bar.pdf", "redact");
    const items = edit.editToolItems(state.editTool.value, false);
    expect(items.map((x) => [x.id, x.pressed])).toEqual([
      ["change", false], ["addText", false], ["addImage", undefined], ["shapes", false], ["whiteout", false], ["redact", true],
    ]);
    expect(items.slice(4).map((x) => [x.label, x.tip])).toEqual([
      ["White-out", "Remove text and drawings from an area and leave it white"],
      ["Redact", "Permanently remove text, drawings and images from an area: a black box stays"],
    ]);
    i18n.setLocale("it");
    expect(edit.EditStrip().props.items.map((x: any) => x.label)).toEqual(["Cambia", "Testo", "Immagine", "Forme", "Bianchetto", "Oscura"]);
    expect(edit.editToolItems("change", false).map((x) => x.label)).toEqual(["Cambia", "Aggiungi testo", "Aggiungi immagine", "Forme", "Bianchetto", "Oscura"]);
    i18n.setLocale("en");
    items[4].onChoose();
    await settle();
    expect(state.editTool.value).toBe("whiteout");

    // The banner: the hint and the note, "Metti al centro", Done naming no key (Esc goes back to Cambia first).
    const banner = edit.EditBanner({ doc: d, elRef: { current: null } });
    const all = nodes(banner);
    expect(all.find((n) => n.props?.role === "status")?.props.children).toBe("Drag over what you want to remove, or click a line.");
    expect(all.some((n) => n.props?.children === "In the file you download, what you redact is gone for good. Until then you can undo it.")).toBe(true);
    expect(ofType(banner, sub.PlaceCentreButton).map((b: any) => b.props.onClick)).toEqual([pending.placeAreaAtCentre]);
    expect(all.find((n) => n.props?.class?.includes("edit-banner-done"))?.props.title).toBe("Stop editing");
    expect(edit.editHint("redact", true)).toBe("Tap a line or the spot to redact, then adjust the box by its corners.");
    media.isCoarse.value = false;
    await actions.setTool(null);
  });

  it("the box's keys in the details panel (in Italian the box is masculine), and what is not guaranteed", async () => {
    const { redactShortcuts } = await import("../src/ui/DetailsPanel");
    expect(redactShortcuts().map(([, action]) => action)).toEqual([
      "Move the box", "Move it by 10 pt", "Change its width or height", "Apply it", "Cancel it",
    ]);
    expect(i18n.t("details.redactLimits")).toMatch(/embedded fonts.*“Pick up where you left off” keeps on this device until you close the document/);
    i18n.setLocale("it");
    expect(redactShortcuts().map(([, action]) => action).slice(0, 2)).toEqual(["Sposta il riquadro", "Spostalo di 10 pt"]);
    expect(i18n.t("details.redactLimits")).toMatch(/font incorporati.*«Riprendi da dove eri» tiene su questo dispositivo finché non chiudi il documento/);
  });

  // Modifica's icon-only sub-tools keep 44 px on touch: shell.css, checked in shapes-ui.test.ts SU1.
  it("touch: a thin box's corner targets are 44 px", () => {
    const css = readFileSync(new URL("../src/styles/redact.css", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");
    // The corner targets: 44 × 44, `--reach-*` inside the box (RedactLayer), the rest outside.
    const at = css.indexOf("@media (pointer: coarse) { .redact-box { cursor: default; }");
    const coarse = css.slice(at, css.indexOf("@", at + 1));
    expect(coarse).toContain(".redact-box .image-handle { width: 44px; height: 44px; }");
    expect(coarse).toContain(".redact-box .image-handle.is-nw { margin: calc(var(--reach-y, 22px) - 44px) 0 0 calc(var(--reach-x, 22px) - 44px); }");
    expect(coarse).toContain(".redact-box .image-handle.is-se { margin: calc(-1 * var(--reach-y, 22px)) 0 0 calc(-1 * var(--reach-x, 22px)); }");
  });

  it("after Riprendi of a log with redactions the download is still '-oscurato'", async () => {
    await open("ripreso.pdf");
    state.startHistory({ editCount: 2, canUndo: true, canRedo: false, changedPages: [], redactions: 1 }, false);
    expect(state.history.value.redactions).toBe(1);
    expect(actions.outputName("ripreso.pdf")).toBe("ripreso-redacted.pdf");
    state.startHistory({ editCount: 1, canUndo: true, canRedo: false, changedPages: [] }, false);
    expect(actions.outputName("ripreso.pdf")).toBe("ripreso-edited.pdf");
  });

  it("a redaction that removed form fields keeps the view where it is: no page operation, the form counted again", async () => {
    const d = await open("campi.pdf");
    state.currentPage.value = 1;
    const layoutRev = d.layout.peek();
    const form = { fieldsPerPage: [0, 0, 0], fields: 0, required: 0 };
    const layout = { pages: [0, 1, 2].map((index) => ({ index, bounds: PAGE })), from: [0, 1, 2], form, signatures: 0 };
    const pages = d.pages.slice();
    state.recordHistory({ editCount: 1, canUndo: true, canRedo: false, changedPages: [1], redactions: 1, layout } as any, "edit");
    expect([d.layout.peek(), state.currentPage.value, d.pages.every((p, i) => p === pages[i])]).toEqual([layoutRev, 1, true]);
    expect(d.info.form).toEqual(form);
    expect(state.stepChangesPages("undo")).toBe(false); // its undo changes no page either
    state.recordHistory({ editCount: 0, canUndo: false, canRedo: true, changedPages: [1], redactions: 0, layout: { ...layout, form: null } } as any, "undo");
    expect([d.layout.peek(), d.info.form]).toEqual([layoutRev, null]);
    // A page operation that leaves the pages in place (a turn by 180°) is still one.
    state.recordHistory({ editCount: 1, canUndo: true, canRedo: false, changedPages: [1], redactions: 0, layout } as any, "edit");
    expect(d.layout.peek()).toBe(layoutRev + 1);
    state.currentPage.value = 0;
  });

  it("the name is the history's when the bytes are made: an undo still on its way when Download is pressed counts", async () => {
    await open("contratto.pdf");
    state.recordHistory({ editCount: 1, canUndo: true, canRedo: false, changedPages: [0], redactions: 1 }, "edit");
    const engine = (globalThis as any).__redactEngine;
    const was = engine.undo;
    engine.undo = async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      calls.push(["undo"]);
      return { editCount: 0, canUndo: false, canRedo: true, changedPages: [0], redactions: 0 };
    };
    const created = (globalThis as any).__created as any[];
    const before = created.length;
    const undone = actions.undo();
    await actions.download();
    await undone;
    expect(created.slice(before).filter((el) => el.tag === "a").map((a) => a.download)).toEqual(["contratto-edited.pdf"]);
    expect(toastTexts()).toContain("Downloaded “contratto-edited.pdf”.");

    // With the save dialog the name is asked first: when it says "-redacted" and the redaction was
    // undone meanwhile, nothing is written under it (the empty file goes) and that is said.
    state.toasts.value = [];
    state.recordHistory({ editCount: 1, canUndo: true, canRedo: false, changedPages: [0], redactions: 1 }, "edit");
    let removed = false;
    let written = false;
    (globalThis as any).showSaveFilePicker = async (opts: { suggestedName: string }) => {
      await actions.undo();
      return {
        name: opts.suggestedName,
        createWritable: async () => ({ write: async () => { written = true; }, close: async () => undefined }),
        getFile: async () => ({ size: 0 }),
        remove: async () => { removed = true; },
      };
    };
    await actions.download();
    delete (globalThis as any).showSaveFilePicker;
    engine.undo = was;
    expect([written, removed]).toEqual([false, true]);
    expect(toastTexts()).toEqual(["The document changed while you chose where to save it: download it again."]);
  });

  it("after a white-out or a redaction the download is '-oscurato', with its own toast", async () => {
    await open("contratto.pdf");
    expect(actions.outputName("contratto.pdf")).toBe("contratto-edited.pdf");
    state.recordHistory({ editCount: 1, canUndo: true, canRedo: false, changedPages: [0], redactions: 1 }, "edit");
    expect(actions.outputName("contratto.pdf")).toBe("contratto-redacted.pdf");
    expect(actions.outputName("contratto.pdf", "pdfa-2b")).toBe("contratto-redacted-PDFA.pdf");
    const names: string[] = [];
    (globalThis as any).showSaveFilePicker = async (opts: { suggestedName: string }) => {
      names.push(opts.suggestedName);
      return { name: opts.suggestedName, createWritable: async () => ({ write: async () => undefined, close: async () => undefined }) };
    };
    i18n.setLocale("it");
    await actions.download();
    delete (globalThis as any).showSaveFilePicker;
    expect(names).toEqual(["contratto-oscurato.pdf"]);
    expect(toastTexts()).toContain(
      "Scaricato “contratto-oscurato.pdf”: le parti oscurate non ci sono più. Il file originale resta com'è: condividi questo.",
    );
  });
});

describe("RU7 the layer and its box, as they render", () => {
  let layer: typeof import("../src/viewer/RedactLayer");
  let edit: typeof import("../src/ui/EditBar");
  let media: typeof import("../src/ui/media");
  beforeAll(async () => {
    layer = await import("../src/viewer/RedactLayer");
    edit = await import("../src/ui/EditBar");
    media = await import("../src/ui/media");
  });

  function nodes(node: any): any[] {
    if (node == null || typeof node !== "object") return [];
    if (Array.isArray(node)) return node.flatMap(nodes);
    return [node, ...nodes(node.props?.children)];
  }
  /** A component called as a function, its i-th useState giving `states[i]` when set. */
  function render(component: any, props: any, states: unknown[] = []) {
    hooks.at = 0;
    hooks.states = states;
    hooks.sets = [];
    return component(props);
  }
  const boxIn = (out: any) => nodes(out).find((n) => typeof n.type === "function" && n.type.name === "AreaBox");
  const lineAt = (index: number, text: string) => ({ index, text, bbox: [50, 100 + 20 * index, 250, 116 + 20 * index], dir: [1, 0], size: 12 });
  const NOTE = "In the file you download, what you redact is gone for good. Until then you can undo it.";

  it("a line's box names its line once, without the spaces around it", async () => {
    const d = await inMode("labels.pdf", "redact");
    const page = d.pages[0];
    page.lines.value = { rev: page.rev.peek(), lines: [lineAt(0, " degli Studi  di Milano "), lineAt(1, "  ")] as any };
    const out = render(layer.RedactLayer, { page, zoom: 1, mode: "redact" });
    expect(nodes(out).filter((n) => n.props?.class === "redact-line").map((n) => n.props["aria-label"])).toEqual([
      "Redact the line: degli Studi di Milano",
    ]);
    await actions.setTool(null);
  });

  it("the same words said again are said again: each apply is a new status", async () => {
    const d = await inMode("twice.pdf", "redact");
    const page = d.pages[0];
    pending.markArea(page, [10, 10, 100, 40]);
    const box = boxIn(render(layer.RedactLayer, { page, zoom: 1, mode: "redact" }));
    box.props.onDone("Area redacted on page 1.");
    box.props.onDone("Area redacted on page 1.");
    const said = hooks.sets as any[];
    expect(said.map((s) => s?.text)).toEqual(["Area redacted on page 1.", "Area redacted on page 1."]);
    expect(said[0].id).not.toBe(said[1].id);
    // Under its own key: the status region gets a new text each time, not the same one kept.
    const again = render(layer.RedactLayer, { page, zoom: 1, mode: "redact" }, [undefined, said[1]]);
    const status = nodes(again).find((n) => n.props?.role === "status");
    expect([status.props.children.key, status.props.children.props.children]).toEqual([said[1].id, "Area redacted on page 1."]);
    await actions.setTool(null);
  });

  it("the notes region is always in the page, so what it says is heard; Enter on a refused box says why again", async () => {
    const css = readFileSync(new URL("../src/styles/redact.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css.includes(".redact-notes:empty")).toBe(false);
    const d = await inMode("refusedbox.pdf", "redact");
    pending.markArea(d.pages[0], [10, 10, 100, 40]);
    const box = boxIn(render(layer.RedactLayer, { page: d.pages[0], zoom: 1, mode: "redact" }));
    const said: string[] = [];
    const preview = { key: "redact|10,10,100,40", value: { pages: [], attachments: 0, refused: { reason: "separation", pageIndex: 0 } } };
    const out = render(box.type, { ...box.props, onDone: (text: string) => said.push(text) }, [undefined, undefined, undefined, preview]);
    expect(nodes(out).find((n) => n.props?.class === "redact-notes")?.props["aria-live"]).toBe("polite");
    const area = nodes(out).find((n) => n.props?.role === "application");
    area.props.onKeyDown({ key: "Enter", repeat: false, preventDefault: () => undefined, stopPropagation: () => undefined });
    await settle();
    expect(said).toEqual([texts.refusalText("separation")]);
    expect(calls.filter((c) => c[0] === "redact")).toEqual([]);
    await actions.setTool(null);
  });

  it("on a phone the banner keeps to the hint, and the note is said in the box's bar until something is redacted", async () => {
    const d = await inMode("phone.pdf", "redact");
    media.isNarrow.value = true;
    try {
      const banner = nodes(edit.EditBanner({ doc: d, elRef: { current: null } }));
      expect(banner.find((n) => n.props?.role === "status")?.props.children).toBe(edit.editHint("redact", false));
      expect(banner.some((n) => n.props?.children === NOTE)).toBe(false);
      pending.markArea(d.pages[0], [10, 10, 100, 40]);
      const box = boxIn(render(layer.RedactLayer, { page: d.pages[0], zoom: 1, mode: "redact" }));
      expect(nodes(render(box.type, box.props)).filter((n) => n.props?.children === NOTE)).toHaveLength(1);
      state.recordHistory({ editCount: 1, canUndo: true, canRedo: false, changedPages: [2], redactions: 1 }, "edit");
      expect(nodes(render(box.type, box.props)).some((n) => n.props?.children === NOTE)).toBe(false);
      // Desktop: the banner says it, the bar does not.
      state.recordHistory({ editCount: 0, canUndo: false, canRedo: true, changedPages: [2], redactions: 0 }, "undo");
      media.isNarrow.value = false;
      expect(nodes(edit.EditBanner({ doc: d, elRef: { current: null } })).some((n) => n.props?.children === NOTE)).toBe(true);
      expect(nodes(render(box.type, box.props)).some((n) => n.props?.children === NOTE)).toBe(false);
    } finally {
      media.isNarrow.value = false;
      await actions.setTool(null);
    }
  });

  it("the box gone with the focus: to its line's box (or the nearest line's) once the lines show, the scroller meanwhile, never <body>", () => {
    const g = globalThis.document as any;
    const was = { active: g.activeElement, querySelector: g.querySelector };
    const el = (name: string, line?: number) => {
      const e: any = { name, dataset: line === undefined ? {} : { redactLine: String(line) }, focus: () => { g.activeElement = e; } };
      return e;
    };
    const scroller = el("scroller");
    g.querySelector = (selector: string) => (selector === ".viewer .scroller" ? scroller : null);
    const shown = { querySelectorAll: () => [el("line 0", 0), el("line 2", 2), el("line 5", 5)] };
    const none = { querySelectorAll: () => [] };
    try {
      // Applied: the page's lines are read again; the scroller meanwhile, then the nearest line's box.
      g.activeElement = g.body;
      expect(layer.refocusLine(none as any, 3, false)).toBe(false);
      expect(g.activeElement).toBe(scroller);
      expect(layer.refocusLine(shown as any, 3, true)).toBe(true);
      expect(g.activeElement.name).toBe("line 2");
      // Cancelled: its own line's box at once.
      g.activeElement = g.body;
      expect(layer.refocusLine(shown as any, 5, true)).toBe(true);
      expect(g.activeElement.name).toBe("line 5");
      // A box drawn by hand: the scroller. The focus somewhere else by then: it stays there.
      g.activeElement = g.body;
      expect(layer.refocusLine(shown as any, null, true)).toBe(true);
      expect(g.activeElement).toBe(scroller);
      const other = el("other");
      g.activeElement = other;
      expect(layer.refocusLine(shown as any, 2, true)).toBe(true);
      expect(g.activeElement).toBe(other);
      // The lines came back with none to show: the scroller keeps it.
      g.activeElement = scroller;
      expect(layer.refocusLine(none as any, 2, true)).toBe(true);
      expect(g.activeElement).toBe(scroller);
    } finally {
      g.activeElement = was.active;
      g.querySelector = was.querySelector;
    }
  });

  /** Three lines of 12 pt Helvetica 14.4 pt apart, turned by `deg` (a skewed scan's text layer). */
  async function turnedLines(deg: number): Promise<Uint8Array> {
    const mupdf = await import("mupdf");
    const { saveBytes } = await import("./helpers/richPdf");
    const [c, s] = [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)];
    const doc = new mupdf.PDFDocument();
    try {
      const helv = doc.addObject({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" });
      const content = `BT /F1 12 Tf ${c} ${s} ${-s} ${c} 80 600 Tm 14.4 TL (Prima riga AAAAAAAAAAAAAA fine) Tj ` +
        "T* (Mario Rossi SEGRETOLUNGO qui) Tj T* (Terza riga BBBBBBBBBBBBBB fine) Tj ET";
      doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { Font: { F1: helv } }, content));
      return saveBytes(doc, "compress=no");
    } finally {
      doc.destroy();
    }
  }

  /** The waiting box applied with its button: the areas its preview asked about, and those sent. */
  async function previewAndApply(page: any) {
    calls.length = 0;
    const box = boxIn(render(layer.RedactLayer, { page, zoom: 1, mode: "redact" }));
    hooks.effects = true;
    let bar: any[] = [];
    try {
      bar = nodes(render(box.type, box.props));
    } finally {
      hooks.effects = false;
    }
    await vi.waitFor(() => expect(calls.some((c) => c[0] === "redactPreview")).toBe(true));
    bar.find((n) => n.props?.class?.includes("btn-primary")).props.onClick();
    await vi.waitFor(() => expect(calls.some((c) => c[0] === "redact")).toBe(true));
    return { asked: calls.find((c) => c[0] === "redactPreview")[1], sent: calls.find((c) => c[0] === "redact")[1] };
  }

  for (const deg of [2, 5, 10]) {
    it(`a tap on a line turned ${deg}° takes the whole line and no letter of the lines beside it; the preview asks what is sent`, async () => {
      const mupdf = await import("mupdf");
      const { EngineSession } = await import("../src/engine/session");
      const s = new EngineSession(mupdf as any);
      try {
        if (!s.open(await turnedLines(deg)).ok) throw new Error("did not open");
        const before = s.lines(0);
        const mid = before.find((l) => /SEGRETO/.test(l.text))!;
        expect(before.map((l) => l.text.trim())).toEqual(["Prima riga AAAAAAAAAAAAAA fine", "Mario Rossi SEGRETOLUNGO qui", "Terza riga BBBBBBBBBBBBBB fine"]);
        const d = await inMode(`turned${deg}.pdf`, "redact");
        const page = d.pages[0];
        page.lines.value = { rev: page.rev.peek(), lines: before };
        const line = nodes(render(layer.RedactLayer, { page, zoom: 1, mode: "redact" })).find((n) => n.props?.["data-redact-line"] === mid.index);
        line.props.onClick({ detail: 1 });
        const shown = pending.pendingRedact.value!.rect;
        let removes = "";
        redactWith = (areas, mode) => {
          removes = s.redactPreview(areas, mode).pages[0].text;
          s.redact(areas, mode);
          return result();
        };
        const { asked, sent } = await previewAndApply(page);
        expect(asked).toEqual(sent);
        expect(geo.boundsOfRects(sent[0].rects)).toEqual(shown); // the box shows the bounds of what goes
        expect(texts.excerpt(removes)).toBe(texts.excerpt(mid.text));
        expect(s.lines(0).map((l) => l.text)).toEqual([before[0].text, before[2].text]);
      } finally {
        s.close();
        await actions.setTool(null);
      }
    });
  }

  it("a line's box moved or resized sends the plain rectangle it shows, and its preview asks the same", async () => {
    const d = await inMode("moved.pdf", "redact");
    const page = d.pages[0];
    const r2 = Math.SQRT1_2;
    const turned = { index: 0, text: "Mario Rossi", bbox: [100, 100, 200, 200], dir: [r2, -r2], size: 12 };
    page.lines.value = { rev: page.rev.peek(), lines: [turned] as any };
    nodes(render(layer.RedactLayer, { page, zoom: 1, mode: "redact" })).find((n) => n.props?.class === "redact-line").props.onClick({ detail: 1 });
    const shown = pending.pendingRedact.value!.rect;
    const box = boxIn(render(layer.RedactLayer, { page, zoom: 1, mode: "redact" }));
    nodes(render(box.type, box.props)).find((n) => n.props?.role === "application")
      .props.onKeyDown({ key: "ArrowRight", preventDefault: () => undefined, stopPropagation: () => undefined });
    const moved = pending.pendingRedact.value!.rect;
    expect(moved).toEqual([shown[0] + 1, shown[1], shown[2] + 1, shown[3]]);
    const { asked, sent } = await previewAndApply(page);
    expect([asked, sent]).toEqual([[{ pageIndex: 0, rects: [moved] }], [{ pageIndex: 0, rects: [moved] }]]);
    await actions.setTool(null);
  });
});
