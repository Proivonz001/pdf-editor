// Cerca's highlights on one page (release 5): every result on the page drawn from its quads, so a
// result across lines is several shapes and vertical, rotated or slanted text is covered as it
// runs; the current result also gets an outline, so it is not told by colour alone (and is drawn
// last, over its neighbours). Nothing to click and nothing for screen readers (the search bar says
// the current result in words). It reads the hits itself (ui/search/runner.ts), so a new result
// re-renders only the layers of the pages that show them; PageView mounts it on the pages near the
// screen in any tool while there are results. Styled by styles/search.css: page marks, which read
// on the white page in both themes, and system colours in forced-colours mode.
import type { Quad } from "../engine/protocol";
import { currentSearchHit, hitsByPage } from "../ui/search/runner";
import type { PageModel } from "./model";

const round = (v: number) => Math.round(v * 10) / 10;

/** The corners of `q` (ul, ur, ll, lr) round the shape, in px from the page's top-left at `zoom`. */
export function quadPoints(q: Quad, origin: readonly [number, number], zoom: number): string {
  const p = (x: number, y: number) => `${round((x - origin[0]) * zoom)},${round((y - origin[1]) * zoom)}`;
  return `${p(q[0], q[1])} ${p(q[2], q[3])} ${p(q[6], q[7])} ${p(q[4], q[5])}`;
}

export function SearchLayer({ page, zoom }: { page: PageModel; zoom: number }) {
  const hits = hitsByPage.value.get(page.index);
  const current = currentSearchHit.value;
  if (!hits?.length) return null;
  const origin: [number, number] = [page.bounds[0], page.bounds[1]];
  const ordered = current && hits.includes(current) ? [...hits.filter((h) => h !== current), current] : hits;
  return (
    <svg class="search-layer" aria-hidden="true" focusable="false">
      {ordered.map((hit, i) =>
        hit.quads.map((q, k) => (
          <polygon key={`${i}:${k}`} class={hit === current ? "search-hit is-current" : "search-hit"}
            points={quadPoints(q, origin, zoom)} />
        )))}
    </svg>
  );
}
