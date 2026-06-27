import { describe, it, expect } from "vitest";
import {
  generateTotpEnrollment,
  verifyTotp,
  currentTotpCode,
  base32Encode,
  base32Decode,
} from "./admin-mfa";

/**
 * TOTP (RFC 6238) self-factor — implemented with Node `crypto` ONLY (no new dependency,
 * CLAUDE.md §3 stack-lock). This suite proves the round-trip, the ±1 step skew window, the
 * digit/format rejection, and the RFC 6238 Appendix-B reference vector (SHA1, 8-digit) so the
 * implementation is provably correct, not just self-consistent.
 */
describe("admin TOTP (RFC 6238, Node crypto only)", () => {
  const ISSUER = "BadaBhai Admin";
  const ACCOUNT = "11111111-1111-4111-8111-111111111111"; // an opaque admin id (NOT an email)

  it("enrollment yields a base32 secret + an otpauth URI carrying it (no PII in the label)", () => {
    const { secret, otpauthUri } = generateTotpEnrollment(ISSUER, ACCOUNT);
    expect(secret).toMatch(/^[A-Z2-7]+$/); // RFC 4648 base32, no padding
    expect(otpauthUri.startsWith("otpauth://totp/")).toBe(true);
    expect(otpauthUri).toContain(`secret=${secret}`);
    expect(otpauthUri).toContain("issuer=BadaBhai+Admin");
    // The account label is the opaque admin id — never an email.
    expect(otpauthUri).toContain(encodeURIComponent(ACCOUNT));
    expect(otpauthUri).not.toContain("@"); // no email in the QR/URI
  });

  it("a freshly-generated current code verifies (round-trip)", () => {
    const { secret } = generateTotpEnrollment(ISSUER, ACCOUNT);
    const code = currentTotpCode(secret);
    expect(verifyTotp(secret, code)).toBe(true);
  });

  it("accepts a code from the PREVIOUS and NEXT step (±1 skew), rejects ±2", () => {
    const { secret } = generateTotpEnrollment(ISSUER, ACCOUNT);
    const now = new Date("2026-06-27T12:00:30.000Z");
    const prev = currentTotpCode(secret, {}, new Date(now.getTime() - 30_000));
    const next = currentTotpCode(secret, {}, new Date(now.getTime() + 30_000));
    const far = currentTotpCode(secret, {}, new Date(now.getTime() - 60_000));
    expect(verifyTotp(secret, prev, {}, now)).toBe(true);
    expect(verifyTotp(secret, next, {}, now)).toBe(true);
    // ±2 steps is outside the default skew window of 1.
    expect(verifyTotp(secret, far, {}, now)).toBe(false);
  });

  it("rejects a wrong/short/non-numeric code (no skew bypass)", () => {
    const { secret } = generateTotpEnrollment(ISSUER, ACCOUNT);
    expect(verifyTotp(secret, "000000")).toBe(false); // (vanishingly unlikely to be valid)
    expect(verifyTotp(secret, "12345")).toBe(false); // too short
    expect(verifyTotp(secret, "abcdef")).toBe(false); // non-numeric
    expect(verifyTotp(secret, "")).toBe(false);
  });

  it("rejects against a malformed secret (never throws into the auth path)", () => {
    expect(verifyTotp("not!base32", "123456")).toBe(false);
    expect(verifyTotp("", "123456")).toBe(false);
  });

  it("base32 encode/decode round-trips arbitrary bytes", () => {
    const buf = Buffer.from([0, 1, 2, 250, 255, 128, 64, 17]);
    expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
  });

  it("matches the RFC 6238 Appendix-B SHA1 reference vector (8-digit, T=59 → 94287082)", () => {
    // RFC 6238 test seed "12345678901234567890" (ASCII) at unix time 59s, 8 digits, SHA1.
    const seedBase32 = base32Encode(Buffer.from("12345678901234567890", "ascii"));
    const code = currentTotpCode(seedBase32, { digits: 8 }, new Date(59_000));
    expect(code).toBe("94287082");
  });
});
