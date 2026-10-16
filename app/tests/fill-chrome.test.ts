// The chrome of Compila e firma and Modifica against the app's real modules with a fake engine
// (no browser): what a form offers, from FormInfo's counts with no page read at open (a signed
// PDF and a read-only form are not forms to fill in), the form notice, "Next empty field" from
// the field the user was in, reading only the pages it gets to and busy while it reads, the bars
// at the bottom that follow typingField, the details panel's keys while writing, the
// missing-fields question about one field, the singulars, the full stops of the marks' toasts,
// the Browse tooltip; and the tools' bars (the components are called as functions and their
// trees read, nothing is rendered): Compila e firma's six sub-tools, Modifica's three and what
// they call, "Put it in the middle" as an icon alone on desktop and phones, the strips on phones,
// Done's tooltip naming Esc only where Esc leaves, the form's notes as toasts on phones once per
// document.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "./stubs/browser-globals";

vi.mock("../src/engine/client.ts", () => {
  class EngineError extends Error {
    constructor(message: string, readonly code?: string) {
      super(message);
    }
  }
  const e = () => (globalThis as any).__chromeEngine;
  class EngineClient {
    ready = Promise.resolve();
    open(bytes: ArrayBuffer) { return e().open(bytes); }
    fields(p: number) { return e().fields(p); }
    setField(name: string, value: unknown) { return e().setField(name, value); }
    lines() { return Promise.resolve([]); }
    images() { return Promise.resolve([]); }
    addedTexts() { return Promise.resolve([]); }
    close() { return Promise.resolve(null); }
  }
  return { EngineError, EngineClient };
});

// IndexedDB is not in Node: no saved signatures.
vi.mock("../src/ui/fill/signatureStore.ts", () => ({
  MAX_SAVED: 5,
  available: async () => false,
  list: async () => [],
  save: async () => null,
  forget: async () => false,
}));

/** The engine calls, in order. */
const calls: string[] = [];
/** DocInfo fields the next open returns on top of a plain one-page PDF. */
let nextInfo: Record<string, unknown> = {};
/** The widgets of each page, as the engine lists them. */
let widgets: Record<number, any[]> = {};
/** Field values the engine holds, by name (setField writes here; fields() reads them). */
const values = new Map<string, string>();
/** While set, every fields() call waits for it (a slow engine). */
let gate: Promise<void> | null = null;

(globalThis as any).__chromeEngine = {
  open: async () => ({
    ok: true, pageCount: 1, pages: [{ index: 0, bounds: [0, 0, 100, 100] }], encrypted: false, needsPassword: false,
    canKeepPassword: false, pdfa: null, signatures: 0, title: null, ...nextInfo,
  }),
  fields: async (p: number) => {
    calls.push(`fields:${p}`);
    if (gate) await gate;
    if (widgets[p] === undefined) throw new Error("no such page");
    return widgets[p].map((f) => (values.has(f.name) ? { ...f, value: values.get(f.name) } : f));
  },
  setField: async (name: string, value: { text: string }) => {
    calls.push(`setField:${name}`);
    values.set(name, value.text);
    return { editCount: 1, canUndo: true, canRedo: false, changedPages: [0], name, missingChars: [], overflow: false };
  },
};

/** A form field widget as the engine lists it: an empty text field unless `extra` says otherwise. */
const FIELD = (name: string, extra: Record<string, unknown> = {}) => ({
  name, index: 0, type: "text", rect: [10, 10, 90, 30], rotation: 0, label: name, value: "", multiline: false,
  comb: false, maxLen: 0, multiSelect: false, editable: false, required: false, scripted: false, format: null,
  fontSize: 0, color: [0, 0, 0], align: 0, locked: null, ...extra,
}) as any;
/**
 * DocInfo.form with `perPage` widgets on each page and `required` fields required; as many fields
 * to fill in as widgets unless `extra` says otherwise (FormInfo counts distinct, unlocked names).
 */
const FORM = (perPage: number[], required: number, extra: Record<string, unknown> = {}) => ({
  form: {
    fieldsPerPage: perPage, fields: perPage.reduce((a, b) => a + b, 0), required, xfa: "none", scripts: false, ...extra,
  },
});
const PAGES = (n: number) => ({
  pageCount: n, pages: Array.from({ length: n }, (_, index) => ({ index, bounds: [0, 0, 100, 100] })),
});

let state: typeof import("../src/state");
let actions: typeof import("../src/ui/actions");
let bar: typeof import("../src/ui/fill/FillBar");
let i18n: typeof import("../src/i18n");

beforeAll(async () => {
  state = await import("../src/state");
  actions = await import("../src/ui/actions");
  bar = await import("../src/ui/fill/FillBar");
  i18n = await import("../src/i18n");
});

beforeEach(() => {
  i18n.setLocale("en");
  calls.length = 0;
  values.clear();
  (globalThis as any).document.activeElement = null;
});

/** Open a document whose pages hold `pages` (the widgets of each page) with `info` on top. */
async function open(name: string, pages: any[][], info: Record<string, unknown> = {}) {
  widgets = Object.fromEntries(pages.map((list, p) => [p, list]));
  nextInfo = { ...PAGES(pages.length), ...FORM(pages.map((list) => list.length), 0), ...info };
  const file = { name, type: "application/pdf", arrayBuffer: async () => new TextEncoder().encode(name).buffer } as unknown as File;
  await actions.openFile(file, { confirmed: true });
  nextInfo = {};
  state.toasts.value = [];
  calls.length = 0;
  return state.doc.value!;
}

const toastTexts = () => state.toasts.value.map((x) => x.text);

describe("C1 what a form offers", () => {
  // FormInfo counts the fields to fill in when the document opens (distinct names, not locked,
  // signature fields left out): the banner, the panel and the notice take its counts, and no
  // page's fields are read for them.

  it("a signed PDF whose only field is its signature is not announced as a form, nor counted", async () => {
    const d = await open("signed.pdf", [[FIELD("Signature1", { type: "signature", signed: true, locked: "signature" })]], {
      signatures: 1, ...FORM([1], 0, { fields: 0 }),
    });
    bar.announceForm(d);
    expect(toastTexts()).toEqual([]);
    expect(bar.fillableFields(d)).toBeNull();
    expect(bar.fillHint(bar.fillableFields(d) !== null, null, false)).toBe("Click where you want to write.");
    expect(calls).toEqual([]);
  });

  it("nor is a form whose fields are all read-only; its notes are not said either", async () => {
    const d = await open("locked.pdf", [[FIELD("a", { locked: "read-only", required: true }), FIELD("b", { index: 1, locked: "password" })]], {
      ...FORM([2], 0, { fields: 0, xfa: "static", scripts: true }),
    });
    bar.announceForm(d);
    expect(toastTexts()).toEqual([]);
    expect(bar.fillableFields(d)).toBeNull();
    expect(bar.formNotes(d.info.form, false)).toEqual([]);
  });

  it("counts what FormInfo counts, and says it is a form once, without reading any page", async () => {
    const d = await open("form.pdf", [
      [
        FIELD("nome", { required: true }),
        FIELD("pagato", { index: 1, type: "checkbox", value: "Off" }),
        FIELD("firma", { index: 2, type: "signature", locked: "signature", required: true }),
      ],
      [FIELD("nome", { required: true })], // the same field again on page 2
    ], FORM([3, 1], 1, { fields: 2 }));
    bar.announceForm(d);
    expect(bar.fillableFields(d)).toEqual({ fields: 2, required: 1 });
    expect(toastTexts()).toEqual(["This PDF is a form: click a field to type in it."]);
    expect(bar.formCountText(2, 1)).toBe("2 fields, 1 required");
    bar.announceForm(d); // once per document
    expect(toastTexts()).toHaveLength(1);
    expect(calls).toEqual([]);
  });

  it("a form of 300 pages opens without its fields being read", async () => {
    const pages = Array.from({ length: 300 }, (_, p) => Array.from({ length: 21 }, (_, i) => FIELD(`p${p}f${i}`, { index: i })));
    const d = await open("big.pdf", pages, FORM(pages.map((l) => l.length), 300, { fields: 6300 }));
    bar.announceForm(d);
    expect(bar.fillableFields(d)).toEqual({ fields: 6300, required: 300 });
    expect(toastTexts()).toEqual(["This PDF is a form: click a field to type in it."]);
    expect(calls.filter((c) => c.startsWith("fields:"))).toEqual([]);
  });

  it("a form whose only field is a signature field still unsigned has nothing to fill in (Sign here is on the page)", async () => {
    const d = await open("tosign.pdf", [[FIELD("Firma", { type: "signature", locked: "signature" })]], FORM([1], 0, { fields: 0 }));
    bar.announceForm(d);
    expect(bar.fillableFields(d)).toBeNull();
    expect(toastTexts()).toEqual([]);
  });

  it("a dynamic XFA form says it can't be filled in", async () => {
    const xfa = await open("xfa.pdf", [[FIELD("a")]], FORM([1], 0, { xfa: "dynamic" }));
    bar.announceForm(xfa);
    expect(toastTexts()).toEqual([i18n.t("form.xfa")]);
    expect(bar.fillableFields(xfa)).toBeNull();
    expect(bar.formNotes(xfa.info.form, false)).toEqual([i18n.t("form.xfa")]);
  });
});

describe("C2 next empty field", () => {
  it("goes on from the field the user was in, though pressing the button took the focus out of it", async () => {
    await open("next.pdf", [[FIELD("a"), FIELD("b", { index: 1 }), FIELD("c", { index: 2, value: "x" })]]);
    state.focusedField.value = { pageIndex: 0, name: "a", index: 0 };
    state.focusedField.value = null; // the field's blur, before the button's click
    await bar.goToNextEmptyField();
    expect(state.focusedField.value).toEqual({ pageIndex: 0, name: "b", index: 1 });

    // From b: c is filled, a is next round the start.
    await bar.goToNextEmptyField();
    expect(state.focusedField.value).toEqual({ pageIndex: 0, name: "a", index: 0 });
  });

  it("writes what is being typed first, and never goes back to the field just filled", async () => {
    await open("typed.pdf", [[FIELD("a"), FIELD("b", { index: 1, value: "y" })]]);
    state.focusedField.value = { pageIndex: 0, name: "a", index: 0 };
    const page = state.doc.value!.pages[0];
    const unregister = state.registerEditor({
      changed: () => true,
      commit: async () => {
        unregister();
        await actions.setFieldValue(0, FIELD("a"), { kind: "text", text: "Luca" }, page.rev.peek());
      },
    });
    await bar.goToNextEmptyField();
    expect(calls[0]).toBe("setField:a");
    expect(state.focusedField.value).toEqual({ pageIndex: 0, name: "a", index: 0 }); // stays: no other field is empty
    expect(toastTexts()).toEqual(["No empty fields left."]);
  });

  it("the field the user is in, still empty and the only one, is the last empty field: not 'no empty fields left'", async () => {
    await open("last.pdf", [[FIELD("a"), FIELD("b", { index: 1, value: "y" })]]);
    state.focusedField.value = { pageIndex: 0, name: "a", index: 0 };
    await bar.goToNextEmptyField();
    expect(state.focusedField.value).toEqual({ pageIndex: 0, name: "a", index: 0 });
    expect(toastTexts()).toEqual(["This is the last empty field."]);
  });

  it("starts from the current page when the field the user was in is far from it", async () => {
    const d = await open("far.pdf", [[FIELD("a")], [], [], [FIELD("d"), FIELD("e", { index: 1 })]]);
    state.focusedField.value = { pageIndex: 0, name: "a", index: 0 };
    state.focusedField.value = null;
    state.currentPage.value = 3;
    expect(bar.nextEmptyFrom(d)).toEqual({ pageIndex: 3, index: -1 });
    state.currentPage.value = 1; // one page on: still about where the user is
    expect(bar.nextEmptyFrom(d)).toEqual({ pageIndex: 0, index: 0, name: "a" });
    state.currentPage.value = 0;
  });

  it("reads only the pages it gets to: the current page first, then the next ones, up to the empty field", async () => {
    const filled = (name: string, index = 0) => FIELD(name, { index, value: "x" });
    await open("lazy.pdf", [[FIELD("a")], [filled("b")], [filled("c")], [filled("d"), FIELD("e", { index: 1 })], [FIELD("f")], [FIELD("g")]]);
    state.focusedField.value = null;
    state.currentPage.value = 1;
    await bar.goToNextEmptyField();
    expect(state.focusedField.value).toEqual({ pageIndex: 3, name: "e", index: 1 });
    expect(calls).toEqual(["fields:1", "fields:2", "fields:3"]);
    state.currentPage.value = 0;
  });

  it("shows that it is busy while it reads pages for longer than a moment; a second press joins the same search", async () => {
    await open("slow.pdf", [[FIELD("a", { value: "x" })], [FIELD("b")]]);
    state.focusedField.value = null;
    state.currentPage.value = 0;
    let release!: () => void;
    gate = new Promise<void>((resolve) => (release = resolve));
    try {
      const first = bar.goToNextEmptyField();
      expect(bar.goToNextEmptyField()).toBe(first);
      expect(bar.seekingEmpty.value).toBe(false); // not at once: most searches are over before it would show
      await new Promise((resolve) => setTimeout(resolve, bar.SEEK_BUSY_MS + 50));
      expect(bar.seekingEmpty.value).toBe(true);
      release();
      await first;
      expect(bar.seekingEmpty.value).toBe(false);
      expect(state.focusedField.value).toEqual({ pageIndex: 1, name: "b", index: 0 });
      expect(calls).toEqual(["fields:0", "fields:1"]); // once each, for both presses
    } finally {
      gate = null;
    }
  });
});

describe("C3 the bars at the bottom on phones", () => {
  it("follow typingField (set by the control that really has the focus), not the field the app asked for", async () => {
    const { bottomBarsHidden, TabBar } = await import("../src/ui/TabBar");
    await open("bars.pdf", [[FIELD("a"), FIELD("b", { index: 1, type: "checkbox" })]]);
    expect(bottomBarsHidden()).toBe(false);
    expect(TabBar()).not.toBeNull();

    // A text field has the focus: the keyboard is up.
    state.focusedField.value = { pageIndex: 0, name: "a", index: 0 };
    state.typingField.value = true;
    expect(bottomBarsHidden()).toBe(true);
    expect(TabBar()).toBeNull();

    // "Next empty field" asks for the check box: until the box has the focus, the text field's
    // keyboard is still up; once it has (the text field's blur), the bars come back.
    state.focusedField.value = { pageIndex: 0, name: "b", index: 1 };
    expect(bottomBarsHidden()).toBe(true);
    state.typingField.value = false;
    expect(bottomBarsHidden()).toBe(false);
    expect(TabBar()).not.toBeNull();

    // And from the check box to a text field: hidden as soon as the text field takes the focus.
    state.focusedField.value = { pageIndex: 0, name: "a", index: 0 };
    expect(bottomBarsHidden()).toBe(false);
    state.typingField.value = true;
    expect(bottomBarsHidden()).toBe(true);
    state.typingField.value = false;
    state.focusedField.value = null;
  });
});

describe("C4 texts", () => {
  it("the writer's keys do not list Tab, which goes to the writer's own bar there", async () => {
    const { fillShortcuts } = await import("../src/ui/DetailsPanel");
    expect(fillShortcuts("writer").map(([key]) => key)).toEqual(["Enter", "Shift + Enter", "Esc"]);
    expect(fillShortcuts("idle").map(([key]) => key)).toContain("Tab");
  });

  it("the missing-fields question speaks of one field in the singular", async () => {
    const { missingFieldsTexts } = await import("../src/ui/Dialogs");
    expect(missingFieldsTexts(1)).toEqual({
      title: "A required field is empty", body: "1 required field is still empty. Download it anyway?", fill: "Fill it in",
    });
    expect(missingFieldsTexts(3).title).toBe("Some required fields are empty");
    expect(missingFieldsTexts(3).fill).toBe("Fill them in");
    i18n.setLocale("it");
    expect(missingFieldsTexts(1)).toEqual({
      title: "Manca un campo obbligatorio", body: "1 campo obbligatorio è ancora vuoto. Vuoi scaricarlo lo stesso?",
      fill: "Compilalo",
    });
    expect(missingFieldsTexts(2).fill).toBe("Compilali");
  });

  it("Browse no longer promises that nothing changes: form fields work there (D2)", () => {
    for (const locale of ["en", "it"] as const) {
      i18n.setLocale(locale);
      const tip = i18n.t("tools.browseTip", { key: "Esc" });
      expect(tip).not.toMatch(/without changing|senza cambiare/);
      expect(tip).toMatch(/form fields|campi del modulo/);
    }
  });

  it("singulars: a field of 1 character, the one other page of a two-page document", async () => {
    const { fieldLengthText } = await import("../src/ui/DetailsPanel");
    const { initialsAllText } = await import("../src/ui/Dialogs");
    expect([fieldLengthText(1), fieldLengthText(16), fieldLengthText(0)]).toEqual(["Up to 1 character", "Up to 16 characters", "No limit"]);
    expect([initialsAllText(1), initialsAllText(3)]).toEqual(["The other page", "All the other pages (3)"]);
    i18n.setLocale("it");
    expect([fieldLengthText(1), fieldLengthText(16)]).toEqual(["Al massimo 1 carattere", "Al massimo 16 caratteri"]);
    expect([initialsAllText(1), initialsAllText(3)]).toEqual(["L'altra pagina", "Tutte le altre pagine (3)"]);
  });

  it("the toasts and statuses of marks and dates end their sentence; the last empty field is said in both languages", () => {
    const where = { page: 1, x: "47", y: "99" };
    expect(i18n.t("mark.placedAt", where)).toBe("Mark on page 1, 47 mm from the left and 99 mm from the top.");
    expect(i18n.t("writer.doneAt", where)).toBe("Written on page 1, 47 mm from the left and 99 mm from the top.");
    expect(i18n.t("form.lastEmpty")).toBe("This is the last empty field.");
    i18n.setLocale("it");
    expect(i18n.t("mark.placedAt", where)).toBe("Segno messo a pagina 1, a 47 mm da sinistra e 99 mm dall'alto.");
    expect(i18n.t("writer.doneAt", where)).toBe("Scritto a pagina 1, a 47 mm da sinistra e 99 mm dall'alto.");
    expect(i18n.t("form.lastEmpty")).toBe("Questo è l'ultimo campo vuoto.");
  });

  it("every text has the same placeholders in both languages", async () => {
    const { en } = await import("../src/i18n/en");
    const { it: itMessages } = await import("../src/i18n/it");
    const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect({ key, holes: holes(itMessages[key]) }).toEqual({ key, holes: holes(en[key]) });
    }
  });

  it("singulars for one page of initials; the phone's picture toast names the round grip", () => {
    expect(i18n.t("initials.workingOne")).toBe("Adding initials to 1 page…");
    expect(i18n.t("fill.imagePlacedTouch", { page: 2 })).toBe("Image added on page 2. Drag the round grip to move it.");
    i18n.setLocale("it");
    expect(i18n.t("initials.workingOne")).toBe("Metto la sigla su 1 pagina…");
    expect(i18n.t("fill.imagePlacedTouch", { page: 2 })).toBe("Immagine aggiunta a pagina 2. Trascina la maniglia tonda per spostarla.");
  });
});

describe("C5 the tools' bars", () => {
  let sub: typeof import("../src/ui/SubTools");
  let edit: typeof import("../src/ui/EditBar");
  let media: typeof import("../src/ui/media");
  let icons: typeof import("../src/ui/icons");

  beforeAll(async () => {
    sub = await import("../src/ui/SubTools");
    edit = await import("../src/ui/EditBar");
    media = await import("../src/ui/media");
    icons = await import("../src/ui/icons");
  });

  /** Every element and component in the tree of `node` (components are not called: they show as themselves). */
  function nodes(node: any): any[] {
    if (node == null || typeof node !== "object") return [];
    if (Array.isArray(node)) return node.flatMap(nodes);
    return [node, ...nodes(node.props?.children)];
  }
  const ofType = (node: any, type: unknown) => nodes(node).filter((n) => n.type === type);
  const statusText = (node: any) => nodes(node).find((n) => n.props?.role === "status")?.props.children;
  const elRef = { current: null };
  /** Lets an action that awaits flushEditor end. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  /** Run `fn` in the phone layout (and with a touch screen when `touch`), then back to the desktop. */
  function onPhone(fn: () => void, touch = false) {
    media.isNarrow.value = true;
    media.isCoarse.value = touch;
    try {
      fn();
    } finally {
      media.isNarrow.value = false;
      media.isCoarse.value = false;
    }
  }

  it("Compila e firma has six sub-tools, none of them Immagine, all toggles, in the banner and in the strip", async () => {
    const d = await open("six.pdf", [[]]);
    await actions.setTool("fill");
    const ids = ["text", "check", "cross", "date", "signature", "initials"];
    const items = bar.fillToolItems("check", false);
    expect(items.map((x) => x.id)).toEqual(ids);
    expect(items.map((x) => x.pressed)).toEqual([false, true, false, false, false, false]);

    const [tools] = ofType(bar.FillBanner({ doc: d, elRef }), sub.SubTools);
    expect(tools.props.label).toBe("Fill & sign tools");
    expect(tools.props.items.map((x: any) => x.id)).toEqual(ids);
    expect(bar.FillStrip().props.items.map((x: any) => x.id)).toEqual(ids);
    // On phones the sub-tools are in the strip, not in the banner.
    onPhone(() => expect(ofType(bar.FillBanner({ doc: d, elRef }), sub.SubTools)).toEqual([]));

    const { en } = await import("../src/i18n/en");
    expect(Object.keys(en).filter((key) => key === "fill.image" || key === "fill.imageTip")).toEqual([]);
    await actions.setTool(null);
  });

  it("'Put it in the middle' is an icon alone, named and with its tooltip, for every sub-tool and a waiting signature, on desktop and phones", async () => {
    const d = await open("middle.pdf", [[]]);
    await actions.setTool("fill");

    const button = sub.PlaceCentreButton();
    expect(button.type).toBe("button");
    expect(button.props["aria-label"]).toBe("Put it in the middle");
    expect(button.props.title).toBe(i18n.t("fill.placeCenterTip"));
    expect(button.props.children.type).toBe(icons.IconTarget); // the icon, and no words beside it
    onPhone(() => expect(sub.PlaceCentreButton().props.title).toBe(i18n.t("fill.placeCenterTipTouch")), true);

    const middles = () => ofType(bar.FillBanner({ doc: d, elRef }), sub.PlaceCentreButton).length;
    for (const id of ["text", "check", "cross", "date", "signature", "initials"] as const) {
      state.fillTool.value = id;
      expect({ id, middles: middles() }).toEqual({ id, middles: 1 });
      onPhone(() => expect({ id, middles: middles() }).toEqual({ id, middles: 1 }));
    }
    state.fillTool.value = "signature";
    state.pendingPlacement.value = {
      id: "s1", kind: "signature", png: new Blob([]), width: 10, height: 4, description: "Signature", source: "draw", savedAt: null,
    };
    try {
      expect(middles()).toBe(1);
      onPhone(() => expect(middles()).toBe(1));
    } finally {
      state.pendingPlacement.value = null;
      state.fillTool.value = "text";
    }
    await actions.setTool(null);
  });

  it("Modifica's sub-tools: Change and Add text are toggles that follow editTool, Add image opens the picker within the click", async () => {
    const d = await open("edit.pdf", [[]]);
    await actions.setTool("edit");
    expect(state.editTool.value).toBe("change");

    const toolsOf = () => ofType(edit.EditBanner({ doc: d, elRef }), sub.SubTools)[0];
    let tools = toolsOf();
    expect(tools.props.label).toBe("Editing tools");
    expect(tools.props.items.map((x: any) => [x.id, x.pressed])).toEqual([["change", true], ["addText", false], ["addImage", undefined]]);
    expect(statusText(edit.EditBanner({ doc: d, elRef }))).toBe("Click a line to change it, or an image to move it.");

    tools.props.items[1].onChoose();
    await settle();
    expect(state.editTool.value).toBe("addText");
    tools = toolsOf();
    expect(tools.props.items.map((x: any) => x.pressed)).toEqual([false, true, undefined]);
    expect(statusText(edit.EditBanner({ doc: d, elRef }))).toBe("Click where you want to write, or on a text you wrote to change it.");

    // The buttons: aria-pressed on the toggles only, the name on the button with its tooltip.
    const button = (item: any) => sub.SubToolButton({ item, tabbable: item.pressed === true, onFocus: () => undefined });
    expect(tools.props.items.map((x: any) => button(x).props["aria-pressed"])).toEqual([false, true, undefined]);
    const addText = button(tools.props.items[1]);
    expect([addText.props["aria-label"], addText.props.title, addText.props.tabIndex]).toEqual(["Add text", "Write new text where you click", 0]);
    expect(ofType(addText, "span")[0].props.children).toBe("Add text");

    // Aggiungi immagine: the picker, opened right there; nothing changes until a picture is chosen.
    expect(tools.props.items[2].onChoose).toBe(actions.chooseNewPicture);
    const created = (globalThis as any).__created as { tag: string; clicked?: boolean }[];
    const before = created.length;
    tools.props.items[2].onChoose();
    expect(created.slice(before).filter((el) => el.tag === "input" && el.clicked)).toHaveLength(1);
    expect(state.editTool.value).toBe("addText");

    tools.props.items[0].onChoose();
    await settle();
    expect(state.editTool.value).toBe("change");

    // Done leaves Modifica.
    const done = nodes(edit.EditBanner({ doc: d, elRef })).find((n) => n.props?.class?.includes("edit-banner-done"));
    done.props.onClick();
    await settle();
    expect(state.tool.value).toBeNull();
  });

  it("'Put it in the middle' in Modifica only with Add text, on desktop and phones; the hint follows the sub-tool there too", async () => {
    const d = await open("middle-edit.pdf", [[]]);
    await actions.setTool("edit");
    const banner = () => edit.EditBanner({ doc: d, elRef });
    const middles = () => ofType(banner(), sub.PlaceCentreButton).length;
    expect(middles()).toBe(0);
    onPhone(() => {
      expect(middles()).toBe(0);
      expect(ofType(banner(), sub.SubTools)).toEqual([]); // in the strip on phones
      expect(statusText(banner())).toBe("Tap a line to change it, or an image to move it.");
    }, true);
    await actions.setEditTool("addText");
    expect(middles()).toBe(1);
    onPhone(() => {
      expect(middles()).toBe(1);
      expect(statusText(banner())).toBe("Tap where you want to write, or a text you wrote to change it.");
    }, true);
    i18n.setLocale("it");
    expect(statusText(banner())).toBe("Fai clic dove vuoi scrivere, o su un testo che hai scritto per cambiarlo.");
    await actions.setTool(null);
  });

  it("the strip of sub-tools on phones: Modifica's or Compila e firma's, away while the keyboard is up", async () => {
    const { stripFor } = await import("../src/viewer/Viewer");
    await open("strip.pdf", [[]]);
    await actions.setTool("edit");
    const strip = edit.EditStrip();
    expect(strip.props.label).toBe("Editing tools");
    expect(strip.props.items.map((x: any) => [x.id, x.pressed])).toEqual([["change", true], ["addText", false], ["addImage", undefined]]);

    expect([stripFor("edit"), stripFor("fill")]).toEqual([null, null]); // desktop: in the banner
    onPhone(() => {
      expect([stripFor("edit"), stripFor("fill"), stripFor("stopped"), stripFor(null)]).toEqual(["edit", "fill", null, null]);
      state.openWriter.value = { pageIndex: 0, origin: [10, 10], text: "", size: 11, color: "black", kind: "text", editing: null, rev: 0 };
      try {
        expect(stripFor("edit")).toBeNull();
      } finally {
        state.openWriter.value = null;
      }
    });
    await actions.setTool(null);
  });

  it("Done names Esc where Esc leaves: Modifica with Change and Compila e firma, not Modifica with Add text", async () => {
    const d = await open("done.pdf", [[]]);
    const doneTip = (banner: any) => nodes(banner).find((n) => n.props?.class?.includes("edit-banner-done")).props.title;
    await actions.setTool("edit");
    expect(doneTip(edit.EditBanner({ doc: d, elRef }))).toBe("Stop editing (Esc)");
    await actions.setEditTool("addText"); // there Esc goes back to Change first
    expect(doneTip(edit.EditBanner({ doc: d, elRef }))).toBe("Stop editing");
    onPhone(() => expect(doneTip(edit.EditBanner({ doc: d, elRef }))).toBe("Stop editing"), true);
    i18n.setLocale("it");
    expect(doneTip(edit.EditBanner({ doc: d, elRef }))).toBe("Esci dalla modifica");
    await actions.setEditTool("change");
    expect(doneTip(edit.EditBanner({ doc: d, elRef }))).toBe("Esci dalla modifica (Esc)");

    // Compila e firma: at rest Esc leaves with every sub-tool.
    i18n.setLocale("en");
    await actions.setTool("fill");
    for (const id of ["text", "check", "cross", "date", "signature", "initials"] as const) {
      state.fillTool.value = id;
      expect({ id, tip: doneTip(bar.FillBanner({ doc: d, elRef })) }).toEqual({ id, tip: "Stop filling in (Esc)" });
    }
    state.fillTool.value = "text";
    await actions.setTool(null);
  });

  it("on phones the form's notes are two toasts, once per document, when Compila e firma is on there; none on desktop", async () => {
    const noted = FORM([1], 0, { xfa: "static", scripts: true });
    const notes = [["warn", i18n.t("form.xfaStatic")], ["warn", i18n.t("form.calculations")]];
    const said = () => state.toasts.value.map((x) => [x.kind, x.text]);
    const bannerNotes = (d: any) =>
      nodes(bar.FillBanner({ doc: d, elRef })).filter((n) => n.props?.class === "fill-banner-note").map((n) => n.props.children);

    media.isNarrow.value = true;
    try {
      // Turned on in the phone layout: the two notes, as toasts, and not in the banner.
      const first = await open("notes.pdf", [[FIELD("a")]], noted);
      expect(said()).toEqual([]);
      await actions.setTool("fill");
      expect(said()).toEqual(notes);
      expect(bannerNotes(first)).toEqual([]);

      // Not again for this document: off and on, wide and narrow again. The toasts on screen go
      // first, or they would hide a repeat (the same toast is never shown twice at once).
      state.toasts.value = [];
      await actions.setTool(null);
      await actions.setTool("fill");
      media.isNarrow.value = false;
      media.isNarrow.value = true;
      expect(said()).toEqual([]);
      await actions.setTool(null);

      // A new document: once more.
      await open("notes-2.pdf", [[FIELD("a")]], noted);
      await actions.setTool("fill");
      expect(said()).toEqual(notes);
      await actions.setTool(null);

      // Desktop: the notes are in the banner, no toast. Narrowed while on, they come as toasts.
      media.isNarrow.value = false;
      const third = await open("notes-3.pdf", [[FIELD("a")]], noted);
      await actions.setTool("fill");
      expect(said()).toEqual([]);
      expect(bannerNotes(third)).toEqual(notes.map(([, text]) => text));
      media.isNarrow.value = true;
      expect(said()).toEqual(notes);
    } finally {
      media.isNarrow.value = false;
      state.toasts.value = [];
      await actions.setTool(null);
    }
  });

  it("the tooltips of Modifica say it adds text and images too", () => {
    expect(i18n.t("tools.editTextTip")).toBe("Edit: change text, move images, add text or images");
    expect(i18n.t("edit.addImageTip")).toBe("Add an image or a photo");
    i18n.setLocale("it");
    expect(i18n.t("tools.editTextTip")).toBe("Modifica: cambia il testo, sposta le immagini, aggiungi testo o immagini");
    expect([i18n.t("edit.change"), i18n.t("edit.addText"), i18n.t("edit.addImage")]).toEqual(["Cambia", "Aggiungi testo", "Aggiungi immagine"]);
  });
});
