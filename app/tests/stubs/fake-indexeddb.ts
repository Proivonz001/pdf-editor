// A small in-memory IndexedDB for tests in Node, which has none: enough for the app's stores
// (src/platform/resume.ts first) to run against something that behaves like the real one where it
// matters to them.
// - Databases with a version: open() upgrades (onupgradeneeded, with a versionchange transaction:
//   the only place createObjectStore works; an exception there or abort() rolls the upgrade back),
//   refuses a lower version (VersionError), and tells the other open connections first
//   (onversionchange; onblocked while one stays open, then it waits for them to close).
// - Object stores with out-of-line keys or a key path (string and number keys, listed in the
//   order IndexedDB sorts them): get, getAll, getAllKeys, count, put, delete, clear.
// - Transactions over one or more stores: one waits for the earlier ones that touch the same
//   stores when either of them writes; it sees its own writes, commits once no request is left,
//   and rolls back on abort(), on a request error nobody prevented, or on an exception in a
//   request's onsuccess. A request can only be made while the transaction is active: in the task
//   that made it or in a request's callback (and the microtasks right after), as in browsers, so
//   code that awaits something slow inside a transaction fails here too (TransactionInactiveError:
//   by then a transaction with no request left has committed). One gap: Node has no hook at the
//   end of a task, so a transaction becomes inactive at its own next step, and a request made from
//   another task that runs before that step is still accepted.
// - Values stored and read as structured clones (DataCloneError for a function, thrown by put()).
// Everything answers a task later (setImmediate, captured when this module loads: a test's fake
// timers stop only the code under test's own timers, not the database; and setTimeout(0) can take
// 15 ms a step on Windows).
// Faults to inject (all can change during a test): `open` ("throw": open() throws SecurityError,
// "error": the open fails, "hang": it never answers), `transactions` ("throw": transaction()
// throws, "hang": they start but never serve a request nor finish, abort() still works), `quota`
// (a commit whose puts do not fit in what is left aborts with QuotaExceededError, as Chrome reports
// a full disk: the bytes a transaction writes count, and its deletes do not make room for them)
// and `fail` (a request that should fail, chosen by store, operation and key).
// `reads` and `writes` list what was read and what was committed, so a test can tell what a call
// touched. Use it with vi.stubGlobal("indexedDB", fake.factory).
/* eslint-disable @typescript-eslint/no-explicit-any */

type Key = string | number;
type Handler = ((event: any) => void) | null;

/** One request, for `fail`, `reads` and `writes`. */
export interface FakeRequestInfo {
  db: string;
  store: string;
  op: "get" | "getAll" | "getAllKeys" | "count" | "put" | "delete" | "clear";
  key?: Key;
  /** For a put: the size of the value stored, in bytes (as `usage` counts them). */
  bytes?: number;
}

interface StoreData {
  keyPath: string | null;
  records: Map<string, { key: Key; value: unknown }>;
}

interface DbData {
  version: number;
  stores: Map<string, StoreData>;
}

export interface FakeIndexedDB {
  /** Stands in for globalThis.indexedDB. */
  factory: { open(name: string, version?: number): any; cmp(a: unknown, b: unknown): number };
  /** The databases: name → version and stores (key → stored clone). */
  databases: Map<string, DbData>;
  /** Every connection opened, in order (each has `name` and `closed`). */
  connections: { name: string; closed: boolean }[];
  /** Every read served, in order. */
  reads: FakeRequestInfo[];
  /** Every write committed, in order (a rolled-back write is not listed). */
  writes: FakeRequestInfo[];
  open: "ok" | "throw" | "error" | "hang";
  transactions: "ok" | "throw" | "hang";
  /**
   * Most bytes a database may hold (ArrayBuffers and typed arrays by length, strings two bytes a
   * character): a transaction whose puts add up to more than what is left fails at commit.
   */
  quota: number;
  /** Return an error to make that request fail (its onerror, then the transaction's), or null. */
  fail: ((r: FakeRequestInfo) => DOMException | null) | null;
  /** Bytes database `name` holds now. */
  usage(name: string): number;
  /** The keys of a store, sorted, or [] when it is not there. */
  keys(db: string, store: string): Key[];
  /** The value stored under `key` itself (not a copy: changing it changes the database), or undefined. */
  peek(db: string, store: string, key: Key): any;
  /** Store `value` under `key` directly (undefined removes it), outside any transaction. */
  poke(db: string, store: string, key: Key, value: unknown): void;
  /** Resolve once the database has nothing left to do (every answer given), in real time. */
  settle(): Promise<void>;
}

/** A task later, on the real clock. */
const nextTask: (f: () => void) => void =
  typeof globalThis.setImmediate === "function"
    ? ((immediate) => (f: () => void) => void immediate(f))(globalThis.setImmediate.bind(globalThis))
    : ((timeout) => (f: () => void) => void timeout(f, 0))(globalThis.setTimeout.bind(globalThis));

const error = (name: string, message = name) => new DOMException(message, name);

/** IndexedDB's key order: numbers before strings, numbers by value, strings by code unit. */
function compareKeys(a: Key, b: Key): number {
  if (typeof a !== typeof b) return typeof a === "number" ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function validKey(k: unknown): k is Key {
  return (typeof k === "number" && !Number.isNaN(k)) || typeof k === "string";
}

const norm = (k: Key) => (typeof k === "number" ? `n${k}` : `s${k}`);

/** Bytes `value` takes, roughly as a browser counts them against the quota. */
function sizeOf(value: unknown, seen = new Set<unknown>()): number {
  if (typeof value === "string") return value.length * 2;
  if (typeof value !== "object" || value === null) return 8;
  if (seen.has(value)) return 0;
  seen.add(value);
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof Blob) return value.size;
  if (value instanceof Map) {
    let n = 0;
    for (const [k, v] of value) n += sizeOf(k, seen) + sizeOf(v, seen);
    return n;
  }
  if (value instanceof Set) {
    let n = 0;
    for (const v of value) n += sizeOf(v, seen);
    return n;
  }
  let n = 0;
  for (const [k, v] of Object.entries(value)) n += k.length * 2 + sizeOf(v, seen);
  return n;
}

/** A new in-memory IndexedDB, empty, with no faults. */
export function fakeIndexedDB(): FakeIndexedDB {
  const databases = new Map<string, DbData>();
  const connections: FakeConnection[] = [];
  /** Transactions not finished yet, per database, in the order they were made. */
  const live = new Map<string, FakeTransaction[]>();
  /** Opens waiting for other connections to close. */
  const blocked: (() => boolean)[] = [];
  let pending = 0;

  const later = (f: () => void) => {
    pending++;
    nextTask(() => {
      pending--;
      f();
    });
  };

  const fake: FakeIndexedDB = {
    factory: {
      open(name: string, version?: number) {
        if (fake.open === "throw") throw error("SecurityError", "The operation is insecure.");
        if (version !== undefined && (!Number.isInteger(version) || version < 1)) throw new TypeError("Bad version");
        const req = openRequest();
        later(() => openStep(req, String(name), version));
        return req;
      },
      cmp(a: unknown, b: unknown) {
        if (!validKey(a) || !validKey(b)) throw error("DataError");
        return compareKeys(a, b);
      },
    },
    databases,
    connections,
    reads: [],
    writes: [],
    open: "ok",
    transactions: "ok",
    quota: Infinity,
    fail: null,
    usage(name: string) {
      return usageOf(databases.get(name), null);
    },
    keys(db: string, store: string) {
      const data = databases.get(db)?.stores.get(store);
      return data ? [...data.records.values()].map((r) => r.key).sort(compareKeys) : [];
    },
    peek(db: string, store: string, key: Key) {
      return databases.get(db)?.stores.get(store)?.records.get(norm(key))?.value;
    },
    poke(db: string, store: string, key: Key, value: unknown) {
      const records = databases.get(db)?.stores.get(store)?.records;
      if (!records) throw new Error(`No store ${db}/${store}`);
      if (value === undefined) records.delete(norm(key));
      else records.set(norm(key), { key, value });
    },
    async settle() {
      do await new Promise<void>((resolve) => nextTask(resolve));
      while (pending > 0);
    },
  };

  function usageOf(data: DbData | undefined, work: Map<string, Map<string, { key: Key; value: unknown }>> | null): number {
    if (!data) return 0;
    let n = 0;
    for (const [name, store] of data.stores) {
      const records = work?.get(name) ?? store.records;
      for (const r of records.values()) n += sizeOf(r.key) + sizeOf(r.value);
    }
    return n;
  }

  function openRequest() {
    return {
      readyState: "pending",
      result: undefined as any,
      error: null as DOMException | null,
      transaction: null as FakeTransaction | null,
      onsuccess: null as Handler,
      onerror: null as Handler,
      onupgradeneeded: null as Handler,
      onblocked: null as Handler,
    };
  }

  interface ErrorEvent {
    type: "error";
    target: unknown;
    defaultPrevented: boolean;
    preventDefault(): void;
    stopPropagation(): void;
  }

  function errorEvent(target: unknown): ErrorEvent {
    const event: ErrorEvent = {
      type: "error",
      target,
      defaultPrevented: false,
      preventDefault() {
        event.defaultPrevented = true;
      },
      stopPropagation() {},
    };
    return event;
  }

  function failOpen(req: ReturnType<typeof openRequest>, e: DOMException) {
    req.readyState = "done";
    req.result = undefined;
    req.error = e;
    req.onerror?.(errorEvent(req));
  }

  function openStep(req: ReturnType<typeof openRequest>, name: string, version: number | undefined) {
    if (fake.open === "hang") return;
    if (fake.open === "error") return failOpen(req, error("UnknownError", "No storage"));
    const old = databases.get(name)?.version ?? 0;
    const v = version ?? (old || 1);
    if (v < old) return failOpen(req, error("VersionError", "The requested version is less than the existing version."));
    if (v === old) {
      const conn = new FakeConnection(name, databases.get(name)!);
      req.readyState = "done";
      req.result = conn;
      req.onsuccess?.({ type: "success", target: req });
      return;
    }
    const others = () => connections.filter((c) => c.name === name && !c.closed);
    for (const c of others()) c.onversionchange?.({ type: "versionchange", oldVersion: old, newVersion: v });
    const tryUpgrade = () => {
      if (others().length > 0) return false;
      later(() => upgrade(req, name, old, v));
      return true;
    };
    if (!tryUpgrade()) {
      req.onblocked?.({ type: "blocked", oldVersion: old, newVersion: v });
      blocked.push(tryUpgrade);
    }
  }

  function upgrade(req: ReturnType<typeof openRequest>, name: string, oldVersion: number, newVersion: number) {
    const existed = databases.get(name);
    const data: DbData = existed ?? { version: 0, stores: new Map() };
    const before = {
      version: data.version,
      stores: new Map([...data.stores].map(([n, s]) => [n, { keyPath: s.keyPath, records: new Map(s.records) }])),
    };
    databases.set(name, data);
    data.version = newVersion;
    const conn = new FakeConnection(name, data);
    conn.upgrading = true;
    const tx = new FakeTransaction(conn, null, "versionchange", (ok) => {
      conn.upgrading = false;
      req.transaction = null;
      if (ok) {
        req.onsuccess?.({ type: "success", target: req });
        return;
      }
      if (existed) {
        data.version = before.version;
        data.stores = before.stores;
      } else {
        databases.delete(name);
      }
      conn.close();
      failOpen(req, error("AbortError", "The upgrade was aborted."));
    });
    req.readyState = "done";
    req.result = conn;
    req.transaction = tx;
    tx.start();
    try {
      req.onupgradeneeded?.({ type: "upgradeneeded", target: req, oldVersion, newVersion });
    } catch {
      tx.abortWith(error("AbortError"));
    }
  }

  function closed() {
    for (let i = blocked.length - 1; i >= 0; i--) if (blocked[i]()) blocked.splice(i, 1);
  }

  /** Start the waiting transactions of `name` that no earlier one holds back. */
  function pump(name: string) {
    const list = live.get(name) ?? [];
    for (let i = 0; i < list.length; i++) {
      const tx = list[i];
      if (tx.state !== "waiting") continue;
      const held = list.slice(0, i).some((t) => t.conflicts(tx));
      if (!held) tx.start();
    }
  }

  function finished(tx: FakeTransaction) {
    const list = live.get(tx.conn.name) ?? [];
    const i = list.indexOf(tx);
    if (i >= 0) list.splice(i, 1);
    pump(tx.conn.name);
  }

  class FakeConnection {
    closed = false;
    upgrading = false;
    onversionchange: Handler = null;
    onclose: Handler = null;
    onabort: Handler = null;
    onerror: Handler = null;
    constructor(
      readonly name: string,
      readonly data: DbData,
    ) {
      connections.push(this);
    }
    get version() {
      return this.data.version;
    }
    get objectStoreNames() {
      const names = [...this.data.stores.keys()].sort();
      return {
        length: names.length,
        item: (i: number) => names[i] ?? null,
        contains: (n: string) => names.includes(n),
        [Symbol.iterator]: () => names[Symbol.iterator](),
      };
    }
    createObjectStore(name: string, options?: { keyPath?: string | null; autoIncrement?: boolean }) {
      if (!this.upgrading) throw error("InvalidStateError", "Not in a version change.");
      if (this.data.stores.has(name)) throw error("ConstraintError", "That store already exists.");
      if (options?.autoIncrement) throw error("NotSupportedError", "No key generators in this fake.");
      this.data.stores.set(name, { keyPath: options?.keyPath ?? null, records: new Map() });
      return { name };
    }
    deleteObjectStore(name: string) {
      if (!this.upgrading) throw error("InvalidStateError", "Not in a version change.");
      if (!this.data.stores.delete(name)) throw error("NotFoundError", "No such store.");
    }
    transaction(names: string | string[], mode: string = "readonly") {
      if (fake.transactions === "throw") throw error("InvalidStateError", "The database connection is closing.");
      if (this.closed) throw error("InvalidStateError", "The database connection is closing.");
      if (this.upgrading) throw error("InvalidStateError", "A version change is running.");
      const scope = [...new Set(typeof names === "string" ? [names] : [...names])];
      if (scope.length === 0) throw error("InvalidAccessError", "No store named.");
      for (const n of scope) if (!this.data.stores.has(n)) throw error("NotFoundError", `No store "${n}".`);
      if (mode !== "readonly" && mode !== "readwrite") throw new TypeError(`Bad mode "${mode}"`);
      const tx = new FakeTransaction(this, scope, mode, null);
      const list = live.get(this.name) ?? [];
      live.set(this.name, list);
      list.push(tx);
      pump(this.name);
      return tx;
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      later(closed);
    }
  }

  interface FakeRequest {
    readyState: string;
    result: unknown;
    error: DOMException | null;
    source: unknown;
    transaction: FakeTransaction;
    onsuccess: Handler;
    onerror: Handler;
    info: FakeRequestInfo;
    run: () => unknown;
  }

  class FakeTransaction {
    state: "waiting" | "running" | "done" = "waiting";
    active = true;
    error: DOMException | null = null;
    oncomplete: Handler = null;
    onerror: Handler = null;
    onabort: Handler = null;
    readonly hung = fake.transactions === "hang";
    private scheduled = false;
    private queue: FakeRequest[] = [];
    /** The stores this transaction wrote, copied when first written (applied on commit). */
    private work = new Map<string, Map<string, { key: Key; value: unknown }>>();
    private log: FakeRequestInfo[] = [];

    constructor(
      readonly conn: FakeConnection,
      private readonly fixedScope: string[] | null,
      readonly mode: string,
      private readonly after: ((ok: boolean) => void) | null,
    ) {
      // Active in the task that made it (and its microtasks): until the first step.
      this.schedule();
    }

    get db() {
      return this.conn;
    }
    get scope(): string[] {
      return this.fixedScope ?? [...this.conn.data.stores.keys()];
    }
    get objectStoreNames() {
      const names = [...this.scope].sort();
      return { length: names.length, item: (i: number) => names[i] ?? null, contains: (n: string) => names.includes(n) };
    }

    conflicts(other: FakeTransaction) {
      if (this.state === "done") return false;
      if (this.mode === "readonly" && other.mode === "readonly") return false;
      return this.scope.some((n) => other.scope.includes(n));
    }

    start() {
      if (this.state !== "waiting") return;
      this.state = "running";
      this.schedule();
    }

    /** One step at a time: each serves one request, a task after the one before. */
    private schedule() {
      if (this.scheduled) return;
      this.scheduled = true;
      later(() => {
        this.scheduled = false;
        this.step();
      });
    }

    objectStore(name: string) {
      if (this.state === "done") throw error("InvalidStateError", "The transaction has finished.");
      if (!this.scope.includes(name)) throw error("NotFoundError", `"${name}" is not in this transaction.`);
      const data = this.conn.data.stores.get(name)!;
      return new FakeObjectStore(this, name, data.keyPath);
    }

    abort() {
      if (this.state === "done") throw error("InvalidStateError", "The transaction has finished.");
      this.abortWith(null);
    }

    /** The records of `store` as this transaction sees them; `write` copies them first. */
    view(store: string, write: boolean) {
      let records = this.work.get(store);
      if (!records) {
        const committed = this.conn.data.stores.get(store)!.records;
        if (!write) return committed;
        records = new Map(committed);
        this.work.set(store, records);
      }
      return records;
    }

    request(info: FakeRequestInfo, source: unknown, run: () => unknown): FakeRequest {
      if (this.state === "done" || !this.active) throw error("TransactionInactiveError", "The transaction is not active.");
      const req: FakeRequest = {
        readyState: "pending", result: undefined, error: null, source, transaction: this,
        onsuccess: null, onerror: null, info, run,
      };
      this.queue.push(req);
      return req;
    }

    private step() {
      if (this.state === "done") return;
      this.active = false;
      if (this.state === "waiting" || this.hung) return;
      const req = this.queue.shift();
      if (!req) return this.commit();
      this.serve(req);
      if (!this.over()) this.schedule();
    }

    /** Committed or aborted (a method, so that a check after serve() is not narrowed away). */
    over(): boolean {
      return this.state === "done";
    }

    private serve(req: FakeRequest) {
      const injected = fake.fail?.(req.info) ?? null;
      let result: unknown;
      let failure: DOMException | null = injected;
      if (!failure) {
        try {
          result = req.run();
        } catch (e) {
          failure = e instanceof DOMException ? e : error("UnknownError", String(e));
        }
      }
      req.readyState = "done";
      this.active = true;
      if (failure) {
        req.error = failure;
        const event = errorEvent(req);
        try {
          req.onerror?.(event);
        } catch {
          return this.abortWith(error("AbortError"));
        }
        try {
          this.onerror?.(event);
        } catch {
          // Reported, as browsers do; the default action still follows.
        }
        if (!event.defaultPrevented) this.abortWith(failure);
        return;
      }
      req.result = result;
      if (req.info.op === "put" || req.info.op === "delete" || req.info.op === "clear") this.log.push(req.info);
      else fake.reads.push(req.info);
      try {
        req.onsuccess?.({ type: "success", target: req });
      } catch {
        this.abortWith(error("AbortError"));
      }
    }

    private commit() {
      if (this.mode !== "readonly") {
        // As Chrome: the bytes written must fit in what is left before the transaction (its
        // deletes do not make room for them).
        const written = this.log.reduce((n, w) => n + (w.bytes ?? 0), 0);
        if (written > 0 && usageOf(this.conn.data, null) + written > fake.quota) {
          return this.abortWith(error("QuotaExceededError", "The quota has been exceeded."));
        }
      }
      for (const [name, records] of this.work) {
        const store = this.conn.data.stores.get(name);
        if (store) store.records = records;
      }
      fake.writes.push(...this.log);
      this.state = "done";
      try {
        this.oncomplete?.({ type: "complete", target: this });
      } finally {
        finished(this);
        this.after?.(true);
      }
    }

    /** Roll back: nothing written stays; the requests not served fail with AbortError; then onabort. */
    abortWith(reason: DOMException | null) {
      if (this.state === "done") return;
      this.state = "done";
      this.active = false;
      this.error = reason;
      this.work.clear();
      const unserved = this.queue.splice(0);
      later(() => {
        for (const req of unserved) {
          req.readyState = "done";
          req.error = error("AbortError", "The transaction was aborted.");
          const event = errorEvent(req);
          try {
            req.onerror?.(event);
            this.onerror?.(event);
          } catch {
            // Reported, as browsers do.
          }
        }
        try {
          this.onabort?.({ type: "abort", target: this });
        } finally {
          finished(this);
          this.after?.(false);
        }
      });
    }
  }

  class FakeObjectStore {
    constructor(
      readonly transaction: FakeTransaction,
      readonly name: string,
      readonly keyPath: string | null,
    ) {}

    private info(op: FakeRequestInfo["op"], key?: Key, bytes?: number): FakeRequestInfo {
      return { db: this.transaction.conn.name, store: this.name, op, ...(key !== undefined ? { key } : {}), ...(bytes !== undefined ? { bytes } : {}) };
    }

    /** The checks every request starts with, in IndexedDB's order. */
    private usable(write: boolean) {
      const tx = this.transaction;
      if (tx.state === "done" || !tx.active) throw error("TransactionInactiveError", "The transaction is not active.");
      if (write && tx.mode === "readonly") throw error("ReadOnlyError", "The transaction is read-only.");
    }

    private keyOf(k: unknown): Key {
      if (!validKey(k)) throw error("DataError", "Not a valid key.");
      return k;
    }

    get(key: unknown) {
      this.usable(false);
      const k = this.keyOf(key);
      return this.transaction.request(this.info("get", k), this, () => {
        const r = this.transaction.view(this.name, false).get(norm(k));
        return r ? structuredClone(r.value) : undefined;
      });
    }

    getAll() {
      this.usable(false);
      return this.transaction.request(this.info("getAll"), this, () =>
        [...this.transaction.view(this.name, false).values()].sort((a, b) => compareKeys(a.key, b.key)).map((r) => structuredClone(r.value)),
      );
    }

    getAllKeys() {
      this.usable(false);
      return this.transaction.request(this.info("getAllKeys"), this, () =>
        [...this.transaction.view(this.name, false).values()].map((r) => r.key).sort(compareKeys),
      );
    }

    count() {
      this.usable(false);
      return this.transaction.request(this.info("count"), this, () => this.transaction.view(this.name, false).size);
    }

    put(value: unknown, key?: unknown) {
      this.usable(true);
      if (this.keyPath !== null && key !== undefined) throw error("DataError", "A store with a key path takes no key.");
      if (this.keyPath === null && key === undefined) throw error("DataError", "No key given.");
      const clone = structuredClone(value); // throws DataCloneError, as put() does
      const k = this.keyOf(this.keyPath !== null ? (clone as any)?.[this.keyPath] : key);
      return this.transaction.request(this.info("put", k, sizeOf(clone)), this, () => {
        this.transaction.view(this.name, true).set(norm(k), { key: k, value: clone });
        return k;
      });
    }

    delete(key: unknown) {
      this.usable(true);
      const k = this.keyOf(key);
      return this.transaction.request(this.info("delete", k), this, () => {
        this.transaction.view(this.name, true).delete(norm(k));
        return undefined;
      });
    }

    clear() {
      this.usable(true);
      return this.transaction.request(this.info("clear"), this, () => {
        this.transaction.view(this.name, true).clear();
        return undefined;
      });
    }
  }

  return fake;
}
