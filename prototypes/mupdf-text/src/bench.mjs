// Large-document benchmark, shared by bench-node.mjs and the Web Worker:
// open a 200+ page PDF, render page 1, make `edits` replacements spread over
// the pages, save, re-open and check every edit, then do it all again to see
// whether memory comes back. Memory is the WebAssembly heap (it only grows,
// so its size is the high-water mark of MuPDF's allocations).
import { now, openPdf, renderPixmap, replaceText, savePdf, extractLines, pageText, countOccurrences } from "./core.mjs";

// The wasm heap: any mupdf Buffer view is a window on the module's memory.
export function wasmHeapBytes(mupdf) {
	const b = new mupdf.Buffer();
	const n = b.asUint8Array().buffer.byteLength;
	b.destroy();
	return n;
}

const EDITS = [
	{ find: "prezzo", replace: "importo" },
	{ find: "consegna", replace: "spedizione" },
	{ find: "Capitolo", replace: "Sezione" },
];

const stats = (xs) => {
	const s = [...xs].sort((a, b) => a - b);
	const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
	return { n: s.length, median: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), max: +s[s.length - 1].toFixed(1), total: +s.reduce((a, b) => a + b, 0).toFixed(0) };
};
const MB = (n) => +(n / 1048576).toFixed(1);

// memory(): extra numbers the host can add (Node: process.memoryUsage()).
export async function runLargeBench(mupdf, bytes, { edits = 50, cycles = 2, memory = () => ({}), onStep = () => {} } = {}) {
	const heap = [];
	const mark = (label) => {
		const h = { step: label, wasmHeapMB: MB(wasmHeapBytes(mupdf)), ...memory() };
		heap.push(h);
		onStep(h);
	};
	const runs = [];
	let outBytes = null;
	mark("start");
	for (let cycle = 1; cycle <= cycles; cycle++) {
		const r = { cycle };
		let t0 = now();
		const { doc } = openPdf(mupdf, bytes);
		r.openMs = +(now() - t0).toFixed(1);
		const n = doc.countPages();
		r.pages = n;
		t0 = now();
		const page1 = doc.loadPage(0);
		const pix = renderPixmap(mupdf, page1, 1.5);
		r.renderPage1Ms = +(now() - t0).toFixed(1);
		pix.destroy();
		page1.destroy();
		mark(`cycle ${cycle}: opened, page 1 rendered`);

		const times = [], plan = [], steps = {};
		for (let i = 0; i < edits; i++) {
			const page = Math.round((i * (n - 1)) / Math.max(1, edits - 1));
			plan.push({ page, ...EDITS[i % EDITS.length] });
		}
		for (const [i, e] of plan.entries()) {
			t0 = now();
			const res = replaceText(mupdf, doc, e.page, e.find, e.replace);
			times.push(now() - t0);
			for (const [k, v] of Object.entries(res.timings)) (steps[k] ||= []).push(v);
			e.segments = res.segments.map((s) => s.source[0].toUpperCase() + ":" + s.text).join("|");
			e.tagged = !!(res.tag && res.tag.newMcid !== undefined);
			if ((i + 1) % 10 === 0) mark(`cycle ${cycle}: ${i + 1} edits`);
		}
		r.editMs = stats(times);
		r.editMsFirst5 = times.slice(0, 5).map((v) => +v.toFixed(1));
		r.editStepMedianMs = Object.fromEntries(Object.entries(steps).map(([k, v]) => [k, stats(v).median]));
		r.taggedEdits = plan.filter((e) => e.tagged).length;
		t0 = now();
		const saved = savePdf(mupdf, doc, { decrypt: true });
		r.saveMs = +(now() - t0).toFixed(1);
		r.sizeIn = bytes.length;
		r.sizeOut = saved.bytes.length;
		mark(`cycle ${cycle}: saved`);
		doc.destroy();
		mark(`cycle ${cycle}: document destroyed`);

		// Re-open the result: every edit's page must have one fewer old word
		// and the new one, the other pages must be untouched in text.
		t0 = now();
		const { doc: before } = openPdf(mupdf, bytes);
		const { doc: after } = openPdf(mupdf, saved.bytes);
		let ok = 0;
		const byPage = new Map();
		for (const e of plan) byPage.set(e.page, (byPage.get(e.page) || []).concat(e));
		const textOf = (d, p) => {
			const pg = d.loadPage(p);
			const t = pageText(extractLines(pg));
			pg.destroy(); // a page wrapper keeps its document alive until JS GC
			return t;
		};
		for (const [p, list] of byPage) {
			const tb = textOf(before, p), ta = textOf(after, p);
			for (const e of list)
				if (countOccurrences(ta, e.find) === countOccurrences(tb, e.find) - list.filter((x) => x.find === e.find).length && ta.includes(e.replace)) ok++;
		}
		r.verifiedEdits = `${ok}/${plan.length}`;
		r.verifyMs = +(now() - t0).toFixed(0);
		// What the viewer does with a big file: thumbnails of every page.
		t0 = now();
		for (let i = 0; i < after.countPages(); i++) {
			const pg = after.loadPage(i);
			renderPixmap(mupdf, pg, 0.15).destroy();
			pg.destroy();
		}
		r.thumbnailsAllPagesMs = +(now() - t0).toFixed(0);
		before.destroy();
		after.destroy();
		mark(`cycle ${cycle}: verified, thumbnails rendered`);
		r.edits = plan.map((e) => `p${e.page + 1} ${e.find}->${e.replace} ${e.segments}${e.tagged ? " [tagged]" : ""}`);
		runs.push(r);
		outBytes = saved.bytes;
	}
	return { runs, heap, outBytes };
}
