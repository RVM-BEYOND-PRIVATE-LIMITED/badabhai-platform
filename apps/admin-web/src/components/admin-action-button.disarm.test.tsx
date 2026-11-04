import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type * as ReactModule from "react";

/**
 * A5 (#2575) — an armed "click again to confirm" button no longer stays armed forever: it disarms
 * after 5 seconds, or as soon as focus leaves its cluster, and pulses once as it arms.
 *
 * `useState` is seeded so the button renders ARMED, its setter is recorded, and `useEffect` runs
 * the effect at once (cleanup kept) under fake timers.
 */
const state = vi.hoisted(() => ({
  armed: true,
  sets: [] as unknown[],
  cleanups: [] as (() => void)[],
}));
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof ReactModule>("react");
  return {
    ...actual,
    useState: () => [state.armed, (v: unknown) => state.sets.push(v)],
    useEffect: (fn: () => void | (() => void)) => {
      const cleanup = fn();
      if (cleanup) state.cleanups.push(cleanup);
    },
  };
});

const { AdminActionButton, ARM_TIMEOUT_MS, focusLeftCluster } =
  await import("./admin-action-button");

const render = () =>
  renderToStaticMarkup(
    <AdminActionButton
      label="Suspend"
      confirmLabel="Confirm suspend?"
      variant="danger"
      action={async () => ({ ok: true, changed: true, message: "" })}
    />,
  );

beforeEach(() => {
  vi.useFakeTimers();
  state.armed = true;
  state.sets = [];
  state.cleanups = [];
});
afterEach(() => vi.useRealTimers());

describe("an armed AdminActionButton", () => {
  it("shows the question in the confirm tone, marked armed for its one pulse, with Cancel", () => {
    const out = render();
    expect(out).toContain('class="btn btn--sm btn--danger" data-armed=""');
    expect(out).toContain("<span>Confirm suspend?</span>");
    expect(out).toContain("<span>Cancel</span>");
  });

  it("disarms itself after 5 seconds", () => {
    expect(ARM_TIMEOUT_MS).toBe(5000);
    render();
    vi.advanceTimersByTime(ARM_TIMEOUT_MS - 1);
    expect(state.sets).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(state.sets).toEqual([false]);
  });

  it("the timer is cleared when it disarms another way (the effect's cleanup)", () => {
    render();
    for (const c of state.cleanups) c();
    vi.advanceTimersByTime(ARM_TIMEOUT_MS * 2);
    expect(state.sets).toEqual([]);
  });

  it("an unarmed button starts no timer and carries no pulse", () => {
    state.armed = false;
    const out = render();
    expect(out).not.toContain("data-armed");
    vi.advanceTimersByTime(ARM_TIMEOUT_MS * 2);
    expect(state.sets).toEqual([]);
  });
});

describe("disarming on blur", () => {
  const cancel = { id: "cancel" };
  const cluster = { contains: (n: unknown) => n === cancel };

  it("focus moving to its own Cancel keeps it armed", () => {
    expect(focusLeftCluster(cluster, cancel)).toBe(false);
  });

  it("focus leaving for anything else — or for nowhere — disarms it", () => {
    expect(focusLeftCluster(cluster, { id: "elsewhere" })).toBe(true);
    expect(focusLeftCluster(cluster, null)).toBe(true);
  });
});
