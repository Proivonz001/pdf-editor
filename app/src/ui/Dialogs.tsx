// The dialogs the app can show (one at a time, from the `dialog` signal): confirm, alert,
// password for protected PDFs, and "ready to share" when the share sheet needs another tap.
import { useState } from "preact/hooks";
import { t } from "../i18n";
import { dialog, showDialog, type DialogState } from "../state";
import { openFile, shareFile } from "./actions";
import { Dialog } from "./Dialog";
import { IconShare } from "./icons";

type Of<K extends DialogState["kind"]> = Extract<DialogState, { kind: K }>;

const close = () => showDialog(null);

function ConfirmDialog({ state }: { state: Of<"confirm"> }) {
  const answer = (ok: boolean) => {
    dialog.value = null;
    state.resolve(ok);
  };
  return (
    <Dialog labelledBy="dlg-title" describedBy="dlg-body" onCancel={() => answer(false)}>
      <h2 id="dlg-title" class="dialog-title">{state.title}</h2>
      <p id="dlg-body" class="dialog-body">{state.body}</p>
      <div class="dialog-actions">
        <button type="button" class="btn" data-autofocus onClick={() => answer(false)}>{t("common.cancel")}</button>
        <button type="button" class="btn btn-danger" onClick={() => answer(true)}>{state.confirmLabel}</button>
      </div>
    </Dialog>
  );
}

function AlertDialog({ state }: { state: Of<"alert"> }) {
  return (
    <Dialog labelledBy="dlg-title" describedBy="dlg-body" onCancel={close}>
      <h2 id="dlg-title" class="dialog-title">{state.title}</h2>
      <p id="dlg-body" class="dialog-body">{state.body}</p>
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
      <form onSubmit={submit} noValidate>
        <h2 id="dlg-title" class="dialog-title">{t("password.title")}</h2>
        <p id="dlg-body" class="dialog-body">{t("password.body", { name: state.file.name })}</p>
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
        <div class="dialog-actions">
          <button type="button" class="btn" onClick={close}>{t("common.cancel")}</button>
          <button type="submit" class="btn btn-primary" disabled={!password}>{t("password.open")}</button>
        </div>
      </form>
    </Dialog>
  );
}

function ShareDialog({ state }: { state: Of<"share"> }) {
  return (
    <Dialog labelledBy="dlg-title" describedBy="dlg-body" onCancel={close}>
      <h2 id="dlg-title" class="dialog-title">{t("share.readyTitle")}</h2>
      <p id="dlg-body" class="dialog-body">{t("share.readyBody", { name: state.file.name })}</p>
      <div class="dialog-actions">
        <button type="button" class="btn" onClick={close}>{t("common.cancel")}</button>
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
  }
}
