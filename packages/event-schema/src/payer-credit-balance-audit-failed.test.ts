import { describe, expect, it } from "vitest";

import { EVENT_REGISTRY, isEventName, validateEvent } from "./index";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_D = "44444444-4444-4444-8444-444444444444";

/**
 * `payer.credit_balance_audit_failed` (#2774). The contract under test: ONE alert per failing run,
 * counts and signed credit gaps only, `.strict()` — no wallet id can ride on the spine — and never
 * an all-zero "failure".
 */
function auditFailed(
  over: Record<string, unknown> = {},
  subject: Record<string, unknown> = { subject_type: "payer", subject_id: null },
): Record<string, unknown> {
  return {
    event_id: UUID_A,
    event_name: "payer.credit_balance_audit_failed",
    event_version: 1,
    occurred_at: "2026-11-19T21:30:00.000Z",
    actor: { actor_type: "system", actor_id: null },
    subject,
    source: "api",
    correlation_id: UUID_D,
    causation_id: null,
    payload: {
      wallets_checked: 120,
      ledger_mismatches: 1,
      lot_mismatches: 2,
      orphan_wallets: 0,
      ledger_gap_credits: -5,
      lot_gap_credits: 7,
      ...over,
    },
    metadata: { environment: "test", service: "api" },
  };
}

describe("payer.credit_balance_audit_failed (#2774)", () => {
  it("is a registered v1 name in the payer domain", () => {
    expect(isEventName("payer.credit_balance_audit_failed")).toBe(true);
    expect(EVENT_REGISTRY["payer.credit_balance_audit_failed"]).toMatchObject({
      version: 1,
      domain: "payer",
    });
  });

  it("validates a system alert on the aggregate payer subject, signed gaps allowed", () => {
    expect(validateEvent(auditFailed()).success).toBe(true);
    expect(validateEvent(auditFailed({ ledger_gap_credits: 3, lot_gap_credits: -3 })).success).toBe(
      true,
    );
  });

  it("an orphan wallet alone is a failure", () => {
    expect(
      validateEvent(
        auditFailed({
          ledger_mismatches: 0,
          lot_mismatches: 0,
          orphan_wallets: 1,
          ledger_gap_credits: 0,
          lot_gap_credits: 0,
        }),
      ).success,
    ).toBe(true);
  });

  it("refuses an all-zero failure: a clean run emits nothing", () => {
    const result = validateEvent(
      auditFailed({
        ledger_mismatches: 0,
        lot_mismatches: 0,
        orphan_wallets: 0,
        ledger_gap_credits: 0,
        lot_gap_credits: 0,
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.stage).toBe("payload");
  });

  it("is strict: no wallet id, list or other field can ride along", () => {
    for (const extra of [{ payer_id: UUID_A }, { wallet_ids: [UUID_A] }, { note: "x" }]) {
      expect(validateEvent(auditFailed(extra)).success, JSON.stringify(extra)).toBe(false);
    }
  });

  it("refuses negative or fractional counts", () => {
    expect(validateEvent(auditFailed({ ledger_mismatches: -1 })).success).toBe(false);
    expect(validateEvent(auditFailed({ wallets_checked: 1.5 })).success).toBe(false);
    expect(validateEvent(auditFailed({ lot_gap_credits: 0.5 })).success).toBe(false);
  });
});
