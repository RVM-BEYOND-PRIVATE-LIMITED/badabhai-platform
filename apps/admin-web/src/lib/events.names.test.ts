import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Events filter's name suggestions (A4, #2574): the metrics route's `by_event_name`, read for
 * a fixed window and CACHED — the one read in this module that is — because it is a GROUP BY the
 * Events page would otherwise run on every filter change.
 */
const calls = vi.hoisted(() => [] as Array<{ path: string; opts: Record<string, unknown> }>);
const reply = vi.hoisted(() => ({ value: null as unknown }));

vi.mock("./admin-http", () => ({
  adminFetch: async (path: string, opts: Record<string, unknown>) => {
    calls.push({ path, opts });
    return reply.value;
  },
}));

const { EVENT_NAME_REVALIDATE_S, EVENT_NAME_WINDOW_DAYS, listRecentEventNames, metricsSchema } =
  await import("./events");

beforeEach(() => {
  calls.length = 0;
  reply.value = {
    window_days: EVENT_NAME_WINDOW_DAYS,
    // The route orders by count; a suggestion list reads in name order.
    by_event_name: [
      { key: "worker.created", count: 40 },
      { key: "profile.confirmed", count: 12 },
      { key: "payer.unlock_completed", count: 3 },
    ],
    by_day: [],
    by_actor_type: [],
    funnel: [],
    breaches: [],
    k_anon_floor: 5,
  };
});

describe("listRecentEventNames", () => {
  it("reads the metrics route for its window, through the response's own schema", async () => {
    await listRecentEventNames();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe(`/admin/events/metrics?windowDays=${EVENT_NAME_WINDOW_DAYS}`);
    expect(calls[0]!.opts.schema).toBe(metricsSchema);
  });

  it("is cached for a few minutes — the only read here that is (adminFetch is no-store without it)", async () => {
    await listRecentEventNames();
    expect(calls[0]!.opts.revalidate).toBe(EVENT_NAME_REVALIDATE_S);
    expect(EVENT_NAME_REVALIDATE_S).toBeGreaterThan(0);
  });

  it("returns the names alone, in name order", async () => {
    await expect(listRecentEventNames()).resolves.toEqual([
      "payer.unlock_completed",
      "profile.confirmed",
      "worker.created",
    ]);
  });

  it("asks for a window the route accepts (1–90 days)", () => {
    expect(EVENT_NAME_WINDOW_DAYS).toBeGreaterThanOrEqual(1);
    expect(EVENT_NAME_WINDOW_DAYS).toBeLessThanOrEqual(90);
  });
});
