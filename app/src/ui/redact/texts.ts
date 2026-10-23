// What Bianchetto and Oscura say, in words: the notes of the waiting area's context bar before it
// is applied (from the engine's preview: "Toglie: «…»", a picture only covered or turned black,
// the fields, links and comments that go whole or stay on top, a drawing crossing the edge,
// attached files), why the engine refuses an area, and the toast after an edit for what the user
// must know (fields or links removed, fields left on other pages, attached files, a file much bigger). Pure
// functions of the engine's facts and the current language (tests/redact-ui.test.ts).
import type { RedactFacts, RedactMode, RedactRefusal, RedactReport } from "../../engine/protocol";
import { locale, t } from "../../i18n";
import { listText, upperFirst } from "../actions";

/** One note of the context bar: what goes, a warning, or the refusal; `useRedact` offers "Usa Oscura". */
export interface AreaNote {
  kind: "removes" | "info" | "warn" | "refused";
  text: string;
  useRedact?: boolean;
}

/** The longest excerpt of the text that goes, in characters (the engine's is short already). */
const MAX_EXCERPT = 80;
/** A redaction that makes the file this much bigger (bytes) is said after it. */
export const GROWTH_TOLD = 1024 * 1024;

/** Why the engine refuses an area, in words (nothing was changed). */
export function refusalText(reason: RedactRefusal): string {
  return t(`redact.refused.${reason}`);
}

/** «name» (IT) or “name” (EN). */
export const quoted = (name: string) => t("redact.quoted", { name });

/** Form fields by name: "il campo «nome»", "i campi «a» e «b»". */
export function fieldsText(names: readonly string[]): string {
  if (names.length === 1) return t("redact.fieldNamed", { name: names[0] });
  return t("redact.fieldsNamed", { names: listText(names.map(quoted)) });
}

/** "1 link", "3 link"; "1 commento", "2 commenti". */
function countText(count: number, one: "redact.linksOne" | "redact.notesOne", many: "redact.links" | "redact.notes"): string {
  return count === 1 ? t(one) : t(many, { count });
}

/** How many fields, links and other annotations `facts` names: one is said in the singular ("Tolto…", "Resta sopra…"). */
const thingsCount = (facts: Pick<RedactFacts, "fields" | "links" | "annotations">) =>
  facts.fields.length + Math.max(0, facts.links) + Math.max(0, facts.annotations);

/** The fields, links and other annotations of `facts`, as a list ("il campo «codice», 1 link e 2 commenti"); "" when none. */
export function thingsText(facts: Pick<RedactFacts, "fields" | "links" | "annotations">): string {
  const items: string[] = [];
  if (facts.fields.length) items.push(fieldsText(facts.fields));
  if (facts.links > 0) items.push(countText(facts.links, "redact.linksOne", "redact.links"));
  if (facts.annotations > 0) items.push(countText(facts.annotations, "redact.notesOne", "redact.notes"));
  return listText(items);
}

/** The excerpt of the text that goes, on one line, cut with "…" when long. */
export function excerpt(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > MAX_EXCERPT ? `${one.slice(0, MAX_EXCERPT - 1).trimEnd()}…` : one;
}

/** "The PDF has 2 attached files: …" (Oscura does not touch them). */
export function attachmentsText(count: number): string {
  return count === 1 ? t("redact.attachmentsOne") : t("redact.attachments", { count });
}

/**
 * The notes for an area before it is applied, from the engine's preview of its page (`facts`;
 * null while it is not known), in `mode`, with the document's attached files: what text goes;
 * Bianchetto over a picture only covers it (with "Usa Oscura"), Oscura turns it black and the file
 * may get bigger; fields, links and comments go whole (Oscura) or stay on top (Bianchetto), and
 * the links wholly inside the area go with Bianchetto too (one thing in the singular); a drawing
 * crosses the edge; Oscura leaves the attached files as they are. "Sotto non c'è testo" only
 * over nothing at all: `facts.text` is the page's text, and a field's value is not in it.
 */
export function previewNotes(facts: RedactFacts | null, mode: RedactMode, attachments: number): AreaNote[] {
  if (!facts) return [];
  const notes: AreaNote[] = [];
  const text = excerpt(facts.text);
  if (text) notes.push({ kind: "removes", text: t("redact.removes", { text }) });
  else if (facts.pictures === 0 && !facts.fields.length) notes.push({ kind: "info", text: t("redact.noText") });
  if (facts.pictures > 0) {
    notes.push(mode === "whiteout"
      ? { kind: "warn", text: t("redact.whiteoutOverImage"), useRedact: true }
      : { kind: "info", text: t("redact.redactOverImage") });
  }
  const things = thingsText(facts);
  const one = thingsCount(facts) === 1;
  if (things) {
    const key = mode === "redact" ? (one ? "redact.goesTooOne" : "redact.goesToo") : one ? "redact.staysOnTopOne" : "redact.staysOnTop";
    notes.push({ kind: "warn", text: t(key, { what: things }) });
  }
  const linksGo = mode === "whiteout" ? facts.linksRemoved ?? 0 : 0; // Oscura counts them in `links`
  if (linksGo > 0) {
    const what = countText(linksGo, "redact.linksOne", "redact.links");
    notes.push({ kind: "warn", text: t(linksGo === 1 ? "redact.goesTooOne" : "redact.goesToo", { what }) });
  }
  if (facts.crossing) notes.push({ kind: "info", text: t("redact.crossing") });
  if (mode === "redact" && attachments > 0) notes.push({ kind: "info", text: attachmentsText(attachments) });
  return notes;
}

/** About `bytes` in megabytes, for people: "5,6 MB" (IT), "5.6 MB". */
export function sizeText(bytes: number): string {
  const mb = Math.max(0.1, Math.round((bytes / (1024 * 1024)) * 10) / 10);
  return `${mb.toLocaleString(locale.value, { maximumFractionDigits: 1 })} MB`;
}

/**
 * What the toast says after an edit, in sentences, only what the user must know: the form fields
 * Oscura removed, the links Bianchetto removed (wholly inside the area), the fields that stay on
 * other pages with their value, the attached files Oscura does not touch, and a file bigger by
 * more than about 1 MB. Empty when there is nothing to say.
 */
export function reportNotes(report: RedactReport, mode: RedactMode): string[] {
  const notes: string[] = [];
  const removed = mode === "redact" ? report.fields : [];
  if (removed.length === 1) notes.push(t("redact.reportFieldOne", { name: removed[0] }));
  else if (removed.length > 1) notes.push(t("redact.reportFields", { names: listText(removed.map(quoted)) }));
  const links = mode === "whiteout" ? report.linksRemoved ?? 0 : 0;
  if (links === 1) notes.push(t("redact.reportLinksOne"));
  else if (links > 1) notes.push(t("redact.reportLinks", { count: links }));
  const elsewhere = report.fieldsElsewhere;
  if (elsewhere.length === 1) notes.push(t("redact.reportElsewhereOne", { name: elsewhere[0] }));
  else if (elsewhere.length > 1) notes.push(t("redact.reportElsewhere", { names: listText(elsewhere.map(quoted)) }));
  if (mode === "redact" && report.attachments > 0) notes.push(attachmentsText(report.attachments));
  if (report.growth >= GROWTH_TOLD) notes.push(t("redact.reportGrowth", { size: sizeText(report.growth) }));
  return notes.map(upperFirst);
}
