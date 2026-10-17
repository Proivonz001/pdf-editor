// Installing the app: what this browser offers and how, for the "Installa l'app" entries (home
// page, More menu, Altro sheet, the hint after the first download). There is no silent install
// anywhere: the browser always asks. Chromium browsers (Chrome, Edge, Samsung Internet... on
// Android and on the computer; Opera on Android only) fire beforeinstallprompt once the app
// qualifies (after a tap and about 30 s on the page): the event is kept here, so that our button
// shows the browser's own install dialog, and Chrome's mini-infobar gives way to our entries.
// Everywhere else there is no API, only the browser's own menu, and the UI shows that browser's
// steps: Safari on iPhone and iPad (Share › Add to Home Screen), the other iOS browsers, in-app
// browsers (open the page in the real browser first), Safari on the Mac (Add to Dock), Firefox on
// Android and on Windows. Nothing is offered when the app is already installed or the browser
// cannot install it. An installed app opened again in a tab of the same Chromium browser gets no
// beforeinstallprompt and runs in a tab, so this device remembers the install (localStorage) until
// the browser offers it again (then it was uninstalled).
// Detection reads the user agent, which is brittle: when unsure it falls back to the steps of the
// underlying browser, never to "none" for a browser that can install. Android in "Desktop site"
// mode sends a computer's user agent: its platform and touch screen still tell. Nothing leaves the
// device.
import { batch, computed, signal, type ReadonlySignal } from "@preact/signals";

/**
 * How this browser can install the app, as the UI offers it:
 * - "installed": running as the installed app (display-mode standalone, navigator.standalone),
 *   installed in this visit (appinstalled), or, in a Chromium tab, installed earlier in this
 *   browser (remembered on this device): nothing is offered;
 * - "prompt": Chromium kept its beforeinstallprompt event: the button calls promptInstall();
 * - "chromium": a Chromium browser that has not offered it (yet: it waits for a tap and ~30 s, or
 *   the user dismissed it): steps for its own menu (desktop: the install icon in the address bar or
 *   ⋮ › "Installa…"; Android, installOnAndroid(): ⋮ › "Installa app" / "Aggiungi a schermata Home");
 * - "ios-safari": iPhone/iPad Safari: the 3 steps (iOS 26: ••• › Condividi › Aggiungi alla
 *   schermata Home › Aggiungi, "Apri come app web" on);
 * - "ios-other": Chrome, Edge, Firefox... on iOS: their Share menu › Aggiungi alla schermata Home
 *   (iOS 16.4+), or open the page in Safari;
 * - "in-app": an in-app browser (Instagram, Facebook, TikTok, LinkedIn, Line, WeChat...): open
 *   the page in the browser, with "Copia link";
 * - "mac-safari": Safari 17+ on macOS: File › Add to Dock, which needs macOS Sonoma (14) or later.
 *   Safari 17 and 18 also run on Monterey and Ventura, and the user agent cannot tell (it always
 *   says 10_15_7): the steps say "macOS Sonoma or later";
 * - "firefox-android": Firefox on Android (also in "Desktop site" mode): its menu › Install;
 * - "firefox-windows": Firefox 143+ on Windows: the web app button in the address bar;
 * - "none": this browser cannot install it (Firefox on macOS/Linux, Opera on the computer,
 *   DuckDuckGo on the Mac, unknown): nothing is offered.
 */
export type InstallState =
  | "installed" | "prompt" | "chromium" | "ios-safari" | "ios-other" | "in-app"
  | "mac-safari" | "firefox-android" | "firefox-windows" | "none";

/** What detection looks at (testable without a browser). */
export interface InstallEnv {
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
  /** navigator.standalone (iOS) or matchMedia("(display-mode: standalone)") (or minimal-ui / window-controls-overlay). */
  standalone: boolean;
  /** A beforeinstallprompt event is being kept. */
  hasPrompt: boolean;
}

/** Chromium's install offer: not in TypeScript's DOM library (it is not a web standard). */
interface BeforeInstallPromptEvent extends Event {
  /** Shows the browser's install dialog: once per event, and only within a user's click. */
  prompt(): Promise<unknown>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

// ---------------------------------------------------------------------------------------------
// Detection

/**
 * In-app browsers, from their user-agent tokens: the web view of a social or chat app cannot
 * install, the page has to be opened in the real browser first. Android's own web view, which
 * these apps mostly use there, marks itself "; wv)". WhatsApp, Telegram and X on iOS mostly use
 * the system's browser view, which looks like the browser itself (and gets its steps).
 */
const IN_APP = new RegExp([
  "FBAN/", "FBAV/", "FB_IAB/", // Facebook, Messenger
  "\\bInstagram\\b",
  "\\bBarcelona\\b", // Threads
  "\\bLine/", // LINE
  "MicroMessenger", // WeChat
  "musical_ly", "BytedanceWebview", "\\btrill_", "\\bTikTok\\b", // TikTok
  "LinkedInApp",
  "Snapchat",
  "Pinterest",
  "Twitter",
  "KAKAOTALK", "NAVER\\(inapp", "DaumApps", // KakaoTalk, Naver, Daum
  "\\bGSA/", // the Google app
  "; wv\\)", // Android System WebView
].join("|"));

/** Browsers on iOS other than Safari (iPadOS may hand them a Mac user agent with Chrome or Firefox in it). */
const IOS_OTHER = /CriOS\/|FxiOS\/|EdgiOS\/|OPiOS\/|OPT\/|OPX\/|YaBrowser\/|DuckDuckGo\/|Ddg\/|UCBrowser\/|Mercury\/|Chrome\/|Firefox\//;

/** Chromium browsers: Chrome, Edge, Opera, Brave, Vivaldi, Samsung Internet... */
const CHROMIUM = /\b(?:Chrome|Chromium|HeadlessChrome)\/|SamsungBrowser\//;

/**
 * Android's navigator.platform: "Linux armv81" (Firefox's constant, and Chromium's frozen value),
 * or the processor where it is not frozen ("Linux aarch64", "Linux armv8l", "Linux armv7l").
 * Browsers on a Linux computer say "Linux x86_64" whatever the processor (Firefox and Chromium
 * alike), so this is not a Linux laptop with a touch screen.
 */
const ANDROID_PLATFORM = /^Linux (?:arm|aarch64)/i;

/**
 * Running on Android, from the user agent, or in "Desktop site" mode, where the user agent is a
 * Linux computer's (Firefox: on request, and by default on large screens since 133; Chrome: on
 * request, and by default on large tablets) but navigator.platform is still Android's and the
 * screen is a touch screen. Not ChromeOS, whose Chrome installs as on a computer. (pure)
 */
export function isAndroid(env: Pick<InstallEnv, "userAgent" | "platform" | "maxTouchPoints">): boolean {
  if (/Android/.test(env.userAgent)) return true;
  return ANDROID_PLATFORM.test(env.platform) && env.maxTouchPoints > 1 && !/\bCrOS\b/.test(env.userAgent);
}

/** WebKit browsers on the Mac that send Safari's user agent plus their own token, without Add to Dock: DuckDuckGo. */
const MAC_BRANDED_WEBKIT = /\bDdg\/|DuckDuckGo\//;

/** The state for `env` (pure). iPadOS reports a Mac user agent with maxTouchPoints > 1: that is iOS. */
export function detectInstall(env: InstallEnv): InstallState {
  if (env.standalone) return "installed";
  // Whatever the user agent says, a browser that offers to install can install.
  if (env.hasPrompt) return "prompt";
  const ua = env.userAgent;
  if (IN_APP.test(ua)) return "in-app";

  const ios = /iPhone|iPad|iPod/.test(ua) || (/Mac/.test(env.platform || ua) && env.maxTouchPoints > 1);
  if (ios) {
    if (IOS_OTHER.test(ua)) return "ios-other";
    // Safari names itself; a web view inside an app (no "Safari/") cannot add to the Home Screen.
    return /Safari\//.test(ua) ? "ios-safari" : "in-app";
  }

  if (isAndroid(env)) {
    if (/Firefox\//.test(ua)) return "firefox-android";
    // Opera included: on Android it installs (⋮ › Add to › Home screen).
    return CHROMIUM.test(ua) ? "chromium" : "none";
  }

  // The computer. Firefox installs web apps only on Windows, from version 143 ("Taskbar Tabs").
  const firefox = /Firefox\/(\d+)/.exec(ua);
  if (firefox) return /Windows/.test(ua) && Number(firefox[1]) >= 143 ? "firefox-windows" : "none";
  // Opera on the computer has no install (should it ever offer one, hasPrompt above takes it).
  if (/\bOPR\//.test(ua)) return "none";
  if (CHROMIUM.test(ua)) return "chromium";
  // Safari on the Mac: File › Add to Dock from Safari 17 (on Sonoma or later: see "mac-safari").
  // Other Mac web views have no "Version/".
  const safari = /Version\/(\d+)/.exec(ua);
  if (safari && /Macintosh/.test(ua) && /Safari\//.test(ua) && !MAC_BRANDED_WEBKIT.test(ua)) {
    return Number(safari[1]) >= 17 ? "mac-safari" : "none";
  }
  return "none";
}

// ---------------------------------------------------------------------------------------------
// State

/**
 * The display modes of an installed app. Not "fullscreen": a browser tab matches it too in
 * Chrome's own full screen (F11), and the manifest does not ask for it.
 */
const APP_DISPLAY_MODES = [
  "(display-mode: standalone)",
  "(display-mode: minimal-ui)",
  "(display-mode: window-controls-overlay)",
];

/** Running as the installed app right now. False wherever the browser cannot tell (or in Node). */
function runningAsApp(): boolean {
  try {
    if ((navigator as Navigator & { standalone?: boolean }).standalone === true) return true;
    return typeof window !== "undefined" && typeof window.matchMedia === "function" &&
      APP_DISPLAY_MODES.some((q) => window.matchMedia(q).matches);
  } catch {
    return false;
  }
}

/** The browser's facts for detectInstall (none in Node: then nothing is offered). */
function browserFacts(): Pick<InstallEnv, "userAgent" | "platform" | "maxTouchPoints"> {
  if (typeof navigator === "undefined") return { userAgent: "", platform: "", maxTouchPoints: 0 };
  return {
    userAgent: navigator.userAgent ?? "",
    platform: navigator.platform ?? "",
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
  };
}

/**
 * This browser runs on Android, "Desktop site" mode included (isAndroid): Chromium's steps are
 * then those of its Android menu (⋮ › Install app), not the computer's address-bar icon.
 */
export function installOnAndroid(): boolean {
  return isAndroid(browserFacts());
}

/**
 * localStorage key: the app was installed in this browser on this device ("1"). Set on
 * appinstalled, an accepted prompt, and whenever the page runs as the app; removed when the
 * browser offers to install again (the app was uninstalled). Read only in "chromium": other
 * browsers never offer again, so a stale memory there would hide the entries for good.
 */
export const INSTALLED_KEY = "pdf-editor.installed";

/** Whether this device remembers the install (false where storage is blocked). */
function readInstalled(): boolean {
  try {
    return localStorage.getItem(INSTALLED_KEY) !== null;
  } catch {
    return false;
  }
}

/** The beforeinstallprompt event kept for our button; null once used. */
const kept = signal<BeforeInstallPromptEvent | null>(null);
/** A beforeinstallprompt event arrived in this visit: this browser can install, whatever its user agent says. */
const offered = signal(false);
/**
 * Seen running as the installed app in this visit (at load, or the browser's own install moved
 * the page into the app's window). Kept when the page goes back into a tab: the app stays installed.
 */
const standalone = signal(runningAsApp());
/** Installed in this visit (appinstalled, or accepted in our prompt), while this page may still be in a tab. */
const installedHere = signal(false);
/** Installed in this browser on an earlier visit (INSTALLED_KEY), or in this one. */
const installedBefore = signal(readInstalled());

/** Remember on this device that the app is installed in this browser, or (false) that it is not any more. */
function remember(installed: boolean): void {
  installedBefore.value = installed;
  try {
    if (installed) localStorage.setItem(INSTALLED_KEY, "1");
    else localStorage.removeItem(INSTALLED_KEY);
  } catch {
    // Storage blocked: known for this visit only.
  }
}

/** The page runs as the installed app: so it is installed, and a tab of this browser offers nothing later. */
function seenAsApp(): void {
  batch(() => {
    standalone.value = true;
    remember(true);
  });
}

/** The current state; changes when beforeinstallprompt or appinstalled arrive, or display-mode changes. */
export const installState: ReadonlySignal<InstallState> = computed(() => {
  if (installedHere.value) return "installed";
  const detected = detectInstall({ ...browserFacts(), standalone: standalone.value, hasPrompt: kept.value !== null });
  // The offer was dismissed (or used up) in a browser its user agent did not tell: its own menu.
  const state = offered.value && detected !== "installed" && detected !== "prompt" ? "chromium" : detected;
  // The installed app opened in a tab of the same browser: Chromium offers nothing there (no
  // beforeinstallprompt, no install item: "Open in app" instead), so neither do we.
  return state === "chromium" && installedBefore.value ? "installed" : state;
});

/** Whether the UI offers install at all: not "installed", not "none". */
export const canOfferInstall: ReadonlySignal<boolean> = computed(
  () => installState.value !== "installed" && installState.value !== "none",
);

let listening = false;

/**
 * Listen for beforeinstallprompt (preventDefault and keep the event: our entries replace Chrome's
 * mini-infobar), appinstalled and display-mode changes, and remember on this device that the app
 * is installed when it runs as the app. Call once, before the first render (main.tsx): the event
 * can fire early.
 */
export function listenForInstall(): void {
  if (listening || typeof window === "undefined" || typeof window.addEventListener !== "function") return;
  listening = true;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    // A later event (Chrome may offer again after a dismissal) replaces the one kept. The browser
    // offers only what is not installed: an install remembered or seen in this visit was undone.
    batch(() => {
      kept.value = e as BeforeInstallPromptEvent;
      offered.value = true;
      installedHere.value = false;
      remember(false);
    });
  });
  window.addEventListener("appinstalled", () => {
    batch(() => {
      kept.value = null;
      installedHere.value = true;
      remember(true);
    });
  });
  if (standalone.peek() || runningAsApp()) seenAsApp();
  if (typeof window.matchMedia !== "function") return;
  for (const query of APP_DISPLAY_MODES) {
    try {
      window.matchMedia(query).addEventListener("change", () => {
        if (runningAsApp()) seenAsApp();
      });
    } catch {
      // An old browser without change events: the mode read at load stands.
    }
  }
}

/**
 * Show the browser's own install dialog (state "prompt"), from within a click. Resolves with the
 * user's choice; "unavailable" when no event is kept (then the UI shows the steps). The event is
 * used once: after it the state is "installed" (accepted) or "chromium" (dismissed).
 */
export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  const event = kept.peek();
  if (!event) return "unavailable";
  let shown: Promise<unknown> | null = null;
  try {
    // Called before anything is awaited: the click's user activation is still there.
    shown = event.prompt();
  } catch {
    // Refused at once: handled below like a refusal later on.
  }
  kept.value = null; // an event shows its dialog only once
  if (!shown) return "unavailable";
  try {
    await shown;
    const { outcome } = await event.userChoice;
    if (outcome !== "accepted") return "dismissed";
    // appinstalled follows; the state does not wait for it.
    batch(() => {
      installedHere.value = true;
      remember(true);
    });
    return "accepted";
  } catch {
    // The browser refused to show it (no user activation left, already shown): the steps instead.
    return "unavailable";
  }
}

/**
 * The app's address, to open it in another browser: its start page, without the query or
 * fragment an in-app browser may have added (tracking ids among them). Empty when unknown.
 */
export function appAddress(): string {
  try {
    return new URL("./", location.href).href;
  } catch {
    return "";
  }
}

/** Copy the app's address (in-app browsers): true when copied (navigator.clipboard), false otherwise (the UI then selects the text). */
export async function copyAppLink(): Promise<boolean> {
  const address = appAddress();
  if (!address) return false;
  try {
    await navigator.clipboard.writeText(address);
    return true;
  } catch {
    return false; // no clipboard here (some web views), or not allowed
  }
}
