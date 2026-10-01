import { describe, expect, it } from "vitest";
import {
  cardFieldsFromAgencyJob,
  cardFieldsFromPostingWire,
  experienceLabel,
  formatIndianGrouped,
  formatPayBandFull,
  neededByLabel,
  payTypeLabel,
  placeLabel,
  shiftLabel,
  toJobCardView,
  type CardFields,
} from "./job-card-view";
import type { AgencyJob, JobPostingWire } from "./contracts";

/**
 * The card mapper is the lineage's single seam. These pin the BYTE-FOR-BYTE formatters (they must
 * read the same numbers/words the worker will see), the row-hiding on an unknown enum, and — the
 * safety property — that `org_label` / a verified seal / a boost flag can NEVER map through.
 */

describe("formatters — byte-for-byte ports of the worker app", () => {
  it("formatIndianGrouped groups Indian-style", () => {
    expect(formatIndianGrouped(800)).toBe("800");
    expect(formatIndianGrouped(16000)).toBe("16,000");
    expect(formatIndianGrouped(125000)).toBe("1,25,000");
  });

  it("formatPayBandFull carries the /mah suffix and hides on no band", () => {
    expect(formatPayBandFull(16000, 26000)).toBe("₹16,000–26,000/mah");
    expect(formatPayBandFull(16000, 16000)).toBe("₹16,000/mah");
    expect(formatPayBandFull(16000, null)).toBe("₹16,000+/mah");
    expect(formatPayBandFull(null, 26000)).toBe("Up to ₹26,000/mah");
    expect(formatPayBandFull(null, null)).toBeNull();
    expect(formatPayBandFull(-5, null)).toBeNull(); // negative is contract-invalid → treated absent
  });

  it("payTypeLabel / shiftLabel / neededByLabel map known values and null everything else", () => {
    expect(payTypeLabel("in_hand")).toBe("IN-HAND");
    expect(payTypeLabel("gross")).toBe("GROSS");
    expect(payTypeLabel("ctc")).toBe("CTC");
    expect(payTypeLabel(null)).toBeNull();
    expect(payTypeLabel("weird")).toBeNull();
    expect(shiftLabel("day")).toBe("Day");
    expect(shiftLabel("rotational")).toBe("Rotational");
    expect(shiftLabel("graveyard")).toBeNull();
    expect(neededByLabel("immediate")).toBe("Turant chahiye");
    expect(neededByLabel("soon")).toBe("Jaldi chahiye");
    expect(neededByLabel("flexible")).toBe("Flexible");
    expect(neededByLabel(null)).toBeNull();
  });

  it("experienceLabel matches the worker vocabulary", () => {
    expect(experienceLabel(2, 5)).toBe("2–5 yrs experience");
    expect(experienceLabel(3, 3)).toBe("3 yrs experience");
    expect(experienceLabel(5, null)).toBe("5+ yrs experience");
    expect(experienceLabel(null, 5)).toBe("Up to 5 yrs experience");
    expect(experienceLabel(null, null)).toBeNull();
  });
});

const FULL_CARD: CardFields = {
  role_title: "CNC Machinist",
  role_kind: "cnc_turner",
  city: "Pune",
  area: "Chakan",
  pay_min: 16000,
  pay_max: 26000,
  pay_type: "in_hand",
  min_experience_years: 2,
  max_experience_years: 5,
  shift: "day",
  needed_by: "immediate",
  requirements: ["Fanuc control"],
  benefits: ["PF + ESI"],
};

describe("toJobCardView — the ONE mapper, in the worker card's order", () => {
  it("builds the title, the place (AREA, CITY), the salary + pill, and the ordered chips — no role row", () => {
    const view = toJobCardView(FULL_CARD);
    expect(Object.keys(view)).toEqual(["title", "place", "salary", "chips"]);
    expect(view.title).toBe("CNC Machinist");
    expect(view.place).toBe("Chakan, Pune");
    expect(view.salary).toEqual({ band: "₹16,000–26,000/mah", issue: null, payTypePill: "IN-HAND" });
    expect(view.chips.map((c) => c.label)).toEqual([
      "Day Shift",
      "2–5 yrs experience",
      "Turant chahiye",
      "Fanuc control",
      "PF + ESI",
    ]);
    // The picked role is NOT drawn — the worker's card has no role-kind row (ADR-0024 addendum).
    expect(JSON.stringify(view)).not.toContain("CNC Turner");
  });

  it("HIDES a row whose enum is unknown/absent (never echoed, never guessed)", () => {
    const view = toJobCardView({
      ...FULL_CARD,
      role_kind: "not_a_role",
      shift: "graveyard",
      pay_type: null,
      needed_by: null,
      pay_min: null,
      pay_max: null,
    });
    expect(view.salary).toBeNull(); // no band → the whole box is hidden
    expect(view.chips.some((c) => c.kind === "shift")).toBe(false);
    expect(view.chips.some((c) => c.kind === "needed_by")).toBe(false);
    expect(JSON.stringify(view)).not.toContain("not_a_role");
  });
});

describe("placeLabel — the worker's `_cardData` order", () => {
  it("area first, then city; area blank → city; city blank → the area alone; neither → hidden", () => {
    expect(placeLabel("Pune", "Chakan MIDC")).toBe("Chakan MIDC, Pune");
    expect(placeLabel("Pune", "")).toBe("Pune");
    expect(placeLabel("Pune", "  ")).toBe("Pune");
    expect(placeLabel("Pune", null)).toBe("Pune");
    expect(placeLabel(" Pune ", " Chakan ")).toBe("Chakan, Pune");
    expect(placeLabel("", "Chakan")).toBe("Chakan");
    expect(placeLabel(null, null)).toBeNull();
  });
});

describe("a live form's draft — an issue REPLACES its row, a pending chip is marked", () => {
  it("a pay issue replaces the band (the pill stays); no draft → the band", () => {
    const view = toJobCardView(FULL_CARD, { payIssue: "Pay needs a whole number" });
    expect(view.salary).toEqual({ band: null, issue: "Pay needs a whole number", payTypePill: "IN-HAND" });
    // A pay issue draws the box even when no bound survived (the payer typed something).
    expect(toJobCardView({ ...FULL_CARD, pay_min: null, pay_max: null }, { payIssue: "x" }).salary?.issue).toBe("x");
  });

  it("an experience issue replaces the window chip in ITS slot (second, after the shift)", () => {
    const view = toJobCardView({ ...FULL_CARD, min_experience_years: null }, { experienceIssue: "Fix me" });
    expect(view.chips.map((c) => [c.label, c.state])).toEqual([
      ["Day Shift", undefined],
      ["Fix me", "invalid"],
      ["Turant chahiye", undefined],
      ["Fanuc control", undefined],
      ["PF + ESI", undefined],
    ]);
  });

  it("marks only the LAST matching chip pending (the draft is appended last)", () => {
    const view = toJobCardView(
      { ...FULL_CARD, requirements: ["Fanuc control", "MIG", "MIG"] },
      { pendingRequirement: "MIG", pendingBenefit: "nope" },
    );
    expect(view.chips.filter((c) => c.state === "pending").map((c) => c.label)).toEqual(["MIG"]);
    expect(view.chips.filter((c) => c.label === "MIG").map((c) => c.state)).toEqual([undefined, "pending"]);
  });
});

describe("adapters — org_label / verified / boost NEVER map through", () => {
  const wire = {
    id: "aaaa1111-0000-4000-8000-000000000001",
    payer_id: "bbbb2222-0000-4000-8000-000000000002",
    created_by: "bbbb2222-0000-4000-8000-000000000002",
    org_label: "Acme Manufacturing Pvt Ltd",
    role_title: "CNC Machinist",
    location_label: "Pune, MH",
    description: "desc",
    vacancy_band: "1-5",
    status: "open",
    skill_phrases: [],
    skill_ids: [],
    city: "Pune",
    area: "Chakan",
    pay_min: 16000,
    pay_max: 26000,
    pay_type: "in_hand",
    min_experience_years: 2,
    max_experience_years: 5,
    shift: "day",
    needed_by: "immediate",
    requirements: ["Fanuc control"],
    benefits: ["PF + ESI"],
    role_kind: "cnc_turner",
    created_at: "2026-06-20T00:00:00.000Z",
    updated_at: "2026-06-20T00:00:00.000Z",
    closed_at: null,
    // Regression fixtures — a trust/boost flag that must never reach the card.
    verified: true,
    boosted_until: "2027-01-01T00:00:00.000Z",
  } as unknown as JobPostingWire;

  it("cardFieldsFromPostingWire drops org_label / verified / boosted_until", () => {
    const card = cardFieldsFromPostingWire(wire);
    const json = JSON.stringify(card);
    expect(json).not.toContain("Acme Manufacturing");
    expect(json).not.toContain("verified");
    expect(json).not.toContain("boosted_until");
    // The traceable card fields ARE present.
    expect(card.role_kind).toBe("cnc_turner");
    expect(card.pay_min).toBe(16000);
    // The view built from it likewise carries no company/trust data.
    const view = JSON.stringify(toJobCardView(card));
    expect(view).not.toContain("Acme Manufacturing");
    expect(view).not.toContain("verified");
  });

  it("cardFieldsFromAgencyJob maps the camelCase job to snake_case card fields (tradeKey is NOT a card field)", () => {
    const job = {
      id: "aaaa1111-0000-4000-8000-000000000001",
      status: "open",
      tradeKey: "cnc_operator",
      title: "CNC Operator",
      city: "Pune",
      area: "Chakan",
      payMin: 16000,
      payMax: 26000,
      minExperienceYears: 2,
      maxExperienceYears: 5,
      neededBy: "immediate",
      shift: "day",
      payType: "in_hand",
      description: "desc",
      requirements: ["Fanuc control"],
      benefits: ["PF + ESI"],
      roleKind: "cnc_turner",
      applicantsReceived: 0,
      createdAt: "2026-06-20T00:00:00.000Z",
      updatedAt: "2026-06-20T00:00:00.000Z",
    } as AgencyJob;
    const card = cardFieldsFromAgencyJob(job);
    expect(card.role_title).toBe("CNC Operator");
    expect(card.role_kind).toBe("cnc_turner");
    expect(card.pay_type).toBe("in_hand");
    expect(JSON.stringify(card)).not.toContain("cnc_operator"); // the trade key never becomes a card field
    // The display role rides along on the fields (for "Also in your posting"), never as a card row.
    expect(JSON.stringify(toJobCardView(card))).not.toContain("CNC Turner");
  });
});
