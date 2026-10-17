// UI logic against the app's real modules with a fake engine (no browser): overlapping opens,
// text still in the line editor, no-op edits, saves finishing late, download re-entry, render
// scale caps, engine error codes, edited-page marks, closing a document, leaving edit mode, the
// service-worker update flow, and the downloads of phase 3 (one tap keeping PDF/A and passwords,
// the PDF/A check and questions, the download options' rules and messages, the PDF/A texts, the
// details panel's protection row), the images of release 2 (selection, edits, replacement,
// Escape, the details panel's image facts), and the fill and sign of release 3 (the tools, the
// text writer, marks and dates, form fields, the empty required fields at download, signatures,
// initials on every page, pictures, saved signatures, Escape and undo), and the fixes after its
// review (a picture landing while the writer is open, a text reopened while a change is on its
// way, new texts kept on the page, what keeping or forgetting a signature really did, failed
// placements, "Put it in the middle", "Next empty field", the focus asked for, Enter on the page),
// and the small fixes after the owner's test (Modifica's sub-tools Cambia, Aggiungi testo and
// Aggiungi immagine, with their Escape and Enter and where the focus goes when they swap the
// layers; no empty file left where a save failed), and the decorations that follow an edited line
// (the line editor's background option and what it sends, the toasts that say what followed the
// text and what stayed, the details panel's rows; after its review, plurals of one kind, and where
// the option goes in the bar so that it is never cut and Cancel and Apply never move).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from "node:fs";
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
    replaceLine(p: number, l: number, text: string, options?: unknown) { return e().replaceLine(p, l, text, options); }
    lineDecorations(p: number, l: number) { return e().lineDecorations(p, l); }
    images(p: number) { return e().images(p); }
    transformImage(p: number, i: number, matrix: number[]) { return e().transformImage(p, i, matrix); }
    deleteImage(p: number, i: number) { return e().deleteImage(p, i); }
    replaceImage(p: number, i: number, bytes: ArrayBuffer) { return e().replaceImage(p, i, bytes); }
    renderImage() { return Promise.reject(new Error("no bitmaps in Node")); }
    fields(p: number) { return e().fields(p); }
    setField(name: string, value: unknown) { return e().setField(name, value); }
    addText(p: number, origin: number[], text: string, style: unknown) { return e().addText(p, origin, text, style); }
    addedTexts(p: number) { return e().addedTexts(p); }
    editAddedText(p: number, id: number, patch: unknown) { return e().editAddedText(p, id, patch); }
    addImage(bytes: ArrayBuffer, targets: unknown[], alt: string | null) { return e().addImage(bytes, targets, alt); }
    undo() { return e().undo(); }
    redo() { return e().redo(); }
    save(options: unknown) { return e().save(options); }
    pdfaCheck() { return e().pdfaCheck(); }
    close() { return e().close(); }
  }
  return { EngineError, EngineClient };
});

// The picture prepared for a replacement: decoding needs a browser, so the test says what it gives.
vi.mock("../src/ui/imageFile.ts", () => {
  class PictureError extends Error {
    constructor(message: string, readonly code: "too-big" | "unreadable") {
      super(message);
    }
  }
  return {
    MAX_PICTURE_SIDE: 2000,
    MAX_PICTURE_FILE: 50 * 1024 * 1024,
    PictureError,
    fitWithin: () => ({ width: 1, height: 1 }),
    hasTransparency: () => false,
    preparePicture: (file: File) => (globalThis as any).__prepare(file),
  };
});

// The signatures kept on the device: IndexedDB is not in Node, so a store in memory, which a test
// can make refuse (`__storeRefuses`, as a private window or a storage that stops answering would),
// and which keeps at most 5, as the real one.
vi.mock("../src/ui/fill/signatureStore.ts", () => {
  const g = globalThis as any;
  const stored = new Map<string, any>();
  g.__stored = stored;
  return {
    MAX_SAVED: 5,
    available: async () => !g.__storeRefuses,
    list: async () => (g.__storeRefuses ? [] : [...stored.values()]),
    save: async (sig: any) => {
      if (g.__storeRefuses || (stored.size >= 5 && !stored.has(sig.id))) return null;
      stored.set(sig.id, sig);
      return sig;
    },
    forget: async (id: string) => {
      if (g.__storeRefuses) return false;
      stored.delete(id);
      return true;
    },
  };
});

const calls: string[] = [];
/** The options of every save, in order. */
const saves: unknown[] = [];
/** DocInfo fields the next open returns on top of a plain one-page PDF. */
let nextInfo: Record<string, unknown> = {};
/** What the next pdfaCheck returns. */
let pdfaReport: any = { blockers: [], removals: [], warnings: [], fixes: 0 };
const edited = (changedPages: number[]) => ({
  editCount: 1, canUndo: true, canRedo: false, changedPages,
  pageIndex: 0, before: "old", after: "new", segments: [], fallbackChars: [], missingChars: [],
});
/** An image edit's result: the edited image's new index (null after a delete). */
const imageEdited = (imageIndex: number | null, changedPages = [0]) => ({
  editCount: 1, canUndo: true, canRedo: false, changedPages, pageIndex: 0, imageIndex,
});
/** The bytes each replaceImage call received, in order. */
const replacedBytes: ArrayBuffer[] = [];
const engineImpl: any = {
  open: async (bytes: ArrayBuffer) => {
    calls.push("open:" + new TextDecoder().decode(bytes));
    return {
      ok: true, pageCount: 1, pages: [{ index: 0, bounds: [0, 0, 100, 100] }], encrypted: false,
      needsPassword: false, canKeepPassword: false, pdfa: null, signatures: 0, title: null, ...nextInfo,
    };
  },
  replaceLine: async () => { calls.push("replaceLine"); return edited([0]); },
  // Asked by the line editor as it opens, beside the edits: not in `calls`, which the edits' tests read.
  lineDecorations: async () => ({ underlines: 0, strikes: 0, links: 0, box: null, left: [] }),
  transformImage: async (_p: number, i: number) => { calls.push(`transformImage:${i}`); return imageEdited(i); },
  deleteImage: async (_p: number, i: number) => { calls.push(`deleteImage:${i}`); return imageEdited(null); },
  replaceImage: async (_p: number, i: number, bytes: ArrayBuffer) => {
    calls.push(`replaceImage:${i}`);
    replacedBytes.push(bytes);
    return imageEdited(i);
  },
  undo: async () => { calls.push("undo"); return { editCount: 0, canUndo: false, canRedo: true, changedPages: [0] }; },
  redo: async () => { calls.push("redo"); return { editCount: 1, canUndo: true, canRedo: false, changedPages: [0] }; },
  save: async (options: any) => {
    calls.push("save");
    saves.push(options);
    return { bytes: new ArrayBuffer(4), pdfa: options?.format === "pdfa-2b" ? pdfaReport : null };
  },
  pdfaCheck: async () => { calls.push("pdfaCheck"); return pdfaReport; },
  close: async () => { calls.push("close"); return null; },
  images: async () => [],
  fields: async () => [],
  setField: async (name: string, value: unknown) => {
    calls.push(`setField:${name}`);
    sent.push(value);
    return { editCount: 1, canUndo: true, canRedo: false, changedPages: [0], name, missingChars: [], overflow: false };
  },
  addText: async (p: number, origin: number[], text: string, style: unknown) => {
    calls.push(`addText:${p}:${text}`);
    sent.push({ origin, text, style });
    return { editCount: 1, canUndo: true, canRedo: false, changedPages: [p], pageIndex: p, id: 100 + sent.length, missingChars: [] };
  },
  addedTexts: async () => [],
  editAddedText: async (p: number, id: number, patch: { text?: string }) => {
    calls.push(`editAddedText:${id}`);
    sent.push(patch);
    return {
      editCount: 1, canUndo: true, canRedo: false, changedPages: [p], pageIndex: p,
      id: patch.text === "" ? null : id, missingChars: [],
    };
  },
  addImage: async (bytes: ArrayBuffer, targets: { pageIndex: number }[], alt: string | null) => {
    calls.push(`addImage:${targets.map((x) => x.pageIndex).join(",")}`);
    sent.push({ bytes, targets, alt });
    return {
      editCount: 1, canUndo: true, canRedo: false, changedPages: [...new Set(targets.map((x) => x.pageIndex))],
      placed: targets.map((x) => ({ pageIndex: x.pageIndex, imageIndex: 5 })),
    };
  },
};
/** What the fill-and-sign calls of the fake engine received (values, texts, patches, pictures), in order. */
const sent: any[] = [];
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
    state.tool.value = "edit";
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
    state.tool.value = "edit";
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

// ---------------------------------------------------------------------------------------------
// Phase 3, release 1: downloads keep PDF/A and passwords

/** A save dialog that always succeeds; returns the names it was asked for. */
function fakePicker(): string[] {
  const names: string[] = [];
  (globalThis as any).showSaveFilePicker = async (opts: { suggestedName: string }) => {
    names.push(opts.suggestedName);
    return { name: opts.suggestedName, createWritable: async () => ({ write: async () => undefined, close: async () => undefined }) };
  };
  return names;
}

async function openWith(name: string, info: Record<string, unknown>) {
  nextInfo = info;
  await actions.openFile(fakeFile(name, name), { confirmed: true });
  nextInfo = {};
  calls.length = 0;
  saves.length = 0;
}

/** Wait for the dialog `kind`, answer it, and return it. */
async function answerDialog(kind: string, yes: boolean) {
  await vi.waitFor(() => expect(state.dialog.value?.kind).toBe(kind));
  const d = state.dialog.value as any;
  state.dialog.value = null;
  d.resolve(yes);
  return d;
}

const toastTexts = () => state.toasts.value.map((x) => x.text);
const CLEAN = { blockers: [], removals: [], warnings: [], fixes: 4 };
const NO_PASSWORD = { mode: "none" };

let options: typeof import("../src/ui/DownloadOptions");
beforeAll(async () => {
  options = await import("../src/ui/DownloadOptions");
});

describe("U12 one-tap download keeps what the file is", () => {
  it("a PDF/A source is checked first, then saved as PDF/A without a password, named -PDFA", async () => {
    const names = fakePicker();
    await openWith("K.pdf", { pdfa: "2B" });
    const page = state.doc.value!.pages[0];
    await actions.replaceLine(page, LINE, "new", page.rev.peek()); // edits, so "saved" can be seen
    calls.length = 0;
    expect(state.dirty.value).toBe(true);
    // Only a replaced colour setting and blend mode: nothing to ask.
    pdfaReport = { ...CLEAN, warnings: [{ code: "output-intent-replaced" }, { code: "blend-mode", count: 2 }] };
    // What is on screen while the check runs: its status, and the busy state.
    const seen: { texts?: string[]; busy?: unknown; running?: boolean } = {};
    const check = engineImpl.pdfaCheck;
    engineImpl.pdfaCheck = async () => {
      seen.texts = toastTexts();
      seen.busy = state.busy.peek();
      seen.running = state.downloadRunning.peek();
      return check();
    };
    try {
      await actions.download();
    } finally {
      engineImpl.pdfaCheck = check;
    }
    expect(seen).toEqual({ texts: expect.arrayContaining(["Checking the PDF/A…"]), busy: "check", running: true });
    expect(calls).toEqual(["pdfaCheck", "save"]);
    expect(saves).toEqual([{ format: "pdfa-2b", password: NO_PASSWORD }]);
    expect(names).toEqual(["K-edited-PDFA.pdf"]);
    expect(state.dialog.value).toBeNull();
    expect(toastTexts()).toContain("Downloaded “K-edited-PDFA.pdf” as PDF/A: the app's checks passed.");
    expect(toastTexts()).not.toContain("Checking the PDF/A…"); // the status went with the check
    expect(state.dirty.value).toBe(false); // markSaved ran on the PDF/A path
    expect(state.downloadRunning.value).toBe(false);
  });

  it("a protected source keeps its password, and the toast says so", async () => {
    const names = fakePicker();
    await openWith("L.pdf", { encrypted: true, needsPassword: true, canKeepPassword: true });
    await actions.download();
    expect(calls).toEqual(["save"]); // a normal PDF: no PDF/A check
    expect(saves).toEqual([{ format: "pdf", password: { mode: "keep" } }]);
    expect(names).toEqual(["L-edited.pdf"]);
    expect(toastTexts()).toContain("Downloaded “L-edited.pdf”, protected with a password.");
  });

  it("a password that cannot protect the download again: one tap opens the options instead", async () => {
    const names = fakePicker();
    await openWith("L2.pdf", { encrypted: true, needsPassword: true, canKeepPassword: false });
    expect(actions.defaultChoice(state.doc.value!.info).password).toEqual(NO_PASSWORD);
    await actions.download();
    expect(calls).toEqual([]); // nothing saved, the protection is not dropped quietly
    expect(state.dialog.peek()).toEqual({ kind: "download-options", purpose: "download" });
    state.dialog.value = null;
    await actions.share();
    expect(calls).toEqual([]);
    expect(state.dialog.peek()).toEqual({ kind: "download-options", purpose: "share" }); // it shares, not downloads
    state.dialog.value = null;
    // In the options, an empty field cannot mean "keep" then: a new password is asked for.
    const form = { format: "pdf" as const, protect: true, password: "", repeat: "" };
    expect(options.optionsProblems(form, false).password).toBe("empty");
    const choice = options.choiceFromForm({ ...form, password: "nuova", repeat: "nuova" }, state.doc.value!.info);
    expect(choice).toEqual({ format: "pdf", password: { mode: "set", password: "nuova" } });
    // What the form opened from Share submits: the share sheet gets the file, no save dialog opens.
    const shared: string[] = [];
    Object.defineProperty(navigator, "share", {
      value: async (data: { files: File[] }) => { shared.push(data.files[0].name); },
      configurable: true,
    });
    await actions.share(choice);
    delete (navigator as any).share;
    expect(shared).toEqual(["L2-edited.pdf"]);
    expect(saves).toEqual([choice]);
    expect(names).toEqual([]);
  });

  it("restrictions only, or nothing: a plain PDF", async () => {
    fakePicker();
    await openWith("M.pdf", { encrypted: true });
    await actions.download();
    expect(saves).toEqual([{ format: "pdf", password: NO_PASSWORD }]);
    expect(toastTexts()).toContain("Downloaded “M-edited.pdf”.");
  });

  it("PDF/A never sends a password; a protected file claiming PDF/A keeps its password", async () => {
    fakePicker();
    await openWith("N.pdf", { encrypted: true, needsPassword: true, canKeepPassword: true, pdfa: "2B" });
    expect(actions.defaultChoice(state.doc.value!.info)).toEqual({ format: "pdf", password: { mode: "keep" } });
    await actions.download();
    expect(calls).toEqual(["save"]);
    expect(saves).toEqual([{ format: "pdf", password: { mode: "keep" } }]);

    saves.length = 0;
    pdfaReport = CLEAN;
    await actions.download({ format: "pdfa-2b", password: { mode: "set", password: "secret" } });
    expect(saves).toEqual([{ format: "pdfa-2b", password: NO_PASSWORD }]);
    expect(actions.saveOptionsFor({ format: "pdfa-2b", password: { mode: "keep" } }).password).toEqual(NO_PASSWORD);
  });
});

describe("U13 PDF/A questions", () => {
  it("blockers explain why; 'Download regular PDF' saves a normal PDF, Cancel saves nothing", async () => {
    const names = fakePicker();
    await openWith("O.pdf", { pdfa: "1B" });
    pdfaReport = { ...CLEAN, blockers: [{ code: "font-not-embedded", detail: "ABCDEF+Calibri-Bold" }, { code: "cmyk" }] };

    let p = actions.download();
    await answerDialog("pdfa-blocked", false);
    await p;
    expect(calls).toEqual(["pdfaCheck"]);

    calls.length = 0;
    p = actions.download();
    const d = await answerDialog("pdfa-blocked", true);
    await p;
    expect(d.purpose).toBe("download");
    expect(d.blockers.map(options.blockerText)).toEqual([
      "The font “Calibri” isn't included in the file, and the app has no copy of it.",
      "It uses print colours (CMYK), which the app can't convert for PDF/A yet.",
    ]);
    expect(calls).toEqual(["pdfaCheck", "save"]);
    expect(saves).toEqual([{ format: "pdf", password: NO_PASSWORD }]);
    expect(names).toEqual(["O-edited.pdf"]);
  });

  it("the regular PDF instead keeps the password a normal download would have", async () => {
    fakePicker();
    await openWith("P.pdf", { encrypted: true, needsPassword: true, canKeepPassword: true });
    pdfaReport = { ...CLEAN, blockers: [{ code: "portfolio" }] };
    const p = actions.download({ format: "pdfa-2b", password: { mode: "keep" } });
    await answerDialog("pdfa-blocked", true);
    await p;
    expect(saves).toEqual([{ format: "pdf", password: { mode: "keep" } }]);
  });

  it("a password that cannot be kept: the regular PDF instead reopens the options, it is never written unprotected", async () => {
    fakePicker();
    await openWith("P2.pdf", { encrypted: true, needsPassword: true, canKeepPassword: false });
    const info = state.doc.value!.info;
    // PDF/A picked in the options: the password part is the one-tap one, which is none here.
    const choice = options.choiceFromForm({ format: "pdfa-2b", protect: true, password: "", repeat: "" }, info);
    expect(choice.password).toEqual(NO_PASSWORD);
    pdfaReport = { ...CLEAN, blockers: [{ code: "portfolio" }] };
    let p = actions.download(choice);
    await answerDialog("pdfa-blocked", true);
    await p;
    expect(calls).toEqual(["pdfaCheck"]);
    expect(saves).toEqual([]);
    expect(state.dialog.peek()).toEqual({ kind: "download-options", purpose: "download" });
    state.dialog.value = null;

    // The same when only the engine's final check refuses the PDF/A.
    calls.length = 0;
    pdfaReport = CLEAN;
    const { EngineError } = await import("../src/engine/client");
    const save = engineImpl.save;
    engineImpl.save = async () => {
      calls.push("save");
      throw new EngineError("self-check failed", "pdfa-blocked");
    };
    p = actions.download(choice);
    await answerDialog("pdfa-blocked", true);
    await p;
    engineImpl.save = save;
    expect(calls).toEqual(["pdfaCheck", "save"]); // the PDF/A attempt only
    expect(state.dialog.peek()).toEqual({ kind: "download-options", purpose: "download" });
    state.dialog.value = null;
  });

  it("removals and the important warnings ask first; Cancel writes nothing", async () => {
    fakePicker();
    await openWith("Q.pdf", { pdfa: "2B", signatures: 1 });
    pdfaReport = {
      ...CLEAN,
      removals: [{ code: "javascript", count: 2 }, { code: "attachments", count: 1, detail: "data.csv" }],
      warnings: [{ code: "output-intent-replaced" }, { code: "signature-invalid" }],
    };
    let p = actions.download();
    const d = await answerDialog("pdfa-confirm", false);
    await p;
    expect(calls).toEqual(["pdfaCheck"]);
    expect(options.confirmLines(d.removals, d.warnings)).toEqual([
      "2 scripts (JavaScript) are removed.",
      "The attached file “data.csv” is removed.",
      "The digital signature is removed from the copy: PDF/A does not allow a signature that is no longer valid.",
      "The file's colour setting is replaced with the standard one (sRGB).",
    ]);

    calls.length = 0;
    p = actions.download();
    await answerDialog("pdfa-confirm", true);
    await p;
    expect(calls).toEqual(["pdfaCheck", "save"]);
    expect(saves).toEqual([{ format: "pdfa-2b", password: NO_PASSWORD }]);

    expect(actions.pdfaNeedsConfirm({ ...CLEAN, warnings: [{ code: "text-may-shift", detail: "Arial" }] })).toBe(true);
    expect(actions.pdfaNeedsConfirm({ ...CLEAN, warnings: [{ code: "blend-mode" }, { code: "output-intent-replaced" }] }))
      .toBe(false);
  });

  it("a refusal from the engine's own final check offers the regular PDF too", async () => {
    fakePicker();
    await openWith("R.pdf", { pdfa: "2B" });
    pdfaReport = CLEAN;
    const { EngineError } = await import("../src/engine/client");
    const save = engineImpl.save;
    engineImpl.save = async (o: any) => {
      if (o.format === "pdfa-2b") {
        calls.push("save");
        throw new EngineError("self-check failed", "pdfa-blocked");
      }
      return save(o);
    };
    const p = actions.download();
    const d = await answerDialog("pdfa-blocked", true);
    await p;
    engineImpl.save = save;
    expect(d.blockers).toEqual([]);
    expect(calls).toEqual(["pdfaCheck", "save", "save"]);
    expect(saves).toEqual([{ format: "pdf", password: NO_PASSWORD }]);
  });

  it("a failed check says so and writes nothing", async () => {
    fakePicker();
    await openWith("R2.pdf", { pdfa: "2B" });
    const { EngineError } = await import("../src/engine/client");
    const check = engineImpl.pdfaCheck;
    engineImpl.pdfaCheck = async () => { throw new EngineError("boom", "engine"); };
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await actions.download();
    error.mockRestore();
    engineImpl.pdfaCheck = check;
    expect(calls).toEqual([]);
    expect(toastTexts()).toContain("Could not check the file for PDF/A.");
    expect(toastTexts()).not.toContain("Checking the PDF/A…");
  });

  it("one download at a time, its question included; another dialog taking its place answers no", async () => {
    fakePicker();
    await openWith("S.pdf", { pdfa: "2B" });
    pdfaReport = { ...CLEAN, removals: [{ code: "annotations", count: 3 }] };
    const p = actions.download();
    await vi.waitFor(() => expect(state.dialog.value?.kind).toBe("pdfa-confirm"));
    await actions.download();
    await actions.share();
    expect(calls).toEqual(["pdfaCheck"]);
    state.showDialog({ kind: "alert", title: "x", body: "y" });
    await p;
    expect(calls).toEqual(["pdfaCheck"]);
    state.showDialog(null);
  });

  it("share follows the one-tap choice, and its questions say Share", async () => {
    delete (globalThis as any).showSaveFilePicker;
    await openWith("T.pdf", { pdfa: "2B" });
    pdfaReport = { ...CLEAN, removals: [{ code: "actions", count: 1 }] };
    const shared: string[] = [];
    Object.defineProperty(navigator, "share", {
      value: async (data: { files: File[] }) => { shared.push(data.files[0].name); },
      configurable: true,
    });
    const p = actions.share();
    const d = await answerDialog("pdfa-confirm", true);
    await p;
    delete (navigator as any).share;
    expect(d.purpose).toBe("share");
    expect(saves).toEqual([{ format: "pdfa-2b", password: NO_PASSWORD }]);
    expect(shared).toEqual(["T-edited-PDFA.pdf"]);
  });

  /** Make the next pdfaCheck wait; resolves to the function that lets it go on. */
  function holdCheck(): Promise<() => void> {
    const check = engineImpl.pdfaCheck;
    return new Promise((held) => {
      engineImpl.pdfaCheck = () => new Promise((done) => {
        engineImpl.pdfaCheck = check;
        held(() => done(check()));
      });
    });
  }

  it("a question that arrives while another dialog is open leaves that dialog alone and writes nothing", async () => {
    fakePicker();
    await openWith("W.pdf", { pdfa: "2B" });
    state.recordHistory({ editCount: 1, canUndo: true, canRedo: false, changedPages: [0] }, "edit"); // unsaved
    pdfaReport = { ...CLEAN, removals: [{ code: "javascript", count: 1 }] };
    const held = holdCheck();
    const p = actions.download();
    const release = await held;
    // While the check runs, the user picks Close document: its question opens.
    const closing = actions.closeDocument();
    await vi.waitFor(() => expect(state.dialog.value?.kind).toBe("confirm"));
    const confirm = state.dialog.value;
    release();
    await p;
    expect(state.dialog.value).toBe(confirm); // still there, not answered "no"
    expect(saves).toEqual([]);
    expect(toastTexts()).toContain("Download cancelled.");
    await answerConfirm(false);
    await closing;
    expect(state.doc.value?.fileName).toBe("W.pdf");
  });

  it("no options while a download runs, and a choice refused then says so", async () => {
    fakePicker();
    await openWith("X.pdf", { pdfa: "2B" });
    pdfaReport = CLEAN;
    const held = holdCheck();
    const p = actions.download();
    const release = await held;
    expect(state.downloadRunning.value).toBe(true);
    state.toasts.value = [];
    actions.openDownloadOptions();
    expect(state.dialog.value).toBeNull();
    expect(toastTexts()).toEqual(["Another download or share is still in progress."]);
    state.toasts.value = [];
    await actions.download({ format: "pdf", password: { mode: "none" } });
    expect(toastTexts()).toEqual(["Another download or share is still in progress."]);
    await actions.download(); // a one-tap repeat (Ctrl+S again) is just ignored
    expect(toastTexts()).toHaveLength(1);
    release();
    await p;
    expect(saves).toEqual([{ format: "pdfa-2b", password: NO_PASSWORD }]); // only the first one
    expect(state.downloadRunning.value).toBe(false);
    actions.openDownloadOptions();
    expect(state.dialog.value).toEqual({ kind: "download-options", purpose: "download" });
    state.showDialog(null);
  });
});

describe("U14 file names", () => {
  it("adds -PDFA once, in both languages", async () => {
    const i18n = await import("../src/i18n");
    expect(actions.outputName("contract.pdf")).toBe("contract-edited.pdf");
    expect(actions.outputName("contract.pdf", "pdfa-2b")).toBe("contract-edited-PDFA.pdf");
    expect(actions.outputName("contract-PDFA.pdf", "pdfa-2b")).toBe("contract-edited-PDFA.pdf");
    i18n.setLocale("it");
    expect(actions.outputName("contratto.PDF", "pdfa-2b")).toBe("contratto-modificato-PDFA.pdf");
    i18n.setLocale("en");
  });
});

describe("U15 download options", () => {
  const info = (extra: Record<string, unknown> = {}) =>
    ({ pageCount: 1, pages: [], encrypted: false, needsPassword: false, canKeepPassword: false, pdfa: null, signatures: 0, title: null, ...extra }) as any;
  const form = (password: string, repeat = password, extra: Record<string, unknown> = {}) =>
    ({ format: "pdf", protect: true, password, repeat, ...extra }) as any;

  it("asks for a password, the same one twice, and one the engine can carry", () => {
    expect(options.optionsProblems(form(""), false)).toEqual({ password: "empty", repeat: null });
    expect(options.optionsProblems(form("abc", "abd"), false)).toEqual({ password: null, repeat: "mismatch" });
    expect(options.optionsProblems(form("abc", ""), false)).toEqual({ password: null, repeat: "mismatch" });
    expect(options.optionsProblems(form("a,b"), false)).toEqual({ password: "unsupported", repeat: null });
    expect(options.unsupportedChars("a, b,")).toContain(",");
    expect(options.optionsProblems(form("x".repeat(128)), false).password).toBe("too-long");
    expect(options.optionsProblems(form("è".repeat(64)), false).password).toBe("too-long"); // 128 bytes
    expect(options.optionsProblems(form("s3cret-pässwörd"), false)).toEqual({ password: null, repeat: null });
  });

  it("an empty field keeps the old password; PDF/A or no protection asks nothing", () => {
    expect(options.optionsProblems(form("", "typed only here"), true)).toEqual({ password: null, repeat: null });
    expect(options.optionsProblems(form("a,b", "x", { format: "pdfa-2b" }), false)).toEqual({ password: null, repeat: null });
    expect(options.optionsProblems(form("", "", { protect: false }), false)).toEqual({ password: null, repeat: null });
  });

  it("turns the form into one download", () => {
    const opened = info({ needsPassword: true, canKeepPassword: true, encrypted: true });
    expect(options.choiceFromForm(form(""), opened)).toEqual({ format: "pdf", password: { mode: "keep" } });
    expect(options.choiceFromForm(form("new"), opened)).toEqual({ format: "pdf", password: { mode: "set", password: "new" } });
    expect(options.choiceFromForm(form("", "", { protect: false }), opened)).toEqual({ format: "pdf", password: NO_PASSWORD });
    // PDF/A: no password with it; a regular PDF offered instead would keep the old one.
    const pdfa = options.choiceFromForm(form("new", "new", { format: "pdfa-2b" }), opened);
    expect(pdfa).toEqual({ format: "pdfa-2b", password: { mode: "keep" } });
    expect(actions.saveOptionsFor(pdfa)).toEqual({ format: "pdfa-2b", password: NO_PASSWORD });
    expect(options.choiceFromForm(form("x", "x", { format: "pdfa-2b" }), info()).password).toEqual(NO_PASSWORD);
  });

  it("opens only with a document and no other dialog", async () => {
    await openWith("U.pdf", {});
    actions.openDownloadOptions();
    expect(state.dialog.value).toEqual({ kind: "download-options", purpose: "download" });
    state.showDialog({ kind: "alert", title: "x", body: "y" });
    actions.openDownloadOptions();
    expect(state.dialog.value?.kind).toBe("alert");
    state.showDialog(null);
  });

  it("names the refused characters: one or several, a tab, the ones that can't be seen", async () => {
    const i18n = await import("../src/i18n");
    expect(options.passwordMessage("unsupported", "a,b")).toBe("This character can't be used in a password: “,”");
    const tab = options.passwordMessage("unsupported", "a\tb");
    expect(tab).toBe("This character can't be used in a password: tab");
    expect(tab).not.toMatch(/space/); // spaces are allowed
    expect(options.passwordMessage("unsupported", "a,\u0001b"))
      .toBe("These characters can't be used in a password: “,”, an invisible character");
    expect(options.unsupportedChars("x,\u0001,")).toEqual([",", "\u0001"]);
    // Fine one by one, refused together (e.g. writing directions mixed): no list.
    expect(options.passwordMessage("unsupported", "abcאב")).toMatch(/^Some PDF readers would read this password differently/);
    // What other readers' password preparation (SASLprep) changes, named as people see it.
    expect(options.charLabel("\u00A0")).toBe("a special space (not the usual one)");
    expect(options.charLabel("\u3000")).toBe("a special space (not the usual one)");
    expect(options.charLabel("\u200B")).toBe("an invisible character");
    expect(options.charLabel("\uFE0F")).toBe("an invisible character");
    expect(options.charLabel("\u0301")).toBe("an invisible character");
    expect(options.charLabel("❤\uFE0F")).toBe("“❤\uFE0F”");
    expect(options.charLabel("ｐ")).toBe("“ｐ”");
    // With passwordProblem's rules: an emoji with its style mark, or joined to another, is
    // quoted whole; an accent typed apart is quoted with its letter.
    const one = (password: string) => options.passwordMessage(options.optionsProblems(form(password), false).password!, password);
    expect(one("amore❤\uFE0F")).toBe("This character can't be used in a password: “❤\uFE0F”");
    expect(one("dev\u{1F469}\u200D\u{1F4BB}")).toBe("This character can't be used in a password: “\u{1F469}\u200D\u{1F4BB}”");
    expect(one("pass\u00A0word")).toBe("This character can't be used in a password: a special space (not the usual one)");
    expect(one("caffe\u0300")).toBe("This character can't be used in a password: “e\u0300”");
    expect(one("x\u200By,")).toBe("These characters can't be used in a password: an invisible character, “,”");
    i18n.setLocale("it");
    expect(options.passwordMessage("unsupported", "a,b")).toBe("Questo carattere non si può usare in una password: “,”");
    expect(options.passwordMessage("unsupported", "a\tb,")).toBe("Questi caratteri non si possono usare in una password: tabulazione, “,”");
    expect(options.charLabel("\u00A0")).toBe("uno spazio speciale (non quello normale)");
    i18n.setLocale("en");
  });
});

describe("U16 PDF/A texts", () => {
  const blockers = ["font-not-embedded", "font-changed", "font-widths", "notdef", "cmyk", "icc-invalid", "xfa-dynamic", "portfolio", "external-content"];
  const removals = ["javascript", "actions", "attachments", "annotations", "hidden-fields-shown", "xfa-data"];
  const warnings = ["text-may-shift", "signature-invalid", "blend-mode", "output-intent-replaced"];

  it("every code has a filled-in text in both languages, with and without details", async () => {
    const i18n = await import("../src/i18n");
    for (const locale of ["en", "it"] as const) {
      i18n.setLocale(locale);
      const texts = [
        ...blockers.flatMap((code) => [options.blockerText({ code } as any), options.blockerText({ code, detail: "Calibri" } as any)]),
        ...removals.flatMap((code) => [1, 2, undefined].map((count) => options.removalText({ code, count } as any))),
        ...warnings.flatMap((code) => [1, 3, undefined].map((count) => options.warningText({ code, count, detail: "Arial" } as any))),
      ];
      for (const text of texts) expect(text).toMatch(/^[^{}]+$/);
    }
    i18n.setLocale("en");
  });

  it("Italian plurals and font names", async () => {
    const i18n = await import("../src/i18n");
    i18n.setLocale("it");
    expect(options.removalText({ code: "javascript", count: 1 })).toBe("Tolgo 1 script (JavaScript).");
    expect(options.removalText({ code: "javascript", count: 2 })).toBe("Tolgo 2 script (JavaScript).");
    expect(options.removalText({ code: "attachments", count: 1 })).toBe("Tolgo 1 allegato.");
    expect(options.removalText({ code: "attachments", count: 2 })).toBe("Tolgo 2 allegati.");
    expect(options.removalText({ code: "attachments", count: 1, detail: "dati.csv" })).toBe("Tolgo l'allegato “dati.csv”.");
    expect(options.removalText({ code: "annotations", count: 3 })).toBe("Tolgo 3 annotazioni nascoste o non ammesse.");
    expect(options.removalText({ code: "hidden-fields-shown", count: 1 })).toBe("Rendo visibile 1 campo nascosto del modulo.");
    expect(options.blockerText({ code: "font-not-embedded", detail: "ABCDEF+Calibri-Bold" }))
      .toBe("Il font “Calibri” non è incluso nel file e non ne ho una copia.");
    expect(options.warningText({ code: "text-may-shift", detail: "ArialMT" }))
      .toBe("Il testo in “Arial” potrebbe spostarsi un poco: quel font non è nel file, quindi ne uso uno standard simile.");
    i18n.setLocale("en");
    expect(options.removalText({ code: "javascript", count: 1 })).toBe("1 script (JavaScript) is removed.");
    expect(options.removalText({ code: "javascript", count: 5 })).toBe("5 scripts (JavaScript) are removed.");
  });
});

describe("U17 details panel", () => {
  it("promises the same password only when the copy can have it", async () => {
    const { protectionText } = await import("../src/ui/DetailsPanel");
    const info = (extra: Record<string, unknown>) =>
      ({ pageCount: 1, pages: [], encrypted: false, needsPassword: false, canKeepPassword: false, pdfa: null, signatures: 0, title: null, ...extra }) as any;
    expect(protectionText(info({ encrypted: true, needsPassword: true, canKeepPassword: true })))
      .toBe("Yes · the downloaded copy keeps the same password");
    expect(protectionText(info({ encrypted: true, needsPassword: true, canKeepPassword: false })))
      .toBe("Yes · you'll choose a new password for the downloaded copy");
    expect(protectionText(info({ encrypted: true }))).toBe("Usage restrictions · the downloaded copy won't have them");
    expect(protectionText(info({}))).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Phase 3, release 2: images

/** An image of page 0 as the engine lists it. */
const IMAGE = (index: number, extra: Record<string, unknown> = {}) => ({
  index, matrix: [50, 0, 0, 40, 10, 20], bbox: [10, 20, 60, 60], visible: [10, 20, 60, 60],
  pixelWidth: 500, pixelHeight: 400, movable: true, reason: null, ...extra,
}) as any;
const MOVED = [50, 0, 0, 40, 30, 25] as any;
const PICKED = { name: "photo.heic", type: "image/heic", size: 4 } as unknown as File;

/** Open a one-page document in edit mode; returns its page. */
async function editing(name: string) {
  await openWith(name, {});
  await actions.setEditMode(true);
  state.toasts.value = [];
  return state.doc.value!.pages[0];
}

/** Make the next call of the engine's `op` wait; resolves to the function that lets it go on. */
function hold(op: string): Promise<() => void> {
  const original = engineImpl[op];
  return new Promise((held) => {
    engineImpl[op] = (...args: unknown[]) => new Promise((done) => {
      engineImpl[op] = original;
      held(() => done(original(...args)));
    });
  });
}

/** What the image frame registers while a keyboard move waits to be written (ImageLayer). */
function pendingMove(page: any, image = IMAGE(1)) {
  const unregister = state.registerEditor({
    changed: () => true,
    commit: async () => {
      unregister();
      await actions.transformImage(page, image, MOVED, page.rev.peek());
    },
  });
  return unregister;
}

describe("U18 selecting an image", () => {
  it("closes the line editor, and opening a line deselects it", async () => {
    const page = await editing("IA.pdf");
    state.editingLine.value = { pageIndex: 0, line: LINE };
    await actions.selectImage(0, IMAGE(1), page.rev.peek());
    expect(state.editingLine.value).toBeNull();
    expect(state.selectedImage.value).toEqual({ pageIndex: 0, index: 1 });
    await actions.openLine(0, LINE);
    expect(state.selectedImage.value).toBeNull();
    expect(state.editingLine.value).toEqual({ pageIndex: 0, line: LINE });
    await actions.selectImage(0, IMAGE(2));
    expect(state.editingLine.value).toBeNull();
    expect(state.selectedImage.value).toEqual({ pageIndex: 0, index: 2 });
    await actions.selectImage(0, null);
    expect(state.selectedImage.value).toBeNull();
    expect(calls).toEqual([]);
  });

  it("a locked image says why and is not selected", async () => {
    const page = await editing("IB.pdf");
    await actions.selectImage(0, IMAGE(0), page.rev.peek());
    await actions.selectImage(0, IMAGE(1, { movable: false, reason: "group" }), page.rev.peek());
    expect(toastTexts()).toEqual(["This image can't be moved: it is joined to other content, such as a caption."]);
    expect(state.selectedImage.value).toEqual({ pageIndex: 0, index: 0 }); // the one selected before stays
  });

  it("not in browse mode, nor from a stale image list, nor while an edit is being written", async () => {
    const page = await editing("IC.pdf");
    const rev = page.rev.peek();
    await actions.setEditMode(false);
    await actions.selectImage(0, IMAGE(1), rev);
    expect(state.selectedImage.value).toBeNull();

    await actions.setEditMode(true);
    await actions.selectImage(0, IMAGE(1), rev);
    state.invalidatePages([0]); // the page changed (an edit landed)
    expect(page.images.value).toBeNull();
    await actions.selectImage(0, IMAGE(2), rev);
    expect(state.selectedImage.value).toBeNull(); // cleared: the indices may be stale

    await actions.selectImage(0, IMAGE(1), page.rev.peek());
    const held = hold("transformImage");
    const p = actions.transformImage(page, IMAGE(1), MOVED, page.rev.peek());
    const release = await held;
    await actions.selectImage(0, IMAGE(2), page.rev.peek());
    expect(state.selectedImage.value).toEqual({ pageIndex: 0, index: 1 }); // the click during the write is ignored
    release();
    await p;
  });

  it("every lock reason has a text, in both languages", async () => {
    const i18n = await import("../src/i18n");
    for (const locale of ["en", "it"] as const) {
      i18n.setLocale(locale);
      const texts = (["group", "soft-mask", "cropped", "unreadable", null] as const).map(actions.lockReasonText);
      for (const text of texts) expect(text).toMatch(/^[^{}]+$/);
      expect(texts.some((text) => text.startsWith("image."))).toBe(false);
      expect(new Set(texts).size).toBe(4); // no reason reads as "unreadable"
    }
    i18n.setLocale("en");
  });
});

describe("U19 image edits", () => {
  it("a move is one edit, and the selection follows the index the engine returns", async () => {
    const page = await editing("ID.pdf");
    await actions.selectImage(0, IMAGE(1), page.rev.peek());
    const rev = page.rev.peek();
    let sent: unknown;
    const transform = engineImpl.transformImage;
    engineImpl.transformImage = async (_p: number, i: number, matrix: unknown) => {
      calls.push(`transformImage:${i}`);
      sent = matrix;
      return imageEdited(3);
    };
    await actions.transformImage(page, IMAGE(1), MOVED, rev);
    engineImpl.transformImage = transform;
    expect(calls).toEqual(["transformImage:1"]);
    expect(sent).toEqual(MOVED);
    expect(state.history.value.editCount).toBe(1);
    expect(state.dirty.value).toBe(true);
    expect([...state.editedPages.value]).toEqual([0]);
    expect(page.rev.peek()).toBe(rev + 1); // re-rendered, its lines and images read again
    expect(page.images.value).toBeNull();
    expect(state.selectedImage.value).toEqual({ pageIndex: 0, index: 3 });
  });

  it("delete is one edit and clears the selection", async () => {
    const page = await editing("IE.pdf");
    await actions.selectImage(0, IMAGE(2), page.rev.peek());
    await actions.deleteImage(page, IMAGE(2), page.rev.peek());
    expect(calls).toEqual(["deleteImage:2"]);
    expect(state.selectedImage.value).toBeNull();
    expect(state.history.value.canUndo).toBe(true);
    expect(state.dirty.value).toBe(true);
  });

  it("a move the engine finds unchanged records nothing and keeps the selection", async () => {
    const page = await editing("IE2.pdf");
    await actions.selectImage(0, IMAGE(1), page.rev.peek());
    const rev = page.rev.peek();
    const transform = engineImpl.transformImage;
    engineImpl.transformImage = async () => ({ ...imageEdited(1, []), editCount: 0, canUndo: false });
    await actions.transformImage(page, IMAGE(1), IMAGE(1).matrix, rev);
    engineImpl.transformImage = transform;
    expect(state.dirty.value).toBe(false);
    expect(page.rev.peek()).toBe(rev);
    expect(state.selectedImage.value).toEqual({ pageIndex: 0, index: 1 });
  });

  it("deselected, or edit mode left, while it is written: the selection does not come back", async () => {
    const page = await editing("IE3.pdf");
    await actions.selectImage(0, IMAGE(1), page.rev.peek());
    let held = hold("transformImage");
    let p = actions.transformImage(page, IMAGE(1), MOVED, page.rev.peek());
    let release = await held;
    await actions.selectImage(0, null);
    release();
    await p;
    expect(calls).toEqual(["transformImage:1"]);
    expect(state.selectedImage.value).toBeNull();

    await actions.selectImage(0, IMAGE(1), page.rev.peek());
    held = hold("transformImage");
    p = actions.transformImage(page, IMAGE(1), MOVED, page.rev.peek());
    release = await held;
    await actions.setEditMode(false);
    release();
    await p;
    expect(state.editMode.value).toBe(false);
    expect(state.selectedImage.value).toBeNull();
  });

  it("a stale page is refused; a locked image and engine failures say so", async () => {
    const page = await editing("IF.pdf");
    await actions.selectImage(0, IMAGE(1), page.rev.peek());
    const rev = page.rev.peek();
    state.invalidatePages([0]);
    await actions.transformImage(page, IMAGE(1), MOVED, rev);
    await actions.deleteImage(page, IMAGE(1), rev);
    expect(calls).toEqual([]);
    expect(toastTexts()).toEqual(["Could not change this image."]);

    const { EngineError } = await import("../src/engine/client");
    const transform = engineImpl.transformImage;
    state.toasts.value = [];
    engineImpl.transformImage = async () => { throw new EngineError("locked", "not-editable"); };
    await actions.transformImage(page, IMAGE(1), MOVED, page.rev.peek());
    expect(toastTexts()).toEqual(["This image can't be changed."]); // not the line's text
    expect(state.selectedImage.value).toBeNull();

    state.toasts.value = [];
    engineImpl.transformImage = async () => { throw new EngineError("stale entry", "edit-failed"); };
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await actions.transformImage(page, IMAGE(1), MOVED, page.rev.peek());
    error.mockRestore();
    engineImpl.transformImage = transform;
    expect(toastTexts()).toEqual(["Could not change this image."]);
    expect(state.dirty.value).toBe(false);
    expect(state.editingStopped.value).toBe(false);
  });
});

describe("U20 the selection and the history", () => {
  it("undo, redo, leaving edit mode and closing the document clear it", async () => {
    const page = await editing("IG.pdf");
    await actions.selectImage(0, IMAGE(1), page.rev.peek());
    await actions.transformImage(page, IMAGE(1), MOVED, page.rev.peek());
    expect(state.selectedImage.value).toEqual({ pageIndex: 0, index: 1 });
    await actions.undo();
    expect(calls).toEqual(["transformImage:1", "undo"]);
    expect(state.selectedImage.value).toBeNull();

    await actions.selectImage(0, IMAGE(1), page.rev.peek());
    await actions.redo();
    expect(calls).toEqual(["transformImage:1", "undo", "redo"]);
    expect(state.selectedImage.value).toBeNull();

    await actions.selectImage(0, IMAGE(1), page.rev.peek());
    await actions.setEditMode(false);
    expect(state.selectedImage.value).toBeNull();

    await actions.setEditMode(true);
    await actions.selectImage(0, IMAGE(1), page.rev.peek());
    const p = actions.closeDocument();
    await answerConfirm(true); // the edit was not downloaded
    await p;
    expect(state.selectedImage.value).toBeNull();
    expect(state.doc.value).toBeNull();
  });
});

describe("U21 a keyboard move still waiting", () => {
  it("counts as unsaved and is written before a download", async () => {
    fakePicker();
    const page = await editing("IH.pdf");
    await actions.selectImage(0, IMAGE(1), page.rev.peek());
    const unregister = pendingMove(page);
    expect(state.hasUnsavedWork()).toBe(true);
    await actions.download();
    unregister();
    expect(calls).toEqual(["transformImage:1", "save"]);
    expect(state.dirty.value).toBe(false); // the file has the move
    expect(state.selectedImage.value).toEqual({ pageIndex: 0, index: 1 });
  });

  it("is written before undo, which then undoes it, and before leaving edit mode", async () => {
    const page = await editing("II.pdf");
    await actions.selectImage(0, IMAGE(1), page.rev.peek());
    let unregister = pendingMove(page);
    await actions.undo();
    unregister();
    expect(calls).toEqual(["transformImage:1", "undo"]);
    expect(state.selectedImage.value).toBeNull();

    calls.length = 0;
    await actions.selectImage(0, IMAGE(1), page.rev.peek());
    unregister = pendingMove(page);
    await actions.setEditMode(false);
    unregister();
    expect(calls).toEqual(["transformImage:1"]);
    expect(state.editMode.value).toBe(false);
    expect(state.selectedImage.value).toBeNull();
  });

  it("selecting another image or a line of the same page writes it first; their indices are stale then", async () => {
    const page = await editing("IJ.pdf");
    await actions.selectImage(0, IMAGE(1), page.rev.peek());
    let unregister = pendingMove(page);
    await actions.selectImage(0, IMAGE(2), page.rev.peek());
    unregister();
    expect(calls).toEqual(["transformImage:1"]);
    expect(state.selectedImage.value).toBeNull(); // clicked again, once the images are read again

    calls.length = 0;
    await actions.selectImage(0, IMAGE(1), page.rev.peek());
    unregister = pendingMove(page);
    await actions.openLine(0, LINE);
    unregister();
    expect(calls).toEqual(["transformImage:1"]);
    expect(state.editingLine.value).toBeNull();
    expect(state.selectedImage.value).toBeNull();
  });
});

describe("U22 keys with an image selected", () => {
  it("Escape deselects first, then leaves edit mode; Ctrl+Z undoes and clears the selection", async () => {
    const g = globalThis as any;
    const saved = { add: g.addEventListener, remove: g.removeEventListener, element: g.HTMLElement };
    const listeners: Record<string, (e: unknown) => void> = {};
    g.addEventListener = (type: string, fn: (e: unknown) => void) => { listeners[type] = fn; };
    g.removeEventListener = () => undefined;
    g.HTMLElement ??= class {};
    const { installShortcuts } = await import("../src/ui/shortcuts");
    const uninstall = installShortcuts();
    const press = (key: string, mods: Record<string, boolean> = {}) => {
      const e: any = {
        key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, target: null, defaultPrevented: false,
        preventDefault() { e.defaultPrevented = true; }, ...mods,
      };
      listeners.keydown(e);
      return e;
    };
    try {
      const page = await editing("IK.pdf");
      await actions.selectImage(0, IMAGE(1), page.rev.peek());
      expect(press("Escape").defaultPrevented).toBe(true);
      await vi.waitFor(() => expect(state.selectedImage.value).toBeNull());
      expect(state.editMode.value).toBe(true);
      press("Escape");
      await vi.waitFor(() => expect(state.editMode.value).toBe(false));

      await actions.setEditMode(true);
      await actions.selectImage(0, IMAGE(1), page.rev.peek());
      await actions.transformImage(page, IMAGE(1), MOVED, page.rev.peek());
      calls.length = 0;
      press("z", { ctrlKey: true });
      await vi.waitFor(() => expect(calls).toEqual(["undo"]));
      await vi.waitFor(() => expect(state.selectedImage.value).toBeNull());
      expect(state.editMode.value).toBe(true);
    } finally {
      uninstall();
      g.addEventListener = saved.add;
      g.removeEventListener = saved.remove;
      g.HTMLElement = saved.element;
    }
  });
});

describe("U23 replacing an image", () => {
  it("prepares the picture with a status, outside the engine's queue, then sends its bytes", async () => {
    const page = await editing("IL.pdf");
    await actions.selectImage(0, IMAGE(1), page.rev.peek());
    const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
    const seen: { name?: string; texts?: string[]; busy?: unknown; pending?: number } = {};
    (globalThis as any).__prepare = async (file: File) => {
      seen.name = file.name;
      seen.texts = toastTexts();
      seen.busy = state.busy.peek();
      seen.pending = state.imageEditsPending.peek();
      return { bytes, width: 4, height: 1 };
    };
    replacedBytes.length = 0;
    await actions.replaceImage(page, IMAGE(1), page.rev.peek(), PICKED);
    // Not in the engine's queue yet, but already an image edit on its way: the frame waits.
    expect(seen).toEqual({ name: "photo.heic", texts: ["Preparing the picture…"], busy: null, pending: 1 });
    expect(state.imageEditsPending.value).toBe(0);
    expect(replacedBytes).toHaveLength(1);
    expect(replacedBytes[0]).toBe(bytes); // the prepared buffer itself: the client transfers it
    expect(calls).toEqual(["replaceImage:1"]);
    expect(toastTexts()).toEqual([]); // the status went with the preparation
    expect(state.history.value.editCount).toBe(1);
    expect(state.selectedImage.value).toEqual({ pageIndex: 0, index: 1 });
  });

  it("Replace… opens a picker for pictures (camera included) and replaces with the file chosen", async () => {
    const page = await editing("IM.pdf");
    await actions.selectImage(0, IMAGE(1), page.rev.peek());
    (globalThis as any).__prepare = async () => ({ bytes: new ArrayBuffer(2), width: 1, height: 1 });
    const inputs: any[] = [];
    const doc = (globalThis as any).document;
    const createElement = doc.createElement;
    doc.createElement = (tag: string) => {
      const el: any = {
        tag, listeners: {}, attrs: {}, clicked: false, removed: false,
        addEventListener(type: string, fn: () => void) { el.listeners[type] = fn; },
        setAttribute(name: string, value: string) { el.attrs[name] = value; },
        click() { el.clicked = true; },
        remove() { el.removed = true; },
      };
      inputs.push(el);
      return el;
    };
    try {
      actions.chooseReplacement(page, IMAGE(1), page.rev.peek());
      expect(inputs).toHaveLength(1);
      expect(inputs[0]).toMatchObject({ tag: "input", type: "file", accept: "image/*", hidden: true, clicked: true });
      expect("capture" in inputs[0]).toBe(false); // with it, phones would offer the camera only
      // Closed without a choice where "cancel" is not fired: the next Replace… removes that input.
      actions.chooseReplacement(page, IMAGE(1), page.rev.peek());
      expect(inputs[0].removed).toBe(true);
      const input = inputs[1];
      input.files = [PICKED];
      input.listeners.change();
      expect(input.removed).toBe(true);
      await vi.waitFor(() => expect(state.history.value.editCount).toBe(1));
      expect(calls).toEqual(["replaceImage:1"]);
      // Cancelled where "cancel" is fired: removed at once.
      actions.chooseReplacement(page, IMAGE(1), page.rev.peek());
      inputs[2].listeners.cancel();
      expect(inputs[2].removed).toBe(true);
    } finally {
      doc.createElement = createElement;
    }
  });

  it("a keyboard move written while the picker is open does not make the replacement stale", async () => {
    const page = await editing("IN.pdf");
    (globalThis as any).__prepare = async () => ({ bytes: new ArrayBuffer(2), width: 1, height: 1 });
    await actions.selectImage(0, IMAGE(1), page.rev.peek());
    const rev = page.rev.peek();
    const unregister = pendingMove(page);
    await state.flushEditor(); // what chooseReplacement starts before the picker opens
    unregister();
    expect(page.rev.peek()).toBe(rev + 1);
    await actions.replaceImage(page, IMAGE(1), rev, PICKED);
    expect(calls).toEqual(["transformImage:1", "replaceImage:1"]);

    // Another image selected meanwhile: the old revision is stale, nothing is written.
    await actions.selectImage(0, IMAGE(0), page.rev.peek());
    state.toasts.value = [];
    await actions.replaceImage(page, IMAGE(1), rev, PICKED);
    expect(calls).toEqual(["transformImage:1", "replaceImage:1"]);
    expect(toastTexts()).toEqual(["Could not change this image."]);
  });

  it("a picture that is too big or unreadable says so and changes nothing", async () => {
    const page = await editing("IO.pdf");
    await actions.selectImage(0, IMAGE(1), page.rev.peek());
    const { PictureError } = await import("../src/ui/imageFile");
    (globalThis as any).__prepare = async () => { throw new PictureError("big", "too-big"); };
    await actions.replaceImage(page, IMAGE(1), page.rev.peek(), PICKED);
    expect(toastTexts()).toEqual(["This picture is too large (more than 50 MB)."]);

    state.toasts.value = [];
    (globalThis as any).__prepare = async () => { throw new PictureError("no decoder", "unreadable"); };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await actions.replaceImage(page, IMAGE(1), page.rev.peek(), PICKED);
    warn.mockRestore();
    expect(toastTexts()).toEqual(["This picture can't be read. Try a JPEG or PNG."]);
    expect(calls).toEqual([]);
    expect(state.dirty.value).toBe(false);
    expect(state.selectedImage.value).toEqual({ pageIndex: 0, index: 1 });
    expect(state.imageEditsPending.value).toBe(0);
  });
});

describe("U24 details panel: the selected image", () => {
  it("size in mm, pixels and resolution, rotation, in both languages", async () => {
    const { imageFacts } = await import("../src/ui/DetailsPanel");
    const i18n = await import("../src/i18n");
    expect(imageFacts(IMAGE(0, { matrix: [144, 0, 0, 72, 0, 0], pixelWidth: 600, pixelHeight: 300 }))).toEqual({
      size: "51 × 25 mm", pixels: "600 × 300 px · 300 ppi", rotation: "0°",
    });
    // Turned 90° clockwise, and small: one decimal below 10 mm.
    const small = IMAGE(0, { matrix: [0, 20, -10, 0, 50, 50], pixelWidth: 100, pixelHeight: 50 });
    expect(imageFacts(small)).toEqual({ size: "7.1 × 3.5 mm", pixels: "100 × 50 px · 360 ppi", rotation: "90°" });
    expect(imageFacts(IMAGE(0, { matrix: [-50, 0, 0, -40, 60, 60] })).rotation).toBe("180°");
    // A 1-px spacer picture (0.75 pt) is not "0 × 0 mm".
    const spacer = IMAGE(0, { matrix: [0.75, 0, 0, 0.75, 10, 10], pixelWidth: 1, pixelHeight: 1 });
    expect(imageFacts(spacer).size).toBe("0.3 × 0.3 mm");
    i18n.setLocale("it");
    expect(imageFacts(small).size).toBe("7,1 × 3,5 mm");
    expect(imageFacts(spacer).size).toBe("0,3 × 0,3 mm");
    i18n.setLocale("en");
  });
});

describe("U25 image edits still on their way", () => {
  it("a Delete waiting behind a download: no other image is selected meanwhile, and pressing it again is the same Delete", async () => {
    fakePicker();
    const page = await editing("IP.pdf");
    await actions.selectImage(0, IMAGE(1), page.rev.peek());
    const rev = page.rev.peek();
    const held = hold("save");
    const saving = actions.download();
    const release = await held;
    const before = { busy: state.busy.value, pending: state.imageEditsPending.value };
    const first = actions.deleteImage(page, IMAGE(1), rev);
    try {
      expect(before).toEqual({ busy: "save", pending: 0 });
      expect(state.imageEditsPending.value).toBe(1); // the frame shows it as pending (ImageLayer)
      const second = actions.deleteImage(page, IMAGE(1), rev);
      expect(second).toBe(first);
      expect(state.imageEditsPending.value).toBe(1);
      await actions.selectImage(0, IMAGE(3), rev); // a click on another image's box meanwhile
      expect(state.selectedImage.value).toEqual({ pageIndex: 0, index: 1 });
    } finally {
      release(); // a failure above must not leave the engine's queue held for the next tests
    }
    await saving;
    await first;
    expect(calls).toEqual(["save", "deleteImage:1"]);
    expect(state.imageEditsPending.value).toBe(0);
    expect(state.selectedImage.value).toBeNull();
    expect(toastTexts()).toEqual(["Downloaded “IP-edited.pdf”."]); // not "Could not change this image."
    expect(state.dirty.value).toBe(true); // the deletion came after the download

    // Done: images can be selected again, and another Delete is a new one.
    await actions.selectImage(0, IMAGE(1), page.rev.peek());
    expect(state.selectedImage.value).toEqual({ pageIndex: 0, index: 1 });
    await actions.deleteImage(page, IMAGE(1), page.rev.peek());
    expect(calls).toEqual(["save", "deleteImage:1", "deleteImage:1"]);
  });

  it("after a delete, a selection on an image painted later moves up one place; others keep theirs", async () => {
    const twoPages = [{ index: 0, bounds: [0, 0, 100, 100] }, { index: 1, bounds: [0, 0, 100, 100] }];
    await openWith("IQ.pdf", { pageCount: 2, pages: twoPages });
    await actions.setEditMode(true);
    state.toasts.value = [];
    const [page, other] = state.doc.value!.pages;

    // Selected while another image's deletion was asked for (through the engine's API).
    await actions.selectImage(0, IMAGE(3), page.rev.peek());
    await actions.deleteImage(page, IMAGE(1), page.rev.peek());
    expect(state.selectedImage.value).toEqual({ pageIndex: 0, index: 2 }); // the same picture
    // An image painted earlier, or one on another page, keeps its index.
    await actions.selectImage(0, IMAGE(0), page.rev.peek());
    await actions.deleteImage(page, IMAGE(1), page.rev.peek());
    expect(state.selectedImage.value).toEqual({ pageIndex: 0, index: 0 });
    await actions.selectImage(1, IMAGE(3), other.rev.peek());
    await actions.deleteImage(page, IMAGE(1), page.rev.peek());
    expect(state.selectedImage.value).toEqual({ pageIndex: 1, index: 3 });
    // A move or a replacement changes no index.
    await actions.selectImage(0, IMAGE(3), page.rev.peek());
    await actions.transformImage(page, IMAGE(1), MOVED, page.rev.peek());
    expect(state.selectedImage.value).toEqual({ pageIndex: 0, index: 3 });
    expect(calls).toEqual(["deleteImage:1", "deleteImage:1", "deleteImage:1", "transformImage:1"]);
    expect(toastTexts()).toEqual([]);
  });

  it("each image edit counts until it has finished: written, refused, failed, or its document closed", async () => {
    const page = await editing("IR.pdf");
    // (What is seen while the engine is held is checked once it is let go, so that a failure
    // does not leave the engine's queue held for the next tests.)
    let held = hold("transformImage");
    const moving = actions.transformImage(page, IMAGE(1), MOVED, page.rev.peek());
    const asked = state.imageEditsPending.value;
    let release = await held;
    const written = { busy: state.busy.value, pending: state.imageEditsPending.value };
    release();
    await moving;
    expect([asked, written, state.imageEditsPending.value]).toEqual([1, { busy: "edit", pending: 1 }, 0]);

    // Refused: the page changed since its images were read.
    await actions.transformImage(page, IMAGE(1), MOVED, page.rev.peek() - 1);
    expect(toastTexts()).toEqual(["Could not change this image."]);
    expect(state.imageEditsPending.value).toBe(0);

    // Failed in the engine.
    const { EngineError } = await import("../src/engine/client");
    const remove = engineImpl.deleteImage;
    engineImpl.deleteImage = async () => { throw new EngineError("stale entry", "edit-failed"); };
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await actions.deleteImage(page, IMAGE(1), page.rev.peek());
    error.mockRestore();
    engineImpl.deleteImage = remove;
    expect(state.imageEditsPending.value).toBe(0);

    // A picture that could not be prepared.
    const { PictureError } = await import("../src/ui/imageFile");
    (globalThis as any).__prepare = async () => { throw new PictureError("big", "too-big"); };
    await actions.replaceImage(page, IMAGE(1), page.rev.peek(), PICKED);
    expect(state.imageEditsPending.value).toBe(0);

    // Closed while an edit waits behind another: neither reaches the engine afterwards.
    calls.length = 0;
    held = hold("transformImage");
    const first = actions.transformImage(page, IMAGE(1), MOVED, page.rev.peek());
    const queued = actions.deleteImage(page, IMAGE(2), page.rev.peek());
    release = await held;
    const waiting = state.imageEditsPending.value;
    const closing = actions.closeDocument();
    try {
      await answerConfirm(true); // the edits written before were not downloaded
      await closing;
    } finally {
      release();
    }
    await first;
    await queued;
    expect(waiting).toBe(2);
    expect(state.doc.value).toBeNull();
    expect(calls).not.toContain("deleteImage:2");
    expect(state.imageEditsPending.value).toBe(0);
  });

  it("no line opens while an image edit waits or an undo runs: the page read again would close it, typed text and all", async () => {
    fakePicker();
    const page = await editing("IS.pdf");
    await actions.selectImage(0, IMAGE(1), page.rev.peek());
    const held = hold("save");
    const saving = actions.download();
    const release = await held;
    const deleting = actions.deleteImage(page, IMAGE(1), page.rev.peek());
    let during: unknown;
    try {
      await actions.openLine(0, LINE); // a click on a line box of the same page meanwhile
      during = { line: state.editingLine.value, selected: state.selectedImage.value };
    } finally {
      release();
    }
    await saving;
    await deleting;
    expect(during).toEqual({ line: null, selected: { pageIndex: 0, index: 1 } });
    expect(calls).toEqual(["save", "deleteImage:1"]);

    // An undo being written: the same.
    const undoing = hold("undo");
    const stepping = actions.undo();
    const letUndoGo = await undoing;
    try {
      await actions.openLine(0, LINE);
      during = state.editingLine.value;
    } finally {
      letUndoGo();
    }
    await stepping;
    expect(during).toBeNull();

    // Done: the line opens.
    await actions.openLine(0, LINE);
    expect(state.editingLine.value).toEqual({ pageIndex: 0, line: LINE });
  });

  it("only the open document's image edits count: one queued when it closed warns about nothing afterwards", async () => {
    fakePicker();
    const page = await editing("IT.pdf");
    await actions.selectImage(0, IMAGE(1), page.rev.peek());
    /** Lets a held engine call go on, once however often it is called. */
    const once = (go: () => void) => {
      let gone = false;
      return () => {
        if (!gone) go();
        gone = true;
      };
    };
    const held = hold("save");
    const saving = actions.download();
    const release = once(await held);
    let afterClose: unknown, asked: unknown, selected: unknown, newCount: unknown;
    let queued: Promise<void> = Promise.resolve();
    let moving: Promise<void> = Promise.resolve();
    let letMoveGo: () => void = () => undefined;
    try {
      queued = actions.deleteImage(page, IMAGE(1), page.rev.peek()); // waits behind the download
      const closing = actions.closeDocument();
      await answerConfirm(true); // the queued delete is all there is to lose
      await closing;
      afterClose = {
        doc: state.doc.value, pending: state.imageEditsPending.value, unsaved: state.hasUnsavedWork(),
        warn: actions.shouldWarnBeforeUnload(),
      };
      // The next file opens without a question about the one closed...
      const opened = actions.openFile(fakeFile("IU.pdf", "IU"));
      await vi.waitFor(() => expect(state.doc.value?.fileName === "IU.pdf" || state.dialog.value !== null).toBe(true));
      asked = state.dialog.value?.kind ?? null;
      if (asked) await answerConfirm(true);
      await opened;
      // ...and its images can be selected and edited, counted on their own.
      await actions.setEditMode(true);
      const next = state.doc.value!.pages[0];
      await actions.selectImage(0, IMAGE(0), next.rev.peek());
      selected = state.selectedImage.value;
      const heldMove = hold("transformImage");
      moving = actions.transformImage(next, IMAGE(0), MOVED, next.rev.peek());
      newCount = state.imageEditsPending.value;
      release(); // the old download ends, then the old delete, which finds its document gone
      await saving;
      await queued;
      letMoveGo = once(await heldMove);
    } finally {
      release();
      letMoveGo();
    }
    expect(afterClose).toEqual({ doc: null, pending: 0, unsaved: false, warn: false });
    expect(asked).toBeNull();
    expect(selected).toEqual({ pageIndex: 0, index: 0 });
    expect(newCount).toBe(1);
    // The old delete ended without taking the new document's edit off the count.
    expect(state.imageEditsPending.value).toBe(1);
    await moving;
    expect(state.imageEditsPending.value).toBe(0);
    expect(calls).not.toContain("deleteImage:1");
    expect(calls.filter((c) => c.startsWith("transformImage"))).toEqual(["transformImage:0"]);

    // A late edit of a page of the closed document (a frame going away late): neither counted nor sent.
    calls.length = 0;
    const late = actions.transformImage(page, IMAGE(1), MOVED, page.rev.peek());
    expect(state.imageEditsPending.value).toBe(0);
    await late;
    expect(calls).toEqual([]);
  });

  it("a replacement still being prepared when its document closes stops counting", async () => {
    const page = await editing("IV.pdf");
    await actions.selectImage(0, IMAGE(1), page.rev.peek());
    let finish!: () => void;
    (globalThis as any).__prepare = () => new Promise((done) => {
      finish = () => done({ bytes: new ArrayBuffer(3), width: 1, height: 1 });
    });
    const replacing = actions.replaceImage(page, IMAGE(1), page.rev.peek(), PICKED);
    const during = { pending: state.imageEditsPending.value, unsaved: state.hasUnsavedWork() };
    const closing = actions.closeDocument();
    await answerConfirm(true);
    await closing;
    const afterClose = { pending: state.imageEditsPending.value, warn: actions.shouldWarnBeforeUnload() };
    finish();
    await replacing;
    expect(during).toEqual({ pending: 1, unsaved: true });
    expect(afterClose).toEqual({ pending: 0, warn: false });
    expect(state.imageEditsPending.value).toBe(0);
    expect(calls).toEqual(["close"]); // no replaceImage for the closed document
  });
});

describe("U26 lengths in millimetres", () => {
  it("whole millimetres, one decimal below 10 mm, the locale's decimal separator; no grouping, no -0", async () => {
    const i18n = await import("../src/i18n");
    const pt = (mm: number) => (mm * 72) / 25.4;
    expect(i18n.formatMm(0.75)).toBe("0.3"); // a 1-px spacer picture
    expect(i18n.formatMm(pt(3.54))).toBe("3.5");
    expect(i18n.formatMm(pt(9.94))).toBe("9.9");
    expect(i18n.formatMm(pt(9.96))).toBe("10");
    expect(i18n.formatMm(pt(51.4))).toBe("51");
    expect(i18n.formatMm(14400)).toBe("5080"); // MAX_IMAGE_SIDE
    // Positions can be negative: a picture that starts left of the page.
    expect(i18n.formatMm(pt(-4.24))).toBe("-4.2");
    expect(i18n.formatMm(pt(-25.4))).toBe("-25");
    expect(i18n.formatMm(-0.01)).toBe("0");
    i18n.setLocale("it");
    expect(i18n.formatMm(0.75)).toBe("0,3");
    expect(i18n.formatMm(pt(3.54))).toBe("3,5");
    expect(i18n.formatMm(14400)).toBe("5080");
    expect(i18n.formatMm(pt(-4.24))).toBe("-4,2");
    i18n.setLocale("en");
  });
});

describe("U27 image texts", () => {
  it("the details panel's hint names the grip by touch and the knob always, wherever the frame puts them; its shortcuts list every image key", async () => {
    const panel = await import("../src/ui/DetailsPanel");
    const { isMac } = await import("../src/ui/media");
    const i18n = await import("../src/i18n");
    // The grip goes below a small picture and the knob below one near the top of the page
    // (ImageLayer's frameLayout): the hints say what they look like, not where they are.
    expect(panel.imageHint(IMAGE(0), false))
      .toBe("Drag it to move it, a corner to resize it, the small knob on the stem to rotate it.");
    expect(panel.imageHint(IMAGE(0), true))
      .toBe("Drag the round grip to move it, a corner to resize it, the small knob on the stem to rotate it.");
    expect(panel.imageHint(IMAGE(0, { movable: false, reason: "cropped" }), true))
      .toBe("Can't be moved: it is cropped by a frame that would not move with it.");
    const keys = panel.imageShortcuts();
    expect(keys.map(([key]) => key))
      .toEqual(["←↑→↓", "Shift + ←↑→↓", `${isMac ? "⌥" : "Alt"} + ←↑→↓`, "+ / −", ", / .", "Delete", "Esc"]);
    expect(keys[2][1]).toBe("Change its width or height");
    expect(keys[4][1]).toBe("Turn it by 1° (Shift: 15°)");
    i18n.setLocale("it");
    expect(panel.imageHint(IMAGE(0), false))
      .toBe("Trascinala per spostarla, un angolo per ridimensionarla, la manopola sullo stelo per ruotarla.");
    expect(panel.imageHint(IMAGE(0), true))
      .toBe("Trascina la maniglia tonda per spostarla, un angolo per ridimensionarla, la manopola sullo stelo per ruotarla.");
    for (const locale of ["en", "it"] as const) {
      i18n.setLocale(locale);
      for (const hint of [panel.imageHint(IMAGE(0), false), panel.imageHint(IMAGE(0), true)]) {
        expect(hint).not.toMatch(/(above|middle|centre|center|sopra|centro)/);
      }
    }
    i18n.setLocale("it");
    expect(panel.imageShortcuts().map(([key, action]) => `${key}: ${action}`).slice(2, 6)).toEqual([
      `${isMac ? "⌥" : "Alt"} + ←↑→↓: Cambiane larghezza o altezza`, "+ / −: Ingrandiscila o rimpiccioliscila",
      ", / .: Ruotala di 1° (Maiusc: 15°)", "Canc: Eliminala",
    ]);
    i18n.setLocale("en");
  });

  it("labels say which image it is; the bar's Deselect is not the edit banner's Done", async () => {
    const i18n = await import("../src/i18n");
    const reason = actions.lockReasonText("group");
    expect(i18n.t("image.label", { n: 2, w: "28", h: "0.3" })).toBe("Image 2, 28 × 0.3 mm");
    expect(i18n.t("image.lockedLabel", { n: 3, reason }))
      .toBe("Image 3 can't be moved: it is joined to other content, such as a caption");
    expect(i18n.t("image.status.placed", { w: "28", h: "21", x: "12", y: "40", deg: 15 }))
      .toBe("28 × 21 mm, 12 mm from the left, 40 mm from the top, 15°");
    for (const locale of ["en", "it"] as const) {
      i18n.setLocale(locale);
      expect(i18n.t("image.done")).not.toBe(i18n.t("edit.done"));
      expect(i18n.t("image.selectedLabel", { n: 1, w: "5", h: "5" })).not.toMatch(/[{}]/);
    }
    expect(i18n.t("image.lockedLabel", { n: 3, reason: actions.lockReasonText("group") }))
      .toBe("L'immagine 3 non si può spostare: è unita ad altro contenuto, per esempio una didascalia");
    expect(i18n.t("image.status.placed", { w: "28", h: "21", x: "12", y: "40", deg: 15 }))
      .toBe("28 × 21 mm, a 12 mm da sinistra e 40 mm dall'alto, 15°");
    i18n.setLocale("en");
  });

  it("every Italian text has the placeholders of the English one", async () => {
    const { en } = await import("../src/i18n/en");
    const { it: italian } = await import("../src/i18n/it");
    const names = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect({ key, names: names(italian[key]) }).toEqual({ key, names: names(en[key]) });
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Phase 3, release 3: fill and sign

const A4 = [0, 0, 595.28, 841.89] as [number, number, number, number];
/** Points per millimetre. */
const MMPT = 72 / 25.4;

/** Open a document (one page unless `info` says otherwise) in Compila e firma; returns its first page. */
async function filling(name: string, info: Record<string, unknown> = {}) {
  await openWith(name, info);
  await actions.setTool("fill");
  state.toasts.value = [];
  sent.length = 0;
  return state.doc.value!.pages[0];
}

/** What the writer registers while `w` is open with `typed` in it (FillLayer): flushEditor writes it. */
function typing(w: any, typed: string) {
  const unregister = state.registerEditor({
    changed: () => typed.trim() !== w.text.trim(),
    commit: async () => {
      unregister();
      await actions.commitWriter(w, typed, w.origin, w.size, w.color);
    },
  });
  return unregister;
}

const png = () => new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
const SIG = (extra: Record<string, unknown> = {}) => ({
  id: "sig-1", kind: "signature", png: png(), width: 300, height: 100, description: "Signature: Mario Rossi",
  source: "type", savedAt: null, ...extra,
}) as any;
const INITIALS = () => SIG({ id: "ini-1", kind: "initials", width: 200, height: 100, description: "Initials: MR" });

/** A form field widget of page 0 as the engine lists it: an empty text field unless `extra` says otherwise. */
const FIELD = (name: string, extra: Record<string, unknown> = {}) => ({
  name, index: 0, type: "text", rect: [10, 10, 90, 30], rotation: 0, label: name, value: "", multiline: false,
  comb: false, maxLen: 0, multiSelect: false, editable: false, required: false, scripted: false, format: null,
  fontSize: 0, color: [0, 0, 0], align: 0, locked: null, ...extra,
}) as any;
/** DocInfo.form with `perPage` widgets on each page, `required` of them required. */
const FORM = (perPage: number[], required: number) => ({
  form: { fieldsPerPage: perPage, fields: perPage.reduce((a, b) => a + b, 0), required, xfa: "none", scripts: false },
});

/** Wait for the dialog `kind`, take it away and return it (its resolve still to be called). */
async function takeDialog(kind: string) {
  await vi.waitFor(() => expect(state.dialog.value?.kind).toBe(kind));
  const d = state.dialog.value as any;
  state.dialog.value = null;
  return d;
}

/** The keyboard shortcuts installed on a fake window; returns press() and the function that removes them. */
async function keyboard() {
  const g = globalThis as any;
  const saved = { add: g.addEventListener, remove: g.removeEventListener, element: g.HTMLElement };
  const listeners: Record<string, (e: unknown) => void> = {};
  g.addEventListener = (type: string, fn: (e: unknown) => void) => { listeners[type] = fn; };
  g.removeEventListener = () => undefined;
  g.HTMLElement ??= class {};
  const { installShortcuts } = await import("../src/ui/shortcuts");
  const uninstall = installShortcuts();
  const press = (key: string, mods: Record<string, unknown> = {}) => {
    const e: any = {
      key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, target: null, defaultPrevented: false,
      preventDefault() { e.defaultPrevented = true; }, ...mods,
    };
    listeners.keydown(e);
    return e;
  };
  const restore = () => {
    uninstall();
    g.addEventListener = saved.add;
    g.removeEventListener = saved.remove;
    g.HTMLElement = saved.element;
  };
  return { press, restore };
}

describe("U28 the tools", () => {
  it("one at a time; editMode follows the tool; none without a document or once editing stopped", async () => {
    const page = await filling("FA.pdf");
    expect([state.tool.value, state.fillMode.value, state.editMode.value]).toEqual(["fill", true, false]);
    await actions.setTool("edit");
    expect([state.tool.value, state.fillMode.value, state.editMode.value]).toEqual(["edit", false, true]);
    await actions.setEditMode(false);
    expect(state.tool.value).toBeNull();
    await actions.setEditMode(true);
    expect(state.tool.value).toBe("edit");

    const { EngineError } = await import("../src/engine/client");
    const replace = engineImpl.replaceLine;
    engineImpl.replaceLine = async () => { throw new EngineError("lost", "broken"); };
    await actions.replaceLine(page, LINE, "x", page.rev.peek());
    engineImpl.replaceLine = replace;
    expect(state.tool.value).toBeNull();
    await actions.setTool("fill");
    expect(state.tool.value).toBeNull();
    state.showDialog(null);

    await actions.closeDocument();
    await actions.setTool("fill");
    expect(state.tool.value).toBeNull();
  });

  it("the phone tab bar: pressing the lit tool turns it off, pressing the other one switches", async () => {
    const { toolAfterTap } = await import("../src/ui/TabBar");
    expect([toolAfterTap(null, "fill"), toolAfterTap("fill", "fill"), toolAfterTap("edit", "fill")]).toEqual(["fill", null, "fill"]);
    expect([toolAfterTap(null, "edit"), toolAfterTap("edit", "edit"), toolAfterTap("fill", "edit")]).toEqual(["edit", null, "edit"]);
  });

  it("changing the tool writes the writer first, then closes it, the signature waiting and the focused field", async () => {
    state.writerStyle.value = { size: 11, color: "black" };
    const page = await filling("FB.pdf");
    await actions.openWriterAt(0, [10, 50], "text");
    const w = state.openWriter.value!;
    expect(w).toEqual({
      pageIndex: 0, origin: [10, 50], text: "", size: 11, color: "black", kind: "text", editing: null, rev: page.rev.peek(),
    });
    const unregister = typing(w, "Mario Rossi");
    state.pendingPlacement.value = SIG();
    state.focusedField.value = { pageIndex: 0, name: "nome", index: 0 };
    await actions.setTool("edit");
    unregister();
    expect(calls).toEqual(["addText:0:Mario Rossi"]);
    expect(sent).toEqual([{
      origin: [10, 50], text: "Mario Rossi", style: { size: 11, color: [0, 0, 0], family: "sans", bold: false, italic: false },
    }]);
    expect([state.openWriter.value, state.pendingPlacement.value, state.focusedField.value]).toEqual([null, null, null]);
    expect(state.dirty.value).toBe(true);
    expect(state.editMode.value).toBe(true);
  });
});

describe("U29 Escape in Compila e firma", () => {
  it("closes the writer (nothing written), then cancels the signature waiting, then deselects the picture, then leaves", async () => {
    const { press, restore } = await keyboard();
    try {
      const page = await filling("FC.pdf");
      await actions.openWriterAt(0, [10, 50], "text");
      const unregister = typing(state.openWriter.value!, "typed");
      expect(press("Escape").defaultPrevented).toBe(true);
      expect(state.openWriter.value).toBeNull();
      await state.flushEditor(); // asked before the writer has unregistered: it writes nothing
      unregister();
      expect(calls).toEqual([]);
      expect(state.fillMode.value).toBe(true);

      actions.setFillTool("signature");
      expect(state.dialog.value).toEqual({ kind: "signature", mode: "signature", forField: null });
      actions.useSignature(SIG());
      expect(state.dialog.value).toBeNull();
      expect(state.pendingPlacement.value?.id).toBe("sig-1");
      expect(state.fillTool.value).toBe("signature");
      press("Escape");
      expect(state.pendingPlacement.value).toBeNull();
      expect(state.fillTool.value).toBe("text");
      expect(state.fillMode.value).toBe(true);

      // Only the pictures the user added are selected here.
      await actions.selectImage(0, IMAGE(0), page.rev.peek());
      expect(state.selectedImage.value).toBeNull();
      await actions.selectImage(0, IMAGE(1, { added: true }), page.rev.peek());
      expect(state.selectedImage.value).toEqual({ pageIndex: 0, index: 1 });
      press("Escape");
      await vi.waitFor(() => expect(state.selectedImage.value).toBeNull());
      expect(state.fillMode.value).toBe(true);
      press("Escape");
      await vi.waitFor(() => expect(state.fillMode.value).toBe(false));
      expect(press("Escape").defaultPrevented).toBe(false); // browse: nothing to close
    } finally {
      restore();
    }
  });
});

describe("U30 the text writer", () => {
  it("a tap with a writer open writes it and opens a new one there; only spaces write nothing", async () => {
    state.writerStyle.value = { size: 11, color: "black" };
    const page = await filling("FD.pdf");
    await actions.openWriterAt(0, [10, 50], "text");
    let unregister = typing(state.openWriter.value!, "Nome");
    await actions.openWriterAt(0, [10, 80], "text");
    unregister();
    expect(calls).toEqual(["addText:0:Nome"]);
    // Opened after the text before it was written: its revision includes it.
    expect(state.openWriter.value).toMatchObject({ origin: [10, 80], text: "", editing: null, rev: page.rev.peek() });

    unregister = typing(state.openWriter.value!, "   ");
    await actions.openWriterAt(0, [10, 95], "text");
    unregister();
    expect(calls).toEqual(["addText:0:Nome"]);
    expect(state.openWriter.value?.origin).toEqual([10, 95]);
  });

  it("a writer that closed with its blur is written before the next one opens on its page", async () => {
    const page = await filling("FD2.pdf");
    await actions.openWriterAt(0, [10, 50], "text");
    const w = state.openWriter.value!;
    const held = hold("addText");
    const blurred = actions.commitWriter(w, "Prima", w.origin, w.size, w.color); // the writer goes with it
    const release = await held;
    const dopo = {
      id: 3, text: "Dopo", origin: [10, 90], style: { size: 11, color: [0, 0, 0], family: "sans", bold: false, italic: false },
      bbox: [10, 80, 40, 92],
    } as any;
    const opening = actions.reopenAdded(0, dopo);
    const before = state.openWriter.value;
    // The page changed meanwhile: the text is read again before the writer opens.
    const texts = engineImpl.addedTexts;
    engineImpl.addedTexts = async () => [dopo];
    try {
      release();
      await blurred;
      await opening;
    } finally {
      engineImpl.addedTexts = texts;
    }
    expect(before).toBeNull();
    expect(state.openWriter.value).toMatchObject({ editing: 3, text: "Dopo", rev: page.rev.peek() });
  });

  it("its Enter and the blur after it write once; Line below writes it and opens the next line 1.25 em lower", async () => {
    state.writerStyle.value = { size: 11, color: "black" };
    await filling("FE.pdf");
    await actions.openWriterAt(0, [10, 50], "text");
    const w = state.openWriter.value!;
    const writing = actions.writeAndNewLine(w, "Riga 1", w.origin, 14, "blue");
    // The next line is open at once, in the same size and ink (the keyboard stays up).
    expect(state.openWriter.value).toMatchObject({
      pageIndex: 0, origin: [10, 50 + 1.25 * 14], text: "", size: 14, color: "blue", kind: "text", editing: null,
    });
    await writing;
    await actions.commitWriter(w, "Riga 1", w.origin, 14, "blue"); // its blur afterwards
    expect(calls).toEqual(["addText:0:Riga 1"]);
    expect(sent[0].style).toEqual({ size: 14, color: state.INK.blue, family: "sans", bold: false, italic: false });
    expect(state.writerStyle.value).toEqual({ size: 14, color: "blue" });
    await actions.openWriterAt(0, [10, 200], "text");
    expect(state.openWriter.value).toMatchObject({ size: 14, color: "blue" });
  });

  it("the download waits for the writer", async () => {
    fakePicker();
    await filling("FF.pdf");
    await actions.openWriterAt(0, [10, 50], "text");
    const unregister = typing(state.openWriter.value!, "Firmato");
    expect(state.hasUnsavedWork()).toBe(true);
    await actions.download();
    unregister();
    expect(calls).toEqual(["addText:0:Firmato", "save"]);
    expect(state.dirty.value).toBe(false);
  });

  it("a page the engine cannot add to says so, not the line editor's words", async () => {
    await filling("FF2.pdf");
    const { EngineError } = await import("../src/engine/client");
    const add = engineImpl.addText;
    engineImpl.addText = async () => { throw new EngineError("content ends inside a string", "not-editable"); };
    await actions.openWriterAt(0, [10, 50], "check");
    engineImpl.addText = add;
    expect(toastTexts()).toEqual(["You can't add text or pictures to this page: its content can't be changed safely."]);
    expect(state.dirty.value).toBe(false);
  });
});

describe("U31 marks, dates and texts written before", () => {
  it("a tick, a cross and the date are written at once, the marks at 1.1 × the size; the sub-tool stays", async () => {
    await filling("FG.pdf");
    state.writerStyle.value = { size: 10, color: "blue" };
    state.fillTool.value = "check";
    await actions.openWriterAt(0, [20, 30], "check");
    await actions.openWriterAt(0, [20, 40], "cross");
    await actions.openWriterAt(0, [20, 50], "date");
    expect(calls).toEqual(["addText:0:✓", "addText:0:✗", `addText:0:${actions.todayText()}`]);
    expect(sent.map((x) => x.style.size)).toEqual([expect.closeTo(11), expect.closeTo(11), 10]);
    expect(sent.map((x) => x.origin)).toEqual([[20, 30], [20, 40], [20, 50]]);
    expect(sent[0].style.color).toEqual(state.INK.blue);
    expect(state.openWriter.value).toBeNull();
    expect(state.fillTool.value).toBe("check");
    const i18n = await import("../src/i18n");
    i18n.setLocale("it");
    expect(actions.todayText()).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    expect(actions.todayText("long")).toMatch(/^\d{1,2} \p{L}+ \d{4}$/u);
    i18n.setLocale("en");
  });

  it("reopened, a text changes only what changed; cleared, it is deleted; Delete is not written back; a stale page is refused", async () => {
    const page = await filling("FH.pdf");
    const style = { size: 11, color: [0, 0, 0], family: "sans", bold: false, italic: false };
    const tick = { id: 7, text: "✓", origin: [20, 30], style, bbox: [20, 20, 30, 31] } as any;
    await actions.reopenAdded(0, tick);
    let w = state.openWriter.value!;
    expect(w).toEqual({ pageIndex: 0, origin: [20, 30], text: "✓", size: 11, color: "black", kind: "check", editing: 7, rev: page.rev.peek() });
    await actions.commitWriter(w, "✓", w.origin, w.size, w.color);
    expect(calls).toEqual([]); // nothing changed: nothing written, no step

    await actions.reopenAdded(0, tick);
    w = state.openWriter.value!;
    await actions.commitWriter(w, "✗", w.origin, w.size, w.color); // "Change to ✗"
    expect(calls).toEqual(["editAddedText:7"]);
    expect(sent.at(-1)).toEqual({ text: "✗" });

    // Moved, larger and blue: the place and the style, its own font kept.
    const name = { id: 8, text: "Mario", origin: [20, 60], style: { ...style, family: "serif", bold: true }, bbox: [20, 50, 60, 62] } as any;
    await actions.reopenAdded(0, name);
    w = state.openWriter.value!;
    expect(w.kind).toBe("text");
    await actions.commitWriter(w, "Mario", [25, 60], 12, "blue");
    expect(sent.at(-1)).toEqual({ origin: [25, 60], style: { size: 12, color: state.INK.blue, family: "serif", bold: true, italic: false } });

    // Cleared and applied: deleted.
    await actions.reopenAdded(0, name);
    w = state.openWriter.value!;
    await actions.commitWriter(w, "  ", w.origin, w.size, w.color);
    expect(sent.at(-1)).toEqual({ text: "" });

    // Delete in the writer: its blur afterwards writes nothing more.
    await actions.reopenAdded(0, name);
    w = state.openWriter.value!;
    calls.length = 0;
    await actions.deleteAdded(0, 8, w.rev);
    expect(state.openWriter.value).toBeNull();
    await actions.commitWriter(w, "Mario", w.origin, w.size, w.color);
    expect(calls).toEqual(["editAddedText:8"]);
    expect(sent.at(-1)).toEqual({ text: "" });

    state.toasts.value = [];
    await actions.deleteAdded(0, 8, page.rev.peek() - 1);
    expect(calls).toEqual(["editAddedText:8"]);
    expect(toastTexts()).toEqual(["Could not write this text."]);

    expect(["16/10/2026", "10/16/2026", "16 ottobre 2026", "16 October 2026", "October 16, 2026", "Nome", "✓ Sì"]
      .map(actions.addedKind)).toEqual(["date", "date", "date", "date", "date", "text", "text"]);
  });
});

describe("U32 form fields", () => {
  it("a value is one edit, by name; the overlays read the values again; a stale page, a locked field and Modifica are refused", async () => {
    const page = await filling("FI.pdf", FORM([1], 0));
    const nome = FIELD("nome");
    page.fields.value = { rev: page.rev.peek(), fields: [nome] };
    const rev = page.rev.peek();
    await actions.setFieldValue(0, nome, { kind: "text", text: "Mario" }, rev);
    expect(calls).toEqual(["setField:nome"]);
    expect(sent).toEqual([{ kind: "text", text: "Mario" }]);
    expect(page.fields.value).toBeNull(); // read again, with the value the engine now has
    expect(page.rev.peek()).toBe(rev + 1);
    expect(state.dirty.value).toBe(true);

    await actions.setFieldValue(0, nome, { kind: "text", text: "Maria" }, rev);
    expect(calls).toEqual(["setField:nome"]);
    expect(toastTexts()).toEqual(["Could not fill in this field."]);

    state.toasts.value = [];
    await actions.setFieldValue(0, FIELD("codice", { locked: "read-only" }), { kind: "text", text: "x" }, page.rev.peek());
    expect(toastTexts()).toEqual(["This field can't be changed."]);

    // With no tool on the fields work (D2); in Modifica they are not there.
    await actions.setTool(null);
    await actions.setFieldValue(0, FIELD("ok", { type: "checkbox", onState: "Yes" }), { kind: "state", state: "Yes" }, page.rev.peek());
    await actions.setTool("edit");
    await actions.setFieldValue(0, nome, { kind: "text", text: "Mario" }, page.rev.peek());
    expect(calls).toEqual(["setField:nome", "setField:ok"]);

    // Undo: the focus goes and the values are read again.
    await actions.setTool("fill");
    page.fields.value = { rev: page.rev.peek(), fields: [nome] };
    state.focusedField.value = { pageIndex: 0, name: "nome", index: 0 };
    await actions.undo();
    expect(state.focusedField.value).toBeNull();
    expect(page.fields.value).toBeNull();
  });

  it("a box ticked while the writer's text is still on its way is not refused", async () => {
    const page = await filling("FI3.pdf", FORM([1], 0));
    await actions.openWriterAt(0, [10, 50], "text");
    const w = state.openWriter.value!;
    const held = hold("addText");
    const writing = actions.commitWriter(w, "Nome", w.origin, w.size, w.color); // its blur, as the box is tapped
    const release = await held;
    const ticking = actions.setFieldValue(0, FIELD("ok", { type: "checkbox" }), { kind: "state", state: "Yes" }, page.rev.peek());
    release();
    await writing;
    await ticking;
    expect(calls).toEqual(["addText:0:Nome", "setField:ok"]);
    expect(toastTexts()).toEqual([]);
  });

  it("the same value records nothing; a text too long for its box and characters no font has say so", async () => {
    const page = await filling("FI2.pdf", FORM([1], 0));
    const set = engineImpl.setField;
    try {
      engineImpl.setField = async (name: string) => ({
        editCount: 0, canUndo: false, canRedo: false, changedPages: [], name, missingChars: [], overflow: false,
      });
      await actions.setFieldValue(0, FIELD("nome"), { kind: "text", text: "" }, page.rev.peek());
      expect(state.dirty.value).toBe(false);
      engineImpl.setField = async (name: string) => ({
        editCount: 1, canUndo: true, canRedo: false, changedPages: [0], name, missingChars: ["\u{10FFFD}"], overflow: true,
      });
      await actions.setFieldValue(0, FIELD("nome"), { kind: "text", text: "molto lungo" }, page.rev.peek());
    } finally {
      engineImpl.setField = set;
    }
    const i18n = await import("../src/i18n");
    expect(toastTexts()).toEqual([
      i18n.t("edit.missing", { chars: "\u{10FFFD}" }),
      "The text doesn't fit in the field: some of it may not show or print.",
    ]);
  });

  it("next field: across pages, in tab order, round to the start; the empty ones only; the field's other widgets skipped", async () => {
    const twoPages = [{ index: 0, bounds: [0, 0, 100, 100] }, { index: 1, bounds: [0, 0, 100, 100] }];
    await filling("FJ0.pdf", { pageCount: 2, pages: twoPages, ...FORM([2, 3], 0) });
    const fields = engineImpl.fields;
    engineImpl.fields = async (p: number) => p === 0
      ? [FIELD("a", { value: "x" }), FIELD("r", { index: 1, type: "radio", value: "Off" })]
      : [FIELD("r", { type: "radio", value: "Off" }), FIELD("b", { index: 1 }), FIELD("ro", { index: 2, locked: "read-only" })];
    try {
      expect(await actions.focusNextField({ pageIndex: 0, index: 0, name: "a" })).toBe(true);
      expect(state.focusedField.value).toEqual({ pageIndex: 0, name: "r", index: 1 });
      await actions.focusNextField({ pageIndex: 0, index: 1, name: "r" });
      expect(state.focusedField.value).toEqual({ pageIndex: 1, name: "b", index: 1 });
      await actions.focusNextField({ pageIndex: 1, index: 1, name: "b" }); // the read-only one is skipped, round to the start
      expect(state.focusedField.value).toEqual({ pageIndex: 0, name: "a", index: 0 });
      await actions.focusNextField(null, true);
      expect(state.focusedField.value).toEqual({ pageIndex: 0, name: "r", index: 1 });
    } finally {
      engineImpl.fields = fields;
    }
  });
});

describe("U33 empty required fields at download", () => {
  it("asked once per document; Fill them in focuses the first (Modifica gives way) and writes nothing", async () => {
    fakePicker();
    const fields = engineImpl.fields;
    engineImpl.fields = async () => [
      FIELD("nome", { required: true }),
      FIELD("cognome", { index: 1, required: true, value: "Rossi" }),
      FIELD("firma", { index: 2, type: "signature", required: true, locked: "signature" }),
      FIELD("privacy", { index: 3, type: "checkbox", required: true, value: "Off" }),
    ];
    try {
      await filling("FK.pdf", FORM([4], 4));
      await actions.setTool("edit");
      let p = actions.download();
      let d = await takeDialog("missing-fields");
      expect(d.count).toBe(2); // the signature field is signed with the Sign tool: not counted
      d.resolve("fill");
      await p;
      expect(calls).toEqual([]);
      expect(state.tool.value).toBe("fill");
      expect(state.focusedField.value).toEqual({ pageIndex: 0, name: "nome", index: 0 });
      await actions.download(); // asked once: straight on
      expect(calls).toEqual(["save"]);

      // Another document is asked again. Cancel writes nothing and asks again next time.
      await openWith("FL.pdf", FORM([4], 4));
      p = actions.download();
      d = await takeDialog("missing-fields");
      d.resolve(null);
      await p;
      expect(calls).toEqual([]);
      p = actions.download();
      d = await takeDialog("missing-fields");
      d.resolve("download");
      await p;
      expect(calls).toEqual(["save"]);

      // Another dialog taking the question's place answers it Cancel.
      await openWith("FL2.pdf", FORM([4], 4));
      p = actions.download();
      await vi.waitFor(() => expect(state.dialog.value?.kind).toBe("missing-fields"));
      state.showDialog({ kind: "alert", title: "x", body: "y" });
      await p;
      state.showDialog(null);
      expect(calls).toEqual([]);

      // All filled in: no question.
      engineImpl.fields = async () => [FIELD("nome", { required: true, value: "Mario" })];
      await openWith("FM0.pdf", FORM([1], 1));
      await actions.download();
      expect(calls).toEqual(["save"]);
      expect(state.dialog.value).toBeNull();
    } finally {
      engineImpl.fields = fields;
    }
  });
});

describe("U34 signatures", () => {
  it("chosen in the sheet, it waits for a tap; placed, it is one edit, selected with its frame, and Firma goes back to Testo", async () => {
    const page = await filling("FN.pdf");
    actions.setFillTool("signature");
    expect(state.dialog.value).toEqual({ kind: "signature", mode: "signature", forField: null });
    expect(state.fillTool.value).toBe("signature");
    const sig = SIG();
    actions.useSignature(sig);
    expect(state.dialog.value).toBeNull();
    expect(state.pendingPlacement.value).toBe(sig);
    expect(state.sessionSignatures.value[0]).toBe(sig);
    const matrix = [141.7, 0, 0, 47.2, 10, 40] as any;
    const placing = actions.placeSignature(0, sig, matrix);
    expect(state.pendingPlacement.value).toBeNull(); // used up at once: a second tap places nothing
    await placing;
    expect(calls).toEqual(["addImage:0"]);
    expect(sent[0].targets).toEqual([{ pageIndex: 0, matrix }]);
    expect(sent[0].alt).toBe("Signature: Mario Rossi");
    expect([...new Uint8Array(sent[0].bytes)]).toEqual([137, 80, 78, 71]);
    expect(state.selectedImage.value).toEqual({ pageIndex: 0, index: 5 });
    expect(state.fillTool.value).toBe("text");
    expect(toastTexts()).toEqual(["Signature on page 1. Drag it to move it."]);
    expect(state.initialsSource.value).toBeNull(); // a signature, not initials
    expect(page.images.value).toBeNull();
    expect(state.imageEditsPending.value).toBe(0);
  });

  it("the sheet closed without one: back to Testo; Sign here on a field puts it inside the box, Compila e firma turned on", async () => {
    await filling("FO.pdf");
    actions.setFillTool("initials");
    expect(state.fillTool.value).toBe("initials");
    state.showDialog(null);
    expect(state.fillTool.value).toBe("text");

    await actions.setTool(null);
    state.showDialog({ kind: "signature", mode: "signature", forField: { pageIndex: 0, rect: [10, 10, 110, 40], rotation: 0 } });
    actions.useSignature(SIG());
    await vi.waitFor(() => expect(calls).toEqual(["addImage:0"]));
    expect(state.tool.value).toBe("fill");
    // 3:1 inside 100 × 30: 90 × 30, centred across, on the box's bottom.
    expect(sent[0].targets[0].matrix).toEqual([90, 0, 0, 30, 15, 10]);
    expect(state.pendingPlacement.value).toBeNull();
  });

  it("the signature waiting goes with undo and with a change of tool", async () => {
    await filling("FP.pdf");
    state.recordHistory({ editCount: 1, canUndo: true, canRedo: false, changedPages: [0] }, "edit");
    actions.useSignature(SIG());
    await actions.undo();
    expect(state.pendingPlacement.value).toBeNull();
    expect(state.fillTool.value).toBe("text");
    actions.useSignature(SIG());
    await actions.setTool("edit");
    expect(state.pendingPlacement.value).toBeNull();
    expect(state.fillTool.value).toBe("text");
  });

  it("kept on the device only when asked, then listed as saved; forgotten at once; refused storage says false", async () => {
    await filling("FQ0.pdf");
    const g = globalThis as any;
    const sig = SIG({ id: "sig-keep" });
    actions.useSignature(sig);
    expect(state.savedSignatures.value.map((s) => s.id)).not.toContain("sig-keep"); // this session only, by default
    expect(await actions.rememberSignature(sig)).toBe(true);
    expect(g.__stored.has("sig-keep")).toBe(true);
    expect(state.savedSignatures.value.map((s) => s.id)).toContain("sig-keep");
    expect(state.pendingPlacement.value?.savedAt).toEqual(expect.any(Number));
    state.toasts.value = [];
    await actions.forgetSignature("sig-keep");
    expect(g.__stored.has("sig-keep")).toBe(false);
    expect(state.sessionSignatures.value.map((s) => s.id)).not.toContain("sig-keep");
    expect(toastTexts()).toEqual(["Signature forgotten."]);
    g.__storeRefuses = true;
    try {
      expect(await actions.rememberSignature(SIG({ id: "sig-no" }))).toBe(false);
    } finally {
      g.__storeRefuses = false;
    }
    expect(state.savedSignatures.value.map((s) => s.id)).not.toContain("sig-no");
  });
});

describe("U35 initials on every page", () => {
  const PAGES = [{ index: 0, bounds: A4 }, { index: 1, bounds: [0, 0, 841.89, 595.28] }, { index: 2, bounds: [0, 0, 612, 792] }];
  // 12 × 6 mm, 15 mm from the right and 10 mm from the bottom of the A4 page.
  const W = 12 * MMPT, H = 6 * MMPT;
  const AT = [W, 0, 0, H, A4[2] - 15 * MMPT - W, A4[3] - 10 * MMPT - H] as any;

  it("one addImage for the pages chosen, as far from the nearest corner on every page size: one history step", async () => {
    await filling("FQ.pdf", { pageCount: 3, pages: PAGES });
    const ini = INITIALS();
    actions.useSignature(ini);
    await actions.placeSignature(0, ini, AT);
    expect(state.initialsSource.value).toMatchObject({ pageIndex: 0, imageIndex: 5, sig: ini });
    expect(toastTexts()).toEqual(["Initials on page 1. Drag them to move them."]);
    const images = engineImpl.images;
    engineImpl.images = async (p: number) => (p === 0 ? [IMAGE(5, { matrix: AT, added: true })] : []);
    try {
      state.toasts.value = [];
      const placing = actions.placeInitialsOnPages(0, 5);
      const d = await takeDialog("initials-pages");
      expect(d).toMatchObject({ pageIndex: 0, imageIndex: 5 });
      const choices = actions.initialsChoices(0, 3);
      expect(choices).toEqual({ all: [1, 2], allButLast: [1] });
      d.resolve(choices.all);
      await placing;
    } finally {
      engineImpl.images = images;
    }
    expect(calls).toEqual(["addImage:0", "addImage:1,2"]);
    const copies = sent[1];
    expect(copies.alt).toBe("Initials: MR");
    expect(copies.targets.map((x: any) => x.pageIndex)).toEqual([1, 2]);
    for (const { pageIndex, matrix } of copies.targets) {
      const b = PAGES[pageIndex].bounds;
      expect(matrix[0]).toBeCloseTo(W, 6);
      expect(matrix[3]).toBeCloseTo(H, 6);
      expect((b[2] - (matrix[4] + matrix[0])) / MMPT).toBeCloseTo(15, 6);
      expect((b[3] - (matrix[5] + matrix[3])) / MMPT).toBeCloseTo(10, 6);
    }
    expect(toastTexts()).toEqual(["Initials added to 2 pages."]);
    expect(state.selectedImage.value).toEqual({ pageIndex: 0, index: 5 }); // the original stays selected
    expect([...state.editedPages.value].sort()).toEqual([0, 1, 2]);
    await actions.undo(); // the copies are one step
    expect([...state.editedPages.value]).toEqual([0]);
    expect(actions.initialsChoices(2, 3)).toEqual({ all: [0, 1], allButLast: [0, 1] });
  });

  it("followed through edits; Cancel, or another dialog, adds nothing; initials gone with an undo are not copied", async () => {
    const page = await filling("FR.pdf", { pageCount: 3, pages: PAGES });
    const ini = INITIALS();
    await actions.placeSignature(0, ini, AT);
    await actions.transformImage(page, IMAGE(5, { added: true }), MOVED, page.rev.peek());
    expect(state.initialsSource.value?.imageIndex).toBe(5);
    await actions.deleteImage(page, IMAGE(2), page.rev.peek()); // painted before them: they move up one place
    expect(state.initialsSource.value?.imageIndex).toBe(4);

    let placing = actions.placeInitialsOnPages(0, 4);
    (await takeDialog("initials-pages")).resolve(null);
    await placing;
    placing = actions.placeInitialsOnPages(0, 4);
    await vi.waitFor(() => expect(state.dialog.value?.kind).toBe("initials-pages"));
    state.showDialog({ kind: "alert", title: "x", body: "y" });
    await placing;
    state.showDialog(null);
    expect(calls).toEqual(["addImage:0", "transformImage:5", "deleteImage:2"]);

    await actions.undo();
    expect(state.initialsSource.value).toBeNull();
    state.toasts.value = [];
    await actions.placeInitialsOnPages(0, 4);
    expect(state.dialog.value).toBeNull();
    expect(toastTexts()).toEqual(["Could not add the initials to the other pages."]);
  });
});

/** document.createElement making inputs whose listeners a test can call (the picture picker's). */
function pickerInputs() {
  const inputs: any[] = [];
  const doc = (globalThis as any).document;
  const createElement = doc.createElement;
  doc.createElement = (tag: string) => {
    const el: any = {
      tag, listeners: {}, clicked: false, removed: false,
      addEventListener(type: string, fn: () => void) { el.listeners[type] = fn; },
      setAttribute() { /* aria-hidden */ },
      click() { el.clicked = true; },
      remove() { el.removed = true; },
    };
    inputs.push(el);
    return el;
  };
  return { inputs, restore: () => { doc.createElement = createElement; } };
}

describe("U36 a picture from a file", () => {
  it("prepared, placed in the middle of the page at most 60 % of its width, selected", async () => {
    await filling("FS.pdf", { pages: [{ index: 0, bounds: [0, 0, 600, 800] }] });
    const bytes = new Uint8Array([9, 9]).buffer;
    (globalThis as any).__prepare = async () => ({ bytes, width: 2000, height: 1000 });
    await actions.addPictureFromFile(PICKED);
    expect(calls).toEqual(["addImage:0"]);
    // 60 % of 600 pt: 360 × 180, in the middle (no viewer here: the whole page counts as what shows).
    expect(sent[0]).toEqual({ bytes, targets: [{ pageIndex: 0, matrix: [360, 0, 0, 180, 120, 310] }], alt: null });
    expect(state.selectedImage.value).toEqual({ pageIndex: 0, index: 5 });
    expect(toastTexts()).toEqual(["Image added on page 1. Drag it where you want."]);
    expect(state.imageEditsPending.value).toBe(0);
    // A small picture keeps its own size (150 ppi); a tall one is held to 60 % of the height.
    const view = [0, 0, 600, 800] as any;
    expect(actions.pictureMatrix(view, view, 300, 150)).toEqual([144, 0, 0, 72, 228, 364]);
    expect(actions.pictureMatrix(view, view, 1000, 4000)).toEqual([120, 0, 0, 480, 240, 160]);
  });

  it("Aggiungi immagine in Modifica opens the picture picker, and adds the picture chosen, selected", async () => {
    await editing("FT.pdf");
    (globalThis as any).__prepare = async () => ({ bytes: new ArrayBuffer(2), width: 100, height: 100 });
    const { inputs, restore } = pickerInputs();
    try {
      actions.chooseNewPicture();
      expect(inputs).toHaveLength(1);
      expect(inputs[0]).toMatchObject({ tag: "input", type: "file", accept: "image/*", clicked: true });
      inputs[0].files = [PICKED];
      inputs[0].listeners.change();
      await vi.waitFor(() => expect(calls).toEqual(["addImage:0"]));
      await vi.waitFor(() => expect(state.selectedImage.value).toEqual({ pageIndex: 0, index: 5 }));
      expect(state.editMode.value).toBe(true);
    } finally {
      restore();
    }
  });
});

describe("U37 undo in Compila e firma", () => {
  it("writes the writer first, then undoes it; the writer, the focused field and the selection go", async () => {
    await filling("FU.pdf");
    await actions.openWriterAt(0, [10, 50], "text");
    const unregister = typing(state.openWriter.value!, "Scritto");
    state.focusedField.value = { pageIndex: 0, name: "x", index: 0 };
    await actions.undo();
    unregister();
    expect(calls).toEqual(["addText:0:Scritto", "undo"]);
    expect([state.openWriter.value, state.focusedField.value, state.selectedImage.value]).toEqual([null, null, null]);
  });
});

// ---------------------------------------------------------------------------------------------
// Release 3, after its review

/** A text the user wrote on page 0, as the engine lists it. */
const ADDED = (id: number, text: string, origin: number[] = [20, 60]) => ({
  id, text, origin, style: { size: 11, color: [0, 0, 0], family: "sans", bold: false, italic: false },
  bbox: [origin[0], origin[1] - 9, origin[0] + 30, origin[1] + 3],
}) as any;
const SIGNED_AT = [60, 0, 0, 20, 10, 10] as any;

describe("U38 a picture that lands while the writer is open", () => {
  it("leaves the writer open with what is typed: the picture is placed, not selected; the line editor is not closed either", async () => {
    await filling("FV.pdf");
    let held = hold("addImage");
    const placing = actions.placeSignature(0, SIG(), SIGNED_AT);
    let release = await held;
    await actions.openWriterAt(0, [10, 50], "text"); // a tap while the signature is on its way
    const w = state.openWriter.value!;
    expect(w).toMatchObject({ editing: null, origin: [10, 50] });
    const unregister = typing(w, "Roma, 16 ottobre");
    release();
    await placing;
    expect(state.openWriter.value).toBe(w);
    expect(state.selectedImage.value).toBeNull();
    expect(toastTexts()).toEqual(["Signature on page 1. Drag it to move it."]);
    expect(state.hasUnsavedWork()).toBe(true);
    await state.flushEditor();
    unregister();
    expect(calls).toEqual(["addImage:0", "addText:0:Roma, 16 ottobre"]);

    held = hold("addImage");
    const again = actions.placeSignature(0, SIG(), SIGNED_AT);
    release = await held;
    await actions.setTool("edit");
    state.editingLine.value = { pageIndex: 0, line: LINE };
    release();
    await again;
    expect(state.editingLine.value).toEqual({ pageIndex: 0, line: LINE });
    expect(state.selectedImage.value).toBeNull();
    state.editingLine.value = null;
  });

  it("a text reopened while the picture is on its way opens once it has landed, and can be changed", async () => {
    const page = await filling("FW.pdf");
    const mario = ADDED(4, "Mario");
    const held = hold("addImage");
    const placing = actions.placeSignature(0, SIG(), SIGNED_AT);
    const release = await held;
    const texts = engineImpl.addedTexts;
    engineImpl.addedTexts = async () => [mario];
    try {
      const opening = actions.reopenAdded(0, mario);
      await new Promise((r) => setTimeout(r, 10));
      expect(state.openWriter.value).toBeNull(); // waits for the picture
      release();
      await placing;
      await opening;
    } finally {
      engineImpl.addedTexts = texts;
    }
    const w = state.openWriter.value!;
    expect(w).toMatchObject({ editing: 4, text: "Mario", rev: page.rev.peek() });
    expect(state.selectedImage.value).toBeNull(); // the writer, asked for later, has it
    await actions.commitWriter(w, "Mario Rossi", w.origin, w.size, w.color);
    expect(calls).toEqual(["addImage:0", "editAddedText:4"]);
    expect(toastTexts()).not.toContain("Could not write this text.");
  });

  it("choosing a signature writes the writer still open instead of dropping it", async () => {
    await filling("FW2.pdf");
    await actions.openWriterAt(0, [10, 50], "text");
    const unregister = typing(state.openWriter.value!, "Nome");
    state.showDialog({ kind: "signature", mode: "signature", forField: null });
    actions.useSignature(SIG());
    await vi.waitFor(() => expect(calls).toEqual(["addText:0:Nome"]));
    unregister();
    expect(state.openWriter.value).toBeNull();
    expect(state.pendingPlacement.value?.id).toBe("sig-1");
  });
});

describe("U39 a text reopened while an undo runs", () => {
  it("opens once the undo has landed, at its revision: it can still be changed or deleted", async () => {
    const page = await filling("FX.pdf");
    state.recordHistory({ editCount: 1, canUndo: true, canRedo: false, changedPages: [0] }, "edit");
    const mario = ADDED(4, "Mario");
    const held = hold("undo");
    const undoing = actions.undo();
    const release = await held;
    const texts = engineImpl.addedTexts;
    engineImpl.addedTexts = async () => [mario];
    try {
      const opening = actions.reopenAdded(0, mario);
      await new Promise((r) => setTimeout(r, 10));
      expect(state.openWriter.value).toBeNull();
      release();
      await undoing;
      await opening;
    } finally {
      engineImpl.addedTexts = texts;
    }
    const w = state.openWriter.value!;
    expect(w).toMatchObject({ editing: 4, rev: page.rev.peek() });
    await actions.deleteAdded(0, 4, w.rev);
    expect(calls).toEqual(["undo", "editAddedText:4"]);
    expect(toastTexts()).toEqual([]);
  });

  it("a text the undo took away does not open; one it changed opens as it is now", async () => {
    await filling("FX2.pdf");
    const texts = engineImpl.addedTexts;
    try {
      for (const now of [[], [ADDED(4, "Maria", [30, 70])]]) {
        state.recordHistory({ editCount: 1, canUndo: true, canRedo: false, changedPages: [0] }, "edit");
        const held = hold("undo");
        const undoing = actions.undo();
        const release = await held;
        engineImpl.addedTexts = async () => now;
        const opening = actions.reopenAdded(0, ADDED(4, "Mario"));
        release();
        await undoing;
        await opening;
        if (!now.length) expect(state.openWriter.value).toBeNull();
      }
    } finally {
      engineImpl.addedTexts = texts;
    }
    expect(state.openWriter.value).toMatchObject({ editing: 4, text: "Maria", origin: [30, 70] });
    actions.cancelWriter();
  });

  it("a writer asked for afterwards wins over the one still on its way", async () => {
    await filling("FX3.pdf");
    state.recordHistory({ editCount: 1, canUndo: true, canRedo: false, changedPages: [0] }, "edit");
    const held = hold("undo");
    const undoing = actions.undo();
    const release = await held;
    const texts = engineImpl.addedTexts;
    engineImpl.addedTexts = async () => [ADDED(4, "Mario")];
    try {
      const opening = actions.reopenAdded(0, ADDED(4, "Mario"));
      await actions.openWriterAt(0, [10, 30], "text"); // a tap elsewhere meanwhile
      release();
      await undoing;
      await opening;
    } finally {
      engineImpl.addedTexts = texts;
    }
    expect(state.openWriter.value).toMatchObject({ editing: null, origin: [10, 30] });
    actions.cancelWriter();
  });

  it("a new text's writer opened while the undo waits its turn keeps what is typed through it", async () => {
    const page = await filling("FX4.pdf", FORM([1], 0));
    state.recordHistory({ editCount: 1, canUndo: true, canRedo: false, changedPages: [0] }, "edit");
    const held = hold("setField");
    const ticking = actions.setFieldValue(0, FIELD("ok", { type: "checkbox" }), { kind: "state", state: "Yes" }, page.rev.peek());
    const release = await held;
    const undoing = actions.undo(); // behind the tick
    await actions.openWriterAt(0, [10, 50], "text");
    const w = state.openWriter.value!;
    const unregister = typing(w, "Ciao");
    release();
    await ticking;
    await undoing;
    expect(state.openWriter.value).toBe(w);
    await state.flushEditor();
    unregister();
    expect(calls).toEqual(["setField:ok", "undo", "addText:0:Ciao"]);
  });
});

describe("U40 new texts stay on the page", () => {
  it("originOnPage: capitals under the top, descenders above the bottom, the width before the right edge", () => {
    const b = [0, 0, 100, 200] as any;
    expect(actions.originOnPage(b, [50, 100], 10, 20)).toEqual([50, 100]);
    expect(actions.originOnPage(b, [-5, 1], 10, 20)).toEqual([0, 8]);
    expect(actions.originOnPage(b, [95, 210], 10, 20)).toEqual([80, 197.5]);
    expect(actions.originOnPage([0, 0, 10, 5] as any, [3, 3], 10, 20)).toEqual([0, 5]); // too small for it: still on it
  });

  it("a tick, a date or a writer near an edge lands on the page; a text written before is not moved", async () => {
    await filling("FY.pdf"); // 100 × 100
    state.writerStyle.value = { size: 10, color: "black" };
    await actions.openWriterAt(0, [-3, 99], "check");
    await actions.openWriterAt(0, [98, 2], "date");
    const tick = sent[0].origin;
    expect(tick[0]).toBe(0);
    expect(tick[1]).toBeCloseTo(100 - 0.25 * 11, 6);
    expect(sent[1].origin).toEqual([100 - 0.56 * 10 * [...actions.todayText()].length, 8]);
    await actions.openWriterAt(0, [99, 0.5], "text");
    expect(state.openWriter.value?.origin).toEqual([100 - 0.56 * 10 * 2, 8]);
    await actions.reopenAdded(0, ADDED(5, "Fine", [99, 99.9]));
    expect(state.openWriter.value).toMatchObject({ editing: 5, origin: [99, 99.9] });
    actions.cancelWriter();
    expect(toastTexts()).toEqual([]);
  });

  it("Line below on the page's last line writes the line, opens no writer, and says why", async () => {
    await filling("FY2.pdf");
    state.writerStyle.value = { size: 10, color: "black" };
    await actions.openWriterAt(0, [10, 95], "text");
    const w = state.openWriter.value!;
    const writing = actions.writeAndNewLine(w, "Riga 1", w.origin, 10, "black");
    expect(state.openWriter.value).toBeNull();
    await writing;
    expect(calls).toEqual(["addText:0:Riga 1"]);
    expect(toastTexts()).toEqual(["There's no room for another line on this page."]);
  });
});

describe("U41 keeping a signature on the device: what really happened", () => {
  it("a forget the storage refuses keeps it listed and says so; a save that fails, or finds 5 saved, says so", async () => {
    await filling("FZ.pdf");
    const g = globalThis as any;
    const sig = SIG({ id: "sig-stay" });
    actions.useSignature(sig);
    expect(await actions.rememberSignature(sig)).toBe(true);
    state.toasts.value = [];
    g.__storeRefuses = true;
    try {
      expect(await actions.forgetSignature("sig-stay")).toBe(false);
      expect(state.savedSignatures.value.map((s) => s.id)).toContain("sig-stay");
      expect(g.__stored.has("sig-stay")).toBe(true);
      expect(toastTexts()).toEqual(["Couldn't forget it on this device: it's still saved. Try again."]);
      state.toasts.value = [];
      expect(await actions.rememberSignature(SIG({ id: "sig-no" }))).toBe(false);
      expect(toastTexts()).toEqual(["Couldn't save it on this device: you can use it until you close the app."]);
    } finally {
      g.__storeRefuses = false;
    }
    state.toasts.value = [];
    expect(await actions.forgetSignature("sig-stay")).toBe(true);
    expect(g.__stored.has("sig-stay")).toBe(false);
    expect(toastTexts()).toEqual(["Signature forgotten."]);

    // Five saved already (from another tab, say): not kept, and why.
    for (let i = 0; i < 5; i++) g.__stored.set(`other-${i}`, SIG({ id: `other-${i}`, savedAt: 1 }));
    state.toasts.value = [];
    try {
      expect(await actions.rememberSignature(SIG({ id: "sig-sixth" }))).toBe(false);
      expect(toastTexts()).toEqual(["Not saved on this device: you already have 5 saved. Forget one to save another."]);
    } finally {
      for (let i = 0; i < 5; i++) g.__stored.delete(`other-${i}`);
    }
  });
});

describe("U42 a placement that fails", () => {
  it("says the signature or picture was not added, not that an image could not be changed", async () => {
    await filling("GA.pdf");
    const { EngineError } = await import("../src/engine/client");
    const add = engineImpl.addImage;
    const error = console.error;
    console.error = () => undefined;
    engineImpl.addImage = async () => { throw new EngineError("matrix", "bad-request"); };
    try {
      await actions.placeSignature(0, SIG(), SIGNED_AT);
      expect(toastTexts()).toEqual(["Could not add the signature or picture."]);
      state.toasts.value = [];
      (globalThis as any).__prepare = async () => ({ bytes: new ArrayBuffer(2), width: 100, height: 100 });
      await actions.addPictureFromFile(PICKED);
      expect(toastTexts()).toEqual(["Could not add the signature or picture."]);
    } finally {
      engineImpl.addImage = add;
      console.error = error;
    }
    state.toasts.value = [];
    const unreadable = SIG({ png: { arrayBuffer: () => Promise.reject(new Error("gone")) } });
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      await actions.placeSignature(0, unreadable, SIGNED_AT);
    } finally {
      console.warn = warn;
    }
    expect(toastTexts()).toEqual(["Could not add the signature or picture."]);
    expect(state.selectedImage.value).toBeNull();
    expect(state.dirty.value).toBe(false);
  });
});

describe("U43 Put it in the middle", () => {
  it("✓, ✗ and Data: written in the middle of the page, said with where, and the focus asked for on their box", async () => {
    await filling("GB.pdf"); // 100 × 100, no viewer: the whole page shows
    state.writerStyle.value = { size: 10, color: "black" };
    const i18n = await import("../src/i18n");
    const where = (o: number[]) => ({ page: 1, x: i18n.formatMm(o[0]), y: i18n.formatMm(o[1]) });
    await actions.placeAtCentre("check");
    expect(calls).toEqual(["addText:0:✓"]);
    expect(sent[0].origin[0]).toBeCloseTo(50 - 0.4 * 11, 6);
    expect(sent[0].origin[1]).toBeCloseTo(50 + 0.35 * 11, 6);
    expect(toastTexts()).toEqual([i18n.t("mark.placedAt", where(sent[0].origin))]);
    expect(toastTexts()[0]).toMatch(/^Mark on page 1\b.*\d mm from the top\.$/); // one message, ending with a full stop
    expect(state.focusRequest.value).toEqual({ pageIndex: 0, kind: "added", id: 101 });
    state.toasts.value = [];
    await actions.placeAtCentre("cross");
    expect(calls.at(-1)).toBe("addText:0:✗");
    expect(state.focusRequest.value).toEqual({ pageIndex: 0, kind: "added", id: 102 });
    state.toasts.value = [];
    await actions.placeAtCentre("date");
    expect(calls.at(-1)).toBe(`addText:0:${actions.todayText()}`);
    expect(toastTexts()).toEqual([i18n.t("writer.doneAt", where(sent[2].origin))]);
    expect(toastTexts()[0]).toMatch(/^Written on page 1\b.*\d mm from the top\.$/);
    expect(state.focusRequest.value).toEqual({ pageIndex: 0, kind: "added", id: 103 });
    expect(state.openWriter.value).toBeNull();

    // Refused by the engine: nothing said as written, no focus asked for.
    state.focusRequest.value = null;
    state.toasts.value = [];
    const { EngineError } = await import("../src/engine/client");
    const addText = engineImpl.addText;
    engineImpl.addText = async () => { throw new EngineError("locked", "not-editable"); };
    try {
      await actions.placeAtCentre("check");
    } finally {
      engineImpl.addText = addText;
    }
    expect(toastTexts()).toEqual(["You can't add text or pictures to this page: its content can't be changed safely."]);
    expect(state.focusRequest.value).toBeNull();
  });

  it("Testo opens a writer there; a signature waiting is placed there and selected; Firma opens its chooser", async () => {
    const page = await filling("GC0.pdf");
    state.writerStyle.value = { size: 10, color: "black" };
    const geometry = await import("../src/ui/fill/geometry");
    await actions.placeAtCentre("text");
    expect(state.openWriter.value).toMatchObject({ editing: null, kind: "text", origin: geometry.writerOrigin([50, 50], 10) });
    actions.cancelWriter();

    const sig = SIG();
    actions.useSignature(sig);
    await actions.placeAtCentre();
    const box = geometry.signatureRect(page.bounds, "signature", 3, [50, 50]);
    expect(sent[0].targets).toEqual([{ pageIndex: 0, matrix: geometry.rectMatrix(box) }]);
    expect(state.selectedImage.value).toEqual({ pageIndex: 0, index: 5 });
    expect(state.focusRequest.value).toEqual({ pageIndex: 0, kind: "image", id: 5 });

    await actions.placeAtCentre("signature");
    expect(state.dialog.value).toEqual({ kind: "signature", mode: "signature", forField: null });
    state.showDialog(null);
    // Pictures come from Modifica's Aggiungi immagine: its picker opens right within the click.
    const created = (globalThis as any).__created as { tag: string; clicked?: boolean; type?: string }[];
    created.length = 0;
    await actions.setTool("edit");
    actions.chooseNewPicture();
    expect(created).toMatchObject([{ tag: "input", type: "file", clicked: true }]);
    await actions.setTool(null);
    await actions.placeAtCentre("check"); // not in Compila e firma: nothing
    expect(calls).toEqual(["addImage:0"]);
  });
});

describe("U44 Next empty field", () => {
  it("the banner's button goes on from the field just left (its blur took focusedField), not back to the start of the page", async () => {
    const page = await filling("GC.pdf", FORM([3], 0));
    const { goToNextEmptyField } = await import("../src/ui/fill/FillBar");
    const fields = engineImpl.fields;
    engineImpl.fields = async () => [FIELD("a"), FIELD("b", { index: 1, value: "x" }), FIELD("c", { index: 2 })];
    try {
      page.fields.value = { rev: page.rev.peek(), fields: [FIELD("a"), FIELD("b", { index: 1 }), FIELD("c", { index: 2 })] };
      state.focusedField.value = { pageIndex: 0, name: "b", index: 1 };
      state.focusedField.value = null; // the button took the focus; b's blur has asked for its write
      const write = actions.setFieldValue(0, FIELD("b", { index: 1 }), { kind: "text", text: "x" }, page.rev.peek());
      await goToNextEmptyField();
      await write;
      expect(state.focusedField.value).toEqual({ pageIndex: 0, name: "c", index: 2 });
      expect(toastTexts()).toEqual([]);
    } finally {
      engineImpl.fields = fields;
    }
  });

  it("a value still being written counts as filled: never back to the field just filled", async () => {
    const page = await filling("GD.pdf", FORM([2], 0));
    const fields = engineImpl.fields;
    engineImpl.fields = async () => [FIELD("a", { value: "Mario" }), FIELD("b", { index: 1 })];
    try {
      page.fields.value = { rev: page.rev.peek(), fields: [FIELD("a"), FIELD("b", { index: 1 })] };
      const held = hold("setField");
      const write = actions.setFieldValue(0, FIELD("a"), { kind: "text", text: "Mario" }, page.rev.peek());
      const release = await held;
      const next = actions.focusNextField({ pageIndex: 0, index: -1 }, true); // from the start of the page
      release();
      await write;
      expect(await next).toBe(true);
      expect(state.focusedField.value).toEqual({ pageIndex: 0, name: "b", index: 1 });
    } finally {
      engineImpl.fields = fields;
    }
  });
});

describe("U46 wording chosen here", () => {
  it("initials copied to one page say page, not pages; a picture added on a touch screen names the round grip", async () => {
    const pages = [{ index: 0, bounds: A4 }, { index: 1, bounds: A4 }];
    await filling("GH.pdf", { pageCount: 2, pages });
    const ini = INITIALS();
    await actions.placeSignature(0, ini, SIGNED_AT);
    const images = engineImpl.images;
    engineImpl.images = async (p: number) => (p === 0 ? [IMAGE(5, { matrix: SIGNED_AT, added: true })] : []);
    try {
      state.toasts.value = [];
      const held = hold("addImage");
      const placing = actions.placeInitialsOnPages(0, 5);
      (await takeDialog("initials-pages")).resolve([1]);
      const release = await held;
      expect(toastTexts()).toEqual(["Adding initials to 1 page…"]);
      release();
      await placing;
    } finally {
      engineImpl.images = images;
    }
    expect(toastTexts()).toEqual(["Initials added to 1 page."]);

    const media = await import("../src/ui/media");
    media.isCoarse.value = true;
    try {
      state.toasts.value = [];
      (globalThis as any).__prepare = async () => ({ bytes: new ArrayBuffer(2), width: 100, height: 100 });
      await actions.addPictureFromFile(PICKED);
      expect(toastTexts()).toEqual(["Image added on page 1. Drag the round grip to move it."]);
    } finally {
      media.isCoarse.value = false;
    }
  });
});

describe("U45 the focus asked for, and Enter on the page", () => {
  it("a change of tool or another document drops the focus asked for", async () => {
    await filling("GE.pdf");
    state.focusRequest.value = { pageIndex: 0, kind: "added", id: 1 };
    await actions.setTool("edit");
    expect(state.focusRequest.value).toBeNull();
    state.focusRequest.value = { pageIndex: 0, kind: "image", id: 2 };
    await openWith("GF.pdf", {});
    expect(state.focusRequest.value).toBeNull();
  });

  it("Enter on the page region with Testo opens a writer in the middle; not with ✓, nor with a writer open, nor elsewhere", async () => {
    const { press, restore } = await keyboard();
    const g = globalThis as any;
    const scroller = { tag: "scroller" };
    const query = g.document.querySelector;
    g.document.querySelector = (sel: string) => (sel === ".viewer .scroller" ? scroller : null);
    try {
      await filling("GG.pdf");
      state.writerStyle.value = { size: 10, color: "black" };
      const { writerOrigin } = await import("../src/ui/fill/geometry");
      expect(press("Enter").defaultPrevented).toBe(false); // not on the page region
      expect(press("Enter", { target: scroller }).defaultPrevented).toBe(true);
      await vi.waitFor(() => expect(state.openWriter.value).not.toBeNull());
      expect(state.openWriter.value).toMatchObject({ editing: null, origin: writerOrigin([50, 50], 10) });
      expect(press("Enter", { target: scroller }).defaultPrevented).toBe(false); // a writer is open
      actions.cancelWriter();
      state.fillTool.value = "check";
      expect(press("Enter", { target: scroller }).defaultPrevented).toBe(false);
      expect(press("Enter", { target: scroller, shiftKey: true }).defaultPrevented).toBe(false);
      await new Promise((r) => setTimeout(r, 10));
      expect(calls).toEqual([]);
    } finally {
      g.document.querySelector = query;
      restore();
    }
  });
});

describe("U47 where a new text lands, as openWriterAt says", () => {
  it("resolves with the origin used: kept on the page for a tick, a date and a writer; a reopened text's own; null when nothing came", async () => {
    await filling("GK.pdf"); // 100 × 100
    state.writerStyle.value = { size: 10, color: "black" };
    const tick = await actions.openWriterAt(0, [-3, 99], "check");
    expect(tick).toEqual(sent[0].origin); // what the engine was sent, not the tap
    expect(tick![0]).toBe(0);
    const date = await actions.openWriterAt(0, [98, 2], "date");
    expect(date).toEqual(sent[1].origin);
    expect(date).toEqual([100 - 0.56 * 10 * [...actions.todayText()].length, 8]);
    const writer = await actions.openWriterAt(0, [99, 0.5], "text");
    expect(writer).toEqual(state.openWriter.value?.origin);
    expect(writer).toEqual([100 - 0.56 * 10 * 2, 8]);
    expect(await actions.reopenAdded(0, ADDED(5, "Fine", [99, 99.9]))).toEqual([99, 99.9]);
    actions.cancelWriter();

    // Asked for something else meanwhile: the first writer never opens.
    const first = actions.openWriterAt(0, [10, 20], "text");
    const second = actions.openWriterAt(0, [30, 40], "text");
    expect(await first).toBeNull();
    expect(await second).toEqual([30, 40]);
    actions.cancelWriter();

    // Refused by the engine: nothing written, null.
    const { EngineError } = await import("../src/engine/client");
    const addText = engineImpl.addText;
    engineImpl.addText = async () => { throw new EngineError("locked", "not-editable"); };
    try {
      expect(await actions.openWriterAt(0, [50, 50], "cross")).toBeNull();
    } finally {
      engineImpl.addText = addText;
    }
    await actions.setTool(null);
    expect(await actions.openWriterAt(0, [50, 50], "check")).toBeNull(); // not in Compila e firma
  });
});

describe("U48 Sign here on a turned field", () => {
  it("the signature goes in upright to the field's text: signatureInField with the widget's rotation", async () => {
    await filling("GL.pdf");
    const geometry = await import("../src/ui/fill/geometry");
    const rect = [10, 10, 40, 110] as [number, number, number, number]; // 30 × 100: a field on its side
    state.showDialog({ kind: "signature", mode: "signature", forField: { pageIndex: 0, rect, rotation: 90 } });
    actions.useSignature(SIG()); // 3:1
    await vi.waitFor(() => expect(calls).toEqual(["addImage:0"]));
    expect(sent[0].targets[0].matrix).toEqual(geometry.signatureInField(rect, 3, 90));
    expect(sent[0].targets[0].matrix).not.toEqual(geometry.rectMatrix(geometry.fitInField(rect, 3)));
    // Turned a quarter: the picture's width runs down the page (a = 0, b > 0).
    const [a, b] = sent[0].targets[0].matrix;
    expect(a).toBe(0);
    expect(b).toBeGreaterThan(0);
  });
});

describe("U49 Next empty field in the last empty one", () => {
  it("keeps the focus in it and says it is the last one, never that none are left; filled, there is none", async () => {
    const page = await filling("GM.pdf", FORM([2], 1));
    const fields = engineImpl.fields;
    let value = "";
    engineImpl.fields = async () => [FIELD("a", { required: true, value }), FIELD("b", { index: 1, value: "x" })];
    try {
      page.fields.value = { rev: page.rev.peek(), fields: await engineImpl.fields() };
      state.focusedField.value = { pageIndex: 0, name: "a", index: 0 };
      expect(await actions.focusNextField({ pageIndex: 0, index: 0, name: "a" }, true)).toBe(true);
      expect(state.focusedField.value).toEqual({ pageIndex: 0, name: "a", index: 0 });
      expect(toastTexts()).toEqual(["This is the last empty field."]);

      // The banner's button, from the field (its press kept the focus there): the same, said once.
      state.toasts.value = [];
      const { goToNextEmptyField } = await import("../src/ui/fill/FillBar");
      await goToNextEmptyField();
      expect(state.focusedField.value).toEqual({ pageIndex: 0, name: "a", index: 0 });
      expect(toastTexts()).toEqual(["This is the last empty field."]);

      // Just filled (the write still on its way when asked): no empty field left, and nothing said here.
      state.toasts.value = [];
      const held = hold("setField");
      const write = actions.setFieldValue(0, FIELD("a", { required: true }), { kind: "text", text: "Mario" }, page.rev.peek());
      const release = await held;
      value = "Mario";
      const next = actions.focusNextField({ pageIndex: 0, index: 0, name: "a" }, true);
      release();
      await write;
      expect(await next).toBe(false);
      expect(toastTexts()).toEqual([]);
    } finally {
      engineImpl.fields = fields;
    }
  });

  it("an empty field after the one the user is in still comes first; a locked field the user is in is not the last empty one", async () => {
    const page = await filling("GN.pdf", FORM([3], 0));
    const fields = engineImpl.fields;
    engineImpl.fields = async () => [
      FIELD("a"), FIELD("b", { index: 1, value: "x" }), FIELD("c", { index: 2 }),
    ];
    try {
      page.fields.value = { rev: page.rev.peek(), fields: await engineImpl.fields() };
      expect(await actions.focusNextField({ pageIndex: 0, index: 0, name: "a" }, true)).toBe(true);
      expect(state.focusedField.value).toEqual({ pageIndex: 0, name: "c", index: 2 });
      expect(toastTexts()).toEqual([]);
      engineImpl.fields = async () => [FIELD("ro", { locked: "read-only" }), FIELD("b", { index: 1, value: "x" })];
      page.fields.value = { rev: page.rev.peek(), fields: await engineImpl.fields() };
      expect(await actions.focusNextField({ pageIndex: 0, index: 0, name: "ro" }, true)).toBe(false);
      expect(toastTexts()).toEqual([]);
    } finally {
      engineImpl.fields = fields;
    }
  });
});

describe("U50 Forget, said once", () => {
  it("with the signature sheet open, no toast (the sheet shows it); closed, one toast", async () => {
    await filling("GO.pdf");
    const g = globalThis as any;
    const sig = SIG({ id: "sig-once" });
    actions.useSignature(sig);
    expect(await actions.rememberSignature(sig)).toBe(true);
    state.toasts.value = [];
    state.showDialog({ kind: "signature", mode: "signature", forField: null });
    g.__storeRefuses = true;
    try {
      expect(await actions.forgetSignature("sig-once")).toBe(false);
    } finally {
      g.__storeRefuses = false;
    }
    expect(state.savedSignatures.value.map((s) => s.id)).toContain("sig-once");
    expect(toastTexts()).toEqual([]);
    expect(await actions.forgetSignature("sig-once")).toBe(true);
    expect(state.sessionSignatures.value.map((s) => s.id)).not.toContain("sig-once");
    expect(toastTexts()).toEqual([]);

    state.showDialog(null);
    const again = SIG({ id: "sig-twice", kind: "initials" });
    expect(await actions.rememberSignature(again)).toBe(true);
    g.__storeRefuses = true;
    try {
      expect(await actions.forgetSignature("sig-twice")).toBe(false);
    } finally {
      g.__storeRefuses = false;
    }
    expect(toastTexts()).toEqual(["Couldn't forget it on this device: it's still saved. Try again."]);
    state.toasts.value = [];
    expect(await actions.forgetSignature("sig-twice")).toBe(true);
    expect(toastTexts()).toEqual(["Initials forgotten."]);
  });
});

describe("U51 typingField", () => {
  it("goes back to false when Modifica comes on and when the document goes; other tools keep it", async () => {
    await filling("GP.pdf");
    state.typingField.value = true;
    await actions.setTool(null); // the form fields stay in browse
    expect(state.typingField.value).toBe(true);
    await actions.setTool("fill");
    expect(state.typingField.value).toBe(true);
    await actions.setTool("edit");
    expect(state.typingField.value).toBe(false);
    await actions.setTool("fill");
    state.typingField.value = true;
    await openWith("GQ.pdf", {});
    expect(state.typingField.value).toBe(false);
    state.typingField.value = true;
    await actions.closeDocument();
    expect(state.typingField.value).toBe(false);
  });
});

describe("U52 mark and date texts", () => {
  it("the toasts of Put it in the middle end with a full stop, in both languages", async () => {
    const { en } = await import("../src/i18n/en");
    const { it: italian } = await import("../src/i18n/it");
    for (const key of ["mark.placedAt", "writer.doneAt", "form.lastEmpty"] as const) {
      expect({ key, en: en[key].endsWith("."), it: italian[key].endsWith(".") }).toEqual({ key, en: true, it: true });
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Release 3, small fixes after the owner's test

describe("U53 Modifica's sub-tools", () => {
  it("Modifica always starts on Cambia; Aggiungi testo only in Modifica, with a document, until editing stops", async () => {
    const page = await editing("HA.pdf");
    expect(state.editTool.value).toBe("change");
    expect(state.writerOn.value).toBe(false);
    await actions.setEditTool("addText");
    expect([state.editTool.value, state.writerOn.value, state.writerKind.value]).toEqual(["addText", true, "text"]);
    await actions.setTool("fill");
    expect(state.editTool.value).toBe("change");
    await actions.setEditTool("addText"); // not in Compila e firma
    expect(state.editTool.value).toBe("change");
    await actions.setTool("edit");
    await actions.setEditTool("addText");
    await actions.setTool("edit"); // Modifica again: on Cambia again
    expect(state.editTool.value).toBe("change");
    await actions.setEditTool("addText");
    await actions.setTool(null);
    expect(state.editTool.value).toBe("change");
    await actions.setEditTool("addText"); // browse
    expect(state.editTool.value).toBe("change");

    await actions.setTool("edit");
    const { EngineError } = await import("../src/engine/client");
    const replace = engineImpl.replaceLine;
    engineImpl.replaceLine = async () => { throw new EngineError("lost", "broken"); };
    await actions.replaceLine(page, LINE, "x", page.rev.peek());
    engineImpl.replaceLine = replace;
    state.showDialog(null);
    state.tool.value = "edit"; // as if still in Modifica
    await actions.setEditTool("addText");
    expect(state.editTool.value).toBe("change");
    await actions.closeDocument();
    state.tool.value = "edit";
    await actions.setEditTool("addText");
    expect(state.editTool.value).toBe("change");
    state.tool.value = null;
  });

  it("switching writes what the writer or the line editor holds first, then closes it; no line opens with Aggiungi testo", async () => {
    state.writerStyle.value = { size: 11, color: "black" };
    const page = await editing("HB.pdf");
    await actions.setEditTool("addText");
    await actions.openWriterAt(0, [10, 50], "text");
    const unregister = typing(state.openWriter.value!, "Nuovo");
    await actions.setEditTool("change");
    unregister();
    expect(calls).toEqual(["addText:0:Nuovo"]);
    expect([state.openWriter.value, state.editTool.value]).toEqual([null, "change"]);

    await actions.openLine(0, LINE);
    expect(state.editingLine.value).toEqual({ pageIndex: 0, line: LINE });
    const unregisterLine = state.registerEditor({
      changed: () => true,
      commit: () => actions.replaceLine(page, LINE, "typed", page.rev.peek()),
    });
    await actions.setEditTool("addText");
    unregisterLine();
    expect(calls).toEqual(["addText:0:Nuovo", "replaceLine"]);
    expect(state.editingLine.value).toBeNull();
    await actions.openLine(0, LINE); // lines are changed with Cambia
    expect(state.editingLine.value).toBeNull();

    calls.length = 0;
    await actions.openWriterAt(0, [10, 80], "text");
    const again = typing(state.openWriter.value!, "Ancora");
    await actions.setEditTool("addText"); // on already: nothing written, nothing closed
    again();
    expect(calls).toEqual([]);
    expect(state.openWriter.value).not.toBeNull();
    actions.cancelWriter();
  });

  it("the writer opens in Modifica with Aggiungi testo, always for text; not with Cambia", async () => {
    state.writerStyle.value = { size: 10, color: "black" };
    await editing("HC.pdf"); // 100 × 100, no viewer: the whole page shows
    expect(await actions.openWriterAt(0, [10, 50], "text")).toBeNull();
    expect(state.openWriter.value).toBeNull();
    await actions.setEditTool("addText");
    expect(await actions.openWriterAt(0, [10, 50], "text")).toEqual([10, 50]);
    const w = state.openWriter.value!;
    expect(w).toMatchObject({ kind: "text", editing: null });
    // Line below works here too.
    const writing = actions.writeAndNewLine(w, "Riga 1", w.origin, 10, "black");
    expect(state.openWriter.value).toMatchObject({ origin: [10, 50 + 1.25 * 10], text: "", kind: "text" });
    await writing;
    actions.cancelWriter();

    // Put it in the middle: Testo, whatever Compila e firma's sub-tool is.
    const { writerOrigin } = await import("../src/ui/fill/geometry");
    state.fillTool.value = "check";
    try {
      expect(state.writerKind.value).toBe("text");
      await actions.placeAtCentre();
      expect(state.openWriter.value).toMatchObject({ kind: "text", editing: null, origin: writerOrigin([50, 50], 10) });
      actions.cancelWriter();
      await actions.placeAtCentre("check");
      expect(state.openWriter.value).toMatchObject({ kind: "text", editing: null });
      actions.cancelWriter();
      expect(calls).toEqual(["addText:0:Riga 1"]); // no ✓ written
      await actions.setEditTool("change");
      await actions.placeAtCentre(); // Cambia: nothing
      expect(state.openWriter.value).toBeNull();
    } finally {
      state.fillTool.value = "text";
    }
  });

  it("Escape: the writer, then the image, then back to Cambia, then out of Modifica; Enter on the page writes only with Aggiungi testo", async () => {
    const { press, restore } = await keyboard();
    const g = globalThis as any;
    const scroller = { tag: "scroller" };
    const query = g.document.querySelector;
    g.document.querySelector = (sel: string) => (sel === ".viewer .scroller" ? scroller : null);
    try {
      const page = await editing("HD.pdf");
      state.writerStyle.value = { size: 10, color: "black" };
      expect(press("Enter", { target: scroller }).defaultPrevented).toBe(false); // Cambia
      await actions.setEditTool("addText");
      expect(press("Enter", { target: scroller }).defaultPrevented).toBe(true);
      await vi.waitFor(() => expect(state.openWriter.value).not.toBeNull());
      expect(state.openWriter.value).toMatchObject({ kind: "text", editing: null });
      const unregister = typing(state.openWriter.value!, "typed");
      expect(press("Escape").defaultPrevented).toBe(true);
      expect(state.openWriter.value).toBeNull();
      await state.flushEditor(); // asked before the writer has unregistered: it writes nothing
      unregister();
      expect(calls).toEqual([]);
      expect(state.editTool.value).toBe("addText");

      // With Aggiungi testo, only the pictures the user added are selected, as in Compila e firma.
      await actions.selectImage(0, IMAGE(0), page.rev.peek());
      expect(state.selectedImage.value).toBeNull();
      await actions.selectImage(0, IMAGE(1, { added: true }), page.rev.peek());
      expect(state.selectedImage.value).toEqual({ pageIndex: 0, index: 1 });
      press("Escape");
      await vi.waitFor(() => expect(state.selectedImage.value).toBeNull());
      expect(state.editTool.value).toBe("addText");
      press("Escape");
      await vi.waitFor(() => expect(state.editTool.value).toBe("change"));
      expect(state.editMode.value).toBe(true);
      press("Escape");
      await vi.waitFor(() => expect(state.editMode.value).toBe(false));
    } finally {
      g.document.querySelector = query;
      restore();
    }
  });

  it("switching the sub-tool hands the focus of a picture's box to the same picture's box in the new layer; anything else to the scroller", async () => {
    const { press, restore } = await keyboard();
    const g = globalThis as any;
    const focusable = (tag: string) => ({ tag, focused: 0, focus() { this.focused++; } });
    const scroller = focusable("scroller");
    /** The boxes the page shows after the switch, by data-image. */
    const shown = new Map<string, any>();
    const pageEl = {
      isConnected: true,
      querySelector: (sel: string) => shown.get(/^\[data-image="(\d+)"\]$/.exec(sel)?.[1] ?? "") ?? null,
    };
    /** A box on the page: a picture's (data-image) or, with null, anything else (a line, a text). */
    const box = (image: string | null) => ({
      ...focusable(`box ${image}`),
      getAttribute: (name: string) => (name === "data-image" ? image : null),
      closest: (sel: string) => (sel === ".page" ? pageEl : null),
    });
    // The element with the focus, on the layer of `layer`: once the sub-tool changes, that layer
    // is gone with it, and the focus is on <body> (as after Preact's re-render).
    let focused: any = null;
    let layer = "addText";
    const query = g.document.querySelector;
    g.document.querySelector = (sel: string) => (sel === ".viewer .scroller" ? scroller : null);
    Object.defineProperty(g.document, "activeElement", {
      configurable: true,
      get: () => (state.editTool.peek() === layer ? focused : g.document.body),
    });
    try {
      await editing("HF.pdf");
      await actions.setEditTool("addText");

      // Esc on the box of a picture the user added: Cambia's full layer has it too.
      focused = box("6");
      const same = focusable("box 6 in Cambia");
      shown.set("6", same);
      press("Escape");
      await vi.waitFor(() => expect(same.focused).toBe(1));
      expect(state.editTool.value).toBe("change");
      expect(scroller.focused).toBe(0);

      // A picture of the document's own: Aggiungi testo does not show it, so the scroller.
      layer = "change";
      focused = box("2");
      shown.clear();
      await actions.setEditTool("addText");
      await vi.waitFor(() => expect(scroller.focused).toBe(1));

      // Anything else (a text the user wrote): the scroller, even with a picture's box there.
      layer = "addText";
      focused = box(null);
      shown.set("6", same);
      await actions.setEditTool("change");
      await vi.waitFor(() => expect(scroller.focused).toBe(2));
      expect(same.focused).toBe(1);
    } finally {
      Object.defineProperty(g.document, "activeElement", { configurable: true, writable: true, value: null });
      g.document.querySelector = query;
      restore();
      await actions.setTool(null);
    }
  });

  it("Aggiungi immagine: only in Modifica; a file chosen goes to Cambia first, then is placed and selected; cancelled, nothing", async () => {
    await filling("HE.pdf");
    (globalThis as any).__prepare = async () => ({ bytes: new ArrayBuffer(2), width: 100, height: 100 });
    const { inputs, restore } = pickerInputs();
    try {
      actions.chooseNewPicture(); // Compila e firma
      await actions.setTool(null);
      actions.chooseNewPicture(); // browse
      expect(inputs).toHaveLength(0);

      await actions.setTool("edit");
      await actions.setEditTool("addText");
      actions.chooseNewPicture();
      expect(inputs).toHaveLength(1);
      expect(inputs[0]).toMatchObject({ tag: "input", type: "file", accept: "image/*", clicked: true });
      inputs[0].listeners.cancel();
      expect(state.editTool.value).toBe("addText");

      actions.chooseNewPicture();
      await actions.openWriterAt(0, [10, 50], "text"); // where "cancel" is not fired, a tap meanwhile
      const unregister = typing(state.openWriter.value!, "Scritto");
      inputs[1].files = [PICKED];
      inputs[1].listeners.change();
      expect(state.editTool.value).toBe("change"); // at once, before the picture is sent
      expect(state.openWriter.value).toBeNull();
      unregister();
      await vi.waitFor(() => expect(calls).toEqual(["addText:0:Scritto", "addImage:0"]));
      await vi.waitFor(() => expect(state.selectedImage.value).toEqual({ pageIndex: 0, index: 5 }));
    } finally {
      restore();
    }
  });
});

describe("U54 a save that fails leaves no empty file", () => {
  /**
   * A save dialog whose file holds `size` bytes (0: the file the dialog made, or a file picked to
   * be overwritten, which Chromium empties as the dialog closes); `fail` is the step of writing it
   * that fails. Returns the file's handle, with spies.
   */
  function savePicker(size: number, fail: "none" | "create" | "write" = "write") {
    const handle: any = {
      name: "Chosen.pdf",
      getFile: vi.fn(async () => ({ size })),
      remove: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
      createWritable: async () => {
        if (fail === "create") throw new DOMException("The disk is full", "QuotaExceededError");
        return {
          write: async () => {
            if (fail === "write") throw new DOMException("The disk is full", "QuotaExceededError");
          },
          close: async () => undefined,
          abort: handle.abort,
        };
      },
    };
    (globalThis as any).showSaveFilePicker = async () => handle;
    return handle;
  }
  const created = () => (globalThis as any).__created as { tag: string; clicked?: boolean; download?: string }[];
  /** The plain downloads started (a link clicked), with their names. */
  const downloads = () => created().filter((e) => e.tag === "a" && e.clicked).map((e) => e.download);

  /** Open `name` with one edit not downloaded yet, ready for a download. */
  async function edited(name: string, info: Record<string, unknown> = {}) {
    await openWith(name, info);
    const page = state.doc.value!.pages[0];
    await actions.replaceLine(page, LINE, "new", page.rev.peek());
    calls.length = 0;
    saves.length = 0;
    created().length = 0;
    state.toasts.value = [];
  }

  it("a write that fails: the empty file is removed, and the PDF is downloaded instead, said so", async () => {
    const handle = savePicker(0);
    await edited("SA.pdf");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await actions.download();
    } finally {
      error.mockRestore();
      delete (globalThis as any).showSaveFilePicker;
    }
    expect(handle.abort).toHaveBeenCalledTimes(1);
    expect(handle.remove).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["save"]); // built once: the download uses the same bytes
    expect(downloads()).toEqual(["Chosen.pdf"]);
    expect(toastTexts()).toEqual(["Couldn't save it where you chose, so it was downloaded as “Chosen.pdf” instead."]);
    expect(state.dirty.value).toBe(false);

    const { en } = await import("../src/i18n/en");
    const { it: italian } = await import("../src/i18n/it");
    for (const text of [en["download.savedInstead"], italian["download.savedInstead"]]) {
      expect(text).toContain("“{name}”");
      expect(text.endsWith(".")).toBe(true);
    }
  });

  it("a file with something in it is never removed; without remove() the file stays; a writable that cannot be made is not aborted", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      // A file that still has content: a browser or a path that does not empty a file picked to
      // be overwritten (Chromium does, and then the file is empty, as below).
      let handle = savePicker(10);
      await edited("SB.pdf");
      await actions.download();
      expect(handle.getFile).toHaveBeenCalled();
      expect(handle.remove).not.toHaveBeenCalled();
      expect(downloads()).toEqual(["Chosen.pdf"]);
      expect(state.dirty.value).toBe(false);

      handle = savePicker(0, "create");
      await edited("SC.pdf");
      await actions.download();
      expect(handle.abort).not.toHaveBeenCalled();
      expect(handle.remove).toHaveBeenCalledTimes(1);
      expect(downloads()).toEqual(["Chosen.pdf"]);

      handle = savePicker(0);
      delete handle.remove; // not Chromium
      await edited("SD.pdf");
      await actions.download();
      expect(handle.getFile).not.toHaveBeenCalled();
      expect(downloads()).toEqual(["Chosen.pdf"]);

      // The plain download fails too: the usual error, and the edits are still not downloaded.
      savePicker(0);
      await edited("SE.pdf");
      const createObjectURL = URL.createObjectURL;
      URL.createObjectURL = () => { throw new Error("no blob URLs here"); };
      try {
        await actions.download();
      } finally {
        URL.createObjectURL = createObjectURL;
      }
      expect(toastTexts()).toEqual(["Could not create the PDF."]);
      expect(state.dirty.value).toBe(true);
    } finally {
      error.mockRestore();
      delete (globalThis as any).showSaveFilePicker;
    }
  });

  it("the engine failing or refusing the PDF/A, or another document opened meanwhile: the empty file is removed", async () => {
    const { EngineError } = await import("../src/engine/client");
    const save = engineImpl.save;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      let handle = savePicker(0, "none");
      await edited("SF.pdf");
      engineImpl.save = async () => { throw new EngineError("boom", "engine"); };
      await actions.download();
      engineImpl.save = save;
      expect(handle.remove).toHaveBeenCalledTimes(1);
      expect(toastTexts()).toEqual(["Could not create the PDF."]);
      expect(downloads()).toEqual([]);

      // Refused when written: removed before the question that offers a normal PDF.
      handle = savePicker(0, "none");
      await edited("SG.pdf", { pdfa: "2B" });
      pdfaReport = CLEAN;
      engineImpl.save = async (o: any) => {
        if (o.format === "pdfa-2b") throw new EngineError("self-check failed", "pdfa-blocked");
        return save(o);
      };
      const p = actions.download();
      await vi.waitFor(() => expect(state.dialog.value?.kind).toBe("pdfa-blocked"));
      expect(handle.remove).toHaveBeenCalledTimes(1);
      await answerDialog("pdfa-blocked", false);
      await p;
      engineImpl.save = save;
      expect(handle.remove).toHaveBeenCalledTimes(1);

      // Another document opened while the save dialog was open: nothing is written for it.
      handle = savePicker(0, "none");
      await edited("SH.pdf");
      const picker = (globalThis as any).showSaveFilePicker;
      (globalThis as any).showSaveFilePicker = async () => {
        await actions.openFile(fakeFile("SI.pdf", "SI"), { confirmed: true });
        return picker();
      };
      await actions.download();
      expect(handle.remove).toHaveBeenCalledTimes(1);
      expect(calls).toEqual(["open:SI"]); // no save
      expect(state.doc.value?.fileName).toBe("SI.pdf");
    } finally {
      engineImpl.save = save;
      error.mockRestore();
      delete (globalThis as any).showSaveFilePicker;
    }
  });

  it("the happy path removes nothing", async () => {
    const handle = savePicker(0, "none");
    try {
      await edited("SJ.pdf");
      await actions.download();
    } finally {
      delete (globalThis as any).showSaveFilePicker;
    }
    expect(handle.getFile).not.toHaveBeenCalled();
    expect(handle.remove).not.toHaveBeenCalled();
    expect(handle.abort).not.toHaveBeenCalled();
    expect(downloads()).toEqual([]);
    expect(toastTexts()).toEqual(["Downloaded “Chosen.pdf”."]);
    expect(state.dirty.value).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Decorations that follow an edited line: the line editor's background option and what it sends,
// the toasts that say what followed the text and what stayed, the details panel's rows

/** What a line edit did to the line's decorations (DecorationReport): nothing unless `extra` says. */
const REPORT = (extra: Record<string, unknown> = {}) =>
  ({ moved: [], removed: [], linksMoved: 0, linksRemoved: 0, left: [], ...extra }) as any;
/** What the engine says of a line as its editor opens (LineDecorations): nothing unless `extra` says. */
const DECORATIONS = (extra: Record<string, unknown> = {}) =>
  ({ underlines: 0, strikes: 0, links: 0, box: null, left: [], ...extra }) as any;
const PILL = { fill: true, stroke: false, suggested: true };

describe("U55 decorations that follow an edited line", () => {
  /**
   * Edit LINE of a document just opened, with the engine reporting `result` on top of a plain
   * edit; returns the toasts shown and what the engine was sent.
   */
  async function editWith(name: string, result: Record<string, unknown>, options?: { box?: boolean }) {
    await openWith(name, {});
    const page = state.doc.value!.pages[0];
    const replace = engineImpl.replaceLine;
    let sentArgs: unknown[] = [];
    engineImpl.replaceLine = async (...args: unknown[]) => {
      sentArgs = args;
      return { ...edited([0]), ...result };
    };
    state.toasts.value = [];
    try {
      await actions.replaceLine(page, LINE, "new", page.rev.peek(), options);
    } finally {
      engineImpl.replaceLine = replace;
    }
    return { toasts: state.toasts.value.map((x) => [x.kind, x.text]), sent: sentArgs };
  }

  it("the editor's choice goes to the engine only when it offered one", async () => {
    const { lineEditOptions } = await import("../src/viewer/LineLayer");
    let r = await editWith("DA.pdf", {}, { box: false });
    expect(r.sent).toEqual([0, 0, "new", { box: false }]);
    r = await editWith("DB.pdf", {});
    expect(r.sent).toEqual([0, 0, "new", undefined]);
    expect(r.toasts).toEqual([]); // no decorations reported: nothing said
    expect(lineEditOptions(null, true)).toBeUndefined(); // no answer from the engine (yet)
    expect(lineEditOptions(DECORATIONS(), true)).toBeUndefined(); // no background to offer
    expect(lineEditOptions(DECORATIONS({ box: PILL }), false)).toEqual({ box: false });
    expect(lineEditOptions(DECORATIONS({ box: PILL }), true)).toEqual({ box: true });
  });

  it("says what followed the text and what stayed, after the edit's own toasts, two at most", async () => {
    const r = await editWith("DC.pdf", {
      fallbackChars: ["é"],
      decorations: REPORT({
        moved: ["strike"], removed: ["underline"], linksRemoved: 2, left: [{ kind: "background", reason: "shared" }],
      }),
    });
    expect(r.toasts).toEqual([
      ["warn", "Not in the original font, written with a similar one: é"],
      ["info", "The strike-through follows the new text too. Removed the underline and the links too."],
      ["warn", "Left the background as it was: it's shared with other lines or a table."],
    ]);
    const s = await editWith("DD.pdf", { decorations: REPORT() });
    expect(s.toasts).toEqual([]); // a report with nothing in it: nothing to say
  });

  it("names what followed, with plurals, in both languages", async () => {
    const i18n = await import("../src/i18n");
    const said = (extra: Record<string, unknown>) => actions.decorationToasts(REPORT(extra)).map((x) => [x.kind, x.text]);
    expect(said({ moved: ["underline"], linksMoved: 1 })).toEqual([["info", "The underline and the link follow the new text too."]]);
    expect(said({ linksMoved: 1 })).toEqual([["info", "The link follows the new text too."]]);
    expect(said({ moved: ["underline", "underline"] })).toEqual([["info", "The underlines follow the new text too."]]);
    expect(said({ moved: ["background", "border"] })).toEqual([["info", "The background and the border follow the new text too."]]);
    expect(said({ removed: ["background", "underline"], linksRemoved: 1 }))
      .toEqual([["info", "Removed the underline, the background and the link too."]]);
    expect(said({ left: [{ kind: "underline", reason: "pattern" }] }))
      .toEqual([["warn", "Left the underline as it was: it's dashed or dotted."]]);
    // Two of a kind for one reason: the plural, with the reason (D26).
    expect(said({ left: [{ kind: "underline", reason: "pattern" }, { kind: "underline", reason: "pattern" }] }))
      .toEqual([["warn", "Left the underlines as they were: they're dashed or dotted."]]);
    expect(said({ left: [{ kind: "link", reason: "direction" }, { kind: "link", reason: "direction" }] }))
      .toEqual([["warn", "Left the links as they were: the text is vertical or slanted."]]);
    // ...and with something else besides, still the plural in the list.
    expect(said({ left: [
      { kind: "underline", reason: "pattern" }, { kind: "underline", reason: "pattern" }, { kind: "link", reason: "direction" },
    ] })).toEqual([["warn", "Left the underlines and the link as they were."]]);
    expect(said({ left: [{ kind: "background", reason: "shared" }, { kind: "link", reason: "ambiguous" }] }))
      .toEqual([["warn", "Left the background and the link as they were."]]);
    expect(said({ left: [{ kind: "underline", reason: "colour" }, { kind: "underline", reason: "pattern" }] }))
      .toEqual([["warn", "Left the underlines as they were."]]);
    expect(actions.decorationToasts(undefined)).toEqual([]);

    i18n.setLocale("it");
    try {
      expect(said({ moved: ["underline"], linksMoved: 1 }))
        .toEqual([["info", "Anche la sottolineatura e il link seguono il nuovo testo."]]);
      expect(said({ linksMoved: 1 })).toEqual([["info", "Anche il link segue il nuovo testo."]]);
      expect(said({ moved: ["background"], linksMoved: 2 })).toEqual([["info", "Anche lo sfondo e i link seguono il nuovo testo."]]);
      expect(said({ removed: ["underline", "background"], linksRemoved: 1 }))
        .toEqual([["info", "Ho tolto anche la sottolineatura, lo sfondo e il link."]]);
      expect(said({ moved: ["strike"], removed: ["underline"], left: [{ kind: "background", reason: "shared" }] })).toEqual([
        ["info", "Anche il barrato segue il nuovo testo. Ho tolto anche la sottolineatura."],
        ["warn", "Ho lasciato com'era lo sfondo: è in comune con altre righe o con una tabella."],
      ]);
      expect(said({ left: [{ kind: "underline", reason: "pattern" }] }))
        .toEqual([["warn", "Ho lasciato com'era la sottolineatura: è a trattini o a puntini."]]);
      expect(said({ left: [{ kind: "underline", reason: "pattern" }, { kind: "underline", reason: "pattern" }] }))
        .toEqual([["warn", "Ho lasciato com'erano le sottolineature: sono a trattini o a puntini."]]);
      expect(said({ left: [{ kind: "background", reason: "shared" }, { kind: "background", reason: "shared" }] }))
        .toEqual([["warn", "Ho lasciato com'erano gli sfondi: sono in comune con altre righe o con una tabella."]]);
      expect(said({ left: [
        { kind: "underline", reason: "pattern" }, { kind: "underline", reason: "pattern" }, { kind: "link", reason: "direction" },
      ] })).toEqual([["warn", "Ho lasciato com'erano le sottolineature e il link."]]);
      expect(said({ left: [{ kind: "background", reason: "shared" }, { kind: "link", reason: "ambiguous" }] }))
        .toEqual([["warn", "Ho lasciato com'erano lo sfondo e il link."]]);
    } finally {
      i18n.setLocale("en");
    }
  });

  it("every reason and every kind has its words, in both languages", async () => {
    const i18n = await import("../src/i18n");
    const reasons = ["pattern", "form", "colour", "overline", "shared", "cover", "complex", "direction", "ambiguous"] as const;
    const kinds = ["underline", "strike", "overline", "background", "border", "link"] as const;
    for (const locale of ["en", "it"] as const) {
      i18n.setLocale(locale);
      for (const reasonText of [actions.decorationReasonText, actions.decorationsReasonText]) {
        const texts = reasons.map((reason) => reasonText(reason));
        for (const text of texts) expect(text).toMatch(/^[^{}.]+$/); // a clause: no placeholder, no full stop
        expect(texts.some((text) => text.startsWith("deco."))).toBe(false);
        expect(new Set(texts).size).toBe(reasons.length);
      }
      for (const bare of [false, true]) {
        const names = actions.decorationNames([...kinds], bare);
        expect(names).toHaveLength(kinds.length);
        expect(new Set(names).size).toBe(kinds.length);
        expect(names.some((name) => name.startsWith("deco."))).toBe(false);
      }
      // Two of each kind: the plural names, none of them a singular one.
      const one = actions.decorationNames([...kinds]);
      const many = actions.decorationNames([...kinds, ...kinds]);
      expect(new Set(many).size).toBe(kinds.length);
      expect(many.filter((name) => one.includes(name))).toEqual([]);
    }
    i18n.setLocale("en");
  });

  it("the background option's words: stretched or removed, always whole", async () => {
    const i18n = await import("../src/i18n");
    const { boxOptionText } = await import("../src/viewer/LineLayer");
    const fill = { fill: true, stroke: false };
    const stroke = { fill: false, stroke: true };
    const both = { fill: true, stroke: true };
    expect(boxOptionText(fill, false)).toBe("Stretch the background too");
    expect(boxOptionText(stroke, true)).toBe("Remove the border too");
    expect(boxOptionText(both, false)).toBe("Stretch the background and border too");
    i18n.setLocale("it");
    try {
      expect(boxOptionText(fill, false)).toBe("Allunga anche lo sfondo");
      expect(boxOptionText(fill, true)).toBe("Togli anche lo sfondo");
      expect(boxOptionText(stroke, false)).toBe("Allunga anche il bordo");
      expect(boxOptionText(both, true)).toBe("Togli anche lo sfondo e il bordo");
    } finally {
      i18n.setLocale("en");
    }
  });

  it("the editor's question: kept only for the editor still open on the page as it was; a failure is quiet", async () => {
    const { askDecorations } = await import("../src/viewer/LineLayer");
    await openWith("DE.pdf", {});
    const page = state.doc.value!.pages[0];
    state.toasts.value = [];
    const original = engineImpl.lineDecorations;
    const info = DECORATIONS({ underlines: 1, links: 1, box: PILL });
    const asked: number[][] = [];
    engineImpl.lineDecorations = async (p: number, l: number) => {
      asked.push([p, l]);
      return info;
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const rev = page.rev.peek();
      expect(await askDecorations(page, LINE, rev, () => true)).toBe(info);
      expect(asked).toEqual([[0, 0]]);
      expect(state.editingDecorations.value).toEqual({ pageIndex: 0, lineIndex: 0, rev, info });
      state.editingDecorations.value = null;

      // The editor closed (or wrote) before the answer came.
      expect(await askDecorations(page, LINE, rev, () => false)).toBeNull();
      expect(state.editingDecorations.value).toBeNull();

      // The page changed before the answer came: its line indices are stale.
      const held = hold("lineDecorations");
      const asking = askDecorations(page, LINE, rev, () => true);
      const release = await held;
      state.invalidatePages([0]);
      release();
      expect(await asking).toBeNull();
      expect(state.editingDecorations.value).toBeNull();

      // The engine could not say: the console only, the editor works as without decorations.
      engineImpl.lineDecorations = async () => { throw new Error("no decorations"); };
      expect(await askDecorations(page, LINE, page.rev.peek(), () => true)).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(state.editingDecorations.value).toBeNull();
      expect(toastTexts()).toEqual([]);
      expect(calls).toEqual([]); // not an edit
    } finally {
      warn.mockRestore();
      engineImpl.lineDecorations = original;
    }
  });

  it("the details panel: what follows the text, the option, what stays and why; nothing when there is none", async () => {
    const i18n = await import("../src/i18n");
    const { decorationFacts } = await import("../src/ui/DetailsPanel");
    expect(decorationFacts(DECORATIONS())).toEqual({ follows: [], stays: [] });
    const info = DECORATIONS({
      underlines: 2, links: 1, box: { fill: true, stroke: true, suggested: false },
      left: [{ kind: "underline", reason: "colour" }, { kind: "underline", reason: "colour" }, { kind: "link", reason: "direction" }],
    });
    expect(decorationFacts(info)).toEqual({
      follows: ["Underline and link", "Background and border: your choice"],
      stays: ["Underline: it's a different colour from the text", "Link: the text is vertical or slanted"],
    });
    expect(decorationFacts(DECORATIONS({ strikes: 1, box: PILL }))).toEqual({ follows: ["Strike-through", "Background: your choice"], stays: [] });
    i18n.setLocale("it");
    try {
      expect(decorationFacts(info)).toEqual({
        follows: ["Sottolineatura e link", "Sfondo e bordo: a scelta"],
        stays: ["Sottolineatura: ha un colore diverso dal testo", "Link: il testo è verticale o inclinato"],
      });
      expect(decorationFacts(DECORATIONS({ left: [{ kind: "overline", reason: "overline" }] })))
        .toEqual({ follows: [], stays: ["Linea sopra il testo: potrebbe essere una riga per la firma"] });
    } finally {
      i18n.setLocale("en");
    }
  });
});

describe("U56 the line editor's bar with the background option", () => {
  // The layout is CSS (components are not rendered here): its rules that the fixes rest on are read
  // from the file. Measured in a browser with the real CSS for the review: 304, 344 and 359 px pages
  // in both languages, pages down to 149 px, the bar above and below the line.
  const viewerCss = readFileSync(new URL("../src/styles/viewer.css", import.meta.url), "utf8");
  /** The bodies of the rules of viewer.css whose selector is exactly `selector`, in file order. */
  function rules(selector: string): string[] {
    const found: string[] = [];
    for (const m of viewerCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selectors = m[1].replace(/\/\*[\s\S]*?\*\//g, "").split(",").map((s) => s.trim());
      if (selectors.includes(selector)) found.push(m[2]);
    }
    return found;
  }
  const px = (body: string, property: string) => {
    const m = new RegExp(String.raw`(?:^|[;\s])${property}:\s*(\d+)px`).exec(body);
    return m ? Number(m[1]) : null;
  };

  it("the bar's side is chosen with room for the option's row, so its coming never flips the bar", async () => {
    const { BAR_OFFSET, barGoesBelow, barRoom } = await import("../src/viewer/LineLayer");
    for (const coarse of [false, true]) {
      const buttons = coarse ? 44 : 36;
      // Room above for the row of buttons alone (enough before the fix), not for the option's row
      // too: below from the start, so the option does not push the buttons to the other side.
      expect(barGoesBelow(BAR_OFFSET + buttons + 10, 400, coarse)).toBe(true);
      expect(barGoesBelow(BAR_OFFSET + barRoom(coarse), 400, coarse)).toBe(false);
      // Less room below than above: it stays above (and the option's row sticks out a little).
      expect(barGoesBelow(BAR_OFFSET + buttons + 10, BAR_OFFSET + buttons, coarse)).toBe(false);
    }
  });

  it("barRoom is the bar's height in viewer.css with one row of the option", async () => {
    const { barRoom } = await import("../src/viewer/LineLayer");
    const [row, rowCoarse] = rules(".context-row");
    const [option, optionCoarse] = rules(".btn.context-option");
    const gap = px(rules(".context-bar")[0], "gap")!;
    const chrome = 2 * (1 + px(rules(".context-bar")[0], "padding")!); // its border and padding
    expect([px(row, "height"), px(rowCoarse, "height"), gap, chrome]).toEqual([28, 36, 4, 8]);
    expect(barRoom(false)).toBe(chrome + px(row, "height")! + gap + px(option, "min-height")!);
    expect(barRoom(true)).toBe(chrome + px(rowCoarse, "height")! + gap + px(optionCoarse, "min-height")!);
  });

  it("the bar's side is chosen for the option's words as they wrap, before the engine says which (D23 edge)", async () => {
    const { BAR_OFFSET, barFitsAbove, barGoesBelow, barRoom } = await import("../src/viewer/LineLayer");
    // Measured in the app (vite, the real CSS, desktop, a mouse): decorations-chrome.pdf at 25%, its
    // page 149 px wide, the line "Amount" with its field 86.5 px below the page's top (94.5 px below
    // the viewer's). Cancel and Apply make the bar 167 px wide, wider than the page, so the option
    // gets their width: "Stretch the background and border too" takes three lines there (59 px,
    // optionHeight), "Allunga anche lo sfondo e il bordo" two (43 px); the bar is 99 px tall.
    const top = 86.5;
    const english = 59;
    const italian = 43;
    // Placed for one line of words, as before: above the line, and its top 25 px past the page's,
    // cut off above the first page.
    expect(barFitsAbove(top, false)).toBe(true);
    expect(barGoesBelow(top + 8, 400, false)).toBe(false);
    expect(top - BAR_OFFSET - barRoom(false, english)).toBeLessThan(-20);
    // Placed for its words as they wrap: below the line from the start, in both languages.
    for (const option of [english, italian]) {
      expect(barFitsAbove(top, false, option)).toBe(false);
      expect(barGoesBelow(top + 8, 400, false, option)).toBe(true);
    }
    // Further down the page ("A long link that wraps", 119 px) it fits above, inside the page.
    expect(barFitsAbove(119, false, english)).toBe(true);
    expect(barGoesBelow(119 + 8, 400, false, english)).toBe(false);
    // The room asked for is the bar's height exactly: the buttons' row, the gap, the option's row
    // as tall as measured (one line of words when not measured yet).
    for (const coarse of [false, true]) {
      const buttons = coarse ? 44 : 36;
      expect(barRoom(coarse)).toBe(barRoom(coarse, coarse ? 36 : 28));
      for (const option of [28, 36, 43, 59, 76]) {
        expect(barRoom(coarse, option)).toBe(buttons + 4 + option);
        expect(barFitsAbove(BAR_OFFSET + barRoom(coarse, option), coarse, option)).toBe(true);
        expect(barFitsAbove(BAR_OFFSET + barRoom(coarse, option) - 0.5, coarse, option)).toBe(false);
        // Not enough room above, and less below: it stays above, as with one line.
        expect(barGoesBelow(BAR_OFFSET + buttons, BAR_OFFSET + buttons - 1, coarse, option)).toBe(false);
      }
    }
  });

  it("the bar is placed for every set of words the option can show, in both languages", async () => {
    const i18n = await import("../src/i18n");
    const { boxOptionText, boxOptionTexts } = await import("../src/viewer/LineLayer");
    const kinds = [{ fill: true, stroke: false }, { fill: false, stroke: true }, { fill: true, stroke: true }];
    for (const locale of ["en", "it"] as const) {
      i18n.setLocale(locale);
      const texts = boxOptionTexts();
      const shown = [false, true].flatMap((removing) => kinds.map((kind) => boxOptionText(kind, removing)));
      expect(texts).toEqual(shown);
      expect(new Set(texts).size).toBe(6);
    }
    i18n.setLocale("en");
    expect(boxOptionTexts()).toContain("Remove the background and border too");
  });

  it("optionHeight: the tallest of the words, set in a hidden copy of the option at its width, taken out again", async () => {
    const { optionHeight } = await import("../src/viewer/LineLayer");
    // A stand-in for the DOM: the copy's height is its lines of words (7 px a character) at its
    // widest (its max-width, less the check box and padding), 16.25 px a line, as in viewer.css.
    const made: any[] = [];
    const element = (tag: string) => {
      const el: any = {
        tag, className: "", style: {}, attributes: {}, children: [] as any[], textContent: "", removed: false,
        setAttribute(name: string, value: string) { el.attributes[name] = value; },
        appendChild(child: any) { el.children.push(child); child.parent = el; return child; },
        remove() { el.removed = true; },
        getBoundingClientRect() {
          const words = el.children[1]?.textContent ?? "";
          const lines = Math.ceil((words.length * 7) / (parseFloat(el.style.maxWidth) - 40));
          return { height: 10 + 16.25 * lines };
        },
      };
      made.push(el);
      return el;
    };
    const create = vi.spyOn(document, "createElement").mockImplementation(element as any);
    try {
      const bar: any = { children: [] as any[], appendChild(child: any) { this.children.push(child); return child; } };
      const texts = ["Stretch the border too", "Stretch the background and border too", "Remove the border too"];
      // The option as wide as the buttons' row (159 px), the room for it less than that: three lines.
      expect(optionHeight(bar, texts, 159, 140)).toBe(Math.ceil(10 + 16.25 * 3));
      const [probe] = bar.children;
      expect(probe.className).toBe("btn context-btn context-option is-probe");
      expect(probe.attributes["aria-hidden"]).toBe("true");
      expect([probe.style.minWidth, probe.style.maxWidth]).toEqual(["159px", "159px"]);
      expect(probe.children.map((c: any) => c.className)).toEqual(["context-option-box", "context-option-text"]);
      expect(probe.removed).toBe(true);
      // More room than the buttons: as wide as its words need, up to the room.
      expect(optionHeight(bar, texts, 159, 320)).toBe(Math.ceil(10 + 16.25 * 1));
      expect(bar.children[1].style.maxWidth).toBe("320px");
      expect(made.filter((el) => el.className.includes("is-probe")).every((el) => el.removed)).toBe(true);
    } finally {
      create.mockRestore();
    }
    // The copy has the option's own classes, so viewer.css sets its words the same way.
    const source = readFileSync(new URL("../src/viewer/LineLayer.tsx", import.meta.url), "utf8");
    expect(source).toContain(`class="btn context-btn context-option"`);
  });

  it("the option's row never moves the bar: it widens it only as far as the page and the screen go", async () => {
    const { barAcross } = await import("../src/viewer/LineLayer");
    const CHROME = 8; // the bar's border and padding across, as in viewer.css
    // A 320 px phone, its page 304 px wide at fit width, a line at its left edge, the bar's row of
    // buttons 199 px wide: room for "Allunga anche lo sfondo e il bordo" on one line.
    const view = { left: 0, right: 320 };
    const page = { left: 8, right: 312 };
    expect(barAcross(23, 199, view, page)).toEqual({ left: 23, optionRoom: 281 });
    // A line further right: the bar is shifted to stay in view as before, the room is what is left.
    expect(barAcross(200, 199, view, page)).toEqual({ left: 113, optionRoom: 191 });
    // A page narrower than the buttons (a receipt, a low zoom): the slot puts the bar at the page's
    // left edge; the option gets no more than the buttons' width (its words wrap there).
    const narrow = { left: 8, right: 204 };
    const r = barAcross(23, 199, view, narrow);
    expect(r.optionRoom).toBeLessThanOrEqual(199 - CHROME);
    // Over many places: the bar at its widest with the option stays on the page and in view, so
    // neither the slot's indent nor the nudge (worked out from the buttons alone) moves it.
    for (const pageWidth of [149, 196, 220, 304, 344, 359, 399, 600, 1200]) {
      for (const viewRight of [320, 360, 375, 1000]) {
        for (const width of [183, 191, 199, 388]) {
          for (const wanted of [-40, 0, 13, 100, 250, 500]) {
            const p = { left: 8, right: 8 + pageWidth };
            const v = { left: 0, right: viewRight };
            const { left, optionRoom } = barAcross(wanted, width, v, p);
            const placed = Math.max(p.left, Math.min(left, p.right - width));
            const widest = Math.max(width, optionRoom + CHROME);
            if (width <= Math.min(p.right, v.right - 8) - placed) {
              expect(placed + widest).toBeLessThanOrEqual(Math.min(p.right, v.right - 8));
            } else {
              expect(widest).toBe(width); // the buttons already fill the room: the option adds nothing
            }
          }
        }
      }
    }
  });

  it("viewer.css: the option is never cut, never clamps the bar, and grows away from the line", () => {
    // The clamp that cut the label and pushed Apply out of narrow bars (D23, D24) is gone.
    expect(viewerCss).not.toMatch(/\.has-option/);
    const [option] = rules(".btn.context-option");
    expect(option).toMatch(/min-width:\s*100%/); // never narrower than Cancel and Apply
    expect(option).toMatch(/max-width:\s*var\(--option-room, 0px\)/); // never wider than the room
    expect(option).toMatch(/white-space:\s*normal/); // wraps rather than cuts
    for (const body of rules(".context-option-text")) expect(body).not.toMatch(/text-overflow|overflow:/);
    // A column, reversed below the line, so the option's row is on the side away from it (D25);
    // the buttons' row keeps its own width when the option widens the bar.
    expect(rules(".context-bar.line-bar")[0]).toMatch(/flex-direction:\s*column;/);
    expect(rules(".context-slot.is-below .line-bar")[0]).toMatch(/flex-direction:\s*column-reverse/);
    expect(rules(".context-row")[0]).toMatch(/align-self:\s*flex-start/);
    // The copy that optionHeight measures: out of the bar's layout, unseen, as wide as its words
    // need between the min- and max-width it is given (the option's).
    const [probe] = rules(".btn.context-option.is-probe");
    expect(probe).toMatch(/position:\s*absolute/);
    expect(probe).toMatch(/visibility:\s*hidden/);
    expect(probe).toMatch(/width:\s*max-content/);
    expect(probe).not.toMatch(/min-width|max-width|white-space|padding|font/);
  });

  it("a page too short for the bar on either side: the side with more room, on the page and in what the pages' box shows", async () => {
    const { BAR_OFFSET, barFitsAbove, barGoesBelow, barRoom, shownBand } = await import("../src/viewer/LineLayer");
    // The pages' box clips what stands out of it: the room it cuts off is not the viewer's.
    expect(rules(".pages")[0]).toMatch(/overflow:\s*clip/);
    // Reproduced in the app (vite, the real CSS): desktop 1280x800, English, a single 612x396 pt page
    // at 25% (153x99 px), the engine offering {fill, stroke}, the line at 350 pt. The viewer shows
    // 127.5 to 800 px; the pages' box is 127.5 to 306.5 (24 px margins, 32 px more after the last
    // page). The field's top is 86 px below the page's (237.5 on screen), 5.2 px tall (4 px words).
    // The option's words at the buttons' width take three lines (59 px): the bar is 99 px tall.
    const option = 59;
    const bar = barRoom(false, option);
    expect(bar).toBe(99);
    const page = { top: 127.5 + 24, height: 99 };
    const field = { top: page.top + 86, bottom: page.top + 86 + 5.2 };
    const view = { top: 127.5, bottom: 800 };
    const pages = { top: 127.5, bottom: 127.5 + 24 + 99 + 24 + 32 };
    const onPage = { above: field.top - page.top, below: page.top + page.height - field.bottom };
    // It fits on neither side of the page.
    expect(barFitsAbove(onPage.above, false, option)).toBe(false);
    expect(onPage.below).toBeLessThan(BAR_OFFSET + bar);
    // Before: below, because it did not fit above (on the page, and on screen counting the empty
    // viewer under the document), with 48 px of it cut off by the pages' box.
    const before = barGoesBelow(field.top - view.top, view.bottom - field.bottom, false, option)
      || !barFitsAbove(onPage.above, false, option);
    expect(before).toBe(true);
    expect(field.bottom + BAR_OFFSET + bar - pages.bottom).toBeCloseTo(48.2, 1);
    // Now: on screen only what the pages' box shows counts, and on the page the side with more room
    // wins. Above, in the margin over the page: at most its border and padding (4 px) are cut.
    const shown = shownBand(view, pages);
    expect(shown).toEqual({ top: 127.5, bottom: 306.5 });
    const flip = barGoesBelow(field.top - shown.top, shown.bottom - field.bottom, false, option);
    const below = flip || barGoesBelow(onPage.above, onPage.below, false, option);
    expect([flip, below]).toEqual([false, false]);
    const cut = pages.top - (field.top - BAR_OFFSET - bar);
    expect(cut).toBeCloseTo(2, 5);
    expect(cut).toBeLessThan(4);

    // D23 stays fixed: decorations-chrome.pdf at 25% (a 210.5 px page), the line "Amount" 86.5 px
    // down: the bar goes below in both languages (the page decides: the Italian words would fit
    // above on screen, in the margin over the page, but not on the page).
    for (const [words, onScreen] of [[59, true], [43, false]] as const) {
      const top = 127.5 + 24 + 86.5;
      const b = shownBand(view, { top: 127.5, bottom: 127.5 + 24 + 210.5 + 24 + 32 });
      const flipped = barGoesBelow(top - b.top, b.bottom - (top + 5.2), false, words);
      expect(flipped).toBe(onScreen);
      expect(flipped || barGoesBelow(86.5, 210.5 - (86.5 + 5.2), false, words)).toBe(true);
    }
    // A long document: the pages' box reaches past what shows, and changes nothing.
    expect(shownBand(view, { top: -4000, bottom: 9000 })).toEqual(view);
    expect(shownBand(view)).toEqual(view);

    // Every place of the line on a short page, every option height: above when the bar fits there;
    // otherwise below when it fits there; otherwise on the side with more room.
    for (const coarse of [false, true]) {
      for (const words of [28, 36, 43, 59, 76]) {
        const need = BAR_OFFSET + barRoom(coarse, words);
        for (const height of [60, 99, 150, 260]) {
          for (let top = 0; top <= height - 5; top += 0.5) {
            const room = height - (top + 5);
            const goes = barGoesBelow(top, room, coarse, words);
            if (top >= need) expect(goes).toBe(false);
            else if (room >= need) expect(goes).toBe(true);
            else expect(goes).toBe(room > top);
          }
        }
      }
    }

    // The editor decides with these: the page's room on both sides, and the band of shownBand.
    const source = readFileSync(new URL("../src/viewer/LineLayer.tsx", import.meta.url), "utf8");
    expect(source).toContain("const below = flip || barGoesBelow(top, page.height * zoom - (top + height), isCoarse.value, optionTall);");
    expect(source).toMatch(/shownBand\(\s*\{ top: viewTop, bottom: viewBottom \}, field\.closest<HTMLElement>\("\.pages"\)\?\.getBoundingClientRect\(\),?\s*\)/);
    expect(source).toContain("setFlip(barGoesBelow(f.top - shown.top, shown.bottom - f.bottom, coarse, tall));");
  });
});
