// Move and resize buttons (release 6, WCAG 2.5.7: a way that needs no dragging), shared by the
// image and shape context bars. In the bar it is one toggle, "Move and resize" (four arrows);
// pressed, it shows a row of its own: four arrows that move by 2 pt (Shift+click 10 pt) and, with
// onScale, "−" and "+" (× 0.9 and ÷ 0.9 about the centre). With onStretch (the shapes) the row
// starts with a second toggle, "Stretch" ("Move the end" for a line): pressed, the arrows change
// the width and height instead (the right and bottom edges move), or move a line's end, so that its
// direction and length change; they are named for what they do then ("Wider", "Move the end left").
// A toggle rather than six more buttons always in the bar: on a 320 px phone the image bar has
// room for its own icons and little more. The row takes a line of the bar of its own on the side
// away from the selection (nudge.css), so once the host places the bar again for its new height,
// the bar's own buttons (the toggle too) stay where they were under the pointer. The bar's buttons
// that follow the toggle are given as children and come before the row in the DOM: Tab reaches the
// row last, as it is drawn below the selection.
//
// An arrow held down repeats after a short delay, like a key, until the pointer lifts or is
// cancelled (also where the arrow does not hear it: the window does, and a blur stops it too), or
// the row closes; the click that ends a hold that repeated adds no step of its own. The arrow keeps
// the pointer meanwhile (as a finger is kept anyway): the bar follows the picture, so the button
// moves away from under a mouse that stays still, and that must not end the hold. They are real
// buttons, so Enter and Space work too. While `disabled` (an edit being written) they stay in the
// bar with the focus they have (aria-disabled), do nothing, and a hold stops. Whether the row is
// shown is kept for the session, in every bar: whoever needs the buttons finds them on the next
// selection too (Stretch is off again on each selection).
import { signal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../i18n";
import { IconArrowDown, IconArrowLeft, IconArrowRight, IconArrowUp, IconMinus, IconMove, IconPlus, IconStretch } from "./icons";

export interface NudgeControlsProps {
  /** Move by (dx, dy) in page points, as seen (positive: right, down). */
  onMove(dx: number, dy: number): void;
  /** Make it bigger (factor > 1) or smaller about its centre; absent: no size buttons. */
  onScale?(factor: number): void;
  /**
   * Stretch by (dx, dy) in page points, as seen: the right edge `dx` and the bottom edge `dy`
   * further, or (stretchEnd) a line's end moved by them; absent: no Stretch toggle.
   */
  onStretch?(dx: number, dy: number): void;
  /** onStretch moves a line's end: the toggle and the arrows are named so. */
  stretchEnd?: boolean;
  /** Nothing can be done now (an edit is being written). */
  disabled?: boolean;
  /** The bar's buttons after the toggle (before the row in the DOM). */
  children?: ComponentChildren;
}

/** A press moves by this much (pt), Shift+click by the far step. */
export const NUDGE_STEP = 2;
export const NUDGE_STEP_FAR = 10;
/** "−" scales by this factor, "+" by its inverse. */
export const NUDGE_SCALE = 0.9;
/** A held arrow repeats after this long (ms), then this often. */
export const HOLD_DELAY = 400;
export const HOLD_REPEAT = 80;

/** The row of buttons is shown (for the session, in every bar that has them). */
export const nudgeOpen = signal(false);

/** Each arrow: its name when it moves, when it stretches a box, when it moves a line's end. */
const MOVES = [
  { key: "nudge.left", stretch: "nudge.narrower", end: "nudge.endLeft", dx: -1, dy: 0, Icon: IconArrowLeft },
  { key: "nudge.up", stretch: "nudge.shorter", end: "nudge.endUp", dx: 0, dy: -1, Icon: IconArrowUp },
  { key: "nudge.down", stretch: "nudge.taller", end: "nudge.endDown", dx: 0, dy: 1, Icon: IconArrowDown },
  { key: "nudge.right", stretch: "nudge.wider", end: "nudge.endRight", dx: 1, dy: 0, Icon: IconArrowRight },
] as const;

const SCALES = [
  { key: "nudge.smaller", factor: NUDGE_SCALE, Icon: IconMinus },
  { key: "nudge.bigger", factor: 1 / NUDGE_SCALE, Icon: IconPlus },
] as const;

/** The "Move and resize" toggle and, when it is on, its row of buttons: for a context bar. */
export function NudgeControls({ onMove, onScale, onStretch, stretchEnd = false, disabled = false, children }: NudgeControlsProps) {
  const open = nudgeOpen.value;
  const [stretchOn, setStretchOn] = useState(false);
  const stretching = stretchOn && !!onStretch;
  // The latest props, for a hold's timer (it outlives the render that started it).
  const latest = useRef({ onMove, onScale, onStretch, stretching, disabled });
  latest.current = { onMove, onScale, onStretch, stretching, disabled };
  /** The hold's timer, the button whose hold has moved (the click that ends it then does not), its window listeners' removal. */
  const hold = useRef({ timer: 0, moved: "", off: (): void => undefined });

  const stop = () => {
    clearTimeout(hold.current.timer);
    hold.current.timer = 0;
    hold.current.off();
  };
  useEffect(() => stop, []); // gone during a hold: no step after

  const move = (dx: number, dy: number, far: boolean) => {
    const step = far ? NUDGE_STEP_FAR : NUDGE_STEP;
    const { onMove: moveBy, onStretch: stretchBy, stretching: stretch } = latest.current;
    (stretch && stretchBy ? stretchBy : moveBy)(dx * step, dy * step);
  };

  const press = (e: PointerEvent, key: string, dx: number, dy: number) => {
    stop();
    hold.current.moved = "";
    if (!e.isPrimary || e.button !== 0 || latest.current.disabled) return;
    try {
      (e.currentTarget as Element | null)?.setPointerCapture(e.pointerId);
    } catch {
      return; // the pointer is gone already (nothing would stop the repeat): its click, if any, is the one step
    }
    // The arrow may not hear its pointer lift (the row closed under it, a release in another window):
    // the window does; a blur ends the hold too.
    const end = (ev: Event) => {
      const id = (ev as PointerEvent).pointerId;
      if (id === undefined || id === e.pointerId) stop();
    };
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", end, true);
    window.addEventListener("blur", end);
    hold.current.off = () => {
      window.removeEventListener("pointerup", end, true);
      window.removeEventListener("pointercancel", end, true);
      window.removeEventListener("blur", end);
      hold.current.off = () => undefined;
    };
    const far = e.shiftKey;
    const after = (delay: number) => {
      hold.current.timer = window.setTimeout(() => {
        if (latest.current.disabled || !nudgeOpen.peek()) return stop();
        hold.current.moved = key;
        move(dx, dy, far);
        after(HOLD_REPEAT);
      }, delay);
    };
    after(HOLD_DELAY);
  };

  const click = (e: MouseEvent, key: string, step: (far: boolean) => void) => {
    stop();
    // A keyboard's click has no detail: a hold that a pointer left unfinished never eats it.
    const held = hold.current.moved === key && e.detail > 0;
    hold.current.moved = "";
    if (!held && !latest.current.disabled) step(e.shiftKey);
  };

  const label = t(onScale ? "nudge.toggle" : "nudge.toggleMove");
  const stretchLabel = t(stretchEnd ? "nudge.stretchEnd" : "nudge.stretch");
  const off = disabled || undefined;
  const rowClass = ["nudge-row", !onScale && "is-move-only", onStretch && "has-stretch"].filter(Boolean).join(" ");
  return (
    <>
      <button
        type="button"
        class="btn context-btn is-icon nudge-toggle"
        title={label}
        aria-label={label}
        aria-expanded={open}
        onClick={() => { nudgeOpen.value = !nudgeOpen.peek(); }}
      >
        <IconMove />
      </button>
      {children}
      {open && (
        <div class={rowClass} role="group" aria-label={label}>
          {onStretch && (
            <button
              type="button"
              class="btn context-btn is-icon nudge-stretch"
              title={stretchLabel}
              aria-label={stretchLabel}
              aria-pressed={stretching}
              onClick={() => setStretchOn(!stretchOn)}
            >
              <IconStretch />
            </button>
          )}
          {MOVES.map(({ key, stretch, end, dx, dy, Icon }) => {
            const name = t(stretching ? (stretchEnd ? end : stretch) : key);
            return (
              <button
                type="button"
                key={key}
                class="btn context-btn is-icon"
                title={t("nudge.moveTip", { what: name, step: NUDGE_STEP, far: NUDGE_STEP_FAR })}
                aria-label={name}
                aria-disabled={off}
                onPointerDown={(e) => press(e, key, dx, dy)}
                onPointerUp={stop}
                onPointerLeave={stop}
                onPointerCancel={stop}
                onLostPointerCapture={stop}
                onContextMenu={(e) => e.preventDefault()} // a long press is a hold, not the menu
                onClick={(e) => click(e, key, (far) => move(dx, dy, far))}
              >
                <Icon />
              </button>
            );
          })}
          {onScale && SCALES.map(({ key, factor, Icon }) => (
            <button
              type="button"
              key={key}
              class="btn context-btn is-icon"
              title={t(key)}
              aria-label={t(key)}
              aria-disabled={off}
              onClick={(e) => click(e, key, () => latest.current.onScale?.(factor))}
            >
              <Icon />
            </button>
          ))}
        </div>
      )}
    </>
  );
}
