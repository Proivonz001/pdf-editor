// Keeping the keyboard focus in the document when the control that had it goes away: Done in the
// edit banner, Edit text in the details panel, Close document, a layout switch at 640 px. Without
// this the focus falls to <body>: screen readers lose their place, and Tab starts over.

/**
 * After a change that may remove the focused element: on the next frame (the new DOM is in place
 * by then), if the focus fell to <body>, give it to `target()`. Whatever else took the focus in
 * the meantime keeps it.
 */
export function rescueFocus(target: () => HTMLElement | null | undefined) {
  requestAnimationFrame(() => {
    const now = document.activeElement;
    if (now && now !== document.body) return;
    target()?.focus({ preventScroll: true });
  });
}

/** The document's scroll area: where the focus goes when a viewer control disappears. */
export const viewerScroller = () => document.querySelector<HTMLElement>(".viewer .scroller");
