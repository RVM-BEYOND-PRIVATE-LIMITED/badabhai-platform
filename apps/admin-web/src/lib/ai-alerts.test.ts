import { describe, expect, it } from "vitest";

import { aiAlertsStatusSchema, describeSpendCap, describeTaskFallback } from "./ai-alerts";

/**
 * B13 (#2567) — the portal-side mirror of `GET /admin/ai-alerts`.
 *
 * WHAT THIS PINS. The server owns the contract (`apps/api/src/admin/admin-ai-alerts.dto.ts`
 * via `AiAlertsService`); this file re-states it in zod. A field the server adds must
 * appear here the day it ships — and a field THIS file requires that the server drops
 * fails the read closed instead of rendering half a page. Both directions are covered:
 * the parse test below runs a captured wire payload through the REAL schema.
 */

const WIRE = {
  generated_at: "2026-11-05T00:00:00.000Z",
  window_hours: 24,
  thresholds: { min_calls: 10, fallback_share: 0.5 },
  tasks: [
    {
      task_type: "profile_extraction",
      window_hours: 24,
      total_calls: 20,
      real_calls: 4,
      fallback_calls: 16,
      fallback_share: 0.8,
      breaching: true,
      last_alert: "raised",
      active: true,
    },
  ],
  spend_cap: { window_hours: 24, breach_count: 3, active: true },
  recent_alerts: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      event_name: "ai.fallback_alert_raised",
      occurred_at: "2026-11-05T00:00:00.000Z",
      task_type: "profile_extraction",
      reason: null,
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      event_name: "ai.spend_cap_exceeded",
      occurred_at: "2026-11-04T23:00:00.000Z",
      task_type: "profile_extraction",
      reason: "daily_cap_exceeded",
    },
  ],
};

describe("ai-alerts wire contract", () => {
  it("parses a captured status payload through the REAL schema", () => {
    expect(aiAlertsStatusSchema.parse(WIRE)).toEqual(WIRE);
  });

  it("a task the portal has never heard of still parses (open task_type, never an enum)", () => {
    const unknown = {
      ...WIRE,
      tasks: [{ ...WIRE.tasks[0]!, task_type: "some_future_task", last_alert: null }],
    };
    expect(aiAlertsStatusSchema.parse(unknown).tasks[0]!.task_type).toBe("some_future_task");
  });
});

describe("describeTaskFallback", () => {
  it("states the counts, the share and the verdict", () => {
    expect(
      describeTaskFallback({
        task_type: "profile_extraction",
        total_calls: 20,
        fallback_calls: 16,
        fallback_share: 0.8,
        breaching: true,
      }),
    ).toBe("profile_extraction: 16/20 recorded calls fell back (80.0% — BREACHING).");
  });

  it("an empty window reads as silence, never as an all-clear", () => {
    const text = describeTaskFallback({
      task_type: "profile_extraction",
      total_calls: 0,
      fallback_calls: 0,
      fallback_share: 0,
      breaching: false,
    });
    expect(text).toMatch(/no recorded calls/);
    expect(text).toMatch(/not an all-clear/);
  });
});

describe("describeSpendCap", () => {
  it("zero trips read as no RECORDED trip", () => {
    expect(describeSpendCap({ breach_count: 0, window_hours: 24 })).toBe(
      "No spend-cap trip recorded in the last 24h.",
    );
  });

  it("counts the trips in the stated window", () => {
    expect(describeSpendCap({ breach_count: 3, window_hours: 24 })).toBe(
      "3 spend-cap trips in the last 24h.",
    );
  });
});
