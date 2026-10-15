// Toasts in live regions: info and warnings are announced politely, errors assertively.
// The regions are always in the page (even when empty), so screen readers pick up what is
// added to them. Dark in both themes, with a coloured bar for the kind (styles/overlays.css);
// they sit above the page indicator on desktop and above the tab bar on phones.
import { t } from "../i18n";
import { dismissToast, toasts, type Toast } from "../state";
import { IconClose } from "./icons";

function ToastItem({ toast }: { toast: Toast }) {
  return (
    <div class={`toast toast-${toast.kind}`}>
      <p class="toast-text">{toast.text}</p>
      <button type="button" class="btn tool toast-close" aria-label={t("common.close")} title={t("common.close")}
        onClick={() => dismissToast(toast.id)}>
        <IconClose />
      </button>
    </div>
  );
}

export function Toasts() {
  const list = toasts.value;
  return (
    <div class="toast-stack">
      <div role="status" aria-live="polite" class="toast-region">
        {list.filter((x) => x.kind !== "error").map((x) => <ToastItem key={x.id} toast={x} />)}
      </div>
      <div role="alert" aria-live="assertive" class="toast-region">
        {list.filter((x) => x.kind === "error").map((x) => <ToastItem key={x.id} toast={x} />)}
      </div>
    </div>
  );
}
