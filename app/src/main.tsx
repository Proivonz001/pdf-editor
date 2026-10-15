import { render } from "preact";
import { App } from "./app";
import { registerPwa } from "./platform/pwa";
import "./styles.css";

render(<App />, document.getElementById("app")!);
registerPwa();
