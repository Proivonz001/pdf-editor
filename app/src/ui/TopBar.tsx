// Top bar. Wide screens: file name, Open, Undo/Redo, zoom, Edit text, Download, language and
// "Update available". Phones (< 640 px): one row of icon buttons, with zoom, share, language
// and update moved into a "More" menu, so the bar never wraps into a tall block. After the
// engine lost a document ("broken"), Edit text, Undo and Redo stay off; Download still works.
import { LOCALE_NAMES, otherLocale, t, toggleLocale } from "../i18n";
import { updateInstalled, updateReady } from "../platform/pwa";
import { busy, dirty, doc, editingLine, editingStopped, editMode, fitMode, history, zoom } from "../state";
import { fitWidth, zoomIn, zoomOut } from "../viewer/zoom";
import { MAX_ZOOM, MIN_ZOOM } from "../viewer/layout";
import { download, redo, share, undo, updateApp } from "./actions";
import { ToolButton } from "./Button";
import { openFilePicker } from "./filePicker";
import {
  IconDownload, IconEditText, IconFitWidth, IconGlobe, IconMore, IconOpen, IconRedo, IconShare, IconUndo,
  IconUpdate, IconZoomIn, IconZoomOut,
} from "./icons";
import { canSharePdf, isNarrow, shortcuts } from "./media";
import { MenuButton, type MenuItem } from "./Menu";

function toggleEditMode() {
  editingLine.value = null;
  editMode.value = !editMode.value;
}

function LanguageButton() {
  const next = otherLocale();
  return (
    <button type="button" class="btn tool has-label lang-btn" title={t("lang.tip")}
      aria-label={`${t("lang.tip")}: ${LOCALE_NAMES[next]}`} onClick={toggleLocale}>
      <IconGlobe />
      <span class="btn-label lang-label" lang={next}>{LOCALE_NAMES[next]}</span>
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

export function TopBar() {
  const d = doc.value;
  const narrow = isNarrow.value;
  const update = updateReady.value;

  if (!d) {
    return (
      <header class="topbar">
        <div class="topbar-title">
          <span class="app-name">{t("app.name")}</span>
        </div>
        <div class="tools">
          {update && <UpdateButton compact={narrow} />}
          <LanguageButton />
        </div>
      </header>
    );
  }

  const h = history.value;
  const working = busy.value;
  const stopped = editingStopped.value;
  const z = zoom.value;
  const percent = `${Math.round(z * 100)}%`;
  const shareable = canSharePdf();

  const fileTitle = (
    <div class="topbar-title">
      <h1 class="file-name" title={d.fileName}>{d.fileName}</h1>
      {dirty.value && <span class="dirty-dot" role="img" aria-label={t("toolbar.unsaved")} title={t("toolbar.unsaved")} />}
    </div>
  );
  const openBtn = (
    <ToolButton icon={<IconOpen />} label={t("toolbar.open")} tip={t("toolbar.openTip", { shortcut: shortcuts.open })}
      showLabel={!narrow} onClick={openFilePicker} />
  );
  const undoBtn = (
    <ToolButton icon={<IconUndo />} label={t("toolbar.undo")} tip={t("toolbar.undoTip", { shortcut: shortcuts.undo })}
      disabled={stopped || (!h.canUndo && working !== "edit")} onClick={() => void undo()} />
  );
  const redoBtn = (
    <ToolButton icon={<IconRedo />} label={t("toolbar.redo")} tip={t("toolbar.redoTip", { shortcut: shortcuts.redo })}
      disabled={stopped || !h.canRedo} onClick={() => void redo()} />
  );
  const editBtn = (
    <ToolButton icon={<IconEditText />} label={t("toolbar.editText")} tip={t("toolbar.editTextTip")}
      showLabel={!narrow} pressed={editMode.value} disabled={stopped} onClick={toggleEditMode} />
  );
  const downloadBtn = (
    <ToolButton icon={<IconDownload />} label={t("toolbar.download")}
      tip={t("toolbar.downloadTip", { shortcut: shortcuts.save })} showLabel={!narrow} variant="primary"
      disabled={working === "save"} onClick={() => void download()} />
  );

  if (narrow) {
    const items: MenuItem[] = [
      { key: "zoom-out", label: t("toolbar.zoomOut"), icon: <IconZoomOut />, onSelect: zoomOut, disabled: z <= MIN_ZOOM },
      { key: "zoom-in", label: t("toolbar.zoomIn"), icon: <IconZoomIn />, onSelect: zoomIn, disabled: z >= MAX_ZOOM },
      { key: "fit", label: t("toolbar.fitWidth"), icon: <IconFitWidth />, onSelect: fitWidth, detail: percent },
    ];
    if (shareable) items.push({ key: "share", label: t("toolbar.share"), icon: <IconShare />, onSelect: () => void share() });
    const next = otherLocale();
    items.push({ key: "lang", label: LOCALE_NAMES[next], lang: next, icon: <IconGlobe />, onSelect: toggleLocale });
    if (update) items.push({ key: "update", label: t("toolbar.update"), icon: <IconUpdate />, onSelect: () => void updateApp() });
    return (
      <header class="topbar is-narrow">
        {openBtn}
        {fileTitle}
        <div class="tools">
          {undoBtn}
          {redoBtn}
          {editBtn}
          {downloadBtn}
          <MenuButton label={t("toolbar.more")} icon={<IconMore />} items={items} badge={update} />
        </div>
      </header>
    );
  }

  return (
    <header class="topbar">
      {fileTitle}
      <div class="tools">
        {openBtn}
        <span class="sep" aria-hidden="true" />
        {undoBtn}
        {redoBtn}
        <span class="sep" aria-hidden="true" />
        <ToolButton icon={<IconZoomOut />} label={t("toolbar.zoomOut")}
          tip={t("toolbar.zoomOutTip", { shortcut: shortcuts.zoomOut })} disabled={z <= MIN_ZOOM} onClick={zoomOut} />
        <output class="zoom-value" aria-label={t("toolbar.zoomValue", { percent })}>{percent}</output>
        <ToolButton icon={<IconZoomIn />} label={t("toolbar.zoomIn")}
          tip={t("toolbar.zoomInTip", { shortcut: shortcuts.zoomIn })} disabled={z >= MAX_ZOOM} onClick={zoomIn} />
        <ToolButton icon={<IconFitWidth />} label={t("toolbar.fitWidth")}
          tip={t("toolbar.fitWidthTip", { shortcut: shortcuts.fit })} pressed={fitMode.value} onClick={fitWidth} />
        <span class="sep" aria-hidden="true" />
        {editBtn}
        {shareable && <ToolButton icon={<IconShare />} label={t("toolbar.share")} onClick={() => void share()} />}
        {downloadBtn}
        {update && <UpdateButton compact={false} />}
        <LanguageButton />
      </div>
    </header>
  );
}
