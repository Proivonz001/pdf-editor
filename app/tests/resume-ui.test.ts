// "Riprendi" in the UI (release 4), against the app's real state and actions with a fake engine
// (which exports as the real one: nothing for a file from the device with no edits, a document
// made here even with none) and an in-memory stand-in for the device's store (platform/resume.ts,
// tested on its own in tests/resume.test.ts): the autosave (a save about a second after a burst
// of edits, with the view; at once when the page is hidden or left, also for a view that changed;
// kept whenever the engine exports something, forgotten when it gives null: nothing for a
// password-protected document or a file from the device with no edits, also while a scan to add
// pages to it is open; what another tab or an earlier visit kept left alone by those forgets; a
// document made from photos kept with no edits, also once downloaded, and once downloaded with an
// edit that is then undone, said and resumed as not downloaded as it really is; edits that never
// pause; forgotten when the document is closed, also while its save is being written, kept when
// an open fails; never during a download or while the engine writes an edit; one export at a time;
// a save whose document went stores nothing; a full store: what this page kept of another
// document goes and the save is tried again, another tab's record never, and a failure is said
// once; nothing at all where storage cannot be used), and the home page's card (what it says, and
// when; read again when what is kept changes while it shows; Riprendi for the document, with its
// history and its view, counted as downloaded or not as it was kept, an edit that no longer
// applies, a file kept with no log, what no longer opens, what cannot be read now; Riprendi for
// the scan; Dimentica with its "Annulla", forgetting exactly the record it was pressed for,
// whatever is open when its toast ends, and never a newer one). Fix round 3 (R8, with the real
// scan flow and page actions): after Riprendi, only a scan meant for that very document is
// offered (one for another document waits for its own); the scan's place follows a page operation
// that lands while its flow is open; Done lets the kept scan go only once the save of the document
// holding its pages has answered (keepOpenDocument: asked at once, answered by a save that starts
// after it).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "./stubs/browser-globals";

// ---------------------------------------------------------------------------------------------
// Browser bits the autosave and the card use: page visibility and its events, the focus targets.

type Listener = () => void;
const listeners = { document: new Map<string, Set<Listener>>(), window: new Map<string, Set<Listener>>() };
function listen(where: Map<string, Set<Listener>>) {
  return {
    add(type: string, fn: Listener) {
      if (!where.has(type)) where.set(type, new Set());
      where.get(type)!.add(fn);
    },
    remove(type: string, fn: Listener) { where.get(type)?.delete(fn); },
  };
}
const g = globalThis as any;
const docEvents = listen(listeners.document);
const winEvents = listen(listeners.window);
g.document.addEventListener = docEvents.add;
g.document.removeEventListener = docEvents.remove;
g.document.visibilityState = "visible";
g.document.querySelector = () => null;
g.document.getElementById = () => null;
g.addEventListener = winEvents.add; // window is globalThis here
g.removeEventListener = winEvents.remove;

function fire(where: "document" | "window", type: string) {
  for (const fn of [...(listeners[where].get(type) ?? [])]) fn();
}
function hidePage() {
  g.document.visibilityState = "hidden";
  fire("document", "visibilitychange");
}

// ---------------------------------------------------------------------------------------------
// The fake engine

vi.mock("../src/engine/client.ts", () => {
  class EngineError extends Error {
    constructor(message: string, readonly code?: string) {
      super(message);
    }
  }
  const e = () => (globalThis as any).__resumeEngine;
  class EngineClient {
    ready = Promise.resolve();
    open(bytes: ArrayBuffer, password?: string) { return e().open(bytes, password); }
    newFromPictures(pictures: unknown[]) { return e().newFromPictures(pictures); }
    exportSession() { return e().exportSession(); }
    resumeSession(original: ArrayBuffer, log: unknown, password?: string) { return e().resumeSession(original, log, password); }
    save(options?: unknown) { return e().save(options); }
    undo() { return e().undo(); }
    redo() { return e().redo(); }
    close() { return e().close(); }
    editPages(edit: unknown) { return e().editPages(edit); }
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

// The scan flow (ui/scan) is agent ScanUI's: here only what Riprendi hands it.
vi.mock("../src/ui/scan/ScanFlow.tsx", () => ({
  resumeScan: (saved: unknown) => { (globalThis as any).__resumedScans.push(saved); },
}));
g.__resumedScans = [] as unknown[];

// The device's store: what it keeps (summaries read without the bytes), with switches for a store
// that refuses saves, cannot be used, holds a save while it writes, or cannot read what it keeps.
// As the real one (platform/resume.ts): its calls run one after the other in the order they were
// made (each is listed in `calls` when it is made); every record has a stamp of its own (a new
// one at each save; a record a test puts there gets one when first read), which its summary and
// its load give, and a forget naming a stamp removes only that record; a session saved here is
// this page's (`owner`) and one loaded to resume it becomes this page's (`claimed`), so a forget
// "own" leaves alone a record another tab (or an earlier visit) wrote; a forget answers whether
// it removed something; and every save or forget that worked bumps `resumeChanged`.
vi.mock("../src/platform/resume.ts", async () => {
  const { signal } = await import("@preact/signals");
  const s = () => (globalThis as any).__store;
  const copy = (b: ArrayBuffer) => b.slice(0);
  let queue: Promise<unknown> = Promise.resolve();
  function queued<T>(job: () => Promise<T>): Promise<T> {
    const run = queue.then(job, job);
    queue = run.then(() => undefined, () => undefined);
    return run;
  }
  let stamps = 0;
  const stampOf = (k: any): string => (k.stamp ??= `stamp-${++stamps}`);
  const named = (which: unknown): which is { stamp: string } => typeof which === "object" && which !== null;
  const resumeChanged = signal(0);
  const changed = () => { resumeChanged.value++; };
  return {
    resumeChanged,
    resumeAvailable: async () => s().available,
    saveSession: (x: any) => {
      s().calls.push(`saveSession:${x.fileName}:${x.editCount}`);
      return queued(async () => {
        if (s().saveGate) await s().saveGate; // being written
        if (!s().available || s().refuse > 0) {
          if (s().refuse > 0) s().refuse--;
          return false;
        }
        s().session = { ...x, original: copy(x.original), savedAt: s().now(), owner: "this page", stamp: `stamp-${++stamps}` };
        changed();
        return true;
      });
    },
    sessionSummary: () => {
      s().calls.push("sessionSummary");
      return queued(async () => {
        const k = s().session;
        if (!k || !s().available) return null;
        return {
          fileName: k.fileName, savedAt: k.savedAt, editCount: k.editCount, pageCount: k.pageCount,
          neverDownloaded: k.neverDownloaded !== false, stamp: stampOf(k),
        };
      });
    },
    loadSession: () => {
      s().calls.push("loadSession");
      return queued(async () => {
        const k = s().session;
        if (!k || s().unreadable) return null;
        k.claimed = true;
        return { ...k, stamp: stampOf(k), original: copy(k.original), log: structuredClone(k.log) };
      });
    },
    forgetSession: (which: "any" | "own" | { stamp: string } = "any") => {
      s().calls.push(which === "own" ? "forgetSession:own" : named(which) ? `forgetSession:${which.stamp}` : "forgetSession");
      return queued(async () => {
        const k = s().session;
        if (!k) return false;
        if (which === "own" && k.owner !== "this page" && !k.claimed) return false; // another page's
        if (named(which) && stampOf(k) !== which.stamp) return false; // replaced since
        s().session = null;
        changed();
        return true;
      });
    },
    saveScan: (x: any) =>
      queued(async () => {
        s().scan = { target: x.target, doc: x.doc ?? null, savedAt: s().now(), pages: x.pages.slice(), stamp: `stamp-${++stamps}` };
        changed();
        return true;
      }),
    scanSummary: () =>
      queued(async () => {
        const k = s().scan;
        return k && s().available
          ? { target: k.target, doc: k.doc ?? null, savedAt: k.savedAt, pages: k.pages.length, stamp: stampOf(k) }
          : null;
      }),
    loadScan: () => {
      s().calls.push("loadScan");
      return queued(async () => (s().scan && !s().unreadable ? structuredClone(s().scan) : null));
    },
    forgetScan: (which: "any" | { stamp: string } = "any") => {
      s().calls.push(named(which) ? `forgetScan:${which.stamp}` : "forgetScan");
      return queued(async () => {
        const k = s().scan;
        if (!k) return false;
        if (named(which) && stampOf(k) !== which.stamp) return false;
        s().scan = null;
        changed();
        return true;
      });
    },
  };
});

interface Store {
  available: boolean;
  /** How many of the next saves the store refuses (a full disk). */
  refuse: number;
  /** Saves wait for it while they write (a big original being written). */
  saveGate: Promise<void> | null;
  /** What is kept cannot be read now (loadSession, loadScan: null; the summaries are still there). */
  unreadable: boolean;
  session: any;
  scan: any;
  calls: string[];
  now: () => number;
}
const store: Store = {
  available: true, refuse: 0, saveGate: null, unreadable: false, session: null, scan: null, calls: [], now: () => Date.now(),
};
g.__store = store;

const pagesOf = (n: number) => Array.from({ length: n }, (_, index) => ({ index, bounds: [0, 0, 100, 200] }));
const docInfo = (pages: number, extra: Record<string, unknown> = {}) => ({
  pageCount: pages, pages: pagesOf(pages), encrypted: false, needsPassword: false, canKeepPassword: false,
  pdfa: null, signatures: 0, form: null, title: null, ...extra,
});

/** A promise the test opens when it wants (an engine answer held back). */
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

// As the real engine (session.ts): a document made here (newFromPictures, or resumed from a log
// that says so) is exported even with no edits, and after a download too; a file from the device
// with no edits is not (null). The log here: the edits as a list, and whether it was made here.
const engineImpl: any = {
  calls: [] as string[],
  pages: 3,
  info: {} as Record<string, unknown>,
  openResult: null as any,
  exported: undefined as any,
  exportGate: null as Promise<void> | null,
  resumeResult: null as any,
  resumeGate: null as Promise<void> | null,
  resumeError: null as Error | null,
  resumedWith: null as any,
  madeHere: false,
  async open(bytes: ArrayBuffer) {
    this.calls.push(`open:${bytes.byteLength}`);
    this.madeHere = false;
    return this.openResult ?? { ok: true, ...docInfo(this.pages, this.info) };
  },
  async newFromPictures(pictures: unknown[]) {
    this.calls.push(`newFromPictures:${pictures.length}`);
    this.madeHere = true;
    return { ok: true, ...docInfo(pictures.length) };
  },
  async exportSession() {
    this.calls.push("exportSession");
    if (this.exportGate) await this.exportGate;
    if (this.exported !== undefined) return this.exported;
    const editCount = stateMod.history.peek().editCount;
    if (editCount === 0 && !this.madeHere) return null;
    const log = { edits: [{ kind: "addText", n: editCount, bytes: new Uint8Array([1, 2, 3]) }], madeHere: this.madeHere };
    return { original: new ArrayBuffer(64), log, editCount, ...(this.madeHere ? { madeHere: true } : {}) };
  },
  async resumeSession(original: ArrayBuffer, log: any) {
    this.calls.push("resumeSession");
    this.resumedWith = { bytes: original.byteLength, log };
    if (this.resumeGate) await this.resumeGate;
    if (this.resumeError) throw this.resumeError;
    if (this.resumeResult?.ok) this.madeHere = log?.madeHere === true;
    return this.resumeResult;
  },
  async save() {
    this.calls.push("save");
    return { bytes: new ArrayBuffer(32), pdfa: null };
  },
  async undo() { return { editCount: 0, canUndo: false, canRedo: true, changedPages: [0] }; },
  async redo() { return { editCount: 1, canUndo: true, canRedo: false, changedPages: [0] }; },
  async close() {
    this.calls.push("close");
    this.madeHere = false;
    return null;
  },
  // Page operations (the scan flow's Fine, a delete): the layout as the real one gives it, from the
  // pages the document has when the answer comes; `editGate` holds the answer back.
  edits: [] as any[],
  editGate: null as Promise<void> | null,
  async editPages(edit: any) {
    this.calls.push(`editPages:${edit.kind}`);
    this.edits.push(edit);
    if (this.editGate) await this.editGate;
    const n = stateMod.doc.peek()!.pages.length;
    let from: (number | null)[] = Array.from({ length: n }, (_, i) => i);
    if (edit.kind === "delete") from = from.filter((i) => !edit.pages.includes(i));
    else if (edit.kind === "pictures") from.splice(edit.at, 0, ...edit.pictures.map(() => null));
    return {
      editCount: stateMod.history.peek().editCount + 1, canUndo: true, canRedo: false, changedPages: [],
      layout: { pages: pagesOf(from.length), from, form: null, signatures: 0 },
      report: { linksRemoved: 0, fieldsRenamed: 0, signaturesAdded: 0 },
    };
  },
};
g.__resumeEngine = engineImpl;

let stateMod: typeof import("../src/state");
let actions: typeof import("../src/ui/actions");
let autosave: typeof import("../src/ui/resume/autosave");
let card: typeof import("../src/ui/resume/ResumeCard");
let zoomMod: typeof import("../src/viewer/zoom");
let i18n: typeof import("../src/i18n");
let clientMod: typeof import("../src/engine/client");
/** The store's stand-in above (what the scan flow and other tabs would call). */
let storeMod: typeof import("../src/platform/resume");

beforeAll(async () => {
  stateMod = await import("../src/state");
  actions = await import("../src/ui/actions");
  autosave = await import("../src/ui/resume/autosave");
  card = await import("../src/ui/resume/ResumeCard");
  zoomMod = await import("../src/viewer/zoom");
  i18n = await import("../src/i18n");
  clientMod = await import("../src/engine/client");
  storeMod = await import("../src/platform/resume");
});

/** Let the promises, and the timers due by now, run (and the save in flight end). */
async function settle(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
  await autosave.autosaveIdle();
  await vi.advanceTimersByTimeAsync(0);
}

const fakeFile = (name: string) =>
  ({ name, type: "application/pdf", arrayBuffer: async () => new ArrayBuffer(10) }) as unknown as File;

async function open(name = "a.pdf") {
  await actions.openFile(fakeFile(name), { confirmed: true });
  await settle();
}

/** An edit as the engine reports it (the history now holds `count` edits). */
function edit(count = stateMod.history.peek().editCount + 1, page = 0) {
  stateMod.recordHistory({ editCount: count, canUndo: true, canRedo: false, changedPages: [page] }, "edit");
}

const engineCalls = (what: string) => engineImpl.calls.filter((c: string) => c === what || c.startsWith(`${what}:`)).length;
const storeCalls = (what: string) => store.calls.filter((c) => c === what || c.startsWith(`${what}:`)).length;

/** Answer the question on screen (a confirm). */
function answer(yes: boolean) {
  const q = stateMod.dialog.peek() as any;
  expect(q?.kind).toBe("confirm");
  q.resolve(yes);
  stateMod.dialog.value = null;
}

/** A record as autosave keeps it. */
function keptSession(over: Record<string, unknown> = {}) {
  return {
    fileName: "contratto.pdf", savedAt: Date.now() - 5 * 60_000, editCount: 3, pageCount: 4,
    original: new ArrayBuffer(100), log: [{ kind: "addText", n: 1 }], view: { page: 2, zoom: 1.5, fit: false }, ...over,
  };
}

function keptScan(target: any = { kind: "new" }, pages = 2) {
  return {
    target, savedAt: Date.now() - 60_000,
    pages: Array.from({ length: pages }, () => ({ bytes: new ArrayBuffer(8), width: 100, height: 140, dpi: 200, preview: new ArrayBuffer(4) })),
  };
}

/** Every vnode in `node`, depth first. */
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

const buttons = (tree: any) => nodes(tree).filter((n) => n.type === "button");

beforeEach(async () => {
  vi.useFakeTimers();
  autosave.stopAutosave();
  // Start from the home page, with nothing open (no autosave watching yet: nothing is forgotten).
  stateMod.doc.value = null;
  stateMod.opening.value = null;
  stateMod.resetHistory();
  stateMod.dialog.value = null;
  stateMod.toasts.value = [];
  stateMod.downloadRunning.value = false;
  stateMod.busy.value = null;
  stateMod.scanFlow.value = null;
  stateMod.engineStatus.value = "ready";
  stateMod.currentPage.value = 0;
  stateMod.zoom.value = 1;
  stateMod.fitMode.value = true;
  i18n.setLocale("en");
  g.document.visibilityState = "visible";
  Object.assign(store, { available: true, refuse: 0, saveGate: null, unreadable: false, session: null, scan: null, calls: [] });
  Object.assign(engineImpl, {
    calls: [], pages: 3, info: {}, openResult: null, exported: undefined, exportGate: null,
    resumeResult: null, resumeGate: null, resumeError: null, resumedWith: null, madeHere: false, edits: [], editGate: null,
  });
  g.__resumedScans.length = 0;
  card.forgetting.value = new Set();
  card.resumeState.value = null;
});

afterEach(async () => {
  autosave.stopAutosave();
  await vi.runOnlyPendingTimersAsync();
  vi.useRealTimers();
});

/** Start the autosave, with a document `name` open and nothing kept for it yet. */
async function startWith(name = "a.pdf") {
  autosave.startAutosave();
  await settle();
  await open(name);
  await settle(autosave.AUTOSAVE_DELAY_MS); // the open's own save: nothing to keep, what was kept goes
  store.calls.length = 0;
  engineImpl.calls.length = 0;
}

// ---------------------------------------------------------------------------------------------

describe("R1 autosave: when", () => {
  it("saves about a second after an edit, once for a burst of edits, with the view", async () => {
    await startWith("a.pdf");
    edit(1);
    await settle(500);
    edit(2);
    await settle(900);
    expect(engineCalls("exportSession")).toBe(0);
    await settle(150);
    expect(engineCalls("exportSession")).toBe(1);
    expect(store.calls).toEqual(["saveSession:a.pdf:2"]);
    expect(store.session).toMatchObject({ fileName: "a.pdf", editCount: 2, pageCount: 3, view: { page: 0, zoom: 1, fit: true } });
    expect(store.session.log).toEqual({ edits: [{ kind: "addText", n: 2, bytes: new Uint8Array([1, 2, 3]) }], madeHere: false });

    // An undo is a change too; the view is the one at the save.
    stateMod.currentPage.value = 2;
    stateMod.fitMode.value = false;
    stateMod.zoom.value = 1.5;
    stateMod.recordHistory({ editCount: 1, canUndo: true, canRedo: true, changedPages: [0] }, "undo");
    await settle(autosave.AUTOSAVE_DELAY_MS);
    expect(engineCalls("exportSession")).toBe(2);
    expect(store.session).toMatchObject({ editCount: 1, view: { page: 2, zoom: 1.5, fit: false } });
  });

  it("edits that never pause still get a save every few seconds", async () => {
    await startWith("a.pdf");
    for (let k = 1; k <= 14; k++) {
      edit(k);
      await settle(900);
    }
    // 14 edits 0.9 s apart: one save once the first had waited AUTOSAVE_MAX_WAIT_MS, none more yet.
    expect(autosave.AUTOSAVE_MAX_WAIT_MS).toBe(10_000);
    expect(engineCalls("exportSession")).toBe(1);
    expect(store.session.editCount).toBe(12);
    await settle(autosave.AUTOSAVE_DELAY_MS);
    expect(engineCalls("exportSession")).toBe(2);
    expect(store.session.editCount).toBe(14);
  });

  it("saves at once when the page is hidden or left, also when only the view changed; nothing when nothing did", async () => {
    await startWith("a.pdf");
    edit(1);
    hidePage();
    await settle();
    expect(engineCalls("exportSession")).toBe(1);
    expect(storeCalls("saveSession")).toBe(1);
    await settle(autosave.AUTOSAVE_DELAY_MS * 2); // the timer was taken back: no second save
    expect(engineCalls("exportSession")).toBe(1);

    g.document.visibilityState = "visible";
    hidePage(); // nothing changed since
    fire("window", "pagehide");
    await settle();
    expect(engineCalls("exportSession")).toBe(1);

    stateMod.currentPage.value = 1; // only the view
    fire("window", "pagehide");
    await settle();
    expect(engineCalls("exportSession")).toBe(2);
    expect(store.session.view).toEqual({ page: 1, zoom: 1, fit: true });

    // Becoming visible again saves nothing.
    g.document.visibilityState = "visible";
    fire("document", "visibilitychange");
    await settle(autosave.AUTOSAVE_DELAY_MS);
    expect(engineCalls("exportSession")).toBe(2);
  });

  it("does not export during a download or while the engine writes an edit, and does once they are done", async () => {
    await startWith("a.pdf");
    stateMod.downloadRunning.value = true;
    edit(1);
    await settle(autosave.AUTOSAVE_DELAY_MS * 3);
    expect(engineCalls("exportSession")).toBe(0);
    stateMod.busy.value = "save";
    stateMod.downloadRunning.value = false;
    await settle();
    expect(engineCalls("exportSession")).toBe(0); // the engine is still writing the file
    stateMod.busy.value = null;
    await settle();
    expect(engineCalls("exportSession")).toBe(1);
    expect(storeCalls("saveSession")).toBe(1);

    stateMod.busy.value = "edit";
    edit(2);
    await settle(autosave.AUTOSAVE_DELAY_MS * 2);
    expect(engineCalls("exportSession")).toBe(1);
    stateMod.busy.value = null;
    await settle();
    expect(engineCalls("exportSession")).toBe(2);
    expect(store.session.editCount).toBe(2);
  });

  it("the page hidden during a download still saves at once (the page may not come back)", async () => {
    await startWith("a.pdf");
    stateMod.downloadRunning.value = true;
    edit(1);
    await settle(autosave.AUTOSAVE_DELAY_MS);
    hidePage();
    await settle();
    expect(engineCalls("exportSession")).toBe(1);
    stateMod.downloadRunning.value = false;
    await settle();
    expect(engineCalls("exportSession")).toBe(1);
  });

  it("never has more than one export in flight", async () => {
    await startWith("a.pdf");
    const held = gate();
    engineImpl.exportGate = held.promise;
    edit(1);
    await vi.advanceTimersByTimeAsync(autosave.AUTOSAVE_DELAY_MS);
    expect(engineCalls("exportSession")).toBe(1);
    edit(2);
    await vi.advanceTimersByTimeAsync(autosave.AUTOSAVE_DELAY_MS);
    hidePage();
    await vi.advanceTimersByTimeAsync(0);
    expect(engineCalls("exportSession")).toBe(1);
    engineImpl.exportGate = null;
    held.open();
    await settle();
    expect(engineCalls("exportSession")).toBe(2); // one more, for what changed meanwhile
    expect(store.session.editCount).toBe(2);
    await settle(autosave.AUTOSAVE_DELAY_MS * 2);
    expect(engineCalls("exportSession")).toBe(2);
  });
});

describe("R2 autosave: what", () => {
  it("forgets what was kept when the engine gives nothing to keep", async () => {
    await startWith("a.pdf");
    edit(1);
    await settle(autosave.AUTOSAVE_DELAY_MS);
    expect(store.session?.fileName).toBe("a.pdf");
    engineImpl.exported = null;
    edit(2);
    await settle(autosave.AUTOSAVE_DELAY_MS);
    expect(store.calls).toEqual(["saveSession:a.pdf:1", "forgetSession:own"]);
    expect(store.session).toBeNull();
  });

  it("never asks the engine for a document that needed a password, and forgets what was kept of the one before", async () => {
    await startWith("a.pdf");
    edit(1);
    await settle(autosave.AUTOSAVE_DELAY_MS);
    expect(store.session?.fileName).toBe("a.pdf");
    engineImpl.info = { needsPassword: true, encrypted: true };
    await open("secret.pdf");
    edit(1);
    await settle(autosave.AUTOSAVE_DELAY_MS);
    edit(2);
    await settle(autosave.AUTOSAVE_DELAY_MS);
    hidePage();
    await settle();
    expect(engineCalls("exportSession")).toBe(1); // a.pdf's
    expect(storeCalls("saveSession")).toBe(1);
    expect(store.session).toBeNull();
  });

  it("another document opened takes the place of what this page kept: forgotten with no edits, replaced with some", async () => {
    await startWith("a.pdf");
    edit(1);
    await settle(autosave.AUTOSAVE_DELAY_MS);
    expect(store.session?.fileName).toBe("a.pdf");
    await open("b.pdf");
    expect(store.session?.fileName).toBe("a.pdf"); // not before the delay
    await settle(autosave.AUTOSAVE_DELAY_MS);
    expect(store.session).toBeNull();
    edit(1);
    await settle(autosave.AUTOSAVE_DELAY_MS);
    expect(store.session?.fileName).toBe("b.pdf");
  });

  it("what an earlier visit kept stays offered when a document without edits is opened, until one with edits takes its place", async () => {
    store.session = keptSession({ fileName: "old.pdf" }); // another page load wrote it
    autosave.startAutosave();
    await settle();
    await open("b.pdf");
    await settle(autosave.AUTOSAVE_DELAY_MS);
    expect(store.session?.fileName).toBe("old.pdf");
    await actions.closeDocument();
    await settle();
    expect(text(card.ResumeCard())).toContain("old.pdf");
    await open("c.pdf");
    edit(1);
    await settle(autosave.AUTOSAVE_DELAY_MS);
    expect(store.session?.fileName).toBe("c.pdf");
  });

  it("P34 two tabs: a document opened without edits here leaves alone what another tab keeps; what this page kept goes", async () => {
    // Tab A keeps x.pdf with 5 edits (another page wrote the record).
    store.session = { ...keptSession({ fileName: "x.pdf", editCount: 5 }), owner: "tab A" };
    autosave.startAutosave();
    await settle();
    // This tab opens y.pdf just to read it, then closes it.
    await open("y.pdf");
    await settle(autosave.AUTOSAVE_DELAY_MS);
    expect(storeCalls("forgetSession")).toBe(1);
    expect(store.session?.fileName).toBe("x.pdf");
    await actions.closeDocument();
    await settle();
    expect(store.session?.fileName).toBe("x.pdf");
    expect(store.session.editCount).toBe(5);
    expect(text(card.ResumeCard())).toContain("x.pdf");
    // A document with edits here: ONE document is kept, the last one saved (tab A's record replaced).
    await open("z.pdf");
    edit(1);
    await settle(autosave.AUTOSAVE_DELAY_MS);
    expect(store.session?.fileName).toBe("z.pdf");
    // Then another one without edits: what this page kept goes.
    await open("w.pdf");
    await settle(autosave.AUTOSAVE_DELAY_MS);
    expect(store.session).toBeNull();
  });

  it("keeps a document made from photos whenever the engine exports it: at once with no edits, with edits, undone again", async () => {
    autosave.startAutosave();
    await settle();
    const picture = { bytes: new ArrayBuffer(8), width: 1654, height: 2339, dpi: 200 };
    expect(await actions.newFromPicturesAction([picture], "Scansione 2026-10-17.pdf")).toBe(true);
    await settle(); // at once: the scan flow has let its pages go
    expect(engineCalls("exportSession")).toBe(1);
    expect(engineCalls("save")).toBe(0);
    expect(store.session).toMatchObject({ fileName: "Scansione 2026-10-17.pdf", editCount: 0, pageCount: 1, neverDownloaded: true });
    expect(store.session.log).toMatchObject({ edits: expect.any(Array), madeHere: true });
    expect(store.session.original.byteLength).toBe(64);

    // With an edit it is kept as any other; undone, kept with none again.
    edit(1);
    await settle(autosave.AUTOSAVE_DELAY_MS);
    expect(engineCalls("exportSession")).toBe(2);
    expect(store.session).toMatchObject({ editCount: 1, neverDownloaded: true });
    stateMod.recordHistory({ editCount: 0, canUndo: false, canRedo: true, changedPages: [0] }, "undo");
    await settle(autosave.AUTOSAVE_DELAY_MS);
    expect(store.session).toMatchObject({ editCount: 0, neverDownloaded: true });

    // Closed: forgotten.
    const closing = actions.closeDocument();
    await vi.advanceTimersByTimeAsync(0);
    answer(true); // "close without downloading"
    await closing;
    await settle();
    expect(store.session).toBeNull();
  });

  it("made here: a scanned PDF downloaded with an edit, the edit then undone, is still kept (that state exists only here) and resumed as not downloaded", async () => {
    autosave.startAutosave();
    await settle();
    const picture = { bytes: new ArrayBuffer(8), width: 1654, height: 2339, dpi: 200 };
    expect(await actions.newFromPicturesAction([picture], "Scansione.pdf")).toBe(true);
    await settle();
    expect(store.session).toMatchObject({ fileName: "Scansione.pdf", editCount: 0, neverDownloaded: true });
    edit(1); // signed
    await settle(autosave.AUTOSAVE_DELAY_MS);
    stateMod.markSaved(stateMod.saveKey()); // downloaded, signed
    await settle(autosave.AUTOSAVE_DELAY_MS);
    stateMod.recordHistory({ editCount: 0, canUndo: false, canRedo: true, changedPages: [0] }, "undo");
    await settle(autosave.AUTOSAVE_DELAY_MS);
    expect(stateMod.dirty.value).toBe(true); // the unsigned scan exists nowhere else
    expect(store.session).toMatchObject({ fileName: "Scansione.pdf", editCount: 0, neverDownloaded: true });
    expect(store.session.log).toMatchObject({ madeHere: true });
    expect(engineCalls("save")).toBe(0); // the engine's export, never the file as a stand-in

    // The tab is killed (the camera open again for one more page); on the next visit Riprendi.
    autosave.stopAutosave();
    stateMod.doc.value = null;
    stateMod.resetHistory();
    autosave.startAutosave();
    await settle();
    expect(text(card.ResumeCard())).toContain("1 page, not downloaded yet");
    engineImpl.resumeResult = {
      ok: true, ...docInfo(1), history: { editCount: 0, canUndo: false, canRedo: false, changedPages: [] }, applied: 0, failedAt: null,
    };
    await card.resumeDocument();
    expect(engineImpl.resumedWith.log).toMatchObject({ madeHere: true });
    expect(stateMod.doc.peek()?.fileName).toBe("Scansione.pdf");
    expect(stateMod.dirty.value).toBe(true);
    await settle(autosave.AUTOSAVE_DELAY_MS);
    expect(store.session).toMatchObject({ fileName: "Scansione.pdf", editCount: 0, neverDownloaded: true });
  });

  it("made here: downloaded as it is, still kept (an undo after a download makes a state that exists only here), said and resumed as downloaded", async () => {
    autosave.startAutosave();
    await settle();
    expect(await actions.newFromPicturesAction([{ bytes: new ArrayBuffer(8), width: 1654, height: 2339, dpi: 200 }], "Scansione.pdf")).toBe(true);
    await settle();
    stateMod.markSaved(stateMod.saveKey()); // downloaded with no edits
    await settle(autosave.AUTOSAVE_DELAY_MS);
    expect(stateMod.dirty.value).toBe(false);
    expect(store.session).toMatchObject({ fileName: "Scansione.pdf", editCount: 0, neverDownloaded: false });
    autosave.stopAutosave();
    stateMod.doc.value = null;
    stateMod.resetHistory();
    autosave.startAutosave();
    await settle();
    expect(text(card.ResumeCard())).toContain("1 page · just now");
    expect(text(card.ResumeCard())).not.toContain("not downloaded");
    engineImpl.resumeResult = {
      ok: true, ...docInfo(1), history: { editCount: 0, canUndo: false, canRedo: false, changedPages: [] }, applied: 0, failedAt: null,
    };
    await card.resumeDocument();
    expect(stateMod.dirty.value).toBe(false); // as it was: the user has that very file
    await settle(autosave.AUTOSAVE_DELAY_MS);
    expect(store.session).toMatchObject({ fileName: "Scansione.pdf", editCount: 0 });
  });

  it("a file from disk without edits is not kept, whatever it had before (undone back to the start)", async () => {
    await startWith("a.pdf");
    expect(store.session).toBeNull();
    edit(1);
    await settle(autosave.AUTOSAVE_DELAY_MS);
    expect(store.session).toMatchObject({ fileName: "a.pdf", editCount: 1, neverDownloaded: false });
    stateMod.markSaved(stateMod.saveKey());
    stateMod.recordHistory({ editCount: 0, canUndo: false, canRedo: true, changedPages: [0] }, "undo");
    await settle(autosave.AUTOSAVE_DELAY_MS);
    expect(stateMod.dirty.value).toBe(true); // the edited file was downloaded, the user has the original
    expect(store.session).toBeNull();
    expect(engineCalls("save")).toBe(0);
  });

  it("P37 P40: a file from disk without edits is not kept because a scan to add pages to it is open (the user has the file)", async () => {
    await startWith("a.pdf");
    stateMod.scanFlow.value = { kind: "insert", at: 1 };
    await settle(autosave.AUTOSAVE_DELAY_MS);
    hidePage(); // the camera app takes the page's place
    await settle();
    g.document.visibilityState = "visible";
    expect(engineCalls("save")).toBe(0);
    expect(storeCalls("saveSession")).toBe(0);
    expect(store.session).toBeNull();
    // The scan's pages added: an edit, kept as any other (the card says "1 edit", not "not downloaded").
    edit(1);
    stateMod.scanFlow.value = null;
    await settle(autosave.AUTOSAVE_DELAY_MS);
    expect(store.session).toMatchObject({ fileName: "a.pdf", editCount: 1 });
    expect(engineCalls("exportSession")).toBe(1);
    expect(engineCalls("save")).toBe(0);

    // A document made here (from photos, not downloaded) is kept with no edits, scan or not.
    const made = actions.newFromPicturesAction([{ bytes: new ArrayBuffer(8), width: 1654, height: 2339, dpi: 200 }], "Scansione.pdf");
    await vi.advanceTimersByTimeAsync(0);
    answer(true); // a.pdf's edit is not downloaded
    expect(await made).toBe(true);
    await settle();
    stateMod.scanFlow.value = { kind: "insert", at: 1 };
    await settle(autosave.AUTOSAVE_DELAY_MS);
    expect(store.session).toMatchObject({ fileName: "Scansione.pdf", editCount: 0, neverDownloaded: true });
    expect(engineCalls("save")).toBe(0);
    stateMod.scanFlow.value = null;
  });
});

describe("R3 autosave: closing, opening, failing", () => {
  it("forgets at once when the document is closed, and a timer or an export on its way stores nothing", async () => {
    await startWith("a.pdf");
    edit(1);
    await settle(autosave.AUTOSAVE_DELAY_MS);
    expect(store.session?.editCount).toBe(1);

    // An export in flight when the document closes.
    const held = gate();
    engineImpl.exportGate = held.promise;
    edit(2);
    await vi.advanceTimersByTimeAsync(autosave.AUTOSAVE_DELAY_MS);
    expect(engineCalls("exportSession")).toBe(2);
    const closing = actions.closeDocument();
    await vi.advanceTimersByTimeAsync(0);
    answer(true);
    await closing;
    expect(store.calls.filter((c) => c !== "sessionSummary").slice(-2)).toEqual(["saveSession:a.pdf:1", "forgetSession:own"]);
    expect(store.calls.at(-1)).toBe("sessionSummary"); // the home page's card, read after the forget
    held.open();
    await settle(autosave.AUTOSAVE_DELAY_MS);
    expect(store.session).toBeNull();
    expect(storeCalls("saveSession")).toBe(1);

    // A save still waiting for its delay when the document closes.
    engineImpl.exportGate = null;
    await open("b.pdf");
    edit(1);
    await settle(300);
    const closing2 = actions.closeDocument();
    await vi.advanceTimersByTimeAsync(0);
    answer(true);
    await closing2;
    await settle(autosave.AUTOSAVE_DELAY_MS * 2);
    expect(engineCalls("exportSession")).toBe(2);
    expect(store.session).toBeNull();
  });

  it("P33: closing the document while its first save is being written still forgets it (the forget runs after the save)", async () => {
    await startWith("a.pdf"); // the open's own save forgot what was kept: nothing kept
    const held = gate();
    store.saveGate = held.promise;
    edit(1);
    await vi.advanceTimersByTimeAsync(autosave.AUTOSAVE_DELAY_MS);
    expect(store.calls).toEqual(["saveSession:a.pdf:1"]); // being written
    const closing = actions.closeDocument();
    await vi.advanceTimersByTimeAsync(0);
    answer(true); // "close without downloading"
    await closing;
    store.saveGate = null;
    held.open();
    await settle(autosave.AUTOSAVE_DELAY_MS);
    expect(store.calls.filter((c) => c !== "sessionSummary")).toEqual(["saveSession:a.pdf:1", "forgetSession:own"]);
    expect(store.session).toBeNull();
    expect(card.ResumeCard()).toBeNull();
  });

  it("P33: another document (no edits) opened while the save is being written: the save is forgotten too, also after it closes", async () => {
    await startWith("a.pdf");
    const held = gate();
    store.saveGate = held.promise;
    edit(1);
    await vi.advanceTimersByTimeAsync(autosave.AUTOSAVE_DELAY_MS);
    expect(store.calls).toEqual(["saveSession:a.pdf:1"]);
    await actions.openFile(fakeFile("b.pdf"), { confirmed: true });
    await vi.advanceTimersByTimeAsync(autosave.AUTOSAVE_DELAY_MS);
    store.saveGate = null;
    held.open();
    await settle(autosave.AUTOSAVE_DELAY_MS);
    expect(store.session).toBeNull();
    await actions.closeDocument();
    await settle();
    expect(store.session).toBeNull();
    expect(card.ResumeCard()).toBeNull();
  });

  it("an open that fails leaves what was kept, and the home page reads it again", async () => {
    store.session = keptSession({ fileName: "old.pdf" });
    autosave.startAutosave();
    await settle();
    expect(card.resumeState.value?.session?.fileName).toBe("old.pdf");
    const reads = storeCalls("sessionSummary");
    engineImpl.openResult = { ok: false, reason: "damaged" };
    await actions.openFile(fakeFile("broken.pdf"), { confirmed: true });
    await settle(autosave.AUTOSAVE_DELAY_MS);
    expect(stateMod.dialog.value?.kind).toBe("alert");
    expect(store.session?.fileName).toBe("old.pdf");
    expect(storeCalls("forgetSession")).toBe(0);
    expect(storeCalls("sessionSummary")).toBe(reads + 1);
  });

  it("a store that refuses: what this page kept of another document goes and the save is tried once more; a failure is said once", async () => {
    await startWith("old.pdf");
    edit(1);
    await settle(autosave.AUTOSAVE_DELAY_MS);
    expect(store.session).toMatchObject({ fileName: "old.pdf", owner: "this page" });
    await open("a.pdf");
    store.calls.length = 0;
    // (The open's own save is still waiting: an edit comes first.)
    store.refuse = 1;
    edit(1);
    await settle(autosave.AUTOSAVE_DELAY_MS);
    expect(store.calls).toEqual(["saveSession:a.pdf:1", "forgetSession:own", "saveSession:a.pdf:1"]);
    expect(store.session?.fileName).toBe("a.pdf");
    expect(stateMod.toasts.value).toEqual([]);

    // This document's own older state stays rather; the failure is said, once.
    store.calls.length = 0;
    store.refuse = 99;
    edit(2);
    await settle(autosave.AUTOSAVE_DELAY_MS);
    expect(store.calls).toEqual(["saveSession:a.pdf:2"]);
    expect(store.session?.editCount).toBe(1);
    const said = () => stateMod.toasts.value.filter((x) => x.text === i18n.t("resume.cantKeep"));
    expect(said()).toHaveLength(1);
    expect(said()[0].kind).toBe("warn");
    edit(3);
    await settle(autosave.AUTOSAVE_DELAY_MS);
    stateMod.toasts.value = [];
    edit(4);
    await settle(autosave.AUTOSAVE_DELAY_MS);
    expect(said()).toHaveLength(0);
  });

  it("P34 a full store never frees another tab's record (nor an earlier visit's) to make room: nothing new is kept, and that is said", async () => {
    // Tab A keeps x.pdf with 5 edits; this tab opens a.pdf (it leaves A's record alone), then edits.
    store.session = { ...keptSession({ fileName: "x.pdf", editCount: 5 }), owner: "tab A" };
    autosave.startAutosave();
    await settle();
    await open("a.pdf");
    await settle(autosave.AUTOSAVE_DELAY_MS);
    store.calls.length = 0;
    store.refuse = 1;
    edit(1);
    await settle(autosave.AUTOSAVE_DELAY_MS);
    expect(store.calls).toEqual(["saveSession:a.pdf:1", "forgetSession:own"]); // nothing of its own to free: no retry
    expect(store.session).toMatchObject({ fileName: "x.pdf", editCount: 5, owner: "tab A" });
    expect(stateMod.toasts.value.filter((x) => x.text === i18n.t("resume.cantKeep"))).toHaveLength(1);
    // Room again: the next save keeps this document (ONE document: the one saved last).
    edit(2);
    await settle(autosave.AUTOSAVE_DELAY_MS);
    expect(store.session).toMatchObject({ fileName: "a.pdf", editCount: 2 });
  });

  it("does nothing at all where the storage cannot be used (no export, no word)", async () => {
    store.available = false;
    autosave.startAutosave();
    await settle();
    await open("a.pdf");
    edit(1);
    await settle(autosave.AUTOSAVE_DELAY_MS);
    hidePage();
    await settle();
    expect(engineCalls("exportSession")).toBe(0);
    expect(storeCalls("saveSession")).toBe(0);
    expect(stateMod.toasts.value).toEqual([]);
    expect(card.ResumeCard()).toBeNull();
  });

  it("saves nothing once the engine has stopped", async () => {
    await startWith("a.pdf");
    stateMod.engineStatus.value = "error";
    edit(1);
    await settle(autosave.AUTOSAVE_DELAY_MS);
    expect(engineCalls("exportSession")).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------

describe("R4 the card: what it says", () => {
  it("shows nothing until something is kept, then the document and the scan with their buttons", async () => {
    await card.refreshResume();
    expect(card.ResumeCard()).toBeNull();

    store.session = keptSession();
    store.scan = keptScan({ kind: "new" }, 2);
    await card.refreshResume();
    const tree = card.ResumeCard();
    expect(tree).not.toBeNull();
    const all = text(tree);
    expect(all).toContain("Resume “contratto.pdf”");
    expect(all).toContain("3 edits · 5 min ago");
    expect(all).toContain("Unfinished scan (2 pages)");
    expect(all).toContain("It stays only on this device.");
    // P34: what really happens (one document; a file opened to read it leaves what is kept alone).
    expect(all).toContain("one document at a time");
    expect(all).toContain("until you close it, tap Forget, or another one takes its place: one with edits, or a PDF made here from photos");
    expect(all).toContain("Opening a PDF just to read it doesn't remove it.");
    expect(all).toContain("PDFs that need a password to open are never kept, nor pages added from one.");
    expect(all).not.toContain("open another one");
    const names = buttons(tree).map((b) => b.props["aria-label"]);
    expect(names).toEqual([
      "Resume “contratto.pdf”", "Forget “contratto.pdf”", "Resume the unfinished scan", "Forget the unfinished scan",
    ]);
    expect(buttons(tree).map((b) => text(b))).toEqual(["Resume", "Forget", "Resume", "Forget"]);
    expect((tree as any).props["aria-label"]).toBe("Pick up where you left off");

    i18n.setLocale("it");
    const it_ = text(card.ResumeCard());
    expect(it_).toContain("Riprendi “contratto.pdf”");
    expect(it_).toContain("3 modifiche · 5 min fa");
    expect(it_).toContain("Scansione non finita (2 pagine)");
    expect(it_).toContain("Resta solo su questo dispositivo.");
    expect(it_).toContain("un documento alla volta");
    expect(it_).toContain("finché lo chiudi, tocchi Dimentica o un altro ne prende il posto: uno con modifiche, o un PDF creato qui da foto");
    expect(it_).toContain("Aprire un PDF solo per leggerlo non lo toglie.");
    expect(it_).toContain("I PDF che chiedono una password per aprirsi non vengono mai tenuti, e nemmeno le pagine aggiunte da uno di loro.");
    expect(it_).not.toContain("ne apri un altro");
    expect(buttons(card.ResumeCard()).map((b) => text(b))).toEqual(["Riprendi", "Dimentica", "Riprendi", "Dimentica"]);

    // The engine down: Riprendi is off. A resume under way: the buttons wait.
    stateMod.engineStatus.value = "error";
    expect(buttons(card.ResumeCard()).filter((b) => b.props.disabled).length).toBe(2);
    stateMod.engineStatus.value = "ready";
    card.resuming.value = "scan";
    expect(buttons(card.ResumeCard()).every((b) => b.props["aria-disabled"] === true)).toBe(true);
    card.resuming.value = null;
  });

  it("only the scan, or only the document, and nothing where the storage cannot be used", async () => {
    store.scan = keptScan({ kind: "insert", at: 2 }, 1);
    await card.refreshResume();
    expect(text(card.ResumeCard())).toContain("Unfinished scan (1 page)");
    expect(buttons(card.ResumeCard())).toHaveLength(2);
    store.available = false;
    await card.refreshResume();
    expect(card.ResumeCard()).toBeNull();
  });

  it("says when, in local time, and what a document kept with no edits is", () => {
    vi.setSystemTime(new Date(2026, 9, 17, 15, 30));
    const now = Date.now();
    i18n.setLocale("it");
    expect(card.whenText(now - 20_000, now)).toBe("poco fa");
    expect(card.whenText(now + 60_000, now)).toBe("poco fa");
    expect(card.whenText(now - 60_000, now)).toBe("1 min fa");
    expect(card.whenText(now - 59 * 60_000, now)).toBe("59 min fa");
    expect(card.whenText(new Date(2026, 9, 17, 9, 5).getTime(), now)).toBe("oggi alle 09:05");
    expect(card.whenText(new Date(2026, 9, 16, 18, 30).getTime(), now)).toBe("ieri alle 18:30");
    expect(card.whenText(new Date(2026, 9, 14, 8, 0).getTime(), now)).toBe("14/10/2026");
    const kept = (editCount: number, pageCount: number, neverDownloaded: boolean) =>
      ({ fileName: "x.pdf", savedAt: now, editCount, pageCount, neverDownloaded, stamp: "s" });
    expect(card.sessionMeta(kept(1, 2, false), now)).toBe("1 modifica · poco fa");
    expect(card.sessionMeta(kept(1, 2, true), now)).toBe("1 modifica · poco fa");
    // P37 P40: "non ancora scaricato" only for a document made here (what the record says).
    expect(card.sessionMeta(kept(0, 2, true), now)).toBe("2 pagine, non ancora scaricato · poco fa");
    expect(card.sessionMeta(kept(0, 2, false), now)).toBe("2 pagine · poco fa");
    i18n.setLocale("en");
    expect(card.whenText(new Date(2026, 9, 17, 9, 5).getTime(), now)).toMatch(/^today at 0?9[:.]05/);
    expect(card.whenText(new Date(2026, 9, 16, 18, 30).getTime(), now)).toMatch(/^yesterday at (18[:.]30|0?6[:.]30)/);
    expect(card.sessionMeta(kept(0, 1, true), now)).toBe("1 page, not downloaded yet · just now");
    expect(card.sessionMeta(kept(0, 1, false), now)).toBe("1 page · just now");
    expect(card.partialText(0)).toBe("The edits no longer apply: the document is as it was when you opened it.");
    expect(card.partialText(1)).toBe("Resumed the first edit: the next one no longer applies.");
    expect(card.partialText(4)).toBe("Resumed the first 4 edits: the next one no longer applies.");
  });
});

describe("R5 the card: Riprendi", () => {
  function resumed(over: Record<string, unknown> = {}) {
    return {
      ok: true, ...docInfo(4), history: { editCount: 3, canUndo: true, canRedo: false, changedPages: [] },
      applied: 3, failedAt: null, ...over,
    };
  }

  it("opens the document again with its edits, its history and its view", async () => {
    store.session = keptSession();
    autosave.startAutosave();
    await settle();
    const went: number[] = [];
    zoomMod.setZoomController({ zoomTo: () => undefined, fitWidth: () => undefined, goToPage: (i) => went.push(i) });
    engineImpl.resumeResult = resumed();
    const held = gate();
    engineImpl.resumeGate = held.promise;
    const run = card.resumeDocument();
    await vi.advanceTimersByTimeAsync(0);
    expect(stateMod.opening.value).toBe("contratto.pdf"); // the "opening…" card meanwhile
    expect(card.resuming.value).toBe("session");
    held.open();
    await run;
    expect(engineImpl.resumedWith).toEqual({ bytes: 100, log: [{ kind: "addText", n: 1 }] });
    const d = stateMod.doc.value!;
    expect(d.fileName).toBe("contratto.pdf");
    expect(d.pages).toHaveLength(4);
    expect(stateMod.opening.value).toBeNull();
    expect(stateMod.history.value).toMatchObject({ editCount: 3, canUndo: true, canRedo: false });
    expect(stateMod.dirty.value).toBe(true);
    expect(stateMod.fitMode.value).toBe(false);
    expect(stateMod.zoom.value).toBe(1.5);
    await vi.advanceTimersByTimeAsync(50); // two frames
    expect(went).toEqual([2]);
    expect(stateMod.toasts.value).toEqual([]);
    expect(card.resuming.value).toBeNull();
    zoomMod.setZoomController(null);

    // Undo takes a resumed edit back, as any other.
    await actions.undo();
    expect(stateMod.history.value.editCount).toBe(0);

    // And it is kept again from now on, as the document it is, this page's own now: its log does
    // not say it was made here, so with no edits the engine gives nothing and it goes; redone, kept.
    await settle(autosave.AUTOSAVE_DELAY_MS);
    expect(store.session).toBeNull();
    await actions.redo();
    await settle(autosave.AUTOSAVE_DELAY_MS);
    expect(store.session).toMatchObject({ fileName: "contratto.pdf", editCount: 1 });
  });

  it("a store that refuses the next save never forgets what the document was resumed from", async () => {
    store.session = keptSession();
    autosave.startAutosave();
    await settle();
    engineImpl.resumeResult = resumed();
    await card.resumeDocument();
    store.calls.length = 0;
    store.refuse = 99;
    await settle(autosave.AUTOSAVE_DELAY_MS);
    expect(store.calls).toEqual(["saveSession:contratto.pdf:3"]);
    expect(store.session?.fileName).toBe("contratto.pdf");
  });

  it("an edit that no longer applies: the ones before it are kept, and a toast says how many", async () => {
    store.session = keptSession({ view: { page: 9, zoom: 1, fit: true } });
    await card.refreshResume();
    const went: number[] = [];
    zoomMod.setZoomController({ zoomTo: () => undefined, fitWidth: () => undefined, goToPage: (i) => went.push(i) });
    engineImpl.resumeResult = resumed({
      ...docInfo(2), history: { editCount: 2, canUndo: true, canRedo: false, changedPages: [] }, applied: 2, failedAt: 2,
    });
    await card.resumeDocument();
    expect(stateMod.history.value.editCount).toBe(2);
    expect(stateMod.fitMode.value).toBe(true);
    const warn = stateMod.toasts.value.find((x) => x.kind === "warn");
    expect(warn?.text).toBe("Resumed the first 2 edits: the next one no longer applies.");
    await vi.advanceTimersByTimeAsync(50);
    expect(went).toEqual([1]); // the page kept, within the pages there are now
    zoomMod.setZoomController(null);
  });

  it("a document kept as the file itself (no log: an earlier build) opens as it is, still not downloaded", async () => {
    store.session = keptSession({ fileName: "Scansione.pdf", editCount: 0, log: null, view: null });
    await card.refreshResume();
    engineImpl.pages = 2;
    await card.resumeDocument();
    expect(engineImpl.calls).toEqual(["open:100"]);
    expect(stateMod.doc.value?.fileName).toBe("Scansione.pdf");
    expect(stateMod.history.value.editCount).toBe(0);
    expect(stateMod.dirty.value).toBe(true);
    expect(stateMod.fitMode.value).toBe(true);
  });

  it("what no longer opens is said and forgotten; an engine that stopped keeps it; a record gone is said", async () => {
    store.session = keptSession();
    await card.refreshResume();
    engineImpl.resumeResult = { ok: false, reason: "damaged" };
    await card.resumeDocument();
    await settle();
    expect(stateMod.doc.value).toBeNull();
    expect(stateMod.opening.value).toBeNull();
    const alert = stateMod.dialog.value as any;
    expect(alert?.kind).toBe("alert");
    expect(alert.title).toBe("“contratto.pdf” can't be resumed");
    expect(alert.body).toBe(i18n.t("resume.damaged"));
    expect(store.session).toBeNull();
    expect(card.ResumeCard()).toBeNull();

    // A log the engine refuses as malformed is forgotten too.
    stateMod.dialog.value = null;
    store.session = keptSession();
    await card.refreshResume();
    engineImpl.resumeError = new clientMod.EngineError("bad log", "bad-request");
    await card.resumeDocument();
    await settle();
    expect(store.session).toBeNull();

    // An engine that stopped: said by the home page; what is kept stays.
    stateMod.dialog.value = null;
    store.session = keptSession();
    await card.refreshResume();
    engineImpl.resumeError = new clientMod.EngineError("gone", "crashed");
    await card.resumeDocument();
    expect(stateMod.engineStatus.value).toBe("error");
    expect(stateMod.opening.value).toBeNull();
    expect(store.session).not.toBeNull();
    expect(stateMod.dialog.value).toBeNull();

    // Kept when the card was read, gone since.
    stateMod.engineStatus.value = "ready";
    engineImpl.resumeError = null;
    store.session = null;
    await card.resumeDocument();
    expect(stateMod.toasts.value.at(-1)).toMatchObject({ kind: "error", text: i18n.t("resume.gone") });
    expect(stateMod.opening.value).toBeNull();
    await settle();
    expect(card.ResumeCard()).toBeNull();
  });

  it("P37 P40: resumed counted as it was kept: a file from the device is clean once its edits are undone, one made here is not", async () => {
    // Kept from a file opened from the device: the record says so.
    await startWith("contratto.pdf");
    edit(1);
    await settle(autosave.AUTOSAVE_DELAY_MS);
    expect(store.session).toMatchObject({ fileName: "contratto.pdf", editCount: 1, neverDownloaded: false });
    // The tab is killed; on the next visit Riprendi.
    autosave.stopAutosave();
    stateMod.doc.value = null;
    stateMod.resetHistory();
    autosave.startAutosave();
    await settle();
    expect(text(card.ResumeCard())).toContain("1 edit · just now");
    const resumedOne = {
      ok: true, ...docInfo(3), history: { editCount: 1, canUndo: true, canRedo: false, changedPages: [] }, applied: 1, failedAt: null,
    };
    engineImpl.resumeResult = resumedOne;
    await card.resumeDocument();
    expect(stateMod.dirty.value).toBe(true);
    await actions.undo();
    expect(stateMod.dirty.value).toBe(false); // the user has that file
    await settle(autosave.AUTOSAVE_DELAY_MS);
    expect(store.session).toBeNull(); // nothing to keep any more (and this page had resumed it: its own)

    // Made here from photos (its log says so): still not downloaded once its edits are undone, and
    // still kept (the engine exports it with no edits).
    await actions.closeDocument();
    await settle();
    store.session = keptSession({
      fileName: "Scansione.pdf", editCount: 1, neverDownloaded: true, log: { edits: [{ kind: "addText", n: 1 }], madeHere: true },
    });
    await card.refreshResume();
    engineImpl.resumeResult = resumedOne;
    await card.resumeDocument();
    expect(stateMod.doc.peek()?.fileName).toBe("Scansione.pdf");
    await actions.undo();
    expect(stateMod.dirty.value).toBe(true);
    await settle(autosave.AUTOSAVE_DELAY_MS);
    expect(store.session).toMatchObject({ fileName: "Scansione.pdf", editCount: 0, neverDownloaded: true });
    expect(store.session.log).toMatchObject({ madeHere: true });
  });

  it("P36: a kept document that cannot be read now: Riprendi says it failed and offers Dimentica, not \"no longer kept\"", async () => {
    store.session = keptSession();
    autosave.startAutosave();
    await settle();
    store.unreadable = true;
    await card.resumeDocument();
    expect(engineCalls("resumeSession")).toBe(0);
    expect(stateMod.doc.value).toBeNull();
    expect(stateMod.opening.value).toBeNull();
    const toast = stateMod.toasts.value.at(-1)!;
    expect(toast.kind).toBe("error");
    expect(toast.text).toBe("Couldn't resume “contratto.pdf”: its copy on this device can't be read right now. Try again, or forget it.");
    expect(toast.action?.label).toBe("Forget");
    expect(text(card.ResumeCard())).toContain("contratto.pdf"); // still offered: a retry may work
    // Read again later: it works.
    store.unreadable = false;
    stateMod.toasts.value = [];
    engineImpl.resumeResult = {
      ok: true, ...docInfo(4), history: { editCount: 3, canUndo: true, canRedo: false, changedPages: [] }, applied: 3, failedAt: null,
    };
    await card.resumeDocument();
    expect(stateMod.doc.value?.fileName).toBe("contratto.pdf");
  });

  it("P36: Dimentica from that toast forgets it (with its own Annulla); the same for the scan", async () => {
    store.session = keptSession();
    store.scan = keptScan({ kind: "new" }, 2);
    await card.refreshResume();
    store.unreadable = true;
    await card.resumeDocument();
    let toast = stateMod.toasts.value.at(-1)!;
    stateMod.dismissToast(toast.id); // as the toast's button does: dismissed, then its action
    toast.action!.run();
    expect(text(card.ResumeCard())).not.toContain("contratto.pdf");
    expect(stateMod.toasts.value.at(-1)?.text).toBe("“contratto.pdf” forgotten.");
    await settle(stateMod.TOAST_ACTION_MS + 100);
    expect(store.session).toBeNull();

    stateMod.toasts.value = [];
    await card.resumeScanAction();
    expect(g.__resumedScans).toHaveLength(0);
    toast = stateMod.toasts.value.at(-1)!;
    expect(toast).toMatchObject({ kind: "error", text: "Couldn't resume the scan: its copy on this device can't be read right now. Try again, or forget it." });
    expect(text(card.ResumeCard())).toContain("Unfinished scan (2 pages)");
    stateMod.dismissToast(toast.id);
    toast.action!.run();
    await settle(stateMod.TOAST_ACTION_MS + 100);
    expect(store.scan).toBeNull();
    expect(card.ResumeCard()).toBeNull();

    // Gone for real (the summary too): "no longer kept", as before.
    i18n.setLocale("it");
    stateMod.toasts.value = [];
    store.unreadable = false;
    store.session = keptSession();
    await card.refreshResume();
    store.session = null;
    await card.resumeDocument();
    expect(stateMod.toasts.value.at(-1)).toMatchObject({ kind: "error", text: "Non è più tenuto su questo dispositivo." });
    expect(stateMod.toasts.value.at(-1)?.action).toBeUndefined();
  });

  it("does nothing with a document open, and a file opened meanwhile takes over", async () => {
    store.session = keptSession();
    await card.refreshResume();
    await open("other.pdf");
    await card.resumeDocument();
    expect(engineCalls("resumeSession")).toBe(0);
    expect(stateMod.doc.value?.fileName).toBe("other.pdf");

    const closing = actions.closeDocument();
    await closing;
    engineImpl.resumeResult = resumed();
    const held = gate();
    engineImpl.resumeGate = held.promise;
    const run = card.resumeDocument();
    await vi.advanceTimersByTimeAsync(0);
    await actions.openFile(fakeFile("dropped.pdf"), { confirmed: true });
    held.open();
    await run;
    expect(stateMod.doc.value?.fileName).toBe("dropped.pdf");
  });

  it("Riprendi the scan opens its flow with the tray; after a document, a scan for one is offered", async () => {
    store.scan = keptScan({ kind: "new" }, 3);
    await card.refreshResume();
    await card.resumeScanAction();
    expect(g.__resumedScans).toHaveLength(1);
    expect(g.__resumedScans[0].pages).toHaveLength(3);
    expect(g.__resumedScans[0].target).toEqual({ kind: "new" });

    store.scan = null;
    await card.resumeScanAction();
    expect(stateMod.toasts.value.at(-1)).toMatchObject({ kind: "error", text: i18n.t("resume.scanGone") });
    expect(g.__resumedScans).toHaveLength(1);

    stateMod.toasts.value = [];
    store.session = keptSession({ view: null });
    store.scan = { ...keptScan({ kind: "insert", at: 1 }, 2), doc: { fileName: "contratto.pdf" } }; // for that document
    await card.refreshResume();
    engineImpl.resumeResult = resumed();
    await card.resumeDocument();
    const offer = stateMod.toasts.value.find((x) => x.action);
    expect(offer?.text).toBe("There's also an unfinished scan for this document (2 pages).");
    expect(offer?.action?.label).toBe("Resume the scan");
    offer!.action!.run();
    await settle();
    expect(g.__resumedScans).toHaveLength(2);
    expect(g.__resumedScans[1].target).toEqual({ kind: "insert", at: 1 });
  });
});

describe("R6 the card: Dimentica", () => {
  /** Press a toast's button as the toast does: dismissed first, then its action. */
  function pressToastButton(id: number) {
    const toast = stateMod.toasts.peek().find((x) => x.id === id)!;
    stateMod.dismissToast(id);
    toast.action!.run();
  }

  it("goes at once with Annulla in a toast; Annulla keeps it; forgotten for good when the toast goes", async () => {
    store.session = keptSession();
    store.scan = keptScan();
    await card.refreshResume();
    card.forgetKept("session");
    const tree = card.ResumeCard();
    expect(text(tree)).not.toContain("contratto.pdf");
    expect(text(tree)).toContain("Unfinished scan");
    const toast = stateMod.toasts.value.at(-1)!;
    expect(toast.text).toBe("“contratto.pdf” forgotten.");
    expect(toast.action?.label).toBe("Undo");
    expect(store.session).not.toBeNull();

    pressToastButton(toast.id);
    await settle();
    expect(text(card.ResumeCard())).toContain("contratto.pdf");
    expect(storeCalls("forgetSession")).toBe(0);
    expect(store.session).not.toBeNull();

    card.forgetKept("session");
    await settle(stateMod.TOAST_ACTION_MS + 100);
    expect(stateMod.toasts.value).toEqual([]);
    expect(store.session).toBeNull();
    expect(text(card.ResumeCard())).not.toContain("contratto.pdf");
    expect(card.forgetting.value.size).toBe(0);

    // The scan's toast closed with ✕: forgotten too.
    card.forgetKept("scan");
    expect(stateMod.toasts.value.at(-1)?.text).toBe("Scan forgotten.");
    stateMod.dismissToast(stateMod.toasts.value.at(-1)!.id);
    await settle();
    expect(store.scan).toBeNull();
    expect(card.ResumeCard()).toBeNull();
  });

  it("a page hidden or left carries it out at once", async () => {
    store.session = keptSession();
    autosave.startAutosave();
    await settle();
    card.forgetKept("session");
    expect(store.session).not.toBeNull();
    fire("window", "pagehide");
    await settle();
    expect(store.session).toBeNull();
    expect(stateMod.toasts.value).toEqual([]);
  });

  it("forgets exactly the record it was pressed for, whatever is open when its toast ends: a PDF opened just to read it meanwhile", async () => {
    // Kept by an earlier visit (another page load's): the autosave's own forgets leave it alone.
    store.session = keptSession({ fileName: "old.pdf" });
    autosave.startAutosave();
    await settle();
    card.forgetKept("session");
    await open("b.pdf"); // no edits: nothing of its own to keep
    await settle(autosave.AUTOSAVE_DELAY_MS);
    expect(store.session?.fileName).toBe("old.pdf"); // its toast still offers Annulla
    await settle(stateMod.TOAST_ACTION_MS);
    expect(stateMod.toasts.value.some((x) => x.action)).toBe(false);
    expect(store.session).toBeNull();
    await actions.closeDocument();
    await settle();
    expect(card.ResumeCard()).toBeNull();

    // Annulla pressed while that document is open: it stays.
    store.session = keptSession({ fileName: "old.pdf" });
    await card.refreshResume();
    card.forgetKept("session");
    await open("c.pdf");
    pressToastButton(stateMod.toasts.value.find((x) => x.action)!.id);
    await settle(stateMod.TOAST_ACTION_MS + autosave.AUTOSAVE_DELAY_MS);
    expect(store.session?.fileName).toBe("old.pdf");
  });

  it("the scan's: carried out as soon as a scan flow opens (under its modal the toast can't be used; the flow must not offer it back); the flow's own tray stays", async () => {
    store.scan = keptScan({ kind: "new" }, 2);
    autosave.startAutosave();
    await settle();
    card.forgetKept("scan");
    stateMod.scanFlow.value = { kind: "new" }; // "Scansiona un documento" within the toast
    await settle();
    expect(store.scan).toBeNull();
    expect(stateMod.toasts.value.some((x) => x.action)).toBe(false);
    // The flow keeps its own tray: the end of that Dimentica does not touch it.
    await storeMod.saveScan(keptScan({ kind: "new" }, 1) as any);
    stateMod.scanFlow.value = null;
    await settle(stateMod.TOAST_ACTION_MS);
    expect(store.scan?.pages).toHaveLength(1);
    expect(text(card.ResumeCard())).toContain("Unfinished scan (1 page)");
  });

  it("a newer save of either record since Dimentica stays (another tab's, say)", async () => {
    store.session = keptSession({ fileName: "old.pdf" });
    store.scan = keptScan({ kind: "new" }, 2);
    await card.refreshResume();
    card.forgetKept("session");
    card.forgetKept("scan");
    await storeMod.saveSession(keptSession({ fileName: "old.pdf", editCount: 4 }) as any); // saved again, elsewhere
    await storeMod.saveScan(keptScan({ kind: "new" }, 3) as any);
    await settle(stateMod.TOAST_ACTION_MS + 100);
    expect(stateMod.toasts.value).toEqual([]);
    expect(store.session).toMatchObject({ fileName: "old.pdf", editCount: 4 });
    expect(store.scan.pages).toHaveLength(3);
    expect(text(card.ResumeCard())).toContain("4 edits");
  });

  it("leaves alone what took its place meanwhile (a document opened and kept)", async () => {
    store.session = keptSession({ fileName: "old.pdf" });
    autosave.startAutosave();
    await settle();
    card.forgetKept("session");
    await open("b.pdf");
    edit(1);
    await settle(autosave.AUTOSAVE_DELAY_MS);
    expect(store.session?.fileName).toBe("b.pdf");
    await settle(stateMod.TOAST_ACTION_MS);
    expect(stateMod.toasts.value.some((x) => x.action)).toBe(false);
    expect(store.session?.fileName).toBe("b.pdf");
  });
});

describe("R7 the card follows what is kept (P28, P35)", () => {
  it("re-reads while the home page shows: a scan the scan flow forgets or keeps, a save or forget in another tab", async () => {
    store.scan = keptScan({ kind: "new" }, 2);
    autosave.startAutosave();
    await settle();
    expect(text(card.ResumeCard())).toContain("Unfinished scan (2 pages)");

    // Riprendi the scan: its flow opens over the home page; cancelled, it forgets the scan (flow.ts closeFlow).
    await card.resumeScanAction();
    stateMod.scanFlow.value = { kind: "new" };
    await storeMod.forgetScan();
    stateMod.scanFlow.value = null;
    await settle();
    expect(card.ResumeCard()).toBeNull();

    // A new scan: its first page kept (shown under the flow already), then forgotten at Fine.
    stateMod.scanFlow.value = { kind: "new" };
    await storeMod.saveScan(keptScan({ kind: "new" }, 1) as any);
    await settle();
    expect(text(card.ResumeCard())).toContain("Unfinished scan (1 page)");
    await storeMod.forgetScan();
    stateMod.scanFlow.value = null;
    await settle();
    expect(card.ResumeCard()).toBeNull();

    // Another tab keeps a document, then forgets it (the store tells this tab: resumeChanged).
    store.session = keptSession({ fileName: "other.pdf" });
    (storeMod.resumeChanged as any).value++;
    await settle();
    expect(text(card.ResumeCard())).toContain("other.pdf");
    store.session = null;
    (storeMod.resumeChanged as any).value++;
    await settle();
    expect(card.ResumeCard()).toBeNull();
  });

  it("does not read the card again while a document is open (it is read when the home page shows)", async () => {
    await startWith("a.pdf");
    const reads = storeCalls("sessionSummary");
    edit(1);
    await settle(autosave.AUTOSAVE_DELAY_MS);
    edit(2);
    await settle(autosave.AUTOSAVE_DELAY_MS);
    expect(storeCalls("saveSession")).toBe(2);
    expect(storeCalls("sessionSummary")).toBe(reads);
  });
});

// ---------------------------------------------------------------------------------------------
// Fix round 3: an unfinished scan and the document its pages are for, with the real scan flow
// (ui/scan/flow.ts: no worker is needed, the tray comes from what is kept), the real page actions
// and this file's fake engine.

describe("R8 fix round 3: the scan and its document", () => {
  let flowMod: typeof import("../src/ui/scan/flow");
  let pageActions: typeof import("../src/ui/pageActions");
  beforeAll(async () => {
    flowMod = await import("../src/ui/scan/flow");
    pageActions = await import("../src/ui/pageActions");
  });
  afterEach(() => {
    stateMod.scanFlow.value = null;
    flowMod.flowClosed(); // as ScanFlow's unmount does
  });

  const resumedA = () => ({
    ok: true, ...docInfo(4), history: { editCount: 3, canUndo: true, canRedo: false, changedPages: [] },
    applied: 3, failedAt: null,
  });
  /** A scan kept for `fileName` (its pages to add to it at `at`). */
  const scanFor = (fileName: string, at: number, pages = 1) => ({ ...keptScan({ kind: "insert", at }, pages), doc: { fileName } });
  /** Let the promises and due timers run without waiting for a save in flight (one may be held). */
  async function turn() {
    for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(0);
  }
  const scanOffered = () => stateMod.toasts.value.some((x) => x.action?.label === i18n.t("resume.resumeScan"));

  it("Riprendi A with a scan kept for B: no scan offered into A, and resumed anyway it waits for B (the orphan case)", async () => {
    store.session = keptSession({ fileName: "A.pdf", view: null });
    store.scan = scanFor("B.pdf", 3);
    await card.refreshResume();
    const shown = text(card.ResumeCard());
    engineImpl.resumeResult = resumedA();
    await card.resumeDocument();
    expect(stateMod.doc.value?.fileName).toBe("A.pdf");
    expect(scanOffered()).toBe(false);
    expect(shown).toContain("For “B.pdf”"); // the card said which document the scan is for

    // Reached another way (the scan's own Riprendi, a new opening's Continua): B's pages are not A's.
    flowMod.resumeTray(structuredClone(store.scan));
    const target = stateMod.scanFlow.value!;
    expect(flowMod.waitsForDocument(target)).toBe(true);
    expect(flowMod.targetNow(target)).toEqual({ kind: "new" });
    expect(flowMod.orphanOffer(target)).toBe("later");
    expect(await flowMod.keepForLater()).toBe(true);
    expect(engineCalls("editPages")).toBe(0);
    expect(store.scan).toMatchObject({ target: { kind: "insert", at: 3 }, doc: { fileName: "B.pdf" } });
  });

  it("Riprendi A with a scan kept for A: offered, and it goes into A", async () => {
    store.session = keptSession({ fileName: "A.pdf", view: null });
    store.scan = scanFor("A.pdf", 3, 2);
    await card.refreshResume();
    engineImpl.resumeResult = resumedA();
    await card.resumeDocument();
    expect(scanOffered()).toBe(true);
    stateMod.toasts.value.find((x) => x.action)!.action!.run();
    await settle();
    flowMod.resumeTray(g.__resumedScans.at(-1)); // what resumeScan (ScanFlow.tsx) does
    const target = stateMod.scanFlow.value!;
    expect(flowMod.waitsForDocument(target)).toBe(false);
    expect(flowMod.targetNow(target)).toEqual({ kind: "insert", at: 3 });
    expect(await flowMod.finishScan()).toBe(true);
    expect(engineImpl.edits.at(-1)).toMatchObject({ kind: "pictures", at: 3 });
    expect(stateMod.doc.value?.pages).toHaveLength(6);
  });

  it("the place follows a page operation that lands while the flow is open: a delete held, the scan opened at 4, Fine after", async () => {
    engineImpl.pages = 6;
    await startWith("six.pdf");
    const keys = stateMod.doc.peek()!.pages.map((p) => p.key);
    const held = gate();
    engineImpl.editGate = held.promise;
    const deleting = pageActions.deletePagesAction([0, 1]); // on its way (behind a download, say)
    await turn();
    expect(engineImpl.edits).toHaveLength(1);
    stateMod.scanFlow.value = { kind: "insert", at: 4 }; // the "+" between pages 4 and 5 > "Foto o scansione" (insertScanAt)
    engineImpl.editGate = null;
    held.open();
    await deleting;
    await settle();
    expect(stateMod.doc.peek()!.pages.map((p) => p.key)).toEqual(keys.slice(2));
    flowMod.flowOpened();
    await settle();
    expect(flowMod.targetNow(stateMod.scanFlow.value!)).toEqual({ kind: "insert", at: 2 }); // still before old page 5
    flowMod.tray.value = [flowMod.trayPage({ bytes: new ArrayBuffer(8), width: 1654, height: 2339, dpi: 200 }, new ArrayBuffer(2))];
    flowMod.phase.value = { step: "tray", finishing: false };
    expect(await flowMod.finishScan()).toBe(true);
    expect(engineImpl.edits.at(-1)).toMatchObject({ kind: "pictures", at: 2 });
    const now = stateMod.doc.peek()!.pages.map((p) => p.key);
    expect(now).toHaveLength(5);
    expect([now[1], now[3]]).toEqual([keys[3], keys[4]]); // between the same two pages
    expect(keys).not.toContain(now[2]);
  });

  it("Done forgets the kept scan only once the document holding its pages has been kept", async () => {
    await startWith("a.pdf");
    store.scan = scanFor("a.pdf", 1);
    const kept = store.scan;
    flowMod.resumeTray(structuredClone(store.scan));
    const held = gate();
    store.saveGate = held.promise;
    const done = flowMod.finishScan();
    await turn();
    expect(stateMod.scanFlow.value).toBeNull(); // the flow closed at once
    expect(engineCalls("editPages")).toBe(1);
    expect(storeCalls("saveSession")).toBe(1); // the autosave was asked at once, not a second later
    expect(store.scan).toBe(kept); // the device still has the pages (not saved again as its pages landed)
    expect(storeCalls("forgetScan")).toBe(0);
    held.open();
    store.saveGate = null;
    expect(await done).toBe(true);
    await settle();
    expect(store.session).toMatchObject({ fileName: "a.pdf", editCount: 1, pageCount: 4 });
    expect(store.scan).toBeNull();
    expect(store.calls.indexOf("forgetScan")).toBeGreaterThan(store.calls.findIndex((c) => c.startsWith("saveSession")));
  });

  it("keepOpenDocument: answered by a save that starts after it is asked, at once (no delay); false when nothing will be kept", async () => {
    expect(await autosave.keepOpenDocument()).toBe(false); // the autosave not started
    await startWith("a.pdf");
    expect(await autosave.keepOpenDocument()).toBe(false); // a file from the device with no edits: nothing to keep
    edit(1);
    await vi.advanceTimersByTimeAsync(autosave.AUTOSAVE_DELAY_MS);
    const held = gate();
    store.saveGate = held.promise;
    edit(2);
    await turn();
    expect(storeCalls("saveSession")).toBe(1); // the save of edit 1 is being written (held)
    let answered: boolean | null = null;
    void autosave.keepOpenDocument().then((ok) => { answered = ok; });
    store.saveGate = null;
    held.open();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    // The save in flight had exported before edit 2: the answer waits for the next one, which runs at once.
    await turn();
    expect(storeCalls("saveSession")).toBe(2);
    expect(answered).toBe(true);
    expect(store.session).toMatchObject({ editCount: 2 });

    // Waiting for the engine (busy) when the document goes: answered false.
    stateMod.busy.value = "edit";
    edit(3);
    const asked = autosave.keepOpenDocument();
    await turn();
    expect(storeCalls("saveSession")).toBe(2); // it waits for the engine
    const closing = actions.closeDocument();
    await turn();
    answer(true); // its edits are not downloaded
    await closing;
    expect(await asked).toBe(false);
    stateMod.busy.value = null;
    await settle();
    expect(storeCalls("saveSession")).toBe(2);
  });

  it("Done with a new PDF: the scan is forgotten once that PDF is kept; a save the store refuses keeps the scan", async () => {
    autosave.startAutosave();
    await settle();
    store.scan = keptScan({ kind: "new" }, 2);
    flowMod.resumeTray(structuredClone(store.scan));
    const held = gate();
    store.saveGate = held.promise;
    const done = flowMod.finishScan();
    await turn();
    expect(engineCalls("newFromPictures")).toBe(1);
    expect(storeCalls("saveSession")).toBe(1);
    expect(store.scan).not.toBeNull();
    held.open();
    store.saveGate = null;
    expect(await done).toBe(true);
    await settle();
    expect(store.session).toMatchObject({ editCount: 0, pageCount: 2, neverDownloaded: true });
    expect(store.scan).toBeNull();

    // Refused (a full store): the document's save was tried and did not happen, so what the device
    // keeps may lack the scanned pages: the scan stays (offered again at worst, never lost).
    stateMod.scanFlow.value = null;
    flowMod.flowClosed();
    store.scan = scanFor(stateMod.doc.peek()!.fileName, 0);
    flowMod.resumeTray(structuredClone(store.scan));
    store.refuse = 2;
    expect(await flowMod.finishScan()).toBe(true);
    await settle();
    expect(store.scan).not.toBeNull();
  });
});
