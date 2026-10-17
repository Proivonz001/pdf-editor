// Toasts in live regions: info and warnings are announced politely, errors assertively.
// The regions are always in the page (even when empty), so screen readers pick up what is
// added to them. Dark in both themes, with a coloured bar for the kind (styles/overlays.css);
// they sit above the page indicator on desktop and above the tab bar on phones. A toast may
// carry one button after its text (Toast.action: the first download's "Install the app"), a real
// button in the Tab order (under the text on narrow screens); pressing it dismisses the toast
// first, then runs the action. A toast's time stops while it holds the focus or the pointer
// (holdToast), so it is not taken away while its button is being reached or its text read; and
// when a toast goes with the focus inside (its time, ✕, its button), the document gets the
// focus, not <body>.
import { t } from "../i18n";
import { dismissToast, holdToast, toasts, type Toast } from "../state";
import { pageFocusTarget } from "./actions";
import { rescueFocus } from "./focus";
import { IconClose } from "./icons";

/** Each shown toast's ref (toastRef). */
const refs = new Map<number, (el: HTMLElement | null) => void>();

/**
 * The ref of toast `id`: the same function for as long as it is shown (a new one at every render
 * would be called with null each time). Preact calls it with null as the toast goes, while it is
 * still in the page: if the focus was inside, the document gets it (rescueFocus acts only once
 * the focus has fallen to <body>; a dialog the toast's button opened keeps it).
 */
function toastRef(id: number) {
  let ref = refs.get(id);
  if (ref) return ref;
  let box: HTMLElement | null = null;
  ref = (el) => {
    if (el) {
      box = el;
      return;
    }
    refs.delete(id);
    if (box?.contains(document.activeElement)) rescueFocus(pageFocusTarget);
    box = null;
  };
  refs.set(id, ref);
  return ref;
}

/** One toast: its text, its action's button when it has one, and the close button (exported for the tests). */
export function ToastItem({ toast }: { toast: Toast }) {
  const action = toast.action;
  return (
    <div
      ref={toastRef(toast.id)}
      class={`toast toast-${toast.kind}${action ? " has-action" : ""}`}
      onFocusIn={() => holdToast(toast.id, "focus", true)}
      onFocusOut={(e) => {
        // From one of its buttons to the other: still inside.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) holdToast(toast.id, "focus", false);
      }}
      onPointerEnter={() => holdToast(toast.id, "pointer", true)}
      onPointerLeave={() => holdToast(toast.id, "pointer", false)}
    >
      <p class="toast-text">{toast.text}</p>
      {action && (
        <button
          type="button"
          class="btn toast-action"
          onClick={() => {
            dismissToast(toast.id);
            action.run();
          }}
        >
          {action.label}
        </button>
      )}
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
