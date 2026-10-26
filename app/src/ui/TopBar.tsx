// Top bar, in three forms:
// - no document (desktop and phone): the brand, then "Update available" and the language switch;
// - desktop with a document: brand, file chip (name and "Edited"), Undo/Redo, zoom, Open,
//   Share, Download PDF (a split button: the one-tap download, and a chevron that opens the
//   download options), Update and a "More" menu (language, "Install the app" where it can be
//   installed and is not yet, what the bar has no room for, the signatures saved on this device
//   when there are any, "Elimina pagina N" for the page shown, source code, close document);
// - phone with a document: Back (closes it), the file name over "Page n of m · Edited", Cerca's
//   magnifier, Undo, Redo and Download. Zoom, share, the download options, language, update and
//   open live in the phone "More" sheet (PhoneSheets), editing in the tab bar. While the search is
//   open it takes the bar's place (ui/search/SearchBar.tsx, PhoneSearch); the hidden field that
//   holds the keyboard for it stays first in the bar in both, so it is the same element throughout.
// Width budget of the desktop bar (nothing may overflow from 640 px, with 44 px buttons on touch
// screens, and the file name must stay readable): below 768 px the zoom controls move into the
// More menu (pinch and Ctrl + wheel still zoom). Share and Update stay in the bar from 1024 px,
// or from 768 px with a mouse (Share is only offered on touch screens anyway); otherwise they
// move into More too, which then carries the update badge. On touch screens the tightest case is
// not 640 px but 768 px, where the zoom group comes back with 44 px buttons and the chevron:
// there Open moves into More as well (below 1024 px), and it keeps its label only from 1200 px
// (at 1024 px Share, Update and "Modificato" need the room). shell.css does the rest (app name
// from 900 px, "Edited" as a dot below 900 px). After the engine lost the document ("broken"),
// Undo and Redo stay off; Download still works. While a download runs, its two buttons stay
// focusable but do nothing (aria-disabled), so the focus is still there after its questions.
import { computed } from "@preact/signals";
import { LOCALE_NAMES, otherLocale, t, toggleLocale } from "../i18n";
import { SOURCE_URL } from "../links";
import { canOfferInstall } from "../platform/install";
import { updateInstalled, updateReady } from "../platform/pwa";
import {
  busy, currentPage, dirty, doc, downloadRunning, editingStopped, fitMode, history, savedSignatures, zoom,
} from "../state";
import { MAX_ZOOM, MIN_ZOOM } from "../viewer/layout";
import { fitWidth, zoomIn, zoomOut } from "../viewer/zoom";
import { closeDocument, download, openDownloadOptions, openInstall, redo, share, undo, updateApp } from "./actions";
import { ToolButton } from "./Button";
import { openFilePicker } from "./filePicker";
import { openSavedSignatures, savedKind } from "./fill/FillBar";
import {
  IconBack, IconChevronDown, IconClose, IconCode, IconDownload, IconFitWidth, IconGlobe, IconInstall, IconMore,
  IconOpen, IconRedo, IconShare, IconSignature, IconTrash, IconUndo, IconUpdate, IconZoomIn, IconZoomOut,
} from "./icons";
import { Logo } from "./Logo";
import { canSharePdf, hasZoomRoom, isCoarse, isNarrow, isRoomy, isWide, shortcuts } from "./media";
import { MenuButton, type MenuItem } from "./Menu";
import { deletePages, deleteShown } from "./organizer/commands";
import { PhoneSearch, SearchKeeper, SearchToggle } from "./search/SearchBar";
import { searchOpen } from "./search/state";

/** Room for Share and Update too: from 1024 px, or from 768 px with 36 px (mouse) buttons. */
const extrasInBar = computed(() => isRoomy.value || (hasZoomRoom.value && !isCoarse.value));
/** Open in the bar: always with a mouse; with 44 px touch buttons only from 1024 px. */
const openInBar = computed(() => isRoomy.value || !isCoarse.value);
/** Open with its label: from 1024 px with a mouse, from 1200 px on touch screens. */
const openLabelled = computed(() => isWide.value || (isRoomy.value && !isCoarse.value));

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

/**
 * A download is under way (its check, questions, save dialog, or the wait behind an edit), or
 * the engine is writing one: no second download, and no options, meanwhile.
 */
const saving = computed(() => downloadRunning.value || busy.value === "save" || busy.value === "check");

/**
 * Download PDF, the one-tap download. A ToolButton in all but one thing: while `saving` it is
 * aria-disabled rather than disabled, so it keeps the focus (a disabled button would drop it to
 * <body>, and the PDF/A questions would give it back there).
 */
function DownloadButton({ showLabel, class: cls }: { showLabel: boolean; class?: string }) {
  const label = t("toolbar.downloadPdf");
  const classes = ["btn tool btn-primary", showLabel && "has-label", cls].filter(Boolean).join(" ");
  return (
    <button type="button" class={classes} aria-label={label} title={t("toolbar.downloadTip", { shortcut: shortcuts.save })}
      aria-disabled={saving.value || undefined} onClick={() => { if (!saving.peek()) void download(); }}>
      <IconDownload />
      {showLabel && <span class="btn-label" aria-hidden="true">{label}</span>}
    </button>
  );
}

/**
 * Desktop: Download PDF (one tap) joined to a chevron that opens "How do you want to download
 * it?". One shape, two real buttons, each with its own name; both aria-disabled while saving.
 */
function SplitDownload() {
  const label = t("toolbar.downloadOptions");
  return (
    <div class="split-btn">
      <DownloadButton showLabel class="split-main" />
      <button type="button" class="btn btn-primary split-more" aria-label={label} title={label}
        aria-haspopup="dialog" aria-disabled={saving.value || undefined}
        onClick={() => { if (!saving.peek()) openDownloadOptions(); }}>
        <IconChevronDown />
      </button>
    </div>
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
    if (searchOpen.value) {
      return (
        <header class="topbar is-search">
          <SearchKeeper key="keeper" />
          <PhoneSearch />
        </header>
      );
    }
    const count = d.pages.length;
    const page = Math.min(currentPage.value, count - 1) + 1;
    return (
      <header class="topbar">
        <SearchKeeper key="keeper" />
        <ToolButton icon={<IconBack />} label={t("toolbar.close")} onClick={() => void closeDocument()} />
        <PhoneTitle fileName={d.fileName} page={page} count={count} />
        <SearchToggle />
        <UndoRedo />
        <DownloadButton showLabel={false} />
      </header>
    );
  }

  const z = zoom.value;
  const percent = `${Math.round(z * 100)}%`;
  const zoomShown = hasZoomRoom.value;
  const extrasShown = extrasInBar.value;
  const openShown = openInBar.value;
  const shareable = canSharePdf();
  const edited = dirty.value;
  const next = otherLocale();

  // The menu holds what the bar has no room for, between the language (and "Install the app")
  // and the source link.
  const items: MenuItem[] = [
    { key: "lang", label: LOCALE_NAMES[next], lang: next, icon: <IconGlobe />, onSelect: toggleLocale },
  ];
  if (canOfferInstall.value) {
    items.push({ key: "install", label: t("install.button"), icon: <IconInstall />, onSelect: () => void openInstall() });
  }
  if (!openShown) {
    items.push({ key: "open", label: t("toolbar.open"), icon: <IconOpen />, onSelect: openFilePicker });
  }
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
  const saved = savedSignatures.value;
  if (saved.length) {
    items.push({
      key: "signatures", label: t("more.savedSignatures", { count: saved.length }), icon: <IconSignature />,
      onSelect: () => void openSavedSignatures(savedKind(saved)),
    });
  }
  const del = deleteShown(d);
  items.push(
    { key: "delete-page", label: del.label, icon: <IconTrash />, reason: del.reason, onSelect: () => void deletePages([del.page]) },
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
          {openShown && (
            <ToolButton icon={<IconOpen />} label={t("toolbar.open")} tip={t("toolbar.openTip", { shortcut: shortcuts.open })}
              showLabel={openLabelled.value} variant="secondary" onClick={openFilePicker} />
          )}
          {extrasShown && shareable && (
            <ToolButton icon={<IconShare />} label={t("toolbar.share")} onClick={() => void share()} />
          )}
          <SplitDownload />
          {extrasShown && update && <UpdateButton compact={!isWide.value} />}
        </div>
        <MenuButton label={t("toolbar.more")} icon={<IconMore />} items={items} badge={update && !extrasShown} />
      </div>
    </header>
  );
}
