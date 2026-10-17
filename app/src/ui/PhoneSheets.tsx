// Phone bottom sheets, driven by the `sheet` signal: "pages" (the thumbnail grid; picking a page
// closes it), "more" (open another PDF, share, download with options, details, zoom, the
// signatures saved on this device when there are any, "Install the app" where it can be installed
// and is not yet, language, update, close document, then the privacy note and the source link)
// and "details" (what the desktop's details panel says, live,
// without the shortcuts). On phones they stand in for the desktop's thumbnails panel, zoom
// controls, More menu, the chevron of the Download button and the details panel. Styled by
// styles/phone.css (.sheet-pages, .sheet-more) and styles/details.css (.sheet-details).
//
// Open, Share, Download with options, Saved signatures, Install the app and Close document close
// the sheet first: they lead somewhere else (the file picker, the share sheet, the download
// options sheet, the signature chooser, the install steps or the browser's own install dialog,
// the home page). Details swaps the More sheet for the details sheet, whose
// Edit and Fill & sign buttons close it before starting their tool. Zoom, language and update
// keep the More sheet open, so their effect shows behind it (an update that needs a
// confirmation asks above it).
import type { ComponentChildren } from "preact";
import { useEffect, useId } from "preact/hooks";
import { LOCALE_NAMES, otherLocale, pageCount, t, toggleLocale } from "../i18n";
import { SOURCE_URL } from "../links";
import { canOfferInstall } from "../platform/install";
import { updateInstalled, updateReady } from "../platform/pwa";
import { fitMode, savedSignatures, sheet, zoom } from "../state";
import { MAX_ZOOM, MIN_ZOOM } from "../viewer/layout";
import type { OpenDoc } from "../viewer/model";
import { PageThumbnails } from "../viewer/Thumbnails";
import { fitWidth, zoomIn, zoomOut } from "../viewer/zoom";
import { closeDocument, openDownloadOptions, openInstall, share, updateApp } from "./actions";
import { DetailsContent } from "./DetailsPanel";
import { openFilePicker } from "./filePicker";
import { openSavedSignatures, savedKind } from "./fill/FillBar";
import {
  IconClose, IconCode, IconDetails, IconDownload, IconFitWidth, IconGlobe, IconInstall, IconMinus, IconOpen, IconPlus,
  IconShare, IconShield, IconSignature, IconUpdate, IconZoom,
} from "./icons";
import { canSharePdf, shortcuts } from "./media";
import { Sheet } from "./Sheet";

function closeSheet() {
  sheet.value = null;
}

/**
 * Close the sheet now, before an action opens something of its own. Until it unmounts (a render
 * later) the modal sheet keeps the rest of the page inert, and the file picker's hidden input is
 * out there: closing the <dialog> itself frees it within this tap.
 */
function leaveSheet(e: Event) {
  if (e.currentTarget instanceof Element) e.currentTarget.closest("dialog")?.close();
  closeSheet();
}

function Row(p: {
  icon: ComponentChildren;
  label: string;
  tip?: string;
  /** Language of the label when it differs from the UI (the language switch). */
  lang?: string;
  /** Highlighter yellow: an update is ready. */
  accent?: boolean;
  /** It opens a dialog of its own (aria-haspopup). */
  opensDialog?: boolean;
  onClick: (e: MouseEvent) => void;
}) {
  return (
    <button type="button" class={p.accent ? "more-row is-accent" : "more-row"} title={p.tip}
      aria-haspopup={p.opensDialog ? "dialog" : undefined} onClick={p.onClick}>
      {p.icon}
      <span class="more-label" lang={p.lang}>{p.label}</span>
    </button>
  );
}

/** Zoom out, the value, zoom in, and fit width. At a limit the button stays focusable (aria-disabled). */
function ZoomRow() {
  const labelId = useId();
  const z = zoom.value;
  const percent = `${Math.round(z * 100)}%`;
  const atMin = z <= MIN_ZOOM, atMax = z >= MAX_ZOOM;
  return (
    <div class="more-section more-zoom" role="group" aria-labelledby={labelId}>
      <span class="more-zoom-label">
        <IconZoom />
        <span id={labelId}>{t("more.zoom")}</span>
      </span>
      <div class="more-zoom-controls">
        <div class="more-stepper">
          <button
            type="button"
            class="btn tool"
            aria-label={t("toolbar.zoomOut")}
            title={t("toolbar.zoomOutTip", { shortcut: shortcuts.zoomOut })}
            aria-disabled={atMin}
            onClick={() => {
              if (!atMin) zoomOut();
            }}
          >
            <IconMinus />
          </button>
          <output class="more-zoom-value" aria-label={t("toolbar.zoomValue", { percent })}>{percent}</output>
          <button
            type="button"
            class="btn tool"
            aria-label={t("toolbar.zoomIn")}
            title={t("toolbar.zoomInTip", { shortcut: shortcuts.zoomIn })}
            aria-disabled={atMax}
            onClick={() => {
              if (!atMax) zoomIn();
            }}
          >
            <IconPlus />
          </button>
        </div>
        <button
          type="button"
          class="btn tool more-fit"
          aria-label={t("toolbar.fitWidth")}
          title={t("toolbar.fitWidthTip", { shortcut: shortcuts.fit })}
          aria-pressed={fitMode.value}
          onClick={fitWidth}
        >
          <IconFitWidth />
        </button>
      </div>
    </div>
  );
}

/** "Saved signatures (N)", only when this device has some: it opens their chooser. */
function SavedSignaturesRow() {
  const saved = savedSignatures.value;
  if (!saved.length) return null;
  return (
    <div class="more-section">
      <Row
        icon={<IconSignature />}
        label={t("more.savedSignatures", { count: saved.length })}
        opensDialog
        onClick={(e) => {
          leaveSheet(e);
          void openSavedSignatures(savedKind(saved));
        }}
      />
    </div>
  );
}

/** The rows of the More sheet (exported for the tests: they cannot render it). */
export function MoreActions() {
  const next = otherLocale();
  return (
    <>
      <div class="more-section">
        <Row
          icon={<IconOpen />}
          label={t("more.openOther")}
          onClick={(e) => {
            leaveSheet(e);
            openFilePicker();
          }}
        />
        {canSharePdf() && (
          <Row
            icon={<IconShare />}
            label={t("toolbar.share")}
            onClick={(e) => {
              leaveSheet(e);
              void share();
            }}
          />
        )}
        <Row
          icon={<IconDownload />}
          label={t("more.downloadOptions")}
          opensDialog
          onClick={(e) => {
            leaveSheet(e);
            openDownloadOptions();
          }}
        />
        {/* Swaps the sheets: the More sheet goes at once and the details sheet comes up. Both give
            the focus back to the More tab when they go. */}
        <Row
          icon={<IconDetails />}
          label={t("tools.details")}
          opensDialog
          onClick={() => {
            sheet.value = "details";
          }}
        />
      </div>
      <ZoomRow />
      <SavedSignaturesRow />
      <div class="more-section">
        {canOfferInstall.value && (
          <Row
            icon={<IconInstall />}
            label={t("install.button")}
            opensDialog
            onClick={(e) => {
              leaveSheet(e);
              void openInstall(); // still within the tap: the browser's own dialog may open
            }}
          />
        )}
        <Row icon={<IconGlobe />} label={LOCALE_NAMES[next]} lang={next} tip={t("lang.tip")} onClick={toggleLocale} />
        {updateReady.value && (
          <Row
            icon={<IconUpdate />}
            label={t("toolbar.update")}
            tip={updateInstalled.value ? t("toolbar.updateInstalledTip") : t("toolbar.updateTip")}
            accent
            onClick={() => void updateApp()}
          />
        )}
      </div>
      <div class="more-section">
        <Row
          icon={<IconClose />}
          label={t("toolbar.close")}
          tip={t("toolbar.closeTip")}
          onClick={(e) => {
            leaveSheet(e);
            void closeDocument();
          }}
        />
      </div>
      <div class="more-footer">
        <p class="more-note">
          <IconShield />
          <span>{t("empty.privacy")}</span>
        </p>
        <a class="more-note more-link" href={SOURCE_URL} target="_blank" rel="noopener noreferrer">
          <IconCode />
          <span>{t("empty.source")}</span>
        </a>
      </div>
    </>
  );
}

export function PhoneSheets({ doc }: { doc: OpenDoc }) {
  // Unmounted with a sheet open (the window grew past the phone width): forget it, so it does not
  // pop up when the phone layout comes back, and Escape works again on the desktop layout.
  useEffect(() => closeSheet, []);

  const kind = sheet.value;
  if (kind === "pages") {
    return (
      <Sheet
        key="pages"
        title={t("pages.title")}
        detail={pageCount(doc.pages.length)}
        class="sheet-pages"
        initialFocus='[aria-current="page"]'
        onClose={closeSheet}
      >
        <PageThumbnails doc={doc} variant="grid" onPick={closeSheet} />
      </Sheet>
    );
  }
  if (kind === "more") {
    return (
      <Sheet key="more" title={t("more.title")} class="sheet-more" onClose={closeSheet}>
        <MoreActions />
      </Sheet>
    );
  }
  if (kind === "details") {
    return (
      <Sheet key="details" title={t("details.label")} class="sheet-details" onClose={closeSheet}>
        <DetailsContent doc={doc} leaveSheet={leaveSheet} />
      </Sheet>
    );
  }
  return null;
}
