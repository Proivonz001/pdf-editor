// The page organizer (release 4: viewer/Thumbnails.tsx, ui/organizer), without a browser: the
// selection rules (a click, Ctrl/Cmd, Shift, all), the order a keyboard move makes (Alt+↑/↓) and
// where a drag lands between thumbnails (list and grid), the keys and where they move the focus,
// the names of the places between pages, the turn a thumbnail shows until its new bitmap; then,
// against the app's real state, actions and page actions with a fake engine: the action bar's
// commands on the selection (rotate, duplicate, extract, delete, move to a position), never
// deleting every page, keyboard moves that follow each other, a drop, the "+" menu's items (a
// blank page, the scan flow, the page picker of another PDF), the move dialog's places, the page
// picker's flow (a PDF opened, a password asked inline and a wrong one said, a file too big,
// damaged or not a PDF, its pages chosen, added at the place, the other PDF closed with the
// dialog or once its pages are in), and the drop zones a dragged file finds. Then a page
// operation landing while something holds pages or a place (fix round 1): keyboard moves and the
// action bar while another operation is on its way (P18), the move dialog's pages and place
// (P16, P12), the page picker's place (P12), a second PDF opened while the first one's insert
// waits (P17), and the "+" between pages after a delete (P15: the line it is drawn on, a place
// past the end, an open menu's place). Fix round 2 (P18): a keyboard move takes its place among
// the changes when it is pressed and is worked out in the queue, so Ctrl+Z pressed after it, behind
// a download or a long insert, undoes the move.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "./stubs/browser-globals";

vi.mock("../src/engine/client.ts", () => {
  class EngineError extends Error {
    constructor(message: string, readonly code?: string) {
      super(message);
    }
  }
  const e = () => (globalThis as any).__orgEngine;
  class EngineClient {
    ready = Promise.resolve();
    open(bytes: ArrayBuffer, password?: string) { return e().open(bytes, password); }
    render() { return Promise.reject(new Error("no bitmaps in Node")); }
    lines() { return Promise.resolve([]); }
    images() { return Promise.resolve([]); }
    fields() { return Promise.resolve([]); }
    addedTexts() { return Promise.resolve([]); }
    undo() { return e().undo(); }
    redo() { return e().redo(); }
    save(options: unknown) { return e().save(options); }
    close() { return e().close(); }
    editPages(edit: unknown) { return e().editPages(edit); }
    extractPages(pages: number[], options: unknown) { return e().extractPages(pages, options); }
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
// The fake engine: a page list (each page an identity and its bounds), a history of page lists,
// and the other PDFs it opens for the page picker.

type Rect = [number, number, number, number];
interface FakePage {
  id: number;
  bounds: Rect;
}

const PORTRAIT: Rect = [0, 0, 100, 200];
const calls: string[] = [];
const edits: any[] = [];
let pages: FakePage[] = [];
let past: FakePage[][] = [];
let future: FakePage[][] = [];
let nextPageId = 1;
let openCount = 4;
/** The other PDFs: what the next openSource answers, and the ones open now. */
let sourcePages = 3;
let sourcePassword: string | null = null;
let sourceDamaged = false;
let nextSource = 1;
const openSources = new Set<number>();

const fresh = (bounds: Rect = PORTRAIT): FakePage => ({ id: nextPageId++, bounds });
const infoPages = (list: FakePage[]) => list.map((p, index) => ({ index, bounds: p.bounds }));

function layoutOf(before: FakePage[], after: FakePage[]) {
  return {
    pages: infoPages(after),
    from: after.map((p) => {
      const i = before.findIndex((b) => b.id === p.id);
      return i < 0 ? null : i;
    }),
    form: null,
    signatures: 0,
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
    case "insert": return `insert:${edit.source}:${edit.pages === "all" ? "all" : edit.pages.join(",")}@${edit.at}`;
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
      canKeepPassword: false, pdfa: null, signatures: 0, form: null, title: null,
    };
  },
  editPages: async (edit: any) => {
    calls.push(`editPages:${describeEdit(edit)}`);
    edits.push(edit);
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
      case "insert": {
        if (!openSources.has(edit.source)) throw new Error("that source is not open");
        next = added(edit.pages === "all" ? sourcePages : edit.pages.length, edit.at);
        break;
      }
      default: throw new Error("bad edit");
    }
    const before = pages;
    past.push(before);
    future = [];
    pages = next;
    return { ...historyNow(changed, layoutOf(before, next)), report: { linksRemoved: 0, fieldsRenamed: 0, signaturesAdded: 0 } };
  },
  undo: async () => {
    calls.push("undo");
    const prev = past.pop()!;
    const before = pages;
    future.push(before);
    pages = prev;
    return historyNow([], layoutOf(before, prev));
  },
  redo: async () => {
    calls.push("redo");
    const next = future.pop()!;
    const before = pages;
    past.push(before);
    pages = next;
    return historyNow([], layoutOf(before, next));
  },
  save: async () => ({ bytes: new ArrayBuffer(4), pdfa: null }),
  close: async () => null,
  extractPages: async (chosen: number[]) => {
    calls.push(`extractPages:${chosen.join(",")}`);
    return { bytes: new ArrayBuffer(8), pdfa: null };
  },
  openSource: async (_bytes: ArrayBuffer, password?: string) => {
    calls.push(password === undefined ? "openSource" : `openSource:${password}`);
    openSources.clear(); // one at a time, as the session keeps them: opening another closes it
    if (sourceDamaged) return { ok: false, reason: "damaged" };
    if (sourcePassword !== null && password === undefined) return { ok: false, reason: "password-required" };
    if (sourcePassword !== null && password !== sourcePassword) return { ok: false, reason: "wrong-password" };
    const source = nextSource++;
    openSources.add(source);
    const list = Array.from({ length: sourcePages }, () => fresh());
    return { ok: true, source, pageCount: list.length, pages: infoPages(list), title: "Other" };
  },
  renderSource: async (source: number, pageIndex: number) => {
    calls.push(`renderSource:${source}:${pageIndex}`);
    return { bitmap: { close() {} }, width: 1, height: 1, scale: 1 };
  },
  closeSource: async (source: number) => {
    calls.push(`closeSource:${source}`);
    openSources.delete(source);
    return null;
  },
};
(globalThis as any).__orgEngine = engineImpl;

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

function fakeFile(name: string, opts: { size?: number; type?: string } = {}): File {
  return {
    name,
    type: opts.type ?? (name.endsWith(".pdf") ? "application/pdf" : ""),
    size: opts.size ?? 100,
    arrayBuffer: async () => new TextEncoder().encode(name).buffer,
  } as unknown as File;
}

let state: typeof import("../src/state");
let actions: typeof import("../src/ui/actions");
let model: typeof import("../src/ui/organizer/model");
let commands: typeof import("../src/ui/organizer/commands");
let picker: typeof import("../src/ui/organizer/sourcePicker");
let moveDialog: typeof import("../src/ui/organizer/MovePagesDialog");
let zones: typeof import("../src/ui/organizer/dropZone");
let protocol: typeof import("../src/engine/protocol");
let fields: typeof import("../src/viewer/fields");

beforeAll(async () => {
  state = await import("../src/state");
  actions = await import("../src/ui/actions");
  model = await import("../src/ui/organizer/model");
  commands = await import("../src/ui/organizer/commands");
  picker = await import("../src/ui/organizer/sourcePicker");
  moveDialog = await import("../src/ui/organizer/MovePagesDialog");
  zones = await import("../src/ui/organizer/dropZone");
  protocol = await import("../src/engine/protocol");
  fields = await import("../src/viewer/fields");
});

/** Open a fresh document of `count` pages; returns its OpenDoc. */
async function openPages(count = 4) {
  openCount = count;
  await actions.openFile(fakeFile("Report.pdf"), { confirmed: true });
  calls.length = 0;
  edits.length = 0;
  state.toasts.value = [];
  model.clearSelection();
  return state.doc.value!;
}

/** Select the pages at `indices` of `d` (as Ctrl+click does, one after the other). */
function selectPages(d: any, indices: number[]) {
  const order = d.pages.map((p: any) => p.key);
  let sel = model.NO_SELECTION;
  for (const i of indices) sel = model.selectAt(order, sel, i, "toggle");
  model.selection.value = sel;
}

const idsOf = () => pages.map((p) => p.id);
const toastTexts = () => state.toasts.value.map((x) => x.text);

beforeEach(() => {
  sourcePages = 3;
  sourcePassword = null;
  sourceDamaged = false;
  state.toasts.value = [];
  state.dialog.value = null;
  state.scanFlow.value = null;
});

// ---------------------------------------------------------------------------------------------
// Pure rules

describe("selection", () => {
  const order = [11, 12, 13, 14, 15];

  it("a plain click selects that page alone; Ctrl/Cmd adds or removes one; each becomes the anchor", () => {
    let sel = model.selectAt(order, model.NO_SELECTION, 1, "only");
    expect([...sel.keys]).toEqual([12]);
    expect(sel.anchor).toBe(12);
    sel = model.selectAt(order, sel, 3, "toggle");
    expect([...sel.keys].sort()).toEqual([12, 14]);
    expect(sel.anchor).toBe(14);
    sel = model.selectAt(order, sel, 1, "toggle");
    expect([...sel.keys]).toEqual([14]);
    sel = model.selectAt(order, sel, 0, "only");
    expect([...sel.keys]).toEqual([11]);
  });

  it("Shift selects the range from the anchor, either way, in place of the rest; the anchor stays", () => {
    let sel = model.selectAt(order, model.NO_SELECTION, 2, "only");
    sel = model.selectAt(order, sel, 4, "range");
    expect([...sel.keys]).toEqual([13, 14, 15]);
    expect(sel.anchor).toBe(13);
    sel = model.selectAt(order, sel, 0, "range");
    expect([...sel.keys]).toEqual([11, 12, 13]);
    expect(sel.anchor).toBe(13);
    // Without an anchor (or one that went with its page): that page alone, as the anchor.
    expect([...model.selectAt(order, model.NO_SELECTION, 3, "range").keys]).toEqual([14]);
    expect([...model.selectAt(order, { keys: new Set([99]), anchor: 99 }, 3, "range").keys]).toEqual([14]);
  });

  it("selects all, says how many, and follows its pages by key (a page that went drops out)", async () => {
    expect([...model.selectAll(order).keys]).toEqual(order);
    expect(model.selectedText(1)).toBe("1 page selected");
    expect(model.selectedText(3)).toBe("3 pages selected");
    const d = await openPages(4);
    selectPages(d, [1, 3]);
    const [, b, , dd] = d.pages;
    await commands.movePagesBefore([dd], 0); // the last page first
    expect(model.selectedIn(d)).toEqual([dd, b]); // in page order, wherever they went
    await commands.deletePages([b]);
    expect(model.selectedIn(d)).toEqual([dd]);
    await actions.undo();
    expect(model.selectedIn(d)).toEqual([dd, b]); // back with its page
  });

  it("never lets every page be deleted", () => {
    expect(model.canDelete(1, 2)).toBe(true);
    expect(model.canDelete(2, 2)).toBe(false);
    expect(model.canDelete(1, 1)).toBe(false);
    expect(model.canDelete(0, 3)).toBe(false);
  });
});

describe("keyboard moves (Alt+↑/↓)", () => {
  it("moves a page one place, a block as one, and nothing past the edges", () => {
    expect(model.nudgeOrder(5, [2], -1)).toEqual([0, 2, 1, 3, 4]);
    expect(model.nudgeOrder(5, [2], 1)).toEqual([0, 1, 3, 2, 4]);
    expect(model.nudgeOrder(5, [2, 3], 1)).toEqual([0, 1, 4, 2, 3]);
    expect(model.nudgeOrder(5, [2, 3], -1)).toEqual([0, 2, 3, 1, 4]);
    expect(model.nudgeOrder(5, [0], -1)).toBeNull();
    expect(model.nudgeOrder(5, [3, 4], 1)).toBeNull();
    expect(model.nudgeOrder(5, [], 1)).toBeNull();
  });

  it("moves the selected pages past their unselected neighbours; one stuck at the top stays", () => {
    expect(model.nudgeOrder(5, [0, 2], -1)).toEqual([0, 2, 1, 3, 4]);
    expect(model.nudgeOrder(5, [1, 3], -1)).toEqual([1, 0, 3, 2, 4]);
    expect(model.nudgeOrder(5, [1, 3], 1)).toEqual([0, 2, 1, 4, 3]);
    expect(model.nudgeOrder(3, [7, -1, 1.5], 1)).toBeNull(); // nothing that is a page
  });
});

describe("where a drop lands", () => {
  const column = [0, 100, 200].map((top) => ({ left: 0, top, width: 150, height: 90 }));
  // Three columns of 100 × 140, a gap of 10; the last row has one tile.
  const grid = [
    { left: 0, top: 0 }, { left: 110, top: 0 }, { left: 220, top: 0 },
    { left: 0, top: 150 },
  ].map((s) => ({ ...s, width: 100, height: 140 }));

  it("in one column: before the first thumbnail whose middle is below the point", () => {
    expect(model.dropGap(column, 50, 10, false)).toBe(0);
    expect(model.dropGap(column, 50, 50, false)).toBe(1);
    expect(model.dropGap(column, 50, 144, false)).toBe(1);
    expect(model.dropGap(column, 50, 146, false)).toBe(2);
    expect(model.dropGap(column, 50, 999, false)).toBe(3);
    expect(model.dropGap(column, 50, -50, false)).toBe(0);
    expect(model.dropGap([], 0, 0, false)).toBe(0);
  });

  it("in a grid: on the point's row, before the first tile whose middle is right of it, else after the row", () => {
    expect(model.dropGap(grid, 10, 10, true)).toBe(0);
    expect(model.dropGap(grid, 170, 10, true)).toBe(2);
    expect(model.dropGap(grid, 300, 70, true)).toBe(3); // after the first row's last tile
    expect(model.dropGap(grid, 10, 160, true)).toBe(3);
    expect(model.dropGap(grid, 90, 200, true)).toBe(4);
    expect(model.dropGap(grid, 10, 900, true)).toBe(3); // below them all: the last row
    expect(model.dropGap(grid, 500, 900, true)).toBe(4);
  });
});

describe("keys", () => {
  const key = (k: string, mods: Partial<Record<"altKey" | "ctrlKey" | "metaKey" | "shiftKey", boolean>> = {}) =>
    ({ key: k, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...mods });

  it("maps the organizer's keys, and leaves the rest alone", () => {
    expect(model.thumbKeyAction(key("ArrowDown"), false)).toEqual({ kind: "focus", move: "down", extend: false });
    expect(model.thumbKeyAction(key("ArrowUp", { shiftKey: true }), false)).toEqual({ kind: "focus", move: "up", extend: true });
    expect(model.thumbKeyAction(key("End", { shiftKey: true }), true)).toEqual({ kind: "focus", move: "last", extend: true });
    expect(model.thumbKeyAction(key("ArrowLeft"), true)).toEqual({ kind: "focus", move: "prev", extend: false });
    expect(model.thumbKeyAction(key("ArrowLeft"), false)).toBeNull(); // no left and right in one column
    expect(model.thumbKeyAction(key("ArrowUp", { altKey: true }), false)).toEqual({ kind: "nudge", dir: -1 });
    expect(model.thumbKeyAction(key("ArrowDown", { altKey: true }), true)).toEqual({ kind: "nudge", dir: 1 });
    expect(model.thumbKeyAction(key("ArrowLeft", { altKey: true }), true)).toBeNull(); // the browser's Back
    expect(model.thumbKeyAction(key("ArrowUp", { altKey: true, shiftKey: true }), false)).toBeNull();
    expect(model.thumbKeyAction(key("Delete"), false)).toEqual({ kind: "delete" });
    expect(model.thumbKeyAction(key("Backspace"), true)).toEqual({ kind: "delete" });
    expect(model.thumbKeyAction(key(" "), false)).toEqual({ kind: "toggle" });
    expect(model.thumbKeyAction(key(" ", { shiftKey: true }), false)).toEqual({ kind: "range" });
    expect(model.thumbKeyAction(key("Enter"), false)).toEqual({ kind: "pick" });
    expect(model.thumbKeyAction(key("a", { ctrlKey: true }), false)).toEqual({ kind: "all" });
    expect(model.thumbKeyAction(key("A", { metaKey: true }), true)).toEqual({ kind: "all" });
    expect(model.thumbKeyAction(key("Escape"), false)).toEqual({ kind: "escape" });
    expect(model.thumbKeyAction(key("z", { ctrlKey: true }), false)).toBeNull(); // undo: the app's
    expect(model.thumbKeyAction(key("ArrowDown", { ctrlKey: true }), false)).toBeNull();
    expect(model.thumbKeyAction(key("Delete", { shiftKey: true }), false)).toBeNull();
    expect(model.thumbKeyAction(key("x"), false)).toBeNull();
  });

  it("moves the focus by rows and columns, never past an edge", () => {
    // Ten thumbnails in rows of four: the last row has two (8 and 9).
    expect(model.nextFocus(5, 9, 4, "down")).toBe(9);
    expect(model.nextFocus(7, 9, 4, "down")).toBe(9); // onto the shorter last row: its last one
    expect(model.nextFocus(9, 9, 4, "down")).toBe(9);
    expect(model.nextFocus(2, 9, 4, "up")).toBe(2);
    expect(model.nextFocus(6, 9, 4, "up")).toBe(2);
    expect(model.nextFocus(0, 9, 4, "prev")).toBe(0);
    expect(model.nextFocus(9, 9, 4, "next")).toBe(9);
    expect(model.nextFocus(4, 9, 4, "first")).toBe(0);
    expect(model.nextFocus(4, 9, 1, "last")).toBe(9);
    expect(model.nextFocus(3, 9, 1, "down")).toBe(4);
  });
});

describe("places between pages", () => {
  it("names them as the page picker and the '+' say them", () => {
    expect(model.gapText(0)).toBe("at the start");
    expect(model.gapText(3)).toBe("after page 3");
    expect(model.insertLabel(0)).toBe("Add pages at the start");
    expect(model.insertLabel(2)).toBe("Add pages after page 2");
  });
});

describe("a turn shown until the new bitmap comes", () => {
  it("adds up the turns made one right after the other, and starts again after anything else", async () => {
    const d = await openPages(3);
    const page = d.pages[0];
    const before = (rev: number) => new Map([[page.key, rev]]);
    model.pageTurns.value = new Map();
    page.rev.value = 5; // a 90° turn from 3: two new revisions (its size, its content)
    model.addTurns([page], 90, before(3));
    expect(model.pageTurns.value.get(page.key)).toEqual({ deg: 90, rev: 5 });
    page.rev.value = 7; // turned again just after: right before it, the page was at the turn's revision
    model.addTurns([page], 90, before(5));
    expect(model.pageTurns.value.get(page.key)).toEqual({ deg: 180, rev: 7 });
    page.rev.value = 10; // something else came in between (an undo: 7 → 8)
    model.addTurns([page], 270, before(8));
    expect(model.pageTurns.value.get(page.key)).toEqual({ deg: 270, rev: 10 });
    page.rev.value = 11; // a 90° turn of a square page: one new revision
    model.addTurns([page], 90, before(10)); // a whole turn: nothing to show
    expect(model.pageTurns.value.has(page.key)).toBe(false);
    model.addTurns([page], 90, before(11));
    expect(model.pageTurns.value.get(page.key)).toEqual({ deg: 90, rev: 11 });
    model.addTurns([page], 90, new Map()); // its revision before not known: a fresh one
    expect(model.pageTurns.value.get(page.key)).toEqual({ deg: 90, rev: 11 });
    model.dropTurn(page.key);
    expect(model.pageTurns.value.has(page.key)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Commands, against the real state and page actions

describe("the action bar's commands", () => {
  it("rotates the selected pages, says so, and shows the turn at once", async () => {
    const d = await openPages(4);
    selectPages(d, [2, 1]);
    const chosen = model.selectedIn(d);
    await commands.rotatePages(chosen, 90);
    expect(calls).toEqual(["editPages:rotate:1,2:90"]);
    expect(model.orgStatus.value?.text).toBe("2 pages rotated.");
    expect(d.pages[1].width).toBe(200); // turned
    for (const p of chosen) expect(model.pageTurns.value.get(p.key)).toEqual({ deg: 90, rev: p.rev.peek() });
    await commands.rotatePages([d.pages[3]], 270);
    expect(model.orgStatus.value?.text).toBe("Page 4 rotated.");
  });

  it("deletes the selection with an Undo in its toast, and never every page", async () => {
    const d = await openPages(3);
    selectPages(d, [0, 1, 2]);
    await commands.deletePages(model.selectedIn(d));
    expect(calls).toEqual([]); // refused before the engine
    expect(toastTexts()).toEqual(["At least one page must stay."]);
    state.toasts.value = [];
    selectPages(d, [0, 2]);
    const before = idsOf();
    await commands.deletePages(model.selectedIn(d));
    expect(calls).toEqual(["editPages:delete:0,2"]);
    expect(idsOf()).toEqual([before[1]]);
    expect(state.toasts.value[0].text).toBe("2 pages deleted.");
    expect(state.toasts.value[0].action?.label).toBe("Undo");
    // The one left can never go.
    await commands.deletePages(d.pages);
    expect(calls).toEqual(["editPages:delete:0,2"]);
  });

  it("duplicates after the last selected page, extracts them, and asks where to move them", async () => {
    const d = await openPages(4);
    selectPages(d, [0, 2]);
    await commands.duplicatePages(model.selectedIn(d));
    expect(calls).toEqual(["editPages:duplicate:0,2@3"]);
    calls.length = 0;
    selectPages(d, [1, 3]);
    await commands.extractPages(model.selectedIn(d));
    expect(calls).toEqual(["extractPages:1,3"]);
    expect(pages).toHaveLength(6); // the document as it was
    commands.askMovePages(model.selectedIn(d));
    expect(state.dialog.value).toEqual({ kind: "move-pages", pages: [1, 3] });
  });

  it("acts on the selection when the page acted on is in it, else on that page alone", async () => {
    const d = await openPages(4);
    selectPages(d, [1, 2]);
    expect(commands.pagesFor(d, d.pages[2])).toEqual([d.pages[1], d.pages[2]]);
    expect(commands.pagesFor(d, d.pages[3])).toEqual([d.pages[3]]);
    model.clearSelection();
    expect(commands.pagesFor(d, d.pages[0])).toEqual([d.pages[0]]);
  });
});

describe("moving pages", () => {
  it("Alt+↑ pressed twice moves a page two places: each move starts from where the one before left it", async () => {
    const d = await openPages(4);
    const [a, b, c, dd] = d.pages;
    const first = commands.nudgePages([c], -1, c);
    const second = commands.nudgePages([c], -1, c);
    await Promise.all([first, second]);
    expect(calls).toEqual(["editPages:move:0,2,1,3", "editPages:move:1,0,2,3"]);
    expect(d.pages).toEqual([c, a, b, dd]);
    expect(state.currentPage.value).toBe(0); // the moved page is the one shown
    expect(model.orgStatus.value?.text).toBe("Page moved: now it's page 1.");
    calls.length = 0;
    await commands.nudgePages([c], -1, c); // at the top already
    expect(calls).toEqual([]);
  });

  it("moves the selection down as a block, the focused page shown", async () => {
    const d = await openPages(5);
    const [a, b, c, dd, e] = d.pages;
    await commands.nudgePages([b, c], 1, c);
    expect(d.pages).toEqual([a, dd, b, c, e]);
    expect(state.currentPage.value).toBe(3);
    expect(model.orgStatus.value?.text).toBe("2 pages moved.");
  });

  it("a drop moves the dragged pages before the place it landed on; where they are already, nothing", async () => {
    const d = await openPages(4);
    const [a, b, c, dd] = d.pages;
    await commands.movePagesBefore([b], 2); // right after itself: no change
    await commands.movePagesBefore([b], 1);
    expect(calls).toEqual([]);
    await commands.movePagesBefore([a, b], 4);
    expect(calls).toEqual(["editPages:move:2,3,0,1"]);
    expect(d.pages).toEqual([c, dd, a, b]);
    expect(model.orgStatus.value?.text).toBe("2 pages moved.");
    await commands.movePagesBefore([b], 0);
    expect(d.pages).toEqual([b, c, dd, a]);
    expect(model.orgStatus.value?.text).toBe("Page moved: now it's page 1.");
  });

  it("the move dialog offers every place, starts at the end, and knows where the pages are already", () => {
    const places = moveDialog.movePositions(3);
    expect(places.map((p) => p.label)).toEqual(["Before page 1", "Before page 2", "Before page 3", "At the end"]);
    expect(places.map((p) => p.before)).toEqual([0, 1, 2, 3]);
    expect(moveDialog.moveIsNoop(4, [1], 1)).toBe(true);
    expect(moveDialog.moveIsNoop(4, [1], 2)).toBe(true);
    expect(moveDialog.moveIsNoop(4, [1], 3)).toBe(false);
    expect(moveDialog.moveIsNoop(4, [1, 2], 1)).toBe(true);
    expect(moveDialog.moveIsNoop(4, [0, 2], 1)).toBe(false); // together, they move
    expect(moveDialog.defaultBefore(4, [1])).toBe(4);
    expect(moveDialog.defaultBefore(4, [2, 3])).toBe(0); // at the end already: the start
  });
});

describe("the '+' menu", () => {
  it("offers a blank page, another PDF and a photo or scan, at its place", async () => {
    const d = await openPages(3);
    const items = commands.insertItems(2);
    expect(items.map((x) => x.label)).toEqual(["Blank page", "From another PDF…", "Photo or scan"]);
    items[0].run(null);
    await vi.waitFor(() => expect(calls).toEqual(["editPages:blank@2"]));
    expect(d.pages).toHaveLength(4);
    expect(state.currentPage.value).toBe(2);
    commands.insertItems(0)[2].run(null);
    expect(state.scanFlow.value).toEqual({ kind: "insert", at: 0 });
  });

  it("'From another PDF…' opens the system picker within the tap, and the page picker with what was chosen", async () => {
    await openPages(3);
    const created = (globalThis as any).__created as { tag: string; clicked?: boolean; accept?: string }[];
    const before = created.length;
    commands.insertItems(1)[1].run(null);
    const input = created[before];
    expect(input.tag).toBe("input");
    expect(input.accept).toBe("application/pdf,.pdf");
    expect(input.clicked).toBe(true);
    // A file dropped between the thumbnails (or chosen in that picker): the page picker opens on it.
    const file = fakeFile("Annex.pdf");
    commands.openInsertFromPdf(3, file);
    expect(state.dialog.value).toEqual({ kind: "insert-from-pdf", at: 3 });
    expect(commands.takePendingSource()).toBe(file);
    expect(commands.takePendingSource()).toBeNull(); // once
    commands.openInsertFromPdf(1);
    expect(commands.takePendingSource()).toBeNull(); // none: the dialog asks for one
  });
});

// ---------------------------------------------------------------------------------------------
// The page picker of "From another PDF…"

describe("the page picker", () => {
  it("opens the PDF, offers all its pages, adds the chosen ones at its place with a bookmark, then closes it", async () => {
    const d = await openPages(3);
    const p = new picker.SourcePicker();
    await p.choose(fakeFile("Annex.pdf"));
    const s = p.state.value as any;
    expect(s.stage).toBe("pages");
    expect(s.pages).toHaveLength(3);
    expect([...s.chosen]).toEqual([0, 1, 2]);
    expect(p.chosenPages()).toBe("all");
    p.toggle(1);
    expect(p.chosenPages()).toEqual([0, 2]);
    p.setAll(false);
    expect(p.chosenPages()).toBeNull();
    expect(await p.add(1)).toBe(false); // nothing chosen
    p.setAll(true);
    p.toggle(0);
    await p.render(2, 0.5);
    expect(await p.add(1)).toBe(true);
    const source = s.source;
    expect(calls).toEqual(["openSource", `renderSource:${source}:2`, `editPages:insert:${source}:1,2@1`, `closeSource:${source}`]);
    expect(edits[0].title).toBe("Annex");
    expect(d.pages).toHaveLength(5);
    expect(toastTexts()).toContain("2 pages added.");
    p.dispose(); // the dialog closing afterwards: nothing more to close
    expect(calls.filter((c) => c.startsWith("closeSource"))).toHaveLength(1);
  });

  it("asks for the password inline, says when it is wrong, then opens", async () => {
    await openPages(2);
    sourcePassword = "secret";
    const p = new picker.SourcePicker();
    await p.choose(fakeFile("Locked.pdf"));
    expect(p.state.value).toEqual({ stage: "password", name: "Locked.pdf", wrong: false });
    await p.submitPassword("nope");
    expect(p.state.value).toEqual({ stage: "password", name: "Locked.pdf", wrong: true });
    await p.submitPassword("secret");
    expect(p.state.value.stage).toBe("pages");
    expect(calls).toEqual(["openSource", "openSource:nope", "openSource:secret"]);
    p.dispose();
  });

  it("says when the file is too big, damaged or not a PDF, without opening what it need not", async () => {
    await openPages(2);
    const p = new picker.SourcePicker();
    await p.choose(fakeFile("Huge.pdf", { size: protocol.MAX_SOURCE_BYTES + 1 }));
    expect(p.state.value).toEqual({ stage: "error", name: "Huge.pdf", reason: "too-big" });
    await p.choose(fakeFile("photo.jpg", { type: "image/jpeg" }));
    expect(p.state.value).toEqual({ stage: "error", name: "photo.jpg", reason: "not-pdf" });
    expect(calls).toEqual([]);
    sourceDamaged = true;
    await p.choose(fakeFile("Broken.pdf"));
    expect(p.state.value).toEqual({ stage: "error", name: "Broken.pdf", reason: "damaged" });
    p.dispose();
  });

  it("closes the other PDF with the dialog, when another file is chosen, and when it opens after the dialog closed", async () => {
    await openPages(2);
    const p = new picker.SourcePicker();
    await p.choose(fakeFile("One.pdf"));
    const one = (p.state.value as any).source;
    await p.choose(fakeFile("Two.pdf"));
    const two = (p.state.value as any).source;
    expect(calls).toEqual(["openSource", `closeSource:${one}`, "openSource"]);
    p.dispose();
    expect(calls.at(-1)).toBe(`closeSource:${two}`);
    expect(openSources.size).toBe(0);

    calls.length = 0;
    const late = new picker.SourcePicker();
    const release = hold("openSource");
    const opening = late.choose(fakeFile("Slow.pdf"));
    (await release)();
    late.dispose(); // the dialog closed while it was opening
    await opening;
    await vi.waitFor(() => expect(openSources.size).toBe(0));
    expect(late.state.value.stage).toBe("loading"); // nothing shown for it any more
  });

  it("names the bookmark after the file", () => {
    expect(picker.bookmarkTitle("Annex 2.pdf")).toBe("Annex 2");
    expect(picker.bookmarkTitle("scan.PDF")).toBe("scan");
    expect(picker.bookmarkTitle(".pdf")).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Page operations that land while something holds a page or a place (r4 fix round 1)

describe("a page operation landing meanwhile", () => {
  const errors = () => state.toasts.value.filter((x) => x.kind === "error").map((x) => x.text);

  it("P18: Alt+↓ pressed while a delete is in the engine waits for it, then moves the page from where it is", async () => {
    const d = await openPages(5);
    const [a, b, c, dd, e] = d.pages;
    const release = hold("editPages");
    const deleting = commands.deletePages([a]);
    const go = await release; // the delete is in the engine now
    const nudge = commands.nudgePages([dd], 1, dd);
    go();
    await Promise.all([deleting, nudge]);
    expect(errors()).toEqual([]);
    expect(d.pages).toEqual([b, c, e, dd]);
    expect(calls).toEqual(["editPages:delete:0", "editPages:move:0,1,3,2"]);
  });

  it("P18: Alt+↓ pressed right after Delete (the delete not yet in the engine) moves the page once it landed", async () => {
    const d = await openPages(5);
    const [a, b, c, dd, e] = d.pages;
    const deleting = commands.deletePages([a]);
    const nudge = commands.nudgePages([dd], 1, dd);
    await Promise.all([deleting, nudge]);
    expect(errors()).toEqual([]);
    expect(d.pages).toEqual([b, c, e, dd]);
  });

  it("P18: Delete and the action bar's commands while a page operation is in the engine follow their pages, without an error", async () => {
    const d = await openPages(6);
    const [a, b, c, dd, e, f] = d.pages;
    const release = hold("editPages");
    const deleting = commands.deletePages([a]);
    const go = await release;
    const rest = [
      commands.rotatePages([c], 90),
      commands.duplicatePages([dd]),
      commands.deletePages([b]),
      commands.nudgePages([f], -1, f),
      commands.movePagesBefore([e], 0),
    ];
    go();
    await Promise.all([deleting, ...rest]);
    expect(errors()).toEqual([]);
    // Each on its pages as they are when it runs, in the order asked (fix round 2: the keyboard
    // move too, one place up from where f is by then, before the drop asked after it).
    expect(calls).toEqual([
      "editPages:delete:0", "editPages:rotate:1:90", "editPages:duplicate:2@3", "editPages:delete:0",
      "editPages:move:0,1,2,4,3", "editPages:move:4,0,1,2,3",
    ]);
    expect(d.pages.slice(0, 3)).toEqual([e, c, dd]);
    expect(d.pages[4]).toBe(f); // after the copy of dd
    expect(d.pages).toHaveLength(5);
    expect(state.currentPage.value).toBe(0); // the dropped page, last to land
  });

  it("P18: Alt+↑ pressed while an undo of an insert is on its way moves the page from where the undo left it", async () => {
    const d = await openPages(3);
    const [a, b, c] = d.pages;
    await commands.insertBlankAt(1);
    calls.length = 0;
    const release = hold("undo");
    const undoing = actions.undo();
    const go = await release;
    const nudge = commands.nudgePages([c], -1, c);
    go();
    await Promise.all([undoing, nudge]);
    expect(errors()).toEqual([]);
    expect(d.pages).toEqual([a, c, b]);
    expect(calls).toEqual(["undo", "editPages:move:0,2,1"]);
    expect(state.currentPage.value).toBe(1);
  });

  /**
   * Hold the engine's queue as a download being written does; returns the function that lets it
   * go (once, whenever it is called: a failing test must not hold the queue for the next one).
   */
  function holdQueue(): () => void {
    let free: (() => void) | null = null;
    let freed = false;
    void actions.exclusive("save", () => new Promise<void>((r) => {
      free = r;
      if (freed) r();
    }));
    return () => {
      freed = true;
      free?.();
    };
  }

  it("P18: Alt+↓ then Ctrl+Z behind a download: the move runs first, then the undo takes it back", async () => {
    const d = await openPages(4);
    const [a, b, c, dd] = d.pages;
    await commands.insertBlankAt(4); // an edit before them, which the undo must leave alone
    const blank = d.pages[4];
    calls.length = 0;
    const free = holdQueue();
    try {
      const nudge = commands.nudgePages([a], 1, a);
      const undoing = actions.undo();
      await new Promise((r) => setTimeout(r, 0));
      free();
      await Promise.all([nudge, undoing]);
    } finally {
      free();
    }
    expect(errors()).toEqual([]);
    expect(calls).toEqual(["editPages:move:1,0,2,3,4", "undo"]);
    expect(d.pages).toEqual([a, b, c, dd, blank]);
    expect(state.history.value).toMatchObject({ editCount: 1, canRedo: true }); // the move, to redo
    await actions.redo();
    expect(d.pages).toEqual([b, a, c, dd, blank]);
  });

  it("P18: the same while a page operation runs in the engine: it, the move, then the undo of the move", async () => {
    const d = await openPages(4);
    const [a, b, c, dd] = d.pages;
    const release = hold("editPages");
    const adding = commands.insertBlankAt(4);
    const go = await release; // the blank page is in the engine
    const nudge = commands.nudgePages([a], 1, a);
    const undoing = actions.undo();
    await new Promise((r) => setTimeout(r, 0));
    go();
    await Promise.all([adding, nudge, undoing]);
    expect(errors()).toEqual([]);
    expect(calls).toEqual(["editPages:blank@4", "editPages:move:1,0,2,3,4", "undo"]);
    expect(d.pages.slice(0, 4)).toEqual([a, b, c, dd]);
    expect(d.pages).toHaveLength(5); // the blank page stays
    expect(state.history.value).toMatchObject({ editCount: 1, canRedo: true });
  });

  it("P18: a keyboard move worked out in the queue does nothing when its page cannot go further by then", async () => {
    const d = await openPages(3);
    const [a, b] = d.pages;
    const free = holdQueue();
    try {
      const first = commands.nudgePages([b], -1, b); // b to the top…
      const second = commands.nudgePages([b], -1, b); // …and then it is there already: nothing more
      await new Promise((r) => setTimeout(r, 0));
      free();
      await Promise.all([first, second]);
    } finally {
      free();
    }
    expect(calls).toEqual(["editPages:move:1,0,2"]);
    expect(d.pages.slice(0, 2)).toEqual([b, a]);
    expect(errors()).toEqual([]);
    expect(model.orgStatus.value?.text).toBe("Page moved: now it's page 1.");
  });

  it("P16, P12: the move dialog holds its pages: an insert landing while it is open moves them, and the dialog follows", async () => {
    const d = await openPages(5);
    const [a, b, c, dd, e] = d.pages;
    const release = hold("editPages");
    const blank = commands.insertBlankAt(0);
    const go = await release; // the insert is in the engine: the dialog opens meanwhile
    commands.askMovePages([c]);
    const asked = state.dialog.value as any;
    expect(asked).toEqual({ kind: "move-pages", pages: [2] });
    go();
    await blank;
    expect(c.index).toBe(3);
    expect(commands.movingPages(asked)).toEqual([c]); // not the page now at index 2 (b)
    // "At the end", as the dialog's submit runs it: c goes, nothing else.
    await commands.movePagesBefore(commands.movingPages(asked), d.pages.length);
    expect(d.pages.slice(1)).toEqual([a, b, dd, e, c]);
    // Its pages gone (deleted, or another document): nothing left to move.
    await commands.deletePages([c]);
    expect(commands.movingPages(asked)).toEqual([]);
  });

  it("P16: the move dialog's place is held by the page it is before", async () => {
    const d = await openPages(4);
    const [a, b, c, dd] = d.pages;
    const before = model.placeOfGap(d.pages, 2); // "Before page 3" (c)
    const end = model.placeOfGap(d.pages, 4); // "At the end"
    await commands.deletePages([a]);
    expect(model.gapOfPlace(d.pages, before)).toBe(1); // still before c
    expect(model.gapOfPlace(d.pages, end)).toBe(3);
    await commands.insertBlankAt(0);
    expect(model.gapOfPlace(d.pages, before)).toBe(2);
    expect(model.gapOfPlace(d.pages, end)).toBe(4);
    await commands.deletePages([c]); // its page went: where it was, within the pages there are
    expect(model.gapOfPlace(d.pages, before)).toBe(2);
    expect(d.pages.slice(1)).toEqual([b, dd]);
    expect(model.gapOfPlace(d.pages, { before: c, at: 9 })).toBe(3);
  });

  it("P12: the page picker's place follows a page operation that lands while it is open", async () => {
    const d = await openPages(4);
    const [, , c] = d.pages;
    const release = hold("editPages");
    const deleting = commands.deletePages([d.pages[0]]);
    const go = await release;
    commands.openInsertFromPdf(2, fakeFile("Annex.pdf")); // "after page 2": before c
    const asked = state.dialog.value as any;
    expect(asked).toEqual({ kind: "insert-from-pdf", at: 2 });
    expect(commands.insertGap(asked)).toBe(2);
    go();
    await deleting;
    expect(commands.insertGap(asked)).toBe(1); // still before c: "after page 1" now
    expect(model.gapText(commands.insertGap(asked))).toBe("after page 1");
    // "Aggiungi" adds them there.
    commands.takePendingSource();
    const p = new picker.SourcePicker();
    await p.choose(fakeFile("Annex.pdf"));
    calls.length = 0;
    await p.add(commands.insertGap(asked));
    expect(calls[0]).toMatch(/^editPages:insert:\d+:all@1$/);
    expect(d.pages[4]).toBe(c);
    // A place past the end (held from a longer document): the end, never past it.
    expect(commands.insertGap({ kind: "insert-from-pdf", at: 99 })).toBe(d.pages.length);
  });

  it("P17: a second PDF chosen before the first one's insert reached the engine opens after it", async () => {
    const d = await openPages(3);
    const first = new picker.SourcePicker();
    await first.choose(fakeFile("First.pdf"));
    calls.length = 0;
    const release = hold("editPages");
    const blank = commands.insertBlankAt(0);
    const go = await release; // a page operation in the engine: the insert waits behind it
    const adding = first.add(1);
    const second = new picker.SourcePicker();
    const opening = second.choose(fakeFile("Second.pdf"));
    await Promise.resolve();
    expect(second.state.value).toEqual({ stage: "loading", name: "Second.pdf" }); // waiting its turn
    go();
    await Promise.all([blank, adding, opening]);
    expect(errors()).toEqual([]);
    expect(d.pages).toHaveLength(3 + 1 + 3);
    const one = calls.findIndex((x) => x.startsWith("closeSource:"));
    expect(calls.slice(0, 2)).toEqual(["editPages:blank@0", expect.stringMatching(/^editPages:insert:\d+:all@2$/)]); // (after the page it was after)
    expect(calls.indexOf("openSource")).toBeGreaterThan(one); // the second one opened once the first was done with
    expect(second.state.value.stage).toBe("pages");
    second.dispose();
    expect(openSources.size).toBe(0);
  });

  it("P17: a picker closed while it waits for an insert never opens its PDF", async () => {
    await openPages(3);
    const first = new picker.SourcePicker();
    await first.choose(fakeFile("First.pdf"));
    calls.length = 0;
    const release = hold("editPages");
    const blank = commands.insertBlankAt(0);
    const go = await release;
    const adding = first.add(0);
    const second = new picker.SourcePicker();
    const opening = second.choose(fakeFile("Second.pdf"));
    second.dispose(); // the dialog closed before it was its turn
    go();
    await Promise.all([blank, adding, opening]);
    expect(calls.filter((x) => x.startsWith("openSource"))).toEqual([]);
    expect(openSources.size).toBe(0);
  });
});

describe("the '+' between pages after a page operation (P15)", () => {
  const column = [0, 100, 200].map((top) => ({ left: 0, top, width: 150, height: 90 }));
  const grid = [{ left: 0, top: 0 }, { left: 110, top: 0 }, { left: 0, top: 150 }].map((s) => ({ ...s, width: 100, height: 140 }));

  it("finds the line between two thumbnails, before the first and after the last", () => {
    expect(model.gapLine(column, 0, false)).toEqual({ x: 75, y: -2, length: 150 });
    expect(model.gapLine(column, 1, false)).toEqual({ x: 75, y: 95, length: 150 });
    expect(model.gapLine(column, 3, false)).toEqual({ x: 75, y: 292, length: 150 });
    expect(model.gapLine(grid, 1, true)).toEqual({ x: 108, y: 70, length: 140 });
    expect(model.gapLine(grid, 3, true)).toEqual({ x: 102, y: 220, length: 140 });
    expect(model.gapLine([], 0, false)).toBeNull();
  });

  it("a place held from before a delete (past the end now) is the end, never a box that is not there", () => {
    // The mouse was over the lower half of the last of four thumbnails (place 4); one was deleted.
    expect(() => model.gapLine(column, 4, false)).not.toThrow();
    expect(model.gapLine(column, 4, false)).toEqual(model.gapLine(column, 3, false));
    expect(model.gapLine(grid, 7, true)).toEqual(model.gapLine(grid, 3, true));
    expect(model.gapLine(column, -2, false)).toEqual(model.gapLine(column, 0, false));
    // Only the boxes around the place measured (slotsAround): the line, or null when one it needs is missing.
    const sparse: (typeof column[number] | undefined)[] = new Array(3);
    sparse[0] = column[0];
    sparse[2] = column[2];
    expect(model.gapLine(sparse, 1, false)).toBeNull();
    expect(model.gapLine(sparse, 3, false)).toEqual({ x: 75, y: 292, length: 150 });
    expect(model.gapLine(sparse, 9, false)).toEqual({ x: 75, y: 292, length: 150 });
  });

  it("clamps a place to the pages there are now", () => {
    expect(model.clampGap(9, 8)).toBe(8);
    expect(model.clampGap(-1, 8)).toBe(0);
    expect(model.clampGap(2.7, 8)).toBe(2);
    expect(model.clampGap(Number.NaN, 8)).toBe(8);
    expect(model.clampGap(3, 0)).toBe(0);
  });

  it("an open menu's place follows its page through a delete and an undo", async () => {
    const d = await openPages(5);
    const [, b, , dd] = d.pages;
    const place = model.placeOfGap(d.pages, 3); // the "+" before page 4 (dd)
    expect(place.before).toBe(dd);
    await commands.deletePages([b]);
    expect(model.gapOfPlace(d.pages, place)).toBe(2);
    expect(model.insertLabel(model.gapOfPlace(d.pages, place))).toBe("Add pages after page 2");
    await actions.undo();
    expect(model.gapOfPlace(d.pages, place)).toBe(3);
    // The menu's "Blank page" at its place as it is now.
    commands.insertItems(model.gapOfPlace(d.pages, place))[0].run(null);
    await vi.waitFor(() => expect(calls.at(-1)).toBe("editPages:blank@3"));
    expect(d.pages[4]).toBe(dd);
  });
});

// ---------------------------------------------------------------------------------------------
// Fix round 3: a move that finds nothing to do touches nothing; two quick turns add up

describe("a move that finds nothing to do (fix round 3)", () => {
  /** What Compila e firma may have open on the pages: a signature waiting to be placed, an image selected, what is remembered. */
  async function openWork(d: any) {
    await actions.setTool("fill");
    const sig = { id: "s", kind: "signature", png: new Blob([]), width: 1, height: 1, description: "", source: "type", savedAt: null } as any;
    state.fillTool.value = "signature";
    state.pendingPlacement.value = sig;
    state.selectedImage.value = { pageIndex: 1, index: 0 };
    state.focusRequest.value = { pageIndex: 1, kind: "image", id: 0 };
    state.editingDecorations.value = { pageIndex: 0, lineIndex: 0, rev: 0, info: {} as any };
    fields.lastFieldFocus.value = { docId: d.id, pageIndex: 1 };
    return {
      sig,
      kept() {
        expect(state.pendingPlacement.value).toBe(sig);
        expect(state.fillTool.value).toBe("signature");
        expect(state.selectedImage.value).toEqual({ pageIndex: 1, index: 0 });
        expect(state.focusRequest.value).toEqual({ pageIndex: 1, kind: "image", id: 0 });
        expect(state.editingDecorations.value).not.toBeNull();
        expect(fields.lastFieldFocus.value).toEqual({ docId: d.id, pageIndex: 1 });
      },
    };
  }

  function holdQueue(): () => void {
    let free: (() => void) | null = null;
    let freed = false;
    void actions.exclusive("save", () => new Promise<void>((r) => {
      free = r;
      if (freed) r();
    }));
    return () => {
      freed = true;
      free?.();
    };
  }

  it("Alt+↑ on the first page, Alt+↓ on the last, a block at the top: the engine is not called and nothing open closes", async () => {
    const d = await openPages(4);
    const [a, b, , dd] = d.pages;
    const open = await openWork(d);
    await commands.nudgePages([a], -1, a);
    open.kept();
    await commands.nudgePages([dd], 1, dd);
    open.kept();
    await commands.nudgePages([a, b], -1, b);
    open.kept();
    expect(calls).toEqual([]);
    expect(actions.pagesChanging()).toBe(false);
    // A drop where the pages are already: the same.
    await commands.movePagesBefore([b], 2);
    open.kept();
    expect(calls).toEqual([]);
    // One that moves a page closes them, as every page operation does.
    await commands.nudgePages([b], -1, b);
    expect(calls).toEqual(["editPages:move:1,0,2,3"]);
    expect(state.pendingPlacement.value).toBeNull();
    expect(state.fillTool.value).toBe("text");
    expect(state.selectedImage.value).toBeNull();
    expect(fields.lastFieldFocus.value).toBeNull();
  });

  it("behind a download (nothing on its way that changes the pages) it is known at once, without waiting for it", async () => {
    const d = await openPages(3);
    const [a] = d.pages;
    const open = await openWork(d);
    const free = holdQueue();
    let nudge: Promise<void> | null = null;
    try {
      nudge = commands.nudgePages([a], -1, a);
      const answer = await Promise.race([nudge.then(() => "done"), new Promise((r) => setTimeout(() => r("waiting"), 20))]);
      expect(answer).toBe("done"); // with the download still being written
      open.kept();
      expect(state.busy.value).toBe("save");
    } finally {
      free();
      await nudge;
    }
    expect(calls).toEqual([]);
  });

  it("an undo pressed after it takes back the edit before it, at once", async () => {
    const d = await openPages(3);
    const [a] = d.pages;
    await commands.insertBlankAt(3);
    calls.length = 0;
    await commands.nudgePages([a], -1, a);
    await actions.undo();
    expect(calls).toEqual(["undo"]);
    expect(d.pages).toHaveLength(3);
  });
});

describe("two quick turns (fix round 3)", () => {
  /** The engine answers after a macrotask, as the worker does (a message): what was asked lands one step at a time. */
  function replyLater() {
    const original = engineImpl.editPages;
    engineImpl.editPages = (edit: any) => new Promise((done) => setTimeout(() => done(original(edit)), 0));
    return () => {
      engineImpl.editPages = original;
    };
  }

  it("two 90° turns one right after the other show the old thumbnail turned 180°, until the new bitmap", async () => {
    const d = await openPages(3);
    const [a] = d.pages;
    model.pageTurns.value = new Map();
    await commands.rotatePages([a], 90);
    expect(model.pageTurns.value.get(a.key)).toEqual({ deg: 90, rev: a.rev.peek() });
    await commands.rotatePages([a], 90);
    expect(model.pageTurns.value.get(a.key)).toEqual({ deg: 180, rev: a.rev.peek() });
    await commands.rotatePages([a], 90);
    expect(model.pageTurns.value.get(a.key)).toEqual({ deg: 270, rev: a.rev.peek() });
    await commands.rotatePages([a], 90); // a whole turn: the old bitmap is right as it is
    expect(model.pageTurns.value.has(a.key)).toBe(false);
    await commands.rotatePages([a], 90);
    model.dropTurn(a.key); // the new bitmap came: the next turn starts from it
    await commands.rotatePages([a], 90);
    expect(model.pageTurns.value.get(a.key)).toEqual({ deg: 90, rev: a.rev.peek() });
  });

  for (const later of [true, false]) {
    it(`the same pressed twice before the first one lands, the selection too (the engine answering ${later ? "after a message" : "at once"})`, async () => {
      const back = later ? replyLater() : () => undefined;
      try {
        const d = await openPages(4);
        const [a, b] = d.pages;
        model.pageTurns.value = new Map();
        await Promise.all([commands.rotatePages([a, b], 90), commands.rotatePages([a, b], 90)]);
        expect(calls).toEqual(["editPages:rotate:0,1:90", "editPages:rotate:0,1:90"]);
        for (const p of [a, b]) expect(model.pageTurns.value.get(p.key)).toEqual({ deg: 180, rev: p.rev.peek() });
        // The first one held in the engine while the second is asked.
        model.pageTurns.value = new Map();
        let release = hold("editPages");
        let first = commands.rotatePages([a], 90);
        let go = await release;
        let second = commands.rotatePages([a], 90);
        go();
        await Promise.all([first, second]);
        expect(model.pageTurns.value.get(a.key)).toEqual({ deg: 180, rev: a.rev.peek() });
        model.pageTurns.value = new Map();
        release = hold("editPages");
        first = commands.rotatePages([a], 90);
        go = await release;
        second = commands.rotatePages([a], 270);
        go();
        await Promise.all([first, second]);
        expect(model.pageTurns.value.has(a.key)).toBe(false); // 90 + 270: as drawn
      } finally {
        back();
      }
    });
  }

  it("a turn of another page in between leaves it alone; after an undo of the turn, the next one is only its own", async () => {
    const d = await openPages(3);
    const [a, b, c] = d.pages;
    model.pageTurns.value = new Map();
    await commands.rotatePages([a], 90);
    await commands.rotatePages([b], 90);
    await commands.rotatePages([a], 90);
    expect(model.pageTurns.value.get(a.key)).toEqual({ deg: 180, rev: a.rev.peek() });
    expect(model.pageTurns.value.get(b.key)).toEqual({ deg: 90, rev: b.rev.peek() });
    // Turned, then undone: the page is back as the old bitmap shows it, and the turn after the
    // undo is only its own (the undo's revision is not the turn's).
    await commands.rotatePages([c], 90);
    await actions.undo();
    await commands.rotatePages([c], 90);
    expect(model.pageTurns.value.get(c.key)).toEqual({ deg: 90, rev: c.rev.peek() });
  });
});

// ---------------------------------------------------------------------------------------------
// A PDF file dragged in from outside

describe("drop zones", () => {
  it("finds the zone a dragged file is over, while it takes files", () => {
    const inside = { nodeType: 1 };
    const outside = { nodeType: 1 };
    let accepting = true;
    const zone = {
      element: { contains: (n: unknown) => n === inside } as unknown as Element,
      accepts: () => accepting,
      hover: () => undefined,
      drop: () => undefined,
    };
    const stop = zones.registerPdfDropZone(zone);
    expect(zones.pdfDropZoneAt(inside as unknown as EventTarget)).toBe(zone);
    expect(zones.pdfDropZoneAt(outside as unknown as EventTarget)).toBeNull();
    expect(zones.pdfDropZoneAt(null)).toBeNull();
    accepting = false; // editing has stopped
    expect(zones.pdfDropZoneAt(inside as unknown as EventTarget)).toBeNull();
    accepting = true;
    stop();
    expect(zones.pdfDropZoneAt(inside as unknown as EventTarget)).toBeNull();
  });
});
