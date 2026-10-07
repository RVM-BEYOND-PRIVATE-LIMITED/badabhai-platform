import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ReactModule from "react";
import type * as LinkModule from "next/link";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The navigation PENDING CUE. With no loading boundary in the portal
 * (app/no-suspense-above-a-page.test.ts), a navigation keeps the current page on screen until the
 * next one has rendered — so the link that started it says so: a dot on the link (Next's
 * `useLinkStatus`), a bar along the top of the viewport (the one visible on a phone, where the
 * drawer closes as the link is followed), and one polite status line for assistive tech. The bar
 * and the line wait out the store's delay, so a prefetched navigation never flashes them.
 *
 * The node env cannot mount React, so `useLinkStatus` is a switch and `useEffect` a recorder
 * whose effects a test runs by hand; the store (and its timer) is the real one.
 */
type Effect = { run: () => void | (() => void); deps: readonly unknown[] | undefined };
const hooks = vi.hoisted(() => ({ pending: false, effects: [] as Effect[] }));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof ReactModule>()),
  useEffect: (run: Effect["run"], deps?: readonly unknown[]) => {
    hooks.effects.push({ run, deps });
  },
}));
vi.mock("next/link", async (importOriginal) => ({
  ...(await importOriginal<typeof LinkModule>()),
  useLinkStatus: () => ({ pending: hooks.pending }),
}));

const { NavPendingCue, NavPendingStatus } = await import("./nav-pending");
const {
  NAV_PENDING_DELAY_MS,
  announceNavigation,
  resetNavigationForTests,
  shownNavigation,
  withdrawNavigation,
} = await import("./nav-pending-store");

beforeEach(() => {
  vi.useFakeTimers();
  hooks.pending = false;
  hooks.effects = [];
  resetNavigationForTests();
});
afterEach(() => vi.useRealTimers());

const IDLE_STATUS =
  '<div class="nav-progress" aria-hidden="true"></div><p class="sr-only" role="status" aria-live="polite"></p>';

describe("the cue inside a link", () => {
  it("draws nothing while its link is idle — and announces nothing", () => {
    expect(renderToStaticMarkup(<NavPendingCue label="Postings" />)).toBe(
      '<span class="nav-pending" aria-hidden="true"></span>',
    );
    for (const e of hooks.effects) e.run();
    vi.advanceTimersByTime(NAV_PENDING_DELAY_MS * 10);
    expect(shownNavigation()).toBeNull();
  });

  it("marks the dot on while its navigation is pending, hidden from assistive tech", () => {
    hooks.pending = true;
    expect(renderToStaticMarkup(<NavPendingCue label="Postings" />)).toBe(
      '<span class="nav-pending nav-pending--on" aria-hidden="true"></span>',
    );
  });

  it("announces its label while pending, and withdraws it when the navigation ends", () => {
    hooks.pending = true;
    renderToStaticMarkup(<NavPendingCue label="Postings" />);
    const effect = hooks.effects.find((e) => e.deps?.includes("Postings"));
    expect(effect?.deps).toEqual([true, "Postings"]);
    const cleanup = effect!.run();
    vi.advanceTimersByTime(NAV_PENDING_DELAY_MS);
    expect(shownNavigation()).toBe("Postings");
    // The navigation commits: `pending` flips, React runs the cleanup — nothing may stick.
    expect(typeof cleanup).toBe("function");
    (cleanup as () => void)();
    expect(shownNavigation()).toBeNull();
  });
});

describe("the shell's bar and status line", () => {
  it("idle: an empty polite status region (present before anything is said) and no bar", () => {
    expect(renderToStaticMarkup(<NavPendingStatus />)).toBe(IDLE_STATUS);
  });

  it("within the delay: still nothing — a prefetched navigation does not flash", () => {
    announceNavigation("Postings");
    vi.advanceTimersByTime(NAV_PENDING_DELAY_MS - 1);
    expect(renderToStaticMarkup(<NavPendingStatus />)).toBe(IDLE_STATUS);
  });

  it("after the delay: the bar shows and the status line names where the navigation is going", () => {
    const token = announceNavigation("Postings");
    vi.advanceTimersByTime(NAV_PENDING_DELAY_MS);
    expect(renderToStaticMarkup(<NavPendingStatus />)).toBe(
      '<div class="nav-progress nav-progress--on" aria-hidden="true"></div><p class="sr-only" role="status" aria-live="polite">Opening Postings…</p>',
    );
    withdrawNavigation(token);
    expect(renderToStaticMarkup(<NavPendingStatus />)).toBe(IDLE_STATUS);
  });
});
