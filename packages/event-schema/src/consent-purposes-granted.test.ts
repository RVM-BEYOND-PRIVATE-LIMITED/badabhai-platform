import { describe, expect, it } from "vitest";

import { EVENT_REGISTRY, isEventName, validateEvent } from "./index";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const WORKER = "33333333-3333-4333-8333-333333333333";
const CONSENT = "44444444-4444-4444-8444-444444444444";
const CORRELATION = "55555555-5555-4555-8555-555555555555";

/**
 * `consent.purposes_granted` (2026-11-04, E4 items 6-7): an existing worker opted in to the
 * approved employer-sharing notice. The contract under test: the grant can only ever name the two
 * employer-contact purposes, carries the notice version he was shown, and is `.strict()` — no
 * phone, name or wider purpose list can ride along.
 */
function grantedEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: EVENT_ID,
    event_name: "consent.purposes_granted",
    event_version: 1,
    occurred_at: "2026-11-04T10:00:00.000Z",
    actor: { actor_type: "worker", actor_id: WORKER },
    subject: { subject_type: "consent", subject_id: CONSENT },
    source: "api",
    correlation_id: CORRELATION,
    causation_id: null,
    payload: {
      worker_id: WORKER,
      consent_id: CONSENT,
      consent_version: "2026-11-04",
      granted_purposes: ["employer_sharing", "employer_messaging"],
      ...over,
    },
    metadata: { environment: "test", service: "api" },
  };
}

describe("consent.purposes_granted", () => {
  it("is registered at v1 in the consent domain", () => {
    expect(isEventName("consent.purposes_granted")).toBe(true);
    expect(EVENT_REGISTRY["consent.purposes_granted"].version).toBe(1);
    expect(EVENT_REGISTRY["consent.purposes_granted"].domain).toBe("consent");
  });

  it("accepts a grant of both employer purposes, or of the one that was missing", () => {
    expect(validateEvent(grantedEvent()).success).toBe(true);
    expect(validateEvent(grantedEvent({ granted_purposes: ["employer_messaging"] })).success).toBe(
      true,
    );
  });

  it("refuses any purpose outside the employer pair (a grant cannot widen anything else)", () => {
    expect(validateEvent(grantedEvent({ granted_purposes: ["profiling"] })).success).toBe(false);
    expect(
      validateEvent(grantedEvent({ granted_purposes: ["employer_sharing", "model_training"] }))
        .success,
    ).toBe(false);
  });

  it("refuses an empty grant (a no-op grant writes no row and emits nothing)", () => {
    expect(validateEvent(grantedEvent({ granted_purposes: [] })).success).toBe(false);
  });

  it("refuses a missing notice version or extra keys (.strict())", () => {
    const { consent_version: _dropped, ...rest } = grantedEvent().payload as Record<
      string,
      unknown
    >;
    expect(validateEvent({ ...grantedEvent(), payload: rest }).success).toBe(false);
    expect(validateEvent(grantedEvent({ phone: "+919800000000" })).success).toBe(false);
  });
});
