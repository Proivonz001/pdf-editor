# PDF Editor app: architecture

The rewrite of PDF Editor. It lives in `app/` while the current single-file editor at the
repository root keeps working; it replaces it once it does everything the old one did.

## Layers

```
┌──────────────── main thread ────────────────┐      ┌──────── Web Worker ────────┐
│ Preact UI (src/app.tsx, src/viewer, src/ui)  │      │ src/engine/worker.ts       │
│   state in @preact/signals                   │ ───▶ │   EngineSession            │
│ src/engine/client.ts (promise RPC)           │ ◀─── │   src/engine/core.js       │
└──────────────────────────────────────────────┘      │   mupdf (WebAssembly)      │
                                                      └────────────────────────────┘
```

- **Engine** (`src/engine/`). MuPDF 1.27.0 in a module Web Worker; the UI never blocks on it.
  `core.js` + `tables.js` come from the validated prototype (`prototypes/mupdf-text/`, 39 test
  cases in Node and Chrome, cross-checked with pdfium). `session.ts` holds one open document and
  the edit history and is plain TypeScript, so the tests run it in Node. `pdfa.ts` converts a
  copy to PDF/A and checks the result, with our own colour profile from `icc.ts` (see "PDF/A").
  `worker.ts` only turns messages into `EngineSession` calls. `protocol.ts` is the contract;
  `client.ts` is the main-thread side.
- **Viewer** (`src/viewer/`). Pages are laid out from their sizes in PDF points; only the pages
  near the screen are rendered, at zoom × devicePixelRatio, and their bitmaps are released when
  they scroll away. Text lines are drawn as an overlay in the same coordinates, with the inline
  line editor and its context bar (Cancel / Apply). The page thumbnails (`Thumbnails.tsx`) have
  their own observers and a separate one-at-a-time render queue, start only once their list is
  still, and release far canvases, so they never delay the pages themselves.
- **UI** (`src/ui/`, `src/app.tsx`), in the "Carta + giallo" style. `app.tsx` lays out a grid
  (`styles/layout.css`) and marks the root `data-layout="phone"` below 640 px, `"desktop"` from
  640 px (`ui/media.ts`):
  - desktop: top bar, tool rail (Browse, Edit text, the panel toggles), thumbnails panel,
    viewer, details panel (from 1200 px). The panels follow the window width until the user
    toggles one; that choice is remembered on the device (`ui/panels.ts`);
  - phone: compact top bar, the viewer, a tab bar at the bottom and bottom sheets for the
    thumbnails and the other actions (`ui/TabBar.tsx`, `ui/Sheet.tsx`, `ui/PhoneSheets.tsx`).

  `ui/actions.ts` holds what the controls do and `src/state.ts` the signals they share.
  Styles are in `src/styles/`: `index.css` imports the tokens, the base, the grid and one file
  per area, `phone.css` last. Colours are defined only in `tokens.css`, light and dark (from the
  system setting); PDF pages stay white in both.
- **Platform** (`src/platform/`, `public/`). Service worker and install (vite-plugin-pwa),
  "Open with" on desktop (`file_handlers` + `launchQueue`), Content-Security-Policy, deploy.
  The engine worker is started from a `blob:` module that imports the worker chunk, so it
  inherits the page's Content-Security-Policy on any host, not only where `_headers` applies.

## Rules carried over from the prototype

1. **Edit whole lines**, never single words in place: there is no reflow, and replacing the
   whole line keeps the reading order of tagged PDFs exact.
2. **Show which characters came from a fallback font** (`EditResult.fallbackChars`).
3. **Keep `replaceText`'s safety steps**: shrunk redaction quads, restored links, font dict
   proved by glyph ids, probed codes, `/ToUnicode` and `/W` extended, replacement tagged on
   tagged pages, vertical-text workarounds.
4. **Save** with `garbage=compact,compress=yes` plus `encrypt=none`, or, for a download
   protected with a password, `encrypt=aes-256` with that password as both user and owner
   password (whoever knows it keeps full control). Subset only the fallback fonts (never
   `subsetFonts()` on the whole document).
5. **Destroy MuPDF objects explicitly** (pages, documents, pixmaps, buffers): a page wrapper
   keeps its whole document alive until the JS garbage collector runs.

## Undo and save

The worker keeps the original bytes, the list of applied edits and a few **checkpoints** (the
document serialized after every 8 edits, at most 12 and 256 MB in total, thinned out so they
stay spread over the whole session). Undo re-opens the nearest checkpoint at or below the target
and replays the edits after it (at most 7 within the last few dozen edits, a few more further
back), so its cost does not grow with the length of the session; a failed edit is rolled back
the same way. If even that fails,
the session is marked broken and the UI stops editing.

Save never replays: it serializes the working document, re-opens the copy, subsets only the
fallback fonts there and writes it, leaving the working document untouched. (When the session
is broken, the copy is the last good state rebuilt from the log.) What is written depends on
the download's `SaveOptions`:

- **Format**: a normal PDF, or PDF/A-2b (next section), which the copy is converted to first.
  A normal-PDF download of an *edited* file that claims PDF/A loses the claim: `dropPdfaClaim`
  (pdfa.ts) removes pdfaid part, conformance, amd and rev from its XMP and leaves the rest of
  the metadata as it was, because nothing re-checked that the edited file still conforms. An
  unedited file keeps its claim.
- **Password**: none; "set", a new one; or "keep", the password the file was opened with (the
  engine keeps it in memory for that), so a protected file stays protected by default. "keep"
  is allowed only when `DocInfo.canKeepPassword` is true, and refused ("bad-request")
  otherwise. It is false when the file needed no password, when `passwordProblem()` refuses
  the password, and when the file was opened with its **owner password only** (MuPDF's
  `authenticatePassword` reports the owner bit without the user bit): the copy has one
  password for both, so keeping the owner password would make it the copy's opening password,
  and the user password the recipients know would stop working.
- **What a password may hold**: `passwordProblem()` (protocol.ts) refuses, besides an empty or
  too long one (more than 127 bytes of UTF-8 makes MuPDF 1.27 fail):
  - what MuPDF cannot carry: it reads its save options as `key=value,key=value`, so a comma
    would cut the password short, and U+0000 cuts the string on its way into MuPDF;
  - anything **SASLprep** (RFC 4013) would change or prohibit. For AES-256, ISO 32000-2 has
    readers prepare the password with SASLprep before hashing it; Acrobat and PDFBox do, while
    MuPDF (which writes the file) and pdf.js hash the bytes as typed. A password SASLprep
    changes would open the copy in some readers and not in others. So refused are: whatever
    NFKC changes (a no-break space, `²`, `º`, `µ`, ligatures, full-width letters, an accent
    typed as a combining mark), the characters it maps to nothing (the emoji variation
    selector U+FE0F, soft hyphen, zero-width characters), controls, private use,
    non-characters, bidi controls, tags, and right-to-left letters mixed with left-to-right
    ones or not at both ends. What is left hashes the same in every reader.
    tests/save.test.ts recomputes the /U hash (ISO 32000-2 Algorithm 2.B) from the UTF-8
    bytes to show that MuPDF hashes them as typed.

  Spaces, quotes, `=`, accents, emoji and CJK all round-trip (tests/save.test.ts). PDF/A takes
  no password: the format forbids encryption.
- **One tap** (`defaultChoice` in `ui/actions.ts`): the password wins over PDF/A (a file that
  needed a password gets a normal PDF, protected with "keep"); a claimed PDF/A without a
  password gets "pdfa-2b"; anything else a normal PDF without password. When the file needed a
  password that cannot be kept (`needsPassword` and not `canKeepPassword`), one tap, Ctrl+S
  and Share open the download options instead of saving, so protection is never dropped
  without asking: the user picks a new password, or none.

Invalid options are refused ("bad-request") before anything is done. The original file is
never changed: every download is a new file, so the digital signatures of a signed file
(`DocInfo.signatures`, signature fields holding a value) are no longer valid in it; the UI
says so.

The edit list is plain data, so it can later be stored for "resume session".

## PDF/A ("PDF/A per l'archivio")

The app writes **PDF/A-2b** (ISO 19005-2, level B: the look is preserved), the level the Italian
AgID guidelines put first among the ones that can be made from an arbitrary PDF. Everything
happens on the device with MuPDF; MuPDF has no PDF/A mode, so `pdfa.ts` builds it from the
object API (ported from the phase 3 prototype). The UI first asks `pdfaCheck`, which runs the
same conversion on a scratch copy and returns the report without writing a file, then saves
with format "pdfa-2b".

What the conversion does, reported as codes the UI turns into words (protocol.ts):

- **Fonts.** Every font used for drawing must be embedded, with widths that agree with the
  program. "Used" is read from the content the way veraPDF reads it: fonts selected with `Tf`
  in the pages, form XObjects, annotation appearances, patterns, soft masks and Type 3 glyphs;
  text in rendering mode 3 (invisible, OCR layers) needs no embedded font, but its font
  dictionary must still be complete (FirstChar, LastChar, Widths: written from MuPDF's
  advances when missing) and it must not draw .notdef. A missing standard
  font, or a metric twin (Arial = Helvetica, Times New Roman = Times, Courier New = Courier),
  gets MuPDF's built-in URW program, keeping its encoding; every code drawn must still draw the
  same glyph, checked before and after through a device ("font-changed" otherwise). The widths
  become the program's; when the file had its own, different widths, text may shift
  ("text-may-shift", confirmed first).
- **Removed, after the user confirms**: JavaScript, other forbidden actions (Launch, Hide,
  most Named actions, additional actions, any action of a form widget or field: PDF/A-2 allows
  none there), attached files, forbidden or hidden annotations,
  the data of a static XFA form; hidden form fields become visible. **Signatures**: a signature
  covers the file's bytes, so any re-save breaks it, and PDF/A forbids a signature whose byte
  range does not cover the file: the signature values are removed (the fields and their
  visible appearance stay), and the UI warns first ("signature-invalid").
- **Silent fixes**: XMP metadata (pdfaid part 2, conformance B, in step with the Info
  dictionary, only predefined schemas), a file `/ID` (MuPDF never creates one; the trailer is
  fetched again right before writing, since one fetched before the first change is detached),
  annotation appearances and flags (buttons get appearance states, other annotations a single
  stream; popups printable), no LZW, no image interpolation, no transfer functions, optional
  content configurations with unique names, CIDSet/CharSet dropped (optional in part 2, often
  stale), CIDToGIDMap /Identity on TrueType CID fonts that lack one (the app's CJK and symbol
  fallback font among them: core.js now writes it too), XMP removed from objects other than
  the catalog, unknown rendering intents made RelativeColorimetric, AlternatePresentations and
  PresSteps removed, `/Type /Font` on font dictionaries.
- **Blockers** (no file is written; the UI offers a normal PDF instead): a font that is not
  embedded and has no standard equivalent, .notdef glyphs drawn, widths that disagree inside an
  embedded font (fixing them would move text), DeviceCMYK without a CMYK output intent or a
  DefaultCMYK the file already declares (we ship no CMYK profile: none has a clear enough
  licence), a broken or too new ICC profile, dynamic XFA forms, portfolios, content in other
  files (reference or PostScript XObjects, external streams). Colours and .notdef are looked
  for in the content as written, in every layer and appearance state, not only in what MuPDF
  draws, so a hidden layer cannot hide a blocker.

**Colour profile.** The output intent carries our own sRGB profile, generated in code
(`icc.ts`): ICC version 2.1 (valid for PDF/A-1 and -2), a display profile with the
Bradford-adapted sRGB primaries, D50 white and the sRGB tone curve sampled at 1024 points;
always the same 2.5 KB. Widely copied profiles (ICC's sRGB2014, the Artifex ones inside MuPDF)
have licence terms of their own or unclear ones, and a PDF/A file hands its profile to whoever
receives it. A file that already has one valid output intent (a display or printer profile)
keeps it: an RGB one, or a CMYK one when nothing is painted in RGB.

**Fonts' licence.** The fonts embedded are MuPDF's built-in URW base-35 programs (Nimbus Sans,
Nimbus Roman, Nimbus Mono PS, Standard Symbols PS, Dingbats), the same the app already writes
into edited PDFs as fallback fonts. `THIRD_PARTY_NOTICES.md` lists them under the SIL Open Font
License 1.1, as shipped in MuPDF, whose requirements do not extend to documents made with the
fonts; URW's AGPL release of the same fonts has an explicit exception for embedding them in
PDF and PostScript documents. Embedded whole (about 30 KB each), not subset.

**The engine's check.** After writing, `checkPdfA` re-opens the bytes and checks what the
engine knows of PDF/A-2b: header and end of file, no encryption, `/ID`, one output intent with
a valid profile, XMP present, uncompressed and in step with Info, no forbidden actions,
annotations, attachments, XFA or signatures, fonts used embedded with consistent widths, no
DeviceCMYK, no .notdef. A file that fails it is never handed out: the save fails with an
"engine" error (a bug to fix, not a file to download). The success message says "the app's
checks passed", never "certified".

**veraPDF in CI.** The reference validator is a Java program, so it cannot run in the browser
or in the Node tests. With the environment variable `PDFA_OUT` set, `tests/pdfa.test.ts` writes
every converted test file there, and the files the app must refuse to `PDFA_OUT/refused/`; the
"pdfa" job in `.github/workflows/app.yml` runs veraPDF (pinned by digest) on both and fails
when a converted file is not compliant. Real conformance is established there, not by the
engine's check.

Not handled yet, so files that need them may fail veraPDF and must be caught there: PDF 2.0
input (MuPDF writes the source's version in the header, PDF/A-2 wants 1.n), implementation
limits (string and name lengths, nesting), JPEG 2000 details, the TrueType cmap and encoding
rules, inline images with interpolation, widths of Type 0 fonts with a CMap other than
Identity-H. PDF/A-1b, -2u and -3 are possible later steps.

## Characters outside the Basic Multilingual Plane

MuPDF.js 1.27 reports characters above U+FFFF (math italic letters, emoji) truncated to 16 bits.
The engine detects them from the drawn glyphs and marks those lines `editable: false` instead
of rewriting them with the wrong character.

## MuPDF version

Pinned to **1.27.0**, the version the prototype validated. MuPDF 1.28.1 fails one case: after
two edits on the same page with Type3 fonts (matplotlib charts), the second redaction shifts a
neighbouring label by 36 pt. `tests/engine.test.ts` keeps that case so an upgrade is checked.
CVE-2026-7233 (out-of-bounds read in CFF subsetting, fixed after 1.28.0) is not reachable
here: the app only subsets its own built-in fallback fonts, never the fonts of a user's PDF,
and in the browser MuPDF runs inside the WebAssembly sandbox.
