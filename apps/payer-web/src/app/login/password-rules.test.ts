import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CONFIRM_MISMATCH,
  NEW_PASSWORD_ERRORS,
  PASSWORD_MAX_CHARS,
  PASSWORD_MIN_CHARS,
  newPasswordChecks,
  newPasswordChecksSummary,
  newPasswordRefusal,
} from "./password-rules";

/**
 * #2587 — the new-password rule mirror agrees with the SERVER's policy (#2628's
 * `PasswordPolicySchema`, rebuilt here from the contract as the oracle) on everything it accepts or
 * refuses, adds only the "not the temporary password" rule the API also enforces, and its copy is
 * plain, short, Latin-script English that never carries a password.
 */
const SERVER_POLICY = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(128, "Password must be at most 128 characters")
  .regex(/^(?=.*[A-Za-z])(?=.*\d).+$/, "Password must include at least one letter and one digit");

describe("newPasswordRefusal — the server's policy, mirrored", () => {
  it("bounds are the contract's: 8 to 128", () => {
    expect([PASSWORD_MIN_CHARS, PASSWORD_MAX_CHARS]).toEqual([8, 128]);
  });

  it.each([
    ["abc1", "too_short"],
    ["a1".repeat(64) + "x", "too_long"],
    ["onlyletters", "letter_and_digit"],
    ["12345678", "letter_and_digit"],
    ["abcd123\n4", "letter_and_digit"], // a line break defeats the server's `.+`
    ["Xk7mPq2rTn9wZa", "same_as_temporary"],
    ["my-own-pass-42", null],
    ["a".repeat(127) + "1", null],
  ] as const)("%j → %s", (value, refusal) => {
    expect(newPasswordRefusal(value, "Xk7mPq2rTn9wZa")).toBe(refusal);
  });

  it("agrees with the server's schema on 3,000 seeded candidates (accept ⇔ accept)", () => {
    let seed = 0x2587;
    const rng = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    const chars = [..."abcXYZ0129 -_!@éक\n"];
    for (let i = 0; i < 3000; i++) {
      let s = "";
      for (let n = Math.floor(rng() * 20); n > 0; n--) s += chars[Math.floor(rng() * chars.length)]!;
      // A temporary password that never collides, so only the policy is compared.
      expect(newPasswordRefusal(s, "\u0000never") === null, JSON.stringify(s)).toBe(
        SERVER_POLICY.safeParse(s).success,
      );
    }
  });

  it("never trims: spaces are characters, exactly as the server counts them", () => {
    expect(newPasswordRefusal("  abc1  ", "temp")).toBeNull();
    expect(newPasswordRefusal(" abc1 ", "temp")).toBe("too_short");
  });
});

describe("newPasswordChecks — the checklist the payer watches", () => {
  const met = (value: string, confirm: string, temporary = "Xk7mPq2rTn9wZa") =>
    newPasswordChecks(value, confirm, temporary)
      .filter((c) => c.met)
      .map((c) => c.id);

  it("nothing typed meets nothing", () => {
    expect(met("", "")).toEqual([]);
  });

  it("each rule ticks on its own", () => {
    expect(met("a", "")).toEqual(["letter", "differs"]);
    expect(met("1", "")).toEqual(["digit", "differs"]);
    expect(met("abcdefgh", "")).toEqual(["length", "letter", "differs"]);
    expect(met("abcdefg1", "abcdefg")).toEqual(["length", "letter", "digit", "differs"]);
    expect(met("abcdefg1", "abcdefg1")).toEqual(["length", "letter", "digit", "differs", "matches"]);
  });

  it("the temporary password itself never meets 'differs', even when it meets the policy", () => {
    expect(met("Xk7mPq2rTn9wZa", "Xk7mPq2rTn9wZa")).not.toContain("differs");
  });

  it("the live summary is silent before typing, then counts", () => {
    const checks = newPasswordChecks("abc", "", "temp");
    expect(newPasswordChecksSummary(checks, false)).toBe("");
    expect(newPasswordChecksSummary(checks, true)).toBe("2 of 5 password rules met.");
    expect(newPasswordChecksSummary(newPasswordChecks("abcdefg1", "abcdefg1", "temp"), true)).toBe(
      "All password rules met.",
    );
  });
});

describe("the copy — plain, short, Latin script, about the value never the account", () => {
  const ALL = [
    ...Object.values(NEW_PASSWORD_ERRORS),
    CONFIRM_MISMATCH,
    ...newPasswordChecks("", "", "").map((c) => c.label),
  ];

  it.each(ALL)("%j", (line) => {
    // ASCII letters/punctuation plus the typographic apostrophe the app writes.
    expect(line).toMatch(/^[\x20-\x7E’]+$/);
    expect(line.length).toBeLessThanOrEqual(64);
    expect(line).not.toMatch(/account|registered|exists|unknown|not found/i);
  });

  it("one message per refused rule", () => {
    expect(Object.keys(NEW_PASSWORD_ERRORS).sort()).toEqual(
      ["letter_and_digit", "other", "same_as_temporary", "too_long", "too_short"].sort(),
    );
  });
});
