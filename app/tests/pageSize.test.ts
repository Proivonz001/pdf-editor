// Page size in the details panel: points → whole millimetres, and the standard paper names
// (either orientation, ±3 pt).
import { describe, expect, it } from "vitest";
import { pageSize } from "../src/ui/pageSize";

describe("pageSize", () => {
  it("names A4 portrait", () => {
    expect(pageSize(595, 842)).toEqual({ name: "A4", widthMm: 210, heightMm: 297 });
  });

  it("names A4 landscape, keeping the page's own width and height", () => {
    expect(pageSize(842, 595)).toEqual({ name: "A4", widthMm: 297, heightMm: 210 });
  });

  it("names A4 as the PDF writers round it", () => {
    expect(pageSize(595.276, 841.89).name).toBe("A4");
    expect(pageSize(596, 843).name).toBe("A4");
  });

  it("names Letter and the other standard sizes", () => {
    expect(pageSize(612, 792)).toEqual({ name: "Letter", widthMm: 216, heightMm: 279 });
    expect(pageSize(792, 612).name).toBe("Letter");
    expect(pageSize(612, 1008)).toEqual({ name: "Legal", widthMm: 216, heightMm: 356 });
    expect(pageSize(842, 1191)).toEqual({ name: "A3", widthMm: 297, heightMm: 420 });
    expect(pageSize(420, 595)).toEqual({ name: "A5", widthMm: 148, heightMm: 210 });
  });

  it("matches within 3 pt and no further", () => {
    expect(pageSize(598, 845).name).toBe("A4");
    expect(pageSize(592, 839).name).toBe("A4");
    expect(pageSize(599, 842).name).toBeNull();
    expect(pageSize(595, 838).name).toBeNull();
  });

  it("gives no name to any other size", () => {
    expect(pageSize(500, 700)).toEqual({ name: null, widthMm: 176, heightMm: 247 });
    expect(pageSize(1, 1)).toEqual({ name: null, widthMm: 0, heightMm: 0 });
  });

  it("rounds to whole millimetres", () => {
    expect(pageSize(100, 100)).toEqual({ name: null, widthMm: 35, heightMm: 35 }); // 35.28 mm
    expect(pageSize(283.46, 141.73)).toEqual({ name: null, widthMm: 100, heightMm: 50 });
    expect(pageSize(361, 361)).toEqual({ name: null, widthMm: 127, heightMm: 127 }); // 127.35 mm
    expect(pageSize(362.9, 362.9)).toEqual({ name: null, widthMm: 128, heightMm: 128 }); // 128.02 mm
  });
});
