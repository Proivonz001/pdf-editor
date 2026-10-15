// Which pages are near the viewport, from two IntersectionObservers on the scroller:
// "near" (about one screen around it) gets a bitmap, "keep" (about three screens) keeps its
// canvas; pages further away release theirs.
import { batch } from "@preact/signals";
import type { PageModel } from "./model";

export class PageVisibility {
  private readonly near: IntersectionObserver;
  private readonly keep: IntersectionObserver;
  private readonly pages = new Map<Element, PageModel>();

  constructor(root: HTMLElement) {
    this.near = new IntersectionObserver((entries) => this.update(entries, "near"), {
      root,
      rootMargin: "100% 100%",
    });
    this.keep = new IntersectionObserver((entries) => this.update(entries, "keep"), {
      root,
      rootMargin: "300% 100%",
    });
  }

  observe(el: Element, page: PageModel) {
    this.pages.set(el, page);
    this.near.observe(el);
    this.keep.observe(el);
  }

  unobserve(el: Element) {
    this.pages.delete(el);
    this.near.unobserve(el);
    this.keep.unobserve(el);
  }

  disconnect() {
    this.near.disconnect();
    this.keep.disconnect();
    this.pages.clear();
  }

  private update(entries: IntersectionObserverEntry[], which: "near" | "keep") {
    batch(() => {
      for (const entry of entries) {
        const page = this.pages.get(entry.target);
        if (page) page[which].value = entry.isIntersecting;
      }
    });
  }
}
