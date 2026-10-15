// The home page (no document open), styled by styles/home.css: a hero with the "Open a PDF"
// button, the privacy promise and the engine status (MuPDF loads about 10 MB the first time),
// a small drawing of a line being edited, three feature cards, "How it works" and a footer with
// the source link. Also the "opening…" card shown while a file is being read.
// The hero comes first in the DOM, so on phones the button is on screen without scrolling.
// Right after a document is closed, the page heading takes the focus (see takeHomeFocus).
import type { ComponentChildren } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";
import { t } from "../i18n";
import { SOURCE_URL } from "../links";
import { engineStatus, opening } from "../state";
import { takeHomeFocus } from "./actions";
import { openFilePicker } from "./filePicker";
import { rescueFocus } from "./focus";
import { IconCheck, IconClose, IconDevices, IconFont, IconLock, IconOpen, IconShield } from "./icons";
import { isCoarse } from "./media";

function EngineStatusLine() {
  const status = engineStatus.value;
  if (status === "loading") {
    return (
      <p class="home-status" role="status">
        <span class="spinner" aria-hidden="true" />
        {t("engine.loading")}
      </p>
    );
  }
  if (status === "error") {
    return (
      <div class="home-error" role="alert">
        <p>{t("engine.failed")}</p>
        <button type="button" class="btn btn-secondary" onClick={() => location.reload()}>{t("engine.reload")}</button>
      </div>
    );
  }
  return null;
}

// Widths of the grey "text" bars on the sample page (fractions of its text column).
const ADDRESS = ["44%", "34%", "39%"];
const BODY = ["100%", "92%", "97%", "58%"];
const ROWS = [["46%", "13%"], ["38%", "11%"], ["42%", "15%"]];

const bar = (width: string, i: number, extra = "") => (
  <span key={i} class={`sample-bar${extra}`} style={{ width }} />
);

/**
 * A white page with a highlighted line under edit, its caret and the context bar above it.
 * One image for assistive technology (role="img"); the words in it are part of the drawing.
 */
function SampleIllustration() {
  return (
    <div class="home-figure">
      <div class="home-sample" role="img" aria-label={t("home.sampleLabel")}>
        <div class="sample-head">
          {bar("40%", 0, " is-title")}
          {bar("20%", 1)}
        </div>
        <div class="sample-group sample-address">{ADDRESS.map((w, i) => bar(w, i))}</div>
        <div class="sample-edit">
          <div class="sample-ctx">
            <span class="sample-pill"><IconClose />{t("edit.cancel")}</span>
            <span class="sample-pill is-apply"><IconCheck />{t("edit.apply")}</span>
          </div>
          <div class="sample-line">
            <span class="sample-text">{t("home.sampleLine")}</span>
            <span class="sample-caret" />
          </div>
        </div>
        <div class="sample-group sample-body">{BODY.map((w, i) => bar(w, i))}</div>
        <div class="sample-table">
          {ROWS.map(([a, b], i) => (
            <div key={i} class="sample-row">{bar(a, 0)}{bar(b, 1)}</div>
          ))}
          <div class="sample-row is-total">{bar("26%", 0, " is-title")}{bar("18%", 1, " is-title")}</div>
        </div>
      </div>
    </div>
  );
}

function Feature({ icon, title, body }: { icon: ComponentChildren; title: string; body: string }) {
  return (
    <li class="home-feature">
      <span class="home-feature-icon">{icon}</span>
      <div class="home-feature-text">
        <h2 class="home-feature-title">{title}</h2>
        <p class="home-feature-body">{body}</p>
      </div>
    </li>
  );
}

function Step({ n, text }: { n: number; text: string }) {
  return (
    <li class="home-step">
      <span class="home-step-num" aria-hidden="true">{n}</span>
      <span class="home-step-text">{text}</span>
    </li>
  );
}

export function EmptyState() {
  const title = useRef<HTMLHeadingElement>(null);

  // The Close or Back button that closed the document is gone, so the focus would fall to <body>.
  // The heading rather than "Open a PDF": screen readers announce the home page, the next Tab
  // reaches the button, and the button may be disabled (engine failed). Never on the first load.
  useLayoutEffect(() => {
    if (takeHomeFocus()) rescueFocus(() => title.current);
  }, []);

  return (
    <div class="home">
      <div class="home-inner">
        <section class="home-hero" aria-labelledby="home-title">
          <div class="home-hero-text">
            <div class="home-intro">
              <h1 id="home-title" class="home-title" tabIndex={-1} ref={title}>
                {t("home.titleLead")}{" "}
                <mark class="hl-mark">{t("home.titleMark")}</mark>{" "}
                {t("home.titleTail")}
              </h1>
              <p class="home-subtitle">{t("home.subtitle")}</p>
            </div>
            <div class="home-actions">
              <div class="home-cta">
                <button
                  type="button"
                  class="btn btn-primary btn-big home-open"
                  disabled={engineStatus.value === "error"}
                  onClick={openFilePicker}
                >
                  <IconOpen />
                  <span>{t("empty.open")}</span>
                </button>
                {!isCoarse.value && <p class="home-drop-hint">{t("empty.dropHint")}</p>}
              </div>
              <p class="home-privacy"><IconLock />{t("empty.privacy")}</p>
              <EngineStatusLine />
            </div>
          </div>
          <SampleIllustration />
        </section>

        <ul class="home-features" role="list">
          <Feature icon={<IconFont />} title={t("home.f1Title")} body={t("home.f1Body")} />
          <Feature icon={<IconDevices />} title={t("home.f2Title")} body={t("home.f2Body")} />
          <Feature icon={<IconShield />} title={t("home.f3Title")} body={t("home.f3Body")} />
        </ul>

        <section class="home-steps" aria-labelledby="home-steps-title">
          <h2 id="home-steps-title" class="home-section-title">{t("home.stepsTitle")}</h2>
          <ol class="home-steps-list" role="list">
            <Step n={1} text={t("home.step1")} />
            <Step n={2} text={t("home.step2")} />
            <Step n={3} text={t("home.step3")} />
          </ol>
        </section>

        <footer class="home-footer">
          <span>{t("home.free")}</span>
          <span aria-hidden="true">·</span>
          <a href={SOURCE_URL} target="_blank" rel="noopener noreferrer">{t("empty.source")}</a>
        </footer>
      </div>
    </div>
  );
}

/** Shown in place of the document while a file is being opened. */
export function OpeningState() {
  const name = opening.value ?? "";
  const waiting = engineStatus.value === "loading";
  return (
    <section class="opening" aria-busy="true">
      <div class="opening-card">
        <span class="spinner" aria-hidden="true" />
        <p class="opening-text" role="status">
          {waiting ? t("open.waitingEngine") : t("open.opening", { name })}
        </p>
      </div>
    </section>
  );
}
