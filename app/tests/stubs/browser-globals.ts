// Minimal browser globals so the UI modules can be imported in Node (tests/ui.test.ts only).
const g = globalThis as Record<string, unknown>;

const created: { tag: string; clicked?: boolean }[] = [];
g.__created = created;
g.localStorage = { getItem: () => null, setItem: () => undefined };
g.document = {
  documentElement: { lang: "" },
  body: { append: () => undefined },
  activeElement: null,
  createElement(tag: string) {
    const el = {
      tag,
      style: {},
      clicked: false,
      click() { el.clicked = true; },
      remove: () => undefined,
      setAttribute: () => undefined,
      addEventListener: () => undefined,
    };
    created.push(el);
    return el;
  },
};
g.window = globalThis;
g.matchMedia = () => ({ matches: false, addEventListener: () => undefined });
g.requestAnimationFrame = (f: () => void) => setTimeout(f, 0);
g.location = { reload: () => undefined };
