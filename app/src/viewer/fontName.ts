// Readable names for the fonts of a PDF, as the engine reports them ("ABCDEF+Helvetica-Bold",
// "TimesNewRomanPSMT"): for the details panel and the inline line editor.

const SUBSET_TAG = /^[A-Z]{6}\+/;

/**
 * The family as written in the file, without the subset tag, the style suffix and the
 * PostScript "MT/PS" endings: "ABCDEF+TimesNewRomanPS-BoldMT" → "TimesNewRoman". Only letters,
 * digits and spaces are kept (the name comes from the file). Empty when nothing is left.
 */
export function fontRawFamily(fontName: string): string {
  return fontName
    .replace(SUBSET_TAG, "")
    .split(/[-,]/)[0]
    .replace(/(PSMT|PS|MT)$/, "")
    .replace(/[^A-Za-z0-9 ]/g, "")
    .trim();
}

/** fontRawFamily() with spaces between the words: "TimesNewRoman" → "Times New Roman". */
export function fontDisplayName(fontName: string): string {
  return fontRawFamily(fontName).replace(/([a-z])([A-Z])/g, "$1 $2");
}

/** A subset font holds only the characters the document uses ("ABCDEF+" before the name). */
export function isSubsetFont(fontName: string): boolean {
  return SUBSET_TAG.test(fontName);
}
