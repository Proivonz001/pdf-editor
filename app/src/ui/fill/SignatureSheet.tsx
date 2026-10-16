// The signature sheet of "Compila e firma" (the Firma and Sigla sub-tools, "Sign here" on a form's
// signature field, "Saved signatures" in the More menu): a bottom sheet on phones, a dialog on
// desktop, chosen when it opens (as the download options are), mounted by ui/Dialogs.tsx for the
// dialog state { kind: "signature" }. Styled by styles/fill.css (.sig-*).
//
// - The chooser, when this session or the device already has signatures (or initials): their
//   pictures over a checkerboard, when each was saved or that it lasts only until the app closes,
//   "Forget" on the saved ones (at once, no question: it is local and can be made again; busy
//   while the device's storage answers, and a failure is said under the row, since the toasts are
//   under the modal), and "New signature". Saved ones of the other kind are listed under them, so
//   the More menu's row can manage every saved one.
// - The creation sheet, with three tabs (roving tabindex, arrow keys): Disegna (the default on
//   touch screens: SignaturePad.tsx), Scrivi (the default with a mouse: the name in up to three of
//   the device's handwriting fonts) and Foto (a photo of a signature on paper: upright and scaled
//   by preparePicture, the paper taken away by extractInk, then cropped with four corners). Each
//   tab keeps what it holds while another is shown. Under them, for every tab: "Remember on this
//   device" (off by default, at most 5, with what that means and why it may be unavailable), the
//   legal line with "When is it enough?", and Use, which stays off until there is ink (more
//   than a tap on the pad). Enter in the typed name goes on to the styles; only Use makes it.
//
// Whatever the tab, the result is a trimmed PNG with alpha (signatureImage.ts), so no font goes
// into the PDF and release 2's frame moves it like any picture. Use hands it to useSignature
// (placed with the next tap, or inside the form field the sheet was opened for; it closes the
// sheet), and to rememberSignature when asked. Closing without one leaves Firma or Sigla for
// Testo (actions.ts).
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Rect } from "../../engine/protocol";
import { locale, t } from "../../i18n";
import { dialog, savedSignatures, sessionSignatures, type DialogState, type InkColor, type Signature } from "../../state";
import { forgetSignature, rememberSignature, useSignature } from "../actions";
import { Dialog } from "../Dialog";
import { IconPlus, IconTrash, IconUndo } from "../icons";
import { PictureError, preparePicture } from "../imageFile";
import { isCoarse, isNarrow } from "../media";
import { Sheet } from "../Sheet";
import { dateText } from "./dates";
import { availableHandwritingFonts } from "./handwritingFonts";
import { inkCss, SignaturePad } from "./SignaturePad";
import {
  extractInk, INK_RGB, initialsOf, inkExtent, MIN_INK_EXTENT, NoInkError, photoPixels, renderInk, renderStrokes,
  renderTyped, type FoundInk, type SignatureImage, type Stroke,
} from "./signatureImage";
import { available as storeAvailable, MAX_SAVED } from "./signatureStore";

type State = Extract<DialogState, { kind: "signature" }>;
type Kind = Signature["kind"];
type Tab = "draw" | "type" | "photo";
type PhotoInk = InkColor | "original";

/**
 * Longest side of the picture, in pixels: a signature placed 50 mm wide gets over 300 ppi
 * (signatureImage.SIGNATURE_MAX_SIDE); initials are placed about 10 mm tall.
 */
const MAX_SIDE: Record<Kind, number> = { signature: 1200, initials: 600 };
/** The crop keeps at least this much of each side (photo pixels). */
const MIN_CROP = 8;
/** Longest typed name or initials. */
const MAX_NAME = 60;

// ---------------------------------------------------------------------------------------------
// Small rules

/** What this session typed, so the next sheet starts with it (initials made from the name). */
const typed = { name: "", initials: "" };

/** The first text of a new sheet's Scrivi field. */
function typedStart(kind: Kind): string {
  return kind === "initials" ? typed.initials || initialsOf(typed.name) : typed.name;
}

/** The description screen readers say and the PDF's /Alt holds: "Firma: Mario Rossi", "Sigla". */
function describe(kind: Kind, name: string | null): string {
  if (kind === "initials") return name ? t("sign.descInitialsTyped", { name }) : t("sign.descInitials");
  return name ? t("sign.descTyped", { name }) : t("sign.desc");
}

function savedDate(sig: Signature): string {
  return dateText(new Date(sig.savedAt ?? Date.now()), locale.value, navigator.languages ?? []);
}

/** "Saved on 16/10/2026", or "Only until you close the app". */
function whenText(sig: Signature): string {
  return sig.savedAt === null ? t("sign.thisSession") : t("sign.savedOn", { date: savedDate(sig) });
}

function newId(): string {
  try {
    if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  } catch {
    // Not a secure context: the fallback below is unique enough on one device.
  }
  return `sig-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Safari on iPhone and iPad, outside the installed app, deletes what a site stored once the site
 * has not been opened for 7 days: a saved signature may not last.
 */
function storageMayExpire(): boolean {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (!ios) return false;
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    (typeof matchMedia === "function" && matchMedia("(display-mode: standalone)").matches);
  return !standalone;
}

const cssOf = (c: readonly [number, number, number]) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;

/**
 * Give the browser a frame to paint ("Finding the signature…") before a long computation. A
 * hidden page gets no frames (the user switched apps meanwhile): then a short wait instead.
 */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => setTimeout(resolve, 0));
    setTimeout(resolve, 100);
  });
}

/** The ink found in the photo, inside its box (found.box), painted `ink`: what the crop shows. */
function preview(found: FoundInk, ink: PhotoInk): Uint8ClampedArray {
  const [x0, y0, x1, y1] = found.box;
  const w = x1 - x0, h = y1 - y0;
  const [r, g, b] = ink === "original" ? found.ink : INK_RGB[ink];
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = found.alpha[(y + y0) * found.width + x + x0];
    }
  }
  return out;
}

type Corner = "tl" | "tr" | "bl" | "br";
const CORNERS: readonly Corner[] = ["tl", "tr", "bl", "br"];
const CORNER_LABEL = {
  tl: "sign.cropTopLeft", tr: "sign.cropTopRight", bl: "sign.cropBottomLeft", br: "sign.cropBottomRight",
} as const;

/**
 * `crop` with `corner` moved to (x, y), kept inside `limit` and at least MIN_CROP across (all in
 * photo pixels, [x0, y0, x1, y1) as signatureImage's boxes).
 */
export function moveCorner(crop: Rect, corner: Corner, x: number, y: number, limit: Rect): Rect {
  let [x0, y0, x1, y1] = crop;
  const minW = Math.min(MIN_CROP, limit[2] - limit[0]), minH = Math.min(MIN_CROP, limit[3] - limit[1]);
  if (corner === "tl" || corner === "bl") x0 = Math.round(Math.min(Math.max(limit[0], x), x1 - minW));
  else x1 = Math.round(Math.max(Math.min(limit[2], x), x0 + minW));
  if (corner === "tl" || corner === "tr") y0 = Math.round(Math.min(Math.max(limit[1], y), y1 - minH));
  else y1 = Math.round(Math.max(Math.min(limit[3], y), y0 + minH));
  return [x0, y0, x1, y1];
}

// ---------------------------------------------------------------------------------------------
// The sheet

/** The signature sheet: a bottom sheet on phones, a dialog on desktop (see the header). */
export function SignatureDialog({ state }: { state: State }) {
  // Chosen once, when it opens: switching at 640 px while it is open (turning the phone) would
  // remount it and lose what was drawn. Either one works at any width.
  const [narrow] = useState(() => isNarrow.peek());
  const kind = state.mode;
  const all = sessionSignatures.value;
  const mine = all.filter((s) => s.kind === kind);
  const othersSaved = all.filter((s) => s.kind !== kind && s.savedAt !== null);
  const [view, setView] = useState<"choose" | "create">(() => (mine.length || othersSaved.length ? "choose" : "create"));
  // The chooser emptied (the last one forgotten): on to a new one.
  const shown = view === "choose" && !mine.length && !othersSaved.length ? "create" : view;
  const titleId = useId();
  /**
   * Said once one is forgotten, also when that empties the chooser: the toasts are outside the
   * modal, inert while it is open (forgetSignature does not toast then). `n` makes the same
   * words a new message.
   */
  const [said, setSaid] = useState<{ n: number; text: string } | null>(null);
  const open = useRef(true);
  useEffect(() => () => {
    open.current = false;
  }, []);
  const say = (text: string) => {
    if (open.current) setSaid((s) => ({ n: (s?.n ?? 0) + 1, text }));
  };

  const close = () => {
    if (dialog.peek() === state) dialog.value = null;
  };
  /** Hand `sig` on: useSignature places it (next tap, or inside the field) and closes the sheet. */
  const take = (sig: Signature) => {
    useSignature(sig);
    close();
  };

  const title = shown === "choose"
    ? t(kind === "initials" ? "sign.titleChooseInitials" : "sign.titleChoose")
    : t(kind === "initials" ? "sign.titleNewInitials" : "sign.titleNew");
  const body = shown === "choose"
    ? <Chooser kind={kind} mine={mine} others={othersSaved} onTake={take} onNew={() => setView("create")} onCancel={close}
      onSay={say} />
    : <Creator kind={kind} title={title} onTake={take} onCancel={close} />;
  const status = <p class="sr-only" role="status">{said && <span key={said.n}>{said.text}</span>}</p>;

  if (narrow) {
    return (
      <Sheet title={title} class="sheet-signature" onClose={close}>
        <div class="sig-body">
          {body}
          {status}
        </div>
      </Sheet>
    );
  }
  return (
    <Dialog labelledBy={titleId} onCancel={close}>
      <div class="sig-body">
        <h2 id={titleId} class="dialog-title">{title}</h2>
        {body}
        {status}
      </div>
    </Dialog>
  );
}

/** After the view inside the open modal changed: the focus to its first control (as on open). */
function useFocusOnMount(root: { current: HTMLElement | null }) {
  useEffect(() => {
    const el = root.current;
    if (!el || el.contains(document.activeElement)) return;
    const target = el.querySelector<HTMLElement>("[data-autofocus]");
    target?.focus();
  }, []);
}

// ---------------------------------------------------------------------------------------------
// The chooser

/** A signature's picture over a checkerboard (its transparent parts show as such). */
function Thumb({ sig }: { sig: Signature }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const u = URL.createObjectURL(sig.png);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [sig.png]);
  return (
    <span class="sig-thumb sig-checker" aria-hidden="true">
      {url && <img src={url} alt="" draggable={false} />}
    </span>
  );
}

/** A Forget that failed: which row, and `n`, which makes the same words a new message at the next failure. */
type ForgetFailure = { id: string; n: number };

function Choices(p: {
  list: readonly Signature[];
  onTake: (sig: Signature) => void;
  onForget: (sig: Signature) => void;
  /** Rows whose Forget is under way. */
  busy: readonly string[];
  failed: ForgetFailure | null;
  autofocus: boolean;
}) {
  return (
    <ul class="sig-list">
      {p.list.map((sig, i) => {
        const when = whenText(sig);
        const forgetLabel = sig.savedAt === null
          ? ""
          : t(sig.kind === "initials" ? "sign.forgetInitialsLabel" : "sign.forgetLabel", { date: savedDate(sig) });
        const busy = p.busy.includes(sig.id);
        const failed = p.failed?.id === sig.id ? p.failed : null;
        return (
          <li key={sig.id}>
            <div class="sig-item">
              <button
                type="button"
                class="sig-pick"
                aria-label={`${sig.description}, ${when}`}
                title={t(sig.kind === "initials" ? "sign.useInitials" : "sign.use")}
                data-autofocus={p.autofocus && i === 0 ? true : undefined}
                onClick={() => p.onTake(sig)}
              >
                <Thumb sig={sig} />
                <span class="sig-item-text" aria-hidden="true">
                  <span class="sig-item-title">{sig.description}</span>
                  <span class="sig-item-when">{when}</span>
                </span>
              </button>
              {/* aria-disabled, not disabled, while it runs: the focus stays on it (a disabled
                  button would drop it out of the modal). */}
              {sig.savedAt !== null && (
                <button type="button" class="btn sig-forget" aria-label={forgetLabel} title={forgetLabel}
                  aria-disabled={busy ? "true" : undefined} onClick={() => { if (!busy) p.onForget(sig); }}>
                  {busy ? <span class="spinner" aria-hidden="true" /> : <IconTrash />}
                  <span aria-hidden="true">{t("sign.forget")}</span>
                </button>
              )}
            </div>
            {sig.savedAt !== null && (
              <p class="field-error" role="status" style={failed ? { marginTop: "6px" } : undefined}>
                {failed && <span key={failed.n}>{t("sign.forgetFailed")}</span>}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Chooser(p: {
  kind: Kind;
  mine: readonly Signature[];
  others: readonly Signature[];
  onTake: (sig: Signature) => void;
  onNew: () => void;
  onCancel: () => void;
  /** Say `text` to screen readers. */
  onSay: (text: string) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const othersId = useId();
  const [busy, setBusy] = useState<readonly string[]>([]);
  const [failed, setFailed] = useState<ForgetFailure | null>(null);
  const failures = useRef(0);
  const shown = useRef(true);
  useEffect(() => () => {
    shown.current = false;
  }, []);
  /**
   * Forget `sig` on the device. Gone: said to screen readers (the row going is what shows), and
   * the focus to the first row left. Kept (the device's storage refused it or did not answer):
   * said under its row, which stays, in the words the toast has elsewhere (sign.forgetFailed).
   */
  const forget = async (sig: Signature) => {
    const text = t(sig.kind === "initials" ? "sign.forgottenInitials" : "sign.forgotten");
    setBusy((b) => [...b, sig.id]);
    setFailed((f) => (f?.id === sig.id ? null : f));
    const done = await forgetSignature(sig.id).catch(() => false);
    if (done) p.onSay(text); // also when that emptied the chooser: the sheet says it
    if (!shown.current) return; // closed, or the chooser emptied
    setBusy((b) => b.filter((id) => id !== sig.id));
    if (!done) {
      setFailed({ id: sig.id, n: ++failures.current });
      return;
    }
    // The button pressed is gone: the focus to the first one left, or to "New".
    requestAnimationFrame(() => {
      const el = root.current;
      if (el && !el.contains(document.activeElement)) el.querySelector<HTMLElement>(".sig-pick, .sig-new")?.focus();
    });
  };
  return (
    <div ref={root} class="sig-chooser">
      {p.mine.length > 0 && (
        <Choices list={p.mine} onTake={p.onTake} onForget={forget} busy={busy} failed={failed} autofocus />
      )}
      <button type="button" class="btn btn-secondary sig-new" data-autofocus={p.mine.length ? undefined : true}
        onClick={p.onNew}>
        <IconPlus />
        <span>{t(p.kind === "initials" ? "sign.newInitials" : "sign.new")}</span>
      </button>
      {p.others.length > 0 && (
        <section class="sig-others" aria-labelledby={othersId}>
          <h3 id={othersId} class="section-label">
            {t(p.kind === "initials" ? "sign.titleChoose" : "sign.titleChooseInitials")}
          </h3>
          <Choices list={p.others} onTake={p.onTake} onForget={forget} busy={busy} failed={failed} autofocus={false} />
        </section>
      )}
      <div class="dialog-actions">
        <button type="button" class="btn btn-secondary" onClick={p.onCancel}>{t("common.cancel")}</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The creation sheet

/** A choice of ink: the two inks, and for a photo "as in the photo". */
function InkChoice<V extends string>(p: {
  value: V;
  options: { value: V; label: string; css: string }[];
  onChange: (value: V) => void;
}) {
  const name = useId();
  return (
    <fieldset class="sig-inks">
      <legend class="sig-legend">{t("writer.color")}</legend>
      <div class="sig-inks-row">
        {p.options.map((o) => (
          <label key={o.value} class="sig-ink">
            <input type="radio" class="sig-ink-radio" name={name} value={o.value} checked={p.value === o.value}
              onChange={() => p.onChange(o.value)} />
            <span class="sig-ink-swatch" style={{ background: o.css }} aria-hidden="true" />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

const inkOptions = (): { value: InkColor; label: string; css: string }[] => [
  { value: "black", label: t("writer.black"), css: inkCss("black") },
  { value: "blue", label: t("writer.blue"), css: inkCss("blue") },
];

type PhotoState =
  | { step: "idle" }
  | { step: "working" }
  | { step: "none" }
  | { step: "error"; message: string }
  /** `crop`: photo pixels, inside found.box. */
  | { step: "ready"; found: FoundInk; crop: Rect };

/** Why Use made nothing: it failed, or the crop holds no ink. */
type Failure = { n: number; empty: boolean };

function Creator(p: { kind: Kind; title: string; onTake: (sig: Signature) => void; onCancel: () => void }) {
  const kind = p.kind;
  const coarse = isCoarse.peek();
  const root = useRef<HTMLFormElement>(null);
  const [fonts] = useState(() => availableHandwritingFonts());
  const [tab, setTab] = useState<Tab>(() => (coarse || !fonts.length ? "draw" : "type"));
  const [color, setColor] = useState<InkColor>("black");
  // Disegna
  const [strokes, setStrokes] = useState<readonly Stroke[]>([]);
  // Scrivi
  const [name, setName] = useState(() => typedStart(kind));
  const [font, setFont] = useState(0);
  // Foto
  const [photo, setPhoto] = useState<PhotoState>({ step: "idle" });
  const [photoInk, setPhotoInk] = useState<PhotoInk>("original");
  // Ricorda
  const [remember, setRemember] = useState(false);
  const [canStore, setCanStore] = useState<boolean | null>(null);
  const full = savedSignatures.value.length >= MAX_SAVED;
  const [working, setWorking] = useState(false);
  const [failed, setFailed] = useState<Failure | null>(null);
  const gone = useRef(false);
  const ids = { tabs: useId(), panel: useId(), remember: useId(), drawHint: useId() };
  useFocusOnMount(root);

  useEffect(() => {
    let live = true;
    void storeAvailable().then(
      (ok) => { if (live) setCanStore(ok); },
      () => { if (live) setCanStore(false); },
    );
    return () => {
      live = false;
      gone.current = true;
    };
  }, []);

  const trimmedName = name.trim();
  // A tap or a slip on the pad is not a signature (it would become a disc 20 mm wide).
  const inked =
    tab === "draw" ? inkExtent(strokes) >= MIN_INK_EXTENT :
    tab === "type" ? trimmedName.length > 0 && fonts.length > 0 :
    photo.step === "ready";
  const rememberOff = canStore !== true || full;

  const make = (): Promise<SignatureImage> => {
    if (tab === "draw") return renderStrokes(strokes, color, MAX_SIDE[kind]);
    if (tab === "type") return renderTyped(trimmedName, fonts[font] ?? fonts[0], color, MAX_SIDE[kind]);
    if (photo.step !== "ready") return Promise.reject(new NoInkError("No photo"));
    return renderInk(photo.found, photoInk === "original" ? null : photoInk, photo.crop, MAX_SIDE[kind]);
  };

  const submit = async (e: Event) => {
    e.preventDefault();
    if (!inked || working) return;
    setWorking(true);
    setFailed(null);
    const source: Signature["source"] = tab;
    let made: SignatureImage;
    try {
      made = await make();
    } catch (err) {
      // A crop moved off the ink: the photo tab says so. Anything else is a failure.
      const empty = err instanceof NoInkError && source === "photo";
      if (!empty) console.warn("The signature could not be made", err);
      if (!gone.current) {
        setWorking(false);
        setFailed((f) => ({ n: (f?.n ?? 0) + 1, empty }));
      }
      return;
    }
    if (gone.current) return; // closed meanwhile
    if (source === "type") typed[kind === "initials" ? "initials" : "name"] = trimmedName;
    const sig: Signature = {
      id: newId(), kind, png: made.png, width: made.width, height: made.height,
      description: describe(kind, source === "type" ? trimmedName : null), source, savedAt: null,
    };
    p.onTake(sig);
    if (remember && !rememberOff) void rememberSignature(sig);
  };

  return (
    <form ref={root} class="sig-form" onSubmit={submit} noValidate>
      <Tabs tab={tab} onTab={setTab} label={p.title} ids={ids} autofocus={coarse || tab !== "type"} />
      <div id={`${ids.panel}-draw`} class="sig-panel" role="tabpanel" aria-labelledby={`${ids.tabs}-draw`}
        hidden={tab !== "draw"}>
        <p id={ids.drawHint} class="sig-hint">{t(coarse ? "sign.drawHint" : "sign.drawHintMouse")}</p>
        <SignaturePad kind={kind} color={color} strokes={strokes} onStrokes={setStrokes}
          label={t("sign.drawArea")} describedBy={ids.drawHint} />
        <p class="sig-hint sig-rotate">{t("sign.rotateHint")}</p>
        <div class="sig-row">
          <div class="sig-pad-actions">
            <button type="button" class="btn btn-secondary sig-small" disabled={!strokes.length}
              onClick={() => setStrokes(strokes.slice(0, -1))}>
              <IconUndo />
              <span>{t("sign.undoStroke")}</span>
            </button>
            <button type="button" class="btn btn-secondary sig-small" disabled={!strokes.length}
              onClick={() => setStrokes([])}>
              <IconTrash />
              <span>{t("sign.clear")}</span>
            </button>
          </div>
          <InkChoice value={color} options={inkOptions()} onChange={setColor} />
        </div>
        {fonts.length > 0 && (
          <p class="sig-hint">
            <button type="button" class="sig-link" onClick={() => setTab("type")}>{t("sign.drawNoPointer")}</button>
          </p>
        )}
      </div>
      <div id={`${ids.panel}-type`} class="sig-panel" role="tabpanel" aria-labelledby={`${ids.tabs}-type`}
        hidden={tab !== "type"}>
        <TypePanel kind={kind} name={name} onName={setName} fonts={fonts} font={font} onFont={setFont} color={color}
          autofocus={!coarse && tab === "type"} />
        {fonts.length > 0 && <InkChoice value={color} options={inkOptions()} onChange={setColor} />}
      </div>
      <div id={`${ids.panel}-photo`} class="sig-panel" role="tabpanel" aria-labelledby={`${ids.tabs}-photo`}
        hidden={tab !== "photo"}>
        <PhotoPanel photo={photo} onPhoto={setPhoto} ink={photoInk} onInk={setPhotoInk} />
      </div>

      <div class="sig-remember">
        <label class={rememberOff ? "sig-check is-disabled" : "sig-check"}>
          <input type="checkbox" class="sig-checkbox" checked={remember && !rememberOff} disabled={rememberOff}
            aria-describedby={ids.remember} onChange={(e) => setRemember(e.currentTarget.checked)} />
          <span>{t("sign.remember")}</span>
        </label>
        <div id={ids.remember} class="sig-check-note">
          {canStore === false ? <p>{t("sign.rememberUnavailable")}</p> : full ? <p>{t("sign.rememberFull")}</p> : (
            <>
              <p>{t("sign.rememberHint")}</p>
              {storageMayExpire() && <p>{t("sign.rememberSafari")}</p>}
            </>
          )}
        </div>
      </div>

      <div class="sig-legal">
        <p>{t("sign.legal")}</p>
        <details class="sig-legal-more">
          <summary>{t("sign.legalMoreButton")}</summary>
          <p>{t("sign.legalMore")}</p>
        </details>
      </div>

      {failed && (
        <p key={failed.n} class="field-error" role="alert">{t(failed.empty ? "sign.cropEmpty" : "sign.renderFailed")}</p>
      )}
      <div class="dialog-actions">
        <button type="button" class="btn btn-secondary" onClick={p.onCancel}>{t("common.cancel")}</button>
        <button type="submit" class="btn btn-primary" disabled={!inked || working}>
          {working && <span class="spinner" aria-hidden="true" />}
          <span>{t(kind === "initials" ? "sign.useInitials" : "sign.use")}</span>
        </button>
      </div>
    </form>
  );
}

const TABS: readonly Tab[] = ["draw", "type", "photo"];
const TAB_LABEL = { draw: "sign.draw", type: "sign.type", photo: "sign.photo" } as const;

/** Disegna, Scrivi, Foto: a tab list with roving tabindex; the arrows (and Home, End) move and pick. */
function Tabs(p: {
  tab: Tab;
  onTab: (tab: Tab) => void;
  label: string;
  ids: { tabs: string; panel: string };
  autofocus: boolean;
}) {
  const list = useRef<HTMLDivElement>(null);
  const onKeyDown = (e: KeyboardEvent) => {
    const at = TABS.indexOf(p.tab);
    let next: number;
    if (e.key === "ArrowRight") next = (at + 1) % TABS.length;
    else if (e.key === "ArrowLeft") next = (at + TABS.length - 1) % TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = TABS.length - 1;
    else return;
    e.preventDefault();
    p.onTab(TABS[next]);
    list.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
  };
  return (
    <div ref={list} class="sig-tabs" role="tablist" aria-label={p.label} onKeyDown={onKeyDown}>
      {TABS.map((tab) => (
        <button
          key={tab}
          type="button"
          id={`${p.ids.tabs}-${tab}`}
          class="sig-tab"
          role="tab"
          aria-selected={tab === p.tab}
          aria-controls={`${p.ids.panel}-${tab}`}
          tabIndex={tab === p.tab ? 0 : -1}
          data-autofocus={p.autofocus && tab === p.tab ? true : undefined}
          onClick={() => p.onTab(tab)}
        >
          {t(TAB_LABEL[tab])}
        </button>
      ))}
    </div>
  );
}

function TypePanel(p: {
  kind: Kind;
  name: string;
  onName: (name: string) => void;
  fonts: string[];
  font: number;
  onFont: (i: number) => void;
  color: InkColor;
  autofocus: boolean;
}) {
  const id = useId();
  const group = useId();
  const styles = useRef<HTMLFieldSetElement>(null);
  const label = t(p.kind === "initials" ? "sign.typeInitialsLabel" : "sign.typeLabel");
  const sample = p.name.trim();
  /**
   * Enter, or the phone keyboard's "Done", in the name: on to the styles (which the keyboard
   * was covering), so the signature is not made in the first one before they were seen. It
   * does not submit the form; Use does. The Enter that picks a word of an input method (Japanese,
   * Chinese) is not one: Safari ends the composition before that keydown, which then has only
   * keyCode 229 to say so.
   */
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Enter" || e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    const list = styles.current;
    (list?.querySelector<HTMLInputElement>(".sig-style-radio:checked") ?? list?.querySelector<HTMLInputElement>(".sig-style-radio"))
      ?.focus();
  };
  return (
    <>
      <div class="field-group">
        <label class="field-label" for={id}>{label}</label>
        <input
          id={id}
          class="field"
          type="text"
          value={p.name}
          maxLength={MAX_NAME}
          autocomplete={p.kind === "initials" ? "off" : "name"}
          autocapitalize={p.kind === "initials" ? "characters" : "words"}
          spellcheck={false}
          enterKeyHint="done"
          data-autofocus={p.autofocus ? true : undefined}
          onInput={(e) => p.onName(e.currentTarget.value)}
          onKeyDown={onKeyDown}
        />
      </div>
      {p.fonts.length ? (
        <fieldset ref={styles} class="sig-styles">
          <legend class="sig-legend">{t("sign.style")}</legend>
          {p.fonts.map((family, i) => (
            <label key={family} class="sig-style">
              <input type="radio" class="sig-style-radio" name={group} checked={p.font === i}
                aria-label={t("sign.styleN", { n: i + 1 })} onChange={() => p.onFont(i)} />
              <span
                class={sample ? "sig-style-sample" : "sig-style-sample is-empty"}
                style={{ fontFamily: family, color: sample ? inkCss(p.color) : undefined }}
                aria-hidden="true"
              >
                {sample || label}
              </span>
            </label>
          ))}
        </fieldset>
      ) : (
        <p class="sig-note">{t("sign.noHandwriting")}</p>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Foto

function PhotoPanel(p: {
  photo: PhotoState;
  onPhoto: (next: PhotoState) => void;
  ink: PhotoInk;
  onInk: (ink: PhotoInk) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const seq = useRef(0);
  const onPhoto = useRef(p.onPhoto);
  onPhoto.current = p.onPhoto;
  useEffect(() => () => { seq.current++; }, []); // unmounted: a photo still being read is dropped

  const read = async (file: File) => {
    const n = ++seq.current;
    onPhoto.current({ step: "working" });
    try {
      // Upright and at most 2000 px (preparePicture), then its pixels at the size the ink is
      // looked for in.
      const prepared = await preparePicture(file);
      const pixels = await photoPixels(prepared.bytes);
      if (n !== seq.current) return;
      await nextFrame();
      const found = extractInk(pixels.rgba, pixels.width, pixels.height);
      if (n !== seq.current) return;
      onPhoto.current(found.empty ? { step: "none" } : { step: "ready", found, crop: found.box });
    } catch (e) {
      if (n !== seq.current) return;
      const tooBig = e instanceof PictureError && e.code === "too-big";
      if (!tooBig) console.warn("The photo could not be read", e);
      onPhoto.current({ step: "error", message: tooBig ? t("image.pictureTooBig") : t("image.pictureUnreadable") });
    }
  };

  const ready = p.photo.step === "ready" ? p.photo : null;
  const found = ready?.found ?? null;
  const pixels = useMemo(() => (found ? preview(found, p.ink) : null), [found, p.ink]);

  return (
    <>
      <p class="sig-hint">{t("sign.photoHint")}</p>
      {/* Inside the modal: an input outside it would be inert while it is open. No `capture`:
          phones offer the camera and the gallery both. */}
      <input
        ref={input}
        type="file"
        accept="image/*"
        hidden
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          e.currentTarget.value = ""; // the same photo again still fires "change"
          if (file) void read(file);
        }}
      />
      <div class="sig-row">
        <button type="button" class="btn btn-secondary" disabled={p.photo.step === "working"}
          onClick={() => input.current?.click()}>
          {t(ready ? "sign.photoAgain" : "sign.photoPick")}
        </button>
        {p.photo.step === "working" && (
          <p class="sig-status" role="status">
            <span class="spinner" aria-hidden="true" />
            <span>{t("sign.photoWorking")}</span>
          </p>
        )}
      </div>
      {p.photo.step === "none" && <p class="field-error" role="alert">{t("sign.photoNone")}</p>}
      {p.photo.step === "error" && <p class="field-error" role="alert">{p.photo.message}</p>}
      {ready && pixels && (
        <>
          <div class="sig-crop-head">
            <span class="sig-legend">{t("sign.photoCrop")}</span>
            <span id={hintId} class="sig-hint">{t("sign.photoCropHint")}</span>
          </div>
          <PhotoCrop found={ready.found} pixels={pixels} crop={ready.crop} describedBy={hintId}
            onCrop={(crop) => p.onPhoto({ ...ready, crop })} />
          <InkChoice
            value={p.ink}
            options={[{ value: "original", label: t("sign.inkOriginal"), css: cssOf(ready.found.ink) }, ...inkOptions()]}
            onChange={p.onInk}
          />
        </>
      )}
    </>
  );
}

/**
 * The ink found in the photo (its box, found.box) over a checkerboard, with a crop frame moved by
 * its four corners: dragged, or with the arrow keys (1 % of a side, Shift 10 %).
 */
function PhotoCrop(p: {
  found: FoundInk;
  /** found.box's pixels, painted (preview). */
  pixels: Uint8ClampedArray;
  crop: Rect;
  describedBy: string;
  onCrop: (crop: Rect) => void;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ corner: Corner; pointer: number } | null>(null);
  const latest = useRef(p);
  latest.current = p;
  const box = p.found.box;
  const w = box[2] - box[0], h = box[3] - box[1];

  useLayoutEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;
    el.width = w;
    el.height = h;
    const image = ctx.createImageData(w, h);
    image.data.set(p.pixels.subarray(0, image.data.length));
    ctx.putImageData(image, 0, 0);
  }, [p.pixels, w, h]);

  /** A pointer's position as photo pixels. */
  const at = (e: PointerEvent): [number, number] | null => {
    const r = frame.current?.getBoundingClientRect();
    if (!r || !r.width || !r.height) return null;
    return [box[0] + ((e.clientX - r.left) / r.width) * w, box[1] + ((e.clientY - r.top) / r.height) * h];
  };

  const onDown = (corner: Corner) => (e: PointerEvent) => {
    if (!e.isPrimary || (e.pointerType === "mouse" && e.button !== 0)) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.focus({ preventScroll: true });
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // It still follows while over the handle.
    }
    drag.current = { corner, pointer: e.pointerId };
  };
  const onMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    const q = at(e);
    if (!q) return;
    const l = latest.current;
    l.onCrop(moveCorner(l.crop, d.corner, q[0], q[1], l.found.box));
  };
  const onEnd = (e: PointerEvent) => {
    if (drag.current?.pointer === e.pointerId) drag.current = null;
  };
  const onKey = (corner: Corner) => (e: KeyboardEvent) => {
    const dx = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
    const dy = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
    if (!dx && !dy) return;
    e.preventDefault();
    const step = e.shiftKey ? 0.1 : 0.01;
    const [x0, y0, x1, y1] = p.crop;
    const x = (corner === "tl" || corner === "bl" ? x0 : x1) + dx * Math.max(1, w * step);
    const y = (corner === "tl" || corner === "tr" ? y0 : y1) + dy * Math.max(1, h * step);
    p.onCrop(moveCorner(p.crop, corner, x, y, box));
  };

  const pct = (v: number, of: number) => `${(v / of) * 100}%`;
  const [c0, c1, c2, c3] = p.crop;
  const place = { left: pct(c0 - box[0], w), top: pct(c1 - box[1], h), width: pct(c2 - c0, w), height: pct(c3 - c1, h) };
  return (
    <div class="sig-photo" style={{ "--ar": (w / h).toFixed(4) }}>
      <div ref={frame} class="sig-photo-frame sig-checker">
        <canvas ref={canvas} class="sig-photo-canvas" role="img" aria-label={t("sign.photoPreview")} />
        {/* What the crop leaves out is dimmed; the handles sit outside this clip, on the corners. */}
        <div class="sig-crop-clip" aria-hidden="true">
          <div class="sig-crop-shade" style={place} />
        </div>
        <div class="sig-crop" style={place}>
          {CORNERS.map((corner) => (
            <button
              key={corner}
              type="button"
              class={`sig-crop-handle is-${corner}`}
              aria-label={t(CORNER_LABEL[corner])}
              aria-describedby={p.describedBy}
              title={t("sign.cropKeys")}
              onPointerDown={onDown(corner)}
              onPointerMove={onMove}
              onPointerUp={onEnd}
              onPointerCancel={onEnd}
              onKeyDown={onKey(corner)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
