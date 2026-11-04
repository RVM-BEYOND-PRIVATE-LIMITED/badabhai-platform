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
