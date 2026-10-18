// Page operations in the UI (release 4), against the app's real state and actions with a fake
// engine that keeps a page list and answers with layouts as the real one does (`from` by page
// identity; a page an undo brings back has none): what each operation does to the page model
// (indices, PageModels and their keys kept, revisions, the document's info), edit marks following
// their pages, a delete that leaves the document not downloaded with an "Undo" in its toast, undo
// and redo bringing back the very PageModels, the current page after each operation, what is open
// on the pages closed (and what is typed written) before an operation, operations queued behind
// another following their pages, a tick asked for before a move landing on its page, "Estrai"
// through the download path, the other PDF's size limit, adoptOpened with a history (Riprendi),
// and a new PDF from pictures asking first when there are edits not downloaded.
// Fix round 1: the delete's "Annulla" never undoes an edit written after it (P10); no writer,
// line editor or image selection opens while a page step is on its way (P11); a document made
// from scans, or resumed, stays not downloaded once its edits are undone (P13); Riprendi's open
// is sequenced with the others, the one asked for last landing (P14).
// Fix round 2 (P11): undos and redos on their way are gone through on the history mirror, so a
// second undo (or redo) that reaches a page operation keeps writers and selections closed too; a
// writer open anyway when such a step runs is written after it, never dropped without a word.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "./stubs/browser-globals";

vi.mock("../src/engine/client.ts", () => {
  class EngineError extends Error {
    constructor(message: string, readonly code?: string) {
      super(message);
    }
  }
  const e = () => (globalThis as any).__pagesEngine;
  class EngineClient {
    ready = Promise.resolve();
    open(bytes: ArrayBuffer, password?: string) { return e().open(bytes, password); }
    render() { return Promise.reject(new Error("no bitmaps in Node")); }
    lines() { return Promise.resolve([]); }
    images() { return Promise.resolve([]); }
    fields() { return Promise.resolve([]); }
    addedTexts() { return Promise.resolve([]); }
    lineDecorations() { return Promise.resolve({ underlines: 0, strikes: 0, links: 0, box: null, left: [] }); }
    renderImage() { return Promise.reject(new Error("no bitmaps in Node")); }
    addText(p: number, origin: number[], text: string, style: unknown) { return e().addText(p, origin, text, style); }
    addImage(bytes: ArrayBuffer, targets: unknown[], alt: string | null) { return e().addImage(bytes, targets, alt); }
    undo() { return e().undo(); }
    redo() { return e().redo(); }
    save(options: unknown) { return e().save(options); }
    close() { return e().close(); }
    editPages(edit: unknown) { return e().editPages(edit); }
    extractPages(pages: number[], options: unknown) { return e().extractPages(pages, options); }
    newFromPictures(pictures: unknown[]) { return e().newFromPictures(pictures); }
    openSource(bytes: ArrayBuffer, password?: string) { return e().openSource(bytes, password); }
    renderSource(source: number, pageIndex: number, scale: number) { return e().renderSource(source, pageIndex, scale); }
    closeSource(source: number) { return e().closeSource(source); }
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
    preparePicture: () => Promise.reject(new PictureError("no pictures here", "unreadable")),
  };
});

// ---------------------------------------------------------------------------------------------
// The fake engine: a page list (each page an identity and its bounds) and a history of page lists.

type Rect = [number, number, number, number];
interface FakePage {
  id: number;
  bounds: Rect;
}

const PORTRAIT: Rect = [0, 0, 100, 200];
const calls: string[] = [];
let pages: FakePage[] = [];
let past: FakePage[][] = [];
let future: FakePage[][] = [];
let nextPageId = 1;
/** Pages the next open gives, and DocInfo fields on top of a plain PDF. */
let openCount = 4;
let nextInfo: Record<string, unknown> = {};
/** What the next page operations report, and the form and signatures the layouts carry. */
let report = { linksRemoved: 0, fieldsRenamed: 0, signaturesAdded: 0 };
let form: any = null;
let signatures = 0;
const extractOptions: unknown[] = [];

const fresh = (bounds: Rect = PORTRAIT): FakePage => ({ id: nextPageId++, bounds });
const infoPages = (list: FakePage[]) => list.map((p, index) => ({ index, bounds: p.bounds }));
const sameList = (a: FakePage[], b: FakePage[]) =>
  a.length === b.length && a.every((p, i) => p.id === b[i].id && p.bounds.join() === b[i].bounds.join());

function layoutOf(before: FakePage[], after: FakePage[]) {
  return {
    pages: infoPages(after),
    from: after.map((p) => {
      const i = before.findIndex((b) => b.id === p.id);
      return i < 0 ? null : i;
    }),
    form,
    signatures,
  };
}

function historyNow(changedPages: number[], layout?: unknown) {
  return {
    editCount: past.length, canUndo: past.length > 0, canRedo: future.length > 0, changedPages,
    ...(layout ? { layout } : {}),
  };
}

function describeEdit(edit: any): string {
  switch (edit.kind) {
    case "move": return `move:${edit.order.join(",")}`;
    case "delete": return `delete:${edit.pages.join(",")}`;
    case "rotate": return `rotate:${edit.pages.join(",")}:${edit.by}`;
    case "blank": return `blank@${edit.at}`;
    case "duplicate": return `duplicate:${edit.pages.join(",")}@${edit.at}`;
    case "insert": return `insert:${edit.pages === "all" ? "all" : edit.pages.join(",")}@${edit.at}`;
    case "pictures": return `pictures:${edit.pictures.length}@${edit.at}`;
    default: return "?";
  }
}

const engineImpl: any = {
  open: async () => {
    calls.push("open");
    pages = Array.from({ length: openCount }, () => fresh());
    past = [];
    future = [];
    return {
      ok: true, pageCount: pages.length, pages: infoPages(pages), encrypted: false, needsPassword: false,
      canKeepPassword: false, pdfa: null, signatures: 0, form: null, title: null, ...nextInfo,
    };
  },
  editPages: async (edit: any) => {
    calls.push(`editPages:${describeEdit(edit)}`);
    let next: FakePage[];
    let changed: number[] = [];
    const added = (n: number, at: number) => {
      const made = Array.from({ length: n }, () => fresh());
      changed = made.map((_, k) => at + k);
      return [...pages.slice(0, at), ...made, ...pages.slice(at)];
    };
    switch (edit.kind) {
      case "move": next = edit.order.map((i: number) => pages[i]); break;
      case "delete": next = pages.filter((_, i) => !edit.pages.includes(i)); break;
      case "rotate":
        next = pages.map((p, i) => (edit.pages.includes(i) ? { id: p.id, bounds: [0, 0, p.bounds[3], p.bounds[2]] as Rect } : p));
        changed = [...edit.pages];
        break;
      case "blank": next = added(1, edit.at); break;
      case "duplicate": next = added(edit.pages.length, edit.at); break;
      case "insert": next = added(edit.pages === "all" ? 2 : edit.pages.length, edit.at); break;
      case "pictures": next = added(edit.pictures.length, edit.at); break;
      default: throw new Error("bad edit");
    }
    const before = pages;
    past.push(before);
    future = [];
    pages = next;
    return { ...historyNow(changed, layoutOf(before, next)), report: { ...report } };
  },
  undo: async () => {
    calls.push("undo");
    const prev = past.pop()!;
    const before = pages;
    future.push(before);
    pages = prev;
    return historyNow([], sameList(before, prev) ? undefined : layoutOf(before, prev));
  },
  redo: async () => {
    calls.push("redo");
    const next = future.pop()!;
    const before = pages;
    past.push(before);
    pages = next;
    return historyNow([], sameList(before, next) ? undefined : layoutOf(before, next));
  },
  addText: async (p: number, _origin: number[], text: string) => {
    calls.push(`addText:${p}:${text}`);
    past.push(pages);
    future = [];
    return { ...historyNow([p]), pageIndex: p, id: 7, missingChars: [] };
  },
  addImage: async (_bytes: ArrayBuffer, targets: { pageIndex: number }[]) => {
    calls.push(`addImage:${targets.map((x) => x.pageIndex).join(",")}`);
    past.push(pages);
    future = [];
    return { ...historyNow(targets.map((x) => x.pageIndex)), placed: targets.map((x) => ({ pageIndex: x.pageIndex, imageIndex: 0 })) };
  },
  save: async () => {
    calls.push("save");
    return { bytes: new ArrayBuffer(4), pdfa: null };
  },
  close: async () => {
    calls.push("close");
    return null;
  },
  extractPages: async (chosen: number[], options: unknown) => {
    calls.push(`extractPages:${chosen.join(",")}`);
    extractOptions.push(options);
    return { bytes: new ArrayBuffer(8), pdfa: null };
  },
  newFromPictures: async (pictures: unknown[]) => {
    calls.push(`newFromPictures:${pictures.length}`);
    pages = pictures.map(() => fresh([0, 0, 595, 842]));
    past = [];
    future = [];
    return {
      ok: true, pageCount: pages.length, pages: infoPages(pages), encrypted: false, needsPassword: false,
      canKeepPassword: false, pdfa: null, signatures: 0, form: null, title: null,
    };
  },
  openSource: async () => {
    calls.push("openSource");
    return { ok: true, source: 1, pageCount: 2, pages: infoPages([fresh(), fresh()]), title: "Other" };
  },
  renderSource: async () => ({ bitmap: { close() {} }, width: 1, height: 1, scale: 1 }),
  closeSource: async (source: number) => {
    calls.push(`closeSource:${source}`);
    return null;
  },
};
(globalThis as any).__pagesEngine = engineImpl;

/** Hold the next call of `op` until the returned function is called. */
function hold(op: string): Promise<() => void> {
  const original = engineImpl[op];
  return new Promise((held) => {
    engineImpl[op] = (...args: unknown[]) => new Promise((done) => {
      engineImpl[op] = original;
      held(() => done(original(...args)));
    });
  });
}

function fakeFile(name: string, size?: number): File {
  return {
    name,
    type: "application/pdf",
    ...(size === undefined ? {} : { size }),
    arrayBuffer: async () => new TextEncoder().encode(name).buffer,
  } as unknown as File;
}

let state: typeof import("../src/state");
let actions: typeof import("../src/ui/actions");
let ops: typeof import("../src/ui/pageActions");
let model: typeof import("../src/viewer/model");
let fields: typeof import("../src/viewer/fields");

beforeAll(async () => {
  state = await import("../src/state");
  actions = await import("../src/ui/actions");
  ops = await import("../src/ui/pageActions");
  model = await import("../src/viewer/model");
  fields = await import("../src/viewer/fields");
});

/** Open a fresh document of `count` pages; returns its OpenDoc. */
async function openPages(count = 4, info: Record<string, unknown> = {}) {
  openCount = count;
  nextInfo = info;
  report = { linksRemoved: 0, fieldsRenamed: 0, signaturesAdded: 0 };
  form = null;
  signatures = 0;
  await actions.openFile(fakeFile("Report.pdf"), { confirmed: true });
  nextInfo = {};
  calls.length = 0;
  state.toasts.value = [];
  return state.doc.value!;
}

const keysOf = (d: any) => d.pages.map((p: any) => p.key);
const indicesOf = (d: any) => d.pages.map((p: any) => p.index);
const revsOf = (d: any) => d.pages.map((p: any) => p.rev.peek());
const toastTexts = () => state.toasts.value.map((x) => x.text);

/** Make an ordinary edit of page `p` (a text written), as the engine and the mirror both record it. */
async function editPage(p: number) {
  await state.flushEditor();
  const result = await engineImpl.addText(p, [10, 10], "x");
  state.recordHistory(result, "edit");
}

async function answerConfirm(ok: boolean) {
  await vi.waitFor(() => expect(state.dialog.value?.kind).toBe("confirm"));
  const d = state.dialog.value as any;
  state.dialog.value = null;
  d.resolve(ok);
}

beforeEach(() => {
  state.toasts.value = [];
});

// ---------------------------------------------------------------------------------------------

describe("applyLayout", () => {
  it("rebuilds the pages in place on the same document, reusing PageModels through `from`", async () => {
    const d = await openPages(3);
    const [a, b, c] = d.pages;
    const array = d.pages;
    const before = d.layout.peek();
    b.lines.value = { rev: b.rev.peek(), lines: [] };
    a.lines.value = { rev: a.rev.peek(), lines: [] };
    const revs = revsOf(d);
    model.applyLayout(d, {
      pages: [{ index: 0, bounds: [0, 0, 100, 200] }, { index: 1, bounds: [0, 0, 100, 200] }, { index: 2, bounds: [0, 0, 50, 50] }, { index: 3, bounds: [0, 0, 100, 200] }],
      from: [0, 2, null, 1],
      form: { fieldsPerPage: [0, 0, 0, 1], fields: 1, required: 0, xfa: "none", scripts: false },
      signatures: 2,
    } as any);
    expect(state.doc.value).toBe(d);
    expect(d.pages).toBe(array);
    expect(d.pages.slice(0, 2)).toEqual([a, c]);
    expect(d.pages[3]).toBe(b);
    expect(indicesOf(d)).toEqual([0, 1, 2, 3]);
    const made = d.pages[2];
    expect(made.key).toBeGreaterThan(Math.max(a.key, b.key, c.key)); // a new key, never one used before
    expect(made.width).toBe(50);
    // a stayed where it was: same revision, its lines kept; b and c moved: new revisions, lines dropped.
    expect(a.rev.peek()).toBe(revs[0]);
    expect(a.lines.value).not.toBeNull();
    expect(b.rev.peek()).toBe(revs[1] + 1);
    expect(b.lines.value).toBeNull();
    expect(c.rev.peek()).toBe(revs[2] + 1);
    expect(d.info.pageCount).toBe(4);
    expect(d.info.pages.map((p) => p.bounds[2])).toEqual([100, 100, 50, 100]);
    expect(d.info.form?.fieldsPerPage).toEqual([0, 0, 0, 1]);
    expect(d.info.signatures).toBe(2);
    expect(d.info.title).toBeNull(); // the rest as at open
    expect(d.layout.peek()).toBe(before + 1);
  });

  it("takes the models given for an undo only when they agree with `from`", async () => {
    const d = await openPages(2);
    const [a, b] = d.pages;
    const stranger = model.createPages({ pages: [{ index: 0, bounds: PORTRAIT }] } as any)[0];
    const layout = { pages: infoPages([fresh(), fresh(), fresh()]), from: [0, null, 1], form: null, signatures: 0 } as any;
    model.applyLayout(d, layout, [b, stranger, a]); // b where a was: contradicts `from`
    expect(d.pages[0]).toBe(a);
    expect(d.pages[1]).not.toBe(stranger);
    expect(d.pages[2]).toBe(b);
  });

  it("reading the pages or the info in a computed follows page operations", async () => {
    const { computed } = await import("@preact/signals");
    const d = await openPages(2);
    const count = computed(() => d.pages.length);
    expect(count.value).toBe(2);
    model.applyLayout(d, { pages: infoPages([fresh()]), from: [0], form: null, signatures: 0 } as any);
    expect(count.value).toBe(1);
  });
});

describe("each operation's page model", () => {
  it("a move keeps every PageModel and its key; only the pages that moved get a new revision", async () => {
    const d = await openPages(4);
    const keys = keysOf(d);
    const revs = revsOf(d);
    d.pages[0].lines.value = { rev: revs[0], lines: [] };
    await ops.movePagesTo([2], 4); // page 3 to the end
    expect(calls).toEqual(["editPages:move:0,1,3,2"]);
    expect(keysOf(d)).toEqual([keys[0], keys[1], keys[3], keys[2]]);
    expect(indicesOf(d)).toEqual([0, 1, 2, 3]);
    expect(revsOf(d)).toEqual([revs[0], revs[1], revs[3] + 1, revs[2] + 1]);
    expect(d.pages[0].lines.value).not.toBeNull();
    expect(state.history.value.editCount).toBe(1);
    expect(state.dirty.value).toBe(true);
    expect(state.currentPage.value).toBe(3); // the page moved
  });

  it("a move of several pages keeps their order and puts them before the page asked for", async () => {
    const d = await openPages(5);
    const keys = keysOf(d);
    await ops.movePagesTo([3, 1], 0);
    expect(calls).toEqual(["editPages:move:1,3,0,2,4"]);
    expect(keysOf(d)).toEqual([keys[1], keys[3], keys[0], keys[2], keys[4]]);
    expect(state.currentPage.value).toBe(0);
    calls.length = 0;
    await ops.movePagesTo([0, 1], 1); // there already: nothing is sent
    expect(calls).toEqual([]);
  });

  it("moveOrder, pageRanges and extractName", () => {
    expect(ops.moveOrder(5, [1, 3], 0)).toEqual([1, 3, 0, 2, 4]);
    expect(ops.moveOrder(5, [0], 5)).toEqual([1, 2, 3, 4, 0]);
    expect(ops.moveOrder(5, [2, 3], 3)).toEqual([0, 1, 2, 3, 4]);
    expect(ops.moveOrder(4, [3, 9, 3], 1)).toEqual([0, 3, 1, 2]);
    expect(ops.pageRanges([0, 1, 2, 4, 6, 7])).toEqual("1-3, 5, 7-8");
    expect(ops.extractName("Report.pdf", [3, 1, 2])).toBe("Report - pages 2-4.pdf");
    expect(ops.extractName("Report.PDF", [2])).toBe("Report - page 3.pdf");
  });

  it("a delete drops the pages, shifts the others down with new revisions, and keeps the document not downloaded", async () => {
    const d = await openPages(4);
    const [a, b, c, e] = d.pages;
    const revs = revsOf(d);
    await ops.deletePagesAction([1, 2]);
    expect(calls).toEqual(["editPages:delete:1,2"]);
    expect(d.pages).toEqual([a, e]);
    expect(e.index).toBe(1);
    expect(a.rev.peek()).toBe(revs[0]);
    expect(e.rev.peek()).toBe(revs[3] + 1);
    expect(b.rev.peek()).toBe(revs[1] + 1); // gone: anything still on its way for it is stale
    expect(c.rev.peek()).toBe(revs[2] + 1);
    expect(d.info.pageCount).toBe(2);
    expect(state.dirty.value).toBe(true);
    expect(state.editedPages.value.size).toBe(0);
    expect(state.currentPage.value).toBe(1);
    const toast = state.toasts.value.find((x) => x.text === "2 pages deleted.");
    expect(toast?.action?.label).toBe("Undo");
  });

  it("never every page", async () => {
    await openPages(2);
    await ops.deletePagesAction([0, 1]);
    expect(calls).toEqual([]);
    expect(toastTexts()).toEqual(["At least one page must stay."]);
    await openPages(1);
    await ops.deletePagesAction([0]);
    expect(calls).toEqual([]);
  });

  it("a turn changes the page's bounds and size, gives it a new revision and drops what was read of it", async () => {
    const d = await openPages(3);
    const page = d.pages[1];
    const rev = page.rev.peek();
    page.images.value = { rev, images: [] };
    const other = d.pages[0].rev.peek();
    await ops.rotatePagesAction([1], 90);
    expect(calls).toEqual(["editPages:rotate:1:90"]);
    expect(d.pages[1]).toBe(page);
    expect(page.bounds).toEqual([0, 0, 200, 100]);
    expect([page.width, page.height]).toEqual([200, 100]);
    expect(page.rev.peek()).toBeGreaterThan(rev);
    expect(page.images.value).toBeNull();
    expect(d.pages[0].rev.peek()).toBe(other);
    expect(d.info.pages[1].bounds).toEqual([0, 0, 200, 100]);
    expect(state.currentPage.value).toBe(1);
    expect(state.editedPages.value).toEqual(new Set([1]));
  });

  it("a blank page, copies, pages of another PDF and pictures come in as new PageModels where asked", async () => {
    const d = await openPages(2);
    const [a, b] = d.pages;
    await ops.insertBlankPage(1);
    expect(d.pages.map((p) => p === a || p === b)).toEqual([true, false, true]);
    expect(state.currentPage.value).toBe(1);
    expect(toastTexts()).toContain("Blank page added.");

    await ops.duplicatePagesAction([0, 2]);
    expect(calls.at(-1)).toBe("editPages:duplicate:0,2@3");
    expect(d.pages.length).toBe(5);
    expect(state.currentPage.value).toBe(3);
    expect(toastTexts()).toContain("2 pages duplicated.");

    report = { linksRemoved: 2, fieldsRenamed: 1, signaturesAdded: 1 };
    signatures = 1;
    form = { fieldsPerPage: [0, 0, 1, 1, 0, 0, 0], fields: 2, required: 0, xfa: "none", scripts: false };
    state.toasts.value = [];
    await ops.insertFromSource(1, "all", 0, "Other");
    expect(calls.at(-1)).toBe("editPages:insert:all@0");
    expect(d.pages.length).toBe(7);
    expect(d.pages[2]).toBe(a);
    expect(d.info.signatures).toBe(1);
    expect(d.info.form?.fields).toBe(2);
    expect(state.currentPage.value).toBe(0);
    expect(toastTexts()).toEqual([
      "2 pages added.", "2 links removed.", "Fields renamed to keep them separate.",
      "The added PDF's digital signatures are no longer valid.",
    ]);

    report = { linksRemoved: 0, fieldsRenamed: 0, signaturesAdded: 0 };
    state.toasts.value = [];
    const picture = { bytes: new ArrayBuffer(3), width: 1654, height: 2339, dpi: 200 };
    await ops.insertPictures(7, [picture]);
    expect(calls.at(-1)).toBe("editPages:pictures:1@7");
    expect(d.pages.length).toBe(8);
    expect(state.currentPage.value).toBe(7);
    expect(toastTexts()).toEqual(["1 page added."]);
    expect(new Set(keysOf(d)).size).toBe(8);
  });

  it("runPagesEdit: refuses an edit that does not fit the document, and shows the page asked for", async () => {
    const d = await openPages(3);
    expect(await ops.runPagesEdit({ kind: "move", order: [0, 0, 1] })).toBeNull();
    expect(await ops.runPagesEdit({ kind: "delete", pages: [5] })).toBeNull();
    expect(calls).toEqual([]);
    expect(toastTexts()).toEqual(["Could not change the pages."]);
    const result = await ops.runPagesEdit({ kind: "move", order: [2, 1, 0] }, 1);
    expect(result?.layout.from).toEqual([2, 1, 0]);
    expect(state.currentPage.value).toBe(1);
    expect(d.pages.length).toBe(3);
  });
});

describe("edit marks and undo", () => {
  it("marks follow their page through a move, go with a deleted page and come back with it", async () => {
    const d = await openPages(4);
    await editPage(1);
    const marked = d.pages[1];
    expect([...state.editedPages.value]).toEqual([1]);
    await ops.movePagesTo([1], 4);
    expect(marked.index).toBe(3);
    expect([...state.editedPages.value]).toEqual([3]);
    expect([...state.editedKeys.value]).toEqual([marked.key]);
    await ops.deletePagesAction([3]);
    expect(state.editedPages.value.size).toBe(0);
    await actions.undo();
    expect(d.pages[3]).toBe(marked); // the very PageModel, back where it was
    expect([...state.editedPages.value]).toEqual([3]);
    await actions.redo();
    expect(d.pages.includes(marked)).toBe(false);
    expect(state.editedPages.value.size).toBe(0);
  });

  it("undo and redo of a page operation bring back the PageModels, with new revisions", async () => {
    const d = await openPages(4);
    const all = d.pages.slice();
    await ops.deletePagesAction([0, 2]);
    expect(d.pages).toEqual([all[1], all[3]]);
    const revs = all.map((p) => p.rev.peek());
    await actions.undo();
    expect(calls.at(-1)).toBe("undo");
    expect(d.pages).toEqual(all);
    expect(indicesOf(d)).toEqual([0, 1, 2, 3]);
    expect(all.map((p) => p.rev.peek() > revs[all.indexOf(p)])).toEqual([true, true, true, true]);
    expect(state.dirty.value).toBe(false); // back to the state as opened
    await actions.redo();
    expect(d.pages).toEqual([all[1], all[3]]);
    expect(state.dirty.value).toBe(true);
    expect(d.info.pageCount).toBe(2);
  });

  it("the current page follows the page it showed through an undo, or its nearest neighbour", async () => {
    const d = await openPages(4);
    const third = d.pages[2];
    await ops.movePagesTo([0], 4);
    state.currentPage.value = third.index; // 1
    await actions.undo();
    expect(state.currentPage.value).toBe(2);
    await actions.redo();
    await ops.insertBlankPage(4);
    state.currentPage.value = 4; // the blank page
    await actions.undo(); // it goes: the page before it is shown
    expect(state.currentPage.value).toBe(3);
  });

  it("the delete's Undo undoes that very delete, and only while it is the last edit", async () => {
    const d = await openPages(3);
    const all = d.pages.slice();
    await ops.deletePagesAction([1]);
    const toast = state.toasts.value.find((x) => x.text === "1 page deleted.")!;
    await editPage(0);
    toast.action!.run();
    expect(calls).not.toContain("undo");
    expect(toastTexts()).toContain("Other changes came after it: undo those first.");
    await actions.undo(); // the text
    calls.length = 0;
    toast.action!.run();
    await vi.waitFor(() => expect(calls).toEqual(["undo"]));
    await vi.waitFor(() => expect(d.pages).toEqual(all));
    toast.action!.run(); // undone already: nothing
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toEqual(["undo"]);
  });

  it("P10: the delete's Undo never undoes text still in the writer when it was pressed", async () => {
    const d = await openPages(3);
    await actions.setTool("fill");
    await ops.deletePagesAction([1]);
    const toast = state.toasts.value.find((x) => x.text === "1 page deleted.")!;
    // A writer, "Mario" typed and not written yet (on a phone the writer keeps the focus when the
    // toast's button is tapped): FillLayer's handle writes it when asked (flushEditor).
    expect(await actions.openWriterAt(0, [20, 40], "text")).not.toBeNull();
    const w = state.openWriter.value!;
    const unregister = state.registerEditor({
      changed: () => true,
      commit: () => actions.commitWriter(w, "Mario", w.origin, w.size, w.color),
    });
    calls.length = 0;
    try {
      toast.action!.run();
      await vi.waitFor(() => expect(toastTexts()).toContain("Other changes came after it: undo those first."));
    } finally {
      unregister();
    }
    expect(calls).toEqual(["addText:0:Mario"]);
    expect(d.pages.length).toBe(2); // the delete stays, and so does the text
    expect(state.history.value.editCount).toBe(2);
  });

  it("P10: nor an edit on its way when it was pressed", async () => {
    const d = await openPages(3);
    await actions.setTool("fill");
    await ops.deletePagesAction([1]);
    const toast = state.toasts.value.find((x) => x.text === "1 page deleted.")!;
    calls.length = 0;
    const held = hold("addText");
    const ticking = actions.openWriterAt(0, [20, 20], "check");
    const release = await held;
    toast.action!.run(); // the tick has not landed: the delete is still the last edit here
    release();
    await ticking;
    await vi.waitFor(() => expect(toastTexts()).toContain("Other changes came after it: undo those first."));
    expect(calls).toEqual(["addText:0:✓"]);
    expect(d.pages.length).toBe(2);
    expect(state.history.value.editCount).toBe(2);
  });
});

describe("P11: nothing that holds typed text opens while the pages change", () => {
  /** What a test holds, let go once at its end whatever happened: a failure must not hold the queue for the next test. */
  const holding: (() => void)[] = [];
  function letGoAtEnd(release: () => void): () => void {
    let done = false;
    const once = () => {
      if (done) return;
      done = true;
      release();
    };
    holding.push(once);
    return once;
  }
  afterEach(() => {
    for (const release of holding.splice(0)) release();
  });

  /** Hold the engine's queue as a download being written does; returns the function that lets it go. */
  function holdQueue(): () => void {
    let free!: () => void;
    void actions.exclusive("save", () => new Promise<void>((r) => { free = r; }));
    return letGoAtEnd(() => free());
  }

  it("no writer opens while a page operation runs; once it has landed, one does", async () => {
    await openPages(3);
    await actions.setTool("fill");
    const held = hold("editPages");
    const inserting = ops.insertBlankPage(3);
    const release = letGoAtEnd(await held);
    expect(actions.pagesChanging()).toBe(true);
    expect(await actions.openWriterAt(0, [20, 40], "text")).toBeNull();
    expect(state.openWriter.value).toBeNull();
    expect(toastTexts()).toContain("Just a moment: the pages are changing.");
    release();
    await inserting;
    expect(actions.pagesChanging()).toBe(false);
    expect(calls).toEqual(["editPages:blank@3"]);
    expect(await actions.openWriterAt(0, [20, 40], "text")).not.toBeNull();
    expect(state.openWriter.value?.pageIndex).toBe(0);
  });

  it("nor while it waits its turn behind a download; no line editor and no image selection either", async () => {
    const d = await openPages(3);
    await actions.setTool("edit");
    const free = holdQueue();
    const deleting = ops.deletePagesAction([2]);
    await new Promise((r) => setTimeout(r, 0));
    expect(state.busy.value).toBe("save"); // the delete waits behind it
    expect(actions.pagesChanging()).toBe(true);
    const line = { index: 0 } as any;
    await actions.openLine(0, line);
    expect(state.editingLine.value).toBeNull();
    await actions.selectImage(0, { index: 0, movable: true, added: true } as any, d.pages[0].rev.peek());
    expect(state.selectedImage.value).toBeNull();
    await actions.setEditTool("addText");
    expect(await actions.openWriterAt(1, [20, 40], "text")).toBeNull();
    free();
    await deleting;
    expect(calls).toEqual(["editPages:delete:2"]);
    expect(actions.pagesChanging()).toBe(false);
    await actions.setEditTool("change");
    await actions.openLine(0, line);
    expect(state.editingLine.value?.pageIndex).toBe(0);
  });

  it("the undo of a page operation counts too; an ordinary undo still lets a new text's writer open", async () => {
    const d = await openPages(3);
    await actions.setTool("fill");
    await ops.deletePagesAction([2]);
    let free = holdQueue();
    let undoing = actions.undo();
    expect(await actions.openWriterAt(0, [20, 40], "text")).toBeNull();
    free();
    await undoing;
    expect(d.pages.length).toBe(3);
    expect(actions.pagesChanging()).toBe(false);

    await editPage(0);
    free = holdQueue();
    undoing = actions.undo();
    expect(actions.pagesChanging()).toBe(false);
    expect(await actions.openWriterAt(0, [20, 40], "text")).not.toBeNull();
    const writer = state.openWriter.value;
    free();
    await undoing;
    expect(state.openWriter.value).toBe(writer); // it has no index to go stale: still open, with what is typed
    state.openWriter.value = null;
  });

  it("a tick tapped meanwhile is still written, on its page", async () => {
    const d = await openPages(3);
    await actions.setTool("fill");
    const first = d.pages[0];
    const held = hold("editPages");
    const inserting = ops.insertBlankPage(0);
    const release = letGoAtEnd(await held);
    const ticking = actions.openWriterAt(0, [20, 20], "check");
    release();
    await Promise.all([inserting, ticking]);
    expect(first.index).toBe(1);
    expect(calls).toEqual(["editPages:blank@0", "addText:1:✓"]);
  });

  // Fix round 2: what the undos and redos on their way will reach, step after step.

  it("two undos behind a download, the second of a delete: no writer opens until both have run", async () => {
    const d = await openPages(3);
    await actions.setTool("fill");
    await ops.deletePagesAction([2]);
    await editPage(0); // a text after the delete: the first undo takes it back, the second the delete
    calls.length = 0;
    state.toasts.value = [];
    const free = holdQueue();
    const first = actions.undo();
    const second = actions.undo();
    await new Promise((r) => setTimeout(r, 0));
    expect(state.busy.value).toBe("save"); // both wait behind it
    expect(actions.pagesChanging()).toBe(true);
    expect(await actions.openWriterAt(0, [20, 40], "text")).toBeNull();
    expect(state.openWriter.value).toBeNull();
    expect(toastTexts()).toContain("Just a moment: the pages are changing.");
    free();
    await Promise.all([first, second]);
    expect(calls).toEqual(["undo", "undo"]);
    expect(d.pages.length).toBe(3);
    expect(actions.pagesChanging()).toBe(false);
    expect(await actions.openWriterAt(0, [20, 40], "text")).not.toBeNull(); // now it does
    state.openWriter.value = null;
  });

  it("two redos behind a download, the second of a delete: the same", async () => {
    const d = await openPages(3);
    await actions.setTool("fill");
    await editPage(0);
    await ops.deletePagesAction([2]);
    await actions.undo(); // the delete
    await actions.undo(); // the text: redo brings the text back first, then the delete
    calls.length = 0;
    const free = holdQueue();
    const first = actions.redo();
    expect(actions.pagesChanging()).toBe(false); // the text alone changes no page list
    const second = actions.redo();
    expect(actions.pagesChanging()).toBe(true);
    await actions.selectImage(0, { index: 0, movable: true, added: true } as any, d.pages[0].rev.peek());
    expect(state.selectedImage.value).toBeNull();
    expect(await actions.openWriterAt(0, [20, 40], "text")).toBeNull();
    free();
    await Promise.all([first, second]);
    expect(calls).toEqual(["redo", "redo"]);
    expect(d.pages.length).toBe(2);
    expect(actions.pagesChanging()).toBe(false);
  });

  it("an undo that will find nothing to undo, or an edit landing first, is followed as the mirror goes", async () => {
    const d = await openPages(3);
    await ops.deletePagesAction([1]);
    const deleted = state.lastEditId()!;
    await editPage(0);
    const text = state.lastEditId()!;
    // Undo the text, then the delete: the second reaches a page operation.
    const firstDone = state.stepAsked(d, "undo");
    expect(state.stepsAheadChangePages(d)).toBe(false);
    const secondDone = state.stepAsked(d, "undo");
    expect(state.stepsAheadChangePages(d)).toBe(true);
    secondDone();
    // "Annulla" of the delete behind the undo of the text: once the text is undone, it is the last one.
    const annulla = state.stepAsked(d, "undo", deleted);
    expect(state.stepsAheadChangePages(d)).toBe(true);
    annulla();
    // An "Annulla" for an edit that is not the last one does nothing, nor do the steps after it.
    const stale = state.stepAsked(d, "undo", text + 1000);
    expect(state.stepsAheadChangePages(d)).toBe(false);
    stale();
    firstDone();
    // A redo with nothing to redo reaches nothing; nor does a step of another document.
    const redo = state.stepAsked(d, "redo");
    expect(state.stepsAheadChangePages(d)).toBe(false);
    redo();
    const other = state.stepAsked({} as any, "undo");
    expect(state.stepsAheadChangePages(d)).toBe(false);
    other();
    // Asked once the delete is the last edit: it counts at once.
    await actions.undo(); // the text
    const again = state.stepAsked(d, "undo");
    expect(state.stepsAheadChangePages(d)).toBe(true);
    again();
    again(); // once
    expect(state.stepsAheadChangePages(d)).toBe(false);
  });

  it("a writer open anyway when such a step runs is written after it, on its page, not dropped", async () => {
    const d = await openPages(3);
    await actions.setTool("fill");
    await ops.deletePagesAction([2]);
    const first = d.pages[0];
    calls.length = 0;
    const free = holdQueue();
    const undoing = actions.undo(); // the delete: the page comes back
    await new Promise((r) => setTimeout(r, 0));
    // A writer that got past the guard, "Mario" typed in it and not written yet.
    const w = { pageIndex: 0, origin: [20, 40], text: "", size: 11, color: "black", kind: "text", editing: null, rev: first.rev.peek() } as any;
    state.openWriter.value = w;
    const unregister = state.registerEditor({
      changed: () => true,
      commit: () => actions.commitWriter(w, "Mario", w.origin, w.size, w.color),
    });
    try {
      free();
      await undoing;
      await vi.waitFor(() => expect(calls).toEqual(["undo", "addText:0:Mario"]));
    } finally {
      unregister();
    }
    expect(state.openWriter.value).toBeNull();
    expect(d.pages.length).toBe(3);
    expect(first.index).toBe(0);
    expect(state.history.value.editCount).toBe(1); // the delete undone, the text written
  });
});

describe("before and after an operation", () => {
  it("writes what is typed, then closes everything that holds a page index", async () => {
    const d = await openPages(3);
    await actions.setTool("fill");
    const sig = { id: "s", kind: "initials", png: new Blob([]), width: 1, height: 1, description: "", source: "type", savedAt: null } as any;
    state.editingLine.value = { pageIndex: 0, line: {} as any };
    state.selectedImage.value = { pageIndex: 1, index: 0 };
    state.openWriter.value = { pageIndex: 2, origin: [1, 1], text: "", size: 11, color: "black", kind: "text", editing: null, rev: 0 };
    state.focusedField.value = { pageIndex: 1, name: "a", index: 0 };
    state.focusRequest.value = { pageIndex: 1, kind: "image", id: 0 };
    state.initialsSource.value = { docId: d.id, pageIndex: 1, imageIndex: 0, sig };
    state.editingDecorations.value = { pageIndex: 0, lineIndex: 0, rev: 0, info: {} as any };
    fields.lastFieldFocus.value = { docId: d.id, pageIndex: 1 };
    const unregister = state.registerEditor({
      changed: () => true,
      commit: async () => {
        unregister();
        calls.push("commit");
      },
    });
    await ops.rotatePagesAction([0], 180);
    expect(calls).toEqual(["commit", "editPages:rotate:0:180"]);
    expect(state.editingLine.value).toBeNull();
    expect(state.selectedImage.value).toBeNull();
    expect(state.openWriter.value).toBeNull();
    expect(state.focusedField.value).toBeNull();
    expect(state.focusRequest.value).toBeNull();
    expect(state.initialsSource.value).toBeNull();
    expect(state.editingDecorations.value).toBeNull();
    expect(fields.lastFieldFocus.value).toBeNull();
  });

  it("fix round 3: an operation that finds nothing to do, with nothing on its way, touches nothing", async () => {
    const d = await openPages(3);
    await actions.setTool("fill");
    const sig = { id: "s", kind: "signature", png: new Blob([]), width: 1, height: 1, description: "", source: "type", savedAt: null } as any;
    state.fillTool.value = "signature";
    state.pendingPlacement.value = sig;
    state.selectedImage.value = { pageIndex: 1, index: 0 };
    state.focusRequest.value = { pageIndex: 1, kind: "image", id: 0 };
    state.editingDecorations.value = { pageIndex: 0, lineIndex: 0, rev: 0, info: {} as any };
    fields.lastFieldFocus.value = { docId: d.id, pageIndex: 1 };
    const kept = () => {
      expect(state.pendingPlacement.value).toBe(sig);
      expect(state.fillTool.value).toBe("signature");
      expect(state.selectedImage.value).toEqual({ pageIndex: 1, index: 0 });
      expect(state.focusRequest.value).toEqual({ pageIndex: 1, kind: "image", id: 0 });
      expect(state.editingDecorations.value).not.toBeNull();
      expect(fields.lastFieldFocus.value).toEqual({ docId: d.id, pageIndex: 1 });
    };
    // A PagesAsk that says "nothing to do", and a move to where the pages are.
    const asked: number[] = [];
    expect(await ops.runPagesEdit((now) => { asked.push(now.pages.length); return null; })).toBeNull();
    kept();
    await ops.movePagesTo([1], 2);
    await ops.movePagesTo([0, 1], 0);
    kept();
    expect(calls).toEqual([]);
    expect(asked).toEqual([3]); // asked once, at once: not again in the queue
    expect(toastTexts()).toEqual([]);
    // One with something to do: asked at once and again in the queue (the last one counts), then everything closes.
    const result = await ops.runPagesEdit((now) => {
      asked.push(now.pages.length);
      return { edit: { kind: "move", order: [1, 0, 2] }, show: 0 };
    });
    expect(result).not.toBeNull();
    expect(asked).toEqual([3, 3, 3]);
    expect(calls).toEqual(["editPages:move:1,0,2"]);
    expect(state.pendingPlacement.value).toBeNull();
    expect(state.fillTool.value).toBe("text");
    expect(state.selectedImage.value).toBeNull();
    expect(fields.lastFieldFocus.value).toBeNull();
  });

  it("fix round 3: with a page operation on its way it is worked out in the queue only; nothing to do there, nothing more closes", async () => {
    const d = await openPages(3);
    const held = hold("editPages");
    const inserting = ops.insertBlankPage(3);
    const release = await held;
    // A download asked for meanwhile: what is asked next waits behind it too.
    let free!: () => void;
    const saving = actions.exclusive("save", () => new Promise<void>((r) => { free = r; }));
    const asked: number[] = [];
    const nudge = ops.runPagesEdit((now) => { asked.push(now.pages.length); return null; });
    await new Promise((r) => setTimeout(r, 0));
    expect(asked).toEqual([]); // the pages are about to change: not asked yet
    release();
    await inserting;
    await new Promise((r) => setTimeout(r, 0));
    expect(asked).toEqual([]); // waiting behind the download
    // Chosen while it waits its turn (the insert closed what was open when it was asked for).
    const sig = { id: "s", kind: "signature", png: new Blob([]), width: 1, height: 1, description: "", source: "type", savedAt: null } as any;
    state.pendingPlacement.value = sig;
    free();
    await saving;
    expect(await nudge).toBeNull();
    expect(asked).toEqual([4]); // in the queue, after the insert
    expect(state.pendingPlacement.value).toBe(sig); // its "nothing to do" closed nothing in the queue
    expect(calls).toEqual(["editPages:blank@3"]);
    expect(d.pages).toHaveLength(4);
    state.pendingPlacement.value = null;
  });

  it("an undo of a page operation closes a new text's writer too; an ordinary undo keeps it", async () => {
    await openPages(3);
    await actions.setTool("fill");
    await editPage(0);
    const writer = { pageIndex: 2, origin: [1, 1], text: "", size: 11, color: "black", kind: "text", editing: null, rev: 0 } as any;
    state.openWriter.value = writer;
    await actions.undo(); // the text: no page changed
    expect(state.openWriter.value).toBe(writer);
    await ops.deletePagesAction([2]);
    state.openWriter.value = writer;
    await actions.undo();
    expect(state.openWriter.value).toBeNull();
  });

  it("a question about a page still open is answered no", async () => {
    await openPages(3);
    let answer: unknown = "none";
    state.showDialog({ kind: "initials-pages", pageIndex: 1, imageIndex: 0, resolve: (p) => { answer = p; } });
    await ops.insertBlankPage(0);
    expect(answer).toBeNull();
    expect(state.dialog.value).toBeNull();
  });

  it("an operation asked for while another runs follows its pages", async () => {
    const d = await openPages(4);
    const last = d.pages[3];
    const held = hold("editPages");
    const deleting = ops.deletePagesAction([0]);
    const release = await held;
    const rotating = ops.rotatePagesAction([3], 90); // asked for with the pages as they were
    const inserting = ops.runPagesEdit({ kind: "blank", at: 4 }, 4); // "at the end"
    release();
    await Promise.all([deleting, rotating, inserting]);
    expect(calls).toEqual(["editPages:delete:0", "editPages:rotate:2:90", "editPages:blank@3"]);
    expect(last.index).toBe(2);
    expect(last.bounds).toEqual([0, 0, 200, 100]);
    expect(state.currentPage.value).toBe(3); // the blank page: `show` gave way to it
  });

  it("a tick asked for before a move lands on its page wherever it went; one before a turn is dropped", async () => {
    const d = await openPages(3);
    await actions.setTool("fill");
    const first = d.pages[0];
    let held = hold("editPages");
    const moving = ops.movePagesTo([0], 3);
    let release = await held;
    const ticking = actions.openWriterAt(0, [20, 20], "check");
    release();
    await Promise.all([moving, ticking]);
    expect(first.index).toBe(2);
    expect(calls).toEqual(["editPages:move:1,2,0", "addText:2:✓"]);

    calls.length = 0;
    state.toasts.value = [];
    held = hold("editPages");
    const turning = ops.rotatePagesAction([2], 90);
    release = await held;
    const ticking2 = actions.openWriterAt(2, [20, 20], "check");
    release();
    await Promise.all([turning, ticking2]);
    expect(calls).toEqual(["editPages:rotate:2:90"]);
    expect(toastTexts()).toContain("Could not write this text.");
  });
});

describe("Estrai", () => {
  it("downloads the pages through the save dialog, named after them; the document does not change", async () => {
    const d = await openPages(5);
    const names: string[] = [];
    (globalThis as any).showSaveFilePicker = async (o: { suggestedName: string }) => {
      names.push(o.suggestedName);
      return { name: o.suggestedName, createWritable: async () => ({ write: async () => undefined, close: async () => undefined }) };
    };
    try {
      const rev = d.layout.peek();
      await ops.extractPagesAction([3, 1, 2]);
      expect(names).toEqual(["Report - pages 2-4.pdf"]);
      expect(calls).toEqual(["extractPages:1,2,3"]);
      expect(extractOptions.at(-1)).toEqual({ format: "pdf", password: { mode: "none" } });
      expect(toastTexts()).toEqual(["Downloaded “Report - pages 2-4.pdf”."]);
      expect(d.layout.peek()).toBe(rev);
      expect(state.dirty.value).toBe(false);
      expect(state.downloadRunning.value).toBe(false);
    } finally {
      delete (globalThis as any).showSaveFilePicker;
    }
  });

  it("asks first when the document's password cannot be kept; keeps the one it can", async () => {
    await openPages(2, { needsPassword: true, canKeepPassword: false });
    const extracting = ops.extractPagesAction([0]);
    await answerConfirm(false);
    await extracting;
    expect(calls).toEqual([]);
    await openPages(2, { needsPassword: true, canKeepPassword: true });
    await ops.extractPagesAction([1]); // a plain download (no save dialog here)
    expect(calls).toEqual(["extractPages:1"]);
    expect(extractOptions.at(-1)).toEqual({ format: "pdf", password: { mode: "keep" } });
  });
});

describe("the other PDF", () => {
  it("a file over the limit is refused before it is read; one within it opens and closes", async () => {
    await openPages(2);
    const { MAX_SOURCE_BYTES } = await import("../src/engine/protocol");
    expect(await ops.openSourceFile(fakeFile("big.pdf", MAX_SOURCE_BYTES + 1))).toEqual({ ok: false, reason: "too-big" });
    expect(calls).toEqual([]);
    const opened = await ops.openSourceFile(fakeFile("other.pdf", 100));
    expect(opened).toMatchObject({ ok: true, source: 1, pageCount: 2 });
    await ops.closeSourceFile(1);
    expect(calls).toEqual(["openSource", "closeSource:1"]);
  });
});

describe("documents opened another way", () => {
  it("adoptOpened with a history (Riprendi): the edits applied, undoable, not downloaded, no page marked", async () => {
    await openPages(2);
    const result = {
      ok: true, pageCount: 3, pages: infoPages([fresh(), fresh(), fresh()]), encrypted: false, needsPassword: false,
      canKeepPassword: false, pdfa: null, signatures: 0, form: null, title: null,
      history: { editCount: 3, canUndo: true, canRedo: false, changedPages: [1] }, applied: 3, failedAt: null,
    } as any;
    state.currentPage.value = 1;
    await actions.adoptOpened(result, "Resumed.pdf", result.history);
    const d = state.doc.value!;
    expect(d.fileName).toBe("Resumed.pdf");
    expect(d.pages.length).toBe(3);
    expect(Object.keys(d.info).sort()).toEqual([
      "canKeepPassword", "encrypted", "form", "needsPassword", "pageCount", "pages", "pdfa", "signatures", "title",
    ]);
    expect(state.currentPage.value).toBe(0);
    expect(state.history.value).toMatchObject({ editCount: 3, canUndo: true, canRedo: false });
    expect(state.dirty.value).toBe(true);
    expect(state.editedPages.value.size).toBe(0);
    // What those edits did is not known: an undo closes everything that holds a page index.
    expect(state.stepChangesPages("undo")).toBeNull();
  });

  it("a new PDF from pictures asks first when there are edits not downloaded", async () => {
    const before = await openPages(2);
    await editPage(0);
    const pictures = [{ bytes: new ArrayBuffer(2), width: 10, height: 10, dpi: 200 }];
    let making = actions.newFromPicturesAction(pictures, "Scan 2026-10-17.pdf");
    await answerConfirm(false);
    expect(await making).toBe(false);
    expect(state.doc.value).toBe(before);
    expect(calls).toEqual(["addText:0:x"]);

    making = actions.newFromPicturesAction([...pictures, ...pictures], "Scan 2026-10-17.pdf");
    await answerConfirm(true);
    expect(await making).toBe(true);
    const d = state.doc.value!;
    expect(d).not.toBe(before);
    expect(d.fileName).toBe("Scan 2026-10-17.pdf");
    expect(d.pages.length).toBe(2);
    expect(calls.at(-1)).toBe("newFromPictures:2");
    expect(state.history.value.editCount).toBe(0);
    // It exists nowhere else yet: not downloaded until it is.
    expect(state.dirty.value).toBe(true);
    state.markSaved(state.saveKey());
    expect(state.dirty.value).toBe(false);
  });

  it("without edits to lose it does not ask", async () => {
    await openPages(1);
    expect(await actions.newFromPicturesAction([{ bytes: new ArrayBuffer(2), width: 1, height: 1, dpi: 72 }], "Scan.pdf")).toBe(true);
    expect(state.dialog.value).toBeNull();
    expect(state.doc.value?.fileName).toBe("Scan.pdf");
  });
});

describe("P13: a document that exists nowhere else stays not downloaded", () => {
  /** What resumeSession answers: the document with `editCount` edits applied again (the fake engine has them too). */
  function resumedDoc(count: number, editCount: number) {
    pages = Array.from({ length: count }, () => fresh());
    past = Array.from({ length: editCount }, () => pages);
    future = [];
    return {
      ok: true, pageCount: count, pages: infoPages(pages), encrypted: false, needsPassword: false,
      canKeepPassword: false, pdfa: null, signatures: 0, form: null, title: null,
      history: { editCount, canUndo: editCount > 0, canRedo: false, changedPages: [] }, applied: editCount, failedAt: null,
    } as any;
  }

  it("a new PDF from scans, its edits undone: still not downloaded", async () => {
    await openPages(1);
    expect(await actions.newFromPicturesAction([{ bytes: new ArrayBuffer(2), width: 1, height: 1, dpi: 72 }], "Scan.pdf")).toBe(true);
    await editPage(0);
    await actions.undo();
    expect(state.history.value.editCount).toBe(0);
    expect(state.dirty.value).toBe(true);
    expect(state.neverDownloaded()).toBe(true);
  });

  it("resumed with Riprendi, every edit undone: still not downloaded, so closing or leaving asks", async () => {
    await openPages(2);
    const result = resumedDoc(2, 1);
    expect(await actions.adoptOpened(result, "Scansione 2026-10-17.pdf", result.history)).toBe(true);
    expect(state.dirty.value).toBe(true);
    expect(state.neverDownloaded()).toBe(true);
    await actions.undo();
    expect(calls.at(-1)).toBe("undo");
    expect(state.history.value.editCount).toBe(0);
    expect(state.dirty.value).toBe(true); // the autosave keeps it, as the file itself
    expect(state.hasUnsavedWork()).toBe(true);
    expect(actions.shouldWarnBeforeUnload()).toBe(true);
    // Downloaded once: from then on it counts as any other.
    state.markSaved(state.saveKey());
    expect(state.dirty.value).toBe(false);
    expect(state.neverDownloaded()).toBe(false);
  });

  it("resumed from a file known to exist elsewhere: back at the start, it is clean", async () => {
    await openPages(2);
    const result = resumedDoc(2, 1);
    await actions.adoptOpened(result, "Contratto.pdf", result.history, { unsaved: false });
    expect(state.dirty.value).toBe(true);
    expect(state.neverDownloaded()).toBe(false);
    await actions.undo();
    expect(state.dirty.value).toBe(false);
  });
});

describe("P14: Riprendi's open is sequenced with the others", () => {
  const resumed = () => ({
    ok: true, pageCount: 3, pages: infoPages([fresh(), fresh(), fresh()]), encrypted: false, needsPassword: false,
    canKeepPassword: false, pdfa: null, signatures: 0, form: null, title: null,
    history: { editCount: 2, canUndo: true, canRedo: false, changedPages: [] }, applied: 2, failedAt: null,
  } as any);

  it("an open asked for after it wins, on screen as in the engine", async () => {
    await openPages(2);
    await actions.closeDocument();
    const ticket = actions.beginOpen("Report.pdf");
    expect(state.opening.value).toBe("Report.pdf"); // the "opening…" card
    expect(ticket.current()).toBe(true);
    // The resume's request went out; the same file is dropped meanwhile, its open sent after it.
    calls.length = 0;
    const held = hold("open");
    const opening = actions.openFile(fakeFile("Report.pdf"), { confirmed: true });
    const release = await held;
    expect(ticket.current()).toBe(false); // so a resume not sent yet is not sent at all
    const r = resumed();
    expect(await actions.adoptOpened(r, "Report.pdf", r.history, { ticket })).toBe(false);
    expect(state.doc.value).toBeNull();
    expect(state.opening.value).toBe("Report.pdf");
    release();
    await opening;
    expect(calls).toEqual(["open"]); // the engine's last request…
    expect(state.doc.value?.pages.length).toBe(2); // …is the document on screen
    expect(state.history.value.editCount).toBe(0);
    expect(state.opening.value).toBeNull();
  });

  it("an open asked for before it lands nowhere; a close cancels it", async () => {
    await openPages(2);
    await actions.closeDocument();
    const held = hold("open");
    const opening = actions.openFile(fakeFile("Other.pdf"), { confirmed: true });
    const release = await held;
    const ticket = actions.beginOpen("Report.pdf");
    release();
    await opening;
    expect(state.doc.value).toBeNull(); // its answer came after Riprendi was asked for
    expect(state.opening.value).toBe("Report.pdf");
    const r = resumed();
    expect(await actions.adoptOpened(r, "Report.pdf", r.history, { ticket })).toBe(true);
    const d = state.doc.value!;
    expect(d.fileName).toBe("Report.pdf");
    expect(d.pages.length).toBe(3);
    expect(state.history.value.editCount).toBe(2);
    expect(state.opening.value).toBeNull();

    const closing = actions.closeDocument(); // asks: the resumed edits are not downloaded
    await answerConfirm(true);
    await closing;
    const late = actions.beginOpen("Report.pdf");
    await actions.closeDocument();
    expect(late.current()).toBe(false);
    expect(await actions.adoptOpened(resumed(), "Report.pdf", undefined, { ticket: late })).toBe(false);
    expect(state.doc.value).toBeNull();
  });
});
