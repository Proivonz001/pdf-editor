// Service worker: the app works offline and can be installed. A new version is never
// forced on the user mid-edit: the UI shows "Update available" and reloads only on request,
// and only the window where the user asked for it. Other open windows keep running the
// version they loaded (with their edits) and pick up the new one the next time they load.
import { signal } from "@preact/signals";
import { registerSW } from "virtual:pwa-register";

/** A new version has been downloaded and is waiting. */
export const updateReady = signal(false);
/** Another window installed the new version: this one runs the old one until it reloads. */
export const updateInstalled = signal(false);
/** Everything is cached: the app now also works without a connection. */
export const offlineReady = signal(false);

let update: ((reload?: boolean) => Promise<void>) | null = null;
let registration: ServiceWorkerRegistration | undefined;
/** The user asked for the update in this window: this is the one that reloads. */
let reloadOnTakeover = false;

export function registerPwa() {
  if (!("serviceWorker" in navigator)) return;
  update = registerSW({
    onNeedRefresh() { updateReady.value = true; },
    onOfflineReady() { offlineReady.value = true; },
    onRegisteredSW(_url, r) { registration = r; },
    // The new version has taken control of the open windows. Without this callback
    // vite-plugin-pwa reloads every window that showed "Update available", throwing away
    // the edits in all of them, as soon as one of them updates.
    onNeedReload() {
      if (reloadOnTakeover) location.reload();
      else updateInstalled.value = true;
    },
  });
}

/**
 * Activate the waiting version and reload this window. Call only when the user asks (unsaved
 * work!). With nothing waiting (another window already installed it, or no service worker)
 * a plain reload loads the newest version.
 */
export function applyUpdate() {
  const waiting = registration?.waiting;
  if (!update || !waiting) {
    location.reload();
    return;
  }
  reloadOnTakeover = true;
  // A window the service worker does not control (e.g. after a hard reload) gets no takeover
  // event: reload once the new version is active.
  if (!navigator.serviceWorker.controller) {
    waiting.addEventListener("statechange", () => {
      if (waiting.state === "activated") location.reload();
    });
  }
  void update(true);
}
