/**
 * The eight `managed_hiring.*` events (#2751 items 4 to 13). Ids, closed codes, integers and times,
 * `.strict()`: no staff note, worker detail, company detail or price label can ride along, and the
 * met / closed-unmet events cannot contradict their own counts.
 */
import { describe, expect, it } from "vitest";

import { EVENT_REGISTRY, isEventName, validateEvent } from "./index";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";
const UUID_D = "44444444-4444-4444-8444-444444444444";
const UUID_E = "55555555-5555-4555-8555-555555555555";
const AT = "2026-11-18T10:00:00.000Z";

function envelope(
  name: string,
  payload: Record<string, unknown>,
  subject: { subject_type: string; subject_id: string } = {
    subject_type: "managed_hiring_order",
    subject_id: UUID_C,
  },
): Record<string, unknown> {
  return {
    event_id: UUID_A,
    event_name: name,
    event_version: 1,
    occurred_at: AT,
    actor: { actor_type: "system", actor_id: null },
    subject,
    source: "api",
    correlation_id: UUID_D,
    causation_id: null,
    payload,
    metadata: { environment: "test", service: "api" },
  };
}

const ids = { order_id: UUID_C, payer_id: UUID_B, job_posting_id: UUID_E };

const VALID: Record<string, Record<string, unknown>> = {
  "managed_hiring.order_created": {
    ...ids,
    payment_order_id: UUID_A,
    tier: "standard",
    price_inr: 4000,
    total_paise: 472_000,
  },
  "managed_hiring.order_activated": {
    ...ids,
    payment_order_id: UUID_A,
    target_count: 5,
    started_at: AT,
    due_at: "2026-11-27T18:30:00.000Z",
    extended_until: "2026-12-18T18:30:00.000Z",
  },
  "managed_hiring.order_extended": {
    ...ids,
    confirmed_count: 4,
    target_count: 5,
    extended_until: "2026-12-18T18:30:00.000Z",
  },
  "managed_hiring.order_met": { ...ids, confirmed_count: 5, target_count: 5, met_at: "deadline" },
  "managed_hiring.order_closed_unmet": { ...ids, confirmed_count: 3, target_count: 5 },
  "managed_hiring.interest_added": {
    order_id: UUID_C,
    payer_id: UUID_B,
    worker_id: UUID_D,
    confirmed_count: 1,
  },
  "managed_hiring.interest_removed": {
    order_id: UUID_C,
    payer_id: UUID_B,
    worker_id: UUID_D,
    confirmed_count: 0,
  },
};

describe("the managed_hiring.* events", () => {
  it("are registered v1 events in the managed_hiring domain", () => {
    for (const name of [...Object.keys(VALID), "managed_hiring.callback_requested"]) {
      expect(isEventName(name)).toBe(true);
      expect(EVENT_REGISTRY[name as keyof typeof EVENT_REGISTRY]).toMatchObject({
        version: 1,
        domain: "managed_hiring",
      });
    }
  });

  it.each(Object.entries(VALID))("%s accepts a valid payload", (name, payload) => {
    expect(validateEvent(envelope(name, payload)).success).toBe(true);
  });

  it.each(Object.entries(VALID))(
    "%s refuses any extra field (no note, label or name)",
    (name, payload) => {
      expect(validateEvent(envelope(name, { ...payload, note: "called him" })).success).toBe(false);
      expect(validateEvent(envelope(name, { ...payload, worker_name: "Ravi" })).success).toBe(
        false,
      );
    },
  );

  it("order_created refuses an unknown tier and a zero price", () => {
    const base = VALID["managed_hiring.order_created"]!;
    expect(
      validateEvent(envelope("managed_hiring.order_created", { ...base, tier: "huge" })).success,
    ).toBe(false);
    expect(
      validateEvent(envelope("managed_hiring.order_created", { ...base, price_inr: 0 })).success,
    ).toBe(false);
  });

  it("order_met cannot claim a target it did not reach; closed_unmet cannot claim one it did", () => {
    expect(
      validateEvent(
        envelope("managed_hiring.order_met", {
          ...VALID["managed_hiring.order_met"]!,
          confirmed_count: 4,
        }),
      ).success,
    ).toBe(false);
    expect(
      validateEvent(
        envelope("managed_hiring.order_closed_unmet", {
          ...VALID["managed_hiring.order_closed_unmet"]!,
          confirmed_count: 5,
        }),
      ).success,
    ).toBe(false);
    expect(
      validateEvent(
        envelope("managed_hiring.order_met", {
          ...VALID["managed_hiring.order_met"]!,
          met_at: "early",
        }),
      ).success,
    ).toBe(false);
  });

  it("callback_requested is about the job: ids, the band and the reason", () => {
    const payload = {
      request_id: UUID_A,
      payer_id: UUID_B,
      job_posting_id: UUID_E,
      vacancy_band: "11-25",
      reason: "above_largest_tier",
    };
    const subject = { subject_type: "job_posting", subject_id: UUID_E };
    expect(
      validateEvent(envelope("managed_hiring.callback_requested", payload, subject)).success,
    ).toBe(true);
    expect(
      validateEvent(
        envelope("managed_hiring.callback_requested", { ...payload, vacancy_band: "50" }, subject),
      ).success,
    ).toBe(false);
    expect(
      validateEvent(
        envelope("managed_hiring.callback_requested", { ...payload, reason: "too_big" }, subject),
      ).success,
    ).toBe(false);
  });
});
