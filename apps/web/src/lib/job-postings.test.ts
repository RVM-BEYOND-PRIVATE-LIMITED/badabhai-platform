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
