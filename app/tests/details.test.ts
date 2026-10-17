// The details panel against the app's real modules (no browser): where it shows as the window
// changes width (docked at every desktop width, open by default from 1200 px and closed by
// default below, one choice remembered on this device; never on phones), the rail's Details
// button, the More sheet's Details row that opens the details sheet on phones, the keys of
// Modifica with Aggiungi testo, and the panel's texts for touch screens.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "./stubs/browser-globals";

// The window's width as the media queries of src/ui/media.ts see it, and their "change" events
// when it changes. Set before any module of the app is imported (they read it on import).
let width = 1400;
const queries: { query: string; matches: boolean; listeners: ((e: { matches: boolean }) => void)[] }[] = [];

function evaluate(query: string): boolean {
  const min = /min-width:\s*([\d.]+)px/.exec(query);
  if (min) return width >= Number(min[1]);
  const max = /max-width:\s*([\d.]+)px/.exec(query);
  if (max) return width <= Number(max[1]);
  return false; // touch, reduced motion, screen density
}

(globalThis as any).matchMedia = (query: string) => {
  const entry = { query, matches: evaluate(query), listeners: [] as ((e: { matches: boolean }) => void)[] };
  queries.push(entry);
  return {
    get matches() { return evaluate(query); },
    addEventListener: (_type: string, listener: (e: { matches: boolean }) => void) => entry.listeners.push(listener),
  };
};

/** The window becomes `next` px wide: the queries whose answer changes say so. */
function resize(next: number) {
  width = next;
  for (const entry of queries) {
    const now = evaluate(entry.query);
    if (now === entry.matches) continue;
    entry.matches = now;
    for (const listener of [...entry.listeners]) listener({ matches: now });
  }
}

/** What this device remembers for the panels when the app starts (null: nothing). */
let stored: string | null = null;
/** What the panels' choices were saved as on this device, oldest first. */
const saves: { pages?: boolean; details?: boolean }[] = [];
(globalThis as any).localStorage = {
  getItem: (key: string) => (key === "pdf-editor.panels" ? stored : null),
  setItem: (key: string, value: string) => {
    if (key === "pdf-editor.panels") saves.push(JSON.parse(value));
  },
};

let panels: typeof import("../src/ui/panels");
let state: typeof import("../src/state");
let i18n: typeof import("../src/i18n");

beforeAll(async () => {
  panels = await import("../src/ui/panels");
  state = await import("../src/state");
  i18n = await import("../src/i18n");
});

beforeEach(() => {
  i18n.setLocale("en");
});

const open = () => panels.detailsPanelOpen.value;

/** The vnodes in `node` (a component's output, not rendered) with a `label` prop, in order. */
function labelled(node: any, out: any[] = []): any[] {
  if (Array.isArray(node)) {
    for (const child of node) labelled(child, out);
  } else if (node && typeof node === "object" && node.props) {
    if (typeof node.props.label === "string") out.push(node);
    labelled(node.props.children, out);
  }
  return out;
}

describe("D1 where the panel shows", () => {
  it("follows the window width until the user toggles it: open by default from 1200 px, closed below, never on phones", () => {
    const widths = [1400, 1200, 1199, 1000, 800, 640, 639, 390, 1250];
    expect(widths.map((px) => (resize(px), open()))).toEqual([true, true, false, false, false, false, false, false, true]);
    expect(saves).toEqual([]); // nothing chosen, nothing remembered
  });

  it("below 1200 px the rail's button opens it docked; that one choice is remembered and holds at every desktop width", () => {
    resize(1000);
    panels.toggleDetailsPanel();
    expect(open()).toBe(true);
    expect(saves.at(-1)).toEqual({ details: true });
    expect([700, 640, 1400, 1100].map((px) => (resize(px), open()))).toEqual([true, true, true, true]);

    resize(1400);
    panels.toggleDetailsPanel(); // closed where it is open by default
    expect(open()).toBe(false);
    expect(saves.at(-1)).toEqual({ details: false });
    expect([1600, 1000, 640].map((px) => (resize(px), open()))).toEqual([false, false, false]);

    resize(900);
    panels.toggleDetailsPanel();
    expect(open()).toBe(true);
    expect(saves.at(-1)).toEqual({ details: true });
  });

  it("never on phones: the toggle there changes nothing, and back on the desktop it is as remembered", () => {
    resize(900);
    expect(open()).toBe(true); // remembered open (the test above)
    resize(500);
    expect(open()).toBe(false);
    const saved = saves.length;
    panels.toggleDetailsPanel();
    expect(open()).toBe(false);
    expect(saves.length).toBe(saved);
    resize(800);
    expect(open()).toBe(true);
  });

  it("the rail's Details button is there at every desktop width, pressed and pointing at the panel while it is open", async () => {
    const { ToolRail } = await import("../src/ui/ToolRail");
    const details = () => labelled(ToolRail()).find((b) => b.props.label === i18n.t("tools.details"));
    for (const px of [700, 1000, 1400]) {
      resize(px);
      expect(details()?.props.onClick).toBe(panels.toggleDetailsPanel);
      expect(details()?.props.pressed).toBe(true);
      expect(details()?.props.controls).toBe("details-panel");
    }
    panels.toggleDetailsPanel();
    expect(details()?.props.pressed).toBe(false);
    expect(details()?.props.controls).toBeUndefined();
    panels.toggleDetailsPanel(); // back to open, for the tests that follow
    expect(open()).toBe(true);
  });
});

describe("D1 the details on phones", () => {
  it("the More sheet has a Details row right after 'Download with options…', which swaps it for the details sheet", async () => {
    resize(390);
    const { MoreActions } = await import("../src/ui/PhoneSheets");
    const rows = labelled(MoreActions());
    const labels = rows.map((row) => row.props.label);
    const at = labels.indexOf(i18n.t("tools.details"));
    expect(at).toBeGreaterThan(0);
    expect(labels[at - 1]).toBe(i18n.t("more.downloadOptions"));
    expect(rows[at].props.opensDialog).toBe(true);

    state.sheet.value = "more";
    rows[at].props.onClick({ currentTarget: null } as unknown as MouseEvent);
    expect(state.sheet.value).toBe("details");
    state.sheet.value = null;

    i18n.setLocale("it");
    expect(labelled(MoreActions()).map((row) => row.props.label)).toContain("Dettagli");
    expect(i18n.t("details.label")).toBe("Dettagli"); // the sheet's title
    resize(1400);
  });
});

describe("D2 what the panel says with the new Modifica", () => {
  it("Aggiungi testo's keys: the writer's Enter and Shift+Enter, Esc back to Cambia, no Tab", async () => {
    const { addTextShortcuts, fillShortcuts } = await import("../src/ui/DetailsPanel");
    expect(addTextShortcuts()).toEqual([["Enter", "Write the text, or apply"], ["Shift + Enter", "Line below"], ["Esc", "Back to Change"]]);
    expect(fillShortcuts("writer").map(([key]) => key)).toEqual(["Enter", "Shift + Enter", "Esc"]); // the writer open, in Modifica too
    i18n.setLocale("it");
    expect(addTextShortcuts().at(-1)).toEqual(["Esc", "Torna a Cambia"]);
  });

  it("the steps say tap on touch screens and click with a mouse, in both languages; Compila e firma's say nothing about pictures", () => {
    const mouse = ["details.step1", "details.fillStep1", "details.addTextStep1", "details.addTextStep2"] as const;
    const touch = ["details.step1Touch", "details.fillStep1Touch", "details.addTextStep1Touch", "details.addTextStep2Touch"] as const;
    for (const locale of ["en", "it"] as const) {
      i18n.setLocale(locale);
      for (const key of mouse) expect(i18n.t(key)).toMatch(/click|clic/i);
      for (const key of touch) {
        expect(i18n.t(key)).toMatch(/tap|tocca/i);
        expect(i18n.t(key)).not.toMatch(/click|clic/i);
      }
      for (const key of ["details.fillStep1", "details.fillStep1Touch", "details.fillStep2", "details.legendField", "details.legendAdded"] as const) {
        expect(i18n.t(key)).not.toMatch(/picture|image|immagin/i);
      }
      // Cambia's steps point to the other two sub-tools by their names on the bar.
      expect(i18n.t("details.editMore")).toContain(i18n.t("edit.addText"));
      expect(i18n.t("details.editMore")).toContain(i18n.t("edit.addImage"));
    }
  });

  it("by touch, the steps that write say what to tap (the bar's Apply, the keyboard's Done key), not Enter", () => {
    const done = { en: "Done", it: "Fine" }; // what phone keyboards show for enterkeyhint="done"
    for (const locale of ["en", "it"] as const) {
      i18n.setLocale(locale);
      for (const key of ["details.step2Touch", "details.addTextStep2Touch"] as const) {
        const text = i18n.t(key);
        expect(text).toContain(i18n.t("edit.apply")); // the writer's and the line editor's button
        expect(text).toContain(done[locale]);
        expect(text).not.toContain(i18n.t("key.enter"));
        expect(text).not.toMatch(/press|premi/i);
      }
      // With a mouse and a keyboard, Enter as before.
      expect(i18n.t("details.step2")).toContain(i18n.t("key.enter"));
      expect(i18n.t("details.addTextStep2")).toContain(i18n.t("key.enter"));
    }
  });
});

describe("D1 a choice remembered on this device", () => {
  /** panels.ts as the app starts with `saved` in storage, at `px`. */
  async function start(saved: string | null, px: number) {
    stored = saved;
    resize(px);
    vi.resetModules();
    return import("../src/ui/panels");
  }

  it("applies from the start at every desktop width; nothing or garbled storage gives the defaults", async () => {
    expect((await start('{"details":true}', 800)).detailsPanelOpen.value).toBe(true);
    expect((await start('{"details":false}', 1400)).detailsPanelOpen.value).toBe(false);
    expect((await start('{"details":true}', 500)).detailsPanelOpen.value).toBe(false); // never on phones
    expect((await start(null, 800)).detailsPanelOpen.value).toBe(false);
    expect((await start("{", 1400)).detailsPanelOpen.value).toBe(true);
    expect((await start('{"details":"yes"}', 800)).detailsPanelOpen.value).toBe(false);
    stored = null;
  });
});
