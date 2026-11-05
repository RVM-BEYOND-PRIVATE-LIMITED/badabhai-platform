import { describe, expect, it } from "vitest";
import { normalizeLoginIdentifier } from "./identifier";

/**
 * #2587 — the password sign-in login ID, sent the way `POST /payer/login/password` matches it
 * (email → E.164 phone → exact org name), mirroring the payer app's `normalizeIdentifier`.
 */
describe("normalizeLoginIdentifier", () => {
  it("an email is trimmed and otherwise sent as typed (the API decides matching)", () => {
    expect(normalizeLoginIdentifier("  Owner@Example.com ")).toBe("Owner@Example.com");
  });

  it.each([
    "9876543210",
    "98765 43210",
    "98765-43210",
    "098765 43210",
    "919876543210",
    "+91 98765 43210",
    "+919876543210",
    "(98765) 43210",
  ])("the Indian mobile %j is sent as E.164", (typed) => {
    expect(normalizeLoginIdentifier(typed)).toBe("+919876543210");
  });

  it("a full international number that is not a 10-digit Indian mobile passes through", () => {
    expect(normalizeLoginIdentifier(" +14155550123 ")).toBe("+14155550123");
  });

  it.each(["Acme Manufacturing", "24x7 Logistics", "Unit 1234567890 Tools", "12345"])(
    "the company name %j passes through (trimmed)",
    (name) => {
      expect(normalizeLoginIdentifier(`  ${name} `)).toBe(name);
    },
  );

  it("empty stays empty", () => {
    expect(normalizeLoginIdentifier("   ")).toBe("");
  });
});
