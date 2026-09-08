# PDF Editor

A PDF editor that runs entirely in your browser. Edit text in place, highlight,
erase, draw, add images and signatures, merge files, and OCR scanned pages.
Nothing is uploaded anywhere: all the work happens on your machine.

Try it online: https://vibesite-one.vercel.app/tools/pdf-edit/index.html

## Running it offline

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

## Tools

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
- **Highlight, Erase, Pen, Image**: the usual annotation tools.
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
- **Merge PDF**, **Export PDF**.

## The indicator in the top-right corner

- `● Real removal: ON`: the original text is really removed and, when possible, the
  PDF's own font is reused for the replacement.
- `○ Real removal: n/a`: reduced mode, the old text is only covered.

## How it is built

Plain JavaScript in a single HTML file, no framework. Three engines cooperate:
[MuPDF](https://mupdf.com/) compiled to WebAssembly for rendering and real text
removal, [pdf-lib](https://pdf-lib.js.org/) for writing the modified document, and
[Tesseract.js](https://tesseract.projectnaptha.com/) for OCR. The bundled
libraries keep their own licenses.

Built with Claude Code.

## License

AGPL-3.0, because the editor is built on MuPDF, which is AGPL. Bundled libraries keep their own licenses; see `LICENSE`.
