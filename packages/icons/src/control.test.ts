import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TOOLTIP_DISMISSED_ATTRIBUTE,
  dismissTooltipOnEscape,
  restoreTooltip,
  warnIfUnlabelled,
} from "./control";

/** A stand-in for the `<button>` — the helpers only ever touch these two methods. */
function fakeControl() {
  const attrs = new Map<string, string>();
  return {
    attrs,
    setAttribute: (k: string, v: string) => void attrs.set(k, v),
    removeAttribute: (k: string) => void attrs.delete(k),
  };
}

describe("tooltip dismissal (WCAG 1.4.13 — dismissible without moving focus)", () => {
  it("the attribute both apps' CSS keys on is pinned", () => {
    expect(TOOLTIP_DISMISSED_ATTRIBUTE).toBe("data-tooltip-dismissed");
  });

  it("Escape marks the control dismissed", () => {
    const c = fakeControl();
    expect(dismissTooltipOnEscape(c, "Escape")).toBe(true);
    expect(c.attrs.has(TOOLTIP_DISMISSED_ATTRIBUTE)).toBe(true);
  });

  it("any other key leaves the tooltip alone (Enter/Space activate; Tab moves on)", () => {
    for (const key of ["Enter", " ", "Tab", "Esc", "escape"]) {
      const c = fakeControl();
      expect(dismissTooltipOnEscape(c, key)).toBe(false);
      expect(c.attrs.size).toBe(0);
    }
  });

  it("blur / pointer-leave re-arms it for the next hover or focus", () => {
    const c = fakeControl();
    dismissTooltipOnEscape(c, "Escape");
    restoreTooltip(c);
    expect(c.attrs.has(TOOLTIP_DISMISSED_ATTRIBUTE)).toBe(false);
  });
});

describe("warnIfUnlabelled", () => {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  afterEach(() => {
    spy.mockClear();
    vi.unstubAllEnvs();
  });

  it("flags an empty or blank label", () => {
    warnIfUnlabelled("", "IconButton");
    warnIfUnlabelled("   ", "IconButton");
    expect(spy).toHaveBeenCalledTimes(2);
    expect(String(spy.mock.calls[0]![0])).toContain("IconButton");
  });

  it("is silent for a real label", () => {
    warnIfUnlabelled("Navigation", "IconButton");
    expect(spy).not.toHaveBeenCalled();
  });

  it("is a no-op in production builds", () => {
    vi.stubEnv("NODE_ENV", "production");
    warnIfUnlabelled("", "IconButton");
    expect(spy).not.toHaveBeenCalled();
  });
});
