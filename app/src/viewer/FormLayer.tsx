// Form field overlay of one page (fill and browse modes, never in Modifica): a native control over
// each widget the engine lists, in the page's tab order (FieldWidget.index), so Tab and the
// keyboard's "next" follow the form. The page's canvas draws the fields' own appearances; the
// controls lie over them, see-through, with an ink-blue tint (a required field has a "*" badge),
// until one has the focus: then its text shows on a white box, and it goes see-through again once
// the canvas shows the value written, so nothing flickers.
//
// By type: one-line text (an input: Enter and the keyboard's "next" write it and go to the next
// field, across pages; "done" on the last one), several lines (a textarea: Enter is a new line),
// comb (monospace, one character per cell), check boxes and radio buttons (native; on touch a
// target of up to 44 px, never more than halfway to a neighbouring widget: touchTargets; the
// radios of a field in one radio group), choices (a select, the phone's own picker; an editable
// combo is a text input with its options listed), unsigned signature fields ("Sign here": the
// signature chooser, or the signature waiting to be placed, fitted in the box; gone once a
// picture the user added covers the box). Read-only and otherwise locked fields have no tint and
// a lock, take no focus, and say so when tapped. Push buttons are left out: no script runs here.
// While a field has the focus, a chip above it gives its name, "required" and its length limit
// (also its description for screen readers), and "Today" on date fields (Tab reaches it, after
// the field, and the next Tab goes on to the next field: the field stays the focused one while
// "Today" has the focus, and nothing pulls the focus back into it); with Data on, a tap on a text
// field writes today's date into it. Tab goes on to the next page whose fields take the focus,
// even when it is far away (fields.ts: its layer stays in the page). While a control that brings
// up the keyboard (a text field, one on several lines) has the focus, typingField says so, from
// the control's own focus and blur, so the phone's bars follow the control that really has it.
// Each value written is one edit (setFieldValue); after any history step the values are read
// again (page.fields), and a value the user is not typing over is shown again.
import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { MAX_FIELD_CHARS, type FieldValue, type FieldWidget, type ImageInfo, type Rect } from "../engine/protocol";
import { t } from "../i18n";
import {
  fillMode, fillTool, focusedField, focusRequest, pendingPlacement, registerEditor, showDialog, showToast, typingField,
} from "../state";
import { focusNextField, placeSignature, setFieldValue, todayText } from "../ui/actions";
import { rescueFocus, viewerScroller } from "../ui/focus";
import { datePattern, looksLikeDate } from "../ui/fill/dates";
import { signatureInField } from "../ui/fill/geometry";
import { IconLock, IconSignature } from "../ui/icons";
import { isCoarse } from "../ui/media";
import { honourFocusRequest } from "./added";
import {
  ensureFields, fieldLabel, focusWithinField, isLastField, isTaxCodeField, isUnsignedSignature, nextOnPage, noteFieldFocus,
  touchTargets,
} from "./fields";
import { cssRgb, px, rectBox, zoomForWriting, type Box } from "./FillLayer";
import { ensureImages } from "./images";
import type { PageModel } from "./model";

/** Touch screens: a field's text is never smaller than this (px), so iOS does not zoom the page into it. */
const MIN_TOUCH_FONT = 16;
/** Touch screens: a check box or radio button takes a finger on at least this square (px), centred on it. */
const TOUCH_TARGET = 44;
/** Under this height (px) a chip above the field would leave the page: it goes below. */
const CHIP_ROOM = 30;
/** "Sign here" shows its words only in a box at least this large (px); else its icon alone. */
const SIGN_TEXT_MIN = { width: 64, height: 16 };

// --- Writing values ------------------------------------------------------------------------------

let fieldEdits: Promise<unknown> = Promise.resolve();

/**
 * Field values are written one after the other, each with the page revision as it is when its turn
 * comes: a field is found again by its name, so its value is never stale, while setFieldValue
 * refuses a revision the page has moved past, which the field written just before is about to do
 * (Tab from one field to the next).
 */
function writeField(page: PageModel, field: FieldWidget, value: FieldValue): Promise<void> {
  const run = fieldEdits.then(() => setFieldValue(page.index, field, value, page.rev.peek()));
  fieldEdits = run.catch(() => undefined);
  return run;
}

/** Today's date for a field: in the pattern its format script asks for, else as Data writes it. */
function todayFor(f: FieldWidget): string {
  if (f.format?.kind === "date") return datePattern(new Date(), f.format.pattern) ?? todayText();
  return todayText();
}

/** A field that takes a date: its format script says so, or its label or name does. */
const isDateField = (f: FieldWidget) => f.format?.kind === "date" || looksLikeDate(`${f.label} ${f.name}`);

/**
 * The field the focus is on, for the rest of the app (the details panel, the page indicator), and
 * for Tab across pages (noteFieldFocus).
 */
function markFocused(page: PageModel, f: FieldWidget) {
  const now = focusedField.peek();
  if (now?.pageIndex !== page.index || now.index !== f.index || now.name !== f.name) {
    focusedField.value = { pageIndex: page.index, name: f.name, index: f.index };
  }
  noteFieldFocus(page.index);
}

function markBlurred(page: PageModel, f: FieldWidget) {
  const now = focusedField.peek();
  if (now && now.pageIndex === page.index && now.index === f.index) focusedField.value = null;
}

/** The text control that set typingField last: only its own blur (or its going) sets it back. */
let typist: object | null = null;

/**
 * A control that brings up the keyboard got the focus (`on`), or lost it: typingField follows.
 * `owner` is the control's own token, so that a blur or a removal that comes late (a field that
 * goes after the next one has taken the focus) never clears what the next one set.
 */
function typing(owner: object, on: boolean) {
  if (on) {
    typist = owner;
    if (!typingField.peek()) typingField.value = true;
  } else if (typist === owner) {
    typist = null;
    if (typingField.peek()) typingField.value = false;
  }
}

/** A control that brings up no keyboard got the focus (a check box, a list, "Sign here"). */
function notTyping() {
  typist = null;
  if (typingField.peek()) typingField.value = false;
}

// --- Geometry ------------------------------------------------------------------------------------

/**
 * The widget's box on the page, and the box its text runs in: turned with it when the text runs
 * down or up the page (FieldWidget.rotation), its sides then swapped.
 */
function geometry(page: PageModel, f: FieldWidget, zoom: number) {
  const box = rectBox(page, f.rect, zoom);
  const turned = f.rotation === 90 || f.rotation === 270;
  const width = turned ? box.height : box.width;
  const height = turned ? box.width : box.height;
  const inner: Record<string, string> = {
    left: `${(box.width - width) / 2}px`,
    top: `${(box.height - height) / 2}px`,
    width: `${width}px`,
    height: `${height}px`,
  };
  if (f.rotation) inner.transform = `rotate(${f.rotation}deg)`;
  return { box, width, height, inner };
}

/**
 * Size of the field's text in points: the form's own, or MuPDF's automatic one, roughly: 70 % of
 * a one-line field's height, 12 pt on several lines, a comb's cell at most.
 */
function textSize(f: FieldWidget, widthPt: number, heightPt: number): number {
  if (f.fontSize > 0) return f.fontSize;
  if (f.multiline) return 12;
  const auto = Math.max(4, heightPt * 0.7);
  if (f.comb && f.maxLen > 0) return Math.max(4, Math.min(auto, (widthPt / f.maxLen) / 0.6 * 0.8));
  return auto;
}

const ALIGN = ["left", "center", "right"] as const;

// --- The chip ------------------------------------------------------------------------------------

/** "required", "Up to N characters": the field's description, for the chip and for screen readers. */
function describe(f: FieldWidget): string {
  const parts: string[] = [];
  if (f.required) parts.push(t("form.required"));
  if (f.maxLen > 0 && (f.type === "text" || f.type === "combo")) {
    parts.push(f.maxLen === 1 ? t("form.maxLenOne") : t("form.maxLen", { count: f.maxLen }));
  }
  return parts.join(" · ");
}

/** Pressing the chip's button must leave the focus (and the caret) in the field. */
const keepFocus = (e: Event) => e.preventDefault();

/**
 * The chip of the focused field. Its "Today" button is a stop for Tab right after the field (the
 * chip comes after the control, in the field's box, so the focus on it keeps the chip up); a
 * press with a pointer leaves the focus in the field, and Escape on it goes back to the field
 * (`onBack`), as Escape in the field does not leave the tool either.
 */
function Chip({ f, box, onToday, onBack }: { f: FieldWidget; box: Box; onToday?: () => void; onBack?: () => void }) {
  const description = describe(f);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    onBack?.();
  };
  return (
    <span class={box.top < CHIP_ROOM ? "form-field-chip is-below" : "form-field-chip"} onPointerDown={keepFocus} onMouseDown={keepFocus}>
      <span class="form-field-chip-text" aria-hidden="true">
        <span class="form-field-chip-label">{fieldLabel(f)}</span>
        {description && <span class="form-field-chip-note">{description}</span>}
      </span>
      {onToday && (
        <button type="button" class="btn form-field-today" onClick={onToday} onKeyDown={onKeyDown}>
          {t("form.today")}
        </button>
      )}
    </span>
  );
}

// --- Controls ------------------------------------------------------------------------------------

interface ControlProps {
  page: PageModel;
  zoom: number;
  f: FieldWidget;
  /** The page's widgets, in tab order. */
  fields: readonly FieldWidget[];
  /** The page revision the page's canvas shows. */
  canvasRev: number;
}

/** The label of a choice's export value. */
function choiceLabel(f: FieldWidget, value: string): string {
  return f.options?.find((o) => o.value === value)?.label ?? value;
}

/**
 * Text fields (one line, several lines, comb) and editable combos (text with its choices listed).
 * The control is uncontrolled, as the line editor: what is typed stays in it; it is written on
 * blur, Enter or flushEditor, and a value read again from the engine replaces it unless the user
 * is typing a different one.
 */
function TextControl({ page, zoom, f, fields, canvasRev }: ControlProps) {
  const input = useRef<HTMLInputElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  /** The focus is in the field or its chip. */
  const [within, setWithin] = useState(false);
  /** The page revision whose canvas must show the value written before the field goes see-through. */
  const [hold, setHold] = useState<number | null>(null);
  /** The text being written, or written last (until the engine's value is read again). */
  const sent = useRef<string | null>(null);
  const inflight = useRef<Promise<void>>(Promise.resolve());
  const unregister = useRef<(() => void) | null>(null);
  const latest = useRef(f);
  latest.current = f;
  const coarse = isCoarse.value;
  const combo = f.type === "combo";
  const multiline = f.type === "text" && f.multiline;
  const el = () => (multiline ? area.current : input.current);
  const shownOf = (x: FieldWidget) => (combo ? x.displayValue ?? choiceLabel(x, x.value) : x.value);
  const shown = shownOf(f);

  // The engine's value changed (an undo, another widget of the same field, this one written):
  // shown, unless the user is typing something else in this field.
  const lastShown = useRef(shown);
  useEffect(() => {
    const node = el();
    if (node && (document.activeElement !== node || node.value === lastShown.current)) node.value = shown;
    lastShown.current = shown;
    sent.current = null;
  }, [shown]);

  // See-through again once the canvas shows the value written (or will not: the page is far).
  useEffect(() => {
    if (hold !== null && (canvasRev >= hold || !page.near.peek())) setHold(null);
  }, [hold, canvasRev]);

  const valueOf = (text: string): FieldValue => {
    if (!combo) return { kind: "text", text };
    const option = latest.current.options?.find((o) => o.label === text || o.value === text);
    if (option) return { kind: "choice", values: [option.value] };
    return text === "" ? { kind: "choice", values: [] } : { kind: "text", text };
  };

  /** Write what the field holds, once; resolves when it is in the engine's history (or refused). */
  const commit = (): Promise<void> => {
    const node = el();
    if (!node) return inflight.current;
    const text = node.value;
    if (text === (sent.current ?? shownOf(latest.current))) return inflight.current;
    sent.current = text;
    const before = page.rev.peek();
    const run = writeField(page, latest.current, valueOf(text)).then(() => {
      if (page.rev.peek() !== before) {
        setHold(page.rev.peek());
        return;
      }
      // Refused, or the same value: the field shows what the engine has.
      sent.current = null;
      if (document.activeElement !== node) node.value = shownOf(latest.current);
    });
    inflight.current = run.catch(() => undefined);
    return inflight.current;
  };

  // typingField: this control's own token; set back if it goes while it has the focus.
  const token = useRef({}).current;
  useLayoutEffect(() => () => typing(token, false), []);

  const onFocus = () => {
    markFocused(page, f);
    typing(token, true);
    unregister.current?.();
    unregister.current = registerEditor({
      changed: () => {
        const node = el();
        return !!node && node.value !== (sent.current ?? shownOf(latest.current));
      },
      commit,
    });
    const { width, height } = geometry(page, f, 1);
    zoomForWriting(wrap.current?.closest(".page") ?? null, page, [f.rect[0], (f.rect[1] + f.rect[3]) / 2], textSize(f, width, height));
  };

  // The field is marked left by its box's focusout, not here: on to "Today" in the chip, it is
  // still the field being filled.
  const onBlur = () => {
    typing(token, false);
    const drop = unregister.current;
    unregister.current = null;
    void commit().then(() => drop?.());
  };

  /** Enter, or the keyboard's "next": write it, and go to the next field (the last one: done). */
  const goNext = (node: HTMLElement) => {
    const field = latest.current;
    void commit();
    if (isLastField(page.index, field, fields)) {
      node.blur();
      rescueFocus(viewerScroller);
      return;
    }
    const next = nextOnPage(field, fields);
    const target = next ? node.closest(".form-fields")?.querySelector<HTMLElement>(`[data-field-index="${next.index}"]`) : null;
    if (target) target.focus(); // at once, within the key press: a phone keeps its keyboard up
    else void focusNextField({ pageIndex: page.index, index: field.index, name: field.name });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing || e.keyCode === 229) return; // IME composition in progress
    const node = e.currentTarget as HTMLInputElement | HTMLTextAreaElement;
    if (e.key === "Enter" && !multiline) {
      e.preventDefault();
      goNext(node);
    } else if (e.key === "Escape") {
      // What was typed goes back to the field's value; with nothing typed, the field is left.
      const value = shownOf(latest.current);
      e.preventDefault();
      e.stopPropagation();
      if (node.value !== value) {
        node.value = value;
      } else {
        node.blur();
        rescueFocus(viewerScroller);
      }
    }
  };

  /** Data on: a tap on the field writes today's date into it. */
  const onClick = (e: MouseEvent) => {
    if (!fillMode.peek() || fillTool.peek() !== "date" || pendingPlacement.peek()) return;
    const node = e.currentTarget as HTMLInputElement | HTMLTextAreaElement;
    node.value = todayFor(latest.current);
    void commit();
  };

  const today = () => {
    const node = el();
    if (!node) return;
    node.value = todayFor(latest.current);
    void commit();
  };

  const { box, width, height, inner } = geometry(page, f, zoom);
  const sizePt = textSize(f, width / zoom, height / zoom);
  const fontSize = Math.max(coarse ? MIN_TOUCH_FONT : 4, sizePt * zoom);
  const comb = f.comb && f.maxLen > 0 && !multiline;
  const cell = comb ? width / f.maxLen : 0;
  const spacing = comb ? Math.max(0, cell - 0.6 * fontSize) : 0;
  const style: Record<string, string> = {
    ...inner,
    fontSize: `${fontSize}px`,
    textAlign: comb ? "left" : ALIGN[f.align] ?? "left",
    padding: multiline ? `${2 * zoom}px ${2 * zoom}px` : comb ? `0 0 0 ${spacing / 2}px` : `0 ${2 * zoom}px`,
    "--ink": cssRgb(f.color),
  };
  if (comb) style.letterSpacing = `${spacing}px`;
  const label = fieldLabel(f);
  const descId = `field-desc-${page.index}-${f.index}`;
  const listId = `field-list-${page.index}-${f.index}`;
  const description = describe(f);
  const classes = [
    "form-field", "is-text", comb && "is-comb", f.required && "is-required", within && "is-focused",
    (within || hold !== null) && "is-showing",
  ].filter(Boolean).join(" ");
  const common = {
    class: "form-field-control",
    "data-field-index": f.index,
    defaultValue: shown,
    maxLength: f.maxLen > 0 ? f.maxLen : MAX_FIELD_CHARS,
    style,
    "aria-label": label,
    "aria-required": f.required || undefined,
    "aria-describedby": description ? descId : undefined,
    autocomplete: "off",
    spellcheck: false,
    onFocus,
    onBlur,
    onKeyDown,
    onClick,
  };

  return (
    <div
      ref={wrap}
      class={classes}
      style={px(box)}
      onFocusIn={() => {
        setWithin(true);
        markFocused(page, f); // also on "Today": the field is still the one being filled
      }}
      onFocusOut={(e) => {
        if (wrap.current?.contains(e.relatedTarget as Node | null)) return; // between the field and "Today"
        setWithin(false);
        markBlurred(page, f); // also from "Today": the field is left
      }}
    >
      {multiline
        ? <textarea ref={area} {...common} />
        : (
          <input
            ref={input}
            type="text"
            {...common}
            enterKeyHint={isLastField(page.index, f, fields) ? "done" : "next"}
            autocapitalize={isTaxCodeField(f) ? "characters" : undefined}
            list={combo ? listId : undefined}
          />
        )}
      {combo && (
        <datalist id={listId}>
          {f.options?.map((o) => <option key={o.value} value={o.label} />)}
        </datalist>
      )}
      {description && <span id={descId} hidden>{description}</span>}
      {within && (
        <Chip f={f} box={box} onToday={isDateField(f) ? today : undefined} onBack={() => el()?.focus({ preventScroll: true })} />
      )}
    </div>
  );
}

/** Combo boxes (not editable) and list boxes: a native select, the phone's own picker. */
function ChoiceControl({ page, zoom, f, canvasRev }: ControlProps) {
  const select = useRef<HTMLSelectElement>(null);
  const [within, setWithin] = useState(false);
  const [hold, setHold] = useState<number | null>(null);
  const latest = useRef(f);
  latest.current = f;
  const multi = f.type === "list" && f.multiSelect;
  const chosen = (x: FieldWidget) => (x.values?.length ? x.values : x.value ? [x.value] : []);

  useEffect(() => {
    if (hold !== null && (canvasRev >= hold || !page.near.peek())) setHold(null);
  }, [hold, canvasRev]);

  /** Back to what the engine has (a refused choice). */
  const restore = () => {
    const node = select.current;
    if (!node) return;
    const values = new Set(chosen(latest.current));
    for (const o of node.options) o.selected = values.has(o.value) || (o.value === "" && values.size === 0);
  };

  const onChange = (e: Event) => {
    const node = e.currentTarget as HTMLSelectElement;
    const values = [...node.selectedOptions].map((o) => o.value).filter((v) => v !== "");
    const before = page.rev.peek();
    void writeField(page, latest.current, { kind: "choice", values }).then(() => {
      if (page.rev.peek() !== before) setHold(page.rev.peek());
      else restore();
    });
  };

  const { box, height, inner } = geometry(page, f, zoom);
  const sizePt = f.fontSize > 0 ? f.fontSize : 12;
  const fontSize = Math.max(isCoarse.value ? MIN_TOUCH_FONT : 4, Math.min(sizePt * zoom, height * 0.8));
  const values = new Set(chosen(f));
  const options = f.options ?? [];
  // A value the file holds that is not among the choices still shows.
  const extra = f.type === "combo" && f.value && !options.some((o) => o.value === f.value);
  const rows = Math.max(2, Math.floor(height / (fontSize * 1.25)));
  const description = describe(f);
  const descId = `field-desc-${page.index}-${f.index}`;
  const classes = [
    "form-field", "is-choice", f.required && "is-required", within && "is-focused", (within || hold !== null) && "is-showing",
  ].filter(Boolean).join(" ");

  return (
    <div class={classes} style={px(box)}>
      <select
        ref={select}
        class="form-field-control"
        data-field-index={f.index}
        multiple={multi}
        size={f.type === "list" ? rows : undefined}
        style={{ ...inner, fontSize: `${fontSize}px`, "--ink": cssRgb(f.color) }}
        aria-label={fieldLabel(f)}
        aria-required={f.required || undefined}
        aria-describedby={description ? descId : undefined}
        onFocus={() => {
          setWithin(true);
          markFocused(page, f);
          notTyping(); // the phone's own picker, no keyboard
        }}
        onBlur={() => {
          setWithin(false);
          markBlurred(page, f);
        }}
        onChange={onChange}
      >
        {f.type === "combo" && <option value="" selected={values.size === 0}>—</option>}
        {extra && <option value={f.value} selected>{f.displayValue ?? f.value}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value} selected={values.has(o.value)}>{o.label}</option>
        ))}
      </select>
      {description && <span id={descId} hidden>{description}</span>}
      {within && <Chip f={f} box={box} />}
    </div>
  );
}

/** Touch targets (px in the page) of the page's widgets, by FieldWidget.index; null with a fine pointer. */
type Targets = ReadonlyMap<number, Rect> | null;

/**
 * A check box, or one radio button of its group (`group`; `badge`: the group's first, which shows
 * its "required" badge): native, see-through over the field's own drawing. On touch screens its
 * control takes the finger on its target (`targets`), round the box.
 */
function BoxControl({ page, zoom, f, group, badge, targets }: {
  page: PageModel; zoom: number; f: FieldWidget; group?: string; badge?: boolean; targets: Targets;
}) {
  const latest = useRef(f);
  latest.current = f;
  const on = f.onState ?? "Yes";
  const isOn = (x: FieldWidget) => x.value !== "Off" && x.value !== "" && x.value === (x.onState ?? "Yes");
  const box = rectBox(page, f.rect, zoom);
  const [hx0, hy0, hx1, hy1] = targets?.get(f.index) ?? [box.left, box.top, box.left + box.width, box.top + box.height];
  const radio = f.type === "radio";
  const label = radio ? choiceLabel(f, on) || fieldLabel(f) : fieldLabel(f);

  const onChange = (e: Event) => {
    const node = e.currentTarget as HTMLInputElement;
    const state = radio ? on : node.checked ? on : "Off";
    const before = page.rev.peek();
    void writeField(page, latest.current, { kind: "state", state }).then(() => {
      if (page.rev.peek() === before) node.checked = isOn(latest.current); // refused: as the engine has it
    });
  };

  return (
    <div class={["form-field", "is-box", (radio ? badge : f.required) && "is-required"].filter(Boolean).join(" ")} style={px(box)}>
      <input
        class="form-field-control"
        type={radio ? "radio" : "checkbox"}
        name={group}
        data-field-index={f.index}
        checked={isOn(f)}
        style={{
          left: `${hx0 - box.left}px`,
          top: `${hy0 - box.top}px`,
          width: `${hx1 - hx0}px`,
          height: `${hy1 - hy0}px`,
        }}
        aria-label={label}
        aria-required={(!radio && f.required) || undefined}
        onFocus={() => {
          markFocused(page, f);
          notTyping();
        }}
        onBlur={() => markBlurred(page, f)}
        onChange={onChange}
      />
    </div>
  );
}

/** The radio buttons of one field on this page, as one radio group named after the field. */
function RadioGroup({ page, zoom, widgets, targets }: { page: PageModel; zoom: number; widgets: FieldWidget[]; targets: Targets }) {
  const first = widgets[0];
  return (
    <div
      class="form-field-group"
      role="radiogroup"
      aria-label={fieldLabel(first)}
      aria-required={first.required || undefined}
    >
      {widgets.map((w, i) => (
        <BoxControl
          key={w.index}
          page={page}
          zoom={zoom}
          f={w}
          group={`field-${page.index}-${first.name}`}
          badge={i === 0 && first.required}
          targets={targets}
        />
      ))}
    </div>
  );
}

/**
 * An unsigned signature field: "Sign here". With a signature waiting to be placed it goes in the
 * box (fitted, resting on its bottom); otherwise the signature chooser opens, for this box.
 */
function SignHere({ page, zoom, f }: { page: PageModel; zoom: number; f: FieldWidget }) {
  const button = useRef<HTMLButtonElement>(null);
  const box = rectBox(page, f.rect, zoom);
  const label = fieldLabel(f);
  const words = box.width >= SIGN_TEXT_MIN.width && box.height >= SIGN_TEXT_MIN.height;
  // It goes once the signature is in the box: a focus it still had stays in the document (the
  // signature's frame takes it as it comes, see ImageLayer).
  useLayoutEffect(() => {
    const node = button.current;
    return () => {
      if (node && document.activeElement === node) rescueFocus(viewerScroller);
    };
  }, []);
  // Fitted in the box and turned with the field's text (a field on a turned page, or turned itself).
  const sign = () => {
    const sig = pendingPlacement.peek();
    if (sig) {
      void placeSignature(page.index, sig, signatureInField(f.rect, sig.width / Math.max(1, sig.height), f.rotation));
      return;
    }
    showDialog({
      kind: "signature", mode: "signature", forField: { pageIndex: page.index, rect: f.rect, rotation: f.rotation },
    });
  };
  return (
    <div class={f.required ? "form-field is-sign is-required" : "form-field is-sign"} style={px(box)}>
      <button
        ref={button}
        type="button"
        class="form-field-control form-field-sign"
        data-field-index={f.index}
        title={t("form.signHereLabel", { label })}
        aria-label={t("form.signHereLabel", { label })}
        aria-required={f.required || undefined}
        onFocus={() => {
          markFocused(page, f);
          notTyping();
        }}
        onBlur={() => markBlurred(page, f)}
        onClick={sign}
      >
        <IconSignature />
        {words && <span>{t("form.signHere")}</span>}
      </button>
    </div>
  );
}

/** A field the app does not fill (read-only, password, file select...): no tint, a lock, no focus. */
function Locked({ page, zoom, f }: { page: PageModel; zoom: number; f: FieldWidget }) {
  return (
    <div
      class="form-field is-locked"
      style={px(rectBox(page, f.rect, zoom))}
      title={t("form.readOnly")}
      role="note"
      onClick={() => showToast("info", t("form.readOnly"))}
    >
      <IconLock />
      <span class="sr-only">{`${fieldLabel(f)}: ${t("form.readOnly")}`}</span>
    </div>
  );
}

// --- The layer -----------------------------------------------------------------------------------

/**
 * A picture the user added covers the field: its middle is in the field's box, or the box's
 * middle is under the picture. "Sign here" then goes (the picture stacks above the fields, so it
 * can be selected again; viewer.css).
 */
function coveredBy(f: FieldWidget, pictures: readonly ImageInfo[]): boolean {
  const [fx0, fy0, fx1, fy1] = f.rect;
  const fcx = (fx0 + fx1) / 2, fcy = (fy0 + fy1) / 2;
  return pictures.some(({ visible: [x0, y0, x1, y1] }) => {
    if (!(x1 > x0 && y1 > y0)) return false;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    return (cx >= fx0 && cx <= fx1 && cy >= fy0 && cy <= fy1) || (fcx >= x0 && fcx <= x1 && fcy >= y0 && fcy <= y1);
  });
}

export function FormLayer({ page, zoom, canvasRev }: { page: PageModel; zoom: number; canvasRev: number }) {
  const rev = page.rev.value;
  const cached = page.fields.value;
  const images = page.images.value;
  const focus = focusedField.value;
  const request = focusRequest.value;
  const coarse = isCoarse.value;
  const layer = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ensureFields(page);
  }, [page, rev, cached]);

  // While the fields are read again after an edit, the controls stay as they were (a field with
  // the focus keeps it): an edit changes values, never where the widgets are.
  const last = useRef<FieldWidget[] | null>(null);
  const fresh = cached && cached.rev === rev ? cached.fields : null;
  if (fresh) last.current = fresh;
  const fields = fresh ?? last.current;

  // Touch screens: how far each check box's and radio button's target may reach (px in the page).
  const targets = useMemo<Targets>(() => {
    if (!coarse || !fields) return null;
    const rects = fields.map((f): Rect => {
      const b = rectBox(page, f.rect, zoom);
      return [b.left, b.top, b.left + b.width, b.top + b.height];
    });
    const grows = fields.map((f) => (f.type === "checkbox" || f.type === "radio") && f.locked === null);
    const out = touchTargets(rects, grows, TOUCH_TARGET);
    return new Map(fields.map((f, i) => [f.index, out[i]]));
  }, [fields, zoom, coarse, page]);

  // A signature placed in an unsigned signature field (or any picture the user added over one)
  // hides its "Sign here": the pictures the user added are read to know (the last ones read
  // while they are read again after an edit, so "Sign here" does not flash up meanwhile).
  const hasSign = fields?.some(isUnsignedSignature) ?? false;
  useEffect(() => {
    if (hasSign) ensureImages(page);
  }, [page, rev, hasSign, images]);
  const lastAdded = useRef<ImageInfo[]>([]);
  if (images && images.rev === rev) lastAdded.current = images.images.filter((i) => i.added);
  const added = lastAdded.current;

  // The app asks for a field to get the focus (the next field on another page, "Fill them in").
  // A focus already within that field stays where it is: on "Today" in its chip, Tab goes on
  // from there (pulling it back into the field would trap Tab).
  useEffect(() => {
    if (!focus || focus.pageIndex !== page.index || !fields) return;
    const el = layer.current?.querySelector<HTMLElement>(`[data-field-index="${focus.index}"]`);
    if (el && !focusWithinField(el, document.activeElement)) el.focus();
  }, [focus, fields]);

  // focusRequest for a field of this page, by name: its first widget here that takes the focus.
  useEffect(() => {
    honourFocusRequest(page.index, "field", fresh !== null, (name) => {
      for (const f of fresh ?? []) {
        const el = f.name === name ? layer.current?.querySelector<HTMLElement>(`[data-field-index="${f.index}"]`) : null;
        if (el) return el;
      }
      return null;
    });
  }, [request, fresh]);

  const items: ComponentChildren[] = [];
  if (fields) {
    const radios = new Map<string, FieldWidget[]>();
    for (const f of fields) {
      if (f.type !== "radio" || f.locked !== null) continue;
      const list = radios.get(f.name);
      if (list) list.push(f);
      else radios.set(f.name, [f]);
    }
    const grouped = new Set<string>();
    for (const f of fields) {
      const key = `w${f.index}`;
      const props = { page, zoom, f, fields, canvasRev };
      if (f.type === "button") continue; // no value, and its action would be a script
      if (f.type === "signature") {
        if (isUnsignedSignature(f) && !coveredBy(f, added)) items.push(<SignHere key={key} page={page} zoom={zoom} f={f} />);
        continue; // signed: the "digitally signed" notice says what happens to it
      }
      if (f.locked !== null) {
        items.push(<Locked key={key} page={page} zoom={zoom} f={f} />);
        continue;
      }
      switch (f.type) {
        case "text":
          items.push(<TextControl key={key} {...props} />);
          break;
        case "combo":
          items.push(f.editable ? <TextControl key={key} {...props} /> : <ChoiceControl key={key} {...props} />);
          break;
        case "list":
          items.push(<ChoiceControl key={key} {...props} />);
          break;
        case "checkbox":
          items.push(<BoxControl key={key} page={page} zoom={zoom} f={f} targets={targets} />);
          break;
        case "radio":
          if (grouped.has(f.name)) break;
          grouped.add(f.name);
          items.push(
            <RadioGroup key={`g${f.index}`} page={page} zoom={zoom} widgets={radios.get(f.name) ?? [f]} targets={targets} />,
          );
          break;
      }
    }
  }

  return <div ref={layer} class="form-fields">{items}</div>;
}
