// The chrome of the "Fill & sign" tool (phase 3, release 3), around the pages:
// - FillBanner, the bar above the pages in Fill mode. On desktop, a first row with the tool's
//   name, its sub-tools (Text, ✓, ✗, Date, Sign, Initials: the toolbar Modifica's bar uses too,
//   ui/SubTools.tsx, icons only when the bar is narrow), "Put it in the middle" (an icon, the
//   keyboard path for placing: placeAtCentre places it, says what and where, and moves the focus
//   onto it) and "Done"; a second with the hint, the form's field count with "Next empty field"
//   (from the field the user is in, never back to it; it reads the pages' fields only when
//   pressed, and only as far as the next empty one) and the form's notes (its scripts never run
//   here, XFA). On phones: the hint, the count, "Put it in the middle" (the path for screen
//   readers and switch access, where a tap on the page cannot be aimed) and "Done"; the sub-tools
//   are in FillStrip, and the notes come once as toasts, so the bar keeps to a line or two.
// - FillStrip, the phone strip of sub-tools: 48 px, right above the tab bar, as Modifica's. It is
//   not a tab: the tab bar stays as it is.
// - What the form offers (fillableFields): the fields the user can fill in, as FormInfo counts
//   them when the document opens (nothing reads every page for it: on a form of hundreds of pages
//   that kept the engine busy for seconds); a digitally signed PDF or a read-only form has fields,
//   but none to fill in.
// - The form notice, once per document when it opens (announceForm).
// - What "Saved signatures (N)" in the More menu and sheet opens (openSavedSignatures).
// A sub-tool is chosen with setFillTool: Sign and Initials open the signature dialog. Pictures are
// added in Modifica (Aggiungi immagine). While a signature waits to be placed, the hint says where
// to tap, with "Put it in the middle" and Cancel.
// Styled by styles/shell.css (the banner's tools) and styles/phone.css (the strip).
import { effect, signal, untracked } from "@preact/signals";
import type { FunctionComponent, RefObject } from "preact";
import type { FormInfo } from "../../engine/protocol";
import { t } from "../../i18n";
import {
  currentPage, doc, editingStopped, fillMode, fillTool, flushEditor, focusedField, pendingPlacement, showDialog,
  showToast, tool, type FillTool, type Signature,
} from "../../state";
import type { OpenDoc } from "../../viewer/model";
import { cancelPlacement, focusNextField, setFillTool, setTool, todayText } from "../actions";
import {
  IconCalendar, IconCheck, IconClose, IconCrossBox, IconFont, IconInitials, IconNextField, IconSignature, IconTickBox,
} from "../icons";
import { isCoarse, isNarrow } from "../media";
import { PlaceCentreButton, SubTools, ToolStrip, type SubToolItem } from "../SubTools";

// ---------------------------------------------------------------------------------------------
// What the form offers

/** The fields of a form the user can fill in, by name (a field with widgets on several pages counts once). */
export interface FormFields {
  fields: number;
  required: number;
}

/**
 * The fields of the form of `d` the user can fill in, or null when there are none: no form, a
 * dynamic XFA form, a signed PDF whose only field is its signature, a form whose fields are all
 * read-only or buttons. FormInfo counts them once, when the document opens (distinct names, not
 * locked, signature fields left out: "Sign here" is on the page anyway), so nothing has to read
 * every page's fields for the banner, the panel or the notice.
 */
export function fillableFields(d: OpenDoc): FormFields | null {
  const form = d.info.form;
  if (!form || form.xfa === "dynamic" || form.fields <= 0) return null;
  return { fields: form.fields, required: Math.min(form.required, form.fields) };
}

// ---------------------------------------------------------------------------------------------
// Texts

/** "12 fields, 3 required", with the singulars ("1 field", "12 fields, 1 required"). */
export function formCountText(fields: number, required: number): string {
  if (fields === 1) return required > 0 ? t("form.countOneRequired") : t("form.countOne");
  if (required <= 0) return t("form.countNoRequired", { count: fields });
  if (required === 1) return t("form.countRequiredOne", { count: fields });
  return t("form.count", { count: fields, required });
}

/**
 * What the user should know about the form before filling it in: a dynamic XFA form cannot be
 * filled in here; filling in removes a static XFA part; scripts never run. The last two only when
 * there is something to fill in (`fillable`).
 */
export function formNotes(form: FormInfo | null, fillable: boolean): string[] {
  if (!form) return [];
  if (form.xfa === "dynamic") return [t("form.xfa")];
  if (!fillable) return [];
  const notes: string[] = [];
  if (form.xfa === "static") notes.push(t("form.xfaStatic"));
  if (form.scripts) notes.push(t("form.calculations"));
  return notes;
}

/** The banner's hint: where to tap for the signature waiting to be placed, or what a tap does. */
export function fillHint(fillable: boolean, pending: Signature | null, touch: boolean): string {
  if (pending) {
    if (pending.kind === "initials") return t(touch ? "fill.placeInitialsTouch" : "fill.placeInitials");
    return t(touch ? "fill.placeSignatureTouch" : "fill.placeSignature");
  }
  if (fillable) return t(touch ? "fill.hintTouch" : "fill.hint");
  return t(touch ? "fill.hintNoFieldsTouch" : "fill.hintNoFields");
}

// ---------------------------------------------------------------------------------------------
// The sub-tools

/** In the order of the bar. Each one changes what a tap on the page does: all are toggles. */
const FILL_TOOLS: readonly { id: FillTool; Icon: FunctionComponent }[] = [
  { id: "text", Icon: IconFont },
  { id: "check", Icon: IconTickBox },
  { id: "cross", Icon: IconCrossBox },
  { id: "date", Icon: IconCalendar },
  { id: "signature", Icon: IconSignature },
  { id: "initials", Icon: IconInitials },
];

function subToolLabel(id: FillTool): string {
  switch (id) {
    case "text": return t("fill.text");
    case "check": return t("fill.check");
    case "cross": return t("fill.cross");
    case "date": return t("fill.date");
    case "signature": return t("fill.signature");
    case "initials": return t("fill.initials");
  }
}

function subToolTip(id: FillTool, touch: boolean): string {
  switch (id) {
    case "text": return t(touch ? "fill.textTipTouch" : "fill.textTip");
    case "check": return t("fill.checkTip");
    case "cross": return t("fill.crossTip");
    case "date": return t("fill.dateTip", { date: todayText() });
    case "signature": return t("fill.signatureTip");
    case "initials": return t("fill.initialsTip");
  }
}

/**
 * The sub-tools of Compila e firma as its toolbar shows them (ui/SubTools.tsx), `current` lit:
 * ✓, ✗ and Date stay lit for ticking many boxes, Sign and Initials until one is placed.
 */
export function fillToolItems(current: FillTool, touch: boolean): SubToolItem[] {
  return FILL_TOOLS.map(({ id, Icon }) => ({
    id,
    Icon,
    label: subToolLabel(id),
    tip: subToolTip(id, touch),
    pressed: current === id,
    onChoose: () => setFillTool(id),
  }));
}

/** Phones: the sub-tools in a strip right above the tab bar (Viewer decides when it shows). */
export function FillStrip() {
  return <ToolStrip label={t("fill.toolbar")} items={fillToolItems(fillTool.value, isCoarse.value)} />;
}

// ---------------------------------------------------------------------------------------------
// "Next empty field"

/**
 * The field the focus was in last, in which document. Pressing a button takes the focus out of a
 * field, and its blur clears focusedField, before the button's click runs: "Next empty field"
 * still goes on from there.
 */
let lastField: { docId: number; pageIndex: number; name: string; index: number } | null = null;
effect(() => {
  const focus = focusedField.value;
  const d = doc.peek();
  if (focus && d) lastField = { docId: d.id, ...focus };
});

/**
 * Forget the field the focus was in last: its page index no longer holds (a page operation, or
 * its undo or redo, moved the pages: ui/actions.ts, closePageWork).
 */
export function forgetLastField(): void {
  lastField = null;
}

/**
 * Where "Next empty field" goes on from: the focused field, else the one the focus was in last
 * when its page is still about where the user is (the current page or the one beside it: they
 * may have scrolled on a little), else the start of the current page.
 */
export function nextEmptyFrom(d: OpenDoc): { pageIndex: number; index: number; name?: string } {
  const here = currentPage.peek();
  const last = lastField && lastField.docId === d.id && Math.abs(lastField.pageIndex - here) <= 1 ? lastField : null;
  const focus = focusedField.peek() ?? last;
  return focus ? { pageIndex: focus.pageIndex, index: focus.index, name: focus.name } : { pageIndex: here, index: -1 };
}

/**
 * After this long, a search for the next empty field shows that it is busy. One that finds the
 * field among the fields already read is done well before; one that reads pages from the engine
 * (a long form, the empty field many pages on) or waits for an edit to land takes longer.
 */
export const SEEK_BUSY_MS = 200;

/** "Next empty field" has been looking for longer than SEEK_BUSY_MS: its button shows it. */
export const seekingEmpty = signal(false);

/** The search under way, if any: a second press joins it rather than starting another. */
let search: { doc: OpenDoc; run: Promise<void> } | null = null;

/**
 * "Next empty field": the next field still empty after the one the user is in (never that one
 * again), or from the current page, across pages and round to the start (focusNextField moves
 * the focus there). Nothing is read in advance: focusNextField goes through the pages from there
 * in order, with the fields the viewer has already read, and asks the engine only for the pages
 * it gets to, until it finds one. What the field holds is written first, so a value just typed
 * counts. When the field the user is in is the last empty one, focusNextField keeps the focus
 * there and says so itself (form.lastEmpty); "No empty fields left" only when none is empty.
 */
export function goToNextEmptyField(): Promise<void> {
  const d = doc.peek();
  if (!d) return Promise.resolve();
  if (search && search.doc === d) return search.run;
  const from = nextEmptyFrom(d);
  const busyTimer = setTimeout(() => {
    if (search?.run === run) seekingEmpty.value = true;
  }, SEEK_BUSY_MS);
  const run: Promise<void> = (async () => {
    await flushEditor();
    if (doc.peek() !== d) return;
    if (!(await focusNextField(from, true)) && doc.peek() === d) showToast("info", t("form.noEmpty"));
  })().finally(() => {
    clearTimeout(busyTimer);
    if (search?.run === run) {
      search = null;
      seekingEmpty.value = false;
    }
  });
  search = { doc: d, run };
  return run;
}

/** A press keeps the focus where it is (in the field, with a phone's keyboard up): see lastField too. */
const keepFocus = (e: Event) => e.preventDefault();

// ---------------------------------------------------------------------------------------------
// The banner

/** The document whose notes were said as toasts (once per document, the first time Fill mode is on in the phone layout). */
let notedDoc = -1;

function toastNotesOnce(d: OpenDoc) {
  if (notedDoc === d.id) return;
  notedDoc = d.id;
  for (const note of formNotes(d.info.form, fillableFields(d) !== null)) showToast("warn", note);
}

// The phone's bar has no room for the form's notes: they are said as toasts, once per document,
// when Fill mode is on in the phone layout (turned on there, or the window narrowed while it is).
effect(() => {
  const d = doc.value;
  if (d && fillMode.value && isNarrow.value) untracked(() => toastNotesOnce(d));
});

/**
 * Fill mode's bar above the pages (Viewer.tsx mounts it as the banner of this mode). "Put it in
 * the middle" is there for every sub-tool (each places something with a tap) and for the
 * signature waiting to be placed.
 */
export function FillBanner({ doc: d, elRef }: { doc: OpenDoc; elRef: RefObject<HTMLDivElement> }) {
  const narrow = isNarrow.value;
  const touch = isCoarse.value;
  const pending = pendingPlacement.value;
  const form = d.info.form;
  const fields = fillableFields(d);
  const notes = narrow ? [] : formNotes(form, fields !== null);
  const seeking = seekingEmpty.value;

  const info = (
    <div class="tool-banner-info">
      {/* A status: the hint changes while a signature waits to be placed, and that is said. */}
      <p class="edit-banner-text" role="status">{fillHint(fields !== null, pending, touch)}</p>
      {fields && !pending && (
        <p class="fill-banner-form">
          <span class="fill-banner-count">{formCountText(fields.fields, fields.required)}</span>
          {/* Busy while a long search runs: the spinner in place of its icon, and said once.
              A second press joins the same search (goToNextEmptyField). */}
          <button
            type="button"
            class="btn fill-banner-link"
            title={t("form.nextEmptyTip")}
            aria-busy={seeking || undefined}
            onMouseDown={keepFocus}
            onClick={() => void goToNextEmptyField()}
          >
            {seeking ? <span class="spinner" aria-hidden="true" /> : <IconNextField />}
            <span>{t("form.nextEmpty")}</span>
          </button>
          <span class="sr-only" role="status">{seeking ? t("form.nextEmptyBusy") : ""}</span>
        </p>
      )}
      {notes.map((note) => <p key={note} class="fill-banner-note">{note}</p>)}
    </div>
  );

  // Desktop: the tools and the buttons on the first row, so they never move; the hint on the
  // second. Phones: the hint first, Done beside it. The DOM follows what is seen (Tab order).
  return (
    <div ref={elRef} class={narrow ? "edit-banner is-tools is-fill is-compact" : "edit-banner is-tools is-fill"}>
      {!narrow && (
        <div class="tool-banner-lead">
          <span class="edit-banner-mark" aria-hidden="true" />
          <span class="tool-banner-title">{t("tools.fill")}</span>
          <SubTools variant="banner" label={t("fill.toolbar")} items={fillToolItems(fillTool.value, touch)} />
        </div>
      )}
      {narrow && info}
      <div class="tool-banner-actions">
        <PlaceCentreButton />
        {pending && (
          <button
            type="button"
            class="btn btn-secondary tool-banner-btn"
            title={t("edit.cancelTip", { key: t("key.esc") })}
            onClick={cancelPlacement}
          >
            <IconClose />
            <span>{t("common.cancel")}</span>
          </button>
        )}
        {/* Esc leaves Compila e firma with every sub-tool once nothing is open (it first closes
            the writer, cancels the signature waiting or deselects the picture): the tooltip names it. */}
        <button
          type="button"
          class="btn btn-secondary edit-banner-done"
          title={t("fill.doneTip", { key: t("key.esc") })}
          onClick={() => void setTool(null)}
        >
          <IconCheck />
          <span>{t("edit.done")}</span>
        </button>
      </div>
      {!narrow && info}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The form notice

let announcedDoc = -1;

/**
 * Once per document, when it opens: a polite toast that it is a form (D2: its fields work without
 * choosing a tool too), or that a dynamic XFA form cannot be filled in here. Only a form with
 * fields to fill in is one (fillableFields, FormInfo's counts: no page is read for it): not a
 * signed PDF whose only field is its signature, nor a form whose fields are all read-only.
 */
export function announceForm(d: OpenDoc): void {
  if (announcedDoc === d.id) return;
  announcedDoc = d.id;
  const form = d.info.form;
  if (!form) return;
  if (form.xfa === "dynamic") showToast("warn", t("form.xfa"));
  else if (fillableFields(d)) showToast("info", t(isCoarse.peek() ? "form.notice" : "form.noticeMouse"));
}

// ---------------------------------------------------------------------------------------------
// Saved signatures (the More menu and sheet)

/** Which chooser "Saved signatures" opens: the signatures', unless only initials are saved. */
export function savedKind(saved: readonly Signature[]): Signature["kind"] {
  return saved.some((s) => s.kind === "signature") || !saved.length ? "signature" : "initials";
}

/**
 * "Saved signatures (N)": their chooser, to use one or forget it. A signature chosen there is
 * placed with the next tap, so Fill mode is turned on first (unless editing has stopped: then
 * the chooser opens for forgetting only).
 */
export async function openSavedSignatures(kind: Signature["kind"]) {
  if (!doc.peek()) return;
  if (tool.peek() !== "fill" && !editingStopped.peek()) await setTool("fill");
  if (tool.peek() === "fill") setFillTool(kind);
  else showDialog({ kind: "signature", mode: kind, forField: null });
}
