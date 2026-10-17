import { render } from "preact";
import { App } from "./app";
import { listenForInstall } from "./platform/install";
import { registerPwa } from "./platform/pwa";
import "./styles/index.css";

// Before the first render: Chromium can offer to install (beforeinstallprompt) that early.
listenForInstall();
render(<App />, document.getElementById("app")!);
registerPwa();
