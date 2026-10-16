// Images of a page, read from the engine on demand (edit mode, page near the viewport) and cached
// in page.images until the page changes (invalidatePages() drops the cache), like the lines in
// lines.ts. Also the sprite of the selected image: that one placement alone on a transparent
// bitmap, shown moving with the pointer while it is dragged (ImageLayer). One sprite is kept at a
// time, because it can take a few megabytes; its bitmap is closed as soon as another one replaces
// it, the page changes, or the selection goes (releaseSprite).
import type { ImageRenderResult } from "../engine/protocol";
import { engine } from "../state";
import type { PageModel } from "./model";

const loading = new WeakMap<PageModel, number>();

/** Read the images of `page` unless they are cached for its current revision or already loading. */
export function ensureImages(page: PageModel) {
  const rev = page.rev.peek();
  const cached = page.images.peek();
  if (cached && cached.rev === rev) return;
  if (loading.get(page) === rev) return;
  loading.set(page, rev);
  engine()
    .images(page.index)
    .then(
      (images) => {
        // A change landed while reading: these images are stale, the next render asks again.
        if (page.rev.peek() === rev) page.images.value = { rev, images };
      },
      (err: unknown) => {
        console.warn(`Reading the images of page ${page.index + 1} failed`, err);
        if (page.rev.peek() === rev) page.images.value = { rev, images: [], failed: true };
      },
    )
    .finally(() => {
      if (loading.get(page) === rev) loading.delete(page);
    });
}

interface SpriteEntry {
  page: PageModel;
  imageIndex: number;
  rev: number;
  scale: number;
  /** The result once it has arrived (null when the engine could not render it). */
  promise: Promise<ImageRenderResult | null>;
  result: ImageRenderResult | null;
}

/** The one sprite kept (or being rendered). */
let sprite: SpriteEntry | null = null;

function closeEntry(entry: SpriteEntry | null) {
  entry?.result?.bitmap.close();
}

/**
 * The sprite of image `imageIndex` of `page` as read at revision `rev`, rendered at `scale`
 * pixels per point. The same request while one is cached or on its way gets the same answer.
 * Resolves null when the page changed meanwhile, another sprite was asked for, or rendering
 * failed. The bitmap belongs to the cache: draw it at once, it is closed when it is replaced.
 */
export function loadSprite(page: PageModel, imageIndex: number, rev: number, scale: number): Promise<ImageRenderResult | null> {
  const s = sprite;
  if (s && s.page === page && s.imageIndex === imageIndex && s.rev === rev && s.scale === scale && page.rev.peek() === rev) {
    return s.promise;
  }
  closeEntry(s);
  if (page.rev.peek() !== rev) {
    sprite = null;
    return Promise.resolve(null);
  }
  const entry: SpriteEntry = { page, imageIndex, rev, scale, promise: Promise.resolve(null), result: null };
  sprite = entry;
  entry.promise = engine()
    .renderImage(page.index, imageIndex, scale)
    .then(
      (result) => {
        // Replaced, released or stale by now: nobody will draw it.
        if (sprite !== entry || page.rev.peek() !== rev) {
          result.bitmap.close();
          if (sprite === entry) sprite = null;
          return null;
        }
        entry.result = result;
        return result;
      },
      (err: unknown) => {
        console.warn(`Rendering image ${imageIndex + 1} of page ${page.index + 1} failed`, err);
        return null;
      },
    );
  return entry.promise;
}

/** Close the cached sprite (the selection went away). */
export function releaseSprite() {
  closeEntry(sprite);
  sprite = null;
}
