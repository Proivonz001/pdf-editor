// Modal dialog on the native <dialog> element, with role="dialog" aria-modal. The modal mechanics
// shared with the phone sheets come from ui/modal.ts: showModal() makes the rest of the page
// inert, focus moves inside on open ([data-autofocus] first), Tab stays inside, and focus goes
// back to where it was on close. Escape = cancel. Styled by styles/overlays.css (.dialog); its
// content lays itself out with .dialog-text, .field-group and .dialog-actions.
import type { ComponentChildren } from "preact";
import { useRef } from "preact/hooks";
import { trapTab, useModal } from "./modal";

export interface DialogProps {
  labelledBy: string;
  describedBy?: string;
  /** Escape, or the browser closing the dialog on its own. */
  onCancel: () => void;
  children: ComponentChildren;
}

export function Dialog({ labelledBy, describedBy, onCancel, children }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const closing = useModal(ref);
  const cancel = useRef(onCancel);
  cancel.current = onCancel;

  return (
    <dialog
      ref={ref}
      class="dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      onKeyDown={(e) => trapTab(e, ref.current)}
      onCancel={(e) => {
        e.preventDefault(); // the state decides when it closes
        cancel.current();
      }}
      onClose={() => {
        if (!closing.current) cancel.current(); // our own close() on unmount is not a cancel
      }}
    >
      {children}
    </dialog>
  );
}
