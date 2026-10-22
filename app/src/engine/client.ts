// Main-thread side of the engine: starts the worker and turns messages into promises.
import type {
  FieldValue, ImageTarget, LineEditOptions, Matrix, Op, PagePicture, PagesEdit, RedactArea, RedactMode,
  RequestOf, ResponseMessage, ResultMap, SaveOptions, SearchOptions, TextStyle,
} from "./protocol";
// The URL of the worker chunk: Vite bundles worker.ts as a worker entry for this import.
import workerPath from "./worker.ts?worker&url";

export class EngineError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

/**
 * Starts the engine from a same-origin blob: module that only imports the worker chunk, instead
 * of from the chunk's own URL. A worker started from a URL gets the Content-Security-Policy sent
 * with that script's response, and only hosts that read public/_headers (Cloudflare) send one:
 * on GitHub Pages or any other static host the engine would run with no policy at all. A worker
 * started from a blob: URL inherits the policy of the page that creates it, <meta> CSP included,
 * so the engine is confined the same way on every host ("worker-src blob:" allows the blob).
 * The import needs an absolute URL; inside the chunk import.meta.url is still the chunk's own
 * URL, so its relative imports and MuPDF's .wasm load as before. Returns the blob URL to revoke.
 */
function startWorker(): [Worker, string] {
  const workerUrl = new URL(workerPath, import.meta.url).href;
  const blobUrl = URL.createObjectURL(new Blob([`import ${JSON.stringify(workerUrl)};`], { type: "text/javascript" }));
  return [new Worker(blobUrl, { type: "module" }), blobUrl];
}

/**
 * The buffers of the ArrayBuffers and byte arrays inside `value` (plain objects and arrays), each
 * once (a buffer listed twice makes postMessage fail): what a request transfers.
 */
function buffersIn(value: unknown): ArrayBuffer[] {
  const found = new Set<ArrayBuffer>(), seen = new Set<object>();
  const visit = (v: unknown) => {
    if (v instanceof ArrayBuffer) found.add(v);
    else if (ArrayBuffer.isView(v)) {
      if (v.buffer instanceof ArrayBuffer) found.add(v.buffer);
    } else if (v && typeof v === "object" && !seen.has(v)) {
      seen.add(v);
      for (const x of Object.values(v)) visit(x);
    }
  };
  visit(value);
  return [...found];
}

export class EngineClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  /** Resolves when MuPDF has loaded in the worker (about 10 MB the first time, cached afterwards). */
  readonly ready: Promise<void>;

  constructor() {
    const [worker, blobUrl] = startWorker();
    this.worker = worker;
    let onReady!: () => void, onFail!: (e: Error) => void;
    this.ready = new Promise((res, rej) => { onReady = res; onFail = rej; });
    // Once the worker has answered (or failed), its module is loaded: the blob URL is not needed.
    this.ready.then(() => URL.revokeObjectURL(blobUrl), () => URL.revokeObjectURL(blobUrl));
    this.worker.onmessage = ({ data }: MessageEvent<ResponseMessage>) => {
      if ("type" in data) {
        if (data.type === "ready") onReady();
        else onFail(new EngineError(data.error, "init"));
        return;
      }
      const p = this.pending.get(data.id);
      if (!p) return;
      this.pending.delete(data.id);
      if (data.ok) p.resolve(data.result);
      else p.reject(new EngineError(data.error, data.code));
    };
    this.worker.onerror = (e) => {
      const err = new EngineError(e.message || "The PDF engine stopped", "crashed");
      onFail(err);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
  }

  async call<K extends Op>(req: RequestOf<K>, transfer: Transferable[] = []): Promise<ResultMap[K]> {
    await this.ready;
    const id = this.nextId++;
    return new Promise<ResultMap[K]>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ ...req, id }, transfer); // the message id last: nothing in a request can replace it
    });
  }

  /** The bytes are transferred to the worker: the caller's ArrayBuffer becomes empty. */
  open(bytes: ArrayBuffer, password?: string) {
    return this.call<"open">({ op: "open", bytes, password }, [bytes]);
  }
  render(pageIndex: number, scale: number) {
    return this.call<"render">({ op: "render", pageIndex, scale });
  }
  lines(pageIndex: number) {
    return this.call<"lines">({ op: "lines", pageIndex });
  }
  replaceLine(pageIndex: number, lineIndex: number, text: string, options?: LineEditOptions) {
    return this.call<"replaceLine">({ op: "replaceLine", pageIndex, lineIndex, text, ...(options ? { options } : {}) });
  }
  lineDecorations(pageIndex: number, lineIndex: number) {
    return this.call<"lineDecorations">({ op: "lineDecorations", pageIndex, lineIndex });
  }
  search(query: string, from: number, opts: { options?: SearchOptions; to?: number; budgetMs?: number; maxHits?: number } = {}) {
    return this.call<"search">({ op: "search", query, from, ...opts });
  }
  redactPreview(areas: RedactArea[], mode: RedactMode) {
    return this.call<"redactPreview">({ op: "redactPreview", areas, mode });
  }
  redact(areas: RedactArea[], mode: RedactMode) {
    return this.call<"redact">({ op: "redact", areas, mode });
  }
  images(pageIndex: number) {
    return this.call<"images">({ op: "images", pageIndex });
  }
  transformImage(pageIndex: number, imageIndex: number, matrix: Matrix) {
    return this.call<"transformImage">({ op: "transformImage", pageIndex, imageIndex, matrix });
  }
  deleteImage(pageIndex: number, imageIndex: number) {
    return this.call<"deleteImage">({ op: "deleteImage", pageIndex, imageIndex });
  }
  /** The bytes are transferred to the worker: the caller's ArrayBuffer becomes empty. */
  replaceImage(pageIndex: number, imageIndex: number, bytes: ArrayBuffer) {
    return this.call<"replaceImage">({ op: "replaceImage", pageIndex, imageIndex, bytes }, [bytes]);
  }
  renderImage(pageIndex: number, imageIndex: number, scale: number) {
    return this.call<"renderImage">({ op: "renderImage", pageIndex, imageIndex, scale });
  }
  fields(pageIndex: number) {
    return this.call<"fields">({ op: "fields", pageIndex });
  }
  setField(name: string, value: FieldValue) {
    return this.call<"setField">({ op: "setField", name, value });
  }
  addText(pageIndex: number, origin: [number, number], text: string, style: TextStyle) {
    return this.call<"addText">({ op: "addText", pageIndex, origin, text, style });
  }
  addedTexts(pageIndex: number) {
    return this.call<"addedTexts">({ op: "addedTexts", pageIndex });
  }
  editAddedText(pageIndex: number, id: number, patch: { text?: string; origin?: [number, number]; style?: TextStyle }) {
    return this.call<"editAddedText">({ op: "editAddedText", pageIndex, addedId: id, ...patch });
  }
  /** The bytes are transferred to the worker: the caller's ArrayBuffer becomes empty. */
  addImage(bytes: ArrayBuffer, targets: ImageTarget[], alt: string | null) {
    return this.call<"addImage">({ op: "addImage", bytes, targets, alt }, [bytes]);
  }
  undo() {
    return this.call<"undo">({ op: "undo" });
  }
  redo() {
    return this.call<"redo">({ op: "redo" });
  }
  save(options: SaveOptions = { format: "pdf", password: { mode: "none" } }) {
    return this.call<"save">({ op: "save", options });
  }
  pdfaCheck() {
    return this.call<"pdfaCheck">({ op: "pdfaCheck" });
  }
  close() {
    return this.call<"close">({ op: "close" });
  }
  /** One page operation. A "pictures" operation's bytes are transferred: the caller's ArrayBuffers become empty. */
  editPages(edit: PagesEdit) {
    return this.call<"editPages">({ op: "editPages", edit }, edit.kind === "pictures" ? buffersIn(edit.pictures) : []);
  }
  /** The bytes are transferred to the worker: the caller's ArrayBuffer becomes empty. */
  openSource(bytes: ArrayBuffer, password?: string) {
    return this.call<"openSource">({ op: "openSource", bytes, password }, [bytes]);
  }
  renderSource(source: number, pageIndex: number, scale: number) {
    return this.call<"renderSource">({ op: "renderSource", source, pageIndex, scale });
  }
  closeSource(source: number) {
    return this.call<"closeSource">({ op: "closeSource", source });
  }
  extractPages(pages: number[], options: SaveOptions = { format: "pdf", password: { mode: "none" } }) {
    return this.call<"extractPages">({ op: "extractPages", pages, options });
  }
  /** The pictures' bytes are transferred: the caller's ArrayBuffers become empty. */
  newFromPictures(pictures: PagePicture[]) {
    return this.call<"newFromPictures">({ op: "newFromPictures", pictures }, buffersIn(pictures));
  }
  exportSession() {
    return this.call<"exportSession">({ op: "exportSession" });
  }
  /** The original and the log's byte arrays are transferred: the caller's buffers become empty. */
  resumeSession(original: ArrayBuffer, log: unknown, password?: string) {
    return this.call<"resumeSession">({ op: "resumeSession", original, log, password }, buffersIn([original, log]));
  }
  terminate() {
    this.worker.terminate();
  }
}
