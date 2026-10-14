// Node 22 runner:  node prototypes/mupdf-text/run-node.mjs [case-id ...] [--subset=fallback|all|none]
// Writes out/<case>.pdf, out/<case>-<n>-before|after.png and out/results-node.json.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runSuite } from "./src/suite.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, "out");
fs.mkdirSync(outDir, { recursive: true });

const args = process.argv.slice(2);
const subset = (args.find((a) => a.startsWith("--subset=")) || "--subset=fallback").split("=")[1];
const tag = subset === "fallback" ? "" : "-subset-" + subset;
const only = args.filter((a) => !a.startsWith("--"));

const t0 = performance.now();
const mupdf = await import(pathToFileURL(path.join(here, "../../lib/mupdf.js")).href);
const initMs = +(performance.now() - t0).toFixed(1);

const results = await runSuite(
	mupdf,
	async (file) => new Uint8Array(fs.readFileSync(path.join(here, "fixtures", file))),
	async (r, { outBytes, crops }) => {
		if (outBytes) fs.writeFileSync(path.join(outDir, `${r.id}${tag}.pdf`), outBytes);
		if (!tag) for (const c of crops) fs.writeFileSync(path.join(outDir, c.name + ".png"), c.pixmap.asPNG());
		const segs = (r.edits || []).map((e) => e.segments.map((s) => `${s.source === "original" ? "O" : s.source === "fallback" ? "F" : "S"}:${s.text}`).join("|")).join(" ; ");
		console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.id.padEnd(24)} ${segs}${r.error ? "  " + r.error.split("\n")[0] : ""}`);
	},
	{ only: only.length ? only : null, subset },
);

const report = { runtime: `node ${process.version}`, mupdf: "lib/mupdf.js 1.27.0", wasmInitMs: initMs, subset, results };
fs.writeFileSync(path.join(outDir, `results-node${tag}.json`), JSON.stringify(report, (k, v) => (k === "font" || k === "fzFont" || k === "ref" ? undefined : v), 1));
console.log(`\nwasm init ${initMs} ms; ${results.filter((r) => r.ok).length}/${results.length} cases pass`);
