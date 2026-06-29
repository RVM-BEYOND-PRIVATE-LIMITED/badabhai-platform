import { describe, it, expect } from "vitest";
import {
  ADMIN_PII_REVEAL_NOTE_MAX,
  AdminPiiRevealParamsSchema,
  AdminPiiRevealSchema,
  noteHasResidualPii,
} from "./admin-pii-reveal.dto";

/**
 * DTO control tests for ADMIN-3b (ADR-0025 Decision 4):
 *   Control 2 — reason-required, CLOSED enum (missing/invalid → reject).
 *   Control 3 — the optional note is length-bounded AND residual-PII-rejected; `.strict()` rejects
 *               any extra (PII-shaped) key.
 *   Control 6 — the path param is a single uuid (no list/range/wildcard).
 */

describe("ADMIN-3b reveal DTO — reason-required closed enum (Control 2)", () => {
  it("accepts each of the three sanctioned reason codes", () => {
    for (const reason_code of ["worker_support_callback", "dispute_resolution", "safety_escalation"]) {
      expect(AdminPiiRevealSchema.safeParse({ reason_code }).success).toBe(true);
    }
  });

  it("rejects a MISSING reason_code (no reveal without a reason)", () => {
    expect(AdminPiiRevealSchema.safeParse({}).success).toBe(false);
  });

  it("rejects an UNKNOWN reason_code (closed enum — no free text)", () => {
    expect(AdminPiiRevealSchema.safeParse({ reason_code: "because_i_can" }).success).toBe(false);
    expect(AdminPiiRevealSchema.safeParse({ reason_code: "" }).success).toBe(false);
  });
});

describe("ADMIN-3b reveal DTO — note PII-safe + bounded (Control 3, must-fix #6)", () => {
  const reason_code = "worker_support_callback";

  it("accepts a short, PII-free note", () => {
    const r = AdminPiiRevealSchema.safeParse({ reason_code, note: "Worker requested a callback re application." });
    expect(r.success).toBe(true);
  });

  it("accepts an omitted note (optional)", () => {
    expect(AdminPiiRevealSchema.safeParse({ reason_code }).success).toBe(true);
  });

  it("rejects a note over the length bound (≤280)", () => {
    const long = "a".repeat(ADMIN_PII_REVEAL_NOTE_MAX + 1);
    expect(AdminPiiRevealSchema.safeParse({ reason_code, note: long }).success).toBe(false);
  });

  it("REJECTS a note containing a phone-shaped digit run (residual PII → 400)", () => {
    for (const note of [
      "call back on 9876543210",
      "his number is +91 98765 43210",
      "ph: 080-2345-6789",
    ]) {
      expect(AdminPiiRevealSchema.safeParse({ reason_code, note }).success, note).toBe(false);
    }
  });

  it("REJECTS a note containing a long digit run (Aadhaar/account — residual numeric PII)", () => {
    expect(AdminPiiRevealSchema.safeParse({ reason_code, note: "aadhaar 123456789012" }).success).toBe(
      false,
    );
  });

  it("REJECTS a note containing an email (another contact channel)", () => {
    expect(
      AdminPiiRevealSchema.safeParse({ reason_code, note: "reach at worker@example.com" }).success,
    ).toBe(false);
  });

  it("rejects an extra (PII-shaped) key — .strict() (no value can ride in)", () => {
    expect(
      AdminPiiRevealSchema.safeParse({ reason_code, phone: "+919876543210" }).success,
    ).toBe(false);
    expect(AdminPiiRevealSchema.safeParse({ reason_code, worker_id: "x" }).success).toBe(false);
  });

  it("noteHasResidualPii flags contact-shaped notes and passes clean ones", () => {
    expect(noteHasResidualPii("9876543210")).toBe(true);
    expect(noteHasResidualPii("a@b.com")).toBe(true);
    expect(noteHasResidualPii("123456789012")).toBe(true);
    expect(noteHasResidualPii("safety concern raised at the unit, follow up")).toBe(false);
  });
});

describe("ADMIN-3b reveal params — single uuid (Control 6, no IDOR)", () => {
  it("accepts a uuid path param", () => {
    expect(
      AdminPiiRevealParamsSchema.safeParse({ id: "dddddddd-0000-4000-8000-000000000004" }).success,
    ).toBe(true);
  });

  it("rejects a non-uuid id (no list/range/wildcard)", () => {
    expect(AdminPiiRevealParamsSchema.safeParse({ id: "all" }).success).toBe(false);
    expect(AdminPiiRevealParamsSchema.safeParse({ id: "1,2,3" }).success).toBe(false);
    expect(AdminPiiRevealParamsSchema.safeParse({ id: "*" }).success).toBe(false);
  });

  it("rejects an extra param key (.strict)", () => {
    expect(
      AdminPiiRevealParamsSchema.safeParse({
        id: "dddddddd-0000-4000-8000-000000000004",
        id2: "x",
      }).success,
    ).toBe(false);
  });
});
