// Toolbar button: a real <button> with an icon, an accessible name and a tooltip. The visible
// label is shown only when showLabel is set (the caller decides per width, see TopBar); the
// accessible name is always set.
import type { ComponentChildren } from "preact";

export interface ToolButtonProps {
  icon: ComponentChildren;
  label: string;
  /** Tooltip; defaults to the label. */
  tip?: string;
  onClick: () => void;
  disabled?: boolean;
  /** Toggle buttons: current state (aria-pressed). */
  pressed?: boolean;
  /** Show the label next to the icon (wide screens). */
  showLabel?: boolean;
  variant?: "primary" | "secondary" | "accent";
  /** Small dot on the icon (e.g. an update is waiting behind the menu). */
  badge?: boolean;
  class?: string;
  /** Menu button pattern: the popup it opens and whether it is open. */
  haspopup?: "menu";
  expanded?: boolean;
  controls?: string;
}

export function ToolButton(p: ToolButtonProps) {
  const cls = ["btn", "tool", p.variant ? `btn-${p.variant}` : "", p.showLabel ? "has-label" : "", p.class ?? ""]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      type="button"
      class={cls}
      aria-label={p.label}
      title={p.tip ?? p.label}
      aria-pressed={p.pressed}
      aria-haspopup={p.haspopup}
      aria-expanded={p.expanded}
      aria-controls={p.controls}
      disabled={p.disabled}
      onClick={p.onClick}
    >
      {p.icon}
      {p.showLabel && <span class="btn-label" aria-hidden="true">{p.label}</span>}
      {p.badge && <span class="badge" aria-hidden="true" />}
    </button>
  );
}
