// A small drop-down menu (the "More" button on phones): menu button pattern with arrow-key
// navigation, Escape to close (focus back on the button) and click-outside to close.
import type { ComponentChildren } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import { ToolButton } from "./Button";

export interface MenuItem {
  key: string;
  label: string;
  icon?: ComponentChildren;
  onSelect: () => void;
  disabled?: boolean;
  /** Language of the label when it differs from the UI (the language switch). */
  lang?: string;
  /** Extra text at the end of the row (e.g. the zoom value). */
  detail?: string;
}

export function MenuButton(props: { label: string; icon: ComponentChildren; items: MenuItem[]; badge?: boolean }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();

  const items = () => [...(menu.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not([disabled])") ?? [])];
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) wrap.current?.querySelector<HTMLButtonElement>(".menu-trigger")?.focus();
  };

  useEffect(() => {
    if (!open) return;
    items()[0]?.focus();
    const onPointerDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  const onKeyDown = (e: KeyboardEvent) => {
    const list = items();
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    let next = -1;
    if (e.key === "ArrowDown") next = (i + 1) % list.length;
    else if (e.key === "ArrowUp") next = (i - 1 + list.length) % list.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = list.length - 1;
    else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    } else if (e.key === "Tab") {
      close(false);
      return;
    }
    if (next >= 0 && list.length) {
      e.preventDefault();
      list[next].focus();
    }
  };

  return (
    <div class="menu-wrap" ref={wrap}>
      <ToolButton
        class="menu-trigger"
        icon={props.icon}
        label={props.label}
        badge={props.badge}
        haspopup="menu"
        expanded={open}
        controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
      />
      {open && (
        <div class="menu" role="menu" id={id} aria-label={props.label} ref={menu} onKeyDown={onKeyDown}>
          {props.items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              class="menu-item"
              tabIndex={-1}
              disabled={item.disabled}
              lang={item.lang}
              onClick={() => {
                close(true);
                item.onSelect();
              }}
            >
              {item.icon}
              <span class="menu-label">{item.label}</span>
              {item.detail && <span class="menu-detail">{item.detail}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
