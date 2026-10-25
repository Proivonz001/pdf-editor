// Forme's chrome (release 6) against the app's real modules with a fake engine (no browser; the
// components are called as functions and their trees read, hooks mocked): Modifica's fourth
// sub-tool of six in its place and lit, on the banner and the phone strip, and the CSS rules that
// keep the six at a 44 px target where they go icons only; the kind picker (a radio group bound
// to shapeKind, the arrow keys, Home and End move the choice; choosing deselects the selected
// shape after writing its keyboard move still waiting), its place on desktop and phones, "Metti al
// centro" (every kind but Penna: it bumps shapeCentreRequest) and the hint for each kind; the
// selected shape cleared by a change of sub-tool or tool, an undo, a page operation (Ruota); the
// details panel's how-to and keys for Forme, and the line pointing to Pagine.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "./stubs/browser-globals";

// Hooks outside a render: refs that stay as made, states at their first value, no effects.
vi.mock("preact/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("preact/hooks")>()),
  useState: (init: unknown) => [typeof init === "function" ? (init as () => unknown)() : init, () => undefined],
  useRef: (init: unknown) => ({ current: init }),
  useEffect: () => undefined,
  useLayoutEffect: () => undefined,
}));

vi.mock("../src/engine/client.ts", () => {
  class EngineError extends Error {
    constructor(message: string, readonly code?: string) {
      super(message);
    }
  }
  class EngineClient {
    ready = Promise.resolve();
    open() {
      return Promise.resolve({
        ok: true, pageCount: 2, pages: [0, 1].map((index) => ({ index, bounds: [0, 0, 600, 800] })), encrypted: false,
        needsPassword: false, canKeepPassword: false, pdfa: null, signatures: 0, title: null, form: null,
      });
    }
    lines() { return Promise.resolve([]); }
    images() { return Promise.resolve([]); }
    addedTexts() { return Promise.resolve([]); }
    fields() { return Promise.resolve([]); }
    undo() { return Promise.resolve({ editCount: 0, canUndo: false, canRedo: true, changedPages: [0] }); }
    /** Pagine's "Ruota" on the first page, as the engine reports it. */
    editPages() {
      return Promise.resolve({
        editCount: 1, canUndo: true, canRedo: false, changedPages: [0],
        layout: { pages: [{ index: 0, bounds: [0, 0, 800, 600] }, { index: 1, bounds: [0, 0, 600, 800] }], from: [0, 1], form: null, signatures: 0 },
        report: { linksRemoved: 0, fieldsRenamed: 0, signaturesAdded: 0 },
      });
    }
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

let state: typeof import("../src/state");
let actions: typeof import("../src/ui/actions");
let i18n: typeof import("../src/i18n");
let edit: typeof import("../src/ui/EditBar");
let sub: typeof import("../src/ui/SubTools");
let media: typeof import("../src/ui/media");
let details: typeof import("../src/ui/DetailsPanel");
let pageOps: typeof import("../src/ui/pageActions");

beforeAll(async () => {
  state = await import("../src/state");
  actions = await import("../src/ui/actions");
  i18n = await import("../src/i18n");
  edit = await import("../src/ui/EditBar");
  sub = await import("../src/ui/SubTools");
  media = await import("../src/ui/media");
  details = await import("../src/ui/DetailsPanel");
  pageOps = await import("../src/ui/pageActions");
});

beforeEach(() => {
  i18n.setLocale("en");
  (globalThis as any).document.activeElement = null;
  media.isNarrow.value = false;
  media.isCoarse.value = false;
});

/** Lets an action that awaits flushEditor or the engine end. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const elRef = { current: null };

/** Every element and component in the tree of `node` (components are not called: they show as themselves). */
function nodes(node: any): any[] {
  if (node == null || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(nodes);
  return [node, ...nodes(node.props?.children)];
}
const ofType = (node: any, type: unknown) => nodes(node).filter((n) => n.type === type);
const statusText = (node: any) => nodes(node).find((n) => n.props?.role === "status")?.props.children;

/** The tree of `node` with every component called in turn (hooks mocked): what it would render. */
function deep(node: any): any {
  if (node == null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(deep);
  if (typeof node.type === "function") return deep(node.type(node.props));
  return { ...node, props: { ...node.props, children: deep(node.props?.children) } };
}
/** The text strings in a deep tree, in order. */
function texts(node: any): string[] {
  if (node == null || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [String(node)];
  if (Array.isArray(node)) return node.flatMap(texts);
  return texts(node.props?.children);
}

async function open(name: string) {
  const file = { name, type: "application/pdf", arrayBuffer: async () => new TextEncoder().encode(name).buffer } as unknown as File;
  await actions.openFile(file, { confirmed: true });
  state.toasts.value = [];
  return state.doc.value!;
}

async function inShapes(name: string) {
  const d = await open(name);
  await actions.setTool("edit");
  await actions.setEditTool("shapes");
  return d;
}

describe("SU1 Forme among Modifica's sub-tools", () => {
  it("fourth of six, after Aggiungi immagine and before Bianchetto, a toggle lit while it is on; on the banner and the phone strip", async () => {
    const d = await open("tools.pdf");
    await actions.setTool("edit");
    const tools = () => ofType(edit.EditBanner({ doc: d, elRef }), sub.SubTools)[0];
    expect(tools().props.items.map((x: any) => [x.id, x.pressed])).toEqual([
      ["change", true], ["addText", false], ["addImage", undefined], ["shapes", false], ["whiteout", false], ["redact", false],
    ]);
    const shapes = tools().props.items[3];
    expect([shapes.label, shapes.tip, shapes.Icon]).toEqual([
      "Shapes", "Draw lines, arrows, rectangles, ellipses or freehand, or highlight text", (await import("../src/ui/icons")).IconShapes,
    ]);

    shapes.onChoose();
    await settle();
    expect(state.editTool.value).toBe("shapes");
    expect(tools().props.items.map((x: any) => x.pressed)).toEqual([false, false, undefined, true, false, false]);
    expect(edit.EditStrip().props.items.map((x: any) => [x.id, x.pressed])).toEqual([
      ["change", false], ["addText", false], ["addImage", undefined], ["shapes", true], ["whiteout", false], ["redact", false],
    ]);
    // The button: aria-pressed, its name on it and its tooltip.
    const button = sub.SubToolButton({ item: tools().props.items[3], tabbable: true, onFocus: () => undefined });
    expect([button.props["aria-pressed"], button.props["aria-label"], button.props.tabIndex]).toEqual([true, "Shapes", 0]);

    i18n.setLocale("it");
    expect(edit.EditStrip().props.items.map((x: any) => x.label)).toEqual(["Cambia", "Testo", "Immagine", "Forme", "Bianchetto", "Oscura"]);
    expect(edit.editToolItems("shapes", false).map((x) => x.label)).toEqual([
      "Cambia", "Aggiungi testo", "Aggiungi immagine", "Forme", "Bianchetto", "Oscura",
    ]);
    // Done names no key: Esc goes back to Cambia first.
    const done = nodes(edit.EditBanner({ doc: d, elRef })).find((n) => n.props?.class?.includes("edit-banner-done"));
    expect(done.props.title).toBe("Esci dalla modifica");
    await actions.setTool(null);
  });

  // jsdom lays nothing out: whether the six fit a 320 px strip is seen only in a browser.
  it("the CSS keeps each of the six a 44 px target: on the narrowest phones' strip, and icons only on a narrow banner", () => {
    const css = readFileSync(new URL("../src/styles/phone.css", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");
    expect(css).toContain("@media (max-width: 359.98px) { .sub-tools.is-strip { gap: 1px; padding: 2px; } .sub-tools.is-strip .sub-tool { min-width: var(--tap); padding: 0 2px; } }");
    // Desktop: icons only below 1000 px of banner (six longer names), 44 px wide on touch.
    const shell = readFileSync(new URL("../src/styles/shell.css", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");
    expect(shell).toContain("@container tool-banner (max-width: 999.98px) { .edit-banner.is-edit .sub-tools.is-banner .sub-tool { width: 32px;");
    expect(shell).toContain("@container tool-banner (max-width: 999.98px) { .edit-banner.is-edit .sub-tools.is-banner .sub-tool { width: var(--tap); } }");
  });
});

describe("SU2 the kind picker", () => {
  /** The picker's radios, as rendered now. */
  const radios = () => nodes(edit.ShapeKindPicker()).filter((n) => n.props?.role === "radio");

  it("a radio group of the six kinds, named, with one Tab stop on the chosen one", async () => {
    await inShapes("picker.pdf");
    const group = edit.ShapeKindPicker();
    expect([group.props.role, group.props["aria-label"]]).toEqual(["radiogroup", "Shape type"]);
    expect(radios().map((r) => [r.key, r.props["aria-label"], r.props.title, r.props["aria-checked"], r.props.tabIndex])).toEqual([
      ["line", "Line", "Line", false, -1],
      ["arrow", "Arrow", "Arrow", false, -1],
      ["rect", "Rectangle", "Rectangle", true, 0],
      ["ellipse", "Ellipse", "Ellipse", false, -1],
      ["pen", "Pen", "Pen", false, -1],
      ["highlight", "Highlight", "Highlight", false, -1],
    ]);
    // The name beside the icon is for the eyes only: the button carries it.
    expect(nodes(radios()[0]).find((n) => n.props?.class === "shape-kind-label").props["aria-hidden"]).toBe("true");
    i18n.setLocale("it");
    expect(edit.ShapeKindPicker().props["aria-label"]).toBe("Tipo di forma");
    expect(radios().map((r) => r.props["aria-label"])).toEqual(["Linea", "Freccia", "Rettangolo", "Ellisse", "Penna", "Evidenzia"]);
    await actions.setTool(null);
  });

  it("a click sets shapeKind; the arrow keys, Home and End move the choice and the focus, round the ends", async () => {
    await inShapes("keys.pdf");
    radios()[4].props.onClick();
    expect(state.shapeKind.value).toBe("pen");

    const group: any = edit.ShapeKindPicker();
    const focused: string[] = [];
    const doc = (globalThis as any).document;
    const buttons = edit.SHAPE_TOOL_KINDS.map(({ kind }) => {
      const b = { kind, focus: () => { focused.push(kind); doc.activeElement = b; } };
      return b;
    });
    group.ref.current = { querySelectorAll: () => buttons }; // preact keeps the ref on the vnode
    doc.activeElement = buttons[4];
    const press = (key: string, extra: Record<string, unknown> = {}) => {
      let prevented = false;
      group.props.onKeyDown({ key, preventDefault: () => { prevented = true; }, ...extra });
      return prevented;
    };
    expect(press("ArrowRight")).toBe(true);
    expect([state.shapeKind.value, focused.at(-1)]).toEqual(["highlight", "highlight"]);
    press("ArrowRight"); // round the end
    expect(state.shapeKind.value).toBe("line");
    press("ArrowLeft");
    expect(state.shapeKind.value).toBe("highlight");
    press("ArrowUp");
    expect(state.shapeKind.value).toBe("pen");
    press("ArrowDown");
    expect(state.shapeKind.value).toBe("highlight");
    press("Home");
    expect([state.shapeKind.value, focused.at(-1)]).toEqual(["line", "line"]);
    press("End");
    expect(state.shapeKind.value).toBe("highlight");
    // Other keys, and arrows with a modifier, are left alone.
    expect(press("a")).toBe(false);
    expect(press("ArrowLeft", { altKey: true })).toBe(false);
    expect(press("ArrowLeft", { ctrlKey: true })).toBe(false);
    expect(state.shapeKind.value).toBe("highlight");
    // Keys faster than a render: each steps from the focused radio (Highlight), not the kind the
    // render saw (Pen, which would give Ellipse twice).
    press("ArrowLeft");
    expect([state.shapeKind.value, focused.at(-1)]).toEqual(["pen", "pen"]);
    press("ArrowLeft");
    expect([state.shapeKind.value, focused.at(-1)]).toEqual(["ellipse", "ellipse"]);
    doc.activeElement = null;
    state.shapeKind.value = "rect";
    await actions.setTool(null);
  });

  it("choosing a kind deselects the selected shape, after writing its keyboard move still waiting", async () => {
    await inShapes("deselect.pdf");
    const order: string[] = [];
    state.selectedShape.value = { pageIndex: 0, id: 3 };
    const unregister = state.registerEditor({
      changed: () => true,
      commit: async () => { order.push(`commit:${JSON.stringify(state.selectedShape.peek())}`); },
    });
    const chosen = actions.setShapeKind("ellipse");
    expect(state.shapeKind.value).toBe("ellipse"); // at once: the radio follows the click
    await chosen;
    unregister();
    expect(order).toEqual(['commit:{"pageIndex":0,"id":3}']);
    expect(state.selectedShape.value).toBeNull();

    // The same kind again deselects too; a shape selected meanwhile stays selected.
    state.selectedShape.value = { pageIndex: 0, id: 4 };
    await actions.setShapeKind("ellipse");
    expect(state.selectedShape.value).toBeNull();
    state.selectedShape.value = { pageIndex: 0, id: 5 };
    const late = actions.setShapeKind("line");
    state.selectedShape.value = { pageIndex: 1, id: 1 };
    await late;
    expect(state.selectedShape.value).toEqual({ pageIndex: 1, id: 1 });
    state.shapeKind.value = "rect";
    await actions.setTool(null);
  });
});

describe("SU3 Forme's banner", () => {
  const banner = (d: any) => edit.EditBanner({ doc: d, elRef });

  it("desktop: the picker leads the hint's row; phones: a row of its own after the buttons; not with the other sub-tools", async () => {
    const d = await inShapes("banner.pdf");
    const info = nodes(banner(d)).find((n) => n.props?.class === "tool-banner-info");
    expect(info.props.children[0].type).toBe(edit.ShapeKindPicker);
    const top = banner(d).props.children.filter(Boolean);
    expect(top.map((n: any) => n.props?.class ?? n.type?.name)).toEqual(["tool-banner-lead", "tool-banner-actions", "tool-banner-info"]);

    media.isNarrow.value = true;
    const phone = banner(d).props.children.filter(Boolean);
    expect(phone.map((n: any) => n.props?.class ?? n.type?.name)).toEqual([
      "edit-banner-mark", "tool-banner-info", "tool-banner-actions", "ShapeKindPicker",
    ]);
    expect(ofType(banner(d), edit.ShapeKindPicker)).toHaveLength(1);
    expect(ofType(banner(d), sub.SubTools)).toEqual([]); // in the strip on phones
    media.isNarrow.value = false;

    for (const tool of ["change", "addText", "whiteout", "redact"] as const) {
      await actions.setEditTool(tool);
      expect({ tool, pickers: ofType(banner(d), edit.ShapeKindPicker).length }).toEqual({ tool, pickers: 0 });
    }
    await actions.setTool(null);
  });

  it("'Metti al centro' for every kind but Penna asks the layer for a shape (shapeCentreRequest), with its own tooltip", async () => {
    const d = await inShapes("centre.pdf");
    const centres = () => ofType(banner(d), sub.PlaceCentreButton);
    for (const kind of ["line", "arrow", "rect", "ellipse", "pen", "highlight"] as const) {
      state.shapeKind.value = kind;
      expect({ kind, centres: centres().length }).toEqual({ kind, centres: kind === "pen" ? 0 : 1 });
    }
    state.shapeKind.value = "rect";
    const [centre] = centres();
    const before = state.shapeCentreRequest.value;
    centre.props.onClick();
    expect(state.shapeCentreRequest.value).toBe(before + 1);
    expect(state.shapeKind.value).toBe("rect");

    // The button itself: the same name as everywhere, the shape's tooltip ("la" in Italian).
    const button = sub.PlaceCentreButton(centre.props);
    expect([button.props["aria-label"], button.props.title]).toEqual(["Put it in the middle", "Put it in the middle of the page you see, without clicking"]);
    i18n.setLocale("it");
    expect(sub.PlaceCentreButton(ofType(banner(d), sub.PlaceCentreButton)[0].props).props.title).toBe("Mettila al centro della pagina che vedi, senza fare clic");
    media.isCoarse.value = true;
    expect(ofType(banner(d), sub.PlaceCentreButton)[0].props.tip).toBe("Mettila al centro della pagina che vedi, senza toccare");
    media.isNarrow.value = true;
    expect(ofType(banner(d), sub.PlaceCentreButton)).toHaveLength(1); // on phones too
    // Bianchetto, Oscura and Aggiungi testo keep theirs, with the usual tooltip.
    expect(sub.PlaceCentreButton().props.title).toBe("Mettilo al centro della pagina che vedi, senza toccare");
    await actions.setTool(null);
  });

  it("the hint follows the kind and the pointer, as a status, in both languages", async () => {
    const d = await inShapes("hints.pdf");
    const hint = () => statusText(banner(d));
    const want: Record<string, [string, string, string, string]> = {
      rect: [
        "Drag on the page to draw. With Shift: square, circle, straight lines.",
        "Tap the page to place the shape, then move and resize it.",
        "Trascina sulla pagina per disegnare. Con Maiusc: quadrato, cerchio, linee dritte.",
        "Tocca la pagina per mettere la forma, poi spostala e ridimensionala.",
      ],
      pen: [
        "Drag to draw freehand.",
        "Draw with one finger. Use two fingers to scroll and zoom.",
        "Trascina per disegnare a mano libera.",
        "Disegna con un dito. Con due dita scorri e ingrandisci.",
      ],
      highlight: [
        "Drag over the text, or click a line.",
        "Tap a line to highlight it.",
        "Trascina sopra il testo, oppure fai clic su una riga.",
        "Tocca una riga per evidenziarla.",
      ],
    };
    for (const [kind, [mouse, touch, mouseIt, touchIt]] of Object.entries(want)) {
      state.shapeKind.value = kind as any;
      i18n.setLocale("en");
      media.isCoarse.value = false;
      expect(hint()).toBe(mouse);
      media.isCoarse.value = true;
      expect(hint()).toBe(touch);
      i18n.setLocale("it");
      expect(hint()).toBe(touchIt);
      media.isCoarse.value = false;
      expect(hint()).toBe(mouseIt);
    }
    // Lines, arrows and ellipses are drawn as rectangles are.
    for (const kind of ["line", "arrow", "ellipse"] as const) expect(edit.editHint("shapes", false, kind)).toBe(want.rect[2]);
    expect(edit.editHint("change", false, "pen")).toBe("Fai clic su una riga per cambiarla, o su un'immagine per spostarla.");
    state.shapeKind.value = "rect";
    await actions.setTool(null);
  });
});

describe("SU4 the selected shape goes with what changes under it", () => {
  const select = () => { state.selectedShape.value = { pageIndex: 0, id: 1 }; };

  it("a change of sub-tool or of tool, an undo, a page operation, another document", async () => {
    await inShapes("clear.pdf");
    select();
    await actions.setEditTool("change");
    expect(state.selectedShape.value).toBeNull();

    await actions.setEditTool("shapes");
    select();
    await actions.setTool(null);
    expect(state.selectedShape.value).toBeNull();

    await actions.setTool("edit");
    await actions.setEditTool("shapes");
    select();
    await actions.setTool("fill");
    expect(state.selectedShape.value).toBeNull();

    await actions.setTool("edit");
    await actions.setEditTool("shapes");
    state.recordHistory({ editCount: 1, canUndo: true, canRedo: false, changedPages: [0] }, "edit");
    select();
    await actions.undo();
    expect(state.history.value.canRedo).toBe(true);
    expect(state.selectedShape.value).toBeNull();

    select();
    await pageOps.rotatePagesAction([0], 90);
    expect(state.history.value.editCount).toBe(1); // the rotation ran
    expect(state.selectedShape.value).toBeNull();

    select();
    await open("another.pdf");
    expect(state.selectedShape.value).toBeNull();
    await actions.setTool(null);
  });

  it("a change of sub-tool writes the shape's keyboard move still waiting first", async () => {
    await inShapes("flush.pdf");
    select();
    const seen: unknown[] = [];
    const unregister = state.registerEditor({ changed: () => true, commit: async () => { seen.push(state.selectedShape.peek()); } });
    await actions.setEditTool("redact");
    unregister();
    expect(seen).toEqual([{ pageIndex: 0, id: 1 }]);
    expect(state.selectedShape.value).toBeNull();
    await actions.setTool(null);
  });
});

describe("SU5 the details panel with Forme", () => {
  /** The details as they render for `d` now (`sheet`: the phone's sheet, no keys). */
  const content = (d: any, sheet = false) =>
    deep(details.DetailsContent({ doc: d, ...(sheet ? { leaveSheet: () => undefined } : {}) }));

  it("the steps for the kind chosen, what each kind does, that shapes become part of the page and hide nothing", async () => {
    const d = await inShapes("details.pdf");
    const said = texts(content(d));
    expect(said).toContain("Shapes");
    expect(said).toContain("Choose the type of shape in the bar above the page.");
    expect(said).toContain("Drag on the page to draw. With Shift: square, circle, straight lines."); // the banner's hint
    expect(said).toContain("Click a shape to change its colour, width or line style, move it or delete it.");
    for (const [kind, what] of [["Line", "A straight line."], ["Pen", "A freehand stroke."], ["Highlight", "See-through colour over the text, like a highlighter pen."]]) {
      expect(said[said.indexOf(kind) + 1]).toBe(what);
    }
    expect(said).toContain("Shapes become part of the page: whoever gets the file sees them everywhere, but cannot move them as they can comments.");
    expect(said).toContain("Shapes hide nothing: the highlighter is see-through and outlines stay empty inside. To really remove text, use Redact.");
    expect(i18n.t("details.shapesHide")).toContain(i18n.t("edit.redact"));

    state.shapeKind.value = "pen";
    media.isCoarse.value = true;
    expect(texts(content(d))).toContain("Draw with one finger. Use two fingers to scroll and zoom.");
    expect(texts(content(d))).toContain("Tap a shape to change its colour, width or line style, move it or delete it.");
    state.shapeKind.value = "rect";
    media.isCoarse.value = false;

    i18n.setLocale("it");
    const it = texts(content(d));
    expect(it).toContain("Le forme diventano parte della pagina: chi riceve il file le vede ovunque, ma non le può spostare come i commenti.");
    expect(it.some((s) => s.includes("Per togliere davvero un testo, usa Oscura."))).toBe(true);
    expect(it).toContain("Evidenzia");
    await actions.setTool(null);
  });

  it("the keys: move 1 pt and 10 pt, width and height, delete; Esc deselects, or with none selected back to Cambia; none in the sheet", async () => {
    const d = await inShapes("keys-details.pdf");
    expect(details.shapeShortcuts(false)).toEqual([
      ["←↑→↓", "Move the selected shape"],
      ["Shift + ←↑→↓", "Move it by 10 pt"],
      ["Alt + ←↑→↓", "Change its width or height (a line: move its end)"],
      ["Delete", "Delete it"],
      ["Esc", "Back to Change"],
    ]);
    expect(details.shapeShortcuts(true).at(-1)).toEqual(["Esc", "Deselect"]);
    const said = texts(content(d));
    expect(said).toContain("Move the selected shape");
    expect(said).toContain("Back to Change");
    state.selectedShape.value = { pageIndex: 0, id: 2 };
    expect(texts(content(d))).toContain("Deselect");
    expect(texts(content(d, true))).not.toContain("Move the selected shape");
    state.selectedShape.value = null;

    i18n.setLocale("it");
    expect(details.shapeShortcuts(true).map(([, action]) => action)).toEqual([
      "Sposta la forma selezionata", "Spostala di 10 pt", "Cambiane larghezza o altezza (di una linea, sposta la fine)", "Eliminala", "Deseleziona",
    ]);
    expect(details.shapeShortcuts(false)[3][0]).toBe("Canc");
    await actions.setTool(null);
  });

  it("browsing: the document's facts say where pages are deleted, rotated and moved", async () => {
    const d = await open("pages.pdf");
    expect(texts(content(d))).toContain("To delete, rotate or move pages, use Pages.");
    i18n.setLocale("it");
    expect(texts(content(d))).toContain("Per eliminare, ruotare o spostare le pagine, usa Pagine.");
    expect(i18n.t("details.pagesHowTo")).toContain(i18n.t("tools.pages"));
    // Not once editing has stopped: the pages cannot change then.
    state.editingStopped.value = true;
    expect(texts(content(d))).not.toContain("Per eliminare, ruotare o spostare le pagine, usa Pagine.");
    state.editingStopped.value = false;
  });
});
