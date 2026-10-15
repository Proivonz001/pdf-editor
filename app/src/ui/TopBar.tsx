// Top bar, in three forms:
// - no document (desktop and phone): the brand, then "Update available" and the language switch;
// - desktop with a document: brand, file chip (name and "Edited"), Undo/Redo, zoom, Open,
//   Share, Download PDF, Update and a "More" menu (language, source code, close document);
// - phone with a document: Back (closes it), the file name over "Page n of m · Edited",
//   Undo, Redo and Download. Zoom, share, language, update and open live in the phone "More"
//   sheet (PhoneSheets), editing in the tab bar.
// Width budget of the desktop bar (nothing may overflow at 640 px, with 44 px buttons on touch
// screens, and the file name must stay readable): below 768 px the zoom controls move into the
// More menu (pinch and Ctrl + wheel still zoom). Share and Update stay in the bar from 1024 px,
// or from 768 px with a mouse (Share is only offered on touch screens anyway); otherwise they
// move into More too, which then carries the update badge. shell.css does the
// rest (app name from 900 px, "Edited" as a dot below 900 px). After the engine lost the
// document ("broken"), Undo and Redo stay off; Download still works.
import { computed } from "@preact/signals";
import { LOCALE_NAMES, otherLocale, t, toggleLocale } from "../i18n";
import { SOURCE_URL } from "../links";
import { updateInstalled, updateReady } from "../platform/pwa";
import { busy, currentPage, dirty, doc, editingStopped, fitMode, history, zoom } from "../state";
import { MAX_ZOOM, MIN_ZOOM } from "../viewer/layout";
import { fitWidth, zoomIn, zoomOut } from "../viewer/zoom";
import { closeDocument, download, redo, share, undo, updateApp } from "./actions";
import { ToolButton } from "./Button";
import { openFilePicker } from "./filePicker";
import {
  IconBack, IconClose, IconCode, IconDownload, IconFitWidth, IconGlobe, IconMore, IconOpen, IconRedo, IconShare,
  IconUndo, IconUpdate, IconZoomIn, IconZoomOut,
} from "./icons";
import { Logo } from "./Logo";
import { canSharePdf, hasZoomRoom, isCoarse, isNarrow, isRoomy, isWide, shortcuts } from "./media";
import { MenuButton, type MenuItem } from "./Menu";

/** Room for Share and Update too: from 1024 px, or from 768 px with 36 px (mouse) buttons. */
const extrasInBar = computed(() => isRoomy.value || (hasZoomRoom.value && !isCoarse.value));

function Brand() {
  return (
    <div class="topbar-brand">
      <Logo size={26} />
      <span class="app-name">{t("app.name")}</span>
    </div>
  );
}

function LanguageButton() {
  const next = otherLocale();
  return (
    <button type="button" class="btn tool has-label lang-btn" title={t("lang.tip")}
      aria-label={`${t("lang.tip")}: ${LOCALE_NAMES[next]}`} onClick={toggleLocale}>
      <IconGlobe />
      <span class="btn-label" lang={next}>{LOCALE_NAMES[next]}</span>
    </button>
  );
}

function UpdateButton({ compact }: { compact: boolean }) {
  return (
    <ToolButton
      icon={<IconUpdate />}
      label={t("toolbar.update")}
      tip={updateInstalled.value ? t("toolbar.updateInstalledTip") : t("toolbar.updateTip")}
      showLabel={!compact}
      variant="accent"
      onClick={() => void updateApp()}
    />
  );
}

function UndoRedo() {
  const h = history.value;
  const stopped = editingStopped.value;
  return (
    <div class="topbar-group">
      <ToolButton icon={<IconUndo />} label={t("toolbar.undo")} tip={t("toolbar.undoTip", { shortcut: shortcuts.undo })}
        disabled={stopped || (!h.canUndo && busy.value !== "edit")} onClick={() => void undo()} />
      <ToolButton icon={<IconRedo />} label={t("toolbar.redo")} tip={t("toolbar.redoTip", { shortcut: shortcuts.redo })}
        disabled={stopped || !h.canRedo} onClick={() => void redo()} />
    </div>
  );
}

function DownloadButton({ showLabel }: { showLabel: boolean }) {
  return (
    <ToolButton icon={<IconDownload />} label={t("toolbar.downloadPdf")}
      tip={t("toolbar.downloadTip", { shortcut: shortcuts.save })} showLabel={showLabel} variant="primary"
      disabled={busy.value === "save"} onClick={() => void download()} />
  );
}

/** Phone: the file name over "Page n of m · ● Edited". */
function PhoneTitle({ fileName, page, count }: { fileName: string; page: number; count: number }) {
  const edited = dirty.value;
  const pageLabel = t("viewer.indicatorLabel", { page, count });
  return (
    <div class="topbar-doc">
      <h1 class="file-name" title={fileName}>{fileName}</h1>
      <p class={edited ? "topbar-sub is-edited" : "topbar-sub"}>
        <span class="topbar-page">{pageLabel}</span>
        {/* Small phones, with "Edited" next to it: the short "12 / 220" instead (shell.css). */}
        <span class="topbar-page-short">
          <span class="sr-only">{pageLabel}</span>
          <span aria-hidden="true">{t("viewer.indicator", { page, count })}</span>
        </span>
        {edited && (
          <>
            <span class="topbar-sub-sep" aria-hidden="true">·</span>
            <span class="topbar-edited" title={t("toolbar.unsaved")}>
              <span class="edited-dot" aria-hidden="true" />
              <span class="topbar-edited-text">{t("toolbar.edited")}</span>
            </span>
          </>
        )}
      </p>
    </div>
  );
}

export function TopBar() {
  const d = doc.value;
  const narrow = isNarrow.value;
  const update = updateReady.value;

  if (!d) {
    return (
      <header class="topbar">
        <Brand />
        <div class="topbar-spacer" />
        <div class="topbar-tools">
          {update && <UpdateButton compact={narrow} />}
          <LanguageButton />
        </div>
      </header>
    );
  }

  if (narrow) {
    const count = d.pages.length;
    const page = Math.min(currentPage.value, count - 1) + 1;
    return (
      <header class="topbar">
        <ToolButton icon={<IconBack />} label={t("toolbar.close")} onClick={() => void closeDocument()} />
        <PhoneTitle fileName={d.fileName} page={page} count={count} />
        <UndoRedo />
        <DownloadButton showLabel={false} />
      </header>
    );
  }

  const z = zoom.value;
  const percent = `${Math.round(z * 100)}%`;
  const zoomShown = hasZoomRoom.value;
  const extrasShown = extrasInBar.value;
  const shareable = canSharePdf();
  const edited = dirty.value;
  const next = otherLocale();

  // The menu holds what the bar has no room for, between the language and the source link.
  const items: MenuItem[] = [
    { key: "lang", label: LOCALE_NAMES[next], lang: next, icon: <IconGlobe />, onSelect: toggleLocale },
  ];
  if (!zoomShown) {
    items.push(
      { key: "zoom-out", label: t("toolbar.zoomOut"), icon: <IconZoomOut />, onSelect: zoomOut, disabled: z <= MIN_ZOOM },
      { key: "zoom-in", label: t("toolbar.zoomIn"), icon: <IconZoomIn />, onSelect: zoomIn, disabled: z >= MAX_ZOOM },
      { key: "fit", label: t("toolbar.fitWidth"), icon: <IconFitWidth />, onSelect: fitWidth, detail: percent },
    );
  }
  if (!extrasShown && shareable) {
    items.push({ key: "share", label: t("toolbar.share"), icon: <IconShare />, onSelect: () => void share() });
  }
  if (!extrasShown && update) {
    items.push({ key: "update", label: t("toolbar.update"), icon: <IconUpdate />, onSelect: () => void updateApp() });
  }
  items.push(
    {
      key: "source", label: t("toolbar.source"), icon: <IconCode />,
      onSelect: () => void window.open(SOURCE_URL, "_blank", "noopener,noreferrer"),
    },
    { key: "close", label: t("toolbar.close"), icon: <IconClose />, onSelect: () => void closeDocument(), divider: true },
  );

  return (
    <header class="topbar">
      <Brand />
      <div class={edited ? "file-chip is-edited" : "file-chip"}>
        <h1 class="file-name" title={d.fileName}>{d.fileName}</h1>
        {edited && (
          <span class="edited-pill" title={t("toolbar.unsaved")}>
            <span class="edited-pill-text">{t("toolbar.edited")}</span>
          </span>
        )}
      </div>
      <div class="topbar-spacer" />
      <div class="topbar-tools">
        <UndoRedo />
        <span class="topbar-sep" aria-hidden="true" />
        {zoomShown && (
          <>
            <div class="topbar-group" role="group" aria-label={t("more.zoom")}>
              <ToolButton icon={<IconZoomOut />} label={t("toolbar.zoomOut")}
                tip={t("toolbar.zoomOutTip", { shortcut: shortcuts.zoomOut })} disabled={z <= MIN_ZOOM} onClick={zoomOut} />
              <output class="zoom-value" aria-label={t("toolbar.zoomValue", { percent })}>{percent}</output>
              <ToolButton icon={<IconZoomIn />} label={t("toolbar.zoomIn")}
                tip={t("toolbar.zoomInTip", { shortcut: shortcuts.zoomIn })} disabled={z >= MAX_ZOOM} onClick={zoomIn} />
              <ToolButton icon={<IconFitWidth />} label={t("toolbar.fitWidth")}
                tip={t("toolbar.fitWidthTip", { shortcut: shortcuts.fit })} pressed={fitMode.value} onClick={fitWidth} />
            </div>
            <span class="topbar-sep" aria-hidden="true" />
          </>
        )}
        <div class="topbar-group topbar-actions">
          <ToolButton icon={<IconOpen />} label={t("toolbar.open")} tip={t("toolbar.openTip", { shortcut: shortcuts.open })}
            showLabel={isRoomy.value} variant="secondary" onClick={openFilePicker} />
          {extrasShown && shareable && (
            <ToolButton icon={<IconShare />} label={t("toolbar.share")} onClick={() => void share()} />
          )}
          <DownloadButton showLabel />
          {extrasShown && update && <UpdateButton compact={!isWide.value} />}
        </div>
        <MenuButton label={t("toolbar.more")} icon={<IconMore />} items={items} badge={update && !extrasShown} />
      </div>
    </header>
  );
}
