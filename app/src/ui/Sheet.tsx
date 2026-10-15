// Bottom sheet (phones) on the native <dialog>, a modal like ui/Dialog.tsx with the same mechanics
// (ui/modal.ts): the rest of the page is inert, focus moves inside on open (the `initialFocus`
// element, else [data-autofocus], else the first focusable one), Tab stays inside, and focus goes
// back to where it was once it closes. Styled by styles/phone.css (.sheet).
//
// Escape, the close button, a tap on the backdrop and dragging the handle or the header down
// all close it: it slides down first (at once with reduced motion), then calls `onClose`, and
// the parent unmounts it. A sheet the parent unmounts directly (e.g. a thumbnail was picked)
// goes at once. The browser closing it by itself (the Android back gesture) calls `onClose` too.
import type { ComponentChildren } from "preact";
import { useId, useRef, useState } from "preact/hooks";
import { t } from "../i18n";
import { IconClose } from "./icons";
import { prefersReducedMotion } from "./media";
import { trapTab, useModal } from "./modal";

/** The slide-down lasts 150 ms (phone.css); unmount just after its last frame. */
const EXIT_MS = 170;
/** Dragged down further than this (px), releasing closes the sheet; a quick flick closes sooner. */
const DRAG_CLOSE = 96;

export interface SheetProps {
  title: string;
  /** Close it: the parent must unmount the sheet. */
  onClose(): void;
  children: ComponentChildren;
  class?: string;
  /** Short muted text after the title (e.g. the page count). */
  detail?: string;
  /** Selector of the element to focus on open, tried before the defaults. */
  initialFocus?: string;
}

interface Drag {
  pointer: number;
  y: number;
  time: number;
  dy: number;
}

export function Sheet(p: SheetProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const grip = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [leaving, setLeaving] = useState(false);
  const onClose = useRef(p.onClose);
  onClose.current = p.onClose;
  const exitTimer = useRef<number>();
  const downOnBackdrop = useRef(false);
  const drag = useRef<Drag | null>(null);

  /** Unmounted: our own close() follows, and its "close" event is not a request. */
  const unmounted = useModal(ref, {
    initialFocus: p.initialFocus,
    onUnmount: () => window.clearTimeout(exitTimer.current), // unmounted mid-slide: drop its timer
  });

  const requestClose = () => {
    if (unmounted.current || exitTimer.current !== undefined) return;
    if (prefersReducedMotion.peek()) {
      onClose.current();
      return;
    }
    setLeaving(true);
    exitTimer.current = window.setTimeout(() => {
      if (!unmounted.current) onClose.current();
    }, EXIT_MS);
  };

  // Clicks on ::backdrop reach the <dialog> itself, outside its box. Both ends of the click must
  // be there: a drag that starts in the sheet and ends outside it is not a tap on the backdrop.
  const onBackdrop = (e: MouseEvent) => {
    const el = ref.current;
    if (!el || e.target !== el) return false;
    const r = el.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };

  // Drag to dismiss, from the handle and the header (not their buttons). The content keeps its
  // own scrolling: the thumbnails grid scrolls, it does not pull the sheet.
  const onGripDown = (e: PointerEvent) => {
    if (!e.isPrimary || e.button !== 0 || leaving) return;
    if (e.target instanceof Element && e.target.closest("button, a")) return;
    drag.current = { pointer: e.pointerId, y: e.clientY, time: e.timeStamp, dy: 0 };
    grip.current?.setPointerCapture(e.pointerId);
    ref.current!.style.transition = "none";
  };
  const onGripMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointer) return;
    d.dy = Math.max(0, e.clientY - d.y);
    ref.current!.style.transform = d.dy ? `translateY(${d.dy}px)` : "";
  };
  const onGripEnd = (e: PointerEvent) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointer) return;
    drag.current = null;
    const el = ref.current!;
    el.style.transition = "";
    const flick = d.dy > 24 && d.dy / Math.max(1, e.timeStamp - d.time) > 0.5;
    if (e.type === "pointerup" && (d.dy > DRAG_CLOSE || flick)) requestClose(); // slides on from there
    else el.style.transform = ""; // snaps back (transition in phone.css)
  };

  const cls = ["sheet", p.class, leaving && "is-leaving"].filter(Boolean).join(" ");

  return (
    <dialog
      ref={ref}
      class={cls}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onKeyDown={(e) => trapTab(e, ref.current)}
      onCancel={(e) => {
        e.preventDefault(); // slide down first; the parent unmounts it
        requestClose();
      }}
      onClose={() => {
        if (!unmounted.current) onClose.current();
      }}
      onPointerDown={(e) => {
        downOnBackdrop.current = onBackdrop(e);
      }}
      onClick={(e) => {
        if (downOnBackdrop.current && onBackdrop(e)) requestClose();
        downOnBackdrop.current = false;
      }}
    >
      <div class="sheet-panel">
        <div
          ref={grip}
          class="sheet-grip"
          onPointerDown={onGripDown}
          onPointerMove={onGripMove}
          onPointerUp={onGripEnd}
          onPointerCancel={onGripEnd}
        >
          <span class="sheet-handle" aria-hidden="true" />
          {/* A div, not <header>: outside sectioning content that would be a banner landmark. */}
          <div class="sheet-header">
            <div class="sheet-heading">
              <h2 id={titleId} class="sheet-title">{p.title}</h2>
              {p.detail && <span class="sheet-detail">{p.detail}</span>}
            </div>
            <button
              type="button"
              class="btn tool sheet-close"
              aria-label={t("common.close")}
              title={t("common.close")}
              onClick={requestClose}
            >
              <IconClose />
            </button>
          </div>
        </div>
        <div class="sheet-content">{p.children}</div>
      </div>
    </dialog>
  );
}
