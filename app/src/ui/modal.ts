// What the app's modals on the native <dialog> share (ui/Dialog.tsx, ui/Sheet.tsx): showModal()
// on mount, which makes the rest of the page inert; the focus moved inside; Tab kept inside; and,
// on unmount, the dialog closed and the focus given back to where it was.
import type { RefObject } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";

/**
 * What Tab can reach inside a modal. Items with tabindex="-1" are left out: they are reached
 * with the arrow keys instead (the thumbnails grid keeps only one of them in the Tab order).
 */
export const FOCUSABLE = [
  "button:not([disabled])",
  "input:not([disabled])",
  "a[href]",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]",
].map((s) => `${s}:not([tabindex="-1"])`).join(", ");

/** Keep Tab inside `root`: from the last item back to the first, and the other way round. */
export function trapTab(e: KeyboardEvent, root: HTMLElement | null) {
  if (e.key !== "Tab" || !root) return;
  const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

export interface ModalOptions {
  /** Selector of the element to focus on open, tried before [data-autofocus]. */
  initialFocus?: string;
  /** Runs on unmount, before the dialog is closed. */
  onUnmount?: () => void;
}

/**
 * Show `ref`'s <dialog> as a modal while the component is mounted. On open the focus goes to the
 * first of `initialFocus`, [data-autofocus] and the first focusable element that takes it; on
 * unmount it goes back to the element that had it, if that is still in the page. Returns a ref
 * that is true once our own close() runs, so that its "close" event is not taken for the user's.
 */
export function useModal(ref: RefObject<HTMLDialogElement>, opts: ModalOptions = {}) {
  const closing = useRef(false);
  useLayoutEffect(() => {
    const el = ref.current!;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    try {
      el.showModal();
    } catch {
      el.setAttribute("open", "");
    }
    const candidates = [
      opts.initialFocus ? el.querySelector<HTMLElement>(opts.initialFocus) : null,
      el.querySelector<HTMLElement>("[data-autofocus]"),
      el.querySelector<HTMLElement>(FOCUSABLE),
    ];
    for (const c of candidates) {
      c?.focus();
      if (c && document.activeElement === c) break; // e.g. the selector matched something unfocusable
    }
    return () => {
      closing.current = true;
      opts.onUnmount?.();
      if (el.open) el.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return closing;
}
