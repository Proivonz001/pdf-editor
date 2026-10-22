// Cerca's bars (release 5):
// - FindBar, desktop: a row docked at the top of the viewer, above the signed notice and the tool's
//   banner (viewer/Viewer.tsx mounts it and counts it in its scroll compensation), in every tool:
//   the search field, the count ("3 di 12"), what is going on ("Cerco… pagina 37 di 220", "Nessun
//   risultato", a wrap), ▲ ▼, the Opzioni menu and ✕;
// - PhoneSearch, phones: the same in place of the top bar's content (TopBar.tsx): ← (close), the
//   field with "3/12" inside it, ▲ ▼ and Opzioni, and what is going on in a line under the bar;
// - SearchToggle, the phone top bar's magnifier, and SearchKeeper, the hidden field it gives the
//   focus to within the tap: iOS brings up its keyboard only for a focus given during the user's
//   gesture, and the search field appears only once the bar is drawn again (it then takes the
//   focus, and what was typed meanwhile, from the hidden field).
// The bar is a search landmark; Esc anywhere in it closes the search (ui/search/state.ts says
// where the focus goes), Enter in the field goes to the next result and Shift+Enter to the
// previous one (F3 and Ctrl+G, with Shift, too: ui/shortcuts.ts). Opzioni is a menu of three
// check boxes that stay open as they are ticked, then "Oscura tutti i risultati…" (the review of
// ui/redact). What happens is said in a polite status region (state.ts, searchStatus). Styled by
// styles/search.css.
import type { ComponentChildren, RefObject } from "preact";
import { useEffect, useId, useLayoutEffect, useRef } from "preact/hooks";
import { MAX_SEARCH_CHARS } from "../../engine/protocol";
import { t } from "../../i18n";
import { IconBack, IconCheck, IconClose, IconNextResult, IconPreviousResult, IconSearch, IconSearchOptions } from "../icons";
import { MenuButton } from "../Menu";
import { openRedactAll } from "../redact/actions";
import {
  closeSearch, goToResult, openSearch, searchCountText, searchFocus, searchInput, searchMenuItems, searchNoteText,
  searchStatus, setSearchInput, setSearchTyping,
} from "./state";

/** A bar's button: an icon with its name, which keeps the focus it is pressed with (WebKit gives none to a tapped button). */
function BarButton(p: { icon: ComponentChildren; label: string; tip?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      class="btn tool"
      aria-label={p.label}
      title={p.tip ?? p.label}
      onClick={(e) => {
        e.currentTarget.focus({ preventScroll: true });
        p.onClick();
      }}
    >
      {p.icon}
    </button>
  );
}

function NavButtons() {
  return (
    <>
      <BarButton icon={<IconPreviousResult />} label={t("search.previous")} tip={t("search.previousTip")}
        onClick={() => goToResult(-1)} />
      <BarButton icon={<IconNextResult />} label={t("search.next")} tip={t("search.nextTip")}
        onClick={() => goToResult(1)} />
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// The field

/**
 * An IME composition is going on: its Enter and Escape are the composition's. Safari ends the
 * composition before the keydown, which then says isComposing false but keyCode 229.
 */
function composing(e: KeyboardEvent): boolean {
  return e.isComposing || e.keyCode === 229;
}

function keeper(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>("[data-search-keeper]");
}

/** What was typed into the hidden field before the search field came; it lets the focus go. */
function takeKept(): string {
  const k = keeper();
  if (!k || document.activeElement !== k) return "";
  const typed = k.value;
  k.value = "";
  return typed;
}

/** The ask for the focus (searchFocus) a field answered last: a field drawn again (at a layout switch) does not take the focus by itself. */
let answered = 0;

function SearchField({ describedBy }: { describedBy: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const ask = searchFocus.value;

  // Asked for the focus (the search opened, Ctrl+F again): take it with the text selected, so
  // typing replaces it; what was typed into the phone's hidden field meanwhile replaces it at once.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || ask === answered) return;
    answered = ask;
    const early = takeKept();
    el.focus({ preventScroll: true });
    if (early) setSearchInput(early);
    else el.select();
  }, [ask]);

  // Gone (the search closed, the layout switched): the bars at the bottom of a phone come back.
  useEffect(() => () => setSearchTyping(false), []);

  return (
    <input
      ref={ref}
      class="search-input"
      type="search"
      value={searchInput.value}
      maxLength={MAX_SEARCH_CHARS}
      autocomplete="off"
      autocapitalize="off"
      spellcheck={false}
      enterKeyHint="search"
      aria-label={t("search.label")}
      aria-describedby={describedBy}
      placeholder={t("search.placeholder")}
      onInput={(e) => setSearchInput(e.currentTarget.value)}
      onFocus={() => setSearchTyping(true)}
      onBlur={() => setSearchTyping(false)}
      onKeyDown={(e) => {
        if (composing(e) || e.key !== "Enter" || e.ctrlKey || e.metaKey || e.altKey) return;
        e.preventDefault();
        goToResult(e.shiftKey ? -1 : 1);
      }}
    />
  );
}

// ---------------------------------------------------------------------------------------------
// Opzioni

/** The options menu (ui/Menu.tsx): its check boxes with a tick column, the same room for the action, so the labels line up. */
function OptionsMenu() {
  const items = searchMenuItems(openRedactAll).map((item) => ({
    ...item,
    icon: <span class="search-menu-check" aria-hidden="true">{item.checked && <IconCheck />}</span>,
  }));
  return <MenuButton label={t("search.options")} icon={<IconSearchOptions />} items={items} />;
}

// ---------------------------------------------------------------------------------------------
// The bars

/** The polite status region: each new message is a new node, so the same words are said again. */
function SearchStatus() {
  const s = searchStatus.value;
  return <p class="sr-only" role="status" aria-live="polite">{s && <span key={s.id}>{s.text}</span>}</p>;
}

/** Esc anywhere in the bar closes the search (the menu keeps its own Escape). */
function onBarKeyDown(e: KeyboardEvent) {
  if (composing(e) || e.key !== "Escape" || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
  e.preventDefault();
  e.stopPropagation(); // not also the next step of Escape (ui/shortcuts.ts)
  closeSearch();
}

/** Desktop: the find bar at the top of the viewer (Viewer.tsx). */
export function FindBar({ elRef }: { elRef: RefObject<HTMLDivElement> }) {
  const countId = useId();
  const noteId = useId();
  const count = searchCountText(false);
  const note = searchNoteText();
  return (
    <div ref={elRef} id="find-bar" class="find-bar" role="search" aria-label={t("search.label")} data-search-bar
      onKeyDown={onBarKeyDown}>
      <div class="search-field">
        <IconSearch />
        <SearchField describedBy={`${countId} ${noteId}`} />
      </div>
      <div class="find-status">
        <span id={countId} class="find-count">{count}</span>
        <span id={noteId} class="find-note" title={note ?? undefined}>{note}</span>
      </div>
      <div class="find-actions">
        <NavButtons />
        <OptionsMenu />
        <BarButton icon={<IconClose />} label={t("search.close")} tip={t("search.closeTip")} onClick={closeSearch} />
      </div>
      <SearchStatus />
    </div>
  );
}

/** Phones: the search in place of the top bar's content (TopBar.tsx), after SearchKeeper. */
export function PhoneSearch() {
  const countId = useId();
  const noteId = useId();
  const count = searchCountText(true);
  const note = searchNoteText();
  return (
    <div class="phone-search" role="search" aria-label={t("search.label")} data-search-bar onKeyDown={onBarKeyDown}>
      <BarButton icon={<IconBack />} label={t("search.close")} onClick={closeSearch} />
      <div class="search-field is-phone">
        <SearchField describedBy={`${countId} ${noteId}`} />
        <span id={countId} class="search-count">{count}</span>
      </div>
      <span id={noteId} class="phone-search-note">{note}</span>
      <NavButtons />
      <OptionsMenu />
      <SearchStatus />
    </div>
  );
}

/**
 * The phone's magnifier (the top bar, between the title and Undo): within the tap the hidden
 * field takes the focus, then the search opens (see the header).
 */
export function SearchToggle() {
  return (
    <button
      type="button"
      class="btn tool"
      data-search-toggle
      aria-label={t("search.open")}
      title={t("search.label")}
      onClick={() => {
        const k = keeper();
        if (k) {
          k.value = "";
          k.focus({ preventScroll: true });
        }
        openSearch();
      }}
    >
      <IconSearch />
    </button>
  );
}

/** The hidden field of the phone top bar that holds the keyboard for the search field (see the header). */
export function SearchKeeper() {
  return <input class="search-keeper" data-search-keeper type="text" tabIndex={-1} aria-hidden="true" autocomplete="off" />;
}
