import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "./forms";
import { Dialog, DIALOG_CLOSING_STATE, playExit } from "./dialog";
import { Tabs, placeTabsIndicator, TABS_INDICATOR_ATTR } from "./tabs";
import { Toast } from "./toast";
import { focusIsWithin, ToastProvider, TOAST_DURATION_MS } from "./toast-provider";
import { ToastTimers } from "./toast-timers";
import { countUpValue } from "./count-up";

/**
 * #2583 (W3) — tactile buttons, dialogs and toasts: the behaviour half (the stylesheet half is
 * src/app/w3-tactile.css.test.ts). Node env — markup through react-dom/server, the DOM-touching
 * helpers through stand-in elements.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Button — busy keeps its look and its width; disabled is the 40% step", () => {
  it("loading: aria-busy, clicks blocked, the label STILL rendered under the shared spinner", () => {
    const out = renderToStaticMarkup(
      <Button loading iconLeft="check">
        Buy Pack 50
      </Button>,
    );
    expect(out).toContain('aria-busy="true"');
    expect(out).toMatch(/<button[^>]*disabled/);
    // The label keeps its box (so the width never changes) — it fades, it is not removed.
    expect(out).toContain('<span class="bb-btn__label">');
    expect(out).toContain("Buy Pack 50");
    expect(out).toContain("ph-check");
    expect(out).toContain('<span class="bb-btn__spinner bb-spinner" aria-hidden="true"></span>');
  });

  it("idle: no aria-busy and no spinner; the label row is the same element", () => {
    const out = renderToStaticMarkup(<Button iconRight="arrow-right">Next</Button>);
    expect(out).not.toContain("aria-busy");
    expect(out).not.toContain("bb-spinner");
    expect(out).toContain('<span class="bb-btn__label">');
  });
});

describe("Dialog — the title is an h2", () => {
  it("renders its title as h2.bb-dialog__title, labelling the dialog", () => {
    const out = renderToStaticMarkup(<Dialog open title="Add credits?" onClose={() => {}} />);
    expect(out).toMatch(/<h2 class="bb-dialog__title" id="([^"]+)">Add credits\?<\/h2>/);
    expect(out).not.toContain("<h3");
  });
});

/** A stand-in scrim whose clone records what is done to it. */
function standInScrim(animationName: string) {
  const body = { appended: [] as unknown[], appendChild: (n: unknown) => body.appended.push(n) };
  const box = { listeners: [] as string[], addEventListener: (t: string) => box.listeners.push(t) };
  const ghost = {
    attrs: {} as Record<string, string>,
    inert: false,
    removed: 0,
    setAttribute(k: string, v: string) {
      this.attrs[k] = v;
    },
    removeAttribute(k: string) {
      delete this.attrs[k];
    },
    querySelector: () => box,
    remove() {
      this.removed += 1;
    },
  };
  const scrim = { ownerDocument: { body }, cloneNode: () => ghost };
  vi.stubGlobal("window", {
    matchMedia: (q: string) => ({ matches: q.includes("reduce") && animationName === "REDUCED" }),
    getComputedStyle: () => ({ animationName }),
    setTimeout: () => 0,
  });
  return { scrim: scrim as unknown as Element, body, ghost, box };
}

describe("Dialog — exit animation on an inert snapshot (never under reduced motion)", () => {
  it("plays the exit on an aria-hidden, inert snapshot that removes itself on animationend", () => {
    const { scrim, body, ghost, box } = standInScrim("bb-dialog-out");
    playExit(scrim);
    expect(body.appended).toEqual([ghost]);
    expect(ghost.attrs).toMatchObject({
      "data-state": DIALOG_CLOSING_STATE,
      "aria-hidden": "true",
    });
    expect(ghost.inert).toBe(true);
    expect(box.listeners).toEqual(["animationend"]);
    expect(ghost.removed).toBe(0);
  });

  it("no snapshot at all under reduced motion — nothing moves", () => {
    const { scrim, body } = standInScrim("REDUCED");
    playExit(scrim);
    expect(body.appended).toEqual([]);
  });

  it("no exit animation to wait for: the snapshot is removed at once", () => {
    const { scrim, ghost } = standInScrim("none");
    playExit(scrim);
    expect(ghost.removed).toBe(1);
  });
});

describe("Tabs — ONE sliding indicator", () => {
  it("renders one aria-hidden indicator in the tablist, after the tabs", () => {
    const out = renderToStaticMarkup(
      <Tabs
        variant="segmented"
        value="b"
        tabs={[
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ]}
      />,
    );
    expect(out.match(/bb-tabs__indicator/g)).toHaveLength(1);
    expect(out).toMatch(/<span class="bb-tabs__indicator" aria-hidden="true"><\/span><\/div>$/);
    // Server markup: not placed yet, so the active tab's own marker shows.
    expect(out).not.toContain(TABS_INDICATOR_ATTR);
  });

  it("placing moves the indicator onto the active tab's box and hands the marker over", () => {
    const vars: Record<string, string> = {};
    const attrs: Record<string, string> = {};
    const bar = { style: { setProperty: (k: string, v: string) => (vars[k] = v) } };
    const active = { offsetLeft: 84, offsetTop: 4, offsetWidth: 120, offsetHeight: 36 };
    const list = {
      querySelector: (sel: string) => (sel === ".bb-tabs__indicator" ? bar : active),
      setAttribute: (k: string, v: string) => (attrs[k] = v),
      removeAttribute: (k: string) => delete attrs[k],
    };
    placeTabsIndicator(list as unknown as HTMLElement);
    expect(vars).toEqual({
      "--bb-tabs-x": "84px",
      "--bb-tabs-y": "4px",
      "--bb-tabs-w": "120px",
      "--bb-tabs-h": "36px",
    });
    expect(attrs[TABS_INDICATOR_ATTR]).toBe("ready");
  });

  it("no active tab: the marker is not handed over", () => {
    const attrs: Record<string, string> = { [TABS_INDICATOR_ATTR]: "ready" };
    const list = {
      querySelector: (sel: string) => (sel === ".bb-tabs__indicator" ? {} : null),
      setAttribute: (k: string, v: string) => (attrs[k] = v),
      removeAttribute: (k: string) => delete attrs[k],
    };
    placeTabsIndicator(list as unknown as HTMLElement);
    expect(attrs).toEqual({});
  });
});

describe("ToastProvider — ONE live region; a toast is announced once", () => {
  it("the region is in the page before any toast: one polite status announcing additions only", () => {
    const out = renderToStaticMarkup(
      <ToastProvider>
        <p>page</p>
      </ToastProvider>,
    );
    expect(out).toBe(
      "<p>page</p>" +
        '<div class="bb-toast-viewport" role="status" aria-live="polite" aria-relevant="additions" aria-label="Notifications"></div>',
    );
  });

  it("a toast inside the region is NOT a live region of its own (no double announcement)", () => {
    expect(renderToStaticMarkup(<Toast live={false} title="Saved" />)).not.toContain("role=");
    // Standalone, a toast still announces itself.
    expect(renderToStaticMarkup(<Toast title="Saved" />)).toContain('role="status"');
  });
});

describe("toast auto-dismiss — 5 seconds, paused while the payer is reading", () => {
  let expired: number[];
  let now: number;
  let timers: ToastTimers;
  beforeEach(() => {
    vi.useFakeTimers();
    expired = [];
    now = 0;
    timers = new ToastTimers(
      (id) => expired.push(id),
      TOAST_DURATION_MS,
      () => now,
    );
  });
  const advance = (ms: number) => {
    now += ms;
    vi.advanceTimersByTime(ms);
  };

  it("is 5 seconds", () => {
    expect(TOAST_DURATION_MS).toBe(5000);
    timers.add(1);
    advance(4999);
    expect(expired).toEqual([]);
    advance(1);
    expect(expired).toEqual([1]);
  });

  it("hover/focus pauses the clock; it resumes with the time that was LEFT", () => {
    timers.add(1);
    advance(3000);
    timers.pause();
    advance(60_000);
    expect(expired).toEqual([]);
    timers.resume();
    advance(1999);
    expect(expired).toEqual([]);
    advance(1);
    expect(expired).toEqual([1]);
  });

  it("a toast that arrives during a pause waits its full 5 seconds after the resume", () => {
    timers.pause();
    timers.add(2);
    advance(10_000);
    timers.resume();
    advance(4999);
    expect(expired).toEqual([]);
    advance(1);
    expect(expired).toEqual([2]);
  });

  it("a dismissed toast never expires later", () => {
    timers.add(3);
    timers.remove(3);
    advance(10_000);
    expect(expired).toEqual([]);
  });

  it("focus is read off the DOM: a focused toast removed without a blur does not pause later toasts", () => {
    const closeButton = { id: "close" };
    const body = { id: "body" };
    const children = new Set<object>([closeButton]);
    const viewport = { contains: (n: object) => children.has(n) } as unknown as Element;
    const doc = { activeElement: closeButton as object };
    vi.stubGlobal("document", doc);
    // What the provider does on focus and on every change to the stack.
    const sync = () => (focusIsWithin(viewport) ? timers.pause() : timers.resume());

    timers.add(1);
    sync(); // the payer tabs onto the ✕ — the clock stops
    advance(60_000);
    expect(expired).toEqual([]);

    // The ✕ dismisses its toast: the focused node goes with it and NO blur fires.
    timers.remove(1);
    children.delete(closeButton);
    doc.activeElement = body;
    sync();

    timers.add(2);
    sync();
    advance(TOAST_DURATION_MS);
    expect(expired).toEqual([2]);
  });
});

describe("CountUp — the balance counts up, ending exactly on the server's figure", () => {
  it("starts at `from`, eases out, and lands on `to`", () => {
    expect(countUpValue(10, 60, 0)).toBe(10);
    expect(countUpValue(10, 60, 0.5)).toBeGreaterThan(35); // ease-out: past halfway at half time
    expect(countUpValue(10, 60, 1)).toBe(60);
    expect(countUpValue(10, 60, 7)).toBe(60); // never overshoots
  });
});
