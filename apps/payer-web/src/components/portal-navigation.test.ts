import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ReactModule from "react";

/**
 * THE PROGRAMMATIC NAVIGATION HELPER (components/portal-navigation.ts) — the button-side twin of
 * `PortalLink`. A button that navigates (a form's publish/save, the agency form's Cancel, the
 * verified sign-in code) must show what a link shows: the bar along the top and the shell's ONE
 * polite status line, "Opening {label}…", until the destination has rendered.
 *
 *  - the router call runs INSIDE the hook's own transition, so its `pending` is the navigation's
 *    own state (Next's router updates in a transition too): push, or replace, and the optional
 *    refresh, all inside it — never before or after;
 *  - while pending, the label is announced to the shared store (after its delay — a prefetched
 *    navigation never flashes) and withdrawn when pending ends or the caller unmounts.
 *
 * The node env cannot mount React, so `useTransition` is a switch whose `startTransition` records
 * whether a call ran inside it, `useState` holds one slot, and `useEffect` is a recorder whose
 * effects a test runs by hand. The store (and its timer) is the real one.
 */
type Effect = { run: () => void | (() => void); deps: readonly unknown[] | undefined };
const hooks = vi.hoisted(() => ({
  pending: false,
  inTransition: false,
  label: null as string | null,
  setLabel: null as unknown as (v: string | null) => void,
  effects: [] as Array<{ run: () => void | (() => void); deps: readonly unknown[] | undefined }>,
}));
/** Each router call, and whether it ran inside the hook's transition. */
const calls: Array<[string, string | undefined, boolean]> = [];

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof ReactModule>()),
  useState: () => [hooks.label, hooks.setLabel],
  useTransition: () => [
    hooks.pending,
    (cb: () => void) => {
      hooks.inTransition = true;
      try {
        cb();
      } finally {
        hooks.inTransition = false;
      }
    },
  ],
  useEffect: (run: Effect["run"], deps?: readonly unknown[]) => {
    hooks.effects.push({ run, deps });
  },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: (href: string) => calls.push(["push", href, hooks.inTransition]),
    replace: (href: string) => calls.push(["replace", href, hooks.inTransition]),
    refresh: () => calls.push(["refresh", undefined, hooks.inTransition]),
  }),
}));

const { usePortalNavigation } = await import("./portal-navigation");
const { NAV_PENDING_DELAY_MS, resetNavigationForTests, shownNavigation } =
  await import("./nav-pending-store");

beforeEach(() => {
  vi.useFakeTimers();
  hooks.pending = false;
  hooks.inTransition = false;
  hooks.label = null;
  hooks.setLabel = vi.fn((v: string | null) => {
    hooks.label = v;
  });
  hooks.effects = [];
  calls.length = 0;
  resetNavigationForTests();
});
afterEach(() => vi.useRealTimers());

/** Render the hook as React would: fresh effects, the current state. */
function render() {
  hooks.effects = [];
  return usePortalNavigation();
}
/** The cue's effect from the last render, run as React would (its cleanup returned). */
function runCueEffect(): (() => void) | undefined {
  const effect = hooks.effects.find((e) => e.deps?.length === 2);
  expect(effect, "the cue effect (deps [pending, label])").toBeDefined();
  const cleanup = effect!.run();
  return typeof cleanup === "function" ? cleanup : undefined;
}

describe("navigate — the router call runs inside the hook's own transition", () => {
  it("pushes the href inside the transition, naming the destination first — and nothing else", () => {
    render().navigate("/postings/p1/applicants?reached=42", { pendingLabel: "Applicants" });
    expect(hooks.setLabel).toHaveBeenCalledWith("Applicants");
    expect(calls).toEqual([["push", "/postings/p1/applicants?reached=42", true]]);
  });

  it("replace: true replaces the history entry instead (sign-in → dashboard), never pushes", () => {
    render().navigate("/dashboard", { pendingLabel: "Dashboard", replace: true });
    expect(calls).toEqual([["replace", "/dashboard", true]]);
  });

  it("refresh: true re-reads the server data too — after the navigation, in the SAME transition", () => {
    render().navigate("/postings/p1", { pendingLabel: "CNC Turner", refresh: true });
    expect(calls).toEqual([
      ["push", "/postings/p1", true],
      ["refresh", undefined, true],
    ]);
  });

  it("exposes the transition's pending as the navigation's own state", () => {
    expect(render().pending).toBe(false);
    hooks.pending = true;
    expect(render().pending).toBe(true);
  });
});

describe("the cue — the shell's bar and ONE status line, while the navigation is pending", () => {
  it("announces the label once pending (after the store's delay), and withdraws it when the navigation ends", () => {
    render().navigate("/postings/p1/applicants", { pendingLabel: "Applicants" });
    hooks.pending = true;
    render();
    const cleanup = runCueEffect();
    expect(shownNavigation()).toBeNull(); // within the delay: a fast navigation never flashes
    vi.advanceTimersByTime(NAV_PENDING_DELAY_MS);
    expect(shownNavigation()).toBe("Applicants");
    // The destination rendered: `pending` flips, React runs the cleanup — nothing may stick.
    expect(cleanup).toBeTypeOf("function");
    cleanup!();
    expect(shownNavigation()).toBeNull();
  });

  it("says nothing while idle — before any navigate, and once the navigation has ended", () => {
    render();
    expect(runCueEffect()).toBeUndefined();
    hooks.label = "Applicants"; // a navigation that already ended: the label stays, pending is false
    render();
    expect(runCueEffect()).toBeUndefined();
    vi.advanceTimersByTime(NAV_PENDING_DELAY_MS * 10);
    expect(shownNavigation()).toBeNull();
  });

  it("feeds the cue the transition's pending and the label it was given (the effect's deps)", () => {
    hooks.pending = true;
    hooks.label = "Postings";
    render();
    expect(hooks.effects.find((e) => e.deps?.length === 2)?.deps).toEqual([true, "Postings"]);
  });
});
