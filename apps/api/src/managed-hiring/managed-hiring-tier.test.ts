/**
 * #2751 item 13 — the tier choice (register B2-31, B2-33, B7-05): the job's vacancy band and its
 * level needed decide the tier; 11+ vacancies get a callback request; an unknown level never prices
 * a job up.
 */
import { describe, expect, it } from "vitest";
import { POSTING_TRADES, normalizeTradeLevelKey, priceTierForTradeSkill } from "@badabhai/taxonomy";
import { VACANCY_BANDS } from "@badabhai/types";

import {
  MANAGED_HIRING_TERMS,
  isExperiencedJob,
  managedHiringTierFor,
  type ManagedHiringJobFacts,
} from "./managed-hiring-tier";

const job = (over: Partial<ManagedHiringJobFacts> = {}): ManagedHiringJobFacts => ({
  vacancyBand: "2-5",
  minExperienceYears: null,
  roleKind: "cnc_turner",
  tradeLevel: null,
  ...over,
});

describe("managedHiringTierFor", () => {
  it("1 to 5 vacancies, fresher to mid level: Standard (₹4,720 with GST)", () => {
    expect(managedHiringTierFor(job({ vacancyBand: "1" }))).toEqual({
      kind: "tier",
      tier: "standard",
      experienced: false,
    });
    expect(managedHiringTierFor(job({ vacancyBand: "2-5", tradeLevel: "operator" }))).toMatchObject(
      {
        tier: "standard",
      },
    );
    expect(managedHiringTierFor(job({ minExperienceYears: 2 }))).toMatchObject({
      tier: "standard",
    });
  });

  it("6 to 10 vacancies: Large (₹9,440), whatever the level", () => {
    expect(managedHiringTierFor(job({ vacancyBand: "6-10" }))).toEqual({
      kind: "tier",
      tier: "large",
      experienced: false,
    });
  });

  it("a 3+ year job is Large even with 1 to 5 vacancies", () => {
    expect(managedHiringTierFor(job({ minExperienceYears: 3 }))).toEqual({
      kind: "tier",
      tier: "large",
      experienced: true,
    });
  });

  it("a rung the trade sheet prices Higher is Large (setter and above on CNC turning)", () => {
    for (const rung of ["setter", "setter_programmer", "programmer"]) {
      expect(managedHiringTierFor(job({ tradeLevel: rung }))).toMatchObject({
        tier: "large",
        experienced: true,
      });
    }
  });

  // #3025 — the trades of CEO pack v2 tier by their own sheets, through the same catalogue.
  it.each([
    // A desk trade: Engineer is above the trainee floor, so Higher.
    ["quality_engineer", "engineer", "large", true],
    ["quality_engineer", "trainee", "standard", false],
    // Stores: Executive is the working rung, priced Lower; Senior Executive is Higher.
    ["store_keeper", "executive", "standard", false],
    ["store_keeper", "senior_executive", "large", true],
    // T21 CNC Router: its sheet prices Setter Lower (unlike the CNC trades); Programmer is Higher.
    ["cnc_router_operator", "setter", "standard", false],
    ["cnc_router_operator", "programmer", "large", true],
  ] as const)("a trades-v2 job: %s at %s is %s", (roleKind, tradeLevel, tier, experienced) => {
    expect(managedHiringTierFor(job({ roleKind, tradeLevel }))).toEqual({
      kind: "tier",
      tier,
      experienced,
    });
  });

  it("11 or more vacancies: no checkout, a callback request (B7-05)", () => {
    expect(managedHiringTierFor(job({ vacancyBand: "11-25" }))).toEqual({ kind: "callback" });
    expect(managedHiringTierFor(job({ vacancyBand: "25+", minExperienceYears: 10 }))).toEqual({
      kind: "callback",
    });
  });

  it("answers every vacancy band (no band falls through)", () => {
    for (const vacancyBand of VACANCY_BANDS) {
      expect(["tier", "callback"]).toContain(managedHiringTierFor(job({ vacancyBand })).kind);
    }
  });
});

describe("isExperiencedJob never prices up on missing data", () => {
  it("no years and no rung is not experienced", () => {
    expect(isExperiencedJob(job())).toBe(false);
  });

  it("an unknown rung, an unknown trade or no trade is not experienced", () => {
    expect(isExperiencedJob(job({ tradeLevel: "grandmaster" }))).toBe(false);
    expect(isExperiencedJob(job({ roleKind: "astronaut", tradeLevel: "setter" }))).toBe(false);
    expect(isExperiencedJob(job({ roleKind: null, tradeLevel: "setter" }))).toBe(false);
  });

  it("matches each postable trade's own sheet, rung by rung", () => {
    for (const trade of POSTING_TRADES) {
      for (const rung of trade.ladder) {
        const level = normalizeTradeLevelKey(rung.rung);
        const higher =
          level !== null && priceTierForTradeSkill(trade.matchSkillId, level) === "higher";
        expect(
          isExperiencedJob(job({ roleKind: trade.roleKind, tradeLevel: rung.rung })),
          `${trade.roleKind}:${rung.rung}`,
        ).toBe(higher);
      }
    }
  });
});

describe("the terms line", () => {
  it("never promises a hire", () => {
    expect(MANAGED_HIRING_TERMS).toBe(
      "Managed Hiring is a sourcing and screening service. BadaBhai does not promise a hire.",
    );
    expect(MANAGED_HIRING_TERMS.toLowerCase()).not.toMatch(/guarantee|assured|we will hire/);
  });
});
