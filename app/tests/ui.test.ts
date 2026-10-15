// UI logic against the app's real modules with a fake engine (no browser): overlapping opens,
// text still in the line editor, no-op edits, saves finishing late, download re-entry, render
// scale caps, engine error codes, edited-page marks, closing a document, leaving edit mode and
// the service-worker update flow.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, describe, expect, it, vi } from "vitest";
import "./stubs/browser-globals";

vi.mock("../src/engine/client.ts", () => {
  class EngineError extends Error {
    constructor(message: string, readonly code?: string) {
      super(message);
    }
  }
  const e = () => (globalThis as any).__engine;
  class EngineClient {
    ready = Promise.resolve();
    open(bytes: ArrayBuffer, password?: string) { return e().open(bytes, password); }
    lines() { return Promise.resolve([]); }
    replaceLine(p: number, l: number, text: string) { return e().replaceLine(p, l, text); }
    undo() { return e().undo(); }
    redo() { return e().redo(); }
    save() { return e().save(); }
    close() { return e().close(); }
  }
  return { EngineError, EngineClient };
});

const calls: string[] = [];
const edited = (changedPages: number[]) => ({
  editCount: 1, canUndo: true, canRedo: false, changedPages,
  pageIndex: 0, before: "old", after: "new", segments: [], fallbackChars: [], missingChars: [],
});
const engineImpl: any = {
  open: async (bytes: ArrayBuffer) => {
    calls.push("open:" + new TextDecoder().decode(bytes));
    return { ok: true, pageCount: 1, pages: [{ index: 0, bounds: [0, 0, 100, 100] }], encrypted: false, title: null };
  },
  replaceLine: async () => { calls.push("replaceLine"); return edited([0]); },
  undo: async () => { calls.push("undo"); return { editCount: 0, canUndo: false, canRedo: true, changedPages: [0] }; },
  redo: async () => { calls.push("redo"); return { editCount: 1, canUndo: true, canRedo: false, changedPages: [0] }; },
  save: async () => { calls.push("save"); return { bytes: new ArrayBuffer(4) }; },
  close: async () => { calls.push("close"); return null; },
};
(globalThis as any).__engine = engineImpl;

function fakeFile(name: string, content: string, ready: Promise<void> = Promise.resolve()): File {
  return {
    name,
    type: "application/pdf",
    arrayBuffer: async () => {
      await ready;
      return new TextEncoder().encode(content).buffer;
    },
  } as unknown as File;
}

const LINE = {
  index: 0, text: "old", bbox: [0, 0, 10, 10], size: 10, fontName: "Helvetica", bold: false, italic: false,
  serif: false, mono: false, color: [0, 0, 0], vertical: false, dir: [1, 0], editable: true,
} as any;

let state: typeof import("../src/state");
let actions: typeof import("../src/ui/actions");

beforeAll(async () => {
  state = await import("../src/state");
  actions = await import("../src/ui/actions");
});

async function answerConfirm(ok: boolean) {
  await vi.waitFor(() => expect(state.dialog.value?.kind).toBe("confirm"));
  const d = state.dialog.value as any;
  state.dialog.value = null;
  d.resolve(ok);
}

describe("U1 overlapping opens", () => {
  it("a slow first file is never sent to the engine after a later one", async () => {
    let releaseA!: () => void, releaseB!: () => void;
    const a = fakeFile("A.pdf", "A", new Promise((r) => { releaseA = r; }));
    const b = fakeFile("B.pdf", "B", new Promise((r) => { releaseB = r; }));
    calls.length = 0;
    const pa = actions.openFile(a, { confirmed: true });
    const pb = actions.openFile(b, { confirmed: true });
    releaseB();
    await pb;
    releaseA();
    await pa;
    expect(calls).toEqual(["open:B"]);
    expect(state.doc.value?.fileName).toBe("B.pdf");
  });

  it("a launch with several files opens only the last readable PDF", async () => {
    let consumer!: (p: { files: unknown[] }) => void;
    (globalThis as any).launchQueue = { setConsumer: (c: typeof consumer) => { consumer = c; } };
    const { onLaunchFiles } = await import("../src/platform/launch");
    const got: string[] = [];
    onLaunchFiles((f) => got.push(f.name));
    const h = (name: string, type: string, fail = false) => ({
      kind: "file",
      getFile: async () => { if (fail) throw new Error("gone"); return { name, type }; },
    });
    consumer({ files: [h("one.pdf", "application/pdf"), h("two.pdf", ""), h("notes.txt", "text/plain"), h("gone.pdf", "application/pdf", true)] });
    await new Promise((r) => setTimeout(r, 10));
    expect(got).toEqual(["two.pdf"]);
  });
});

describe("U2 text still in the line editor", () => {
  it("counts as unsaved, and download writes it before saving", async () => {
    await actions.openFile(fakeFile("C.pdf", "C"), { confirmed: true });
    const page = state.doc.value!.pages[0];
    const typed = "new";
    const unregister = state.registerEditor({
      changed: () => typed.trim() !== LINE.text,
      commit: () => actions.replaceLine(page, LINE, typed, page.rev.peek()),
    });
    expect(state.dirty.value).toBe(false);
    expect(state.hasUnsavedWork()).toBe(true);
    expect(actions.shouldWarnBeforeUnload()).toBe(true);
    calls.length = 0;
    await actions.download();
    unregister();
    expect(calls).toEqual(["replaceLine", "save"]);
    expect(state.dirty.value).toBe(false); // the saved state includes the edit
  });

  it("opening another file first writes it, then asks", async () => {
    const page = state.doc.value!.pages[0];
    const unregister = state.registerEditor({
      changed: () => true,
      commit: () => actions.replaceLine(page, LINE, "newer", page.rev.peek()),
    });
    calls.length = 0;
    const p = actions.openFile(fakeFile("D.pdf", "D"));
    await answerConfirm(false);
    await p;
    unregister();
    expect(calls).toEqual(["replaceLine"]);
    expect(state.doc.value?.fileName).toBe("C.pdf");
    expect(state.dirty.value).toBe(true);
  });
});

describe("U3 no-op edits", () => {
  it("an edit that changed no page is not recorded and keeps redo", () => {
    state.resetHistory();
    state.recordHistory({ editCount: 1, canUndo: true, canRedo: false, changedPages: [0] }, "edit");
    state.markSaved(state.saveKey());
    expect(state.dirty.value).toBe(false);
    state.recordHistory({ editCount: 0, canUndo: false, canRedo: true, changedPages: [0] }, "undo");
    expect(state.dirty.value).toBe(true);
    state.recordHistory({ editCount: 0, canUndo: false, canRedo: true, changedPages: [] }, "edit");
    expect(state.history.value.canRedo).toBe(true);
    state.recordHistory({ editCount: 1, canUndo: true, canRedo: false, changedPages: [0] }, "redo");
    expect(state.dirty.value).toBe(false);
  });
});

describe("U4 save finishing after another open", () => {
  it("does not touch the new document's saved state", async () => {
    state.recordHistory({ editCount: 2, canUndo: true, canRedo: false, changedPages: [0] }, "edit");
    const oldKey = state.saveKey();
    await actions.openFile(fakeFile("E.pdf", "E"), { confirmed: true });
    expect(state.dirty.value).toBe(false);
    state.markSaved(oldKey);
    expect(state.dirty.value).toBe(false);
  });
});

describe("U5 download re-entry", () => {
  it("ignores a second call while the picker is open; NotAllowedError is not a plain download", async () => {
    const created = (globalThis as any).__created as { tag: string }[];
    let rejectPicker!: (e: unknown) => void;
    let pickerCalls = 0;
    (globalThis as any).showSaveFilePicker = () => {
      pickerCalls++;
      return new Promise((_, rej) => { rejectPicker = rej; });
    };
    created.length = 0;
    calls.length = 0;
    const first = actions.download();
    await actions.download();
    expect(pickerCalls).toBe(1);
    rejectPicker(new DOMException("A file picker is already showing", "NotAllowedError"));
    await first;
    expect(created.filter((e) => e.tag === "a")).toHaveLength(0);
    expect(calls).not.toContain("save");

    (globalThis as any).showSaveFilePicker = () => Promise.reject(new DOMException("No user gesture", "SecurityError"));
    await actions.download();
    expect(created.filter((e) => e.tag === "a")).toHaveLength(1);
    expect(calls).toContain("save");
    delete (globalThis as any).showSaveFilePicker;
  });
});

describe("U7 render scale", () => {
  it("caps each side of the bitmap, not only its area", async () => {
    const { renderScale } = await import("../src/viewer/PageView");
    const tall = { width: 100, height: 20000 } as any;
    const s = renderScale(tall, 4, 2);
    expect(Math.ceil(tall.height * s) + 2).toBeLessThanOrEqual(32767);
    expect(tall.width * s * tall.height * s).toBeLessThanOrEqual(16_000_000);
    expect(renderScale({ width: 612, height: 792 } as any, 1, 2)).toBe(2);
    expect(renderScale({ width: 1e9, height: 1 } as any, 1, 1)).toBeGreaterThan(0);
  });
});

describe("U8 engine error codes", () => {
  it("not-editable shows the toast; broken stops editing", async () => {
    const { EngineError } = await import("../src/engine/client");
    const page = state.doc.value!.pages[0];
    engineImpl.replaceLine = async () => { throw new EngineError("BMP", "not-editable"); };
    await actions.replaceLine(page, LINE, "x", page.rev.peek());
    expect(state.toasts.value.map((t) => t.text)).toContain("This line contains characters that can't be edited yet.");
    expect(state.editingStopped.value).toBe(false);

    engineImpl.replaceLine = async () => { throw new EngineError("lost", "broken"); };
    state.editMode.value = true;
    await actions.replaceLine(page, LINE, "x", page.rev.peek());
    expect(state.editingStopped.value).toBe(true);
    expect(state.editMode.value).toBe(false);
    expect(state.dialog.value).toMatchObject({ kind: "alert", title: "Editing stopped" });

    state.recordHistory({ editCount: 1, canUndo: true, canRedo: false, changedPages: [0] }, "edit");
    calls.length = 0;
    await actions.undo();
    expect(calls).not.toContain("undo");

    state.dialog.value = null;
    await actions.openFile(fakeFile("F.pdf", "F"), { confirmed: true });
    expect(state.editingStopped.value).toBe(false);
    engineImpl.replaceLine = async () => { calls.push("replaceLine"); return edited([0]); };
  });

  it("a no-op edit from the engine leaves the document clean", async () => {
    engineImpl.replaceLine = async () => edited([]);
    const page = state.doc.value!.pages[0];
    await actions.replaceLine(page, LINE, "old ", page.rev.peek());
    expect(state.dirty.value).toBe(false);
  });
});

describe("U9 edited pages", () => {
  it("follow undo and redo, and forget an undone edit replaced by a new one", () => {
    const step = (pages: number[], kind: "edit" | "undo" | "redo") =>
      state.recordHistory({ editCount: 0, canUndo: true, canRedo: kind === "undo", changedPages: pages }, kind);
    state.resetHistory();
    step([2], "edit");
    step([0], "edit");
    expect([...state.editedPages.value].sort()).toEqual([0, 2]);
    step([0], "undo");
    expect([...state.editedPages.value]).toEqual([2]);
    step([0], "redo");
    expect([...state.editedPages.value].sort()).toEqual([0, 2]);
    step([0], "undo");
    step([1], "edit"); // the undone edit of page 0 can no longer come back
    step([], "redo");
    expect([...state.editedPages.value].sort()).toEqual([1, 2]);
    state.resetHistory();
    expect(state.editedPages.value.size).toBe(0);
  });
});

describe("U10 closing a document", () => {
  it("asks when edits are not downloaded, then resets everything and frees the engine", async () => {
    await actions.openFile(fakeFile("G.pdf", "G"), { confirmed: true });
    state.recordHistory({ editCount: 1, canUndo: true, canRedo: false, changedPages: [0] }, "edit");
    state.editMode.value = true;
    state.sheet.value = "more";

    let p = actions.closeDocument();
    await answerConfirm(false);
    await p;
    expect(state.doc.value?.fileName).toBe("G.pdf");

    calls.length = 0;
    p = actions.closeDocument();
    await answerConfirm(true);
    await p;
    expect(state.doc.value).toBeNull();
    expect(state.editMode.value).toBe(false);
    expect(state.sheet.value).toBeNull();
    expect(state.dirty.value).toBe(false);
    expect(state.history.value.canUndo).toBe(false);
    expect(calls).toEqual(["close"]);
  });

  it("abandons an open still being read", async () => {
    let release!: () => void;
    const h = fakeFile("H.pdf", "H", new Promise((r) => { release = r; }));
    calls.length = 0;
    const p = actions.openFile(h, { confirmed: true });
    await vi.waitFor(() => expect(state.opening.value).toBe("H.pdf"));
    await actions.closeDocument();
    expect(state.opening.value).toBeNull();
    release();
    await p;
    expect(state.doc.value).toBeNull();
    expect(calls).toEqual([]); // nothing reached the engine: no document was open either
  });
});

describe("U11 leaving edit mode", () => {
  it("writes the text still in the line editor first", async () => {
    engineImpl.replaceLine = async () => { calls.push("replaceLine"); return edited([0]); };
    await actions.openFile(fakeFile("I.pdf", "I"), { confirmed: true });
    const page = state.doc.value!.pages[0];
    await actions.setEditMode(true);
    expect(state.editMode.value).toBe(true);
    const unregister = state.registerEditor({
      changed: () => true,
      commit: () => actions.replaceLine(page, LINE, "typed", page.rev.peek()),
    });
    calls.length = 0;
    await actions.setEditMode(false);
    unregister();
    expect(calls).toEqual(["replaceLine"]);
    expect(state.editMode.value).toBe(false);
    expect(state.dirty.value).toBe(true);
  });
});

describe("P1/P2 service worker update", () => {
  it("only the window that asked reloads; Update with nothing waiting reloads; leaving resets", async () => {
    Object.defineProperty(navigator, "serviceWorker", { value: { controller: {} }, configurable: true });
    const reload = vi.fn();
    (globalThis as any).location = { reload };
    const pwa = await import("../src/platform/pwa");
    const stub = await import("./stubs/pwa-register");
    pwa.registerPwa();
    const opts = stub.captured.options!;
    expect(typeof opts.onNeedReload).toBe("function");

    // Another window updated: this one keeps running.
    opts.onNeedRefresh();
    opts.onNeedReload();
    expect(reload).not.toHaveBeenCalled();
    expect(pwa.updateInstalled.value).toBe(true);

    // Nothing waiting any more: Update is a plain reload.
    opts.onRegisteredSW("sw.js", { waiting: null } as any);
    pwa.applyUpdate();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(stub.captured.updateCalls).toBe(0);

    // Something waiting: skip waiting, and reload when it takes over.
    opts.onRegisteredSW("sw.js", { waiting: { state: "installed", addEventListener: vi.fn() } } as any);
    pwa.applyUpdate();
    expect(stub.captured.updateCalls).toBe(1);
    expect(reload).toHaveBeenCalledTimes(1);
    opts.onNeedReload();
    expect(reload).toHaveBeenCalledTimes(2);

    // updateApp: no warning right after confirming, and the warning comes back if no reload.
    vi.useFakeTimers();
    state.recordHistory({ editCount: 1, canUndo: true, canRedo: false, changedPages: [0] }, "edit");
    expect(actions.shouldWarnBeforeUnload()).toBe(true);
    const p = actions.updateApp();
    await answerConfirm(true);
    await p;
    expect(actions.shouldWarnBeforeUnload()).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(actions.shouldWarnBeforeUnload()).toBe(true);
    vi.useRealTimers();
  });
});
