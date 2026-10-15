// Runs the test matrix with a given mupdf module and a fixture loader, so the
// Node runner and the Web Worker execute exactly the same steps.
import { CASES } from "./cases.mjs";
import { now, openPdf, renderPixmap, replaceText, savePdf, verifyEdits } from "./core.mjs";

const ms = (v) => +v.toFixed(1);

// onCase(result, { outBytes, crops: [{ name, pixmap }] }) is called per case.
export async function runSuite(mupdf, loadFixture, onCase, { only = null, subset = "fallback" } = {}) {
	const results = [];
	for (const c of CASES) {
		if (only && !only.includes(c.id)) continue;
		const r = { id: c.id, file: c.file, page: (c.page || 0) + 1, timings: {} };
		try {
			const bytes = await loadFixture(c.file);
			let t0 = now();
			const { doc, info } = openPdf(mupdf, bytes, c.password || "");
			r.timings.open = ms(now() - t0);
			r.encrypted = info.needsPassword ? `user password (auth=${info.auth})` : "";
			const pageIndex = c.page || 0;

			t0 = now();
			const pix = renderPixmap(mupdf, doc.loadPage(pageIndex), 1.5);
			r.timings.renderPage1_5x = ms(now() - t0);
			r.renderSize = `${pix.getWidth()}x${pix.getHeight()}`;
			pix.destroy();

			r.edits = [];
			for (const e of c.edits) {
				const edit = replaceText(mupdf, doc, pageIndex, e.find, e.replace);
				for (const [k, v] of Object.entries(edit.timings)) r.timings[k] = ms((r.timings[k] || 0) + v);
				r.edits.push(edit);
			}

			t0 = now();
			const { bytes: outBytes, opts } = savePdf(mupdf, doc, { decrypt: true, subset });
			r.subset = subset;
			r.timings.save = ms(now() - t0);
			r.saveOptions = opts;
			r.sizeIn = bytes.length;
			r.sizeOut = outBytes.length;
			doc.destroy();

			t0 = now();
			r.verify = verifyEdits(mupdf, bytes, outBytes, c.password || "", r.edits.map((e) => ({ ...e, find: e.find })));
			r.timings.verify = ms(now() - t0);
			r.ok = summarize(r);

			// Before/after crops around each edit, for eyeballing.
			const crops = [];
			const { doc: before } = openPdf(mupdf, bytes, c.password || "");
			const { doc: after } = openPdf(mupdf, outBytes, "");
			r.edits.forEach((e, i) => {
				const v = r.verify.edits[i];
				const b = v.newBBox || e.original.bbox;
				const box = [Math.min(b[0], e.original.bbox[0]) - 40, Math.min(b[1], e.original.bbox[1]) - 14,
					Math.max(b[2], e.original.bbox[2]) + 40, Math.max(b[3], e.original.bbox[3]) + 14];
				crops.push({ name: `${c.id}-${i + 1}-before`, pixmap: renderPixmap(mupdf, before.loadPage(pageIndex), 3, box) });
				crops.push({ name: `${c.id}-${i + 1}-after`, pixmap: renderPixmap(mupdf, after.loadPage(pageIndex), 3, box) });
			});
			before.destroy();
			after.destroy();
			await onCase(r, { outBytes, crops });
			for (const cr of crops) cr.pixmap.destroy();
		} catch (err) {
			r.ok = false;
			r.error = String(err && err.stack || err);
			await onCase(r, { outBytes: null, crops: [] });
		}
		results.push(r);
	}
	return results;
}

// A case passes when every edit verifies and nothing else on the page moved.
export function summarize(r) {
	const v = r.verify;
	const editsOk = v.edits.every((e, i) =>
		e.oldWordGone && e.newTextExtracts && e.neighboursKept !== false && e.baselineDelta < 0.01 &&
		e.sizeDelta < 0.01 && e.dirSame && e.colorSame && r.edits[i].missing.length === 0 &&
		e.fontsAsPlanned.split("/")[0] === e.fontsAsPlanned.split("/")[1] &&
		e.glyphIdsSameAsElsewhere.split("/")[0] === e.glyphIdsSameAsElsewhere.split("/")[1]);
	const pixelsOk = Object.values(v.pixelsChangedOutsideEdits).every((n) => n === 0);
	const sb = v.structureBefore, sa = v.structureAfter;
	const structOk = sb.pages === sa.pages && sb.outlineItems === sa.outlineItems &&
		sb.acroFormFields === sa.acroFormFields && JSON.stringify(sb.widgets) === JSON.stringify(sa.widgets) &&
		JSON.stringify(sb.links) === JSON.stringify(sa.links);
	const tagsOk = !v.tags || v.tags.ok; // tagged PDFs: replacement tagged, tree intact
	return editsOk && pixelsOk && structOk && tagsOk && v.reopenedWithoutPassword;
}
