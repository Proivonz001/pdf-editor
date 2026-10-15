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
  the edit history and is plain TypeScript, so the tests run it in Node. `worker.ts` only turns
  messages into `EngineSession` calls. `protocol.ts` is the contract; `client.ts` is the
  main-thread side.
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
4. **Save** with `garbage=compact,compress=yes` plus `encrypt=none`, and subset only the
   fallback fonts (never `subsetFonts()` on the whole document).
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
fallback fonts there and writes it, leaving the working document untouched.

The edit list is plain data, so it can later be stored for "resume session".

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
