// Move and resize without dragging (release 6, WCAG 2.5.7): the NudgeControls of the context bars
// (the toggle and its row, the names in both languages, a click's step and Shift's, − and +, the
// shapes' Stretch toggle that makes the arrows stretch or move a line's end, a held arrow that
// repeats and stops (also when the row closes, the window loses the focus or the pointer lifts
// elsewhere), disabled while an edit is written, the bar's buttons before the row in the DOM), the
// CSS that keeps its row on one line where the page has room, and the image bar's buttons going
// through the keyboard's accumulation: shown at once, added up with the arrow keys, clamped to the
// page, written as one edit after the pause or when the app flushes it, and nothing while an edit
// is pending.
// Components are called as functions (hooks mocked: refs and states kept by call order until the
// next mount, a state set kept for the next call, effects not run), with no engine and no browser.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { signal } from "@preact/signals";
import { h } from "preact";
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "./stubs/browser-globals";
import type { ImageInfo, Matrix } from "../src/engine/protocol";

const hooks = vi.hoisted(() => ({ at: 0, refs: [] as { current: unknown }[], states: [] as unknown[] }));
vi.mock("preact/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("preact/hooks")>()),
  useState: (init: unknown) => {
    const i = hooks.at++;
    return [hooks.states[i] ?? (typeof init === "function" ? (init as () => unknown)() : init), (v: unknown) => { hooks.states[i] = v; }];
  },
  useRef: (init: unknown) => (hooks.refs[hooks.at++] ??= { current: init }),
  useEffect: () => undefined,
  useLayoutEffect: () => undefined,
}));

vi.mock("../src/engine/client.ts", () => ({
  EngineError: class extends Error {},
  EngineClient: class {},
}));

// The image edits the frame asks for (the real ones go to the engine).
const edits = vi.hoisted(() => [] as unknown[][]);
vi.mock("../src/ui/actions.ts", () => ({
  chooseReplacement: () => undefined,
  deleteImage: () => Promise.resolve(),
  lockReasonText: () => "",
  selectImage: () => Promise.resolve(),
  transformImage: (...args: unknown[]) => {
    edits.push(args);
    return Promise.resolve();
  },
}));

vi.mock("../src/viewer/images.ts", () => ({
  ensureImages: () => undefined,
  loadSprite: () => Promise.resolve(null),
  releaseSprite: () => undefined,
}));

// Window listeners (window is globalThis here), kept so a test can send them an event.
const winListeners = new Map<string, Set<(e: any) => void>>();
const g = globalThis as any;
g.addEventListener = (type: string, fn: (e: any) => void) => {
  if (!winListeners.has(type)) winListeners.set(type, new Set());
  winListeners.get(type)!.add(fn);
};
g.removeEventListener = (type: string, fn: (e: any) => void) => winListeners.get(type)?.delete(fn);
const fire = (type: string, e: object = {}) => [...(winListeners.get(type) ?? [])].forEach((fn) => fn(e));
const listening = () => ["pointerup", "pointercancel", "blur"].reduce((n, type) => n + (winListeners.get(type)?.size ?? 0), 0);

let nudge: typeof import("../src/ui/NudgeControls");
let layer: typeof import("../src/viewer/ImageLayer");
let state: typeof import("../src/state");
let i18n: typeof import("../src/i18n");
let geo: typeof import("../src/viewer/imageGeometry");
beforeAll(async () => {
  nudge = await import("../src/ui/NudgeControls");
  layer = await import("../src/viewer/ImageLayer");
  state = await import("../src/state");
  i18n = await import("../src/i18n");
  geo = await import("../src/viewer/imageGeometry");
});

/** Every vnode in a tree (children of elements, not of components: those are not rendered). */
function nodes(node: any): any[] {
  if (node == null || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(nodes);
  return [node, ...nodes(node.props?.children)];
}
const buttons = (out: any) => nodes(out).filter((n) => n.type === "button");
const named = (out: any, name: string) => buttons(out).find((b) => b.props["aria-label"] === name);

/** A new component instance: its refs and states start again. */
function mount() {
  hooks.refs = [];
  hooks.states = [];
}
/** Call a component, as Preact would render it again (the same refs). */
function render(component: any, props: any) {
  hooks.at = 0;
  return component(props);
}

const pointer = (extra: object = {}) => ({ isPrimary: true, button: 0, shiftKey: false, ...extra });
const click = (extra: object = {}) => ({ detail: 1, shiftKey: false, ...extra });

beforeEach(() => {
  i18n.setLocale("en");
  nudge.nudgeOpen.value = false;
});

describe("N1 the move and resize controls", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("are one toggle in the bar until it is pressed, then a row of named buttons, in both languages", () => {
    mount();
    let out = render(nudge.NudgeControls, { onMove: () => undefined, onScale: () => undefined });
    expect(buttons(out).map((b) => [b.props["aria-label"], b.props["aria-expanded"]])).toEqual([["Move and resize", false]]);
    buttons(out)[0].props.onClick();
    expect(nudge.nudgeOpen.value).toBe(true);
    out = render(nudge.NudgeControls, { onMove: () => undefined, onScale: () => undefined });
    expect(buttons(out).map((b) => b.props["aria-label"])).toEqual([
      "Move and resize", "Move left", "Move up", "Move down", "Move right", "Smaller", "Bigger",
    ]);
    expect(buttons(out)[0].props["aria-expanded"]).toBe(true);
    const row = nodes(out).find((n) => n.props?.role === "group");
    expect([row.props["aria-label"], row.props.class]).toEqual(["Move and resize", "nudge-row"]);
    expect(named(out, "Move left").props.title).toBe("Move left by 2 pt (Shift: 10 pt). Hold it down to keep going.");
    // Every button is an icon button of the bar, with its tooltip (44 px on touch: viewer.css).
    for (const b of buttons(out)) {
      expect(b.props.class).toMatch(/^btn context-btn is-icon/);
      expect(b.props.title).toBeTruthy();
    }

    i18n.setLocale("it");
    out = render(nudge.NudgeControls, { onMove: () => undefined, onScale: () => undefined });
    expect(buttons(out).map((b) => b.props["aria-label"])).toEqual([
      "Sposta e ridimensiona", "Sposta a sinistra", "Sposta su", "Sposta giù", "Sposta a destra", "Più piccola", "Più grande",
    ]);
    expect(named(out, "Sposta giù").props.title).toBe("Sposta giù di 2 pt (Maiusc: 10 pt). Tieni premuto per continuare.");

    // Without onScale: the arrows only, and the toggle says so.
    out = render(nudge.NudgeControls, { onMove: () => undefined });
    expect(buttons(out).map((b) => b.props["aria-label"])).toEqual([
      "Sposta", "Sposta a sinistra", "Sposta su", "Sposta giù", "Sposta a destra",
    ]);
    expect(nodes(out).find((n) => n.props?.role === "group").props.class).toBe("nudge-row is-move-only");

    // Pressed again: back to the toggle alone (the focus stays on it).
    buttons(out)[0].props.onClick();
    expect(buttons(render(nudge.NudgeControls, { onMove: () => undefined })).length).toBe(1);
  });

  it("a click moves by 2 pt as seen, Shift+click by 10 pt; − and + scale by 0.9 and its inverse", () => {
    nudge.nudgeOpen.value = true;
    const moves: number[][] = [];
    const scales: number[] = [];
    mount();
    const out = render(nudge.NudgeControls, { onMove: (dx: number, dy: number) => moves.push([dx, dy]), onScale: (f: number) => scales.push(f) });
    named(out, "Move left").props.onClick(click());
    named(out, "Move right").props.onClick(click());
    named(out, "Move up").props.onClick(click());
    named(out, "Move down").props.onClick(click({ shiftKey: true }));
    named(out, "Smaller").props.onClick(click());
    named(out, "Bigger").props.onClick(click({ detail: 0 })); // Enter or Space
    expect(moves).toEqual([[-2, 0], [2, 0], [0, -2], [0, 10]]);
    expect(scales).toEqual([0.9, 1 / 0.9]);
  });

  it("while an edit is written they stay (aria-disabled, so a focus on one stays) and do nothing; the toggle still works", () => {
    nudge.nudgeOpen.value = true;
    const moves: number[][] = [];
    const scales: number[] = [];
    mount();
    const out = render(nudge.NudgeControls, { onMove: (dx: number, dy: number) => moves.push([dx, dy]), onScale: (f: number) => scales.push(f), disabled: true });
    expect(buttons(out).slice(1).every((b) => b.props["aria-disabled"] === true && !b.props.disabled)).toBe(true);
    expect(buttons(out)[0].props["aria-disabled"]).toBeUndefined();
    vi.useFakeTimers();
    named(out, "Move left").props.onPointerDown(pointer());
    vi.advanceTimersByTime(2000);
    named(out, "Move left").props.onClick(click());
    named(out, "Bigger").props.onClick(click());
    expect([moves, scales]).toEqual([[], []]);
    buttons(out)[0].props.onClick();
    expect(nudge.nudgeOpen.value).toBe(false);
  });

  it("an arrow held down repeats after a delay, like a key, until the pointer lifts; the click that ends it adds no step", () => {
    nudge.nudgeOpen.value = true;
    const moves: number[][] = [];
    mount();
    const out = render(nudge.NudgeControls, { onMove: (dx: number, dy: number) => moves.push([dx, dy]), onScale: () => undefined });
    const right = named(out, "Move right").props;
    vi.useFakeTimers();
    // The arrow keeps the pointer: the bar follows the picture, away from under a still mouse.
    const captured: number[] = [];
    right.onPointerDown(pointer({ shiftKey: true, pointerId: 7, currentTarget: { setPointerCapture: (id: number) => captured.push(id) } }));
    expect(captured).toEqual([7]);
    vi.advanceTimersByTime(nudge.HOLD_DELAY - 1);
    expect(moves).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(moves).toEqual([[10, 0]]); // Shift at the press: the far step
    vi.advanceTimersByTime(3 * nudge.HOLD_REPEAT);
    expect(moves.length).toBe(4);
    right.onPointerUp();
    right.onPointerLeave(); // a finger lifting leaves too, before its click
    right.onClick(click());
    vi.advanceTimersByTime(2000);
    expect(moves.length).toBe(4);

    // A short press is the click's single step, no repeat.
    moves.length = 0;
    right.onPointerDown(pointer());
    vi.advanceTimersByTime(nudge.HOLD_DELAY - 50);
    right.onPointerUp();
    right.onClick(click());
    vi.advanceTimersByTime(2000);
    expect(moves).toEqual([[2, 0]]);
  });

  it("a hold stops when the pointer leaves or is cancelled, or an edit starts; it never eats another click", () => {
    nudge.nudgeOpen.value = true;
    const moves: number[][] = [];
    const scales: number[] = [];
    const props = { onMove: (dx: number, dy: number) => moves.push([dx, dy]), onScale: (f: number) => scales.push(f) };
    mount();
    let out = render(nudge.NudgeControls, props);
    vi.useFakeTimers();
    for (const end of ["onPointerLeave", "onPointerCancel", "onLostPointerCapture"]) {
      moves.length = 0;
      named(out, "Move up").props.onPointerDown(pointer());
      vi.advanceTimersByTime(nudge.HOLD_DELAY);
      named(out, "Move up").props[end]();
      vi.advanceTimersByTime(2000);
      expect(moves).toEqual([[0, -2]]);
    }
    // A pointer gone before it could be kept: no hold, its click (if any) is the one step.
    named(out, "Move up").props.onPointerDown(pointer({ currentTarget: { setPointerCapture: () => { throw new Error("gone"); } } }));
    vi.advanceTimersByTime(2000);
    expect(moves).toEqual([[0, -2]]);
    // Released elsewhere (no click on the arrow): the next click on another button, and a
    // keyboard click on the same one, each make their step.
    named(out, "Bigger").props.onClick(click());
    named(out, "Move up").props.onClick(click({ detail: 0 }));
    expect([moves.length, scales]).toEqual([2, [1 / 0.9]]);

    // An edit starts during a hold (rendered again with disabled): the repeat stops.
    moves.length = 0;
    named(out, "Move down").props.onPointerDown(pointer());
    vi.advanceTimersByTime(nudge.HOLD_DELAY + nudge.HOLD_REPEAT);
    expect(moves.length).toBe(2);
    out = render(nudge.NudgeControls, { ...props, disabled: true });
    vi.advanceTimersByTime(2000);
    expect(moves.length).toBe(2);

    // Not a hold: a right button, a second finger.
    moves.length = 0;
    out = render(nudge.NudgeControls, props);
    named(out, "Move down").props.onPointerDown(pointer({ button: 2 }));
    named(out, "Move down").props.onPointerDown(pointer({ isPrimary: false }));
    vi.advanceTimersByTime(2000);
    expect(moves).toEqual([]);
    // A long press brings no context menu (it is a hold).
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    named(out, "Move down").props.onContextMenu(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("the row's buttons fit on one line of the bar where the page has room: its min-width is the real button size", () => {
    const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
    const read = (name: string) => strip(readFileSync(new URL(`../src/styles/${name}`, import.meta.url), "utf8"));
    const [viewer, base, tokens, css] = ["viewer.css", "base.css", "tokens.css", "nudge.css"].map(read);
    const bodies = (text: string, selector: string) =>
      [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => m[1].split(",").map((s) => s.trim()).includes(selector)).map((m) => m[2]);
    const px = (body: string, property: string) => Number(new RegExp(String.raw`(?:^|[;\s])${property}:\s*(\d+)px`).exec(body)?.[1]);
    // An icon button is .btn's min-width wide, var(--btn): 36 px, 44 px on touch (min-width wins
    // over the 32 px .context-btn.is-icon asks for); the bar: 4 px gaps, 3 px padding, 1 px border.
    expect(bodies(base, ".btn").some((b) => /min-width:\s*var\(--btn\)/.test(b))).toBe(true);
    expect([...tokens.matchAll(/--btn:\s*(\d+)px/g)].map((m) => Number(m[1]))).toEqual([36, 44]);
    const bar = bodies(viewer, ".context-bar")[0];
    expect([px(bar, "gap"), px(bar, "padding"), /border:\s*1px/.test(bar)]).toEqual([4, 3, true]);
    expect(bodies(css, ".context-bar:has(> .nudge-row)")[0]).toMatch(/--nudge-btn:\s*var\(--btn\)/);
    // At most the page's width: on a narrower page the row wraps (no button past the screen).
    expect(css).toContain("min-width: min(calc(6 * var(--nudge-btn) + 5 * 4px + 8px), 100%)");
    expect(css).toContain("min-width: min(calc(7 * var(--nudge-btn) + 6 * 4px + 8px), 100%)");
    expect(css).toContain("min-width: min(calc(4 * var(--nudge-btn) + 3 * 4px + 8px), 100%)");
    expect(bodies(css, ".nudge-row")[0]).toMatch(/flex-wrap:\s*wrap/);
    // The image bar's row, 292 px on touch: within a 320 px phone's view, 8 px from each side (VIEW_EDGE in ImageLayer).
    expect(6 * 44 + 5 * 4 + 8).toBeLessThanOrEqual(320 - 2 * 8);
  });

  it("with onStretch, a Stretch toggle starts the row: pressed, the arrows stretch (or move a line's end), named so", () => {
    nudge.nudgeOpen.value = true;
    const moves: number[][] = [];
    const stretches: number[][] = [];
    const props = {
      onMove: (dx: number, dy: number) => moves.push([dx, dy]),
      onScale: () => undefined,
      onStretch: (dx: number, dy: number) => stretches.push([dx, dy]),
    };
    mount();
    let out = render(nudge.NudgeControls, props);
    expect(nodes(out).find((n) => n.props?.role === "group").props.class).toBe("nudge-row has-stretch");
    expect(buttons(out).map((b) => b.props["aria-label"])).toEqual([
      "Move and resize", "Stretch", "Move left", "Move up", "Move down", "Move right", "Smaller", "Bigger",
    ]);
    expect(named(out, "Stretch").props["aria-pressed"]).toBe(false);
    named(out, "Move right").props.onClick(click());
    named(out, "Stretch").props.onClick();
    out = render(nudge.NudgeControls, props);
    expect(named(out, "Stretch").props["aria-pressed"]).toBe(true);
    expect(buttons(out).slice(2, 6).map((b) => b.props["aria-label"])).toEqual(["Narrower", "Shorter", "Taller", "Wider"]);
    expect(named(out, "Wider").props.title).toBe("Wider by 2 pt (Shift: 10 pt). Hold it down to keep going.");
    named(out, "Wider").props.onClick(click());
    named(out, "Taller").props.onClick(click({ shiftKey: true }));
    // A held arrow stretches too.
    vi.useFakeTimers();
    named(out, "Narrower").props.onPointerDown(pointer({ currentTarget: { setPointerCapture: () => undefined } }));
    vi.advanceTimersByTime(nudge.HOLD_DELAY);
    named(out, "Narrower").props.onPointerUp();
    expect([moves, stretches]).toEqual([[[2, 0]], [[2, 0], [0, 10], [-2, 0]]]);

    // A line: the toggle and the arrows say they move its end.
    i18n.setLocale("it");
    out = render(nudge.NudgeControls, { ...props, stretchEnd: true });
    expect(buttons(out).slice(1, 6).map((b) => b.props["aria-label"])).toEqual([
      "Sposta la fine", "Sposta la fine a sinistra", "Sposta la fine su", "Sposta la fine giù", "Sposta la fine a destra",
    ]);
    // Without onStretch (the image bar): no toggle, and the arrows move.
    mount();
    out = render(nudge.NudgeControls, { onMove: props.onMove, onScale: () => undefined });
    expect(named(out, "Allunga")).toBeUndefined();
    expect(named(out, "Sposta a destra")).toBeTruthy();
    expect(nodes(out).find((n) => n.props?.role === "group").props.class).toBe("nudge-row");
  });

  it("the bar's buttons given as children come after the toggle and before the row, which Tab reaches last", () => {
    nudge.nudgeOpen.value = true;
    mount();
    const out = render(nudge.NudgeControls, {
      onMove: () => undefined,
      children: [h("button", { key: "delete", "aria-label": "Delete" }), h("button", { key: "done", "aria-label": "Done" })],
    });
    expect(buttons(out).map((b) => b.props["aria-label"])).toEqual(["Move", "Delete", "Done", "Move left", "Move up", "Move down", "Move right"]);
  });

  it("a hold stops when the row closes, the window loses the focus, or its pointer lifts where the arrow does not hear it", () => {
    nudge.nudgeOpen.value = true;
    const moves: number[][] = [];
    mount();
    const out = render(nudge.NudgeControls, { onMove: (dx: number, dy: number) => moves.push([dx, dy]) });
    const down = named(out, "Move down").props;
    vi.useFakeTimers();
    const held = (end: () => void) => {
      moves.length = 0;
      down.onPointerDown(pointer({ pointerId: 3, currentTarget: { setPointerCapture: () => undefined } }));
      vi.advanceTimersByTime(nudge.HOLD_DELAY);
      end();
      vi.advanceTimersByTime(2000);
      return moves.length;
    };
    // The row closed under it (the toggle, by keyboard): no step after.
    expect(held(() => { nudge.nudgeOpen.value = false; })).toBe(1);
    nudge.nudgeOpen.value = true;
    expect(held(() => fire("blur"))).toBe(1);
    expect(held(() => fire("pointerup", { pointerId: 3 }))).toBe(1);
    expect(held(() => fire("pointercancel", { pointerId: 3 }))).toBe(1);
    // Another pointer lifting does not end it; the window's listeners go with the hold.
    expect(held(() => fire("pointerup", { pointerId: 9 }))).toBeGreaterThan(10);
    down.onPointerUp();
    expect(listening()).toBe(0);
  });
});

describe("N2 the image bar's move and size buttons", () => {
  const M0: Matrix = [100, 0, 0, 50, 100, 100];
  const image = (matrix: Matrix = M0): ImageInfo => ({
    index: 0, matrix, bbox: [100, 100, 200, 150], visible: [100, 100, 200, 150],
    pixelWidth: 10, pixelHeight: 5, movable: true, reason: null, added: false,
  });
  const close = (a: Matrix, b: Matrix) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 9));
  const fakePage = () => ({
    key: 1, index: 0, bounds: [0, 0, 600, 800], width: 600, height: 800,
    near: signal(true), keep: signal(true), rev: signal(1),
    lines: signal(null), images: signal({ rev: 1, images: [image()] }), fields: signal(null), added: signal(null),
  });

  /** The selected image's frame and bar, as the layer renders them (`only` as the layer's). */
  function selected(page: any, only: "all" | "added" = "all") {
    state.selectedImage.value = { pageIndex: 0, index: 0 };
    mount();
    const frame = nodes(render(layer.ImageLayer, { page, zoom: 1, canvasRev: 1, only }))
      .find((n) => typeof n.type === "function" && n.type.name === "SelectedImage");
    expect(frame).toBeTruthy();
    mount();
    const out = render(frame.type, frame.props);
    return {
      out,
      controls: nodes(out).find((n) => n.type === nudge.NudgeControls).props,
      key: (key: string, extra: object = {}) => nodes(out).find((n) => n.props?.role === "application").props.onKeyDown({
        key, code: key, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false,
        preventDefault: () => undefined, stopPropagation: () => undefined, ...extra,
      }),
    };
  }

  beforeEach(() => {
    edits.length = 0;
    vi.useFakeTimers();
  });
  afterEach(async () => {
    await state.flushEditor();
    vi.useRealTimers();
    state.selectedImage.value = null;
    state.imageEditsPending.value = 0;
  });

  it("are in the bar after Rotate, for every picture and for the added pictures of Compila e firma", () => {
    for (const only of ["all", "added"] as const) {
      const page = fakePage();
      page.images.value = { rev: 1, images: [{ ...image(), added: true }] };
      const { out, controls } = selected(page, only);
      expect([typeof controls.onMove, typeof controls.onScale, controls.disabled]).toEqual(["function", "function", false]);
      const bar = nodes(out).find((n) => n.props?.role === "toolbar");
      const order = (bar.props.children as any[]).flat().filter(Boolean).map((n: any) => n.type === nudge.NudgeControls ? "nudge" : n.key);
      expect(order).toEqual(["replace", "rotate", "nudge"]);
      // Delete and Done follow the toggle, before its row (NudgeControls renders its children there).
      const inner = nodes(out).find((n) => n.type === nudge.NudgeControls).props.children;
      expect([inner].flat().map((n: any) => n.key)).toEqual(["delete", "done"]);
      expect(controls.onStretch).toBeUndefined(); // a picture is moved and scaled, not stretched
    }
  });

  it("add up with the arrow keys, show at once, and are written as one edit 600 ms after the last change", async () => {
    const page = fakePage();
    const { controls, key } = selected(page);
    key("ArrowRight"); // 1 pt
    controls.onMove(2, 0);
    controls.onMove(0, 10);
    controls.onScale(1 / 0.9);
    expect(state.hasUnsavedWork()).toBe(true); // registered: downloads, undo and tool changes flush it
    vi.advanceTimersByTime(599);
    expect(edits).toEqual([]);
    controls.onMove(-2, 0); // each change starts the pause again
    vi.advanceTimersByTime(599);
    expect(edits).toEqual([]);
    vi.advanceTimersByTime(1);
    await vi.runAllTimersAsync();
    const moved = geo.translateBy(M0, 1 + 2, 10);
    const scaled = geo.scaleAbout(moved, geo.centre(moved), 1 / 0.9);
    expect(edits.length).toBe(1);
    const [, img, matrix, rev] = edits[0] as [unknown, ImageInfo, Matrix, number];
    expect([img.index, rev]).toEqual([0, 1]);
    close(matrix, geo.translateBy(scaled, -2, 0));
    expect(state.hasUnsavedWork()).toBe(false);
  });

  it("are written at once when the app flushes (a download, undo, a change of tool)", async () => {
    const { controls } = selected(fakePage());
    controls.onMove(0, -2);
    await state.flushEditor();
    expect(edits.map((e) => e[2])).toEqual([geo.translateBy(M0, 0, -2)]);
  });

  it("keep the picture's centre on the page, as the arrow keys do", async () => {
    const page = fakePage();
    const { controls } = selected(page);
    for (let i = 0; i < 100; i++) controls.onMove(-10, 0);
    await state.flushEditor();
    expect(edits.length).toBe(1);
    close(edits[0][2] as Matrix, geo.clampCentre(geo.translateBy(M0, -1000, 0), page.bounds as any));
    expect(geo.centre(edits[0][2] as Matrix)[0]).toBeCloseTo(0, 5); // on the left edge (a hair inside)
  });

  it("do nothing while an image edit waits or is written: disabled, and no change", async () => {
    state.imageEditsPending.value = 1;
    const { controls } = selected(fakePage());
    expect(controls.disabled).toBe(true);
    controls.onMove(2, 0);
    controls.onScale(0.9);
    await vi.runAllTimersAsync();
    await state.flushEditor();
    expect(edits).toEqual([]);
  });
});
