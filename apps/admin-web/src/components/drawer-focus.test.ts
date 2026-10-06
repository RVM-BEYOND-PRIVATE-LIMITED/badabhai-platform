import { describe, expect, it, vi } from "vitest";
import { focusableIn, holdFocusInDrawer, trapTab, type Focusable } from "./drawer-focus";

/**
 * Keyboard behaviour of the navigation drawer below 1024px (final sweep AW-04). Measured before:
 * Tab 2-16 walked 15 off-screen drawer controls, and once the drawer was open the next Tabs
 * went to the page BEHIND the scrim — the drawer's links were reachable only with Shift+Tab.
 *
 * The node env has no DOM, so the drawer, its controls and the key target are stand-ins with
 * exactly the surface the helper uses. (The closed drawer leaving the tab order is CSS —
 * `visibility: hidden` — pinned in a11y-foundations.css.test.ts.)
 */
type Control = Focusable & { name: string; focus: ReturnType<typeof vi.fn> };

function control(name: string, opts: { tabIndex?: number; rendered?: boolean } = {}): Control {
  return {
    name,
    tabIndex: opts.tabIndex ?? 0,
    focus: vi.fn(),
    getClientRects: () => ({ length: opts.rendered === false ? 0 : 1 }),
  };
}

function drawer(controls: Control[]) {
  return {
    selectors: [] as string[],
    querySelectorAll(selector: string) {
      this.selectors.push(selector);
      return controls;
    },
  };
}

/** A keydown carrying `key` (Node has no KeyboardEvent). */
function keydown(key: string, shiftKey = false): Event {
  const e = new Event("keydown", { cancelable: true });
  Object.defineProperties(e, { key: { value: key }, shiftKey: { value: shiftKey } });
  return e;
}

describe("trapTab — where Tab goes from the drawer's edges", () => {
  const [a, b, c] = ["a", "b", "c"];
  const all = [a, b, c];

  it("Tab on the last control wraps to the first", () => {
    expect(trapTab(all, c, false)).toBe(a);
  });

  it("Shift+Tab on the first control wraps to the last", () => {
    expect(trapTab(all, a, true)).toBe(c);
  });

  it("inside the run, the browser moves focus itself", () => {
    expect(trapTab(all, b, false)).toBeNull();
    expect(trapTab(all, b, true)).toBeNull();
    expect(trapTab(all, a, false)).toBeNull();
    expect(trapTab(all, c, true)).toBeNull();
  });

  it("focus that has left the drawer is brought back to its start (or end, going back)", () => {
    expect(trapTab(all, "behind the scrim", false)).toBe(a);
    expect(trapTab(all, null, true)).toBe(c);
  });

  it("an empty drawer traps nothing", () => {
    expect(trapTab([], a, false)).toBeNull();
  });
});

describe("focusableIn — the drawer's Tab stops", () => {
  it("skips controls that are out of the tab order or not rendered", () => {
    const keep = control("Dashboard");
    const root = drawer([
      keep,
      control("tabindex -1", { tabIndex: -1 }),
      control("display none", { rendered: false }),
    ]);
    expect(focusableIn(root).map((c) => c.name)).toEqual(["Dashboard"]);
  });

  it("asks for every kind of control, enabled only", () => {
    const root = drawer([]);
    focusableIn(root);
    const selector = root.selectors[0]!;
    for (const part of [
      "a[href]",
      "button:not([disabled])",
      "select:not([disabled])",
      "[tabindex]",
    ]) {
      expect(selector).toContain(part);
    }
  });
});

describe("holdFocusInDrawer — an open drawer holds the keyboard", () => {
  function open() {
    const first = control("Dashboard");
    const middle = control("Events");
    const last = control("Sign out");
    const keys = new EventTarget();
    let active: unknown = null;
    const onClose = vi.fn();
    const release = holdFocusInDrawer({
      drawer: drawer([first, middle, last]),
      keyTarget: keys,
      activeElement: () => active,
      onClose,
    });
    return {
      first,
      middle,
      last,
      keys,
      onClose,
      release,
      setActive: (el: unknown) => (active = el),
    };
  }

  it("moves focus to the drawer's first control when it opens", () => {
    const { first } = open();
    expect(first.focus).toHaveBeenCalledTimes(1);
  });

  it("Tab from the last control wraps to the first, and the browser's move is cancelled", () => {
    const { first, last, keys, setActive } = open();
    first.focus.mockClear();
    setActive(last);
    const e = keydown("Tab");
    keys.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(first.focus).toHaveBeenCalledTimes(1);
  });

  it("Shift+Tab from the first control wraps to the last", () => {
    const { first, last, keys, setActive } = open();
    setActive(first);
    const e = keydown("Tab", true);
    keys.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(last.focus).toHaveBeenCalledTimes(1);
  });

  it("Tab between two drawer controls is left to the browser", () => {
    const { middle, keys, setActive } = open();
    setActive(middle);
    const e = keydown("Tab");
    keys.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });

  it("Escape closes it (the existing behaviour)", () => {
    const { keys, onClose } = open();
    keys.dispatchEvent(keydown("Escape"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("other keys pass through untouched", () => {
    const { keys, onClose } = open();
    const e = keydown("Enter");
    keys.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("releasing it removes the listener — a closed drawer no longer reacts", () => {
    const { keys, onClose, release, first, last, setActive } = open();
    release();
    keys.dispatchEvent(keydown("Escape"));
    setActive(last);
    first.focus.mockClear();
    const e = keydown("Tab");
    keys.dispatchEvent(e);
    expect(onClose).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
    expect(first.focus).not.toHaveBeenCalled();
  });
});
