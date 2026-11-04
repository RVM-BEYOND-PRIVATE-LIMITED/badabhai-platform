import { describe, expect, it, vi } from "vitest";
import { holdFocus } from "./overlay-focus";
import type { Focusable } from "./drawer-focus";

/**
 * A5 (#2575) — the keyboard contract of every Dialog and Drawer: focus is trapped inside, Escape
 * closes, and focus returns to the trigger. The node env has no DOM, so the panel, its controls,
 * the trigger and the key target are stand-ins with exactly the surface the helper uses.
 */
type Control = Focusable & { name: string; focus: ReturnType<typeof vi.fn> };

const control = (name: string): Control => ({
  name,
  tabIndex: 0,
  focus: vi.fn(),
  getClientRects: () => ({ length: 1 }),
});

function setup(controls: Control[], opts: { initial?: Control; returnTo?: Control } = {}) {
  const panel = { focus: vi.fn(), querySelectorAll: () => controls };
  const keyTarget = new EventTarget();
  let active: unknown = null;
  const onEscape = vi.fn();
  const release = holdFocus({
    container: panel,
    keyTarget,
    activeElement: () => active,
    onEscape,
    initial: opts.initial,
    returnTo: opts.returnTo,
  });
  const press = (key: string, shiftKey = false) => {
    const e = new Event("keydown", { cancelable: true });
    Object.defineProperties(e, { key: { value: key }, shiftKey: { value: shiftKey } });
    keyTarget.dispatchEvent(e);
    return e;
  };
  return { panel, onEscape, release, press, focusOn: (c: unknown) => (active = c) };
}

describe("holdFocus — where focus starts", () => {
  it("on the panel's first control by default", () => {
    const [close, cancel] = [control("close"), control("cancel")];
    setup([close, cancel]);
    expect(close.focus).toHaveBeenCalledTimes(1);
    expect(cancel.focus).not.toHaveBeenCalled();
  });

  it("on `initial` when given — a T3 confirm starts on Cancel", () => {
    const [close, cancel, confirm] = [control("close"), control("cancel"), control("confirm")];
    setup([close, cancel, confirm], { initial: cancel });
    expect(cancel.focus).toHaveBeenCalledTimes(1);
    expect(close.focus).not.toHaveBeenCalled();
    expect(confirm.focus).not.toHaveBeenCalled();
  });

  it("on the panel itself when it holds no control", () => {
    const { panel } = setup([]);
    expect(panel.focus).toHaveBeenCalledTimes(1);
  });
});

describe("holdFocus — focus is trapped", () => {
  it("Tab on the last control wraps to the first, Shift+Tab on the first to the last", () => {
    const [a, b, c] = [control("a"), control("b"), control("c")];
    const t = setup([a, b, c]);
    a.focus.mockClear();
    t.focusOn(c);
    expect(t.press("Tab").defaultPrevented).toBe(true);
    expect(a.focus).toHaveBeenCalledTimes(1);
    t.focusOn(a);
    expect(t.press("Tab", true).defaultPrevented).toBe(true);
    expect(c.focus).toHaveBeenCalledTimes(1);
  });

  it("focus that escaped the panel is brought back inside", () => {
    const [a, b] = [control("a"), control("b")];
    const t = setup([a, b]);
    a.focus.mockClear();
    t.focusOn({ outside: true });
    expect(t.press("Tab").defaultPrevented).toBe(true);
    expect(a.focus).toHaveBeenCalledTimes(1);
  });

  it("inside the run, the browser moves focus itself", () => {
    const [a, b, c] = [control("a"), control("b"), control("c")];
    const t = setup([a, b, c]);
    t.focusOn(b);
    expect(t.press("Tab").defaultPrevented).toBe(false);
  });
});

describe("holdFocus — Escape closes, and focus returns to the trigger", () => {
  it("Escape calls onEscape", () => {
    const t = setup([control("a")]);
    const e = t.press("Escape");
    expect(t.onEscape).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it("release focuses the trigger again and stops listening", () => {
    const trigger = control("trigger");
    const t = setup([control("a")], { returnTo: trigger });
    expect(trigger.focus).not.toHaveBeenCalled();
    t.release();
    expect(trigger.focus).toHaveBeenCalledTimes(1);
    t.press("Escape");
    expect(t.onEscape).not.toHaveBeenCalled();
  });
});

/**
 * A7 (#2577) — a confirm opens OVER the candidate drawer (the phone reveal's reason). Both holds
 * listen on the same window, so before this only one key press ever belonged to the top one:
 * Escape closed the drawer under the confirm as well, and every Tab inside the confirm was pulled
 * back into the drawer first.
 */
describe("holdFocus — stacked overlays: only the topmost answers a key", () => {
  function stacked() {
    const keyTarget = new EventTarget();
    let active: unknown = null;
    const hold = (controls: Control[]) => {
      const onEscape = vi.fn();
      const release = holdFocus({
        container: { focus: vi.fn(), querySelectorAll: () => controls },
        keyTarget,
        activeElement: () => active,
        onEscape,
      });
      return { onEscape, release };
    };
    const press = (key: string, shiftKey = false) => {
      const e = new Event("keydown", { cancelable: true });
      Object.defineProperties(e, { key: { value: key }, shiftKey: { value: shiftKey } });
      keyTarget.dispatchEvent(e);
      return e;
    };
    return { hold, press, focusOn: (c: unknown) => (active = c) };
  }

  it("Escape closes the confirm on top and leaves the drawer under it open", () => {
    const s = stacked();
    const drawer = s.hold([control("close"), control("reveal")]);
    const confirm = s.hold([control("cancel"), control("confirm")]);
    s.press("Escape");
    expect(confirm.onEscape).toHaveBeenCalledTimes(1);
    expect(drawer.onEscape).not.toHaveBeenCalled();
  });

  it("Tab wraps inside the confirm, never into the drawer beneath", () => {
    const s = stacked();
    const drawerFirst = control("drawer-close");
    s.hold([drawerFirst, control("reveal")]);
    const [cancel, confirm] = [control("cancel"), control("confirm")];
    s.hold([cancel, confirm]);
    drawerFirst.focus.mockClear();
    cancel.focus.mockClear();
    s.focusOn(confirm);
    expect(s.press("Tab").defaultPrevented).toBe(true);
    expect(cancel.focus).toHaveBeenCalledTimes(1);
    expect(drawerFirst.focus).not.toHaveBeenCalled();
    // Inside the confirm's run the browser moves focus itself — the drawer does not pull it.
    s.focusOn(cancel);
    expect(s.press("Tab").defaultPrevented).toBe(false);
    expect(drawerFirst.focus).not.toHaveBeenCalled();
  });

  it("once the confirm is released, the drawer answers again", () => {
    const s = stacked();
    const drawer = s.hold([control("close")]);
    const confirm = s.hold([control("cancel")]);
    confirm.release();
    s.press("Escape");
    expect(drawer.onEscape).toHaveBeenCalledTimes(1);
    expect(confirm.onEscape).not.toHaveBeenCalled();
    drawer.release();
  });

  it("releasing out of order (the drawer first) still leaves the confirm in charge", () => {
    const s = stacked();
    const drawer = s.hold([control("close")]);
    const confirm = s.hold([control("cancel")]);
    drawer.release();
    s.press("Escape");
    expect(confirm.onEscape).toHaveBeenCalledTimes(1);
    confirm.release();
  });
});
