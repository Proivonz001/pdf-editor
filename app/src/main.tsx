import { render } from "preact";
import { App } from "./app";
import { listenForInstall } from "./platform/install";
import { registerPwa } from "./platform/pwa";
import { startAutosave } from "./ui/resume/autosave";
import "./styles/index.css";

// Before the first render: Chromium can offer to install (beforeinstallprompt) that early; and
// Riprendi starts reading what this device kept, for the home page's card.
listenForInstall();
startAutosave();
render(<App />, document.getElementById("app")!);
registerPwa();
