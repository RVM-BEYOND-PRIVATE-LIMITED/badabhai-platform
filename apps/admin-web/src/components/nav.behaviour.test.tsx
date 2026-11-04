import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ReactModule from "react";
import type { ReactElement, ReactNode } from "react";
import { createHookHarness, type HookHarness } from "../../test/hook-harness";

/**
 * The sidebar's groups and its active marker, WIRED (A6, #2576). The node env cannot mount React,
 * so the component runs through the one-instance hook harness (state kept across re-renders, a
 * setState from a handler seen by the next render), effects are collected to be run by hand,
 * and its one ref is a stand-in nav element. What renders is read off the element tree.
 */
type Effect = { run: () => void | (() => void); deps: readonly unknown[] | undefined };

const h = vi.hoisted(() => ({
  harness: null as HookHarness | null,
  effects: [] as Effect[],
  pathname: "/jobs",
  nav: null as unknown,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
    useState: <T,>(initial: T | (() => T)) => h.harness!.useState(initial),
    useId: () => h.harness!.useId(),
    useRef: () => ({ current: h.nav }),
    useEffect: (run: Effect["run"], deps?: readonly unknown[]) => {
      h.effects.push({ run, deps });
    },
  };
});
vi.mock("next/navigation", () => ({ usePathname: () => h.pathname }));

const { SidebarNav } = await import("./nav");

const SECTIONS = [
  { title: "Home", items: [{ href: "/", label: "Dashboard", icon: "squares-four" as const }] },
  {
    title: "Directory",
    items: [
      { href: "/candidates", label: "Candidates", icon: "users-three" as const },
      { href: "/jobs", label: "Postings", icon: "briefcase" as const },
    ],
  },
  { title: "Finance", items: [{ href: "/credits", label: "Credits", icon: "wallet" as const }] },
];

type Props = { className?: string; children?: ReactNode; [key: string]: unknown };

/** Every element in the tree (component children are not expanded — they are not ours). */
function walk(node: ReactNode, out: ReactElement<Props>[] = []): ReactElement<Props>[] {
  if (Array.isArray(node)) node.forEach((n) => walk(n as ReactNode, out));
  else if (node && typeof node === "object" && "props" in node) {
    const el = node as ReactElement<Props>;
    out.push(el);
    walk(el.props.children, out);
  }
  return out;
}

/** Render (re-render) the one SidebarNav instance; effects are collected afresh. */
function render(): ReactElement<Props> {
  h.effects = [];
  return h.harness!.render(() => SidebarNav({ sections: SECTIONS })) as ReactElement<Props>;
}
const byClass = (tree: ReactElement<Props>, cls: string) =>
  walk(tree).filter((el) => el.props.className?.split(" ").includes(cls));
const toggleOf = (tree: ReactElement<Props>, title: string) =>
  byClass(tree, "sidebar__grouptoggle").find((b) =>
    walk(b.props.children).some((c) => c.props.children === title),
  )!;
const groupOf = (tree: ReactElement<Props>, title: string) =>
  byClass(tree, "sidebar__group").find((g) =>
    walk(g.props.children).some((c) => c.props.children === title),
  )!;
const listOf = (tree: ReactElement<Props>, title: string) =>
  byClass(groupOf(tree, title), "sidebar__list")[0]!;
const click = (el: ReactElement<Props>) => (el.props.onClick as () => void)();

beforeEach(() => {
  h.harness = createHookHarness();
  h.pathname = "/jobs";
  h.nav = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a group opens and closes from its title", () => {
  it("every group starts open, its button controlling its list", () => {
    const tree = render();
    for (const title of ["Home", "Directory", "Finance"]) {
      const toggle = toggleOf(tree, title);
      expect(toggle.props["aria-expanded"]).toBe(true);
      expect(toggle.props["aria-controls"]).toBe(listOf(tree, title).props.id);
      expect(listOf(tree, title).props.hidden).toBe(false);
    }
  });

  it("closing one hides only its rows, and says so on its button", () => {
    click(toggleOf(render(), "Finance"));
    const tree = render();
    expect(listOf(tree, "Finance").props.hidden).toBe(true);
    expect(toggleOf(tree, "Finance").props["aria-expanded"]).toBe(false);
    expect(listOf(tree, "Directory").props.hidden).toBe(false);
  });

  it("and opens again", () => {
    click(toggleOf(render(), "Finance"));
    click(toggleOf(render(), "Finance"));
    const tree = render();
    expect(listOf(tree, "Finance").props.hidden).toBe(false);
    expect(toggleOf(tree, "Finance").props["aria-expanded"]).toBe(true);
  });

  it("only a group the operator toggled is marked to animate — nothing moves on a load", () => {
    expect(byClass(render(), "sidebar__group").map((g) => g.props["data-moved"])).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    click(toggleOf(render(), "Finance"));
    const tree = render();
    expect(groupOf(tree, "Finance").props["data-moved"]).toBe("");
    expect(groupOf(tree, "Directory").props["data-moved"]).toBeUndefined();
  });

  it("closing the current page's own group is the operator's choice: it stays closed", () => {
    click(toggleOf(render(), "Directory"));
    render();
    expect(listOf(render(), "Directory").props.hidden).toBe(true);
  });

  it("a navigation INTO a closed group opens it, so the current page is never hidden", () => {
    click(toggleOf(render(), "Finance"));
    expect(listOf(render(), "Finance").props.hidden).toBe(true);
    h.pathname = "/credits";
    const tree = render();
    expect(listOf(tree, "Finance").props.hidden).toBe(false);
    expect(toggleOf(tree, "Finance").props["aria-expanded"]).toBe(true);
  });

  it("a navigation elsewhere leaves a closed group closed", () => {
    click(toggleOf(render(), "Finance"));
    h.pathname = "/candidates";
    expect(listOf(render(), "Finance").props.hidden).toBe(true);
  });
});

describe("the active marker", () => {
  /**
   * A stand-in nav whose active row sits `top` px down it, `height` tall: its layout (the link in
   * a positioned `li`, the `li` in the nav), and where it is DRAWN — its client rect, `slide` px
   * short while its group's list is still sliding open (a transform moves paint, never layout).
   * `rendered: false` is the row inside a closed group: no box at all.
   */
  function standInNav(top: number, height: number) {
    const nav = {
      offsetTop: 0,
      clientTop: 0,
      offsetParent: null,
      rendered: true,
      slide: 0,
      getBoundingClientRect: () => ({ top: 100, height: 600 }),
      querySelector: () => row,
      move(nextTop: number) {
        li.offsetTop = nextTop;
      },
    };
    const li = { offsetTop: top, clientTop: 0, offsetParent: nav };
    const row = {
      offsetTop: 0,
      offsetHeight: height,
      offsetParent: li,
      getClientRects: () => ({ length: nav.rendered ? 1 : 0 }),
      getBoundingClientRect: () => ({ top: 100 + li.offsetTop - nav.slide, height }),
    };
    return nav;
  }
  const markerEffect = () =>
    h.effects.find((e) => e.deps?.includes("/jobs") || e.deps?.includes("/credits"));

  it("is measured after the render and drawn over the active row; the nav hands it the wash", () => {
    h.nav = standInNav(144, 36);
    render();
    markerEffect()!.run();
    const tree = render();
    expect(tree.props["data-marker"]).toBe("");
    const marker = byClass(tree, "sidebar__marker")[0]!;
    expect(marker.props["aria-hidden"]).toBe("true");
    expect(marker.props.style).toEqual({ "--nav-marker-y": "144px", "--nav-marker-h": "36px" });
  });

  it("is placed again when the route changes — the CSS glides it there", () => {
    const nav = standInNav(144, 36);
    h.nav = nav;
    render();
    markerEffect()!.run();
    h.pathname = "/credits";
    nav.move(260);
    render();
    const effect = markerEffect()!;
    // Keyed on the active row, so a new route re-measures.
    expect(effect.deps).toContain("/credits");
    effect.run();
    expect(byClass(render(), "sidebar__marker")[0]!.props.style).toEqual({
      "--nav-marker-y": "260px",
      "--nav-marker-h": "36px",
    });
  });

  it("follows the rows when the nav resizes (a group above it closing), and lets go on unmount", () => {
    let resized: (() => void) | null = null;
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: () => void) {
          resized = cb;
        }
        observe() {}
        disconnect = disconnect;
      },
    );
    const nav = standInNav(144, 36);
    h.nav = nav;
    render();
    const cleanup = markerEffect()!.run();
    nav.move(100);
    resized!();
    expect(byClass(render(), "sidebar__marker")[0]!.props.style).toEqual({
      "--nav-marker-y": "100px",
      "--nav-marker-h": "36px",
    });
    // A resize that moved nothing keeps the very same marker state: no re-render.
    const placed = h.harness!.slots.find((v) => v && typeof v === "object" && "top" in v);
    resized!();
    expect(h.harness!.slots.find((v) => v && typeof v === "object" && "top" in v)).toBe(placed);
    (cleanup as () => void)();
    expect(disconnect).toHaveBeenCalled();
  });

  it("re-opening the active row's own group puts it ON the row — not where the slide begins", () => {
    // The A6 review's marker finding: the effect (and the ResizeObserver's first call) measure in the frame the
    // group opens, when nav-group-in still holds its list 6px up; nothing measures again after,
    // since a transform resizes nothing. A reading of where the row was DRAWN stuck 6px high.
    const nav = standInNav(144, 36);
    h.nav = nav;
    render();
    markerEffect()!.run();
    // The operator closes Directory, the page's own group: no row, so no marker.
    click(toggleOf(render(), "Directory"));
    nav.rendered = false;
    render();
    markerEffect()!.run();
    expect(byClass(render(), "sidebar__marker")).toEqual([]);
    // …and opens it again, measured mid-slide.
    click(toggleOf(render(), "Directory"));
    nav.rendered = true;
    nav.slide = 6;
    render();
    markerEffect()!.run();
    expect(byClass(render(), "sidebar__marker")[0]!.props.style).toEqual({
      "--nav-marker-y": "144px",
      "--nav-marker-h": "36px",
    });
  });

  it("is removed when there is no row to mark, and the rows draw their own wash again", () => {
    const nav = standInNav(144, 36);
    h.nav = nav;
    render();
    markerEffect()!.run();
    expect(render().props["data-marker"]).toBe("");
    (nav as { querySelector: () => unknown }).querySelector = () => null;
    markerEffect()!.run();
    const tree = render();
    expect(tree.props["data-marker"]).toBeUndefined();
    expect(byClass(tree, "sidebar__marker")).toEqual([]);
  });
});
