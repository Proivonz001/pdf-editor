// "Install the app" (the "install" dialog, opened by openInstall in ui/actions.ts where the
// browser has no install dialog of its own ready): why it is worth it (it opens like the other
// apps, works without a connection, the files still never leave the device), then how, for this
// browser (installState, platform/install.ts):
// - Safari on iPhone and iPad: 3 steps that hold on iOS 26 and on iOS 18 (Share, in Safari's bar
//   or first under •••; Add to Home Screen, further down or under "View More"; Add, with "Open as
//   Web App" left on where iOS 26 shows it), with our own small drawings of the Share button and
//   of "Add to Home Screen";
// - the other iOS browsers: their Share menu, or Safari, with "Copy link";
// - in-app browsers (Instagram, Facebook...): open the page in the browser first, with "Copy
//   link" (and the address shown, selected, when the clipboard refuses);
// - Chrome and Edge on the computer, Chromium on Android (installOnAndroid: "Desktop site" mode
//   too), Safari on the Mac (macOS Sonoma or later), Firefox on Android (⋮ › More) and on Windows:
//   that browser's own menu. Chromium's steps also say where an app already installed opens
//   from, should this browser offer it again.
// The browser's offer arriving while it is open adds an "Install" button (its own dialog); the
// app installed meanwhile says so. A dialog on desktop, a bottom sheet on phones, chosen when it
// opens (as the download options); closed, the focus goes back to the page, should the entry that
// opened it be gone (installed meanwhile). The steps are texts of i18n: Safari changes its menus
// between versions. Styled by styles/install.css.
import type { FunctionComponent, RefObject } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { t, type MessageKey } from "../i18n";
import { appAddress, copyAppLink, installOnAndroid, installState, type InstallState } from "../platform/install";
import { dialog, showDialog, type DialogState } from "../state";
import { openInstall, pageFocusTarget } from "./actions";
import { Dialog } from "./Dialog";
import { rescueFocus } from "./focus";
import { IconAddSquare, IconCopy, IconShare } from "./icons";
import { isNarrow } from "./media";
import { Sheet } from "./Sheet";

// ---------------------------------------------------------------------------------------------
// What it says, by state (plain data, tested in tests/install-ui.test.ts)

/** The texts of this dialog (install.*): none of them has a placeholder. */
export type InstallKey = Extract<MessageKey, `install.${string}`>;

/** A small drawing beside a step: the Share button, "Add to Home Screen". */
export type InstallGlyph = "share" | "add";

export interface InstallStep {
  text: InstallKey;
  glyph?: InstallGlyph;
}

export interface InstallContent {
  /** The paragraphs under the title. */
  body: InstallKey[];
  /** The numbered steps (none once installed). */
  steps: InstallStep[];
  /** A line after the steps. */
  note: InstallKey | null;
  /** "Copy link": the page must first be opened in another browser. */
  copyLink: boolean;
  /** "Install": the browser's own install dialog is ready (its offer came while this was open). */
  install: boolean;
}

const steps = (...keys: InstallKey[]): InstallStep[] => keys.map((text) => ({ text }));

/** What the dialog says for `state`; `android`: Chromium's steps are those of its Android menu. */
export function installContent(state: InstallState, android: boolean): InstallContent {
  const plain = { body: ["install.why"] as InstallKey[], note: null, copyLink: false, install: false };
  switch (state) {
    case "installed":
      return { ...plain, body: ["install.done"], steps: [] };
    case "none":
      return { ...plain, body: ["install.none"], steps: [] };
    case "ios-safari":
      return {
        ...plain,
        steps: [
          { text: "install.ios.step1", glyph: "share" },
          { text: "install.ios.step2", glyph: "add" },
          { text: "install.ios.step3" },
        ],
      };
    case "ios-other":
      return {
        ...plain,
        steps: [
          { text: "install.iosOther.step1", glyph: "share" },
          { text: "install.iosOther.step2", glyph: "add" },
          { text: "install.iosOther.step3" },
        ],
        note: "install.iosOther.note",
        copyLink: true,
      };
    case "in-app":
      return {
        ...plain,
        body: ["install.why", "install.inApp.body"],
        steps: steps("install.inApp.step1", "install.inApp.step2", "install.inApp.step3"),
        copyLink: true,
      };
    case "mac-safari":
      // Add to Dock needs macOS Sonoma, and Safari's user agent cannot say which macOS it runs on.
      return {
        ...plain,
        steps: steps("install.mac.step1", "install.mac.step2", "install.mac.step3"),
        note: "install.mac.note",
      };
    case "firefox-android":
      return {
        ...plain,
        steps: steps("install.firefoxAndroid.step1", "install.firefoxAndroid.step2", "install.firefoxAndroid.step3"),
      };
    case "firefox-windows":
      return { ...plain, steps: steps("install.firefoxWindows.step1", "install.firefoxWindows.step2") };
    case "prompt":
    case "chromium": {
      const menu = android
        ? steps("install.android.step1", "install.android.step2", "install.android.step3")
        : steps("install.chromium.step1", "install.chromium.step2", "install.chromium.step3");
      // No offer from the browser: the app may be installed already (Chromium offers nothing
      // then), and this device does not remember it. Where it opens from, so this is no dead end.
      const note: InstallKey | null = state === "prompt" ? null : android ? "install.android.note" : "install.chromium.note";
      return { ...plain, steps: menu, note, install: state === "prompt" };
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The dialog

const GLYPHS: Record<InstallGlyph, FunctionComponent> = { share: IconShare, add: IconAddSquare };

/** The numbered steps, each with its small drawing when it has one (hook-free: the tests call it). */
export function InstallSteps({ steps: list }: { steps: readonly InstallStep[] }) {
  if (!list.length) return null;
  return (
    <ol class="install-steps" role="list">
      {list.map((step, i) => {
        const Glyph = step.glyph ? GLYPHS[step.glyph] : null;
        return (
          <li key={step.text} class="install-step">
            <span class="install-step-num" aria-hidden="true">{i + 1}</span>
            <span class="install-step-text">{t(step.text)}</span>
            {Glyph && <span class="install-glyph" aria-hidden="true"><Glyph /></span>}
          </li>
        );
      })}
    </ol>
  );
}

/** What the taps on "Copy link" came to: how many so far, and whether the last one copied. */
export interface CopyOutcome {
  n: number;
  copied: boolean;
}

/** The outcome after one more tap on "Copy link" (`copied`: copyAppLink's answer). */
export function nextCopyOutcome(prev: CopyOutcome | null, copied: boolean): CopyOutcome {
  return { n: (prev?.n ?? 0) + 1, copied };
}

/**
 * The clipboard refused: the address field (just shown) takes the focus, all of it selected, for
 * the system's own Copy. Nothing once copied.
 */
export function revealAddress(outcome: CopyOutcome | null, field: HTMLInputElement | null) {
  if (!outcome || outcome.copied || !field) return;
  field.focus();
  field.select();
}

/**
 * "Copy link" as it shows for `outcome`: the button, the status line saying what came of the
 * last tap (the toasts are outside the modal, inert while it is open) and, when the clipboard
 * refused, the address in a read-only field (`field`). Hook-free (the tests call it).
 */
export function CopyLinkView({ outcome, onCopy, field }: {
  outcome: CopyOutcome | null;
  onCopy: () => void;
  field: RefObject<HTMLInputElement>;
}) {
  return (
    <div class="install-link">
      <button type="button" class="btn btn-secondary" onClick={onCopy}>
        <IconCopy />
        <span>{t("install.copyLink")}</span>
      </button>
      {/* Always in the page; `n` makes the same words a new message, so a second tap is heard too. */}
      <p class="install-copy-status" role="status">
        {outcome && <span key={outcome.n}>{t(outcome.copied ? "install.copied" : "install.copyFailed")}</span>}
      </p>
      {outcome && !outcome.copied && (
        <input
          ref={field}
          class="field install-address"
          type="text"
          readOnly
          value={appAddress()}
          aria-label={t("install.address")}
          spellcheck={false}
          onFocus={(e) => e.currentTarget.select()}
        />
      )}
    </div>
  );
}

/** "Copy link", and what came of it (CopyLinkView); refused, the address to copy by hand (revealAddress). */
function CopyLink() {
  const [outcome, setOutcome] = useState<CopyOutcome | null>(null);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => revealAddress(outcome, field.current), [outcome]);
  const copy = async () => {
    const copied = await copyAppLink();
    setOutcome((o) => nextCopyOutcome(o, copied));
  };
  return <CopyLinkView outcome={outcome} onCopy={() => void copy()} field={field} />;
}

/**
 * What the dialog and the sheet hold: the title (the sheet has its own), the why, this browser's
 * steps, "Copy link" where the page must be opened elsewhere, Close, and Install once the
 * browser's own dialog is ready. Hook-free (the tests call it); it follows installState.
 */
export function InstallBody({ heading, onClose }: { heading: boolean; onClose: () => void }) {
  const content = installContent(installState.value, installOnAndroid());
  return (
    <div class="install-body">
      {heading && <h2 id="dlg-title" class="dialog-title">{t("install.title")}</h2>}
      <div id="dlg-body" class="install-text">
        {content.body.map((key) => <p key={key}>{t(key)}</p>)}
      </div>
      <InstallSteps steps={content.steps} />
      {content.note && <p class="install-note">{t(content.note)}</p>}
      {content.copyLink && <CopyLink />}
      <div class="dialog-actions">
        <button type="button" class={content.install ? "btn btn-secondary" : "btn btn-primary"}
          data-autofocus={!content.install || undefined} onClick={onClose}>
          {t("common.close")}
        </button>
        {content.install && (
          <button
            type="button"
            class="btn btn-primary"
            data-autofocus
            onClick={() => {
              onClose();
              void openInstall(); // the browser's own dialog, still within this click
            }}
          >
            {t("install.install")}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Close the steps `state` (Close, Escape, Install). The modal gives the focus back to the entry
 * that opened it; should that be gone (the app installed meanwhile, from the browser's own menu:
 * nothing is offered any more), the page takes it rather than <body>.
 */
export function closeInstall(state: Extract<DialogState, { kind: "install" }>) {
  if (dialog.peek() === state) showDialog(null);
  rescueFocus(pageFocusTarget);
}

/** "Install the app": a dialog on desktop, a bottom sheet on phones. */
export function InstallDialog({ state }: { state: Extract<DialogState, { kind: "install" }> }) {
  // Chosen once, when it opens (Dialogs.tsx mounts it afresh for each opening), as the download
  // options: either one works at any width.
  const [narrow] = useState(() => isNarrow.peek());
  const close = () => closeInstall(state);
  if (narrow) {
    return (
      <Sheet title={t("install.title")} class="sheet-install" onClose={close}>
        <InstallBody heading={false} onClose={close} />
      </Sheet>
    );
  }
  return (
    <Dialog labelledBy="dlg-title" describedBy="dlg-body" onCancel={close}>
      <InstallBody heading onClose={close} />
    </Dialog>
  );
}
