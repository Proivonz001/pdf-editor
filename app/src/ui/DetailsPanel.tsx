// The details: one content (DetailsContent) in two frames. In the desktop layout (DetailsPanel)
// it is docked in its own column on the right at every width: open by default from 1200 px and
// closed by default below, until the rail's Details button makes one choice, remembered on this
// device (panels.ts). On phones it is a sheet opened from the More sheet (PhoneSheets): no
// shortcuts there, and its buttons that start a tool close the sheet first. It follows what the
// user is doing:
// - browsing: facts about the document (file, pages, size of the current page, PDF/A format,
//   protection, digital signature, form fields, edits and whether they were downloaded), how to
//   start editing (changing, moving, adding text and images) or filling in, and the privacy note;
// - Modifica with Cambia, nothing open: the three steps, Aggiungi testo and Aggiungi immagine,
//   the legend of the line and image marks, the shortcuts;
// - Modifica with a line open: that line's text, font, size, style and colour, what follows its
//   text if it is edited and what stays as it is (its decorations, once the engine has said),
//   the shortcuts;
// - Modifica with an image selected: its size, pixels and resolution, rotation, how to move it
//   (with a mouse, or by touch: large tablets have the panel too), and the image's own shortcuts;
// - Modifica with Aggiungi testo: the writer's size and colour while it is open, the selected
//   picture the user added as above, or else short steps for writing; the shortcuts;
// - Fill mode, nothing open: its steps, the legend of the field and text marks, the shortcuts;
//   with a writer open: its size and colour; with a picture it added selected: as in Modifica;
// - a form field with the focus (in Fill mode or browsing, D2): its label, type, whether it is
//   required, its maximum length.
// Read-only: it shows state and offers two actions (Edit, Fill & sign), nothing else.
import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { DocInfo, FieldWidget, ImageInfo, LineDecorations, LineInfo } from "../engine/protocol";
import { formatFontSize, formatMm, t } from "../i18n";
import {
  currentPage, dirty, editingDecorations, editingLine, editingStopped, focusedField, history, INK, openWriter,
  pendingPlacement, selectedImage, tool, writerOn, type InkColor, type OpenWriter, type SelectedImage,
} from "../state";
import { fontDisplayName, isSubsetFont } from "../viewer/fontName";
import { ppi, rotationDeg, sides } from "../viewer/imageGeometry";
import type { OpenDoc } from "../viewer/model";
import {
  decorationNames, decorationReasonText, distinctLeft, listText, lockReasonText, setTool, upperFirst,
} from "./actions";
import { fillableFields, formCountText } from "./fill/FillBar";
import { rescueFocus, viewerScroller } from "./focus";
import { IconCheck, IconEditText, IconShield, IconSign } from "./icons";
import { isCoarse, isMac, shortcuts } from "./media";
import { pageSize } from "./pageSize";

/**
 * In the phone's sheet: what the buttons that start a tool call first (it closes the sheet). Its
 * presence also leaves the shortcuts out.
 */
type LeaveSheet = (e: MouseEvent) => void;

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

/**
 * The "Protected" row: what the one-tap download does with the protection (actions.ts,
 * defaultChoice), or null when there is none. A password that cannot protect the copy (whatever
 * the reason: the download options say what to do) is not promised to the copy.
 */
export function protectionText(info: DocInfo): string | null {
  if (info.needsPassword) return info.canKeepPassword ? t("details.protectedPassword") : t("details.protectedNewPassword");
  return info.encrypted ? t("details.protectedRestrictions") : null;
}

/** The PDF/A claim as people write it: "2B" → "PDF/A-2b", "1A" → "PDF/A-1a", "4" → "PDF/A-4". */
function pdfaLabel(claim: string): string {
  return `PDF/A-${claim.replace(/[A-Za-z]+$/, (level) => level.toLowerCase())}`;
}

function DocumentInfo({ doc, leaveSheet }: { doc: OpenDoc; leaveSheet?: LeaveSheet }) {
  const info = doc.info;
  const count = doc.pages.length;
  const page = doc.pages[Math.min(currentPage.value, count - 1)] ?? doc.pages[0];
  const size = page ? pageSize(page.width, page.height) : null;
  const edits = history.value.editCount;
  const edited = dirty.value;
  const stopped = editingStopped.value;
  const protection = protectionText(info);
  const fields = fillableFields(doc);

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
          {info.pdfa && <Row label={t("details.format")}>{pdfaLabel(info.pdfa)}</Row>}
          {protection && <Row label={t("details.protected")}>{protection}</Row>}
          {info.signatures > 0 && <Row label={t("details.signature")}>{t("details.signatureValue")}</Row>}
          {fields && (
            <Row label={t("details.form")}>
              <span class="dp-num">{formCountText(fields.fields, fields.required)}</span>
            </Row>
          )}
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
            <button
              type="button"
              class="btn btn-secondary"
              onClick={(e) => {
                leaveSheet?.(e);
                void setTool("edit");
              }}
            >
              <IconEditText />
              <span>{t("tools.editText")}</span>
            </button>
            <p>{t("details.howToFill")}</p>
            <button
              type="button"
              class="btn btn-secondary"
              onClick={(e) => {
                leaveSheet?.(e);
                void setTool("fill");
              }}
            >
              <IconSign />
              <span>{t("tools.fill")}</span>
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

/** Numbered steps. */
function Steps({ steps }: { steps: string[] }) {
  return (
    <ol class="dp-steps" role="list">
      {steps.map((text, i) => (
        <li key={i} class="dp-step">
          <span class="dp-step-num" aria-hidden="true">{i + 1}</span>
          <span>{text}</span>
        </li>
      ))}
    </ol>
  );
}

/** Modifica with Cambia, nothing open: the steps, the other two sub-tools, the line and image marks. */
function EditSteps() {
  const touch = isCoarse.value;
  const steps = [
    touch ? t("details.step1Touch") : t("details.step1"),
    touch ? t("details.step2Touch") : t("details.step2"),
    t("details.step3"),
  ];
  return (
    <Section title={t("details.editTitle")}>
      <Steps steps={steps} />
      <p class="dp-note">{t("details.editMore")}</p>
      <ul class="dp-legend" role="list">
        <li>
          <span class="dp-swatch is-editable" aria-hidden="true" />
          {t("details.legendEditable")}
        </li>
        <li>
          <span class="dp-swatch is-locked" aria-hidden="true" />
          {t("details.legendLocked")}
        </li>
        <li>
          <span class="dp-swatch is-image" aria-hidden="true" />
          {t("details.legendImage")}
        </li>
        <li>
          <span class="dp-swatch is-image-locked" aria-hidden="true" />
          {t("details.legendImageLocked")}
        </li>
      </ul>
    </Section>
  );
}

/** Modifica with Aggiungi testo, nothing open: how to write, and the mark of the text the user wrote. */
function AddTextSteps() {
  const touch = isCoarse.value;
  const steps = [
    touch ? t("details.addTextStep1Touch") : t("details.addTextStep1"),
    touch ? t("details.addTextStep2Touch") : t("details.addTextStep2"),
    t("details.step3"),
  ];
  return (
    <Section title={t("edit.addText")}>
      <Steps steps={steps} />
      <ul class="dp-legend" role="list">
        <li>
          <span class="dp-swatch is-added" aria-hidden="true" />
          {t("details.legendAdded")}
        </li>
      </ul>
    </Section>
  );
}

/** Fill mode, nothing open: the steps, and the marks of the fields and of the text the user wrote. */
function FillSteps() {
  const steps = [isCoarse.value ? t("details.fillStep1Touch") : t("details.fillStep1"), t("details.fillStep2"), t("details.step3")];
  return (
    <Section title={t("details.fillTitle")}>
      <Steps steps={steps} />
      <ul class="dp-legend" role="list">
        <li>
          <span class="dp-swatch is-field" aria-hidden="true" />
          {t("details.legendField")}
        </li>
        <li>
          <span class="dp-swatch is-field is-required" aria-hidden="true" />
          {t("details.legendRequired")}
        </li>
        <li>
          <span class="dp-swatch is-added" aria-hidden="true" />
          {t("details.legendAdded")}
        </li>
      </ul>
    </Section>
  );
}

/** A field's kind in words: a text field says whether it has several lines or one box per character. */
export function fieldTypeText(field: FieldWidget): string {
  if (field.type === "text" && field.comb) return t("details.fieldType.comb");
  if (field.type === "text" && field.multiline) return t("details.fieldType.multiline");
  return t(`details.fieldType.${field.type}`);
}

/** A text field's length in words: "Up to 1 character", "Up to 16 characters", "No limit". */
export function fieldLengthText(maxLen: number): string {
  if (maxLen <= 0) return t("details.fieldNoLimit");
  return maxLen === 1 ? t("form.maxLenOne") : t("form.maxLen", { count: maxLen });
}

/** The focused field: its label (or its name made readable), type, whether required, maximum length. */
function FieldInfoSection({ field }: { field: FieldWidget }) {
  const label = field.label.trim() || field.name.replace(/[_-]+/g, " ").trim();
  return (
    <Section title={t("details.field")}>
      {label && <p class="dp-quote" dir="auto">{label}</p>}
      <dl class="dp-list">
        <Row label={t("details.fieldType")}>{fieldTypeText(field)}</Row>
        <Row label={t("details.fieldRequired")}>{field.required ? t("details.yes") : t("details.no")}</Row>
        {field.type === "text" && (
          <Row label={t("details.fieldLength")}>
            <span class="dp-num">{fieldLengthText(field.maxLen)}</span>
          </Row>
        )}
      </dl>
      {field.locked && <p class="dp-note">{t("form.readOnly")}</p>}
      {field.scripted && !field.locked && <p class="dp-note">{t("form.calculations")}</p>}
    </Section>
  );
}

/** What the open writer writes with now: its size as its bar says it ("16 pt"), and its ink. */
interface WriterLook {
  size: string;
  color: InkColor;
}

/**
 * The open writer's look, read from its bar (FillLayer's TextWriter; one writer at a time): A−,
 * A+ and the ink buttons change the size and the ink inside the writer until it writes, while
 * `openWriter` keeps what it opened with. Before the bar is there, what it opened with.
 */
function lookOf(writer: OpenWriter): WriterLook {
  const bar = document.querySelector<HTMLElement>(".fill-layer .writer-bar");
  const size = bar?.querySelector(".writer-size")?.textContent?.trim();
  const ink = bar?.querySelector('.writer-ink[aria-pressed="true"]');
  const color: InkColor = ink ? (ink.getAttribute("aria-label") === t("writer.blue") ? "blue" : "black") : writer.color;
  return { size: size || t("writer.size", { size: formatFontSize(writer.size) }), color };
}

/** The open writer's size and ink as its bar shows them, followed as they change. */
function useWriterLook(writer: OpenWriter): WriterLook {
  const [look, setLook] = useState(() => lookOf(writer));
  useEffect(() => {
    const update = () => {
      const next = lookOf(writer);
      setLook((prev) => (prev.size === next.size && prev.color === next.color ? prev : next));
    };
    update();
    const root = viewerScroller();
    if (!root) return;
    const watch = new MutationObserver(update);
    watch.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["aria-pressed"] });
    return () => watch.disconnect();
  }, [writer]);
  return look;
}

/**
 * The open writer: the size and the ink it writes with, as A−/A+ and the ink buttons set them.
 * The size is said when it changes (a polite live region): A−/A+ keep their names.
 */
function WriterInfoSection({ writer }: { writer: OpenWriter }) {
  const look = useWriterLook(writer);
  const color = hexColor(INK[look.color]);
  return (
    <Section title={t("details.writer")}>
      <dl class="dp-list">
        <Row label={t("details.size")}>
          <span class="dp-num" aria-live="polite">{look.size}</span>
        </Row>
        <Row label={t("details.color")}>
          <span class="dp-color">
            {/* The ink's own colour, as written on the page (not a theme colour). */}
            <span class="dp-color-swatch" style={{ background: color }} aria-hidden="true" />
            <span>{look.color === "blue" ? t("writer.blue") : t("writer.black")}</span>
          </span>
        </Row>
      </dl>
    </Section>
  );
}

/**
 * What the details say about the open line's decorations (LineDecorations): what follows its text
 * by itself if it is edited, and the background option ("Underline and link", "Background: your
 * choice"); what stays as it is, and why ("Underline: it's dashed or dotted"). Empty lists when
 * there is nothing to say.
 */
export function decorationFacts(info: LineDecorations): { follows: string[]; stays: string[] } {
  const auto = [
    ...(info.underlines > 0 ? ["underline" as const] : []),
    ...(info.strikes > 0 ? ["strike" as const] : []),
    ...(info.links > 0 ? ["link" as const] : []),
  ];
  const follows: string[] = [];
  if (auto.length) follows.push(upperFirst(listText(decorationNames(auto, true))));
  if (info.box) {
    const kinds = [...(info.box.fill ? ["background" as const] : []), ...(info.box.stroke ? ["border" as const] : [])];
    const what = listText(decorationNames(kinds.length ? kinds : ["background"], true));
    follows.push(upperFirst(t("deco.optional", { what })));
  }
  const stays = distinctLeft(info.left).map(({ kind, reason }) =>
    upperFirst(t("deco.because", { what: decorationNames([kind], true)[0], reason: decorationReasonText(reason) })));
  return { follows, stays };
}

/** The open line's decorations, once the engine has said (editingDecorations): nothing until then. */
function LineDecorationRows({ line }: { line: LineInfo }) {
  const known = editingDecorations.value;
  const open = editingLine.value;
  if (!known || !open || known.pageIndex !== open.pageIndex || known.lineIndex !== line.index) return null;
  const { follows, stays } = decorationFacts(known.info);
  return (
    <>
      {follows.length > 0 && (
        <Row label={t("deco.follows")}>
          {follows.map((text) => <span key={text}>{text}</span>)}
        </Row>
      )}
      {stays.length > 0 && (
        <Row label={t("deco.stays")}>
          {stays.map((text) => <span key={text}>{text}</span>)}
        </Row>
      )}
    </>
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
        <LineDecorationRows line={line} />
      </dl>
      <p class="dp-note">{t("details.wholeLine")}</p>
    </Section>
  );
}

/** What the panel says about an image: its size on the page, its pixels and resolution, its rotation. */
export function imageFacts(image: ImageInfo): { size: string; pixels: string; rotation: string } {
  const { width, height } = sides(image.matrix);
  return {
    size: t("details.imageSizeValue", { w: formatMm(width), h: formatMm(height) }),
    pixels: t("details.imagePixelsValue", {
      w: image.pixelWidth, h: image.pixelHeight, ppi: Math.round(ppi(image.pixelWidth, width)),
    }),
    rotation: t("details.imageRotationValue", { deg: Math.round(rotationDeg(image.matrix)) % 360 }),
  };
}

/**
 * How to move, resize and rotate the selected image. By touch (a large tablet shows the panel
 * too) dragging the picture scrolls the page: the round grip moves it. The grip and the knob are
 * named, not placed: the frame puts the grip in the middle of the picture or below a small one,
 * and the knob above or below it (ImageLayer's frameLayout), so the words hold for every case.
 */
export function imageHint(image: ImageInfo, touch: boolean): string {
  if (!image.movable) return t("details.imageLocked", { reason: lockReasonText(image.reason) });
  return touch ? t("details.imageHintTouch") : t("details.imageHint");
}

function ImageInfoSection({ image }: { image: ImageInfo }) {
  const facts = imageFacts(image);
  return (
    <Section title={t("details.image")}>
      <dl class="dp-list">
        <Row label={t("details.imageSize")}>
          <span class="dp-num">{facts.size}</span>
        </Row>
        <Row label={t("details.imagePixels")}>
          <span class="dp-num">{facts.pixels}</span>
        </Row>
        <Row label={t("details.imageRotation")}>
          <span class="dp-num">{facts.rotation}</span>
        </Row>
      </dl>
      <p class="dp-note">{imageHint(image, isCoarse.value)}</p>
    </Section>
  );
}

/**
 * The selected image as its page's current image list has it. While that list is read again
 * after an edit of the image, the last one known for the same selection, so the section does
 * not blink away after every move.
 */
function useSelectedImage(doc: OpenDoc, sel: SelectedImage | null): ImageInfo | null {
  const last = useRef<{ doc: OpenDoc; pageIndex: number; image: ImageInfo } | null>(null);
  const page = sel ? doc.pages[sel.pageIndex] : undefined;
  if (!sel || !page) {
    last.current = null;
    return null;
  }
  const cached = page.images.value;
  if (cached && cached.rev === page.rev.value) {
    const image = cached.images.find((i) => i.index === sel.index) ?? null;
    last.current = image && { doc, pageIndex: sel.pageIndex, image };
    return image;
  }
  const kept = last.current;
  return kept && kept.doc === doc && kept.pageIndex === sel.pageIndex && kept.image.index === sel.index ? kept.image : null;
}

/**
 * The focused form field as its page's current field list has it. While that list is read again
 * after an edit, the last one known for the same field, so the section does not blink away.
 */
function useFocusedField(doc: OpenDoc, focus: { pageIndex: number; name: string; index: number } | null): FieldWidget | null {
  const last = useRef<{ doc: OpenDoc; pageIndex: number; field: FieldWidget } | null>(null);
  const page = focus ? doc.pages[focus.pageIndex] : undefined;
  if (!focus || !page) {
    last.current = null;
    return null;
  }
  const cached = page.fields.value;
  if (cached && cached.rev === page.rev.value) {
    const field = cached.fields.find((w) => w.index === focus.index && w.name === focus.name) ?? null;
    last.current = field && { doc, pageIndex: focus.pageIndex, field };
    return field;
  }
  const kept = last.current;
  return kept && kept.doc === doc && kept.pageIndex === focus.pageIndex && kept.field.name === focus.name ? kept.field : null;
}

/**
 * Fill mode's keys, and the writer's in Modifica too: Enter writes (or applies), Shift+Enter
 * writes and starts the line below, Esc cancels the writer, or the signature waiting to be placed,
 * or leaves Fill mode; Tab goes to the next field, except in the writer, where it goes to the
 * writer's own bar.
 */
export function fillShortcuts(state: "writer" | "pending" | "idle"): [key: string, action: string][] {
  const esc = state === "writer" ? t("shortcut.cancelWriter") : state === "pending" ? t("common.cancel") : t("shortcut.exitFill");
  const keys: [key: string, action: string][] = [
    [t("key.enter"), t("shortcut.write")],
    [`Shift + ${t("key.enter")}`, t("writer.newLine")],
    [t("key.esc"), esc],
  ];
  if (state !== "writer") keys.push([t("key.tab"), t("shortcut.nextField")]);
  return keys;
}

/** The keys of the selected image's frame (ImageLayer). Alt is Option (⌥) on a Mac keyboard. */
export function imageShortcuts(): [key: string, action: string][] {
  return [
    ["←↑→↓", t("shortcut.nudge")],
    ["Shift + ←↑→↓", t("shortcut.nudgeFar")],
    [`${isMac ? "⌥" : "Alt"} + ←↑→↓`, t("shortcut.stretchImage")],
    ["+ / −", t("shortcut.scaleImage")],
    [", / .", t("shortcut.turnImage")],
    [t("key.delete"), t("shortcut.deleteImage")],
    [t("key.esc"), t("shortcut.deselect")],
  ];
}

/**
 * Modifica with Aggiungi testo, no writer open: the writer's Enter and Shift+Enter (Enter on the
 * page region opens one in the middle of what shows), and Esc goes back to Cambia. No Tab:
 * Modifica has no form fields. With the writer open, its keys are Fill mode's (fillShortcuts).
 */
export function addTextShortcuts(): [key: string, action: string][] {
  return [
    [t("key.enter"), t("shortcut.write")],
    [`Shift + ${t("key.enter")}`, t("writer.newLine")],
    [t("key.esc"), t("shortcut.backToChange")],
  ];
}

type ShortcutFocus = "edit" | "line" | "image" | "addText" | "fill" | "writer" | "pending" | "field";

function shortcutRows(focus: ShortcutFocus): [key: string, action: string][] {
  switch (focus) {
    case "image": return imageShortcuts();
    case "addText": return addTextShortcuts();
    case "fill": return fillShortcuts("idle");
    case "writer": return fillShortcuts("writer");
    case "pending": return fillShortcuts("pending");
    case "field": return [[t("key.tab"), t("shortcut.nextField")], [`Shift + ${t("key.tab")}`, t("shortcut.prevField")]];
    case "edit":
    case "line":
      return [
        [t("key.enter"), t("shortcut.apply")],
        [t("key.esc"), focus === "line" ? t("shortcut.cancel") : t("shortcut.exitEdit")],
      ];
  }
}

/**
 * The keys of what is going on: Enter/Esc for the line editor (Esc leaves Modifica when no line
 * is open), the selected image's keys, Aggiungi testo's, Fill mode's keys or a field's; then
 * history and save.
 */
function Shortcuts({ focus }: { focus: ShortcutFocus }) {
  const rows = shortcutRows(focus);
  rows.push(
    [shortcuts.undo, t("shortcut.undo")],
    [shortcuts.redo, t("shortcut.redo")],
    [shortcuts.save, t("shortcut.download")],
  );
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

interface ToolDetailsProps {
  image: ImageInfo | null;
  selected: boolean;
  /** The shortcuts are shown (not in the phone's sheet). */
  keys: boolean;
}

/**
 * Modifica. With Cambia: the open line, else the selected image, else the steps. With Aggiungi
 * testo: the open writer, else the selected picture the user added, else the steps for writing.
 */
function EditDetails({ line, image, selected, keys }: ToolDetailsProps & { line: LineInfo | null }) {
  if (writerOn.value) {
    const writer = openWriter.value;
    return (
      <>
        {writer ? <WriterInfoSection writer={writer} /> : image ? <ImageInfoSection image={image} /> : <AddTextSteps />}
        {keys && <Shortcuts focus={writer ? "writer" : selected ? "image" : "addText"} />}
      </>
    );
  }
  return (
    <>
      {line ? <LineInfoSection line={line} /> : image ? <ImageInfoSection image={image} /> : <EditSteps />}
      {keys && <Shortcuts focus={line ? "line" : selected ? "image" : "edit"} />}
    </>
  );
}

/** Fill mode: the writer, else the focused field, else the selected picture, else the steps. */
function FillDetails({ doc, image, selected, keys }: ToolDetailsProps & { doc: OpenDoc }) {
  const writer = openWriter.value;
  const field = useFocusedField(doc, writer ? null : focusedField.value);
  const pending = pendingPlacement.value !== null;
  const focus: ShortcutFocus = writer ? "writer" : field ? "field" : selected ? "image" : pending ? "pending" : "fill";
  return (
    <>
      {writer
        ? <WriterInfoSection writer={writer} />
        : field
        ? <FieldInfoSection field={field} />
        : image
        ? <ImageInfoSection image={image} />
        : <FillSteps />}
      {keys && <Shortcuts focus={focus} />}
    </>
  );
}

/** Browsing: the document's facts, or the focused field's (its fields work without a tool, D2). */
function BrowseDetails({ doc, leaveSheet }: { doc: OpenDoc; leaveSheet?: LeaveSheet }) {
  const field = useFocusedField(doc, focusedField.value);
  if (!field) return <DocumentInfo doc={doc} leaveSheet={leaveSheet} />;
  return (
    <>
      <FieldInfoSection field={field} />
      {!leaveSheet && <Shortcuts focus="field" />}
    </>
  );
}

/**
 * What the details say, in either frame: the docked panel, or the phone's sheet (`leaveSheet`
 * set: no shortcuts, and the buttons that start a tool close the sheet first).
 */
export function DetailsContent({ doc, leaveSheet }: { doc: OpenDoc; leaveSheet?: LeaveSheet }) {
  const current = tool.value;
  const editing = current === "edit";
  const line = editing ? editingLine.value?.line ?? null : null;
  // Fill mode and Aggiungi testo select only the pictures the user added (signatures, photos),
  // with the same frame.
  const selected = (editing && !line) || current === "fill" ? selectedImage.value : null;
  const image = useSelectedImage(doc, selected);
  const keys = !leaveSheet;

  if (editing) return <EditDetails line={line} image={image} selected={selected !== null} keys={keys} />;
  if (current === "fill") return <FillDetails doc={doc} image={image} selected={selected !== null} keys={keys} />;
  return <BrowseDetails doc={doc} leaveSheet={leaveSheet} />;
}

/**
 * The details panel in the desktop layout, docked in its own column at every width. app.tsx mounts
 * it while it is open; the rail's button points at it (aria-controls), hence the fixed id. That
 * button closes it, with the focus on the button. It also goes when the window crosses 1200 px
 * with no choice remembered, when the layout goes to phone, and when another document opens: if
 * the focus was inside it, the focus goes to the document, never to <body>.
 */
export function DetailsPanel({ doc }: { doc: OpenDoc }) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    return () => {
      if (el?.contains(document.activeElement)) rescueFocus(viewerScroller);
    };
  }, []);
  return (
    <aside ref={ref} class="details-panel" id="details-panel" aria-label={t("details.label")}>
      <DetailsContent doc={doc} />
    </aside>
  );
}
