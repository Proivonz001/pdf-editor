// Italian strings. Plain, friendly Italian; same keys and placeholders as en.ts.
import type { Messages } from "./en";

export const it: Messages = {
  "app.name": "PDF Editor",

  // Schermata iniziale
  "empty.title": "Modifica il testo di un PDF",
  "empty.subtitle": "Cambia il testo vero del tuo PDF, dal computer o dal telefono.",
  "empty.open": "Apri un PDF",
  "empty.dropHint": "Oppure trascina un PDF in un punto qualsiasi della pagina.",
  "empty.privacy": "Il tuo file non lascia mai questo dispositivo.",
  "empty.source": "Codice sorgente (AGPL-3.0)",

  // Motore
  "engine.loading": "Sto caricando il motore PDF (circa 10 MB, solo la prima volta)…",
  "engine.failed": "Il motore PDF non è partito. Ricarica la pagina per riprovare.",
  "engine.crashed": "Il motore PDF si è fermato. Ricarica la pagina per continuare.",
  "engine.reload": "Ricarica",

  // Apertura
  "open.opening": "Sto aprendo “{name}”…",
  "open.waitingEngine": "Sto preparando il motore PDF…",
  "open.damagedTitle": "Impossibile aprire il file",
  "open.damaged": "“{name}” sembra danneggiato, oppure non è un PDF.",
  "open.failed": "Qualcosa è andato storto nell'aprire “{name}”.",
  "drop.overlay": "Rilascia il PDF per aprirlo",
  "drop.notPdf": "Questo file non è un PDF.",

  // Password
  "password.title": "Questo PDF è protetto",
  "password.body": "Scrivi la password per aprire “{name}”.",
  "password.label": "Password",
  "password.wrong": "Password sbagliata. Riprova.",
  "password.open": "Apri",

  // Comuni
  "common.cancel": "Annulla",
  "common.ok": "OK",
  "common.close": "Chiudi",

  // Modifiche non scaricate
  "unsaved.title": "Modifiche non scaricate",
  "unsaved.openBody": "Hai delle modifiche che non hai ancora scaricato. Se apri un altro file, andranno perse.",
  "unsaved.openConfirm": "Apri lo stesso",
  "unsaved.updateBody": "L'aggiornamento ricarica l'app e le modifiche non scaricate andranno perse.",
  "unsaved.updateConfirm": "Aggiorna lo stesso",

  // Barra in alto
  "toolbar.open": "Apri",
  "toolbar.openTip": "Apri un PDF ({shortcut})",
  "toolbar.undo": "Annulla modifica",
  "toolbar.undoTip": "Annulla l'ultima modifica ({shortcut})",
  "toolbar.redo": "Ripeti modifica",
  "toolbar.redoTip": "Ripeti la modifica ({shortcut})",
  "toolbar.zoomOut": "Riduci",
  "toolbar.zoomOutTip": "Riduci ({shortcut})",
  "toolbar.zoomIn": "Ingrandisci",
  "toolbar.zoomInTip": "Ingrandisci ({shortcut})",
  "toolbar.fitWidth": "Adatta alla larghezza",
  "toolbar.fitWidthTip": "Adatta alla larghezza ({shortcut})",
  "toolbar.zoomValue": "Zoom: {percent}",
  "toolbar.editText": "Modifica testo",
  "toolbar.editTextTip": "Modifica testo: scegli una riga e cambiala",
  "toolbar.download": "Scarica",
  "toolbar.downloadTip": "Scarica il PDF modificato ({shortcut})",
  "toolbar.share": "Condividi",
  "toolbar.more": "Altro",
  "toolbar.update": "Aggiornamento disponibile",
  "toolbar.updateTip": "È pronta una nuova versione: fai clic per aggiornare",
  "toolbar.updateInstalledTip": "In un'altra finestra è stata installata una nuova versione. Si carica alla prossima apertura dell'app: fai clic per ricaricare ora",
  "toolbar.unsaved": "Modifiche non scaricate",
  "lang.tip": "Cambia lingua",

  // Visualizzatore
  "viewer.label": "Documento",
  "viewer.page": "Pagina {page}",
  "viewer.indicator": "{page} / {count}",
  "viewer.indicatorLabel": "Pagina {page} di {count}",
  "viewer.working": "Un attimo…",

  // Modifica del testo
  "edit.hint": "Fai clic su una riga per cambiarla. Viene sostituita la riga intera.",
  "edit.hintTouch": "Tocca una riga per cambiarla. Viene sostituita la riga intera.",
  "edit.lineLabel": "Modifica la riga: {text}",
  "edit.lockedLabel": "Riga non modificabile: {text}",
  "edit.notEditable": "Questa riga contiene caratteri che non si possono ancora modificare.",
  "edit.inputLabel": "Nuovo testo della riga",
  "edit.fallback": "Non presenti nel font originale, scritti con uno simile: {chars}",
  "edit.missing": "Non è stato possibile scriverli (nessun font li contiene): {chars}",
  "edit.failed": "Non è stato possibile cambiare questa riga.",
  "history.failed": "Non è stato possibile annullare o ripetere l'ultima modifica.",
  "broken.title": "Modifica interrotta",
  "broken.body": "Qualcosa è andato storto durante la modifica di questo PDF e non è più possibile modificarlo. Scaricalo ora per tenere le modifiche fatte finora, oppure ricarica la pagina e apri di nuovo il file.",
  "broken.note": "La modifica è disattivata per questo file: scaricalo per tenere le modifiche, oppure ricarica la pagina per ricominciare.",

  // Aggiornamento dell'app
  "update.installedElsewhere": "In un'altra finestra è stata installata una nuova versione dell'app. Questa finestra continua a funzionare e passerà alla nuova versione la prossima volta che apri l'app.",

  // Download e condivisione
  "download.suffix": "-modificato",
  "download.done": "Scaricato “{name}”.",
  "download.failed": "Non è stato possibile creare il PDF.",
  "share.readyTitle": "Il tuo PDF è pronto",
  "share.readyBody": "“{name}” è pronto da condividere.",
  "share.share": "Condividi",
  "share.failed": "Non è stato possibile condividere il file.",
};
