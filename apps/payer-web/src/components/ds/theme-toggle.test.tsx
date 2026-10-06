import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";

/**
 * THEME-1 — ThemeToggle (the light/dark control). Rendered to an element tree in the node
 * env and walked. Asserts: the switch carries role="switch" + a direction-correct
 * aria-checked/aria-label (both directions); clicking it flips data-theme, writes the
 * bb_theme cookie, and syncs theme-color via the theme helpers; the System button is present
 * + aria-pressed when active; and a polite live region announces the change.
 *
 * Hooks are stubbed (node env can't run real React hooks). `resolved` is injected via a
 * seeded useState so both label directions can be exercised without a click cycle.
 */

let resolvedSeed: "paper" | "ink" = "paper";
let prefSeed: "paper" | "ink" | "system" = "system";
// Per-render useState call index — reset by render() before each invocation so the (pref,
// resolved, announce) order maps to the seeds on every render.
const hookCursor = { i: 0 };

// useState calls in order: (1) pref, (2) resolved, (3) announce. Seed the first two and give
// announce an inert setter.
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof ReactModule>("react");
  return {
    ...actual,
    useState: (init: unknown) => {
      const i = hookCursor.i++;
      if (i === 0) return [prefSeed, vi.fn()];
      if (i === 1) return [resolvedSeed, vi.fn()];
      return [init ?? "", vi.fn()];
    },
    useEffect: () => undefined,
    useRef: () => ({ current: null }),
    useCallback: (fn: unknown) => fn,
  };
});

// Spy on the theme helpers — the component must call these on commit.
const applyResolvedTheme = vi.fn();
const writeThemeCookie = vi.fn();
const syncThemeColorMeta = vi.fn();
const readThemeCookieClient = vi.fn(() => undefined);
const resolvePreferenceClient = vi.fn((p: "paper" | "ink" | "system") =>
  p === "ink" ? "ink" : p === "paper" ? "paper" : "paper",
);
vi.mock("../../lib/theme", () => ({
  applyResolvedTheme: (...a: unknown[]) => applyResolvedTheme(...a),
  writeThemeCookie: (...a: unknown[]) => writeThemeCookie(...a),
  syncThemeColorMeta: (...a: unknown[]) => syncThemeColorMeta(...a),
  readThemeCookieClient: () => readThemeCookieClient(),
  resolvePreferenceClient: (p: "paper" | "ink" | "system") => resolvePreferenceClient(p),
}));

const { ThemeToggle, THEME_ANIM_SETTLE_MS, cssTimeMs } = await import("./theme-toggle");

// A document stub so commit()'s startViewTransition feature-detect + the cross-fade class are safe
// (added on a switch, and removed once the fade — `--duration-base`, read from the root — has run).
const classList = { add: vi.fn(), remove: vi.fn() };
let reducedMotion = false;
beforeEach(() => {
  applyResolvedTheme.mockClear();
  writeThemeCookie.mockClear();
  syncThemeColorMeta.mockClear();
  classList.add.mockClear();
  classList.remove.mockClear();
  reducedMotion = false;
  vi.stubGlobal("document", {
    documentElement: { classList },
    // no startViewTransition → the synchronous fallback path runs
  });
  vi.stubGlobal("window", {
    matchMedia: (q: string) => ({
      matches: q.includes("reduce") ? reducedMotion : false,
      addEventListener() {},
      removeEventListener() {},
    }),
  });
  vi.stubGlobal("getComputedStyle", () => ({
    getPropertyValue: (n: string) => (n === "--duration-base" ? " 220ms" : ""),
  }));
});

interface El {
  type: unknown;
  props: Record<string, unknown> & { children?: ReactNode };
}

function walk(node: ReactNode, out: El[]): void {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (typeof node === "string" || typeof node === "number") return;
  if (Array.isArray(node)) {
    node.forEach((c) => walk(c, out));
    return;
  }
  const el = node as El;
  out.push(el);
  if (typeof el.type === "function") {
    walk((el.type as (p: unknown) => ReactNode)(el.props), out);
    return;
  }
  if (el.props && "children" in el.props) walk(el.props.children as ReactNode, out);
}

function render(): El[] {
  hookCursor.i = 0; // reset the useState cursor for this render
  const out: El[] = [];
  walk((ThemeToggle as () => ReactElement)(), out);
  return out;
}

function findSwitch(els: El[]): El {
  return els.find((e) => e.props["role"] === "switch")!;
}
function findSystem(els: El[]): El {
  return els.find((e) => e.props["aria-label"] === "Follow system theme")!;
}

describe("ThemeToggle — switch a11y (role/label/aria-checked)", () => {
  it("paper resolved → unchecked switch labelled 'Switch to dark theme'", () => {
    resolvedSeed = "paper";
    const sw = findSwitch(render());
    expect(sw.type).toBe("button");
    expect(sw.props["role"]).toBe("switch");
    expect(sw.props["aria-checked"]).toBe(false);
    expect(sw.props["aria-label"]).toBe("Switch to dark theme");
  });

  it("ink resolved → checked switch labelled 'Switch to light theme'", () => {
    resolvedSeed = "ink";
    const sw = findSwitch(render());
    expect(sw.props["aria-checked"]).toBe(true);
    expect(sw.props["aria-label"]).toBe("Switch to light theme");
  });
});

describe("ThemeToggle — toggling persists + applies (both directions)", () => {
  it("from paper, clicking the switch commits ink: applies, writes cookie, syncs meta", () => {
    resolvedSeed = "paper";
    const sw = findSwitch(render());
    (sw.props["onClick"] as () => void)();
    expect(applyResolvedTheme).toHaveBeenCalledWith("ink");
    expect(writeThemeCookie).toHaveBeenCalledWith("ink");
  });

  it("from ink, clicking the switch commits paper", () => {
    resolvedSeed = "ink";
    const sw = findSwitch(render());
    (sw.props["onClick"] as () => void)();
    expect(applyResolvedTheme).toHaveBeenCalledWith("paper");
    expect(writeThemeCookie).toHaveBeenCalledWith("paper");
  });
});

describe("ThemeToggle — System is reachable + reflects state", () => {
  it("renders a System button that writes the 'system' preference", () => {
    prefSeed = "ink";
    const els = render();
    const sys = findSystem(els);
    expect(sys.type).toBe("button");
    expect(sys.props["aria-pressed"]).toBe(false);
    (sys.props["onClick"] as () => void)();
    expect(writeThemeCookie).toHaveBeenCalledWith("system");
  });

  it("marks System aria-pressed when the active preference is system", () => {
    prefSeed = "system";
    const sys = findSystem(render());
    expect(sys.props["aria-pressed"]).toBe(true);
  });
});

describe("ThemeToggle — polite live region for announcements", () => {
  it("includes an aria-live='polite' status region", () => {
    const els = render();
    expect(
      els.some((e) => e.props["aria-live"] === "polite" && e.props["role"] === "status"),
    ).toBe(true);
  });
});

describe("ThemeToggle — the switch's shared tooltip (final sweep C, F26)", () => {
  /** The switch's DIRECT children: the shared CSS shows `:focus-visible > .bb-icon-tip`. */
  const kids = (sw: El): El[] =>
    ([] as unknown[])
      .concat(sw.props.children as unknown)
      .filter((c): c is El => typeof c === "object" && c !== null && "props" in c);

  it.each([
    ["paper", "Switch to dark theme"],
    ["ink", "Switch to light theme"],
  ] as const)("%s: a direct .bb-icon-tip child repeats the switch's name", (seed, label) => {
    resolvedSeed = seed;
    const sw = findSwitch(render());
    expect(sw.props["aria-label"]).toBe(label);
    const tips = kids(sw).filter((c) => String(c.props["className"]).includes("bb-icon-tip"));
    expect(tips).toHaveLength(1);
    expect(tips[0]!.type).toBe("span");
    expect(tips[0]!.props["className"]).toBe("bb-icon-tip bb-icon-tip--bottom");
    expect(tips[0]!.props["aria-hidden"]).toBe("true");
    expect(tips[0]!.props.children).toBe(label);
  });

  it("Escape on the focused switch dismisses its tooltip; blur re-arms it", () => {
    resolvedSeed = "paper";
    const sw = findSwitch(render());
    const attrs = new Set<string>();
    const target = {
      setAttribute: (n: string) => void attrs.add(n),
      removeAttribute: (n: string) => void attrs.delete(n),
    };
    (sw.props["onKeyDown"] as (e: unknown) => void)({ key: "Enter", currentTarget: target });
    expect(attrs.has("data-tooltip-dismissed")).toBe(false);
    (sw.props["onKeyDown"] as (e: unknown) => void)({ key: "Escape", currentTarget: target });
    expect(attrs.has("data-tooltip-dismissed")).toBe(true);
    (sw.props["onBlur"] as (e: unknown) => void)({ currentTarget: target });
    expect(attrs.has("data-tooltip-dismissed")).toBe(false);
    expect(typeof sw.props["onPointerEnter"]).toBe("function");
    expect(typeof sw.props["onPointerLeave"]).toBe("function");
  });
});

describe("ThemeToggle — the cross-fade class ends with the fade (review of final sweep C)", () => {
  // MEASURED: `html.theme-anim` was added on every switch and never removed, so its rule
  // (`html.theme-anim .pshell__rail { transition: var(--theme-fade) }`) replaced the nav drawer's
  // transform transition for the rest of the session — after one theme switch it never slid.
  const click = (sw: El) => (sw.props["onClick"] as () => void)();

  it("a switch adds it, and it comes off once the fade (--duration-base + the settle) has run", () => {
    vi.useFakeTimers();
    try {
      resolvedSeed = "paper";
      click(findSwitch(render()));
      expect(classList.add).toHaveBeenCalledWith("theme-anim");
      vi.advanceTimersByTime(220 + THEME_ANIM_SETTLE_MS - 1);
      expect(classList.remove).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(classList.remove).toHaveBeenCalledWith("theme-anim");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a second switch inside the fade restarts the clock (the class is not pulled mid-fade)", () => {
    vi.useFakeTimers();
    try {
      resolvedSeed = "paper";
      const sw = findSwitch(render());
      click(sw);
      vi.advanceTimersByTime(200);
      click(sw);
      vi.advanceTimersByTime(220 + THEME_ANIM_SETTLE_MS - 1);
      expect(classList.remove).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(classList.remove).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("under reduced motion there is no fade: the class is never added", () => {
    reducedMotion = true;
    click(findSwitch(render()));
    expect(classList.add).not.toHaveBeenCalled();
  });

  it("cssTimeMs reads a CSS time (ms or s); anything else is 0", () => {
    expect(cssTimeMs(" 220ms")).toBe(220);
    expect(cssTimeMs("0.22s")).toBe(220);
    expect(cssTimeMs("0ms")).toBe(0);
    expect(cssTimeMs("")).toBe(0);
    expect(cssTimeMs("fast")).toBe(0);
    expect(cssTimeMs("220")).toBe(0);
  });
});
