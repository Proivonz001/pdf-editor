// The fill viewer's own rules, without a browser: the touch targets of dense check boxes (each box
// is always its own control's, findings 45), the pages Tab goes on to (25; pages whose widgets
// take no focus passed over), the focus staying within a date field and its "Today" (26), the
// name of a picture the user added (54), the app's focus requests and when something may take
// the focus (19, 24, 47, 49), and the layers of Modifica's sub-tools: what a tap does with
// Aggiungi testo, and which overlays a page mounts with Cambia and with Aggiungi testo.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { signal } from "@preact/signals";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import "./stubs/browser-globals";
import type { FieldWidget, Rect } from "../src/engine/protocol";
import type { PageFields } from "../src/viewer/model";

vi.mock("../src/engine/client.ts", () => ({
  EngineError: class EngineError extends Error {},
  EngineClient: class EngineClient {},
}));

let fields: typeof import("../src/viewer/fields");
let added: typeof import("../src/viewer/added");
let state: typeof import("../src/state");
let pageView: typeof import("../src/viewer/PageView");
let fillLayer: typeof import("../src/viewer/FillLayer");

beforeAll(async () => {
  fields = await import("../src/viewer/fields");
  added = await import("../src/viewer/added");
  state = await import("../src/state");
  pageView = await import("../src/viewer/PageView");
  fillLayer = await import("../src/viewer/FillLayer");
});

// --- Touch targets -------------------------------------------------------------------------------

const TARGET = 44;
const area = ([x0, y0, x1, y1]: Rect) => Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
const meet = (a: Rect, b: Rect): Rect => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
const inside = ([x, y]: [number, number], [x0, y0, x1, y1]: Rect) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
const centre = ([x0, y0, x1, y1]: Rect): [number, number] => [(x0 + x1) / 2, (y0 + y1) / 2];

/** Every target holds its own box, no two targets overlap, and no target holds another box's centre. */
function expectSeparate(rects: Rect[], targets: Rect[]) {
  targets.forEach((t, i) => {
    const r = rects[i];
    expect(t[0]).toBeLessThanOrEqual(r[0] + 1e-9);
    expect(t[1]).toBeLessThanOrEqual(r[1] + 1e-9);
    expect(t[2]).toBeGreaterThanOrEqual(r[2] - 1e-9);
    expect(t[3]).toBeGreaterThanOrEqual(r[3] - 1e-9);
    targets.forEach((u, j) => {
      if (i === j) return;
      expect(area(meet(t, u))).toBeLessThanOrEqual(1e-9);
      expect(inside(centre(rects[j]), t)).toBe(false);
    });
  });
}

describe("touch targets of check boxes and radio buttons", () => {
  it("an isolated box gets the full 44 px, centred", () => {
    const [t] = fields.touchTargets([[100, 100, 106, 106]], [true], TARGET);
    expect(t).toEqual([81, 81, 125, 125]);
  });

  it("a box larger than the target keeps its own size", () => {
    const [t] = fields.touchTargets([[0, 0, 60, 50]], [true], TARGET);
    expect(t).toEqual([0, 0, 60, 50]);
  });

  it("a dense column (6 px boxes, 8.4 px apart: 10 pt every 14 pt at phone zoom) never takes a neighbour's tap", () => {
    // The review's case: before, the centre of box 1 hit box 3's target, and so on down the column.
    const rects: Rect[] = Array.from({ length: 8 }, (_, i): Rect => [8, 260 + 8.4 * i, 14, 266 + 8.4 * i]);
    const targets = fields.touchTargets(rects, rects.map(() => true), TARGET);
    expectSeparate(rects, targets);
    for (const [i, t] of targets.entries()) {
      // As wide as a finger (nothing beside them), and halfway to the next box up and down.
      expect(t[2] - t[0]).toBeCloseTo(TARGET);
      if (i > 0) expect(t[1]).toBeCloseTo(rects[i][1] - 1.2);
      if (i < 7) expect(t[3]).toBeCloseTo(rects[i][3] + 1.2);
    }
    // The first and the last still reach out fully on their free side.
    expect(targets[0][1]).toBeCloseTo(260 - 19);
    expect(targets[7][3]).toBeCloseTo(266 + 8.4 * 7 + 19);
    // Each visible centre lands on its own target only.
    for (const r of rects) expect(targets.filter((t) => inside(centre(r), t)).length).toBe(1);
  });

  it("a box beside a text field stops halfway to it, and the field keeps its own box", () => {
    const rects: Rect[] = [[0, 0, 10, 10], [16, -5, 200, 15]];
    const targets = fields.touchTargets(rects, [true, false], TARGET);
    expect(targets[1]).toEqual(rects[1]);
    expect(targets[0][2]).toBeCloseTo(13);
    expect(targets[0][0]).toBeCloseTo(-17);
    expectSeparate(rects, targets);
  });

  it("a grid, and boxes set diagonally, stay apart", () => {
    const grid: Rect[] = [];
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) grid.push([c * 12, r * 12, c * 12 + 6, r * 12 + 6]);
    expectSeparate(grid, fields.touchTargets(grid, grid.map(() => true), TARGET));
    const staggered: Rect[] = [[0, 0, 6, 6], [8, 8, 14, 14], [16, 0, 22, 6], [24, 8, 30, 14]];
    expectSeparate(staggered, fields.touchTargets(staggered, staggered.map(() => true), TARGET));
  });

  it("random layouts: no target ever covers another widget", () => {
    let seed = 7;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let round = 0; round < 200; round++) {
      const rects: Rect[] = [];
      while (rects.length < 12) {
        const w = 4 + random() * 30, h = 4 + random() * 20;
        const x = random() * 200, y = random() * 200;
        const r: Rect = [x, y, x + w, y + h];
        if (rects.every((o) => area(meet(o, r)) === 0)) rects.push(r);
      }
      const grows = rects.map(() => random() < 0.7);
      expectSeparate(rects, fields.touchTargets(rects, grows, TARGET));
    }
  });
});

// --- Tab across pages ----------------------------------------------------------------------------

describe("the pages Tab and Shift+Tab go on to", () => {
  it("are the nearest pages with fields before and after, however far", () => {
    const perPage = [1, 0, 0, 2, 0, 0, 0, 1];
    expect(fields.fieldPagesAround(perPage, 3)).toEqual([0, 7]);
    expect(fields.fieldPagesAround(perPage, 0)).toEqual([null, 3]);
    expect(fields.fieldPagesAround(perPage, 7)).toEqual([3, null]);
    expect(fields.fieldPagesAround([0, 4, 0], 1)).toEqual([null, null]);
  });

  it("follow the field focused last, in the open document only", () => {
    const pages = Array.from({ length: 6 }, () => ({ fields: signal<PageFields | null>(null) }));
    state.doc.value = { id: 41, fileName: "f.pdf", info: { form: { fieldsPerPage: [1, 0, 1, 0, 0, 1] } }, pages } as any;
    fields.noteFieldFocus(2);
    expect([0, 1, 2, 3, 4, 5].map((p) => fields.nextToFieldFocus(p))).toEqual([true, false, false, false, false, true]);
    // The focus leaves the field: they stay (a Tab is on its way to the next one).
    expect(fields.lastFieldFocus.value).toEqual({ docId: 41, pageIndex: 2 });
    // Another document: nothing from the one before.
    state.doc.value = { id: 42, fileName: "g.pdf", info: { form: { fieldsPerPage: [1, 0, 1, 0, 0, 1] } }, pages } as any;
    expect([0, 5].map((p) => fields.nextToFieldFocus(p))).toEqual([false, false]);
    state.doc.value = null;
  });

  it("pass over pages whose widgets take no focus; a page whose fields are not known yet counts", () => {
    const perPage = [1, 1, 0, 1, 2];
    const known: (boolean | null)[] = [true, false, null, true, null];
    expect(fields.fieldPagesAround(perPage, 0, (p) => known[p])).toEqual([null, 3]);
    expect(fields.fieldPagesAround(perPage, 3, (p) => known[p])).toEqual([0, 4]);
    expect(fields.fieldPagesAround(perPage, 4, (p) => known[p])).toEqual([3, null]);
    known[1] = null;
    expect(fields.fieldPagesAround(perPage, 0, (p) => known[p])).toEqual([null, 1]);
  });

  it("the review's form: Tab from alpha on page 1 reaches beta on page 4 past a read-only field on page 2", () => {
    const pages = Array.from({ length: 4 }, () => ({ rev: signal(0), fields: signal<PageFields | null>(null) }));
    state.doc.value = { id: 43, fileName: "ab.pdf", info: { form: { fieldsPerPage: [1, 1, 0, 1] } }, pages } as any;
    const readOnly = widget({ name: "ro", locked: "read-only" });
    pages[0].fields.value = { rev: 0, fields: [widget({ name: "alpha" })] };
    fields.noteFieldFocus(0);
    // Page 2's fields are not read yet: its layer stays in the page, and reads them.
    expect([1, 3].map((p) => fields.nextToFieldFocus(p))).toEqual([true, false]);
    pages[1].fields.value = { rev: 0, fields: [readOnly] };
    expect([1, 3].map((p) => fields.nextToFieldFocus(p))).toEqual([false, true]);
    // A change of page 2 drops its fields: what they said holds while they are read again.
    pages[1].fields.value = null;
    expect([1, 3].map((p) => fields.nextToFieldFocus(p))).toEqual([false, true]);
    // Push buttons and digitally signed signatures take no focus either; "Sign here" does.
    pages[1].fields.value = {
      rev: 1,
      fields: [
        widget({ name: "btn", type: "button", locked: "push-button" }),
        widget({ name: "signed", type: "signature", signed: true, locked: "signature" }),
      ],
    };
    expect([1, 3].map((p) => fields.nextToFieldFocus(p))).toEqual([false, true]);
    pages[1].fields.value = { rev: 2, fields: [widget({ name: "sig", type: "signature", signed: false, locked: "signature" })] };
    expect([1, 3].map((p) => fields.nextToFieldFocus(p))).toEqual([true, false]);
    // Shift+Tab from beta goes back to alpha, past the read-only page.
    pages[1].fields.value = { rev: 3, fields: [readOnly] };
    fields.noteFieldFocus(3);
    expect([0, 1].map((p) => fields.nextToFieldFocus(p))).toEqual([true, false]);
    state.doc.value = null;
  });

  it("Enter says 'done' on the last field when the later pages hold none the app fills in", () => {
    const pages = Array.from({ length: 2 }, () => ({ rev: signal(0), fields: signal<PageFields | null>(null) }));
    state.doc.value = { id: 44, fileName: "cd.pdf", info: { form: { fieldsPerPage: [1, 1] } }, pages } as any;
    const alpha = widget({ name: "alpha" });
    expect(fields.isLastField(0, alpha, [alpha])).toBe(false); // page 2 not read yet
    pages[1].fields.value = { rev: 0, fields: [widget({ name: "ro", locked: "read-only" })] };
    expect(fields.isLastField(0, alpha, [alpha])).toBe(true);
    // "Sign here" takes Tab, not the keyboard's "next" (focusNextField goes to fields the app fills in).
    pages[1].fields.value = { rev: 1, fields: [widget({ name: "sig", type: "signature", locked: "signature" })] };
    expect(fields.isLastField(0, alpha, [alpha])).toBe(true);
    pages[1].fields.value = { rev: 2, fields: [widget({ name: "beta" })] };
    expect(fields.isLastField(0, alpha, [alpha])).toBe(false);
    state.doc.value = null;
  });
});

describe("the focus within a field: its control, or 'Today' in its chip", () => {
  // A field's box (.form-field) holding its control and the chip's "Today" button, and another field.
  const node = (box: { contains: (n: unknown) => boolean } | null) => ({ closest: (s: string) => (s === ".form-field" ? box : null) });
  const parts: unknown[] = [];
  const box = { contains: (n: unknown) => parts.includes(n) };
  const control = node(box);
  const today = node(box);
  parts.push(control, today);
  const other = node({ contains: () => false });

  it("Tab from the field to 'Today' stays within it; on to another field, or nowhere, does not", () => {
    expect(fields.focusWithinField(control as any, control as any)).toBe(true);
    expect(fields.focusWithinField(control as any, today as any)).toBe(true);
    expect(fields.focusWithinField(control as any, other as any)).toBe(false);
    expect(fields.focusWithinField(control as any, null)).toBe(false);
    expect(fields.focusWithinField(node(null) as any, today as any)).toBe(false);
  });

  it("takes the focus: the fields the app fills in and 'Sign here', not locked fields, push buttons or signed signatures", () => {
    expect(fields.takesFocus(widget())).toBe(true);
    expect(fields.takesFocus(widget({ type: "checkbox" }))).toBe(true);
    expect(fields.takesFocus(widget({ type: "signature", locked: "signature" }))).toBe(true);
    expect(fields.takesFocus(widget({ type: "signature", signed: true, locked: "signature" }))).toBe(false);
    expect(fields.takesFocus(widget({ locked: "read-only" }))).toBe(false);
    expect(fields.takesFocus(widget({ locked: "password" }))).toBe(false);
    expect(fields.takesFocus(widget({ type: "button", locked: "push-button" }))).toBe(false);
  });
});

/** A one-line text field widget, unless `over` says otherwise. */
function widget(over: Partial<FieldWidget> = {}): FieldWidget {
  return {
    name: "f", index: 0, type: "text", rect: [0, 0, 100, 20], rotation: 0, label: "", value: "", multiline: false,
    comb: false, maxLen: 0, multiSelect: false, editable: false, required: false, scripted: false, format: null,
    fontSize: 0, color: [0, 0, 0], align: 0, locked: null, ...over,
  };
}

// --- The name of a picture the user added ----------------------------------------------------------

const sig = (id: string, width: number, height: number, description: string) =>
  ({ id, kind: "signature", png: new Blob([]), width, height, description, source: "draw", savedAt: null }) as const;

describe("a picture the user added is named by the signature it was placed with", () => {
  const image = (pixelWidth: number, pixelHeight: number, isAdded = true) => ({ added: isAdded, pixelWidth, pixelHeight });

  it("by its pixel size", () => {
    const sigs = [sig("a", 1200, 400, "Firma: Mario Rossi"), sig("b", 600, 600, "Sigla")];
    expect(added.addedDescription(image(1200, 400), sigs)).toBe("Firma: Mario Rossi");
    expect(added.addedDescription(image(600, 600), sigs)).toBe("Sigla");
  });

  it("not a photo, not an image of the document, not a guess between two descriptions", () => {
    const sigs = [sig("a", 1200, 400, "Firma: Mario Rossi"), sig("b", 1200, 400, "Firma: Luigi Bianchi")];
    expect(added.addedDescription(image(1600, 1200), sigs)).toBeNull();
    expect(added.addedDescription(image(1200, 400, false), sigs)).toBeNull();
    expect(added.addedDescription(image(1200, 400), sigs)).toBeNull();
    // The same signature known twice (made, then saved) is still the one.
    expect(added.addedDescription(image(1200, 400), [sigs[0], { ...sigs[0], id: "c" }])).toBe("Firma: Mario Rossi");
  });
});

// --- Focus requests ------------------------------------------------------------------------------

describe("focus requests and taking the focus", () => {
  // A few DOM element kinds, enough for mayTakeFocus: `within` lists the selectors an element is inside.
  class FakeElement {
    classList: { contains: (c: string) => boolean };
    isContentEditable = false;
    focused = 0;
    constructor(readonly within: string[] = [], classes: string[] = []) {
      this.classList = { contains: (c: string) => classes.includes(c) };
    }
    closest(selector: string) {
      return selector.split(",").some((s) => this.within.includes(s.trim())) ? this : null;
    }
    focus() {
      this.focused++;
      (globalThis as any).document.activeElement = this;
    }
  }
  class FakeInput extends FakeElement {
    constructor(readonly type: string, within: string[] = [], classes: string[] = []) {
      super(within, classes);
    }
  }
  class FakeTextArea extends FakeElement {}
  class FakeSelect extends FakeElement {}
  const g = globalThis as any;
  const body = new FakeElement();

  beforeAll(() => {
    g.HTMLElement = FakeElement;
    g.HTMLInputElement = FakeInput;
    g.HTMLTextAreaElement = FakeTextArea;
    g.HTMLSelectElement = FakeSelect;
    g.document.body = body;
  });

  const focusOn = (el: FakeElement | null) => {
    g.document.activeElement = el;
  };

  it("nothing is taken from a field the user fills, the writer, or a dialog", () => {
    focusOn(body);
    expect(added.mayTakeFocus()).toBe(true);
    focusOn(new FakeElement(["button"]));
    expect(added.mayTakeFocus()).toBe(true); // "Put it in the middle", a picture's box
    focusOn(new FakeInput("text", [".form-fields"]));
    expect(added.mayTakeFocus()).toBe(false);
    focusOn(new FakeInput("checkbox", [".form-fields"]));
    expect(added.mayTakeFocus()).toBe(false); // a box just ticked
    focusOn(new FakeElement([".form-fields"], ["form-field-sign"]));
    expect(added.mayTakeFocus()).toBe(true); // "Sign here": the signature placed there takes it
    focusOn(new FakeInput("text", [".writer"]));
    expect(added.mayTakeFocus()).toBe(false);
    focusOn(new FakeElement([".writer-bar"]));
    expect(added.mayTakeFocus()).toBe(false); // A+ in the writer's bar
    focusOn(new FakeInput("text"));
    expect(added.mayTakeFocus()).toBe(false); // the phone's hidden keyboard holder
    focusOn(new FakeTextArea());
    expect(added.mayTakeFocus()).toBe(false);
    focusOn(new FakeElement(["dialog"]));
    expect(added.mayTakeFocus()).toBe(false);
  });

  it("a request is taken by its layer once what it names is there, and only then cleared", () => {
    focusOn(body);
    const box = new FakeElement();
    state.focusRequest.value = { pageIndex: 1, kind: "added", id: 7 };
    const find = vi.fn((id: number | string) => (id === 7 ? (box as any) : null));
    added.honourFocusRequest(0, "added", true, find); // another page
    added.honourFocusRequest(1, "image", true, find); // another kind
    added.honourFocusRequest(1, "added", false, find); // the page is being read again
    expect(find).not.toHaveBeenCalled();
    expect(state.focusRequest.value).not.toBeNull();
    added.honourFocusRequest(1, "added", true, () => null); // not there yet: it waits
    expect(state.focusRequest.value).not.toBeNull();
    added.honourFocusRequest(1, "added", true, find);
    expect(box.focused).toBe(1);
    expect(state.focusRequest.value).toBeNull();
  });

  it("the user typing elsewhere keeps the focus; a request is done all the same", () => {
    const field = new FakeInput("text", [".form-fields"]);
    focusOn(field);
    const box = new FakeElement();
    state.focusRequest.value = { pageIndex: 0, kind: "image", id: 2 };
    added.honourFocusRequest(0, "image", true, () => box as any);
    expect(box.focused).toBe(0);
    expect(g.document.activeElement).toBe(field);
    expect(state.focusRequest.value).toBeNull();
  });

  it("a request never found is dropped after a while, and a late one moves nothing", () => {
    focusOn(body);
    const now = vi.spyOn(performance, "now");
    try {
      now.mockReturnValue(1000);
      state.focusRequest.value = { pageIndex: 0, kind: "field", id: "nome" };
      added.honourFocusRequest(0, "field", true, () => null);
      expect(state.focusRequest.value).not.toBeNull();
      now.mockReturnValue(6000);
      const late = new FakeElement();
      added.honourFocusRequest(0, "field", true, () => late as any);
      expect(late.focused).toBe(0);
      expect(state.focusRequest.value).toBeNull();
    } finally {
      now.mockRestore();
    }
  });
});

// --- Modifica's sub-tools --------------------------------------------------------------------------

describe("Modifica's sub-tools: Aggiungi testo writes as Testo does, Cambia keeps the lines and images", () => {
  afterEach(() => {
    state.tool.value = null;
    state.editTool.value = "change";
    state.fillTool.value = "text";
    state.selectedImage.value = null;
    state.pendingPlacement.value = null;
    state.editingStopped.value = false;
  });

  it("a page mounts the writer's layers with Aggiungi testo, the lines and images with Cambia, form fields never in Modifica", () => {
    expect(pageView.layersFor("edit", "change", false)).toEqual({ edit: true, writer: false, fields: false });
    expect(pageView.layersFor("edit", "addText", false)).toEqual({ edit: false, writer: true, fields: false });
    // Compila e firma and browse as before (the sub-tool of Modifica does not matter there).
    expect(pageView.layersFor("fill", "change", false)).toEqual({ edit: false, writer: true, fields: true });
    expect(pageView.layersFor("fill", "addText", false)).toEqual({ edit: false, writer: true, fields: true });
    expect(pageView.layersFor(null, "addText", false)).toEqual({ edit: false, writer: false, fields: true });
    // Editing stopped: no writer and no fields; Modifica's lines and images as they always were.
    expect(pageView.layersFor("fill", "change", true)).toEqual({ edit: false, writer: false, fields: false });
    expect(pageView.layersFor("edit", "addText", true)).toEqual({ edit: false, writer: false, fields: false });
    expect(pageView.layersFor("edit", "change", true)).toEqual({ edit: true, writer: false, fields: false });
  });

  it("a tap in Modifica with Aggiungi testo opens a text writer even when Compila e firma's sub-tool is ✓", () => {
    state.fillTool.value = "check";
    state.tool.value = "edit";
    state.editTool.value = "addText";
    expect(fillLayer.tapIntent(false)).toEqual({ do: "write" });
    for (const sub of ["cross", "date", "signature", "initials"] as const) {
      state.fillTool.value = sub;
      expect(fillLayer.tapIntent(false)).toEqual({ do: "write" });
    }
    // The same tap in Compila e firma does what its sub-tool says.
    state.tool.value = "fill";
    expect(fillLayer.tapIntent(false)).toEqual({ do: "choose", kind: "initials" });
    state.fillTool.value = "check";
    expect(fillLayer.tapIntent(false)).toEqual({ do: "mark", mark: "check" });
    state.fillTool.value = "date";
    expect(fillLayer.tapIntent(false)).toEqual({ do: "date" });
    state.fillTool.value = "text";
    expect(fillLayer.tapIntent(false)).toEqual({ do: "write" });
  });

  it("with Aggiungi testo a tap first deselects a picture the user added, as in Compila e firma", () => {
    state.tool.value = "edit";
    state.editTool.value = "addText";
    state.selectedImage.value = { pageIndex: 0, index: 2 };
    expect(fillLayer.tapIntent(false)).toEqual({ do: "deselect" });
    state.selectedImage.value = null;
    expect(fillLayer.tapIntent(false)).toEqual({ do: "write" });
  });

  it("no writer, no tap: Cambia, browse, and once editing has stopped", () => {
    state.tool.value = "edit";
    expect(fillLayer.tapIntent(false)).toEqual({ do: "nothing" }); // Cambia
    state.tool.value = null;
    expect(fillLayer.tapIntent(false)).toEqual({ do: "nothing" });
    state.tool.value = "edit";
    state.editTool.value = "addText";
    state.editingStopped.value = true;
    expect(fillLayer.tapIntent(false)).toEqual({ do: "nothing" });
  });
});
