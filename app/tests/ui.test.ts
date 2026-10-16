// UI logic against the app's real modules with a fake engine (no browser): overlapping opens,
// text still in the line editor, no-op edits, saves finishing late, download re-entry, render
// scale caps, engine error codes, edited-page marks, closing a document, leaving edit mode, the
// service-worker update flow, and the downloads of phase 3 (one tap keeping PDF/A and passwords,
// the PDF/A check and questions, the download options' rules and messages, the PDF/A texts, the
// details panel's protection row), and the images of release 2 (selection, edits, replacement,
// Escape, the details panel's image facts).
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
    images() { return Promise.resolve([]); }
    transformImage(p: number, i: number, matrix: number[]) { return e().transformImage(p, i, matrix); }
    deleteImage(p: number, i: number) { return e().deleteImage(p, i); }
    replaceImage(p: number, i: number, bytes: ArrayBuffer) { return e().replaceImage(p, i, bytes); }
    renderImage() { return Promise.reject(new Error("no bitmaps in Node")); }
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
