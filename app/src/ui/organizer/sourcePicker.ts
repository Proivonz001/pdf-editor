// The flow of "Da un altro PDF…" (the insert-from-pdf dialog, InsertFromPdfDialog.tsx), apart
// from its looks so the tests can run it with a fake engine: a PDF chosen (or dropped between
// the thumbnails) is opened read-only beside the document (pageActions.openSourceFile); its
// password asked when it has one, inline; a file too big, damaged or not a PDF said as such; its
// pages offered with check boxes (all of them at first, "Tutte" for all or none); then
// "Aggiungi" adds the chosen ones (all: "all") at the place the dialog was opened for, with a
// bookmark named after the file, as one edit.
//
// The other PDF stays open in the engine only while the dialog needs it: closing the dialog (or
// choosing another file) closes it, and after "Aggiungi" it is closed once the pages are in. A
// file still opening when the dialog closes is closed as soon as it opens.
//
// The engine keeps one other PDF at a time: opening one closes the one before. An insert waits
// its turn in the engine's queue (behind a download being written, a large insert still running)
// and needs its PDF open until it runs, so a PDF chosen meanwhile (the dialog opened again, a
// file dropped on the thumbnails) is opened only once the inserts already asked for have run and
// closed theirs; until then its picker says it is opening it.
import { signal } from "@preact/signals";
import type { PageInfo, RenderResult } from "../../engine/protocol";
import { closeSourceFile, insertFromSource, openSourceFile, renderSourcePage } from "../pageActions";
import { isPdfFile } from "../actions";

/** The inserts handed over by "Aggiungi" and not yet done (their PDF still open in the engine). */
let inserting: Promise<unknown> = Promise.resolve();

/** Resolves once every insert asked for so far has run (or was dropped) and closed its PDF. */
async function insertsDone(): Promise<void> {
  for (;;) {
    const asked = inserting;
    await asked;
    if (asked === inserting) return;
  }
}

export type PickerState =
  | { stage: "choose" }
  | { stage: "loading"; name: string }
  | { stage: "password"; name: string; wrong: boolean }
  | { stage: "error"; name: string; reason: "too-big" | "damaged" | "not-pdf" }
  | {
    stage: "pages";
    name: string;
    source: number;
    pages: PageInfo[];
    /** The pages to add, by index in the other PDF. */
    chosen: ReadonlySet<number>;
  };

/** The bookmark that leads to the added pages: the file's name without ".pdf". */
export function bookmarkTitle(fileName: string): string | null {
  const name = fileName.replace(/\.pdf$/i, "").trim();
  return name || null;
}

export class SourcePicker {
  readonly state = signal<PickerState>({ stage: "choose" });
  private file: File | null = null;
  /** The other PDF open in the engine for this picker, until it is closed or handed to the insert. */
  private source: number | null = null;
  /** Bumped by every open: the answer of an older one is closed, not shown. */
  private seq = 0;
  private closed = false;

  /** Open `file` (the one before is closed first). */
  choose(file: File): Promise<void> {
    this.file = file;
    if (!isPdfFile(file)) {
      this.release();
      this.state.value = { stage: "error", name: file.name, reason: "not-pdf" };
      return Promise.resolve();
    }
    return this.open(undefined);
  }

  /** The password typed for the file chosen. */
  submitPassword(password: string): Promise<void> {
    if (!this.file || !password) return Promise.resolve();
    return this.open(password);
  }

  private async open(password: string | undefined): Promise<void> {
    const file = this.file;
    if (!file || this.closed) return;
    this.release();
    const seq = ++this.seq;
    this.state.value = { stage: "loading", name: file.name };
    await insertsDone(); // opening it would close the PDF an insert still waiting needs
    if (this.closed || seq !== this.seq) return; // closed meanwhile, or another file chosen: never opened
    const result = await openSourceFile(file, password);
    if (this.closed || seq !== this.seq) {
      if (result.ok) void closeSourceFile(result.source); // nobody wants it any more
      return;
    }
    if (result.ok) {
      this.source = result.source;
      const all = new Set(result.pages.map((_, i) => i));
      this.state.value = { stage: "pages", name: file.name, source: result.source, pages: result.pages, chosen: all };
    } else if (result.reason === "password-required" || result.reason === "wrong-password") {
      // Asked again after a password was given: it was wrong.
      this.state.value = { stage: "password", name: file.name, wrong: password !== undefined };
    } else {
      this.state.value = { stage: "error", name: file.name, reason: result.reason };
    }
  }

  /** Page `index` of the other PDF in or out of the pages to add. */
  toggle(index: number) {
    const s = this.state.peek();
    if (s.stage !== "pages" || index < 0 || index >= s.pages.length) return;
    const chosen = new Set(s.chosen);
    if (chosen.has(index)) chosen.delete(index);
    else chosen.add(index);
    this.state.value = { ...s, chosen };
  }

  /** "Tutte": every page (`on`), or none. */
  setAll(on: boolean) {
    const s = this.state.peek();
    if (s.stage !== "pages") return;
    this.state.value = { ...s, chosen: on ? new Set(s.pages.map((_, i) => i)) : new Set() };
  }

  /** The pages to add: "all", the chosen ones in page order, or null when none is chosen. */
  chosenPages(): number[] | "all" | null {
    const s = this.state.peek();
    if (s.stage !== "pages" || s.chosen.size === 0) return null;
    if (s.chosen.size === s.pages.length) return "all";
    return [...s.chosen].sort((a, b) => a - b);
  }

  /** A page of the other PDF for its thumbnail (the caller closes the bitmap), or null. */
  render(index: number, scale: number): Promise<RenderResult | null> {
    const s = this.state.peek();
    if (s.stage !== "pages" || this.closed) return Promise.resolve(null);
    return renderSourcePage(s.source, index, scale);
  }

  /**
   * "Aggiungi": the chosen pages at `at` (a page operation, with its toast), then the other PDF
   * closed. The picker is done with it from here: closing the dialog no longer closes it. False
   * when there was nothing to add.
   */
  async add(at: number): Promise<boolean> {
    const s = this.state.peek();
    const pages = this.chosenPages();
    if (s.stage !== "pages" || pages === null || this.source !== s.source) return false;
    const source = s.source;
    this.source = null; // the insert has it now
    this.dispose();
    const run = (async () => {
      try {
        await insertFromSource(source, pages, at, bookmarkTitle(s.name));
      } finally {
        await closeSourceFile(source);
      }
    })();
    inserting = Promise.allSettled([inserting, run]); // a PDF chosen meanwhile opens after it
    await run;
    return true;
  }

  /** The dialog closed: the other PDF is closed (unless "Aggiungi" took it), and an open on its way too. */
  dispose() {
    this.closed = true;
    this.seq++;
    this.release();
  }

  private release() {
    const source = this.source;
    this.source = null;
    if (source !== null) void closeSourceFile(source);
  }
}
