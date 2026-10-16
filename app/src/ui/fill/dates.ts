// Today's date as "Compila e firma" writes it (the Data sub-tool, and a tap with Data on a text
// field): in the app's language, short ("16/10/2026") or long ("16 ottobre 2026").
//
// Italian is it-IT. English is day first ("16/10/2026", en-GB) unless the browser's first English
// language is exactly en-US: bare "en" resolves to US order in Intl, which would surprise an
// Italian phone whose second language is English (decision D8). A form field that says how it
// wants its date (FieldWidget.format, read from its format script) gets that order instead, when
// the pattern is only numbers.
import type { Locale } from "../../i18n";

export type DateStyle = "short" | "long";

/** The BCP 47 tag the date is formatted with: it-IT, en-US or en-GB. */
export function dateLocale(appLocale: Locale, languages: readonly string[]): string {
  if (appLocale === "it") return "it-IT";
  const english = languages.find((l) => /^en(?:-|$)/i.test(l));
  return english && /^en-us(?:-|$)/i.test(english) ? "en-US" : "en-GB";
}

/**
 * `date` (local time) as text: "short" is two-digit day and month and the full year
 * (16/10/2026, 10/16/2026), "long" the month's name (16 ottobre 2026, 16 October 2026,
 * October 16, 2026). `languages` is navigator.languages.
 */
export function dateText(date: Date, appLocale: Locale, languages: readonly string[], style: DateStyle = "short"): string {
  const options: Intl.DateTimeFormatOptions = style === "short"
    ? { day: "2-digit", month: "2-digit", year: "numeric" }
    : { day: "numeric", month: "long", year: "numeric" };
  return new Intl.DateTimeFormat(dateLocale(appLocale, languages), options).format(date);
}

/**
 * `date` written as an AcroForm date pattern asks (AFDate_FormatEx: "dd/mm/yyyy", "mm.dd.yy",
 * "yyyy-mm-dd", "d/m/yyyy"), or null when the pattern is not only numeric day, month and year
 * (month names, times, anything unknown): the caller then writes dateText.
 */
export function datePattern(date: Date, pattern: string): string | null {
  if (!/[dmy]/i.test(pattern)) return null;
  let out = "";
  let i = 0;
  const p = pattern.toLowerCase();
  while (i < p.length) {
    const ch = p[i];
    let run = 1;
    while (p[i + run] === ch) run++;
    if (ch === "d" && run <= 2) out += pad(date.getDate(), run);
    else if (ch === "m" && run <= 2) out += pad(date.getMonth() + 1, run);
    else if (ch === "y" && run === 4) out += String(date.getFullYear()).padStart(4, "0");
    else if (ch === "y" && run === 2) out += pad(date.getFullYear() % 100, 2);
    else if (/[a-z]/.test(ch)) return null; // a month name, a weekday, a time, or unknown
    else out += pattern.slice(i, i + run);
    i += run;
  }
  return out;
}

/** The field's label or name asks for a date ("Data di nascita", "Date", "nato il"): it gets an "Oggi" chip. */
export function looksLikeDate(text: string): boolean {
  // Field names are often "data_nascita" or "birthDate": split them into words first.
  const words = text.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_.\-]+/g, " ");
  return /\b(?:data|date)\b|\bnat[oa] il\b/i.test(words);
}

function pad(n: number, digits: number): string {
  return String(n).padStart(digits, "0");
}
