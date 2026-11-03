import { describe, it, expect } from "vitest";
import {
  PASSWORD_MAX_CHARS,
  PASSWORD_MIN_CHARS,
  generateTemporaryPassword,
  newPasswordPairReady,
  newPasswordSchema,
  passwordPolicyProblem,
  presentedPasswordSchema,
} from "./password-policy";

/**
 * The client copy of the admin password policy (ADR-0060) must agree with the server's —
 * `PayerPasswordSetSchema` in apps/api (8–128 chars, `/^(?=.*[A-Za-z])(?=.*\d).+$/`) — in BOTH
 * directions: a password it calls fine and the server refuses is a confusing round trip; one it
 * refuses and the server would take is an operator locked out of a valid choice.
 */
const SERVER_PATTERN = /^(?=.*[A-Za-z])(?=.*\d).+$/;
const serverAccepts = (v: string) => v.length >= 8 && v.length <= 128 && SERVER_PATTERN.test(v);

const SAMPLES = [
  "",
  "a1",
  "abcdefg1",
  "abcdefgh",
  "12345678",
  "        ",
  "pass word 1",
  "Ünïcödé1x",
  "ÄÖÜäöüß1", // a digit but no ASCII letter: the server's [A-Za-z] refuses it
  "a1".repeat(64),
  "a1".repeat(64) + "x",
  "line\nbreak1",
  "!@#$%^&*a9",
];

const label = (s: string) => JSON.stringify(s.length > 20 ? `${s.slice(0, 12)}…(${s.length})` : s);

describe("the policy matches the server's, sample by sample", () => {
  for (const sample of SAMPLES) {
    it(label(sample), () => {
      expect(newPasswordSchema.safeParse(sample).success).toBe(serverAccepts(sample));
      expect(passwordPolicyProblem(sample) === null).toBe(serverAccepts(sample));
    });
  }

  it("the bounds are the server's", () => {
    expect(PASSWORD_MIN_CHARS).toBe(8);
    expect(PASSWORD_MAX_CHARS).toBe(128);
  });
});

describe("passwordPolicyProblem says what to fix", () => {
  it("names the first unmet rule", () => {
    expect(passwordPolicyProblem("a1")).toMatch(/at least 8/);
    expect(passwordPolicyProblem("abcdefgh")).toMatch(/digit/);
    expect(passwordPolicyProblem("12345678")).toMatch(/letter/);
    expect(passwordPolicyProblem("a1".repeat(65))).toMatch(/at most 128/);
  });
});

describe("newPasswordPairReady", () => {
  it("needs a passing password AND a matching confirmation", () => {
    expect(newPasswordPairReady("MyOwnPass9", "MyOwnPass9")).toBe(true);
    expect(newPasswordPairReady("MyOwnPass9", "MyOwnPass8")).toBe(false);
    expect(newPasswordPairReady("weakweak", "weakweak")).toBe(false);
  });
});

describe("presentedPasswordSchema (sign-in, current password)", () => {
  it("is bounded but NOT policy-checked — an old weak password must still sign in", () => {
    expect(presentedPasswordSchema.safeParse("abc").success).toBe(true);
    expect(presentedPasswordSchema.safeParse("").success).toBe(false);
    expect(presentedPasswordSchema.safeParse("x".repeat(129)).success).toBe(false);
  });
});

describe("generateTemporaryPassword", () => {
  it("always satisfies the policy, at the requested length", () => {
    for (let i = 0; i < 200; i++) {
      const p = generateTemporaryPassword();
      expect(p).toHaveLength(16);
      expect(serverAccepts(p), p).toBe(true);
    }
    expect(generateTemporaryPassword(24)).toHaveLength(24);
  });

  it("leaves out the characters that are misread aloud (0/O, 1/l/I)", () => {
    const all = Array.from({ length: 200 }, () => generateTemporaryPassword()).join("");
    expect(all).not.toMatch(/[0O1lI]/);
  });

  it("is not a constant", () => {
    const seen = new Set(Array.from({ length: 20 }, () => generateTemporaryPassword()));
    expect(seen.size).toBe(20);
  });
});
