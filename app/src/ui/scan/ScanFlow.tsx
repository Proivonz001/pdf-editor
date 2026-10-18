// "Foto e scansione" (release 4): photos of sheets, from the phone's camera or the gallery, made
// into pages (found, straightened and cleaned up in the scan worker: src/scan), then a new PDF or
// pages added to the open document. Mounted by app.tsx while `scanFlow` (state.ts) is set: from
// the home page's "Scansiona un documento" (a new PDF), the organizer's "+" menu, "Foto o
// scansione" (pages at a place), and the home page's "Riprendi" on an unfinished scan
// (resumeScan). The state and what the buttons do are in ./flow.ts; the corner editor and the
// tray in ./CornerEditor.tsx and ./Tray.tsx; styles in styles/scan.css (.scan-*).
//
// A modal on the native <dialog>, with the mechanics of the app's other modals (ui/modal.ts: the
// rest inert, the focus inside, Tab kept inside, the focus given back): a dialog on desktop, the
// whole screen on phones (CSS only, so turning the phone loses nothing). Its own header has the
// title and a close button; Escape, the close button and the browser closing it (Android's back
// gesture) all cancel, which asks first only when the tray has pages (flow.ts, cancelScan). The
// window's shortcuts and drop handling leave the document alone while it is open (shortcuts.ts,
// DropOverlay.tsx): Escape is the dialog's, and pictures dropped on it join as photos.
//
// The two pickers are file inputs inside the modal (one outside would be inert while it is open;
// iOS opens pickers only for inputs in the document) and are clicked within the user's tap:
// "Fotocamera" with `capture="environment"`, which opens the camera on phones (one photo per
// opening: iOS replaces the files even with `multiple`, so "Altra pagina" opens it again), and
// "Galleria" ("Scegli immagini" with a mouse) with `multiple` and no `capture`. With a mouse
// there is no camera to open: one button picks pictures. A picker dismissed without a photo fires
// "cancel" at its input, which bubbles: only the dialog's own "cancel" cancels the flow.
//
// When the device keeps an unfinished scan from before, a new opening first asks: continue it, or
// start over (flow.ts, phase "kept"), naming the document its pages are for. Pages for a document
// that is not open (a resumed or continued scan) say so, naming it, and why Fine makes a new PDF
// instead, and offer "Più tardi" to keep the pages for that document, only while the device keeps
// them (flow.ts, orphanOffer): when it could not, the hint says that only a new PDF keeps them.
// "Più tardi" pressed while the tray's save is on its way waits for it (busy). Pages that go into
// the open document say where, naming it.
//
// The focus: on open, the step's main control or heading ([data-step-focus]); when a step gives
// way to another (its controls gone with the focus), the new step's. A status line says what
// happened (a page added, moved, deleted) and a failure shows at the top until the next action.
import { useEffect, useId, useLayoutEffect, useRef } from "preact/hooks";
import { t } from "../../i18n";
import type { SavedScan } from "../../platform/resume";
import type { AnalysedPhoto } from "../../scan/scanClient";
import { cornersUsable } from "../../scan/sizes";
import type { PageShape, ScanMode } from "../../scan/types";
import { doc, type ScanTarget } from "../../state";
import { IconPageScan, IconClose, IconImage } from "../icons";
import { isCoarse } from "../media";
import { trapTab, useModal } from "../modal";
import { CornerEditor } from "./CornerEditor";
import {
  addPhotos, alerted, cancelScan, continueKept, discardPhoto, documentFor, dropPhotos, finishScan, flowClosed, flowOpened,
  keepForLater, leaving, makePage, notKept, orphanOffer, pageShape, phase, resumeTray, said, scanMode, setCorners,
  setPageShape, setScanMode, startOver, takesPhotos, targetNow, toggleWholePhoto, tray, wholePhotoAction, type Phase,
  type TrayPage,
} from "./flow";
import { Tray } from "./Tray";

/**
 * Open the scan flow with the tray of an unfinished scan kept on this device (the home page's
 * Riprendi, from loadScan, or the toast after resuming its document): its pages, for its target.
 * An insert whose document is not the open one says so, naming it: Fine makes a new PDF instead,
 * or "Più tardi" keeps the scan for that document (while the device keeps it).
 */
export function resumeScan(saved: SavedScan): void {
  resumeTray(saved);
}

// A new opening (a new ScanTarget object) always mounts a fresh flow.
const keys = new WeakMap<ScanTarget, number>();
let nextKey = 1;
/** The Preact key of the flow opened for `target` (app.tsx). */
export function scanFlowKey(target: ScanTarget): number {
  let k = keys.get(target);
  if (!k) keys.set(target, (k = nextKey++));
  return k;
}

const photoKeys = new WeakMap<AnalysedPhoto, number>();
let nextPhotoKey = 1;
function photoKey(photo: AnalysedPhoto): number {
  let k = photoKeys.get(photo);
  if (!k) photoKeys.set(photo, (k = nextPhotoKey++));
  return k;
}

const MODES: readonly ScanMode[] = ["document", "grey", "bw", "original"];
const MODE_LABEL = {
  document: "scan.mode.document", grey: "scan.mode.grey", bw: "scan.mode.bw", original: "scan.mode.original",
} as const;
const MODE_HINT = {
  document: "scan.modeHint.document", grey: "scan.modeHint.grey", bw: "scan.modeHint.bw", original: "scan.modeHint.original",
} as const;
const SHAPES: readonly PageShape[] = ["a4", "photo"];
const SHAPE_LABEL = { a4: "scan.shape.a4", photo: "scan.shape.photo" } as const;

type Source = "camera" | "gallery";

/**
 * The dialog's "cancel" (Escape, the back gesture): Cancel, which asks first when the tray has
 * pages. Only the dialog's own: a picker dismissed without a photo fires "cancel" at its input
 * (Chrome, Edge, Firefox, Safari 16.4+), which bubbles up to here and must leave the flow as it was.
 */
export function onFlowCancel(e: Pick<Event, "target" | "currentTarget" | "preventDefault">): void {
  if (e.target !== e.currentTarget) return;
  e.preventDefault(); // cancelScan decides, asking first when there are pages
  void cancelScan();
}

function carriesFiles(e: DragEvent) {
  return !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");
}

/** Files dragged over the flow: a drop is taken while photos can join (the window leaves it to the flow). */
export function onFlowDragOver(e: DragEvent): void {
  if (!carriesFiles(e)) return;
  e.preventDefault(); // allow the drop (and never let the browser open the file)
  if (e.dataTransfer) e.dataTransfer.dropEffect = takesPhotos() ? "copy" : "none";
}

/** Files dropped on the flow: the pictures among them join as photos (flow.ts, dropPhotos). */
export function onFlowDrop(e: DragEvent): void {
  if (!carriesFiles(e)) return;
  e.preventDefault();
  dropPhotos([...(e.dataTransfer?.files ?? [])]);
}

export function ScanFlow({ target }: { target: ScanTarget }) {
  const ref = useRef<HTMLDialogElement>(null);
  const closing = useModal(ref, { initialFocus: "[data-step-focus]", onUnmount: flowClosed });
  useEffect(() => flowOpened(), []); // a scan kept from before is asked about first
  const titleId = useId();
  const camera = useRef<HTMLInputElement>(null);
  const gallery = useRef<HTMLInputElement>(null);
  /** The tray page the photo being picked is to replace (Rifai), or null for a new page. */
  const replace = useRef<number | null>(null);
  const coarse = isCoarse.value;
  const p = phase.value;
  const pages = tray.value;
  const now = targetNow(target);
  const forDoc = documentFor(target);
  const fail = alerted.value;
  const status = said.value;
  const pageCount = doc.value?.pages.length ?? 0;

  /** Open a picker, within the tap that asked for it. */
  const pick = (from: Source, page: number | null = null) => {
    replace.current = page;
    (from === "camera" ? camera : gallery).current?.click();
  };
  const onPicked = (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const files = input.files ? [...input.files] : [];
    input.value = ""; // the same photo again still fires "change"
    const page = replace.current;
    replace.current = null;
    if (files.length) addPhotos(files, page);
  };
  /** The picker was dismissed without a photo: nothing changes (and the dialog is not told). */
  const onPickerCancel = (e: Event) => {
    e.stopPropagation();
    replace.current = null;
  };

  const view = p.step === "kept" ? "kept"
    : p.step === "reading" ? "reading" : p.step === "corners" ? "corners" : pages.length ? "tray" : "start";
  // The step changed and the focus went with the controls of the one before: the new step's.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const active = document.activeElement;
    if (active && active !== document.body && el.contains(active)) return;
    el.querySelector<HTMLElement>("[data-step-focus]")?.focus({ preventScroll: true });
  }, [view]);

  const finishing = p.step === "tray" && p.finishing;
  const leavingNow = leaving.value;
  let body;
  if (p.step === "kept") {
    body = <KeptStep pages={p.pages} name={p.for ?? null} busy={p.busy} />;
  } else if (p.step === "reading") {
    body = <ReadingStep index={p.index} total={p.total} />;
  } else if (p.step === "corners") {
    body = <CornersStep key={photoKey(p.photo)} p={p} coarse={coarse} pages={pages} />;
  } else if (pages.length) {
    body = (
      <TrayStep pages={pages} finishing={finishing} leaving={leavingNow} coarse={coarse} target={now} pageCount={pageCount}
        name={forDoc} offer={orphanOffer(target)} onPick={pick} />
    );
  } else {
    body = <StartStep coarse={coarse} onPick={pick} />;
  }

  return (
    <dialog
      ref={ref}
      class="dialog scan"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onKeyDown={(e) => trapTab(e, ref.current)}
      onCancel={onFlowCancel}
      onDragOver={onFlowDragOver}
      onDrop={onFlowDrop}
      onClose={(e) => {
        if (closing.current || e.target !== e.currentTarget) return; // our own close() on unmount
        // The browser closed it by itself (the back gesture): show it again, then ask as Cancel does.
        try {
          ref.current?.showModal();
        } catch {
          ref.current?.setAttribute("open", "");
        }
        void cancelScan();
      }}
    >
      <div class="scan-head">
        <h2 id={titleId} class="scan-title">{t(now.kind === "new" ? "scan.titleNew" : "scan.titleInsert")}</h2>
        <button
          type="button"
          class="btn tool scan-close"
          aria-label={t("common.close")}
          title={t("common.close")}
          aria-disabled={finishing || leavingNow ? "true" : undefined}
          onClick={() => void cancelScan()}
        >
          <IconClose />
        </button>
      </div>
      <div class="scan-body">
        {fail && <p key={fail.n} class="scan-alert" role="alert">{fail.text}</p>}
        {body}
      </div>
      <input ref={camera} type="file" accept="image/*" capture="environment" hidden tabIndex={-1} aria-hidden="true"
        onChange={onPicked} onCancel={onPickerCancel} />
      <input ref={gallery} type="file" accept="image/*" multiple hidden tabIndex={-1} aria-hidden="true"
        onChange={onPicked} onCancel={onPickerCancel} />
      <p class="sr-only" role="status">{status && <span key={status.n}>{status.text}</span>}</p>
    </dialog>
  );
}

/** What the "kept" question says of the scan's pages (`name`: the document they are for, when known). */
function keptBody(pages: number, name: string | null): string {
  if (name !== null) return pages === 1 ? t("scan.keptBodyForOne", { name }) : t("scan.keptBodyFor", { count: pages, name });
  return pages === 1 ? t("scan.keptBodyOne") : t("scan.keptBody", { count: pages });
}

/**
 * An unfinished scan of `pages` pages is kept from before (for the document `name`, when known):
 * continue it, or start over (which forgets it).
 */
function KeptStep({ pages, name, busy }: { pages: number; name: string | null; busy: boolean }) {
  const off = busy ? "true" : undefined;
  return (
    <div class="scan-step scan-start">
      <h3 class="scan-step-title" tabIndex={-1} data-step-focus>{t("scan.keptTitle")}</h3>
      <p class="scan-lead">{keptBody(pages, name)}</p>
      <div class="scan-start-actions">
        <button type="button" class="btn btn-primary btn-big" aria-disabled={off} onClick={() => {
          if (!busy) void continueKept();
        }}>
          {busy && <span class="spinner" aria-hidden="true" />}
          <span>{t("scan.keptContinue")}</span>
        </button>
        <button type="button" class="btn btn-secondary btn-big" aria-disabled={off} onClick={() => {
          if (!busy) void startOver();
        }}>
          <span>{t("scan.keptStartOver")}</span>
        </button>
      </div>
    </div>
  );
}

/** Nothing in the tray yet: how to take a good photo, and the pickers. */
function StartStep({ coarse, onPick }: { coarse: boolean; onPick: (from: Source) => void }) {
  return (
    <div class="scan-step scan-start">
      <p class="scan-lead">{t(coarse ? "scan.startHint" : "scan.startHintDesktop")}</p>
      <div class="scan-start-actions">
        {coarse ? (
          <>
            <button type="button" class="btn btn-primary btn-big" data-step-focus onClick={() => onPick("camera")}>
              <IconPageScan />
              <span>{t("scan.camera")}</span>
            </button>
            <button type="button" class="btn btn-secondary btn-big" onClick={() => onPick("gallery")}>
              <IconImage />
              <span>{t("scan.gallery")}</span>
            </button>
          </>
        ) : (
          <button type="button" class="btn btn-primary btn-big" data-step-focus onClick={() => onPick("gallery")}>
            <IconImage />
            <span>{t("scan.choose")}</span>
          </button>
        )}
      </div>
      <p class="scan-note">{t("scan.keptNote")}</p>
    </div>
  );
}

/** A photo is being read and its sheet looked for (its heading takes the focus, so it is said). */
function ReadingStep({ index, total }: { index: number; total: number }) {
  return (
    <div class="scan-step scan-reading" role="status">
      <span class="spinner" aria-hidden="true" />
      <h3 class="scan-step-title" tabIndex={-1} data-step-focus>
        {total > 1 ? `${t("scan.photoOf", { n: index, count: total })} · ${t("scan.reading")}` : t("scan.reading")}
      </h3>
    </div>
  );
}

/** A choice of radio buttons drawn as chips (the mode, the page shape), with a hint under them. */
function Choice<V extends string>(p: {
  legend: string;
  value: V;
  options: readonly { value: V; label: string }[];
  onChange: (value: V) => void;
  hint?: string;
}) {
  const name = useId();
  const hintId = useId();
  return (
    <fieldset class="scan-choice" aria-describedby={p.hint ? hintId : undefined}>
      <legend class="scan-legend">{p.legend}</legend>
      <div class="scan-chips">
        {p.options.map((o) => (
          <label key={o.value} class="scan-chip">
            <input type="radio" class="scan-chip-radio" name={name} value={o.value} checked={p.value === o.value}
              onChange={() => p.onChange(o.value)} />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
      {p.hint && <p id={hintId} class="scan-hint">{p.hint}</p>}
    </fieldset>
  );
}

/** The corner editor on a photo, its mode and page shape, and Aggiungi pagina. */
function CornersStep({ p, coarse, pages }: {
  p: Extract<Phase, { step: "corners" }>;
  coarse: boolean;
  pages: readonly TrayPage[];
}) {
  const helpId = useId();
  const usable = cornersUsable(p.corners, p.photo.width, p.photo.height);
  const mode = scanMode.value;
  const shape = pageShape.value;
  const replaced = p.replaces === null ? -1 : pages.findIndex((x) => x.id === p.replaces);
  const title = p.total > 1 ? `${t("scan.photoOf", { n: p.index, count: p.total })} · ${t("scan.cornersTitle")}` : t("scan.cornersTitle");
  const whole = wholePhotoAction(p);
  return (
    <div class="scan-step scan-corners">
      <div class="scan-step-head">
        <h3 class="scan-step-title" tabIndex={-1} data-step-focus>{title}</h3>
        <button type="button" class="btn btn-secondary scan-small"
          aria-disabled={p.making || whole === null ? "true" : undefined} onClick={toggleWholePhoto}>
          {t(whole === "found" ? "scan.foundEdges" : "scan.wholePhoto")}
        </button>
      </div>
      {p.found
        ? <p class="scan-hint">{t("scan.cornersFound")}</p>
        : <p class="scan-hint is-warn" role="status">{t("scan.cornersNotFound")}</p>}
      <CornerEditor photo={p.photo} corners={p.corners} onCorners={setCorners} disabled={p.making} describedBy={helpId} />
      <p id={helpId} class={coarse ? "sr-only" : "scan-hint"}>{t("scan.cornersHelp")}</p>
      {!usable && <p class="scan-hint is-warn" role="alert">{t("scan.cornersCrossed")}</p>}
      <div class="scan-options">
        <Choice
          legend={t("scan.mode")}
          value={mode}
          options={MODES.map((m) => ({ value: m, label: t(MODE_LABEL[m]) }))}
          onChange={setScanMode}
          hint={t(MODE_HINT[mode])}
        />
        <Choice
          legend={t("scan.shape")}
          value={shape}
          options={SHAPES.map((s) => ({ value: s, label: t(SHAPE_LABEL[s]) }))}
          onChange={setPageShape}
        />
      </div>
      <div class="dialog-actions scan-actions">
        <button type="button" class="btn btn-secondary" aria-disabled={p.making ? "true" : undefined}
          onClick={() => {
            if (!p.making) discardPhoto();
          }}>
          {t("scan.discard")}
        </button>
        <button type="button" class="btn btn-primary" aria-disabled={p.making || !usable ? "true" : undefined}
          onClick={() => {
            if (!p.making && usable) void makePage();
          }}>
          {p.making && <span class="spinner" aria-hidden="true" />}
          <span>{replaced >= 0 ? t("scan.replacePage", { n: replaced + 1 }) : t("scan.addPage")}</span>
        </button>
      </div>
    </div>
  );
}

/** Where Fine puts the pages, in words: a new PDF, or the place in the document `name` (the open one). */
function goesText(target: ScanTarget, pageCount: number, name: string | null): string {
  if (target.kind === "new") return t("scan.goesNew");
  const doc = name ?? "";
  if (target.at <= 0) return t("scan.goesStart", { name: doc });
  if (target.at >= pageCount) return t("scan.goesEnd", { name: doc });
  return t("scan.goesAfter", { n: target.at, name: doc });
}

/** Why pages meant for a document that is not open wait (orphanOffer's `offer`), naming it when known. */
function orphanText(offer: "later" | "unkept", name: string | null): string {
  if (name === null) return t(offer === "later" ? "scan.orphanHint" : "scan.orphanHintNotKept");
  return offer === "later" ? t("scan.orphanHintFor", { name }) : t("scan.orphanHintForNotKept", { name });
}

/**
 * The pages so far, another page, and Fine. `offer` (flow.ts, orphanOffer): they were meant for a
 * document that is not open (a resumed or continued scan), so Fine makes a new PDF instead, said
 * so; "later": the device keeps them and "Più tardi" leaves them for that document; "unkept": it
 * could not, so no "Più tardi" (it would lose them) and the hint says that only a new PDF keeps
 * them. `leaving`: "Più tardi" waits for the device (busy, like everything else meanwhile).
 */
function TrayStep({ pages, finishing, leaving, coarse, target, pageCount, name, offer, onPick }: {
  pages: readonly TrayPage[];
  finishing: boolean;
  leaving: boolean;
  coarse: boolean;
  /** As Fine will use it (targetNow), and the open document's page count. */
  target: ScanTarget;
  pageCount: number;
  /** The document the pages are for (flow.ts, documentFor): the open one for an insert. */
  name: string | null;
  offer: "later" | "unkept" | null;
  onPick: (from: Source, replace?: number | null) => void;
}) {
  const goesId = useId();
  const finishButton = useRef<HTMLButtonElement>(null);
  const hadLater = useRef(false);
  const count = pages.length;
  const busy = finishing || leaving;
  const off = busy ? "true" : undefined;
  const own = coarse ? "camera" : "gallery";
  const later = offer === "later";
  // "Più tardi" went (the device could not keep the pages) and took the focus with it: Fine, which keeps them.
  useLayoutEffect(() => {
    const had = hadLater.current;
    hadLater.current = later;
    const active = document.activeElement;
    if (had && !later && (!active || active === document.body)) finishButton.current?.focus({ preventScroll: true });
  }, [later]);
  return (
    <div class="scan-step scan-tray-step">
      <h3 class="scan-step-title" tabIndex={-1} data-step-focus>
        {count === 1 ? t("scan.pagesOne") : t("scan.pages", { count })}
      </h3>
      <Tray pages={pages} busy={busy} onRetake={(id) => onPick(own, id)} />
      {notKept.value && offer !== "unkept" && <p class="scan-note is-warn">{t("scan.notKept")}</p>}
      <p id={goesId} class={offer ? "scan-hint is-warn" : "scan-hint"}>
        {offer ? orphanText(offer, name) : goesText(target, pageCount, name)}
      </p>
      <div class="dialog-actions scan-actions">
        {later && (
          <button type="button" class="btn btn-secondary" aria-disabled={off} onClick={() => {
            if (!busy) void keepForLater();
          }}>
            {leaving && <span class="spinner" aria-hidden="true" />}
            <span>{t("scan.later")}</span>
          </button>
        )}
        <button type="button" class="btn btn-secondary" aria-disabled={off} onClick={() => {
          if (!busy) onPick(own);
        }}>
          {coarse ? <IconPageScan /> : <IconImage />}
          <span>{t(coarse ? "scan.another" : "scan.morePictures")}</span>
        </button>
        {coarse && (
          <button type="button" class="btn btn-secondary" aria-disabled={off} onClick={() => {
            if (!busy) onPick("gallery");
          }}>
            <IconImage />
            <span>{t("scan.fromGallery")}</span>
          </button>
        )}
        <button ref={finishButton} type="button" class="btn btn-primary scan-finish" aria-disabled={off}
          aria-describedby={goesId} onClick={() => {
            if (!busy) void finishScan();
          }}>
          {finishing && <span class="spinner" aria-hidden="true" />}
          <span>{t(offer ? "scan.finishNew" : "scan.finish")}</span>
        </button>
      </div>
    </div>
  );
}
