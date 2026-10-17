// "Install the app" in the UI, against the app's real state and actions with a fake engine and a
// stand-in for src/platform/install.ts whose state each test sets (detection itself is tested in
// tests/install.test.ts): the entries (home page, desktop More menu, phone More sheet) shown only
// where there is something to offer; openInstall, the browser's own dialog in "prompt" and the
// steps otherwise (and after "unavailable"), nothing more while that dialog is up (a double click),
// and the focus kept in the page when the entry goes with the install; what the dialog says for
// each state, "Copy link" only where the page must be opened elsewhere, and its fallback when the
// clipboard refuses; the suggestion in the first download's toast, once per device, never inside
// another app's browser, never for a share, never with blocked storage; and the toast's action
// button, its time stopped while it holds the focus or the pointer, the focus given to the page
// when a toast goes with it.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "./stubs/browser-globals";

// This device's storage, which a test can block (getItem and setItem throw, as in some private
// windows) or make forgetful (writes accepted and dropped).
const stored = new Map<string, string>();
let storage: "ok" | "blocked" | "forgetful" = "ok";
(globalThis as any).localStorage = {
  getItem(key: string) {
    if (storage === "blocked") throw new DOMException("blocked", "SecurityError");
    return stored.get(key) ?? null;
  },
  setItem(key: string, value: string) {
    if (storage === "blocked") throw new DOMException("blocked", "SecurityError");
    if (storage === "ok") stored.set(key, value);
  },
  removeItem(key: string) { stored.delete(key); },
};
// rescueFocus (after a toast or an install entry goes) looks for the viewer's scroller, else the
// home page's heading: none here, unless a test puts them there (focusTargets).
(globalThis as any).document.querySelector = () => null;
(globalThis as any).document.getElementById = () => null;
// The More sheet's rows check what was tapped (leaveSheet): nothing is an element here.
(globalThis as any).Element ??= class {};

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
        ok: true, pageCount: 1, pages: [{ index: 0, bounds: [0, 0, 100, 100] }], encrypted: false,
        needsPassword: false, canKeepPassword: false, pdfa: null, signatures: 0, title: null,
      });
    }
    save() { return Promise.resolve({ bytes: new ArrayBuffer(4), pdfa: null }); }
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

// The install module's state, set by each test; promptInstall answers as `choice` says and moves
// the state as the real one does (accepted: installed; dismissed or gone: the browser's menu).
// With `wait`, the browser's dialog stays up until that promise gives the choice: meanwhile the
// event is used up, so the state is already "chromium", as in the real module.
vi.mock("../src/platform/install.ts", async () => {
  const { computed, signal } = await import("@preact/signals");
  const state = signal<string>("none");
  const ctl = { state, prompts: 0, choice: "accepted" as string, copied: true, wait: null as Promise<string> | null, android: false };
  (globalThis as any).__install = ctl;
  return {
    installState: computed(() => state.value),
    canOfferInstall: computed(() => state.value !== "installed" && state.value !== "none"),
    detectInstall: () => "none",
    listenForInstall: () => undefined,
    installOnAndroid: () => ctl.android,
    promptInstall: () => {
      ctl.prompts++;
      if (state.peek() !== "prompt") return Promise.resolve("unavailable");
      if (ctl.wait) {
        state.value = "chromium";
        return ctl.wait.then((choice) => {
          if (choice === "accepted") state.value = "installed";
          return choice;
        });
      }
      state.value = ctl.choice === "accepted" ? "installed" : "chromium";
      return Promise.resolve(ctl.choice);
    },
    appAddress: () => "https://pdf.example/",
    copyAppLink: async () => ctl.copied,
  };
});

const install = () => (globalThis as any).__install as {
  state: { value: string }; prompts: number; choice: string; copied: boolean; wait: Promise<string> | null; android: boolean;
};
const setInstall = (state: string) => { install().state.value = state; };

const OFFERED = ["prompt", "chromium", "ios-safari", "ios-other", "in-app", "mac-safari", "firefox-android", "firefox-windows"];
const NOT_OFFERED = ["installed", "none"];

let state: typeof import("../src/state");
let actions: typeof import("../src/ui/actions");
let i18n: typeof import("../src/i18n");
let dialogUi: typeof import("../src/ui/InstallDialog");
let toastsUi: typeof import("../src/ui/Toasts");
let en: typeof import("../src/i18n/en").en;
let it_: typeof import("../src/i18n/it").it;

beforeAll(async () => {
  state = await import("../src/state");
  actions = await import("../src/ui/actions");
  i18n = await import("../src/i18n");
  dialogUi = await import("../src/ui/InstallDialog");
  toastsUi = await import("../src/ui/Toasts");
  en = (await import("../src/i18n/en")).en;
  it_ = (await import("../src/i18n/it")).it;
});

beforeEach(() => {
  storage = "ok";
  i18n.setLocale("en");
  state.dialog.value = null;
  state.toasts.value = [];
  install().prompts = 0;
  install().choice = "accepted";
  install().copied = true;
  install().wait = null;
  install().android = false;
});

/**
 * Something that takes the focus: `focused` counts the times it did. With it, document.activeElement
 * says where the focus is (null: on <body>, as after the focused control went).
 */
function focusable(name: string) {
  const el = {
    name,
    focused: 0,
    focus() { el.focused++; (globalThis as any).document.activeElement = el; },
  };
  return el;
}

/**
 * The viewer's scroller (only with `withDocument`) and the home page's heading, where the focus
 * goes when the control that had it is gone; `restore` takes them away again.
 */
function focusTargets(withDocument: boolean) {
  const g = (globalThis as any).document;
  const scroller = focusable("scroller");
  const heading = focusable("home-title");
  g.querySelector = (sel: string) => (withDocument && sel === ".viewer .scroller" ? scroller : null);
  g.getElementById = (id: string) => (!withDocument && id === "home-title" ? heading : null);
  return {
    scroller,
    heading,
    restore() {
      g.querySelector = () => null;
      g.getElementById = () => null;
      g.activeElement = null;
    },
  };
}

/** Every vnode in `node` (a component's output, not rendered), depth first. */
function nodes(node: any): any[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!node || typeof node !== "object" || !node.props) return [];
  return [node, ...nodes(node.props.children)];
}

/** The plain text of a vnode tree. */
function text(node: any): string {
  if (Array.isArray(node)) return node.map(text).join("");
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (!node || typeof node !== "object" || !node.props) return "";
  return text(node.props.children);
}

const fakeFile = (name: string) =>
  ({ name, type: "application/pdf", arrayBuffer: async () => new ArrayBuffer(4) }) as unknown as File;

async function openDoc() {
  if (!state.doc.value) await actions.openFile(fakeFile("report.pdf"), { confirmed: true });
}

describe("I1 the entries", () => {
  it("are hidden where the app is installed or the browser cannot install it, and shown everywhere else", async () => {
    const { HomeInstall } = await import("../src/ui/EmptyState");
    const { MoreActions } = await import("../src/ui/PhoneSheets");
    const { TopBar } = await import("../src/ui/TopBar");
    await openDoc();
    const label = i18n.t("install.button");
    const menu = () => nodes(TopBar()).find((n) => Array.isArray(n.props.items)).props.items as any[];
    const rows = () => nodes(MoreActions()).filter((n) => typeof n.props.label === "string");

    for (const s of NOT_OFFERED) {
      setInstall(s);
      expect(HomeInstall(), s).toBeNull();
      expect(menu().map((x) => x.key), s).not.toContain("install");
      expect(rows().map((r) => r.props.label), s).not.toContain(label);
    }
    for (const s of OFFERED) {
      setInstall(s);
      const home = HomeInstall() as any;
      expect(home.type, s).toBe("button"); // a real button, with its words
      expect(home.props.class).toContain("btn-secondary");
      expect(text(home)).toBe(label);
      // Desktop More menu: right after the language.
      const items = menu();
      expect(items.map((x) => x.key).slice(0, 2), s).toEqual(["lang", "install"]);
      expect(items[1].label).toBe(label);
      // Phone More sheet: right before the language.
      const labels = rows().map((r) => r.props.label);
      const at = labels.indexOf(label);
      expect(at, s).toBeGreaterThan(0);
      expect(labels[at + 1]).toBe(i18n.LOCALE_NAMES[i18n.otherLocale()]);
      expect(rows()[at].props.opensDialog).toBe(true);
    }
  });

  it("all of them call openInstall: the steps open from each", async () => {
    const { HomeInstall } = await import("../src/ui/EmptyState");
    const { MoreActions } = await import("../src/ui/PhoneSheets");
    const { TopBar } = await import("../src/ui/TopBar");
    await openDoc();
    setInstall("ios-safari");
    const label = i18n.t("install.button");
    const clicks = [
      () => (HomeInstall() as any).props.onClick(),
      () => nodes(TopBar()).find((n) => Array.isArray(n.props.items)).props.items.find((x: any) => x.key === "install").onSelect(),
      () => nodes(MoreActions()).find((n) => n.props.label === label).props.onClick({ currentTarget: null }),
    ];
    for (const click of clicks) {
      state.dialog.value = null;
      click();
      await vi.waitFor(() => expect(state.dialog.value?.kind).toBe("install"));
    }
  });
});

describe("I2 openInstall", () => {
  it("in \"prompt\" shows the browser's own dialog, from within the click: accepted says where the app is", async () => {
    setInstall("prompt");
    const run = actions.openInstall();
    expect(install().prompts).toBe(1); // asked before anything was awaited
    await run;
    expect(state.dialog.value).toBeNull();
    expect(state.toasts.value.map((x) => [x.kind, x.text])).toEqual([["info", "Installed: you'll find it among your apps."]]);
    expect(install().state.value).toBe("installed");
    // Installed: nothing more to offer.
    await actions.openInstall();
    expect(install().prompts).toBe(1);
    expect(state.dialog.value).toBeNull();
  });

  it("dismissed: nothing more; the next time, the browser's menu steps", async () => {
    setInstall("prompt");
    install().choice = "dismissed";
    await actions.openInstall();
    expect(state.dialog.value).toBeNull();
    expect(state.toasts.value).toEqual([]);
    expect(install().state.value).toBe("chromium");
    await actions.openInstall();
    expect(install().prompts).toBe(1); // no event left to show
    expect(state.dialog.value?.kind).toBe("install");
  });

  it("\"unavailable\" (the browser's dialog is gone): the steps instead", async () => {
    setInstall("prompt");
    install().choice = "unavailable";
    await actions.openInstall();
    expect(install().prompts).toBe(1);
    expect(state.dialog.value?.kind).toBe("install");
    expect(state.toasts.value).toEqual([]);
  });

  it("a second click while the browser's dialog is up does nothing: no steps under it, none left after the choice", async () => {
    for (const choice of ["accepted", "dismissed"]) {
      setInstall("prompt");
      state.dialog.value = null;
      state.toasts.value = [];
      install().prompts = 0;
      let answer!: (c: string) => void;
      install().wait = new Promise((resolve) => { answer = resolve; });
      const first = actions.openInstall();
      expect(install().state.value, choice).toBe("chromium"); // the event is used up while its dialog is up
      // A double click, or a tap on another entry.
      await actions.openInstall();
      await actions.openInstall();
      expect(install().prompts, choice).toBe(1);
      expect(state.dialog.value, choice).toBeNull();
      answer(choice);
      await first;
      expect(state.dialog.value, choice).toBeNull();
      expect(state.toasts.value.map((x) => x.text), choice)
        .toEqual(choice === "accepted" ? ["Installed: you'll find it among your apps."] : []);
      install().wait = null;
    }
    // Once the choice is made, the entries work again: dismissed, the browser's menu steps.
    await actions.openInstall();
    expect(state.dialog.value?.kind).toBe("install");
  });

  it("a click while the browser refuses at once still works the next time", async () => {
    setInstall("prompt");
    install().choice = "unavailable";
    await actions.openInstall();
    expect(state.dialog.value?.kind).toBe("install");
    state.dialog.value = null;
    setInstall("prompt");
    install().choice = "accepted";
    await actions.openInstall();
    expect(install().prompts).toBe(2);
    expect(install().state.value).toBe("installed");
  });

  it("installed from the home page's button, which goes with it: the focus goes to the page's heading, not <body>", async () => {
    const { HomeInstall } = await import("../src/ui/EmptyState");
    const targets = focusTargets(false);
    try {
      setInstall("prompt");
      const button = HomeInstall() as any;
      (globalThis as any).document.activeElement = button;
      button.props.onClick();
      await vi.waitFor(() => expect(install().state.value).toBe("installed"));
      expect(HomeInstall()).toBeNull(); // the button is gone
      (globalThis as any).document.activeElement = null; // and the focus with it
      await vi.waitFor(() => expect(targets.heading.focused).toBe(1));
      expect(targets.scroller.focused).toBe(0);
    } finally {
      targets.restore();
    }
  });

  it("installed with a document open: the focus goes to the document; where it stayed in place, it is left there", async () => {
    await openDoc();
    let targets = focusTargets(true);
    try {
      setInstall("prompt");
      await actions.openInstall();
      await vi.waitFor(() => expect(targets.scroller.focused).toBe(1));
      expect(targets.heading.focused).toBe(0);
    } finally {
      targets.restore();
    }
    // The More menu's trigger kept the focus: nothing moves it.
    targets = focusTargets(true);
    try {
      const trigger = focusable("More");
      (globalThis as any).document.activeElement = trigger;
      setInstall("prompt");
      await actions.openInstall();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(targets.scroller.focused).toBe(0);
      expect((globalThis as any).document.activeElement).toBe(trigger);
    } finally {
      targets.restore();
    }
  });

  it("every other state that can install opens the steps; nothing where there is nothing to offer, or over another dialog", async () => {
    for (const s of OFFERED.filter((x) => x !== "prompt")) {
      setInstall(s);
      state.dialog.value = null;
      await actions.openInstall();
      expect(state.dialog.peek()?.kind, s).toBe("install");
    }
    expect(install().prompts).toBe(0);
    for (const s of NOT_OFFERED) {
      setInstall(s);
      state.dialog.value = null;
      await actions.openInstall();
      expect(state.dialog.value, s).toBeNull();
    }
    setInstall("prompt");
    const other = { kind: "alert", title: "T", body: "B" } as const;
    state.dialog.value = other;
    await actions.openInstall();
    expect(state.dialog.value).toBe(other);
    expect(install().prompts).toBe(0);
  });
});

describe("I3 what the dialog says", () => {
  const keysOf = (c: import("../src/ui/InstallDialog").InstallContent) =>
    [...c.body, ...c.steps.map((s) => s.text), ...(c.note ? [c.note] : [])];

  it("the steps of each browser, with the iPhone's drawings; Copy link only where the page must be opened elsewhere", () => {
    const of = (s: string, android = false) => dialogUi.installContent(s as any, android);
    const ios = of("ios-safari");
    expect(ios.body).toEqual(["install.why"]);
    expect(ios.steps).toEqual([
      { text: "install.ios.step1", glyph: "share" },
      { text: "install.ios.step2", glyph: "add" },
      { text: "install.ios.step3" },
    ]);
    expect(of("ios-other").steps.map((s) => s.text)).toEqual(["install.iosOther.step1", "install.iosOther.step2", "install.iosOther.step3"]);
    expect(of("ios-other").note).toBe("install.iosOther.note");
    expect(of("in-app").body).toEqual(["install.why", "install.inApp.body"]);
    expect(of("in-app").steps.map((s) => s.text)).toEqual(["install.inApp.step1", "install.inApp.step2", "install.inApp.step3"]);
    expect(of("chromium").steps.map((s) => s.text)).toEqual(["install.chromium.step1", "install.chromium.step2", "install.chromium.step3"]);
    expect(of("chromium", true).steps.map((s) => s.text)).toEqual(["install.android.step1", "install.android.step2", "install.android.step3"]);
    // No offer from the browser: maybe installed already, and where it opens from then.
    expect(of("chromium").note).toBe("install.chromium.note");
    expect(of("chromium", true).note).toBe("install.android.note");
    expect(of("prompt").note).toBeNull(); // the browser offers it: not installed
    expect(of("mac-safari").steps.map((s) => s.text)).toEqual(["install.mac.step1", "install.mac.step2", "install.mac.step3"]);
    expect(of("mac-safari").note).toBe("install.mac.note"); // Sonoma or later: the user agent can't tell
    expect(of("firefox-android").steps.map((s) => s.text))
      .toEqual(["install.firefoxAndroid.step1", "install.firefoxAndroid.step2", "install.firefoxAndroid.step3"]);
    expect(of("firefox-windows").steps.map((s) => s.text)).toEqual(["install.firefoxWindows.step1", "install.firefoxWindows.step2"]);
    // The browser's offer came while the steps were open: its menu's steps, and Install.
    expect(of("prompt").steps).toEqual(of("chromium").steps);
    expect(OFFERED.filter((s) => of(s).install)).toEqual(["prompt"]);
    expect(OFFERED.filter((s) => of(s).copyLink)).toEqual(["ios-other", "in-app"]);
    expect(OFFERED.filter((s) => of(s).steps.some((x) => x.glyph))).toEqual(["ios-safari", "ios-other"]);
    // Installed meanwhile: it says so, no steps.
    expect(of("installed")).toMatchObject({ body: ["install.done"], steps: [], copyLink: false, install: false });
  });

  it("every text is there in both languages, with typographic quotes; the iOS steps name Safari's own words", () => {
    const used = new Set<string>(["install.button", "install.title", "install.install", "install.copyLink", "install.copied",
      "install.copyFailed", "install.address"]);
    for (const s of [...OFFERED, ...NOT_OFFERED]) {
      for (const android of [false, true]) for (const key of keysOf(dialogUi.installContent(s as any, android))) used.add(key);
    }
    for (const key of used) {
      const k = key as keyof typeof en;
      expect(en[k]?.trim(), key).toBeTruthy();
      expect(it_[k]?.trim(), key).toBeTruthy();
      expect(it_[k], key).not.toBe(en[k]);
      expect(en[k], key).not.toContain('"');
      expect(it_[k], key).not.toContain('"');
    }
    // iPhone and iPad: true on iOS 26 and on iOS 18 (Share in Safari's bar, or under ••• on iOS 26;
    // “Open as Web App” only where iOS 26 shows it), wherever the bar is (iPad: at the top).
    expect(it_["install.ios.step1"]).toMatch(/^Tocca Condividi nella barra di Safari \(su iOS 26 .*•••/);
    expect(it_["install.ios.step1"]).not.toMatch(/in basso|in alto/);
    expect(it_["install.ios.step2"]).toContain("“Aggiungi alla schermata Home”");
    expect(it_["install.ios.step2"]).toContain("“Mostra altro”");
    expect(it_["install.ios.step2"]).toContain("scorri");
    expect(it_["install.ios.step3"]).toBe("Tocca Aggiungi. Se c'è “Apri come app web”, lascialo attivo.");
    expect(en["install.ios.step3"]).toBe("Tap Add. If there's “Open as Web App”, leave it on.");
    // Firefox for Android 141+: the item is under ⋮ › More, as Firefox names it.
    expect(it_["install.firefoxAndroid.step1"]).toContain("⋮ e tocca “Altro”");
    expect(it_["install.firefoxAndroid.step2"]).toContain("“Aggiungi app alla schermata principale”");
    expect(en["install.firefoxAndroid.step1"]).toContain("⋮ and tap “More”");
    expect(en["install.firefoxAndroid.step2"]).toContain("“Add app to Home screen”");
    expect(it_["install.mac.note"]).toContain("macOS Sonoma o successivo");
    expect(it_["install.chromium.note"]).toMatch(/^Se l'hai già installata, aprila dalle tue app/);
    expect(it_["install.done"]).toBe("Installata: la trovi tra le tue app.");
    expect(it_["install.button"]).toBe("Installa l'app");
    expect(it_["install.copyLink"]).toBe("Copia link");
  });

  it("the body: title, the why, the steps, Copy link where it belongs, Close, and Install in \"prompt\"", () => {
    const close = vi.fn();
    const body = (s: string) => {
      setInstall(s);
      return nodes(dialogUi.InstallBody({ heading: true, onClose: close }));
    };
    const buttons = (all: any[]) => all.filter((n) => n.type === "button");
    const hasCopy = (all: any[]) => all.some((n) => typeof n.type === "function" && n.type.name === "CopyLink");
    for (const s of OFFERED) {
      const all = body(s);
      expect(all.find((n) => n.type === "h2")?.props.children, s).toBe("Install the app");
      const note = dialogUi.installContent(s as any, false).note;
      expect(all.find((n) => n.props.class === "install-note")?.props.children, s).toBe(note ? i18n.t(note) : undefined);
      expect(text(all.find((n) => n.props.id === "dlg-body")), s).toContain(i18n.t("install.why"));
      expect(hasCopy(all), s).toBe(s === "ios-other" || s === "in-app");
      expect(buttons(all).map((b) => text(b)), s).toEqual(s === "prompt" ? ["Close", "Install"] : ["Close"]);
    }
    // No title in the sheet, which has its own.
    expect(nodes(dialogUi.InstallBody({ heading: false, onClose: close })).some((n) => n.type === "h2")).toBe(false);
    // Close closes; Install closes, then shows the browser's own dialog within the same click.
    const ios = body("ios-safari");
    buttons(ios)[0].props.onClick();
    expect(close).toHaveBeenCalledTimes(1);
    const prompt = buttons(body("prompt"));
    expect(prompt[1].props["data-autofocus"]).toBe(true);
    prompt[1].props.onClick();
    expect(close).toHaveBeenCalledTimes(2);
    expect(install().prompts).toBe(1);
  });

  it("Android's menu wherever the platform says Android: a tablet in “Desktop site” mode too (installOnAndroid)", () => {
    const stepsOf = () => nodes(dialogUi.InstallBody({ heading: true, onClose: () => undefined }))
      .find((n) => n.type === dialogUi.InstallSteps).props.steps.map((s: any) => s.text);
    setInstall("chromium");
    install().android = true; // e.g. Chrome on a Pixel Tablet, which sends a Linux desktop user agent
    expect(stepsOf()).toEqual(["install.android.step1", "install.android.step2", "install.android.step3"]);
    install().android = false;
    expect(stepsOf()).toEqual(["install.chromium.step1", "install.chromium.step2", "install.chromium.step3"]);
  });

  it("Copy link: copied, it says so; refused, it says so and shows the address, focused and selected; each tap is heard", () => {
    const { CopyLinkView, nextCopyOutcome, revealAddress } = dialogUi;
    const field = { current: null };
    const onCopy = vi.fn();
    const view = (outcome: import("../src/ui/InstallDialog").CopyOutcome | null) =>
      nodes(CopyLinkView({ outcome, onCopy, field }));
    const status = (all: any[]) => all.find((n) => n.props.role === "status");
    const address = (all: any[]) => all.find((n) => n.type === "input");

    // Before the first tap: the button, an empty status line (in the page, for screen readers), no field.
    const before = view(null);
    const button = before.find((n) => n.type === "button");
    expect(text(button)).toBe("Copy link");
    button.props.onClick();
    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(text(status(before))).toBe("");
    expect(address(before)).toBeUndefined();

    // Refused (no clipboard in this web view): the address, read-only, named, to copy by hand.
    const refused = nextCopyOutcome(null, false);
    const failed = view(refused);
    expect(text(status(failed))).toBe("Couldn't copy it: copy the address below.");
    const input = address(failed);
    expect(input.props).toMatchObject({ readOnly: true, value: "https://pdf.example/", "aria-label": "The app's address" });
    expect(input.ref).toBe(field);
    const el = { focus: vi.fn(), select: vi.fn() };
    revealAddress(refused, el as any);
    expect(el.focus).toHaveBeenCalledTimes(1);
    expect(el.select).toHaveBeenCalledTimes(1);
    // Focused again later (a tap on it): all of it selected again, for the system's Copy.
    const select = vi.fn();
    input.props.onFocus({ currentTarget: { select } });
    expect(select).toHaveBeenCalledTimes(1);

    // A second tap, refused again: the same words as a new message (a new key), so it is heard again.
    const again = nextCopyOutcome(refused, false);
    const firstKey = status(failed).props.children.key;
    expect(status(view(again)).props.children.key).not.toBe(firstKey);

    // Copied: it says so, no field, nothing focused.
    const copied = nextCopyOutcome(again, true);
    expect(copied).toEqual({ n: 3, copied: true });
    const done = view(copied);
    expect(text(status(done))).toBe("Link copied.");
    expect(address(done)).toBeUndefined();
    const other = { focus: vi.fn(), select: vi.fn() };
    revealAddress(copied, other as any);
    revealAddress(null, other as any);
    revealAddress(refused, null);
    expect(other.focus).not.toHaveBeenCalled();
    expect(other.select).not.toHaveBeenCalled();
  });

  it("closed after the app was installed meanwhile (the entry that opened it is gone): the focus goes to the page, not <body>", () => {
    vi.useFakeTimers();
    const targets = focusTargets(false);
    try {
      const open = { kind: "install" } as const;
      state.dialog.value = open;
      (globalThis as any).document.activeElement = null;
      dialogUi.closeInstall(open);
      expect(state.dialog.value).toBeNull();
      vi.advanceTimersByTime(20);
      expect(targets.heading.focused).toBe(1);
      // Another dialog took its place meanwhile: that one stays.
      const other = { kind: "alert", title: "T", body: "B" } as const;
      state.dialog.value = other;
      dialogUi.closeInstall(open);
      expect(state.dialog.value).toBe(other);
    } finally {
      targets.restore();
      vi.useRealTimers();
    }
  });

  it("the steps are numbered, in the user's language, the drawings hidden from screen readers", () => {
    i18n.setLocale("it");
    const list = dialogUi.InstallSteps({ steps: dialogUi.installContent("ios-safari", false).steps }) as any;
    expect(list.type).toBe("ol");
    const items = nodes(list).filter((n) => n.type === "li");
    expect(items.map((li) => text(li))).toEqual([
      `1${it_["install.ios.step1"]}`, `2${it_["install.ios.step2"]}`, `3${it_["install.ios.step3"]}`,
    ]);
    const glyphs = nodes(list).filter((n) => n.props.class === "install-glyph");
    expect(glyphs).toHaveLength(2);
    expect(glyphs.every((g) => g.props["aria-hidden"] === "true")).toBe(true);
    expect(dialogUi.InstallSteps({ steps: [] })).toBeNull();
  });
});

describe("I4 the suggestion after the first download", () => {
  const withAction = () => state.toasts.value.filter((x) => x.action);

  it("once per device: the first download's own done toast carries Install the app, which opens the steps", async () => {
    await openDoc();
    stored.clear();
    setInstall("chromium");
    await actions.download();
    expect(state.toasts.value).toHaveLength(1); // no toast of its own, nothing stacked
    const done = state.toasts.value[0];
    expect(done.text).toBe("Downloaded “report-edited.pdf”.");
    expect(done.action?.label).toBe("Install the app");
    expect(stored.get(actions.INSTALL_HINT_KEY)).toBeTruthy();
    done.action!.run();
    await vi.waitFor(() => expect(state.dialog.value?.kind).toBe("install"));

    state.dialog.value = null;
    state.toasts.value = [];
    await actions.download();
    expect(state.toasts.value.map((x) => x.text)).toEqual(["Downloaded “report-edited.pdf”."]);
    expect(withAction()).toEqual([]);
  });

  it("only where installing can be offered, and never inside another app's browser", async () => {
    await openDoc();
    for (const s of [...NOT_OFFERED, "in-app"]) {
      stored.clear();
      state.toasts.value = [];
      setInstall(s);
      await actions.download();
      expect(state.toasts.value, s).toHaveLength(1);
      expect(withAction(), s).toEqual([]);
      expect(stored.has(actions.INSTALL_HINT_KEY), s).toBe(false); // still to come, where it can be offered
    }
  });

  it("not for a share", async () => {
    await openDoc();
    stored.clear();
    setInstall("chromium");
    let shared = 0;
    (globalThis as any).navigator.share = async () => { shared++; };
    try {
      await actions.share();
    } finally {
      delete (globalThis as any).navigator.share;
    }
    expect(shared).toBe(1);
    expect(withAction()).toEqual([]);
    expect(stored.has(actions.INSTALL_HINT_KEY)).toBe(false);
  });

  it("never where this device cannot remember it was shown: blocked or forgetful storage", async () => {
    await openDoc();
    stored.clear();
    setInstall("ios-safari");
    for (const kind of ["blocked", "forgetful"] as const) {
      storage = kind;
      state.toasts.value = [];
      await actions.download();
      expect(state.toasts.value, kind).toHaveLength(1);
      expect(withAction(), kind).toEqual([]);
    }
  });

  it("the browser's own dialog straight from the toast's button, in \"prompt\"", async () => {
    await openDoc();
    stored.clear();
    setInstall("prompt");
    await actions.download();
    const done = state.toasts.value[0];
    const button = nodes(toastsUi.ToastItem({ toast: done })).find((n) => n.props.class === "btn toast-action");
    button.props.onClick();
    expect(install().prompts).toBe(1); // within the click
    expect(state.toasts.value).toEqual([]);
    await vi.waitFor(() => expect(state.toasts.value.map((x) => x.text)).toEqual(["Installed: you'll find it among your apps."]));
  });
});

describe("I5 a toast's action", () => {
  it("renders as a real button after the text, dismisses its toast and runs; a toast without one has none", () => {
    const run = vi.fn();
    const id = state.showToast("info", "Saved.", undefined, { label: "Do it", run });
    state.showToast("warn", "Careful.");
    const items = nodes(toastsUi.Toasts()).filter((n) => n.type === toastsUi.ToastItem);
    expect(items.map((n) => n.props.toast.text)).toEqual(["Saved.", "Careful."]);
    const [withIt, without] = items.map((n) => nodes(toastsUi.ToastItem({ toast: n.props.toast })));
    const buttons = withIt.filter((n) => n.type === "button");
    expect(buttons.map((b) => b.props.class)).toEqual(["btn toast-action", "btn tool toast-close"]);
    expect(buttons[0].props.type).toBe("button");
    expect(buttons[0].props.tabIndex).toBeUndefined(); // in the Tab order
    expect(text(buttons[0])).toBe("Do it");
    expect(without.filter((n) => n.type === "button").map((b) => b.props.class)).toEqual(["btn tool toast-close"]);

    buttons[0].props.onClick();
    expect(run).toHaveBeenCalledTimes(1);
    expect(state.toasts.value.map((x) => x.id)).not.toContain(id);
    expect(state.toasts.value.map((x) => x.text)).toEqual(["Careful."]);
  });

  it("waits while it holds the focus or the pointer, then goes on with the time it had left", () => {
    vi.useFakeTimers();
    try {
      const id = state.showToast("info", "Downloaded.", undefined, { label: "Install the app", run: () => undefined });
      const shown = () => state.toasts.value.some((x) => x.id === id);
      const box = () => nodes(toastsUi.ToastItem({ toast: state.toasts.value.find((x) => x.id === id)! }))[0];
      const inside = { name: "a button of the toast" };
      const self = { contains: (node: unknown) => node === inside };
      vi.advanceTimersByTime(3000);
      // Tab reaches its button: it stays, however long the user takes.
      box().props.onFocusIn({ currentTarget: self, relatedTarget: null });
      vi.advanceTimersByTime(60_000);
      expect(shown()).toBe(true);
      // From its action to its close button: still inside.
      box().props.onFocusOut({ currentTarget: self, relatedTarget: inside });
      box().props.onFocusIn({ currentTarget: self, relatedTarget: inside });
      vi.advanceTimersByTime(60_000);
      expect(shown()).toBe(true);
      // The pointer on it, then the focus elsewhere: the pointer still holds it.
      box().props.onPointerEnter();
      box().props.onFocusOut({ currentTarget: self, relatedTarget: null });
      vi.advanceTimersByTime(60_000);
      expect(shown()).toBe(true);
      // Neither any more: the 7 s it had left.
      box().props.onPointerLeave();
      vi.advanceTimersByTime(6999);
      expect(shown()).toBe(true);
      vi.advanceTimersByTime(1);
      expect(shown()).toBe(false);

      // Held at the very end: some time to read it after, not gone at once.
      const late = state.showToast("info", "Saved.");
      vi.advanceTimersByTime(3900);
      state.holdToast(late, "pointer", true);
      vi.advanceTimersByTime(10_000);
      state.holdToast(late, "pointer", false);
      vi.advanceTimersByTime(state.TOAST_RESUME_MS - 1);
      expect(state.toasts.value.map((x) => x.id)).toContain(late);
      vi.advanceTimersByTime(1);
      expect(state.toasts.value).toEqual([]);

      // A toast that stays until it is dismissed (ms 0) is not timed by a hold either.
      const status = state.showToast("info", "Checking…", 0);
      state.holdToast(status, "focus", true);
      state.holdToast(status, "focus", false);
      vi.advanceTimersByTime(60_000);
      expect(state.toasts.value.map((x) => x.id)).toEqual([status]);
      state.dismissToast(status);
      state.holdToast(status, "focus", true); // gone: nothing to hold
      expect(state.toasts.value).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("when a toast goes with the focus inside (its time, ✕, its button), the document gets the focus, not <body>", () => {
    vi.useFakeTimers();
    const g = (globalThis as any).document;
    try {
      for (const withDocument of [true, false]) {
        const targets = focusTargets(withDocument);
        const id = state.showToast("info", "Downloaded.", undefined, { label: "Go", run: () => undefined });
        const toast = state.toasts.value.find((x) => x.id === id)!;
        const ref = nodes(toastsUi.ToastItem({ toast }))[0].ref;
        // The same ref at every render, so it is called with null only when the toast goes.
        expect(nodes(toastsUi.ToastItem({ toast }))[0].ref).toBe(ref);
        const button = focusable("toast button");
        const el = { contains: (node: unknown) => node === button };
        ref(el);
        g.activeElement = button;
        vi.advanceTimersByTime(10_000); // its time is up
        expect(state.toasts.value).toEqual([]);
        ref(null); // Preact takes it out, still holding the focus...
        g.activeElement = null; // ...which falls to <body>
        vi.advanceTimersByTime(20);
        expect(targets.scroller.focused, String(withDocument)).toBe(withDocument ? 1 : 0);
        expect(targets.heading.focused, String(withDocument)).toBe(withDocument ? 0 : 1);
        targets.restore();
      }
      // Gone without the focus: nothing moves it.
      const targets = focusTargets(true);
      const id = state.showToast("info", "Saved.");
      const ref = nodes(toastsUi.ToastItem({ toast: state.toasts.value.find((x) => x.id === id)! }))[0].ref;
      ref({ contains: () => false });
      state.dismissToast(id);
      ref(null);
      g.activeElement = null;
      vi.advanceTimersByTime(20);
      expect(targets.scroller.focused).toBe(0);
      targets.restore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("is under the text when it has a button (phones keep the text readable)", () => {
    const id = state.showToast("info", "Downloaded “contratto-affitto-2026-firmato-modificato.pdf”.", undefined, { label: "Go", run: () => undefined });
    const box = nodes(toastsUi.ToastItem({ toast: state.toasts.value.find((x) => x.id === id)! }))[0];
    expect(box.props.class).toBe("toast toast-info has-action");
    const plain = state.showToast("warn", "Careful.");
    expect(nodes(toastsUi.ToastItem({ toast: state.toasts.value.find((x) => x.id === plain)! }))[0].props.class).toBe("toast toast-warn");
  });

  it("stays 10 s (info toasts otherwise 4 s), and takes the place of the same message shown without it", () => {
    vi.useFakeTimers();
    try {
      state.showToast("info", "Plain.");
      state.showToast("info", "With a button.", undefined, { label: "Go", run: () => undefined });
      vi.advanceTimersByTime(4001);
      expect(state.toasts.value.map((x) => x.text)).toEqual(["With a button."]);
      vi.advanceTimersByTime(6000);
      expect(state.toasts.value).toEqual([]);

      state.showToast("info", "Same.");
      state.showToast("info", "Same.", undefined, { label: "Go", run: () => undefined });
      expect(state.toasts.value).toHaveLength(1);
      expect(state.toasts.value[0].action?.label).toBe("Go");
      state.showToast("info", "Same."); // and again without: the one with the button stays
      expect(state.toasts.value).toHaveLength(1);
      expect(state.toasts.value[0].action?.label).toBe("Go");
    } finally {
      vi.useRealTimers();
    }
  });
});
