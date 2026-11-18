import { describe, expect, it } from "vitest";
import { contactCost, type ContactCostFacts } from "./contact-cost";
import { DEFAULT_CREDIT_RULES, parseCreditRules } from "./credit-rules";

const NONE: ContactCostFacts = {
  alreadyOpened: false,
  managedHiringOrder: false,
  waived: false,
  rvmStudent: false,
  higherRungMonths: null,
};
const cost = (facts: Partial<ContactCostFacts>, rules = DEFAULT_CREDIT_RULES) =>
  contactCost(rules, { ...NONE, ...facts });

describe("the brief's table (#2750 'Checks with the specifics')", () => {
  it.each([
    ["a CAD designer with 3 years costs 2 (B2-39)", { higherRungMonths: 36 }, 2, "higher"],
    [
      "the same trade at 2 years 11 months costs 1 (B2-40)",
      { higherRungMonths: 35 },
      1,
      "standard",
    ],
    [
      "an operator with 10 years costs 1 (no rung prices Higher) (B2-41)",
      { higherRungMonths: null },
      1,
      "standard",
    ],
    ["a fresher costs 1", { higherRungMonths: 0 }, 1, "standard"],
    [
      "an RVM applicant with no waiver costs 1 (B2-37, B6-04)",
      { rvmStudent: true },
      1,
      "rvm_student",
    ],
    [
      "an RVM applicant on a higher rung still costs the standard 1",
      { rvmStudent: true, higherRungMonths: 120 },
      1,
      "rvm_student",
    ],
    ["a waived RVM applicant costs 0", { rvmStudent: true, waived: true }, 0, "waived"],
    [
      "a contact already opened costs 0",
      { alreadyOpened: true, higherRungMonths: 120 },
      0,
      "already_opened",
    ],
    [
      "a Managed Hiring contact costs 0",
      { managedHiringOrder: true, higherRungMonths: 120 },
      0,
      "managed_hiring",
    ],
  ] as const)("%s", (_label, facts, credits, basis) => {
    expect(cost(facts)).toEqual({ credits, basis });
  });
});

describe("settings move the price with no deploy (B4C-10)", () => {
  const rules = parseCreditRules({
    ...DEFAULT_CREDIT_RULES,
    higherCostMinMonths: 48,
    higherCost: 3,
  });

  it("4 years and 3 credits: a 3-year programmer costs 1", () => {
    expect(cost({ higherRungMonths: 36 }, rules).credits).toBe(1);
  });

  it("4 years and 3 credits: a 5-year programmer costs 3", () => {
    expect(cost({ higherRungMonths: 60 }, rules).credits).toBe(3);
  });

  it("the standard cost is a setting too", () => {
    const two = parseCreditRules({ ...DEFAULT_CREDIT_RULES, standardCost: 2, higherCost: 2 });
    expect(cost({}, two).credits).toBe(2);
    expect(cost({ rvmStudent: true }, two).credits).toBe(2);
  });
});

describe("never price up on missing or garbage data", () => {
  it.each([NaN, Infinity, -Infinity])("months %s costs the standard 1", (months) => {
    expect(cost({ higherRungMonths: months }).credits).toBe(1);
  });

  it("a waiver without the RVM tag changes nothing (waivers free RVM applicants only)", () => {
    expect(cost({ waived: true }).credits).toBe(1);
  });
});
