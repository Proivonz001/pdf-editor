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
  the edit history and is plain TypeScript, so the tests run it in Node. `images.ts` finds the
  pictures of a page and edits one placement at a time (see "Images"). `forms.ts` lists and
  fills form fields, `newcontent.ts` writes new text and new pictures on a page (see "Fill and
  sign"). `decorations.ts` makes a line's underline, strike-through, links and background follow
  an edit of its text (see "Decorations"). `pages.ts` moves, deletes, copies, turns and adds
  pages (see "Pages, scans and Riprendi"). `search.ts` finds text and `redact.ts` removes what
  lies under an area (see "Cerca, Bianchetto and Oscura"). `pdfa.ts` converts a
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
  - desktop: top bar, tool rail (Browse, Edit, Fill & sign, the panel toggles), thumbnails
    panel, viewer, details panel. Both panels are docked in their own columns at every width,
    so the viewer gets narrower when one opens. Each follows the window width (thumbnails open
    by default from 1024 px, details from 1200 px) until the user toggles it; that one choice is
    remembered on the device (`ui/panels.ts`);
  - phone: compact top bar, the viewer, a tab bar at the bottom and bottom sheets for the
    thumbnails, the other actions and the details (a row of the More sheet, with the panel's
    content, `DetailsContent`) (`ui/TabBar.tsx`, `ui/Sheet.tsx`, `ui/PhoneSheets.tsx`).

  The tools (`tool` in `src/state.ts`, changed only through `setTool`, which first writes what
  is still typed): Edit ("Modifica") has five sub-tools on its bar (`ui/EditBar.tsx`,
  `editTool`, `setEditTool`): Change ("Cambia", where it starts: a line to change, a picture to
  move), Add text ("Aggiungi testo"), Add image ("Aggiungi immagine": the picker; the picture
  lands in the middle of what shows, selected, back on Change), and White-out and Redact
  ("Bianchetto", "Oscura": an area to remove, see "Cerca, Bianchetto and Oscura"). Fill & sign ("Compila e firma",
  `ui/fill/FillBar.tsx`) has Text, Tick, Cross, Date, Sign and Initials, and no picture of its
  own. The two bars share one toolbar (`ui/SubTools.tsx`). The text writer and the boxes of the
  text the user wrote (`viewer/FillLayer.tsx`) serve Fill & sign and Add text alike: `writerOn`
  says when they are on, `writerKind` what a tap writes (always text in Edit).

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
3. **Keep `replaceText`'s safety steps**: shrunk redaction quads, restored links (the same
   objects, in their place: see "Decorations"), font dict
   proved by glyph ids, probed codes, `/ToUnicode` and `/W` extended, replacement tagged on
   tagged pages, vertical-text workarounds.
4. **Save** with `garbage=compact,compress=yes` plus `encrypt=none`, or, for a download
   protected with a password, `encrypt=aes-256` with that password as both user and owner
   password (whoever knows it keeps full control). Subset only the fallback fonts (never
   `subsetFonts()` on the whole document).
5. **Destroy MuPDF objects explicitly** (pages, documents, pixmaps, buffers): a page wrapper
   keeps its whole document alive until the JS garbage collector runs.
6. **MuPDF does not see in-place changes to a resource it has loaded.** It keeps loaded
   resources (fonts, images, colour spaces) in its store, keyed by their PDF object. So
   `core.replaceText` calls `mupdf.emptyStore()` after an edit that extended a font's
   /ToUnicode or /W: without it, the working document kept reading the old font, lines() returned
   U+FFFD for the new characters and a second edit of the line wrote it into the file. It does so
   only then, because emptying the store also drops decoded images, of every page: the next
   render of a page with a large scan decodes it again (measured: 454 ms instead of 75 ms for a
   300 dpi full-page JPEG at scale 2), a cost paid once per such edit, accepted for correctness.
   New code that changes an already-loaded resource in place must do the same, or write a new
   object instead.
7. **What the app adds stays its own** (release 3): every line of text and every picture it
   writes is a marked block of its own (`/PEText`, `/PEImage`), appended with
   `newcontent.appendSafely`, never `core.appendContent`, and changed by rewriting that block,
   never by redaction, which would take whatever lies under it.
8. **Form fields are filled by the app's rules, not MuPDF's setters alone**: MuPDF.js checks
   nothing (read-only, MaxLen, options), draws only WinAnsi text right, and its `toggle()` turns
   on every radio button of a group. See "Fill and sign".

## Undo and save

The worker keeps the original bytes, the list of applied edits and a few **checkpoints** (the
document serialized after every 8 edits, at most 12 and 256 MB in total, thinned out so they
stay spread over the whole session). Undo re-opens the nearest checkpoint at or below the target
and replays the edits after it (at most 7 within the last few dozen edits, a few more further
back), so its cost does not grow with the length of the session; a failed edit is rolled back
the same way. If even that fails, the session is marked broken and the UI stops editing.
Snapshots are written with `compress-images=yes`, which keeps object numbers: pictures MuPDF
holds decoded (a PNG signature, a replacement photo) would otherwise make every checkpoint many
times the size of the file. After each snapshot (a checkpoint, a save, a PDF/A check) the session
carries on with the snapshot re-opened, as undo carries on after a rebuild, so each picture is
compressed once, by the first snapshot after it was placed, not again at every later one.

Save never replays: it serializes the working document, re-opens the copy, subsets only the
fallback fonts there and writes it, leaving what the working document holds untouched (it may
now be that serialization re-opened: see above). Each fallback font keeps the glyphs the copy
still draws with it (its pages' content and annotation appearances, read as they are then:
`core.subsetFallbackFonts`), not every glyph ever written with it: a subset's glyphs tell which
characters were written, so a line deleted or rewritten, a page deleted, or the pages an extract
leaves out would otherwise leave their characters in the file. (When the session
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

Where the browser has a save dialog (`showSaveFilePicker`), the file is there as soon as the
user picks where, and Chromium empties a file picked to be overwritten right then. So when
nothing is written into it afterwards (the engine failed or refused the PDF/A, another document
was opened), `writeDownload` (`ui/actions.ts`) removes it while it is still empty; when writing
into it fails, the bytes already built are downloaded normally instead. No empty PDF is left.

The edit list is plain data, so it can be stored on the device for "Riprendi" (see "Pages, scans
and Riprendi").

## Images

The pictures drawn on a page can be moved, resized, rotated, deleted or replaced, one
**placement** at a time: the same picture drawn twice is two placements (`images.ts`, ported from
the phase 3 prototype; `EngineSession.images`, `transformImage`, `deleteImage`, `replaceImage`,
`renderImage`).

**Finding them.** MuPDF.js 1.27 has no content-stream processor or filter, so `images.ts` walks
the page's content itself: a small lexer, the q/Q/cm stack, Form XObjects (recursively, with
/Matrix, the /BBox clip, /Resources and a loop guard), inline images (BI..ID..EI: skipped by length
when unfiltered or when /L gives it, otherwise up to the first EI between whitespace), clips, soft
masks set with `gs`, marked content, colours set to a pattern, and pages with several content
streams. Names are read as MuPDF reads them: `#xx` escapes decoded (`/Logo#20A` draws the key
"Logo A"), the bytes taken as UTF-8, which is how MuPDF.js gives and looks up keys (a name whose
bytes are not UTF-8 cannot be looked up through MuPDF.js: the gate then locks the page). For each
placement it keeps the painting operation (the Do, the BI..EI, or the Do of the
form holding the image), the image's **own block** (the outermost q..Q, within one stream, that
paints nothing else) and the clips that move with it (set inside that block, or inside the form).
The clips in effect are a list whose tails the states saved by q share, so adding one copies
nothing. The walk is capped: at most 1,000,000 operations (a form's counted each time it is
drawn), 5,000 placements and 2,000,000 clips checked (the clips in effect at each placement,
summed). Past a cap, a page of a few KB that expands into a million placements, or one with tens
of thousands of clips, is listed as MuPDF draws it (5,000 images at most), all locked as
"unreadable", instead of keeping the worker busy for minutes.

**The safety gate.** Then MuPDF's own interpreter runs the page (`runPageContents` with a JS
`Device`) and records every `fillImage` and `fillImageMask` in order, leaving out images inside
tiling patterns and soft-mask groups. Each placement of the walk must be, in order, an image
MuPDF draws at the same matrix (within 0.01 pt): a hidden optional-content layer, an inline image
read wrongly, a broken stream or a `cm` MuPDF reads otherwise fail that, and the page's images
are then listed as MuPDF draws them, all locked as "unreadable". MuPDF may draw images that are
not placements: the cells of a pattern fill smaller than one cell come without `beginTile`, and
a stencil mask painted with a pattern is drawn as a clip and the pattern (the walk leaves those
masks out). Such extra images are accepted only on a page that paints with a pattern or a
Type 3 font; anywhere else they mean the walk missed something, and its blocks cannot be
trusted. The device pass also gives each image's pixel size and visible box (its bounding box
within the clips in effect and the page).

**No exception leaves a device callback.** An error thrown inside a JS device callback (MuPDF
failing to decode a picture, or running out of memory, in a call the callback makes) would unwind
through MuPDF's C frames and corrupt the shared WebAssembly module: after about twenty, every
call fails, saving included, in every session. So every callback catches, the first failure is
kept, the rest of the pass does nothing, and the failure is thrown once `runPageContents` has
returned ("edit-failed" from the session).

**The matrix.** `ImageInfo.matrix` maps the picture's unit square as it is seen, (0, 0) its
top-left corner, onto page space: exactly the matrix MuPDF reports to a device. The PDF image
matrix P has the flip [1 0 0 -1 0 1] in front of it; the flip is its own inverse.

**An edit** changes only the drawing instruction of that one placement, where it is in the
stream. So the painting order stays (text over the picture stays over it), marked content (tags)
and the clips inside the image's own block stay right, and other placements of the same picture
do not change. With X the CTM where the change is made, M = X · P⁻¹ · P′ · X⁻¹:

- when the image's own block starts with `q a b c d e f cm`, M is folded into that cm (twenty
  moves in a row leave the stream the same size);
- otherwise ` M cm` is inserted right after the block's q;
- without a block of its own (a frame stroked in the same block, say), the painting operation is
  wrapped in `q M cm … Q`.

The edited stream is written back into the same stream object, unless another page draws it too
(or the page twice): then into a new one in that page's /Contents only. A new object per edit
would leave a dead copy of the page's content in the working document and in every checkpoint
(snapshots are not garbage collected), a megabyte per drag on a heavy drawing. Numbers are
written in fixed notation: PDF has no exponents. A target must be six finite numbers, not
degenerate, its centre on the page, and each side within 1..14,400 pt, or, for a side already
outside those limits (a 0.5 pt rule, a 1-pixel spacer drawn at 0.75 pt), no further from them
than it is: such a picture can be moved and turned, not made thinner.

**Delete** removes only the painting operation, so q/Q and BDC/EMC stay balanced. **Replace**
draws the new picture as `q K cm /PEImg<n> Do Q`, in place of the painting operation, or of the
innermost block around it when that block holds only a cm and the operation (as many producers
write a picture, and as a replacement leaves it): replacing again takes the place of the last
replacement instead of nesting inside it. The new picture fits inside the part of the old one
that showed: the old unit square within the clips that move with it (each by its bounding box
along the picture's axes), keeping its own proportions, centred, so with the same rotation. A
form's own clips (its /BBox, those set inside it) would go with its Do: they are written again
around the new picture, the path's points mapped into the user space there. A mirrored old
picture (negative determinant: stored bottom-up, or flipped for display) is read as the more
upright of its two readings, and the new one is drawn at that angle, not mirrored, over the same
box. The XObject goes in the page's own /Resources as `PEImg<n>`; a JPEG is embedded as it is
(DCTDecode; without its metadata, and turned by its EXIF orientation: see "Fill and sign"); the
same bytes put in several places in one session are embedded once, whatever path the history
took (the session notes which object holds each picture the app embedded, with the checkpoints,
and points a copy a replay adds back at the first one); the new XObject gets
the /OC of the old picture and of the forms it was drawn in (several: one membership dictionary
with /P /AllOn, which MuPDF 1.27 itself does not apply, other readers do). MuPDF backs a picture
without a colour profile with its own (Artifex's) profiles, which the app does not ship (see
"Colour profile" under PDF/A): such pictures get /DeviceRGB, /DeviceGray or /DeviceCMYK instead; a
JPEG's or PNG's own profile is kept.

**What leaves the file.** After a delete or a replace, every XObject name the page no longer
draws leaves its resources: what its content draws, and the content that uses the page's
resources because it has none of its own (forms, Type 3 glyphs, patterns, soft-mask groups,
annotation appearances), counts. The page first gets its own shallow copy of /Resources and of
/XObject (inherited ones, or a dictionary shared with other pages), so the other pages keep
theirs. The pictures behind the names it dropped may still be listed elsewhere, which keeps them
in the file: in the one /Resources FPDF and TCPDF give every page, in resources inherited from
the page tree, in a form whose /Resources is the page's dictionary, or in the dictionary the
other pages keep after a text edit gave this page renamed resources of its own. So the cleanup
looks through the document's resources (every page's, the page tree's, and those of the forms,
patterns, Type 3 fonts, soft-mask groups and appearances found in them, each once) for XObject
dictionaries that list those pictures (by object number). Such a name leaves its dictionary when
nothing drawing with that dictionary draws it: the pages that resolve to it, directly or by
inheritance, and what has it as /Resources or has none and is drawn with it. Only those users'
content is read, each stream once (a 1,000-page file where every page shares one dictionary:
about 0.1 s; with resources of their own, about 30 ms). Objects are told apart as pdfa.ts does
(the indirect object, or the same direct one in memory: a text edit's copy of inherited
resources keeps the page tree's /XObject). The cleanup is conservative: when some content that
may draw with a dictionary cannot be decoded (a bad /DecodeParms in an appearance, a pattern, a
Type 3 glyph or another page), draws a name that is not one of its keys (so it cannot be sure it
reads the names MuPDF does), or the form fields' default resources (/AcroForm /DR) have it,
nothing more is pruned for that edit, and the edit is made all the same; past 4,000,000 operations
or 200,000 dictionaries read, the same. The download's garbage collection then drops the
picture unless something still draws it: a deleted photo is not in the file for an extraction
tool to find, and deleting the only CMYK picture lets the file be saved as PDF/A.

**Descriptions.** On a tagged page, the structure element that owns the placement's marked
content (through /StructParents and the ParentTree) loses /Alt and /ActualText, which described
the old picture, when it is a Figure or a Formula (its own type, or the one the RoleMap gives a
custom type), or when the picture was all it held: its marked-content sequence paints nothing
else and the element has no other content. Any other element keeps them: a paragraph with text
and an inline icon has them for its text too (MuPDF reads the text through /ActualText). Nothing
happens when the file has no structure tree or it cannot be read.

**Locked images** are listed with the reason, and every edit refuses them ("not-editable"):

- "group": drawn in a form that also paints something else, such as a caption: moving the form
  would move the caption too (cloning the form for this page is for later);
- "soft-mask": a soft mask set with `gs` outside the image's own block applies to it;
- "cropped": a clip set outside the image's own block crops it as a frame would (it cuts part of
  the picture off, and lies within the picture's box): moved, it would show another part. A
  larger clip that the picture reaches, such as the page-margin clip Chrome writes around
  everything, does not lock it, or a picture moved partly under the margin could not be moved
  back. Clips that cannot be measured (curves, text) count as cutting;
- "unreadable": the safety gate failed, or the page is past the walk's caps.

**How edits are identified.** An image edit is logged as plain data: page, image index (painting
order), the matrix it must still have (`expect`), and the operation with its data (the target
matrix, or a copy of the new picture's bytes). Every replay (undo, redo, checkpoints, rollback)
finds the page's placements again, walk and gate, and refuses an entry whose image is missing,
locked or more than 0.01 pt away from `expect` ("edit-failed", through the usual rollback).
Resource names and byte offsets are not stable, since a text edit's redaction rewrites the stream
and renames resources; the painting order is. Text and image edits mix freely in one history; a
move to where the image already is is a no-op, like an unchanged line.

**The sprite.** `renderImage` draws one placement alone, for the preview while it is dragged: a JS
device forwards only that image (the one the gate matched it to, counted as the gate counts) and
every clip to a DrawDevice on a transparent pixmap covering its visible box, at most 4 million
pixels. Each clip that is not a rectangle along the pixel grid holds a mask and a copy of its
area in the draw device until it is popped (about 5 bytes a pixel): a clip that would take what
the clips open at once hold past 128 MB is not forwarded, so MuPDF never runs out of memory. If
such a clip is still in effect when the image comes (clips set and ended elsewhere on the page do
not matter), the sprite is drawn again at the lower scale where they fit, since what they hold
goes with the square of the scale: 30 nested rounded frames around a full-page picture at scale 2
(a retina screen at 100 %) give a sprite at about 1.2. It is refused ("edit-failed") only when
even 0.25 pixel per point would be over. MuPDF's pixmaps with alpha are premultiplied; the worker
builds an ImageData, which wants straight alpha, so the engine converts.

**Not in this release**: "replace everywhere" for a picture used several times, links or
captions that move with the picture, bring to front / send to back, cropping, snap guides, images
inside annotations (stamps), images in groups with other content (locked). After a delete the
picture's structure element (Figure) keeps an empty marked-content sequence, and a moved
picture's /BBox layout attribute, when a tagged file has one, is not updated. Replacing a form
placement drops what the form set besides clips (a soft mask or marked content inside it). A
picture also listed in the form fields' default resources, or reached only from outside the
pages' resources (a structure element's object reference), stays in the file.

## Fill and sign ("Compila e firma")

Release 3 fills in form fields and writes new text and new pictures (signatures, initials,
photos) on the page. All three are logged edits like line and image edits (`session.ts`): plain
data, replayed by undo, redo, checkpoints and rollback, mixed freely with the others in one
history. New text and pictures are real page content, not annotations, so every reader shows,
prints and searches them the same, and nothing is left to flatten.

**Form fields** (`forms.ts`; `EngineSession.fields`, `setField`; `DocInfo.form`). MuPDF.js 1.27
reads every field type correctly but checks nothing when a value is set: it ignores ReadOnly and
MaxLen, takes any combo value and writes `/V` even on push buttons and signature fields. So
`planFieldEdit` checks the value first (the field's options and states, MaxLen, MAX_FIELD_CHARS,
controls removed, line breaks only in multi-line fields) and refuses locked fields
(`FieldWidget.locked`: read-only, password, file select, push button, signature, no name, or
same-named fields of different types); a value every dictionary with that name holds already is
a no-op. Then `applyFieldEdit`, shared by the first application and every replay:

- **Identity is the full name** ("a.b.c"): every field dictionary with that name, and all their
  widgets on every page, get the value, as readers group same-named fields. The log keeps the
  name and the type the field must still have; a replay that finds neither fails ("edit-failed").
  Object numbers would not do: downloads renumber them, and merging files (release 4) would too.
- **Appearances.** A value that is all WinAnsi goes through MuPDF's setters and `update()`, the
  one case MuPDF draws right. Anything else (Polish, Romanian, Greek, CJK...) MuPDF puts under
  the box's bottom edge, sizes to 0 pt when automatic, or draws with fonts it does not embed:
  the app's writer draws it instead, inside the frame MuPDF drew for an empty value (background,
  border, clip, /Matrix), with core.js's embedded fallback fonts (`encodeWithFallbacks`, shared
  with line edits and new text, one copy per document), laid out as MuPDF lays out WinAnsi text
  (to within 0.01 pt; tests compare). List boxes always go through the writer: MuPDF draws no
  highlight for the selected rows. Characters no font has stay in the value, are left out of the
  drawing and reported (`missingChars`); text that does not fit says so (`overflow`).
- **Check boxes and radio buttons: never `toggle()`**, which in 1.27 sets the new state into
  `/AS` of every widget of the group (all radios drawn on, and NoToggleToOff then refusing any
  other choice). The field's `/V` and each widget's `/AS` (its on state or Off) are set here; a
  check box without appearance states gets a pair drawn with ZapfDingbats.
- **Scripts never run** (MuPDF.js has no JavaScript here): keystroke, format, validate and
  calculate scripts are reported (`FieldWidget.scripted`, `FormInfo.scripts`), a format script's
  date or number pattern read as a hint for the UI, totals never recalculated.
- **XFA and NeedAppearances.** A static XFA part would keep the old data beside the new values:
  the first field edit removes it (the UI says so first). A dynamic XFA form has no fields to
  fill. A form with `/NeedAppearances` gets real appearances for all its fields on the first
  edit and loses the flag, or MuPDF would redraw every field on every page load with its own
  drawing.
- **Passwords are never drawn.** MuPDF draws a password field's value in clear when it makes the
  field's appearance. A password widget without an appearance gets one with only its frame
  (`hidePasswords`) when the file is opened, and on every field edit and PDF/A conversion; the
  app never fills password fields (they are locked). One exception, on screen only: in a form
  with /NeedAppearances MuPDF redraws every field for display, the stored password too, until
  the first field edit drops the flag. No file the app writes carries it.
- **Saving.** `subsetFallbackFonts` also reads annotation appearances for the glyphs they draw,
  and points them at the subset fonts. The
  PDF/A conversion draws with the writer what MuPDF would draw wrongly, and gives an unsigned
  signature field an empty appearance: MuPDF's own is an orange "SIGN" tag, which would be
  written into the file.

**New text** (`newcontent.ts`; `EngineSession.addText`, `addedTexts`, `editAddedText`;
`LineInfo.added`). A line of real text in the app's embedded fonts: the Nimbus face of the style,
ZapfDingbats for ✓ ✗ ✔ ✘ (core's fallback chain has it before the CJK font, which lacks ✗ ✔ ✘),
the CJK font; Identity-H with a complete /ToUnicode, so it searches and extracts exactly. Its
baseline starts at the origin given in page space and it is horizontal as seen, whatever the
/Rotate and CropBox. The session checks the origin (on the page), the text (made one line,
controls dropped, 1 to MAX_TEXT_CHARS characters, something drawable: characters beyond U+FFFF
are always left out, since MuPDF.js reads them back truncated) and the style (size, sRGB colour,
family, bold, italic), and refuses anything else ("bad-request") before logging.

- **Each line is a marked block of its own**: `/P <</MCID n /PEText id>> BDC q BT … ET Q EMC` on
  a tagged page, `/Span <</PEText id>>` otherwise. The id (one more than the page's largest,
  1 to 2^31 - 1; past the largest, the smallest free one) is stable across edits, undo and redo (a replay that gives another id fails), and the block is
  found again after a redaction rewrote the page, in a later session and after save and
  re-open. On a tagged page the line becomes a /P at the end of the document's top structure
  element, registered under a new MCID (a page without /StructParents gets a key); it is read
  last, after the page's own text.
- **Appending** (`appendSafely`): new content is drawn from the page's initial graphics state.
  When the content does not end clean (q and Q unbalanced, a state changed outside any q, a text
  object, marked sequence or path left open, operands no operator takes), it is wrapped once in
  q..Q, what it left open
  closed first, and later additions go after it without nesting deeper (`core.appendContent`
  nests one level per call: harmless after a redaction, which flattens the content, but
  additions are never redacted). Content that ends inside a string, an array, a dictionary or an
  inline image would swallow what follows, and content that restores more states than it saves
  would draw differently once wrapped: both are refused ("not-editable").
- **Editing what the app wrote never redacts.** Redaction is geometric: it removes whatever lies
  under the line's characters, so correcting a name written on a form's underscores would take
  the underscores, and removing a ✓ the box. `editAddedText` rewrites the block in place (text,
  origin, style; an empty text removes it and its /P), and `replaceLine` routes a line made only
  of added blocks (`newcontent.addedLineIds`) the same way: two blocks MuPDF reads as one line
  (written one after the other on one baseline) are rewritten as the first, the others absorbed.
  The other way round, a normal line edit first notes the page's added lines and, after the
  redaction, writes back as they were those it damaged (`protectAdded`). MuPDF reads text
  written just after a printed label ("Data di nascita:") as one line with it: such a line is
  edited part by part (`kind: "mixed"`): the printed part by redaction, each added part rewritten
  in its own block and style, and added parts after a printed part that grew moved right by as
  much; a change that would rewrite two printed parts is refused ("not-editable"). All of this
  is part of the logged edit, so every replay does the same.
- A line edit's `fallbackChars` leaves out a fallback in the very face the line was drawn with
  (core's segments carry the face, `program`): a line the app wrote is all fallback fonts, and
  writing more of it changes nothing the user could see.

**New pictures** (`newcontent.addImage`; `EngineSession.addImage`; `ImageInfo.added`). A picture
at one or more targets (ImageInfo.matrix convention), one per page, each checked as a move is
(sides 1..14,400 pt, centre on the page): one edit, the picture embedded once (initials on every
page share one XObject). Each placement is a block of its own after everything else on the page,
`/Figure <</MCID n /PEImage id>>` with the description as /Alt on a tagged page ("Firma: Mario
Rossi"), or `/Artifact <</PEImage id>>` when it has none or the page is not tagged.
`findPlacements` lists it as the page's last placement, movable, so release 2's move, resize,
rotate, replace and delete work on it; `placed` gives its index (null when the page's images are
locked). **Picture files** (`images.checkPicture`, for `replaceImage` too): a JPEG loses,
losslessly, what describes the photo rather than draws it (EXIF with the GPS position and a
thumbnail, XMP, comments, JFXX thumbnails, stray bytes between segments, anything after its
end), keeping JFIF, its colour profile and Adobe's segment; its EXIF orientation, which MuPDF and PDF readers ignore, turns the placement instead,
so a phone photo stored sideways shows upright (recorded as /PEOrientation on the app's image
object, so a later replacement fits the picture as it is seen).

**History.** Undo and redo report every page an edit touched (`pagesOf`: a field's pages, the
pages of a picture's targets). `edits()` copies every kind. A refusal from newcontent.ts found
only while applying (the content cannot take an addition) rolls the document back like any
failed edit and keeps its own code.

**Not in this release**: digital signatures (a signature field is "signed" by placing a picture
in its box; it stays unsigned), flattening the form, running a form's scripts, right-to-left and
complex scripts (no font of the app draws them), placing new text and pictures in the reading
order next to the nearest label (they are read last).

## Decorations

PDF has no underline attribute: producers draw an underline, a strike-through, a pill or a
highlight as shapes of their own, and a link as an annotation. A line edit used to leave them as
long as the old text, and a deleted line left a broken underline, an empty pill and a link over
blank space. Now an edit of a plain printed line takes them along, in the same edit (one undo)
(`decorations.ts`; `EngineSession.lineDecorations`, asked when the line editor opens, and
`replaceLine`'s options):

- **What follows by itself**: a solid underline or strike-through in the text's own colour, whose
  ends sit on the edges of the line's characters, touching no other shape, in the page's own
  content; and the line's links (a rect over one run of this line's characters only, on a line
  along the page's axes, /Rotate included). They stretch or shrink with the new text, and go
  with it when its text is deleted: the path and its painting operator, the link out of /Annots
  and, on a tagged page, out of the structure tree (a link that cannot leave it for sure stays).
- **What is offered**: a background or border that hugs a run of the line's text (a pill, a
  button, a chip, a highlight), holding no other line's characters, touching nothing else, drawn
  before the text or translucent over it: the line editor's option "Allunga anche lo sfondo"
  ("Togli anche lo sfondo" when the line is emptied), ticked to start with when both side
  margins are at most 1.5 em and about equal. Never table cells, boxes shared by several lines,
  or opaque boxes drawn over the text.
- **What stays, with the reason said** (`DecorationLeftReason`): dashed or dotted rules (a wavy
  one is a picture: not even seen), shapes inside a Form XObject, a rule in another colour, an
  overline (it may be a signature line), shapes that are part of a layout, vertical or slanted
  text, a page too complex to read (past 200,000 paths), and an edit whose change runs across
  the edge of a partly decorated run (ambiguous). Lines that hold text the app wrote (added or
  mixed) keep theirs as they are.

**Finding them.** MuPDF's own interpreter (a device pass, with the discipline of "Images") gives
the paths near the line with their points, colour, alpha, line width and dashes, and the line's
own glyphs in painting order; the rules work in the line's frame (along the baseline and across
it, in units of the font size). Each candidate must then be exactly one path of the page's own
content painted the same way at its bounds (within 0.02 pt). **Following.** Which characters a
decoration covers after the change comes from the common start and end of the old and new text
(the whole line's decoration covers the whole new line; text typed right after a decorated run
continues it); the new text is found where replaceText wrote it and must read what it wrote. A
path's points past its middle move by the change at the run's end, the others by the change at
its start, so round ends stay round and a rectangle stays a rectangle; Chrome's skip-ink holes
(a clip with holes under the descenders) stay under their characters. A link's rect and
/QuadPoints move the same way, written in user space (`Link.setBounds` takes it, `getBounds`
gives page space). The links replaceText's redaction removes (any whose rect meets the redacted
characters) come back as the same objects, at their place in /Annots, keeping /F, /Border and
/StructParent (they used to be made again at the end without them, which broke a tagged PDF's
link structure).

**The log.** The TextEdit carries the plan as it was carried out: each shape by its page-space
bounds and paint, each link by its rect and URI, each with the characters it decorates; no
resource names or offsets, since a text edit's redaction rewrites the stream. Every replay
applies that plan as logged and never decides again, so a later change of the rules cannot change
old history; a page that does not have what the plan says fails the replay, as an image edit's
`expect` does. When MuPDF cannot read the decorations at all, the line is edited as it was
before, without them.

**Not in this release**: new skip-ink holes under new descenders; keeping right or centre
alignment (the text grows to the right, its decorations with it); drawing dashed or dotted rules
again; shapes inside forms; decorations of mixed and added lines; size and colour changes (the
line editor cannot make them yet).

## Pages, scans and Riprendi

Release 4 ("Pagine e foto") moves, deletes, copies, turns and adds pages, adds pages of another
PDF, makes pages of photos and scanned sheets, and keeps the open document and its edits on the
device so that the user can resume after the tab was closed or killed ("Riprendi").

**Page operations** (`pages.ts`; `EngineSession.editPages`, one request per operation): "move",
"delete", "blank", "duplicate", "rotate", "insert" (pages of another PDF) and "pictures". MuPDF's
ready-made calls cannot be used as they are: `rearrangePages` rebuilds the catalog (the form, the
tags and the labels go), `deletePage` leaves fields, tags, bookmarks and destinations pointing at
the page, which keeps it, and what the user wrote on it, in every download, and `graftPage` copies
no annotation and drags in the source's whole page tree through any reference to one of its pages.
So `pages.ts` has its own: inherited MediaBox, CropBox, Rotate and Resources given to the pages
first, labels read before and written back after, a clean delete (every reference to the page and
its annotations removed, then any reference left cut by a pass over every object), copies as new
page dictionaries with their own content, annotations and renamed fields, and an import that copies
only what cannot reach a page that was not chosen. Its header lists what is out of scope: tags
for added and copied pages (they come in untagged), among others. Each operation is one edit: undo,
redo, checkpoints and rollback work as for any other.

**What is logged.** A `kind: "pages"` entry, plain data like the others, holding the operation with
what it needs to be made again exactly: its page indices as they were, the size of a blank page
(the page's before it as seen, when none was asked), for "insert" the chosen pages of the other
PDF as a file of their own and their indices in it in the chosen order ("all" made a list; see
"The other PDF"), for "pictures" each picture as addImage keeps one, with its page's size and its
description. The indices of the entries before and after it stay as
they were: replaying in log order makes them right, so nothing is renumbered. `pages.ts` depends
only on its arguments and the document's state, so a replay repeats field renames (`nome_2`,
`nome_copia1`), label repairs and where a bookmark goes. Everything is checked before anything is
logged ("bad-request"); a page tree MuPDF cannot read is "not-editable".

**The layout.** A step that changed the pages (an operation, its undo or its redo) answers with
`HistoryState.layout`: the pages now, and for each the index it had before the step, worked out
from the operation itself (`layoutFrom`: a move gives its permutation, a delete the pages that
stay, new pages a `from` of null at their place and the pages after them shifted, a rotation every
page where it was; an undo the inverse, `undoneFrom`, where the pages a delete brings back have
no `from`). Never by matching page objects before and after: an undo compares the working
document with one rebuilt from a checkpoint or the original, and two paths to the same state do
not number their objects alike (a picture embedded again after a snapshot, which forgets what was
embedded, shifts every later object). The form and the signature count are read again (an
inserted PDF can bring fields or signatures, a delete take them away). `encrypted`, `needsPassword` and `canKeepPassword`
stay as they were at open: read again they would change after the first snapshot. `changedPages`
lists the pages turned or made. The UI rebuilds its page list from the layout, keeping the
PageModels of the pages that stayed (`viewer/model.ts`, `applyLayout`).

**Layers.** MuPDF reads a document's layer list once, the first time it draws optional content:
layers an insert adds after that draw as visible until the document is opened again. So after an
insert that brought layers the working document is written out and opened again (as a checkpoint
does), and a replay goes on with a copy opened again at that point: what the pages show never
depends on the path the history took (undo, redo, a rebuild, a resume).

**The other PDF** (`openSource`, `renderSource`, `closeSource`), for the page picker of "Da un
altro PDF": one at a time beside the document, at most `MAX_SOURCE_BYTES` (100 MiB), its password
asked as for a document. Its password fields get a frame-only look (`hidePasswords`), and while it
is open it is kept as a private copy written unencrypted (`encrypt=none`). An insert takes its
chosen pages from that copy into a file of their own (`insertPart`): a scratch copy with the
other pages deleted cleanly (`keepPages`, which cuts the links that led to them: counted in the
report as an insert from the whole file counts them), without what an insert never copies (the
catalog's attachments, scripts, structure tree, metadata and actions, the form's XFA, the pages'
/PieceInfo and thumbnails; the bookmarks too when there is no title), written unencrypted and
garbage collected. That file is what the insert logs and opens at every run, the first one
included (never the copy open for the picker's thumbnails, which drawing may have changed), so a
replay needs no password and repeats the first run exactly, and the log, its exports and the
device's store hold nothing of the pages the user did not add. The other PDF is closed by
closeSource, by opening or closing a document, and when another one is opened. The added pages sit
in the log once, and their copied objects in every later checkpoint (thinned past 256 MB in total
as before). An inserted signed PDF keeps its signatures (counted in the report): like the
document's own, they are no longer valid in the new file, and the UI says so.

**Extract** (`extractPages`): a scratch copy of the document as it is, the other pages deleted
cleanly there (`keepPages`), then exactly the path a download takes (fallback fonts subset, PDF/A
conversion when asked, the password). The document does not change. A normal-PDF part never claims
PDF/A, edited or not: nothing checked it.

**Pictures as pages.** A picture (JPEG, or a 1-bit grey PNG for a black-and-white scan) becomes a
new page of its own size, its pixels at its dpi (A4 at 200 dpi is 1654 × 2339 pixels), with the
picture over the whole page as the app's own picture (`newcontent.addImage`, the session's
`sharePicture`): it can be moved, replaced or deleted like a signature. On a tagged document it is a
Figure described "Pagina scansionata", or "Scanned page" when the document's /Lang is not Italian,
unless the scan gave a description. MuPDF 1.27 stores a grey PNG whose pixels are only black and
white as a 1-bit image and writes it CCITT G4 (about 80 KB for an A4 page at 300 dpi). Pictures
are checked as addImage's are, besides their size: the file's pixels must be what they say (within
a pixel), at most 40 million, each page side 1..14,400 pt. `newFromPictures` builds a new PDF the
same way and opens it as the document: that file is the original, and the log starts empty. The
scan itself (finding the sheet, straightening it, the modes) runs in a separate short-lived worker
in plain JavaScript (`src/scan/`), not in the engine: no second MuPDF.

**Riprendi** (`exportSession`, `resumeSession`; the store is `platform/resume.ts`, the autosave and
the home page card `ui/resume/`). What is kept: the original as it was opened and the log
(`SessionLog`, version 1), every byte array in them a copy of its own. Nothing is kept for a file
from the device with no edits (the user has it). A document made here (`newFromPictures`;
`SessionExport.madeHere`, carried in the log across a resume) is kept even with no edits and after
a download: it exists nowhere else. Nothing is kept for a document that needed a password to
open: its original stays encrypted, but its edits (what the user wrote, field values, pictures,
inserted PDFs) would sit on the device unencrypted. Nor while the log holds pages of another PDF that needed a password (the
insert is marked `protectedSource`): they sit in the log unencrypted; once that insert is undone,
what is left is kept again. It is kept only on this device, in an IndexedDB database of its own
("pdf-editor-resume": signatureStore's "pdf-editor" is never opened at another version), never
sent anywhere. One document at a time: it is forgotten when the user closes it, when another
document with edits takes its place, or with "Dimentica" (which forgets exactly the record it was
pressed for); a page load forgets only what it kept itself, so another tab's record stays.
`resumeSession` refuses a log that is not exportSession's (another version, an entry of an
unknown kind or shape: "bad-request") before anything is done; then it opens the original and
applies the edits one by one as redo does, taking checkpoints as new edits do, so undo works as it
did. An edit that no longer applies (the app changed since) stops there: the document goes back to
the edits before it, which stay, and `failedAt` says which one stopped. The redo stack and the
checkpoints are not kept (checkpoints hold functions, and are made again).

## Cerca, Bianchetto and Oscura

Release 5 finds text in the document ("Cerca") and removes for good what lies under an area, in
two ways: Bianchetto (white-out: text and drawings go, the area is left white, pictures are only
covered) and Oscura (redaction: text, drawings and picture pixels go, a black box). Everything
happens in the engine, on the device.

**Cerca** (`search.ts`). MuPDF's own search cannot be used: it takes no options, respects accents
("Universita" finds nothing in "Università"), equates no apostrophe, quote or dash variants, finds
nothing in vertical text and does not look into form fields. So each page is read once with a light
structured-text walk (the option and the vertical-text fix of `core.extractLines`) into a compact
`PageText`: the characters in reading order, a separator between lines that says how the break
reads (a space, nothing, a word hyphenated at the line end, a break in a script written without
spaces) and, per character, where it starts and ends along its line in 16-bit steps of it; each
visible form field's appearance is a text of its own (not password fields, not Hidden or NoView
widgets; a comb field's read without the space MuPDF would put between every two of its cells, so a
codice fiscale is found as typed). The matcher folds text and query alike: case and accents ignored
by default, apostrophes, quotes, dashes and runs of spaces made one, soft hyphens, zero-width
characters and bidi marks ignored, ligatures and TeX accents read as letters, a word hyphenated at
the line end (by a hyphen or a soft hyphen) found whole and as written, and Italian's apostrophe
for an accent ("perche'" finds "perché"); the options are whole words, case (Æ, Œ, ẞ then read AE,
OE, SS) and accents. A hit has one quad per line run, in MuPDF's corner order (equal to MuPDF's own
where MuPDF finds the hit too), `in: "field"` and the field's full name when it is in a field, and
some text around it. Not searched: notes' /Contents and other annotations, text outside the page.
Found although not seen: invisible text (OCR layers), text in a layer switched off, text under a
white box: it is in the page. Characters beyond U+FFFF, which MuPDF.js cuts to 16 bits, are read
whole (from the structured text as text, or the drawn glyphs), so they never match by mistake.

**The search protocol.** As one request, a search of 600 pages kept a render waiting about 5 s, so
it is steps the client drives (`search`: from a page up to another, at least one page, then more
while the step has taken less than its budget, 5..200 ms, default 20, and found fewer than
`maxHits`, at most 10,000; `next` is the page to go on from, `truncated` says the last page read
had more). Nothing is kept between steps but the page texts, so the client (`ui/search/runner.ts`)
goes from the current page to the end and then from the first page back to it, keeps at most 1000
hits, and cancels by not asking for the next step. The session's cache of page texts (600 dense
pages take about 23 MB, reading a page again 7 to 9 ms) holds at most 32 MB, and past it a page
read is not kept: evicting the oldest would, read after read, push out the very page the next
search starts from, so a longer document keeps the pages read first and a search reads only the
rest again. It follows the history in one place, `history()`: the pages a step changed leave it, a
page operation's layout moves the others to their new indices (a page it turned or made is read
again), and open, close, newFromPictures and resumeSession empty it. After an edit the client reads
its changed pages again, one step each; after a layout it starts over.

**Bianchetto and Oscura** (`redact.ts`, its header says how). MuPDF's redaction (a Redact
annotation per rect, `applyRedactions` with line art removed only when wholly covered) does the
core of it; on its own it leaves a lot in the file, so around it, as part of the same edit:

- **Oscura** removes text (every render mode, hidden layers, the copies MuPDF makes of the forms the
  page draws), drawings wholly inside the area, picture pixels and the soft mask or /Mask under the
  area (a signature's shape lives there), every annotation whose /Rect meets the area, whole
  (links, notes with their popups and replies, FreeText, highlights, form widgets: a field left
  without widgets leaves the form, its value with it; one with widgets elsewhere keeps its value
  there, and the report says so), the descriptions of what changed (/ActualText, /Alt and /E,
  inline and in named property lists, a shared one copied first, and the structure elements'),
  the page's /Thumb and /PieceInfo, and whatever the page's resources listed and it no longer
  draws (pictures, forms, fonts only the removed text used, graphics states, patterns, shadings,
  property lists) from every dictionary of the document that lists it, unless something else
  draws it. The new pictures get device colour spaces instead of MuPDF's Artifex profiles, their
  /OC, /StructParent and /PEOrientation back, and a JPEG stays a JPEG (quality 85; the others
  stay lossless).
- **Bianchetto** removes text and drawings wholly inside the area. Pictures are only covered and
  annotations and fields stay on top (the UI says so before applying, and offers Oscura); a link
  MuPDF removed comes back, unless it lay wholly inside the area (then it leaves the structure
  tree too).
- **Both**: the file's own pending Redact marks sit out the call and come back as they were. The
  app's lines: an emptied one is removed and untagged, a cut one loses /PEText and is printed text
  from then on. The box is the app's own block (`/Artifact <</PERedact id>>`, appended with
  `appendSafely`), over the area and the characters the redaction took (a character goes whole
  when its box, shrunk by 10 %, meets the area), kept to 70 % of their height; `decorations.ts`
  never takes it for a line's background or underline. The edit never goes through
  `protectAdded`, which would write back the app's lines the area took.

**Areas from hits and lines are made smaller, never larger** (`redactGeometry.areasForQuads`): a
hit's quads are full line height (16.5 pt for 12 pt Helvetica), and an area that large took letters
from the lines above and below. Each quad keeps the middle half across it, and stops a little
short of its ends.

**Refusals**, all checked before anything changes ("not-editable", the message naming the
`RedactRefusal`; nothing logged, nothing rolled back: `RedactError.changed` is false, and the
session keeps its working document as it is; so it does for a bad request, areas wholly off their
pages among them, which the session finds itself before the edit): a picture in printing colours (Separation,
DeviceN) under the area; a picture of more than 50 million pixels (clearing it would not fit in a
phone's memory); resources shared with other pages that the app cannot read for sure (everything
that draws with the dictionaries the page's resources are is read first, at most 20 million content
operations); content that cannot take the box. One case shows only after the change (another page
whose drawing cannot be read lists an object the redaction took off; `changed` true): the session
rolls the edit back, as for any failed edit. `redactPreview` says, changing nothing, what would go
or stay on each page, the attached files and the refusal, so the UI can say it before the user
applies.

**What is logged.** A `kind: "redact"` entry, plain data: the mode and the areas in page space as
checked (one entry per page, in page order, the rects as given, at most 1000 a page). The edit is
deterministic, so undo, redo, a rebuild from a checkpoint or the original and Riprendi repeat it
exactly. "Oscura tutti i risultati…" is one such entry over every chosen hit's areas; on a page
with more than 1000 rects (hundreds of hits, or a turned page, where each hit is many pieces) it is
several, each hit whole in one of them unless it alone has more, and the toast's Annulla undoes
them all, the last first.
A redaction that removed widgets answers, as its undo and redo do, with a layout of the same pages
(`from` the identity) carrying the form and the signature count read again.
`HistoryState.redactions` counts the redactions applied; the download is then named "-oscurato". The log stays
version 1: an older build that reads a log with a redaction refuses it as malformed, and its home
page card forgets the record.

**What cannot be guaranteed**, said in the UI where it applies: the length of the removed text
(its width stays, as the space before the next word); characters still in embedded fonts that the
rest of the page shares; the part of a drawing, a shading or a pattern cell that only crosses the
area (it stays, covered); the outline of a clip under the area (MuPDF keeps clip paths: the shape
a gradient fills through one stays, covered); text outside the CropBox; the same words elsewhere
(Cerca finds them); attached files (not touched: counted and said, they may hold the same data);
and the original file and the Riprendi record on this device, which hold everything until the
document is closed.
A cleared picture is stored losslessly unless it was a JPEG, so the file can grow (the report's
`growth`; said past about 1 MB).

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
