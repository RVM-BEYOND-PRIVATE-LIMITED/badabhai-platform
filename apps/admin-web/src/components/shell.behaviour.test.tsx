import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ReactModule from "react";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The portal shell's drawer, wired (final sweep AW-04). The node env cannot mount React, so the
 * hooks are recorders: `useState` hands back the drawer state under test, `useRef` the drawer
 * stand-in, and `useEffect` collects each effect with its dependency list so a test can run
 * the ones it is about. `window` / `document` are stand-ins with exactly the surface the shell
 * touches. The helper's own key handling is covered in drawer-focus.test.ts.
 */
type Effect = { run: () => void | (() => void); deps: readonly unknown[] | undefined };

const hooks = vi.hoisted(() => ({
  open: false,
  setOpen: vi.fn(),
  effects: [] as Effect[],
  drawer: null as unknown,
  pathname: "/jobs",
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
    useState: () => [hooks.open, hooks.setOpen],
    useRef: () => ({ current: hooks.drawer }),
    useEffect: (run: Effect["run"], deps?: readonly unknown[]) => {
      hooks.effects.push({ run, deps });
    },
  };
});
vi.mock("next/navigation", () => ({ usePathname: () => hooks.pathname }));

const { Shell, MENU_TOGGLE_ID } = await import("./shell");

const props = {
  sections: [],
  roleLabel: "Ops admin",
  adminId: "a1b2c3d4-0000-4000-8000-000000000001",
  onSignOut: null,
  children: <p>content</p>,
};

/** A drawer control stand-in. */
const control = () => ({ tabIndex: 0, focus: vi.fn(), getClientRects: () => ({ length: 1 }) });

let keys: EventTarget;
let toggle: {
  focus: ReturnType<typeof vi.fn>;
  drawn: boolean;
  getClientRects: () => { length: number };
};
let firstLink: ReturnType<typeof control>;

beforeEach(() => {
  hooks.effects = [];
  hooks.setOpen.mockReset();
  firstLink = control();
  hooks.drawer = { querySelectorAll: () => [firstLink, control()] };
  keys = new EventTarget();
  toggle = {
    focus: vi.fn(),
    drawn: true,
    getClientRects() {
      return { length: this.drawn ? 1 : 0 };
    },
  };
  vi.stubGlobal("window", keys);
  vi.stubGlobal("document", {
    activeElement: null,
    getElementById: (id: string) => (id === MENU_TOGGLE_ID ? toggle : null),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Run every effect the shell registered, as a mount would; returns the cleanups. */
function mount(open: boolean): Array<() => void> {
  hooks.open = open;
  hooks.effects = [];
  Shell(props);
  return hooks.effects.map((e) => e.run()).filter((c): c is () => void => typeof c === "function");
}

describe("the open drawer holds focus (AW-04)", () => {
  it("opening moves focus to the drawer's first control", () => {
    mount(true);
    expect(firstLink.focus).toHaveBeenCalledTimes(1);
  });

  it("Escape still closes it", () => {
    mount(true);
    hooks.setOpen.mockClear();
    keys.dispatchEvent(Object.defineProperty(new Event("keydown"), "key", { value: "Escape" }));
    expect(hooks.setOpen).toHaveBeenCalledWith(false);
  });

  it("closing hands focus back to the menu toggle", () => {
    const cleanups = mount(true);
    expect(toggle.focus).not.toHaveBeenCalled();
    cleanups.forEach((c) => c());
    expect(toggle.focus).toHaveBeenCalledTimes(1);
  });

  it("a closed drawer neither takes focus nor listens for keys", () => {
    mount(false);
    expect(firstLink.focus).not.toHaveBeenCalled();
    hooks.setOpen.mockClear();
    keys.dispatchEvent(Object.defineProperty(new Event("keydown"), "key", { value: "Escape" }));
    expect(hooks.setOpen).not.toHaveBeenCalled();
  });
});

describe("the drawer closes when it stops making sense", () => {
  it("navigating (a drawer link was followed) closes it", () => {
    mount(true);
    const onPath = hooks.effects.find((e) => e.deps?.includes(hooks.pathname));
    expect(onPath, "an effect keyed on the pathname").toBeDefined();
    hooks.setOpen.mockClear();
    onPath!.run();
    expect(hooks.setOpen).toHaveBeenCalledWith(false);
  });

  it("widening past the drawer breakpoint closes it, so the page is never left inert", () => {
    // Drawer mode is read off the stylesheet: above the breakpoint the toggle is not drawn.
    mount(true);
    hooks.setOpen.mockClear();
    toggle.drawn = false;
    keys.dispatchEvent(new Event("resize"));
    expect(hooks.setOpen).toHaveBeenCalledWith(false);
  });

  it("a resize that stays in drawer mode leaves it open", () => {
    mount(true);
    hooks.setOpen.mockClear();
    toggle.drawn = true;
    keys.dispatchEvent(new Event("resize"));
    expect(hooks.setOpen).not.toHaveBeenCalled();
  });
});

describe("what the open drawer renders", () => {
  const render = (open: boolean) => {
    hooks.open = open;
    hooks.drawer = null;
    return renderToStaticMarkup(<Shell {...props} />);
  };

  it("the page behind the scrim is inert while the drawer is open — and only then", () => {
    expect(render(true)).toContain('<div class="shell__main" inert="">');
    expect(render(false)).toContain('<div class="shell__main">');
  });

  it("the scrim is a pointer target, never a Tab stop (its focus ring would be off-screen)", () => {
    for (const open of [true, false]) {
      const out = render(open);
      const scrim = out.slice(out.lastIndexOf("<button", out.indexOf("shell__scrim")));
      expect(scrim.slice(0, scrim.indexOf(">"))).toContain('tabindex="-1"');
    }
  });

  it("the toggle carries the id focus returns to, and keeps its name and state", () => {
    const out = render(true);
    const start = out.indexOf(`id="${MENU_TOGGLE_ID}"`);
    expect(start).toBeGreaterThanOrEqual(0);
    const tag = out.slice(out.lastIndexOf("<button", start), out.indexOf(">", start));
    expect(tag).toContain('aria-label="Navigation"');
    expect(tag).toContain('aria-expanded="true"');
    expect(tag).toContain('aria-controls="portal-sidebar"');
  });

  it("the function form returns the open shell class (sanity: the mock reaches the shell)", () => {
    hooks.open = true;
    const el = Shell(props) as ReactElement<{ className: string }>;
    expect(el.props.className).toBe("shell shell--drawer-open");
  });
});
