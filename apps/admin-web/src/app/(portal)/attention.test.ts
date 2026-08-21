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
  metrics: { breaches: [], by_event_name: [], window_days: 7 },
  health: { environment: "production", checks: { db: "up", redis: "up", sms: "real" } },
  mayReadEvents: true,
  mayReadEntities: true,
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
      metrics: { breaches: [{ count: 4 }], by_event_name: [], window_days: 7 },
      health: { environment: "staging", checks: { db: "down", sms: "mock" } },
    });
    // down → breaches → mock. An outage outranks a tripped cap outranks a simulated provider.
    expect(out.map((i) => i.id)).toEqual(["health-down", "breaches", "health-mock"]);
    expect(out[0]!.tone).toBe("critical");
  });

  it("counts cap breaches across buckets and links to the events spine", () => {
    const out = buildAdminAttention({
      ...HEALTHY,
      metrics: { breaches: [{ count: 2 }, { count: 3 }], by_event_name: [], window_days: 14 },
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.title).toContain("5 cap breaches");
    expect(out[0]!.title).toContain("14 days");
    expect(out[0]!.href).toBe("/events");
  });

  it("uses the singular for exactly one breach", () => {
    const out = buildAdminAttention({
      ...HEALTHY,
      metrics: { breaches: [{ count: 1 }], by_event_name: [], window_days: 7 },
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

/**
 * FEEDBACK NOBODY HAS READ.
 *
 * Both figures are event-name counts the dashboard's existing metrics read already carries;
 * nothing here adds a request, and nothing here invents a number. The rule is deliberately
 * asymmetric — it fires on the ABSENCE of a read event, which is only readable as zero
 * because the server groups by name with no limit, and it goes silent the moment anyone
 * opens the screen.
 */
describe("feedback waiting to be read", () => {
  const withEvents = (buckets: { key: string; count: number }[]): AttentionInput => ({
    ...HEALTHY,
    metrics: { breaches: [], by_event_name: buckets, window_days: 7 },
  });

  it("raises an item when messages arrived and no read is recorded", () => {
    const out = buildAdminAttention(withEvents([{ key: "feedback.submitted", count: 3 }]));
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("feedback-unread");
    expect(out[0]!.title).toContain("3 worker messages");
    expect(out[0]!.href).toBe("/feedback");
  });

  it("counts what ARRIVED, never the number of buckets or the read count", () => {
    // The bug this catches is a rule that reports "1" (one bucket) or falls through to the
    // read tally — both of which render as a plausible figure on a console.
    const out = buildAdminAttention(
      withEvents([
        { key: "worker.otp_verified", count: 99 },
        { key: "feedback.submitted", count: 12 },
      ]),
    );
    expect(out[0]!.title).toContain("12 worker messages");
  });

  it("uses the singular for exactly one message", () => {
    const out = buildAdminAttention(withEvents([{ key: "feedback.submitted", count: 1 }]));
    expect(out[0]!.title).toBe("1 worker message waiting");
    expect(out[0]!.body).toContain("A worker wrote in");
  });

  it("names the window the figure was measured over", () => {
    const out = buildAdminAttention({
      ...HEALTHY,
      metrics: {
        breaches: [],
        by_event_name: [{ key: "feedback.submitted", count: 2 }],
        window_days: 30,
      },
    });
    expect(out[0]!.body).toContain("30 days");
  });

  it("goes SILENT once the feedback screen has been read in the window", () => {
    // The whole point of the rule. A banner that stays up after the operator has acted is
    // the one they learn to ignore, and with it every other banner on the band.
    const out = buildAdminAttention(
      withEvents([
        { key: "feedback.submitted", count: 3 },
        { key: "admin.feedback_viewed", count: 1 },
      ]),
    );
    expect(out).toEqual([]);
  });

  it("says nothing when no feedback arrived — an unread screen is not an event", () => {
    const out = buildAdminAttention(withEvents([{ key: "admin.feedback_viewed", count: 4 }]));
    expect(out).toEqual([]);
  });

  it("says nothing to an operator who cannot open the feedback screen", () => {
    // `read_entities` is what the route declares. An item whose entire content is "go and
    // read this" is noise to someone the route would turn away.
    const out = buildAdminAttention({
      ...withEvents([{ key: "feedback.submitted", count: 5 }]),
      mayReadEntities: false,
    });
    expect(out.map((i) => i.id)).not.toContain("feedback-unread");
  });

  it("claims nothing at all when the metrics read failed", () => {
    // No counts means no claim. "0 messages" and "we could not ask" are different sentences,
    // and only one of them is true here.
    const out = buildAdminAttention({ ...HEALTHY, metrics: null, metricsFailed: true });
    expect(out.map((i) => i.id)).not.toContain("feedback-unread");
  });

  it("ranks below an outage, a tripped cap and a blind console", () => {
    const out = buildAdminAttention({
      ...HEALTHY,
      metrics: {
        breaches: [{ count: 1 }],
        by_event_name: [{ key: "feedback.submitted", count: 2 }],
        window_days: 7,
      },
      health: { environment: "staging", checks: { db: "down", sms: "mock" } },
    });
    expect(out.map((i) => i.id)).toEqual([
      "health-down",
      "breaches",
      "health-mock",
      "feedback-unread",
    ]);
  });
});
