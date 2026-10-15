// English strings: the reference dictionary. Every key here must exist in it.ts too (the type
// `Messages` enforces it). Placeholders are written {name} and filled in by t().
export const en = {
  "app.name": "PDF Editor",

  // Empty state
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
  "edit.lockedLabel": "Line that can't be edited yet: {text}",
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

  // Home page
  "home.titleLead": "Edit the",
  "home.titleMark": "real text",
  "home.titleTail": "of your PDF",
  "home.subtitle": "Change the words in your PDF and keep its original font. On a computer or on your phone, for free.",
  "home.f1Title": "The real text",
  "home.f1Body": "No white boxes pasted on top: the line itself changes, in its original font.",
  "home.f2Title": "Computer and phone",
  "home.f2Body": "Works in the browser and installs as an app. Offline too.",
  "home.f3Title": "Stays on your device",
  "home.f3Body": "The file is never uploaded: it is opened and saved right here.",
  "home.stepsTitle": "How it works",
  "home.step1": "Open a PDF",
  "home.step2": "Choose a line and type",
  "home.step3": "Download the edited PDF",
  "home.free": "Free and open source",
  "home.sampleLine": "Invoice no. 2026-117",
  "home.sampleLabel": "Example: a line of a PDF being edited",

  // Top bar, with a document
  "toolbar.close": "Close document",
  "toolbar.closeTip": "Close this PDF and go back to the start",
  "toolbar.downloadPdf": "Download PDF",
  "toolbar.edited": "Edited",
  "toolbar.source": "Source code",

  // Tools (rail on desktop, tab bar on phones)
  "tools.label": "Tools",
  "tools.groupEdit": "Edit",
  "tools.groupView": "View",
  "tools.browse": "Browse",
  "tools.browseTip": "Scroll and zoom without changing anything ({key})",
  "tools.editText": "Edit text",
  "tools.editShort": "Edit",
  "tools.editTextTip": "Edit text: choose a line and change it",
  "tools.pages": "Pages",
  "tools.pagesTip": "Show or hide the page thumbnails",
  "tools.details": "Details",
  "tools.detailsTip": "Show or hide the details panel",
  "tools.more": "More",

  // Page thumbnails
  "pages.title": "Pages",
  "pages.countOne": "1 page",
  "pages.count": "{count} pages",
  "pages.thumbEdited": "Page {page}, edited",
  "pages.edited": "Edited",

  // Details panel
  "details.label": "Details",
  "details.document": "Document",
  "details.file": "File",
  "details.pages": "Pages",
  "details.pageSize": "Page size",
  "details.pageSizeValue": "{w} × {h} mm",
  "details.pageSizeNamed": "{name} · {w} × {h} mm",
  "details.protected": "Protected",
  "details.protectedValue": "Yes · the downloaded copy is not protected",
  "details.edits": "Edits",
  "details.editsNone": "None yet",
  "details.notDownloaded": "Not downloaded yet",
  "details.downloaded": "Downloaded",
  "details.howTo": "To change a line of text, choose Edit text, then click the line.",
  "details.editTitle": "Edit text",
  "details.step1": "Click a highlighted line to change it.",
  "details.step2": "Type the new text, then press Enter.",
  "details.step3": "When you are done, download the PDF.",
  "details.legendEditable": "Line you can edit",
  "details.legendLocked": "Line that can't be edited yet",
  "details.line": "Selected line",
  "details.font": "Font",
  "details.fontUnknown": "Unnamed font",
  "details.fontSubset": "The PDF holds only the letters this document uses: new letters may be written with a similar font.",
  "details.fontFull": "The whole font is in the PDF.",
  "details.size": "Size",
  "details.sizeValue": "{size} pt",
  "details.style": "Style",
  "details.styleRegular": "Regular",
  "details.styleBold": "Bold",
  "details.styleItalic": "Italic",
  "details.styleBoldItalic": "Bold italic",
  "details.color": "Colour",
  "details.wholeLine": "The whole line is replaced; font, size and colour stay the same.",
  "details.shortcuts": "Shortcuts",
  "details.privacy": "Everything happens on this device: the file is never uploaded.",

  // Keyboard shortcut names
  "key.enter": "Enter",
  "key.esc": "Esc",
  "shortcut.apply": "Apply the change",
  "shortcut.cancel": "Cancel the change",
  "shortcut.undo": "Undo",
  "shortcut.redo": "Redo",
  "shortcut.download": "Download",
  "shortcut.exitEdit": "Stop editing",

  // Line editor
  "edit.apply": "Apply",
  "edit.applyTip": "Apply ({key})",
  "edit.cancel": "Cancel",
  "edit.cancelTip": "Cancel ({key})",
  "edit.writing": "Writing…",
  "edit.done": "Done",
  "edit.doneTip": "Stop editing ({key})",
  "edit.fontInfo": "{font} · {size} pt",

  // Phone sheets, closing a document
  "more.title": "More",
  "more.openOther": "Open another PDF",
  "more.zoom": "Zoom",
  "unsaved.closeBody": "You have edits you haven't downloaded yet. If you close this PDF, they will be lost.",
  "unsaved.closeConfirm": "Close anyway",
} as const;

export type MessageKey = keyof typeof en;
/** The shape every translation must have: the same keys, any strings. */
export type Messages = { readonly [K in MessageKey]: string };
