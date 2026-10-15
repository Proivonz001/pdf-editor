// What the app shows with no document: a big "Open a PDF" button, the privacy promise, the
// engine status (it loads about 10 MB the first time) and the link to the source code.
import { t } from "../i18n";
import { engineStatus, opening } from "../state";
import { openFilePicker } from "./filePicker";
import { IconDocument, IconLock, IconOpen } from "./icons";
import { isCoarse } from "./media";

const SOURCE_URL = "https://github.com/Proivonz001/pdf-editor";

function EngineStatusLine() {
  const status = engineStatus.value;
  if (status === "loading") {
    return (
      <p class="engine-status" role="status">
        <span class="spinner" aria-hidden="true" />
        {t("engine.loading")}
      </p>
    );
  }
  if (status === "error") {
    return (
      <div class="engine-error" role="alert">
        <p>{t("engine.failed")}</p>
        <button type="button" class="btn" onClick={() => location.reload()}>{t("engine.reload")}</button>
      </div>
    );
  }
  return null;
}

export function EmptyState() {
  return (
    <section class="empty" aria-labelledby="empty-title">
      <div class="empty-card">
        <div class="empty-illustration"><IconDocument /></div>
        <h1 id="empty-title" class="empty-title">{t("empty.title")}</h1>
        <p class="empty-subtitle">{t("empty.subtitle")}</p>
        <button
          type="button"
          class="btn btn-primary btn-big"
          disabled={engineStatus.value === "error"}
          onClick={openFilePicker}
        >
          <IconOpen />
          <span>{t("empty.open")}</span>
        </button>
        {!isCoarse.value && <p class="empty-hint">{t("empty.dropHint")}</p>}
        <p class="privacy"><IconLock />{t("empty.privacy")}</p>
        <EngineStatusLine />
      </div>
      <footer class="empty-footer">
        <a href={SOURCE_URL} target="_blank" rel="noopener noreferrer">{t("empty.source")}</a>
      </footer>
    </section>
  );
}

/** Shown in place of the document while a file is being opened. */
export function OpeningState() {
  const name = opening.value ?? "";
  const waiting = engineStatus.value === "loading";
  return (
    <section class="empty" aria-busy="true">
      <p class="opening" role="status">
        <span class="spinner" aria-hidden="true" />
        {waiting ? t("open.waitingEngine") : t("open.opening", { name })}
      </p>
    </section>
  );
}
