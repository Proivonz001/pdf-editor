// The scan flow in the UI (release 4, "Foto e scansione"), against the app's real state with a
// fake scan client (photos analysed and pages made on demand, each answer under the test's
// control), a fake device store (what saveScan kept, what was forgotten) and stand-ins for the two
// actions Fine ends in (a new PDF, pages inserted): the tray's pure operations; what Fine does per
// target (a new PDF named by the date, or the pages at the target's place, as copies, the tray
// left as it was when that fails or is refused; the scan forgotten when it worked); a save of the
// tray after every page that joins, leaves, moves or is retaken; photos picked together read one
// after the other, with what fails said and skipped; the corner editor's corners (found, the
// whole photo, crossed); a failed page that leaves the editor to try again; Cancel asking only
// with pages; the flow closing (photos closed, the scan worker disposed, late answers dropped);
// and Riprendi on a kept scan. Fix round 1 (S5): a dismissed picker, an unfinished scan kept from
// before, a resumed insert without its document, the engine down at Fine, the worker after a
// close during a decode, the HEIC words per device, and the window's shortcuts and drops (real
// shortcuts.ts and DropOverlay.tsx, with its hooks run at once) while the flow is open. Fix round
// 2 (S6): pages the device could not keep (a full store, with the real platform/resume.ts on the
// fake IndexedDB): no "Più tardi" (what the flow shows, ScanFlow called as a function) and the
// hint saying so, a later save that works bringing it back, and "Più tardi" waiting for the save
// on its way. Fix round 3 (S7): a scan kept for one document never goes into another (resumed or
// continued, its pages wait for theirs, and the flow names it); the place follows page operations
// that land while the flow is open (the real viewer model); Done lets the kept scan go only once
// the autosave has answered for the document holding its pages (a stand-in for it), and a new
// opening meanwhile does not offer those pages back.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "./stubs/browser-globals";
import { fakeIndexedDB } from "./stubs/fake-indexeddb";

/**
 * DropOverlay's hooks, run at once outside a render (no DOM here): its effect installs its
 * listeners. The rest let a component be called as a function, to see what it shows (`shown`):
 * refs that stay empty, ids, layout effects that do not run.
 */
const hooks = vi.hoisted(() => ({ sets: [] as unknown[], ids: 0 }));
vi.mock("preact/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("preact/hooks")>()),
  useEffect: (fn: () => unknown) => {
    fn();
  },
  useState: (init: unknown) => [typeof init === "function" ? (init as () => unknown)() : init, (v: unknown) => {
    hooks.sets.push(v);
  }],
  useRef: (init: unknown) => ({ current: init }),
  useId: () => `id${++hooks.ids}`,
  useLayoutEffect: () => undefined,
}));

vi.mock("../src/engine/client.ts", () => {
  class EngineError extends Error {
    constructor(message: string, readonly code?: string) {
      super(message);
    }
  }
  class EngineClient {
    ready = Promise.resolve();
  }
  return { EngineError, EngineClient };
});

/** What the fakes did, and how they answer next (set by each test). */
const fake = vi.hoisted(() => ({
  analysed: [] as { name: string }[],
  processed: [] as { corners: unknown; mode: string; shape: string; photo: unknown }[],
  disposed: 0,
  /** analysePhoto's answer for a file: by default a found sheet. */
  analyse: null as null | ((file: { name: string }) => Promise<unknown>),
  /** processPhoto's answer: by default a page. */
  process: null as null | (() => Promise<unknown>),
  saves: [] as { target: unknown; doc: unknown; pages: { bytes: ArrayBuffer; width: number; preview: ArrayBuffer }[] }[],
  forgets: 0,
  /** Read when a save answers (after `saveHold`): true, it is refused (a full or blocked store). */
  refuseSaves: false,
  /** While set, saves wait for it before they answer (a slow or stalled write). */
  saveHold: null as null | Promise<void>,
  /** The real platform/resume.ts (on a fake IndexedDB) when a test uses it instead of the stand-in. */
  real: null as null | typeof import("../src/platform/resume"),
  /** The scan the fake store keeps now (saveScan replaces it, forgetScan removes it). */
  keptScan: null as any,
  /** scanSummary's answer, when a test holds it back. */
  summaryAnswer: null as null | (() => Promise<unknown>),
  /** loadScan's answer, when a test changes it ("unreadable": null while the summary stays). */
  loadAnswer: "kept" as "kept" | "unreadable",
  /** The document the fake store keeps for Riprendi (sessionSummary), or null. */
  keptSession: null as null | { fileName: string; savedAt: number; editCount: number; pageCount: number },
  newPdf: [] as { pictures: { bytes: ArrayBuffer; width: number; height: number; dpi: number }[]; name: string }[],
  newPdfAnswer: true as boolean | Error,
  /** What the fake newFromPicturesAction does to the engine's status before it answers. */
  newPdfEngine: null as null | "error",
  inserted: [] as { edit: any; show: unknown }[],
  insertAnswer: "ok" as "ok" | "null" | "throw",
  /** The document actions the window's shortcuts and drops ran. */
  acted: [] as string[],
  /** The autosave asked to keep the open document now (keepOpenDocument), and its answer. */
  keepAsked: 0,
  keepDocument: null as null | (() => Promise<boolean | "kept" | "none" | "failed">),
}));

// The autosave (ui/resume, tested in resume-ui.test.ts): only what Fine asks of it.
vi.mock("../src/ui/resume/autosave.ts", () => ({
  // A boolean answer stands for "kept" / "none" (what keepOpenDocument says); or the outcome itself.
  keepOpenDocumentOutcome: () => {
    fake.keepAsked++;
    return (fake.keepDocument ? fake.keepDocument() : Promise.resolve(false))
      .then((ok) => (typeof ok === "string" ? ok : ok ? "kept" : "none"));
  },
}));

vi.mock("../src/scan/scanClient.ts", async () => {
  const types = await vi.importActual<typeof import("../src/scan/types")>("../src/scan/types");
  return {
    ScanError: types.ScanError,
    FOUND_CONFIDENCE: 0.5,
    analysePhoto: (file: { name: string }) => {
      fake.analysed.push({ name: file.name });
      return fake.analyse!(file);
    },
    processPhoto: (photo: unknown, corners: unknown, mode: string, shape: string) => {
      fake.processed.push({ photo, corners, mode, shape });
      return fake.process!();
    },
    disposeScanWorker: () => {
      fake.disposed++;
    },
  };
});

vi.mock("../src/platform/resume.ts", () => {
  const stand: Record<string, (...args: any[]) => Promise<unknown>> = {
    saveScan: async (s: any) => {
      const doc = s.doc ? { ...s.doc } : null;
      fake.saves.push({ target: structuredClone(s.target), doc, pages: s.pages.slice() });
      if (fake.saveHold) await fake.saveHold;
      if (fake.refuseSaves) return false;
      fake.keptScan = s.pages.length ? { target: structuredClone(s.target), doc, savedAt: Date.now(), pages: s.pages.slice() } : null;
      return true;
    },
    forgetScan: async () => {
      fake.forgets++;
      fake.keptScan = null;
    },
    scanSummary: async () => {
      if (fake.summaryAnswer) return fake.summaryAnswer();
      const k = fake.keptScan;
      return k ? { target: k.target, doc: k.doc ?? null, savedAt: k.savedAt, pages: k.pages.length } : null;
    },
    loadScan: async () => (fake.loadAnswer === "unreadable" ? null : fake.keptScan),
    sessionSummary: async () => fake.keptSession,
  };
  // The stand-in, or the real store when a test asked for it (fake.real).
  const via = (name: string) => (...args: any[]) => (fake.real ? (fake.real as any)[name](...args) : stand[name](...args));
  return Object.fromEntries(Object.keys(stand).map((name) => [name, via(name)]));
});

vi.mock("../src/ui/actions.ts", () => {
  const act = (name: string) => () => {
    fake.acted.push(name);
  };
  return {
    newFromPicturesAction: async (pictures: any[], name: string) => {
      fake.newPdf.push({ pictures, name });
      if (fake.newPdfEngine) (await import("../src/state")).engineStatus.value = fake.newPdfEngine;
      if (fake.newPdfAnswer instanceof Error) throw fake.newPdfAnswer;
      return fake.newPdfAnswer;
    },
    // What the window's shortcuts and drops would do to the document (shortcuts.ts, DropOverlay.tsx).
    undo: act("undo"),
    redo: act("redo"),
    download: act("download"),
    setTool: act("setTool"),
    setEditTool: act("setEditTool"),
    selectImage: act("selectImage"),
    cancelWriter: act("cancelWriter"),
    cancelPlacement: act("cancelPlacement"),
    placeAtCentre: act("placeAtCentre"),
    openFile: act("openFile"),
    isPdfFile: (f: File) => /\.pdf$/i.test(f.name),
  };
});

vi.mock("../src/ui/pageActions.ts", () => ({
  runPagesEdit: async (edit: any, show: unknown) => {
    fake.inserted.push({ edit, show });
    if (fake.insertAnswer === "throw") throw new Error("engine down");
    if (fake.insertAnswer === "null") return null;
    const added = edit.pictures.length;
    return {
      editCount: 1, canUndo: true, canRedo: false, changedPages: [],
      layout: { pages: [], from: [0, ...new Array(added).fill(null)], form: null, signatures: 0 },
      report: { linksRemoved: 0, fieldsRenamed: 0, signaturesAdded: 0 },
    };
  },
}));

let state: typeof import("../src/state");
let flow: typeof import("../src/ui/scan/flow");
let i18n: typeof import("../src/i18n");
let types: typeof import("../src/scan/types");

beforeAll(async () => {
  state = await import("../src/state");
  flow = await import("../src/ui/scan/flow");
  i18n = await import("../src/i18n");
  types = await import("../src/scan/types");
});

// ---------------------------------------------------------------------------------------------
// Helpers

type Corners = import("../src/scan/types").Corners;
const W = 1000, H = 1400;
const FOUND: Corners = [[100, 120], [880, 100], [900, 1300], [80, 1280]];
const WHOLE: Corners = [[0, 0], [W, 0], [W, H], [0, H]];

/** A photo as analysePhoto answers, with a bitmap that records its close(). */
function photoOf(confidence = 0.9, corners: Corners = FOUND) {
  const image = { closed: false, close() { this.closed = true; } };
  return { image, width: W, height: H, corners: confidence >= 0.5 ? corners : WHOLE, confidence };
}

let pageBytes = 0;
/** A page as processPhoto answers: distinct bytes each time. */
function pageOf() {
  const n = ++pageBytes;
  return {
    bytes: new Uint8Array([n, n, n, n]).buffer, width: 1654, height: 2339, dpi: 200,
    preview: new Blob([new Uint8Array([9, n])], { type: "image/jpeg" }),
  };
}

const file = (name: string, type = "image/jpeg") => ({ name, type, size: 1000 }) as unknown as File;

/** Let the flow's promises settle. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Answer the confirm dialog that is open. */
function answer(ok: boolean) {
  const d = state.dialog.value as any;
  expect(d?.kind).toBe("confirm");
  state.dialog.value = null;
  d.resolve(ok);
}

const corners = () => {
  const p = flow.phase.value;
  if (p.step !== "corners") throw new Error(`not in the corner editor but in "${p.step}"`);
  return p;
};

/** Open the flow for `target` as ScanFlow does when it mounts (flowOpened), and let it check the device. */
async function open(target: import("../src/state").ScanTarget = { kind: "new" }) {
  state.scanFlow.value = target;
  (flow as any).flowOpened?.();
  await settle();
}

/** A scan kept on the device from before, with `count` pages, for `target` (an insert: for the document `fileName`, when known). */
function keptBefore(count: number, target: import("../src/state").ScanTarget = { kind: "new" }, fileName: string | null = null) {
  fake.keptScan = {
    target, doc: fileName ? { fileName } : null, savedAt: 1000,
    pages: Array.from({ length: count }, (_, i) => ({
      bytes: new Uint8Array([100 + i]).buffer, width: 100, height: 141, dpi: 200, preview: new ArrayBuffer(2),
    })),
  };
  return fake.keptScan;
}

/** Open the flow for `target` and add a page per photo name. */
async function withPages(names: string[], target: import("../src/state").ScanTarget = { kind: "new" }) {
  await open(target);
  for (const name of names) {
    flow.addPhotos([file(name)]);
    await settle();
    await flow.makePage();
  }
  expect(flow.tray.value).toHaveLength(names.length);
}

beforeEach(() => {
  i18n.locale.value = "it";
  fake.analysed.length = 0;
  fake.processed.length = 0;
  fake.saves.length = 0;
  fake.newPdf.length = 0;
  fake.inserted.length = 0;
  fake.forgets = 0;
  fake.disposed = 0;
  fake.refuseSaves = false;
  fake.saveHold = null;
  fake.real = null;
  fake.keptScan = null;
  fake.summaryAnswer = null;
  fake.loadAnswer = "kept";
  fake.keptSession = null;
  fake.newPdfAnswer = true;
  fake.newPdfEngine = null;
  fake.insertAnswer = "ok";
  fake.acted.length = 0;
  fake.keepAsked = 0;
  fake.keepDocument = null;
  fake.analyse = async () => photoOf();
  fake.process = async () => pageOf();
  state.doc.value = null;
  state.dialog.value = null;
  state.toasts.value = [];
  state.engineStatus.value = "ready";
  flow.setScanMode("document");
  flow.setPageShape("a4");
});

afterEach(() => {
  state.scanFlow.value = null;
  flow.flowClosed();
  state.doc.value = null;
  state.tool.value = null;
  fake.real = null;
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------------------------

describe("S1 the tray's operations (pure)", () => {
  const page = (n: number) => flow.trayPage({ bytes: new Uint8Array([n]).buffer, width: 10, height: 14, dpi: 200 }, new ArrayBuffer(1));

  it("adds at the end, replaces in place, and adds when the page to replace has gone", () => {
    const [a, b, c] = [page(1), page(2), page(3)];
    expect(flow.withPage([a, b], c, null)).toEqual([a, b, c]);
    expect(flow.withPage([a, b], c, a.id)).toEqual([c, b]);
    expect(flow.withPage([a, b], c, 999_999)).toEqual([a, b, c]);
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
  });

  it("deletes and moves; a move off either end is refused", () => {
    const [a, b, c] = [page(1), page(2), page(3)];
    expect(flow.withoutPage([a, b, c], b.id)).toEqual([a, c]);
    expect(flow.movedPage([a, b, c], c.id, -1)).toEqual([a, c, b]);
    expect(flow.movedPage([a, b, c], a.id, 1)).toEqual([b, a, c]);
    expect(flow.movedPage([a, b, c], a.id, -1)).toBeNull();
    expect(flow.movedPage([a, b, c], c.id, 1)).toBeNull();
    expect(flow.movedPage([a, b, c], 999_999, 1)).toBeNull();
  });

  it("keeps the tray as the device store takes it, and makes a tray of what it kept, with new ids", () => {
    const [a, b] = [page(1), page(2)];
    const saved = flow.savedScanOf({ kind: "insert", at: 3 }, [b, a], 1234);
    expect(saved.target).toEqual({ kind: "insert", at: 3 });
    expect(saved.savedAt).toBe(1234);
    expect(saved.pages.map((p) => new Uint8Array(p.bytes)[0])).toEqual([2, 1]);
    expect(saved.pages[0]).toEqual({ bytes: b.picture.bytes, width: 10, height: 14, dpi: 200, preview: b.preview });
    const back = flow.trayOf(saved);
    expect(back.map((p) => new Uint8Array(p.picture.bytes)[0])).toEqual([2, 1]);
    expect(back[0].picture).toEqual({ bytes: b.picture.bytes, width: 10, height: 14, dpi: 200 });
    expect(back.every((p) => p.id !== a.id && p.id !== b.id)).toBe(true);
  });

  it("Fine: a new PDF named by the local date, or the pages at a place kept within the document", () => {
    const day = new Date(2026, 9, 7, 23, 30);
    expect(flow.isoDate(day)).toBe("2026-10-07");
    expect(flow.finishPlan({ kind: "new" }, 4, day)).toEqual({ kind: "new", fileName: "Scansione 2026-10-07.pdf" });
    expect(flow.finishPlan({ kind: "insert", at: 2 }, 4, day)).toEqual({ kind: "insert", at: 2 });
    expect(flow.finishPlan({ kind: "insert", at: 9 }, 4, day)).toEqual({ kind: "insert", at: 4 });
    expect(flow.finishPlan({ kind: "insert", at: -3 }, 4, day)).toEqual({ kind: "insert", at: 0 });
    // An insert with no document open (a scan resumed before its document): a new PDF.
    expect(flow.finishPlan({ kind: "insert", at: 2 }, null, day)).toEqual({ kind: "new", fileName: "Scansione 2026-10-07.pdf" });
    i18n.locale.value = "en";
    expect(flow.scanFileName(day)).toBe("Scan 2026-10-07.pdf");
  });

  it("says why a photo cannot be used: too large, HEIC this browser cannot read, unreadable, anything else", () => {
    const { ScanError } = types;
    const heic = { name: "IMG_0001.HEIC", type: "" };
    const jpeg = { name: "a.jpg", type: "image/jpeg" };
    expect(flow.photoErrorText(new ScanError("x", "too-big"), jpeg, false)).toBe(i18n.t("image.pictureTooBig"));
    expect(flow.photoErrorText(new ScanError("x", "unreadable"), heic, false, true)).toBe(i18n.t("scan.photoHeic"));
    expect(flow.photoErrorText(new ScanError("x", "unreadable"), { name: "x", type: "image/heif" }, false, true)).toBe(i18n.t("scan.photoHeic"));
    expect(flow.photoErrorText(new ScanError("x", "unreadable"), jpeg, false)).toBe(i18n.t("image.pictureUnreadable"));
    expect(flow.photoErrorText(new Error("boom"), jpeg, false)).toBe(i18n.t("scan.photoFailed"));
    expect(flow.photoErrorText(new ScanError("x", "failed"), jpeg, true)).toBe(`“a.jpg”: ${i18n.t("scan.photoFailed")}`);
  });

  it("moves a corner inside the photo only", () => {
    const moved = flow.withCorner(FOUND, 2, [1200, -40], W, H);
    expect(moved[2]).toEqual([W, 0]);
    expect(moved[0]).toEqual(FOUND[0]);
    expect(FOUND[2]).toEqual([900, 1300]); // not changed in place
    expect(flow.sameCorners(FOUND, FOUND.map(([x, y]) => [x + 0.001, y]) as Corners)).toBe(true);
    expect(flow.sameCorners(FOUND, moved)).toBe(false);
  });
});

describe("S2 photos into pages", () => {
  it("does nothing while the flow is closed", async () => {
    flow.addPhotos([file("a.jpg")]);
    await settle();
    expect(fake.analysed).toEqual([]);
    expect(flow.phase.value.step).toBe("start");
  });

  it("reads a photo, opens the corner editor on the corners found, makes the page and keeps the tray", async () => {
    await open();
    const reading = deferred<unknown>();
    fake.analyse = () => reading.promise;
    flow.addPhotos([file("a.jpg")]);
    expect(flow.phase.value).toEqual({ step: "reading", index: 1, total: 1 });
    const photo = photoOf(0.93);
    reading.resolve(photo);
    await settle();
    const editing = corners();
    expect(editing.photo).toBe(photo);
    expect(editing.corners).toEqual(FOUND);
    expect(editing.found).toEqual(FOUND);
    expect(editing.replaces).toBeNull();

    flow.setScanMode("bw");
    flow.setPageShape("photo");
    await flow.makePage();
    expect(fake.processed).toHaveLength(1);
    expect(fake.processed[0]).toMatchObject({ photo, corners: FOUND, mode: "bw", shape: "photo" });
    expect(photo.image.closed).toBe(true); // its page is made: the working photo goes
    expect(flow.phase.value).toEqual({ step: "tray", finishing: false });
    const [page] = flow.tray.value;
    expect(page.picture).toEqual({ bytes: expect.any(ArrayBuffer), width: 1654, height: 2339, dpi: 200 });
    expect([...new Uint8Array(page.preview)]).toEqual([9, pageBytes]);
    // Kept on the device at once, with its preview.
    expect(fake.saves).toHaveLength(1);
    expect(fake.saves[0].target).toEqual({ kind: "new" });
    expect(fake.saves[0].pages).toHaveLength(1);
    expect(fake.saves[0].pages[0].bytes).toBe(page.picture.bytes);
    expect(fake.saves[0].pages[0].preview).toBe(page.preview);
    expect(flow.said.value?.text).toBe("Pagina 1 aggiunta.");
  });

  it("starts from the whole photo when the sheet was not found surely; Tutta la foto goes there and back", async () => {
    await open();
    fake.analyse = async () => photoOf(0.3);
    flow.addPhotos([file("a.jpg")]);
    await settle();
    expect(corners().found).toBeNull();
    expect(corners().corners).toEqual(WHOLE);
    expect(flow.wholePhotoAction(corners())).toBeNull(); // nothing to do: the button is off
    flow.toggleWholePhoto(); // nothing found: stays the whole photo
    expect(corners().corners).toEqual(WHOLE);

    flow.discardPhoto();
    fake.analyse = async () => photoOf(0.8);
    flow.addPhotos([file("b.jpg")]);
    await settle();
    expect(corners().corners).toEqual(FOUND);
    expect(flow.wholePhotoAction(corners())).toBe("whole");
    flow.toggleWholePhoto();
    expect(corners().corners).toEqual(WHOLE);
    expect(flow.wholePhotoAction(corners())).toBe("found");
    flow.toggleWholePhoto();
    expect(corners().corners).toEqual(FOUND);
    // Moved by hand: the next press puts them on the whole photo again.
    const moved = flow.withCorner(FOUND, 0, [10, 10], W, H);
    flow.setCorners(moved);
    expect(corners().corners).toEqual(moved);
    flow.toggleWholePhoto();
    expect(corners().corners).toEqual(WHOLE);
  });

  it("refuses crossed corners without making anything, and says so", async () => {
    await open();
    flow.addPhotos([file("a.jpg")]);
    await settle();
    const crossed: Corners = [FOUND[1], FOUND[0], FOUND[2], FOUND[3]];
    flow.setCorners(crossed);
    await flow.makePage();
    expect(fake.processed).toEqual([]);
    expect(flow.alerted.value?.text).toBe(i18n.t("scan.cornersCrossed"));
    expect(corners().making).toBe(false);
    expect(fake.saves).toEqual([]);
  });

  it("a page that cannot be made leaves the editor as it was, to try again", async () => {
    await open();
    flow.addPhotos([file("a.jpg")]);
    await settle();
    const photo = corners().photo as any;
    const making = deferred<unknown>();
    fake.process = () => making.promise;
    const made = flow.makePage();
    expect(corners().making).toBe(true);
    flow.setCorners(WHOLE); // ignored while it is being made
    flow.discardPhoto(); // so is this
    expect(corners().corners).toEqual(FOUND);
    making.reject(new types.ScanError("no canvas", "failed"));
    await made;
    expect(corners().making).toBe(false);
    expect(flow.alerted.value?.text).toBe(i18n.t("scan.makeFailed"));
    expect(photo.image.closed).toBe(false);
    expect(flow.tray.value).toEqual([]);
    expect(fake.saves).toEqual([]);
    // Again, and this time it works.
    fake.process = async () => pageOf();
    await flow.makePage();
    expect(flow.tray.value).toHaveLength(1);
    expect(flow.alerted.value).toBeNull();
    expect(photo.image.closed).toBe(true);
  });

  it("reads photos picked together one after the other; a photo that fails is said and skipped; Scarta drops one", async () => {
    await open();
    fake.analyse = async (f) => {
      if (f.name === "b.heic") throw new types.ScanError("not here", "unreadable");
      return photoOf();
    };
    flow.addPhotos([file("a.jpg"), file("b.heic", "image/heic"), file("c.jpg"), file("d.jpg")]);
    await settle();
    expect(corners()).toMatchObject({ index: 1, total: 4 });
    await flow.makePage(); // a → page 1, then b fails, then c
    expect(fake.analysed.map((x) => x.name)).toEqual(["a.jpg", "b.heic", "c.jpg"]);
    expect(corners()).toMatchObject({ index: 3, total: 4 });
    expect(flow.alerted.value?.text).toBe(`“b.heic”: ${i18n.t("scan.photoHeicDesktop")}`); // no touch screen here
    const c = corners().photo as any;
    flow.discardPhoto(); // c makes no page
    expect(c.image.closed).toBe(true);
    await settle();
    expect(corners()).toMatchObject({ index: 4, total: 4 });
    await flow.makePage(); // d → page 2
    expect(flow.phase.value).toEqual({ step: "tray", finishing: false });
    expect(flow.tray.value).toHaveLength(2);
    // One save per page that joined the tray.
    expect(fake.saves.map((s) => s.pages.length)).toEqual([1, 2]);
  });

  it("a retake takes the place of its page once the new one is made; a retake dropped changes nothing", async () => {
    await withPages(["a.jpg", "b.jpg", "c.jpg"]);
    const [a, b, c] = flow.tray.value;
    fake.saves.length = 0;
    flow.addPhotos([file("b2.jpg"), file("ignored.jpg")], b.id);
    await settle();
    expect(corners().replaces).toBe(b.id);
    expect(corners().total).toBe(1); // a retake takes one photo
    await flow.makePage();
    const after = flow.tray.value;
    expect(after).toHaveLength(3);
    expect(after[0]).toBe(a);
    expect(after[2]).toBe(c);
    expect(after[1]).not.toBe(b);
    expect(flow.said.value?.text).toBe("Pagina 2 sostituita.");
    expect(fake.saves).toHaveLength(1);
    expect(fake.saves[0].pages.map((p) => p.bytes)).toEqual(after.map((p) => p.picture.bytes));
    expect(fake.analysed.map((x) => x.name)).not.toContain("ignored.jpg");

    // Retake dropped: the page stays, and the next photo is a new page again.
    flow.addPhotos([file("a2.jpg")], a.id);
    await settle();
    flow.discardPhoto();
    await settle();
    expect(flow.tray.value).toEqual(after);
    flow.addPhotos([file("e.jpg")]);
    await settle();
    expect(corners().replaces).toBeNull();
    await flow.makePage();
    expect(flow.tray.value).toHaveLength(4);
    expect(flow.tray.value[0]).toBe(a);
  });

  it("deletes and moves pages, keeping the tray on the device after each; the last page gone, back to the start", async () => {
    await withPages(["a.jpg", "b.jpg"]);
    const [a, b] = flow.tray.value;
    fake.saves.length = 0;
    expect(flow.movePage(a.id, -1)).toBe(false); // already first
    expect(fake.saves).toEqual([]);
    expect(flow.movePage(a.id, 1)).toBe(true);
    expect(flow.tray.value).toEqual([b, a]);
    expect(flow.said.value?.text).toBe("Pagina spostata in posizione 2.");
    flow.removePage(b.id);
    expect(flow.tray.value).toEqual([a]);
    expect(flow.said.value?.text).toBe("Pagina 1 eliminata.");
    flow.removePage(a.id);
    expect(flow.tray.value).toEqual([]);
    expect(flow.phase.value).toEqual({ step: "start" });
    // An empty tray is kept as such: the store forgets the scan.
    expect(fake.saves.map((s) => s.pages.map((p) => p.bytes))).toEqual([
      [b.picture.bytes, a.picture.bytes], [a.picture.bytes], [],
    ]);
  });

  it("says once when the device refuses to keep the tray", async () => {
    fake.refuseSaves = true;
    await withPages(["a.jpg"]);
    await settle();
    expect(flow.notKept.value).toBe(true);
  });
});

describe("S3 Fine", () => {
  it("target new: a new PDF of copies of the pages, named by the date; done, the scan is forgotten and the flow closes", async () => {
    await withPages(["a.jpg", "b.jpg"]);
    const pages = flow.tray.value;
    const done = flow.finishScan();
    expect(flow.phase.value).toEqual({ step: "tray", finishing: true });
    expect(await done).toBe(true);
    expect(fake.newPdf).toHaveLength(1);
    const { pictures, name } = fake.newPdf[0];
    expect(name).toBe(`Scansione ${flow.isoDate(new Date())}.pdf`);
    expect(pictures.map((p) => [...new Uint8Array(p.bytes)])).toEqual(pages.map((p) => [...new Uint8Array(p.picture.bytes)]));
    expect(pictures.every((p, i) => p.bytes !== pages[i].picture.bytes)).toBe(true); // copies
    expect(pictures[0]).toMatchObject({ width: 1654, height: 2339, dpi: 200 });
    expect(fake.forgets).toBe(1);
    expect(state.scanFlow.value).toBeNull();
    expect(fake.inserted).toEqual([]);
  });

  it("target new refused (edits not downloaded) or failed: the tray stays as it was, nothing forgotten", async () => {
    await withPages(["a.jpg"]);
    const pages = flow.tray.value;
    for (const outcome of [false, new Error("crashed")]) {
      fake.newPdfAnswer = outcome;
      expect(await flow.finishScan()).toBe(false);
      expect(flow.phase.value).toEqual({ step: "tray", finishing: false });
      expect(flow.tray.value).toBe(pages);
      expect(pages[0].picture.bytes.byteLength).toBe(4); // the engine got a copy
      expect(state.scanFlow.value).toEqual({ kind: "new" });
      expect(fake.forgets).toBe(0);
    }
  });

  it("target insert: the pages at the target's place in the open document, as one edit; done, a toast says how many", async () => {
    state.doc.value = { id: 7, fileName: "x.pdf", pages: [{}, {}, {}, {}, {}] } as any;
    await withPages(["a.jpg", "b.jpg"], { kind: "insert", at: 3 });
    expect(flow.targetNow(state.scanFlow.value!)).toEqual({ kind: "insert", at: 3 });
    expect(await flow.finishScan()).toBe(true);
    expect(fake.inserted).toHaveLength(1);
    const { edit, show } = fake.inserted[0];
    expect(edit.kind).toBe("pictures");
    expect(edit.at).toBe(3);
    expect(show).toBe(3);
    expect(edit.pictures).toHaveLength(2);
    expect(fake.newPdf).toEqual([]);
    expect(fake.forgets).toBe(1);
    expect(state.scanFlow.value).toBeNull();
    await settle();
    expect(state.toasts.value.map((x) => x.text)).toContain("2 pagine aggiunte.");
  });

  it("target insert that fails: said inside the flow, the tray kept", async () => {
    state.doc.value = { id: 7, fileName: "x.pdf", pages: [{}, {}] } as any;
    await withPages(["a.jpg"], { kind: "insert", at: 9 });
    for (const outcome of ["null", "throw"] as const) {
      fake.insertAnswer = outcome;
      expect(await flow.finishScan()).toBe(false);
      expect(fake.inserted.at(-1)!.edit.at).toBe(2); // kept within the document
      expect(flow.alerted.value?.text).toBe(i18n.t("scan.insertFailed"));
      expect(flow.tray.value).toHaveLength(1);
      expect(fake.forgets).toBe(0);
      expect(state.scanFlow.value).not.toBeNull();
    }
  });

  it("target insert with no document open (resumed first): a new PDF", async () => {
    await withPages(["a.jpg"], { kind: "insert", at: 1 });
    expect(flow.targetNow(state.scanFlow.value!)).toEqual({ kind: "new" });
    expect(await flow.finishScan()).toBe(true);
    expect(fake.newPdf).toHaveLength(1);
    expect(fake.inserted).toEqual([]);
  });

  it("nothing without pages, and only once at a time", async () => {
    await open();
    expect(await flow.finishScan()).toBe(false);
    await withPages(["a.jpg"]);
    const first = flow.finishScan();
    expect(await flow.finishScan()).toBe(false);
    flow.removePage(flow.tray.value[0].id); // not while Fine runs
    expect(flow.tray.value).toHaveLength(1);
    expect(await first).toBe(true);
    expect(fake.newPdf).toHaveLength(1);
  });
});

describe("S4 cancel, close, resume", () => {
  it("Cancel closes at once with an empty tray; with pages it asks, and No keeps everything", async () => {
    await open();
    expect(await flow.cancelScan()).toBe(true);
    expect(state.scanFlow.value).toBeNull();
    expect(state.dialog.value).toBeNull();
    expect(fake.forgets).toBe(1);

    await withPages(["a.jpg", "b.jpg"]);
    let asked = flow.cancelScan();
    await settle();
    expect((state.dialog.value as any).body).toBe("Le 2 pagine che hai scansionato andranno perse.");
    answer(false);
    expect(await asked).toBe(false);
    expect(state.scanFlow.value).toEqual({ kind: "new" });
    expect(fake.forgets).toBe(1);

    asked = flow.cancelScan();
    await settle();
    answer(true);
    expect(await asked).toBe(true);
    expect(state.scanFlow.value).toBeNull();
    expect(fake.forgets).toBe(2);
  });

  it("not while Fine runs", async () => {
    await withPages(["a.jpg"]);
    const done = flow.finishScan();
    expect(await flow.cancelScan()).toBe(false);
    expect(state.dialog.value).toBeNull();
    expect(await done).toBe(true);
    expect(fake.forgets).toBe(1);
  });

  it("closing drops the photo on screen and the queue, terminates the scan worker, and lands nothing late", async () => {
    await open();
    flow.addPhotos([file("a.jpg"), file("b.jpg")]);
    await settle();
    const photo = corners().photo as any;
    state.scanFlow.value = null;
    flow.flowClosed();
    expect(photo.image.closed).toBe(true);
    expect(fake.disposed).toBe(1);
    expect(flow.phase.value).toEqual({ step: "start" });
    expect(flow.tray.value).toEqual([]);

    // A photo still being read when the flow closes: closed when it comes, nothing shown.
    await open();
    const reading = deferred<unknown>();
    fake.analyse = () => reading.promise;
    flow.addPhotos([file("c.jpg")]);
    state.scanFlow.value = null;
    flow.flowClosed();
    const late = photoOf();
    reading.resolve(late);
    await settle();
    expect(late.image.closed).toBe(true);
    expect(flow.phase.value).toEqual({ step: "start" });

    // A page still being made: dropped, nothing kept.
    await open();
    fake.analyse = async () => photoOf();
    flow.addPhotos([file("d.jpg")]);
    await settle();
    const making = deferred<unknown>();
    fake.process = () => making.promise;
    const made = flow.makePage();
    state.scanFlow.value = null;
    flow.flowClosed();
    making.resolve(pageOf());
    await made;
    expect(flow.tray.value).toEqual([]);
    expect(fake.saves).toEqual([]);
  });

  it("Riprendi opens the flow on the kept tray, for its target; not over a flow already open", async () => {
    const { resumeScan } = await import("../src/ui/scan/ScanFlow");
    const kept = {
      target: { kind: "insert", at: 2 } as const,
      savedAt: 5,
      pages: [1, 2].map((n) => ({ bytes: new Uint8Array([n]).buffer, width: 100, height: 141, dpi: 200, preview: new ArrayBuffer(2) })),
    };
    resumeScan(kept);
    expect(state.scanFlow.value).toEqual({ kind: "insert", at: 2 });
    expect(flow.phase.value).toEqual({ step: "tray", finishing: false });
    expect(flow.tray.value.map((p) => p.picture.bytes)).toEqual(kept.pages.map((p) => p.bytes));
    expect(fake.saves).toEqual([]); // it is what the device has

    // Already open: nothing changes.
    const open = state.scanFlow.value;
    resumeScan({ ...kept, target: { kind: "new" } });
    expect(state.scanFlow.value).toBe(open);
    expect(flow.tray.value).toHaveLength(2);

    // A change of the resumed tray is kept with its target.
    flow.removePage(flow.tray.value[0].id);
    expect(fake.saves[0].target).toEqual({ kind: "insert", at: 2 });
    expect(fake.saves[0].pages).toHaveLength(1);
  });

  it("a scan with no pages is not resumed", async () => {
    const { resumeScan } = await import("../src/ui/scan/ScanFlow");
    resumeScan({ target: { kind: "new" }, savedAt: 1, pages: [] });
    expect(state.scanFlow.value).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Fix round 1

/** The window's listeners (shortcuts.ts, DropOverlay.tsx) installed on a fake window; restore() puts it back. */
function fakeWindow() {
  const g = globalThis as any;
  const saved = { add: g.addEventListener, remove: g.removeEventListener, element: g.HTMLElement };
  const listeners: Record<string, (e: unknown) => void> = {};
  g.addEventListener = (type: string, fn: (e: unknown) => void) => { listeners[type] = fn; };
  g.removeEventListener = () => undefined;
  g.HTMLElement ??= class {};
  const restore = () => {
    g.addEventListener = saved.add;
    g.removeEventListener = saved.remove;
    g.HTMLElement = saved.element;
  };
  return { listeners, restore };
}

/** A drag event carrying `files` (for the window's handlers, and the flow's own in ScanFlow.tsx). */
function dragEvent(files: File[]) {
  const e: any = {
    dataTransfer: { types: ["Files"], files, dropEffect: "" }, target: null, clientX: 5, clientY: 5,
    defaultPrevented: false, preventDefault() { e.defaultPrevented = true; },
  };
  return e;
}

describe("S5 fix round 1", () => {
  it("P23 a file picker dismissed without a photo leaves the flow and its tray as they were", async () => {
    const { onFlowCancel } = (await import("../src/ui/scan/ScanFlow")) as any;
    await withPages(["a.jpg"]);
    const dialogEl = { tag: "dialog" }, input = { tag: "input" };
    let prevented = 0;
    const cancel = (target: unknown) => ({ target, currentTarget: dialogEl, preventDefault() { prevented++; } });
    // The picker's "cancel" fires at its input and bubbles up to the dialog.
    onFlowCancel(cancel(input));
    await settle();
    expect(state.dialog.value).toBeNull();
    expect(state.scanFlow.value).toEqual({ kind: "new" });
    expect(flow.tray.value).toHaveLength(1);
    expect(fake.forgets).toBe(0);
    expect(fake.keptScan?.pages).toHaveLength(1);
    // With an empty tray it does not close the flow either.
    flow.removePage(flow.tray.value[0].id);
    onFlowCancel(cancel(input));
    await settle();
    expect(state.scanFlow.value).toEqual({ kind: "new" });
    expect(prevented).toBe(0);
    // The dialog's own cancel (Escape, the back gesture) still cancels.
    onFlowCancel(cancel(dialogEl));
    await settle();
    expect(prevented).toBe(1);
    expect(state.scanFlow.value).toBeNull();
  });

  it("P24 a new scan never forgets the unfinished one kept before: closed before choosing, it stays", async () => {
    keptBefore(3);
    await open({ kind: "new" }); // "Scansiona un documento" on the home page
    const closing = flow.cancelScan();
    await settle();
    expect(state.dialog.value).toBeNull();
    expect(await closing).toBe(true);
    expect(fake.forgets).toBe(0);
    expect(fake.keptScan?.pages).toHaveLength(3);
  });

  it("P24 it asks first; photos picked meanwhile wait; the first page never replaces the kept scan; Ricomincia forgets it only then", async () => {
    keptBefore(2);
    await open({ kind: "new" });
    flow.addPhotos([file("a.jpg")]);
    await settle();
    await flow.makePage(); // nothing to make while the question is open
    expect(fake.saves).toEqual([]);
    expect(fake.keptScan?.pages).toHaveLength(2);
    expect(fake.analysed).toEqual([]);
    expect(flow.phase.value).toEqual({ step: "kept", pages: 2, busy: false });

    await flow.startOver();
    expect(fake.forgets).toBe(1);
    expect(flow.said.value?.text).toBe(i18n.t("scan.keptStartedOver"));
    await settle();
    expect(fake.analysed.map((x) => x.name)).toEqual(["a.jpg"]); // the photo picked meanwhile
    await flow.makePage();
    expect(fake.saves.map((s) => s.pages.length)).toEqual([1]);
  });

  it("P24 a question still being asked of the device holds the photos too", async () => {
    keptBefore(1);
    const summary = deferred<unknown>();
    fake.summaryAnswer = () => summary.promise;
    await open({ kind: "new" });
    flow.addPhotos([file("a.jpg")]);
    await settle();
    expect(fake.analysed).toEqual([]);
    expect(flow.phase.value).toMatchObject({ step: "reading" });
    summary.resolve({ target: { kind: "new" }, savedAt: 1000, pages: 1 });
    await settle();
    expect(flow.phase.value).toEqual({ step: "kept", pages: 1, busy: false });
    expect(fake.analysed).toEqual([]);
  });

  it("P24 Continua: the kept pages come back in the tray, for where this scan was opened, and new ones join after them", async () => {
    state.doc.value = { id: 7, fileName: "x.pdf", pages: [{}, {}, {}] } as any;
    const kept = keptBefore(2, { kind: "new" });
    await open({ kind: "insert", at: 1 }); // the organizer's "+" > "Foto o scansione"
    expect(flow.phase.value).toEqual({ step: "kept", pages: 2, busy: false });
    await flow.continueKept();
    expect(flow.phase.value).toEqual({ step: "tray", finishing: false });
    expect(flow.tray.value.map((p) => p.picture.bytes)).toEqual(kept.pages.map((p: any) => p.bytes));
    expect(flow.said.value?.text).toBe(i18n.t("scan.keptContinued"));
    expect(fake.forgets).toBe(0);
    // Kept again for this opening's target.
    expect(fake.saves.map((s) => [s.target, s.pages.length])).toEqual([[{ kind: "insert", at: 1 }, 2]]);
    flow.addPhotos([file("c.jpg")]);
    await settle();
    await flow.makePage();
    expect(flow.tray.value).toHaveLength(3);
    expect(await flow.finishScan()).toBe(true);
    expect(fake.inserted[0].edit.pictures).toHaveLength(3);
    expect(fake.forgets).toBe(1);
  });

  it("P24 Continua when the kept scan cannot be read now: said, the question stays; when it has gone: an empty start", async () => {
    keptBefore(2);
    await open();
    fake.loadAnswer = "unreadable";
    await flow.continueKept();
    expect(flow.alerted.value?.text).toBe(i18n.t("scan.keptUnreadable"));
    expect(flow.phase.value).toEqual({ step: "kept", pages: 2, busy: false });
    expect(fake.forgets).toBe(0);
    fake.keptScan = null; // forgotten meanwhile (Dimentica in another tab)
    await flow.continueKept();
    expect(flow.alerted.value?.text).toBe(i18n.t("resume.scanGone"));
    expect(flow.phase.value).toEqual({ step: "start" });
    // Now the flow's own: a page is kept as usual.
    flow.addPhotos([file("a.jpg")]);
    await settle();
    await flow.makePage();
    expect(fake.saves).toHaveLength(1);
  });

  it("P24 a scan resumed with Riprendi asks nothing", async () => {
    const { resumeScan } = await import("../src/ui/scan/ScanFlow");
    resumeScan(keptBefore(2));
    (flow as any).flowOpened?.();
    await settle();
    expect(flow.phase.value).toEqual({ step: "tray", finishing: false });
    expect(flow.tray.value).toHaveLength(2);
  });

  it("P25 a resumed insert scan without its document: says why; leaving keeps the pages, with no question", async () => {
    const { resumeScan } = await import("../src/ui/scan/ScanFlow");
    resumeScan(keptBefore(2, { kind: "insert", at: 2 }, "x.pdf"));
    flow.flowOpened();
    await settle();
    expect(flow.waitsForDocument(state.scanFlow.value!)).toBe(true);
    expect(flow.targetNow(state.scanFlow.value!)).toEqual({ kind: "new" });
    const closing = flow.cancelScan();
    await settle();
    expect(state.dialog.value).toBeNull();
    expect(await closing).toBe(true);
    expect(state.scanFlow.value).toBeNull();
    expect(fake.forgets).toBe(0);
    expect(fake.keptScan?.pages).toHaveLength(2);
    await settle();
    expect(state.toasts.value.map((x) => x.text)).toContain(i18n.t("scan.keptForLater"));

    // "Più tardi" does the same.
    flow.flowClosed();
    resumeScan(fake.keptScan);
    flow.flowOpened();
    await settle();
    expect(await flow.keepForLater()).toBe(true);
    expect(state.scanFlow.value).toBeNull();
    expect(fake.keptScan?.pages).toHaveLength(2);
    // With its document open, nothing waits for it: Later is not offered.
    flow.flowClosed();
    state.doc.value = { id: 7, fileName: "x.pdf", pages: [{}, {}, {}] } as any;
    resumeScan(fake.keptScan);
    expect(flow.waitsForDocument(state.scanFlow.value!)).toBe(false);
    expect(await flow.keepForLater()).toBe(false);
    // Another document open (fix round 3): it still waits for its own.
    state.scanFlow.value = null;
    flow.flowClosed();
    state.doc.value = { id: 8, fileName: "y.pdf", pages: [{}, {}, {}] } as any;
    resumeScan(fake.keptScan);
    expect(flow.waitsForDocument(state.scanFlow.value!)).toBe(true);
  });

  it("P25 Fine there makes a new PDF, asking first when Riprendi keeps a document the new one would replace", async () => {
    const { resumeScan } = await import("../src/ui/scan/ScanFlow");
    fake.keptSession = { fileName: "X.pdf", savedAt: 1, editCount: 5, pageCount: 3 };
    resumeScan(keptBefore(1, { kind: "insert", at: 2 }));
    flow.flowOpened();
    await settle();
    let done = flow.finishScan();
    await settle();
    const d = state.dialog.value as any;
    expect(d?.kind).toBe("confirm");
    expect(d.body).toBe(i18n.t("scan.orphanNewBody", { name: "X.pdf" }));
    answer(false);
    expect(await done).toBe(false);
    expect(fake.newPdf).toEqual([]);
    expect(flow.phase.value).toEqual({ step: "tray", finishing: false });
    expect(fake.keptScan?.pages).toHaveLength(1);
    done = flow.finishScan();
    await settle();
    answer(true);
    expect(await done).toBe(true);
    expect(fake.newPdf).toHaveLength(1);
    expect(fake.forgets).toBe(1);
  });

  it("P29 Fine with the engine down says so inside the flow; the pages stay kept, Cancel too", async () => {
    await withPages(["a.jpg"]);
    state.engineStatus.value = "error";
    expect(await flow.finishScan()).toBe(false);
    expect(fake.newPdf).toEqual([]); // not even tried: it would leave the document first
    expect(flow.alerted.value?.text).toBe(i18n.t("scan.engineDown"));
    expect(flow.phase.value).toEqual({ step: "tray", finishing: false });
    expect(flow.tray.value).toHaveLength(1);

    // The engine stops during Fine.
    state.engineStatus.value = "ready";
    fake.newPdfEngine = "error";
    fake.newPdfAnswer = false;
    expect(await flow.finishScan()).toBe(false);
    expect(fake.newPdf).toHaveLength(1);
    expect(flow.alerted.value?.text).toBe(i18n.t("scan.engineDown"));

    // Leaving: the pages cannot be used now, so they stay for later, with no question.
    const closing = flow.cancelScan();
    await settle();
    expect(state.dialog.value).toBeNull();
    expect(await closing).toBe(true);
    expect(fake.forgets).toBe(0);
    expect(fake.keptScan?.pages).toHaveLength(1);
  });

  it("P29 an insert with the engine down says so too; pages the device could not keep are said lost", async () => {
    state.doc.value = { id: 7, fileName: "x.pdf", pages: [{}, {}] } as any;
    fake.refuseSaves = true;
    await withPages(["a.jpg"], { kind: "insert", at: 1 });
    await settle();
    state.engineStatus.value = "error";
    expect(await flow.finishScan()).toBe(false);
    expect(fake.inserted).toEqual([]);
    expect(flow.alerted.value?.text).toBe(i18n.t("scan.engineDownNotKept"));
    // Not kept on the device: leaving asks, as the pages would be lost.
    const asked = flow.cancelScan();
    await settle();
    expect((state.dialog.value as any)?.kind).toBe("confirm");
    answer(false);
    expect(await asked).toBe(false);
  });

  it("P30 closing while a photo is being read: the worker goes once that read has ended, unless a flow is open again", async () => {
    await open();
    const reading = deferred<unknown>();
    fake.analyse = () => reading.promise;
    flow.addPhotos([file("a.jpg")]);
    await settle();
    expect(fake.analysed).toHaveLength(1);
    state.scanFlow.value = null;
    flow.flowClosed();
    expect(fake.disposed).toBe(1);
    reading.resolve(photoOf()); // e.g. a decode on the main thread, which then starts a worker
    await settle();
    expect(fake.disposed).toBe(2);

    // A read that fails is waited for too.
    await open();
    const failing = deferred<unknown>();
    fake.analyse = () => failing.promise;
    flow.addPhotos([file("b.jpg")]);
    await settle();
    state.scanFlow.value = null;
    flow.flowClosed();
    expect(fake.disposed).toBe(3);
    failing.reject(new types.ScanError("x", "failed"));
    await settle();
    expect(fake.disposed).toBe(4);

    // A new flow is open by the time the answer comes: its worker stays (its own close ends it).
    await open();
    const late = deferred<unknown>();
    fake.analyse = () => late.promise;
    flow.addPhotos([file("c.jpg")]);
    await settle();
    state.scanFlow.value = null;
    flow.flowClosed();
    expect(fake.disposed).toBe(5);
    await open();
    late.resolve(photoOf());
    await settle();
    expect(fake.disposed).toBe(5);
  });

  it("P31 the HEIC words fit the device: the camera only where the flow has one", () => {
    const heic = { name: "IMG_1.HEIC", type: "image/heic" };
    const e = new types.ScanError("x", "unreadable");
    expect(flow.photoErrorText(e, heic, false, true)).toBe(i18n.t("scan.photoHeic"));
    expect(flow.photoErrorText(e, heic, false, false)).toBe(i18n.t("scan.photoHeicDesktop"));
    expect(i18n.t("scan.photoHeicDesktop")).not.toContain(i18n.t("scan.camera"));
    i18n.locale.value = "en";
    expect(flow.photoErrorText(e, heic, false, false)).not.toContain(i18n.t("scan.camera"));
    expect(flow.photoErrorText(e, heic, false, true)).toContain(i18n.t("scan.camera"));
  });

  it("P26 the window's shortcuts leave the document alone while the flow is open; Escape is the flow's", async () => {
    const { listeners, restore } = fakeWindow();
    const { installShortcuts } = await import("../src/ui/shortcuts");
    const uninstall = installShortcuts();
    const press = (key: string, mods: Record<string, unknown> = {}) => {
      const e: any = {
        key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, target: null,
        defaultPrevented: false, preventDefault() { e.defaultPrevented = true; }, ...mods,
      };
      listeners.keydown(e);
      return e;
    };
    const created = (globalThis as any).__created as unknown[];
    try {
      state.doc.value = { id: 7, fileName: "x.pdf", pages: [{}, {}] } as any;
      state.tool.value = "fill";
      await open({ kind: "insert", at: 1 });
      const before = created.length;
      const zoom = state.zoom.value;
      const keys: [string, Record<string, unknown>][] = [
        ["z", { ctrlKey: true }], ["z", { ctrlKey: true, shiftKey: true }], ["y", { ctrlKey: true }],
        ["s", { ctrlKey: true }], ["o", { ctrlKey: true }], ["0", { ctrlKey: true }], ["+", { ctrlKey: true }],
        ["-", { metaKey: true }], ["Escape", {}], ["Enter", {}],
      ];
      for (const [key, mods] of keys) expect(press(key, mods).defaultPrevented, `${key} ${JSON.stringify(mods)}`).toBe(false);
      await settle();
      expect(fake.acted).toEqual([]);
      expect(created.length).toBe(before); // no file picker
      expect(state.zoom.value).toBe(zoom);
      expect(state.scanFlow.value).not.toBeNull();

      // The flow closed: the same keys act on the document again.
      state.scanFlow.value = null;
      flow.flowClosed();
      expect(press("z", { ctrlKey: true }).defaultPrevented).toBe(true);
      expect(press("Escape").defaultPrevented).toBe(true);
      await settle();
      expect(fake.acted).toEqual(["undo", "setTool"]);
    } finally {
      uninstall();
      restore();
    }
  });

  it("P27 drops while the flow is open: no PDF opens beneath it and no overlay; pictures dropped on the flow join it", async () => {
    const { listeners, restore } = fakeWindow();
    try {
      const { DropOverlay } = await import("../src/ui/DropOverlay");
      hooks.sets.length = 0;
      DropOverlay(); // its effect installs the window's drop handling
      const pdf = file("other.pdf", "application/pdf");
      const drag = (type: string, files: File[]) => {
        const e = dragEvent(files);
        listeners[type](e);
        return e;
      };
      await open();
      drag("dragenter", [pdf]);
      const over = drag("dragover", [pdf]);
      expect(over.defaultPrevented).toBe(true); // the browser must not open the file itself
      expect(over.dataTransfer.dropEffect).toBe(""); // left to the flow's own dragover
      expect(drag("drop", [pdf]).defaultPrevented).toBe(true);
      expect(hooks.sets).not.toContain(true); // no overlay
      expect(fake.acted).toEqual([]); // nothing opened beneath
      expect(state.toasts.value).toEqual([]);

      // The flow's own drop handling: pictures join as photos; anything else is said inside it.
      const { onFlowDragOver, onFlowDrop } = (await import("../src/ui/scan/ScanFlow")) as any;
      const o = dragEvent([file("a.jpg")]);
      onFlowDragOver(o);
      expect([o.defaultPrevented, o.dataTransfer.dropEffect]).toEqual([true, "copy"]);
      const d = dragEvent([pdf]);
      onFlowDrop(d);
      expect(d.defaultPrevented).toBe(true);
      expect(flow.alerted.value?.text).toBe(i18n.t("scan.dropNotPicture"));
      onFlowDrop(dragEvent([file("a.jpg"), pdf, file("b.png", "image/png")]));
      await settle();
      expect(fake.analysed.map((x) => x.name)).toEqual(["a.jpg"]);
      expect(corners()).toMatchObject({ index: 1, total: 2 });
      expect(flow.isPictureFile({ name: "IMG_1.HEIC", type: "" })).toBe(true);
      expect(flow.isPictureFile({ name: "x.pdf", type: "application/pdf" })).toBe(false);

      // The flow closed: a PDF dropped opens again, with the overlay.
      state.scanFlow.value = null;
      flow.flowClosed();
      drag("dragenter", [pdf]);
      drag("drop", [pdf]);
      expect(fake.acted).toEqual(["openFile"]);
      expect(hooks.sets).toContain(true);
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Fix round 2

/** Function components left out by `expand` (their insides do not matter here). */
const LEAVES = new Set(["Tray", "CornerEditor"]);

/** `node` with its function components called, as a render would (LEAVES dropped). */
function expand(node: any): any {
  if (Array.isArray(node)) return node.map(expand);
  if (!node || typeof node !== "object" || !("props" in node)) return node;
  if (typeof node.type === "function") return LEAVES.has(node.type.name) ? null : expand(node.type(node.props));
  return { type: node.type, props: { ...node.props, children: expand(node.props.children) } };
}

/** Every element of an expanded tree, depth first. */
function elements(node: any): any[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !node.props) return [];
  return [node, ...elements(node.props.children)];
}

/** The plain text of an expanded tree. */
function textOf(node: any): string {
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (!node || typeof node !== "object" || !node.props) return "";
  return textOf(node.props.children);
}

/** What the flow shows now (ScanFlow called as a render would): its text, and its buttons' words. */
async function shown() {
  const { ScanFlow } = await import("../src/ui/scan/ScanFlow");
  const tree = expand(ScanFlow({ target: state.scanFlow.value! }));
  return { text: textOf(tree), buttons: elements(tree).filter((n) => n.type === "button").map(textOf) };
}

/** The real device store (platform/resume.ts) on a fake IndexedDB, used by the flow instead of the stand-in. */
async function realStore() {
  const idb = fakeIndexedDB();
  vi.stubGlobal("indexedDB", idb.factory);
  fake.real = await vi.importActual<typeof import("../src/platform/resume")>("../src/platform/resume.ts");
  return { idb, real: fake.real };
}

/** `count` pages as the device keeps them, with distinct bytes. */
function storedPages(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    bytes: new Uint8Array([200 + i, 1, 2]).buffer, width: 100, height: 141, dpi: 200, preview: new Uint8Array([7]).buffer,
  }));
}

const bytesOf = (pages: readonly { bytes: ArrayBuffer }[]) => pages.map((p) => [...new Uint8Array(p.bytes)]);

/** Open the flow with a resumed insert scan of `count` pages whose document is not open. */
async function resumedOrphan(count: number) {
  const { resumeScan } = await import("../src/ui/scan/ScanFlow");
  resumeScan(keptBefore(count, { kind: "insert", at: 2 }));
  flow.flowOpened();
  await settle();
  expect(flow.waitsForDocument(state.scanFlow.value!)).toBe(true);
}

describe("S6 fix round 2", () => {
  it("P25 a full store: no “Più tardi” and the hint says only a new PDF keeps the pages; a later save that works brings it back", async () => {
    const { idb, real } = await realStore();
    const { resumeScan } = await import("../src/ui/scan/ScanFlow");
    expect(await real.saveScan({ target: { kind: "insert", at: 2 }, savedAt: 0, pages: storedPages(2) })).toBe(true);
    resumeScan((await real.loadScan())!); // Riprendi on the home page, the PDF it was for not open
    flow.flowOpened();
    await settle();
    expect(flow.waitsForDocument(state.scanFlow.value!)).toBe(true);
    let view = await shown();
    expect(view.buttons).toContain(i18n.t("scan.later"));
    expect(view.text).toContain(i18n.t("scan.orphanHint"));

    // The store is full: the new page is not kept (the device still has the two before it).
    idb.quota = idb.usage("pdf-editor-resume");
    flow.addPhotos([file("c.jpg")]);
    await settle();
    await flow.makePage();
    await real.scanSummary(); // after the save
    expect(flow.tray.value).toHaveLength(3);
    expect(flow.notKept.value).toBe(true);
    expect((await real.scanSummary())?.pages).toBe(2);
    // "Più tardi" would leave that page behind (and did nothing at all before): not offered, and
    // the hint no longer tells the user to choose it.
    view = await shown();
    expect(view.buttons).not.toContain(i18n.t("scan.later"));
    expect(view.buttons).toContain(i18n.t("scan.finishNew"));
    expect(view.text).toContain(i18n.t("scan.orphanHintNotKept"));
    expect(view.text).not.toContain(i18n.t("scan.orphanHint"));
    expect(i18n.t("scan.orphanHintNotKept")).not.toContain(i18n.t("scan.later"));
    expect(await flow.keepForLater()).toBe(false);
    expect(state.scanFlow.value).not.toBeNull();
    // Leaving asks, as the pages would be lost; No keeps the flow.
    const asked = flow.cancelScan();
    await settle();
    expect((state.dialog.value as any)?.body).toBe("Le 3 pagine che hai scansionato andranno perse.");
    answer(false);
    expect(await asked).toBe(false);

    // Room again: the next change of the tray is kept, and "Più tardi" is back.
    idb.quota = Infinity;
    expect(flow.movePage(flow.tray.value[2].id, -1)).toBe(true);
    await real.scanSummary();
    expect(flow.notKept.value).toBe(false);
    view = await shown();
    expect(view.buttons).toContain(i18n.t("scan.later"));
    expect(view.text).toContain(i18n.t("scan.orphanHint"));
    const order = bytesOf(flow.tray.value.map((p) => p.picture));
    expect(await flow.keepForLater()).toBe(true);
    expect(state.scanFlow.value).toBeNull();
    const back = await real.loadScan();
    expect(back?.target).toEqual({ kind: "insert", at: 2 });
    expect(bytesOf(back!.pages)).toEqual(order);
  });

  it("P25 the device's answer follows the latest save: refused once, kept the next time", async () => {
    fake.refuseSaves = true;
    await withPages(["a.jpg", "b.jpg"]);
    await settle();
    expect(flow.notKept.value).toBe(true);
    fake.refuseSaves = false;
    expect(flow.movePage(flow.tray.value[0].id, 1)).toBe(true);
    await settle();
    expect(flow.notKept.value).toBe(false);
    expect(fake.keptScan?.pages).toHaveLength(2);
    // What Fine says with the engine down follows it too: the pages stay on the device.
    state.engineStatus.value = "error";
    expect(await flow.finishScan()).toBe(false);
    expect(flow.alerted.value?.text).toBe(i18n.t("scan.engineDown"));
  });

  it("P25 “Più tardi” while the tray's save is on its way waits for it: kept, the flow closes", async () => {
    await resumedOrphan(3);
    const hold = deferred<void>();
    fake.saveHold = hold.promise;
    flow.removePage(flow.tray.value[0].id); // its save waits
    const later = flow.keepForLater();
    expect((flow as any).leaving.value).toBe(true);
    expect(state.scanFlow.value).not.toBeNull();
    expect((await shown()).buttons).toContain(i18n.t("scan.later")); // still there, busy
    // Nothing else leaves or finishes meanwhile.
    expect(await flow.cancelScan()).toBe(false);
    expect(await flow.finishScan()).toBe(false);
    expect(state.dialog.value).toBeNull();
    hold.resolve();
    expect(await later).toBe(true);
    expect(state.scanFlow.value).toBeNull();
    expect(fake.keptScan?.pages).toHaveLength(2);
    expect(fake.forgets).toBe(0);
    await settle();
    expect(state.toasts.value.map((x) => x.text)).toContain(i18n.t("scan.keptForLater"));
  });

  it("P25 “Più tardi” while a save is on its way that is refused: the flow stays, says why, without “Più tardi”", async () => {
    await resumedOrphan(3);
    const hold = deferred<void>();
    fake.saveHold = hold.promise;
    flow.removePage(flow.tray.value[0].id);
    const later = flow.keepForLater();
    fake.refuseSaves = true;
    hold.resolve();
    expect(await later).toBe(false);
    expect((flow as any).leaving.value).toBe(false);
    expect(state.scanFlow.value).not.toBeNull();
    expect(flow.notKept.value).toBe(true);
    expect(flow.alerted.value?.text).toBe(i18n.t("scan.laterFailed"));
    const view = await shown();
    expect(view.buttons).not.toContain(i18n.t("scan.later"));
    expect(view.text).toContain(i18n.t("scan.orphanHintNotKept"));
    expect(fake.keptScan?.pages).toHaveLength(3); // the device still has the tray from before
    expect(fake.forgets).toBe(0);
    await settle();
    expect(state.toasts.value).toEqual([]);
  });

  it("P25 Cancel while a save is on its way that is refused: it waits, then asks, as the pages would be lost", async () => {
    await resumedOrphan(3);
    const hold = deferred<void>();
    fake.saveHold = hold.promise;
    flow.removePage(flow.tray.value[0].id);
    const cancelling = flow.cancelScan();
    await settle();
    expect(state.dialog.value).toBeNull(); // not before the device has answered
    expect(state.scanFlow.value).not.toBeNull();
    fake.refuseSaves = true;
    hold.resolve();
    await settle();
    expect((state.dialog.value as any)?.body).toBe("Le 2 pagine che hai scansionato andranno perse.");
    answer(false);
    expect(await cancelling).toBe(false);
    expect(state.scanFlow.value).not.toBeNull();
    expect(flow.tray.value).toHaveLength(2);
    expect(fake.forgets).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Fix round 3

let docIds = 100;
/** A real open document of `n` pages (viewer/model.ts), as an open makes it. */
async function openDoc(fileName: string, n: number) {
  const { createDoc } = await import("../src/viewer/model");
  const info = {
    pageCount: n, pages: pagesInfo(n), encrypted: false, needsPassword: false, canKeepPassword: false,
    pdfa: null, signatures: 0, form: null, title: null,
  };
  const d = createDoc(++docIds, fileName, info);
  state.doc.value = d;
  return d;
}

function pagesInfo(n: number) {
  return Array.from({ length: n }, (_, index) => ({ index, bounds: [0, 0, 595, 842] as [number, number, number, number] }));
}

describe("S7 fix round 3", () => {
  it("a scan kept for another document never goes into the open one: resumed, its pages wait for theirs, named", async () => {
    await openDoc("A.pdf", 2);
    const { resumeScan } = await import("../src/ui/scan/ScanFlow");
    resumeScan(keptBefore(2, { kind: "insert", at: 3 }, "B.pdf"));
    flow.flowOpened();
    await settle();
    const target = state.scanFlow.value!;
    expect(flow.documentFor(target)).toBe("B.pdf");
    expect(flow.waitsForDocument(target)).toBe(true);
    expect(flow.targetNow(target)).toEqual({ kind: "new" });
    expect(flow.orphanOffer(target)).toBe("later");
    const view = await shown();
    expect(view.text).toContain("Queste pagine sono per “B.pdf”, che non è aperto.");
    expect(view.buttons).toContain(i18n.t("scan.later"));
    expect(view.buttons).toContain(i18n.t("scan.finishNew"));
    // A change of the tray is kept for B, at B's place.
    flow.removePage(flow.tray.value[0].id);
    expect(fake.saves.at(-1)).toMatchObject({ target: { kind: "insert", at: 3 }, doc: { fileName: "B.pdf" } });
    // Fine makes a new PDF of them; nothing goes into A.
    expect(await flow.finishScan()).toBe(true);
    expect(fake.inserted).toEqual([]);
    expect(fake.newPdf).toHaveLength(1);

    // A scan kept by an earlier build (its document not known) is not put into A either.
    flow.flowClosed();
    resumeScan(keptBefore(1, { kind: "insert", at: 1 }));
    expect(flow.waitsForDocument(state.scanFlow.value!)).toBe(true);
    expect((await shown()).text).toContain(i18n.t("scan.orphanHint"));

    // Kept for A: it goes into A, and the flow says where, naming it.
    state.scanFlow.value = null;
    flow.flowClosed();
    resumeScan(keptBefore(1, { kind: "insert", at: 3 }, "A.pdf"));
    expect(flow.waitsForDocument(state.scanFlow.value!)).toBe(false);
    expect(flow.targetNow(state.scanFlow.value!)).toEqual({ kind: "insert", at: 2 });
    expect((await shown()).text).toContain("Vanno alla fine di “A.pdf”.");
    expect(await flow.finishScan()).toBe(true);
    expect(fake.inserted.at(-1)!.edit).toMatchObject({ kind: "pictures", at: 2 });
  });

  it("Continua on a scan kept for another document: the question names it, and its pages stay that document's", async () => {
    await openDoc("A.pdf", 3);
    keptBefore(2, { kind: "insert", at: 1 }, "B.pdf");
    await open({ kind: "insert", at: 2 }); // A's "+" > "Foto o scansione"
    expect(flow.phase.value).toEqual({ step: "kept", pages: 2, for: "B.pdf", busy: false });
    expect((await shown()).text).toContain(i18n.t("scan.keptBodyFor", { count: 2, name: "B.pdf" }));
    await flow.continueKept();
    const target = state.scanFlow.value!;
    expect(flow.documentFor(target)).toBe("B.pdf");
    expect(flow.waitsForDocument(target)).toBe(true);
    expect(fake.saves).toEqual([]); // kept as it was: B's
    flow.addPhotos([file("c.jpg")]);
    await settle();
    await flow.makePage();
    expect(fake.saves.at(-1)).toMatchObject({ target: { kind: "insert", at: 1 }, doc: { fileName: "B.pdf" } });
    expect(await flow.keepForLater()).toBe(true);
    expect(fake.inserted).toEqual([]);
    expect(fake.keptScan).toMatchObject({ target: { kind: "insert", at: 1 }, doc: { fileName: "B.pdf" } });

    // B opened again (the same file from the device: the same name): Continua puts them where this opening says.
    flow.flowClosed();
    await openDoc("B.pdf", 4);
    await open({ kind: "insert", at: 4 });
    expect(flow.phase.value).toMatchObject({ step: "kept", pages: 3, for: "B.pdf" });
    await flow.continueKept();
    expect(flow.waitsForDocument(state.scanFlow.value!)).toBe(false);
    expect(flow.targetNow(state.scanFlow.value!)).toEqual({ kind: "insert", at: 4 });
    expect(fake.saves.at(-1)).toMatchObject({ target: { kind: "insert", at: 4 }, doc: { fileName: "B.pdf" } });
    expect(await flow.finishScan()).toBe(true);
    expect(fake.inserted.at(-1)!.edit).toMatchObject({ kind: "pictures", at: 4 });
    expect(fake.inserted.at(-1)!.edit.pictures).toHaveLength(3);

    // From the home page ("Scansiona un documento", nothing open), B's pages wait for B too.
    state.scanFlow.value = null;
    flow.flowClosed();
    state.doc.value = null;
    keptBefore(1, { kind: "insert", at: 1 }, "B.pdf");
    await open({ kind: "new" });
    await flow.continueKept();
    expect(flow.waitsForDocument(state.scanFlow.value!)).toBe(true);
    expect(flow.orphanOffer(state.scanFlow.value!)).toBe("later");
  });

  it("the place follows page operations that land while the flow is open; the device keeps it as an index", async () => {
    const { applyLayout } = await import("../src/viewer/model");
    const d = await openDoc("six.pdf", 6);
    const keys = d.pages.map((p) => p.key);
    state.scanFlow.value = { kind: "insert", at: 4 }; // the "+" between pages 4 and 5
    // A delete asked before it (waiting in the engine's queue) lands now: pages 1 and 2 go.
    applyLayout(d, { pages: pagesInfo(4), from: [2, 3, 4, 5], form: null, signatures: 0 });
    flow.flowOpened();
    await settle();
    expect(flow.targetNow(state.scanFlow.value!)).toEqual({ kind: "insert", at: 2 }); // still before old page 5
    flow.addPhotos([file("a.jpg")]);
    await settle();
    await flow.makePage();
    expect(fake.saves.at(-1)).toMatchObject({ target: { kind: "insert", at: 2 }, doc: { fileName: "six.pdf" } });
    expect((await shown()).text).toContain("Vanno in “six.pdf”, dopo la pagina 2.");
    // A blank page at the start lands too: the device keeps the new index at once (a tab killed
    // now finds the place as the document is kept), and nothing is written when the place stays.
    const saved = fake.saves.length;
    applyLayout(d, { pages: pagesInfo(5), from: [null, 0, 1, 2, 3], form: null, signatures: 0 });
    expect(flow.targetNow(state.scanFlow.value!)).toEqual({ kind: "insert", at: 3 });
    expect(fake.saves).toHaveLength(saved + 1);
    expect(fake.saves.at(-1)).toMatchObject({ target: { kind: "insert", at: 3 }, doc: { fileName: "six.pdf" } });
    expect(fake.saves.at(-1)!.pages).toHaveLength(1);
    applyLayout(d, { pages: pagesInfo(6), from: [0, 1, 2, 3, 4, null], form: null, signatures: 0 }); // after it
    expect(fake.saves).toHaveLength(saved + 1);
    expect(await flow.finishScan()).toBe(true);
    expect(fake.inserted[0].edit.at).toBe(3);
    expect(fake.inserted[0].show).toBe(3);
    expect(d.pages[3].key).toBe(keys[4]); // they go before the same page
    expect(d.pages[2].key).toBe(keys[3]); // and after the same one

    // The page it goes before deleted: where it was (as the organizer's other places do).
    state.scanFlow.value = null;
    flow.flowClosed();
    const e = await openDoc("five.pdf", 5);
    state.scanFlow.value = { kind: "insert", at: 2 };
    applyLayout(e, { pages: pagesInfo(4), from: [0, 1, 3, 4], form: null, signatures: 0 });
    expect(flow.targetNow(state.scanFlow.value!)).toEqual({ kind: "insert", at: 2 });
  });

  it("Done lets the kept scan go only once the autosave has answered for the document; a new opening meanwhile does not offer it back", async () => {
    await openDoc("A.pdf", 2);
    let held = deferred<boolean>();
    fake.keepDocument = () => held.promise;
    await withPages(["a.jpg"], { kind: "insert", at: 1 });
    const done = flow.finishScan();
    await settle();
    expect(state.scanFlow.value).toBeNull(); // the flow closed at once
    expect(fake.inserted).toHaveLength(1);
    expect(fake.keepAsked).toBe(1);
    expect(fake.forgets).toBe(0); // the device still has the pages
    expect(fake.keptScan?.pages).toHaveLength(1);

    // "+" > "Foto o scansione" again at once: the pages just used are not "an unfinished scan".
    flow.flowClosed();
    await open({ kind: "insert", at: 0 });
    expect(flow.phase.value).toEqual({ step: "start" });
    held.resolve(true);
    expect(await done).toBe(true);
    await settle();
    expect(fake.forgets).toBe(1);
    expect(fake.keptScan).toBeNull();
    expect(flow.phase.value).toEqual({ step: "start" }); // never the "kept" question
    flow.addPhotos([file("b.jpg")]);
    await settle();
    await flow.makePage();
    expect(fake.keptScan?.pages).toHaveLength(1); // this opening's own

    // Nothing will be kept of the document (the autosave says so): let go all the same; a new PDF too.
    state.scanFlow.value = null;
    flow.flowClosed();
    fake.keptScan = null; // that opening's page, left aside (it would be asked about)
    fake.keepDocument = async () => false;
    await withPages(["c.jpg"], { kind: "insert", at: 1 });
    expect(await flow.finishScan()).toBe(true);
    expect(fake.forgets).toBe(2);
    state.scanFlow.value = null;
    flow.flowClosed();
    held = deferred<boolean>();
    fake.keepDocument = () => held.promise;
    await withPages(["d.jpg"]);
    const made = flow.finishScan();
    await settle();
    expect(fake.newPdf).toHaveLength(1);
    expect(fake.forgets).toBe(2);
    held.resolve(true);
    expect(await made).toBe(true);
    expect(fake.forgets).toBe(3);
  });

  it("Done keeps the scan when the document's save was tried and failed (the engine stopped, the store refused)", async () => {
    await openDoc("A.pdf", 2);
    fake.keepDocument = async () => "failed";
    await withPages(["a.jpg"], { kind: "insert", at: 1 });
    expect(await flow.finishScan()).toBe(true);
    await settle();
    expect(fake.inserted).toHaveLength(1);
    expect(fake.keepAsked).toBe(1);
    expect(fake.forgets).toBe(0); // the pages may be on no record of the document: the scan stays
    expect(fake.keptScan?.pages).toHaveLength(1);
  });
});
