import { describe, expect, it } from "vitest";
import {
  CREDIT_RULE_KEYS,
  CreditRulesInputSchema,
  CreditRulesSchema,
  DEFAULT_CREDIT_RULES,
  changedCreditRuleKeys,
  parseCreditRules,
} from "./credit-rules";

/** The brief's numbers (#2750 "Settings and their starting values"). */
const BRIEF = {
  standardCost: 1,
  higherCost: 2,
  higherCostMinMonths: 36,
  welcomeCredits: 5,
  welcomeValidityDays: 30,
  workerWeeklyOpenLimit: 5,
  agencyDailyOpenLimit: 40,
  couldntReachWindowDays: 7,
  deskWindowHours: 48,
  returnedCreditsMax: 20,
  returnedCreditsWindowMonths: 6,
  returnedLotValidityDays: 30,
  refundUnusedWithinDays: 7,
  refundLowMatchWithinDays: 30,
  refundLowMatchMinWorkers: 3,
  goodwillMaxPerQuarter: 5,
  goodwillValidityDays: 30,
};

describe("the defaults are the brief's values", () => {
  it("every key, exactly", () => {
    expect(DEFAULT_CREDIT_RULES).toEqual(BRIEF);
  });

  it("the key list is the schema's keys, in a fixed order", () => {
    expect([...CREDIT_RULE_KEYS]).toEqual(Object.keys(BRIEF));
  });

  it("the defaults are frozen", () => {
    expect(Object.isFrozen(DEFAULT_CREDIT_RULES)).toBe(true);
  });
});

describe("a stored row", () => {
  it("keeps its own values", () => {
    const rules = parseCreditRules({ ...BRIEF, higherCostMinMonths: 48, higherCost: 3 });
    expect(rules.higherCostMinMonths).toBe(48);
    expect(rules.higherCost).toBe(3);
  });

  it("takes the default for a key it does not hold (a key added after the row was written)", () => {
    const { goodwillValidityDays: _dropped, ...older } = BRIEF;
    expect(parseCreditRules(older).goodwillValidityDays).toBe(30);
  });

  it.each([
    ["an unknown key", { ...BRIEF, freeUnlockCredits: 50 }],
    ["a fraction", { ...BRIEF, standardCost: 1.5 }],
    ["a string number", { ...BRIEF, standardCost: "1" }],
    ["a zero cost", { ...BRIEF, standardCost: 0 }],
    ["a cost past its bound", { ...BRIEF, higherCost: 21 }],
    ["a higher cost below the standard one", { ...BRIEF, standardCost: 3, higherCost: 2 }],
    ["null", null],
    ["an array", []],
    ["a string", "{}"],
  ])("fails closed WHOLE on %s", (_label, raw) => {
    expect(CreditRulesSchema.safeParse(raw).success).toBe(false);
    expect(parseCreditRules(raw)).toBe(DEFAULT_CREDIT_RULES);
  });

  it("never throws", () => {
    expect(() => parseCreditRules(undefined)).not.toThrow();
  });
});

describe("the edit body", () => {
  it("accepts a full set", () => {
    expect(CreditRulesInputSchema.safeParse(BRIEF).success).toBe(true);
  });

  it("refuses a partial set rather than resetting the missing keys to defaults", () => {
    const { welcomeCredits: _dropped, ...partial } = BRIEF;
    expect(CreditRulesInputSchema.safeParse(partial).success).toBe(false);
  });

  it("refuses an unknown key", () => {
    expect(CreditRulesInputSchema.safeParse({ ...BRIEF, extra: 1 }).success).toBe(false);
  });

  it("refuses a higher cost below the standard one", () => {
    expect(
      CreditRulesInputSchema.safeParse({ ...BRIEF, standardCost: 2, higherCost: 1 }).success,
    ).toBe(false);
  });

  it("allows an equal higher and standard cost (one price for everyone)", () => {
    expect(
      CreditRulesInputSchema.safeParse({ ...BRIEF, standardCost: 2, higherCost: 2 }).success,
    ).toBe(true);
  });

  it("B4C-10: 4 years and 3 credits is a valid edit", () => {
    const parsed = CreditRulesInputSchema.parse({
      ...BRIEF,
      higherCostMinMonths: 48,
      higherCost: 3,
    });
    expect(parsed.higherCostMinMonths).toBe(48);
  });
});

describe("changedCreditRuleKeys", () => {
  it("names only the keys that moved, in key order", () => {
    const after = parseCreditRules({ ...BRIEF, higherCost: 3, higherCostMinMonths: 48 });
    expect(changedCreditRuleKeys(DEFAULT_CREDIT_RULES, after)).toEqual([
      "higherCost",
      "higherCostMinMonths",
    ]);
  });

  it("is empty for an unchanged set", () => {
    expect(changedCreditRuleKeys(DEFAULT_CREDIT_RULES, parseCreditRules(BRIEF))).toEqual([]);
  });
});
