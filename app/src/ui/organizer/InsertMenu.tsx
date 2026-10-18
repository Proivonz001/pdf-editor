// The menu of a "+" in the thumbnails (viewer/Thumbnails.tsx): what to add at that place between
// pages: a blank page, pages from another PDF (the system picker opens at once, within the tap),
// a photo or a scan (the scan flow). The menu button pattern of ui/Menu.tsx (arrow keys, Home and
// End, Escape back to its "+", Tab and a click outside close it), but anchored to a "+" that may
// sit anywhere in a narrow panel or a phone sheet: it is placed in the window (position: fixed)
// next to its "+", within the screen, below it or else above it. Styled as the app's menus
// (styles/overlays.css: .menu, .menu-item) plus styles/organizer.css (.org-menu).
import type { JSX } from "preact";
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import { insertLabel } from "./model";
import { insertItems, type InsertItem } from "./commands";
import { IconOpen, IconPageBlank, IconPageScan } from "../icons";

/** Room kept between the menu and the edges of the window (px). */
const MARGIN = 8;

const ICONS: Record<InsertItem["key"], () => JSX.Element> = {
  blank: IconPageBlank,
  pdf: IconOpen,
  scan: IconPageScan,
};

export function InsertMenu({ gap, anchor, onClose }: {
  /** The place the pages go (0 … pageCount), as it is now: its items add pages there. */
  gap: number;
  /** The "+" that opened it: the menu sits next to it, and the focus goes back to it. */
  anchor: HTMLElement;
  /** Close it; `refocus`: give the focus back to the "+". */
  onClose: (refocus: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const items = insertItems(gap);

  const buttons = () => [...(ref.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? [])];

  // Placed next to its "+" (below and left-aligned, else above; within the window), and again
  // when its place moved (a page operation landed while it was open: its "+" moved with its page).
  useLayoutEffect(() => {
    const menu = ref.current!;
    const a = anchor.getBoundingClientRect();
    const m = menu.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    let left = a.left;
    if (left + m.width > vw - MARGIN) left = a.right - m.width;
    left = Math.max(MARGIN, Math.min(left, vw - m.width - MARGIN));
    let top = a.bottom + 4;
    if (top + m.height > vh - MARGIN) top = a.top - m.height - 4;
    top = Math.max(MARGIN, Math.min(top, vh - m.height - MARGIN));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.visibility = "";
  }, [gap]);

  // Once open, the focus on its first item.
  useLayoutEffect(() => {
    buttons()[0]?.focus();
  }, []);

  // A press outside closes it (the focus goes wherever that press puts it).
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!ref.current?.contains(target) && !anchor.contains(target)) close.current(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    const list = buttons();
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    let next = -1;
    if (e.key === "ArrowDown") next = (i + 1) % list.length;
    else if (e.key === "ArrowUp") next = (i - 1 + list.length) % list.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = list.length - 1;
    else if (e.key === "Escape") {
      e.preventDefault(); // (in the phone sheet: the sheet stays open)
      e.stopPropagation();
      close.current(true);
      return;
    } else if (e.key === "Tab") {
      close.current(false);
      return;
    }
    if (next >= 0 && list.length) {
      e.preventDefault();
      list[next].focus();
    }
  };

  return (
    <div
      ref={ref}
      class="menu org-menu"
      role="menu"
      aria-label={insertLabel(gap)}
      style={{ visibility: "hidden" }}
      onKeyDown={onKeyDown}
    >
      {items.map((item) => {
        const Icon = ICONS[item.key];
        return (
          <button
            key={item.key}
            type="button"
            role="menuitem"
            class="menu-item"
            tabIndex={-1}
            onClick={() => {
              close.current(true); // a dialog or the scan flow that opens gives the focus back to the "+"
              item.run(anchor);
            }}
          >
            <Icon />
            <span class="menu-label">{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}
