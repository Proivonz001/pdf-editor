// Desktop details panel (right, from 1200 px). It follows what the user is doing:
// - browsing: facts about the document (file, pages, size of the current page, protection,
//   edits and whether they were downloaded), how to start editing, and the privacy note;
// - edit mode, no line open: the three steps, the legend of the line marks, the shortcuts;
// - edit mode with a line open: that line's text, font, size, style and colour, the shortcuts.
// Read-only: it shows state and offers one action (enter edit mode), nothing else.
import type { ComponentChildren } from "preact";
import type { LineInfo } from "../engine/protocol";
import { formatFontSize, t } from "../i18n";
import { currentPage, dirty, editingLine, editingStopped, editMode, history } from "../state";
import { fontDisplayName, isSubsetFont } from "../viewer/fontName";
import type { OpenDoc } from "../viewer/model";
import { setEditMode } from "./actions";
import { IconCheck, IconEditText, IconShield } from "./icons";
import { shortcuts } from "./media";
import { pageSize } from "./pageSize";

/** sRGB 0..1 → "#1A2B3C". */
function hexColor(rgb: readonly number[]): string {
  const hex = rgb.slice(0, 3).map((c) => Math.round(Math.min(1, Math.max(0, c || 0)) * 255).toString(16).padStart(2, "0"));
  return `#${hex.join("").toUpperCase()}`;
}

function styleName(line: LineInfo): string {
  if (line.bold && line.italic) return t("details.styleBoldItalic");
  if (line.bold) return t("details.styleBold");
  if (line.italic) return t("details.styleItalic");
  return t("details.styleRegular");
}

/** A titled block. Not a labelled region: inside the panel's own landmark, headings are enough. */
function Section({ title, children }: { title: string; children: ComponentChildren }) {
  return (
    <section class="dp-section">
      <h2 class="section-label">{title}</h2>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <div class="dp-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function DocumentInfo({ doc }: { doc: OpenDoc }) {
  const count = doc.pages.length;
  const page = doc.pages[Math.min(currentPage.value, count - 1)] ?? doc.pages[0];
  const size = page ? pageSize(page.width, page.height) : null;
  const edits = history.value.editCount;
  const edited = dirty.value;
  const stopped = editingStopped.value;

  return (
    <>
      <Section title={t("details.document")}>
        <dl class="dp-list">
          <Row label={t("details.file")}>
            <span class="dp-file">{doc.fileName}</span>
          </Row>
          <Row label={t("details.pages")}>
            <span class="dp-num">{count}</span>
          </Row>
          {size && (
            <Row label={t("details.pageSize")}>
              <span class="dp-num">
                {size.name
                  ? t("details.pageSizeNamed", { name: size.name, w: size.widthMm, h: size.heightMm })
                  : t("details.pageSizeValue", { w: size.widthMm, h: size.heightMm })}
              </span>
            </Row>
          )}
          {doc.info.encrypted && <Row label={t("details.protected")}>{t("details.protectedValue")}</Row>}
          {/* Undoing every edit after a download leaves no edits, but a file on disk that still
              has them: that is "not downloaded", as the top bar's "Edited" says. */}
          <Row label={t("details.edits")}>
            {edits === 0 && !edited ? (
              t("details.editsNone")
            ) : (
              <span class="dp-edits">
                {edits > 0 && <span class="dp-num">{edits}</span>}
                {edited ? (
                  <span class="dp-status">
                    <span class="edited-dot" aria-hidden="true" />
                    {t("details.notDownloaded")}
                  </span>
                ) : (
                  <span class="dp-status">
                    <IconCheck />
                    {t("details.downloaded")}
                  </span>
                )}
              </span>
            )}
          </Row>
        </dl>
      </Section>
      <div class="dp-section">
        {stopped ? (
          <p class="dp-callout is-stopped">{t("broken.note")}</p>
        ) : (
          <div class="dp-callout">
            <p>{t("details.howTo")}</p>
            <button type="button" class="btn btn-secondary" onClick={() => void setEditMode(true)}>
              <IconEditText />
              <span>{t("tools.editText")}</span>
            </button>
          </div>
        )}
      </div>
      <p class="dp-privacy">
        <IconShield />
        <span>{t("details.privacy")}</span>
      </p>
    </>
  );
}

function EditSteps() {
  const steps = [t("details.step1"), t("details.step2"), t("details.step3")];
  return (
    <Section title={t("details.editTitle")}>
      <ol class="dp-steps" role="list">
        {steps.map((text, i) => (
          <li key={i} class="dp-step">
            <span class="dp-step-num" aria-hidden="true">{i + 1}</span>
            <span>{text}</span>
          </li>
        ))}
      </ol>
      <ul class="dp-legend" role="list">
        <li>
          <span class="dp-swatch is-editable" aria-hidden="true" />
          {t("details.legendEditable")}
        </li>
        <li>
          <span class="dp-swatch is-locked" aria-hidden="true" />
          {t("details.legendLocked")}
        </li>
      </ul>
    </Section>
  );
}

function LineInfoSection({ line }: { line: LineInfo }) {
  const font = fontDisplayName(line.fontName);
  const size = formatFontSize(line.size);
  const color = hexColor(line.color);
  return (
    <Section title={t("details.line")}>
      <p class="dp-quote" dir="auto">{line.text}</p>
      <dl class="dp-list">
        <Row label={t("details.font")}>
          <span>{font || t("details.fontUnknown")}</span>
          <span class="dp-sub">{isSubsetFont(line.fontName) ? t("details.fontSubset") : t("details.fontFull")}</span>
        </Row>
        <Row label={t("details.size")}>
          <span class="dp-num">{t("details.sizeValue", { size })}</span>
        </Row>
        <Row label={t("details.style")}>{styleName(line)}</Row>
        <Row label={t("details.color")}>
          <span class="dp-color">
            {/* The line's own colour, from the document (not a theme colour). */}
            <span class="dp-color-swatch" style={{ background: color }} aria-hidden="true" />
            <span class="dp-hex">{color}</span>
          </span>
        </Row>
      </dl>
      <p class="dp-note">{t("details.wholeLine")}</p>
    </Section>
  );
}

/** Enter/Esc for the line editor (Esc leaves edit mode when no line is open), then history and save. */
function Shortcuts({ lineOpen }: { lineOpen: boolean }) {
  const rows: [key: string, action: string][] = [
    [t("key.enter"), t("shortcut.apply")],
    [t("key.esc"), lineOpen ? t("shortcut.cancel") : t("shortcut.exitEdit")],
    [shortcuts.undo, t("shortcut.undo")],
    [shortcuts.redo, t("shortcut.redo")],
    [shortcuts.save, t("shortcut.download")],
  ];
  return (
    <Section title={t("details.shortcuts")}>
      <dl class="dp-keys">
        {rows.map(([key, action]) => (
          <div key={key} class="dp-key-row">
            <dt><kbd class="kbd">{key}</kbd></dt>
            <dd>{action}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

export function DetailsPanel({ doc }: { doc: OpenDoc }) {
  const editing = editMode.value;
  const line = editing ? editingLine.value?.line ?? null : null;

  return (
    <aside class="details-panel" id="details-panel" aria-label={t("details.label")}>
      {!editing ? (
        <DocumentInfo doc={doc} />
      ) : (
        <>
          {line ? <LineInfoSection line={line} /> : <EditSteps />}
          <Shortcuts lineOpen={line !== null} />
        </>
      )}
    </aside>
  );
}
