import { describe, expect, it } from "vitest";

import { CREDIT_CALL_RESULTS } from "@badabhai/types";

import { EVENT_REGISTRY, isEventName, validateEvent } from "./index";

const PAYER = "11111111-1111-4111-8111-111111111111";
const ADMIN = "22222222-2222-4222-8222-222222222222";
const CALL = "55555555-5555-4555-8555-555555555555";
const CORRELATION = "33333333-3333-4333-8333-333333333333";

/**
 * `admin.credit_call_logged` (#2755 item 8). The contract: the company, the call row, the admin and
 * one closed result code, `.strict()` — never a name, a phone or a note.
 */
function event(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    event_id: "44444444-4444-4444-8444-444444444444",
    event_name: "admin.credit_call_logged",
    event_version: 1,
    occurred_at: "2026-11-17T10:00:00.000Z",
    actor: { actor_type: "admin", actor_id: ADMIN },
    subject: { subject_type: "payer", subject_id: PAYER },
    source: "api",
    correlation_id: CORRELATION,
    causation_id: null,
    payload,
    metadata: { environment: "test", service: "api" },
  };
}

const logged = (over: Record<string, unknown> = {}) =>
  event({ payer_id: PAYER, call_id: CALL, admin_id: ADMIN, result: "no_answer", ...over });

describe("admin.credit_call_logged", () => {
  it("is registered as a version-1 admin event", () => {
    expect(isEventName("admin.credit_call_logged")).toBe(true);
    expect(EVENT_REGISTRY["admin.credit_call_logged"]).toMatchObject({
      version: 1,
      domain: "admin",
    });
  });

  it("the result is one of the five closed codes", () => {
    expect([...CREDIT_CALL_RESULTS]).toEqual([
      "reached_will_buy",
      "reached_not_now",
      "reached_declined",
      "no_answer",
      "wrong_number",
    ]);
    for (const result of CREDIT_CALL_RESULTS) {
      expect(validateEvent(logged({ result })).success, result).toBe(true);
    }
    for (const bad of ["busy", "Reached", "", undefined, null]) {
      expect(validateEvent(logged({ result: bad })).success, String(bad)).toBe(false);
    }
  });

  it("needs the company, the call and the admin, each a uuid", () => {
    expect(validateEvent(logged()).success).toBe(true);
    for (const key of ["payer_id", "call_id", "admin_id"]) {
      expect(validateEvent(logged({ [key]: undefined })).success, key).toBe(false);
      expect(validateEvent(logged({ [key]: null })).success, key).toBe(false);
      expect(validateEvent(logged({ [key]: "acme" })).success, key).toBe(false);
    }
  });

  it("is STRICT: a name, a phone or a free-text note cannot ride along", () => {
    for (const smuggled of [
      { org_name: "Acme" },
      { phone: "+919876543210" },
      { note: "call back Monday" },
      { reason: "busy" },
    ]) {
      expect(validateEvent(logged(smuggled)).success, Object.keys(smuggled)[0]).toBe(false);
    }
  });
});
