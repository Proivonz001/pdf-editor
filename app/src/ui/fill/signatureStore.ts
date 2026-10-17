// Signatures and initials kept on this device, only when the user ticks "Ricorda su questo
// dispositivo" (off by default, decision D3): at most 5, in this browser's IndexedDB (database
// "pdf-editor", store "signatures"), never sent anywhere and not encrypted (sign.rememberHint
// says so). The rest of the session's signatures live only in memory (state.sessionSignatures).
//
// Storage may be missing or refuse to work (private browsing, blocked site data, a sandboxed
// frame, Safari evicting it after 7 days without a visit): every call catches everything and the
// app works without it. available() says whether to offer "Ricorda"; list() gives [] and save()
// null when it cannot. An open that never answers counts as unavailable after a few seconds.
//
// The picture is stored as its bytes (an ArrayBuffer) rather than a Blob, which some WebKit
// versions failed to put in IndexedDB; list() gives Blobs back, and also reads a stored Blob.
import type { Signature } from "../../state";

const DB_NAME = "pdf-editor";
const DB_VERSION = 1;
const STORE = "signatures";
/** At most this many saved signatures and initials together. */
export const MAX_SAVED = 5;
/** An open that has not answered by then is taken as "no storage". */
const OPEN_TIMEOUT_MS = 3000;

/** IndexedDB can be used here: opening the database works. */
export async function available(): Promise<boolean> {
  const db = await openDb();
  if (!db) return false;
  db.close();
  return true;
}

/** The saved signatures and initials, newest first; [] when there are none or storage fails. */
export async function list(): Promise<Signature[]> {
  try {
    const db = await openDb();
    if (!db) return [];
    try {
      const records = await new Promise<unknown[]>((resolve, reject) => {
        const req = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
        req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
        req.onerror = () => reject(req.error);
      });
      const out: Signature[] = [];
      for (const r of records) {
        const sig = fromRecord(r);
        if (sig) out.push(sig);
      }
      return out.sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0));
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

/**
 * Keep `sig` on this device (replacing a saved one with the same id). Gives what was stored,
 * with its savedAt (now, unless it had one), or null when nothing was: 5 already saved, or the
 * storage failed.
 */
export async function save(sig: Signature): Promise<Signature | null> {
  try {
    // Read before the transaction: one must not wait on anything else while it is open.
    const bytes = await sig.png.arrayBuffer();
    const stored: Signature = { ...sig, savedAt: sig.savedAt ?? Date.now() };
    const record = { ...stored, png: bytes, type: sig.png.type || "image/png" };
    const db = await openDb();
    if (!db) return null;
    try {
      const ok = await new Promise<boolean>((resolve) => {
        let full = false;
        const tx = db.transaction(STORE, "readwrite");
        const store = tx.objectStore(STORE);
        const keys = store.getAllKeys();
        keys.onsuccess = () => {
          const ids = Array.isArray(keys.result) ? keys.result : [];
          if (ids.length >= MAX_SAVED && !ids.includes(sig.id)) {
            full = true;
            tx.abort();
            return;
          }
          store.put(record);
        };
        tx.oncomplete = () => resolve(!full);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      });
      return ok ? stored : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** Remove the saved signature `id`. False when the storage failed (true also when it was not there). */
export async function forget(id: string): Promise<boolean> {
  try {
    const db = await openDb();
    if (!db) return false;
    try {
      return await new Promise<boolean>((resolve) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).delete(id);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      });
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
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
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
        } catch {
          // The open then fails, and onerror answers.
        }
      };
      req.onsuccess = () => {
        try {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE)) {
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

/** A stored record as a Signature, or null when it is not one (an older or damaged entry). */
function fromRecord(r: unknown): Signature | null {
  if (!r || typeof r !== "object") return null;
  const { id, kind, png, type, width, height, description, source, savedAt } = r as Record<string, unknown>;
  if (typeof id !== "string" || (kind !== "signature" && kind !== "initials")) return null;
  if (!(typeof width === "number" && width > 0 && typeof height === "number" && height > 0)) return null;
  if (source !== "draw" && source !== "type" && source !== "photo") return null;
  const blobType = typeof type === "string" && type ? type : "image/png";
  const blob = png instanceof Blob ? png : png instanceof ArrayBuffer ? new Blob([png], { type: blobType }) : null;
  if (!blob || blob.size === 0) return null;
  return {
    id, kind, png: blob, width, height, source,
    description: typeof description === "string" ? description : "",
    savedAt: typeof savedAt === "number" && Number.isFinite(savedAt) ? savedAt : 0,
  };
}
