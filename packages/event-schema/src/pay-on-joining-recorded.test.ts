import { describe, expect, it } from "vitest";

import { EVENT_DOMAINS } from "./enums";
import { createEvent, EVENT_REGISTRY, isEventName, validateEvent } from "./index";
import { POJ_HIRE_FIELDS, POJ_PAYMENT_STATES, POJ_RECORD_CHANGES } from "./payloads";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const ADMIN = "22222222-2222-4222-8222-222222222222";
const FACTORY = "33333333-3333-4333-8333-333333333333";
const CORRELATION = "44444444-4444-4444-8444-444444444444";
const WORKER = "55555555-5555-4555-8555-555555555555";
const PARTNER = "66666666-6666-4666-8666-666666666666";
const HIRE = "77777777-7777-4777-8777-777777777777";

/**
 * `pay_on_joining.recorded` (#2753 item 11). The contract under test: ids, paise integers and
 * closed values, `.strict()` (the admin's note cannot ride along), and the share pinned to the
 * server's floor arithmetic.
 */
function recordedEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: UUID_A,
    event_name: "pay_on_joining.recorded",
    event_version: 1,
    occurred_at: "2026-12-05T10:00:00.000Z",
    actor: { actor_type: "admin", actor_id: ADMIN },
    subject: { subject_type: "payer", subject_id: FACTORY },
    source: "api",
    correlation_id: CORRELATION,
    causation_id: null,
    payload: {
      hire_id: HIRE,
      change: "created",
      changed_fields: ["factory_payer_id", "worker_id", "joined_on", "fee_paise"],
      factory_payer_id: FACTORY,
      partner_payer_id: PARTNER,
      job_posting_id: null,
      worker_id: WORKER,
      fee_paise: 500_000,
      partner_share_percent: 70,
      partner_share_paise: 350_000,
      stayed_30_days: null,
      payment_state: "awaiting_factory",
      ...over,
    },
    metadata: { environment: "test", service: "api" },
  };
}

describe("pay_on_joining.recorded", () => {
  it("is registered as a version-1 event in its own pay_on_joining domain", () => {
    expect(isEventName("pay_on_joining.recorded")).toBe(true);
    expect(EVENT_DOMAINS).toContain("pay_on_joining");
    expect(EVENT_REGISTRY["pay_on_joining.recorded"]).toMatchObject({
      version: 1,
      domain: "pay_on_joining",
    });
  });

  it("validates a create and an edit, and keeps the payload exactly as sent", () => {
    for (const over of [
      {},
      {
        change: "updated",
        changed_fields: ["factory_paid_on", "note"],
        stayed_30_days: true,
        payment_state: "partner_due",
      },
      { partner_payer_id: null, job_posting_id: HIRE, payment_state: "settled" },
    ]) {
      const parsed = recordedEvent(over);
      expect(validateEvent(parsed).success, JSON.stringify(over)).toBe(true);
      expect(createEvent(parsed as never).payload).toEqual(parsed.payload);
    }
  });

  it("pins the payload SHAPE and its closed values", () => {
    const def = EVENT_REGISTRY["pay_on_joining.recorded"];
    expect(Object.keys(def.payload.shape).sort()).toEqual(
      [
        "change",
        "changed_fields",
        "factory_payer_id",
        "fee_paise",
        "hire_id",
        "job_posting_id",
        "partner_payer_id",
        "partner_share_paise",
        "partner_share_percent",
        "payment_state",
        "stayed_30_days",
        "worker_id",
      ].sort(),
    );
    expect([...POJ_RECORD_CHANGES]).toEqual(["created", "updated"]);
    expect([...POJ_PAYMENT_STATES]).toEqual(["awaiting_factory", "partner_due", "settled"]);
    // The share is never a field a client writes, so it is never a changed-field key either.
    expect(POJ_HIRE_FIELDS).not.toContain("partner_share_paise");
    expect(POJ_HIRE_FIELDS).not.toContain("partner_share_percent");
  });

  it("is STRICT: the note, a name, a phone or a company name cannot ride along", () => {
    for (const smuggled of [
      "note",
      "full_name",
      "phone",
      "org_name",
      "factory_name",
      "invoice_no",
    ]) {
      const result = validateEvent(recordedEvent({ [smuggled]: "x" }));
      expect(result.success, smuggled).toBe(false);
      if (!result.success) expect(result.error.stage).toBe("payload");
    }
  });

  it("refuses a share that is not the server's floor", () => {
    // 70% of ₹5,000.99 (500099 paise) = 350069.3 → 350069; 350070 would be a rounded-up share.
    expect(
      validateEvent(recordedEvent({ fee_paise: 500_099, partner_share_paise: 350_069 })).success,
    ).toBe(true);
    for (const share of [350_070, 350_068, 500_099]) {
      expect(
        validateEvent(recordedEvent({ fee_paise: 500_099, partner_share_paise: share })).success,
        String(share),
      ).toBe(false);
    }
  });

  it("holds the floor exactly for a fee where a float product would be wrong", () => {
    const fee = Number.MAX_SAFE_INTEGER; // 9007199254740991 * 70 is past 2^53
    const share = Number((BigInt(fee) * 70n) / 100n);
    expect(
      validateEvent(recordedEvent({ fee_paise: fee, partner_share_paise: share })).success,
    ).toBe(true);
  });

  it("refuses money that is negative, fractional or unsafe, and a percent outside 0..100", () => {
    for (const over of [
      { fee_paise: -1, partner_share_paise: 0 },
      { fee_paise: 100.5, partner_share_paise: 70 },
      { fee_paise: Number.MAX_SAFE_INTEGER + 2, partner_share_paise: 0 },
      { partner_share_percent: 101 },
      { partner_share_percent: -1 },
    ]) {
      expect(validateEvent(recordedEvent(over)).success, JSON.stringify(over)).toBe(false);
    }
  });

  it("refuses an empty, repeated or unknown changed-field key, and an unknown state or change", () => {
    for (const over of [
      { changed_fields: [] },
      { changed_fields: ["fee_paise", "fee_paise"] },
      { changed_fields: ["partner_share_paise"] },
      { changed_fields: ["note_text"] },
      { payment_state: "paid" },
      { change: "deleted" },
      { worker_id: "not-a-uuid" },
    ]) {
      expect(validateEvent(recordedEvent(over)).success, JSON.stringify(over)).toBe(false);
    }
  });
});
