import { describe, expect, it } from "vitest";
import { DEFAULT_MATCH_CONFIG, MatchConfigSchema, parseMatchConfig } from "./config";

describe("MatchConfig", () => {
  it("ships the ratified V1 defaults", () => {
    expect(DEFAULT_MATCH_CONFIG).toEqual({
      engineVersion: "v1.0",
      monthBucket: 6,
      maxSkillsPerPosting: 3,
      relatedSkillsDefault: "on",
      maxConsecutiveSameCompany: 2,
      applicantQuota: "off",
      tierFloorMonths: 36,
      freeUnlockCredits: 50,
      boostSupplyFloor: 25,
    });
  });

  it("freezes the defaults so a caller cannot silently re-rank every feed", () => {
    expect(Object.isFrozen(DEFAULT_MATCH_CONFIG)).toBe(true);
  });

  it("accepts a partial remote config and fills the rest from defaults", () => {
    const parsed = parseMatchConfig({ tierFloorMonths: 24, relatedSkillsDefault: "off" });
    expect(parsed.tierFloorMonths).toBe(24);
    expect(parsed.relatedSkillsDefault).toBe("off");
    expect(parsed.monthBucket).toBe(6);
    expect(parsed.engineVersion).toBe("v1.0");
  });

  it("strips unknown keys rather than rejecting the whole config", () => {
    const parsed = parseMatchConfig({ monthBucket: 12, someFutureDial: "yes" });
    expect(parsed.monthBucket).toBe(12);
    expect(parsed).not.toHaveProperty("someFutureDial");
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "monthBucket=6"],
    ["a number", 6],
    ["an array", [1, 2, 3]],
    ["a negative bucket", { monthBucket: -6 }],
    ["a zero bucket", { monthBucket: 0 }],
    ["a fractional bucket", { monthBucket: 6.5 }],
    ["a NaN floor", { tierFloorMonths: Number.NaN }],
    ["a negative floor", { tierFloorMonths: -1 }],
    ["a garbage enum", { relatedSkillsDefault: "maybe" }],
    ["a garbage quota", { applicantQuota: 1 }],
    ["an empty engine version", { engineVersion: "" }],
    ["a string month bucket", { monthBucket: "6" }],
  ])("FAILS CLOSED to the defaults on %s", (_label, raw) => {
    expect(parseMatchConfig(raw)).toEqual(DEFAULT_MATCH_CONFIG);
  });

  it("never throws, whatever it is handed", () => {
    const hostile: unknown[] = [
      Symbol("x"),
      () => 1,
      new Map(),
      { monthBucket: { nested: true } },
      { tierFloorMonths: Number.POSITIVE_INFINITY },
    ];
    for (const raw of hostile) {
      expect(() => parseMatchConfig(raw)).not.toThrow();
    }
  });

  it("fails the WHOLE object, not just the bad field", () => {
    // One garbage field must not leave a half-applied config in force.
    const parsed = parseMatchConfig({ tierFloorMonths: 12, monthBucket: "nope" });
    expect(parsed.tierFloorMonths).toBe(DEFAULT_MATCH_CONFIG.tierFloorMonths);
  });

  it("returns a frozen config so a parsed value cannot be edited in place", () => {
    expect(Object.isFrozen(parseMatchConfig({ monthBucket: 12 }))).toBe(true);
  });

  it("exposes the schema for boundary validation elsewhere", () => {
    expect(MatchConfigSchema.safeParse({}).success).toBe(true);
    expect(MatchConfigSchema.safeParse({ monthBucket: 0 }).success).toBe(false);
  });
});
