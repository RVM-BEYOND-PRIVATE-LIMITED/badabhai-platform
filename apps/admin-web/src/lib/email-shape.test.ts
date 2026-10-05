import { describe, expect, it } from "vitest";
import { looksLikeAdminEmail } from "./email-shape";

/**
 * #1937/#1946 — the admin-invite email-shape check is linear and agrees with the
 * pre-fix anchored pattern wherever the old pattern was safe to run (strings
 * ≤ 254 chars), while refusing the over-length inputs the shared `emailSchema.max(254)`
 * rejects anyway.
 */
describe("looksLikeAdminEmail (#1937/#1946)", () => {
  // THE PRE-#1946 anchored shape, frozen as the oracle. It is quadratic, so it
  // only ever sees bounded strings in this file.
  const PRE_1946_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  it.each(["a@b.co", "first.last+tag@mail.example.co.in", "admin@acme.example"])(
    "accepts %j",
    (s) => {
      expect(looksLikeAdminEmail(s)).toBe(true);
      expect(PRE_1946_EMAIL_RE.test(s)).toBe(true);
    },
  );

  it.each(["", "a@b", "@b.com", "a @b.com", "a@ b.com", "a@.com", "a@b.", "user@localhost"])(
    "refuses the near-miss %j",
    (s) => {
      expect(looksLikeAdminEmail(s)).toBe(false);
      expect(PRE_1946_EMAIL_RE.test(s)).toBe(false);
    },
  );

  it("agrees with the pre-#1946 oracle on 2,000 seeded strings up to 254 chars", () => {
    let seed = 0x1937;
    const rng = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    const chars = [..."abcXYZ019._+-@ \u00e9\u0915"];
    const run = (max: number): string => {
      let out = "";
      for (let n = Math.floor(rng() * max); n > 0; n--) out += chars[Math.floor(rng() * chars.length)]!;
      return out;
    };
    for (let i = 0; i < 2_000; i++) {
      const s = run(20) + (rng() < 0.7 ? "@" : "") + run(20) + (rng() < 0.7 ? "." : "") + run(10);
      expect(looksLikeAdminEmail(s), JSON.stringify(s)).toBe(PRE_1946_EMAIL_RE.test(s));
    }
  });

  it("refuses an over-length address the oracle would accept", () => {
    const long = `${"l".repeat(300)}@acme.in`;
    expect(PRE_1946_EMAIL_RE.test(long)).toBe(true);
    expect(looksLikeAdminEmail(long)).toBe(false);
  });
});
