// The dialogs the app can show (one at a time, from the `dialog` signal): confirm, alert,
// password for protected PDFs, "ready to share" when the share sheet needs another tap, the
// download options and PDF/A questions (ui/DownloadOptions.tsx), and for Fill & sign: the
// signature chooser and creator (ui/fill/SignatureSheet.tsx), "On every page…" for initials, and
// "Some required fields are empty" before a download; "Install the app", with this browser's
// steps (ui/InstallDialog.tsx); and for the page organizer, "From another PDF…" (its page picker)
// and "Move to…" (ui/organizer).
// Cancel is always the quiet secondary button; a confirm that throws edits away is red, and
// it is Cancel that gets the focus, so Enter never loses work by accident.
import { useId, useState } from "preact/hooks";
import { t } from "../i18n";
import { dialog, doc, showDialog, type DialogState } from "../state";
import { initialsChoices, openFile, shareFile } from "./actions";
import { Dialog } from "./Dialog";
import { DownloadOptions, PdfaBlockedDialog, PdfaConfirmDialog } from "./DownloadOptions";
import { SignatureDialog } from "./fill/SignatureSheet";
import { IconShare } from "./icons";
import { InstallDialog } from "./InstallDialog";
import { InsertFromPdfDialog } from "./organizer/InsertFromPdfDialog";
import { MovePagesDialog } from "./organizer/MovePagesDialog";

type Of<K extends DialogState["kind"]> = Extract<DialogState, { kind: K }>;

const close = () => showDialog(null);

function DialogText({ title, body }: { title: string; body: string }) {
  return (
    <div class="dialog-text">
      <h2 id="dlg-title" class="dialog-title">{title}</h2>
      <p id="dlg-body" class="dialog-body">{body}</p>
    </div>
  );
}

function ConfirmDialog({ state }: { state: Of<"confirm"> }) {
  const answer = (ok: boolean) => {
    dialog.value = null;
    state.resolve(ok);
  };
  return (
    <Dialog labelledBy="dlg-title" describedBy="dlg-body" onCancel={() => answer(false)}>
      <DialogText title={state.title} body={state.body} />
      <div class="dialog-actions">
        <button type="button" class="btn btn-secondary" data-autofocus onClick={() => answer(false)}>
          {t("common.cancel")}
        </button>
        <button type="button" class="btn btn-danger" onClick={() => answer(true)}>{state.confirmLabel}</button>
      </div>
    </Dialog>
  );
}

function AlertDialog({ state }: { state: Of<"alert"> }) {
  return (
    <Dialog labelledBy="dlg-title" describedBy="dlg-body" onCancel={close}>
      <DialogText title={state.title} body={state.body} />
      <div class="dialog-actions">
        <button type="button" class="btn btn-primary" data-autofocus onClick={close}>{t("common.ok")}</button>
      </div>
    </Dialog>
  );
}

function PasswordDialog({ state }: { state: Of<"password"> }) {
  const [password, setPassword] = useState("");
  const submit = (e: Event) => {
    e.preventDefault();
    if (!password) return;
    close();
    void openFile(state.file, { password, confirmed: true });
  };
  return (
    <Dialog labelledBy="dlg-title" describedBy="dlg-body" onCancel={close}>
      <form class="dialog-form" onSubmit={submit} noValidate>
        <DialogText title={t("password.title")} body={t("password.body", { name: state.file.name })} />
        <div class="field-group">
          <label class="field-label" for="pdf-password">{t("password.label")}</label>
          <input
            id="pdf-password"
            class="field"
            type="password"
            autocomplete="off"
            spellcheck={false}
            data-autofocus
            value={password}
            aria-invalid={state.wrong}
            aria-describedby={state.wrong ? "pdf-password-error" : undefined}
            onInput={(e) => setPassword(e.currentTarget.value)}
          />
          {state.wrong && <p id="pdf-password-error" class="field-error">{t("password.wrong")}</p>}
        </div>
        <div class="dialog-actions">
          <button type="button" class="btn btn-secondary" onClick={close}>{t("common.cancel")}</button>
          <button type="submit" class="btn btn-primary" disabled={!password}>{t("password.open")}</button>
        </div>
      </form>
    </Dialog>
  );
}

function ShareDialog({ state }: { state: Of<"share"> }) {
  return (
    <Dialog labelledBy="dlg-title" describedBy="dlg-body" onCancel={close}>
      <DialogText title={t("share.readyTitle")} body={t("share.readyBody", { name: state.file.name })} />
      <div class="dialog-actions">
        <button type="button" class="btn btn-secondary" onClick={close}>{t("common.cancel")}</button>
        <button
          type="button"
          class="btn btn-primary"
          data-autofocus
          onClick={() => {
            close();
            void shareFile(state.file, state.saveKey, false);
          }}
        >
          <IconShare />
          <span>{t("share.share")}</span>
        </button>
      </div>
    </Dialog>
  );
}

/** The first choice of "Initials on the other pages": "The other page" when there is only one. */
export function initialsAllText(count: number): string {
  return count === 1 ? t("initials.allOne") : t("initials.all", { count });
}

/**
 * "Initials on the other pages" (D9): every other page (the default), or all of them but the last
 * (where the full signature goes), the second only when it is a different, non-empty choice
 * (initialsChoices). Then one batch, one history step.
 */
function InitialsPagesDialog({ state }: { state: Of<"initials-pages"> }) {
  const count = doc.value?.pages.length ?? 0;
  const choices = initialsChoices(state.pageIndex, count);
  const all = choices.all;
  const allButLast = choices.allButLast.length > 0 && choices.allButLast.length !== all.length ? choices.allButLast : null;
  const [choice, setChoice] = useState<"all" | "allButLast">("all");
  const name = useId();
  const pages = choice === "allButLast" && allButLast ? allButLast : all;
  const answer = (picked: number[] | null) => {
    dialog.value = null;
    state.resolve(picked);
  };
  const option = (value: "all" | "allButLast", label: string) => (
    <label class="dl-choice">
      <input
        type="radio"
        class="dl-radio"
        name={name}
        value={value}
        checked={choice === value}
        data-autofocus={choice === value || undefined}
        onChange={() => setChoice(value)}
      />
      <span class="dl-choice-text">
        <span class="dl-choice-title">{label}</span>
      </span>
    </label>
  );
  return (
    <Dialog labelledBy="dlg-title" describedBy="dlg-body" onCancel={() => answer(null)}>
      <form
        class="dialog-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (pages.length) answer(pages);
        }}
      >
        <h2 id="dlg-title" class="dialog-title">{t("initials.title")}</h2>
        <fieldset class="dl-group" aria-labelledby="dlg-title">
          {option("all", initialsAllText(all.length))}
          {allButLast && option("allButLast", t("initials.allButLast", { count: allButLast.length }))}
        </fieldset>
        <p id="dlg-body" class="dl-hint">{t("initials.note")}</p>
        <div class="dialog-actions">
          <button type="button" class="btn btn-secondary" onClick={() => answer(null)}>{t("common.cancel")}</button>
          <button type="submit" class="btn btn-primary" disabled={!pages.length}>{t("initials.apply")}</button>
        </div>
      </form>
    </Dialog>
  );
}

/** The missing-fields question's title, text and "Fill them in", in the singular for one field. */
export function missingFieldsTexts(count: number): { title: string; body: string; fill: string } {
  if (count === 1) return { title: t("form.missingTitleOne"), body: t("form.missingOne"), fill: t("form.missingFillOne") };
  return { title: t("form.missingTitle"), body: t("form.missingMany", { count }), fill: t("form.missingFill") };
}

/**
 * Before a download, once per document (D6): required fields are still empty. "Fill them in"
 * has the focus: it loses nothing; "Download anyway" goes on; Escape answers neither.
 */
function MissingFieldsDialog({ state }: { state: Of<"missing-fields"> }) {
  const answer = (go: "fill" | "download" | null) => {
    dialog.value = null;
    state.resolve(go);
  };
  const texts = missingFieldsTexts(state.count);
  return (
    <Dialog labelledBy="dlg-title" describedBy="dlg-body" onCancel={() => answer(null)}>
      <DialogText title={texts.title} body={texts.body} />
      <div class="dialog-actions">
        <button type="button" class="btn btn-secondary" onClick={() => answer("download")}>
          {t("form.missingDownload")}
        </button>
        <button type="button" class="btn btn-primary" data-autofocus onClick={() => answer("fill")}>
          {texts.fill}
        </button>
      </div>
    </Dialog>
  );
}

// A new dialog object always mounts a fresh component (e.g. "wrong password" after a retry).
const keys = new WeakMap<DialogState, number>();
let nextKey = 1;
function keyOf(d: DialogState) {
  let k = keys.get(d);
  if (!k) keys.set(d, (k = nextKey++));
  return k;
}

export function Dialogs() {
  const d = dialog.value;
  if (!d) return null;
  const key = keyOf(d);
  switch (d.kind) {
    case "confirm": return <ConfirmDialog key={key} state={d} />;
    case "alert": return <AlertDialog key={key} state={d} />;
    case "password": return <PasswordDialog key={key} state={d} />;
    case "share": return <ShareDialog key={key} state={d} />;
    case "download-options": {
      const open = doc.value;
      return open ? <DownloadOptions key={key} doc={open} purpose={d.purpose} /> : null;
    }
    case "pdfa-blocked": return <PdfaBlockedDialog key={key} state={d} />;
    case "pdfa-confirm": return <PdfaConfirmDialog key={key} state={d} />;
    case "signature": return <SignatureDialog key={key} state={d} />;
    case "initials-pages": return <InitialsPagesDialog key={key} state={d} />;
    case "missing-fields": return <MissingFieldsDialog key={key} state={d} />;
    case "install": return <InstallDialog key={key} state={d} />;
    case "insert-from-pdf": return <InsertFromPdfDialog key={key} state={d} />;
    case "move-pages": return <MovePagesDialog key={key} state={d} />;
  }
}
