// The scan worker (module Web Worker): analyses photos and turns them into pages, off the main
// thread, in plain JavaScript (no MuPDF: a second copy of its 10 MB of WebAssembly, whose memory
// never shrinks, would stay for the whole session). It is short-lived: scanClient.ts starts it
// when the scan flow needs it and terminates it when the flow closes, which frees everything.
// This file only passes messages; the work is in scanJobs.ts.
import { replyTo } from "./scanJobs";
import type { ScanRequest } from "./types";

const scope = self as unknown as DedicatedWorkerGlobalScope;

// One request at a time, in arrival order: the work is synchronous apart from decoding and
// encoding, and only one photo's pixels are kept.
let queue: Promise<void> = Promise.resolve();
scope.onmessage = ({ data }: MessageEvent<ScanRequest & { id: number }>) => {
  queue = queue.then(async () => {
    const [message, transfer] = await replyTo(data);
    try {
      scope.postMessage(message, { transfer });
    } catch (err) {
      // The reply could not be cloned or transferred: the caller must not wait for ever.
      scope.postMessage({ id: data.id, ok: false, error: err instanceof Error ? err.message : String(err), code: "failed" });
    }
  });
};
