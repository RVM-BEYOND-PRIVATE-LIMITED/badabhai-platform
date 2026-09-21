import { describe, expect, it } from "vitest";

import {
  VERIFICATION_BADGE_LABEL,
  VERIFICATION_STATES,
  isVerificationState,
  verificationBadgeFor,
} from "./verification-tier";

/**
 * ADR-0042 D9 / Layer A (g) — ASSUMPTIONS A1's contract, executable.
 *
 * Five states in the schema, two in the UI; absence reads neutral, never doubt; a self-claim is
 * not a platform verification.
 */
describe("verification-tier — five in the schema, two in the UI (ASSUMPTIONS A1)", () => {
  it("reserves Part 10's five-value vocabulary", () => {
    expect(VERIFICATION_STATES).toEqual([
      "self-declared",
      "RVM-attested",
      "document-verified",
      "EPFO-verified",
      "employer-rated",
    ]);
  });

  it("prints the ONE badge for the states that are BadaBhai verification", () => {
    for (const state of ["RVM-attested", "document-verified", "EPFO-verified"] as const) {
      expect(verificationBadgeFor(state)).toBe(VERIFICATION_BADGE_LABEL);
    }
    expect(VERIFICATION_BADGE_LABEL).toBe("BadaBhai Verified");
  });

  it("prints NOTHING for unverified, self-declared or employer-rated", () => {
    // `self-declared` is the worker's own claim: printing the platform badge for it would be a
    // false claim by BadaBhai. `employer-rated` is a rating, not a verification. Unverified is
    // absence, which must read neutral, never as doubt.
    expect(verificationBadgeFor(null)).toBeNull();
    expect(verificationBadgeFor(undefined)).toBeNull();
    expect(verificationBadgeFor("self-declared")).toBeNull();
    expect(verificationBadgeFor("employer-rated")).toBeNull();
  });

  it("fails closed to silence for an unknown or retired state", () => {
    expect(verificationBadgeFor("platinum-verified")).toBeNull();
    expect(verificationBadgeFor("")).toBeNull();
  });

  it("recognises exactly the closed vocabulary", () => {
    expect(isVerificationState("RVM-attested")).toBe(true);
    expect(isVerificationState("self-declared")).toBe(true);
    expect(isVerificationState("unverified")).toBe(false);
    expect(isVerificationState(null)).toBe(false);
    expect(isVerificationState(7)).toBe(false);
  });
});
