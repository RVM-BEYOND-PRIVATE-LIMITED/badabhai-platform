import { describe, it, expect } from "vitest";

import { isMatchSkillId, matchSkillIndustry } from "@badabhai/taxonomy";
import { CONSENT_PURPOSES, CURRENT_CONSENT_VERSION } from "@badabhai/types";

import { FIXTURE, assertFixtureValid } from "./seed-e4-reach-fixture";

// The exact range the local test-login seam accepts (SYNTHETIC_TEST_PHONE_PATTERN in
// apps/api/src/auth/auth.dto.ts). Re-declared here on purpose: a fixture phone outside it
// could never mint a worker token, so item 9 would be un-runnable — this is the guard.
const RESERVED_TEST_PHONE_PATTERN = /^\+910{5}\d{5}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("E4 reach fixture constants (#1844 — E4_CHECK item 9)", () => {
  it("names a real, closed-vocabulary match skill", () => {
    expect(isMatchSkillId(FIXTURE.skillId)).toBe(true);
  });

  it("the skill resolves to an industry (denormalized onto worker_skill)", () => {
    expect(matchSkillIndustry(FIXTURE.skillId)).toBe("ind_industrial_manufacturing");
  });

  it("the worker phone is inside the reserved test-login range (so a token can be minted)", () => {
    expect(FIXTURE.phoneE164).toMatch(RESERVED_TEST_PHONE_PATTERN);
  });

  it("every fixed id is a syntactically valid uuid", () => {
    for (const id of [FIXTURE.workerId, FIXTURE.consentId, FIXTURE.postingId, FIXTURE.opsActorId]) {
      expect(id).toMatch(UUID_PATTERN);
    }
  });

  it("all fixed ids are distinct", () => {
    const ids = [FIXTURE.workerId, FIXTURE.consentId, FIXTURE.postingId, FIXTURE.opsActorId];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("the seeded consent uses the current version and only known purposes", () => {
    expect(FIXTURE.consentVersion).toBe(CURRENT_CONSENT_VERSION);
    expect(FIXTURE.consentPurposes.length).toBeGreaterThan(0);
    for (const p of FIXTURE.consentPurposes) {
      expect(CONSENT_PURPOSES).toContain(p);
    }
  });

  it("months_bucketed is non-negative (worker_skill CHECK)", () => {
    expect(FIXTURE.monthsBucketed).toBeGreaterThanOrEqual(0);
  });
});

describe("assertFixtureValid — the fail-closed guard main() runs before any write", () => {
  it("passes for the shipped fixture and returns the resolved industry", () => {
    expect(() => assertFixtureValid()).not.toThrow();
    expect(assertFixtureValid().industryId).toBe("ind_industrial_manufacturing");
  });
});
