// Geometry of Forme (engine/shapeGeometry.ts), shared by the engine and the viewer's preview.
import { describe, expect, it } from "vitest";
import type { Shape } from "../src/engine/protocol";
import { MAX_PEN_POINTS } from "../src/engine/protocol";
import { arrowHead, dashArray, drawing, isShapeDrawable, mapShape, shapeBox, svgPath, type Segment } from "../src/engine/shapeGeometry";

const base = { color: [0, 0, 0] as [number, number, number], width: 2, dash: "solid" as const, heads: 0 as const };
const shape = (s: Partial<Shape> & Pick<Shape, "kind" | "points">): Shape => ({ ...base, ...s });
const ends = (segs: Segment[]) => segs.filter((s) => s.op !== "Z").map((s) => (s as { p: [number, number] }).p);

describe("shapeGeometry", () => {
  it("draws a box and an ellipse from two corners in any order, upright", () => {
    const r = drawing(shape({ kind: "rect", points: [[50, 40], [10, 20]] }));
    expect(ends(r.stroke)).toEqual([[10, 20], [50, 20], [50, 40], [10, 40]]);
    expect(r.join).toBe(0);
    const e = drawing(shape({ kind: "ellipse", points: [[10, 20], [50, 40]] }));
    expect(ends(e.stroke)).toEqual([[50, 30], [30, 40], [10, 30], [30, 20], [50, 30]]);
  });

  it("stops an arrow's stroke inside its heads and keeps the tips on the ends", () => {
    const d = drawing(shape({ kind: "line", points: [[0, 0], [100, 0]], heads: 2 }));
    const { length } = arrowHead(2);
    expect(ends(d.stroke)).toEqual([[length / 2, 0], [100 - length / 2, 0]]);
    expect(d.fill.filter((s) => s.op === "M").map((s) => (s as { p: number[] }).p)).toEqual([[100, 0], [0, 0]]);
    // Heads on a line shorter than both together are drawn smaller and never cross.
    const short = drawing(shape({ kind: "line", points: [[0, 0], [10, 0]], heads: 2 }));
    expect(Math.max(...ends(short.fill).map((p) => p[0]).filter((x) => x < 10))).toBeLessThanOrEqual(10);
  });

  it("dashes and dots by the width, dots with round caps, the pen and the highlight solid", () => {
    expect(dashArray("dashed", 2)).toEqual([6, 4]);
    expect(dashArray("dotted", 2)).toEqual([0, 4]);
    expect(drawing(shape({ kind: "rect", points: [[0, 0], [9, 9]], dash: "dotted" })).cap).toBe(1);
    expect(drawing(shape({ kind: "pen", points: [[0, 0], [5, 5], [9, 0]], dash: "dashed" })).dash).toEqual([]);
    const h = drawing(shape({ kind: "highlight", points: [[0, 0], [20, 8]], width: 0 }));
    expect(h.stroke).toEqual([]);
    expect(h.fill.length).toBe(5);
  });

  it("smooths a pen stroke through the middles of its segments and ends on its last point", () => {
    const d = drawing(shape({ kind: "pen", points: [[0, 0], [10, 0], [10, 10], [20, 10]] }));
    expect(d.stroke.map((s) => s.op)).toEqual(["M", "C", "C", "L"]);
    expect(ends(d.stroke)).toEqual([[0, 0], [10, 5], [15, 10], [20, 10]]);
  });

  it("the size rule (the engine's, which the viewer applies too): a line's length, a box's sides, a pen stroke's longer side", () => {
    expect(isShapeDrawable(shape({ kind: "line", points: [[0, 0], [0.8, 0.8]] }))).toBe(true); // 1.13 long
    expect(isShapeDrawable(shape({ kind: "line", points: [[0, 0], [0.6, 0.6]] }))).toBe(false);
    expect(isShapeDrawable(shape({ kind: "rect", points: [[0, 0], [1, 5]] }))).toBe(true);
    expect(isShapeDrawable(shape({ kind: "ellipse", points: [[0, 0], [5, 0.9]] }))).toBe(false);
    expect(isShapeDrawable(shape({ kind: "highlight", points: [[0, 0], [0.9, 5]], width: 0 }))).toBe(false);
    expect(isShapeDrawable(shape({ kind: "pen", points: [[0, 0], [0.8, 0.8]] }))).toBe(false); // its diagonal is over 1, not its sides
    expect(isShapeDrawable(shape({ kind: "pen", points: [[0, 0], [1, 0.2], [0.5, 0]] }))).toBe(true);
    expect(isShapeDrawable(shape({ kind: "pen", points: [[0, 0]] }))).toBe(false);
    expect(isShapeDrawable(shape({ kind: "pen", points: Array.from({ length: MAX_PEN_POINTS + 1 }, (_, k) => [k, 0]) }))).toBe(false);
    expect(isShapeDrawable(shape({ kind: "rect", points: [[0, 0], [5, 5], [9, 9]] }))).toBe(false);
    expect(isShapeDrawable(shape({ kind: "line", points: [[0, 0], [NaN, 5]] }))).toBe(false);
  });

  it("boxes a shape with its stroke and heads, and maps points through a matrix", () => {
    expect(shapeBox(shape({ kind: "rect", points: [[10, 10], [20, 30]], width: 4 }))).toEqual([8, 8, 22, 32]);
    const arrow = shapeBox(shape({ kind: "line", points: [[0, 50], [100, 50]], heads: 1 }));
    expect(arrow[1]).toBeCloseTo(50 - arrowHead(2).half);
    const turned = mapShape(shape({ kind: "line", points: [[0, 0], [10, 0]] }), [0, 1, -1, 0, 100, 0]);
    expect(turned.points).toEqual([[100, 0], [100, 10]]);
    expect(svgPath(drawing(shape({ kind: "line", points: [[0, 0], [1.23456, 2]] })).stroke)).toBe("M 0 0 L 1.235 2");
  });
});
