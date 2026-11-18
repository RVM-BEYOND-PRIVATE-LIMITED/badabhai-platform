import { describe, expect, it } from "vitest";

import {
  createEvent,
  EVENT_REGISTRY,
  isEventName,
  validateEvent,
  WELCOME_CREDITS_TRIGGERS,
} from "./index";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";
const UUID_D = "44444444-4444-4444-8444-444444444444";

/**
 * `payer.welcome_credits_granted` (#2750 item 4). The contract under test: the wallet key, the lot,
 * a POSITIVE count, the expiry and the closed trigger, `.strict()` — ids, numbers and codes only,
 * so no company name, GSTIN or phone can ride along.
 */
function welcomeEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: UUID_A,
    event_name: "payer.welcome_credits_granted",
    event_version: 1,
    occurred_at: "2026-11-17T10:00:00.000Z",
    actor: { actor_type: "system", actor_id: null },
    subject: { subject_type: "payer", subject_id: UUID_B },
    source: "api",
    correlation_id: UUID_D,
    causation_id: null,
    payload: {
      payer_id: UUID_B,
      lot_id: UUID_C,
      credits: 5,
      expires_at: "2026-12-17T10:00:00.000Z",
      trigger: "posting_approved",
      ...over,
    },
    metadata: { environment: "test", service: "api" },
  };
}

describe("payer.welcome_credits_granted", () => {
  it("is registered as a version-1 event in the payer domain", () => {
    expect(isEventName("payer.welcome_credits_granted")).toBe(true);
    expect(EVENT_REGISTRY["payer.welcome_credits_granted"]).toMatchObject({
      version: 1,
      domain: "payer",
    });
  });

  it("the triggers are exactly the three the grant knows", () => {
    expect([...WELCOME_CREDITS_TRIGGERS]).toEqual([
      "posting_approved",
      "company_updated",
      "company_import",
    ]);
  });

  it.each(WELCOME_CREDITS_TRIGGERS.map((t) => [t]))("accepts trigger %s", (trigger) => {
    expect(validateEvent(welcomeEvent({ trigger })).success).toBe(true);
  });

  it.each([
    ["an unknown trigger", { trigger: "signup" }],
    ["zero credits", { credits: 0 }],
    ["a fractional count", { credits: 2.5 }],
    ["a non-uuid lot", { lot_id: "lot-1" }],
    ["a company name riding along", { org_name: "Acme Works" }],
    ["a GSTIN riding along", { gst_number: "27AAPFU0939F1ZV" }],
  ])("refuses %s", (_label, over) => {
    expect(validateEvent(welcomeEvent(over)).success).toBe(false);
  });

  it("createEvent keeps the payload whole, and the shape is pinned", () => {
    expect(createEvent(welcomeEvent() as never).payload).toEqual({
      payer_id: UUID_B,
      lot_id: UUID_C,
      credits: 5,
      expires_at: "2026-12-17T10:00:00.000Z",
      trigger: "posting_approved",
    });
    const def = EVENT_REGISTRY["payer.welcome_credits_granted"];
    expect(Object.keys(def.payload.shape).sort()).toEqual([
      "credits",
      "expires_at",
      "lot_id",
      "payer_id",
      "trigger",
    ]);
  });
});
