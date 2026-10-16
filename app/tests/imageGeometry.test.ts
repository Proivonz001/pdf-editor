// Geometry of the image overlay (viewer/imageGeometry.ts): matrices, handles, rotation snapping
// and the CSS that draws the selection frame and the drag preview. Every check runs on upright,
// rotated (30°, 90°, 180°), flipped and skewed pictures, because the frame must follow all of them.
import { describe, expect, it } from "vitest";
import { MAX_IMAGE_SIDE, type Matrix, type Rect } from "../src/engine/protocol";
import {
  IDENTITY,
  applyTo,
  beyondEdge,
  boundsOf,
  centre,
  clampCentre,
  concat,
  corners,
  cssBox,
  cssMatrix,
  handlePoint,
  invert,
  nearlyEqual,
  pagePoint,
  ppi,
  previewTransform,
  resize,
  rotate90,
  rotateAbout,
  rotateTo,
  rotationDeg,
  scaleAbout,
  sides,
  sidesSwapped,
  stretchBy,
  stretchOnScreen,
  translateBy,
  type Handle,
  type Point,
} from "../src/viewer/imageGeometry";

const W = 200, H = 100;
/** A W × H picture turned `deg` clockwise about its top-left corner, which is at (x, y). */
function turned(deg: number, x = 150, y = 200): Matrix {
  const r = (deg * Math.PI) / 180;
  return [W * Math.cos(r), W * Math.sin(r), -H * Math.sin(r), H * Math.cos(r), x, y];
}

const upright: Matrix = [W, 0, 0, H, 150, 200];
const cases: Record<string, Matrix> = {
  upright,
  "rotated 30°": turned(30),
  "rotated 90°": [0, W, -H, 0, 300, 100],
  "rotated 180°": [-W, 0, 0, -H, 350, 300],
  "rotated -30°": turned(-30),
  "flipped left-right": [-W, 0, 0, H, 350, 200],
  "flipped upside down": [W, 0, 0, -H, 150, 300],
  "flipped and rotated 30°": concat([-1, 0, 0, 1, 0, 0], turned(30)),
  skewed: [W, 0, 40, H, 150, 200],
  "skewed and rotated": concat([W, 0, 60, H, 0, 0], [Math.cos(0.4), Math.sin(0.4), -Math.sin(0.4), Math.cos(0.4), 250, 150]),
};
const caseList = Object.entries(cases);
const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const CORNERS: Handle[] = ["nw", "ne", "se", "sw"];
const EDGES: Handle[] = ["n", "e", "s", "w"];
/** Unit-square position of each handle, and of the point that must stay put. */
const UNIT: Record<Handle, Point> = { nw: [0, 0], n: [0.5, 0], ne: [1, 0], e: [1, 0.5], se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5] };
const opposite = (h: Handle): Point => [1 - UNIT[h][0], 1 - UNIT[h][1]];

const det = (m: Matrix) => m[0] * m[3] - m[1] * m[2];
const dist = (p: Point, q: Point) => Math.hypot(p[0] - q[0], p[1] - q[1]);
const unskewed = (m: Matrix) => Math.abs(m[0] * m[2] + m[1] * m[3]) < 1e-9 * (W * H);

function expectPoint(actual: Point, expected: Point, eps = 1e-9) {
  expect(Math.abs(actual[0] - expected[0]), `x: ${actual[0]} vs ${expected[0]}`).toBeLessThanOrEqual(eps);
  expect(Math.abs(actual[1] - expected[1]), `y: ${actual[1]} vs ${expected[1]}`).toBeLessThanOrEqual(eps);
}
function expectMatrix(actual: Matrix, expected: Matrix, eps = 1e-9) {
  expect(nearlyEqual(actual, expected, eps), `${actual.join(" ")} vs ${expected.join(" ")}`).toBe(true);
}

/** The six numbers of a CSS matrix(), checking it is written in plain decimals. */
function parseCss(transform: string): Matrix {
  const match = /^matrix\(([^)]*)\)$/.exec(transform);
  expect(match, transform).not.toBeNull();
  const parts = match![1].split(", ");
  expect(parts).toHaveLength(6);
  for (const p of parts) expect(p, transform).toMatch(/^-?\d+(\.\d{1,6})?$/);
  for (const p of parts) expect(p, transform).not.toBe("-0");
  return parts.map(Number) as Matrix;
}

/** Angle difference in degrees, folded into (-180, 180]. */
function angleDiff(a: number, b: number) {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

describe("matrix basics", () => {
  it("concat is 'a then b', and invert undoes a matrix", () => {
    const a: Matrix = [2, 0.5, -1, 3, 10, 20];
    const b: Matrix = [0.5, 1, 1.5, -2, -7, 4];
    const p: Point = [3, -4];
    expectPoint(applyTo(concat(a, b), p), applyTo(b, applyTo(a, p)));
    for (const [, m] of caseList) {
      expectMatrix(concat(m, invert(m)), IDENTITY);
      expectMatrix(concat(invert(m), m), IDENTITY);
    }
  });

  it("refuses to invert a singular matrix", () => {
    expect(() => invert([1, 2, 2, 4, 5, 6])).toThrow();
    expect(() => invert([0, 0, 0, 0, 0, 0])).toThrow();
    expect(() => invert([Infinity, 0, 0, 1, 0, 0])).toThrow();
  });

  it("gives the corners as seen, the centre, the sides and the bounding box", () => {
    expect(corners(upright)).toEqual([[150, 200], [350, 200], [350, 300], [150, 300]]);
    expect(centre(upright)).toEqual([250, 250]);
    expect(sides(upright)).toEqual({ width: 200, height: 100 });
    expect(boundsOf(upright)).toEqual([150, 200, 350, 300]);
    // Turned 180°: the picture's own top-left corner is at the bottom-right of the screen.
    expect(corners(cases["rotated 180°"])).toEqual([[350, 300], [150, 300], [150, 200], [350, 200]]);
    expect(boundsOf(cases["rotated 180°"])).toEqual([150, 200, 350, 300]);
    for (const [, m] of caseList) {
      const s = sides(m);
      const [tl, tr, , bl] = corners(m);
      expect(s.width).toBeCloseTo(dist(tl, tr), 9);
      expect(s.height).toBeCloseTo(dist(tl, bl), 9);
      const [x0, y0, x1, y1] = boundsOf(m);
      for (const [x, y] of corners(m)) {
        expect(x).toBeGreaterThanOrEqual(x0);
        expect(x).toBeLessThanOrEqual(x1);
        expect(y).toBeGreaterThanOrEqual(y0);
        expect(y).toBeLessThanOrEqual(y1);
      }
      expect(corners(m).some(([x]) => x === x0) && corners(m).some(([x]) => x === x1)).toBe(true);
      expect(corners(m).some(([, y]) => y === y0) && corners(m).some(([, y]) => y === y1)).toBe(true);
    }
  });

  it("measures the rotation of the top edge, clockwise, in [0, 360)", () => {
    expect(rotationDeg(upright)).toBe(0);
    expect(rotationDeg(cases["rotated 30°"])).toBeCloseTo(30, 9);
    expect(rotationDeg(cases["rotated 90°"])).toBe(90);
    expect(rotationDeg(cases["rotated 180°"])).toBe(180);
    expect(rotationDeg([0, -W, H, 0, 0, 0])).toBe(270);
    expect(rotationDeg(cases["rotated -30°"])).toBeCloseTo(330, 9);
    expect(rotationDeg(cases["flipped left-right"])).toBe(180);
    expect(rotationDeg(cases["flipped upside down"])).toBe(0);
    expect(rotationDeg(cases.skewed)).toBe(0);
    for (const [, m] of caseList) {
      const r = rotationDeg(m);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThan(360);
    }
    // Rounding noise just below 0 still reads as [0, 360).
    const r = rotationDeg([1, -1e-17, 0, 1, 0, 0]);
    expect(r >= 0 && r < 360).toBe(true);
  });

  it("never changes the matrices it is given", () => {
    const frozen = Object.freeze([...cases["skewed and rotated"]]) as Matrix;
    const pointer: Point = [400, 50];
    expect(() => {
      translateBy(frozen, 1, 2);
      rotateAbout(frozen, [0, 0], 30);
      rotate90(frozen);
      scaleAbout(frozen, [10, 10], 2);
      for (const h of HANDLES) resize(frozen, h, pointer, { keepAspect: true, minSide: 1 });
      for (const h of HANDLES) resize(frozen, h, pointer, { keepAspect: false, minSide: 1 });
      rotateTo(frozen, [0, 0], pointer, { snap: true });
      clampCentre(frozen, [0, 0, 10, 10]);
      cssBox(frozen, [0, 0], 2);
      previewTransform(boundsOf(frozen), frozen, upright, 2);
      invert(frozen);
      concat(frozen, frozen);
    }).not.toThrow();
    expect(IDENTITY).toEqual([1, 0, 0, 1, 0, 0]);
    expect(Object.isFrozen(IDENTITY)).toBe(true);
  });
});

describe("translate, rotate and scale", () => {
  it("translates without changing anything else", () => {
    expect(translateBy(upright, 10, -5)).toEqual([W, 0, 0, H, 160, 195]);
  });

  it("rotates about a point, which stays fixed, keeping the sides", () => {
    const about: Point = [37, -12];
    for (const [name, m] of caseList) {
      for (const deg of [30, 90, -45, 180, 270, 400]) {
        const r = rotateAbout(m, about, deg);
        const inv = invert(m);
        // The point under `about` stays where it was.
        expectPoint(applyTo(r, applyTo(inv, about)), about, 1e-9);
        expect(sides(r).width).toBeCloseTo(sides(m).width, 9);
        expect(sides(r).height).toBeCloseTo(sides(m).height, 9);
        expect(angleDiff(rotationDeg(r), rotationDeg(m) + deg), name).toBeCloseTo(0, 9);
        expect(Math.sign(det(r))).toBe(Math.sign(det(m)));
      }
    }
  });

  it("turns 90° clockwise about the centre, exactly for an upright picture", () => {
    expect(rotate90(upright)).toEqual([0, W, -H, 0, 300, 150]);
    expect(rotationDeg(rotate90(upright))).toBe(90);
    expect(rotationDeg(rotate90(rotate90(upright)))).toBe(180);
    expect(rotationDeg(rotate90(rotate90(rotate90(upright))))).toBe(270);
  });

  it("comes back to the start after four quarter turns", () => {
    for (const [name, m] of caseList) {
      let r = m;
      for (let i = 0; i < 4; i++) {
        const next = rotate90(r);
        expectPoint(centre(next), centre(m), 1e-9);
        expect(angleDiff(rotationDeg(next), rotationDeg(r) + 90), name).toBeCloseTo(0, 9);
        r = next;
      }
      expectMatrix(r, m, 1e-9);
    }
  });

  it("scales about a point, which stays fixed", () => {
    const about: Point = [250, 250];
    const s = scaleAbout(upright, about, 1.05);
    expect(sides(s).width).toBeCloseTo(210, 9);
    expect(sides(s).height).toBeCloseTo(105, 9);
    expectPoint(centre(s), about);
    for (const [, m] of caseList) {
      const c = centre(m);
      const k = scaleAbout(m, c, 0.95);
      expectPoint(centre(k), c, 1e-9);
      expect(rotationDeg(k)).toBeCloseTo(rotationDeg(m), 9);
    }
  });

  it("stretches the width or the height by points about the centre (the keyboard's Alt + arrows)", () => {
    expect(stretchBy(upright, 10, 0)).toEqual([210, 0, 0, H, 145, 200]);
    expect(stretchBy(upright, 0, -10)).toEqual([W, 0, 0, 90, 150, 205]);
    for (const [name, m] of caseList) {
      for (const [dw, dh] of [[1, 0], [-1, 0], [0, 10], [0, -10], [5, -3]]) {
        const r = stretchBy(m, dw, dh);
        expectPoint(centre(r), centre(m), 1e-9);
        expect(sides(r).width, name).toBeCloseTo(sides(m).width + dw, 9);
        expect(sides(r).height, name).toBeCloseTo(sides(m).height + dh, 9);
        // Same rotation, flip and skew: each edge keeps its direction.
        expect(rotationDeg(r), name).toBeCloseTo(rotationDeg(m), 9);
        expect(Math.sign(det(r))).toBe(Math.sign(det(m)));
        const cross = (u: Point, v: Point) => u[0] * v[1] - u[1] * v[0];
        expect(Math.abs(cross([r[2], r[3]], [m[2], m[3]]))).toBeLessThan(1e-6);
      }
    }
  });

  it("stretches as seen on screen: → wider and ↓ taller, also after a quarter turn (Alt + arrows)", () => {
    const box = (m: Matrix) => {
      const [x0, y0, x1, y1] = boundsOf(m);
      return { w: x1 - x0, h: y1 - y0 };
    };
    // A 100 × 50 pt picture, turned as the Rotate button does, flipped, or both.
    const picture: Matrix = [100, 0, 0, 50, 100, 100];
    const quarter = rotate90(picture);
    const turns: Matrix[] = [picture, quarter, rotate90(quarter), rotate90(rotate90(quarter))];
    const flips: Matrix[] = [[100, 0, 0, -50, 100, 150], [-100, 0, 0, 50, 200, 100], rotate90([100, 0, 0, -50, 100, 150])];
    for (const m of [...turns, ...flips]) {
      const b = box(m);
      for (const step of [1, 10, -1, -10]) {
        const wider = stretchOnScreen(m, step, 0);
        expect(box(wider).w, `${m.join(" ")} → ${step}`).toBeCloseTo(b.w + step, 9);
        expect(box(wider).h).toBeCloseTo(b.h, 9);
        const taller = stretchOnScreen(m, 0, step);
        expect(box(taller).h, `${m.join(" ")} ↓ ${step}`).toBeCloseTo(b.h + step, 9);
        expect(box(taller).w).toBeCloseTo(b.w, 9);
        // About the centre, with the same turn and flip.
        for (const r of [wider, taller]) {
          expectPoint(centre(r), centre(m), 1e-9);
          expect(rotationDeg(r)).toBeCloseTo(rotationDeg(m), 9);
          expect(Math.sign(det(r))).toBe(Math.sign(det(m)));
        }
      }
    }
    // The report's case: 100 × 50, turned 90°, shows 50 wide and 100 tall; Alt + → makes it 60 wide.
    expect(box(quarter)).toEqual({ w: 50, h: 100 });
    const wider = box(stretchOnScreen(quarter, 10, 0));
    expect(wider.w).toBeCloseTo(60, 9);
    expect(wider.h).toBeCloseTo(100, 9);
    const taller = box(stretchOnScreen(quarter, 0, 10));
    expect(taller.w).toBeCloseTo(50, 9);
    expect(taller.h).toBeCloseTo(110, 9);
  });

  it("gives each arrow to the side running closer to it on screen", () => {
    for (const deg of [0, 30, 44, 46, 60, 90, 130, 150, 200, 260, 280, 330]) {
      const m = rotateAbout(upright, centre(upright), deg);
      const nearQuarter = Math.round(deg / 90) % 2 === 1;
      expect(sidesSwapped(m), `${deg}°`).toBe(nearQuarter);
      const r = stretchOnScreen(m, 10, 0);
      expect(sides(r).width, `${deg}°`).toBeCloseTo(nearQuarter ? W : W + 10, 9);
      expect(sides(r).height, `${deg}°`).toBeCloseTo(nearQuarter ? H + 10 : H, 9);
    }
    // A skewed picture: its left edge leans, its top edge is still the more horizontal one.
    expect(sidesSwapped(cases.skewed)).toBe(false);
    expect(sidesSwapped(rotate90(cases.skewed))).toBe(true);
    // No width or no height: nothing to swap.
    expect(sidesSwapped([0, 0, 0, H, 0, 0])).toBe(false);
    expect(sidesSwapped([0, W, 0, 0, 0, 0])).toBe(false);
  });

  it("leaves a side alone that a stretch would make zero or negative, or that has no length", () => {
    expect(stretchBy(upright, -W, 0)).toEqual(upright);
    expect(stretchBy(upright, 0, -H - 5)).toEqual(upright);
    const flat: Matrix = [W, 0, 0, 0, 10, 10];
    expect(sides(stretchBy(flat, 10, 10))).toEqual({ width: W + 10, height: 0 });
  });
});

describe("beyondEdge", () => {
  it("is out from the middle of the top or bottom edge, along the left edge, away from the picture", () => {
    expect(beyondEdge(upright, "top", 24)).toEqual([250, 176]);
    expect(beyondEdge(upright, "bottom", 24)).toEqual([250, 324]);
    // Turned 180°: its top edge is at the bottom of the screen, so "above" it is further down.
    expect(beyondEdge(cases["rotated 180°"], "top", 10)).toEqual([250, 310]);
    // Turned 90° clockwise: its top edge is on the right.
    expect(beyondEdge(cases["rotated 90°"], "top", 10)).toEqual([310, 200]);
    for (const [name, m] of caseList) {
      const top = applyTo(m, [0.5, 0]);
      const bottom = applyTo(m, [0.5, 1]);
      const above = beyondEdge(m, "top", 30);
      const below = beyondEdge(m, "bottom", 30);
      expect(dist(above, top), name).toBeCloseTo(30, 9);
      expect(dist(below, bottom), name).toBeCloseTo(30, 9);
      // On the line of the left edge's direction through each middle point, on the far side.
      expect(dist(above, bottom), name).toBeCloseTo(sides(m).height + 30, 9);
      expect(dist(below, top), name).toBeCloseTo(sides(m).height + 30, 9);
    }
  });

  it("goes straight up or down for a picture with no height", () => {
    expect(beyondEdge([W, 0, 0, 0, 0, 100], "top", 5)).toEqual([100, 95]);
    expect(beyondEdge([W, 0, 0, 0, 0, 100], "bottom", 5)).toEqual([100, 105]);
  });
});

describe("resize", () => {
  const minSide = 8;
  // A drag of the handle by (30, -20) points: outward or inward depending on the case.
  const drag: Point = [30, -20];

  for (const [name, m] of caseList) {
    describe(name, () => {
      for (const handle of HANDLES) {
        it(`${handle}: keeps the opposite ${CORNERS.includes(handle) ? "corner" : "edge"} fixed`, () => {
          const h = handlePoint(m, handle);
          const pointer: Point = [h[0] + drag[0], h[1] + drag[1]];
          for (const keepAspect of [true, false]) {
            const r = resize(m, handle, pointer, { keepAspect, minSide });
            if (CORNERS.includes(handle)) {
              const o = opposite(handle);
              expectPoint(applyTo(r, o), applyTo(m, o), 1e-9);
            } else {
              // Both corners of the opposite edge stay.
              const [ou, ov] = opposite(handle);
              const ends: Point[] = ou === 0.5 ? [[0, ov], [1, ov]] : [[ou, 0], [ou, 1]];
              for (const p of ends) expectPoint(applyTo(r, p), applyTo(m, p), 1e-9);
            }
            // Never flipped, and the edges keep their directions (rotation, flip, skew).
            expect(Math.sign(det(r))).toBe(Math.sign(det(m)));
            const cross = (u: Point, v: Point) => u[0] * v[1] - u[1] * v[0];
            expect(Math.abs(cross([r[0], r[1]], [m[0], m[1]]))).toBeLessThan(1e-6);
            expect(Math.abs(cross([r[2], r[3]], [m[2], m[3]]))).toBeLessThan(1e-6);
            expect(r[0] * m[0] + r[1] * m[1]).toBeGreaterThan(0);
            expect(r[2] * m[2] + r[3] * m[3]).toBeGreaterThan(0);
          }
        });
      }

      for (const handle of CORNERS) {
        it(`${handle}: follows the pointer freely without keepAspect`, () => {
          const h = handlePoint(m, handle);
          const pointer: Point = [h[0] + drag[0], h[1] + drag[1]];
          const r = resize(m, handle, pointer, { keepAspect: false, minSide });
          expectPoint(applyTo(r, UNIT[handle]), pointer, 1e-9);
        });

        it(`${handle}: keeps the proportions with keepAspect, following the diagonal`, () => {
          const h = handlePoint(m, handle);
          const anchor = applyTo(m, opposite(handle));
          for (const pointer of [[h[0] + drag[0], h[1] + drag[1]], [h[0] - 25, h[1] - 10], [h[0] + 60, h[1] + 45]] as Point[]) {
            const r = resize(m, handle, pointer, { keepAspect: true, minSide });
            const s0 = sides(m), s1 = sides(r);
            expect(s1.width / s1.height).toBeCloseTo(s0.width / s0.height, 9);
            // The handle lands on the pointer's projection on the diagonal.
            const dx = h[0] - anchor[0], dy = h[1] - anchor[1];
            const t = ((pointer[0] - anchor[0]) * dx + (pointer[1] - anchor[1]) * dy) / (dx * dx + dy * dy);
            expectPoint(applyTo(r, UNIT[handle]), [anchor[0] + t * dx, anchor[1] + t * dy], 1e-9);
            expect(s1.width).toBeCloseTo(s0.width * t, 9);
          }
        });
      }

      for (const handle of EDGES) {
        it(`${handle}: changes one side only, to the pointer, also with keepAspect`, () => {
          const h = handlePoint(m, handle);
          const pointer: Point = [h[0] + drag[0], h[1] + drag[1]];
          const horizontal = handle === "e" || handle === "w";
          for (const keepAspect of [true, false]) {
            const r = resize(m, handle, pointer, { keepAspect, minSide });
            // The other side is untouched.
            if (horizontal) expect([r[2], r[3]]).toEqual([m[2], m[3]]);
            else expect([r[0], r[1]]).toEqual([m[0], m[1]]);
            // The moved edge runs through the pointer (seen in the new picture's unit square).
            const [pu, pv] = applyTo(invert(r), pointer);
            if (horizontal) expect(pu).toBeCloseTo(UNIT[handle][0], 9);
            else expect(pv).toBeCloseTo(UNIT[handle][1], 9);
          }
        });
      }

      for (const handle of HANDLES) {
        it(`${handle}: stops at minSide when dragged past the opposite side, without flipping`, () => {
          const o = applyTo(m, opposite(handle));
          const h = handlePoint(m, handle);
          // Far beyond the opposite corner or edge, on the line through the handle.
          const pointer: Point = [o[0] + 3 * (o[0] - h[0]), o[1] + 3 * (o[1] - h[1])];
          for (const keepAspect of [true, false]) {
            const r = resize(m, handle, pointer, { keepAspect, minSide });
            const s = sides(r);
            expect(Math.sign(det(r))).toBe(Math.sign(det(m)));
            const [hu, hv] = UNIT[handle];
            const uniform = keepAspect && hu !== 0.5 && hv !== 0.5;
            if (uniform) {
              // The shorter side stops at minSide, the other keeps the proportions.
              expect(Math.min(s.width, s.height)).toBeCloseTo(minSide, 9);
              expect(s.width / s.height).toBeCloseTo(sides(m).width / sides(m).height, 9);
            } else {
              if (hu !== 0.5) expect(s.width).toBeCloseTo(minSide, 9);
              else expect(s.width).toBeCloseTo(sides(m).width, 9);
              if (hv !== 0.5) expect(s.height).toBeCloseTo(minSide, 9);
              else expect(s.height).toBeCloseTo(sides(m).height, 9);
            }
            expect(s.width).toBeGreaterThanOrEqual(minSide - 1e-9);
            expect(s.height).toBeGreaterThanOrEqual(minSide - 1e-9);
          }
        });
      }
    });
  }

  it("honours minSide when shrinking towards the anchor too", () => {
    // se dragged almost onto the top-left corner.
    const r = resize(upright, "se", [151, 201], { keepAspect: false, minSide: 8 });
    expect(sides(r)).toEqual({ width: 8, height: 8 });
    expect(applyTo(r, [0, 0])).toEqual([150, 200]);
    const k = resize(upright, "se", [151, 201], { keepAspect: true, minSide: 8 });
    expect(sides(k).height).toBeCloseTo(8, 9);
    expect(sides(k).width).toBeCloseTo(16, 9);
  });

  it("never makes a side longer than MAX_IMAGE_SIDE", () => {
    const far: Point = [1e7, 1e7];
    const free = resize(upright, "se", far, { keepAspect: false, minSide: 1 });
    expect(sides(free).width).toBeCloseTo(MAX_IMAGE_SIDE, 6);
    expect(sides(free).height).toBeCloseTo(MAX_IMAGE_SIDE, 6);
    const kept = resize(upright, "se", far, { keepAspect: true, minSide: 1 });
    expect(sides(kept).width).toBeCloseTo(MAX_IMAGE_SIDE, 6);
    expect(sides(kept).height).toBeCloseTo(MAX_IMAGE_SIDE / 2, 6);
    const edge = resize(upright, "s", far, { keepAspect: false, minSide: 1 });
    expect(sides(edge).height).toBeCloseTo(MAX_IMAGE_SIDE, 6);
    expect(sides(edge).width).toBe(W);
  });

  it("gives exact numbers for an upright picture", () => {
    expect(resize(upright, "se", [400, 350], { keepAspect: false, minSide: 1 })).toEqual([250, 0, 0, 150, 150, 200]);
    expect(resize(upright, "nw", [100, 150], { keepAspect: false, minSide: 1 })).toEqual([250, 0, 0, 150, 100, 150]);
    expect(resize(upright, "e", [300, 999], { keepAspect: false, minSide: 1 })).toEqual([150, 0, 0, H, 150, 200]);
    expect(resize(upright, "n", [999, 250], { keepAspect: true, minSide: 1 })).toEqual([W, 0, 0, 50, 150, 250]);
    // Uniform: the pointer (450, 300) projects onto the diagonal at 1.4 × its length.
    expect(nearlyEqual(resize(upright, "se", [450, 300], { keepAspect: true, minSide: 1 }), [280, 0, 0, 140, 150, 200], 1e-9)).toBe(true);
  });

  describe("a side already shorter than minSide (a thin rule, a small icon at a low zoom)", () => {
    // A 300 × 3 pt rule; minSide 8 is what 8 px are at zoom 1.
    const rule: Matrix = [300, 0, 0, 3, 100, 400];
    const turnedRule = rotateAbout(rule, centre(rule), 30);

    it("does not grow when a corner is nudged inward, with or without keepAspect", () => {
      for (const m of [rule, turnedRule]) {
        const s0 = sides(m);
        // 3 pt inward along the diagonal, and along the long side only (in the picture's own axes).
        for (const pointer of [applyTo(m, [0.99, 0.99]), applyTo(m, [0.99, 1])]) {
          const kept = sides(resize(m, "se", pointer, { keepAspect: true, minSide: 8 }));
          expect(kept.width).toBeLessThanOrEqual(s0.width + 1e-9);
          expect(kept.height).toBeLessThanOrEqual(s0.height + 1e-9);
          expect(kept.height).toBeCloseTo(s0.height, 9); // the short side cannot shrink
          const free = sides(resize(m, "se", pointer, { keepAspect: false, minSide: 8 }));
          expect(free.height).toBeCloseTo(s0.height, 9); // not forced up to 8
          expect(free.width).toBeLessThan(s0.width);
        }
        // Inward along the diagonal: the uniform scale cannot go below 1, so the long side alone
        // follows it, by as much, and the short side keeps its length.
        const half = resize(m, "se", applyTo(m, [0.5, 0.5]), { keepAspect: true, minSide: 8 });
        expect(sides(half).width).toBeCloseTo(s0.width / 2, 9);
        expect(sides(half).height).toBeCloseTo(s0.height, 9);
        expectPoint(applyTo(half, [0, 0]), applyTo(m, [0, 0]), 1e-9);
      }
    });

    it("can be shortened and lengthened again from a corner with keepAspect, keeping its thickness (touch)", () => {
      // At a phone's fit-width zoom (0.603), minSide is 8 px = 13.3 pt.
      const minSide = 8 / 0.603;
      const turnedQuarter = rotate90(rule);
      const flipped: Matrix = [-300, 0, 0, 3, 400, 400];
      const vertical: Matrix = [3, 0, 0, 300, 100, 100];
      for (const m of [rule, turnedRule, turnedQuarter, flipped, vertical]) {
        const s0 = sides(m);
        const long = s0.width > s0.height ? "width" : "height";
        const thin = long === "width" ? "height" : "width";
        for (const handle of CORNERS) {
          const anchor = applyTo(m, opposite(handle));
          const h = handlePoint(m, handle);
          // The pointer at a fraction of the way from the anchor to the handle, a finger's width off
          // the diagonal (which barely moves the projection on so long a diagonal).
          const at = (k: number): Point => [anchor[0] + k * (h[0] - anchor[0]) + 6, anchor[1] + k * (h[1] - anchor[1]) - 6];
          let previous = Infinity;
          for (const k of [0.95, 0.7, 0.5, 0.2]) {
            const r = resize(m, handle, at(k), { keepAspect: true, minSide });
            const s = sides(r);
            expect(s[thin], `${handle} ${k}`).toBeCloseTo(s0[thin], 9); // its thickness
            expect(s[long], `${handle} ${k}`).toBeLessThan(previous); // shorter at every step
            expect(s[long] / s0[long], `${handle} ${k}`).toBeCloseTo(k, 1);
            previous = s[long];
            // The opposite corner stays, the picture is not flipped, the edges keep their directions.
            expectPoint(applyTo(r, opposite(handle)), anchor, 1e-9);
            expect(Math.sign(det(r))).toBe(Math.sign(det(m)));
            expect(rotationDeg(r)).toBeCloseTo(rotationDeg(m), 9);
          }
          // Back out within the same gesture: as long as before, then longer (and in proportion).
          expectMatrix(resize(m, handle, h, { keepAspect: true, minSide }), m, 1e-9);
          const longer = sides(resize(m, handle, [anchor[0] + 1.2 * (h[0] - anchor[0]), anchor[1] + 1.2 * (h[1] - anchor[1])], { keepAspect: true, minSide }));
          expect(longer[long]).toBeCloseTo(s0[long] * 1.2, 9);
          expect(longer[thin]).toBeCloseTo(s0[thin] * 1.2, 9);
          // Past the opposite corner: the long side stops at minSide, still as thick, not flipped.
          const past = resize(m, handle, [anchor[0] - (h[0] - anchor[0]), anchor[1] - (h[1] - anchor[1])], { keepAspect: true, minSide });
          expect(sides(past)[long]).toBeCloseTo(minSide, 9);
          expect(sides(past)[thin]).toBeCloseTo(s0[thin], 9);
          expect(Math.sign(det(past))).toBe(Math.sign(det(m)));
        }
      }
    });

    it("is continuous where the uniform scale gives way to the long side alone", () => {
      const anchor = applyTo(rule, [0, 0]);
      const h = handlePoint(rule, "se");
      const at = (k: number): Point => [anchor[0] + k * (h[0] - anchor[0]), anchor[1] + k * (h[1] - anchor[1])];
      const below = resize(rule, "se", at(1 - 1e-7), { keepAspect: true, minSide: 8 });
      const above = resize(rule, "se", at(1 + 1e-7), { keepAspect: true, minSide: 8 });
      expectMatrix(below, rule, 1e-4);
      expectMatrix(above, rule, 1e-4);
    });

    it("keeps the proportions of a picture whose sides are both above minSide", () => {
      // 300 × 10 at minSide 8: the uniform scale stops when the short side reaches 8 (240 × 8).
      const bar: Matrix = [300, 0, 0, 10, 0, 0];
      const r = resize(bar, "se", [60, 2], { keepAspect: true, minSide: 8 });
      expect(sides(r).width).toBeCloseTo(240, 9);
      expect(sides(r).height).toBeCloseTo(8, 9);
    });

    it("grows in proportion when a corner is dragged outward, by as much as the drag", () => {
      // 3 pt to the right of the se corner, on the line of the diagonal's direction: s ≈ 1.01.
      const r = resize(rule, "se", [403, 403.03], { keepAspect: true, minSide: 8 });
      const s = sides(r);
      expect(s.width).toBeCloseTo(303, 6);
      expect(s.height).toBeCloseTo(3.03, 6);
      expect(applyTo(r, [0, 0])).toEqual([100, 400]); // the opposite corner stays
      // Not the 800 × 8 pt jump a forced minimum would give.
      expect(s.width).toBeLessThan(310);
    });

    it("lets an edge handle change the long side only, and keeps the short one", () => {
      const r = resize(rule, "e", [250, 999], { keepAspect: true, minSide: 8 });
      expect(sides(r)).toEqual({ width: 150, height: 3 });
      // The short side's own edge handle cannot make it shorter, but can make it taller.
      expect(sides(resize(rule, "s", [0, 401], { keepAspect: false, minSide: 8 })).height).toBeCloseTo(3, 9);
      expect(sides(resize(rule, "s", [0, 410], { keepAspect: false, minSide: 8 })).height).toBeCloseTo(10, 9);
      // The long side still stops at minSide.
      expect(sides(resize(rule, "e", [0, 0], { keepAspect: false, minSide: 8 })).width).toBeCloseTo(8, 9);
    });

    it("keeps a small icon its size at a low zoom (minSide above both sides)", () => {
      // A 20 × 20 pt icon at zoom 0.25: minSide is 32 pt.
      const icon: Matrix = [20, 0, 0, 20, 50, 50];
      for (const handle of HANDLES) {
        const h = handlePoint(icon, handle);
        for (const keepAspect of [true, false]) {
          const inward = resize(icon, handle, [h[0] + (50 + 10 - h[0]) * 0.1, h[1] + (50 + 10 - h[1]) * 0.1], { keepAspect, minSide: 32 });
          expectMatrix(inward, icon, 1e-9);
          const outward = resize(icon, handle, [h[0] + (h[0] - 60) * 0.1, h[1] + (h[1] - 60) * 0.1], { keepAspect, minSide: 32 });
          expect(sides(outward).width).toBeGreaterThanOrEqual(20 - 1e-9);
          expect(sides(outward).width).toBeLessThan(23);
          expect(sides(outward).height).toBeLessThan(23);
        }
      }
    });

    it("never makes a side longer than MAX_IMAGE_SIDE, and does not shrink one that already is", () => {
      // 14 000 × 2 pt: the old lower bound (8 / 2 = 4) asked for a width of 56 000 pt.
      const long: Matrix = [14000, 0, 0, 2, 0, 0];
      const r = resize(long, "se", [14003, 2.0004], { keepAspect: true, minSide: 8 });
      expect(sides(r).width).toBeLessThanOrEqual(MAX_IMAGE_SIDE + 1e-6);
      expect(sides(r).width).toBeGreaterThanOrEqual(14000 - 1e-6);
      const far = resize(long, "se", [1e7, 1e7], { keepAspect: true, minSide: 8 });
      expect(sides(far).width).toBeCloseTo(MAX_IMAGE_SIDE, 6);
      // Longer than MAX_IMAGE_SIDE already: a drag outward keeps it, a drag inward shrinks it.
      const huge: Matrix = [20000, 0, 0, 100, 0, 0];
      expectMatrix(resize(huge, "se", [30000, 150], { keepAspect: true, minSide: 8 }), huge, 1e-9);
      expect(sides(resize(huge, "e", [30000, 50], { keepAspect: false, minSide: 8 })).width).toBeCloseTo(20000, 9);
      expect(sides(resize(huge, "e", [19000, 50], { keepAspect: false, minSide: 8 })).width).toBeCloseTo(19000, 9);
    });
  });

  it("leaves a picture with no area, or a pointer that is not a number, alone", () => {
    const flat: Matrix = [W, 0, 0, 0, 10, 10];
    expect(resize(flat, "se", [500, 500], { keepAspect: false, minSide: 1 })).toEqual(flat);
    expect(resize(upright, "se", [NaN, 500], { keepAspect: false, minSide: 1 })).toEqual(upright);
    expect(resize(upright, "se", [Infinity, 500], { keepAspect: true, minSide: 1 })).toEqual(upright);
  });
});

describe("rotateTo", () => {
  /** A pointer at `deg` clockwise from the start point (straight above the centre), 80 pt out. */
  const around = (m: Matrix, deg: number): Point => {
    const [cx, cy] = centre(m);
    const r = ((deg - 90) * Math.PI) / 180;
    return [cx + 80 * Math.cos(r), cy + 80 * Math.sin(r)];
  };
  const startOf = (m: Matrix): Point => around(m, 0);

  it("follows the angle swept around the centre", () => {
    for (const [name, m] of caseList) {
      for (const sweep of [10, 40, -60, 135, -170, 179]) {
        const r = rotateTo(m, startOf(m), around(m, sweep), { snap: false });
        const expected = rotationDeg(m) + sweep;
        const right = Math.round(expected / 90) * 90;
        const target = Math.abs(expected - right) <= 3 ? right : expected;
        expect(angleDiff(rotationDeg(r), target), `${name}, ${sweep}°`).toBeCloseTo(0, 9);
        expectPoint(centre(r), centre(m), 1e-9);
        expect(sides(r).width).toBeCloseTo(sides(m).width, 9);
        expect(sides(r).height).toBeCloseTo(sides(m).height, 9);
        expect(Math.sign(det(r))).toBe(Math.sign(det(m)));
      }
    }
  });

  it("snaps to a right angle within 3°, and not further", () => {
    const at = (sweep: number) => rotationDeg(rotateTo(upright, startOf(upright), around(upright, sweep), { snap: false }));
    expect(at(88)).toBe(90);
    expect(at(87)).toBe(90);
    expect(at(92.9)).toBe(90);
    expect(at(86)).toBeCloseTo(86, 9);
    expect(at(94)).toBeCloseTo(94, 9);
    expect(at(178)).toBe(180);
    expect(at(-2)).toBe(0);
    expect(at(2)).toBe(0);
    expect(at(-91)).toBe(270);
    expect(at(5)).toBeCloseTo(5, 9);
    // The absolute rotation snaps, not the sweep: from 30°, a 58° sweep lands on 90°.
    const m = cases["rotated 30°"];
    const r = rotateTo(m, startOf(m), around(m, 58), { snap: false });
    expect(rotationDeg(r)).toBe(90);
    expect(r[0]).toBe(0); // exactly upright again, no rounding noise
    expect(r[3]).toBe(0);
  });

  it("snaps to 15° steps with snap", () => {
    const at = (m: Matrix, sweep: number) => rotationDeg(rotateTo(m, startOf(m), around(m, sweep), { snap: true }));
    expect(at(upright, 7)).toBe(0);
    expect(at(upright, 8)).toBeCloseTo(15, 9);
    expect(at(upright, 22)).toBeCloseTo(15, 9);
    expect(at(upright, 23)).toBeCloseTo(30, 9);
    expect(at(upright, 50)).toBeCloseTo(45, 9);
    expect(at(upright, -20)).toBeCloseTo(345, 9);
    expect(at(cases["rotated 30°"], 12)).toBeCloseTo(45, 9);
    expect(at(cases["rotated 30°"], 55)).toBe(90);
  });

  it("snaps flipped and skewed pictures by their top edge", () => {
    // Mirrored, then turned 30°: the top edge points the other way, at 210°.
    const flipped = cases["flipped and rotated 30°"];
    expect(rotationDeg(flipped)).toBeCloseTo(210, 9);
    expect(rotationDeg(rotateTo(flipped, startOf(flipped), around(flipped, -28), { snap: false }))).toBe(180);
    expect(rotationDeg(rotateTo(flipped, startOf(flipped), around(flipped, 62), { snap: false }))).toBe(270);
    const skewed = cases["skewed and rotated"];
    const r = rotateTo(skewed, startOf(skewed), around(skewed, -rotationDeg(skewed) + 1), { snap: false });
    expect(rotationDeg(r)).toBe(0);
    expect(r[1]).toBe(0); // the top edge is exactly horizontal
    expect(sides(r).height).toBeCloseTo(sides(skewed).height, 9);
  });

  it("does nothing for a pointer on the centre", () => {
    const m = cases["rotated 30°"];
    expect(rotateTo(m, startOf(m), centre(m), { snap: false })).toEqual(m);
    expect(rotateTo(m, centre(m), startOf(m), { snap: true })).toEqual(m);
  });
});

describe("clampCentre", () => {
  const page: Rect = [0, 0, 612, 792];

  it("leaves a picture whose centre is on the page alone", () => {
    for (const [, m] of caseList) expect(clampCentre(m, page)).toEqual(m);
  });

  it("moves an off-page centre back inside, by translation only", () => {
    for (const [, m] of caseList) {
      for (const [dx, dy] of [[1000, 0], [-1000, 0], [0, 2000], [0, -2000], [700, -900]]) {
        const off = translateBy(m, dx, dy);
        const r = clampCentre(off, page);
        expect(r.slice(0, 4)).toEqual(off.slice(0, 4));
        const [cx, cy] = centre(r);
        expect(cx).toBeGreaterThan(page[0]);
        expect(cx).toBeLessThan(page[2]);
        expect(cy).toBeGreaterThan(page[1]);
        expect(cy).toBeLessThan(page[3]);
        // On the edge it was pushed past (within the tiny safety margin).
        const [ox, oy] = centre(off);
        if (ox > page[2]) expect(cx).toBeCloseTo(page[2], 5);
        if (ox < page[0]) expect(cx).toBeCloseTo(page[0], 5);
        if (oy > page[3]) expect(cy).toBeCloseTo(page[3], 5);
        if (oy < page[1]) expect(cy).toBeCloseTo(page[1], 5);
        // A coordinate that was on the page does not move.
        if (ox >= page[0] && ox <= page[2]) expect(cx).toBeCloseTo(ox, 9);
        if (oy >= page[1] && oy <= page[3]) expect(cy).toBeCloseTo(oy, 9);
      }
    }
  });

  it("works with a page whose bounds do not start at 0, 0", () => {
    const r = clampCentre(translateBy(upright, -500, 0), [100, 50, 400, 500]);
    expect(centre(r)[0]).toBeCloseTo(100, 5);
    expect(centre(r)[0]).toBeGreaterThan(100);
    expect(centre(r)[1]).toBe(250);
  });
});

describe("nearlyEqual", () => {
  it("compares within 0.01 by default", () => {
    expect(nearlyEqual(upright, translateBy(upright, 0.009, -0.009))).toBe(true);
    expect(nearlyEqual(upright, translateBy(upright, 0.011, 0))).toBe(false);
    expect(nearlyEqual(upright, [W + 0.02, 0, 0, H, 150, 200])).toBe(false);
    expect(nearlyEqual(upright, translateBy(upright, 0.5, 0), 1)).toBe(true);
    expect(nearlyEqual(upright, [NaN, 0, 0, H, 150, 200])).toBe(false);
  });
});

describe("cssBox", () => {
  const origin: Point = [-12, 30];

  for (const zoom of [0.5, 1, 1.5, 3]) {
    it(`covers the picture's quad exactly at zoom ${zoom}`, () => {
      for (const [name, m] of caseList) {
        const box = cssBox(m, origin, zoom);
        const t = parseCss(box.transform);
        expect(t[4]).toBe(0);
        expect(t[5]).toBe(0);
        // The box's corners, through the transform about its top-left, land on the quad.
        const local: Point[] = [[0, 0], [box.width, 0], [box.width, box.height], [0, box.height]];
        const quad = corners(m).map(([x, y]): Point => [(x - origin[0]) * zoom, (y - origin[1]) * zoom]);
        local.forEach((p, i) => {
          const [x, y] = applyTo(t, p);
          expectPoint([box.left + x, box.top + y], quad[i], 2e-3);
        });
        // The box has the picture's size; an unskewed picture is only turned or mirrored.
        expect(box.width).toBeCloseTo(sides(m).width * zoom, 5);
        expect(box.height).toBeCloseTo(sides(m).height * zoom, 5);
        if (unskewed(m)) {
          expect(Math.hypot(t[0], t[1]), name).toBeCloseTo(1, 5);
          expect(Math.hypot(t[2], t[3]), name).toBeCloseTo(1, 5);
          expect(t[0] * t[2] + t[1] * t[3], name).toBeCloseTo(0, 5);
        }
      }
    });
  }

  it("writes plain decimals", () => {
    const box = cssBox(rotateAbout(upright, [150, 200], 30), [0, 0], 1);
    expect(box.transform).toBe("matrix(0.866025, 0.5, -0.5, 0.866025, 0, 0)");
    expect(cssBox(upright, [0, 0], 1).transform).toBe("matrix(1, 0, 0, 1, 0, 0)");
    expect(cssBox(cases["rotated 90°"], [0, 0], 1).transform).toBe("matrix(0, 1, -1, 0, 0, 0)");
    expect(cssBox(cases["flipped left-right"], [0, 0], 1).transform).toBe("matrix(-1, 0, 0, 1, 0, 0)");
    expect(cssBox(upright, [0, 0], 1)).toMatchObject({ left: 150, top: 200, width: 200, height: 100 });
    // Tiny numbers are rounded, not written with an exponent.
    expect(cssMatrix([1e-9, -1e-9, 1.23456789, -0.0000004, 12345.6789012, 0])).toBe("matrix(0, 0, 1.234568, 0, 12345.678901, 0)");
    const tiny = cssBox([W, 0, 0, H, 1e-9, -1e-9], [0, 0], 1);
    expect(String(tiny.left)).toBe("0");
    expect(String(tiny.top)).toBe("0");
  });

  it("keeps the box usable for a picture with no width", () => {
    const box = cssBox([0, 0, 0, H, 10, 10], [0, 0], 1);
    expect(box.width).toBe(0);
    expect(box.transform).toBe("matrix(1, 0, 0, 1, 0, 0)");
  });
});

describe("previewTransform", () => {
  const targets: Record<string, (m: Matrix) => Matrix> = {
    moved: (m) => translateBy(m, 40, -25),
    "turned 90°": rotate90,
    "turned 30° and moved": (m) => translateBy(rotateAbout(m, centre(m), 30), 15, 10),
    resized: (m) => resize(m, "se", [handlePoint(m, "se")[0] + 30, handlePoint(m, "se")[1] + 50], { keepAspect: false, minSide: 1 }),
    shrunk: (m) => scaleAbout(m, centre(m), 0.5),
  };

  for (const zoom of [0.75, 1, 2.5]) {
    it(`maps the captured picture onto the target at zoom ${zoom}`, () => {
      for (const [, from] of caseList) {
        // The bitmap covers the picture's box, rounded out like the engine's sprite.
        const [x0, y0, x1, y1] = boundsOf(from);
        const rect: Rect = [Math.floor(x0 * zoom) / zoom, Math.floor(y0 * zoom) / zoom, Math.ceil(x1 * zoom) / zoom, Math.ceil(y1 * zoom) / zoom];
        for (const [, target] of Object.entries(targets)) {
          const to = target(from);
          const t = parseCss(previewTransform(rect, from, to, zoom));
          for (const u of [[0, 0], [1, 0], [1, 1], [0, 1], [0.5, 0.5], [0.2, 0.7]] as Point[]) {
            // Where this point of the picture is in the bitmap (element px)...
            const [px, py] = applyTo(from, u);
            const inElement: Point = [(px - rect[0]) * zoom, (py - rect[1]) * zoom];
            // ...and where it must show: at the target, in the same element's px.
            const [qx, qy] = applyTo(to, u);
            expectPoint(applyTo(t, inElement), [(qx - rect[0]) * zoom, (qy - rect[1]) * zoom], 2e-3);
          }
        }
      }
    });
  }

  it("is the identity when nothing moved, or when the start has no area", () => {
    const m = cases["rotated 30°"];
    expect(previewTransform(boundsOf(m), m, m, 1.5)).toBe("matrix(1, 0, 0, 1, 0, 0)");
    expect(previewTransform([0, 0, 10, 10], [0, 0, 0, 0, 5, 5], upright, 1)).toBe("matrix(1, 0, 0, 1, 0, 0)");
  });
});

describe("ppi and pagePoint", () => {
  it("measures pixels per inch along the width", () => {
    expect(ppi(600, 144)).toBe(300);
    expect(ppi(72, 72)).toBe(72);
    expect(ppi(1000, sides(cases["rotated 30°"]).width)).toBeCloseTo(360, 9);
    expect(ppi(100, 0)).toBe(0);
  });

  it("round-trips a page point through client coordinates", () => {
    const pageRect = { left: 37.5, top: -812.25 };
    const origin: Point = [-10, 25];
    for (const zoom of [0.25, 1, 1.75, 4]) {
      for (const p of [[0, 0], [300.5, 412.125], [-10, 25], [612, 792]] as Point[]) {
        const clientX = pageRect.left + (p[0] - origin[0]) * zoom;
        const clientY = pageRect.top + (p[1] - origin[1]) * zoom;
        expectPoint(pagePoint(clientX, clientY, pageRect, origin, zoom), p, 1e-9);
      }
    }
    expect(pagePoint(37.5, -812.25, pageRect, origin, 2)).toEqual(origin);
  });
});
