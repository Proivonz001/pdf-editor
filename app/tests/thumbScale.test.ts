// Thumbnail render scale (viewer/Thumbnails.tsx): the thumbnail's CSS width × devicePixelRatio
// per point of page width, rounded down to 1/1000, within a 300 000-pixel budget, and never 0
// (the engine refuses a zero scale).
import { beforeAll, describe, expect, it } from "vitest";
import "./stubs/browser-globals";
import type { PageModel } from "../src/viewer/model";

const page = (width: number, height: number) => ({ width, height }) as PageModel;
const pixels = (p: PageModel, scale: number) => p.width * scale * p.height * scale;

let thumbScale: typeof import("../src/viewer/Thumbnails").thumbScale;

beforeAll(async () => {
  ({ thumbScale } = await import("../src/viewer/Thumbnails"));
});

describe("thumbScale", () => {
  it("fills the CSS width at the screen's density, rounded down to 1/1000", () => {
    const letter = page(612, 792);
    expect(thumbScale(letter, 112, 1)).toBe(0.183); // 0.18301
    expect(thumbScale(letter, 112, 2)).toBe(0.366); // 0.36601
    expect(thumbScale(page(300, 300), 200, 1)).toBe(0.666); // 0.66667: down, not to the nearest
  });

  it("keeps a thumbnail within 300 000 pixels at a high density", () => {
    const letter = page(612, 792);
    const s = thumbScale(letter, 112, 6); // wants 1.098; the budget allows 0.7867
    expect(s).toBe(0.786);
    expect(pixels(letter, s)).toBeLessThanOrEqual(300_000);
  });

  it("keeps a long strip within 300 000 pixels at an ordinary density", () => {
    const strip = page(100, 20_000);
    const s = thumbScale(strip, 112, 2); // wants 2.24; the budget allows 0.3873
    expect(s).toBe(0.387);
    expect(pixels(strip, s)).toBeLessThanOrEqual(300_000);
  });

  it("never returns 0, however large the page or small the box", () => {
    expect(thumbScale(page(1e9, 1e9), 112, 2)).toBe(0.001);
    expect(thumbScale(page(612, 792), 0.1, 1)).toBe(0.001);
  });
});
