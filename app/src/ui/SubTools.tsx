// What the bars of Modifica (ui/EditBar.tsx) and Compila e firma (ui/fill/FillBar.tsx) share, so
// the two behave the same:
// - SubTools, a tool's sub-tools as a toolbar: one Tab stop, the arrow keys (Home, End) move
//   between them. The ones that change what a tap on the page does are toggles, the lit one
//   aria-pressed; an action (Aggiungi immagine: the picker) is a plain button. The name is always
//   on the button, so the icons-only bar (when the banner is narrow) keeps it, with the tooltip.
//   In the banner on desktop, or as the phone strip right above the tab bar, which scrolls
//   sideways when the screen is too narrow for them all (ToolStrip).
// - PlaceCentreButton, "Metti al centro": what a tap would write goes in the middle of what
//   shows. An icon alone, quieter than the buttons beside it.
// Styled by styles/shell.css (the banner) and styles/phone.css (the strip).
import type { FunctionComponent } from "preact";
import { useRef, useState } from "preact/hooks";
import { t } from "../i18n";
import { placeAtCentre } from "./actions";
import { IconTarget } from "./icons";
import { isCoarse } from "./media";

/** One sub-tool of a bar. */
export interface SubToolItem {
  id: string;
  Icon: FunctionComponent;
  label: string;
  /** The tooltip. */
  tip: string;
  /** A toggle: whether it is lit (aria-pressed). Left out for an action, which is never lit. */
  pressed?: boolean;
  /** Called from within the click: a picker opens there (iOS opens pickers only then). */
  onChoose: () => void;
}

/** One button of the toolbar: its icon, its name (always on the button), lit or not. */
export function SubToolButton({ item, tabbable, onFocus }: { item: SubToolItem; tabbable: boolean; onFocus: () => void }) {
  const { Icon, label } = item;
  return (
    <button
      type="button"
      class="btn sub-tool"
      aria-label={label}
      title={item.tip}
      aria-pressed={item.pressed}
      tabIndex={tabbable ? 0 : -1}
      onFocus={onFocus}
      onClick={() => item.onChoose()}
    >
      <Icon />
      <span class="sub-tool-label" aria-hidden="true">{label}</span>
    </button>
  );
}

/** The sub-tools as a toolbar named `label`: in the banner, or in the phone strip (`variant`). */
export function SubTools({ variant, label, items }: { variant: "banner" | "strip"; label: string; items: readonly SubToolItem[] }) {
  const ref = useRef<HTMLDivElement>(null);
  /** The item that holds the Tab stop: the last one focused, else the lit one. */
  const [focused, setFocused] = useState<number | null>(null);
  const lit = items.findIndex((item) => item.pressed);
  const tabStop = focused ?? Math.max(0, lit);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>(".sub-tool") ?? [])];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0 || !buttons.length) return;
    let next = -1;
    if (e.key === "ArrowRight") next = (i + 1) % buttons.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + buttons.length) % buttons.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = buttons.length - 1;
    if (next < 0) return;
    e.preventDefault();
    buttons[next].focus();
    buttons[next].scrollIntoView?.({ block: "nearest", inline: "nearest" }); // the phone strip scrolls
  };

  return (
    <div ref={ref} class={`sub-tools is-${variant}`} role="toolbar" aria-label={label} onKeyDown={onKeyDown}>
      {items.map((item, i) => (
        <SubToolButton key={item.id} item={item} tabbable={i === tabStop} onFocus={() => setFocused(i)} />
      ))}
    </div>
  );
}

/** Phones: the sub-tools in a strip right above the tab bar (Viewer decides when it shows). */
export function ToolStrip({ label, items }: { label: string; items: readonly SubToolItem[] }) {
  return (
    <div class="tool-strip">
      <SubTools variant="strip" label={label} items={items} />
    </div>
  );
}

/**
 * "Put it in the middle" (placeAtCentre: what a tap would place goes in the middle of what shows
 * of the current page, is said and takes the focus): the path for the keyboard, screen readers
 * and switch access, on phones too, where a tap on the page cannot be aimed. In Compila e firma
 * for every sub-tool and for the signature waiting to be placed; in Modifica with Aggiungi testo.
 * The icon alone, named by aria-label, with its tooltip. `onClick` replaces placeAtCentre (Bianchetto
 * and Oscura place their default box).
 */
export function PlaceCentreButton({ onClick = () => void placeAtCentre() }: { onClick?: () => void } = {}) {
  return (
    <button
      type="button"
      class="btn tool-banner-centre"
      aria-label={t("fill.placeCenter")}
      title={t(isCoarse.value ? "fill.placeCenterTipTouch" : "fill.placeCenterTip")}
      onClick={onClick}
    >
      <IconTarget />
    </button>
  );
}
