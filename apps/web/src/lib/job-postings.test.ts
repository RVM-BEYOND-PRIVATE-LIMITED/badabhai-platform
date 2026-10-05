import { describe, it, expect } from "vitest";
import { looksLikePii } from "@badabhai/validators";
import { descriptionLooksLikePii } from "./job-postings";

describe("job-postings — client-side looksLikePii parity", () => {
  it("matches the shared validator for email-like strings", () => {
    const inputs = [
      "contact me at foo@bar.com",
      "my email is a@b.co",
      "not an email",
      "plain text with no email",
      "alias@domain",
    ];
    for (const s of inputs) {
      expect(descriptionLooksLikePii(s)).toBe(looksLikePii(s));
    }
  });

  it("matches the shared validator for phone-like strings", () => {
    const inputs = [
      "call 9876543210",
      "+91 98765 43210",
      "123-456-7890",
      "short 123",
      "98765",
    ];
    for (const s of inputs) {
      expect(descriptionLooksLikePii(s)).toBe(looksLikePii(s));
    }
  });

  it("matches the shared validator for mixed / edge cases", () => {
    const inputs = [
      "",
      "   ",
      "a".repeat(100),
      "no digits or at-signs here",
      "hello.world@example",
    ];
    for (const s of inputs) {
      expect(descriptionLooksLikePii(s)).toBe(looksLikePii(s));
    }
  });
});

// #1946 — the client email mirror is linear, and no verdict moved.
describe("job-postings — email mirror is the linear shape (#1946)", () => {
  // THE PRE-#1924 client oracle: the quadratic email pattern plus the same phone
  // rule. Its email scan is quadratic, so it only ever sees short strings here.
  const PRE_1946_EMAIL_LIKE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
  const pre1946DescriptionLooksLikePii = (s: string): boolean =>
    PRE_1946_EMAIL_LIKE.test(s) || /\d{7,}/.test(s.replace(/[\s().+-]/g, ""));

  it.each([
    "contact me at foo@bar.com",
    "my email is a@b.co",
    "Mail ravi.kumar@gmail.com now",
    "first.last+tag@mail.example.co.in",
    "alias@domain",
    "not an email",
    "rate @ 500.00",
    "user@localhost",
  ])("agrees with the pre-#1946 oracle on %j", (s) => {
    expect(descriptionLooksLikePii(s)).toBe(pre1946DescriptionLooksLikePii(s));
  });

  it("agrees with the pre-#1946 oracle on 2,000 seeded strings", () => {
    let seed = 0x1946;
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
      const s = run(12) + (rng() < 0.7 ? "@" : "") + run(12) + (rng() < 0.7 ? "." : "") + run(6);
      expect(descriptionLooksLikePii(s), JSON.stringify(s)).toBe(
        pre1946DescriptionLooksLikePii(s),
      );
    }
  });
});
