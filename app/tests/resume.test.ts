// Riprendi's store (src/platform/resume.ts), against the in-memory IndexedDB of
// tests/stubs/fake-indexeddb.ts: the document and the unfinished scan saved, summarised without
// their bytes, loaded and forgotten; large binaries kept once by their content (the original is
// not written again after every edit, and what is no longer used goes); storage missing, blocked,
// full or stalled (false or null, nothing thrown, the previous record still readable); records of
// another format or damaged; calls kept in order; whether the document exists nowhere else; the
// document an insert scan's pages are for (its name, in the summary too; none for a new PDF); two
// tabs (a forget "own" leaves another tab's record, a record loaded becomes this tab's; a forget
// naming a record's stamp removes that one only, never a later save) and what changed
// (resumeChanged, also told to and by the other tabs). A few checks of the fake itself at the end,
// for the behaviours the store relies on.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  forgetScan, forgetSession, loadScan, loadSession, resumeAvailable, resumeChanged, saveScan, saveSession, scanSummary,
  sessionSummary, type SavedScan, type SavedScanPage, type SavedSession,
} from "../src/platform/resume";
import { fakeIndexedDB, type FakeIndexedDB } from "./stubs/fake-indexeddb";

const DB = "pdf-editor-resume";
/** Above the store's blob threshold (64 KiB), and well below it. */
const BIG = 200_000;
const SMALL = 1000;

let fake: FakeIndexedDB;

beforeEach(() => {
  fake = fakeIndexedDB();
  vi.stubGlobal("indexedDB", fake.factory);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** `n` bytes of a pattern of its own for each `seed`. */
function bytes(n: number, seed: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + seed * 97 + (i >> 8)) & 255;
  return b;
}
const buffer = (n: number, seed: number) => bytes(n, seed).buffer;
const same = (a: ArrayBuffer | Uint8Array, b: ArrayBuffer | Uint8Array) =>
  Buffer.from(a instanceof ArrayBuffer ? new Uint8Array(a) : a).equals(Buffer.from(b instanceof ArrayBuffer ? new Uint8Array(b) : b));

/**
 * `value` with every binary replaced by its type, length and hash, to compare structures quickly
 * (vitest compares a 200 KB typed array element by element, in seconds).
 */
function shape(value: unknown): unknown {
  const label = (kind: string, b: Uint8Array) => `${kind}(${b.byteLength}) ${createHash("sha1").update(b).digest("hex")}`;
  if (value instanceof ArrayBuffer) return label("ArrayBuffer", new Uint8Array(value));
  if (value instanceof Uint8Array) return label("Uint8Array", value);
  if (value instanceof Map) return new Map([...value].map(([k, v]) => [k, shape(v)]));
  if (Array.isArray(value)) return value.map(shape);
  if (typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    const out = {};
    for (const k of Object.keys(value)) Object.defineProperty(out, k, { value: shape((value as any)[k]), enumerable: true, writable: true, configurable: true });
    return out;
  }
  return value;
}

/** An edit log as the engine might export it: plain data with pictures inside. */
function log(...pictures: number[]) {
  return [
    { kind: "text", pageIndex: 0, lineIndex: 3, text: "Mario Rossi" },
    ...pictures.map((seed) => ({ kind: "addImage", pages: [0], picture: { bytes: bytes(BIG, seed), orientation: 1, width: 640, height: 480 } })),
  ];
}

function session(extra: Partial<SavedSession> = {}): SavedSession {
  return {
    fileName: "contratto.pdf", savedAt: 1, editCount: 2, pageCount: 3, original: buffer(BIG, 1), log: log(2),
    view: { page: 1, zoom: 1.5, fit: false }, ...extra,
  };
}

function page(seed: number, extra: Partial<SavedScanPage> = {}): SavedScanPage {
  return { bytes: buffer(BIG, seed), width: 1654, height: 2339, dpi: 200, preview: buffer(SMALL, seed), ...extra };
}

function scan(pages: SavedScanPage[], target: SavedScan["target"] = { kind: "new" }): SavedScan {
  return { target, savedAt: 1, pages };
}

const keys = (store: "session" | "scan") => fake.keys(DB, store).map(String);
const blobKeys = (store: "session" | "scan") => keys(store).filter((k) => k.startsWith("blob:"));
/** The blobs written by what ran since `from` (an index in fake.writes). */
const blobPuts = (from: number) => fake.writes.slice(from).filter((w) => w.op === "put" && String(w.key).startsWith("blob:"));

describe("Riprendi store: storage missing or failing", () => {
  async function nothingWorks(available: boolean) {
    expect(await resumeAvailable()).toBe(available);
    expect(await saveSession(session())).toBe(false);
    expect(await sessionSummary()).toBeNull();
    expect(await loadSession()).toBeNull();
    expect(await forgetSession()).toBe(false);
    expect(await saveScan(scan([page(1)]))).toBe(false);
    expect(await scanSummary()).toBeNull();
    expect(await loadScan()).toBeNull();
    expect(await forgetScan()).toBe(false);
  }

  it("no IndexedDB: unavailable, and nothing throws", async () => {
    vi.stubGlobal("indexedDB", undefined);
    await nothingWorks(false);
  });

  it("reading indexedDB itself throws (blocked site data): unavailable", async () => {
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, get() { throw new DOMException("denied", "SecurityError"); } });
    try {
      await nothingWorks(false);
    } finally {
      delete (globalThis as any).indexedDB;
    }
  });

  it("open() throws, or the open fails: unavailable", async () => {
    fake.open = "throw";
    await nothingWorks(false);
    fake.open = "error";
    await nothingWorks(false);
  });

  it("transactions that cannot start: the database opens, but nothing is kept", async () => {
    fake.transactions = "throw";
    await nothingWorks(true);
    expect(fake.connections.every((c) => c.closed)).toBe(true);
  });

  it("an open that never answers counts as unavailable after a few seconds", async () => {
    vi.useFakeTimers();
    fake.open = "hang";
    const available = resumeAvailable();
    const saved = saveSession(session({ original: buffer(SMALL, 1), log: [] })); // nothing to hash: straight to the open
    const summary = sessionSummary(); // after the save (the same queue)
    await vi.advanceTimersByTimeAsync(3000);
    expect(await available).toBe(false);
    expect(await saved).toBe(false);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await summary).toBeNull();
  });

  it("a newer app holding the database at version 2: refused cleanly (VersionError), nothing thrown", async () => {
    await new Promise<void>((resolve) => {
      const req = fake.factory.open(DB, 2);
      req.onupgradeneeded = () => req.result.createObjectStore("session");
      req.onsuccess = () => {
        req.result.close();
        resolve();
      };
    });
    await nothingWorks(false);
    expect(fake.databases.get(DB)?.version).toBe(2);
  });

  it("a stalled write counts as failed after its time limit, is aborted, and the previous record stays", async () => {
    expect(await saveSession(session())).toBe(true);
    const before = keys("session");
    fake.transactions = "hang";
    vi.useFakeTimers();
    const saved = saveSession(session({ fileName: "altro.pdf", original: buffer(SMALL, 9), log: [] }));
    await fake.settle(); // opened, and its transaction started and stalled
    expect(fake.connections.at(-1)?.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await saved).toBe(false);
    vi.useRealTimers();
    fake.transactions = "ok";
    expect(await sessionSummary()).toMatchObject({ fileName: "contratto.pdf" });
    expect(keys("session")).toEqual(before);
    expect(same((await loadSession())!.original, buffer(BIG, 1))).toBe(true);
  });

  it("a save over the quota keeps nothing and leaves the previous record readable", async () => {
    expect(await saveSession(session())).toBe(true);
    const before = keys("session");
    fake.quota = fake.usage(DB) + SMALL;
    expect(await saveSession(session({ fileName: "grande.pdf", original: buffer(BIG, 5) }))).toBe(false);
    expect(keys("session")).toEqual(before);
    expect(await sessionSummary()).toMatchObject({ fileName: "contratto.pdf" });
    const loaded = await loadSession();
    expect(same(loaded!.original, buffer(BIG, 1))).toBe(true);
    expect(shape(loaded!.log)).toStrictEqual(shape(log(2)));
    // Nothing kept before and the first save too big: nothing at all.
    await forgetSession();
    fake.quota = BIG;
    expect(await saveSession(session())).toBe(false);
    expect(keys("session")).toEqual([]);
    expect(await sessionSummary()).toBeNull();
  });

  it("a request failing in the middle of a save (the summary) leaves the previous record as it was", async () => {
    expect(await saveSession(session())).toBe(true);
    const before = keys("session");
    fake.fail = (r) => (r.op === "put" && r.key === "summary" ? new DOMException("Disk error", "UnknownError") : null);
    expect(await saveSession(session({ fileName: "altro.pdf", original: buffer(BIG, 7), log: log(8) }))).toBe(false);
    fake.fail = null;
    expect(keys("session")).toEqual(before); // no blob of the failed save left behind
    const loaded = await loadSession();
    expect(loaded).toMatchObject({ fileName: "contratto.pdf", editCount: 2, pageCount: 3 });
    expect(same(loaded!.original, buffer(BIG, 1))).toBe(true);
  });

  it("a log that cannot be stored (a function inside): false, the previous record stays", async () => {
    expect(await saveSession(session())).toBe(true);
    expect(await saveSession(session({ fileName: "altro.pdf", log: [{ kind: "text", run: () => 1 }] }))).toBe(false);
    expect(await sessionSummary()).toMatchObject({ fileName: "contratto.pdf" });
    expect(shape((await loadSession())!.log)).toStrictEqual(shape(log(2)));
  });
});

describe("Riprendi store: the document", () => {
  it("save, summary, load, forget; savedAt from Date.now()", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_760_000_000_000);
    expect(await resumeAvailable()).toBe(true);
    expect(await sessionSummary()).toBeNull();
    expect(await loadSession()).toBeNull();
    expect(await saveSession(session({ savedAt: 5 }))).toBe(true);
    // Not said whether it exists elsewhere: counted as never downloaded (the safe side).
    expect(await sessionSummary()).toEqual({
      fileName: "contratto.pdf", savedAt: 1_760_000_000_000, editCount: 2, pageCount: 3, neverDownloaded: true,
      stamp: expect.any(String),
    });
    const loaded = await loadSession();
    expect(loaded).toMatchObject({ fileName: "contratto.pdf", savedAt: 1_760_000_000_000, editCount: 2, pageCount: 3, neverDownloaded: true, view: { page: 1, zoom: 1.5, fit: false } });
    expect(loaded!.original).toBeInstanceOf(ArrayBuffer);
    expect(same(loaded!.original, buffer(BIG, 1))).toBe(true);
    expect(shape(loaded!.log)).toStrictEqual(shape(log(2)));
    await forgetSession();
    expect(await sessionSummary()).toBeNull();
    expect(await loadSession()).toBeNull();
    expect(keys("session")).toEqual([]);
    // Its own database, version 1; signatureStore's "pdf-editor" never opened; every connection closed.
    expect([...fake.databases.keys()]).toEqual([DB]);
    expect(fake.databases.get(DB)!.version).toBe(1);
    expect([...fake.databases.get(DB)!.stores.keys()].sort()).toEqual(["scan", "session"]);
    expect(fake.connections.every((c) => c.name === DB && c.closed)).toBe(true);
  });

  it("P37 P40: whether the document exists nowhere else is kept with it (a file from the device: false)", async () => {
    expect(await saveSession(session({ neverDownloaded: false }))).toBe(true);
    expect(await sessionSummary()).toMatchObject({ neverDownloaded: false });
    expect(await loadSession()).toMatchObject({ neverDownloaded: false });
    expect(await saveSession(session({ editCount: 0, log: null, neverDownloaded: true }))).toBe(true);
    expect(await sessionSummary()).toMatchObject({ editCount: 0, neverDownloaded: true });
    // Junk there (a later or damaged record): not known, so true.
    fake.peek(DB, "session", "summary").neverDownloaded = "yes";
    expect(await sessionSummary()).toMatchObject({ neverDownloaded: true });
  });

  it("the summary is read without the bytes (one small record)", async () => {
    expect(await saveSession(session())).toBe(true);
    const from = fake.reads.length;
    expect(await sessionSummary()).not.toBeNull();
    expect(fake.reads.slice(from)).toEqual([{ db: DB, store: "session", op: "get", key: "summary" }]);
    expect(JSON.stringify(fake.peek(DB, "session", "summary")).length).toBeLessThan(400);
    // A load reads the summary first.
    const at = fake.reads.length;
    await loadSession();
    expect(fake.reads[at]).toEqual({ db: DB, store: "session", op: "get", key: "summary" });
  });

  it("structured-cloneable logs round-trip: Uint8Arrays (big and small, views into a bigger buffer), ArrayBuffers, Maps, Dates", async () => {
    const shared = bytes(BIG, 3);
    const window = new Uint8Array(buffer(BIG * 2, 4), 1000, BIG); // a view with an offset
    const odd = JSON.parse('{"__proto__": {"x": 1}, "constructor": "c"}');
    const value = [
      { kind: "addImage", picture: { bytes: shared, width: 1, height: 1 }, copies: [shared] },
      { kind: "replaceImage", picture: { bytes: window } },
      { kind: "insert", source: buffer(BIG, 5), pages: "all", title: null },
      { kind: "small", bytes: bytes(SMALL, 6), raw: buffer(SMALL, 7) },
      { kind: "other", map: new Map<string, unknown>([["a", bytes(BIG, 8)]]), when: new Date(5), nothing: undefined, n: null, nan: NaN },
      { kind: "odd", odd, deep: [[[[{ bytes: bytes(BIG, 9) }]]]] },
    ];
    expect(await saveSession(session({ log: value }))).toBe(true);
    const loaded = (await loadSession())!.log as any[];
    expect(shape(loaded)).toStrictEqual(shape(value));
    expect(loaded[0].picture.bytes).toBeInstanceOf(Uint8Array);
    expect(loaded[1].picture.bytes).toBeInstanceOf(Uint8Array);
    expect(loaded[1].picture.bytes.byteLength).toBe(BIG);
    expect(same(loaded[1].picture.bytes, window)).toBe(true);
    expect(loaded[2].source).toBeInstanceOf(ArrayBuffer);
    expect(loaded[4].map.get("a")).toBeInstanceOf(Uint8Array);
    expect(Object.getPrototypeOf(loaded[5].odd)).toBe(Object.prototype);
    expect(Object.hasOwn(loaded[5].odd, "__proto__")).toBe(true);
    expect(loaded[5].odd.__proto__).toEqual({ x: 1 });
    expect(loaded[5].deep[0][0][0][0].bytes).toBeInstanceOf(Uint8Array);
    // The same bytes twice come back as two buffers (one could be transferred without the other).
    expect(loaded[0].picture.bytes.buffer).not.toBe(loaded[0].copies[0].buffer);
    // Each big binary is a blob of its own, once: the original, shared (twice), window, source, deep.
    expect(blobKeys("session")).toHaveLength(5);
  });

  it("release 6: a log with shape edits (a pen stroke of 4000 points, a delete) is kept as it is, and adds no blob", async () => {
    const pen = Array.from({ length: 4000 }, (_, k) => [10 + k / 10, 300 + Math.sin(k / 50)]);
    const value = [
      { kind: "addShape", pageIndex: 0, shape: { kind: "pen", points: pen, color: [0, 0, 0], width: 1, dash: "solid", heads: 0 }, id: 1 },
      { kind: "addShape", pageIndex: 0, shape: { kind: "line", points: [[1, 2], [3.5, 4.25]], color: [0.85, 0.18, 0.13], width: 2, dash: "dotted", heads: 2 }, id: 2 },
      { kind: "editShape", pageIndex: 0, id: 1, shape: null },
    ];
    expect(await saveSession(session({ log: value, editCount: 3 }))).toBe(true);
    expect((await loadSession())!.log).toStrictEqual(value);
    expect(blobKeys("session")).toHaveLength(1); // the original alone
  });

  it("the original is written once, not again after every edit; a picture no longer in the log goes", async () => {
    let from = fake.writes.length;
    expect(await saveSession(session({ log: log(2) }))).toBe(true);
    expect(blobPuts(from)).toHaveLength(2); // the original and the picture
    // The next edit: a fresh copy of the same original (as exportSession gives it), the log grown.
    from = fake.writes.length;
    expect(await saveSession(session({ original: buffer(BIG, 1), log: log(2, 3), editCount: 3 }))).toBe(true);
    expect(blobPuts(from)).toHaveLength(1); // only the new picture
    expect(fake.writes.slice(from).every((w) => (w.bytes ?? 0) < BIG || String(w.key).startsWith("blob:"))).toBe(true);
    expect(blobKeys("session")).toHaveLength(3);
    // Undo the first picture: its blob is deleted in the same save.
    from = fake.writes.length;
    expect(await saveSession(session({ original: buffer(BIG, 1), log: log(3), editCount: 2 }))).toBe(true);
    expect(blobPuts(from)).toEqual([]);
    expect(fake.writes.slice(from).filter((w) => w.op === "delete")).toHaveLength(1);
    expect(blobKeys("session")).toHaveLength(2);
    expect(shape((await loadSession())!.log)).toStrictEqual(shape(log(3)));
  });

  it("another document replaces the old one, and none of the old one's bytes stay", async () => {
    expect(await saveSession(session())).toBe(true);
    expect(await saveSession(session({ fileName: "fattura.pdf", original: buffer(BIG, 11), log: [{ kind: "text", text: "x" }], editCount: 1, pageCount: 1 }))).toBe(true);
    expect(keys("session")).toHaveLength(3); // summary, data, the new original
    for (const key of blobKeys("session")) {
      const stored = fake.peek(DB, "session", key).bytes as ArrayBuffer;
      expect(same(stored, buffer(BIG, 1)) || same(stored, bytes(BIG, 2))).toBe(false);
    }
    expect(await loadSession()).toMatchObject({ fileName: "fattura.pdf", editCount: 1, pageCount: 1 });
  });

  it("a small file stays in the data record; without WebCrypto nothing is taken out, and it still round-trips", async () => {
    expect(await saveSession(session({ original: buffer(SMALL, 1), log: [] }))).toBe(true);
    expect(keys("session")).toEqual(["data", "summary"]);
    vi.stubGlobal("crypto", undefined);
    expect(await saveSession(session())).toBe(true);
    expect(keys("session")).toEqual(["data", "summary"]);
    const loaded = await loadSession();
    expect(same(loaded!.original, buffer(BIG, 1))).toBe(true);
    expect(shape(loaded!.log)).toStrictEqual(shape(log(2)));
  });

  it("what is not valid is refused, and nothing is written", async () => {
    const detached = buffer(BIG, 1);
    structuredClone(detached, { transfer: [detached] });
    const from = fake.writes.length;
    for (const bad of [
      session({ fileName: "" }),
      session({ fileName: undefined as any }),
      session({ original: new ArrayBuffer(0) }),
      session({ original: detached }),
      session({ original: bytes(BIG, 1) as any }),
      session({ editCount: -1 }),
      session({ editCount: 1.5 }),
      session({ pageCount: NaN }),
      null as any,
      undefined as any,
    ]) {
      expect(await saveSession(bad)).toBe(false);
    }
    expect(fake.writes.length).toBe(from);
    expect(await sessionSummary()).toBeNull();
    // A view that is not one is kept as null.
    expect(await saveSession(session({ view: { page: -1, zoom: 1, fit: true } }))).toBe(true);
    expect((await loadSession())!.view).toBeNull();
    expect(await saveSession(session({ view: { page: 2, zoom: 0, fit: true } }))).toBe(true);
    expect((await loadSession())!.view).toBeNull();
    expect(await saveSession(session({ view: null }))).toBe(true);
    expect((await loadSession())!.view).toBeNull();
  });

  it("records of another format, or damaged, count as missing", async () => {
    expect(await saveSession(session())).toBe(true);
    const summary = fake.peek(DB, "session", "summary");
    const data = fake.peek(DB, "session", "data");
    // A later app's format.
    summary.v = 2;
    expect(await sessionSummary()).toBeNull();
    expect(await loadSession()).toBeNull();
    summary.v = 1;
    expect(await loadSession()).not.toBeNull();
    // Data that does not belong to the summary.
    const stamp = data.stamp;
    data.stamp = "another";
    expect(await sessionSummary()).not.toBeNull();
    expect(await loadSession()).toBeNull();
    data.stamp = stamp;
    // A blob missing, or of another size.
    const key = blobKeys("session")[0];
    const blob = fake.peek(DB, "session", key);
    fake.poke(DB, "session", key, undefined);
    expect(await loadSession()).toBeNull();
    fake.poke(DB, "session", key, { v: 1, bytes: new ArrayBuffer(10) });
    expect(await loadSession()).toBeNull();
    fake.poke(DB, "session", key, blob);
    expect(await loadSession()).not.toBeNull();
    // Holes that do not fit the value.
    const holes = data.holes;
    data.holes = [{ path: ["nowhere", 3], key: holes[0].key, size: holes[0].size, view: false }];
    expect(await loadSession()).toBeNull();
    data.holes = "junk";
    expect(await loadSession()).toBeNull();
    data.holes = holes;
    // A summary with fields that are not right.
    summary.fileName = 42;
    expect(await sessionSummary()).toBeNull();
    expect(await loadSession()).toBeNull();
    summary.fileName = "contratto.pdf";
    // Junk where the summary should be.
    fake.poke(DB, "session", "summary", "not a record");
    expect(await sessionSummary()).toBeNull();
    expect(await loadSession()).toBeNull();
    // A save over damaged records works and cleans them.
    expect(await saveSession(session({ fileName: "nuovo.pdf" }))).toBe(true);
    expect(await loadSession()).toMatchObject({ fileName: "nuovo.pdf" });
  });

  it("calls run in the order they were made: a forget made after a save wins, even while the save hashes", async () => {
    const saved = saveSession(session({ original: buffer(BIG * 10, 1) }));
    const forgot = forgetSession();
    expect(await saved).toBe(true);
    await forgot;
    expect(await sessionSummary()).toBeNull();
    expect(keys("session")).toEqual([]);
    const forgot2 = forgetSession();
    const saved2 = saveSession(session());
    const summary = sessionSummary();
    await forgot2;
    expect(await saved2).toBe(true);
    expect(await summary).toMatchObject({ fileName: "contratto.pdf" });
  });

  it("the caller's buffers stay usable after a save", async () => {
    const s = session();
    expect(await saveSession(s)).toBe(true);
    expect(s.original.byteLength).toBe(BIG);
    expect(same(s.original, buffer(BIG, 1))).toBe(true);
    expect((s.log as any[])[1].picture.bytes.byteLength).toBe(BIG);
  });
});

describe("Riprendi store: the unfinished scan", () => {
  it("save, summary (without the pages), load, forget", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_760_000_123_000);
    expect(await scanSummary()).toBeNull();
    expect(await loadScan()).toBeNull();
    expect(await saveScan(scan([page(1), page(2, { width: 2339, height: 1654, dpi: 300 })], { kind: "insert", at: 2 }))).toBe(true);
    const from = fake.reads.length;
    expect(await scanSummary()).toEqual({
      target: { kind: "insert", at: 2 }, doc: null, savedAt: 1_760_000_123_000, pages: 2, stamp: expect.any(String),
    });
    expect(fake.reads.slice(from)).toEqual([{ db: DB, store: "scan", op: "get", key: "summary" }]);
    const loaded = await loadScan();
    expect(loaded).toMatchObject({ target: { kind: "insert", at: 2 }, savedAt: 1_760_000_123_000 });
    expect(loaded!.pages.map((p) => [p.width, p.height, p.dpi])).toEqual([[1654, 2339, 200], [2339, 1654, 300]]);
    for (const [i, p] of loaded!.pages.entries()) {
      expect(p.bytes).toBeInstanceOf(ArrayBuffer);
      expect(same(p.bytes, buffer(BIG, i + 1))).toBe(true);
      expect(same(p.preview, buffer(SMALL, i + 1))).toBe(true);
    }
    await forgetScan();
    expect(await scanSummary()).toBeNull();
    expect(await loadScan()).toBeNull();
    expect(keys("scan")).toEqual([]);
  });

  it("each save writes only the page that joined; a page removed goes; a move writes no page", async () => {
    let from = fake.writes.length;
    expect(await saveScan(scan([page(1)]))).toBe(true);
    expect(blobPuts(from)).toHaveLength(1);
    from = fake.writes.length;
    expect(await saveScan(scan([page(1), page(2)]))).toBe(true);
    expect(blobPuts(from)).toHaveLength(1);
    from = fake.writes.length;
    expect(await saveScan(scan([page(1), page(2), page(3)]))).toBe(true);
    expect(blobPuts(from)).toHaveLength(1);
    from = fake.writes.length;
    expect(await saveScan(scan([page(3), page(1)]))).toBe(true); // page 2 deleted, page 3 moved up
    expect(blobPuts(from)).toEqual([]);
    expect(blobKeys("scan")).toHaveLength(2);
    const loaded = await loadScan();
    expect(loaded!.pages.map((p) => same(p.bytes, buffer(BIG, 3)))).toEqual([true, false]);
    expect(same(loaded!.pages[1].bytes, buffer(BIG, 1))).toBe(true);
    expect(await scanSummary()).toMatchObject({ pages: 2 });
  });

  it("the tray as it was at the call is kept, even when it changes while an earlier save is still running", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    const tray = scan([page(1)]);
    const first = saveScan(tray);
    const second = saveScan(scan([page(1), page(2)]));
    tray.pages.push(page(3)); // the caller's array changes right after the call
    tray.target = { kind: "insert", at: 4 };
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(await scanSummary()).toEqual({ target: { kind: "new" }, doc: null, savedAt: 1000, pages: 2, stamp: expect.any(String) });
    expect((await loadScan())!.pages).toHaveLength(2);
  });

  it("the same page twice (retaken identical) is kept twice", async () => {
    expect(await saveScan(scan([page(1), page(1)]))).toBe(true);
    const loaded = await loadScan();
    expect(loaded!.pages).toHaveLength(2);
    expect(loaded!.pages[0].bytes).not.toBe(loaded!.pages[1].bytes);
    expect(same(loaded!.pages[0].bytes, loaded!.pages[1].bytes)).toBe(true);
  });

  it("no pages left: the scan is forgotten", async () => {
    expect(await saveScan(scan([page(1)]))).toBe(true);
    expect(await saveScan(scan([]))).toBe(true);
    expect(await scanSummary()).toBeNull();
    expect(keys("scan")).toEqual([]);
  });

  it("what is not valid is refused, and the scan kept before stays", async () => {
    expect(await saveScan(scan([page(1)]))).toBe(true);
    const detached = buffer(BIG, 2);
    structuredClone(detached, { transfer: [detached] });
    for (const bad of [
      scan([page(2, { bytes: new ArrayBuffer(0) })]),
      scan([page(2, { bytes: detached })]),
      scan([page(2, { width: 0 })]),
      scan([page(2, { height: -3 })]),
      scan([page(2, { dpi: NaN })]),
      scan([page(2, { preview: undefined as any })]),
      scan([page(2), "junk" as any]),
      scan([page(2)], { kind: "insert", at: -1 }),
      scan([page(2)], { kind: "other" } as any),
      { target: { kind: "new" }, savedAt: 1, pages: "junk" } as any,
      null as any,
    ]) {
      expect(await saveScan(bad)).toBe(false);
    }
    const loaded = await loadScan();
    expect(loaded!.pages).toHaveLength(1);
    expect(same(loaded!.pages[0].bytes, buffer(BIG, 1))).toBe(true);
  });

  it("only a page's own fields are stored (no Blob, no function the caller attached)", async () => {
    const extra = { ...page(1), blob: new Blob(["x"]), onDone: () => undefined } as SavedScanPage;
    expect(await saveScan(scan([extra]))).toBe(true);
    const loaded = await loadScan();
    expect(Object.keys(loaded!.pages[0]).sort()).toEqual(["bytes", "dpi", "height", "preview", "width"]);
  });

  it("a damaged scan record counts as missing", async () => {
    expect(await saveScan(scan([page(1), page(2)]))).toBe(true);
    const summary = fake.peek(DB, "scan", "summary");
    summary.pages = 3; // not the pages the data holds
    expect(await scanSummary()).toMatchObject({ pages: 3 });
    expect(await loadScan()).toBeNull();
    summary.pages = 0;
    expect(await scanSummary()).toBeNull();
    summary.pages = 2;
    summary.target = { kind: "insert" };
    expect(await scanSummary()).toBeNull();
    summary.target = { kind: "new" };
    expect(await loadScan()).not.toBeNull();
    fake.peek(DB, "scan", "data").value.pages[1].width = "wide";
    expect(await loadScan()).toBeNull();
  });

  it("fix round 3: an insert scan keeps the document its pages are for (its name only), in the summary too; a new one none", async () => {
    const forB = { ...scan([page(1)], { kind: "insert", at: 3 }), doc: { fileName: "B.pdf", extra: "dropped" } as any };
    expect(await saveScan(forB)).toBe(true);
    const from = fake.reads.length;
    expect(await scanSummary()).toMatchObject({ target: { kind: "insert", at: 3 }, doc: { fileName: "B.pdf" }, pages: 1 });
    expect(fake.reads.slice(from)).toEqual([{ db: DB, store: "scan", op: "get", key: "summary" }]); // without the pages
    const loaded = await loadScan();
    expect(loaded).toMatchObject({ target: { kind: "insert", at: 3 }, doc: { fileName: "B.pdf" } });
    expect(loaded!.doc).toEqual({ fileName: "B.pdf" });
    // A new PDF has no document; nor has a document without a name (not known), nor an older record.
    for (const [target, d] of [[{ kind: "new" }, { fileName: "B.pdf" }], [{ kind: "insert", at: 1 }, { fileName: "" }], [{ kind: "insert", at: 1 }, "B.pdf"]] as const) {
      expect(await saveScan({ ...scan([page(2)], target as any), doc: d as any })).toBe(true);
      expect((await scanSummary())?.doc).toBeNull();
      expect((await loadScan())?.doc).toBeNull();
    }
    expect(await saveScan(forB)).toBe(true);
    delete fake.peek(DB, "scan", "summary").doc; // kept by an earlier build
    expect((await scanSummary())?.doc).toBeNull();
    expect((await loadScan())?.doc).toBeNull();
  });

  it("the document and the scan are kept apart", async () => {
    const [a, b] = await Promise.all([saveSession(session()), saveScan(scan([page(1)]))]);
    expect([a, b]).toEqual([true, true]);
    await forgetSession();
    expect(await scanSummary()).toMatchObject({ pages: 1 });
    expect(await saveSession(session())).toBe(true);
    await forgetScan();
    expect(await sessionSummary()).toMatchObject({ fileName: "contratto.pdf" });
    expect(await loadScan()).toBeNull();
  });
});

describe("Riprendi store: two tabs, and what changed (P28, P33, P34, P35)", () => {
  /** The store as another tab (another page load) of the app has it: its own module, the same database. */
  async function anotherTab(): Promise<typeof import("../src/platform/resume")> {
    vi.resetModules();
    return import("../src/platform/resume");
  }

  it("a forget \"own\" removes only what this page wrote or resumed: another tab's record stays; a plain forget removes any", async () => {
    const tabB = await anotherTab();
    // This tab (A) keeps x.pdf with 5 edits; tab B opens a file just to read it and forgets "its own".
    expect(await saveSession(session({ fileName: "x.pdf", editCount: 5 }))).toBe(true);
    await tabB.forgetSession("own");
    expect(await sessionSummary()).toMatchObject({ fileName: "x.pdf", editCount: 5 });
    expect(blobKeys("session")).toHaveLength(2);
    // ONE document: B's save replaces it. Then A's own forget leaves B's; B's own forget removes it.
    expect(await tabB.saveSession(session({ fileName: "y.pdf", original: buffer(SMALL, 3), log: [] }))).toBe(true);
    await forgetSession("own");
    expect(await sessionSummary()).toMatchObject({ fileName: "y.pdf" });
    await tabB.forgetSession("own");
    expect(await sessionSummary()).toBeNull();
    expect(keys("session")).toEqual([]);

    // A record B loaded (Riprendi) becomes B's: B closing it forgets it.
    expect(await saveSession(session({ fileName: "x.pdf" }))).toBe(true);
    expect(await tabB.loadSession()).toMatchObject({ fileName: "x.pdf" });
    await tabB.forgetSession("own");
    expect(await sessionSummary()).toBeNull();
    // ...that very record only: saved again by A since, it is A's.
    expect(await saveSession(session({ fileName: "x.pdf" }))).toBe(true);
    expect(await tabB.loadSession()).not.toBeNull();
    expect(await saveSession(session({ fileName: "x.pdf", editCount: 3 }))).toBe(true);
    await tabB.forgetSession("own");
    expect(await sessionSummary()).toMatchObject({ editCount: 3 });

    // A plain forget (Dimentica, a record that no longer opens) removes whatever is kept.
    await tabB.forgetSession();
    expect(await sessionSummary()).toBeNull();
    // Damaged or of another format: nobody's, so an own forget removes it too.
    expect(await saveSession(session())).toBe(true);
    fake.poke(DB, "session", "summary", "not a record");
    await tabB.forgetSession("own");
    expect(keys("session")).toEqual([]);
  });

  it("Dimentica's forget names its record (the stamp): that very record goes, whoever wrote it; one saved after it stays", async () => {
    // The stamp: the summary's and the load's are the same; each save has a new one, the same document too.
    expect(await saveSession(session({ fileName: "old.pdf" }))).toBe(true);
    const first = (await sessionSummary())!.stamp;
    expect(first).toEqual(expect.any(String));
    expect((await loadSession())!.stamp).toBe(first);
    expect(await saveSession(session({ fileName: "old.pdf", editCount: 3 }))).toBe(true);
    const second = (await sessionSummary())!.stamp;
    expect(second).not.toBe(first);
    // Pressed for the first: a newer save (here, or in another tab) has replaced it, so it stays.
    expect(await forgetSession({ stamp: first })).toBe(false);
    expect(await sessionSummary()).toMatchObject({ fileName: "old.pdf", editCount: 3 });
    // Pressed for the one kept: it goes, also when another tab (or an earlier visit) wrote it.
    const tabB = await anotherTab();
    const n = resumeChanged.value;
    expect(await tabB.forgetSession({ stamp: second })).toBe(true);
    expect(await sessionSummary()).toBeNull();
    expect(keys("session")).toEqual([]);
    await vi.waitFor(() => expect(resumeChanged.value).toBe(n + 1));
    expect(await forgetSession({ stamp: second })).toBe(false); // nothing left

    // The scan the same way.
    expect(await saveScan(scan([page(1)]))).toBe(true);
    const tray1 = (await scanSummary())!.stamp;
    expect(await saveScan(scan([page(1), page(2)]))).toBe(true);
    const tray2 = (await scanSummary())!.stamp;
    expect(tray2).not.toBe(tray1);
    expect(await forgetScan({ stamp: tray1 })).toBe(false);
    expect(await scanSummary()).toMatchObject({ pages: 2 });
    expect(await forgetScan({ stamp: tray2 })).toBe(true);
    expect(await scanSummary()).toBeNull();
    expect(keys("scan")).toEqual([]);

    // A forget answers whether it removed something: "any", "own".
    expect(await forgetSession()).toBe(false);
    expect(await saveSession(session())).toBe(true);
    expect(await tabB.forgetSession("own")).toBe(false); // another tab's
    expect(await forgetSession("own")).toBe(true);
    expect(await saveSession(session())).toBe(true);
    expect(await tabB.forgetSession()).toBe(true);
    // A summary without its stamp (damaged): not one, so not offered.
    expect(await saveSession(session())).toBe(true);
    delete fake.peek(DB, "session", "summary").stamp;
    expect(await sessionSummary()).toBeNull();
  });

  it("a forget \"own\" made while this page's save is still hashing or writing runs after it and wins", async () => {
    const saved = saveSession(session({ original: buffer(BIG * 10, 1) }));
    const forgot = forgetSession("own");
    expect(await saved).toBe(true);
    await forgot;
    expect(await sessionSummary()).toBeNull();
    expect(keys("session")).toEqual([]);
  });

  it("resumeChanged counts every save and forget that changed what is kept, of either record", async () => {
    let n = resumeChanged.value;
    expect(await saveSession(session())).toBe(true);
    expect(resumeChanged.value).toBe(++n);
    expect(await saveScan(scan([page(1)]))).toBe(true);
    expect(resumeChanged.value).toBe(++n);
    expect(await saveScan(scan([]))).toBe(true); // no pages left: forgotten
    expect(resumeChanged.value).toBe(++n);
    await forgetSession();
    expect(resumeChanged.value).toBe(++n);
    // Nothing changed: nothing kept to forget, a save refused, a forget "own" that leaves another tab's.
    await forgetSession();
    await forgetScan();
    expect(await saveSession(session({ fileName: "" }))).toBe(false);
    fake.quota = 0;
    expect(await saveSession(session())).toBe(false);
    fake.quota = Infinity;
    const tabB = await anotherTab();
    expect(await tabB.saveSession(session({ fileName: "b.pdf" }))).toBe(true);
    await vi.waitFor(() => expect(resumeChanged.value).toBe(n + 1)); // B's save, told over the channel
    const before = resumeChanged.value;
    await forgetSession("own");
    expect(await sessionSummary()).toMatchObject({ fileName: "b.pdf" });
    expect(resumeChanged.value).toBe(before);
  });

  it("another tab's saves and forgets reach this one, told only which kind changed (BroadcastChannel)", async () => {
    const other = new BroadcastChannel("pdf-editor-resume");
    const heard: unknown[] = [];
    other.onmessage = (e: MessageEvent) => heard.push(e.data);
    try {
      const n = resumeChanged.value;
      other.postMessage({ kind: "scan" });
      await vi.waitFor(() => expect(resumeChanged.value).toBe(n + 1));
      expect(await saveSession(session())).toBe(true);
      expect(await saveScan(scan([page(1)]))).toBe(true);
      await forgetScan();
      await vi.waitFor(() => expect(heard).toEqual([{ kind: "session" }, { kind: "scan" }, { kind: "scan" }]));
      // Another tab's module hears this one's changes.
      const tabB = await anotherTab();
      const m = tabB.resumeChanged.value;
      await forgetSession();
      await vi.waitFor(() => expect(tabB.resumeChanged.value).toBe(m + 1));
    } finally {
      other.close();
    }
  });
});

describe("the fake IndexedDB, where the store relies on it", () => {
  function open(fakeDb: FakeIndexedDB, stores: string[] = ["s"]): Promise<any> {
    return new Promise((resolve, reject) => {
      const req = fakeDb.factory.open("t", 1);
      req.onupgradeneeded = () => {
        for (const s of stores) req.result.createObjectStore(s);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  const thrown = (f: () => unknown) => {
    try {
      f();
      return "nothing";
    } catch (e) {
      return (e as DOMException).name;
    }
  };
  const finish = (tx: any) =>
    new Promise<string>((resolve) => {
      tx.oncomplete = () => resolve("complete");
      tx.onabort = () => resolve(`abort:${tx.error?.name ?? "none"}`);
    });

  it("abort() rolls back; a request error nobody prevents aborts; the quota aborts at commit", async () => {
    const db = await open(fake);
    let tx = db.transaction("s", "readwrite");
    tx.objectStore("s").put(1, "a");
    tx.abort();
    expect(await finish(tx)).toBe("abort:none");
    expect(fake.keys("t", "s")).toEqual([]);
    fake.fail = (r) => (r.key === "b" ? new DOMException("x", "UnknownError") : null);
    tx = db.transaction("s", "readwrite");
    tx.objectStore("s").put(1, "a");
    tx.objectStore("s").put(2, "b");
    expect(await finish(tx)).toBe("abort:UnknownError");
    expect(fake.keys("t", "s")).toEqual([]);
    fake.fail = null;
    fake.quota = 100;
    tx = db.transaction("s", "readwrite");
    tx.objectStore("s").put(new ArrayBuffer(200), "a");
    expect(await finish(tx)).toBe("abort:QuotaExceededError");
    fake.quota = Infinity;
    tx = db.transaction("s", "readwrite");
    tx.objectStore("s").put(new ArrayBuffer(200), 7);
    tx.objectStore("s").put("x", "a");
    expect(await finish(tx)).toBe("complete");
    expect(fake.keys("t", "s")).toEqual([7, "a"]);
    db.close();
  });

  it("a request after waiting on something slow fails (the transaction has committed); one after a resolved promise works", async () => {
    const db = await open(fake);
    const tx = db.transaction("s", "readwrite");
    const store = tx.objectStore("s");
    await Promise.resolve();
    store.put(1, "a");
    expect(await finish(tx)).toBe("complete");
    expect(thrown(() => store.put(2, "b"))).toBe("TransactionInactiveError");
    const slow = db.transaction("s", "readwrite");
    const slowStore = slow.objectStore("s");
    const done = finish(slow);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(thrown(() => slowStore.put(2, "b"))).toBe("TransactionInactiveError");
    expect(await done).toBe("complete");
    expect(fake.keys("t", "s")).toEqual(["a"]);
    expect(thrown(() => db.transaction("s", "readonly").objectStore("s").put(1, "c"))).toBe("ReadOnlyError");
    expect(thrown(() => db.transaction("s", "readwrite").objectStore("s").put(() => 1, "c"))).toBe("DataCloneError");
    db.close();
  });

  it("transactions on the same store run in the order they were made; reads see what was committed", async () => {
    const db = await open(fake);
    const order: string[] = [];
    const w1 = db.transaction("s", "readwrite");
    const r = db.transaction("s", "readonly");
    const w2 = db.transaction("s", "readwrite");
    w1.objectStore("s").put("one", "k");
    const read = r.objectStore("s").get("k");
    w2.objectStore("s").put("two", "k");
    w1.oncomplete = () => order.push("w1");
    r.oncomplete = () => order.push(`r:${read.result}`);
    await new Promise<void>((resolve) => {
      w2.oncomplete = () => {
        order.push("w2");
        resolve();
      };
    });
    expect(order).toEqual(["w1", "r:one", "w2"]);
    db.close();
  });

  it("upgrades once; a later version tells the open connections and waits for them; a lower version is refused", async () => {
    const db = await open(fake);
    const again = await open(fake, ["other"]); // the same version: no upgrade
    expect([...again.objectStoreNames]).toEqual(["s"]);
    again.close();
    const events: string[] = [];
    db.onversionchange = () => events.push("versionchange");
    const v2 = await new Promise<any>((resolve) => {
      const req = fake.factory.open("t", 2);
      req.onblocked = () => {
        events.push("blocked");
        db.close();
      };
      req.onupgradeneeded = (e: any) => {
        events.push(`upgrade ${e.oldVersion} to ${e.newVersion}`);
        req.result.createObjectStore("v2");
      };
      req.onsuccess = () => resolve(req.result);
    });
    expect(events).toEqual(["versionchange", "blocked", "upgrade 1 to 2"]);
    expect([...v2.objectStoreNames]).toEqual(["s", "v2"]);
    v2.close();
    await expect(open(fake)).rejects.toMatchObject({ name: "VersionError" });
    expect(fake.databases.get("t")!.version).toBe(2);
  });
});
