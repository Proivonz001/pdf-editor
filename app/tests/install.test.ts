// Installing the app (src/platform/install.ts) without a browser: what detection says for a table
// of real user agents (iPhone and iPad Safari, the other iOS browsers, in-app browsers on iOS and
// Android, Android and desktop Chromium, Android in "Desktop site" mode, Opera, Firefox on
// Android, Windows, macOS and Linux, Safari and DuckDuckGo on the Mac, the installed app), and the
// install flow with a synthetic beforeinstallprompt event (kept, shown once from the click,
// accepted or dismissed, appinstalled, display-mode changes), the install remembered on the device
// for a later tab of the same browser, plus the "Copia link" address and the manifest's identity
// (no explicit id: the start page, at a domain root and in a sub-folder). Each flow test loads the
// module afresh on a fake window, with its own localStorage.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MANIFEST } from "../vite.config";
import { detectInstall, INSTALLED_KEY, isAndroid, type InstallEnv, type InstallState } from "../src/platform/install";

const IPHONE_SAFARI_26 =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
const IPAD_MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
const IOS_CHROME =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.7390.96 Mobile/15E148 Safari/604.1";
const IOS_FIREFOX =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/144.0 Mobile/15E148 Safari/605.1.15";
const IOS_EDGE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 EdgiOS/141.0.3537.71 Mobile/15E148 Safari/605.1.15";
const IOS_INSTAGRAM =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 400.0.0.23.88 (iPhone15,2; iOS 18_6; it_IT; it; scale=3.00; 1179x2556; 812345678)";
const IOS_FACEBOOK =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/530.0.0.44.107;FBBV/812345678;FBDV/iPhone15,2;FBMD/iPhone;FBSN/iOS;FBSV/18.6;FBSS/3;FBID/phone;FBLC/it_IT;FBOP/80]";
const IOS_TIKTOK =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 musical_ly_41.5.0 JsSdk/2.0 NetType/WIFI Channel/App Store ByteLocale/it Region/IT isDarkMode/0 WKWebView/1 RevealType/Dialog BytedanceWebview/d8a21c6";
const IOS_LINKEDIN =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [LinkedInApp]/9.31.1";
const IOS_GOOGLE_APP =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) GSA/390.0.807416745 Mobile/15E148 Safari/604.1";
const IOS_WEB_VIEW =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const ANDROID_INSTAGRAM =
  "Mozilla/5.0 (Linux; Android 15; SM-S921B Build/AP3A.240905.015.A2; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.7390.97 Mobile Safari/537.36 Instagram 401.0.0.48.79 Android (35/15; 480dpi; 1080x2340; samsung; SM-S921B; e1s; s5e9945; it_IT; 812345678)";
const ANDROID_FACEBOOK =
  "Mozilla/5.0 (Linux; Android 15; Pixel 9 Build/AP4A.250105.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.7390.97 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/530.0.0.47.110;]";
const ANDROID_TIKTOK =
  "Mozilla/5.0 (Linux; Android 14; SM-A546B Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.7390.97 Mobile Safari/537.36 trill_410504 JsSdk/1.0 NetType/WIFI Channel/googleplay AppName/musical_ly app_version/41.5.4 ByteLocale/it ByteFullLocale/it Region/IT BytedanceWebview/d8a21c6";
const ANDROID_WECHAT =
  "Mozilla/5.0 (Linux; Android 14; V2309A Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.6723.103 Mobile Safari/537.36 XWEB/1300289 MMWEBSDK/20240404 MMWEBID/1234 MicroMessenger/8.0.49.2600(0x28003133) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64";
const ANDROID_WEB_VIEW =
  "Mozilla/5.0 (Linux; Android 15; Pixel 9 Build/AP4A.250105.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.7390.97 Mobile Safari/537.36";
const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36";
const SAMSUNG_INTERNET =
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36";
const ANDROID_EDGE =
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36 EdgA/141.0.0.0";
const ANDROID_FIREFOX = "Mozilla/5.0 (Android 15; Mobile; rv:144.0) Gecko/144.0 Firefox/144.0";
const ANDROID_OPERA_MINI =
  "Opera/9.80 (Android; Opera Mini/88.0.2254/191.379; U; it) Presto/2.12.423 Version/12.16";
const WINDOWS_CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const WINDOWS_EDGE =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0";
const WINDOWS_FIREFOX_142 = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:142.0) Gecko/20100101 Firefox/142.0";
const WINDOWS_FIREFOX_143 = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0";
const MAC_SAFARI_16 =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Safari/605.1.15";
const MAC_SAFARI_17 =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15";
const MAC_SAFARI_26 =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
const MAC_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const MAC_FIREFOX = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:144.0) Gecko/20100101 Firefox/144.0";
const MAC_WEB_VIEW = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const LINUX_CHROME =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const LINUX_FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0";
const CHROMEOS =
  "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
// "Desktop site" on Android: Firefox replaces "Android 15; Mobile" with "X11; Linux x86_64"
// (GeckoView's getDesktopUserAgent), Chrome sends a Linux computer's agent (by default on large
// tablets). navigator.platform stays Android's in both: "Linux armv81" (Gecko's constant,
// Chromium's frozen value), "Linux aarch64" or "Linux armv8l" where it is not frozen.
const ANDROID_FIREFOX_DESKTOP_SITE = "Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0";
const ANDROID_CHROME_DESKTOP_SITE =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const MAC_SAFARI_18 =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15";
const MAC_DUCKDUCKGO =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15 Ddg/26.0";
const WINDOWS_OPERA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 OPR/124.0.0.0";
const MAC_OPERA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 OPR/124.0.0.0";
const LINUX_OPERA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 OPR/124.0.0.0";
const ANDROID_OPERA =
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36 OPR/92.0.0.0";

/** A device: user agent, navigator.platform, touch points. */
type Device = [ua: string, platform: string, touch: number];
const IPHONE = (ua: string): Device => [ua, "iPhone", 5];
const ANDROID = (ua: string): Device => [ua, "Linux armv8l", 5];
/** An Android phone or tablet in "Desktop site" mode: a computer's user agent, Android's platform. */
const DESKTOP_SITE = (ua: string, platform = "Linux armv81"): Device => [ua, platform, 5];
const WINDOWS = (ua: string): Device => [ua, "Win32", 0];
const MAC = (ua: string): Device => [ua, "MacIntel", 0];
const LINUX = (ua: string): Device => [ua, "Linux x86_64", 0];
/** A Linux laptop with a touch screen: desktop browsers there say "Linux x86_64" on any processor. */
const LINUX_TOUCH = (ua: string): Device => [ua, "Linux x86_64", 10];

function env([userAgent, platform, maxTouchPoints]: Device, extra: Partial<InstallEnv> = {}): InstallEnv {
  return { userAgent, platform, maxTouchPoints, standalone: false, hasPrompt: false, ...extra };
}

describe("detectInstall", () => {
  const table: [name: string, device: Device, expected: InstallState][] = [
    ["iPhone Safari, iOS 26", IPHONE(IPHONE_SAFARI_26), "ios-safari"],
    ["iPad Safari, Mac user agent with touch", [IPAD_MAC_UA, "MacIntel", 5], "ios-safari"],
    ["iPad Chrome, Mac user agent with touch", [MAC_CHROME, "MacIntel", 5], "ios-other"],
    ["Chrome on iOS", IPHONE(IOS_CHROME), "ios-other"],
    ["Firefox on iOS", IPHONE(IOS_FIREFOX), "ios-other"],
    ["Edge on iOS", IPHONE(IOS_EDGE), "ios-other"],
    ["Instagram on iOS", IPHONE(IOS_INSTAGRAM), "in-app"],
    ["Facebook on iOS", IPHONE(IOS_FACEBOOK), "in-app"],
    ["TikTok on iOS", IPHONE(IOS_TIKTOK), "in-app"],
    ["LinkedIn on iOS", IPHONE(IOS_LINKEDIN), "in-app"],
    ["the Google app on iOS", IPHONE(IOS_GOOGLE_APP), "in-app"],
    ["an unknown web view on iOS (no Safari/)", IPHONE(IOS_WEB_VIEW), "in-app"],
    ["Instagram on Android", ANDROID(ANDROID_INSTAGRAM), "in-app"],
    ["Facebook on Android", ANDROID(ANDROID_FACEBOOK), "in-app"],
    ["TikTok on Android", ANDROID(ANDROID_TIKTOK), "in-app"],
    ["WeChat on Android", ANDROID(ANDROID_WECHAT), "in-app"],
    ["an unknown Android web view (wv)", ANDROID(ANDROID_WEB_VIEW), "in-app"],
    ["Chrome on Android", ANDROID(ANDROID_CHROME), "chromium"],
    ["Samsung Internet", ANDROID(SAMSUNG_INTERNET), "chromium"],
    ["Edge on Android", ANDROID(ANDROID_EDGE), "chromium"],
    ["Firefox on Android", ANDROID(ANDROID_FIREFOX), "firefox-android"],
    ["Firefox on Android, Desktop site", DESKTOP_SITE(ANDROID_FIREFOX_DESKTOP_SITE), "firefox-android"],
    ["Firefox on Android, Desktop site, unfrozen platform", DESKTOP_SITE(ANDROID_FIREFOX_DESKTOP_SITE, "Linux aarch64"), "firefox-android"],
    ["Chrome on an Android tablet, Desktop site", DESKTOP_SITE(ANDROID_CHROME_DESKTOP_SITE), "chromium"],
    ["Opera on Android", ANDROID(ANDROID_OPERA), "chromium"],
    ["Opera Mini on Android", ANDROID(ANDROID_OPERA_MINI), "none"],
    ["Chrome on Windows", WINDOWS(WINDOWS_CHROME), "chromium"],
    ["Edge on Windows", WINDOWS(WINDOWS_EDGE), "chromium"],
    ["Opera on Windows", WINDOWS(WINDOWS_OPERA), "none"],
    ["Firefox 142 on Windows", WINDOWS(WINDOWS_FIREFOX_142), "none"],
    ["Firefox 143 on Windows", WINDOWS(WINDOWS_FIREFOX_143), "firefox-windows"],
    ["Safari 16 on macOS", MAC(MAC_SAFARI_16), "none"],
    ["Safari 17 on macOS", MAC(MAC_SAFARI_17), "mac-safari"],
    // Also on Ventura, which has no Add to Dock: the user agent cannot tell (the steps say Sonoma).
    ["Safari 18 on macOS", MAC(MAC_SAFARI_18), "mac-safari"],
    ["Safari 26 on macOS", MAC(MAC_SAFARI_26), "mac-safari"],
    ["DuckDuckGo on macOS (Safari's agent plus Ddg/)", MAC(MAC_DUCKDUCKGO), "none"],
    ["Chrome on macOS", MAC(MAC_CHROME), "chromium"],
    ["Opera on macOS", MAC(MAC_OPERA), "none"],
    ["Firefox on macOS", MAC(MAC_FIREFOX), "none"],
    ["a web view in a Mac app", MAC(MAC_WEB_VIEW), "none"],
    ["Chrome on Linux", LINUX(LINUX_CHROME), "chromium"],
    ["Chrome on a Linux touch laptop", LINUX_TOUCH(LINUX_CHROME), "chromium"],
    ["Opera on Linux", LINUX(LINUX_OPERA), "none"],
    ["Firefox on Linux", LINUX(LINUX_FIREFOX), "none"],
    ["Firefox on a Linux touch laptop", LINUX_TOUCH(LINUX_FIREFOX), "none"],
    ["Chrome on ChromeOS", LINUX(CHROMEOS), "chromium"],
    ["no user agent at all", ["", "", 0], "none"],
  ];

  it.each(table)("%s", (_name, device, expected) => {
    expect(detectInstall(env(device))).toBe(expected);
  });

  it("says installed when running as the app, wherever", () => {
    for (const device of [IPHONE(IPHONE_SAFARI_26), [IPAD_MAC_UA, "MacIntel", 5] as Device, ANDROID(ANDROID_CHROME), WINDOWS(WINDOWS_EDGE), MAC(MAC_SAFARI_26)]) {
      expect(detectInstall(env(device, { standalone: true }))).toBe("installed");
      expect(detectInstall(env(device, { standalone: true, hasPrompt: true }))).toBe("installed");
    }
  });

  it("says prompt while an offer is kept, whatever the user agent", () => {
    expect(detectInstall(env(WINDOWS(WINDOWS_CHROME), { hasPrompt: true }))).toBe("prompt");
    expect(detectInstall(env(ANDROID(SAMSUNG_INTERNET), { hasPrompt: true }))).toBe("prompt");
    // Opera on the computer has no install of its own: should it ever offer one, it is taken.
    expect(detectInstall(env(WINDOWS(WINDOWS_OPERA), { hasPrompt: true }))).toBe("prompt");
    // A user agent the table does not know, or takes for something else.
    expect(detectInstall(env(["", "", 0], { hasPrompt: true }))).toBe("prompt");
    expect(detectInstall(env(ANDROID(ANDROID_WEB_VIEW), { hasPrompt: true }))).toBe("prompt");
  });

  it("does not take a Mac without touch for an iPad", () => {
    expect(detectInstall(env([IPAD_MAC_UA, "MacIntel", 0]))).toBe("mac-safari");
    expect(detectInstall(env([IPAD_MAC_UA, "MacIntel", 1]))).toBe("mac-safari");
  });
});

describe("isAndroid (Chromium's steps: the Android menu or the computer's)", () => {
  it("is Android from the user agent", () => {
    for (const ua of [ANDROID_CHROME, SAMSUNG_INTERNET, ANDROID_EDGE, ANDROID_FIREFOX, ANDROID_OPERA]) {
      expect(isAndroid({ userAgent: ua, platform: "Linux armv81", maxTouchPoints: 5 }), ua).toBe(true);
      expect(isAndroid({ userAgent: ua, platform: "", maxTouchPoints: 0 }), ua).toBe(true);
    }
  });

  it("is Android in Desktop site mode: a computer's user agent on Android's platform, with touch", () => {
    for (const platform of ["Linux armv81", "Linux aarch64", "Linux armv8l", "Linux armv7l"]) {
      for (const ua of [ANDROID_CHROME_DESKTOP_SITE, ANDROID_FIREFOX_DESKTOP_SITE]) {
        const [userAgent, , maxTouchPoints] = DESKTOP_SITE(ua, platform);
        expect(isAndroid({ userAgent, platform, maxTouchPoints }), `${platform} ${ua}`).toBe(true);
      }
    }
  });

  it("is not Android on a computer, touch screen or not, nor on ChromeOS, iOS or a Mac", () => {
    const computers: Device[] = [
      LINUX(LINUX_CHROME), LINUX_TOUCH(LINUX_CHROME), LINUX_TOUCH(LINUX_FIREFOX),
      [ANDROID_CHROME_DESKTOP_SITE, "Linux armv81", 0], // no touch: not a phone or tablet
      [CHROMEOS, "Linux aarch64", 10], // an ARM Chromebook tablet: ChromeOS's own (desktop) install
      WINDOWS(WINDOWS_CHROME), MAC(MAC_CHROME), IPHONE(IOS_CHROME), [IPAD_MAC_UA, "MacIntel", 5], ["", "", 0],
    ];
    for (const [userAgent, platform, maxTouchPoints] of computers) {
      expect(isAndroid({ userAgent, platform, maxTouchPoints }), `${platform} ${userAgent}`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The flow, on a fake window

/** A synthetic BeforeInstallPromptEvent: records prompt() calls, answers with `outcome`. */
class FakeInstallPrompt extends Event {
  prompts = 0;
  readonly outcome: "accepted" | "dismissed";
  readonly refuse: boolean;
  constructor(outcome: "accepted" | "dismissed", refuse = false) {
    super("beforeinstallprompt", { cancelable: true });
    this.outcome = outcome;
    this.refuse = refuse;
  }
  prompt(): Promise<void> {
    this.prompts++;
    if (this.refuse) return Promise.reject(new Error("NotAllowedError"));
    if (this.prompts > 1) return Promise.reject(new Error("InvalidStateError"));
    return Promise.resolve();
  }
  get userChoice() {
    return Promise.resolve({ outcome: this.outcome, platform: "web" });
  }
}

/** matchMedia with display modes the test can switch, firing "change" like the browser. */
function fakeMedia(initial: Record<string, boolean> = {}) {
  const lists = new Map<string, { matches: boolean; listeners: (() => void)[] }>();
  const list = (query: string) => {
    let l = lists.get(query);
    if (!l) lists.set(query, (l = { matches: initial[query] ?? false, listeners: [] }));
    return l;
  };
  return {
    matchMedia(query: string) {
      const l = list(query);
      return {
        media: query,
        get matches() { return l.matches; },
        addEventListener(_type: string, cb: () => void) { l.listeners.push(cb); },
      };
    },
    set(query: string, matches: boolean) {
      const l = list(query);
      l.matches = matches;
      for (const cb of l.listeners) cb();
    },
    listeners: (query: string) => list(query).listeners.length,
  };
}

/**
 * localStorage as a browser keeps it from one visit to the next (pass the same one to several
 * loads). `blocked`: every call throws, as with blocked site data or some private modes.
 */
function fakeStorage(blocked = false) {
  const items = new Map<string, string>();
  const check = () => {
    if (blocked) throw new DOMException("The operation is insecure.", "SecurityError");
  };
  return {
    items,
    getItem(key: string) { check(); return items.get(key) ?? null; },
    setItem(key: string, value: string) { check(); items.set(key, String(value)); },
    removeItem(key: string) { check(); items.delete(key); },
  };
}

type Install = typeof import("../src/platform/install");

/** Load the module afresh in a browser with `ua`, on a fake window (and a new, empty localStorage unless given one). */
async function load(
  device: Device,
  opts: { media?: Record<string, boolean>; standalone?: boolean; storage?: ReturnType<typeof fakeStorage> } = {},
) {
  const media = fakeMedia(opts.media);
  const win = Object.assign(new EventTarget(), { matchMedia: media.matchMedia });
  const add = vi.spyOn(win, "addEventListener");
  const [userAgent, platform, maxTouchPoints] = device;
  const storage = opts.storage ?? fakeStorage();
  vi.stubGlobal("window", win);
  vi.stubGlobal("navigator", { userAgent, platform, maxTouchPoints, standalone: opts.standalone });
  vi.stubGlobal("localStorage", storage);
  vi.resetModules();
  const install: Install = await import("../src/platform/install");
  return { install, win, media, add, storage };
}

describe("the install flow", () => {
  beforeEach(() => { vi.unstubAllGlobals(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("keeps the offer, shows it once from the click, and is installed once accepted", async () => {
    const { install, win } = await load(WINDOWS(WINDOWS_CHROME));
    expect(install.installState.value).toBe("chromium");
    expect(install.canOfferInstall.value).toBe(true);
    install.listenForInstall();

    const offer = new FakeInstallPrompt("accepted");
    win.dispatchEvent(offer);
    expect(offer.defaultPrevented).toBe(true); // Chrome's mini-infobar gives way to our entries
    expect(install.installState.value).toBe("prompt");

    const choice = install.promptInstall();
    expect(offer.prompts).toBe(1); // called before anything is awaited: still within the click
    expect(install.installState.value).not.toBe("prompt"); // used once
    await expect(choice).resolves.toBe("accepted");
    expect(install.installState.value).toBe("installed");
    expect(install.canOfferInstall.value).toBe(false);

    await expect(install.promptInstall()).resolves.toBe("unavailable");
    expect(offer.prompts).toBe(1);
  });

  it("falls back to the browser's menu once the offer is dismissed, and takes a new offer", async () => {
    const { install, win } = await load(ANDROID(ANDROID_CHROME));
    install.listenForInstall();
    const offer = new FakeInstallPrompt("dismissed");
    win.dispatchEvent(offer);
    await expect(install.promptInstall()).resolves.toBe("dismissed");
    expect(install.installState.value).toBe("chromium");
    expect(install.canOfferInstall.value).toBe(true);
    await expect(install.promptInstall()).resolves.toBe("unavailable");
    expect(offer.prompts).toBe(1);

    // Chrome may offer again later: the new event is the one kept.
    const again = new FakeInstallPrompt("accepted");
    win.dispatchEvent(again);
    expect(install.installState.value).toBe("prompt");
    await expect(install.promptInstall()).resolves.toBe("accepted");
    expect(again.prompts).toBe(1);
    expect(install.installState.value).toBe("installed");
  });

  it("says unavailable when there is no offer, or when the browser refuses to show it", async () => {
    const { install, win } = await load(WINDOWS(WINDOWS_EDGE));
    install.listenForInstall();
    await expect(install.promptInstall()).resolves.toBe("unavailable");

    const refused = new FakeInstallPrompt("accepted", true);
    win.dispatchEvent(refused);
    await expect(install.promptInstall()).resolves.toBe("unavailable");
    expect(refused.prompts).toBe(1);
    expect(install.installState.value).toBe("chromium"); // the steps instead
  });

  it("is installed on appinstalled (the browser's own install), and drops the kept offer", async () => {
    const { install, win } = await load(WINDOWS(WINDOWS_CHROME));
    install.listenForInstall();
    const offer = new FakeInstallPrompt("accepted");
    win.dispatchEvent(offer);
    win.dispatchEvent(new Event("appinstalled"));
    expect(install.installState.value).toBe("installed");
    expect(install.canOfferInstall.value).toBe(false);
    await expect(install.promptInstall()).resolves.toBe("unavailable");
    expect(offer.prompts).toBe(0);
  });

  it("is installed when the page moves into the app's window, and stays so back in a tab", async () => {
    const { install, media } = await load(MAC(MAC_CHROME));
    install.listenForInstall();
    expect(install.installState.value).toBe("chromium");
    media.set("(display-mode: standalone)", true);
    expect(install.installState.value).toBe("installed");
    media.set("(display-mode: standalone)", false);
    expect(install.installState.value).toBe("installed");
  });

  it("knows the installed app at load, from the display mode or navigator.standalone", async () => {
    for (const mode of ["(display-mode: standalone)", "(display-mode: minimal-ui)", "(display-mode: window-controls-overlay)"]) {
      const { install } = await load(WINDOWS(WINDOWS_CHROME), { media: { [mode]: true } });
      expect(install.installState.value).toBe("installed");
      expect(install.canOfferInstall.value).toBe(false);
    }
    const { install } = await load(IPHONE(IPHONE_SAFARI_26), { standalone: true });
    expect(install.installState.value).toBe("installed");
    // Chrome's own full screen (F11) is a tab, not the app.
    const fullscreen = await load(WINDOWS(WINDOWS_CHROME), { media: { "(display-mode: fullscreen)": true } });
    expect(fullscreen.install.installState.value).toBe("chromium");
  });

  it("offers the browser's menu after a dismissal even where the user agent said none", async () => {
    const { install, win } = await load(["SomeBrowser/1.0", "", 0]);
    expect(install.installState.value).toBe("none");
    expect(install.canOfferInstall.value).toBe(false);
    install.listenForInstall();
    win.dispatchEvent(new FakeInstallPrompt("dismissed"));
    expect(install.installState.value).toBe("prompt");
    await install.promptInstall();
    expect(install.installState.value).toBe("chromium");
  });

  it("listens only once", async () => {
    const { install, win, media, add } = await load(WINDOWS(WINDOWS_CHROME));
    install.listenForInstall();
    install.listenForInstall();
    expect(add.mock.calls.filter(([type]) => type === "beforeinstallprompt")).toHaveLength(1);
    expect(add.mock.calls.filter(([type]) => type === "appinstalled")).toHaveLength(1);
    expect(media.listeners("(display-mode: standalone)")).toBe(1);
    const offer = new FakeInstallPrompt("dismissed");
    win.dispatchEvent(offer);
    expect(install.installState.value).toBe("prompt");
  });

  it("states the iOS, in-app and other states from the browser it runs in", async () => {
    expect((await load(IPHONE(IPHONE_SAFARI_26))).install.installState.value).toBe("ios-safari");
    expect((await load(IPHONE(IOS_INSTAGRAM))).install.installState.value).toBe("in-app");
    expect((await load(MAC(MAC_FIREFOX))).install.canOfferInstall.value).toBe(false);
    expect((await load(WINDOWS(WINDOWS_FIREFOX_143))).install.canOfferInstall.value).toBe(true);
    expect((await load(DESKTOP_SITE(ANDROID_FIREFOX_DESKTOP_SITE))).install.installState.value).toBe("firefox-android");
    expect((await load(WINDOWS(WINDOWS_OPERA))).install.canOfferInstall.value).toBe(false);
  });

  it("says whether this browser runs on Android, Desktop site mode included (Chromium's steps)", async () => {
    expect((await load(ANDROID(ANDROID_CHROME))).install.installOnAndroid()).toBe(true);
    expect((await load(DESKTOP_SITE(ANDROID_CHROME_DESKTOP_SITE))).install.installOnAndroid()).toBe(true);
    expect((await load(LINUX(LINUX_CHROME))).install.installOnAndroid()).toBe(false);
    expect((await load(LINUX_TOUCH(LINUX_CHROME))).install.installOnAndroid()).toBe(false);
    expect((await load(WINDOWS(WINDOWS_EDGE))).install.installOnAndroid()).toBe(false);
  });

  it("does nothing without a browser (Node)", async () => {
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("navigator", undefined);
    vi.stubGlobal("localStorage", undefined);
    vi.resetModules();
    const install: Install = await import("../src/platform/install");
    expect(() => install.listenForInstall()).not.toThrow();
    expect(install.installState.value).toBe("none");
    expect(install.canOfferInstall.value).toBe(false);
    expect(install.installOnAndroid()).toBe(false);
    await expect(install.promptInstall()).resolves.toBe("unavailable");
  });
});

// ---------------------------------------------------------------------------------------------
// The installed app opened again in a tab of the same browser: Chromium fires no
// beforeinstallprompt then, and the page runs in a tab, so only the device can remember it.

describe("remembering the install on this device", () => {
  beforeEach(() => { vi.unstubAllGlobals(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("remembers the browser's own install (appinstalled): a later tab offers nothing", async () => {
    const { install, win, storage } = await load(WINDOWS(WINDOWS_CHROME));
    install.listenForInstall();
    expect(storage.items.has(INSTALLED_KEY)).toBe(false);
    win.dispatchEvent(new Event("appinstalled"));
    expect(storage.items.get(INSTALLED_KEY)).toBe("1");

    const later = await load(WINDOWS(WINDOWS_CHROME), { storage });
    later.install.listenForInstall();
    expect(later.install.installState.value).toBe("installed");
    expect(later.install.canOfferInstall.value).toBe(false);
  });

  it("remembers an install accepted in our prompt", async () => {
    const { install, win, storage } = await load(ANDROID(ANDROID_CHROME));
    install.listenForInstall();
    win.dispatchEvent(new FakeInstallPrompt("accepted"));
    await expect(install.promptInstall()).resolves.toBe("accepted");
    expect(storage.items.get(INSTALLED_KEY)).toBe("1");
    expect((await load(ANDROID(ANDROID_CHROME), { storage })).install.installState.value).toBe("installed");
  });

  it("remembers the app seen running, at load or moved into its window (installed elsewhere, or before)", async () => {
    // An Android WebAPK shares Chrome's storage: opened from the Home Screen once, then a link in Chrome.
    const app = await load(ANDROID(ANDROID_CHROME), { media: { "(display-mode: standalone)": true } });
    app.install.listenForInstall();
    expect(app.storage.items.get(INSTALLED_KEY)).toBe("1");
    expect((await load(ANDROID(ANDROID_CHROME), { storage: app.storage })).install.installState.value).toBe("installed");

    // Desktop: installed from the browser's own address-bar icon, the page moves into the app's window.
    const tab = await load(MAC(MAC_CHROME));
    tab.install.listenForInstall();
    expect(tab.storage.items.has(INSTALLED_KEY)).toBe(false);
    tab.media.set("(display-mode: standalone)", true);
    expect(tab.storage.items.get(INSTALLED_KEY)).toBe("1");
    expect((await load(MAC(MAC_CHROME), { storage: tab.storage })).install.installState.value).toBe("installed");
  });

  it("forgets it when the browser offers to install again (the app was uninstalled)", async () => {
    const storage = fakeStorage();
    storage.items.set(INSTALLED_KEY, "1");
    const { install, win } = await load(WINDOWS(WINDOWS_EDGE), { storage });
    install.listenForInstall();
    expect(install.installState.value).toBe("installed");
    win.dispatchEvent(new FakeInstallPrompt("dismissed"));
    expect(install.installState.value).toBe("prompt");
    expect(storage.items.has(INSTALLED_KEY)).toBe(false);
    await expect(install.promptInstall()).resolves.toBe("dismissed");
    expect(install.installState.value).toBe("chromium"); // the browser's menu, not "installed"
    expect((await load(WINDOWS(WINDOWS_EDGE), { storage })).install.installState.value).toBe("chromium");
  });

  it("takes a new offer after an install in this visit (uninstalled meanwhile)", async () => {
    const { install, win } = await load(WINDOWS(WINDOWS_CHROME));
    install.listenForInstall();
    win.dispatchEvent(new Event("appinstalled"));
    expect(install.installState.value).toBe("installed");
    win.dispatchEvent(new FakeInstallPrompt("accepted"));
    expect(install.installState.value).toBe("prompt");
  });

  it("trusts it only where Chromium would offer it again (other browsers never say it was uninstalled)", async () => {
    const remembered = () => {
      const storage = fakeStorage();
      storage.items.set(INSTALLED_KEY, "1");
      return storage;
    };
    const cases: [Device, InstallState][] = [
      [ANDROID(ANDROID_FIREFOX), "firefox-android"],
      [WINDOWS(WINDOWS_FIREFOX_143), "firefox-windows"],
      [IPHONE(IPHONE_SAFARI_26), "ios-safari"],
      [IPHONE(IOS_CHROME), "ios-other"],
      [IPHONE(IOS_INSTAGRAM), "in-app"],
      [MAC(MAC_SAFARI_26), "mac-safari"],
    ];
    for (const [device, expected] of cases) {
      const { install } = await load(device, { storage: remembered() });
      install.listenForInstall();
      expect(install.installState.value, device[0]).toBe(expected);
    }
  });

  it("works with storage blocked: installed for this visit only", async () => {
    const storage = fakeStorage(true);
    const { install, win } = await load(WINDOWS(WINDOWS_CHROME), { storage });
    expect(() => install.listenForInstall()).not.toThrow();
    expect(install.installState.value).toBe("chromium");
    win.dispatchEvent(new Event("appinstalled"));
    expect(install.installState.value).toBe("installed");
    win.dispatchEvent(new FakeInstallPrompt("dismissed"));
    expect(install.installState.value).toBe("prompt");
    expect((await load(WINDOWS(WINDOWS_CHROME), { storage })).install.installState.value).toBe("chromium");

    const app = await load(ANDROID(ANDROID_CHROME), { storage, media: { "(display-mode: standalone)": true } });
    expect(() => app.install.listenForInstall()).not.toThrow();
    expect(app.install.installState.value).toBe("installed");
  });
});

// ---------------------------------------------------------------------------------------------
// The manifest

describe("the manifest's identity", () => {
  /**
   * The app's id as browsers compute it (W3C Web App Manifest, "processing the id member"):
   * start_url (against the manifest's address, which index.html links as "manifest.webmanifest")
   * when there is no id, otherwise the id parsed against start_url's origin.
   */
  function identity(manifest: { id?: string; start_url?: string }, page: string): string {
    const start = new URL(manifest.start_url ?? ".", new URL("manifest.webmanifest", page));
    const id = manifest.id === undefined ? start : new URL(manifest.id, start.origin);
    id.hash = "";
    return id.href;
  }

  it("is the start page at a domain root and in a sub-folder alike: no explicit id", () => {
    expect(MANIFEST).not.toHaveProperty("id");
    expect(MANIFEST.start_url).toBe("./");
    expect(identity(MANIFEST, "https://pdf.example/")).toBe("https://pdf.example/");
    expect(identity(MANIFEST, "https://user.github.io/pdf-editor/")).toBe("https://user.github.io/pdf-editor/");
    // Why: an id of "./" is the bare origin in a sub-folder, another app (and installed copies would not match).
    expect(identity({ ...MANIFEST, id: "./" }, "https://user.github.io/pdf-editor/")).toBe("https://user.github.io/");
  });
});

describe("the app's address (Copia link)", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("is the start page, without what an in-app browser added", async () => {
    const { appAddress } = await import("../src/platform/install");
    vi.stubGlobal("location", { href: "https://pdf.example/?fbclid=IwAR0abc#top" });
    expect(appAddress()).toBe("https://pdf.example/");
    vi.stubGlobal("location", { href: "https://example.org/tools/pdf/index.html?utm_source=ig" });
    expect(appAddress()).toBe("https://example.org/tools/pdf/");
    vi.stubGlobal("location", undefined);
    expect(appAddress()).toBe("");
  });

  it("copies it when the clipboard takes it, and says so", async () => {
    const { copyAppLink } = await import("../src/platform/install");
    vi.stubGlobal("location", { href: "https://pdf.example/?fbclid=1" });
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await expect(copyAppLink()).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("https://pdf.example/");

    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(async () => { throw new Error("NotAllowedError"); }) } });
    await expect(copyAppLink()).resolves.toBe(false);
    vi.stubGlobal("navigator", {}); // a web view without the clipboard API
    await expect(copyAppLink()).resolves.toBe(false);
    vi.stubGlobal("location", undefined);
    await expect(copyAppLink()).resolves.toBe(false);
  });
});
