import { describe, expect, it } from "vitest";

import { EVENT_REGISTRY, isEventName, validateEvent } from "./index";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";
const UUID_D = "44444444-4444-4444-8444-444444444444";

/**
 * `consent.age_declared` (#2541, CEO pack v1 A4 #9) — the worker's 18+ answer at sign-up.
 *
 * The contract under test: a yes/no and the consent row it produced, nothing else. An 18+ answer
 * names its consent row; an under-18 answer names none, because none was written. `.strict()`, so
 * a birth year or a date of birth can never ride along.
 */
function ageDeclaredEvent(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    event_id: UUID_A,
    event_name: "consent.age_declared",
    event_version: 1,
    occurred_at: "2026-11-04T10:00:00.000Z",
    actor: { actor_type: "worker", actor_id: UUID_B },
    subject: { subject_type: "worker", subject_id: UUID_B },
    source: "api",
    correlation_id: UUID_D,
    causation_id: null,
    payload,
    metadata: { environment: "test", service: "api" },
  };
}

describe("consent.age_declared", () => {
  it("is registered at v1 in the consent domain", () => {
    expect(isEventName("consent.age_declared")).toBe(true);
    expect(EVENT_REGISTRY["consent.age_declared"].version).toBe(1);
    expect(EVENT_REGISTRY["consent.age_declared"].domain).toBe("consent");
  });

  it("accepts an 18+ answer that names its consent row", () => {
    const res = validateEvent(
      ageDeclaredEvent({ worker_id: UUID_B, age_18_plus: true, consent_id: UUID_C }),
    );
    expect(res.success).toBe(true);
  });

  it("accepts an under-18 answer with no consent row", () => {
    const res = validateEvent(
      ageDeclaredEvent({ worker_id: UUID_B, age_18_plus: false, consent_id: null }),
    );
    expect(res.success).toBe(true);
  });

  it("refuses a minor with a consent row, and an adult without one", () => {
    expect(
      validateEvent(ageDeclaredEvent({ worker_id: UUID_B, age_18_plus: false, consent_id: UUID_C }))
        .success,
    ).toBe(false);
    expect(
      validateEvent(ageDeclaredEvent({ worker_id: UUID_B, age_18_plus: true, consent_id: null }))
        .success,
    ).toBe(false);
  });

  it("is strict — a birth year or date of birth cannot ride along", () => {
    for (const extra of [{ birth_year: 2009 }, { date_of_birth: "2009-01-01" }, { age: 17 }]) {
      const res = validateEvent(
        ageDeclaredEvent({ worker_id: UUID_B, age_18_plus: true, consent_id: UUID_C, ...extra }),
      );
      expect(res.success, JSON.stringify(extra)).toBe(false);
    }
  });

  it("refuses a non-boolean answer", () => {
    const res = validateEvent(
      ageDeclaredEvent({ worker_id: UUID_B, age_18_plus: "true", consent_id: UUID_C }),
    );
    expect(res.success).toBe(false);
  });
});
