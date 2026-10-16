// Saving with options (EngineSession.save): format, passwords kept, set or removed, invalid
// options refused; passwordProblem against what MuPDF's save options really carry and what
// SASLprep (the password preparation of Acrobat and PDFBox) would change; and the DocInfo fields
// that drive the download choices (needsPassword, canKeepPassword, signatures, pdfa).
import { createCipheriv, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as mupdf from "mupdf";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_PASSWORD_BYTES, passwordProblem, type SaveOptions } from "../src/engine/protocol";
import { EngineSession, SessionError } from "../src/engine/session";

/**
 * The engine's PDF/A check, able to fail on demand (a conversion that did not land in the
 * file), and core.replaceText, able to fail (to break a session, as in engine.test.ts).
 */
const inject = vi.hoisted(() => ({ checkFails: false, editFails: false }));
vi.mock("../src/engine/pdfa", async (importOriginal) => {
  const pdfa = await importOriginal<typeof import("../src/engine/pdfa")>();
  return {
    ...pdfa,
    checkPdfA: (...args: Parameters<typeof pdfa.checkPdfA>) => (inject.checkFails ? ["injected problem"] : pdfa.checkPdfA(...args)),
  };
});
vi.mock("../src/engine/core.js", async (importOriginal) => {
  const core = await importOriginal<typeof import("../src/engine/core.js")>();
  return {
    ...core,
    replaceText(...args: Parameters<typeof core.replaceText>) {
      if (inject.editFails) throw new Error("injected failure");
      return core.replaceText(...args);
    },
  };
});
beforeEach(() => {
  inject.checkFails = false;
  inject.editFails = false;
});

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const PLAIN: SaveOptions = { format: "pdf", password: { mode: "none" } };
const KEEP: SaveOptions = { format: "pdf", password: { mode: "keep" } };
const withPassword = (password: string): SaveOptions => ({ format: "pdf", password: { mode: "set", password } });

function session(name: string, password?: string) {
  const s = new EngineSession(mupdf);
  const r = s.open(fixture(name), password);
  if (!r.ok) throw new Error(`${name} did not open: ${r.reason}`);
  return s;
}

const texts = (s: EngineSession) => s.lines(0).map((l) => l.text.trim());

/** The saved file opens only with `password`, which gives full (owner) rights, encrypted with AES-256. */
function expectProtected(bytes: ArrayBuffer, password: string) {
  const s = new EngineSession(mupdf);
  expect(s.open(bytes)).toEqual({ ok: false, reason: "password-required" });
  expect(s.open(bytes, password === "sbagliata" ? "altra" : "sbagliata")).toEqual({ ok: false, reason: "wrong-password" });
  const r = s.open(bytes, password);
  expect(r).toMatchObject({ ok: true, needsPassword: true, encrypted: true });
  const doc = mupdf.Document.openDocument(new Uint8Array(bytes), "application/pdf");
  try {
    expect(doc.getMetaData("encryption")).toMatch(/256-bit AES/);
    expect(doc.authenticatePassword(password) & 4).toBe(4); // owner
  } finally {
    doc.destroy();
  }
  return s;
}

function expectSessionError(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(SessionError);
    expect((err as SessionError).code).toBe(code);
    return;
  }
  throw new Error(`expected a SessionError "${code}"`);
}

/** A PDF made here with MuPDF. */
function makePdf(build: (doc: mupdf.PDFDocument) => void, options = ""): Uint8Array {
  const doc = new mupdf.PDFDocument();
  try {
    doc.insertPage(-1, doc.addPage([0, 0, 200, 100], 0, {}, "0 0 1 rg 10 10 50 50 re f"));
    build(doc);
    const buf = doc.saveToBuffer(options);
    try {
      return buf.asUint8Array().slice();
    } finally {
      buf.destroy();
    }
  } finally {
    doc.destroy();
  }
}

function infoOf(bytes: Uint8Array, password?: string) {
  const r = new EngineSession(mupdf).open(bytes, password);
  if (!r.ok) throw new Error(`did not open: ${r.reason}`);
  return r;
}

/** A PDF made here, protected with AES-256 and `password` as user and owner password. */
const protectedPdf = (password: string) => makePdf(() => {}, `encrypt=aes-256,user-password=${password},owner-password=${password}`);

/**
 * ISO 32000-2 Algorithm 2.B for the user password (no user key data): the hash an AES-256 file
 * stores in the first 32 bytes of /U, from the password bytes and the validation salt after them.
 */
function hash2B(password: Uint8Array, salt: Uint8Array): Buffer {
  let k = createHash("sha256").update(password).update(salt).digest();
  for (let round = 1; ; round++) {
    const k1 = Buffer.concat(Array<Uint8Array>(64).fill(Buffer.concat([password, k])));
    const aes = createCipheriv("aes-128-cbc", k.subarray(0, 16), k.subarray(16, 32)).setAutoPadding(false);
    const e = Buffer.concat([aes.update(k1), aes.final()]);
    const sum = e.subarray(0, 16).reduce((n, b) => n + b, 0);
    k = createHash(["sha256", "sha384", "sha512"][sum % 3]).update(e).digest();
    if (round >= 64 && e[e.length - 1] <= round - 32) return k.subarray(0, 32);
  }
}

/** Whether the /U of an AES-256 file is the hash of exactly these UTF-8 bytes. */
function userHashOf(bytes: Uint8Array | ArrayBuffer, password: string): boolean {
  const doc = mupdf.Document.openDocument(new Uint8Array(bytes), "application/pdf").asPDF()!;
  try {
    const u = doc.getTrailer().get("Encrypt").get("U").asByteString();
    return hash2B(new TextEncoder().encode(password), u.subarray(32, 40)).equals(u.subarray(0, 32));
  } finally {
    doc.destroy();
  }
}

// ---------------------------------------------------------------------------------------------

describe("passwordProblem", () => {
  const nul = String.fromCharCode(0), tab = String.fromCharCode(9), del = String.fromCharCode(0x7f);
  it("accepts what MuPDF carries into the file and SASLprep leaves as it is", () => {
    for (const ok of ["a", "a b", " spazi ", "a=b", "virgolette \"doppie\"", "l'apostrofo", "back\\slash", "punto;e:virgola",
      "àèìòù€", "caffè", "😀 emoji", "日本語", "日本語のパスワード", "한국어", "Пароль", "x".repeat(MAX_PASSWORD_BYTES), "é".repeat(63) + "x",
      // Right to left: right-to-left letters at both ends, ASCII digits and spaces between are neutral.
      "שלום", "مرحبا", "שלום 123 שלום", "abc١٢٣" /* Arabic-Indic digits are not right-to-left letters */])
      expect(passwordProblem(ok), JSON.stringify(ok)).toBeNull();
  });
  it("refuses empty, too long and what MuPDF cannot carry", () => {
    expect(passwordProblem("")).toBe("empty");
    expect(passwordProblem("x".repeat(MAX_PASSWORD_BYTES + 1))).toBe("too-long");
    expect(passwordProblem("é".repeat(64))).toBe("too-long"); // 128 bytes in UTF-8
    for (const bad of ["a,b", ",", `a${nul}b`, `a${tab}b`, "riga\nnuova", `x${del}`]) expect(passwordProblem(bad), JSON.stringify(bad)).toBe("unsupported");
  });
  it("refuses what SASLprep would change or prohibit, so every reader hashes the same bytes", () => {
    for (const bad of [
      "pass word", // Option+Space on a Mac: a no-break space, mapped to a space
      "mµller²", "nº1", "ﬁle", // NFKC: µ, ², º, the "fi" ligature
      "ｐａｓｓ", // full-width letters
      "caffè", // the accent typed as a combining mark (NFD)
      "amore❤️", // the emoji variation selector, mapped to nothing
      "a­b", "a​b", "a⁠b", // soft hyphen, zero-width space, word joiner: mapped to nothing
      "a\u0085b", "a b", // controls outside ASCII
      "pua", "a\u{f0000}", // private use
      "a﷐", "a￿", "a\u{1fffe}", // non-characters
      "a‎b", "a‮b", // bidi controls
      "a\u{e0041}", // a tag character
      "a\ud800b", // a lone surrogate
      "⿰x", // an ideographic description character
      "שלוםabc", "abcשלום", // right-to-left mixed with left-to-right letters
      "שלום1", "1שלום", // right-to-left, but not at both ends
      "שלום€שלום", // a non-ASCII neutral next to right-to-left letters: refused to be safe
    ])
      expect(passwordProblem(bad), JSON.stringify(bad)).toBe("unsupported");
  });
  it("judges single characters on their own, so the UI can name the ones to remove", () => {
    // The bidi rule is about the whole password: no single character breaks it.
    for (const ok of ["ש", "1", "a", "١", "ָ"]) expect(passwordProblem(ok), JSON.stringify(ok)).toBeNull();
    for (const bad of [" ", "²", "️", "ａ"]) expect(passwordProblem(bad), JSON.stringify(bad)).toBe("unsupported");
  });
});

describe("save: passwords", () => {
  it("without options, saves a normal PDF without password, as before", () => {
    const s = session("chrome-subset.pdf");
    const r = s.save();
    expect(r.pdfa).toBeNull();
    expect(infoOf(new Uint8Array(r.bytes))).toMatchObject({ encrypted: false, needsPassword: false });
    expect(s.save(PLAIN).bytes.byteLength).toBe(r.bytes.byteLength);
  });

  it("keeps the password the file was opened with", () => {
    const s = session("enc-user-aes128.pdf", "utente");
    s.replaceLine(0, s.lines(0).findIndex((l) => l.text.includes("Note")), "Appunti");
    const again = expectProtected(s.save(KEEP).bytes, "utente");
    expect(texts(again)).toContain("Appunti");
  });

  it("removes it with password none", () => {
    const s = session("enc-user-aes128.pdf", "utente");
    expect(infoOf(new Uint8Array(s.save(PLAIN).bytes))).toMatchObject({ encrypted: false, needsPassword: false });
  });

  it("sets a new password on any file, and the new one replaces the old", () => {
    expectProtected(session("chrome-subset.pdf").save(withPassword("nuova")).bytes, "nuova");
    const s = session("enc-user-aes128.pdf", "utente");
    const bytes = s.save(withPassword("diversa")).bytes;
    expectProtected(bytes, "diversa");
    expect(new EngineSession(mupdf).open(bytes, "utente")).toEqual({ ok: false, reason: "wrong-password" });
  });

  it("round-trips spaces, quotes, =, accents, emoji, CJK and the longest password", () => {
    const s = session("chrome-subset.pdf");
    for (const password of ["a b c", " spazi ", "a=b", "virgolette \"doppie\" e 'semplici'", "back\\slash", "àèìòù€", "😀 emoji",
      "日本語のパスワード", "x".repeat(MAX_PASSWORD_BYTES), "é".repeat(63) + "x"]) {
      const again = expectProtected(s.save(withPassword(password)).bytes, password);
      expect(texts(again)).toContain("Note");
    }
  });

  it("writes the hash of the password's UTF-8 bytes: what SASLprep readers hash too, for every password it accepts", () => {
    const s = session("chrome-subset.pdf");
    for (const password of ["nuova", "àèìòù€", "😀 emoji", "日本語のパスワード", "שלום 123 שלום"]) {
      expect(passwordProblem(password)).toBeNull(); // so SASLprep leaves it as it is
      expect(userHashOf(s.save(withPassword(password)).bytes, password), password).toBe(true);
    }
    // What passwordProblem refuses: MuPDF hashes the no-break space as typed, a reader that
    // applies SASLprep hashes a plain space, so the file would open in one and not the other.
    const nbsp = protectedPdf("pass word");
    expect(userHashOf(nbsp, "pass word")).toBe(true);
    expect(userHashOf(nbsp, "pass word")).toBe(false);
  });

  it("refuses invalid options before doing anything", () => {
    const s = session("chrome-subset.pdf");
    for (const password of ["", "a,b", "x".repeat(MAX_PASSWORD_BYTES + 1), `a${String.fromCharCode(0)}b`, "pass word", "caffè"])
      expectSessionError(() => s.save(withPassword(password)), "bad-request");
    expectSessionError(() => s.save(KEEP), "bad-request"); // opened without a password
    expectSessionError(() => s.save({ format: "pdfa-2b", password: { mode: "set", password: "segreta" } }), "bad-request");
    expectSessionError(() => s.save({ format: "docx" } as unknown as SaveOptions), "bad-request");
    expectSessionError(() => s.save({ format: "pdf", password: { mode: "maybe" } } as unknown as SaveOptions), "bad-request");
    expectSessionError(() => s.save({ format: "pdf", password: { mode: "set" } } as unknown as SaveOptions), "bad-request");
    expect(texts(s)).toContain("Note"); // the session is fine
    const p = session("enc-user-aes128.pdf", "utente");
    expectSessionError(() => p.save({ format: "pdfa-2b", password: { mode: "keep" } }), "bad-request");
  });

  it("a protected file opened with an owner password only is encrypted but needs none", () => {
    const bytes = makePdf(() => {}, "encrypt=aes-256,owner-password=proprietario");
    expect(infoOf(bytes)).toMatchObject({ encrypted: true, needsPassword: false });
    const s = new EngineSession(mupdf);
    s.open(bytes);
    expectSessionError(() => s.save(KEEP), "bad-request");
    expect(infoOf(new Uint8Array(s.save(PLAIN).bytes))).toMatchObject({ encrypted: false });
  });
});

describe("save: PDF/A in the session", () => {
  const PDFA: SaveOptions = { format: "pdfa-2b", password: { mode: "none" } };

  it("returns the bytes and the report, and the copy claims PDF/A-2B", () => {
    const s = session("chrome-subset.pdf");
    const r = s.save(PDFA);
    expect(r.pdfa).toEqual(s.pdfaCheck());
    expect(infoOf(new Uint8Array(r.bytes))).toMatchObject({ pdfa: "2B", encrypted: false });
  });

  it("a file that fails the engine's own check is an engine error, never a download", () => {
    const s = session("chrome-subset.pdf");
    inject.checkFails = true;
    let error: unknown;
    try {
      s.save(PDFA);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(SessionError); // the worker reports it as "engine"
    expect((error as Error).message).toContain("injected problem");
    inject.checkFails = false;
    expect(s.save(PDFA).pdfa).not.toBeNull(); // nothing was left behind
  });

  it("works from the broken state, from the last good state", () => {
    const s = session("enc-user-aes128.pdf", "utente");
    s.replaceLine(0, s.lines(0).findIndex((l) => l.text.includes("Note")), "Appunti");
    inject.editFails = true; // the next edit fails, and so does replaying the first one
    expectSessionError(() => s.replaceLine(0, s.lines(0).findIndex((l) => l.text.includes("Condizioni")), "Patti"), "broken");
    inject.editFails = false;
    expect(s.pdfaCheck().blockers).toEqual([]);
    const pdfa = new EngineSession(mupdf);
    expect(pdfa.open(s.save(PDFA).bytes)).toMatchObject({ ok: true, pdfa: "2B" });
    expect(texts(pdfa)).toContain("Appunti");
    expect(texts(expectProtected(s.save(KEEP).bytes, "utente"))).toContain("Appunti");
  });

  it("needs a document", () => {
    const s = new EngineSession(mupdf);
    expectSessionError(() => s.pdfaCheck(), "no-document");
    expectSessionError(() => s.save(PDFA), "no-document");
  });
});

describe("DocInfo", () => {
  it("needsPassword: only when opening asked for one; canKeepPassword when it can protect a download", () => {
    expect(infoOf(fixture("chrome-subset.pdf"))).toMatchObject({ needsPassword: false, canKeepPassword: false, encrypted: false });
    expect(infoOf(fixture("enc-user-aes128.pdf"), "utente"))
      .toMatchObject({ needsPassword: true, canKeepPassword: true, encrypted: true });
  });

  it("canKeepPassword is false for an opening password passwordProblem refuses, and keep is refused; the rest works", () => {
    const tab = String.fromCharCode(9);
    // A control character MuPDF carries, a no-break space and an accent typed as a combining mark
    // (SASLprep would change both): each opens the file it protects, in MuPDF.
    for (const password of [`a${tab}b`, "pass word", "caffè"]) {
      const bytes = protectedPdf(password);
      expect(infoOf(bytes, password), JSON.stringify(password)).toMatchObject({ needsPassword: true, encrypted: true, canKeepPassword: false });
      const s = new EngineSession(mupdf);
      expect(s.open(bytes, password).ok).toBe(true);
      expectSessionError(() => s.save(KEEP), "bad-request");
      expectProtected(s.save(withPassword("nuova")).bytes, "nuova");
      expect(infoOf(new Uint8Array(s.save(PLAIN).bytes))).toMatchObject({ encrypted: false });
    }
  });

  it("canKeepPassword is false for a password that opened the file but is too long to protect a download", () => {
    // AES-128 uses the first 32 bytes of a password, so 200 characters open this file.
    const bytes = makePdf(() => {}, `encrypt=aes-128,user-password=${"x".repeat(32)},owner-password=${"x".repeat(32)}`);
    const long = "x".repeat(200);
    expect(infoOf(bytes, long)).toMatchObject({ needsPassword: true, canKeepPassword: false });
    const s = new EngineSession(mupdf);
    expect(s.open(bytes, long).ok).toBe(true);
    expectSessionError(() => s.save(KEEP), "bad-request");
    expect(infoOf(bytes, "x".repeat(32))).toMatchObject({ needsPassword: true, canKeepPassword: true });
  });

  it("opened with the owner password: canKeepPassword is false and keep is refused, so the user password keeps working", () => {
    const bytes = makePdf(() => {}, "encrypt=aes-256,user-password=cliente,owner-password=admin-segreta");
    expect(infoOf(bytes, "admin-segreta")).toMatchObject({ needsPassword: true, encrypted: true, canKeepPassword: false });
    const s = new EngineSession(mupdf);
    expect(s.open(bytes, "admin-segreta").ok).toBe(true);
    expectSessionError(() => s.save(KEEP), "bad-request");
    expectProtected(s.save(withPassword("nuova")).bytes, "nuova"); // the session still works
    expect(infoOf(new Uint8Array(s.save(PLAIN).bytes))).toMatchObject({ encrypted: false });

    // Opened with the user password, that one is kept (as the copy's only password).
    expect(s.open(bytes, "cliente")).toMatchObject({ ok: true, needsPassword: true, canKeepPassword: true });
    const kept = s.save(KEEP).bytes;
    expectProtected(kept, "cliente");
    expect(new EngineSession(mupdf).open(kept, "admin-segreta")).toEqual({ ok: false, reason: "wrong-password" });
  });

  it("an edited PDF/A saved as a normal PDF stops claiming PDF/A; an unedited one keeps the claim", () => {
    // A source with a title and an author, so the metadata kept is something to compare.
    const titled = (() => {
      const doc = mupdf.Document.openDocument(fixture("chrome-subset.pdf"), "application/pdf").asPDF()!;
      try {
        doc.setMetaData("info:Title", "Titolo prova");
        doc.setMetaData("info:Author", "Autore");
        const buf = doc.saveToBuffer("");
        try {
          return buf.asUint8Array().slice();
        } finally {
          buf.destroy();
        }
      } finally {
        doc.destroy();
      }
    })();
    const source = new EngineSession(mupdf);
    expect(source.open(titled).ok).toBe(true);
    const pdfa = new Uint8Array(source.save({ format: "pdfa-2b", password: { mode: "none" } }).bytes);
    expect(infoOf(pdfa)).toMatchObject({ pdfa: "2B", title: "Titolo prova" });

    const unedited = new EngineSession(mupdf);
    expect(unedited.open(pdfa)).toMatchObject({ ok: true, pdfa: "2B" });
    expect(infoOf(new Uint8Array(unedited.save(PLAIN).bytes)).pdfa).toBe("2B");

    const edited = new EngineSession(mupdf);
    expect(edited.open(pdfa).ok).toBe(true);
    edited.replaceLine(0, 0, "Riga cambiata");
    const saved = new Uint8Array(edited.save(PLAIN).bytes);
    expect(infoOf(saved).pdfa).toBeNull();

    /** The catalog's XMP packet, as text. */
    const xmpOf = (bytes: Uint8Array) => {
      const doc = mupdf.Document.openDocument(bytes, "application/pdf").asPDF()!;
      try {
        const meta = doc.getTrailer().get("Root").get("Metadata");
        expect(meta.isStream()).toBe(true);
        const buf = meta.readStream();
        try {
          return buf.asString();
        } finally {
          buf.destroy();
        }
      } finally {
        doc.destroy();
      }
    };
    const before = xmpOf(pdfa), after = xmpOf(saved);
    expect(after).toMatch(/^<\?xpacket begin=/);
    expect(after).toContain("<?xpacket end=");
    expect(after).toContain("<dc:title><rdf:Alt><rdf:li xml:lang=\"x-default\">Titolo prova</rdf:li>");
    expect(after).toContain("<rdf:li>Autore</rdf:li>");
    expect(after).toMatch(/<xmp:CreateDate>[^<]+<\/xmp:CreateDate>/);
    expect(after).toMatch(/<pdf:Producer>[^<]+<\/pdf:Producer>/);
    expect(before).toMatch(/pdfaid:(part|conformance)/);
    expect(after).not.toMatch(/pdfaid:(part|conformance|amd|rev)>/);
    // Only the claim went: the rest of the packet is exactly as it was.
    expect(after).toBe(before.replace(/\s*<pdfaid:(part|conformance|amd|rev)>[^<]*<\/pdfaid:\1>/g, ""));
    const doc = mupdf.Document.openDocument(saved, "application/pdf");
    try {
      expect(doc.getMetaData("info:Title")).toBe("Titolo prova");
      expect(doc.getMetaData("info:Author")).toBe("Autore");
    } finally {
      doc.destroy();
    }
  });

  it("signatures: signature fields that hold a signature, through the field tree", () => {
    const bytes = makePdf((doc) => {
      const sig = () => doc.addObject({ Type: "Sig", Filter: "Adobe.PPKLite", ByteRange: [0, 1, 2, 3], Contents: doc.newByteString(new Uint8Array(8)) });
      const signed = doc.addObject({ FT: "Sig", T: "(Firma1)", V: sig() });
      // /FT inherited from the parent: one kid signed, one not.
      const parent = doc.addObject({ FT: "Sig", T: "(Gruppo)" });
      const kidSigned = doc.addObject({ T: "(A)", Parent: parent, V: sig() });
      const kidEmpty = doc.addObject({ T: "(B)", Parent: parent });
      parent.put("Kids", [kidSigned, kidEmpty]);
      const unsigned = doc.addObject({ FT: "Sig", T: "(Vuota)" });
      const text = doc.addObject({ FT: "Tx", T: "(Nome)", V: "(Mario)" });
      doc.getTrailer().get("Root").put("AcroForm", doc.addObject({ Fields: [signed, parent, unsigned, text], SigFlags: 3 }));
    });
    expect(infoOf(bytes).signatures).toBe(2);
    expect(infoOf(fixture("reportlab-form.pdf")).signatures).toBe(0);
  });

  it("pdfa: the claim in the XMP metadata, attribute or element form", () => {
    const withXmp = (xmp: string | null) => makePdf((doc) => {
      if (xmp === null) return;
      const buf = new mupdf.Buffer(xmp);
      doc.getTrailer().get("Root").put("Metadata", doc.addStream(buf, { Type: "Metadata", Subtype: "XML" }));
      buf.destroy();
    });
    const rdf = (body: string, ns = "pdfaid") =>
      `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
      `<rdf:Description rdf:about="" xmlns:${ns}="http://www.aiim.org/pdfa/ns/id/" ${body}</rdf:Description></rdf:RDF></x:xmpmeta>`;
    expect(infoOf(withXmp(rdf(`pdfaid:part="1" pdfaid:conformance="A">`))).pdfa).toBe("1A");
    expect(infoOf(withXmp(rdf(`><pdfaid:part>2</pdfaid:part><pdfaid:conformance>b</pdfaid:conformance>`))).pdfa).toBe("2B");
    expect(infoOf(withXmp(rdf(`><id:part>3</id:part><id:conformance>U</id:conformance>`, "id"))).pdfa).toBe("3U");
    expect(infoOf(withXmp(rdf(`><pdfaid:part>4</pdfaid:part>`))).pdfa).toBe("4");
    expect(infoOf(withXmp(rdf(`><dc:title>niente</dc:title>`))).pdfa).toBeNull();
    expect(infoOf(withXmp("not xml at all <<<")).pdfa).toBeNull();
    expect(infoOf(withXmp(null)).pdfa).toBeNull();
  });
});
