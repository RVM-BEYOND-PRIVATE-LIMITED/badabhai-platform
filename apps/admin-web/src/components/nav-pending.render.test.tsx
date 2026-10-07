import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ReactModule from "react";
import type * as LinkModule from "next/link";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The navigation PENDING CUE (review of #2095). With no loading boundary anywhere in the console
 * (app/no-loading-boundary-anywhere.test.ts), a navigation keeps the current page on screen until
 * the next one has rendered — so whatever started it says so: a dot on the link or button (Next's
 * `useLinkStatus`, or a filter bar's own transition), a bar along the top of the viewport (the one
 * visible on a phone, where the drawer closes as the link is followed), and one polite status
 * line for assistive tech. The bar, the dot and the announcement all wait ~180ms (delta review),
 * so a prefetched navigation that lands at once never flashes them.
 *
 * The node env cannot mount React, so `useLinkStatus` is a switch and `useEffect` a recorder
 * whose effects a test runs by hand (with fake timers); the store is the real one.
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

const { NavPendingCue, NavPendingStatus, SubmitPendingCue, PENDING_ANNOUNCE_DELAY_MS } =
  await import("./nav-pending");
const { announceNavigation, pendingNavigation, resetNavigationForTests, withdrawNavigation } =
  await import("./nav-pending-store");

beforeEach(() => {
  hooks.pending = false;
  hooks.effects = [];
  resetNavigationForTests();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** The one announcement effect a render recorded. */
const announcement = (message: string) => {
  const effect = hooks.effects.find((e) => e.deps?.includes(message));
  expect(effect, "the announcement effect").toBeDefined();
  return effect!;
};

describe("the cue inside a nav link", () => {
  it("draws nothing while its link is idle — and announces nothing", () => {
    expect(renderToStaticMarkup(<NavPendingCue message="Opening Workers…" />)).toBe(
      '<span class="nav-pending" aria-hidden="true"></span>',
    );
    for (const e of hooks.effects) e.run();
    vi.advanceTimersByTime(PENDING_ANNOUNCE_DELAY_MS * 2);
    expect(pendingNavigation()).toBeNull();
  });

  it("marks the dot while the navigation its link started is pending, hidden from assistive tech", () => {
    hooks.pending = true;
    expect(renderToStaticMarkup(<NavPendingCue message="Opening Workers…" />)).toBe(
      '<span class="nav-pending nav-pending--on" aria-hidden="true"></span>',
    );
  });

  it("announces only once the navigation has been pending for a moment — a fast one says nothing", () => {
    hooks.pending = true;
    renderToStaticMarkup(<NavPendingCue message="Opening Workers…" />);
    const effect = announcement("Opening Workers…");
    expect(effect.deps).toEqual([true, "Opening Workers…"]);
    const cleanup = effect.run();
    vi.advanceTimersByTime(PENDING_ANNOUNCE_DELAY_MS - 1);
    expect(pendingNavigation()).toBeNull();
    // A prefetched navigation lands now: the cleanup runs before the delay is up.
    (cleanup as () => void)();
    vi.advanceTimersByTime(PENDING_ANNOUNCE_DELAY_MS * 2);
    expect(pendingNavigation()).toBeNull();
  });

  it("a slow one is announced after the delay, and withdrawn the moment it commits", () => {
    hooks.pending = true;
    renderToStaticMarkup(<NavPendingCue message="Opening Workers…" />);
    const cleanup = announcement("Opening Workers…").run();
    vi.advanceTimersByTime(PENDING_ANNOUNCE_DELAY_MS);
    expect(pendingNavigation()).toBe("Opening Workers…");
    // The navigation commits: `pending` flips, React runs the cleanup — nothing may stick.
    expect(typeof cleanup).toBe("function");
    (cleanup as () => void)();
    expect(pendingNavigation()).toBeNull();
  });
});

describe("the cue on a form's submit button (a filter bar's Apply)", () => {
  it("follows the pending flag it is given — the bar's own navigation transition", () => {
    expect(
      renderToStaticMarkup(<SubmitPendingCue pending={false} message="Applying the filters…" />),
    ).toBe('<span class="nav-pending" aria-hidden="true"></span>');
    expect(renderToStaticMarkup(<SubmitPendingCue pending message="Applying the filters…" />)).toBe(
      '<span class="nav-pending nav-pending--on" aria-hidden="true"></span>',
    );
  });

  it("announces after the same delay, and withdraws when the navigation commits", () => {
    renderToStaticMarkup(<SubmitPendingCue pending message="Applying the filters…" />);
    const cleanup = announcement("Applying the filters…").run();
    vi.advanceTimersByTime(PENDING_ANNOUNCE_DELAY_MS);
    expect(pendingNavigation()).toBe("Applying the filters…");
    (cleanup as () => void)();
    expect(pendingNavigation()).toBeNull();
  });
});

describe("the shell's status line and page-wide bar", () => {
  it("idle: an empty polite status region (present before anything is said) and no bar", () => {
    expect(renderToStaticMarkup(<NavPendingStatus />)).toBe(
      '<div class="nav-progress" aria-hidden="true"></div><p class="sr-only" role="status" aria-live="polite"></p>',
    );
  });

  it("pending: the bar is on and the status line says what is happening", () => {
    const token = announceNavigation("Opening Workers…");
    expect(renderToStaticMarkup(<NavPendingStatus />)).toBe(
      '<div class="nav-progress nav-progress--on" aria-hidden="true"></div><p class="sr-only" role="status" aria-live="polite">Opening Workers…</p>',
    );
    withdrawNavigation(token);
    expect(renderToStaticMarkup(<NavPendingStatus />)).not.toContain("nav-progress--on");
  });
});
