import { describe, expect, it } from "vitest";

import { EVENT_REGISTRY, isEventName, PAYER_TEST_ACCOUNT_REASONS, validateEvent } from "./index";

const PAYER = "11111111-1111-4111-8111-111111111111";
const ADMIN = "22222222-2222-4222-8222-222222222222";
const CORRELATION = "33333333-3333-4333-8333-333333333333";

/**
 * `admin.payer_test_account_marked` / `_unmarked` (#2755 item 2). The contract: the company, the
 * admin (null only for the backfill's mark) and one closed reason code, `.strict()`.
 */
function event(
  name: "admin.payer_test_account_marked" | "admin.payer_test_account_unmarked",
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    event_id: "44444444-4444-4444-8444-444444444444",
    event_name: name,
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

const marked = (over: Record<string, unknown> = {}) =>
  event("admin.payer_test_account_marked", {
    payer_id: PAYER,
    reason: "staff",
    admin_id: ADMIN,
    ...over,
  });
const unmarked = (over: Record<string, unknown> = {}) =>
  event("admin.payer_test_account_unmarked", { payer_id: PAYER, admin_id: ADMIN, ...over });

describe("admin.payer_test_account_marked / _unmarked", () => {
  it("are registered as version-1 admin events", () => {
    for (const name of ["admin.payer_test_account_marked", "admin.payer_test_account_unmarked"]) {
      expect(isEventName(name)).toBe(true);
      expect(EVENT_REGISTRY[name as keyof typeof EVENT_REGISTRY]).toMatchObject({
        version: 1,
        domain: "admin",
      });
    }
  });

  it("the reason is one of four closed codes", () => {
    expect([...PAYER_TEST_ACCOUNT_REASONS]).toEqual([
      "synthetic_sign_in",
      "staff",
      "rehearsal",
      "pilot_test",
    ]);
    for (const reason of PAYER_TEST_ACCOUNT_REASONS) {
      expect(validateEvent(marked({ reason })).success, reason).toBe(true);
    }
    expect(validateEvent(marked({ reason: "because" })).success).toBe(false);
    expect(validateEvent(marked({ reason: undefined })).success).toBe(false);
  });

  it("the mark's admin may be null (the backfill); the unmark's may not", () => {
    expect(validateEvent(marked({ admin_id: null, reason: "synthetic_sign_in" })).success).toBe(
      true,
    );
    expect(validateEvent(unmarked({ admin_id: null })).success).toBe(false);
    expect(validateEvent(unmarked()).success).toBe(true);
  });

  it("is STRICT: an email, a name, a phone or a free-text note cannot ride along", () => {
    for (const smuggled of [
      { email: "x@e2e.badabhai.invalid" },
      { org_name: "Acme" },
      { phone: "+919876543210" },
      { note: "staff test" },
    ]) {
      expect(validateEvent(marked(smuggled)).success, Object.keys(smuggled)[0]).toBe(false);
      expect(validateEvent(unmarked(smuggled)).success, Object.keys(smuggled)[0]).toBe(false);
    }
  });

  it("refuses a non-uuid company", () => {
    expect(validateEvent(marked({ payer_id: "acme" })).success).toBe(false);
    expect(validateEvent(unmarked({ payer_id: "acme" })).success).toBe(false);
  });
});
