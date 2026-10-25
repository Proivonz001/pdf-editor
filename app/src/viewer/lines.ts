// Text lines of a page, read from the engine on demand (edit mode, page near the viewport) and
// cached in page.lines until the page changes (invalidatePages() drops the cache).
import { engine } from "../state";
import type { PageModel } from "./model";

const loading = new WeakMap<PageModel, { rev: number; done: Promise<void> }>();

/**
 * Read the lines of `page` unless they are cached for its current revision or already loading.
 * Settles when they are in page.lines (or the read is over: failed, or stale after a change).
 */
export function ensureLines(page: PageModel): Promise<void> {
  const rev = page.rev.peek();
  const cached = page.lines.peek();
  if (cached && cached.rev === rev) return Promise.resolve();
  const now = loading.get(page);
  if (now?.rev === rev) return now.done;
  const done = engine()
    .lines(page.index)
    .then(
      (lines) => {
        // A change landed while reading: these lines are stale, the next render asks again.
        if (page.rev.peek() === rev) page.lines.value = { rev, lines };
      },
      (err: unknown) => {
        console.warn(`Reading the lines of page ${page.index + 1} failed`, err);
        if (page.rev.peek() === rev) page.lines.value = { rev, lines: [], failed: true };
      },
    )
    .finally(() => {
      if (loading.get(page)?.rev === rev) loading.delete(page);
    });
  loading.set(page, { rev, done });
  return done;
}
