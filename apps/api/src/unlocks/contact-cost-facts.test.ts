import { describe, expect, it } from "vitest";
import { contactCost, DEFAULT_CREDIT_RULES } from "@badabhai/pricing";
import { contactCostFactsOf, higherRungMonthsOf, isHigherPricedRung } from "./contact-cost-facts";
import type { ContactCostFactsRow } from "./unlocks.repository";

const row = (over: Partial<ContactCostFactsRow> = {}): ContactCostFactsRow => ({
  rungs: [],
  totalYears: null,
  rvmStudent: false,
  grant: null,
  ...over,
});
const priced = (r: ContactCostFactsRow) =>
  contactCost(DEFAULT_CREDIT_RULES, contactCostFactsOf(r, { forOpen: true })).credits;

describe("which rungs price Higher", () => {
  it.each([
    ["a CNC setter", "mskill_cnc_turner", "setter", true],
    ["a CNC operator", "mskill_cnc_turner", "operator", false],
    ["a CAM programmer", "mskill_cam_programmer", "programmer", true],
    [
      "a CAM junior programmer (the trade, above trainee)",
      "mskill_cam_programmer",
      "junior_programmer",
      true,
    ],
    ["a CAM trainee", "mskill_cam_programmer", "trainee", false],
    ["a 3D CAD designer (the trade, above trainee)", "mskill_cad_designer_3d", "designer", true],
    ["a 3D CAD trainee modeller", "mskill_cad_designer_3d", "trainee_modeller", false],
    // CEO pack v2 sheet T38 (#3000): Higher from senior_technician, not technician.
    ["a PLC technician", "mskill_plc_automation_tech", "technician", false],
    ["a PLC senior technician", "mskill_plc_automation_tech", "senior_technician", true],
    ["an electrician technician", "mskill_industrial_electrician", "technician", false],
    ["an unknown rung", "mskill_cnc_turner", "astronaut", false],
  ])("%s", (_label, skillId, level, higher) => {
    expect(isHigherPricedRung(skillId, level)).toBe(higher);
  });
});

describe("experience in the higher-priced trade", () => {
  it("uses his months in that trade", () => {
    const r = row({ rungs: [{ skillId: "mskill_cnc_turner", tradeLevel: "setter", months: 36 }] });
    expect(higherRungMonthsOf(r)).toBe(36);
    expect(priced(r)).toBe(2);
  });

  it("falls back to his total years when he has no months row for the trade", () => {
    const r = row({
      rungs: [{ skillId: "mskill_cad_designer_3d", tradeLevel: "designer", months: null }],
      totalYears: 3,
    });
    expect(higherRungMonthsOf(r)).toBe(36);
    expect(priced(r)).toBe(2);
  });

  it("a trade's own months win over total years (2y11m in the trade, 10 years overall)", () => {
    const r = row({
      rungs: [{ skillId: "mskill_cad_designer_3d", tradeLevel: "designer", months: 35 }],
      totalYears: 10,
    });
    expect(priced(r)).toBe(1);
  });

  it("an operator with 10 years is the standard cost: his rung does not price Higher", () => {
    const r = row({
      rungs: [{ skillId: "mskill_cnc_turner", tradeLevel: "operator", months: 120 }],
      totalYears: 10,
    });
    expect(higherRungMonthsOf(r)).toBeNull();
    expect(priced(r)).toBe(1);
  });

  it("unknown experience is never priced up", () => {
    const r = row({
      rungs: [{ skillId: "mskill_cnc_turner", tradeLevel: "setter", months: null }],
    });
    expect(higherRungMonthsOf(r)).toBeNull();
    expect(priced(r)).toBe(1);
  });

  it("takes the most months across his higher-priced trades", () => {
    const r = row({
      rungs: [
        { skillId: "mskill_cnc_turner", tradeLevel: "setter", months: 12 },
        { skillId: "mskill_cam_programmer", tradeLevel: "programmer", months: 48 },
        { skillId: "mskill_vmc_operator", tradeLevel: "operator", months: 240 },
      ],
    });
    expect(higherRungMonthsOf(r)).toBe(48);
  });

  it("a worker who stated nothing (or an id that does not exist) is the standard cost", () => {
    expect(priced(row())).toBe(1);
  });
});

describe("the RVM label and a contact already held", () => {
  it("an RVM student on a higher rung is the standard cost", () => {
    const r = row({
      rvmStudent: true,
      rungs: [{ skillId: "mskill_cam_programmer", tradeLevel: "programmer", months: 60 }],
    });
    expect(priced(r)).toBe(1);
  });

  it("the quote prices a contact the company holds open at 0; the open prices a NEW grant", () => {
    const future = new Date(Date.now() + 86_400_000);
    const r = row({
      grant: { status: "granted", expiresAt: future },
      rungs: [{ skillId: "mskill_cnc_turner", tradeLevel: "setter", months: 60 }],
    });
    expect(contactCostFactsOf(r, { forOpen: false }).alreadyOpened).toBe(true);
    expect(contactCostFactsOf(r, { forOpen: true }).alreadyOpened).toBe(false);
  });

  it("a lapsed or denied grant is not held: the quote prices it again", () => {
    const past = new Date(Date.now() - 86_400_000);
    expect(
      contactCostFactsOf(row({ grant: { status: "granted", expiresAt: past } }), { forOpen: false })
        .alreadyOpened,
    ).toBe(false);
    expect(
      contactCostFactsOf(row({ grant: { status: "denied", expiresAt: null } }), { forOpen: false })
        .alreadyOpened,
    ).toBe(false);
  });

  it("no Managed Hiring tracker and no waiver read: never 0 on their account", () => {
    const facts = contactCostFactsOf(row({ rvmStudent: true }), { forOpen: false });
    expect(facts.managedHiringOrder).toBe(false);
    expect(facts.waived).toBe(false);
  });

  it("#2751 item 11 — a worker on a paid Managed Hiring tracker costs 0 (B7-15), even a Higher rung", () => {
    const r = row({ rungs: [{ skillId: "mskill_cnc_turner", tradeLevel: "setter", months: 60 }] });
    expect(contactCostFactsOf(r, { forOpen: true, managedHiring: true }).managedHiringOrder).toBe(
      true,
    );
    expect(
      contactCost(
        DEFAULT_CREDIT_RULES,
        contactCostFactsOf(r, { forOpen: true, managedHiring: true }),
      ),
    ).toEqual({
      credits: 0,
      basis: "managed_hiring",
    });
  });
});
