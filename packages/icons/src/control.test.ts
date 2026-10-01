import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TOOLTIP_DISMISSED_ATTRIBUTE,
  dismissTooltipOnEscape,
  restoreTooltip,
  warnIfUnlabelled,
  watchEscapeWhileHovered,
} from "./control";
import { FakeDocument, fakeControl } from "./test-doubles";

describe("tooltip dismissal (WCAG 1.4.13 — dismissible without moving focus)", () => {
  it("the attribute the tooltip CSS keys on is pinned", () => {
    expect(TOOLTIP_DISMISSED_ATTRIBUTE).toBe("data-tooltip-dismissed");
  });

  it("Escape marks the control dismissed", () => {
    const c = fakeControl(new FakeDocument());
    expect(dismissTooltipOnEscape(c, "Escape")).toBe(true);
    expect(c.attrs.has(TOOLTIP_DISMISSED_ATTRIBUTE)).toBe(true);
  });

  it("any other key leaves the tooltip alone (Enter/Space activate; Tab moves on)", () => {
    for (const key of ["Enter", " ", "Tab", "Esc", "escape"]) {
      const c = fakeControl(new FakeDocument());
      expect(dismissTooltipOnEscape(c, key)).toBe(false);
      expect(c.attrs.size).toBe(0);
    }
  });

  it("blur / pointer-leave re-arms it for the next hover or focus", () => {
    const c = fakeControl(new FakeDocument());
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

describe("watchEscapeWhileHovered — Escape for a HOVER-opened tooltip (focus is elsewhere)", () => {
  it("listens on the control's document, so Escape pressed anywhere dismisses", () => {
    const doc = new FakeDocument();
    const control = fakeControl(doc);
    const stop = watchEscapeWhileHovered(control);
    expect(doc.keydownListeners).toBe(1);
    doc.pressKey("Enter");
    expect(control.dismissed).toBe(false);
    doc.pressKey("Escape");
    expect(control.dismissed).toBe(true);
    stop();
  });

  it("never swallows the key — a drawer's own Escape listener still runs", () => {
    const doc = new FakeDocument();
    const stop = watchEscapeWhileHovered(fakeControl(doc));
    let drawerSaw = false;
    doc.addEventListener("keydown", () => (drawerSaw = true));
    const event = doc.pressKey("Escape");
    expect(drawerSaw).toBe(true);
    expect(event.defaultPrevented).toBe(false);
    stop();
  });

  it("stop() removes the listener (no leak) and is idempotent", () => {
    const doc = new FakeDocument();
    const control = fakeControl(doc);
    const stop = watchEscapeWhileHovered(control);
    stop();
    stop();
    expect(doc.keydownListeners).toBe(0);
    doc.pressKey("Escape");
    expect(control.dismissed).toBe(false);
  });

  it("a control removed from the document drops its listener on the next keydown", () => {
    const doc = new FakeDocument();
    const control = fakeControl(doc);
    watchEscapeWhileHovered(control);
    control.isConnected = false;
    doc.pressKey("a");
    expect(doc.keydownListeners).toBe(0);
    expect(control.dismissed).toBe(false);
  });
});
