import { describe, expect, it } from "vitest";
import { buildAdminAttention } from "./attention";
import type { AttentionInput } from "./attention";

/**
 * The console's "needs attention" rules.
 *
 * These exist because a dashboard that always shows a banner trains operators to stop
 * reading banners. The contract under test is therefore as much about SILENCE as about
 * noise: a healthy platform must produce an empty list.
 */

const HEALTHY: AttentionInput = {
  metrics: { breaches: [], window_days: 7 },
  health: { environment: "production", checks: { db: "up", redis: "up", sms: "real" } },
  mayReadEvents: true,
  metricsFailed: false,
  recentFailed: false,
};

describe("buildAdminAttention", () => {
  it("says NOTHING when the platform is healthy", () => {
    expect(buildAdminAttention(HEALTHY)).toEqual([]);
  });

  it("raises a CRITICAL item for a dependency that is down, and names it", () => {
    const out = buildAdminAttention({
      ...HEALTHY,
      health: { environment: "production", checks: { db: "up", redis: "down" } },
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.tone).toBe("critical");
    expect(out[0]!.id).toBe("health-down");
    expect(out[0]!.body).toContain("redis");
  });

  it("puts a DOWN dependency ahead of everything else on the screen", () => {
    const out = buildAdminAttention({
      ...HEALTHY,
      metrics: { breaches: [{ count: 4 }], window_days: 7 },
      health: { environment: "staging", checks: { db: "down", sms: "mock" } },
    });
    // down → breaches → mock. An outage outranks a tripped cap outranks a simulated provider.
    expect(out.map((i) => i.id)).toEqual(["health-down", "breaches", "health-mock"]);
    expect(out[0]!.tone).toBe("critical");
  });

  it("counts cap breaches across buckets and links to the events spine", () => {
    const out = buildAdminAttention({
      ...HEALTHY,
      metrics: { breaches: [{ count: 2 }, { count: 3 }], window_days: 14 },
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.title).toContain("5 cap breaches");
    expect(out[0]!.title).toContain("14 days");
    expect(out[0]!.href).toBe("/events");
  });

  it("uses the singular for exactly one breach", () => {
    const out = buildAdminAttention({
      ...HEALTHY,
      metrics: { breaches: [{ count: 1 }], window_days: 7 },
    });
    expect(out[0]!.title).toContain("1 cap breach");
    expect(out[0]!.title).not.toContain("breaches");
  });

  it("surfaces a SIMULATED dependency — a green console quietly running on mocks is how a staging config reaches production unnoticed", () => {
    const out = buildAdminAttention({
      ...HEALTHY,
      health: { environment: "production", checks: { db: "up", sms: "mock" } },
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("health-mock");
    expect(out[0]!.tone).toBe("info");
    expect(out[0]!.body).toContain("sms");
    expect(out[0]!.body).toContain("production");
  });

  it("distinguishes an unreachable probe from an all-clear", () => {
    const out = buildAdminAttention({ ...HEALTHY, health: null });
    expect(out.map((i) => i.id)).toContain("health-unreachable");
    expect(out.find((i) => i.id === "health-unreachable")!.body).toContain("not an all-clear");
  });

  it("says the figures are incomplete when the events spine did not answer", () => {
    const out = buildAdminAttention({ ...HEALTHY, metrics: null, metricsFailed: true });
    expect(out.map((i) => i.id)).toContain("events-unreachable");
  });

  it("does NOT claim the events spine failed for an operator who never asked it", () => {
    // No read_events capability: the reads were never attempted, so reporting them as
    // failing would blame the platform for a permission boundary.
    const out = buildAdminAttention({
      ...HEALTHY,
      metrics: null,
      mayReadEvents: false,
      metricsFailed: true,
      recentFailed: true,
    });
    expect(out.map((i) => i.id)).not.toContain("events-unreachable");
  });

  it("treats 'real' and 'up' as healthy, and never flags them", () => {
    const out = buildAdminAttention({
      ...HEALTHY,
      health: { environment: "production", checks: { sms: "real", db: "up", cache: "ok" } },
    });
    expect(out).toEqual([]);
  });
});
