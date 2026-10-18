// "Riprendi da dove eri": the last open document with its edits, and an unfinished scan, kept on
// this device only (IndexedDB), so that after the tab was closed or killed (Android kills it while
// the camera app is open) the home page can offer to resume them. ONE document and ONE scan: a
// save replaces what was kept before, and the callers forget them when the user closes the
// document, finishes or cancels the scan, or taps "Dimentica" (another document takes the place of
// the one kept by being saved over it). Nothing is kept for a document that needed a password to
// open, nor for one holding pages added from such a PDF (the engine's exportSession gives null for
// them, so their content never sits unencrypted here). Never sent anywhere, and not encrypted.
//
// A database of its own, "pdf-editor-resume" (version 1), with one object store per kind,
// "session" and "scan". signatureStore's "pdf-editor" is never opened here: opening it at another
// version would make the saved signatures unavailable (VersionError).
//
// Each kind is kept as three sorts of records in its store:
// - "summary": the small record the home page reads (file name, when, how many edits or pages,
//   whether the document exists nowhere else, which document a scan's pages are for; which page
//   load wrote it; and the stamp naming this very save, which the summaries give, so a forget can
//   name the record it means), so it never loads the bytes;
// - "data": everything else, with every large binary (the original PDF, the pictures and PDFs
//   inside the edit log, the scanned pages) taken out and replaced by a reference;
// - "blob:<SHA-256 of the bytes>": those binaries, one record each, named by their content. A save
//   writes only the ones not stored yet and deletes the ones no longer used, so saving after every
//   edit does not write the whole PDF again (an edit adds its own few KB, not the 50 MB original).
//   Only ArrayBuffers and Uint8Arrays of BLOB_MIN_BYTES or more, inside plain objects and arrays,
//   are taken out; anything else stays in "data" as it is (still kept, just written every time).
//   Without WebCrypto (an insecure context) nothing is taken out.
// One save is one transaction (all or nothing; the summary is put last, and every record the save
// does not use, of a previous document too, is deleted in it), so a failed save (the quota, a value
// that cannot be stored, a stalled transaction) leaves the previous record readable as it was. A
// read takes the summary first and checks that the data belongs to it (a stamp) and that every blob
// is there with its size. Every record carries its format `v`: a record of another format counts as
// missing, so a later app can refuse an old one cleanly (it should use other blob keys or another
// database, rather than reuse these).
//
// Storage may be missing or refuse to work (private browsing, blocked site data, Safari evicting it
// after 7 days without a visit, a full disk): every call catches everything, has a time limit, and
// answers false or null instead of throwing. The calls on one kind run one after the other, in the
// order they were made, so a forget made after a save always wins, even while the save is still
// hashing or writing its bytes. Binaries are stored as ArrayBuffers, not Blobs (some WebKit
// versions failed to put a Blob). put() copies what it stores: the caller's buffers stay usable,
// and a buffer already transferred elsewhere (detached) cannot be stored.
//
// Two tabs (or windows) of the app share what is kept, still ONE document and ONE scan. Each page
// load has an id of its own (OWNER), written in the summary of the document it saves; a document
// it loads (Riprendi) becomes its own too. A forget "own" (the autosave's: the document closed,
// another opened with nothing to keep, no edits any more; and making room on a full disk) removes
// only such a record, so a tab that opens a file just to read it never wipes what another tab
// keeps of a document with edits (nor what an earlier visit kept: the home page keeps offering it
// until a document with edits takes its place, or Dimentica). A save replaces whatever is kept,
// another tab's too: with edits in two tabs, the one saved last is kept; and Riprendi on a record
// another tab is still editing opens a second copy, the two then taking turns. A forget naming a
// stamp (Dimentica, a record that no longer opens) removes that very record, whoever wrote it,
// and nothing that a later save (of the same document too) put in its place. Every save or forget
// that changed what is kept bumps `resumeChanged`, also in the app's other tabs (a
// BroadcastChannel of this origin, telling only which kind changed), so the home page's card can
// follow.
import { signal, type ReadonlySignal } from "@preact/signals";
import type { ScanTarget } from "../state";

const DB_NAME = "pdf-editor-resume";
const DB_VERSION = 1;
/** The format of every record written here; a record of another format counts as missing. */
const FORMAT = 1;
/** One object store per kind of thing kept, and its calls run in order (see `queued`). */
type Kind = "session" | "scan";
const KINDS: readonly Kind[] = ["session", "scan"];
const SUMMARY = "summary";
const DATA = "data";
const BLOB = "blob:";
/** Binaries at least this big get a record of their own; smaller ones stay in the data record. */
const BLOB_MIN_BYTES = 64 * 1024;
/** Plain objects and arrays deeper than this are kept as they are (no binary taken out). */
const MAX_DEPTH = 64;
/** An open that has not answered by then is taken as "no storage". */
const OPEN_TIMEOUT_MS = 3000;
/** A summary read or a forget that has not finished by then counts as failed. */
const QUICK_TIMEOUT_MS = 5000;
/** A save or a full read (up to a few hundred MB) that has not finished by then counts as failed. */
const BYTES_TIMEOUT_MS = 30_000;
/** The app's tabs tell each other on it that what is kept changed. */
const CHANNEL = "pdf-editor-resume";

/** This page load's id, written in the summary of the document it keeps (see the header). */
const OWNER = newOwner();
/** The stamps of the session records this page loaded (Riprendi): they are its own too. */
const claimed = new Set<string>();

const changes = signal(0);
/**
 * Bumped after every save or forget that changed what is kept (the document or the scan), in this
 * tab or in another tab of the app: read the summaries again when it changes.
 */
export const resumeChanged: ReadonlySignal<number> = changes;
const channel = openChannel();

/** Where the user was in the document: the page shown, the zoom, and whether it fits the width. */
export interface SavedView {
  page: number;
  zoom: number;
  fit: boolean;
}

/**
 * The document as Riprendi keeps it: the file as it was opened and the edits since (`original` and
 * `log` from the engine's exportSession, opaque here: any structured-cloneable data), what the
 * home page says about it, and the view to restore.
 */
export interface SavedSession {
  fileName: string;
  savedAt: number;
  editCount: number;
  pageCount: number;
  /**
   * The document as it was opened (its original, without the edits kept) exists nowhere else:
   * made here (from photos or scans) and not downloaded as it is since, as far as the app knows
   * (autosave.ts says how). False for a file opened from the device: the user has it. Left out
   * (an older record): not known, read back as true.
   */
  neverDownloaded?: boolean;
  original: ArrayBuffer;
  log: unknown;
  view: SavedView | null;
  /** What loadSession gives: the stamp naming this very record (SessionSummary's). Not used by saveSession. */
  stamp?: string;
}

/** What the home page shows about the kept document, read without its bytes. */
export interface SessionSummary {
  fileName: string;
  savedAt: number;
  editCount: number;
  pageCount: number;
  /** As SavedSession's: true when not known. */
  neverDownloaded: boolean;
  /**
   * Names this very record: every save gets a new one (of the same document too), so
   * forgetSession({ stamp }) removes this record and never one saved after it.
   */
  stamp: string;
}

/** Which record a forget removes: whatever is kept, or only the one with this stamp (a summary's). */
export type ForgetWhich = "any" | { stamp: string };

/** A finished page of a scan: the picture as processPhoto gave it, and its preview for the tray. */
export interface SavedScanPage {
  bytes: ArrayBuffer;
  width: number;
  height: number;
  dpi: number;
  preview: ArrayBuffer;
}

/**
 * The document an unfinished scan's pages are to be added to, as the scan flow knew it: its file
 * name (what the app shows of a document, and the only thing it could know a file from the device
 * by again after a reload). The flow puts the pages only into a document of that name.
 */
export interface ScanDocument {
  fileName: string;
}

/**
 * An unfinished scan: where its pages go (for an insert, the index in its document, and that
 * document in `doc`), and the tray's pages in order.
 */
export interface SavedScan {
  target: ScanTarget;
  /**
   * For an insert: the document its pages are for. Null or left out for a new PDF, and for a scan
   * kept by an earlier build of this release (its document not known: the flow then puts its pages
   * into no document).
   */
  doc?: ScanDocument | null;
  savedAt: number;
  pages: SavedScanPage[];
}

/** What the home page shows about the unfinished scan, read without its pages. */
export interface ScanSummary {
  target: ScanTarget;
  /** As SavedScan's: null for a new PDF, or when not known. */
  doc: ScanDocument | null;
  savedAt: number;
  pages: number;
  /** Names this very record, as SessionSummary's (for forgetScan({ stamp })). */
  stamp: string;
}

/** IndexedDB can be used here: the database opens. */
export async function resumeAvailable(): Promise<boolean> {
  const db = await openDb();
  if (!db) return false;
  db.close();
  return true;
}

/**
 * Keep `s` as the document to resume, replacing the one kept before (of this document or another,
 * also another tab's). The record says when save was called (Date.now()); `s.savedAt` is not used.
 * False when nothing was kept: storage missing, blocked or full (a full disk can refuse even a save
 * that only replaces the one kept before), a stalled write, or `s` not valid (no file name, an empty
 * or detached `original`, a log that cannot be cloned); what was kept before is then still there,
 * unchanged. A `view` that is not valid is kept as null. The bytes are read when the save runs
 * (after the calls made before it): do not transfer them until it has answered.
 */
export function saveSession(s: SavedSession): Promise<boolean> {
  try {
    const { fileName, editCount, pageCount, original, log } = s;
    if (typeof fileName !== "string" || !fileName) return Promise.resolve(false);
    if (!isCount(editCount) || !isCount(pageCount)) return Promise.resolve(false);
    if (!(original instanceof ArrayBuffer) || original.byteLength === 0) return Promise.resolve(false);
    const neverDownloaded = s.neverDownloaded !== false;
    const summary = { fileName, savedAt: Date.now(), editCount, pageCount, neverDownloaded, owner: OWNER };
    const payload = { original, log, view: viewOf(s.view) };
    return queued("session", () => keep("session", summary, payload));
  } catch {
    return Promise.resolve(false);
  }
}

/** The kept document's name, time and counts, without reading its bytes; null when none is kept. */
export function sessionSummary(): Promise<SessionSummary | null> {
  return queued("session", async () => {
    const r = await readSummary("session");
    return r ? sessionSummaryOf(r) : null;
  });
}

/**
 * The kept document with its bytes and edits, and its stamp (to resume it: from then on it counts
 * as this page's own, see forgetSession); null when none is kept, or it is damaged or of another
 * format, or it could not be read now (a slow or failing read: sessionSummary may still find it).
 */
export function loadSession(): Promise<SavedSession | null> {
  return queued("session", async () => {
    const kept = await restore("session");
    if (!kept) return null;
    const summary = sessionSummaryOf(kept.summary);
    const value = kept.value;
    if (!summary || !isRecord(value) || !(value.original instanceof ArrayBuffer)) return null;
    claimed.add(summary.stamp);
    return { ...summary, original: value.original, log: value.log, view: viewOf(value.view) };
  });
}

/**
 * Remove the kept document, its bytes and its edits. `which` "any": whatever is kept. A stamp
 * (Dimentica, a record that no longer opens: a summary's or loadSession's): only that very record;
 * one saved after it (also of the same document, in any tab) stays. "own" (the autosave: the
 * document closed, another opened with nothing to keep, no edits any more; room made on a full
 * disk): only a record this page saved or loaded; another tab's (or an earlier visit's) stays (see
 * the header). Runs after the calls made before it, so it wins over a save still being written.
 * True when it removed what was kept; never throws.
 */
export function forgetSession(which: ForgetWhich | "own" = "any"): Promise<boolean> {
  return queued("session", async () => {
    const own = (summary: Record<string, unknown>) =>
      summary.owner === OWNER || (typeof summary.stamp === "string" && claimed.has(summary.stamp));
    const stays = which === "own" ? (summary: Record<string, unknown>) => !own(summary) : staysFor(which);
    const removed = (await clear("session", stays)) === "removed";
    if (removed) changed("session");
    return removed;
  });
}

/**
 * Keep `s` as the unfinished scan, replacing the one kept before: call it after every page that
 * joins, leaves or moves in the tray (the tray as it is at the call is what is kept). Only the
 * pages not kept yet are written. The record says when save was called (Date.now()); `s.savedAt`
 * is not used. `s.doc` is kept for an insert only (a document without a file name: not known). A
 * scan with no pages left is forgotten (true when that worked). False when nothing
 * was kept: storage missing, blocked or full, or `s` not valid (a page without bytes, a detached
 * buffer, sizes that are not positive); what was kept before is then still there. The bytes are
 * read when the save runs: do not transfer them (to the engine) until it has answered.
 */
export function saveScan(s: SavedScan): Promise<boolean> {
  try {
    const target = targetOf(s.target);
    if (!target || !Array.isArray(s.pages)) return Promise.resolve(false);
    const pages: SavedScanPage[] = [];
    for (const p of s.pages) {
      const page = scanPageOf(p);
      if (!page) return Promise.resolve(false);
      pages.push(page);
    }
    if (pages.length === 0) {
      return queued("scan", async () => {
        const done = await clear("scan");
        if (done === "removed") changed("scan");
        return done !== "failed";
      });
    }
    const summary = { target, doc: scanDocOf(target, s.doc), savedAt: Date.now(), pages: pages.length };
    return queued("scan", () => keep("scan", summary, { pages }));
  } catch {
    return Promise.resolve(false);
  }
}

/** The unfinished scan's target, time and page count, without reading its pages; null when none is kept. */
export function scanSummary(): Promise<ScanSummary | null> {
  return queued("scan", async () => {
    const r = await readSummary("scan");
    return r ? scanSummaryOf(r) : null;
  });
}

/**
 * The unfinished scan with its pages, in tray order; null when none is kept, or it is damaged or of
 * another format, or it could not be read now (scanSummary may still find it).
 */
export function loadScan(): Promise<SavedScan | null> {
  return queued("scan", async () => {
    const kept = await restore("scan");
    if (!kept) return null;
    const summary = scanSummaryOf(kept.summary);
    const value = kept.value;
    if (!summary || !isRecord(value) || !Array.isArray(value.pages)) return null;
    const pages: SavedScanPage[] = [];
    for (const p of value.pages) {
      const page = scanPageOf(p);
      if (!page) return null;
      pages.push(page);
    }
    if (pages.length !== summary.pages) return null;
    return { target: summary.target, doc: summary.doc, savedAt: summary.savedAt, pages };
  });
}

/**
 * Remove the unfinished scan and its pages (whichever tab kept it): `which` "any", whatever scan is
 * kept; a stamp (Dimentica: a summary's), only that very record, not a tray saved after it. True
 * when it removed one; never throws.
 */
export function forgetScan(which: ForgetWhich = "any"): Promise<boolean> {
  return queued("scan", async () => {
    const removed = (await clear("scan", staysFor(which))) === "removed";
    if (removed) changed("scan");
    return removed;
  });
}

/** For clear: what a forget of `which` leaves (a record of another stamp), or nothing for "any". */
function staysFor(which: ForgetWhich): ((summary: Record<string, unknown>) => boolean) | undefined {
  if (which === "any") return undefined;
  const { stamp } = which;
  return (summary) => summary.stamp !== stamp;
}

// ---------------------------------------------------------------------------------------------
// Validation (what is saved, and what is read back: a record may be damaged or older)

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

function isCount(x: unknown): x is number {
  return typeof x === "number" && Number.isInteger(x) && x >= 0;
}

/** A time from Date.now() (finite, not negative). */
function isTime(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x) && x >= 0;
}

function isPositive(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x) && x > 0;
}

function viewOf(v: unknown): SavedView | null {
  if (!isRecord(v)) return null;
  const { page, zoom, fit } = v;
  if (!isCount(page) || !isPositive(zoom) || typeof fit !== "boolean") return null;
  return { page, zoom, fit };
}

function targetOf(t: unknown): ScanTarget | null {
  if (!isRecord(t)) return null;
  if (t.kind === "new") return { kind: "new" };
  if (t.kind === "insert" && isCount(t.at)) return { kind: "insert", at: t.at };
  return null;
}

/** An insert scan's document (a clean copy to store), or null: a new PDF, or not one (not known). */
function scanDocOf(target: ScanTarget, d: unknown): ScanDocument | null {
  if (target.kind !== "insert" || !isRecord(d)) return null;
  return typeof d.fileName === "string" && d.fileName ? { fileName: d.fileName } : null;
}

/** A scan page with only its own fields (a clean copy to store), or null when it is not one. */
function scanPageOf(p: unknown): SavedScanPage | null {
  if (!isRecord(p)) return null;
  const { bytes, width, height, dpi, preview } = p;
  if (!(bytes instanceof ArrayBuffer) || bytes.byteLength === 0 || !(preview instanceof ArrayBuffer)) return null;
  if (!isPositive(width) || !isPositive(height) || !isPositive(dpi)) return null;
  return { bytes, width, height, dpi, preview };
}

function sessionSummaryOf(r: Record<string, unknown>): SessionSummary | null {
  const { fileName, savedAt, editCount, pageCount, stamp } = r;
  if (typeof fileName !== "string" || !fileName || typeof stamp !== "string") return null;
  if (!isTime(savedAt) || !isCount(editCount) || !isCount(pageCount)) return null;
  return { fileName, savedAt, editCount, pageCount, neverDownloaded: r.neverDownloaded !== false, stamp };
}

function scanSummaryOf(r: Record<string, unknown>): ScanSummary | null {
  const target = targetOf(r.target);
  const { savedAt, pages, stamp } = r;
  if (!target || !isTime(savedAt) || !isCount(pages) || pages === 0 || typeof stamp !== "string") return null;
  return { target, doc: scanDocOf(target, r.doc), savedAt, pages, stamp };
}

// ---------------------------------------------------------------------------------------------
// Large binaries kept by content

/** Where a binary was taken out of a data record's value, and which blob holds it. */
interface Hole {
  /** Keys from the value down to it (object keys and array indices); never empty. */
  path: (string | number)[];
  /** The SHA-256 of its bytes, in hex: the blob record is BLOB + key. */
  key: string;
  /** Its length in bytes. */
  size: number;
  /** A Uint8Array (true) or an ArrayBuffer (false). */
  view: boolean;
}

interface Taken {
  /** The object or array (in the copy) that held it, and under which key. */
  parent: Record<string | number, unknown>;
  name: string | number;
  path: (string | number)[];
  original: ArrayBuffer | Uint8Array;
}

/**
 * `value` with its large binaries taken out (a copy of its plain objects and arrays; the rest is
 * shared, as put() copies it anyway), where they were, and the bytes of each by its hash.
 */
async function split(value: Record<string, unknown>): Promise<{ value: unknown; holes: Hole[]; blobs: Map<string, ArrayBuffer> }> {
  const taken: Taken[] = [];
  const copy = strip(value, [], taken, new Set(), 0);
  const holes: Hole[] = [];
  const blobs = new Map<string, ArrayBuffer>();
  for (const t of taken) {
    const bytes = exactBuffer(t.original);
    const key = await sha256(bytes);
    if (key === null) {
      setOwn(t.parent, t.name, t.original); // no WebCrypto: it stays in the data record
      continue;
    }
    holes.push({ path: t.path, key, size: bytes.byteLength, view: t.original instanceof Uint8Array });
    if (!blobs.has(key)) blobs.set(key, bytes);
  }
  return { value: copy, holes, blobs };
}

/** A copy of the plain objects and arrays in `node`, with the large binaries left as null and listed in `taken`. */
function strip(node: unknown, path: (string | number)[], taken: Taken[], seen: Set<object>, depth: number): unknown {
  if (typeof node !== "object" || node === null || depth > MAX_DEPTH || seen.has(node)) return node;
  const isArray = Array.isArray(node);
  const proto: unknown = Object.getPrototypeOf(node);
  if (!isArray && proto !== Object.prototype && proto !== null) return node; // Map, Date, Blob...: as it is
  seen.add(node);
  const source = node as Record<string | number, unknown>;
  const copy = (isArray ? new Array((node as unknown[]).length) : {}) as Record<string | number, unknown>;
  const names: (string | number)[] = isArray
    ? Object.keys(node).filter((k) => /^(0|[1-9]\d*)$/.test(k)).map(Number)
    : Object.keys(node);
  for (const name of names) {
    const child = source[name];
    const at = [...path, name];
    if ((child instanceof ArrayBuffer || child instanceof Uint8Array) && child.byteLength >= BLOB_MIN_BYTES) {
      taken.push({ parent: copy, name, path: at, original: child });
      setOwn(copy, name, null);
    } else {
      setOwn(copy, name, strip(child, at, taken, seen, depth + 1));
    }
  }
  seen.delete(node);
  return copy;
}

/** Put the binaries back where `holes` say (in a value just read, so it can be changed); false when one is missing. */
function fill(value: unknown, holes: Hole[], blobs: Map<string, ArrayBuffer>): boolean {
  const used = new Set<string>();
  for (const hole of holes) {
    const stored = blobs.get(hole.key);
    if (!stored || stored.byteLength !== hole.size) return false;
    // The same bytes in two places come back as two buffers, as they were saved.
    const bytes = used.has(hole.key) ? stored.slice(0) : stored;
    used.add(hole.key);
    let parent: unknown = value;
    for (const name of hole.path.slice(0, -1)) {
      if (!isRecord(parent) || !Object.hasOwn(parent, name)) return false;
      parent = parent[name];
    }
    const name = hole.path[hole.path.length - 1];
    if (!isRecord(parent) || !Object.hasOwn(parent, name) || parent[name] !== null) return false;
    setOwn(parent, name, hole.view ? new Uint8Array(bytes) : bytes);
  }
  return true;
}

function holesOf(x: unknown): Hole[] | null {
  if (!Array.isArray(x)) return null;
  const holes: Hole[] = [];
  for (const h of x) {
    if (!isRecord(h) || typeof h.key !== "string" || !/^[0-9a-f]{64}$/.test(h.key)) return null;
    if (!isCount(h.size) || typeof h.view !== "boolean" || !Array.isArray(h.path) || h.path.length === 0) return null;
    if (!h.path.every((k: unknown) => typeof k === "string" || isCount(k))) return null;
    holes.push({ path: h.path as (string | number)[], key: h.key, size: h.size, view: h.view });
  }
  return holes;
}

/** The bytes of a buffer or a view as an ArrayBuffer of exactly their length (the buffer itself when it is). */
function exactBuffer(b: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (b instanceof ArrayBuffer) return b;
  if (b.byteOffset === 0 && b.buffer instanceof ArrayBuffer && b.byteLength === b.buffer.byteLength) return b.buffer;
  return b.slice().buffer;
}

/** The SHA-256 of `bytes` in hex; null without WebCrypto (an insecure context). */
async function sha256(bytes: ArrayBuffer): Promise<string | null> {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return null;
    const digest = new Uint8Array(await subtle.digest("SHA-256", bytes));
    let hex = "";
    for (const b of digest) hex += b.toString(16).padStart(2, "0");
    return hex;
  } catch {
    return null;
  }
}

/** obj[name] = value as an own property (also for a key such as "__proto__"). */
function setOwn(obj: Record<string | number, unknown>, name: string | number, value: unknown) {
  Object.defineProperty(obj, name, { value, writable: true, enumerable: true, configurable: true });
}

let stamps = 0;
/** Ties a data record to the summary written with it. */
function newStamp(): string {
  stamps++;
  return `${Date.now().toString(36)}.${stamps.toString(36)}.${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------------------------
// The records of one kind

/** The current record of `r` (format FORMAT), or null. */
function current(r: unknown): Record<string, unknown> | null {
  return isRecord(r) && r.v === FORMAT ? r : null;
}

/**
 * Replace everything kept of `kind` with `summary` and `payload`, in one transaction: the blobs it
 * does not have yet, the data, then the summary; every other record of the store goes.
 */
async function keep(kind: Kind, summary: Record<string, unknown>, payload: Record<string, unknown>): Promise<boolean> {
  try {
    // Hash before the transaction: it must not wait on anything else while it is open.
    const { value, holes, blobs } = await split(payload);
    const db = await openDb();
    if (!db) return false;
    try {
      const stamp = newStamp();
      const done = await inTransaction(db, kind, "readwrite", BYTES_TIMEOUT_MS, (store, tx) => {
        let written = false;
        const keys = store.getAllKeys();
        keys.onsuccess = () => {
          try {
            const had = Array.isArray(keys.result) ? keys.result : [];
            const wanted = new Set([SUMMARY, DATA, ...[...blobs.keys()].map((h) => BLOB + h)]);
            const present = new Set<string>();
            for (const k of had) {
              if (typeof k === "string" && wanted.has(k)) present.add(k);
              else store.delete(k);
            }
            for (const [hash, bytes] of blobs) {
              if (!present.has(BLOB + hash)) store.put({ v: FORMAT, bytes }, BLOB + hash);
            }
            store.put({ v: FORMAT, stamp, value, holes }, DATA);
            store.put({ ...summary, v: FORMAT, stamp }, SUMMARY); // last
            written = true;
          } catch {
            written = false;
            abortQuietly(tx);
          }
        };
        return () => written;
      });
      if (done === true) changed(kind);
      return done === true;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

/** The current summary record of `kind`, or null. */
async function readSummary(kind: Kind): Promise<Record<string, unknown> | null> {
  try {
    const db = await openDb();
    if (!db) return null;
    try {
      return await inTransaction(db, kind, "readonly", QUICK_TIMEOUT_MS, (store) => {
        const req = store.get(SUMMARY);
        return () => current(req.result);
      });
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** The summary and the value (binaries put back) of `kind`, read together; null when anything is missing or does not match. */
async function restore(kind: Kind): Promise<{ summary: Record<string, unknown>; value: unknown } | null> {
  try {
    const db = await openDb();
    if (!db) return null;
    try {
      return await inTransaction(db, kind, "readonly", BYTES_TIMEOUT_MS, (store) => {
        let summary: Record<string, unknown> | null = null;
        let data: { value: unknown; holes: Hole[] } | null = null;
        const blobs = new Map<string, ArrayBuffer>();
        const s = store.get(SUMMARY); // first: no summary, nothing else is read
        s.onsuccess = () => {
          summary = current(s.result);
          if (!summary) return;
          const d = store.get(DATA);
          d.onsuccess = () => {
            const r = current(d.result);
            const holes = r && summary && r.stamp === summary.stamp ? holesOf(r.holes) : null;
            if (!r || !holes) return;
            data = { value: r.value, holes };
            for (const key of new Set(holes.map((h) => h.key))) {
              const b = store.get(BLOB + key);
              b.onsuccess = () => {
                const blob = current(b.result);
                if (blob && blob.bytes instanceof ArrayBuffer) blobs.set(key, blob.bytes);
              };
            }
          };
        };
        return () => {
          if (!summary || !data || !fill(data.value, data.holes, blobs)) return null;
          return { summary, value: data.value };
        };
      });
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** What a clear did: removed what was kept, found nothing, left it because `stays` said so, or failed. */
type Cleared = "removed" | "empty" | "kept" | "failed";

/**
 * Remove every record of `kind`, in one transaction, unless `stays` says the current summary there
 * must stay (a summary of another format, or none, never does).
 */
async function clear(kind: Kind, stays?: (summary: Record<string, unknown>) => boolean): Promise<Cleared> {
  try {
    const db = await openDb();
    if (!db) return "failed";
    try {
      const done = await inTransaction(db, kind, "readwrite", QUICK_TIMEOUT_MS, (store) => {
        let outcome: Cleared = "empty";
        const keys = store.getAllKeys();
        keys.onsuccess = () => {
          if (!Array.isArray(keys.result) || keys.result.length === 0) return;
          const s = store.get(SUMMARY);
          s.onsuccess = () => {
            const summary = current(s.result);
            if (summary && stays?.(summary)) {
              outcome = "kept";
              return;
            }
            store.clear();
            outcome = "removed";
          };
        };
        return () => outcome;
      });
      return done ?? "failed";
    } finally {
      db.close();
    }
  } catch {
    return "failed";
  }
}

// ---------------------------------------------------------------------------------------------
// Who kept it, and telling the other tabs

/** A new page load's id: random, never shown, kept only in the summary. */
function newOwner(): string {
  try {
    const id = globalThis.crypto?.randomUUID?.();
    if (id) return id;
  } catch {
    // An insecure context: below.
  }
  return `${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 12)}`;
}

/** What is kept of `kind` changed here: bumped, and the other tabs told (only the kind). */
function changed(kind: Kind) {
  changes.value++;
  try {
    channel?.postMessage({ kind });
  } catch {
    // Closed: the other tabs read it again when their home page shows.
  }
}

/** The app's tabs' channel, heard for as long as the page lives; null where there is none. */
function openChannel(): BroadcastChannel | null {
  try {
    if (typeof BroadcastChannel !== "function") return null;
    const c = new BroadcastChannel(CHANNEL);
    c.onmessage = () => {
      changes.value++;
    };
    (c as { unref?: () => void }).unref?.(); // Node (the tests): it does not keep the process alive
    return c;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// IndexedDB plumbing

const queues: Record<Kind, Promise<unknown>> = { session: Promise.resolve(), scan: Promise.resolve() };

/** Run `job` after every call on `kind` made before it (each job catches its own failures). */
function queued<T>(kind: Kind, job: () => Promise<T>): Promise<T> {
  const run = queues[kind].then(job, job);
  queues[kind] = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function abortQuietly(tx: IDBTransaction | undefined) {
  try {
    tx?.abort();
  } catch {
    // Already over.
  }
}

/**
 * One transaction on `storeName`: `work` makes its requests and gives what to answer once the
 * transaction has completed. Null when it fails, aborts, throws, or has not completed after
 * `timeoutMs` (it is then aborted, so a stalled write keeps nothing).
 */
function inTransaction<T>(
  db: IDBDatabase,
  storeName: Kind,
  mode: IDBTransactionMode,
  timeoutMs: number,
  work: (store: IDBObjectStore, tx: IDBTransaction) => () => T,
): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = false;
    let tx: IDBTransaction | undefined;
    const done = (value: T | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      abortQuietly(tx);
      done(null);
    }, timeoutMs);
    try {
      tx = db.transaction(storeName, mode);
      const answer = work(tx.objectStore(storeName), tx);
      tx.oncomplete = () => {
        try {
          done(answer());
        } catch {
          done(null);
        }
      };
      tx.onerror = () => done(null);
      tx.onabort = () => done(null);
    } catch {
      abortQuietly(tx);
      done(null);
    }
  });
}

/** The database, created on first use; null when there is no IndexedDB or it does not open. */
function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (db: IDBDatabase | null) => {
      if (settled) {
        db?.close(); // answered after the timeout: not wanted any more
        return;
      }
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(db);
    };
    try {
      // Reading the property itself throws where storage is blocked (SecurityError).
      const factory: IDBFactory | undefined = globalThis.indexedDB;
      if (!factory) return done(null);
      timer = setTimeout(() => done(null), OPEN_TIMEOUT_MS);
      const req = factory.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        try {
          const db = req.result;
          for (const kind of KINDS) if (!db.objectStoreNames.contains(kind)) db.createObjectStore(kind);
        } catch {
          // The open then fails, and onerror answers.
        }
      };
      req.onsuccess = () => {
        try {
          const db = req.result;
          if (!KINDS.every((kind) => db.objectStoreNames.contains(kind))) {
            db.close();
            return done(null);
          }
          // A newer version of the app opening the database in another tab: let it.
          db.onversionchange = () => db.close();
          done(db);
        } catch {
          done(null);
        }
      };
      req.onerror = (e) => {
        e.preventDefault?.();
        done(null);
      };
      req.onblocked = () => done(null);
    } catch {
      done(null);
    }
  });
}
