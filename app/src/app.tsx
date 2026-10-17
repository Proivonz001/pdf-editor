// The app shell, laid out by styles/layout.css. Without a document: top bar and home (or the
// "opening…" state). With one, on desktop: top bar, tool rail, thumbnails panel, viewer and
// details panel, both panels docked in their own columns (the thumbnails open by default from
// 1024 px, the details from 1200 px, one remembered choice each: panels.ts); on phones: top bar,
// viewer, tab bar and the bottom sheets (the details among them). Plus the drop overlay, toasts
// and dialogs. Global listeners (shortcuts, "Open with", beforeunload, "updated in another
// window") are installed once here.
import { useEffect, useLayoutEffect } from "preact/hooks";
import { t } from "./i18n";
import { onLaunchFiles } from "./platform/launch";
import { updateInstalled } from "./platform/pwa";
import { busy, doc, opening, showToast, startEngine } from "./state";
import { openFile, shouldWarnBeforeUnload } from "./ui/actions";
import { DetailsPanel } from "./ui/DetailsPanel";
import { Dialogs } from "./ui/Dialogs";
import { DropOverlay } from "./ui/DropOverlay";
import { EmptyState, OpeningState } from "./ui/EmptyState";
import { rescueFocus, viewerScroller } from "./ui/focus";
import { isNarrow } from "./ui/media";
import { PagesPanel } from "./ui/PagesPanel";
import { detailsPanelOpen, pagesPanelOpen } from "./ui/panels";
import { PhoneSheets } from "./ui/PhoneSheets";
import { installShortcuts } from "./ui/shortcuts";
import { TabBar } from "./ui/TabBar";
import { Toasts } from "./ui/Toasts";
import { ToolRail } from "./ui/ToolRail";
import { TopBar } from "./ui/TopBar";
import { Viewer } from "./viewer/Viewer";

let started = false;

function onBeforeUnload(e: BeforeUnloadEvent) {
  if (!shouldWarnBeforeUnload()) return;
  e.preventDefault();
  e.returnValue = ""; // older browsers need it to show the prompt
}

export function App() {
  useEffect(() => {
    // Load the engine now, while the user is still choosing a file.
    startEngine();
    if (!started) {
      started = true;
      onLaunchFiles((file) => void openFile(file)); // desktop "Open with"
    }
    const removeShortcuts = installShortcuts();
    window.addEventListener("beforeunload", onBeforeUnload);
    // Another window installed the new version: this one keeps its document and edits.
    const stopUpdateNotice = updateInstalled.subscribe((installed) => {
      if (installed) showToast("info", t("update.installedElsewhere"), 10_000);
    });
    return () => {
      removeShortcuts();
      window.removeEventListener("beforeunload", onBeforeUnload);
      stopUpdateNotice();
    };
  }, []);

  const d = doc.value;
  const narrow = isNarrow.value;

  // A document just opened (the "Open" button or the opening card that had the focus are gone),
  // or the layout switched at 640 px (the top bar, rail or tab bar that had it are gone): keep
  // the focus on the document.
  const docId = d?.id;
  useLayoutEffect(() => {
    if (docId !== undefined) rescueFocus(viewerScroller);
  }, [docId, narrow]);

  // Window title: the file name first, so it reads well in the taskbar and tab strip.
  const appName = t("app.name");
  useEffect(() => {
    document.title = d ? `${d.fileName} – ${appName}` : appName;
  }, [d, appName]);

  // Keys: a fresh panel for each document; siblings need different keys, hence the prefixes.
  return (
    <div class={d ? "app has-doc" : "app"} data-layout={narrow ? "phone" : "desktop"}>
      <TopBar />
      {d && !narrow && <ToolRail />}
      {d && pagesPanelOpen.value && <PagesPanel key={`pages:${d.id}`} doc={d} />}
      <main class="main" aria-busy={busy.value !== null || opening.value !== null}>
        {d ? <Viewer key={d.id} doc={d} /> : opening.value ? <OpeningState /> : <EmptyState />}
      </main>
      {d && detailsPanelOpen.value && <DetailsPanel key={`details:${d.id}`} doc={d} />}
      {d && narrow && <TabBar />}
      {d && narrow && <PhoneSheets key={`sheets:${d.id}`} doc={d} />}
      <DropOverlay />
      <Toasts />
      <Dialogs />
    </div>
  );
}
