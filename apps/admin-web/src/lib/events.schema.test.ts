import { describe, it, expect } from "vitest";
import { entityTimelineSchema, eventListItemSchema, metricsSchema } from "./events";

/**
 * Response-shape parity with the admin API.
 *
 * REGRESSION GUARD. The metrics schema originally typed `by_day` as the `{key,count}`
 * bucket the other two aggregates use. The server actually emits `{day,count}`, so the
 * whole response failed to parse and the dashboard silently showed "metrics unavailable"
 * — the transport failing closed, correctly, but on a shape I had assumed rather than
 * checked.
 *
 * The fixtures below are REAL payloads captured from a running API during the Milestone 2
 * verification run, not invented ones. That is the point: a fixture I made up would have
 * encoded the same wrong assumption.
 */

// Captured from GET /admin/events/metrics on 2026-08-04.
const REAL_METRICS = {
  window_days: 30,
  by_event_name: [
    { key: "admin.session_started", count: 9 },
    { key: "admin.session_revoked", count: 1 },
  ],
  by_day: [{ day: "2026-08-04", count: 10 }],
  by_actor_type: [{ key: "admin", count: 10 }],
  funnel: [
    { event_name: "feed.shown", count: 0, distinct_subjects: 0, suppressed: false },
    { event_name: "application.submitted", count: 0, distinct_subjects: 0, suppressed: false },
  ],
  breaches: [{ key: "unlock.cap_exceeded", count: 0 }],
  k_anon_floor: 5,
};

// Captured from GET /admin/events.
const REAL_EVENT = {
  id: "0f0b7a2a-2f3a-4d1e-9a1e-2b7c9d4e5f60",
  event_name: "admin.session_started",
  event_version: 1,
  actor_type: "admin",
  actor_id: "80e2b2a0-3633-482b-8f5a-4f092c06e62e",
  subject_type: "admin_session",
  subject_id: "64660d27-091f-4105-accb-cd72eef62c35",
  occurred_at: "2026-08-04T09:40:29.000Z",
  correlation_id: "792aafca-1b9c-4f19-b75b-16892bc2e318",
  causation_id: null,
};

// Captured from GET /admin/entities/worker/:id/timeline — route #4, AdminEventsService.timeline().
// Reuses the same list-item envelope as REAL_EVENT (the timeline row is the identical
// AdminEventListItem projection), wrapped with the subject echo + keyset cursor.
const REAL_ENTITY_TIMELINE = {
  subject_type: "worker",
  subject_id: "64660d27-091f-4105-accb-cd72eef62c35",
  events: [REAL_EVENT],
  nextCursor: null,
};

describe("event list item — parses the real API row", () => {
  it("accepts a captured row", () => {
    expect(eventListItemSchema.safeParse(REAL_EVENT).success).toBe(true);
  });

  it("accepts the nullable fields as null (they genuinely arrive null)", () => {
    const parsed = eventListItemSchema.safeParse({
      ...REAL_EVENT,
      actor_id: null,
      subject_id: null,
      causation_id: null,
    });
    expect(parsed.success).toBe(true);
  });

  it("REJECTS a row missing the correlation id — the field the whole trace view hangs on", () => {
    const { correlation_id: _omitted, ...without } = REAL_EVENT;
    expect(eventListItemSchema.safeParse(without).success).toBe(false);
  });
});

describe("metrics — the aggregates do NOT all share one bucket shape", () => {
  /*
   * These assertions run the REAL SCHEMA over the captured payload.
   *
   * The first version of this file only checked properties on the fixture object — which
   * a mutation proved was vacuous: reverting `by_day` to the wrong bucket type SURVIVED,
   * because nothing here ever invoked the schema. A test that cannot fail for the bug it
   * names is worse than no test, since it reads as coverage.
   */
  it("parses a captured /admin/events/metrics response", () => {
    const parsed = metricsSchema.safeParse(REAL_METRICS);
    expect(parsed.success).toBe(true);
  });

  it("REJECTS by_day rows keyed `key` — the exact shape that blanked the dashboard", () => {
    const wrong = { ...REAL_METRICS, by_day: [{ key: "2026-08-04", count: 10 }] };
    expect(metricsSchema.safeParse(wrong).success).toBe(false);
  });

  it("REJECTS by_event_name rows keyed `day` — the mirror-image mistake", () => {
    const wrong = { ...REAL_METRICS, by_event_name: [{ day: "x", count: 1 }] };
    expect(metricsSchema.safeParse(wrong).success).toBe(false);
  });

  it("keeps the suppression flag and the floor — the funnel cannot render honestly without them", () => {
    const parsed = metricsSchema.parse(REAL_METRICS);
    for (const stage of parsed.funnel) {
      expect(typeof stage.suppressed).toBe("boolean");
      expect(typeof stage.distinct_subjects).toBe("number");
    }
    expect(parsed.k_anon_floor).toBeGreaterThan(0);
  });

  it("REJECTS a funnel stage missing `suppressed` — it would render as a real count", () => {
    const wrong = {
      ...REAL_METRICS,
      funnel: [{ event_name: "feed.shown", count: 0, distinct_subjects: 0 }],
    };
    expect(metricsSchema.safeParse(wrong).success).toBe(false);
  });
});

describe("entity timeline — route #4, GET /admin/entities/:type/:id/timeline", () => {
  /*
   * `getEntityTimeline` is the route the per-entity "View event timeline" links call
   * instead of the generic `/admin/events` filter. Its schema was never run against a
   * captured shape before this — a real risk given `metrics` above already proved this
   * file's schemas can drift from what `AdminEventsService` actually returns.
   */
  it("parses a captured /admin/entities/:type/:id/timeline response", () => {
    const parsed = entityTimelineSchema.safeParse(REAL_ENTITY_TIMELINE);
    expect(parsed.success).toBe(true);
  });

  it("REJECTS a payload missing nextCursor — keyset pagination cannot page without it", () => {
    const { nextCursor: _omitted, ...without } = REAL_ENTITY_TIMELINE;
    expect(entityTimelineSchema.safeParse(without).success).toBe(false);
  });

  it("REJECTS a malformed event inside `events` — missing correlation id, same as the list route", () => {
    const { correlation_id: _omitted, ...malformedEvent } = REAL_EVENT;
    const wrong = { ...REAL_ENTITY_TIMELINE, events: [malformedEvent] };
    expect(entityTimelineSchema.safeParse(wrong).success).toBe(false);
  });

  it("REJECTS a payload missing subject_id — the caller cannot tell which entity this is", () => {
    const { subject_id: _omitted, ...without } = REAL_ENTITY_TIMELINE;
    expect(entityTimelineSchema.safeParse(without).success).toBe(false);
  });
});
