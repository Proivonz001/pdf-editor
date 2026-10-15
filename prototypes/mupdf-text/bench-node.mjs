// Large-document benchmark in Node:  node prototypes/mupdf-text/bench-node.mjs [edits]
// Needs fixtures/large-220p.pdf (python -I prototypes/mupdf-text/fixtures/src/make_large.py).
// Writes out/large-220p-edited.pdf and out/bench-node.json.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runLargeBench } from "./src/bench.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(here, "fixtures", "large-220p.pdf");
if (!fs.existsSync(file)) {
	console.error("fixtures/large-220p.pdf is missing: run fixtures/src/make_large.py first (needs Chrome)");
	process.exit(1);
}
const mupdf = await import(pathToFileURL(path.join(here, "../../lib/mupdf.js")).href);
const MB = (n) => +(n / 1048576).toFixed(1);
const memory = () => {
	const m = process.memoryUsage();
	return { rssMB: MB(m.rss), jsHeapMB: MB(m.heapUsed) };
};
const edits = +(process.argv[2] || 50);
const res = await runLargeBench(mupdf, new Uint8Array(fs.readFileSync(file)), {
	edits, memory, onStep: (h) => console.log(JSON.stringify(h)),
});
fs.mkdirSync(path.join(here, "out"), { recursive: true });
fs.writeFileSync(path.join(here, "out", "large-220p-edited.pdf"), res.outBytes);
const report = { runtime: `node ${process.version}`, file: "large-220p.pdf", runs: res.runs, heap: res.heap };
fs.writeFileSync(path.join(here, "out", "bench-node.json"), JSON.stringify(report, null, 1));
for (const r of res.runs) {
	const { edits: list, ...rest } = r;
	console.log(JSON.stringify(rest));
	if (r.cycle === 1) console.log(list.slice(0, 6).join("\n"));
}
