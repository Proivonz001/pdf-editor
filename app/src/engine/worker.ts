// Module Web Worker: owns the document. It only turns protocol messages into EngineSession calls
// (src/engine/session.ts) and their results into messages, transferring bitmaps and bytes.
import type { Op, RequestMessage, ResponseMessage, ResultMap } from "./protocol";
import { EngineSession, SessionError } from "./session";

const scope = self as unknown as DedicatedWorkerGlobalScope;

function post(message: ResponseMessage, transfer: Transferable[] = []) {
  scope.postMessage(message, { transfer });
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

// MuPDF (about 10 MB of WebAssembly) loads with a top-level await inside the package. A dynamic
// import, unlike a static one, lets a failed load be reported as "init-error" instead of an
// opaque worker error. Vite turns the package's new URL("mupdf-wasm.wasm", import.meta.url)
// into the hashed asset URL, so the .wasm is found next to the built chunks.
const engine: Promise<EngineSession> = import("mupdf").then((mupdf) => new EngineSession(mupdf));
engine.then(
  () => post({ type: "ready" }),
  (err) => post({ type: "init-error", error: errorMessage(err) }),
);

// One request at a time, in arrival order. The session is synchronous; the queue only matters
// across the awaits (MuPDF loading, createImageBitmap) and keeps replies in request order.
let queue: Promise<void> = Promise.resolve();
scope.onmessage = ({ data }: MessageEvent<RequestMessage>) => {
  queue = queue.then(() => handle(data));
};

async function handle(msg: RequestMessage) {
  try {
    const session = await engine;
    const [result, transfer] = await run(session, msg);
    post({ id: msg.id, ok: true, result }, transfer);
  } catch (err) {
    const code = err instanceof SessionError ? err.code : "engine";
    post({ id: msg.id, ok: false, error: errorMessage(err), code });
  }
}

type Reply<K extends Op> = [ResultMap[K], Transferable[]];

async function run(s: EngineSession, msg: RequestMessage): Promise<Reply<Op>> {
  switch (msg.op) {
    case "open":
      // The bytes arrived with this message (transferred by the client) and nothing else in
      // the worker holds them: the session keeps this buffer as the original, not a copy.
      return reply<"open">(s.open(msg.bytes, msg.password, { transfer: true }));
    case "render": {
      const { width, height, rgba, scale } = s.render(msg.pageIndex, msg.scale);
      const bitmap = await createImageBitmap(new ImageData(rgba, width, height));
      return reply<"render">({ bitmap, width, height, scale }, [bitmap]);
    }
    case "lines":
      return reply<"lines">(s.lines(msg.pageIndex));
    case "replaceLine":
      return reply<"replaceLine">(s.replaceLine(msg.pageIndex, msg.lineIndex, msg.text, msg.options));
    case "lineDecorations":
      return reply<"lineDecorations">(s.lineDecorations(msg.pageIndex, msg.lineIndex));
    case "images":
      return reply<"images">(s.images(msg.pageIndex));
    case "transformImage":
      return reply<"transformImage">(s.transformImage(msg.pageIndex, msg.imageIndex, msg.matrix));
    case "deleteImage":
      return reply<"deleteImage">(s.deleteImage(msg.pageIndex, msg.imageIndex));
    case "replaceImage":
      // Transferred like the bytes of "open": the session keeps this buffer in its log, not a copy.
      return reply<"replaceImage">(s.replaceImage(msg.pageIndex, msg.imageIndex, msg.bytes, { transfer: true }));
    case "renderImage": {
      const { width, height, rgba, scale, rect } = s.renderImage(msg.pageIndex, msg.imageIndex, msg.scale);
      const bitmap = await createImageBitmap(new ImageData(rgba, width, height));
      return reply<"renderImage">({ bitmap, width, height, scale, rect }, [bitmap]);
    }
    case "fields":
      return reply<"fields">(s.fields(msg.pageIndex));
    case "setField":
      return reply<"setField">(s.setField(msg.name, msg.value));
    case "addText":
      return reply<"addText">(s.addText(msg.pageIndex, msg.origin, msg.text, msg.style));
    case "addedTexts":
      return reply<"addedTexts">(s.addedTexts(msg.pageIndex));
    case "editAddedText":
      return reply<"editAddedText">(s.editAddedText(msg.pageIndex, msg.addedId, { text: msg.text, origin: msg.origin, style: msg.style }));
    case "addImage":
      // Transferred like the bytes of "replaceImage": the session keeps this buffer in its log, not a copy.
      return reply<"addImage">(s.addImage(msg.bytes, msg.targets, msg.alt, { transfer: true }));
    case "undo":
      return reply<"undo">(s.undo());
    case "redo":
      return reply<"redo">(s.redo());
    case "save": {
      const result = s.save(msg.options);
      return reply<"save">(result, [result.bytes]);
    }
    case "pdfaCheck":
      return reply<"pdfaCheck">(s.pdfaCheck());
    case "close":
      return reply<"close">(s.close());
    case "editPages":
      // A "pictures" operation's bytes arrived transferred, like those of "addImage": the session keeps them in its log.
      return reply<"editPages">(s.editPages(msg.edit, { transfer: true }));
    case "openSource":
      return reply<"openSource">(s.openSource(msg.bytes, msg.password));
    case "renderSource": {
      const { width, height, rgba, scale } = s.renderSource(msg.source, msg.pageIndex, msg.scale);
      const bitmap = await createImageBitmap(new ImageData(rgba, width, height));
      return reply<"renderSource">({ bitmap, width, height, scale }, [bitmap]);
    }
    case "closeSource":
      return reply<"closeSource">(s.closeSource(msg.source));
    case "extractPages": {
      const result = s.extractPages(msg.pages, msg.options);
      return reply<"extractPages">(result, [result.bytes]);
    }
    case "newFromPictures":
      // Transferred like the bytes of "open" and "addImage": the session keeps them, not copies.
      return reply<"newFromPictures">(s.newFromPictures(msg.pictures, { transfer: true }));
    case "exportSession": {
      // Every byte array in it is a copy of its own (exportSession): all of them are transferred.
      const result = s.exportSession();
      return reply<"exportSession">(result, result ? buffersIn(result) : []);
    }
    case "resumeSession":
      // The original and the log's byte arrays arrived with this message: the session keeps them as they are.
      return reply<"resumeSession">(s.resumeSession(msg.original, msg.log, msg.password, { transfer: true }));
    case "search":
      return reply<"search">(s.search(msg.query, msg.from, { options: msg.options, to: msg.to, budgetMs: msg.budgetMs, maxHits: msg.maxHits }));
    case "redactPreview":
      return reply<"redactPreview">(s.redactPreview(msg.areas, msg.mode));
    case "redact":
      return reply<"redact">(s.redact(msg.areas, msg.mode));
    default: {
      const unknown: never = msg;
      throw new Error(`Unknown request ${JSON.stringify(unknown)}`);
    }
  }
}

/** Ties each result to its op's type in ResultMap. */
function reply<K extends Op>(result: ResultMap[K], transfer: Transferable[] = []): Reply<K> {
  return [result, transfer];
}

/** The buffers of the byte arrays inside `value` (plain objects and arrays), each once: what a reply can transfer. */
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
