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
      return reply<"replaceLine">(s.replaceLine(msg.pageIndex, msg.lineIndex, msg.text));
    case "undo":
      return reply<"undo">(s.undo());
    case "redo":
      return reply<"redo">(s.redo());
    case "save": {
      const { bytes } = s.save();
      return reply<"save">({ bytes }, [bytes]);
    }
    case "close":
      return reply<"close">(s.close());
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
