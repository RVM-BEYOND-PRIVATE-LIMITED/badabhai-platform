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

const { ThemeToggle } = await import("./theme-toggle");

// A document stub so commit()'s startViewTransition feature-detect + classList.add are safe.
beforeEach(() => {
  applyResolvedTheme.mockClear();
  writeThemeCookie.mockClear();
  syncThemeColorMeta.mockClear();
  vi.stubGlobal("document", {
    documentElement: { classList: { add: vi.fn() } },
    // no startViewTransition → the synchronous fallback path runs
  });
  vi.stubGlobal("window", {
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
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
