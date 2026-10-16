// The chrome of Compila e firma against the app's real modules with a fake engine (no browser):
// what a form offers, from FormInfo's counts with no page read at open (a signed PDF and a
// read-only form are not forms to fill in), the form notice, "Next empty field" from the field
// the user was in, reading only the pages it gets to and busy while it reads, the bars at the
// bottom that follow typingField, "Put it in the middle" on phones, the details panel's keys
// while writing, the missing-fields question about one field, the singulars, the full stops of
// the marks' toasts, and the Browse tooltip.
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
  it("'Put it in the middle' for every sub-tool that places with a tap, on phones too", () => {
    for (const sub of ["text", "check", "cross", "date", "signature", "initials"] as const) {
      expect(bar.placeCenterShown(false, sub)).toBe(true);
    }
    expect(bar.placeCenterShown(false, "image")).toBe(false);
    expect(bar.placeCenterShown(true, "image")).toBe(true);
  });

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
