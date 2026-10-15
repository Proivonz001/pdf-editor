// Module Web Worker: all MuPDF work happens here, the page only draws bitmaps.
import { openPdf, pixmapToRGBA, renderPixmap, replaceText, savePdf, verifyEdits, now } from "./core.mjs";
import { runSuite } from "./suite.mjs";
import { runLargeBench } from "./bench.mjs";

const t0 = now();
const mupdf = await import("../../../lib/mupdf.js");
const initMs = now() - t0;

async function toBitmap(pix) {
	const { width, height, rgba } = pixmapToRGBA(pix);
	return createImageBitmap(new ImageData(rgba, width, height));
}

const fixture = async (file) => new Uint8Array(await (await fetch(new URL(`../fixtures/${file}`, import.meta.url))).arrayBuffer());

self.onmessage = async ({ data: msg }) => {
	try {
		if (msg.type === "suite") {
			const t = now();
			const results = await runSuite(mupdf, fixture, async (r, { crops }) => {
				const bitmaps = [];
				for (const c of crops) bitmaps.push({ name: c.name, bitmap: await toBitmap(c.pixmap) });
				self.postMessage({ type: "case", result: r, crops: bitmaps }, bitmaps.map((b) => b.bitmap));
			}, { subset: msg.subset || "fallback" });
			self.postMessage({ type: "suite-done", initMs, totalMs: now() - t, pass: results.filter((r) => r.ok).length, count: results.length });
		} else if (msg.type === "render") {
			const bytes = msg.bytes || await fixture(msg.file);
			let t = now();
			const { doc } = openPdf(mupdf, bytes, msg.password || "");
			const openMs = now() - t;
			const page = doc.loadPage(msg.page || 0);
			t = now();
			const pix = renderPixmap(mupdf, page, msg.scale || 1.5);
			const renderMs = now() - t;
			t = now();
			const bitmap = await toBitmap(pix);
			const bitmapMs = now() - t;
			pix.destroy();
			doc.destroy();
			self.postMessage({ type: "render-done", initMs, openMs, renderMs, bitmapMs, bitmap }, [bitmap]);
		} else if (msg.type === "edit") {
			const bytes = msg.bytes;
			const { doc } = openPdf(mupdf, bytes, msg.password || "");
			const pageIndex = (msg.page || 1) - 1;
			const edit = replaceText(mupdf, doc, pageIndex, msg.find, msg.replace);
			let t = now();
			const { bytes: out } = savePdf(mupdf, doc, { subset: msg.subset || "fallback" });
			const saveMs = now() - t;
			doc.destroy();
			const verify = verifyEdits(mupdf, bytes, out, msg.password || "", [edit]);
			const { doc: before } = openPdf(mupdf, bytes, msg.password || "");
			const { doc: after } = openPdf(mupdf, out, "");
			const b = verify.edits[0].newBBox || edit.original.bbox, o = edit.original.bbox;
			const box = [Math.min(b[0], o[0]) - 60, Math.min(b[1], o[1]) - 20, Math.max(b[2], o[2]) + 60, Math.max(b[3], o[3]) + 20];
			const crop = async (d) => {
				const pix = renderPixmap(mupdf, d.loadPage(pageIndex), 2.5, box);
				const bitmap = await toBitmap(pix);
				pix.destroy();
				return bitmap;
			};
			const crops = [{ name: "before", bitmap: await crop(before) }, { name: "after", bitmap: await crop(after) }];
			before.destroy();
			after.destroy();
			self.postMessage({ type: "edit-done", edit, verify, saveMs, out, crops },
				[out.buffer, ...crops.map((c) => c.bitmap)]);
		} else if (msg.type === "bench") {
			const bytes = await fixture(msg.file || "large-220p.pdf");
			const res = await runLargeBench(mupdf, bytes, {
				edits: msg.edits || 50,
				onStep: (step) => self.postMessage({ type: "bench-step", step }),
			});
			self.postMessage({ type: "bench-done", initMs, runs: res.runs, heap: res.heap });
		}
	} catch (err) {
		self.postMessage({ type: "error", message: String(err && err.stack || err) });
	}
};

self.postMessage({ type: "ready", initMs });
