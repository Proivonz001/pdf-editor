// Downloading with options, and the PDF/A questions (shown from ui/Dialogs.tsx):
// - "How do you want to download it?": the format (regular PDF or PDF/A for archiving) and a
//   password, for one download. A dialog on desktop, a bottom sheet on phones. It opens on the
//   one-tap choice (actions.ts, defaultChoice): a protected file starts protected, and an empty
//   field then means "the same password as before" (unless that password cannot be reused:
//   then a new one is asked for). Share opens it as "How do you want to share it?" when the
//   file's password must be chosen anew, and it then shares instead of downloading.
// - "This PDF can't be saved as PDF/A": the reasons, one line each, and a regular PDF instead.
// - "Making it PDF/A changes a few things": what the conversion removes or changes, to confirm.
// The texts for every code of the engine's PDF/A report live here too, with their plurals.
// Styled by styles/overlays.css (.dl-*, .dialog-list) and styles/phone.css (.sheet-download).
import type { ComponentChildren, RefObject } from "preact";
import { useId, useRef, useState } from "preact/hooks";
import {
  passwordProblem, type DocInfo, type PdfaBlockerCode, type PdfaIssue, type PdfaRemovalCode, type PdfaWarningCode,
  type SaveFormat,
} from "../engine/protocol";
import { t } from "../i18n";
import { dialog, showDialog, type DialogState, type SavePurpose } from "../state";
import { fontDisplayName } from "../viewer/fontName";
import type { OpenDoc } from "../viewer/model";
import { defaultChoice, download, share, type DownloadChoice } from "./actions";
import { Dialog } from "./Dialog";
import { IconInfo } from "./icons";
import { isNarrow } from "./media";
import { Sheet } from "./Sheet";

// ---------------------------------------------------------------------------------------------
// The form's rules (plain functions, tested in tests/ui.test.ts)

export interface OptionsForm {
  format: SaveFormat;
  /** "Protect with a password" is ticked (it does not apply to a PDF/A). */
  protect: boolean;
  password: string;
  repeat: string;
}

export type PasswordFieldProblem = "empty" | "too-long" | "unsupported";

export interface OptionsProblems {
  password: PasswordFieldProblem | null;
  /** Shown only once the password itself is fine. */
  repeat: "mismatch" | null;
}

/**
 * What stops the form. `canKeep`: DocInfo.canKeepPassword, meaning the file was opened with a
 * password that can protect the download again, so an empty field keeps that one (the repeat
 * field is hidden then, and ignored).
 */
export function optionsProblems(form: OptionsForm, canKeep: boolean): OptionsProblems {
  if (form.format === "pdfa-2b" || !form.protect || (canKeep && form.password === "")) {
    return { password: null, repeat: null };
  }
  const password = passwordProblem(form.password);
  return { password, repeat: !password && form.repeat !== form.password ? "mismatch" : null };
}

/**
 * The download the form asks for (check optionsProblems first). For a PDF/A the password part is
 * the one-tap one: it is not sent with the PDF/A, only used if the user takes a regular PDF
 * instead. A file whose password can be kept stays protected then; one whose password cannot
 * has none there, so actions.ts opens these options again rather than write it unprotected.
 */
export function choiceFromForm(form: OptionsForm, info: DocInfo): DownloadChoice {
  if (form.format === "pdfa-2b") return { format: "pdfa-2b", password: defaultChoice(info).password };
  if (!form.protect) return { format: "pdf", password: { mode: "none" } };
  if (info.canKeepPassword && form.password === "") return { format: "pdf", password: { mode: "keep" } };
  return { format: "pdf", password: { mode: "set", password: form.password } };
}

/**
 * The password cut into what people see as one character: a letter with its accents, an emoji
 * with its invisible style marks and the emoji joined to it (U+200D), so the message can quote
 * "❤️" rather than an invisible mark. Close enough to Unicode's grapheme clusters for that,
 * without Intl.Segmenter (Firefox has it only from version 125).
 */
const CHARACTER = /[^\p{M}\u200D]\p{M}*(?:\u200D[^\p{M}\u200D]\p{M}*)*|[\p{M}\u200D]+/gu;

/** The characters that alone make a password "unsupported" (none when the rule is not per character). */
export function unsupportedChars(password: string): string[] {
  const chars = password.match(CHARACTER) ?? [];
  return [...new Set(chars.filter((c) => passwordProblem(c) === "unsupported"))];
}

/**
 * How the message names a refused character: between quotes when it can be seen; by its kind
 * when it cannot (a tab, a space other than the usual one, a control or formatting character,
 * an accent or emoji mark on its own), since empty quotes would say nothing.
 */
export function charLabel(char: string): string {
  if (char === "\t") return t("dlopt.tab");
  if (/^\p{Zs}$/u.test(char)) return t("dlopt.specialSpace");
  if (/^[\p{Cc}\p{Cf}\p{Cs}\p{Cn}\p{Zl}\p{Zp}\p{M}]+$/u.test(char)) return t("dlopt.invisible");
  return `“${char}”`;
}

/** The error under the password field: what to change, the characters named one by one when it can. */
export function passwordMessage(problem: PasswordFieldProblem, password: string): string {
  if (problem === "empty") return t("dlopt.errEmpty");
  if (problem === "too-long") return t("dlopt.errTooLong");
  const labels = [...new Set(unsupportedChars(password).map(charLabel))];
  // Each character is fine alone, only not together (e.g. right-to-left and left-to-right
  // writing mixed): the message says so without a list.
  if (!labels.length) return t("dlopt.errCharsAny");
  return t(labels.length === 1 ? "dlopt.errChar" : "dlopt.errChars", { chars: labels.join(", ") });
}

// ---------------------------------------------------------------------------------------------
// Texts of the PDF/A report

/** A font name from the file, readable: "ABCDEF+Calibri-Bold" → "Calibri". Empty when there is none. */
function fontOf(issue: PdfaIssue): string {
  const raw = issue.detail?.trim() ?? "";
  return raw ? fontDisplayName(raw) || raw.replace(/^[A-Z]{6}\+/, "") : "";
}

/** No count: the "Any" text; 1: the singular; more: the plural with the number. */
function counted(count: number | undefined, any: string, one: string, many: string): string {
  if (count === undefined || !Number.isFinite(count) || count < 1) return any;
  return count === 1 ? one : many;
}

export function blockerText(issue: PdfaIssue<PdfaBlockerCode>): string {
  const font = fontOf(issue);
  switch (issue.code) {
    case "font-not-embedded": return font ? t("pdfa.b.fontNotEmbedded", { font }) : t("pdfa.b.fontNotEmbeddedAny");
    case "font-changed": return font ? t("pdfa.b.fontChanged", { font }) : t("pdfa.b.fontChangedAny");
    case "font-widths": return font ? t("pdfa.b.fontWidths", { font }) : t("pdfa.b.fontWidthsAny");
    case "notdef": return font ? t("pdfa.b.notdef", { font }) : t("pdfa.b.notdefAny");
    case "cmyk": return t("pdfa.b.cmyk");
    case "icc-invalid": return t("pdfa.b.iccInvalid");
    case "xfa-dynamic": return t("pdfa.b.xfaDynamic");
    case "portfolio": return t("pdfa.b.portfolio");
    case "external-content": return t("pdfa.b.external");
  }
}

export function removalText(issue: PdfaIssue<PdfaRemovalCode>): string {
  const n = issue.count;
  const count = n ?? 0;
  switch (issue.code) {
    case "javascript":
      return counted(n, t("pdfa.r.javascriptAny"), t("pdfa.r.javascriptOne"), t("pdfa.r.javascriptMany", { count }));
    case "actions":
      return counted(n, t("pdfa.r.actionsAny"), t("pdfa.r.actionsOne"), t("pdfa.r.actionsMany", { count }));
    case "attachments": {
      const name = issue.detail?.trim();
      if (name && (n === undefined || n === 1)) return t("pdfa.r.attachmentNamed", { name });
      return counted(n, t("pdfa.r.attachmentsAny"), t("pdfa.r.attachmentsOne"), t("pdfa.r.attachmentsMany", { count }));
    }
    case "annotations":
      return counted(n, t("pdfa.r.annotationsAny"), t("pdfa.r.annotationsOne"), t("pdfa.r.annotationsMany", { count }));
    case "hidden-fields-shown":
      return counted(n, t("pdfa.r.hiddenFieldsAny"), t("pdfa.r.hiddenFieldsOne"), t("pdfa.r.hiddenFieldsMany", { count }));
    case "xfa-data":
      return t("pdfa.r.xfaData");
  }
}

export function warningText(issue: PdfaIssue<PdfaWarningCode>): string {
  const n = issue.count;
  switch (issue.code) {
    case "text-may-shift": {
      const font = fontOf(issue);
      return font ? t("pdfa.w.textMayShift", { font }) : t("pdfa.w.textMayShiftAny");
    }
    case "signature-invalid":
      return t("pdfa.w.signatureInvalid");
    case "blend-mode":
      return counted(n, t("pdfa.w.blendModeAny"), t("pdfa.w.blendModeOne"), t("pdfa.w.blendModeMany", { count: n ?? 0 }));
    case "output-intent-replaced":
      return t("pdfa.w.outputIntent");
  }
}

/** Warnings in the confirmation, the ones that matter most first. */
const WARNING_ORDER: readonly PdfaWarningCode[] = ["signature-invalid", "text-may-shift", "blend-mode", "output-intent-replaced"];

/** The lines of the confirmation: what is removed, then what may change. Repeated lines once. */
export function confirmLines(removals: PdfaIssue<PdfaRemovalCode>[], warnings: PdfaIssue<PdfaWarningCode>[]): string[] {
  const sorted = [...warnings].sort((a, b) => WARNING_ORDER.indexOf(a.code) - WARNING_ORDER.indexOf(b.code));
  return [...new Set([...removals.map(removalText), ...sorted.map(warningText)])];
}

// ---------------------------------------------------------------------------------------------
// "How do you want to download it?"

function FormatChoice(p: {
  name: string;
  value: SaveFormat;
  checked: boolean;
  title: string;
  hint: string;
  onPick: (value: SaveFormat) => void;
}) {
  const titleId = useId();
  const hintId = useId();
  // Named by the title and described by the hint (the label holds both: named by it, the
  // hint would be read twice).
  return (
    <label class="dl-choice">
      <input
        type="radio"
        class="dl-radio"
        name={p.name}
        value={p.value}
        checked={p.checked}
        aria-labelledby={titleId}
        aria-describedby={hintId}
        data-autofocus={p.checked || undefined}
        onChange={() => p.onPick(p.value)}
      />
      <span class="dl-choice-text">
        <span id={titleId} class="dl-choice-title">{p.title}</span>
        <span id={hintId} class="dl-choice-hint">{p.hint}</span>
      </span>
    </label>
  );
}

/** A password field with its label, an optional hint and its error, all tied to it. */
function PasswordField(p: {
  label: string;
  value: string;
  shown: boolean;
  error: string | null;
  inputRef: RefObject<HTMLInputElement>;
  placeholder?: string;
  hint?: string;
  /** Next to the label (the Show toggle). */
  aside?: ComponentChildren;
  onInput: (value: string) => void;
}) {
  const id = useId();
  const described = [p.hint && `${id}-hint`, p.error && `${id}-error`].filter(Boolean).join(" ") || undefined;
  return (
    <div class="field-group">
      <div class="dl-label-row">
        <label class="field-label" for={id}>{p.label}</label>
        {p.aside}
      </div>
      <input
        id={id}
        ref={p.inputRef}
        class="field"
        type={p.shown ? "text" : "password"}
        autocomplete="new-password"
        autocapitalize="off"
        autocorrect="off"
        spellcheck={false}
        placeholder={p.placeholder}
        value={p.value}
        aria-invalid={p.error ? true : undefined}
        aria-describedby={described}
        onInput={(e) => p.onInput(e.currentTarget.value)}
      />
      {p.hint && <p id={`${id}-hint`} class="dl-hint">{p.hint}</p>}
      {p.error && <p id={`${id}-error`} class="field-error">{p.error}</p>}
    </div>
  );
}

/** The form's title: it says what the button does. */
const titleOf = (purpose: SavePurpose) => (purpose === "share" ? t("dlopt.titleShare") : t("dlopt.title"));

function DownloadForm(p: { doc: OpenDoc; purpose: SavePurpose; heading: boolean; onCancel: () => void }) {
  const info = p.doc.info;
  const canKeep = info.canKeepPassword;
  const sharing = p.purpose === "share";
  const [form, setForm] = useState<OptionsForm>(() => ({
    format: defaultChoice(info).format,
    protect: info.needsPassword,
    password: "",
    repeat: "",
  }));
  const [shown, setShown] = useState(false);
  /** Errors show once Download was pressed, then follow the typing. */
  const [tried, setTried] = useState(false);
  /**
   * The error read out when Download is refused and the focus cannot move to the field (Enter
   * was pressed in it): no focus change, so nothing else would announce it. `n` remounts the
   * alert, so a second Enter with the same error is read again.
   */
  const [spoken, setSpoken] = useState<{ n: number; text: string } | null>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const repeatRef = useRef<HTMLInputElement>(null);
  const name = useId();
  const pdfaNoteId = useId();

  const update = (patch: Partial<OptionsForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    setSpoken(null); // the error under the field follows the typing; the old alert goes
  };
  const pdfa = form.format === "pdfa-2b";
  const protecting = form.protect && !pdfa;
  const problems = optionsProblems(form, canKeep);
  const passwordError = tried && problems.password ? passwordMessage(problems.password, form.password) : null;
  const repeatError = tried && problems.repeat ? t("dlopt.errMismatch") : null;

  const submit = (e: Event) => {
    e.preventDefault();
    if (problems.password || problems.repeat) {
      setTried(true);
      const field = (problems.password ? passwordRef : repeatRef).current;
      // Moving the focus reads the field with its error (aria-describedby); saying it here too
      // would read it twice.
      if (field && document.activeElement === field) {
        const text = problems.password ? passwordMessage(problems.password, form.password) : t("dlopt.errMismatch");
        setSpoken((a) => ({ n: (a?.n ?? 0) + 1, text }));
      }
      field?.focus();
      return;
    }
    const choice = choiceFromForm(form, info);
    showDialog(null);
    // Still inside the click (or Enter): the save dialog or share sheet may open as a user gesture.
    void (sharing ? share(choice) : download(choice));
  };

  return (
    <form class="dialog-form dl-form" onSubmit={submit} noValidate>
      {p.heading && <h2 id="dlg-title" class="dialog-title">{titleOf(p.purpose)}</h2>}
      <fieldset class="dl-group">
        <legend class="dl-legend">{t("dlopt.format")}</legend>
        <FormatChoice name={name} value="pdf" checked={!pdfa} title={t("dlopt.pdf")} hint={t("dlopt.pdfHint")}
          onPick={(format) => update({ format })} />
        <FormatChoice name={name} value="pdfa-2b" checked={pdfa} title={t("dlopt.pdfa")} hint={t("dlopt.pdfaHint")}
          onPick={(format) => update({ format })} />
      </fieldset>
      <div class="dl-group">
        <label class={pdfa ? "dl-check is-disabled" : "dl-check"}>
          <input
            type="checkbox"
            class="dl-checkbox"
            checked={protecting}
            disabled={pdfa}
            aria-describedby={pdfa ? pdfaNoteId : undefined}
            onChange={(e) => update({ protect: e.currentTarget.checked })}
          />
          <span>{t("dlopt.protect")}</span>
        </label>
        {pdfa && <p id={pdfaNoteId} class="dl-hint dl-check-note">{t("dlopt.protectPdfa")}</p>}
        {protecting && (
          <div class="dl-fields">
            <PasswordField
              label={t("dlopt.password")}
              value={form.password}
              shown={shown}
              error={passwordError}
              inputRef={passwordRef}
              placeholder={canKeep ? t("dlopt.samePlaceholder") : undefined}
              hint={canKeep ? t("dlopt.sameHint") : info.needsPassword ? t("dlopt.cannotKeepHint") : undefined}
              aside={
                <button
                  type="button"
                  class="btn dl-show"
                  aria-pressed={shown}
                  aria-label={t("dlopt.showLabel")}
                  title={t("dlopt.showLabel")}
                  onClick={() => setShown(!shown)}
                >
                  {t("dlopt.show")}
                </button>
              }
              onInput={(password) => update({ password })}
            />
            {/* Keeping the old password needs no repeat: it was right when the file opened. */}
            {(!canKeep || form.password !== "") && (
              <PasswordField
                label={t("dlopt.repeat")}
                value={form.repeat}
                shown={shown}
                error={repeatError}
                inputRef={repeatRef}
                onInput={(repeat) => update({ repeat })}
              />
            )}
          </div>
        )}
      </div>
      {info.signatures > 0 && (
        <p class="dl-note">
          <IconInfo />
          <span>{t("dlopt.signed")}</span>
        </p>
      )}
      {/* Inside the modal: the toasts' live regions are outside it, and inert while it is open. */}
      {spoken && <p key={spoken.n} class="sr-only" role="alert">{spoken.text}</p>}
      <div class="dialog-actions">
        <button type="button" class="btn btn-secondary" onClick={p.onCancel}>{t("common.cancel")}</button>
        <button type="submit" class="btn btn-primary">{sharing ? t("share.share") : t("dlopt.download")}</button>
      </div>
    </form>
  );
}

/** The options for one download or share: a dialog on desktop, a bottom sheet on phones. */
export function DownloadOptions({ doc, purpose }: { doc: OpenDoc; purpose: SavePurpose }) {
  const close = () => showDialog(null);
  // Chosen once, when it opens (Dialogs.tsx mounts it afresh for each opening): switching at
  // 640 px while it is open (turning the phone) would remount the form and lose what was typed.
  // Either one works at any width.
  const [narrow] = useState(() => isNarrow.peek());
  if (narrow) {
    return (
      <Sheet title={titleOf(purpose)} class="sheet-download" onClose={close}>
        <DownloadForm doc={doc} purpose={purpose} heading={false} onCancel={close} />
      </Sheet>
    );
  }
  return (
    <Dialog labelledBy="dlg-title" onCancel={close}>
      <DownloadForm doc={doc} purpose={purpose} heading onCancel={close} />
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------
// The PDF/A questions

type Of<K extends DialogState["kind"]> = Extract<DialogState, { kind: K }>;

function answer(state: Of<"pdfa-blocked"> | Of<"pdfa-confirm">, yes: boolean) {
  dialog.value = null;
  state.resolve(yes);
}

function Lines({ lines }: { lines: string[] }) {
  return (
    <ul class="dialog-list">
      {lines.map((line, i) => <li key={i}>{line}</li>)}
    </ul>
  );
}

/**
 * No PDF/A possible: why, and a regular PDF instead. Cancel has the focus: the regular PDF is
 * not what the user asked for, so Enter does not pick it by accident.
 */
export function PdfaBlockedDialog({ state }: { state: Of<"pdfa-blocked"> }) {
  const lines = [...new Set(state.blockers.map(blockerText))];
  const share = state.purpose === "share";
  return (
    <Dialog labelledBy="dlg-title" describedBy="dlg-body" onCancel={() => answer(state, false)}>
      <div class="dialog-text">
        <h2 id="dlg-title" class="dialog-title">{t("pdfa.blockedTitle")}</h2>
        <div id="dlg-body" class="dialog-body">
          {lines.length ? (
            <>
              <p>{lines.length === 1 ? t("pdfa.blockedReason") : t("pdfa.blockedReasons")}</p>
              <Lines lines={lines} />
            </>
          ) : (
            <p>{t("pdfa.blockedFinal")}</p>
          )}
          <p>{share ? t("pdfa.fallbackShareBody") : t("pdfa.fallbackDownloadBody")}</p>
        </div>
      </div>
      <div class="dialog-actions">
        <button type="button" class="btn btn-secondary" data-autofocus onClick={() => answer(state, false)}>
          {t("common.cancel")}
        </button>
        <button type="button" class="btn btn-primary" onClick={() => answer(state, true)}>
          {share ? t("pdfa.fallbackShare") : t("pdfa.fallbackDownload")}
        </button>
      </div>
    </Dialog>
  );
}

/** The conversion removes or changes something: list it and ask. Cancel has the focus. */
export function PdfaConfirmDialog({ state }: { state: Of<"pdfa-confirm"> }) {
  const share = state.purpose === "share";
  return (
    <Dialog labelledBy="dlg-title" describedBy="dlg-body" onCancel={() => answer(state, false)}>
      <div class="dialog-text">
        <h2 id="dlg-title" class="dialog-title">{t("pdfa.confirmTitle")}</h2>
        <div id="dlg-body" class="dialog-body">
          <p>{t("pdfa.confirmIntro")}</p>
          <Lines lines={confirmLines(state.removals, state.warnings)} />
          <p>{t("pdfa.confirmOriginal")}</p>
        </div>
      </div>
      <div class="dialog-actions">
        <button type="button" class="btn btn-secondary" data-autofocus onClick={() => answer(state, false)}>
          {t("common.cancel")}
        </button>
        <button type="button" class="btn btn-primary" onClick={() => answer(state, true)}>
          {share ? t("pdfa.confirmShare") : t("pdfa.confirmDownload")}
        </button>
      </div>
    </Dialog>
  );
}
