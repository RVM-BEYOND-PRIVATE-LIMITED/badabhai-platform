import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type * as ReactModule from "react";

/**
 * A5 (#2575) — AdminActionButton tells its host when its confirmed request is in flight
 * (`onPendingChange`), so a dialog hosting it can refuse to close — and drop the one-time result —
 * before that request settles.
 *
 * `useTransition` is seeded with the in-flight flag, and `useEffect` runs each effect at once,
 * keeping its cleanup (run when the request settles, or when the button unmounts mid-request).
 */
const state = vi.hoisted(() => ({
  pending: false,
  cleanups: [] as (() => void)[],
}));
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof ReactModule>("react");
  return {
    ...actual,
    useTransition: () => [state.pending, (fn: () => void) => fn()],
    useEffect: (fn: () => void | (() => void)) => {
      const cleanup = fn();
      if (cleanup) state.cleanups.push(cleanup);
    },
  };
});

const { AdminActionButton } = await import("./admin-action-button");

let reports: boolean[] = [];
const render = () =>
  renderToStaticMarkup(
    <AdminActionButton
      label="Create admin"
      confirmLabel="Confirm: create this admin?"
      variant="primary"
      action={async () => ({ ok: true, changed: true, message: "" })}
      onPendingChange={(pending) => reports.push(pending)}
    />,
  );

beforeEach(() => {
  state.pending = false;
  state.cleanups = [];
  reports = [];
});

describe("onPendingChange", () => {
  it("reports nothing while no request is in flight", () => {
    render();
    for (const c of state.cleanups) c();
    expect(reports).toEqual([]);
  });

  it("reports the request going out, then settling", () => {
    state.pending = true;
    expect(render()).toContain("<span>Working…</span>");
    expect(reports).toEqual([true]);
    for (const c of state.cleanups) c();
    expect(reports).toEqual([true, false]);
  });
});
