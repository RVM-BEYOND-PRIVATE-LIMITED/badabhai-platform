import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decl, parseRules, stripComments } from "../../test/css-rules";
import {
  NAV_PENDING_DELAY_MS,
  announceNavigation,
  resetNavigationForTests,
  shownNavigation,
  subscribeNavigation,
  withdrawNavigation,
} from "./nav-pending-store";

/**
 * Which link's navigation is pending, for the shell's bar and status line. Each pending link
 * announces itself and withdraws when its navigation ends or it unmounts. Two rules matter:
 *  - nothing is SHOWN until the navigation has been pending for the delay — a prefetched one
 *    commits sooner and must not flash the bar or speak "Opening …";
 *  - nothing ever outlives its link's withdrawal — a cue that sticks is the very "click did
 *    nothing" it replaces.
 */
beforeEach(() => {
  vi.useFakeTimers();
  resetNavigationForTests();
});
afterEach(() => vi.useRealTimers());

describe("the delay", () => {
  it("is long enough to skip a prefetched navigation and short enough to answer a click (150–200ms)", () => {
    expect(NAV_PENDING_DELAY_MS).toBeGreaterThanOrEqual(150);
    expect(NAV_PENDING_DELAY_MS).toBeLessThanOrEqual(200);
  });

  it("is the same delay the link's dot waits out in CSS", () => {
    const css = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "app", "globals.css"),
      "utf8",
    );
    const on = parseRules(stripComments(css)).filter(
      (r) => r.selector === ".nav-pending--on" && r.at === "",
    );
    expect(on).toHaveLength(1);
    expect(decl(on[0]!, "--nav-pending-delay")).toBe(`${NAV_PENDING_DELAY_MS}ms`);
  });
});

describe("the pending-navigation store", () => {
  it("shows nothing until a link announces itself", () => {
    expect(shownNavigation()).toBeNull();
  });

  it("shows an announced label only after the delay — and tells subscribers then, not before", () => {
    const listener = vi.fn();
    subscribeNavigation(listener);
    announceNavigation("Postings");
    vi.advanceTimersByTime(NAV_PENDING_DELAY_MS - 1);
    expect(shownNavigation()).toBeNull();
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(shownNavigation()).toBe("Postings");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("a navigation that lands within the delay never shows at all (no flash)", () => {
    const listener = vi.fn();
    subscribeNavigation(listener);
    const token = announceNavigation("Postings");
    vi.advanceTimersByTime(NAV_PENDING_DELAY_MS - 1);
    withdrawNavigation(token);
    vi.advanceTimersByTime(NAV_PENDING_DELAY_MS * 10);
    expect(shownNavigation()).toBeNull();
    expect(listener).not.toHaveBeenCalled();
  });

  it("clears when its link withdraws after showing", () => {
    const listener = vi.fn();
    subscribeNavigation(listener);
    const token = announceNavigation("Postings");
    vi.advanceTimersByTime(NAV_PENDING_DELAY_MS);
    withdrawNavigation(token);
    expect(shownNavigation()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("the same destination clicked again waits out the delay again", () => {
    withdrawNavigation(announceNavigation("Postings"));
    announceNavigation("Postings");
    expect(shownNavigation()).toBeNull();
    vi.advanceTimersByTime(NAV_PENDING_DELAY_MS);
    expect(shownNavigation()).toBe("Postings");
  });

  it("an older link withdrawing never clears a newer one — click A, then B before A lands", () => {
    const a = announceNavigation("Postings");
    const b = announceNavigation("Dashboard");
    vi.advanceTimersByTime(NAV_PENDING_DELAY_MS);
    withdrawNavigation(a);
    expect(shownNavigation()).toBe("Dashboard");
    withdrawNavigation(b);
    expect(shownNavigation()).toBeNull();
  });

  it("click A, then B inside A's delay: A's label is never shown, B's is after its own delay", () => {
    announceNavigation("Postings");
    vi.advanceTimersByTime(100);
    announceNavigation("Dashboard");
    vi.advanceTimersByTime(NAV_PENDING_DELAY_MS - 100);
    expect(shownNavigation()).toBeNull();
    vi.advanceTimersByTime(100);
    expect(shownNavigation()).toBe("Dashboard");
  });

  it("a newer click replaces a shown label at once, and shows its own after the delay", () => {
    announceNavigation("Postings");
    vi.advanceTimersByTime(NAV_PENDING_DELAY_MS);
    announceNavigation("Dashboard");
    expect(shownNavigation()).toBeNull();
    vi.advanceTimersByTime(NAV_PENDING_DELAY_MS);
    expect(shownNavigation()).toBe("Dashboard");
  });

  it("an unsubscribed listener is told nothing", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeNavigation(listener);
    unsubscribe();
    announceNavigation("Postings");
    vi.advanceTimersByTime(NAV_PENDING_DELAY_MS);
    expect(listener).not.toHaveBeenCalled();
  });
});
