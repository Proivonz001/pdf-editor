// Italian strings. Plain, friendly Italian; same keys and placeholders as en.ts.
import type { Messages } from "./en";

export const it: Messages = {
  "app.name": "PDF Editor",

  // Schermata iniziale
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
  "edit.lockedLabel": "Riga non ancora modificabile: {text}",
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

  // Pagina iniziale
  "home.titleLead": "Modifica il",
  "home.titleMark": "testo vero",
  "home.titleTail": "del tuo PDF",
  "home.subtitle": "Cambia le parole del tuo PDF e mantieni il font originale. Dal computer o dal telefono, gratis.",
  "home.f1Title": "Il testo vero",
  "home.f1Body": "Niente riquadri bianchi incollati sopra: cambia la riga stessa, nel suo font originale.",
  "home.f2Title": "Computer e telefono",
  "home.f2Body": "Funziona nel browser e si installa come app. Anche senza connessione.",
  "home.f3Title": "Resta sul tuo dispositivo",
  "home.f3Body": "Il file non viene mai caricato online: si apre e si salva qui.",
  "home.stepsTitle": "Come funziona",
  "home.step1": "Apri un PDF",
  "home.step2": "Scegli una riga e scrivi",
  "home.step3": "Scarica il PDF modificato",
  "home.free": "Gratis e open source",
  "home.sampleLine": "Fattura n. 2026-117",
  "home.sampleLabel": "Esempio: una riga di un PDF mentre viene modificata",

  // Barra in alto, con un documento
  "toolbar.close": "Chiudi documento",
  "toolbar.closeTip": "Chiudi questo PDF e torna all'inizio",
  "toolbar.downloadPdf": "Scarica PDF",
  "toolbar.edited": "Modificato",
  "toolbar.source": "Codice sorgente",

  // Strumenti (barra laterale sul computer, barra in basso sul telefono)
  "tools.label": "Strumenti",
  "tools.groupEdit": "Modifica",
  "tools.groupView": "Vista",
  "tools.browse": "Sfoglia",
  "tools.browseTip": "Scorri e ingrandisci senza cambiare nulla ({key})",
  "tools.editText": "Modifica testo",
  "tools.editShort": "Modifica",
  "tools.editTextTip": "Modifica testo: scegli una riga e cambiala",
  "tools.pages": "Pagine",
  "tools.pagesTip": "Mostra o nascondi le miniature delle pagine",
  "tools.details": "Dettagli",
  "tools.detailsTip": "Mostra o nascondi il pannello dei dettagli",
  "tools.more": "Altro",

  // Miniature delle pagine
  "pages.title": "Pagine",
  "pages.countOne": "1 pagina",
  "pages.count": "{count} pagine",
  "pages.thumbEdited": "Pagina {page}, modificata",
  "pages.edited": "Modificata",

  // Pannello dei dettagli
  "details.label": "Dettagli",
  "details.document": "Documento",
  "details.file": "File",
  "details.pages": "Pagine",
  "details.pageSize": "Formato pagina",
  "details.pageSizeValue": "{w} × {h} mm",
  "details.pageSizeNamed": "{name} · {w} × {h} mm",
  "details.protected": "Protetto",
  "details.protectedValue": "Sì · la copia scaricata non è protetta",
  "details.edits": "Modifiche",
  "details.editsNone": "Nessuna per ora",
  "details.notDownloaded": "Non ancora scaricate",
  "details.downloaded": "Scaricate",
  "details.howTo": "Per cambiare una riga di testo, scegli Modifica testo e fai clic sulla riga.",
  "details.editTitle": "Modifica testo",
  "details.step1": "Fai clic su una riga evidenziata per cambiarla.",
  "details.step2": "Scrivi il nuovo testo e premi Invio.",
  "details.step3": "Quando hai finito, scarica il PDF.",
  "details.legendEditable": "Riga modificabile",
  "details.legendLocked": "Riga non ancora modificabile",
  "details.line": "Riga selezionata",
  "details.font": "Font",
  "details.fontUnknown": "Font senza nome",
  "details.fontSubset": "Il PDF contiene solo le lettere usate nel documento: quelle nuove potrebbero essere scritte con un font simile.",
  "details.fontFull": "Il font è incluso per intero nel PDF.",
  "details.size": "Dimensione",
  "details.sizeValue": "{size} pt",
  "details.style": "Stile",
  "details.styleRegular": "Normale",
  "details.styleBold": "Grassetto",
  "details.styleItalic": "Corsivo",
  "details.styleBoldItalic": "Grassetto corsivo",
  "details.color": "Colore",
  "details.wholeLine": "Viene sostituita la riga intera; font, dimensione e colore restano gli stessi.",
  "details.shortcuts": "Scorciatoie",
  "details.privacy": "Tutto avviene su questo dispositivo: il file non viene mai caricato online.",

  // Nomi delle scorciatoie
  "key.enter": "Invio",
  "key.esc": "Esc",
  "shortcut.apply": "Applica la modifica",
  "shortcut.cancel": "Lascia la riga com'era",
  "shortcut.undo": "Annulla l'ultima modifica",
  "shortcut.redo": "Ripeti",
  "shortcut.download": "Scarica",
  "shortcut.exitEdit": "Esci dalla modifica",

  // Campo di modifica della riga
  "edit.apply": "Applica",
  "edit.applyTip": "Applica ({key})",
  "edit.cancel": "Annulla",
  "edit.cancelTip": "Annulla ({key})",
  "edit.writing": "Sto scrivendo…",
  "edit.done": "Fine",
  "edit.doneTip": "Esci dalla modifica ({key})",
  "edit.fontInfo": "{font} · {size} pt",

  // Fogli del telefono, chiusura del documento
  "more.title": "Altro",
  "more.openOther": "Apri un altro PDF",
  "more.zoom": "Zoom",
  "unsaved.closeBody": "Hai delle modifiche che non hai ancora scaricato. Se chiudi questo PDF, andranno perse.",
  "unsaved.closeConfirm": "Chiudi lo stesso",
};
