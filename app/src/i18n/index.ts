// Translations: a `locale` signal and t(key, params).
//
// The language follows the browser ("it" when navigator.language starts with "it", English
// otherwise) until the user picks one with the toggle; that choice is remembered. Components
// that call t() during render re-render by themselves when the locale changes, because t()
// reads the signal.
import { effect, signal } from "@preact/signals";
import { en, type MessageKey, type Messages } from "./en";
import { it } from "./it";

export type Locale = "en" | "it";
export type { MessageKey };

const STORAGE_KEY = "pdf-editor.locale";
const dictionaries: Record<Locale, Messages> = { en, it };

/** Display name of each language, in that language (for the toggle). */
export const LOCALE_NAMES: Record<Locale, string> = { en: "English", it: "Italiano" };

function initialLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "en" || saved === "it") return saved;
  } catch {
    // Storage blocked (private mode, sandbox): fall back to the browser language.
  }
  return (navigator.language || "").toLowerCase().startsWith("it") ? "it" : "en";
}

export const locale = signal<Locale>(initialLocale());

// Keep <html lang> in sync, so screen readers pronounce the UI in the right language.
effect(() => {
  document.documentElement.lang = locale.value;
});

export function setLocale(next: Locale) {
  locale.value = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Not remembered: fine, it still applies to this visit.
  }
}

export function toggleLocale() {
  setLocale(locale.value === "it" ? "en" : "it");
}

/** The language the toggle switches to. */
export function otherLocale(): Locale {
  return locale.value === "it" ? "en" : "it";
}

// Placeholder names of an English message, e.g. "Page {page} of {count}" → "page" | "count".
type ParamNames<S extends string> = S extends `${string}{${infer P}}${infer Rest}` ? P | ParamNames<Rest> : never;
type Params<K extends MessageKey> = Record<ParamNames<(typeof en)[K]>, string | number>;
type Args<K extends MessageKey> = [ParamNames<(typeof en)[K]>] extends [never] ? [] : [params: Params<K>];

/** Translate `key` into the current locale, filling in its {placeholders}. */
export function t<K extends MessageKey>(key: K, ...args: Args<K>): string {
  const text: string = dictionaries[locale.value][key] ?? en[key];
  const params = args[0] as Record<string, string | number> | undefined;
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}
