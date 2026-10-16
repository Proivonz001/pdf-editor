// What the buttons, shortcuts, the line editor, the image frame and the fill layer do: open,
// close, the tools (Modifica, Compila e firma), edit a line, select, move, delete or replace an
// image, write text anywhere, fill form fields, place signatures, initials (on every page too) and
// pictures (with a tap, or in the middle from the keyboard), keep signatures on the device and say
// when that fails, undo/redo, download (one tap, or with options: PDF/A,
// password; asking first about empty required fields), share, update. Engine changes run one at
// a time (a promise chain), so an Undo clicked while an edit is being written applies after it,
// never in between. Download, share, open, close, update, undo, redo and changing the tool first
// write what is still typed in the line editor or the text writer, or an image's keyboard move
// still waiting (flushEditor), so it is neither left out of the file nor lost without a warning.
import { batch, effect } from "@preact/signals";
import { EngineError } from "../engine/client";
import {
  MAX_ALT_CHARS, MAX_IMAGE_SIDE, MAX_TEXT_SIZE, MIN_IMAGE_SIDE, MIN_TEXT_SIZE,
  type AddedText, type DocInfo, type FieldValue, type FieldWidget, type ImageEditResult, type ImageInfo,
  type ImageLockReason, type ImageTarget, type LineInfo, type Matrix, type PdfaReport, type Rect, type SaveFormat,
  type SaveOptions, type SavePassword, type TextStyle,
} from "../engine/protocol";
import { formatMm, locale, t } from "../i18n";
import { applyUpdate } from "../platform/pwa";
import {
  busy, confirmDialog, countImageEdit, currentPage, dialog, dismissToast, doc, downloadRunning, editingLine,
  editingStopped, editMode, engine, engineStatus, fillMode, fillTool, fitMode, flushEditor, focusedField, focusRequest,
  hasUnsavedWork, history, imageEditsPending, INK, initialsSource, markSaved, opening, openWriter, pendingPlacement,
  recordHistory, resetHistory, resetImageEdits, saveKey, selectedImage, sessionSignatures, sheet, showDialog,
  showToast, tool, typingField, writerStyle, zoom,
  type BusyKind, type DialogState, type FillTool, type InkColor, type OpenWriter, type SavePurpose, type Signature,
  type Tool,
} from "../state";
import { createPages, type OpenDoc, type PageModel } from "../viewer/model";
import { goToPage } from "../viewer/zoom";
import { dateText } from "./fill/dates";
import { anchorOf, placeOn, rectMatrix, signatureInField, signatureRect, writerOrigin } from "./fill/geometry";
import {
  forget as forgetStored, list as listStored, MAX_SAVED, save as saveStored,
} from "./fill/signatureStore";
import { rescueFocus, viewerScroller } from "./focus";
import { PictureError, preparePicture } from "./imageFile";
import { isCoarse } from "./media";

// ---------------------------------------------------------------------------------------------
// Helpers

let chain: Promise<unknown> = Promise.resolve();
/** The chain as of the last change asked for (an edit, undo or redo): settled once all of them have run. */
let lastChange: Promise<unknown> = Promise.resolve();

/** Run engine changes one after the other, with `busy` set while each runs. */
function exclusive<T>(kind: BusyKind, fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    busy.value = kind;
    try {
      return await fn();
    } finally {
      busy.value = null;
    }
  });
  chain = run.catch(() => undefined);
  if (kind === "edit" || kind === "undo" || kind === "redo") lastChange = chain;
  return run;
}

/** Resolves when no image edit of the open document is on its way (imageEditsPending is 0). */
function noImageEdits(): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const stop = effect(() => {
      if (done || imageEditsPending.value > 0) return;
      done = true;
      resolve();
      queueMicrotask(() => stop()); // not from within the effect's first run
    });
  });
}

/**
 * Resolves once every change asked for so far has landed: the edits, undos and redos in the
 * engine's queue (and what waits before them, a download say), and, with `images`, the image
 * edits still on their way (a picture being prepared, a placement). Changes asked for meanwhile
 * are waited for too. A page revision read afterwards includes them all.
 */
async function changesLanded(images = true): Promise<void> {
  for (;;) {
    const asked = lastChange;
    await asked;
    if (images && imageEditsPending.peek() > 0) {
      await noImageEdits();
      continue;
    }
    if (asked === lastChange) return;
  }
}

function isAbort(e: unknown) {
  return e instanceof DOMException && e.name === "AbortError";
}

/**
 * Show an engine failure: a crashed worker, a line the engine refuses to rewrite (or what
 * `notEditable` says the engine refused: a locked field, a page that cannot take new content)
 * and a document the engine could not restore are reported as such, anything else with `message`.
 */
function reportEngineError(e: unknown, message: string, notEditable = t("edit.notEditable")) {
  const code = e instanceof EngineError ? e.code : undefined;
  if (code === "not-editable") {
    showToast("info", notEditable);
    return;
  }
  console.error(e);
  if (code === "crashed" || code === "init") {
    engineStatus.value = "error";
    showToast("error", t("engine.crashed"));
  } else if (code === "broken") {
    // The first time: stop editing and explain. Later (e.g. a download that could not rebuild
    // the last good state either): say that this action failed too.
    if (editingStopped.peek()) showToast("error", message);
    else stopEditing();
  } else {
    showToast("error", message);
  }
}

/**
 * An edit failed and the engine could not put the document back ("broken"): no more edits,
 * undo or redo on it. What it holds can still be downloaded; a reload starts clean.
 */
function stopEditing() {
  if (editingStopped.peek()) return;
  batch(() => {
    editingStopped.value = true;
    tool.value = null;
    clearOpenWork();
  });
  showDialog({ kind: "alert", title: t("broken.title"), body: t("broken.body") });
}

/**
 * Bumped whenever a text writer is asked for (openWriterAt), and when what is open goes: a writer
 * still on its way then does not open (the user has asked for something else since).
 */
let writerAsks = 0;

/**
 * Close what is open on the pages: the line editor, the image selection, the text writer (and one
 * still on its way), a signature waiting to be placed, the focused field. Nothing is written
 * (flushEditor first for that). Firma and Sigla, without their signature, go back to Testo.
 * `forStep`: for an undo or redo about to run, which may change the pages' indices. A new text's
 * writer, opened since the step was asked for (a tap while it waited its turn), stays open with
 * what is typed: it has no index to go stale. One still on its way, asked for after the step,
 * opens after it (openWriterAt waits for the changes asked for before).
 */
function clearOpenWork(forStep = false) {
  if (!forStep) writerAsks++;
  batch(() => {
    editingLine.value = null;
    selectedImage.value = null;
    if (!forStep || openWriter.peek()?.editing !== null) openWriter.value = null;
    pendingPlacement.value = null;
    focusedField.value = null;
    const sub = fillTool.peek();
    if (sub === "signature" || sub === "initials" || sub === "image") fillTool.value = "text";
  });
}

export function isPdfFile(file: File) {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}

/**
 * "report.pdf" → "report-edited.pdf" (IT: "report-modificato.pdf"); as PDF/A
 * "report-edited-PDFA.pdf" (a source already called "…-PDFA" does not get it twice).
 */
export function outputName(fileName: string, format: SaveFormat = "pdf") {
  const base = fileName.replace(/\.pdf$/i, "") || "document";
  if (format === "pdf") return `${base}${t("download.suffix")}.pdf`;
  return `${base.replace(/-PDFA$/i, "") || "document"}${t("download.suffix")}-PDFA.pdf`;
}

// ---------------------------------------------------------------------------------------------
// Open

let openSeq = 0;

/**
 * Open `file`. Asks first when there are edits not downloaded (unless `confirmed`), and shows
 * the password dialog or a clear error when the engine cannot open it.
 */
export async function openFile(file: File, opts: { password?: string; confirmed?: boolean } = {}) {
  await flushEditor(); // typed text becomes an edit, so the question below covers it
  if (!opts.confirmed && hasUnsavedWork()) {
    const ok = await confirmDialog({
      title: t("unsaved.title"),
      body: t("unsaved.openBody"),
      confirmLabel: t("unsaved.openConfirm"),
    });
    if (!ok) return;
  }
  const seq = ++openSeq;
  batch(() => {
    clearOpenWork();
    focusRequest.value = null;
    typingField.value = false; // its form controls go with it, perhaps without a blur
    initialsSource.value = null;
    resetImageEdits(); // those of the document before end on their own, written nowhere
    editingStopped.value = false;
    sheet.value = null;
    doc.value = null;
    opening.value = file.name;
  });
  resetHistory();
  try {
    const bytes = await file.arrayBuffer();
    // Another open started while this file was being read (a second drop, "Open with" on two
    // files): it goes to the engine instead. Sending this one too could reach the worker after
    // it, leaving the engine with a different file than the one on screen.
    if (seq !== openSeq) return;
    const result = await engine().open(bytes, opts.password);
    if (seq !== openSeq) return;
    if (result.ok) {
      const info: DocInfo = {
        pageCount: result.pageCount, pages: result.pages, encrypted: result.encrypted,
        needsPassword: result.needsPassword, canKeepPassword: result.canKeepPassword, pdfa: result.pdfa,
        signatures: result.signatures, form: result.form ?? null, title: result.title,
      };
      batch(() => {
        fitMode.value = true;
        currentPage.value = 0;
        doc.value = { id: seq, fileName: file.name, info, pages: createPages(info) };
      });
      void loadSavedSignatures();
    } else if (result.reason === "damaged") {
      showDialog({ kind: "alert", title: t("open.damagedTitle"), body: t("open.damaged", { name: file.name }) });
    } else {
      // A password was given and still "required": it was wrong.
      const wrong = result.reason === "wrong-password" || opts.password !== undefined;
      showDialog({ kind: "password", file, wrong });
    }
  } catch (e) {
    if (seq !== openSeq) return;
    console.error(e);
    if (e instanceof EngineError && (e.code === "crashed" || e.code === "init")) {
      engineStatus.value = "error"; // the empty state explains it
    } else {
      showDialog({ kind: "alert", title: t("open.damagedTitle"), body: t("open.failed", { name: file.name }) });
    }
  } finally {
    if (seq === openSeq) opening.value = null;
  }
}

let homeFocus = false;

/**
 * For the home page, once when it mounts: true right after closeDocument(), when the focus should
 * move to it (the Close or Back button that had it is gone). Not on the first load.
 */
export function takeHomeFocus(): boolean {
  const take = homeFocus;
  homeFocus = false;
  return take;
}

/**
 * Close the document and go back to the home screen. Asks first when there are edits not
 * downloaded. An open still being read is abandoned too.
 */
export async function closeDocument() {
  await flushEditor();
  if (hasUnsavedWork()) {
    const ok = await confirmDialog({
      title: t("unsaved.title"),
      body: t("unsaved.closeBody"),
      confirmLabel: t("unsaved.closeConfirm"),
    });
    if (!ok) return;
  }
  const hadDoc = doc.peek() !== null;
  ++openSeq; // an open still in progress lands nowhere
  homeFocus = true; // the control that closed it is about to go: the home page takes the focus
  batch(() => {
    clearOpenWork();
    focusRequest.value = null;
    typingField.value = false; // its form controls go with it, perhaps without a blur
    initialsSource.value = null;
    resetImageEdits(); // one still queued ends on its own, written nowhere: no "unsaved" warning
    editingStopped.value = false;
    tool.value = null;
    sheet.value = null;
    doc.value = null;
    opening.value = null;
  });
  resetHistory();
  // Free the engine's copy (and its undo checkpoints). Nothing to report if it fails: the next
  // open replaces the document anyway.
  if (hadDoc) engine().close().catch((e: unknown) => console.warn("Closing the document failed", e));
}

// ---------------------------------------------------------------------------------------------
// Edit, undo, redo

/**
 * Turn a tool on (Modifica, Compila e firma), or none (browse). It first writes what the line
 * editor or the text writer holds (a tap on a tab does not always take the focus away from the
 * field, so blur cannot be relied on), or the selected image's keyboard move; then the line
 * editor, the image selection, the writer, a signature waiting to be placed and the focused field
 * close. A tool is refused without a document or once editing has stopped; turning off always works.
 */
export async function setTool(next: Tool): Promise<void> {
  const before = document.activeElement;
  await flushEditor();
  batch(() => {
    clearOpenWork();
    focusRequest.value = null; // the layers it was for change with the tool
    tool.value = next !== null && doc.peek() !== null && !editingStopped.peek() ? next : null;
    if (tool.peek() === "edit") typingField.value = false; // no form controls in Modifica
  });
  // The control that did it may go with the change (Done in the edit banner, Edit text in the
  // details panel, a line box when Esc leaves edit mode): keep the focus on the document.
  if (before && before !== document.body) rescueFocus(viewerScroller);
}

/** Modifica on or off (kept for the existing callers): setTool("edit") or setTool(null). */
export function setEditMode(on: boolean): Promise<void> {
  return setTool(on ? "edit" : null);
}

/**
 * Replace a whole line (rule 1: whole lines only). `rev` is the page revision the line was
 * read at: if the page changed since, its line indices are stale and nothing is written.
 */
export function replaceLine(page: PageModel, line: LineInfo, text: string, rev: number): Promise<void> {
  const d = doc.peek();
  return exclusive("edit", async () => {
    if (!d || doc.peek() !== d || editingStopped.peek()) return;
    if (page.rev.peek() !== rev) {
      showToast("error", t("edit.failed"));
      return;
    }
    try {
      const result = await engine().replaceLine(page.index, line.index, text);
      if (doc.peek() !== d) return;
      recordHistory(result, "edit");
      if (result.fallbackChars.length) {
        showToast("warn", t("edit.fallback", { chars: result.fallbackChars.join(" ") }));
      }
      if (result.missingChars.length) {
        showToast("error", t("edit.missing", { chars: result.missingChars.join(" ") }));
      }
    } catch (e) {
      reportEngineError(e, t("edit.failed"));
    }
  });
}

async function historyStep(step: "undo" | "redo") {
  const d = doc.peek();
  if (!d) return;
  // What the line editor or the writer holds, or an image's keyboard move still waiting, is the
  // latest change: written first, then undone (redo brings it back).
  await flushEditor();
  return exclusive(step, async () => {
    if (doc.peek() !== d || editingStopped.peek()) return;
    const h = history.peek();
    if (step === "undo" ? !h.canUndo : !h.canRedo) return;
    // Image indices may change with the step: the selection goes, as the line editor, a
    // reopened text's writer, a signature waiting to be placed and the focused field do (field
    // values are read again: recordHistory drops the pages' fields).
    batch(() => {
      clearOpenWork(true);
      initialsSource.value = null;
    });
    try {
      const state = step === "undo" ? await engine().undo() : await engine().redo();
      if (doc.peek() === d) recordHistory(state, step);
    } catch (e) {
      reportEngineError(e, t("history.failed"));
    }
  });
}

export const undo = () => historyStep("undo");
export const redo = () => historyStep("redo");

/**
 * Open the line editor on `line` (a click or tap on its box), deselecting the selected image. A
 * keyboard move of that image still waiting is written first; if it changed this page, the
 * line's index may be stale, so no editor opens (the line is clicked again). As for images,
 * nothing opens while an edit, undo or redo is being written or an image edit waits for its turn
 * (a Delete behind a download, say): when it lands the page is read again, which closes the
 * editor and would drop what was typed in it without a word.
 */
export async function openLine(pageIndex: number, line: LineInfo): Promise<void> {
  const d = doc.peek();
  const page = d?.pages[pageIndex];
  const canOpen = () => editMode.peek() && !editingStopped.peek() && !changing();
  if (!d || !page || !canOpen()) return;
  if (selectedImage.peek()) {
    const rev = page.rev.peek();
    await flushEditor();
    if (doc.peek() !== d) return;
    if (page.rev.peek() !== rev) {
      selectedImage.value = null;
      return;
    }
  }
  if (!canOpen()) return;
  batch(() => {
    selectedImage.value = null;
    editingLine.value = { pageIndex, line };
  });
}

// ---------------------------------------------------------------------------------------------
// Images
//
// In edit mode an image is selected with a click or a tap (in Compila e firma, only the pictures
// the user added: signatures, initials, photos), then moved, resized, rotated (all three are
// transformImage), deleted or replaced. Each change is one edit in the history, made like a line
// edit: one at a time, refused when the page changed since its images were read.
// The selection is an index in the page's image list, which an edit can change: it follows the
// edited image to its new index (none after a delete), and after a delete a selection on an
// image painted later moves one place up with it; undo, redo, changing the tool, open and close
// clear it. An image edit counts from the moment it is asked for (imageEditsPending), even when
// it waits behind a download: until it is done no other image is selected and no line opened, so
// nothing is picked on indices about to change, and a second Delete of the same image is the
// first one. Only the open document's edits count: opening or closing one starts again from 0.

/** Why an image cannot be moved, in words (for the toast, the box's label, the details panel). */
export function lockReasonText(reason: ImageLockReason | null): string {
  return t(`image.reason.${reason ?? "unreadable"}`);
}

/**
 * An edit, undo or redo is running, or an image edit of the open document waits for its turn:
 * the pages' image and line indices may be about to change.
 */
function changing() {
  const kind = busy.peek();
  return kind === "edit" || kind === "undo" || kind === "redo" || imageEditsPending.peek() > 0;
}

/** The open document, when `page` is one of its pages (not one of a document closed since). */
function docOf(page: PageModel): OpenDoc | null {
  const d = doc.peek();
  return d && d.pages[page.index] === page ? d : null;
}

/**
 * Count an image edit of `page` in imageEditsPending from now until it has finished: written,
 * refused or failed (or its document closed: countImageEdit). `edit` starts right away (its
 * place in the engine's queue is taken now). A page of a document closed already (an image
 * frame going away late, say) has nothing to edit: not counted, nothing sent.
 */
async function counted(page: PageModel, edit: () => Promise<void>): Promise<void> {
  if (!docOf(page)) return;
  const end = countImageEdit();
  try {
    await edit();
  } finally {
    end();
  }
}

/** The selection is on `image` of `page`. */
function isSelected(page: PageModel, image: ImageInfo) {
  const sel = selectedImage.peek();
  return sel !== null && sel.pageIndex === page.index && sel.index === image.index;
}

/**
 * Select `image` of page `pageIndex` (a click or tap on it), or deselect with null. A line edit,
 * the writer's text or an image's keyboard move still waiting is written first; if that changed
 * the page (its images were read at `rev`), their indices may be stale, so the selection is
 * cleared instead. A locked image says why and is not selected. Selecting closes the line editor
 * and the writer. Nothing is selected in browse mode, in Compila e firma unless the user added
 * it, while another change is being written (as for lines), or while an image edit waits for
 * its turn (behind a download, say). Deselecting always works.
 */
export async function selectImage(pageIndex: number, image: ImageInfo | null, rev?: number): Promise<void> {
  const d = doc.peek();
  if (!d) return;
  await flushEditor();
  if (doc.peek() !== d) return;
  if (!image) {
    selectedImage.value = null;
    return;
  }
  const on = tool.peek();
  if (on === null || (on === "fill" && !image.added) || editingStopped.peek() || changing()) return;
  const page = d.pages[pageIndex];
  if (!page || (rev !== undefined && page.rev.peek() !== rev)) {
    selectedImage.value = null;
    return;
  }
  if (!image.movable) {
    showToast("info", t("image.locked", { reason: lockReasonText(image.reason) }));
    return;
  }
  writerAsks++; // a text writer still on its way does not open over the selection
  batch(() => {
    editingLine.value = null;
    openWriter.value = null;
    selectedImage.value = { pageIndex, index: image.index };
  });
}

/**
 * After an image edit of `page` (image `edited`, now at `newIndex`, null after a delete), an
 * index that pointed at that page's images: the edited image's new one, one place up for an
 * image painted after a deleted one, the same otherwise.
 */
function followIndex(index: number, edited: number, newIndex: number | null): number | null {
  if (index === edited) return newIndex;
  return newIndex === null && index > edited ? index - 1 : index;
}

/**
 * Run one image edit in the engine. `current` says whether the image's index still holds (the
 * page has not changed since its images were read); if not, nothing is written. On success the
 * edit is recorded and the selection follows the image, unless the user selected another one
 * (or none, or left edit mode) while it was written. After a delete (no new index) the images
 * painted after it each move one place up, a selected one too.
 */
function editImage(
  page: PageModel, image: ImageInfo, current: () => boolean, send: () => Promise<ImageEditResult>,
): Promise<void> {
  const d = docOf(page);
  return exclusive("edit", async () => {
    if (!d || doc.peek() !== d || editingStopped.peek()) return;
    if (!current()) {
      showToast("error", t("image.failed"));
      return;
    }
    try {
      const result = await send();
      if (doc.peek() !== d) return;
      batch(() => {
        const sel = selectedImage.peek();
        recordHistory(result, "edit");
        const source = initialsSource.peek();
        if (source && source.docId === d.id && source.pageIndex === page.index) {
          const index = followIndex(source.imageIndex, image.index, result.imageIndex);
          if (index !== source.imageIndex) initialsSource.value = index === null ? null : { ...source, imageIndex: index };
        }
        if (!sel || sel.pageIndex !== page.index) return;
        const index = followIndex(sel.index, image.index, result.imageIndex);
        if (index !== sel.index) selectedImage.value = index === null ? null : { pageIndex: page.index, index };
      });
    } catch (e) {
      if (e instanceof EngineError && e.code === "not-editable") {
        showToast("info", t("image.notEditable"));
        if (isSelected(page, image)) selectedImage.value = null;
        return;
      }
      reportEngineError(e, t("image.failed"));
    }
  });
}

/**
 * Move, resize or rotate an image: `matrix` is where it is to be drawn (ImageInfo.matrix
 * convention). `rev` is the page revision its images were read at.
 */
export function transformImage(page: PageModel, image: ImageInfo, matrix: Matrix, rev: number): Promise<void> {
  return counted(page, () => editImage(
    page, image,
    () => page.rev.peek() === rev,
    () => engine().transformImage(page.index, image.index, matrix),
  ));
}

/** Deletions asked for and not finished yet, by document, page, revision and image. */
const deleting = new Map<string, Promise<void>>();

/**
 * Delete an image (`rev`: the page revision its images were read at). Delete pressed again
 * while the first one waits behind a download is that same deletion, not a second one (which
 * would then be refused as stale, with an error, although the image went as asked).
 */
export function deleteImage(page: PageModel, image: ImageInfo, rev: number): Promise<void> {
  const key = `${doc.peek()?.id ?? 0}:${page.index}:${rev}:${image.index}`;
  const queued = deleting.get(key);
  if (queued) return queued;
  const run = counted(page, () => editImage(
    page, image,
    () => page.rev.peek() === rev,
    () => engine().deleteImage(page.index, image.index),
  ));
  deleting.set(key, run);
  const forget = () => {
    if (deleting.get(key) === run) deleting.delete(key);
  };
  run.then(forget, forget);
  return run;
}

/**
 * Replace an image with the picture in `file`, prepared first (upright, scaled down, JPEG or
 * PNG: imageFile.ts). The engine fits it inside the image's current box, so only which
 * placement it is matters: when the page changed since `rev` through an edit of this very image
 * (a keyboard move written while the picker was open), the selection, which follows the image,
 * still says that it is the same index. It counts as pending from the moment the picture is
 * chosen, its preparation included.
 */
export function replaceImage(page: PageModel, image: ImageInfo, rev: number, file: File): Promise<void> {
  const d = docOf(page);
  if (!d || editingStopped.peek()) return Promise.resolve();
  return counted(page, async () => {
    // Decoding and encoding a large photo takes a moment: outside the engine's queue.
    const status = showToast("info", t("image.preparing"), 0);
    let bytes: ArrayBuffer;
    try {
      bytes = (await preparePicture(file)).bytes;
    } catch (e) {
      const tooBig = e instanceof PictureError && e.code === "too-big";
      if (!tooBig) console.warn("The picture could not be prepared", e);
      showToast("error", tooBig ? t("image.pictureTooBig") : t("image.pictureUnreadable"));
      return;
    } finally {
      dismissToast(status);
    }
    if (doc.peek() !== d) return;
    await editImage(
      page, image,
      () => page.rev.peek() === rev || isSelected(page, image),
      () => engine().replaceImage(page.index, image.index, bytes),
    );
  });
}

/** The input of the picture picker open now, if any. */
let picker: HTMLInputElement | null = null;

/** Replace… in the image's context bar: the system picker for a picture (pickPicture), then replaceImage. */
export function chooseReplacement(page: PageModel, image: ImageInfo, rev: number): void {
  if (!doc.peek() || editingStopped.peek()) return;
  // A keyboard move still waiting is written now, not while the picker is open.
  void flushEditor();
  pickPicture((file) => void replaceImage(page, image, rev, file));
}

/**
 * The system picker for a picture (camera and gallery both: no `capture`), then `onPick` with
 * the file chosen. The input is made for this pick and removed after it; it is attached (iOS
 * Safari opens pickers only for inputs in the document) and clicked right here, within the
 * user's click.
 */
function pickPicture(onPick: (file: File) => void): void {
  picker?.remove(); // left over from a pick cancelled where "cancel" is not fired
  const input = document.createElement("input");
  picker = input;
  input.type = "file";
  input.accept = "image/*";
  input.hidden = true;
  input.tabIndex = -1;
  input.setAttribute("aria-hidden", "true");
  const done = () => {
    input.remove();
    if (picker === input) picker = null;
  };
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    done();
    if (file) onPick(file);
  });
  input.addEventListener("cancel", done);
  document.body.append(input);
  input.click();
}

// ---------------------------------------------------------------------------------------------
// Compila e firma
//
// A tap in Compila e firma fills in a form field, reopens what the user wrote (a text, a mark, a
// date; a picture they added is selected instead), or uses the current sub-tool there: a text
// writer, a tick or a cross, today's date, the signature or initials chosen, a picture. Each of
// them is one edit in the history, made like a line edit: one at a time, through the engine's
// queue, recorded with recordHistory (which drops the pages' fields and added texts, so they are
// read again). An edit of an added text (by its id) or of a field (by its name) is refused when
// the page changed between the moment it was read (`rev`) and the moment the user acted: ids and
// names do not go stale as a line's index does, so edits already queued then, landing first, do
// not make it stale (a box ticked right after a writer's text was sent). For the same reason a
// text reopened in the writer opens once the changes asked for before have landed (an undo, a
// placement on its way), read again if they changed its page. A new text or picture carries only
// where it goes, in page space, which no change makes stale; it is kept on the page, the text
// inside it (originOnPage). A picture that lands while the writer or the line editor is open does
// not close it: it is placed, not selected. "Put it in the middle" (placeAtCentre) places what a
// tap would, from the keyboard, says what it wrote and where, and moves the focus onto it. Form
// fields also work with no tool on (browse), never in Modifica.

/** Marks are drawn a little larger than the text around them. */
const MARK_SCALE = 1.1;
/** Room a text takes above its baseline (capitals, accents) and below it (descenders), in em. */
const ASCENT = 0.8;
const DESCENT = 0.25;
/** "Line below": the next baseline, this many times the size lower. */
const LINE_STEP = 1.25;
/** The marks, real text in the embedded Dingbats font: ✓ U+2713 and ✗ U+2717. */
export const MARK_TEXT = { check: "✓", cross: "✗" } as const;
/** A date as dateText writes it, short ("16/10/2026", "10/16/2026") or long ("16 ottobre 2026", "October 16, 2026"). */
const DATE_LIKE = /^(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{1,2}\.? \p{L}+ \d{4}|\p{L}+ \d{1,2}, \d{4})$/u;

/** What a text written before is, to reopen it with the right controls: a mark, a date, or text. */
export function addedKind(text: string): OpenWriter["kind"] {
  const s = text.trim();
  if (s === MARK_TEXT.check) return "check";
  if (s === MARK_TEXT.cross) return "cross";
  return DATE_LIKE.test(s) ? "date" : "text";
}

/** Today's date as Data writes it: in the app's language; English follows the browser's region (D8). */
export function todayText(style: "short" | "long" = "short"): string {
  const languages = typeof navigator === "undefined" ? [] : [...(navigator.languages ?? [navigator.language])];
  return dateText(new Date(), locale.peek(), languages, style);
}

/** The ink nearest to `color` (a text written before), so reopening it changes nothing by itself. */
function inkOf(color: readonly number[]): InkColor {
  const away = (ink: InkColor) => INK[ink].reduce((sum, c, i) => sum + (c - (color[i] ?? 0)) ** 2, 0);
  return away("blue") < away("black") ? "blue" : "black";
}

/** The style of what the user writes: the app's sans fallback font (or the one it had), in one of the two inks. */
function inkStyle(size: number, color: InkColor, base?: TextStyle): TextStyle {
  const [r, g, b] = INK[color];
  return {
    size: Math.min(MAX_TEXT_SIZE, Math.max(MIN_TEXT_SIZE, size)),
    color: [r, g, b],
    family: base?.family ?? "sans",
    bold: base?.bold ?? false,
    italic: base?.italic ?? false,
  };
}

/** About how wide `text` is at `size` points: a Dingbats mark 0.8 em; text 0.56 em a character, at least two. */
function textWidth(text: string, size: number, mark: boolean): number {
  return mark ? 0.8 * size : 0.56 * size * Math.max(2, [...text].length);
}

/**
 * Where a new text starts (`at`, its baseline start), kept on the page `bounds` with the text
 * inside it: about `width` points wide, `size` points tall (capitals above the baseline,
 * descenders below). Every new text, mark and date goes through it (a tap near an edge, "Put it
 * in the middle", "Line below"), so none is sent off the page, which the engine refuses, or cut
 * by its edge. On a page too small for the text, the text still starts on the page.
 */
export function originOnPage(bounds: Rect, at: [number, number], size: number, width = 0): [number, number] {
  const [x0, y0, x1, y1] = bounds;
  const x = Math.max(x0, Math.min(at[0], x1 - Math.max(0, width)));
  const y = Math.max(y0 + ASCENT * size, Math.min(at[1], y1 - DESCENT * size));
  return [Math.min(x, x1), Math.min(Math.max(y, y0), y1)];
}

/** Writer commits under way, by writer: its Enter, Apply, blur and flushEditor all write it once. */
const committing = new WeakMap<OpenWriter, Promise<void>>();
/** The same commits, and marks and dates being written, to wait for before a writer opens (its page revision must include them). */
const writing = new Set<Promise<unknown>>();
/** The style of a text reopened in the writer, so a change of size or ink keeps its font. */
const reopenedStyle = new WeakMap<OpenWriter, TextStyle>();
/** The document each writer was opened on: a late commit never writes into another one. */
const writerDoc = new WeakMap<OpenWriter, OpenDoc>();

/**
 * Turn on a sub-tool of Compila e firma. Firma and Sigla open the signature sheet (the choice
 * then waits to be placed: useSignature); Immagine opens the picture picker and stays off
 * (addPictureFromFile). What the writer holds is written first.
 */
export function setFillTool(next: FillTool): void {
  if (!doc.peek() || !fillMode.peek() || editingStopped.peek()) return;
  const sheetFor = next === "signature" || next === "initials" ? next : null;
  if (sheetFor && dialog.peek()) return;
  void flushEditor();
  writerAsks++; // a writer still on its way (a text reopened during an undo) does not open after this
  if (next === "image") {
    pickPicture((file) => void addPictureFromFile(file));
    return;
  }
  batch(() => {
    pendingPlacement.value = null;
    fillTool.value = next;
    if (sheetFor) showDialog({ kind: "signature", mode: sheetFor, forField: null });
  });
}

// Firma or Sigla chosen, and its sheet closed without a signature to place: back to Testo.
effect(() => {
  if (dialog.value?.kind === "signature") return;
  const sub = fillTool.peek();
  if ((sub === "signature" || sub === "initials") && !pendingPlacement.peek()) fillTool.value = "text";
});

/** Cancel the signature or initials waiting to be placed (Esc, Cancel in the bar): back to Testo. */
export function cancelPlacement(): void {
  batch(() => {
    pendingPlacement.value = null;
    const sub = fillTool.peek();
    if (sub === "signature" || sub === "initials") fillTool.value = "text";
  });
}

interface WriterOptions {
  /** AddedText.id: reopen that text. */
  editing?: number;
  size?: number;
  color?: InkColor;
  /** The reopened text's own style (its font kept through a change of size or ink). */
  style?: TextStyle;
  /** The page revision the reopened text was read at (default: the page's current one). */
  readAt?: number;
}

/**
 * A tap in Compila e firma with Testo, ✓, ✗ or Data (`kind`) at `origin` (the baseline start,
 * page space). The writer still open is written first (a tap elsewhere: write it, then a new
 * writer there). "text" opens the writer with `text` (empty by default), in the last size and
 * ink used; a mark (✓ or ✗, 1.1 × that size) or the date (today's, unless `text`) is written at
 * once, one tap. A new one is kept on the page (originOnPage). `opts.editing` reopens a text
 * written before (its AddedText id), in a writer of its kind, with its size, ink and style
 * (reopenAdded), once the changes asked for before have landed. A writer still on its way when
 * another is asked for (or when a picture is selected, the tool changes...) does not open.
 * Resolves with where the text starts, as used: kept on the page (a tap near an edge moves it in),
 * or where the reopened text is now; null when nothing was written and no writer opened (refused,
 * failed, or asked for something else since). The fill layer draws its copy and says where there.
 */
export async function openWriterAt(
  pageIndex: number, origin: [number, number], kind: OpenWriter["kind"], text?: string, opts: WriterOptions = {},
): Promise<[number, number] | null> {
  return (await openOrWrite(pageIndex, origin, kind, text, opts))?.origin ?? null;
}

/**
 * What openWriterAt did: on which page and where the text starts (page space); for a mark or a
 * date written at once, its id (AddedText.id); null for a writer opened.
 */
interface Opened {
  pageIndex: number;
  origin: [number, number];
  id: number | null;
}

/** openWriterAt's work: what it wrote or opened, or null for nothing. */
async function openOrWrite(
  pageIndex: number, origin: [number, number], kind: OpenWriter["kind"], text: string | undefined, opts: WriterOptions,
): Promise<Opened | null> {
  const d = doc.peek();
  const can = () => doc.peek() === d && fillMode.peek() && !editingStopped.peek();
  if (!d || !d.pages[pageIndex] || !can()) return null;
  const page = d.pages[pageIndex];
  const ask = ++writerAsks;
  const readAt = opts.readAt ?? page.rev.peek();
  await flushEditor();
  // A writer that went with its blur may still be on its way: its edit must be in the revision.
  await Promise.allSettled(writing);
  if (!can()) return null;
  const last = writerStyle.peek();
  const editing = opts.editing ?? null;
  const mark = kind === "check" || kind === "cross";
  let size = opts.size ?? (mark ? last.size * MARK_SCALE : last.size);
  let color = opts.color ?? last.color;
  if (editing === null && kind !== "text") {
    // Written at once. A writer open now was asked for after this tap: it stays.
    batch(() => {
      selectedImage.value = null;
      focusedField.value = null;
    });
    const written = text ?? (kind === "date" ? todayText() : MARK_TEXT[kind]);
    const at = originOnPage(page.bounds, origin, size, textWidth(written, size, mark));
    const id = await track(writeNew(d, pageIndex, at, written, inkStyle(size, color)));
    return id === null ? null : { pageIndex, id, origin: at };
  }
  let at = origin;
  let shown = text ?? "";
  let shownKind = kind;
  let style = opts.style;
  if (editing === null) {
    at = originOnPage(page.bounds, origin, size, textWidth(shown, size, false));
  } else {
    // Its revision must include what was asked for before (an undo running, a picture on its
    // way, initials being copied): landing after the writer opened, any of them would make it
    // stale, and what is typed would be refused. If they changed the page, the text is read again.
    await changesLanded();
    if (ask !== writerAsks || !can()) return null;
    if (page.rev.peek() !== readAt) {
      const fresh = await addedNow(page, editing);
      if (!fresh || ask !== writerAsks || !can()) return null;
      at = fresh.origin;
      shown = fresh.text;
      size = fresh.style.size;
      color = inkOf(fresh.style.color);
      style = fresh.style;
      shownKind = addedKind(fresh.text);
    }
  }
  if (ask !== writerAsks) return null;
  const w: OpenWriter = {
    pageIndex, origin: at, text: shown, size, color, kind: shownKind, editing, rev: page.rev.peek(),
  };
  writerDoc.set(w, d);
  if (style) reopenedStyle.set(w, style);
  batch(() => {
    editingLine.value = null;
    selectedImage.value = null;
    focusedField.value = null;
    pendingPlacement.value = null;
    openWriter.value = w;
  });
  return { pageIndex, origin: at, id: null };
}

/**
 * The text `id` of `page` as the engine has it now (a change has landed since it was read), with
 * the page revision unchanged while it was read; null when it is gone or cannot be read.
 */
async function addedNow(page: PageModel, id: number): Promise<AddedText | null> {
  for (let tries = 0; tries < 3; tries++) {
    const rev = page.rev.peek();
    let texts: AddedText[];
    try {
      texts = await engine().addedTexts(page.index);
    } catch (e) {
      console.warn("Reading the texts written on the page failed", e);
      return null;
    }
    if (page.rev.peek() === rev) return texts.find((a) => a.id === id) ?? null;
  }
  return null;
}

/**
 * A tap on a text the user wrote: reopen it in the writer (prefilled, movable, with Delete), as
 * read at the page's current revision (FillLayer shows only boxes read at it). Resolves as
 * openWriterAt does: where the text is now, or null when no writer opened.
 */
export function reopenAdded(pageIndex: number, added: AddedText): Promise<[number, number] | null> {
  const readAt = doc.peek()?.pages[pageIndex]?.rev.peek();
  return openWriterAt(pageIndex, added.origin, addedKind(added.text), added.text, {
    editing: added.id, size: added.style.size, color: inkOf(added.style.color), style: added.style, readAt,
  });
}

/**
 * Close the writer without writing (Cancel, Esc): a commit it asks for afterwards (its blur,
 * flushEditor before it unregisters) writes nothing.
 */
export function cancelWriter(): void {
  const w = openWriter.peek();
  if (!w) return;
  committing.set(w, Promise.resolve());
  openWriter.value = null;
}

/** Keep `run` in `writing` until it ends, so a writer opening next waits for it. */
function track<T>(run: Promise<T>): Promise<T> {
  writing.add(run);
  const done = () => writing.delete(run);
  run.then(done, done);
  return run;
}

/**
 * Write what the writer `w` holds: `text` at `origin` (the baseline start, page space), `size`
 * points, in `color`. A new text is written (addText); a reopened one gets what changed
 * (editAddedText; cleared: deleted). Only spaces in a new writer, or nothing changed in a reopened
 * one, writes nothing and records no step. The writer closes at once; its size and ink are kept
 * for the next text. Once per writer: the writer's Enter, Apply, blur and flushEditor share it.
 */
export function commitWriter(w: OpenWriter, text: string, origin: [number, number], size: number, color: InkColor): Promise<void> {
  const running = committing.get(w);
  if (running) return running;
  const run = track(writeWriter(w, text, origin, size, color));
  committing.set(w, run);
  return run;
}

async function writeWriter(w: OpenWriter, text: string, origin: [number, number], size: number, color: InkColor) {
  const d = writerDoc.get(w) ?? doc.peek();
  if (openWriter.peek() === w) openWriter.value = null;
  if (!d || doc.peek() !== d || !d.pages[w.pageIndex] || editingStopped.peek()) return;
  // Remembered for the next text: the size of a text (a mark's is its own), the ink of any.
  writerStyle.value = { size: w.kind === "text" || w.kind === "date" ? size : writerStyle.peek().size, color };
  const base = reopenedStyle.get(w);
  if (w.editing === null) {
    if (!text.trim()) return;
    await writeNew(d, w.pageIndex, origin, text, inkStyle(size, color, base));
    return;
  }
  const patch: { text?: string; origin?: [number, number]; style?: TextStyle } = {};
  if (!text.trim()) {
    patch.text = ""; // cleared: Apply deletes it
  } else {
    if (text !== w.text) patch.text = text;
    if (origin[0] !== w.origin[0] || origin[1] !== w.origin[1]) patch.origin = origin;
    if (size !== w.size || color !== w.color) patch.style = inkStyle(size, color, base);
  }
  if (Object.keys(patch).length === 0) return;
  await editAdded(d, d.pages[w.pageIndex], w.editing, patch, w.rev);
}

/**
 * "Line below" (Shift+Enter): write the writer's text, and open a new writer one line below
 * (baseline + 1.25 × size), at the same x, in the same size and ink, right away (the keyboard
 * stays up); resolves once the text is written. On the page's last line there is no room for
 * another (it would go off the page, or be cut by its edge): the text is written, no writer
 * opens, and a toast says why.
 */
export function writeAndNewLine(
  w: OpenWriter, text: string, origin: [number, number], size: number, color: InkColor,
): Promise<void> {
  const written = commitWriter(w, text, origin, size, color);
  const d = doc.peek();
  const page = d?.pages[w.pageIndex];
  if (d && page && (writerDoc.get(w) ?? d) === d && fillMode.peek() && !editingStopped.peek()) {
    const below: [number, number] = [origin[0], origin[1] + LINE_STEP * size];
    if (below[1] + DESCENT * size > page.bounds[3]) {
      showToast("info", t("writer.noRoomBelow"));
      return written;
    }
    writerAsks++; // this one, not a writer asked for before it
    const next: OpenWriter = {
      pageIndex: w.pageIndex, origin: originOnPage(page.bounds, below, size, textWidth("", size, false)), text: "",
      size, color, kind: "text", editing: null, rev: page.rev.peek(),
    };
    writerDoc.set(next, d);
    openWriter.value = next;
  }
  return written;
}

/** Delete a text the user wrote (Delete in the reopened writer). `rev`: the page revision it was read at. */
export function deleteAdded(pageIndex: number, id: number, rev: number): Promise<void> {
  const d = doc.peek();
  const page = d?.pages[pageIndex];
  if (!d || !page) return Promise.resolve();
  const w = openWriter.peek();
  if (w && w.pageIndex === pageIndex && w.editing === id) cancelWriter(); // its blur must not write it back
  return track(editAdded(d, page, id, { text: "" }, rev));
}

/** Write a new text (a writer's, a mark, a date): one edit. Its id, or null when nothing was written. */
function writeNew(
  d: OpenDoc, pageIndex: number, origin: [number, number], text: string, style: TextStyle,
): Promise<number | null> {
  return exclusive("edit", async () => {
    if (doc.peek() !== d || editingStopped.peek()) return null;
    try {
      const result = await engine().addText(pageIndex, origin, text, style);
      if (doc.peek() !== d) return null;
      recordHistory(result, "edit");
      if (result.missingChars.length) showToast("error", t("edit.missing", { chars: result.missingChars.join(" ") }));
      return result.changedPages.length ? result.id : null;
    } catch (e) {
      reportEngineError(e, t("writer.failed"), t("fill.pageLocked"));
      return null;
    }
  });
}

/** Change or delete a text written before: one edit, refused when the page changed since `rev`. */
function editAdded(
  d: OpenDoc, page: PageModel, id: number, patch: { text?: string; origin?: [number, number]; style?: TextStyle },
  rev: number,
): Promise<void> {
  if (page.rev.peek() !== rev) {
    showToast("error", t("writer.failed"));
    return Promise.resolve();
  }
  return exclusive("edit", async () => {
    if (doc.peek() !== d || editingStopped.peek()) return;
    try {
      const result = await engine().editAddedText(page.index, id, patch);
      if (doc.peek() !== d) return;
      recordHistory(result, "edit");
      if (result.missingChars.length) showToast("error", t("edit.missing", { chars: result.missingChars.join(" ") }));
    } catch (e) {
      reportEngineError(e, t("writer.failed"), t("fill.pageLocked"));
    }
  });
}

/**
 * Fill in a form field (every widget of the field with that name): one edit; the same value is
 * none. `rev`: the page revision the field was read at; refused when the page has changed since
 * (edits already on their way do not count, see above). Not in Modifica, where the fields are
 * not shown; a locked field (read-only, password...) says so.
 */
export function setFieldValue(pageIndex: number, field: FieldWidget, value: FieldValue, rev: number): Promise<void> {
  const d = doc.peek();
  const page = d?.pages[pageIndex];
  if (!d || !page || editMode.peek() || editingStopped.peek()) return Promise.resolve();
  if (field.locked) {
    showToast("info", t("form.readOnly"));
    return Promise.resolve();
  }
  if (page.rev.peek() !== rev) {
    showToast("error", t("form.failed"));
    return Promise.resolve();
  }
  return exclusive("edit", async () => {
    if (doc.peek() !== d || editingStopped.peek()) return;
    try {
      const result = await engine().setField(field.name, value);
      if (doc.peek() !== d) return;
      recordHistory(result, "edit");
      if (result.missingChars.length) showToast("error", t("edit.missing", { chars: result.missingChars.join(" ") }));
      if (result.overflow) showToast("warn", t("form.overflow"));
    } catch (e) {
      reportEngineError(e, t("form.failed"), t("form.readOnly"));
    }
  });
}

// Form fields: emptiness, and moving the focus to the next field across pages.

/** A field the app fills (not a button, a signature field or a locked one). */
function fillable(f: FieldWidget) {
  return f.locked === null && f.type !== "button" && f.type !== "signature";
}

/** The field holds no value: no text, "Off", no choice. */
export function fieldIsEmpty(f: FieldWidget): boolean {
  switch (f.type) {
    case "text":
      return f.value.trim() === "";
    case "checkbox":
    case "radio":
      return f.value === "" || f.value === "Off";
    case "combo":
    case "list":
      return f.value === "" && !(f.values?.length);
    default:
      return false;
  }
}

/** The fields of a page: the ones the viewer has read for its current revision, else the engine's. */
async function fieldsOf(page: PageModel): Promise<FieldWidget[]> {
  const cached = page.fields.peek();
  if (cached && !cached.failed && cached.rev === page.rev.peek()) return cached.fields;
  return engine().fields(page.index);
}

/** The pages of `d` that have fields, in order, starting with `from` (then wrapping round). */
function fieldPages(d: OpenDoc, from: number): number[] {
  const perPage = d.info.form?.fieldsPerPage ?? [];
  const pages: number[] = [];
  for (let k = 0; k < d.pages.length; k++) {
    const p = (from + k) % d.pages.length;
    if ((perPage[p] ?? 0) > 0) pages.push(p);
  }
  return pages;
}

/**
 * The required fields still empty, by name (a field with widgets on several pages counts once),
 * and the first one in page and tab order. Fields that cannot be filled here do not count.
 */
async function emptyRequiredFields(d: OpenDoc): Promise<{ count: number; first: FieldFocus | null }> {
  const seen = new Set<string>();
  let first: FieldFocus | null = null;
  for (const p of fieldPages(d, 0)) {
    for (const f of await fieldsOf(d.pages[p])) {
      if (!f.required || !fillable(f) || seen.has(f.name) || !fieldIsEmpty(f)) continue;
      seen.add(f.name);
      first ??= { pageIndex: p, name: f.name, index: f.index };
    }
  }
  return { count: seen.size, first };
}

type FieldFocus = { pageIndex: number; name: string; index: number };

/**
 * Move the focus to a field: show its page (unless `stay`: it is the page in view) and ask the
 * form layer to focus it (focusedField).
 */
async function focusField(target: FieldFocus, stay = false) {
  if (editMode.peek()) await setTool("fill"); // no fields in Modifica
  if (doc.peek() === null) return;
  if (!stay) goToPage(target.pageIndex);
  focusedField.value = target;
}

/**
 * The keyboard's "next" in a field, or "Next empty field": move the focus to the field after
 * `from` (a widget of the focused field, whose other widgets are skipped; null: from the start)
 * that the app fills, across pages, in tab order, wrapping round; with `onlyEmpty`, to the next
 * empty one, once what the field held is written and the edits asked for before have landed (a
 * value just typed, or a box just ticked, counts as filled). When the field the user is in is
 * still empty and no other one is, the focus stays there (back from the button pressed) and a
 * toast says it is the last empty field: never "no empty fields left" while they stand in one.
 * True when the focus went to a field (or stayed in that last empty one); false when there is none.
 */
export async function focusNextField(
  from: { pageIndex: number; index: number; name?: string } | null, onlyEmpty = false,
): Promise<boolean> {
  const d = doc.peek();
  if (!d || !d.info.form) return false;
  if (onlyEmpty) {
    await flushEditor();
    await changesLanded(false);
    if (doc.peek() !== d) return false;
  }
  const start = from?.pageIndex ?? 0;
  const pages = fieldPages(d, start);
  // The start page twice: the fields after `from`, and at the end of the round those before it.
  if (from && pages[0] === start) pages.push(start);
  /** The widget the user is in (`from`), as read on its page: still empty, it may be the last one. */
  let current: FieldWidget | undefined;
  for (const [k, p] of pages.entries()) {
    let fields: FieldWidget[];
    try {
      fields = await fieldsOf(d.pages[p]);
    } catch (e) {
      console.warn("Reading the form fields failed", e);
      return false;
    }
    if (doc.peek() !== d) return false;
    if (from?.name !== undefined && p === start && k === 0) {
      current = fields.find((f) => f.name === from.name && f.index === from.index)
        ?? fields.find((f) => f.name === from.name);
    }
    const target = fields.find((f) => {
      if (!fillable(f) || (onlyEmpty && !fieldIsEmpty(f)) || (from?.name !== undefined && f.name === from.name)) return false;
      if (!from || p !== start) return true;
      return k === 0 ? f.index > from.index : f.index <= from.index;
    });
    if (target) {
      await focusField({ pageIndex: p, name: target.name, index: target.index });
      return true;
    }
  }
  if (onlyEmpty && current && fillable(current) && fieldIsEmpty(current)) {
    // On the page in view, no scroll to its top: the user is there, and the focus shows the field.
    await focusField({ pageIndex: start, name: current.name, index: current.index }, start === currentPage.peek());
    showToast("info", t("form.lastEmpty"));
    return true;
  }
  return false;
}

/** Documents already asked about their empty required fields (by id): once per document (D6). */
const missingAsked = new Set<number>();

/** The document has a form with required fields, and has not been asked about them yet. */
function mayAskMissing(d: OpenDoc): boolean {
  return (d.info.form?.required ?? 0) > 0 && !missingAsked.has(d.id);
}

/**
 * Before a download (mayAskMissing): when required fields are still empty, ask (D6). "Fill them
 * in" moves the focus to the first one and stops the download; "Download anyway" goes on. True
 * to go on.
 */
async function settleMissingFields(d: OpenDoc): Promise<boolean> {
  await flushEditor(); // a value still being typed counts
  let missing: Awaited<ReturnType<typeof emptyRequiredFields>>;
  try {
    missing = await emptyRequiredFields(d);
  } catch (e) {
    console.warn("Reading the form fields failed", e);
    return true; // the download is not held back by the question
  }
  if (doc.peek() !== d) return false;
  if (missing.count === 0) return true;
  if (dialog.peek()) {
    showToast("info", t("download.cancelled")); // another question is open: as the PDF/A ones
    return false;
  }
  const answer = await new Promise<"fill" | "download" | null>((resolve) => {
    showDialog({ kind: "missing-fields", count: missing.count, resolve });
  });
  if (answer === null || doc.peek() !== d) return false;
  missingAsked.add(d.id);
  if (answer === "download") return true;
  if (missing.first) await focusField(missing.first);
  return false;
}

// Signatures, initials and pictures.

/**
 * "Use this signature" in the sheet (or a tap on one in the chooser): it joins this session's
 * signatures, and goes inside the field the sheet was opened from ("Sign here"; turned with the
 * field's text, signatureInField), or waits to be placed with the next tap (pendingPlacement),
 * Compila e firma turned on if needed. Closes the sheet.
 */
export function useSignature(sig: Signature): void {
  const d = dialog.peek();
  const forField = d?.kind === "signature" ? d.forField : null;
  batch(() => {
    if (d?.kind === "signature") showDialog(null);
    sessionSignatures.value = [sig, ...sessionSignatures.peek().filter((s) => s.id !== sig.id)];
  });
  const go = () => {
    if (!fillMode.peek()) return;
    if (forField) {
      // Upright to the field's text: a field turned with its page (or on its own) gets it turned too.
      const aspect = sig.width / Math.max(1, sig.height);
      void placeSignature(forField.pageIndex, sig, signatureInField(forField.rect, aspect, forField.rotation));
      return;
    }
    // A writer still open (an iPhone keeps the focus in it when "Sign here" is tapped) is
    // written, not dropped; one on its way does not open over the signature waiting.
    void flushEditor();
    writerAsks++;
    batch(() => {
      openWriter.value = null;
      selectedImage.value = null;
      pendingPlacement.value = sig;
      fillTool.value = sig.kind;
    });
  };
  if (fillMode.peek()) go();
  else void setTool("fill").then(go);
}

/**
 * Place `sig` on page `pageIndex` where `matrix` says (a tap, "Put it in the middle", a
 * signature field's box): one edit; then the new picture is selected with its frame (unless the
 * writer or the line editor was opened meanwhile: selectAdded), and Firma and Sigla go back to
 * Testo. The placement waiting for a tap is used up at once (a second tap places nothing).
 */
export function placeSignature(pageIndex: number, sig: Signature, matrix: Matrix): Promise<void> {
  return placeAndSelect(pageIndex, sig, matrix).then(() => undefined);
}

/** placeSignature's work: the new picture's index once it is selected, else null. */
async function placeAndSelect(pageIndex: number, sig: Signature, matrix: Matrix): Promise<number | null> {
  const d = doc.peek();
  const page = d?.pages[pageIndex];
  if (!d || !page || editingStopped.peek()) return null;
  cancelPlacement();
  let selected: number | null = null;
  await counted(page, async () => {
    let bytes: ArrayBuffer;
    try {
      bytes = await sig.png.arrayBuffer();
    } catch (e) {
      console.warn("The signature could not be read", e);
      showToast("error", t("fill.placeFailed"));
      return;
    }
    if (doc.peek() !== d) return;
    const placed = await addPicture(d, bytes, [{ pageIndex, matrix }], sig.description);
    const index = placed?.[0]?.imageIndex ?? null;
    if (!placed || doc.peek() !== d) return;
    batch(() => {
      if (index !== null && sig.kind === "initials") initialsSource.value = { docId: d.id, pageIndex, imageIndex: index, sig };
      if (index !== null && selectAdded(pageIndex, index)) selected = index;
    });
    const touch = isCoarse.peek();
    const page1 = pageIndex + 1;
    showToast("info", sig.kind === "initials"
      ? t(touch ? "initials.placedTouch" : "initials.placed", { page: page1 })
      : t(touch ? "sign.placedTouch" : "sign.placed", { page: page1 }));
  });
  return selected;
}

/**
 * Select a picture just added (its frame shows), where pictures are shown: Compila e firma and
 * Modifica. Not while the text writer or the line editor is open (opened while the picture was on
 * its way, a phone photo being prepared, say): selecting would close it, and what is typed in it
 * would be lost. The picture is placed all the same, and its toast says where. True when selected.
 */
function selectAdded(pageIndex: number, index: number): boolean {
  if (tool.peek() === null || openWriter.peek() || editingLine.peek()) return false;
  // A text reopened while the picture was on its way still opens afterwards (the user's latest
  // wish), and the selection then goes.
  selectedImage.value = { pageIndex, index };
  return true;
}

/**
 * Add a picture (`bytes`, transferred) at `targets`, one edit; the result's placements, or null
 * when it failed (and the user was told).
 */
function addPicture(
  d: OpenDoc, bytes: ArrayBuffer, targets: ImageTarget[], alt: string | null,
): Promise<Placed | null> {
  return exclusive("edit", () => sendPicture(d, bytes, targets, alt));
}

type Placed = { pageIndex: number; imageIndex: number | null }[];

/**
 * addPicture's engine call, for a caller already in the engine's queue. A failure says that
 * nothing was added (`failed`: the signature or picture by default), not that an image could not
 * be changed.
 */
async function sendPicture(
  d: OpenDoc, bytes: ArrayBuffer, targets: ImageTarget[], alt: string | null, failed = t("fill.placeFailed"),
): Promise<Placed | null> {
  if (doc.peek() !== d || editingStopped.peek()) return null;
  try {
    const result = await engine().addImage(bytes, targets, alt === null ? null : alt.slice(0, MAX_ALT_CHARS));
    if (doc.peek() !== d) return null;
    recordHistory(result, "edit");
    return result.placed;
  } catch (e) {
    reportEngineError(e, failed, t("fill.pageLocked"));
    return null;
  }
}

/** The pages "On every page…" offers for initials on page `pageIndex`: all the others, or all but the last. */
export function initialsChoices(pageIndex: number, pageCount: number): { all: number[]; allButLast: number[] } {
  const all = Array.from({ length: pageCount }, (_, p) => p).filter((p) => p !== pageIndex);
  return { all, allButLast: all.filter((p) => p !== pageCount - 1) };
}

/**
 * "On every page…" on the initials `imageIndex` of page `pageIndex` (the ones placed last,
 * initialsSource): asks which pages, then puts a copy on each in one edit (one history step,
 * the same picture object): the same size in points and the same distance from the nearest
 * corner or edge of each page (anchorOf, placeOn). The original stays selected.
 */
export async function placeInitialsOnPages(pageIndex: number, imageIndex: number): Promise<void> {
  const d = doc.peek();
  const page = d?.pages[pageIndex];
  if (!d || !page || d.pages.length < 2 || editingStopped.peek() || dialog.peek()) return;
  await flushEditor(); // a keyboard move of the initials still waiting: the copies follow it
  if (doc.peek() !== d) return;
  /** The initials of this page that "On every page…" copies, followed through edits (or gone). */
  const isSource = () => {
    const source = initialsSource.peek();
    return source && source.docId === d.id && source.pageIndex === pageIndex ? source : null;
  };
  if (isSource()?.imageIndex !== imageIndex) {
    showToast("error", t("initials.failed"));
    return;
  }
  const answer = await new Promise<number[] | null>((resolve) => {
    showDialog({ kind: "initials-pages", pageIndex, imageIndex, resolve });
  });
  const pages = (answer ?? []).filter((p) => p !== pageIndex && d.pages[p]);
  if (!pages.length || doc.peek() !== d) return;
  await counted(page, async () => {
    const working = pages.length === 1 ? t("initials.workingOne") : t("initials.working", { count: pages.length });
    const status = showToast("info", working, 0);
    let count = 0;
    try {
      count = await copyInitials(d, page, isSource, pages);
    } finally {
      dismissToast(status);
    }
    if (count > 0) showToast("info", count === 1 ? t("initials.doneOne") : t("initials.done", { count }));
  });
}

/**
 * The copies of "On every page…", in the engine's queue: where the initials are now (they may
 * have moved, or gone with an undo, while the question was open), then one addImage for all
 * `pages`. How many were placed.
 */
function copyInitials(
  d: OpenDoc, page: PageModel, sourceOf: () => { imageIndex: number; sig: Signature } | null, pages: number[],
): Promise<number> {
  return exclusive("edit", async () => {
    const source = sourceOf();
    if (doc.peek() !== d || editingStopped.peek()) return 0;
    let image: ImageInfo | undefined;
    let bytes = new ArrayBuffer(0);
    try {
      if (source) {
        image = (await engine().images(page.index)).find((i) => i.index === source.imageIndex);
        bytes = await source.sig.png.arrayBuffer();
      }
    } catch (e) {
      reportEngineError(e, t("initials.failed"));
      return 0;
    }
    if (doc.peek() !== d) return 0;
    if (!source || !image) {
      showToast("error", t("initials.failed"));
      return 0;
    }
    const anchor = anchorOf(image.matrix, page.bounds);
    const from = image.matrix;
    const targets = pages.map((p) => ({ pageIndex: p, matrix: placeOn(anchor, from, d.pages[p].bounds) }));
    const placed = await sendPicture(d, bytes, targets, source.sig.description, t("initials.failed"));
    return placed?.filter((x) => x.imageIndex !== null).length ?? 0;
  });
}

/** Picture added without a size of its own: its pixels at this resolution, at most 60 % of the page. */
const PICTURE_PPI = 150;

/**
 * The part of page `pageIndex` on screen (page space), or the whole page when it cannot be told
 * (not laid out, no viewer): where "Put it in the middle" and Immagine place things.
 */
export function visiblePart(pageIndex: number): Rect {
  const page = doc.peek()?.pages[pageIndex];
  if (!page) return [0, 0, 0, 0];
  try {
    const scroller = viewerScroller();
    const el = scroller?.querySelector<HTMLElement>(`.page[data-page="${pageIndex}"]`);
    if (!scroller || !el) return page.bounds;
    const view = scroller.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    const z = zoom.peek() || 1;
    const x0 = Math.max(view.left, box.left), x1 = Math.min(view.right, box.right);
    const y0 = Math.max(view.top, box.top), y1 = Math.min(view.bottom, box.bottom);
    if (x1 <= x0 || y1 <= y0) return page.bounds;
    const [bx, by] = page.bounds;
    return [bx + (x0 - box.left) / z, by + (y0 - box.top) / z, bx + (x1 - box.left) / z, by + (y1 - box.top) / z];
  } catch {
    return page.bounds;
  }
}

/**
 * Where a new picture of `width` × `height` pixels goes: centred on `view` (the visible part of
 * the page), its own proportions, at most 60 % of the page's width and height.
 */
export function pictureMatrix(view: Rect, bounds: Rect, width: number, height: number): Matrix {
  const aspect = Math.max(1, width) / Math.max(1, height);
  const pageW = bounds[2] - bounds[0], pageH = bounds[3] - bounds[1];
  let w = Math.min((Math.max(1, width) * 72) / PICTURE_PPI, 0.6 * pageW);
  let h = w / aspect;
  if (h > 0.6 * pageH) {
    h = 0.6 * pageH;
    w = h * aspect;
  }
  const side = (s: number) => Math.min(MAX_IMAGE_SIDE, Math.max(MIN_IMAGE_SIDE, s));
  w = side(w);
  h = side(h);
  const cx = Math.min(Math.max((view[0] + view[2]) / 2, bounds[0]), bounds[2]);
  const cy = Math.min(Math.max((view[1] + view[3]) / 2, bounds[1]), bounds[3]);
  return [w, 0, 0, h, cx - w / 2, cy - h / 2];
}

/**
 * Immagine: the picture in `file` is prepared (upright, scaled down, JPEG or PNG), placed in the
 * middle of what shows of the current page (pictureMatrix), and selected with its frame. One
 * edit; it counts as pending from the moment it is chosen.
 */
export function addPictureFromFile(file: File): Promise<void> {
  const d = doc.peek();
  if (!d || editingStopped.peek()) return Promise.resolve();
  const pageIndex = Math.min(Math.max(0, currentPage.peek()), d.pages.length - 1);
  const page = d.pages[pageIndex];
  return counted(page, async () => {
    const status = showToast("info", t("image.preparing"), 0);
    let picture: { bytes: ArrayBuffer; width: number; height: number };
    try {
      picture = await preparePicture(file);
    } catch (e) {
      const tooBig = e instanceof PictureError && e.code === "too-big";
      if (!tooBig) console.warn("The picture could not be prepared", e);
      showToast("error", tooBig ? t("image.pictureTooBig") : t("image.pictureUnreadable"));
      return;
    } finally {
      dismissToast(status);
    }
    if (doc.peek() !== d) return;
    const matrix = pictureMatrix(visiblePart(pageIndex), page.bounds, picture.width, picture.height);
    const placed = await addPicture(d, picture.bytes, [{ pageIndex, matrix }], null);
    const index = placed?.[0]?.imageIndex ?? null;
    if (!placed || doc.peek() !== d) return;
    if (index !== null) selectAdded(pageIndex, index);
    // On touch screens one finger scrolls the page: the picture moves by its round grip.
    showToast("info", t(isCoarse.peek() ? "fill.imagePlacedTouch" : "fill.imagePlaced", { page: pageIndex + 1 }));
  });
}

/**
 * "Put it in the middle": the keyboard and screen-reader path for every placement, on phones too.
 * What the sub-tool `kind` would place with a tap goes in the middle of what shows of the current
 * page (visiblePart):
 * - the signature or initials waiting to be placed (whatever `kind`), then selected, its frame
 *   taking the focus (focusRequest);
 * - Testo: a writer opens there and takes the focus;
 * - ✓, ✗ and Data: written there at once, as a tap would, kept on the page; a toast says what and
 *   where in one sentence (mark.placedAt, writer.doneAt), and the focus goes to its box (focusRequest);
 * - Firma and Sigla with nothing chosen: the chooser; Immagine: the picture picker (opened right
 *   here, within the click, as iOS wants; the picture goes in the middle anyway).
 * Resolves once done.
 */
export async function placeAtCentre(kind: FillTool = fillTool.peek()): Promise<void> {
  const d = doc.peek();
  if (!d || !d.pages.length || !fillMode.peek() || editingStopped.peek()) return;
  const sig = pendingPlacement.peek();
  if (!sig && (kind === "signature" || kind === "initials" || kind === "image")) {
    setFillTool(kind);
    return;
  }
  const pageIndex = Math.min(Math.max(0, currentPage.peek()), d.pages.length - 1);
  const page = d.pages[pageIndex];
  const view = visiblePart(pageIndex);
  const centre: [number, number] = [(view[0] + view[2]) / 2, (view[1] + view[3]) / 2];
  if (sig) {
    const box = signatureRect(page.bounds, sig.kind, sig.width / Math.max(1, sig.height), centre);
    const index = await placeAndSelect(pageIndex, sig, rectMatrix(box));
    if (index !== null && doc.peek() === d) focusRequest.value = { pageIndex, kind: "image", id: index };
    return;
  }
  const size = writerStyle.peek().size;
  if (kind === "text") {
    await openWriterAt(pageIndex, writerOrigin(centre, size), "text");
    return;
  }
  const [x, y] = centre;
  let written: Opened | null = null;
  if (kind === "date") {
    const text = todayText();
    // About 0.5 em a character: centred across the point, its digits' middle on it.
    written = await openOrWrite(pageIndex, [x - 0.25 * size * text.length, y + 0.35 * size], "date", text, {});
  } else if (kind === "check" || kind === "cross") {
    // The Dingbats ✓ and ✗ are about 0.8 em wide and 0.7 em tall: centred on the point.
    const s = size * MARK_SCALE;
    written = await openOrWrite(pageIndex, [x - 0.4 * s, y + 0.35 * s], kind, MARK_TEXT[kind], {});
  }
  if (written?.id == null || doc.peek() !== d) return;
  const [bx, by] = page.bounds;
  const where = { page: pageIndex + 1, x: formatMm(written.origin[0] - bx), y: formatMm(written.origin[1] - by) };
  showToast("info", t(kind === "date" ? "writer.doneAt" : "mark.placedAt", where));
  focusRequest.value = { pageIndex, kind: "added", id: written.id };
}

let savedLoaded = false;

/**
 * Read the signatures saved on this device into this session's list, once (when the first
 * document opens). Nothing when the device keeps none or storage is blocked.
 */
export async function loadSavedSignatures(): Promise<void> {
  if (savedLoaded) return;
  savedLoaded = true;
  let saved: readonly Signature[];
  try {
    saved = await listStored();
  } catch (e) {
    console.warn("Reading the saved signatures failed", e);
    return;
  }
  const known = new Set(sessionSignatures.peek().map((s) => s.id));
  const added = saved.filter((s) => !known.has(s.id));
  if (added.length) sessionSignatures.value = [...sessionSignatures.peek(), ...added];
}

/**
 * "Remember on this device" (off by default): keep `sig` in this browser (IndexedDB, at most 5,
 * never online). True when it was saved. False when storage is blocked, failed or full (5 saved
 * already, from another tab say): a toast says it was not kept, and why when it was full; the
 * signature still works for this session. (Called once the sheet has closed: the toast is heard.)
 */
export async function rememberSignature(sig: Signature): Promise<boolean> {
  const stored = await saveStored({ ...sig, savedAt: Date.now() }).catch((e: unknown) => {
    console.warn("Saving the signature failed", e);
    return null;
  });
  if (!stored) {
    const full = await listStored().then(
      (saved) => saved.length >= MAX_SAVED && !saved.some((s) => s.id === sig.id),
      () => false,
    );
    showToast("warn", full ? t("sign.rememberFailedFull", { count: MAX_SAVED }) : t("sign.rememberFailed"));
    return false;
  }
  const list = sessionSignatures.peek();
  sessionSignatures.value = list.some((s) => s.id === sig.id)
    ? list.map((s) => (s.id === sig.id ? stored : s))
    : [stored, ...list];
  const pending = pendingPlacement.peek();
  if (pending?.id === sig.id) pendingPlacement.value = stored;
  return true;
}

/**
 * "Forget": the signature (or initials) leaves the device, then this session's list. True when it
 * is gone. False when the device's storage did not answer or refused: it stays in the list (it
 * would come back at the next start anyway), never "forgotten". What happened is said once: by
 * the signature sheet when it is still open (the toasts are under it, inert), else in a toast
 * (sign.forgetFailed, or forgotten).
 */
export async function forgetSignature(id: string): Promise<boolean> {
  const initials = sessionSignatures.peek().find((s) => s.id === id)?.kind === "initials";
  let gone = false;
  try {
    gone = await forgetStored(id);
  } catch (e) {
    console.warn("Forgetting the signature failed", e);
  }
  if (gone) sessionSignatures.value = sessionSignatures.peek().filter((s) => s.id !== id);
  if (dialog.peek()?.kind === "signature") return gone; // the sheet says it
  if (!gone) showToast("error", t("sign.forgetFailed"));
  else showToast("info", t(initials ? "sign.forgottenInitials" : "sign.forgotten"));
  return gone;
}

// ---------------------------------------------------------------------------------------------
// Download and share
//
// One tap (Download, Ctrl+S, Share) keeps what the file is: a PDF/A stays PDF/A, a PDF that needed
// a password to open stays protected with it. "More download options" picks the format and the
// password for one download (or one share, when a password must be chosen anew for it). Before a
// PDF/A the engine checks what the conversion would do: what makes it impossible is explained (a
// normal PDF is offered instead), what it removes or changes is asked first, and a clean file
// downloads straight away.

/** What one download writes: the format, and the password the file gets as a normal PDF. */
export interface DownloadChoice {
  format: SaveFormat;
  /** Not sent for a PDF/A (which cannot have one), but kept for the normal PDF offered instead. */
  password: SavePassword;
}

/**
 * The one-tap choice for a document. A file that needs a password cannot be a valid PDF/A
 * (PDF/A forbids encryption), whatever its metadata claims: there the password wins, so a
 * protected file never comes out unprotected without being asked.
 */
export function defaultChoice(info: DocInfo): DownloadChoice {
  return {
    format: info.pdfa && !info.needsPassword ? "pdfa-2b" : "pdf",
    password: info.canKeepPassword ? { mode: "keep" } : { mode: "none" },
  };
}

/**
 * A file that needed a password the download cannot be protected with again (one the engine
 * cannot carry or other readers would read differently, or the owner password it was opened
 * with): one tap must not quietly drop the protection, so it opens the download options, where
 * the user picks a new password or none.
 */
const mustChoosePassword = (info: DocInfo) => info.needsPassword && !info.canKeepPassword;

/**
 * The regular PDF offered instead of a PDF/A carries the one-tap password, which is none for
 * such a file: written as it is, it would drop the protection without asking.
 */
const dropsProtection = (d: OpenDoc, choice: DownloadChoice) =>
  choice.format === "pdf" && choice.password.mode === "none" && mustChoosePassword(d.info);

/** What the engine is asked for: a PDF/A never carries a password. */
export function saveOptionsFor(choice: DownloadChoice): SaveOptions {
  return choice.format === "pdfa-2b"
    ? { format: "pdfa-2b", password: { mode: "none" } }
    : { format: "pdf", password: choice.password };
}

/**
 * Removals always need a yes; of the warnings, only text that may move and a signature that
 * stops being valid. A replaced blend mode or colour declaration is not worth a question.
 */
export function pdfaNeedsConfirm(report: PdfaReport): boolean {
  return report.removals.length > 0 ||
    report.warnings.some((w) => w.code === "text-may-shift" || w.code === "signature-invalid");
}

// The File System Access API is not in TypeScript's DOM types yet.
interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: { description?: string; accept: Record<string, string[]> }[];
}
type SaveFilePicker = (options?: SaveFilePickerOptions) => Promise<FileSystemFileHandle>;

type PdfaQuestion = Extract<DialogState, { kind: "pdfa-blocked" | "pdfa-confirm" }>;
/** A question without its answer callback (Omit applied to each kind separately). */
type Unanswered<Q> = Q extends unknown ? Omit<Q, "resolve"> : never;

/**
 * Ask a PDF/A question; resolves false on Cancel, Escape, or another dialog taking its place.
 * The check takes a while, and Close, Open and Update still work meanwhile: when the user has
 * opened one of their questions (or any other dialog), that one stays, and this download stops
 * with a word instead of answering it "no" behind their back.
 */
function ask(question: Unanswered<PdfaQuestion>): Promise<boolean> {
  if (dialog.peek()) {
    showToast("info", question.purpose === "share" ? t("share.cancelled") : t("download.cancelled"));
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    showDialog({ ...question, resolve } as PdfaQuestion);
  });
}

/** Run the engine's PDF/A check, with a status toast while it works. Null when it failed. */
async function checkPdfa(d: OpenDoc): Promise<PdfaReport | null> {
  const status = showToast("info", t("pdfa.checking"), 0);
  try {
    return await exclusive("check", async () => {
      if (doc.peek() !== d) return null;
      try {
        return await engine().pdfaCheck();
      } catch (e) {
        reportEngineError(e, t("pdfa.checkFailed"));
        return null;
      }
    });
  } finally {
    dismissToast(status);
  }
}

/**
 * What a download ends with: nothing more to do, or "choose-password" when the regular PDF taken
 * instead of a PDF/A would drop the file's password (dropsProtection): the options open then.
 */
type Delivered = "choose-password" | void;

/**
 * For a PDF/A: check first, then explain or ask. Returns what to write (the normal PDF when the
 * user took it instead), "choose-password" (see Delivered), or null to stop. Any other choice
 * goes through unchanged.
 */
async function settleChoice(
  d: OpenDoc, choice: DownloadChoice, purpose: SavePurpose,
): Promise<DownloadChoice | "choose-password" | null> {
  if (choice.format !== "pdfa-2b") return choice;
  await flushEditor(); // the check must see the text still in the line editor
  const report = await checkPdfa(d);
  if (!report || doc.peek() !== d) return null;
  let ok = true;
  if (report.blockers.length) {
    ok = await ask({ kind: "pdfa-blocked", blockers: report.blockers, purpose });
    choice = { format: "pdf", password: choice.password };
  } else if (pdfaNeedsConfirm(report)) {
    ok = await ask({ kind: "pdfa-confirm", removals: report.removals, warnings: report.warnings, purpose });
  }
  if (!ok || doc.peek() !== d) return null;
  return dropsProtection(d, choice) ? "choose-password" : choice;
}

/**
 * Build the file in the engine. "blocked": the engine refused the PDF/A when writing it (its own
 * final check); null: it failed, and the user was told.
 */
async function buildPdf(choice: DownloadChoice): Promise<ArrayBuffer | "blocked" | null> {
  try {
    return (await engine().save(saveOptionsFor(choice))).bytes;
  } catch (e) {
    if (e instanceof EngineError && e.code === "pdfa-blocked") return "blocked";
    reportEngineError(e, t("download.failed"));
    return null;
  }
}

/** Plain browser download through a temporary blob URL. */
function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.append(a);
  a.click();
  a.remove();
  // Revoked later, not right away: some browsers start reading the blob after click() returns.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function doneMessage(choice: DownloadChoice, name: string): string {
  if (choice.format === "pdfa-2b") return t("download.donePdfa", { name });
  if (choice.password.mode !== "none") return t("download.doneProtected", { name });
  return t("download.done", { name });
}

/**
 * Download the edited PDF as "<name>-edited.pdf" ("…-PDFA.pdf" for a PDF/A), with `choice` from
 * the download options, or else the one-tap choice. With the File System Access API the user
 * picks where, asked while the click still counts as a user gesture (the click that started it,
 * or the one that answered a PDF/A question); otherwise, or when the gesture has expired
 * meanwhile, it is a normal download. Afterwards the edits count as saved.
 *
 * One download at a time: a second click or Ctrl+S while the save dialog is open is ignored
 * (Chrome would refuse a second dialog, and that must not turn into an extra plain download).
 */
export function download(choice?: DownloadChoice) {
  return start("download", choice);
}

/**
 * Share the edited PDF through the system share sheet (touch devices), with `choice` from the
 * options, or else the one-tap choice. A building that outlasts the tap's user gesture asks for
 * one more tap (shareFile).
 */
export function share(choice?: DownloadChoice) {
  return start("share", choice);
}

/**
 * Download or share, one at a time (downloadRunning), its questions included: the empty required
 * fields first (downloads only, once per document), then PDF/A's.
 */
async function start(purpose: SavePurpose, choice: DownloadChoice | undefined) {
  const d = doc.peek();
  if (!d) return;
  if (downloadRunning.peek()) {
    // A one-tap repeat is simply ignored; a choice made in the options must not vanish silently.
    if (choice) showToast("info", t("download.busy"));
    return;
  }
  if (!choice && mustChoosePassword(d.info)) {
    openDownloadOptions(purpose);
    return;
  }
  downloadRunning.value = true;
  let next: Delivered;
  try {
    if (purpose === "download" && mayAskMissing(d) && !(await settleMissingFields(d))) return;
    next = await deliver(d, choice ?? defaultChoice(d.info), purpose);
  } finally {
    downloadRunning.value = false;
  }
  // The options open once this download is over (they refuse to open while one runs).
  if (next === "choose-password" && doc.peek() === d) openDownloadOptions(purpose);
}

/** Settle the choice and write the file; when the engine still refuses the PDF/A, offer a normal PDF. */
async function deliver(d: OpenDoc, choice: DownloadChoice, purpose: SavePurpose): Promise<Delivered> {
  const settled = await settleChoice(d, choice, purpose);
  if (settled === null) return;
  if (settled === "choose-password") return settled;
  const outcome = purpose === "download" ? await writeDownload(d, settled) : await writeShare(d, settled);
  if (outcome !== "blocked") return;
  const fallback = await ask({ kind: "pdfa-blocked", blockers: [], purpose });
  if (!fallback || doc.peek() !== d) return;
  const regular: DownloadChoice = { format: "pdf", password: settled.password };
  return dropsProtection(d, regular) ? "choose-password" : deliver(d, regular, purpose);
}

async function writeDownload(d: OpenDoc, choice: DownloadChoice): Promise<"blocked" | void> {
  const name = outputName(d.fileName, choice.format);
  const picker = (window as unknown as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
  let handle: FileSystemFileHandle | null = null;
  if (picker) {
    try {
      handle = await picker({
        suggestedName: name,
        types: [{ description: "PDF", accept: { "application/pdf": [".pdf"] } }],
      });
    } catch (e) {
      if (isAbort(e)) return; // the user closed the dialog
      // The picker cannot be used here (sandboxed frame, the gesture expired, options refused):
      // fall back to a normal download. Anything else (e.g. NotAllowedError) is a refusal.
      const unusable = e instanceof TypeError || (e instanceof DOMException && e.name === "SecurityError");
      if (!unusable) {
        console.error(e);
        showToast("error", t("download.failed"));
        return;
      }
    }
  }
  await flushEditor();
  return exclusive("save", async () => {
    if (doc.peek() !== d) return;
    const key = saveKey();
    const bytes = await buildPdf(choice);
    if (bytes === "blocked") return "blocked";
    if (!bytes) return;
    try {
      if (handle) {
        const writable = await handle.createWritable();
        await writable.write(bytes);
        await writable.close();
      } else {
        downloadBlob(new Blob([bytes], { type: "application/pdf" }), name);
      }
      markSaved(key); // ignored if another file was opened while writing
      showToast("info", doneMessage(choice, handle?.name ?? name));
    } catch (e) {
      console.error(e);
      showToast("error", t("download.failed"));
    }
  });
}

async function writeShare(d: OpenDoc, choice: DownloadChoice): Promise<"blocked" | void> {
  await flushEditor();
  return exclusive("save", async () => {
    if (doc.peek() !== d) return;
    const key = saveKey();
    const bytes = await buildPdf(choice);
    if (bytes === "blocked") return "blocked";
    if (!bytes) return;
    const file = new File([bytes], outputName(d.fileName, choice.format), { type: "application/pdf" });
    await shareFile(file, key, true);
  });
}

/**
 * "More download options": format and password for one download, or one share when a file whose
 * password must be chosen anew is shared (a dialog; a sheet on phones). Not while a download
 * runs: the choice made there would be refused, or a PDF/A question would take its place. The
 * top bar's chevron is off then; the phone's "Download with options…" row gets a word instead.
 */
export function openDownloadOptions(purpose: SavePurpose = "download") {
  if (!doc.peek() || dialog.peek()) return;
  if (downloadRunning.peek()) {
    showToast("info", t("download.busy"));
    return;
  }
  showDialog({ kind: "download-options", purpose });
}

/**
 * Open the share sheet for `file`. If building the PDF took long enough for the tap to stop
 * counting as a user gesture, the browser refuses: then (when `askAgain`) a small dialog asks
 * for one more tap.
 */
export async function shareFile(file: File, key: string, askAgain: boolean) {
  try {
    await navigator.share({ files: [file], title: file.name });
    markSaved(key);
  } catch (e) {
    if (isAbort(e)) return;
    if (askAgain && e instanceof DOMException && e.name === "NotAllowedError") {
      showDialog({ kind: "share", file, saveKey: key });
      return;
    }
    console.error(e);
    showToast("error", t("share.failed"));
  }
}

// ---------------------------------------------------------------------------------------------
// App update and leaving the page

let leaving = false;

/** True while the page should warn before closing (edits not downloaded, or still being typed). */
export function shouldWarnBeforeUnload() {
  return hasUnsavedWork() && !leaving;
}

/** Install the waiting version (asks first when there are edits not downloaded). */
export async function updateApp() {
  await flushEditor();
  if (hasUnsavedWork()) {
    const ok = await confirmDialog({
      title: t("unsaved.title"),
      body: t("unsaved.updateBody"),
      confirmLabel: t("unsaved.updateConfirm"),
    });
    if (!ok) return;
  }
  leaving = true; // already confirmed: no second warning from beforeunload
  applyUpdate();
  // Normally the page is gone long before this. If no reload came after all, edits made from
  // now on must be protected again.
  setTimeout(() => { leaving = false; }, 10_000);
}
