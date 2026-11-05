import "reflect-metadata";
import { describe, expect, it } from "vitest";
import {
  ADMIN_CANDIDATE_EVENT_NAMES,
  assertCandidateEventNamesValid,
} from "./candidate-index.events";

describe("ADMIN_CANDIDATE_EVENT_NAMES (B4, #2557)", () => {
  it("is a non-empty closed list", () => {
    expect(ADMIN_CANDIDATE_EVENT_NAMES.length).toBeGreaterThan(0);
    expect(new Set(ADMIN_CANDIDATE_EVENT_NAMES).size).toBe(ADMIN_CANDIDATE_EVENT_NAMES.length);
  });

  it("names only real registry events (a typo would silently project nothing)", () => {
    expect(() => assertCandidateEventNamesValid()).not.toThrow();
  });
});
