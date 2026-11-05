import { describe, it, expect } from "vitest";
import {
  PayerSignupSchema,
  PayerLoginRequestSchema,
  PayerLoginVerifySchema,
  PayerPasswordSetSchema,
  PayerPasswordLoginSchema,
} from "./payer-auth.dto";

/**
 * #2497 — contract tests for phone-optional signup/login + the password DTOs.
 *
 * The schemas are the server-side authority (the Flutter client mirrors the policy
 * but never decides it): at-least-one-contact on every OTP door, 8–128 letter+digit
 * on set, and a bounded-but-unjudging identifier+password on password login (every
 * well-formed attempt burns one KDF verify — no short-password oracle).
 */
describe("payer auth contact-flexible DTOs (#2497)", () => {
  it("signup accepts email-only (unchanged), phone-only, or both — never neither", () => {
    expect(
      PayerSignupSchema.safeParse({ role: "employer", email: "a@b.com", org_name: "X" }).success,
    ).toBe(true);
    expect(
      PayerSignupSchema.safeParse({ role: "agent", org_name: "X", phone: "+919876543210" }).success,
    ).toBe(true);
    expect(
      PayerSignupSchema.safeParse({
        role: "employer",
        email: "a@b.com",
        org_name: "X",
        phone: "+919876543210",
      }).success,
    ).toBe(true);
    expect(PayerSignupSchema.safeParse({ role: "employer", org_name: "X" }).success).toBe(false);
  });

  it("email normalizes (trim + lowercase) and phone stays strict E.164", () => {
    const parsed = PayerSignupSchema.safeParse({
      role: "employer",
      email: "  Boss@Acme.com ",
      org_name: "Acme",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.email).toBe("boss@acme.com");
    // Non-E.164 phones are rejected, not normalized into shape.
    expect(
      PayerSignupSchema.safeParse({ role: "agent", org_name: "X", phone: "9876543210" }).success,
    ).toBe(false);
    expect(
      PayerSignupSchema.safeParse({ role: "agent", org_name: "X", phone: "+91 98765 43210" })
        .success,
    ).toBe(false);
  });

  it("login request/verify take the same email-or-phone shape (request and verify MUST match)", () => {
    expect(PayerLoginRequestSchema.safeParse({ phone: "+919876543210" }).success).toBe(true);
    expect(PayerLoginRequestSchema.safeParse({}).success).toBe(false);
    expect(
      PayerLoginVerifySchema.safeParse({ email: "a@b.com", code: "1234" }).success,
    ).toBe(true);
    expect(
      PayerLoginVerifySchema.safeParse({ phone: "+919876543210", code: "123456" }).success,
    ).toBe(true);
    expect(PayerLoginVerifySchema.safeParse({ email: "a@b.com", code: "12" }).success).toBe(
      false,
    );
  });
});

describe("payer password set policy (#2497 — server is the authority)", () => {
  it("accepts 8–128 chars with at least one letter and one digit", () => {
    for (const good of ["Correct19", "correcthorse9", "s3cureP@ss", "x".repeat(118) + "a1"]) {
      expect(PayerPasswordSetSchema.safeParse({ password: good }).success, good).toBe(true);
    }
  });

  it("rejects short, over-long, letterless and digitless passwords", () => {
    for (const bad of [
      "short1!", // 7 chars
      "alllettershere", // no digit
      "123456789012", // no letter
      "        ", // whitespace only, no letter/digit
      "x".repeat(129), // over 128
    ]) {
      expect(PayerPasswordSetSchema.safeParse({ password: bad }).success, bad).toBe(false);
    }
  });
});

describe("payer password login body (#2497)", () => {
  it("accepts any non-empty identifier up to 320 chars with any non-empty password up to 128", () => {
    for (const identifier of ["boss@acme.com", "+919876543210", "Acme Manufacturing", "x".repeat(320)]) {
      expect(
        PayerPasswordLoginSchema.safeParse({ identifier, password: "whatever1" }).success,
        identifier,
      ).toBe(true);
    }
  });

  it("rejects blank identifiers and unbounded/empty passwords (never an unbounded KDF input)", () => {
    expect(
      PayerPasswordLoginSchema.safeParse({ identifier: "   ", password: "whatever1" }).success,
    ).toBe(false);
    expect(PayerPasswordLoginSchema.safeParse({ identifier: "a@b.com", password: "" }).success).toBe(
      false,
    );
    expect(
      PayerPasswordLoginSchema.safeParse({ identifier: "a@b.com", password: "x".repeat(129) })
        .success,
    ).toBe(false);
  });
});
