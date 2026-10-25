// A small drop-down menu (the "More" button of the desktop top bar, Cerca's options): menu button
// pattern with arrow-key navigation (Home/End too; ArrowDown/ArrowUp on the button open it),
// Escape to close (focus back on the button), Tab and click-outside to close. Rows are actions,
// or check boxes (menuitemcheckbox) that leave the menu open as they are ticked. A row that cannot
// act now but should say why (`reason`) stays reachable: aria-disabled, its name the label alone,
// the reason as its description and tooltip, and in a toast when it is chosen (as the organizer's
// buttons do). It opens under
// its button, aligned to the button's right edge (styles/overlays.css).
import { Fragment, type ComponentChildren } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import { showToast } from "../state";
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
  /** Draw a thin line above this item, to set it apart (e.g. Close document). */
  divider?: boolean;
  /** A check box, ticked or not: choosing it leaves the menu open. Left out for an action. */
  checked?: boolean;
  /** Why it does nothing now: the row stays reachable (aria-disabled), says it, and choosing it shows it in a toast. */
  reason?: string;
}

export function MenuButton(props: { label: string; icon: ComponentChildren; items: MenuItem[]; badge?: boolean }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  /** Opened with ArrowUp on the button: start from the last item. */
  const fromEnd = useRef(false);
  const id = useId();

  const items = () => [...(menu.current?.querySelectorAll<HTMLButtonElement>("[role^=menuitem]:not([disabled])") ?? [])];
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) wrap.current?.querySelector<HTMLButtonElement>(".menu-trigger")?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const list = items();
    (fromEnd.current ? list[list.length - 1] : list[0])?.focus();
    fromEnd.current = false;
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

  // On the closed button, ArrowDown / ArrowUp open the menu (on its first / last item).
  const onTriggerKeyDown = (e: KeyboardEvent) => {
    if (open || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
    if (!(e.target instanceof Element) || !e.target.closest(".menu-trigger")) return;
    e.preventDefault();
    fromEnd.current = e.key === "ArrowUp";
    setOpen(true);
  };

  return (
    <div class="menu-wrap" ref={wrap} onKeyDown={onTriggerKeyDown}>
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
            <Fragment key={item.key}>
              {item.divider && <div class="menu-divider" role="separator" />}
              <button
                type="button"
                role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
                aria-checked={item.checked}
                class="menu-item"
                tabIndex={-1}
                disabled={item.disabled}
                aria-disabled={item.reason ? "true" : undefined}
                aria-label={item.reason ? item.label : undefined}
                aria-describedby={item.reason ? `${id}-${item.key}-why` : undefined}
                title={item.reason}
                lang={item.lang}
                onClick={() => {
                  if (item.checked === undefined) close(true);
                  if (item.reason) showToast("info", item.reason);
                  else item.onSelect();
                }}
              >
                {item.icon}
                <span class="menu-label">{item.label}</span>
                {item.detail && <span class="menu-detail">{item.detail}</span>}
                {item.reason && <span id={`${id}-${item.key}-why`} class="sr-only">{item.reason}</span>}
              </button>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
