// The app shell: top bar, then either the empty state, the "opening…" state or the viewer;
// plus the drop overlay, toasts and dialogs. Global listeners (shortcuts, "Open with",
// beforeunload, "updated in another window") are installed once here.
import { useEffect } from "preact/hooks";
import { t } from "./i18n";
import { onLaunchFiles } from "./platform/launch";
import { updateInstalled } from "./platform/pwa";
import { busy, doc, opening, showToast, startEngine } from "./state";
import { openFile, shouldWarnBeforeUnload } from "./ui/actions";
import { Dialogs } from "./ui/Dialogs";
import { DropOverlay } from "./ui/DropOverlay";
import { EmptyState, OpeningState } from "./ui/EmptyState";
import { installShortcuts } from "./ui/shortcuts";
import { Toasts } from "./ui/Toasts";
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

  // Window title: the file name first, so it reads well in the taskbar and tab strip.
  const appName = t("app.name");
  useEffect(() => {
    document.title = d ? `${d.fileName} – ${appName}` : appName;
  }, [d, appName]);

  return (
    <div class="app">
      <TopBar />
      <main class="main" aria-busy={busy.value !== null || opening.value !== null}>
        {d ? <Viewer key={d.id} doc={d} /> : opening.value ? <OpeningState /> : <EmptyState />}
      </main>
      <DropOverlay />
      <Toasts />
      <Dialogs />
    </div>
  );
}
