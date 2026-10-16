// UI logic against the app's real modules with a fake engine (no browser): overlapping opens,
// text still in the line editor, no-op edits, saves finishing late, download re-entry, render
// scale caps, engine error codes, edited-page marks, closing a document, leaving edit mode, the
// service-worker update flow, and the downloads of phase 3 (one tap keeping PDF/A and passwords,
// the PDF/A check and questions, the download options' rules and messages, the PDF/A texts, the
// details panel's protection row).
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
    save(options: unknown) { return e().save(options); }
    pdfaCheck() { return e().pdfaCheck(); }
    close() { return e().close(); }
  }
  return { EngineError, EngineClient };
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
const engineImpl: any = {
  open: async (bytes: ArrayBuffer) => {
    calls.push("open:" + new TextDecoder().decode(bytes));
    return {
      ok: true, pageCount: 1, pages: [{ index: 0, bounds: [0, 0, 100, 100] }], encrypted: false,
      needsPassword: false, canKeepPassword: false, pdfa: null, signatures: 0, title: null, ...nextInfo,
    };
  },
  replaceLine: async () => { calls.push("replaceLine"); return edited([0]); },
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
