// Modal dialog on the native <dialog> element (showModal makes the rest of the page inert),
// with role="dialog" aria-modal, focus moved inside on open, Tab kept inside, Escape = cancel,
// and focus given back to where it was on close.
import type { ComponentChildren } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), a[href], select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface DialogProps {
  labelledBy: string;
  describedBy?: string;
  /** Escape, or the browser closing the dialog on its own. */
  onCancel: () => void;
  children: ComponentChildren;
}

export function Dialog({ labelledBy, describedBy, onCancel, children }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const closing = useRef(false);
  const cancel = useRef(onCancel);
  cancel.current = onCancel;

  useLayoutEffect(() => {
    const el = ref.current!;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    try {
      el.showModal();
    } catch {
      el.setAttribute("open", "");
    }
    const first = el.querySelector<HTMLElement>("[data-autofocus]") ?? el.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    return () => {
      closing.current = true; // our own close(): its "close" event is not a cancel
      if (el.open) el.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const items = [...(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <dialog
      ref={ref}
      class="dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      onKeyDown={onKeyDown}
      onCancel={(e) => {
        e.preventDefault(); // the state decides when it closes
        cancel.current();
      }}
      onClose={() => {
        if (!closing.current) cancel.current();
      }}
    >
      {children}
    </dialog>
  );
}
