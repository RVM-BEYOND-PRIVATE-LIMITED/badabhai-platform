import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ReactModule from "react";
import { TOOLTIP_DISMISSED_ATTRIBUTE } from "@badabhai/icons";

/**
 * useIconTipHandlers — the shared tooltip's Escape / re-arm wiring for a control that keeps its
 * own markup (the theme switch). The helpers it composes are tested in packages/icons; this pins
 * the WIRING: which handler arms and disarms what, and that an unmount mid-hover leaks nothing.
 *
 * Hooks are stubbed (node env, no renderer): one persistent ref per call site, and the effect's
 * cleanup captured so the test can "unmount".
 */
const refs: { current: unknown }[] = [];
const cleanups: (() => void)[] = [];
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof ReactModule>("react");
  return {
    ...actual,
    useRef: (init: unknown) => {
      const r = { current: init };
      refs.push(r);
      return r;
    },
    useEffect: (fn: () => void | (() => void)) => {
      const c = fn();
      if (typeof c === "function") cleanups.push(c);
    },
  };
});

const { useIconTipHandlers } = await import("./icon-tip");

/** A control in a document: records its attributes and the document's keydown listeners. */
function control() {
  const attrs = new Set<string>();
  const listeners = new Set<(e: Event) => void>();
  const el = {
    isConnected: true,
    setAttribute: (n: string) => void attrs.add(n),
    removeAttribute: (n: string) => void attrs.delete(n),
    ownerDocument: {
      addEventListener: (_t: string, fn: (e: Event) => void) => void listeners.add(fn),
      removeEventListener: (_t: string, fn: (e: Event) => void) => void listeners.delete(fn),
    },
  };
  const pressOnDocument = (key: string) => {
    for (const fn of listeners) fn({ key } as unknown as Event);
  };
  return { el, attrs, listeners, pressOnDocument };
}
const ev = (currentTarget: unknown, extra: Record<string, unknown> = {}) =>
  ({ currentTarget, ...extra }) as never;

beforeEach(() => {
  refs.length = 0;
  cleanups.length = 0;
});

describe("useIconTipHandlers", () => {
  it("Escape on the focused control dismisses; any other key does not; blur re-arms", () => {
    const h = useIconTipHandlers();
    const c = control();
    h.onKeyDown(ev(c.el, { key: "Tab" }));
    expect(c.attrs.has(TOOLTIP_DISMISSED_ATTRIBUTE)).toBe(false);
    h.onKeyDown(ev(c.el, { key: "Escape" }));
    expect(c.attrs.has(TOOLTIP_DISMISSED_ATTRIBUTE)).toBe(true);
    h.onBlur(ev(c.el));
    expect(c.attrs.has(TOOLTIP_DISMISSED_ATTRIBUTE)).toBe(false);
  });

  it("hover arms ONE document Escape listener; leave removes it and re-arms the tooltip", () => {
    const h = useIconTipHandlers();
    const c = control();
    h.onPointerEnter(ev(c.el));
    h.onPointerEnter(ev(c.el)); // a second enter replaces, never stacks
    expect(c.listeners.size).toBe(1);
    c.pressOnDocument("Escape");
    expect(c.attrs.has(TOOLTIP_DISMISSED_ATTRIBUTE)).toBe(true);
    h.onPointerLeave(ev(c.el));
    expect(c.listeners.size).toBe(0);
    expect(c.attrs.has(TOOLTIP_DISMISSED_ATTRIBUTE)).toBe(false);
  });

  it("unmounting mid-hover removes the document listener (no leak)", () => {
    const h = useIconTipHandlers();
    const c = control();
    h.onPointerEnter(ev(c.el));
    expect(c.listeners.size).toBe(1);
    expect(cleanups).toHaveLength(1);
    cleanups[0]!();
    expect(c.listeners.size).toBe(0);
  });
});
