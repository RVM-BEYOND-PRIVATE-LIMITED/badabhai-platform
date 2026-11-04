import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ReactModule from "react";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { createHookHarness, type HookHarness } from "../../test/hook-harness";
import type { DataGridViewProps } from "./data-grid-view";

/**
 * The data grid's client half, render by render (A4, #2574) — what only the browser knows:
 * whether the table FITS its box (measured, never guessed), and the viewer's density.
 *
 * The node env has no reconciler: the view is called as a function on the hook harness (state
 * kept across renders), `useSyncExternalStore` reads the client snapshot, `useEffect` is recorded
 * so a test runs the measurement by hand against stub elements and a stub ResizeObserver.
 */
type Effect = () => void | (() => void);
const h = vi.hoisted(() => ({
  harness: null as unknown,
  effects: [] as Effect[],
  refs: [] as { current: unknown }[],
  refCalls: 0,
}));
const harness = () => h.harness as HookHarness;

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
    useState: (initial: unknown) => harness().useState(initial),
    useRef: (initial: unknown) => {
      const at = h.refCalls++;
      h.refs[at] ??= { current: initial };
      return h.refs[at]!;
    },
    useEffect: (run: Effect) => {
      h.effects.push(run);
    },
    useMemo: (fn: () => unknown) => fn(),
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
  };
});

const { DataGridView } = await import("./data-grid-view");
const { resetGridPreferencesForTests, writeDensity } = await import("./grid-preferences");

const PROPS: DataGridViewProps = {
  gridId: "g",
  caption: "c",
  columns: [{ id: "a", header: "A", width: "fill", text: "truncate", locked: false, defaultHidden: false }],
  rows: [{ key: "r1", cells: ["one"], trails: [undefined], titles: [undefined] }],
  viewControls: false,
};

function elements(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const props = node.props as { children?: ReactNode };
  return [node, ...elements(props.children)];
}

const draw = () => {
  h.effects = [];
  return harness().render(() => {
    h.refCalls = 0;
    return DataGridView(PROPS);
  });
};
const root = (tree: ReactNode) => tree as ReactElement<Record<string, string>>;

let observed: Array<{ callback: () => void; targets: unknown[]; disconnected: boolean }> = [];
class FakeResizeObserver {
  readonly entry: { callback: () => void; targets: unknown[]; disconnected: boolean };
  constructor(callback: () => void) {
    this.entry = { callback, targets: [], disconnected: false };
    observed.push(this.entry);
  }
  observe(target: unknown) {
    this.entry.targets.push(target);
  }
  disconnect() {
    this.entry.disconnected = true;
  }
}

beforeEach(() => {
  h.harness = createHookHarness();
  h.refs = [];
  observed = [];
  resetGridPreferencesForTests();
});
afterEach(() => vi.unstubAllGlobals());

describe("whether the table fits its box — measured", () => {
  it("scrolls sideways until measured: the server render never clips a table", () => {
    expect(root(draw()).props["data-fit"]).toBe("false");
  });

  it("measures on mount and on every resize of the box or the table; stops when unmounted", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    draw();
    const box = { clientWidth: 1000 };
    const table = { offsetWidth: 900 };
    h.refs[0]!.current = box; // the scroller
    h.refs[1]!.current = table; // the table
    const cleanup = h.effects[0]!() as () => void; // the measurement (the first effect)
    expect(observed).toHaveLength(1);
    expect(observed[0]!.targets).toEqual([box, table]);

    // It fits: clipped, so its header sticks to the window.
    expect(root(draw()).props["data-fit"]).toBe("true");

    // The window narrows past the table's minimum: it scrolls sideways again.
    box.clientWidth = 700;
    observed[0]!.callback();
    expect(root(draw()).props["data-fit"]).toBe("false");

    cleanup();
    expect(observed[0]!.disconnected).toBe(true);
  });

  it("without ResizeObserver it never claims to fit", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    draw();
    h.refs[0]!.current = { clientWidth: 1000 };
    h.refs[1]!.current = { offsetWidth: 10 };
    h.effects[0]!();
    expect(root(draw()).props["data-fit"]).toBe("false");
  });
});

describe("a new set of rows", () => {
  it("starts at its first row — the fill layout's scroller is reset, instantly, never animated", () => {
    draw();
    const box = { clientWidth: 1000, scrollTop: 1840 };
    h.refs[0]!.current = box;
    // The second effect, re-run by React whenever the rows change.
    h.effects[1]!();
    expect(box.scrollTop).toBe(0);
  });
});

describe("density", () => {
  it("re-enters the rows when it changes — their fade replays (opacity, never height)", () => {
    const body = (tree: ReactNode) => elements(tree).find((e) => e.type === "tbody")!;
    expect(root(draw()).props["data-density"]).toBe("comfortable");
    const before = body(draw()).key;
    writeDensity("compact");
    const after = draw();
    expect(root(after).props["data-density"]).toBe("compact");
    expect(body(after).key).not.toBe(before);
  });
});
