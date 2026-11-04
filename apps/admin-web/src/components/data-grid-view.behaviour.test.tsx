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

const { DataGridView, drawerRowLink, openRowDrawer, openRowFromCell } =
  await import("./data-grid-view");
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
  it("replays the rows' fade when it changes (opacity, never height) — each change flips the keyframes", () => {
    expect(root(draw()).props["data-density"]).toBe("comfortable");
    // The density a page LOADS with is no change: nothing replays on hydration.
    expect(root(draw()).props["data-replay"]).toBeUndefined();
    writeDensity("compact");
    expect(root(draw()).props["data-density"]).toBe("compact");
    expect(root(draw()).props["data-replay"]).toBe("odd");
    writeDensity("comfortable");
    expect(root(draw()).props["data-replay"]).toBe("even");
  });

  it("never remounts the rows to do it — a row's own state (a role being chosen) survives", () => {
    // It used to key the body on the density, which threw away every row's client state.
    const body = (tree: ReactNode) => elements(tree).find((e) => e.type === "tbody")!;
    const before = body(draw());
    writeDensity("compact");
    const after = body(draw());
    expect(before.key).toBeNull();
    expect(after.key).toBeNull();
  });
});

/**
 * A click on a cell's own text (lifted above the row's stretched link so its title shows) is
 * handed to the row's link — the node env has no DOM, so the row is a duck-typed stand-in that
 * answers exactly the two lookups the handler makes.
 */
describe("a plain click on a cell's text still opens the row", () => {
  const ROW_CONTROLS = "a, button, input, select, textarea, summary, label, [role='button']";

  function scene({ insideControl = false, rowLinks = true } = {}) {
    const link = { click: vi.fn() };
    const row = {
      querySelector: (selector: string) => (selector === "a.grid__link" && rowLinks ? link : null),
    };
    const text = {
      closest: (selector: string) =>
        selector === "tr" ? row : selector === ROW_CONTROLS && insideControl ? {} : null,
    };
    return { link, text };
  }
  const click = (target: unknown, over: Record<string, unknown> = {}) =>
    ({
      target,
      button: 0,
      defaultPrevented: false,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      ...over,
    }) as unknown as Parameters<typeof openRowFromCell>[0];
  const selection = (text: string) =>
    vi.stubGlobal("window", { getSelection: () => ({ isCollapsed: text === "", toString: () => text }) });

  beforeEach(() => selection(""));

  it("hands a plain primary click to the row's link — its navigation, its pending cue", () => {
    const { link, text } = scene();
    openRowFromCell(click(text));
    expect(link.click).toHaveBeenCalledTimes(1);
  });

  it("leaves a click with a modifier or another button alone", () => {
    const { link, text } = scene();
    for (const over of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      openRowFromCell(click(text, over));
    }
    expect(link.click).not.toHaveBeenCalled();
  });

  it("leaves a click on a control of its own alone — a copy button, a customer link, the link itself", () => {
    const { link, text } = scene({ insideControl: true });
    openRowFromCell(click(text));
    expect(link.click).not.toHaveBeenCalled();
  });

  it("leaves a click that ends a text selection alone — the text was being copied", () => {
    selection("Chakan MIDC");
    const { link, text } = scene();
    openRowFromCell(click(text));
    expect(link.click).not.toHaveBeenCalled();
  });

  it("does nothing in a row with no link, or for a click something already handled", () => {
    const unlinked = scene({ rowLinks: false });
    expect(() => openRowFromCell(click(unlinked.text))).not.toThrow();
    expect(unlinked.link.click).not.toHaveBeenCalled();
    const handled = scene();
    openRowFromCell(click(handled.text, { defaultPrevented: true }));
    expect(handled.link.click).not.toHaveBeenCalled();
  });

  it("is wired to the body of a grid whose rows link — and only there", () => {
    const body = (tree: ReactNode) => elements(tree).find((e) => e.type === "tbody")!;
    const props = (tree: ReactNode) => body(tree).props as { onClick?: unknown };
    expect(props(draw()).onClick).toBeUndefined();
    const linked = {
      ...PROPS,
      linkColumn: "a",
      rows: [{ ...PROPS.rows[0]!, href: "/candidates/1", name: "one" }],
    };
    const tree = harness().render(() => {
      h.refCalls = 0;
      return DataGridView(linked);
    });
    expect(props(tree).onClick).toBe(openRowFromCell);
  });
});

/**
 * A7 (#2577): a row can open a DRAWER over its own list (`rowLink.drawer`). The link keeps its
 * href (`?c=<id>` with the list's query — a new tab opens the drawer there), but a plain click
 * Next would handle is stopped and the address taken in place, so the list is not re-read.
 */
describe("a row that opens a drawer over the list", () => {
  type RowLinkEl = ReactElement<{ row: unknown; href: string; drawer?: string }>;
  const linked = (linkDrawer?: string) => ({
    ...PROPS,
    linkColumn: "a",
    linkDrawer,
    rows: [{ ...PROPS.rows[0]!, href: "/candidates?status=active&c=w1", name: "one" }],
  });
  /** The row link the view drew, and the <Link> it renders. */
  function rowLink(props: DataGridViewProps) {
    const tree = harness().render(() => {
      h.refCalls = 0;
      return DataGridView(props);
    });
    const el = elements(tree).find(
      (e) => typeof e.type === "function" && e.type.name === "RowLink",
    ) as RowLinkEl | undefined;
    expect(el).toBeDefined();
    const render = el!.type as unknown as (p: RowLinkEl["props"]) => ReactElement<{
      href: string;
      onNavigate?: (e: { preventDefault(): void }) => void;
      "data-drawer-value"?: string;
    }>;
    return { el: el!, link: render(el!.props) };
  }

  it("hands the drawer's param to the row link — and nothing to a grid whose rows open pages", () => {
    expect(rowLink(linked("c")).el.props.drawer).toBe("c");
    expect(rowLink(linked()).el.props.drawer).toBeUndefined();
    expect(rowLink(linked()).link.props.onNavigate).toBeUndefined();
  });

  it("keeps the row's href — the drawer's own address, filters kept — for a new tab", () => {
    expect(rowLink(linked("c")).link.props.href).toBe("/candidates?status=active&c=w1");
  });

  it("a plain click: Next's navigation is stopped and ONE history entry is pushed in place", () => {
    const pushState = vi.fn();
    vi.stubGlobal("window", { history: { state: null, pushState, replaceState: vi.fn(), back: vi.fn() } });
    const { link } = rowLink(linked("c"));
    const event = { preventDefault: vi.fn() };
    link.props.onNavigate!(event);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(pushState).toHaveBeenCalledTimes(1);
    expect(pushState.mock.calls[0]![2]).toBe("/candidates?status=active&c=w1");
  });

  it("openRowDrawer stops the navigation before it opens anything", () => {
    const order: string[] = [];
    openRowDrawer(
      { preventDefault: () => order.push("prevent") },
      "/candidates?c=w2",
      "c",
      (href, param) => order.push(`open ${href} ${param}`),
    );
    expect(order).toEqual(["prevent", "open /candidates?c=w2 c"]);
  });

  it("its link names the value it opens the drawer at — read from its own href", () => {
    expect(rowLink(linked("c")).link.props["data-drawer-value"]).toBe("w1");
    // A row that opens a page names no drawer value.
    expect(rowLink(linked()).link.props["data-drawer-value"]).toBeUndefined();
  });
});

/**
 * A7 (#2577): when the drawer closes, focus goes back to the row it is ON — after ↑/↓ the row it
 * moved to, not the one that opened it — found by the value each drawer row link names.
 */
describe("drawerRowLink — the row a drawer is on", () => {
  const link = (value: string) => ({ dataset: { drawerValue: value } }) as unknown as HTMLElement;
  const scopeOf = (links: HTMLElement[]) => {
    const asked: string[] = [];
    return {
      asked,
      scope: {
        querySelectorAll: (selector: string) => {
          asked.push(selector);
          return links;
        },
      },
    };
  };

  it("finds the drawer row link whose value is the drawer's", () => {
    const [w1, w2, w3] = [link("w1"), link("w2"), link("w3")];
    const { scope, asked } = scopeOf([w1, w2, w3]);
    expect(drawerRowLink("w3", scope)).toBe(w3);
    expect(asked).toEqual(["a.grid__link[data-drawer-value]"]);
  });

  it("is null when that row is not on this page", () => {
    expect(drawerRowLink("w9", scopeOf([link("w1")]).scope)).toBeNull();
    expect(drawerRowLink("w1", scopeOf([]).scope)).toBeNull();
  });
});
