// English strings: the reference dictionary. Every key here must exist in it.ts too (the type
// `Messages` enforces it). Placeholders are written {name} and filled in by t().
export const en = {
  "app.name": "PDF Editor",

  // Empty state
  "empty.title": "Edit the text of a PDF",
  "empty.subtitle": "Change the real text of your PDF, on a computer or on your phone.",
  "empty.open": "Open a PDF",
  "empty.dropHint": "Or drop a PDF anywhere on this page.",
  "empty.privacy": "Your file never leaves this device.",
  "empty.source": "Source code (AGPL-3.0)",

  // Engine
  "engine.loading": "Loading the PDF engine (about 10 MB, only the first time)…",
  "engine.failed": "The PDF engine could not start. Reload the page to try again.",
  "engine.crashed": "The PDF engine stopped. Reload the page to continue.",
  "engine.reload": "Reload",

  // Opening
  "open.opening": "Opening “{name}”…",
  "open.waitingEngine": "Getting the PDF engine ready…",
  "open.damagedTitle": "This file can't be opened",
  "open.damaged": "“{name}” seems to be damaged, or it is not a PDF.",
  "open.failed": "Something went wrong while opening “{name}”.",
  "drop.overlay": "Drop the PDF to open it",
  "drop.notPdf": "That file is not a PDF.",

  // Password dialog
  "password.title": "This PDF is protected",
  "password.body": "Type the password to open “{name}”.",
  "password.label": "Password",
  "password.wrong": "Wrong password. Try again.",
  "password.open": "Open",

  // Common
  "common.cancel": "Cancel",
  "common.ok": "OK",
  "common.close": "Close",

  // Unsaved edits
  "unsaved.title": "Edits not downloaded",
  "unsaved.openBody": "You have edits you haven't downloaded yet. If you open another file, they will be lost.",
  "unsaved.openConfirm": "Open anyway",
  "unsaved.updateBody": "Updating reloads the app, and the edits you haven't downloaded will be lost.",
  "unsaved.updateConfirm": "Update anyway",

  // Top bar
  "toolbar.open": "Open",
  "toolbar.openTip": "Open a PDF ({shortcut})",
  "toolbar.undo": "Undo",
  "toolbar.undoTip": "Undo ({shortcut})",
  "toolbar.redo": "Redo",
  "toolbar.redoTip": "Redo ({shortcut})",
  "toolbar.zoomOut": "Zoom out",
  "toolbar.zoomOutTip": "Zoom out ({shortcut})",
  "toolbar.zoomIn": "Zoom in",
  "toolbar.zoomInTip": "Zoom in ({shortcut})",
  "toolbar.fitWidth": "Fit width",
  "toolbar.fitWidthTip": "Fit width ({shortcut})",
  "toolbar.zoomValue": "Zoom: {percent}",
  "toolbar.editText": "Edit text",
  "toolbar.editTextTip": "Edit text: pick a line and change it",
  "toolbar.download": "Download",
  "toolbar.downloadTip": "Download the edited PDF ({shortcut})",
  "toolbar.share": "Share",
  "toolbar.more": "More",
  "toolbar.update": "Update available",
  "toolbar.updateTip": "A new version is ready: click to update",
  "toolbar.updateInstalledTip": "A new version was installed in another window. It loads next time you open the app: click to reload now",
  "toolbar.unsaved": "Edits not downloaded",
  "lang.tip": "Change language",

  // Viewer
  "viewer.label": "Document",
  "viewer.page": "Page {page}",
  "viewer.indicator": "{page} / {count}",
  "viewer.indicatorLabel": "Page {page} of {count}",
  "viewer.working": "Working…",

  // Editing text
  "edit.hint": "Click a line to change it. The whole line is replaced.",
  "edit.hintTouch": "Tap a line to change it. The whole line is replaced.",
  "edit.lineLabel": "Edit line: {text}",
  "edit.lockedLabel": "Line that can't be edited: {text}",
  "edit.notEditable": "This line contains characters that can't be edited yet.",
  "edit.inputLabel": "New text for the line",
  "edit.fallback": "Not in the original font, written with a similar one: {chars}",
  "edit.missing": "Could not be written (no font has them): {chars}",
  "edit.failed": "Could not change this line.",
  "history.failed": "Could not undo or redo the last change.",
  "broken.title": "Editing stopped",
  "broken.body": "Something went wrong while changing this PDF, and it can't be edited any further. Download it now to keep the changes made so far, or reload the page and open the file again.",
  "broken.note": "Editing is off for this file: download it to keep your changes, or reload the page to start again.",

  // App update
  "update.installedElsewhere": "A new version of the app was installed in another window. This window keeps working and switches to it the next time you open the app.",

  // Download and share
  "download.suffix": "-edited",
  "download.done": "Downloaded “{name}”.",
  "download.failed": "Could not create the PDF.",
  "share.readyTitle": "Your PDF is ready",
  "share.readyBody": "“{name}” is ready to share.",
  "share.share": "Share",
  "share.failed": "Could not share the file.",
} as const;

export type MessageKey = keyof typeof en;
/** The shape every translation must have: the same keys, any strings. */
export type Messages = { readonly [K in MessageKey]: string };
