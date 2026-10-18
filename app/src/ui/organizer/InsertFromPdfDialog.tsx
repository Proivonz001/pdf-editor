// "Da un altro PDF…" (the `insert-from-pdf` dialog): the page picker for pages of another PDF,
// added at the place the dialog was opened for ("after page 3", "at the start"; held by its page,
// so a page operation landing meanwhile moves it with that page). It opens on the
// file already chosen (from the "+" menu's picker, or dropped between the thumbnails), else asks
// for one; a protected file asks for its password right here; a file too big, damaged or not a
// PDF is said as such, with "Choose another PDF…". Then its pages as thumbnails with check
// boxes, all chosen at first ("All" chooses all or none), and "Add N pages". The flow itself is
// SourcePicker (sourcePicker.ts); the other PDF is closed when the dialog closes, or once its
// pages are in. Thumbnails are drawn one at a time, only those near the visible part, and a
// canvas far away is released.
import type { ComponentChildren } from "preact";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { MAX_SOURCE_BYTES, type PageInfo } from "../../engine/protocol";
import { pageCount, t } from "../../i18n";
import { devicePixelRatio, doc, showDialog, type DialogState } from "../../state";
import { Dialog } from "../Dialog";
import { insertGap, pickPdf, takePendingSource } from "./commands";
import { gapText } from "./model";
import { SourcePicker, type PickerState } from "./sourcePicker";

/** CSS width of a page's thumbnail in the picker (organizer.css: .org-pdf-pages). */
const THUMB_CSS = 96;
/** Pixel budget of one of them. */
const MAX_PIXELS = 160_000;

/** Pixels per point for page `bounds` drawn `cssWidth` px wide at `ratio` device px per CSS px, within the budget. */
export function sourceScale(bounds: PageInfo["bounds"], cssWidth: number, ratio: number): number {
  const w = Math.max(1, bounds[2] - bounds[0]);
  const h = Math.max(1, bounds[3] - bounds[1]);
  const scale = Math.min((cssWidth * ratio) / w, Math.sqrt(MAX_PIXELS / (w * h)));
  return Math.max(1, Math.floor(scale * 1000)) / 1000;
}

/** One render at a time, in the order asked; a request no longer wanted when its turn comes is skipped. */
class Renders {
  private chain: Promise<unknown> = Promise.resolve();
  ask(run: () => Promise<void>) {
    this.chain = this.chain.then(run, run);
  }
}

/**
 * One IntersectionObserver for all the thumbnails: near the visible part of the scroller (about
 * a screen around it) or not. Thumbnails register before it is connected (child effects run
 * first): they are observed once it is.
 */
class Nearness {
  private io: IntersectionObserver | null = null;
  private readonly targets = new Map<Element, (near: boolean) => void>();

  connect(root: HTMLElement) {
    this.io = new IntersectionObserver((entries) => {
      for (const entry of entries) this.targets.get(entry.target)?.(entry.isIntersecting);
    }, { root, rootMargin: "100% 0px" });
    for (const el of this.targets.keys()) this.io.observe(el);
  }

  observe(el: Element, onChange: (near: boolean) => void): () => void {
    this.targets.set(el, onChange);
    this.io?.observe(el);
    return () => {
      this.targets.delete(el);
      this.io?.unobserve(el);
    };
  }

  disconnect() {
    this.io?.disconnect();
    this.io = null;
  }
}

function SourcePage({ picker, renders, nearness, index, info, chosen }: {
  picker: SourcePicker;
  renders: Renders;
  nearness: Nearness;
  index: number;
  info: PageInfo;
  chosen: boolean;
}) {
  const box = useRef<HTMLSpanElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(false);
  const [ready, setReady] = useState(false);
  const ratio = devicePixelRatio.value;
  const w = Math.max(1, info.bounds[2] - info.bounds[0]);
  const h = Math.max(1, info.bounds[3] - info.bounds[1]);

  useLayoutEffect(() => nearness.observe(box.current!, setNear), []);

  useEffect(() => {
    if (!near) return;
    let wanted = true;
    renders.ask(async () => {
      if (!wanted) return;
      const result = await picker.render(index, sourceScale(info.bounds, THUMB_CSS, ratio));
      const c = canvas.current;
      if (!result) return;
      if (!wanted || !c) {
        result.bitmap.close();
        return;
      }
      c.width = result.width;
      c.height = result.height;
      c.getContext("2d")?.drawImage(result.bitmap, 0, 0);
      result.bitmap.close();
      setReady(true);
    });
    return () => {
      wanted = false;
      // Out of view: its memory back (width = 0 frees the backing store at once).
      const c = canvas.current;
      if (c) {
        c.width = 0;
        c.height = 0;
      }
      setReady(false);
    };
  }, [near, ratio]);

  return (
    <label class={chosen ? "org-pdf-page is-chosen" : "org-pdf-page"}>
      <span ref={box} class={ready ? "org-pdf-thumb is-ready" : "org-pdf-thumb"} style={{ "--ar": String(w / h) }}>
        <canvas ref={canvas} class="org-pdf-canvas" aria-hidden="true" />
      </span>
      <span class="org-pdf-check">
        <input type="checkbox" class="dl-checkbox" checked={chosen} onChange={() => picker.toggle(index)} />
        <span>{t("viewer.page", { page: index + 1 })}</span>
      </span>
    </label>
  );
}

/** The pages of the other PDF, with "All" and the check boxes. */
function SourcePages({ picker, state }: { picker: SourcePicker; state: Extract<PickerState, { stage: "pages" }> }) {
  const root = useRef<HTMLDivElement>(null);
  const renders = useMemo(() => new Renders(), []);
  const nearness = useMemo(() => new Nearness(), []);
  useLayoutEffect(() => {
    nearness.connect(root.current!);
    return () => nearness.disconnect();
  }, []);
  const all = state.chosen.size === state.pages.length;
  const some = state.chosen.size > 0 && !all;
  const groupId = useId();
  return (
    <div class="org-pdf">
      <label class="dl-check org-pdf-all">
        <input type="checkbox" class="dl-checkbox" checked={all} indeterminate={some} onChange={() => picker.setAll(!all)} />
        <span>{t("org.pdfAll")}</span>
      </label>
      <p id={groupId} class="sr-only">{t("org.pdfPagesLabel", { name: state.name })}</p>
      <div ref={root} class="org-pdf-pages" role="group" aria-labelledby={groupId}>
        {state.pages.map((info, i) => (
          <SourcePage key={i} picker={picker} renders={renders} nearness={nearness} index={i} info={info}
            chosen={state.chosen.has(i)} />
        ))}
      </div>
    </div>
  );
}

export function InsertFromPdfDialog({ state }: { state: Extract<DialogState, { kind: "insert-from-pdf" }> }) {
  const picker = useMemo(() => new SourcePicker(), []);
  const s = picker.state.value;
  const [password, setPassword] = useState("");
  const form = useRef<HTMLFormElement>(null);
  const passwordId = useId();
  const close = () => showDialog(null);
  // The document the pages are for: when it goes (or another takes its place), so does the dialog.
  const d = doc.value;
  // Where the pages go, as it is now: the place follows page operations that land while the
  // dialog is open (commands.insertGap; it reads d.layout, so "after page 3" is said again).
  const at = insertGap(state);
  const opened = useRef(d);
  useEffect(() => {
    if (d !== opened.current) close();
  }, [d]);

  // The file chosen before the dialog (the "+" menu's picker, a drop), if any; the other PDF
  // closed with the dialog.
  useEffect(() => {
    const file = takePendingSource();
    if (file) void picker.choose(file);
    return () => picker.dispose();
  }, []);

  // A new step replaces the controls: the focus goes to the new step's own (the password field,
  // "Add", "Choose another PDF…"). While the file opens, it stays where it is unless its button
  // went (then Cancel has it).
  useLayoutEffect(() => {
    const el = form.current;
    if (!el) return;
    const active = document.activeElement;
    const kept = active && active !== document.body && el.contains(active);
    if (s.stage === "loading" && kept) return;
    el.querySelector<HTMLElement>("[data-autofocus]")?.focus();
  }, [s.stage, s.stage === "password" && s.wrong]);

  const choose = (e: MouseEvent) => {
    pickPdf(e.currentTarget as Element, (file) => {
      setPassword("");
      void picker.choose(file);
    });
  };
  const chooseButton = (primary: boolean, first: boolean) => (
    <button type="button" class={primary ? "btn btn-primary" : "btn btn-secondary"} data-autofocus={primary || undefined}
      onClick={choose}>
      {first ? t("org.pdfChoose") : t("org.pdfChooseOther")}
    </button>
  );
  const cancel = (focus = false) => (
    <button type="button" class="btn btn-secondary" data-autofocus={focus || undefined} onClick={close}>
      {t("common.cancel")}
    </button>
  );

  let body: ComponentChildren;
  let actions: ComponentChildren;
  switch (s.stage) {
    case "choose":
      body = <p id="dlg-body" class="dialog-body">{t("org.pdfIntro")}</p>;
      actions = <>{cancel()}{chooseButton(true, true)}</>;
      break;
    case "loading":
      body = (
        <p id="dlg-body" class="dialog-body org-pdf-status" role="status">
          <span class="spinner" aria-hidden="true" />
          <span>{t("org.pdfOpening", { name: s.name })}</span>
        </p>
      );
      actions = cancel(true);
      break;
    case "password":
      body = (
        <>
          <p id="dlg-body" class="dialog-body">{t("org.pdfProtected", { name: s.name })}</p>
          <div class="field-group">
            <label class="field-label" for={passwordId}>{t("password.label")}</label>
            <input
              id={passwordId}
              class="field"
              type="password"
              autocomplete="off"
              spellcheck={false}
              data-autofocus
              value={password}
              aria-invalid={s.wrong}
              aria-describedby={s.wrong ? `${passwordId}-error` : undefined}
              onInput={(e) => setPassword(e.currentTarget.value)}
            />
            {s.wrong && <p id={`${passwordId}-error`} class="field-error">{t("password.wrong")}</p>}
          </div>
        </>
      );
      actions = (
        <>
          {cancel()}
          {chooseButton(false, false)}
          <button type="submit" class="btn btn-primary" disabled={!password}>{t("password.open")}</button>
        </>
      );
      break;
    case "error": {
      const text = s.reason === "too-big"
        ? t("org.pdfTooBig", { name: s.name, max: Math.round(MAX_SOURCE_BYTES / (1024 * 1024)) })
        : s.reason === "not-pdf" ? t("org.pdfNotPdf", { name: s.name }) : t("org.pdfDamaged", { name: s.name });
      body = <p id="dlg-body" class="dialog-body org-pdf-error" role="alert">{text}</p>;
      actions = <>{cancel()}{chooseButton(true, false)}</>;
      break;
    }
    case "pages": {
      const n = s.chosen.size;
      body = (
        <>
          <p id="dlg-body" class="dialog-body">
            <span class="org-pdf-name">{s.name}</span> · {pageCount(s.pages.length)}. {t("org.pdfWhere", { where: gapText(at) })}
          </p>
          <SourcePages picker={picker} state={s} />
          {n === 0 && <p class="field-error">{t("org.pdfNone")}</p>}
        </>
      );
      actions = (
        <>
          {cancel()}
          {chooseButton(false, false)}
          <button type="submit" class="btn btn-primary" data-autofocus disabled={n === 0}>
            {n === 1 ? t("org.pdfAddOne") : t("org.pdfAdd", { count: n })}
          </button>
        </>
      );
      break;
    }
  }

  const submit = (e: Event) => {
    e.preventDefault();
    if (s.stage === "password") {
      if (password) void picker.submitPassword(password);
      return;
    }
    if (s.stage !== "pages" || picker.chosenPages() === null) return;
    void picker.add(insertGap(state)); // takes the other PDF first: closing the dialog no longer closes it
    close();
  };

  return (
    <Dialog labelledBy="dlg-title" describedBy="dlg-body" onCancel={close}>
      <form ref={form} class="dialog-form org-pdf-dialog" onSubmit={submit} noValidate>
        <h2 id="dlg-title" class="dialog-title">{t("org.pdfTitle")}</h2>
        {body}
        <div class="dialog-actions">{actions}</div>
      </form>
    </Dialog>
  );
}
