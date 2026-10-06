import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TOOLTIP_DISMISSED_ATTRIBUTE,
  dismissTooltipOnEscape,
  focusWithoutTooltip,
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

describe("focusWithoutTooltip — focus the APP moves never opens a tooltip", () => {
  /**
   * A focus target: its children's classes, its attributes, and the ORDER of what happened. It
   * takes focus (becomes its document's activeElement) unless `focusable` is false — a control
   * that is `display: none` right now.
   */
  function target(childClasses: string[][], { focusable = true } = {}) {
    const log: string[] = [];
    const attrs = new Set<string>();
    const ownerDocument = { activeElement: null as unknown };
    const t = {
      log,
      attrs,
      ownerDocument,
      children: childClasses.map((cls) => ({
        classList: { contains: (c: string) => cls.includes(c) },
      })),
      setAttribute: (k: string) => void (attrs.add(k), log.push(`set ${k}`)),
      removeAttribute: (k: string) => void (attrs.delete(k), log.push(`remove ${k}`)),
      focus: (options?: FocusOptions) => {
        log.push(
          `focus (dismissed=${attrs.has(TOOLTIP_DISMISSED_ATTRIBUTE)}${options?.preventScroll ? ", preventScroll" : ""})`,
        );
        if (focusable) ownerDocument.activeElement = t;
      },
    };
    return t;
  }
  const TIP = [
    ["ph-fill", "ph-x"],
    ["bb-icon-tip", "bb-icon-tip--bottom-end"],
  ];

  it("an icon-only control is focused with its tooltip ALREADY dismissed (set before focus)", () => {
    const t = target(TIP);
    focusWithoutTooltip(t);
    expect(t.log).toEqual([`set ${TOOLTIP_DISMISSED_ATTRIBUTE}`, "focus (dismissed=true)"]);
    expect(t.attrs.has(TOOLTIP_DISMISSED_ATTRIBUTE)).toBe(true);
  });

  it("…and its own blur re-arms it, so moving away and back shows it again", () => {
    // Object.assign, not a spread: the stand-in's `dismissed` is a live getter.
    const doc = new FakeDocument();
    const c = Object.assign(fakeControl(doc), {
      children: [{ classList: { contains: (k: string) => k === "bb-icon-tip" } }],
      focus: () => void (doc.activeElement = c),
    });
    focusWithoutTooltip(c);
    expect(c.dismissed).toBe(true);
    restoreTooltip(c);
    expect(c.dismissed).toBe(false);
  });

  it("a focus that does not take (display:none) takes the flag back — it would never be cleared", () => {
    // Measured: the drawer open at 900px, the window widened past 1024px, then Escape — focus went
    // to the menu button, now display:none; the flag stayed, and back below 1024px its tooltip
    // never showed again.
    const t = target(TIP, { focusable: false });
    focusWithoutTooltip(t);
    expect(t.log).toEqual([
      `set ${TOOLTIP_DISMISSED_ATTRIBUTE}`,
      "focus (dismissed=true)",
      `remove ${TOOLTIP_DISMISSED_ATTRIBUTE}`,
    ]);
    expect(t.attrs.size).toBe(0);
  });

  it("passes focus options through (preventScroll for a control sliding in from off-screen)", () => {
    const t = target(TIP);
    focusWithoutTooltip(t, { preventScroll: true });
    expect(t.log).toContain("focus (dismissed=true, preventScroll)");
  });

  it("a target without a tooltip (a plain button, the dialog itself) is focused untouched", () => {
    for (const kids of [[], [["ph-fill", "ph-x"]], [["bb-icon-tip-ish"]]]) {
      for (const focusable of [true, false]) {
        const t = target(kids, { focusable });
        focusWithoutTooltip(t);
        expect(t.log).toEqual(["focus (dismissed=false)"]);
        expect(t.attrs.size).toBe(0);
      }
    }
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
    // The fake dispatches on the document itself, where a capture listener's stopPropagation()
    // cannot block a sibling listener — so check the flag directly: in a real page it would keep
    // the key from the drawer's `window` listener.
    expect(event.cancelBubble).toBe(false);
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
