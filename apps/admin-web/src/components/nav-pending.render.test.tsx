import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ReactModule from "react";
import type * as LinkModule from "next/link";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The navigation PENDING CUE (review of #2095). With no loading boundary anywhere in the console
 * (app/no-loading-boundary-anywhere.test.ts), a navigation keeps the current page on screen until
 * the next one has rendered — so the link that started it says so: a dot on the link (Next's
 * `useLinkStatus`), a bar along the top of the viewport (the one visible on a phone, where the
 * drawer closes as the link is followed), and one polite status line for assistive tech.
 *
 * The node env cannot mount React, so `useLinkStatus` is a switch and `useEffect` a recorder
 * whose effects a test runs by hand; the store is the real one.
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
const { announceNavigation, pendingNavigation, resetNavigationForTests, withdrawNavigation } =
  await import("./nav-pending-store");

beforeEach(() => {
  hooks.pending = false;
  hooks.effects = [];
  resetNavigationForTests();
});

describe("the cue inside a nav link", () => {
  it("draws nothing while its link is idle — and announces nothing", () => {
    expect(renderToStaticMarkup(<NavPendingCue label="Workers" />)).toBe(
      '<span class="nav-pending" aria-hidden="true"></span>',
    );
    for (const e of hooks.effects) e.run();
    expect(pendingNavigation()).toBeNull();
  });

  it("shows the dot while the navigation its link started is pending, hidden from assistive tech", () => {
    hooks.pending = true;
    expect(renderToStaticMarkup(<NavPendingCue label="Workers" />)).toBe(
      '<span class="nav-pending nav-pending--on" aria-hidden="true"></span>',
    );
  });

  it("announces its label while pending, and withdraws it when the navigation ends", () => {
    hooks.pending = true;
    renderToStaticMarkup(<NavPendingCue label="Workers" />);
    const effect = hooks.effects.find((e) => e.deps?.includes("Workers"));
    expect(effect?.deps).toEqual([true, "Workers"]);
    const cleanup = effect!.run();
    expect(pendingNavigation()).toBe("Workers");
    // The navigation commits: `pending` flips, React runs the cleanup — nothing may stick.
    expect(typeof cleanup).toBe("function");
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

  it("pending: the bar shows and the status line names where the navigation is going", () => {
    const token = announceNavigation("Workers");
    expect(renderToStaticMarkup(<NavPendingStatus />)).toBe(
      '<div class="nav-progress nav-progress--on" aria-hidden="true"></div><p class="sr-only" role="status" aria-live="polite">Opening Workers…</p>',
    );
    withdrawNavigation(token);
    expect(renderToStaticMarkup(<NavPendingStatus />)).not.toContain("nav-progress--on");
  });
});
