import { describe, expect, it } from "vitest";

import { CREDIT_LOT_EXPIRY_TRIGGERS, CREDIT_LOT_SOURCES } from "@badabhai/types";

import { createEvent, EVENT_REGISTRY, isEventName, validateEvent } from "./index";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";
const UUID_D = "44444444-4444-4444-8444-444444444444";

/**
 * `payer.credits_expired` (#2749). The contract under test: the wallet key, the lot, a POSITIVE
 * count of credits, the lot's closed source, its date and the closed trigger, `.strict()` — ids,
 * numbers and codes only, so no price, payment reference or name can ride along.
 */
function expiredEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: UUID_A,
    event_name: "payer.credits_expired",
    event_version: 1,
    occurred_at: "2026-11-16T10:00:00.000Z",
    actor: { actor_type: "system", actor_id: null },
    subject: { subject_type: "payer", subject_id: UUID_B },
    source: "api",
    correlation_id: UUID_D,
    causation_id: null,
    payload: {
      payer_id: UUID_B,
      lot_id: UUID_C,
      credits: 12,
      source: "pack",
      expires_at: "2026-11-15T18:30:00.000Z",
      trigger: "sweep",
      ...over,
    },
    metadata: { environment: "test", service: "api" },
  };
}

describe("payer.credits_expired", () => {
  it("is registered as a version-1 event in the payer domain", () => {
    expect(isEventName("payer.credits_expired")).toBe(true);
    expect(EVENT_REGISTRY["payer.credits_expired"]).toMatchObject({
      version: 1,
      domain: "payer",
    });
  });

  it.each(CREDIT_LOT_EXPIRY_TRIGGERS.map((t) => [t]))(
    "validates an expiry closed by a %s",
    (trigger) => {
      const event = expiredEvent({ trigger });
      if (trigger === "spend") event.actor = { actor_type: "payer", actor_id: UUID_A };
      expect(validateEvent(event).success).toBe(true);
      expect(createEvent(event as never).payload).toEqual({
        payer_id: UUID_B,
        lot_id: UUID_C,
        credits: 12,
        source: "pack",
        expires_at: "2026-11-15T18:30:00.000Z",
        trigger,
      });
    },
  );

  it("pins the payload SHAPE, the source set and the trigger set", () => {
    const def = EVENT_REGISTRY["payer.credits_expired"];
    expect(Object.keys(def.payload.shape).sort()).toEqual([
      "credits",
      "expires_at",
      "lot_id",
      "payer_id",
      "source",
      "trigger",
    ]);
    expect(def.payload.shape.source.options).toEqual([...CREDIT_LOT_SOURCES]);
    expect(def.payload.shape.trigger.options).toEqual([...CREDIT_LOT_EXPIRY_TRIGGERS]);
  });

  it("accepts every lot source", () => {
    for (const source of CREDIT_LOT_SOURCES) {
      expect(validateEvent(expiredEvent({ source })).success, source).toBe(true);
    }
  });

  it("is STRICT: a price, a payment reference, a name or a balance cannot ride along", () => {
    for (const smuggled of [
      "price_inr",
      "payment_ref",
      "pack_code",
      "org_name",
      "email",
      "balance_after",
    ]) {
      const result = validateEvent(expiredEvent({ [smuggled]: "x" }));
      expect(result.success, smuggled).toBe(false);
      if (!result.success) expect(result.error.stage).toBe("payload");
    }
  });

  it("refuses zero or fractional credits, a source or trigger outside the sets, a bad date or id", () => {
    for (const over of [
      { credits: 0 },
      { credits: -3 },
      { credits: 1.5 },
      { source: "grant" },
      { trigger: "admin" },
      { expires_at: "yesterday" },
      { lot_id: "not-a-uuid" },
      { payer_id: "not-a-uuid" },
    ]) {
      expect(validateEvent(expiredEvent(over)).success, JSON.stringify(over)).toBe(false);
    }
  });
});
