// Page render scheduler: at most two render requests in flight, the page nearest the centre of
// the viewport first, and requests for pages that scrolled away are dropped before they reach
// the engine. A page has at most one waiting request: a newer one replaces it.
import type { EngineClient } from "../engine/client";
import type { RenderResult } from "../engine/protocol";

interface Job {
  pageIndex: number;
  scale: number;
  /** Still wanted? Checked before sending and when the bitmap arrives. */
  wanted: () => boolean;
  resolve: (result: RenderResult | null) => void;
}

export class RenderQueue {
  private waiting: Job[] = [];
  private inFlight = 0;
  private disposed = false;

  constructor(
    private readonly client: EngineClient,
    /** Lower = sooner (distance from the page at the centre of the viewport). */
    private readonly priority: (pageIndex: number) => number,
    private readonly maxInFlight = 2,
  ) {}

  /**
   * Render a page at `scale` pixels per point. Resolves null when the request was dropped;
   * otherwise the caller owns the bitmap and must close() it.
   */
  request(pageIndex: number, scale: number, wanted: () => boolean): Promise<RenderResult | null> {
    if (this.disposed) return Promise.resolve(null);
    const old = this.waiting.findIndex((j) => j.pageIndex === pageIndex);
    if (old >= 0) this.waiting.splice(old, 1)[0].resolve(null);
    return new Promise((resolve) => {
      this.waiting.push({ pageIndex, scale, wanted, resolve });
      this.pump();
    });
  }

  /** Drop everything (document closed). Bitmaps still in flight are closed when they arrive. */
  dispose() {
    this.disposed = true;
    for (const job of this.waiting) job.resolve(null);
    this.waiting = [];
  }

  private pump() {
    while (!this.disposed && this.inFlight < this.maxInFlight) {
      this.waiting = this.waiting.filter((j) => {
        if (j.wanted()) return true;
        j.resolve(null);
        return false;
      });
      if (this.waiting.length === 0) return;
      let best = 0;
      for (let i = 1; i < this.waiting.length; i++) {
        if (this.priority(this.waiting[i].pageIndex) < this.priority(this.waiting[best].pageIndex)) best = i;
      }
      const job = this.waiting.splice(best, 1)[0];
      this.inFlight++;
      this.client
        .render(job.pageIndex, job.scale)
        .then(
          (result) => {
            if (this.disposed || !job.wanted()) {
              result.bitmap.close();
              job.resolve(null);
            } else {
              job.resolve(result);
            }
          },
          (err: unknown) => {
            if (!this.disposed) console.warn(`Render of page ${job.pageIndex + 1} failed`, err);
            job.resolve(null);
          },
        )
        .finally(() => {
          this.inFlight--;
          this.pump();
        });
    }
  }
}
