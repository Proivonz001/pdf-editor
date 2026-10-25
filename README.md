# PDF Editor

A PDF editor that edits the **real text** of a PDF, in the file's own fonts, on a computer or a
phone. It installs as an app, works offline, and the file never leaves your device: there is no
server, all the work happens in the browser.

Use it at **https://pdf-editor.priamo-anfuso.workers.dev** (the interface is in Italian or
English, following your device's language).

## What it does

- **Modifica**: change a line of text in its original font (underlines, strike-throughs, links
  and backgrounds follow the new text); add new text; add pictures, and move, resize, rotate,
  replace or delete the ones already there; **Forme**: lines, arrows, rectangles, ellipses, a
  freehand pen and a highlighter, in five colours, solid, dashed or dotted.
- **Bianchetto and Oscura**: white-out and redaction that really remove what lies under the
  area (text and drawings; Oscura also the pixels of pictures), not just cover it.
- **Compila e firma**: fill in form fields, write wherever you tap, tick, cross and date,
  signature and initials (drawn, typed or from a photo).
- **Pagine**: reorder, rotate, duplicate, delete, add blank pages or pages from another PDF,
  extract pages to a new PDF; add photos and scans as pages.
- **Cerca**: find text, ignoring accents and case.
- **Scarica**: a normal PDF, or PDF/A-2b for archiving; a protected PDF keeps its password.
  The app warns before changing a digitally signed PDF.
- **Riprendi da dove eri**: if the tab closes, the document and its edits come back (kept only
  on this device).
- Undo and redo for every edit.

How to run, test and deploy it: [app/README.md](app/README.md). How it works:
[app/ARCHITECTURE.md](app/ARCHITECTURE.md).

## The first version (repository root)

The original single-file editor is still in the repository root (`index.html` and `lib/`), and
online at https://vibesite-one.vercel.app/tools/pdf-edit/index.html. It is no longer developed.

### Running it offline

1. Double-click **`Start.bat`**.
2. A black window opens (the mini-server): do **not** close it while you use the app.
3. Your browser opens at `http://localhost:8799/` (open it by hand if it does not).

To quit, close the black window.

**Why not just double-click `index.html`?** Browsers refuse to load WebAssembly
modules from `file://` for security reasons. The mini-server serves the page over
`http://localhost`, which is all it takes. It needs Python, which is present on most
machines; otherwise install it from https://www.python.org/ and tick "Add Python to PATH".

Everything the app needs is in the `lib/` folder, including the MuPDF engine and the
Tesseract OCR data, so it works without an internet connection.

### Tools

- **Text**: add new text boxes.
- **Edit text (✎)**: click a word or a line to edit it in place, on the original page.
  Best for quick fixes.
- **All text (✎✎)**: make every line on the page editable at once, with the same
  high-quality method. Runs of the same style are merged into one box; where the
  style changes, boxes are split but stay grouped by line so they move together.
- **Copy to new page (➕)**: create a rebuilt copy of the page after the original.
  The background keeps photos, tables and shapes with the text removed, and the
  text becomes editable objects. Handy for separating content; quality is slightly
  lower because the background is an image. For scans, use OCR instead.
- **Highlight, Pen, Image**: the usual annotation tools.
- **Erase**: covers an area with white. When you export, the text and drawings
  underneath are really removed from the file, not just hidden. Pictures (including
  scanned pages) underneath are covered but stay in the file.
- **Shapes**: line (／), rectangle (▭), arrow (↗). Drag to draw them.
- **Grid (▦)**: pick rows × columns, then drag on the page.
- **Signature (✍️)**: draw it by hand, press "Save signature" (it stays on this
  device), then "Use" and click where it should go in the PDF.
- **OCR / rebuild page (🔎)**: creates a new editable page after the original, which
  is left untouched. Photos, tables and shapes stay faithful as the background. The
  page type is detected automatically:
  - digital PDF (real text): same tools as "Edit text", with exact size, weight,
    colour and font;
  - scanned PDF (image): OCR in English, Italian or both, with colour, size and
    weight estimated from the pixels. Works offline.
- **Undo / Redo**: ↶ ↷ buttons or Ctrl+Z / Ctrl+Y.
- **Pages** (left column): reorder, rotate, delete.
- **Merge PDF**, **Export PDF**. The downloaded file is named after the original
  (`name-edited.pdf`). Password-protected PDFs ask for their password when opened;
  the exported copy is saved without protection.

### The indicator in the top-right corner

The text-removal engine (MuPDF, about 10 MB) is loaded only when it is needed: the
first time you use Edit text, All text or Erase, or when you export.

- `○ Real removal: on demand`: the engine has not been needed yet.
- `● Real removal: ON`: the original text is really removed and, when possible, the
  PDF's own font is reused for the replacement.
- `○ Real removal: n/a`: the engine could not be loaded. Before downloading, the app
  warns you that the old text would only be covered.

### How it is built

Plain JavaScript in a single HTML file, no framework. Four engines cooperate:
[pdf.js](https://mozilla.github.io/pdf.js/) for rendering the pages,
[MuPDF](https://mupdf.com/) compiled to WebAssembly for real text removal and for
opening protected files, [pdf-lib](https://pdf-lib.js.org/) for writing the modified
document, and [Tesseract.js](https://tesseract.projectnaptha.com/) for OCR. Only
pdf.js loads at startup; the others load the first time they are needed, always from
the local `lib/` folder.

Built with Claude Code.

## License

GNU AGPL-3.0 (full text in `LICENSE`), because the editor is built on MuPDF, which is
AGPL. Copyright notice in `NOTICE`. The bundled libraries keep their own licenses;
see `THIRD_PARTY_NOTICES.md`.
