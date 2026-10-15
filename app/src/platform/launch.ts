// "Open with": once the app is installed on a desktop Chromium browser, the manifest's
// file_handlers (vite.config.ts) register it for PDF files. When the user opens a PDF with it,
// the browser starts the app and hands the files over through window.launchQueue
// (File Handling API). Elsewhere (Firefox, Safari, phones, a plain browser tab) the API does
// not exist and this module does nothing.

// Minimal local declarations: the File Handling API is not in TypeScript's DOM library yet.
interface LaunchParams {
  /** The files the app was launched with; empty when it was simply started. */
  readonly files: readonly FileSystemHandle[];
}

interface LaunchQueue {
  /** The consumer receives the launch that started the page (if any) and every later one. */
  setConsumer(consumer: (params: LaunchParams) => void): void;
}

/** True for a PDF: by MIME type, or by extension when the system gives no type. */
function isPdf(file: File): boolean {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}

/**
 * Call `cb` with the PDF the app is launched with ("Open with" / double-click once the app is
 * the handler). The app holds one document at a time, so when several files are launched
 * together only the last readable PDF is opened: opening them one after the other would only
 * race (and ask about unsaved edits once per file). Other files are ignored, as are files that
 * can no longer be read. Call once at startup: the browser queues launches until a consumer is
 * set.
 */
export function onLaunchFiles(cb: (file: File) => void): void {
  if (typeof window === "undefined") return;
  const queue = (window as Window & { launchQueue?: LaunchQueue }).launchQueue;
  if (!queue || typeof queue.setConsumer !== "function") return;

  queue.setConsumer((params) => {
    void (async () => {
      const handles = [...(params.files ?? [])].reverse();
      for (const handle of handles) {
        if (handle.kind !== "file") continue;
        let file: File;
        try {
          file = await (handle as FileSystemFileHandle).getFile();
        } catch (err) {
          // The file was moved or deleted, or the permission was withdrawn: skip it.
          console.warn("Could not read a launched file", err);
          continue;
        }
        if (isPdf(file)) {
          cb(file);
          return;
        }
      }
    })();
  });
}
